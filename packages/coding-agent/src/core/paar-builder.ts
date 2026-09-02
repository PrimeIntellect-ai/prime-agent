import { createHash } from "node:crypto";
import { types } from "node:util";
import {
	encodePaarManifest,
	type PaarEncodeInput,
	type PaarFileEntry,
	type PaarManifest,
	type PaarTarget,
} from "./paar-manifest-codec.js";
import { type PaarVerificationExpectation, verifyPaarArchive } from "./paar-streaming-verifier.js";

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 1024 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const OPERATION_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const INPUT_KEYS = new Set([
	"daemonProtocolVersion",
	"daemonSchemaRevision",
	"output",
	"sourceCommit",
	"target",
	"tree",
]);
const TREE_KEYS = new Set(["close", "list", "open"]);
const OUTPUT_KEYS = new Set(["close", "create"]);
const STATUS_KEYS = new Set(["status"]);
const LIST_KEYS = new Set(["entries", "status"]);
const ENTRY_KEYS = new Set(["mode", "path"]);
const OPENED_KEYS = new Set(["reader", "status"]);
const READER_KEYS = new Set(["close", "read", "stat"]);
const STAT_KEYS = new Set(["ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "nlink", "size", "uid"]);
const BYTES_KEYS = new Set(["bytes", "status"]);
const CREATED_KEYS = new Set(["status", "writer"]);
const WRITER_KEYS = new Set(["abandon", "finalize", "write"]);
const WRITTEN_KEYS = new Set(["committed", "status"]);
const SEALED_KEYS = new Set(["handle", "status"]);
const HEX40 = /^[0-9a-f]{40}$/;
const REGULAR_MODE = 0o100000n;
const TYPE_MASK = 0o170000n;
const SPECIAL_MODE = 0o7000n;
const EMPTY_SHA256 = createHash("sha256").digest("hex");

export type PaarBuilderFailureCode =
	| "ABANDON_UNCONFIRMED"
	| "BOUNDS_INVALID"
	| "CLOSE_UNCONFIRMED"
	| "INPUT_INVALID"
	| "MANIFEST_INVALID"
	| "OUTPUT_CREATE_FAILED"
	| "OUTPUT_UNCERTAIN"
	| "SOURCE_CHANGED"
	| "SOURCE_CLOSE_UNCONFIRMED"
	| "SOURCE_LIST_FAILED"
	| "SOURCE_OPEN_FAILED"
	| "SOURCE_READ_FAILED"
	| "SOURCE_STAT_INVALID"
	| "VERIFICATION_FAILED";

export type PaarBuilderResult =
	| Readonly<{
			ok: true;
			value: Readonly<{
				archiveSha256: string;
				archiveSize: number;
				buildId: string;
				manifest: PaarManifest;
			}>;
	  }>
	| Readonly<{ ok: false; error: Readonly<{ code: PaarBuilderFailureCode }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type OwnedClose = () => Promise<boolean>;
type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

interface TreeCapability {
	readonly list: BoundMethod;
	readonly open: BoundMethod;
	readonly close: OwnedClose;
}

interface OutputCapability {
	readonly create: BoundMethod;
	readonly close: OwnedClose;
}

interface ReaderCapability {
	readonly stat: BoundMethod;
	readonly read: BoundMethod;
	readonly close: OwnedClose;
}

interface WriterCapability {
	readonly identity: object;
	readonly write: BoundMethod;
	readonly finalize: BoundMethod;
	readonly abandon: OwnedClose;
}

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly uid: bigint;
	readonly gid: bigint;
	readonly mode: bigint;
	readonly nlink: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

interface ListedEntry {
	readonly path: string;
	readonly mode: 0o644 | 0o755;
}

interface FirstPassEntry extends ListedEntry {
	readonly identity: FileIdentity;
	readonly size: number;
	readonly sha256: string;
}

interface ReadOutcome {
	readonly status: "bytes" | "eof" | "error";
	readonly bytes?: Uint8Array;
}

function failed(code: PaarBuilderFailureCode): PaarBuilderResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function passed(manifest: PaarManifest, archiveSize: number, archiveSha256: string): PaarBuilderResult {
	return Object.freeze({
		ok: true as const,
		value: Object.freeze({
			archiveSha256,
			archiveSize,
			buildId: manifest.buildId,
			manifest,
		}),
	});
}

function rawDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function ownData(raw: unknown, key: string): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const descriptors = rawDescriptors(raw);
	if (!descriptors) return null;
	const names = Object.getOwnPropertyNames(descriptors);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return descriptors;
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

function erase(bytes: Uint8Array | null): void {
	if (bytes === null) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		// Best effort for locally owned bytes.
	}
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype) as object;
const BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;
const BUFFER_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const ARRAY_BUFFER_LENGTH_GETTER = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

function isExactBytes(raw: unknown): raw is Uint8Array {
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
		) {
			return false;
		}
		const byteLength = Reflect.apply(BYTE_LENGTH_GETTER, raw, []) as number;
		const byteOffset = Reflect.apply(BYTE_OFFSET_GETTER, raw, []) as number;
		const buffer = Reflect.apply(BUFFER_GETTER, raw, []) as unknown;
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			types.isProxy(buffer) ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype
		) {
			return false;
		}
		const backingLength = Reflect.apply(ARRAY_BUFFER_LENGTH_GETTER, buffer, []) as number;
		ArrayBuffer.prototype.slice.call(buffer, 0, 0);
		return byteOffset === 0 && byteLength === backingLength;
	} catch {
		return false;
	}
}

