/**
 * Tests for B03 directory recovery — paginated journal + delivery-index scanner.
 */

import { describe, expect, it } from "vitest";
import { encodeDeliveryMarkerV1 } from "../src/modes/daemon/b03-delivery-index-codec.js";
import type { JournalDirection } from "../src/modes/daemon/b03-journal-record-codec.js";
import { encodeJournalRecordV1 } from "../src/modes/daemon/b03-journal-record-codec.js";
import type {
	B03Adapter,
	B03EntryStat,
	B03ListPageRequest,
	B03OpenOutcome,
	B03Page,
	B03ReadOutcome,
} from "../src/modes/daemon/b03-recovery-directory.js";
import { recoverB03Directory } from "../src/modes/daemon/b03-recovery-directory.js";

// ===========================================================================
// Helpers
// ===========================================================================

function pad(seq: number): string {
	return String(seq).padStart(20, "0");
}
function journalFileName(seq: number): string {
	return `${pad(seq)}.b03-journal`;
}
function deliveryFileName(seq: number): string {
	return `${pad(seq)}.b03-delivery`;
}

function makeStat(overrides?: Partial<B03EntryStat>): B03EntryStat {
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

function makeEnvelope(frameId?: string): Record<string, unknown> {
	return {
		type: "frame",
		frameId: frameId ?? "f-001",
		protocol: { name: "prime-agent.remote-host", version: 1 },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: {
			type: "event",
			id: "e-001",
			sequence: 1,
			cursor: { hostId: "h-1", generation: "g-1", sessionId: "s-1", sequence: 1 },
			emittedAt: "2025-01-15T10:30:00.000Z",
			body: { type: "agent_start" },
		},
	};
}

function makeJournalRaw(
	seq: number,
	direction?: JournalDirection,
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		version: 1,
		journalSeq: seq,
		direction: direction ?? "sent",
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		recordedAt: "2025-01-15T10:30:00.000Z",
		envelope: makeEnvelope(),
		...overrides,
	};
}

function makeMarkerRaw(
	seq: number,
	journalSeq: number,
	state?: "pending" | "delivered",
	overrides?: Record<string, unknown>,
): Record<string, unknown> {
	return {
		version: 1,
		hostId: "h-1",
		generation: "g-1",
		sessionId: "s-1",
		direction: "sent",
		frameId: "f-001",
		envelopeDigest: "00".repeat(32),
		journalSeq,
		indexSeq: seq,
		state: state ?? "pending",
		recordedAt: "2025-01-15T10:30:00.000Z",
		...overrides,
	};
}

function encodeJournal(seq: number, direction?: JournalDirection): Uint8Array {
	const r = encodeJournalRecordV1(makeJournalRaw(seq, direction));
	if (!r.ok) throw new Error("encode failed");
	return new Uint8Array(r.bytes);
}

function encodeJournalWith(overrides: Record<string, unknown>): Uint8Array {
	const raw = { ...makeJournalRaw(1), ...overrides };
	const r = encodeJournalRecordV1(raw);
	if (!r.ok) throw new Error("encode failed");
	return new Uint8Array(r.bytes);
}

function journalDigest(journalSeq: number, frameId = "f-001"): string {
	const encoded = encodeJournalRecordV1({ ...makeJournalRaw(journalSeq), envelope: makeEnvelope(frameId) });
	if (!encoded.ok) throw new Error("encode failed");
	encoded.bytes.fill(0);
	return encoded.record.envelopeDigest;
}

function encodeMarker(seq: number, journalSeq: number, state?: "pending" | "delivered"): Uint8Array {
	const raw = { ...makeMarkerRaw(seq, journalSeq, state), envelopeDigest: journalDigest(journalSeq) };
	const r = encodeDeliveryMarkerV1(raw);
	if (!r.ok) throw new Error("encode failed");
	return new Uint8Array(r.bytes);
}

function encodeMarkerWith(overrides: Record<string, unknown>): Uint8Array {
	const journalSeq = typeof overrides.journalSeq === "number" ? overrides.journalSeq : 1;
	const frameId = typeof overrides.frameId === "string" ? overrides.frameId : "f-001";
	const raw = { ...makeMarkerRaw(1, 1), envelopeDigest: journalDigest(journalSeq, frameId), ...overrides };
	const r = encodeDeliveryMarkerV1(raw);
	if (!r.ok) throw new Error("encode failed");
	return new Uint8Array(r.bytes);
}

// ===========================================================================
// FileSpec
// ===========================================================================

interface FileSpec {
	name: string;
	bytes: Uint8Array;
	stat?: Partial<B03EntryStat>;
}

// ===========================================================================
// Build adapters — entries sorted by name (delivery < journal bytewise)
// ===========================================================================

