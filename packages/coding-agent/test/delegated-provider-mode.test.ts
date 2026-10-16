import { getApiProvider, resetApiProviders } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

describe("delegated provider runtime mode", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
		resetApiProviders();
	});

	it("exposes model availability without loading credentials and blocks sandbox login writes", async () => {
		vi.stubEnv("PRIME_PROVIDER_BROKER_SOCKET", "/run/pi-cad/provider/provider.sock");
		vi.stubEnv("PRIME_PROVIDER_BROKER_CAPABILITY", "delegated-capability-with-enough-entropy-1234567890");
		const authStorage = AuthStorage.inMemory();
		const registry = ModelRegistry.inMemory(authStorage);
		const model = registry.getAll().find((candidate) => candidate.provider === "anthropic")!;

		expect(registry.getAvailable()).toContain(model);
		expect(registry.hasConfiguredAuth(model)).toBe(true);
		expect(registry.getProviderAuthStatus(model.provider)).toEqual({ configured: true, source: "runtime" });
		await expect(registry.getApiKeyAndHeaders(model)).resolves.toEqual({
			ok: true,
			apiKey: "delegated-provider-request",
			headers: undefined,
		});
		expect(() => authStorage.set("anthropic", { type: "api_key", key: "sandbox-key" })).toThrow("trusted host");
		expect(() => authStorage.setPrimeInferenceApiKey("sandbox-key")).toThrow("trusted host");
	});

	it("replaces the registered provider with the host adapter", async () => {
		vi.stubEnv("PRIME_PROVIDER_BROKER_SOCKET", "/run/pi-cad/provider/provider.sock");
		vi.stubEnv("PRIME_PROVIDER_BROKER_CAPABILITY", "delegated-capability-with-enough-entropy-1234567890");
		const before = getApiProvider("openai-responses");
		const { installDelegatedProviderAdapters, getDelegatedProviderOptionsFromEnvironment } = await import(
			"@earendil-works/pi-ai"
		);
		const options = getDelegatedProviderOptionsFromEnvironment();
		expect(options).toEqual({
			socketPath: "/run/pi-cad/provider/provider.sock",
			capability: "delegated-capability-with-enough-entropy-1234567890",
		});
		installDelegatedProviderAdapters(options!);
		const after = getApiProvider("openai-responses");
		expect(after).toBeDefined();
		expect(after).not.toBe(before);
	});
});
