import { randomUUID } from "node:crypto";

/**
 * Direct REST client for Prime Intellect Prime Sandboxes.
 *
 * This module talks straight from a local process to the Prime platform REST
 * API (sandbox lifecycle + per-sandbox gateway auth) and to the per-sandbox
 * gateway (batch exec, upload, download). There is no platform control-plane
 * intermediary: the platform only provisions and authenticates the sandbox.
 *
 * Everything is injected — `apiKey`, `baseUrl`, `fetchFn`, `teamId`,
 * `requestTimeoutMs`, `sleepFn`. Nothing is read from `process.env`,
 * `~/.prime`, or globals, so the client is embeddable in both the supervisor
 * and sandbox worker processes and testable with a fake fetch.
 *
 * Wire contract (verified against the `prime_sandboxes` SDK shipped by the
 * `prime` CLI and the platform backend):
 *
 * - `POST {base}/api/v1/sandbox`            create sandbox; snake_case body; `idempotency_key`
 * - `GET  {base}/api/v1/sandbox/{id}`       fetch sandbox; camelCase body (`memoryGB`, `diskSizeGB`)
 * - `DELETE {base}/api/v1/sandbox/{id}`     delete sandbox; JSON object body
 * - `POST {base}/api/v1/sandbox/{id}/auth`  gateway auth; snake_case body
 * - `POST {gateway}/{ns}/{job}/exec`        batch exec (containers only); snake_case body
 * - `POST {gateway}/{ns}/{job}/upload`      multipart `file`; `path`,`sandbox_id` params
 * - `GET  {gateway}/{ns}/{job}/download`    raw bytes; `path`,`sandbox_id` params
 *
 * The SDK prefixes every platform endpoint with `/api/v1`; `baseUrl` may be
 * passed with or without that suffix and is normalized here. The gateway
 * batch exec endpoint (`execContainerCommand`) serves container sandboxes
 * only and MUST NOT be used for VM sandboxes: the SDK routes VM execution
 * through a ConnectRPC `command_session.CommandSession` stream, which this
 * module intentionally does not implement. Upload and download are
 * runtime-agnostic.
 *
 * Safety contract:
 * - No secret (API key, gateway token) ever appears in an error message or URL.
 * - Every response is strictly validated; a 200 with a malformed body is a
 *   typed `invalid_response` error, never a silent default.
 * - Upload and download payloads are bounded to `MAX_TRANSFER_BYTES` (200 MiB).
 * - All URL path segments derived from platform data are validated before use.
 */

export const MAX_TRANSFER_BYTES = 200 * 1024 * 1024;
export const MAX_EXEC_TIMEOUT_SECONDS = 900;
export const PRIME_SANDBOX_CREATE_MAX_ATTEMPTS = 3;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 2_000;
const MAX_RESPONSE_PREVIEW_CHARS = 512;
const ENV_VAR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const URL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REDACTED_KEY_PATTERN = /authorization|api[-_]?key|token|secret|password/i;

export const PRIME_SANDBOX_STATUSES = [
	"PENDING",
	"PROVISIONING",
	"RUNNING",
	"PAUSED",
	"ERROR",
	"TERMINATED",
	"TIMEOUT",
] as const;
export type PrimeSandboxStatus = (typeof PRIME_SANDBOX_STATUSES)[number];

const TERMINAL_SANDBOX_STATUSES: ReadonlySet<PrimeSandboxStatus> = new Set(["ERROR", "TERMINATED", "TIMEOUT"]);

/** A process to start without invoking a shell (VM start command form). */
export interface PrimeSandboxStartCommand {
	executable: string;
	args: string[];
}

/** Create request for a VM-backed sandbox. `vm: true` is forced by the client. */
export interface PrimeSandboxVmCreateRequest {
	/** Sandbox name; non-empty. */
	name: string;
	/** VM image or container image reference. */
	dockerImage: string;
	/** CPU cores; positive. */
	cpuCores: number;
	/** Memory in GB; positive. */
	memoryGb: number;
	/** Disk size in GB; positive. */
	diskSizeGb: number;
	/** GPU count; non-negative integer. Requires `gpuType` when > 0. */
	gpuCount?: number;
	/** GPU type/model; required with `gpuCount > 0`, forbidden otherwise. */
	gpuType?: string;
	/** Structured VM start command; omit to use the image default. */
	startCommand?: PrimeSandboxStartCommand;
	/** VM-only egress allowlist; mutually exclusive with `networkDenylist`. */
	networkAllowlist?: string[];
	/** VM-only egress denylist; mutually exclusive with `networkAllowlist`. */
	networkDenylist?: string[];
	/** Sandbox lifetime cap in minutes; positive integer. */
	timeoutMinutes: number;
	/** Terminate after this many minutes without sandbox activity. */
	idleTimeoutMinutes?: number;
	/** Environment variables in the sandbox; shell-identifier keys. */
	environmentVars?: Record<string, string>;
	/** Secrets in the sandbox; shell-identifier keys. */
	secrets?: Record<string, string>;
	/** Free-form labels. */
	labels?: string[];
	/**
	 * Create idempotency key. The server returns the same sandbox for repeated
	 * create calls that carry the same key, which makes retries safe. A fresh
	 * UUID is generated when omitted. When provided it must be 1-128
	 * characters of letters, digits, dots, underscores, or dashes, starting
	 * with a letter or digit.
	 */
	idempotencyKey?: string;
}

/** A sandbox record (GET /sandbox/{id} response; camelCase wire form). */
export interface PrimeSandbox {
	id: string;
	name: string;
	dockerImage: string;
	startCommand?: PrimeSandboxStartCommand | string | null;
	cpuCores: number;
	memoryGb: number;
	diskSizeGb: number;
	diskMountPath?: string;
	gpuCount: number;
	gpuType?: string | null;
	vm: boolean;
	networkAllowlist?: string[] | null;
	networkDenylist?: string[] | null;
	status: PrimeSandboxStatus;
	timeoutMinutes: number;
	idleTimeoutMinutes?: number | null;
	terminationReason?: string | null;
	environmentVars?: Record<string, unknown> | null;
	secrets?: Record<string, unknown> | null;
	labels: string[];
	createdAt: string;
	updatedAt: string;
	startedAt?: string | null;
	terminatedAt?: string | null;
	exitCode?: number | null;
	errorType?: string | null;
	errorMessage?: string | null;
	userId?: string | null;
	teamId?: string | null;
	kubernetesJobId?: string | null;
	region?: string | null;
	registryCredentialsId?: string | null;
	pendingImageBuildId?: string | null;
}

