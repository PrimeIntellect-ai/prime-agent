import { createHash } from "node:crypto";
import { types } from "node:util";

const CHUNK_BYTES = 64 * 1024;
const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_PATH_BYTES = 4096;
const OPERATION_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const HEX64 = /^[0-9a-f]{64}$/;
const NODE_VERSION = /^22\.8\.(0|[1-9][0-9]{0,8})$/;
const PYTHON_VERSION = /^3\.11\.(0|[1-9][0-9]{0,8})$/;
const BUILD_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const INPUT_KEYS = new Set(["bundle", "node", "python", "runtime", "target"]);
const SOURCE_KEYS = new Set(["manifest", "tree"]);
const MANIFEST_KEYS = new Set(["buildSha256", "files", "kind", "target", "treeSha256", "version"]);
const FILE_KEYS = new Set(["mode", "path", "sha256", "size"]);
const TREE_KEYS = new Set(["close", "list", "open"]);
const LIST_RESULT_KEYS = new Set(["entries", "status"]);
const LIST_ENTRY_KEYS = new Set(["mode", "path"]);
const OPEN_RESULT_KEYS = new Set(["reader", "status"]);
const READER_KEYS = new Set(["close", "read", "stat"]);
const READ_BYTES_KEYS = new Set(["bytes", "status"]);
const READ_EOF_KEYS = new Set(["status"]);
const READ_REQUEST_KEYS = new Set(["maximum", "offset"]);
const OPEN_REQUEST_KEYS = new Set(["pass", "path"]);
const STAT_KEYS = new Set(["ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "nlink", "size", "uid"]);
const STATUS_KEYS = new Set(["status"]);
const REGULAR_MODE = 0o100000n;
const TYPE_MASK = 0o170000n;
const SPECIAL_MODE = 0o7000n;
const ELF_MAGIC = Object.freeze([0x7f, 0x45, 0x4c, 0x46]);
const EM_X86_64 = 0x3e;
const EM_AARCH64 = 0xb7;
const PT_INTERP = 3;

export type OfflineRuntimeTarget = "linux-x64" | "linux-arm64";
export type OfflineRuntimeSourceKind = "bundle" | "node" | "python" | "runtime";
export type OfflineRuntimeFailureCode =
	| "CLOSE_UNCONFIRMED"
	| "INPUT_INVALID"
	| "MANIFEST_INVALID"
	| "SOURCE_ALIASED"
	| "SOURCE_CLOSE_UNCONFIRMED"
	| "SOURCE_LIST_FAILED"
	| "SOURCE_LIST_INVALID"
	| "TARGET_LAYOUT_INVALID";

export interface OfflineRuntimeManifestFile {
	readonly path: string;
	readonly mode: 0o644 | 0o755;
	readonly size: number;
	readonly sha256: string;
}

export interface OfflineRuntimeManifest {
	readonly kind: OfflineRuntimeSourceKind;
	readonly target: OfflineRuntimeTarget | "any";
	readonly version: string;
	readonly buildSha256: string;
	readonly treeSha256: string;
	readonly files: readonly OfflineRuntimeManifestFile[];
}

export type OfflineRuntimeTreeCapability = Readonly<{
	list: () => Promise<unknown>;
	open: (raw: unknown) => Promise<unknown>;
	close: () => Promise<unknown>;
}>;

export type ComposeOfflineRuntimeResult =
	| Readonly<{ ok: true; tree: OfflineRuntimeTreeCapability }>
	| Readonly<{ ok: false; error: Readonly<{ code: OfflineRuntimeFailureCode }> }>;

export type OfflineRuntimeManifestDigestResult =
	| Readonly<{ ok: true; value: string }>
	| Readonly<{ ok: false; error: Readonly<{ code: "MANIFEST_INVALID" }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;
type Identity = Readonly<{
	dev: bigint;
	ino: bigint;
	uid: bigint;
	gid: bigint;
	mode: bigint;
	nlink: bigint;
	size: bigint;
	mtimeNs: bigint;
	ctimeNs: bigint;
}>;
type ManifestSnapshot = Readonly<{
	kind: OfflineRuntimeSourceKind;
	target: OfflineRuntimeTarget | "any";
	version: string;
	buildSha256: string;
	treeSha256: string;
	files: readonly OfflineRuntimeManifestFile[];
}>;
type OwnedClose = () => Promise<boolean>;
type OwnedTree = Readonly<{
	identity: object;
	list: BoundMethod;
	open: BoundMethod;
	close: OwnedClose;
	usable: boolean;
}>;
type SourceSnapshot = Readonly<{ manifest: ManifestSnapshot; tree: OwnedTree }>;
type Mapping = Readonly<{
	targetPath: string;
	sourcePath: string;
	source: SourceSnapshot;
	mode: 0o644 | 0o755;
	size: number;
	sha256: string;
}>;

type ReaderCapability = Readonly<{
	identity: object;
	stat: BoundMethod;
	read: BoundMethod;
	close: OwnedClose;
	usable: boolean;
}>;

function failure(code: OfflineRuntimeFailureCode): ComposeOfflineRuntimeResult {
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
	const found = descriptors(raw);
	if (!found) return null;
	const names = Object.getOwnPropertyNames(found);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = found[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return found;
}

function bind(raw: object, descriptor: PropertyDescriptor): BoundMethod | null {
	if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
	try {
		if (types.isProxy(descriptor.value)) return null;
		const callable = descriptor.value as CallableFunction;
		return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
	} catch {
		return null;
	}
}

function ownData(raw: unknown, key: string): unknown {
	const found = descriptors(raw);
	const descriptor = found?.[key];
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			types.isPromise(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observe(raw: unknown, timeoutMs: number, late?: (value: unknown) => void): Promise<Observed> {
	if (!isNativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					if (settled) {
						late?.(value);
						return;
					}
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value }));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "rejected" as const }));
				},
			]);
		} catch {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function invoke(call: () => unknown, timeoutMs: number, late?: (value: unknown) => void): Promise<Observed> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
	return observe(raw, timeoutMs, late);
}

