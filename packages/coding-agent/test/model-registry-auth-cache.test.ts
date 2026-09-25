import { createHmac } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";

const counters = vi.hoisted(() => ({ reads: new Map<string, number>(), hashes: 0 }));
vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	return {
		...actual,
		readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
			const key = String(args[0]);
			counters.reads.set(key, (counters.reads.get(key) ?? 0) + 1);
			return actual.readFileSync(...args);
		}) as typeof actual.readFileSync,
	};
});
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	return {
		...actual,
		createHash: ((algorithm, options) => {
			counters.hashes += 1;
			return actual.createHash(algorithm, options);
		}) as typeof actual.createHash,
	};
});
const fingerprint = createHmac("sha256", "k").update("prime-agent:private-prime-authorization:v1\0t").digest("hex");
const counted = (map: Map<string, number>, path: string) => map.get(path) ?? 0;
const touch = (path: string, iso: string) => utimesSync(path, new Date(iso), new Date(iso));
const tempDir = mkdtempSync(join(tmpdir(), "pi-test-catalog-cache-"));
// Never written; the private cache path is derived from its dirname.
const modelsJsonPath = join(tempDir, "models.json");
const privateCachePath = join(tempDir, "prime-inference-private-models.json");
const primeTeam = { teamId: "t", name: "n" };
const authStorage = AuthStorage.inMemory({ "prime-inference": { type: "api_key", key: "k", primeTeam } });
beforeAll(() => {
	vi.stubEnv("PRIME_API_KEY", undefined);
	vi.stubEnv("PRIME_TEAM_ID", undefined);
	vi.stubEnv("PI_OFFLINE", "1");
});
afterAll(() => {
	vi.unstubAllEnvs();
	rmSync(tempDir, { recursive: true, force: true });
});

function writePrivateCache(displayName: string, mtimeIso: string): void {
	const pricing = { input_usd_per_mtok: 1, output_usd_per_mtok: 2 };
	const data = [{ id: "internal/glm-5.2-fast", display_name: displayName, pricing }];
	writeFileSync(privateCachePath, JSON.stringify({ fingerprint, data, refreshedAt: Date.now() }));
	touch(privateCachePath, mtimeIso);
}

describe("model registry private authorization cache and auth-source memo", () => {
	test("serves the private authorization cache from its stat snapshot and memoizes auth fingerprints", async () => {
		writePrivateCache("Cache Entry One", "2026-01-01T00:00:00.000Z");
		const registry = ModelRegistry.create(authStorage, modelsJsonPath);
		const glm = async () => (await registry.getExecutableModels()).find((m) => m.id === "internal/glm-5.2-fast");
		expect(await glm()).toBeDefined();
		expect(counted(counters.reads, privateCachePath)).toBe(1);
		counters.reads.clear();
		const hashes = counters.hashes;
		await registry.getExecutableModels();
		expect(counted(counters.reads, privateCachePath)).toBe(0); // unchanged file: served from the snapshot
		expect(counters.hashes).toBe(hashes); // unchanged auth sources are not re-hashed
		writePrivateCache("Cache Entry Two", "2026-01-02T00:00:00.000Z");
		expect((await glm())?.name).toBe("Cache Entry Two"); // moved mtime: re-parsed
		expect(registry.getAll().filter((m) => m.provider === "openrouter").length).toBeGreaterThan(1);
		const hasAuthSpy = vi.spyOn(authStorage, "hasAuth");
		registry.getAvailable(); // direct call: getExecutableModels() runs getAvailable() more than once
		expect(hasAuthSpy.mock.calls.filter((call) => call[0] === "openrouter")).toHaveLength(1);
	});
});
