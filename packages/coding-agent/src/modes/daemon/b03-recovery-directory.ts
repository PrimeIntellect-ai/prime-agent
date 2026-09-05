import { types } from "node:util";
import type { DeliveryIdentity, DeliveryMarkerV1 } from "./b03-delivery-index-codec.js";
import { createRecoveryAccumulator, decodeDeliveryMarkerV1 } from "./b03-delivery-index-codec.js";
import type { JournalDirection, JournalRecordV1 } from "./b03-journal-record-codec.js";
import { decodeJournalRecordV1 } from "./b03-journal-record-codec.js";
import { CODEC_ERRORS, type CodecErrorCode } from "./remote-host-frame-codec.js";

const PAGE_MAX_ENTRIES = 64;
const PAGE_MAX_BYTES = 16_777_216;
const TOTAL_MAX_BYTES = 268_435_456;
const FILE_MAX_BYTES = 1_310_720;
const READ_MAX_BYTES = 65_536;
const MAX_JOURNALS = 20_000;
const MAX_MARKERS = 40_000;
const FILE_NAME = /^(\d{20})\.b03-(delivery|journal)$/;
const CURSOR = /^[A-Za-z0-9._~-]{1,256}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const INPUT_KEYS = new Set(["adapter", "direction", "identity"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const ADAPTER_KEYS = new Set(["listPage", "open"]);
const PAGE_KEYS = new Set(["entries", "nextCursor"]);
const ENTRY_KEYS = new Set(["name", "stat"]);
const STAT_KEYS = new Set(["ctimeNs", "dev", "ino", "isFile", "isSymlink", "mode", "mtimeNs", "nlink", "size", "uid"]);
const OPEN_ERROR_KEYS = new Set(["status"]);
const OPENED_KEYS = new Set(["handle", "status"]);
const HANDLE_KEYS = new Set(["close", "confirmEof", "fstat", "readAt"]);
const STATUS_KEYS = new Set(["status"]);
const BYTES_KEYS = new Set(["bytes", "status"]);

export const RECOVERY_ERRORS = Object.freeze({ ...CODEC_ERRORS, IO_UNCONFIRMED: "IO_UNCONFIRMED" } as const);
export type RecoveryErrorCode = CodecErrorCode | "IO_UNCONFIRMED";

export interface B03EntryStat {
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
	readonly mode: number;
	readonly size: number;
	readonly nlink: number;
	readonly isFile: boolean;
	readonly isSymlink: boolean;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
}
export interface B03Entry {
	readonly name: string;
	readonly stat: B03EntryStat;
}
export interface B03ListPageRequest {
	readonly cursor: string | null;
	readonly maxEntries: 64;
	readonly maxBytes: 16_777_216;
}
export interface B03Page {
	readonly entries: readonly B03Entry[];
	readonly nextCursor: string | null;
}
export interface B03OpenRequest {
	readonly name: string;
	readonly expected: B03EntryStat;
}
export type B03ReadOutcome =
	| Readonly<{ status: "bytes"; bytes: Uint8Array }>
	| Readonly<{ status: "eof" }>
	| Readonly<{ status: "error" }>;
export interface B03ReadHandle {
	readAt(offset: number, size: number): unknown;
	confirmEof(size: number): unknown;
	fstat(): unknown;
	close(): unknown;
}
export type B03OpenOutcome = Readonly<{ status: "opened"; handle: B03ReadHandle }> | Readonly<{ status: "error" }>;
export interface B03Adapter {
	listPage(request: B03ListPageRequest): unknown;
	open(request: B03OpenRequest): unknown;
}
export interface B03RecoveryInput {
	readonly identity: DeliveryIdentity;
	readonly direction: JournalDirection;
	readonly adapter: B03Adapter;
}
export interface RecoverB03DirectoryOk {
	readonly ok: true;
	readonly identity: DeliveryIdentity;
	readonly direction: JournalDirection;
	readonly journals: readonly JournalRecordV1[];
	readonly markers: readonly DeliveryMarkerV1[];
	readonly totalBytes: number;
}
export interface RecoverB03DirectoryError {
	readonly ok: false;
	readonly error: Readonly<{ code: RecoveryErrorCode }>;
}
export type RecoverB03DirectoryResult = RecoverB03DirectoryOk | RecoverB03DirectoryError;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundAdapter = Readonly<{
	listPage: (request: B03ListPageRequest) => unknown;
	open: (request: B03OpenRequest) => unknown;
}>;
type BoundHandle = Readonly<{
	readAt: (offset: number, size: number) => unknown;
	confirmEof: (size: number) => unknown;
	fstat: () => unknown;
	close: () => unknown;
}>;
type ParsedName = Readonly<{ kind: "journal" | "delivery"; sequence: number }>;
type DecodedFile =
	| Readonly<{ ok: true; kind: "journal"; record: JournalRecordV1; size: number }>
	| Readonly<{ ok: true; kind: "delivery"; marker: DeliveryMarkerV1; size: number }>
	| RecoverB03DirectoryError;

function fail(code: RecoveryErrorCode): RecoverB03DirectoryError {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}
function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const values = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const value = values[name];
			if (!value || !("value" in value) || !value.enumerable) return null;
		}
		return values;
	} catch {
		return null;
	}
}
function method(values: Descriptors, owner: object, name: string): (() => unknown) | null {
	const value = values[name]?.value;
	if (typeof value !== "function") return null;
	try {
		if (types.isProxy(value)) return null;
	} catch {
		return null;
	}
	return (...args: readonly unknown[]): unknown => Reflect.apply(value as CallableFunction, owner, args);
}
function validId(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return false;
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index);
		if (code <= 0x20 || code >= 0x7f) return false;
	}
	return true;
}
function snapshotIdentity(raw: unknown): DeliveryIdentity | null {
	const values = exact(raw, IDENTITY_KEYS);
	const hostId = values?.hostId?.value;
	const generation = values?.generation?.value;
	const sessionId = values?.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}
