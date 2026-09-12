// MCP connection verification: a real handshake (initialize -> tools/list) through the
// official @modelcontextprotocol/sdk client. Health check only — the Python generic
// runtime performs all real execution.
//
// Error reporting uses fixed, safe categories. The endpoint URL, response bodies,
// server-controlled messages, and server names are untrusted and never appear in
// results: they can embed credentials/query secrets and provider-controlled text.

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

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

/** Fixed failure categories; safe to persist and show to the model. */
export const MCP_PROBE_ERRORS = {
	TIMEOUT: "verification-timeout",
	UNAUTHORIZED: "http-unauthorized",
	NETWORK: "network-unreachable",
	SERVER_REJECTED: "server-rejected-handshake",
	HTTP_ERROR: "http-error",
	INVALID_RESPONSE: "invalid-response",
	UNKNOWN: "verification-failed",
	/** The grant changed while the probe ran; the result was discarded, nothing persisted. */
	CREDENTIAL_CHANGED: "credential-changed",
} as const;

export type McpEndpointProbeResult =
	| { ok: true; toolCount: number }
	| { ok: false; error: (typeof MCP_PROBE_ERRORS)[keyof typeof MCP_PROBE_ERRORS] };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Verify an MCP endpoint with a real handshake using the official SDK client:
 * connect (initialize + initialized notification), tools/list, then an explicit
 * session termination (HTTP DELETE). Tool counts reflect the first page; the count
 * is a verification signal, not a complete inventory.
 */
export async function probeMcpEndpoint(options: McpEndpointProbeOptions): Promise<McpEndpointProbeResult> {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	let transport: StreamableHTTPClientTransport | undefined;
	try {
		const token = (await options.getToken()) ?? "";
		const url = new URL(options.url);
		transport = new StreamableHTTPClientTransport(url, {
			requestInit: {
				// No redirects: a redirecting endpoint must not receive the token.
				redirect: "error",
				...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
			},
			...(options.fetchImpl ? { fetch: options.fetchImpl } : {}),
		});
		const client = new Client({ name: "prime-agent", version: "mcp-verify" }, { capabilities: {} });
		try {
			await client.connect(transport, { timeout: timeoutMs });
			const result = await client.listTools(undefined, { timeout: timeoutMs });
			return { ok: true, toolCount: result.tools?.length ?? 0 };
		} finally {
			// Terminate the session explicitly; servers may decline (405), which is fine.
			await transport.terminateSession().catch(() => undefined);
			await client.close().catch(() => undefined);
		}
	} catch (error) {
		return { ok: false, error: categorizeProbeError(error) };
	}
}

/** Map any failure to one fixed, safe category; drop all untrusted detail. */
export function categorizeProbeError(error: unknown): (typeof MCP_PROBE_ERRORS)[keyof typeof MCP_PROBE_ERRORS] {
	if (error instanceof McpError) {
		if (error.code === ErrorCode.RequestTimeout) return MCP_PROBE_ERRORS.TIMEOUT;
		// JSON-RPC-level rejection: the server's message is untrusted text.
		return MCP_PROBE_ERRORS.SERVER_REJECTED;
	}
	if (error instanceof UnauthorizedError) return MCP_PROBE_ERRORS.UNAUTHORIZED;
	if (error instanceof StreamableHTTPError) {
		if (error.code === 401 || error.code === 403) return MCP_PROBE_ERRORS.UNAUTHORIZED;
		return MCP_PROBE_ERRORS.HTTP_ERROR;
	}
	if (error instanceof Error && error.name === "TimeoutError") return MCP_PROBE_ERRORS.TIMEOUT;
	// SDK schema-validation failures (e.g. a malformed tools/list result). Zod v4
	// raises $ZodError; older stacks used ZodError/ValidationError.
	if (
		error instanceof Error &&
		(error.name === "ZodError" || error.name === "$ZodError" || error.name === "ValidationError")
	) {
		return MCP_PROBE_ERRORS.INVALID_RESPONSE;
	}
	if (error instanceof TypeError) {
		// fetch rejects with TypeError on unreachable hosts, refused redirects, and
		// URLs with embedded credentials; the URL itself is never echoed.
		return MCP_PROBE_ERRORS.NETWORK;
	}
	if (error instanceof Error && error.name === "AbortError") return MCP_PROBE_ERRORS.TIMEOUT;
	if (error instanceof SyntaxError) return MCP_PROBE_ERRORS.INVALID_RESPONSE;
	return MCP_PROBE_ERRORS.UNKNOWN;
}
