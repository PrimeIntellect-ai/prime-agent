import { types } from "node:util";
/**
 * Execution location types for the coding agent.
 *
 * Defines JSON-safe discriminated unions for execution placement and
 * sandbox connection health.  Execution placement identifies *where*
 * code runs; connection health tracks the *transport state* to that
 * location.  The two concerns are kept separate so a location object
 * is immutable identity data while connection health is a live field
 * that may transition independently.
 *
 * No credential, secret, or provider-internal URL is carried in any
 * type exported from this module.
 */

export type SandboxConnectionHealth =
	| { readonly status: "connected"; readonly connectedAt: string }
	| { readonly status: "connecting"; readonly startedAt: string }
	| { readonly status: "reconnecting"; readonly attempt: number; readonly since: string }
	| { readonly status: "unreachable"; readonly error: UnreachableErrorCode; readonly failedAt: string }
	| { readonly status: "closed" };

export interface RemoteModelDescriptor {
	readonly provider: string;
	readonly modelId: string;
	readonly name?: string;
}

export interface RemoteSessionDescriptor {
	readonly sessionId: string;
	readonly createdAt: string;
	readonly lastActiveAt: string;
	readonly executionLocation: ExecutionLocation;
	readonly model?: RemoteModelDescriptor;
}

export type ExecutionLocation = { readonly type: "local" } | { readonly type: "prime-sandbox" };

// ---------------------------------------------------------------------------
// Descriptor snapshot helper — strict hostile-proof validation
// ---------------------------------------------------------------------------

/**
 * Validate an unknown value as a plain object with only own enumerable
 * value properties.  Returns the names and descriptors if valid;
 * returns undefined for Proxy, custom/null prototype, symbols, accessors,
 * non-enumerable keys, throwing getters, or non-object primitives.
 */
function snapshotDescriptor(
	value: unknown,
): { readonly names: readonly string[]; readonly descriptors: Readonly<PropertyDescriptorMap> } | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		if (Array.isArray(value)) return undefined;
		if (types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	} catch {
		return undefined;
	}
	if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
	const names = Object.getOwnPropertyNames(value);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const name of names) {
		const d = descriptors[name];
		if (!d || !("value" in d) || !d.enumerable) return undefined;
	}
	return { names, descriptors };
}
// ---------------------------------------------------------------------------
// SandboxOptions – validated daemon-protocol descriptor (no secrets, no raw values)
// ---------------------------------------------------------------------------

/** JSON-safe sandbox session descriptor. No credentials, host paths, or provider config. */
export interface SandboxOptions {
	readonly region?: string;
}

/**
 * Normalize and validate an unknown value as SandboxOptions.
 *
 * Strict descriptor validation (Proxy, non-Object prototype, symbols,
 * accessor descriptors, non-enumerable keys all rejected).  Only the
 * known key "region" is accepted.  Returns a frozen copy.
 * Does NOT echo the rejected value in the error message.
 */
export function normalizeSandboxOptions(value: unknown): SandboxOptions | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		if (Array.isArray(value)) return undefined;
		if (types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	} catch {
		return undefined;
	}
	if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
	const names = Object.getOwnPropertyNames(value);
	if (names.length > 1) return undefined;
	for (const name of names) {
		if (name !== "region") return undefined;
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const name of Object.keys(descriptors)) {
		const d = descriptors[name];
		if (!d || !("value" in d) || !d.enumerable) return undefined;
	}
	if (names.length === 1) {
		const dRegion = descriptors.region;
		if (!dRegion || !("value" in dRegion) || !dRegion.enumerable) return undefined;
		const regionValue = dRegion.value;
		if (regionValue !== undefined) {
			if (typeof regionValue !== "string") return undefined;
			if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(regionValue)) return undefined;
			return Object.freeze({ region: regionValue });
		}
		return undefined;
	}
	return Object.freeze({});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ISO8601_STRICT_RE =
	/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:0\d|1[0-3]):[0-5]\d)$/;

