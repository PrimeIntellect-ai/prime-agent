import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Usage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessDigestMessage } from "../../../src/core/messages.js";
import { loadHarnessState } from "../../../src/core/refinement/index.js";
import type { FileEntry, SessionEntry } from "../../../src/core/session-manager.js";
import { emptyUsage, subtractAssistantUsage } from "../../../src/core/usage.js";
import { SessionContextView } from "../../../src/session/context/context-view.js";
import { SessionHarnessContext } from "../../../src/session/context/harness-context.js";
import { SessionModelSelection } from "../../../src/session/models/model-selection.js";
import { createHarness, type Harness } from "../harness.js";

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function usage(input: number): Usage {
	return { ...emptyUsage(), input, totalTokens: input };
}

describe("session model and history ownership boundaries", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it.each(["set", "available", "scoped"] as const)(
		"honors a late thinking wrapper before tier changes and model hooks during %s selection",
		async (selection) => {
			const harness = await createHarness({ models: [{ id: "one" }, { id: "two" }] });
			harnesses.push(harness);
			const { session, sessionManager, settingsManager } = harness;
			const nextModel = harness.getModel("two")!;
			if (selection === "scoped") session.setScopedModels(harness.models.map((model) => ({ model })));
			const events: string[] = [];
			const original = session.setThinkingLevel.bind(session);
			const wrapper = vi.spyOn(session, "setThinkingLevel").mockImplementation((level) => {
				expect(session.model).toMatchObject({ provider: nextModel.provider, id: nextModel.id });
				expect(sessionManager.getEntries().at(-1)).toMatchObject({ type: "model_change", modelId: "two" });
				expect(settingsManager.getDefaultModel()).toBe("two");
				expect(session.serviceTier).toBe("priority");
				events.push("thinking");
				original(level);
			});
			session.subscribe((event) => {
				if (event.type === "service_tier_changed") events.push("tier");
			});
			vi.spyOn(session.extensionRunner, "emit").mockImplementation(async (event) => {
				if (event.type === "model_select") events.push("model");
				return undefined;
			});
			session.state.serviceTier = "priority";
			if (selection === "set") await session.setModel(nextModel);
			else await session.cycleModel();
			expect(wrapper).toHaveBeenCalledOnce();
			expect(events).toEqual(["thinking", "tier", "model"]);
			expect(session.serviceTier).toBe("default");
		},
	);

	it.each(["set", "available", "scoped"] as const)(
		"preserves partial updates and rejection when a late thinking wrapper throws during %s selection",
		async (selection) => {
			const harness = await createHarness({ models: [{ id: "one" }, { id: "two" }] });
			harnesses.push(harness);
			const { session, sessionManager, settingsManager } = harness;
			if (selection === "scoped") session.setScopedModels(harness.models.map((model) => ({ model })));
			const failure = new Error("thinking wrapper failed");
			vi.spyOn(session, "setThinkingLevel").mockImplementation(() => {
				throw failure;
			});
			const emit = vi.spyOn(session.extensionRunner, "emit");
			const events = vi.fn();
			session.subscribe(events);
			session.state.serviceTier = "priority";
			const selectionPromise =
				selection === "set" ? session.setModel(harness.getModel("two")!) : session.cycleModel();
			await expect(selectionPromise).rejects.toBe(failure);
			expect(session.model?.id).toBe("two");
			expect(sessionManager.getEntries().at(-1)).toMatchObject({ type: "model_change", modelId: "two" });
			expect(settingsManager.getDefaultModel()).toBe("two");
			expect(session.serviceTier).toBe("priority");
			expect(events).not.toHaveBeenCalled();
			expect(emit).not.toHaveBeenCalled();
		},
	);

	it("uses late capability and thinking-level overrides for cycling and preference persistence", async () => {
		const harness = await createHarness({ models: [{ id: "one", reasoning: false }] });
		harnesses.push(harness);
		const { session, settingsManager } = harness;
		const supports = vi.spyOn(session, "supportsThinking").mockReturnValue(true);
		vi.spyOn(session, "getAvailableThinkingLevels").mockReturnValue(["off", "high"]);
		const original = session.setThinkingLevel.bind(session);
		const wrapper = vi.spyOn(session, "setThinkingLevel").mockImplementation((level) => original(level));
		session.state.thinkingLevel = "off";
		expect(session.cycleThinkingLevel()).toBe("high");
		expect(session.thinkingLevel).toBe("high");
		expect(wrapper).toHaveBeenLastCalledWith("high");
		expect(session.cycleThinkingLevel()).toBe("off");
		expect(settingsManager.getDefaultThinkingLevel()).toBe("off");
		supports.mockReturnValue(false);
		wrapper.mockClear();
		expect(session.cycleThinkingLevel()).toBeUndefined();
		expect(wrapper).not.toHaveBeenCalled();
	});

	it("uses a late capability override to restore the saved thinking preference during model selection", async () => {
		const harness = await createHarness({
			models: [
				{ id: "one", reasoning: true },
				{ id: "two", reasoning: true },
			],
		});
		harnesses.push(harness);
		const { session, settingsManager } = harness;
		session.state.thinkingLevel = "low";
		settingsManager.setDefaultThinkingLevel("high");
		vi.spyOn(session, "supportsThinking").mockReturnValue(false);
		vi.spyOn(session, "getAvailableThinkingLevels").mockReturnValue(["low", "high"]);
		await session.setModel(harness.getModel("two")!);
		expect(session.thinkingLevel).toBe("high");
	});

	it("uses a context-usage wrapper installed after construction for stats and tree aggregates", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const { session } = harness;
		const original = session.getContextUsage.bind(session);
		const replacement = { tokens: 42, contextWindow: 100, percent: 42 };
		const wrapper = vi.spyOn(session, "getContextUsage").mockImplementation(() => {
			expect(original()).toBeDefined();
			return replacement;
		});
		expect(session.getSessionStats().contextUsage).toBe(replacement);
		expect(session.getContextTree().contextUsage).toBe(replacement);
		expect(wrapper).toHaveBeenCalledTimes(2);
	});

	it("resolves request auth freshly and reads the current registry after replacement", async () => {
		const first = await createHarness();
		const second = await createHarness();
		harnesses.push(first, second);
		let registry = first.session.modelRegistry;
		const owner = new SessionModelSelection(
			{
				getState: () => first.session.state,
				getModel: () => first.session.model,
				setThinkingLevel: (level) => first.session.setThinkingLevel(level),
				getAvailableThinkingLevels: () => first.session.getAvailableThinkingLevels(),
				supportsThinking: () => first.session.supportsThinking(),
				getRegistry: () => registry,
				getExtensions: () => first.session.extensionRunner,
				sessionManager: first.sessionManager,
				settingsManager: first.settingsManager,
				emit: () => {},
			},
			"default",
			[],
		);
		const firstAuth = vi
			.spyOn(registry, "getApiKeyAndHeaders")
			.mockResolvedValue({ ok: true, apiKey: "first", headers: { team: "one" } });
		const secondAuth = vi
			.spyOn(second.session.modelRegistry, "getApiKeyAndHeaders")
			.mockResolvedValue({ ok: true, apiKey: "second", headers: { team: "two" } });
		expect(await owner.getRequiredRequestAuth(first.getModel())).toEqual({
			apiKey: "first",
			headers: { team: "one" },
		});
		registry = second.session.modelRegistry;
		expect(await owner.getRequiredRequestAuth(first.getModel())).toEqual({
			apiKey: "second",
			headers: { team: "two" },
		});
		secondAuth.mockResolvedValue({ ok: false, error: "credential refresh failed" });
		await expect(owner.getRequiredRequestAuth(first.getModel())).rejects.toThrow("credential refresh failed");
		expect(firstAuth).toHaveBeenCalledOnce();
		expect(secondAuth).toHaveBeenCalledTimes(2);
	});

	it("dispatches queued model hooks through the live extension runner", async () => {
		const entered = deferred();
		const release = deferred();
		const events: string[] = [];
		const first = await createHarness({
			models: [{ id: "one" }, { id: "two" }, { id: "three" }],
			extensionFactories: [
				(pi) =>
					pi.on("model_select", async (event) => {
						events.push(`old:${event.model.id}`);
						entered.resolve();
						await release.promise;
					}),
			],
		});
		const second = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.on("model_select", (event) => {
						events.push(`new:${event.model.id}`);
					}),
			],
		});
		harnesses.push(first, second);
		let extensions = first.session.extensionRunner;
		const owner = new SessionModelSelection(
			{
				getState: () => first.session.state,
				getModel: () => first.session.model,
				setThinkingLevel: (level) => first.session.setThinkingLevel(level),
				getAvailableThinkingLevels: () => first.session.getAvailableThinkingLevels(),
				supportsThinking: () => first.session.supportsThinking(),
				getRegistry: () => first.session.modelRegistry,
				getExtensions: () => extensions,
				sessionManager: first.sessionManager,
				settingsManager: first.settingsManager,
				emit: () => {},
			},
			"default",
			[],
		);
		await owner.setModel(first.getModel("two")!, { waitForExtensions: false });
		await entered.promise;
		await owner.setModel(first.getModel("three")!, { waitForExtensions: false });
		const pending = owner.pendingModelSelectEmit();
		expect(pending).toBeDefined();
		extensions = second.session.extensionRunner;
		release.resolve();
		await pending;
		expect(events).toEqual(["old:two", "new:three"]);
		expect(owner.pendingModelSelectEmit()).toBeUndefined();
		expect(first.session.model?.id).toBe("three");
	});

	it("releases a cancelled navigation before the next queued branch mutation", async () => {
		const entered = deferred();
		const calls: string[] = [];
		let firstSignal: AbortSignal | undefined;
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) =>
					pi.on("session_before_tree", async (event) => {
						calls.push(event.preparation.targetId);
						if (calls.length !== 1) return;
						firstSignal = event.signal;
						entered.resolve();
						await new Promise<void>((resolve) =>
							event.signal.addEventListener("abort", () => resolve(), { once: true }),
						);
						return { cancel: true };
					}),
			],
		});
		harnesses.push(harness);
		const firstUser = harness.sessionManager.appendMessage({ role: "user", content: "first", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("first answer"));
		const secondUser = harness.sessionManager.appendMessage({ role: "user", content: "second", timestamp: 3 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("second answer"));
		const originalLeaf = harness.sessionManager.getLeafId();
		const first = harness.session.navigateTree(firstUser);
		await entered.promise;
		const second = harness.session.navigateTree(secondUser);
		expect(calls).toEqual([firstUser]);
		expect(harness.session.isCompacting).toBe(true);
		expect(harness.sessionManager.getLeafId()).toBe(originalLeaf);
		harness.session.abortBranchSummary();
		expect(firstSignal?.aborted).toBe(true);
		await expect(first).resolves.toEqual({ cancelled: true });
		await expect(second).resolves.toMatchObject({ cancelled: false, editorText: "second" });
		expect(calls).toEqual([firstUser, secondUser]);
		expect(harness.session.isCompacting).toBe(false);
		await expect(harness.session.navigateTree("missing")).rejects.toThrow("Entry missing not found");
		await expect(harness.session.navigateTree(harness.sessionManager.getLeafId()!)).resolves.toEqual({
			cancelled: false,
		});
	});

	it("invalidates own spend for live attribution and equal-length entry replacement", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		const message = { ...fauxAssistantMessage("answer"), usage: usage(100) };
		harness.sessionManager.appendMessage(message);
		let entries = harness.sessionManager.getEntries();
		let unindexed: Usage | undefined;
		const owner = new SessionContextView({
			sessionManager: {
				getEntries: () => entries,
				getBranch: () => entries,
				getSessionId: () => harness.session.sessionId,
				getSessionFile: () => undefined,
				getSessionName: () => undefined,
			},
			getMessages: () => [message],
			getContextUsage: () => harness.session.getContextUsage(),
			getModel: () => harness.session.model,
			findModel: (provider, id) => harness.session.modelRegistry.find(provider, id),
			subtractUnindexedChildUsage: (ownUsage, entries) => {
				for (const entry of entries) {
					if (entry.type === "message" && entry.message === message && unindexed) {
						subtractAssistantUsage(ownUsage, unindexed);
					}
				}
			},
			getLiveChildren: () => [],
			getRlmSessionDir: () => undefined,
		});
		const first = owner.getOwnUsageSummary();
		expect(first?.inputTokens).toBe(100);
		expect(owner.getOwnUsageSummary()).toBe(first);
		unindexed = usage(40);
		owner.invalidateOwnUsage();
		expect(owner.getOwnUsageSummary()?.inputTokens).toBe(60);
		expect(owner.getContextTree().totalUsage.input).toBe(100);
		expect(owner.getContextTree().ownUsage.input).toBe(60);
		entries = [
			{
				...entries[0]!,
				id: "replacement",
				message: { ...fauxAssistantMessage("replacement"), usage: usage(25) },
			} as SessionEntry,
		];
		expect(owner.getOwnUsageSummary()?.inputTokens).toBe(25);
	});

	it("keeps cold digests lazy and uses timestamp recency after a context replacement", async () => {
		const harness = await createHarness({ tools: [] });
		harnesses.push(harness);
		let messages: AgentMessage[] = [];
		const append = vi.spyOn(harness.sessionManager, "appendCustomMessageEntryWithRollback").mockImplementation(() => {
			throw new Error("disk unavailable");
		});
		const owner = new SessionHarnessContext({
			sessionManager: harness.sessionManager,
			getMessages: () => messages,
			getActiveToolNames: () => [],
			getVisibleSkills: () => [],
			loadHarnessState: () => loadHarnessState(join(harness.tempDir, "harness"), "local"),
			applyLateSentMessages: () => {},
		});
		owner.ensureHarnessDigestContext();
		expect(owner.digestPending).toBe(true);
		expect(messages).toEqual([]);
		expect(append).not.toHaveBeenCalled();
		messages = [{ role: "user", content: "resume", timestamp: 1 }];
		owner.ensureHarnessDigestContext();
		expect(owner.digestPending).toBe(false);
		expect(messages).toHaveLength(2);
		expect(append).toHaveBeenCalledOnce();
		owner.ensureHarnessDigestContext();
		expect(messages).toHaveLength(2);
		const newer = { ...createHarnessDigestMessage("new"), timestamp: 30 };
		const older = { ...createHarnessDigestMessage("old"), timestamp: 20 };
		messages = [newer, older];
		expect(owner.latestContextHarnessDigest()).toBe("new");
		const outcome = { ...createHarnessDigestMessage("retained"), timestamp: 25 };
		owner.retainOutcome(outcome);
		const rebuilt: AgentMessage[] = [older, newer];
		owner.mergeUnpersistedOutcomes(rebuilt);
		expect(rebuilt).toEqual([older, outcome, newer]);
	});

	it("exports only the selected branch without mutating persisted parent links", async () => {
		const harness = await createHarness({ tools: [], persistSession: true });
		harnesses.push(harness);
		const root = harness.sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("abandoned answer"));
		harness.sessionManager.branch(root);
		const answer = harness.sessionManager.appendMessage(fauxAssistantMessage("selected answer"));
		harness.session.state.messages = harness.session.buildSessionContext().messages;
		const before = structuredClone(harness.sessionManager.getEntries());
		const path = harness.session.exportToJsonl(join(harness.tempDir, "export", "branch.jsonl"));
		const exported = readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as FileEntry);
		expect(exported[0]).toMatchObject({ type: "session", id: harness.session.sessionId });
		expect(exported.slice(1)).toMatchObject([
			{ id: root, parentId: null },
			{ id: answer, parentId: root },
		]);
		expect(exported).toHaveLength(3);
		expect(harness.sessionManager.getEntries()).toEqual(before);
		const html = await harness.session.exportToHtml(join(harness.tempDir, "session.html"));
		const encoded = readFileSync(html, "utf8").match(
			/<script id="session-data" type="application\/json">([^<]+)<\/script>/,
		)?.[1];
		expect(encoded).toBeDefined();
		const htmlData = Buffer.from(encoded!, "base64").toString("utf8");
		expect(htmlData).toContain("selected answer");
		expect(htmlData).toContain("abandoned answer");
		harness.session.state.messages.push(fauxAssistantMessage([], { stopReason: "aborted" }));
		expect(harness.session.getLastAssistantText()).toBe("selected answer");
		expect(harness.session.getUserMessagesForForking()).toEqual([{ entryId: root, text: "root" }]);
	});
});
