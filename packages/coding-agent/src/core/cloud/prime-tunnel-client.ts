import { randomUUID } from "node:crypto";

/**
 * Direct REST client for Prime Tunnels.
 *
 * Direction A of the cloud bridge: the LOCAL daemon registers the tunnel with
 * the Prime platform using the user's existing Prime API credentials; the
 * guest sandbox only receives the frp connection details of that one tunnel
 * (frp token, binding secret, server host/port, subdomain). The guest never
 * sees the platform API key and can never call the tunnel REST API itself:
 * register, inspect, and delete stay local.
 *
 * Wire contract (verified against the `prime_tunnel` SDK shipped by the
 * `prime` CLI 0.1.11):
 *
 * - `POST   {base}/api/v1/tunnel`        register; snake_case body, `teamId`
 *                                        and `http_user` camel/snake as noted
 * - `GET    {base}/api/v1/tunnel/{id}`   status; no secrets in the response
 * - `DELETE {base}/api/v1/tunnel/{id}`   delete; 404 means already gone
 *
 * Safety contract:
 * - No secret (API key, frp token, binding secret, basic-auth password) ever
 *   appears in an error message or URL.
 * - Every response is strictly validated; a 200 with a malformed body is a
 *   typed `invalid_response` error, never a silent default.
 * - The create response is the only place the one-time basic-auth password
 *   and the frp token are ever returned; callers must persist them durably
 *   and treat them as secrets.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_JSON_BODY_BYTES = 1_048_576;
const MAX_RESPONSE_PREVIEW_CHARS = 512;
const URL_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_TUNNEL_NAME_CHARS = 128;
const MAX_LABEL_CHARS = 256;
const MAX_HTTP_USER_CHARS = 64;

export const PRIME_TUNNEL_STATUSES = ["PENDING", "CONNECTED", "DISCONNECTED", "EXPIRED", "TERMINATED"] as const;
export type PrimeTunnelStatus = (typeof PRIME_TUNNEL_STATUSES)[number];
/** Terminal statuses: the registration is gone or permanently unusable. */
export const PRIME_TUNNEL_TERMINAL_STATUSES: readonly PrimeTunnelStatus[] = ["EXPIRED", "TERMINATED"];

/** Registration request; `guestPort` is the loopback port frpc forwards to inside the sandbox. */
export interface PrimeTunnelCreateRequest {
	/** Friendly name; defaults to a generated id. */
	name?: string;
	/** Team scope; omit for the user's personal tunnels. */
	teamId?: string;
	/** Free-form labels for discoverability and bulk cleanup. */
	labels?: string[];
	/** HTTP basic auth username enforced at the tunnel edge. The backend generates the password. */
	httpUser?: string;
	/** Loopback port inside the sandbox that frpc forwards the edge to. */
	guestPort: number;
}

/** A registered tunnel. Create carries the secrets; get does not. */
export interface PrimeTunnel {
	tunnelId: string;
	/** Public HTTPS origin of the tunnel, e.g. "https://<id>.tunnels.example.com". */
	url: string;
	/** Public hostname of the tunnel edge. */
	hostname: string;
	/** Loopback port inside the sandbox. */
	guestPort?: number;
	labels: string[];
	/** Basic auth username when edge auth is enabled. */
	httpUser?: string;
	/** ISO-8601 registration expiry. */
	expiresAt: string;
	/** Deployment lifecycle token; lowercase tokens are normalized. */
	status?: PrimeTunnelStatus;
	userId?: string;
	teamId?: string;
	createdAt?: string;
}

/** Create response: the only carrier of the tunnel's connection secrets. */
export interface PrimeTunnelRegistration extends PrimeTunnel {
	/** Edge basic auth username; always present because create requests auth. */
	httpUser: string;
	/** frps authentication token; only valid for this tunnel's frpc connection. */
	frpToken: string;
	/** Per-tunnel proxy binding secret. */
	bindingSecret: string;
	/** frps dial endpoint host. */
	serverHost: string;
	/** frps dial endpoint port. */
	serverPort: number;
	/** One-time auto-generated edge basic-auth password; never retrievable again. */
	httpPassword: string;
}

export type PrimeTunnelErrorCode =
	| "invalid_request"
	| "network"
	| "timeout"
	| "http"
	| "invalid_response"
	| "auth"
	| "payment_required"
	| "limit_reached"
	| "not_found";

