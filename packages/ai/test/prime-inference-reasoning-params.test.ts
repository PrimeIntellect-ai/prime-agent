import { beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model } from "../src/types.js";

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
							yield { choices: [{ delta: {}, finish_reason: "stop" }] };
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

// Mirrors the live z-ai/glm-5.3 route: reasoning and reasoning_effort are
// declared, enable_thinking is not, and the route accepts low/high/max only.
const glmEffortRoute: Model<"openai-completions"> = {
	id: "z-ai/glm-5.3",
	name: "GLM 5.3",
	api: "openai-completions",
	provider: "prime-inference",
	baseUrl: "https://api.pinference.ai/api/v1",
	reasoning: true,
	thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_048_576,
	maxTokens: 131_072,
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
	},
};

// Mirrors a live toggle-only route such as z-ai/glm-5.1: reasoning is declared
// without reasoning_effort or enable_thinking.
const glmToggleRoute: Model<"openai-completions"> = {
	...glmEffortRoute,
	id: "z-ai/glm-5.1",
	thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
	compat: {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		thinkingFormat: "openrouter",
	},
};

// The z.ai coding-plan provider still drives reasoning through enable_thinking.
const zaiProviderModel: Model<"openai-completions"> = {
	...glmEffortRoute,
	id: "glm-5.2",
	provider: "zai",
	baseUrl: "https://api.z.ai/api/coding/paas/v4",
	thinkingLevelMap: undefined,
	compat: { supportsDeveloperRole: false, thinkingFormat: "zai" },
};

function requestParams(model: Model<"openai-completions">, reasoning?: "off" | "low" | "medium" | "high" | "xhigh") {
	return streamSimple(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
		{ apiKey: "test", ...(reasoning ? { reasoning } : {}) },
	).result();
}

describe("Prime Inference reasoning request serialization", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("sends only the declared reasoning parameter for effort routes", async () => {
		await requestParams(glmEffortRoute, "high");

		const params = mockState.lastParams as Record<string, unknown>;
		expect(params.reasoning_effort).toBe("high");
		expect("enable_thinking" in params).toBe(false);
		expect("reasoning" in params).toBe(false);
		expect("thinking" in params).toBe(false);
	});

	it("clamps undeclared efforts to the declared set", async () => {
		await requestParams(glmEffortRoute, "medium");
		expect((mockState.lastParams as Record<string, unknown>).reasoning_effort).toBe("high");

		await requestParams(glmEffortRoute, "xhigh");
		expect((mockState.lastParams as Record<string, unknown>).reasoning_effort).toBe("max");

		// The route is mandatory, so an off request clamps to the lowest declared effort.
		await requestParams(glmEffortRoute, "off");
		const offParams = mockState.lastParams as Record<string, unknown>;
		expect(offParams.reasoning_effort).toBe("low");
		expect("enable_thinking" in offParams).toBe(false);
	});

	it("toggles reasoning through the declared reasoning object on toggle-only routes", async () => {
		await requestParams(glmToggleRoute, "high");
		expect((mockState.lastParams as Record<string, unknown>).reasoning).toEqual({ enabled: true });
		expect((mockState.lastParams as Record<string, unknown>).enable_thinking).toBeUndefined();

		await requestParams(glmToggleRoute, "off");
		expect((mockState.lastParams as Record<string, unknown>).reasoning).toEqual({ enabled: false });
		expect((mockState.lastParams as Record<string, unknown>).enable_thinking).toBeUndefined();
	});

	it("keeps enable_thinking for the z.ai provider", async () => {
		await requestParams(zaiProviderModel, "high");

		const params = mockState.lastParams as Record<string, unknown>;
		expect(params.enable_thinking).toBe(true);
		expect("reasoning_effort" in params).toBe(false);

		await requestParams(zaiProviderModel, "off");
		expect((mockState.lastParams as Record<string, unknown>).enable_thinking).toBe(false);
	});
});
