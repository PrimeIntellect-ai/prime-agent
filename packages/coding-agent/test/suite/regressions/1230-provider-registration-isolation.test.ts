import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices } from "../../../src/core/agent-session-services.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";

describe("issue #1230 provider registration isolation", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	it("skips an unavailable provider without blocking valid providers", async () => {
		vi.stubEnv("UNAVAILABLE_PROVIDER_KEY", "");
		const tempDir = join(tmpdir(), `pi-1230-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ provider: "available-provider" });
		cleanups.push(() => {
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			noBuiltinHerdrReporter: true,
			telemetryDisabled: true,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi) => {
						pi.registerProvider("unavailable-provider", {
							baseUrl: "https://unavailable-provider.test/v1",
							apiKey: process.env.UNAVAILABLE_PROVIDER_KEY ?? "",
							api: "openai-completions",
							models: [
								{
									id: "unavailable-model",
									name: "Unavailable Model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 128000,
									maxTokens: 4096,
								},
							],
						});
					},
					(pi) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models,
						});
					},
				],
				noPromptTemplates: true,
				noSkills: true,
				noThemes: true,
			},
		});

		expect(services.modelRegistry.find(faux.getModel().provider, faux.getModel().id)).toBeDefined();
		expect(services.modelRegistry.find("unavailable-provider", "unavailable-model")).toBeUndefined();
		expect(services.diagnostics).toContainEqual({
			type: "warning",
			message: expect.stringMatching(/unavailable-provider.*apiKey.*oauth/),
		});
		expect(services.diagnostics).not.toContainEqual(expect.objectContaining({ type: "error" }));
	});
});
