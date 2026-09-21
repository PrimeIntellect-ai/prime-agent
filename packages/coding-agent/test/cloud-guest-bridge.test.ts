import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	watch,
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
import { CloudResultStore, decodeCloudChangedPaths, decodeCloudResultPatch } from "../src/core/cloud/result-import.js";

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

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/**
 * Wait for a file through directory watch events: the artifact's arrival is
 * the only signal, never a clock. The double check covers the race between
 * the initial probe and arming the watcher.
 */
function waitForFile(dir: string, fileName: string, isReady: (path: string) => boolean = () => true): Promise<void> {
	return new Promise((resolve, reject) => {
		const path = join(dir, fileName);
		const ready = () => existsSync(path) && isReady(path);
		if (ready()) return resolve();
		const watcher = watch(dir, () => {
			if (ready()) {
				watcher.close();
				resolve();
			}
		});
		if (ready()) {
			watcher.close();
			return resolve();
		}
		watcher.on("error", (error) => {
			watcher.close();
			reject(error);
		});
	});
}

async function startBridge(
	options: {
		prompt?: string;
		/** Replaces the resident daemon argv; finalize-only tests stub it out. */
		daemonArgv?: string[];
		/** Prepares a pre-existing workspace and returns extra bridge env. */
		setupWorkspace?: (workspaceDir: string) => Record<string, string>;
	} = {},
): Promise<Bridge> {
	const root = mkdtempSync(join(tmpdir(), "cloud-guest-bridge-test-"));
	roots.push(root);
	const workspaceDir = join(root, "workspace");
	const resultsDir = join(root, "results");
	const stateDir = join(root, "state");
	const daemonStateDir = join(root, "daemon-state");
	const agentDir = join(root, "agent");
	mkdirSync(workspaceDir, { recursive: true });
	mkdirSync(resultsDir);
	mkdirSync(stateDir);
	mkdirSync(daemonStateDir);
	mkdirSync(agentDir);
	const workspaceEnv = options.setupWorkspace?.(workspaceDir) ?? {};
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
			PRIME_AGENT_CLOUD_DAEMON_ARGV_JSON: JSON.stringify(
				options.daemonArgv ?? [process.execPath, tsxPath, fixturePath],
			),
			PRIME_AGENT_TEST_FAUX_RESPONSES: responsesPath,
			PRIME_AGENT_TEST_FAUX_ECHO: "1",
			PRIME_API_KEY: "",
			...workspaceEnv,
		},
		stdio: ["ignore", "ignore", "pipe"],
	});
	children.add(bridgeProcess);
	bridgeProcess.stderr?.setEncoding("utf8");
	const stderr: string[] = [];
	bridgeProcess.stderr?.on("data", (chunk: string) => stderr.push(chunk));
	const portPath = join(stateDir, "port");
	// The port file's arrival is the deterministic ready signal; an early
	// bridge exit is the deterministic failure signal. Neither needs a clock.
	const portPromise = new Promise<number>((resolve, reject) => {
		const readPort = () => {
			if (!existsSync(portPath)) return undefined;
			const port = Number(readFileSync(portPath, "utf8").trim());
			return Number.isInteger(port) && port >= 1 ? port : undefined;
		};
		const port = readPort();
		if (port !== undefined) return resolve(port);
		const watcher = watch(stateDir, () => {
			const next = readPort();
			if (next !== undefined) {
				watcher.close();
				resolve(next);
			}
		});
		const settled = readPort();
		if (settled !== undefined) {
			watcher.close();
			return resolve(settled);
		}
		watcher.on("error", (error) => {
			watcher.close();
			reject(error);
		});
		bridgeProcess.once("exit", () => {
			if (readPort() === undefined) {
				watcher.close();
				reject(new Error(`bridge exited early: ${stderr.join("")}`));
			}
		});
	});
	const port = await portPromise;
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
	/** Event-driven wait: the predicate re-runs on every landed message, never on a clock. */
	waitFor(predicate: (message: CloudMessage) => boolean): Promise<void>;
	close: () => Promise<void>;
}

