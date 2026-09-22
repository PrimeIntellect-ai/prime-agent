import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLocalHarnessStateDir, loadHarnessState, saveHarnessState } from "../../src/core/refinement/index.js";
import { createHarness, getMessageText, type Harness } from "./harness.js";

type SerializedInternals = {
	_shouldStopAfterTurn(context: {
		message: { stopReason?: string; content: unknown[]; role: string; usage?: unknown; timestamp?: number };
		toolResults: unknown[];
		context: unknown;
		newMessages: unknown[];
	}): Promise<boolean>;
	_shouldStopForThresholdCompaction(context: unknown): Promise<boolean>;
	_runSerializedRefineCheckpoint(): Promise<void>;
	_runSerializedRefine(options: { instructions?: string; global?: boolean }, source: "auto" | "self"): Promise<void>;
	_consumeSerializedBackgroundPlan(consume: (result: unknown) => Promise<boolean>): Promise<string>;
	_planRefine(options: { instructions?: string; global?: boolean }, signal: AbortSignal): Promise<unknown>;
	_applyRefine(
		plan: unknown,
		options: { instructions?: string; global?: boolean },
		abort: AbortController,
	): Promise<unknown>;
	_createPreparedTurnAction(
		schedule: "steer",
		text: string,
		images: undefined,
		options: Record<string, never>,
	): unknown;
	_admitSessionInput(action: unknown, options?: { wake?: boolean }): { accepted: boolean };
	_assistantTurnsSinceAutoRefine: number;
	_lastAutoRefineReviewAt: number;
	_autoRefineBranchVersion: number;
	_serializedPlanInFlight?: Promise<unknown>;
	_maybeStartSerializedBackgroundPlan(): void;
	_invalidatePendingAutoRefineForBranchChange(): Promise<void>;
	_rebuildSystemPrompt(tools: string[]): string;
	_drainPendingRefinementForDisposal(): Promise<void>;
	_autoRefineOperations: Set<Promise<void>>;
};

function emptyRefinementResult() {
	return {
		id: "refine_test",
		summary: "test refinement",
		rationale: "test rationale",
		expectedOutcome: "test outcome",
		appliedEdits: [],
		harnessStatePath: "/tmp/harness_state.json",
	};
}

function makeCtx(text: string) {
	return {
		message: {
			stopReason: "stop",
			content: [{ type: "text" as const, text }],
			role: "assistant",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 },
			timestamp: Date.now(),
		},
		toolResults: [],
		context: {},
		newMessages: [],
	};
}

