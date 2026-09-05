import { createHash } from "node:crypto";
import { constants, type Dirent, type Stats } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { types } from "node:util";
import type { DurableObservationIdentity } from "./durable-observation-record-codec.js";
import { isValidDigest, isValidSafeId } from "./remote-host-frame-codec.js";

const INPUT_KEYS = new Set(["directoryPath", "identity"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const PAGE_REQUEST_KEYS = new Set(["cursor", "maxBytes", "maxCount"]);
const PUBLISH_KEYS = new Set(["bytes", "observationId", "sha256", "size", "state"]);
const IDENTITY_FILE = "identity.json";
const RECORD_RE = /^(\d{20})\.b11-observation$/;
const MAX_DIRECTORY_PATH = 4096;
const MAX_RECORDS = 20_000;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_COUNT = 64;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const NO_SPECIAL_MODE = 0o7000;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const arrayBufferLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type ObservationState = "pending" | "applied";

type BackendErrorCode = "DIRECTORY_UNSAFE" | "IDENTITY_MISMATCH" | "INPUT_INVALID" | "IO_UNCERTAIN";
export type CreateNodeDurableObservationBackendResult =
	| Readonly<{ ok: true; backend: NodeDurableObservationBackendCapability }>
	| Readonly<{ ok: false; error: Readonly<{ code: BackendErrorCode }> }>;

export interface NodeDurableObservationBackendCapability {
	recoverPage(raw: unknown): Promise<unknown>;
	publishPending(raw: unknown): Promise<unknown>;
	publishApplied(raw: unknown): Promise<unknown>;
	close(): Promise<Readonly<{ status: "closed" | "error" }>>;
}

interface DirectoryIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly uid: number;
}

interface FileIdentity {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	readonly ctimeMs: number;
}

interface OpenRecord {
	readonly identity: FileIdentity;
	readonly sequence: number;
	readonly bytes: Uint8Array;
	readonly size: number;
	readonly sha256: string;
	readonly handle: FileHandle;
}

function failure(code: BackendErrorCode): CreateNodeDurableObservationBackendResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function descriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Object.prototype ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return null;
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

function identity(raw: unknown): Readonly<DurableObservationIdentity> | null {
	const found = exact(raw, IDENTITY_KEYS);
	const hostId = found?.hostId?.value;
	const generation = found?.generation?.value;
	const sessionId = found?.sessionId?.value;
	if (!isValidSafeId(hostId) || !isValidSafeId(generation) || !isValidSafeId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

function ownedBytes(raw: unknown): raw is Uint8Array {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Uint8Array.prototype ||
			Object.hasOwn(raw, "buffer") ||
			Object.hasOwn(raw, "byteOffset") ||
			Object.hasOwn(raw, "byteLength") ||
			!bufferGetter ||
			!byteOffsetGetter ||
			!byteLengthGetter ||
			!arrayBufferLengthGetter
		)
			return false;
		const buffer = Reflect.apply(bufferGetter, raw, []) as unknown;
		const offset = Reflect.apply(byteOffsetGetter, raw, []) as unknown;
		const length = Reflect.apply(byteLengthGetter, raw, []) as unknown;
		if (
			typeof buffer !== "object" ||
			buffer === null ||
			Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
			typeof offset !== "number" ||
			offset !== 0 ||
			typeof length !== "number" ||
			!Number.isSafeInteger(length)
		)
			return false;
		const backingLength = Reflect.apply(arrayBufferLengthGetter, buffer, []) as number;
		return backingLength === length;
	} catch {
		return false;
	}
}

function erase(bytes: Uint8Array | null | undefined): void {
	if (!bytes) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		/* Ownership was not safely writable. */
	}
}

function errorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	try {
		if (types.isProxy(error)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(error, "code");
		return descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : null;
	} catch {
		return null;
	}
}

function currentUid(): number | null {
	try {
		const uid = process.getuid?.();
		return typeof uid === "number" && Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
	} catch {
		return null;
	}
}

