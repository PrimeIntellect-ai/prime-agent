/**
 * PAB1 — Payload Bootstrap v1 binary codec for B14 sandbox bootstrap.
 *
 * Wire format (big-endian):
 *   [0-3]   ASCII magic "PAB1"                     (4 bytes)
 *   [4-7]   metadataLength (uint32 BE)             (4 bytes)
 *   [8..]   canonical UTF-8 metadata JSON           (exact metadataLength bytes, <=16 KiB)
 *   [..]    grantLength (uint16 BE)                 (2 bytes)
 *   [..]    grant raw bytes                         (exact grantLength bytes, 32-128)
 *   total <= 64 KiB
 *
 * Every intermediate buffer is zeroed before return. Input grant/payload views
 * are erased on every path after copying. Output payloads are caller-owned.
 *
 * No dynamic imports, no require, no sync fs/process, no Buffer subarray alias.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** ASCII magic bytes "PAB1". */
const MAGIC = new Uint8Array([0x50, 0x41, 0x42, 0x31]);
const MAGIC_LEN = 4;
const META_LEN_FIELD = 4; // uint32BE
const GRANT_LEN_FIELD = 2; // uint16BE
const HEADER_OVERHEAD = MAGIC_LEN + META_LEN_FIELD; // 8

const MAX_META_BYTES = 16 * 1024; // 16 KiB
const MAX_GRANT_BYTES = 128;
const MIN_GRANT_BYTES = 32;
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB
const MAX_ID_LENGTH = 128;
const MAX_CONNECT_TIMEOUT_MS = 300_000; // 5 minutes

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/** Grant allowed bytes: 0x21-0x7E excluding " (0x22), : (0x3A), \\ (0x5C). */
function isGrantByte(b: number): boolean {
	if (b < 0x21 || b > 0x7e) return false;
	if (b === 0x22) return false;
	if (b === 0x3a) return false;
	if (b === 0x5c) return false;
	return true;
}

