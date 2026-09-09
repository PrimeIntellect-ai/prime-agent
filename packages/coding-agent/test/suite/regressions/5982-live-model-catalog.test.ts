import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createModelCatalog,
	fauxAssistantMessage,
	getApiProvider,
	getModel,
	getModels,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { MODEL_CATALOG_REFRESH_INTERVAL_MS } from "../../../src/core/model-catalog-cache.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import {
	findInitialModel,
	resolveCliModelFromCatalog,
	restoreModelFromSession,
} from "../../../src/core/model-resolver.js";
import { PROVIDER_MODEL_CATALOG_URL, parseProviderModelCatalog } from "../../../src/core/provider-model-catalog.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import { createDefaultRuntimeFactory } from "../../../src/main.js";
import { createHarness, type Harness } from "../harness.js";

const primeUrl = "https://api.pinference.ai/api/v1/models";
const newProviderModel = {
	...getModel("openai", "gpt-5.5"),
	id: "catalog-new",
	name: "Catalog New",
	reasoning: false,
	contextWindow: 67_890,
	maxTokens: 12_345,
};
const providerPayload = createModelCatalog([newProviderModel]);
function primeEntry(id: string, model?: Model<"openai-completions">) {
	return {
		id,
		display_name: model?.name ?? id,
		pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
		specs: {
			context_window: model?.contextWindow ?? 200_000,
			max_output_tokens: model?.maxTokens ?? 20_000,
			supports_reasoning: model?.reasoning ?? false,
			modalities: { input: model?.input ?? ["text"], output: ["text"] },
		},
	};
}
const publicEntries = [
	...getModels("prime-inference").map((model) => primeEntry(model.id, model)),
	primeEntry("test/new-public"),
];
const primePayload = {
	data: [...publicEntries, { ...primeEntry("internal/new-private"), display_name: "Catalog Private" }],
};
const json = (payload: unknown) => new Response(JSON.stringify(payload));