function statusIs(raw: unknown, status: string): boolean {
	return exact(raw, STATUS_KEYS)?.status?.value === status;
}

function ownedClose(method: BoundMethod): OwnedClose {
	let invoked = false;
	let shared: Promise<boolean> | null = null;
	return (): Promise<boolean> => {
		if (shared) return shared;
		if (invoked) return Promise.resolve(false);
		invoked = true;
		shared = invoke(() => method(), CLOSE_TIMEOUT_MS).then(
			(result) => result.status === "fulfilled" && statusIs(result.value, "closed"),
			() => false,
		);
		return shared;
	};
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

function exactBytes(raw: unknown): raw is Uint8Array {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			Object.getOwnPropertyDescriptor(raw, "buffer") !== undefined ||
			Object.getOwnPropertyDescriptor(raw, "byteLength") !== undefined ||
			Object.getOwnPropertyDescriptor(raw, "byteOffset") !== undefined ||
			!BYTE_LENGTH_GETTER ||
			!BYTE_OFFSET_GETTER ||
			!BUFFER_GETTER ||
			!ARRAY_BUFFER_LENGTH_GETTER
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
		ArrayBuffer.prototype.slice.call(buffer, 0, 0);
		return byteOffset === 0 && byteLength === backingLength;
	} catch {
		return false;
	}
}

function erase(bytes: Uint8Array | null): void {
	if (!bytes) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		/* owned bytes may be detached */
	}
}

function exactArray(raw: unknown, maximum: number, allowEmpty: boolean): readonly unknown[] | null {
	if (!Array.isArray(raw)) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Array.prototype ||
			!Object.isFrozen(raw) ||
			Object.getOwnPropertySymbols(raw).length !== 0 ||
			raw.length > maximum ||
			(!allowEmpty && raw.length === 0)
		)
			return null;
		const found = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(found);
		if (names.length !== raw.length + 1 || names[names.length - 1] !== "length") return null;
		const values: unknown[] = [];
		for (let index = 0; index < raw.length; index += 1) {
			const descriptor = found[String(index)];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
			values.push(descriptor.value);
		}
		return Object.freeze(values);
	} catch {
		return null;
	}
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
	const length = Math.min(left.byteLength, right.byteLength);
	for (let index = 0; index < length; index += 1) {
		const difference = left[index]! - right[index]!;
		if (difference !== 0) return difference;
	}
	return left.byteLength - right.byteLength;
}

function compareUtf8(left: string, right: string): number {
	return compareBytes(new TextEncoder().encode(left), new TextEncoder().encode(right));
}

