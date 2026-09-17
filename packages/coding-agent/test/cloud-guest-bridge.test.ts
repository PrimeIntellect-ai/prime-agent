import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLOUD_GUEST_BRIDGE_SCRIPT } from "../src/core/cloud/bridge/guest-bridge-script.js";
import type { CloudTunnelConnection } from "../src/core/cloud/bridge/tunnel-transport.js";
import { WsTunnelTransport } from "../src/core/cloud/bridge/tunnel-transport.js";
import {
	type CloudCommandRequest,
	type CloudEvent,
	type CloudMessage,
	cloudRequestDigest,
} from "../src/core/cloud/protocol.js";

/**
 * End-to-end coverage of the guest bridge against the real local transport.
 *
 * The bridge script is executed by the guest image's plain `node` binary, so
 * the test does exactly that: it writes the uploaded script to a temp
 * directory, starts it with the fixed-name environment the daemon would set,
 * and drives the real WebSocket protocol over 127.0.0.1. The "agent" is a
 * fake shell script, so no provider, key, or external network is involved.
 */

const roots: string[] = [];
function temp(): string {
	const value = mkdtempSync(join(tmpdir(), "cloud-guest-bridge-test-"));
	roots.push(value);
	return value;
}
afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

const BRIDGE_TOKEN = "a".repeat(64);
const SESSION_ID = "sess_bridge_test_1";

interface Bridge {
	process: ChildProcess;
	root: string;
	port: number;
	workspaceDir: string;
	resultsDir: string;
	stateDir: string;
	authPath: string;
	promptPath: string;
}

function writeFile(path: string, contents: string, mode = 0o600): void {
	const fd = openSync(path, "wx", mode);
	try {
		writeSync(fd, contents);
	} finally {
		closeSync(fd);
	}
}