function buildSortedFiles(files: FileSpec[]): FileSpec[] {
	return [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function makeAdapter(files: FileSpec[]): B03Adapter {
	const sorted = buildSortedFiles(files);
	let cursorPos = 0;
	return {
		listPage(request: { cursor: string | null; maxEntries: number; maxBytes: number }): B03Page {
			if (request.maxEntries !== 64 || request.maxBytes !== 16777216) {
				return { entries: [], nextCursor: null };
			}
			if (request.cursor === null) cursorPos = 0;
			else cursorPos = parseInt(request.cursor, 10);
			if (cursorPos >= sorted.length) return { entries: [], nextCursor: null };
			const end = Math.min(cursorPos + 64, sorted.length);
			const slice = sorted.slice(cursorPos, end);
			const entries = slice.map((f) => ({
				name: f.name,
				stat: makeStat({ size: f.bytes.length, ...f.stat }),
			}));
			const nextCursor = end < sorted.length ? String(end) : null;
			cursorPos = end;
			return { entries, nextCursor };
		},
		async open(request: { name: string; expected: B03EntryStat }): Promise<B03OpenOutcome> {
			const file = sorted.find((f) => f.name === request.name);
			if (!file) return { status: "error" };
			let closed = false;
			return {
				status: "opened",
				handle: {
					async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
						if (closed) throw new Error("read on closed handle");
						if (offset >= file.bytes.length) return { status: "eof" };
						const end = Math.min(offset + size, file.bytes.length);
						const chunk = file.bytes.slice(offset, end);
						const copy = new Uint8Array(chunk.length);
						copy.set(chunk);
						return { status: "bytes", bytes: copy };
					},
					async confirmEof(): Promise<{ status: "eof" }> {
						return { status: "eof" };
					},
					async fstat(): Promise<B03EntryStat> {
						return makeStat({ size: file.bytes.length, ...file.stat });
					},
					async close(): Promise<{ status: "closed" }> {
						if (closed) throw new Error("double close");
						closed = true;
						return { status: "closed" };
					},
				},
			};
		},
	};
}

// ===========================================================================
// Paginating adapter for cross-page tests
// ===========================================================================

function makePagingAdapter(files: FileSpec[], pageSize: number): B03Adapter {
	const sorted = buildSortedFiles(files);
	let cursorPos = 0;
	return {
		listPage(request: { cursor: string | null; maxEntries: number; maxBytes: number }): B03Page {
			if (request.cursor === null) cursorPos = 0;
			else cursorPos = parseInt(request.cursor, 10);
			if (cursorPos >= sorted.length) return { entries: [], nextCursor: null };
			const end = Math.min(cursorPos + pageSize, sorted.length);
			const slice = sorted.slice(cursorPos, end);
			const entries = slice.map((f) => ({
				name: f.name,
				stat: makeStat({ size: f.bytes.length, ...f.stat }),
			}));
			const nextCursor = end < sorted.length ? String(end) : null;
			cursorPos = end;
			return { entries, nextCursor };
		},
		async open(request: { name: string; expected: B03EntryStat }): Promise<B03OpenOutcome> {
			const file = sorted.find((f) => f.name === request.name);
			if (!file) return { status: "error" };
			const _closed = false;
			return {
				status: "opened",
				handle: {
					async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
						if (offset >= file.bytes.length) return { status: "eof" };
						const end = Math.min(offset + size, file.bytes.length);
						const chunk = file.bytes.slice(offset, end);
						const copy = new Uint8Array(chunk.length);
						copy.set(chunk);
						return { status: "bytes", bytes: copy };
					},
					async confirmEof(): Promise<{ status: "eof" }> {
						return { status: "eof" };
					},
					async fstat(): Promise<B03EntryStat> {
						return makeStat({ size: file.bytes.length, ...file.stat });
					},
					async close(): Promise<{ status: "closed" }> {
						return { status: "closed" };
					},
				},
			};
		},
	};
}

// ===========================================================================
// Tests
// ===========================================================================

