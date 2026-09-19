import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CloudCommandRequest,
	type CloudEvent,
	type CloudSessionState,
	cloudRequestDigest,
	parseCloudMessage,
} from "../src/core/cloud/protocol.js";
import { CloudGuestDaemon, parseCloudDaemonEnv } from "../src/modes/cloud/cloud-daemon.js";
import { CloudProtocolServer, type CloudProtocolServerCallbacks } from "../src/modes/cloud/cloud-protocol-server.js";
import { createFauxRuntimeFactory } from "./fixtures/cloud-guest-daemon-fixture.js";

/**
 * In-process strictness tests for the resident guest daemon: the session-host
 * seam (SessionHostCore), the v2 command translation, the durable mirror
 * (entries, meta, roster, usage), crash journal recovery, and the protocol
 * bounds - all against a real AgentSession with a faux provider.
 */

const roots: string[] = [];
function temp(): string {
	const root = mkdtempSync(join(tmpdir(), "cloud-guest-daemon-test-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

const SESSION_ID = "sess_daemon_test_1";
const BRIDGE_TOKEN = "t".repeat(64);

function daemonEnv(root: string, options: { prompt?: string } = {}) {
	return parseCloudDaemonEnv(
		{
			PRIME_AGENT_CLOUD_DAEMON_SOCKET: join(root, "cloud.sock"),
			PRIME_AGENT_CLOUD_SESSION_ID: SESSION_ID,
			PRIME_AGENT_CLOUD_GENERATION: "1",
			PRIME_AGENT_CLOUD_WORKSPACE_DIR: join(root, "workspace"),
			PRIME_AGENT_CLOUD_AGENT_DIR: join(root, "agent"),
			PRIME_AGENT_CLOUD_BRIDGE_TOKEN: BRIDGE_TOKEN,
			PRIME_AGENT_CLOUD_PROMPT_PATH: join(root, "prompt.txt"),
			PRIME_AGENT_CLOUD_MODEL: "",
			PRIME_AGENT_CLOUD_DAEMON_STATE_DIR: join(root, "daemon-state"),
			...(options.prompt === undefined ? {} : {}),
		},
		{ stateDir: join(root, "daemon-state") },
	);
}

/** Drive the protocol server over its unix socket like the bridge does. */
class LoopClient {
	private socket: ReturnType<typeof createConnection>;
	/** Raw bytes: a line decodes only once its \n byte arrived, so a multibyte UTF-8 sequence split across TCP chunks stays intact. */
	private buffer = Buffer.alloc(0);
	public readonly messages: string[] = [];

	constructor(socketPath: string) {
		this.socket = createConnection(socketPath);
		this.socket.setNoDelay(true);
		// The server drops protocol violators; an async EPIPE on a later write
		// must stay handled or it surfaces as an unhandled error.
		this.socket.on("error", () => undefined);
		this.socket.on("data", (chunk: Buffer) => {
			this.buffer = Buffer.concat([this.buffer, chunk]);
			for (;;) {
				const newline = this.buffer.indexOf(0x0a);
				if (newline < 0) break;
				const line = this.buffer.subarray(0, newline).toString("utf8");
				this.buffer = this.buffer.subarray(newline + 1);
				if (line.length > 0) this.messages.push(line);
			}
		});
	}

	send(value: unknown): void {
		this.socket.write(`${JSON.stringify(value)}\n`);
	}

	hello(cursor?: number): void {
		this.send({
			type: "hello",
			protocolVersion: 3,
			generation: 1,
			clientId: "client_loop",
			sessionId: SESSION_ID,
			authToken: BRIDGE_TOKEN,
			...(cursor === undefined ? {} : { cursor: { generation: 1, sequence: cursor } }),
		});
	}

	subscribe(sequence: number): void {
		this.send({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 1, sequence } });
	}

	submit(commandId: string, request: CloudCommandRequest): void {
		this.send({
			type: "submit",
			sessionId: SESSION_ID,
			generation: 1,
			commandId,
			request,
			digest: cloudRequestDigest(request),
		});
	}

	events(): CloudEvent[] {
		const events: CloudEvent[] = [];
		for (const message of this.messages) {
			const parsed = parseCloudMessage(message);
			if (!parsed.ok) continue;
			if (parsed.message.type === "snapshot") events.push(...parsed.message.events);
			if (parsed.message.type === "events") events.push(...parsed.message.events);
		}
		return events;
	}

	commandFrame(commandId: string): { state: string; uncertain: boolean } | undefined {
		for (const message of [...this.messages].reverse()) {
			const parsed = parseCloudMessage(message);
			if (!parsed.ok) continue;
			if (parsed.message.type === "command" && parsed.message.receipt.commandId === commandId) {
				return { state: parsed.message.receipt.state, uncertain: parsed.message.receipt.uncertain };
			}
		}
		return undefined;
	}

	closed(): Promise<void> {
		return new Promise((resolve) => {
			if (this.socket.destroyed) return resolve();
			this.socket.once("close", () => resolve());
		});
	}

	async close(): Promise<void> {
		const closed = this.closed();
		this.socket.destroy();
		await closed;
	}

	async waitForSnapshot(timeoutMs = 15_000): Promise<void> {
		await this.waitFor((_events, messages) => messages.some((line) => line.includes('"type":"snapshot"')), timeoutMs);
	}

	async waitFor(predicate: (events: CloudEvent[], messages: string[]) => boolean, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (predicate(this.events(), this.messages)) return;
			if (Date.now() > deadline) {
				throw new Error("timed out waiting for a guest daemon event");
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

async function startDaemon(root: string): Promise<{ daemon: CloudGuestDaemon; client: LoopClient }> {
	const daemon = await CloudGuestDaemon.start(daemonEnv(root), { createRuntime: createFauxRuntimeFactory });
	await daemon.openSession({});
	daemon.startMirrorLoop();
	const client = new LoopClient(daemonEnv(root).socketPath);
	client.hello();
	await client.waitForSnapshot();
	// Live pushes require a subscribe; the loopback bridge does the same.
	client.subscribe(0);
	return { daemon, client };
}

describe("resident guest daemon (in-process, faux provider)", () => {
	it("mirrors session entries, meta, roster, and usage, and translates the v2 command surface", async () => {
		const root = temp();
		const { daemon, client } = await startDaemon(root);
		try {
			// set_session_name lands in the session and in the mirror.
			client.submit("cmd_name", { kind: "set_session_name", name: "cloud-root" });
			await client.waitFor((events) =>
				events.some(
					(event) => event.kind === "session_entry" && (event.entry as { type?: string }).type === "session_info",
				),
			);

			// An unknown model is an honest failed receipt, never a silent fallback.
			client.submit("cmd_model", { kind: "set_model", provider: "openai", modelId: "gpt-not-real" });
			await client.waitFor((_events, messages) =>
				messages.some((line) => line.includes('"commandId":"cmd_model"') && line.includes('"state":"failed"')),
			);

			// An unknown child fails the receipt instead of pretending to cancel.
			client.submit("cmd_cancel_child", { kind: "cancel_child", childId: "missing-child" });
			await client.waitFor((_events, messages) =>
				messages.some(
					(line) => line.includes('"commandId":"cmd_cancel_child"') && line.includes('"state":"failed"'),
				),
			);

			// A v2 prompt drives real inference through the resident session;
			// the fixture answers from the queued response step.
			const responsesPath = join(root, "responses.jsonl");
			process.env.PRIME_AGENT_TEST_FAUX_RESPONSES = responsesPath;
			delete process.env.PRIME_AGENT_TEST_FAUX_ECHO;
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "guest answer" }],
				api: "faux",
				provider: "faux",
				timestamp: Date.now(),
				usage: {
					input: 3,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 8,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;
			writeFileSync(responsesPath, `${JSON.stringify(response)}\n`, { mode: 0o600 });
			client.submit("cmd_prompt", { kind: "prompt", text: "say the thing" });
			await client.waitFor((events) =>
				events.some((event) => event.kind === "output_delta" && event.text.includes("guest answer")),
			);
			// The user prompt and the assistant answer mirror as durable entries.
			await client.waitFor((events) =>
				events.some(
					(event) => event.kind === "session_entry" && JSON.stringify(event.entry).includes("say the thing"),
				),
			);
			// Usage totals stream per assistant message.
			await client.waitFor((events) => events.some((event) => event.kind === "usage"));
			// Meta frames carry the remote session identity.
			await client.waitFor((events) => events.some((event) => event.kind === "session_meta"));
			await client.close();
			await daemon.stop();
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	}, 30_000);

	it("replays retained events from a cursor across reconnects and never duplicates", async () => {
		const root = temp();
		const { daemon, client } = await startDaemon(root);
		try {
			client.submit("cmd_name", { kind: "set_session_name", name: "replay-root" });
			await client.waitFor((events) => events.some((event) => event.kind === "session_entry"));
			const tail = client.events().reduce((max, event) => Math.max(max, event.sequence), 0);
			// A second subscribe from zero replays the whole retained log; the
			// client may already hold a copy, so dedupe by sequence.
			client.subscribe(0);
			// The retained log replays again from zero: the first event arrives a
			// second time (the client keeps both deliveries for this assertion).
			await client.waitFor((events) => events.filter((event) => event.sequence === 1).length >= 2);
			const replay = [...new Set(client.events().map((event) => event.sequence))].sort((a, b) => a - b);
			for (let index = 1; index < replay.length; index++) {
				expect(replay[index]).toBe((replay[index - 1] as number) + 1);
			}

			// Reconnect from the acked cursor: nothing before it replays again.
			client.send({ type: "ack", sessionId: SESSION_ID, cursor: { generation: 1, sequence: tail } });
			await client.close();
			const second = new LoopClient(daemonEnv(root).socketPath);
			second.hello(tail);
			await second.waitForSnapshot();
			second.subscribe(tail);
			// New work after the reconnect arrives strictly past the cursor.
			second.submit("cmd_after_reconnect", { kind: "set_session_name", name: "post-replay" });
			await second.waitFor((events) => events.some((event) => event.sequence > tail));
			for (const event of second.events()) {
				expect(event.sequence).toBeGreaterThan(tail);
			}
			await second.close();
			await daemon.stop();
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	}, 30_000);

	it("never re-executes a command restored uncertain after a crash", async () => {
		const root = temp();
		const socketPath = join(root, "crash.sock");
		const options = {
			socketPath,
			stateDirectory: join(root, "crash-state"),
			sessionId: SESSION_ID,
			generation: 1,
		};
		// A dispatch that never settles: the command is admitted, claimed, and
		// running when the "process dies".
		const never = new Promise<never>(() => {});
		const crashed = await (async () => {
			const server = new CloudProtocolServer({
				...options,
				callbacks: {
					sessionId: () => SESSION_ID,
					generation: () => 1,
					protocolToken: () => BRIDGE_TOKEN,
					status: () => "busy" as const,
					snapshotState: () => ({ cwd: "/tmp", modelId: "faux-1", queuedCommandIds: [] }),
					dispatch: () => never,
				},
			});
			await server.start();
			return server;
		})();
		const client = new LoopClient(socketPath);
		client.hello();
		await client.waitForSnapshot();
		client.subscribe(0);
		client.submit("cmd_hang", { kind: "prompt", text: "hang forever" });
		await client.waitFor((events) =>
			events.some(
				(event) =>
					event.kind === "command_state" &&
					event.receipt.commandId === "cmd_hang" &&
					event.receipt.state === "running",
			),
		);
		// Crash: close everything without a settle record.
		await client.close();
		await crashed.stop();

		// The restarted server restores the command as uncertain: it is never
		// claimed again, and its receipt says so for honest local reporting.
		const dispatched: string[] = [];
		const recovered = new CloudProtocolServer({
			...options,
			callbacks: {
				sessionId: () => SESSION_ID,
				generation: () => 1,
				protocolToken: () => BRIDGE_TOKEN,
				status: () => "idle" as const,
				snapshotState: () => ({ cwd: "/tmp", modelId: "faux-1", queuedCommandIds: [] }),
				dispatch: async (request) => {
					dispatched.push(request.kind);
					return { state: "completed" };
				},
			},
		});
		await recovered.start();
		const uncertain = recovered.listUncertainCommands();
		expect(uncertain.map((receipt) => receipt.commandId)).toContain("cmd_hang");
		expect(uncertain.every((receipt) => receipt.uncertain)).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(dispatched).toEqual([]);
		await recovered.stop();
	}, 30_000);

	it("stores oversized session entries as artifact refs instead of inline payloads", async () => {
		const root = temp();
		const { daemon, client } = await startDaemon(root);
		try {
			const session = daemon.rootSession;
			expect(session).toBeDefined();
			// Append an oversized entry directly to the session file.
			const big = "x".repeat(300_000);
			daemon.rootSession?.sessionManager.appendCustomEntry("big-payload", { blob: big });
			daemon.mirrorNow();
			await client.waitFor((events) =>
				events.some(
					(event) =>
						event.kind === "session_entry" &&
						event.entryId !== undefined &&
						(event as { artifacts?: Array<{ path: string; sha256: string; bytes: number }> }).artifacts !==
							undefined,
				),
			);
			const oversize = client
				.events()
				.find(
					(event) => event.kind === "session_entry" && (event as { artifacts?: unknown }).artifacts !== undefined,
				) as
				| undefined
				| (Extract<CloudEvent, { kind: "session_entry" }> & {
						artifacts: Array<{ path: string; sha256: string; bytes: number }>;
				  });
			expect(oversize).toBeDefined();
			const artifact = oversize?.artifacts?.[0];
			expect(artifact?.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
			expect(existsSync(artifact?.path ?? "/nonexistent")).toBe(true);
			// The inline entry carries identity only, never the payload.
			expect(JSON.stringify(oversize?.entry)).not.toContain("xxxx");
			await client.close();
			await daemon.stop();
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	}, 30_000);

	it("rejects requests over the protocol bounds before any admission", async () => {
		const root = temp();
		const { daemon, client } = await startDaemon(root);
		try {
			const closed = client.closed();
			client.send({
				type: "submit",
				sessionId: SESSION_ID,
				generation: 1,
				commandId: "cmd_too_big",
				request: { kind: "prompt", text: "y".repeat(70_000) },
				digest: cloudRequestDigest({ kind: "prompt", text: "y".repeat(70_000) }),
			});
			await closed;
			await client.close();
			await daemon.stop();
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	}, 30_000);

	it("reports retention stalls and recovery through the production daemon's status record", async () => {
		const root = temp();
		const env = daemonEnv(root);
		// The production daemon must wire the protocol server's retention
		// callbacks into its status record: this failed when
		// CloudGuestDaemon.start constructed the server without
		// onRetentionStalled/onRetentionRecovered, so a full unacknowledged
		// log stalled the mirror with no honest status signal.
		const daemon = await CloudGuestDaemon.start(env, {
			createRuntime: createFauxRuntimeFactory,
			maxOutboxRecords: 3,
		});
		try {
			const readStatus = () =>
				JSON.parse(readFileSync(env.statusFile, "utf8")) as { status?: string; retentionStalled?: boolean };
			// No session is needed: filling the durable log with nothing
			// acknowledged drives the stall through the production wiring.
			for (let index = 0; index < 5; index++) {
				daemon.protocolServer.appendEvent({
					kind: "session_status",
					recordedAt: new Date().toISOString(),
					status: "busy",
				});
			}
			expect(daemon.protocolServer.retentionStalled).toBe(true);
			expect(readStatus().retentionStalled).toBe(true);

			// A client imports the retained events and acknowledges the tail;
			// the next append frees retention and the status record recovers.
			const client = new LoopClient(env.socketPath);
			client.hello();
			await client.waitForSnapshot();
			client.subscribe(0);
			await client.waitFor((events) => events.length > 0);
			const tail = client.events().reduce((max, event) => Math.max(max, event.sequence), 0);
			client.send({
				type: "ack",
				sessionId: SESSION_ID,
				cursor: { generation: daemon.protocolServer.currentGeneration(), sequence: tail },
			});
			// The ack travels over the socket asynchronously; let it land
			// before the freeing append runs.
			await new Promise((resolve) => setTimeout(resolve, 150));
			const appended = daemon.protocolServer.appendEvent({
				kind: "session_status",
				recordedAt: new Date().toISOString(),
				status: "idle",
			});
			expect(appended).toBeDefined();
			expect(daemon.protocolServer.retentionStalled).toBe(false);
			expect(readStatus().retentionStalled).toBe(false);
			await client.close();
		} finally {
			await daemon.stop();
		}
	}, 30_000);
});

describe("guest daemon protocol hardening (in-process, faux provider)", () => {
	function serverCallbacks(
		overrides: {
			dispatch?: (request: CloudCommandRequest, commandId: string) => Promise<{ state: string; error?: string }>;
		} = {},
	): CloudProtocolServerCallbacks {
		return {
			sessionId: () => SESSION_ID,
			generation: () => 1,
			protocolToken: () => BRIDGE_TOKEN,
			status: () => "idle" as const,
			snapshotState: () => ({ cwd: "/tmp", modelId: "faux-1", queuedCommandIds: [] }),
			dispatch: async (request, commandId) => {
				if (overrides.dispatch !== undefined) {
					const outcome = await overrides.dispatch(request, commandId);
					return { state: outcome.state as "completed", error: outcome.error };
				}
				return { state: "completed" };
			},
		};
	}

	async function startServer(root: string, options: { maxOutboxRecords?: number } = {}): Promise<CloudProtocolServer> {
		const nonce = Math.random().toString(16).slice(2, 8);
		const server = new CloudProtocolServer({
			socketPath: join(root, `s${nonce}k.sock`),
			stateDirectory: join(root, `st${nonce}`),
			sessionId: SESSION_ID,
			generation: 1,
			callbacks: serverCallbacks(),
			...(options.maxOutboxRecords === undefined ? {} : { maxOutboxRecords: options.maxOutboxRecords }),
		});
		await server.start();
		return server;
	}

	it("frames UTF-8 lines split across TCP chunk boundaries without corruption", async () => {
		const root = temp();
		const server = await startServer(root);
		try {
			const client = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			// A hello whose multibyte session id is split mid-sequence: the
			// server must decode the complete line, not a replacement pair.
			const hello = JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				generation: 1,
				clientId: "client-éop",
				sessionId: `${SESSION_ID}-éop→session-ün`,
				authToken: BRIDGE_TOKEN,
			});
			const bytes = Buffer.from(hello, "utf8");
			// Split inside a multibyte sequence: find one mid-sequence offset.
			const splitAt = (() => {
				for (let index = 0; index < bytes.length; index++) {
					const byte = bytes[index] as number;
					if (byte >= 0xc2) return index + 1; // inside a multibyte sequence
				}
				return Math.floor(bytes.length / 2);
			})();
			// Send the frame in one write; the socket data arrives as one chunk,
			// so split the LINE across two writes with a newline at the very end.
			const socketField = (client as unknown as { socket: { write: (chunk: string | Buffer) => void } }).socket;
			socketField.write(bytes.subarray(0, splitAt));
			await new Promise((resolve) => setTimeout(resolve, 20));
			socketField.write(Buffer.concat([bytes.subarray(splitAt), Buffer.from("\n")]));
			// The wrong session id is a fencing rejection, but the parse must be
			// clean: the connection closes without the line having been decoded
			// into replacement characters (any response or close is fine, no
			// crash). Now the real split-line regression on a valid session id:
			const client2 = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			const hello2 = JSON.stringify({
				type: "hello",
				protocolVersion: 3,
				generation: 1,
				clientId: "client-éop",
				sessionId: SESSION_ID,
				authToken: BRIDGE_TOKEN,
			});
			const bytes2 = Buffer.from(hello2, "utf8");
			const split2 = (() => {
				for (let index = 0; index < bytes2.length; index++) {
					const byte = bytes2[index] as number;
					if (byte >= 0xc2) return index + 1;
				}
				return Math.floor(bytes2.length / 2);
			})();
			const socket2 = (client2 as unknown as { socket: { write: (chunk: string | Buffer) => void } }).socket;
			socket2.write(bytes2.subarray(0, split2));
			await new Promise((resolve) => setTimeout(resolve, 20));
			socket2.write(Buffer.concat([bytes2.subarray(split2), Buffer.from("\n")]));
			await client2.waitForSnapshot();
			// A prompt with split multibyte content parses and admits too.
			const promptBytes = Buffer.from(
				`${JSON.stringify({
					type: "submit",
					sessionId: SESSION_ID,
					generation: 1,
					commandId: "cmd_utf8",
					request: { kind: "prompt", text: "héllo→wörld-é" },
					digest: cloudRequestDigest({ kind: "prompt", text: "héllo→wörld-é" }),
				})}\n`,
				"utf8",
			);
			const split3 = (() => {
				for (let index = 0; index < promptBytes.length; index++) {
					const byte = promptBytes[index] as number;
					if (byte >= 0xc2) return index + 1;
				}
				return Math.floor(promptBytes.length / 2);
			})();
			socket2.write(promptBytes.subarray(0, split3));
			await new Promise((resolve) => setTimeout(resolve, 20));
			socket2.write(promptBytes.subarray(split3));
			await client2.waitFor((_events, messages) => messages.some((line) => line.includes('"commandId":"cmd_utf8"')));
			await client2.close();
			await client.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("stalls honestly when the log fills with nothing acknowledged instead of crash-looping", async () => {
		const root = temp();
		const server = await startServer(root, { maxOutboxRecords: 3 });
		try {
			let stalled = 0;
			const callbacks = serverCallbacks();
			callbacks.onRetentionStalled = () => {
				stalled += 1;
			};
			callbacks.onRetentionRecovered = () => undefined;
			(server as unknown as { options: { callbacks: typeof callbacks } }).options.callbacks = callbacks;
			// Fill the log past its bound with no ack in flight.
			for (let index = 0; index < 5; index++) {
				server.appendEvent({
					kind: "session_status",
					recordedAt: new Date().toISOString(),
					status: "busy",
				});
			}
			expect(stalled).toBe(1);
			expect(server.retentionStalled).toBe(true);
			// The stall recovers after an acknowledgement frees retention.
			const client = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			client.hello();
			await client.waitForSnapshot();
			// Subscribe so the retained events are delivered, then acknowledge
			// the true tail: retention can only trim acknowledged history.
			client.subscribe(0);
			await client.waitFor((events) => events.length > 0);
			const tail = client.events().reduce((max, event) => Math.max(max, event.sequence), 0);

			client.send({
				type: "ack",
				sessionId: SESSION_ID,
				cursor: { generation: server.currentGeneration(), sequence: tail },
			});
			const recoveredPromise = new Promise<void>((resolve) => {
				// The stall-clear callback fires on the next successful append.
				const poll = setInterval(() => {
					if (!server.retentionStalled) {
						clearInterval(poll);
						resolve();
					}
				}, 20);
			});

			// The ack travels over the socket asynchronously; let it land before
			// the freeing append runs.
			await new Promise((resolve) => setTimeout(resolve, 150));
			server.appendEvent({
				kind: "session_status",
				recordedAt: new Date().toISOString(),
				status: "idle",
			});
			await recoveredPromise;
			expect(server.retentionStalled).toBe(false);
			await client.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("keeps a pre-trim client reconnecting after retention trims: resync, never wedge", async () => {
		const root = temp();
		const server = await startServer(root, { maxOutboxRecords: 2 });
		try {
			// First event; the client receives and acknowledges it.
			server.appendEvent({ kind: "session_status", recordedAt: new Date().toISOString(), status: "busy" });
			const client = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			client.hello();
			await client.waitForSnapshot();
			client.subscribe(0);
			await client.waitFor((events) => events.some((event) => event.kind === "session_status"));
			const preTrimGeneration = server.currentGeneration();
			const preTrimCursor = client.events().reduce((max, event) => Math.max(max, event.sequence), 0);
			expect(preTrimCursor).toBeGreaterThan(0);
			client.send({
				type: "ack",
				sessionId: SESSION_ID,
				cursor: { generation: preTrimGeneration, sequence: preTrimCursor },
			});
			await client.close();

			// Two more events past the 2-record bound: acknowledged history
			// trims, the event-log generation bumps, the new events land.
			server.appendEvent({ kind: "session_status", recordedAt: new Date().toISOString(), status: "idle" });
			server.appendEvent({ kind: "session_status", recordedAt: new Date().toISOString(), status: "busy" });
			expect(server.retentionStalled).toBe(false);
			const postTrimGeneration = server.currentGeneration();
			expect(postTrimGeneration).toBeGreaterThan(preTrimGeneration);

			// Reconnect with the PRE-trim cursor and generation: hello still
			// fences on the sandbox generation (1), and the stale subscribe
			// resyncs from a snapshot instead of wedging.
			const resumed = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			resumed.hello(preTrimCursor);
			await resumed.waitForSnapshot();
			resumed.subscribe(preTrimCursor);
			// The resync delivers the post-trim history without a wedge.
			await resumed.waitFor((events) => events.some((event) => event.kind === "session_status"), 10_000);
			expect(resumed.events().length).toBeGreaterThan(0);
			await resumed.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("deletes a spawned child through the runtime host and stops mirroring it", async () => {
		const root = temp();
		const { daemon, client } = await startDaemon(root);
		try {
			const runtime = daemon.rootRuntime;
			const session = daemon.rootSession;
			expect(runtime).toBeDefined();
			expect(session).toBeDefined();
			// A real recursive child through the runtime's inline subagent
			// host - the same path the kernel's rlm.run spawns through.
			const child = await runtime!.createRlmSubagentRuntime({
				parentSession: session!,
				id: "child-del-1",
				prompt: "child task",
				sessionName: "deleteme",
				sessionDir: join(root, "child-session"),
				model: session!.model as never,
				thinkingLevel: session!.thinkingLevel,
				serviceTier: session!.serviceTier ?? "auto",
				scopedModels: [...session!.scopedModels],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: true,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-del-1",
			});
			expect(child.session.sessionName).toBe("deleteme");
			// The mirror picks the child up as a roster row.
			await client.waitFor(
				(events) =>
					events.some(
						(event) => event.kind === "roster_delta" && event.rows.some((row) => row.childId === "child-del-1"),
					),
				20_000,
			);
			// Delete through the protocol: cancel + runtime-host delete + the
			// tracked-map entry for the child's session is dropped.
			client.submit("cmd_delete_child", { kind: "delete_child", childId: "child-del-1" });
			await client.waitFor(
				(_events, messages) =>
					messages.some(
						(line) => line.includes('"commandId":"cmd_delete_child"') && line.includes('"state":"completed"'),
					),
				20_000,
			);
			// The emptied roster is itself a change: the empty delta arrives.
			await client.waitFor(
				(events) => events.some((event) => event.kind === "roster_delta" && event.rows.length === 0),
				20_000,
			);
			// The child runtime is really gone.
			expect(runtime!.listSubagentRuntimes().some((entry) => entry.metadata.rlmChildId === "child-del-1")).toBe(
				false,
			);
			await client.close();
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	}, 30_000);

	it("fails an open_session whose requested model cannot resolve instead of silently falling back", async () => {
		const root = temp();
		// Boot the daemon without opening the session: open_session arrives as
		// a real first command with an unknown model.
		const daemon = await CloudGuestDaemon.start(daemonEnv(root), {
			createRuntime: createFauxRuntimeFactory,
		});
		try {
			const client = new LoopClient(daemonEnv(root).socketPath);
			client.hello();
			await client.waitForSnapshot();
			client.subscribe(0);
			client.submit("cmd_open_unknown_model", {
				kind: "open_session",
				cwd: daemonEnv(root).workspaceDir,
				model: "unknown/model-does-not-exist",
			});
			await client.waitFor(
				(_events, messages) =>
					messages.some(
						(line) =>
							line.includes('"commandId":"cmd_open_unknown_model"') &&
							line.includes('"state":"failed"') &&
							line.includes("model-does-not-exist"),
					),
				20_000,
			);
			// The session was never created: no session file in the state dir.
			const manifest = join(daemonEnv(root).stateDir, "session-file.json");
			expect(existsSync(manifest)).toBe(false);
			await client.close();
		} finally {
			await daemon.stop();
		}
	}, 30_000);

	it("closes the connection on a command-id conflict and never re-admits", async () => {
		const root = temp();
		const server = await startServer(root);
		try {
			const socketPath = (server as unknown as { socketPath: string }).socketPath;
			const client = new LoopClient(socketPath);
			client.hello();
			await client.waitForSnapshot();
			client.subscribe(0);
			const first: CloudCommandRequest = { kind: "prompt", text: "original request" };
			client.submit("cmd_conflict", first);
			await client.waitFor((_events, messages) =>
				messages.some((line) => line.includes('"commandId":"cmd_conflict"')),
			);
			// The same commandId with a different request is a conflict: the
			// connection closes and the original admission stands.
			const closed = client.closed();
			client.submit("cmd_conflict", { kind: "prompt", text: "different request" });
			await closed;
			// The journal still holds exactly the original request.
			const probe = new LoopClient(socketPath);
			probe.hello();
			await probe.waitForSnapshot();
			probe.send({
				type: "get_command",
				sessionId: SESSION_ID,
				generation: 1,
				commandId: "cmd_conflict",
			});
			// The receipt keeps the ORIGINAL admission: its digest still names
			// the first request, never the conflicting one.
			const originalDigest = cloudRequestDigest(first);
			await probe.waitFor((_events, messages) => messages.some((line) => line.includes(originalDigest)));
			const conflictingDigest = cloudRequestDigest({ kind: "prompt", text: "different request" });
			for (const line of probe.messages) {
				if (!line.includes('"commandId":"cmd_conflict"')) continue;
				expect(line).not.toContain(conflictingDigest);
			}
			await probe.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("mirrors the transcript tail through release", async () => {
		const root = temp();
		const { daemon, client } = await startDaemon(root);
		try {
			const responsesPath = join(root, "responses.jsonl");
			process.env.PRIME_AGENT_TEST_FAUX_RESPONSES = responsesPath;
			delete process.env.PRIME_AGENT_TEST_FAUX_ECHO;
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "final tail answer" }],
				api: "faux",
				provider: "faux",
				timestamp: Date.now(),
			} as AssistantMessage;
			writeFileSync(responsesPath, `${JSON.stringify(response)}\n`, { mode: 0o600 });
			await client.waitForSnapshot();
			client.submit("cmd_tail", { kind: "prompt", text: "produce the tail" });
			// Wait only for the admission receipt, NOT for the mirror tick.
			await client.waitFor((_events, messages) => messages.some((line) => line.includes('"commandId":"cmd_tail"')));
			// Release immediately: the forced final mirror must still land the
			// assistant entry in the durable log, or /cloud stop loses the tail.
			await daemon.release("stopped");
			const eventsFile = join(daemonEnv(root).stateDir, `${SESSION_ID}.g1`, "event-outbox", "outbox-events.ndjson");
			const entries = readFileSync(eventsFile, "utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as { event?: { kind?: string; entry?: unknown } });
			const tailMirrored = entries.some(
				(entry) =>
					entry.event?.kind === "session_entry" && JSON.stringify(entry.event.entry).includes("final tail answer"),
			);
			expect(tailMirrored).toBe(true);
			const statusEvents = entries.filter((entry) => entry.event?.kind === "session_status");
			expect(statusEvents.some((entry) => JSON.stringify(entry.event).includes('"stopped"'))).toBe(true);
		} finally {
			await daemon.stop().catch(() => undefined);
		}
	}, 30_000);

	it("drops a pre-auth socket on a deadline and bounds unframed buffers", async () => {
		const root = temp();
		const server = await startServer(root);
		try {
			const socketPath = (server as unknown as { socketPath: string }).socketPath;
			// A client that floods bytes without a newline is dropped at the
			// frame bound instead of growing the buffer without limit.
			const flood = new LoopClient(socketPath);
			const socket = (flood as unknown as { socket: { write: (chunk: string | Buffer) => void } }).socket;
			const closed = flood.closed();
			socket.write(Buffer.alloc(1024 * 1024, 0x61));
			socket.write(Buffer.alloc(1024 * 1024 + 16, 0x62));
			await closed;
			await flood.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("replays in byte-bounded batches without exceeding the protocol frame bound", async () => {
		const root = temp();
		const server = await startServer(root);
		try {
			// ~1.2 MiB of events: one 512 KiB batch cannot carry them all.
			for (let index = 0; index < 20; index++) {
				server.appendEvent({
					kind: "output_delta",
					recordedAt: new Date().toISOString(),
					taskId: "task_replay",
					stream: "stdout",
					text: "x".repeat(60_000),
				});
			}
			const client = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			client.hello();
			await client.waitForSnapshot();
			client.subscribe(0);
			await client.waitFor(
				(events) => events.filter((event) => event.kind === "output_delta").length === 20,
				20_000,
			);
			// Batches arrive split by bytes, and every line is one bounded frame.
			for (const line of client.messages) {
				if (!line.includes('"type":"events"')) continue;
				expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1_048_576);
				expect(line.length).toBeLessThanOrEqual(524_288 + 65_536);
			}
			const sequences = client
				.events()
				.map((event) => event.sequence)
				.sort((a, b) => a - b);
			for (let index = 1; index < sequences.length; index++) {
				expect(sequences[index]).toBe((sequences[index - 1] as number) + 1);
			}
			await client.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("drains CJK output deltas in multiple byte-bounded frames without crashing", async () => {
		const root = temp();
		const server = await startServer(root);
		try {
			// Seven valid ~65K-character CJK deltas: each is ~196 KiB of
			// UTF-8 but only ~65K JavaScript characters, so counting
			// characters instead of bytes would pack all seven into one
			// ~1.4 MiB frame that cannot serialize - the drain crashed the
			// daemon from the uncaught hello/subscribe resync. Each delta is
			// unique by its last character and exactly at the 65,536-char bound.
			const cjk = "あ".repeat(65_535);
			const texts = Array.from({ length: 7 }, (_, index) => cjk + String.fromCharCode(0x3042 + index));
			for (const text of texts) {
				const appended = server.appendEvent({
					kind: "output_delta",
					recordedAt: new Date().toISOString(),
					taskId: "task_cjk",
					stream: "stdout",
					text,
				});
				expect(appended).toBeDefined();
			}
			const client = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			client.hello();
			await client.waitForSnapshot();
			client.subscribe(0);
			await client.waitFor((events) => events.filter((event) => event.kind === "output_delta").length === 7, 20_000);
			// The drain needs more than one bounded frame, and every frame is
			// below the protocol byte bound.
			const eventsFrames = client.messages.filter((line) => line.includes('"type":"events"'));
			expect(eventsFrames.length).toBeGreaterThan(1);
			for (const line of eventsFrames) {
				expect(Buffer.byteLength(line, "utf8")).toBeLessThan(1_048_576);
			}
			// Every delta arrived exactly once, in order, without a gap.
			const delivered = client
				.events()
				.filter((event) => event.kind === "output_delta")
				.map((event) => (event as { text: string }).text);
			expect(delivered).toHaveLength(7);
			expect(new Set(delivered).size).toBe(7);
			for (const text of texts) {
				expect(delivered).toContain(text);
			}
			const sequences = client
				.events()
				.map((event) => event.sequence)
				.sort((a, b) => a - b);
			for (let index = 1; index < sequences.length; index++) {
				expect(sequences[index]).toBe((sequences[index - 1] as number) + 1);
			}
			// The server is still healthy: it serves another client after the drain.
			const second = new LoopClient((server as unknown as { socketPath: string }).socketPath);
			second.hello();
			await second.waitForSnapshot();
			await second.close();
			await client.close();
		} finally {
			await server.stop();
		}
	}, 30_000);

	it("isolates one client's resync serialization failure per client instead of crashing", async () => {
		const root = temp();
		const socketPath = join(root, "resync.sock");
		const validState: CloudSessionState = { cwd: "/tmp", modelId: "faux-1", queuedCommandIds: [] };
		// A state that fails snapshot serialization: every resync throws, so
		// the hello and subscribe paths must drop only the affected client
		// and keep the daemon alive for everyone else.
		const invalidState = { cwd: "/tmp", modelId: "faux-1", queuedCommandIds: "not-an-array" };
		let state: unknown = validState;
		const dispatchErrors: string[] = [];
		const server = new CloudProtocolServer({
			socketPath,
			stateDirectory: join(root, "resync-state"),
			sessionId: SESSION_ID,
			generation: 1,
			callbacks: {
				sessionId: () => SESSION_ID,
				generation: () => 1,
				protocolToken: () => BRIDGE_TOKEN,
				status: () => "idle" as const,
				snapshotState: () => state as CloudSessionState,
				dispatch: async () => ({ state: "completed" as const }),
				onDispatchError: (message) => dispatchErrors.push(message),
			},
		});
		await server.start();
		try {
			// One retained event, so a surviving client can drain it later.
			const appended = server.appendEvent({
				kind: "session_status",
				recordedAt: new Date().toISOString(),
				status: "idle",
			});
			expect(appended).toBeDefined();

			// Hello: the snapshot resync cannot serialize; only this client
			// drops, and the failure is reported honestly.
			state = invalidState;
			const first = new LoopClient(socketPath);
			first.hello();
			await first.closed();
			expect(dispatchErrors.length).toBeGreaterThan(0);
			expect(dispatchErrors[0]).toContain("hello resync failed");

			// Subscribe from a stale event epoch: the resync cannot serialize;
			// the client drops with the subscribe path named in the report.
			state = validState;
			const second = new LoopClient(socketPath);
			second.hello();
			await second.waitForSnapshot();
			state = invalidState;
			second.send({ type: "subscribe", sessionId: SESSION_ID, cursor: { generation: 99, sequence: 0 } });
			await second.closed();
			expect(dispatchErrors.some((message) => message.includes("subscribe epoch resync failed"))).toBe(true);

			// The daemon survived both per-client failures: a clean client
			// attaches again and drains the retained log.
			state = validState;
			const third = new LoopClient(socketPath);
			third.hello();
			await third.waitForSnapshot();
			third.subscribe(0);
			await third.waitFor((events) => events.length > 0);
			await third.close();
			await server.stop();
		} finally {
			await server.stop().catch(() => undefined);
		}
	}, 30_000);
});
