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

// PAAR codec protocol binding constants — mirrors remote-agent-host-protocol.ts
const REMOTE_HOST_PROTOCOL_NAME = "prime-agent.remote-host";
const REMOTE_HOST_PROTOCOL_VERSION = 1;

// ===========================================================================
// Constants
// ===========================================================================

const MAGIC_BYTES = 5;
const MAGIC0 = 0x50; // P
const MAGIC1 = 0x41; // A
const MAGIC2 = 0x41; // A
const MAGIC3 = 0x52; // R
const MAGIC4 = 0x31; // 1
const HEADER_PREFIX = MAGIC_BYTES + 4; // magic + uint32BE length

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024; // 4 MiB
const MAX_FILES = 20_000;
const MAX_FILE_SIZE = 256 * 1024 * 1024; // 256 MiB
const MAX_TOTAL_PAYLOAD = 1024 * 1024 * 1024; // 1 GiB
const MAX_ARCHIVE_SIZE = 1024 * 1024 * 1024; // 1 GiB total (header + payload)
const MAX_PATH_BYTES = 512;
const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX40_RE = /^[0-9a-f]{40}$/;

// ===========================================================================
// Error Codes — fixed set, no raw values/paths attached
// ===========================================================================

export const PAAR_ERRORS = {
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
	MISSING_FILE_FIELD: "MISSING_FILE_FIELD",
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
	EXTRA_MANIFEST_FIELD: "EXTRA_MANIFEST_FIELD",
	MISSING_MANIFEST_FIELD: "MISSING_MANIFEST_FIELD",
	DUPLICATE_KEYS: "DUPLICATE_KEYS",
	BAD_FILES_DIGEST: "BAD_FILES_DIGEST",
	BAD_BUILD_ID: "BAD_BUILD_ID",
	TRAILING_MANIFEST_BYTES: "TRAILING_MANIFEST_BYTES",
	CANONICAL_ENCODE_ERROR: "CANONICAL_ENCODE_ERROR",
	FILES_EMPTY: "FILES_EMPTY",
} as const;

export type PaarErrorCode = (typeof PAAR_ERRORS)[keyof typeof PAAR_ERRORS];

// ===========================================================================
// Result types
// ===========================================================================

export interface PaarError {
	code: PaarErrorCode;
}

export type PaarResult<T> = { ok: true; value: T } | { ok: false; error: PaarError };

// ===========================================================================
// Public types
// ===========================================================================

export type PaarTarget = "linux-x64" | "linux-arm64";

export interface PaarFileEntry {
	path: string;
	size: number;
	mode: number; // 0o644 or 0o755
	sha256: string;
	offset: number;
}

export interface PaarProtocolInfo {
	name: typeof REMOTE_HOST_PROTOCOL_NAME;
	version: typeof REMOTE_HOST_PROTOCOL_VERSION;
	daemonProtocolVersion: number;
	daemonSchemaRevision: number;
}

export interface PaarManifest {
	format: "prime-agent-artifact";
	version: 1;
	target: PaarTarget;
	sourceCommit: string;
	protocol: PaarProtocolInfo;
	filesDigest: string;
	buildId: string;
	files: readonly PaarFileEntry[];
}

export interface PaarEncodeResult {
	manifest: Readonly<PaarManifest>;
	header: Uint8Array;
	payloadSize: number;
	headerSize: number;
	archiveSize: number;
}

export interface PaarDecodeResult {
	manifest: Readonly<PaarManifest>;
	payloadSize: number;
	headerSize: number;
	archiveSize: number;
}