function zero(buf: Uint8Array): void {
	if (buf.byteLength > 0) buf.fill(0);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

// ---------------------------------------------------------------------------
// Error codes — fixed safe strings only, no secrets/grants/urls/hashes
// ---------------------------------------------------------------------------

const ERR_MAGIC = "PAB1_ERR_MAGIC";
const ERR_META_OVERSIZE = "PAB1_ERR_META_OVERSIZE";
const ERR_META_READ = "PAB1_ERR_META_READ";
const ERR_META_PARSE = "PAB1_ERR_META_PARSE";
const ERR_META_UNKNOWN = "PAB1_ERR_META_UNKNOWN";
const ERR_META_TYPE = "PAB1_ERR_META_TYPE";
const ERR_META_NONCANONICAL = "PAB1_ERR_META_NONCANONICAL";
const ERR_GRANT_LENGTH = "PAB1_ERR_GRANT_LENGTH";
const ERR_GRANT_BYTE = "PAB1_ERR_GRANT_BYTE";
const ERR_TRAILING = "PAB1_ERR_TRAILING";
const ERR_OVERSIZE = "PAB1_ERR_OVERSIZE";
const ERR_TRUNCATED = "PAB1_ERR_TRUNCATED";
const ERR_RELAY_URL = "PAB1_ERR_RELAY_URL";
const ERR_ID = "PAB1_ERR_ID";
const ERR_BUILD_IDENTITY = "PAB1_ERR_BUILD_IDENTITY";
const ERR_TIMEOUT = "PAB1_ERR_TIMEOUT";
const ERR_VERSION = "PAB1_ERR_VERSION";
const ERR_GRANT_CONSUMED = "PAB1_ERR_GRANT_CONSUMED";
const ERR_GRANT_DISPOSED = "PAB1_ERR_GRANT_DISPOSED";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface OkResult<T> {
	ok: true;
	value: T;
}

export interface FailResult {
	ok: false;
	code: string;
}

export type Result<T> = OkResult<T> | FailResult;

function ok<T>(value: T): OkResult<T> {
	return { ok: true, value };
}

function fail(code: string): FailResult {
	return { ok: false, code };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidSafeId(id: string): boolean {
	return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH && SAFE_ID_RE.test(id);
}

function isNonNegativeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// ---------------------------------------------------------------------------
// URL validation for wss:// relay URLs
// ---------------------------------------------------------------------------

const MAX_HOSTNAME_LENGTH = 253;
const MAX_URL_PATH_LENGTH = 1024;
const SAFE_PATH_RE = /^\/[a-zA-Z0-9._~/-]*$/;

function isValidRelayUrl(url: string): string | undefined {
	if (typeof url !== "string") return ERR_RELAY_URL;
	if (!url.startsWith("wss://")) return ERR_RELAY_URL;

	const afterScheme = url.slice(6);

	// No @ means no username/password
	if (afterScheme.includes("@")) return ERR_RELAY_URL;

	const slashIdx = afterScheme.indexOf("/");
	let hostPart: string;
	let pathPart: string;
	if (slashIdx < 0) {
		hostPart = afterScheme;
		pathPart = "";
	} else {
		hostPart = afterScheme.slice(0, slashIdx);
		pathPart = afterScheme.slice(slashIdx);
	}

	// No query or fragment anywhere
	if (hostPart.includes("?") || hostPart.includes("#") || pathPart.includes("?") || pathPart.includes("#")) {
		return ERR_RELAY_URL;
	}

	if (hostPart.length === 0 || hostPart.length > MAX_HOSTNAME_LENGTH + 6) return ERR_RELAY_URL;

	// Strip port for IP validation
	const hostname = hostPart.includes(":") ? hostPart.split(":")[0] : hostPart;
	const hostnameLower = hostname.toLowerCase();

	// No localhost
	if (hostnameLower === "localhost") return ERR_RELAY_URL;
	// No loopback 127.x.x.x
	if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return ERR_RELAY_URL;
	// No link-local 169.254.x.x
	if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return ERR_RELAY_URL;
	// No private 10.x.x.x
	if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return ERR_RELAY_URL;
	// No private 172.16-31.x.x
	if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return ERR_RELAY_URL;
	// No private 192.168.x.x
	if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return ERR_RELAY_URL;
	// No IPv6 loopback
	if (hostnameLower === "::1") return ERR_RELAY_URL;

	// Hostname label validation
	const labels = hostnameLower.split(".");
	for (const label of labels) {
		if (label.length === 0 || label.length > 63) return ERR_RELAY_URL;
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)) return ERR_RELAY_URL;
	}

	// Path validation
	if (pathPart.length > MAX_URL_PATH_LENGTH) return ERR_RELAY_URL;
	if (pathPart.length > 0 && !SAFE_PATH_RE.test(pathPart)) return ERR_RELAY_URL;

	return undefined;
}

// ---------------------------------------------------------------------------
// Metadata types
// ---------------------------------------------------------------------------

export interface BuildIdentityOpts {
	buildId: string;
	daemonProtocolVersion: number;
	daemonSchemaRevision: number;
	appVersion?: string;
}

