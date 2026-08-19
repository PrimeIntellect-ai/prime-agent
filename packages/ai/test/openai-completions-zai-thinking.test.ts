import { beforeEach, describe, expect, it, vi } from "vitest";
import { clampThinkingLevel, getModel, getSupportedThinkingLevels } from "../src/models.js";
import { streamSimple } from "../src/stream.js";

const mockState = vi.hoisted(() => ({
	lastParams: undefined as unknown,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{
							data: typeof stream;
							response: { status: number; headers: Headers };
						}>;
					};
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}

	return { default: FakeOpenAI };
});

async function captureParams(
	modelId: "glm-4.7" | "glm-5.2" | "glm-5.3",
	reasoning: "off" | "low" | "high" | undefined,
) {
	await streamSimple(
		getModel("zai", modelId)!,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test", ...(reasoning ? { reasoning } : {}) },
	).result();
	return mockState.lastParams as { enable_thinking?: boolean; reasoning_effort?: string };
}

describe("z.ai thinking payload", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("maps GLM-5.3 thinking off to reasoning_effort none", () => {
		const model = getModel("zai", "glm-5.3")!;
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "high", "max"]);
		expect(clampThinkingLevel(model, "off")).toBe("off");
	});

	it("keeps GLM-5.2 disable support and exposes high/max efforts", () => {
		const model = getModel("zai", "glm-5.2")!;
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high", "max"]);
		expect(clampThinkingLevel(model, "off")).toBe("off");
	});

	it("disables GLM-5.3 thinking through reasoning_effort none", async () => {
		const params = await captureParams("glm-5.3", "off");
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("none");
	});

	it("sends the mapped effort for GLM-5.3", async () => {
		const params = await captureParams("glm-5.3", "high");
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("high");
	});

	it("disables GLM-5.2 thinking through reasoning_effort none", async () => {
		const params = await captureParams("glm-5.2", "off");
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("none");
	});

	it("clamps unsupported GLM-5.2 levels to a supported effort", async () => {
		const params = await captureParams("glm-5.2", "low");
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("high");
	});

	it("keeps thinking enabled without an effort when reasoning is unspecified for GLM-5.3", async () => {
		const params = await captureParams("glm-5.3", undefined);
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("keeps Prime Inference z.ai routes toggle-only even with an effort map", async () => {
		const model = getModel("prime-inference", "z-ai/glm-5.2")!;
		expect(model.compat?.supportsReasoningEffort).toBe(false);
		expect(model.thinkingLevelMap?.high).toBe("high");

		for (const reasoning of ["high", "off", undefined] as const) {
			await streamSimple(
				model,
				{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
				{ apiKey: "test", ...(reasoning ? { reasoning } : {}) },
			).result();

			const params = mockState.lastParams as { enable_thinking?: boolean; reasoning_effort?: string };
			expect(params.enable_thinking).toBe(reasoning === "high");
			expect(params.reasoning_effort).toBeUndefined();
		}
	});

	it("falls back to identity efforts for effort-capable models without a map", async () => {
		const base = getModel("zai", "glm-5.2")!;
		const model = { ...base, thinkingLevelMap: undefined };

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", reasoning: "high" },
		).result();
		let params = mockState.lastParams as { enable_thinking?: boolean; reasoning_effort?: string };
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("high");

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", reasoning: "off" },
		).result();
		params = mockState.lastParams as { enable_thinking?: boolean; reasoning_effort?: string };
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe("none");
	});

	it("keeps the enable_thinking toggle for effort-less GLM models", async () => {
		const enabled = await captureParams("glm-4.7", "high");
		expect(enabled.enable_thinking).toBe(true);
		expect(enabled.reasoning_effort).toBeUndefined();

		const disabled = await captureParams("glm-4.7", "off");
		expect(disabled.enable_thinking).toBe(false);
		expect(disabled.reasoning_effort).toBeUndefined();
	});
});