function bindAdapter(raw: unknown): BoundAdapter | null {
	const values = exact(raw, ADAPTER_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const listPage = method(values, raw, "listPage");
	const open = method(values, raw, "open");
	if (!listPage || !open) return null;
	return Object.freeze({
		listPage: (request: B03ListPageRequest): unknown => Reflect.apply(listPage, undefined, [request]),
		open: (request: B03OpenRequest): unknown => Reflect.apply(open, undefined, [request]),
	});
}
function decimal(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length <= 64 && DECIMAL.test(raw);
}
function safeInteger(raw: unknown): raw is number {
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}
function snapshotStat(raw: unknown): B03EntryStat | null {
	const value = exact(raw, STAT_KEYS);
	if (!value) return null;
	const dev = value.dev?.value;
	const ino = value.ino?.value;
	const uid = value.uid?.value;
	const mode = value.mode?.value;
	const size = value.size?.value;
	const nlink = value.nlink?.value;
	const isFile = value.isFile?.value;
	const isSymlink = value.isSymlink?.value;
	const mtimeNs = value.mtimeNs?.value;
	const ctimeNs = value.ctimeNs?.value;
	if (
		!decimal(dev) ||
		!decimal(ino) ||
		!decimal(uid) ||
		!safeInteger(mode) ||
		!safeInteger(size) ||
		!safeInteger(nlink) ||
		typeof isFile !== "boolean" ||
		typeof isSymlink !== "boolean" ||
		!decimal(mtimeNs) ||
		!decimal(ctimeNs)
	)
		return null;
	return Object.freeze({ dev, ino, uid, mode, size, nlink, isFile, isSymlink, mtimeNs, ctimeNs });
}
function snapshotEntry(raw: unknown): B03Entry | null {
	const value = exact(raw, ENTRY_KEYS);
	const name = value?.name?.value;
	const stat = snapshotStat(value?.stat?.value);
	return typeof name === "string" && stat ? Object.freeze({ name, stat }) : null;
}
function snapshotPage(raw: unknown): B03Page | null {
	const value = exact(raw, PAGE_KEYS);
	const entriesRaw = value?.entries?.value;
	const nextCursor = value?.nextCursor?.value;
	if (!Array.isArray(entriesRaw) || entriesRaw.length > PAGE_MAX_ENTRIES) return null;
	try {
		if (types.isProxy(entriesRaw) || Object.getPrototypeOf(entriesRaw) !== Array.prototype) return null;
	} catch {
		return null;
	}
	if (nextCursor !== null && (typeof nextCursor !== "string" || !CURSOR.test(nextCursor))) return null;
	const entries: B03Entry[] = [];
	for (let index = 0; index < entriesRaw.length; index += 1) {
		if (!Object.hasOwn(entriesRaw, index)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(entriesRaw, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		const entry = snapshotEntry(descriptor.value);
		if (!entry) return null;
		entries.push(entry);
	}
	const names = Object.getOwnPropertyNames(entriesRaw);
	if (names.length !== entriesRaw.length + 1 || names.at(-1) !== "length") return null;
	return Object.freeze({ entries: Object.freeze(entries), nextCursor });
}
function parseName(name: string): ParsedName | null {
	const match = FILE_NAME.exec(name);
	if (!match) return null;
	const sequence = Number(match[1]);
	const kind = match[2];
	if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
	if (kind === "journal" && sequence <= MAX_JOURNALS) return Object.freeze({ kind, sequence });
	if (kind === "delivery" && sequence <= MAX_MARKERS) return Object.freeze({ kind, sequence });
	return null;
}
function statEqual(left: B03EntryStat, right: B03EntryStat): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.nlink === right.nlink &&
		left.isFile === right.isFile &&
		left.isSymlink === right.isSymlink &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}
function bindHandle(raw: unknown): BoundHandle | null {
	const values = exact(raw, HANDLE_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const readAt = method(values, raw, "readAt");
	const confirmEof = method(values, raw, "confirmEof");
	const fstat = method(values, raw, "fstat");
	const close = method(values, raw, "close");
	if (!readAt || !confirmEof || !fstat || !close) return null;
	return Object.freeze({
		readAt: (offset: number, size: number): unknown => Reflect.apply(readAt, undefined, [offset, size]),
		confirmEof: (size: number): unknown => Reflect.apply(confirmEof, undefined, [size]),
		fstat: (): unknown => Reflect.apply(fstat, undefined, []),
		close: (): unknown => Reflect.apply(close, undefined, []),
	});
}
function discoverClose(raw: unknown): (() => unknown) | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (
			!descriptor ||
			!("value" in descriptor) ||
			typeof descriptor.value !== "function" ||
			types.isProxy(descriptor.value)
		)
			return null;
		const close = descriptor.value;
		return (): unknown => Reflect.apply(close as CallableFunction, raw, []);
	} catch {
		return null;
	}
}
async function checkedClose(close: () => unknown): Promise<boolean> {
	try {
		const raw = await close();
		const value = exact(raw, STATUS_KEYS);
		return value?.status?.value === "closed";
	} catch {
		return false;
	}
}
function ownData(raw: unknown, name: string): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}
async function inspectOpen(
	raw: unknown,
): Promise<{ kind: "opened"; handle: BoundHandle } | { kind: "error"; error: RecoverB03DirectoryError }> {
	const handleRaw = ownData(raw, "handle");
	const cleanup = discoverClose(handleRaw);
	const error = exact(raw, OPEN_ERROR_KEYS);
	if (error?.status?.value === "error") return { kind: "error", error: fail("IO_UNCONFIRMED") };
	const opened = exact(raw, OPENED_KEYS);
	if (opened?.status?.value !== "opened" || !cleanup) {
		if (cleanup && !(await checkedClose(cleanup))) return { kind: "error", error: fail("IO_UNCONFIRMED") };
		return { kind: "error", error: fail("INVALID_FRAME") };
	}
	const handle = bindHandle(handleRaw);
	if (handle) return { kind: "opened", handle };
	return { kind: "error", error: (await checkedClose(cleanup)) ? fail("INVALID_FRAME") : fail("IO_UNCONFIRMED") };
}

