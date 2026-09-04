import { createHash, type Hash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import process from "node:process";

const MIN_ARCHIVE_BYTES = 1;
const MAX_ARCHIVE_BYTES = 96 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const MAX_PATH_BYTES = 4096;
const FILE_MODE = 0o600n;
const MODE_MASK = 0o7777n;
const FIELD_NAME = "file";
const FILE_NAME = "prime-agent-runtime.tar.gz";
const CRLF = "\r\n";

export type ArchiveUploadCode =
	| "INPUT_INVALID"
	| "OPEN_FAILED"
	| "FILE_UNSAFE"
	| "READ_FAILED"
	| "DIGEST_MISMATCH"
	| "FILE_CHANGED"
	| "RNG_FAILED"
	| "ALREADY_USED"
	| "CANCELLED"
	| "CLEANUP_UNCERTAIN";

export type ArchiveUploadFailure = Readonly<{ ok: false; code: ArchiveUploadCode }>;
export type ArchiveUploadCompletion = Readonly<{ ok: true }> | ArchiveUploadFailure;
export type ArchiveUploadCloseResult = Readonly<{ ok: true }> | Readonly<{ ok: false; code: "CLEANUP_UNCERTAIN" }>;

export interface ArchiveUploadBody {
	readonly contentType: string;
	readonly contentLength: number;
	readonly stream: ReadableStream<Uint8Array<ArrayBuffer>>;
	readonly completion: Promise<ArchiveUploadCompletion>;
	cancelAndSettle(): Promise<ArchiveUploadCompletion>;
	retryCleanup(): Promise<ArchiveUploadCloseResult>;
}

export interface PreparedArchiveUpload {
	take(): Readonly<{ ok: true; value: ArchiveUploadBody }> | ArchiveUploadFailure;
	close(): Promise<ArchiveUploadCloseResult>;
}

interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly uid: bigint;
	readonly nlink: bigint;
	readonly mode: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}

interface UploadState {
	fd: FileHandle | undefined;
	readonly identity: FileIdentity;
	readonly expectedSize: number;
	readonly expectedDigest: string;
	readonly prefix: Uint8Array<ArrayBuffer>;
	readonly suffix: Uint8Array<ArrayBuffer>;
	readonly contentType: string;
	readonly contentLength: number;
	offset: number;
	phase: "prefix" | "file" | "suffix" | "done";
	taken: boolean;
	cancelRequested: boolean;
	controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
	activePull: Promise<void> | undefined;
	finalizing: Promise<ArchiveUploadCompletion> | undefined;
	resolveCompletion: (value: ArchiveUploadCompletion) => void;
	readonly completion: Promise<ArchiveUploadCompletion>;
	settled: ArchiveUploadCompletion | undefined;
	readonly hasher: Hash;
}

function failure(code: ArchiveUploadCode): ArchiveUploadFailure {
	return Object.freeze({ ok: false, code });
}

function closeFailure(): Readonly<{ ok: false; code: "CLEANUP_UNCERTAIN" }> {
	return Object.freeze({ ok: false, code: "CLEANUP_UNCERTAIN" });
}

function closeSuccess(): Readonly<{ ok: true }> {
	return Object.freeze({ ok: true });
}

function completionSuccess(): Readonly<{ ok: true }> {
	return Object.freeze({ ok: true });
}

function validPath(value: string): boolean {
	if (value.length < 2 || value.length > MAX_PATH_BYTES || !value.startsWith("/")) return false;
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x1f || unit === 0x7f) return false;
		if (unit <= 0x7f) bytes += 1;
		else if (unit <= 0x7ff) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return false;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return false;
			bytes += 4;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
		else bytes += 3;
		if (bytes > MAX_PATH_BYTES) return false;
	}
	return true;
}

function validSize(value: number): boolean {
	return Number.isSafeInteger(value) && value >= MIN_ARCHIVE_BYTES && value <= MAX_ARCHIVE_BYTES;
}

function validDigest(value: string): boolean {
	return /^[0-9a-f]{64}$/.test(value);
}

