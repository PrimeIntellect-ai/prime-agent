import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open as fsOpen, realpath as fsRealpath } from "node:fs/promises";
import { join } from "node:path";
import { types } from "node:util";
import { observeExactPromiseCall } from "./exact-promise-observer.js";
import { decodePawsManifestBytes, type PawsIdentity } from "./paws-stream-codec.js";

// ===========================================================================
// Captured intrinsics — all-or-nothing bundle
// ===========================================================================

const INTRINSICS: Readonly<{
	taFill: (value: number) => Uint8Array;
	taByteLengthGet: () => number;
	taBufferGet: () => ArrayBuffer;
	taByteOffsetGet: () => number;
	taSubarray: (begin: number, end?: number) => Uint8Array;
	taSet: (source: ArrayLike<number>, offset?: number) => void;
	abByteLengthGet: () => number;
	dvConstruct: DataViewConstructor;
	dvGetUint8: (byteOffset: number) => number;
	dvGetBigUint64: (byteOffset: number, littleEndian?: boolean) => bigint;

	taProto: object;
	taExactProto: object;
	abProto: object;
	isUint8Array: (value: unknown) => value is Uint8Array;
	isProxy: (value: unknown) => boolean;
	isPromise: (value: unknown) => value is Promise<unknown>;
}> | null = (() => {
	try {
		const taProto = Object.getPrototypeOf(Uint8Array.prototype);
		if (taProto === null || taProto === Object.prototype) return null;

		const fillDesc = Object.getOwnPropertyDescriptor(taProto, "fill");
		if (fillDesc === undefined || !("value" in fillDesc)) return null;
		if (typeof fillDesc.value !== "function" || types.isProxy(fillDesc.value)) return null;

		const blDesc = Object.getOwnPropertyDescriptor(taProto, "byteLength");
		if (blDesc === undefined || blDesc.get === undefined) return null;
		if (types.isProxy(blDesc.get)) return null;

		const bufDesc = Object.getOwnPropertyDescriptor(taProto, "buffer");
		if (bufDesc === undefined || bufDesc.get === undefined) return null;
		if (types.isProxy(bufDesc.get)) return null;

		const boDesc = Object.getOwnPropertyDescriptor(taProto, "byteOffset");
		if (boDesc === undefined || boDesc.get === undefined) return null;
		if (types.isProxy(boDesc.get)) return null;

		const subDesc = Object.getOwnPropertyDescriptor(taProto, "subarray");
		if (subDesc === undefined || !("value" in subDesc)) return null;
		if (typeof subDesc.value !== "function" || types.isProxy(subDesc.value)) return null;

		const setDesc = Object.getOwnPropertyDescriptor(taProto, "set");
		if (setDesc === undefined || !("value" in setDesc)) return null;
		if (typeof setDesc.value !== "function" || types.isProxy(setDesc.value)) return null;

		const abBlDesc = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength");
		if (abBlDesc === undefined || abBlDesc.get === undefined) return null;
		if (types.isProxy(abBlDesc.get)) return null;

		// Capture ArrayBuffer.prototype (not the live reference) for genuine-backing checks
		if (types.isProxy(ArrayBuffer.prototype)) return null;
		if (types.isProxy(Uint8Array.prototype)) return null;

		// DataView intrinsics — constructor and prototype getUint8/getBigUint64
		if (typeof DataView !== "function" || types.isProxy(DataView)) return null;

		const getUint8Desc = Object.getOwnPropertyDescriptor(DataView.prototype, "getUint8");
		if (getUint8Desc === undefined || !("value" in getUint8Desc)) return null;
		if (typeof getUint8Desc.value !== "function" || types.isProxy(getUint8Desc.value)) return null;

		const getBigUint64Desc = Object.getOwnPropertyDescriptor(DataView.prototype, "getBigUint64");
		if (getBigUint64Desc === undefined || !("value" in getBigUint64Desc)) return null;
		if (typeof getBigUint64Desc.value !== "function" || types.isProxy(getBigUint64Desc.value)) return null;

		return Object.freeze({
			taFill: fillDesc.value,
			taByteLengthGet: blDesc.get,
			taBufferGet: bufDesc.get,
			taByteOffsetGet: boDesc.get,
			taSubarray: subDesc.value,
			taSet: setDesc.value,
			abByteLengthGet: abBlDesc.get,
			dvConstruct: DataView,
			dvGetUint8: getUint8Desc.value,
			dvGetBigUint64: getBigUint64Desc.value,
			taProto: taProto,
			taExactProto: Uint8Array.prototype,
			abProto: ArrayBuffer.prototype,
			isUint8Array: types.isUint8Array,
			isProxy: types.isProxy,
			isPromise: types.isPromise,
		});
	} catch {
		return null;
	}
})();

const CAPTURED_GETUID = (() => {
	try {
		const d = Object.getOwnPropertyDescriptor(process, "getuid");
		if (d === undefined || !("value" in d)) return undefined;
		if (typeof d.value !== "function" || types.isProxy(d.value)) return undefined;
		return d.value;
	} catch {
		return undefined;
	}
})();

// ===========================================================================
// Delegated intrinsic accessors
// ===========================================================================

function eraseVerified(bytes: Uint8Array): boolean {
	if (INTRINSICS === null) return false;
	try {
		Reflect.apply(INTRINSICS.taFill, bytes, [0]);
		// Confirm every byte is actually zero — adversarial fill may lie
		const bl: unknown = Reflect.apply(INTRINSICS.taByteLengthGet, bytes, []);
		if (typeof bl !== "number" || !Number.isSafeInteger(bl) || bl < 0) return false;
		if (bl === 0) return true;
		const buf: unknown = Reflect.apply(INTRINSICS.taBufferGet, bytes, []);
		if (typeof buf !== "object" || buf === null || INTRINSICS.isProxy(buf)) return false;
		const byteOff: unknown = Reflect.apply(INTRINSICS.taByteOffsetGet, bytes, []);
		if (typeof byteOff !== "number" || !Number.isSafeInteger(byteOff) || byteOff < 0) return false;
		const dv = Reflect.construct(INTRINSICS.dvConstruct, [buf, byteOff, bl]);
		for (let i = 0; i < bl; i++) {
			if (Reflect.apply(INTRINSICS.dvGetUint8, dv, [i]) !== 0) return false;
		}
		return true;
	} catch {
		return false;
	}
}

