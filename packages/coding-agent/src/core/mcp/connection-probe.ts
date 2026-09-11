// Minimal host-side MCP verification probe: initialize + tools/list over streamable HTTP.
// This is a health check only; the Python generic runtime performs all real execution.

export interface McpEndpointProbeOptions {
	/** HTTPS streamable-HTTP MCP endpoint. */
	url: string;
	/** Bearer token getter; empty or undefined sends no Authorization header. */
	getToken: () => string | Promise<string>;
	/** Per-request timeout in milliseconds. Defaults to 15000. */
	timeoutMs?: number;
	/** Injectable fetch for tests. */
	fetchImpl?: typeof fetch;
}

export type McpEndpointProbeResult =
	| { ok: true; toolCount: number; serverName?: string }
	| { ok: false; error: string };

const PROBE_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_ERROR_LENGTH = 300;

interface JsonResponse {
	status: number;
	contentType: string;
	sessionId?: string;
	json: unknown;
}

function truncateError(message: string): string {
	const normalized = message.replace(/[\r\n\t]+/g, " ").trim();
	return normalized.length > MAX_ERROR_LENGTH ? `${normalized.slice(0, MAX_ERROR_LENGTH)}…` : normalized;
}

function isJsonRpcResult(value: unknown, id: number): value is { jsonrpc: string; id: number; result?: unknown } {
	if (!value || typeof value !== "object") return false;
	const message = value as { id?: unknown; error?: unknown };
	return message.id === id;
}

/** Extract data payloads from a buffered SSE chunk, returning the remainder. */
function extractSseData(buffer: string): { events: string[]; remainder: string } {
	const events: string[] = [];
	let remainder = buffer;
	for (;;) {
		const index = remainder.indexOf("\n\n");
		if (index === -1) break;
		const raw = remainder.slice(0, index);
		remainder = remainder.slice(index + 2);
		const data = raw
			.split(/\n/)
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n");
		if (data) events.push(data);
	}
	return { events, remainder };
}

async function postJsonRpc(
	fetchImpl: typeof fetch,
	url: string,
	baseHeaders: Record<string, string>,
	body: Record<string, unknown>,
	options: { timeoutMs: number; sessionId?: string; expectId: number | null },
): Promise<JsonResponse> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs);
	try {
		const headers = { ...baseHeaders };
		if (options.sessionId) headers["mcp-session-id"] = options.sessionId;
		let response: Response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				redirect: "error",
				signal: controller.signal,
			});
		} catch {
			if (controller.signal.aborted) throw new Error(`timed out after ${options.timeoutMs}ms`);
			throw new Error("request failed (network error, refused connection, or refused redirect)");
		}
		const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
		const sessionId = response.headers.get("mcp-session-id") ?? undefined;
		if (contentType === "text/event-stream" && response.body) {
			const json = await readSseJson(response.body, options.expectId, controller);
			return { status: response.status, contentType, sessionId, json };
		}
		const text = await response.text();
		if (response.status >= 200 && response.status < 300 && contentType === "application/json") {
			try {
				return { status: response.status, contentType, sessionId, json: JSON.parse(text) };
			} catch {
				throw new Error(`response was not valid JSON (HTTP ${response.status})`);
			}
		}
		if (response.status >= 200 && response.status < 300) {
			// Accepted notification or empty body.
			return { status: response.status, contentType, sessionId, json: undefined };
		}
		throw new Error(`HTTP ${response.status}`);
	} finally {
		clearTimeout(timer);
	}
}

async function readSseJson(
	body: ReadableStream<Uint8Array>,
	expectId: number | null,
	controller: AbortController,
): Promise<unknown> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const { events, remainder } = extractSseData(buffer);
			buffer = remainder;
			for (const data of events) {
				try {
					const parsed: unknown = JSON.parse(data);
					if (expectId === null || isJsonRpcResult(parsed, expectId)) return parsed;
				} catch {
					// Non-JSON keep-alive or comment events are ignored.
				}
			}
		}
		return undefined;
	} finally {
		await reader.cancel().catch(() => undefined);
		void controller;
	}
}

function expectResult(response: JsonResponse, id: number, step: string): Record<string, unknown> {
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`${step} failed: HTTP ${response.status}`);
	}
	const json = response.json;
	if (!json || typeof json !== "object") throw new Error(`${step} returned no JSON-RPC response`);
	const message = json as { id?: unknown; error?: { message?: unknown }; result?: unknown };
	if (message.error !== undefined) {
		const detail =
			typeof message.error === "object" && message.error !== null && typeof message.error.message === "string"
				? `: ${message.error.message}`
				: "";
		throw new Error(`${step} failed with a server error${detail}`);
	}
	if (message.id !== id || message.result === undefined) {
		throw new Error(`${step} returned no result`);
	}
	return message.result as Record<string, unknown>;
}

/**
 * Verify an MCP endpoint with a real handshake: initialize, notifications/initialized,
 * then tools/list. Returns the discovered tool count. Never echoes response bodies or
 * tokens in error messages.
 */
export async function probeMcpEndpoint(options: McpEndpointProbeOptions): Promise<McpEndpointProbeResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const url = options.url;
	try {
		const token = (await options.getToken()) ?? "";
		const baseHeaders: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(token ? { authorization: `Bearer ${token}` } : {}),
		};

		const initialize = await postJsonRpc(
			fetchImpl,
			url,
			baseHeaders,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROBE_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "prime-agent", version: "mcp-verify" },
				},
			},
			{ timeoutMs, expectId: 1 },
		);
		const initializeResult = expectResult(initialize, 1, "initialize");
		const serverInfo = initializeResult.serverInfo as { name?: unknown } | undefined;
		const serverName = typeof serverInfo?.name === "string" ? serverInfo.name : undefined;

		// The initialized notification's response is not meaningful for verification;
		// a transport-level failure surfaces through the subsequent tools/list call.
		await postJsonRpc(
			fetchImpl,
			url,
			baseHeaders,
			{
				jsonrpc: "2.0",
				method: "notifications/initialized",
			},
			{ timeoutMs, sessionId: initialize.sessionId, expectId: null },
		).catch(() => undefined);

		const toolsList = await postJsonRpc(
			fetchImpl,
			url,
			baseHeaders,
			{
				jsonrpc: "2.0",
				id: 2,
				method: "tools/list",
				params: {},
			},
			{ timeoutMs, sessionId: initialize.sessionId, expectId: 2 },
		);
		const toolsResult = expectResult(toolsList, 2, "tools/list");
		const tools = toolsResult.tools;
		if (!Array.isArray(tools)) throw new Error("tools/list returned no tool array");
		return { ok: true, toolCount: tools.length, ...(serverName ? { serverName } : {}) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: truncateError(`MCP verification at ${url} failed: ${message}`) };
	}
}
