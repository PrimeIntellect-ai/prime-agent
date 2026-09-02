/**
 * Pure exact HOME `prime sandbox ssh` spawn-request codec (B14).
 *
 * `buildSandboxSshSpawnSpec(raw)` never throws and returns a frozen fixed
 * Result.  All validation is structural: bounds, sane characters, no NUL,
 * no control bytes, no backslash, no secret/credential env keys, no accessors,
 * no Proxy, no Symbol, no non-enumerable or undefined data, no mismatched
 * prototype.  Output is deeply frozen.
 *
 * No spawn, process, events, stdin, stdout, cleanup, or secret bytes.
 */

import { types } from "node:util";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
	readonly code: string;
	readonly message: string;
}

export type SandboxSshSpawnResult =
	| { readonly ok: true; readonly value: SandboxSshSpawnSpec }
	| { readonly ok: false; readonly error: SandboxSshSpawnError };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set(["PATH", "HOME", "USER", "TMPDIR"]);

const SEGMENT_RE: RegExp = /^[A-Za-z0-9._-]+$/;

const NONCE_RE: RegExp = /^[0-9a-f]{32}$/;

const CONTROL_RE: RegExp = /[\x00-\x1f\x7f]/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || v === undefined || typeof v !== "object" || Array.isArray(v)) {
		return false;
	}
	try {
		// Reject Proxy wrappers
		if (types.isProxy(v)) return false;
		const proto = Object.getPrototypeOf(v);
		if (proto !== null && proto !== Object.prototype) return false;
		if (v.constructor !== undefined && v.constructor !== Object) return false;
		return true;
	} catch {
		return false;
	}
}

function err(code: string, message: string): SandboxSshSpawnResult {
	return Object.freeze({
		ok: false as const,
		error: Object.freeze({ code, message }),
	});
}

function okValue(value: SandboxSshSpawnSpec): SandboxSshSpawnResult {
	return Object.freeze({ ok: true as const, value });
}

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

function validateSandboxId(value: unknown): string | SandboxSshSpawnResult {
	if (typeof value !== "string") {
		return err("INVALID_TYPE", "sandboxId must be a string");
	}
	if (value.length < 1 || value.length > 128) {
		return err("LENGTH", "sandboxId length out of range 1..128");
	}
	if (value.startsWith("-")) {
		return err("LEADING_DASH", "sandboxId must not start with a dash");
	}
	if (!/^[A-Za-z0-9._-]+$/.test(value)) {
		return err("INVALID_CHAR", "sandboxId contains invalid characters");
	}
	return value;
}

function validatePosixPath(
	value: unknown,
	label: string,
	maxLen: number,
	allowRoot: boolean,
): string | SandboxSshSpawnResult {
	if (typeof value !== "string") {
		return err("INVALID_TYPE", `${label} must be a string`);
	}
	if (CONTROL_RE.test(value)) {
		return err("CONTROL_CHAR", `${label} contains control characters or NUL`);
	}
	if (value.indexOf("\\") >= 0) {
		return err("BACKSLASH", `${label} contains backslash`);
	}
	if (value.length < 1 || value.length > maxLen) {
		return err("LENGTH", `${label} length out of range 1..${String(maxLen)}`);
	}
	if (value.charAt(0) !== "/") {
		return err("NOT_ABSOLUTE", `${label} is not an absolute POSIX path`);
	}
	if (value.indexOf("//") >= 0) {
		return err("DOUBLE_SLASH", `${label} contains double slash`);
	}
	if (value.length > 1 && value.charAt(value.length - 1) === "/") {
		return err("TRAILING_SLASH", `${label} has trailing slash`);
	}

	var segments = value.split("/").filter((s) => s.length > 0);
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (seg === ".") {
			return err("DOT_SEGMENT", `${label} contains "." segment`);
		}
		if (seg === "..") {
			return err("DOTDOT_SEGMENT", `${label} contains ".." segment`);
		}
		if (!SEGMENT_RE.test(seg)) {
			return err("INVALID_SEGMENT", `${label} contains invalid segment "${seg}"`);
		}
	}

	if (!allowRoot && value === "/") {
		return err("ROOT_PATH", `${label} must not be root path`);
	}
	return value;
}

