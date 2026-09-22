/**
 * Local benchmark: full-history bytes on the wire + wall-clock latency for a
 * warm session switch into a large (48k-entry) transcript.
 *
 * Method: spawn the real daemon (built dist) over a local socket with an
 * isolated agent dir, attach a real DaemonAgentConnection (source via tsx,
 * direct worker link like the TUI), then measure the switch window:
 *   1. await connection.switchSession(largeSessionPath)
 *   2. await connection.getInitialSnapshot()   (the TUI's post-switch render)
 * and account every daemon->client frame (JSON payload size) plus every
 * command response the client issued during the window, split by whether the
 * frame carries the full transcript (chunked snapshot, inline replacement,
 * get_messages response, get_session_context response).
 *
 * Usage:
 *   npx tsx scripts/bench-switch-doublefetch.ts --trials 3
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { DaemonClient } from "../packages/coding-agent/src/modes/daemon/daemon-client.js";
import { DaemonAgentConnection } from "../packages/coding-agent/src/modes/agent-connection/daemon-agent-connection.js";
import { createDaemonSessionTransport } from "../packages/coding-agent/src/modes/daemon/daemon-routed-client.js";
import type { DaemonCommand, DaemonResponse } from "../packages/coding-agent/src/modes/daemon/daemon-protocol.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_INSTANCE_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_STARTUP_GATE_FD_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
} from "../packages/coding-agent/src/modes/daemon/daemon-worker-protocol.js";

// Fixture shape ported from scripts/benchmarks/ui.py (_session_lines): a
// deterministic realistic mix of user / assistant(thinking+text+toolCall) /
// toolResult entries per step, so a 16000-step transcript matches the 18k-step
// 48k-entry session PR #2399 profiled (~35MB per full-history frame).
const BASE_TIMESTAMP_MS = 946684800000;
const TOOL_OUTPUT_LINES = 60;

function iso(ms: number): string {
	return new Date(ms).toISOString();
}

function sessionLines(name: string, identifier: string, count: number, cwd: string): string {
	let timestamp = BASE_TIMESTAMP_MS;
	let parent: string | null = null;
	const lines: string[] = [];
	const prefix = identifier.replaceAll("-", "").slice(0, 8);
	const link = (entryId: string) => {
		timestamp += 1000;
		const entry: Record<string, unknown> = {
			id: entryId,
			parentId: parent,
			timestamp: iso(timestamp),
		};
		parent = entryId;
		return entry;
	};
	lines.push(
		JSON.stringify({
			type: "session",
			version: 3,
			id: identifier,
			timestamp: iso(timestamp),
			cwd,
			rlmDepth: 0,
		}),
	);
	const info = link(`${prefix}n`);
	info.type = "session_info";
	info.name = name;
	lines.push(JSON.stringify(info));
	const model = link(`${prefix}m`);
	model.type = "model_change";
	model.provider = "prime-inference";
	model.modelId = "internal/glm-5.3-fast";
	lines.push(JSON.stringify(model));
	const usage = {
		input: 100,
		output: 50,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 150,
		cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 },
	};
	for (let index = 0; index < count; index++) {
		const final = index === count - 1;
		const user = link(`${prefix}u${index}`);
		user.type = "message";
		user.message = {
			role: "user",
			timestamp: 0,
			content: `Please continue task ${name} step ${index}: review the module, run the checks, and summarize findings for the migration notes.`,
		};
		lines.push(JSON.stringify(user));
		const text = `Working on ${name} step ${index}. The parser handles nested records correctly; the next edit keeps the schema stable while trimming the duplicated branch.`;
		const content: unknown[] = [
			{
				type: "thinking",
				thinking: `Step ${index} for ${name}: check the invariants, then update the affected call sites before running the full suite again to confirm no behavior changed.`,
			},
			{ type: "text", text },
		];
		if (!final) {
			content.push({ type: "toolCall", id: `call-${index}`, name: "ipython", arguments: { code: "pass" } });
		}
		const assistant = link(`${prefix}a${index}`);
		assistant.type = "message";
		assistant.message = {
			role: "assistant",
			timestamp: 0,
			content,
			api: "responses",
			provider: "prime-inference",
			model: "internal/glm-5.3-fast",
			usage,
			stopReason: final ? "stop" : "toolUse",
		};
		lines.push(JSON.stringify(assistant));
		if (!final) {
			const tool = link(`${prefix}t${index}`);
			tool.type = "message";
			tool.message = {
				role: "toolResult",
				toolCallId: `call-${index}`,
				toolName: "ipython",
				content: [{ type: "text", text: "all checks passed\n".repeat(TOOL_OUTPUT_LINES) }],
				isError: false,
				timestamp: 0,
			};
			lines.push(JSON.stringify(tool));
		}
	}
	return `${lines.join("\n")}\n`;
}

interface Counters {
	commandCounts: Map<string, number>;
	responseBytes: Map<string, number>;
	responseMs: Map<string, number>;
	outboundFrames: Map<string, number>;
	outboundBytes: Map<string, number>;
	/** Full transcript crossings in the window: streamed snapshots, inline replacements, and full-history refetches. */
	fullHistoryTransfers: number;
}

