import { describe, expect, it, vi } from "vitest";
import { categorizeProbeError, MCP_PROBE_ERRORS, probeMcpEndpoint } from "../src/core/mcp/connection-probe.js";

type FetchCall = { url: string | URL; init: RequestInit };

function jsonRpcResponse(id: number, result: unknown, status = 200): Response {
	return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/**
 * Fake streamable-HTTP MCP server. Responds to initialize, the initialized
 * notification, tools/list, and session termination; GET streams are declined
 * (405, allowed by the spec).
 */
function createMcpFakeFetch(
	options: {
		tools?: Array<{ name: string; inputSchema: { type: string } }>;
		initializeStatus?: number;
		initializeBody?: (body: { id?: number }) => Response;
		sseCrlf?: boolean;
		onDelete?: () => void;
		onInitialize?: (body: unknown) => void;
	} = {},
) {
	const calls: FetchCall[] = [];
	const deletes: unknown[] = [];
	const fetchImpl = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
		calls.push({ url, init });
		const method = init.method ?? "GET";
		if (method === "DELETE") {
			deletes.push(init);
			options.onDelete?.();
			return new Response(null, { status: 200 });
		}
		if (method === "GET") {
			return new Response(null, { status: 405 });
		}
		const body = JSON.parse(String(init.body)) as {
			id?: number;
			method: string;
			params?: { protocolVersion?: string };
		};
		if (body.method === "initialize") {
			options.onInitialize?.(body);
			if (options.initializeBody) return options.initializeBody(body);
			if (options.initializeStatus !== undefined && options.initializeStatus !== 200) {
				return new Response("nope", {
					status: options.initializeStatus,
					headers: { "content-type": "text/plain" },
				});
			}
			if (options.sseCrlf) {
				const payload = JSON.stringify({
					jsonrpc: "2.0",
					id: body.id,
					result: {
						protocolVersion: body.params?.protocolVersion,
						capabilities: {},
						serverInfo: { name: "acme", version: "1.0" },
					},
				});
				return new Response(`event: message\r\ndata: ${payload}\r\n\r\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			const response = jsonRpcResponse(body.id ?? 1, {
				protocolVersion: body.params?.protocolVersion,
				capabilities: {},
				serverInfo: { name: "acme", version: "1.0" },
			});
			// A session id makes the SDK's terminateSession send the cleanup DELETE.
			const headers = new Headers(response.headers);
			headers.set("mcp-session-id", "probe-session");
			return new Response(response.body, { status: response.status, headers });
		}
		if (body.method === "notifications/initialized") {
			return new Response(null, { status: 202 });
		}
		if (body.method === "tools/list") {
			return jsonRpcResponse(body.id ?? 2, {
				tools: options.tools ?? [{ name: "search", inputSchema: { type: "object" } }],
			});
		}
		throw new Error(`unexpected method ${body.method}`);
	});
	return { fetchImpl, calls, deletes };
}

const FAKE_TOKEN = "probe-token-value";

describe("probeMcpEndpoint", () => {
	it("verifies a handshake through the official SDK and terminates the session", async () => {
		const server = createMcpFakeFetch({
			tools: [
				{ name: "a", inputSchema: { type: "object" } },
				{ name: "b", inputSchema: { type: "object" } },
				{ name: "c", inputSchema: { type: "object" } },
			],
		});
		const result = await probeMcpEndpoint({
			url: "https://mcp.acme.test/mcp",
			getToken: () => FAKE_TOKEN,
			fetchImpl: server.fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: true, toolCount: 3 });
		// The session is explicitly terminated (HTTP DELETE), not just aborted.
		expect(server.deletes).toHaveLength(1);
		// The bearer token reaches requests; no redirect following is allowed.
		const bodyText = (call: FetchCall): string => (call.init.body === undefined ? "" : String(call.init.body));
		const initialize = server.calls.find((call) => bodyText(call).includes("initialize"));
		expect(initialize?.init.redirect).toBe("error");
		expect((initialize?.init.headers as Headers).get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);
		// Subsequent requests carry the negotiated protocol version header (SDK-managed).
		const toolsList = server.calls.find((call) => bodyText(call).includes("tools/list"));
		expect((toolsList?.init.headers as Headers).get("mcp-protocol-version")).toBeTruthy();
	});

	it("parses CRLF-separated SSE responses", async () => {
		const server = createMcpFakeFetch({ sseCrlf: true });
		const result = await probeMcpEndpoint({
			url: "https://mcp.acme.test/mcp",
			getToken: () => FAKE_TOKEN,
			fetchImpl: server.fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: true, toolCount: 1 });
	});

	it("maps a 401 to the fixed unauthorized category without echoing server text", async () => {
		const server = createMcpFakeFetch({ initializeStatus: 401 });
		const result = await probeMcpEndpoint({
			url: "https://mcp.acme.test/mcp?session=SECRET",
			getToken: () => FAKE_TOKEN,
			fetchImpl: server.fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, error: MCP_PROBE_ERRORS.UNAUTHORIZED });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("SECRET");
		expect(serialized).not.toContain("mcp.acme.test");
	});

	it("maps network failures (including refused redirects) without echoing the URL", async () => {
		const result = await probeMcpEndpoint({
			url: "https://user:pass@mcp.acme.test/mcp?token=QUERY-SECRET",
			getToken: () => FAKE_TOKEN,
			fetchImpl: (async () => {
				throw new TypeError("fetch failed");
			}) as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, error: MCP_PROBE_ERRORS.NETWORK });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("user:pass");
		expect(serialized).not.toContain("QUERY-SECRET");
		expect(serialized).not.toContain("mcp.acme.test");
	});

	it("drops server-controlled JSON-RPC error text into a fixed category", async () => {
		const server = createMcpFakeFetch({
			initializeBody: (body: { id?: number }) =>
				new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: body.id,
						error: { code: -32000, message: "token probe-token-value leaked at https://mcp.acme.test/mcp" },
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		});
		const result = await probeMcpEndpoint({
			url: "https://mcp.acme.test/mcp",
			getToken: () => FAKE_TOKEN,
			fetchImpl: server.fetchImpl as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, error: MCP_PROBE_ERRORS.SERVER_REJECTED });
		const serialized = JSON.stringify(result);
		expect(serialized).not.toContain("probe-token-value");
		expect(serialized).not.toContain("mcp.acme.test");
	});

	it("reports a fixed timeout category when the endpoint hangs", async () => {
		const result = await probeMcpEndpoint({
			url: "https://mcp.acme.test/mcp",
			getToken: () => FAKE_TOKEN,
			timeoutMs: 40,
			fetchImpl: (async () => {
				await new Promise(() => {});
			}) as unknown as typeof fetch,
		});
		expect(result).toEqual({ ok: false, error: MCP_PROBE_ERRORS.TIMEOUT });
	}, 5000);
});

describe("categorizeProbeError", () => {
	it("always produces one of the fixed categories, never raw error text", () => {
		const categories = new Set(Object.values(MCP_PROBE_ERRORS));
		const samples: unknown[] = [
			new Error("secret https://x.test token=abc"),
			"plain string failure",
			undefined,
			null,
			{ unexpected: "shape" },
		];
		for (const sample of samples) {
			const category = categorizeProbeError(sample);
			expect(categories.has(category)).toBe(true);
		}
	});
});
