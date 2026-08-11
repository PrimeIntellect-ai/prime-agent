import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import type { RlmTokenBudgetConfig } from "../src/core/rlm-token-budget.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const lastMessage = context.messages[context.messages.length - 1] as AgentMessage | undefined;
	if (!lastMessage) return "";
	if (lastMessage.role !== "user") return "";
	if (typeof lastMessage.content === "string") return lastMessage.content;
	return (lastMessage.content as TextContent[])
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function usage(input = 7, output = 3, cacheWrite = 0, cacheRead = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistantMessage(text) }));
	return stream;
}

function grantCapturingHost(record: (options: CreateRlmSubagentRuntimeOptions) => void): SubagentRuntimeHost {
	return {
		createRlmSubagentRuntime: async (options) => {
			record(options);
			throw new Error("stop after capturing the grant");
		},
		deleteRlmSubagentRuntime: async () => undefined,
	};
}

describe("probe: rlm token budget", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-probe-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		options: {
			depth?: number;
			maxDepth?: number;
			streamFn?: StreamFn;
			subagentRuntimeHost?: SubagentRuntimeHost;
			sessionManager?: SessionManager;
			settingsManager?: SettingsManager;
			tokenBudget?: RlmTokenBudgetConfig;
			tokenAllowance?: number;
			rlmSessionDir?: string;
		} = {},
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = options.settingsManager ?? SettingsManager.create(tempDir, tempDir);
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: options.streamFn ?? ((_model, context) => streamAnswer(`child answer: ${userText(context)}`)),
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({}),
			subagentRuntimeHost: options.subagentRuntimeHost,
			rlmDepth: options.depth,
			rlmMaxDepth: options.maxDepth,
			rlmTokenBudget: options.tokenBudget,
			rlmTokenAllowance: options.tokenAllowance,
			rlmSessionDir: options.rlmSessionDir,
		});
		return session;
	}

	it("PROBE 1: a funded subagent's own spend is not deducted from the pool it grants", async () => {
		const captured: Array<number | undefined> = [];
		const child = createSession({
			depth: 1,
			maxDepth: 3,
			tokenBudget: { totalTokens: 100_000 },
			tokenAllowance: 100_000,
			subagentRuntimeHost: grantCapturingHost((o) => captured.push(o.rlmTokenAllowance)),
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: assistantMessage("spent", usage(45_000, 45_000)) }),
				);
				return stream;
			},
		});

		await child.prompt("burn most of the pot");
		await child.agent.waitForIdle();
		const afterBurn = child.getRlmTokenBudgetStatus();
		console.log("after burn:", JSON.stringify(afterBurn));

		await child.runRlmChild("grandchild");
		await vi.waitFor(() => expect(captured).toHaveLength(1));
		console.log("grandchild grant:", captured[0]);
		console.log("after grant:", JSON.stringify(child.getRlmTokenBudgetStatus()));
		// Invariant: subtree total <= 100_000, so the grant may not exceed 100_000 - 90_000.
		expect(captured[0]).toBeLessThanOrEqual(10_000);
	});

	it("PROBE 2: branch navigation refills a pool whose grants are still live", async () => {
		const captured: Array<number | undefined> = [];
		const root = createSession({
			maxDepth: 3,
			tokenBudget: { totalTokens: 1000 },
			subagentRuntimeHost: grantCapturingHost((o) => captured.push(o.rlmTokenAllowance)),
		});

		await root.prompt("hello");
		await root.agent.waitForIdle();
		const branchBefore = root.sessionManager.getBranch();
		const target = branchBefore.find((entry) => entry.type === "message");
		if (!target) throw new Error("no message entry");

		await root.runRlmChild("first", { token_budget: 1000 });
		await vi.waitFor(() => expect(captured).toHaveLength(1));
		console.log("after first grant:", JSON.stringify(root.getRlmTokenBudgetStatus()));
		expect(captured[0]).toBe(1000);

		await root.navigateTree(target.id, { summarize: false });
		console.log("after navigate:", JSON.stringify(root.getRlmTokenBudgetStatus()));

		// The 1000 tokens are still committed to the live child, so nothing may be granted again.
		await expect(root.runRlmChild("second", { token_budget: 1000 })).rejects.toThrow(/exhausted/);
	});

	it("PROBE 3: daemon rehydration subtracts delegated tokens twice", async () => {
		const captured: Array<number | undefined> = [];
		const sessionsDir = join(tempDir, "child-sessions");
		const manager = SessionManager.create(tempDir, sessionsDir);
		const child = createSession({
			depth: 1,
			maxDepth: 3,
			sessionManager: manager,
			tokenBudget: { totalTokens: 1000 },
			tokenAllowance: 1000,
			subagentRuntimeHost: grantCapturingHost((o) => captured.push(o.rlmTokenAllowance)),
		});
		await child.runRlmChild("grandchild", { token_budget: 400 });
		await vi.waitFor(() => expect(captured).toHaveLength(1));
		const beforeStatus = child.getRlmTokenBudgetStatus();
		console.log("live child status:", JSON.stringify(beforeStatus));
		expect(beforeStatus.allowanceTokens).toBe(600);
		child.sessionManager.flushNow();
		const sessionFile = child.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("missing child session file");
		child.dispose();

		// daemon-mode.ts:2248 records rlmTokenAllowance: budget.allowanceTokens for a completed child,
		// daemon-mode.ts:2779 feeds it back as rlmTokenAllowance on rehydration.
		const reopened = SessionManager.open(sessionFile, sessionsDir);
		const rehydrated = createSession({
			depth: 1,
			maxDepth: 3,
			sessionManager: reopened,
			tokenBudget: { totalTokens: 1000 },
			tokenAllowance: beforeStatus.allowanceTokens ?? undefined,
		});
		const afterStatus = rehydrated.getRlmTokenBudgetStatus();
		console.log("rehydrated status:", JSON.stringify(afterStatus));
		expect(afterStatus.allowanceTokens).toBe(600);
	});

	it("PROBE 4: depth 0 is never stopped by the budget", async () => {
		let turns = 0;
		const root = createSession({
			maxDepth: 3,
			tokenBudget: { totalTokens: 5 },
			streamFn: () => {
				turns++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(`turn ${turns}`, usage(500, 500)),
					}),
				);
				return stream;
			},
		});
		await root.prompt("one");
		await root.agent.waitForIdle();
		await root.prompt("two");
		await root.agent.waitForIdle();
		const status = root.getRlmTokenBudgetStatus();
		console.log("root status:", JSON.stringify(status), "turns", turns);
		expect(status.exhausted).toBe(false);
		expect(turns).toBe(2);
		expect(root.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
	});

	it("PROBE 5: a spawn that fails after the reservation destroys the grant", async () => {
		const root = createSession({
			maxDepth: 3,
			tokenBudget: { totalTokens: 1000 },
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("model server unreachable");
				},
				deleteRlmSubagentRuntime: async () => undefined,
			},
		});
		await root.runRlmChild("doomed", { token_budget: 1000 });
		await vi.waitFor(() => expect(root.getRlmTokenBudgetStatus().delegatedTokens).toBe(1000));
		console.log("after failed spawn:", JSON.stringify(root.getRlmTokenBudgetStatus()));
		// The child never existed and never spent a token, so a retry should still be fundable.
		await expect(root.runRlmChild("retry", { token_budget: 1000 })).resolves.toBeDefined();
	});
	it("PROBE 6: a funded subagent can disable its own cap with /rlm-token-budget off", async () => {
		let turns = 0;
		const child = createSession({
			depth: 1,
			maxDepth: 3,
			tokenBudget: { totalTokens: 1000 },
			tokenAllowance: 100,
			streamFn: () => {
				turns++;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() =>
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(`turn ${turns}`, usage(400, 400)),
					}),
				);
				return stream;
			},
		});
		expect(child.getRlmTokenBudgetStatus().allowanceTokens).toBe(100);

		// Exactly what `/rlm-token-budget off` and the daemon `set_rlm_token_budget` command do.
		await child.setRlmTokenBudget(undefined);
		console.log("child after off:", JSON.stringify(child.getRlmTokenBudgetStatus()));

		await child.prompt("keep going");
		await child.agent.waitForIdle();
		await child.prompt("and again");
		await child.agent.waitForIdle();
		console.log("child after two 800-token turns:", JSON.stringify(child.getRlmTokenBudgetStatus()), "turns", turns);
		// The parent reserved 100 tokens; the child must not be able to lift its own cap.
		expect(child.getRlmTokenBudgetStatus().allowanceTokens).toBe(100);
	});

	it("PROBE 7: an unfunded grandchild is spawnable after the subagent disables its budget", async () => {
		const captured: Array<number | undefined> = [];
		const child = createSession({
			depth: 1,
			maxDepth: 3,
			tokenBudget: { totalTokens: 1000 },
			tokenAllowance: 100,
			subagentRuntimeHost: grantCapturingHost((o) => captured.push(o.rlmTokenAllowance)),
		});
		await child.setRlmTokenBudget(undefined);
		await child.runRlmChild("grandchild", { token_budget: 5_000_000 });
		await vi.waitFor(() => expect(captured).toHaveLength(1));
		console.log("grandchild grant after off:", captured[0]);
		expect(captured[0]).toBeLessThanOrEqual(100);
	});

	it("PROBE 8: pool arithmetic at the safe-integer boundary", async () => {
		const captured: Array<number | undefined> = [];
		const root = createSession({
			maxDepth: 3,
			tokenBudget: { totalTokens: Number.MAX_SAFE_INTEGER },
			subagentRuntimeHost: grantCapturingHost((o) => captured.push(o.rlmTokenAllowance)),
		});
		await root.runRlmChild("huge", { token_budget: Number.MAX_SAFE_INTEGER });
		await vi.waitFor(() => expect(captured).toHaveLength(1));
		console.log("max-safe grant:", captured[0], JSON.stringify(root.getRlmTokenBudgetStatus()));
		expect(captured[0]).toBe(Number.MAX_SAFE_INTEGER);
		await expect(root.runRlmChild("another", { token_budget: 1 })).rejects.toThrow(/exhausted/);
	});
	it("PROBE 9: the daemon registry reader drops entries whose rlmTokenAllowance is 0", async () => {
		const { AgentDaemon } = await import("../src/modes/daemon/daemon-mode.js");
		const daemon = new AgentDaemon(join(tempDir, "probe.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: join(tempDir, "sessions") },
			createRuntime: (async () => {
				throw new Error("unused");
			}) as never,
		});
		const internals = daemon as unknown as {
			readLatestRlmSubagentRegistryPath(
				path: string,
				throwOnReadError?: boolean,
			): Promise<Array<{ childId: string; status: string; rlmTokenAllowance?: number }>>;
		};
		const registry = join(tempDir, "rlm-subagents.jsonl");
		const row = (extra: Record<string, unknown>) =>
			JSON.stringify({
				type: "rlm_subagent",
				childId: "child-1",
				sessionName: "worker",
				sessionDir: join(tempDir, "child"),
				sessionFile: join(tempDir, "child", "session.jsonl"),
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmTokenBudget: { totalTokens: 1000 },
				createdAt: 1,
				updatedAt: "2026-01-01T00:00:00.000Z",
				...extra,
			});
		// A child granted 400 tokens that delegated all 400 completes with allowanceTokens 0,
		// which daemon-mode.ts:2248 writes verbatim into the completion row.
		writeFileSync(
			registry,
			`${row({ status: "running", rlmTokenAllowance: 400 })}\n${row({ status: "completed", rlmTokenAllowance: 0 })}\n`,
		);
		const entries = await internals.readLatestRlmSubagentRegistryPath(registry);
		console.log(
			"registry entries:",
			JSON.stringify(entries.map((e) => ({ status: e.status, allowance: e.rlmTokenAllowance }))),
		);
		expect(entries).toHaveLength(1);
		expect(entries[0]?.status).toBe("completed");
	});
	it("PROBE 10: a refused spawn does not debit, and a flushed grant survives resume", async () => {
		const sessionsDir = join(tempDir, "resume-sessions");
		const manager = SessionManager.create(tempDir, sessionsDir);
		const root = createSession({
			maxDepth: 3,
			sessionManager: manager,
			tokenBudget: { totalTokens: 1000 },
			subagentRuntimeHost: grantCapturingHost(() => {}),
		});
		await expect(root.runRlmChild("nope", { token_budget: [10, 2000] })).resolves.toBeDefined();
		expect(root.getRlmTokenBudgetStatus().delegatedTokens).toBe(1000);
		// A refused spawn must not move the counter.
		await expect(root.runRlmChild("refused", { token_budget: 10 })).rejects.toThrow(/exhausted/);
		expect(root.getRlmTokenBudgetStatus().delegatedTokens).toBe(1000);

		root.sessionManager.flushNow();
		const file = root.sessionManager.getSessionFile();
		if (!file) throw new Error("missing session file");
		const onDisk = readFileSync(file, "utf8");
		console.log("spend rows on disk:", onDisk.split("\n").filter((l) => l.includes("rlm_token_budget_spend")).length);
		root.dispose();
		const resumed = createSession({
			maxDepth: 3,
			sessionManager: SessionManager.open(file, sessionsDir),
			tokenBudget: { totalTokens: 1000 },
		});
		console.log("resumed root:", JSON.stringify(resumed.getRlmTokenBudgetStatus()));
		expect(resumed.getRlmTokenBudgetStatus().delegatedTokens).toBe(1000);
		expect(resumed.getRlmTokenBudgetStatus().subtreePoolTokens).toBe(0);
	});

	it("PROBE 11: one NaN usage record permanently disables the cap", async () => {
		let turns = 0;
		const child = createSession({
			depth: 1,
			maxDepth: 3,
			tokenBudget: { totalTokens: 100 },
			tokenAllowance: 100,
			streamFn: () => {
				turns++;
				const stream = createAssistantMessageEventStream();
				const broken = turns === 1 ? usage(Number.NaN, 0) : usage(500, 500);
				queueMicrotask(() =>
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`turn ${turns}`, broken) }),
				);
				return stream;
			},
		});
		await child.prompt("first");
		await child.agent.waitForIdle();
		await child.prompt("second");
		await child.agent.waitForIdle();
		const status = child.getRlmTokenBudgetStatus();
		console.log("after NaN usage:", JSON.stringify(status), "turns", turns);
		expect(status.exhausted).toBe(true);
	});
	it("PROBE 12: a synchronous spawn failure after the debit leaks the grant", async () => {
		const rlmDir = join(tempDir, "blocked-rlm-dir");
		const root = createSession({
			maxDepth: 3,
			tokenBudget: { totalTokens: 1000 },
			rlmSessionDir: rlmDir,
		});
		// Any fs failure while creating the child session dir happens after the debit.
		rmSync(rlmDir, { recursive: true, force: true });
		writeFileSync(rlmDir, "not a directory");
		await expect(root.runRlmChild("child", { token_budget: [10, 500] })).rejects.toThrow();
		console.log("after sync failure:", JSON.stringify(root.getRlmTokenBudgetStatus()));
		expect(root.getRlmTokenBudgetStatus().delegatedTokens).toBe(0);
	});
});
