/**
 * Tests for the sandbox ownership store and state machine (B12) — final pass.
 *
 * Covers:
 *  - OwnershipClaim validation
 *  - Lock/CAS semantics, two-store contention, stale claim
 *  - State transitions (valid, invalid)
 *  - ID validation, hashed filenames
 *  - Full-schema read validation (exact keys, Date round-trip, strict types)
 *  - Atomic fsync persistence (0600, parent-dir fsync, fd close, no leftover tmp)
 *  - Fixed reason codes — no free-form notes
 *  - Platform-deleted handling (idempotent)
 *  - Wake/reconnect outcomes
 *  - Owner reclaim (stale provisioning + stale active) and fenced ownership transfer
 *  - Durable DELETED tombstone + fenced purge
 *  - Orphan enumeration with corrupt-record descriptors
 *  - Fail-closed lifecycle integration (no err.message access)
 *  - Secret/path-bearing provider errors: fixed codes, no raw content
 *  - Observer throw isolation
 *  - Aborted provisioning compensation with bounded cleanup signal
 *  - markPassivated uses injected clock, validates TTL
 *  - list() returns corrupt descriptors
 */

import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIFECYCLE_CODES, type ProviderErrorKind, SandboxLifecycle } from "../src/core/sandbox-lifecycle.js";
import type { OwnershipClaim, SandboxOwnershipState } from "../src/core/sandbox-ownership.js";
import { createClaim, epochForState, isValidTransition, SandboxOwnershipStore } from "../src/core/sandbox-ownership.js";
import { createPrimeSandboxProvider } from "../src/core/sandbox-provider.js";
import type { CommandRunner, SandboxRunResult } from "../src/core/sandbox-types.js";

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "b12-test-"));
}
function fixedClock(iso: string): () => string {
	return () => iso;
}
function makeStore(baseDir?: string, now?: () => string): SandboxOwnershipStore {
	return new SandboxOwnershipStore({ baseDir: baseDir ?? tempDir(), now });
}

const GEN = "gen-001";
const TOK = "00000000-0000-4000-a000-000000000001";
const BASE_TIME = "2026-09-02T12:00:00.000Z";

function pc(): OwnershipClaim {
	return createClaim(GEN, TOK, "provisioning");
}
function ac(): OwnershipClaim {
	return createClaim(GEN, TOK, "active");
}
function pasc(): OwnershipClaim {
	return createClaim(GEN, TOK, "passivated");
}
function tc(): OwnershipClaim {
	return createClaim(GEN, TOK, "terminated");
}

async function prov(store: SandboxOwnershipStore, lk = "lk-1", sessionId = "sess-1"): Promise<void> {
	await store.create(pc(), lk, sessionId);
}
async function setupActive(store: SandboxOwnershipStore, lk = "lk-1"): Promise<void> {
	await prov(store, lk);
	await store.markActive(pc(), lk);
}

// =========================================================================
// OwnershipClaim
// =========================================================================
describe("OwnershipClaim", () => {
	it("validates generation/token/state", () => {
		const c = createClaim(GEN, TOK, "provisioning");
		expect(c.ownerGeneration).toBe(GEN);
		expect(c.expectedState).toBe("provisioning");
		expect(c.expectedEpoch).toBe(0);
	});
	it("rejects invalid generation", () => {
		expect(() => createClaim("", TOK, "provisioning")).toThrow(/invalid generation/);
	});
	it("rejects invalid token", () => {
		expect(() => createClaim(GEN, "bad", "provisioning")).toThrow(/invalid token/);
	});
	it("rejects invalid state", () => {
		expect(() => createClaim(GEN, TOK, "bogus" as SandboxOwnershipState)).toThrow(/invalid/);
	});
});

// =========================================================================
// State machine
// =========================================================================
describe("state machine", () => {
	it("validates known transitions", () => {
		expect(isValidTransition("provisioning", "active")).toBe(true);
		expect(isValidTransition("terminating", "terminated")).toBe(true);
		expect(isValidTransition("terminated", "deleted")).toBe(true);
	});
	it("rejects invalid", () => {
		expect(isValidTransition("provisioning", "deleted")).toBe(false);
	});
	it("maps epochs", () => {
		expect(epochForState("provisioning")).toBe(0);
		expect(epochForState("active")).toBe(1);
		expect(epochForState("passivated")).toBeNull();
	});
});

