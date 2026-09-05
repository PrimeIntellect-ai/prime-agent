/**
 * Pure exact HOME `prime sandbox ssh` spawn-request codec (B14).
 *
 * `buildSandboxSshSpawnSpec(raw)` never throws and returns a frozen fixed
 * Result.  All validation is structural: exact key set, bounds, sane
 * characters, no NUL, no control bytes, no backslash, no secret/credential
 * env keys, no accessors, no Proxy, no Symbol, no non-enumerable or
 * undefined data, no mismatched prototype.  Output is deeply frozen.
 *
 * No spawn, process, events, stdin, stdout, cleanup, or secret bytes.
 */

import { types } from "node:util";

// ---- Error codes (closed literal union) ----

export type SandboxSshSpawnErrorCode =
	| "ACCESSOR_PROP"
	| "BACKSLASH"
	| "CONTROL_CHAR"
	| "DOT_SEGMENT"
	| "DOTDOT_SEGMENT"
	| "DOUBLE_SLASH"
	| "EXTRA_KEY"
	| "INVALID_CHAR"
	| "INVALID_INPUT"
	| "INVALID_NONCE"
	| "INVALID_SEGMENT"
	| "INVALID_TYPE"
	| "LEADING_DASH"
	| "LENGTH"
	| "MISSING_KEY"
	| "MISSING_PATH"
	| "NONENUM"
	| "NON_STRING"
	| "NOT_ABSOLUTE"
	| "ROOT_PATH"
	| "SYMBOL_KEY"
	| "TRAILING_SLASH"
	| "THROW"
	| "UNDEFINED_VALUE";

// ---- Types ----

export interface SandboxSshSpawnSpec {
	readonly command: "prime";
	readonly args: readonly [string, string, string, string, string, string, string, string, string];
	readonly options: {
		readonly stdio: readonly ["pipe", "pipe", "pipe"];
		readonly shell: false;
		readonly detached: true;
		readonly cwd: string;
		readonly env: Readonly<Record<string, string>>;
	};
}

export interface SandboxSshSpawnError {
	readonly code: SandboxSshSpawnErrorCode;
	readonly message: string;
}

export type SandboxSshSpawnResult =
	| { readonly ok: true; readonly value: SandboxSshSpawnSpec }
	| { readonly ok: false; readonly error: SandboxSshSpawnError };

// ---- Constants ----

const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "TMPDIR"]);

const REQUIRED_RAW_KEYS: ReadonlySet<string> = new Set([
	"sandboxId",
	"remoteExecutable",
	"homeCwd",
	"readyNonce",
	"homeEnv",
]);

const SEGMENT_RE: RegExp = /^[A-Za-z0-9._-]+$/;

const NONCE_RE: RegExp = /^[0-9a-f]{32}$/;

const CONTROL_RE: RegExp = /[\x00-\x1f\x7f]/;

// ---- Helpers ----

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) {
		return false;
	}
	try {
		if (types.isProxy(v)) return false;
		const proto = Object.getPrototypeOf(v);
		if (proto !== null && proto !== Object.prototype) return false;
		return true;
	} catch {
		return false;
	}
}

function err(code: SandboxSshSpawnErrorCode, message: string): SandboxSshSpawnResult {
	return Object.freeze({
		ok: false as const,
		error: Object.freeze({ code, message }),
	});
}

function okValue(value: SandboxSshSpawnSpec): SandboxSshSpawnResult {
	return Object.freeze({ ok: true as const, value });
}

// ---- Top-level raw schema validation (single descriptor snapshot) ----

