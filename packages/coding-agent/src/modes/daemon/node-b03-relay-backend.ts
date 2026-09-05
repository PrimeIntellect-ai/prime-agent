/**
 * Node FS production backend for B03 DurableRelayStore.
 *
 * createNodeB03RelayBackend(raw) creates or joins a b03 journal directory
 * at the canonical absolute path, binds identity+direction in identity.json,
 * and returns three distinct independent capability objects:
 *
 *   journalPublisher  — wraps publishImmutableJournalRecord
 *   deliveryPublisher — wraps publishImmutableDeliveryMarker
 *   recoveryBackend   — implements B03 listPage / open / read handle contract
 *
 * Security pattern derived from node-durable-observation-backend:
 *   mkdir 0700, realpath exact, O_DIRECTORY|O_NOFOLLOW handle,
 *   uid/mode/dev/ino validation on every operation,
 *   identity O_EXCL + fsync file+dir + reopen verify,
 *   no symlinks/hardlinks, bounded sorted page max 64/16MiB,
 *   names only exact b03 suffixes plus ignore identity.json,
 *   bigint-safe stat conversion, one-open readAt short-read semantics
 *   with full-backing genuine Uint8Array output, confirmEof,
 *   fstat identity, close consumes ownership even on throw.
 *
 * No sync fs / dynamic imports / any / shell.
 * IDs are opaque Home-local only.
 * Directory creation only below an existing canonical private parent; parent and
 * final directory ownership remain inode-bound and verified.
 */

import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, sep } from "node:path";
import { types } from "node:util";
import type { B03Entry, B03EntryStat } from "./b03-recovery-directory.js";
import {
	DELIVERY_MARKER_SUFFIX,
	type DeliveryMarkerPublishOptions,
	JOURNAL_RECORD_SUFFIX,
	type PublishOptions,
	publishImmutableDeliveryMarker,
	publishImmutableJournalRecord,
} from "./immutable-journal-publisher.js";

// ===========================================================================
// Constants
// ===========================================================================