const DAYS_IN_MONTH: readonly number[] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
	return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/**
 * Returns true when `s` is a strict canonical ISO-8601 string with explicit
 * timezone offset, bounded length (max 29 chars), and component validation
 * that rejects impossible dates (Feb 30, Apr 31, etc.).  The strict regex
 * ensures format; component bounds reject overflow dates.  Maximum length
 * prevents ReDoS from pathological patterns.
 */
export function isValidISODateString(s: string): boolean {
	if (typeof s !== "string") return false;
	if (s.length > 29) return false;
	const m = ISO8601_STRICT_RE.exec(s);
	if (!m) return false;
	const year = Number(s.slice(0, 4));
	const month = Number(s.slice(5, 7));
	const day = Number(s.slice(8, 10));
	if (month < 1 || month > 12) return false;
	const maxDay = DAYS_IN_MONTH[month] + (month === 2 && isLeapYear(year) ? 1 : 0);
	if (day < 1 || day > maxDay) return false;
	const ms = Date.parse(s);
	return Number.isFinite(ms);
}

// ---------------------------------------------------------------------------
// Safe unreachable error codes — never arbitrary exception text
// ---------------------------------------------------------------------------

export type UnreachableErrorCode =
	| "timeout"
	| "auth_failed"
	| "not_found"
	| "provider_error"
	| "network_error"
	| "unknown";

const VALID_UNREACHABLE_CODES: ReadonlySet<string> = new Set<UnreachableErrorCode>([
	"timeout",
	"auth_failed",
	"not_found",
	"provider_error",
	"network_error",
	"unknown",
]);

/** Type predicate for UnreachableErrorCode. No cast needed. */
function isUnreachableErrorCode(value: string): value is UnreachableErrorCode {
	return VALID_UNREACHABLE_CODES.has(value);
}

/**
 * Convert an arbitrary error string to a safe UnreachableErrorCode.
 * Unknown values map to "unknown".  Never leaks arbitrary text.
 */
export function toUnreachableErrorCode(error: string | undefined): UnreachableErrorCode {
	if (typeof error === "string" && isUnreachableErrorCode(error)) return error;
	return "unknown";
}

// ---------------------------------------------------------------------------
// Bounded printable text — control / length / non-printable rejection
// ---------------------------------------------------------------------------

const MAX_PRINTABLE_LENGTH = 256;

/**
 * Returns true when `s` is a non-empty string of printable ASCII characters
 * (code points 0x21–0x7E) with length at most MAX_PRINTABLE_LENGTH.
 * Rejects empty string, control characters, non-printable, and oversized input.
 */