/** Per-sandbox gateway credentials (POST /sandbox/{id}/auth response). */
export interface PrimeSandboxAuth {
	sandboxId: string;
	/** Gateway origin, e.g. "https://sandbox-gw.example.com". */
	gatewayUrl: string;
	/** Gateway user namespace (URL path segment). */
	userNamespace: string;
	/** Gateway job id (URL path segment). */
	jobId: string;
	/** Bearer token for gateway calls. Never logged. */
	token: string;
	/** ISO-8601 expiry timestamp. */
	expiresAt: string;
}

/** Gateway batch exec request. */
export interface PrimeSandboxExecRequest {
	/** Command line executed via shell. */
	command: string;
	workingDir?: string;
	env?: Record<string, string>;
	/** Per-exec timeout in seconds; 1..900. */
	timeoutSeconds?: number;
	/** Run as user (container sandboxes only). */
	user?: string;
}

/** Gateway batch exec result. */
export interface PrimeSandboxExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Gateway upload request. */
export interface PrimeSandboxUploadRequest {
	/** Absolute path inside the sandbox where the file is written. */
	path: string;
	/** Multipart file name. */
	filename: string;
	/** File bytes; bounded to `MAX_TRANSFER_BYTES`. */
	content: Uint8Array;
}

/** Gateway upload response. */
export interface PrimeSandboxUploadResult {
	success: boolean;
	path: string;
	size: number;
	timestamp: string;
}

export type PrimeSandboxErrorCode =
	| "invalid_request"
	| "network"
	| "timeout"
	| "http"
	| "invalid_response"
	| "too_large"
	| "terminal_status"
	/** Gateway-reported request timeout (HTTP 408). */
	| "request_timeout"
	/** Gateway-reported conflict (HTTP 409), typically transient. */
	| "conflict"
	/** Gateway 502 with `{ error: "sandbox_not_found" }`: the sandbox is gone. */
	| "sandbox_not_found";

/**
 * Typed, redacted error. `details` carries a bounded, secret-scrubbed preview
 * of a non-2xx response body. Messages never contain the API key or gateway
 * token.
 */
export class PrimeSandboxError extends Error {
	readonly code: PrimeSandboxErrorCode;
	readonly method?: string;
	/** Sanitized request URL (no credentials). */
	readonly url?: string;
	/** HTTP status for `code === "http"`. */
	readonly status?: number;
	readonly details?: string;

	constructor(
		code: PrimeSandboxErrorCode,
		message: string,
		properties: {
			method?: string;
			url?: string;
			status?: number;
			details?: string;
			cause?: unknown;
		} = {},
	) {
		super(message, properties.cause !== undefined ? { cause: properties.cause } : undefined);
		this.name = "PrimeSandboxError";
		this.code = code;
		this.method = properties.method;
		this.url = properties.url;
		this.status = properties.status;
		this.details = properties.details;
	}
}

export interface PrimeSandboxClientOptions {
	/** Prime platform API key; sent as `Authorization: Bearer <key>`. */
	apiKey: string;
	/**
	 * Prime platform API origin, e.g. "https://api.primeintellect.ai". A
	 * trailing `/api/v1` is accepted and normalized away; every platform
	 * endpoint is built as `{origin}/api/v1/...`.
	 */
	baseUrl: string;
	/** Injectable fetch; defaults to the global fetch. */
	fetchFn?: typeof fetch;
	/** Team id appended to create requests when set. */
	teamId?: string;
	/** Default per-request timeout; overridden per call where supported. */
	requestTimeoutMs?: number;
	/**
	 * Permit plain http:// only for localhost, 127.0.0.1, or ::1 — for both
	 * the platform base URL and gateway URLs returned by the platform.
	 * Everything else must be https://.
	 */
	allowInsecureLocalhost?: boolean;
}

export interface PrimeSandboxWaitOptions {
	/** Overall wait budget; default 10 minutes. */
	timeoutMs?: number;
	/** Poll interval; default 2 seconds. */
	pollIntervalMs?: number;
	/** Injectable sleep for tests. */
	sleepFn?: (ms: number) => Promise<void>;
}

