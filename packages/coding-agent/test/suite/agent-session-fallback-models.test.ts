import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelSwitchEntry } from "../../src/core/session-manager.js";
import { createHarness, getAssistantTexts, type Harness } from "./harness.js";

const FALLBACK_MODELS = [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }];

function transientError(errorMessage = "overloaded_error"): AssistantMessage {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

function structuredFailure(kind: "auth" | "invalid_request", status?: number): AssistantMessage {
	return {
		...fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: `provider ${kind} failure`,
		}),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: status === undefined ? { kind } : { kind, status },
			},
		],
	};
}

function modelSwitches(harness: Harness): ModelSwitchEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry): entry is ModelSwitchEntry => entry.type === "model_switch");
}

describe("native model failover (fallbackModels)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("advances to the next fallback model once the retry policy is exhausted", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([transientError(), transientError(), transientError(), fauxAssistantMessage("recovered")]);

		await harness.session.prompt("test");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.faux.state.callCount).toBe(4);
		expect(getAssistantTexts(harness)).toContain("recovered");
	});

	it("continues the same conversation across the switch", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([transientError(), transientError(), fauxAssistantMessage("after switch")]);

		await harness.session.prompt("remember this");

		const userTexts = harness.session.messages.filter((m) => m.role === "user");
		expect(userTexts.length).toBe(1);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(getAssistantTexts(harness)).toContain("after switch");
	});

	it("records a structured model_switch entry in the session JSONL", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			persistSession: true,
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([
			transientError("429 rate limit"),
			transientError("429 rate limit"),
			fauxAssistantMessage("ok"),
		]);

		await harness.session.prompt("test");

		const switches = modelSwitches(harness);
		expect(switches).toHaveLength(1);
		expect(switches[0]).toMatchObject({
			type: "model_switch",
			from: "faux/faux-1",
			to: "faux/faux-2",
			attempt: 1,
		});
		expect(switches[0].reason).toContain("429 rate limit");
		expect(typeof switches[0].timestamp).toBe("string");
	});

	it("emits a model_switch session event", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([transientError(), transientError(), fauxAssistantMessage("ok")]);

		await harness.session.prompt("test");

		const events = harness.eventsOfType("model_switch");
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ from: "faux/faux-1", to: "faux/faux-2" });
	});

	it("walks the whole chain when each model keeps failing", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!, harness.getModel("faux-3")!]);

		harness.setResponses([
			transientError(),
			transientError(),
			transientError(),
			transientError(),
			fauxAssistantMessage("third model works"),
		]);

		await harness.session.prompt("test");

		expect(modelSwitches(harness).map((entry) => entry.to)).toEqual(["faux/faux-2", "faux/faux-3"]);
		expect(harness.session.model?.id).toBe("faux-3");
		expect(getAssistantTexts(harness)).toContain("third model works");
	});

	it("does not switch on a 401 auth failure", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([
			structuredFailure("auth", 401),
			structuredFailure("auth", 401),
			structuredFailure("auth", 401),
		]);

		await harness.session.prompt("test");

		expect(modelSwitches(harness)).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("does not switch on an invalid_request failure", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([
			structuredFailure("invalid_request"),
			structuredFailure("invalid_request"),
			structuredFailure("invalid_request"),
		]);

		await harness.session.prompt("test");

		expect(modelSwitches(harness)).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-1");
	});

	it("keeps current behavior when no fallback chain is configured", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);

		harness.setResponses([transientError(), transientError()]);

		await harness.session.prompt("test");

		expect(modelSwitches(harness)).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
	});

	it("reports every attempted model when the chain is exhausted", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([transientError(), transientError(), transientError(), transientError()]);

		await harness.session.prompt("test");

		const ends = harness.eventsOfType("auto_retry_end");
		const finalError = ends[ends.length - 1]?.finalError ?? "";
		expect(finalError).toContain("faux/faux-1");
		expect(finalError).toContain("faux/faux-2");
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toContain(false);
	});

	it("does not reset goal budget counters across a switch", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			initialGoal: { objective: "stay alive", tokenBudget: 1_000_000 },
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([
			{
				...fauxAssistantMessage("before switch"),
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		]);
		await harness.session.prompt("first");
		const tokensBefore = harness.session.goalState.tokensUsed;
		expect(tokensBefore).toBeGreaterThan(0);

		harness.setResponses([transientError(), transientError(), fauxAssistantMessage("after switch")]);
		await harness.session.prompt("second");

		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.session.goalState.tokensUsed).toBeGreaterThanOrEqual(tokensBefore);
		expect(harness.session.goalState.objective).toBe("stay alive");
	});

	it("spawns RLM children on the active fallback model, not the configured default", async () => {
		const harness = await createHarness({
			models: FALLBACK_MODELS,
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
			rlmDepth: 0,
			rlmMaxDepth: 2,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("child runtime intentionally not started in this test");
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		harnesses.push(harness);
		harness.session.setFallbackModels([harness.getModel("faux-2")!]);

		harness.setResponses([transientError(), transientError(), fauxAssistantMessage("switched")]);
		await harness.session.prompt("test");
		expect(harness.session.model?.id).toBe("faux-2");

		await harness.session.runRlmChild("child task");

		const childUpdates = harness.eventsOfType("rlm_child_update");
		expect(childUpdates.length).toBeGreaterThan(0);
		expect(childUpdates[0].child.model).toBe("faux/faux-2");
	});
});
