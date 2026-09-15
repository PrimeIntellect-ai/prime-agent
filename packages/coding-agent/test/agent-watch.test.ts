import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import {
	AGENT_WATCH_MAX_ACTIVE,
	AgentWatchRegistry,
	formatAgentWatchNotice,
	formatJobWatchNotice,
} from "../src/core/agent-watch.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { HostRequestHandlers } from "../src/core/kernel/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

describe("agent watch registry", () => {
	it("emits index ranges and status transitions only, with per-child baselines", () => {
		const registry = new AgentWatchRegistry();
		const messages = new Map<string, number>([["child-1", 3]]);
		const statuses = new Map<string, string>([["child-1", "idle"]]);
		const snapshot = (childId: string) => {
			const messageCount = messages.get(childId);
			const status = statuses.get(childId);
			return messageCount === undefined || status === undefined ? undefined : { messageCount, status };
		};
		registry.register("w1", "child-1", "c1", { messageCount: 3, status: "idle" });

		const seen: string[] = [];
		const poll = () =>
			registry.poll({
				messageCount: snapshot,
				onEvent: (event) => seen.push(formatAgentWatchNotice(event)),
			});

		poll();
		expect(seen).toHaveLength(0);

		messages.set("child-1", 7);
		statuses.set("child-1", "running");
		poll();
		expect(seen[0]).toContain("messages 3..7 (+4)");
		expect(seen[0]).toContain("status: idle -> running");

		// No growth, no repeat status event: quiet.
		seen.length = 0;
		poll();
		expect(seen).toHaveLength(0);

		// A vanished child stops emitting; the registry keeps the baseline.
		expect(registry.cancel("w1")).toBe(true);
		expect(registry.cancel("w1")).toBe(false);
	});

	it("enforces active and total limits", () => {
		const registry = new AgentWatchRegistry();
		for (let i = 0; i < AGENT_WATCH_MAX_ACTIVE; i++) {
			registry.register(`w-${i}`, `child-${i}`, `c${i}`, { messageCount: 0, status: "idle" });
		}
		expect(() => registry.register("w-over", "child-over", "c", { messageCount: 0, status: "idle" })).toThrow(
			/active/,
		);
	});

	it("formats job progress notices as byte ranges", () => {
		expect(formatJobWatchNotice(123, 100, 4567, "echo long command")).toContain(
			"[watch-job pid:123] output +4467 bytes (100..4567)",
		);
	});
});

describe("watch notice routing", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-watch-routing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(agentMessageDigest: boolean): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage: {
							input: 700,
							output: 100,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 800,
							cost: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								total: 0,
							},
						},
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			agentMessageDigest,
		});
		return session;
	}

	function kernelHandlers(): HostRequestHandlers {
		return (session as unknown as { _createKernelHostHandlers(): HostRequestHandlers })._createKernelHostHandlers();
	}

	it("delivers job progress as a quiet injected notice on the push lane", async () => {
		createSession(false);
		const handlers = kernelHandlers();
		await handlers["bash.progress"]!({ pid: 99, command: "tail -f", fromBytes: 0, toBytes: 400 });
		await session.waitForSessionInputIdle();
		await session.agent.waitForIdle();

		const notice = session.agent.state.messages.find(
			(message) => "customType" in message && message.customType === "agent_watch_notice",
		);
		expect(notice).toMatchObject({
			role: "custom",
			content: expect.stringContaining("[watch-job pid:99] output +400 bytes (0..400)"),
		});
	});

	it("lands job progress in the digest inbox when the digest lane is on", async () => {
		const target = createSession(true);
		const handlers = kernelHandlers();
		await handlers["bash.progress"]!({ pid: 99, command: "tail -f", fromBytes: 0, toBytes: 400 });

		const stats = target.messagingStats();
		expect(stats.inbox).toEqual({ unread: 1, total: 1 });
		const listing = (await handlers["rlm.inbox.list"]!({})) as {
			entries: { kind: string; watch?: string; content: string }[];
		};
		expect(listing.entries[0]).toMatchObject({ kind: "watch", watch: "job" });
		expect(listing.entries[0]?.content).toContain("[watch-job pid:99]");
	});

	it("validates watch registration payloads", async () => {
		const target = createSession(false);
		const handlers = kernelHandlers();
		await expect(handlers["rlm.watch.agent"]!({})).rejects.toThrow(/target/);
		await expect(handlers["rlm.watch.agent"]!({ target: "ghost" })).rejects.toThrow(/No direct child/);
		await expect(handlers["bash.progress"]!({ pid: "x", fromBytes: 0, toBytes: 1 })).rejects.toThrow(/numeric/);
		// No-growth progress is a silent no-op, not an error.
		await expect(handlers["bash.progress"]!({ pid: 5, command: "c", fromBytes: 40, toBytes: 40 })).resolves.toEqual({
			status: "ok",
		});
		expect(target.listAgentWatches()).toEqual([]);
	});
});