// ===========================================================================
// Constants
// ===========================================================================

const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const HEADER_PREFIX = 13;
const FILE_MODE = 0o600;
const FILE_MODE_MASK = 0o777;
const DIRECTORY_MODE = 0o700;
const DIRECTORY_MODE_MASK = 0o777;
const SPECIAL_MODE_MASK = 0o7000;
const MAX_DIRECTORY_PATH = 4096;

const HEX64_RE = /^[0-9a-f]{64}$/;
const RELATIVE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;
const INPUT_KEYS = Object.freeze(
	new Set(["kind", "rootDir", "relativeName", "snapshotId", "baseSnapshotId", "changesetId"]),
);

// ===========================================================================
// Public types
// ===========================================================================

export type PawsVerificationFailureCode =
	| "ARCHIVE_TOO_LARGE"
	| "ARCHIVE_SIZE_MISMATCH"
	| "CLOSE_UNCONFIRMED"
	| "ERASURE_CONFIRM_FAILED"
	| "FILE_HASH_MISMATCH"
	| "IDENTITY_CHANGED"
	| "IDENTITY_INVALID"
	| "INPUT_INVALID"
	| "MANIFEST_INVALID"
	| "PARENT_INVALID"
	| "READ_FAILED"
	| "TRAILING_BYTES"
	| "UNEXPECTED_EOF";

export interface PawsSnapshotVerification {
	readonly kind: "snapshot";
	readonly snapshotId: string;
	readonly totalBytes: number;
	readonly entryCount: number;
	readonly archiveBytes: number;
}

export interface PawsChangesetVerification {
	readonly kind: "changeset";
	readonly snapshotId: string;
	readonly baseSnapshotId: string;
	readonly changesetId: string;
	readonly totalBytes: number;
	readonly entryCount: number;
	readonly archiveBytes: number;
}

export type PawsArchiveVerificationResult =
	| Readonly<{ ok: true; value: Readonly<PawsSnapshotVerification> }>
	| Readonly<{ ok: true; value: Readonly<PawsChangesetVerification> }>
	| Readonly<{ ok: false; error: Readonly<{ code: PawsVerificationFailureCode }> }>;

// ===========================================================================
// Module-private IO capture
// ===========================================================================

const IO_BRAND = new WeakSet<object>();
const IO_METHOD_NAMES: readonly string[] = Object.freeze(["realpath", "open", "getuid"]);

interface InnerIO {
	readonly realpath: (path: string) => unknown;
	readonly open: (path: string, flags: number) => unknown;
	readonly getuid: () => unknown;
	readonly brand: object;
}

function captureIORaw(raw: unknown): InnerIO | null {
	if (typeof raw !== "object" || raw === null) return null;
	if (types.isProxy(raw)) return null;
	try {
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length < 1) return null;
		for (const name of names) {
			if (!IO_METHOD_NAMES.includes(name)) return null;
		}
		const descs = Object.getOwnPropertyDescriptors(raw);
		const capturedMethods: Record<string, (...args: readonly unknown[]) => unknown> = Object.create(null);
		for (const key of IO_METHOD_NAMES) {
			const d = descs[key];
			if (d === undefined || !("value" in d) || d.get !== undefined || d.set !== undefined) return null;
			if (typeof d.value !== "function" || types.isProxy(d.value)) return null;
			capturedMethods[key] = d.value;
		}
		const brand = Object.freeze({});
		IO_BRAND.add(brand);
		const io: InnerIO = Object.freeze({
			realpath: (path: string): unknown => Reflect.apply(capturedMethods.realpath, raw, [path]),
			open: (path: string, flags: number): unknown => Reflect.apply(capturedMethods.open, raw, [path, flags]),
			getuid: (): unknown => Reflect.apply(capturedMethods.getuid, raw, []),
			brand,
		});
		if (!IO_BRAND.has(io.brand)) return null;
		return io;
	} catch {
		return null;
	}
}

function isBrandedIO(raw: unknown): raw is InnerIO {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		const d = Object.getOwnPropertyDescriptor(raw, "brand");
		if (d === undefined || !("value" in d)) return false;
		const b = d.value;
		return typeof b === "object" && b !== null && IO_BRAND.has(b);
	} catch {
		return false;
	}
}

const CAPTURED_OPEN = (() => {
	try {
		const d = Object.getOwnPropertyDescriptor({ open: fsOpen }, "open");
		return d !== undefined && "value" in d ? d.value : undefined;
	} catch {
		return undefined;
	}
})();

const CAPTURED_REALPATH = (() => {
	try {
		const d = Object.getOwnPropertyDescriptor({ realpath: fsRealpath }, "realpath");
		return d !== undefined && "value" in d ? d.value : undefined;
	} catch {
		return undefined;
	}
})();

const DEFAULT_IO: InnerIO | null = (() => {
	if (CAPTURED_OPEN === undefined || CAPTURED_REALPATH === undefined) return null;
	const rawIo = Object.freeze({
		realpath: (path: string): unknown => Reflect.apply(CAPTURED_REALPATH, undefined, [path]),
		open: (path: string, flags: number): unknown => Reflect.apply(CAPTURED_OPEN, undefined, [path, flags]),
		getuid: (): unknown => {
			if (typeof CAPTURED_GETUID !== "function" || types.isProxy(CAPTURED_GETUID)) return undefined;
			try {
				return Reflect.apply(CAPTURED_GETUID, process, []);
			} catch {
				return undefined;
			}
		},
	});
	return captureIORaw(rawIo);
})();

// ===========================================================================
// Internal types
// ===========================================================================

