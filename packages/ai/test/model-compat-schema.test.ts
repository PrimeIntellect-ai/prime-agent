import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { ProviderCompatSchema } from "../src/model-compat-schema.js";

describe("provider compatibility schema", () => {
	test("validates known fields while allowing provider extensions", () => {
		expect(Value.Check(ProviderCompatSchema, { supportsDeveloperRole: false })).toBe(true);
		expect(Value.Check(ProviderCompatSchema, { supportsDeveloperRole: "false" })).toBe(false);
		expect(Value.Check(ProviderCompatSchema, { providerExtension: "value" })).toBe(true);
	});
});