function exactArray(raw: unknown, maxLength: number): readonly unknown[] | null {
	if (!Array.isArray(raw)) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0 || raw.length < 1 || raw.length > maxLength) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== raw.length + 1 || names[names.length - 1] !== "length") return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		const values: unknown[] = [];
		for (let index = 0; index < raw.length; index += 1) {
			const descriptor = descriptors[String(index)];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
			values.push(descriptor.value);
		}
		return Object.freeze(values);
	} catch {
		return null;
	}
}

function snapshotIdentity(raw: unknown): FileIdentity | null {
	const descriptors = exact(raw, STAT_KEYS);
	if (!descriptors) return null;
	const fields: Record<string, bigint> = {};
	for (const key of STAT_KEYS) {
		const value = descriptors[key]?.value;
		if (typeof value !== "bigint" || value < 0n) return null;
		fields[key] = value;
	}
	if ((fields.mode & TYPE_MASK) !== REGULAR_MODE || (fields.mode & SPECIAL_MODE) !== 0n) return null;
	if (fields.nlink !== 1n) return null;
	const size = Number(fields.size);
	if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return null;
	return Object.freeze({
		dev: fields.dev,
		ino: fields.ino,
		uid: fields.uid,
		gid: fields.gid,
		mode: fields.mode,
		nlink: fields.nlink,
		size: fields.size,
		mtimeNs: fields.mtimeNs,
		ctimeNs: fields.ctimeNs,
	});
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
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

function listedEntries(raw: unknown): readonly ListedEntry[] | null {
	const result = exact(raw, LIST_KEYS);
	if (!result || result.status.value !== "listed") return null;
	const entries = exactArray(result.entries.value, MAX_FILES);
	if (!entries) return null;
	const output: ListedEntry[] = [];
	for (const entry of entries) {
		const descriptors = exact(entry, ENTRY_KEYS);
		const path = descriptors?.path?.value;
		const mode = descriptors?.mode?.value;
		if (typeof path !== "string" || (mode !== 0o644 && mode !== 0o755)) return null;
		output.push(Object.freeze({ path, mode }));
	}
	return Object.freeze(output);
}

function statusClosed(raw: unknown, status: string): boolean {
	return exact(raw, STATUS_KEYS)?.status?.value === status;
}

function closeOwner(raw: unknown, expectedStatus: string): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (!descriptor) return null;
		const close = bind(raw, descriptor);
		if (!close) return null;
		let used = false;
		return async (): Promise<boolean> => {
			if (used) return false;
			used = true;
			const observed = await invoke(() => close(), CLOSE_TIMEOUT_MS);
			return observed.status === "fulfilled" && statusClosed(observed.value, expectedStatus);
		};
	} catch {
		return null;
	}
}