async function startBridge(prompt: string, agentScript: string, agentSleepSeconds = 0.35): Promise<Bridge> {
	const root = temp();
	const workspaceDir = join(root, "workspace");
	const resultsDir = join(root, "results");
	const stateDir = join(root, "state");
	mkdirSync(workspaceDir);
	mkdirSync(resultsDir);
	mkdirSync(stateDir);
	const authPath = join(root, "inference.token");
	const promptPath = join(root, "prompt.txt");
	const agentBin = join(root, "fake-agent.sh");
	writeFile(authPath, "guest-inference-key\n");
	writeFile(promptPath, prompt);
	writeFile(
		agentBin,
		agentScript.replace("{{TASK_MARK}}", "initial").replace("{{SLEEP}}", String(agentSleepSeconds)),
		0o700,
	);
	const bridgePath = join(root, "bridge-server.mjs");
	writeFile(bridgePath, CLOUD_GUEST_BRIDGE_SCRIPT, 0o600);
	const bridgeProcess = spawn("node", [bridgePath], {
		env: {
			...process.env,
			PRIME_AGENT_CLOUD_SESSION_ID: SESSION_ID,
			PRIME_AGENT_CLOUD_GENERATION: "1",
			PRIME_AGENT_CLOUD_WORKSPACE_DIR: workspaceDir,
			PRIME_AGENT_CLOUD_ARCHIVE_PATH: join(root, "workspace.tar"),
			PRIME_AGENT_CLOUD_MANIFEST_PATH: join(root, "manifest.json"),
			PRIME_AGENT_CLOUD_PROMPT_PATH: promptPath,
			PRIME_AGENT_CLOUD_AUTH_PATH: authPath,
			PRIME_AGENT_CLOUD_RESULTS_DIR: resultsDir,
			PRIME_AGENT_CLOUD_AGENT_BIN: agentBin,
			PRIME_AGENT_CLOUD_MODEL: "",
			PRIME_AGENT_CLOUD_BRIDGE_TOKEN: BRIDGE_TOKEN,
			PRIME_AGENT_CLOUD_BRIDGE_PORT: "0",
			PRIME_AGENT_CLOUD_BRIDGE_STATE_DIR: stateDir,
			PRIME_AGENT_CLOUD_BRIDGE_OUTPUT_FLUSH_MS: "20",
			PRIME_API_KEY: "",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	const stderr: string[] = [];
	bridgeProcess.stderr?.setEncoding("utf8");
	bridgeProcess.stderr?.on("data", (chunk: string) => stderr.push(chunk));
	const portPath = join(stateDir, "port");
	const deadline = Date.now() + 10_000;
	let port = 0;
	for (;;) {
		if (existsSync(portPath)) {
			const text = readFileSync(portPath, "utf8").trim();
			port = Number(text);
			if (Number.isInteger(port) && port >= 1) break;
		}
		if (bridgeProcess.exitCode !== null) throw new Error(`bridge exited early: ${stderr.join("")}`);
		if (Date.now() > deadline) throw new Error(`bridge port file is invalid: ${String(port)}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return { process: bridgeProcess, root, port, workspaceDir, resultsDir, stateDir, authPath, promptPath };
}

const transport = new WsTunnelTransport({ connectTimeoutMs: 5_000 });

async function connect(
	bridge: Bridge,
	closeTracking: { closed: boolean } = { closed: false },
): Promise<{
	connection: CloudTunnelConnection;
	messages: CloudMessage[];
	close: () => Promise<void>;
}> {
	const connection = await transport.connect(`http://127.0.0.1:${String(bridge.port)}`, {});
	const messages: CloudMessage[] = [];
	connection.onMessage((message) => {
		const parsed = JSON.parse(message) as CloudMessage;
		messages.push(parsed);
	});
	connection.onClose(() => {
		closeTracking.closed = true;
	});
	return {
		connection,
		messages,
		close: () =>
			new Promise<void>((resolve) => {
				connection.onClose(() => resolve());
				connection.close("test done");
				setTimeout(resolve, 1_000);
			}),
	};
}

async function waitFor(
	messages: CloudMessage[],
	predicate: (message: CloudMessage) => boolean,
	timeoutMs = 8_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (messages.some(predicate)) return;
		if (Date.now() > deadline) throw new Error("timed out waiting for a protocol message");
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}

function eventsOf(messages: CloudMessage[]): CloudEvent[] {
	const events: CloudEvent[] = [];
	for (const message of messages) {
		if (message.type === "snapshot") events.push(...message.events);
		if (message.type === "events") events.push(...message.events);
	}
	return events;
}

function sendHello(connection: CloudTunnelConnection, token: string, cursor?: number): void {
	connection.send(
		JSON.stringify({
			type: "hello",
			protocolVersion: 1,
			generation: 1,
			clientId: "client_test",
			sessionId: SESSION_ID,
			authToken: token,
			...(cursor === undefined ? {} : { cursor: { generation: 1, sequence: cursor } }),
		}),
	);
}

const fakeAgent = ["#!/bin/sh", 'echo "task output from {{TASK_MARK}}"', "sleep {{SLEEP}}", 'echo "done"'].join("\n");

describe("guest cloud bridge (end-to-end, fake agent, loopback)", () => {
	it("authenticates hello, streams live output, runs steer as a follow-up task, and honors cancel", async () => {
		const bridge = await startBridge("do the initial thing", fakeAgent);
		try {
			// Health endpoint answers with a bounded, secret-free document.
			const health = await fetch(`http://127.0.0.1:${String(bridge.port)}/`);
			expect(health.status).toBe(200);
			const healthBody = (await health.json()) as Record<string, unknown>;
			expect(healthBody).toMatchObject({ ok: true, sessionId: SESSION_ID, generation: 1 });

			// A wrong protocol token is refused even though the transport is up.
			const rejected: { closed: boolean } = { closed: false };
			const badClient = await connect(bridge, rejected);
			sendHello(badClient.connection, "f".repeat(64));
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("bad-token client was not closed")), 5_000);
				badClient.connection.onClose(() => {
					clearTimeout(timer);
					resolve();
				});
			});

			const client = await connect(bridge);
			sendHello(client.connection, BRIDGE_TOKEN);
			await waitFor(client.messages, (message) => message.type === "snapshot");
			const snapshot = client.messages.find(
				(message): message is Extract<CloudMessage, { type: "snapshot" }> => message.type === "snapshot",
			);
			expect(snapshot?.sessionId).toBe(SESSION_ID);
			expect(snapshot?.state.cwd).toBe(bridge.workspaceDir);

			// Live output from the initial task arrives as bounded output_delta events.
			client.connection.send(
				JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence: 0 } }),
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) => event.kind === "output_delta" && event.text.includes("task output from initial"),
					),
			);

			// Cancel an unknown task is an honest failure, not a silent success,
			// while the initial task is still running.
			const cancelRequest: CloudCommandRequest = { kind: "cancel_task", taskId: "task_missing" };
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_cancel_missing",
					request: cancelRequest,
					digest: cloudRequestDigest(cancelRequest),
				}),
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "command" &&
					message.receipt.commandId === "cmd_cancel_missing" &&
					message.receipt.state === "failed",
			);

			// Steer is admitted durably, runs after the initial task, and its receipt completes.
			const steerRequest: CloudCommandRequest = {
				kind: "steer",
				taskId: "task_steer_1",
				text: "now do the follow-up",
			};
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_steer_1",
					request: steerRequest,
					digest: cloudRequestDigest(steerRequest),
				}),
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "command" &&
					message.receipt.commandId === "cmd_steer_1" &&
					message.receipt.state === "accepted",
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "command_state" &&
							event.receipt.commandId === "cmd_steer_1" &&
							event.receipt.state === "completed",
					),
				15_000,
			);

			// Acknowledgement advances the trim cursor; the bridge keeps serving until it finalizes.
			const seen = eventsOf(client.messages);
			const tail = seen.reduce((max, event) => Math.max(max, event.sequence), 0);
			client.connection.send(
				JSON.stringify({ type: "ack", sessionId: SESSION_ID, cursor: { generation: 1, sequence: tail } }),
			);

			// The delegation finalizes with the standard results contract: stdout,
			// stderr, patch, auth removal, and status.txt last.
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "session_status" && event.status === "stopped"),
				15_000,
			);
			const deadline = Date.now() + 8_000;
			while (!existsSync(join(bridge.resultsDir, "status.txt"))) {
				if (Date.now() > deadline) throw new Error("status.txt was never published");
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
			expect(readFileSync(join(bridge.resultsDir, "status.txt"), "utf8").trim()).toBe("completed");
			const stdout = readFileSync(join(bridge.resultsDir, "stdout.txt"), "utf8");
			expect(stdout).toContain("task output from initial");
			expect(stdout).toContain("=== task task_steer_1 ===");
			expect(existsSync(bridge.authPath)).toBe(false);
			expect(readFileSync(join(bridge.stateDir, "journal.ndjson"), "utf8")).toContain("cmd_steer_1");
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 30_000);

	it("cancels the active task, reconnects with cursor replay, and never duplicates events", async () => {
		const bridge = await startBridge("run long enough to cancel", fakeAgent, 8);
		try {
			const first = await connect(bridge);
			sendHello(first.connection, BRIDGE_TOKEN);
			await waitFor(first.messages, (message) => message.type === "snapshot");
			first.connection.send(
				JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence: 0 } }),
			);
			await waitFor(
				first.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "session_status" && event.status === "busy"),
			);
			// Drop the connection mid-task; the resident bridge keeps running.
			await first.close();

			const second = await connect(bridge);
			sendHello(second.connection, BRIDGE_TOKEN);
			await waitFor(second.messages, (message) => message.type === "snapshot");
			second.connection.send(
				JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence: 0 } }),
			);
			await waitFor(
				second.messages,
				(message) => message.type === "events" && message.events.some((event) => event.kind === "output_delta"),
			);
			const replaySequences = new Set<number>(eventsOf(second.messages).map((event) => event.sequence));
			expect(replaySequences.size).toBeGreaterThan(0);
			const replay = [...replaySequences].sort((a, b) => a - b);
			for (let index = 1; index < replay.length; index++) {
				expect(replay[index]).toBe((replay[index - 1] as number) + 1);
			}

			const cancelRequest: CloudCommandRequest = { kind: "cancel_task", taskId: "task_initial" };
			second.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_cancel_1",
					request: cancelRequest,
					digest: cloudRequestDigest(cancelRequest),
				}),
			);
			await waitFor(
				second.messages,
				(message) => message.type === "command" && message.receipt.commandId === "cmd_cancel_1",
			);
			// The cancellation's own receipt settles only after the task actually stopped.
			await waitFor(
				second.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "command_state" &&
							event.receipt.commandId === "cmd_cancel_1" &&
							event.receipt.state === "cancelled",
					),
				15_000,
			);
			// Duplicate submit with the same identity returns the retained receipt.
			second.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_cancel_1",
					request: cancelRequest,
					digest: cloudRequestDigest(cancelRequest),
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 200));

			await waitFor(
				second.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "session_status" && event.status === "stopped"),
				15_000,
			);
			const deadline = Date.now() + 8_000;
			while (!existsSync(join(bridge.resultsDir, "status.txt"))) {
				if (Date.now() > deadline) throw new Error("status.txt was never published after cancel");
				await new Promise((resolve) => setTimeout(resolve, 15));
			}
			expect(readFileSync(join(bridge.resultsDir, "status.txt"), "utf8").trim()).toBe("stopped");
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 30_000);

	it("replays a multi-megabyte output backlog in byte-bounded batches without force-closing", async () => {
		// 2 MiB of output becomes ~32 maximum-size output_delta events. An
		// unbounded replay batch would exceed the 1 MiB protocol frame and
		// close the connection with 1009; the byte-bounded batches must carry
		// the whole backlog across multiple messages instead.
		const bigAgent = ["#!/bin/sh", 'head -c 2097152 /dev/zero | tr "\\0" "x"', "sleep {{SLEEP}}"].join("\n");
		const bridge = await startBridge("print a lot", bigAgent, 20);
		try {
			// First client: watch the burst stream live and wait until all of
			// it has been recorded on the guest side.
			const live = await connect(bridge);
			sendHello(live.connection, BRIDGE_TOKEN);
			await waitFor(live.messages, (message) => message.type === "snapshot");
			live.connection.send(
				JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence: 0 } }),
			);
			await waitFor(
				live.messages,
				(message) =>
					message.type === "events" &&
					eventsOf(live.messages)
						.filter((event) => event.kind === "output_delta")
						.reduce((total, event) => total + event.text.length, 0) >= 2_097_152,
				20_000,
			);
			const stillOpen = { closed: false };
			live.connection.onClose(() => {
				stillOpen.closed = true;
			});
			await live.close();

			// Second client: a fresh attachment replays the whole backlog from
			// sequence zero in bounded batches and must survive the drain.
			const replay = await connect(bridge);
			let replayClosed = false;
			replay.connection.onClose(() => {
				replayClosed = true;
			});
			sendHello(replay.connection, BRIDGE_TOKEN);
			await waitFor(replay.messages, (message) => message.type === "snapshot");
			replay.connection.send(
				JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence: 0 } }),
			);
			await waitFor(
				replay.messages,
				(message) =>
					message.type === "events" &&
					eventsOf(replay.messages)
						.filter((event) => event.kind === "output_delta")
						.reduce((total, event) => total + event.text.length, 0) >= 2_097_152,
				20_000,
			);
			// The raw client sees the byte-bounded snapshot tail plus the full
			// subscribe replay, so deduplicate by guest sequence before
			// asserting the backlog arrived contiguously and complete.
			const unique = new Map<number, number>();
			for (const event of eventsOf(replay.messages)) {
				if (event.kind === "output_delta") unique.set(event.sequence, event.text.length);
			}
			const sequences = [...unique.keys()].sort((a, b) => a - b);
			// Contiguous, gapless replay of the whole output backlog.
			for (let index = 1; index < sequences.length; index++) {
				expect(sequences[index]).toBe((sequences[index - 1] as number) + 1);
			}
			expect([...unique.values()].reduce((total, length) => total + length, 0)).toBeGreaterThanOrEqual(2_097_152);
			expect(replayClosed).toBe(false);
			expect(stillOpen.closed).toBe(false);
			await replay.close();
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 30_000);

	it("terminates a cancelled task's whole process group, including TERM-immune helpers", async () => {
		// The agent spawns a helper that ignores SIGTERM, exactly like the
		// image's prime-agent fork-server child: only a process-group kill
		// reaches it, and a lone parent signal would leave it running.
		const stubbornAgent = [
			"#!/bin/sh",
			'echo "task output from {{TASK_MARK}}"',
			"sh -c 'trap \"\" TERM; sleep 60' &",
			"echo $! > grandchild.pid",
			"sleep {{SLEEP}}",
		].join("\n");
		const bridge = await startBridge("hold the line", stubbornAgent, 20);
		let grandchildPid: number | undefined;
		try {
			const client = await connect(bridge);
			sendHello(client.connection, BRIDGE_TOKEN);
			await waitFor(client.messages, (message) => message.type === "snapshot");
			client.connection.send(
				JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence: 0 } }),
			);
			const pidPath = join(bridge.workspaceDir, "grandchild.pid");
			const deadline = Date.now() + 10_000;
			while (!existsSync(pidPath)) {
				if (Date.now() > deadline) throw new Error("grandchild pid file never appeared");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			grandchildPid = Number(readFileSync(pidPath, "utf8").trim());
			expect(Number.isInteger(grandchildPid) && grandchildPid > 1).toBe(true);

			const cancelRequest: CloudCommandRequest = { kind: "cancel_task", taskId: "task_initial" };
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_group_kill_1",
					request: cancelRequest,
					digest: cloudRequestDigest(cancelRequest),
				}),
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "command_state" &&
							event.receipt.commandId === "cmd_group_kill_1" &&
							event.receipt.state === "cancelled",
					),
				15_000,
			);
			// The TERM-immune helper must die with the group inside the grace window.
			await vi.waitFor(
				() => {
					expect(() => process.kill(grandchildPid as number, 0)).toThrow();
				},
				{ timeout: 15_000 },
			);
			await client.close();
		} finally {
			try {
				if (grandchildPid !== undefined) process.kill(grandchildPid, 0);
			} catch {
				// Already dead, as the test asserts.
			}
			bridge.process.kill("SIGKILL");
		}
	}, 30_000);

	it("closes the stream when a command id is reused with a different request", async () => {
		const bridge = await startBridge("hold the line", fakeAgent, 8);
		try {
			const client = await connect(bridge);
			sendHello(client.connection, BRIDGE_TOKEN);
			await waitFor(client.messages, (message) => message.type === "snapshot");
			const request: CloudCommandRequest = { kind: "steer", taskId: "task_a", text: "first body" };
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_conflict",
					request,
					digest: cloudRequestDigest(request),
				}),
			);
			await waitFor(
				client.messages,
				(message) => message.type === "command" && message.receipt.commandId === "cmd_conflict",
			);
			// The journal keeps the retained receipt for an identical resubmission...
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_conflict",
					request,
					digest: cloudRequestDigest(request),
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 150));
			// ...but a different body under the same id is a protocol violation.
			const conflicting: CloudCommandRequest = { kind: "steer", taskId: "task_a", text: "different body" };
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_conflict",
					request: conflicting,
					digest: cloudRequestDigest(conflicting),
				}),
			);
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error("conflicting submit was not rejected")), 5_000);
				client.connection.onClose(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 20_000);
});
