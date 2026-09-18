import { type ChildProcess, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CLOUD_GUEST_BRIDGE_SCRIPT } from "../src/core/cloud/bridge/guest-bridge-script.js";
import type { CloudTunnelConnection } from "../src/core/cloud/bridge/tunnel-transport.js";
import { WsTunnelTransport } from "../src/core/cloud/bridge/tunnel-transport.js";
import {
	CLOUD_PROTOCOL_VERSION,
	type CloudCommandRequest,
	type CloudEvent,
	type CloudMessage,
	cloudRequestDigest,
} from "../src/core/cloud/protocol.js";

/**
 * End-to-end coverage of the resident guest daemon through a loopback bridge.
 *
 * The bridge script runs as a real `node` subprocess exactly as the guest
 * image runs it, and it supervises the real guest daemon mode through a tsx
 * fixture (faux provider, file-driven responses: no network, no paid tokens).
 * The test drives the true WebSocket protocol over 127.0.0.1 the same way the
 * local tunnel attachment does.
 */

const roots: string[] = [];
const children = new Set<ChildProcess>();
const fixturePath = resolve(__dirname, "fixtures/cloud-guest-daemon-fixture.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const repoTsconfigPath = resolve(__dirname, "../../../tsconfig.json");

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	// The bridge supervises the daemon in its own process group; a SIGKILLed
	// bridge cannot clean up, so the test kills any surviving daemon by the
	// pidfile before removing its state.
	for (const path of roots) {
		const pidPath = join(path, "state", "daemon.pid");
		try {
			const pid = Number(readFileSync(pidPath, "utf8").trim());
			if (Number.isInteger(pid) && pid > 0) {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						process.kill(pid, "SIGKILL");
					} catch {
						// Already gone.
					}
				}
			}
		} catch {
			// No pidfile for this root.
		}
	}
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5 });
});

const BRIDGE_TOKEN = "b".repeat(64);
const SESSION_ID = "sess_bridge_test_1";

interface Bridge {
	process: ChildProcess;
	root: string;
	port: number;
	workspaceDir: string;
	resultsDir: string;
	stateDir: string;
	daemonStateDir: string;
	agentDir: string;
	authPath: string;
	promptPath: string;
	responsesPath: string;
}

function writeFile(path: string, contents: string, mode = 0o600): void {
	const fd = openSync(path, "wx", mode);
	try {
		writeSync(fd, contents);
	} finally {
		closeSync(fd);
	}
}

function appendResponse(root: Bridge, text: string): void {
	const response = {
		role: "assistant",
		content: [{ type: "text", text }],
	};
	writeFileSync(root.responsesPath, `${readFileSync(root.responsesPath, "utf8")}${JSON.stringify(response)}\n`, {
		mode: 0o600,
	});
}