function safeDirectory(stats: Stats, uid: number): boolean {
	return (
		stats.isDirectory() &&
		!stats.isFile() &&
		(stats.mode & 0o777) === DIRECTORY_MODE &&
		(stats.mode & NO_SPECIAL_MODE) === 0 &&
		stats.uid === uid &&
		Number.isSafeInteger(stats.dev) &&
		Number.isSafeInteger(stats.ino)
	);
}

function safeFile(stats: Stats, uid: number, maxBytes: number): FileIdentity | null {
	if (
		!stats.isFile() ||
		stats.isSymbolicLink() ||
		stats.nlink !== 1 ||
		(stats.mode & 0o777) !== FILE_MODE ||
		(stats.mode & NO_SPECIAL_MODE) !== 0 ||
		stats.uid !== uid ||
		!Number.isSafeInteger(stats.size) ||
		stats.size < 1 ||
		stats.size > maxBytes ||
		!Number.isSafeInteger(stats.dev) ||
		!Number.isSafeInteger(stats.ino)
	)
		return null;
	return Object.freeze({
		dev: stats.dev,
		ino: stats.ino,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
		ctimeMs: stats.ctimeMs,
	});
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
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

async function readOpenRecord(path: string, sequence: number, uid: number): Promise<OpenRecord | null> {
	let handle: FileHandle | null = null;
	let bytes: Uint8Array | null = null;
	let transferred = false;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const before = safeFile(await handle.stat(), uid, MAX_RECORD_BYTES);
		if (!before) return null;
		bytes = new Uint8Array(before.size);
		let offset = 0;
		while (offset < bytes.byteLength) {
			const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
			if (!Number.isSafeInteger(read.bytesRead) || read.bytesRead < 1 || read.bytesRead > bytes.byteLength - offset)
				return null;
			offset += read.bytesRead;
		}
		const extra = new Uint8Array(1);
		try {
			const eof = await handle.read(extra, 0, 1, offset);
			if (eof.bytesRead !== 0) return null;
		} finally {
			erase(extra);
		}
		const after = safeFile(await handle.stat(), uid, MAX_RECORD_BYTES);
		if (!after || !sameFile(before, after)) return null;
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		transferred = true;
		return Object.freeze({ identity: after, sequence, bytes, size: bytes.byteLength, sha256, handle });
	} catch {
		return null;
	} finally {
		if (!transferred) {
			erase(bytes);
			await closeHandle(handle);
		}
	}
}

type IdentityOwnerResult =
	| Readonly<{ status: "opened"; owner: Readonly<{ handle: FileHandle; identity: FileIdentity }> }>
	| Readonly<{ status: "mismatch" | "uncertain" }>;

async function readIdentityOwner(path: string, expected: Uint8Array, uid: number): Promise<IdentityOwnerResult> {
	const record = await readOpenRecord(path, 0, uid);
	if (!record) return Object.freeze({ status: "uncertain" as const });
	let same = record.bytes.byteLength === expected.byteLength;
	for (let index = 0; same && index < expected.byteLength; index += 1) same = record.bytes[index] === expected[index];
	erase(record.bytes);
	if (!same) {
		const closed = await closeHandle(record.handle);
		return Object.freeze({ status: closed ? ("mismatch" as const) : ("uncertain" as const) });
	}
	return Object.freeze({
		status: "opened" as const,
		owner: Object.freeze({ handle: record.handle, identity: record.identity }),
	});
}

async function directoryMatches(path: string, handle: FileHandle, expected: DirectoryIdentity): Promise<boolean> {
	try {
		const [pathStats, handleStats, resolved] = await Promise.all([lstat(path), handle.stat(), realpath(path)]);
		return (
			resolved === path &&
			safeDirectory(pathStats, expected.uid) &&
			safeDirectory(handleStats, expected.uid) &&
			pathStats.dev === expected.dev &&
			pathStats.ino === expected.ino &&
			handleStats.dev === expected.dev &&
			handleStats.ino === expected.ino
		);
	} catch {
		return false;
	}
}

