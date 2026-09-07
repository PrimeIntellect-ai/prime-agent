import { afterEach, describe, expect, it } from "vitest";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.js";
import { getModel, getProviders } from "../src/models.js";

const originalKiloApiKey = process.env.KILO_API_KEY;
const originalClineApiKey = process.env.CLINE_API_KEY;

afterEach(() => {
	if (originalKiloApiKey === undefined) delete process.env.KILO_API_KEY;
	else process.env.KILO_API_KEY = originalKiloApiKey;
	if (originalClineApiKey === undefined) delete process.env.CLINE_API_KEY;
	else process.env.CLINE_API_KEY = originalClineApiKey;
});

describe("gateway providers", () => {
	it("registers Kilo Code and Cline models", () => {
		const kilo = getModel("kilocode", "kilo-auto/balanced");
		expect(kilo).toBeDefined();
		expect(kilo.api).toBe("openai-completions");
		expect(kilo.provider).toBe("kilocode");
		expect(kilo.baseUrl).toBe("https://api.kilo.ai/api/gateway");

		const cline = getModel("cline", "anthropic/claude-sonnet-4.6");
		expect(cline).toBeDefined();
		expect(cline.api).toBe("openai-completions");
		expect(cline.provider).toBe("cline");
		expect(cline.baseUrl).toBe("https://api.cline.bot/api/v1");

		expect(getProviders()).toEqual(expect.arrayContaining(["kilocode", "cline"]));
	});

	it("resolves Kilo and Cline API keys from the environment", () => {
		process.env.KILO_API_KEY = "test-kilo-key";
		process.env.CLINE_API_KEY = "test-cline-key";

		expect(findEnvKeys("kilocode")).toEqual(["KILO_API_KEY"]);
		expect(getEnvApiKey("kilocode")).toBe("test-kilo-key");
		expect(findEnvKeys("cline")).toEqual(["CLINE_API_KEY"]);
		expect(getEnvApiKey("cline")).toBe("test-cline-key");
	});
});
