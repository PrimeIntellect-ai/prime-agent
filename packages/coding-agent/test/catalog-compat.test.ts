import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, createModelCatalog, getModels, type Model, parseModelCatalog } from "@earendil-works/pi-ai";
import { parseMcpServiceCatalogFile } from "@earendil-works/pi-ai/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getBundledModels } from "../src/core/bundled-model-catalog.js";
import {
	refreshRemoteMcpServiceCatalog,
	resolveServiceCatalogWithDiagnostics,
} from "../src/core/mcp/service-catalog.js";
import { CatalogCache } from "../src/core/model-catalog-cache.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { PRIME_INFERENCE_BASE_URL } from "../src/core/prime-inference-model-catalog.js";
import { PROVIDER_MODEL_CATALOG_URL, parseProviderModelCatalog } from "../src/core/provider-model-catalog.js";
import { createAgentSession } from "../src/core/sdk.js";
import { createTestResourceLoader } from "./utilities.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllGlobals();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "catalog-compat-"));
	tempDirs.push(dir);
	return dir;
}

function bundledProviderModel(provider = "anthropic"): Model<Api> {
	const model = getBundledModels().find(
		(entry) => entry.provider === provider && entry.provider !== "prime-inference",
	);
	if (!model) throw new Error(`missing bundled model for ${provider}`);
	return model;
}

function modelPayload(models: readonly Model<Api>[]): unknown {
	return createModelCatalog(models);
}

function fetchSequence(responses: Array<() => Response | Promise<Response>>): typeof fetch {
	return (async () => {
		const next = responses.shift();
		if (!next) throw new Error("unexpected fetch");
		return next();
	}) as typeof fetch;
}

function mcpEntry(server: string, url = `https://${server}.example.com/mcp`): Record<string, unknown> {
	return {
		server,
		service: server,
		label: server,
		url,
		aliases: [],
		transport: { type: "http", url },
		auth: { strategy: "oauth", clientRegistration: "dynamic" },
		setup: { status: "ready" },
		verification: { status: "unverified" },
		legacyBuiltin: false,
		provenance: [{ source: "prime" }],
	};
}

function mcpPayload(entries: readonly Record<string, unknown>[], version = 2): unknown {
	return { version, counts: { entries: entries.length }, entries };
}

function primeInferenceCatalogPayload(): unknown {
	return {
		data: getModels("prime-inference").map((model) => ({
			id: model.id,
			pricing: { input_usd_per_mtok: model.cost.input, output_usd_per_mtok: model.cost.output },
			specs: {
				context_window: model.contextWindow,
				max_output_tokens: model.maxTokens,
				modalities: { input: model.input, output: ["text"] },
				supports_reasoning: model.reasoning,
			},
		})),
	};
}

