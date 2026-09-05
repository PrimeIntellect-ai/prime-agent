import { createHash, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { decodePaarManifestHeader, type PaarManifest, type PaarTarget } from "./paar-manifest-codec.js";

const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_READ_BYTES = 64 * 1024;
const TOTAL_TIMEOUT_MS = 60_000;
const CLOSE_TIMEOUT_MS = 5_000;
const SAFE_MODE_TYPE_MASK = 0o170000n;
const SAFE_MODE_REGULAR = 0o100000n;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HANDLE_KEYS = new Set(["close", "read", "stat"]);
const EXPECTATION_KEYS = new Set([
	"archiveSha256",
	"archiveSize",
	"buildId",
	"daemonProtocolVersion",
	"daemonSchemaRevision",
	"protocolName",
	"protocolVersion",
	"sourceCommit",
	"target",
]);
const STAT_KEYS = new Set(["ctimeNs", "dev", "gid", "ino", "mode", "mtimeNs", "nlink", "size", "uid"]);
const STATUS_KEYS = new Set(["status"]);
const BYTES_KEYS = new Set(["bytes", "status"]);

export type PaarVerificationFailure =
	| "ARCHIVE_HASH_MISMATCH"
	| "ARCHIVE_SIZE_MISMATCH"
	| "CLOSE_UNCONFIRMED"
	| "FILE_HASH_MISMATCH"
	| "HANDLE_INVALID"
	| "IDENTITY_CHANGED"
	| "IDENTITY_INVALID"
	| "MANIFEST_INVALID"
	| "READ_FAILED"
	| "TIMEOUT"
	| "UNEXPECTED_EOF"
	| "UNEXPECTED_TRAILING_BYTES";

export interface PaarArchiveIdentity {
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

export interface PaarVerificationExpectation {
	readonly archiveSize: number;
	readonly archiveSha256: string;
	readonly buildId: string;
	readonly sourceCommit: string;
	readonly target: PaarTarget;
	readonly protocolName: string;
	readonly protocolVersion: number;
	readonly daemonProtocolVersion: number;
	readonly daemonSchemaRevision: number;
}

export type PaarVerificationResult =
	| Readonly<{
			ok: true;
			value: Readonly<{
				archiveSha256: string;
				identity: PaarArchiveIdentity;
				manifest: PaarManifest;
			}>;
	  }>
	| Readonly<{ ok: false; error: Readonly<{ code: PaarVerificationFailure }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundHandle = Readonly<{
	close: () => unknown;
	read: (offset: number, maxBytes: number) => unknown;
	stat: () => unknown;
}>;
type HandleDiscovery =
	| Readonly<{ close: (() => unknown) | null; handle: BoundHandle | null }>
	| Readonly<{ close: null; handle: null }>;
type Observed =
	| Readonly<{ kind: "fulfilled"; value: unknown }>
	| Readonly<{ kind: "invalid" | "rejected" | "threw" | "timeout" }>;
type ReadResult = Readonly<{ status: "bytes"; bytes: Uint8Array }> | Readonly<{ status: "eof" | "error" }>;

function failure(code: PaarVerificationFailure): PaarVerificationResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function success(manifest: PaarManifest, archiveSha256: string, identity: PaarArchiveIdentity): PaarVerificationResult {
	return Object.freeze({
		ok: true as const,
		value: Object.freeze({ archiveSha256, identity, manifest }),
	});
}

function exact(value: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof value !== "object" || value === null) return null;
	try {
		if (types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(value).length !== 0) return null;
		const names = Object.getOwnPropertyNames(value);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return descriptors;
	} catch {
		return null;
	}
}

function bound(raw: object, descriptor: PropertyDescriptor): ((...args: readonly unknown[]) => unknown) | null {
	if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
	try {
		if (types.isProxy(descriptor.value)) return null;
		const callable = descriptor.value as (...args: readonly unknown[]) => unknown;
		return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
	} catch {
		return null;
	}
}

function discoverHandle(raw: unknown): HandleDiscovery {
	if (typeof raw !== "object" || raw === null) return Object.freeze({ close: null, handle: null });
	let close: (() => unknown) | null = null;
	try {
		if (types.isProxy(raw)) return Object.freeze({ close, handle: null });
		const closeDescriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (closeDescriptor) {
			const callable = bound(raw, closeDescriptor);
			if (callable) close = (): unknown => callable();
		}
		if (Object.getPrototypeOf(raw) !== Object.prototype || !close || !Object.isFrozen(raw)) {
			return Object.freeze({ close, handle: null });
		}
		const descriptors = exact(raw, HANDLE_KEYS);
		if (!descriptors) return Object.freeze({ close, handle: null });
		const stat = bound(raw, descriptors.stat);
		const read = bound(raw, descriptors.read);
		if (!stat || !read) return Object.freeze({ close, handle: null });
		return Object.freeze({
			close,
			handle: Object.freeze({
				close,
				read: (offset: number, maxBytes: number): unknown => read(offset, maxBytes),
				stat: (): unknown => stat(),
			}),
		});
	} catch {
		return Object.freeze({ close, handle: null });
	}
}

function safeInteger(value: unknown, positive = false): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && (positive ? value > 0 : value >= 0);
}

function snapshotExpectation(raw: unknown): PaarVerificationExpectation | null {
	const descriptors = exact(raw, EXPECTATION_KEYS);
	if (!descriptors) return null;
	const archiveSize = descriptors.archiveSize.value;
	const archiveSha256 = descriptors.archiveSha256.value;
	const buildId = descriptors.buildId.value;
	const sourceCommit = descriptors.sourceCommit.value;
	const target = descriptors.target.value;
	const protocolName = descriptors.protocolName.value;
	const protocolVersion = descriptors.protocolVersion.value;
	const daemonProtocolVersion = descriptors.daemonProtocolVersion.value;
	const daemonSchemaRevision = descriptors.daemonSchemaRevision.value;
	if (!safeInteger(archiveSize, true) || archiveSize > MAX_ARCHIVE_BYTES) return null;
	if (typeof archiveSha256 !== "string" || !HEX64.test(archiveSha256)) return null;
	if (typeof buildId !== "string" || !HEX64.test(buildId)) return null;
	if (typeof sourceCommit !== "string" || !HEX40.test(sourceCommit)) return null;
	if (target !== "linux-x64" && target !== "linux-arm64") return null;
	if (typeof protocolName !== "string" || protocolName.length < 1 || protocolName.length > 128) return null;
	if (!safeInteger(protocolVersion) || !safeInteger(daemonProtocolVersion, true) || !safeInteger(daemonSchemaRevision))
		return null;
	return Object.freeze({
		archiveSha256,
		archiveSize,
		buildId,
		daemonProtocolVersion,
		daemonSchemaRevision,
		protocolName,
		protocolVersion,
		sourceCommit,
		target,
	});
}

function snapshotStat(raw: unknown): PaarArchiveIdentity | null {
	const descriptors = exact(raw, STAT_KEYS);
	if (!descriptors || !Object.isFrozen(raw)) return null;
	const result: Record<string, bigint> = Object.create(null) as Record<string, bigint>;
	for (const key of STAT_KEYS) {
		const value = descriptors[key].value;
		if (typeof value !== "bigint" || value < 0n) return null;
		result[key] = value;
	}
	if ((result.mode & SAFE_MODE_TYPE_MASK) !== SAFE_MODE_REGULAR || result.nlink !== 1n) return null;
	return Object.freeze({
		ctimeNs: result.ctimeNs,
		dev: result.dev,
		gid: result.gid,
		ino: result.ino,
		mode: result.mode,
		mtimeNs: result.mtimeNs,
		nlink: result.nlink,
		size: result.size,
		uid: result.uid,
	});
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

function genuineBytes(raw: unknown): Uint8Array | null {
	try {
		if (typeof raw !== "object" || raw === null || types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Uint8Array.prototype) return null;
		if (!bufferGetter || !byteOffsetGetter || !byteLengthGetter) return null;
		const backing = bufferGetter.call(raw) as unknown;
		const offset = byteOffsetGetter.call(raw) as unknown;
		const length = byteLengthGetter.call(raw) as unknown;
		if (typeof backing !== "object" || backing === null || Object.getPrototypeOf(backing) !== ArrayBuffer.prototype)
			return null;
		if (typeof offset !== "number" || offset !== 0 || typeof length !== "number" || length < 1) return null;
		if (length !== (backing as ArrayBuffer).byteLength) return null;
		ArrayBuffer.prototype.slice.call(backing, 0, 0);
		return raw as Uint8Array;
	} catch {
		return null;
	}
}

function erase(bytes: Uint8Array | null): void {
	if (!bytes) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		// Only exact owned views reach this helper.
	}
}

function eraseDiscoverableBytes(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) return;
	try {
		if (types.isProxy(raw)) return;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "bytes");
		if (!descriptor || !("value" in descriptor)) return;
		erase(genuineBytes(descriptor.value));
	} catch {
		// A hostile result is not safely owned.
	}
}

