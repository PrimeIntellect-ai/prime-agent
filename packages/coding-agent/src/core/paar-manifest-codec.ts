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
// Error Codes — fixed set, runtime-frozen, no raw values/paths attached
// ===========================================================================

export const PAAR_ERRORS: Readonly<Record<string, string>> = Object.freeze({
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

export type PaarErrorCode = string;

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

function nfc(s: string): string {
	return s.normalize("NFC");
}

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

// ===========================================================================
// Descriptor-based snapshots — no `in`, no direct Proxy reads
//
// Given an unknown value and a set of expected own-data property names,
// extracts every property via its descriptor `.value` accessor, verifying
// the value is not undefined.  Returns the snapshot as a fresh object.
// This prevents Proxy getter traps and subclass hallucinated properties.
// ===========================================================================

function snapshotOwnData(value: unknown, expectedKeys: ReadonlySet<string>): PaarResult<Record<string, unknown>> {
	if (typeof value !== "object" || value === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	// Own-property verification — reject non-plain prototypes
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(value);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}
	if (proto !== null && proto !== Object.prototype) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
	}

	let descs: PropertyDescriptorMap;
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

	// Check accessors/nonenumerable/undefined and extract values via .value
	const result: Record<string, unknown> = Object.create(null);
	for (const key of ownKeys) {
		const desc = descs[key];
		if (desc.get !== undefined || desc.set !== undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		if (!desc.enumerable) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		// Use desc.value directly — never `value[key]` (avoids Proxy getter)
		if (desc.value === undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		}
		if (!expectedKeys.has(key)) {
			return { ok: false as const, error: { code: PAAR_ERRORS.EXTRA_MANIFEST_FIELD } };
		}
		result[key] = desc.value;
	}

	// Check all expected keys present
	for (const key of expectedKeys) {
		if (!(key in result)) {
			return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
		}
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
// Deep freeze
// ===========================================================================

function deepFreeze<T>(obj: T): Readonly<T> {
	if (obj === null || typeof obj !== "object") return obj;
	// Skip TypedArrays, ArrayBuffers, and DataViews
	if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return obj as unknown as Readonly<T>;
	const names = Object.getOwnPropertyNames(obj);
	for (const name of names) {
		const val = (obj as Record<string, unknown>)[name];
		if (val !== null && typeof val === "object") deepFreeze(val);
	}
	return Object.freeze(obj);
}

// ===========================================================================
// Freeze a PaarResult<T> — freezes both success and error containers
// ===========================================================================

function freezeResult<T>(r: PaarResult<T>): PaarResult<T> {
	if (r.ok) {
		const v = r.value;
		if (typeof v === "object" && v !== null) deepFreeze(v);
		return Object.freeze({ ok: true as const, value: v }) as PaarResult<T>;
	}
	return Object.freeze({ ok: false as const, error: Object.freeze({ code: r.error.code }) }) as PaarResult<T>;
}

// ===========================================================================
// Strict-copy a file entry, snapshot via descriptors, no `in`/`value[key]`
// ===========================================================================

function strictCopyFileEntry(raw: unknown, seen: Set<object>): PaarResult<PaarFileEntry> {
	if (typeof raw !== "object" || raw === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
	}

	// Alias check
	const aliasErr = rejectAliases(raw, seen);
	if (aliasErr) return { ok: false as const, error: { code: aliasErr } };

	const expected = new Set(["path", "size", "mode", "sha256", "offset"]);
	const snap = snapshotOwnData(raw, expected);
	if (!snap.ok) return snap;

	const s = snap.value;

	// Validate path
	const pathCheck = checkFilePath(s.path);
	if (pathCheck) return { ok: false as const, error: { code: pathCheck } };

	// Validate mode (numeric 0o644 or 0o755)
	if (typeof s.mode !== "number" || !Number.isSafeInteger(s.mode)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
	}
	if (s.mode !== 0o644 && s.mode !== 0o755) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
	}

	// Validate size
	if (!isNonNegativeSafeInt(s.size)) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };
	if ((s.size as number) > MAX_FILE_SIZE)
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };

	// Validate sha256
	if (typeof s.sha256 !== "string" || !isHex64(s.sha256))
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_HASH } };

	// Validate offset
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

	// Top-level input must be a plain object or null-prototype object
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

	// Snapshot top-level input via descriptors (no `in`/direct Proxy reads)
	const inputDescs = Object.getOwnPropertyDescriptors(input);
	const inputKeys = Object.getOwnPropertyNames(input);
	const inputSymbols = Object.getOwnPropertySymbols(input);
	if (inputSymbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };

	const allowedInput = new Set(["sourceCommit", "target", "daemonProtocolVersion", "daemonSchemaRevision", "files"]);

	// Use descriptor `.value` to read — rejects getter traps
	const inp: Record<string, unknown> = Object.create(null);
	for (const key of inputKeys) {
		if (!allowedInput.has(key)) return { ok: false as const, error: { code: PAAR_ERRORS.EXTRA_MANIFEST_FIELD } };
		const desc = inputDescs[key];
		if (desc.get !== undefined || desc.set !== undefined)
			return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		if (!desc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		if (desc.value === undefined) return { ok: false as const, error: { code: PAAR_ERRORS.INPUT_NOT_PLAIN } };
		inp[key] = desc.value;
	}
	// Check all required keys present in the fresh snapshot
	if (!("sourceCommit" in inp)) return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
	if (!("target" in inp)) return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
	if (!("daemonProtocolVersion" in inp))
		return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
	if (!("daemonSchemaRevision" in inp))
		return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
	if (!("files" in inp)) return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };

	// sourceCommit
	if (typeof inp.sourceCommit !== "string" || !isHex40(inp.sourceCommit)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_SOURCE_COMMIT } };
	}

	// target
	if (inp.target !== "linux-x64" && inp.target !== "linux-arm64") {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_TARGET } };
	}

	// daemonProtocolVersion
	if (!isPositiveSafeInt(inp.daemonProtocolVersion)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION } };
	}

	// daemonSchemaRevision
	if (!isNonNegativeSafeInt(inp.daemonSchemaRevision)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION } };
	}

	// files array — check via own-data (not `in`)
	const rawFiles = inp.files;
	if (!Array.isArray(rawFiles)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	if (rawFiles.length === 0) return { ok: false as const, error: { code: PAAR_ERRORS.FILES_EMPTY } };
	if (rawFiles.length > MAX_FILES) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	for (let i = 0; i < rawFiles.length; i++) {
		if (!(i in rawFiles)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}

	// Check the array object itself has no extra own properties, symbols, non-plain prototype
	const arrProto = Object.getPrototypeOf(rawFiles);
	if (arrProto !== null && arrProto !== Array.prototype) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	const arrDescs = Object.getOwnPropertyDescriptors(rawFiles);
	const arrOwnKeys = Object.getOwnPropertyNames(rawFiles);
	const arrSymbols = Object.getOwnPropertySymbols(rawFiles);
	if (arrSymbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	for (const key of arrOwnKeys) {
		if (key === "length") continue;
		// Reject any non-index own key (extra property on the array object)
		if (!/^[0-9]+$/.test(key)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		const desc = arrDescs[key];
		if (desc.get !== undefined || desc.set !== undefined)
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		if (!desc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		if (desc.value === undefined) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}

	// Strict-copy each file entry
	const entries: PaarFileEntry[] = [];
	const pathSet = new Set<string>();

	for (let i = 0; i < rawFiles.length; i++) {
		// Access by indexed subscript (not rawFiles[i] due to Proxy)
		const idxDesc = Object.getOwnPropertyDescriptor(rawFiles, String(i));
		if (!idxDesc) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		if (idxDesc.get !== undefined || idxDesc.set !== undefined) {
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
		}
		const rawEntry = idxDesc.value;
		const feResult = strictCopyFileEntry(rawEntry, seen);
		if (!feResult.ok) return feResult;
		const fe = feResult.value;
		seen.add(fe);

		// NFC check
		const nfcPath = nfc(fe.path);
		if (nfcPath !== fe.path) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_PATH } };

		// Duplicate path check
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

	// filesDigest
	const filesDigestStr = encodeFilesArray(entries);
	const filesDigest = createHash("sha256").update(filesDigestStr, "utf-8").digest("hex");

	// Protocol info
	const protocol: PaarProtocolInfo = Object.freeze({
		name: REMOTE_HOST_PROTOCOL_NAME,
		version: REMOTE_HOST_PROTOCOL_VERSION,
		daemonProtocolVersion: inp.daemonProtocolVersion as number,
		daemonSchemaRevision: inp.daemonSchemaRevision as number,
	});

	// buildId
	const buildIdStr = `{"sourceCommit":${jsonStr(inp.sourceCommit as string)},"target":${jsonStr(inp.target as string)},"protocol":${encodeProtocolJson(protocol)},"filesDigest":${jsonStr(filesDigest)}}`;
	const buildId = createHash("sha256").update(buildIdStr, "utf-8").digest("hex");

	// Build manifest
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

	// Encode to canonical JSON
	const manifestJson = encodeManifestJson(manifest);
	const manifestBytes = utf8Encode(manifestJson);
	if (manifestBytes.length > MAX_MANIFEST_BYTES) {
		manifestBytes.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TOO_LARGE } };
	}

	// Build header
	const headerSize = HEADER_PREFIX + manifestBytes.length;
	const header = new Uint8Array(headerSize);
	header[0] = MAGIC0;
	header[1] = MAGIC1;
	header[2] = MAGIC2;
	header[3] = MAGIC3;
	header[4] = MAGIC4;
	header[5] = (manifestBytes.length >> 24) & 0xff;
	header[6] = (manifestBytes.length >> 16) & 0xff;
	header[7] = (manifestBytes.length >> 8) & 0xff;
	header[8] = manifestBytes.length & 0xff;
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
	// Fixed-map hostile byte views: a Proxy/subclass that throws while being
	// read must not be misclassified as INVALID_UTF8 (that code is reserved
	// for genuine byte content that fails UTF-8 validation).
	let inputOk = false;
	try {
		inputOk = bytes instanceof Uint8Array && Number.isSafeInteger(bytes.length) && bytes.length >= 0;
	} catch {
		inputOk = false;
	}
	if (!inputOk) {
		return Object.freeze({
			ok: false as const,
			error: Object.freeze({ code: PAAR_ERRORS.INVALID_INPUT }),
		}) as PaarResult<PaarDecodeResult>;
	}
	try {
		return freezeResult(decodePaarManifestHeaderImpl(bytes, totalArchiveSize));
	} catch {
		// Hostile Proxy/subclass traps threw during decode — fixed-map, do not
		// misclassify as INVALID_UTF8.
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

	// must at least have magic + length
	if (bytes.length < HEADER_PREFIX) {
		return { ok: false as const, error: { code: PAAR_ERRORS.SHORT_HEADER } };
	}

	// magic
	if (
		bytes[0] !== MAGIC0 ||
		bytes[1] !== MAGIC1 ||
		bytes[2] !== MAGIC2 ||
		bytes[3] !== MAGIC3 ||
		bytes[4] !== MAGIC4
	) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_MAGIC } };
	}

	// manifest length via DataView
	const manifestLen = readUint32BE(bytes, 5);
	if (manifestLen > MAX_MANIFEST_BYTES) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TOO_LARGE } };
	}

	const headerSize = HEADER_PREFIX + manifestLen;
	if (bytes.length < headerSize) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TRUNCATED } };
	}

	// Extract manifest bytes (subarray — does not copy)
	const manifestSlice = bytes.subarray(HEADER_PREFIX, HEADER_PREFIX + manifestLen);

	// Validate UTF-8 with fatal TextDecoder
	const manifestStr = utf8Decode(manifestSlice);
	if (manifestStr === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}

	// Verify no replacement chars: roundtrip must produce same bytes
	const reencoded = utf8Encode(manifestStr);
	if (reencoded.length !== manifestSlice.length) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}
	for (let i = 0; i < manifestSlice.length; i++) {
		if (manifestSlice[i] !== reencoded[i]) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
		}
	}

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestStr);
	} catch {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_JSON } };
	}

	// Must be a plain object — reject class instances, Proxy, etc.
	// snapshotOwnData does this check and returns INPUT_NOT_PLAIN for bad ones
	const manifestObjResult = snapshotOwnData(
		parsed,
		new Set(["format", "version", "target", "sourceCommit", "protocol", "filesDigest", "buildId", "files"]),
	);
	if (!manifestObjResult.ok) {
		reencoded.fill(0);
		return manifestObjResult;
	}
	const mobj = manifestObjResult.value;

	// Validate format
	if (mobj.format !== "prime-agent-artifact") {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
	}

	// Version
	if (mobj.version !== 1) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_VERSION } };
	}

	// Target
	if (mobj.target !== "linux-x64" && mobj.target !== "linux-arm64") {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_TARGET } };
	}

	// sourceCommit
	if (typeof mobj.sourceCommit !== "string" || !isHex40(mobj.sourceCommit)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_SOURCE_COMMIT } };
	}

	// Protocol
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

	// filesDigest / buildId format
	if (typeof mobj.filesDigest !== "string" || !isHex64(mobj.filesDigest)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES_DIGEST } };
	}
	if (typeof mobj.buildId !== "string" || !isHex64(mobj.buildId)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_BUILD_ID } };
	}

	// Files array
	const rawFiles = mobj.files;
	if (!Array.isArray(rawFiles)) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	if (rawFiles.length === 0) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.FILES_EMPTY } };
	}
	if (rawFiles.length > MAX_FILES) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	for (let i = 0; i < rawFiles.length; i++) {
		if (!(i in rawFiles)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
	}

	// Check array prototype/own-properties
	const arrProto = Object.getPrototypeOf(rawFiles);
	if (arrProto !== null && arrProto !== Array.prototype) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	const arrDescs = Object.getOwnPropertyDescriptors(rawFiles);
	const arrOwnKeys = Object.getOwnPropertyNames(rawFiles);
	const arrSymbols = Object.getOwnPropertySymbols(rawFiles);
	if (arrSymbols.length > 0) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}
	for (const key of arrOwnKeys) {
		if (key === "length") continue;
		if (!/^[0-9]+$/.test(key)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
		const desc = arrDescs[key];
		if (desc.get !== undefined || desc.set !== undefined) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
		if (!desc.enumerable) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
		if (desc.value === undefined) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
	}

	// Parse each file entry via descriptor snapshots
	const parsedFiles: PaarFileEntry[] = [];
	const pathSet = new Set<string>();

	for (let i = 0; i < rawFiles.length; i++) {
		const idxDesc = Object.getOwnPropertyDescriptor(rawFiles, String(i));
		if (!idxDesc) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
		}
		if (idxDesc.get !== undefined || idxDesc.set !== undefined) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
		}

		const feResult = snapshotOwnData(idxDesc.value, new Set(["path", "size", "mode", "sha256", "offset"]));
		if (!feResult.ok) {
			reencoded.fill(0);
			return feResult;
		}
		const fe = feResult.value;

		// Validate path
		const pathCheck = checkFilePath(fe.path);
		if (pathCheck) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: pathCheck } };
		}

		// Validate mode
		if (typeof fe.mode !== "number" || !Number.isSafeInteger(fe.mode)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
		}
		if (fe.mode !== 0o644 && fe.mode !== 0o755) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
		}

		// Validate size
		if (!isNonNegativeSafeInt(fe.size) || (fe.size as number) > MAX_FILE_SIZE) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };
		}

		// Validate sha256
		if (typeof fe.sha256 !== "string" || !isHex64(fe.sha256)) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_HASH } };
		}

		// Validate offset
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

	// UTF-8 byte order
	for (let i = 1; i < parsedFiles.length; i++) {
		const bufA = Buffer.from(parsedFiles[i - 1].path, "utf-8");
		const bufB = Buffer.from(parsedFiles[i].path, "utf-8");
		if (Buffer.compare(bufA, bufB) >= 0) {
			reencoded.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.FILES_UNSORTED } };
		}
	}

	// Offsets contiguous from 0
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

	// totalArchiveSize == headerSize + payloadSize
	if (totalArchiveSize !== headerSize + payloadSize) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH } };
	}

	// Recompute filesDigest
	const computedFDStr = encodeFilesArray(parsedFiles);
	const computedFD = createHash("sha256").update(computedFDStr, "utf-8").digest("hex");
	if (computedFD !== mobj.filesDigest) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.FILES_DIGEST_MISMATCH } };
	}

	// Protocol info for buildId
	const protocolInfo: PaarProtocolInfo = Object.freeze({
		name: REMOTE_HOST_PROTOCOL_NAME,
		version: REMOTE_HOST_PROTOCOL_VERSION,
		daemonProtocolVersion: proto.daemonProtocolVersion as number,
		daemonSchemaRevision: proto.daemonSchemaRevision as number,
	});

	// Recompute buildId
	const computedBIDStr = `{"sourceCommit":${jsonStr(mobj.sourceCommit as string)},"target":${jsonStr(mobj.target as string)},"protocol":${encodeProtocolJson(protocolInfo)},"filesDigest":${jsonStr(computedFD)}}`;
	const computedBID = createHash("sha256").update(computedBIDStr, "utf-8").digest("hex");
	if (computedBID !== mobj.buildId) {
		reencoded.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.BUILD_ID_MISMATCH } };
	}

	// Build fresh manifest
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

	// Canonical encoding check — raw manifest bytes must constant-time equal canonical re-encoding
	// This catches whitespace, key reorder, duplicate keys, escaped equivalents, -0, trailing bytes, etc.
	const reCanon = utf8Encode(encodeManifestJson(freshManifest));
	if (reCanon.length !== manifestSlice.length) {
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

	// Freeze the result DTOs
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