export interface PaarEncodeInput {
	sourceCommit: string;
	target: PaarTarget;
	daemonProtocolVersion: number;
	daemonSchemaRevision: number;
	files: readonly PaarFileEntry[];
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
//
// Rules:
// - exact NFC
// - 1..512 UTF-8 bytes
// - relative POSIX (no leading /)
// - no trailing slash
// - no backslash
// - no NUL or control chars (0x00-0x1F)
// - no DEL (0x7F)
// - no BOM (U+FEFF)
// - no lone surrogates (accept valid surrogate pairs)
// - no empty/dot/dotdot segments
// - no segment starting ".prime-agent-staging"
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
		if (cp <= 0x1f) return true; // NUL and control chars
		if (cp === 0x7f) return true; // DEL
		if (cp === 0xfeff) return true; // BOM
		if (cp === 0x5c) return true; // backslash

		// Reject lone surrogates, accept valid surrogate pairs
		if (cp >= 0xd800 && cp <= 0xdbff) {
			// High surrogate — must be followed by low surrogate
			if (i + 1 >= path.length) return true;
			const next = path.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
			i += 1; // skip low surrogate
			continue;
		}
		if (cp >= 0xdc00 && cp <= 0xdfff) {
			// Lone low surrogate
			return true;
		}
	}
	return false;
}

// Check that a path is valid relative POSIX.
// Returns undefined on success or an error code on failure.
function checkFilePath(path: unknown): PaarErrorCode | undefined {
	if (typeof path !== "string") return PAAR_ERRORS.INVALID_FILE_PATH;
	if (path.length === 0) return PAAR_ERRORS.INVALID_FILE_PATH;

	// Must be NFC
	if (!isNfc(path)) return PAAR_ERRORS.INVALID_FILE_PATH;

	// Must be relative (no leading slash)
	if (path.charCodeAt(0) === 0x2f) return PAAR_ERRORS.INVALID_FILE_PATH;

	// No trailing slash
	if (path.charCodeAt(path.length - 1) === 0x2f) return PAAR_ERRORS.INVALID_FILE_PATH;

	// Check UTF-8 byte length
	const byteLen = byteLengthUtf8(path);
	if (byteLen > MAX_PATH_BYTES) return PAAR_ERRORS.INVALID_FILE_PATH;
	if (byteLen < 1) return PAAR_ERRORS.INVALID_FILE_PATH;

	// Check invalid characters including lone surrogates
	if (hasInvalidPathChar(path)) return PAAR_ERRORS.INVALID_FILE_PATH;

	// Split into segments and validate each
	const segments = path.split("/");
	for (const seg of segments) {
		if (seg.length === 0) return PAAR_ERRORS.INVALID_FILE_PATH;
		if (seg === ".") return PAAR_ERRORS.INVALID_FILE_PATH;
		if (seg === "..") return PAAR_ERRORS.INVALID_FILE_PATH;
		if (seg.startsWith(".prime-agent-staging")) return PAAR_ERRORS.INVALID_FILE_PATH;
	}

	return undefined;
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
		else len += 3; // lone surrogate, counts as 3 in error
	}
	return len;
}

// ===========================================================================
// Canonical JSON serialization
//
// Fixed key order per schema.
// ===========================================================================

// Fixed key order for manifest: format, version, target, sourceCommit, protocol, filesDigest, buildId, files
// Fixed key order for protocol: name, version, daemonProtocolVersion, daemonSchemaRevision
// Fixed key order for file entry: path, size, mode, sha256, offset

function jsonStr(s: string): string {
	return JSON.stringify(s);
}

function encodeFileJson(f: PaarFileEntry): string {
	return `{"path":${jsonStr(f.path)},"size":${f.size},"mode":${f.mode},"sha256":${jsonStr(f.sha256)},"offset":${f.offset}}`;
}

function encodeFilesArrayJson(files: readonly PaarFileEntry[]): string {
	const parts: string[] = [];
	for (const f of files) {
		parts.push(encodeFileJson(f));
	}
	return `[${parts.join(",")}]`;
}

function encodeProtocolJson(p: PaarProtocolInfo): string {
	return `{"name":${jsonStr(p.name)},"version":${p.version},"daemonProtocolVersion":${p.daemonProtocolVersion},"daemonSchemaRevision":${p.daemonSchemaRevision}}`;
}