function snapshotRead(raw: unknown, requested: number): ReadResult | null {
	const statusDescriptors = exact(raw, STATUS_KEYS);
	if (statusDescriptors) {
		const status = statusDescriptors.status.value;
		if ((status === "eof" || status === "error") && Object.isFrozen(raw)) return Object.freeze({ status });
		return null;
	}
	const bytesDescriptors = exact(raw, BYTES_KEYS);
	if (!bytesDescriptors || bytesDescriptors.status.value !== "bytes" || !Object.isFrozen(raw)) return null;
	const bytes = genuineBytes(bytesDescriptors.bytes.value);
	if (!bytes || bytes.byteLength > requested || bytes.byteLength > MAX_READ_BYTES) return null;
	return Object.freeze({ status: "bytes" as const, bytes });
}

function exactNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observeCall(
	call: () => unknown,
	timeoutMs: number,
	lateCleanup?: (value: unknown) => void,
): Promise<Observed> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ kind: "threw" as const }));
	}
	if (!exactNativePromise(raw)) return Promise.resolve(Object.freeze({ kind: "invalid" as const }));
	return new Promise<Observed>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ kind: "timeout" as const }));
		}, timeoutMs);
		try {
			Promise.prototype.then.call(
				raw,
				(value: unknown) => {
					if (settled) {
						lateCleanup?.(value);
						return;
					}
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ kind: "fulfilled" as const, value }));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ kind: "rejected" as const }));
				},
			);
		} catch {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				resolve(Object.freeze({ kind: "invalid" as const }));
			}
		}
	});
}

