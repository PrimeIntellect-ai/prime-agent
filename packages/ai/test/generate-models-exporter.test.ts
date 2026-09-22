import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "vitest";
import {
	getModelsDevThinkingLevelMap,
	mergeProviderModelsForCatalog,
	readCatalogPolicy,
	syncCatalog,
} from "../scripts/generate-models.js";
import type { Api, Model } from "../src/types.js";

function model(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: `Fresh ${id}`,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
		contextWindow: 128000,
		maxTokens: 8192,
		...overrides,
	};
}

function catalogPolicyFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "model-catalog-policy-"));
	mkdirSync(join(root, "models", "whitelist"), { recursive: true });
	mkdirSync(join(root, "models", "manual"), { recursive: true });
	return root;
}

function writeCatalogFixture(root: string, openaiIds: string[]): void {
	mkdirSync(join(root, "models", "whitelist"), { recursive: true });
	mkdirSync(join(root, "models", "manual"), { recursive: true });
	writeFileSync(
		join(root, "models", "whitelist", "openai.yml"),
		['source: "openai"', "ids:", ...openaiIds.map((id) => `  - "${id}"`), "globs: []", ""].join("\n"),
	);
	writeFileSync(
		join(root, "models", "manual", "openai-codex.yml"),
		[
			"models:",
			'  - id: "codex-manual"',
			'    name: "Codex Manual"',
			'    api: "openai-codex-responses"',
			'    provider: "openai-codex"',
			'    baseUrl: "https://chatgpt.com/backend-api"',
			"    reasoning: true",
			'    input: ["text"]',
			"    cost:",
			"      input: 1",
			"      output: 2",
			"      cacheRead: 0",
			"      cacheWrite: 0",
			"    contextWindow: 128000",
			"    maxTokens: 8192",
			"",
		].join("\n"),
	);
	const models = [
		{
			id: "kept",
			name: "Old kept",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
			contextWindow: 4096,
			maxTokens: 1024,
			featured: true,
		},
		{
			id: "removed",
			name: "Removed",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
			contextWindow: 4096,
			maxTokens: 1024,
		},
		{
			id: "codex-manual",
			name: "Old manual",
			api: "openai-codex-responses",
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		},
	];
	writeFileSync(
		join(root, "models", "catalog.v1.json"),
		`${JSON.stringify({ schemaVersion: 1, models }, null, "	")}\n`,
	);
}

function installMockCatalogFetch(): () => void {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (url: string | URL | Request) => {
		const href = String(url);
		if (href === "https://models.dev/api.json") {
			return new Response(
				JSON.stringify({
					openai: {
						models: {
							kept: {
								id: "kept",
								name: "Fresh kept",
								tool_call: true,
								reasoning: true,
								modalities: { input: ["text"] },
								cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
								limit: { context: 128000, output: 8192 },
							},
							removed: {
								id: "removed",
								name: "Fresh removed",
								tool_call: true,
								reasoning: true,
								modalities: { input: ["text"] },
								cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 },
								limit: { context: 128000, output: 8192 },
							},
						},
					},
				}),
			);
		}
		if (href === "https://openrouter.ai/api/v1/models") {
			return new Response(JSON.stringify({ data: [] }));
		}
		throw new Error(`unexpected fetch ${href}`);
	}) as typeof fetch;
	return () => {
		globalThis.fetch = originalFetch;
	};
}