function validateRaw(raw: unknown): Record<string, unknown> | SandboxSshSpawnResult {
	if (!isPlainObject(raw)) return err("INVALID_INPUT", "raw input must be a plain object");

	let descriptors: PropertyDescriptorMap;
	let ownKeys: string[];
	try {
		descriptors = Object.getOwnPropertyDescriptors(raw);
		ownKeys = Object.getOwnPropertyNames(raw);
	} catch {
		return err("THROW", "failed to inspect raw input");
	}

	// Reject Symbol keys
	try {
		if (Object.getOwnPropertySymbols(raw).length > 0) {
			return err("SYMBOL_KEY", "raw input contains Symbol keys");
		}
	} catch {
		return err("THROW", "failed to inspect raw symbols");
	}

	// Verify no non-enumerable or accessor own keys
	for (const key of ownKeys) {
		const desc = descriptors[key];
		if (desc.get !== undefined || desc.set !== undefined) {
			return err("ACCESSOR_PROP", "raw input has an accessor property");
		}
		if (!desc.enumerable) {
			return err("NONENUM", "raw input has non-enumerable keys");
		}
	}

	// Must have exactly the 5 required keys (no fewer, no more)
	if (ownKeys.length !== 5) {
		return err("EXTRA_KEY", "raw input must have exactly 5 keys");
	}

	for (const key of ownKeys) {
		if (!REQUIRED_RAW_KEYS.has(key)) {
			return err("EXTRA_KEY", "raw input contains an unexpected key");
		}
	}

	// Extract values from descriptors (never re-read caller input)
	const extracted: Record<string, unknown> = {};
	for (const key of ownKeys) {
		const val = descriptors[key].value;
		if (val === undefined) {
			return err("UNDEFINED_VALUE", "raw input key has an undefined value");
		}
		extracted[key] = val;
	}

	return extracted;
}

// ---- Individual field validators (fixed error messages, no interpolation) ----

function validateSandboxId(value: unknown): string | SandboxSshSpawnResult {
	if (typeof value !== "string") {
		return err("INVALID_TYPE", "sandboxId must be a string");
	}
	if (value.length < 1 || value.length > 128) {
		return err("LENGTH", "sandboxId length out of valid range");
	}
	if (value.startsWith("-")) {
		return err("LEADING_DASH", "sandboxId must not start with a dash");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		return err("INVALID_CHAR", "sandboxId contains invalid characters");
	}
	return value;
}

function validatePosixPath(value: unknown, maxLen: number, allowRoot: boolean): string | SandboxSshSpawnResult {
	if (typeof value !== "string") {
		return err("INVALID_TYPE", "path must be a string");
	}
	if (CONTROL_RE.test(value)) {
		return err("CONTROL_CHAR", "path contains control characters or NUL");
	}
	if (value.indexOf("\\") >= 0) {
		return err("BACKSLASH", "path contains backslash");
	}
	if (value.length < 1 || value.length > maxLen) {
		return err("LENGTH", "path length out of valid range");
	}
	if (value.charAt(0) !== "/") {
		return err("NOT_ABSOLUTE", "path is not absolute");
	}
	if (value.indexOf("//") >= 0) {
		return err("DOUBLE_SLASH", "path contains double slash");
	}
	if (value.length > 1 && value.charAt(value.length - 1) === "/") {
		return err("TRAILING_SLASH", "path has trailing slash");
	}

	const segments = value.split("/").filter((s) => s.length > 0);
	for (const seg of segments) {
		if (seg === ".") {
			return err("DOT_SEGMENT", "path contains dot segment");
		}
		if (seg === "..") {
			return err("DOTDOT_SEGMENT", "path contains dotdot segment");
		}
		if (!SEGMENT_RE.test(seg)) {
			return err("INVALID_SEGMENT", "path contains invalid segment characters");
		}
	}

	if (!allowRoot && value === "/") {
		return err("ROOT_PATH", "path must not be root");
	}
	return value;
}

function validateNonce(value: unknown): string | SandboxSshSpawnResult {
	if (typeof value !== "string") {
		return err("INVALID_TYPE", "nonce must be a string");
	}
	if (!NONCE_RE.test(value)) {
		return err("INVALID_NONCE", "nonce must be exactly 32 lowercase hex characters");
	}
	return value;
}

