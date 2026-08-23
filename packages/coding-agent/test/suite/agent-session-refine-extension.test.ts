import { afterEach, describe, expect, it } from "vitest";
import { RefineSkippedError } from "../../src/core/agent-session.js";
import type { SessionBeforeRefineEvent } from "../../src/core/extensions/index.js";
import { loadHarnessState, type RefinementProposal } from "../../src/core/refinement/index.js";
import { createHarness, type Harness } from "./harness.js";

describe("AgentSession session_before_refine extension hook", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("applies an extension-provided proposal without calling the built-in planner", async () => {
		const events: SessionBeforeRefineEvent[] = [];
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async (event) => {
						events.push(event);
						return {
							proposal: {
								summary: "extension summary",
								rationale: "extension rationale",
								expectedOutcome: "extension outcome",
								edits: [
									{
										action: "create" as const,
										kind: "memory" as const,
										title: "Extension memory",
										content: "Captured by the extension planner",
									},
								],
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const result = await harness.session.refine({ instructions: "capture lessons" });

		expect(result.summary).toBe("extension summary");
		expect(result.appliedEdits).toHaveLength(1);
		expect(result.appliedEdits[0]?.applied).toBe(true);
		expect(events).toHaveLength(1);
		expect(events[0]?.preparation.trigger).toBe("manual");
		expect(events[0]?.preparation.scope).toBe("local");
		expect(events[0]?.preparation.instructions).toBe("capture lessons");
		expect(harness.getPendingResponseCount()).toBe(0);

		const state = loadHarnessState(result.harnessStatePath.replace(/\/[^/]+$/, ""), "local");
		const memories = Object.values(state.entries.memory);
		expect(memories.some((entry) => entry.title === "Extension memory")).toBe(true);
	});

	it("rejects invalid extension edits at apply time", async () => {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({
						proposal: {
							summary: "bad plan",
							rationale: "bad",
							expectedOutcome: "bad",
							edits: [
								// update without id is invalid
								{ action: "update" as const, kind: "memory" as const, title: "x", content: "y" },
							],
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const result = await harness.session.refine();

		expect(result.appliedEdits[0]?.applied).toBe(false);
		expect(result.appliedEdits[0]?.error).toContain("requires id");
	});

	it("normalizes malformed runtime extension proposals before applying them", async () => {
		const proposals: Array<{ proposal: unknown; expectedEdits: number }> = [
			{ proposal: { summary: "missing edits" }, expectedEdits: 0 },
			{ proposal: { edits: "not an array" }, expectedEdits: 0 },
			{
				proposal: {
					edits: [null, "not an edit", { action: "update", kind: "memory", title: "x", content: "y" }],
				},
				expectedEdits: 1,
			},
		];

		for (const { proposal, expectedEdits } of proposals) {
			const harness = await createHarness({
				persistSession: true,
				extensionFactories: [
					(pi) => {
						pi.on("session_before_refine", async () => ({
							proposal: proposal as RefinementProposal,
						}));
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([]);
			await harness.session.prompt("hello").catch(() => {});

			const result = await harness.session.refine();

			expect(result.appliedEdits).toHaveLength(expectedEdits);
			if (expectedEdits > 0) {
				expect(result.appliedEdits[0]?.applied).toBe(false);
				expect(result.appliedEdits[0]?.error).toContain("requires id");
			}
			expect(harness.eventsOfType("refine_failed")).toHaveLength(0);
		}
	});

	it("skips the refinement round when an extension returns skip", async () => {
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({ skip: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		await expect(harness.session.refine()).rejects.toThrow(RefineSkippedError);
	});

	it("falls back to the built-in planner when the handler returns nothing", async () => {
		let handlerCalls = 0;
		const harness = await createHarness({
			persistSession: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => {
						handlerCalls += 1;
						return undefined;
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const internals = harness.session as unknown as {
			_planRefine(options: unknown, signal: AbortSignal): Promise<unknown>;
		};
		// The handler runs but does not short-circuit: planning proceeds to the
		// built-in planner LLM call, which fails here (no faux response queued)
		// rather than being skipped.
		const refineAbort = new AbortController();
		await expect(internals._planRefine({ instructions: "x" }, refineAbort.signal)).rejects.not.toThrow(
			RefineSkippedError,
		);
		expect(handlerCalls).toBe(1);
	});

	it("consumes a non-serialized auto-refine round when an extension skips it", async () => {
		let handlerCalls = 0;
		const harness = await createHarness({
			persistSession: true,
			settings: { autoRefine: { enabled: true, turnInterval: 1, cooldownMs: 0 } },
			autoRefineReviewer: async () => ({ shouldRefine: true, rationale: "durable lesson" }),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => {
						handlerCalls += 1;
						return { skip: true };
					});
				},
			],
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_maybeAutoRefine(reason: "turn_interval"): Promise<void>;
			_assistantTurnsSinceAutoRefine: number;
			_turnIntervalAutoRefinePending: boolean;
			_pendingAutoRefineReview?: unknown;
		};
		internals._assistantTurnsSinceAutoRefine = 1;

		await internals._maybeAutoRefine("turn_interval");

		expect(handlerCalls).toBe(1);
		expect(internals._assistantTurnsSinceAutoRefine).toBe(0);
		expect(internals._turnIntervalAutoRefinePending).toBe(false);
		expect(internals._pendingAutoRefineReview).toBeUndefined();
		expect(harness.eventsOfType("refine_failed")).toHaveLength(0);

		await internals._maybeAutoRefine("turn_interval");
		expect(handlerCalls).toBe(1);
	});

	it("marks serialized auto-refine as trigger auto and treats extension skip as a non-failure", async () => {
		const events: SessionBeforeRefineEvent[] = [];
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			autoRefineReviewer: async () => ({
				shouldRefine: true,
				rationale: "durable lesson",
				instructions: "capture the lesson",
			}),
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async (event) => {
						events.push(event);
						return { skip: true };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		const internals = harness.session as unknown as {
			_runSerializedAutoRefineReview(reason: "compact" | "turn_interval", branchVersion: number): Promise<void>;
			_autoRefineBranchVersion: number;
		};
		await internals._runSerializedAutoRefineReview("turn_interval", internals._autoRefineBranchVersion);

		expect(events).toHaveLength(1);
		expect(events[0]?.preparation.trigger).toBe("auto");
		expect(harness.eventsOfType("refine_failed")).toHaveLength(0);
	});

	it("emits refine_failed when disposal drains an extension-skipped explicit serialized refine.run", async () => {
		const harness = await createHarness({
			persistSession: true,
			serializedRefine: true,
			extensionFactories: [
				(pi) => {
					pi.on("session_before_refine", async () => ({ skip: true }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([]);
		await harness.session.prompt("hello").catch(() => {});

		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = true;
		harness.session.handleRefineHostRequest("refine.run", { instructions: "x" });
		(harness.session.agent.state as { isStreaming: boolean }).isStreaming = false;

		await harness.session.disposeAsync();

		const failures = harness.eventsOfType("refine_failed");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.error).toBe("Refinement skipped by extension");
	});
});
