import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_REVISION,
	type DaemonOutbound,
	type DaemonPeerTransportTicket,
	type DaemonResponse,
} from "../src/modes/daemon/daemon-protocol.js";
import { createDaemonSessionTransport, DaemonRoutedClient } from "../src/modes/daemon/daemon-routed-client.js";
import { getDaemonSocketIdentity } from "../src/modes/daemon/daemon-socket.js";
import { DaemonWorkerClient } from "../src/modes/daemon/daemon-worker-client.js";

const HELLO = {
	type: "daemon_hello",
	socketPath: "/tmp/fake.sock",
	protocol: DAEMON_PROTOCOL_INFO,
	schemaRevision: DAEMON_SCHEMA_REVISION,
	clientId: "client-1",
	serverCapabilities: ["session_input_admission", "direct_peer_transport"],
} as const;

function makeFakeEndpoint(hello: unknown = HELLO) {
	const requests: { type: string }[] = [];
	return {
		requests,
		client: {
			hello,
			isConnected: true,
			supportsServerCapability: (capability: string) =>
				Array.isArray((hello as { serverCapabilities?: string[] })?.serverCapabilities) &&
				(hello as { serverCapabilities: string[] }).serverCapabilities.includes(capability),
			onMessage: () => () => {},
			onClose: () => () => {},
			request: async (command: { type: string }): Promise<DaemonResponse> => {
				requests.push(command);
				return { type: "response", command: command.type, success: true };
			},
			close: () => {},
		},
	};
}

describe("DaemonRoutedClient routing", () => {
	it("routes only session-plane commands the worker's own hello serves to the direct socket", async () => {
		const supervisor = makeFakeEndpoint();
		const direct = makeFakeEndpoint({ ...HELLO, serverCapabilities: [] });
		const routed = new DaemonRoutedClient(supervisor.client as never, direct.client as unknown as DaemonWorkerClient);

		await routed.request({ type: "abort", activeSessionId: "active-1" });
		expect(direct.requests.map((request) => request.type)).toEqual(["abort"]);

		// A worker "list" would mean something different; control-plane commands never go direct.
		await routed.request({ type: "list" });
		// The worker hello lacks session_input_admission, so prompt falls back to the supervisor.
		await routed.request({ type: "prompt", activeSessionId: "active-1", message: "hi" });
		expect(direct.requests.map((request) => request.type)).toEqual(["abort"]);
		expect(supervisor.requests.map((request) => request.type)).toEqual(["list", "prompt"]);
		routed.close();
	});
});

describe("createDaemonSessionTransport", () => {
	it("never asks an old supervisor for a ticket", async () => {
		const supervisor = makeFakeEndpoint({ ...HELLO, serverCapabilities: [] });

		const transport = await createDaemonSessionTransport(supervisor.client as never, "active-1", false);

		expect(transport).toBe(supervisor.client);
		expect(supervisor.requests).toEqual([]);
	});

	it("falls back to the supervisor when the worker socket identity does not match the ticket", async () => {
		const directory = mkdtempSync(join(tmpdir(), "prime-agent-routed-ticket-"));
		const socketPath = join(directory, "worker.sock");
		const server = createServer();
		await new Promise<void>((resolveListen) => server.listen(socketPath, resolveListen));
		try {
			const identity = getDaemonSocketIdentity(socketPath)!;
			const ticket: DaemonPeerTransportTicket = {
				purpose: "session_client",
				socketPath,
				socketIdentity: { dev: identity.dev, ino: identity.ino + 1 },
				workerInstanceId: "instance-1",
				activeSessionId: "active-1",
				grantId: "grant-1",
				token: "token-1",
				expiresAt: new Date(Date.now() + 10_000).toISOString(),
			};
			const supervisor = makeFakeEndpoint();
			supervisor.client.request = async (command: { type: string }): Promise<DaemonResponse> => ({
				type: "response",
				command: command.type,
				success: true,
				data: ticket,
			});

			const transport = await createDaemonSessionTransport(supervisor.client as never, "active-1", false);

			expect(transport).toBe(supervisor.client);
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

describe("DaemonWorkerClient direct decoding", () => {
	function makeDirectClient() {
		const destroyed = vi.fn();
		const client = new DaemonWorkerClient("/tmp/prime-agent-direct.sock");
		const internals = client as unknown as {
			socket: Socket;
			directPeer: boolean;
			handleFrame(frame: { header: Record<string, unknown>; payload: Buffer }): void;
		};
		internals.socket = { destroyed: false, destroy: destroyed } as unknown as Socket;
		internals.directPeer = true;
		return { client, internals, destroyed };
	}

	it("emits decoded outbound frames to message listeners", () => {
		const { client, internals } = makeDirectClient();
		const messages: DaemonOutbound[] = [];
		client.onMessage((message) => messages.push(message));

		internals.handleFrame({
			header: { kind: "outbound", outboundType: "session_detached", payloadEncoding: "jsonl" },
			payload: Buffer.from(JSON.stringify({ type: "session_detached", activeSessionId: "active-1" })),
		});

		expect(messages).toEqual([{ type: "session_detached", activeSessionId: "active-1" }]);
	});

	it("closes the direct link on a malformed frame instead of throwing into consumers", () => {
		const { client, internals, destroyed } = makeDirectClient();
		const messages: DaemonOutbound[] = [];
		const closes: Error[] = [];
		client.onMessage((message) => messages.push(message));
		client.onClose((error) => closes.push(error));

		internals.handleFrame({
			header: { kind: "outbound", outboundType: "session_event", payloadEncoding: "jsonl" },
			payload: Buffer.from("{not json"),
		});

		expect(messages).toEqual([]);
		expect(destroyed).toHaveBeenCalledOnce();
		expect(closes).toHaveLength(1);
		expect(closes[0]?.name).toBe("DaemonSocketClosedError");
	});
});
