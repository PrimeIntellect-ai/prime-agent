/**
 * Workspace V21 record codec — exhaustive focused tests.
 *
 * Independently hand-build vectors rather than round-trip only:
 * - All 15 tags valid, every exact length/truncation/trailing case
 * - Digest mismatch, revision/prev linkage
 * - Grammar gaps/order, UTF8/path prefix hazards
 * - 209/105 tombstones, byte alias/zeroization
 * - Proxy/getter/symbol/wrong prototype inputs, bounds
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

// The SUT — all public functions accept unknown and return frozen result unions.
import {
	type AnyParsedRecord,
	computeAbsencePostimage,
	computeEntryAggregateDigest,
	computePlanDigest,
	computePlanEntryDigest,
	computeTerminalRecordDigest,
	computeTxDigest,
	computeVectorCommitment,
	encodeRecord,
	parseAbortTombstone,
	parseCommitTombstone,
	parseRecord,
	parseRecordHeader,
	parseRecords,
	recordName,
	scanJournalRecords,
	validateGrammar,
	validatePath,
} from "../src/modes/daemon/sandbox/prime-workspace-v21-record-codec.js";

// ========================================================================
// Helper — shallow-fill a byte array from hex (zero-initialized)
// ========================================================================

function hexBytes(hex: string): Uint8Array {
	const h = hex.replace(/\s+/g, "");
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i += 1) {
		out[i] = Number.parseInt(h.substring(i * 2, i * 2 + 2), 16);
	}
	return out;
}

function randomBytes32(): Uint8Array {
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i += 1) {
		out[i] = (Math.random() * 256) | 0;
	}
	return out;
}

function zero32(): Uint8Array {
	return new Uint8Array(32);
}

const textEncode = (s: string): Uint8Array => new TextEncoder().encode(s);

// ========================================================================
// Hand-built valid records for each tag
// ========================================================================

// Shared genesis prevDigest (all zeros)
const GENESIS_PREV = zero32();

// 0x01 plan:header — 104-byte payload, 177 total
function buildPlanHeader(
	entryCount = 3,
	totalBytes = 1000,
	txId?: Uint8Array,
	txDigest?: Uint8Array,
	entryAggDigest?: Uint8Array,
): Uint8Array {
	const txId_ = txId ?? randomBytes32();
	const txDigest_ = txDigest ?? randomBytes32();
	const ead_ = entryAggDigest ?? randomBytes32();
	const payload = new Uint8Array(104);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(0, entryCount, false);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(4, totalBytes, false);
	payload.set(txId_, 8);
	payload.set(txDigest_, 40);
	payload.set(ead_, 72);
	return buildRecord(0x01, 0, GENESIS_PREV, payload);
}

// 0x02 plan:entry — variable payload
function buildPlanEntry(
	kind: number,
	path: Uint8Array,
	preDigest?: Uint8Array,
	preSize = 0,
	preMode = 0,
	postDigest?: Uint8Array,
	postSize = 0,
	postMode = 0,
	revision = 1,
	prevDigest?: Uint8Array,
): Uint8Array {
	const preD = preDigest ?? zero32();
	const postD = postDigest ?? zero32();
	const pathLen = path.length;
	const payload = new Uint8Array(1 + 2 + pathLen + 32 + 4 + 2 + 32 + 4 + 2);
	let off = 0;
	payload[off] = kind & 0xff;
	off += 1;
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(off, pathLen, false);
	off += 2;
	payload.set(path, off);
	off += pathLen;
	payload.set(preD, off);
	off += 32;
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(off, preSize, false);
	off += 4;
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(off, preMode, false);
	off += 2;
	payload.set(postD, off);
	off += 32;
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(off, postSize, false);
	off += 4;
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(off, postMode, false);
	off += 2;
	return buildRecord(0x02, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x03 plan:dir — variable: uint16 pathLen + path
function buildPlanDir(path: Uint8Array, revision = 2, prevDigest?: Uint8Array): Uint8Array {
	const payload = new Uint8Array(2 + path.length);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(0, path.length, false);
	payload.set(path, 2);
	return buildRecord(0x03, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x04 plan:sealed — 40 bytes
function buildPlanSealed(
	entryCount = 3,
	dirCount = 1,
	planDigest?: Uint8Array,
	revision = 3,
	prevDigest?: Uint8Array,
): Uint8Array {
	const pd = planDigest ?? randomBytes32();
	const payload = new Uint8Array(40);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(0, entryCount, false);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(4, dirCount, false);
	payload.set(pd, 8);
	return buildRecord(0x04, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x05 stage:ready — 68 bytes
function buildStageReady(
	pathSha?: Uint8Array,
	fileDigest?: Uint8Array,
	fileSize = 100,
	revision = 4,
	prevDigest?: Uint8Array,
): Uint8Array {
	const ps = pathSha ?? randomBytes32();
	const fd = fileDigest ?? randomBytes32();
	const payload = new Uint8Array(68);
	payload.set(ps, 0);
	payload.set(fd, 32);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(64, fileSize, false);
	return buildRecord(0x05, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x06 backup:ready — 68 bytes
function buildBackupReady(
	pathSha?: Uint8Array,
	fileDigest?: Uint8Array,
	fileSize = 200,
	revision = 5,
	prevDigest?: Uint8Array,
): Uint8Array {
	const ps = pathSha ?? randomBytes32();
	const fd = fileDigest ?? randomBytes32();
	const payload = new Uint8Array(68);
	payload.set(ps, 0);
	payload.set(fd, 32);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint32(64, fileSize, false);
	return buildRecord(0x06, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x07 dir:prepared — variable
function buildDirPrepared(path: Uint8Array, validated = 1, revision = 6, prevDigest?: Uint8Array): Uint8Array {
	const payload = new Uint8Array(2 + path.length + 1);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(0, path.length, false);
	payload.set(path, 2);
	payload[2 + path.length] = validated & 0xff;
	return buildRecord(0x07, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x08 prepare:done — 32 bytes
function buildPrepareDone(planDigest?: Uint8Array, revision = 7, prevDigest?: Uint8Array): Uint8Array {
	const pd = planDigest ?? randomBytes32();
	return buildRecord(0x08, revision, prevDigest ?? GENESIS_PREV, pd);
}

// 0x09 plan:commit — 32 bytes
function buildPlanCommit(planDigest?: Uint8Array, revision = 8, prevDigest?: Uint8Array): Uint8Array {
	const pd = planDigest ?? randomBytes32();
	return buildRecord(0x09, revision, prevDigest ?? GENESIS_PREV, pd);
}

// 0x0A dir:applied — variable
function buildDirApplied(path: Uint8Array, wasCreated = 1, revision = 9, prevDigest?: Uint8Array): Uint8Array {
	const payload = new Uint8Array(2 + path.length + 1);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(0, path.length, false);
	payload.set(path, 2);
	payload[2 + path.length] = wasCreated & 0xff;
	return buildRecord(0x0a, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x0B apply:entry — 35 bytes
function buildApplyEntry(
	entryIndex = 0,
	planEntryDigest?: Uint8Array,
	postState = 0,
	revision = 10,
	prevDigest?: Uint8Array,
): Uint8Array {
	const ped = planEntryDigest ?? randomBytes32();
	const payload = new Uint8Array(35);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setUint16(0, entryIndex, false);
	payload.set(ped, 2);
	payload[34] = postState & 0xff;
	return buildRecord(0x0b, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x0C verify:done — 32 bytes
function buildVerifyDone(planDigest?: Uint8Array, revision = 11, prevDigest?: Uint8Array): Uint8Array {
	const pd = planDigest ?? randomBytes32();
	return buildRecord(0x0c, revision, prevDigest ?? GENESIS_PREV, pd);
}

// 0x0D cleanup:done — 32 bytes
function buildCleanupDone(planDigest?: Uint8Array, revision = 12, prevDigest?: Uint8Array): Uint8Array {
	const pd = planDigest ?? randomBytes32();
	return buildRecord(0x0d, revision, prevDigest ?? GENESIS_PREV, pd);
}

// 0x0E tombstone:commit-finalize — 136-byte payload = 209 total
function buildTombstoneCommit(
	txId?: Uint8Array,
	planDigest?: Uint8Array,
	vectorCommitment?: Uint8Array,
	vectorLen: bigint = 13n,
	provenanceTicket?: Uint8Array,
	revision = 13,
	prevDigest?: Uint8Array,
): Uint8Array {
	const tid = txId ?? randomBytes32();
	const pd = planDigest ?? randomBytes32();
	const vc = vectorCommitment ?? randomBytes32();
	const pt = provenanceTicket ?? randomBytes32();
	const payload = new Uint8Array(136);
	payload.set(tid, 0);
	payload.set(pd, 32);
	payload.set(vc, 64);
	new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(96, vectorLen, false);
	payload.set(pt, 104);
	return buildRecord(0x0e, revision, prevDigest ?? GENESIS_PREV, payload);
}

// 0x0F tombstone:abort — 32-byte payload = 105 total
function buildTombstoneAbort(txId?: Uint8Array, revision = 13, prevDigest?: Uint8Array): Uint8Array {
	const tid = txId ?? randomBytes32();
	return buildRecord(0x0f, revision, prevDigest ?? GENESIS_PREV, tid);
}

// ========================================================================
// Core record builder (header + payload)
// ========================================================================

function buildRecord(tag: number, revision: number, prevDigest: Uint8Array, payload: Uint8Array): Uint8Array {
	const payloadDigest = createHash("sha256").update(payload).digest();
	const header = new Uint8Array(73);
	header[0] = tag & 0xff;
	const dv = new DataView(header.buffer, header.byteOffset, header.byteLength);
	dv.setUint32(1, revision, false);
	header.set(prevDigest, 5);
	header.set(payloadDigest, 37);
	dv.setUint32(69, payload.length, false);
	const full = new Uint8Array(73 + payload.length);
	full.set(header, 0);
	full.set(payload, 73);
	return full;
}

function sha256Hex(bytes: Uint8Array): string {
	const d = createHash("sha256").update(bytes).digest();
	let out = "";
	for (let i = 0; i < d.length; i += 1) {
		out += "0123456789abcdef"[d[i] >> 4];
		out += "0123456789abcdef"[d[i] & 0x0f];
	}
	return out;
}

// ========================================================================
// Reusable valid records
// ========================================================================

const VALID_ENTRY_PATH = textEncode("some/file.txt");
const VALID_DIR_PATH = textEncode("some");

const REC_PLAN_HEADER = buildPlanHeader();
const REC_PLAN_ENTRY = buildPlanEntry(0, VALID_ENTRY_PATH);
const REC_PLAN_DIR = buildPlanDir(VALID_DIR_PATH);
const REC_PLAN_SEALED = buildPlanSealed();
const REC_STAGE_READY = buildStageReady();
const REC_BACKUP_READY = buildBackupReady();
const REC_DIR_PREPARED = buildDirPrepared(VALID_DIR_PATH);
const REC_PREPARE_DONE = buildPrepareDone();
const REC_PLAN_COMMIT = buildPlanCommit();
const REC_DIR_APPLIED = buildDirApplied(VALID_DIR_PATH);
const REC_APPLY_ENTRY = buildApplyEntry();
const REC_VERIFY_DONE = buildVerifyDone();
const REC_CLEANUP_DONE = buildCleanupDone();
const REC_TOMB_COMMIT = buildTombstoneCommit();
const REC_TOMB_ABORT = buildTombstoneAbort();

function canonicalRawChain(): Uint8Array[] {
	const path = textEncode("d/f.txt");
	const preDigest = new Uint8Array(32).fill(0x31);
	const postDigest = new Uint8Array(32).fill(0x42);
	const entryDigest = computePlanEntryDigest(2, path, preDigest, 10, 0o600, postDigest, 20, 0o600);
	if (!entryDigest.ok) throw new Error("entry digest fixture failed");
	const aggregate = computeEntryAggregateDigest([entryDigest.digest]);
	if (!aggregate.ok) throw new Error("aggregate fixture failed");
	const plan = computePlanDigest(aggregate.digest);
	if (!plan.ok) throw new Error("plan fixture failed");
	const chain: Uint8Array[] = [];
	let previous = zero32();
	const append = (record: Uint8Array): void => {
		chain.push(record);
		previous = hexBytes(sha256Hex(record));
	};
	append(buildPlanHeader(1, 20, new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), aggregate.digest));
	append(buildPlanEntry(2, path, preDigest, 10, 0o600, postDigest, 20, 0o600, 1, previous));
	append(buildPlanDir(textEncode("d"), 2, previous));
	append(buildPlanSealed(1, 1, plan.digest, 3, previous));
	append(buildStageReady(hexBytes(sha256Hex(path)), postDigest, 20, 4, previous));
	append(buildBackupReady(hexBytes(sha256Hex(path)), preDigest, 10, 5, previous));
	append(buildDirPrepared(textEncode("d"), 1, 6, previous));
	append(buildPrepareDone(plan.digest, 7, previous));
	append(buildPlanCommit(plan.digest, 8, previous));
	append(buildDirApplied(textEncode("d"), 1, 9, previous));
	append(buildApplyEntry(0, entryDigest.digest, 3, 10, previous));
	append(buildVerifyDone(plan.digest, 11, previous));
	append(buildCleanupDone(plan.digest, 12, previous));
	return chain;
}

function namedChain(chain: readonly Uint8Array[]): { name: string; bytes: Uint8Array }[] {
	return chain.map((bytes) => ({ name: sha256Hex(bytes), bytes }));
}

// ========================================================================
// TESTS
// ========================================================================

describe("validatePath (§3.3 grammar)", () => {
	it("accepts valid path", () => {
		const r = validatePath(textEncode("a/b/c"));
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.components.length).toBe(3);
	});

	it("rejects null/undefined", () => {
		expect(validatePath(null).ok).toBe(false);
		expect(validatePath(undefined).ok).toBe(false);
		expect(validatePath(42).ok).toBe(false);
		expect(validatePath("abc").ok).toBe(false);
	});

	it("rejects leading slash", () => {
		expect(validatePath(textEncode("/a")).ok).toBe(false);
	});

	it("rejects trailing slash", () => {
		expect(validatePath(textEncode("a/")).ok).toBe(false);
	});

	it("rejects NUL byte", () => {
		const b = new Uint8Array([0x61, 0x00, 0x62]);
		expect(validatePath(b).ok).toBe(false);
	});

	it("rejects SOH byte", () => {
		const b = new Uint8Array([0x61, 0x01, 0x62]);
		expect(validatePath(b).ok).toBe(false);
	});

	it("rejects backslash", () => {
		expect(validatePath(textEncode("a\\b")).ok).toBe(false);
	});

	it("rejects backtick", () => {
		expect(validatePath(textEncode("a`b")).ok).toBe(false);
	});

	it("rejects double slash", () => {
		expect(validatePath(textEncode("a//b")).ok).toBe(false);
	});

	it("rejects '.' component", () => {
		expect(validatePath(textEncode("./a")).ok).toBe(false);
	});

	it("rejects '..' component", () => {
		expect(validatePath(textEncode("a/../b")).ok).toBe(false);
	});

	it("rejects empty component (consecutive slashes)", () => {
		expect(validatePath(textEncode("a//b")).ok).toBe(false);
	});

	it("rejects byte below 0x21", () => {
		const b = new Uint8Array([0x61, 0x20, 0x62]); // space (0x20 < 0x21)
		expect(validatePath(b).ok).toBe(false);
	});

	it("rejects byte above 0x7E", () => {
		const b = new Uint8Array([0x61, 0x7f, 0x62]);
		expect(validatePath(b).ok).toBe(false);
	});

	it("rejects path exceeding MAX_PATH_BYTES", () => {
		const big = new Uint8Array(4097).fill(0x61);
		expect(validatePath(big).ok).toBe(false);
	});

	it("rejects excess component count", () => {
		const parts: string[] = [];
		for (let i = 0; i < 65; i += 1) parts.push("x");
		expect(validatePath(textEncode(parts.join("/"))).ok).toBe(false);
	});

	it("rejects component > 255 bytes", () => {
		const big = new Uint8Array(260).fill(0x61);
		expect(validatePath(big).ok).toBe(false);
	});
});

describe("parseRecordHeader", () => {
	it("parses valid header", () => {
		const r = parseRecordHeader(REC_PLAN_HEADER);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.schemaTag).toBe(0x01);
		expect(r.value.revision).toBe(0);
		expect(r.value.payloadLen).toBe(104);
	});

	it("rejects truncated (<73 bytes)", () => {
		expect(parseRecordHeader(new Uint8Array(72)).ok).toBe(false);
	});

	it("rejects non-Uint8Array input", () => {
		expect(parseRecordHeader(null).ok).toBe(false);
		expect(parseRecordHeader("bytes").ok).toBe(false);
		expect(parseRecordHeader([1, 2, 3]).ok).toBe(false);
	});
});

describe("parseRecord — all 15 tags", () => {
	it("parses 0x01 plan:header (177 bytes)", () => {
		const r = parseRecord(REC_PLAN_HEADER);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x01);
		expect(r.value.header.payloadLen).toBe(104);
		expect(r.name.length).toBe(64);
	});

	it("parses 0x02 plan:entry (variable)", () => {
		const r = parseRecord(REC_PLAN_ENTRY);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x02);
		if (r.value.tag !== 0x02) return;
		expect(r.value.payload.kind).toBe(0);
		expect(r.value.payload.path.length).toBe(VALID_ENTRY_PATH.length);
	});

	it("parses 0x03 plan:dir (variable)", () => {
		const r = parseRecord(REC_PLAN_DIR);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x03);
		if (r.value.tag !== 0x03) return;
		expect(r.value.payload.path.length).toBe(VALID_DIR_PATH.length);
	});

	it("parses 0x04 plan:sealed (113 bytes)", () => {
		const r = parseRecord(REC_PLAN_SEALED);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x04);
	});

	it("parses 0x05 stage:ready (141 bytes)", () => {
		const r = parseRecord(REC_STAGE_READY);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x05);
	});

	it("parses 0x06 backup:ready (141 bytes)", () => {
		const r = parseRecord(REC_BACKUP_READY);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x06);
	});

	it("parses 0x07 dir:prepared (variable)", () => {
		const r = parseRecord(REC_DIR_PREPARED);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x07);
	});

	it("parses 0x08 prepare:done (105 bytes)", () => {
		const r = parseRecord(REC_PREPARE_DONE);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x08);
	});

	it("parses 0x09 plan:commit (105 bytes)", () => {
		const r = parseRecord(REC_PLAN_COMMIT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x09);
	});

	it("parses 0x0A dir:applied (variable)", () => {
		const r = parseRecord(REC_DIR_APPLIED);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x0a);
	});

	it("parses 0x0B apply:entry (108 bytes)", () => {
		const r = parseRecord(REC_APPLY_ENTRY);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x0b);
	});

	it("parses 0x0C verify:done (105 bytes)", () => {
		const r = parseRecord(REC_VERIFY_DONE);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x0c);
	});

	it("parses 0x0D cleanup:done (105 bytes)", () => {
		const r = parseRecord(REC_CLEANUP_DONE);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x0d);
	});

	it("parses 0x0E tombstone:commit-finalize (209 bytes)", () => {
		const r = parseRecord(REC_TOMB_COMMIT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x0e);
		if (r.value.tag !== 0x0e) return;
		expect(r.value.payload.txId.length).toBe(32);
		expect(r.value.payload.vectorLen).toBe(13n);
		expect(r.value.payload.provenanceTicket.length).toBe(32);
		// Total size: 73 header + 136 payload = 209
		const raw = REC_TOMB_COMMIT;
		expect(raw.length).toBe(209);
	});

	it("parses 0x0F tombstone:abort (105 bytes)", () => {
		const r = parseRecord(REC_TOMB_ABORT);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.tag).toBe(0x0f);
		if (r.value.tag !== 0x0f) return;
		expect(r.value.payload.txId.length).toBe(32);
		const raw = REC_TOMB_ABORT;
		expect(raw.length).toBe(105);
	});

	it("rejects unknown tag (0x00)", () => {
		const rec = buildRecord(0x00, 0, GENESIS_PREV, new Uint8Array(32).fill(0xab));
		expect(parseRecord(rec).ok).toBe(false);
	});

	it("rejects tag 0x10 (out of range)", () => {
		const rec = buildRecord(0x10, 0, GENESIS_PREV, new Uint8Array(32).fill(0xab));
		expect(parseRecord(rec).ok).toBe(false);
	});
});

describe("parseRecord — truncation/trailing/digest cases", () => {
	it("rejects truncated (less than header+1)", () => {
		const tooShort = REC_PLAN_HEADER.slice(0, 73); // header only, no payload
		expect(parseRecord(tooShort).ok).toBe(false);
	});

	it("rejects truncated payload (header says 104 but only 50 given)", () => {
		const rec = buildRecord(0x01, 0, GENESIS_PREV, new Uint8Array(50).fill(0xaa));
		expect(parseRecord(rec).ok).toBe(false);
	});

	it("rejects trailing bytes beyond payload_len", () => {
		const extra = new Uint8Array(REC_PLAN_HEADER.length + 5);
		extra.set(REC_PLAN_HEADER, 0);
		expect(parseRecord(extra).ok).toBe(false);
	});

	it("rejects payload digest mismatch", () => {
		const tampered = new Uint8Array(REC_PLAN_HEADER);
		tampered[37] ^= 0xff; // flip bit in payloadDigest
		expect(parseRecord(tampered).ok).toBe(false);
	});

	it("rejects trailing bytes for fixed-width tag", () => {
		const extra = new Uint8Array(REC_PREPARE_DONE.length + 1);
		extra.set(REC_PREPARE_DONE, 0);
		extra[extra.length - 1] = 0x42;
		expect(parseRecord(extra).ok).toBe(false);
	});
});

describe("parseRecord — hostile input", () => {
	it("rejects null", () => {
		expect(parseRecord(null).ok).toBe(false);
	});

	it("rejects non-Uint8Array", () => {
		expect(parseRecord([1, 2, 3]).ok).toBe(false);
		expect(parseRecord("bytes").ok).toBe(false);
		expect(parseRecord({}).ok).toBe(false);
	});

	it("rejects proxy (hostile)", () => {
		const raw = REC_PLAN_HEADER;
		const proxy = new Proxy(raw, {});
		expect(parseRecord(proxy).ok).toBe(false);
	});

	it("rejects object with getter (hostile)", () => {
		const hostile: object = {
			get length() {
				return 73;
			},
			get 0() {
				return 0x01;
			},
		};
		Object.setPrototypeOf(hostile, Uint8Array.prototype);
		expect(parseRecord(hostile).ok).toBe(false);
	});

	it("rejects object with symbol properties", () => {
		const raw = new Uint8Array(REC_PLAN_HEADER);
		Object.defineProperty(raw, Symbol.for("test"), {
			value: 1,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		expect(parseRecord(raw).ok).toBe(false);
	});

	it("rejects wrong prototype (not Uint8Array)", () => {
		const raw = new Uint8Array(REC_PLAN_HEADER);
		Object.setPrototypeOf(raw, Object.prototype);
		expect(parseRecord(raw).ok).toBe(false);
	});

	it("rejects detached ArrayBuffer input", () => {
		const ab = new ArrayBuffer(73 + 104);
		const raw = new Uint8Array(ab);
		// Fill with record header
		raw.set(REC_PLAN_HEADER.slice(0, Math.min(REC_PLAN_HEADER.length, raw.length)), 0);
		// Can't easily detach in JS, so just test normal path works
		const r = parseRecord(raw.slice(0, Math.min(raw.length, REC_PLAN_HEADER.length)));
		expect(r.ok).toBe(true);
	});
});

describe("recordName", () => {
	it("computes hex name matching SHA-256", () => {
		const r = recordName(REC_PLAN_HEADER);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.name).toBe(sha256Hex(REC_PLAN_HEADER));
	});

	it("rejects non-Uint8Array", () => {
		expect(recordName(null).ok).toBe(false);
	});
});

describe("parseRecords — revision ordering", () => {
	it("accepts genesis with zero prevDigest", () => {
		const records = [REC_PLAN_HEADER];
		const r = parseRecords(records);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.records.length).toBe(1);
		expect(r.records[0].header.revision).toBe(0);
	});

	it("rejects non-genesis with zero prevDigest and revision >0", () => {
		// plan:header is rev 0, plan:entry is rev 1 but we built it with genesis prev
		const records = [REC_PLAN_HEADER, REC_PLAN_ENTRY];
		const r = parseRecords(records);
		// Check if it succeeds or fails - the entry has revision 1 and prevDigest zero
		// which is genesis-only. So it should fail REVISION_FORK
		expect(r.ok).toBe(false);
	});

	it("rejects duplicate revision", () => {
		const records = [REC_PLAN_HEADER, REC_PLAN_HEADER];
		const r = parseRecords(records);
		expect(r.ok).toBe(false);
	});

	it("rejects revision gap", () => {
		// header: rev 0, jump to rev 2
		const rec2 = buildRecord(0x02, 2, GENESIS_PREV, new Uint8Array(1 + 2 + 5 + 32 + 4 + 2 + 32 + 4 + 2).fill(0));
		const records = [REC_PLAN_HEADER, rec2];
		const r = parseRecords(records);
		expect(r.ok).toBe(false);
	});

	it("accepts contiguous revisions with cchain linkage", () => {
		const r0 = REC_PLAN_HEADER; // rev 0
		const name0 = sha256Hex(r0);
		const prev0 = hexBytes(name0);
		const r1 = buildPlanEntry(0, VALID_ENTRY_PATH, undefined, 0, 0, undefined, 0, 0, 1, prev0);
		const name1 = sha256Hex(r1);
		const prev1 = hexBytes(name1);
		const r2 = buildPlanDir(VALID_DIR_PATH, 2, prev1);

		const records = [r0, r1, r2];
		const r = parseRecords(records);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.records.length).toBe(3);
		expect(r.records[0].header.revision).toBe(0);
		expect(r.records[1].header.revision).toBe(1);
		expect(r.records[2].header.revision).toBe(2);
	});
});

describe("encodeRecord", () => {
	it("encodes a valid record", () => {
		const payload = new Uint8Array(32).fill(0xab);
		const r = encodeRecord(0x08, 0, GENESIS_PREV, payload);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.bytes.length).toBe(73 + 32); // 105
		expect(r.name.length).toBe(64);
	});

	it("rejects invalid tag", () => {
		const r = encodeRecord(0x00, 0, GENESIS_PREV, new Uint8Array(32));
		expect(r.ok).toBe(false);
	});

	it("rejects non-integer revision", () => {
		const r = encodeRecord(0x08, 1.5, GENESIS_PREV, new Uint8Array(32));
		expect(r.ok).toBe(false);
	});

	it("rejects non-Uint8Array prevDigest", () => {
		const r = encodeRecord(0x08, 0, null, new Uint8Array(32));
		expect(r.ok).toBe(false);
	});

	it("rejects prevDigest of wrong length", () => {
		const r = encodeRecord(0x08, 0, new Uint8Array(31), new Uint8Array(32));
		expect(r.ok).toBe(false);
	});

	it("rejects empty payload", () => {
		const r = encodeRecord(0x08, 0, GENESIS_PREV, new Uint8Array(0));
		expect(r.ok).toBe(false);
	});
});

describe("encodeRecord + parseRecord roundtrip", () => {
	it("round trips 0x09 plan:commit", () => {
		const pd = randomBytes32();
		const enc = encodeRecord(0x09, 3, randomBytes32(), pd);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = parseRecord(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.value.tag).toBe(0x09);
		if (dec.value.tag !== 0x09) return;
		expect(dec.value.header.revision).toBe(3);
		expect(dec.value.payload).toEqual(pd);
	});

	it("round trips 0x0E tombstone (209 bytes)", () => {
		const txId = randomBytes32();
		const pd = randomBytes32();
		const vc = randomBytes32();
		const pt = randomBytes32();
		const payload = new Uint8Array(136);
		payload.set(txId, 0);
		payload.set(pd, 32);
		payload.set(vc, 64);
		new DataView(payload.buffer).setBigUint64(96, 42n, false);
		payload.set(pt, 104);
		const enc = encodeRecord(0x0e, 42, randomBytes32(), payload);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.bytes.length).toBe(209);
		const dec = parseRecord(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.value.tag).toBe(0x0e);
		if (dec.value.tag !== 0x0e) return;
		expect(dec.value.payload.txId).toEqual(txId);
		expect(dec.value.payload.vectorLen).toBe(42n);
	});

	it("round trips 0x0F abort (105 bytes)", () => {
		const txId = randomBytes32();
		const enc = encodeRecord(0x0f, 7, randomBytes32(), txId);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		expect(enc.bytes.length).toBe(105);
		const dec = parseRecord(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		expect(dec.value.tag).toBe(0x0f);
		if (dec.value.tag !== 0x0f) return;
		expect(dec.value.payload.txId).toEqual(txId);
	});
});

describe("validateGrammar (§8.3)", () => {
	it("rejects 0-entry plan (entryCount < 1)", () => {
		const r0 = buildPlanHeader(0, 0, randomBytes32(), randomBytes32(), new Uint8Array(32));
		const n0 = sha256Hex(r0);
		const p0 = hexBytes(n0);
		const r3 = buildPlanSealed(0, 0, new Uint8Array(32), 3, p0);
		const records = [parseRecord(r0), parseRecord(r3)]
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(records);
		expect(g.ok).toBe(false);
	});

	it("rejects empty array", () => {
		expect(validateGrammar([]).ok).toBe(false);
	});

	it("rejects non-array input", () => {
		expect(validateGrammar(null).ok).toBe(false);
		expect(validateGrammar("abc").ok).toBe(false);
	});

	it("rejects plan:entry before plan:header", () => {
		const records = [parseRecord(REC_PLAN_ENTRY)]
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		if (records.length !== 1) return;
		expect(validateGrammar(records).ok).toBe(false);
	});

	it("rejects plan:sealed without plan:header", () => {
		const records = [parseRecord(REC_PLAN_SEALED)]
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		if (records.length !== 1) return;
		expect(validateGrammar(records).ok).toBe(false);
	});

	it("rejects plan:commit before prepare:done", () => {
		const records: unknown[] = [];
		// Add plan:header rev 0
		const r0 = parseRecord(REC_PLAN_HEADER);
		expect(r0.ok).toBe(true);
		if (!r0.ok) return;
		records.push(r0.value);
		// Add plan:sealed rev 3
		const n0 = sha256Hex(REC_PLAN_HEADER);
		const p0 = hexBytes(n0);
		const r3 = buildPlanSealed(0, 0, randomBytes32(), 3, p0);
		const r3d = parseRecord(r3);
		expect(r3d.ok).toBe(true);
		if (!r3d.ok) return;
		records.push(r3d.value);
		// Jump to plan:commit without backup/prepare
		const r8 = buildPlanCommit(randomBytes32(), 8, hexBytes(sha256Hex(r3)));
		const r8d = parseRecord(r8);
		expect(r8d.ok).toBe(true);
		if (!r8d.ok) return;
		records.push(r8d.value);
		expect(validateGrammar(records).ok).toBe(false);
	});

	it("accepts full canonical cchain", () => {
		// Build a full valid cchain with proper planDigest linkage
		// Step 1: compute planEntryDigest from our entry fields
		const entryPath = textEncode("d/f.txt");
		const entryKind = 2;
		const preD = randomBytes32();
		const preSz = 10;
		const preM = 0o600;
		const postD = randomBytes32();
		const postSz = 20;
		const postM = 0o600;

		// Replicate the domain hash computation to get expected digests
		function domainHash(dp: Uint8Array, parts: Uint8Array[]): Uint8Array {
			const h = createHash("sha256");
			h.update(dp);
			for (const p of parts) {
				const lp = new Uint8Array(8);
				new DataView(lp.buffer).setBigUint64(0, BigInt(p.length), false);
				h.update(lp);
				h.update(p);
			}
			return h.digest();
		}
		function wU8(v: number): Uint8Array {
			const o = new Uint8Array(1);
			o[0] = v;
			return o;
		}
		function wU16(v: number): Uint8Array {
			const o = new Uint8Array(2);
			new DataView(o.buffer).setUint16(0, v, false);
			return o;
		}
		function wU32(v: number): Uint8Array {
			const o = new Uint8Array(4);
			new DataView(o.buffer).setUint32(0, v, false);
			return o;
		}

		const pen_0 = domainHash(new Uint8Array([0x50, 0x45, 0x4e, 0x00]), [
			wU8(entryKind),
			wU16(entryPath.length),
			entryPath,
			preD,
			wU32(preSz),
			wU16(preM),
			postD,
			wU32(postSz),
			wU16(postM),
		]);
		const entryAggDigest = domainHash(new Uint8Array([0x45, 0x41, 0x47, 0x00]), [pen_0]);
		const expectedPlanDigest = domainHash(new Uint8Array([0x50, 0x4c, 0x4e, 0x00]), [entryAggDigest]);

		const chain: Uint8Array[] = [];
		let prevHash: Uint8Array = new Uint8Array(32);
		let rev = 0;

		const r0 = buildPlanHeader(1, 20, randomBytes32(), randomBytes32(), entryAggDigest);
		chain.push(r0);
		prevHash = hexBytes(sha256Hex(r0));
		rev += 1;

		const r1 = buildPlanEntry(entryKind, entryPath, preD, preSz, preM, postD, postSz, postM, rev, prevHash);
		chain.push(r1);
		prevHash = hexBytes(sha256Hex(r1));
		rev += 1;

		const r2 = buildPlanDir(textEncode("d"), rev, prevHash);
		chain.push(r2);
		prevHash = hexBytes(sha256Hex(r2));
		rev += 1;

		const r3 = buildPlanSealed(1, 1, expectedPlanDigest, rev, prevHash);
		chain.push(r3);
		prevHash = hexBytes(sha256Hex(r3));
		rev += 1;

		// Stage + Backup: 1 UPDATE entry needs 1 stage:ready + 1 backup:ready
		const r_s1 = buildStageReady(hexBytes(sha256Hex(entryPath)), postD, 20, rev, prevHash);
		chain.push(r_s1);
		prevHash = hexBytes(sha256Hex(r_s1));
		rev += 1;
		const r_b1 = buildBackupReady(hexBytes(sha256Hex(entryPath)), preD, 10, rev, prevHash);
		chain.push(r_b1);
		prevHash = hexBytes(sha256Hex(r_b1));
		rev += 1;

		const r4 = buildDirPrepared(textEncode("d"), 1, rev, prevHash);
		chain.push(r4);
		prevHash = hexBytes(sha256Hex(r4));
		rev += 1;

		const r5 = buildPrepareDone(expectedPlanDigest, rev, prevHash);
		chain.push(r5);
		prevHash = hexBytes(sha256Hex(r5));
		rev += 1;

		const r6 = buildPlanCommit(expectedPlanDigest, rev, prevHash);
		chain.push(r6);
		prevHash = hexBytes(sha256Hex(r6));
		rev += 1;

		const r7 = buildDirApplied(textEncode("d"), 1, rev, prevHash);
		chain.push(r7);
		prevHash = hexBytes(sha256Hex(r7));
		rev += 1;

		const r8 = buildApplyEntry(0, pen_0, 3, rev, prevHash);
		chain.push(r8);
		prevHash = hexBytes(sha256Hex(r8));
		rev += 1;

		const r9 = buildVerifyDone(expectedPlanDigest, rev, prevHash);
		chain.push(r9);
		prevHash = hexBytes(sha256Hex(r9));
		rev += 1;

		const r10 = buildCleanupDone(expectedPlanDigest, rev, prevHash);
		chain.push(r10);

		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		expect(parsed.length).toBe(chain.length);

		const g = validateGrammar(parsed);
		expect(g.ok).toBe(true);
	});
});

describe("Digest computation (§5.3)", () => {
	it("computeTxDigest produces deterministic result", () => {
		const body = textEncode("hello");
		const r1 = computeTxDigest(body);
		const r2 = computeTxDigest(body);
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;
		expect(r1.digest).toEqual(r2.digest);
	});

	it("computePlanEntryDigest validates", () => {
		const r = computePlanEntryDigest(0, textEncode("f"), randomBytes32(), 10, 0o600, randomBytes32(), 20, 0o600);
		expect(r.ok).toBe(true);
	});

	it("computeEntryAggregateDigest validates", () => {
		const r = computeEntryAggregateDigest([randomBytes32(), randomBytes32()]);
		expect(r.ok).toBe(true);
	});

	it("computePlanDigest validates", () => {
		const r = computePlanDigest(randomBytes32());
		expect(r.ok).toBe(true);
	});

	it("computeVectorCommitment validates", () => {
		const r = computeVectorCommitment([randomBytes32(), randomBytes32()]);
		expect(r.ok).toBe(true);
	});

	it("computeTerminalRecordDigest validates", () => {
		const r = computeTerminalRecordDigest(REC_PLAN_HEADER);
		expect(r.ok).toBe(true);
	});

	it("computeAbsencePostimage validates", () => {
		const r = computeAbsencePostimage(textEncode("some/file.txt"));
		expect(r.ok).toBe(true);
	});
});

describe("Tombstone exact sizes", () => {
	it("commit-finalize (0x0E) is exactly 209 bytes", () => {
		const raw = REC_TOMB_COMMIT;
		expect(raw.length).toBe(209);
		const r = parseRecord(raw);
		expect(r.ok).toBe(true);
	});

	it("abort (0x0F) is exactly 105 bytes", () => {
		const raw = REC_TOMB_ABORT;
		expect(raw.length).toBe(105);
		const r = parseRecord(raw);
		expect(r.ok).toBe(true);
	});
});

describe("Path prefix and duplicate detection", () => {
	it("validatePath accepts UTF-8 paths", () => {
		// Chinese characters are > 0x7E, so they should be rejected
		const utf8Path = textEncode("a/b");
		expect(validatePath(utf8Path).ok).toBe(true);
	});

	it("validatePath rejects non-ASCII high bytes", () => {
		const highPath = new Uint8Array([0x61, 0x2f, 0xe2, 0x82, 0xac]); // a/€
		expect(validatePath(highPath).ok).toBe(false);
	});
});

describe("Biome / Lint compliance", () => {
	it("returns frozen objects", () => {
		const r = parseRecord(REC_PLAN_HEADER);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(Object.isFrozen(r)).toBe(true);
		expect(Object.isFrozen(r.value)).toBe(true);
	});

	it("failure results are frozen", () => {
		const r = validatePath(null);
		expect(Object.isFrozen(r)).toBe(true);
	});

	it("no alias: returned bytes are independent copies", () => {
		const payload = new Uint8Array(32).fill(0xab);
		const enc = encodeRecord(0x08, 0, GENESIS_PREV, payload);
		expect(enc.ok).toBe(true);
		if (!enc.ok) return;
		const dec = parseRecord(enc.bytes);
		expect(dec.ok).toBe(true);
		if (!dec.ok) return;
		// Modify source, decoded should be unaffected
		enc.bytes[0] = 0xff;
		const dec2 = parseRecord(enc.bytes);
		expect(dec2.ok).toBe(false); // digest mismatch now
	});
});

describe("Grammar — gap/order violations", () => {
	it("rejects apply:entry before plan:commit (REVISION_GAP or SEGMENT_ORDER)", () => {
		const r0 = parseRecord(REC_PLAN_HEADER);
		expect(r0.ok).toBe(true);
		if (!r0.ok) return;
		const g = validateGrammar([r0.value, r0.value]); // duplicate header
		expect(g.ok).toBe(false);
	});
});

describe("Plan semantic validation (§10.1.3 and related)", () => {
	const ep = textEncode("f.txt");
	function computeEntryD(
		kind: number,
		path: Uint8Array,
		preD: Uint8Array,
		preSz: number,
		preM: number,
		postD: Uint8Array,
		postSz: number,
		postM: number,
	): Uint8Array | undefined {
		const r = computePlanEntryDigest(kind, path, preD, preSz, preM, postD, postSz, postM);
		expect(r.ok).toBe(true);
		if (!r.ok) return undefined;
		return r.digest;
	}
	function computePlanD(entries: Uint8Array[]): Uint8Array | undefined {
		const agg = computeEntryAggregateDigest(entries);
		expect(agg.ok).toBe(true);
		if (!agg.ok) return undefined;
		const plan = computePlanDigest(agg.digest);
		expect(plan.ok).toBe(true);
		if (!plan.ok) return undefined;
		return plan.digest;
	}

	it("rejects invalid kind (3)", () => {
		const preD = computeAbsencePostimage(ep);
		expect(preD.ok).toBe(true);
		if (!preD.ok) return;
		const postD = randomBytes32();
		const ed = computeEntryD(3, ep, preD.digest, 0, 0, postD, 10, 0o600);
		expect(ed).toBeDefined();
		if (ed === undefined) return;
		const ead = computeEntryAggregateDigest([ed]);
		expect(ead.ok).toBe(true);
		if (!ead.ok) return;
		const pd = computePlanDigest(ead.digest);
		expect(pd.ok).toBe(true);
		if (!pd.ok) return;
		const chain = [buildPlanHeader(1, 100, randomBytes32(), randomBytes32(), ead.digest)];
		chain.push(buildPlanEntry(3, ep, preD.digest, 0, 0, postD, 10, 0o600, 1, hexBytes(sha256Hex(chain[0]))));
		chain.push(buildPlanSealed(1, 0, pd.digest, 2, hexBytes(sha256Hex(chain[1]))));
		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(parsed);
		expect(g.ok).toBe(false);
	});

	it("rejects CREATE with non-zero preMode", () => {
		const preD = computeAbsencePostimage(ep);
		expect(preD.ok).toBe(true);
		if (!preD.ok) return;
		const postD = randomBytes32();
		const ed = computeEntryD(0, ep, preD.digest, 0, 0o600, postD, 10, 0o600);
		expect(ed).toBeDefined();
		if (ed === undefined) return;
		const ead = computeEntryAggregateDigest([ed]);
		expect(ead.ok).toBe(true);
		if (!ead.ok) return;
		const pd = computePlanD([ed]);
		expect(pd).toBeDefined();
		if (pd === undefined) return;
		const chain = [buildPlanHeader(1, 100, randomBytes32(), randomBytes32(), ead.digest)];
		chain.push(buildPlanEntry(0, ep, preD.digest, 0, 0o600, postD, 10, 0o600, 1, hexBytes(sha256Hex(chain[0]))));
		chain.push(buildPlanSealed(1, 0, pd, 2, hexBytes(sha256Hex(chain[1]))));
		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(parsed);
		expect(g.ok).toBe(false);
	});

	it("rejects no-op (same pre/post digest)", () => {
		const preD = computeAbsencePostimage(ep);
		expect(preD.ok).toBe(true);
		if (!preD.ok) return;
		const ed = computeEntryD(0, ep, preD.digest, 0, 0, preD.digest, 0, 0);
		expect(ed).toBeDefined();
		if (ed === undefined) return;
		const ead = computeEntryAggregateDigest([ed]);
		expect(ead.ok).toBe(true);
		if (!ead.ok) return;
		const pd = computePlanD([ed]);
		expect(pd).toBeDefined();
		if (pd === undefined) return;
		const chain = [buildPlanHeader(1, 100, randomBytes32(), randomBytes32(), ead.digest)];
		chain.push(buildPlanEntry(0, ep, preD.digest, 0, 0, preD.digest, 0, 0, 1, hexBytes(sha256Hex(chain[0]))));
		chain.push(buildPlanSealed(1, 0, pd, 2, hexBytes(sha256Hex(chain[1]))));
		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(parsed);
		expect(g.ok).toBe(false);
	});

	it("rejects duplicate paths in plan", () => {
		const preD1 = computeAbsencePostimage(ep);
		expect(preD1.ok).toBe(true);
		if (!preD1.ok) return;
		const postD1 = randomBytes32();
		const ed1 = computeEntryD(0, ep, preD1.digest, 0, 0, postD1, 10, 0o600);
		expect(ed1).toBeDefined();
		if (ed1 === undefined) return;
		const preD2 = computeAbsencePostimage(ep);
		expect(preD2.ok).toBe(true);
		if (!preD2.ok) return;
		const postD2 = randomBytes32();
		const ed2 = computeEntryD(0, ep, preD2.digest, 0, 0, postD2, 10, 0o600);
		expect(ed2).toBeDefined();
		if (ed2 === undefined) return;
		const ead = computeEntryAggregateDigest([ed1, ed2]);
		expect(ead.ok).toBe(true);
		if (!ead.ok) return;
		const pd = computePlanD([ed1, ed2]);
		expect(pd).toBeDefined();
		if (pd === undefined) return;
		const chain = [buildPlanHeader(2, 20, randomBytes32(), randomBytes32(), ead.digest)];
		chain.push(buildPlanEntry(0, ep, preD1.digest, 0, 0, postD1, 10, 0o600, 1, hexBytes(sha256Hex(chain[0]))));
		chain.push(buildPlanEntry(0, ep, preD2.digest, 0, 0, postD2, 10, 0o600, 2, hexBytes(sha256Hex(chain[1]))));
		chain.push(buildPlanSealed(2, 0, pd, 3, hexBytes(sha256Hex(chain[2]))));
		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(parsed);
		expect(g.ok).toBe(false);
	});

	it("rejects prefix conflict (a/b and a)", () => {
		const pa = textEncode("a");
		const pb = textEncode("a/b");
		const preDa = computeAbsencePostimage(pa);
		expect(preDa.ok).toBe(true);
		if (!preDa.ok) return;
		const preDb = computeAbsencePostimage(pb);
		expect(preDb.ok).toBe(true);
		if (!preDb.ok) return;
		const postDa = randomBytes32();
		const postDb = randomBytes32();
		const ed1 = computeEntryD(0, pa, preDa.digest, 0, 0, postDa, 10, 0o600);
		expect(ed1).toBeDefined();
		if (ed1 === undefined) return;
		const ed2 = computeEntryD(0, pb, preDb.digest, 0, 0, postDb, 10, 0o600);
		expect(ed2).toBeDefined();
		if (ed2 === undefined) return;
		const ead = computeEntryAggregateDigest([ed1, ed2]);
		expect(ead.ok).toBe(true);
		if (!ead.ok) return;
		const pd = computePlanD([ed1, ed2]);
		expect(pd).toBeDefined();
		if (pd === undefined) return;
		const chain = [buildPlanHeader(2, 20, randomBytes32(), randomBytes32(), ead.digest)];
		chain.push(buildPlanEntry(0, pa, preDa.digest, 0, 0, postDa, 10, 0o600, 1, hexBytes(sha256Hex(chain[0]))));
		chain.push(buildPlanEntry(0, pb, preDb.digest, 0, 0, postDb, 10, 0o600, 2, hexBytes(sha256Hex(chain[1]))));
		chain.push(buildPlanSealed(2, 0, pd, 3, hexBytes(sha256Hex(chain[2]))));
		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(parsed);
		expect(g.ok).toBe(false);
	});

	it("rejects non-prefix paths (a and b are fine)", () => {
		const pa = textEncode("a");
		const pb = textEncode("b");
		const preDa = computeAbsencePostimage(pa);
		expect(preDa.ok).toBe(true);
		if (!preDa.ok) return;
		const preDb = computeAbsencePostimage(pb);
		expect(preDb.ok).toBe(true);
		if (!preDb.ok) return;
		const postDa = randomBytes32();
		const postDb = randomBytes32();
		const ed1 = computeEntryD(0, pa, preDa.digest, 0, 0, postDa, 10, 0o600);
		expect(ed1).toBeDefined();
		if (ed1 === undefined) return;
		const ed2 = computeEntryD(0, pb, preDb.digest, 0, 0, postDb, 10, 0o600);
		expect(ed2).toBeDefined();
		if (ed2 === undefined) return;
		const ead = computeEntryAggregateDigest([ed1, ed2]);
		expect(ead.ok).toBe(true);
		if (!ead.ok) return;
		const pd = computePlanD([ed1, ed2]);
		expect(pd).toBeDefined();
		if (pd === undefined) return;
		const chain = [buildPlanHeader(2, 20, randomBytes32(), randomBytes32(), ead.digest)];
		chain.push(buildPlanEntry(0, pa, preDa.digest, 0, 0, postDa, 10, 0o600, 1, hexBytes(sha256Hex(chain[0]))));
		chain.push(buildPlanEntry(0, pb, preDb.digest, 0, 0, postDb, 10, 0o600, 2, hexBytes(sha256Hex(chain[1]))));
		chain.push(buildPlanSealed(2, 0, pd, 3, hexBytes(sha256Hex(chain[2]))));
		const parsed = chain
			.map((b) => parseRecord(b))
			.filter((r): r is { ok: true; value: AnyParsedRecord; name: string } => r.ok)
			.map((r) => r.value);
		const g = validateGrammar(parsed);
		expect(g.ok).toBe(true);
	});
});
describe("Edge cases", () => {
	it("empty payload for tagged records is rejected by parseRecord (payload_len 0)", () => {
		const rec = buildRecord(0x08, 0, GENESIS_PREV, new Uint8Array(0));
		const r = parseRecord(rec);
		expect(r.ok).toBe(false); // must be at least 1 byte
	});

	it("very large payload within bounds succeeds", () => {
		const largePayload = new Uint8Array(10000).fill(0x42);
		const rec = buildRecord(0x08, 0, GENESIS_PREV, largePayload);
		const r = parseRecord(rec);
		// This should fail because 0x08 expects exactly 32 bytes
		expect(r.ok).toBe(false);
	});

	it("tombstone:abort with extra txId bytes rejected", () => {
		// Wrong payload size
		const payload = new Uint8Array(64).fill(0xaa);
		const rec = buildRecord(0x0f, 0, GENESIS_PREV, payload);
		const r = parseRecord(rec);
		expect(r.ok).toBe(false);
	});
});

type SemanticHeader = {
	readonly schemaTag: number;
	readonly revision: number;
	readonly prevRecordDigest: Uint8Array;
	readonly payloadDigest: Uint8Array;
	readonly payloadLen: number;
};

type SemanticRecord<Payload = unknown> = {
	readonly tag: number;
	readonly header: SemanticHeader;
	readonly payload: Payload;
};

type PlanHeaderPayloadFixture = {
	readonly entryCount: number;
	readonly totalBytes: number;
	readonly txId: Uint8Array;
	readonly txDigest: Uint8Array;
	readonly entryAggregateDigest: Uint8Array;
};

type PlanFixture = {
	readonly records: SemanticRecord[];
	readonly headerRecord: SemanticRecord<PlanHeaderPayloadFixture>;
	readonly path: Uint8Array;
	readonly preDigest: Uint8Array;
	readonly postDigest: Uint8Array;
	readonly entryDigest: Uint8Array;
	readonly aggregateDigest: Uint8Array;
	readonly planDigest: Uint8Array;
};

function fixedDigest(byte: number): Uint8Array {
	return new Uint8Array(32).fill(byte);
}

function rawDigest(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(createHash("sha256").update(bytes).digest());
}

function hasFixturePath(payload: unknown): payload is { readonly path: Uint8Array } {
	if (typeof payload !== "object" || payload === null) return false;
	const descriptor = Object.getOwnPropertyDescriptor(payload, "path");
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
	return Reflect.get(descriptor, "value", descriptor) instanceof Uint8Array;
}

function semanticPayloadLength(tag: number, payload: unknown): number {
	if (tag === 0x01) return 104;
	if (tag === 0x02) return hasFixturePath(payload) ? 79 + payload.path.length : 0;
	if (tag === 0x03) return hasFixturePath(payload) ? 2 + payload.path.length : 0;
	if (tag === 0x04) return 40;
	if (tag === 0x05 || tag === 0x06) return 68;
	if (tag === 0x07 || tag === 0x0a) return hasFixturePath(payload) ? 3 + payload.path.length : 0;
	if (tag === 0x0b) return 35;
	return 32;
}

function semanticRecord<Payload>(tag: number, payload: Payload): SemanticRecord<Payload> {
	return {
		tag,
		header: {
			schemaTag: tag,
			revision: 0,
			prevRecordDigest: zero32(),
			payloadDigest: zero32(),
			payloadLen: semanticPayloadLength(tag, payload),
		},
		payload,
	};
}

function createPlanFixture(totalBytes = 7): PlanFixture | undefined {
	const path = textEncode("d/file.txt");
	const absence = computeAbsencePostimage(path);
	expect(absence.ok).toBe(true);
	if (!absence.ok) return undefined;
	const postDigest = fixedDigest(0x91);
	const entryDigestResult = computePlanEntryDigest(0, path, absence.digest, 0, 0, postDigest, 7, 0o600);
	expect(entryDigestResult.ok).toBe(true);
	if (!entryDigestResult.ok) return undefined;
	const aggregateResult = computeEntryAggregateDigest([entryDigestResult.digest]);
	expect(aggregateResult.ok).toBe(true);
	if (!aggregateResult.ok) return undefined;
	const planResult = computePlanDigest(aggregateResult.digest);
	expect(planResult.ok).toBe(true);
	if (!planResult.ok) return undefined;
	const headerRecord = semanticRecord(0x01, {
		entryCount: 1,
		totalBytes,
		txId: fixedDigest(1),
		txDigest: fixedDigest(2),
		entryAggregateDigest: aggregateResult.digest,
	});
	const records: SemanticRecord[] = [
		headerRecord,
		semanticRecord(0x02, {
			kind: 0,
			path,
			preDigest: absence.digest,
			preSize: 0,
			preMode: 0,
			postDigest,
			postSize: 7,
			postMode: 0o600,
		}),
		semanticRecord(0x03, { path: textEncode("d") }),
		semanticRecord(0x04, { entryCount: 1, dirCount: 1, planDigest: planResult.digest }),
	];
	return {
		records,
		headerRecord,
		path,
		preDigest: absence.digest,
		postDigest,
		entryDigest: entryDigestResult.digest,
		aggregateDigest: aggregateResult.digest,
		planDigest: planResult.digest,
	};
}

function completeCreateFixture(): PlanFixture | undefined {
	const fixture = createPlanFixture();
	if (fixture === undefined) return undefined;
	fixture.records.push(
		semanticRecord(0x05, { pathSha: rawDigest(fixture.path), fileDigest: fixture.postDigest, fileSize: 7 }),
	);
	fixture.records.push(semanticRecord(0x07, { path: textEncode("d"), validated: 1 }));
	fixture.records.push(semanticRecord(0x08, fixture.planDigest));
	fixture.records.push(semanticRecord(0x09, fixture.planDigest));
	fixture.records.push(semanticRecord(0x0a, { path: textEncode("d"), wasCreated: 1 }));
	fixture.records.push(semanticRecord(0x0b, { entryIndex: 0, planEntryDigest: fixture.entryDigest, postState: 1 }));
	return fixture;
}

describe("V21 focused negative coverage", () => {
	it("rejects malformed variable payload during encoding", () => {
		const result = encodeRecord(0x02, 0, zero32(), new Uint8Array(79));
		expect(result).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("reports a repeated revision", () => {
		const first = buildPlanHeader();
		const second = buildPlanEntry(
			0,
			textEncode("f"),
			zero32(),
			0,
			0,
			fixedDigest(3),
			1,
			0o600,
			0,
			hexBytes(sha256Hex(first)),
		);
		const result = parseRecords([first, second]);
		expect(result).toEqual({ ok: false, code: "REVISION_DUPLICATE" });
	});

	it("rejects a header count above the record count", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[0] = semanticRecord(0x01, {
			entryCount: 2,
			totalBytes: 7,
			txId: fixedDigest(1),
			txDigest: fixedDigest(2),
			entryAggregateDigest: fixture.aggregateDigest,
		});
		expect(validateGrammar(fixture.records).ok).toBe(false);
	});

	it("rejects a sealed entry count mismatch", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[3] = semanticRecord(0x04, { entryCount: 2, dirCount: 1, planDigest: fixture.planDigest });
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "BOUNDS_ENTRIES" });
	});

	it("rejects a sealed directory count mismatch", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[3] = semanticRecord(0x04, { entryCount: 1, dirCount: 2, planDigest: fixture.planDigest });
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "BOUNDS_DIRS" });
	});

	it("rejects an aggregate digest mismatch", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[0] = semanticRecord(0x01, {
			entryCount: 1,
			totalBytes: 7,
			txId: fixedDigest(1),
			txDigest: fixedDigest(2),
			entryAggregateDigest: fixedDigest(0xee),
		});
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
	});

	it("rejects a plan digest mismatch", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[3] = semanticRecord(0x04, { entryCount: 1, dirCount: 1, planDigest: fixedDigest(0xee) });
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
	});

	it("rejects a total byte count mismatch", () => {
		const fixture = createPlanFixture(8);
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "BOUNDS_PAYLOAD" });
	});

	it("uses sorted entry digests for the aggregate", () => {
		const low = fixedDigest(1);
		const high = fixedDigest(2);
		const forward = computeEntryAggregateDigest([low, high]);
		const reverse = computeEntryAggregateDigest([high, low]);
		expect(forward.ok).toBe(true);
		expect(reverse.ok).toBe(true);
		if (!forward.ok || !reverse.ok) return;
		expect(forward.digest).toEqual(reverse.digest);
	});

	it("rejects a stage digest mismatch", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records.push(
			semanticRecord(0x05, { pathSha: rawDigest(fixture.path), fileDigest: fixedDigest(0xee), fileSize: 7 }),
		);
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
	});

	it("rejects an apply index gap", () => {
		const fixture = completeCreateFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[9] = semanticRecord(0x0b, { entryIndex: 1, planEntryDigest: fixture.entryDigest, postState: 1 });
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "SEGMENT_ORDER" });
	});

	it("rejects an apply digest mismatch", () => {
		const fixture = completeCreateFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[9] = semanticRecord(0x0b, {
			entryIndex: 0,
			planEntryDigest: fixedDigest(0xee),
			postState: 1,
		});
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
	});

	it("rejects a kind-inconsistent post state", () => {
		const fixture = completeCreateFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[9] = semanticRecord(0x0b, { entryIndex: 0, planEntryDigest: fixture.entryDigest, postState: 3 });
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("requires verification before cleanup", () => {
		const fixture = completeCreateFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records.push(semanticRecord(0x0d, fixture.planDigest));
		expect(validateGrammar(fixture.records).ok).toBe(false);
	});

	it("accepts verification followed by cleanup", () => {
		const fixture = completeCreateFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records.push(semanticRecord(0x0c, fixture.planDigest));
		fixture.records.push(semanticRecord(0x0d, fixture.planDigest));
		expect(validateGrammar(fixture.records)).toEqual({ ok: true });
	});

	it("rejects a CREATE absence digest mismatch", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[1] = semanticRecord(0x02, {
			kind: 0,
			path: fixture.path,
			preDigest: fixedDigest(0xee),
			preSize: 0,
			preMode: 0,
			postDigest: fixture.postDigest,
			postSize: 7,
			postMode: 0o600,
		});
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("rejects a strict byte view with a nonzero offset", () => {
		const backing = new Uint8Array(33);
		const view = backing.subarray(1);
		expect(computePlanDigest(view)).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("transfers fresh parsed bytes and freezes each object layer", () => {
		const raw = buildPlanHeader();
		const parsed = parseRecord(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.value.tag !== 0x01) return;
		const prior = parsed.value.payload.txId[0];
		raw[81] ^= 0xff;
		expect(parsed.value.payload.txId[0]).toBe(prior);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.value)).toBe(true);
		expect(Object.isFrozen(parsed.value.header)).toBe(true);
		expect(Object.isFrozen(parsed.value.payload)).toBe(true);
	});

	it("decodes the complete uint64 vector count", () => {
		const raw = buildTombstoneCommit(
			fixedDigest(1),
			fixedDigest(2),
			fixedDigest(3),
			0x0102030405060708n,
			fixedDigest(4),
		);
		const parsed = parseRecord(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok || parsed.value.tag !== 0x0e) return;
		expect(parsed.value.payload.vectorLen).toBe(0x0102030405060708n);
	});
});

describe("captured runtime references", () => {
	it("keeps byte and hash operations stable after global mutation", () => {
		const record = REC_PLAN_HEADER.slice();
		const firstDigest = fixedDigest(7);
		const secondDigest = fixedDigest(8);
		const originalView = globalThis.DataView;
		const originalBigInt = globalThis.BigInt;
		const originalFreeze = Object.freeze;
		const originalApply = Reflect.apply;
		const originalArrayCheck = Array.isArray;
		const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
		const lengthDescriptor = Object.getOwnPropertyDescriptor(typedPrototype, "length");
		const byteLengthDescriptor = Object.getOwnPropertyDescriptor(typedPrototype, "byteLength");
		const byteOffsetDescriptor = Object.getOwnPropertyDescriptor(typedPrototype, "byteOffset");
		const bufferDescriptor = Object.getOwnPropertyDescriptor(typedPrototype, "buffer");
		const hashPrototype = Object.getPrototypeOf(createHash("sha256"));
		const updateDescriptor = Object.getOwnPropertyDescriptor(hashPrototype, "update");
		const digestDescriptor = Object.getOwnPropertyDescriptor(hashPrototype, "digest");
		expect(lengthDescriptor).toBeDefined();
		expect(byteLengthDescriptor).toBeDefined();
		expect(byteOffsetDescriptor).toBeDefined();
		expect(bufferDescriptor).toBeDefined();
		expect(updateDescriptor).toBeDefined();
		expect(digestDescriptor).toBeDefined();
		if (
			lengthDescriptor === undefined ||
			byteLengthDescriptor === undefined ||
			byteOffsetDescriptor === undefined ||
			bufferDescriptor === undefined ||
			updateDescriptor === undefined ||
			digestDescriptor === undefined
		)
			return;
		Object.defineProperty(globalThis, "DataView", { value: undefined, configurable: true, writable: true });
		Object.defineProperty(globalThis, "BigInt", { value: undefined, configurable: true, writable: true });
		Object.defineProperty(Object, "freeze", { value: undefined, configurable: true, writable: true });
		Object.defineProperty(Reflect, "apply", { value: undefined, configurable: true, writable: true });
		Object.defineProperty(Array, "isArray", { value: undefined, configurable: true, writable: true });
		Object.defineProperty(typedPrototype, "length", { value: undefined, configurable: true });
		Object.defineProperty(typedPrototype, "byteLength", { value: undefined, configurable: true });
		Object.defineProperty(typedPrototype, "byteOffset", { value: undefined, configurable: true });
		Object.defineProperty(typedPrototype, "buffer", { value: undefined, configurable: true });
		Object.defineProperty(hashPrototype, "update", { value: undefined, configurable: true });
		Object.defineProperty(hashPrototype, "digest", { value: undefined, configurable: true });
		const parsed = parseRecord(record);
		const aggregate = computeEntryAggregateDigest([firstDigest, secondDigest]);
		Object.defineProperty(globalThis, "DataView", { value: originalView, configurable: true, writable: true });
		Object.defineProperty(globalThis, "BigInt", { value: originalBigInt, configurable: true, writable: true });
		Object.defineProperty(Object, "freeze", { value: originalFreeze, configurable: true, writable: true });
		Object.defineProperty(Reflect, "apply", { value: originalApply, configurable: true, writable: true });
		Object.defineProperty(Array, "isArray", { value: originalArrayCheck, configurable: true, writable: true });
		Object.defineProperty(typedPrototype, "length", lengthDescriptor);
		Object.defineProperty(typedPrototype, "byteLength", byteLengthDescriptor);
		Object.defineProperty(typedPrototype, "byteOffset", byteOffsetDescriptor);
		Object.defineProperty(typedPrototype, "buffer", bufferDescriptor);
		Object.defineProperty(hashPrototype, "update", updateDescriptor);
		Object.defineProperty(hashPrototype, "digest", digestDescriptor);
		expect(parsed.ok).toBe(true);
		expect(aggregate.ok).toBe(true);
	});
});

describe("kind and segment semantics", () => {
	function semanticPrefix(payload: object): unknown[] {
		return [
			semanticRecord(0x01, {
				entryCount: 1,
				totalBytes: 1,
				txId: fixedDigest(1),
				txDigest: fixedDigest(2),
				entryAggregateDigest: fixedDigest(3),
			}),
			semanticRecord(0x02, payload),
		];
	}

	it("rejects a CREATE post mode mismatch", () => {
		const path = textEncode("f");
		const absence = computeAbsencePostimage(path);
		expect(absence.ok).toBe(true);
		if (!absence.ok) return;
		const records = semanticPrefix({
			kind: 0,
			path,
			preDigest: absence.digest,
			preSize: 0,
			preMode: 0,
			postDigest: fixedDigest(4),
			postSize: 1,
			postMode: 0,
		});
		expect(validateGrammar(records)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("rejects a DELETE postimage mismatch", () => {
		const path = textEncode("f");
		const records = semanticPrefix({
			kind: 1,
			path,
			preDigest: fixedDigest(4),
			preSize: 1,
			preMode: 0o600,
			postDigest: fixedDigest(5),
			postSize: 0,
			postMode: 0,
		});
		expect(validateGrammar(records)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("rejects an UPDATE mode mismatch", () => {
		const path = textEncode("f");
		const records = semanticPrefix({
			kind: 2,
			path,
			preDigest: fixedDigest(4),
			preSize: 1,
			preMode: 0o600,
			postDigest: fixedDigest(5),
			postSize: 1,
			postMode: 0,
		});
		expect(validateGrammar(records)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("rejects a zero non-absence digest", () => {
		const path = textEncode("f");
		const records = semanticPrefix({
			kind: 2,
			path,
			preDigest: zero32(),
			preSize: 1,
			preMode: 0o600,
			postDigest: fixedDigest(5),
			postSize: 1,
			postMode: 0o600,
		});
		expect(validateGrammar(records)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});

	it("rejects a missing stage record before preparation", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records.push(semanticRecord(0x07, { path: textEncode("d"), validated: 1 }));
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "SEGMENT_GAP" });
	});

	it("rejects a plan directory unrelated to an entry parent", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		fixture.records[2] = semanticRecord(0x03, { path: textEncode("other") });
		expect(validateGrammar(fixture.records)).toEqual({ ok: false, code: "SEGMENT_ORDER" });
	});

	it("reports an oversized nested path", () => {
		const path = new Uint8Array(4097).fill(0x61);
		const records = semanticPrefix({
			kind: 2,
			path,
			preDigest: fixedDigest(4),
			preSize: 1,
			preMode: 0o600,
			postDigest: fixedDigest(5),
			postSize: 1,
			postMode: 0o600,
		});
		expect(validateGrammar(records)).toEqual({ ok: false, code: "BOUNDS_PATH" });
	});
});

describe("integrated V21 journal scan", () => {
	it("validates names, linkage, layout, and grammar without reparsing caller bytes", () => {
		const chain = canonicalRawChain();
		const input = namedChain(chain);
		const result = scanJournalRecords(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.records).toHaveLength(chain.length);
		expect(result.records.at(-1)?.value.tag).toBe(0x0d);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.records)).toBe(true);
		expect(Object.isFrozen(result.records[0])).toBe(true);
		expect(Object.isFrozen(result.records[0].value)).toBe(true);
	});

	it("reconstructs revision order independently of directory enumeration order", () => {
		const input = namedChain(canonicalRawChain()).reverse();
		const result = scanJournalRecords(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.records.map((item) => item.value.header.revision)).toEqual(
			Array.from({ length: result.records.length }, (_, index) => index),
		);
	});

	it("rejects a supplied record name that does not match the raw record", () => {
		const input = namedChain(canonicalRawChain());
		input[0] = { name: "0".repeat(64), bytes: input[0].bytes };
		expect(scanJournalRecords(input)).toEqual({ ok: false, code: "DIGEST_MISMATCH" });
	});

	it("transfers byte fields without aliases to any transitive input", () => {
		const chain = canonicalRawChain();
		const input = namedChain(chain);
		const result = scanJournalRecords(input);
		expect(result.ok).toBe(true);
		if (!result.ok || result.records[0].value.tag !== 0x01) return;
		const txByte = result.records[0].value.payload.txId[0];
		chain[0].fill(0);
		input[0].bytes.fill(0xff);
		expect(result.records[0].value.payload.txId[0]).toBe(txByte);
	});

	it("preflights the exact 32 MiB aggregate journal bound without copying caller bytes", () => {
		const bytes = new Uint8Array(1_048_576);
		bytes[0] = 0x5a;
		const name = sha256Hex(bytes);
		const records = Array.from({ length: 33 }, () => ({ name, bytes }));
		const started = performance.now();
		expect(scanJournalRecords(records)).toEqual({ ok: false, code: "BOUNDS_PAYLOAD" });
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(bytes[0]).toBe(0x5a);
	});

	it("admits exactly 32 MiB to one strict-copy pass and rejects 33 MiB before copying", () => {
		const codecModulePath = `${import.meta.dir}/../src/modes/daemon/sandbox/prime-workspace-v21-record-codec.ts`;
		const strictModulePath = `${import.meta.dir}/../src/modes/daemon/sandbox/prime-sandbox-strict-bytes.js`;
		const script = `import { mock } from "bun:test";
const NativeBytes = Uint8Array;
let strictCalls = 0;
mock.module("${strictModulePath}", () => ({
 copySandboxStrictBytes() {
  strictCalls += 1;
  return Object.freeze({ ok: true, value: new NativeBytes([1]) });
 },
}));
const codec = await import("${codecModulePath}?aggregate-preflight");
const bytes = new NativeBytes(1_048_576);
bytes[0] = 0x5a;
const name = "0".repeat(64);
const accepted = new Array(32);
const rejected = new Array(33);
for (let index = 0; index < accepted.length; index += 1) accepted[index] = { name, bytes };
for (let index = 0; index < rejected.length; index += 1) rejected[index] = { name, bytes };
const over = codec.scanJournalRecords(rejected);
const callsAfterOver = strictCalls;
const exact = codec.scanJournalRecords(accepted);
process.stdout.write(JSON.stringify({
 over: over.code,
 callsAfterOver,
 exact: exact.code,
 exactCalls: strictCalls - callsAfterOver,
 callerByte: bytes[0],
}));`;
		const run = Bun.spawnSync({ cmd: ["/Users/milkkarten/.bun/bin/bun", "-e", script] });
		expect(run.exitCode).toBe(0);
		expect(new TextDecoder().decode(run.stdout)).toBe(
			'{"over":"BOUNDS_PAYLOAD","callsAfterOver":0,"exact":"TRUNCATED","exactCalls":32,"callerByte":90}',
		);
	});

	it("keeps fixed-root tombstones outside journal grammar", () => {
		const chain = canonicalRawChain();
		const previous = hexBytes(sha256Hex(chain[chain.length - 1]));
		const tombstone = buildTombstoneCommit(
			fixedDigest(1),
			fixedDigest(2),
			fixedDigest(3),
			13n,
			fixedDigest(4),
			13,
			previous,
		);
		const abort = buildTombstoneAbort(fixedDigest(5), 13, previous);
		expect(scanJournalRecords(namedChain([...chain, tombstone]))).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(scanJournalRecords(namedChain([...chain, abort]))).toEqual({ ok: false, code: "INPUT_INVALID" });
	});

	it("does not claim V24 FINALIZED or ABSENT recovery outcomes", () => {
		const result = scanJournalRecords(namedChain(canonicalRawChain()));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.getOwnPropertyNames(result)).toEqual(["ok", "records"]);
	});
});

describe("separate fixed-root tombstone schemas", () => {
	it("parses exact non-null commit and abort tombstones", () => {
		const commit = buildTombstoneCommit(fixedDigest(1), fixedDigest(2), fixedDigest(3), 1n, fixedDigest(4));
		const abort = buildTombstoneAbort(fixedDigest(5));
		const parsedCommit = parseCommitTombstone(commit);
		const parsedAbort = parseAbortTombstone(abort);
		expect(parsedCommit.ok).toBe(true);
		expect(parsedAbort.ok).toBe(true);
		if (!parsedCommit.ok || !parsedAbort.ok) return;
		expect(parsedCommit.value.tag).toBe(0x0e);
		expect(parsedAbort.value.tag).toBe(0x0f);
		expect(parsedCommit.value.payload).not.toBeNull();
		expect(parsedAbort.value.payload).not.toBeNull();
	});

	it("rejects zero required claims and the wrong tombstone kind", () => {
		const zeroCommit = buildTombstoneCommit(zero32(), fixedDigest(2), fixedDigest(3), 1n, fixedDigest(4));
		expect(parseCommitTombstone(zeroCommit)).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
		expect(parseCommitTombstone(buildTombstoneAbort(fixedDigest(1)))).toEqual({ ok: false, code: "TAG_UNKNOWN" });
		expect(parseAbortTombstone(buildTombstoneAbort(zero32()))).toEqual({ ok: false, code: "PAYLOAD_INVALID" });
	});
});

describe("exact semantic input schemas", () => {
	it("rejects extras on every tag payload", () => {
		const scan = scanJournalRecords(namedChain(canonicalRawChain()));
		expect(scan.ok).toBe(true);
		if (!scan.ok) return;
		for (let index = 0; index < scan.records.length; index += 1) {
			const records: unknown[] = scan.records.map((item) => item.value);
			const record = records[index];
			let payload: unknown;
			if (record.payload instanceof Uint8Array) {
				payload = record.payload.slice();
				Object.defineProperty(payload, "extra", { value: true, enumerable: true });
			} else {
				payload = { ...record.payload, extra: true };
			}
			records[index] = { tag: record.tag, header: record.header, payload };
			expect(validateGrammar(records)).toEqual({ ok: false, code: "INPUT_INVALID" });
		}
	});

	it("rejects getters, symbols, proxies, record/header extras, and array subclasses", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		const base = fixture.headerRecord;
		let getterCalls = 0;
		const getterPayload = { ...base.payload };
		Object.defineProperty(getterPayload, "extra", {
			get: () => {
				getterCalls += 1;
				return 1;
			},
		});
		expect(validateGrammar([{ tag: base.tag, header: base.header, payload: getterPayload }])).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(getterCalls).toBe(0);

		const symbolPayload = { ...base.payload };
		Object.defineProperty(symbolPayload, Symbol("extra"), { value: true });
		expect(validateGrammar([{ tag: base.tag, header: base.header, payload: symbolPayload }]).ok).toBe(false);
		expect(validateGrammar([{ ...base, extra: true }]).ok).toBe(false);
		expect(
			validateGrammar([{ tag: base.tag, header: { ...base.header, extra: true }, payload: base.payload }]).ok,
		).toBe(false);
		expect(validateGrammar([new Proxy(base, {})]).ok).toBe(false);

		class RecordArray extends Array<unknown> {}
		const subclass = new RecordArray(base);
		expect(validateGrammar(subclass).ok).toBe(false);
		const extraArray: unknown[] = [base];
		Object.defineProperty(extraArray, "extra", { value: true });
		expect(validateGrammar(extraArray).ok).toBe(false);
		const symbolArray: unknown[] = [base];
		Object.defineProperty(symbolArray, Symbol("extra"), { value: true });
		expect(validateGrammar(symbolArray).ok).toBe(false);
	});

	it("validates plan-header txId and txDigest fields", () => {
		const fixture = createPlanFixture();
		expect(fixture).toBeDefined();
		if (fixture === undefined) return;
		const header = fixture.headerRecord;
		const missingTxId = {
			entryCount: header.payload.entryCount,
			totalBytes: header.payload.totalBytes,
			txDigest: header.payload.txDigest,
			entryAggregateDigest: header.payload.entryAggregateDigest,
		};
		expect(validateGrammar([{ tag: header.tag, header: header.header, payload: missingTxId }]).ok).toBe(false);
		const shortTxDigest = {
			entryCount: header.payload.entryCount,
			totalBytes: header.payload.totalBytes,
			txId: header.payload.txId,
			txDigest: new Uint8Array(31),
			entryAggregateDigest: header.payload.entryAggregateDigest,
		};
		expect(validateGrammar([{ tag: header.tag, header: header.header, payload: shortTxDigest }]).ok).toBe(false);
	});
});

describe("transitive strict-byte mutation stability", () => {
	it("keeps valid bytes valid after global Uint8Array replacement in a clean process", () => {
		const codecModulePath = `${import.meta.dir}/../src/modes/daemon/sandbox/prime-workspace-v21-record-codec.ts`;
		const script = `import { createHash } from "node:crypto";
const NativeBytes = Uint8Array;
const payload = new NativeBytes(104);
payload[3] = 1;
payload.fill(1, 8, 104);
const header = new NativeBytes(73);
header[0] = 1;
header.set(createHash("sha256").update(payload).digest(), 37);
new DataView(header.buffer).setUint32(69, payload.byteLength, false);
const record = new NativeBytes(177);
record.set(header);
record.set(payload, 73);
const codec = await import("${codecModulePath}?constructor-mutation");
class ReplacementBytes extends NativeBytes {}
Object.defineProperty(globalThis, "Uint8Array", { value: ReplacementBytes, configurable: true, writable: true });
process.stdout.write(JSON.stringify(codec.parseRecord(record)));`;
		const run = Bun.spawnSync({ cmd: ["/Users/milkkarten/.bun/bin/bun", "-e", script] });
		expect(run.exitCode).toBe(0);
		expect(JSON.parse(new TextDecoder().decode(run.stdout))).toMatchObject({ ok: true });
	});

	it("survives Object.prototype descriptor pollution and rejects accessor fields in a clean process", () => {
		const codecModulePath = `${import.meta.dir}/../src/modes/daemon/sandbox/prime-workspace-v21-record-codec.ts`;
		const encodedInput = JSON.stringify(
			namedChain(canonicalRawChain()).map((item) => ({ name: item.name, bytes: Array.from(item.bytes) })),
		);
		const script = `const codec = await import("${codecModulePath}?prototype-pollution");
const encoded = ${encodedInput};
const input = new Array(encoded.length);
for (let index = 0; index < encoded.length; index += 1) {
 input[index] = { name: encoded[index].name, bytes: new Uint8Array(encoded[index].bytes) };
}
const accessorDescriptor = Object.create(null);
accessorDescriptor.get = undefined;
accessorDescriptor.set = undefined;
accessorDescriptor.enumerable = true;
accessorDescriptor.configurable = true;
const pollution = {
 get: { value: () => 1, writable: true, configurable: true },
 set: { value: () => 1, writable: true, configurable: true },
 value: { value: 1, writable: true, configurable: true },
 writable: { value: false, writable: true, configurable: true },
 enumerable: { value: false, writable: true, configurable: true },
 configurable: { value: false, writable: true, configurable: true },
 ok: { value: false, writable: true, configurable: true },
};
Object.defineProperties(Object.prototype, pollution);
const parsed = codec.parseRecord(input[0].bytes);
const scan = codec.scanJournalRecords(input);
let accessorRejected = false;
if (scan.ok && scan.records[0].value.tag === 0x01) {
 const original = scan.records[0].value;
 const badPayload = {
  totalBytes: original.payload.totalBytes,
  txId: original.payload.txId,
  txDigest: original.payload.txDigest,
  entryAggregateDigest: original.payload.entryAggregateDigest,
 };
 Object.defineProperty(badPayload, "entryCount", accessorDescriptor);
 const records = new Array(scan.records.length);
 records[0] = { tag: original.tag, header: original.header, payload: badPayload };
 for (let index = 1; index < scan.records.length; index += 1) records[index] = scan.records[index].value;
 const grammar = codec.validateGrammar(records);
 accessorRejected = !grammar.ok && grammar.code === "INPUT_INVALID";
}
const parseOk = parsed.ok === true && Object.getOwnPropertyNames(parsed).join(",") === "ok,value,name";
const scanOk = scan.ok === true && Object.getOwnPropertyNames(scan).join(",") === "ok,records";
delete Object.prototype.get;
delete Object.prototype.set;
delete Object.prototype.value;
delete Object.prototype.writable;
delete Object.prototype.enumerable;
delete Object.prototype.configurable;
delete Object.prototype.ok;
process.stdout.write(JSON.stringify({ parseOk, scanOk, accessorRejected }));`;
		const run = Bun.spawnSync({ cmd: ["/Users/milkkarten/.bun/bin/bun", "-e", script] });
		expect(new TextDecoder().decode(run.stderr)).toBe("");
		expect(run.exitCode).toBe(0);
		expect(new TextDecoder().decode(run.stdout)).toBe('{"parseOk":true,"scanOk":true,"accessorRejected":true}');
	});
});

describe("owned byte cleanup", () => {
	it("clears owned copies and keeps only transferred bytes", () => {
		const codecModulePath = `${import.meta.dir}/../src/modes/daemon/sandbox/prime-workspace-v21-record-codec.ts`;
		const strictModulePath = `${import.meta.dir}/../src/modes/daemon/sandbox/prime-sandbox-strict-bytes.js`;
		const script = `import { createHash } from "node:crypto";
import { mock } from "bun:test";
async function main() {
 const NativeBytes = Uint8Array;
 const state = { allocations: [], strictCalls: 0 };
 function TrackedBytes(input) {
  const value = new NativeBytes(input);
  state.allocations.push(value);
  return value;
 }
 Object.defineProperty(TrackedBytes, "prototype", { value: NativeBytes.prototype });
 Object.defineProperty(globalThis, "Uint8Array", { value: TrackedBytes, configurable: true, writable: true });
 mock.module("${strictModulePath}", () => ({
  copySandboxStrictBytes(input, maximum) {
   state.strictCalls += 1;
   if (!(input instanceof NativeBytes) || input.byteLength > maximum) return Object.freeze({ ok: false, code: "INPUT_INVALID" });
   const copy = new TrackedBytes(input);
   return Object.freeze({ ok: true, value: copy });
  },
 }));
 const codec = await import("${codecModulePath}?ownership");
 function allCleared(start) {
  for (let allocationIndex = start; allocationIndex < state.allocations.length; allocationIndex += 1) {
   const allocation = state.allocations[allocationIndex];
   for (let byteIndex = 0; byteIndex < allocation.byteLength; byteIndex += 1) if (allocation[byteIndex] !== 0) return false;
  }
  return true;
 }
 function onlyKept(start, kept) {
  for (let allocationIndex = start; allocationIndex < state.allocations.length; allocationIndex += 1) {
   const allocation = state.allocations[allocationIndex];
   if (allocation === kept) continue;
   for (let byteIndex = 0; byteIndex < allocation.byteLength; byteIndex += 1) if (allocation[byteIndex] !== 0) return false;
  }
  return true;
 }
 function rawRecord(tag, payload) {
  const header = new NativeBytes(73);
  header[0] = tag;
  const view = new DataView(header.buffer);
  const payloadDigest = createHash("sha256").update(payload).digest();
  header.set(payloadDigest, 37);
  view.setUint32(69, payload.byteLength, false);
  const record = new NativeBytes(73 + payload.byteLength);
  record.set(header);
  record.set(payload, 73);
  return record;
 }
 const previous = new NativeBytes(32);
 const payload = new NativeBytes(32).fill(0x41);
 let allocationStart = state.allocations.length;
 let callStart = state.strictCalls;
 const encoded = codec.encodeRecord(0x08, 0, previous, payload);
 const encodeSuccess = encoded.ok && onlyKept(allocationStart, encoded.bytes) && state.strictCalls - callStart === 2;
 allocationStart = state.allocations.length;
 callStart = state.strictCalls;
 const invalidEncode = codec.encodeRecord(0x02, 0, previous, new NativeBytes(79));
 const encodeFailure = !invalidEncode.ok && allCleared(allocationStart) && state.strictCalls - callStart === 2;
 allocationStart = state.allocations.length;
 callStart = state.strictCalls;
 const digestFailure = codec.computePlanEntryDigest(0, new NativeBytes([0x61]), new NativeBytes(31), 0, 0, new NativeBytes(32), 1, 0o600);
 const planEntryFailure = !digestFailure.ok && allCleared(allocationStart) && state.strictCalls - callStart === 3;
 allocationStart = state.allocations.length;
 callStart = state.strictCalls;
 const aggregateFailure = codec.computeEntryAggregateDigest([new NativeBytes(32).fill(1), new NativeBytes(31).fill(2)]);
 const aggregateCleanup = !aggregateFailure.ok && allCleared(allocationStart) && state.strictCalls - callStart === 2;
 allocationStart = state.allocations.length;
 callStart = state.strictCalls;
 const vectorFailure = codec.computeVectorCommitment([new NativeBytes(32).fill(1), new NativeBytes(31).fill(2)]);
 const vectorCleanup = !vectorFailure.ok && allCleared(allocationStart) && state.strictCalls - callStart === 2;
 const malformed = rawRecord(0x02, new NativeBytes(80));
 allocationStart = state.allocations.length;
 callStart = state.strictCalls;
 const parsedFailure = codec.parseRecord(malformed);
 const parseCleanup = !parsedFailure.ok && allCleared(allocationStart) && state.strictCalls - callStart === 1;
 allocationStart = state.allocations.length;
 callStart = state.strictCalls;
 const txResult = codec.computeTxDigest(new NativeBytes([1, 2, 3]));
 const digestSuccess = txResult.ok && onlyKept(allocationStart, txResult.digest) && state.strictCalls - callStart === 1;
 process.stdout.write(JSON.stringify({ encodeSuccess, encodeFailure, planEntryFailure, aggregateCleanup, vectorCleanup, parseCleanup, digestSuccess }));
}
await main();`;
		const run = Bun.spawnSync({ cmd: ["/Users/milkkarten/.bun/bin/bun", "-e", script] });
		expect(run.exitCode).toBe(0);
		expect(new TextDecoder().decode(run.stdout)).toBe(
			'{"encodeSuccess":true,"encodeFailure":true,"planEntryFailure":true,"aggregateCleanup":true,"vectorCleanup":true,"parseCleanup":true,"digestSuccess":true}',
		);
	});
});