function identityEqual(left: PaarArchiveIdentity, right: PaarArchiveIdentity): boolean {
	return (
		left.ctimeNs === right.ctimeNs &&
		left.dev === right.dev &&
		left.gid === right.gid &&
		left.ino === right.ino &&
		left.mode === right.mode &&
		left.mtimeNs === right.mtimeNs &&
		left.nlink === right.nlink &&
		left.size === right.size &&
		left.uid === right.uid
	);
}

function hashesEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "ascii");
	const rightBytes = Buffer.from(right, "ascii");
	return timingSafeEqual(leftBytes, rightBytes);
}

async function verifyOwned(
	handle: BoundHandle,
	expectation: PaarVerificationExpectation,
	deadline: number,
): Promise<PaarVerificationResult> {
	const remaining = (): number => Math.max(0, deadline - Date.now());
	const invoke = (call: () => unknown, lateCleanup?: (value: unknown) => void): Promise<Observed> => {
		const time = remaining();
		return time > 0
			? observeCall(call, time, lateCleanup)
			: Promise.resolve(Object.freeze({ kind: "timeout" as const }));
	};
	const read = async (offset: number, requested: number): Promise<ReadResult | PaarVerificationResult> => {
		const observed = await invoke(() => handle.read(offset, requested), eraseDiscoverableBytes);
		if (observed.kind === "timeout") return failure("TIMEOUT");
		if (observed.kind !== "fulfilled") return failure("READ_FAILED");
		const result = snapshotRead(observed.value, requested);
		if (!result) {
			eraseDiscoverableBytes(observed.value);
			return failure("READ_FAILED");
		}
		return result;
	};
	const stat = async (): Promise<PaarArchiveIdentity | PaarVerificationResult> => {
		const observed = await invoke(() => handle.stat());
		if (observed.kind === "timeout") return failure("TIMEOUT");
		if (observed.kind !== "fulfilled") return failure("IDENTITY_INVALID");
		return snapshotStat(observed.value) ?? failure("IDENTITY_INVALID");
	};
	const isFailure = (
		value: ReadResult | PaarArchiveIdentity | PaarVerificationResult,
	): value is PaarVerificationResult => "ok" in value;

	const initial = await stat();
	if (isFailure(initial)) return initial;
	if (initial.size !== BigInt(expectation.archiveSize)) return failure("ARCHIVE_SIZE_MISMATCH");

	const archiveHash = createHash("sha256");
	const prefix = new Uint8Array(9);
	let prefixOffset = 0;
	while (prefixOffset < prefix.byteLength) {
		const outcome = await read(prefixOffset, prefix.byteLength - prefixOffset);
		if (isFailure(outcome)) {
			erase(prefix);
			return outcome;
		}
		if (outcome.status !== "bytes") {
			erase(prefix);
			return failure("UNEXPECTED_EOF");
		}
		archiveHash.update(outcome.bytes);
		prefix.set(outcome.bytes, prefixOffset);
		prefixOffset += outcome.bytes.byteLength;
		erase(outcome.bytes);
	}
	if (prefix[0] !== 0x50 || prefix[1] !== 0x41 || prefix[2] !== 0x41 || prefix[3] !== 0x52 || prefix[4] !== 0x31) {
		erase(prefix);
		return failure("MANIFEST_INVALID");
	}
	const manifestBytes = new DataView(prefix.buffer).getUint32(5, false);
	const headerSize = 9 + manifestBytes;
	if (manifestBytes > MAX_MANIFEST_BYTES || headerSize > expectation.archiveSize) {
		erase(prefix);
		return failure("MANIFEST_INVALID");
	}
	const header = new Uint8Array(headerSize);
	header.set(prefix);
	erase(prefix);
	let offset = 9;
	while (offset < headerSize) {
		const requested = Math.min(MAX_READ_BYTES, headerSize - offset);
		const outcome = await read(offset, requested);
		if (isFailure(outcome)) {
			erase(header);
			return outcome;
		}
		if (outcome.status !== "bytes") {
			erase(header);
			return failure("UNEXPECTED_EOF");
		}
		archiveHash.update(outcome.bytes);
		header.set(outcome.bytes, offset);
		offset += outcome.bytes.byteLength;
		erase(outcome.bytes);
	}
	const decoded = decodePaarManifestHeader(header, expectation.archiveSize);
	erase(header);
	if (!decoded.ok) return failure("MANIFEST_INVALID");
	const manifest = decoded.value.manifest;
	if (
		manifest.buildId !== expectation.buildId ||
		manifest.sourceCommit !== expectation.sourceCommit ||
		manifest.target !== expectation.target ||
		manifest.protocol.name !== expectation.protocolName ||
		manifest.protocol.version !== expectation.protocolVersion ||
		manifest.protocol.daemonProtocolVersion !== expectation.daemonProtocolVersion ||
		manifest.protocol.daemonSchemaRevision !== expectation.daemonSchemaRevision
	)
		return failure("MANIFEST_INVALID");

	offset = decoded.value.headerSize;
	for (const file of manifest.files) {
		const fileHash = createHash("sha256");
		let remainingFile = file.size;
		while (remainingFile > 0) {
			const requested = Math.min(MAX_READ_BYTES, remainingFile);
			const outcome = await read(offset, requested);
			if (isFailure(outcome)) return outcome;
			if (outcome.status !== "bytes") return failure("UNEXPECTED_EOF");
			archiveHash.update(outcome.bytes);
			fileHash.update(outcome.bytes);
			offset += outcome.bytes.byteLength;
			remainingFile -= outcome.bytes.byteLength;
			erase(outcome.bytes);
		}
		const digest = fileHash.digest("hex");
		if (!hashesEqual(digest, file.sha256)) return failure("FILE_HASH_MISMATCH");
	}
	if (offset !== expectation.archiveSize) return failure("ARCHIVE_SIZE_MISMATCH");
	const eof = await read(offset, 1);
	if (isFailure(eof)) return eof;
	if (eof.status === "bytes") {
		erase(eof.bytes);
		return failure("UNEXPECTED_TRAILING_BYTES");
	}
	if (eof.status !== "eof") return failure("READ_FAILED");
	const finalIdentity = await stat();
	if (isFailure(finalIdentity)) return finalIdentity;
	if (!identityEqual(initial, finalIdentity)) return failure("IDENTITY_CHANGED");
	const archiveDigest = archiveHash.digest("hex");
	if (!hashesEqual(archiveDigest, expectation.archiveSha256)) return failure("ARCHIVE_HASH_MISMATCH");
	return success(manifest, archiveDigest, finalIdentity);
}

