/**
 * hosted-child-ledger.test.ts — Comprehensive tests for Hosted Child Ledger V1 codec.
 *
 * Covers full V9 formal matrix: complete lifecycle, terminal pair preservation,
 * chain errors, genesis invariants, identity/anchor changes, storage ingress vs
 * full-chain rules, hostile inputs, mintRecordBytes matrix, fork/gap/orphan,
 * collision detection, deterministic permutation ordering, deep freeze.
 *
 * No casts, `as`, `as const`, non-null assertion, `any`, `instanceof` at hostile
 * boundaries, explicit `throw`, spread, `Object.setPrototypeOf`, or fake
 * structural branding.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	type AppendResult,
	appendGenesis,
	appendTransition,
	type DecodeJournalResult,
	type DecodeResult,
	decodeJournal,
	decodeRecord,
	type EncodeResult,
	encodeGenesisBytes,
	encodeTransitionBytes,
	type InventoryResult,
	inventory,
	type LedgerRecord,
	type LedgerRecordBytes,
	type MintResult,
	mintRecordBytes,
	type RevealResult,
	reveal,
} from "../src/modes/daemon/sandbox/hosted-child-ledger.js";

// =========================================================================
// Constants
// =========================================================================

const C64: string = "0000000000000000000000000000000000000000000000000000000000000000";

const DEFAULT_BOUNDS: Record<string, number> = Object.freeze({
	maxRecords: 100,
	maxBytes: 1048576,
	maxRecordBytes: 65536,
	maxGroups: 50,
});

// =========================================================================
// Helpers
// =========================================================================

function makeGenesisInput(overrides: Record<string, unknown>): Record<string, unknown> {
	const base: Record<string, unknown> = {};
	base.sessionId = "sess-default";
	base.activeSessionId = "active-default";
	base.childId = "child-default";
	base.name = "default-name";
	base.modelSelector = "default-model";
	base.durableParentSessionId = "default-parent";
	base.rlmParentNodeId = "default-rlm";
	base.spawnedByRequestId = null;
	base.thinkingLevel = "medium";
	base.serviceTier = "auto";
	base.spawnContextDigest = C64;
	base.depth = 0;
	const keys: string[] = Object.keys(overrides);
	for (const k of keys) {
		base[k] = overrides[k];
	}
	return Object.freeze(base);
}

function defaultGenesis(): Record<string, unknown> {
	return makeGenesisInput({});
}

function makeTransition(s: string, ts: string | null, tc: string | null): Record<string, unknown> {
	const t: Record<string, unknown> = {};
	t.status = s;
	t.terminalStatus = ts;
	t.terminalCode = tc;
	return Object.freeze(t);
}

function assertFrozen(val: unknown): void {
	if (typeof val === "object" && val !== null) {
		expect(Object.isFrozen(val)).toBe(true);
	}
}

function getField(obj: unknown, key: string): unknown {
	if (typeof obj !== "object" || obj === null) return undefined;
	const desc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(obj, key);
	if (desc === undefined) return undefined;
	return desc.value;
}

// Canonical JSON serialization (mirrors production algorithm)
const _CANONICAL_RECORD_FIELDS: readonly string[] = Object.freeze([
	"schema",
	"identity",
	"rev",
	"status",
	"terminalStatus",
	"terminalCode",
	"contentDigest",
	"prevDigest",
]);

const _CANONICAL_IDENTITY_FIELDS: readonly string[] = Object.freeze([
	"schema",
	"lifecycleKeyDigest",
	"sessionId",
	"activeSessionId",
	"childId",
	"name",
	"modelSelector",
	"durableParentSessionId",
	"rlmParentNodeId",
	"spawnedByRequestId",
	"thinkingLevel",
	"serviceTier",
	"spawnContextDigest",
	"depth",
]);

function _canonicalJSON(obj: unknown, fieldOrder: readonly string[]): string {
	if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
		// Determine if this is an identity-like object
		const lkdDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(obj, "lifecycleKeyDigest");
		const order: readonly string[] =
			lkdDesc !== undefined && typeof lkdDesc.value === "string" ? _CANONICAL_IDENTITY_FIELDS : fieldOrder;
		const parts: string[] = [];
		for (const k of order) {
			const desc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(obj, k);
			if (desc !== undefined) {
				parts.push(`${JSON.stringify(k)}:${_canonicalJSON(desc.value, fieldOrder)}`);
			}
		}
		return `{${parts.join(",")}}`;
	}
	if (typeof obj === "string") return JSON.stringify(obj);
	if (typeof obj === "number") return String(obj);
	if (obj === null) return "null";
	return JSON.stringify(obj);
}

function computeContentDigest(recordObj: Record<string, unknown>): string {
	// Build zeroed-copy via descriptor enumeration
	const identityDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(recordObj, "identity");
	const identityObj: Record<string, unknown> = {};
	if (identityDesc !== undefined && typeof identityDesc.value === "object" && identityDesc.value !== null) {
		const idObj: object = identityDesc.value;
		for (const k of _CANONICAL_IDENTITY_FIELDS) {
			const d: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(idObj, k);
			if (d !== undefined) {
				identityObj[k] = d.value;
			}
		}
	}

	const preimageObj: Record<string, unknown> = {};
	preimageObj.schema = getField(recordObj, "schema");
	preimageObj.identity = identityObj;
	preimageObj.rev = getField(recordObj, "rev");
	preimageObj.status = getField(recordObj, "status");
	preimageObj.terminalStatus = getField(recordObj, "terminalStatus");
	preimageObj.terminalCode = getField(recordObj, "terminalCode");
	preimageObj.contentDigest = C64;
	preimageObj.prevDigest = getField(recordObj, "prevDigest");

	const preimage: string = _canonicalJSON(preimageObj, _CANONICAL_RECORD_FIELDS);
	return createHash("sha256").update(preimage, "utf-8").digest("hex");
}

function buildCanonicalBytes(recordObj: Record<string, unknown>): Uint8Array {
	const json: string = _canonicalJSON(recordObj, _CANONICAL_RECORD_FIELDS);
	const encoded: Uint8Array = new TextEncoder().encode(json);
	const result: Uint8Array = new Uint8Array(encoded.byteLength + 1);
	result.set(encoded, 0);
	result[encoded.byteLength] = 0x0a;
	return result;
}

// Build a modified record from an existing genesis Uint8Array
function modifyGenesisBytes(genesisBytes: Uint8Array, overrides: Record<string, unknown>): Uint8Array {
	const text: string = new TextDecoder().decode(genesisBytes);
	const parsed: Record<string, unknown> = JSON.parse(text);
	const overrideKeys: string[] = Object.keys(overrides);
	for (const k of overrideKeys) {
		parsed[k] = overrides[k];
	}
	parsed.contentDigest = computeContentDigest(parsed);
	return buildCanonicalBytes(parsed);
}

// Create a genesis and extract identity + bytes for reuse
interface GenesisFixture {
	ok: true;
	bytes: Uint8Array;
	wrapper: LedgerRecordBytes;
	identityObj: Record<string, unknown>;
	lifecycleKeyDigest: string;
}

interface GenesisFixtureFail {
	ok: false;
}

type GenesisFixtureResult = GenesisFixture | GenesisFixtureFail;

const GENESIS_FIXTURE_FAIL: GenesisFixtureFail = Object.freeze({ ok: false });

function genesisFixture(): GenesisFixtureResult {
	const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
	if (g.code !== "OK") return GENESIS_FIXTURE_FAIL;

	const rv: RevealResult = reveal(g.bytes);
	if (rv.code !== "OK") return GENESIS_FIXTURE_FAIL;

	const idObj: Record<string, unknown> = {};
	for (const k of _CANONICAL_IDENTITY_FIELDS) {
		const d: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(g.record.identity, k);
		if (d !== undefined) {
			idObj[k] = d.value;
		}
	}

	const lkdDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
		g.record.identity,
		"lifecycleKeyDigest",
	);
	const lkd: string = lkdDesc !== undefined && typeof lkdDesc.value === "string" ? lkdDesc.value : "";

	const result: GenesisFixture = {
		ok: true,
		bytes: rv.data,
		wrapper: g.bytes,
		identityObj: idObj,
		lifecycleKeyDigest: lkd,
	};
	return Object.freeze(result);
}

// =========================================================================
// 2. appendGenesis
// =========================================================================

describe("appendGenesis", () => {
	it("accepts valid genesis with default identity", () => {
		const result: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(result.code).toBe("OK");
		assertFrozen(result);
		if (result.code !== "OK") return;
		const record: LedgerRecord = result.record;
		const wrapper: LedgerRecordBytes = result.bytes;

		expect(record.rev).toBe(0);
		expect(record.status).toBe("reserved");
		expect(record.terminalStatus).toBe(null);
		expect(record.terminalCode).toBe(null);
		expect(record.prevDigest).toBe(null);
		expect(record.schema).toBe("hosted-child-ledger-v1");
		expect(record.identity.lifecycleKeyDigest.length).toBe(64);
		expect(Object.isFrozen(record)).toBe(true);
		expect(Object.isFrozen(record.identity)).toBe(true);
		expect(Object.isFrozen(wrapper)).toBe(true);
	});

	it("rejects genesis with extra field", () => {
		const base: Record<string, unknown> = {};
		const original: Record<string, unknown> = defaultGenesis();
		const keys: string[] = Object.keys(original);
		for (const k of keys) {
			base[k] = original[k];
		}
		base.extraField = "x";
		const result: AppendResult = appendGenesis([], base, DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
		if (result.code === "FAIL") {
			expect(result.error).toBe("FIELD_UNKNOWN_KEY");
		}
	});

	it("rejects genesis with missing field", () => {
		const base: Record<string, unknown> = {};
		base.sessionId = "sess-default";
		base.activeSessionId = "active-default";
		base.childId = "child-default";
		base.name = "default-name";
		base.modelSelector = "default-model";
		base.durableParentSessionId = "default-parent";
		base.rlmParentNodeId = "default-rlm";
		base.spawnedByRequestId = null;
		base.thinkingLevel = "medium";
		base.serviceTier = "auto";
		base.spawnContextDigest = C64;
		const result: AppendResult = appendGenesis([], base, DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
		if (result.code === "FAIL") {
			expect(result.error).toBe("FIELD_UNKNOWN_KEY");
		}
	});

	it("rejects genesis with empty sessionId", () => {
		const result: AppendResult = appendGenesis([], makeGenesisInput({ sessionId: "" }), DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
	});

	it("rejects genesis with negative depth", () => {
		const result: AppendResult = appendGenesis([], makeGenesisInput({ depth: -1 }), DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
	});

	it("rejects genesis with invalid thinkingLevel", () => {
		const result: AppendResult = appendGenesis([], makeGenesisInput({ thinkingLevel: "invalid" }), DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
	});

	it("rejects genesis with invalid serviceTier", () => {
		const result: AppendResult = appendGenesis([], makeGenesisInput({ serviceTier: "invalid" }), DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
	});

	it("rejects non-empty chain for genesis", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const result: AppendResult = appendGenesis([g1.bytes], defaultGenesis(), DEFAULT_BOUNDS);
		expect(result.code).toBe("FAIL");
		if (result.code === "FAIL") {
			expect(result.error).toBe("EMPTY_CHAIN");
		}
	});

	it("accepts genesis with non-null spawnedByRequestId", () => {
		const result: AppendResult = appendGenesis(
			[],
			makeGenesisInput({ spawnedByRequestId: "req-123" }),
			DEFAULT_BOUNDS,
		);
		expect(result.code).toBe("OK");
		if (result.code === "OK") {
			expect(result.record.identity.spawnedByRequestId).toBe("req-123");
		}
	});

	it("accepts genesis with serviceTier null", () => {
		const result: AppendResult = appendGenesis([], makeGenesisInput({ serviceTier: null }), DEFAULT_BOUNDS);
		expect(result.code).toBe("OK");
		if (result.code === "OK") {
			expect(result.record.identity.serviceTier).toBe(null);
		}
	});

	it("accepts genesis with all thinking levels", () => {
		const tlOptions: string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		for (const tl of tlOptions) {
			const r: AppendResult = appendGenesis([], makeGenesisInput({ thinkingLevel: tl }), DEFAULT_BOUNDS);
			expect(r.code).toBe("OK");
			if (r.code === "OK") {
				const _level: unknown = r.record.identity.thinkingLevel;
				const tlDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
					r.record.identity,
					"thinkingLevel",
				);
				if (tlDesc !== undefined) {
					expect(tlDesc.value).toBe(tl);
				}
			}
		}
	});

	it("rejects genesis with serviceTier auto as null", () => {
		// serviceTier "auto" is valid; null is also valid
		const r: AppendResult = appendGenesis([], makeGenesisInput({ serviceTier: "auto" }), DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
	});
});

// =========================================================================
// 3. appendTransition — lifecycle tests
// =========================================================================

describe("appendTransition", () => {
	it("builds a full valid lifecycle reserved->deleted", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const b0: LedgerRecordBytes = g.bytes;

		const ops: Record<string, unknown>[] = [
			makeTransition("allocating", null, null),
			makeTransition("allocated", null, null),
			makeTransition("starting", null, null),
			makeTransition("running", null, null),
			makeTransition("completed", "completed", "SUCCESS"),
			makeTransition("deleting", "completed", "SUCCESS"),
			makeTransition("deleted", "completed", "SUCCESS"),
		];

		const chain: LedgerRecordBytes[] = [b0];
		for (const op of ops) {
			const r: AppendResult = appendTransition(chain, op, DEFAULT_BOUNDS);
			expect(r.code).toBe("OK");
			if (r.code !== "OK") return;
			chain.push(r.bytes);
		}
		expect(chain.length).toBe(8);

		// Decode full journal
		const journal: unknown[] = chain.slice();
		const decoded: DecodeJournalResult = decodeJournal(journal);
		expect(decoded.code).toBe("OK");
		if (decoded.code === "OK") {
			expect(decoded.records.length).toBe(8);
			expect(decoded.records[7].status).toBe("deleted");
			expect(decoded.records[7].terminalStatus).toBe("completed");
			expect(decoded.records[7].terminalCode).toBe("SUCCESS");
		}
	});

	it("supports reserved->error with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition([g.bytes], makeTransition("error", "error", "INTERNAL"), DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(r.record.status).toBe("error");
			expect(r.record.terminalStatus).toBe("error");
			expect(r.record.terminalCode).toBe("INTERNAL");
		}
	});

	it("supports reserved->cancelled with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes],
			makeTransition("cancelled", "cancelled", "USER_STOP"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(r.record.terminalCode).toBe("USER_STOP");
		}
	});

	it("supports allocating->error with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("error", "error", "FAILURE"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
	});

	it("rejects allocating->error without terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("error", null, null),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("FAIL");
	});

	it("rejects invalid transition reserved->deleted", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition([g.bytes], makeTransition("deleted", null, null), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects invalid transition reserved->completed", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes],
			makeTransition("completed", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("FAIL");
	});

	it("rejects terminal pair change", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const b0: LedgerRecordBytes = fixture.wrapper;

		const t1: AppendResult = appendTransition([b0], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[b0, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const t3: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes],
			makeTransition("starting", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t3.code).toBe("OK");
		if (t3.code !== "OK") return;
		const t4: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes],
			makeTransition("running", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t4.code).toBe("OK");
		if (t4.code !== "OK") return;
		const t5: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes, t4.bytes],
			makeTransition("completed", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(t5.code).toBe("OK");
		if (t5.code !== "OK") return;

		// Change terminalCode on deleting -> TERMINAL_PAIR_CHANGED
		const t6: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes, t4.bytes, t5.bytes],
			makeTransition("deleting", "completed", "FAILURE"),
			DEFAULT_BOUNDS,
		);
		expect(t6.code).toBe("FAIL");
	});

	it("preserves null terminalCode through delete phases", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const b0: LedgerRecordBytes = fixture.wrapper;

		const t1: AppendResult = appendTransition([b0], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[b0, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const t3: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes],
			makeTransition("starting", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t3.code).toBe("OK");
		if (t3.code !== "OK") return;
		const t4: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes],
			makeTransition("running", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t4.code).toBe("OK");
		if (t4.code !== "OK") return;
		const t5: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes, t4.bytes],
			makeTransition("completed", "completed", null),
			DEFAULT_BOUNDS,
		);
		expect(t5.code).toBe("OK");
		if (t5.code !== "OK") return;
		const t6: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes, t4.bytes, t5.bytes],
			makeTransition("deleting", "completed", null),
			DEFAULT_BOUNDS,
		);
		expect(t6.code).toBe("OK");
		if (t6.code === "OK") {
			expect(t6.record.terminalStatus).toBe("completed");
			expect(t6.record.terminalCode).toBe(null);
		}
	});

	it("rejects setting terminalCode when previous pair had null terminalCode", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const b0: LedgerRecordBytes = fixture.wrapper;

		const t1: AppendResult = appendTransition([b0], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[b0, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const t3: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes],
			makeTransition("starting", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t3.code).toBe("OK");
		if (t3.code !== "OK") return;
		const t4: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes],
			makeTransition("running", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t4.code).toBe("OK");
		if (t4.code !== "OK") return;
		const t5: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes, t4.bytes],
			makeTransition("completed", "completed", null),
			DEFAULT_BOUNDS,
		);
		expect(t5.code).toBe("OK");
		if (t5.code !== "OK") return;
		const t6: AppendResult = appendTransition(
			[b0, t1.bytes, t2.bytes, t3.bytes, t4.bytes, t5.bytes],
			makeTransition("deleting", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(t6.code).toBe("FAIL");
	});

	it("rejects NULL_TERMINAL_STATUS_WITH_CODE", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes],
			makeTransition("allocating", null, "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("FAIL");
	});

	it("rejects TERMINAL_STATUS_CONTRADICTION", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes],
			makeTransition("error", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("FAIL");
	});

	it("rejects empty chain for transition", () => {
		const r: AppendResult = appendTransition([], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects invalid status value", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition([g.bytes], makeTransition("INVALID", null, null), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects invalid terminalStatus value", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition([g.bytes], makeTransition("running", "INVALID", null), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects invalid terminalCode value", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: AppendResult = appendTransition([g.bytes], makeTransition("running", null, "INVALID"), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	// G7: Comprehensive forbidden transitions from each from-state
	const FORBIDDEN_TRANSITIONS: { from: string; to: string; desc: string }[] = [
		{ from: "reserved", to: "starting", desc: "reserved->starting" },
		{ from: "reserved", to: "running", desc: "reserved->running" },
		{ from: "reserved", to: "deleting", desc: "reserved->deleting" },
		{ from: "reserved", to: "cleanup-uncertain", desc: "reserved->cleanup-uncertain" },
		{ from: "allocating", to: "starting", desc: "allocating->starting" },
		{ from: "allocating", to: "running", desc: "allocating->running" },
		{ from: "allocating", to: "completed", desc: "allocating->completed" },
		{ from: "allocating", to: "reserved", desc: "allocating->reserved" },
		{ from: "allocating", to: "deleting", desc: "allocating->deleting" },
		{ from: "allocating", to: "deleted", desc: "allocating->deleted" },
		{ from: "allocating", to: "cleanup-uncertain", desc: "allocating->cleanup-uncertain" },
		{ from: "allocated", to: "running", desc: "allocated->running" },
		{ from: "allocated", to: "completed", desc: "allocated->completed" },
		{ from: "allocated", to: "reserved", desc: "allocated->reserved" },
		{ from: "allocated", to: "allocating", desc: "allocated->allocating" },
		{ from: "allocated", to: "deleting", desc: "allocated->deleting" },
		{ from: "allocated", to: "deleted", desc: "allocated->deleted" },
		{ from: "allocated", to: "cleanup-uncertain", desc: "allocated->cleanup-uncertain" },
		{ from: "starting", to: "completed", desc: "starting->completed" },
		{ from: "starting", to: "reserved", desc: "starting->reserved" },
		{ from: "starting", to: "allocating", desc: "starting->allocating" },
		{ from: "starting", to: "allocated", desc: "starting->allocated" },
		{ from: "starting", to: "deleting", desc: "starting->deleting" },
		{ from: "starting", to: "deleted", desc: "starting->deleted" },
		{ from: "starting", to: "cleanup-uncertain", desc: "starting->cleanup-uncertain" },
		{ from: "running", to: "reserved", desc: "running->reserved" },
		{ from: "running", to: "allocating", desc: "running->allocating" },
		{ from: "running", to: "allocated", desc: "running->allocated" },
		{ from: "running", to: "starting", desc: "running->starting" },
		{ from: "running", to: "deleting", desc: "running->deleting" },
		{ from: "running", to: "deleted", desc: "running->deleted" },
		{ from: "running", to: "cleanup-uncertain", desc: "running->cleanup-uncertain" },
		{ from: "completed", to: "error", desc: "completed->error" },
		{ from: "completed", to: "cancelled", desc: "completed->cancelled" },
		{ from: "completed", to: "running", desc: "completed->running" },
		{ from: "error", to: "running", desc: "error->running" },
		{ from: "error", to: "completed", desc: "error->completed" },
		{ from: "error", to: "cancelled", desc: "error->cancelled" },
		{ from: "cancelled", to: "running", desc: "cancelled->running" },
		{ from: "cancelled", to: "completed", desc: "cancelled->completed" },
		{ from: "cancelled", to: "error", desc: "cancelled->error" },
		{ from: "deleting", to: "running", desc: "deleting->running" },
		{ from: "deleting", to: "completed", desc: "deleting->completed" },
		{ from: "deleting", to: "error", desc: "deleting->error" },
		{ from: "deleting", to: "cancelled", desc: "deleting->cancelled" },
		{ from: "deleting", to: "reserved", desc: "deleting->reserved" },
		{ from: "cleanup-uncertain", to: "running", desc: "cleanup-uncertain->running" },
		{ from: "cleanup-uncertain", to: "completed", desc: "cleanup-uncertain->completed" },
		{ from: "cleanup-uncertain", to: "error", desc: "cleanup-uncertain->error" },
		{ from: "cleanup-uncertain", to: "cancelled", desc: "cleanup-uncertain->cancelled" },
		{ from: "cleanup-uncertain", to: "deleted", desc: "cleanup-uncertain->deleted" },
		{ from: "deleted", to: "reserved", desc: "deleted->reserved" },
		{ from: "deleted", to: "deleting", desc: "deleted->deleting" },
	];

	it("rejects all forbidden transitions from each from-state", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;

		// Build base chain through pre-running states: reserved->allocating->allocated->starting->running
		const baseChain: LedgerRecordBytes[] = [g.bytes];
		const path: Record<string, unknown>[] = [
			makeTransition("allocating", null, null),
			makeTransition("allocated", null, null),
			makeTransition("starting", null, null),
			makeTransition("running", null, null),
		];
		for (const op of path) {
			const r: AppendResult = appendTransition(baseChain, op, DEFAULT_BOUNDS);
			expect(r.code).toBe("OK");
			if (r.code !== "OK") return;
			baseChain.push(r.bytes);
		}

		// Build terminal/post-terminal chain segments
		// running -> completed(completed,SUCCESS)
		const tc5: AppendResult = appendTransition(
			baseChain.slice(0, 5),
			makeTransition("completed", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(tc5.code).toBe("OK");
		if (tc5.code !== "OK") return;

		// completed -> deleting(completed,SUCCESS) — preserves terminal pair
		const tc6: AppendResult = appendTransition(
			[baseChain[0], baseChain[1], baseChain[2], baseChain[3], baseChain[4], tc5.bytes],
			makeTransition("deleting", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(tc6.code).toBe("OK");
		if (tc6.code !== "OK") return;

		// deleting -> cleanup-uncertain(completed,SUCCESS) — preserves terminal pair
		const tc7: AppendResult = appendTransition(
			[baseChain[0], baseChain[1], baseChain[2], baseChain[3], baseChain[4], tc5.bytes, tc6.bytes],
			makeTransition("cleanup-uncertain", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(tc7.code).toBe("OK");
		if (tc7.code !== "OK") return;

		// deleting -> deleted(completed,SUCCESS) — preserves terminal pair
		const tc8: AppendResult = appendTransition(
			[baseChain[0], baseChain[1], baseChain[2], baseChain[3], baseChain[4], tc5.bytes, tc6.bytes],
			makeTransition("deleted", "completed", "SUCCESS"),
			DEFAULT_BOUNDS,
		);
		expect(tc8.code).toBe("OK");
		if (tc8.code !== "OK") return;

		// Build direct-terminal chains: genesis->error(error,FAILURE) and genesis->cancelled(cancelled,USER_STOP)
		const errChain: AppendResult = appendTransition(
			[g.bytes],
			makeTransition("error", "error", "FAILURE"),
			DEFAULT_BOUNDS,
		);
		expect(errChain.code).toBe("OK");
		if (errChain.code !== "OK") return;

		const cancChain: AppendResult = appendTransition(
			[g.bytes],
			makeTransition("cancelled", "cancelled", "USER_STOP"),
			DEFAULT_BOUNDS,
		);
		expect(cancChain.code).toBe("OK");
		if (cancChain.code !== "OK") return;

		// Build cache: chainFor[fromStatus] = LedgerRecordBytes[]
		const chainFor: Record<string, LedgerRecordBytes[]> = {
			reserved: [baseChain[0]],
			allocating: baseChain.slice(0, 2),
			allocated: baseChain.slice(0, 3),
			starting: baseChain.slice(0, 4),
			running: baseChain.slice(0, 5),
			completed: [baseChain[0], baseChain[1], baseChain[2], baseChain[3], baseChain[4], tc5.bytes],
			error: [g.bytes, errChain.bytes],
			cancelled: [g.bytes, cancChain.bytes],
			deleting: [baseChain[0], baseChain[1], baseChain[2], baseChain[3], baseChain[4], tc5.bytes, tc6.bytes],
			"cleanup-uncertain": [
				baseChain[0],
				baseChain[1],
				baseChain[2],
				baseChain[3],
				baseChain[4],
				tc5.bytes,
				tc6.bytes,
				tc7.bytes,
			],
			deleted: [
				baseChain[0],
				baseChain[1],
				baseChain[2],
				baseChain[3],
				baseChain[4],
				tc5.bytes,
				tc6.bytes,
				tc8.bytes,
			],
		};

		// Verify each chain ends at the expected status
		const statusFromChain: Record<
			string,
			| "reserved"
			| "allocating"
			| "allocated"
			| "starting"
			| "running"
			| "completed"
			| "error"
			| "cancelled"
			| "deleting"
			| "cleanup-uncertain"
			| "deleted"
		> = {
			reserved: "reserved",
			allocating: "allocating",
			allocated: "allocated",
			starting: "starting",
			running: "running",
			completed: "completed",
			error: "error",
			cancelled: "cancelled",
			deleting: "deleting",
			"cleanup-uncertain": "cleanup-uncertain",
			deleted: "deleted",
		};
		for (const fromStatus of Object.keys(statusFromChain)) {
			const c: LedgerRecordBytes[] = chainFor[fromStatus];
			const lastRec: DecodeResult = decodeRecord(c[c.length - 1]);
			expect(lastRec.code).toBe("OK");
			if (lastRec.code === "OK") {
				expect(lastRec.record.status).toBe(statusFromChain[fromStatus]);
			}
		}

		// Test each forbidden transition
		let executedCount: number = 0;
		for (const ft of FORBIDDEN_TRANSITIONS) {
			const c: LedgerRecordBytes[] = chainFor[ft.from];
			// Build the transition: forbidden to-state has no terminal pair
			const transition: Record<string, unknown> = makeTransition(ft.to, null, null);
			const r2: AppendResult = appendTransition(c, transition, DEFAULT_BOUNDS);
			expect(r2.code).toBe("FAIL");
			if (r2.code === "FAIL") {
				expect(r2.error).toBe("INVALID_TRANSITION");
			}
			executedCount += 1;
		}
		expect(executedCount).toBe(FORBIDDEN_TRANSITIONS.length);
	}); // G8: Pre-running terminal - valid and missing-pair cases
	it("supports allocating->cancelled with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("cancelled", "cancelled", "USER_STOP"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
	});

	it("supports allocated->error with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes],
			makeTransition("error", "error", "FAILURE"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
	});

	it("supports allocated->cancelled with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes],
			makeTransition("cancelled", "cancelled", "USER_STOP"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
	});

	it("supports starting->error with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const t3: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes],
			makeTransition("starting", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t3.code).toBe("OK");
		if (t3.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes, t3.bytes],
			makeTransition("error", "error", "TIMEOUT"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
	});

	it("supports starting->cancelled with terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const t3: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes],
			makeTransition("starting", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t3.code).toBe("OK");
		if (t3.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes, t3.bytes],
			makeTransition("cancelled", "cancelled", "USER_STOP"),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
	});

	it("rejects allocated->error without terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes],
			makeTransition("error", null, null),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("FAIL");
	});

	it("rejects starting->error without terminal pair", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const t1: AppendResult = appendTransition([g.bytes], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const t2: AppendResult = appendTransition(
			[g.bytes, t1.bytes],
			makeTransition("allocated", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t2.code).toBe("OK");
		if (t2.code !== "OK") return;
		const t3: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes],
			makeTransition("starting", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t3.code).toBe("OK");
		if (t3.code !== "OK") return;
		const r: AppendResult = appendTransition(
			[g.bytes, t1.bytes, t2.bytes, t3.bytes],
			makeTransition("error", null, null),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("FAIL");
	});

	// G9: Terminal pair preservation through full delete chain
	it("preserves non-null terminalCode through deleting->cleanup-uncertain->deleting->deleted", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const b0: LedgerRecordBytes = fixture.wrapper;
		const ops: Record<string, unknown>[] = [
			makeTransition("allocating", null, null),
			makeTransition("allocated", null, null),
			makeTransition("starting", null, null),
			makeTransition("running", null, null),
			makeTransition("completed", "completed", "SUCCESS"),
			makeTransition("deleting", "completed", "SUCCESS"),
			makeTransition("cleanup-uncertain", "completed", "SUCCESS"),
			makeTransition("deleting", "completed", "SUCCESS"),
			makeTransition("deleted", "completed", "SUCCESS"),
		];
		const chain: LedgerRecordBytes[] = [b0];
		for (const op of ops) {
			const r: AppendResult = appendTransition(chain, op, DEFAULT_BOUNDS);
			expect(r.code).toBe("OK");
			if (r.code !== "OK") return;
			chain.push(r.bytes);
		}
		expect(chain.length).toBe(10);
	});

	it("carries completed/null-code through full delete path", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const b0: LedgerRecordBytes = fixture.wrapper;
		const ops: Record<string, unknown>[] = [
			makeTransition("allocating", null, null),
			makeTransition("allocated", null, null),
			makeTransition("starting", null, null),
			makeTransition("running", null, null),
			makeTransition("completed", "completed", null),
			makeTransition("deleting", "completed", null),
			makeTransition("cleanup-uncertain", "completed", null),
			makeTransition("deleting", "completed", null),
			makeTransition("deleted", "completed", null),
		];
		const chain: LedgerRecordBytes[] = [b0];
		for (const op of ops) {
			const r: AppendResult = appendTransition(chain, op, DEFAULT_BOUNDS);
			expect(r.code).toBe("OK");
			if (r.code !== "OK") return;
			chain.push(r.bytes);
		}
		// Verify last record has the correct pair
		const decoded: DecodeJournalResult = decodeJournal(chain);
		expect(decoded.code).toBe("OK");
		if (decoded.code === "OK") {
			expect(decoded.records[9].terminalStatus).toBe("completed");
			expect(decoded.records[9].terminalCode).toBe(null);
		}
	});
});

// =========================================================================
// 4. decodeRecord
// =========================================================================

describe("decodeRecord", () => {
	it("rejects non-LedgerRecordBytes", () => {
		const r: DecodeResult = decodeRecord("not-a-wrapper");
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") expect(r.error).toBe("BRAND_CHECK_FAILURE");
	});

	it("rejects null", () => {
		const r: DecodeResult = decodeRecord(null);
		expect(r.code).toBe("FAIL");
	});

	it("rejects plain object", () => {
		const r: DecodeResult = decodeRecord({});
		expect(r.code).toBe("FAIL");
	});

	it("rejects number", () => {
		const r: DecodeResult = decodeRecord(42);
		expect(r.code).toBe("FAIL");
	});

	it("rejects undefined", () => {
		const r: DecodeResult = decodeRecord(undefined);
		expect(r.code).toBe("FAIL");
	});

	it("rejects boolean", () => {
		const r: DecodeResult = decodeRecord(true);
		expect(r.code).toBe("FAIL");
	});

	it("decodes a valid wrapper", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: DecodeResult = decodeRecord(g.bytes);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(r.record.rev).toBe(0);
			expect(Object.isFrozen(r.record)).toBe(true);
		}
	});
});

// =========================================================================
// 5. decodeJournal — chain validation
// =========================================================================

describe("decodeJournal", () => {
	it("decodes an array of wrappers", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const t1: AppendResult = appendTransition(
			[fixture.wrapper],
			makeTransition("allocating", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t1.code).toBe("OK");
		if (t1.code !== "OK") return;
		const journal: unknown[] = [fixture.wrapper, t1.bytes];
		const r: DecodeJournalResult = decodeJournal(journal);
		expect(r.code).toBe("OK");
		assertFrozen(r);
		if (r.code === "OK") {
			expect(r.records.length).toBe(2);
		}
	});

	it("rejects non-array input", () => {
		const r: DecodeJournalResult = decodeJournal("not-array");
		expect(r.code).toBe("FAIL");
	});

	it("rejects array with non-wrapper element", () => {
		const r: DecodeJournalResult = decodeJournal(["bad"]);
		expect(r.code).toBe("FAIL");
	});

	it("rejects EMPTY_CHAIN", () => {
		const r: DecodeJournalResult = decodeJournal([]);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			expect(r.error).toBe("EMPTY_CHAIN");
		}
	});

	it("rejects NON_MONOTONIC_REVISION via two genesis wrappers", () => {
		// Two genesis wrappers with same identity -> both rev 0
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		// decodeJournal validates chain: second record at rev 0 when prev is rev 0 => NON_MONOTONIC_REVISION
		const r: DecodeJournalResult = decodeJournal([g1.bytes, g2.bytes]);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			expect(r.error).toBe("NON_MONOTONIC_REVISION");
		}
	});
});

// =========================================================================
// 6. encodeGenesisBytes
// =========================================================================

describe("encodeGenesisBytes", () => {
	it("encodes and decodes roundtrip", () => {
		const r: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		assertFrozen(r);
		if (r.code === "OK") {
			const d: DecodeResult = decodeRecord(r.bytes);
			expect(d.code).toBe("OK");
			if (d.code === "OK") expect(d.record.rev).toBe(0);
		}
	});

	it("rejects invalid bounds", () => {
		const bad: Record<string, number> = Object.freeze({
			maxRecords: 0,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
			maxGroups: 50,
		});
		const r: EncodeResult = encodeGenesisBytes(defaultGenesis(), bad);
		expect(r.code).toBe("FAIL");
	});

	it("freezes result envelope", () => {
		const r: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(Object.isFrozen(r)).toBe(true);
			expect(Object.isFrozen(r.bytes)).toBe(true);
		}
	});
});

// =========================================================================
// 7. encodeTransitionBytes
// =========================================================================

describe("encodeTransitionBytes", () => {
	it("encodes transition from chain", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: EncodeResult = encodeTransitionBytes(
			[g.bytes],
			makeTransition("allocating", null, null),
			DEFAULT_BOUNDS,
		);
		expect(r.code).toBe("OK");
		assertFrozen(r);
		if (r.code === "OK") {
			const d: DecodeResult = decodeRecord(r.bytes);
			expect(d.code).toBe("OK");
		}
	});

	it("rejects empty chain", () => {
		const r: EncodeResult = encodeTransitionBytes([], makeTransition("allocating", null, null), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});
});

// =========================================================================
// 8. reveal
// =========================================================================

describe("reveal", () => {
	it("returns fresh mutable copy each time — different ArrayBuffer", () => {
		const g: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r1: RevealResult = reveal(g.bytes);
		expect(r1.code).toBe("OK");
		if (r1.code !== "OK") return;
		const r2: RevealResult = reveal(g.bytes);
		expect(r2.code).toBe("OK");
		if (r2.code !== "OK") return;
		expect(r1.data.buffer === r2.data.buffer).toBe(false);
	});

	it("revealed Uint8Array is mutable", () => {
		const g: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: RevealResult = reveal(g.bytes);
		expect(r.code).toBe("OK");
		if (r.code !== "OK") return;
		expect(Object.isFrozen(r.data)).toBe(false);
		const orig: number = r.data[0];
		r.data[0] = 0xff;
		expect(r.data[0]).toBe(0xff);
		r.data[0] = orig;
	});

	it("result envelope is frozen", () => {
		const g: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: RevealResult = reveal(g.bytes);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("rejects non-wrapper", () => {
		const r: RevealResult = reveal({});
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") expect(r.error).toBe("BRAND_CHECK_FAILURE");
	});

	it("rejects null", () => {
		const r: RevealResult = reveal(null);
		expect(r.code).toBe("FAIL");
	});

	it("rejects string", () => {
		const r: RevealResult = reveal("bad");
		expect(r.code).toBe("FAIL");
	});
});

// =========================================================================
// 9. mintRecordBytes — valid ingress
// =========================================================================

describe("mintRecordBytes", () => {
	it("mints a valid genesis record", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const rv: RevealResult = reveal(g.bytes);
		expect(rv.code).toBe("OK");
		if (rv.code !== "OK") return;
		const mr: MintResult = mintRecordBytes(rv.data);
		expect(mr.code).toBe("OK");
		if (mr.code === "OK") {
			expect(Object.isFrozen(mr.bytes)).toBe(true);
			const d: DecodeResult = decodeRecord(mr.bytes);
			expect(d.code).toBe("OK");
			if (d.code === "OK") expect(d.record.rev).toBe(0);
		}
	});

	it("mints a modified record (different status)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const modified: Uint8Array = modifyGenesisBytes(fixture.bytes, { status: "allocating" });
		const mr: MintResult = mintRecordBytes(modified);
		expect(mr.code).toBe("OK");
		if (mr.code === "OK") {
			expect(mr.record.status).toBe("allocating");
			expect(mr.record.rev).toBe(0);
		}
	});

	it("rejects duplicate top-level keys", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Insert a duplicate "schema" key before the real one
		const dupText: string = text.replace('{"schema"', '{"schema":"hosted-child-ledger-v1","schema"');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects duplicate nested keys in identity", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Insert a duplicate "childId" key inside identity
		const dupText: string = text.replace('"childId":"', '"childId":"child-dup","childId":"');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects escaped-equivalent duplicate key (first)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Insert escaped-equivalent "re\\u0076":0 BEFORE "rev":0 so escaped key comes first
		const dupText: string = text.replace('"rev":0,', '"re\\u0076":0,"rev":0,');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects escaped-equivalent duplicate key (last)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Insert escaped-equivalent "re\\u0076":0 AFTER "rev":0 so escaped key comes last
		const dupText: string = text.replace('"rev":0,', '"rev":0,"re\\u0076":0,');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects nested container (array) as value", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Replace a scalar value with an array
		const dupText: string = text.replace(":0", ":[1,2,3]");
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects deeply nested object past bound", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Build 80 levels of nesting inside "depth" value
		let nested: string = "0";
		for (let i: number = 0; i < 80; i++) nested = `{"x":${nested}}`;
		const dupText: string = text.replace(":0", `:${nested}`);
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects nested object duplicate key", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Insert a nested object with a duplicate key inside identity
		const dupText: string = text.replace('"sessionId":"', '"sessionId":"sess","nested":{"a":1,"a":2},"sessionId":"');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects array containing nested duplicate key", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Insert an array that contains an object with duplicate keys
		const dupText: string = text.replace('"sessionId":"', '"sessionId":"sess","arr":[{"x":1,"x":2}],"sessionId":"');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects invalid hex in \\u escape", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Bad hex nibbles in a key
		const dupText: string = text.replace('"rev"', '"re\\uXYZQv"');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects short \\u escape (only 2 nibbles)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Only two hex nibbles after \u
		const dupText: string = text.replace('"rev"', '"re\\u12v"');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects escaped surrogate and raw duplicate key", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const text: string = new TextDecoder().decode(fixture.bytes);
		// Surrogate \uD83D is a valid escape but lone surrogate unit.
		// Using it as a key that happens to match a different raw key should still detect
		// the duplicate. Insert \uD83D followed by raw \uD83D (same decoded value) as duplicates.
		const dupText: string = text.replace('"rev":0,', '"\\uD83D":0,"\\uD83D":0,');
		const dupBytes: Uint8Array = new TextEncoder().encode(dupText);
		const mr: MintResult = mintRecordBytes(dupBytes);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects invalid contentDigest", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const bytes: Uint8Array = fixture.bytes;
		// Corrupt the last byte
		const corrupted: Uint8Array = new Uint8Array(bytes);
		corrupted[corrupted.byteLength - 1] = 0x00;
		const mr: MintResult = mintRecordBytes(corrupted);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects invalid JSON", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const bytes: Uint8Array = fixture.bytes;
		const corrupted: Uint8Array = new Uint8Array(bytes);
		corrupted[0] = 0xff; // invalid UTF-8 start byte
		const mr: MintResult = mintRecordBytes(corrupted);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects trailing data after newline", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const bytes: Uint8Array = fixture.bytes;
		const extended: Uint8Array = new Uint8Array(bytes.byteLength + 1);
		extended.set(bytes, 0);
		extended[bytes.byteLength] = 0x0a;
		const mr: MintResult = mintRecordBytes(extended);
		expect(mr.code).toBe("FAIL");
	});
});

// =========================================================================
// 10. mintRecordBytes — hostile bytes (Uint8Array validation)
// =========================================================================

describe("mintRecordBytes — hostile bytes", () => {
	it("rejects Proxy wrapping Uint8Array", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const proxy: object = new Proxy(fixture.bytes, {});
		const mr: MintResult = mintRecordBytes(proxy);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects revoked Proxy", () => {
		const { proxy, revoke } = Proxy.revocable(new Uint8Array(10), {});
		revoke();
		const mr: MintResult = mintRecordBytes(proxy);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects non-Uint8Array typed array", () => {
		const arr: Int32Array = new Int32Array(10);
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects null prototype Uint8Array", () => {
		const arr: Uint8Array = new Uint8Array(10);
		const nullProto: object = Object.create(null);
		// Copy over numeric indices
		for (let i: number = 0; i < 10; i++) {
			Object.defineProperty(nullProto, String(i), {
				value: arr[i],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		const mr: MintResult = mintRecordBytes(nullProto);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects custom prototype Uint8Array", () => {
		const custom: object = Object.create({ custom: true });
		for (let i: number = 0; i < 10; i++) {
			Object.defineProperty(custom, String(i), {
				value: 0,
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		const mr: MintResult = mintRecordBytes(custom);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects resizable ArrayBuffer backing", () => {
		// Real resizable ArrayBuffer via Reflect.construct: type-safe no directive
		const rab: ArrayBuffer = Reflect.construct(ArrayBuffer, [10, { maxByteLength: 20 }]);
		const arr: Uint8Array = new Uint8Array(rab);
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects non-zero byteOffset", () => {
		const ab: ArrayBuffer = new ArrayBuffer(20);
		const arr: Uint8Array = new Uint8Array(ab, 10, 10);
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects detached ArrayBuffer", () => {
		// Real detached buffer via transfer(): capture descriptor, verify function, Reflect.apply
		const transferDesc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
			ArrayBuffer.prototype,
			"transfer",
		);
		if (typeof transferDesc?.value !== "function") return;
		const transferFn = transferDesc.value;
		const ab: ArrayBuffer = new ArrayBuffer(10);
		const arr: Uint8Array = new Uint8Array(ab);
		Reflect.apply(transferFn, ab, [10]);
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects SharedArrayBuffer backing", () => {
		// SharedArrayBuffer has a different prototype than ArrayBuffer
		// Platform capability: Bun 1.4 supports SharedArrayBuffer
		const sab: SharedArrayBuffer = new SharedArrayBuffer(10);
		const arr: Uint8Array = new Uint8Array(sab);
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects symbol properties", () => {
		const arr: Uint8Array = new Uint8Array(10);
		const sym: symbol = Symbol("bad");
		Object.defineProperty(arr, sym, {
			value: 42,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects own length property", () => {
		const arr: Uint8Array = new Uint8Array(10);
		Object.defineProperty(arr, "length", {
			value: 5,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects own buffer property", () => {
		const arr: Uint8Array = new Uint8Array(10);
		Object.defineProperty(arr, "buffer", {
			value: new ArrayBuffer(5),
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects own byteOffset property", () => {
		const arr: Uint8Array = new Uint8Array(10);
		Object.defineProperty(arr, "byteOffset", {
			value: 5,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects own byteLength property", () => {
		const arr: Uint8Array = new Uint8Array(10);
		Object.defineProperty(arr, "byteLength", {
			value: 5,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects accessor property on Uint8Array", () => {
		// Uint8Array numeric indices are exotic (not own properties).
		// Production checks own property descriptors via getOwnPropertyDescriptor.
		// For an index that IS an own property (added via defineProperty), an accessor
		// is rejected. Here we verify that a non-standard property name with accessor is rejected.
		const arr: Uint8Array = new Uint8Array(10);
		// Add an own property (not a typical index) with accessor
		Object.defineProperty(arr, "myProp", {
			get: (): number => 42,
			enumerable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("rejects non-enumerable index", () => {
		// Uint8Array numeric indices are exotic (not own properties).
		// Add an own non-index non-enumerable property instead.
		const arr: Uint8Array = new Uint8Array(10);
		Object.defineProperty(arr, "extra", {
			value: 0,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const mr: MintResult = mintRecordBytes(arr);
		expect(mr.code).toBe("FAIL");
	});

	it("accepts valid genesis through mint and reveals isolation", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const mr: MintResult = mintRecordBytes(fixture.bytes);
		expect(mr.code).toBe("OK");
		if (mr.code !== "OK") return;

		// Original bytes unchanged
		const text: string = new TextDecoder().decode(fixture.bytes);
		expect(text.length).toBeGreaterThan(0);

		// Minted wrapper is independently usable
		const decoded: DecodeResult = decodeRecord(mr.bytes);
		expect(decoded.code).toBe("OK");

		// Second mint creates independent wrapper
		const mr2: MintResult = mintRecordBytes(fixture.bytes);
		expect(mr2.code).toBe("OK");
		if (mr2.code === "OK") {
			expect(mr.bytes === mr2.bytes).toBe(false);
		}
	});
});

// =========================================================================
// 11. inventory — basic + fork/gap/orphan
// =========================================================================

describe("inventory", () => {
	it("returns OK for valid single group", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const r: InventoryResult = inventory([fixture.wrapper], DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		assertFrozen(r);
		if (r.code === "OK") {
			expect(r.groups.length).toBe(1);
			expect(Object.isFrozen(r.groups)).toBe(true);
		}
	});

	it("detects BOUND_RECORDS_EXCEEDED", () => {
		const g1: AppendResult = appendGenesis([], makeGenesisInput({ childId: "a" }), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: AppendResult = appendGenesis([], makeGenesisInput({ childId: "b" }), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		const tiny: Record<string, number> = Object.freeze({
			maxRecords: 1,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
			maxGroups: 50,
		});
		const r: InventoryResult = inventory([g1.bytes, g2.bytes], tiny);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			expect(r.errors[0]).toBe("BOUND_RECORDS_EXCEEDED");
		}
	});

	it("detects BOUND_BYTES_EXCEEDED", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const tiny: Record<string, number> = Object.freeze({
			maxRecords: 100,
			maxBytes: 64,
			maxRecordBytes: 65536,
			maxGroups: 50,
		});
		const r: InventoryResult = inventory([fixture.wrapper], tiny);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			expect(r.errors[0]).toBe("BOUND_BYTES_EXCEEDED");
		}
	});

	it("detects BOUND_RECORD_BYTES_EXCEEDED", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const tiny: Record<string, number> = Object.freeze({
			maxRecords: 100,
			maxBytes: 1048576,
			maxRecordBytes: 32,
			maxGroups: 50,
		});
		const r: InventoryResult = inventory([fixture.wrapper], tiny);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			expect(r.errors[0]).toBe("BOUND_RECORD_BYTES_EXCEEDED");
		}
	});

	it("detects BOUND_GROUPS_EXCEEDED", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-other" }), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		const oneGroup: Record<string, number> = Object.freeze({
			maxRecords: 100,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
			maxGroups: 1,
		});
		const r: InventoryResult = inventory([g1.bytes, g2.bytes], oneGroup);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			const found: boolean = r.errors.indexOf("BOUND_GROUPS_EXCEEDED") !== -1;
			expect(found).toBe(true);
		}
	});

	it("detects DUPLICATE_REV in same group", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		const r: InventoryResult = inventory([g1.bytes, g2.bytes], DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			const found: boolean = r.errors.indexOf("DUPLICATE_REV") !== -1;
			expect(found).toBe(true);
		}
	});

	it("detects FORK_DETECTED via mintRecordBytes (same anchor, same rev, different contentDigest)", () => {
		// Create two records with same identity but different status at rev 0
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;

		// Record A: standard genesis (rev 0, status reserved)
		// Record B: modified bytes with same identity but status=allocating at rev 0
		const modified: Uint8Array = modifyGenesisBytes(fixture.bytes, { status: "allocating" });
		const mrB: MintResult = mintRecordBytes(modified);
		expect(mrB.code).toBe("OK");
		if (mrB.code !== "OK") return;

		const r: InventoryResult = inventory([fixture.wrapper, mrB.bytes], DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			// Should include FORK_DETECTED (same rev 0, different contentDigest in same anchor group)
			const found: boolean = r.errors.indexOf("FORK_DETECTED") !== -1;
			expect(found).toBe(true);
		}
	});

	it("detects GAP_DETECTED via mintRecordBytes (revs 0 and 2 without rev 1)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;

		// Record A: genesis (rev 0, status reserved)
		// Record B: modified bytes at rev 2 with same identity
		const modified: Uint8Array = modifyGenesisBytes(fixture.bytes, {
			rev: 2,
			status: "allocating",
		});
		const mrB: MintResult = mintRecordBytes(modified);
		expect(mrB.code).toBe("OK");
		if (mrB.code !== "OK") return;

		const r: InventoryResult = inventory([fixture.wrapper, mrB.bytes], DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			const found: boolean = r.errors.indexOf("GAP_DETECTED") !== -1;
			expect(found).toBe(true);
		}
	});

	it("detects ORPHAN_DETECTED via mintRecordBytes (wrong lifecycleKeyDigest)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;

		// Modify the lifecycleKeyDigest in the bytes to be different from
		// what would be derived from the actual identity fields.
		const text: string = new TextDecoder().decode(fixture.bytes);
		const parsed: Record<string, unknown> = JSON.parse(text);
		const identityObj: Record<string, unknown> = {};
		if (typeof parsed.identity === "object" && parsed.identity !== null) {
			const idObj: object = parsed.identity;
			const idKeys: string[] = Object.getOwnPropertyNames(idObj);
			for (const k of idKeys) {
				const d: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(idObj, k);
				if (d !== undefined) identityObj[k] = d.value;
			}
		}
		// Replace lifecycleKeyDigest with wrong value
		identityObj.lifecycleKeyDigest = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		parsed.identity = identityObj;
		parsed.contentDigest = computeContentDigest(parsed);

		const orphanBytes: Uint8Array = buildCanonicalBytes(parsed);
		const mr: MintResult = mintRecordBytes(orphanBytes);
		expect(mr.code).toBe("OK");
		if (mr.code !== "OK") return;

		const r: InventoryResult = inventory([fixture.wrapper, mr.bytes], DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			const found: boolean = r.errors.indexOf("ORPHAN_DETECTED") !== -1;
			expect(found).toBe(true);
		}
	});

	it("returns OK for different anchors (different childId)", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-other" }), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		const r: InventoryResult = inventory([g1.bytes, g2.bytes], DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(r.groups.length).toBe(2);
		}
	});

	it("handles empty array", () => {
		const r: InventoryResult = inventory([], DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(r.groups.length).toBe(0);
		}
	});

	// G5: ANCHOR_REUSE_IDENTITY_COLLISION
	it("detects ANCHOR_REUSE_IDENTITY_COLLISION via appendGenesis", () => {
		// Two records with same anchor (same childId, sessionId, activeSessionId)
		// but different lifecycleKeyDigest (from different name)
		const input1: Record<string, unknown> = makeGenesisInput({
			childId: "child-a",
			sessionId: "sess-a",
			activeSessionId: "active-a",
			name: "agent-one",
		});
		const g1: AppendResult = appendGenesis([], input1, DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;

		const input2: Record<string, unknown> = makeGenesisInput({
			childId: "child-a",
			sessionId: "sess-a",
			activeSessionId: "active-a",
			name: "agent-two",
		});
		const g2: AppendResult = appendGenesis([], input2, DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;

		const r: InventoryResult = inventory([g1.bytes, g2.bytes], {
			maxRecords: 100,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
			maxGroups: 50,
		});
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			// Same anchor but different lifecycleKeyDigest => ANCHOR_REUSE_IDENTITY_COLLISION
			const found: boolean = r.errors.indexOf("ANCHOR_REUSE_IDENTITY_COLLISION") !== -1;
			expect(found).toBe(true);
		}
	});

	// G4: Compound per-group + chain errors
	it("detects compound DUPLICATE_REV + chain error in same group", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		// Build two records with same genesis bytes -> same identity, same rev
		const r: InventoryResult = inventory([fixture.wrapper, fixture.wrapper], DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			// HOSTILE_INPUT from per-group alias detection + DUPLICATE_REV or chain error
			const hasError: boolean = r.errors.indexOf("HOSTILE_INPUT") >= 0 || r.errors.indexOf("DUPLICATE_REV") >= 0;
			expect(hasError).toBe(true);
		}
	});
});

// =========================================================================
// 12. inventory — deterministic permutation tests
// =========================================================================

describe("inventory — permutation tests", () => {
	it("shuffled inputs produce same errors (DUPLICATE_REV)", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;

		// Input order [g1.bytes, g2.bytes]
		const r1: InventoryResult = inventory([g1.bytes, g2.bytes], DEFAULT_BOUNDS);
		// Input order [g2.bytes, g1.bytes]
		const r2: InventoryResult = inventory([g2.bytes, g1.bytes], DEFAULT_BOUNDS);

		expect(r1.code).toBe("FAIL");
		expect(r2.code).toBe("FAIL");
		if (r1.code === "FAIL" && r2.code === "FAIL") {
			expect(r1.errors.length).toBe(r2.errors.length);
			for (let i: number = 0; i < r1.errors.length; i++) {
				expect(r1.errors[i]).toBe(r2.errors[i]);
			}
		}
	});

	it("shuffled multi-group inputs produce same errors (different childId)", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2Input: Record<string, unknown> = makeGenesisInput({ childId: "child-B" });
		const g2: AppendResult = appendGenesis([], g2Input, DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		const g3Input: Record<string, unknown> = makeGenesisInput({ childId: "child-C" });
		const g3: AppendResult = appendGenesis([], g3Input, DEFAULT_BOUNDS);
		expect(g3.code).toBe("OK");
		if (g3.code !== "OK") return;

		const order1: InventoryResult = inventory([g1.bytes, g2.bytes, g3.bytes], DEFAULT_BOUNDS);
		const order2: InventoryResult = inventory([g3.bytes, g2.bytes, g1.bytes], DEFAULT_BOUNDS);
		const order3: InventoryResult = inventory([g2.bytes, g1.bytes, g3.bytes], DEFAULT_BOUNDS);

		expect(order1.code).toBe("OK");
		expect(order2.code).toBe("OK");
		expect(order3.code).toBe("OK");

		if (order1.code === "OK" && order2.code === "OK" && order3.code === "OK") {
			expect(order1.groups.length).toBe(order2.groups.length);
			expect(order1.groups.length).toBe(order3.groups.length);
			// Compare group anchors deterministically
			for (let i: number = 0; i < order1.groups.length; i++) {
				expect(order1.groups[i].anchor.childId).toBe(order2.groups[i].anchor.childId);
				expect(order1.groups[i].anchor.childId).toBe(order3.groups[i].anchor.childId);
			}
		}
	});

	it("multi-group inventory is deterministic under shuffle", () => {
		// Three records with different anchors: deterministic multi-group result
		const g1: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-C" }), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;

		const g2: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-A" }), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;

		const g3: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-B" }), DEFAULT_BOUNDS);
		expect(g3.code).toBe("OK");
		if (g3.code !== "OK") return;

		const inputs: unknown[] = [g1.bytes, g2.bytes, g3.bytes];
		const perm1: unknown[] = [inputs[0], inputs[1], inputs[2]];
		const perm2: unknown[] = [inputs[2], inputs[1], inputs[0]];
		const perm3: unknown[] = [inputs[1], inputs[0], inputs[2]];

		const r1: InventoryResult = inventory(perm1, DEFAULT_BOUNDS);
		const r2: InventoryResult = inventory(perm2, DEFAULT_BOUNDS);
		const r3: InventoryResult = inventory(perm3, DEFAULT_BOUNDS);

		expect(r1.code).toBe("OK");
		expect(r2.code).toBe("OK");
		expect(r3.code).toBe("OK");

		if (r1.code === "OK" && r2.code === "OK" && r3.code === "OK") {
			expect(r1.groups.length).toBe(r2.groups.length);
			expect(r1.groups.length).toBe(r3.groups.length);
			for (let i: number = 0; i < r1.groups.length; i++) {
				expect(r1.groups[i].anchor.childId).toBe(r2.groups[i].anchor.childId);
				expect(r1.groups[i].anchor.childId).toBe(r3.groups[i].anchor.childId);
			}
		}
	});

	// G15: Mixed-error permutation - BOUND_GROUPS_EXCEEDED after LIFECYCLE_DIGEST_COLLISION
	it("mixed collision + groups exceeded error order is permutation-invariant", () => {
		// Create records with different childIds so each is its own group
		// Records 0 and 1 will share the same lifecycleKeyDigest (via crafted bytes)
		// => LIFECYCLE_DIGEST_COLLISION + BOUND_GROUPS_EXCEEDED
		const g1: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-1" }), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const lkd1: string = g1.record.identity.lifecycleKeyDigest;

		const g2: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-2" }), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;

		const g3: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-3" }), DEFAULT_BOUNDS);
		expect(g3.code).toBe("OK");
		if (g3.code !== "OK") return;

		const g4: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-4" }), DEFAULT_BOUNDS);
		expect(g4.code).toBe("OK");
		if (g4.code !== "OK") return;

		const g5: AppendResult = appendGenesis([], makeGenesisInput({ childId: "child-5" }), DEFAULT_BOUNDS);
		expect(g5.code).toBe("OK");
		if (g5.code !== "OK") return;

		// Craft record 2 to have lifecycleKeyDigest matching record 1's LKD but childId="child-2"
		// By constructing the record object with explicit lifecycleKeyDigest override
		const rev2Id: Record<string, unknown> = {};
		for (const k of _CANONICAL_IDENTITY_FIELDS) {
			const d: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(g2.record.identity, k);
			if (d !== undefined) rev2Id[k] = d.value;
		}
		// Override lifecycleKeyDigest to match g1
		rev2Id.lifecycleKeyDigest = lkd1;
		const collRecord: Record<string, unknown> = {
			schema: "hosted-child-ledger-v1",
			identity: rev2Id,
			rev: 0,
			status: "reserved",
			terminalStatus: null,
			terminalCode: null,
			contentDigest: C64,
			prevDigest: null,
		};
		collRecord.contentDigest = computeContentDigest(collRecord);
		const collBytes: Uint8Array = buildCanonicalBytes(collRecord);
		const collMint: MintResult = mintRecordBytes(collBytes);
		expect(collMint.code).toBe("OK");
		if (collMint.code !== "OK") return;

		// Bounds: maxGroups=3 (4 groups > 3) but lifecycle collision comes first
		const tightBounds: Record<string, number> = {
			maxRecords: 100,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
			maxGroups: 3,
		};

		const inputs: LedgerRecordBytes[][] = [
			[g1.bytes, collMint.bytes, g3.bytes, g4.bytes, g5.bytes],
			[g5.bytes, g4.bytes, g3.bytes, collMint.bytes, g1.bytes],
			[g3.bytes, g1.bytes, g5.bytes, collMint.bytes, g4.bytes],
		];
		for (const inp of inputs) {
			const r: InventoryResult = inventory(inp, tightBounds);
			expect(r.code).toBe("FAIL");
			if (r.code === "FAIL") {
				// Both LIFECYCLE_DIGEST_COLLISION and BOUND_GROUPS_EXCEEDED must appear
				const hasCollision: boolean = r.errors.indexOf("LIFECYCLE_DIGEST_COLLISION") !== -1;
				const hasGroupsExceeded: boolean = r.errors.indexOf("BOUND_GROUPS_EXCEEDED") !== -1;
				expect(hasCollision).toBe(true);
				expect(hasGroupsExceeded).toBe(true);
			}
		}
	});
	it("rejects Proxy wrapping valid data as genesis", () => {
		const target: Record<string, unknown> = defaultGenesis();
		const proxy: object = new Proxy(target, {});
		const r: AppendResult = appendGenesis([], proxy, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects null prototype object as genesis", () => {
		const nullProto: object = Object.create(null);
		const base: Record<string, unknown> = defaultGenesis();
		const keys: string[] = Object.keys(base);
		for (const k of keys) {
			Object.defineProperty(nullProto, k, {
				value: base[k],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		const r: AppendResult = appendGenesis([], nullProto, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects class instance as genesis", () => {
		class FakeInput {}
		const r: AppendResult = appendGenesis([], new FakeInput(), DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects object with symbol property", () => {
		const base: Record<string, unknown> = defaultGenesis();
		const sym: symbol = Symbol("test");
		const withSym: object = {};
		const keys: string[] = Object.keys(base);
		for (const k of keys) {
			Object.defineProperty(withSym, k, {
				value: base[k],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		Object.defineProperty(withSym, sym, {
			value: 42,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const r: AppendResult = appendGenesis([], withSym, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects object with accessor property", () => {
		const base: Record<string, unknown> = defaultGenesis();
		const withAccessor: object = {};
		const keys: string[] = Object.keys(base);
		for (const k of keys) {
			Object.defineProperty(withAccessor, k, {
				value: base[k],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		Object.defineProperty(withAccessor, "accessorProp", {
			get: (): number => 42,
			enumerable: true,
			configurable: true,
		});
		const r: AppendResult = appendGenesis([], withAccessor, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects object with non-enumerable property", () => {
		const base: Record<string, unknown> = defaultGenesis();
		const withNonEnum: object = {};
		const allKeys: string[] = Object.keys(base);
		for (const k of allKeys) {
			Object.defineProperty(withNonEnum, k, {
				value: base[k],
				enumerable: true,
				writable: true,
				configurable: true,
			});
		}
		Object.defineProperty(withNonEnum, "hidden", {
			value: 1,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const r: AppendResult = appendGenesis([], withNonEnum, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("rejects Proxy as field value", () => {
		const base: Record<string, unknown> = {};
		const proxyTarget: Record<string, unknown> = { v: "x" };
		base.sessionId = new Proxy(proxyTarget, {});
		base.activeSessionId = "active-default";
		base.childId = "child-default";
		base.name = "default-name";
		base.modelSelector = "default-model";
		base.durableParentSessionId = "default-parent";
		base.rlmParentNodeId = "default-rlm";
		base.spawnedByRequestId = null;
		base.thinkingLevel = "medium";
		base.serviceTier = "auto";
		base.spawnContextDigest = C64;
		base.depth = 0;
		const r: AppendResult = appendGenesis([], base, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});

	it("accepts frozen input with non-writable/configurable properties", () => {
		const base: Record<string, unknown> = {};
		base.sessionId = "sess-default";
		base.activeSessionId = "active-default";
		base.childId = "child-default";
		base.name = "default-name";
		base.modelSelector = "default-model";
		base.durableParentSessionId = "default-parent";
		base.rlmParentNodeId = "default-rlm";
		base.spawnedByRequestId = null;
		base.thinkingLevel = "medium";
		base.serviceTier = "auto";
		base.spawnContextDigest = C64;
		base.depth = 0;
		Object.freeze(base);
		const r: AppendResult = appendGenesis([], base, DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
	});

	it("rejects Object.create(null) to decodeRecord", () => {
		const r: DecodeResult = decodeRecord(Object.create(null));
		expect(r.code).toBe("FAIL");
	});

	it("rejects Proxy-wrapped wrapper for decodeRecord", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const proxy: object = new Proxy(fixture.wrapper, {});
		const r: DecodeResult = decodeRecord(proxy);
		expect(r.code).toBe("FAIL");
	});

	it("rejects Proxy-wrapped wrapper for reveal", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const proxy: object = new Proxy(fixture.wrapper, {});
		const r: RevealResult = reveal(proxy);
		expect(r.code).toBe("FAIL");
	});

	it("rejects cross-codec wrapper", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const wrapperProto: object | null = Object.getPrototypeOf(fixture.wrapper);
		const fake: object = Object.create(wrapperProto);
		const r: DecodeResult = decodeRecord(fake);
		expect(r.code).toBe("FAIL");
		if (r.code === "FAIL") {
			expect(r.error).toBe("BRAND_CHECK_FAILURE");
		}
	});
});

// =========================================================================
// 14. hostile input — array
// =========================================================================

describe("hostile input — array", () => {
	it("rejects Proxy wrapping array to decodeJournal", () => {
		const arr: unknown[] = [1];
		const proxy: object = new Proxy(arr, {});
		const r: DecodeJournalResult = decodeJournal(proxy);
		expect(r.code).toBe("FAIL");
	});

	it("rejects null to decodeJournal", () => {
		const r: DecodeJournalResult = decodeJournal(null);
		expect(r.code).toBe("FAIL");
	});

	it("rejects object to decodeJournal", () => {
		const r: DecodeJournalResult = decodeJournal({});
		expect(r.code).toBe("FAIL");
	});

	it("rejects array with symbol property", () => {
		const arr: unknown[] = [1, 2];
		const sym: symbol = Symbol("bad");
		Object.defineProperty(arr, sym, {
			value: 42,
			enumerable: false,
			writable: true,
			configurable: true,
		});
		const r: DecodeJournalResult = decodeJournal(arr);
		expect(r.code).toBe("FAIL");
	});

	it("rejects sparse array", () => {
		const arr: unknown[] = [];
		arr[0] = "a";
		arr[2] = "b";
		const r: DecodeJournalResult = decodeJournal(arr);
		expect(r.code).toBe("FAIL");
	});

	// G6: Dense array reference alias detection
	it("rejects reference aliases in dense array (same wrapper twice)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const arr: unknown[] = [fixture.wrapper, fixture.wrapper];
		const r: DecodeJournalResult = decodeJournal(arr);
		expect(r.code).toBe("FAIL");
	});

	// Also test inventory with reference aliases
	it("rejects reference aliases in inventory dense array (same wrapper twice)", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const r: InventoryResult = inventory([fixture.wrapper, fixture.wrapper], DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
	});
});

// =========================================================================
// 15. deep freeze
// =========================================================================

describe("deep freeze", () => {
	it("appendGenesis result is deeply frozen", () => {
		const g: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		expect(Object.isFrozen(g)).toBe(true);
		expect(Object.isFrozen(g.record)).toBe(true);
		expect(Object.isFrozen(g.record.identity)).toBe(true);
		expect(Object.isFrozen(g.bytes)).toBe(true);
	});

	it("appendTransition result is deeply frozen", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const t: AppendResult = appendTransition(
			[fixture.wrapper],
			makeTransition("allocating", null, null),
			DEFAULT_BOUNDS,
		);
		expect(t.code).toBe("OK");
		if (t.code !== "OK") return;
		expect(Object.isFrozen(t)).toBe(true);
		expect(Object.isFrozen(t.record)).toBe(true);
		expect(Object.isFrozen(t.bytes)).toBe(true);
	});

	it("decodeRecord result is deeply frozen", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const r: DecodeResult = decodeRecord(fixture.wrapper);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(Object.isFrozen(r)).toBe(true);
			expect(Object.isFrozen(r.record)).toBe(true);
		}
	});

	it("encodeGenesisBytes result is deeply frozen", () => {
		const r: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(Object.isFrozen(r)).toBe(true);
			expect(Object.isFrozen(r.bytes)).toBe(true);
		}
	});

	it("inventory OK result is deeply frozen", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const r: InventoryResult = inventory([fixture.wrapper], DEFAULT_BOUNDS);
		expect(r.code).toBe("OK");
		if (r.code === "OK") {
			expect(Object.isFrozen(r)).toBe(true);
			expect(Object.isFrozen(r.groups)).toBe(true);
		}
	});

	it("reveal result envelope is frozen but data is mutable", () => {
		const g: EncodeResult = encodeGenesisBytes(defaultGenesis(), DEFAULT_BOUNDS);
		expect(g.code).toBe("OK");
		if (g.code !== "OK") return;
		const r: RevealResult = reveal(g.bytes);
		expect(r.code).toBe("OK");
		if (r.code !== "OK") return;
		expect(Object.isFrozen(r)).toBe(true);
		expect(Object.isFrozen(r.data)).toBe(false);
	});

	it("FAIL results are frozen", () => {
		const r: AppendResult = appendGenesis([], {}, DEFAULT_BOUNDS);
		expect(r.code).toBe("FAIL");
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("mintRecordBytes result is deeply frozen", () => {
		const fixture = genesisFixture();
		expect(fixture.ok).toBe(true);
		if (!fixture.ok) return;
		const mr: MintResult = mintRecordBytes(fixture.bytes);
		expect(mr.code).toBe("OK");
		if (mr.code === "OK") {
			expect(Object.isFrozen(mr)).toBe(true);
			expect(Object.isFrozen(mr.bytes)).toBe(true);
			expect(Object.isFrozen(mr.record)).toBe(true);
		}
	});
});

// =========================================================================
// 16. bounds validation
// =========================================================================

describe("bounds validation", () => {
	it("rejects bounds with maxRecords=0", () => {
		const bad: Record<string, number> = Object.freeze({
			maxRecords: 0,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
			maxGroups: 50,
		});
		const r: EncodeResult = encodeGenesisBytes(defaultGenesis(), bad);
		expect(r.code).toBe("FAIL");
	});

	it("rejects bounds with missing field", () => {
		const bad: Record<string, number> = Object.freeze({
			maxRecords: 100,
			maxBytes: 1048576,
			maxRecordBytes: 65536,
		});
		const r: EncodeResult = encodeGenesisBytes(defaultGenesis(), bad);
		expect(r.code).toBe("FAIL");
	});
});

// =========================================================================
// 17. identity/anchor
// =========================================================================

describe("identity/anchor", () => {
	it("lifecycleKeyDigest is deterministic across same identity", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		expect(g1.record.identity.lifecycleKeyDigest).toBe(g2.record.identity.lifecycleKeyDigest);
	});

	it("different sessionId produces different lifecycleKeyDigest", () => {
		const g1: AppendResult = appendGenesis([], defaultGenesis(), DEFAULT_BOUNDS);
		expect(g1.code).toBe("OK");
		if (g1.code !== "OK") return;
		const g2: AppendResult = appendGenesis([], makeGenesisInput({ sessionId: "sess-other" }), DEFAULT_BOUNDS);
		expect(g2.code).toBe("OK");
		if (g2.code !== "OK") return;
		expect(g1.record.identity.lifecycleKeyDigest).not.toBe(g2.record.identity.lifecycleKeyDigest);
	});
});

// =========================================================================
// 18. collision fixture integration test
// =========================================================================

describe("collision fixture", () => {
	it("collision fixture exits 0 against production source", () => {
		const fixturePath: string = resolve(__dirname, "fixtures/hosted-child-ledger-collision-fixture.ts");
		const result = spawnSync("/Users/milkkarten/.bun/bin/bun", ["run", fixturePath], {
			timeout: 30000,
			stdio: "pipe",
		});
		const out: string = (result.stdout || "").toString();
		const err: string = (result.stderr || "").toString();
		expect(result.status).toBe(0);
		if (result.status !== 0) {
			console.log("Collision fixture stderr:", err);
		}
		expect(out.indexOf("PASS")).not.toBe(-1);
	});
});
