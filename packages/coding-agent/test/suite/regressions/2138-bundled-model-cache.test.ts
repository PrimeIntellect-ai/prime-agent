import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createModelCatalog, getModel } from "@earendil-works/pi-ai";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { getBundledModels } from "../../../src/core/bundled-model-catalog.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { createHarness, type Harness } from "../harness.js";

const oauthId = "bundle-cache-test";
const compiledModel = getModel("openai", "gpt-5.5");

describe("PR 2138 immutable bundled model cache", () => {
	let harness: Harness;
	let installDir: string;
	let assetPath: string;

	function writeCatalog(path: string, name: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(createModelCatalog([{ ...compiledModel, name }])));
	}

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")));
		harness = await createHarness();
		installDir = join(harness.tempDir, "install");
		assetPath = join(installDir, "dist/models.bundled.json");
		writeCatalog(assetPath, "Bundled Test Model");
		vi.stubEnv("PI_PACKAGE_DIR", installDir);
	});

	afterEach(() => {
		unregisterOAuthProvider(oauthId);
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	test("reuses validated nested model objects while keeping list arrays independent", () => {
		const first = getBundledModels();
		writeFileSync(assetPath, "{");
		const second = getBundledModels();
		expect(second).not.toBe(first);
		expect(second[0]).toBe(first[0]);
		expect(second[0].cost).toBe(first[0].cost);
		expect(second[0].name).toBe("Bundled Test Model");
		expect(Object.isFrozen(first[0])).toBe(true);
		expect(Object.isFrozen(first[0].cost)).toBe(true);
		expect(Object.isFrozen(first[0].input)).toBe(true);
		expect(() => {
			first[0].cost.input = 999;
		}).toThrow(TypeError);
		first.pop();
		expect(getBundledModels()).toHaveLength(second.length);
		expect(Object.isFrozen(compiledModel)).toBe(false);
		expect(Object.isFrozen(compiledModel.cost)).toBe(false);
	});

	test("separates installed package paths and source assets", () => {
		const first = getBundledModels()[0];
		const otherDir = join(harness.tempDir, "other-install");
		writeCatalog(join(otherDir, "dist/models.bundled.json"), "Other Install");
		vi.stubEnv("PI_PACKAGE_DIR", otherDir);
		expect(getBundledModels()[0].name).toBe("Other Install");

		const sourceDir = join(harness.tempDir, "repo/packages/coding-agent");
		mkdirSync(join(sourceDir, "src"), { recursive: true });
		writeCatalog(join(harness.tempDir, "repo/catalog/models.v1.json"), "Source Snapshot");
		writeCatalog(join(sourceDir, "dist/models.bundled.json"), "Installed Snapshot");
		vi.stubEnv("PI_PACKAGE_DIR", sourceDir);
		expect(getBundledModels().find((model) => model.id === compiledModel.id)?.name).toBe("Source Snapshot");
		rmSync(join(sourceDir, "src"), { recursive: true });
		expect(getBundledModels()[0].name).toBe("Installed Snapshot");
		vi.stubEnv("PI_PACKAGE_DIR", join(installDir, "."));
		expect(getBundledModels()[0]).toBe(first);
	});

	test("caches damaged-install fallback without freezing global compiled definitions", () => {
		writeFileSync(assetPath, "{");
		const first = getBundledModels().find((model) => model.provider === "openai" && model.id === compiledModel.id);
		expect(first).toEqual(compiledModel);
		expect(first).not.toBe(compiledModel);
		expect(Object.isFrozen(first?.cost)).toBe(true);
		expect(Object.isFrozen(compiledModel.cost)).toBe(false);
		writeCatalog(assetPath, "Changed On Disk");
		expect(getBundledModels().find((model) => model.provider === "openai" && model.id === compiledModel.id)).toBe(
			first,
		);
	});

	test("shares bundled models across registries without leaking per-model or provider overrides", () => {
		const plain = ModelRegistry.inMemory(AuthStorage.inMemory());
		const other = ModelRegistry.inMemory(AuthStorage.inMemory());
		expect(plain.find("openai", compiledModel.id)).toBe(other.find("openai", compiledModel.id));
		const modelsPath = join(harness.tempDir, "overrides/models.json");
		mkdirSync(dirname(modelsPath), { recursive: true });
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					openai: {
						baseUrl: "https://local.invalid/v1",
						modelOverrides: { [compiledModel.id]: { name: "Overridden", cost: { input: 999 } } },
					},
				},
			}),
		);
		const overridden = ModelRegistry.create(AuthStorage.inMemory(), modelsPath);
		expect(overridden.find("openai", compiledModel.id)).toMatchObject({
			name: "Overridden",
			baseUrl: "https://local.invalid/v1",
			cost: { input: 999 },
		});
		expect(plain.find("openai", compiledModel.id)).toMatchObject({
			name: "Bundled Test Model",
			baseUrl: compiledModel.baseUrl,
			cost: compiledModel.cost,
		});
	});

	test("allows in-place OAuth model edits without leaking into the cache or another registry", () => {
		registerOAuthProvider({
			id: oauthId,
			name: "Bundle Cache Test",
			login: async () => {
				throw new Error("login is not used");
			},
			refreshToken: async (credentials) => credentials,
			getApiKey: (credentials) => credentials.access,
			modifyModels: (models, credentials) => {
				const model = models.find(
					(candidate) => candidate.provider === "openai" && candidate.id === compiledModel.id,
				);
				if (!model) throw new Error("missing bundled model");
				model.name = credentials.access;
				model.cost.input = 999;
				model.input.pop();
				return models;
			},
		});
		const auth = (access: string) =>
			AuthStorage.inMemory({
				[oauthId]: { type: "oauth", access, refresh: "unused", expires: Date.now() + 60_000 },
			});
		const first = ModelRegistry.inMemory(auth("First Account"));
		const second = ModelRegistry.inMemory(auth("Second Account"));
		const plain = ModelRegistry.inMemory(AuthStorage.inMemory());
		expect(first.find("openai", compiledModel.id)?.name).toBe("First Account");
		expect(second.find("openai", compiledModel.id)?.name).toBe("Second Account");
		expect(plain.find("openai", compiledModel.id)).toMatchObject({
			name: "Bundled Test Model",
			cost: compiledModel.cost,
			input: compiledModel.input,
		});
		expect(getBundledModels()[0].cost).toEqual(compiledModel.cost);
	});
	test("isolates in-place OAuth edits when a provider is registered after construction", () => {
		const auth = AuthStorage.inMemory({
			[oauthId]: { type: "oauth", access: "unused", refresh: "unused", expires: Date.now() + 60_000 },
		});
		const registry = ModelRegistry.inMemory(auth);
		const plain = ModelRegistry.inMemory(AuthStorage.inMemory());
		registry.registerProvider(oauthId, {
			api: compiledModel.api,
			baseUrl: compiledModel.baseUrl,
			models: [{ ...compiledModel, id: "dynamic-model" }],
			oauth: {
				name: "Dynamic Bundle Test",
				login: async () => {
					throw new Error("login is not used");
				},
				refreshToken: async (credentials) => credentials,
				getApiKey: (credentials) => credentials.access,
				modifyModels: (models) => {
					for (const model of models) model.cost.input = 999;
					return models;
				},
			},
		});
		expect(registry.find("openai", compiledModel.id)?.cost.input).toBe(999);
		expect(plain.find("openai", compiledModel.id)?.cost).toEqual(compiledModel.cost);
		expect(getBundledModels()[0].cost).toEqual(compiledModel.cost);
	});
});
