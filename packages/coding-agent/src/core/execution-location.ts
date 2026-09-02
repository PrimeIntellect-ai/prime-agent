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
	| { readonly status: "unreachable"; readonly error: string; readonly failedAt: string }
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

export type ExecutionLocation =
	| { readonly type: "local" }
	| { readonly type: "prime-sandbox"; readonly sandboxId: string; readonly region?: string };

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
		const regionValue = descriptors.region!.value;
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

/**
 * Returns true when `s` is a valid ISO-8601 date string that parses to
 * a finite number *and* ends with a timezone indicator (Z, +HH:mm, -HH:mm).
 * Rejects bare dates, impossible month/day values, and timestamps that
 * omit an explicit offset.
 */
export function isValidISODateString(s: string): boolean {
	if (typeof s !== "string") return false;
	const ms = Date.parse(s);
	if (!Number.isFinite(ms)) return false;
	// Require an explicit timezone suffix: Z, +HH:mm, or -HH:mm
	return /[Zz]|[+-]\d{2}:\d{2}$/.test(s);
}

// ---------------------------------------------------------------------------
// Normalisers
// ---------------------------------------------------------------------------

export function normalizeExecutionLocation(value: unknown): ExecutionLocation | undefined {
	if (typeof value !== "object" || value === null) return undefined;

	const obj = value as Record<string, unknown>;
	const type = obj.type;

	if (type === "local") {
		return { type: "local" };
	}

	if (type === "prime-sandbox") {
		if (typeof obj.sandboxId !== "string" || obj.sandboxId.length === 0) return undefined;
		const region = typeof obj.region === "string" && obj.region.length > 0 ? obj.region : undefined;
		return { type: "prime-sandbox", sandboxId: obj.sandboxId, region };
	}

	return undefined;
}

export function normalizeSandboxConnectionHealth(value: unknown): SandboxConnectionHealth | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const obj = value as Record<string, unknown>;
	const status = obj.status;

	if (status === "connected") {
		if (typeof obj.connectedAt !== "string" || !isValidISODateString(obj.connectedAt)) return undefined;
		return { status: "connected", connectedAt: obj.connectedAt };
	}

	if (status === "connecting") {
		if (typeof obj.startedAt !== "string" || !isValidISODateString(obj.startedAt)) return undefined;
		return { status: "connecting", startedAt: obj.startedAt };
	}

	if (status === "reconnecting") {
		if (typeof obj.attempt !== "number" || obj.attempt < 0) return undefined;
		if (typeof obj.since !== "string" || !isValidISODateString(obj.since)) return undefined;
		return { status: "reconnecting", attempt: obj.attempt, since: obj.since };
	}

	if (status === "unreachable") {
		if (typeof obj.error !== "string" || obj.error.length === 0) return undefined;
		if (typeof obj.failedAt !== "string" || !isValidISODateString(obj.failedAt)) return undefined;
		return { status: "unreachable", error: obj.error, failedAt: obj.failedAt };
	}

	if (status === "closed") {
		return { status: "closed" };
	}

	return undefined;
}

export function normalizeRemoteModelDescriptor(value: unknown): RemoteModelDescriptor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const obj = value as Record<string, unknown>;

	if (typeof obj.provider !== "string" || obj.provider.length === 0) return undefined;
	if (typeof obj.modelId !== "string" || obj.modelId.length === 0) return undefined;

	// Reject known secret-bearing keys.
	if (typeof obj.apiKey !== "undefined") return undefined;
	if (typeof obj.baseUrl !== "undefined") return undefined;
	if (typeof obj.token !== "undefined") return undefined;

	const name = typeof obj.name === "string" && obj.name.length > 0 ? obj.name : undefined;

	return { provider: obj.provider, modelId: obj.modelId, name };
}

export function normalizeRemoteSessionDescriptor(value: unknown): RemoteSessionDescriptor | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const obj = value as Record<string, unknown>;

	if (typeof obj.sessionId !== "string" || obj.sessionId.length === 0) return undefined;
	if (typeof obj.createdAt !== "string" || !isValidISODateString(obj.createdAt)) return undefined;
	if (typeof obj.lastActiveAt !== "string" || !isValidISODateString(obj.lastActiveAt)) return undefined;

	const executionLocation = normalizeExecutionLocation(obj.executionLocation);
	if (!executionLocation) return undefined;

	const model = obj.model ? normalizeRemoteModelDescriptor(obj.model) : undefined;

	return {
		sessionId: obj.sessionId,
		createdAt: obj.createdAt,
		lastActiveAt: obj.lastActiveAt,
		executionLocation,
		model,
	};
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