const INPUT_KEYS = new Set(["directoryPath", "identity", "direction"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const PAGE_REQUEST_KEYS = new Set(["cursor", "maxEntries", "maxBytes"]);
const OPEN_REQUEST_KEYS = new Set(["name", "expected"]);
const STAT_KEYS = new Set(["dev", "ino", "uid", "mode", "size", "nlink", "isFile", "isSymlink", "mtimeNs", "ctimeNs"]);
const PUBLISH_KEYS = new Set(["journalDir", "seq", "bytes"]);
const DELIVERY_PUBLISH_KEYS = new Set(["journalDir", "indexSeq", "bytes"]);

const IDENTITY_FILE = "identity.json";
const B03_RE = /^\d{20}\.b03-(?:delivery|journal)$/;
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_DIRECTORY_PATH = 4096;
const MAX_PAGE_COUNT = 64;
const MAX_PAGE_BYTES = 16_777_216;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NO_SPECIAL_MODE = 0o7000;
const FILE_MAX_BYTES = 1_310_720;
const READ_MAX_BYTES = 65_536;
const IDENTITY_MAX_BYTES = 4096;

// ===========================================================================
// Types
// ===========================================================================

export type B03RelayBackendErrorCode = "DIRECTORY_UNSAFE" | "IDENTITY_MISMATCH" | "INPUT_INVALID" | "IO_UNCERTAIN";

export type CreateNodeB03RelayBackendResult =
	| Readonly<{
			ok: true;
			journalDir: string;
			journalPublisher: NodeB03JournalPublisherCapability;
			deliveryPublisher: NodeB03DeliveryPublisherCapability;
			recoveryBackend: NodeB03RecoveryBackendCapability;
	  }>
	| Readonly<{ ok: false; error: Readonly<{ code: B03RelayBackendErrorCode }> }>;

export interface NodeB03JournalPublisherCapability {
	readonly publish: (raw: unknown) => unknown;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export interface NodeB03DeliveryPublisherCapability {
	readonly publish: (raw: unknown) => unknown;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export interface NodeB03RecoveryBackendCapability {
	readonly listPage: (raw: unknown) => Promise<unknown>;
	readonly open: (raw: unknown) => Promise<unknown>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

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

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;

// ===========================================================================
// Helpers
// ===========================================================================

function failure(code: B03RelayBackendErrorCode): CreateNodeB03RelayBackendResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function descriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const d = descriptors(raw);
	if (!d) return null;
	const names = Object.getOwnPropertyNames(d);
	if (names.length !== keys.size || names.some((n) => !keys.has(n))) return null;
	for (const name of names) {
		const desc = d[name];
		if (!desc || !("value" in desc) || !desc.enumerable) return null;
	}
	return d;
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

function erase(bytes: Uint8Array | null): void {
	if (bytes === null) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
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

function bigintToSafe(v: bigint, max: number): number | null {
	if (v < 0n) return null;
	const n = Number(v);
	if (!Number.isSafeInteger(n) || n < 0 || n > max) return null;
	return n;
}

function bigintStr(v: bigint): string {
	return String(v);
}

function validId(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length <= 128 && SAFE_ID_RE.test(raw);
}

function validDecimal(raw: unknown): raw is string {
	return typeof raw === "string" && raw.length >= 1 && raw.length <= 32 && DECIMAL_RE.test(raw);
}

function validateDirection(raw: unknown): raw is "sent" | "received" {
	return raw === "sent" || raw === "received";
}

function parseB03Name(name: string): { kind: "journal" | "delivery"; sequence: number } | null {
	const m = B03_RE.exec(name);
	if (!m) return null;
	const seq = Number(name.slice(0, 20));
	if (!Number.isSafeInteger(seq) || seq < 1) return null;
	if (name.endsWith(JOURNAL_RECORD_SUFFIX) && seq <= 20_000) return { kind: "journal", sequence: seq };
	if (name.endsWith(DELIVERY_MARKER_SUFFIX) && seq <= 40_000) return { kind: "delivery", sequence: seq };
	return null;
}

// ===========================================================================
// Bigint stat snapshots
// ===========================================================================

function snapDirId(st: Record<string, unknown>, expectedUid: string): DirIdBs | null {
	const dev = st.dev;
	const ino = st.ino;
	const uid = st.uid;
	if (typeof dev !== "bigint" || typeof ino !== "bigint" || typeof uid !== "bigint") return null;
	const uidStr = bigintStr(uid);
	if (uidStr !== expectedUid) return null;
	const mode = st.mode;
	if (typeof mode !== "bigint") return null;
	const masked = mode & 0o7777n;
	const modeNum = bigintToSafe(masked, 0o7777);
	if (modeNum === null || (modeNum & 0o777) !== DIRECTORY_MODE || (modeNum & NO_SPECIAL_MODE) !== 0) {
		return null;
	}
	try {
		if (typeof st.isDirectory !== "function" || !st.isDirectory()) return null;
		if (typeof st.isSymbolicLink !== "function" || st.isSymbolicLink()) return null;
	} catch {
		return null;
	}
	return Object.freeze({ dev: bigintStr(dev), ino: bigintStr(ino), uid: uidStr });
}

function snapFileId(st: Record<string, unknown>, expectedUid: string, maxSize: number): FileIdBs | null {
	const dev = st.dev;
	const ino = st.ino;
	const uid = st.uid;
	if (typeof dev !== "bigint" || typeof ino !== "bigint" || typeof uid !== "bigint") return null;
	const uidStr = bigintStr(uid);
	if (uidStr !== expectedUid) return null;
	const mode = st.mode;
	if (typeof mode !== "bigint") return null;
	const masked = mode & 0o7777n;
	const modeNum = bigintToSafe(masked, 0o7777);
	if (modeNum === null || (modeNum & 0o777) !== FILE_MODE || (modeNum & NO_SPECIAL_MODE) !== 0) return null;
	const size = st.size;
	if (typeof size !== "bigint") return null;
	const sizeNum = bigintToSafe(size, maxSize);
	if (sizeNum === null || sizeNum < 1) return null;
	const nlink = st.nlink;
	if (typeof nlink !== "bigint") return null;
	const nlinkNum = bigintToSafe(nlink, 1);
	if (nlinkNum === null || nlinkNum !== 1) return null;
	try {
		if (typeof st.isFile !== "function" || !st.isFile()) return null;
		if (typeof st.isSymbolicLink !== "function" || st.isSymbolicLink()) return null;
	} catch {
		return null;
	}
	const mtimeNs = st.mtimeNs;
	const ctimeNs = st.ctimeNs;
	if (typeof mtimeNs !== "bigint" || typeof ctimeNs !== "bigint") return null;
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

function snapB03Stat(st: Record<string, unknown>): B03EntryStat | null {
	const dev = st.dev;
	const ino = st.ino;
	const uid = st.uid;
	if (typeof dev !== "bigint" || typeof ino !== "bigint" || typeof uid !== "bigint") return null;
	const mode = st.mode;
	if (typeof mode !== "bigint") return null;
	const masked = mode & 0o7777n;
	const modeNum = bigintToSafe(masked, 0o7777);
	if (modeNum === null) return null;
	const size = st.size;
	if (typeof size !== "bigint") return null;
	const sizeNum = bigintToSafe(size, FILE_MAX_BYTES);
	if (sizeNum === null || sizeNum < 1) return null;
	const nlink = st.nlink;
	if (typeof nlink !== "bigint") return null;
	const nlinkNum = bigintToSafe(nlink, 1);
	if (nlinkNum !== 1 || (modeNum & 0o777) !== FILE_MODE || (modeNum & NO_SPECIAL_MODE) !== 0) return null;
	try {
		if (typeof st.isFile !== "function" || !st.isFile()) return null;
		if (typeof st.isSymbolicLink !== "function" || st.isSymbolicLink()) return null;
	} catch {
		return null;
	}
	const mtimeNs = st.mtimeNs;
	const ctimeNs = st.ctimeNs;
	if (typeof mtimeNs !== "bigint" || typeof ctimeNs !== "bigint") return null;
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
// Identity serialization and ownership
// ===========================================================================

function serializeIdentity(
	value: Readonly<{ generation: string; hostId: string; sessionId: string; direction: "sent" | "received" }>,
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			version: 1,
			hostId: value.hostId,
			generation: value.generation,
			sessionId: value.sessionId,
			direction: value.direction,
		}),
	);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
	return difference === 0;
}

function dirIdEqual(left: DirIdBs, right: DirIdBs): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function verifyDirectoryOwner(path: string, handle: FileHandle, expected: DirIdBs): Promise<boolean> {
	try {
		const [pathStats, handleStats, resolved] = await Promise.all([
			lstat(path, { bigint: true }),
			handle.stat({ bigint: true }),
			realpath(path),
		]);
		const pathId = snapDirId(pathStats as unknown as Record<string, unknown>, expected.uid);
		const handleId = snapDirId(handleStats as unknown as Record<string, unknown>, expected.uid);
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
		const fileId = snapFileId(
			(await handle.stat({ bigint: true })) as unknown as Record<string, unknown>,
			uidStr,
			IDENTITY_MAX_BYTES,
		);
		if (!fileId || fileId.size !== content.byteLength) return "uncertain";
		await handle.sync();
		const owner = handle;
		handle = null;
		if (!(await closeHandle(owner))) return "uncertain";
		if (!(await verifyDirectoryOwner(directoryPath, directory, directoryId))) return "uncertain";
		await directory.sync();
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
		const before = snapFileId(
			(await handle.stat({ bigint: true })) as unknown as Record<string, unknown>,
			uidStr,
			IDENTITY_MAX_BYTES,
		);
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
				const after = snapFileId(
					(await handle.stat({ bigint: true })) as unknown as Record<string, unknown>,
					uidStr,
					IDENTITY_MAX_BYTES,
				);
				if (eofRead !== 0 || !after || !fileIdEqual(before, after)) outcome = "uncertain";
				else if (!bytesEqual(bytes, expectedContent)) outcome = "mismatch";
				else {
					const owned = handle;
					handle = null;
					return Object.freeze({ status: "opened" as const, handle: owned, identity: after });
				}
			}
		}
	} catch {
		outcome = "uncertain";
	} finally {
		erase(bytes);
	}
	const closeOk = await closeHandle(handle);
	return Object.freeze({ status: closeOk ? outcome : ("uncertain" as const) });
}

async function verifyIdentityOwner(
	path: string,
	handle: FileHandle,
	expected: FileIdBs,
	uidStr: string,
): Promise<boolean> {
	try {
		const [pathStats, handleStats] = await Promise.all([
			lstat(path, { bigint: true }),
			handle.stat({ bigint: true }),
		]);
		const pathId = snapFileId(pathStats as unknown as Record<string, unknown>, uidStr, IDENTITY_MAX_BYTES);
		const handleId = snapFileId(handleStats as unknown as Record<string, unknown>, uidStr, IDENTITY_MAX_BYTES);
		return pathId !== null && handleId !== null && fileIdEqual(pathId, expected) && fileIdEqual(handleId, expected);
	} catch {
		return false;
	}
}

async function verifyIdentityPath(path: string, expected: FileIdBs, uidStr: string): Promise<boolean> {
	try {
		const identity = snapFileId(
			(await lstat(path, { bigint: true })) as unknown as Record<string, unknown>,
			uidStr,
			IDENTITY_MAX_BYTES,
		);
		return identity !== null && fileIdEqual(identity, expected);
	} catch {
		return false;
	}
}

// ===========================================================================
// Directory setup
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
	{ ok: true; resolved: string; handle: FileHandle; id: DirIdBs } | { ok: false; code: B03RelayBackendErrorCode }
> {
	if (
		typeof path !== "string" ||
		!isAbsolute(path) ||
		path.length === 0 ||
		path.length > MAX_DIRECTORY_PATH ||
		path.includes(" ")
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
		const parentId = snapDirId(
			(await parentHandle.stat({ bigint: true })) as unknown as Record<string, unknown>,
			uidStr,
		);
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
		const snap = snapDirId((await handle.stat({ bigint: true })) as unknown as Record<string, unknown>, uidStr);
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

// ===========================================================================
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

// B03 directory scan
// ===========================================================================

async function scanB03(dir: string, uidStr: string): Promise<readonly B03Entry[] | null> {
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return null;
	}
	if (names.length > 60_000) return null;
	const filtered: string[] = [];
	for (const name of names) {
		if (name === IDENTITY_FILE) continue;
		if (!parseB03Name(name)) return null;
		filtered.push(name);
	}
	filtered.sort();
	const entries: B03Entry[] = [];
	for (const name of filtered) {
		let st: Record<string, unknown>;
		try {
			const raw = await lstat(join(dir, name), { bigint: true });
			st = raw as unknown as Record<string, unknown>;
		} catch {
			return null;
		}
		const snap = snapB03Stat(st);
		if (!snap || snap.uid !== uidStr) return null;
		entries.push(Object.freeze({ name, stat: snap }));
	}
	return entries;
}

// ===========================================================================
// Publisher capabilities (exact-own wrappers)
// ===========================================================================

function typedArrayGetter(
	value: object,
	key: "buffer" | "byteOffset" | "byteLength",
): ((this: unknown) => unknown) | null {
	let current: object | null = Object.getPrototypeOf(value);
	for (let depth = 0; current !== null && depth < 5; depth += 1) {
		const descriptor = Object.getOwnPropertyDescriptor(current, key);
		if (descriptor?.get) return descriptor.get;
		current = Object.getPrototypeOf(current);
	}
	return null;
}

function takeTransferredBytes(value: unknown): Uint8Array | null {
	if (typeof value !== "object" || value === null) return null;
	let caller: Uint8Array | null = null;
	let owned: Uint8Array | null = null;
	try {
		if (types.isProxy(value) || Object.getPrototypeOf(value) !== Uint8Array.prototype) return null;
		if (Object.hasOwn(value, "buffer") || Object.hasOwn(value, "byteOffset") || Object.hasOwn(value, "byteLength")) {
			return null;
		}
		const bufferGetter = typedArrayGetter(value, "buffer");
		const offsetGetter = typedArrayGetter(value, "byteOffset");
		const lengthGetter = typedArrayGetter(value, "byteLength");
		const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;
		if (!bufferGetter || !offsetGetter || !lengthGetter || !arrayBufferLengthGetter) return null;
		const backing = bufferGetter.call(value);
		if (
			typeof backing !== "object" ||
			backing === null ||
			types.isProxy(backing) ||
			Object.getPrototypeOf(backing) !== ArrayBuffer.prototype
		)
			return null;
		const offset = offsetGetter.call(value);
		const length = lengthGetter.call(value);
		const backingLength = arrayBufferLengthGetter.call(backing);
		if (
			offset !== 0 ||
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length !== backingLength ||
			length > FILE_MAX_BYTES
		)
			return null;
		caller = value as Uint8Array;
		owned = new Uint8Array(length);
		Uint8Array.prototype.set.call(owned, caller);
		erase(caller);
		return owned;
	} catch {
		erase(caller);
		erase(owned);
		return null;
	}
}

async function consumeRejectedJournal(raw: unknown, descriptors: Descriptors | null): Promise<void> {
	const input = descriptors
		? (Object.freeze({
				journalDir: "",
				seq: descriptors.seq.value,
				bytes: descriptors.bytes.value,
			}) as PublishOptions)
		: (raw as PublishOptions);
	try {
		await publishImmutableJournalRecord(input);
	} catch {
		// Ownership is uncertain, but no rejected input bytes remain knowingly owned here.
	}
}

async function consumeRejectedDelivery(raw: unknown, descriptors: Descriptors | null): Promise<void> {
	const input = descriptors
		? (Object.freeze({
				journalDir: "",
				indexSeq: descriptors.indexSeq.value,
				bytes: descriptors.bytes.value,
			}) as DeliveryMarkerPublishOptions)
		: (raw as DeliveryMarkerPublishOptions);
	try {
		await publishImmutableDeliveryMarker(input);
	} catch {
		// Ownership is uncertain, but no rejected input bytes remain knowingly owned here.
	}
}

function makeJournalPub(
	journalDir: string,
	directory: FileHandle,
	directoryId: DirIdBs,
	identityPath: string,
	identityId: FileIdBs,
	uidStr: string,
): NodeB03JournalPublisherCapability {
	let closed = false;
	let poisoned = false;
	let tail: Promise<void> = Promise.resolve();
	let closeP: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;

	async function run(input: PublishOptions): Promise<unknown> {
		if (poisoned) {
			await consumeRejectedJournal(input, exact(input, PUBLISH_KEYS));
			return Object.freeze({ status: "IO_UNCONFIRMED" });
		}
		if (
			!(await verifyDirectoryOwner(journalDir, directory, directoryId)) ||
			!(await verifyIdentityPath(identityPath, identityId, uidStr))
		) {
			poisoned = true;
			await consumeRejectedJournal(input, exact(input, PUBLISH_KEYS));
			return Object.freeze({ status: "IO_UNCONFIRMED" });
		}
		let result: Awaited<ReturnType<typeof publishImmutableJournalRecord>>;
		try {
			result = await publishImmutableJournalRecord(input);
		} catch {
			poisoned = true;
			return Object.freeze({ status: "IO_UNCONFIRMED" });
		}
		if (
			(await verifyDirectoryOwner(journalDir, directory, directoryId)) &&
			(await verifyIdentityPath(identityPath, identityId, uidStr))
		)
			return result;
		poisoned = true;
		return result.status === "success"
			? Object.freeze({
					status: "POST_PUBLICATION_UNCERTAIN" as const,
					seq: result.seq,
					size: result.size,
					sha256: result.sha256,
				})
			: Object.freeze({ status: "IO_UNCONFIRMED" });
	}

	return Object.freeze({
		publish(raw: unknown): unknown {
			const descriptors = exact(raw, PUBLISH_KEYS);
			if (!descriptors || closed || poisoned || descriptors.journalDir.value !== journalDir) {
				return consumeRejectedJournal(raw, descriptors).then(() => Object.freeze({ status: "error" as const }));
			}
			const bytes = takeTransferredBytes(descriptors.bytes.value);
			if (!bytes) {
				return consumeRejectedJournal(raw, descriptors).then(() => Object.freeze({ status: "error" as const }));
			}
			const captured = Object.freeze({ journalDir, seq: descriptors.seq.value, bytes }) as PublishOptions;
			const operation = tail.then(
				() => run(captured),
				() => run(captured),
			);
			tail = operation.then(
				() => undefined,
				() => {
					poisoned = true;
				},
			);
			return operation;
		},
		close(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (closeP) return closeP;
			closed = true;
			closeP = tail.then(
				async () => Object.freeze({ status: (await closeHandle(directory)) ? "closed" : "error" }),
				async () => Object.freeze({ status: (await closeHandle(directory)) ? "closed" : "error" }),
			);
			return closeP;
		},
	});
}

function makeDeliveryPub(
	journalDir: string,
	directory: FileHandle,
	directoryId: DirIdBs,
	identityPath: string,
	identityId: FileIdBs,
	uidStr: string,
): NodeB03DeliveryPublisherCapability {
	let closed = false;
	let poisoned = false;
	let tail: Promise<void> = Promise.resolve();
	let closeP: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;

	async function run(input: DeliveryMarkerPublishOptions): Promise<unknown> {
		if (poisoned) {
			await consumeRejectedDelivery(input, exact(input, DELIVERY_PUBLISH_KEYS));
			return Object.freeze({ status: "IO_UNCONFIRMED" });
		}
		if (
			!(await verifyDirectoryOwner(journalDir, directory, directoryId)) ||
			!(await verifyIdentityPath(identityPath, identityId, uidStr))
		) {
			poisoned = true;
			await consumeRejectedDelivery(input, exact(input, DELIVERY_PUBLISH_KEYS));
			return Object.freeze({ status: "IO_UNCONFIRMED" });
		}
		let result: Awaited<ReturnType<typeof publishImmutableDeliveryMarker>>;
		try {
			result = await publishImmutableDeliveryMarker(input);
		} catch {
			poisoned = true;
			return Object.freeze({ status: "IO_UNCONFIRMED" });
		}
		if (
			(await verifyDirectoryOwner(journalDir, directory, directoryId)) &&
			(await verifyIdentityPath(identityPath, identityId, uidStr))
		)
			return result;
		poisoned = true;
		return result.status === "success"
			? Object.freeze({
					status: "POST_PUBLICATION_UNCERTAIN" as const,
					sequence: result.sequence,
					size: result.size,
					sha256: result.sha256,
				})
			: Object.freeze({ status: "IO_UNCONFIRMED" });
	}

	return Object.freeze({
		publish(raw: unknown): unknown {
			const descriptors = exact(raw, DELIVERY_PUBLISH_KEYS);
			if (!descriptors || closed || poisoned || descriptors.journalDir.value !== journalDir) {
				return consumeRejectedDelivery(raw, descriptors).then(() => Object.freeze({ status: "error" as const }));
			}
			const bytes = takeTransferredBytes(descriptors.bytes.value);
			if (!bytes) {
				return consumeRejectedDelivery(raw, descriptors).then(() => Object.freeze({ status: "error" as const }));
			}
			const captured = Object.freeze({
				journalDir,
				indexSeq: descriptors.indexSeq.value,
				bytes,
			}) as DeliveryMarkerPublishOptions;
			const operation = tail.then(
				() => run(captured),
				() => run(captured),
			);
			tail = operation.then(
				() => undefined,
				() => {
					poisoned = true;
				},
			);
			return operation;
		},
		close(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (closeP) return closeP;
			closed = true;
			closeP = tail.then(
				async () => Object.freeze({ status: (await closeHandle(directory)) ? "closed" : "error" }),
				async () => Object.freeze({ status: (await closeHandle(directory)) ? "closed" : "error" }),
			);
			return closeP;
		},
	});
}

// ===========================================================================
// Recovery backend (closure-based, exact-own, no class prototype)
// ===========================================================================

interface OpenedReadOwner {
	readonly handle: FileHandle;
	consumed: boolean;
}

function makeRecoveryBackend(
	dirPath: string,
	uidStr: string,
	dirHandle: FileHandle,
	dirId: DirIdBs,
	idHandle: FileHandle,
	idId: FileIdBs,
): NodeB03RecoveryBackendCapability {
	let closed = false;
	let poisoned = false;
	let expectedCursor: string | null = null;
	let tail: Promise<void> = Promise.resolve();
	let handleTail: Promise<void> = Promise.resolve();
	let closeP: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	const openedHandles = new Set<OpenedReadOwner>();
	let handleCloseUncertain = false;
	const idPath = join(dirPath, IDENTITY_FILE);

	async function checkStorage(): Promise<boolean> {
		return (
			(await verifyDirectoryOwner(dirPath, dirHandle, dirId)) &&
			(await verifyIdentityOwner(idPath, idHandle, idId, uidStr))
		);
	}

	function enq<T>(fn: () => Promise<T>): Promise<T> {
		const result = tail.then(fn, fn);
		tail = result.then(
			() => undefined,
			() => {
				poisoned = true;
			},
		);
		return result;
	}

	function enqHandle<T>(fn: () => Promise<T>): Promise<T> {
		const result = handleTail.then(fn, fn);
		handleTail = result.then(
			() => undefined,
			() => {
				poisoned = true;
			},
		);
		return result;
	}

	async function closeAllHandles(): Promise<boolean> {
		await handleTail;
		let ok = !handleCloseUncertain;
		for (const owner of openedHandles) {
			if (owner.consumed) continue;
			owner.consumed = true;
			if (!(await closeHandle(owner.handle))) ok = false;
		}
		openedHandles.clear();
		if (!(await closeHandle(idHandle))) ok = false;
		if (!(await closeHandle(dirHandle))) ok = false;
		return ok;
	}

	return Object.freeze({
		listPage(raw: unknown): Promise<unknown> {
			return enq(async () => {
				if (closed || poisoned) return Object.freeze({ status: "error" });
				const d = exact(raw, PAGE_REQUEST_KEYS);
				if (!d) return Object.freeze({ status: "error" });
				const cursor = d.cursor.value as string | null;
				const maxCount = d.maxEntries.value as number;
				const maxBytes = d.maxBytes.value as number;
				if (cursor !== null && (typeof cursor !== "string" || !parseB03Name(cursor))) {
					return Object.freeze({ status: "error" });
				}
				if (
					!Number.isSafeInteger(maxCount) ||
					maxCount < 1 ||
					maxCount > MAX_PAGE_COUNT ||
					!Number.isSafeInteger(maxBytes) ||
					maxBytes < 1 ||
					maxBytes > MAX_PAGE_BYTES
				) {
					return Object.freeze({ status: "error" });
				}
				if (cursor !== expectedCursor) {
					if (cursor !== null || expectedCursor !== null) return Object.freeze({ status: "error" });
				}
				if (!(await checkStorage())) {
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				// Re-scan directory entries each listPage call for consistency
				let currentEntries: readonly B03Entry[];
				const scanned = await scanB03(dirPath, uidStr);
				if (scanned === null) {
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				currentEntries = scanned;
				if (!(await checkStorage())) {
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				let start = 0;
				if (cursor !== null) {
					const idx = currentEntries.findIndex((e) => e.name === cursor);
					if (idx < 0) {
						poisoned = true;
						return Object.freeze({ status: "error" });
					}
					start = idx + 1;
				}
				const page: B03Entry[] = [];
				let pageBytes = 0;
				for (let i = start; i < currentEntries.length && page.length < maxCount; i++) {
					const e = currentEntries[i];
					if (pageBytes + e.stat.size > maxBytes && page.length > 0) break;
					page.push(Object.freeze({ name: e.name, stat: e.stat }));
					pageBytes += e.stat.size;
				}
				const lastName = page.at(-1)?.name ?? null;
				let nextCursor: string | null = null;
				if (lastName !== null) {
					const li = currentEntries.findIndex((e) => e.name === lastName);
					if (li < 0) {
						poisoned = true;
						return Object.freeze({ status: "error" });
					}
					if (li + 1 < currentEntries.length) nextCursor = lastName;
				}
				expectedCursor = nextCursor;
				return Object.freeze({ entries: Object.freeze(page), nextCursor });
			});
		},

		open(raw: unknown): Promise<unknown> {
			return enq(async () => {
				if (closed || poisoned) return Object.freeze({ status: "error" });
				const request = exact(raw, OPEN_REQUEST_KEYS);
				if (!request) return Object.freeze({ status: "error" });
				const name = request.name.value;
				const expectedRaw = request.expected.value;
				if (typeof name !== "string" || !parseB03Name(name)) return Object.freeze({ status: "error" });
				const expected = exact(expectedRaw, STAT_KEYS);
				if (!expected) return Object.freeze({ status: "error" });
				const expectedStat: B03EntryStat = Object.freeze({
					dev: expected.dev.value as string,
					ino: expected.ino.value as string,
					uid: expected.uid.value as string,
					mode: expected.mode.value as number,
					size: expected.size.value as number,
					nlink: expected.nlink.value as number,
					isFile: expected.isFile.value as boolean,
					isSymlink: expected.isSymlink.value as boolean,
					mtimeNs: expected.mtimeNs.value as string,
					ctimeNs: expected.ctimeNs.value as string,
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
				)
					return Object.freeze({ status: "error" });
				if (!(await checkStorage())) {
					poisoned = true;
					return Object.freeze({ status: "error" });
				}
				const filePath = join(dirPath, name);
				let handle: FileHandle | null = null;
				try {
					const pathBefore = snapB03Stat(
						(await lstat(filePath, { bigint: true })) as unknown as Record<string, unknown>,
					);
					if (!pathBefore || !statEqual(pathBefore, expectedStat)) return Object.freeze({ status: "error" });
					handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
					const handleBefore = snapB03Stat(
						(await handle.stat({ bigint: true })) as unknown as Record<string, unknown>,
					);
					const pathAfter = snapB03Stat(
						(await lstat(filePath, { bigint: true })) as unknown as Record<string, unknown>,
					);
					if (
						!handleBefore ||
						!pathAfter ||
						!statEqual(handleBefore, expectedStat) ||
						!statEqual(pathAfter, expectedStat)
					) {
						const closeOk = await closeHandle(handle);
						handle = null;
						if (!closeOk) poisoned = true;
						return Object.freeze({ status: "error" });
					}
				} catch {
					const closeOk = await closeHandle(handle);
					if (!closeOk) poisoned = true;
					return Object.freeze({ status: "error" });
				}

				if (!(await checkStorage())) {
					poisoned = true;
					const closeOk = await closeHandle(handle);
					handle = null;
					if (!closeOk) handleCloseUncertain = true;
					return Object.freeze({ status: "error" });
				}
				const owner: OpenedReadOwner = { handle, consumed: false };
				handle = null;
				openedHandles.add(owner);
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
						return enqHandle(async () => {
							const buffer = new Uint8Array(size);
							try {
								const read = await owner.handle.read(buffer, 0, size, offset);
								if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 0 || read.bytesRead > size) {
									return Object.freeze({ status: "error" });
								}
								if (read.bytesRead === 0) return Object.freeze({ status: "eof" });
								const bytes = new Uint8Array(read.bytesRead);
								bytes.set(buffer.subarray(0, read.bytesRead));
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
						return enqHandle(async () => {
							const buffer = new Uint8Array(1);
							try {
								const read = await owner.handle.read(buffer, 0, 1, size);
								return Object.freeze({ status: read.bytesRead === 0 ? "eof" : "error" });
							} catch {
								return Object.freeze({ status: "error" });
							} finally {
								erase(buffer);
							}
						});
					},
					fstat(): unknown {
						if (closed || poisoned || owner.consumed) {
							return Promise.resolve(Object.freeze({ status: "error" }));
						}
						return enqHandle(async () => {
							try {
								if (!(await checkStorage())) {
									poisoned = true;
									return Object.freeze({ status: "error" });
								}
								const snapshot = snapB03Stat(
									(await owner.handle.stat({ bigint: true })) as unknown as Record<string, unknown>,
								);
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
						if (owner.consumed) return Promise.resolve(Object.freeze({ status: "error" }));
						owner.consumed = true;
						openedHandles.delete(owner);
						return enqHandle(async () => {
							const closeOk = await closeHandle(owner.handle);
							if (!closeOk) handleCloseUncertain = true;
							return Object.freeze({ status: closeOk ? "closed" : "error" });
						});
					},
				});
				return Object.freeze({ status: "opened", handle: readHandle });
			});
		},

		close(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (closeP) return closeP;
			closed = true;
			closeP = tail.then(
				async () => {
					const ok = await closeAllHandles();
					return Object.freeze({ status: ok ? "closed" : "error" });
				},
				async () => {
					const ok = await closeAllHandles();
					return Object.freeze({ status: ok ? "closed" : "error" });
				},
			);
			return closeP;
		},
	});
}

// ===========================================================================
// Main entry point
// ===========================================================================

export async function createNodeB03RelayBackend(raw: unknown): Promise<CreateNodeB03RelayBackendResult> {
	let directoryOwner: FileHandle | null = null;
	let identityOwner: FileHandle | null = null;
	let journalPublisherOwner: FileHandle | null = null;
	let deliveryPublisherOwner: FileHandle | null = null;
	let identityBytes: Uint8Array | null = null;
	let transferred = false;
	let result: CreateNodeB03RelayBackendResult;
	try {
		result = await (async (): Promise<CreateNodeB03RelayBackendResult> => {
			const input = exact(raw, INPUT_KEYS);
			const directoryPath = input?.directoryPath?.value;
			const identityRaw = input?.identity?.value;
			const direction = input?.direction?.value;
			if (
				typeof directoryPath !== "string" ||
				typeof identityRaw !== "object" ||
				identityRaw === null ||
				!validateDirection(direction)
			)
				return failure("INPUT_INVALID");
			const identity = exact(identityRaw, IDENTITY_KEYS);
			if (!identity) return failure("INPUT_INVALID");
			const hostId = identity.hostId.value;
			const generation = identity.generation.value;
			const sessionId = identity.sessionId.value;
			if (!validId(hostId) || !validId(generation) || !validId(sessionId)) {
				return failure("INPUT_INVALID");
			}
			const uid = getUid();
			if (uid === undefined) return failure("DIRECTORY_UNSAFE");
			const uidStr = String(uid);
			const directory = await openDir(directoryPath, uidStr);
			if (!directory.ok) return failure(directory.code);
			directoryOwner = directory.handle;
			identityBytes = serializeIdentity({ generation, hostId, sessionId, direction });
			if (identityBytes.byteLength > IDENTITY_MAX_BYTES) return failure("INPUT_INVALID");
			const identityPath = join(directory.resolved, IDENTITY_FILE);
			const publication = await publishIdentity(
				identityPath,
				identityBytes,
				uidStr,
				directory.resolved,
				directoryOwner,
				directory.id,
			);
			if (publication === "uncertain") return failure("IO_UNCERTAIN");
			const openedIdentity = await openIdentityOwner(identityPath, identityBytes, uidStr);
			if (openedIdentity.status !== "opened") {
				if (openedIdentity.status === "uncertain") return failure("IO_UNCERTAIN");
				return failure(publication === "exists" ? "IDENTITY_MISMATCH" : "DIRECTORY_UNSAFE");
			}
			identityOwner = openedIdentity.handle;
			if (
				!(await verifyDirectoryOwner(directory.resolved, directoryOwner, directory.id)) ||
				!(await verifyIdentityOwner(identityPath, identityOwner, openedIdentity.identity, uidStr))
			)
				return failure("DIRECTORY_UNSAFE");
			const entries = await scanB03(directory.resolved, uidStr);
			if (
				entries === null ||
				!(await verifyDirectoryOwner(directory.resolved, directoryOwner, directory.id)) ||
				!(await verifyIdentityOwner(identityPath, identityOwner, openedIdentity.identity, uidStr))
			)
				return failure("DIRECTORY_UNSAFE");
			journalPublisherOwner = await openDirectoryOwner(directory.resolved, directory.id);
			deliveryPublisherOwner = await openDirectoryOwner(directory.resolved, directory.id);
			if (!journalPublisherOwner || !deliveryPublisherOwner) return failure("IO_UNCERTAIN");
			const journalPublisher = makeJournalPub(
				directory.resolved,
				journalPublisherOwner,
				directory.id,
				identityPath,
				openedIdentity.identity,
				uidStr,
			);
			const deliveryPublisher = makeDeliveryPub(
				directory.resolved,
				deliveryPublisherOwner,
				directory.id,
				identityPath,
				openedIdentity.identity,
				uidStr,
			);
			const recoveryBackend = makeRecoveryBackend(
				directory.resolved,
				uidStr,
				directoryOwner,
				directory.id,
				identityOwner,
				openedIdentity.identity,
			);
			const successResult = Object.freeze({
				ok: true as const,
				journalDir: directory.resolved,
				journalPublisher,
				deliveryPublisher,
				recoveryBackend,
			});
			transferred = true;
			return successResult;
		})();
	} catch {
		result = failure("IO_UNCERTAIN");
	} finally {
		erase(identityBytes);
	}
	if (!transferred) {
		const identityClosed = await closeHandle(identityOwner);
		const journalPublisherClosed = await closeHandle(journalPublisherOwner);
		const deliveryPublisherClosed = await closeHandle(deliveryPublisherOwner);
		const directoryClosed = await closeHandle(directoryOwner);
		if (!identityClosed || !journalPublisherClosed || !deliveryPublisherClosed || !directoryClosed) {
			return failure("IO_UNCERTAIN");
		}
	}
	return result;
}