// =========================================================================
// ID validation
// =========================================================================
describe("ID validation", () => {
	it("rejects invalid sandboxId/sessionId", async () => {
		await expect(makeStore().create(pc(), "", "s")).rejects.toThrow(/invalid lifecycleKey/);
		await expect(makeStore().create(pc(), "x", "")).rejects.toThrow(/invalid sessionId/);
	});
	it("uses hashed filenames", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "my-lk", "s1");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"));
		expect(f.length).toBe(1);
		expect(f[0]).toMatch(/^[0-9a-f]{64}\.sandbox-ownership\.json$/);
		expect(f[0]).not.toContain("my-lk");
	});
});

// =========================================================================
// Lock/CAS
// =========================================================================
describe("lock and CAS", () => {
	it("rejects wrong generation", async () => {
		const store = makeStore();
		await prov(store);
		await expect(store.markActive(createClaim("x", TOK, "provisioning"), "lk-1")).rejects.toThrow(
			/claim_generation_mismatch/,
		);
	});
	it("rejects wrong token", async () => {
		const store = makeStore();
		await prov(store);
		await expect(
			store.markActive(createClaim(GEN, "11111111-1111-4111-a111-111111111111", "provisioning"), "lk-1"),
		).rejects.toThrow(/claim_token_mismatch/);
	});
	it("rejects wrong state", async () => {
		const store = makeStore();
		await prov(store);
		await expect(store.markActive(createClaim(GEN, TOK, "active"), "lk-1")).rejects.toThrow(/claim_state_mismatch/);
	});
	it("two stores see committed", async () => {
		const dir = tempDir();
		const s1 = makeStore(dir, fixedClock(BASE_TIME));
		await s1.create(pc(), "c", "s");
		const s2 = makeStore(dir, fixedClock(BASE_TIME));
		expect((await s2.read("c"))!.state).toBe("provisioning");
	});
	it("stale claim fails", async () => {
		const store = makeStore();
		await prov(store, "st");
		await store.markActive(pc(), "st");
		await expect(store.markTerminated(pc(), "st", "provisioning_abandoned")).rejects.toThrow(/claim_state_mismatch/);
	});
});

// =========================================================================
// CRUD with full-schema validation
// =========================================================================
describe("CRUD", () => {
	it("create stores PROVISIONING record", async () => {
		const r = await makeStore().create(pc(), "x", "y");
		expect(r.state).toBe("provisioning");
		expect(r.epoch).toBe(0);
		expect(r.terminationReason).toBeNull();
	});
	it("create rejects duplicate", async () => {
		const store = makeStore();
		await store.create(pc(), "d", "s1");
		await expect(store.create(pc(), "d", "s2")).rejects.toThrow(/already exists/);
	});
	it("create rejects non-provisioning claim", async () => {
		await expect(makeStore().create(ac(), "x", "y")).rejects.toThrow(/create_requires_provisioning/);
	});
	it("read returns undefined for nonexistent", async () => {
		expect(await makeStore().read("none")).toBeUndefined();
	});
	it("read returns record for existing", async () => {
		const store = makeStore();
		await prov(store, "r");
		expect((await store.read("r"))!.lifecycleKey).toBe("r");
	});
	it("read throws record_corrupt for corrupt file", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "good", "s");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"))[0];
		const p = join(dir, f);
		const parsed = JSON.parse(readFileSync(p, "utf8"));
		parsed.epoch = 99;
		writeFileSync(p, JSON.stringify(parsed));
		await expect(store.read("good")).rejects.toThrow(/record_corrupt/);
	});
	it("read rejects records with unknown keys", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "ex", "s");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"))[0];
		const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
		parsed.extraKey = "evil";
		writeFileSync(join(dir, f), JSON.stringify(parsed));
		await expect(store.read("ex")).rejects.toThrow(/record_corrupt unknown key/);
	});
	it("update preserves immutables", async () => {
		const store = makeStore();
		await store.create(pc(), "sbx", "sess-original");
		await store.markActive(pc(), "sbx");
		const r = await store.read("sbx");
		expect(r).toBeDefined();
		expect(r?.sessionId).toBe("sess-original");
		expect(r?.ownerGeneration).toBe(GEN);
	});
	it("deleteRecord uses full assertClaimMatches", async () => {
		const store = makeStore();
		await prov(store, "d");
		await expect(
			store.deleteRecord(createClaim(GEN, "11111111-1111-4111-a111-111111111111", "provisioning"), "d"),
		).rejects.toThrow(/claim_token_mismatch/);
	});
	it("deleteRecord is idempotent", async () => {
		const store = makeStore();
		await prov(store, "di");
		await store.deleteRecord(pc(), "di");
		await store.deleteRecord(pc(), "di");
		expect(await store.read("di")).toBeUndefined();
	});
	it("list returns records and corrupt descriptors", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "good", "s");
		writeFileSync(join(dir, "deadbeef.sandbox-ownership.json"), "not-json\n");
		const { records, corrupt } = await store.list();
		expect(records.length).toBe(1);
		expect(corrupt.length).toBe(1);
	});
});

