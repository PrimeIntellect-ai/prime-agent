import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Result and option types — journal records
// ---------------------------------------------------------------------------

export type PublishResult =
	| { readonly status: "success"; readonly seq: number; readonly size: number; readonly sha256: string }
	| { readonly status: "IO_UNCONFIRMED" }
	| { readonly status: "SEQ_COLLISION"; readonly seq: number }
	| {
			readonly status: "POST_PUBLICATION_UNCERTAIN";
			readonly seq: number;
			readonly size: number;
			readonly sha256: string;
	  }
	| { readonly status: "INVALID_ARGUMENT" };

export interface PublishOptions {
	journalDir: string;
	seq: number;
	bytes: Uint8Array;
}

/** Versioned journal record suffix shared with the scanner layout. */
export const JOURNAL_RECORD_SUFFIX = ".b03-journal";

// ---------------------------------------------------------------------------
// Result and option types — delivery markers
// ---------------------------------------------------------------------------

export type DeliveryMarkerPublishResult =
	| {
			readonly status: "success";
			readonly sequence: number;
			readonly size: number;
			readonly sha256: string;
	  }
	| { readonly status: "IO_UNCONFIRMED" }
	| { readonly status: "SEQ_COLLISION"; readonly sequence: number }
	| {
			readonly status: "POST_PUBLICATION_UNCERTAIN";
			readonly sequence: number;
			readonly size: number;
			readonly sha256: string;
	  }
	| { readonly status: "INVALID_ARGUMENT" };

export interface DeliveryMarkerPublishOptions {
	journalDir: string;
	indexSeq: number;
	bytes: Uint8Array;
}

/** Delivery-index marker suffix shared with the scanner layout. */
export const DELIVERY_MARKER_SUFFIX = ".b03-delivery";

// ---------------------------------------------------------------------------
// Private kind descriptors — the only internal parameterization
// ---------------------------------------------------------------------------

interface PublishKind {
	readonly suffix: string;
	readonly maxSeq: number;
	readonly optionKeys: readonly string[];
	readonly seqKey: string;
	readonly fileName: (seq: number) => string;
}

const JOURNAL_KIND: PublishKind = {
	suffix: JOURNAL_RECORD_SUFFIX,
	maxSeq: 20000,
	optionKeys: Object.freeze(["journalDir", "seq", "bytes"]),
	seqKey: "seq",
	fileName(seq: number): string {
		if (!Number.isSafeInteger(seq) || seq < 0 || seq > JOURNAL_KIND.maxSeq) return "";
		return `${String(seq).padStart(20, "0")}${JOURNAL_RECORD_SUFFIX}`;
	},
};

const DELIVERY_KIND: PublishKind = {
	suffix: DELIVERY_MARKER_SUFFIX,
	maxSeq: 40000,
	optionKeys: Object.freeze(["journalDir", "indexSeq", "bytes"]),
	seqKey: "indexSeq",
	fileName(seq: number): string {
		if (!Number.isSafeInteger(seq) || seq < 0 || seq > DELIVERY_KIND.maxSeq) return "";
		return `${String(seq).padStart(20, "0")}${DELIVERY_MARKER_SUFFIX}`;
	},
};

// ---------------------------------------------------------------------------
// IO abstraction
// ---------------------------------------------------------------------------

export interface IoStats {
	readonly dev: number;
	readonly ino: number;
	readonly mode: number;
	readonly nlink: number;
	readonly uid: number;
	readonly size: number;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
}

