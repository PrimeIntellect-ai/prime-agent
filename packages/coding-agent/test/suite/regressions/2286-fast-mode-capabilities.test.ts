import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, fauxAssistantMessage, type ServiceTier, supportsFastMode } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createTestResourceLoader } from "../../utilities.js";
import { createHarness, type Harness } from "../harness.js";

const supportedBackends = [
	{ provider: "openai-codex", api: "openai-codex-responses" },
	{ provider: "openai", api: "openai-responses" },
] satisfies Array<{ provider: string; api: Api }>;

const unsupportedBackends = [
	{ provider: "openai-codex", api: "openai-responses" },
	{ provider: "openai", api: "openai-completions" },
	{ provider: "custom-provider", api: "openai-codex-responses" },
	{ provider: "custom-provider", api: "openai-responses" },
	{ provider: "anthropic", api: "anthropic-messages" },
] satisfies Array<{ provider: string; api: Api }>;

describe("Fast mode capabilities", () => {
	let tempDir: string;
	let harness: Harness | undefined;
	const sessions: AgentSession[] = [];
	const fetchMock = vi.fn(() => Promise.reject(new Error("Unexpected network request")));

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-fast-capabilities-"));
		vi.stubEnv("PI_OFFLINE", "1");
		fetchMock.mockClear();
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		harness?.cleanup();
		harness = undefined;
		rmSync(tempDir, { recursive: true, force: true });
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each(supportedBackends)("honors $provider JSON overrides and refreshes explicit empty tiers", ({ provider }) => {
		const modelsPath = join(tempDir, "models.json");
		const writeOverride = (supportedServiceTiers: string[]) => {
			writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: { [provider]: { modelOverrides: { "gpt-5.4": { supportedServiceTiers } } } },
				}),
			);
		};
		writeOverride(["priority"]);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		expect(registry.getError()).toBeUndefined();
		expect(registry.find(provider, "gpt-5.4")?.supportedServiceTiers).toEqual(["priority"]);
		expect(supportsFastMode(registry.find(provider, "gpt-5.4")!)).toBe(true);

		writeOverride([]);
		registry.refresh();
		expect(registry.getError()).toBeUndefined();
		expect(registry.find(provider, "gpt-5.4")?.supportedServiceTiers).toEqual([]);
		expect(supportsFastMode(registry.find(provider, "gpt-5.4")!)).toBe(false);

		writeOverride(["priority"]);
		registry.refresh();
		expect(registry.getError()).toBeUndefined();
		expect(supportsFastMode(registry.find(provider, "gpt-5.4")!)).toBe(true);
	});

	it.each(supportedBackends)("loads advertised tiers on new $provider model definitions", ({ provider, api }) => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					[provider]: {
						api,
						models: [
							{ id: "advertised-fast-model", supportedServiceTiers: ["default", "priority"] },
							{ id: "explicitly-disabled-model", supportedServiceTiers: [] },
							{ id: "unknown-model" },
						],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		for (let pass = 0; pass < 2; pass++) {
			expect(registry.getError()).toBeUndefined();
			expect(registry.find(provider, "advertised-fast-model")?.supportedServiceTiers).toEqual([
				"default",
				"priority",
			]);
			expect(supportsFastMode(registry.find(provider, "advertised-fast-model")!)).toBe(true);
			expect(registry.find(provider, "explicitly-disabled-model")?.supportedServiceTiers).toEqual([]);
			expect(supportsFastMode(registry.find(provider, "explicitly-disabled-model")!)).toBe(false);
			expect(supportsFastMode(registry.find(provider, "unknown-model")!)).toBe(false);
			if (pass === 0) registry.refresh();
		}
	});

	it.each(unsupportedBackends)("does not enable $provider / $api through JSON metadata", ({ provider, api }) => {
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					[provider]: {
						api,
						baseUrl: "http://localhost:0",
						apiKey: "faux-key",
						models: [{ id: "gpt-6-astra", supportedServiceTiers: ["priority"] }],
					},
				},
			}),
		);
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		expect(registry.getError()).toBeUndefined();
		const model = registry.find(provider, "gpt-6-astra");
		expect(model?.supportedServiceTiers).toEqual(["priority"]);
		expect(supportsFastMode(model!)).toBe(false);
	});

	it.each([
		{ tiers: ["priority"], enabled: true },
		{ tiers: [], enabled: false },
	])("preserves extension-registered tiers $tiers across refresh", async ({ tiers, enabled }) => {
		harness = await createHarness({
			provider: "openai-codex",
			api: "openai-codex-responses",
			models: [{ id: "extension-model" }],
			extensionFactories: [
				(pi) => {
					pi.registerProvider("openai-codex", {
						api: "openai-codex-responses",
						apiKey: "faux-key",
						baseUrl: "http://localhost:0",
						models: [
							{
								id: "extension-model",
								name: "Extension Model",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 128000,
								maxTokens: 16384,
								supportedServiceTiers: tiers,
							},
						],
					});
				},
			],
		});
		const registry = harness.session.modelRegistry;
		const model = registry.find("openai-codex", "extension-model");
		expect(model?.supportedServiceTiers).toEqual(tiers);
		expect(supportsFastMode(model!)).toBe(enabled);
		await harness.session.setModel(model!);
		harness.session.setServiceTier("priority");
		expect(harness.session.serviceTier).toBe(enabled ? "priority" : "default");

		registry.refresh();
		const refreshed = registry.find("openai-codex", "extension-model");
		expect(refreshed?.supportedServiceTiers).toEqual(tiers);
		expect(supportsFastMode(refreshed!)).toBe(enabled);
	});

	it("keeps GPT-6 Astra Fast mode through toggles, model switches, and persisted resume", async () => {
		harness = await createHarness({
			provider: "openai-codex",
			api: "openai-codex-responses",
			models: [{ id: "gpt-6-astra" }, { id: "gpt-5.3" }],
			persistSession: true,
			tools: [],
		});
		const astra = harness.getModel("gpt-6-astra")!;
		expect(supportsFastMode(astra)).toBe(true);
		harness.session.setServiceTier("priority");
		expect(harness.session.serviceTier).toBe("priority");
		harness.session.setServiceTier("default");
		expect(harness.session.serviceTier).toBe("default");
		harness.session.setServiceTier("priority");

		await harness.session.setModel(harness.getModel("gpt-5.3")!);
		expect(harness.session.serviceTier).toBe("default");
		await harness.session.setModel(astra);
		expect(harness.session.serviceTier).toBe("priority");

		const requestedTiers: Array<ServiceTier | undefined> = [];
		harness.setResponses([
			(_context, options) => {
				requestedTiers.push(options?.serviceTier);
				return fauxAssistantMessage("Fast response");
			},
		]);
		await harness.session.prompt("Check Fast mode");
		expect(requestedTiers).toEqual(["priority"]);
		expect(harness.session.getLastAssistantText()).toBe("Fast response");
		const sessionFile = harness.session.sessionFile;
		expect(sessionFile).toBeDefined();
		harness.session.dispose();

		const sessionManager = SessionManager.open(sessionFile!);
		expect(sessionManager.buildSessionContext().serviceTier).toBe("priority");
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: harness.tempDir,
			authStorage: harness.authStorage,
			modelRegistry: harness.session.modelRegistry,
			resourceLoader: createTestResourceLoader(),
			sessionManager,
			settingsManager: harness.settingsManager,
			noTools: "all",
		});
		sessions.push(session);
		expect(modelFallbackMessage).toBeUndefined();
		expect(session.model?.id).toBe("gpt-6-astra");
		expect(session.serviceTier).toBe("priority");
		expect(session.sessionManager.buildSessionContext().serviceTier).toBe("priority");
	});
});