describe("model catalog exporter merge", () => {
	test("refreshes whitelisted ids and keeps whitelisted ids missing upstream", () => {
		const existing = [
			{
				id: "kept",
				name: "Old name",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: false,
				thinkingLevelMap: { low: "low" },
				input: ["text"],
				cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
				contextWindow: 4096,
				maxTokens: 1024,
				featured: true,
			},
			{ id: "stale", name: "Stale" },
		];

		const result = mergeProviderModelsForCatalog(existing, [model("kept"), model("new")], {
			ids: ["kept", "stale"],
			globs: [],
		});

		expect(result.summary).toEqual({
			updated: 1,
			added: 0,
			delisted: 0,
			notInUpstream: 1,
			skipped: 0,
			globAdmitted: [],
			delistedIds: [],
			notInUpstreamIds: ["stale"],
		});
		expect(result.models).toHaveLength(2);
		expect(result.models[0]).toMatchObject({
			id: "kept",
			name: "Fresh kept",
			reasoning: true,
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
			contextWindow: 128000,
			maxTokens: 8192,
			featured: true,
		});
		expect(result.models[0]).not.toHaveProperty("thinkingLevelMap");
		expect(Object.keys(result.models[0])).toEqual([
			"id",
			"name",
			"api",
			"provider",
			"baseUrl",
			"reasoning",
			"input",
			"cost",
			"contextWindow",
			"maxTokens",
			"featured",
		]);
		expect(result.models[1]).toEqual(existing[1]);
	});

	test("delists committed ids that are no longer whitelisted", () => {
		const result = mergeProviderModelsForCatalog(
			[
				{ id: "kept", name: "Old name" },
				{ id: "removed", name: "Removed" },
			],
			[model("kept"), model("removed")],
			{ ids: ["kept"], globs: [] },
		);

		expect(result.models.map((entry) => entry.id)).toEqual(["kept"]);
		expect(result.summary.delisted).toBe(1);
		expect(result.summary.delistedIds).toEqual(["removed"]);
	});

	test("never writes headers into catalog records", () => {
		const result = mergeProviderModelsForCatalog(
			[
				{
					id: "kept",
					name: "Old name",
					api: "openai-completions",
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					reasoning: true,
					input: ["text"],
					cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128000,
					maxTokens: 8192,
					headers: { Authorization: "must-not-leak" },
					unknownCatalogField: true,
				},
			],
			[
				model("kept", {
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					headers: { "User-Agent": "GitHubCopilotChat/0.48.1" },
				} as Partial<Model<Api>>),
				model("allowed-new", {
					provider: "github-copilot",
					baseUrl: "https://api.individual.githubcopilot.com",
					headers: { "User-Agent": "GitHubCopilotChat/0.48.1" },
				} as Partial<Model<Api>>),
			],
			{ ids: ["kept"], globs: ["allowed-*"] },
		);

		for (const record of result.models) {
			expect(record).not.toHaveProperty("headers");
			expect(record).not.toHaveProperty("unknownCatalogField");
		}
		expect(result.summary).toEqual({
			updated: 1,
			added: 1,
			delisted: 0,
			notInUpstream: 0,
			skipped: 0,
			globAdmitted: [{ id: "allowed-new", glob: "allowed-*" }],
			delistedIds: [],
			notInUpstreamIds: [],
		});
	});

	test("adds only new ids admitted by provider globs", () => {
		const result = mergeProviderModelsForCatalog(
			[{ id: "kept", name: "Old name" }],
			[model("kept"), model("allowed-alpha"), model("blocked-beta"), model("allowed-gamma")],
			{ ids: ["kept"], globs: ["allowed-*"] },
		);

		expect(result.summary.added).toBe(2);
		expect(result.summary.globAdmitted).toEqual([
			{ id: "allowed-alpha", glob: "allowed-*" },
			{ id: "allowed-gamma", glob: "allowed-*" },
		]);
		expect(result.models.map((entry) => entry.id)).toEqual(["kept", "allowed-alpha", "allowed-gamma"]);
	});
});

