import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BashOperations } from "../tools/bash.js";
import { sanitizeAvoVerificationEnvironment } from "./verification-environment.js";
import { captureAvoWorkspaceSnapshot } from "./workspace.js";

export const AVO_VERIFICATION_BROKER_SOCKET_ENV = "PRIME_AGENT_INTERNAL_AVO_VERIFICATION_BROKER_SOCKET";
export const AVO_VERIFICATION_BROKER_TOKEN_ENV = "PRIME_AGENT_INTERNAL_AVO_VERIFICATION_BROKER_TOKEN";
export const AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY_ENV =
	"PRIME_AGENT_INTERNAL_AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY";

const AVO_VERIFICATION_BROKER_PROTOCOL_VERSION = 1;
const AVO_VERIFICATION_BROKER_MAX_REQUEST_BYTES = 32_768;
const AVO_VERIFICATION_BROKER_MAX_RESPONSE_BYTES = 2_500_000;
const AVO_VERIFICATION_BROKER_MAX_OUTPUT_BYTES = 2_000_000;
const AVO_VERIFICATION_BROKER_MAX_CONTROL_BYTES = 128 * 1024 * 1024;
const AVO_VERIFICATION_BROKER_MAX_HOST_FIXTURE_BYTES = 128 * 1024 * 1024;
const AVO_VERIFICATION_BROKER_HARD_MAXIMUM_TIMEOUT_MS = 900_000;
const AVO_VERIFICATION_BROKER_RESPONSE_MARGIN_MS = 60_000;
const AVO_VERIFICATION_BROKER_MAX_CONNECTIONS = 32;
const AVO_VERIFICATION_BROKER_MAX_ACTIVE_EXECUTIONS = 1;
const AVO_VERIFICATION_BROKER_MAX_QUEUED_EXECUTIONS = 8;
const AVO_VERIFICATION_BROKER_PREAUTH_MAX_BYTES = 512;
const AVO_VERIFICATION_BROKER_PREAUTH_IDLE_MS = 2_000;
const AVO_VERIFICATION_BROKER_REQUEST_IDLE_MS = 5_000;

type JsonRecord = Record<string, unknown>;

export interface AvoVerificationBrokerReceipt {
	protocolVersion: 1;
	brokerId: string;
	requestId: string;
	commandDigest: string;
	controlDigest: string;
	hostFixtureDigest: string;
	postHostFixtureDigest: string;
	hostFixtureCount: number;
	environmentDigest: string;
	workspaceDigest: string;
	postWorkspaceDigest: string;
	sourceDigest: string;
	postSourceDigest: string;
	exitCode: number | null;
	outputDigest: string;
	durationMs: number;
	timedOut: boolean;
	sourceWorkspaceImmutable: true;
	disposableWorkspace: true;
	networkIsolated: true;
	homeIsolated: boolean;
	hostFixturesImmutable: true;
	pythonSemanticAuthority: boolean;
	receiptDigest: string;
}

export interface AvoVerificationBrokerExecution {
	exitCode: number | null;
	output: string;
	receipt: AvoVerificationBrokerReceipt;
}

export interface AvoVerificationBrokerBashOperations extends BashOperations {
	readonly verificationMode: "host_broker";
	lastReceipt(): AvoVerificationBrokerReceipt | undefined;
}

export interface AvoVerificationBrokerHandle {
	socketPath: string;
	token: string;
	brokerId: string;
	close(): Promise<void>;
}

export interface AvoVerificationBrokerOptions {
	workspace: string;
	allowedCommand: string;
	controlPaths: readonly string[];
	hiddenPaths?: readonly string[];
	privateHome?: boolean;
	visiblePaths?: readonly string[];
	hostFixtures?: readonly AvoVerificationBrokerHostFixture[];
	environment?: NodeJS.ProcessEnv;
	defaultTimeoutMs?: number;
	maximumTimeoutMs?: number;
	pythonSemanticAuthority?: boolean;
}

export interface AvoVerificationBrokerHostFixture {
	sourcePath: string;
	destinationPath: string;
}

interface BoundHostFixture {
	sourcePath: string;
	destinationPath: string;
}

interface ParsedBrokerRequest {
	requestId: string;
	command: string;
	cwd: string;
	timeoutMs?: number;
}

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function constantTimeTokenMatches(expected: string, observed: unknown): boolean {
	if (typeof observed !== "string") return false;
	const expectedBuffer = Buffer.from(expected);
	const observedBuffer = Buffer.from(observed);
	return expectedBuffer.length === observedBuffer.length && timingSafeEqual(expectedBuffer, observedBuffer);
}

function safeRelativePath(value: string, label: string): string {
	const normalized = value.replaceAll("\\", "/");
	if (
		!normalized ||
		normalized === "." ||
		normalized === ".." ||
		normalized.startsWith("/") ||
		normalized.startsWith("../") ||
		normalized.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error(`${label} must be a bounded relative path`);
	}
	return normalized;
}