function canonicalPath(raw: unknown): string | null {
	if (
		typeof raw !== "string" ||
		raw.length === 0 ||
		raw.normalize("NFC") !== raw ||
		raw.includes("\\") ||
		raw.includes("\0")
	)
		return null;
	const segments = raw.split("/");
	if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) return null;
	try {
		const encoded = new TextEncoder().encode(raw);
		if (encoded.byteLength > MAX_PATH_BYTES || new TextDecoder("utf-8", { fatal: true }).decode(encoded) !== raw)
			return null;
		return raw;
	} catch {
		return null;
	}
}

function snapshotManifest(raw: unknown, expectedKind: OfflineRuntimeSourceKind): ManifestSnapshot | null {
	const found = exact(raw, MANIFEST_KEYS);
	if (!found || !Object.isFrozen(raw)) return null;
	const kind = found.kind?.value;
	const target = found.target?.value;
	const version = found.version?.value;
	const buildSha256 = found.buildSha256?.value;
	const treeSha256 = found.treeSha256?.value;
	if (
		kind !== expectedKind ||
		(target !== "linux-x64" && target !== "linux-arm64" && target !== "any") ||
		typeof version !== "string" ||
		typeof buildSha256 !== "string" ||
		!HEX64.test(buildSha256) ||
		typeof treeSha256 !== "string" ||
		!HEX64.test(treeSha256)
	)
		return null;
	if (
		(kind === "node" && !NODE_VERSION.test(version)) ||
		(kind === "python" && !PYTHON_VERSION.test(version)) ||
		((kind === "bundle" || kind === "runtime") && !BUILD_ID.test(version))
	)
		return null;
	const values = exactArray(found.files?.value, MAX_FILES, false);
	if (!values) return null;
	const files: OfflineRuntimeManifestFile[] = [];
	let previous: Uint8Array | null = null;
	let total = 0;
	for (const value of values) {
		const entry = exact(value, FILE_KEYS);
		if (!entry || !Object.isFrozen(value)) return null;
		const path = canonicalPath(entry.path?.value);
		const mode = entry.mode?.value;
		const size = entry.size?.value;
		const sha256 = entry.sha256?.value;
		if (
			!path ||
			(mode !== 0o644 && mode !== 0o755) ||
			typeof size !== "number" ||
			!Number.isSafeInteger(size) ||
			size < 0 ||
			size > MAX_FILE_BYTES ||
			typeof sha256 !== "string" ||
			!HEX64.test(sha256)
		)
			return null;
		const encoded = new TextEncoder().encode(path);
		if (previous && compareBytes(previous, encoded) >= 0) return null;
		previous = encoded;
		total += size;
		if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES) return null;
		files.push(Object.freeze({ path, mode, size, sha256 }));
	}
	return Object.freeze({ kind, target, version, buildSha256, treeSha256, files: Object.freeze(files) });
}

function manifestDigest(manifest: Omit<ManifestSnapshot, "treeSha256">): string {
	const canonical = Object.freeze({
		kind: manifest.kind,
		target: manifest.target,
		version: manifest.version,
		buildSha256: manifest.buildSha256,
		files: manifest.files.map((file) =>
			Object.freeze({ path: file.path, mode: file.mode, size: file.size, sha256: file.sha256 }),
		),
	});
	return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function computeOfflineRuntimeManifestDigest(raw: unknown): OfflineRuntimeManifestDigestResult {
	const found = exact(raw, new Set(["buildSha256", "files", "kind", "target", "version"]));
	if (!found || !Object.isFrozen(raw))
		return Object.freeze({ ok: false, error: Object.freeze({ code: "MANIFEST_INVALID" as const }) });
	const candidate = Object.freeze({ ...(raw as object), treeSha256: "0".repeat(64) });
	const kind = found.kind?.value;
	if (kind !== "bundle" && kind !== "node" && kind !== "python" && kind !== "runtime") {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "MANIFEST_INVALID" as const }) });
	}
	const snapshot = snapshotManifest(candidate, kind);
	if (!snapshot) return Object.freeze({ ok: false, error: Object.freeze({ code: "MANIFEST_INVALID" as const }) });
	return Object.freeze({ ok: true as const, value: manifestDigest(snapshot) });
}

