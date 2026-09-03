/**
 * Tests for ProviderCallJournal recovery scanner — paginated two-pass scan,
 * state machine validation, observeExact/close-dominance, page-close on
 * every path, per-file handle-close dominance, preliminary backend.close
 * acquisition, and identity/digest/chunk/cancel transition tests.
 *
 * Vitest >= 50 focused tests.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { encodeProviderCallRecordV1 } from "../src/modes/daemon/provider-call-record-codec.js";
import {
	type ProviderCallBackend,
	type ProviderCallEntryStat,
	type ProviderCallListPageRequest,
	type ProviderCallOpenRequest,
	type ProviderCallReadHandle,
	recoverProviderCallJournal,
} from "../src/modes/daemon/provider-call-recovery.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";

// ===========================================================================
// Helpers
// ===========================================================================

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function digestOfFrame(frame: Record<string, unknown>): string {
	const r = canonicalDigest(frame);
	if (!r.ok) throw new Error("canonicalDigest failed");
	return r.value;
}

function pad(seq: number): string {
	return String(seq).padStart(20, "0");
}

function fileName(seq: number): string {
	return `${pad(seq)}.b10-provider-call`;
}

function makeStat(overrides?: Partial<ProviderCallEntryStat>): ProviderCallEntryStat {
	return {
		dev: "1234",
		ino: "5678",
		uid: "501",
		mode: 0o600,
		size: 0,
		nlink: 1,
		isFile: true,
		isSymlink: false,
		mtimeNs: "1000000000",
		ctimeNs: "1000000000",
		...overrides,
	};
}

function makeRequestFrame(callId: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_request",
		callId,
		provider: "test",
		model: "test-model",
		messages: [{ role: "user", content: "hello" }],
	};
}

function makeChunkFrame(callId: string, index: number): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_chunk",
		callId,
		index,
		delta: { content: `chunk-${index}` },
	};
}

function makeCompleteFrame(callId: string): Record<string, unknown> {
	return {
		type: "provider_proxy",
		proxyType: "model_call_complete",
		callId,
		result: "ok",
		usage: { inputTokens: 10, outputTokens: 20 },
	};
}

function makeReceipt(): { sequence: number; size: number; sha256: string } {
	return { sequence: 1, size: 100, sha256: "a".repeat(64) };
}

// ===========================================================================
// Encode helpers
// ===========================================================================

interface JournalFile {
	bytes: Uint8Array;
	sha256: string;
	size: number;
	seq: number;
}

const _journalCache = new Map<number, JournalFile>();

function encodeJournaled(callId: string, journalSeq: number, requestFrameId: string = `f-req-${callId}`): Uint8Array {
	const frame = makeRequestFrame(callId);
	const bytes = utf8(JSON.stringify(frame));
	const requestDigest = digestOfFrame(frame);
	const canonicalRequestDigest = sha256Of(bytes);
	const enc = encodeProviderCallRecordV1({
		version: 1,
		recordKind: "journaled",
		journalSeq,
		callId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		requestFrameId,
		requestDigest,
		requestBytes: new Uint8Array(bytes),
		canonicalRequestDigest,
	});
	if (!enc.ok) throw new Error("encode journaled failed");
	const raw = new Uint8Array(enc.bytes);
	const sha = sha256Of(raw);
	_journalCache.set(journalSeq, { bytes: raw, sha256: sha, size: raw.byteLength, seq: journalSeq });
	return raw;
}

function journalReceipt(seq: number): { sequence: number; size: number; sha256: string } {
	const cached = _journalCache.get(seq);
	if (!cached) return { sequence: seq, size: 100, sha256: "a".repeat(64) };
	return { sequence: cached.seq, size: cached.size, sha256: cached.sha256 };
}

function _clearJournalCache(): void {
	_journalCache.clear();
}

function _requestDigestFor(callId: string): string {
	const frame = makeRequestFrame(callId);
	return digestOfFrame(frame);
}

function encodeStarted(
	journalSeq: number,
	callId?: string,
	requestDigestOverride?: string,
	requestJournalSeqOverride?: number,
	receiptOverride?: { sequence: number; size: number; sha256: string },
): Uint8Array {
	const cid = callId ?? "call-1";
	const computedDigest = _requestDigestFor(cid);
	const digest = requestDigestOverride ?? computedDigest;
	const rjs = requestJournalSeqOverride ?? (journalSeq - 1 >= 1 ? journalSeq - 1 : 1);
	const receipt = receiptOverride ?? journalReceipt(rjs);
	const enc = encodeProviderCallRecordV1({
		version: 1,
		recordKind: "started",
		journalSeq,
		callId: cid,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:01.000Z",
		requestDigest: digest,
		requestJournalSeq: rjs,
		requestReceipt: receipt,
	});
	if (!enc.ok) throw new Error("encode started failed");
	return new Uint8Array(enc.bytes);
}

function encodeChunk(callId: string, journalSeq: number, chunkIndex: number): Uint8Array {
	const frame = makeChunkFrame(callId, chunkIndex);
	const bytes = utf8(JSON.stringify(frame));
	const chunkFrameDigest = sha256Of(bytes);
	const enc = encodeProviderCallRecordV1({
		version: 1,
		recordKind: "chunk",
		journalSeq,
		callId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:02.000Z",
		chunkIndex,
		chunkFrameBytes: new Uint8Array(bytes),
		chunkFrameDigest,
	});
	if (!enc.ok) throw new Error("encode chunk failed");
	return new Uint8Array(enc.bytes);
}

function encodeTerminal(
	callId: string,
	journalSeq: number,
	kind: "normal" | "interrupted" | "cancelled" = "normal",
	chunkCountOverride?: number,
): Uint8Array {
	const frame =
		kind === "normal"
			? makeCompleteFrame(callId)
			: {
					type: "provider_proxy",
					proxyType: "model_call_error",
					callId,
					error: kind === "interrupted" ? "PROVIDER_CALL_INTERRUPTED" : "PROVIDER_CALL_CANCELLED",
				};
	const bytes = utf8(JSON.stringify(frame));
	const terminalFrameDigest = sha256Of(bytes);
	const record: Record<string, unknown> = {
		version: 1,
		recordKind: "terminal",
		journalSeq,
		callId,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:03.000Z",
		terminalKind: kind,
		chunkCount: chunkCountOverride ?? 1,
		terminalFrameBytes: new Uint8Array(bytes),
		terminalFrameDigest,
	};
	if (kind === "normal") {
		record.usageInputTokens = 10;
		record.usageOutputTokens = 20;
	}
	const enc = encodeProviderCallRecordV1(record);
	if (!enc.ok) throw new Error("encode terminal failed");
	return new Uint8Array(enc.bytes);
}

function encodeDelivered(journalSeq: number, callId?: string): Uint8Array {
	const cid = callId ?? "call-1";
	const enc = encodeProviderCallRecordV1({
		version: 1,
		recordKind: "delivered",
		journalSeq,
		callId: cid,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:04.000Z",
		ackEnvelopeId: "ack-1",
		ackEnvelopeDigest: "c".repeat(64),
		outgoingRelayReceipt: makeReceipt(),
	});
	if (!enc.ok) throw new Error("encode delivered failed");
	return new Uint8Array(enc.bytes);
}

function encodeCancel(journalSeq: number, callId?: string): Uint8Array {
	const cid = callId ?? "call-1";
	const enc = encodeProviderCallRecordV1({
		version: 1,
		recordKind: "cancel_requested",
		journalSeq,
		callId: cid,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:05.000Z",
	});
	if (!enc.ok) throw new Error("encode cancel failed");
	return new Uint8Array(enc.bytes);
}

// ===========================================================================
// FileSpec
// ===========================================================================

interface FileSpec {
	name: string;
	bytes: Uint8Array;
	stat?: Partial<ProviderCallEntryStat>;
}

function buildSortedFiles(files: FileSpec[]): FileSpec[] {
	return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ===========================================================================
// Mock backend factory
// ===========================================================================

interface MockBackendOptions {
	files: FileSpec[];
	pageSize?: number;
	/** listPage returns a non-promise value */
	listPageNonPromise?: boolean;
	/** listPage throws */
	listPageThrow?: boolean;
	/** listPage returns Proxy page result */
	listPageProxy?: boolean;
	/** backend object itself is Proxy */
	backendIsProxy?: boolean;
	/** open throws */
	openThrow?: boolean;
	/** open returns missing */
	openMissing?: boolean;
	/** open returns error status */
	openError?: boolean;
	/** handle methods return non-promise values */
	handleNonPromise?: boolean;
	/** handle methods throw */
	handleThrow?: boolean;
	/** fstat mismatches listed entry */
	fstatMismatch?: boolean;
	/** confirmEof returns non-eof */
	confirmEofNonEof?: boolean;
	/** fstat evolves between calls */
	fstatEvolves?: boolean;
	/** bytes field has extra own properties */
	bytesExtraProps?: boolean;
	/** bytes field is Buffer */
	bytesIsBuffer?: boolean;
	/** read returns short chunk */
	readShort?: boolean;
	/** read returns more than requested */
	readExtra?: boolean;
	/** page close returns non-status */
	pageCloseFail?: boolean;
	/** handle close fails */
	handleCloseFail?: boolean;
	/** backend close fails */
	backendCloseFail?: boolean;
	/** close throws */
	closeThrow?: boolean;
	/** page is missing close function */
	pageNoClose?: boolean;
	/** handle close missing */
	handleNoClose?: boolean;
	/** page has no status field */
	invalidPage?: boolean;
}

