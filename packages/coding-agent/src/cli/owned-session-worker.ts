import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "../core/agent-session.js";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import {
	clearOrphanProcessJournal,
	killOrphanProcess,
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	shouldReapOrphanProcess,
} from "../core/orphan-process-journal.js";
import { SESSION_LEASE_OWNER_ID_ENV, SESSION_LEASES_ENABLED_ENV } from "../core/session-lease.js";
import { attachJsonlLineReader, serializeJsonLine } from "../modes/rpc/jsonl.js";
import { isHelpCommandRequest, PUBLIC_COMMAND_NAMES, REMOVED_COMMAND_NAMES } from "./command-registry.js";
import { type CliSubprocessLaunchSpec, createCliSubprocessLaunchSpec } from "./subprocess-launch.js";

const OWNED_WORKER_ENV = "PRIME_AGENT_INTERNAL_OWNED_WORKER";
const OWNED_RECOVERY_DESCRIPTOR_ENV = "PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR";
const OWNED_PROFILE_ENV = "PRIME_AGENT_INTERNAL_OWNED_PROFILE";

let closeOwnerWatch: (() => void) | undefined;

export type OwnedSessionWorkerProfile = "print" | "json" | "rpc" | "interactive-ephemeral";

export function isOwnedSessionWorkerProcess(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment[OWNED_WORKER_ENV] === "1";
}

interface OwnedSessionRecoveryDescriptor {
	version: 1;
	profile: OwnedSessionWorkerProfile;
	sessionId: string;
	sessionFile?: string;
	cwd: string;
	updatedAt: string;
}

const NON_SESSION_FLAGS = new Set(["--help", "-h", "--version", "-v", "--list-models", "--export"]);

const NON_SESSION_COMMANDS = new Set([...PUBLIC_COMMAND_NAMES, ...REMOVED_COMMAND_NAMES]);

function valueAfter(args: readonly string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index === -1 ? undefined : args[index + 1];
}

function hasNonSessionOperation(args: readonly string[]): boolean {
	if (args.some((arg) => NON_SESSION_FLAGS.has(arg) || arg.startsWith("--export="))) {
		return true;
	}
	const first = args[0];
	if (first === "help") {
		return isHelpCommandRequest(args.slice(1));
	}
	return first !== undefined && NON_SESSION_COMMANDS.has(first);
}

function isStartupBenchmark(environment: NodeJS.ProcessEnv): boolean {
	const value = environment.PI_STARTUP_BENCHMARK?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

export function classifyOwnedSessionWorkerInvocation(
	args: readonly string[],
	stdinIsTTY: boolean | undefined,
	environment: NodeJS.ProcessEnv = process.env,
): OwnedSessionWorkerProfile | undefined {
	if (isOwnedSessionWorkerProcess(environment) || hasNonSessionOperation(args)) {
		return undefined;
	}

	const mode = valueAfter(args, "--mode");
	if (mode === "daemon") {
		return undefined;
	}
	if (mode === "rpc") {
		return "rpc";
	}
	if (mode === "json") {
		return "json";
	}
	if (args.includes("--print") || args.includes("-p") || stdinIsTTY === false) {
		return "print";
	}
	if (args.includes("--no-session") || isStartupBenchmark(environment)) {
		return "interactive-ephemeral";
	}
	return undefined;
}

export type OwnedWorkerLaunchSpec = CliSubprocessLaunchSpec;

export function createOwnedWorkerLaunchSpec(
	args: readonly string[],
	executable = process.execPath,
	execArgs: readonly string[] = process.execArgv,
	entrypoint = process.argv[1],
): OwnedWorkerLaunchSpec {
	return createCliSubprocessLaunchSpec(args, executable, execArgs, entrypoint);
}

function readOwnedRecoveryDescriptor(path: string): OwnedSessionRecoveryDescriptor | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<OwnedSessionRecoveryDescriptor>;
		if (
			value.version === 1 &&
			typeof value.sessionId === "string" &&
			typeof value.cwd === "string" &&
			(value.sessionFile === undefined || typeof value.sessionFile === "string")
		) {
			return value as OwnedSessionRecoveryDescriptor;
		}
	} catch {
		// The worker may have stopped before creating a recoverable session.
	}
	return undefined;
}