function snapshotIdentity(raw: unknown): Identity | null {
	const found = exact(raw, STAT_KEYS);
	if (!found) return null;
	const values: Record<string, bigint> = {};
	for (const key of STAT_KEYS) {
		const value = found[key]?.value;
		if (typeof value !== "bigint" || value < 0n) return null;
		values[key] = value;
	}
	if (
		(values.mode & TYPE_MASK) !== REGULAR_MODE ||
		(values.mode & SPECIAL_MODE) !== 0n ||
		values.nlink !== 1n ||
		values.size > BigInt(MAX_FILE_BYTES)
	)
		return null;
	return Object.freeze({
		dev: values.dev!,
		ino: values.ino!,
		uid: values.uid!,
		gid: values.gid!,
		mode: values.mode!,
		nlink: values.nlink!,
		size: values.size!,
		mtimeNs: values.mtimeNs!,
		ctimeNs: values.ctimeNs!,
	});
}

function sameIdentity(left: Identity, right: Identity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.gid === right.gid &&
		left.mode === right.mode &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function acquireTree(raw: unknown): OwnedTree | null {
	if (typeof raw !== "object" || raw === null) return null;
	const preliminary = descriptors(raw);
	const closeDescriptor = preliminary?.close;
	const closeMethod = closeDescriptor ? bind(raw, closeDescriptor) : null;
	if (!closeMethod) return null;
	const close = ownedClose(closeMethod);
	const found = exact(raw, TREE_KEYS);
	const list = found ? bind(raw, found.list!) : null;
	const open = found ? bind(raw, found.open!) : null;
	if (!list || !open)
		return Object.freeze({ identity: raw, list: () => undefined, open: () => undefined, close, usable: false });
	return Object.freeze({ identity: raw, list, open, close, usable: true });
}

function snapshotListing(raw: unknown): readonly Readonly<{ path: string; mode: 0o644 | 0o755 }>[] | null {
	const found = exact(raw, LIST_RESULT_KEYS);
	if (!found || found.status?.value !== "listed") return null;
	const values = exactArray(found.entries?.value, MAX_FILES, false);
	if (!values) return null;
	const entries: Readonly<{ path: string; mode: 0o644 | 0o755 }>[] = [];
	for (const value of values) {
		const entry = exact(value, LIST_ENTRY_KEYS);
		const path = canonicalPath(entry?.path?.value);
		const mode = entry?.mode?.value;
		if (!path || (mode !== 0o644 && mode !== 0o755)) return null;
		entries.push(Object.freeze({ path, mode }));
	}
	return Object.freeze(entries);
}

function mapPath(kind: OfflineRuntimeSourceKind, path: string): string {
	if (kind === "node") return `node/${path}`;
	if (kind === "python") return `python/${path}`;
	if (kind === "bundle") return `prime-agent/${path}`;
	return `python/site-packages/${path}`;
}

function isElf(prefix: Uint8Array, length: number): boolean {
	return length >= 4 && ELF_MAGIC.every((value, index) => prefix[index] === value);
}

function readU16(prefix: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 2 > prefix.byteLength) return null;
	return prefix[offset]! + prefix[offset + 1]! * 0x100;
}

function readU32(prefix: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 4 > prefix.byteLength) return null;
	return (
		prefix[offset]! + prefix[offset + 1]! * 0x100 + prefix[offset + 2]! * 0x10000 + prefix[offset + 3]! * 0x1000000
	);
}

function readU64(prefix: Uint8Array, offset: number): number | null {
	if (offset < 0 || offset + 8 > prefix.byteLength) return null;
	let value = 0n;
	for (let index = 7; index >= 0; index -= 1) value = value * 256n + BigInt(prefix[offset + index]!);
	return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
}

