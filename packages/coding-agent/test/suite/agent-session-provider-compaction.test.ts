import { readFileSync } from "node:fs";
import {
	type AssistantMessage,
	type CompactFunction,
	type Context,
	fauxAssistantMessage,
	getApiProvider,
	getModel,
	type ProviderCompactionCheckpoint,
	registerApiProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProviderCheckpoint } from "../../src/core/compaction/checkpoint.js";
import {
	DEFAULT_COMPACTION_SETTINGS,
	generateSummary,
	prepareCompaction,
	shouldCompactForModel,
} from "../../src/core/compaction/compaction.js";
import { convertToLlm } from "../../src/core/messages.js";
import { requestWithProviderRetry } from "../../src/core/provider-retry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

const harnesses: Harness[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	while (harnesses.length) harnesses.pop()?.cleanup();
});

async function seededHarness(): Promise<Harness> {
	const harness = await createHarness({
		persistSession: true,
		models: [{ id: "faux-1" }, { id: "faux-2", contextWindow: 8000 }],
		settings: {
			compaction: { enabled: false, keepRecentTokens: 1 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
		},
	});
	harnesses.push(harness);
	harness.setResponses([fauxAssistantMessage("First response"), fauxAssistantMessage("Second response")]);
	await harness.session.prompt("Remember original project paths");
	await harness.session.prompt("Do the second task");
	return harness;
}

function checkpointFor(harness: Harness): ProviderCompactionCheckpoint {
	const model = harness.session.model!;
	return {
		version: 1,
		provider: model.provider,
		api: model.api,
		model: model.id,
		baseUrl: model.baseUrl,
		estimatedTokens: 100,
		items: [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "Retained user request" }] },
			{ type: "compaction", id: "cmp_test", encrypted_content: "opaque" },
		],
	};
}

function installCompactor(harness: Harness, compact: CompactFunction): void {
	const provider = getApiProvider(harness.session.model!.api)!;
	registerApiProvider({ ...provider, compact });
}