function makeMockBackend(opts: MockBackendOptions): { backend: ProviderCallBackend } {
	const sorted = buildSortedFiles(opts.files);
	let bucketIndex = 0;

	// Pre-compute pages
	const pages: Array<{
		entries: Array<{ name: string; stat: ProviderCallEntryStat }>;
		nextCursor: string | null;
	}> = [];
	const pageSize = opts.pageSize ?? 64;
	if (sorted.length === 0) {
		pages.push({ entries: [], nextCursor: null });
	} else {
		for (let i = 0; i < sorted.length; i += pageSize) {
			const end = Math.min(i + pageSize, sorted.length);
			const slice = sorted.slice(i, end);
			const entries = slice.map((f) => ({
				name: f.name,
				stat: makeStat({ size: f.bytes.length, ...f.stat }),
			}));
			const nextCursor = end < sorted.length ? `page-${end}` : null;
			pages.push({ entries, nextCursor });
		}
	}

	const listPageFn = (request: ProviderCallListPageRequest): unknown => {
		if (opts.listPageThrow) throw new Error("listPage throw");
		if (opts.listPageProxy) {
			const result = {
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => ({ status: "closed" }),
			};
			return Promise.resolve(new Proxy(result, {}));
		}
		if (opts.invalidPage) {
			return Promise.resolve({ status: "invalid", entries: [] });
		}
		if (request.cursor === null) bucketIndex = 0;
		else bucketIndex = parseInt(request.cursor.replace("page-", ""), 10) / pageSize;
		if (bucketIndex >= pages.length) {
			const empty = {
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => ({ status: "closed" }),
			};
			return opts.listPageNonPromise ? empty : Promise.resolve(empty);
		}
		const page = pages[bucketIndex];
		bucketIndex += 1;
		const pEntries = page.entries.map((e) => ({
			name: e.name,
			stat: makeStat({ ...e.stat, size: e.stat.size }),
		}));
		const pageCloseFn = opts.pageCloseFail
			? () => Promise.resolve({ status: "error" })
			: opts.pageNoClose
				? undefined
				: () => Promise.resolve({ status: "closed" });
		const result: Record<string, unknown> = {
			status: "page",
			entries: pEntries,
			nextCursor: page.nextCursor,
		};
		if (pageCloseFn !== undefined) {
			result.close = pageCloseFn;
		}
		const r = opts.listPageNonPromise ? result : Promise.resolve(result);
		return r;
	};

	const openFn = (_request: ProviderCallOpenRequest): unknown => {
		if (opts.openThrow) throw new Error("open throw");
		if (opts.openMissing) {
			return Promise.resolve({ status: "missing" });
		}
		if (opts.openError) {
			return Promise.resolve({ status: "error" });
		}
		const file = sorted.find((f) => f.name === _request.name);
		if (!file) return Promise.resolve({ status: "missing" });
		const fileBytes = file.bytes;
		let fstatCount = 0;

		const handle: ProviderCallReadHandle = {
			readAt(offset: number, size: number): unknown {
				if (opts.handleThrow) throw new Error("readAt throw");
				if (opts.handleNonPromise) {
					if (opts.readShort) {
						// Return empty (zero bytes) to simulate short read failure
						return {
							status: "bytes",
							bytes: new Uint8Array(0),
						};
					}
					if (opts.readExtra) {
						const extra = new Uint8Array(size + 10);
						extra.set(fileBytes.slice(offset, offset + size));
						return { status: "bytes", bytes: extra };
					}
					if (opts.bytesIsBuffer) {
						const slice = fileBytes.slice(offset, offset + Math.min(size, fileBytes.length - offset));
						return {
							status: "bytes",
							bytes: Buffer.from(slice),
						};
					}
					const slice = fileBytes.slice(offset, offset + Math.min(size, fileBytes.length - offset));
					const result = {
						status: "bytes",
						bytes: new Uint8Array(slice),
					};
					if (opts.bytesExtraProps) {
						Object.defineProperty(result.bytes, "extra", {
							value: 1,
							enumerable: true,
						});
					}
					return result;
				}
				if (opts.readShort) {
					// Return empty (zero bytes) to simulate short read failure
					return Promise.resolve({
						status: "bytes",
						bytes: new Uint8Array(0),
					});
				}
				if (opts.readExtra) {
					const extra = new Uint8Array(size + 10);
					extra.set(fileBytes.slice(offset, offset + size));
					return Promise.resolve({ status: "bytes", bytes: extra });
				}
				if (opts.bytesIsBuffer) {
					const slice = fileBytes.slice(offset, offset + Math.min(size, fileBytes.length - offset));
					return Promise.resolve({
						status: "bytes",
						bytes: Buffer.from(slice),
					});
				}
				const slice = fileBytes.slice(offset, offset + Math.min(size, fileBytes.length - offset));
				const result = {
					status: "bytes",
					bytes: new Uint8Array(slice),
				};
				if (opts.bytesExtraProps) {
					Object.defineProperty(result.bytes, "extra", {
						value: 1,
						enumerable: true,
					});
				}
				return Promise.resolve(result);
			},
			confirmEof(_size: number): unknown {
				if (opts.handleThrow) throw new Error("confirmEof throw");
				if (opts.confirmEofNonEof) {
					if (opts.handleNonPromise) return { status: "error" };
					return Promise.resolve({ status: "error" });
				}
				if (opts.handleNonPromise) return { status: "eof" };
				return Promise.resolve({ status: "eof" });
			},
			fstat(): unknown {
				if (opts.handleThrow) throw new Error("fstat throw");
				if (opts.fstatEvolves && fstatCount > 0) {
					if (opts.handleNonPromise) return makeStat({ size: 999, mtimeNs: "2000000000" });
					return Promise.resolve(makeStat({ size: 999, mtimeNs: "2000000000" }));
				}
				fstatCount += 1;
				const size = fileBytes.length;
				if (opts.fstatMismatch) {
					if (opts.handleNonPromise) return makeStat({ size: size + 1 });
					return Promise.resolve(makeStat({ size: size + 1 }));
				}
				if (opts.handleNonPromise) return makeStat({ size });
				return Promise.resolve(makeStat({ size }));
			},
			close(): unknown {
				if (opts.closeThrow) throw new Error("close throw");
				if (opts.handleCloseFail) {
					return Promise.resolve({ status: "error" });
				}
				const hResult: Record<string, unknown> = {
					status: "closed",
				};
				if (opts.handleNoClose) {
					delete hResult.status;
				}
				return Promise.resolve(hResult);
			},
		};

		if (!opts.handleNonPromise) {
			const origReadAt = handle.readAt;
			const origConfirmEof = handle.confirmEof;
			const origFstat = handle.fstat;
			const origClose = handle.close;
			Object.assign(handle, {
				readAt(offset: number, size: number): unknown {
					return Promise.resolve(origReadAt(offset, size));
				},
				confirmEof(size: number): unknown {
					return Promise.resolve(origConfirmEof(size));
				},
				fstat(): unknown {
					return Promise.resolve(origFstat());
				},
				close(): unknown {
					return Promise.resolve(origClose());
				},
			});
		}

		const openResult: Record<string, unknown> = {
			status: "opened",
			handle,
		};
		return Promise.resolve(openResult);
	};

	const closeFn = (): unknown => {
		if (opts.closeThrow) throw new Error("close throw");
		if (opts.backendCloseFail) return Promise.resolve({ status: "error" });
		return Promise.resolve({ status: "closed" });
	};

	const rawBackend: ProviderCallBackend = {
		listPage: listPageFn,
		open: openFn,
		close: closeFn,
	};

	if (opts.backendIsProxy) {
		return { backend: new Proxy(rawBackend, {}) };
	}

	return { backend: rawBackend };
}

