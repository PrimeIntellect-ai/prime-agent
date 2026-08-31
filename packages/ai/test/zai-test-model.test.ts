import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.js";

let models: Model<"openai-completions">[] = [];

vi.mock("../src/models.js", () => ({
	getModels: () => models,
}));

import { getZaiTestModel } from "./zai-test-model.js";

function createZaiModel(id: string, contextWindow: number, zaiToolStream = true): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "zai",
		baseUrl: "https://api.z.ai/api/coding/paas/v4",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens: 4096,
		compat: { zaiToolStream },
	};
}

describe("getZaiTestModel", () => {
	beforeEach(() => {
		models = [
			createZaiModel("glm-4.7", 204800),
			createZaiModel("glm-5-turbo", 200000),
			createZaiModel("glm-5.2", 1000000),
		];
	});

	it("prefers the current general-purpose model", () => {
		expect(getZaiTestModel().id).toBe("glm-5.2");
	});

	it("selects the smallest live context window for overflow tests", () => {
		const model = getZaiTestModel({ smallestContextWindow: true });

		expect(model.id).toBe("glm-5-turbo");
		expect(model.contextWindow).toBe(200000);
	});

	it("selects a tool-stream-capable model when required", () => {
		models = [createZaiModel("glm-5.2", 1000000, false), createZaiModel("glm-4.7", 204800)];

		expect(getZaiTestModel({ toolStream: true }).id).toBe("glm-4.7");
	});
});
