/**
 * PAB1 — Payload Bootstrap v1 binary codec for B14 sandbox bootstrap.
 *
 * Wire format (big-endian):
 *   [0-3]   ASCII magic "PAB1"                     (4 bytes)
 *   [4-7]   metadataLength (uint32 BE)             (4 bytes)
 *   [8..]   canonical UTF-8 metadata JSON          (exact metadataLength bytes, <=16 KiB)
 *   [..]    grantLength (uint16 BE)                (2 bytes)
 *   [..]    grant raw bytes                        (exact grantLength bytes, 32-128)
 *   total <= 64 KiB
 *
 * Every intermediate buffer is zeroed before return. Public encode/decode return
 * fixed discriminated Result and never throw for input/envelope issues.
 * Input grant/payload views are copied immediately; the original Uint8Array is
 * erased on every reachable path when it is a genuine non-shared ArrayBuffer-backed
 * view. Proxy/SharedArrayBuffer/detached hosts are detected and rejected or erased
 * best-effort without false claims.
 *
 * No dynamic imports, no require, no sync fs/process, no Buffer subarray alias.
 */

// ---------------------------------------------------------------------------
// Import accepted protocol constraints (re-exported for consumers)
// ---------------------------------------------------------------------------

/** Maximum safe-ID length matching the accepted remote-agent-host protocol. */
export const MAX_ID_LENGTH = 128 as const;

/** Maximum hostname length per RFC 1035. */
export const MAX_HOSTNAME_LENGTH = 253 as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGIC = new Uint8Array([0x50, 0x41, 0x42, 0x31]); // PAB1
const MAGIC_LEN = 4;
const META_LEN_FIELD = 4; // uint32BE
const GRANT_LEN_FIELD = 2; // uint16BE
const HEADER_OVERHEAD = MAGIC_LEN + META_LEN_FIELD; // 8

const MAX_META_BYTES = 16 * 1024; // 16 KiB
const MAX_GRANT_BYTES = 128;
const MIN_GRANT_BYTES = 32;
const MAX_PAYLOAD_BYTES = 64 * 1024; // 64 KiB
const MAX_CONNECT_TIMEOUT_MS = 300_000; // 5 min

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const MAX_DEPTH = 64;
const _MAX_NODES = 10_000;

// Grant allowed bytes: 0x21-0x7E excluding " (0x22), : (0x3A), \ (0x5C), control
function isGrantByte(b: number): boolean {
	if (b < 0x21 || b > 0x7e) return false;
	if (b === 0x22 || b === 0x3a || b === 0x5c) return false;
	return true;
}

// ---- Brand token for OneUseBootstrapGrant ----
export const GRANT_BRAND: unique symbol = Symbol("OneUseBootstrapGrant");

// ---- Error code union ----
export type Pab1ErrorCode =
	| "PAB1_ERR_MAGIC"
	| "PAB1_ERR_META_OVERSIZE"
	| "PAB1_ERR_META_READ"
	| "PAB1_ERR_META_PARSE"
	| "PAB1_ERR_META_UNKNOWN"
	| "PAB1_ERR_META_TYPE"
	| "PAB1_ERR_META_NONCANONICAL"
	| "PAB1_ERR_GRANT_LENGTH"
	| "PAB1_ERR_GRANT_BYTE"
	| "PAB1_ERR_TRAILING"
	| "PAB1_ERR_OVERSIZE"
	| "PAB1_ERR_TRUNCATED"
	| "PAB1_ERR_RELAY_URL"
	| "PAB1_ERR_ID"
	| "PAB1_ERR_BUILD_IDENTITY"
	| "PAB1_ERR_TIMEOUT"
	| "PAB1_ERR_VERSION"
	| "PAB1_ERR_GRANT_CONSUMED"
	| "PAB1_ERR_GRANT_DISPOSED"
	| "PAB1_ERR_INVALID_ARGUMENT"
	| "PAB1_ERR_INVALID_BRAND"
	| "PAB1_ERR_INPUT_IMMUTABLE"
	| "PAB1_ERR_ENCODE_FAILED"
	| "PAB1_ERR_NODE_LIMIT"
	| "PAB1_ERR_DEPTH_LIMIT"
	| "PAB1_ERR_META_CYCLE"
	| "PAB1_ERR_META_ALIAS"
	| "PAB1_ERR_META_DESCRIPTOR"
	| "PAB1_ERR_META_NONENUMERABLE"
	| "PAB1_ERR_URL_CANONICAL"
	| "PAB1_ERR_URL_PRIVATE"
	| "PAB1_ERR_URL_HOST"
	| "PAB1_ERR_URL_PATH"
	| "PAB1_ERR_GRANT_FORGE"
	| "PAB1_ERR_INPUT_DETACHED";