function snapshotTree(raw: unknown, close: OwnedClose): TreeCapability | null {
	const descriptors = exact(raw, TREE_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const list = bind(raw, descriptors.list);
	const open = bind(raw, descriptors.open);
	return list && open ? Object.freeze({ list, open, close }) : null;
}

function snapshotOutput(raw: unknown, close: OwnedClose): OutputCapability | null {
	const descriptors = exact(raw, OUTPUT_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const create = bind(raw, descriptors.create);
	return create ? Object.freeze({ create, close }) : null;
}

async function closeOwners(closes: readonly OwnedClose[]): Promise<boolean> {
	const results = await Promise.all([...new Set(closes)].map((close) => close()));
	return results.every((closed) => closed);
}

function discoverReader(
	raw: unknown,
	identities: Set<object>,
): Readonly<{ aliased: boolean; close: OwnedClose | null; reader: ReaderCapability | null }> {
	if (typeof raw !== "object" || raw === null) {
		return Object.freeze({ aliased: false, close: null, reader: null });
	}
	if (identities.has(raw)) return Object.freeze({ aliased: true, close: null, reader: null });
	identities.add(raw);
	const close = closeOwner(raw, "closed");
	const descriptors = exact(raw, READER_KEYS);
	if (!close || !descriptors) return Object.freeze({ aliased: false, close, reader: null });
	const stat = bind(raw, descriptors.stat);
	const read = bind(raw, descriptors.read);
	return stat && read
		? Object.freeze({ aliased: false, close, reader: Object.freeze({ stat, read, close }) })
		: Object.freeze({ aliased: false, close, reader: null });
}

async function closeLateReader(raw: unknown, identities: Set<object>): Promise<void> {
	const discovery = discoverReader(ownData(raw, "reader"), identities);
	if (discovery.close) await discovery.close();
}

async function openReader(
	tree: TreeCapability,
	entry: ListedEntry,
	pass: 1 | 2,
	identities: Set<object>,
): Promise<Readonly<{ ok: true; reader: ReaderCapability }> | Readonly<{ ok: false; closeFailed: boolean }>> {
	const observed = await invoke(
		() => tree.open(Object.freeze({ path: entry.path, pass })),
		OPERATION_TIMEOUT_MS,
		(value) => {
			void closeLateReader(value, identities);
		},
	);
	if (observed.status !== "fulfilled") return Object.freeze({ ok: false as const, closeFailed: false });
	const rawReader = ownData(observed.value, "reader");
	const discovery = discoverReader(rawReader, identities);
	const opened = exact(observed.value, OPENED_KEYS);
	if (!opened || opened.status.value !== "opened" || !discovery.reader) {
		const closeFailed = discovery.close ? !(await discovery.close()) : false;
		return Object.freeze({ ok: false as const, closeFailed });
	}
	return Object.freeze({ ok: true as const, reader: discovery.reader });
}

function discoverBytes(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "bytes");
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function readOutcome(raw: unknown, maximum: number): ReadOutcome | null {
	const transferred = discoverBytes(raw);
	const status = exact(raw, STATUS_KEYS);
	if (status?.status?.value === "eof" || status?.status?.value === "error") {
		return Object.freeze({ status: status.status.value });
	}
	const bytesResult = exact(raw, BYTES_KEYS);
	const bytes = bytesResult?.bytes?.value;
	if (
		bytesResult?.status?.value !== "bytes" ||
		!isExactBytes(bytes) ||
		bytes.byteLength < 1 ||
		bytes.byteLength > maximum ||
		bytes.byteLength > CHUNK_BYTES
	) {
		if (isExactBytes(transferred)) erase(transferred);
		return null;
	}
	return Object.freeze({ status: "bytes" as const, bytes });
}

function eraseLateRead(raw: unknown): void {
	const bytes = discoverBytes(raw);
	if (isExactBytes(bytes)) erase(bytes);
}

async function readChunk(reader: ReaderCapability, offset: number, maximum: number): Promise<ReadOutcome | null> {
	const observed = await invoke(
		() => reader.read(Object.freeze({ offset, maximum })),
		OPERATION_TIMEOUT_MS,
		eraseLateRead,
	);
	return observed.status === "fulfilled" ? readOutcome(observed.value, maximum) : null;
}

async function statReader(reader: ReaderCapability): Promise<FileIdentity | null> {
	const observed = await invoke(() => reader.stat(), OPERATION_TIMEOUT_MS);
	return observed.status === "fulfilled" ? snapshotIdentity(observed.value) : null;
}

function preflight(
	sourceCommit: unknown,
	target: unknown,
	daemonProtocolVersion: unknown,
	daemonSchemaRevision: unknown,
	entries: readonly ListedEntry[],
): Readonly<{
	sourceCommit: string;
	target: PaarTarget;
	daemonProtocolVersion: number;
	daemonSchemaRevision: number;
}> | null {
	if (
		typeof sourceCommit !== "string" ||
		!HEX40.test(sourceCommit) ||
		(target !== "linux-x64" && target !== "linux-arm64") ||
		typeof daemonProtocolVersion !== "number" ||
		!Number.isSafeInteger(daemonProtocolVersion) ||
		daemonProtocolVersion < 1 ||
		typeof daemonSchemaRevision !== "number" ||
		!Number.isSafeInteger(daemonSchemaRevision) ||
		daemonSchemaRevision < 0
	) {
		return null;
	}
	const files = entries.map((entry) =>
		Object.freeze({ path: entry.path, mode: entry.mode, size: 0, sha256: EMPTY_SHA256, offset: 0 }),
	);
	const encoded = encodePaarManifest(
		Object.freeze({
			sourceCommit,
			target,
			daemonProtocolVersion,
			daemonSchemaRevision,
			files: Object.freeze(files),
		}),
	);
	if (!encoded.ok) return null;
	erase(encoded.value.header);
	return Object.freeze({ sourceCommit, target, daemonProtocolVersion, daemonSchemaRevision });
}

type ReaderWorkResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; code: PaarBuilderFailureCode }>;

async function withReader<T>(
	tree: TreeCapability,
	entry: ListedEntry,
	pass: 1 | 2,
	work: (reader: ReaderCapability) => Promise<ReaderWorkResult<T>>,
	identities: Set<object>,
): Promise<ReaderWorkResult<T>> {
	const opened = await openReader(tree, entry, pass, identities);
	if (!opened.ok) {
		return Object.freeze({
			ok: false as const,
			code: opened.closeFailed ? "SOURCE_CLOSE_UNCONFIRMED" : "SOURCE_OPEN_FAILED",
		});
	}
	let result: ReaderWorkResult<T>;
	try {
		result = await work(opened.reader);
	} catch {
		result = Object.freeze({ ok: false as const, code: "SOURCE_READ_FAILED" as const });
	}
	const closed = await opened.reader.close();
	return closed ? result : Object.freeze({ ok: false as const, code: "SOURCE_CLOSE_UNCONFIRMED" as const });
}

async function firstPassFile(
	tree: TreeCapability,
	entry: ListedEntry,
	identities: Set<object>,
): Promise<ReaderWorkResult<FirstPassEntry>> {
	return await withReader(
		tree,
		entry,
		1,
		async (reader) => {
			const before = await statReader(reader);
			if (!before) return Object.freeze({ ok: false as const, code: "SOURCE_STAT_INVALID" as const });
			if (Number(before.mode & 0o777n) !== entry.mode) {
				return Object.freeze({ ok: false as const, code: "SOURCE_STAT_INVALID" as const });
			}
			const size = Number(before.size);
			const hasher = createHash("sha256");
			let offset = 0;
			while (offset < size) {
				const chunk = await readChunk(reader, offset, Math.min(CHUNK_BYTES, size - offset));
				if (!chunk || chunk.status !== "bytes" || !chunk.bytes) {
					return Object.freeze({ ok: false as const, code: "SOURCE_READ_FAILED" as const });
				}
				try {
					hasher.update(chunk.bytes);
					offset += chunk.bytes.byteLength;
				} finally {
					erase(chunk.bytes);
				}
			}
			const eof = await readChunk(reader, offset, 1);
			if (!eof || eof.status !== "eof") {
				if (eof?.bytes) erase(eof.bytes);
				return Object.freeze({ ok: false as const, code: "SOURCE_READ_FAILED" as const });
			}
			const after = await statReader(reader);
			if (!after) return Object.freeze({ ok: false as const, code: "SOURCE_STAT_INVALID" as const });
			if (!sameIdentity(before, after)) {
				return Object.freeze({ ok: false as const, code: "SOURCE_CHANGED" as const });
			}
			return Object.freeze({
				ok: true as const,
				value: Object.freeze({ ...entry, identity: before, size, sha256: hasher.digest("hex") }),
			});
		},
		identities,
	);
}

function ownedMethod(raw: unknown, name: string, expectedStatus: string): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor) return null;
		const method = bind(raw, descriptor);
		if (!method) return null;
		let used = false;
		return async (): Promise<boolean> => {
			if (used) return false;
			used = true;
			const observed = await invoke(() => method(), CLOSE_TIMEOUT_MS);
			return observed.status === "fulfilled" && statusClosed(observed.value, expectedStatus);
		};
	} catch {
		return null;
	}
}