function readIdentity(value: BigIntStats): FileIdentity | undefined {
	if (
		typeof value.dev !== "bigint" ||
		typeof value.ino !== "bigint" ||
		typeof value.uid !== "bigint" ||
		typeof value.nlink !== "bigint" ||
		typeof value.mode !== "bigint" ||
		typeof value.size !== "bigint" ||
		typeof value.mtimeNs !== "bigint" ||
		typeof value.ctimeNs !== "bigint"
	) {
		return undefined;
	}
	return Object.freeze({
		dev: value.dev,
		ino: value.ino,
		uid: value.uid,
		nlink: value.nlink,
		mode: value.mode,
		size: value.size,
		mtimeNs: value.mtimeNs,
		ctimeNs: value.ctimeNs,
	});
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.uid === right.uid &&
		left.nlink === right.nlink &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function identitySafe(value: FileIdentity, expectedSize: number, uid: number): boolean {
	return (
		value.dev >= 0n &&
		value.ino > 0n &&
		value.uid === BigInt(uid) &&
		value.nlink === 1n &&
		(value.mode & MODE_MASK) === FILE_MODE &&
		value.size === BigInt(expectedSize) &&
		value.mtimeNs >= 0n &&
		value.ctimeNs >= 0n
	);
}

async function statIdentity(fd: FileHandle): Promise<FileIdentity | undefined> {
	try {
		const value = await fd.stat({ bigint: true });
		if (!value.isFile()) return undefined;
		return readIdentity(value);
	} catch {
		return undefined;
	}
}

async function closeFd(state: { fd: FileHandle | undefined }): Promise<ArchiveUploadCloseResult> {
	const fd = state.fd;
	if (fd === undefined) return closeSuccess();
	try {
		await fd.close();
		state.fd = undefined;
		return closeSuccess();
	} catch {
		return closeFailure();
	}
}

async function hashExact(fd: FileHandle, expectedSize: number): Promise<string | undefined> {
	const hasher = createHash("sha256");
	let offset = 0;
	try {
		while (offset < expectedSize) {
			const wanted = Math.min(CHUNK_BYTES, expectedSize - offset);
			const buffer = new Uint8Array(new ArrayBuffer(wanted));
			const result = await fd.read(buffer, 0, wanted, offset);
			if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0 || result.bytesRead > wanted)
				return undefined;
			hasher.update(buffer.subarray(0, result.bytesRead));
			offset += result.bytesRead;
		}
		const extra = new Uint8Array(new ArrayBuffer(1));
		const tail = await fd.read(extra, 0, 1, expectedSize);
		if (tail.bytesRead !== 0) return undefined;
		return hasher.digest("hex");
	} catch {
		return undefined;
	}
}

function randomBoundary(): string | undefined {
	try {
		const bytes = new Uint8Array(new ArrayBuffer(24));
		globalThis.crypto.getRandomValues(bytes);
		let value = "prime-agent-";
		for (let index = 0; index < bytes.byteLength; index += 1) value += bytes[index].toString(16).padStart(2, "0");
		return value;
	} catch {
		return undefined;
	}
}

function encode(value: string): Uint8Array<ArrayBuffer> {
	const raw = new TextEncoder().encode(value);
	const copy = new Uint8Array(new ArrayBuffer(raw.byteLength));
	copy.set(raw);
	return copy;
}

async function finishFailure(state: UploadState, code: ArchiveUploadCode): Promise<ArchiveUploadCompletion> {
	if (state.settled !== undefined) return state.settled;
	if (state.finalizing !== undefined) return state.finalizing;
	const operation = (async (): Promise<ArchiveUploadCompletion> => {
		const closed = await closeFd(state);
		const result = closed.ok ? failure(code) : failure("CLEANUP_UNCERTAIN");
		state.phase = "done";
		state.settled = result;
		state.resolveCompletion(result);
		return result;
	})();
	state.finalizing = operation;
	return operation;
}

