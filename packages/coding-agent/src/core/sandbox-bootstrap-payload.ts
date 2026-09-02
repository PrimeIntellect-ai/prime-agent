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
 * Encode/decode return fixed discriminated Result and never throw for input issues.
 * Input grant/payload views are copied immediately and erased on every reachable path
 * when backed by a genuine non-shared ArrayBuffer.
 * OneUseBootstrapGrant instances are created only by the decoder and tracked via
 * internal WeakSet; the constructor and brand token are not exported.
 *
 * No dynamic imports, no require, no sync fs/process, no Buffer subarray alias.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGIC = new Uint8Array([0x50, 0x41, 0x42, 0x31]); // PAB1
const MAGIC_LEN = 4;
const META_LEN_FIELD = 4;
const GRANT_LEN_FIELD = 2;
const HEADER_OVERHEAD = MAGIC_LEN + META_LEN_FIELD; // 8

const MAX_META_BYTES = 16 * 1024;
const MAX_GRANT_BYTES = 128;
const MIN_GRANT_BYTES = 32;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_CONNECT_TIMEOUT_MS = 300_000;
const MAX_ID_LENGTH = 128;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_URL_PATH_LENGTH = 1024;
const MAX_DEPTH = 64;
const MAX_NODES = 10_000;

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function isGrantByte(b: number): boolean {
	if (b < 0x21 || b > 0x7e) return false;
	if (b === 0x22 || b === 0x3a || b === 0x5c) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Error code union
// ---------------------------------------------------------------------------

export type Pab1ErrorCode =
	| "PAB1_ERR_MAGIC"
	| "PAB1_ERR_META_OVERSIZE"
	| "PAB1_ERR_META_READ"
	| "PAB1_ERR_META_PARSE"
	| "PAB1_ERR_META_UNKNOWN"
	| "PAB1_ERR_META_TYPE"
	| "PAB1_ERR_META_NONCANONICAL"
	| "PAB1_ERR_META_MISSING"
	| "PAB1_ERR_GRANT_LENGTH"
	| "PAB1_ERR_GRANT_BYTE"
	| "PAB1_ERR_TRAILING"
	| "PAB1_ERR_OVERSIZE"
	| "PAB1_ERR_TRUNCATED"
	| "PAB1_ERR_RELAY_URL"
	| "PAB1_ERR_URL_PATH"
	| "PAB1_ERR_ID"
	| "PAB1_ERR_BUILD_IDENTITY"
	| "PAB1_ERR_TIMEOUT"
	| "PAB1_ERR_VERSION"
	| "PAB1_ERR_GRANT_CONSUMED"
	| "PAB1_ERR_GRANT_DISPOSED"
	| "PAB1_ERR_INVALID_ARGUMENT"
	| "PAB1_ERR_INVALID_BRAND"
	| "PAB1_ERR_INPUT_DETACHED"
	| "PAB1_ERR_INPUT_SHARED"
	| "PAB1_ERR_INPUT_PROXY"
	| "PAB1_ERR_INPUT_SUBCLASS"
	| "PAB1_ERR_ENCODE_FAILED"
	| "PAB1_ERR_NODE_LIMIT"
	| "PAB1_ERR_DEPTH_LIMIT"
	| "PAB1_ERR_META_CYCLE"
	| "PAB1_ERR_META_ALIAS"
	| "PAB1_ERR_META_DESCRIPTOR"
	| "PAB1_ERR_META_NONENUMERABLE"
	| "PAB1_ERR_META_PROTOTYPE"
	| "PAB1_ERR_META_SYMBOL"
	| "PAB1_ERR_URL_CANONICAL"
	| "PAB1_ERR_URL_PRIVATE"
	| "PAB1_ERR_URL_HOST"
	| "PAB1_ERR_GRANT_FORGE"
	| "PAB1_ERR_CALLBACK_FAILED";

// ---------------------------------------------------------------------------
// Discriminated Result types — frozen
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
// Genuine Uint8Array detection
// ---------------------------------------------------------------------------

/** True for a real Uint8Array with exact Uint8Array prototype and non-shared ArrayBuffer. */
function isGenuineUint8Array(v: unknown): v is Uint8Array {
	if (v === null || v === undefined) return false;
	if (typeof v !== "object") return false;
	try {
		if (Object.getPrototypeOf(v) !== Uint8Array.prototype) return false;
		const buf = (v as Uint8Array).buffer;
		const bufProto = Object.getPrototypeOf(buf);
		return bufProto === ArrayBuffer.prototype;
	} catch {
		return false;
	}
}

/** Check if a genuine Uint8Array's backing buffer is detached. */
function isDetached(buf: Uint8Array): boolean {
	try {
		// Detached ArrayBuffer throws when byteLength is accessed on some engines
		const ab = buf.buffer;
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		ab.byteLength;
		// Also check that the Uint8Array view is still valid
		if (buf.byteLength === 0 && buf.length === 0) {
			// All-zero-length could be legitimately empty; check buffer byteLength
			const bl = ab.byteLength;
			if (bl === 0) return false; // empty but valid
		}
		return false;
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Safe buffer helpers
// ---------------------------------------------------------------------------

function safeZero(buf: Uint8Array | null | undefined): void {
	if (!buf) return;
	try {
		if (buf.byteLength > 0 && isGenuineUint8Array(buf) && !isDetached(buf)) {
			buf.fill(0);
		}
	} catch {
		// best effort
	}
}

/** Copy bytes into a fresh ArrayBuffer-backed Uint8Array. */
function _copyBytes(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.byteLength);
	out.set(source);
	return out;
}

/** Copy grant bytes and erase original if genuine. Returns Result. */
function copyGrant(grant: Uint8Array): Result<Uint8Array> {
	if (!isGenuineUint8Array(grant)) {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}
	if (isDetached(grant)) {
		return fail("PAB1_ERR_INPUT_DETACHED");
	}
	const out = new Uint8Array(grant.byteLength);
	try {
		out.set(grant);
	} catch {
		return fail("PAB1_ERR_ENCODE_FAILED");
	}
	safeZero(grant);
	return ok(out);
}

// ---------------------------------------------------------------------------
// OneUseBootstrapGrant — module-private implementation
// ---------------------------------------------------------------------------

const grantBrandSet = new WeakSet<object>();

/** Public interface for a one-time-use bootstrap grant. */
export interface IOneUseBootstrapGrant {
	readonly byteLength: number;
	readonly status: "ready" | "consumed" | "disposed";
	takeBytes(): Result<Uint8Array>;
	dispose(): OkResult<undefined>;
	toJSON(): undefined;
	toString(): string;
	valueOf(): this;
	[Symbol.toPrimitive](): string;
}

class OneUseBootstrapGrantImpl implements IOneUseBootstrapGrant {
	#bytes: Uint8Array | null;
	#state: "ready" | "consumed" | "disposed";

	constructor(bytes: Uint8Array) {
		this.#bytes = new Uint8Array(bytes);
		this.#state = "ready";
		grantBrandSet.add(this);
		Object.freeze(this);
	}

	get byteLength(): number {
		return this.#bytes?.byteLength ?? 0;
	}

	get status(): "ready" | "consumed" | "disposed" {
		return this.#state;
	}

	takeBytes(): Result<Uint8Array> {
		if (this.#state !== "ready") {
			return fail(this.#state === "consumed" ? "PAB1_ERR_GRANT_CONSUMED" : "PAB1_ERR_GRANT_DISPOSED");
		}
		this.#state = "consumed";
		const out = this.#bytes!;
		this.#bytes = null;
		return ok(out);
	}

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

/** Safe brand check: returns false for any non-object, Proxy that traps getPrototypeOf, etc. */
function isBrandedGrant(v: unknown): v is IOneUseBootstrapGrant {
	if (!v || typeof v !== "object") return false;
	try {
		return grantBrandSet.has(v);
	} catch {
		return false;
	}
}

function createGrant(bytes: Uint8Array): IOneUseBootstrapGrant {
	return new OneUseBootstrapGrantImpl(bytes);
}

// ---------------------------------------------------------------------------
// Safe ID / number validation
// ---------------------------------------------------------------------------

function isValidSafeId(id: unknown): id is string {
	return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH && SAFE_ID_RE.test(id);
}

function isNonNegativeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function isValidRelayUrl(url: unknown): Pab1ErrorCode | undefined {
	if (typeof url !== "string") return "PAB1_ERR_RELAY_URL";
	if (!url.startsWith("wss://")) return "PAB1_ERR_RELAY_URL";

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "PAB1_ERR_RELAY_URL";
	}

	if (parsed.protocol !== "wss:") return "PAB1_ERR_RELAY_URL";
	if (parsed.username || parsed.password) return "PAB1_ERR_RELAY_URL";
	if (parsed.search || parsed.hash) return "PAB1_ERR_RELAY_URL";
	if (parsed.port) return "PAB1_ERR_URL_CANONICAL";

	const hostname = parsed.hostname;
	if (!hostname || hostname.length > MAX_HOSTNAME_LENGTH) return "PAB1_ERR_URL_HOST";

	const hn = hostname.toLowerCase();
	if (hn === "localhost" || hn.endsWith(".localhost") || hn.endsWith(".local")) return "PAB1_ERR_URL_PRIVATE";

	// Reject all literal IPv4 patterns
	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) {
		if (/^127\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^169\.254\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^10\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^192\.168\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		// CGNAT 100.64.0.0/10, 198.18.0.0/15, multicast 224-239.x.x.x
		if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^198\.1[89]\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
		if (/^22[4-9]\.|^23[0-9]\./.test(hostname)) return "PAB1_ERR_URL_PRIVATE";
	}

	// Bracketed IPv6
	if (hostname.startsWith("[")) {
		const ipv6 = hostname.slice(1, -1);
		if (ipv6 === "::1") return "PAB1_ERR_URL_PRIVATE";
		const lc6 = ipv6.toLowerCase();
		if (lc6.startsWith("fe80")) return "PAB1_ERR_URL_PRIVATE";
		if (lc6.startsWith("fc") || lc6.startsWith("fd")) return "PAB1_ERR_URL_PRIVATE";
	}

	// DNS label validation for non-IP hostnames
	if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) && !hostname.startsWith("[")) {
		const labels = hostname.split(".");
		for (const label of labels) {
			if (label.length === 0 || label.length > 63) return "PAB1_ERR_URL_HOST";
			if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) return "PAB1_ERR_URL_HOST";
		}
	}

	// Path validation: safe segments, nonempty, bounded
	if (!parsed.pathname || parsed.pathname === "/") return "PAB1_ERR_URL_PATH";
	if (parsed.pathname.length > MAX_URL_PATH_LENGTH) return "PAB1_ERR_URL_PATH";
	// Path segments: only unreserved ASCII characters, no percent-encoding,
	// no dot segments. Prime Tunnel uses DNS hostnames only, no literal IPs.
	const segments = parsed.pathname.split("/").filter(Boolean);
	for (const seg of segments) {
		if (seg === ".." || seg === ".") return "PAB1_ERR_URL_PATH";
		if (seg.length === 0) return "PAB1_ERR_URL_PATH";
		for (let i = 0; i < seg.length; i++) {
			const cp = seg.charCodeAt(i);
			// Allow A-Z, a-z, 0-9, ., _, ~, -
			if (
				!(cp >= 0x41 && cp <= 0x5a) &&
				!(cp >= 0x61 && cp <= 0x7a) &&
				!(cp >= 0x30 && cp <= 0x39) &&
				cp !== 0x2e &&
				cp !== 0x5f &&
				cp !== 0x7e &&
				cp !== 0x2d
			)
				return "PAB1_ERR_URL_PATH";
		}
	}

	// Canonical URL equality
	const canUrl = `wss://${hostname}${parsed.pathname}`;
	if (canUrl !== url) return "PAB1_ERR_URL_CANONICAL";

	return undefined;
}