/** Typed, redacted error. Messages never contain the API key or any tunnel secret. */
export class PrimeTunnelError extends Error {
	readonly code: PrimeTunnelErrorCode;
	readonly method?: string;
	/** Sanitized request URL (no credentials). */
	readonly url?: string;
	/** HTTP status for `code === "http"`. */
	readonly status?: number;
	readonly details?: string;

	constructor(
		code: PrimeTunnelErrorCode,
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
		this.name = "PrimeTunnelError";
		this.code = code;
		this.method = properties.method;
		this.url = properties.url;
		this.status = properties.status;
		this.details = properties.details;
	}
}

export interface PrimeTunnelClientOptions {
	/** Prime platform API key; sent as `Authorization: Bearer <key>`. */
	apiKey: string;
	/**
	 * Prime platform API origin, e.g. "https://api.primeintellect.ai". A
	 * trailing `/api/v1` is accepted and normalized away.
	 */
	baseUrl: string;
	/** Injectable fetch; defaults to the global fetch. */
	fetchFn?: typeof fetch;
	/** Default per-request timeout. */
	requestTimeoutMs?: number;
}

interface RequestJsonOptions<T> {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: unknown;
	timeoutMs: number;
	secrets: readonly string[];
	context: string;
	parse: (value: unknown) => T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function redactSecrets(text: string, secrets: readonly string[]): string {
	let redacted = text;
	for (const secret of secrets) {
		if (secret.length > 0) redacted = redacted.split(secret).join("[redacted]");
	}
	return redacted.length > MAX_RESPONSE_PREVIEW_CHARS
		? `${redacted.slice(0, MAX_RESPONSE_PREVIEW_CHARS - 1)}…`
		: redacted;
}

function optionalString(value: unknown, label: string, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.length === 0 || value.length > maxChars || value.includes("\x00")) {
		throw new PrimeTunnelError("invalid_response", `${label} is not a bounded non-empty string`);
	}
	return value;
}

function requiredString(value: unknown, label: string, maxChars: number): string {
	const parsed = optionalString(value, label, maxChars);
	if (parsed === undefined) {
		throw new PrimeTunnelError("invalid_response", `${label} is required`);
	}
	return parsed;
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
	const parsed = optionalString(value, label, 64);
	if (parsed === undefined) return undefined;
	if (Number.isNaN(Date.parse(parsed))) {
		throw new PrimeTunnelError("invalid_response", `${label} is not an ISO-8601 timestamp`);
	}
	return parsed;
}

function requiredInteger(value: unknown, label: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		throw new PrimeTunnelError("invalid_response", `${label} must be an integer from ${min} to ${max}`);
	}
	return value;
}

function parseStatus(value: unknown): PrimeTunnelStatus | undefined {
	if (value === undefined || value === null) return undefined;
	// The deployed tunnel service reports lowercase tokens ("pending",
	// "terminated"); normalize before validating.
	const normalized = typeof value === "string" ? value.toUpperCase() : value;
	if (typeof normalized !== "string" || !(PRIME_TUNNEL_STATUSES as readonly string[]).includes(normalized)) {
		throw new PrimeTunnelError("invalid_response", `status must be one of ${PRIME_TUNNEL_STATUSES.join(", ")}`);
	}
	return normalized as PrimeTunnelStatus;
}