function discoverWriter(
	raw: unknown,
	identities: Set<object>,
): Readonly<{ abandon: OwnedClose | null; writer: WriterCapability | null }> {
	if (typeof raw !== "object" || raw === null) return Object.freeze({ abandon: null, writer: null });
	if (identities.has(raw)) return Object.freeze({ abandon: null, writer: null });
	identities.add(raw);
	const abandon = ownedMethod(raw, "abandon", "abandoned");
	const descriptors = exact(raw, WRITER_KEYS);
	if (!abandon || !descriptors) return Object.freeze({ abandon, writer: null });
	const write = bind(raw, descriptors.write);
	const finalize = bind(raw, descriptors.finalize);
	return write && finalize
		? Object.freeze({ abandon, writer: Object.freeze({ identity: raw, write, finalize, abandon }) })
		: Object.freeze({ abandon, writer: null });
}

async function abandonLateWriter(raw: unknown, identities: Set<object>): Promise<void> {
	const discovery = discoverWriter(ownData(raw, "writer"), identities);
	if (discovery.abandon) await discovery.abandon();
}

async function createWriter(
	output: OutputCapability,
	archiveSize: number,
	buildId: string,
	identities: Set<object>,
): Promise<Readonly<{ ok: true; writer: WriterCapability }> | Readonly<{ ok: false; abandonFailed: boolean }>> {
	const observed = await invoke(
		() => output.create(Object.freeze({ archiveSize, buildId })),
		OPERATION_TIMEOUT_MS,
		(value) => {
			void abandonLateWriter(value, identities);
		},
	);
	if (observed.status !== "fulfilled") {
		return Object.freeze({ ok: false as const, abandonFailed: false });
	}
	const discovery = discoverWriter(ownData(observed.value, "writer"), identities);
	const created = exact(observed.value, CREATED_KEYS);
	if (!created || created.status.value !== "created" || !discovery.writer) {
		const abandonFailed = discovery.abandon ? !(await discovery.abandon()) : false;
		return Object.freeze({ ok: false as const, abandonFailed });
	}
	return Object.freeze({ ok: true as const, writer: discovery.writer });
}

