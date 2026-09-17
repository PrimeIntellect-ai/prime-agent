import http from "node:http";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudTunnelAttachment } from "../src/core/cloud/bridge/tunnel-attachment.js";
import { CloudTunnelTransportError, WsTunnelTransport } from "../src/core/cloud/bridge/tunnel-transport.js";
import {
	encodeWsClose,
	encodeWsText,
	newSecWebSocketKey,
	WS_OPCODE,
	type WsFrame,
	WsFrameDecoder,
	webSocketAccept,
} from "../src/core/cloud/bridge/ws-frames.js";
import { type CloudMessage, cloudRequestDigest } from "../src/core/cloud/protocol.js";

/**
 * Local-transport regressions against a minimal loopback WebSocket server.
 *
 * The real transport must satisfy the same `CloudTunnelConnection` contract the
 * in-memory fakes implement elsewhere: a locally initiated close still
 * notifies the close handler exactly once, so supervisors can reconnect after
 * a protocol violation and shut down without deadlocking on their own loop.
 */

const servers: http.Server[] = [];

interface MiniBridge {
	port: number;
	close(): Promise<void>;
}

async function startMiniBridge(onClient: (client: MiniClient) => void): Promise<MiniBridge> {
	const clients = new Set<MiniClient>();
	const server = http.createServer((_request, response) => {
		response.writeHead(404);
		response.end();
	});
	servers.push(server);
	server.on("upgrade", (request, socket) => {
		const key = request.headers["sec-websocket-key"];
		if (typeof key !== "string" || key === "") {
			socket.destroy();
			return;
		}
		socket.write(
			`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${webSocketAccept(key)}\r\n\r\n`,
		);
		(socket as unknown as Socket).setNoDelay(true);
		const client = new MiniClient(socket as unknown as Socket);
		clients.add(client);
		socket.on("close", () => clients.delete(client));
		onClient(client);
	});
	const port = await new Promise<number>((resolve) =>
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		}),
	);
	return {
		port,
		close: async () => {
			for (const client of clients) client.destroy();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

class MiniClient {
	private readonly decoder = new WsFrameDecoder({ expectMasked: true, maxPayloadBytes: 1_048_576 });
	private handler: ((message: string) => void) | undefined;

	constructor(private readonly socket: Socket) {
		socket.on("data", (chunk: Buffer) => {
			let frames: WsFrame[];
			try {
				frames = this.decoder.push(chunk);
			} catch {
				this.destroy();
				return;
			}
			for (const frame of frames) {
				if (frame.opcode === WS_OPCODE.close) {
					try {
						this.socket.write(encodeWsClose(1000, "", false));
					} catch {
						// Already closing.
					}
					this.destroy();
					return;
				}
				if (frame.opcode === WS_OPCODE.text && frame.fin) {
					this.handler?.(frame.payload.toString("utf8"));
				}
			}
		});
	}

	onMessage(handler: (message: string) => void): void {
		this.handler = handler;
	}

	send(message: CloudMessage): void {
		this.socket.write(encodeWsText(JSON.stringify(message), false));
	}

	sendCloseFrame(): void {
		this.socket.write(encodeWsClose(1000, "server closing", false));
		this.destroy();
	}

	destroy(): void {
		this.socket.destroy();
	}
}

const transport = new WsTunnelTransport({ connectTimeoutMs: 2_000 });

describe("WsTunnelTransport close semantics", () => {
	afterEach(async () => {
		for (const server of servers.splice(0)) {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});

	it("notifies the close handler exactly once when the client initiates the close", async () => {
		const bridge = await startMiniBridge(() => {});
		const connection = await transport.connect(`http://127.0.0.1:${String(bridge.port)}`, {
			Authorization: "Basic dXNlcjpwYXNz",
			"Sec-WebSocket-Key": newSecWebSocketKey(),
		});
		const onClose = vi.fn();
		connection.onClose(onClose);
		connection.close("test done");
		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(onClose.mock.calls[0]).toHaveLength(1);
		expect(onClose.mock.calls[0]?.[0]).toBeUndefined();
		await bridge.close();
	});

	it("notifies the close handler once when the peer initiates the close", async () => {
		let mini: MiniClient | undefined;
		const bridge = await startMiniBridge((client) => {
			mini = client;
		});
		const connection = await transport.connect(`http://127.0.0.1:${String(bridge.port)}`, {});
		const onClose = vi.fn();
		connection.onClose(onClose);
		mini?.sendCloseFrame();
		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(onClose.mock.calls[0]?.[0]).toBeUndefined();
		await bridge.close();
	});

	it("stops an attachment over the real transport without hanging on its own loop", async () => {
		let mini: MiniClient | undefined;
		const bridge = await startMiniBridge((client) => {
			mini = client;
			client.onMessage((message) => {
				const parsed = JSON.parse(message) as CloudMessage;
				if (parsed.type === "hello") {
					client.send({
						type: "snapshot",
						sessionId: parsed.sessionId,
						generation: parsed.generation,
						cursor: { generation: parsed.generation, sequence: 0 },
						status: "busy",
						state: { cwd: "/w", modelId: "image-default", queuedCommandIds: [] },
						events: [],
					});
				}
				if (parsed.type === "submit") {
					client.send({
						type: "command",
						sessionId: parsed.sessionId,
						generation: parsed.generation,
						receipt: {
							commandId: parsed.commandId,
							digest: cloudRequestDigest(parsed.request),
							state: "accepted",
							submittedAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
							uncertain: false,
						},
					});
				}
			});
		});
		const attachment = new CloudTunnelAttachment({
			sessionId: "sess_transport_1",
			generation: 1,
			transport,
			callbacks: {
				resolveTarget: () => ({
					url: `http://127.0.0.1:${String(bridge.port)}`,
					httpUser: "user",
					httpPassword: "pass",
					bridgeToken: "bridge-token-0123456789",
				}),
				appendGuestEvent: () => {},
				flushTrace: async () => {},
				persistGuestCursor: () => {},
				loadGuestCursor: () => undefined,
				recordAttachment: () => {},
				isSessionLive: () => true,
				checkTunnelAlive: async () => true,
				onAttachmentError: () => {},
				onTerminal: () => {},
			},
			reconnectDelayMs: 5,
			maxReconnectDelayMs: 20,
			sleepFn: async () => {},
		});
		attachment.start();
		await vi.waitFor(() => expect(attachment.attached).toBe(true));
		expect(mini).toBeDefined();
		// stop() must settle on its own: it awaits the supervisor loop, which
		// can only end when the close handshake notifies the close handler.
		await vi.waitFor(async () => {
			await expect(attachment.stop()).resolves.toBeUndefined();
		});
		expect(attachment.attached).toBe(false);
		await bridge.close();
	});

	it("rejects an upgrade without a websocket accept handshake", async () => {
		const server = http.createServer((_request, response) => {
			response.writeHead(200);
			response.end("plain");
		});
		servers.push(server);
		const port = await new Promise<number>((resolve) =>
			server.listen(0, "127.0.0.1", () => {
				const address = server.address();
				resolve(typeof address === "object" && address !== null ? address.port : 0);
			}),
		);
		await expect(transport.connect(`http://127.0.0.1:${String(port)}`, {})).rejects.toThrow(
			CloudTunnelTransportError,
		);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
});
