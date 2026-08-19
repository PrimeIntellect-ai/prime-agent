import { mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createHerdrAgentStateExtension,
	hasFileBasedHerdrIntegration,
	herdrAgentStateExtension,
} from "../src/core/extensions/builtin/herdr-agent-state.js";
import type { ExtensionAPI } from "../src/core/extensions/types.js";

interface RecordedRequest {
	method: string;
	params: Record<string, unknown>;
}

function createMockPi() {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const busHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const pi = {
		on(event: string, handler: (...args: unknown[]) => unknown) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		events: {
			on(event: string, handler: (...args: unknown[]) => unknown) {
				const list = busHandlers.get(event) ?? [];
				list.push(handler);
				busHandlers.set(event, list);
				return () => {
					const current = busHandlers.get(event) ?? [];
					const index = current.indexOf(handler);
					if (index !== -1) {
						current.splice(index, 1);
					}
				};
			},
		},
	} as unknown as ExtensionAPI;
	return { pi, handlers, busHandlers };
}

async function startFakeHerdrServer(socketPath: string): Promise<{
	server: Server;
	requests: RecordedRequest[];
	waitForRequests: (count: number, timeoutMs?: number) => Promise<void>;
}> {
	const requests: RecordedRequest[] = [];
	const waiters: Array<{ count: number; resolve: () => void }> = [];

	const server = createServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex >= 0) {
				const line = buffer.slice(0, newlineIndex);
				buffer = buffer.slice(newlineIndex + 1);
				if (line.trim()) {
					const parsed = JSON.parse(line);
					requests.push({ method: parsed.method, params: parsed.params });
					socket.write(`${JSON.stringify({ id: parsed.id, result: { type: "ok" } })}\n`);
					for (const waiter of [...waiters]) {
						if (requests.length >= waiter.count) {
							waiters.splice(waiters.indexOf(waiter), 1);
							waiter.resolve();
						}
					}
				}
				newlineIndex = buffer.indexOf("\n");
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.on("error", reject);
		server.listen(socketPath, resolve);
	});

	const waitForRequests = (count: number, timeoutMs = 3000): Promise<void> => {
		if (requests.length >= count) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`timed out waiting for ${count} herdr requests`)), timeoutMs);
			waiters.push({
				count,
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
			});
		});
	};

	return { server, requests, waitForRequests };
}

