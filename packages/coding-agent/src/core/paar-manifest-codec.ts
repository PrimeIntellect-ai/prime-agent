/**
 * PAAR (Prime Agent Artifact) v1 manifest/framing codec.
 *
 * Pure codec — no filesystem, builder, verifier, installer, spawn, or network.
 * Encodes and decodes the PAAR v1 wire framing:
 *
 *   ASCII "PAAR1" (5) + uint32BE manifest byte length + canonical UTF-8 JSON manifest
 *
 * Payload bytes after the manifest are outside this codec's scope.
 *
 * @module
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { REMOTE_HOST_PROTOCOL_NAME, REMOTE_HOST_PROTOCOL_VERSION } from "../modes/daemon/remote-agent-host-protocol.js";

// ===========================================================================
// Constants
// ===========================================================================

const MAGIC0 = 0x50; // P
const MAGIC1 = 0x41; // A
const MAGIC2 = 0x41; // A
const MAGIC3 = 0x52; // R
const MAGIC4 = 0x31; // 1
const MAGIC_BYTES = 5;
const HEADER_PREFIX = MAGIC_BYTES + 4; // magic + uint32BE length

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MiB
const MAX_FILES = 20_000;
const MAX_FILE_SIZE = 256 * 1024 * 1024; // 256 MiB
const MAX_TOTAL_PAYLOAD = 1024 * 1024 * 1024; // 1 GiB
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024; // 1 GiB total
const MAX_PATH_BYTES = 512;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;

// ===========================================================================
// Error Codes — fixed set, runtime-frozen, literal types preserved
// ===========================================================================

export const PAAR_ERRORS = Object.freeze({
	SHORT_HEADER: "SHORT_HEADER",
	BAD_MAGIC: "BAD_MAGIC",
	MANIFEST_TOO_LARGE: "MANIFEST_TOO_LARGE",
	MANIFEST_TRUNCATED: "MANIFEST_TRUNCATED",
	ARCHIVE_TOO_LARGE: "ARCHIVE_TOO_LARGE",
	INVALID_UTF8: "INVALID_UTF8",
	INVALID_JSON: "INVALID_JSON",
	NON_CANONICAL: "NON_CANONICAL",
	BAD_FORMAT: "BAD_FORMAT",
	BAD_VERSION: "BAD_VERSION",
	BAD_TARGET: "BAD_TARGET",
	BAD_SOURCE_COMMIT: "BAD_SOURCE_COMMIT",
	BAD_PROTOCOL: "BAD_PROTOCOL",
	BAD_PROTOCOL_NAME: "BAD_PROTOCOL_NAME",
	BAD_PROTOCOL_VERSION: "BAD_PROTOCOL_VERSION",
	BAD_DAEMON_PROTOCOL_VERSION: "BAD_DAEMON_PROTOCOL_VERSION",
	BAD_DAEMON_SCHEMA_REVISION: "BAD_DAEMON_SCHEMA_REVISION",
	BAD_FILES: "BAD_FILES",
	BAD_FILE_ENTRY: "BAD_FILE_ENTRY",
	MISSING_MANIFEST_FIELD: "MISSING_MANIFEST_FIELD",
	MISSING_FILE_FIELD: "MISSING_FILE_FIELD",
	EXTRA_MANIFEST_FIELD: "EXTRA_MANIFEST_FIELD",
	INVALID_FILE_PATH: "INVALID_FILE_PATH",
	INVALID_FILE_MODE: "INVALID_FILE_MODE",
	INVALID_FILE_SIZE: "INVALID_FILE_SIZE",
	INVALID_FILE_HASH: "INVALID_FILE_HASH",
	INVALID_FILE_OFFSET: "INVALID_FILE_OFFSET",
	FILES_UNSORTED: "FILES_UNSORTED",
	DUPLICATE_FILE_PATH: "DUPLICATE_FILE_PATH",
	PAYLOAD_OVERFLOW: "PAYLOAD_OVERFLOW",
	FILES_DIGEST_MISMATCH: "FILES_DIGEST_MISMATCH",
	BUILD_ID_MISMATCH: "BUILD_ID_MISMATCH",
	TOTAL_ARCHIVE_MISMATCH: "TOTAL_ARCHIVE_MISMATCH",
	BAD_FILES_DIGEST: "BAD_FILES_DIGEST",
	BAD_BUILD_ID: "BAD_BUILD_ID",
	FILES_EMPTY: "FILES_EMPTY",
	CANONICAL_ENCODE_ERROR: "CANONICAL_ENCODE_ERROR",
	INPUT_NOT_PLAIN: "INPUT_NOT_PLAIN",
	PROTO_INVALID_ALIAS: "PROTO_INVALID_ALIAS",
	INVALID_INPUT: "INVALID_INPUT",
});

export type PaarErrorCode = (typeof PAAR_ERRORS)[keyof typeof PAAR_ERRORS];

// ===========================================================================
// Result types
// ===========================================================================

export interface PaarError {
	readonly code: PaarErrorCode;
}

export type PaarResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly error: PaarError };

// ===========================================================================
// Public DTO types — all fields readonly
// ===========================================================================

export type PaarTarget = "linux-x64" | "linux-arm64";

export interface PaarFileEntry {
	readonly path: string;
	readonly size: number;
	readonly mode: number; // 0o644 or 0o755
	readonly sha256: string;
	readonly offset: number;
}

export interface PaarProtocolInfo {
	readonly name: typeof REMOTE_HOST_PROTOCOL_NAME;
	readonly version: typeof REMOTE_HOST_PROTOCOL_VERSION;
	readonly daemonProtocolVersion: number;
	readonly daemonSchemaRevision: number;
}

export interface PaarManifest {
	readonly format: "prime-agent-artifact";
	readonly version: 1;
	readonly target: PaarTarget;
	readonly sourceCommit: string;
	readonly protocol: PaarProtocolInfo;
	readonly filesDigest: string;
	readonly buildId: string;
	readonly files: readonly PaarFileEntry[];
}

export interface PaarEncodeResult {
	readonly manifest: Readonly<PaarManifest>;
	readonly header: Uint8Array;
	readonly payloadSize: number;
	readonly headerSize: number;
	readonly archiveSize: number;
}

export interface PaarDecodeResult {
	readonly manifest: Readonly<PaarManifest>;
	readonly payloadSize: number;
	readonly headerSize: number;
	readonly archiveSize: number;
}

export interface PaarEncodeInput {
	readonly sourceCommit: string;
	readonly target: PaarTarget;
	readonly daemonProtocolVersion: number;
	readonly daemonSchemaRevision: number;
	readonly files: readonly PaarFileEntry[];
}

// ===========================================================================
// Internal helpers
// ===========================================================================

function isHex64(s: string): boolean {
	return HEX64_RE.test(s);
}
function isHex40(s: string): boolean {
	return HEX40_RE.test(s);
}
function isPositiveSafeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
function isNonNegativeSafeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

// ===========================================================================
// File path validation
// ===========================================================================

function isNfc(s: string): boolean {
	try {
		return s.normalize("NFC") === s;
	} catch {
		return false;
	}
}

function hasInvalidPathChar(path: string): boolean {
	for (let i = 0; i < path.length; i++) {
		const cp = path.charCodeAt(i);
		if (cp <= 0x1f) return true;
		if (cp === 0x7f) return true;
		if (cp === 0xfeff) return true;
		if (cp === 0x5c) return true;
		if (cp >= 0xd800 && cp <= 0xdbff) {
			if (i + 1 >= path.length) return true;
			const next = path.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			i += 1;
			continue;
		}
		if (cp >= 0xdc00 && cp <= 0xdfff) return true;
	}
	return false;
}

function byteLengthUtf8(s: string): number {
	let len = 0;
	for (let i = 0; i < s.length; i++) {
		const cp = s.charCodeAt(i);
		if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < s.length) {
			const next = s.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				len += 4;
				i += 1;
				continue;
			}
		}
		if (cp < 0x80) len += 1;
		else if (cp < 0x800) len += 2;
		else if (cp < 0xd800 || cp > 0xdfff) len += 3;
		else len += 3;
	}
	return len;
}

function checkFilePath(path: unknown): PaarErrorCode | undefined {
	if (typeof path !== "string") return PAAR_ERRORS.INVALID_FILE_PATH;
	if (path.length === 0) return PAAR_ERRORS.INVALID_FILE_PATH;
	if (!isNfc(path)) return PAAR_ERRORS.INVALID_FILE_PATH;
	if (path.charCodeAt(0) === 0x2f) return PAAR_ERRORS.INVALID_FILE_PATH;
	if (path.charCodeAt(path.length - 1) === 0x2f) return PAAR_ERRORS.INVALID_FILE_PATH;
	const byteLen = byteLengthUtf8(path);
	if (byteLen > MAX_PATH_BYTES || byteLen < 1) return PAAR_ERRORS.INVALID_FILE_PATH;
	if (hasInvalidPathChar(path)) return PAAR_ERRORS.INVALID_FILE_PATH;
	const segments = path.split("/");
	for (const seg of segments) {
		if (seg.length === 0 || seg === "." || seg === "..") return PAAR_ERRORS.INVALID_FILE_PATH;
		if (seg.startsWith(".prime-agent-staging")) return PAAR_ERRORS.INVALID_FILE_PATH;
	}
	return undefined;
}

// ===========================================================================
// Canonical JSON serialization — fixed key order per schema
// ===========================================================================

function jsonStr(s: string): string {
	return JSON.stringify(s);
}

function encodeFileJson(f: PaarFileEntry): string {
	return `{"path":${jsonStr(f.path)},"size":${f.size},"mode":${f.mode},"sha256":${jsonStr(f.sha256)},"offset":${f.offset}}`;
}

function encodeFilesArray(files: readonly PaarFileEntry[]): string {
	const p: string[] = [];
	for (const f of files) p.push(encodeFileJson(f));
	return `[${p.join(",")}]`;
}

function encodeProtocolJson(p: PaarProtocolInfo): string {
	return `{"name":${jsonStr(p.name)},"version":${p.version},"daemonProtocolVersion":${p.daemonProtocolVersion},"daemonSchemaRevision":${p.daemonSchemaRevision}}`;
}

function encodeManifestJson(m: PaarManifest): string {
	return `{"format":${jsonStr(m.format)},"version":${m.version},"target":${jsonStr(m.target)},"sourceCommit":${jsonStr(m.sourceCommit)},"protocol":${encodeProtocolJson(m.protocol)},"filesDigest":${jsonStr(m.filesDigest)},"buildId":${jsonStr(m.buildId)},"files":${encodeFilesArray(m.files)}}`;
}

// ===========================================================================
// UTF-8 encode/decode that own buffers
// ===========================================================================

function utf8Encode(s: string): Uint8Array {
	return Buffer.from(s, "utf-8");
}

function utf8Decode(bytes: Uint8Array): string | null {
	try {
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}

// ===========================================================================
// DataView uint32BE
// ===========================================================================

function readUint32BE(bytes: Uint8Array, offset: number): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
	return view.getUint32(0, false);
}

function writeUint32BE(header: Uint8Array, offset: number, value: number): void {
	const view = new DataView(header.buffer, header.byteOffset + offset, 4);
	view.setUint32(0, value, false);
}

// ===========================================================================
// Buffer genuineness: exact non-shared Uint8Array with zero byteOffset
// ===========================================================================

function isSharedBuffer(buf: ArrayBuffer): boolean {
	try {
		return !(buf instanceof ArrayBuffer);
	} catch {
		return true;
	}
}

function isGenuineUint8Array(bytes: unknown): bytes is Uint8Array {
	if (bytes === null || typeof bytes !== "object") return false;
	try {
		if (Object.getPrototypeOf(bytes) !== Uint8Array.prototype) return false;
	} catch {
		return false;
	}
	const b = bytes as Uint8Array;
	if (b.byteOffset !== 0) return false;
	if (b.buffer === null || typeof b.buffer !== "object") return false;
	if (isSharedBuffer(b.buffer as ArrayBuffer)) return false;
	if (!Number.isSafeInteger(b.byteLength) || b.byteLength < 0) return false;
	// Reject detached buffer: the backing store must be at least as large as
	// the view claims. Detached buffers report byteLength=0.
	let bufLen: number;
	try {
		bufLen = (b.buffer as ArrayBuffer).byteLength;
	} catch {
		return false;
	}
	if (typeof bufLen !== "number" || !Number.isSafeInteger(bufLen) || bufLen < b.byteLength) {
		return false;
	}
	return true;
}

// ===========================================================================
// Descriptor-based snapshots — no `in`, no direct Proxy reads
// ===========================================================================

function snapshotOwnData(value: unknown, expectedKeys: ReadonlySet<string>): PaarResult<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(value);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	if (proto !== null && proto !== Object.prototype) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	let descs: ReturnType<typeof Object.getOwnPropertyDescriptors>;
	try {
		descs = Object.getOwnPropertyDescriptors(value);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	let ownKeys: string[];
	try {
		ownKeys = Object.getOwnPropertyNames(value);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(value);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	if (symbols.length > 0) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	const result: Record<string, unknown> = Object.create(null);
	for (const key of ownKeys) {
		const desc = descs[key];
		if (desc.get !== undefined || desc.set !== undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		if (!desc.enumerable) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		if (desc.value === undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		if (!expectedKeys.has(key)) {
			return { ok: false as const, error: { code: PAAR_ERRORS.EXTRA_MANIFEST_FIELD } };
		}
		result[key] = desc.value;
	}

	for (const key of expectedKeys) {
		if (result[key] === undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
		}
	}

	return { ok: true as const, value: result };
}

// ===========================================================================
// Snapshot exact array descriptor set: ordinary Array prototype, exact length
// descriptor, indices 0..length-1, no extras/symbols/accessors/undefined.
// ===========================================================================

function snapshotArrayIndices(raw: unknown): PaarResult<unknown[]> {
	if (!Array.isArray(raw)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(raw);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	if (proto !== null && proto !== Array.prototype) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}

	let lenDesc: PropertyDescriptor | undefined;
	try {
		lenDesc = Object.getOwnPropertyDescriptor(raw, "length");
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	if (!lenDesc) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	if (lenDesc.get !== undefined || lenDesc.set !== undefined) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	const rawLen = lenDesc.value;
	if (typeof rawLen !== "number" || !Number.isSafeInteger(rawLen) || rawLen < 0) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	if (rawLen === 0) return { ok: false as const, error: { code: PAAR_ERRORS.FILES_EMPTY } };
	if (rawLen > MAX_FILES) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };

	let descs: ReturnType<typeof Object.getOwnPropertyDescriptors>;
	try {
		descs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	let ownKeys: string[];
	try {
		ownKeys = Object.getOwnPropertyNames(raw);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	let symbols: symbol[];
	try {
		symbols = Object.getOwnPropertySymbols(raw);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	if (symbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };

	// Must have exactly length+1 own names: "length" + indices 0..rawLen-1
	if (ownKeys.length !== rawLen + 1) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };

	const indexSet = new Set<string>();
	for (const key of ownKeys) {
		if (key === "length") continue;
		const num = Number(key);
		if (key !== String(num) || !Number.isSafeInteger(num) || num < 0 || num >= rawLen) {
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
		if (indexSet.has(key)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		indexSet.add(key);
	}
	if (indexSet.size !== rawLen) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };

	const result: unknown[] = [];
	for (let i = 0; i < rawLen; i++) {
		const idxDesc = descs[String(i)];
		if (!idxDesc) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		if (idxDesc.get !== undefined || idxDesc.set !== undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
		if (!idxDesc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		if (idxDesc.value === undefined) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		result.push(idxDesc.value);
	}

	return { ok: true as const, value: result };
}

// ===========================================================================
// Alias detection — verify value does not equal any reference in a set
// ===========================================================================

function rejectAliases(value: unknown, seen: ReadonlySet<object>): PaarErrorCode | undefined {
	if (value !== null && typeof value === "object") {
		if (seen.has(value as object)) return PAAR_ERRORS.PROTO_INVALID_ALIAS;
	}
	return undefined;
}

// ===========================================================================
// Strict-copy a file entry — raw reference added to `seen` BEFORE snapshot
// ===========================================================================

function strictCopyFileEntry(raw: unknown, seen: Set<object>): PaarResult<PaarFileEntry> {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
	}

	const aliasErr = rejectAliases(raw, seen);
	if (aliasErr) return { ok: false as const, error: { code: aliasErr } };
	seen.add(raw);

	const expected = new Set(["path", "size", "mode", "sha256", "offset"]);
	const snap = snapshotOwnData(raw, expected);
	if (!snap.ok) return snap;

	const s = snap.value;

	const pathCheck = checkFilePath(s.path);
	if (pathCheck) return { ok: false as const, error: { code: pathCheck } };

	if (typeof s.mode !== "number" || !Number.isSafeInteger(s.mode)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
	}
	if (s.mode !== 0o644 && s.mode !== 0o755) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
	}

	if (!isNonNegativeSafeInt(s.size)) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };
	if ((s.size as number) > MAX_FILE_SIZE)
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };

	if (typeof s.sha256 !== "string" || !isHex64(s.sha256)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_HASH } };
	}

	if (!isNonNegativeSafeInt(s.offset)) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };

	return {
		ok: true as const,
		value: Object.freeze({
			path: s.path as string,
			size: s.size as number,
			mode: s.mode as number,
			sha256: s.sha256 as string,
			offset: s.offset as number,
		}) as PaarFileEntry,
	};
}

// ===========================================================================
// Deep freeze (skips TypedArray views — they cannot be frozen)
// ===========================================================================

function deepFreeze<T>(obj: T): Readonly<T> {
	if (obj === null || typeof obj !== "object") return obj;
	if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return obj as unknown as Readonly<T>;
	const names = Object.getOwnPropertyNames(obj);
	for (const name of names) {
		const val = (obj as Record<string, unknown>)[name];
		if (val !== null && typeof val === "object") deepFreeze(val);
	}
	return Object.freeze(obj);
}

function freezeResult<T>(r: PaarResult<T>): PaarResult<T> {
	if (r.ok) {
		const v = r.value;
		if (typeof v === "object" && v !== null) deepFreeze(v);
		return Object.freeze({ ok: true as const, value: v }) as PaarResult<T>;
	}
	return Object.freeze({ ok: false as const, error: Object.freeze({ code: r.error.code }) }) as PaarResult<T>;
}

// ===========================================================================
// Public API: encodePaarManifest
// ===========================================================================

export function encodePaarManifest(input: PaarEncodeInput): PaarResult<PaarEncodeResult> {
	try {
		return freezeResult(encodePaarManifestImpl(input));
	} catch {
		return Object.freeze({
			ok: false as const,
			error: Object.freeze({ code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR }),
		}) as PaarResult<PaarEncodeResult>;
	}
}

function encodePaarManifestImpl(input: PaarEncodeInput): PaarResult<PaarEncodeResult> {
	const seen = new Set<object>();

	if (typeof input !== "object" || input === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	let inputProto: object | null;
	try {
		inputProto = Object.getPrototypeOf(input);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	if (inputProto !== null && inputProto !== Object.prototype) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	let inputDescs: PropertyDescriptorMap;
	try {
		inputDescs = Object.getOwnPropertyDescriptors(input);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	let inputKeys: string[];
	try {
		inputKeys = Object.getOwnPropertyNames(input);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	let inputSymbols: symbol[];
	try {
		inputSymbols = Object.getOwnPropertySymbols(input);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	if (inputSymbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };

	const allowedInput = new Set(["sourceCommit", "target", "daemonProtocolVersion", "daemonSchemaRevision", "files"]);

	const inp: Record<string, unknown> = Object.create(null);
	for (const key of inputKeys) {
		if (!allowedInput.has(key)) return { ok: false as const, error: { code: PAAR_ERRORS.EXTRA_MANIFEST_FIELD } };
		const desc = inputDescs[key];
		if (desc.get !== undefined || desc.set !== undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		if (!desc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		if (desc.value === undefined) return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		inp[key] = desc.value;
	}
	if (
		inp.sourceCommit === undefined ||
		inp.target === undefined ||
		inp.daemonProtocolVersion === undefined ||
		inp.daemonSchemaRevision === undefined ||
		inp.files === undefined
	) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
	}

	if (typeof inp.sourceCommit !== "string" || !isHex40(inp.sourceCommit)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_SOURCE_COMMIT } };
	}
	if (inp.target !== "linux-x64" && inp.target !== "linux-arm64") {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_TARGET } };
	}
	if (!isPositiveSafeInt(inp.daemonProtocolVersion)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION } };
	}
	if (!isNonNegativeSafeInt(inp.daemonSchemaRevision)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION } };
	}

	// files array — snapshot exact descriptor set
	const arrResult = snapshotArrayIndices(inp.files);
	if (!arrResult.ok) return arrResult;
	const rawFiles = arrResult.value;

	const entries: PaarFileEntry[] = [];
	const pathSet = new Set<string>();

	for (let i = 0; i < rawFiles.length; i++) {
		const rawEntry = rawFiles[i];
		const feResult = strictCopyFileEntry(rawEntry, seen);
		if (!feResult.ok) return feResult;
		const fe = feResult.value;

		const nfcPath = fe.path.normalize("NFC");
		if (nfcPath !== fe.path) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_PATH } };

		if (pathSet.has(fe.path)) return { ok: false as const, error: { code: PAAR_ERRORS.DUPLICATE_FILE_PATH } };
		pathSet.add(fe.path);

		entries.push(fe);
	}

	// UTF-8 byte order
	for (let i = 1; i < entries.length; i++) {
		const bufA = Buffer.from(entries[i - 1].path, "utf-8");
		const bufB = Buffer.from(entries[i].path, "utf-8");
		if (Buffer.compare(bufA, bufB) >= 0) return { ok: false as const, error: { code: PAAR_ERRORS.FILES_UNSORTED } };
	}

	// Contiguous offsets from 0
	let runningOff = 0;
	for (const f of entries) {
		if (f.offset !== runningOff) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };
		runningOff += f.size;
	}
	const payloadSize = runningOff;
	if (payloadSize > MAX_TOTAL_PAYLOAD) return { ok: false as const, error: { code: PAAR_ERRORS.PAYLOAD_OVERFLOW } };

	const filesDigestStr = encodeFilesArray(entries);
	const filesDigest = createHash("sha256").update(filesDigestStr, "utf-8").digest("hex");

	const protocol: PaarProtocolInfo = Object.freeze({
		name: REMOTE_HOST_PROTOCOL_NAME,
		version: REMOTE_HOST_PROTOCOL_VERSION,
		daemonProtocolVersion: inp.daemonProtocolVersion as number,
		daemonSchemaRevision: inp.daemonSchemaRevision as number,
	});

	const buildIdStr = `{"sourceCommit":${jsonStr(inp.sourceCommit as string)},"target":${jsonStr(inp.target as string)},"protocol":${encodeProtocolJson(protocol)},"filesDigest":${jsonStr(filesDigest)}}`;
	const buildId = createHash("sha256").update(buildIdStr, "utf-8").digest("hex");

	const manifest: PaarManifest = Object.freeze({
		format: "prime-agent-artifact",
		version: 1 as const,
		target: inp.target as PaarTarget,
		sourceCommit: inp.sourceCommit as string,
		protocol,
		filesDigest,
		buildId,
		files: Object.freeze(entries),
	});

	const manifestJson = encodeManifestJson(manifest);
	const manifestBytes = utf8Encode(manifestJson);
	if (manifestBytes.length > MAX_MANIFEST_BYTES) {
		manifestBytes.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TOO_LARGE } };
	}

	const headerSize = HEADER_PREFIX + manifestBytes.length;
	const header = new Uint8Array(headerSize);
	header[0] = MAGIC0;
	header[1] = MAGIC1;
	header[2] = MAGIC2;
	header[3] = MAGIC3;
	header[4] = MAGIC4;
	writeUint32BE(header, 5, manifestBytes.length);
	header.set(manifestBytes, HEADER_PREFIX);
	manifestBytes.fill(0);

	const archiveSize = headerSize + payloadSize;
	if (archiveSize > MAX_ARCHIVE_SIZE) {
		header.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.ARCHIVE_TOO_LARGE } };
	}

	return {
		ok: true as const,
		value: {
			manifest,
			header,
			payloadSize,
			headerSize,
			archiveSize,
		},
	};
}

// ===========================================================================
// Public API: decodePaarManifestHeader
// ===========================================================================

export function decodePaarManifestHeader(bytes: Uint8Array, totalArchiveSize: number): PaarResult<PaarDecodeResult> {
	// Enforce exact non-shared Uint8Array — reject Buffer, subclass, shared
	// array buffer, detached buffer, and non-zero byteOffset views. Any throw
	// from reading the view (hostile Proxy/subclass traps) maps to INVALID_INPUT.
	let genuine = false;
	try {
		genuine = isGenuineUint8Array(bytes);
	} catch {
		genuine = false;
	}
	if (!genuine) {
		return Object.freeze({
			ok: false as const,
			error: Object.freeze({ code: PAAR_ERRORS.INVALID_INPUT }),
		}) as PaarResult<PaarDecodeResult>;
	}
	try {
		return freezeResult(decodePaarManifestHeaderImpl(bytes, totalArchiveSize));
	} catch {
		return Object.freeze({
			ok: false as const,
			error: Object.freeze({ code: PAAR_ERRORS.INVALID_INPUT }),
		}) as PaarResult<PaarDecodeResult>;
	}
}

function decodePaarManifestHeaderImpl(bytes: Uint8Array, totalArchiveSize: number): PaarResult<PaarDecodeResult> {
	// totalArchiveSize must be positive safe int <= 1 GiB
	if (!isPositiveSafeInt(totalArchiveSize) || totalArchiveSize > MAX_ARCHIVE_SIZE) {
		return { ok: false as const, error: { code: PAAR_ERRORS.ARCHIVE_TOO_LARGE } };
	}

	// Claimed total archive must not exceed supplied bytes
	if (bytes.byteLength > totalArchiveSize) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_INPUT } };
	}

	// must at least have magic + length
	if (bytes.byteLength < HEADER_PREFIX) {
		return { ok: false as const, error: { code: PAAR_ERRORS.SHORT_HEADER } };
	}

	if (
		bytes[0] !== MAGIC0 ||
		bytes[1] !== MAGIC1 ||
		bytes[2] !== MAGIC2 ||
		bytes[3] !== MAGIC3 ||
		bytes[4] !== MAGIC4
	) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_MAGIC } };
	}

	const manifestLen = readUint32BE(bytes, 5);
	if (manifestLen > MAX_MANIFEST_BYTES) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TOO_LARGE } };
	}

	const headerSize = HEADER_PREFIX + manifestLen;
	if (bytes.byteLength < headerSize) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TRUNCATED } };
	}

	const manifestSlice = bytes.subarray(HEADER_PREFIX, HEADER_PREFIX + manifestLen);

	const manifestStr = utf8Decode(manifestSlice);
	if (manifestStr === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}

	// Verify no replacement chars: roundtrip must produce same bytes
	const reencoded = utf8Encode(manifestStr);
	if (reencoded.byteLength !== manifestSlice.byteLength) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}
	for (let i = 0; i < manifestSlice.byteLength; i++) {
		if (manifestSlice[i] !== reencoded[i]) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
		}
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestStr);
	} catch {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_JSON } };
	}

	const manifestObjResult = snapshotOwnData(
		parsed,
		new Set(["format", "version", "target", "sourceCommit", "protocol", "filesDigest", "buildId", "files"]),
	);
	if (!manifestObjResult.ok) {
		reencoded.fill(0);
		return manifestObjResult;
	}
	const mobj = manifestObjResult.value;

	if (mobj.format !== "prime-agent-artifact") {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
	}
	if (mobj.version !== 1) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_VERSION } };
	}
	if (mobj.target !== "linux-x64" && mobj.target !== "linux-arm64") {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_TARGET } };
	}
	if (typeof mobj.sourceCommit !== "string" || !isHex40(mobj.sourceCommit)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_SOURCE_COMMIT } };
	}

	const protoResult = snapshotOwnData(
		mobj.protocol,
		new Set(["name", "version", "daemonProtocolVersion", "daemonSchemaRevision"]),
	);
	if (!protoResult.ok) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_PROTOCOL } };
	}
	const proto = protoResult.value;

	if (proto.name !== REMOTE_HOST_PROTOCOL_NAME) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_PROTOCOL_NAME } };
	}
	if (proto.version !== REMOTE_HOST_PROTOCOL_VERSION) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_PROTOCOL_VERSION } };
	}
	if (!isPositiveSafeInt(proto.daemonProtocolVersion)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION } };
	}
	if (!isNonNegativeSafeInt(proto.daemonSchemaRevision)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION } };
	}

	if (typeof mobj.filesDigest !== "string" || !isHex64(mobj.filesDigest)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES_DIGEST } };
	}
	if (typeof mobj.buildId !== "string" || !isHex64(mobj.buildId)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_BUILD_ID } };
	}

	// Files array — snapshot exact descriptor set
	const rawFilesResult = snapshotArrayIndices(mobj.files);
	if (!rawFilesResult.ok) {
		reencoded.fill(0);
		return rawFilesResult;
	}
	const rawFiles = rawFilesResult.value;

	const parsedFiles: PaarFileEntry[] = [];
	const pathSet = new Set<string>();

	for (let i = 0; i < rawFiles.length; i++) {
		const feResult = snapshotOwnData(rawFiles[i], new Set(["path", "size", "mode", "sha256", "offset"]));
		if (!feResult.ok) {
			reencoded.fill(0);
			return feResult;
		}
		const fe = feResult.value;

		const pathCheck = checkFilePath(fe.path);
		if (pathCheck) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: pathCheck } };
		}
		if (typeof fe.mode !== "number" || !Number.isSafeInteger(fe.mode)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
		}
		if (fe.mode !== 0o644 && fe.mode !== 0o755) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
		}
		if (!isNonNegativeSafeInt(fe.size) || (fe.size as number) > MAX_FILE_SIZE) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };
		}
		if (typeof fe.sha256 !== "string" || !isHex64(fe.sha256)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_HASH } };
		}
		if (!isNonNegativeSafeInt(fe.offset)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };
		}

		const p = fe.path as string;
		if (pathSet.has(p)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.DUPLICATE_FILE_PATH } };
		}
		pathSet.add(p);

		parsedFiles.push({
			path: p,
			size: fe.size as number,
			mode: fe.mode as number,
			sha256: fe.sha256 as string,
			offset: fe.offset as number,
		});
	}

	for (let i = 1; i < parsedFiles.length; i++) {
		const bufA = Buffer.from(parsedFiles[i - 1].path, "utf-8");
		const bufB = Buffer.from(parsedFiles[i].path, "utf-8");
		if (Buffer.compare(bufA, bufB) >= 0) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.FILES_UNSORTED } };
		}
	}

	let expectedOff = 0;
	for (const f of parsedFiles) {
		if (f.offset !== expectedOff) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };
		}
		expectedOff += f.size;
	}
	const payloadSize = expectedOff;
	if (payloadSize > MAX_TOTAL_PAYLOAD) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.PAYLOAD_OVERFLOW } };
	}

	if (totalArchiveSize !== headerSize + payloadSize) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH } };
	}

	const computedFDStr = encodeFilesArray(parsedFiles);
	const computedFD = createHash("sha256").update(computedFDStr, "utf-8").digest("hex");
	if (computedFD !== mobj.filesDigest) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.FILES_DIGEST_MISMATCH } };
	}

	const protocolInfo: PaarProtocolInfo = Object.freeze({
		name: REMOTE_HOST_PROTOCOL_NAME,
		version: REMOTE_HOST_PROTOCOL_VERSION,
		daemonProtocolVersion: proto.daemonProtocolVersion as number,
		daemonSchemaRevision: proto.daemonSchemaRevision as number,
	});

	const computedBIDStr = `{"sourceCommit":${jsonStr(mobj.sourceCommit as string)},"target":${jsonStr(mobj.target as string)},"protocol":${encodeProtocolJson(protocolInfo)},"filesDigest":${jsonStr(computedFD)}}`;
	const computedBID = createHash("sha256").update(computedBIDStr, "utf-8").digest("hex");
	if (computedBID !== mobj.buildId) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BUILD_ID_MISMATCH } };
	}

	const freshManifest: PaarManifest = {
		format: "prime-agent-artifact",
		version: 1,
		target: mobj.target as PaarTarget,
		sourceCommit: mobj.sourceCommit as string,
		protocol: protocolInfo,
		filesDigest: computedFD,
		buildId: computedBID,
		files: parsedFiles,
	};

	// Canonical raw-byte equality — catches whitespace, key reorder, duplicate
	// keys, escaped equivalents, -0, case, and trailing bytes.
	const reCanon = utf8Encode(encodeManifestJson(freshManifest));
	if (reCanon.byteLength !== manifestSlice.byteLength) {
		reCanon.fill(0);
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
	}
	try {
		if (!timingSafeEqual(reCanon, manifestSlice as unknown as Buffer)) {
			reCanon.fill(0);
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
		}
	} catch {
		reCanon.fill(0);
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
	}
	reCanon.fill(0);
	reencoded.fill(0);

	const frozenFileEntries = Object.freeze(parsedFiles.map(deepFreeze));
	const frozenManifest = deepFreeze({
		...freshManifest,
		files: frozenFileEntries,
	});

	return {
		ok: true as const,
		value: {
			manifest: frozenManifest,
			payloadSize,
			headerSize,
			archiveSize: totalArchiveSize,
		},
	};
}