const TYPED_ARRAY_PROTO = Object.getPrototypeOf(Uint8Array.prototype) as object;
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteLength")?.get;
const BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "byteOffset")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTO, "buffer")?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
function eraseTransferred(raw: unknown): void {
	try {
		if (typeof raw !== "object" || raw === null || types.isProxy(raw) || !BYTE_LENGTH_GETTER) return;
		const length = Reflect.apply(BYTE_LENGTH_GETTER, raw, []) as number;
		if (length > 0) Uint8Array.prototype.fill.call(raw, 0);
	} catch {
		// Proxies, detached buffers, and unrelated objects are not safely writable.
	}
}

function exactTransferred(raw: unknown): raw is Uint8Array {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			!BYTE_LENGTH_GETTER ||
			!BYTE_OFFSET_GETTER ||
			!BUFFER_GETTER ||
			!ARRAY_BUFFER_LENGTH_GETTER
		)
			return false;
		if (
			Object.getOwnPropertyDescriptor(raw, "buffer") ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset")
		)
			return false;
		const byteLength = Reflect.apply(BYTE_LENGTH_GETTER, raw, []) as number;
		const byteOffset = Reflect.apply(BYTE_OFFSET_GETTER, raw, []) as number;
		const buffer = Reflect.apply(BUFFER_GETTER, raw, []) as unknown;
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
		)
			return false;
		const backingLength = Reflect.apply(ARRAY_BUFFER_LENGTH_GETTER, buffer, []) as number;
		return byteOffset === 0 && byteLength === backingLength && byteLength > 0;
	} catch {
		return false;
	}
}
function readStatus(raw: unknown): "eof" | "error" | null {
	const value = exact(raw, STATUS_KEYS)?.status?.value;
	return value === "eof" || value === "error" ? value : null;
}
function bytesValue(raw: unknown): unknown {
	const value = exact(raw, BYTES_KEYS);
	return value?.status?.value === "bytes" ? value.bytes?.value : undefined;
}
function discoverBytes(raw: unknown): unknown {
	return ownData(raw, "bytes");
}

