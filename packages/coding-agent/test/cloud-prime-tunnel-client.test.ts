import { describe, expect, it } from "vitest";
import { PrimeTunnelClient, PrimeTunnelError } from "../src/core/cloud/prime-tunnel-client.js";

const now = "2026-01-01T00:00:00.000Z";
const future = "2027-01-01T00:00:00.000Z";

function registrationBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tunnel_id: "tun_abc123",
		name: "prime-agent-sess_1",
		hostname: "tun-abc123.tunnels.example.com",
		url: "https://tun-abc123.tunnels.example.com",
		frp_token: "frp-secret-token",
		binding_secret: "binding-secret",
		server_host: "frps.example.com",
		server_port: 7000,
		local_port: 8740,
		labels: ["prime-agent-cloud"],
		http_user: "prime-agent",
		http_password: "edge-password-once",
		expires_at: future,
		status: "PENDING",
		created_at: now,
		...overrides,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function makeClient(fetchFn: typeof fetch): PrimeTunnelClient {
	return new PrimeTunnelClient({
		apiKey: "platform-key",
		baseUrl: "https://api.primeintellect.ai",
		fetchFn,
		requestTimeoutMs: 500,
	});
}

describe("PrimeTunnelClient", () => {
	it("registers a tunnel with the documented request shape and validates the response strictly", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const client = makeClient(async (url, init) => {
			calls.push({ url: String(url), init: init ?? {} });
			return jsonResponse(registrationBody());
		});
		const registration = await client.createTunnel({
			guestPort: 8740,
			teamId: "team_123",
			labels: ["prime-agent-cloud", "session:sess_1"],
			httpUser: "prime-agent",
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.primeintellect.ai/api/v1/tunnel");
		expect(calls[0]?.init.method).toBe("POST");
		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer platform-key");
		const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
		expect(body).toEqual({
			local_port: 8740,
			name: expect.stringMatching(/^prime-agent-/) as unknown as string,
			labels: ["prime-agent-cloud", "session:sess_1"],
			teamId: "team_123",
			http_user: "prime-agent",
		});
		expect(registration).toMatchObject({
			tunnelId: "tun_abc123",
			url: "https://tun-abc123.tunnels.example.com",
			hostname: "tun-abc123.tunnels.example.com",
			httpUser: "prime-agent",
			httpPassword: "edge-password-once",
			frpToken: "frp-secret-token",
			bindingSecret: "binding-secret",
			serverHost: "frps.example.com",
			serverPort: 7000,
			expiresAt: future,
		});
	});

	it("rejects malformed create responses instead of defaulting", async () => {
		for (const overrides of [
			{ tunnel_id: "bad id with spaces" },
			{ url: "" },
			{ frp_token: "" },
			{ server_port: 0 },
			{ expires_at: "not-a-date" },
			{ http_user: "prime-agent" },
			{ http_password: 12345 },
			{ status: "SOMETHING_ELSE" },
			{},
		]) {
			const client = makeClient(async () => jsonResponse(registrationBody(overrides)));
			await expect(client.createTunnel({ guestPort: 8740 })).rejects.toThrow(PrimeTunnelError);
		}
	});

	it("validates requests before any bytes reach the network", async () => {
		const client = makeClient(async () => {
			throw new Error("network must not be reached");
		});
		await expect(client.createTunnel({ guestPort: 0 })).rejects.toThrow(/guestPort/);
		await expect(client.createTunnel({ guestPort: 8740, httpUser: "bad user" })).rejects.toThrow(/httpUser/);
		await expect(client.createTunnel({ guestPort: 8740, teamId: "bad team" })).rejects.toThrow(/teamId/);
		await expect(client.createTunnel({ guestPort: 8740, labels: [""] })).rejects.toThrow(/labels/);
		await expect(client.deleteTunnel("bad id")).rejects.toThrow(PrimeTunnelError);
		await expect(client.getTunnel("../escape")).rejects.toThrow(PrimeTunnelError);
	});

	it("maps auth, payment, and limit failures to typed errors without leaking secrets", async () => {
		const unauthorized = makeClient(async () => new Response("unauthorized", { status: 401 }));
		const err = await unauthorized.createTunnel({ guestPort: 8740 }).catch((error: unknown) => error);
		expect(err).toBeInstanceOf(PrimeTunnelError);
		expect((err as PrimeTunnelError).code).toBe("auth");

		const payment = makeClient(async () => new Response("payment required", { status: 402 }));
		await expect(payment.createTunnel({ guestPort: 8740 })).rejects.toThrow(/billing/);

		const limit = makeClient(async () =>
			jsonResponse({ detail: "You have reached the maximum number of tunnels" }, 400),
		);
		const limited = await limit.createTunnel({ guestPort: 8740 }).catch((error: unknown) => error);
		expect(limited).toBeInstanceOf(PrimeTunnelError);
		expect((limited as PrimeTunnelError).code).toBe("limit_reached");
	});

	it("normalizes the deployed lowercase statuses and treats terminal tunnels as gone", async () => {
		const statusBody = (status: string) => ({
			tunnel_id: "tun_abc123",
			hostname: "tun-abc123.tunnels.example.com",
			url: "https://tun-abc123.tunnels.example.com",
			local_port: 8740,
			labels: [],
			http_user: "prime-agent",
			expires_at: future,
			status,
		});
		// The deployed service reports lowercase lifecycle tokens.
		const lower = makeClient(async () => jsonResponse(statusBody("connected")));
		expect((await lower.getTunnel("tun_abc123"))?.status).toBe("CONNECTED");
		const pending = makeClient(async () => jsonResponse(statusBody("pending")));
		expect((await pending.getTunnel("tun_abc123"))?.status).toBe("PENDING");
		// Deleted tunnels answer HTTP 200 with a terminal status, not 404.
		const terminated = makeClient(async () => jsonResponse(statusBody("terminated")));
		expect(await terminated.getTunnel("tun_abc123")).toBeUndefined();
		const expired = makeClient(async () => jsonResponse(statusBody("EXPIRED")));
		expect(await expired.getTunnel("tun_abc123")).toBeUndefined();
		// Unknown statuses still fail closed instead of guessing.
		const bogus = makeClient(async () => jsonResponse(statusBody("later")));
		await expect(bogus.getTunnel("tun_abc123")).rejects.toThrow(PrimeTunnelError);
		// A create response that reports a terminal status is invalid.
		const badCreate = makeClient(async () => jsonResponse(registrationBody({ status: "terminated" })));
		await expect(badCreate.createTunnel({ guestPort: 8740 })).rejects.toThrow(PrimeTunnelError);
	});

	it("treats a delete response echoing a terminated tunnel as already gone", async () => {
		const responses = [
			jsonResponse({ tunnel_id: "tun_abc123", status: "terminated" }),
			jsonResponse({ deleted: true }),
		];
		let call = 0;
		const client = makeClient(async () => responses[Math.min(call++, responses.length - 1)] as Response);
		// A deployment that echoes the terminated record answers "already gone".
		expect(await client.deleteTunnel("tun_abc123")).toBe(false);
		// The plain acknowledgement still reports a real delete.
		expect(await client.deleteTunnel("tun_abc123")).toBe(true);
	});

	it("treats delete 404 as already gone and returns tunnel status without secrets", async () => {
		let deleteStatus = 404;
		const client = makeClient(async (_url, init) => {
			const method = (init ?? {}).method ?? "GET";
			if (method === "DELETE") {
				return deleteStatus === 404 ? new Response("not found", { status: 404 }) : jsonResponse({ deleted: true });
			}
			return jsonResponse({
				tunnel_id: "tun_abc123",
				hostname: "tun-abc123.tunnels.example.com",
				url: "https://tun-abc123.tunnels.example.com",
				local_port: 8740,
				labels: [],
				http_user: "prime-agent",
				expires_at: future,
				status: "CONNECTED",
			});
		});
		expect(await client.deleteTunnel("tun_abc123")).toBe(false);
		deleteStatus = 200;
		expect(await client.deleteTunnel("tun_abc123")).toBe(true);
		const status = await client.getTunnel("tun_abc123");
		expect(status).toMatchObject({ tunnelId: "tun_abc123", status: "CONNECTED", httpUser: "prime-agent" });
		expect(await makeClient(async () => new Response("", { status: 404 })).getTunnel("tun_abc123")).toBeUndefined();
	});

	it("surfaces timeouts and network failures as typed errors", async () => {
		const hanging = makeClient(() => new Promise<Response>(() => {}));
		await expect(hanging.createTunnel({ guestPort: 8740 })).rejects.toThrow(/timed out/);
		const failing = makeClient(async () => {
			throw new Error("connection reset");
		});
		await expect(failing.createTunnel({ guestPort: 8740 })).rejects.toThrow(PrimeTunnelError);
	});

	it("requires https base URLs and an API key", () => {
		expect(() => new PrimeTunnelClient({ apiKey: "", baseUrl: "https://api.example.com" })).toThrow(PrimeTunnelError);
		expect(() => new PrimeTunnelClient({ apiKey: "k", baseUrl: "http://api.example.com" })).toThrow(/https/);
		expect(() => new PrimeTunnelClient({ apiKey: "k", baseUrl: "https://api.example.com/api/v1" })).not.toThrow();
	});
});