function encodeManifestJson(m: PaarManifest): string {
	return `{"format":${jsonStr(m.format)},"version":${m.version},"target":${jsonStr(m.target)},"sourceCommit":${jsonStr(m.sourceCommit)},"protocol":${encodeProtocolJson(m.protocol)},"filesDigest":${jsonStr(m.filesDigest)},"buildId":${jsonStr(m.buildId)},"files":${encodeFilesArrayJson(m.files)}}`;
}

// Canonical hash input strings use the same fixed order as the manifest
function filesArrayDigestString(files: readonly PaarFileEntry[]): string {
	return encodeFilesArrayJson(files);
}

function buildIdDigestString(
	sourceCommit: string,
	target: PaarTarget,
	protocol: PaarProtocolInfo,
	filesDigest: string,
): string {
	return `{"sourceCommit":${jsonStr(sourceCommit)},"target":${jsonStr(target)},"protocol":${encodeProtocolJson(protocol)},"filesDigest":${jsonStr(filesDigest)}}`;
}

// ===========================================================================
// Deep freeze
// ===========================================================================

function deepFreeze<T>(obj: T): Readonly<T> {
	if (obj === null || typeof obj !== "object") return obj;
	const propNames = Object.getOwnPropertyNames(obj);
	for (const name of propNames) {
		const val = (obj as Record<string, unknown>)[name];
		if (val !== null && typeof val === "object") {
			deepFreeze(val);
		}
	}
	return Object.freeze(obj);
}

// ===========================================================================
// Strict-copy input (no Proxy/getter allows values through)
// ===========================================================================

function strictCopyFileEntry(raw: unknown): PaarResult<PaarFileEntry> {
	// Must be non-null object without accessors/symbols/nonenumerable
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
	}
	const descs = Object.getOwnPropertyDescriptors(raw);
	const ownKeys = Object.getOwnPropertyNames(raw);
	const symbols = Object.getOwnPropertySymbols(raw);
	if (symbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };

	// Check exactly the 5 known keys, with no accessors/nonenumerable
	const allowedKeys = new Set(["path", "size", "mode", "sha256", "offset"]);
	for (const key of ownKeys) {
		if (!allowedKeys.has(key)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
		const desc = descs[key];
		if (desc.get || desc.set) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
		if (!desc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
	}
	// Check all keys present
	for (const key of allowedKeys) {
		if (!(key in raw)) return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_FILE_FIELD } };
	}

	const e = raw as Record<string, unknown>;

	// Validate path
	const pathCheck = checkFilePath(e.path);
	if (pathCheck) return { ok: false as const, error: { code: pathCheck } };

	// Validate mode (numeric 0o644 or 0o755)
	if (typeof e.mode !== "number" || !Number.isSafeInteger(e.mode)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
	}
	if (e.mode !== 0o644 && e.mode !== 0o755) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
	}

	// Validate size
	if (!isNonNegativeSafeInt(e.size)) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };
	if ((e.size as number) > MAX_FILE_SIZE)
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };

	// Validate sha256
	if (typeof e.sha256 !== "string" || !isHex64(e.sha256))
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_HASH } };

	// Validate offset
	if (!isNonNegativeSafeInt(e.offset)) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };

	return {
		ok: true as const,
		value: {
			path: e.path as string,
			size: e.size as number,
			mode: e.mode as number,
			sha256: e.sha256 as string,
			offset: e.offset as number,
		},
	};
}

// ===========================================================================
// Read uint32BE via DataView to avoid sign issues
// ===========================================================================

function readUint32BE(bytes: Uint8Array, offset: number): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
	return view.getUint32(0, false); // big-endian
}

// ===========================================================================
// Check raw JSON has trailing bytes after the one root value
// ===========================================================================

