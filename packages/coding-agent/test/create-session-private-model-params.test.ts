import { getModels, type Model, streamSimple } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCliModel } from "../src/core/model-resolver.js";
import { getPrivatePrimeInferenceModels } from "../src/core/prime-inference-models.js";

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
									prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
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

describe("created-session private model request params", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	// The registry a daemon worker builds for a fresh session: bundled public
	// catalog plus bundled private models, without the team-authorized private
	// catalog that only loads after refreshAvailableModels(). This is what an
	// rlm.create_session session resolves its provider/model strings against.
	const freshWorkerRegistry = {
		getAll: () => [...getModels("prime-inference"), ...getPrivatePrimeInferenceModels()],
	} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

	it("omits enable_thinking for an internal model resolved like a created session", async () => {
		const resolved = resolveCliModel({
			cliProvider: "prime-inference",
			cliModel: "internal/glm-5.3-fast",
			modelRegistry: freshWorkerRegistry,
		});
		expect(resolved.error).toBeUndefined();
		const model = resolved.model as Model<"openai-completions">;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = mockState.lastParams as { model?: string; enable_thinking?: boolean };
		expect(params.model).toBe("internal/glm-5.3-fast");
		expect("enable_thinking" in params).toBe(false);
	});

	it("omits enable_thinking for public Prime Inference z-ai models", async () => {
		const model = getModels("prime-inference").find(
			(candidate) => candidate.id === "z-ai/glm-5.3",
		) as Model<"openai-completions">;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
			{ apiKey: "test", reasoning: "high" },
		).result();

		const params = mockState.lastParams as { enable_thinking?: boolean };
		expect("enable_thinking" in params).toBe(false);
	});
});