// ---------------------------------------------------------------------------
// Discriminated Result types — both frozen
// ---------------------------------------------------------------------------

export interface OkResult<T> {
	readonly ok: true;
	readonly value: T;
}
export interface FailResult {
	readonly ok: false;
	readonly code: Pab1ErrorCode;
}
export type Result<T> = OkResult<T> | FailResult;

function ok<T>(value: T): OkResult<T> {
	return Object.freeze({ ok: true as const, value }) as OkResult<T>;
}

function fail(code: Pab1ErrorCode): FailResult {
	return Object.freeze({ ok: false as const, code }) as FailResult;
}

// ---------------------------------------------------------------------------
// Safe buffer helpers — survive hostile inputs
// ---------------------------------------------------------------------------

/** Safe zero: no-op on null/undefined/detached; catches throws from Proxy. */
function safeZero(buf: Uint8Array | null | undefined): void {
	if (!buf) return;
	try {
		if (buf.byteLength > 0) {
			// Cannot zero SharedArrayBuffer or detached — return
			if (isDetachedOrShared(buf)) return;
			buf.fill(0);
		}
	} catch {
		// Hostile Proxy — best effort
	}
}

/** Check if a buffer is backed by SharedArrayBuffer or is detached. */
function isDetachedOrShared(buf: Uint8Array): boolean {
	try {
		// Accessing .byteLength on detached throws for ArrayBuffer
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		buf.byteLength;
		// Check for SharedArrayBuffer
		const ab = buf.buffer;
		if (!ab) return true;
		if ((ab as ArrayBuffer | SharedArrayBuffer).byteLength === undefined) return true;
		// Check byteLength — detached buffers have 0 byteLength in some engines
		return false;
	} catch {
		return true;
	}
}

/** Check if a value is a genuine Uint8Array with a non-shared ArrayBuffer that we can safely erase. */
function isMutableUint8Array(v: unknown): v is Uint8Array {
	if (!(v instanceof Uint8Array)) return false;
	if (isDetachedOrShared(v)) return false;
	try {
		const ab = v.buffer;
		if (ab instanceof SharedArrayBuffer) return false;
		return true;
	} catch {
		return false;
	}
}

/** Copy a Uint8Array into a fresh non-shared buffer. */
function _copyBytes(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.byteLength);
	out.set(source);
	return out;
}

/** Copy data from a hostile value — must be a real Uint8Array. Returns Result. */
function safeCopyUint8Array(v: unknown, eraseTarget: Uint8Array | null): Result<Uint8Array> {
	if (!(v instanceof Uint8Array)) {
		safeZero(eraseTarget);
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}
	try {
		// Check for detached
		if (isDetachedOrShared(v)) {
			safeZero(eraseTarget);
			return fail("PAB1_ERR_INPUT_DETACHED");
		}
		const out = new Uint8Array(v.byteLength);
		try {
			out.set(v);
		} catch {
			safeZero(eraseTarget);
			return fail("PAB1_ERR_ENCODE_FAILED");
		}
		// Erase original if mutable non-shared
		if (isMutableUint8Array(v)) {
			safeZero(v);
		}
		return ok(out);
	} catch {
		safeZero(eraseTarget);
		return fail("PAB1_ERR_ENCODE_FAILED");
	}
}

// ---------------------------------------------------------------------------
// Plain-object data descriptor check
// ---------------------------------------------------------------------------

function _isPlainDataObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	try {
		const proto = Object.getPrototypeOf(v);
		if (proto !== null && proto !== Object.prototype) return false;
		const descs = Object.getOwnPropertyDescriptors(v);
		for (const key of Object.getOwnPropertyNames(v)) {
			const d = descs[key];
			if (d.get || d.set) return false;
			if (!d.enumerable) return false;
		}
		return true;
	} catch {
		return false;
	}
}