describe("remote catalog compatibility", () => {
	it("keeps the last-good provider catalog on unsupported schema versions and recovers later", async () => {
		const tempDir = makeTempDir();
		const bundled = getBundledModels();
		const first = bundledProviderModel("anthropic");
		const next = { ...first, name: `${first.name} refreshed` };
		const cache = new CatalogCache(PROVIDER_MODEL_CATALOG_URL, join(tempDir, "provider-cache.json"), (payload) =>
			parseProviderModelCatalog(payload, bundled),
		);

		const firstModels = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify(modelPayload([first])))]),
		});
		expect(firstModels?.map((model) => model.id)).toEqual([first.id]);

		const unsupported = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify({ schemaVersion: 2, models: [next] }))]),
		});
		expect(unsupported).toBe(firstModels);
		expect(cache.get("public")).toBe(firstModels);

		const recovered = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify(modelPayload([next])))]),
		});
		expect(recovered?.[0]?.name).toBe(next.name);
	});

	it("drops one malformed model from a new provider catalog while keeping valid entries", () => {
		const bundled = getBundledModels();
		const valid = createModelCatalog(
			bundled.filter((model) => model.provider !== "prime-inference").slice(0, 2),
		).models;
		const malformed = { ...valid[0], id: "broken-entry", contextWindow: 0 };
		const parsed = parseProviderModelCatalog({ schemaVersion: 1, models: [valid[0], malformed, valid[1]] }, bundled);

		expect(parsed.map((model) => model.id)).toEqual(valid.map((model) => model.id));
		expect(() => parseModelCatalog({ schemaVersion: 1, models: [valid[0], malformed, valid[1]] })).toThrow(
			"Invalid model catalog entry",
		);
	});

	it("rejects malformed MCP catalogs as a whole, keeps last-good data, and recovers on the next good fetch", async () => {
		const tempDir = makeTempDir();
		const cache = new CatalogCache(
			"https://catalog.example.test/plugins/catalog.v2.json",
			join(tempDir, "mcp-cache.json"),
			(payload) => Object.freeze(parseMcpServiceCatalogFile(payload).entries),
		);

		const first = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify(mcpPayload([mcpEntry("alpha")])))]),
		});
		expect(first?.map((entry) => entry.server)).toEqual(["alpha"]);

		const malformed = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([
				() =>
					new Response(JSON.stringify(mcpPayload([mcpEntry("beta"), { ...mcpEntry("bad"), url: "http://bad" }]))),
			]),
		});
		expect(malformed).toBe(first);
		expect(cache.get("public")).toBe(first);

		const recovered = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify(mcpPayload([mcpEntry("gamma")])))]),
		});
		expect(recovered?.map((entry) => entry.server)).toEqual(["gamma"]);
	});

	it("resolves entries from each remote MCP cache path independently", async () => {
		const firstDir = makeTempDir();
		const secondDir = makeTempDir();
		const firstPath = join(firstDir, "mcp-service-catalog.v2.json");
		const secondPath = join(secondDir, "mcp-service-catalog.v2.json");
		vi.stubGlobal(
			"fetch",
			fetchSequence([
				() => new Response(JSON.stringify(mcpPayload([mcpEntry("remote-alpha")]))),
				() => new Response(JSON.stringify(mcpPayload([mcpEntry("remote-beta")]))),
			]),
		);

		await refreshRemoteMcpServiceCatalog(firstPath, true);
		await refreshRemoteMcpServiceCatalog(secondPath, true);

		expect(
			resolveServiceCatalogWithDiagnostics([], [], firstPath).descriptors.some(
				(entry) => entry.serviceId === "remote-alpha",
			),
		).toBe(true);
		expect(
			resolveServiceCatalogWithDiagnostics([], [], firstPath).descriptors.some(
				(entry) => entry.serviceId === "remote-beta",
			),
		).toBe(false);
		expect(
			resolveServiceCatalogWithDiagnostics([], [], secondPath).descriptors.some(
				(entry) => entry.serviceId === "remote-beta",
			),
		).toBe(true);
	});

	it("keeps last-good MCP data on unsupported versions, network failures, and oversized payloads", async () => {
		const tempDir = makeTempDir();
		const cache = new CatalogCache(
			"https://catalog.example.test/plugins/catalog.v2.json",
			join(tempDir, "mcp-cache.json"),
			(payload) => Object.freeze(parseMcpServiceCatalogFile(payload).entries),
		);
		const first = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify(mcpPayload([mcpEntry("alpha")])))]),
		});

		for (const fetchFn of [
			fetchSequence([() => new Response(JSON.stringify(mcpPayload([mcpEntry("beta")], 3)))]),
			fetchSequence([
				async () => {
					throw new Error("offline");
				},
			]),
			fetchSequence([
				() =>
					new Response("x".repeat(8 * 1024 * 1024 + 1), {
						headers: { "content-length": String(8 * 1024 * 1024 + 1) },
					}),
			]),
		]) {
			await expect(cache.refresh("public", { force: true, fetchFn })).resolves.toBe(first);
			expect(cache.get("public")).toBe(first);
		}

		const recovered = await cache.refresh("public", {
			force: true,
			fetchFn: fetchSequence([() => new Response(JSON.stringify(mcpPayload([mcpEntry("delta")])))]),
		});
		expect(recovered?.map((entry) => entry.server)).toEqual(["delta"]);
	});

	it("keeps a running session pinned to its active model object across failed and changed catalog refreshes", async () => {
		const tempDir = makeTempDir();
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(tempDir, "models.json"));
		const activeModel = modelRegistry.find("anthropic", "claude-fable-5");
		if (!activeModel) throw new Error("missing active model");
		const sessionResult = await createAgentSession({
			cwd: tempDir,
			agentDir: join(tempDir, "agent"),
			authStorage,
			modelRegistry,
			model: activeModel,
			resourceLoader: createTestResourceLoader(),
		});
		const session = sessionResult.session;

		const changedModel = { ...activeModel, name: "Changed catalog name" };
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input instanceof Request ? input.url : input.toString();
				if (url === PROVIDER_MODEL_CATALOG_URL) {
					return new Response(JSON.stringify(modelPayload([changedModel])));
				}
				if (url === `${PRIME_INFERENCE_BASE_URL}/models`) {
					return new Response(JSON.stringify(primeInferenceCatalogPayload()));
				}
				throw new Error(`unexpected fetch ${url}`);
			}),
		);

		try {
			await modelRegistry.refreshAvailableModels();
			await modelRegistry.waitForPendingModelRefreshes(2_000);
			expect(modelRegistry.find("anthropic", "claude-fable-5")?.name).toBe("Changed catalog name");
			const modelAfterChangedCatalog = session.model;
			expect(modelAfterChangedCatalog).toBe(activeModel);
			expect(modelAfterChangedCatalog?.baseUrl).toBe(activeModel.baseUrl);

			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("offline");
				}),
			);
			await expect(modelRegistry.refreshAvailableModels()).resolves.toEqual(expect.any(Array));
			const modelAfterFailedRefresh = session.model;
			expect(modelAfterFailedRefresh).toBe(activeModel);
			expect(modelAfterFailedRefresh?.baseUrl).toBe(activeModel.baseUrl);
		} finally {
			session.dispose();
		}
	});
});