async function finalize(
	close: (() => unknown) | null,
	tentative: PaarVerificationResult,
): Promise<PaarVerificationResult> {
	if (!close) return tentative;
	const observed = await observeCall(close, CLOSE_TIMEOUT_MS);
	if (observed.kind !== "fulfilled") return failure("CLOSE_UNCONFIRMED");
	const descriptors = exact(observed.value, STATUS_KEYS);
	if (!descriptors || !Object.isFrozen(observed.value) || descriptors.status.value !== "closed") {
		return failure("CLOSE_UNCONFIRMED");
	}
	return tentative;
}

export async function verifyPaarArchive(rawHandle: unknown, rawExpectation: unknown): Promise<PaarVerificationResult> {
	const discovered = discoverHandle(rawHandle);
	if (!discovered.handle) return await finalize(discovered.close, failure("HANDLE_INVALID"));
	const expectation = snapshotExpectation(rawExpectation);
	if (!expectation) return await finalize(discovered.close, failure("MANIFEST_INVALID"));
	let tentative: PaarVerificationResult;
	try {
		tentative = await verifyOwned(discovered.handle, expectation, Date.now() + TOTAL_TIMEOUT_MS);
	} catch {
		tentative = failure("READ_FAILED");
	}
	return await finalize(discovered.close, tentative);
}