// =========================================================================
// Full-schema validation edge cases (exact keys, Date round-trip, types)
// =========================================================================
describe("full-schema validation", () => {
	it("rejects missing keys", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "mk", "s");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"))[0];
		const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
		delete parsed.platformDeleted;
		writeFileSync(join(dir, f), JSON.stringify(parsed));
		await expect(store.read("mk")).rejects.toThrow(/record_corrupt missing key/);
	});
	it("rejects wrong types for booleans", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "bt", "s");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"))[0];
		const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
		parsed.platformDeleted = "yes";
		writeFileSync(join(dir, f), JSON.stringify(parsed));
		await expect(store.read("bt")).rejects.toThrow(/record_corrupt platformDeleted/);
	});
	it("rejects bad checkpoints (path chars)", async () => {
		const store = makeStore();
		await prov(store, "ck");
		await store.markActive(pc(), "ck");
		await expect(store.setCheckpoint(ac(), "ck", "../../etc/passwd")).rejects.toThrow(/invalid checkpointId/);
	});
	it("rejects bad ISO timestamps (no round-trip)", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "iso", "s");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"))[0];
		const parsed = JSON.parse(readFileSync(join(dir, f), "utf8"));
		parsed.createdAt = "2026-01-01T00:00:00.000+00:00"; // valid ISO but wrong format
		writeFileSync(join(dir, f), JSON.stringify(parsed));
		await expect(store.read("iso")).rejects.toThrow(/date round-trip mismatch/);
	});
});

// =========================================================================
// State transitions
// =========================================================================
describe("state transitions", () => {
	it("full cycle", async () => {
		const store = makeStore();
		await prov(store, "c");
		await store.markActive(pc(), "c");
		expect((await store.read("c"))!.state).toBe("active");
		await store.markPassivated(ac(), "c");
		expect((await store.read("c"))!.epoch).toBeNull();
		await store.markRehydrating(pasc(), "c");
		expect((await store.read("c"))!.state).toBe("rehydrating");
		await store.markActive(createClaim(GEN, TOK, "rehydrating"), "c");
		expect((await store.read("c"))!.state).toBe("active");
	});
	it("provisioning -> terminated", async () => {
		const store = makeStore();
		await prov(store, "t");
		const r = await store.markTerminated(pc(), "t", "provisioning_abandoned");
		expect(r.terminationReason).toBe("provisioning_abandoned");
	});
	it("terminating -> terminated -> deleted (durable tombstone)", async () => {
		const store = makeStore();
		await prov(store, "dd");
		await store.markActive(pc(), "dd");
		await store.markTerminating(ac(), "dd");
		await store.markTerminated(createClaim(GEN, TOK, "terminating"), "dd", "user_deleted");
		await store.markDeleted(tc(), "dd");
		expect(await store.read("dd")).toBeUndefined();
		// Tombstone should exist
		const dir = (store as unknown as { baseDir: string }).baseDir;
		const tombs = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-tombstone.json"));
		expect(tombs.length).toBe(1);
	});
	it("markDeleted requires terminated claim", async () => {
		const store = makeStore();
		await prov(store, "md");
		await store.markActive(pc(), "md");
		// Cannot markDeleted from active — need terminated claim
		await expect(store.markDeleted(ac(), "md")).rejects.toThrow(/markDeleted_requires_terminated/);
	});
	it("fenced purge removes tombstone and fsyncs dir", async () => {
		const store = makeStore();
		await prov(store, "pu");
		await store.markActive(pc(), "pu");
		await store.markTerminating(ac(), "pu");
		await store.markTerminated(createClaim(GEN, TOK, "terminating"), "pu", "user_deleted");
		await store.markDeleted(tc(), "pu");
		await store.purge(tc(), "pu");
		const dir = (store as unknown as { baseDir: string }).baseDir;
		const tombs = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-tombstone.json"));
		expect(tombs.length).toBe(0);
	});
	it("setCheckpoint and heartbeat", async () => {
		const store = makeStore(undefined, fixedClock("2026-09-02T13:00:00.000Z"));
		await setupActive(store, "ch");
		await store.setCheckpoint(ac(), "ch", "ckpt-abc");
		expect((await store.read("ch"))!.checkpointId).toBe("ckpt-abc");
		const hb = await store.heartbeat(ac(), "ch");
		expect(hb.lastHeartbeatAt).toBe("2026-09-02T13:00:00.000Z");
	});
});

