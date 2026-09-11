import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModelCatalog, getModel, getModels, parseModelCatalog } from "@earendil-works/pi-ai";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadModelCatalogSnapshot } from "../../../scripts/model-catalog-snapshot.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { createBundledModelCatalog } from "../../../src/core/bundled-model-catalog.js";
import { KeybindingsManager } from "../../../src/core/keybindings.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { PROVIDER_MODEL_CATALOG_URL } from "../../../src/core/provider-model-catalog.js";
import { ConfigurationMenuComponent } from "../../../src/modes/interactive/components/configuration-menu.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "../harness.js";

const providerCatalog = parseModelCatalog(
	JSON.parse(readFileSync(new URL("../../../../../catalog/models.v1.json", import.meta.url), "utf8")),
);
const providerModel = {
	...getModel("openai", "gpt-5.5"),
	id: "installed-provider-model",
	name: "Installed Provider Model",
};
const primeModel = { ...getModels("prime-inference")[0], id: "test/installed-prime", name: "Installed Prime Model" };
const bundled = createBundledModelCatalog(createModelCatalog([...providerCatalog.models, providerModel]), [
	...getModels("prime-inference"),
	primeModel,
]);

describe("ENG-5982 packaged onboarding catalog", () => {
	let harness: Harness;
	let assetPath: string;
	let modelsPath: string;
	const fetchFn = vi.fn<typeof fetch>();

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		fetchFn.mockReset().mockRejectedValue(new Error("network unavailable"));
		vi.stubGlobal("fetch", fetchFn);
		harness = await createHarness();
		const installDir = join(harness.tempDir, "install");
		mkdirSync(join(installDir, "dist"), { recursive: true });
		assetPath = join(installDir, "dist/models.bundled.json");
		writeFileSync(assetPath, JSON.stringify(bundled));
		modelsPath = join(harness.tempDir, "models.json");
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		vi.stubEnv("PI_PACKAGE_DIR", installDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	test.each(["offline", "pending", "failure"])(
		"shows packaged models and providers in onboarding with %s discovery and empty caches",
		async (network) => {
			const finish: Array<() => void> = [];
			if (network !== "offline") vi.stubEnv("PI_OFFLINE", "0");
			if (network === "pending") {
				fetchFn.mockImplementation(
					() =>
						new Promise<Response>((resolve) => finish.push(() => resolve(new Response(null, { status: 503 })))),
				);
			}
			const auth = AuthStorage.inMemory();
			const registry = ModelRegistry.create(auth, modelsPath);
			const snapshot = await registry.refreshModelCatalog();
			expect(snapshot.models).toEqual(
				expect.arrayContaining([expect.objectContaining(primeModel), expect.objectContaining(providerModel)]),
			);
			expect(snapshot.models).toHaveLength(bundled.models.length);
			const providers = [...new Set(snapshot.models.map((model) => model.provider))];
			const menu = new ConfigurationMenuComponent({
				initialTab: "providers",
				tui: { requestRender: () => {} } as unknown as TUI,
				authStorage: auth,
				providerOptions: providers.map((id) => ({
					id,
					name: registry.getProviderDisplayName(id),
					authType: "api_key",
				})),
				modelRegistry: registry,
				currentModel: undefined,
				scopedModels: [],
				availableModels: snapshot.models,
				configuredProviders: new Set(snapshot.configuredProviders),
				initialModelSearch: "installed",
				requestRender: () => {},
				onSelectProvider: () => {},
				onSelectMcpConnection: () => {},
				onSelectModel: () => {},
				onCancel: () => {},
			});
			menu.handleInput("prime");
			expect(stripAnsi(menu.render(120).join("\n"))).toContain("Prime Inference");
			menu.setActiveTab("models");
			const output = stripAnsi(menu.render(120).join("\n"));
			expect(output).toContain("installed-prime");
			expect(output).toContain("installed-provider-model");
			expect(menu.getSearchValue("models")).toBe("installed");
			if (network === "offline") expect(fetchFn).not.toHaveBeenCalled();
			else {
				await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
				for (const complete of finish) complete();
				await registry.refreshAvailableModels({ background: false });
				expect(registry.find("prime-inference", primeModel.id)).toMatchObject(primeModel);
			}
		},
	);

	test("prefers a downloaded provider catalog over the install snapshot after an offline restart", async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		const updated = { ...providerModel, name: "Updated Catalog Model" };
		fetchFn.mockImplementation(async (url) =>
			url === PROVIDER_MODEL_CATALOG_URL
				? new Response(JSON.stringify(createModelCatalog([updated])))
				: new Response(null, { status: 503 }),
		);
		await ModelRegistry.create(AuthStorage.inMemory(), modelsPath).refreshAvailableModels({ background: false });
		vi.stubEnv("PI_OFFLINE", "1");
		fetchFn.mockClear();
		const restarted = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		expect(restarted.find("openai", providerModel.id)?.name).toBe(updated.name);
		expect(restarted.find("prime-inference", primeModel.id)).toMatchObject(primeModel);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("keeps compiled definitions usable if the install asset is damaged", () => {
		writeFileSync(assetPath, "{");
		const registry = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		expect(registry.find("openai", "gpt-5.5")).toBeDefined();
		expect(registry.find("prime-inference", getModels("prime-inference")[0].id)).toBeDefined();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test("excludes private Prime routes and request headers from the install asset", () => {
		const catalog = createBundledModelCatalog(createModelCatalog([providerModel]), [
			primeModel,
			{ ...primeModel, id: "internal/private", headers: { Authorization: "private-token" } },
		]);
		expect(catalog.models.some((model) => model.id === "internal/private")).toBe(false);
		expect(JSON.stringify(catalog)).not.toContain("private-token");
	});

	test.each(["oversized name", "oversized price"])(
		"uses compiled models when a successful Prime response has an %s",
		async (invalidField) => {
			vi.stubEnv("PI_OFFLINE", "0");
			const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
			const data = getModels("prime-inference").map((model, index) => ({
				id: model.id,
				display_name: index === 0 && invalidField === "oversized name" ? "x".repeat(1_025) : model.name,
				pricing: {
					input_usd_per_mtok: index === 0 && invalidField === "oversized price" ? 1_000_001 : model.cost.input,
					output_usd_per_mtok: model.cost.output,
				},
			}));
			fetchFn.mockResolvedValue(new Response(JSON.stringify({ data })));
			expect(await loadModelCatalogSnapshot(providerCatalog)).toEqual(createBundledModelCatalog(providerCatalog));
			expect(warning).toHaveBeenCalledWith(expect.stringContaining("Using compiled Prime Inference models"));
		},
	);

	test("rejects invalid curated data instead of treating it as a failed Prime refresh", async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		await expect(loadModelCatalogSnapshot({ schemaVersion: 1, models: [] })).rejects.toThrow();
		expect(fetchFn).not.toHaveBeenCalled();
	});

	test.each(["offline", "request failure"])("builds a compiled snapshot on %s", async (mode) => {
		vi.stubEnv("PI_OFFLINE", mode === "offline" ? "1" : "0");
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await loadModelCatalogSnapshot(providerCatalog)).toEqual(createBundledModelCatalog(providerCatalog));
		expect(fetchFn).toHaveBeenCalledTimes(mode === "offline" ? 0 : 1);
	});

	test("includes validated live Prime metadata in the install snapshot", async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const data = getModels("prime-inference").map((model) => ({
			id: model.id,
			display_name: "Updated Prime Model",
			pricing: { input_usd_per_mtok: model.cost.input, output_usd_per_mtok: model.cost.output },
		}));
		fetchFn.mockResolvedValue(new Response(JSON.stringify({ data })));
		const catalog = await loadModelCatalogSnapshot(providerCatalog);
		expect(catalog.models.filter((model) => model.provider !== "prime-inference")).toEqual(providerCatalog.models);
		const primeModels = catalog.models.filter((model) => model.provider === "prime-inference");
		expect(primeModels).toHaveLength(data.length);
		expect(primeModels.every((model) => model.name === "Updated Prime Model")).toBe(true);
		expect(warning).not.toHaveBeenCalled();
	});
});