async function writeTransferred(
	writer: WriterCapability,
	offset: number,
	source: Uint8Array,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; uncertain: true }>> {
	let position = 0;
	while (position < source.byteLength) {
		let copy: Uint8Array | null = new Uint8Array(
			source.subarray(position, Math.min(source.byteLength, position + CHUNK_BYTES)),
		);
		const copyLength = copy.byteLength;
		const request = Object.freeze({ offset: offset + position, bytes: copy });
		let raw: unknown;
		try {
			raw = writer.write(request);
			copy = null;
		} catch {
			copy = null;
			return Object.freeze({ ok: false as const, uncertain: true as const });
		} finally {
			erase(copy);
		}
		const observed = await observe(raw, OPERATION_TIMEOUT_MS);
		if (observed.status !== "fulfilled") {
			return Object.freeze({ ok: false as const, uncertain: true as const });
		}
		const written = exact(observed.value, WRITTEN_KEYS);
		const committed = written?.committed?.value;
		if (
			written?.status?.value !== "written" ||
			typeof committed !== "number" ||
			!Number.isSafeInteger(committed) ||
			committed < 1 ||
			committed > copyLength
		) {
			return Object.freeze({ ok: false as const, uncertain: true as const });
		}
		position += committed;
	}
	return Object.freeze({ ok: true as const });
}

