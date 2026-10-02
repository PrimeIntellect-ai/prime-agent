import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel } from "../src/models.js";

const originalFireworksApiKey = process.env.FIREWORKS_API_KEY;

afterEach(() => {
	if (originalFireworksApiKey === undefined) {
		delete process.env.FIREWORKS_API_KEY;
	} else {
		process.env.FIREWORKS_API_KEY = originalFireworksApiKey;
	}
});

describe("Fireworks models", () => {
	it("registers the default Kimi K3 model via Anthropic-compatible Messages API", () => {
		const model = getModel("fireworks", "accounts/fireworks/models/kimi-k3");

		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
		expect(model.provider).toBe("fireworks");
		expect(model.baseUrl).toBe("https://api.fireworks.ai/inference");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.contextWindow).toBe(1048576);
		expect(model.maxTokens).toBe(131072);
		expect(model.cost).toEqual({
			input: 3,
			output: 15,
			cacheRead: 0.3,
			cacheWrite: 0,
		});
	});

	it("registers the Kimi Fast Latest router model", () => {
		const model = getModel("fireworks", "accounts/fireworks/routers/kimi-fast-latest");

		expect(model).toBeDefined();
		expect(model.api).toBe("anthropic-messages");
		expect(model.baseUrl).toBe("https://api.fireworks.ai/inference");
		expect(model.input).toEqual(["text", "image"]);
	});

	it("resolves FIREWORKS_API_KEY from the environment", () => {
		process.env.FIREWORKS_API_KEY = "test-fireworks-key";

		expect(findEnvKeys("fireworks")).toEqual(["FIREWORKS_API_KEY"]);
		expect(getEnvApiKey("fireworks")).toBe("test-fireworks-key");
	});
});