function digestControlPaths(workspace: string, controlPaths: readonly string[]): string {
	const digest = createHash("sha256");
	digest.update("prime-avo-verification-controls-v1\0");
	let totalBytes = 0;
	const visit = (absolute: string, relativePath: string): void => {
		const metadata = lstatSync(absolute);
		if (metadata.isSymbolicLink())
			throw new Error(`verification control must not be a symbolic link: ${relativePath}`);
		if (metadata.isFile()) {
			totalBytes += metadata.size;
			if (totalBytes > AVO_VERIFICATION_BROKER_MAX_CONTROL_BYTES) {
				throw new Error("verification controls exceed 134217728 bytes");
			}
			digest.update(`file\0${relativePath}\0${metadata.mode}\0${metadata.size}\0`);
			digest.update(readFileSync(absolute));
			digest.update("\0");
			return;
		}
		if (!metadata.isDirectory()) throw new Error(`verification control has an unsupported type: ${relativePath}`);
		digest.update(`directory\0${relativePath}\0${metadata.mode}\0`);
		for (const entry of readdirSync(absolute).sort()) visit(join(absolute, entry), `${relativePath}/${entry}`);
	};
	for (const path of [...controlPaths].sort()) visit(resolve(workspace, path), path);
	return digest.digest("hex");
}

function digestHostFixtureFiles(
	fixtures: readonly BoundHostFixture[],
	pathFor: (fixture: BoundHostFixture) => string,
): string {
	const digest = createHash("sha256");
	digest.update("prime-avo-verification-host-fixtures-v1\0");
	let totalBytes = 0;
	for (const fixture of fixtures) {
		const path = pathFor(fixture);
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink() || !metadata.isFile()) {
			throw new Error(
				`verification host fixture must remain a regular non-symlink file: ${fixture.destinationPath}`,
			);
		}
		totalBytes += metadata.size;
		if (totalBytes > AVO_VERIFICATION_BROKER_MAX_HOST_FIXTURE_BYTES) {
			throw new Error("verification host fixtures exceed 134217728 bytes");
		}
		digest.update(`file\0${fixture.destinationPath}\0${metadata.size}\0`);
		digest.update(readFileSync(path));
		digest.update("\0");
	}
	return digest.digest("hex");
}

function copyHostFixtures(
	executionWorkspace: string,
	fixtures: readonly BoundHostFixture[],
	expectedDigest: string,
): void {
	for (const fixture of fixtures) {
		const destination = resolve(executionWorkspace, fixture.destinationPath);
		mkdirSync(dirname(destination), { recursive: true });
		cpSync(fixture.sourcePath, destination, { dereference: false });
		chmodSync(destination, 0o600);
	}
	if (
		digestHostFixtureFiles(fixtures, (fixture) => resolve(executionWorkspace, fixture.destinationPath)) !==
		expectedDigest
	) {
		throw new Error("verification host fixture copy does not match its host-bound source fingerprint");
	}
}

function digestWorkspaceTree(workspace: string): string {
	const digest = createHash("sha256");
	digest.update("prime-avo-verification-source-v1\0");
	let totalBytes = 0;
	const visit = (absolute: string, relativePath: string): void => {
		const metadata = lstatSync(absolute);
		if (metadata.isSymbolicLink()) {
			digest.update(`symlink\0${relativePath}\0${readlinkSync(absolute)}\0`);
			return;
		}
		if (metadata.isFile()) {
			totalBytes += metadata.size;
			if (totalBytes > 1024 * 1024 * 1024) throw new Error("verification source exceeds 1073741824 bytes");
			digest.update(`file\0${relativePath}\0${metadata.mode}\0${metadata.size}\0`);
			digest.update(readFileSync(absolute));
			digest.update("\0");
			return;
		}
		if (!metadata.isDirectory()) throw new Error(`verification source has an unsupported type: ${relativePath}`);
		digest.update(`directory\0${relativePath}\0`);
		for (const entry of readdirSync(absolute).sort()) {
			visit(join(absolute, entry), relativePath ? `${relativePath}/${entry}` : entry);
		}
	};
	visit(workspace, "");
	return digest.digest("hex");
}