function isValidPrintableText(s: unknown): s is string {
	if (typeof s !== "string") return false;
	if (s.length === 0 || s.length > MAX_PRINTABLE_LENGTH) return false;
	for (let i = 0; i < s.length; i++) {
		const code = s.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

export function normalizeExecutionLocation(value: unknown): ExecutionLocation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		if (Array.isArray(value)) return undefined;
		if (types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
	} catch {
		return undefined;
	}
	if (Object.getOwnPropertySymbols(value).length !== 0) return undefined;
	const names = Object.getOwnPropertyNames(value);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	for (const name of names) {
		const d = descriptors[name];
		if (!d || !("value" in d) || !d.enumerable) return undefined;
	}
	if (names.length === 1 && names[0] === "type") {
		const dType = descriptors.type;
		if (!dType || !("value" in dType) || !dType.enumerable) return undefined;
		if (dType.value === "local") return Object.freeze({ type: "local" });
		if (dType.value === "prime-sandbox") return Object.freeze({ type: "prime-sandbox" });
	}
	return undefined;
}

export function normalizeSandboxConnectionHealth(value: unknown): SandboxConnectionHealth | undefined {
	const d = snapshotDescriptor(value);
	if (!d) return undefined;
	const { names, descriptors } = d;
	const dStatus = descriptors.status;
	if (!dStatus || !("value" in dStatus) || !dStatus.enumerable) return undefined;
	const status = dStatus.value;

	if (status === "connected") {
		if (names.length !== 2 || !names.includes("status") || !names.includes("connectedAt")) return undefined;
		const dConnectedAt = descriptors.connectedAt;
		if (!dConnectedAt || !("value" in dConnectedAt) || !dConnectedAt.enumerable) return undefined;
		const connectedAt = dConnectedAt.value;
		if (typeof connectedAt !== "string" || !isValidISODateString(connectedAt)) return undefined;
		return Object.freeze({ status: "connected", connectedAt });
	}

	if (status === "connecting") {
		if (names.length !== 2 || !names.includes("status") || !names.includes("startedAt")) return undefined;
		const dStartedAt = descriptors.startedAt;
		if (!dStartedAt || !("value" in dStartedAt) || !dStartedAt.enumerable) return undefined;
		const startedAt = dStartedAt.value;
		if (typeof startedAt !== "string" || !isValidISODateString(startedAt)) return undefined;
		return Object.freeze({ status: "connecting", startedAt });
	}

	if (status === "reconnecting") {
		if (names.length !== 3 || !names.includes("status") || !names.includes("attempt") || !names.includes("since"))
			return undefined;
		const dAttempt = descriptors.attempt;
		if (!dAttempt || !("value" in dAttempt) || !dAttempt.enumerable) return undefined;
		const attempt = dAttempt.value;
		if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 0) return undefined;
		const dSince = descriptors.since;
		if (!dSince || !("value" in dSince) || !dSince.enumerable) return undefined;
		const since = dSince.value;
		if (typeof since !== "string" || !isValidISODateString(since)) return undefined;
		return Object.freeze({ status: "reconnecting", attempt, since });
	}

	if (status === "unreachable") {
		if (names.length !== 3 || !names.includes("status") || !names.includes("error") || !names.includes("failedAt"))
			return undefined;
		const dError = descriptors.error;
		if (!dError || !("value" in dError) || !dError.enumerable) return undefined;
		const error = dError.value;
		if (typeof error !== "string" || !isUnreachableErrorCode(error)) return undefined;
		const dFailedAt = descriptors.failedAt;
		if (!dFailedAt || !("value" in dFailedAt) || !dFailedAt.enumerable) return undefined;
		const failedAt = dFailedAt.value;
		if (typeof failedAt !== "string" || !isValidISODateString(failedAt)) return undefined;
		return Object.freeze({ status: "unreachable", error, failedAt });
	}

	if (status === "closed") {
		if (names.length !== 1 || names[0] !== "status") return undefined;
		return Object.freeze({ status: "closed" });
	}

	return undefined;
}

export function normalizeRemoteModelDescriptor(value: unknown): RemoteModelDescriptor | undefined {
	const d = snapshotDescriptor(value);
	if (!d) return undefined;
	const { names, descriptors } = d;

	// Reject secret-bearing keys unconditionally.
	if (names.includes("apiKey") || names.includes("baseUrl") || names.includes("token")) return undefined;

	// Accept only the known keys: provider, modelId (required), name (optional).
	const known = new Set(["provider", "modelId", "name"]);
	if (names.some((n) => !known.has(n))) return undefined;

	if (names.length < 2 || !names.includes("provider") || !names.includes("modelId")) return undefined;

	const dProvider = descriptors.provider;
	if (!dProvider || !("value" in dProvider) || !dProvider.enumerable) return undefined;
	const provider = dProvider.value;
	if (!isValidPrintableText(provider)) return undefined;

	const dModelId = descriptors.modelId;
	if (!dModelId || !("value" in dModelId) || !dModelId.enumerable) return undefined;
	const modelId = dModelId.value;
	if (!isValidPrintableText(modelId)) return undefined;

	let name: string | undefined;
	if (names.includes("name")) {
		const dName = descriptors.name;
		if (!dName || !("value" in dName) || !dName.enumerable) return undefined;
		const nameVal = dName.value;
		if (!isValidPrintableText(nameVal)) return undefined;
		name = nameVal;
	}

	return Object.freeze({ provider, modelId, ...(name !== undefined ? { name } : {}) });
}