async function readFile(
	entry: B03Entry,
	parsed: ParsedName,
	identity: DeliveryIdentity,
	direction: JournalDirection,
	adapter: BoundAdapter,
): Promise<DecodedFile> {
	let rawOpen: unknown;
	try {
		rawOpen = await adapter.open(Object.freeze({ name: entry.name, expected: entry.stat }));
	} catch {
		return fail("IO_UNCONFIRMED");
	}
	const inspected = await inspectOpen(rawOpen);
	if (inspected.kind === "error") return inspected.error;
	const handle = inspected.handle;
	let bytes = new Uint8Array(0);
	let outcome: DecodedFile;
	const consume = async (): Promise<DecodedFile> => {
		const initial = snapshotStat(await handle.fstat());
		if (!initial || !statEqual(initial, entry.stat)) return fail("MISMATCH");
		bytes = new Uint8Array(entry.stat.size);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const requested = Math.min(READ_MAX_BYTES, bytes.byteLength - offset);
			const rawRead = await handle.readAt(offset, requested);
			const transferred = bytesValue(rawRead);
			if (transferred === undefined) {
				eraseTransferred(discoverBytes(rawRead));
				if (readStatus(rawRead) === "error") return fail("IO_UNCONFIRMED");
				return fail("INVALID_FRAME");
			}
			if (!exactTransferred(transferred)) {
				eraseTransferred(transferred);
				return fail("INVALID_FRAME");
			}
			try {
				if (transferred.byteLength > requested) return fail("OVERFLOW");
				bytes.set(transferred, offset);
				offset += transferred.byteLength;
			} finally {
				eraseTransferred(transferred);
			}
		}
		const eof = await handle.confirmEof(bytes.byteLength);
		const eofStatus = readStatus(eof);
		if (eofStatus !== "eof") return fail(eofStatus === "error" ? "IO_UNCONFIRMED" : "INVALID_FRAME");
		const final = snapshotStat(await handle.fstat());
		if (!final || !statEqual(initial, final)) return fail("MISMATCH");
		if (parsed.kind === "journal") {
			const decoded = decodeJournalRecordV1(
				bytes,
				Object.freeze({
					journalSeq: parsed.sequence,
					hostId: identity.hostId,
					generation: identity.generation,
					sessionId: identity.sessionId,
					direction,
				}),
			);
			bytes = new Uint8Array(0);
			return decoded.ok
				? Object.freeze({
						ok: true as const,
						kind: "journal" as const,
						record: decoded.record,
						size: entry.stat.size,
					})
				: fail(decoded.error.code);
		}
		const decoded = decodeDeliveryMarkerV1(
			bytes,
			Object.freeze({
				indexSeq: parsed.sequence,
				hostId: identity.hostId,
				generation: identity.generation,
				sessionId: identity.sessionId,
				direction,
			}),
		);
		bytes = new Uint8Array(0);
		return decoded.ok
			? Object.freeze({
					ok: true as const,
					kind: "delivery" as const,
					marker: decoded.marker,
					size: entry.stat.size,
				})
			: fail(decoded.error.code);
	};
	let closeOk = false;
	try {
		outcome = await consume();
	} catch {
		outcome = fail("IO_UNCONFIRMED");
	} finally {
		try {
			bytes.fill(0);
		} finally {
			closeOk = await checkedClose(handle.close);
		}
	}
	return closeOk ? outcome : fail("IO_UNCONFIRMED");
}