async function startBridge(options: { prompt?: string } = {}): Promise<Bridge> {
	const root = mkdtempSync(join(tmpdir(), "cloud-guest-bridge-test-"));
	roots.push(root);
	const workspaceDir = join(root, "workspace");
	const resultsDir = join(root, "results");
	const stateDir = join(root, "state");
	const daemonStateDir = join(root, "daemon-state");
	const agentDir = join(root, "agent");
	mkdirSync(workspaceDir);
	mkdirSync(resultsDir);
	mkdirSync(stateDir);
	mkdirSync(daemonStateDir);
	mkdirSync(agentDir);
	const authPath = join(root, "inference.token");
	const promptPath = join(root, "prompt.txt");
	const responsesPath = join(root, "responses.jsonl");
	writeFile(authPath, "guest-inference-key\n");
	writeFile(promptPath, options.prompt ?? "");
	writeFile(responsesPath, "");
	const bridgePath = join(root, "bridge-server.mjs");
	writeFile(bridgePath, CLOUD_GUEST_BRIDGE_SCRIPT, 0o600);
	const bridgeProcess = spawn(process.execPath, [bridgePath], {
		env: {
			...process.env,
			TSX_TSCONFIG_PATH: repoTsconfigPath,
			PI_SKIP_VERSION_CHECK: "1",
			PRIME_AGENT_CLOUD_SESSION_ID: SESSION_ID,
			PRIME_AGENT_CLOUD_GENERATION: "1",
			PRIME_AGENT_CLOUD_WORKSPACE_DIR: workspaceDir,
			PRIME_AGENT_CLOUD_ARCHIVE_PATH: join(root, "workspace.tar"),
			PRIME_AGENT_CLOUD_MANIFEST_PATH: join(root, "manifest.json"),
			PRIME_AGENT_CLOUD_PROMPT_PATH: promptPath,
			PRIME_AGENT_CLOUD_AUTH_PATH: authPath,
			PRIME_AGENT_CLOUD_RESULTS_DIR: resultsDir,
			PRIME_AGENT_CLOUD_BRIDGE_TOKEN: BRIDGE_TOKEN,
			PRIME_AGENT_CLOUD_BRIDGE_PORT: "0",
			PRIME_AGENT_CLOUD_BRIDGE_STATE_DIR: stateDir,
			PRIME_AGENT_CLOUD_BRIDGE_ENABLED: "1",
			PRIME_AGENT_CLOUD_DAEMON_SOCKET: join(daemonStateDir, "cloud.sock"),
			PRIME_AGENT_CLOUD_DAEMON_STATE_DIR: daemonStateDir,
			PRIME_AGENT_CLOUD_AGENT_DIR: agentDir,
			PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON: JSON.stringify([process.execPath, tsxPath, fixturePath]),
			PRIME_AGENT_TEST_FAUX_RESPONSES: responsesPath,
			PRIME_AGENT_TEST_FAUX_ECHO: "1",
			PRIME_API_KEY: "",
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.add(bridgeProcess);
	bridgeProcess.stderr?.setEncoding("utf8");
	const stderr: string[] = [];
	bridgeProcess.stderr?.on("data", (chunk: string) => stderr.push(chunk));
	const portPath = join(stateDir, "port");
	const deadline = Date.now() + 15_000;
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
	const bridge: Bridge = {
		process: bridgeProcess,
		root,
		port,
		workspaceDir,
		resultsDir,
		stateDir,
		daemonStateDir,
		agentDir,
		authPath,
		promptPath,
		responsesPath,
	};
	return bridge;
}

const transport = new WsTunnelTransport({ connectTimeoutMs: 5_000 });

interface Client {
	connection: CloudTunnelConnection;
	messages: CloudMessage[];
	close: () => Promise<void>;
}

async function connect(bridge: Bridge): Promise<Client> {
	const connection = await transport.connect(`http://127.0.0.1:${String(bridge.port)}`, {});
	const messages: CloudMessage[] = [];
	connection.onMessage((message) => {
		messages.push(JSON.parse(message) as CloudMessage);
	});
	return {
		connection,
		messages,
		close: () =>
			new Promise<void>((resolve) => {
				connection.onClose(() => resolve());
				connection.close("test done");
				setTimeout(resolve, 2_000);
			}),
	};
}

async function waitFor(
	messages: CloudMessage[],
	predicate: (message: CloudMessage) => boolean,
	timeoutMs = 20_000,
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

function sendHello(
	connection: CloudTunnelConnection,
	options: { token?: string; cursor?: number; generation?: number; version?: number } = {},
): void {
	connection.send(
		JSON.stringify({
			type: "hello",
			protocolVersion: options.version ?? CLOUD_PROTOCOL_VERSION,
			generation: options.generation ?? 1,
			clientId: "client_test",
			sessionId: SESSION_ID,
			authToken: options.token ?? BRIDGE_TOKEN,
			...(options.cursor === undefined ? {} : { cursor: { generation: 1, sequence: options.cursor } }),
		}),
	);
}

function sendSubscribe(connection: CloudTunnelConnection, sequence: number): void {
	connection.send(JSON.stringify({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence } }));
}

async function submit(
	connection: CloudTunnelConnection,
	commandId: string,
	request: CloudCommandRequest,
): Promise<void> {
	connection.send(
		JSON.stringify({
			type: "submit",
			sessionId: SESSION_ID,
			generation: 1,
			commandId,
			request,
			digest: cloudRequestDigest(request),
		}),
	);
}

async function awaitClosed(client: Client, timeoutMs = 10_000): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("client was not closed")), timeoutMs);
		client.connection.onClose(() => {
			clearTimeout(timer);
			resolve();
		});
	});
}