async function secondPassFile(
	tree: TreeCapability,
	entry: FirstPassEntry,
	writer: WriterCapability,
	payloadOffset: number,
	archiveHasher: ReturnType<typeof createHash>,
	markOutputUncertain: () => void,
	identities: Set<object>,
): Promise<ReaderWorkResult<void>> {
	return await withReader(
		tree,
		entry,
		2,
		async (reader) => {
			const before = await statReader(reader);
			if (!before) return Object.freeze({ ok: false as const, code: "SOURCE_STAT_INVALID" as const });
			if (!sameIdentity(before, entry.identity)) {
				return Object.freeze({ ok: false as const, code: "SOURCE_CHANGED" as const });
			}
			const hasher = createHash("sha256");
			let offset = 0;
			while (offset < entry.size) {
				const chunk = await readChunk(reader, offset, Math.min(CHUNK_BYTES, entry.size - offset));
				if (!chunk || chunk.status !== "bytes" || !chunk.bytes) {
					return Object.freeze({ ok: false as const, code: "SOURCE_READ_FAILED" as const });
				}
				try {
					hasher.update(chunk.bytes);
					archiveHasher.update(chunk.bytes);
					const written = await writeTransferred(writer, payloadOffset + offset, chunk.bytes);
					if (!written.ok) {
						markOutputUncertain();
						return Object.freeze({ ok: false as const, code: "OUTPUT_UNCERTAIN" as const });
					}
					offset += chunk.bytes.byteLength;
				} finally {
					erase(chunk.bytes);
				}
			}
			const eof = await readChunk(reader, offset, 1);
			if (!eof || eof.status !== "eof") {
				if (eof?.bytes) erase(eof.bytes);
				return Object.freeze({ ok: false as const, code: "SOURCE_READ_FAILED" as const });
			}
			const after = await statReader(reader);
			if (!after) return Object.freeze({ ok: false as const, code: "SOURCE_STAT_INVALID" as const });
			if (!sameIdentity(before, after) || !sameIdentity(after, entry.identity)) {
				return Object.freeze({ ok: false as const, code: "SOURCE_CHANGED" as const });
			}
			if (hasher.digest("hex") !== entry.sha256) {
				return Object.freeze({ ok: false as const, code: "SOURCE_CHANGED" as const });
			}
			return Object.freeze({ ok: true as const, value: undefined });
		},
		identities,
	);
}

async function closeLateSealed(raw: unknown, identities: Set<object>, writerIdentity: object): Promise<void> {
	const handle = ownData(raw, "handle");
	if (typeof handle !== "object" || handle === null) return;
	const aliased = identities.has(handle);
	if (aliased && handle !== writerIdentity) return;
	if (!aliased) identities.add(handle);
	const close = closeOwner(handle, "closed");
	if (close) await close();
}