async function identityMatches(
	path: string,
	handle: FileHandle,
	expected: FileIdentity,
	uid: number,
): Promise<boolean> {
	try {
		const [pathStats, handleStats] = await Promise.all([lstat(path), handle.stat()]);
		const pathIdentity = safeFile(pathStats, uid, 4096);
		const handleIdentity = safeFile(handleStats, uid, 4096);
		return Boolean(
			pathIdentity && handleIdentity && sameFile(expected, pathIdentity) && sameFile(expected, handleIdentity),
		);
	} catch {
		return false;
	}
}

async function verifyPublishedRecord(
	path: string,
	sequence: number,
	uid: number,
	expectedIdentity: FileIdentity,
	expectedBytes: Uint8Array,
	expectedSha256: string,
): Promise<boolean> {
	const record = await readOpenRecord(path, sequence, uid);
	if (!record) return false;
	let same = false;
	try {
		same =
			sameFile(expectedIdentity, record.identity) &&
			record.sha256 === expectedSha256 &&
			record.bytes.byteLength === expectedBytes.byteLength;
		for (let index = 0; same && index < expectedBytes.byteLength; index += 1)
			same = record.bytes[index] === expectedBytes[index];
	} catch {
		same = false;
	} finally {
		erase(record.bytes);
		if (!(await closeHandle(record.handle))) same = false;
	}
	return same;
}

async function writeIdentity(
	path: string,
	bytes: Uint8Array,
	uid: number,
	directory: FileHandle,
): Promise<"created" | "exists" | "uncertain"> {
	let handle: FileHandle | null = null;
	let opened = false;
	let completed = false;
	try {
		try {
			handle = await open(
				path,
				constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
				FILE_MODE,
			);
			opened = true;
		} catch (error) {
			if (errorCode(error) === "EEXIST") return "exists";
			return "uncertain";
		}
		let offset = 0;
		while (offset < bytes.byteLength) {
			const written = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
			if (
				!Number.isSafeInteger(written.bytesWritten) ||
				written.bytesWritten < 1 ||
				written.bytesWritten > bytes.byteLength - offset
			)
				return "uncertain";
			offset += written.bytesWritten;
		}
		const stats = safeFile(await handle.stat(), uid, 4096);
		if (!stats || stats.size !== bytes.byteLength) return "uncertain";
		await handle.sync();
		if (!(await closeHandle(handle))) {
			handle = null;
			return "uncertain";
		}
		handle = null;
		await directory.sync();
		completed = true;
		return "created";
	} catch {
		return opened ? "uncertain" : "exists";
	} finally {
		if (handle && !(await closeHandle(handle))) completed = false;
		if (opened && !completed) {
			// Preserve the write-once identity evidence on every uncertain path.
		}
	}
}

function identityBytes(value: Readonly<DurableObservationIdentity>): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(
			Object.freeze({ version: 1, generation: value.generation, hostId: value.hostId, sessionId: value.sessionId }),
		),
	);
}

function recordName(sequence: number): string {
	return `${String(sequence).padStart(20, "0")}.b11-observation`;
}

function pageOwner(records: readonly OpenRecord[], active: Set<object>, token: object) {
	let promise: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	return Object.freeze({
		close(): Promise<Readonly<{ status: "closed" | "error" }>> {
			if (promise) return promise;
			promise = (async () => {
				let closed = true;
				for (const record of records) if (!(await closeHandle(record.handle))) closed = false;
				active.delete(token);
				return Object.freeze({ status: closed ? ("closed" as const) : ("error" as const) });
			})();
			return promise;
		},
	});
}

class NodeObservationBackend {
	private closed = false;
	private poisoned = false;
	private recoveryDone = false;
	private expectedCursor: number | null = null;
	private nextSequence: number;
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	private readonly activePages = new Set<object>();
	private readonly publicationBytes = new WeakSet<object>();

	constructor(
		private readonly path: string,
		private readonly uid: number,
		private readonly directory: FileHandle,
		private readonly directoryIdentity: DirectoryIdentity,
		private readonly identityHandle: FileHandle,
		private readonly identityIdentity: FileIdentity,
		private readonly sequences: readonly number[],
	) {
		this.nextSequence = sequences.length + 1;
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const running = this.tail.then(operation, operation);
		this.tail = running.then(
			() => undefined,
			() => undefined,
		);
		return running;
	}