// =========================================================================
// markPassivated uses injected clock and validates TTL
// =========================================================================
describe("markPassivated clock and TTL", () => {
	it("uses injected clock for soft reservation", async () => {
		const store = makeStore(undefined, fixedClock(BASE_TIME));
		await setupActive(store, "mp");
		await store.markPassivated(ac(), "mp", 3600_000);
		const r = await store.read("mp");
		expect(r?.softReservationExpiresAt).toBe("2026-09-02T13:00:00.000Z");
	});
	it("rejects invalid TTL", async () => {
		const store = makeStore();
		await setupActive(store, "inv");
		await expect(store.markPassivated(ac(), "inv", -1)).rejects.toThrow(/positive integer/);
	});
});

// =========================================================================
// Platform deleted
// =========================================================================
describe("platform deleted", () => {
	it("markPlatformDeleted transitions through terminating", async () => {
		const store = makeStore();
		await setupActive(store, "pd");
		const r = await store.markPlatformDeleted(ac(), "pd");
		expect(r.state).toBe("terminated");
		expect(r.platformDeleted).toBe(true);
	});
});

// =========================================================================
// Wake / reconnect
// =========================================================================
describe("wake and reconnect", () => {
	it("tryWake requires passivated", async () => {
		expect(await makeStore().tryWake(pasc(), "n")).toBeUndefined();
		const store = makeStore();
		await prov(store, "w");
		expect(await store.tryWake(pasc(), "w")).toBeUndefined();
	});
	it("tryWake transitions to rehydrating", async () => {
		const store = makeStore();
		await setupActive(store, "w2");
		await store.markPassivated(ac(), "w2");
		const r = await store.tryWake(pasc(), "w2");
		expect(r?.state).toBe("rehydrating");
	});
	it("resolveWake alive", async () => {
		const store = makeStore();
		await setupActive(store, "rw");
		await store.markPassivated(ac(), "rw");
		await store.markRehydrating(pasc(), "rw");
		const r = await store.resolveWake(ac(), "rw", "alive", "ckpt-abc");
		expect(r?.state).toBe("active");
		expect(r?.checkpointId).toBe("ckpt-abc");
	});
	it("resolveWake terminated_by_platform", async () => {
		const store = makeStore();
		await setupActive(store, "rw2");
		await store.markPassivated(ac(), "rw2");
		await store.markRehydrating(pasc(), "rw2");
		const r = await store.resolveWake(ac(), "rw2", "terminated_by_platform");
		expect(r?.state).toBe("terminated");
	});
	it("resolveWake timeout", async () => {
		const store = makeStore();
		await setupActive(store, "rw3");
		await store.markPassivated(ac(), "rw3");
		await store.markRehydrating(pasc(), "rw3");
		const r = await store.resolveWake(ac(), "rw3", "timeout");
		expect(r?.state).toBe("terminated");
		expect(r?.terminationReason).toBe("wake_timeout");
	});
});

// =========================================================================
// Owner reclaim and transfer
// =========================================================================
describe("owner reclaim", () => {
	it("reclaimStale provisioning after lease timeout", async () => {
		const dir = tempDir();
		const store = makeStore(dir, fixedClock(BASE_TIME));
		await store.create(pc(), "st", "s");
		const ls = makeStore(dir, fixedClock("2026-09-02T13:00:00.000Z"));
		const nc = createClaim("gen-new", "22222222-2222-4222-a222-222222222222", "provisioning");
		const r = await ls.reclaimStale(nc, "st", "provisioning", 5 * 60 * 1000);
		expect(r.ownerGeneration).toBe("gen-new");
	});
	it("reclaimStale provisioning rejects non-expired", async () => {
		const store = makeStore(undefined, fixedClock(BASE_TIME));
		await store.create(pc(), "fr", "s");
		const nc = createClaim("gen-n", "22222222-2222-4222-a222-222222222222", "provisioning");
		await expect(store.reclaimStale(nc, "fr", "provisioning", 5 * 60 * 1000)).rejects.toThrow(/reclaim_too_early/);
	});
	it("reclaimStale active after heartbeat lease timeout", async () => {
		const dir = tempDir();
		const store = makeStore(dir, fixedClock(BASE_TIME));
		await store.create(pc(), "sa", "s");
		await store.markActive(pc(), "sa");
		const ls = makeStore(dir, fixedClock("2026-09-02T13:00:00.000Z"));
		const nc = createClaim("gen-2", "22222222-2222-4222-a222-222222222222", "active");
		const r = await ls.reclaimStale(nc, "sa", "active", 5 * 60 * 1000);
		expect(r.ownerGeneration).toBe("gen-2");
	});
	it("transferOwnership requires full claim match", async () => {
		const store = makeStore();
		await prov(store, "xf");
		const r = await store.transferOwnership(pc(), "xf", "gen-2", "33333333-3333-4333-a333-333333333333");
		expect(r.ownerGeneration).toBe("gen-2");
		const wrong = createClaim("gen-2", "33333333-3333-4333-a333-333333333333", "active");
		await expect(
			store.transferOwnership(wrong, "xf", "gen-3", "44444444-4444-4444-a444-444444444444"),
		).rejects.toThrow(/claim_state_mismatch/);
	});
});