// ---------------------------------------------------------------------------
// Metadata types
// ---------------------------------------------------------------------------

export interface BuildIdentityOpts {
	readonly buildId: string;
	readonly daemonProtocolVersion: number;
	readonly daemonSchemaRevision: number;
	readonly appVersion?: string;
}

export interface MetadataOpts {
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly relayUrl: string;
	readonly buildIdentity: BuildIdentityOpts;
	readonly connectTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Node/depth preflight
// ---------------------------------------------------------------------------

function preflightNodeDepth(value: unknown, depth: number, budget: { nodes: number }): Pab1ErrorCode | undefined {
	if (depth > MAX_DEPTH) return "PAB1_ERR_DEPTH_LIMIT";
	if (budget.nodes <= 0) return "PAB1_ERR_NODE_LIMIT";
	budget.nodes -= 1;

	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return undefined;
	}
	if (Array.isArray(value)) {
		for (let i = 0; i < value.length; i++) {
			const e = preflightNodeDepth(value[i], depth + 1, budget);
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
			const e = preflightNodeDepth(v, depth + 1, budget);
			if (e) return e;
		}
		return undefined;
	}
	return "PAB1_ERR_META_TYPE";
}

// ---------------------------------------------------------------------------
// Safe plain-object metadata acquisition
// ---------------------------------------------------------------------------

