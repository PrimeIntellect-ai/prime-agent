/**
 * PAB1 — Payload Bootstrap v1 binary codec for B14 sandbox bootstrap.
 *
 * Every intermediate buffer is zeroed before return. Public encode/decode return
 * fixed discriminated Result and never throw for input issues (outer catch handles
 * allocation/hostile failures with erasure).
 *
 * No dynamic imports, no require, no sync fs/process, no Buffer subarray alias.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAGIC = new Uint8Array([0x50, 0x41, 0x42, 0x31]);
const MAGIC_LEN = 4;
const META_LEN_FIELD = 4;
const GRANT_LEN_FIELD = 2;
const HEADER_OVERHEAD = MAGIC_LEN + META_LEN_FIELD;

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
	return b !== 0x22 && b !== 0x3a && b !== 0x5c;
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
	| "PAB1_ERR_META_DESCRIPTOR"
	| "PAB1_ERR_META_NONENUMERABLE"
	| "PAB1_ERR_META_PROTOTYPE"
	| "PAB1_ERR_META_SYMBOL"
	| "PAB1_ERR_URL_CANONICAL"
	| "PAB1_ERR_URL_PRIVATE"
	| "PAB1_ERR_URL_HOST"
	| "PAB1_ERR_GRANT_FORGE"
	| "PAB1_ERR_CALLBACK_FAILED"
	| "PAB1_ERR_INPUT_SUBARRAY";

// ---------------------------------------------------------------------------
// Result types
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

function isGenuineUint8Array(v: unknown): v is Uint8Array {
	if (!v || typeof v !== "object") return false;
	try {
		if (Object.getPrototypeOf(v) !== Uint8Array.prototype) return false;
		const buf = (v as Uint8Array).buffer;
		const bufProto = Object.getPrototypeOf(buf);
		if (bufProto !== ArrayBuffer.prototype) return false;
		// Require exact byte views: byteOffset===0, byteLength===buffer.byteLength
		const u = v as Uint8Array;
		if (u.byteOffset !== 0) return false;
		const ab = buf as ArrayBuffer;
		if (u.byteLength !== ab.byteLength) return false;
		return true;
	} catch {
		return false;
	}
}

/** True if the backing buffer is detached. Uses an intrinsic that throws. */
function isDetachedBuffer(buf: ArrayBuffer): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		buf.slice(0, 0);
		return false;
	} catch {
		return true;
	}
}