interface DirIdentity {
	readonly dev: string;
	readonly ino: string;
	readonly uid: string;
}
interface FileIdentity extends DirIdentity {
	readonly mode: number;
	readonly size: number;
	readonly nlink: number;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
}
interface ParsedInput {
	readonly rootDir: string;
	readonly relativeName: string;
	readonly kind: "snapshot" | "changeset";
	readonly snapshotId: string;
	readonly baseSnapshotId: string | undefined;
	readonly changesetId: string | undefined;
}
interface HandleBundle {
	readonly close: (this: unknown) => unknown;
	readonly stat: (this: unknown, options?: unknown) => unknown;
	readonly read: (this: unknown, ...args: readonly unknown[]) => unknown;
}

// Trusted promise observation delegated to exact-promise-observer.js
// (uses captureExactPromiseContext per-call to handle ALS contexts)

// ===========================================================================
// Helpers
// ===========================================================================

function isObject(raw: unknown): raw is object {
	return typeof raw === "object" && raw !== null;
}
function isString(raw: unknown): raw is string {
	return typeof raw === "string";
}
function hex64(s: unknown): s is string {
	return isString(s) && HEX64_RE.test(s);
}

function failure(code: PawsVerificationFailureCode): PawsArchiveVerificationResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code }) });
}

function allocateGenuineUint8Array(byteLength: number): Uint8Array {
	return new Uint8Array(new ArrayBuffer(byteLength));
}

function safeByteLength(bytes: Uint8Array): number {
	if (INTRINSICS === null) return 0;
	try {
		return Reflect.apply(INTRINSICS.taByteLengthGet, bytes, []);
	} catch {
		return 0;
	}
}

function isFullBackingGenuine(bytes: Uint8Array): boolean {
	if (INTRINSICS === null) return false;
	try {
		// Must be a genuine Uint8Array (captured intrinsic, not live call)
		if (!INTRINSICS.isUint8Array(bytes)) return false;
		// Must have the exact captured Uint8Array prototype
		if (Object.getPrototypeOf(bytes) !== INTRINSICS.taExactProto) return false;
		// Reject any own Symbols (hostile extras)
		if (Object.getOwnPropertySymbols(bytes).length > 0) return false;
		const ownNames = Object.getOwnPropertyNames(bytes);
		const byteLen: unknown = Reflect.apply(INTRINSICS.taByteLengthGet, bytes, []);
		if (typeof byteLen !== "number" || !Number.isSafeInteger(byteLen)) return false;
		// A genuine Uint8Array must have exactly byteLen own numeric-indexed properties
		if (ownNames.length !== byteLen) return false;
		for (const name of ownNames) {
			const n = Number(name);
			// Each name must be a canonical numeric string (e.g. "0" not "00")
			if (!Number.isSafeInteger(n) || n < 0 || n >= byteLen) return false;
			if (String(n) !== name) return false;
			// Every indexed property must be a genuine data descriptor (no accessor)
			const d: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(bytes, name);
			if (
				d === undefined ||
				!("value" in d) ||
				d.writable !== true ||
				d.enumerable !== true ||
				d.configurable !== true
			) {
				return false;
			}
		}
		const buf: unknown = Reflect.apply(INTRINSICS.taBufferGet, bytes, []);
		if (typeof buf !== "object" || buf === null) return false;
		if (INTRINSICS.isProxy(buf)) return false;
		// Use captured ArrayBuffer.prototype, not live reference
		if (Object.getPrototypeOf(buf) !== INTRINSICS.abProto) return false;
		const bufLen: unknown = Reflect.apply(INTRINSICS.abByteLengthGet, buf, []);
		if (typeof bufLen !== "number" || !Number.isSafeInteger(bufLen)) return false;
		if (bufLen !== byteLen) return false;
		const byteOff: unknown = Reflect.apply(INTRINSICS.taByteOffsetGet, bytes, []);
		if (typeof byteOff !== "number" || byteOff !== 0) return false;
		if (Object.getOwnPropertyNames(buf).length > 0) return false;
		if (Object.getOwnPropertySymbols(buf).length > 0) return false;
		return true;
	} catch {
		return false;
	}
}

function copyWithSubarraySet(
	target: Uint8Array,
	targetOffset: number,
	source: Uint8Array,
	sourceOffset: number,
	length: number,
): boolean {
	if (INTRINSICS === null) return false;
	try {
		const srcView = Reflect.apply(INTRINSICS.taSubarray, source, [sourceOffset, sourceOffset + length]);
		if (typeof srcView !== "object" || srcView === null || !INTRINSICS.isUint8Array(srcView)) return false;
		Reflect.apply(INTRINSICS.taSet, target, [srcView, targetOffset]);
		return true;
	} catch {
		return false;
	}
}

function readProp(obj: object, key: string): unknown {
	try {
		const d = Object.getOwnPropertyDescriptor(obj, key);
		if (d === undefined || d.get !== undefined || d.set !== undefined) return undefined;
		return d.value;
	} catch {
		return undefined;
	}
}