/** Safely acquire metadata as a fresh plain-object copy, rejecting proxies/getters/symbols/non-plain-protos. */
function sanitizeMetadata(raw: unknown): Result<{
	version: number;
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
}> {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}

	// Reject non-plain prototype
	let proto: object | null;
	try {
		proto = Object.getPrototypeOf(raw);
	} catch {
		return fail("PAB1_ERR_META_PROTOTYPE");
	}
	if (proto !== null && proto !== Object.prototype) return fail("PAB1_ERR_META_PROTOTYPE");

	// Reject symbols
	try {
		if (Object.getOwnPropertySymbols(raw).length > 0) return fail("PAB1_ERR_META_SYMBOL");
	} catch {
		return fail("PAB1_ERR_META_DESCRIPTOR");
	}

	// Check all own enumerable data descriptors
	let ownKeys: string[];
	let descs: PropertyDescriptorMap;
	try {
		ownKeys = Object.getOwnPropertyNames(raw);
		descs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return fail("PAB1_ERR_META_DESCRIPTOR");
	}
	for (const k of ownKeys) {
		const d = descs[k];
		if (!d) return fail("PAB1_ERR_META_DESCRIPTOR");
		if (d.get || d.set) return fail("PAB1_ERR_META_DESCRIPTOR");
		if (!d.enumerable) return fail("PAB1_ERR_META_NONENUMERABLE");
	}

	// Node/depth preflight
	const budget = { nodes: MAX_NODES };
	const pf = preflightNodeDepth(raw, 0, budget);
	if (pf) return fail(pf);

	// Cycle/alias check
	const seen = new Set<object>();
	if (hasCycleOrAlias(raw, seen)) return fail("PAB1_ERR_META_CYCLE");

	// Read and validate fields
	const obj = raw as Record<string, unknown>;
	const knownKeys = new Set([
		"version",
		"hostId",
		"generation",
		"sessionId",
		"relayUrl",
		"buildIdentity",
		"connectTimeoutMs",
	]);
	for (const k of ownKeys) {
		if (!knownKeys.has(k)) return fail("PAB1_ERR_META_UNKNOWN");
	}
	// Check all required keys present
	const required = new Set(["hostId", "generation", "sessionId", "relayUrl", "buildIdentity", "connectTimeoutMs"]);
	for (const k of required) {
		if (!ownKeys.includes(k)) return fail("PAB1_ERR_META_MISSING");
	}

	// version is required in parsed JSON (decode path) but optional in encode input
	if (ownKeys.includes("version") && obj.version !== 1) return fail("PAB1_ERR_VERSION");
	if (!isValidSafeId(obj.hostId)) return fail("PAB1_ERR_ID");
	if (!isValidSafeId(obj.generation)) return fail("PAB1_ERR_ID");
	if (!isValidSafeId(obj.sessionId)) return fail("PAB1_ERR_ID");

	const urlErr = isValidRelayUrl(obj.relayUrl);
	if (urlErr) return fail(urlErr);

	// Validate buildIdentity
	if (typeof obj.buildIdentity !== "object" || obj.buildIdentity === null || Array.isArray(obj.buildIdentity)) {
		return fail("PAB1_ERR_BUILD_IDENTITY");
	}
	const bi = obj.buildIdentity as Record<string, unknown>;

	// Check buildIdentity descriptors/prototype/symbols
	try {
		const biProto = Object.getPrototypeOf(bi);
		if (biProto !== null && biProto !== Object.prototype) return fail("PAB1_ERR_BUILD_IDENTITY");
		if (Object.getOwnPropertySymbols(bi).length > 0) return fail("PAB1_ERR_BUILD_IDENTITY");
		const biDescs = Object.getOwnPropertyDescriptors(bi);
		const biKeys = Object.getOwnPropertyNames(bi);
		for (const k of biKeys) {
			const d = biDescs[k];
			if (!d || d.get || d.set) return fail("PAB1_ERR_BUILD_IDENTITY");
			if (!d.enumerable) return fail("PAB1_ERR_BUILD_IDENTITY");
		}
	} catch {
		return fail("PAB1_ERR_BUILD_IDENTITY");
	}

	const buildKnownKeys = new Set(["buildId", "daemonProtocolVersion", "daemonSchemaRevision", "appVersion"]);
	for (const k of Object.getOwnPropertyNames(bi)) {
		if (!buildKnownKeys.has(k)) return fail("PAB1_ERR_META_UNKNOWN");
	}

	if (typeof bi.buildId !== "string" || !HEX64.test(bi.buildId)) return fail("PAB1_ERR_BUILD_IDENTITY");
	if (!isNonNegativeInt(bi.daemonProtocolVersion)) return fail("PAB1_ERR_BUILD_IDENTITY");
	if (!isNonNegativeInt(bi.daemonSchemaRevision)) return fail("PAB1_ERR_BUILD_IDENTITY");
	if (bi.appVersion !== undefined) {
		if (!isValidSafeId(bi.appVersion)) return fail("PAB1_ERR_BUILD_IDENTITY");
	}

	if (!isPositiveInt(obj.connectTimeoutMs)) return fail("PAB1_ERR_TIMEOUT");
	if (obj.connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS) return fail("PAB1_ERR_TIMEOUT");

	const result: {
		version: number;
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
	} = {
		version: 1,
		hostId: obj.hostId as string,
		generation: obj.generation as string,
		sessionId: obj.sessionId as string,
		relayUrl: obj.relayUrl as string,
		buildIdentity:
			bi.appVersion !== undefined
				? {
						buildId: bi.buildId as string,
						daemonProtocolVersion: bi.daemonProtocolVersion as number,
						daemonSchemaRevision: bi.daemonSchemaRevision as number,
						appVersion: bi.appVersion as string,
					}
				: {
						buildId: bi.buildId as string,
						daemonProtocolVersion: bi.daemonProtocolVersion as number,
						daemonSchemaRevision: bi.daemonSchemaRevision as number,
					},
		connectTimeoutMs: obj.connectTimeoutMs as number,
	};

	return ok(result);
}

