/**
 * Node FS production backend for sandbox durable journals.
 *
 * Supports three fixed journal kinds:
 *   - .b14-command   (sandbox command lifecycle records)
 *   - .b14-event-outbox (sandbox event pending/delivered records)
 *   - .b10-provider-call  (provider call records)
 *
 * Factory creates or joins a private directory at the canonical absolute path,
 * binds identity in identity.json (O_CREAT|O_EXCL on first creation), scans
 * existing entries for next-sequence tracking, and returns a publisher and a
 * recovery backend with PHYSICALLY DISTINCT directory and identity-file handles
 * so that closing one never closes the other's resources.
 *
 * Security invariants:
 *   mkdir 0700, realpath exact, O_DIRECTORY|O_NOFOLLOW handles,
 *   uid/mode/dev/ino verification on every operation, identity O_EXCL + fsync
 *   file+dir + reopen verify, no symlinks/hardlinks, bounded sorted page,
 *   names only exact suffix plus hide identity.json, bigint-safe stat
 *   conversion, short-read-safe readAt, confirmEof, fstat identity,
 *   close consumes ownership even on throw, zero casts/assertions/any.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { types } from "node:util";

// ===========================================================================
// Public constants — suffix strings
// ===========================================================================

export const COMMAND_SUFFIX = ".b14-command";
export const EVENT_OUTBOX_SUFFIX = ".b14-event-outbox";
export const PROVIDER_CALL_SUFFIX = ".b10-provider-call";

// ===========================================================================
// Kind descriptor
// ===========================================================================

export type SandboxJournalKind = "command" | "event-outbox" | "provider-call";

export interface JournalKindDescriptor {
	readonly suffix: string;
	readonly maxSeq: number;
	readonly name: string;
}

const KIND_MAP: Readonly<Record<SandboxJournalKind, JournalKindDescriptor>> = Object.freeze({
	command: Object.freeze({ suffix: COMMAND_SUFFIX, maxSeq: 20_000, name: "command" }),
	"event-outbox": Object.freeze({ suffix: EVENT_OUTBOX_SUFFIX, maxSeq: 20_000, name: "event-outbox" }),
	"provider-call": Object.freeze({ suffix: PROVIDER_CALL_SUFFIX, maxSeq: 20_000, name: "provider-call" }),
});

// ===========================================================================
// Internal constants
// ===========================================================================

const IDENTITY_FILE = "identity.json";
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_DIRECTORY_PATH = 4096;
const IDENTITY_MAX_BYTES = 4096;
const FILE_MAX_BYTES = 1_310_720;
const READ_MAX_BYTES = 65_536;
const MAX_PAGE_COUNT = 64;
const MAX_PAGE_BYTES = 16_777_216;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const NO_SPECIAL_MODE = 0o7000;

const INPUT_KEYS = new Set(["directoryPath", "identity", "kind"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const STAT_STRING_KEYS = new Set(["ctimeNs", "dev", "ino", "mtimeNs", "uid"]);
const STAT_NUM_KEYS = new Set(["mode", "nlink", "size"]);
const STAT_BOOL_KEYS = new Set(["isFile", "isSymlink"]);
const PAGE_REQUEST_KEYS = new Set(["cursor", "maxEntries", "maxBytes"]);
const OPEN_REQUEST_KEYS = new Set(["name", "expected"]);

// ===========================================================================
// Types
// ===========================================================================

export type SandboxJournalBackendErrorCode =
	| "DIRECTORY_UNSAFE"
	| "IDENTITY_MISMATCH"
	| "INPUT_INVALID"
	| "IO_UNCERTAIN"
	| "KIND_INVALID";

export type CreateSandboxJournalBackendResult =
	| Readonly<{
			ok: true;
			publisher: SandboxJournalPublisherCapability;
			recoveryBackend: SandboxJournalRecoveryCapability;
	  }>
	| Readonly<{ ok: false; error: Readonly<{ code: SandboxJournalBackendErrorCode }> }>;

export interface SandboxJournalPublishReceipt {
	readonly sequence: number;
	readonly size: number;
	readonly sha256: string;
}

export type SandboxJournalPublishResult =
	| Readonly<{ ok: true; receipt: SandboxJournalPublishReceipt }>
	| Readonly<{
			ok: false;
			error: "IO_UNCONFIRMED" | "SEQ_COLLISION" | "POST_PUBLICATION_UNCERTAIN" | "INVALID_ARGUMENT";
	  }>;

export interface SandboxJournalPublisherCapability {
	readonly publish: (seq: number, bytes: Uint8Array) => Promise<SandboxJournalPublishResult>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export interface SandboxJournalEntryStat {
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

export interface SandboxJournalEntry {
	readonly name: string;
	readonly stat: SandboxJournalEntryStat;
}

export interface SandboxJournalRecoveryCapability {
	readonly listPage: (raw: unknown) => Promise<unknown>;
	readonly open: (raw: unknown) => Promise<unknown>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

// ===========================================================================
// Zero-cast helpers — extract typed values from `unknown` objects
// using `in` narrowing + bracket indexing (TypeScript allows this).
// ===========================================================================

function isObject(raw: unknown): raw is object {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function hasProp<K extends string>(obj: object, key: K): obj is object & Record<K, unknown> {
	return key in obj;
}

function bigintProp(obj: object, key: string): bigint | null {
	if (!hasProp(obj, key)) return null;
	const v = obj[key];
	return typeof v === "bigint" ? v : null;
}

// biome-ignore lint/complexity/noBannedTypes: typeof narrows to Function, not a callable signature
function fnProp(obj: object, key: string): Function | null {
	if (!hasProp(obj, key)) return null;
	const v = obj[key];
	return typeof v === "function" ? v : null;
}

// Call an isDirectory/isFile/isSymbolicLink method on a Stats-like object and return the boolean result.
function callBoolMethod(obj: object, key: string): boolean {
	const fn = fnProp(obj, key);
	if (!fn) return false;
	try {
		return Boolean(Reflect.apply(fn, obj, []));
	} catch {
		return false;
	}
}

// ===========================================================================
// Error/descriptor helpers
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

interface DirIdBs {
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
}

interface FileIdBs {
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
	readonly size: number;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
	readonly mode: number;
	readonly nlink: number;
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	try {
		const d = Object.getOwnPropertyDescriptor(error, "code");
		if (!d || !d.enumerable || d.get !== undefined) return undefined;
		return typeof d.value === "string" ? d.value : undefined;
	} catch {
		return undefined;
	}
}

function descriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function erase(bytes: Uint8Array | null): void {
	if (!bytes) return;
	if (!_taFill) return;
	try {
		Reflect.apply(_taFill, bytes, [0]);
	} catch {
		// best effort
	}
}

async function closeHandle(handle: FileHandle | null): Promise<boolean> {
	if (!handle) return true;
	try {
		await handle.close();
		return true;
	} catch {
		return false;
	}
}

function getUid(): number | undefined {
	try {
		return process.getuid?.();
	} catch {
		return undefined;
	}
}

function validId(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length <= 128 && SAFE_ID_RE.test(raw);
}

function validDecimal(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length >= 1 && raw.length <= 32 && DECIMAL_RE.test(raw);
}

function bigintToSafe(v: bigint, max: number): number | null {
	if (v < 0n) return null;
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n < 0 || n > max) return null;
	return n;
}

function bigintStr(v: bigint): string {
	return String(v);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < left.byteLength; i += 1) diff |= left[i] ^ right[i];
	return diff === 0;
}

// ===========================================================================
// Kind helpers
// ===========================================================================

function getKindDescriptor(kind: string): JournalKindDescriptor | null {
	if (kind === "command") return KIND_MAP.command;
	if (kind === "event-outbox") return KIND_MAP["event-outbox"];
	if (kind === "provider-call") return KIND_MAP["provider-call"];
	return null;
}

function fileName(seq: number, kind: JournalKindDescriptor): string {
	if (!Number.isSafeInteger(seq) || seq < 1 || seq > kind.maxSeq) return "";
	return `${String(seq).padStart(20, "0")}${kind.suffix}`;
}

function parseName(name: string, kind: JournalKindDescriptor): { readonly sequence: number } | null {
	const suffix = kind.suffix;
	if (!name.endsWith(suffix)) return null;
	const prefix = name.slice(0, -suffix.length);
	if (prefix.length !== 20) return null;
	for (let i = 0; i < prefix.length; i += 1) {
		const c = prefix.charCodeAt(i);
		if (c < 0x30 || c > 0x39) return null;
	}
	const seq = Number(prefix);
	if (!Number.isSafeInteger(seq) || seq < 1 || seq > kind.maxSeq) return null;
	return Object.freeze({ sequence: seq });
}

// ===========================================================================
// Bigint stat snapshots — ZERO casts, uses in/bracket narrowing
// ===========================================================================

function snapDirId(st: unknown, expectedUid: string): DirIdBs | null {
	if (!isObject(st)) return null;
	const dev = bigintProp(st, "dev");
	const ino = bigintProp(st, "ino");
	const uid = bigintProp(st, "uid");
	const mode = bigintProp(st, "mode");
	if (dev === null || ino === null || uid === null || mode === null) return null;
	const uidStr = bigintStr(uid);
	if (uidStr !== expectedUid) return null;
	const masked = mode & 0o7777n;
	const modeNum = bigintToSafe(masked, 0o7777);
	if (modeNum === null || (modeNum & 0o777) !== DIRECTORY_MODE || (modeNum & NO_SPECIAL_MODE) !== 0) return null;
	const isDir = callBoolMethod(st, "isDirectory");
	const isSym = callBoolMethod(st, "isSymbolicLink");
	if (!isDir || isSym) return null;
	return Object.freeze({ dev: bigintStr(dev), ino: bigintStr(ino), uid: uidStr });
}

function snapFileId(st: unknown, expectedUid: string, maxSize: number): FileIdBs | null {
	if (!isObject(st)) return null;
	const dev = bigintProp(st, "dev");
	const ino = bigintProp(st, "ino");
	const uid = bigintProp(st, "uid");
	const mode = bigintProp(st, "mode");
	const size = bigintProp(st, "size");
	const nlink = bigintProp(st, "nlink");
	const mtimeNs = bigintProp(st, "mtimeNs");
	const ctimeNs = bigintProp(st, "ctimeNs");
	if (
		dev === null ||
		ino === null ||
		uid === null ||
		mode === null ||
		size === null ||
		nlink === null ||
		mtimeNs === null ||
		ctimeNs === null
	)
		return null;
	const uidStr = bigintStr(uid);
	if (uidStr !== expectedUid) return null;
	const masked = mode & 0o7777n;
	const modeNum = bigintToSafe(masked, 0o7777);
	if (modeNum === null || (modeNum & 0o777) !== FILE_MODE || (modeNum & NO_SPECIAL_MODE) !== 0) return null;
	const sizeNum = bigintToSafe(size, maxSize);
	if (sizeNum === null || sizeNum < 1) return null;
	const nlinkNum = bigintToSafe(nlink, 1);
	if (nlinkNum === null || nlinkNum !== 1) return null;
	const isFile = callBoolMethod(st, "isFile");
	const isSym = callBoolMethod(st, "isSymbolicLink");
	if (!isFile || isSym) return null;
	return Object.freeze({
		dev: bigintStr(dev),
		ino: bigintStr(ino),
		uid: uidStr,
		size: sizeNum,
		mtimeNs: bigintStr(mtimeNs),
		ctimeNs: bigintStr(ctimeNs),
		mode: modeNum,
		nlink: nlinkNum,
	});
}

function snapEntryStat(st: unknown): SandboxJournalEntryStat | null {
	if (!isObject(st)) return null;
	const dev = bigintProp(st, "dev");
	const ino = bigintProp(st, "ino");
	const uid = bigintProp(st, "uid");
	const mode = bigintProp(st, "mode");
	const size = bigintProp(st, "size");
	const nlink = bigintProp(st, "nlink");
	const mtimeNs = bigintProp(st, "mtimeNs");
	const ctimeNs = bigintProp(st, "ctimeNs");
	if (
		dev === null ||
		ino === null ||
		uid === null ||
		mode === null ||
		size === null ||
		nlink === null ||
		mtimeNs === null ||
		ctimeNs === null
	)
		return null;
	const masked = mode & 0o7777n;
	const modeNum = bigintToSafe(masked, 0o7777);
	if (modeNum === null) return null;
	const sizeNum = bigintToSafe(size, FILE_MAX_BYTES);
	if (sizeNum === null || sizeNum < 1) return null;
	const nlinkNum = bigintToSafe(nlink, 1);
	if (nlinkNum !== 1 || (modeNum & 0o777) !== FILE_MODE || (modeNum & NO_SPECIAL_MODE) !== 0) return null;
	const isFile = callBoolMethod(st, "isFile");
	const isSym = callBoolMethod(st, "isSymbolicLink");
	if (!isFile || isSym) return null;
	return Object.freeze({
		dev: bigintStr(dev),
		ino: bigintStr(ino),
		uid: bigintStr(uid),
		mode: modeNum,
		size: sizeNum,
		nlink: nlinkNum,
		isFile: true,
		isSymlink: false,
		mtimeNs: bigintStr(mtimeNs),
		ctimeNs: bigintStr(ctimeNs),
	});
}

function statEqual(left: SandboxJournalEntryStat, right: SandboxJournalEntryStat): boolean {
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

function dirIdEqual(left: DirIdBs, right: DirIdBs): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function fileIdEqual(a: FileIdBs, b: FileIdBs): boolean {
	return (
		a.dev === b.dev &&
		a.ino === b.ino &&
		a.uid === b.uid &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs &&
		a.mode === b.mode &&
		a.nlink === b.nlink
	);
}

// ===========================================================================
// Ownership verification
// ===========================================================================

async function verifyDirectoryOwner(path: string, handle: FileHandle, expected: DirIdBs): Promise<boolean> {
	try {
		const [pathStats, handleStats, resolved] = await Promise.all([
			lstat(path, { bigint: true }),
			handle.stat({ bigint: true }),
			realpath(path),
		]);
		const pathId = snapDirId(pathStats, expected.uid);
		const handleId = snapDirId(handleStats, expected.uid);
		return (
			resolved === path &&
			pathId !== null &&
			handleId !== null &&
			dirIdEqual(pathId, expected) &&
			dirIdEqual(handleId, expected)
		);
	} catch {
		return false;
	}
}

async function verifyFileOwner(path: string, handle: FileHandle, expected: FileIdBs, uidStr: string): Promise<boolean> {
	try {
		const [pathStats, handleStats] = await Promise.all([
			lstat(path, { bigint: true }),
			handle.stat({ bigint: true }),
		]);
		const pathId = snapFileId(pathStats, uidStr, IDENTITY_MAX_BYTES);
		const handleId = snapFileId(handleStats, uidStr, IDENTITY_MAX_BYTES);
		return pathId !== null && handleId !== null && fileIdEqual(pathId, expected) && fileIdEqual(handleId, expected);
	} catch {
		return false;
	}
}

// ===========================================================================
// Identity management
// ===========================================================================

function serializeIdentity(
	value: Readonly<{ generation: string; hostId: string; sessionId: string; kind: string }>,
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			version: 1,
			hostId: value.hostId,
			generation: value.generation,
			sessionId: value.sessionId,
			kind: value.kind,
		}),
	);
}

async function publishIdentity(
	path: string,
	content: Uint8Array,
	uidStr: string,
	directoryPath: string,
	directory: FileHandle,
	directoryId: DirIdBs,
): Promise<"created" | "exists" | "uncertain"> {
	let handle: FileHandle | null = null;
	try {
		try {
			handle = await open(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				FILE_MODE,
			);
		} catch (error) {
			return errorCode(error) === "EEXIST" ? "exists" : "uncertain";
		}
		let offset = 0;
		while (offset < content.byteLength) {
			const written = await handle.write(content, offset, content.byteLength - offset, offset);
			if (
				!Number.isSafeInteger(written.bytesWritten) ||
				written.bytesWritten < 1 ||
				written.bytesWritten > content.byteLength - offset
			)
				return "uncertain";
			offset += written.bytesWritten;
		}
		const fileId = snapFileId(await handle.stat({ bigint: true }), uidStr, IDENTITY_MAX_BYTES);
		if (!fileId || fileId.size !== content.byteLength) return "uncertain";
		await handle.sync();
		const owner = handle;
		handle = null;
		if (!(await closeHandle(owner))) return "uncertain";
		if (!(await verifyDirectoryOwner(directoryPath, directory, directoryId))) return "uncertain";
		await directory.sync();
		if (!(await verifyDirectoryOwner(directoryPath, directory, directoryId))) return "uncertain";
		return "created";
	} catch {
		return "uncertain";
	} finally {
		if (handle !== null) await closeHandle(handle);
	}
}

type IdentityOwnerResult =
	| Readonly<{ status: "opened"; handle: FileHandle; identity: FileIdBs }>
	| Readonly<{ status: "mismatch" | "uncertain" }>;

async function openIdentityOwner(
	path: string,
	expectedContent: Uint8Array,
	uidStr: string,
): Promise<IdentityOwnerResult> {
	let handle: FileHandle | null = null;
	let bytes: Uint8Array | null = null;
	let outcome: "mismatch" | "uncertain" = "uncertain";
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = snapFileId(await handle.stat({ bigint: true }), uidStr, IDENTITY_MAX_BYTES);
		if (!before || before.size !== expectedContent.byteLength) {
			outcome = "mismatch";
		} else {
			bytes = new Uint8Array(before.size);
			let offset = 0;
			while (offset < bytes.byteLength) {
				const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
				if (
					!Number.isSafeInteger(read.bytesRead) ||
					read.bytesRead < 1 ||
					read.bytesRead > bytes.byteLength - offset
				) {
					outcome = "uncertain";
					break;
				}
				offset += read.bytesRead;
			}
			if (offset === bytes.byteLength) {
				const eof = new Uint8Array(1);
				let eofRead = -1;
				try {
					eofRead = (await handle.read(eof, 0, 1, offset)).bytesRead;
				} finally {
					erase(eof);
				}
				const after = snapFileId(await handle.stat({ bigint: true }), uidStr, IDENTITY_MAX_BYTES);
				if (eofRead !== 0 || !after || !fileIdEqual(before, after)) outcome = "uncertain";
				else if (!bytesEqual(bytes, expectedContent)) outcome = "mismatch";
				else {
					const owned = handle;
					handle = null;
					return Object.freeze({ status: "opened", handle: owned, identity: after });
				}
			}
		}
	} catch {
		outcome = "uncertain";
	} finally {
		erase(bytes);
	}
	const closeOk = await closeHandle(handle);
	return Object.freeze({ status: closeOk ? outcome : "uncertain" });
}

// ===========================================================================
// Directory setup and scan
// ===========================================================================

async function pathComponentsAreDirectories(path: string): Promise<boolean> {
	try {
		const root = parse(path).root;
		let current = root;
		for (const component of path.slice(root.length).split(sep)) {
			if (component.length === 0 || component === "." || component === "..") return false;
			current = join(current, component);
			const stats = await lstat(current, { bigint: true });
			if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
		}
		return true;
	} catch {
		return false;
	}
}

async function openDir(
	path: string,
	uidStr: string,
): Promise<
	{ ok: true; resolved: string; handle: FileHandle; id: DirIdBs } | { ok: false; code: SandboxJournalBackendErrorCode }
> {
	if (
		typeof path !== "string" ||
		!isAbsolute(path) ||
		path.length === 0 ||
		path.length > MAX_DIRECTORY_PATH ||
		path.indexOf("\\0") >= 0
	)
		return { ok: false, code: "INPUT_INVALID" };
	const parentPath = dirname(path);
	if (parentPath === path || !(await pathComponentsAreDirectories(parentPath))) {
		return { ok: false, code: "DIRECTORY_UNSAFE" };
	}
	let parentHandle: FileHandle | null = null;
	try {
		if ((await realpath(parentPath)) !== parentPath) return { ok: false, code: "DIRECTORY_UNSAFE" };
		parentHandle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const parentId = snapDirId(await parentHandle.stat({ bigint: true }), uidStr);
		if (!parentId || !(await verifyDirectoryOwner(parentPath, parentHandle, parentId))) {
			const closeOk = await closeHandle(parentHandle);
			parentHandle = null;
			return { ok: false, code: closeOk ? "DIRECTORY_UNSAFE" : "IO_UNCERTAIN" };
		}
		try {
			await mkdir(path, { recursive: false, mode: DIRECTORY_MODE });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") {
				const closeOk = await closeHandle(parentHandle);
				parentHandle = null;
				return { ok: false, code: closeOk ? "DIRECTORY_UNSAFE" : "IO_UNCERTAIN" };
			}
		}
		// (D) fsync parentHandle after mkdir and reverify
		await parentHandle.sync();
		if (
			!(await verifyDirectoryOwner(parentPath, parentHandle, parentId)) ||
			!(await pathComponentsAreDirectories(path))
		) {
			const closeOk = await closeHandle(parentHandle);
			parentHandle = null;
			return { ok: false, code: closeOk ? "DIRECTORY_UNSAFE" : "IO_UNCERTAIN" };
		}
		const closeOk = await closeHandle(parentHandle);
		parentHandle = null;
		if (!closeOk) return { ok: false, code: "IO_UNCERTAIN" };
	} catch {
		const closeOk = await closeHandle(parentHandle);
		return { ok: false, code: closeOk ? "DIRECTORY_UNSAFE" : "IO_UNCERTAIN" };
	}
	let resolved: string;
	try {
		resolved = await realpath(path);
	} catch {
		return { ok: false, code: "DIRECTORY_UNSAFE" };
	}
	if (resolved !== path) return { ok: false, code: "DIRECTORY_UNSAFE" };
	let handle: FileHandle | null = null;
	try {
		handle = await open(resolved, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const snap = snapDirId(await handle.stat({ bigint: true }), uidStr);
		if (!snap || !(await verifyDirectoryOwner(resolved, handle, snap))) {
			const closeOk = await closeHandle(handle);
			handle = null;
			return { ok: false, code: closeOk ? "DIRECTORY_UNSAFE" : "IO_UNCERTAIN" };
		}
		return { ok: true, resolved, handle, id: snap };
	} catch {
		const closeOk = await closeHandle(handle);
		return { ok: false, code: closeOk ? "DIRECTORY_UNSAFE" : "IO_UNCERTAIN" };
	}
}

async function openDirectoryOwner(path: string, expected: DirIdBs): Promise<FileHandle | null> {
	let handle: FileHandle | null = null;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		if (!(await verifyDirectoryOwner(path, handle, expected))) {
			await closeHandle(handle);
			return null;
		}
		return handle;
	} catch {
		await closeHandle(handle);
		return null;
	}
}

async function scanJournalDir(
	dir: string,
	kind: JournalKindDescriptor,
): Promise<readonly SandboxJournalEntry[] | null> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	if (names.length > 60_000) return null;
	const parsedEntries: SandboxJournalEntry[] = [];
	const others: SandboxJournalEntry[] = [];
	for (const name of names) {
		if (name === IDENTITY_FILE) continue;
		let raw: unknown;
		try {
			raw = await lstat(join(dir, name), { bigint: true });
		} catch {
			return null;
		}
		const snap = snapEntryStat(raw);
		// For parsed entries (matching kind naming pattern), stat validation is mandatory.
		// For unexpected entries, include them only if stat passes, otherwise skip.
		if (parseName(name, kind) !== null) {
			if (!snap) return null;
			parsedEntries.push(Object.freeze({ name, stat: snap }));
		} else {
			if (snap) {
				others.push(Object.freeze({ name, stat: snap }));
			}
			// Skip entries that fail stat validation silently — they aren't safe journal records.
		}
	}
	// (E) Validate: safe 0600 one-link current-UID entries, total <=256MiB, no gaps
	parsedEntries.sort((a, b) => a.name.localeCompare(b.name));
	let runningTotal = 0;
	for (let i = 0; i < parsedEntries.length; i++) {
		const p = parseName(parsedEntries[i].name, kind);
		if (!p) return null;
		if (p.sequence !== i + 1) return null; // gap or non-contiguous
		const st = parsedEntries[i].stat;
		if (st.mode !== FILE_MODE || st.nlink !== 1 || !st.isFile || st.isSymlink) return null;
		if (st.uid !== String(getUid())) return null;
		if (typeof st.size !== "number" || st.size < 1 || st.size > FILE_MAX_BYTES) return null;
		runningTotal += st.size;
		if (runningTotal > 268_435_456) return null;
	}
	// Combine sorted parsed + others
	others.sort((a, b) => a.name.localeCompare(b.name));
	return Object.freeze(parsedEntries.concat(others));
}

// ===========================================================================
// Uint8Array ownership transfer — type-guarded genuine-byte validation
// ===========================================================================

const TA_PROTO = Object.getPrototypeOf(Uint8Array.prototype);
const U8_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TA_PROTO, "byteLength");
const U8_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TA_PROTO, "byteOffset");
const U8_BUFFER_GETTER = Object.getOwnPropertyDescriptor(TA_PROTO, "buffer");
const AB_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength");

// Extract getter functions (typed array properties are accessors, not data descriptors).
const _u8BufferGet = U8_BUFFER_GETTER && typeof U8_BUFFER_GETTER.get === "function" ? U8_BUFFER_GETTER.get : null;
const _u8OffsetGet =
	U8_BYTE_OFFSET_GETTER && typeof U8_BYTE_OFFSET_GETTER.get === "function" ? U8_BYTE_OFFSET_GETTER.get : null;
const _u8LengthGet =
	U8_BYTE_LENGTH_GETTER && typeof U8_BYTE_LENGTH_GETTER.get === "function" ? U8_BYTE_LENGTH_GETTER.get : null;
const _abLengthGet =
	AB_BYTE_LENGTH_GETTER && typeof AB_BYTE_LENGTH_GETTER.get === "function" ? AB_BYTE_LENGTH_GETTER.get : null;
const _taFill: Uint8Array["fill"] | null = TA_PROTO && typeof TA_PROTO.fill === "function" ? TA_PROTO.fill : null;

/**
 * takeTransferredBytes validates `value` is a genuine full-backing non-shared
 * Uint8Array (zero offset, length === backing byteLength, no own-props,
 * no Proxy). If valid, it copies the bytes into a fresh owned Uint8Array,
 * erases the caller's buffer, and returns the owned copy.
 *
 * Returns null for any invalid, shared, proxied, or empty input.
 * ZERO casts — uses captured native getters.
 */
