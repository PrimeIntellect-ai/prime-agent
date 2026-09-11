import { createHash } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { ModelRegistry } from "../../../src/core/model-registry.js";
import { findInitialModel, restoreModelFromSession } from "../../../src/core/model-resolver.js";
import { createHarness, type Harness } from "../harness.js";

const provider = "prime-inference";
const knownPrivateId = "internal/glm-5.2-fast";
const discoveredPrivateId = "internal/saved-command-model";
const primeUrl = "https://api.pinference.ai/api/v1/models";
const payload = {
	data: [
		{ id: knownPrivateId },
		{
			id: discoveredPrivateId,
			display_name: "Saved Command Model",
			pricing: { input_usd_per_mtok: 1, output_usd_per_mtok: 2 },
			specs: {
				context_window: 123456,
				max_output_tokens: 12345,
				supports_reasoning: false,
				modalities: { input: ["text"], output: ["text"] },
			},
		},
	],
};

type Selection = "default" | "resume";
function selectSaved(registry: ModelRegistry, id: string, selection: Selection) {
	return selection === "default"
		? findInitialModel({
				scopedModels: [],
				isContinuing: false,
				defaultProvider: provider,
				defaultModelId: id,
				modelRegistry: registry,
			})
		: restoreModelFromSession(provider, id, undefined, false, registry);
}

function seedCommandSnapshot(directory: string, auth: AuthStorage): void {
	// Resolve uncached only to seed the prior process's scope; the async command cache stays cold.
	const token = auth.getCurrentAuthSourceToken(provider)!;
	const teamId = auth.getProviderHeaders(provider)?.["X-Prime-Team-ID"] ?? "";
	const scope = createHash("sha256").update(token.valueFingerprint).update("\0").update(teamId).digest("hex");
	writeFileSync(
		join(directory, "prime-inference-catalog.v1.json"),
		JSON.stringify({ url: primeUrl, scope, fetchedAt: Date.now(), payload }),
	);
	expect(auth.getCurrentAuthSourceToken(provider, { resolveCommands: false })).toBeUndefined();
}

function deferredResponse() {
	let resolve!: (response: Response) => void;
	const promise = new Promise<Response>((finish) => {
		resolve = finish;
	});
	return { promise, resolve };
}