	private async storageMatches(): Promise<boolean> {
		return (
			(await directoryMatches(this.path, this.directory, this.directoryIdentity)) &&
			(await identityMatches(join(this.path, IDENTITY_FILE), this.identityHandle, this.identityIdentity, this.uid))
		);
	}

	private errorPublish(
		state: ObservationState,
		observationId: unknown,
		sequence: number,
		size: unknown,
		sha256: unknown,
	): Readonly<Record<string, unknown>> {
		return Object.freeze({
			status: "error",
			state,
			observationId: typeof observationId === "string" ? observationId : "",
			sequence,
			size: typeof size === "number" && Number.isSafeInteger(size) ? size : 0,
			sha256: typeof sha256 === "string" ? sha256 : "",
		});
	}

	recoverPage(raw: unknown): Promise<unknown> {
		return this.enqueue(async () => {
			if (this.closed || this.poisoned || this.recoveryDone || this.activePages.size !== 0)
				return Object.freeze({ status: "error" });
			const input = exact(raw, PAGE_REQUEST_KEYS);
			const cursor = input?.cursor?.value;
			const maxCount = input?.maxCount?.value;
			const maxBytes = input?.maxBytes?.value;
			if (
				(cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) ||
				cursor !== this.expectedCursor ||
				!Number.isSafeInteger(maxCount) ||
				maxCount < 1 ||
				maxCount > MAX_PAGE_COUNT ||
				!Number.isSafeInteger(maxBytes) ||
				maxBytes < 1 ||
				maxBytes > MAX_PAGE_BYTES
			)
				return Object.freeze({ status: "error" });
			if (!(await this.storageMatches())) {
				this.poisoned = true;
				return Object.freeze({ status: "error" });
			}
			const start = cursor === null ? 0 : cursor;
			const opened: OpenRecord[] = [];
			let bytes = 0;
			for (let index = start; index < this.sequences.length && opened.length < maxCount; index += 1) {
				const sequence = this.sequences[index];
				const record = await readOpenRecord(join(this.path, recordName(sequence)), sequence, this.uid);
				if (!record) {
					for (const acquired of opened) {
						erase(acquired.bytes);
						await closeHandle(acquired.handle);
					}
					this.poisoned = true;
					return Object.freeze({ status: "error" });
				}
				if (bytes + record.size > maxBytes) {
					erase(record.bytes);
					const closed = await closeHandle(record.handle);
					if (opened.length === 0 || !closed) {
						for (const acquired of opened) {
							erase(acquired.bytes);
							await closeHandle(acquired.handle);
						}
						this.poisoned = true;
						return Object.freeze({ status: "error" });
					}
					break;
				}
				opened.push(record);
				bytes += record.size;
			}
			const last = opened.at(-1)?.sequence ?? cursor;
			const more = typeof last === "number" && last < this.sequences.length;
			const nextCursor = more ? last : null;
			if (!more) this.recoveryDone = true;
			else this.expectedCursor = nextCursor;
			const token = Object.freeze({});
			this.activePages.add(token);
			const owner = pageOwner(opened, this.activePages, token);
			const entries = Object.freeze(
				opened.map(({ sequence, bytes: recordBytes, size, sha256 }) =>
					Object.freeze({ sequence, bytes: recordBytes, size, sha256 }),
				),
			);
			return Object.freeze({ status: "page", entries, nextCursor, owner });
		});
	}