function newCounters(): Counters {
	return {
		commandCounts: new Map(),
		responseBytes: new Map(),
		responseMs: new Map(),
		outboundFrames: new Map(),
		outboundBytes: new Map(),
		fullHistoryTransfers: 0,
	};
}

function bump(map: Map<string, number>, key: string, delta: number): void {
	map.set(key, (map.get(key) ?? 0) + delta);
}

function messageKind(message: { type: string }): string {
	return message.type;
}

function fullHistoryBytes(counters: Counters): number {
	let total = 0;
	// Streamed replacement snapshot frames carry the transcript once.
	for (const kind of ["session_snapshot_begin", "session_snapshot_chunk", "session_snapshot_end"]) {
		total += counters.outboundBytes.get(kind) ?? 0;
	}
	// An inline session_replaced carries the full transcript in one frame.
	total += counters.outboundBytes.get("session_replaced") ?? 0;
	// Full-history refetch responses.
	total += counters.responseBytes.get("get_messages") ?? 0;
	total += counters.responseBytes.get("get_session_context") ?? 0;
	return total;
}

async function waitForSocket(socketPath: string, deadlineMs: number): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (Date.now() - start > deadlineMs) throw new Error("daemon socket did not appear");
		const ok = await new Promise<boolean>((resolve) => {
			const socket = connect(socketPath);
			socket.once("connect", () => {
				socket.destroy();
				resolve(true);
			});
			socket.once("error", () => resolve(false));
		});
		if (ok) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			timer.unref?.();
		}),
	]);
}

interface TrialResult {
	switchMs: number;
	snapshotMs: number;
	totalMs: number;
	commandCounts: Record<string, number>;
	fullHistoryBytes: number;
	fullHistoryTransfers: number;
	totalBytes: number;
}

const TRIAL_DEADLINE_MS = 120_000;

/**
 * The bench itself may run inside a daemon worker. The spawned daemon must not
 * inherit that role: a worker daemon speaks private-framed transport, while the
 * supervisor client used below reads JSONL.
 */
function supervisorEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
	for (const name of [
		DAEMON_WORKER_ROLE_ENV,
		DAEMON_WORKER_TOKEN_ENV,
		DAEMON_WORKER_INSTANCE_ID_ENV,
		DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
		DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
		DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
		DAEMON_WORKER_STARTUP_GATE_FD_ENV,
	]) {
		delete environment[name];
	}
	return environment;
}

