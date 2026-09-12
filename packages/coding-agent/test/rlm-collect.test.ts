import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createRlmCollectHostHandler } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

describe("rlm.collect typed fan-in", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-collect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function makeSession(): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: (_model, context) => streamAnswer(`child answer: ${userText(context)}`),
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
	}

	it("returns a typed envelope once the child settles", async () => {
		session = makeSession();
		const handle = await session.runRlmChild("compute the answer", { name: "worker-a" });

		const results = await session.collectRlmChildren([handle.rlm_child_id], 10_000);
		expect(results.results).toHaveLength(1);
		const entry = results.results[0];
		expect(entry.rlm_child_id).toBe(handle.rlm_child_id);
		expect(entry.session_name).toBe("worker-a");
		expect(entry.status).toBe("done");
		expect(entry.settled).toBe(true);
		expect(entry.answer_preview).toContain("child answer");
		expect(entry.error).toBeUndefined();
	});

	it("collects every direct child when no targets are given", async () => {
		session = makeSession();
		const first = await session.runRlmChild("first task", { name: "worker-a" });
		const second = await session.runRlmChild("second task", { name: "worker-b" });

		const results = await session.collectRlmChildren([], 10_000);
		const ids = results.results.map((entry) => entry.rlm_child_id).sort();
		expect(ids).toEqual([first.rlm_child_id, second.rlm_child_id].sort());
		expect(results.results.every((entry) => entry.settled && entry.status === "done")).toBe(true);
	});

	it("re-collects a settled child after terminal cleanup", async () => {
		session = makeSession();
		const handle = await session.runRlmChild("compute the answer", { name: "worker-a" });
		// Wait for settlement: the terminal path removes the settled run from
		// _activeRlmChildRuns while its envelope stays retained until deleted.
		const settled = await session.collectRlmChildren([handle.rlm_child_id], 10_000);
		expect(settled.results[0]?.settled).toBe(true);

		const byId = await session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(byId.results).toHaveLength(1);
		expect(byId.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);
		expect(byId.results[0]?.status).toBe("done");
		expect(byId.results[0]?.settled).toBe(true);
		expect(byId.results[0]?.answer_preview).toContain("child answer");

		const byName = await session.collectRlmChildren(["worker-a"], 0);
		expect(byName.results[0]?.rlm_child_id).toBe(handle.rlm_child_id);

		const all = await session.collectRlmChildren([], 0);
		expect(all.results.map((entry) => entry.rlm_child_id)).toContain(handle.rlm_child_id);
	});

	it("returns only the selected child from a targeted collect", async () => {
		session = makeSession();
		const first = await session.runRlmChild("first task", { name: "worker-a" });
		const second = await session.runRlmChild("second task", { name: "worker-b" });
		await session.collectRlmChildren([], 10_000);

		const targeted = await session.collectRlmChildren([first.rlm_child_id], 0);
		expect(targeted.results.map((entry) => entry.rlm_child_id)).toEqual([first.rlm_child_id]);
		const byName = await session.collectRlmChildren(["worker-b"], 0);
		expect(byName.results.map((entry) => entry.rlm_child_id)).toEqual([second.rlm_child_id]);
	});

	it("returns current snapshots on timeout without rejecting", async () => {
		session = makeSession();
		const handle = await session.runRlmChild("slow task", { name: "worker-a" });
		// The child runs to completion quickly in this stub; a zero timeout is
		// the guaranteed non-blocking read used for polling.
		const snapshot = await session.collectRlmChildren([handle.rlm_child_id], 0);
		expect(snapshot.results).toHaveLength(1);
		expect(snapshot.results[0].rlm_child_id).toBe(handle.rlm_child_id);
		expect(["queued", "running", "done"]).toContain(snapshot.results[0].status);
	});

	it("throws for unknown selectors and keeps ambiguity detection", async () => {
		session = makeSession();
		await expect(session.collectRlmChildren(["no-such-child"], 0)).rejects.toThrow(
			'No direct RLM child matches "no-such-child"',
		);
	});

	it("validates host payload shape", async () => {
		const handler = createRlmCollectHostHandler(async () => ({ results: [] }));
		await expect(handler({ targets: "worker-a" })).rejects.toThrow("targets must be an array");
		await expect(handler({ targets: [""] })).rejects.toThrow("non-empty strings");
		await expect(handler({ timeout_ms: -1 })).rejects.toThrow("non-negative integer");
		await expect(handler({ timeout_ms: "soon" })).rejects.toThrow("non-negative integer");
		// Node clamps setTimeout delays above 2^31-1 to 1ms, so an oversized
		// timeout must be rejected instead of returning an immediate snapshot.
		await expect(handler({ timeout_ms: 2_147_483_648 })).rejects.toThrow("2147483647");
		const ok = await handler({ targets: ["worker-a"], timeout_ms: 5 });
		expect(ok).toEqual({ results: [] });
		const defaults = await handler({});
		expect(defaults).toEqual({ results: [] });
	});
});