function hasCycleOrAlias(value: unknown, seen: Set<object>): boolean {
	if (value === null || typeof value !== "object") return false;
	try {
		if (seen.has(value as object)) return true;
		seen.add(value as object);
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				if (hasCycleOrAlias(value[i], seen)) return true;
			}
		} else if (typeof value === "object") {
			const keys = Object.getOwnPropertyNames(value);
			for (const k of keys) {
				const v = (value as Record<string, unknown>)[k];
				if (hasCycleOrAlias(v, seen)) return true;
			}
		}
		return false;
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// Canonical JSON
// ---------------------------------------------------------------------------

function buildCanonicalMetadataJson(meta: {
	version: number;
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
}): string {
	const bi: Record<string, unknown> = {
		buildId: meta.buildIdentity.buildId,
		daemonProtocolVersion: meta.buildIdentity.daemonProtocolVersion,
		daemonSchemaRevision: meta.buildIdentity.daemonSchemaRevision,
	};
	if (meta.buildIdentity.appVersion !== undefined) {
		bi.appVersion = meta.buildIdentity.appVersion;
	}
	const obj: Record<string, unknown> = {
		version: 1,
		hostId: meta.hostId,
		generation: meta.generation,
		sessionId: meta.sessionId,
		relayUrl: meta.relayUrl,
		buildIdentity: bi,
		connectTimeoutMs: meta.connectTimeoutMs,
	};
	return JSON.stringify(obj);
}

