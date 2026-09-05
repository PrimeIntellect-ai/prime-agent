import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { isModelCompat, ProviderCompatSchema } from "../src/model-compat-schema.js";

describe("provider compatibility schema", () => {
	test("validates known fields while allowing provider extensions", () => {
		expect(Value.Check(ProviderCompatSchema, { supportsDeveloperRole: false })).toBe(true);
		expect(Value.Check(ProviderCompatSchema, { supportsDeveloperRole: "false" })).toBe(false);
		expect(Value.Check(ProviderCompatSchema, { providerExtension: "value" })).toBe(true);
	});

	test("defines compatibility handling for every bundled API", () => {
		for (const api of [
			"mistral-conversations",
			"azure-openai-responses",
			"openai-codex-responses",
			"bedrock-converse-stream",
			"google-generative-ai",
			"google-vertex",
		]) {
			expect(isModelCompat(api, undefined)).toBe(true);
			expect(isModelCompat(api, {})).toBe(false);
		}
		expect(isModelCompat("future-api", undefined)).toBe(false);
	});
});