/** Options shared by gateway operations. */
export interface PrimeSandboxGatewayOptions {
	/** Reuse known gateway auth; fetched when omitted. */
	auth?: PrimeSandboxAuth;
	/** Per-request timeout override. */
	requestTimeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// Node's URL.hostname keeps the brackets for IPv6 ("[::1]"), so both forms
// of the loopback literal must be allowed.
const LOCAL_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isSafeUrl(url: string): boolean {
	try {
		const parsed = new URL(url);
		return (
			(parsed.protocol === "https:" || parsed.protocol === "http:") &&
			parsed.hostname !== "" &&
			parsed.username === "" &&
			parsed.password === ""
		);
	} catch {
		return false;
	}
}

/** https-only, except plain http to loopback hosts when explicitly allowed. */
function isAllowedUrl(url: string, allowInsecureLocalhost: boolean): boolean {
	if (!isSafeUrl(url)) {
		return false;
	}
	const parsed = new URL(url);
	if (parsed.protocol === "https:") {
		return true;
	}
	return parsed.protocol === "http:" && allowInsecureLocalhost && LOCAL_HOSTNAMES.has(parsed.hostname);
}

/**
 * Validate and normalize the platform base URL (origin + optional path
 * prefix). A trailing `/api/v1` is accepted and stripped: the SDK prefixes
 * every platform endpoint with `/api/v1`, and this client builds that prefix
 * itself, so a caller may pass either form. https is required except for
 * loopback hosts when `allowInsecureLocalhost` is set.
 */
function normalizeBaseUrl(value: string, allowInsecureLocalhost: boolean): string {
	if (value.includes("?") || value.includes("#") || !isAllowedUrl(value, allowInsecureLocalhost)) {
		throw new PrimeSandboxError("invalid_request", "Prime sandbox base URL must be an https URL with a host");
	}
	// Trim trailing slashes first, then strip the exact "/api/v1" suffix: the
	// documented ".../api/v1" form must normalize, not be rejected.
	let trimmed = value.replace(/\/+$/, "");
	while (trimmed.endsWith("/api/v1")) {
		trimmed = trimmed.slice(0, -"/api/v1".length).replace(/\/+$/, "");
	}
	if (trimmed === "" || !isAllowedUrl(trimmed, allowInsecureLocalhost)) {
		throw new PrimeSandboxError("invalid_request", "Prime sandbox base URL must be an https URL with a host");
	}
	return trimmed;
}

const IPV4_OCTET_PATTERN = /^(0|[1-9][0-9]{0,2})$/;

/** True for an exact IPv4 address such as "1.2.3.4". */
function isIpv4Address(value: string): boolean {
	const parts = value.split(".");
	if (parts.length !== 4) return false;
	return parts.every((part) => {
		if (!IPV4_OCTET_PATTERN.test(part)) return false;
		const octet = Number(part);
		return octet <= 255;
	});
}

/** True for an IPv4 CIDR such as "10.0.0.0/8". */
function isIpv4Cidr(value: string): boolean {
	const [address, prefixText] = value.split("/");
	if (address === undefined || prefixText === undefined) return false;
	if (!/^[0-9]{1,2}$/.test(prefixText)) return false;
	const prefix = Number(prefixText);
	if (prefix > 32) return false;
	return isIpv4Address(address);
}

/** Hostname or leftmost-label wildcard such as "example.com" or "*.example.com". */
function isHostnameEntry(value: string): boolean {
	if (value.includes("*.")) {
		if (!value.startsWith("*.")) return false;
		return isHostnameEntry(value.slice(2));
	}
	// A CIDR-shaped entry that failed CIDR parsing is not a hostname either.
	if (value.includes("/")) return false;
	const domain = value.replace(/\.+$/, "");
	if (domain === "") return false;
	if (domain.includes("*")) return false;
	return domain.split(".").every((label) => label !== "");
}

const MAX_EGRESS_POLICY_ENTRIES = 256;

/**
 * Mirror the platform egress entry contract: an exact hostname, a leftmost
 * `*.` wildcard, an IPv4 address, or an IPv4 CIDR. Schemes, credentials,
 * ports, query strings, bare `*`, IPv6, and wildcards in other positions are
 * rejected (the server canonicalizes further).
 */
function validateEgressEntry(entry: string, field: string): void {
	if (entry === "") {
		throw new PrimeSandboxError("invalid_request", `${field} entries must not be empty`);
	}
	if (isIpv4Address(entry) || isIpv4Cidr(entry)) {
		return;
	}
	for (const [forbidden, reason] of [
		["://", "schemes are not supported"],
		["@", "credentials are not supported"],
		[":", "ports and IPv6 are not supported"],
		["?", "query strings are not supported"],
	] as const) {
		if (entry.includes(forbidden)) {
			throw new PrimeSandboxError("invalid_request", `${field} entry ${JSON.stringify(entry)}: ${reason}`);
		}
	}
	if (!isHostnameEntry(entry)) {
		throw new PrimeSandboxError(
			"invalid_request",
			`${field} entry ${JSON.stringify(entry)} is not a valid egress rule`,
		);
	}
}

function validateEgressList(value: string[] | undefined, field: string): void {
	if (value === undefined) return;
	// An empty allowlist means "deny all egress" and an empty denylist means
	// "allow all egress"; both are valid requested policies.
	if (value.length > MAX_EGRESS_POLICY_ENTRIES) {
		throw new PrimeSandboxError("invalid_request", `${field} supports at most ${MAX_EGRESS_POLICY_ENTRIES} entries`);
	}
	for (const entry of value) {
		if (typeof entry !== "string" || entry === "" || entry.includes("\x00") || /\s/.test(entry)) {
			throw new PrimeSandboxError("invalid_request", `${field} entries must be non-empty whitespace-free strings`);
		}
		validateEgressEntry(entry, field);
	}
}

function assertSandboxId(value: string): string {
	if (!URL_SEGMENT_PATTERN.test(value)) {
		throw new PrimeSandboxError("invalid_request", "Sandbox id must match [A-Za-z0-9][A-Za-z0-9._-]{0,127}");
	}
	return value;
}

/** Scrub secret-bearing keys from a parsed JSON value, recursively. */
function scrubJsonSecrets(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => scrubJsonSecrets(entry));
	}
	if (!isRecord(value)) {
		return value;
	}
	const scrubbed: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (REDACTED_KEY_PATTERN.test(key)) {
			scrubbed[key] = "[redacted]";
		} else {
			scrubbed[key] = scrubJsonSecrets(entry);
		}
	}
	return scrubbed;
}

function redactSecrets(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret.length > 0) {
			redacted = redacted.split(secret).join("[redacted]");
		}
	}
	return redacted;
}

function boundPreview(text: string): string {
	if (text.length <= MAX_RESPONSE_PREVIEW_CHARS) {
		return text;
	}
	return `${text.slice(0, MAX_RESPONSE_PREVIEW_CHARS)}…`;
}

/** Cap for error-body reads: previews never read more than this many bytes. */
const MAX_ERROR_BODY_BYTES = 64 * 1024;
/** Cap for JSON response bodies (sandbox records, exec results). */
const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Read at most `maxBytes` of a response body. Consumption is bounded even
 * when the body is larger: the stream is cancelled as soon as the cap is
 * reached and `truncated` reports it. Returns undefined when the body cannot
 * be read at all.
 */
async function boundedBodyText(
	response: Response,
	maxBytes: number,
): Promise<{ text: string; truncated: boolean } | undefined> {
	if (response.body !== null && typeof response.body.getReader === "function") {
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let received = 0;
		let truncated = false;
		const chunks: string[] = [];
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				chunks.push(decoder.decode(value, { stream: true }));
				if (received > maxBytes) {
					chunks.push(decoder.decode());
					truncated = true;
					break;
				}
			}
		} catch {
			return undefined;
		} finally {
			await reader.cancel().catch(() => undefined);
		}
		return { text: chunks.join(""), truncated };
	}
	try {
		const text = await response.text();
		const capped = text.length > maxBytes * 4;
		return { text: capped ? text.slice(0, maxBytes * 4) : text, truncated: capped };
	} catch {
		return undefined;
	}
}

/** Bounded, secret-scrubbed preview built from already-read body text. */
function previewFromText(text: string, secrets: readonly string[]): string | undefined {
	if (!text) {
		return undefined;
	}
	try {
		return boundPreview(redactSecrets(JSON.stringify(scrubJsonSecrets(JSON.parse(text))), secrets));
	} catch {
		return boundPreview(redactSecrets(text, secrets));
	}
}