async function connect(bridge: Bridge): Promise<Client> {
	const connection = await transport.connect(`http://127.0.0.1:${String(bridge.port)}`, {});
	const messages: CloudMessage[] = [];
	const waiters = new Set<() => void>();
	const notify = () => {
		const pending = [...waiters];
		waiters.clear();
		for (const resolve of pending) resolve();
	};
	connection.onMessage((message) => {
		messages.push(JSON.parse(message) as CloudMessage);
		notify();
	});
	return {
		connection,
		messages,
		waitFor: async (predicate: (message: CloudMessage) => boolean) => {
			for (;;) {
				if (messages.some(predicate)) return;
				await new Promise<void>((resolve) => waiters.add(resolve));
			}
		},
		close: () =>
			new Promise<void>((resolve) => {
				connection.onClose(() => {
					notify();
					resolve();
				});
				connection.close("test done");
			}),
	};
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

async function awaitClosed(client: Client): Promise<void> {
	// The close event is the only signal; a hang surfaces through the runner's
	// default test timeout.
	await new Promise<void>((resolve) => {
		client.connection.onClose(() => resolve());
	});
}

async function awaitDaemonReady(bridge: Bridge): Promise<void> {
	await waitForFile(bridge.daemonStateDir, "cloud.sock");
}

function daemonPid(bridge: Bridge): number | undefined {
	const pidPath = join(bridge.stateDir, "daemon.pid");
	if (!existsSync(pidPath)) return undefined;
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

async function submitAndWait(client: Client, commandId: string, request: CloudCommandRequest): Promise<void> {
	await submit(client.connection, commandId, request);
	await client.waitFor((message) => message.type === "command" && message.receipt.commandId === commandId);
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
				await client.waitFor((message) => message.type === "snapshot");
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
			await client.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "session_entry" &&
							event.entryId !== undefined &&
							(event.entry as { type?: string }).type === "message",
					),
			);
			await client.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("first answer")),
			);

			appendResponse(bridge, "second answer");
			await submit(client.connection, "cmd_prompt_2", { kind: "prompt", text: "second prompt" });
			await client.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("second answer")),
			);
			// The durable mirror lags the live stream by at most one tick.
			await client.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "session_entry" &&
							JSON.stringify((event.entry as { message?: unknown }).message ?? null).includes("second prompt"),
					),
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
			await client.waitFor(
				(message) => message.type === "events" && message.events.some((event) => event.kind === "session_meta"),
			);
			await client.waitFor(
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
	});

	it("reconnects with cursor replay, idempotent resubmits, and honest receipt states", async () => {
		const bridge = await startBridge();
		try {
			const first = await connect(bridge);
			sendHello(first.connection);
			await first.waitFor((message) => message.type === "snapshot");
			sendSubscribe(first.connection, 0);
			await submitAndWait(first, "cmd_open", { kind: "open_session", cwd: bridge.workspaceDir });
			appendResponse(bridge, "steered answer");
			await submit(first.connection, "cmd_steer", { kind: "steer", text: "steer this" });
			await first.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("steered answer")),
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
			await second.waitFor((message) => message.type === "snapshot");
			sendSubscribe(second.connection, tail);
			// A duplicate submit replays the retained receipt and never re-executes.
			await submit(second.connection, "cmd_steer", { kind: "steer", text: "steer this" });
			await second.waitFor((message) => message.type === "command" && message.receipt.commandId === "cmd_steer");
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
			await second.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) =>
							event.kind === "command_state" &&
							event.receipt.commandId === "cmd_abort" &&
							event.receipt.state === "completed",
					),
			);
			await second.close();
		} finally {
			bridge.process.kill("SIGKILL");
		}
	});

	it("restarts a crashed guest daemon, replays from the durable log, and never re-executes uncertain work", async () => {
		const bridge = await startBridge();
		try {
			const client = await connect(bridge);
			sendHello(client.connection);
			await client.waitFor((message) => message.type === "snapshot");
			sendSubscribe(client.connection, 0);
			await submitAndWait(client, "cmd_open", { kind: "open_session", cwd: bridge.workspaceDir });
			appendResponse(bridge, "pre-crash answer");
			await submit(client.connection, "cmd_prompt_pre", { kind: "prompt", text: "before the crash" });
			await client.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some((event) => event.kind === "output_delta" && event.text.includes("pre-crash answer")),
			);
			const pid = daemonPid(bridge);
			expect(pid).toBeGreaterThan(0);

			// Crash the daemon hard: the bridge restarts it and the durable
			// journal + outbox recover the session and the mirrored entries.
			process.kill(pid as number, "SIGKILL");
			await client.close();
			// The bridge's restart writes a new daemon pid: the file change is
			// the deterministic signal that the replacement came up.
			await new Promise<void>((resolve, reject) => {
				const restarted = () => {
					const next = daemonPid(bridge);
					return next !== undefined && next !== pid;
				};
				if (restarted()) return resolve();
				const watcher = watch(bridge.stateDir, () => {
					if (restarted()) {
						watcher.close();
						resolve();
					}
				});
				if (restarted()) {
					watcher.close();
					return resolve();
				}
				watcher.on("error", (error) => {
					watcher.close();
					reject(error);
				});
			});

			const resumed = await connect(bridge);
			sendHello(resumed.connection, { cursor: 0 });
			await resumed.waitFor((message) => message.type === "snapshot");
			sendSubscribe(resumed.connection, 0);
			// The durable log replays through the restarted daemon.
			await resumed.waitFor(
				(message) => message.type === "events" && message.events.some((event) => event.kind === "session_entry"),
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
			await resumed.waitFor(
				(message) =>
					message.type === "events" &&
					message.events.some(
						(event) => event.kind === "output_delta" && event.text.includes("post-crash answer"),
					),
			);
			await resumed.close();
		} finally {
			bridge.process.kill("SIGKILL");
		}
	});

	it("finalizes the gateway results contract for the one-shot flow (no tunnel)", async () => {
		const bridge = await startBridge({ prompt: "run the one-shot task" });
		try {
			// The bridge writes status.txt as its terminal commit marker: the
			// file's arrival is the deterministic completion signal.
			await waitForFile(bridge.resultsDir, "status.txt");
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
	});

	// A stub daemon (the supervised process ignores everything): finalize and
	// the terminal results contract are bridge-owned, so the contract is
	// exercised without the daemon's startup latency or one-shot races.
	it("publishes exact patch bytes and changed paths on the stop flow, importing them byte-for-byte", async () => {
		// The edits cover the byte-safety the contract must preserve: a text
		// hunk with non-UTF-8 bytes (any lossy string round-trip corrupts the
		// patch) and a NUL-bearing binary blob (a GIT binary patch section).
		const baselineText = Buffer.from([0x74, 0x65, 0x78, 0x74, 0xe9, 0x0a]);
		const editedText = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x20, 0xff, 0x0a]);
		const editedBlob = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x42, 0x00]);
		const bridge = await startBridge({
			daemonArgv: [process.execPath, "-e", "setInterval(() => {}, 3600000)"],
			setupWorkspace: (workspaceDir) => {
				writeFileSync(join(workspaceDir, "notes.txt"), baselineText);
				writeFileSync(join(workspaceDir, "data.bin"), Buffer.from([0x00, 0x00, 0x00]));
				git(workspaceDir, "init", "-q");
				git(workspaceDir, "config", "user.email", "test@example.com");
				git(workspaceDir, "config", "user.name", "Test");
				git(workspaceDir, "add", "-A");
				git(workspaceDir, "commit", "-qm", "baseline");
				writeFileSync(join(workspaceDir, "notes.txt"), editedText);
				writeFileSync(join(workspaceDir, "data.bin"), editedBlob);
				return { PRIME_AGENT_CLOUD_GIT_BASELINE: git(workspaceDir, "rev-parse", "HEAD") };
			},
		});
		try {
			// The exact bytes finalize must publish, computed the same way the
			// bridge computes them while nothing else can touch the tree.
			const expectedPatch = execFileSync(
				"git",
				[
					"-c",
					"core.quotePath=false",
					"diff",
					"--binary",
					"--no-renames",
					git(bridge.workspaceDir, "rev-parse", "HEAD"),
				],
				{ cwd: bridge.workspaceDir },
			);
			expect(expectedPatch.byteLength).toBeGreaterThan(0);
			// A strict UTF-8 decode must fail: the raw latin-1 hunk bytes prove
			// the patch is only byte-exact, never string-exact.
			expect(() => new TextDecoder("utf-8", { fatal: true }).decode(expectedPatch)).toThrow();

			// Release (stop) the bridge: SIGTERM is the release signal.
			bridge.process.kill("SIGTERM");
			// The terminal status is the commit marker: the instant it is
			// observable, both artifacts must already be complete on disk.
			await waitForFile(bridge.resultsDir, "status.txt");
			expect(existsSync(join(bridge.resultsDir, "changes.patch"))).toBe(true);
			expect(existsSync(join(bridge.resultsDir, "changed-paths.txt"))).toBe(true);
			expect(readFileSync(join(bridge.resultsDir, "status.txt"), "utf8")).toBe("stopped\n");
			expect(existsSync(bridge.authPath)).toBe(false);

			const patchBytes = readFileSync(join(bridge.resultsDir, "changes.patch"));
			expect(patchBytes.equals(expectedPatch)).toBe(true);
			const changedPaths = decodeCloudChangedPaths(readFileSync(join(bridge.resultsDir, "changed-paths.txt")));
			expect(changedPaths.slice().sort()).toEqual(["data.bin", "notes.txt"]);

			// Import through the real result store: the exact patch bytes
			// persist, cross-validate against the changed paths, and apply
			// byte-for-byte into a clean clone of the captured baseline.
			const resultStore = new CloudResultStore(join(bridge.root, "result-store"));
			const saved = resultStore.save({
				sessionId: SESSION_ID,
				resultId: "res_output",
				patch: decodeCloudResultPatch(patchBytes),
				changedPaths,
				baselineManifestDigest: `sha256:${"a".repeat(64)}`,
			});
			expect(saved.changedPaths).toEqual(["data.bin", "notes.txt"]);
			const clone = join(bridge.root, "clone");
			execFileSync("git", ["clone", "-q", "--no-hardlinks", bridge.workspaceDir, clone]);
			const applied = await resultStore.apply(SESSION_ID, saved.resultId, { cwd: clone });
			expect(applied.applied).toBe(true);
			expect(readFileSync(join(clone, "notes.txt")).equals(editedText)).toBe(true);
			expect(readFileSync(join(clone, "data.bin")).equals(editedBlob)).toBe(true);
		} finally {
			bridge.process.kill("SIGKILL");
		}
	});

	it("publishes an empty patch and empty changed paths when nothing changed", async () => {
		const bridge = await startBridge({
			daemonArgv: [process.execPath, "-e", "setInterval(() => {}, 3600000)"],
			setupWorkspace: (workspaceDir) => {
				writeFileSync(join(workspaceDir, "notes.txt"), "unchanged\n");
				git(workspaceDir, "init", "-q");
				git(workspaceDir, "config", "user.email", "test@example.com");
				git(workspaceDir, "config", "user.name", "Test");
				git(workspaceDir, "add", "-A");
				git(workspaceDir, "commit", "-qm", "baseline");
				return { PRIME_AGENT_CLOUD_GIT_BASELINE: git(workspaceDir, "rev-parse", "HEAD") };
			},
		});
		try {
			bridge.process.kill("SIGTERM");
			await waitForFile(bridge.resultsDir, "status.txt");
			expect(existsSync(join(bridge.resultsDir, "changes.patch"))).toBe(true);
			expect(existsSync(join(bridge.resultsDir, "changed-paths.txt"))).toBe(true);
			expect(readFileSync(join(bridge.resultsDir, "status.txt"), "utf8")).toBe("stopped\n");
			expect(existsSync(bridge.authPath)).toBe(false);
			expect(readFileSync(join(bridge.resultsDir, "changes.patch")).byteLength).toBe(0);
			expect(decodeCloudChangedPaths(readFileSync(join(bridge.resultsDir, "changed-paths.txt")))).toEqual([]);
		} finally {
			bridge.process.kill("SIGKILL");
		}
	});

	it("passes the scoped inference credential to the guest daemon without leaking it", async () => {
		const bridge = await startBridge();
		try {
			await awaitDaemonReady(bridge);
			const credentialPath = join(bridge.agentDir, "credential-seen.json");
			await waitForFile(bridge.agentDir, "credential-seen.json");
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
	});

	it("rejects oversized and malformed submits at the protocol bound", async () => {
		const bridge = await startBridge();
		try {
			const client = await connect(bridge);
			sendHello(client.connection);
			await client.waitFor((message) => message.type === "snapshot");
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
	});
});