function takeTransferredBytes(value: unknown): Uint8Array | null {
	// Non-mutating preflight: type checks that never throw on Proxy
	if (typeof value !== "object" || value === null) return null;
	// Proxy detection before any property access
	try {
		if (types.isProxy(value)) return null;
	} catch {
		return null;
	}
	// Prototype check (safe: does not invoke traps)
	try {
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return null;
	} catch {
		return null;
	}
	// Reject own buffer/byteOffset/byteLength (not genuine full-backing)
	if (Object.hasOwn(value, "buffer") || Object.hasOwn(value, "byteOffset") || Object.hasOwn(value, "byteLength")) {
		return null;
	}
	// Captured getters for non-mutating access
	if (!_u8BufferGet || !_u8OffsetGet || !_u8LengthGet || !_abLengthGet) return null;
	let backing: unknown;
	let offset: unknown;
	let length: unknown;
	let backingLength: unknown;
	try {
		backing = Reflect.apply(_u8BufferGet, value, []);
	} catch {
		return null;
	}
	if (typeof backing !== "object" || backing === null || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype)
		return null;
	try {
		if (types.isProxy(backing)) return null;
	} catch {
		return null;
	}
	// Reject SharedArrayBuffer
	if (Object.getPrototypeOf(backing) !== ArrayBuffer.prototype) return null;
	// Reject own property names/symbols on backing ArrayBuffer
	if (Object.getOwnPropertyNames(backing).length > 0) return null;
	if (Object.getOwnPropertySymbols(backing).length > 0) return null;
	try {
		offset = Reflect.apply(_u8OffsetGet, value, []);
		length = Reflect.apply(_u8LengthGet, value, []);
		backingLength = Reflect.apply(_abLengthGet, backing, []);
	} catch {
		return null;
	}
	if (
		offset !== 0 ||
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 1 ||
		length !== backingLength ||
		length > FILE_MAX_BYTES
	)
		return null;
	// Reject symbols and extra own properties — genuine Uint8Array has only numeric indices
	try {
		if (Object.getOwnPropertySymbols(value).length > 0) return null;
	} catch {
		return null;
	}
	const ownKeys = Object.getOwnPropertyNames(value);
	// Reject if own names count does not equal expected byte length
	if (ownKeys.length !== length) return null;
	for (let i = 0; i < ownKeys.length; i++) {
		const k = ownKeys[i];
		// Verify each name is the canonical string representation of its index
		const n = Number(k);
		if (!Number.isSafeInteger(n) || n < 0 || n >= length || String(n) !== k) return null;
	}
	// Genuine full-backing validated — copy every byte
	let owned: Uint8Array | null = null;
	try {
		owned = new Uint8Array(length);
		for (let i = 0; i < length; i++) {
			const desc = Object.getOwnPropertyDescriptor(value, String(i));
			if (!desc || !("value" in desc)) {
				erase(owned);
				return null;
			}
			const byteVal = desc.value;
			if (typeof byteVal !== "number" || !Number.isSafeInteger(byteVal) || byteVal < 0 || byteVal > 255) {
				erase(owned);
				return null;
			}
			owned[i] = byteVal;
		}
	} catch {
		erase(owned);
		return null;
	}
	// Erase caller bytes — if erase fails, reject the transfer
	try {
		if (_taFill) Reflect.apply(_taFill, value, [0]);
	} catch {
		erase(owned);
		return null;
	}
	return owned;
}
// ===========================================================================
// Journal file publish
// ===========================================================================