describe("model catalog exporter emit", () => {
	test("writes aggregate and admission manifest directly", async () => {
		const restoreFetch = installMockCatalogFetch();
		try {
			const root = catalogPolicyFixture();
			writeCatalogFixture(root, ["kept", "removed"]);

			await expect(syncCatalog(root)).resolves.toBe(0);

			const catalog = JSON.parse(readFileSync(join(root, "models", "catalog.v1.json"), "utf8"));
			const manifest = JSON.parse(readFileSync(join(root, "models", "admission-manifest.v1.json"), "utf8"));
			expect(
				catalog.models.map((entry: { provider: string; id: string }) => `${entry.provider}:${entry.id}`),
			).toEqual(["openai:kept", "openai:removed", "openai-codex:codex-manual"]);
			expect(catalog.models[0]).toMatchObject({ name: "Fresh kept", featured: true });
			expect(manifest).toEqual({
				schemaVersion: 1,
				admitted: { openai: ["kept", "removed"], "openai-codex": ["codex-manual"] },
			});
			expect(() => readFileSync(join(root, "models", "providers", "openai.json"), "utf8")).toThrow();
		} finally {
			restoreFetch();
		}
	});

	test("removes a delisted id from both aggregate and manifest", async () => {
		const restoreFetch = installMockCatalogFetch();
		try {
			const root = catalogPolicyFixture();
			writeCatalogFixture(root, ["kept"]);

			await expect(syncCatalog(root)).resolves.toBe(0);

			const catalog = JSON.parse(readFileSync(join(root, "models", "catalog.v1.json"), "utf8"));
			const manifest = JSON.parse(readFileSync(join(root, "models", "admission-manifest.v1.json"), "utf8"));
			expect(
				catalog.models.map((entry: { provider: string; id: string }) => `${entry.provider}:${entry.id}`),
			).toEqual(["openai:kept", "openai-codex:codex-manual"]);
			expect(manifest.admitted.openai).toEqual(["kept"]);
		} finally {
			restoreFetch();
		}
	});

	test("sources Kimi For Coding from the kimi-code-plan-cn slug", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request) => {
			const href = String(url);
			if (href === "https://models.dev/api.json") {
				return new Response(
					JSON.stringify({
						"kimi-code-plan-cn": {
							models: {
								"kimi-for-coding": {
									id: "kimi-for-coding",
									name: "Kimi K2.7 Code",
									tool_call: true,
									reasoning: true,
									modalities: { input: ["text", "image"] },
									cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
									limit: { context: 262144, output: 32768 },
								},
							},
						},
					}),
				);
			}
			if (href === "https://openrouter.ai/api/v1/models") {
				return new Response(JSON.stringify({ data: [] }));
			}
			throw new Error(`unexpected fetch ${href}`);
		}) as typeof fetch;
		try {
			const root = catalogPolicyFixture();
			writeFileSync(
				join(root, "models", "whitelist", "kimi-coding.yml"),
				'source: "kimi-code-plan-cn"\nids:\n  - "kimi-for-coding"\nglobs: []\n',
			);
			writeFileSync(
				join(root, "models", "catalog.v1.json"),
				`${JSON.stringify({ schemaVersion: 1, models: [] }, null, "	")}\n`,
			);

			await expect(syncCatalog(root)).resolves.toBe(0);

			const catalog = JSON.parse(readFileSync(join(root, "models", "catalog.v1.json"), "utf8"));
			expect(catalog.models).toEqual([
				expect.objectContaining({
					id: "kimi-for-coding",
					provider: "kimi-coding",
					api: "anthropic-messages",
					baseUrl: "https://api.kimi.com/coding",
				}),
			]);
			expect(catalog.models[0]).not.toHaveProperty("headers");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("model catalog exporter policy", () => {
	test("parses whitelist ids, globs, and manual models", () => {
		const root = catalogPolicyFixture();
		writeFileSync(
			join(root, "models", "whitelist", "openrouter.yml"),
			'source: "openrouter-api"\nids:\n  - "kept"\nglobs:\n  - "allowed-*"\n',
		);
		writeFileSync(
			join(root, "models", "whitelist", "fireworks.yml"),
			'source: "fireworks-ai"\nids:\n  - "accounts/fireworks/models/glm-5p3"\nglobs: []\n',
		);
		writeFileSync(
			join(root, "models", "whitelist", "azure-openai-responses.yml"),
			'source: "azure"\nids:\n  - "gpt-5"\nglobs: []\n',
		);
		writeFileSync(
			join(root, "models", "manual", "openai-codex.yml"),
			[
				"models:",
				'  - id: "gpt-5.1"',
				'    name: "GPT-5.1"',
				'    api: "openai-codex-responses"',
				'    provider: "openai-codex"',
				'    baseUrl: "https://chatgpt.com/backend-api"',
				"    reasoning: true",
				'    input: ["text"]',
				"    cost:",
				"      input: 1",
				"      output: 2",
				"      cacheRead: 0",
				"      cacheWrite: 0",
				"    contextWindow: 128000",
				"    maxTokens: 8192",
				"",
			].join("\n"),
		);

		const policy = readCatalogPolicy(root);
		expect(policy.whitelists.get("openrouter")).toEqual({
			source: "openrouter-api",
			ids: ["kept"],
			globs: ["allowed-*"],
		});
		expect(policy.whitelists.get("fireworks")).toEqual({
			source: "fireworks-ai",
			ids: ["accounts/fireworks/models/glm-5p3"],
			globs: [],
		});
		expect(policy.whitelists.get("azure-openai-responses")).toEqual({
			source: "azure",
			ids: ["gpt-5"],
			globs: [],
		});
		expect(policy.manuals.get("openai-codex")?.[0]).toMatchObject({ id: "gpt-5.1", provider: "openai-codex" });
	});

	test("rejects whitelist source mismatches", () => {
		const root = catalogPolicyFixture();
		writeFileSync(
			join(root, "models", "whitelist", "openrouter.yml"),
			'source: "models-dev-openrouter"\nids: []\nglobs: []\n',
		);

		expect(() => readCatalogPolicy(root)).toThrow(/expected openrouter-api/);
	});
});

describe("models.dev metadata helpers", () => {
	test("derives thinking level maps from models.dev effort options", () => {
		expect(
			getModelsDevThinkingLevelMap({
				id: "glm-5.2",
				name: "GLM-5.2",
				reasoning_options: [{ type: "effort", values: ["high", "max"] }],
			}),
		).toEqual({
			off: null,
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});

		expect(
			getModelsDevThinkingLevelMap({
				id: "gpt-5.3-codex",
				name: "GPT-5.3 Codex",
				reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
			}),
		).toMatchObject({
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: null,
		});
	});
});