function snapshotInput(raw: unknown): ParsedInput | null {
	if (!isObject(raw)) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length === 0) return null;
		for (const name of names) {
			if (!INPUT_KEYS.has(name)) return null;
		}
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const d = descs[name];
			if (d === undefined || !("value" in d) || !d.enumerable) return null;
		}
		const kindDesc = descs.kind;
		if (kindDesc === undefined || !("value" in kindDesc)) return null;
		const k = kindDesc.value;
		if (k !== "snapshot" && k !== "changeset") return null;
		const isSnapshot = k === "snapshot";

		const rootDirDesc = descs.rootDir;
		if (rootDirDesc === undefined || !("value" in rootDirDesc)) return null;
		const rootDir = rootDirDesc.value;
		if (typeof rootDir !== "string" || rootDir.length < 1 || rootDir.length > MAX_DIRECTORY_PATH) return null;
		if (rootDir.charCodeAt(0) !== 0x2f) return null;

		const relativeNameDesc = descs.relativeName;
		if (relativeNameDesc === undefined || !("value" in relativeNameDesc)) return null;
		const relativeName = relativeNameDesc.value;
		if (typeof relativeName !== "string" || !RELATIVE_NAME_RE.test(relativeName)) return null;

		const snapshotIdDesc = descs.snapshotId;
		if (snapshotIdDesc === undefined || !("value" in snapshotIdDesc)) return null;
		const snapshotId = snapshotIdDesc.value;
		if (typeof snapshotId !== "string" || !HEX64_RE.test(snapshotId)) return null;

		if (isSnapshot) {
			if (names.length !== 4) return null;
			if (names.indexOf("baseSnapshotId") >= 0 || names.indexOf("changesetId") >= 0) return null;
			return {
				rootDir,
				relativeName,
				kind: "snapshot",
				snapshotId,
				baseSnapshotId: undefined,
				changesetId: undefined,
			};
		}

		if (names.length !== 6) return null;
		const baseSnapshotIdDesc = descs.baseSnapshotId;
		if (baseSnapshotIdDesc === undefined || !("value" in baseSnapshotIdDesc)) return null;
		const baseSnapshotId = baseSnapshotIdDesc.value;
		if (typeof baseSnapshotId !== "string" || !HEX64_RE.test(baseSnapshotId)) return null;

		const changesetIdDesc = descs.changesetId;
		if (changesetIdDesc === undefined || !("value" in changesetIdDesc)) return null;
		const changesetId = changesetIdDesc.value;
		if (typeof changesetId !== "string" || !HEX64_RE.test(changesetId)) return null;

		return {
			rootDir,
			relativeName,
			kind: "changeset",
			snapshotId,
			baseSnapshotId,
			changesetId,
		};
	} catch {
		return null;
	}
}

// ===========================================================================
// Handle bundle capture
// ===========================================================================

function captureBundle(handle: object): HandleBundle | null {
	try {
		if (types.isProxy(handle)) return null;
		const closeDesc = Object.getOwnPropertyDescriptor(handle, "close");
		if (closeDesc === undefined || !("value" in closeDesc)) return null;
		if (typeof closeDesc.value !== "function" || types.isProxy(closeDesc.value)) return null;
		const proto = Object.getPrototypeOf(handle);
		if (typeof proto !== "object" || proto === null) return null;
		const statOwn = Object.getOwnPropertyDescriptor(handle, "stat");
		if (statOwn !== undefined) return null;
		const readOwn = Object.getOwnPropertyDescriptor(handle, "read");
		if (readOwn !== undefined) return null;
		const statDesc = Object.getOwnPropertyDescriptor(proto, "stat");
		const readDesc = Object.getOwnPropertyDescriptor(proto, "read");
		if (statDesc === undefined || readDesc === undefined) return null;
		if (!("value" in statDesc) || !("value" in readDesc)) return null;
		if (typeof statDesc.value !== "function" || typeof readDesc.value !== "function") return null;
		if (types.isProxy(statDesc.value) || types.isProxy(readDesc.value)) return null;
		return Object.freeze({ close: closeDesc.value, stat: statDesc.value, read: readDesc.value });
	} catch {
		return null;
	}
}

// ===========================================================================
// Stat helpers
// ===========================================================================

function bigintProp(obj: object, key: string): bigint | null {
	try {
		const d = Object.getOwnPropertyDescriptor(obj, key);
		if (d === undefined || !("value" in d)) return null;
		return typeof d.value === "bigint" ? d.value : null;
	} catch {
		return null;
	}
}

function callBoolMethod(obj: object, key: string): boolean {
	try {
		let proto: object | null = obj;
		while (proto !== null) {
			const d: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(proto, key);
			if (d !== undefined) {
				if (d.get !== undefined || d.set !== undefined) return false;
				if (types.isProxy(d.value)) return false;
				if (typeof d.value !== "function") return false;
				return Boolean(Reflect.apply(d.value, obj, []));
			}
			proto = Object.getPrototypeOf(proto);
		}
		return false;
	} catch {
		return false;
	}
}

function snapDirId(st: object, expectedUid: string): DirIdentity | null {
	const dev = bigintProp(st, "dev");
	const ino = bigintProp(st, "ino");
	const uid = bigintProp(st, "uid");
	const mode = bigintProp(st, "mode");
	if (dev === null || ino === null || uid === null || mode === null) return null;
	if (String(uid) !== expectedUid) return null;
	const masked = mode & BigInt(0o7777);
	if (masked < 0n) return null;
	const modeNum = Number(masked);
	if (!Number.isSafeInteger(modeNum) || modeNum < 0 || modeNum > 0o7777) return null;
	if ((modeNum & DIRECTORY_MODE_MASK) !== DIRECTORY_MODE || (modeNum & SPECIAL_MODE_MASK) !== 0) return null;
	if (!callBoolMethod(st, "isDirectory")) return null;
	if (callBoolMethod(st, "isSymbolicLink")) return null;
	return Object.freeze({ dev: String(dev), ino: String(ino), uid: String(uid) });
}

function snapFileId(st: object, expectedUid: string): FileIdentity | null {
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
	if (String(uid) !== expectedUid) return null;
	const modeMasked = mode & BigInt(0o7777);
	const modeNum = Number(modeMasked);
	if (!Number.isSafeInteger(modeNum) || modeNum < 0 || modeNum > 0o7777) return null;
	if ((modeNum & FILE_MODE_MASK) !== FILE_MODE || (modeNum & SPECIAL_MODE_MASK) !== 0) return null;
	if (size < 0n) return null;
	const sizeNum = Number(size);
	if (!Number.isSafeInteger(sizeNum) || sizeNum < 1 || sizeNum > MAX_ARCHIVE_BYTES) return null;
	if (nlink < 0n) return null;
	const nlinkNum = Number(nlink);
	if (!Number.isSafeInteger(nlinkNum) || nlinkNum !== 1) return null;
	if (!callBoolMethod(st, "isFile")) return null;
	if (callBoolMethod(st, "isSymbolicLink")) return null;
	return Object.freeze({
		dev: String(dev),
		ino: String(ino),
		uid: String(uid),
		mode: modeNum,
		size: sizeNum,
		nlink: nlinkNum,
		mtimeNs: String(mtimeNs),
		ctimeNs: String(ctimeNs),
	});
}