/**
 * Map a non-2xx response onto the typed error contract: HTTP 408 is a
 * `request_timeout`, HTTP 409 a `conflict`, and HTTP 502 with
 * `{ error: "sandbox_not_found" }` a `sandbox_not_found`; everything else is
 * a generic `http` error. The body is read once, bounded; `details` carries a
 * redacted preview of it.
 */
async function httpError(
	response: Response,
	method: string,
	url: string,
	secrets: readonly string[],
	context: string,
): Promise<PrimeSandboxError> {
	const read = await boundedBodyText(response, MAX_ERROR_BODY_BYTES);
	const text = read?.text ?? "";
	const details = previewFromText(text, secrets);
	let code: PrimeSandboxErrorCode = "http";
	let message = `${context} failed with HTTP ${response.status}`;
	if (response.status === 408) {
		code = "request_timeout";
		message = `${context} timed out on the server (HTTP 408)`;
	} else if (response.status === 409) {
		code = "conflict";
		message = `${context} returned a conflict (HTTP 409); this is typically transient`;
	} else if (response.status === 502) {
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (isRecord(parsed) && parsed.error === "sandbox_not_found") {
				code = "sandbox_not_found";
				message = `${context} target sandbox is no longer present on the runtime node`;
			}
		} catch {
			// A non-JSON 502 stays a generic HTTP error.
		}
	}
	return new PrimeSandboxError(code, message, { method, url, status: response.status, details });
}

function requireString(value: unknown, field: string): string {
	if (typeof value !== "string" || value === "") {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be a non-empty string`);
	}
	return value;
}

function optionalString(value: unknown, field: string): string | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be a string or null`);
	}
	return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be a finite number`);
	}
	return value;
}

function requireInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be an integer`);
	}
	return value;
}

function requireBoolean(value: unknown, field: string): boolean {
	if (typeof value !== "boolean") {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be a boolean`);
	}
	return value;
}

function requireTimestamp(value: unknown, field: string): string {
	const text = requireString(value, field);
	if (Number.isNaN(Date.parse(text))) {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be an ISO-8601 date`);
	}
	return text;
}