export interface IoHandle {
	fstat(): Promise<IoStats>;
	read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<number>;
	write(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<number>;
	fsync(): Promise<void>;
	close(): Promise<void>;
}

export interface JournalIo {
	lstat(path: string): Promise<IoStats>;
	realpath(path: string): Promise<string>;
	open(path: string, flags: number, mode?: number): Promise<IoHandle>;
	/** Allocation seam — tests override to observe internal buffer erasure. */
	allocateBuffer(size: number): Uint8Array;
}

// ---------------------------------------------------------------------------
// Node FileHandle duck-type (avoids inline import)
// ---------------------------------------------------------------------------

interface FsHandle {
	stat(): Promise<{
		dev: number;
		ino: number;
		mode: number;
		nlink: number;
		uid: number;
		size: number;
		isFile(): boolean;
		isDirectory(): boolean;
	}>;
	read(buf: Uint8Array, off: number, len: number, pos: number): Promise<{ bytesRead: number }>;
	write(buf: Uint8Array, off: number, len: number, pos: number | null): Promise<{ bytesWritten: number }>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Real implementation
// ---------------------------------------------------------------------------

function convStats(s: {
	dev: number;
	ino: number;
	mode: number;
	nlink: number;
	uid: number;
	size: number;
	isFile(): boolean;
	isDirectory(): boolean;
}): IoStats {
	return Object.freeze({
		dev: s.dev,
		ino: s.ino,
		mode: s.mode,
		nlink: s.nlink,
		uid: s.uid,
		size: s.size,
		isFile: s.isFile(),
		isDirectory: s.isDirectory(),
	});
}

class RealHandle implements IoHandle {
	constructor(private readonly fd: FsHandle) {}
	async fstat(): Promise<IoStats> {
		return convStats(await this.fd.stat());
	}
	async read(b: Uint8Array, o: number, l: number, p: number): Promise<number> {
		const { bytesRead } = await this.fd.read(b, o, l, p);
		if (!Number.isSafeInteger(bytesRead) || bytesRead < 0) throw new Error();
		return bytesRead;
	}
	async write(b: Uint8Array, o: number, l: number, p: number | null): Promise<number> {
		const { bytesWritten } = await this.fd.write(b, o, l, p);
		if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0) throw new Error();
		return bytesWritten;
	}
	async fsync(): Promise<void> {
		await this.fd.sync();
	}
	async close(): Promise<void> {
		await this.fd.close();
	}
}

export class RealJournalIo implements JournalIo {
	allocateBuffer(size: number): Uint8Array {
		return new Uint8Array(size);
	}
	async lstat(path: string): Promise<IoStats> {
		return convStats(await lstat(path));
	}
	async realpath(path: string): Promise<string> {
		return await realpath(path);
	}
	async open(path: string, flags: number, mode?: number): Promise<IoHandle> {
		return new RealHandle(await open(path, flags, mode));
	}
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_BYTES = 1_310_720;
const MAX_DIR_LEN = 4096;
const SCRATCH_SIZE = 65_536;
const NO_SPECIAL = 0o7000;
const STAT_KEYS: readonly string[] = Object.freeze([
	"dev",
	"ino",
	"mode",
	"nlink",
	"uid",
	"size",
	"isFile",
	"isDirectory",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getUid(): number | undefined {
	try {
		return process.getuid?.();
	} catch {
		return undefined;
	}
}

// Non-throwing intrinsic erase; never calls attacker-overridden methods.
function eraseIntrinsic(b: Uint8Array | null | undefined): void {
	if (b == null) return;
	try {
		Uint8Array.prototype.fill.call(b, 0);
	} catch {
		/* ignore */
	}
}

// ---- Exact own-value from descriptor .value; never getter / Proxy trap ----

function ownValue(obj: object, key: string): unknown {
	try {
		const desc = Object.getOwnPropertyDescriptor(obj, key);
		if (desc === undefined || !desc.enumerable || desc.get !== undefined) return undefined;
		return desc.value;
	} catch {
		return undefined;
	}
}

// ---- Chain descriptor lookup through prototypes (getter-safe) ----

function chainDesc(obj: object, key: string): PropertyDescriptor | undefined {
	let cur: object | null = obj;
	const seen = new Set<object>();
	while (cur !== null && !seen.has(cur)) {
		seen.add(cur);
		let desc: PropertyDescriptor | undefined;
		try {
			desc = Object.getOwnPropertyDescriptor(cur, key);
		} catch {
			return undefined;
		}
		if (desc !== undefined) return desc;
		try {
			cur = Object.getPrototypeOf(cur);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function chainFunc(obj: object, key: string): ((...args: never[]) => unknown) | undefined {
	const desc = chainDesc(obj, key);
	if (desc === undefined || desc.get !== undefined || desc.set !== undefined) return undefined;
	return typeof desc.value === "function" ? (desc.value as (...args: never[]) => unknown) : undefined;
}

// ---- Intrinsic detached detection (slice on a detached buffer throws) ----

function isDetached(buf: ArrayBuffer): boolean {
	try {
		ArrayBuffer.prototype.slice.call(buf, 0, 0);
		return false;
	} catch {
		return true;
	}
}

// ---- Strict genuine-Uint8Array validation ----

function isGenuineBytes(v: unknown): v is Uint8Array {
	try {
		if (!(v instanceof Uint8Array)) return false;
		if (Object.getPrototypeOf(v) !== Uint8Array.prototype) return false;
		if (!(v.buffer instanceof ArrayBuffer)) return false;
		if (v.byteOffset !== 0) return false;
		if (v.byteLength !== v.buffer.byteLength) return false;
		if (isDetached(v.buffer)) return false;
		return true;
	} catch {
		return false;
	}
}

// ---- Error classification via own data descriptor only ----

function isEexist(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	try {
		const desc = Object.getOwnPropertyDescriptor(err, "code");
		if (!desc || !desc.enumerable || desc.get !== undefined) return false;
		return desc.value === "EEXIST";
	} catch {
		return false;
	}
}

// ---- Exact stat DTO snapshot: fixed own data keys, no extras/accessors ----

interface StatsSnap {
	readonly dev: number;
	readonly ino: number;
	readonly mode: number;
	readonly nlink: number;
	readonly uid: number;
	readonly size: number;
	readonly isFile: boolean;
	readonly isDirectory: boolean;
}

function isSafeUint(x: unknown): x is number {
	return typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
}

function snapStats(st: unknown): StatsSnap | null {
	if (typeof st !== "object" || st === null) return null;
	try {
		const names = Object.getOwnPropertyNames(st);
		const syms = Object.getOwnPropertySymbols(st);
		if (syms.length > 0 || names.length !== STAT_KEYS.length) return null;
		for (const k of names) {
			if (!STAT_KEYS.includes(k)) return null;
		}
		const dev = ownValue(st, "dev");
		const ino = ownValue(st, "ino");
		const mode = ownValue(st, "mode");
		const nlink = ownValue(st, "nlink");
		const uid = ownValue(st, "uid");
		const size = ownValue(st, "size");
		const isFile = ownValue(st, "isFile");
		const isDirectory = ownValue(st, "isDirectory");
		if (
			!isSafeUint(dev) ||
			!isSafeUint(ino) ||
			!isSafeUint(mode) ||
			!isSafeUint(nlink) ||
			!isSafeUint(uid) ||
			!isSafeUint(size)
		) {
			return null;
		}
		if (typeof isFile !== "boolean" || typeof isDirectory !== "boolean") return null;
		return Object.freeze({ dev, ino, mode, nlink, uid, size, isFile, isDirectory });
	} catch {
		return null;
	}
}

// ---- Frozen result construction ----

function resSuccess(seq: number, size: number, sha: string): PublishResult {
	return Object.freeze({ status: "success" as const, seq, size, sha256: sha });
}
function resCollision(seq: number): PublishResult {
	return Object.freeze({ status: "SEQ_COLLISION" as const, seq });
}
function resUncertain(seq: number, size: number, sha: string): PublishResult {
	return Object.freeze({ status: "POST_PUBLICATION_UNCERTAIN" as const, seq, size, sha256: sha });
}
function resSimple(s: "IO_UNCONFIRMED" | "INVALID_ARGUMENT"): PublishResult {
	return Object.freeze({ status: s });
}

// ---- Delivery result construction (maps sequence -> sequence) ----

function delResSuccess(seq: number, size: number, sha: string): DeliveryMarkerPublishResult {
	return Object.freeze({ status: "success" as const, sequence: seq, size, sha256: sha });
}
function delResCollision(seq: number): DeliveryMarkerPublishResult {
	return Object.freeze({ status: "SEQ_COLLISION" as const, sequence: seq });
}
function delResUncertain(seq: number, size: number, sha: string): DeliveryMarkerPublishResult {
	return Object.freeze({
		status: "POST_PUBLICATION_UNCERTAIN" as const,
		sequence: seq,
		size,
		sha256: sha,
	});
}
function delResSimple(s: "IO_UNCONFIRMED" | "INVALID_ARGUMENT"): DeliveryMarkerPublishResult {
	return Object.freeze({ status: s });
}

// ---- Identity type ----

interface DirId {
	readonly dev: number;
	readonly ino: number;
	readonly mode: number;
	readonly uid: number;
}

// ---- Caller bytes discovery: exact own data-descriptor, no getters ----

function discoverGenuineBytes(options: unknown): Uint8Array | undefined {
	if (typeof options !== "object" || options === null) return undefined;
	const bytes = ownValue(options, "bytes");
	if (!isGenuineBytes(bytes)) return undefined;
	return bytes as Uint8Array;
}

// ---- Options snapshot: exact keys, descriptor values only ----

interface OptionsSnap {
	readonly journalDir: string;
	readonly seq: number;
}

function snapshotOptions(options: unknown, knownBytes: Uint8Array | undefined, kind: PublishKind): OptionsSnap | null {
	if (typeof options !== "object" || options === null) return null;
	if (knownBytes === undefined) return null;
	let names: string[];
	let syms: symbol[];
	try {
		names = Object.getOwnPropertyNames(options);
		syms = Object.getOwnPropertySymbols(options);
	} catch {
		return null;
	}
	if (syms.length > 0) return null;
	if (names.length !== kind.optionKeys.length) return null;
	for (const k of names) {
		if (!kind.optionKeys.includes(k)) return null;
	}
	// bytes must be an enumerable data descriptor carrying the discovered buffer
	const bDesc = Object.getOwnPropertyDescriptor(options, "bytes");
	if (!bDesc || !bDesc.enumerable || bDesc.get !== undefined || bDesc.value !== knownBytes) return null;
	const journalDir = ownValue(options, "journalDir");
	const seq = ownValue(options, kind.seqKey);
	if (journalDir === undefined || seq === undefined) return null;
	if (typeof journalDir !== "string") return null;
	if (typeof seq !== "number" || !Number.isInteger(seq)) return null;
	return Object.freeze({ journalDir, seq });
}

// ---- IO adapter snapshot from descriptor values, bound once ----

interface IoSnap {
	lstat(path: string): Promise<IoStats>;
	realpath(path: string): Promise<string>;
	open(path: string, flags: number, mode?: number): Promise<IoHandle>;
	allocateBuffer(size: number): Uint8Array;
}

function snapshotIo(io: unknown): IoSnap | null {
	if (typeof io !== "object" || io === null) return null;
	try {
		const lstat = chainFunc(io, "lstat");
		const realpath = chainFunc(io, "realpath");
		const open = chainFunc(io, "open");
		const allocateBuffer = chainFunc(io, "allocateBuffer");
		if (lstat === undefined || realpath === undefined || open === undefined || allocateBuffer === undefined) {
			return null;
		}
		const ioObj = io as object;
		return {
			lstat: lstat.bind(ioObj) as IoSnap["lstat"],
			realpath: realpath.bind(ioObj) as IoSnap["realpath"],
			open: open.bind(ioObj) as IoSnap["open"],
			allocateBuffer: allocateBuffer.bind(ioObj) as IoSnap["allocateBuffer"],
		};
	} catch {
		return null;
	}
}

// ---- Handle ownership guard: bind close first, then the rest ----

async function snapHandleOwned(raw: unknown): Promise<IoHandle | null> {
	if (typeof raw !== "object" || raw === null) return null;
	const closeFn = chainFunc(raw, "close");
	if (closeFn === undefined) return null;
	const obj = raw as object;
	const close = closeFn.bind(obj) as IoHandle["close"];
	const fstat = chainFunc(raw, "fstat");
	const read = chainFunc(raw, "read");
	const write = chainFunc(raw, "write");
	const fsync = chainFunc(raw, "fsync");
	if (fstat === undefined || read === undefined || write === undefined || fsync === undefined) {
		// Close exactly once, best-effort; never lose raw handle ownership.
		try {
			await close();
		} catch {
			/* ignore */
		}
		return null;
	}
	return {
		fstat: fstat.bind(obj) as IoHandle["fstat"],
		read: read.bind(obj) as IoHandle["read"],
		write: write.bind(obj) as IoHandle["write"],
		fsync: fsync.bind(obj) as IoHandle["fsync"],
		close,
	};
}

// ---- Confirmed close: exactly one attempt, checked outcome ----

async function confirmedClose(h: IoHandle): Promise<boolean> {
	try {
		await h.close();
		return true;
	} catch {
		return false;
	}
}

// ---- Directory fsync: identity-verified before fsync, single close ----

async function fsyncDir(io: IoSnap, dir: string, expected: DirId): Promise<boolean> {
	let fh: IoHandle | null = null;
	try {
		const raw = await io.open(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		fh = await snapHandleOwned(raw);
		if (fh === null) return false;
		const st = snapStats(await fh.fstat());
		if (
			st === null ||
			!st.isDirectory ||
			st.isFile ||
			(st.mode & 0o777) !== 0o700 ||
			(st.mode & NO_SPECIAL) !== 0 ||
			st.uid !== expected.uid ||
			st.dev !== expected.dev ||
			st.ino !== expected.ino
		) {
			const f = fh;
			fh = null;
			await confirmedClose(f);
			return false;
		}
		await fh.fsync();
		const f = fh;
		fh = null;
		return await confirmedClose(f);
	} catch {
		if (fh !== null) {
			const f = fh;
			fh = null;
			await confirmedClose(f);
		}
		return false;
	}
}

// ---- Directory identity match ----

async function dirMatch(io: IoSnap, dir: string, expected: DirId): Promise<boolean> {
	try {
		const st = snapStats(await io.lstat(dir));
		return (
			st !== null &&
			st.isDirectory &&
			!st.isFile &&
			(st.mode & 0o777) === 0o700 &&
			(st.mode & NO_SPECIAL) === 0 &&
			st.uid === expected.uid &&
			st.dev === expected.dev &&
			st.ino === expected.ino
		);
	} catch {
		return false;
	}
}

// ---- Content verification: bounded 64KiB scratch + one-byte EOF ----

async function verifyContent(fh: IoHandle, expect: Uint8Array, scratch: Uint8Array): Promise<boolean> {
	let pos = 0;
	while (pos < expect.length) {
		const n = Math.min(scratch.length, expect.length - pos);
		let br: number;
		try {
			br = await fh.read(scratch, 0, n, pos);
		} catch {
			return false;
		}
		if (!Number.isSafeInteger(br) || br !== n) return false;
		for (let i = 0; i < n; i++) {
			if (scratch[i] !== expect[pos + i]) return false;
		}
		pos += n;
	}
	let eof: number;
	try {
		eof = await fh.read(scratch, 0, 1, pos);
	} catch {
		return false;
	}
	return Number.isSafeInteger(eof) && eof === 0;
}

// ---------------------------------------------------------------------------
// Core publication — direct-final no-replace design, parameterized by kind
// ---------------------------------------------------------------------------

async function publishCore(
	io: IoSnap,
	owned: Uint8Array,
	sha: string,
	journalDir: string,
	dirId: DirId,
	finalP: string,
	seq: number,
	scratch: Uint8Array,
): Promise<PublishResult> {
	const uid = getUid();
	if (uid === undefined) return resSimple("IO_UNCONFIRMED");

	// Reverify directory before the reservation open.
	if (!(await dirMatch(io, journalDir, dirId))) return resSimple("IO_UNCONFIRMED");

	// Reservation/publication point: exclusive no-replace create of the final
	// record. No staging, no link, no unlink.
	let fh: IoHandle | null = null;
	try {
		const raw = await io.open(
			finalP,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		fh = await snapHandleOwned(raw);
	} catch (openErr: unknown) {
		if (isEexist(openErr)) return resCollision(seq);
		// Any other open/snapshot error: the final may exist. Preserve, uncertain.
		return resUncertain(seq, owned.length, sha);
	}
	if (fh === null) return resUncertain(seq, owned.length, sha);

	// Final open succeeded — never delete evidence on any later failure.
	try {
		const st = snapStats(await fh.fstat());
		if (
			st === null ||
			!st.isFile ||
			st.isDirectory ||
			(st.mode & 0o777) !== 0o600 ||
			(st.mode & NO_SPECIAL) !== 0 ||
			st.uid !== uid ||
			st.nlink !== 1 ||
			st.size !== 0
		) {
			return resUncertain(seq, owned.length, sha);
		}
		const dev = st.dev;
		const ino = st.ino;

		// Exact positional write loop.
		let written = 0;
		while (written < owned.length) {
			const chunkLen = Math.min(SCRATCH_SIZE, owned.length - written);
			let bw: number;
			try {
				bw = await fh.write(owned, written, chunkLen, written);
			} catch {
				return resUncertain(seq, owned.length, sha);
			}
			if (!Number.isSafeInteger(bw) || bw < 1 || bw > chunkLen) {
				return resUncertain(seq, owned.length, sha);
			}
			written += bw;
		}

		// File fsync.
		try {
			await fh.fsync();
		} catch {
			return resUncertain(seq, owned.length, sha);
		}

		// Exactly one checked close of the write handle.
		const f = fh;
		fh = null;
		if (!(await confirmedClose(f))) return resUncertain(seq, owned.length, sha);

		// Reopen O_RDONLY|O_NOFOLLOW: same dev/ino, content, mode, uid, nlink=1.
		let verifyOk = false;
		let reopenCloseFailed = false;
		try {
			const raw2 = await io.open(finalP, constants.O_RDONLY | constants.O_NOFOLLOW);
			const fh2 = await snapHandleOwned(raw2);
			if (fh2 === null) return resUncertain(seq, owned.length, sha);
			try {
				const st2 = snapStats(await fh2.fstat());
				verifyOk =
					st2 !== null &&
					st2.isFile &&
					!st2.isDirectory &&
					st2.dev === dev &&
					st2.ino === ino &&
					st2.size === owned.length &&
					(st2.mode & 0o777) === 0o600 &&
					(st2.mode & NO_SPECIAL) === 0 &&
					st2.uid === uid &&
					st2.nlink === 1 &&
					(await verifyContent(fh2, owned, scratch));
			} finally {
				if (!(await confirmedClose(fh2))) reopenCloseFailed = true;
			}
		} catch {
			return resUncertain(seq, owned.length, sha);
		}
		if (reopenCloseFailed || !verifyOk) return resUncertain(seq, owned.length, sha);

		// Identity-bound directory fsync makes publication durable.
		if (!(await fsyncDir(io, journalDir, dirId))) return resUncertain(seq, owned.length, sha);

		return resSuccess(seq, owned.length, sha);
	} catch {
		return resUncertain(seq, owned.length, sha);
	} finally {
		if (fh !== null) {
			const f = fh;
			fh = null;
			await confirmedClose(f);
		}
	}
}

// ---------------------------------------------------------------------------
// Generic publication entry point — parameterized by kind
// ---------------------------------------------------------------------------

async function publishImmutableByKind(kind: PublishKind, options: unknown, io: JournalIo): Promise<PublishResult> {
	// 1. Discover a proven writable caller bytes value via its own
	//    data-descriptor, never invoking getters or Proxy traps.
	const callerBytes = discoverGenuineBytes(options);

	// 2. One outer try/catch/finally established immediately after bytes
	//    discovery: erase the proven writable caller buffer on every path,
	//    including io/options snapshot failures.
	let owned: Uint8Array | undefined;
	let scratch: Uint8Array | undefined;
	let coreEntered = false;
	let size = 0;
	let sha = "";
	let seqVal = 0;
	let result: PublishResult = resSimple("INVALID_ARGUMENT");

	try {
		const ioSnap = snapshotIo(io);
		if (ioSnap === null) return resSimple("INVALID_ARGUMENT");

		// One exact options descriptor snapshot; caller bytes already proven.
		const opts = snapshotOptions(options, callerBytes, kind);
		if (opts === null) return resSimple("INVALID_ARGUMENT");
		const journalDir = opts.journalDir;
		const seq = opts.seq;
		seqVal = seq;

		// Bound/canonical journalDir check before any filesystem work.
		if (
			journalDir.length === 0 ||
			journalDir.length > MAX_DIR_LEN ||
			journalDir.includes("\0") ||
			journalDir[0] !== "/"
		) {
			return resSimple("INVALID_ARGUMENT");
		}
		if (seq < 1 || seq > kind.maxSeq) return resSimple("INVALID_ARGUMENT");
		if (callerBytes === undefined) return resSimple("INVALID_ARGUMENT");
		if (callerBytes.byteLength < 1 || callerBytes.byteLength > MAX_BYTES) return resSimple("INVALID_ARGUMENT");

		owned = ioSnap.allocateBuffer(callerBytes.byteLength);
		if (!isGenuineBytes(owned) || owned.byteLength !== callerBytes.byteLength) return resSimple("INVALID_ARGUMENT");
		// Reject allocator aliases: owned must not share caller backing.
		if (owned.buffer === callerBytes.buffer) return resSimple("INVALID_ARGUMENT");
		Uint8Array.prototype.set.call(owned, callerBytes);
		eraseIntrinsic(callerBytes);
		size = owned.byteLength;

		try {
			sha = createHash("sha256").update(owned).digest("hex");
		} catch {
			return resSimple("INVALID_ARGUMENT");
		}

		scratch = ioSnap.allocateBuffer(SCRATCH_SIZE);
		if (!isGenuineBytes(scratch) || scratch.byteLength !== SCRATCH_SIZE) return resSimple("INVALID_ARGUMENT");
		// Reject allocator aliases: scratch must not share owned or caller backing.
		if (scratch.buffer === owned.buffer || scratch.buffer === callerBytes.buffer)
			return resSimple("INVALID_ARGUMENT");

		const uid = getUid();
		if (uid === undefined) return resSimple("INVALID_ARGUMENT");

		let dirId: DirId | undefined;
		try {
			const st = snapStats(await ioSnap.lstat(journalDir));
			if (
				st === null ||
				!st.isDirectory ||
				st.isFile ||
				(st.mode & 0o777) !== 0o700 ||
				(st.mode & NO_SPECIAL) !== 0 ||
				st.uid !== uid
			) {
				return resSimple("INVALID_ARGUMENT");
			}
			dirId = { dev: st.dev, ino: st.ino, mode: 0o700, uid };
		} catch {
			return resSimple("INVALID_ARGUMENT");
		}

		try {
			const rp = await ioSnap.realpath(journalDir);
			if (rp !== journalDir) return resSimple("INVALID_ARGUMENT");
		} catch {
			return resSimple("INVALID_ARGUMENT");
		}

		const finalPath = join(journalDir, kind.fileName(seq));

		coreEntered = true;
		result = await publishCore(ioSnap, owned, sha, journalDir, dirId, finalPath, seq, scratch);
	} catch {
		// The final open may already have occurred; never claim IO_UNCONFIRMED.
		result = coreEntered ? resUncertain(seqVal, size, sha) : resSimple("INVALID_ARGUMENT");
	} finally {
		eraseIntrinsic(callerBytes);
		eraseIntrinsic(owned);
		eraseIntrinsic(scratch);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Main exports
// ---------------------------------------------------------------------------

export async function publishImmutableJournalRecord(
	options: PublishOptions,
	io: JournalIo = new RealJournalIo(),
): Promise<PublishResult> {
	return await publishImmutableByKind(JOURNAL_KIND, options, io);
}

export async function publishImmutableDeliveryMarker(
	options: DeliveryMarkerPublishOptions,
	io: JournalIo = new RealJournalIo(),
): Promise<DeliveryMarkerPublishResult> {
	const result = await publishImmutableByKind(DELIVERY_KIND, options, io);
	// Map from PublishResult (seq) to DeliveryMarkerPublishResult (sequence)
	switch (result.status) {
		case "success": {
			const r = result as { status: "success"; seq: number; size: number; sha256: string };
			return delResSuccess(r.seq, r.size, r.sha256);
		}
		case "SEQ_COLLISION": {
			const r = result as { status: "SEQ_COLLISION"; seq: number };
			return delResCollision(r.seq);
		}
		case "POST_PUBLICATION_UNCERTAIN": {
			const r = result as {
				status: "POST_PUBLICATION_UNCERTAIN";
				seq: number;
				size: number;
				sha256: string;
			};
			return delResUncertain(r.seq, r.size, r.sha256);
		}
		case "IO_UNCONFIRMED":
			return delResSimple("IO_UNCONFIRMED");
		case "INVALID_ARGUMENT":
			return delResSimple("INVALID_ARGUMENT");
		default:
			return delResSimple("INVALID_ARGUMENT");
	}
}