function validateNonce(value: unknown): string | SandboxSshSpawnResult {
	if (typeof value !== "string") {
		return err("INVALID_TYPE", "readyNonce must be a string");
	}
	if (!NONCE_RE.test(value)) {
		return err("INVALID_NONCE", "readyNonce must be exactly 32 lowercase hex characters");
	}
	return value;
}

function validateHomeEnv(value: unknown): Record<string, string> | SandboxSshSpawnResult {
	if (!isPlainObject(value)) {
		return err("INVALID_TYPE", "homeEnv must be a plain object");
	}

	// Reject Symbol keys
	if (Object.getOwnPropertySymbols(value).length > 0) {
		return err("SYMBOL_KEY", "homeEnv contains Symbol keys");
	}

	var descriptors = Object.getOwnPropertyDescriptors(value);
	var ownKeys = Object.getOwnPropertyNames(value);

	for (let i = 0; i < ownKeys.length; i++) {
		const key = ownKeys[i];
		const desc = descriptors[key];

		// No accessor properties
		if (desc.get !== undefined || desc.set !== undefined) {
			return err("ACCESSOR_PROP", `homeEnv key "${key}" has an accessor`);
		}

		// No non-enumerable own properties
		if (!desc.enumerable) {
			return err("NONENUM", `homeEnv has non-enumerable key "${key}"`);
		}
	}

	// Reject any key not in the allowlist
	for (let i = 0; i < ownKeys.length; i++) {
		const key = ownKeys[i];
		if (descriptors[key].enumerable && !ALLOWED_ENV_KEYS.has(key)) {
			return err("EXTRA_KEY", `homeEnv contains disallowed key "${key}"`);
		}
	}

	// Collect allowlist env vars (fresh copy)
	var env: Record<string, string> = {};
	var allowedList = ["PATH", "HOME", "USER", "TMPDIR"];
	for (let i = 0; i < allowedList.length; i++) {
		const k = allowedList[i];
		if (k in (value as Record<string, unknown>)) {
			const val = (value as Record<string, unknown>)[k];
			if (val === undefined || val === null) {
				return err("UNDEFINED_VALUE", `homeEnv key "${k}" is ${val === null ? "null" : "undefined"}`);
			}
			if (typeof val !== "string") {
				return err("NON_STRING", `homeEnv key "${k}" value is not a string`);
			}
			if (CONTROL_RE.test(val as string)) {
				return err("CONTROL_CHAR", `homeEnv key "${k}" contains control characters or NUL`);
			}
			if ((val as string).length < 1 || (val as string).length > 8192) {
				return err("LENGTH", `homeEnv key "${k}" value length out of range 1..8192`);
			}
			env[k] = val as string;
		}
	}

	if (!("PATH" in env)) {
		return err("MISSING_PATH", "homeEnv must include PATH at minimum");
	}

	return env;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildSandboxSshSpawnSpec(raw: unknown): SandboxSshSpawnResult {
	if (!isPlainObject(raw)) {
		return err("INVALID_INPUT", "raw input must be a plain object");
	}

	var rawObj = raw as Record<string, unknown>;

	var sandboxIdRes = validateSandboxId(rawObj.sandboxId);
	if (typeof sandboxIdRes !== "string") return sandboxIdRes;

	var remoteExecRes = validatePosixPath(rawObj.remoteExecutable, "remoteExecutable", 1024, false);
	if (typeof remoteExecRes !== "string") return remoteExecRes;

	var homeCwdRes = validatePosixPath(rawObj.homeCwd, "homeCwd", 4096, true);
	if (typeof homeCwdRes !== "string") return homeCwdRes;

	var nonceRes = validateNonce(rawObj.readyNonce);
	if (typeof nonceRes !== "string") return nonceRes;

	var envRes = validateHomeEnv(rawObj.homeEnv);
	// envRes is either Record<string, string> (ok) or SandboxSshSpawnResult (error).
	// A SandboxSshSpawnResult has an "ok" key; a plain Record does not.
	if (typeof envRes === "object" && envRes !== null && "ok" in envRes) {
		return envRes as SandboxSshSpawnResult;
	}

	var args: [string, string, string, string, string, string, string, string, string] = [
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

	var spec: SandboxSshSpawnSpec = Object.freeze({
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
}