function isTerminalTunnelStatus(status: PrimeTunnelStatus | undefined): boolean {
	return status !== undefined && (PRIME_TUNNEL_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** https-only base URL, with an optional trailing `/api/v1` normalized away. */
function normalizeBaseUrl(value: string): string {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new PrimeTunnelError("invalid_request", "Prime tunnel base URL must be an absolute http(s) URL");
	}
	if (parsed.protocol !== "https:") {
		throw new PrimeTunnelError("invalid_request", "Prime tunnel base URL must use https");
	}
	const path = parsed.pathname.replace(/\/$/, "").replace(/\/api\/v1$/, "");
	return `${parsed.protocol}//${parsed.host}${path}`;
}

/** Strict parser for the create response; every secret is validated before use. */
function parseRegistration(value: unknown): PrimeTunnelRegistration {
	if (!isRecord(value)) {
		throw new PrimeTunnelError("invalid_response", "tunnel create response must be a JSON object");
	}
	const tunnelId = requiredString(value.tunnel_id, "tunnel_id", 128);
	if (!URL_SEGMENT_PATTERN.test(tunnelId)) {
		throw new PrimeTunnelError("invalid_response", "tunnel_id is not a URL-safe segment");
	}
	const url = requiredString(value.url, "url", 2048);
	const hostname = requiredString(value.hostname, "hostname", 255);
	const frpToken = requiredString(value.frp_token, "frp_token", 2048);
	const bindingSecret = requiredString(value.binding_secret, "binding_secret", 2048);
	const serverHost = requiredString(value.server_host, "server_host", 255);
	const serverPort = requiredInteger(value.server_port, "server_port", 1, 65535);
	const httpUser = optionalString(value.http_user, "http_user", MAX_HTTP_USER_CHARS);
	const httpPassword = requiredString(value.http_password, "http_password", 2048);
	if (httpUser === undefined || httpPassword === undefined) {
		throw new PrimeTunnelError(
			"invalid_response",
			"tunnel create response is missing the edge basic auth credentials",
		);
	}
	const labels = value.labels;
	if (labels !== undefined && (!Array.isArray(labels) || labels.some((item) => typeof item !== "string"))) {
		throw new PrimeTunnelError("invalid_response", "labels must be an array of strings");
	}
	const status = parseStatus(value.status);
	if (isTerminalTunnelStatus(status)) {
		throw new PrimeTunnelError("invalid_response", "tunnel create response reports a terminal status");
	}
	const expiresAt = requiredString(value.expires_at, "expires_at", 64);
	if (Number.isNaN(Date.parse(expiresAt))) {
		throw new PrimeTunnelError("invalid_response", "expires_at is not an ISO-8601 timestamp");
	}
	return {
		tunnelId,
		url,
		hostname,
		...(value.local_port === undefined || value.local_port === null
			? {}
			: { guestPort: requiredInteger(value.local_port, "local_port", 1, 65535) }),
		labels: (labels as string[] | undefined) ?? [],
		httpUser,
		expiresAt,
		...(status === undefined ? {} : { status }),
		...(value.user_id === undefined || value.user_id === null
			? {}
			: { userId: requiredString(value.user_id, "user_id", 128) }),
		...(value.team_id === undefined || value.team_id === null
			? {}
			: { teamId: requiredString(value.team_id, "team_id", 128) }),
		...(value.created_at === undefined || value.created_at === null
			? {}
			: { createdAt: optionalTimestamp(value.created_at, "created_at") }),
		frpToken,
		bindingSecret,
		serverHost,
		serverPort,
		httpPassword,
	};
}

/** Strict parser for the status response; no secrets are ever present. */
function parseTunnel(value: unknown): PrimeTunnel {
	if (!isRecord(value)) {
		throw new PrimeTunnelError("invalid_response", "tunnel status response must be a JSON object");
	}
	const tunnelId = requiredString(value.tunnel_id, "tunnel_id", 128);
	if (!URL_SEGMENT_PATTERN.test(tunnelId)) {
		throw new PrimeTunnelError("invalid_response", "tunnel_id is not a URL-safe segment");
	}
	const url = requiredString(value.url, "url", 2048);
	const hostname = requiredString(value.hostname, "hostname", 255);
	const expiresAt = requiredString(value.expires_at, "expires_at", 64);
	if (Number.isNaN(Date.parse(expiresAt))) {
		throw new PrimeTunnelError("invalid_response", "expires_at is not an ISO-8601 timestamp");
	}
	const status = parseStatus(value.status);
	const labels = value.labels;
	if (labels !== undefined && (!Array.isArray(labels) || labels.some((item) => typeof item !== "string"))) {
		throw new PrimeTunnelError("invalid_response", "labels must be an array of strings");
	}
	return {
		tunnelId,
		url,
		hostname,
		...(value.local_port === undefined || value.local_port === null
			? {}
			: { guestPort: requiredInteger(value.local_port, "local_port", 1, 65535) }),
		labels: (labels as string[] | undefined) ?? [],
		...(value.http_user === undefined || value.http_user === null
			? {}
			: { httpUser: optionalString(value.http_user, "http_user", MAX_HTTP_USER_CHARS) }),
		expiresAt,
		...(status === undefined ? {} : { status }),
		...(value.user_id === undefined || value.user_id === null
			? {}
			: { userId: requiredString(value.user_id, "user_id", 128) }),
		...(value.team_id === undefined || value.team_id === null
			? {}
			: { teamId: requiredString(value.team_id, "team_id", 128) }),
		...(value.created_at === undefined || value.created_at === null
			? {}
			: { createdAt: optionalTimestamp(value.created_at, "created_at") }),
	};
}

/**
 * Client for the Prime Tunnel REST surface. Register with the user's platform
 * credentials, never with anything derived from inside the guest.
 */
export class PrimeTunnelClient {
	private readonly apiKey: string;
	private readonly baseUrl: string;
	private readonly fetchFn: typeof fetch;
	private readonly requestTimeoutMs: number;

	constructor(options: PrimeTunnelClientOptions) {
		if (!options.apiKey) throw new PrimeTunnelError("invalid_request", "Prime tunnel client requires an API key");
		this.apiKey = options.apiKey;
		this.baseUrl = normalizeBaseUrl(options.baseUrl);
		this.fetchFn = options.fetchFn ?? fetch;
		const timeout = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		if (!Number.isInteger(timeout) || timeout < 1) {
			throw new PrimeTunnelError("invalid_request", "requestTimeoutMs must be a positive integer");
		}
		this.requestTimeoutMs = timeout;
	}

	/**
	 * Register a tunnel. The response carries the frp connection details and
	 * the one-time edge basic-auth password; treat all of them as secrets.
	 */
	async createTunnel(request: PrimeTunnelCreateRequest): Promise<PrimeTunnelRegistration> {
		if (!Number.isInteger(request.guestPort) || request.guestPort < 1 || request.guestPort > 65535) {
			throw new PrimeTunnelError("invalid_request", "guestPort must be an integer from 1 to 65535");
		}
		const name = request.name ?? `prime-agent-${randomUUID()}`;
		if (name.length > MAX_TUNNEL_NAME_CHARS || name.includes("\x00")) {
			throw new PrimeTunnelError("invalid_request", "name must be a NUL-free string of at most 128 characters");
		}
		if (request.teamId !== undefined && !URL_SEGMENT_PATTERN.test(request.teamId)) {
			throw new PrimeTunnelError("invalid_request", "teamId must be a URL-safe segment");
		}
		if (request.httpUser !== undefined) {
			if (request.httpUser.length === 0 || request.httpUser.length > MAX_HTTP_USER_CHARS) {
				throw new PrimeTunnelError("invalid_request", "httpUser must be a string of 1-64 characters");
			}
			if (/[:\s]/.test(request.httpUser)) {
				throw new PrimeTunnelError("invalid_request", "httpUser must not contain spaces or colons");
			}
		}
		const labels = request.labels ?? [];
		for (const label of labels) {
			if (
				typeof label !== "string" ||
				label.length === 0 ||
				label.length > MAX_LABEL_CHARS ||
				label.includes("\x00")
			) {
				throw new PrimeTunnelError("invalid_request", "labels must be non-empty strings of at most 256 characters");
			}
		}
		const body: Record<string, unknown> = {
			local_port: request.guestPort,
			name,
			labels,
		};
		if (request.teamId !== undefined) body.teamId = request.teamId;
		if (request.httpUser !== undefined) body.http_user = request.httpUser;
		const registration = await this.requestJson({
			method: "POST",
			url: `${this.baseUrl}/api/v1/tunnel`,
			headers: this.headers(),
			body: JSON.stringify(body),
			timeoutMs: this.requestTimeoutMs,
			context: "tunnel create",
			secrets: [this.apiKey],
			parse: parseRegistration,
		});
		if (registration.httpUser !== request.httpUser) {
			throw new PrimeTunnelError("invalid_response", "tunnel create response does not echo the requested auth user");
		}
		return registration;
	}

	/**
	 * Tunnel status; undefined when the tunnel no longer exists. The deployed
	 * service answers 200 with a terminal status (e.g. "terminated") for a
	 * deleted tunnel instead of 404, so terminal statuses count as gone.
	 */
	async getTunnel(tunnelId: string): Promise<PrimeTunnel | undefined> {
		this.requireTunnelId(tunnelId);
		const response = await this.fetchWithTimeout(
			"GET",
			`${this.baseUrl}/api/v1/tunnel/${tunnelId}`,
			this.headers(),
			undefined,
			this.requestTimeoutMs,
			[this.apiKey],
		);
		if (response.status === 404) return undefined;
		const tunnel = await this.readJson(response, "GET", this.baseUrl, "tunnel status", [this.apiKey], parseTunnel);
		return isTerminalTunnelStatus(tunnel.status) ? undefined : tunnel;
	}

	/** Delete a tunnel; false when it was already gone. */
	async deleteTunnel(tunnelId: string): Promise<boolean> {
		this.requireTunnelId(tunnelId);
		const response = await this.fetchWithTimeout(
			"DELETE",
			`${this.baseUrl}/api/v1/tunnel/${tunnelId}`,
			this.headers(),
			undefined,
			this.requestTimeoutMs,
			[this.apiKey],
		);
		if (response.status === 404) return false;
		let alreadyGone = false;
		await this.readJson(response, "DELETE", this.baseUrl, "tunnel delete", [this.apiKey], (value) => {
			if (value !== undefined && !isRecord(value) && typeof value !== "boolean") {
				throw new PrimeTunnelError("invalid_response", "tunnel delete response must be empty or an object");
			}
			// Some deployments echo the post-delete record (status
			// "terminated") instead of an empty body; that means already gone.
			if (isRecord(value) && isTerminalTunnelStatus(parseStatus(value.status))) alreadyGone = true;
			return undefined;
		});
		return !alreadyGone;
	}

	private requireTunnelId(tunnelId: string): void {
		if (!URL_SEGMENT_PATTERN.test(tunnelId)) {
			throw new PrimeTunnelError("invalid_request", "tunnelId must be a URL-safe segment");
		}
	}

	private headers(): Record<string, string> {
		return {
			Authorization: `Bearer ${this.apiKey}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		};
	}

	private async requestJson<T>(options: RequestJsonOptions<T>): Promise<T> {
		const response = await this.fetchWithTimeout(
			options.method,
			options.url,
			options.headers,
			options.body,
			options.timeoutMs,
			options.secrets,
		);
		return await this.readJson(
			response,
			options.method,
			options.url,
			options.context,
			options.secrets,
			options.parse,
		);
	}

	private async readJson<T>(
		response: Response,
		method: string,
		url: string,
		context: string,
		secrets: readonly string[],
		parse: (value: unknown) => T,
	): Promise<T> {
		if (response.status === 401) {
			throw new PrimeTunnelError("auth", "Prime tunnel API rejected the API key", { method, url });
		}
		if (response.status === 402) {
			throw new PrimeTunnelError("payment_required", "Prime tunnel API rejected the request: billing problem", {
				method,
				url,
			});
		}
		if (!response.ok) {
			const details = await boundedBodyText(response);
			// The backend reports the per-user tunnel cap as a 400 with this text
			// (mirrors the SDK's TunnelLimitReachedError).
			if (response.status === 400 && (details ?? "").toLowerCase().includes("maximum number of")) {
				throw new PrimeTunnelError(
					"limit_reached",
					`${context} reached the tunnel limit; delete an existing tunnel first`,
					{ method, url, status: response.status },
				);
			}
			throw new PrimeTunnelError("http", `${context} failed with HTTP ${response.status}`, {
				method,
				url,
				status: response.status,
				details: redactSecrets(details ?? "", secrets),
			});
		}
		if (response.status === 204) return parse(undefined);
		const text = await boundedBodyText(response);
		if (text === undefined || text === "") {
			throw new PrimeTunnelError("invalid_response", `${context} returned no response body`, { method, url });
		}
		if (text.length > MAX_JSON_BODY_BYTES) {
			throw new PrimeTunnelError("invalid_response", `${context} response exceeds the JSON body limit`, {
				method,
				url,
			});
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			throw new PrimeTunnelError("invalid_response", `${context} returned a non-JSON response`, {
				method,
				url,
				cause: error,
			});
		}
		return parse(parsed);
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
				reject(new PrimeTunnelError("timeout", redactSecrets(timeoutMessage, secrets), { method, url }));
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
					throw new PrimeTunnelError("timeout", redactSecrets(timeoutMessage, secrets), { method, url });
				}
				throw new PrimeTunnelError(
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
			fetchPromise.catch(() => undefined);
		}
	}
}

async function boundedBodyText(response: Response): Promise<string | undefined> {
	const reader = response.body?.getReader();
	if (reader === undefined) {
		const text = await response.text();
		return text.length > MAX_JSON_BODY_BYTES ? text.slice(0, MAX_RESPONSE_PREVIEW_CHARS) : text;
	}
	let received = 0;
	const chunks: Uint8Array[] = [];
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value !== undefined) {
			received += value.byteLength;
			if (received > MAX_JSON_BODY_BYTES) {
				throw new PrimeTunnelError("invalid_response", "response exceeds the JSON body limit");
			}
			chunks.push(value);
		}
	}
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder("utf-8").decode(merged);
}