function validateElf(
	prefix: Uint8Array,
	prefixLength: number,
	target: OfflineRuntimeTarget | "any",
	requiredExecutable: boolean,
): boolean {
	const elf = isElf(prefix, prefixLength);
	if (target === "any") return !elf;
	if (!elf) return !requiredExecutable;
	if (
		prefixLength < 64 ||
		prefix[4] !== 2 ||
		prefix[5] !== 1 ||
		prefix[6] !== 1 ||
		readU32(prefix, 20) !== 1 ||
		readU16(prefix, 52) !== 64
	)
		return false;
	const machine = readU16(prefix, 18);
	if (machine !== (target === "linux-x64" ? EM_X86_64 : EM_AARCH64)) return false;
	if (!requiredExecutable) return true;
	const programOffset = readU64(prefix, 32);
	const entrySize = readU16(prefix, 54);
	const entryCount = readU16(prefix, 56);
	if (programOffset === null || entrySize === null || entryCount === null || entrySize !== 56 || entryCount < 1)
		return false;
	const tableEnd = programOffset + entrySize * entryCount;
	if (!Number.isSafeInteger(tableEnd) || programOffset < 64 || tableEnd > prefixLength) return false;
	let interpreter: string | null = null;
	for (let index = 0; index < entryCount; index += 1) {
		const base = programOffset + index * entrySize;
		if (readU32(prefix, base) !== PT_INTERP) continue;
		if (interpreter !== null) return false;
		const offset = readU64(prefix, base + 8);
		const size = readU64(prefix, base + 32);
		const end = offset === null || size === null ? null : offset + size;
		if (
			offset === null ||
			size === null ||
			end === null ||
			!Number.isSafeInteger(end) ||
			size < 2 ||
			end > prefixLength
		)
			return false;
		const bytes = prefix.subarray(offset, offset + size);
		if (bytes[bytes.byteLength - 1] !== 0 || bytes.subarray(0, -1).includes(0)) return false;
		try {
			interpreter = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1));
		} catch {
			return false;
		}
	}
	const expected = target === "linux-x64" ? "/lib64/ld-linux-x86-64.so.2" : "/lib/ld-linux-aarch64.so.1";
	return interpreter === expected;
}

function closeReaderFrom(raw: unknown, identities: Set<object>, cleanup: Set<Promise<boolean>>): void {
	const reader = ownData(raw, "reader");
	if (typeof reader !== "object" || reader === null || identities.has(reader)) return;
	identities.add(reader);
	const preliminary = descriptors(reader);
	const closeDescriptor = preliminary?.close;
	const method = closeDescriptor ? bind(reader, closeDescriptor) : null;
	if (!method) return;
	const task = ownedClose(method)();
	cleanup.add(task);
	void task.finally(() => cleanup.delete(task));
}

function discoverReader(raw: unknown, identities: Set<object>): ReaderCapability | null {
	if (typeof raw !== "object" || raw === null || identities.has(raw)) return null;
	identities.add(raw);
	const preliminary = descriptors(raw);
	const closeDescriptor = preliminary?.close;
	const closeMethod = closeDescriptor ? bind(raw, closeDescriptor) : null;
	if (!closeMethod) return null;
	const close = ownedClose(closeMethod);
	const found = exact(raw, READER_KEYS);
	const stat = found ? bind(raw, found.stat!) : null;
	const read = found ? bind(raw, found.read!) : null;
	if (!stat || !read)
		return Object.freeze({ identity: raw, stat: () => undefined, read: () => undefined, close, usable: false });
	return Object.freeze({ identity: raw, stat, read, close, usable: true });
}

function cloneIdentity(identity: Identity): Identity {
	return Object.freeze({ ...identity });
}