function hasTrailing(json: string): boolean {
	let depth = 0;
	let inStr = false;
	let esc = false;
	let rootEnd = -1;
	for (let i = 0; i < json.length; i++) {
		const ch = json[i];
		if (esc) {
			esc = false;
			continue;
		}
		if (inStr) {
			if (ch === "\\") {
				esc = true;
			} else if (ch === '"') {
				inStr = false;
			}
			continue;
		}
		if (ch === '"') {
			inStr = true;
			continue;
		}
		if (ch === "{" || ch === "[") {
			depth++;
			continue;
		}
		if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) {
				rootEnd = i + 1;
				break;
			}
		}
	}
	if (rootEnd === -1) return false;
	for (let i = rootEnd; i < json.length; i++) {
		const ch = json[i];
		if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") return true;
	}
	return false;
}

// ===========================================================================
// Check for -0 in JSON
// ===========================================================================

function hasNegZero(json: string): boolean {
	for (let i = 0; i < json.length; i++) {
		if (json[i] === "-" && i + 1 < json.length && json[i + 1] === "0") {
			if (i + 2 >= json.length || ((json[i + 2] < "0" || json[i + 2] > "9") && json[i + 2] !== ".")) {
				return true;
			}
		}
	}
	return false;
}

// ===========================================================================
// utf-8 encode/decode helpers that own buffers
// ===========================================================================

function utf8Encode(s: string): Uint8Array {
	return Buffer.from(s, "utf-8");
}