describe("ENG-5982 live model catalogs", () => {
	let harness: Harness;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let modelsPath: string;
	const fetchFn = vi.fn<typeof fetch>();

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		fetchFn.mockReset().mockImplementation(async (url, init) => {
			if (url === PROVIDER_MODEL_CATALOG_URL) return json(providerPayload);
			if (url === primeUrl)
				return json(new Headers(init?.headers).has("Authorization") ? primePayload : { data: publicEntries });
			throw new Error(`Unexpected request: ${url}`);
		});
		vi.stubGlobal("fetch", fetchFn);
		harness = await createHarness({ models: [{ id: "first" }, { id: "second" }] });
		auth = AuthStorage.inMemory({
			openai: { type: "api_key", key: "openai-test-key" },
			"prime-inference": { type: "api_key", key: "prime-test-key", primeTeam: { teamId: "team-a", name: "Team A" } },
		});
		modelsPath = join(harness.tempDir, "models.json");
		registry = ModelRegistry.create(auth, modelsPath);
		fetchFn.mockClear();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	test("renders the local catalog before either network response, then publishes both catalogs", async () => {
		const complete: Array<() => void> = [];
		fetchFn.mockImplementation(
			(url) =>
				new Promise<Response>((resolve) =>
					complete.push(() => resolve(json(url === primeUrl ? primePayload : providerPayload))),
				),
		);
		const cached = await registry.refreshModelCatalog();
		expect(cached.models.some((model) => model.id === "catalog-new")).toBe(false);
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
		const refreshed = registry.refreshAvailableModels({ background: false });
		await Promise.resolve();
		for (const finish of complete) finish();
		const models = await refreshed;
		expect(models.map((model) => model.id)).toEqual(
			expect.arrayContaining(["catalog-new", "test/new-public", "internal/new-private"]),
		);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		const primeRequest = fetchFn.mock.calls.find(([url]) => url === primeUrl);
		expect(new Headers(primeRequest?.[1]?.headers).get("authorization")).toBe("Bearer prime-test-key");
		expect(
			new Headers(fetchFn.mock.calls.find(([url]) => url === PROVIDER_MODEL_CATALOG_URL)?.[1]?.headers).has(
				"authorization",
			),
		).toBe(false);
	});

	test("starts and resumes with a cached model while catalog requests are pending", async () => {
		await registry.refreshAvailableModels({ background: false });
		const complete: Array<() => void> = [];
		fetchFn.mockImplementation(
			(url) =>
				new Promise<Response>((resolve) =>
					complete.push(() => resolve(json(url === primeUrl ? primePayload : providerPayload))),
				),
		);
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "openai",
			defaultModelId: "catalog-new",
			modelRegistry: registry,
		});
		expect(initial.model?.id).toBe("catalog-new");
		const restored = await restoreModelFromSession("openai", "catalog-new", undefined, false, registry);
		expect(restored.model?.id).toBe("catalog-new");
		for (const finish of complete) finish();
		await registry.refreshAvailableModels({ background: false });
	});

	test("restores one full Prime snapshot and one provider snapshot offline", async () => {
		await registry.refreshAvailableModels({ background: false });
		const files = readdirSync(harness.tempDir).filter((file) => file.endsWith("catalog.v1.json"));
		expect(files.sort()).toEqual(["prime-inference-catalog.v1.json", "provider-model-catalog.v1.json"]);
		const disk = readFileSync(join(harness.tempDir, "prime-inference-catalog.v1.json"), "utf8");
		expect(disk).toContain("test/new-public");
		expect(disk).toContain("internal/new-private");
		expect(disk).not.toContain("prime-test-key");
		vi.stubEnv("PI_OFFLINE", "1");
		fetchFn.mockClear();
		const restored = ModelRegistry.create(auth, modelsPath);
		expect((await restored.refreshModelCatalog()).models.map((model) => model.id)).toEqual(
			expect.arrayContaining(["catalog-new", "test/new-public", "internal/new-private"]),
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test.each([
		["openai", "catalog-new", "Catalog New"],
		["prime-inference", "internal/new-private", "Catalog Private"],
	])("restores cached %s metadata through the production startup factory", async (provider, model, name) => {
		auth.setRuntimeApiKey(provider, "catalog-test-key");
		await registry.refreshAvailableModels({ background: false });
		const factory = createDefaultRuntimeFactory({
			provider,
			model,
			apiKey: "catalog-test-key",
			noTools: true,
			noExtensions: true,
			noSkills: true,
			noContextFiles: true,
			noPromptTemplates: true,
			noThemes: true,
			telemetryDisabled: true,
		});
		const created = await factory({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			sessionOptions: { rlmDepth: 1 },
		});
		try {
			expect(created.session.model).toMatchObject({ provider, id: model, name });
			expect(created.diagnostics).not.toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "warning" })]),
			);
			if (provider === "prime-inference") {
				expect(created.session.model).toMatchObject({ contextWindow: 200_000, maxTokens: 20_000 });
				const request = fetchFn.mock.calls.find(([url]) => url === primeUrl);
				expect(new Headers(request?.[1]?.headers).get("authorization")).toBe("Bearer catalog-test-key");
			}
		} finally {
			created.session.dispose();
		}
	});

	test.each([
		["openai", "catalog-new"],
		["prime-inference", "internal/new-private"],
	])("does not wait or substitute metadata for an uncached saved %s model", async (provider, id) => {
		const complete: Array<() => void> = [];
		fetchFn.mockImplementation(
			(url) =>
				new Promise<Response>((resolve) =>
					complete.push(() => resolve(json(url === primeUrl ? primePayload : providerPayload))),
				),
		);
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: provider,
			defaultModelId: id,
			modelRegistry: registry,
		});
		expect(initial.model).toBeUndefined();
		expect(initial.fallbackMessage).toContain(`${provider}/${id} has no local catalog metadata`);
		const restored = await restoreModelFromSession(provider, id, getModel("openai", "gpt-5.5"), false, registry);
		expect(restored.model).toBeUndefined();
		expect(restored.fallbackMessage).toContain(`${provider}/${id} has no local catalog metadata`);
		await vi.waitFor(() => expect(complete).toHaveLength(2));
		const refresh = registry.refreshAvailableModels({ background: false });
		for (const finish of complete) finish();
		await refresh;
		expect(registry.find(provider, id)).toBeDefined();
		expect(initial.model).toBeUndefined();
	});

	test("retains the actual active model metadata when restoring the same model after cache loss", async () => {
		const restored = await restoreModelFromSession("openai", "catalog-new", newProviderModel, false, registry);
		expect(restored.model).toBe(newProviderModel);
		expect(restored.fallbackMessage).toBeUndefined();
		await registry.refreshAvailableModels({ background: false });
	});

	test("SDK resume does not silently select another model when saved metadata is missing", async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		harness.sessionManager.appendModelChange("openai", "catalog-new");
		harness.sessionManager.appendMessage({ role: "user", content: "saved prompt", timestamp: Date.now() });
		const created = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			sessionManager: harness.sessionManager,
			authStorage: auth,
			modelRegistry: registry,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			noTools: "all",
			rlmDepth: 1,
		});
		try {
			expect(created.session.model).toMatchObject({
				id: "unknown",
				contextWindow: 0,
				maxTokens: 0,
				reasoning: false,
			});
			expect(created.modelFallbackMessage).toContain("openai/catalog-new has no local catalog metadata");
			expect(harness.sessionManager.buildSessionContext().model).toEqual({
				provider: "openai",
				modelId: "catalog-new",
			});
		} finally {
			created.session.dispose();
		}
	});

	test("cycles and submits with the selected model while both catalogs are stalled", async () => {
		const complete: Array<() => void> = [];
		fetchFn.mockImplementation(
			() => new Promise<Response>((resolve) => complete.push(() => resolve(new Response(null, { status: 503 })))),
		);
		const stream = getApiProvider(harness.faux.api)!.streamSimple;
		harness.session.agent.streamFn = stream;
		harness.setResponses([fauxAssistantMessage("selected model response")]);
		const run = (async () => {
			const selected = await harness.session.cycleModel();
			expect(selected?.model.id).toBe("second");
			expect(harness.session.model?.id).toBe("second");
			await harness.session.promptAndWait("reply from the selected model");
		})();
		let finished = false;
		void run.then(() => {
			finished = true;
		});
		try {
			await vi.waitFor(() => expect(finished).toBe(true), { timeout: 1_000 });
			expect(
				harness.session.messages.some((message) => message.role === "assistant" && message.model === "second"),
			).toBe(true);
		} finally {
			for (const finish of complete) finish();
			await run;
			await harness.session.modelRegistry.refreshAvailableModels({ background: false });
		}
	});

	test.each(["team", "stored key", "runtime key", "logout"])(
		"refreshes automatically after changing %s",
		async (change) => {
			await registry.refreshAvailableModels({ background: false });
			fetchFn.mockClear();
			fetchFn.mockImplementation(async (url, init) =>
				json(
					url === primeUrl
						? {
								data: [
									...publicEntries,
									...(new Headers(init?.headers).has("Authorization")
										? [primeEntry("internal/changed-scope")]
										: []),
								],
							}
						: providerPayload,
				),
			);
			if (change === "team") auth.setPrimeInferenceTeamSelection({ teamId: "team-b", name: "Team B" });
			else if (change === "stored key") auth.set("prime-inference", { type: "api_key", key: "changed-key" });
			else if (change === "runtime key") auth.setRuntimeApiKey("prime-inference", "changed-runtime-key");
			else auth.logout("prime-inference");
			expect(registry.getAvailable().some((model) => model.id === "internal/new-private")).toBe(false);
			await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
			if (change !== "logout")
				await vi.waitFor(() =>
					expect(registry.getAvailable().some((model) => model.id === "internal/changed-scope")).toBe(true),
				);
			await registry.refreshAvailableModels({ background: false });
		},
	);

	test("resolves cached CLI models without starting or awaiting a refresh", async () => {
		await registry.refreshAvailableModels({ background: false });
		fetchFn.mockClear();
		for (const [provider, id] of [
			["openai", "catalog-new"],
			["prime-inference", "internal/new-private"],
		]) {
			const resolved = await resolveCliModelFromCatalog({
				cliProvider: provider,
				cliModel: id,
				modelRegistry: registry,
			});
			expect(resolved.model).toBe(registry.find(provider, id));
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("does not invent metadata for a private model absent from the authenticated catalog", async () => {
		const resolved = await resolveCliModelFromCatalog({
			cliProvider: "prime-inference",
			cliModel: "internal/not-authorized",
			modelRegistry: registry,
		});
		expect(resolved.model).toBeUndefined();
		expect(resolved.error).toContain("not available for the current Prime team");
	});

	test("does not reuse private metadata after an explicit CLI API key change", async () => {
		await registry.refreshAvailableModels({ background: false });
		fetchFn.mockImplementation(async (url) => json(url === primeUrl ? { data: publicEntries } : providerPayload));
		const resolved = await resolveCliModelFromCatalog({
			cliProvider: "prime-inference",
			cliModel: "internal/new-private",
			apiKey: "different-account-key",
			modelRegistry: registry,
		});
		expect(resolved.model).toBeUndefined();
		expect(resolved.error).toContain("not available for the current Prime team");
	});

	test("keeps custom public model IDs usable when catalog discovery fails", async () => {
		fetchFn.mockRejectedValue(new Error("offline"));
		const resolved = await resolveCliModelFromCatalog({
			cliProvider: "openai",
			cliModel: "custom-unlisted-id",
			modelRegistry: registry,
		});
		expect(resolved.model).toMatchObject({ provider: "openai", id: "custom-unlisted-id" });
		expect(resolved.error).toBeUndefined();
	});

	test.each(["team", "credentials", "logout"])(
		"invalidates private entries immediately after changing %s",
		async (change) => {
			await registry.refreshAvailableModels({ background: false });
			if (change === "team") auth.setPrimeInferenceTeamSelection({ teamId: "team-b", name: "Team B" });
			else if (change === "credentials")
				auth.set("prime-inference", {
					type: "api_key",
					key: "different-key",
					primeTeam: { teamId: "team-a", name: "Team A" },
				});
			else auth.remove("prime-inference");
			expect(registry.getAvailable().some((model) => model.id === "internal/new-private")).toBe(false);
			vi.stubEnv("PI_OFFLINE", "1");
			expect(
				(await ModelRegistry.create(auth, modelsPath).refreshModelCatalog()).models.some(
					(model) => model.id === "internal/new-private",
				),
			).toBe(false);
		},
	);

	test("keeps local overrides, custom models, extensions, and the active session model", async () => {
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					openai: {
						modelOverrides: { "catalog-new": { name: "Local Name", contextWindow: 123456 } },
						models: [{ id: "custom-local" }],
					},
				},
			}),
		);
		registry.registerProvider("test-extension", {
			apiKey: "test-key",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			models: [{ ...newProviderModel, id: "extension-model" }],
		});
		const active = harness.session.model;
		await registry.refreshAvailableModels({ background: false });
		expect(registry.find("openai", "catalog-new")).toMatchObject({ name: "Local Name", contextWindow: 123456 });
		expect(registry.find("openai", "custom-local")).toBeDefined();
		expect(registry.find("test-extension", "extension-model")).toBeDefined();
		expect(harness.session.model).toBe(active);
	});

	test("refreshes both sources every six hours", async () => {
		vi.useFakeTimers();
		await registry.refreshAvailableModels({ background: false });
		fetchFn.mockClear();
		await vi.advanceTimersByTimeAsync(MODEL_CATALOG_REFRESH_INTERVAL_MS);
		expect(fetchFn.mock.calls.filter(([url]) => url === primeUrl)).toHaveLength(1);
		expect(fetchFn.mock.calls.filter(([url]) => url === PROVIDER_MODEL_CATALOG_URL)).toHaveLength(1);
	});

	test("cannot redirect provider credentials or admit Prime models through GitHub", () => {
		const invalid = [
			{ ...newProviderModel, baseUrl: "https://untrusted.example/v1" },
			{ ...newProviderModel, api: "unknown-api" },
			{ ...newProviderModel, provider: "prime-inference" },
		];
		const payload = createModelCatalog([
			newProviderModel,
			...invalid.map((model, index) => ({ ...model, id: `bad-${index}` })),
		]);
		expect(parseProviderModelCatalog(payload, getModels("openai")).map((model) => model.id)).toEqual(["catalog-new"]);
	});

	test("coalesces slow credential commands and never runs them while reading model availability", async () => {
		const tokenPath = join(harness.tempDir, "dummy-token");
		const countPath = join(harness.tempDir, "command-count");
		const commandPath = join(harness.tempDir, "credential.cjs");
		writeFileSync(tokenPath, "command-key-a");
		writeFileSync(countPath, "");
		writeFileSync(
			commandPath,
			`const fs = require("node:fs"); fs.appendFileSync(process.argv[3], "x"); setTimeout(() => process.stdout.write(fs.readFileSync(process.argv[2], "utf8")), 150);`,
		);
		const command = `!"${process.execPath}" "${commandPath}" "${tokenPath}" "${countPath}"`;
		const commandAuth = AuthStorage.inMemory({ "prime-inference": { type: "api_key", key: command } });
		const commandRegistry = ModelRegistry.create(commandAuth, modelsPath);
		const privateModels = Array.from({ length: 20 }, (_, index) => primeEntry(`internal/command-${index}`));
		fetchFn.mockImplementation(async (url) =>
			json(url === primeUrl ? { data: [...publicEntries, ...privateModels] } : providerPayload),
		);
		commandRegistry.getAvailable();
		expect(readFileSync(countPath, "utf8")).toBe("");
		const refresh = commandRegistry.refreshAvailableModels({ background: false });
		const concurrent = commandRegistry.refreshAvailableModels({ background: false });
		await vi.waitFor(() => expect(readFileSync(countPath, "utf8")).toBe("x"));
		const local = await commandRegistry.refreshAvailableModels();
		expect(local.some((model) => model.id.startsWith("internal/command-"))).toBe(false);
		await Promise.all([refresh, concurrent]);
		for (let index = 0; index < 20; index++) {
			expect(
				commandRegistry.getAvailable().filter((model) => model.id.startsWith("internal/command-")),
			).toHaveLength(20);
			expect(commandRegistry.getProviderAuthStatus("prime-inference").source).toBe("stored");
		}
		expect(readFileSync(countPath, "utf8")).toBe("x");
		const source = commandAuth.getCurrentAuthSourceToken("prime-inference", { resolveCommands: false })!;
		commandAuth.markAuthSourceStale(source);
		expect(commandRegistry.getAvailable()).toHaveLength(0);
		expect(commandRegistry.getProviderAuthStatus("prime-inference").source).toBe("stale");
		expect(readFileSync(countPath, "utf8")).toBe("x");
		writeFileSync(tokenPath, "command-key-b");
		await commandRegistry.refreshAvailableModels({ background: false });
		expect(readFileSync(countPath, "utf8")).toBe("xx");
		expect(commandRegistry.getAvailable().filter((model) => model.id.startsWith("internal/command-"))).toHaveLength(
			20,
		);
		const requests = fetchFn.mock.calls.filter(([url]) => url === primeUrl);
		expect(new Headers(requests.at(-1)?.[1]?.headers).get("Authorization")).toBe("Bearer command-key-b");
	});

	test("coalesces credential changes and rejects an old scope's late response", async () => {
		await registry.refreshAvailableModels({ background: false });
		fetchFn.mockClear();
		let finishOld: (() => void) | undefined;
		fetchFn.mockImplementation((url, init) => {
			if (url !== primeUrl) return Promise.resolve(json(providerPayload));
			if (new Headers(init?.headers).get("Authorization") === "Bearer key-old") {
				return new Promise<Response>((resolve) => {
					finishOld = () => resolve(json(primePayload));
				});
			}
			return Promise.resolve(json({ data: [...publicEntries, primeEntry("internal/current-key")] }));
		});
		auth.setRuntimeApiKey("prime-inference", "key-old");
		await vi.waitFor(() => expect(finishOld).toBeDefined());
		auth.setRuntimeApiKey("prime-inference", "intermediate-key");
		auth.setRuntimeApiKey("prime-inference", "key-current");
		await vi.waitFor(() => expect(registry.find("prime-inference", "internal/current-key")).toBeDefined());
		finishOld?.();
		await vi.waitFor(() =>
			expect(registry.getAvailable().some((model) => model.id === "internal/current-key")).toBe(true),
		);
		expect(registry.getAvailable().some((model) => model.id === "internal/new-private")).toBe(false);
		const keys = fetchFn.mock.calls
			.filter(([url]) => url === primeUrl)
			.map(([, init]) => new Headers(init?.headers).get("Authorization"));
		expect(keys).toEqual(["Bearer key-old", "Bearer key-current"]);
	});
});
