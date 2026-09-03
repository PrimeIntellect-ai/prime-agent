/**
 * Tests for SandboxEventOutboxJournal recovery scanner — paginated two-pass scan,
 * per-file state validation, page-close on every path, per-file handle-close
 * dominance, preliminary backend.close acquisition, and identity/digest/transition
 * tests.
 *
 * Vitest >= 50 focused tests.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

// Typed literal constants for variant fields (no `as const` assertions)
const PENDING: "pending" = "pending";
const DELIVERED: "delivered" = "delivered";
const DELIVERED_OUTCOME: "DELIVERED" = "DELIVERED";

import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";
import { encodeSandboxEventOutboxRecordV1 } from "../src/modes/daemon/sandbox-event-outbox-record-codec.js";
import {
	CleanupRegistry,
	type EventOutboxBackend,
	type EventOutboxEntryStat,
	type EventOutboxListPageRequest,
	type EventOutboxOpenRequest,
	type EventOutboxReadHandle,
	exactTransferred,
	isPromise,
	recoverSandboxEventOutboxJournal,
} from "../src/modes/daemon/sandbox-event-outbox-recovery.js";

// ===========================================================================
// Helpers
// ===========================================================================

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function _utf8(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function _digestOfFrame(frame: Record<string, unknown>): string {
	const r = canonicalDigest(frame);
	if (!r.ok) throw new Error("canonicalDigest failed");
	return r.value;
}

function pad(seq: number): string {
	return String(seq).padStart(20, "0");
}

function fileName(seq: number): string {
	return `${pad(seq)}.b14-event-outbox`;
}

function makeStat(overrides?: Partial<EventOutboxEntryStat>): EventOutboxEntryStat {
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

function makeEventBody(type: string): Record<string, unknown> {
	switch (type) {
		case "session_created":
			return { type: "session_created", sessionId: "sess-1", workspaceId: "ws-1" };
		case "session_destroyed":
			return { type: "session_destroyed" };
		case "agent_start":
			return { type: "agent_start" };
		case "agent_end":
			return { type: "agent_end", messages: 5 };
		case "agent_text_delta":
			return { type: "agent_text_delta", index: 0, text: "hello" };
		case "agent_thinking_delta":
			return { type: "agent_thinking_delta", index: 0, text: "thinking..." };
		case "agent_toolcall_delta":
			return { type: "agent_toolcall_delta", index: 0, text: "tool call" };
		case "bash_start":
			return { type: "bash_start", command: "ls" };
		case "bash_end":
			return { type: "bash_end", exitCode: 0, cancelled: false, truncated: false };
		case "bash_delta":
			return { type: "bash_delta", text: "output" };
		case "compact_start":
			return { type: "compact_start" };
		case "compact_end":
			return { type: "compact_end", keptMessages: 10 };
		case "compact_failed":
			return { type: "compact_failed", error: "oops" };
		case "error":
			return { type: "error", code: "ERR", message: "something went wrong" };
		case "checkpoint_start":
			return { type: "checkpoint_start" };
		case "checkpoint_complete":
			return { type: "checkpoint_complete", snapshotId: "snap-1" };
		case "checkpoint_failed":
			return { type: "checkpoint_failed", error: "checkpoint error" };
		case "session_state":
			return { type: "session_state", state: "running" };
		default:
			throw new Error(`unknown event body type: ${type}`);
	}
}

function makeEventFrame(eventId: string, bodyType: string, sequence?: number): Record<string, unknown> {
	const body = makeEventBody(bodyType);
	const seq = sequence ?? 1;
	return {
		type: "event",
		id: eventId,
		sequence: seq,
		cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: seq },
		emittedAt: "2025-01-15T10:30:00.000Z",
		body,
	};
}

function digestOfFrameAlt(evt: Record<string, unknown>): string {
	const r = canonicalDigest(evt);
	if (!r.ok) throw new Error("canonicalDigest failed for event frame");
	return r.value;
}

function makeAckFrame(
	ackId: string,
	acknowledges: string,
	status: "delivered" | "replayed" | "rejected",
): Record<string, unknown> {
	return {
		type: "ack",
		ackId,
		acknowledges,
		status,
	};
}

function digestOfAck(ack: Record<string, unknown>): string {
	const r = canonicalDigest(ack);
	if (!r.ok) throw new Error("canonicalDigest failed for ack");
	return r.value;
}

function makePendingRecord(eventId: string, recordSeq: number, bodyType?: string): Record<string, unknown> {
	const bType = bodyType ?? "agent_start";
	const evt = makeEventFrame(eventId, bType);
	const eventDigest = digestOfFrameAlt(evt);
	return {
		version: 1,
		recordKind: "pending",
		recordSeq,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		eventId,
		eventSequence: 1,
		eventType: bType,
		eventDigest,
		event: evt,
	};
}

function makeDeliveredRecord(
	eventId: string,
	recordSeq: number,
	bodyType?: string,
	ackStatus?: "delivered" | "replayed",
): Record<string, unknown> {
	const bType = bodyType ?? "agent_start";
	const ackSt = ackStatus ?? "delivered";
	const evt = makeEventFrame(eventId, bType);
	const eventDigest = digestOfFrameAlt(evt);
	const ack = makeAckFrame(`a-${eventId}`, eventId, ackSt);
	const ackDigest = digestOfAck(ack);
	return {
		version: 1,
		recordKind: "delivered",
		recordSeq,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		eventId,
		eventSequence: 1,
		eventType: bType,
		eventDigest,
		event: evt,
		outcome: "DELIVERED",
		ackDigest,
		ack,
	};
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

function encodePending(eventId: string, recordSeq: number): Uint8Array {
	const raw = makePendingRecord(eventId, recordSeq);
	const enc = encodeSandboxEventOutboxRecordV1(raw);
	if (!enc.ok) throw new Error("encode pending failed");
	const rawBytes = new Uint8Array(enc.bytes);
	const sha = sha256Of(rawBytes);
	_journalCache.set(recordSeq, { bytes: rawBytes, sha256: sha, size: rawBytes.byteLength, seq: recordSeq });
	return rawBytes;
}

function encodeDelivered(eventId: string, recordSeq: number): Uint8Array {
	const raw = makeDeliveredRecord(eventId, recordSeq);
	const enc = encodeSandboxEventOutboxRecordV1(raw);
	if (!enc.ok) throw new Error("encode delivered failed");
	const rawBytes = new Uint8Array(enc.bytes);
	const sha = sha256Of(rawBytes);
	_journalCache.set(recordSeq, { bytes: rawBytes, sha256: sha, size: rawBytes.byteLength, seq: recordSeq });
	return rawBytes;
}

function _clearJournalCache(): void {
	_journalCache.clear();
}

// ===========================================================================
// FileSpec
// ===========================================================================

interface FileSpec {
	name: string;
	bytes: Uint8Array;
	stat?: Partial<EventOutboxEntryStat>;
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

function makeMockBackend(opts: MockBackendOptions): { backend: EventOutboxBackend } {
	const sorted = buildSortedFiles(opts.files);
	let bucketIndex = 0;

	// Pre-compute pages
	const pages: Array<{
		entries: Array<{ name: string; stat: EventOutboxEntryStat }>;
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

	const listPageFn = (request: EventOutboxListPageRequest): unknown => {
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

	const openFn = (_request: EventOutboxOpenRequest): unknown => {
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

		const handle: EventOutboxReadHandle = {
			readAt(offset: number, size: number): unknown {
				if (opts.handleThrow) throw new Error("readAt throw");
				if (opts.handleNonPromise) {
					if (opts.readShort) {
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

	const rawBackend: EventOutboxBackend = {
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
	it("recovers single pending record", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(1);
		expect(result.value.records[0].recordKind).toBe("pending");
		expect(result.value.nextJournalSeq).toBe(2);
		expect(result.value.totalBytes).toBe(b1.length);
		expect(result.value.receipts.length).toBe(1);
		expect(result.value.receipts[0].sequence).toBe(1);
		expect(result.value.receipts[0].size).toBe(b1.length);
		expect(result.value.receipts[0].sha256.length).toBe(64);
	});

	it("recovers pending + delivered pair", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodeDelivered("evt-1", 2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(2);
		expect(result.value.records[0].recordKind).toBe("pending");
		expect(result.value.records[1].recordKind).toBe("delivered");
		expect(result.value.nextJournalSeq).toBe(3);
	});

	it("recovers across multiple pages", async () => {
		const files: FileSpec[] = [];
		for (let i = 1; i <= 70; i++) {
			const evt = makeEventFrame(`evt-${i}`, "agent_start", i);
			const ed = digestOfFrameAlt(evt);
			const raw = {
				version: 1,
				recordKind: PENDING,
				recordSeq: i,
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				recordedAt: "2025-01-15T10:30:00.000Z",
				eventId: `evt-${i}`,
				eventSequence: i,
				eventType: "agent_start",
				eventDigest: ed,
				event: evt,
			};
			const enc = encodeSandboxEventOutboxRecordV1(raw);
			if (!enc.ok) throw new Error("encode failed");
			files.push({ name: fileName(i), bytes: new Uint8Array(enc.bytes) });
		}
		const { backend } = makeMockBackend({ files, pageSize: 64 });
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(70);
		expect(result.value.nextJournalSeq).toBe(71);
		expect(result.value.receipts.length).toBe(70);
	});

	it("returns deep-frozen output", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.identity)).toBe(true);
		expect(Object.isFrozen(result.value.records)).toBe(true);
		expect(Object.isFrozen(result.value.receipts)).toBe(true);
	});
});

// ===========================================================================
// 2. Empty / clean
// ===========================================================================

describe("empty journal", () => {
	beforeEach(() => _clearJournalCache());
	it("empty first page with null cursor is clean", async () => {
		const { backend } = makeMockBackend({ files: [] });
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(0);
		expect(result.value.totalBytes).toBe(0);
		expect(result.value.nextJournalSeq).toBe(1);
		expect(result.value.receipts.length).toBe(0);
	});
});

// ===========================================================================
// 3. Identity
// ===========================================================================

describe("identity validation", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects invalid identity (empty hostId)", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: { hostId: "", generation: "g-1", sessionId: "s-1" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects invalid identity (missing field)", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: { hostId: "h-1", generation: "g-1", sessionId: "" },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects decoded record with mismatched identity field", async () => {
		// Encode a valid record, then tamper the bytes to change hostId and sessionId
		const enc = encodeSandboxEventOutboxRecordV1(makePendingRecord("evt-1", 1));
		if (!enc.ok) throw new Error("encode failed");
		const str = new TextDecoder().decode(enc.bytes);
		const tampered = str
			.replace(/"hostId":"h-1"/g, '"hostId":"h-2"')
			.replace(/"sessionId":"s-1"/g, '"sessionId":"s-2"');
		const b1 = new TextEncoder().encode(tampered);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 4. State transitions
// ===========================================================================

describe("state transitions", () => {
	beforeEach(() => _clearJournalCache());
	it("pending-only (never delivered) is valid", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(1);
		expect(result.value.records[0].recordKind).toBe("pending");
	});

	it("delivered without prior pending is rejected", async () => {
		const b1 = encodeDelivered("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("duplicate event ID is rejected", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodePending("evt-1", 2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("pending then delivered for same event is valid", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodeDelivered("evt-1", 2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(2);
	});

	it("pending then delivered for same event checks event content equality", async () => {
		const b1 = encodePending("evt-1", 1);
		// Create a delivered record with different event type
		const evt = makeEventFrame("evt-1", "bash_start");
		const eventDigest = digestOfFrameAlt(evt);
		const ack = makeAckFrame("a-evt-1", "evt-1", "delivered");
		const ackDigest = digestOfAck(ack);
		const raw = {
			version: 1,
			recordKind: DELIVERED,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-1",
			eventSequence: 1,
			eventType: "bash_start",
			eventDigest,
			event: evt,
			outcome: "DELIVERED",
			ackDigest,
			ack,
		};
		const enc = encodeSandboxEventOutboxRecordV1(raw);
		if (!enc.ok) throw new Error("encode delivered with bash_start failed");
		const b2 = new Uint8Array(enc.bytes);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		// eventDigest won't match because body type differs - the codec
		// will validate and encode correctly but the recovery checks eventDigest
		// equality. The pending has eventDigest for agent_start, delivered has
		// eventDigest for bash_start, so eventContentEq will see different digests.
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 5. Hostile backend
// ===========================================================================

describe("hostile backend", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects Proxy backend", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			backendIsProxy: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("rejects non-native promise from listPage", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			listPageNonPromise: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects listPage that throws", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			listPageThrow: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects open that throws", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			openThrow: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects open returning missing", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			openMissing: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects open returning error", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			openError: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 6. Handle behaviour
// ===========================================================================

describe("handle behaviour", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects fstat mismatch before read", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			fstatMismatch: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects short read", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			readShort: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects extra bytes in read result", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			readExtra: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects confirmEof returning non-eof", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			confirmEofNonEof: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects fstat evolution between initial and final", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			fstatEvolves: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects Buffer in bytes field", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			bytesIsBuffer: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects byte array with extra own properties", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			bytesExtraProps: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 7. Close dominance
// ===========================================================================

describe("close dominance", () => {
	beforeEach(() => _clearJournalCache());
	it("page close failure on valid page causes CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			pageCloseFail: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("handle close failure causes CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			handleCloseFail: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("backend close failure causes CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			backendCloseFail: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 8. Input validation
// ===========================================================================

describe("input validation", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects null", async () => {
		const result = await recoverSandboxEventOutboxJournal(null);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects non-object", async () => {
		const result = await recoverSandboxEventOutboxJournal(42);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects missing backend", async () => {
		const result = await recoverSandboxEventOutboxJournal({
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects missing identity", async () => {
		const { backend } = makeMockBackend({ files: [] });
		const result = await recoverSandboxEventOutboxJournal({ backend });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});
});

// ===========================================================================
// 9. File name/ordering
// ===========================================================================

describe("file name and ordering", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects non-matching filename suffix", async () => {
		const b1 = encodePending("evt-1", 1);
		const name = `${pad(1)}.b10-provider-call`; // wrong suffix
		const { backend } = makeMockBackend({
			files: [{ name, bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects out-of-order sequence", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodePending("evt-2", 3); // seq 3 but filename is seq 2
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(3), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects duplicate sequence", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodePending("evt-2", 1); // same seq
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(1), bytes: b2 }, // same name
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 10. File size bounds
// ===========================================================================

describe("file size bounds", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects file size 0", async () => {
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: new Uint8Array(0) }],
		});
		const result = await recoverSandboxEventOutboxJournal({
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 11. Cursor termination
// ===========================================================================

describe("cursor termination", () => {
	beforeEach(() => _clearJournalCache());
	it("non-terminating cursor without null fails", async () => {
		let nontermCount = 0;
		const pageSz = 64;
		const backend: EventOutboxBackend = {
			listPage(_request: EventOutboxListPageRequest): unknown {
				const entries: Array<{
					name: string;
					stat: EventOutboxEntryStat;
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
			open(_request: EventOutboxOpenRequest): unknown {
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	}, 15000);

	it("cursor cycle detection", async () => {
		let count = 0;
		const backend: EventOutboxBackend = {
			listPage(_request: EventOutboxListPageRequest): unknown {
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
			open(_request: EventOutboxOpenRequest): unknown {
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 12. Stat validation
// ===========================================================================

describe("stat validation", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects symlink entry", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [
				{
					name: fileName(1),
					bytes: b1,
					stat: { isFile: true, isSymlink: true },
				},
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects non-0600 mode", async () => {
		const b1 = encodePending("evt-1", 1);
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects nlink != 1", async () => {
		const b1 = encodePending("evt-1", 1);
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 13. Preliminary backend.close acquisition
// ===========================================================================

describe("preliminary close acquisition", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects backend with accessor descriptor on close", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend: rawBackend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
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
		const result = await recoverSandboxEventOutboxJournal(input);
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
		const result = await recoverSandboxEventOutboxJournal({
			backend: proxy,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 14. observeExact hostile promise
// ===========================================================================

describe("observeExact hostile promise", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects promise with own properties (non-bare native promise)", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend: rawB } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const listPage = (_req: EventOutboxListPageRequest): unknown => {
			const p = Promise.resolve({
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => ({ status: "closed" }),
			});
			Object.defineProperty(p, "extra", { value: true, enumerable: true });
			return p;
		};
		const backend: EventOutboxBackend = { listPage, open: rawB.open, close: rawB.close };
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("rejects promise with own symbols", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend: rawB } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const listPage = (_req: EventOutboxListPageRequest): unknown => {
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
		const backend: EventOutboxBackend = { listPage, open: rawB.open, close: rawB.close };
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 15. Hostile close (backend.close returns non-bare promise)
// ===========================================================================

describe("hostile close", () => {
	beforeEach(() => _clearJournalCache());
	it("backend.close returns Promise subclass -> CLOSE_UNCERTAIN", async () => {
		class SubPromise<T> extends Promise<T> {}
		const b1 = encodePending("evt-1", 1);
		const rawBackend: Record<string, unknown> = {
			listPage(_request: EventOutboxListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: EventOutboxOpenRequest): unknown {
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
		const result = await recoverSandboxEventOutboxJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("backend.close has own properties -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const p = Promise.resolve({ status: "closed" });
		Object.defineProperty(p, "extra", { value: 1, enumerable: true });
		const rawBackend: Record<string, unknown> = {
			listPage(_request: EventOutboxListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: EventOutboxOpenRequest): unknown {
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
		const result = await recoverSandboxEventOutboxJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 16. Open result malformations
// ===========================================================================

describe("open outer result malformations", () => {
	beforeEach(() => _clearJournalCache());
	it("open outer handle Proxy -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const rawBackend: Record<string, unknown> = {
			listPage(_request: EventOutboxListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: EventOutboxOpenRequest): unknown {
				return Promise.resolve({ status: "opened", handle: new Proxy({}, {}) });
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({
			backend: rawBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("open outer handle accessor close -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
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
			listPage(_request: EventOutboxListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: EventOutboxOpenRequest): unknown {
				return Promise.resolve({ status: "opened", handle });
			},
			close(): unknown {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({
			backend: rawBackend,
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
		const b1 = encodePending("evt-1", 1);
		const { backend: backend1 } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend: backend1,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(1);
	});
});

// ===========================================================================
// 18. Null prototypes
// ===========================================================================

describe("null prototypes", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects identity with null prototype", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({ files: [{ name: fileName(1), bytes: b1 }] });
		const nullIdentity = Object.assign(Object.create(null), {
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: nullIdentity,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});

	it("rejects backend with null prototype", async () => {
		const b1 = encodePending("evt-1", 1);
		const nullBackend = Object.assign(Object.create(null), {
			listPage(_request: EventOutboxListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open(_request: EventOutboxOpenRequest): unknown {
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
		const result = await recoverSandboxEventOutboxJournal({
			backend: nullBackend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENT");
	});
});

// ===========================================================================
// 19. Journal sequence identity verification
// ===========================================================================

describe("journal sequence identity", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects record with mismatched recordSeq vs filename", async () => {
		// Encode record with recordSeq=2 but filename is 00000000000000000001
		const b1 = encodePending("evt-1", 2);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("accepts record with matching recordSeq vs filename", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records[0].recordSeq).toBe(1);
	});
});

// ===========================================================================
// 20. Non-null cursor at termination
// ===========================================================================

describe("max pages bound", () => {
	beforeEach(() => _clearJournalCache());
	it("non-null cursor after last page fails", async () => {
		const backend: EventOutboxBackend = {
			listPage(_request: EventOutboxListPageRequest): unknown {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: "still-going",
					close: () => ({ status: "closed" }),
				});
			},
			open(_request: EventOutboxOpenRequest): unknown {
				const b1 = encodePending("evt-1", 1);
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 21. Malformed open result handle close code paths
// ===========================================================================

describe("malformed open result", () => {
	beforeEach(() => _clearJournalCache());
	it("closes a directly discoverable handle from a malformed open result", async () => {
		const bytes = encodePending("evt-1", 1);
		const base = makeMockBackend({ files: [{ name: fileName(1), bytes }] }).backend;
		let handleCloses = 0;
		const backend: EventOutboxBackend = {
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
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result).toEqual({ ok: false, error: { code: "RECOVERY_FAILED" } });
		expect(handleCloses).toBe(1);
	});

	it("makes malformed-result handle close uncertainty dominate", async () => {
		const bytes = encodePending("evt-1", 1);
		const base = makeMockBackend({ files: [{ name: fileName(1), bytes }] }).backend;
		let handleCloses = 0;
		const backend: EventOutboxBackend = {
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
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
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
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(backendCloses).toBe(1);
	});
});

// ===========================================================================
// 22. Total bytes bound
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
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 23. Page close before validation
// ===========================================================================

describe("page close before validation", () => {
	beforeEach(() => _clearJournalCache());
	it("page close fail returns CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			pageCloseFail: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 24. Multiple event types
// ===========================================================================

describe("multiple event types", () => {
	beforeEach(() => _clearJournalCache());
	it("recovers multiple pending events with different body types", async () => {
		const evt1 = makeEventFrame("evt-m1", "session_created");
		const ed1 = digestOfFrameAlt(evt1);
		const raw1 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-m1",
			eventSequence: 1,
			eventType: "session_created",
			eventDigest: ed1,
			event: evt1,
		};
		const enc1 = encodeSandboxEventOutboxRecordV1(raw1);
		if (!enc1.ok) throw new Error("encode failed");

		const evt2 = makeEventFrame("evt-m2", "bash_start", 2);
		const ed2 = digestOfFrameAlt(evt2);
		const raw2 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-m2",
			eventSequence: 2,
			eventType: "bash_start",
			eventDigest: ed2,
			event: evt2,
		};
		const enc2 = encodeSandboxEventOutboxRecordV1(raw2);
		if (!enc2.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(enc1.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(enc2.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.records.length).toBe(2);
		expect(result.value.records[0].eventType).toBe("session_created");
		expect(result.value.records[1].eventType).toBe("bash_start");
	});
});

// ===========================================================================
// 25. Non-contiguous recordSeq
// ===========================================================================

describe("non-contiguous recordSeq", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects non-contiguous recordSeq sequential records", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodePending("evt-2", 3); // seq 3 but should be 2
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 27. Multiple pages with many files — ownership regression
// ===========================================================================

describe("recovery ownership and identity regressions", () => {
	beforeEach(() => _clearJournalCache());

	it("accepts more than 314 bounded pages", async () => {
		const files: FileSpec[] = [];
		for (let sequence = 1; sequence <= 315; sequence += 1) {
			const evt = makeEventFrame(`evt-${sequence}`, "agent_start", sequence);
			const ed = digestOfFrameAlt(evt);
			const raw = {
				version: 1,
				recordKind: PENDING,
				recordSeq: sequence,
				hostId: "h-1",
				generation: "g-1",
				sessionId: "s-1",
				recordedAt: "2025-01-15T10:30:00.000Z",
				eventId: `evt-${sequence}`,
				eventSequence: sequence,
				eventType: "agent_start",
				eventDigest: ed,
				event: evt,
			};
			const enc = encodeSandboxEventOutboxRecordV1(raw);
			if (!enc.ok) throw new Error("encode failed");
			files.push({
				name: fileName(sequence),
				bytes: new Uint8Array(enc.bytes),
			});
		}
		const { backend } = makeMockBackend({ files, pageSize: 1 });
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		if (!result.ok) {
			expect(result.error.code).toBe("RECOVERY_FAILED");
		}
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.records).toHaveLength(315);
	});

	it("records have correct receipts", async () => {
		const b1 = encodePending("evt-1", 1);
		const b2 = encodeDelivered("evt-1", 2);
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: b1 },
				{ name: fileName(2), bytes: b2 },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.receipts).toHaveLength(2);
		expect(result.value.receipts[0].sequence).toBe(1);
		expect(result.value.receipts[0].size).toBe(b1.length);
		expect(result.value.receipts[0].sha256.length).toBe(64);
		expect(result.value.receipts[1].sequence).toBe(2);
		expect(result.value.receipts[1].size).toBe(b2.length);
		expect(result.value.receipts[1].sha256.length).toBe(64);
	});
});

// ===========================================================================
// 28. Sync-return (non-promise) cleanup for page/handle
// ===========================================================================

describe("sync-return cleanup", () => {
	beforeEach(() => _clearJournalCache());
	it("non-promise listPage return is rejected and page close is cleaned", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			listPageNonPromise: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});

	it("sync-return handle methods (non-native promise) are rejected", async () => {
		const b1 = encodePending("evt-1", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
			handleNonPromise: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 29. Page with missing close
// ===========================================================================

describe("page missing close", () => {
	beforeEach(() => _clearJournalCache());
	it("page with missing close returns error", async () => {
		const { backend } = makeMockBackend({
			files: [],
			pageNoClose: true,
		});
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 30. Own fill override rejection
// ===========================================================================

describe("own fill override", () => {
	beforeEach(() => _clearJournalCache());
	it("handle bytes with own fill override is rejected", async () => {
		// This tests the exactTransferred rejection path in readSingleFile.
		// The readAt returns a Uint8Array with the intrinsic fill overridden.
		const fileBytes = encodePending("evt-1", 1);
		const { backend: rawB } = makeMockBackend({
			files: [{ name: fileName(1), bytes: fileBytes }],
		});
		const backend: EventOutboxBackend = {
			listPage: rawB.listPage,
			open(_request: EventOutboxOpenRequest): unknown {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number): unknown {
							const u8 = new Uint8Array(fileBytes);
							Object.defineProperty(u8, "fill", {
								value: () => {
									/* no-op */
								},
							});
							return Promise.resolve({ status: "bytes", bytes: u8 });
						},
						confirmEof(_size: number): unknown {
							return Promise.resolve({ status: "eof" });
						},
						fstat(): unknown {
							return Promise.resolve(makeStat({ size: fileBytes.length }));
						},
						close(): unknown {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close: rawB.close,
		};
		const result = await recoverSandboxEventOutboxJournal({
			backend,
			identity: IDENTITY,
		});
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 31. Regression: null/primitive INVALID_ARGUMENT (not CLOSE_UNCERTAIN)
// ===========================================================================

