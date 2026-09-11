import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type HarnessState, planRefinement, reviewAutoRefine } from "../../../src/core/refinement/refinement.js";
import { type SideQuestionEvent, startSideQuestion } from "../../../src/core/side-question.js";
import { createHarness, type Harness } from "../harness.js";

const harnesses: Harness[] = [];
const noRetry = { enabled: false, maxRetries: 0, baseDelayMs: 1, maxRetryDelayMs: 1 };
const proposal = { summary: "No change", rationale: "Fixture", expectedOutcome: "No change", edits: [] };
const review = { shouldRefine: false, rationale: "No reusable lesson" };

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface ReasoningCase {
	name: string;
	reasoning: boolean;
	parentLevel: ThinkingLevel;
	expectedLevel: ThinkingLevel;
	omitRefinementLevel?: boolean;
	thinkingLevelMap?: Model<string>["thinkingLevelMap"];
}

const cases: ReasoningCase[] = [
	{
		name: "enabled session with incomplete capability metadata",
		reasoning: true,
		parentLevel: "high",
		expectedLevel: "low",
	},
	{ name: "minimal session", reasoning: true, parentLevel: "minimal", expectedLevel: "minimal" },
	{ name: "explicit off supported", reasoning: true, parentLevel: "off", expectedLevel: "off" },
	{ name: "non-reasoning model", reasoning: false, parentLevel: "high", expectedLevel: "off" },
	{
		name: "refinement caller without a thinking preference",
		reasoning: true,
		parentLevel: "high",
		expectedLevel: "low",
		omitRefinementLevel: true,
	},
	{
		name: "off and minimal unsupported",
		reasoning: true,
		parentLevel: "off",
		expectedLevel: "low",
		thinkingLevelMap: { off: null, minimal: null },
	},
	{
		name: "only high supported",
		reasoning: true,
		parentLevel: "high",
		expectedLevel: "high",
		thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
	},
];

describe("auxiliary reasoning settings", () => {
	it.each(cases)("completes refinement, review, and side questions: $name", async (testCase) => {
		const harness = await createHarness({
			models: [
				{ id: "reasoning-contract", reasoning: testCase.reasoning, contextWindow: 262_144, maxTokens: 128_000 },
			],
		});
		harnesses.push(harness);
		const parent = harness.session.agent;
		const model = harness.getModel();
		model.thinkingLevelMap = testCase.thinkingLevelMap;
		parent.state.thinkingLevel = testCase.parentLevel;
		const parentMessages = structuredClone(parent.state.messages);
		const observed: SimpleStreamOptions[] = [];
		// Side questions keep the session level (cache identity); the first two calls clamp.
		const expectedLevels: ThinkingLevel[] = [testCase.expectedLevel, testCase.expectedLevel, testCase.parentLevel];
		harness.setResponses(
			[JSON.stringify(proposal), JSON.stringify(review), "Side answer"].map((text, index) => (_context, options) => {
				const request = options as SimpleStreamOptions;
				observed.push(request);
				if (request.reasoning !== expectedLevels[index]) {
					return fauxAssistantMessage("", {
						stopReason: "error",
						errorMessage: `Unsupported auxiliary reasoning: ${request.reasoning}`,
					});
				}
				return fauxAssistantMessage([
					{ type: "thinking", thinking: "Fixture reasoning" },
					{ type: "text", text },
				]);
			}),
		);
		const state: HarnessState = {
			schema: 1,
			entries: { prompt: {}, memory: {}, skill: {}, subagent: {} },
			refinements: [],
		};
		const messages = [{ role: "user" as const, content: "Remember the result", timestamp: 1 }];
		await expect(
			planRefinement(
				messages,
				state,
				[],
				model,
				"faux-key",
				{ retry: noRetry },
				undefined,
				undefined,
				testCase.omitRefinementLevel ? undefined : testCase.parentLevel,
			),
		).resolves.toMatchObject({ proposal });
		await expect(
			reviewAutoRefine(
				messages,
				state,
				[],
				model,
				"faux-key",
				{ reason: "turn_interval", turnsSinceLastReview: 5 },
				undefined,
				undefined,
				testCase.omitRefinementLevel ? undefined : testCase.parentLevel,
				noRetry,
			),
		).resolves.toMatchObject(review);
		const events: SideQuestionEvent[] = [];
		await startSideQuestion(
			parent,
			"side",
			"What happened?",
			(event) => {
				events.push(event);
			},
			[],
			noRetry,
		).done;
		expect(events.at(-1)).toMatchObject({ status: "complete", answer: "Side answer" });
		expect(observed.map((options) => options.reasoning)).toEqual(expectedLevels);
		expect(observed[0].maxTokens).toBe(testCase.expectedLevel === "off" ? 32_000 : model.maxTokens);
		expect(observed[1].maxTokens).toBe(testCase.expectedLevel === "off" ? 4_096 : model.maxTokens);
		expect(parent.state.thinkingLevel).toBe(testCase.parentLevel);
		expect(parent.state.messages).toEqual(parentMessages);
	});
});