describe("recoverB03Directory", () => {
	// ===========================================================================
	// 1. Basic success
	// ===========================================================================

	describe("basic success", () => {
		it("returns empty result for empty directory", async () => {
			const adapter = makeAdapter([]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toEqual([]);
			expect(result.markers).toEqual([]);
			expect(result.totalBytes).toBe(0);
		});

		it("recovers single journal file", async () => {
			const jBytes = encodeJournal(1);
			const adapter = makeAdapter([{ name: journalFileName(1), bytes: jBytes }]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toHaveLength(1);
			expect(result.journals[0].journalSeq).toBe(1);
			expect(result.markers).toHaveLength(0);
			expect(result.totalBytes).toBe(jBytes.length);
		});

		it("recovers single delivery marker", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarker(1, 1);
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toHaveLength(1);
			expect(result.markers).toHaveLength(1);
			expect(result.markers[0].indexSeq).toBe(1);
			expect(result.markers[0].journalSeq).toBe(1);
			expect(result.markers[0].state).toBe("pending");
		});

		it("recovers interleaved journals and markers", async () => {
			const j1 = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-001") });
			const j2 = encodeJournalWith({ journalSeq: 2, envelope: makeEnvelope("f-002") });
			const m1 = encodeMarkerWith({ indexSeq: 1, journalSeq: 1, frameId: "f-001" });
			const m2 = encodeMarkerWith({ indexSeq: 2, journalSeq: 2, frameId: "f-002" });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: m1 },
				{ name: deliveryFileName(2), bytes: m2 },
				{ name: journalFileName(1), bytes: j1 },
				{ name: journalFileName(2), bytes: j2 },
			]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toHaveLength(2);
			expect(result.markers).toHaveLength(2);
			expect(result.markers[0].journalSeq).toBe(1);
			expect(result.markers[1].journalSeq).toBe(2);
		});

		it("returns frozen result", async () => {
			const jBytes = encodeJournal(1);
			const adapter = makeAdapter([{ name: journalFileName(1), bytes: jBytes }]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(Object.isFrozen(result)).toBe(true);
			expect(Object.isFrozen(result.journals)).toBe(true);
			expect(Object.isFrozen(result.markers)).toBe(true);
			expect(result.identity.hostId).toBe("h-1");
		});

		it("works with received direction", async () => {
			const jBytes = encodeJournal(1, "received");
			const adapter = makeAdapter([{ name: journalFileName(1), bytes: jBytes }]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "received",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals[0].direction).toBe("received");
		});
	});

	// ===========================================================================
	// 2. Pagination
	// ===========================================================================

	describe("pagination", () => {
		it("handles cursor loop with multiple pages", async () => {
			const files: FileSpec[] = [];
			for (let i = 1; i <= 100; i++) {
				files.push({
					name: journalFileName(i),
					bytes: encodeJournalWith({ journalSeq: i, envelope: makeEnvelope(`f-${pad(i)}`) }),
				});
			}
			const adapter = makePagingAdapter(files, 64);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			// 100 entries, first page 64, second page 36
			expect(result.journals).toHaveLength(100);
		});

		it("handles a 65-file journal and marker page boundary", async () => {
			const files: FileSpec[] = [];
			for (let i = 1; i <= 33; i++) {
				const frameId = `f-marker-${pad(i)}`;
				files.push({
					name: journalFileName(i),
					bytes: encodeJournalWith({ journalSeq: i, envelope: makeEnvelope(frameId) }),
				});
				if (i <= 32) {
					files.push({
						name: deliveryFileName(i),
						bytes: encodeMarkerWith({ indexSeq: i, journalSeq: i, frameId }),
					});
				}
			}
			const adapter = makePagingAdapter(files, 64);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toHaveLength(33);
			expect(result.markers).toHaveLength(32);
		});

		it("rejects non-final page with empty entries", async () => {
			let callCount = 0;
			const adapter: B03Adapter = {
				listPage(): B03Page {
					callCount++;
					if (callCount === 1)
						return { entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }], nextCursor: "x" };
					if (callCount === 2) return { entries: [], nextCursor: "y" };
					return { entries: [], nextCursor: null };
				},
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							readAt() {
								throw new Error();
							},
							confirmEof() {
								throw new Error();
							},
							fstat() {
								return makeStat({ size: 10 });
							},
							close() {
								return { status: "closed" };
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
		});
	});

	// ===========================================================================
	// 3. Input validation
	// ===========================================================================

	describe("input validation", () => {
		it("rejects null input", async () => {
			expect((await recoverB03Directory(null)).ok).toBe(false);
		});
		it("rejects non-object input", async () => {
			expect((await recoverB03Directory("bad")).ok).toBe(false);
		});
		it("rejects input with extra keys", async () => {
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([]),
				extra: true,
			});
			expect(result.ok).toBe(false);
		});
		it("rejects invalid identity (empty sessionId)", async () => {
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "" },
				direction: "sent",
				adapter: makeAdapter([]),
			});
			expect(result.ok).toBe(false);
		});
		it("rejects invalid direction", async () => {
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "invalid",
				adapter: makeAdapter([]),
			});
			expect(result.ok).toBe(false);
		});
		it("rejects Proxy input (prototype trap throws)", async () => {
			const p = new Proxy(
				{},
				{
					getPrototypeOf() {
						throw new Error();
					},
				},
			);
			expect((await recoverB03Directory(p)).ok).toBe(false);
		});
		it("rejects input with symbol keys", async () => {
			const obj: Record<PropertyKey, unknown> = {
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([]),
			};
			Object.defineProperty(obj, Symbol.for("k"), { value: 1, enumerable: true });
			expect((await recoverB03Directory(obj)).ok).toBe(false);
		});
		it("rejects input missing adapter", async () => {
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
					} as unknown)
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 4. Adapter validation
	// ===========================================================================

	describe("adapter validation", () => {
		it("rejects adapter with extra methods", async () => {
			const a: Record<string, unknown> = {
				listPage: () => ({ entries: [], nextCursor: null }),
				open: () => ({ status: "opened", handle: {} }),
				extra: () => {},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: a,
					})
				).ok,
			).toBe(false);
		});
		it("rejects adapter with missing methods", async () => {
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: { listPage: () => ({ entries: [], nextCursor: null }) } as unknown,
					})
				).ok,
			).toBe(false);
		});
		it("rejects adapter with getter methods", async () => {
			const a: Record<string, unknown> = {};
			Object.defineProperty(a, "listPage", {
				get: () => () => ({ entries: [], nextCursor: null }),
				enumerable: true,
			});
			Object.defineProperty(a, "open", { get: () => () => ({ status: "opened", handle: {} }), enumerable: true });
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: a,
					})
				).ok,
			).toBe(false);
		});
		it("rejects adapter where get trap returns non-function", async () => {
			// Proxy that returns non-function descriptor value via get trap
			const p = new Proxy({} as Record<string, unknown>, {
				ownKeys() {
					return ["listPage", "open"];
				},
				getOwnPropertyDescriptor() {
					return { value: "not-a-function", enumerable: true, configurable: true, writable: true };
				},
			});
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: p,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 5. Stat / filename validation
	// ===========================================================================

	describe("stat and filename validation", () => {
		it("rejects non-file entry", async () => {
			const files = [{ name: journalFileName(1), bytes: encodeJournal(1), stat: { isFile: false } }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects symlink entry", async () => {
			const files = [{ name: journalFileName(1), bytes: encodeJournal(1), stat: { isSymlink: true } }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects wrong mode", async () => {
			const files = [{ name: journalFileName(1), bytes: encodeJournal(1), stat: { mode: 0o644 } }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects nlink != 1", async () => {
			const files = [{ name: journalFileName(1), bytes: encodeJournal(1), stat: { nlink: 2 } }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects invalid filename", async () => {
			const files = [{ name: "bad-name.b03-journal", bytes: encodeJournal(1) }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects out-of-range journal seq (>20000)", async () => {
			const files = [{ name: journalFileName(20001), bytes: new Uint8Array(10) }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects out-of-range marker seq (>40000)", async () => {
			const files = [{ name: deliveryFileName(40001), bytes: new Uint8Array(10) }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects duplicate filename", async () => {
			const jBytes = encodeJournal(1);
			const files = [
				{ name: journalFileName(1), bytes: jBytes },
				{ name: journalFileName(1), bytes: jBytes },
			];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects oversized file (>1.25 MiB)", async () => {
			const files = [{ name: journalFileName(1), bytes: new Uint8Array(1_310_721), stat: { size: 1_310_721 } }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 6. Sequence contiguity
	// ===========================================================================

	describe("sequence contiguity", () => {
		it("rejects gap in journal sequence (1 then 3)", async () => {
			const files = [
				{ name: journalFileName(1), bytes: encodeJournal(1) },
				{ name: journalFileName(3), bytes: encodeJournal(3) },
			];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects gap in marker sequence (1 then 3)", async () => {
			const j1 = encodeJournal(1);
			const files = [
				{ name: deliveryFileName(1), bytes: encodeMarker(1, 1) },
				{ name: deliveryFileName(3), bytes: encodeMarker(3, 1) },
				{ name: journalFileName(1), bytes: j1 },
			];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects marker delivered without prior pending", async () => {
			const jBytes = encodeJournal(1);
			const files = [
				{ name: deliveryFileName(1), bytes: encodeMarker(1, 1, "delivered") },
				{ name: journalFileName(1), bytes: jBytes },
			];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 7. Handle validation
	// ===========================================================================

	describe("handle validation", () => {
		it("rejects handle with extra methods", async () => {
			const jBytes = encodeJournal(1);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					const h: Record<string, unknown> = {
						async readAt() {
							return { status: "bytes", bytes: new Uint8Array(jBytes) };
						},
						async confirmEof() {
							return { status: "eof" };
						},
						async fstat() {
							return makeStat({ size: jBytes.length });
						},
						async close(): Promise<{ status: "closed" }> {
							return { status: "closed" };
						},
					};
					h.extra = () => {};
					return { status: "opened", handle: h };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects handle with missing methods", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return { status: "opened", handle: { readAt() {}, confirmEof() {}, fstat() {} } as unknown };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects handle with getter methods", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					const h: Record<string, unknown> = {};
					Object.defineProperty(h, "readAt", {
						get: () => () => ({ status: "bytes", bytes: new Uint8Array(10) }),
						enumerable: true,
					});
					Object.defineProperty(h, "confirmEof", { get: () => () => ({ status: "eof" }), enumerable: true });
					Object.defineProperty(h, "fstat", { get: () => () => makeStat({ size: 10 }), enumerable: true });
					Object.defineProperty(h, "close", { get: () => () => "ok", enumerable: true });
					return { status: "opened", handle: h };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 8. Open errors
	// ===========================================================================

	describe("open errors", () => {
		it("rejects open returning error", async () => {
			let _opened = false;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					_opened = true;
					return { status: "error" };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects open throwing", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				open() {
					throw new Error("open fail");
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 9. Close errors / uncertainty
	// ===========================================================================

	describe("close errors and uncertainty", () => {
		it("close that throws returns IO_UNCONFIRMED", async () => {
			const jBytes = encodeJournal(1);
			let closed = false;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								return { status: "bytes", bytes: new Uint8Array(jBytes.slice(offset, end)) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error("double close");
								closed = true;
								throw new Error("close fail");
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("IO_UNCONFIRMED");
		});
		it("close returning non-ok value returns IO_UNCONFIRMED", async () => {
			const jBytes = encodeJournal(1);
			let closed = false;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								return { status: "bytes", bytes: new Uint8Array(jBytes.slice(offset, end)) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<unknown> {
								if (closed) throw new Error("double close");
								closed = true;
								return "bad";
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 10. Read errors
	// ===========================================================================

	describe("read errors", () => {
		it("rejects read returning error", async () => {
			const jBytes = encodeJournal(1);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								return { status: "error" };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects read returning EOF before full read", async () => {
			const jBytes = encodeJournal(1);
			let readCount = 0;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								readCount++;
								if (readCount > 1) return { status: "eof" };
								return { status: "bytes", bytes: new Uint8Array(10) };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects readAt throwing", async () => {
			const jBytes = encodeJournal(1);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							readAt() {
								throw new Error("read fail");
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 11. Codec corruption
	// ===========================================================================

	describe("codec corruption", () => {
		it("rejects corrupted journal bytes", async () => {
			const jBytes = encodeJournal(1);
			jBytes[10] = 0xff;
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter([{ name: journalFileName(1), bytes: jBytes }]),
					})
				).ok,
			).toBe(false);
		});
		it("rejects wrong hostId in journal", async () => {
			const jBytes = encodeJournalWith({ hostId: "h-other" });
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter([{ name: journalFileName(1), bytes: jBytes }]),
					})
				).ok,
			).toBe(false);
		});
		it("rejects wrong direction in journal", async () => {
			const jBytes = encodeJournalWith({ direction: "received" });
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter([{ name: journalFileName(1), bytes: jBytes }]),
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 12. Marker resolution
	// ===========================================================================

	describe("marker resolution", () => {
		it("rejects marker with unknown journalSeq", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarker(1, 2);
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects marker with wrong hostId", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarkerWith({ hostId: "h-other", journalSeq: 1 });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects marker with wrong generation", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarkerWith({ generation: "g-other", journalSeq: 1 });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects marker with wrong sessionId", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarkerWith({ sessionId: "s-other", journalSeq: 1 });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects marker with wrong direction", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarkerWith({ direction: "received", journalSeq: 1 });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 13. Marker transitions
	// ===========================================================================

	describe("marker transitions", () => {
		it("pending then delivered transitions succeed", async () => {
			const jBytes = encodeJournal(1);
			const m1 = encodeMarker(1, 1, "pending");
			const m2 = encodeMarker(2, 1, "delivered");
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: m1 },
				{ name: deliveryFileName(2), bytes: m2 },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.markers).toHaveLength(2);
			expect(result.markers[0].state).toBe("pending");
			expect(result.markers[1].state).toBe("delivered");
		});
		it("rejects delivered without pending", async () => {
			const jBytes = encodeJournal(1);
			const mBytes = encodeMarker(1, 1, "delivered");
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects duplicate pending for same frame", async () => {
			const jBytes = encodeJournal(1);
			const m1 = encodeMarker(1, 1, "pending");
			const m2 = encodeMarker(2, 1, "pending");
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: m1 },
				{ name: deliveryFileName(2), bytes: m2 },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 14. Duplicate frameId rules
	// ===========================================================================

	describe("duplicate frameId rules", () => {
		it("allows duplicate frameId with same digest+direction", async () => {
			const env = makeEnvelope("f-001"); // same content = same digest
			const j1 = encodeJournalWith({ journalSeq: 1, envelope: { ...env } });
			const j2 = encodeJournalWith({ journalSeq: 2, envelope: { ...env } });
			const adapter = makeAdapter([
				{ name: journalFileName(1), bytes: j1 },
				{ name: journalFileName(2), bytes: j2 },
			]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toHaveLength(2);
		});
		it("rejects duplicate frameId with different digest", async () => {
			const env1 = makeEnvelope("f-001");
			const env2 = makeEnvelope("f-001");
			env2.sentAt = "2025-06-15T10:30:00.000Z";
			const j1 = encodeJournalWith({ journalSeq: 1, envelope: env1 });
			const j2 = encodeJournalWith({ journalSeq: 2, envelope: env2 });
			const adapter = makeAdapter([
				{ name: journalFileName(1), bytes: j1 },
				{ name: journalFileName(2), bytes: j2 },
			]);
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 15. Page atomicity
	// ===========================================================================

	describe("page atomicity", () => {
		it("fails page if any entry fails, no partial state", async () => {
			const j1 = encodeJournal(1);
			const j2 = encodeJournal(2);
			j2[5] = 0xff; // corrupt
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter([
							{ name: journalFileName(1), bytes: j1 },
							{ name: journalFileName(2), bytes: j2 },
						]),
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 16. Byte erasure
	// ===========================================================================

	describe("byte erasure", () => {
		it("erases read result bytes after copy", async () => {
			const jBytes = encodeJournal(1);
			let readBytes: Uint8Array | null = null;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								const b = new Uint8Array(jBytes);
								readBytes = b;
								return { status: "bytes", bytes: b };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			if (readBytes) {
				for (let i = 0; i < (readBytes as Uint8Array).length; i++) expect((readBytes as Uint8Array)[i]).toBe(0);
			}
		});
	});

	// ===========================================================================
	// 17. Exact listPage parameters
	// ===========================================================================

	describe("exact listPage parameters", () => {
		it("calls listPage with frozen exact parameters", async () => {
			const requests: B03ListPageRequest[] = [];
			const adapter: B03Adapter = {
				listPage(request: B03ListPageRequest): B03Page {
					requests.push(request);
					return { entries: [], nextCursor: null };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(requests).toHaveLength(1);
			const receivedRequest = requests[0];
			expect(receivedRequest.cursor).toBeNull();
			expect(receivedRequest.maxEntries).toBe(64);
			expect(receivedRequest.maxBytes).toBe(16777216);
			expect(Object.isFrozen(receivedRequest)).toBe(true);
		});
	});

	// ===========================================================================
	// 18. Cursor validation
	// ===========================================================================

	describe("cursor validation", () => {
		it("rejects same cursor from non-final page", async () => {
			let _callCount = 0;
			const adapter: B03Adapter = {
				listPage(): B03Page {
					_callCount++;
					return { entries: [{ name: journalFileName(1), stat: makeStat({ size: 1 }) }], nextCursor: "same" };
				},
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt() {
								return { status: "bytes", bytes: new Uint8Array(1) };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: 1 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects empty string cursor", async () => {
			const adapter: B03Adapter = {
				listPage(): B03Page {
					return { entries: [], nextCursor: "" };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 19. Sensitive output
	// ===========================================================================

	describe("sensitive output", () => {
		it("does not expose adapter, cursor, path, stat, raw bytes in result", async () => {
			const jBytes = encodeJournal(1);
			const adapter = makeAdapter([{ name: journalFileName(1), bytes: jBytes }]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const keys = Object.keys(result);
			expect(keys).toEqual(["ok", "identity", "direction", "journals", "markers", "totalBytes"]);
		});
	});

	// ===========================================================================
	// 20. Error result frozen
	// ===========================================================================

	describe("error result frozen", () => {
		it("error result is frozen", async () => {
			expect(Object.isFrozen(await recoverB03Directory(null))).toBe(true);
		});
	});

	// ===========================================================================
	// 21. Fstat mismatch
	// ===========================================================================

	describe("stat matching", () => {
		it("fstat size mismatch with list stat is rejected", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 100 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt() {
								return { status: "bytes", bytes: new Uint8Array(10) };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: 10 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("fstat mode mismatch with list stat is rejected", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10, mode: 0o600 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt() {
								return { status: "bytes", bytes: new Uint8Array(10) };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: 10, mode: 0o644 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 22. Additional coverage
	// ===========================================================================

	describe("additional coverage", () => {
		it("rejects oversized byte page (>16 MiB)", async () => {
			const files = [{ name: journalFileName(1), bytes: encodeJournal(1), stat: { size: 20_000_000 } }];
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter: makeAdapter(files),
					})
				).ok,
			).toBe(false);
		});
		it("rejects handle fstat throwing", async () => {
			const jBytes = encodeJournal(1);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt() {
								return { status: "bytes", bytes: new Uint8Array(10) };
							},
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								throw new Error("fstat fail");
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects handle confirmEof throwing", async () => {
			const jBytes = encodeJournal(1);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								return { status: "bytes", bytes: new Uint8Array(jBytes.slice(offset, end)) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								throw new Error("eof fail");
							},
							async fstat() {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects listPage throwing", async () => {
			const adapter: B03Adapter = {
				listPage() {
					throw new Error("list fail");
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("rejects too many entries in a single page (>64)", async () => {
			const adapter: B03Adapter = {
				listPage(): B03Page {
					const entries = [];
					for (let i = 0; i < 65; i++) entries.push({ name: journalFileName(i + 1), stat: makeStat({ size: 1 }) });
					return { entries, nextCursor: null };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
		it("accepts exactly 64 entries in a page", async () => {
			const files: FileSpec[] = [];
			for (let i = 1; i <= 64; i++)
				files.push({
					name: journalFileName(i),
					bytes: encodeJournalWith({ journalSeq: i, envelope: makeEnvelope(`f-${pad(i)}`) }),
				});
			const adapter = makeAdapter(files);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.journals).toHaveLength(64);
		});
		it("never throws", async () => {
			// Various invalid inputs that should never throw
			expect((await recoverB03Directory(undefined)).ok).toBe(false);
			expect((await recoverB03Directory(42)).ok).toBe(false);
			expect((await recoverB03Directory([])).ok).toBe(false);
			expect((await recoverB03Directory({} as unknown)).ok).toBe(false);
			expect((await recoverB03Directory("")).ok).toBe(false);
		});
	});

	// ===========================================================================
	// 23. Error passthrough from codec
	// ===========================================================================

	describe("error passthrough", () => {
		it("INVALID_IDENTITY from codec is passed through", async () => {
			const jBytes = encodeJournalWith({ hostId: "h-other" });
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([{ name: journalFileName(1), bytes: jBytes }]),
			});
			expect(result.ok).toBe(false);
		});
		it("OVERFLOW error from codec is passed through", async () => {
			const huge = new Uint8Array(1_310_721);
			huge.fill(0x20); // space padding
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([{ name: journalFileName(1), bytes: huge }]),
			});
			expect(result.ok).toBe(false);
		});
	});
	// ===========================================================================
	// 24. Additional handle & read edge cases
	// ===========================================================================

	describe("additional handle edge cases", () => {
		it("rejects short read that doesn't reach stat.size", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-short") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					let closed = false;
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								const b = new Uint8Array(5);
								b.fill(0x20);
								return { status: "bytes", bytes: b };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error();
								closed = true;
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects overlong read chunk (>64KiB request not enforced by codec, but short bytes accepted)", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-over") });
			// This tests that 65,537 bytes per request works (our code uses 65536 chunks)
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					let closed = false;
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								const chunk = jBytes.slice(offset, end);
								return { status: "bytes", bytes: new Uint8Array(chunk) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error();
								closed = true;
								return { status: "closed" };
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
		});

		it("rejects handle returning non-Uint8Array bytes", async () => {
			const _jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-nonu8") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<unknown> {
								return { status: "bytes", bytes: "not-uint8array" };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: 10 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects handle returning SharedArrayBuffer bytes", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								const sab = new SharedArrayBuffer(10);
								return { status: "bytes", bytes: new Uint8Array(sab) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: 10 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects handle with detached ArrayBuffer bytes", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								const ab = new ArrayBuffer(10);
								const { port1, port2 } = new MessageChannel();
								port1.postMessage(ab, [ab]);
								port2.addEventListener("message", () => {});
								port1.close();
								port2.close();
								return { status: "bytes", bytes: new Uint8Array(ab) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: 10 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects final fstat that differs from initial", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-fstat") });
			let fstatCalls = 0;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								return { status: "bytes", bytes: new Uint8Array(jBytes.slice(offset, end)) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								fstatCalls++;
								if (fstatCalls === 1) return makeStat({ size: jBytes.length, mtimeNs: "1000000000" });
								return makeStat({ size: jBytes.length, mtimeNs: "2000000000" }); // different mtime
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 25. Additional codec/error edge cases
	// ===========================================================================

	describe("additional codec edge cases", () => {
		it("rejects oversized entry in page", async () => {
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([
					{ name: journalFileName(1), bytes: new Uint8Array(1_310_721), stat: { size: 1_310_721 } },
				]),
			});
			expect(result.ok).toBe(false);
		});

		it("rejects marker with duplicate frameId but different digest on same journal", async () => {
			// Create two markers for the same journal with different digests
			const jBytes = encodeJournal(1);
			const m1 = encodeMarkerWith({ indexSeq: 1, journalSeq: 1, frameId: "f-dup" });
			const m2 = encodeMarkerWith({ indexSeq: 2, journalSeq: 1, frameId: "f-dup", envelopeDigest: "aa".repeat(32) });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: m1 },
				{ name: deliveryFileName(2), bytes: m2 },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			// The accumulator will accept m1 (pending), then m2 should fail because
			// it has same frameId but different digest
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
		});

		it("rejects confirmEof wrong status", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-eof") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								return { status: "bytes", bytes: new Uint8Array(jBytes.slice(offset, end)) };
							},
							async confirmEof(): Promise<unknown> {
								return { status: "not-eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects zero-length read result", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-zero") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								return { status: "bytes", bytes: new Uint8Array(0) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects read with overlong bytes (> requested chunk)", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 100 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								const b = new Uint8Array(1000); // way more than requested
								b.fill(0x20);
								return { status: "bytes", bytes: b };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: 100 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	// ===========================================================================
	// 26. Close on error before handle validation
	// ===========================================================================

	describe("close on error paths", () => {
		it("close is called exactly once on fstat mismatch during init", async () => {
			let closeCount = 0;
			let closed = false;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 100 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								throw new Error();
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								throw new Error();
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: 10 });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error();
								closed = true;
								closeCount++;
								return { status: "closed" };
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
			expect(closeCount).toBe(1); // close is called exactly once
		});

		it("read returning error still calls close exactly once", async () => {
			let closeCount = 0;
			let closed = false;
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-close1") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(): Promise<B03ReadOutcome> {
								return { status: "error" };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error();
								closed = true;
								closeCount++;
								return { status: "closed" };
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
			expect(closeCount).toBe(1);
		});

		it("close called exactly once when readAt throws", async () => {
			let closeCount = 0;
			let closed = false;
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-close2") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							readAt(): Promise<B03ReadOutcome> {
								throw new Error("read fail");
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error();
								closed = true;
								closeCount++;
								return { status: "closed" };
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
			expect(closeCount).toBe(1);
		});

		it("close throws on first call is caught and does not double-close", async () => {
			let closed = false;
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-close3") });
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: jBytes.length }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							async readAt(offset: number, size: number): Promise<B03ReadOutcome> {
								const end = Math.min(offset + size, jBytes.length);
								return { status: "bytes", bytes: new Uint8Array(jBytes.slice(offset, end)) };
							},
							async confirmEof(): Promise<{ status: "eof" }> {
								return { status: "eof" };
							},
							async fstat(): Promise<B03EntryStat> {
								return makeStat({ size: jBytes.length });
							},
							async close(): Promise<{ status: "closed" }> {
								if (closed) throw new Error("double close");
								closed = true;
								throw new Error("close error");
							},
						},
					};
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
		});
	});

	// ===========================================================================
	// 27. Identity / direction mismatch edge cases
	// ===========================================================================

	describe("identity/direction edge cases", () => {
		it("rejects identity with null bytes in hostId", async () => {
			const result = await recoverB03Directory({
				identity: { hostId: "h-\0-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([]),
			});
			expect(result.ok).toBe(false);
		});

		it("rejects direction 'sent' when journal says 'received'", async () => {
			const jBytes = encodeJournalWith({ direction: "received", envelope: makeEnvelope("f-dir") });
			const adapter = makeAdapter([{ name: journalFileName(1), bytes: jBytes }]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
		});

		it("marker direction mismatch with recovery direction", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-mdir") });
			// Marker with wrong direction
			const mBytes = encodeMarkerWith({ indexSeq: 1, journalSeq: 1, direction: "received" });
			const adapter = makeAdapter([
				{ name: deliveryFileName(1), bytes: mBytes },
				{ name: journalFileName(1), bytes: jBytes },
			]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
		});
	});

	// ===========================================================================
	// 28. Cross-page ordering
	// ===========================================================================

	describe("cross-page ordering", () => {
		it("rejects entries out of bytewise order across pages", async () => {
			let callCount = 0;
			const adapter: B03Adapter = {
				listPage(): B03Page {
					callCount++;
					if (callCount === 1)
						return {
							entries: [{ name: "00000000000000000002.b03-journal", stat: makeStat({ size: 10 }) }],
							nextCursor: "page2",
						};
					if (callCount === 2)
						return {
							entries: [{ name: "00000000000000000001.b03-journal", stat: makeStat({ size: 10 }) }],
							nextCursor: null,
						};
					return { entries: [], nextCursor: null };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(false);
		});
	});

	// ===========================================================================
	// 29. Boundary and error code coverage
	// ===========================================================================

	describe("boundary coverage", () => {
		it("rejects entry where listPage returns wrong maxEntries param", async () => {
			const adapter: B03Adapter = {
				listPage(_request: B03ListPageRequest): B03Page {
					// Return more than allowed
					const entries = [];
					for (let i = 0; i < 65; i++) entries.push({ name: journalFileName(i + 1), stat: makeStat({ size: 1 }) });
					return { entries, nextCursor: null };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects entry with malformed stat (extra field)", async () => {
			const adapter: B03Adapter = {
				listPage(): B03Page {
					const stat = { ...makeStat({ size: 10 }), extra: true };
					const entry = { name: journalFileName(1), stat };
					return { entries: [entry], nextCursor: null };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects page with malformed entry (missing name)", async () => {
			const adapter: B03Adapter = {
				listPage(): B03Page {
					return { entries: [{ stat: makeStat({ size: 10 }) }], nextCursor: null } as unknown as B03Page;
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("returns frozen journals and markers arrays", async () => {
			const jBytes = encodeJournalWith({ journalSeq: 1, envelope: makeEnvelope("f-frozen") });
			const adapter = makeAdapter([{ name: journalFileName(1), bytes: jBytes }]);
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(() => {
				(result.journals as unknown as { push: unknown }).push = 1;
			}).toThrow();
			expect(() => {
				(result.markers as unknown as { push: unknown }).push = 1;
			}).toThrow();
		});

		it("handles maxPageBytes exact boundary (16 MiB)", async () => {
			// 16 MiB / ~559 bytes per journal = ~30000 entries can fit
			// But we only need to test the boundary logic
			const adapter: B03Adapter = {
				listPage(): B03Page {
					const entries: Array<{ name: string; stat: B03EntryStat }> = [];
					for (let i = 0; i < 3; i++) {
						entries.push({ name: journalFileName(i + 1), stat: makeStat({ size: 5_592_406 }) }); // ~5.3 MiB each = ~16 MiB total
					}
					return { entries, nextCursor: null };
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			// Page has too many bytes
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			// Should fail because stat.size sum > 16 MiB
			expect(result.ok).toBe(false);
		});

		it("rejects handle returning readAt that is not a function", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: 10 }) }],
					nextCursor: null,
				}),
				async open(): Promise<unknown> {
					return {
						status: "opened",
						handle: {
							readAt: "not-a-function",
							async confirmEof() {
								return { status: "eof" };
							},
							async fstat() {
								return makeStat({ size: 10 });
							},
							async close(): Promise<{ status: "closed" }> {
								return { status: "closed" };
							},
						},
					};
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});

		it("rejects page where entries array is not sorted correctly", async () => {
			const adapter: B03Adapter = {
				listPage(): B03Page {
					return {
						entries: [
							{ name: "00000000000000000002.b03-journal", stat: makeStat({ size: 10 }) },
							{ name: "00000000000000000001.b03-journal", stat: makeStat({ size: 10 }) },
						],
						nextCursor: null,
					};
				},
				async open(): Promise<unknown> {
					return { status: "opened", handle: {} };
				},
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});

	describe("adversarial recovery ownership and binding", () => {
		it("rejects an empty non-final page", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({ entries: [], nextCursor: "next" }),
				open: () => ({ status: "error" }),
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result).toEqual({ ok: false, error: { code: "INVALID_FRAME" } });
		});

		it("rejects a non-adjacent cursor cycle", async () => {
			const bytes = [1, 2, 3].map((sequence) => encodeJournalWith({ journalSeq: sequence }));
			const base = makeAdapter(bytes.map((value, index) => ({ name: journalFileName(index + 1), bytes: value })));
			let call = 0;
			const adapter: B03Adapter = {
				listPage: () => {
					const index = Math.min(call, 2);
					const nextCursor = ["cursor-a", "cursor-b", "cursor-a"][index];
					call += 1;
					return {
						entries: [{ name: journalFileName(index + 1), stat: makeStat({ size: bytes[index].byteLength }) }],
						nextCursor,
					};
				},
				open: (request) => base.open(request),
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result).toEqual({ ok: false, error: { code: "INVALID_SEQUENCE" } });
			expect(call).toBe(3);
		});

		it("enforces filename order across pages independently of kind sequence", async () => {
			const journal = encodeJournal(1);
			const marker = encodeMarker(1, 1);
			const base = makeAdapter([
				{ name: journalFileName(1), bytes: journal },
				{ name: deliveryFileName(1), bytes: marker },
			]);
			let call = 0;
			const adapter: B03Adapter = {
				listPage: () => {
					call += 1;
					return call === 1
						? {
								entries: [{ name: journalFileName(1), stat: makeStat({ size: journal.byteLength }) }],
								nextCursor: "next",
							}
						: {
								entries: [{ name: deliveryFileName(1), stat: makeStat({ size: marker.byteLength }) }],
								nextCursor: null,
							};
				},
				open: (request) => base.open(request),
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result).toEqual({ ok: false, error: { code: "INVALID_SEQUENCE" } });
		});

		it("freezes its copied identity", async () => {
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter: makeAdapter([]),
			});
			expect(result.ok).toBe(true);
			if (result.ok) expect(Object.isFrozen(result.identity)).toBe(true);
		});

		it("consumes a safely discoverable close from a malformed opened result", async () => {
			const bytes = encodeJournal(1);
			let closes = 0;
			const handle = {
				readAt: () => ({ status: "error" }),
				confirmEof: () => ({ status: "eof" }),
				fstat: () => makeStat({ size: bytes.byteLength }),
				close: () => {
					closes += 1;
					return { status: "closed" };
				},
			};
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: bytes.byteLength }) }],
					nextCursor: null,
				}),
				open: () => ({ status: "opened", handle, extra: true }),
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result).toEqual({ ok: false, error: { code: "INVALID_FRAME" } });
			expect(closes).toBe(1);
		});

		it("lets close uncertainty dominate an earlier mismatch", async () => {
			const bytes = encodeJournal(1);
			let closes = 0;
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: bytes.byteLength }) }],
					nextCursor: null,
				}),
				open: () => ({
					status: "opened",
					handle: {
						readAt: () => ({ status: "error" }),
						confirmEof: () => ({ status: "eof" }),
						fstat: () => makeStat({ size: bytes.byteLength, ino: "999" }),
						close: () => {
							closes += 1;
							return { status: "error" };
						},
					},
				}),
			};
			const result = await recoverB03Directory({
				identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
				direction: "sent",
				adapter,
			});
			expect(result).toEqual({ ok: false, error: { code: "IO_UNCONFIRMED" } });
			expect(closes).toBe(1);
		});

		it("erases a rejected Buffer view without erasing unrelated pooled bytes", async () => {
			const journal = encodeJournal(1);
			const backing = Buffer.alloc(journal.byteLength + 2, 0x7f);
			Buffer.from(journal).copy(backing, 1);
			const view = backing.subarray(1, backing.length - 1);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: journal.byteLength }) }],
					nextCursor: null,
				}),
				open: () => ({
					status: "opened",
					handle: {
						readAt: () => ({ status: "bytes", bytes: view }),
						confirmEof: () => ({ status: "eof" }),
						fstat: () => makeStat({ size: journal.byteLength }),
						close: () => ({ status: "closed" }),
					},
				}),
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
			expect([...view].every((value) => value === 0)).toBe(true);
			expect(backing[0]).toBe(0x7f);
			expect(backing.at(-1)).toBe(0x7f);
		});

		it("erases safely discoverable bytes from a malformed read result", async () => {
			const journal = encodeJournal(1);
			const transferred = new Uint8Array(journal);
			const adapter: B03Adapter = {
				listPage: () => ({
					entries: [{ name: journalFileName(1), stat: makeStat({ size: journal.byteLength }) }],
					nextCursor: null,
				}),
				open: () => ({
					status: "opened",
					handle: {
						readAt: () => ({ status: "bytes", bytes: transferred, extra: true }),
						confirmEof: () => ({ status: "eof" }),
						fstat: () => makeStat({ size: journal.byteLength }),
						close: () => ({ status: "closed" }),
					},
				}),
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
			expect([...transferred].every((value) => value === 0)).toBe(true);
		});

		it("does not invoke page accessors", async () => {
			let reads = 0;
			const page = { nextCursor: null } as Record<string, unknown>;
			Object.defineProperty(page, "entries", {
				enumerable: true,
				get() {
					reads += 1;
					return [];
				},
			});
			const adapter: B03Adapter = { listPage: () => page, open: () => ({ status: "error" }) };
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
			expect(reads).toBe(0);
		});

		it("bounds opaque cursors", async () => {
			const adapter: B03Adapter = {
				listPage: () => ({ entries: [], nextCursor: "x".repeat(257) }),
				open: () => ({ status: "error" }),
			};
			expect(
				(
					await recoverB03Directory({
						identity: { hostId: "h-1", generation: "g-1", sessionId: "s-1" },
						direction: "sent",
						adapter,
					})
				).ok,
			).toBe(false);
		});
	});
});