function dirIdsEqual(left: DirIdentity, right: DirIdentity): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

function fileIdsEqual(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.nlink === right.nlink &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

// ===========================================================================
// Close / stat helpers (via observeExactPromiseCall)
// ===========================================================================

async function closeBundle(bundle: HandleBundle, handle: object): Promise<boolean> {
	try {
		const observed = await observeExactPromiseCall((): unknown => Reflect.apply(bundle.close, handle, []));
		return observed.fulfilled;
	} catch {
		return false;
	}
}

async function statBundle(bundle: HandleBundle, handle: object): Promise<object | null> {
	try {
		const observed = await observeExactPromiseCall((): unknown =>
			Reflect.apply(bundle.stat, handle, [{ bigint: true }]),
		);
		if (!observed.fulfilled) return null;
		const st = observed.value;
		if (!isObject(st) || bigintProp(st, "dev") === null) return null;
		return st;
	} catch {
		return null;
	}
}

// ===========================================================================
// Read chunk — with adversarial re-verification
// ===========================================================================

type ReadOutcome = Readonly<{ bytes: Uint8Array }> | Readonly<{ eof: true }>;

async function readChunk(
	bundle: HandleBundle,
	handle: object,
	position: number,
	length: number,
): Promise<ReadOutcome | null | undefined> {
	if (INTRINSICS === null) return null;
	const buf = allocateGenuineUint8Array(length);
	try {
		const observed = await observeExactPromiseCall((): unknown =>
			Reflect.apply(bundle.read, handle, [buf, 0, length, position]),
		);
		if (!observed.fulfilled) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		const resultValue = observed.value;
		// Reorder: check Proxy before Object.getPrototypeOf
		if (INTRINSICS.isProxy(resultValue)) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		if (!isObject(resultValue)) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		// Exact-validate FileHandle read result:
		// Must be ordinary object, reject Proxy/symbol/accessor/extras
		const resultProto = Object.getPrototypeOf(resultValue);
		if (resultProto !== Object.prototype && resultProto !== null) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		if (Object.getOwnPropertySymbols(resultValue).length !== 0) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		const ownKeys = Object.getOwnPropertyNames(resultValue);
		// Require exactly ["bytesRead", "buffer"] — two keys, no other
		if (ownKeys.length !== 2) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		if (ownKeys.indexOf("bytesRead") < 0 || ownKeys.indexOf("buffer") < 0) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		const descs = Object.getOwnPropertyDescriptors(resultValue);
		for (const k of ownKeys) {
			const d = descs[k];
			if (d === undefined || !("value" in d) || d.get !== undefined || d.set !== undefined || !d.enumerable) {
				if (!eraseVerified(buf)) return undefined;
				return null;
			}
		}
		const bytesReadDesc = descs.bytesRead;
		if (bytesReadDesc === undefined || !("value" in bytesReadDesc)) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		const bytesRead = bytesReadDesc.value;
		if (typeof bytesRead !== "number" || !Number.isSafeInteger(bytesRead)) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		if (bytesRead < 0 || bytesRead > length) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		// buffer field must be exactly our owned buffer
		const bufferDesc = descs.buffer;
		if (bufferDesc === undefined || !("value" in bufferDesc)) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		const bufferValue = bufferDesc.value;
		if (bufferValue !== buf) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		// Re-confirm genuine full backing via captured buffer/byteOffset/byteLength
		if (!isFullBackingGenuine(buf)) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		if (bytesRead === 0) {
			if (!eraseVerified(buf)) return undefined;
			const r: Readonly<{ eof: true }> = Object.freeze({ eof: true });
			return r;
		}
		if (bytesRead === length) {
			// Full read — return buffer as-is, caller will erase when done copying
			return Object.freeze({ bytes: buf });
		}
		// Partial read — use captured subarray + set for the copy
		const trimmed = allocateGenuineUint8Array(bytesRead);
		const copyOk = copyWithSubarraySet(trimmed, 0, buf, 0, bytesRead);
		if (!copyOk) {
			if (!eraseVerified(buf)) return undefined;
			return null;
		}
		if (!eraseVerified(buf)) return undefined;
		return Object.freeze({ bytes: trimmed });
	} catch {
		if (!eraseVerified(buf)) return undefined;
		return null;
	}
}

// ===========================================================================
// Uint64BE, SHA-256, identity verification
// ===========================================================================

function readUint64BE(bytes: Uint8Array, offset: number): number {
	if (INTRINSICS === null) return 0;
	try {
		const buf = Reflect.apply(INTRINSICS.taBufferGet, bytes, []);
		if (typeof buf !== "object" || buf === null || INTRINSICS.isProxy(buf)) return 0;
		const byteOff = Reflect.apply(INTRINSICS.taByteOffsetGet, bytes, []);
		if (typeof byteOff !== "number" || !Number.isSafeInteger(byteOff) || byteOff < 0) return 0;
		const bl = Reflect.apply(INTRINSICS.taByteLengthGet, bytes, []);
		if (typeof bl !== "number" || !Number.isSafeInteger(bl) || bl < 8) return 0;
		const abLen = Reflect.apply(INTRINSICS.abByteLengthGet, buf, []);
		if (typeof abLen !== "number" || !Number.isSafeInteger(abLen) || byteOff + bl > abLen) return 0;
		if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset + 8 > bl) return 0;
		const dv = Reflect.construct(INTRINSICS.dvConstruct, [buf, byteOff, bl]);
		const val = Reflect.apply(INTRINSICS.dvGetBigUint64, dv, [offset]);
		if (typeof val !== "bigint") return 0;
		if (val < 0n || val > 0xffffffffffffffffn) return 0;
		return Number(val);
	} catch {
		return 0;
	}
}

function hashesEqual(left: string, right: string): boolean {
	if (left.length !== right.length) return false;
	let diff = 0;
	for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
	return diff === 0;
}

