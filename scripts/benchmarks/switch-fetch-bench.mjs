/**
 * Session-switch transcript-fetch benchmark: one warm switch into a large
 * (16k-step) session through a real daemon and a direct worker link, counting
 * how many times the full transcript crosses the wire in the switch window
 * (streamed replacement snapshots, inline replacements, and full-history
 * refetch responses). Ports the measurement of scripts/bench-switch-doublefetch.ts
 * to the CI harness so benchmark runs compare main and the PR head directly.
 *
 * Runs against the prepared source build and prints one RESULT line with the
 * transfer count; the benchmark worker records it as the switch_fetch metric.
 *
 * Usage: node switch-fetch-bench.mjs --dist <packages/coding-agent dist>
 */
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const SMALL_STEPS = 2000;
const LARGE_STEPS = 16000;
const TOOL_OUTPUT_LINES = 60;
const BASE_TIMESTAMP_MS = 946684800000;
const TRIAL_DEADLINE_MS = 120_000;

function parseArgs(argv) {
	const args = { dist: "" };
	for (let index = 2; index < argv.length; index++) {
		if (argv[index] === "--dist" && argv[index + 1]) {
			args.dist = argv[index + 1];
			index++;
		}
	}
	if (!args.dist) {
		throw new Error("usage: node switch-fetch-bench.mjs --dist <coding-agent dist>");
	}
	return args;
}

function iso(ms) {
	return new Date(ms).toISOString();
}

/** Fixture shape ported from scripts/benchmarks/ui.py and bench-switch-doublefetch.ts. */
function sessionLines(name, identifier, count, cwd) {
	let timestamp = BASE_TIMESTAMP_MS;
	let parent = null;
	const lines = [];
	const prefix = identifier.replaceAll("-", "").slice(0, 8);
	const link = (entryId) => {
		timestamp += 1000;
		const entry = { id: entryId, parentId: parent, timestamp: iso(timestamp) };
		parent = entryId;
		return entry;
	};
	lines.push(JSON.stringify({ type: "session", version: 3, id: identifier, timestamp: iso(timestamp), cwd, rlmDepth: 0 }));
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
		const content = [
			{
				type: "thinking",
				thinking: `Step ${index} for ${name}: check the invariants, then update the affected call sites before running the full suite again to confirm no behavior changed.`,
			},
			{
				type: "text",
				text: `Working on ${name} step ${index}. The parser handles nested records correctly; the next edit keeps the schema stable while trimming the duplicated branch.`,
			},
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
			modelId: "internal/glm-5.3-fast",
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

function bump(map, key, delta) {
	map.set(key, (map.get(key) ?? 0) + delta);
}

async function waitForSocket(socketPath, deadlineMs) {
	const started = Date.now();
	for (;;) {
		if (Date.now() - started > deadlineMs) throw new Error("daemon socket did not appear");
		const connected = await new Promise((resolve) => {
			const probe = connect(socketPath);
			probe.once("connect", () => {
				probe.destroy();
				resolve(true);
			});
			probe.once("error", () => resolve(false));
		});
		if (connected) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function withTimeout(promise, ms, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
			timer.unref?.();
		}),
	]);
}