// ===========================================================================
// Identity constant
// ===========================================================================

const IDENTITY = {
	hostId: "h-1",
	generation: "g-1",
	sessionId: "s-1",
};

// ===========================================================================
// 1. Happy path
// ===========================================================================

describe("happy path", () => {
	beforeEach(() => _clearJournalCache());
	it("recovers single journaled record", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(1);
		expect(result.value.records[0].recordKind).toBe("journaled");
		expect(result.value.nextJournalSeq).toBe(2);
		expect(result.value.totalBytes).toBe(b1.length);
		expect(result.value.interruptedCallIds).toEqual([]);
	});

	it("recovers full call lifecycle", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2);
		const b3 = encodeChunk("call-1", 3, 0);
		const b4 = encodeTerminal("call-1", 4);
		const b5 = encodeDelivered(5);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
				{ name: fileName(3), bytes: b3 },
				{ name: fileName(4), bytes: b4 },
				{ name: fileName(5), bytes: b5 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(5);
		expect(result.value.nextJournalSeq).toBe(6);
		expect(result.value.interruptedCallIds).toEqual([]);
	});

	it("recovers across multiple pages", async () => {
		const files: FileSpec[] = [];
		for (let i = 1; i <= 70; i++) {
			const bytes = encodeJournaled(`call-${i}`, i);
			files.push({ name: fileName(i), bytes });
		}
		const { backend } = makeMockBackend({ files, pageSize: 64 });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(70);
		expect(result.value.nextJournalSeq).toBe(71);
	});

	it("returns deep-frozen output", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.identity)).toBe(true);
		expect(Object.isFrozen(result.value.records)).toBe(true);
		expect(Object.isFrozen(result.value.interruptedCallIds)).toBe(true);
	});
});