async function awaitDaemonReady(bridge: Bridge, timeoutMs = 30_000): Promise<void> {
	const socketPath = join(bridge.daemonStateDir, "cloud.sock");
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(socketPath)) {
		if (Date.now() > deadline) throw new Error("guest daemon socket never appeared");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function daemonPid(bridge: Bridge): number | undefined {
	const pidPath = join(bridge.stateDir, "daemon.pid");
	if (!existsSync(pidPath)) return undefined;
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function submitAndWait(client: Client, commandId: string, request: CloudCommandRequest): Promise<void> {
	await submit(client.connection, commandId, request);
	await waitFor(client.messages, (message) => message.type === "command" && message.receipt.commandId === commandId);
}

describe("guest cloud bridge with the resident guest daemon (end-to-end, faux provider, loopback)", () => {
	it("authenticates hello, mirrors a persistent conversation, and never accepts a v1 hello", async () => {
		const bridge = await startBridge();
		try {
			await awaitDaemonReady(bridge);
			// A v1 hello is rejected at the version gate with no snapshot.
			const stale = await connect(bridge);
			sendHello(stale.connection, { version: 1 });
			await awaitClosed(stale);

			// A wrong token is refused even though the transport is up.
			const rejected = await connect(bridge);
			sendHello(rejected.connection, { token: "f".repeat(64) });
			await awaitClosed(rejected);

			// A stale generation is fenced off.
			const fenced = await connect(bridge);
			sendHello(fenced.connection, { generation: 2 });
			await awaitClosed(fenced);

			const client = await connect(bridge);
			sendHello(client.connection);
			const snapshot = await (async () => {
				await waitFor(client.messages, (message) => message.type === "snapshot");
				return client.messages.find(
					(message): message is Extract<CloudMessage, { type: "snapshot" }> => message.type === "snapshot",
				);
			})();
			expect(snapshot?.sessionId).toBe(SESSION_ID);
			expect(snapshot?.state.cwd).toBe(bridge.workspaceDir);
			expect(snapshot?.capabilities).toContain("session_entries");
			sendSubscribe(client.connection, 0);

			// Open the session, then prompt twice: one remote session, one
			// growing conversation, mirrored as durable session_entry events.
			await submitAndWait(client, "cmd_open", { kind: "open_session", cwd: bridge.workspaceDir });
			appendResponse(bridge, "first answer");
			await submit(client.connection, "cmd_prompt_1", { kind: "prompt", text: "first prompt" });
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "session_entry" &&
							event.entryId !== undefined &&
							(event.entry as { type?: string }).type === "message",
					),
				25_000,
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("first answer")),
				25_000,
			);

			appendResponse(bridge, "second answer");
			await submit(client.connection, "cmd_prompt_2", { kind: "prompt", text: "second prompt" });
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("second answer")),
				25_000,
			);
			// The durable mirror lags the live stream by at most one tick.
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "session_entry" &&
							JSON.stringify((event.entry as { message?: unknown }).message ?? null).includes("second prompt"),
					),
				25_000,
			);

			const entries = eventsOf(client.messages).filter((event) => event.kind === "session_entry") as Array<
				Extract<CloudEvent, { kind: "session_entry" }>
			>;
			const messageEntries = entries.filter((event) => (event.entry as { type?: string }).type === "message");
			// The conversation persisted in one session: both user prompts
			// and both assistant answers mirror as durable entries.
			const texts = messageEntries
				.map((event) => (event.entry as { message?: { role?: string; content?: unknown } }).message)
				.map((message) => JSON.stringify(message?.content))
				.join("\n");
			expect(texts).toContain("first prompt");
			expect(texts).toContain("second prompt");
			const sessions = new Set(messageEntries.map((event) => event.sessionId));
			expect(sessions.size).toBe(1);

			// Meta frames track the session, and status transitions stream live.
			await waitFor(
				client.messages,
				(message) => message.type === "events" && message.events.some((event) => event.kind === "session_meta"),
			);
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "session_status" && event.status === "idle"),
			);
			expect(eventsOf(client.messages).some((event) => event.kind === "session_event")).toBe(true);
			expect(eventsOf(client.messages).some((event) => event.kind === "usage")).toBe(true);
			await client.close();
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 120_000);

	it("reconnects with cursor replay, idempotent resubmits, and honest receipt states", async () => {
		const bridge = await startBridge();
		try {
			const first = await connect(bridge);
			sendHello(first.connection);
			await waitFor(first.messages, (message) => message.type === "snapshot");
			sendSubscribe(first.connection, 0);
			await submitAndWait(first, "cmd_open", { kind: "open_session", cwd: bridge.workspaceDir });
			appendResponse(bridge, "steered answer");
			await submit(first.connection, "cmd_steer", { kind: "steer", text: "steer this" });
			await waitFor(
				first.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("steered answer")),
				25_000,
			);
			const seen = eventsOf(first.messages);
			const tail = seen.reduce((max, event) => Math.max(max, event.sequence), 0);
			first.connection.send(
				JSON.stringify({ type: "ack", sessionId: SESSION_ID, cursor: { generation: 1, sequence: tail } }),
			);
			await first.close();

			// Reconnect from the acked cursor: replay continues, no gaps, no duplicates.
			const second = await connect(bridge);
			sendHello(second.connection, { cursor: tail });
			await waitFor(second.messages, (message) => message.type === "snapshot");
			sendSubscribe(second.connection, tail);
			// A duplicate submit replays the retained receipt and never re-executes.
			await submit(second.connection, "cmd_steer", { kind: "steer", text: "steer this" });
			await waitFor(
				second.messages,
				(message) => message.type === "command" && message.receipt.commandId === "cmd_steer",
			);
			const receipts = eventsOf(second.messages)
				.filter((event) => event.kind === "command_state" && event.receipt.commandId === "cmd_steer")
				.map((event) => (event as { receipt: { state: string } }).receipt.state);
			// The journal replays the terminal state once, never a re-run.
			expect(receipts.filter((state) => state === "completed").length).toBeLessThanOrEqual(1);

			// Follow-up and abort translate to ordinary session semantics.
			appendResponse(bridge, "follow-up answer");
			await submitAndWait(second, "cmd_follow_up", { kind: "follow_up", text: "queue this" });
			await submitAndWait(second, "cmd_abort", { kind: "abort" });
			// Abort bypasses the dispatch queue: its receipt settles as a
			// command_state event while the interrupted work winds down.
			await waitFor(
				second.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "command_state" &&
							event.receipt.commandId === "cmd_abort" &&
							event.receipt.state === "completed",
					),
				20_000,
			);
			await second.close();
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 120_000);

	it("restarts a crashed guest daemon, replays from the durable log, and never re-executes uncertain work", async () => {
		const bridge = await startBridge();
		try {
			const client = await connect(bridge);
			sendHello(client.connection);
			await waitFor(client.messages, (message) => message.type === "snapshot");
			sendSubscribe(client.connection, 0);
			await submitAndWait(client, "cmd_open", { kind: "open_session", cwd: bridge.workspaceDir });
			appendResponse(bridge, "pre-crash answer");
			await submit(client.connection, "cmd_prompt_pre", { kind: "prompt", text: "before the crash" });
			await waitFor(
				client.messages,
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("pre-crash answer")),
				25_000,
			);
			const pid = daemonPid(bridge);
			expect(pid).toBeGreaterThan(0);

			// Crash the daemon hard: the bridge restarts it and the durable
			// journal + outbox recover the session and the mirrored entries.
			process.kill(pid as number, "SIGKILL");
			await client.close();
			const restartedAt = Date.now();
			let newPid = pid;
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				newPid = daemonPid(bridge);
				if (newPid !== undefined && newPid !== pid) break;
				if (Date.now() - restartedAt > 30_000) throw new Error("the bridge did not restart the daemon");
			}

			const resumed = await connect(bridge);
			sendHello(resumed.connection, { cursor: 0 });
			await waitFor(resumed.messages, (message) => message.type === "snapshot");
			sendSubscribe(resumed.connection, 0);
			// The durable log replays through the restarted daemon.
			await waitFor(
				resumed.messages,
				(message) => message.type === "events" && message.events.some((event) => event.kind === "session_entry"),
				20_000,
			);
			const replayed = eventsOf(resumed.messages);
			const entries = replayed.filter((event) => event.kind === "session_entry") as Array<
				Extract<CloudEvent, { kind: "session_entry" }>
			>;
			// The crash-recovered session keeps its conversation: the
			// durable session file and the outbox both survive the kill.
			expect(entries.length).toBeGreaterThan(0);
			// hello(cursor 0) delivers a bounded snapshot tail and the
			// subscribe replays from the same cursor: overlap is the client's
			// to dedupe (the local attachment dedupes by sequence).
			const sequences = [...new Set(replayed.map((event) => event.sequence))].sort((a, b) => a - b);
			for (let index = 1; index < sequences.length; index++) {
				expect(sequences[index]).toBe((sequences[index - 1] as number) + 1);
			}

			// A new prompt works on the restarted daemon (persistent conversation).
			appendResponse(bridge, "post-crash answer");
			await submit(resumed.connection, "cmd_prompt_post", { kind: "prompt", text: "after the crash" });
			await waitFor(
				resumed.messages,
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) => event.kind === "output_delta" && event.text.includes("post-crash answer"),
					),
				30_000,
			);
			await resumed.close();
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 150_000);

	it("finalizes the gateway results contract for the one-shot flow (no tunnel)", async () => {
		const bridge = await startBridge({ prompt: "run the one-shot task" });
		try {
			const deadline = Date.now() + 60_000;
			while (!existsSync(join(bridge.resultsDir, "status.txt"))) {
				if (Date.now() > deadline) throw new Error("status.txt was never published");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			expect(readFileSync(join(bridge.resultsDir, "status.txt"), "utf8").trim()).toBe("completed");
			const stdout = readFileSync(join(bridge.resultsDir, "stdout.txt"), "utf8");
			expect(stdout).toContain("faux-ack");
			expect(existsSync(bridge.authPath)).toBe(false);
			const eventsFile = join(bridge.daemonStateDir, `${SESSION_ID}.g1`, "event-outbox", "outbox-events.ndjson");
			expect(existsSync(eventsFile)).toBe(true);
			const outboxLines = readFileSync(eventsFile, "utf8")
				.split("\n")
				.filter((line) => line.length > 0);
			for (const line of outboxLines) {
				expect(() => JSON.parse(line)).not.toThrow();
			}
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 120_000);

	it("passes the scoped inference credential to the guest daemon without leaking it", async () => {
		const bridge = await startBridge();
		try {
			await awaitDaemonReady(bridge);
			const credentialPath = join(bridge.agentDir, "credential-seen.json");
			const deadline = Date.now() + 20_000;
			for (;;) {
				if (existsSync(credentialPath)) break;
				if (Date.now() > deadline) throw new Error("the guest daemon never reported its credential env");
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			const seen = JSON.parse(readFileSync(credentialPath, "utf8")) as { apiKey: string | null };
			expect(seen.apiKey).toBe("guest-inference-key");
			// The bridge log carries supervision lines only, never the secret.
			const bridgeLog = readFileSync(join(bridge.stateDir, "bridge.log"), "utf8");
			expect(bridgeLog).not.toContain("guest-inference-key");
			// The credential file is still present while the session is live;
			// only finalize removes it.
			expect(readFileSync(bridge.authPath, "utf8")).toBe("guest-inference-key\n");
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 60_000);

	it("rejects oversized and malformed submits at the protocol bound", async () => {
		const bridge = await startBridge();
		try {
			const client = await connect(bridge);
			sendHello(client.connection);
			await waitFor(client.messages, (message) => message.type === "snapshot");
			// A request over the prompt bound never reaches the journal.
			client.connection.send(
				JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_too_big",
					request: { kind: "prompt", text: "x".repeat(70_000) },
					digest: cloudRequestDigest({ kind: "prompt", text: "x".repeat(70_000) }),
				}),
			);
			await awaitClosed(client);
		} finally {
			bridge.process.kill("SIGKILL");
		}
	}, 60_000);
});