async function pullFile(
	state: UploadState,
	controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>,
): Promise<void> {
	if (state.cancelRequested) {
		const result = await finishFailure(state, "CANCELLED");
		controller.error(new Error(result.ok ? "CANCELLED" : result.code));
		return;
	}
	const fd = state.fd;
	if (fd === undefined) {
		const result = await finishFailure(state, "FILE_CHANGED");
		controller.error(new Error(result.ok ? "FILE_CHANGED" : result.code));
		return;
	}
	const wanted = Math.min(CHUNK_BYTES, state.expectedSize - state.offset);
	const buffer = new Uint8Array(new ArrayBuffer(wanted));
	let bytesRead: number;
	try {
		const read = await fd.read(buffer, 0, wanted, state.offset);
		bytesRead = read.bytesRead;
	} catch {
		const result = await finishFailure(state, "READ_FAILED");
		controller.error(new Error(result.ok ? "READ_FAILED" : result.code));
		return;
	}
	if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0 || bytesRead > wanted) {
		const result = await finishFailure(state, "READ_FAILED");
		controller.error(new Error(result.ok ? "READ_FAILED" : result.code));
		return;
	}
	const chunk = new Uint8Array(new ArrayBuffer(bytesRead));
	chunk.set(buffer.subarray(0, bytesRead));
	state.hasher.update(chunk);
	state.offset += bytesRead;
	if (state.cancelRequested) {
		const result = await finishFailure(state, "CANCELLED");
		controller.error(new Error(result.ok ? "CANCELLED" : result.code));
		return;
	}
	if (state.offset < state.expectedSize) {
		controller.enqueue(chunk);
		return;
	}

	let code: ArchiveUploadCode | undefined;
	try {
		const extra = new Uint8Array(new ArrayBuffer(1));
		const tail = await fd.read(extra, 0, 1, state.expectedSize);
		if (tail.bytesRead !== 0) code = "FILE_CHANGED";
	} catch {
		code = "READ_FAILED";
	}
	const current = code === undefined ? await statIdentity(fd) : undefined;
	if (code === undefined && (current === undefined || !sameIdentity(state.identity, current))) code = "FILE_CHANGED";
	let digest: string | undefined;
	if (code === undefined) {
		try {
			digest = state.hasher.digest("hex");
		} catch {
			code = "READ_FAILED";
		}
	}
	if (code === undefined && digest !== state.expectedDigest) code = "DIGEST_MISMATCH";
	if (code !== undefined) {
		const result = await finishFailure(state, code);
		controller.error(new Error(result.ok ? code : result.code));
		return;
	}
	const closed = await closeFd(state);
	if (!closed.ok) {
		const result = await finishFailure(state, "CLEANUP_UNCERTAIN");
		controller.error(new Error(result.ok ? "CLEANUP_UNCERTAIN" : result.code));
		return;
	}
	if (state.cancelRequested) {
		const result = await finishFailure(state, "CANCELLED");
		controller.error(new Error(result.ok ? "CANCELLED" : result.code));
		return;
	}
	controller.enqueue(chunk);
	state.phase = "suffix";
}

function buildBody(state: UploadState): ArchiveUploadBody {
	const stream = new ReadableStream<Uint8Array<ArrayBuffer>>(
		{
			start(controller): void {
				state.controller = controller;
			},
			pull(controller): Promise<void> {
				const operation = (async (): Promise<void> => {
					try {
						if (state.cancelRequested || (state.settled !== undefined && !state.settled.ok)) {
							const result = await finishFailure(state, "CANCELLED");
							controller.error(new Error(result.ok ? "CANCELLED" : result.code));
							return;
						}
						if (state.phase === "prefix") {
							controller.enqueue(state.prefix);
							state.phase = "file";
							return;
						}
						if (state.phase === "file") {
							await pullFile(state, controller);
							return;
						}
						if (state.phase === "suffix") {
							if (state.cancelRequested || state.settled !== undefined) {
								const result = await finishFailure(state, "CANCELLED");
								controller.error(new Error(result.ok ? "CANCELLED" : result.code));
								return;
							}
							controller.enqueue(state.suffix);
							controller.close();
							state.phase = "done";
							const result = completionSuccess();
							state.settled = result;
							state.resolveCompletion(result);
							return;
						}
						controller.close();
					} catch {
						const result = await finishFailure(state, state.cancelRequested ? "CANCELLED" : "READ_FAILED");
						try {
							controller.error(new Error(result.ok ? "READ_FAILED" : result.code));
						} catch {
							// The fixed completion result is authoritative.
						}
					}
				})();
				state.activePull = operation;
				return operation.finally(() => {
					if (state.activePull === operation) state.activePull = undefined;
				});
			},
			async cancel(): Promise<void> {
				state.cancelRequested = true;
				const active = state.activePull;
				if (active !== undefined) {
					try {
						await active;
					} catch {
						// The fixed completion result carries the failure.
					}
				}
				await finishFailure(state, "CANCELLED");
			},
		},
		{ highWaterMark: 0 },
	);

	const body: ArchiveUploadBody = Object.freeze({
		contentType: state.contentType,
		contentLength: state.contentLength,
		stream,
		completion: state.completion,
		async cancelAndSettle(): Promise<ArchiveUploadCompletion> {
			state.cancelRequested = true;
			const controller = state.controller;
			if (controller !== undefined && state.phase !== "done") {
				try {
					controller.error(new Error("CANCELLED"));
				} catch {
					// A closed stream is settled below.
				}
			}
			const active = state.activePull;
			if (active !== undefined) {
				try {
					await active;
				} catch {
					// The fixed completion result carries the failure.
				}
			}
			return finishFailure(state, "CANCELLED");
		},
		async retryCleanup(): Promise<ArchiveUploadCloseResult> {
			return closeFd(state);
		},
	});
	return body;
}

class PreparedArchiveUploadImpl implements PreparedArchiveUpload {
	readonly #state: UploadState;

	constructor(state: UploadState) {
		this.#state = state;
		Object.freeze(this);
	}