async function buildWithWriter(
	tree: TreeCapability,
	writer: WriterCapability,
	firstPass: readonly FirstPassEntry[],
	manifest: PaarManifest,
	header: Uint8Array,
	headerSize: number,
	archiveSize: number,
	input: Readonly<{
		sourceCommit: string;
		target: PaarTarget;
		daemonProtocolVersion: number;
		daemonSchemaRevision: number;
	}>,
	identities: Set<object>,
): Promise<PaarBuilderResult> {
	let phase: "open" | "uncertain" | "finalized" = "open";
	const writerState = { uncertain: false };
	let outcome: PaarBuilderResult;
	try {
		const archiveHasher = createHash("sha256");
		archiveHasher.update(header);
		const headerWrite = await writeTransferred(writer, 0, header);
		if (!headerWrite.ok) {
			phase = "uncertain";
			writerState.uncertain = true;
			outcome = failed("OUTPUT_UNCERTAIN");
		} else {
			let payloadOffset = headerSize;
			outcome = failed("SOURCE_READ_FAILED");
			let passFailed = false;
			for (const entry of firstPass) {
				const second = await secondPassFile(
					tree,
					entry,
					writer,
					payloadOffset,
					archiveHasher,
					() => {
						phase = "uncertain";
						writerState.uncertain = true;
					},
					identities,
				);
				if (!second.ok) {
					outcome = failed(writerState.uncertain ? "OUTPUT_UNCERTAIN" : second.code);
					passFailed = true;
					break;
				}
				payloadOffset += entry.size;
			}
			if (!passFailed && payloadOffset !== archiveSize) {
				outcome = failed("SOURCE_CHANGED");
				passFailed = true;
			}
			if (!passFailed) {
				const archiveSha256 = archiveHasher.digest("hex");
				phase = "uncertain";
				const finalized = await invoke(
					() => writer.finalize(),
					OPERATION_TIMEOUT_MS,
					(value) => {
						void closeLateSealed(value, identities, writer.identity);
					},
				);
				if (finalized.status !== "fulfilled") {
					outcome = failed("OUTPUT_UNCERTAIN");
				} else {
					const handle = ownData(finalized.value, "handle");
					const sealed = exact(finalized.value, SEALED_KEYS);
					const handleObject = typeof handle === "object" && handle !== null ? handle : null;
					const aliased = handleObject !== null && identities.has(handleObject);
					if (handleObject !== null && !aliased) identities.add(handleObject);
					if (!sealed || sealed.status.value !== "sealed" || aliased) {
						phase = "finalized";
						const mayCloseTransition = !aliased || handle === writer.identity;
						const close = mayCloseTransition ? closeOwner(handle, "closed") : null;
						if (close && !(await close())) outcome = failed("CLOSE_UNCONFIRMED");
						else outcome = failed("OUTPUT_UNCERTAIN");
					} else {
						phase = "finalized";
						const expectation: PaarVerificationExpectation = Object.freeze({
							archiveSize,
							archiveSha256,
							buildId: manifest.buildId,
							sourceCommit: input.sourceCommit,
							target: input.target,
							protocolName: manifest.protocol.name,
							protocolVersion: manifest.protocol.version,
							daemonProtocolVersion: input.daemonProtocolVersion,
							daemonSchemaRevision: input.daemonSchemaRevision,
						});
						const verified = await verifyPaarArchive(handle, expectation);
						outcome = verified.ok ? passed(manifest, archiveSize, archiveSha256) : failed("VERIFICATION_FAILED");
					}
				}
			}
		}
	} catch {
		outcome = failed(
			phase === "uncertain"
				? "OUTPUT_UNCERTAIN"
				: phase === "finalized"
					? "VERIFICATION_FAILED"
					: "SOURCE_READ_FAILED",
		);
	} finally {
		erase(header);
	}
	if (phase === "open" && !(await writer.abandon())) return failed("ABANDON_UNCONFIRMED");
	return outcome;
}