describe("herdrAgentStateExtension", () => {
	const cleanupPaths: string[] = [];
	const cleanupServers: Server[] = [];
	const savedEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"HERDR_ENV",
		"HERDR_SOCKET_PATH",
		"HERDR_PANE_ID",
		"HERDR_PI_IDLE_DEBOUNCE_MS",
		"HERDR_PI_RETRY_GRACE_MS",
		"PRIME_AGENT_CODING_AGENT_DIR",
	];

	for (const key of envKeys) {
		savedEnv[key] = process.env[key];
	}

	afterEach(async () => {
		for (const key of envKeys) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
		while (cleanupServers.length > 0) {
			const server = cleanupServers.pop();
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		}
		while (cleanupPaths.length > 0) {
			const path = cleanupPaths.pop();
			if (path) {
				rmSync(path, { recursive: true, force: true });
			}
		}
	});

	it("registers no handlers when HERDR_ENV is not set", () => {
		delete process.env.HERDR_ENV;
		delete process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_PANE_ID;

		const { pi, handlers, busHandlers } = createMockPi();
		herdrAgentStateExtension(pi);

		expect(handlers.size).toBe(0);
		expect(busHandlers.size).toBe(0);
	});

	it("detects the file-based herdr integration among loaded extension paths", () => {
		expect(hasFileBasedHerdrIntegration(["/x/extensions/herdr-agent-state.ts"])).toBe(true);
		expect(hasFileBasedHerdrIntegration(["/x/extensions/herdr-agent-state.js"])).toBe(true);
		expect(hasFileBasedHerdrIntegration(["/x/extensions/other.ts"])).toBe(false);
		expect(hasFileBasedHerdrIntegration([])).toBe(false);
	});

	it("defers only to a file-based integration that actually loaded", () => {
		const tempDir = join(tmpdir(), `pi-herdr-defer-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = join(tempDir, "h.sock");
		process.env.HERDR_PANE_ID = "w1:p1";

		// The loader reports the file-based integration as loaded: defer.
		let loadedPaths = [join(tempDir, "extensions", "herdr-agent-state.ts")];
		const factory = createHerdrAgentStateExtension(() => loadedPaths);
		const { pi, handlers, busHandlers } = createMockPi();
		factory(pi);
		expect(handlers.size).toBe(0);
		expect(busHandlers.size).toBe(0);

		// Loaded paths are consulted per invocation, so a /reload after the
		// file-based integration is removed or disabled re-enables the built-in.
		loadedPaths = [];
		const second = createMockPi();
		factory(second.pi);
		expect(second.handlers.size).toBeGreaterThan(0);
	});

	it("ignores events from sessions other than the one it bound to", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";

		const { pi, handlers } = createMockPi();
		herdrAgentStateExtension(pi);

		const parentSessionManager = { getSessionFile: () => "/tmp/parent.jsonl", getSessionId: () => "parent" };
		const childSessionManager = { getSessionFile: () => "/tmp/child.jsonl", getSessionId: () => "child" };
		const parentCtx = { sessionManager: parentSessionManager };
		const childCtx = { sessionManager: childSessionManager };

		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, parentCtx);
		await waitForRequests(1);
		expect(requests[0]?.params.agent_session_path).toBe("/tmp/parent.jsonl");

		// Inline RLM children rebind the same handlers with their own ctx; their
		// events must not flip the pane state or release the parent's pane.
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, childCtx);
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, childCtx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(requests).toHaveLength(1);

		// The bound parent still reports normally.
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, parentCtx);
		await waitForRequests(2);
		expect(requests[1]?.params.state).toBe("working");
	});

	it("reports lifecycle state to the herdr socket", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.HERDR_PI_IDLE_DEBOUNCE_MS = "10";
		process.env.PRIME_AGENT_CODING_AGENT_DIR = tempDir;

		const { pi, handlers } = createMockPi();
		herdrAgentStateExtension(pi);

		expect(handlers.has("session_start")).toBe(true);
		expect(handlers.has("agent_start")).toBe(true);
		expect(handlers.has("agent_end")).toBe(true);
		expect(handlers.has("session_shutdown")).toBe(true);

		const ctx = {
			sessionManager: {
				getSessionFile: () => "/tmp/session.jsonl",
				getSessionId: () => "session-1",
			},
		};

		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await waitForRequests(1);
		expect(requests[0]?.method).toBe("pane.report_agent");
		expect(requests[0]?.params.agent).toBe("prime-agent");
		expect(requests[0]?.params.pane_id).toBe("w1:p1");
		expect(requests[0]?.params.state).toBe("idle");
		expect(requests[0]?.params.agent_session_path).toBe("/tmp/session.jsonl");

		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
		await waitForRequests(2);
		expect(requests[1]?.params.state).toBe("working");

		handlers.get("agent_end")?.[0]?.({ type: "agent_end", messages: [] }, ctx);
		await waitForRequests(3);
		expect(requests[2]?.params.state).toBe("idle");

		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "new" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(requests).toHaveLength(3);

		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, ctx);
		await waitForRequests(4);
		expect(requests[3]?.method).toBe("pane.release_agent");
		expect(requests[3]?.params.agent).toBe("prime-agent");
	});

	it("unsubscribes the shared-bus herdr:blocked listener on shutdown", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";

		const { pi, handlers, busHandlers } = createMockPi();
		herdrAgentStateExtension(pi);
		expect(busHandlers.get("herdr:blocked")).toHaveLength(1);

		const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "new" }, ctx);
		expect(busHandlers.get("herdr:blocked")).toHaveLength(0);
	});

	it("reports working when the session starts mid-turn (reload)", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.HERDR_PI_IDLE_DEBOUNCE_MS = "10";

		const { pi, handlers } = createMockPi();
		herdrAgentStateExtension(pi);

		const ctx = {
			sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" },
			isIdle: () => false,
		};
		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "reload" }, ctx);
		await waitForRequests(1);
		expect(requests[0]?.params.state).toBe("working");

		handlers.get("agent_end")?.[0]?.({ type: "agent_end", messages: [] }, ctx);
		await waitForRequests(2);
		expect(requests[1]?.params.state).toBe("idle");
	});

	it("settles the retry hold when a blocked event interrupts it", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.HERDR_PI_IDLE_DEBOUNCE_MS = "10";

		const { pi, handlers, busHandlers } = createMockPi();
		herdrAgentStateExtension(pi);

		const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
		handlers.get("agent_end")?.[0]?.(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limit exceeded" }],
			},
			ctx,
		);
		// A blocked event lands during the hold, cancelling the retry timer...
		const blocked = busHandlers.get("herdr:blocked")?.[0];
		blocked?.({ active: true, label: "permission needed" });
		// ...and when the block lifts, the pane must settle to blocked (failed
		// retry), not stick at working forever. Intermediate states coalesce in
		// the latest-wins queue, so assert on the settled final report.
		blocked?.({ active: false });

		await waitForRequests(2);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const finalState = requests.at(-1)?.params.state;
		expect(finalState).toBe("blocked");
		expect(requests.at(-1)?.params.message).toContain("rate limit");
	});

	it("holds working through any error end until the retry grace settles", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.HERDR_PI_IDLE_DEBOUNCE_MS = "10";
		process.env.HERDR_PI_RETRY_GRACE_MS = "30";

		const { pi, handlers } = createMockPi();
		herdrAgentStateExtension(pi);

		const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
		handlers.get("agent_end")?.[0]?.(
			{
				type: "agent_end",
				messages: [{ role: "assistant", stopReason: "error", errorMessage: "unexpected provider failure xyz" }],
			},
			ctx,
		);

		await waitForRequests(3);
		expect(requests.map((r) => r.params.state)).toEqual(["idle", "working", "blocked"]);
		expect(requests.at(-1)?.params.message).toContain("unexpected provider failure");
	});

	it("sends no reports after quit release", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";

		const { pi, handlers } = createMockPi();
		herdrAgentStateExtension(pi);

		const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, ctx);
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);

		await waitForRequests(2);
		await new Promise((resolve) => setTimeout(resolve, 100));
		// Still-queued reports are dropped by the release, so the exact report
		// count depends on send timing; the invariant is that the release is the
		// last write and nothing reclaims the pane after it.
		expect(requests.at(-1)?.method).toBe("pane.release_agent");
		expect(requests.filter((r) => r.method === "pane.release_agent")).toHaveLength(1);
	});

	it("silences a replaced instance without releasing the pane", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";

		const { pi, handlers } = createMockPi();
		herdrAgentStateExtension(pi);

		const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };
		handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await waitForRequests(1);

		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "new" }, ctx);
		handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(requests).toHaveLength(1);
		expect(requests.some((r) => r.method === "pane.release_agent")).toBe(false);
	});

	it("keeps seq monotonically increasing across extension instances", async () => {
		const tempDir = join(tmpdir(), `hrd-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempDir, { recursive: true });
		cleanupPaths.push(tempDir);
		const socketPath = join(tempDir, "h.sock");

		const { server, requests, waitForRequests } = await startFakeHerdrServer(socketPath);
		cleanupServers.push(server);

		process.env.HERDR_ENV = "1";
		process.env.HERDR_SOCKET_PATH = socketPath;
		process.env.HERDR_PANE_ID = "w1:p1";
		process.env.PRIME_AGENT_CODING_AGENT_DIR = tempDir;

		const ctx = { sessionManager: { getSessionFile: () => undefined, getSessionId: () => "s" } };

		// Two instances, as after a session replacement: the successor's seq must
		// exceed everything the predecessor sent, or herdr drops its reports.
		const first = createMockPi();
		herdrAgentStateExtension(first.pi);
		first.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await waitForRequests(1);

		const second = createMockPi();
		herdrAgentStateExtension(second.pi);
		second.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "new" }, ctx);
		await waitForRequests(2);

		const seqs = requests.map((r) => r.params.seq as number);
		expect(seqs[1]).toBeGreaterThan(seqs[0]);
	});
});