describe("Serialized refine", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function serialized(options: { turnInterval?: number } = {}) {
		const reviewer = vi.fn(async () => ({ shouldRefine: true, rationale: "test", instructions: "test" }));
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			settings: { autoRefine: { enabled: true, turnInterval: options.turnInterval ?? 1, cooldownMs: 0 } },
			autoRefineReviewer: reviewer,
		});
		harnesses.push(harness);
		return { harness, reviewer, internals: harness.session as unknown as SerializedInternals };
	}

	it("max concurrent primary/refinement model requests is one in serialized mode", async () => {
		const { internals } = await serialized();
		internals._assistantTurnsSinceAutoRefine = 1;

		let applyInFlight = false;
		let resolveApply: () => void = () => {};
		const applyPromise = new Promise<void>((resolve) => {
			resolveApply = resolve;
		});
		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			applyInFlight = true;
			await applyPromise;
			applyInFlight = false;
			return emptyRefinementResult();
		});

		// The agent loop cannot start the next model request while the
		// checkpoint (and its apply) is still running.
		const checkpointPromise = internals._shouldStopAfterTurn(makeCtx("test"));
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
		expect(applyInFlight).toBe(true);

		resolveApply();
		await checkpointPromise;
		expect(applyInFlight).toBe(false);
	});

	it("never deadlocks: serialized checkpoint does not call waitForIdle or _maybeAutoRefine", async () => {
		const { harness, internals } = await serialized();
		vi.spyOn(internals, "_planRefine").mockResolvedValue({ id: "p", proposal: { edits: [] } });
		const applyRefine = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		// Simulate "active" agent state (as during a tool loop).
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		internals._assistantTurnsSinceAutoRefine = 1;

		const timeout = new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("Serialized checkpoint deadlocked")), 5000),
		);
		await Promise.race([internals._runSerializedRefineCheckpoint(), timeout]);

		expect(applyRefine).toHaveBeenCalledTimes(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("real message_end/turn_end ordering: threshold planning starts and applies before next model turn", async () => {
		// Real agent.prompt() with faux responses: message_end must increment the
		// counter before the serialized checkpoint checks the threshold.
		const { harness, internals, reviewer } = await serialized({ turnInterval: 2 });
		const planSpy = vi
			.spyOn(internals, "_planRefine")
			.mockResolvedValue({ id: "p", proposal: { edits: [] } } as never);
		const applySpy = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		harness.setResponses([fauxAssistantMessage("response 1")]);
		const counterBefore = internals._assistantTurnsSinceAutoRefine;
		await harness.session.prompt("test prompt");
		expect(internals._assistantTurnsSinceAutoRefine).toBe(counterBefore + 1);

		harness.setResponses([fauxAssistantMessage("response 2")]);
		await harness.session.prompt("test prompt 2");

		expect(applySpy).toHaveBeenCalled();
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		expect(reviewer).toHaveBeenCalledTimes(1);
		expect(planSpy).toHaveBeenCalledTimes(1);
	});

	it("steering waits for interval refine and threshold compaction boundaries", async () => {
		const { internals } = await serialized();
		internals._admitSessionInput(internals._createPreparedTurnAction("steer", "steer", undefined, {}));

		let planResolved = false;
		let applyFinished = false;
		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			await new Promise<void>((resolve) => setTimeout(resolve, 20));
			planResolved = true;
			return { id: "p", proposal: { edits: [] } };
		});
		vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			expect(planResolved).toBe(true);
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			applyFinished = true;
			return emptyRefinementResult();
		});
		const compactionSpy = vi.spyOn(internals, "_shouldStopForThresholdCompaction").mockImplementation(async () => {
			expect(applyFinished).toBe(true);
			return true;
		});

		internals._assistantTurnsSinceAutoRefine++;
		internals._maybeStartSerializedBackgroundPlan();
		await new Promise<void>((resolve) => setTimeout(resolve, 10));

		// The checkpoint drains the background plan before compaction fires,
		// so the compaction model call cannot overlap an in-flight refine.
		const result = await internals._shouldStopAfterTurn(makeCtx("turn"));

		expect(compactionSpy).toHaveBeenCalledTimes(1);
		expect(result).toBe(true);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("branch navigation with in-flight serialized plan: aborts signal, no apply", async () => {
		const { internals } = await serialized();
		const applySpy = vi.spyOn(internals, "_applyRefine").mockResolvedValue(emptyRefinementResult());

		let planSignal: AbortSignal | undefined;
		vi.spyOn(internals, "_planRefine").mockImplementation(async (_opts: unknown, signal: AbortSignal) => {
			planSignal = signal;
			if (signal.aborted) throw new Error("Plan aborted by branch change");
			await new Promise<void>((_, reject) => {
				signal.addEventListener("abort", () => reject(new Error("aborted")));
			}).catch(() => undefined);
			if (signal.aborted) throw new Error("Plan aborted by branch change");
			return { id: "p", proposal: { edits: [] } };
		});

		internals._assistantTurnsSinceAutoRefine++;
		internals._maybeStartSerializedBackgroundPlan();
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(internals._serializedPlanInFlight).toBeDefined();
		expect(planSignal).toBeDefined();

		await internals._invalidatePendingAutoRefineForBranchChange();

		expect(internals._autoRefineBranchVersion).toBeGreaterThan(0);
		expect(internals._serializedPlanInFlight).toBeUndefined();

		await internals._runSerializedRefineCheckpoint();
		expect(applySpy).not.toHaveBeenCalled();
	});

	it("non-mocked apply pipeline: harness state persisted, prompt untouched, notice emitted", async () => {
		// Only _planRefine is mocked; the real _applyRefine runs.
		const { harness, internals } = await serialized();
		vi.spyOn(internals, "_planRefine").mockResolvedValue({
			id: "refine_p0_test",
			proposal: {
				summary: "P0 test refinement",
				rationale: "testing non-mocked apply",
				expectedOutcome: "memory entry persisted",
				edits: [
					{ action: "create", kind: "memory", title: "apply pipeline memory", content: "applied content" },
					{ action: "update", kind: "memory", id: "missing-memory", title: "Missing", content: "Rejected edit" },
				],
			},
		} as never);
		const rebuildSpy = vi.spyOn(internals, "_rebuildSystemPrompt");
		const extensionEmit = vi.spyOn(harness.session.extensionRunner, "emit");
		let refineCompleteEmitted = false;
		harness.session.subscribe((event) => {
			if (event.type === "refine_complete") refineCompleteEmitted = true;
		});

		const promptBefore = harness.session.agent.state.systemPrompt;
		await internals._runSerializedRefine({ instructions: "add a memory" }, "self");

		// The cache pin: applying a refinement never rebuilds or swaps the prompt.
		expect(rebuildSpy).not.toHaveBeenCalled();
		expect(harness.session.agent.state.systemPrompt).toBe(promptBefore);
		const notice = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "refinement_notice",
		);
		expect(getMessageText(notice)).toMatch(/^\[self-refinement\]\n\n/);

		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeDefined();
		if (localDir) {
			const state = loadHarnessState(localDir, "local");
			const memoryEntry = Object.values(state.entries.memory ?? {}).find((m) => m.title === "apply pipeline memory");
			expect(memoryEntry?.content).toBe("applied content");
		}

		// refine_complete reports only successfully applied edits to extensions.
		expect(refineCompleteEmitted).toBe(true);
		expect(extensionEmit).toHaveBeenCalledWith(expect.objectContaining({ type: "refine_complete", appliedEdits: 1 }));
	});

	it("serialized same-entry harness write: concurrent kernel write rejected via baselineState", async () => {
		const { harness, internals } = await serialized();
		const localDir = getLocalHarnessStateDir(harness.sessionManager.getSessionArtifactDir());
		expect(localDir).toBeDefined();
		if (!localDir) return;
		const seedState = loadHarnessState(localDir, "local");
		seedState.entries.memory ??= {};
		seedState.entries.memory.shared = {
			id: "shared",
			kind: "memory",
			title: "Shared",
			content: "planning baseline",
			path: "general",
			scope: "local",
			reference: {},
			arguments: {},
			metadata: {},
			source: "refine",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			version: 1,
		};
		saveHarnessState(localDir, seedState);

		let releasePlan: (() => void) | undefined;
		const planGate = new Promise<void>((resolve) => {
			releasePlan = resolve;
		});
		let planStarted: (() => void) | undefined;
		const planStartedPromise = new Promise<void>((resolve) => {
			planStarted = resolve;
		});
		const baselineState = loadHarnessState(localDir, "local");
		vi.spyOn(internals, "_planRefine").mockImplementation(async () => {
			planStarted?.();
			await planGate;
			return {
				id: "refine_conflict_test",
				proposal: {
					summary: "Update shared memory",
					rationale: "planned update",
					expectedOutcome: "updated",
					edits: [
						{ action: "update", kind: "memory", id: "shared", title: "Shared", content: "stale planned content" },
					],
				},
				baselineState,
			} as never;
		});

		const refinePromise = internals._runSerializedRefine({ instructions: "update shared memory" }, "self");
		await planStartedPromise;

		// Concurrent kernel harness write while planning is in flight.
		const concurrentState = loadHarnessState(localDir, "local");
		const sharedEntry = concurrentState.entries.memory?.shared;
		expect(sharedEntry).toBeDefined();
		if (sharedEntry) {
			sharedEntry.content = "concurrent kernel content";
			sharedEntry.version++;
		}
		saveHarnessState(localDir, concurrentState);

		releasePlan?.();
		await refinePromise;

		const finalState = loadHarnessState(localDir, "local");
		expect(finalState.entries.memory?.shared?.content).toBe("concurrent kernel content");
	});

	it("consumes a serialized background plan only once across concurrent drains", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;
		let resolvePlan: (value: unknown) => void = () => {};
		internals._serializedPlanInFlight = new Promise((resolve) => {
			resolvePlan = resolve;
		});
		let releaseProcessing: () => void = () => {};
		const processing = new Promise<void>((resolve) => {
			releaseProcessing = resolve;
		});
		const firstConsumer = vi.fn(async (result: unknown) => {
			expect(result).toEqual({ status: "skip" });
			await processing;
			return false;
		});
		const secondConsumer = vi.fn(async () => false);

		const first = internals._consumeSerializedBackgroundPlan(firstConsumer);
		const second = internals._consumeSerializedBackgroundPlan(secondConsumer);
		expect(internals._serializedPlanInFlight).toBeDefined();
		resolvePlan({ status: "skip" });
		await vi.waitFor(() => expect(firstConsumer).toHaveBeenCalledOnce());

		let secondSettled = false;
		void second.then(() => {
			secondSettled = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(secondSettled).toBe(false);

		releaseProcessing();
		await expect(first).resolves.toBe("continue");
		await expect(second).resolves.toBe("waited");
		expect(secondConsumer).not.toHaveBeenCalled();
	});

	it("disposal waits for the checkpoint owner to finish applying a claimed plan", async () => {
		const harness = await createHarness({ persistSession: true, serializedRefine: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;
		let resolvePlan: (value: unknown) => void = () => {};
		internals._serializedPlanInFlight = new Promise((resolve) => {
			resolvePlan = resolve;
		});
		internals._assistantTurnsSinceAutoRefine = 1;
		let releaseApply: () => void = () => {};
		const applyBlocked = new Promise<void>((resolve) => {
			releaseApply = resolve;
		});
		const apply = vi.spyOn(internals, "_applyRefine").mockImplementation(async () => {
			await applyBlocked;
			return emptyRefinementResult();
		});

		const checkpoint = internals._runSerializedRefineCheckpoint();
		const drain = internals._drainPendingRefinementForDisposal();
		resolvePlan({
			status: "plan",
			plan: { id: "claimed-plan", proposal: { edits: [] } },
			options: {},
			abort: new AbortController(),
			branchVersion: internals._autoRefineBranchVersion,
		});
		await vi.waitFor(() => expect(apply).toHaveBeenCalledOnce());

		let drainSettled = false;
		void drain.then(() => {
			drainSettled = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(drainSettled).toBe(false);

		releaseApply();
		await Promise.all([checkpoint, drain]);
		expect(apply).toHaveBeenCalledOnce();
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
	});

	it("waits for an interactive auto-refine operation before disposal drain continues", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const internals = harness.session as unknown as SerializedInternals;
		let releaseOperation: () => void = () => {};
		const operation = new Promise<void>((resolve) => {
			releaseOperation = resolve;
		});
		internals._autoRefineOperations.add(operation);
		let settled = false;
		const drain = internals._drainPendingRefinementForDisposal().then(() => {
			settled = true;
		});

		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		releaseOperation();
		await drain;
		expect(settled).toBe(true);
	});
});