export function normalizeRemoteSessionDescriptor(value: unknown): RemoteSessionDescriptor | undefined {
	const d = snapshotDescriptor(value);
	if (!d) return undefined;
	const { names, descriptors } = d;

	// Accept only known keys: sessionId, createdAt, lastActiveAt, executionLocation (required), model (optional).
	const known = new Set(["sessionId", "createdAt", "lastActiveAt", "executionLocation", "model"]);
	if (names.some((n) => !known.has(n))) return undefined;

	if (
		names.length < 4 ||
		!names.includes("sessionId") ||
		!names.includes("createdAt") ||
		!names.includes("lastActiveAt") ||
		!names.includes("executionLocation")
	)
		return undefined;

	const dSessionId = descriptors.sessionId;
	if (!dSessionId || !("value" in dSessionId) || !dSessionId.enumerable) return undefined;
	const sessionId = dSessionId.value;
	if (!isValidPrintableText(sessionId)) return undefined;

	const dCreatedAt = descriptors.createdAt;
	if (!dCreatedAt || !("value" in dCreatedAt) || !dCreatedAt.enumerable) return undefined;
	const createdAt = dCreatedAt.value;
	if (typeof createdAt !== "string" || !isValidISODateString(createdAt)) return undefined;

	const dLastActiveAt = descriptors.lastActiveAt;
	if (!dLastActiveAt || !("value" in dLastActiveAt) || !dLastActiveAt.enumerable) return undefined;
	const lastActiveAt = dLastActiveAt.value;
	if (typeof lastActiveAt !== "string" || !isValidISODateString(lastActiveAt)) return undefined;

	const dExecLoc = descriptors.executionLocation;
	if (!dExecLoc || !("value" in dExecLoc) || !dExecLoc.enumerable) return undefined;
	const executionLocation = normalizeExecutionLocation(dExecLoc.value);
	if (!executionLocation) return undefined;

	let model: RemoteModelDescriptor | undefined;
	if (names.includes("model")) {
		const dModel = descriptors.model;
		if (!dModel || !("value" in dModel) || !dModel.enumerable) return undefined;
		model = normalizeRemoteModelDescriptor(dModel.value);
		if (!model) return undefined;
	}

	return Object.freeze({
		sessionId,
		createdAt,
		lastActiveAt,
		executionLocation,
		...(model !== undefined ? { model } : {}),
	});
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

export function validateExecutionLocation(value: unknown): ExecutionLocation {
	const normalised = normalizeExecutionLocation(value);
	if (normalised) return normalised;
	throw new ExecutionLocationError("Invalid ExecutionLocation value");
}

export function validateSandboxConnectionHealth(value: unknown): SandboxConnectionHealth {
	const normalised = normalizeSandboxConnectionHealth(value);
	if (normalised) return normalised;
	throw new ExecutionLocationError("Invalid SandboxConnectionHealth value");
}

export function validateRemoteModelDescriptor(value: unknown): RemoteModelDescriptor {
	const normalised = normalizeRemoteModelDescriptor(value);
	if (normalised) return normalised;
	throw new ExecutionLocationError("Invalid RemoteModelDescriptor value");
}

export function validateRemoteSessionDescriptor(value: unknown): RemoteSessionDescriptor {
	const normalised = normalizeRemoteSessionDescriptor(value);
	if (normalised) return normalised;
	throw new ExecutionLocationError("Invalid RemoteSessionDescriptor value");
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Error thrown when an execution-location value fails validation.
 * Does NOT carry the raw input so credentials cannot leak into logs.
 */
export class ExecutionLocationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExecutionLocationError";
	}
}