describe("durable provider compaction", () => {
	it.each(["openai", "openai-codex"] as const)(
		"honors Astra Fast mode and the %s compaction budget",
		async (provider) => {
			const model = getModel(provider, "gpt-6-astra");
			const harness = await createHarness({
				api: model.api,
				provider,
				models: [{ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
			});
			harnesses.push(harness);
			harness.session.setServiceTier("priority");
			expect(harness.session.serviceTier).toBe("priority");
			const threshold = provider === "openai" ? 905_616 : 244_800;
			expect(shouldCompactForModel(threshold, model, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
			expect(shouldCompactForModel(threshold + 1, model, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
			const assistant: AssistantMessage = {
				...fauxAssistantMessage("Large successful response"),
				api: model.api,
				provider,
				model: model.id,
				usage: {
					input: threshold + 1,
					output: 1,
					totalTokens: threshold + 2,
					cacheRead: 0,
					cacheWrite: 0,
					cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 },
				},
			};
			harness.session.agent.state.messages = [assistant];
			const internals = harness.session as unknown as {
				_checkCompaction: (message: AssistantMessage) => Promise<boolean>;
				_runAutoCompaction: (reason: string, retry: boolean) => Promise<boolean>;
			};
			const autoCompact = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(true);
			await internals._checkCompaction(assistant);
			expect(autoCompact).toHaveBeenCalledWith("threshold", false);
		},
	);

	it("rejects an incompatible provider result before replacing history", async () => {
		const harness = await seededHarness();
		installCompactor(harness, async () => ({ checkpoint: { ...checkpointFor(harness), model: "wrong-model" } }));
		await expect(harness.session.compact()).rejects.toThrow(/incompatible checkpoint/);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
	});
	it("persists the entire window, resumes it, and continues without duplicating retained history", async () => {
		const harness = await seededHarness();
		const checkpoint = checkpointFor(harness);
		const compact = vi.fn<CompactFunction>().mockResolvedValue({ checkpoint });
		installCompactor(harness, compact);
		await harness.session.compact("Keep paths");
		expect(compact).toHaveBeenCalledOnce();
		expect(compact.mock.calls[0][1].systemPrompt).toBe(harness.session.agent.state.systemPrompt);
		expect(
			compact.mock.calls[0][1].messages.some((message) =>
				getMessageText(message).includes("original project paths"),
			),
		).toBe(true);
		expect(compact.mock.calls[0][2]).toMatchObject({ customInstructions: "Keep paths" });
		const marker = harness.session.messages.find((message) => message.role === "compactionSummary");
		expect(marker).toMatchObject({ providerContext: checkpoint, retainedMessageCount: 0 });
		expect(
			harness.session.messages.filter((message) => message.role === "assistant" || message.role === "user"),
		).toHaveLength(0);
		const reopened = SessionManager.open(harness.sessionManager.getSessionFile()!);
		expect(convertToLlm(reopened.buildSessionContext(harness.session.model).messages)[0]).toMatchObject({
			providerContext: checkpoint,
		});
		expect(readFileSync(harness.sessionManager.getSessionFile()!, "utf8")).toContain(
			"Remember original project paths",
		);
		let resumedContext: Context | undefined;
		harness.setResponses([
			(context) => {
				resumedContext = context;
				return fauxAssistantMessage("Still working");
			},
		]);
		await harness.session.prompt("Continue after compaction");
		expect(resumedContext?.messages[0]).toMatchObject({ providerContext: checkpoint });
		expect(
			resumedContext?.messages.filter((message) => getMessageText(message).includes("Continue after compaction")),
		).toHaveLength(1);
		await harness.session.compact();
		expect(compact.mock.calls[1][1].messages[0]).toMatchObject({ providerContext: checkpoint });
	});

	it("rebuilds original history for a different model or endpoint and can restore the checkpoint", async () => {
		const harness = await seededHarness();
		const checkpoint = checkpointFor(harness);
		installCompactor(harness, async () => ({ checkpoint }));
		await harness.session.compact();
		await harness.session.setModel(harness.getModel("faux-2")!);
		expect(
			harness.session.messages.some((message) => getMessageText(message).includes("original project paths")),
		).toBe(true);
		expect(
			convertToLlm(harness.session.messages).some((message) => message.role === "user" && message.providerContext),
		).toBe(false);
		await harness.session.setModel(harness.getModel("faux-1")!);
		expect(convertToLlm(harness.session.messages)[0]).toMatchObject({ providerContext: checkpoint });
		const changedEndpoint = harness.sessionManager.buildSessionContext({
			...harness.session.model!,
			baseUrl: "https://other.example",
		});
		expect(
			changedEndpoint.messages.some((message) => getMessageText(message).includes("original project paths")),
		).toBe(true);
	});

	it("ignores unknown checkpoint versions and never uses the display label as a local summary", async () => {
		const harness = await seededHarness();
		const firstId = harness.sessionManager.getBranch().find((entry) => entry.type === "message")!.id;
		harness.sessionManager.appendCompaction("Display label", firstId, 5000, {
			providerCheckpoint: { ...checkpointFor(harness), version: 2 },
		});
		harness.sessionManager.appendMessage({ role: "user", content: "New work", timestamp: Date.now() });
		const restored = harness.sessionManager.buildSessionContext(harness.session.model);
		expect(restored.messages.some((message) => getMessageText(message).includes("original project paths"))).toBe(
			true,
		);
		const preparation = prepareCompaction(harness.sessionManager.getBranch(), {
			enabled: true,
			reserveTokens: 1000,
			keepRecentTokens: 1,
		});
		expect(preparation?.previousSummary).toBeUndefined();
	});

	it("falls back to the existing local summarizer when a provider reports unsupported", async () => {
		const harness = await seededHarness();
		installCompactor(harness, async () => undefined);
		harness.setResponses([fauxAssistantMessage("Local history summary"), fauxAssistantMessage("Local turn summary")]);
		const result = await harness.session.compact();
		expect(result.summary).toContain("Local history summary");
		expect(getProviderCheckpoint(result.details)).toBeUndefined();
	});

	it("retries transient unary failures before committing one checkpoint", async () => {
		const harness = await seededHarness();
		const compact = vi
			.fn<CompactFunction>()
			.mockRejectedValueOnce(Object.assign(new Error("busy"), { status: 503, retryAfterMs: 1 }))
			.mockResolvedValue({ checkpoint: checkpointFor(harness) });
		installCompactor(harness, compact);
		await harness.session.compact();
		expect(compact).toHaveBeenCalledTimes(2);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("preserves the live and saved history when cancelled", async () => {
		const harness = await seededHarness();
		const compact = vi.fn<CompactFunction>().mockImplementation(
			(_model, _context, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
						once: true,
					});
				}),
		);
		installCompactor(harness, compact);
		const pending = harness.session.compact();
		const rejected = expect(pending).rejects.toThrow(/[Cc]ancel/);
		await vi.waitFor(() => expect(compact).toHaveBeenCalledOnce());
		harness.session.abortCompaction();
		await rejected;
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			harness.session.messages.some((message) => getMessageText(message).includes("original project paths")),
		).toBe(true);
	});

	it("rolls back a checkpoint when its disk append fails", async () => {
		const harness = await seededHarness();
		installCompactor(harness, async () => ({ checkpoint: checkpointFor(harness) }));
		const persist = harness.sessionManager._persist.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "_persist").mockImplementation((entry) => {
			if (entry.type === "compaction") throw new Error("disk full");
			persist(entry);
		});
		await expect(harness.session.compact()).rejects.toThrow("disk full");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(
			SessionManager.open(harness.sessionManager.getSessionFile()!)
				.getEntries()
				.some((entry) => entry.type === "compaction"),
		).toBe(false);
		expect(
			harness.session.messages.some((message) => getMessageText(message).includes("original project paths")),
		).toBe(true);
	});

	it("summarizes oversized restored transcripts in bounded calls with distinct request identities", async () => {
		const harness = await createHarness({ models: [{ id: "faux-1", contextWindow: 8000, maxTokens: 1000 }] });
		harnesses.push(harness);
		const calls: Context[] = [];
		harness.setResponses(
			Array.from({ length: 20 }, () => (context: Context) => {
				calls.push(context);
				return fauxAssistantMessage("Accumulated summary");
			}),
		);
		let requestId = 0;
		const result = await generateSummary(
			[{ role: "user", content: `START${"x".repeat(100_000)}END`, timestamp: 1 }],
			harness.getModel(),
			1000,
			"faux-key",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			(call) => call({ "x-request-id": String(++requestId) }),
		);
		expect(result.summary).toBe("Accumulated summary");
		expect(calls.length).toBeGreaterThan(1);
		expect(requestId).toBe(calls.length);
		expect(getMessageText(calls[0].messages[0])).toContain("START");
		expect(getMessageText(calls.at(-1)!.messages[0])).toContain("END");
		for (const call of calls) expect(getMessageText(call.messages[0]).length / 3).toBeLessThan(8000 - 800);
	});

	it("does not retry permanent failures or excessive Retry-After delays", async () => {
		for (const failure of [{ status: 401 }, { status: 429, retryAfterMs: 60_001 }]) {
			const request = vi.fn().mockRejectedValue(Object.assign(new Error("failed"), failure));
			await expect(requestWithProviderRetry(request)).rejects.toThrow("failed");
			expect(request).toHaveBeenCalledOnce();
		}
	});
});