function optionalStringArray(value: unknown, field: string): string[] | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be a string array or null`);
	}
	return value as string[];
}

function optionalRecord(value: unknown, field: string): Record<string, unknown> | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		throw new PrimeSandboxError("invalid_response", `Sandbox response field ${field} must be an object or null`);
	}
	return value;
}

function optionalStartCommand(value: unknown): PrimeSandboxStartCommand | string | null | undefined {
	if (value === null) return null;
	if (value === undefined) return undefined;
	if (typeof value === "string") return value;
	if (
		isRecord(value) &&
		typeof value.executable === "string" &&
		value.executable !== "" &&
		Array.isArray(value.args) &&
		value.args.every((arg) => typeof arg === "string")
	) {
		return { executable: value.executable, args: value.args as string[] };
	}
	throw new PrimeSandboxError("invalid_response", "Sandbox response field startCommand is malformed");
}

/** Strictly validate a GET /sandbox/{id} body (camelCase wire form). */
export function parsePrimeSandbox(value: unknown): PrimeSandbox {
	if (!isRecord(value)) {
		throw new PrimeSandboxError("invalid_response", "Sandbox response must be a JSON object");
	}
	const status = requireString(value.status, "status");
	if (!(PRIME_SANDBOX_STATUSES as readonly string[]).includes(status)) {
		throw new PrimeSandboxError("invalid_response", `Sandbox response has unknown status ${status}`);
	}
	const sandbox: PrimeSandbox = {
		id: requireString(value.id, "id"),
		name: requireString(value.name, "name"),
		dockerImage: requireString(value.dockerImage, "dockerImage"),
		startCommand: optionalStartCommand(value.startCommand),
		cpuCores: requireFiniteNumber(value.cpuCores, "cpuCores"),
		memoryGb: requireFiniteNumber(value.memoryGB, "memoryGB"),
		diskSizeGb: requireFiniteNumber(value.diskSizeGB, "diskSizeGB"),
		diskMountPath: requireString(value.diskMountPath, "diskMountPath"),
		gpuCount: requireInteger(value.gpuCount, "gpuCount"),
		gpuType: optionalString(value.gpuType, "gpuType"),
		vm: requireBoolean(value.vm, "vm"),
		// The platform's SandboxResponse aliases memoryGB/diskSizeGB to
		// camelCase but keeps the egress lists snake_case on the wire.
		networkAllowlist: optionalStringArray(value.network_allowlist, "network_allowlist"),
		networkDenylist: optionalStringArray(value.network_denylist, "network_denylist"),
		status: status as PrimeSandboxStatus,
		timeoutMinutes: requireInteger(value.timeoutMinutes, "timeoutMinutes"),
		idleTimeoutMinutes:
			value.idleTimeoutMinutes === undefined || value.idleTimeoutMinutes === null
				? null
				: requireInteger(value.idleTimeoutMinutes, "idleTimeoutMinutes"),
		terminationReason: optionalString(value.terminationReason, "terminationReason"),
		environmentVars: optionalRecord(value.environmentVars, "environmentVars"),
		secrets: optionalRecord(value.secrets, "secrets"),
		labels: optionalStringArray(value.labels, "labels") ?? [],
		createdAt: requireTimestamp(value.createdAt, "createdAt"),
		updatedAt: requireTimestamp(value.updatedAt, "updatedAt"),
		startedAt: optionalString(value.startedAt, "startedAt"),
		terminatedAt: optionalString(value.terminatedAt, "terminatedAt"),
		exitCode:
			value.exitCode === undefined || value.exitCode === null ? null : requireInteger(value.exitCode, "exitCode"),
		errorType: optionalString(value.errorType, "errorType"),
		errorMessage: optionalString(value.errorMessage, "errorMessage"),
		userId: optionalString(value.userId, "userId"),
		teamId: optionalString(value.teamId, "teamId"),
		kubernetesJobId: optionalString(value.kubernetesJobId, "kubernetesJobId"),
		region: optionalString(value.region, "region"),
		registryCredentialsId: optionalString(value.registryCredentialsId, "registryCredentialsId"),
		pendingImageBuildId: optionalString(value.pendingImageBuildId, "pendingImageBuildId"),
	};
	return sandbox;
}

function validateEnvRecord(value: Record<string, string> | undefined, field: string): void {
	for (const [key, entry] of Object.entries(value ?? {})) {
		if (!ENV_VAR_KEY_PATTERN.test(key)) {
			throw new PrimeSandboxError(
				"invalid_request",
				`${field} key ${JSON.stringify(key)} is not a valid env var name`,
			);
		}
		if (typeof entry !== "string" || entry.includes("\x00")) {
			throw new PrimeSandboxError("invalid_request", `${field} values must be NUL-free strings`);
		}
	}
}

interface RequestJsonOptions<T> {
	method: string;
	url: string;
	body?: unknown;
	headers: Record<string, string>;
	timeoutMs: number;
	secrets: readonly string[];
	context: string;
	/** Strict body parser; throws PrimeSandboxError("invalid_response") on malformed bodies. */
	parse: (value: unknown) => T;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export class PrimeSandboxClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly teamId?: string;
	private readonly requestTimeoutMs: number;
	private readonly allowInsecureLocalhost: boolean;

	constructor(options: PrimeSandboxClientOptions) {
		if (typeof options.apiKey !== "string" || options.apiKey === "") {
			throw new PrimeSandboxError("invalid_request", "Prime sandbox client requires a non-empty apiKey");
		}
		this.apiKey = options.apiKey;
		this.allowInsecureLocalhost = options.allowInsecureLocalhost === true;
		this.baseUrl = normalizeBaseUrl(options.baseUrl, this.allowInsecureLocalhost);
		this.fetchFn = options.fetchFn ?? fetch;
		this.teamId = options.teamId === "" ? undefined : options.teamId;
		const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
			throw new PrimeSandboxError("invalid_request", "requestTimeoutMs must be a positive integer");
		}
		this.requestTimeoutMs = timeoutMs;
	}

	/**
	 * Create a VM-backed sandbox. Idempotent: retries transient (network or
	 * timeout) failures up to `PRIME_SANDBOX_CREATE_MAX_ATTEMPTS` times while
	 * reusing the same server-side `idempotency_key`, so a retried create can
	 * never provision a second sandbox.
	 */
	async createVmSandbox(request: PrimeSandboxVmCreateRequest): Promise<PrimeSandbox> {
		if (typeof request.name !== "string" || request.name.trim() === "" || request.name.length > 100) {
			throw new PrimeSandboxError(
				"invalid_request",
				"Sandbox name must be a non-empty string of at most 100 characters",
			);
		}
		if (typeof request.dockerImage !== "string" || request.dockerImage === "" || /\s/.test(request.dockerImage)) {
			throw new PrimeSandboxError("invalid_request", "dockerImage must be a non-empty whitespace-free string");
		}
		for (const [field, value, min, max] of [
			["cpuCores", request.cpuCores, 0.1, 16],
			["memoryGb", request.memoryGb, 0.1, 64],
			["diskSizeGb", request.diskSizeGb, 0.1, 1000],
		] as const) {
			if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
				throw new PrimeSandboxError("invalid_request", `${field} must be a finite number from ${min} to ${max}`);
			}
		}
		if (!Number.isInteger(request.timeoutMinutes) || request.timeoutMinutes < 1 || request.timeoutMinutes > 1440) {
			throw new PrimeSandboxError("invalid_request", "timeoutMinutes must be an integer from 1 to 1440");
		}
		if (
			request.idleTimeoutMinutes !== undefined &&
			(!Number.isInteger(request.idleTimeoutMinutes) || request.idleTimeoutMinutes < 1)
		) {
			throw new PrimeSandboxError("invalid_request", "idleTimeoutMinutes must be a positive integer");
		}
		if (
			request.idleTimeoutMinutes !== undefined &&
			request.timeoutMinutes > 0 &&
			request.idleTimeoutMinutes > request.timeoutMinutes
		) {
			throw new PrimeSandboxError("invalid_request", "idleTimeoutMinutes must not exceed timeoutMinutes");
		}
		const gpuCount = request.gpuCount ?? 0;
		if (!Number.isInteger(gpuCount) || gpuCount < 0 || gpuCount > 8) {
			throw new PrimeSandboxError("invalid_request", "gpuCount must be an integer from 0 to 8");
		}
		const gpuType = request.gpuType === "" ? undefined : request.gpuType;
		if (gpuCount > 0 && gpuType === undefined) {
			throw new PrimeSandboxError("invalid_request", "gpuType is required when gpuCount is greater than 0");
		}
		if (gpuCount === 0 && gpuType !== undefined) {
			throw new PrimeSandboxError("invalid_request", "gpuType requires gpuCount greater than 0");
		}
		if (request.startCommand !== undefined) {
			if (typeof request.startCommand.executable !== "string" || request.startCommand.executable === "") {
				throw new PrimeSandboxError("invalid_request", "startCommand.executable must be a non-empty string");
			}
			if (request.startCommand.executable.includes("\x00")) {
				throw new PrimeSandboxError("invalid_request", "startCommand.executable must not contain NUL bytes");
			}
			if (
				!Array.isArray(request.startCommand.args) ||
				request.startCommand.args.some((arg) => typeof arg !== "string" || arg.includes("\x00"))
			) {
				throw new PrimeSandboxError("invalid_request", "startCommand.args must be an array of NUL-free strings");
			}
		}
		if (request.networkAllowlist !== undefined && request.networkDenylist !== undefined) {
			throw new PrimeSandboxError("invalid_request", "networkAllowlist and networkDenylist are mutually exclusive");
		}
		validateEgressList(request.networkAllowlist, "networkAllowlist");
		validateEgressList(request.networkDenylist, "networkDenylist");
		validateEnvRecord(request.environmentVars, "environmentVars");
		validateEnvRecord(request.secrets, "secrets");
		for (const label of request.labels ?? []) {
			if (typeof label !== "string" || label === "" || label.length > 256 || label.includes("\x00")) {
				throw new PrimeSandboxError(
					"invalid_request",
					"labels must be non-empty strings of at most 256 characters",
				);
			}
		}
		const region = (request as unknown as Record<string, unknown>).region;
		if (region !== undefined) {
			throw new PrimeSandboxError(
				"invalid_request",
				"region is not caller-selectable for VM sandboxes; omit it and let the platform place the sandbox",
			);
		}
		if (request.idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(request.idempotencyKey)) {
			throw new PrimeSandboxError(
				"invalid_request",
				"idempotencyKey must be 1-128 characters of letters, digits, dots, underscores, or dashes, starting with a letter or digit",
			);
		}
		const idempotencyKey = request.idempotencyKey ?? randomUUID();

		const body: Record<string, unknown> = {
			name: request.name,
			docker_image: request.dockerImage,
			cpu_cores: request.cpuCores,
			memory_gb: request.memoryGb,
			disk_size_gb: request.diskSizeGb,
			gpu_count: gpuCount,
			vm: true,
			timeout_minutes: request.timeoutMinutes,
			labels: request.labels ?? [],
			idempotency_key: idempotencyKey,
		};
		if (request.startCommand !== undefined) {
			body.start_command = { executable: request.startCommand.executable, args: request.startCommand.args };
		}
		if (gpuType !== undefined) body.gpu_type = gpuType;
		if (request.networkAllowlist !== undefined) body.network_allowlist = request.networkAllowlist;
		if (request.networkDenylist !== undefined) body.network_denylist = request.networkDenylist;
		if (request.idleTimeoutMinutes !== undefined) body.idle_timeout_minutes = request.idleTimeoutMinutes;
		if (request.environmentVars !== undefined) body.environment_vars = request.environmentVars;
		if (request.secrets !== undefined) body.secrets = request.secrets;
		if (this.teamId !== undefined) body.team_id = this.teamId;

		const url = `${this.baseUrl}/api/v1/sandbox`;
		let lastError: PrimeSandboxError | undefined;
		for (let attempt = 1; attempt <= PRIME_SANDBOX_CREATE_MAX_ATTEMPTS; attempt++) {
			try {
				return await this.requestJson({
					method: "POST",
					url,
					body: JSON.stringify(body),
					headers: this.platformHeaders(),
					timeoutMs: this.requestTimeoutMs,
					secrets: this.platformSecrets(),
					context: "Sandbox create",
					parse: parsePrimeSandbox,
				});
			} catch (error) {
				if (
					error instanceof PrimeSandboxError &&
					(error.code === "network" || error.code === "timeout") &&
					attempt < PRIME_SANDBOX_CREATE_MAX_ATTEMPTS
				) {
					lastError = error;
					continue;
				}
				throw error;
			}
		}
		throw lastError ?? new PrimeSandboxError("network", "Sandbox create failed");
	}

	/** Fetch a sandbox by id. */
	async getSandbox(sandboxId: string): Promise<PrimeSandbox> {
		assertSandboxId(sandboxId);
		return this.requestJson({
			method: "GET",
			url: `${this.baseUrl}/api/v1/sandbox/${sandboxId}`,
			headers: this.platformHeaders(),
			timeoutMs: this.requestTimeoutMs,
			secrets: this.platformSecrets(),
			context: "Sandbox fetch",
			parse: parsePrimeSandbox,
		});
	}

	/** Delete a sandbox by id. */
	async deleteSandbox(sandboxId: string): Promise<void> {
		assertSandboxId(sandboxId);
		try {
			await this.requestJson({
				method: "DELETE",
				url: `${this.baseUrl}/api/v1/sandbox/${sandboxId}`,
				headers: this.platformHeaders(),
				timeoutMs: this.requestTimeoutMs,
				secrets: this.platformSecrets(),
				context: "Sandbox delete",
				parse: (value) => {
					if (!isRecord(value)) {
						throw new PrimeSandboxError("invalid_response", "Sandbox delete response must be a JSON object");
					}
					return undefined;
				},
			});
		} catch (error) {
			if (error instanceof PrimeSandboxError && error.code === "http" && error.status === 404) return;
			throw error;
		}
	}

	/**
	 * Poll a sandbox until it reports RUNNING. Throws a typed
	 * `terminal_status` error as soon as the sandbox reaches a terminal state
	 * (ERROR/TERMINATED/TIMEOUT) and a `timeout` error when the wait budget is
	 * exhausted first.
	 */
	async waitForRunning(sandboxId: string, options: PrimeSandboxWaitOptions = {}): Promise<PrimeSandbox> {
		assertSandboxId(sandboxId);
		const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
		const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
		if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || !Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
			throw new PrimeSandboxError(
				"invalid_request",
				"waitForRunning requires positive integer timeoutMs and pollIntervalMs",
			);
		}
		const sleepFn = options.sleepFn ?? defaultSleep;
		const deadline = Date.now() + timeoutMs;
		while (true) {
			const sandbox = await this.getSandbox(sandboxId);
			if (sandbox.status === "RUNNING") {
				return sandbox;
			}
			if (TERMINAL_SANDBOX_STATUSES.has(sandbox.status)) {
				throw new PrimeSandboxError(
					"terminal_status",
					`Sandbox ${sandboxId} reached terminal status ${sandbox.status}`,
					{
						details:
							redactSecrets(
								[sandbox.errorType, sandbox.errorMessage].filter(Boolean).join(": "),
								this.platformSecrets(),
							) || undefined,
					},
				);
			}
			if (Date.now() >= deadline) {
				throw new PrimeSandboxError("timeout", `Timed out waiting for sandbox ${sandboxId} to become RUNNING`, {
					details: `last status ${sandbox.status}`,
				});
			}
			await sleepFn(pollIntervalMs);
		}
	}

	/** Fetch per-sandbox gateway credentials. */
	async getSandboxAuth(
		sandboxId: string,
		options: Pick<PrimeSandboxGatewayOptions, "requestTimeoutMs"> = {},
	): Promise<PrimeSandboxAuth> {
		assertSandboxId(sandboxId);
		const allowInsecure = this.allowInsecureLocalhost;
		const auth = await this.requestJson({
			method: "POST",
			url: `${this.baseUrl}/api/v1/sandbox/${sandboxId}/auth`,
			headers: this.platformHeaders(),
			timeoutMs: options.requestTimeoutMs ?? this.requestTimeoutMs,
			secrets: this.platformSecrets(),
			context: "Sandbox auth",
			parse: (value) => {
				if (!isRecord(value)) {
					throw new PrimeSandboxError("invalid_response", "Sandbox auth response must be a JSON object");
				}
				const gatewayUrl = requireString(value.gateway_url, "gateway_url");
				const userNamespace = requireString(value.user_ns, "user_ns");
				const jobId = requireString(value.job_id, "job_id");
				const token = requireString(value.token, "token");
				const expiresAt = requireTimestamp(value.expires_at, "expires_at");
				if (gatewayUrl.includes("?") || gatewayUrl.includes("#") || !isAllowedUrl(gatewayUrl, allowInsecure)) {
					throw new PrimeSandboxError("invalid_response", "Sandbox auth gateway_url must be an https URL");
				}
				if (!URL_SEGMENT_PATTERN.test(userNamespace) || !URL_SEGMENT_PATTERN.test(jobId)) {
					throw new PrimeSandboxError(
						"invalid_response",
						"Sandbox auth user_ns and job_id must be URL-safe segments",
					);
				}
				return {
					sandboxId,
					gatewayUrl: gatewayUrl.replace(/\/+$/, ""),
					userNamespace,
					jobId,
					token,
					expiresAt,
				};
			},
		});
		return auth;
	}

	/**
	 * Run a batch command through the gateway REST exec endpoint. This
	 * endpoint serves CONTAINER sandboxes only: it MUST NOT be used for VM
	 * sandboxes. VM execution goes through the ConnectRPC
	 * `command_session.CommandSession` stream (a separate module; see the
	 * client header). `timeoutSeconds` is capped at `MAX_EXEC_TIMEOUT_SECONDS`
	 * (the platform's batch exec limit); long-running work must be launched
	 * detached and polled.
	 */
	async execContainerCommand(
		sandboxId: string,
		request: PrimeSandboxExecRequest,
		options: PrimeSandboxGatewayOptions = {},
	): Promise<PrimeSandboxExecResult> {
		assertSandboxId(sandboxId);
		if (typeof request.command !== "string" || request.command.trim() === "" || request.command.includes("\x00")) {
			throw new PrimeSandboxError("invalid_request", "command must be a non-empty NUL-free string");
		}
		if (request.workingDir !== undefined && (typeof request.workingDir !== "string" || request.workingDir === "")) {
			throw new PrimeSandboxError("invalid_request", "workingDir must be a non-empty string");
		}
		if (request.user !== undefined && (typeof request.user !== "string" || request.user === "")) {
			throw new PrimeSandboxError("invalid_request", "user must be a non-empty string");
		}
		validateEnvRecord(request.env, "env");
		const timeoutSeconds = request.timeoutSeconds ?? 300;
		if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > MAX_EXEC_TIMEOUT_SECONDS) {
			throw new PrimeSandboxError(
				"invalid_request",
				`timeoutSeconds must be an integer from 1 to ${MAX_EXEC_TIMEOUT_SECONDS}`,
			);
		}
		const body: Record<string, unknown> = {
			command: request.command,
			sandbox_id: sandboxId,
			timeout: timeoutSeconds,
		};
		if (request.workingDir !== undefined) body.working_dir = request.workingDir;
		if (request.env !== undefined) body.env = request.env;
		if (request.user !== undefined) body.user = request.user;
		const auth = await this.resolveAuth(sandboxId, options);
		return this.requestJson({
			method: "POST",
			url: this.gatewayUrl(auth, "exec"),
			body: JSON.stringify(body),
			headers: { Authorization: `Bearer ${auth.token}` },
			timeoutMs: options.requestTimeoutMs ?? this.scaledExecTimeoutMs(timeoutSeconds),
			secrets: [this.apiKey, auth.token],
			context: "Sandbox exec",
			parse: (value) => {
				if (!isRecord(value)) {
					throw new PrimeSandboxError("invalid_response", "Sandbox exec response must be a JSON object");
				}
				if (typeof value.stdout !== "string" || typeof value.stderr !== "string") {
					throw new PrimeSandboxError(
						"invalid_response",
						"Sandbox exec response stdout and stderr must be strings",
					);
				}
				return {
					stdout: value.stdout,
					stderr: value.stderr,
					exitCode: requireInteger(value.exit_code, "exit_code"),
				};
			},
		});
	}

	/** Upload bytes to a path inside the sandbox (multipart gateway upload). */
	async uploadFile(
		sandboxId: string,
		request: PrimeSandboxUploadRequest,
		options: PrimeSandboxGatewayOptions = {},
	): Promise<PrimeSandboxUploadResult> {
		assertSandboxId(sandboxId);
		validateSandboxFilePath(request.path);
		if (typeof request.filename !== "string" || request.filename === "" || /[/\\\x00]/.test(request.filename)) {
			throw new PrimeSandboxError("invalid_request", "filename must be a non-empty path-segment string");
		}
		if (!(request.content instanceof Uint8Array)) {
			throw new PrimeSandboxError("invalid_request", "upload content must be a Uint8Array");
		}
		if (request.content.byteLength > MAX_TRANSFER_BYTES) {
			throw new PrimeSandboxError(
				"too_large",
				`Upload of ${request.path} exceeds the ${MAX_TRANSFER_BYTES} byte limit`,
			);
		}
		const auth = await this.resolveAuth(sandboxId, options);
		const form = new FormData();
		form.append("file", new Blob([request.content]), request.filename);
		const url = new URL(this.gatewayUrl(auth, "upload"));
		url.searchParams.set("path", request.path);
		url.searchParams.set("sandbox_id", sandboxId);
		return this.requestJson({
			method: "POST",
			url: url.toString(),
			body: form,
			headers: { Authorization: `Bearer ${auth.token}` },
			timeoutMs: options.requestTimeoutMs ?? this.requestTimeoutMs,
			secrets: [this.apiKey, auth.token],
			context: "Sandbox upload",
			parse: (value) => {
				if (!isRecord(value)) {
					throw new PrimeSandboxError("invalid_response", "Sandbox upload response must be a JSON object");
				}
				if (value.success !== true) {
					throw new PrimeSandboxError("invalid_response", "Sandbox upload response reported failure");
				}
				const size = requireInteger(value.size, "size");
				if (size < 0) {
					throw new PrimeSandboxError("invalid_response", "Sandbox upload response size must be non-negative");
				}
				return {
					success: true,
					path: requireString(value.path, "path"),
					size,
					timestamp: requireTimestamp(value.timestamp, "timestamp"),
				};
			},
		});
	}

	/** Download a file from the sandbox as raw bytes, bounded to `MAX_TRANSFER_BYTES`. */
	async downloadFile(sandboxId: string, path: string, options: PrimeSandboxGatewayOptions = {}): Promise<Uint8Array> {
		assertSandboxId(sandboxId);
		validateSandboxFilePath(path);
		const auth = await this.resolveAuth(sandboxId, options);
		const url = new URL(this.gatewayUrl(auth, "download"));
		url.searchParams.set("path", path);
		url.searchParams.set("sandbox_id", sandboxId);
		const secrets = [this.apiKey, auth.token];
		const response = await this.fetchWithTimeout(
			"GET",
			url.toString(),
			{ Authorization: `Bearer ${auth.token}` },
			undefined,
			options.requestTimeoutMs ?? this.requestTimeoutMs,
			secrets,
		);
		if (!response.ok) {
			throw await httpError(response, "GET", url.toString(), secrets, "Sandbox download");
		}
		const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
		if (Number.isFinite(declaredLength) && declaredLength > MAX_TRANSFER_BYTES) {
			throw new PrimeSandboxError(
				"too_large",
				`Download of ${path} declares ${declaredLength} bytes, exceeding the ${MAX_TRANSFER_BYTES} byte limit`,
			);
		}
		if (response.body !== null && typeof response.body.getReader === "function") {
			// Stream with a hard cap: stop reading as soon as the limit is
			// exceeded instead of buffering an unbounded body first.
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let received = 0;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					received += value.byteLength;
					if (received > MAX_TRANSFER_BYTES) {
						await reader.cancel().catch(() => undefined);
						throw new PrimeSandboxError(
							"too_large",
							`Download of ${path} exceeds the ${MAX_TRANSFER_BYTES} byte limit`,
						);
					}
					chunks.push(value);
				}
			} catch (error) {
				if (error instanceof PrimeSandboxError) throw error;
				throw new PrimeSandboxError("invalid_response", `Sandbox download of ${path} was interrupted`, {
					cause: error,
				});
			}
			const bytes = new Uint8Array(received);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return bytes;
		}
		let bytes: ArrayBuffer;
		try {
			bytes = await response.arrayBuffer();
		} catch (error) {
			throw new PrimeSandboxError("invalid_response", `Sandbox download of ${path} returned no body`, {
				cause: error,
			});
		}
		if (bytes.byteLength > MAX_TRANSFER_BYTES) {
			throw new PrimeSandboxError(
				"too_large",
				`Download of ${path} returned ${bytes.byteLength} bytes, exceeding the ${MAX_TRANSFER_BYTES} byte limit`,
			);
		}
		return new Uint8Array(bytes);
	}

	private scaledExecTimeoutMs(timeoutSeconds: number): number {
		// The request must outlive the command: command budget + transport overhead.
		return timeoutSeconds * 1000 + this.requestTimeoutMs;
	}

	private async resolveAuth(sandboxId: string, options: PrimeSandboxGatewayOptions): Promise<PrimeSandboxAuth> {
		if (options.auth) {
			if (options.auth.sandboxId !== sandboxId) {
				throw new PrimeSandboxError("invalid_request", "Provided gateway auth belongs to a different sandbox");
			}
			return options.auth;
		}
		return this.getSandboxAuth(sandboxId, { requestTimeoutMs: options.requestTimeoutMs });
	}

	private gatewayUrl(auth: PrimeSandboxAuth, endpoint: "exec" | "upload" | "download"): string {
		return `${auth.gatewayUrl}/${encodeURIComponent(auth.userNamespace)}/${encodeURIComponent(auth.jobId)}/${endpoint}`;
	}

	private platformHeaders(): Record<string, string> {
		return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
	}

	private platformSecrets(): string[] {
		return [this.apiKey];
	}

	/**
	 * Shared JSON request pipeline: deadline race (works even with a fake
	 * fetch that ignores AbortSignal), typed errors, redacted previews, and
	 * strict response parsing.
	 */
	private async requestJson<T>(options: RequestJsonOptions<T>): Promise<T> {
		const response = await this.fetchWithTimeout(
			options.method,
			options.url,
			options.headers,
			options.body,
			options.timeoutMs,
			options.secrets,
		);
		if (!response.ok) {
			throw await httpError(response, options.method, options.url, options.secrets, options.context);
		}
		const read = await boundedBodyText(response, MAX_JSON_BODY_BYTES);
		if (read === undefined) {
			throw new PrimeSandboxError("invalid_response", `${options.context} returned no response body`, {
				method: options.method,
				url: options.url,
			});
		}
		if (read.truncated) {
			throw new PrimeSandboxError(
				"too_large",
				`${options.context} response exceeds the ${MAX_JSON_BODY_BYTES} byte JSON body limit`,
				{ method: options.method, url: options.url },
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(read.text);
		} catch (error) {
			throw new PrimeSandboxError("invalid_response", `${options.context} returned a non-JSON response`, {
				method: options.method,
				url: options.url,
				cause: error,
			});
		}
		return options.parse(parsed);
	}

	private async fetchWithTimeout(
		method: string,
		url: string,
		headers: Record<string, string>,
		body: unknown,
		timeoutMs: number,
		secrets: readonly string[],
	): Promise<Response> {
		const controller = new AbortController();
		let timedOut = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutMessage = `Request timed out after ${timeoutMs}ms: ${method} ${url}`;
		const timeoutPromise = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				controller.abort();
				reject(
					new PrimeSandboxError("timeout", redactSecrets(timeoutMessage, secrets), {
						method,
						url,
					}),
				);
			}, timeoutMs);
		});
		const fetchPromise = (async () => {
			try {
				return await this.fetchFn(url, {
					method,
					headers,
					...(body !== undefined ? { body: body as RequestInit["body"] } : {}),
					signal: controller.signal,
				});
			} catch (error) {
				if (timedOut) {
					throw new PrimeSandboxError("timeout", redactSecrets(timeoutMessage, secrets), {
						method,
						url,
					});
				}
				throw new PrimeSandboxError(
					"network",
					redactSecrets(`Request failed: ${method} ${url}: ${errorMessage(error)}`, secrets),
					{ method, url, cause: error },
				);
			}
		})();
		try {
			return await Promise.race([fetchPromise, timeoutPromise]);
		} finally {
			clearTimeout(timer);
			// A lost race must not surface as an unhandled rejection.
			fetchPromise.catch(() => undefined);
		}
	}
}

function validateSandboxFilePath(path: string): void {
	if (typeof path !== "string" || path === "" || path.length > 4096 || path.includes("\x00")) {
		throw new PrimeSandboxError("invalid_request", "Sandbox file path must be a non-empty NUL-free string");
	}
}