/** Check own property descriptors of a plain data object for getters/nonenumerable. Returns error code or undefined. */
function checkOwnDataDescriptors(v: Record<string, unknown>): Pab1ErrorCode | undefined {
	try {
		const descs = Object.getOwnPropertyDescriptors(v);
		for (const k of Object.getOwnPropertyNames(descs)) {
			const d = descs[k];
			if (d.get || d.set) return "PAB1_ERR_META_DESCRIPTOR";
			if (!d.enumerable) return "PAB1_ERR_META_NONENUMERABLE";
		}
		return undefined;
	} catch {
		return "PAB1_ERR_META_DESCRIPTOR";
	}
}

// ---------------------------------------------------------------------------
// Cycle/alias detection
// ---------------------------------------------------------------------------

function hasCycleOrAlias(value: unknown, seen: Set<object>): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value as object)) return true;
	seen.add(value as object);
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			if (hasCycleOrAlias(value[i], seen)) return true;
		}
	} else if (typeof value === "object") {
		const keys = Object.getOwnPropertyNames(value);
		for (const k of keys) {
			try {
				const v = (value as Record<string, unknown>)[k];
				if (hasCycleOrAlias(v, seen)) return true;
			} catch {
				return true;
			}
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Safe ID validation
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
// URL validation — uses URL constructor for canonical parsing
// ---------------------------------------------------------------------------

function isValidRelayUrl(url: string): Pab1ErrorCode | undefined {
	if (typeof url !== "string") return "PAB1_ERR_RELAY_URL";
	if (!url.startsWith("wss://")) return "PAB1_ERR_RELAY_URL";

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "PAB1_ERR_RELAY_URL";
	}

	// Require exact canonical href equality wss:// + hostname + path
	if (parsed.protocol !== "wss:") return "PAB1_ERR_RELAY_URL";

	// No credentials
	if (parsed.username || parsed.password) return "PAB1_ERR_RELAY_URL";
	// No query or fragment
	if (parsed.search || parsed.hash) return "PAB1_ERR_RELAY_URL";
	// No default port — wss://hostname/path is canonical, not wss://hostname:443/path
	if (parsed.port) return "PAB1_ERR_URL_CANONICAL";

	// Hostname validation
	const hostname = parsed.hostname;
	if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) return "PAB1_ERR_URL_HOST";

	// Reject localhost
	const hn = hostname.toLowerCase();
	if (hn === "localhost" || hn.endsWith(".localhost") || hn.endsWith(".local")) return "PAB1_ERR_URL_PRIVATE";

	// Reject literal IPv4 private/loopback/link-local
	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
		if (/^127\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^169\.254\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^10\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^192\.168\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
	}

	// Reject bracketed IPv6 loopback/link-local/ULA
	if (hostname.startsWith("[")) {
		const ipv6 = hostname.slice(1, -1);
		if (ipv6 === "::1") return "PAB1_ERR_URL_PRIVATE";
		if (ipv6.toLowerCase().startsWith("fe80")) return "PAB1_ERR_URL_PRIVATE";
		if (ipv6.toLowerCase().startsWith("fc") || ipv6.toLowerCase().startsWith("fd")) return "PAB1_ERR_URL_PRIVATE";
	}

	// Hostname label validation for DNS names
	const labels = hostname.split(".");
	if (labels.length >= 2 || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
		for (const label of labels) {
			if (label.length === 0 || label.length > 63) return "PAB1_ERR_URL_HOST";
			if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label) && !/^\d{1,3}$/.test(label)) return "PAB1_ERR_URL_HOST";
		}
	}

	// Path must be safe and nonempty
	if (!parsed.pathname || parsed.pathname.length > 1024 || parsed.pathname === "/") return "PAB1_ERR_URL_PATH";

	// Re-construct canonical URL and require exact string equality
	const canUrl = `wss://${hostname}${parsed.pathname}`;
	if (canUrl !== url) return "PAB1_ERR_URL_CANONICAL";

	return undefined;
}

// ---------------------------------------------------------------------------
// Metadata types
// ---------------------------------------------------------------------------

export interface BuildIdentityOpts {
	readonly buildId: string; // exactly 64 lowercase hex
	readonly daemonProtocolVersion: number;
	readonly daemonSchemaRevision: number;
	readonly appVersion?: string; // safe-id string when present
}