function writeOwnedRecoveryDescriptor(path: string, profile: OwnedSessionWorkerProfile, session: AgentSession): void {
	const descriptor: OwnedSessionRecoveryDescriptor = {
		version: 1,
		profile,
		sessionId: session.sessionId,
		...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
		cwd: session.sessionManager.getCwd(),
		updatedAt: new Date().toISOString(),
	};
	const tempPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(descriptor)}\n`, { mode: 0o600 });
	chmodSync(tempPath, 0o600);
	renameSync(tempPath, path);
}

export function installOwnedSessionRecoveryTracking(runtime: AgentSessionRuntime): void {
	const path = process.env[OWNED_RECOVERY_DESCRIPTOR_ENV];
	const profile = process.env[OWNED_PROFILE_ENV] as OwnedSessionWorkerProfile | undefined;
	if (!path || !profile) {
		return;
	}
	let unsubscribeSession: (() => void) | undefined;
	const bind = (session: AgentSession) => {
		unsubscribeSession?.();
		writeOwnedRecoveryDescriptor(path, profile, session);
		let lastSessionFile = session.sessionFile;
		unsubscribeSession = session.subscribe((event) => {
			if (event.type !== "message_start" && event.type !== "session_info_changed") {
				return;
			}
			if (session.sessionFile !== lastSessionFile) {
				lastSessionFile = session.sessionFile;
				writeOwnedRecoveryDescriptor(path, profile, session);
			}
		});
	};
	bind(runtime.session);
	runtime.onSessionReplaced(bind);
}

export function createRpcRecoveryArgs(args: readonly string[], sessionPath: string): string[] {
	const recovered: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (arg === "--resume" || arg === "-r" || arg === "--fork") {
			index++;
			continue;
		}
		if (arg.startsWith("--resume=")) {
			continue;
		}
		if (arg === "--continue" || arg === "-c") {
			continue;
		}
		recovered.push(arg);
	}
	return [...recovered, "--resume", sessionPath];
}

function exitCodeForSignal(signal: NodeJS.Signals | null): number {
	if (signal === "SIGHUP") {
		return 129;
	}
	if (signal === "SIGINT") {
		return 130;
	}
	if (signal === "SIGTERM") {
		return 143;
	}
	return 1;
}

function forwardSignal(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode === null && child.signalCode === null) {
		child.kill(signal);
	}
}

export async function runOwnedSessionWorkerFrontend(
	args: readonly string[],
	profile: OwnedSessionWorkerProfile,
): Promise<number> {
	const interactive = profile === "interactive-ephemeral";
	const recoveryDescriptorPath = join(tmpdir(), `prime-agent-owned-${process.pid}-${randomUUID().slice(0, 12)}.json`);
	const orphanProcessJournalPath = `${recoveryDescriptorPath}.orphans.jsonl`;
	let currentChild: ChildProcess | undefined;
	let terminating = false;
	let terminationSignal: NodeJS.Signals | undefined;
	let stdinEnded = false;
	let currentRpcInput: NodeJS.WritableStream | undefined;
	let currentRpcOutput: NodeJS.ReadableStream | undefined;
	let rpcStdoutPaused = false;
	let detachRpcInput: (() => void) | undefined;
	let detachRpcOutput: (() => void) | undefined;
	const bufferedRpcInput: string[] = [];
	const pendingRpcCommands = new Map<string, { publicId?: string; command: string }>();
	const anonymousRpcIdPrefix = `prime-agent-owned-${randomUUID()}`;
	let anonymousRpcCommandId = 0;

	const prepareRpcInput = (line: string): string => {
		try {
			const command = JSON.parse(line) as { id?: unknown; type?: unknown } | null;
			if (
				!command ||
				Array.isArray(command) ||
				typeof command.type !== "string" ||
				command.type === "extension_ui_response" ||
				command.type === "ack_result"
			) {
				return `${line}\n`;
			}
			const publicId = typeof command.id === "string" ? command.id : undefined;
			const internalId = publicId ?? `${anonymousRpcIdPrefix}-${++anonymousRpcCommandId}`;
			pendingRpcCommands.set(internalId, { publicId, command: command.type });
			return publicId !== undefined ? `${line}\n` : serializeJsonLine({ ...command, id: internalId });
		} catch {
			// The worker preserves the existing parse-error response contract.
			return `${line}\n`;
		}
	};
	const observeRpcOutput = (line: string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(line) as unknown;
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return;
		}
		const response = parsed as { id?: unknown; type?: unknown; command?: unknown };
		const id = typeof response.id === "string" ? response.id : undefined;
		const pending = id !== undefined ? pendingRpcCommands.get(id) : undefined;
		let framed = `${line}\n`;
		if (response.type === "response" && pending?.publicId === undefined) {
			const { id: _internalId, ...publicResponse } = response;
			framed = serializeJsonLine(publicResponse);
		}
		if (!process.stdout.write(framed) && !rpcStdoutPaused) {
			rpcStdoutPaused = true;
			currentRpcOutput?.pause();
			process.stdout.once("drain", () => {
				rpcStdoutPaused = false;
				currentRpcOutput?.resume();
			});
		}
		if (response.type !== "response" || typeof response.command !== "string") {
			return;
		}
		if (id !== undefined && pending?.command === response.command) {
			pendingRpcCommands.delete(id);
		}
	};
	const failPendingRpcCommands = () => {
		for (const pending of pendingRpcCommands.values()) {
			process.stdout.write(
				serializeJsonLine({
					...(pending.publicId !== undefined ? { id: pending.publicId } : {}),
					type: "response",
					command: pending.command,
					success: false,
					error: "The isolated session worker stopped during this command; its result is uncertain and was not replayed",
				}),
			);
		}
		pendingRpcCommands.clear();
	};
	const reapWorkerResources = (workerPid: number | undefined) => {
		if (!workerPid) {
			return;
		}
		if (process.platform !== "win32") {
			try {
				process.kill(-workerPid, "SIGKILL");
			} catch {
				// The worker process group may already be fully reaped.
			}
		}
		for (const orphan of readActiveOrphanProcesses(orphanProcessJournalPath, workerPid)) {
			if (!shouldReapOrphanProcess(orphan)) {
				continue;
			}
			killOrphanProcess(orphan.pid);
		}
		clearOrphanProcessJournal(orphanProcessJournalPath);
	};

	if (profile === "rpc") {
		detachRpcInput = attachJsonlLineReader(process.stdin, (line) => {
			const framed = prepareRpcInput(line);
			const input = currentRpcInput;
			if (input?.writable) {
				if (!input.write(framed)) {
					process.stdin.pause();
					input.once("drain", () => {
						if (currentRpcInput === input && !stdinEnded) {
							process.stdin.resume();
						}
					});
				}
			} else {
				bufferedRpcInput.push(framed);
			}
		});
		process.stdin.once("end", () => {
			stdinEnded = true;
			currentRpcInput?.end();
		});
	}

	const spawnWorker = (workerArgs: readonly string[]): ChildProcess => {
		const launch = createOwnedWorkerLaunchSpec(workerArgs);
		const bridgeStdin = profile === "rpc" || process.stdin.isTTY !== true;
		const stdio: StdioOptions = interactive
			? ["inherit", "inherit", "inherit", "ipc"]
			: [bridgeStdin ? "pipe" : "inherit", "pipe", "pipe", "ipc"];
		const child = spawn(launch.command, launch.args, {
			cwd: process.cwd(),
			detached: process.platform !== "win32",
			env: {
				...process.env,
				[OWNED_WORKER_ENV]: "1",
				[OWNED_RECOVERY_DESCRIPTOR_ENV]: recoveryDescriptorPath,
				[OWNED_PROFILE_ENV]: profile,
				[ORPHAN_PROCESS_JOURNAL_ENV]: orphanProcessJournalPath,
				[SESSION_LEASES_ENABLED_ENV]: "1",
				[SESSION_LEASE_OWNER_ID_ENV]: `owned-${randomUUID()}`,
			},
			stdio,
		});
		currentChild = child;
		if (!interactive) {
			const childInput = child.stdin ?? undefined;
			const childOutput = child.stdout ?? undefined;
			const childError = child.stderr ?? undefined;
			if ((bridgeStdin && !childInput) || !childOutput || !childError) {
				child.kill("SIGTERM");
				throw new Error("Owned session worker did not expose bridged stdio");
			}
			childError.pipe(process.stderr, { end: false });
			if (profile === "rpc") {
				if (!childInput) {
					throw new Error("Owned RPC worker did not expose stdin");
				}
				currentRpcInput = childInput;
				currentRpcOutput = childOutput;
				if (rpcStdoutPaused) {
					childOutput.pause();
				}
				detachRpcOutput = attachJsonlLineReader(childOutput, observeRpcOutput);
				for (const buffered of bufferedRpcInput.splice(0)) {
					childInput.write(buffered);
				}
				if (stdinEnded) {
					childInput.end();
				}
			} else {
				if (childInput) {
					process.stdin.pipe(childInput);
				}
				childOutput.pipe(process.stdout, { end: false });
			}
		}
		return child;
	};

	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
	if (process.platform !== "win32") {
		signals.push("SIGHUP");
	}
	const signalHandlers = signals.map((signal) => {
		const handler = () => {
			terminating = true;
			terminationSignal ??= signal;
			if (currentChild) {
				forwardSignal(currentChild, signal);
			}
		};
		process.on(signal, handler);
		return { signal, handler };
	});

	try {
		let workerArgs = [...args];
		let recoveryAttempt = 0;
		while (true) {
			if (terminating) {
				return exitCodeForSignal(terminationSignal ?? null);
			}
			const workerStartedAt = Date.now();
			const child = spawnWorker(workerArgs);
			const workerPid = child.pid;
			const exit = await new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
				child.once("error", reject);
				child.once("close", (code, signal) => resolveExit({ code: code ?? exitCodeForSignal(signal), signal }));
			});
			currentChild = undefined;
			currentRpcInput = undefined;
			currentRpcOutput = undefined;
			if (profile === "rpc" && !stdinEnded) {
				process.stdin.resume();
			}
			detachRpcOutput?.();
			detachRpcOutput = undefined;
			if (!interactive && profile !== "rpc" && child.stdin) {
				process.stdin.unpipe(child.stdin);
			}
			if (child.connected) {
				child.disconnect();
			}
			reapWorkerResources(workerPid);
			const rpcCrashed =
				profile === "rpc" &&
				!terminating &&
				(exit.code !== 0 || exit.signal !== null || pendingRpcCommands.size > 0);
			const workerExitCode = rpcCrashed && exit.code === 0 ? 1 : exit.code;
			if (Date.now() - workerStartedAt >= 60_000) {
				recoveryAttempt = 0;
			}
			if (rpcCrashed) {
				failPendingRpcCommands();
			}
			const shouldRecover = rpcCrashed && !stdinEnded && recoveryAttempt < 3;
			if (!shouldRecover) {
				return terminationSignal ? exitCodeForSignal(terminationSignal) : workerExitCode;
			}
			const descriptor = readOwnedRecoveryDescriptor(recoveryDescriptorPath);
			if (!descriptor?.sessionFile) {
				return terminationSignal ? exitCodeForSignal(terminationSignal) : workerExitCode;
			}
			workerArgs = createRpcRecoveryArgs(args, descriptor.sessionFile);
			const retryDelay = [250, 1000, 5000][recoveryAttempt] ?? 5000;
			recoveryAttempt++;
			await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay));
			if (terminating) {
				return exitCodeForSignal(terminationSignal ?? null);
			}
		}
	} finally {
		for (const { signal, handler } of signalHandlers) {
			process.off(signal, handler);
		}
		detachRpcInput?.();
		detachRpcOutput?.();
		rmSync(recoveryDescriptorPath, { force: true });
		clearOrphanProcessJournal(orphanProcessJournalPath);
	}
}

export async function maybeRunOwnedSessionWorkerFrontend(
	args: readonly string[],
	forceLegacyFrontend = false,
): Promise<boolean> {
	if (!forceLegacyFrontend && process.env.PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND !== "1") {
		return false;
	}
	const profile = classifyOwnedSessionWorkerInvocation(args, process.stdin.isTTY);
	if (!profile) {
		return false;
	}
	process.exitCode = await runOwnedSessionWorkerFrontend(args, profile);
	return true;
}

export function installOwnedSessionWorkerOwnerWatch(): void {
	if (!isOwnedSessionWorkerProcess()) {
		return;
	}
	if (!process.channel) {
		throw new Error("Owned session worker is missing its owner channel");
	}

	let ownerGone = false;
	const terminate = () => {
		if (ownerGone) {
			return;
		}
		ownerGone = true;
		closeOwnerWatch = undefined;
		const forceTimer = setTimeout(() => {
			if (process.platform !== "win32") {
				try {
					process.kill(-process.pid, "SIGKILL");
					return;
				} catch {
					// Fall through to terminating only this process.
				}
			}
			process.exit(143);
		}, 5000);
		forceTimer.unref();
		process.kill(process.pid, "SIGTERM");
	};
	process.once("disconnect", terminate);
	process.channel.unref();
	closeOwnerWatch = () => {
		if (ownerGone) {
			return;
		}
		ownerGone = true;
		process.off("disconnect", terminate);
		if (process.connected) {
			process.disconnect();
		}
		closeOwnerWatch = undefined;
	};
}

export function closeOwnedSessionWorkerOwnerWatch(): void {
	closeOwnerWatch?.();
}
