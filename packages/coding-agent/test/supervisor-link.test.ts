import { describe, expect, it } from "vitest";
import type { DaemonCommandBody } from "../src/modes/daemon/daemon-client.js";
import { DaemonSocketClosedError } from "../src/modes/daemon/daemon-client.js";
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

	it("does not retry a failed request; a healthy socket survives, a dead one reconnects", async () => {
		const clients: MockClient[] = [];
		const link = new SupervisorLink({
			socketPath: "/tmp/unused.sock",
			factory: () => {
				const client = makeMockClient(clients.length === 0);
				clients.push(client);
				return client;
			},
		});
		// Command-level failure: the shared socket stays up for the next request.
		await expect(link.request({ type: "send_message" } as DaemonCommandBody)).rejects.toThrow(
			"socket died mid-request",
		);
		const response = await link.request({ type: "send_message" } as DaemonCommandBody);
		expect(response.success).toBe(true);
		expect(clients).toHaveLength(1);

		// Socket-level failure: the link tears down, the next request reconnects.
		const closed = new DaemonSocketClosedError("/tmp/unused.sock", "shutdown");
		clients[0].request = async () => {
			throw closed;
		};
		await expect(link.request({ type: "send_message" } as DaemonCommandBody)).rejects.toThrow();
		const response2 = await link.request({ type: "send_message" } as DaemonCommandBody);
		expect(response2.success).toBe(true);
		expect(clients).toHaveLength(2);
		expect(clients[0].closeCount).toBe(1);
		link.close();
	});

	it("closes the client when the handshake fails", async () => {
		const clients: MockClient[] = [];
		const link = new SupervisorLink({
			socketPath: "/tmp/unused.sock",
			factory: () => {
				const client = makeMockClient();
				// First candidate fails the hello; the next connects cleanly.
				if (clients.length === 0) {
					client.waitForHello = async () => {
						throw new Error("hello timeout");
					};
				}
				clients.push(client);
				return client;
			},
		});
		await expect(link.request({ type: "send_message" } as DaemonCommandBody)).rejects.toThrow("hello timeout");
		expect(clients[0].closeCount).toBe(1);
		const response = await link.request({ type: "send_message" } as DaemonCommandBody);
		expect(response.success).toBe(true);
		expect(clients).toHaveLength(2);
		link.close();
	});

	it("closes a client still mid-handshake when close() runs", async () => {
		const clients: MockClient[] = [];
		const link = new SupervisorLink({
			socketPath: "/tmp/unused.sock",
			factory: () => {
				const client = makeMockClient();
				let rejectHello: ((error: Error) => void) | undefined;
				client.waitForHello = () =>
					new Promise((_, reject) => {
						rejectHello = reject;
					});
				const closeClient = client.close.bind(client);
				client.close = () => {
					// Socket death surfaces the pending handshake as a failure.
					closeClient();
					rejectHello?.(new Error("socket closed during handshake"));
				};
				clients.push(client);
				return client;
			},
		});
		const pending = link.ensureConnected();
		await new Promise((resolveTick) => setTimeout(resolveTick, 0));
		link.close();
		expect(clients[0].closeCount).toBe(1);
		await expect(pending).rejects.toThrow();
	});

	it("stops reconnecting after close()", async () => {
		const clients: MockClient[] = [];
		const link = makeLink(clients);
		link.close();
		await expect(link.request({ type: "list_agent_peers" } as DaemonCommandBody)).rejects.toThrow();
		expect(clients).toHaveLength(0);
	});
});