export interface MetadataOpts {
	hostId: string;
	generation: string;
	sessionId: string;
	relayUrl: string;
	buildIdentity: BuildIdentityOpts;
	connectTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Canonical JSON builder — fresh DTO with fixed key order
// ---------------------------------------------------------------------------

function buildCanonicalMetadataJson(meta: MetadataOpts): string {
	const buildIdentity: Record<string, unknown> = {
		buildId: meta.buildIdentity.buildId,
		daemonProtocolVersion: meta.buildIdentity.daemonProtocolVersion,
		daemonSchemaRevision: meta.buildIdentity.daemonSchemaRevision,
	};
	if (meta.buildIdentity.appVersion !== undefined) {
		buildIdentity.appVersion = meta.buildIdentity.appVersion;
	}
	const obj: Record<string, unknown> = {
		version: 1,
		hostId: meta.hostId,
		generation: meta.generation,
		sessionId: meta.sessionId,
		relayUrl: meta.relayUrl,
		buildIdentity,
		connectTimeoutMs: meta.connectTimeoutMs,
	};
	return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// Parsed metadata DTO
// ---------------------------------------------------------------------------

export interface ParsedMetadata {
	version: 1;
	hostId: string;
	generation: string;
	sessionId: string;
	relayUrl: string;
	buildIdentity: {
		buildId: string;
		daemonProtocolVersion: number;
		daemonSchemaRevision: number;
		appVersion?: string;
	};
	connectTimeoutMs: number;
}

function validateMetadataJson(parsed: unknown): Result<ParsedMetadata> {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return fail(ERR_META_TYPE);
	}

	const knownKeys = new Set([
		"version",
		"hostId",
		"generation",
		"sessionId",
		"relayUrl",
		"buildIdentity",
		"connectTimeoutMs",
	]);
	for (const key of Object.keys(parsed as Record<string, unknown>)) {
		if (!knownKeys.has(key)) return fail(ERR_META_UNKNOWN);
	}

	const obj = parsed as Record<string, unknown>;

	if (obj.version !== 1) return fail(ERR_VERSION);
	if (typeof obj.hostId !== "string" || !isValidSafeId(obj.hostId)) return fail(ERR_ID);
	if (typeof obj.generation !== "string" || !isValidSafeId(obj.generation)) return fail(ERR_ID);
	if (typeof obj.sessionId !== "string" || !isValidSafeId(obj.sessionId)) return fail(ERR_ID);

	if (typeof obj.relayUrl !== "string") return fail(ERR_RELAY_URL);
	const urlErr = isValidRelayUrl(obj.relayUrl);
	if (urlErr) return fail(urlErr);

	if (typeof obj.buildIdentity !== "object" || obj.buildIdentity === null || Array.isArray(obj.buildIdentity)) {
		return fail(ERR_BUILD_IDENTITY);
	}
	const buildKnownKeys = new Set(["buildId", "daemonProtocolVersion", "daemonSchemaRevision", "appVersion"]);
	for (const key of Object.keys(obj.buildIdentity as Record<string, unknown>)) {
		if (!buildKnownKeys.has(key)) return fail(ERR_META_UNKNOWN);
	}
	const build = obj.buildIdentity as Record<string, unknown>;

	if (typeof build.buildId !== "string" || !isValidSafeId(build.buildId)) {
		return fail(ERR_BUILD_IDENTITY);
	}
	if (!isNonNegativeInt(build.daemonProtocolVersion)) return fail(ERR_BUILD_IDENTITY);
	if (!isNonNegativeInt(build.daemonSchemaRevision)) return fail(ERR_BUILD_IDENTITY);
	if (
		build.appVersion !== undefined &&
		(typeof build.appVersion !== "string" || build.appVersion.length > MAX_ID_LENGTH)
	) {
		return fail(ERR_BUILD_IDENTITY);
	}

	if (!isPositiveInt(obj.connectTimeoutMs)) return fail(ERR_TIMEOUT);
	if (obj.connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS) return fail(ERR_TIMEOUT);

	const bi: ParsedMetadata["buildIdentity"] = {
		buildId: build.buildId as string,
		daemonProtocolVersion: build.daemonProtocolVersion as number,
		daemonSchemaRevision: build.daemonSchemaRevision as number,
	};
	if (build.appVersion !== undefined) {
		bi.appVersion = build.appVersion as string;
	}

	return ok({
		version: 1,
		hostId: obj.hostId as string,
		generation: obj.generation as string,
		sessionId: obj.sessionId as string,
		relayUrl: obj.relayUrl as string,
		buildIdentity: bi,
		connectTimeoutMs: obj.connectTimeoutMs as number,
	});
}

// ---------------------------------------------------------------------------
// Grant validation
// ---------------------------------------------------------------------------

function validateGrant(grant: Uint8Array): string | undefined {
	if (grant.byteLength < MIN_GRANT_BYTES || grant.byteLength > MAX_GRANT_BYTES) {
		return ERR_GRANT_LENGTH;
	}
	for (let i = 0; i < grant.byteLength; i++) {
		if (!isGrantByte(grant[i])) return ERR_GRANT_BYTE;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// OneUseBootstrapGrant
// ---------------------------------------------------------------------------

/**
 * Wraps a one-time-use bootstrap grant.
 *
 * Owns a private copied Uint8Array. `takeBytes()` succeeds exactly once and
 * returns the owned bytes (caller must erase). `dispose()` erases unconsumed
 * bytes and is idempotent. No getter returns an alias before takeBytes().
 * No toJSON/valueOf/toString/inspect exposes the secret content.
 */
type GrantState = "ready" | "consumed" | "disposed";

export class OneUseBootstrapGrant {
	#bytes: Uint8Array | null;
	#state: GrantState;

	/** Internal. Takes ownership of the provided bytes (caller must have copied). */
	constructor(bytes: Uint8Array) {
		this.#bytes = new Uint8Array(bytes);
		this.#state = "ready";
	}

	/** Non-secret byte length. */
	get byteLength(): number {
		return this.#bytes?.byteLength ?? 0;
	}

	/** Non-secret status enumeration. */
	get status(): GrantState {
		return this.#state;
	}

	/**
	 * Take the owned grant bytes. Succeeds exactly once; subsequent calls
	 * throw. The caller MUST zero the returned buffer after consumption.
	 * Returns a fresh Uint8Array; the internal buffer is nulled out.
	 */
	takeBytes(): Uint8Array {
		if (this.#state !== "ready") {
			if (this.#state === "consumed") throw new CodecPayloadError(ERR_GRANT_CONSUMED);
			if (this.#state === "disposed") throw new CodecPayloadError(ERR_GRANT_DISPOSED);
		}
		this.#state = "consumed";
		const out = this.#bytes!;
		this.#bytes = null;
		return out;
	}

	/**
	 * Dispose the grant. Erases the private copy if unconsumed. Idempotent.
	 */
	dispose(): void {
		if (this.#state === "ready" && this.#bytes !== null) {
			zero(this.#bytes);
			this.#bytes = null;
			this.#state = "disposed";
		} else if (this.#state === "consumed") {
			// Already consumed; stay consumed
		} else if (this.#state === "disposed") {
			// Already disposed; idempotent
		}
	}

	// ---- No secret exposure via standard JS protocols ----

	toJSON(): undefined {
		return undefined;
	}

	toString(): string {
		return "[OneUseBootstrapGrant]";
	}

	valueOf(): this {
		return this;
	}

	[Symbol.toPrimitive](): string {
		return "[OneUseBootstrapGrant]";
	}

	[Symbol.for("nodejs.util.inspect.custom")](): string {
		return "[OneUseBootstrapGrant]";
	}
}

// ---------------------------------------------------------------------------
// withBootstrapGrant
// ---------------------------------------------------------------------------

/**
 * Hand owned grant bytes to a callback, then always erase/dispose.
 * Thrown values are mapped by the caller — the helper does NOT stringify
 * or expose the grant content.
 */
export async function withBootstrapGrant<T>(
	grant: OneUseBootstrapGrant,
	fn: (bytes: Uint8Array) => Promise<T>,
): Promise<T> {
	let bytes: Uint8Array | undefined;
	try {
		bytes = grant.takeBytes();
		return await fn(bytes);
	} finally {
		if (bytes !== undefined) {
			zero(bytes);
		}
		grant.dispose();
	}
}

// ---------------------------------------------------------------------------
// Thrown error for codec-internal failures
// ---------------------------------------------------------------------------

/** Internal error thrown on encode failures or grant misuse. */
class CodecPayloadError {
	readonly code: string;
	constructor(code: string) {
		this.code = code;
	}
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export interface EncodeSandboxBootstrapPayloadOpts {
	metadata: MetadataOpts;
	/**
	 * Caller-owned mutable grant Uint8Array.
	 * This view is erased on EVERY path after copying.
	 */
	grant: Uint8Array;
}

/**
 * Encode a PAB1 sandbox bootstrap payload.
 *
 * Takes a caller-owned mutable grant Uint8Array and erases that view on
 * EVERY path after copying. Returns a caller-owned payload Uint8Array.
 */
export function encodeSandboxBootstrapPayload(opts: EncodeSandboxBootstrapPayloadOpts): Uint8Array {
	// Validate inputs before any buffer mutation
	const metaJson = buildCanonicalMetadataJson(opts.metadata);
	const metaBytes = new TextEncoder().encode(metaJson);

	if (metaBytes.byteLength > MAX_META_BYTES) {
		zero(metaBytes);
		zero(opts.grant);
		throw new CodecPayloadError(ERR_META_OVERSIZE);
	}

	const grantErr = validateGrant(opts.grant);
	if (grantErr) {
		zero(metaBytes);
		zero(opts.grant);
		throw new CodecPayloadError(grantErr);
	}

	const grantLen = opts.grant.byteLength;
	const totalLen = HEADER_OVERHEAD + metaBytes.byteLength + GRANT_LEN_FIELD + grantLen;

	if (totalLen > MAX_PAYLOAD_BYTES) {
		zero(metaBytes);
		zero(opts.grant);
		throw new CodecPayloadError(ERR_OVERSIZE);
	}

	const payload = new Uint8Array(totalLen);
	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

	try {
		// Magic
		payload.set(MAGIC, 0);

		// Metadata length
		dv.setUint32(MAGIC_LEN, metaBytes.byteLength);

		// Metadata JSON
		payload.set(metaBytes, HEADER_OVERHEAD);

		// Grant length
		dv.setUint16(HEADER_OVERHEAD + metaBytes.byteLength, grantLen);

		// Grant bytes (copy then erase original)
		payload.set(opts.grant, HEADER_OVERHEAD + metaBytes.byteLength + GRANT_LEN_FIELD);

		// Erase intermediates
		zero(metaBytes);
		zero(opts.grant);

		return payload;
	} catch (err) {
		zero(metaBytes);
		zero(opts.grant);
		zero(payload);
		if (err instanceof CodecPayloadError) throw err;
		throw new CodecPayloadError(ERR_OVERSIZE);
	}
}

// ---------------------------------------------------------------------------
// Decode result types
// ---------------------------------------------------------------------------

export interface SandboxBootstrapPayloadDecoded {
	metadata: ParsedMetadata;
	grant: OneUseBootstrapGrant;
}

function freezeDeep<T extends Record<string, unknown>>(obj: T): T {
	const frozen: Record<string, unknown> = {};
	for (const key of Object.keys(obj)) {
		const val = obj[key];
		if (val !== null && typeof val === "object" && !Array.isArray(val)) {
			frozen[key] = freezeDeep(val as Record<string, unknown>);
		} else {
			frozen[key] = val;
		}
	}
	return Object.freeze(frozen) as T;
}

// ---------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------

/**
 * Decode a PAB1 sandbox bootstrap payload.
 *
 * Erases the caller payload on EVERY success/failure path.
 * Returns a deeply frozen metadata DTO plus a OneUseBootstrapGrant
 * owning a copied private Uint8Array.
 */
export function decodeSandboxBootstrapPayload(payload: Uint8Array): Result<SandboxBootstrapPayloadDecoded> {
	// --- Step 1: size preflight ---
	if (payload.byteLength < HEADER_OVERHEAD + GRANT_LEN_FIELD) {
		zero(payload);
		return fail(ERR_TRUNCATED);
	}
	if (payload.byteLength > MAX_PAYLOAD_BYTES) {
		zero(payload);
		return fail(ERR_OVERSIZE);
	}

	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

	// --- Step 2: magic check ---
	const magicSlice = payload.slice(0, MAGIC_LEN);
	if (!constantTimeEqual(magicSlice, MAGIC)) {
		zero(magicSlice);
		zero(payload);
		return fail(ERR_MAGIC);
	}
	zero(magicSlice);

	// --- Step 3: metadata length ---
	const metaLen = dv.getUint32(MAGIC_LEN);
	if (metaLen === 0 || metaLen > MAX_META_BYTES) {
		zero(payload);
		return fail(metaLen === 0 ? ERR_META_READ : ERR_META_OVERSIZE);
	}

	const grantLenOffset = HEADER_OVERHEAD + metaLen;
	if (grantLenOffset + GRANT_LEN_FIELD > payload.byteLength) {
		zero(payload);
		return fail(ERR_TRUNCATED);
	}

	// --- Step 4: read metadata bytes ---
	const metaBytes = payload.slice(HEADER_OVERHEAD, grantLenOffset);

	// --- Step 5: grant length ---
	const grantLen = dv.getUint16(grantLenOffset);
	if (grantLen < MIN_GRANT_BYTES || grantLen > MAX_GRANT_BYTES) {
		zero(metaBytes);
		zero(payload);
		return fail(ERR_GRANT_LENGTH);
	}

	// --- Step 6: exact EOF check ---
	const grantEnd = grantLenOffset + GRANT_LEN_FIELD + grantLen;
	if (grantEnd > payload.byteLength) {
		zero(metaBytes);
		zero(payload);
		return fail(ERR_TRUNCATED);
	}
	if (grantEnd !== payload.byteLength) {
		zero(metaBytes);
		zero(payload);
		return fail(ERR_TRAILING);
	}

	// --- Step 7: read grant (copy before erasing payload) ---
	const grantRaw = payload.slice(grantLenOffset + GRANT_LEN_FIELD, grantEnd);

	// Erase caller payload now — on every remaining path, payload is gone
	zero(payload);

	// --- Step 8: validate grant bytes ---
	for (let i = 0; i < grantRaw.byteLength; i++) {
		if (!isGrantByte(grantRaw[i])) {
			zero(grantRaw);
			zero(metaBytes);
			return fail(ERR_GRANT_BYTE);
		}
	}

	// --- Step 9: parse metadata JSON ---
	let parsed: unknown;
	try {
		const metaStr = new TextDecoder("utf-8", { fatal: true }).decode(metaBytes);
		parsed = JSON.parse(metaStr);
	} catch {
		zero(grantRaw);
		zero(metaBytes);
		return fail(ERR_META_PARSE);
	}

	// --- Step 10: canonical JSON check ---
	// Construct a fresh fixed-order DTO from parsed fields and stringify it.
	// This catches wrong key order, duplicate keys, extra whitespace,
	// non-canonical encodings, and any variance from canonical representation.
	const parsedObj = parsed as Record<string, unknown>;
	const buildIdObj = parsedObj.buildIdentity as Record<string, unknown>;
	const canonicalObj: Record<string, unknown> = {
		version: parsedObj.version,
		hostId: parsedObj.hostId,
		generation: parsedObj.generation,
		sessionId: parsedObj.sessionId,
		relayUrl: parsedObj.relayUrl,
		buildIdentity: {
			buildId: buildIdObj.buildId,
			daemonProtocolVersion: buildIdObj.daemonProtocolVersion,
			daemonSchemaRevision: buildIdObj.daemonSchemaRevision,
		},
		connectTimeoutMs: parsedObj.connectTimeoutMs,
	};
	if (buildIdObj.appVersion !== undefined) {
		(canonicalObj.buildIdentity as Record<string, unknown>).appVersion = buildIdObj.appVersion;
	}

	const canonStr = JSON.stringify(canonicalObj);
	const canonBytes = new TextEncoder().encode(canonStr);

	if (!constantTimeEqual(canonBytes, metaBytes)) {
		zero(canonBytes);
		zero(grantRaw);
		zero(metaBytes);
		return fail(ERR_META_NONCANONICAL);
	}
	zero(canonBytes);
	zero(metaBytes);

	// --- Step 11: validate metadata fields ---
	const metaResult = validateMetadataJson(parsed);
	if (!metaResult.ok) {
		zero(grantRaw);
		return fail(metaResult.code);
	}

	// --- Step 12: construct result ---
	const frozenMeta = freezeDeep(metaResult.value as unknown as Record<string, unknown>) as unknown as ParsedMetadata;
	const grantObj = new OneUseBootstrapGrant(grantRaw);
	zero(grantRaw); // grantRaw is the intermediate; the copy is in OneUseBootstrapGrant

	return ok({
		metadata: frozenMeta,
		grant: grantObj,
	});
}