export async function recoverB03Directory(raw: unknown): Promise<RecoverB03DirectoryResult> {
	try {
		const input = exact(raw, INPUT_KEYS);
		const identity = snapshotIdentity(input?.identity?.value);
		const directionRaw = input?.direction?.value;
		const direction: JournalDirection | null =
			directionRaw === "sent" || directionRaw === "received" ? directionRaw : null;
		const adapter = bindAdapter(input?.adapter?.value);
		if (!identity) return fail("INVALID_IDENTITY");
		if (!direction || !adapter) return fail("INVALID_FRAME");
		const journalRecords: JournalRecordV1[] = [];
		const markerRecords: DeliveryMarkerV1[] = [];
		const journalBySequence = new Map<number, JournalRecordV1>();
		const frameIds = new Map<string, Readonly<{ digest: string; direction: JournalDirection }>>();
		const seenCursors = new Set<string>();
		let cursor: string | null = null;
		let lastName: string | null = null;
		let nextJournal = 1;
		let nextMarker = 1;
		let totalBytes = 0;
		for (;;) {
			let rawPage: unknown;
			try {
				rawPage = await adapter.listPage(
					Object.freeze({ cursor, maxEntries: PAGE_MAX_ENTRIES as 64, maxBytes: PAGE_MAX_BYTES as 16_777_216 }),
				);
			} catch {
				return fail("IO_UNCONFIRMED");
			}
			const page = snapshotPage(rawPage);
			if (!page) return fail("INVALID_FRAME");
			if (page.entries.length === 0 && page.nextCursor !== null) return fail("INVALID_FRAME");
			if (page.nextCursor !== null && (page.nextCursor === cursor || seenCursors.has(page.nextCursor)))
				return fail("INVALID_SEQUENCE");
			let prospectiveLast: string | null = lastName;
			let prospectiveJournal = nextJournal;
			let prospectiveMarker = nextMarker;
			let pageBytes = 0;
			const parsedEntries: Array<Readonly<{ entry: B03Entry; parsed: ParsedName }>> = [];
			for (const entry of page.entries) {
				const parsed = parseName(entry.name);
				if (!parsed || (prospectiveLast !== null && prospectiveLast >= entry.name)) return fail("INVALID_SEQUENCE");
				if (!entry.stat.isFile || entry.stat.isSymlink || entry.stat.mode !== 0o600 || entry.stat.nlink !== 1)
					return fail("MISMATCH");
				if (entry.stat.size < 1 || entry.stat.size > FILE_MAX_BYTES) return fail("OVERFLOW");
				pageBytes += entry.stat.size;
				if (!Number.isSafeInteger(pageBytes) || pageBytes > PAGE_MAX_BYTES) return fail("OVERFLOW");
				if (parsed.kind === "journal") {
					if (parsed.sequence !== prospectiveJournal) return fail("INVALID_SEQUENCE");
					prospectiveJournal += 1;
				} else {
					if (parsed.sequence !== prospectiveMarker) return fail("INVALID_SEQUENCE");
					prospectiveMarker += 1;
				}
				prospectiveLast = entry.name;
				parsedEntries.push(Object.freeze({ entry, parsed }));
			}
			if (totalBytes + pageBytes > TOTAL_MAX_BYTES) return fail("OVERFLOW");
			const pageJournals: JournalRecordV1[] = [];
			const pageMarkers: DeliveryMarkerV1[] = [];
			const pageFrameIds = new Map<string, Readonly<{ digest: string; direction: JournalDirection }>>();
			for (const item of parsedEntries) {
				const decoded = await readFile(item.entry, item.parsed, identity, direction, adapter);
				if (!decoded.ok) return decoded;
				if (decoded.kind === "journal") {
					const key = decoded.record.envelope.frameId;
					const existing = pageFrameIds.get(key) ?? frameIds.get(key);
					if (
						existing &&
						(existing.digest !== decoded.record.envelopeDigest || existing.direction !== decoded.record.direction)
					)
						return fail("MISMATCH");
					pageFrameIds.set(
						key,
						Object.freeze({ digest: decoded.record.envelopeDigest, direction: decoded.record.direction }),
					);
					pageJournals.push(decoded.record);
				} else pageMarkers.push(decoded.marker);
			}
			for (const record of pageJournals) {
				journalRecords.push(record);
				journalBySequence.set(record.journalSeq, record);
			}
			markerRecords.push(...pageMarkers);
			for (const [key, value] of pageFrameIds) frameIds.set(key, value);
			totalBytes += pageBytes;
			lastName = prospectiveLast;
			nextJournal = prospectiveJournal;
			nextMarker = prospectiveMarker;
			if (page.nextCursor === null) break;
			seenCursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		for (const marker of markerRecords) {
			const journal = journalBySequence.get(marker.journalSeq);
			if (
				!journal ||
				journal.envelope.frameId !== marker.frameId ||
				journal.envelopeDigest !== marker.envelopeDigest ||
				journal.direction !== marker.direction ||
				journal.hostId !== marker.hostId ||
				journal.generation !== marker.generation ||
				journal.sessionId !== marker.sessionId
			)
				return fail("MISMATCH");
		}
		const recovery = createRecoveryAccumulator(identity, direction);
		if (!recovery.ok) return fail(recovery.error.code);
		for (const marker of markerRecords) {
			const applied = recovery.accumulator.ingest(marker);
			if (!applied.ok) return fail(applied.error.code);
		}
		return Object.freeze({
			ok: true as const,
			identity,
			direction,
			journals: Object.freeze(journalRecords),
			markers: Object.freeze(markerRecords),
			totalBytes,
		});
	} catch {
		return fail("INVALID_FRAME");
	}
}
