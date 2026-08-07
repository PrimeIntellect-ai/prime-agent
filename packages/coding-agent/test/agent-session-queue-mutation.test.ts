/** Tests for AgentSession.mutateQueuedMessage: (lane, index, expectedText) queue edits. */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type ImageContent,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { QueuedMessageMutation } from "../src/core/session-action-store.js";
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

const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: { ...zeroUsage, totalTokens: 0, cost: zeroUsage },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AgentSession queue mutation", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-queue-mutation-test-${Date.now()}-${Math.random()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) session.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: (_model, _context, options) => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => stream.push({ type: "start", partial: createAssistantMessage("") }));
				options?.signal?.addEventListener("abort", () =>
					stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") }),
				);
				return stream;
			},
		});
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, tempDir),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	/** Start a never-finishing turn so later submissions stay queued; returns the prompt promise. */
	async function blockSession(): Promise<{ running: Promise<void> }> {
		const running = session.prompt("running");
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { running };
	}

	const mutate = (l: "steering" | "followUp", i: number, text: string, m: QueuedMessageMutation) =>
		session.mutateQueuedMessage(l, i, text, m);
	const queue = () => {
		const snapshot = session.getSessionActionSnapshot();
		return { steering: [...snapshot.steering], followUp: [...snapshot.followUps] };
	};
	const payloadOf = (text: string) =>
		session.getSessionActionRecoverySnapshot().actions.find((action) => action.payload.text === text)?.payload;
	const primaryContent = (text: string) => {
		const payload = payloadOf(text);
		if (payload?.kind !== "turn") throw new Error(`expected turn payload for ${text}`);
		return payload.records[0]?.message.content;
	};

	it("addresses items in snapshot projection order and rejects stale addresses", async () => {
		createSession();
		const { running } = await blockSession();
		await session.steer("s1");
		await session.steer("s2");
		await session.followUp("f1");
		expect(queue()).toEqual({ steering: ["s1", "s2"], followUp: ["f1"] });
		expect(session.queuedActionCount).toBe(3);
		expect(mutate("steering", 0, "wrong", { type: "delete" })).toBe("rejected");
		expect(mutate("steering", 3, "s1", { type: "delete" })).toBe("rejected");
		expect(mutate("followUp", 0, "s1", { type: "delete" })).toBe("rejected"); // right text, wrong lane
		expect(mutate("steering", 0, "s1", { type: "delete" })).toBe("applied");
		expect(queue()).toEqual({ steering: ["s2"], followUp: ["f1"] });
		expect(session.queuedActionCount).toBe(2);
		await session.abort();
		await running.catch(() => {});
	});

	it("moves within a lane, rejects boundary moves, and flips lanes to the target lane end", async () => {
		createSession();
		const { running } = await blockSession();
		await session.steer("s1");
		await session.steer("s2");
		await session.followUp("f1");
		expect(mutate("steering", 0, "s1", { type: "move", direction: 1 })).toBe("applied");
		expect(queue().steering).toEqual(["s2", "s1"]);
		expect(mutate("steering", 1, "s1", { type: "move", direction: 1 })).toBe("rejected");
		expect(mutate("steering", 0, "s2", { type: "move", direction: -1 })).toBe("rejected");
		expect(mutate("steering", 0, "s2", { type: "replace", text: "s2 flipped", lane: "followUp" })).toBe("applied");
		expect(queue()).toEqual({ steering: ["s1"], followUp: ["f1", "s2 flipped"] });
		expect(mutate("followUp", 1, "s2 flipped", { type: "replace", text: "s2 flipped", lane: "steering" })).toBe(
			"applied",
		);
		expect(queue()).toEqual({ steering: ["s1", "s2 flipped"], followUp: ["f1"] });
		await session.abort();
		await running.catch(() => {});
	});

	it("replaces turn text in place across the image tri-state and rebuilds content and records", async () => {
		createSession();
		const { running } = await blockSession();
		const original: ImageContent = { type: "image", data: "original", mimeType: "image/png" };
		await session.prompt("edit me [image #1]", {
			streamingBehavior: "steer",
			images: [original],
			content: [{ type: "text", text: "edit me" }, { type: "text", text: " [image #1]" }, original],
		});
		const edit = (expected: string, text: string, images?: ImageContent[]) =>
			mutate("steering", 0, expected, { type: "replace", text, images, lane: "steering" });
		// images undefined: preserve images, swap the text block, keep non-text blocks.
		expect(edit("edit me [image #1]", "edited")).toBe("applied");
		expect(payloadOf("edited")).toMatchObject({
			images: [original],
			content: [{ type: "text", text: "edited" }, original],
		});
		expect(primaryContent("edited")).toEqual([{ type: "text", text: "edited" }, original]);
		// explicit images: content rebuilt from text + clones.
		const replacement: ImageContent = { type: "image", data: "replacement", mimeType: "image/png" };
		expect(edit("edited", "re-imaged", [replacement])).toBe("applied");
		const reimaged = payloadOf("re-imaged");
		expect(reimaged).toMatchObject({
			images: [replacement],
			content: [{ type: "text", text: "re-imaged" }, replacement],
		});
		expect(primaryContent("re-imaged")).toEqual([{ type: "text", text: "re-imaged" }, replacement]);
		// empty images: clear to a bare text block.
		expect(edit("re-imaged", "plain", [])).toBe("applied");
		const cleared = payloadOf("plain");
		expect(cleared).not.toHaveProperty("images");
		expect(cleared?.kind === "turn" ? cleared.content : undefined).toEqual([{ type: "text", text: "plain" }]);
		expect(primaryContent("plain")).toEqual([{ type: "text", text: "plain" }]);
		await session.abort();
		await running.catch(() => {});
	});

	it("validates session command text and protects accepted agent messages", async () => {
		createSession();
		const { running } = await blockSession();
		await session.prompt("/compact focus on tools", { streamingBehavior: "steer" });
		await session.acceptAgentMessagePrompt("agent item", { streamingBehavior: "followUp" });
		expect(queue()).toEqual({ steering: ["/compact focus on tools"], followUp: ["agent item"] });
		expect(
			mutate("steering", 0, "/compact focus on tools", { type: "replace", text: "plain", lane: "steering" }),
		).toBe("invalid");
		expect(
			mutate("steering", 0, "/compact focus on tools", {
				type: "replace",
				text: "/compact revised focus",
				lane: "followUp",
			}),
		).toBe("applied");
		expect(queue().steering).toEqual([]);
		expect(payloadOf("/compact revised focus")).toMatchObject({
			kind: "session_command",
			command: { name: "compact", args: "revised focus" },
		});
		expect(mutate("followUp", 0, "agent item", { type: "replace", text: "hijacked", lane: "followUp" })).toBe(
			"rejected",
		);
		expect(mutate("followUp", 0, "agent item", { type: "delete" })).toBe("applied");
		expect(queue().followUp).toEqual(["/compact revised focus"]); // flipped command appended to the lane end
		await session.abort();
		await running.catch(() => {});
	});

	it("resumes suspended queued work after a successful replace", async () => {
		createSession();
		const { running } = await blockSession();
		await session.followUp("f1");
		await session.abort();
		await running.catch(() => {});
		expect(session.isQueuedWorkSuspended).toBe(true);
		expect(queue().followUp).toEqual(["f1"]); // queue survives abort
		expect(mutate("followUp", 0, "f1", { type: "replace", text: "f1 edited", lane: "followUp" })).toBe("applied");
		expect(session.isQueuedWorkSuspended).toBe(false);
		await session.abort();
	});

	it("settles the completion of a deleted promptAndWait turn", async () => {
		createSession();
		const { running } = await blockSession();
		const waiting = session.promptAndWait("waited", { streamingBehavior: "steer" });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(queue().steering).toEqual(["waited"]);
		expect(mutate("steering", 0, "waited", { type: "delete" })).toBe("applied");
		await expect(waiting).rejects.toThrow("Queued prompt was deleted before delivery.");
		await session.abort();
		await running.catch(() => {});
	});

	it("rejects replacing an injected custom-message turn but allows deleting it", async () => {
		createSession();
		const { running } = await blockSession();
		const injected = (
			session as unknown as {
				_promptInjectedMessage(
					text: string,
					message: unknown,
					options?: { streamingBehavior?: "steer" },
				): Promise<void>;
			}
		)._promptInjectedMessage(
			"injected",
			{ role: "custom", customType: "test", content: "injected", display: true, timestamp: Date.now() },
			{ streamingBehavior: "steer" },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const [expected] = queue().steering;
		expect(expected).toBeDefined();
		expect(mutate("steering", 0, expected!, { type: "replace", text: "rewritten", lane: "steering" })).toBe(
			"rejected",
		);
		expect(mutate("steering", 0, expected!, { type: "delete" })).toBe("applied");
		await session.abort();
		await Promise.allSettled([running, injected]);
	});

	it("updates the wake policy when flipping lanes", async () => {
		createSession();
		const { running } = await blockSession();
		await session.followUp("f1");
		expect(mutate("followUp", 0, "f1", { type: "replace", text: "f1", lane: "steering" })).toBe("applied");
		const recovered = session.getSessionActionRecoverySnapshot().actions.find((a) => a.payload.text === "f1");
		expect(recovered?.delivery).toBe("next_turn_boundary");
		expect(recovered?.wake).toBe("on_lower_boundary");
		await session.abort();
		await running.catch(() => {});
	});
});