describe("legacy cache locations", () => {
	it("reads a legacy flat cache when the primary path is missing", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-legacy-cache-"));
		try {
			const payload = createModelCatalog([getModels("openai")[0]!]);
			writeFileSync(
				join(dir, "legacy.v1.json"),
				JSON.stringify({ url: "https://catalog.example/models", scope: "public", fetchedAt: Date.now(), payload }),
			);
			const cache = new CatalogCache(
				"https://catalog.example/models",
				join(dir, "new", "primary.v1.json"),
				(p) => parseModelCatalog(p).models,
				[join(dir, "legacy.v1.json")],
			);
			expect(cache.get("public")?.length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("prefers the primary cache when both exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-primary-cache-"));
		try {
			const legacy = createModelCatalog([getModels("openai")[0]!]);
			const primary = createModelCatalog([getModels("anthropic")[0]!]);
			mkdirSync(join(dir, "new"), { recursive: true });
			writeFileSync(
				join(dir, "legacy.v1.json"),
				JSON.stringify({
					url: "https://catalog.example/models",
					scope: "public",
					fetchedAt: Date.now() - 1000,
					payload: legacy,
				}),
			);
			writeFileSync(
				join(dir, "new", "primary.v1.json"),
				JSON.stringify({
					url: "https://catalog.example/models",
					scope: "public",
					fetchedAt: Date.now(),
					payload: primary,
				}),
			);
			const cache = new CatalogCache(
				"https://catalog.example/models",
				join(dir, "new", "primary.v1.json"),
				(p) => parseModelCatalog(p).models,
				[join(dir, "legacy.v1.json")],
			);
			expect(cache.get("public")?.[0]?.provider).toBe("anthropic");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
