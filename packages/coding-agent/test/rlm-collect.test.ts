import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createRlmCollectHostHandler, type SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getCodingAgentFixtureModel } from "./fixture-models.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getCodingAgentFixtureModel("anthropic", "claude-sonnet-4-5");

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

	function makeSession(
		options: { subagentRuntimeHost?: SubagentRuntimeHost; rlmSessionDir?: string } = {},
	): AgentSession {
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
			subagentRuntimeHost: options.subagentRuntimeHost,
			rlmSessionDir: options.rlmSessionDir,
		});
	}

	/** Register a daemon-hydrated run-less child under `name`, as the daemon does. */
	function registerRunlessChild(root: AgentSession, childId: string, name: string): AgentSession {
		const retainedChild = makeSession({ rlmSessionDir: join(tempDir, childId) });
		session = root;
		retainedChild.setSessionName(name);
		expect(root.registerRlmChildSession(childId, retainedChild)).toBe(true);
		return retainedChild;
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

	it("collects every direct child when no targets are given and only the selected child when targeted", async () => {
		session = makeSession();
		const first = await session.runRlmChild("first task", { name: "worker-a" });
		const second = await session.runRlmChild("second task", { name: "worker-b" });

		const all = await session.collectRlmChildren([], 10_000);
		const ids = all.results.map((entry) => entry.rlm_child_id).sort();
		expect(ids).toEqual([first.rlm_child_id, second.rlm_child_id].sort());
		expect(all.results.every((entry) => entry.settled && entry.status === "done")).toBe(true);

		const targeted = await session.collectRlmChildren([first.rlm_child_id], 0);
		expect(targeted.results.map((entry) => entry.rlm_child_id)).toEqual([first.rlm_child_id]);
		const byName = await session.collectRlmChildren(["worker-b"], 0);
		expect(byName.results.map((entry) => entry.rlm_child_id)).toEqual([second.rlm_child_id]);
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

	it("keeps deleted children's cancelled envelopes after their delete receipts", async () => {
		session = makeSession();
		// A settled child takes the no-active-run delete path; a daemon-hydrated
		// run-less child exercises the registry-identity tombstone.
		const done = await session.runRlmChild("done shard", { name: "done-worker" });
		await session.collectRlmChildren([done.rlm_child_id], 10_000);
		registerRunlessChild(session, "runless-child", "runless-worker");
		await expect(session.deleteRlmSubagent(done.rlm_child_id)).resolves.toMatchObject({
			subagent: { rlm_child_id: done.rlm_child_id },
		});
		await expect(session.deleteRlmSubagent("runless-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: "runless-child" },
		});
		// The receipt promises a cancelled envelope even though both runs are gone.
		const byName = await session.collectRlmChildren(["done-worker"], 0);
		expect(byName.results[0]).toMatchObject({
			rlm_child_id: done.rlm_child_id,
			status: "cancelled",
			settled: true,
			error: "Deleted by parent orchestrator",
		});
		const byId = await session.collectRlmChildren(["runless-child"], 0);
		expect(byId.results[0]).toMatchObject({
			rlm_child_id: "runless-child",
			session_name: "runless-worker",
			status: "cancelled",
			settled: true,
		});
	});

	// The replacement's delete failed, so it never got a receipt and still owns the name.
	it("keeps a failed-cleanup run-less replacement off the deleted generation's cancelled envelope", async () => {
		const hostedChildren: AgentSession[] = [];
		const makeHostedChild = (): AgentSession => {
			const root = session;
			const child = makeSession();
			session = root;
			hostedChildren.push(child);
			return child;
		};
		const root = makeSession({
			subagentRuntimeHost: {
				// Only the run-less replacement's delete fails.
				createRlmSubagentRuntime: async () => ({ session: makeHostedChild() }),
				deleteRlmSubagentRuntime: async (childId: string) => {
					if (childId === "runless-failed") throw new Error("injected cleanup failure");
				},
			},
		});
		session = root;
		const first = await root.runRlmChild("first shard", { name: "reused-worker" });
		// Settle and delete the first generation: its tombstone is the stale envelope.
		await root.collectRlmChildren([first.rlm_child_id], 10_000);
		await root.deleteRlmSubagent(first.rlm_child_id);

		registerRunlessChild(root, "runless-failed", "reused-worker");
		await expect(root.deleteRlmSubagent("reused-worker")).rejects.toThrow("injected cleanup failure");

		// The replacement still owns the name: a same-name spawn stays blocked.
		await expect(root.runRlmChild("blocked shard", { name: "reused-worker" })).rejects.toThrow(
			'Agent name "reused-worker" is unavailable',
		);
		// Resident and name-bound, it must keep the deleted generation's tombstone silent.
		await expect(root.collectRlmChildren(["reused-worker"], 0)).rejects.toThrow(
			'No direct RLM child matches "reused-worker" in the current parent session',
		);
		const byOldId = await root.collectRlmChildren([first.rlm_child_id], 0);
		expect(byOldId.results).toHaveLength(1);
		expect(byOldId.results[0]).toMatchObject({
			rlm_child_id: first.rlm_child_id,
			status: "cancelled",
			settled: true,
		});
		for (const hosted of hostedChildren) hosted.dispose();
	});
});