function validateHomeEnv(value: unknown): Record<string, string> | SandboxSshSpawnResult {
	if (!isPlainObject(value)) {
		return err("INVALID_TYPE", "homeEnv must be a plain object");
	}

	// Reject Symbol keys
	try {
		if (Object.getOwnPropertySymbols(value).length > 0) {
			return err("SYMBOL_KEY", "homeEnv contains Symbol keys");
		}
	} catch {
		return err("THROW", "failed to inspect homeEnv symbols");
	}

	// Take single descriptor snapshot
	let descriptors: PropertyDescriptorMap;
	let ownKeys: string[];
	try {
		descriptors = Object.getOwnPropertyDescriptors(value);
		ownKeys = Object.getOwnPropertyNames(value);
	} catch {
		return err("THROW", "failed to inspect homeEnv");
	}

	// Validate all own keys: no accessors, all enumerable
	for (const key of ownKeys) {
		const desc = descriptors[key];
		if (desc.get !== undefined || desc.set !== undefined) {
			return err("ACCESSOR_PROP", "homeEnv has an accessor property");
		}
		if (!desc.enumerable) {
			return err("NONENUM", "homeEnv has non-enumerable keys");
		}
	}

	// Reject any key not in the allowlist
	for (const key of ownKeys) {
		if (!ALLOWED_ENV_KEYS.has(key)) {
			return err("EXTRA_KEY", "homeEnv contains a disallowed key");
		}
	}

	// Collect allowlist values from descriptor (never re-read caller input)
	const env: Record<string, string> = {};
	const allowedList = ["PATH", "HOME", "USER", "TMPDIR"];
	for (const k of allowedList) {
		if (descriptors[k] !== undefined) {
			const val = descriptors[k].value;
			if (val === undefined || val === null) {
				return err("UNDEFINED_VALUE", "homeEnv value is undefined or null");
			}
			if (typeof val !== "string") {
				return err("NON_STRING", "homeEnv value is not a string");
			}
			if (CONTROL_RE.test(val as string)) {
				return err("CONTROL_CHAR", "homeEnv value contains control characters");
			}
			if ((val as string).length < 1 || (val as string).length > 8192) {
				return err("LENGTH", "homeEnv value length out of range");
			}
			env[k] = val as string;
		}
	}

	if (!("PATH" in env)) {
		return err("MISSING_PATH", "homeEnv must include PATH");
	}

	return env;
}

// ---- Public API (wrapped, never throws) ----

export function buildSandboxSshSpawnSpec(raw: unknown): SandboxSshSpawnResult {
	try {
		const extracted = validateRaw(raw);
		if (!(typeof extracted === "object" && extracted !== null && !("ok" in extracted))) {
			return extracted as SandboxSshSpawnResult;
		}
		const er = extracted as Record<string, unknown>;

		const sandboxIdRes = validateSandboxId(er.sandboxId);
		if (typeof sandboxIdRes !== "string") return sandboxIdRes;

		const remoteExecRes = validatePosixPath(er.remoteExecutable, 1024, false);
		if (typeof remoteExecRes !== "string") return remoteExecRes;

		const homeCwdRes = validatePosixPath(er.homeCwd, 4096, true);
		if (typeof homeCwdRes !== "string") return homeCwdRes;

		const nonceRes = validateNonce(er.readyNonce);
		if (typeof nonceRes !== "string") return nonceRes;

		const envRes = validateHomeEnv(er.homeEnv);
		if (typeof envRes === "object" && envRes !== null && "ok" in envRes) {
			return envRes as SandboxSshSpawnResult;
		}

		const args: [string, string, string, string, string, string, string, string, string] = [
			"sandbox",
			"ssh",
			"--plain",
			sandboxIdRes,
			"--",
			remoteExecRes,
			"--prime-agent-fd3-bootstrap",
			"--ready-nonce",
			nonceRes,
		];

		const spec: SandboxSshSpawnSpec = Object.freeze({
			command: "prime" as const,
			args: Object.freeze(args),
			options: Object.freeze({
				stdio: Object.freeze(["pipe", "pipe", "pipe"] as const),
				shell: false as const,
				detached: true as const,
				cwd: homeCwdRes,
				env: Object.freeze(envRes),
			}),
		});

		return okValue(spec);
	} catch {
		return err("THROW", "unexpected error in buildSandboxSshSpawnSpec");
	}
}
