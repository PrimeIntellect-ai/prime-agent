import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	completeSimple,
	type FauxResponseFactory,
	fauxAssistantMessage,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessState, planRefinement, reviewAutoRefine } from "../../../src/core/refinement/refinement.js";
import { createHarness, getMessageText, type Harness } from "../harness.js";

const harnesses: Harness[] = [];
const retry = { enabled: true, maxRetries: 2, baseDelayMs: 1, maxRetryDelayMs: 1 };
const proposal = { summary: "No change", rationale: "Fixture", expectedOutcome: "No change", edits: [] };
const review = { shouldRefine: false, rationale: "No reusable lesson" };
const paths = [
	{ kind: "plan", formerCap: 32_000, expected: proposal },
	{ kind: "review", formerCap: 4_096, expected: review },
] as const;

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function requestRefinement(
	harness: Harness,
	kind: "plan" | "review",
	content = "",
	thinkingLevel: ThinkingLevel = "high",
) {
	const state: HarnessState = {
		schema: 1,
		entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
		refinements: [],
	};
	const messages = content ? [{ role: "user" as const, content, timestamp: 1 }] : [];
	if (kind === "plan") {
		const result = await planRefinement(
			messages,
			state,
			[],
			harness.getModel(),
			"faux-key",
			{ retry },
			undefined,
			undefined,
			thinkingLevel,
		);
		return result.proposal;
	}
	return reviewAutoRefine(
		messages,
		state,
		[],
		harness.getModel(),
		"faux-key",
		{ reason: "turn_interval", turnsSinceLastReview: 5 },
		undefined,
		undefined,
		thinkingLevel,
		retry,
	);
}

function budgetedResponse(text: string, reasoningTokens: number, requests: SimpleStreamOptions[]): FauxResponseFactory {
	return (_context, options, _state, model) => {
		const request = options as SimpleStreamOptions;
		requests.push(request);
		// Synthetic tokens: one JSON character per token, after a fixed reasoning cost.
		const totalBudget = Math.min(request.maxTokens ?? 32_000, model.maxTokens);
		const visible = text.slice(0, Math.max(0, totalBudget - reasoningTokens));
		return fauxAssistantMessage(
			[
				{ type: "thinking", thinking: "Condensed fixture reasoning" },
				...(visible ? [{ type: "text" as const, text: visible }] : []),
			],
			{ stopReason: visible === text ? "stop" : "length" },
		);
	};
}