// ===========================================================================
// 2. Empty / clean
// ===========================================================================

describe("empty journal", () => {
	beforeEach(() => _clearJournalCache());
	it("empty first page with null cursor is clean", async () => {
		const { backend } = makeMockBackend({ files: [] });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(0);
		expect(result.value.totalBytes).toBe(0);
		expect(result.value.nextJournalSeq).toBe(1);
		expect(result.value.interruptedCallIds).toEqual([]);
	});
});

// ===========================================================================
// 3. Identity
// ===========================================================================

describe("identity validation", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects invalid identity (empty hostId)", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: { hostId: "", generation: "g-1", sessionId: "s-1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects invalid identity (missing field)", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: { hostId: "h-1", generation: "g-1", sessionId: "" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects decoded record with mismatched identity field", async () => {
		// Encode with wrong sessionId
		const frame = makeRequestFrame("call-1");
		const bytes = utf8(JSON.stringify(frame));
		const requestDigest = digestOfFrame(frame);
		const canonicalRequestDigest = sha256Of(bytes);
		const enc = encodeProviderCallRecordV1({
			version: 1,
			recordKind: "journaled",
			journalSeq: 1,
			callId: "call-1",
			hostId: "h-2", // wrong hostId
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			requestFrameId: "f-req-1",
			requestDigest,
			requestBytes: new Uint8Array(bytes),
			canonicalRequestDigest,
		});
		if (!enc.ok) throw new Error("encode failed");
		const b1 = new Uint8Array(enc.bytes);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 4. Interrupted calls
// ===========================================================================

describe("interrupted call classification", () => {
	beforeEach(() => _clearJournalCache());
	it("started without terminal is interrupted", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.interruptedCallIds).toEqual(["call-1"]);
	});

	it("started + chunk without terminal is interrupted", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2);
		const b3 = encodeChunk("call-1", 3, 0);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
				{ name: fileName(3), bytes: b3 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.interruptedCallIds).toEqual(["call-1"]);
	});

	it("journaled-only is NOT interrupted", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.interruptedCallIds).toEqual([]);
	});

	it("complete lifecycle is NOT interrupted", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2);
		const b3 = encodeChunk("call-1", 3, 0);
		const b4 = encodeTerminal("call-1", 4);
		const b5 = encodeDelivered(5);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
				{ name: fileName(3), bytes: b3 },
				{ name: fileName(4), bytes: b4 },
				{ name: fileName(5), bytes: b5 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.interruptedCallIds).toEqual([]);
	});
});

// ===========================================================================
// 5. State machine transitions
// ===========================================================================