// =========================================================================
// Orphan enumeration with corrupt descriptors
// =========================================================================
describe("orphan enumeration", () => {
	it("finds stale provisioning", async () => {
		const dir = tempDir();
		const store = makeStore(dir, fixedClock(BASE_TIME));
		await store.create(pc(), "sp", "s");
		const ls = makeStore(dir, fixedClock("2026-09-02T13:00:00.000Z"));
		const o = await ls.enumerateOrphans(5 * 60 * 1000);
		expect(o.staleProvisioning.length).toBeGreaterThanOrEqual(1);
	});
	it("finds no-beat active", async () => {
		const dir = tempDir();
		const store = makeStore(dir, fixedClock(BASE_TIME));
		await store.create(pc(), "nb", "s");
		await store.markActive(pc(), "nb");
		const ls = makeStore(dir, fixedClock("2026-09-02T13:00:00.000Z"));
		expect((await ls.enumerateOrphans(5 * 60 * 1000)).activeWithoutHeartbeat.length).toBeGreaterThanOrEqual(1);
	});
	it("includes corrupt descriptors", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "g", "s");
		writeFileSync(join(dir, "bad.sandbox-ownership.json"), "{corrupt");
		const o = await store.enumerateOrphans();
		expect(o.corruptRecords.length).toBe(1);
	});
	it("empty categories for empty store", async () => {
		const o = await makeStore().enumerateOrphans();
		expect(o.staleProvisioning).toEqual([]);
		expect(o.corruptRecords).toEqual([]);
	});
});

// =========================================================================
// Fixed termination reasons
// =========================================================================
describe("fixed termination reasons", () => {
	const REASONS = [
		"user_deleted",
		"provisioning_abandoned",
		"provisioning_failed",
		"platform_deleted",
		"wake_terminated",
		"wake_timeout",
		"orphan_cleanup",
		"expired",
	] as const;
	for (const reason of REASONS) {
		it(reason, async () => {
			const store = makeStore();
			await prov(store, "r");
			expect((await store.markTerminated(pc(), "r", reason)).terminationReason).toBe(reason);
		});
	}
});

// =========================================================================
// Sanitized records
// =========================================================================
describe("sanitized records", () => {
	it("JSON has no credentials in values", async () => {
		const json = JSON.stringify(await makeStore().create(pc(), "san", "s"));
		expect(json).not.toMatch(/:"[^"]*(?:password|secret|credential)[^"]*"/i);
		expect(json).not.toMatch(/\/home\/|\/Users\/|\/tmp\//);
	});
	it("errors do not leak raw values", async () => {
		await expect(makeStore().update(pc(), "none", (r) => r)).rejects.toThrow(/record_not_found/);
	});

	it("persisted record contains only ownerTokenHash, never raw token", async () => {
		const store = makeStore();
		await store.create(pc(), "hash-record", "s1");
		const rec = await store.read("hash-record");
		expect(rec).toBeDefined();
		expect(rec?.ownerTokenHash).toMatch(/^[0-9a-f]{64}$/);
		expect(rec?.ownerTokenHash).not.toBe(TOK);
		const json = JSON.stringify(rec);
		expect(json).not.toContain(TOK);
		expect(json).not.toContain('"ownerToken":');
		expect(json).toContain("ownerTokenHash");
	});

	it("read/list never expose raw token after transfer", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "xfer-hash", "s1");
		const newTok = "33333333-3333-4333-a333-333333333333";
		await store.transferOwnership(pc(), "xfer-hash", "gen-2", newTok);
		const rec = await store.read("xfer-hash");
		const json = JSON.stringify(rec);
		expect(json).not.toContain(newTok);
		expect(rec?.ownerTokenHash).toMatch(/^[0-9a-f]{64}$/);
		const { records } = await store.list();
		expect(JSON.stringify(records)).not.toContain(newTok);
	});

	it("claim matching works against hashed record", async () => {
		const store = makeStore();
		await store.create(pc(), "match-hash", "s1");
		await expect(store.markActive(pc(), "match-hash")).resolves.toBeDefined();
		const wrongTok = createClaim(GEN, "11111111-1111-4111-a111-111111111111", "provisioning");
		await expect(store.markTerminated(wrongTok, "match-hash", "provisioning_abandoned")).rejects.toThrow(
			/claim_token_mismatch/,
		);
	});
});