	take(): Readonly<{ ok: true; value: ArchiveUploadBody }> | ArchiveUploadFailure {
		if (this.#state.taken || this.#state.phase === "done") return failure("ALREADY_USED");
		this.#state.taken = true;
		return Object.freeze({ ok: true, value: buildBody(this.#state) });
	}

	async close(): Promise<ArchiveUploadCloseResult> {
		this.#state.cancelRequested = true;
		const controller = this.#state.controller;
		if (controller !== undefined && this.#state.phase !== "done") {
			try {
				controller.error(new Error("CANCELLED"));
			} catch {
				// The fixed cleanup result is authoritative.
			}
		}
		const active = this.#state.activePull;
		if (active !== undefined) {
			try {
				await active;
			} catch {
				// The fixed cleanup result is authoritative.
			}
		}
		const result = await finishFailure(this.#state, "CANCELLED");
		return result.ok || result.code !== "CLEANUP_UNCERTAIN" ? closeSuccess() : closeFailure();
	}
}

export async function prepareArchiveUpload(
	path: string,
	expectedSize: number,
	expectedDigest: string,
): Promise<Readonly<{ ok: true; value: PreparedArchiveUpload }> | ArchiveUploadFailure> {
	if (typeof path !== "string" || !validPath(path) || !validSize(expectedSize) || !validDigest(expectedDigest)) {
		return failure("INPUT_INVALID");
	}
	if (typeof process.getuid !== "function") return failure("FILE_UNSAFE");
	const noFollow = constants.O_NOFOLLOW;
	if (!Number.isSafeInteger(noFollow) || noFollow <= 0) return failure("FILE_UNSAFE");
	let uid: number;
	try {
		uid = process.getuid();
	} catch {
		return failure("FILE_UNSAFE");
	}
	if (!Number.isSafeInteger(uid) || uid < 0) return failure("FILE_UNSAFE");
	let fd: FileHandle;
	try {
		fd = await open(path, constants.O_RDONLY | noFollow);
	} catch {
		return failure("OPEN_FAILED");
	}
	const closeOwner = { fd };
	const initial = await statIdentity(fd);
	if (initial === undefined || !identitySafe(initial, expectedSize, uid)) {
		const closed = await closeFd(closeOwner);
		return closed.ok ? failure("FILE_UNSAFE") : failure("CLEANUP_UNCERTAIN");
	}
	const digest = await hashExact(fd, expectedSize);
	if (digest === undefined) {
		const closed = await closeFd(closeOwner);
		return closed.ok ? failure("READ_FAILED") : failure("CLEANUP_UNCERTAIN");
	}
	const afterHash = await statIdentity(fd);
	if (afterHash === undefined || !sameIdentity(initial, afterHash)) {
		const closed = await closeFd(closeOwner);
		return closed.ok ? failure("FILE_CHANGED") : failure("CLEANUP_UNCERTAIN");
	}
	if (digest !== expectedDigest) {
		const closed = await closeFd(closeOwner);
		return closed.ok ? failure("DIGEST_MISMATCH") : failure("CLEANUP_UNCERTAIN");
	}
	const boundary = randomBoundary();
	if (boundary === undefined) {
		const closed = await closeFd(closeOwner);
		return closed.ok ? failure("RNG_FAILED") : failure("CLEANUP_UNCERTAIN");
	}
	const prefix = encode(
		`--${boundary}${CRLF}Content-Disposition: form-data; name="${FIELD_NAME}"; filename="${FILE_NAME}"${CRLF}Content-Type: application/gzip${CRLF}${CRLF}`,
	);
	const suffix = encode(`${CRLF}--${boundary}--${CRLF}`);
	const contentLength = prefix.byteLength + expectedSize + suffix.byteLength;
	if (!Number.isSafeInteger(contentLength)) {
		const closed = await closeFd(closeOwner);
		return closed.ok ? failure("INPUT_INVALID") : failure("CLEANUP_UNCERTAIN");
	}
	let resolveCompletion: (value: ArchiveUploadCompletion) => void = () => {};
	const completion = new Promise<ArchiveUploadCompletion>((resolve) => {
		resolveCompletion = resolve;
	});
	const state: UploadState = {
		fd,
		identity: initial,
		expectedSize,
		expectedDigest,
		prefix,
		suffix,
		contentType: `multipart/form-data; boundary=${boundary}`,
		contentLength,
		offset: 0,
		phase: "prefix",
		taken: false,
		cancelRequested: false,
		controller: undefined,
		activePull: undefined,
		finalizing: undefined,
		resolveCompletion,
		completion,
		settled: undefined,
		hasher: createHash("sha256"),
	};
	return Object.freeze({ ok: true, value: new PreparedArchiveUploadImpl(state) });
}