describe.each(paths)("$kind shared reasoning and JSON budget", ({ kind, formerCap, expected }) => {
	it.each(["off", "high"] as const)(
		"accepts a long English trajectory on a 64k model with reasoning %s",
		async (thinkingLevel) => {
			const harness = await createHarness({
				models: [{ id: "glm-context", reasoning: true, contextWindow: 65_536, maxTokens: 16_384 }],
			});
			harnesses.push(harness);
			const content = `${"The project now stores the result locally. ".repeat(2_000)}Latest fact: preserve local state.`;
			let observedPrompt = "";
			const requests: SimpleStreamOptions[] = [];
			harness.setResponses([
				(context, options) => {
					observedPrompt = context.messages.map(getMessageText).join("");
					requests.push(options as SimpleStreamOptions);
					return fauxAssistantMessage(JSON.stringify(expected));
				},
			]);
			await expect(requestRefinement(harness, kind, content, thinkingLevel)).resolves.toEqual(expected);
			expect(observedPrompt).toContain(content.slice(-39_000));
			expect(requests[0].maxTokens).toBe(thinkingLevel === "off" ? Math.min(formerCap, 16_384) : 16_384);
		},
	);

	it.each(["off", "high"] as const)("accepts a full multibyte trajectory with reasoning %s", async (thinkingLevel) => {
		const harness = await createHarness({
			models: [{ id: "multibyte-context", reasoning: true, contextWindow: 200_000, maxTokens: 65_536 }],
		});
		harnesses.push(harness);
		const content = `${"项目记录".repeat(20_000)}最新事实`;
		harness.setResponses([fauxAssistantMessage(JSON.stringify(expected))]);
		await expect(requestRefinement(harness, kind, content, thinkingLevel)).resolves.toEqual(expected);
	});

	it.each(["界", "😀"])(
		"retains recent %s context and valid Unicode when shortening a dense trajectory",
		async (character) => {
			const harness = await createHarness({
				models: [{ id: "dense-context", reasoning: true, contextWindow: 32_768, maxTokens: 8_192 }],
			});
			harnesses.push(harness);
			const content = `${character.repeat(80_000)}Latest fact: retain the newest decision.`;
			let observedPrompt = "";
			let maxTokens: number | undefined;
			harness.setResponses([
				(context, options) => {
					observedPrompt = context.messages.map(getMessageText).join("");
					maxTokens = (options as SimpleStreamOptions).maxTokens;
					return fauxAssistantMessage(JSON.stringify(expected));
				},
			]);
			await expect(requestRefinement(harness, kind, content)).resolves.toEqual(expected);
			expect(observedPrompt).toContain("Earlier conversation omitted");
			expect(observedPrompt).toContain("Latest fact: retain the newest decision.");
			expect(observedPrompt).toContain(kind === "plan" ? "<scope_policy>" : "<trigger>");
			expect([...observedPrompt].some((point) => point.length === 1 && /[\ud800-\udfff]/u.test(point))).toBe(false);
			expect(maxTokens).toBe(8_192);
		},
	);

	it("leaves at least 60k output tokens for a long English trajectory on a 128k model", async () => {
		const harness = await createHarness({
			models: [{ id: "wide-context", reasoning: true, contextWindow: 128_000, maxTokens: 100_000 }],
		});
		harnesses.push(harness);
		const requests: SimpleStreamOptions[] = [];
		harness.setResponses([budgetedResponse(JSON.stringify(expected), 60_000, requests)]);
		await expect(requestRefinement(harness, kind, "Keep the useful project facts. ".repeat(3_000))).resolves.toEqual(
			expected,
		);
		expect(requests[0].maxTokens).toBeGreaterThan(60_000);
	});
	it.each([0, 8])("completes when the former cap leaves only %i JSON tokens", async (visibleTokens) => {
		const harness = await createHarness({
			models: [{ id: "shared-output-budget", reasoning: true, maxTokens: 65_536 }],
		});
		harnesses.push(harness);
		const requests: SimpleStreamOptions[] = [];
		const response = budgetedResponse(JSON.stringify(expected), formerCap - visibleTokens, requests);
		harness.setResponses([response, response]);

		const control = await completeSimple(
			harness.getModel(),
			{ messages: [] },
			{
				apiKey: "faux-key",
				reasoning: "low",
				maxTokens: formerCap,
			},
		);
		expect(control.stopReason).toBe("length");
		expect(
			control.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
		).toBe(JSON.stringify(expected).slice(0, visibleTokens));

		await expect(requestRefinement(harness, kind)).resolves.toEqual(expected);
		expect(requests.map((request) => request.maxTokens)).toEqual([formerCap, 65_536]);
		expect(requests.map((request) => request.reasoning)).toEqual(["low", "low"]);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("uses a small model's actual output limit", async () => {
		const harness = await createHarness({ models: [{ id: "small-budget", reasoning: true, maxTokens: 2_048 }] });
		harnesses.push(harness);
		const requests: SimpleStreamOptions[] = [];
		harness.setResponses([budgetedResponse(JSON.stringify(expected), 1_024, requests)]);

		await expect(requestRefinement(harness, kind)).resolves.toEqual(expected);
		expect(requests[0].maxTokens).toBe(2_048);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each([
		{ name: "empty trajectory", content: "", addedThinkingTokens: 0 },
		{ name: "short English words", content: "a ".repeat(40_000), addedThinkingTokens: 0 },
		{ name: "ASCII punctuation", content: "!@#$%^&*()".repeat(8_000), addedThinkingTokens: 0 },
		{ name: "multibyte trajectory", content: "界".repeat(15_000), addedThinkingTokens: 0 },
		{ name: "separate thinking allowance", content: "界".repeat(15_000), addedThinkingTokens: 16_384 },
	])(
		"reserves prompt context for equal context and output limits: $name",
		async ({ content, addedThinkingTokens }) => {
			const harness = await createHarness({
				models: [{ id: "shared-context-limit", reasoning: true, contextWindow: 131_072, maxTokens: 131_072 }],
			});
			harnesses.push(harness);
			const originalModel = structuredClone(harness.getModel());
			const requests: SimpleStreamOptions[] = [];
			let totalTokens = 0;
			harness.setResponses([
				(context, options, _state, model) => {
					const request = options as SimpleStreamOptions;
					requests.push(request);
					// Synthetic tokenizer: English words, CJK characters, and punctuation, plus message framing.
					const inputTokens =
						[context.systemPrompt ?? "", ...context.messages.map(getMessageText)]
							.join("")
							.match(/[\u4e00-\u9fff]|[A-Za-z0-9_]+|[^\s]/gu)!.length + 256;
					// Some adapters add thinking tokens before clamping to the supplied model ceiling.
					const wireMaxTokens = Math.min((request.maxTokens ?? 32_000) + addedThinkingTokens, model.maxTokens);
					totalTokens = inputTokens + wireMaxTokens;
					return fauxAssistantMessage(JSON.stringify(expected));
				},
			]);

			await expect(requestRefinement(harness, kind, content)).resolves.toEqual(expected);
			expect(totalTokens).toBeLessThanOrEqual(originalModel.contextWindow);
			expect(requests[0].maxTokens).toBeGreaterThan(formerCap);
			expect(requests[0].reasoning).toBe("low");
			expect(harness.getModel()).toEqual(originalModel);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	it("rejects a prompt with no reserved output space before calling the provider", async () => {
		const harness = await createHarness({
			models: [{ id: "no-context-space", reasoning: true, contextWindow: 1_024, maxTokens: 1_024 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage(JSON.stringify(expected))]);

		await expect(requestRefinement(harness, kind, "界".repeat(1_024))).rejects.toThrow("no room for output");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it.each([0, 8])(
		"reports exhaustion at the model limit with %i JSON tokens without retrying",
		async (visibleTokens) => {
			const harness = await createHarness({
				models: [{ id: "exhausted-budget", reasoning: true, maxTokens: 2_048 }],
			});
			harnesses.push(harness);
			const requests: SimpleStreamOptions[] = [];
			harness.setResponses([budgetedResponse(JSON.stringify(expected), 2_048 - visibleTokens, requests)]);

			await expect(requestRefinement(harness, kind)).rejects.toThrow("output budget was exhausted");
			expect(requests[0].maxTokens).toBe(2_048);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);
});