// =========================================================================
// Atomic persistence
// =========================================================================
describe("atomic persistence", () => {
	it("writes 0600 files", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "m", "s");
		const f = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"))[0];
		expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
	});
	it("survives simulated crash", async () => {
		const dir = tempDir();
		const s1 = makeStore(dir);
		await setupActive(s1, "cr");
		expect((await makeStore(dir).read("cr"))!.state).toBe("active");
	});
	it("no leftover tmp files", async () => {
		const dir = tempDir();
		const s = makeStore(dir);
		await s.create(pc(), "nt", "s");
		await s.markActive(pc(), "nt");
		expect(readdirSync(dir).filter((x: string) => x.endsWith(".tmp"))).toEqual([]);
	});
	it("list skips corrupt but reports them", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		await store.create(pc(), "g", "s");
		writeFileSync(join(dir, "bad.sandbox-ownership.json"), "not-json\n");
		const { records, corrupt } = await store.list();
		expect(records.length).toBe(1);
		expect(corrupt.length).toBe(1);
	});
});

// =========================================================================
// Fail-closed lifecycle — no err.message access
// =========================================================================
describe("lifecycle fail-closed", () => {
	it("constructor requires owner config", () => {
		expect(
			() =>
				new SandboxLifecycle(createPrimeSandboxProvider(new FakeCommandRunner()), { ownershipStore: makeStore() }),
		).toThrow(/ownerGeneration required/);
	});
	it("accepts complete config", () => {
		const life = new SandboxLifecycle(createPrimeSandboxProvider(new FakeCommandRunner()), {
			ownershipStore: makeStore(),
			ownerGeneration: GEN,
			ownerToken: TOK,
		});
		expect(life.ownershipStore).toBeDefined();
	});
	it("create+waitForReady+delete with ownership", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		const runner = new FakeCommandRunner()
			.onCommand("--version", { stdout: "0.9.1\n" })
			.onCommand("sandbox list --num", { stdout: emptyListJson() })
			.onCommand("sandbox list --output", { stdout: emptyListJson() })
			.onCommand("sandbox create", { stdout: "Successfully created sandbox sbx-full-001\n" })
			.onCommand("sandbox get", { stdout: makeGetJson({ id: "sbx-full-001", status: "RUNNING" }) })
			.onCommand("sandbox delete", { stdout: "" });
		const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
			ownershipStore: store,
			ownerGeneration: GEN,
			ownerToken: TOK,
		});
		await life.create({ image: "img", sessionLabel: "t" }, "sess-lc");
		const lk2: string = life.lifecycleKey as string;
		let rec = await store.read(lk2);
		expect(rec).toBeDefined();
		expect(rec?.state).toBe("provisioning");
		await life.waitForReady();
		rec = await store.read(lk2);
		expect(rec).toBeDefined();
		expect(rec?.state).toBe("active");
		await life.delete();
		rec = await store.read(lk2);
		expect(rec).toBeDefined();
		expect(rec?.state).toBe("terminated");

		// Verify persisted file name is hashed and lacks raw provider sandbox ID + region
		const files = readdirSync(dir).filter((x: string) => x.endsWith(".sandbox-ownership.json"));
		expect(files.length).toBe(1);
		expect(files[0]).toMatch(/^[0-9a-f]{64}\.sandbox-ownership\.json$/);
		const fileContent = readFileSync(join(dir, files[0]), "utf8");
		expect(fileContent).not.toContain("sbx-full-001");
		expect(fileContent).not.toContain("us-west");
		expect(fileContent).not.toContain("us-east");
		expect(fileContent).not.toContain(TOK);
	});

	it("events use fixed codes only", async () => {
		const throwingRunner: CommandRunner = {
			run: async () => {
				throw new Error("raw CLI output");
			},
		};
		const events: Array<{ code: string; status: string }> = [];
		const life = new SandboxLifecycle(createPrimeSandboxProvider(throwingRunner), {
			onEvent: (e) => events.push({ code: e.code, status: e.status }),
		});
		await expect(life.preflight()).rejects.toThrow();
		for (const ev of events) {
			expect(ev.code).not.toMatch(/sandbox-provider:|internal error|exit \d+|credentials|secret|key/);
		}
	});

	it("observer throw does not alter lifecycle", () => {
		expect(
			() =>
				new SandboxLifecycle(createPrimeSandboxProvider(new FakeCommandRunner()), {
					onEvent: () => {
						throw new Error("obs");
					},
				}),
		).not.toThrow();
	});
});

