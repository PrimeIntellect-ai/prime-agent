import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, getModels, type Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	getRemoteModelCatalogUrl,
	mergeRemoteModelCatalog,
	parseRemoteModelCatalog,
	refreshRemoteModelCatalog,
} from "../src/core/remote-model-catalog.js";

const generatedAt = "2026-08-31T00:00:00.000Z";

function catalog(models: Model<Api>[]) {
	return { schemaVersion: 1, generatedAt, models };
}

function openAiModel(): Model<Api> {
	return structuredClone(getModels("openai")[0] as Model<Api>);
}

describe("remote model catalog", () => {
	let tempDir: string;
	let previousCatalogUrl: string | undefined;
	let previousOffline: string | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `prime-model-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		previousCatalogUrl = process.env.PRIME_AGENT_MODEL_CATALOG_URL;
		previousOffline = process.env.PI_OFFLINE;
		process.env.PRIME_AGENT_MODEL_CATALOG_URL = `https://catalog.test/${Math.random()}.json`;
		delete process.env.PI_OFFLINE;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (previousCatalogUrl === undefined) delete process.env.PRIME_AGENT_MODEL_CATALOG_URL;
		else process.env.PRIME_AGENT_MODEL_CATALOG_URL = previousCatalogUrl;
		if (previousOffline === undefined) delete process.env.PI_OFFLINE;
		else process.env.PI_OFFLINE = previousOffline;
		if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	test("validates entries and rejects duplicate provider/model ids", () => {
		const model = openAiModel();
		expect(parseRemoteModelCatalog(catalog([model])).models).toHaveLength(1);
		expect(() => parseRemoteModelCatalog(catalog([model, structuredClone(model)]))).toThrow("Duplicate");
		expect(() =>
			parseRemoteModelCatalog(catalog([{ ...model, cost: { ...model.cost, input: Number.NaN } }])),
		).toThrow("Invalid model catalog entry");
	});

	test("updates metadata while pinning bundled request transports", () => {
		const bundled = openAiModel();
		const remote = {
			...structuredClone(bundled),
			name: "Current provider name",
			baseUrl: "https://attacker.test/v1",
			api: "attacker-api",
			headers: { Authorization: "exfiltrate" },
			cost: { ...bundled.cost, input: bundled.cost.input + 1 },
		};
		const [merged] = mergeRemoteModelCatalog([bundled], [remote]);
		expect(merged).toMatchObject({
			name: "Current provider name",
			baseUrl: bundled.baseUrl,
			api: bundled.api,
			cost: remote.cost,
		});
		expect(merged.headers).toEqual(bundled.headers);
	});

	test("adds models only through a bundled provider transport", () => {
		const bundled = openAiModel();
		const accepted = { ...structuredClone(bundled), id: "future-model", name: "Future Model" };
		const rejected = { ...structuredClone(accepted), id: "redirected-model", baseUrl: "https://other.test" };
		const merged = mergeRemoteModelCatalog([bundled], [accepted, rejected]);
		expect(merged.map((model) => model.id)).toEqual([bundled.id, "future-model"]);
	});

	test("fetches once, validates, and reuses the fresh atomic cache", async () => {
		const cachePath = join(tempDir, "cache.json");
		const model = openAiModel();
		const fetchFn = vi.fn(async () => new Response(JSON.stringify(catalog([model])), { status: 200 }));
		const [first, concurrent] = await Promise.all([
			refreshRemoteModelCatalog(cachePath, { fetchFn, now: 1_000 }),
			refreshRemoteModelCatalog(cachePath, { fetchFn, now: 1_000 }),
		]);
		expect(fetchFn).toHaveBeenCalledOnce();
		expect(first?.[0].id).toBe(model.id);
		expect(concurrent?.[0].id).toBe(model.id);
		expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({
			url: getRemoteModelCatalogUrl(),
			fetchedAt: 1_000,
		});

		await refreshRemoteModelCatalog(cachePath, { fetchFn, now: 2_000 });
		expect(fetchFn).toHaveBeenCalledOnce();
	});

	test("uses a stale validated cache when offline or refresh fails", async () => {
		const cachePath = join(tempDir, "cache.json");
		const model = openAiModel();
		writeFileSync(
			cachePath,
			JSON.stringify({ url: getRemoteModelCatalogUrl(), fetchedAt: 1, catalog: catalog([model]) }),
		);
		const fetchFn = vi.fn(async () => new Response(null, { status: 503 }));
		expect((await refreshRemoteModelCatalog(cachePath, { fetchFn, now: 100_000_000 }))?.[0].id).toBe(model.id);
		expect(fetchFn).toHaveBeenCalledOnce();

		process.env.PI_OFFLINE = "1";
		const offlineFetch = vi.fn();
		expect((await refreshRemoteModelCatalog(cachePath, { fetchFn: offlineFetch, now: 200_000_000 }))?.[0].id).toBe(
			model.id,
		);
		expect(offlineFetch).not.toHaveBeenCalled();
	});

	test("keeps local model overrides and custom models above remote metadata", async () => {
		const model = openAiModel();
		const modelsPath = join(tempDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					openai: {
						modelOverrides: { [model.id]: { name: "Local name", cost: { input: 99 } } },
						models: [{ ...model, id: "local-model", name: "Local model" }],
					},
				},
			}),
		);
		const remote = { ...structuredClone(model), name: "Remote name", cost: { ...model.cost, input: 42 } };
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(catalog([remote])), { status: 200 })),
		);
		const registry = ModelRegistry.create(
			AuthStorage.inMemory({ openai: { type: "api_key", key: "key" } }),
			modelsPath,
		);
		registry.registerProvider("extension-provider", {
			api: "openai-completions",
			apiKey: "extension-key",
			baseUrl: "https://extension.test/v1",
			models: [{ ...model, id: "extension-model", name: "Extension model" }],
		});
		await registry.refreshAvailableModels();
		expect(registry.find("openai", model.id)).toMatchObject({ name: "Local name", cost: { input: 99 } });
		expect(registry.find("openai", "local-model")?.name).toBe("Local model");
		expect(registry.find("extension-provider", "extension-model")?.name).toBe("Extension model");
	});
});