function createReader(
	source: ReaderCapability,
	mapping: Mapping,
	pass: 1 | 2,
	identities: Map<string, Identity>,
	onComplete: (valid: boolean) => void,
	markUncertain: () => void,
): Readonly<{ stat: () => Promise<unknown>; read: (raw: unknown) => Promise<unknown>; close: () => Promise<unknown> }> {
	let closed: Promise<unknown> | null = null;
	let invalid = false;
	let offset = 0;
	let eof = false;
	let statCalls = 0;
	let observedIdentity: Identity | null = null;
	const hasher = createHash("sha256");
	const prefix = new Uint8Array(Math.min(CHUNK_BYTES, mapping.size));
	let prefixLength = 0;

	const stat = (): Promise<unknown> =>
		invoke(() => source.stat(), OPERATION_TIMEOUT_MS).then((observed) => {
			if (observed.status !== "fulfilled") {
				invalid = true;
				return Object.freeze({});
			}
			const identity = snapshotIdentity(observed.value);
			if (!identity || identity.size !== BigInt(mapping.size) || Number(identity.mode & 0o777n) !== mapping.mode) {
				invalid = true;
				return observed.value;
			}
			statCalls += 1;
			if (observedIdentity && !sameIdentity(observedIdentity, identity)) invalid = true;
			observedIdentity = cloneIdentity(identity);
			const prior = identities.get(mapping.targetPath);
			if (pass === 1 && prior && !sameIdentity(prior, identity)) invalid = true;
			if (pass === 2 && (!prior || !sameIdentity(prior, identity))) invalid = true;
			return observed.value;
		});

	const read = (raw: unknown): Promise<unknown> => {
		const request = exact(raw, READ_REQUEST_KEYS);
		const requestedOffset = request?.offset?.value;
		const maximum = request?.maximum?.value;
		if (
			typeof requestedOffset !== "number" ||
			!Number.isSafeInteger(requestedOffset) ||
			requestedOffset !== offset ||
			typeof maximum !== "number" ||
			!Number.isSafeInteger(maximum) ||
			maximum < 1 ||
			maximum > CHUNK_BYTES
		) {
			invalid = true;
			return Promise.resolve(Object.freeze({ status: "error" }));
		}
		return invoke(
			() => source.read(Object.freeze({ offset: requestedOffset, maximum })),
			OPERATION_TIMEOUT_MS,
			(value) => {
				const bytes = ownData(value, "bytes");
				if (exactBytes(bytes)) erase(bytes);
				markUncertain();
			},
		).then((observed) => {
			if (observed.status !== "fulfilled") {
				invalid = true;
				if (observed.status === "timeout") markUncertain();
				return Object.freeze({ status: "error" });
			}
			const bytesResult = exact(observed.value, READ_BYTES_KEYS);
			if (bytesResult?.status?.value === "bytes") {
				const bytes = bytesResult.bytes?.value;
				if (
					!exactBytes(bytes) ||
					bytes.byteLength < 1 ||
					bytes.byteLength > maximum ||
					offset + bytes.byteLength > mapping.size
				) {
					if (exactBytes(bytes)) erase(bytes);
					invalid = true;
					return Object.freeze({ status: "error" });
				}
				hasher.update(bytes);
				const take = Math.min(bytes.byteLength, prefix.byteLength - prefixLength);
				if (take > 0) {
					const slice = Uint8Array.prototype.subarray.call(bytes, 0, take) as Uint8Array;
					Uint8Array.prototype.set.call(prefix, slice, prefixLength);
					prefixLength += take;
				}
				offset += bytes.byteLength;
				return Object.freeze({ status: "bytes" as const, bytes });
			}
			const discoveredBytes = ownData(observed.value, "bytes");
			if (exactBytes(discoveredBytes)) erase(discoveredBytes);
			const eofResult = exact(observed.value, READ_EOF_KEYS);
			if (!eofResult || eofResult.status?.value !== "eof" || offset !== mapping.size || eof) {
				invalid = true;
				return Object.freeze({ status: "error" });
			}
			eof = true;
			return Object.freeze({ status: "eof" as const });
		});
	};

	const close = (): Promise<unknown> => {
		if (closed) return closed;
		closed = (async () => {
			let digest = "";
			try {
				digest = hasher.digest("hex");
			} catch {
				invalid = true;
			}
			if (
				statCalls !== 2 ||
				!observedIdentity ||
				!eof ||
				offset !== mapping.size ||
				digest !== mapping.sha256 ||
				!validateElf(
					prefix,
					prefixLength,
					mapping.source.manifest.target,
					mapping.targetPath === "node/node" || mapping.targetPath === "python/bin/python3.11",
				)
			)
				invalid = true;
			if (pass === 1 && observedIdentity && !invalid)
				identities.set(mapping.targetPath, cloneIdentity(observedIdentity));
			erase(prefix);
			const sourceClosed = await source.close();
			if (!sourceClosed) markUncertain();
			onComplete(!invalid && sourceClosed);
			return Object.freeze({ status: !invalid && sourceClosed ? "closed" : "error" });
		})();
		return closed;
	};
	return Object.freeze({ stat, read, close });
}