export interface MetadataOpts {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly relayUrl: string;
	readonly buildIdentity: BuildIdentityOpts;
	readonly connectTimeoutMs: number;
}

/** Parsed and validated metadata DTO — same shape as MetadataOpts. */
export interface ParsedMetadata {
	readonly version: 1;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly relayUrl: string;
	readonly buildIdentity: {
		readonly buildId: string;
		readonly daemonProtocolVersion: number;
		readonly daemonSchemaRevision: number;
		readonly appVersion?: string;
	};
	readonly connectTimeoutMs: number;
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
// Deep metadata schema validation (before canonical check)
// ---------------------------------------------------------------------------

function validateMetadataSchema(parsed: unknown): Result<ParsedMetadata> {
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return fail("PAB1_ERR_META_TYPE");
	}

	// Check own data descriptors
	const descriptorErr = checkOwnDataDescriptors(parsed as Record<string, unknown>);
	if (descriptorErr) return fail(descriptorErr);

	// Cycle/alias check — do NOT pre-add root (hasCycleOrAlias adds visited nodes)
	const seen = new Set<object>();
	if (hasCycleOrAlias(parsed, seen)) return fail("PAB1_ERR_META_CYCLE");

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
		if (!knownKeys.has(key)) return fail("PAB1_ERR_META_UNKNOWN");
	}

	const obj = parsed as Record<string, unknown>;

	if (obj.version !== 1) return fail("PAB1_ERR_VERSION");

	if (typeof obj.hostId !== "string" || !isValidSafeId(obj.hostId)) return fail("PAB1_ERR_ID");
	if (typeof obj.generation !== "string" || !isValidSafeId(obj.generation)) return fail("PAB1_ERR_ID");
	if (typeof obj.sessionId !== "string" || !isValidSafeId(obj.sessionId)) return fail("PAB1_ERR_ID");

	if (typeof obj.relayUrl !== "string") return fail("PAB1_ERR_RELAY_URL");
	const urlErr = isValidRelayUrl(obj.relayUrl);
	if (urlErr) return fail(urlErr);

	// Validate buildIdentity as an object (not null/primitive/array) BEFORE canonical check
	if (typeof obj.buildIdentity !== "object" || obj.buildIdentity === null || Array.isArray(obj.buildIdentity)) {
		return fail("PAB1_ERR_BUILD_IDENTITY");
	}
	const buildDescriptorErr = checkOwnDataDescriptors(obj.buildIdentity as Record<string, unknown>);
	if (buildDescriptorErr) return fail(buildDescriptorErr);

	const buildSeen = new Set<object>();
	if (hasCycleOrAlias(obj.buildIdentity, buildSeen)) return fail("PAB1_ERR_META_CYCLE");

	const buildKnownKeys = new Set(["buildId", "daemonProtocolVersion", "daemonSchemaRevision", "appVersion"]);
	for (const key of Object.keys(obj.buildIdentity as Record<string, unknown>)) {
		if (!buildKnownKeys.has(key)) return fail("PAB1_ERR_META_UNKNOWN");
	}
	const build = obj.buildIdentity as Record<string, unknown>;

	// buildId: exactly 64 lowercase hex
	if (typeof build.buildId !== "string" || !HEX64.test(build.buildId)) return fail("PAB1_ERR_BUILD_IDENTITY");
	// daemonProtocolVersion: non-negative integer
	if (!isNonNegativeInt(build.daemonProtocolVersion)) return fail("PAB1_ERR_BUILD_IDENTITY");
	// daemonSchemaRevision: non-negative integer
	if (!isNonNegativeInt(build.daemonSchemaRevision)) return fail("PAB1_ERR_BUILD_IDENTITY");
	// appVersion: absent or nonempty safe-id string
	if (build.appVersion !== undefined) {
		if (typeof build.appVersion !== "string" || !isValidSafeId(build.appVersion))
			return fail("PAB1_ERR_BUILD_IDENTITY");
	}

	// connectTimeoutMs: bounded positive integer
	if (!isPositiveInt(obj.connectTimeoutMs)) return fail("PAB1_ERR_TIMEOUT");
	if (obj.connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS) return fail("PAB1_ERR_TIMEOUT");

	const bi: ParsedMetadata["buildIdentity"] =
		build.appVersion !== undefined
			? {
					buildId: build.buildId as string,
					daemonProtocolVersion: build.daemonProtocolVersion as number,
					daemonSchemaRevision: build.daemonSchemaRevision as number,
					appVersion: build.appVersion as string,
				}
			: {
					buildId: build.buildId as string,
					daemonProtocolVersion: build.daemonProtocolVersion as number,
					daemonSchemaRevision: build.daemonSchemaRevision as number,
				};

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