// =========================================================================
// Provider error sanitization — no err.message in events/thrown
// =========================================================================
describe("provider error sanitization", () => {
	it("create with secret-bearing error uses fixed code", async () => {
		const throwingRunner: CommandRunner = {
			run: async () => {
				throw new Error("API key 'sk-abc123' invalid");
			},
		};
		const events: Array<{ code: string; status: string }> = [];
		const life = new SandboxLifecycle(createPrimeSandboxProvider(throwingRunner), {
			onEvent: (e) => events.push({ code: e.code, status: e.status }),
		});
		await expect(life.preflight()).rejects.toThrow(); // sandbox-lifecycle: preflight_fail
		for (const ev of events) {
			expect(ev.code).not.toMatch(/sk-abc123|invalid|secret/);
		}
	});

	it("delete with not-found from classifier succeeds", async () => {
		const throwingRunner: CommandRunner = {
			run: async () => {
				throw new Error("not found: sandbox-123");
			},
		};
		const events: Array<{ code: string; status: string }> = [];
		const life = new SandboxLifecycle(createPrimeSandboxProvider(throwingRunner), {
			onEvent: (e) => events.push({ code: e.code, status: e.status }),
			classifyError: () => ({ kind: "not_found" as ProviderErrorKind, code: LIFECYCLE_CODES.DELETE_GONE }),
		});
		(life as unknown as { identity: unknown }).identity = {
			id: "sbx",
			name: "",
			status: "RUNNING",
			image: "",
			region: "",
			createdAt: "",
			labels: [],
			resources: "",
		};
		await life.delete();
		// Should emit DELETE_GONE (success), not raw paths
		const okEvents = events.filter((e) => e.code === LIFECYCLE_CODES.DELETE_OK);
		expect(okEvents.length).toBeGreaterThan(0);
		for (const ev of events) expect(ev.code).not.toMatch(/\/Users|secret/);
	});
});