function createComposedTree(
	mappings: readonly Mapping[],
	sources: readonly SourceSnapshot[],
	allIdentities: Set<object>,
): OfflineRuntimeTreeCapability {
	const sorted = Object.freeze([...mappings].sort((left, right) => compareUtf8(left.targetPath, right.targetPath)));
	const byPath = new Map(sorted.map((mapping) => [mapping.targetPath, mapping]));
	const passIdentities = new Map<string, Identity>();
	const openReaderCloses = new Set<() => Promise<unknown>>();
	const cleanup = new Set<Promise<boolean>>();
	let nextPassOne = 0;
	let nextPassTwo = 0;
	let active = false;
	let listCalled = false;
	let poisoned = false;
	let closeUncertain = false;
	let closed: Promise<unknown> | null = null;

	const markUncertain = (): void => {
		poisoned = true;
		closeUncertain = true;
	};
	const list = (): Promise<unknown> => {
		if (closed || listCalled) return Promise.resolve(Object.freeze({ status: "error" }));
		listCalled = true;
		return Promise.resolve(
			Object.freeze({
				status: "listed" as const,
				entries: Object.freeze(
					sorted.map((mapping) => Object.freeze({ path: mapping.targetPath, mode: mapping.mode })),
				),
			}),
		);
	};

	const open = (raw: unknown): Promise<unknown> => {
		if (closed || !listCalled || active || poisoned) return Promise.resolve(Object.freeze({ status: "error" }));
		const request = exact(raw, OPEN_REQUEST_KEYS);
		const path = request?.path?.value;
		const pass = request?.pass?.value;
		if (typeof path !== "string" || (pass !== 1 && pass !== 2))
			return Promise.resolve(Object.freeze({ status: "error" }));
		const expectedIndex = pass === 1 ? nextPassOne : nextPassTwo;
		if (
			(pass === 2 && nextPassOne !== sorted.length) ||
			expectedIndex >= sorted.length ||
			sorted[expectedIndex]?.targetPath !== path
		) {
			poisoned = true;
			return Promise.resolve(Object.freeze({ status: "error" }));
		}
		const mapping = byPath.get(path);
		if (!mapping) {
			poisoned = true;
			return Promise.resolve(Object.freeze({ status: "error" }));
		}
		active = true;
		return invoke(
			() => mapping.source.tree.open(Object.freeze({ path: mapping.sourcePath, pass })),
			OPERATION_TIMEOUT_MS,
			(value) => closeReaderFrom(value, allIdentities, cleanup),
		).then(async (observed) => {
			if (observed.status !== "fulfilled") {
				active = false;
				poisoned = true;
				if (observed.status === "timeout") closeUncertain = true;
				return Object.freeze({ status: "error" });
			}
			const result = exact(observed.value, OPEN_RESULT_KEYS);
			const rawReader = result?.reader?.value;
			const reader = discoverReader(rawReader, allIdentities);
			if (!result || result.status?.value !== "opened" || !reader || !reader.usable) {
				if (reader) await reader.close();
				active = false;
				poisoned = true;
				return Object.freeze({ status: "error" });
			}
			let wrapperClose: (() => Promise<unknown>) | null = null;
			const wrapper = createReader(
				reader,
				mapping,
				pass,
				passIdentities,
				(valid) => {
					if (wrapperClose) openReaderCloses.delete(wrapperClose);
					active = false;
					if (!valid) {
						poisoned = true;
						return;
					}
					if (pass === 1) nextPassOne += 1;
					else nextPassTwo += 1;
				},
				markUncertain,
			);
			wrapperClose = wrapper.close;
			openReaderCloses.add(wrapperClose);
			return Object.freeze({ status: "opened" as const, reader: wrapper });
		});
	};

	const close = (): Promise<unknown> => {
		if (closed) return closed;
		closed = (async () => {
			const readerResults = await Promise.all([...openReaderCloses].map((readerClose) => readerClose()));
			const lateResults = await Promise.all([...cleanup]);
			const rootResults = await Promise.all(sources.map((source) => source.tree.close()));
			const clean =
				!closeUncertain &&
				readerResults.every((result) => statusIs(result, "closed")) &&
				rootResults.every(Boolean) &&
				lateResults.every(Boolean);
			return Object.freeze({ status: clean ? ("closed" as const) : ("error" as const) });
		})();
		return closed;
	};
	return Object.freeze({ list, open, close });
}

async function closeSources(
	sources: readonly SourceSnapshot[],
	code: OfflineRuntimeFailureCode,
): Promise<ComposeOfflineRuntimeResult> {
	const results = await Promise.all(sources.map((source) => source.tree.close()));
	return results.every(Boolean) ? failure(code) : failure("CLOSE_UNCONFIRMED");
}