async function runTrial(trial: number, agentDir: string, workspace: string): Promise<TrialResult> {
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const smallId = `00000000-0000-4000-8000-0000000000a${trial}`;
	const largeId = `00000000-0000-4000-8000-0000000000b${trial}`;
	const smallPath = join(sessionsDir, `${smallId}.jsonl`);
	const largePath = join(sessionsDir, `${largeId}.jsonl`);
	writeFileSync(smallPath, sessionLines(`bench-small-${trial}`, smallId, 2000, workspace));
	writeFileSync(largePath, sessionLines(`bench-large-${trial}`, largeId, 16000, workspace));

	const socketPath = join(agentDir, `daemon-${trial}.sock`);
	const repoRoot = fileURLToPath(new URL("..", import.meta.url));
	const entrypoint = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
	const daemon: ChildProcess = spawn(process.execPath, [entrypoint, "--mode", "daemon", "--daemon-socket", socketPath], {
		stdio: "ignore",
		env: supervisorEnvironment(agentDir),
		// Own process group: the supervisor leaves its session worker running on
		// SIGTERM, so the trial stops the whole group when it tears down.
		detached: true,
	});
	const trialStart = performance.now();
	try {
		await waitForSocket(socketPath, 30_000);
		const supervisor = new DaemonClient(socketPath);
		await withTimeout(supervisor.connect(), 15_000, "daemon connect");
		await withTimeout(supervisor.waitForHello(20_000), 25_000, "daemon hello");

		const createResponse = await withTimeout(
			supervisor.request({ id: "c1", type: "create", sessionPath: smallPath } as unknown as DaemonCommand, 30_000),
			35_000,
			"create session",
		);
		if (!createResponse.success) throw new Error(`create failed: ${createResponse.error}`);
		const activeSessionId = (createResponse.data as { activeSessionId: string }).activeSessionId;

		const transport = await createDaemonSessionTransport(supervisor, activeSessionId, false);
		const routed = (transport as { constructor?: { name?: string } }).constructor?.name === "DaemonRoutedClient";
		console.log(`trial ${trial}: transport ${routed ? "direct worker link (private-framed)" : "supervisor (jsonl)"}`);
		const counters = newCounters();
		transport.onMessage((message) => {
			const kind = messageKind(message);
			bump(counters.outboundFrames, kind, 1);
			bump(counters.outboundBytes, kind, JSON.stringify(message).length + 1);
			if (
				kind === "session_snapshot_end" ||
				(kind === "session_replaced" && Array.isArray((message as { messages?: unknown[] }).messages) && ((message as { messages: unknown[] }).messages.length > 0))
			) {
				counters.fullHistoryTransfers++;
			}
		});
		const originalRequest = transport.request.bind(transport);
		transport.request = (async (command: DaemonCommand, timeoutMs?: number, options?: unknown) => {
			const started = performance.now();
			const response: DaemonResponse = await originalRequest(
				command,
				timeoutMs,
				options as never,
			);
			const kind = command.type;
			bump(counters.commandCounts, kind, 1);
			bump(counters.responseBytes, kind, JSON.stringify(response).length + 1);
			bump(counters.responseMs, kind, performance.now() - started);
			if (kind === "get_messages" || kind === "get_session_context") {
				counters.fullHistoryTransfers++;
			}
			return response;
		}) as typeof transport.request;

		const connection = new DaemonAgentConnection(transport, activeSessionId, {});
		await withTimeout(connection.attach(), 30_000, "attach");
		await withTimeout(connection.getInitialSnapshot(), 30_000, "initial snapshot");

		// Switch window: reset counters around the warm switch.
		for (const key of [...counters.commandCounts.keys()]) counters.commandCounts.delete(key);
		for (const key of [...counters.responseBytes.keys()]) counters.responseBytes.delete(key);
		for (const key of [...counters.responseMs.keys()]) counters.responseMs.delete(key);
		for (const key of [...counters.outboundFrames.keys()]) counters.outboundFrames.delete(key);
		for (const key of [...counters.outboundBytes.keys()]) counters.outboundBytes.delete(key);
		counters.fullHistoryTransfers = 0;

		const t0 = performance.now();
		const switched = await withTimeout(connection.switchSession(largePath), 60_000, "switchSession");
		const tSwitch = performance.now();
		if (switched.cancelled) throw new Error("switch was cancelled");
		const snapshot = await withTimeout(connection.getInitialSnapshot(), 60_000, "getInitialSnapshot");
		const tSnapshot = performance.now();
		if (snapshot.messages.length === 0) throw new Error("switch produced an empty transcript");

		const result: TrialResult = {
			switchMs: tSwitch - t0,
			snapshotMs: tSnapshot - tSwitch,
			totalMs: tSnapshot - t0,
			commandCounts: Object.fromEntries(counters.commandCounts),
			fullHistoryBytes: fullHistoryBytes(counters),
			fullHistoryTransfers: counters.fullHistoryTransfers,
			totalBytes: [...counters.outboundBytes.values()].reduce((a, b) => a + b, 0) +
				[...counters.responseBytes.values()].reduce((a, b) => a + b, 0),
		};
		await withTimeout(connection.dispose(), 15_000, "dispose");
		// The supervisor's SIGTERM path closes its socket without stopping the detached
		// session worker, so the teardown asks for the worker-stopping shutdown while
		// this socket is still open.
		await withTimeout(
			supervisor.request({ type: "shutdown", force: true } as unknown as DaemonCommand, 10_000),
			15_000,
			"shutdown",
		).catch(() => undefined);
		supervisor.close();
		const elapsed = performance.now() - trialStart;
		if (elapsed > TRIAL_DEADLINE_MS) throw new Error(`trial exceeded ${TRIAL_DEADLINE_MS}ms budget`);
		return result;
	} finally {
		await stopDaemon(daemon);
	}
}