// ---------------------------------------------------------------------------
// withBootstrapGrant
// ---------------------------------------------------------------------------

/**
 * Hand owned grant bytes to a callback, then always erase/dispose.
 * Callback errors are fixed-mapped to CALLBACK_FAILED.
 */
export async function withBootstrapGrant<T>(
	grant: IOneUseBootstrapGrant,
	fn: (bytes: Uint8Array) => Promise<T>,
): Promise<Result<T>> {
	if (!isBrandedGrant(grant)) {
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
			return fail("PAB1_ERR_CALLBACK_FAILED");
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
// Encode
// ---------------------------------------------------------------------------

export interface EncodeSandboxBootstrapPayloadOpts {
	readonly metadata: MetadataOpts;
	readonly grant: Uint8Array;
}

/**
 * Encode a PAB1 sandbox bootstrap payload.
 *
 * Safely acquires metadata descriptors, copies+erases grant immediately,
 * then validates metadata schema. Returns fixed Result.
 */
export function encodeSandboxBootstrapPayload(opts: EncodeSandboxBootstrapPayloadOpts): Result<Uint8Array> {
	// --- Acquire grant bytes first (copy+erase immediately) ---
	let grantCopy: Uint8Array | undefined;

	try {
		if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
			return fail("PAB1_ERR_INVALID_ARGUMENT");
		}
		// Check opts prototype
		let optsProto: object | null;
		try {
			optsProto = Object.getPrototypeOf(opts);
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}
		if (optsProto !== null && optsProto !== Object.prototype) return fail("PAB1_ERR_META_DESCRIPTOR");

		// Check opts own enumerable data descriptors
		let optsDescs: PropertyDescriptorMap;
		let optsKeys: string[];
		try {
			optsKeys = Object.getOwnPropertyNames(opts);
			optsDescs = Object.getOwnPropertyDescriptors(opts);
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}
		for (const k of optsKeys) {
			const d = optsDescs[k];
			if (!d) return fail("PAB1_ERR_META_DESCRIPTOR");
			if (d.get || d.set) return fail("PAB1_ERR_META_DESCRIPTOR");
			if (!d.enumerable) return fail("PAB1_ERR_META_NONENUMERABLE");
		}
		const expectedOptsKeys = new Set(["metadata", "grant"]);
		for (const k of optsKeys) {
			if (!expectedOptsKeys.has(k)) return fail("PAB1_ERR_META_UNKNOWN");
		}
		if (!optsKeys.includes("metadata") || !optsKeys.includes("grant")) {
			return fail("PAB1_ERR_META_MISSING");
		}

		// Take grant from descriptor, never re-read opts.grant
		let grantValue: unknown;
		try {
			grantValue = optsDescs.grant.value;
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}
		const grantResult = copyGrant(grantValue as Uint8Array);
		if (!grantResult.ok) {
			return fail(grantResult.code);
		}
		grantCopy = grantResult.value;

		// Validate grant length/bytes
		const grantErr = validateGrantBytes(grantCopy);
		if (grantErr) {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail(grantErr);
		}

		// --- Validate metadata (after grant is safe) ---
		// Take metadata from descriptor, never re-read opts.metadata
		let metaValue: unknown;
		try {
			metaValue = optsDescs.metadata.value;
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}
		const metaResult = sanitizeMetadata(metaValue);
		if (!metaResult.ok) {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail(metaResult.code);
		}
		const meta = metaResult.value;

		// Build canonical JSON
		const metaJson = buildCanonicalMetadataJson(meta);
		const metaBytes = new TextEncoder().encode(metaJson);

		if (metaBytes.byteLength > MAX_META_BYTES) {
			safeZero(metaBytes);
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_META_OVERSIZE");
		}

		const totalLen = HEADER_OVERHEAD + metaBytes.byteLength + GRANT_LEN_FIELD + grantCopy.byteLength;
		if (totalLen > MAX_PAYLOAD_BYTES) {
			safeZero(metaBytes);
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_OVERSIZE");
		}

		const payload = new Uint8Array(totalLen);
		const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
		try {
			payload.set(MAGIC, 0);
			dv.setUint32(MAGIC_LEN, metaBytes.byteLength);
			payload.set(metaBytes, HEADER_OVERHEAD);
			dv.setUint16(HEADER_OVERHEAD + metaBytes.byteLength, grantCopy.byteLength);
			payload.set(grantCopy, HEADER_OVERHEAD + metaBytes.byteLength + GRANT_LEN_FIELD);

			safeZero(metaBytes);
			safeZero(grantCopy);
			grantCopy = undefined;
			return ok(payload);
		} catch {
			safeZero(metaBytes);
			safeZero(payload);
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_ENCODE_FAILED");
		}
	} catch {
		if (grantCopy) safeZero(grantCopy);
		return fail("PAB1_ERR_ENCODE_FAILED");
	}
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
// Decode
// ---------------------------------------------------------------------------

export interface SandboxBootstrapPayloadDecoded {
	readonly metadata: {
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
	};
	readonly grant: IOneUseBootstrapGrant;
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

/**
 * Decode a PAB1 sandbox bootstrap payload.
 * Returns a deeply frozen metadata DTO plus a brand-gated IOneUseBootstrapGrant.
 */
export function decodeSandboxBootstrapPayload(payload: Uint8Array): Result<SandboxBootstrapPayloadDecoded> {
	// --- Validate input ---
	if (!isGenuineUint8Array(payload)) {
		if (payload === null || payload === undefined) return fail("PAB1_ERR_INVALID_ARGUMENT");
		if (typeof payload === "object") {
			try {
				const proto = Object.getPrototypeOf(payload);
				if (proto !== Uint8Array.prototype) {
					if (typeof Buffer !== "undefined" && proto === Buffer.prototype) return fail("PAB1_ERR_INPUT_SUBCLASS");
					return fail("PAB1_ERR_INPUT_PROXY");
				}
				const bufProto = Object.getPrototypeOf((payload as Uint8Array).buffer);
				if (bufProto === SharedArrayBuffer.prototype) return fail("PAB1_ERR_INPUT_SHARED");
				return fail("PAB1_ERR_INPUT_DETACHED");
			} catch {
				return fail("PAB1_ERR_INPUT_PROXY");
			}
		}
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}
	if (isDetached(payload)) return fail("PAB1_ERR_INPUT_DETACHED");

	// --- Size preflight ---
	if (payload.byteLength < HEADER_OVERHEAD + GRANT_LEN_FIELD) {
		safeZero(payload);
		return fail("PAB1_ERR_TRUNCATED");
	}
	if (payload.byteLength > MAX_PAYLOAD_BYTES) {
		safeZero(payload);
		return fail("PAB1_ERR_OVERSIZE");
	}

	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

	// --- Magic ---
	const magicSlice = payload.slice(0, MAGIC_LEN);
	const magicOk = constantTimeEqual(magicSlice, MAGIC);
	safeZero(magicSlice);
	if (!magicOk) {
		safeZero(payload);
		return fail("PAB1_ERR_MAGIC");
	}

	// --- Metadata length ---
	const metaLen = dv.getUint32(MAGIC_LEN);
	if (metaLen === 0 || metaLen > MAX_META_BYTES) {
		safeZero(payload);
		return fail(metaLen === 0 ? "PAB1_ERR_META_READ" : "PAB1_ERR_META_OVERSIZE");
	}

	const grantLenOffset = HEADER_OVERHEAD + metaLen;
	if (grantLenOffset + GRANT_LEN_FIELD > payload.byteLength) {
		safeZero(payload);
		return fail("PAB1_ERR_TRUNCATED");
	}

	const metaBytes = payload.slice(HEADER_OVERHEAD, grantLenOffset);
	const grantLen = dv.getUint16(grantLenOffset);

	if (grantLen < MIN_GRANT_BYTES || grantLen > MAX_GRANT_BYTES) {
		safeZero(metaBytes);
		safeZero(payload);
		return fail("PAB1_ERR_GRANT_LENGTH");
	}

	const grantEnd = grantLenOffset + GRANT_LEN_FIELD + grantLen;
	if (grantEnd > payload.byteLength) {
		safeZero(metaBytes);
		safeZero(payload);
		return fail("PAB1_ERR_TRUNCATED");
	}
	if (grantEnd !== payload.byteLength) {
		safeZero(metaBytes);
		safeZero(payload);
		return fail("PAB1_ERR_TRAILING");
	}

	const grantRaw = payload.slice(grantLenOffset + GRANT_LEN_FIELD, grantEnd);
	safeZero(payload); // erase caller view after copy

	// --- Validate grant bytes ---
	for (let i = 0; i < grantRaw.byteLength; i++) {
		if (!isGrantByte(grantRaw[i])) {
			safeZero(grantRaw);
			safeZero(metaBytes);
			return fail("PAB1_ERR_GRANT_BYTE");
		}
	}

	// --- Parse metadata JSON ---
	let parsed: unknown;
	try {
		const metaStr = new TextDecoder("utf-8", { fatal: true }).decode(metaBytes);
		parsed = JSON.parse(metaStr);
	} catch {
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail("PAB1_ERR_META_PARSE");
	}

	// --- Validate schema ---
	const schemaResult = sanitizeMetadata(parsed);
	if (!schemaResult.ok) {
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail(schemaResult.code);
	}
	const meta = schemaResult.value;

	// --- Canonical JSON roundtrip ---
	const canonStr = buildCanonicalMetadataJson(meta);
	const canonBytes = new TextEncoder().encode(canonStr);
	if (!constantTimeEqual(canonBytes, metaBytes)) {
		safeZero(canonBytes);
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail("PAB1_ERR_META_NONCANONICAL");
	}
	safeZero(canonBytes);
	safeZero(metaBytes);

	// --- Build result ---
	const frozenMeta = freezeDeep(
		meta as unknown as Record<string, unknown>,
	) as unknown as SandboxBootstrapPayloadDecoded["metadata"];
	const grantObj = createGrant(grantRaw);
	safeZero(grantRaw);

	const value: SandboxBootstrapPayloadDecoded = Object.freeze({
		metadata: frozenMeta,
		grant: grantObj,
	});
	return ok(value);
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