async function waitForDaemonExit(daemon, timeoutMs) {
	if (daemon.exitCode !== null || daemon.signalCode !== null) return true;
	return await new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		daemon.once("exit", () => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

async function stopDaemon(daemon, { swift = false } = {}) {
	for (const signal of swift ? ["SIGTERM", "SIGKILL"] : [undefined, "SIGTERM", "SIGKILL"]) {
		if (await waitForDaemonExit(daemon, signal === undefined ? 10_000 : 5_000)) return;
		try {
			// The daemon leads its own detached process group, so signalling the group
			// also reaches a session worker a wedged supervisor never stopped.
			process.kill(-daemon.pid, signal ?? "SIGTERM");
		} catch {
			// The group is already gone; wait again before the stronger signal.
		}
	}
}

async function main() {
	// Resolve before spawning the daemon with a different cwd.
	const dist = resolve(parseArgs(process.argv).dist);
	const module = (path) => import(pathToFileURL(join(dist, path)).href);
	const { DaemonClient } = await module("modes/daemon/daemon-client.js");
	const { DaemonAgentConnection } = await module("modes/agent-connection/daemon-agent-connection.js");
	const { createDaemonSessionTransport } = await module("modes/daemon/daemon-routed-client.js");
	const workerProtocol = await module("modes/daemon/daemon-worker-protocol.js");

	const supervisorEnvironment = (agentDir) => {
		const environment = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" };
		for (const name of [
			workerProtocol.DAEMON_WORKER_ROLE_ENV,
			workerProtocol.DAEMON_WORKER_TOKEN_ENV,
			workerProtocol.DAEMON_WORKER_INSTANCE_ID_ENV,
			workerProtocol.DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
			workerProtocol.DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
			workerProtocol.DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
			workerProtocol.DAEMON_WORKER_STARTUP_GATE_FD_ENV,
		]) {
			delete environment[name];
		}
		return environment;
	};

	const agentDir = mkdtempSync(join(tmpdir(), "pi-switch-fetch-bench-"));
	const workspace = join(agentDir, "workspace");
	mkdirSync(workspace, { recursive: true });
	const trialStart = performance.now();
	let daemon;
	const runTrial = async () => {
		const sessionsDir = join(agentDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const smallId = "00000000-0000-4000-8000-0000000000aa";
		const largeId = "00000000-0000-4000-8000-0000000000bb";
		const smallPath = join(sessionsDir, `${smallId}.jsonl`);
		const largePath = join(sessionsDir, `${largeId}.jsonl`);
		writeFileSync(smallPath, sessionLines("bench-switch-fetch-small", smallId, SMALL_STEPS, workspace));
		writeFileSync(largePath, sessionLines("bench-switch-fetch-large", largeId, LARGE_STEPS, workspace));
		const socketPath = join(agentDir, "daemon.sock");
		daemon = spawn(
			process.execPath,
			[join(dist, "cli.js"), "--mode", "daemon", "--daemon-socket", socketPath],
			{ cwd: workspace, env: supervisorEnvironment(agentDir), stdio: "ignore", detached: true },
		);
		await waitForSocket(socketPath, 30_000);
		const supervisor = new DaemonClient(socketPath);
		await withTimeout(supervisor.connect(), 15_000, "daemon connect");
		await withTimeout(supervisor.waitForHello(20_000), 25_000, "daemon hello");
		const createResponse = await withTimeout(
			supervisor.request({ id: "create", type: "create", sessionPath: smallPath }, 30_000),
			35_000,
			"create session",
		);
		if (!createResponse.success) throw new Error(`create failed: ${createResponse.error}`);
		const activeSessionId = createResponse.data.activeSessionId;

		const transport = await createDaemonSessionTransport(supervisor, activeSessionId, false);
		const commandCounts = new Map();
		const responseBytes = new Map();
		const outboundBytes = new Map();
		let fullHistoryTransfers = 0;
		transport.onMessage((message) => {
			const kind = message.type;
			bump(outboundBytes, kind, JSON.stringify(message).length + 1);
			if (kind === "session_snapshot_end") {
				fullHistoryTransfers++;
			}
			if (kind === "session_replaced" && Array.isArray(message.messages) && message.messages.length > 0) {
				fullHistoryTransfers++;
			}
		});
		const originalRequest = transport.request.bind(transport);
		transport.request = async (command, timeoutMs, options) => {
			const response = await originalRequest(command, timeoutMs, options);
			const kind = command.type;
			bump(commandCounts, kind, 1);
			bump(responseBytes, kind, JSON.stringify(response).length + 1);
			if (kind === "get_messages" || kind === "get_session_context") {
				fullHistoryTransfers++;
			}
			return response;
		};

		const connection = new DaemonAgentConnection(transport, activeSessionId, {});
		await withTimeout(connection.attach(), 30_000, "attach");
		await withTimeout(connection.getInitialSnapshot(), 30_000, "initial snapshot");

		// Switch window: count every full-history crossing while the switch happens.
		commandCounts.clear();
		responseBytes.clear();
		outboundBytes.clear();
		fullHistoryTransfers = 0;

		const started = performance.now();
		const switched = await withTimeout(connection.switchSession(largePath), 60_000, "switchSession");
		if (switched.cancelled) throw new Error("switch was cancelled");
		const snapshot = await withTimeout(connection.getInitialSnapshot(), 60_000, "getInitialSnapshot");
		const switchWindowMs = performance.now() - started;
		if (snapshot.messages.length === 0) throw new Error("switch produced an empty transcript");
		if (fullHistoryTransfers < 1) throw new Error("no full-history transfer was observed during the switch");
		let fullHistoryBytes = 0;
		for (const kind of ["session_snapshot_begin", "session_snapshot_chunk", "session_snapshot_end"]) {
			fullHistoryBytes += outboundBytes.get(kind) ?? 0;
		}
		fullHistoryBytes += outboundBytes.get("session_replaced") ?? 0;
		fullHistoryBytes += responseBytes.get("get_messages") ?? 0;
		fullHistoryBytes += responseBytes.get("get_session_context") ?? 0;
		const commands = Object.fromEntries(commandCounts);
		await withTimeout(connection.dispose(), 15_000, "dispose");
		await withTimeout(
			supervisor.request({ type: "shutdown", force: true }, 10_000),
			15_000,
			"shutdown",
		).catch(() => undefined);
		supervisor.close();
		// Await the pipe flush so the recorded value cannot be truncated.
		await new Promise((resolve) => {
			process.stdout.write(
				`RESULT ${JSON.stringify({
					value: fullHistoryTransfers,
					switch_window_ms: Math.round(switchWindowMs),
					full_history_bytes: fullHistoryBytes,
					commands: commands,
				})}\n`,
				resolve,
			);
		});
	};
	// One race bounds the whole trial, not a check at its end: every step keeps
	// its own smaller timeout, and the losing trial's late rejection is expected
	// once the deadline kills the daemon. Teardown still fits the worker timeout.
	const trial = runTrial();
	trial.catch(() => undefined);
	let trialTimer;
	let completed = false;
	try {
		await Promise.race([
			trial,
			new Promise((_, reject) => {
				trialTimer = setTimeout(
					() => reject(new Error(`trial exceeded ${TRIAL_DEADLINE_MS}ms budget`)),
					TRIAL_DEADLINE_MS,
				);
				trialTimer.unref?.();
			}),
		]);
		completed = true;
	} finally {
		clearTimeout(trialTimer);
		// A lost race kills the daemon immediately; the happy path lets it finish.
		if (daemon) await stopDaemon(daemon, { swift: !completed });
		rmSync(agentDir, { recursive: true, force: true });
		if (completed) {
			// A completed measurement must not become a failure or a hang because a
			// stray daemon handle keeps the event loop alive after teardown.
			process.exit(0);
		}
	}
}

main().catch((error) => {
	process.stderr.write(`switch-fetch-bench failed: ${error?.stack ?? error}\n`);
	process.exit(1);
});