function validateAllowedCommand(command: string): string {
	if (!command || command.length > 4_096)
		throw new Error("verification broker command must contain 1-4096 characters");
	if (/[;&|`$<>()\r\n]/.test(command)) {
		throw new Error("verification broker command must be a direct invocation without shell expansion");
	}
	return command;
}

function normalizeTimeout(value: number | undefined, fallback: number, maximum: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value <= 0) throw new Error("verification broker timeout must be positive");
	return Math.min(value, maximum);
}

function environmentDigest(environment: NodeJS.ProcessEnv): string {
	return sha256(JSON.stringify(Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))));
}

function receiptPayload(receipt: Omit<AvoVerificationBrokerReceipt, "receiptDigest">): string {
	return JSON.stringify(receipt);
}

function parseReceipt(value: unknown, requestId: string, command: string): AvoVerificationBrokerReceipt {
	if (!isRecord(value)) throw new Error("verification broker returned no receipt");
	const receipt = value as unknown as AvoVerificationBrokerReceipt;
	if (
		receipt.protocolVersion !== AVO_VERIFICATION_BROKER_PROTOCOL_VERSION ||
		receipt.requestId !== requestId ||
		receipt.commandDigest !== sha256(command) ||
		!/^broker-[a-f0-9]{32}$/.test(receipt.brokerId) ||
		![
			receipt.controlDigest,
			receipt.hostFixtureDigest,
			receipt.postHostFixtureDigest,
			receipt.environmentDigest,
			receipt.workspaceDigest,
			receipt.postWorkspaceDigest,
			receipt.sourceDigest,
			receipt.postSourceDigest,
			receipt.outputDigest,
			receipt.receiptDigest,
		].every((digest) => /^[a-f0-9]{64}$/.test(digest)) ||
		receipt.hostFixtureDigest !== receipt.postHostFixtureDigest ||
		!Number.isSafeInteger(receipt.hostFixtureCount) ||
		receipt.hostFixtureCount < 0 ||
		receipt.workspaceDigest !== receipt.postWorkspaceDigest ||
		receipt.sourceDigest !== receipt.postSourceDigest ||
		!(receipt.exitCode === null || Number.isSafeInteger(receipt.exitCode)) ||
		!Number.isFinite(receipt.durationMs) ||
		receipt.durationMs < 0 ||
		typeof receipt.timedOut !== "boolean" ||
		receipt.sourceWorkspaceImmutable !== true ||
		receipt.disposableWorkspace !== true ||
		receipt.networkIsolated !== true ||
		typeof receipt.homeIsolated !== "boolean" ||
		receipt.hostFixturesImmutable !== true ||
		typeof receipt.pythonSemanticAuthority !== "boolean"
	) {
		throw new Error("verification broker returned an invalid receipt");
	}
	const { receiptDigest, ...payload } = receipt;
	if (sha256(receiptPayload(payload)) !== receiptDigest) {
		throw new Error("verification broker receipt digest does not match its execution payload");
	}
	return receipt;
}

export function avoVerificationBrokerReceiptMatchesWorkspace(
	command: string,
	verificationMode: string,
	receipt: AvoVerificationBrokerReceipt | undefined,
	expectedWorkspaceDigest: string,
): boolean {
	if (verificationMode !== "host_broker") return true;
	if (
		!receipt ||
		receipt.workspaceDigest !== expectedWorkspaceDigest ||
		receipt.postWorkspaceDigest !== expectedWorkspaceDigest
	) {
		return false;
	}
	try {
		parseReceipt(receipt, receipt.requestId, command);
		return true;
	} catch {
		return false;
	}
}

export function avoVerificationBrokerGrantsPythonSemanticAuthority(
	command: string,
	verificationMode: string,
	receipt: AvoVerificationBrokerReceipt | undefined,
): boolean {
	if (
		process.env[AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY_ENV] !== "1" ||
		verificationMode !== "host_broker" ||
		!receipt ||
		receipt.pythonSemanticAuthority !== true ||
		receipt.timedOut
	) {
		return false;
	}
	try {
		parseReceipt(receipt, receipt.requestId, command);
		return true;
	} catch {
		return false;
	}
}

function parseExecution(value: unknown, requestId: string, command: string): AvoVerificationBrokerExecution {
	if (!isRecord(value) || typeof value.output !== "string") {
		throw new Error("verification broker returned an invalid execution");
	}
	if (Buffer.byteLength(value.output) > AVO_VERIFICATION_BROKER_MAX_OUTPUT_BYTES) {
		throw new Error("verification broker returned oversized output");
	}
	const receipt = parseReceipt(value.receipt, requestId, command);
	if (sha256(value.output) !== receipt.outputDigest) {
		throw new Error("verification broker output does not match its receipt");
	}
	return { exitCode: receipt.exitCode, output: value.output, receipt };
}

function brokerConfiguration(): { socketPath: string; token: string } | undefined {
	const socketPath = process.env[AVO_VERIFICATION_BROKER_SOCKET_ENV];
	const token = process.env[AVO_VERIFICATION_BROKER_TOKEN_ENV];
	if (!socketPath && !token) return undefined;
	if (!socketPath || !token || !isAbsolute(socketPath) || !/^[a-f0-9]{64}$/.test(token)) {
		throw new Error("AVO host verification broker configuration is incomplete or invalid");
	}
	return { socketPath, token };
}

export function avoVerificationBrokerClientTimeoutMs(timeoutSeconds?: number): number {
	const requestedMs =
		timeoutSeconds === undefined
			? AVO_VERIFICATION_BROKER_HARD_MAXIMUM_TIMEOUT_MS
			: Math.ceil(timeoutSeconds * 1_000);
	return (
		Math.max(1, Math.min(AVO_VERIFICATION_BROKER_HARD_MAXIMUM_TIMEOUT_MS, requestedMs)) +
		AVO_VERIFICATION_BROKER_RESPONSE_MARGIN_MS
	);
}

export function createAvoVerificationBrokerBashOperations(): AvoVerificationBrokerBashOperations | undefined {
	const configuration = brokerConfiguration();
	if (!configuration) return undefined;
	let latestReceipt: AvoVerificationBrokerReceipt | undefined;
	return {
		verificationMode: "host_broker",
		lastReceipt: () => latestReceipt,
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolveExecution, rejectExecution) => {
				latestReceipt = undefined;
				const requestId = randomBytes(16).toString("hex");
				let response = "";
				let settled = false;
				const socket = createConnection(configuration.socketPath);
				const finish = (error?: Error, execution?: AvoVerificationBrokerExecution) => {
					if (settled) return;
					settled = true;
					clearTimeout(responseTimeout);
					if (signal) signal.removeEventListener("abort", onAbort);
					socket.destroy();
					if (error) rejectExecution(error);
					else if (execution) {
						latestReceipt = execution.receipt;
						onData(Buffer.from(execution.output));
						resolveExecution({ exitCode: execution.exitCode });
					}
				};
				const onAbort = () => finish(new Error("aborted"));
				const responseTimeout = setTimeout(
					() => finish(new Error("host verification broker timed out")),
					avoVerificationBrokerClientTimeoutMs(timeout),
				);
				if (signal) {
					if (signal.aborted) {
						onAbort();
						return;
					}
					signal.addEventListener("abort", onAbort, { once: true });
				}
				socket.setEncoding("utf8");
				socket.once("connect", () => {
					socket.write(
						`${JSON.stringify({
							protocolVersion: AVO_VERIFICATION_BROKER_PROTOCOL_VERSION,
							token: configuration.token,
							requestId,
							command,
							cwd,
							...(timeout === undefined ? {} : { timeoutMs: Math.ceil(timeout * 1_000) }),
						})}\n`,
					);
				});
				socket.on("data", (chunk: string) => {
					response += chunk;
					if (response.length > AVO_VERIFICATION_BROKER_MAX_RESPONSE_BYTES) {
						finish(new Error("host verification broker response exceeded its size limit"));
						return;
					}
					const newline = response.indexOf("\n");
					if (newline < 0) return;
					try {
						const envelope = JSON.parse(response.slice(0, newline)) as unknown;
						if (!isRecord(envelope) || envelope.protocolVersion !== AVO_VERIFICATION_BROKER_PROTOCOL_VERSION) {
							throw new Error("host verification broker returned an invalid protocol envelope");
						}
						if (typeof envelope.error === "string") {
							throw new Error(
								`host verification broker rejected the request: ${envelope.error.slice(0, 1_000)}`,
							);
						}
						finish(undefined, parseExecution(envelope.execution, requestId, command));
					} catch (error) {
						finish(error instanceof Error ? error : new Error(String(error)));
					}
				});
				socket.once("error", (error) =>
					finish(new Error(`host verification broker connection failed: ${error.message}`)),
				);
				socket.once("end", () => {
					if (!settled) finish(new Error("host verification broker closed without an execution"));
				});
			}),
	};
}

function parseBrokerRequest(value: unknown, token: string): ParsedBrokerRequest {
	if (
		!isRecord(value) ||
		value.protocolVersion !== AVO_VERIFICATION_BROKER_PROTOCOL_VERSION ||
		!constantTimeTokenMatches(token, value.token) ||
		typeof value.requestId !== "string" ||
		!/^[a-f0-9]{32}$/.test(value.requestId) ||
		typeof value.command !== "string" ||
		typeof value.cwd !== "string"
	) {
		throw new Error("unauthorized or invalid verification broker request");
	}
	if (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || (value.timeoutMs as number) <= 0)) {
		throw new Error("verification broker request timeout is invalid");
	}
	return {
		requestId: value.requestId,
		command: value.command,
		cwd: value.cwd,
		...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs as number }),
	};
}

function brokerSocketDirectory(): string {
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	if (runtimeDirectory && isAbsolute(runtimeDirectory) && existsSync(runtimeDirectory)) return runtimeDirectory;
	const fallback = join(homedir(), ".cache", "prime-agent", "verification-brokers");
	mkdirSync(fallback, { recursive: true, mode: 0o700 });
	return fallback;
}

function brokerSnapshotDirectory(): string {
	const root = join(brokerSocketDirectory(), "snapshots");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

async function listenOnSocket(server: Server, socketPath: string): Promise<void> {
	await new Promise<void>((resolveListen, rejectListen) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			rejectListen(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolveListen();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(socketPath, AVO_VERIFICATION_BROKER_MAX_CONNECTIONS);
	});
}

function sandboxDestinationDirectories(
	destinations: ReadonlyArray<{ path: string; directory: boolean }>,
	maskedRoots: readonly string[],
): string[] {
	const directories = new Set<string>();
	for (const destination of destinations) {
		for (const maskedRoot of maskedRoots) {
			if (destination.path !== maskedRoot && !destination.path.startsWith(`${maskedRoot}${sep}`)) continue;
			const parts = destination.path.slice(maskedRoot.length).split(sep).filter(Boolean);
			if (!destination.directory) parts.pop();
			let current = maskedRoot;
			for (const part of parts) {
				current = join(current, part);
				directories.add(current);
			}
		}
	}
	return [...directories]
		.sort((left, right) => left.split(sep).length - right.split(sep).length || left.localeCompare(right))
		.flatMap((directory) => ["--dir", directory]);
}

async function executeHostSandbox(
	options: {
		executionWorkspace: string;
		command: string;
		controlPaths: readonly string[];
		hiddenPaths: readonly string[];
		privateHome: boolean;
		visiblePaths: readonly string[];
		environment: NodeJS.ProcessEnv;
		timeoutMs: number;
	},
	signal: AbortSignal,
): Promise<{ exitCode: number | null; output: string; durationMs: number; timedOut: boolean }> {
	const startedAt = Date.now();
	return new Promise((resolveExecution, rejectExecution) => {
		const hostHome = realpathSync(homedir());
		const maskedRoots = ["/tmp", ...(options.privateHome ? [hostHome] : [])];
		const privateHome = "/tmp/prime-avo-home";
		const destinationDirectories = sandboxDestinationDirectories(
			[
				{ path: options.executionWorkspace, directory: true },
				...(options.privateHome ? [{ path: privateHome, directory: true }] : []),
				...options.visiblePaths.map((path) => ({ path, directory: lstatSync(path).isDirectory() })),
			],
			maskedRoots,
		);
		const args = [
			"--ro-bind",
			"/",
			"/",
			"--dev",
			"/dev",
			"--proc",
			"/proc",
			"--tmpfs",
			"/tmp",
			...(existsSync("/run") ? ["--tmpfs", "/run"] : []),
			...options.hiddenPaths.flatMap((path) => ["--tmpfs", path]),
			...(options.privateHome ? ["--tmpfs", hostHome] : []),
			...destinationDirectories,
			...options.visiblePaths.flatMap((path) => ["--ro-bind", path, path]),
			"--bind",
			options.executionWorkspace,
			options.executionWorkspace,
			...options.controlPaths.flatMap((path) => [
				"--ro-bind",
				resolve(options.executionWorkspace, path),
				resolve(options.executionWorkspace, path),
			]),
			"--unshare-net",
			"--unshare-pid",
			"--new-session",
			"--die-with-parent",
			"--cap-drop",
			"ALL",
			"--chdir",
			options.executionWorkspace,
			"--",
			"/bin/sh",
			"-c",
			options.command,
		];
		const child = spawn("/usr/bin/bwrap", args, {
			cwd: options.executionWorkspace,
			detached: true,
			env: {
				...options.environment,
				...(options.privateHome ? { HOME: privateHome } : {}),
				TMPDIR: "/tmp",
				TMP: "/tmp",
				TEMP: "/tmp",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let outputBytes = 0;
		let timedOut = false;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const append = (chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > AVO_VERIFICATION_BROKER_MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				return;
			}
			output += chunk.toString("utf8");
		};
		const finish = (error?: Error, exitCode: number | null = null) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal.removeEventListener("abort", onAbort);
			if (error) rejectExecution(error);
			else if (outputBytes > AVO_VERIFICATION_BROKER_MAX_OUTPUT_BYTES) {
				rejectExecution(new Error("verification output exceeded 2000000 bytes"));
			} else {
				resolveExecution({ exitCode, output, durationMs: Date.now() - startedAt, timedOut });
			}
		};
		const onAbort = () => child.kill("SIGKILL");
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.once("error", (error) => finish(error));
		child.once("close", (exitCode) => finish(undefined, exitCode));
		timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, options.timeoutMs);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}

export async function startAvoVerificationBroker(
	options: AvoVerificationBrokerOptions,
): Promise<AvoVerificationBrokerHandle> {
	if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) {
		throw new Error("the host verification broker requires Linux and /usr/bin/bwrap");
	}
	const workspace = realpathSync(resolve(options.workspace));
	if (!lstatSync(workspace).isDirectory()) throw new Error("verification broker workspace must be a directory");
	const allowedCommand = validateAllowedCommand(options.allowedCommand);
	const controlPaths = [...new Set(options.controlPaths.map((path) => safeRelativePath(path, "control path")))].sort();
	if (controlPaths.length === 0) throw new Error("verification broker requires at least one immutable control path");
	const initialControlDigest = digestControlPaths(workspace, controlPaths);
	const hostFixtures = (options.hostFixtures ?? [])
		.map((fixture): BoundHostFixture => {
			const requestedSource = resolve(fixture.sourcePath);
			const sourceMetadata = lstatSync(requestedSource);
			if (sourceMetadata.isSymbolicLink() || !sourceMetadata.isFile()) {
				throw new Error("verification host fixture source must be a regular non-symlink file");
			}
			const sourcePath = realpathSync(requestedSource);
			if (sourcePath === workspace || sourcePath.startsWith(`${workspace}${sep}`)) {
				throw new Error("verification host fixture source must be outside the model workspace");
			}
			const destinationPath = safeRelativePath(fixture.destinationPath, "host fixture destination");
			if (
				controlPaths.some(
					(controlPath) =>
						destinationPath === controlPath ||
						destinationPath.startsWith(`${controlPath}/`) ||
						controlPath.startsWith(`${destinationPath}/`),
				)
			) {
				throw new Error("verification host fixture destination must not overlap immutable controls");
			}
			const destination = resolve(workspace, destinationPath);
			if (existsSync(destination)) {
				throw new Error("verification host fixture destination must be absent from the model workspace");
			}
			let ancestor = workspace;
			for (const part of destinationPath.split("/").slice(0, -1)) {
				ancestor = join(ancestor, part);
				if (!existsSync(ancestor)) break;
				const ancestorMetadata = lstatSync(ancestor);
				if (ancestorMetadata.isSymbolicLink() || !ancestorMetadata.isDirectory()) {
					throw new Error("verification host fixture destination has an unsafe workspace ancestor");
				}
			}
			return { sourcePath, destinationPath };
		})
		.sort((left, right) => left.destinationPath.localeCompare(right.destinationPath));
	if (new Set(hostFixtures.map((fixture) => fixture.destinationPath)).size !== hostFixtures.length) {
		throw new Error("verification host fixtures contain duplicate destinations");
	}
	const initialHostFixtureDigest = digestHostFixtureFiles(hostFixtures, (fixture) => fixture.sourcePath);
	const hiddenPaths = [...new Set(options.hiddenPaths ?? [])]
		.map((path) => resolve(path))
		.filter((path) => existsSync(path))
		.sort();
	for (const hiddenPath of hiddenPaths) {
		const overlap =
			hiddenPath === workspace ||
			hiddenPath.startsWith(`${workspace}${sep}`) ||
			workspace.startsWith(`${hiddenPath}${sep}`);
		if (overlap) throw new Error("verification broker hidden paths must not overlap its workspace");
		if (!lstatSync(hiddenPath).isDirectory()) {
			throw new Error("verification broker hidden paths must be directories");
		}
	}
	const privateHome = options.privateHome === true;
	const hostHome = realpathSync(homedir());
	const visiblePaths = [...new Set(options.visiblePaths ?? [])]
		.map((path) => {
			const absolute = resolve(path);
			if (lstatSync(absolute).isSymbolicLink()) {
				throw new Error("verification broker visible paths must not be symbolic links");
			}
			return realpathSync(absolute);
		})
		.sort();
	if (!privateHome && visiblePaths.length > 0) {
		throw new Error("verification broker visible paths require private-home isolation");
	}
	for (const visiblePath of visiblePaths) {
		if (visiblePath === hostHome || !visiblePath.startsWith(`${hostHome}${sep}`)) {
			throw new Error("verification broker visible paths must be bounded descendants of the isolated home");
		}
		if (
			hiddenPaths.some(
				(hiddenPath) =>
					visiblePath === hiddenPath ||
					visiblePath.startsWith(`${hiddenPath}${sep}`) ||
					hiddenPath.startsWith(`${visiblePath}${sep}`),
			)
		) {
			throw new Error("verification broker visible paths must not overlap hidden paths");
		}
	}
	const defaultTimeoutMs = normalizeTimeout(
		options.defaultTimeoutMs,
		180_000,
		AVO_VERIFICATION_BROKER_HARD_MAXIMUM_TIMEOUT_MS,
	);
	const maximumTimeoutMs = normalizeTimeout(
		options.maximumTimeoutMs,
		AVO_VERIFICATION_BROKER_HARD_MAXIMUM_TIMEOUT_MS,
		AVO_VERIFICATION_BROKER_HARD_MAXIMUM_TIMEOUT_MS,
	);
	if (defaultTimeoutMs > maximumTimeoutMs) throw new Error("verification broker default timeout exceeds its maximum");
	const environment = sanitizeAvoVerificationEnvironment(options.environment ?? process.env);
	if (privateHome) environment.HOME = "/tmp/prime-avo-home";
	delete environment.DOCKER_HOST;
	delete environment.CONTAINER_HOST;
	const boundEnvironmentDigest = environmentDigest(environment);
	const brokerId = `broker-${randomBytes(16).toString("hex")}`;
	const token = randomBytes(32).toString("hex");
	const socketPath = join(
		brokerSocketDirectory(),
		`prime-avo-verify-${process.pid}-${randomBytes(6).toString("hex")}.sock`,
	);
	type ExecutionTask = {
		socket: Socket;
		abortController: AbortController;
		cancelled: boolean;
		completion?: Promise<void>;
		execute(): Promise<void>;
	};
	const clients = new Set<Socket>();
	const queuedExecutions: ExecutionTask[] = [];
	const activeTasks = new Set<ExecutionTask>();
	let activeExecutions = 0;
	let closing = false;
	const startExecution = (task: ExecutionTask) => {
		activeExecutions += 1;
		activeTasks.add(task);
		task.completion = task.execute().finally(() => {
			activeExecutions -= 1;
			activeTasks.delete(task);
			drainExecutions();
		});
		void task.completion;
	};
	const drainExecutions = () => {
		while (!closing && activeExecutions < AVO_VERIFICATION_BROKER_MAX_ACTIVE_EXECUTIONS) {
			const task = queuedExecutions.shift();
			if (!task) return;
			if (task.cancelled || task.socket.destroyed) continue;
			startExecution(task);
		}
	};
	const scheduleExecution = (task: ExecutionTask): boolean => {
		if (closing || task.socket.destroyed) return false;
		if (activeExecutions < AVO_VERIFICATION_BROKER_MAX_ACTIVE_EXECUTIONS) {
			startExecution(task);
			return true;
		}
		if (queuedExecutions.length >= AVO_VERIFICATION_BROKER_MAX_QUEUED_EXECUTIONS) return false;
		queuedExecutions.push(task);
		return true;
	};
	const server = createServer({ allowHalfOpen: true }, (socket) => {
		if (closing || clients.size >= AVO_VERIFICATION_BROKER_MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		clients.add(socket);
		let requestText = "";
		let requestBytes = 0;
		let handled = false;
		let authenticated = false;
		let requestDeadline: ReturnType<typeof setTimeout> | undefined;
		let task: ExecutionTask | undefined;
		const respond = (value: Record<string, unknown>) => {
			if (!socket.destroyed) {
				if (requestDeadline) clearTimeout(requestDeadline);
				requestDeadline = setTimeout(() => socket.destroy(), AVO_VERIFICATION_BROKER_REQUEST_IDLE_MS);
				socket.end(
					`${JSON.stringify({ protocolVersion: AVO_VERIFICATION_BROKER_PROTOCOL_VERSION, ...value })}\n`,
					() => {
						if (requestDeadline) clearTimeout(requestDeadline);
						socket.destroy();
					},
				);
			}
		};
		const rejectRequest = (message: string) => {
			if (handled) return;
			handled = true;
			socket.setTimeout(0);
			respond({ error: message });
		};
		socket.setEncoding("utf8");
		socket.once("error", () => socket.destroy());
		requestDeadline = setTimeout(
			() => rejectRequest("verification broker authentication timed out"),
			AVO_VERIFICATION_BROKER_PREAUTH_IDLE_MS,
		);
		socket.setTimeout(AVO_VERIFICATION_BROKER_PREAUTH_IDLE_MS, () => {
			rejectRequest(
				authenticated ? "verification broker request timed out" : "verification broker authentication timed out",
			);
		});
		socket.once("close", () => {
			if (requestDeadline) clearTimeout(requestDeadline);
			clients.delete(socket);
			if (!task) return;
			task.cancelled = true;
			task.abortController.abort();
			const queuedIndex = queuedExecutions.indexOf(task);
			if (queuedIndex >= 0) queuedExecutions.splice(queuedIndex, 1);
		});
		socket.on("data", (chunk: string) => {
			if (handled) return;
			requestText += chunk;
			requestBytes += Buffer.byteLength(chunk);
			if (!authenticated) {
				const authenticationWindow = Buffer.from(requestText)
					.subarray(0, AVO_VERIFICATION_BROKER_PREAUTH_MAX_BYTES)
					.toString("utf8");
				const observedToken = /"token"\s*:\s*"([^"\\]*)"/.exec(authenticationWindow)?.[1];
				const observedProtocol = /"protocolVersion"\s*:\s*(\d+)/.exec(authenticationWindow)?.[1];
				if (observedToken !== undefined && !constantTimeTokenMatches(token, observedToken)) {
					rejectRequest("unauthorized or invalid verification broker request");
					return;
				}
				if (observedToken !== undefined && observedProtocol !== undefined) {
					if (observedProtocol !== String(AVO_VERIFICATION_BROKER_PROTOCOL_VERSION)) {
						rejectRequest("unauthorized or invalid verification broker request");
						return;
					}
					authenticated = true;
					socket.setTimeout(AVO_VERIFICATION_BROKER_REQUEST_IDLE_MS);
					if (requestDeadline) clearTimeout(requestDeadline);
					requestDeadline = setTimeout(
						() => rejectRequest("verification broker request timed out"),
						AVO_VERIFICATION_BROKER_REQUEST_IDLE_MS,
					);
				} else if (requestBytes > AVO_VERIFICATION_BROKER_PREAUTH_MAX_BYTES || requestText.includes("\n")) {
					rejectRequest("unauthorized or invalid verification broker request");
					return;
				} else {
					return;
				}
			}
			if (requestBytes > AVO_VERIFICATION_BROKER_MAX_REQUEST_BYTES) {
				rejectRequest("request exceeded 32768 bytes");
				return;
			}
			const newline = requestText.indexOf("\n");
			if (newline < 0) return;
			const requestLine = requestText.slice(0, newline);
			requestText = "";
			handled = true;
			socket.setTimeout(0);
			if (requestDeadline) clearTimeout(requestDeadline);
			try {
				const request = parseBrokerRequest(JSON.parse(requestLine) as unknown, token);
				if (request.command !== allowedCommand) {
					throw new Error("verification command is not the exact host-allowlisted command");
				}
				if (realpathSync(resolve(request.cwd)) !== workspace) {
					throw new Error("verification request cwd does not match the host-bound workspace");
				}
				const abortController = new AbortController();
				task = {
					socket,
					abortController,
					cancelled: false,
					execute: async () => {
						try {
							if (abortController.signal.aborted) throw new Error("verification broker request aborted");
							if (digestControlPaths(workspace, controlPaths) !== initialControlDigest) {
								throw new Error("verification controls changed after broker registration");
							}
							if (
								digestHostFixtureFiles(hostFixtures, (fixture) => fixture.sourcePath) !==
								initialHostFixtureDigest
							) {
								throw new Error("verification host fixtures changed after broker registration");
							}
							const workspaceDigest = captureAvoWorkspaceSnapshot(workspace).digest;
							const sourceDigest = digestWorkspaceTree(workspace);
							const snapshotRoot = mkdtempSync(join(brokerSnapshotDirectory(), "request-"));
							const executionWorkspace = join(snapshotRoot, "workspace");
							const { execution, postSourceDigest, postWorkspaceDigest, postHostFixtureDigest } =
								await (async () => {
									try {
										cpSync(workspace, executionWorkspace, {
											recursive: true,
											dereference: false,
											preserveTimestamps: true,
										});
										if (
											digestWorkspaceTree(workspace) !== sourceDigest ||
											digestWorkspaceTree(executionWorkspace) !== sourceDigest ||
											captureAvoWorkspaceSnapshot(workspace).digest !== workspaceDigest ||
											captureAvoWorkspaceSnapshot(executionWorkspace).digest !== workspaceDigest
										) {
											throw new Error(
												"verification source changed while its disposable snapshot was captured",
											);
										}
										copyHostFixtures(executionWorkspace, hostFixtures, initialHostFixtureDigest);
										const disposableExecution = await executeHostSandbox(
											{
												executionWorkspace,
												command: request.command,
												controlPaths,
												hiddenPaths,
												privateHome,
												visiblePaths,
												environment,
												timeoutMs: normalizeTimeout(request.timeoutMs, defaultTimeoutMs, maximumTimeoutMs),
											},
											abortController.signal,
										);
										if (abortController.signal.aborted) {
											throw new Error("verification broker request aborted");
										}
										return {
											execution: disposableExecution,
											postSourceDigest: digestWorkspaceTree(workspace),
											postWorkspaceDigest: captureAvoWorkspaceSnapshot(workspace).digest,
											postHostFixtureDigest: digestHostFixtureFiles(
												hostFixtures,
												(fixture) => fixture.sourcePath,
											),
										};
									} finally {
										rmSync(snapshotRoot, { recursive: true, force: true });
									}
								})();
							if (sourceDigest !== postSourceDigest) {
								throw new Error("verification source changed during broker execution");
							}
							if (workspaceDigest !== postWorkspaceDigest) {
								throw new Error("verification semantic workspace changed during broker execution");
							}
							if (initialHostFixtureDigest !== postHostFixtureDigest) {
								throw new Error("verification host fixtures changed during broker execution");
							}
							if (digestControlPaths(workspace, controlPaths) !== initialControlDigest) {
								throw new Error("verification controls changed during broker execution");
							}
							const payload: Omit<AvoVerificationBrokerReceipt, "receiptDigest"> = {
								protocolVersion: 1,
								brokerId,
								requestId: request.requestId,
								commandDigest: sha256(request.command),
								controlDigest: initialControlDigest,
								hostFixtureDigest: initialHostFixtureDigest,
								postHostFixtureDigest,
								hostFixtureCount: hostFixtures.length,
								environmentDigest: boundEnvironmentDigest,
								workspaceDigest,
								postWorkspaceDigest,
								sourceDigest,
								postSourceDigest,
								exitCode: execution.exitCode,
								outputDigest: sha256(execution.output),
								durationMs: execution.durationMs,
								timedOut: execution.timedOut,
								sourceWorkspaceImmutable: true,
								disposableWorkspace: true,
								networkIsolated: true,
								homeIsolated: privateHome,
								hostFixturesImmutable: true,
								pythonSemanticAuthority: options.pythonSemanticAuthority === true,
							};
							const receipt: AvoVerificationBrokerReceipt = {
								...payload,
								receiptDigest: sha256(receiptPayload(payload)),
							};
							respond({ execution: { exitCode: execution.exitCode, output: execution.output, receipt } });
						} catch (error) {
							respond({
								error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
							});
						}
					},
				};
				if (!scheduleExecution(task)) respond({ error: "verification broker is at execution capacity" });
			} catch (error) {
				respond({
					error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
				});
			}
		});
	});
	server.maxConnections = AVO_VERIFICATION_BROKER_MAX_CONNECTIONS;
	await listenOnSocket(server, socketPath);
	chmodSync(socketPath, 0o600);
	let closePromise: Promise<void> | undefined;
	return {
		socketPath,
		token,
		brokerId,
		close: () => {
			closePromise ??= (async () => {
				closing = true;
				const activeCompletions = [...activeTasks].flatMap((active) => {
					active.cancelled = true;
					active.abortController.abort();
					return active.completion ? [active.completion] : [];
				});
				for (const queued of queuedExecutions) {
					queued.cancelled = true;
					queued.abortController.abort();
				}
				queuedExecutions.length = 0;
				for (const client of clients) client.destroy();
				const serverClosed = new Promise<void>((resolveClose) => server.close(() => resolveClose()));
				await Promise.allSettled(activeCompletions);
				await serverClosed;
				rmSync(socketPath, { force: true });
			})();
			return closePromise;
		},
	};
}