async function publishJournalFile(
	dirPath: string,
	dirHandle: FileHandle,
	dirId: DirIdBs,
	seq: number,
	bytes: Uint8Array,
	kind: JournalKindDescriptor,
	uidStr: string,
	identityPath: string,
	identityId: FileIdBs,
	idHandle: FileHandle,
): Promise<SandboxJournalPublishResult> {
	const beforeOk =
		(await verifyDirectoryOwner(dirPath, dirHandle, dirId)) &&
		(await verifyFileOwner(identityPath, idHandle, identityId, uidStr));
	if (!beforeOk) {
		return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
	}
	const name = fileName(seq, kind);
	if (!name) return Object.freeze({ ok: false, error: "INVALID_ARGUMENT" });
	const filePath = join(dirPath, name);
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	let handle: FileHandle | null = null;
	let publicationOccurred = false;
	try {
		handle = await open(
			filePath,
			constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
			FILE_MODE,
		);
		publicationOccurred = true;
	} catch (error) {
		const code = errorCode(error);
		if (code === "EEXIST") return Object.freeze({ ok: false, error: "SEQ_COLLISION" });
		return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
	}
	try {
		let offset = 0;
		while (offset < bytes.byteLength) {
			const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
			if (
				!Number.isSafeInteger(written.bytesWritten) ||
				written.bytesWritten < 1 ||
				written.bytesWritten > bytes.byteLength - offset
			) {
				const closeOk = await closeHandle(handle);
				handle = null;
				return Object.freeze({
					ok: false,
					error: closeOk
						? publicationOccurred
							? "POST_PUBLICATION_UNCERTAIN"
							: "IO_UNCONFIRMED"
						: "POST_PUBLICATION_UNCERTAIN",
				});
			}
			offset += written.bytesWritten;
		}
		await handle.sync();
		const handleBefore = snapFileId(await handle.stat({ bigint: true }), uidStr, FILE_MAX_BYTES);
		if (!handleBefore || handleBefore.size !== bytes.byteLength) {
			await closeHandle(handle);
			handle = null;
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		const readback = new Uint8Array(bytes.byteLength);
		let readOffset = 0;
		while (readOffset < readback.byteLength) {
			const read = await handle.read(readback, readOffset, readback.byteLength - readOffset, readOffset);
			if (
				!Number.isSafeInteger(read.bytesRead) ||
				read.bytesRead < 1 ||
				read.bytesRead > readback.byteLength - readOffset
			) {
				erase(readback);
				await closeHandle(handle);
				handle = null;
				return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
			}
			readOffset += read.bytesRead;
		}
		const eof = new Uint8Array(1);
		const eofRead = (await handle.read(eof, 0, 1, readOffset)).bytesRead;
		erase(eof);
		if (eofRead !== 0) {
			erase(readback);
			await closeHandle(handle);
			handle = null;
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		// (C) Verify path stat exactly equals handle stat
		const pathAfter = snapEntryStat(await lstat(filePath, { bigint: true }));
		if (
			!pathAfter ||
			!statEqual(
				pathAfter,
				Object.freeze({
					dev: handleBefore.dev,
					ino: handleBefore.ino,
					uid: handleBefore.uid,
					mode: handleBefore.mode,
					size: handleBefore.size,
					nlink: handleBefore.nlink,
					isFile: true,
					isSymlink: false,
					mtimeNs: handleBefore.mtimeNs,
					ctimeNs: handleBefore.ctimeNs,
				}),
			)
		) {
			erase(readback);
			await closeHandle(handle);
			handle = null;
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		const computedSha = createHash("sha256").update(readback).digest("hex");
		erase(readback);
		if (computedSha !== sha256) {
			await closeHandle(handle);
			handle = null;
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		const closeOk = await closeHandle(handle);
		handle = null;
		if (!closeOk) return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		// Directory fsync and reverify — verify before+after sync
		if (
			!(await verifyDirectoryOwner(dirPath, dirHandle, dirId)) ||
			!(await verifyFileOwner(identityPath, idHandle, identityId, uidStr))
		) {
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		await dirHandle.sync();
		if (
			!(await verifyDirectoryOwner(dirPath, dirHandle, dirId)) ||
			!(await verifyFileOwner(identityPath, idHandle, identityId, uidStr))
		) {
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		// Parent directory fsync: open a transient handle to dirname(dirPath)
		// Verify identity before and after sync so we know we synced the right parent.
		let parentHandle: FileHandle | null = null;
		try {
			const parentPath = dirname(dirPath);
			parentHandle = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			const parentBefore = snapDirId(await parentHandle.stat({ bigint: true }), uidStr);
			if (!parentBefore || !(await verifyDirectoryOwner(parentPath, parentHandle, parentBefore))) {
				await closeHandle(parentHandle);
				parentHandle = null;
				return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
			}
			await parentHandle.sync();
			const parentAfter = snapDirId(await parentHandle.stat({ bigint: true }), uidStr);
			if (!parentAfter || !dirIdEqual(parentBefore, parentAfter)) {
				await closeHandle(parentHandle);
				parentHandle = null;
				return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
			}
		} catch {
			await closeHandle(parentHandle);
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		const parentOk = await closeHandle(parentHandle);
		parentHandle = null;
		if (!parentOk) return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		const finalFileStat = snapEntryStat(await lstat(filePath, { bigint: true }));
		if (
			!finalFileStat ||
			!statEqual(finalFileStat, pathAfter) ||
			!(await verifyDirectoryOwner(dirPath, dirHandle, dirId)) ||
			!(await verifyFileOwner(identityPath, idHandle, identityId, uidStr))
		) {
			return Object.freeze({ ok: false, error: "POST_PUBLICATION_UNCERTAIN" });
		}
		return Object.freeze({
			ok: true,
			receipt: Object.freeze({ sequence: seq, size: bytes.byteLength, sha256 }),
		});
	} catch {
		const closeOk = await closeHandle(handle);
		handle = null;
		return Object.freeze({
			ok: false,
			error: closeOk
				? publicationOccurred
					? "POST_PUBLICATION_UNCERTAIN"
					: "IO_UNCONFIRMED"
				: "POST_PUBLICATION_UNCERTAIN",
		});
	}
}
// ===========================================================================
// Publisher capability
// ===========================================================================

function makePublisher(
	dirPath: string,
	dirId: DirIdBs,
	identityPath: string,
	identityId: FileIdBs,
	uidStr: string,
	kind: JournalKindDescriptor,
	pubTail: { current: Promise<void> },
	publisherOwnedDirHandle: FileHandle,
	publisherOwnedIdHandle: FileHandle,
	initialNextSeq: number,
	initialTotalBytes: number,
): SandboxJournalPublisherCapability {
	let closed = false;
	let poisoned = false;
	let closeP: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	let nextSeq = initialNextSeq;
	let admittedBytes = initialTotalBytes;
	let poisonTail = false;

	return Object.freeze({
		publish(seq: number, bytes: Uint8Array): Promise<SandboxJournalPublishResult> {
			if (closed || poisoned) return Promise.resolve(Object.freeze({ ok: false, error: "IO_UNCONFIRMED" }));
			if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > kind.maxSeq) {
				return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
			}
			// Non-mutating sequence check: validate before any byte transfer
			if (seq !== nextSeq) return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
			// Non-mutating preflight: safe helper inside try (Proxy cannot throw)
			let byteLen: number = 0;
			try {
				if (typeof bytes !== "object" || bytes === null)
					return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
				if (Object.getPrototypeOf(bytes) !== Uint8Array.prototype)
					return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
				if (Object.getOwnPropertySymbols(bytes).length > 0)
					return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
				if (!_u8LengthGet) return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
				const raw = _u8LengthGet.call(bytes);
				if (typeof raw !== "number" || !Number.isSafeInteger(raw))
					return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
				byteLen = raw;
			} catch {
				return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
			}
			if (byteLen < 1 || byteLen > FILE_MAX_BYTES) {
				return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
			}
			// Safe cumulative size check before accepting bytes
			if (admittedBytes + byteLen > 268_435_456) {
				return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
			}
			// Check poisonTail at admission
			if (poisonTail) return Promise.resolve(Object.freeze({ ok: false, error: "IO_UNCONFIRMED" }));
			// Now take ownership — non-mutating checks leave caller bytes untouched
			const owned = takeTransferredBytes(bytes);
			if (!owned) return Promise.resolve(Object.freeze({ ok: false, error: "INVALID_ARGUMENT" }));
			// Accepted caller bytes erased immediately after owned copy
			const capturedSeq = seq;
			const capturedBytes = owned;

			// Advance nextSeq and totalBytes synchronously before returning
			nextSeq = capturedSeq + 1;
			admittedBytes += byteLen;

			const op = pubTail.current.then(
				async () => {
					if (poisonTail) {
						erase(capturedBytes);
						return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
					}
					const result = await publishJournalFile(
						dirPath,
						publisherOwnedDirHandle,
						dirId,
						capturedSeq,
						capturedBytes,
						kind,
						uidStr,
						identityPath,
						identityId,
						publisherOwnedIdHandle,
					);
					erase(capturedBytes);
					// Poison on any failure so no gap can advance
					if (!result.ok) {
						poisonTail = true;
					} else if ("error" in result && result.error === "POST_PUBLICATION_UNCERTAIN") {
						poisonTail = true;
					} else if ("error" in result && result.error === "SEQ_COLLISION") {
						poisonTail = true;
					}
					return result;
				},
				async () => {
					erase(capturedBytes);
					poisonTail = true;
					return Object.freeze({ ok: false, error: "IO_UNCONFIRMED" });
				},
			);
			pubTail.current = op.then(
				() => undefined,
				() => {
					poisoned = true;
				},
			);
			return op;
		},
		close(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (closeP) return closeP;
			closed = true;
			closeP = pubTail.current.then(
				async () => {
					// Close in reverse acquisition order: id (acquired second), then dir (acquired first)
					const idOk = await closeHandle(publisherOwnedIdHandle);
					const dirOk = await closeHandle(publisherOwnedDirHandle);
					return Object.freeze({ status: idOk && dirOk ? "closed" : "error" });
				},
				async () => {
					const idOk = await closeHandle(publisherOwnedIdHandle);
					const dirOk = await closeHandle(publisherOwnedDirHandle);
					return Object.freeze({ status: idOk && dirOk ? "closed" : "error" });
				},
			);
			return closeP;
		},
	});
}

// ===========================================================================
// Recovery capability
// ===========================================================================

// ===========================================================================
// Name validation
// ===========================================================================

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/;

function isValidEntryName(name: unknown): name is string {
	if (typeof name !== "string") return false;
	if (name.length < 1 || name.length > 256) return false;
	if (name.indexOf("/") >= 0 || name.indexOf("\\") >= 0 || name.indexOf("\0") >= 0) return false;
	if (name === "." || name === "..") return false;
	return SAFE_NAME_RE.test(name);
}
function makeRecoveryBackend(
	dirPath: string,
	dirId: DirIdBs,
	identityPath: string,
	identityId: FileIdBs,
	uidStr: string,
	kind: JournalKindDescriptor,
	recoveryOwnedDirHandle: FileHandle,
	recoveryOwnedIdHandle: FileHandle,
	pubTail: { current: Promise<void> },
): SandboxJournalRecoveryCapability {
	let closed = false;
	let poisoned = false;
	let closeP: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	let recoveryTail: Promise<void> = Promise.resolve();

	// Owner abstraction: one tail + one shared close Promise per file/dir handle
	interface Owner {
		readonly handle: FileHandle;
		consumed: boolean;
		tail: Promise<void>;
		closeP: Promise<Readonly<{ status: "closed" | "error" }>> | null;
	}
	const owners: Owner[] = [];
	let closeUncertain = false;

	async function checkStorage(): Promise<boolean> {
		return (
			(await verifyDirectoryOwner(dirPath, recoveryOwnedDirHandle, dirId)) &&
			(await verifyFileOwner(identityPath, recoveryOwnedIdHandle, identityId, uidStr))
		);
	}

	function enqRecovery<T>(fn: () => Promise<T>): Promise<T> {
		const op = recoveryTail.then(fn, fn);
		recoveryTail = op.then(
			() => undefined,
			() => {
				poisoned = true;
			},
		);
		return op;
	}

	// Close helpers — return the shared owner close Promise or create one
	function requestOwnerClose(owner: Owner): Promise<Readonly<{ status: "closed" | "error" }>> {
		if (owner.closeP !== null) return owner.closeP;
		owner.closeP = owner.tail.then(
			async () => {
				const ok = await closeHandle(owner.handle);
				if (!ok) closeUncertain = true;
				return Object.freeze({ status: ok ? "closed" : "error" });
			},
			async () => {
				const ok = await closeHandle(owner.handle);
				if (!ok) closeUncertain = true;
				return Object.freeze({ status: ok ? "closed" : "error" });
			},
		);
		owner.consumed = true;
		return owner.closeP;
	}

	function createOwner(fh: FileHandle): Owner {
		const o: Owner = { handle: fh, consumed: false, tail: Promise.resolve(), closeP: null };
		owners.push(o);
		return o;
	}

	async function closeAllOwners(): Promise<boolean> {
		await recoveryTail;
		let ok = !closeUncertain;
		// Close in reverse acquisition order
		for (let i = owners.length - 1; i >= 0; i--) {
			const owner = owners[i];
			if (owner.closeP !== null) {
				const r = await owner.closeP;
				if (r.status !== "closed") ok = false;
			} else if (!owner.consumed) {
				// Request close — awaits owner tail then closes
				const r = await requestOwnerClose(owner);
				if (r.status !== "closed") ok = false;
			}
		}
		owners.length = 0;
		if (!(await closeHandle(recoveryOwnedIdHandle))) ok = false;
		if (!(await closeHandle(recoveryOwnedDirHandle))) ok = false;
		return ok;
	}

	return Object.freeze({
		listPage(raw: unknown): Promise<unknown> {
			const d = descriptors(raw);
			if (!d || closed || poisoned) return Promise.resolve(Object.freeze({ status: "error" }));
			const keys = Object.getOwnPropertyNames(d);
			if (keys.length !== 3 || keys.some((k) => !PAGE_REQUEST_KEYS.has(k))) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			if (
				keys.some((k) => {
					const desc = d[k];
					return !desc || !("value" in desc) || !desc.enumerable;
				})
			) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			const cursor = d.cursor.value;
			const maxCount = d.maxEntries.value;
			const maxBytes = d.maxBytes.value;
			if (cursor !== null && cursor !== undefined && typeof cursor !== "string") {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			if (cursor === undefined) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			if (
				typeof maxCount !== "number" ||
				!Number.isSafeInteger(maxCount) ||
				maxCount < 1 ||
				maxCount > MAX_PAGE_COUNT ||
				typeof maxBytes !== "number" ||
				!Number.isSafeInteger(maxBytes) ||
				maxBytes < 1 ||
				maxBytes > MAX_PAGE_BYTES
			) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}

			// Snapshot pubTail.current and synchronously call enqRecovery; await inside
			const pubBefore = pubTail.current;
			return enqRecovery(async () => {
				if (closed || poisoned) return Object.freeze({ status: "error" });
				await pubBefore;
				if (!(await checkStorage())) {
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				// Open a page-level directory handle
				let pageDir: FileHandle | null = null;
				try {
					pageDir = await open(dirPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
					if (!(await verifyDirectoryOwner(dirPath, pageDir, dirId))) {
						await closeHandle(pageDir);
						poisoned = true;
						return Object.freeze({ status: "error" });
					}
				} catch {
					await closeHandle(pageDir);
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				if (!(await checkStorage())) {
					await closeHandle(pageDir);
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				const entries = await scanJournalDir(dirPath, kind);
				if (entries === null || !(await checkStorage())) {
					await closeHandle(pageDir);
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				let start = 0;
				if (cursor !== null && cursor !== undefined) {
					const idx = entries.findIndex((e) => e.name === cursor);
					if (idx < 0) {
						await closeHandle(pageDir);
						poisoned = true;
						return Object.freeze({ status: "error" });
					}
					start = idx + 1;
				}
				const page: SandboxJournalEntry[] = [];
				let pageBytes = 0;
				for (let i = start; i < entries.length && page.length < maxCount; i++) {
					const e = entries[i];
					// Never return an entry whose stat.size exceeds maxBytes
					if (e.stat.size > maxBytes) break;
					if (pageBytes + e.stat.size > maxBytes && page.length > 0) break;
					page.push(Object.freeze({ name: e.name, stat: e.stat }));
					pageBytes += e.stat.size;
				}
				const lastName = page.at(-1)?.name ?? null;
				let nextCursor: string | null = null;
				if (lastName !== null) {
					const li = entries.findIndex((e) => e.name === lastName);
					if (li < 0) {
						await closeHandle(pageDir);
						poisoned = true;
						return Object.freeze({ status: "error" });
					}
					if (li + 1 < entries.length) nextCursor = lastName;
				}
				// Register page as a tracked owner
				const pageOwner = createOwner(pageDir);
				pageDir = null;

				return Object.freeze({
					status: "page",
					entries: Object.freeze(page),
					nextCursor,
					close: (): unknown => requestOwnerClose(pageOwner),
				});
			});
		},

		open(raw: unknown): Promise<unknown> {
			const d = descriptors(raw);
			if (!d || closed || poisoned) return Promise.resolve(Object.freeze({ status: "error" }));
			const keys = Object.getOwnPropertyNames(d);
			if (keys.length !== 2 || keys.some((k) => !OPEN_REQUEST_KEYS.has(k))) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			for (const k of keys) {
				if (!d[k] || !("value" in d[k]) || !d[k].enumerable) {
					return Promise.resolve(Object.freeze({ status: "error" }));
				}
			}
			const name = d.name.value;
			const expectedRaw = d.expected.value;
			if (!isValidEntryName(name)) return Promise.resolve(Object.freeze({ status: "error" }));
			if (typeof name !== "string") return Promise.resolve(Object.freeze({ status: "error" }));
			const expected = descriptors(expectedRaw);
			if (!expected) return Promise.resolve(Object.freeze({ status: "error" }));
			const expectedKeys = Object.getOwnPropertyNames(expected);
			if (expectedKeys.length !== STAT_STRING_KEYS.size + STAT_NUM_KEYS.size + STAT_BOOL_KEYS.size) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			let devStr = "";
			let inoStr = "";
			let uidStr2 = "";
			let modeNum = 0;
			let sizeNum = 0;
			let nlinkNum = 0;
			let isFileVal = false;
			let isSymlinkVal = false;
			let mtimeNsStr = "";
			let ctimeNsStr = "";
			for (const k of expectedKeys) {
				const desc = expected[k];
				if (!desc || !("value" in desc) || !desc.enumerable) {
					return Promise.resolve(Object.freeze({ status: "error" }));
				}
				const v = desc.value;
				if (STAT_STRING_KEYS.has(k)) {
					if (typeof v !== "string") return Promise.resolve(Object.freeze({ status: "error" }));
					if (k === "dev") devStr = v;
					else if (k === "ino") inoStr = v;
					else if (k === "uid") uidStr2 = v;
					else if (k === "mtimeNs") mtimeNsStr = v;
					else if (k === "ctimeNs") ctimeNsStr = v;
				} else if (STAT_NUM_KEYS.has(k)) {
					if (typeof v !== "number" || !Number.isSafeInteger(v)) {
						return Promise.resolve(Object.freeze({ status: "error" }));
					}
					if (k === "mode") modeNum = v;
					else if (k === "size") sizeNum = v;
					else if (k === "nlink") nlinkNum = v;
				} else if (STAT_BOOL_KEYS.has(k)) {
					if (typeof v !== "boolean") return Promise.resolve(Object.freeze({ status: "error" }));
					if (k === "isFile") isFileVal = v;
					else if (k === "isSymlink") isSymlinkVal = v;
				}
			}
			const expectedStat: SandboxJournalEntryStat = Object.freeze({
				dev: devStr,
				ino: inoStr,
				uid: uidStr2,
				mode: modeNum,
				size: sizeNum,
				nlink: nlinkNum,
				isFile: isFileVal,
				isSymlink: isSymlinkVal,
				mtimeNs: mtimeNsStr,
				ctimeNs: ctimeNsStr,
			});
			if (
				!validDecimal(expectedStat.dev) ||
				!validDecimal(expectedStat.ino) ||
				!validDecimal(expectedStat.uid) ||
				!validDecimal(expectedStat.mtimeNs) ||
				!validDecimal(expectedStat.ctimeNs) ||
				!Number.isSafeInteger(expectedStat.mode) ||
				!Number.isSafeInteger(expectedStat.size) ||
				expectedStat.size < 1 ||
				expectedStat.size > FILE_MAX_BYTES ||
				expectedStat.uid !== uidStr ||
				expectedStat.mode !== FILE_MODE ||
				expectedStat.nlink !== 1 ||
				expectedStat.isFile !== true ||
				expectedStat.isSymlink !== false
			) {
				return Promise.resolve(Object.freeze({ status: "error" }));
			}
			// Snapshot pubTail.current and synchronously call enqRecovery; await inside
			const pubBefore = pubTail.current;
			return enqRecovery(async () => {
				if (closed || poisoned) return Object.freeze({ status: "error" });
				await pubBefore;
				if (!(await checkStorage())) {
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				const filePath = join(dirPath, name);
				let fh: FileHandle | null = null;
				try {
					const pathBefore = snapEntryStat(await lstat(filePath, { bigint: true }));
					if (!pathBefore || !statEqual(pathBefore, expectedStat)) return Object.freeze({ status: "error" });
					fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
					const handleBefore = snapEntryStat(await fh.stat({ bigint: true }));
					const pathAfter = snapEntryStat(await lstat(filePath, { bigint: true }));
					if (
						!handleBefore ||
						!pathAfter ||
						!statEqual(handleBefore, expectedStat) ||
						!statEqual(pathAfter, expectedStat)
					) {
						const ok = await closeHandle(fh);
						fh = null;
						if (!ok) poisoned = true;
						return Object.freeze({ status: "error" });
					}
				} catch {
					const ok = await closeHandle(fh);
					if (!ok) poisoned = true;
					return Object.freeze({ status: "error" });
				}
				if (!(await checkStorage())) {
					poisoned = true;
					const ok = await closeHandle(fh);
					fh = null;
					if (!ok) closeUncertain = true;
					return Object.freeze({ status: "error" });
				}
				// Create tracked owner
				const owner = createOwner(fh);
				fh = null;

				// Enqueue operation onto owner tail
				function enqOp<T>(fn: () => Promise<T>): Promise<T> {
					const op = owner.tail.then(fn, fn);
					owner.tail = op.then(
						() => undefined,
						() => {
							poisoned = true;
						},
					);
					return op;
				}

				const readHandle = Object.freeze({
					readAt(offset: number, size: number): unknown {
						if (closed || poisoned || owner.consumed) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						if (!Number.isSafeInteger(offset) || offset < 0 || offset > FILE_MAX_BYTES) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						if (!Number.isSafeInteger(size) || size < 1 || size > READ_MAX_BYTES) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						const buffer = new Uint8Array(size);
						return enqOp(async () => {
							try {
								const read = await owner.handle.read(buffer, 0, size, offset);
								if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > size) {
									return Object.freeze({ status: "error" });
								}
								if (read.bytesRead === 0) return Object.freeze({ status: "eof" });
								const bytes = new Uint8Array(read.bytesRead);
								Uint8Array.prototype.set.call(bytes, buffer.subarray(0, read.bytesRead));
								return Object.freeze({ status: "bytes", bytes });
							} catch {
								return Object.freeze({ status: "error" });
							} finally {
								erase(buffer);
							}
						});
					},
					confirmEof(size: number): unknown {
						if (closed || poisoned || owner.consumed) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						if (!Number.isSafeInteger(size) || size < 0 || size > FILE_MAX_BYTES) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						const buf = new Uint8Array(1);
						return enqOp(async () => {
							try {
								const read = await owner.handle.read(buf, 0, 1, size);
								return Object.freeze({ status: read.bytesRead === 0 ? "eof" : "error" });
							} catch {
								return Object.freeze({ status: "error" });
							} finally {
								erase(buf);
							}
						});
					},
					fstat(): unknown {
						if (closed || poisoned || owner.consumed) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						return enqOp(async () => {
							try {
								if (!(await checkStorage())) {
									poisoned = true;
									return Object.freeze({ status: "error" });
								}
								const snapshot = snapEntryStat(await owner.handle.stat({ bigint: true }));
								if (!snapshot || !(await checkStorage())) {
									poisoned = true;
									return Object.freeze({ status: "error" });
								}
								return snapshot;
							} catch {
								poisoned = true;
								return Object.freeze({ status: "error" });
							}
						});
					},
					close(): unknown {
						if (owner.consumed && owner.closeP !== null) return owner.closeP;
						if (owner.consumed) return Promise.resolve(Object.freeze({ status: "error" }));
						owner.consumed = true;
						// Set close intent once; return shared close Promise
						return requestOwnerClose(owner);
					},
				});
				return Object.freeze({ status: "opened", handle: readHandle });
			});
		},

		close(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (closeP) return closeP;
			closed = true;
			closeP = recoveryTail.then(
				async () => {
					const ok = await closeAllOwners();
					return Object.freeze({ status: ok ? "closed" : "error" });
				},
				async () => {
					const ok = await closeAllOwners();
					return Object.freeze({ status: ok ? "closed" : "error" });
				},
			);
			return closeP;
		},
	});
}

// ===========================================================================
// Factory entry point
// ===========================================================================

export async function createSandboxJournalBackend(raw: unknown): Promise<CreateSandboxJournalBackendResult> {
	let directoryOwner: FileHandle | null = null;
	let identityOwner: FileHandle | null = null;
	let pubDirHandle: FileHandle | null = null;
	let pubIdHandle: FileHandle | null = null;
	let recDirHandle: FileHandle | null = null;
	let recIdHandle: FileHandle | null = null;
	let identityBytes: Uint8Array | null = null;
	let transferred = false;
	const pubTail: { current: Promise<void> } = { current: Promise.resolve() };
	let _finalResult: CreateSandboxJournalBackendResult = Object.freeze({
		ok: false,
		error: Object.freeze({ code: "IO_UNCERTAIN" }),
	});
	try {
		_finalResult = await (async (): Promise<CreateSandboxJournalBackendResult> => {
			const input = descriptors(raw);
			if (!input) return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			const inputKeys = Object.getOwnPropertyNames(input);
			if (inputKeys.length !== INPUT_KEYS.size) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			}
			for (const k of inputKeys) {
				if (!INPUT_KEYS.has(k))
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
				const desc = input[k];
				if (!desc || !("value" in desc) || !desc.enumerable) {
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
				}
			}
			const directoryPath = input.directoryPath.value;
			const identityRaw = input.identity.value;
			const kindRaw = input.kind.value;
			if (
				typeof directoryPath !== "string" ||
				typeof identityRaw !== "object" ||
				identityRaw === null ||
				typeof kindRaw !== "string"
			) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			}
			const kind = getKindDescriptor(kindRaw);
			if (!kind) return Object.freeze({ ok: false, error: Object.freeze({ code: "KIND_INVALID" }) });

			const identityDesc = descriptors(identityRaw);
			if (!identityDesc) return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			const idKeys = Object.getOwnPropertyNames(identityDesc);
			if (idKeys.length !== IDENTITY_KEYS.size) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			}
			for (const k of idKeys) {
				if (!IDENTITY_KEYS.has(k))
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
				const desc = identityDesc[k];
				if (!desc || !("value" in desc) || !desc.enumerable) {
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
				}
			}
			const hostId = identityDesc.hostId.value;
			const generation = identityDesc.generation.value;
			const sessionId = identityDesc.sessionId.value;
			if (!validId(hostId) || !validId(generation) || !validId(sessionId)) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			}
			const uid = getUid();
			if (uid === undefined) return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
			const uidStr = String(uid);
			const directory = await openDir(directoryPath, uidStr);
			if (!directory.ok) return Object.freeze({ ok: false, error: Object.freeze({ code: directory.code }) });
			directoryOwner = directory.handle;
			identityBytes = serializeIdentity({ generation, hostId, sessionId, kind: kind.name });
			if (identityBytes.byteLength > IDENTITY_MAX_BYTES) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INPUT_INVALID" }) });
			}
			const identityPath = join(directory.resolved, IDENTITY_FILE);
			const publication = await publishIdentity(
				identityPath,
				identityBytes,
				uidStr,
				directory.resolved,
				directoryOwner,
				directory.id,
			);
			if (publication === "uncertain") {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "IO_UNCERTAIN" }) });
			}
			const openedIdentity = await openIdentityOwner(identityPath, identityBytes, uidStr);
			if (openedIdentity.status !== "opened") {
				if (openedIdentity.status === "uncertain") {
					return Object.freeze({ ok: false, error: Object.freeze({ code: "IO_UNCERTAIN" }) });
				}
				return Object.freeze({
					ok: false,
					error: Object.freeze({
						code: publication === "exists" ? "IDENTITY_MISMATCH" : "DIRECTORY_UNSAFE",
					}),
				});
			}
			identityOwner = openedIdentity.handle;
			if (
				!(await verifyDirectoryOwner(directory.resolved, directoryOwner, directory.id)) ||
				!(await verifyFileOwner(identityPath, identityOwner, openedIdentity.identity, uidStr))
			) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
			}
			const rawEntries = await scanJournalDir(directory.resolved, kind);
			if (rawEntries === null) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
			}
			if (
				!(await verifyDirectoryOwner(directory.resolved, directoryOwner, directory.id)) ||
				!(await verifyFileOwner(identityPath, identityOwner, openedIdentity.identity, uidStr))
			) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
			}

			// Derive nextSequence and totalBytes from disk with validation
			let nextSequence = 1;
			let totalBytes = 0;
			for (const entry of rawEntries) {
				const parsed = parseName(entry.name, kind);
				if (parsed !== null) {
					if (parsed.sequence >= nextSequence) nextSequence = parsed.sequence + 1;
					const st = entry.stat;
					if (
						typeof st.size !== "number" ||
						!Number.isSafeInteger(st.size) ||
						st.size < 0 ||
						st.uid !== uidStr ||
						st.mode !== FILE_MODE ||
						st.nlink !== 1 ||
						!st.isFile ||
						st.isSymlink
					) {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
					}
					if (totalBytes + st.size > 268_435_456 || !Number.isSafeInteger(totalBytes + st.size)) {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
					}
					totalBytes += st.size;
				}
			}
			if (nextSequence > kind.maxSeq + 1) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
			}

			// Open physically distinct handles for publisher and recovery
			pubDirHandle = await openDirectoryOwner(directory.resolved, directory.id);
			pubIdHandle = await open(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			recDirHandle = await openDirectoryOwner(directory.resolved, directory.id);
			recIdHandle = await open(identityPath, constants.O_RDONLY | constants.O_NOFOLLOW);
			if (!pubDirHandle || !pubIdHandle || !recDirHandle || !recIdHandle) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "IO_UNCERTAIN" }) });
			}
			if (
				!(await verifyDirectoryOwner(directory.resolved, pubDirHandle, directory.id)) ||
				!(await verifyFileOwner(identityPath, pubIdHandle, openedIdentity.identity, uidStr)) ||
				!(await verifyDirectoryOwner(directory.resolved, recDirHandle, directory.id)) ||
				!(await verifyFileOwner(identityPath, recIdHandle, openedIdentity.identity, uidStr))
			) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "DIRECTORY_UNSAFE" }) });
			}

			// Close factory-owned handles before returning
			const _idCloseOk = await closeHandle(identityOwner);
			const _dirCloseOk = await closeHandle(directoryOwner);
			identityOwner = null;
			directoryOwner = null;
			if (!_idCloseOk || !_dirCloseOk) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "IO_UNCERTAIN" }) });
			}

			const publisher = makePublisher(
				directory.resolved,
				directory.id,
				identityPath,
				openedIdentity.identity,
				uidStr,
				kind,
				pubTail,
				pubDirHandle,
				pubIdHandle,
				nextSequence,
				totalBytes,
			);
			const recoveryBackend = makeRecoveryBackend(
				directory.resolved,
				directory.id,
				identityPath,
				openedIdentity.identity,
				uidStr,
				kind,
				recDirHandle,
				recIdHandle,
				pubTail,
			);
			const out = Object.freeze({
				ok: true,
				publisher,
				recoveryBackend,
			});
			transferred = true;
			return out;
		})();
		if (_finalResult.ok) {
			transferred = true;
		}
	} catch {
		_finalResult = Object.freeze({ ok: false, error: Object.freeze({ code: "IO_UNCERTAIN" }) });
	} finally {
		erase(identityBytes);
		if (!transferred) {
			// Close in reverse acquisition order: recId, recDir, pubId, pubDir, identityOwner, directoryOwner
			// Preserve every attempt; any failure overrides to IO_UNCERTAIN
			let anyFail = false;
			if (!(await closeHandle(recIdHandle))) anyFail = true;
			if (!(await closeHandle(recDirHandle))) anyFail = true;
			if (!(await closeHandle(pubIdHandle))) anyFail = true;
			if (!(await closeHandle(pubDirHandle))) anyFail = true;
			if (!(await closeHandle(identityOwner))) anyFail = true;
			if (!(await closeHandle(directoryOwner))) anyFail = true;
			if (anyFail) {
				_finalResult = Object.freeze({ ok: false, error: Object.freeze({ code: "IO_UNCERTAIN" }) });
			}
		}
	}
	return _finalResult;
}