export async function composeOfflineRuntimeTree(raw: unknown): Promise<ComposeOfflineRuntimeResult> {
	const input = exact(raw, INPUT_KEYS);
	if (!input) return failure("INPUT_INVALID");
	const kinds: readonly OfflineRuntimeSourceKind[] = Object.freeze(["node", "python", "bundle", "runtime"]);
	const acquired: SourceSnapshot[] = [];
	const manifestsRaw: unknown[] = [];
	const allIdentities = new Set<object>();
	for (const kind of kinds) {
		const source = exact(input[kind]?.value, SOURCE_KEYS);
		if (!source) return await closeSources(acquired, "INPUT_INVALID");
		const tree = acquireTree(source.tree?.value);
		if (!tree || allIdentities.has(tree.identity)) {
			return await closeSources(acquired, tree ? "SOURCE_ALIASED" : "INPUT_INVALID");
		}
		allIdentities.add(tree.identity);
		const placeholder = Object.freeze({
			kind,
			target: "any" as const,
			version: "invalid",
			buildSha256: "0".repeat(64),
			treeSha256: "0".repeat(64),
			files: Object.freeze([]),
		});
		acquired.push(Object.freeze({ manifest: placeholder, tree }));
		manifestsRaw.push(source.manifest?.value);
		if (!tree.usable) return await closeSources(acquired, "INPUT_INVALID");
	}
	const target = input.target?.value;
	if (target !== "linux-x64" && target !== "linux-arm64") return await closeSources(acquired, "INPUT_INVALID");

	const sources: SourceSnapshot[] = [];
	for (let index = 0; index < manifestsRaw.length; index += 1) {
		const manifest = snapshotManifest(manifestsRaw[index], kinds[index]!);
		if (!manifest || manifestDigest(manifest) !== manifest.treeSha256)
			return await closeSources(acquired, "MANIFEST_INVALID");
		if (
			manifest.kind === "node" || manifest.kind === "python" ? manifest.target !== target : manifest.target !== "any"
		) {
			return await closeSources(acquired, "MANIFEST_INVALID");
		}
		sources.push(Object.freeze({ manifest, tree: acquired[index]!.tree }));
	}

	const listings: Array<readonly Readonly<{ path: string; mode: 0o644 | 0o755 }>[]> = [];
	for (const source of sources) {
		const observed = await invoke(() => source.tree.list(), OPERATION_TIMEOUT_MS);
		if (observed.status !== "fulfilled") return await closeSources(sources, "SOURCE_LIST_FAILED");
		const listing = snapshotListing(observed.value);
		if (!listing || listing.length !== source.manifest.files.length)
			return await closeSources(sources, "SOURCE_LIST_INVALID");
		for (let index = 0; index < listing.length; index += 1) {
			const actual = listing[index]!;
			const expected = source.manifest.files[index]!;
			if (actual.path !== expected.path || actual.mode !== expected.mode)
				return await closeSources(sources, "SOURCE_LIST_INVALID");
		}
		listings.push(listing);
	}

	const mappings: Mapping[] = [];
	const targets = new Set<string>();
	let total = 0;
	for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
		const source = sources[sourceIndex]!;
		for (const file of source.manifest.files) {
			if (mappings.length >= MAX_FILES) return await closeSources(sources, "MANIFEST_INVALID");
			const targetPath = mapPath(source.manifest.kind, file.path);
			if (!canonicalPath(targetPath) || targets.has(targetPath))
				return await closeSources(sources, "TARGET_LAYOUT_INVALID");
			targets.add(targetPath);
			total += file.size;
			if (!Number.isSafeInteger(total) || total > MAX_TOTAL_BYTES)
				return await closeSources(sources, "MANIFEST_INVALID");
			mappings.push(
				Object.freeze({
					targetPath,
					sourcePath: file.path,
					source,
					mode: file.mode,
					size: file.size,
					sha256: file.sha256,
				}),
			);
		}
	}
	const nodeBinary = mappings.find((mapping) => mapping.targetPath === "node/node");
	const pythonBinary = mappings.find((mapping) => mapping.targetPath === "python/bin/python3.11");
	const pythonHasSitePackages =
		sources
			.find((source) => source.manifest.kind === "python")
			?.manifest.files.some((file) => file.path.startsWith("site-packages/")) === true;
	if (
		!nodeBinary ||
		nodeBinary.mode !== 0o755 ||
		!pythonBinary ||
		pythonBinary.mode !== 0o755 ||
		!targets.has("prime-agent/dist/bundle/cli.js") ||
		!targets.has("python/site-packages/rlm/__init__.py") ||
		!pythonHasSitePackages
	) {
		return await closeSources(sources, "TARGET_LAYOUT_INVALID");
	}
	return Object.freeze({
		ok: true as const,
		tree: createComposedTree(Object.freeze(mappings), Object.freeze(sources), allIdentities),
	});
}