function validateGrantBytes(grant: Uint8Array): Pab1ErrorCode | undefined {
	if (grant.byteLength < MIN_GRANT_BYTES || grant.byteLength > MAX_GRANT_BYTES) {
		return "PAB1_ERR_GRANT_LENGTH";
	}
	for (let i = 0; i < grant.byteLength; i++) {
		if (!isGrantByte(grant[i])) return "PAB1_ERR_GRANT_BYTE";
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// OneUseBootstrapGrant — private constructor via factory, frozen instance
// ---------------------------------------------------------------------------

/**
 * Wraps a one-time-use bootstrap grant.
 *
 * Created via `createOneUseBootstrapGrant`. `takeBytes()` succeeds exactly once.
 * Instance is frozen (private fields remain mutable). Branded — use `isOneUseBootstrapGrant`.
 * No toJSON/valueOf/toString/inspect exposes the secret content.
 */
export class OneUseBootstrapGrant {
	/** @internal Brand symbol for instanceof-style check. */
	readonly [GRANT_BRAND]: true;
	#bytes: Uint8Array | null;
	#state: GrantState;

	/** @internal Private constructor — use createOneUseBootstrapGrant. */
	constructor(bytes: Uint8Array, brand: symbol) {
		if (brand !== GRANT_BRAND) throw new Error("Private constructor");
		this[GRANT_BRAND] = true;
		this.#bytes = new Uint8Array(bytes);
		this.#state = "ready";
		Object.freeze(this);
	}

	/** Non-secret byte length. */
	get byteLength(): number {
		return this.#bytes?.byteLength ?? 0;
	}

	/** Non-secret status. */
	get status(): GrantState {
		return this.#state;
	}

	/**
	 * Take the owned grant bytes. Succeeds exactly once.
	 * Returns OkResult with the bytes on success, FailResult otherwise.
	 * Does not throw. The caller MUST zero the returned buffer.
	 */
	takeBytes(): Result<Uint8Array> {
		if (this.#state !== "ready") {
			if (this.#state === "consumed") return fail("PAB1_ERR_GRANT_CONSUMED");
			return fail("PAB1_ERR_GRANT_DISPOSED");
		}
		this.#state = "consumed";
		const out = this.#bytes!;
		this.#bytes = null;
		return ok(out);
	}

	/**
	 * Dispose the grant. Erases the private copy if unconsumed. Idempotent.
	 * Returns OkResult.
	 */
	dispose(): OkResult<undefined> {
		if (this.#state === "ready" && this.#bytes !== null) {
			safeZero(this.#bytes);
			this.#bytes = null;
			this.#state = "disposed";
		}
		return ok(undefined);
	}

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

type GrantState = "ready" | "consumed" | "disposed";

/** Check if a value is a genuine branded OneUseBootstrapGrant instance. */
export function isOneUseBootstrapGrant(v: unknown): v is OneUseBootstrapGrant {
	return v instanceof OneUseBootstrapGrant && (v as unknown as Record<symbol, unknown>)[GRANT_BRAND] === true;
}

/** Create a OneUseBootstrapGrant that owns a private copy of the given bytes. */
function createOneUseBootstrapGrant(bytes: Uint8Array): OneUseBootstrapGrant {
	return new OneUseBootstrapGrant(bytes, GRANT_BRAND);
}

// ---------------------------------------------------------------------------
// withBootstrapGrant
// ---------------------------------------------------------------------------

/**
 * Hand owned grant bytes to a callback, then always erase/dispose.
 * Thrown values are fixed-mapped (the helper does NOT stringify the grant).
 * Accepts only a genuine branded OneUseBootstrapGrant.
 */
export async function withBootstrapGrant<T>(
	grant: OneUseBootstrapGrant,
	fn: (bytes: Uint8Array) => Promise<T>,
): Promise<Result<T>> {
	if (!isOneUseBootstrapGrant(grant)) {
		return fail("PAB1_ERR_INVALID_BRAND");
	}
	let bytes: Uint8Array | undefined;
	try {
		const taken = grant.takeBytes();
		if (!taken.ok) {
			grant.dispose();
			return taken;
		}
		bytes = taken.value;
		let result: T;
		try {
			result = await fn(bytes);
		} catch {
			// Callback threw — fixed-map, do not stringify secret
			return fail("PAB1_ERR_GRANT_CONSUMED");
		}
		return ok(result);
	} finally {
		if (bytes !== undefined) {
			safeZero(bytes);
		}
		grant.dispose();
	}
}

// ---------------------------------------------------------------------------
// Node/depth preflight for metadata object
// ---------------------------------------------------------------------------

function _preflightNodeDepth(value: unknown, depth: number, budget: { nodes: number }): Pab1ErrorCode | undefined {
	if (depth > MAX_DEPTH) return "PAB1_ERR_DEPTH_LIMIT";
	if (budget.nodes <= 0) return "PAB1_ERR_NODE_LIMIT";
	budget.nodes -= 1;

	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return undefined;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const e = _preflightNodeDepth(value[i], depth + 1, budget);
			if (e) return e;
		}
		return undefined;
	}
	if (typeof value === "object") {
		const keys = Object.getOwnPropertyNames(value);
		for (const k of keys) {
			let v: unknown;
			try {
				v = (value as Record<string, unknown>)[k];
			} catch {
				return "PAB1_ERR_META_DESCRIPTOR";
			}
			const e = _preflightNodeDepth(v, depth + 1, budget);
			if (e) return e;
		}
		return undefined;
	}
	return "PAB1_ERR_META_TYPE";
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

export interface EncodeSandboxBootstrapPayloadOpts {
	metadata: MetadataOpts;
	/**
	 * Caller-owned mutable grant Uint8Array.
	 * This view is erased on every path after copying (when safely mutable).
	 */
	grant: Uint8Array;
}

/**
 * Encode a PAB1 sandbox bootstrap payload.
 *
 * Returns a fixed discriminated Result. Never throws for input issues.
 * The grant Uint8Array is erased on every reachable path when it is a
 * genuine non-shared ArrayBuffer-backed view.
 */
export function encodeSandboxBootstrapPayload(opts: EncodeSandboxBootstrapPayloadOpts): Result<Uint8Array> {
	// --- Step 0: validate opts ---
	if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}

	// Copy own data descriptors of opts before any reads — traps getters
	let optsKeys: string[];
	try {
		const descs = Object.getOwnPropertyDescriptors(opts);
		optsKeys = Object.getOwnPropertyNames(opts);
		for (const k of optsKeys) {
			const d = descs[k];
			if (d.get || d.set) return fail("PAB1_ERR_META_DESCRIPTOR");
			if (!d.enumerable) return fail("PAB1_ERR_META_NONENUMERABLE");
		}
	} catch {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}

	// Check for metadata/metadata fields getters
	if (typeof opts.metadata !== "object" || opts.metadata === null || Array.isArray(opts.metadata)) {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}
	const metaDescriptorErr = checkOwnDataDescriptors(opts.metadata as unknown as Record<string, unknown>);
	if (metaDescriptorErr) return fail(metaDescriptorErr);

	// Validate buildIdentity inside metadata
	const meta = opts.metadata as unknown as Record<string, unknown>;
	if (typeof meta.buildIdentity !== "object" || meta.buildIdentity === null || Array.isArray(meta.buildIdentity)) {
		return fail("PAB1_ERR_BUILD_IDENTITY");
	}
	// Check metadata descriptors for child objects before proceeding

	// --- Step 1: build canonical metadata JSON ---
	let metaJson: string;
	try {
		metaJson = buildCanonicalMetadataJson(opts.metadata);
	} catch {
		return fail("PAB1_ERR_ENCODE_FAILED");
	}
	const metaBytes = new TextEncoder().encode(metaJson);

	if (metaBytes.byteLength > MAX_META_BYTES) {
		safeZero(metaBytes);
		// Erase grant before returning
		const _ = safeCopyUint8Array(opts.grant, null);
		return fail("PAB1_ERR_META_OVERSIZE");
	}

	// --- Step 2: copy grant BEFORE validation (to erase original) ---
	const grantCopyResult = safeCopyUint8Array(opts.grant, opts.grant);
	if (!grantCopyResult.ok) {
		safeZero(metaBytes);
		return fail(grantCopyResult.code);
	}
	const grantCopy = grantCopyResult.value;
	// opts.grant is now zeroed if it was a mutable non-shared Uint8Array

	// --- Step 3: validate grant ---
	const grantErr = validateGrantBytes(grantCopy);
	if (grantErr) {
		safeZero(grantCopy);
		safeZero(metaBytes);
		return fail(grantErr);
	}

	const grantLen = grantCopy.byteLength;
	const totalLen = HEADER_OVERHEAD + metaBytes.byteLength + GRANT_LEN_FIELD + grantLen;

	if (totalLen > MAX_PAYLOAD_BYTES) {
		safeZero(grantCopy);
		safeZero(metaBytes);
		return fail("PAB1_ERR_OVERSIZE");
	}

	// --- Step 4: build payload ---
	const payload = new Uint8Array(totalLen);
	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

	try {
		payload.set(MAGIC, 0);
		dv.setUint32(MAGIC_LEN, metaBytes.byteLength);
		payload.set(metaBytes, HEADER_OVERHEAD);
		dv.setUint16(HEADER_OVERHEAD + metaBytes.byteLength, grantLen);
		payload.set(grantCopy, HEADER_OVERHEAD + metaBytes.byteLength + GRANT_LEN_FIELD);

		safeZero(metaBytes);
		safeZero(grantCopy);
		return ok(payload);
	} catch {
		safeZero(metaBytes);
		safeZero(grantCopy);
		safeZero(payload);
		return fail("PAB1_ERR_ENCODE_FAILED");
	}
}

// ---------------------------------------------------------------------------
// Decode result types
// ---------------------------------------------------------------------------

export interface SandboxBootstrapPayloadDecoded {
	readonly metadata: ParsedMetadata;
	readonly grant: OneUseBootstrapGrant;
}

/** Deep freeze an object. */
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
 * Erases the caller payload on EVERY success/failure path when safely mutable.
 * Returns a deeply frozen metadata DTO plus a brand-gated OneUseBootstrapGrant.
 */
export function decodeSandboxBootstrapPayload(payload: Uint8Array): Result<SandboxBootstrapPayloadDecoded> {
	// --- Step 0: validate input ---
	if (!(payload instanceof Uint8Array)) {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}

	let mutablePayload: Uint8Array;
	try {
		if (isDetachedOrShared(payload)) return fail("PAB1_ERR_INPUT_DETACHED");
		// Do NOT claim erasure for non-mutable. Use a copy for reading.
		// But we still try to erase the original if mutable.
		mutablePayload = payload;

		// Check for Proxy — access a property through the proto chain
		try {
			// eslint-disable-next-line @typescript-eslint/no-unused-expressions
			payload.byteLength;
		} catch {
			return fail("PAB1_ERR_INVALID_ARGUMENT");
		}
	} catch {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}

	// We'll try to erase the original at the end. If it's a Proxy, we can't reliably
	// claim erasure, but we don't throw — we just return the fixed result.
	let erasedOriginal = false;
	function erasePayload(): void {
		if (!erasedOriginal && isMutableUint8Array(mutablePayload)) {
			safeZero(mutablePayload);
			erasedOriginal = true;
		}
	}

	// --- Step 1: size preflight ---
	if (mutablePayload.byteLength < HEADER_OVERHEAD + GRANT_LEN_FIELD) {
		erasePayload();
		return fail("PAB1_ERR_TRUNCATED");
	}
	if (mutablePayload.byteLength > MAX_PAYLOAD_BYTES) {
		erasePayload();
		return fail("PAB1_ERR_OVERSIZE");
	}

	const dv = new DataView(mutablePayload.buffer, mutablePayload.byteOffset, mutablePayload.byteLength);

	// --- Step 2: magic check ---
	const magicSlice = mutablePayload.slice(0, MAGIC_LEN);
	const magicOk = constantTimeEqual(magicSlice, MAGIC);
	safeZero(magicSlice);
	if (!magicOk) {
		erasePayload();
		return fail("PAB1_ERR_MAGIC");
	}

	// --- Step 3: metadata length ---
	const metaLen = dv.getUint32(MAGIC_LEN);
	if (metaLen === 0 || metaLen > MAX_META_BYTES) {
		erasePayload();
		return fail(metaLen === 0 ? "PAB1_ERR_META_READ" : "PAB1_ERR_META_OVERSIZE");
	}

	const grantLenOffset = HEADER_OVERHEAD + metaLen;
	if (grantLenOffset + GRANT_LEN_FIELD > mutablePayload.byteLength) {
		erasePayload();
		return fail("PAB1_ERR_TRUNCATED");
	}

	// --- Step 4: read metadata bytes ---
	const metaBytes = mutablePayload.slice(HEADER_OVERHEAD, grantLenOffset);

	// --- Step 5: grant length ---
	const grantLen = dv.getUint16(grantLenOffset);
	if (grantLen < MIN_GRANT_BYTES || grantLen > MAX_GRANT_BYTES) {
		safeZero(metaBytes);
		erasePayload();
		return fail("PAB1_ERR_GRANT_LENGTH");
	}

	const grantEnd = grantLenOffset + GRANT_LEN_FIELD + grantLen;
	if (grantEnd > mutablePayload.byteLength) {
		safeZero(metaBytes);
		erasePayload();
		return fail("PAB1_ERR_TRUNCATED");
	}
	if (grantEnd !== mutablePayload.byteLength) {
		safeZero(metaBytes);
		erasePayload();
		return fail("PAB1_ERR_TRAILING");
	}

	// --- Step 6: read grant (copy before erasing payload) ---
	const grantRaw = mutablePayload.slice(grantLenOffset + GRANT_LEN_FIELD, grantEnd);

	// Erase caller payload NOW
	erasePayload();

	// --- Step 7: validate grant bytes ---
	for (let i = 0; i < grantRaw.byteLength; i++) {
		if (!isGrantByte(grantRaw[i])) {
			safeZero(grantRaw);
			safeZero(metaBytes);
			return fail("PAB1_ERR_GRANT_BYTE");
		}
	}

	// --- Step 8: parse metadata JSON ---
	let parsed: unknown;
	try {
		const metaStr = new TextDecoder("utf-8", { fatal: true }).decode(metaBytes);
		parsed = JSON.parse(metaStr);
	} catch {
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail("PAB1_ERR_META_PARSE");
	}

	// --- Step 9: validate schema FIRST (before canonical check) ---
	// This ensures buildIdentity is a valid object, not null/primitive
	const schemaResult = validateMetadataSchema(parsed);
	if (!schemaResult.ok) {
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail(schemaResult.code);
	}

	// --- Step 10: canonical JSON roundtrip check ---
	// Build fresh canonical JSON from the schema-validated data
	const freshMeta = schemaResult.value;
	const freshBuildIdentity: Record<string, unknown> = {
		buildId: freshMeta.buildIdentity.buildId,
		daemonProtocolVersion: freshMeta.buildIdentity.daemonProtocolVersion,
		daemonSchemaRevision: freshMeta.buildIdentity.daemonSchemaRevision,
	};
	if (freshMeta.buildIdentity.appVersion !== undefined) {
		freshBuildIdentity.appVersion = freshMeta.buildIdentity.appVersion;
	}
	const canonObj: Record<string, unknown> = {
		version: 1,
		hostId: freshMeta.hostId,
		generation: freshMeta.generation,
		sessionId: freshMeta.sessionId,
		relayUrl: freshMeta.relayUrl,
		buildIdentity: freshBuildIdentity,
		connectTimeoutMs: freshMeta.connectTimeoutMs,
	};
	const canonStr = JSON.stringify(canonObj);
	const canonBytes = new TextEncoder().encode(canonStr);

	if (!constantTimeEqual(canonBytes, metaBytes)) {
		safeZero(canonBytes);
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail("PAB1_ERR_META_NONCANONICAL");
	}
	safeZero(canonBytes);
	safeZero(metaBytes);

	// --- Step 11: construct result ---
	const frozenMeta = freezeDeep(schemaResult.value as unknown as Record<string, unknown>) as unknown as ParsedMetadata;
	const grantObj = createOneUseBootstrapGrant(grantRaw);
	safeZero(grantRaw);

	return ok({
		metadata: frozenMeta,
		grant: grantObj,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	let diff = 0;
	for (let i = 0; i < a.byteLength; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}