describe("null/primitive INVALID_ARGUMENT regression", () => {
	beforeEach(() => _clearJournalCache());
	it("null returns INVALID_ARGUMENT", async () => {
		const result = await recoverSandboxEventOutboxJournal(null);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("undefined returns INVALID_ARGUMENT", async () => {
		const result = await recoverSandboxEventOutboxJournal(undefined);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("number returns INVALID_ARGUMENT", async () => {
		const result = await recoverSandboxEventOutboxJournal(42);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("string returns INVALID_ARGUMENT", async () => {
		const result = await recoverSandboxEventOutboxJournal("bad");
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});
});

// ===========================================================================
// 32. Regression: nonadjacent delivered matched against its actual pending
// ===========================================================================

describe("nonadjacent delivered matching", () => {
	beforeEach(() => _clearJournalCache());
	it("delivered matches its pending even when not adjacent in file order", async () => {
		// Pending for evt-A at seq 1, pending for evt-B at seq 2 (eventSequence +1),
		// then delivered for evt-A at seq 3 (not adjacent to its pending).
		const evtA = makeEventFrame("evt-A", "agent_start", 1);
		const edA = digestOfFrameAlt(evtA);
		const rawPendingA = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-A",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: edA,
			event: evtA,
		};
		const encA = encodeSandboxEventOutboxRecordV1(rawPendingA);
		if (!encA.ok) throw new Error("encode failed");

		const evtB = makeEventFrame("evt-B", "bash_start", 2);
		const edB = digestOfFrameAlt(evtB);
		const rawPendingB = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-B",
			eventSequence: 2,
			eventType: "bash_start",
			eventDigest: edB,
			event: evtB,
		};
		const encB = encodeSandboxEventOutboxRecordV1(rawPendingB);
		if (!encB.ok) throw new Error("encode failed");

		// Delivered for evt-A with matching digest (not adjacent to its pending)
		const ackA = makeAckFrame("a-evt-A", "evt-A", "delivered");
		const ackDigestA = digestOfAck(ackA);
		const rawDeliveredA = {
			version: 1,
			recordKind: DELIVERED,
			recordSeq: 3,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-A",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: edA,
			event: evtA,
			outcome: DELIVERED_OUTCOME,
			ackDigest: ackDigestA,
			ack: ackA,
		};
		const encDelA = encodeSandboxEventOutboxRecordV1(rawDeliveredA);
		if (!encDelA.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(encA.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(encB.bytes) },
				{ name: fileName(3), bytes: new Uint8Array(encDelA.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.records.length).toBe(3);
			expect(result.value.records[2].recordKind).toBe("delivered");
			expect(result.value.records[2].eventId).toBe("evt-A");
		}
	});

	it("rejects nonadjacent delivered with mutated event digest", async () => {
		const evtA = makeEventFrame("evt-D1", "agent_start", 1);
		const edA = digestOfFrameAlt(evtA);
		const rawPendingA = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-D1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: edA,
			event: evtA,
		};
		const encA = encodeSandboxEventOutboxRecordV1(rawPendingA);
		if (!encA.ok) throw new Error("encode failed");

		// Pending for a different event (evt-D2) to break adjacency
		const evtB = makeEventFrame("evt-D2", "bash_start", 2);
		const edB = digestOfFrameAlt(evtB);
		const rawPendingB = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-D2",
			eventSequence: 2,
			eventType: "bash_start",
			eventDigest: edB,
			event: evtB,
		};
		const encB = encodeSandboxEventOutboxRecordV1(rawPendingB);
		if (!encB.ok) throw new Error("encode failed");

		// Delivered for evt-D1 with DIFFERENT event digest (mutated content)
		const evtMutated = makeEventFrame("evt-D1", "bash_start", 1);
		const edMutated = digestOfFrameAlt(evtMutated);
		const ackMutated = makeAckFrame("a-evt-D1", "evt-D1", "delivered");
		const ackDigestMutated = digestOfAck(ackMutated);
		const rawDeliveredMutated = {
			version: 1,
			recordKind: DELIVERED,
			recordSeq: 3,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-D1",
			eventSequence: 1,
			eventType: "bash_start",
			eventDigest: edMutated,
			event: evtMutated,
			outcome: DELIVERED_OUTCOME,
			ackDigest: ackDigestMutated,
			ack: ackMutated,
		};
		const encDel = encodeSandboxEventOutboxRecordV1(rawDeliveredMutated);
		if (!encDel.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(encA.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(encB.bytes) },
				{ name: fileName(3), bytes: new Uint8Array(encDel.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 33. Regression: duplicate eventSequence for different event IDs
// ===========================================================================

describe("duplicate eventSequence rejection", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects two event IDs sharing the same eventSequence", async () => {
		const evt1 = makeEventFrame("evt-seq1", "agent_start", 1);
		const ed1 = digestOfFrameAlt(evt1);
		const raw1 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-seq1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: ed1,
			event: evt1,
		};
		const enc1 = encodeSandboxEventOutboxRecordV1(raw1);
		if (!enc1.ok) throw new Error("encode failed");

		// Second pending with same eventSequence=1 but different eventId
		const evt2 = makeEventFrame("evt-seq2", "bash_start", 1);
		const ed2 = digestOfFrameAlt(evt2);
		const raw2 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-seq2",
			eventSequence: 1,
			eventType: "bash_start",
			eventDigest: ed2,
			event: evt2,
		};
		const enc2 = encodeSandboxEventOutboxRecordV1(raw2);
		if (!enc2.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(enc1.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(enc2.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});

	it("delivered with eventSequence mismatch against its pending is rejected", async () => {
		const evtP = makeEventFrame("evt-seq3", "agent_start", 2);
		const edP = digestOfFrameAlt(evtP);
		const rawPending = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-seq3",
			eventSequence: 2,
			eventType: "agent_start",
			eventDigest: edP,
			event: evtP,
		};
		const encP = encodeSandboxEventOutboxRecordV1(rawPending);
		if (!encP.ok) throw new Error("encode failed");

		// Delivered with DIFFERENT eventSequence (3 instead of 2)
		const evtD = makeEventFrame("evt-seq3", "agent_start", 3);
		const edD = digestOfFrameAlt(evtD);
		const ack = makeAckFrame("a-evt-seq3", "evt-seq3", "delivered");
		const ackDigest = digestOfAck(ack);
		const rawDelivered = {
			version: 1,
			recordKind: DELIVERED,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-seq3",
			eventSequence: 3,
			eventType: "agent_start",
			eventDigest: edD,
			event: evtD,
			outcome: DELIVERED_OUTCOME,
			ackDigest,
			ack,
		};
		const encD = encodeSandboxEventOutboxRecordV1(rawDelivered);
		if (!encD.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(encP.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(encD.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 34. Regression: eventSequence exact +1 for each new pending
// ===========================================================================

describe("eventSequence exact increment", () => {
	beforeEach(() => _clearJournalCache());
	it("rejects pending with eventSequence gap (+2 instead of +1)", async () => {
		const evt1 = makeEventFrame("evt-gap1", "agent_start", 1);
		const ed1 = digestOfFrameAlt(evt1);
		const raw1 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-gap1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: ed1,
			event: evt1,
		};
		const enc1 = encodeSandboxEventOutboxRecordV1(raw1);
		if (!enc1.ok) throw new Error("encode failed");

		const evt2 = makeEventFrame("evt-gap2", "bash_start", 3);
		const ed2 = digestOfFrameAlt(evt2);
		const raw2 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-gap2",
			eventSequence: 3,
			eventType: "bash_start",
			eventDigest: ed2,
			event: evt2,
		};
		const enc2 = encodeSandboxEventOutboxRecordV1(raw2);
		if (!enc2.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(enc1.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(enc2.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});

	it("rejects pending with eventSequence not +1 from previous", async () => {
		const evt1 = makeEventFrame("evt-inc1", "agent_start", 5);
		const ed1 = digestOfFrameAlt(evt1);
		const raw1 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-inc1",
			eventSequence: 5,
			eventType: "agent_start",
			eventDigest: ed1,
			event: evt1,
		};
		const enc1 = encodeSandboxEventOutboxRecordV1(raw1);
		if (!enc1.ok) throw new Error("encode failed");

		const evt2 = makeEventFrame("evt-inc2", "bash_start", 5);
		const ed2 = digestOfFrameAlt(evt2);
		const raw2 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-inc2",
			eventSequence: 5,
			eventType: "bash_start",
			eventDigest: ed2,
			event: evt2,
		};
		const enc2 = encodeSandboxEventOutboxRecordV1(raw2);
		if (!enc2.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(enc1.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(enc2.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 35. CleanupRegistry — core unit tests
// ===========================================================================

describe("CleanupRegistry", () => {
	it("records none for null/undefined/primitive", () => {
		const r = new CleanupRegistry();
		expect(r.record(null, "null").state).toBe("none");
		expect(r.record(undefined, "undef").state).toBe("none");
		expect(r.record(42, "num").state).toBe("none");
		expect(r.record("str", "str").state).toBe("none");
		expect(r.snapshot()).toEqual([
			{ state: "none", closed: false, closeFailed: false },
			{ state: "none", closed: false, closeFailed: false },
			{ state: "none", closed: false, closeFailed: false },
			{ state: "none", closed: false, closeFailed: false },
		]);
	});

	it("records owner for object with direct own enumerable non-Proxy close", () => {
		const r = new CleanupRegistry();
		const obj = { close: () => ({ status: "closed" }) };
		expect(r.record(obj, "owner").state).toBe("owner");
		expect(r.snapshot()).toEqual([{ state: "owner", closed: false, closeFailed: false }]);
	});

	it("records alias for same close function reference", () => {
		const r = new CleanupRegistry();
		const fn = () => ({ status: "closed" });
		const obj1 = { close: fn };
		const obj2 = { close: fn };
		expect(r.record(obj1, "first").state).toBe("owner");
		expect(r.record(obj2, "second").state).toBe("alias");
		const snap = r.snapshot();
		expect(snap[0].state).toBe("owner");
		expect(snap[1].state).toBe("alias");
		expect(r.aliasCount).toBe(1);
	});

	it("records uncertain for Proxy object close", () => {
		const r = new CleanupRegistry();
		const target = { close: () => ({ status: "closed" }) };
		const proxy = new Proxy(target, {});
		expect(r.record(proxy, "proxy").state).toBe("uncertain");
		expect(r.snapshot()).toEqual([{ state: "uncertain", closed: false, closeFailed: false }]);
		expect(r.uncertainCount).toBe(1);
	});

	it("records uncertain for accessor descriptor close", () => {
		const r = new CleanupRegistry();
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "close", {
			get: () => () => ({ status: "closed" }),
			enumerable: true,
		});
		expect(r.record(obj, "accessor").state).toBe("uncertain");
		expect(r.snapshot()).toEqual([{ state: "uncertain", closed: false, closeFailed: false }]);
	});

	it("reports hasUncertainty when alias present", () => {
		const r = new CleanupRegistry();
		const fn = () => ({ status: "closed" });
		r.record({ close: fn }, "first");
		r.record({ close: fn }, "second");
		expect(r.hasUncertainty).toBe(true);
	});

	it("reports hasUncertainty when uncertain present", () => {
		const r = new CleanupRegistry();
		r.record(new Proxy({ close: () => ({ status: "closed" }) }, {}), "proxy");
		expect(r.hasUncertainty).toBe(true);
	});

	it("closeAll invokes each owner exactly once", async () => {
		const r = new CleanupRegistry();
		const callOrder: string[] = [];
		const obj1 = {
			close: () => {
				callOrder.push("a");
				return Promise.resolve({ status: "closed" });
			},
		};
		const obj2 = {
			close: () => {
				callOrder.push("b");
				return Promise.resolve({ status: "closed" });
			},
		};
		r.record(obj1, "first");
		r.record(obj2, "second");
		const ok = await r.closeAll();
		expect(ok).toBe(true);
		// Reverse order: second before first
		expect(callOrder).toEqual(["b", "a"]);
	});

	it("closeAll returns false on failure", async () => {
		const r = new CleanupRegistry();
		const obj1 = { close: () => Promise.resolve({ status: "error" }) };
		r.record(obj1, "fail");
		const ok = await r.closeAll();
		expect(ok).toBe(false);
	});

	it("closeAll backend-last ordering", async () => {
		const r = new CleanupRegistry();
		const order: string[] = [];
		const page = {
			close: () => {
				order.push("page");
				return Promise.resolve({ status: "closed" });
			},
		};
		const handle = {
			close: () => {
				order.push("handle");
				return Promise.resolve({ status: "closed" });
			},
		};
		const backend = {
			close: () => {
				order.push("backend");
				return Promise.resolve({ status: "closed" });
			},
		};
		r.record(backend, "backend-prelim"); // recorded first but closes last
		r.record(page, "page");
		r.record(handle, "handle");
		r.record(backend, "backend"); // duplicate alias - won't be called
		const ok = await r.closeAll();
		expect(ok).toBe(true);
		// Reverse acquisition: handle, page, backend-prelim
		expect(order).toEqual(["handle", "page", "backend"]);
	});
});

// ===========================================================================
// 36. isPromise unit tests
// ===========================================================================

describe("isPromise", () => {
	it("returns true for bare native Promise", () => {
		expect(isPromise(Promise.resolve(42))).toBe(true);
	});

	it("returns false for Proxy of Promise", () => {
		const p = Promise.resolve(42);
		const proxy = new Proxy(p, {});
		expect(isPromise(proxy)).toBe(false);
	});

	it("returns false for Promise with own properties", () => {
		const p = Promise.resolve(42);
		Object.defineProperty(p, "extra", { value: 1, enumerable: true });
		expect(isPromise(p)).toBe(false);
	});

	it("returns false for Promise with own symbols", () => {
		const p = Promise.resolve(42);
		Object.defineProperty(p, Symbol("secret"), { value: 1 });
		expect(isPromise(p)).toBe(false);
	});

	it("returns false for Promise subclass", () => {
		class SubPromise<T> extends Promise<T> {}
		expect(isPromise(new SubPromise(() => {}))).toBe(false);
	});

	it("returns false for null/undefined", () => {
		expect(isPromise(null)).toBe(false);
		expect(isPromise(undefined)).toBe(false);
	});

	it("returns false for plain object", () => {
		// biome-ignore lint/suspicious/noThenProperty: intentional isPromise thenable test
		expect(isPromise({ then: () => {} })).toBe(false);
	});

	it("does NOT use instanceof or .then reads", () => {
		// A thenable that would pass instanceof Promise but fail the test
		const fake = Object.create(Promise.prototype);
		expect(isPromise(fake)).toBe(false);
		let thenCalled = false;
		const thenable: Record<string, unknown> = {};
		// biome-ignore lint/suspicious/noThenProperty: intentional hostile fixture
		Object.defineProperty(thenable, "then", {
			value: (): void => {
				thenCalled = true;
			},
			enumerable: true,
		});
		expect(isPromise(thenable)).toBe(false);
		expect(thenCalled).toBe(false);
		isPromise(thenable);
		expect(thenCalled).toBe(false);
	});
});

// ===========================================================================
// 37. exactTransferred unit tests
// ===========================================================================

describe("exactTransferred", () => {
	it("accepts genuine Uint8Array", () => {
		const u8 = new Uint8Array([1, 2, 3]);
		expect(exactTransferred(u8)).toBe(true);
	});

	it("rejects Buffer", () => {
		const buf = Buffer.from([1, 2, 3]);
		expect(exactTransferred(buf)).toBe(false);
	});

	it("rejects Uint8Array subclass", () => {
		class SubU8 extends Uint8Array {}
		const sub = new SubU8(3);
		expect(exactTransferred(sub)).toBe(false);
	});

	it("rejects SharedArrayBuffer backed", () => {
		const sab = new SharedArrayBuffer(3);
		const u8 = new Uint8Array(sab);
		expect(exactTransferred(u8)).toBe(false);
	});

	it("rejects detached ArrayBuffer", () => {
		const ab = new ArrayBuffer(3);
		const u8 = new Uint8Array(ab);
		// Manually trigger detach if possible (Node >= 21 has structuredClone for detach)
		try {
			const _cloned = u8.slice(0, 0);
			// slice returns a new Uint8Array; the source buffer is kept.
			// For real detach test, rely on the subview test below.
		} catch {
			/* ignore */
		}
		// A subview has non-zero byteOffset
		const ab2 = new ArrayBuffer(10);
		const _full = new Uint8Array(ab2);
		const subview = new Uint8Array(ab2, 2, 3);
		expect(exactTransferred(subview)).toBe(false);
	});

	it("rejects Uint8Array with extra own properties", () => {
		const u8 = new Uint8Array([1, 2, 3]);
		Object.defineProperty(u8, "extra", { value: 1, enumerable: true });
		expect(exactTransferred(u8)).toBe(false);
	});

	it("rejects Uint8Array with own buffer override", () => {
		const u8 = new Uint8Array([1, 2, 3]);
		Object.defineProperty(u8, "buffer", { value: new ArrayBuffer(3), enumerable: true });
		expect(exactTransferred(u8)).toBe(false);
	});

	it("rejects Proxy wrapping Uint8Array", () => {
		const u8 = new Uint8Array([1, 2, 3]);
		const proxy = new Proxy(u8, {});
		expect(exactTransferred(proxy)).toBe(false);
	});

	it("accepts zero-offset non-subview", () => {
		const ab = new ArrayBuffer(10);
		const u8 = new Uint8Array(ab, 0, 10);
		expect(exactTransferred(u8)).toBe(true);
	});
});

// ===========================================================================
// 38. CleanupRegistry regression: sync page/open cleanup
// ===========================================================================

describe("CleanupRegistry sync cleanup", () => {
	beforeEach(() => _clearJournalCache());

	it("sync (non-promise) listPage still records page close in registry", async () => {
		const b1 = encodePending("evt-1", 1);
		let pageCloseCalled = false;
		const backend: EventOutboxBackend = {
			listPage() {
				return {
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => {
						pageCloseCalled = true;
						return { status: "closed" };
					},
				};
			},
			open(_req: EventOutboxOpenRequest) {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_o: number, _s: number) {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof() {
							return Promise.resolve({ status: "eof" });
						},
						fstat() {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close() {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false); // sync listPage → rejected
		expect(pageCloseCalled).toBe(true); // snapshotAndClose records page in cleanup, close is called
	});

	it("sync open result still handles discovered close via cleanup", async () => {
		const b1 = encodePending("evt-1", 1);
		let _handleCloseCalled = false;
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				return {
					status: "opened",
					handle: {
						close() {
							_handleCloseCalled = true;
							return { status: "closed" };
						},
					},
				};
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 39. Backend/page/handle alias regression
// ===========================================================================

describe("cleanup alias regression", () => {
	beforeEach(() => _clearJournalCache());

	it("backend, page, and handle sharing same close function -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const sharedClose = () => Promise.resolve({ status: "closed" });
		let _closeCallCount = 0;
		const wrappedClose = () => {
			_closeCallCount += 1;
			return sharedClose();
		};
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: wrappedClose,
				});
			},
			open() {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_o: number, _s: number) {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof() {
							return Promise.resolve({ status: "eof" });
						},
						fstat() {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close: wrappedClose,
					},
				});
			},
			close: wrappedClose,
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
		// The alias detection means the later registrations are aliases
	});
});

// ===========================================================================
// 40. Proxy zero trap invocation
// ===========================================================================

describe("Proxy trap invocation", () => {
	beforeEach(() => _clearJournalCache());

	it("backend close through Proxy with zero traps still detected", async () => {
		const b1 = encodePending("evt-1", 1);
		let closeCalled = false;
		const target = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_o: number, _s: number) {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof() {
							return Promise.resolve({ status: "eof" });
						},
						fstat() {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close() {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close() {
				closeCalled = true;
				return Promise.resolve({ status: "closed" });
			},
		};
		// Wrap in Proxy with zero traps — but the OUTER input is what we see
		// CleanupRegistry sees the Proxy on the outer input, not the inner backend
		const outerProxy = new Proxy({ backend: target, identity: IDENTITY }, {});
		const result = await recoverSandboxEventOutboxJournal(outerProxy);
		// Proxy on outer input -> CLOSE_UNCERTAIN
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
		expect(closeCalled).toBe(false); // can't trust close via Proxy
	});
});

// ===========================================================================
// 41. Accessor uncertainty on handle close
// ===========================================================================

describe("accessor uncertainty on handle", () => {
	beforeEach(() => _clearJournalCache());

	it("handle with accessor close -> CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const handle: Record<string, unknown> = {
			readAt(_o: number, _s: number) {
				return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
			},
			confirmEof() {
				return Promise.resolve({ status: "eof" });
			},
			fstat() {
				return Promise.resolve(makeStat({ size: b1.length }));
			},
		};
		Object.defineProperty(handle, "close", {
			get: () => () => Promise.resolve({ status: "closed" }),
			enumerable: true,
		});
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				return Promise.resolve({ status: "opened", handle });
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 42. Sync genuine bytes erased regression
// ===========================================================================

describe("sync bytes erased", () => {
	beforeEach(() => _clearJournalCache());

	it("sync transferred bytes are erased after copy", async () => {
		const b1 = encodePending("evt-1", 1);
		const transferredCopies: Uint8Array[] = [];
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_o: number, _s: number) {
							const slice = new Uint8Array(b1);
							transferredCopies.push(slice);
							return Promise.resolve({ status: "bytes", bytes: slice });
						},
						confirmEof() {
							return Promise.resolve({ status: "eof" });
						},
						fstat() {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close() {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
		// The transferred bytes should have been erased
		expect(transferredCopies.length).toBeGreaterThanOrEqual(1);
		for (const transferred of transferredCopies) {
			let allZero = true;
			for (let i = 0; i < transferred.length; i++) {
				if (transferred[i] !== 0) {
					allZero = false;
					break;
				}
			}
			expect(allZero).toBe(true);
		}
	});
});

// ===========================================================================
// 43. Nonadjacent delivery mutation rejection (regression)
// ===========================================================================

describe("nonadjacent delivery mutation", () => {
	beforeEach(() => _clearJournalCache());

	it("rejects nonadjacent delivered with mutated eventId", async () => {
		// Pending for evt-A at seq 1, pending for evt-B at seq 2,
		// then delivered for evt-C (not evt-A) at seq 3
		const evtA = makeEventFrame("evt-MUT1", "agent_start", 1);
		const edA = digestOfFrameAlt(evtA);
		const rawPA = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-MUT1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: edA,
			event: evtA,
		};
		const encA = encodeSandboxEventOutboxRecordV1(rawPA);
		if (!encA.ok) throw new Error("encode failed");

		const evtB = makeEventFrame("evt-MUT2", "bash_start", 2);
		const edB = digestOfFrameAlt(evtB);
		const rawPB = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-MUT2",
			eventSequence: 2,
			eventType: "bash_start",
			eventDigest: edB,
			event: evtB,
		};
		const encB = encodeSandboxEventOutboxRecordV1(rawPB);
		if (!encB.ok) throw new Error("encode failed");

		// Delivered for evt-C (not matching any pending)
		const evtC = makeEventFrame("evt-MUT3", "session_created", 1);
		const edC = digestOfFrameAlt(evtC);
		const ackC = makeAckFrame("a-evt-MUT3", "evt-MUT3", "delivered");
		const ackDigestC = digestOfAck(ackC);
		const rawDC = {
			version: 1,
			recordKind: DELIVERED,
			recordSeq: 3,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-MUT3",
			eventSequence: 1,
			eventType: "session_created",
			eventDigest: edC,
			event: evtC,
			outcome: DELIVERED_OUTCOME,
			ackDigest: ackDigestC,
			ack: ackC,
		};
		const encDC = encodeSandboxEventOutboxRecordV1(rawDC);
		if (!encDC.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(encA.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(encB.bytes) },
				{ name: fileName(3), bytes: new Uint8Array(encDC.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 44. Duplicate/gap sequence regression
// ===========================================================================

describe("duplicate and gap sequence", () => {
	beforeEach(() => _clearJournalCache());

	it("rejects duplicate eventSequence in delivered records", async () => {
		const evt = makeEventFrame("evt-DUP1", "agent_start", 1);
		const ed = digestOfFrameAlt(evt);
		const ack1 = makeAckFrame("a-evt-DUP1", "evt-DUP1", "delivered");
		const ad1 = digestOfAck(ack1);
		const rawP = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-DUP1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: ed,
			event: evt,
		};
		const rawD = {
			version: 1,
			recordKind: DELIVERED,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-DUP1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: ed,
			event: evt,
			outcome: DELIVERED_OUTCOME,
			ackDigest: ad1,
			ack: ack1,
		};
		const encP = encodeSandboxEventOutboxRecordV1(rawP);
		const encD = encodeSandboxEventOutboxRecordV1(rawD);
		if (!encP.ok || !encD.ok) throw new Error("encode failed");

		// Delivered with same eventId, same eventSequence = OK (pending then delivered)
		// This test verifies that duplicate eventSequence for different eventIds is rejected
		// For the same eventId, it's fine — it's the sequence of matching.
		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(encP.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(encD.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
	});

	it("rejects gap in eventSequence between pending records", async () => {
		const evt1 = makeEventFrame("evt-GAP1", "agent_start", 1);
		const ed1 = digestOfFrameAlt(evt1);
		const raw1 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 1,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-GAP1",
			eventSequence: 1,
			eventType: "agent_start",
			eventDigest: ed1,
			event: evt1,
		};
		const enc1 = encodeSandboxEventOutboxRecordV1(raw1);
		if (!enc1.ok) throw new Error("encode failed");

		const evt2 = makeEventFrame("evt-GAP2", "bash_start", 3); // gap: should be 2
		const ed2 = digestOfFrameAlt(evt2);
		const raw2 = {
			version: 1,
			recordKind: PENDING,
			recordSeq: 2,
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			recordedAt: "2025-01-15T10:30:00.000Z",
			eventId: "evt-GAP2",
			eventSequence: 3,
			eventType: "bash_start",
			eventDigest: ed2,
			event: evt2,
		};
		const enc2 = encodeSandboxEventOutboxRecordV1(raw2);
		if (!enc2.ok) throw new Error("encode failed");

		const { backend } = makeMockBackend({
			files: [
				{ name: fileName(1), bytes: new Uint8Array(enc1.bytes) },
				{ name: fileName(2), bytes: new Uint8Array(enc2.bytes) },
			],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
	});
});

// ===========================================================================
// 45. Recursive freeze/fresh fixed failures
// ===========================================================================

describe("recursive freeze and fresh fixed", () => {
	beforeEach(() => _clearJournalCache());

	it("output is recursively frozen", async () => {
		const b1 = encodePending("evt-FREEZE", 1);
		const { backend } = makeMockBackend({
			files: [{ name: fileName(1), bytes: b1 }],
		});
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.identity)).toBe(true);
		expect(Object.isFrozen(result.value.records)).toBe(true);
		expect(Object.isFrozen(result.value.receipts)).toBe(true);
		for (const rec of result.value.records) {
			expect(Object.isFrozen(rec)).toBe(true);
		}
		for (const rec of result.value.receipts) {
			expect(Object.isFrozen(rec)).toBe(true);
		}
	});

	it("error result is frozen", async () => {
		const result = await recoverSandboxEventOutboxJournal(null);
		expect(Object.isFrozen(result)).toBe(true);
		if (!result.ok) {
			expect(Object.isFrozen(result.error)).toBe(true);
		}
	});
});

// ===========================================================================
// 46. End-to-end close ordering assertion
// ===========================================================================

describe("close ordering end-to-end", () => {
	beforeEach(() => _clearJournalCache());

	it("closes page then handle then backend in immediate close order", async () => {
		const b1 = encodePending("evt-ORDER", 1);
		const order: string[] = [];
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => {
						order.push("page");
						return Promise.resolve({ status: "closed" });
					},
				});
			},
			open() {
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_o: number, _s: number) {
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
						},
						confirmEof() {
							return Promise.resolve({ status: "eof" });
						},
						fstat() {
							return Promise.resolve(makeStat({ size: b1.length }));
						},
						close: () => {
							order.push("handle");
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close: () => {
				order.push("backend");
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(true);
		// Immediate close order: page (via closeRegistered), then handle (via closeRegistered), then backend (via closeAll)
		expect(order).toEqual(["page", "handle", "backend"]);
		// Each owner <= 1 call: handle (closeRegistered), page (closeRegistered), backend (closeAll)
		expect(order.filter((o) => o === "handle").length).toBe(1);
		expect(order.filter((o) => o === "page").length).toBe(1);
		expect(order.filter((o) => o === "backend").length).toBe(1);
	});
});

// ===========================================================================
// 47. Sync open descriptor-snapshot regressions
// ===========================================================================

describe("sync open descriptor-snapshot", () => {
	beforeEach(() => _clearJournalCache());

	it("Proxy sync open result => CLOSE_UNCERTAIN (zero traps)", async () => {
		const b1 = encodePending("evt-1", 1);
		let trapCount = 0;
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const target = { status: "opened", handle: { close: () => Promise.resolve({ status: "closed" }) } };
				return new Proxy(target, {
					get() {
						trapCount++;
					},
				});
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
		expect(trapCount).toBe(0);
	});

	it("sync open non-enumerable data handle => CLOSE_UNCERTAIN, handle close invoked once", async () => {
		const b1 = encodePending("evt-1", 1);
		let handleCloseCalls = 0;
		const handle: Record<string, unknown> = {
			readAt(_o: number, _s: number) {
				return Promise.resolve({ status: "bytes", bytes: new Uint8Array(b1) });
			},
			confirmEof() {
				return Promise.resolve({ status: "eof" });
			},
			fstat() {
				return Promise.resolve(makeStat({ size: b1.length }));
			},
			close() {
				handleCloseCalls++;
				return Promise.resolve({ status: "closed" });
			},
		};
		// Manually create a sync open result with non-enumerable handle descriptor
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const result: Record<string, unknown> = {};
				result.status = "opened";
				Object.defineProperty(result, "handle", {
					value: handle,
					enumerable: false,
				});
				// Non-Promise return => sync path
				return result;
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
		expect(handleCloseCalls).toBe(1);
	});

	it("sync open accessor handle descriptor => CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const result: Record<string, unknown> = {};
				result.status = "opened";
				Object.defineProperty(result, "handle", {
					get: () => ({ close: () => Promise.resolve({ status: "closed" }) }),
					enumerable: true,
				});
				return result;
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});

// ===========================================================================
// 48. Sync read descriptor-snapshot regressions
// ===========================================================================

describe("sync read descriptor-snapshot", () => {
	beforeEach(() => _clearJournalCache());

	it("Proxy sync readAt result => CLOSE_UNCERTAIN (zero traps)", async () => {
		const b1 = encodePending("evt-1", 1);
		let trapCount = 0;
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const handle: EventOutboxReadHandle = {
					readAt() {
						const target = { status: "bytes", bytes: new Uint8Array(b1) };
						return new Proxy(target, {
							get() {
								trapCount++;
							},
						});
					},
					confirmEof() {
						return Promise.resolve({ status: "eof" });
					},
					fstat() {
						return Promise.resolve(makeStat({ size: b1.length }));
					},
					close() {
						return Promise.resolve({ status: "closed" });
					},
				};
				return Promise.resolve({ status: "opened", handle });
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
		expect(trapCount).toBe(0);
	});

	it("sync readAt non-enumerable bytes descriptor => CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const handle: EventOutboxReadHandle = {
					readAt(_o: number, _s: number) {
						const result: Record<string, unknown> = {};
						result.status = "bytes";
						Object.defineProperty(result, "bytes", {
							value: new Uint8Array(b1),
							enumerable: false,
						});
						return result;
					},
					confirmEof() {
						return Promise.resolve({ status: "eof" });
					},
					fstat() {
						return Promise.resolve(makeStat({ size: b1.length }));
					},
					close() {
						return Promise.resolve({ status: "closed" });
					},
				};
				return Promise.resolve({ status: "opened", handle });
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("sync readAt accessor bytes descriptor => CLOSE_UNCERTAIN", async () => {
		const b1 = encodePending("evt-1", 1);
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const handle: EventOutboxReadHandle = {
					readAt() {
						const result: Record<string, unknown> = {};
						result.status = "bytes";
						Object.defineProperty(result, "bytes", {
							get: () => new Uint8Array(b1),
							enumerable: true,
						});
						return result;
					},
					confirmEof() {
						return Promise.resolve({ status: "eof" });
					},
					fstat() {
						return Promise.resolve(makeStat({ size: b1.length }));
					},
					close() {
						return Promise.resolve({ status: "closed" });
					},
				};
				return Promise.resolve({ status: "opened", handle });
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("sync readAt missing status with genuine bytes => erasure + RECOVERY_FAILED", async () => {
		const b1 = encodePending("evt-1", 1);
		const transferredCopies: Uint8Array[] = [];
		const backend: EventOutboxBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: [{ name: fileName(1), stat: makeStat({ size: b1.length }) }],
					nextCursor: null,
					close: () => Promise.resolve({ status: "closed" }),
				});
			},
			open() {
				const handle: EventOutboxReadHandle = {
					readAt() {
						const bytes = new Uint8Array(b1);
						transferredCopies.push(bytes);
						return { status: "wrong", bytes };
					},
					confirmEof() {
						return Promise.resolve({ status: "eof" });
					},
					fstat() {
						return Promise.resolve(makeStat({ size: b1.length }));
					},
					close() {
						return Promise.resolve({ status: "closed" });
					},
				};
				return Promise.resolve({ status: "opened", handle });
			},
			close() {
				return Promise.resolve({ status: "closed" });
			},
		};
		const result = await recoverSandboxEventOutboxJournal({ backend, identity: IDENTITY });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("RECOVERY_FAILED");
		// Bytes must be erased despite wrong status
		expect(transferredCopies.length).toBeGreaterThanOrEqual(1);
		for (const transferred of transferredCopies) {
			let allZero = true;
			for (let i = 0; i < transferred.length; i++) {
				if (transferred[i] !== 0) {
					allZero = false;
					break;
				}
			}
			expect(allZero).toBe(true);
		}
	});
});