function utf8Decode(bytes: Uint8Array): string | null {
	try {
		// Use TextDecoder with fatal: true to reject invalid UTF-8
		const decoder = new TextDecoder("utf-8", { fatal: true });
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}

// ===========================================================================
// Public API: encodePaarManifest
// ===========================================================================

export function encodePaarManifest(input: PaarEncodeInput): PaarResult<PaarEncodeResult> {
	try {
		return encodePaarManifestImpl(input);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
	}
}

function encodePaarManifestImpl(input: PaarEncodeInput): PaarResult<PaarEncodeResult> {
	// Guard against Proxy/getter wrapping — access known own properties only
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
	}
	const inputDescs = Object.getOwnPropertyDescriptors(input);
	const inputKeys = Object.getOwnPropertyNames(input);
	const inputSymbols = Object.getOwnPropertySymbols(input);
	if (inputSymbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
	const allowedInputKeys = new Set([
		"sourceCommit",
		"target",
		"daemonProtocolVersion",
		"daemonSchemaRevision",
		"files",
	]);
	for (const key of inputKeys) {
		if (!allowedInputKeys.has(key))
			return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
		const desc = inputDescs[key];
		if (desc.get || desc.set) return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
		if (!desc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
	}
	for (const key of allowedInputKeys) {
		if (!(key in input)) return { ok: false as const, error: { code: PAAR_ERRORS.CANONICAL_ENCODE_ERROR } };
	}

	const inp = input as unknown as Record<string, unknown>;

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

	// files array — strict own-data descriptor check
	const rawFiles = inp.files;
	if (!Array.isArray(rawFiles)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	if (rawFiles.length === 0) return { ok: false as const, error: { code: PAAR_ERRORS.FILES_EMPTY } };
	if (rawFiles.length > MAX_FILES) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };

	// Check array is not sparse
	for (let i = 0; i < rawFiles.length; i++) {
		if (!(i in rawFiles)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}

	// Strict copy each file entry and validate mode/path/hash/size
	const entries: PaarFileEntry[] = [];
	const seenPaths = new Set<string>();

	for (let i = 0; i < rawFiles.length; i++) {
		const feResult = strictCopyFileEntry(rawFiles[i]);
		if (!feResult.ok) return feResult;
		const fe = feResult.value;

		// NFC path
		const nfcPath = nfc(fe.path);
		if (nfcPath !== fe.path) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_PATH } };

		// Check duplicate paths
		if (seenPaths.has(fe.path)) return { ok: false as const, error: { code: PAAR_ERRORS.DUPLICATE_FILE_PATH } };
		seenPaths.add(fe.path);

		entries.push(fe);
	}

	// Require strict UTF-8 byte ordering
	for (let i = 1; i < entries.length; i++) {
		const bufA = Buffer.from(entries[i - 1].path, "utf-8");
		const bufB = Buffer.from(entries[i].path, "utf-8");
		if (Buffer.compare(bufA, bufB) >= 0) {
			return { ok: false as const, error: { code: PAAR_ERRORS.FILES_UNSORTED } };
		}
	}

	// Require contiguous offsets from 0
	let runningOffset = 0;
	for (const f of entries) {
		if (f.offset !== runningOffset) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };
		runningOffset += f.size;
	}
	const payloadSize = runningOffset;
	if (payloadSize > MAX_TOTAL_PAYLOAD) return { ok: false as const, error: { code: PAAR_ERRORS.PAYLOAD_OVERFLOW } };

	// Compute filesDigest = sha256(canonical fixed-order files array)
	const filesDigestStr = filesArrayDigestString(entries);
	const filesDigest = createHash("sha256").update(filesDigestStr, "utf-8").digest("hex");

	// Build protocol info
	const protocol: PaarProtocolInfo = {
		name: REMOTE_HOST_PROTOCOL_NAME,
		version: REMOTE_HOST_PROTOCOL_VERSION,
		daemonProtocolVersion: inp.daemonProtocolVersion as number,
		daemonSchemaRevision: inp.daemonSchemaRevision as number,
	};

	// Compute buildId = sha256(canonical fixed-order {sourceCommit, target, protocol, filesDigest})
	const buildIdStr = buildIdDigestString(inp.sourceCommit as string, inp.target as PaarTarget, protocol, filesDigest);
	const buildId = createHash("sha256").update(buildIdStr, "utf-8").digest("hex");

	// Build frozen manifest
	const manifest: PaarManifest = {
		format: "prime-agent-artifact",
		version: 1 as const,
		target: inp.target as PaarTarget,
		sourceCommit: inp.sourceCommit as string,
		protocol,
		filesDigest: filesDigest,
		buildId: buildId,
		files: entries,
	};

	// Encode to canonical JSON
	const manifestJson = encodeManifestJson(manifest);
	const manifestBytes = utf8Encode(manifestJson);

	if (manifestBytes.length > MAX_MANIFEST_BYTES) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TOO_LARGE } };
	}

	// Build header: MAGIC (5) + uint32BE length (4) + manifest bytes
	const headerSize = HEADER_PREFIX + manifestBytes.length;
	const header = new Uint8Array(headerSize);
	header[0] = MAGIC0;
	header[1] = MAGIC1;
	header[2] = MAGIC2;
	header[3] = MAGIC3;
	header[4] = MAGIC4;
	// uint32BE
	header[5] = (manifestBytes.length >> 24) & 0xff;
	header[6] = (manifestBytes.length >> 16) & 0xff;
	header[7] = (manifestBytes.length >> 8) & 0xff;
	header[8] = manifestBytes.length & 0xff;
	header.set(manifestBytes, HEADER_PREFIX);

	// Erase intermediate manifest bytes (owned, we're done with them)
	manifestBytes.fill(0);

	const archiveSize = headerSize + payloadSize;

	// Total archive <= 1 GiB
	if (archiveSize > MAX_ARCHIVE_SIZE) {
		return { ok: false as const, error: { code: PAAR_ERRORS.ARCHIVE_TOO_LARGE } };
	}

	// Freeze the result DTO
	const frozenEntries = Object.freeze(entries.map(deepFreeze));
	const frozenManifest = deepFreeze({
		...manifest,
		files: frozenEntries,
	});

	return {
		ok: true as const,
		value: {
			manifest: frozenManifest,
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
	try {
		return decodePaarManifestHeaderImpl(bytes, totalArchiveSize);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}
}

function decodePaarManifestHeaderImpl(bytes: Uint8Array, totalArchiveSize: number): PaarResult<PaarDecodeResult> {
	// totalArchiveSize must be positive safe int <= 1 GiB
	if (!isPositiveSafeInt(totalArchiveSize) || totalArchiveSize > MAX_ARCHIVE_SIZE) {
		return { ok: false as const, error: { code: PAAR_ERRORS.ARCHIVE_TOO_LARGE } };
	}

	// Must at least have magic + length
	if (bytes.length < HEADER_PREFIX) {
		return { ok: false as const, error: { code: PAAR_ERRORS.SHORT_HEADER } };
	}

	// Check magic
	if (
		bytes[0] !== MAGIC0 ||
		bytes[1] !== MAGIC1 ||
		bytes[2] !== MAGIC2 ||
		bytes[3] !== MAGIC3 ||
		bytes[4] !== MAGIC4
	) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_MAGIC } };
	}

	// Read uint32BE manifest length via DataView
	const manifestLen = readUint32BE(bytes, 5);
	if (manifestLen > MAX_MANIFEST_BYTES) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TOO_LARGE } };
	}

	const headerSize = HEADER_PREFIX + manifestLen;
	if (bytes.length < headerSize) {
		return { ok: false as const, error: { code: PAAR_ERRORS.MANIFEST_TRUNCATED } };
	}

	// Extract manifest bytes (view into input; we don't own them until decode succeeds)
	const manifestSlice = bytes.subarray(HEADER_PREFIX, HEADER_PREFIX + manifestLen);

	// Validate UTF-8 with fatal TextDecoder
	const manifestStr = utf8Decode(manifestSlice);
	if (manifestStr === null) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}

	// Verify no replacement chars: roundtrip must produce same bytes
	const reencoded = utf8Encode(manifestStr);
	if (reencoded.length !== manifestSlice.length) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
	}
	for (let i = 0; i < manifestSlice.length; i++) {
		if (manifestSlice[i] !== reencoded[i]) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_UTF8 } };
		}
	}
	// Erase reencoded buffer
	reencoded.fill(0);

	// Check for trailing bytes after root JSON value
	if (hasTrailing(manifestStr)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.TRAILING_MANIFEST_BYTES } };
	}

	// Check for -0
	if (hasNegZero(manifestStr)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
	}

	// Parse JSON
	let parsed: unknown;
	try {
		parsed = JSON.parse(manifestStr);
	} catch {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_JSON } };
	}

	// Must be a plain object
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_JSON } };
	}

	// Verify: null-prototype or Object.prototype, own-data descriptors, exact known keys
	const manifestObjResult = checkOwnDataDescriptor(
		parsed,
		new Set(["format", "version", "target", "sourceCommit", "protocol", "filesDigest", "buildId", "files"]),
	);
	if (!manifestObjResult.ok) return manifestObjResult;
	const mobj = manifestObjResult.value;

	// Validate format
	if (mobj.format !== "prime-agent-artifact") return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };

	// Validate version
	if (mobj.version !== 1) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_VERSION } };

	// Validate target
	if (mobj.target !== "linux-x64" && mobj.target !== "linux-arm64") {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_TARGET } };
	}

	// Validate sourceCommit
	if (typeof mobj.sourceCommit !== "string" || !isHex40(mobj.sourceCommit)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_SOURCE_COMMIT } };
	}

	// Validate protocol
	const protoResult = checkOwnDataDescriptor(
		mobj.protocol,
		new Set(["name", "version", "daemonProtocolVersion", "daemonSchemaRevision"]),
	);
	if (!protoResult.ok) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_PROTOCOL } };
	const proto = protoResult.value;

	if (proto.name !== REMOTE_HOST_PROTOCOL_NAME)
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_PROTOCOL_NAME } };
	if (proto.version !== REMOTE_HOST_PROTOCOL_VERSION)
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_PROTOCOL_VERSION } };
	if (!isPositiveSafeInt(proto.daemonProtocolVersion))
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_PROTOCOL_VERSION } };
	if (!isNonNegativeSafeInt(proto.daemonSchemaRevision))
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_DAEMON_SCHEMA_REVISION } };

	// Validate filesDigest
	if (typeof mobj.filesDigest !== "string" || !isHex64(mobj.filesDigest)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES_DIGEST } };
	}

	// Validate buildId
	if (typeof mobj.buildId !== "string" || !isHex64(mobj.buildId)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_BUILD_ID } };
	}

	// Validate files array
	if (!Array.isArray(mobj.files)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	if (mobj.files.length === 0) return { ok: false as const, error: { code: PAAR_ERRORS.FILES_EMPTY } };
	if (mobj.files.length > MAX_FILES) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };

	// Check sparse
	for (let i = 0; i < mobj.files.length; i++) {
		if (!(i in mobj.files)) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILES } };
	}

	// Parse each file entry
	const parsedFiles: PaarFileEntry[] = [];
	const seenPaths = new Set<string>();

	for (let i = 0; i < mobj.files.length; i++) {
		const feResult = checkOwnDataDescriptor(mobj.files[i], new Set(["path", "size", "mode", "sha256", "offset"]));
		if (!feResult.ok) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FILE_ENTRY } };
		const fe = feResult.value;

		// Validate path
		const pathCheck = checkFilePath(fe.path);
		if (pathCheck) return { ok: false as const, error: { code: pathCheck } };

		// Validate mode (must be number 0o644 or 0o755)
		if (typeof fe.mode !== "number" || !Number.isSafeInteger(fe.mode)) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
		}
		if (fe.mode !== 0o644 && fe.mode !== 0o755) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_MODE } };
		}

		// Validate size (0..256MiB)
		if (!isNonNegativeSafeInt(fe.size) || (fe.size as number) > MAX_FILE_SIZE) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_SIZE } };
		}

		// Validate sha256
		if (typeof fe.sha256 !== "string" || !isHex64(fe.sha256)) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_HASH } };
		}

		// Validate offset
		if (!isNonNegativeSafeInt(fe.offset)) {
			return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };
		}

		const p = fe.path as string;
		if (seenPaths.has(p)) return { ok: false as const, error: { code: PAAR_ERRORS.DUPLICATE_FILE_PATH } };
		seenPaths.add(p);

		parsedFiles.push({
			path: p,
			size: fe.size as number,
			mode: fe.mode as number,
			sha256: fe.sha256 as string,
			offset: fe.offset as number,
		});
	}

	// Verify strict UTF-8 byte sorted
	for (let i = 1; i < parsedFiles.length; i++) {
		const bufA = Buffer.from(parsedFiles[i - 1].path, "utf-8");
		const bufB = Buffer.from(parsedFiles[i].path, "utf-8");
		if (Buffer.compare(bufA, bufB) >= 0) {
			return { ok: false as const, error: { code: PAAR_ERRORS.FILES_UNSORTED } };
		}
	}

	// Verify offsets contiguous from 0
	let expectedOffset = 0;
	for (const f of parsedFiles) {
		if (f.offset !== expectedOffset) return { ok: false as const, error: { code: PAAR_ERRORS.INVALID_FILE_OFFSET } };
		expectedOffset += f.size;
	}
	const payloadSize = expectedOffset;
	if (payloadSize > MAX_TOTAL_PAYLOAD) return { ok: false as const, error: { code: PAAR_ERRORS.PAYLOAD_OVERFLOW } };

	// Verify totalArchiveSize == headerSize + payloadSize
	if (totalArchiveSize !== headerSize + payloadSize) {
		return { ok: false as const, error: { code: PAAR_ERRORS.TOTAL_ARCHIVE_MISMATCH } };
	}

	// Recompute filesDigest
	const computedFilesDigestStr = filesArrayDigestString(parsedFiles);
	const computedFilesDigest = createHash("sha256").update(computedFilesDigestStr, "utf-8").digest("hex");

	if (computedFilesDigest !== mobj.filesDigest) {
		return { ok: false as const, error: { code: PAAR_ERRORS.FILES_DIGEST_MISMATCH } };
	}

	// Build protocol info for buildId
	const protocolInfo: PaarProtocolInfo = {
		name: REMOTE_HOST_PROTOCOL_NAME,
		version: REMOTE_HOST_PROTOCOL_VERSION,
		daemonProtocolVersion: proto.daemonProtocolVersion as number,
		daemonSchemaRevision: proto.daemonSchemaRevision as number,
	};

	// Recompute buildId
	const computedBuildIdStr = buildIdDigestString(
		mobj.sourceCommit as string,
		mobj.target as PaarTarget,
		protocolInfo,
		computedFilesDigest,
	);
	const computedBuildId = createHash("sha256").update(computedBuildIdStr, "utf-8").digest("hex");

	if (computedBuildId !== mobj.buildId) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BUILD_ID_MISMATCH } };
	}

	// Build fresh manifest
	const freshManifest: PaarManifest = {
		format: "prime-agent-artifact",
		version: 1,
		target: mobj.target as PaarTarget,
		sourceCommit: mobj.sourceCommit as string,
		protocol: protocolInfo,
		filesDigest: computedFilesDigest,
		buildId: computedBuildId,
		files: parsedFiles,
	};

	// Canonical encoding check — raw manifest bytes must constant-time equal canonical re-encoding
	const reCanon = utf8Encode(encodeManifestJson(freshManifest));
	if (reCanon.length !== manifestSlice.length) {
		reCanon.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
	}
	try {
		if (!timingSafeEqual(reCanon, manifestSlice as unknown as Buffer)) {
			reCanon.fill(0);
			return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
		}
	} catch {
		reCanon.fill(0);
		return { ok: false as const, error: { code: PAAR_ERRORS.NON_CANONICAL } };
	}
	// Erase re-encoded buffer
	reCanon.fill(0);

	// Erase computed digest strings (intermediate strings GC handles)
	// Erase computedFilesDigestStr — no, strings are immutable but temp strings get GC'd

	// Freeze fresh manifest
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