/**
 * Wait for the supervisor to finish the shutdown the trial requested, and fall back
 * to signals so a wedged daemon cannot leave the benchmark hanging. A supervisor
 * killed with SIGTERM alone would leave its detached session worker (and that
 * worker's session state) running after the trial.
 */
async function stopDaemon(daemon: ChildProcess): Promise<void> {
	for (const signal of [undefined, "SIGTERM", "SIGKILL"] as const) {
		if (await waitForDaemonExit(daemon, signal === undefined ? 10_000 : 5_000)) return;
		daemon.kill(signal ?? "SIGTERM");
	}
}

/** Resolve true when the daemon has exited within the budget. */
async function waitForDaemonExit(daemon: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (daemon.exitCode !== null || daemon.signalCode !== null) return true;
	return await new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		daemon.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

const args = process.argv.slice(2);
const trialsIndex = args.indexOf("--trials");
const trials = trialsIndex === -1 ? 3 : Number(args[trialsIndex + 1] ?? 3);

const median = (values: number[]): number => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
};

const results: TrialResult[] = [];
for (let trial = 1; trial <= trials; trial++) {
	const agentDir = mkdtempSync(join(tmpdir(), `pi-switch-bench-${trial}-`));
	const workspace = join(agentDir, "workspace");
	mkdirSync(workspace, { recursive: true });
	try {
		const result = await runTrial(trial, agentDir, workspace);
		results.push(result);
		console.log(
			`trial ${trial}: switch ${result.switchMs.toFixed(0)}ms + snapshot ${result.snapshotMs.toFixed(0)}ms = ${result.totalMs.toFixed(0)}ms; full-history transfers ${result.fullHistoryTransfers}; full-history bytes ${(result.fullHistoryBytes / 1024 / 1024).toFixed(1)}MB; total wire bytes ${(result.totalBytes / 1024 / 1024).toFixed(1)}MB; commands ${JSON.stringify(result.commandCounts)}`,
		);
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
}

if (results.length > 0) {
	console.log("");
	console.log(`median switchSession:          ${median(results.map((r) => r.switchMs)).toFixed(0)}ms`);
	console.log(`median getInitialSnapshot:      ${median(results.map((r) => r.snapshotMs)).toFixed(0)}ms`);
	console.log(`median total switch window:    ${median(results.map((r) => r.totalMs)).toFixed(0)}ms`);
	console.log(`median full-history transfers: ${median(results.map((r) => r.fullHistoryTransfers))}`);
	console.log(`median full-history bytes:     ${(median(results.map((r) => r.fullHistoryBytes)) / 1024 / 1024).toFixed(1)}MB`);
	console.log(`median total wire bytes:       ${(median(results.map((r) => r.totalBytes)) / 1024 / 1024).toFixed(1)}MB`);
}

// Flush stdout before exiting so piped output is not truncated, and leave through
// process.exit: a stray daemon handle must not keep the benchmark alive.
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
