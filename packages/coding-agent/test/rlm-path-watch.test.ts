import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
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

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("rlm path watches", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-path-watch-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	function kernelHandlers(): HostRequestHandlers {
		return (session as unknown as { _createKernelHostHandlers(): HostRequestHandlers })._createKernelHostHandlers();
	}

	function watchNotice(customType: string) {
		return session.messages.find(
			(message): message is Extract<(typeof session.messages)[number], { role: "custom" }> =>
				message.role === "custom" && message.customType === customType,
		);
	}

	it("registers a watch and delivers a debounced change notice into the session", async () => {
		createSession();
		const handlers = kernelHandlers();
		const shared = join(tempDir, "shared");
		mkdirSync(shared);

		const registered = (await handlers["rlm.watch_path"]!({ path: shared, recursive: false })) as {
			watch: { watch_id: string; path: string; status: string };
		};
		expect(registered.watch.status).toBe("active");
		expect(registered.watch.path).toBe(shared);

		writeFileSync(join(shared, "signal-1.txt"), "one");
		writeFileSync(join(shared, "signal-2.txt"), "two");

		await vi.waitFor(() => expect(watchNotice("watch_path_changed")).toBeDefined(), { timeout: 5_000 });
		const notice = watchNotice("watch_path_changed");
		expect(notice?.content).toContain(`[watch-path id:${registered.watch.watch_id} path:${shared}]`);
		expect(notice?.content).toContain("signal-1.txt");
		expect(notice?.content).toContain("signal-2.txt");

		const listed = (await handlers["rlm.watch_list"]!({})) as { watches: { watch_id: string; status: string }[] };
		expect(listed.watches.map((watch) => watch.watch_id)).toEqual([registered.watch.watch_id]);

		const cancelled = (await handlers["rlm.watch_cancel"]!({
			watch_id: registered.watch.watch_id,
		})) as { watch: { status: string } };
		expect(cancelled.watch.status).toBe("completed");
	});

	it("resolves relative paths against the session cwd", async () => {
		createSession();
		const handlers = kernelHandlers();
		mkdirSync(join(tempDir, "relative"));

		const registered = (await handlers["rlm.watch_path"]!({ path: "relative" })) as {
			watch: { watch_id: string; path: string };
		};
		expect(registered.watch.path).toBe(join(tempDir, "relative"));
		await handlers["rlm.watch_cancel"]!({ watch_id: registered.watch.watch_id });
	});

	it("rejects missing paths, invalid flags, and unknown watch ids", async () => {
		createSession();
		const handlers = kernelHandlers();
		await expect(handlers["rlm.watch_path"]!({ path: join(tempDir, "missing") })).rejects.toThrow("does not exist");
		await expect(handlers["rlm.watch_path"]!({ path: tempDir, recursive: "yes" })).rejects.toThrow(
			"recursive must be a boolean",
		);
		await expect(handlers["rlm.watch_get"]!({ watch_id: "watch_unknown" })).rejects.toThrow("Unknown path watch");
	});

	it("reports watch failure when the watched file is removed", async () => {
		createSession();
		const handlers = kernelHandlers();
		const target = join(tempDir, "gone.txt");
		writeFileSync(target, "seed");

		const registered = (await handlers["rlm.watch_path"]!({ path: target })) as {
			watch: { watch_id: string };
		};
		unlinkSync(target);

		await vi.waitFor(() => expect(watchNotice("watch_path_failed")).toBeDefined(), { timeout: 5_000 });
		const failure = watchNotice("watch_path_failed");
		expect(failure?.content).toContain("[watch-path-failed");
		expect(failure?.content).toContain("removed");

		const listed = (await handlers["rlm.watch_list"]!({})) as {
			watches: { watch_id: string; status: string; error?: string }[];
		};
		expect(listed.watches[0].status).toBe("failed");
		expect(listed.watches[0].watch_id).toBe(registered.watch.watch_id);
	});
});