// ===========================================================================
// checkOwnDataDescriptor — verify a value is a plain/null-proto object with
// exact known keys, no accessors/nonenumerable/symbol/undefined/extra/missing.
// Returns the object cast to Record<string, unknown>.
// ===========================================================================

function checkOwnDataDescriptor(value: unknown, allowedKeys: Set<string>): PaarResult<Record<string, unknown>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
	}
	const obj = value as Record<string, unknown>;

	const proto = Object.getPrototypeOf(obj);
	if (proto !== null && proto !== Object.prototype) {
		return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
	}

	const descs = Object.getOwnPropertyDescriptors(obj);
	const ownKeys = Object.getOwnPropertyNames(obj);
	const symbols = Object.getOwnPropertySymbols(obj);
	if (symbols.length > 0) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };

	for (const key of ownKeys) {
		const desc = descs[key];
		if (desc.get || desc.set) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
		if (!desc.enumerable) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
		if (obj[key] === undefined) return { ok: false as const, error: { code: PAAR_ERRORS.BAD_FORMAT } };
		if (!allowedKeys.has(key)) return { ok: false as const, error: { code: PAAR_ERRORS.EXTRA_MANIFEST_FIELD } };
	}

	// Check all required keys present
	for (const key of allowedKeys) {
		if (!(key in obj)) return { ok: false as const, error: { code: PAAR_ERRORS.MISSING_MANIFEST_FIELD } };
	}

	return { ok: true as const, value: obj };
}