function isDetachedView(v: Uint8Array): boolean {
	return isDetachedBuffer(v.buffer as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Safe buffer helpers
// ---------------------------------------------------------------------------

function safeZero(buf: Uint8Array | null | undefined): void {
	if (!buf) return;
	try {
		if (buf.byteLength > 0 && isGenuineUint8Array(buf) && !isDetachedView(buf)) {
			buf.fill(0);
		}
	} catch {
		/* best effort */
	}
}

function _copyBytes(source: Uint8Array): Uint8Array {
	const out = new Uint8Array(source.byteLength);
	out.set(source);
	return out;
}

/** Copy grant bytes and erase original if genuine. Returns Result. */
function copyGrant(grant: unknown): Result<Uint8Array> {
	if (!isGenuineUint8Array(grant)) {
		if (grant === null || grant === undefined) return fail("PAB1_ERR_INVALID_ARGUMENT");
		if (typeof grant === "object") {
			try {
				const proto = Object.getPrototypeOf(grant);
				if (typeof Buffer !== "undefined" && proto === Buffer.prototype) return fail("PAB1_ERR_INPUT_SUBCLASS");
				if (proto === Uint8Array.prototype) {
					const buf = (grant as Uint8Array).buffer;
					if (
						typeof SharedArrayBuffer !== "undefined" &&
						Object.getPrototypeOf(buf) === SharedArrayBuffer.prototype
					)
						return fail("PAB1_ERR_INPUT_SHARED");
					const u = grant as Uint8Array;
					if (u.byteOffset !== 0 || u.byteLength !== buf.byteLength) return fail("PAB1_ERR_INPUT_SUBARRAY");
					return fail("PAB1_ERR_INPUT_DETACHED");
				}
			} catch {
				return fail("PAB1_ERR_INPUT_PROXY");
			}
		}
		return fail("PAB1_ERR_INVALID_ARGUMENT");
	}
	if (isDetachedView(grant)) return fail("PAB1_ERR_INPUT_DETACHED");
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
// OneUseBootstrapGrant
// ---------------------------------------------------------------------------

const grantBrandSet = new WeakSet<object>();

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
		if (this.#state !== "ready")
			return fail(this.#state === "consumed" ? "PAB1_ERR_GRANT_CONSUMED" : "PAB1_ERR_GRANT_DISPOSED");
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
}

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
// ID / number helpers
// ---------------------------------------------------------------------------

function isValidSafeId(v: unknown): v is string {
	return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH && SAFE_ID_RE.test(v);
}
function isNonNegativeInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
function isPositiveInt(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

// ---------------------------------------------------------------------------
// URL validation — reject ALL literal IP addresses
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

	// Reject ALL literal IPv4
	if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return "PAB1_ERR_URL_HOST";
	// Reject ALL bracketed IPv6
	if (hostname.startsWith("[") && hostname.endsWith("]")) return "PAB1_ERR_URL_HOST";

	const hn = hostname.toLowerCase();
	if (hn === "localhost" || hn.endsWith(".localhost") || hn.endsWith(".local")) return "PAB1_ERR_URL_PRIVATE";

	// DNS label validation
	const labels = hostname.split(".");
	for (const label of labels) {
		if (label.length === 0 || label.length > 63) return "PAB1_ERR_URL_HOST";
		if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(label)) return "PAB1_ERR_URL_HOST";
	}

	// Path: nonempty, safe segments, no empty/repeated slashes, no dot segments
	const path = parsed.pathname;
	if (!path || path === "/") return "PAB1_ERR_URL_PATH";
	if (path.length > MAX_URL_PATH_LENGTH) return "PAB1_ERR_URL_PATH";
	const segments = path.split("/");
	// path starts with / so first is ""
	if (segments[0] !== "") return "PAB1_ERR_URL_PATH";
	for (let i = 1; i < segments.length; i++) {
		const s = segments[i];
		if (s.length === 0) return "PAB1_ERR_URL_PATH";
		if (s === "." || s === "..") return "PAB1_ERR_URL_PATH";
		for (let j = 0; j < s.length; j++) {
			const cp = s.charCodeAt(j);
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

	const canUrl = `wss://${hostname}${path}`;
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
// Snapshot-based metadata validation — copies descriptor values, never re-reads
// ---------------------------------------------------------------------------

/** Snapshot the own enumerable data descriptor values of a plain object into a fresh structure. */
/**
 * Recursively snapshot a value through own data descriptors only.
 * Returns a fresh structure with no references to the original objects,
 * rejecting proxies/getters/non-enumerables/non-plain prototypes/symbols,
 * cycles/aliases, and depth/node overflow during the walk.
 */
function snapshotValue(v: unknown, seen: Set<object>, depth: number, budget: { nodes: number }): Result<unknown> {
	if (depth > MAX_DEPTH) return fail("PAB1_ERR_DEPTH_LIMIT");
	if (budget.nodes <= 0) return fail("PAB1_ERR_NODE_LIMIT");
	budget.nodes -= 1;

	if (v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
		return ok(v);
	}
	if (Array.isArray(v)) {
		if (seen.has(v as object)) return fail("PAB1_ERR_META_CYCLE");
		seen.add(v as object);
		const arr: unknown[] = [];
		for (let i = 0; i < v.length; i++) {
			const e = snapshotValue(v[i], seen, depth + 1, budget);
			if (!e.ok) return e;
			arr.push(e.value);
		}
		return ok(arr);
	}
	if (typeof v === "object") {
		if (seen.has(v as object)) return fail("PAB1_ERR_META_CYCLE");
		seen.add(v as object);

		let proto: object | null;
		try {
			proto = Object.getPrototypeOf(v);
		} catch {
			return fail("PAB1_ERR_META_PROTOTYPE");
		}
		if (proto !== null && proto !== Object.prototype) return fail("PAB1_ERR_META_PROTOTYPE");

		try {
			if (Object.getOwnPropertySymbols(v).length > 0) return fail("PAB1_ERR_META_SYMBOL");
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}

		let keys: string[];
		let descs: PropertyDescriptorMap;
		try {
			keys = Object.getOwnPropertyNames(v);
			descs = Object.getOwnPropertyDescriptors(v);
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}

		const out: Record<string, unknown> = {};
		for (const k of keys) {
			const d = descs[k];
			if (!d) return fail("PAB1_ERR_META_DESCRIPTOR");
			if (d.get || d.set) return fail("PAB1_ERR_META_DESCRIPTOR");
			if (!d.enumerable) return fail("PAB1_ERR_META_NONENUMERABLE");
			const sub = snapshotValue(d.value, seen, depth + 1, budget);
			if (!sub.ok) return sub;
			out[k] = sub.value;
		}
		return ok(out);
	}
	return fail("PAB1_ERR_META_TYPE");
}

/**
 * Full metadata validation: recursively snapshot descriptor values,
 * then validate the fresh snapshot. Never re-reads the original objects.
 */
function sanitizeMetadata(raw: unknown) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("PAB1_ERR_INVALID_ARGUMENT");
	const snapResult = snapshotValue(raw, new Set<object>(), 0, { nodes: MAX_NODES });
	if (!snapResult.ok) return snapResult;
	const snap = snapResult.value as Record<string, unknown>;
	return validateMetadataSnapshot(snap);
}

/** Validate a fresh snapshot of metadata (never re-reads the original). */
function validateMetadataSnapshot(snapshot: Record<string, unknown>): Result<{
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
	const knownKeys = new Set([
		"version",
		"hostId",
		"generation",
		"sessionId",
		"relayUrl",
		"buildIdentity",
		"connectTimeoutMs",
	]);
	const snapshotKeys = Object.getOwnPropertyNames(snapshot);
	for (const k of snapshotKeys) {
		if (!knownKeys.has(k)) return fail("PAB1_ERR_META_UNKNOWN");
	}
	const required = new Set(["hostId", "generation", "sessionId", "relayUrl", "buildIdentity", "connectTimeoutMs"]);
	for (const k of required) {
		if (!snapshotKeys.includes(k)) return fail("PAB1_ERR_META_MISSING");
	}

	if (snapshotKeys.includes("version") && snapshot.version !== 1) return fail("PAB1_ERR_VERSION");

	if (!isValidSafeId(snapshot.hostId)) return fail("PAB1_ERR_ID");
	if (!isValidSafeId(snapshot.generation)) return fail("PAB1_ERR_ID");
	if (!isValidSafeId(snapshot.sessionId)) return fail("PAB1_ERR_ID");

	const urlErr = isValidRelayUrl(snapshot.relayUrl);
	if (urlErr) return fail(urlErr);

	// buildIdentity — snapshot is a fresh plain object
	const bi = snapshot.buildIdentity;
	if (typeof bi !== "object" || bi === null || Array.isArray(bi)) return fail("PAB1_ERR_BUILD_IDENTITY");
	const biSnapshot = bi as Record<string, unknown>;

	const buildKnown = new Set(["buildId", "daemonProtocolVersion", "daemonSchemaRevision", "appVersion"]);
	const biKeys = Object.getOwnPropertyNames(biSnapshot);
	for (const k of biKeys) {
		if (!buildKnown.has(k)) return fail("PAB1_ERR_META_UNKNOWN");
	}

	if (typeof biSnapshot.buildId !== "string" || !HEX64.test(biSnapshot.buildId))
		return fail("PAB1_ERR_BUILD_IDENTITY");
	if (!isNonNegativeInt(biSnapshot.daemonProtocolVersion)) return fail("PAB1_ERR_BUILD_IDENTITY");
	if (!isNonNegativeInt(biSnapshot.daemonSchemaRevision)) return fail("PAB1_ERR_BUILD_IDENTITY");
	if (biSnapshot.appVersion !== undefined && !isValidSafeId(biSnapshot.appVersion))
		return fail("PAB1_ERR_BUILD_IDENTITY");

	if (!isPositiveInt(snapshot.connectTimeoutMs) || snapshot.connectTimeoutMs > MAX_CONNECT_TIMEOUT_MS)
		return fail("PAB1_ERR_TIMEOUT");

	const r = {
		version: 1,
		hostId: snapshot.hostId as string,
		generation: snapshot.generation as string,
		sessionId: snapshot.sessionId as string,
		relayUrl: snapshot.relayUrl as string,
		buildIdentity:
			biSnapshot.appVersion !== undefined
				? {
						buildId: biSnapshot.buildId as string,
						daemonProtocolVersion: biSnapshot.daemonProtocolVersion as number,
						daemonSchemaRevision: biSnapshot.daemonSchemaRevision as number,
						appVersion: biSnapshot.appVersion as string,
					}
				: {
						buildId: biSnapshot.buildId as string,
						daemonProtocolVersion: biSnapshot.daemonProtocolVersion as number,
						daemonSchemaRevision: biSnapshot.daemonSchemaRevision as number,
					},
		connectTimeoutMs: snapshot.connectTimeoutMs as number,
	};
	return ok(r);
}

// ---------------------------------------------------------------------------
// Canonical JSON builder
// ---------------------------------------------------------------------------

function buildCanonicalMetadataJson(meta: {
	version: number;
	hostId: string;
	generation: string;
	sessionId: string;
	relayUrl: string;
	buildIdentity: { buildId: string; daemonProtocolVersion: number; daemonSchemaRevision: number; appVersion?: string };
	connectTimeoutMs: number;
}): string {
	const bi: Record<string, unknown> = {
		buildId: meta.buildIdentity.buildId,
		daemonProtocolVersion: meta.buildIdentity.daemonProtocolVersion,
		daemonSchemaRevision: meta.buildIdentity.daemonSchemaRevision,
	};
	if (meta.buildIdentity.appVersion !== undefined) bi.appVersion = meta.buildIdentity.appVersion;
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

export async function withBootstrapGrant<T>(
	grant: IOneUseBootstrapGrant,
	fn: (bytes: Uint8Array) => Promise<T>,
): Promise<Result<T>> {
	if (!isBrandedGrant(grant)) return fail("PAB1_ERR_INVALID_BRAND");
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
		if (bytes !== undefined) safeZero(bytes);
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

export function encodeSandboxBootstrapPayload(opts: EncodeSandboxBootstrapPayloadOpts): Result<Uint8Array> {
	let grantCopy: Uint8Array | undefined;

	try {
		if (typeof opts !== "object" || opts === null || Array.isArray(opts)) return fail("PAB1_ERR_INVALID_ARGUMENT");

		// Get descriptors first so we can acquire+erase grant ASAP
		let ownKeys: string[];
		let descs: PropertyDescriptorMap;
		try {
			ownKeys = Object.getOwnPropertyNames(opts);
			descs = Object.getOwnPropertyDescriptors(opts);
		} catch {
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}

		// Acquire and erase grant from descriptor.value BEFORE any other validation
		// This ensures grant is zeroed even if opts has structural issues later.
		let grantValue: unknown;
		let grantDescOk = false;
		const grantIdx = ownKeys.indexOf("grant");
		if (grantIdx >= 0) {
			const gd = descs.grant!;
			if (gd && !gd.get && !gd.set && gd.enumerable) {
				grantDescOk = true;
				try {
					grantValue = gd.value;
				} catch {
					/* best effort */
				}
			}
		}
		if (grantDescOk) {
			const grantResult = copyGrant(grantValue);
			if (grantResult.ok) {
				grantCopy = grantResult.value;
			} // else grant was not a genuine Uint8Array; no need to copy
		}

		// Now validate the rest of opts structure
		let proto: object | null;
		try {
			proto = Object.getPrototypeOf(opts);
		} catch {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}
		if (proto !== null && proto !== Object.prototype) {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_META_PROTOTYPE");
		}
		try {
			if (Object.getOwnPropertySymbols(opts).length > 0) {
				safeZero(grantCopy);
				grantCopy = undefined;
				return fail("PAB1_ERR_META_SYMBOL");
			}
		} catch {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_META_DESCRIPTOR");
		}

		for (const k of ownKeys) {
			const d = descs[k];
			if (!d) {
				safeZero(grantCopy);
				grantCopy = undefined;
				return fail("PAB1_ERR_META_DESCRIPTOR");
			}
			if (d.get || d.set) {
				safeZero(grantCopy);
				grantCopy = undefined;
				return fail("PAB1_ERR_META_DESCRIPTOR");
			}
			if (!d.enumerable) {
				safeZero(grantCopy);
				grantCopy = undefined;
				return fail("PAB1_ERR_META_NONENUMERABLE");
			}
		}
		const expected = new Set(["metadata", "grant"]);
		for (const k of ownKeys) {
			if (!expected.has(k)) {
				safeZero(grantCopy);
				grantCopy = undefined;
				return fail("PAB1_ERR_META_UNKNOWN");
			}
		}
		if (!ownKeys.includes("metadata") || !ownKeys.includes("grant")) {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail("PAB1_ERR_META_MISSING");
		}

		// Validate grant bytes
		if (!grantCopy) {
			return fail("PAB1_ERR_INVALID_ARGUMENT");
		}
		const gErr = validateGrantBytes(grantCopy);
		if (gErr) {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail(gErr);
		}

		// Validate grant bytes
		const grantErr = validateGrantBytes(grantCopy);
		if (grantErr) {
			safeZero(grantCopy);
			grantCopy = undefined;
			return fail(grantErr);
		}

		// Acquire metadata from descriptor.value (not opts.metadata)
		let metaValue: unknown;
		try {
			metaValue = descs.metadata!.value;
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

		// Build payload
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

function validateGrantBytes(grant: Uint8Array): Pab1ErrorCode | undefined {
	if (grant.byteLength < MIN_GRANT_BYTES || grant.byteLength > MAX_GRANT_BYTES) return "PAB1_ERR_GRANT_LENGTH";
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
		frozen[key] =
			val !== null && typeof val === "object" && !Array.isArray(val)
				? freezeDeep(val as Record<string, unknown>)
				: val;
	}
	return Object.freeze(frozen) as T;
}

export function decodeSandboxBootstrapPayload(payload: Uint8Array): Result<SandboxBootstrapPayloadDecoded> {
	try {
		// Validate input
		if (!isGenuineUint8Array(payload)) {
			if (payload === null || payload === undefined) return fail("PAB1_ERR_INVALID_ARGUMENT");
			if (typeof payload === "object") {
				try {
					const proto = Object.getPrototypeOf(payload);
					if (typeof Buffer !== "undefined" && proto === Buffer.prototype) return fail("PAB1_ERR_INPUT_SUBCLASS");
					if (proto === Uint8Array.prototype) {
						const u = payload as Uint8Array;
						const buf = u.buffer;
						if (
							typeof SharedArrayBuffer !== "undefined" &&
							Object.getPrototypeOf(buf) === SharedArrayBuffer.prototype
						)
							return fail("PAB1_ERR_INPUT_SHARED");
						if (u.byteOffset !== 0 || u.byteLength !== buf.byteLength) return fail("PAB1_ERR_INPUT_SUBARRAY");
						return fail("PAB1_ERR_INPUT_DETACHED");
					}
				} catch {
					return fail("PAB1_ERR_INPUT_PROXY");
				}
			}
			return fail("PAB1_ERR_INVALID_ARGUMENT");
		}
		if (isDetachedView(payload)) return fail("PAB1_ERR_INPUT_DETACHED");

		return decodeImpl(payload);
	} catch {
		safeZero(payload);
		return fail("PAB1_ERR_ENCODE_FAILED");
	}
}

function decodeImpl(payload: Uint8Array): Result<SandboxBootstrapPayloadDecoded> {
	if (payload.byteLength < HEADER_OVERHEAD + GRANT_LEN_FIELD) {
		safeZero(payload);
		return fail("PAB1_ERR_TRUNCATED");
	}
	if (payload.byteLength > MAX_PAYLOAD_BYTES) {
		safeZero(payload);
		return fail("PAB1_ERR_OVERSIZE");
	}

	const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

	const magicSlice = payload.slice(0, MAGIC_LEN);
	const magicOk = constantTimeEqual(magicSlice, MAGIC);
	safeZero(magicSlice);
	if (!magicOk) {
		safeZero(payload);
		return fail("PAB1_ERR_MAGIC");
	}

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
	safeZero(payload); // erase caller after copy

	for (let i = 0; i < grantRaw.byteLength; i++) {
		if (!isGrantByte(grantRaw[i])) {
			safeZero(grantRaw);
			safeZero(metaBytes);
			return fail("PAB1_ERR_GRANT_BYTE");
		}
	}

	let parsed: unknown;
	try {
		const metaStr = new TextDecoder("utf-8", { fatal: true }).decode(metaBytes);
		parsed = JSON.parse(metaStr);
	} catch {
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail("PAB1_ERR_META_PARSE");
	}

	const schemaResult = sanitizeMetadata(parsed);
	if (!schemaResult.ok) {
		safeZero(grantRaw);
		safeZero(metaBytes);
		return fail(schemaResult.code);
	}
	const meta = schemaResult.value;

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

	const frozenMeta = freezeDeep(
		meta as unknown as Record<string, unknown>,
	) as unknown as SandboxBootstrapPayloadDecoded["metadata"];
	const grantObj = createGrant(grantRaw);
	safeZero(grantRaw);

	const value: SandboxBootstrapPayloadDecoded = Object.freeze({ metadata: frozenMeta, grant: grantObj });
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