async function buildOwned(
	input: Descriptors,
	tree: TreeCapability,
	output: OutputCapability,
	identities: Set<object>,
): Promise<PaarBuilderResult> {
	const listed = await invoke(() => tree.list(), OPERATION_TIMEOUT_MS);
	if (listed.status !== "fulfilled") return failed("SOURCE_LIST_FAILED");
	const entries = listedEntries(listed.value);
	if (!entries) return failed("SOURCE_LIST_FAILED");
	const validated = preflight(
		input.sourceCommit.value,
		input.target.value,
		input.daemonProtocolVersion.value,
		input.daemonSchemaRevision.value,
		entries,
	);
	if (!validated) return failed("INPUT_INVALID");
	const first: FirstPassEntry[] = [];
	let totalPayload = 0;
	for (const entry of entries) {
		const result = await firstPassFile(tree, entry, identities);
		if (!result.ok) return failed(result.code);
		totalPayload += result.value.size;
		if (!Number.isSafeInteger(totalPayload) || totalPayload > MAX_PAYLOAD_BYTES) {
			return failed("BOUNDS_INVALID");
		}
		first.push(result.value);
	}
	const files: PaarFileEntry[] = [];
	let offset = 0;
	for (const entry of first) {
		files.push(
			Object.freeze({
				path: entry.path,
				mode: entry.mode,
				size: entry.size,
				sha256: entry.sha256,
				offset,
			}),
		);
		offset += entry.size;
	}
	const encodeInput: PaarEncodeInput = Object.freeze({
		sourceCommit: validated.sourceCommit,
		target: validated.target,
		daemonProtocolVersion: validated.daemonProtocolVersion,
		daemonSchemaRevision: validated.daemonSchemaRevision,
		files: Object.freeze(files),
	});
	const encoded = encodePaarManifest(encodeInput);
	if (!encoded.ok) return failed("MANIFEST_INVALID");
	let header: Uint8Array | null = encoded.value.header;
	const writerResult = await createWriter(
		output,
		encoded.value.archiveSize,
		encoded.value.manifest.buildId,
		identities,
	);
	if (!writerResult.ok) {
		erase(header);
		header = null;
		return failed(writerResult.abandonFailed ? "ABANDON_UNCONFIRMED" : "OUTPUT_CREATE_FAILED");
	}
	const ownedHeader = header;
	header = null;
	return await buildWithWriter(
		tree,
		writerResult.writer,
		first,
		encoded.value.manifest,
		ownedHeader,
		encoded.value.headerSize,
		encoded.value.archiveSize,
		validated,
		identities,
	);
}

export async function buildPaarArchive(raw: unknown): Promise<PaarBuilderResult> {
	const treeRaw = ownData(raw, "tree");
	const outputRaw = ownData(raw, "output");
	const identities = new Set<object>();
	if (typeof treeRaw === "object" && treeRaw !== null) identities.add(treeRaw);
	if (typeof outputRaw === "object" && outputRaw !== null) identities.add(outputRaw);
	const closeCache = new Map<object, OwnedClose | null>();
	const captureClose = (candidate: unknown): OwnedClose | null => {
		if (typeof candidate !== "object" || candidate === null) return closeOwner(candidate, "closed");
		if (closeCache.has(candidate)) return closeCache.get(candidate) ?? null;
		const close = closeOwner(candidate, "closed");
		closeCache.set(candidate, close);
		return close;
	};
	const treeClose = captureClose(treeRaw);
	const outputClose = captureClose(outputRaw);
	const ownedCloses = [...new Set([treeClose, outputClose])].filter((close): close is OwnedClose => close !== null);
	let outcome: PaarBuilderResult;
	try {
		const input = exact(raw, INPUT_KEYS);
		if (!input || !treeClose || !outputClose || treeRaw === outputRaw) {
			outcome = failed("INPUT_INVALID");
		} else {
			const tree = snapshotTree(treeRaw, treeClose);
			const output = snapshotOutput(outputRaw, outputClose);
			outcome = tree && output ? await buildOwned(input, tree, output, identities) : failed("INPUT_INVALID");
		}
	} catch {
		outcome = failed("INPUT_INVALID");
	}
	return (await closeOwners(ownedCloses)) ? outcome : failed("CLOSE_UNCONFIRMED");
}