function verifyExpectedIdentity(decodedIdentity: Readonly<PawsIdentity>, expected: ParsedInput): boolean {
	if (expected.kind === "snapshot") {
		const sidRaw = readProp(decodedIdentity, "snapshotId");
		const sid: string = isString(sidRaw) ? sidRaw : "";
		return hashesEqual(sid, expected.snapshotId);
	}
	const baseRaw = readProp(decodedIdentity, "baseSnapshotId");
	const snapRaw = readProp(decodedIdentity, "snapshotId");
	const chgRaw = readProp(decodedIdentity, "changesetId");
	const base: string = isString(baseRaw) ? baseRaw : "";
	const snap: string = isString(snapRaw) ? snapRaw : "";
	const chg: string = isString(chgRaw) ? chgRaw : "";
	if (expected.baseSnapshotId === undefined || !hashesEqual(base, expected.baseSnapshotId)) return false;
	if (!hashesEqual(snap, expected.snapshotId)) return false;
	if (expected.changesetId === undefined || !hashesEqual(chg, expected.changesetId)) return false;
	return true;
}

function successSnapshot(
	input: ParsedInput,
	totalBytes: number,
	entryCount: number,
	archiveBytes: number,
): PawsArchiveVerificationResult {
	return Object.freeze({
		ok: true,
		value: Object.freeze({
			kind: "snapshot",
			snapshotId: input.snapshotId,
			totalBytes,
			entryCount,
			archiveBytes,
		}),
	});
}

function successChangeset(
	input: ParsedInput,
	totalBytes: number,
	entryCount: number,
	archiveBytes: number,
): PawsArchiveVerificationResult {
	const baseSnapshotId: string = input.baseSnapshotId !== undefined ? input.baseSnapshotId : "";
	const changesetId: string = input.changesetId !== undefined ? input.changesetId : "";
	return Object.freeze({
		ok: true,
		value: Object.freeze({
			kind: "changeset",
			snapshotId: input.snapshotId,
			baseSnapshotId,
			changesetId,
			totalBytes,
			entryCount,
			archiveBytes,
		}),
	});
}

// ===========================================================================
// Verification core
// ===========================================================================