	private publish(raw: unknown, state: ObservationState): Promise<unknown> {
		const discovered = descriptors(raw)?.bytes?.value;
		let bytes: Uint8Array | null = null;
		if (ownedBytes(discovered) && !this.publicationBytes.has(discovered)) {
			this.publicationBytes.add(discovered);
			bytes = discovered;
		}
		return this.enqueue(async () => {
			const input = exact(raw, PUBLISH_KEYS);
			const observationId = input?.observationId?.value;
			const sha256 = input?.sha256?.value;
			const size = input?.size?.value;
			const requestedState = input?.state?.value;
			const sequence = this.nextSequence;
			const expectedState: ObservationState = sequence % 2 === 1 ? "pending" : "applied";
			try {
				if (
					!bytes ||
					this.closed ||
					this.poisoned ||
					!this.recoveryDone ||
					this.activePages.size !== 0 ||
					requestedState !== state ||
					state !== expectedState ||
					!isValidDigest(observationId) ||
					!isValidDigest(sha256) ||
					!Number.isSafeInteger(size) ||
					size !== bytes.byteLength ||
					size < 1 ||
					size > MAX_RECORD_BYTES ||
					createHash("sha256").update(bytes).digest("hex") !== sha256 ||
					sequence > MAX_RECORDS
				)
					return this.errorPublish(state, observationId, sequence, size, sha256);
				if (!(await this.storageMatches())) {
					this.poisoned = true;
					return this.errorPublish(state, observationId, sequence, size, sha256);
				}
				const finalPath = join(this.path, recordName(sequence));
				let writer: FileHandle | null = null;
				let opened = false;
				let durable = false;
				try {
					writer = await open(
						finalPath,
						constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
						FILE_MODE,
					);
					opened = true;
					let offset = 0;
					while (offset < bytes.byteLength) {
						const written = await writer.write(bytes, offset, bytes.byteLength - offset, offset);
						if (
							!Number.isSafeInteger(written.bytesWritten) ||
							written.bytesWritten < 1 ||
							written.bytesWritten > bytes.byteLength - offset
						)
							throw new Error("write failed");
						offset += written.bytesWritten;
					}
					const writtenIdentity = safeFile(await writer.stat(), this.uid, MAX_RECORD_BYTES);
					if (!writtenIdentity || writtenIdentity.size !== bytes.byteLength) throw new Error("identity failed");
					await writer.sync();
					if (!(await closeHandle(writer))) {
						writer = null;
						throw new Error("close failed");
					}
					writer = null;
					if (!(await verifyPublishedRecord(finalPath, sequence, this.uid, writtenIdentity, bytes, sha256)))
						throw new Error("verify failed");
					await this.directory.sync();
					if (!(await directoryMatches(this.path, this.directory, this.directoryIdentity)))
						throw new Error("directory changed");
					durable = true;
				} catch {
					this.poisoned = true;
				} finally {
					if (writer && !(await closeHandle(writer))) this.poisoned = true;
					if (opened && !durable) {
						try {
							await this.directory.sync();
						} catch {
							this.poisoned = true;
						}
					}
				}
				if (!durable) return this.errorPublish(state, observationId, sequence, size, sha256);
				this.nextSequence += 1;
				return Object.freeze({ status: "persisted", state, observationId, sequence, size, sha256 });
			} catch {
				this.poisoned = true;
				return this.errorPublish(state, observationId, sequence, size, sha256);
			} finally {
				erase(bytes);
			}
		});
	}

	capability(): NodeDurableObservationBackendCapability {
		return Object.freeze({
			recoverPage: (raw: unknown) => this.recoverPage(raw),
			publishPending: (raw: unknown) => this.publish(raw, "pending"),
			publishApplied: (raw: unknown) => this.publish(raw, "applied"),
			close: () => this.close(),
		});
	}

	close(): Promise<Readonly<{ status: "closed" | "error" }>> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = this.enqueue(async () => {
			let certain = this.activePages.size === 0;
			if (!(await closeHandle(this.identityHandle))) certain = false;
			if (!(await closeHandle(this.directory))) certain = false;
			return Object.freeze({ status: certain ? ("closed" as const) : ("error" as const) });
		});
		return this.closePromise;
	}
}