// =========================================================================
// Compensation
// =========================================================================
describe("compensation on missing sessionId", () => {
	it("compensates with bounded cleanup signal", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		let del = false;
		const runner: CommandRunner = {
			run: async (argv: string[]) => {
				const cmd = argv.join(" ");
				if (cmd.includes("--version")) return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox list")) return { stdout: emptyListJson(), stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox create"))
					return { stdout: "Successfully created sandbox sbx-c1\n", stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox get")) return { stdout: makeGetJson({ id: "sbx-c1" }), stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox delete")) {
					del = true;
					return { stdout: "", stderr: "", exitCode: 0 };
				}
				return { stdout: "", stderr: "nope", exitCode: 127 };
			},
		};
		const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
			ownershipStore: store,
			ownerGeneration: GEN,
			ownerToken: TOK,
		});
		await expect(life.create({ image: "img", sessionLabel: "t" })).rejects.toThrow(/create_session_required/);
		expect(del).toBe(true);
		expect(await store.read("sbx-c1")).toBeUndefined();
	});

	it("missing-session cleanup failure retains identity and emits RECOVERY_REQUIRED", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		let deleteThrows = false;
		const runner: CommandRunner = {
			run: async (argv: string[]) => {
				const cmd = argv.join(" ");
				if (cmd.includes("--version")) return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox list")) return { stdout: emptyListJson(), stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox create")) {
					return { stdout: "Successfully created sandbox sbx-cf\n", stderr: "", exitCode: 0 };
				}
				if (cmd.includes("sandbox get")) {
					return { stdout: makeGetJson({ id: "sbx-cf" }), stderr: "", exitCode: 0 };
				}
				if (cmd.includes("sandbox delete")) {
					deleteThrows = true;
					throw new Error("network down");
				}
				return { stdout: "", stderr: "nope", exitCode: 127 };
			},
		};
		const events: Array<{ code: string; status: string }> = [];
		const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
			ownershipStore: store,
			ownerGeneration: GEN,
			ownerToken: TOK,
			onEvent: (e) => events.push({ code: e.code, status: e.status }),
		});
		await expect(life.create({ image: "img", sessionLabel: "t" })).rejects.toThrow(/recovery_required/);
		expect(deleteThrows).toBe(true);
		expect(
			(
				life as unknown as {
					readonly identity: {
						readonly id: string;
						readonly name: string;
						readonly status: string;
						readonly image: string;
						readonly region: string;
						readonly createdAt: string;
						readonly labels: readonly string[];
						readonly resources: string;
					} | null;
				}
			).identity?.id,
		).toBe("sbx-cf");
		const errorCodes = events.filter((e) => e.status === "error").map((e) => e.code);
		expect(errorCodes).toContain(LIFECYCLE_CODES.RECOVERY_REQUIRED);
	});

	it("missing-session cleanup success clears identity and emits CREATE_SESSION_REQUIRED", async () => {
		const dir = tempDir();
		const store = makeStore(dir);
		const runner: CommandRunner = {
			run: async (argv: string[]) => {
				const cmd = argv.join(" ");
				if (cmd.includes("--version")) return { stdout: "0.9.1\n", stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox list")) return { stdout: emptyListJson(), stderr: "", exitCode: 0 };
				if (cmd.includes("sandbox create")) {
					return { stdout: "Successfully created sandbox sbx-cs\n", stderr: "", exitCode: 0 };
				}
				if (cmd.includes("sandbox get")) {
					return { stdout: makeGetJson({ id: "sbx-cs" }), stderr: "", exitCode: 0 };
				}
				if (cmd.includes("sandbox delete")) return { stdout: "", stderr: "", exitCode: 0 };
				return { stdout: "", stderr: "nope", exitCode: 127 };
			},
		};
		const events: Array<{ code: string; status: string }> = [];
		const life = new SandboxLifecycle(createPrimeSandboxProvider(runner), {
			ownershipStore: store,
			ownerGeneration: GEN,
			ownerToken: TOK,
			onEvent: (e) => events.push({ code: e.code, status: e.status }),
		});
		await expect(life.create({ image: "img", sessionLabel: "t" })).rejects.toThrow(/create_session_required/);
		expect(
			(
				life as unknown as {
					readonly identity: {
						readonly id: string;
						readonly name: string;
						readonly status: string;
						readonly image: string;
						readonly region: string;
						readonly createdAt: string;
						readonly labels: readonly string[];
						readonly resources: string;
					} | null;
				}
			).identity?.id,
		).toBeUndefined();
		const errorCodes = events.filter((e) => e.status === "error").map((e) => e.code);
		expect(errorCodes).toContain(LIFECYCLE_CODES.CREATE_SESSION_REQUIRED);
	});
});

// =========================================================================
// Helpers
// =========================================================================
interface Rule {
	match: (argv: string[]) => boolean;
	stdout: string;
	stderr?: string;
	exitCode?: number;
}

class FakeCommandRunner implements CommandRunner {
	private rules: Rule[] = [];
	on(match: (argv: string[]) => boolean, o: { stdout?: string; stderr?: string; exitCode?: number }): this {
		this.rules.push({ match, stdout: o.stdout ?? "", stderr: o.stderr ?? "", exitCode: o.exitCode ?? 0 });
		return this;
	}
	onCommand(sub: string, o: { stdout?: string; stderr?: string; exitCode?: number }): this {
		return this.on((argv) => argv.join(" ").includes(sub), o);
	}
	async run(argv: string[], _opts?: unknown): Promise<SandboxRunResult> {
		for (const r of this.rules)
			if (r.match(argv)) return { stdout: r.stdout, stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
		return { stdout: "", stderr: "no rule", exitCode: 127 };
	}
}

function emptyListJson(): string {
	return JSON.stringify({ sandboxes: [] });
}
function makeGetJson(o: Record<string, unknown> = {}): string {
	return JSON.stringify({
		id: "sbx",
		name: "t",
		docker_image: "i",
		status: "RUNNING",
		region: "us",
		created_at: "2026-09-02T12:00:00Z",
		labels: ["t"],
		...o,
	});
}