async function verifyOwned(
	bundle: HandleBundle,
	handle: object,
	id: FileIdentity,
	input: ParsedInput,
): Promise<PawsArchiveVerificationResult> {
	if (INTRINSICS === null) return failure("READ_FAILED");
	try {
		const headerBuf = allocateGenuineUint8Array(HEADER_PREFIX);
		const headerOutcome = await readChunk(bundle, handle, 0, HEADER_PREFIX);
		if (headerOutcome === undefined) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("ERASURE_CONFIRM_FAILED");
		}
		if (!headerOutcome) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("READ_FAILED");
		}
		if (!("bytes" in headerOutcome)) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("UNEXPECTED_EOF");
		}
		// Copy header bytes via captured subarray+set
		{
			const bl = safeByteLength(headerOutcome.bytes);
			if (bl === 0 || bl > HEADER_PREFIX) {
				if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("READ_FAILED");
			}
			if (!copyWithSubarraySet(headerBuf, 0, headerOutcome.bytes, 0, bl)) {
				if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("READ_FAILED");
			}
		}
		if (!eraseVerified(headerOutcome.bytes)) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("ERASURE_CONFIRM_FAILED");
		}

		// Use DataView-based safe byte reading — no live index access
		let headerByte0: number;
		let headerByte1: number;
		let headerByte2: number;
		let headerByte3: number;
		let headerByte4: number;
		try {
			const buf = Reflect.apply(INTRINSICS.taBufferGet, headerBuf, []);
			if (typeof buf !== "object" || buf === null || INTRINSICS.isProxy(buf)) {
				if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("READ_FAILED");
			}
			const byteOff = Reflect.apply(INTRINSICS.taByteOffsetGet, headerBuf, []);
			if (typeof byteOff !== "number" || !Number.isSafeInteger(byteOff) || byteOff < 0) {
				if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("READ_FAILED");
			}
			const dv = Reflect.construct(INTRINSICS.dvConstruct, [buf, byteOff, HEADER_PREFIX]);
			headerByte0 = Reflect.apply(INTRINSICS.dvGetUint8, dv, [0]);
			headerByte1 = Reflect.apply(INTRINSICS.dvGetUint8, dv, [1]);
			headerByte2 = Reflect.apply(INTRINSICS.dvGetUint8, dv, [2]);
			headerByte3 = Reflect.apply(INTRINSICS.dvGetUint8, dv, [3]);
			headerByte4 = Reflect.apply(INTRINSICS.dvGetUint8, dv, [4]);
		} catch {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("READ_FAILED");
		}
		if (
			headerByte0 !== 0x50 ||
			headerByte1 !== 0x41 ||
			headerByte2 !== 0x57 ||
			headerByte3 !== 0x53 ||
			headerByte4 !== 0x31
		) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("MANIFEST_INVALID");
		}

		const manifestLen = readUint64BE(headerBuf, 5);
		if (manifestLen > MAX_MANIFEST_BYTES || manifestLen < 1) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("MANIFEST_INVALID");
		}

		const headerSize = HEADER_PREFIX + manifestLen;
		if (headerSize > id.size) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("MANIFEST_INVALID");
		}

		const manifestFull = allocateGenuineUint8Array(headerSize);
		if (!copyWithSubarraySet(manifestFull, 0, headerBuf, 0, HEADER_PREFIX)) {
			if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("READ_FAILED");
		}
		if (!eraseVerified(headerBuf)) return failure("ERASURE_CONFIRM_FAILED");

		let manifestOffset = HEADER_PREFIX;
		while (manifestOffset < headerSize) {
			const chunkLen = Math.min(MAX_READ_BYTES, headerSize - manifestOffset);
			const chunk = await readChunk(bundle, handle, manifestOffset, chunkLen);
			if (chunk === undefined) {
				if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("ERASURE_CONFIRM_FAILED");
			}
			if (!chunk) {
				if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("READ_FAILED");
			}
			if (!("bytes" in chunk)) {
				if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("UNEXPECTED_EOF");
			}
			{
				const bl = safeByteLength(chunk.bytes);
				if (bl === 0 || manifestOffset + bl > headerSize) {
					if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
					return failure("READ_FAILED");
				}
				if (!copyWithSubarraySet(manifestFull, manifestOffset, chunk.bytes, 0, bl)) {
					if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
					return failure("READ_FAILED");
				}
			}
			if (!eraseVerified(chunk.bytes)) {
				if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
				return failure("ERASURE_CONFIRM_FAILED");
			}
			manifestOffset += safeByteLength(chunk.bytes);
		}

		const decoded = decodePawsManifestBytes(manifestFull);
		if (!eraseVerified(manifestFull)) return failure("ERASURE_CONFIRM_FAILED");
		if (!decoded.ok) return failure("MANIFEST_INVALID");

		const { manifest, identity: pawsIdentity, payloadSize } = decoded.value;
		if (headerSize + payloadSize > MAX_ARCHIVE_BYTES) return failure("ARCHIVE_TOO_LARGE");
		const expectedTotalSize = headerSize + payloadSize;
		if (expectedTotalSize !== id.size) return failure("ARCHIVE_SIZE_MISMATCH");
		if (!verifyExpectedIdentity(pawsIdentity, input)) return failure("IDENTITY_INVALID");

		let entryCount = 0;
		for (const entry of manifest.entries) {
			if (isObject(entry) && readProp(entry, "operation") === "delete") continue;
			const rawSize = readProp(entry, "size");
			const rawSha256 = readProp(entry, "sha256");
			const rawOffset = readProp(entry, "offset");
			if (typeof rawSize !== "number" || !Number.isSafeInteger(rawSize) || rawSize < 0)
				return failure("MANIFEST_INVALID");
			if (!isString(rawSha256) || !hex64(rawSha256)) return failure("MANIFEST_INVALID");
			if (typeof rawOffset !== "number" || !Number.isSafeInteger(rawOffset) || rawOffset < 0)
				return failure("MANIFEST_INVALID");

			if (rawSize === 0) {
				entryCount += 1;
				continue;
			}

			const hash = createHash("sha256");
			let remaining = rawSize;
			const readPos = headerSize + rawOffset;
			let posOffset = 0;

			while (remaining > 0) {
				const chunkLen = Math.min(MAX_READ_BYTES, remaining);
				const chunk = await readChunk(bundle, handle, readPos + posOffset, chunkLen);
				if (chunk === undefined) return failure("ERASURE_CONFIRM_FAILED");
				if (!chunk) return failure("READ_FAILED");
				if (!("bytes" in chunk)) return failure("UNEXPECTED_EOF");
				const actualLen = safeByteLength(chunk.bytes);
				if (actualLen < 1 || actualLen > chunkLen) {
					if (!eraseVerified(chunk.bytes)) return failure("ERASURE_CONFIRM_FAILED");
					return failure("READ_FAILED");
				}
				// Require progress — partial read must advance by actual captured length
				hash.update(chunk.bytes);
				if (!eraseVerified(chunk.bytes)) return failure("ERASURE_CONFIRM_FAILED");
				posOffset += actualLen;
				remaining -= actualLen;
			}
			if (!hashesEqual(hash.digest("hex"), rawSha256)) return failure("FILE_HASH_MISMATCH");
			entryCount += 1;
		}

		const eofCheck = await readChunk(bundle, handle, expectedTotalSize, MAX_READ_BYTES);
		if (eofCheck === undefined) return failure("ERASURE_CONFIRM_FAILED");
		if (eofCheck !== null && "bytes" in eofCheck) {
			if (!eraseVerified(eofCheck.bytes)) return failure("ERASURE_CONFIRM_FAILED");
			return failure("TRAILING_BYTES");
		}

		const finalStat = await statBundle(bundle, handle);
		if (!finalStat) return failure("IDENTITY_CHANGED");
		const finalId = snapFileId(finalStat, id.uid);
		if (!finalId || !fileIdsEqual(id, finalId)) return failure("IDENTITY_CHANGED");

		if (input.kind === "changeset") {
			return successChangeset(input, payloadSize, entryCount, expectedTotalSize);
		}
		return successSnapshot(input, payloadSize, entryCount, expectedTotalSize);
	} catch {
		return failure("READ_FAILED");
	}
}

// ===========================================================================
// Close helpers
// ===========================================================================

interface SingleOwner {
	readonly bundle: HandleBundle;
	readonly handle: object;
}
interface PairOwners {
	readonly root: SingleOwner;
	readonly archive: SingleOwner;
}

async function closeSingleOwner(owner: SingleOwner): Promise<boolean> {
	return await closeBundle(owner.bundle, owner.handle);
}

async function tryCloseHandleDirect(handle: object): Promise<boolean> {
	try {
		const closeDesc = Object.getOwnPropertyDescriptor(handle, "close");
		if (closeDesc === undefined || !("value" in closeDesc)) return false;
		if (typeof closeDesc.value !== "function" || types.isProxy(closeDesc.value)) return false;
		const observed = await observeExactPromiseCall((): unknown => Reflect.apply(closeDesc.value, handle, []));
		return observed.fulfilled;
	} catch {
		return false;
	}
}

async function finishRootOnly(
	owner: SingleOwner,
	t: PawsArchiveVerificationResult,
): Promise<PawsArchiveVerificationResult> {
	const ok = await closeSingleOwner(owner);
	if (!ok) return failure("CLOSE_UNCONFIRMED");
	return t;
}

async function finishBoth(pair: PairOwners, t: PawsArchiveVerificationResult): Promise<PawsArchiveVerificationResult> {
	const archiveOk = await closeSingleOwner(pair.archive);
	const rootOk = await closeSingleOwner(pair.root);
	if (!archiveOk || !rootOk) return failure("CLOSE_UNCONFIRMED");
	return t;
}

