import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModels } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { findSessionModelWithReadinessWait, restoreModelFromSession } from "../../../src/core/model-resolver.js";
import { createAgentSession } from "../../../src/core/sdk.js";
import { SessionManager } from "../../../src/core/session-manager.js";

const SAVED_PROVIDER = "prime-inference";
/** A public Prime Inference model that exists only in the (delayed) live catalog. */
const CATALOG_ONLY_MODEL_ID = "test/catalog-only-restore-canary";
const FALLBACK_MODEL_ID = "z-ai/glm-5.3";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * A catalog payload that covers the bundled Prime Inference snapshot (so the
 * fetch survives the coverage check) and additionally contains the
 * catalog-only canary model, which has no bundled template.
 */
function catalogPayloadWithCanary(): unknown {
	const bundledEntries = getModels(SAVED_PROVIDER).map((model) => ({
		id: model.id,
		pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 1 },
	}));
	return {
		data: [
			...bundledEntries,
			{
				id: CATALOG_ONLY_MODEL_ID,
				pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 1 },
				specs: {
					context_window: 200000,
					max_output_tokens: 32000,
					modalities: { input: ["text"], output: ["text"] },
					supports_reasoning: false,
				},
			},
		],
	};
}

/** Stubs the catalog fetch to resolve with the canary catalog after delayMs. */
function stubDelayedCatalogFetch(delayMs: number): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request) => {
			const url = input instanceof Request ? input.url : input.toString();
			if (url === "https://api.pinference.ai/api/v1/models") {
				await sleep(delayMs);
				return new Response(JSON.stringify(catalogPayloadWithCanary()), { status: 200 });
			}
			return new Response(JSON.stringify({ schemaVersion: 1, models: [] }), { status: 200 });
		}),
	);
}

function primeAuthStorage(): AuthStorage {
	return AuthStorage.inMemory({
		"prime-inference": { type: "api_key", key: "test-key" },
	});
}

function makeTempDir(): string {
	const dir = join(tmpdir(), `pi-restore-readiness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("session model restore waits for catalog readiness", () => {
	const tempDirs: string[] = [];

	beforeEach(() => {
		tempDirs.push(makeTempDir());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("restoreModelFromSession restores a saved model once the delayed catalog refresh settles", async () => {
		stubDelayedCatalogFetch(40);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));

		const restored = await restoreModelFromSession(
			SAVED_PROVIDER,
			CATALOG_ONLY_MODEL_ID,
			undefined,
			false,
			registry,
			2_000,
		);

		expect(restored.model).toMatchObject({ provider: SAVED_PROVIDER, id: CATALOG_ONLY_MODEL_ID });
		expect(restored.fallbackMessage).toBeUndefined();
	});

	test("restoreModelFromSession falls back to the current model when the bounded wait expires", async () => {
		stubDelayedCatalogFetch(150);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));
		const currentModel = registry.find(SAVED_PROVIDER, FALLBACK_MODEL_ID);
		expect(currentModel).toBeDefined();

		const restored = await restoreModelFromSession(
			SAVED_PROVIDER,
			CATALOG_ONLY_MODEL_ID,
			currentModel,
			false,
			registry,
			25,
		);

		expect(restored.model).toMatchObject({ provider: SAVED_PROVIDER, id: FALLBACK_MODEL_ID });
		expect(restored.fallbackMessage).toBe(
			`Could not restore model ${SAVED_PROVIDER}/${CATALOG_ONLY_MODEL_ID} (model no longer exists). Using ${SAVED_PROVIDER}/${FALLBACK_MODEL_ID}.`,
		);
	});

	test("findSessionModelWithReadinessWait restores a saved model after the delayed refresh settles", async () => {
		stubDelayedCatalogFetch(40);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));

		const model = await findSessionModelWithReadinessWait(registry, SAVED_PROVIDER, CATALOG_ONLY_MODEL_ID, 2_000);

		expect(model).toMatchObject({ provider: SAVED_PROVIDER, id: CATALOG_ONLY_MODEL_ID });
	});

	test("findSessionModelWithReadinessWait gives up after the bounded wait", async () => {
		stubDelayedCatalogFetch(150);
		const registry = ModelRegistry.create(primeAuthStorage(), join(tempDirs[0]!, "models.json"));

		const model = await findSessionModelWithReadinessWait(registry, SAVED_PROVIDER, CATALOG_ONLY_MODEL_ID, 25);

		expect(model).toBeUndefined();
	});

	test("createAgentSession restores a saved session model once the catalog refresh settles", async () => {
		stubDelayedCatalogFetch(40);
		const cwd = tempDirs[0]!;
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });

		const authStorage = primeAuthStorage();
		const modelRegistry = ModelRegistry.create(authStorage, join(cwd, "models.json"));
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		sessionManager.appendModelChange(SAVED_PROVIDER, CATALOG_ONLY_MODEL_ID);

		const result = await createAgentSession({
			cwd,
			agentDir,
			authStorage,
			modelRegistry,
			sessionManager,
		});

		expect(result.session.model).toMatchObject({ provider: SAVED_PROVIDER, id: CATALOG_ONLY_MODEL_ID });
		expect(result.modelFallbackMessage).toBeUndefined();

		result.session.dispose();
	}, 15_000);
});
