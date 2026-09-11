import { describe, expect, it } from "vitest";
import type { DaemonCommandBody } from "../src/modes/daemon/daemon-client.js";
import type { DaemonResponse } from "../src/modes/daemon/daemon-protocol.js";
import { type DaemonClientLike, SupervisorLink } from "../src/modes/daemon/supervisor-link.js";

interface MockClient extends DaemonClientLike {
	requests: DaemonCommandBody[];
	closeCount: number;
	simulateClose: (() => void) | undefined;
}

function makeMockClient(failFirstRequest = false): MockClient {
	const client = {
		requests: [] as DaemonCommandBody[],
		closeCount: 0,
		simulateClose: undefined as (() => void) | undefined,
		connect: async () => {},
		waitForHello: async () => ({}),
		onClose(listener: () => void) {
			client.simulateClose = listener;
			return () => {
				client.simulateClose = undefined;
			};
		},
		close() {
			client.closeCount += 1;
		},
		async request(command: DaemonCommandBody): Promise<DaemonResponse> {
			client.requests.push(command);
			if (failFirstRequest && client.requests.length === 1) {
				throw new Error("socket died mid-request");
			}
			return { id: "r", type: "response", command: command.type, success: true, data: { ok: true } };
		},
	};
	return client as MockClient;
}

function makeLink(clients: MockClient[]) {
	return new SupervisorLink({
		socketPath: "/tmp/unused.sock",
		factory: () => {
			const client = makeMockClient();
			clients.push(client);
			return client;
		},
	});
}

describe("SupervisorLink", () => {
	it("reuses one connection across requests", async () => {
		const clients: MockClient[] = [];
		const link = makeLink(clients);
		await link.request({ type: "list_agent_peers" } as DaemonCommandBody);
		await link.request({ type: "agent_messages_status" } as DaemonCommandBody);
		expect(clients).toHaveLength(1);
		expect(clients[0].requests).toHaveLength(2);
		link.close();
		expect(clients[0].closeCount).toBe(1);
	});

	it("single-flights concurrent connects", async () => {
		const clients: MockClient[] = [];
		const link = makeLink(clients);
		await Promise.all([
			link.request({ type: "list_agent_peers" } as DaemonCommandBody),
			link.request({ type: "list_agent_peers" } as DaemonCommandBody),
		]);
		expect(clients).toHaveLength(1);
		link.close();
	});

	it("reconnects after the socket closes", async () => {
		const clients: MockClient[] = [];
		const link = makeLink(clients);
		await link.request({ type: "list_agent_peers" } as DaemonCommandBody);
		clients[0].simulateClose?.();
		await link.request({ type: "list_agent_peers" } as DaemonCommandBody);
		expect(clients).toHaveLength(2);
		link.close();
	});

	it("does not retry a failed request; the next request reconnects", async () => {
		const clients: MockClient[] = [];
		const link = new SupervisorLink({
			socketPath: "/tmp/unused.sock",
			factory: () => {
				const client = makeMockClient(clients.length === 0);
				clients.push(client);
				return client;
			},
		});
		await expect(link.request({ type: "send_message" } as DaemonCommandBody)).rejects.toThrow(
			"socket died mid-request",
		);
		const response = await link.request({ type: "send_message" } as DaemonCommandBody);
		expect(response.success).toBe(true);
		expect(clients).toHaveLength(2);
		link.close();
	});

	it("stops reconnecting after close()", async () => {
		const clients: MockClient[] = [];
		const link = makeLink(clients);
		link.close();
		await expect(link.request({ type: "list_agent_peers" } as DaemonCommandBody)).rejects.toThrow();
		expect(clients).toHaveLength(0);
	});
});