async function handleRootCaptureFailure(rootHandle: object): Promise<PawsArchiveVerificationResult> {
	const closeOk = await tryCloseHandleDirect(rootHandle);
	if (!closeOk) return failure("CLOSE_UNCONFIRMED");
	return failure("CLOSE_UNCONFIRMED");
}

async function handleArchiveCaptureFailure(
	archiveHandle: object,
	rootOwner: SingleOwner,
): Promise<PawsArchiveVerificationResult> {
	const archiveOk = await tryCloseHandleDirect(archiveHandle);
	const rootOk = await closeSingleOwner(rootOwner);
	if (!archiveOk || !rootOk) return failure("CLOSE_UNCONFIRMED");
	return failure("CLOSE_UNCONFIRMED");
}

// ===========================================================================
// Public API
// ===========================================================================

export function createVerifier(ioRaw?: unknown): (rawInput: unknown) => Promise<PawsArchiveVerificationResult> {
	// Factory fails fixed if intrinsics unavailable
	if (INTRINSICS === null) {
		return async (): Promise<PawsArchiveVerificationResult> => failure("PARENT_INVALID");
	}
	const activeIo: InnerIO | null = ioRaw !== undefined ? captureIORaw(ioRaw) : DEFAULT_IO;
	if (activeIo === null || !isBrandedIO(activeIo)) {
		return async (): Promise<PawsArchiveVerificationResult> => failure("PARENT_INVALID");
	}

	return async function verifyPawsArchive(rawInput: unknown): Promise<PawsArchiveVerificationResult> {
		const input = snapshotInput(rawInput);
		if (!input) return failure("INPUT_INVALID");

		let getuidRaw: unknown;
		try {
			getuidRaw = activeIo.getuid();
		} catch {
			return failure("IDENTITY_INVALID");
		}
		const uidNum: number | undefined =
			typeof getuidRaw === "number" && Number.isSafeInteger(getuidRaw) ? getuidRaw : undefined;
		if (uidNum === undefined) return failure("IDENTITY_INVALID");
		const uidStr = String(uidNum);

		let resolvedRoot: string;
		{
			const rootObserved = await observeExactPromiseCall(() => activeIo.realpath(input.rootDir));
			if (!rootObserved.fulfilled) return failure("PARENT_INVALID");
			resolvedRoot = typeof rootObserved.value === "string" ? rootObserved.value : "";
			if (resolvedRoot !== input.rootDir) return failure("PARENT_INVALID");
		}

		let rootHandle: object;
		{
			const openObserved = await observeExactPromiseCall(() =>
				activeIo.open(input.rootDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW),
			);
			if (!openObserved.fulfilled) return failure("PARENT_INVALID");
			if (typeof openObserved.value !== "object" || openObserved.value === null) return failure("PARENT_INVALID");
			rootHandle = openObserved.value;
		}

		const rootBundle = captureBundle(rootHandle);
		if (!rootBundle) {
			return await handleRootCaptureFailure(rootHandle);
		}

		const rootOwner: SingleOwner = Object.freeze({ bundle: rootBundle, handle: rootHandle });

		const rootStat = await statBundle(rootBundle, rootHandle);
		if (!rootStat) return await finishRootOnly(rootOwner, failure("PARENT_INVALID"));
		const rootDirId = snapDirId(rootStat, uidStr);
		if (!rootDirId) return await finishRootOnly(rootOwner, failure("PARENT_INVALID"));

		const archivePath = join(input.rootDir, input.relativeName);
		let resolvedArchive: string;
		{
			const archObserved = await observeExactPromiseCall(() => activeIo.realpath(archivePath));
			if (!archObserved.fulfilled) return await finishRootOnly(rootOwner, failure("IDENTITY_INVALID"));
			resolvedArchive = typeof archObserved.value === "string" ? archObserved.value : "";
			if (resolvedArchive !== archivePath) return await finishRootOnly(rootOwner, failure("IDENTITY_INVALID"));
		}

		let archiveHandle: object;
		{
			const openObserved = await observeExactPromiseCall(() =>
				activeIo.open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW),
			);
			if (!openObserved.fulfilled) return await finishRootOnly(rootOwner, failure("IDENTITY_INVALID"));
			if (typeof openObserved.value !== "object" || openObserved.value === null)
				return await finishRootOnly(rootOwner, failure("IDENTITY_INVALID"));
			archiveHandle = openObserved.value;
		}

		const archiveBundle = captureBundle(archiveHandle);
		if (!archiveBundle) {
			return await handleArchiveCaptureFailure(archiveHandle, rootOwner);
		}

		const pair: PairOwners = Object.freeze({
			root: rootOwner,
			archive: Object.freeze({ bundle: archiveBundle, handle: archiveHandle }),
		});

		const fileStat = await statBundle(archiveBundle, archiveHandle);
		if (!fileStat) return await finishBoth(pair, failure("IDENTITY_INVALID"));
		const fileId = snapFileId(fileStat, uidStr);
		if (!fileId) return await finishBoth(pair, failure("IDENTITY_INVALID"));

		const recheckStat = await statBundle(rootBundle, rootHandle);
		if (!recheckStat) return await finishBoth(pair, failure("PARENT_INVALID"));
		const recheckId = snapDirId(recheckStat, uidStr);
		if (!recheckId || !dirIdsEqual(recheckId, rootDirId)) return await finishBoth(pair, failure("PARENT_INVALID"));

		const result = await verifyOwned(archiveBundle, archiveHandle, fileId, input);

		return await finishBoth(pair, result);
	};
}

export const verifyPawsArchive: (rawInput: unknown) => Promise<PawsArchiveVerificationResult> = (() => {
	if (INTRINSICS === null) {
		return async (): Promise<PawsArchiveVerificationResult> => failure("PARENT_INVALID");
	}
	if (DEFAULT_IO === null) {
		return async (): Promise<PawsArchiveVerificationResult> => failure("PARENT_INVALID");
	}
	return createVerifier(DEFAULT_IO);
})();