export async function createNodeDurableObservationBackend(
	raw: unknown,
): Promise<CreateNodeDurableObservationBackendResult> {
	const input = exact(raw, INPUT_KEYS);
	const directoryPath = input?.directoryPath?.value;
	const durableIdentity = identity(input?.identity?.value);
	const uid = currentUid();
	if (
		typeof directoryPath !== "string" ||
		directoryPath.length < 2 ||
		directoryPath.length > MAX_DIRECTORY_PATH ||
		directoryPath.includes("\0") ||
		!isAbsolute(directoryPath) ||
		durableIdentity === null ||
		uid === null
	)
		return failure("INPUT_INVALID");
	let directory: FileHandle | null = null;
	let identityOwner: Readonly<{ handle: FileHandle; identity: FileIdentity }> | null = null;
	const fail = async (code: BackendErrorCode): Promise<CreateNodeDurableObservationBackendResult> => {
		let closed = true;
		if (identityOwner && !(await closeHandle(identityOwner.handle))) closed = false;
		identityOwner = null;
		if (!(await closeHandle(directory))) closed = false;
		directory = null;
		return failure(closed ? code : "IO_UNCERTAIN");
	};
	try {
		try {
			await mkdir(directoryPath, { mode: DIRECTORY_MODE });
		} catch (error) {
			if (errorCode(error) !== "EEXIST") return failure("IO_UNCERTAIN");
		}
		const pathStats = await lstat(directoryPath);
		if (!safeDirectory(pathStats, uid) || (await realpath(directoryPath)) !== directoryPath)
			return failure("DIRECTORY_UNSAFE");
		directory = await open(directoryPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const directoryStats = await directory.stat();
		if (
			!safeDirectory(directoryStats, uid) ||
			directoryStats.dev !== pathStats.dev ||
			directoryStats.ino !== pathStats.ino
		)
			return await fail("DIRECTORY_UNSAFE");
		const directoryIdentity = Object.freeze({ dev: pathStats.dev, ino: pathStats.ino, uid });
		const encodedIdentity = identityBytes(durableIdentity);
		try {
			const outcome = await writeIdentity(join(directoryPath, IDENTITY_FILE), encodedIdentity, uid, directory);
			if (outcome === "uncertain") return await fail("IO_UNCERTAIN");
			const openedIdentity = await readIdentityOwner(join(directoryPath, IDENTITY_FILE), encodedIdentity, uid);
			if (openedIdentity.status !== "opened")
				return await fail(
					openedIdentity.status === "mismatch" && outcome === "exists" ? "IDENTITY_MISMATCH" : "IO_UNCERTAIN",
				);
			identityOwner = openedIdentity.owner;
		} finally {
			erase(encodedIdentity);
		}
		if (!(await directoryMatches(directoryPath, directory, directoryIdentity))) return await fail("DIRECTORY_UNSAFE");
		const entries: Dirent[] = await readdir(directoryPath, { withFileTypes: true });
		if (!(await directoryMatches(directoryPath, directory, directoryIdentity))) return await fail("DIRECTORY_UNSAFE");
		const sequences: number[] = [];
		let identityEntries = 0;
		for (const entry of entries) {
			if (entry.name === IDENTITY_FILE && entry.isFile()) {
				identityEntries += 1;
				continue;
			}
			const matched = RECORD_RE.exec(entry.name);
			if (!matched || !entry.isFile()) return await fail("DIRECTORY_UNSAFE");
			const sequence = Number(matched[1]);
			if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence > MAX_RECORDS)
				return await fail("DIRECTORY_UNSAFE");
			sequences.push(sequence);
		}
		if (identityEntries !== 1 || sequences.length > MAX_RECORDS) return await fail("DIRECTORY_UNSAFE");
		sequences.sort((left, right) => left - right);
		if (sequences.some((sequence, index) => sequence !== index + 1)) return await fail("DIRECTORY_UNSAFE");
		if (!identityOwner) return await fail("IO_UNCERTAIN");
		const backend = new NodeObservationBackend(
			directoryPath,
			uid,
			directory,
			directoryIdentity,
			identityOwner.handle,
			identityOwner.identity,
			Object.freeze(sequences),
		);
		directory = null;
		identityOwner = null;
		return Object.freeze({ ok: true as const, backend: backend.capability() });
	} catch {
		return await fail("IO_UNCERTAIN");
	}
}