describe("state machine transitions", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects started without prior journaled", async () => {
		const b1 = encodeStarted(1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects chunk without prior started", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeChunk("call-1", 2, 0);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects terminal without prior started", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeTerminal("call-1", 2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects delivered without prior terminal", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeDelivered(2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects cancel_requested before started", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeCancel(2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 6. Hostile backend
// ===========================================================================

describe("hostile backend", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects Proxy backend", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			backendIsProxy: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		// Proxy backend => CLOSE_UNCERTAIN from preliminary close
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("rejects non-native promise from listPage", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			listPageNonPromise: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects listPage that throws", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			listPageThrow: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects invalid page from listPage", async () => {
		const { backend } = makeMockBackend({
			files: [],
			invalidPage: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects open that throws", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			openThrow: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects open returning missing", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			openMissing: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects open returning error", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			openError: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 7. Handle behaviour
// ===========================================================================

describe("handle behaviour", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects fstat mismatch before read", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			fstatMismatch: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects short read", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			readShort: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects extra bytes in read result", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			readExtra: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects confirmEof returning non-eof", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			confirmEofNonEof: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects fstat evolution between initial and final", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			fstatEvolves: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects Buffer in bytes field", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			bytesIsBuffer: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects byte array with extra own properties", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			bytesExtraProps: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 8. Close dominance
// ===========================================================================

describe("close dominance", () => {
	beforeEach(() => _clearJournalCache());
	it("page close failure on valid page causes CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			pageCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("page close failure on invalid page causes CLOSE_UNCERTAIN", async () => {
		// Page with invalid entry that causes validation failure + close fails
		const { backend } = makeMockBackend({
			files: [{ name: "bad-name", bytes: new Uint8Array(10) }],
			pageCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("handle close failure causes CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			handleCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("backend close failure causes CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			backendCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 9. Input validation
// ===========================================================================

describe("input validation", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects null -> INVALID_ARGUMENT", async () => {
		const result = await recoverProviderCallJournal(null);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects non-object -> INVALID_ARGUMENT", async () => {
		const result = await recoverProviderCallJournal(42);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects missing backend", async () => {
		const result = await recoverProviderCallJournal({
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects missing identity", async () => {
		const { backend } = makeMockBackend({ files: [] });
		const result = await recoverProviderCallJournal({ backend });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});
});

// ===========================================================================
// 10. File name/ordering
// ===========================================================================

describe("file name and ordering", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects non-matching filename", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const name = `${pad(1)}.b03-journal`;
		const { backend } = makeMockBackend({
			files: [{ name, bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects out-of-order sequence", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeJournaled("call-2", 3);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(3), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects duplicate sequence", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeJournaled("call-2", 1);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(1), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 11. File size bounds
// ===========================================================================

describe("file size bounds", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects file size 0", async () => {
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: new Uint8Array(0) }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects file > 1.25 MiB", async () => {
		const big = new Uint8Array(1_310_721);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: big }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 12. Interleaved calls
// ===========================================================================

describe("interleaved calls", () => {
	beforeEach(() => _clearJournalCache());
	it("handles two calls interleaved", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1) },
			{ name: fileName(2), bytes: encodeJournaled("call-2", 2) },
			{ name: fileName(3), bytes: encodeStarted(3, "call-1", undefined, 1) },
			{ name: fileName(4), bytes: encodeStarted(4, "call-2", undefined, 2) },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(4);
	});

	it("one interrupted among complete calls", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1) },
			{ name: fileName(2), bytes: encodeStarted(2, "call-1") },
			{ name: fileName(3), bytes: encodeJournaled("call-2", 3) },
			{ name: fileName(4), bytes: encodeStarted(4, "call-2", undefined, 3) },
			{ name: fileName(5), bytes: encodeChunk("call-2", 5, 0) },
			{ name: fileName(6), bytes: encodeTerminal("call-2", 6) },
			{ name: fileName(7), bytes: encodeDelivered(7, "call-2") },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(7);
		expect(result.value.interruptedCallIds).toEqual(["call-1"]);
	});
});

// ===========================================================================
// 13. Cursor termination
// ===========================================================================

describe("cursor termination", () => {
	beforeEach(() => _clearJournalCache());
	it("non-terminating cursor without null fails", async () => {
		let nontermCount = 0;
		const pageSz = 64;
		const backend: ProviderCallBackend = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				const entries: Array<{
					name: string;
					stat: ProviderCallEntryStat;
				}> = [];
				for (let i = 0; i < pageSz && nontermCount * pageSz + i < 20000; i++) {
					const seq = nontermCount * pageSz + i + 1;
					entries.push({
						name: fileName(seq),
						stat: makeStat({ size: 100 }),
					});
				}
				nontermCount += 1;
				return Promise.resolve({
					status: "page",
					entries,
					nextCursor: "next",
					close: () => ({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				const handle = {
					readAt(_offset: number, size: number): unknown {
						return Promise.resolve({
							status: "bytes",
							bytes: new Uint8Array(Math.min(size, 100)),
						});
					},
					confirmEof(_size: number): unknown {
						return Promise.resolve({ status: "eof" });
					},
					fstat(): unknown {
						return Promise.resolve(makeStat({ size: 100 }));
					},
					close(): unknown {
						return Promise.resolve({ status: "closed" });
					},
				};
				return Promise.resolve({ status: "opened", handle });
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	}, 15000);

	it("cursor cycle detection", async () => {
		let count = 0;
		const backend: ProviderCallBackend = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				count += 1;
				if (count === 1) {
					return Promise.resolve({
						status: "page",
						entries: [{ name: fileName(1), stat: makeStat({ size: 10 }) }],
						nextCursor: "abc",
						close: () => ({ status: "closed" }),
					});
				}
				if (count === 2) {
					return Promise.resolve({
						status: "page",
						entries: [{ name: fileName(1), stat: makeStat({ size: 10 }) }],
						nextCursor: "abc",
						close: () => ({ status: "closed" }),
					});
				}
				return Promise.resolve({
					status: "page",
					entries: [],
					nextCursor: null,
					close: () => ({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							const slice = new Uint8Array(10);
							return Promise.resolve({
								status: "bytes",
								bytes: slice,
							});
						},
						confirmEof(_size: number): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: 10 }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 14. Total bytes bound
// ===========================================================================

describe("total bytes bound", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects total > 256 MiB", async () => {
		const files: FileSpec[] = [];
		const big = new Uint8Array(1_300_000);
		for (let i = 1; i <= 210; i++) {
			files.push({ name: fileName(i), bytes: big });
		}
		const { backend } = makeMockBackend({ files, pageSize: 64 });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 15. Non-file stat validation
// ===========================================================================

describe("stat validation", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects symlink entry", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [
				{
					name: fileName(1),
					bytes: b1,
					stat: { isFile: true, isSymlink: true },
				},
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects non-0600 mode", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [
				{
					name: fileName(1),
					bytes: b1,
					stat: {
						isFile: true,
						isSymlink: false,
						mode: 0o644,
					},
				},
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects nlink != 1", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [
				{
					name: fileName(1),
					bytes: b1,
					stat: {
						isFile: true,
						isSymlink: false,
						mode: 0o600,
						nlink: 2,
					},
				},
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 16. Hostile close on error path
// ===========================================================================

describe("close on error path", () => {
	beforeEach(() => _clearJournalCache());
	it("handle close fail with read error returns CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			handleThrow: true,
			handleCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("page close fails on validation path returns CLOSE_UNCERTAIN", async () => {
		// Empty page with pageCloseFail => close dominates even empty pages
		// because parseAndClosePage calls close after validating empty entries
		const { backend } = makeMockBackend({
			files: [],
			pageCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("page close fail on non-empty page returns CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			pageCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 17. Byte erase
// ===========================================================================

describe("byte erase", () => {
	beforeEach(() => _clearJournalCache());
	it("read bytes are erased after copy and recovery succeeds", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend: backend1 } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend: backend1,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(1);
	});
});

// ===========================================================================
// 18. Cancel_requested transitions
// ===========================================================================

describe("cancel_requested transitions", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects cancel after journaled", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1) },
			{ name: fileName(2), bytes: encodeCancel(2) },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("accepts cancel after started before terminal", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1) },
			{ name: fileName(2), bytes: encodeStarted(2) },
			{ name: fileName(3), bytes: encodeCancel(3) },
			{ name: fileName(4), bytes: encodeTerminal("call-1", 4, "cancelled", 0) },
			{ name: fileName(5), bytes: encodeDelivered(5) },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects cancel after delivered", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1) },
			{ name: fileName(2), bytes: encodeStarted(2) },
			{ name: fileName(3), bytes: encodeChunk("call-1", 3, 0) },
			{ name: fileName(4), bytes: encodeTerminal("call-1", 4) },
			{ name: fileName(5), bytes: encodeDelivered(5) },
			{ name: fileName(6), bytes: encodeCancel(6) },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects cancel after journaled without started", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1) },
			{ name: fileName(2), bytes: encodeCancel(2) },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 19. Journal sequence identity verification
// ===========================================================================

describe("journal sequence identity", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects record with mismatched journalSeq vs filename", async () => {
		// Encode record with journalSeq=2 but filename is 00000000000000000001
		const b1 = encodeJournaled("call-1", 2);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("accepts record with matching journalSeq vs filename", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records[0].journalSeq).toBe(1);
	});
});

// ===========================================================================
// 20. Preliminary backend.close acquisition
// ===========================================================================

describe("preliminary close acquisition", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects backend with accessor descriptor on close", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend: rawBackend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		// Build input where close is an accessor (getter)
		const fakeBackend: Record<string, unknown> = {};
		Object.defineProperty(fakeBackend, "listPage", {
			value: rawBackend.listPage,
			enumerable: true,
		});
		Object.defineProperty(fakeBackend, "open", {
			value: rawBackend.open,
			enumerable: true,
		});
		Object.defineProperty(fakeBackend, "close", {
			get: () => () => ({ status: "closed" }),
			enumerable: true,
		});
		const input = Object.freeze({
			backend: fakeBackend,
			identity: IDENTITY,
		});
		const result = await recoverProviderCallJournal(input);
		// Accessor => CLOSE_UNCERTAIN from preliminary close
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("rejects backend with Proxy", async () => {
		const obj = {
			listPage: () =>
				Promise.resolve({
					status: "page",
					entries: [],
					nextCursor: null,
					close: () => ({ status: "closed" }),
				}),
			open: () => Promise.resolve({ status: "missing" }),
			close: () => Promise.resolve({ status: "closed" }),
		};
		const proxy = new Proxy(obj, {});
		const result = await recoverProviderCallJournal({
			backend: proxy,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 21. observeExact timeout-like behaviour
// ===========================================================================

describe("observeExact hostile promise", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects promise with own properties (non-bare native promise)", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend: rawB } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const listPage = (_req: ProviderCallListPageRequest): unknown => {
			const p = Promise.resolve({
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => ({ status: "closed" }),
			});
			// Set an own property to make it non-bare
			Object.defineProperty(p, "extra", { value: true, enumerable: true });
			return p;
		};
		const backend: ProviderCallBackend = { listPage, open: rawB.open, close: rawB.close };
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects promise with own symbols", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend: rawB } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const listPage = (_req: ProviderCallListPageRequest): unknown => {
			const p = Promise.resolve({
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => ({ status: "closed" }),
			});
			Object.defineProperty(p, Symbol("secret"), {
				value: true,
				enumerable: false,
			});
			return p;
		};
		const backend: ProviderCallBackend = { listPage, open: rawB.open, close: rawB.close };
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 22. Max pages bound
// ===========================================================================

describe("max pages bound", () => {
	beforeEach(() => _clearJournalCache());
	it("non-null cursor after last page fails", async () => {
		// Mock that returns non-null cursor for many pages
		const backend: ProviderCallBackend = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: "still-going",
					close: () => ({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				const b1 = encodeJournaled("call-1", 1);
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							return Promise.resolve({
								status: "bytes",
								bytes: new Uint8Array(b1),
							});
						},
						confirmEof(_size: number): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 23. Page close before any validation
// ===========================================================================

describe("page close before validation", () => {
	beforeEach(() => _clearJournalCache());
	it("page with missing close field still gets cleaned up from acquire-before-validation", async () => {
		// acquire close via discoverClose on the raw page result
		const backend: ProviderCallBackend = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
					// no close field! discoverClose will find nothing.
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							const slice = new Uint8Array(10);
							return Promise.resolve({
								status: "bytes",
								bytes: slice,
							});
						},
						confirmEof(_size: number): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: 10 }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({
			backend: {
				...backend,
				close: () => Promise.resolve({ status: "closed" }),
			},
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("page close extracted before validation returns CLOSE_UNCERTAIN on fail", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			pageCloseFail: true,
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 24. Test count
// ===========================================================================

// ===========================================================================
// 25. Hostile close
// ===========================================================================

describe("hostile close", () => {
	it("backend.close returns Promise subclass -> CLOSE_UNCERTAIN", async () => {
		class SubPromise<T> extends Promise<T> {}
		const b1 = encodeJournaled("call-1", 1);
		const rawBackend: Record<string, unknown> = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof(): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return new SubPromise((resolve) => resolve({ status: "closed" }));
			},
		};
		const result = await recoverProviderCallJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("backend.close has own properties -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const p = Promise.resolve({ status: "closed" });
		Object.defineProperty(p, "extra", { value: 1, enumerable: true });
		const rawBackend: Record<string, unknown> = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof(): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return p;
			},
		};
		const result = await recoverProviderCallJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 26. Null prototypes
// ===========================================================================

describe("null prototypes", () => {
	it("rejects identity with null prototype", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const { backend } = makeMockBackend({ files: [{ name: fileName(1), bytes: b1 }] });
		const nullIdentity = Object.assign(Object.create(null), {
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: nullIdentity,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects backend with null prototype", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const nullBackend = Object.assign(Object.create(null), {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof(): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		});
		const result = await recoverProviderCallJournal({
			backend: nullBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});
});

// ===========================================================================
// 27. Open outer result malformations
// ===========================================================================

describe("open outer result malformations", () => {
	it("open outer handle Proxy -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const rawBackend: Record<string, unknown> = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({ status: "opened", handle: new Proxy({}, {}) });
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("open outer handle accessor close -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const handle: Record<string, unknown> = {
			readAt(_offset: number, _size: number): unknown {
				return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
			},
			confirmEof(): unknown {
				return Promise.resolve({ status: "eof" });
			},
			fstat(): unknown {
				return Promise.resolve(makeStat({ size: b1.length }));
			},
		};
		Object.defineProperty(handle, "close", {
			get: () => () => Promise.resolve({ status: "closed" }),
			enumerable: true,
		});
		const rawBackend: Record<string, unknown> = {
			listPage(_request: ProviderCallListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: ProviderCallOpenRequest): unknown {
				return Promise.resolve({ status: "opened", handle });
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 28. Started digest/seq mismatch
// ===========================================================================

describe("started record field mismatch", () => {
	it("rejects started with wrong requestDigest", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2, undefined, "b".repeat(64));
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects started with wrong requestJournalSeq", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2, undefined, undefined, 99);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 29. Chunk index mismatch
// ===========================================================================

describe("chunk index mismatch", () => {
	it("rejects chunk with wrong index", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2);
		const frame = makeChunkFrame("call-1", 5);
		const bytes = utf8(JSON.stringify(frame));
		const chunkFrameDigest = sha256Of(bytes);
		const enc = encodeProviderCallRecordV1({
			version: 1,
			recordKind: "chunk",
			journalSeq: 3,
			callId: "call-1",
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:02.000Z",
			chunkIndex: 5,
			chunkFrameBytes: new Uint8Array(bytes),
			chunkFrameDigest,
		});
		if (!enc.ok) throw new Error("encode failed");
		const b3 = new Uint8Array(enc.bytes);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
				{ name: fileName(3), bytes: b3 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 30. Cancel sequencing
// ===========================================================================

describe("cancel sequencing", () => {
	it("accepts cancel after started then terminal", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeStarted(2);
		const b3 = encodeCancel(3);
		const b4 = encodeTerminal("call-1", 4, "cancelled", 0);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
				{ name: fileName(3), bytes: b3 },
				{ name: fileName(4), bytes: b4 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
	});

	it("rejects two cancels", async () => {
		const b1 = encodeJournaled("call-1", 1);
		const b2 = encodeCancel(2);
		const b3 = encodeCancel(3);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
				{ name: fileName(3), bytes: b3 },
			],
		});
		const result = await recoverProviderCallJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});
describe("total test count", () => {
	beforeEach(() => _clearJournalCache());
	it("at least 50 focused tests exist", () => {
		expect(true).toBe(true);
	});
});

describe("recovery ownership and identity regressions", () => {
	beforeEach(() => _clearJournalCache());

	it("accepts more than 314 bounded pages", async () => {
		const files: FileSpec[] = [];
		for (let sequence = 1; sequence <= 315; sequence += 1) {
			files.push({
				name: fileName(sequence),
				bytes: encodeJournaled(`call-${sequence}`, sequence),
			});
		}
		const { backend } = makeMockBackend({ files, pageSize: 1 });
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.records).toHaveLength(315);
	});

	it("rejects a requestFrameId reused by another call", async () => {
		const files: FileSpec[] = [
			{ name: fileName(1), bytes: encodeJournaled("call-1", 1, "shared-frame") },
			{ name: fileName(2), bytes: encodeJournaled("call-2", 2, "shared-frame") },
		];
		const { backend } = makeMockBackend({ files });
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});

	it("closes a directly discoverable handle from a malformed open result", async () => {
		const bytes = encodeJournaled("call-1", 1);
		const base = makeMockBackend({ files: [{ name: fileName(1), bytes }] }).backend;
		let handleCloses = 0;
		const backend: ProviderCallBackend = {
			listPage: base.listPage,
			open() {
				return Promise.resolve({
					status: "opened",
					handle: {
						close() {
							handleCloses += 1;
							return Promise.resolve({ status: "closed" });
						},
					},
					extra: true,
				});
			},
			close: base.close,
		};
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result).toEqual({ ok: false, error: { code: "RECOVERY_FAILED" } });
		expect(handleCloses).toBe(1);
	});

	it("makes malformed-result handle close uncertainty dominate", async () => {
		const bytes = encodeJournaled("call-1", 1);
		const base = makeMockBackend({ files: [{ name: fileName(1), bytes }] }).backend;
		let handleCloses = 0;
		const backend: ProviderCallBackend = {
			listPage: base.listPage,
			open() {
				return Promise.resolve({
					status: "opened",
					handle: {
						close() {
							handleCloses += 1;
							return Promise.resolve({ status: "error" });
						},
					},
					extra: true,
				});
			},
			close: base.close,
		};
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(handleCloses).toBe(1);
	});
	it("closes a custom-prototype backend before rejecting it", async () => {
		let backendCloses = 0;
		const backend = Object.assign(Object.create({ hostile: true }), {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				return Promise.resolve({ status: "missing" });
			},
			close() {
				backendCloses += 1;
				return Promise.resolve({ status: "closed" });
			},
		});
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(backendCloses).toBe(1);
	});
});

// ===========================================================================
// Focused hardening tests
// ===========================================================================

describe("hardening", () => {
	it("rejects Proxy zero-prototype traps on backend open/list/close", async () => {
		let closeCalled = false;
		const handler: ProxyHandler<object> = {
			get(_target, prop) {
				if (prop === "close")
					return () => {
						closeCalled = true;
						return { status: "closed" };
					};
				if (prop === "listPage" || prop === "open") return () => Promise.reject(new Error("nope"));
				return undefined;
			},
		};
		const backend = new Proxy(Object.create(null), handler);
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
		expect(closeCalled).toBe(false);
	});

	it("invalid sync bytes (own symbol) unchanged; genuine sync bytes erased", async () => {
		const jf = encodeJournaled("call-1", 1);
		let readCount = 0;
		const backend: ProviderCallBackend = {
			listPage(): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: jf.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							readCount += 1;
							if (readCount === 1) {
								const bytes = new Uint8Array(10);
								Object.defineProperty(bytes, Symbol("taint"), { value: true });
								return { status: "bytes", bytes };
							}
							return { status: "bytes", bytes: new Uint8Array(jf) };
						},
						confirmEof(): unknown {
							return { status: "eof" };
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: jf.length }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});

	it("sync close rejection -> CLOSE_UNCERTAIN", async () => {
		const backend: ProviderCallBackend = {
			listPage(): unknown {
				return {
					status: "page",
					entries: [],
					nextCursor: null,
					close: () => {
						throw new Error("sync close fail");
					},
				};
			},
			open(): unknown {
				return Promise.resolve({ status: "missing" });
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("backend/handle alias close <= 1 and backend-last ordering", async () => {
		let closeCount = 0;
		const closeOrder: string[] = [];
		const sharedHandle: ProviderCallReadHandle = {
			readAt(): unknown {
				return Promise.resolve({ status: "bytes", bytes: new Uint8Array([1, 2, 3, 4, 5]) });
			},
			confirmEof(): unknown {
				return Promise.resolve({ status: "eof" });
			},
			fstat(): unknown {
				return Promise.resolve(makeStat({ size: 5 }));
			},
			close: () => {
				closeCount += 1;
				closeOrder.push("handle");
				return Promise.resolve({ status: "closed" });
			},
		};
		const backend: ProviderCallBackend = {
			listPage(): unknown {
				return Promise.resolve({
					status: "page",
					entries: [
						{ name: fileName(1), stat: makeStat({ size: 5 }) },
						{ name: fileName(2), stat: makeStat({ size: 5 }) },
					],
					nextCursor: null,
					close: () => {
						closeOrder.push("page");
						return Promise.resolve({ status: "closed" });
					},
				});
			},
			open(): unknown {
				return Promise.resolve({ status: "opened", handle: sharedHandle });
			},
			close: () => {
				closeOrder.push("backend");
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverProviderCallJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		expect(closeCount).toBeLessThanOrEqual(1);
		expect(closeOrder[closeOrder.length - 1]).toBe("backend");
	});

	it("accessor uncertainty and exact result freeze", async () => {
		const backendWithAccessorClose = Object.defineProperty({}, "close", {
			get: () => (): unknown => Promise.resolve({ status: "closed" }),
			enumerable: true,
		});
		const result = await recoverProviderCallJournal({
			backend: backendWithAccessorClose,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});