describe("ENG-5982 saved private model restoration", () => {
	let harness: Harness;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	const fetchFn = vi.fn<typeof fetch>();

	beforeEach(async () => {
		vi.stubEnv("PI_OFFLINE", "0");
		vi.stubEnv("PRIME_API_KEY", "");
		vi.stubEnv("PRIME_TEAM_ID", "");
		fetchFn.mockReset().mockImplementation(async () => new Response(null, { status: 503 }));
		vi.stubGlobal("fetch", fetchFn);
		harness = await createHarness();
		auth = AuthStorage.inMemory({
			[provider]: { type: "api_key", key: "test-key", primeTeam: { teamId: "team-a", name: "Team A" } },
		});
		registry = ModelRegistry.create(auth, join(harness.tempDir, "models.json"));
	});

	afterEach(async () => {
		await registry.refreshAvailableModels({ background: false });
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		harness.cleanup();
	});

	test.each(["default", "resume"] as const)(
		"waits for a cold saved private %s without blocking catalog reads or the public provider catalog",
		async (selection) => {
			const prime = deferredResponse();
			const publicCatalog = deferredResponse();
			fetchFn.mockImplementation((url) => (url === primeUrl ? prime.promise : publicCatalog.promise));
			const selected = selectSaved(registry, knownPrivateId, selection);
			let completed = false;
			void selected.then(() => {
				completed = true;
			});
			try {
				await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
				expect(completed).toBe(false);
				const localCatalog = await registry.refreshModelCatalog();
				expect(localCatalog.models.some((model) => model.id === knownPrivateId)).toBe(false);
				prime.resolve(new Response(JSON.stringify(payload)));
				const result = await selected;
				expect(result.model?.id).toBe(knownPrivateId);
				expect(result.fallbackMessage).toBeUndefined();
			} finally {
				prime.resolve(new Response(null, { status: 503 }));
				publicCatalog.resolve(new Response(null, { status: 503 }));
				await selected;
			}
		},
	);

	test.each(["default", "resume"] as const)(
		"keeps a denied saved %s model-less with its ID in the warning",
		async (selection) => {
			fetchFn.mockImplementation(async (url) =>
				url === primeUrl ? new Response(JSON.stringify({ data: [] })) : new Response(null, { status: 503 }),
			);
			const result = await selectSaved(registry, knownPrivateId, selection);
			expect(result.model).toBeUndefined();
			expect(result.fallbackMessage).toContain(`${provider}/${knownPrivateId}`);
			expect(result.fallbackMessage).toContain("model is not available");
		},
	);

	test.each([401, 403, 503])("does not substitute a public model after HTTP %s", async (status) => {
		fetchFn.mockImplementation(async () => new Response(null, { status }));
		const result = await selectSaved(registry, knownPrivateId, "resume");
		expect(result.model).toBeUndefined();
		expect(result.fallbackMessage).toContain(knownPrivateId);
	});

	test("does not admit a known private route without auth", async () => {
		auth.remove(provider);
		const result = await selectSaved(registry, knownPrivateId, "default");
		expect(result.model).toBeUndefined();
		expect(result.fallbackMessage).toContain(knownPrivateId);
		expect(fetchFn.mock.calls.every(([, init]) => !new Headers(init?.headers).has("Authorization"))).toBe(true);
	});

	test.each(["team", "key", "logout", "stale"] as const)(
		"does not restore another scope's cached private model after %s changes",
		async (change) => {
			fetchFn.mockImplementation(async (url) =>
				url === primeUrl ? new Response(JSON.stringify(payload)) : new Response(null, { status: 503 }),
			);
			await registry.refreshAvailableModels({ background: false });
			vi.stubEnv("PI_OFFLINE", "1");
			if (change === "team") auth.setPrimeInferenceTeamSelection({ teamId: "team-b", name: "Team B" });
			else if (change === "key") auth.setRuntimeApiKey(provider, "other-key");
			else if (change === "logout") auth.logout(provider);
			else auth.markAuthStale(provider);
			const result = await selectSaved(registry, discoveredPrivateId, "resume");
			expect(result.model).toBeUndefined();
			expect(result.fallbackMessage).toContain(discoveredPrivateId);
		},
	);

	test("rejects a late old-team response during saved model discovery", async () => {
		const prime = deferredResponse();
		fetchFn.mockImplementation((url) =>
			url === primeUrl ? prime.promise : Promise.resolve(new Response(null, { status: 503 })),
		);
		const selected = selectSaved(registry, knownPrivateId, "resume");
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
		vi.stubEnv("PI_OFFLINE", "1");
		auth.setPrimeInferenceTeamSelection({ teamId: "team-b", name: "Team B" });
		prime.resolve(new Response(JSON.stringify(payload)));
		expect((await selected).model).toBeUndefined();
	});

	test.each(["default", "resume"] as const)(
		"restores a warm command-auth disk cache offline for %s",
		async (selection) => {
			const keyFile = join(harness.tempDir, "key.txt");
			const commandFile = join(harness.tempDir, "credential.cjs");
			writeFileSync(keyFile, "command-test-key");
			writeFileSync(commandFile, 'process.stdout.write(require("node:fs").readFileSync(process.argv[2], "utf8"));');
			auth = AuthStorage.inMemory({
				[provider]: {
					type: "api_key",
					key: `!"${process.execPath}" "${commandFile}" "${keyFile}"`,
					primeTeam: { teamId: "team-a", name: "Team A" },
				},
			});
			seedCommandSnapshot(harness.tempDir, auth);
			vi.stubEnv("PI_OFFLINE", "1");
			registry = ModelRegistry.create(auth, join(harness.tempDir, "models.json"));
			expect(registry.find(provider, discoveredPrivateId)).toBeUndefined();
			const result = await selectSaved(registry, discoveredPrivateId, selection);
			expect(result.model).toMatchObject({ id: discoveredPrivateId, contextWindow: 123456, maxTokens: 12345 });
			expect(result.fallbackMessage).toBeUndefined();
			expect(fetchFn).not.toHaveBeenCalled();
		},
	);

	test.each(["logout", "team", "key"] as const)(
		"checks the current %s after a delayed cold credential resolves",
		async (change) => {
			const commandFile = join(harness.tempDir, "delayed-credential.cjs");
			const startedFile = join(harness.tempDir, "started");
			const releaseFile = join(harness.tempDir, "release");
			writeFileSync(
				commandFile,
				`const fs = require("node:fs");
const path = require("node:path");
let watcher;
let finished = false;
function finish() {
	if (finished || !fs.existsSync(process.argv[3])) return;
	finished = true;
	watcher?.close();
	process.stdout.write("command-key");
}
if (!fs.existsSync(process.argv[3])) watcher = fs.watch(path.dirname(process.argv[3]), finish);
fs.writeFileSync(process.argv[2], "started");
finish();`,
			);
			auth = AuthStorage.inMemory({
				[provider]: {
					type: "api_key",
					key: `!"${process.execPath}" "${commandFile}" "${startedFile}" "${releaseFile}"`,
					primeTeam: { teamId: "team-a", name: "Team A" },
				},
			});
			writeFileSync(releaseFile, "release seed");
			seedCommandSnapshot(harness.tempDir, auth);
			rmSync(startedFile);
			rmSync(releaseFile);
			vi.stubEnv("PI_OFFLINE", "1");
			registry = ModelRegistry.create(auth, join(harness.tempDir, "models.json"));
			const selected = selectSaved(registry, discoveredPrivateId, "resume");
			try {
				await vi.waitFor(() => expect(existsSync(startedFile)).toBe(true));
				if (change === "logout") auth.logout(provider);
				else if (change === "team") auth.setPrimeInferenceTeamSelection({ teamId: "team-b", name: "Team B" });
				else auth.setRuntimeApiKey(provider, "other-key");
				writeFileSync(releaseFile, "release after auth change");
				const result = await selected;
				expect(result.model).toBeUndefined();
				expect(result.fallbackMessage).toContain(discoveredPrivateId);
				expect(fetchFn).not.toHaveBeenCalled();
			} finally {
				writeFileSync(releaseFile, "release cleanup");
				await selected;
			}
		},
	);

	test("restores cached private metadata without waiting for network refresh", async () => {
		fetchFn.mockImplementation(async (url) =>
			url === primeUrl ? new Response(JSON.stringify(payload)) : new Response(null, { status: 503 }),
		);
		await registry.refreshAvailableModels({ background: false });
		const response = deferredResponse();
		fetchFn.mockImplementation(() => response.promise);
		try {
			const result = await selectSaved(registry, discoveredPrivateId, "resume");
			expect(result.model?.id).toBe(discoveredPrivateId);
		} finally {
			response.resolve(new Response(null, { status: 503 }));
		}
	});
});
