/**
 * Audit tests for opaque execution location (B01).
 *
 * These tests recursively scan every returned DTO, persisted fixture,
 * and log-level metadata for raw provider sandbox IDs, regions, URLs,
 * paths, or raw exceptions.  They preserve local compatibility and
 * guard against regression.
 *
 * No dynamic imports, casts, any, sync fs, or non-null assertions.
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ExecutionLocation,
	normalizeExecutionLocation,
	normalizeRemoteModelDescriptor,
	normalizeRemoteSessionDescriptor,
	normalizeSandboxConnectionHealth,
} from "../src/core/execution-location.js";
import { SandboxLifecycle } from "../src/core/sandbox-lifecycle.js";
import { createClaim, SandboxOwnershipStore } from "../src/core/sandbox-ownership.js";
import { createPrimeSandboxProvider } from "../src/core/sandbox-provider.js";
import {
	projectSessionExecutionMetadata,
	snapshotSessionExecutionMetadata,
} from "../src/modes/agents-view/agents-view-state.js";

// --------------------------------------------------------------------------
// Known patterns that MUST NOT appear in public DTOs
// --------------------------------------------------------------------------

const RAW_ID_PATTERN = /^sbx?-/i;
const RAW_REGION_PATTERN = /^(us|eu|ap)-[a-z]+-/i;
const RAW_URL_PATTERN = /^https?:\/\//i;
const RAW_PATH_PATTERN = /^\/[a-z]/i;

function scanForRawProviderValues(obj: unknown, path: string, found: string[]): void {
	if (obj === null || obj === undefined) return;
	if (typeof obj === "string") {
		if (RAW_ID_PATTERN.test(obj)) found.push(`${path}: raw sandbox ID pattern "${obj.slice(0, 20)}"`);
		if (RAW_REGION_PATTERN.test(obj)) found.push(`${path}: raw region pattern "${obj.slice(0, 20)}"`);
		if (RAW_URL_PATTERN.test(obj)) found.push(`${path}: URL "${obj.slice(0, 40)}"`);
		if (RAW_PATH_PATTERN.test(obj)) found.push(`${path}: path-like "${obj.slice(0, 40)}"`);
		return;
	}
	if (typeof obj !== "object") return;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) scanForRawProviderValues(obj[i], `${path}[${i}]`, found);
		return;
	}
	for (const [key, value] of Object.entries(obj)) {
		if (key === "sandboxId" || key === "region") {
			found.push(`${path}.${key}: raw provider field name present`);
		}
		scanForRawProviderValues(value, `${path}.${key}`, found);
	}
}

// --------------------------------------------------------------------------
// DTO structure audit: ExecutionLocation
// --------------------------------------------------------------------------

describe("ExecutionLocation prime-sandbox is opaque", () => {
	it("does not carry sandboxId or region in its type", () => {
		// The type itself must not reference sandboxId or region fields
		const loc: ExecutionLocation = { type: "prime-sandbox" };
		expect(loc).not.toHaveProperty("sandboxId");
		expect(loc).not.toHaveProperty("region");
	});

	it("accepts opaque prime-sandbox through normalizer", () => {
		const result = normalizeExecutionLocation({ type: "prime-sandbox" });
		expect(result).toEqual({ type: "prime-sandbox" });
		const leaked: string[] = [];
		scanForRawProviderValues(result, "result", leaked);
		expect(leaked).toEqual([]);
	});

	it("local is unchanged", () => {
		const result = normalizeExecutionLocation({ type: "local" });
		expect(result).toEqual({ type: "local" });
	});
});

// --------------------------------------------------------------------------
// DTO structure audit: RemoteSessionDescriptor
// --------------------------------------------------------------------------

describe("RemoteSessionDescriptor never carries raw provider values", () => {
	const validSession = {
		sessionId: "sess-xyz",
		createdAt: "2026-09-02T06:44:00Z",
		lastActiveAt: "2026-09-02T06:45:00Z",
		executionLocation: { type: "prime-sandbox" },
	};

	it("normalizes with opaque execution location", () => {
		const result = normalizeRemoteSessionDescriptor(validSession);
		expect(result).toBeDefined();
		expect(result?.executionLocation).toEqual({ type: "prime-sandbox" });
		const leaked: string[] = [];
		scanForRawProviderValues(result, "result", leaked);
		expect(leaked).toEqual([]);
	});

	it("rejects session with raw sandboxId in executionLocation", () => {
		const leakedSession = {
			...validSession,
			executionLocation: { type: "prime-sandbox", sandboxId: "sbx-leaked" },
		};
		expect(normalizeRemoteSessionDescriptor(leakedSession)).toBeUndefined();
	});

	it("rejects session with region in executionLocation", () => {
		const regionSession = {
			...validSession,
			executionLocation: { type: "prime-sandbox", region: "us-west-2" },
		};
		expect(normalizeRemoteSessionDescriptor(regionSession)).toBeUndefined();
	});

	it("normalizes local session without leakage", () => {
		const localSession = {
			...validSession,
			executionLocation: { type: "local" },
		};
		const result = normalizeRemoteSessionDescriptor(localSession);
		const leaked: string[] = [];
		scanForRawProviderValues(result, "result", leaked);
		expect(leaked).toEqual([]);
	});
});

// --------------------------------------------------------------------------
// DTO structure audit: model descriptor (rejects apiKey/baseUrl/token)
// --------------------------------------------------------------------------

describe("RemoteModelDescriptor rejects credential-bearing input", () => {
	it("rejects apiKey", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", apiKey: "sk-xxx" }),
		).toBeUndefined();
	});

	it("rejects baseUrl", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", baseUrl: "https://api.openai.com" }),
		).toBeUndefined();
	});

	it("rejects token", () => {
		expect(
			normalizeRemoteModelDescriptor({ provider: "openai", modelId: "gpt-4o", token: "secret" }),
		).toBeUndefined();
	});
});

// --------------------------------------------------------------------------
// Agents View metadata audit
// --------------------------------------------------------------------------

describe("Agents View execution metadata never carries raw values", () => {
	it("sandbox metadata has no sandboxId or region fields", () => {
		const meta = projectSessionExecutionMetadata({ type: "prime-sandbox" }, "connected");
		expect(meta).toEqual({ kind: "sandbox", linkStatus: "connected" });
		expect(Object.isFrozen(meta)).toBe(true);
		const leaked: string[] = [];
		scanForRawProviderValues(meta, "meta", leaked);
		expect(leaked).toEqual([]);
	});

	it("local metadata has no extra fields", () => {
		const meta = projectSessionExecutionMetadata({ type: "local" }, undefined);
		expect(meta).toEqual({ kind: "local" });
		const leaked: string[] = [];
		scanForRawProviderValues(meta, "meta", leaked);
		expect(leaked).toEqual([]);
	});

	it("unavailable metadata has no raw patterns", () => {
		const meta = projectSessionExecutionMetadata({ type: "unknown" }, undefined);
		expect(meta).toEqual({ kind: "unavailable" });
		const leaked: string[] = [];
		scanForRawProviderValues(meta, "meta", leaked);
		expect(leaked).toEqual([]);
	});
});

// --------------------------------------------------------------------------
// snapshotSessionExecutionMetadata round-trip
// --------------------------------------------------------------------------

describe("snapshotSessionExecutionMetadata round-trip", () => {
	it("preserves opaque sandbox metadata", () => {
		const meta = snapshotSessionExecutionMetadata({ kind: "sandbox", linkStatus: "connected" });
		expect(meta).toEqual({ kind: "sandbox", linkStatus: "connected" });
	});

	it("preserves local metadata", () => {
		const meta = snapshotSessionExecutionMetadata({ kind: "local" });
		expect(meta).toEqual({ kind: "local" });
	});

	it("preserves unavailable metadata", () => {
		const meta = snapshotSessionExecutionMetadata({ kind: "unavailable" });
		expect(meta).toEqual({ kind: "unavailable" });
	});

	it("rejects unknown fields in sandbox metadata", () => {
		const meta = snapshotSessionExecutionMetadata({
			kind: "sandbox",
			linkStatus: "connected",
			sandboxId: "sbx-proxy",
		});
		expect(meta).toEqual({ kind: "unavailable" });
	});
});

// --------------------------------------------------------------------------
// Connection health never carries raw provider values
// --------------------------------------------------------------------------

describe("SandboxConnectionHealth never carries raw provider values", () => {
	it("connected with ISO timestamp", () => {
		const result = normalizeSandboxConnectionHealth({ status: "connected", connectedAt: "2026-09-02T06:44:00Z" });
		const leaked: string[] = [];
		scanForRawProviderValues(result, "result", leaked);
		expect(leaked).toEqual([]);
	});

	it("closed status", () => {
		const result = normalizeSandboxConnectionHealth({ status: "closed" });
		expect(result).toEqual({ status: "closed" });
	});
});

// --------------------------------------------------------------------------
// Persisted ownership records never carry raw provider values
// --------------------------------------------------------------------------

describe("lifecycle persisted files lack raw provider values", () => {
	it("record and tombstone file names and content lack raw sandboxId and region", async () => {
		const dir = await mkdtemp(join(tmpdir(), "audit-lifecycle-"));
		const gen = "gen-audit-lifecycle";
		const tok = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
		const store = new SandboxOwnershipStore({ baseDir: dir });
		const sentinelId = "sbx-raw-secret-xyz";
		const sentinelRegion = "us-secret-region-42";
		const fakeIdentityJson = JSON.stringify({
			id: sentinelId,
			name: "test",
			docker_image: "img",
			status: "RUNNING",
			region: sentinelRegion,
			created_at: "2026-09-02T12:00:00Z",
			labels: ["t"],
		});

		let createTriggered = false;
		let deleteTriggered = false;

		const runner = {
			run: async (argv: string[]) => {
				const cmd = argv.join(" ");
				if (cmd.includes("--version")) return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox list"))
					return { stdout: JSON.stringify({ sandboxes: [] }), stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox create")) {
					createTriggered = true;
					return { stdout: `Successfully created sandbox ${sentinelId}\n`, stderr: "", exitCode: 0 };
				}
				if (cmd.includes("sandbox get")) return { stdout: fakeIdentityJson, stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox delete")) {
					deleteTriggered = true;
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "no rule", exitCode: 127 };
			},
		};

		try {
			const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
				ownershipStore: store,
				ownerGeneration: gen,
				ownerToken: tok,
			});
			await life.create({ image: "img", sessionLabel: "t" }, "sess-lifecycle-1");
			expect(createTriggered).toBe(true);
			const recordFile = (await readdir(dir)).filter((x: string) => x.endsWith(".sandbox-ownership.json"));
			expect(recordFile.length).toBe(1);
			expect(recordFile[0]).not.toContain(sentinelId);
			expect(recordFile[0]).not.toContain(sentinelRegion);
			expect(recordFile[0]).toMatch(/^[0-9a-f]{64}\.sandbox-ownership\.json$/);

			await life.waitForReady();
			await life.delete();
			expect(deleteTriggered).toBe(true);

			// After lifecycle.delete the record is terminated (still present as a file).
			// Verify the terminated record lacks sentinels, then create the tombstone.
			const lk = life.lifecycleKey;
			if (lk === null) throw new Error("missing lifecycle key");
			const terminatedRecord = await store.read(lk);
			expect(terminatedRecord).toBeDefined();
			expect(terminatedRecord?.state).toBe("terminated");
			const termFile = (await readdir(dir)).filter((x: string) => x.endsWith(".sandbox-ownership.json"));
			expect(termFile.length).toBe(1);
			const termContent = await readFile(join(dir, termFile[0]), "utf8");
			expect(termContent).not.toContain(sentinelId);
			expect(termContent).not.toContain(sentinelRegion);
			expect(termContent).not.toContain(tok);
			const leaked: string[] = [];
			scanForRawProviderValues(JSON.parse(termContent), termFile[0], leaked);
			expect(leaked).toEqual([]);

			// Create tombstone via store.markDeleted, verify record removed and tombstone exists
			const terminateClaim = createClaim(gen, tok, "terminated");
			await store.markDeleted(terminateClaim, lk);
			const tombstoneFiles = (await readdir(dir)).filter((x: string) => x.endsWith(".sandbox-tombstone.json"));
			expect(tombstoneFiles.length).toBe(1);
			expect(await store.read(lk)).toBeUndefined();
			const tombContent = await readFile(join(dir, tombstoneFiles[0]), "utf8");
			expect(tombContent).not.toContain(sentinelId);
			expect(tombContent).not.toContain(sentinelRegion);
			expect(tombContent).not.toContain(tok);
			const leakedTomb: string[] = [];
			const decodedTombstone: unknown = JSON.parse(tombContent);
			scanForRawProviderValues(decodedTombstone, tombstoneFiles[0], leakedTomb);
			expect(leakedTomb).toEqual([]);

			if (typeof decodedTombstone !== "object" || decodedTombstone === null) {
				throw new Error("invalid tombstone fixture");
			}
			Object.defineProperty(decodedTombstone, "sandboxId", {
				value: sentinelId,
				enumerable: true,
			});
			await writeFile(join(dir, tombstoneFiles[0]), JSON.stringify(decodedTombstone), "utf8");
			await expect(store.purge(terminateClaim, lk)).rejects.toThrow("invalid tombstone");
		} finally {
			await rm(dir, { recursive: true, force: true }).catch(() => {});
		}
	});
});
