import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
	encodeWsClose,
	encodeWsFrame,
	encodeWsText,
	newSecWebSocketKey,
	WS_OPCODE,
	type WsFrame,
	WsFrameDecoder,
	webSocketAccept,
} from "./ws-frames.js";

/**
 * Transport-agnostic attachment channel plus the real WebSocket client.
 *
 * The attachment supervisor (`tunnel-attachment.ts`) speaks only to the
 * `CloudTunnelTransport` interface, so tests drive it with an in-memory fake
 * and production uses `WsTunnelTransport`: a hand-rolled RFC 6455 client over
 * `node:https` (or `node:http` for loopback tests) with edge basic auth in the
 * handshake headers. A custom client is required because the WHATWG WebSocket
 * API cannot send an `Authorization` header, and the edge enforces basic auth
 * at upgrade time.
 */

export type CloudTunnelTransportErrorCode =
	| "connect"
	| "rejected"
	| "unauthorized"
	| "protocol"
	| "too_big"
	| "closed"
	| "timeout";

export class CloudTunnelTransportError extends Error {
	readonly code: CloudTunnelTransportErrorCode;
	/** HTTP status for `code === "rejected" | "unauthorized"`. */
	readonly status?: number;

	constructor(
		code: CloudTunnelTransportErrorCode,
		message: string,
		properties: { status?: number; cause?: unknown } = {},
	) {
		super(message, properties.cause === undefined ? undefined : { cause: properties.cause });
		this.name = "CloudTunnelTransportError";
		this.code = code;
		this.status = properties.status;
	}
}

export interface CloudTunnelConnection {
	/** Queue one text message; oversized messages fail the connection. */
	send(message: string): void;
	/** Begin the close handshake; the close handler fires exactly once. */
	close(reason?: string): void;
	onMessage(handler: (message: string) => void): void;
	onClose(handler: (error?: CloudTunnelTransportError) => void): void;
}

export interface CloudTunnelTransport {
	/**
	 * Open one WebSocket connection. Resolves after the 101 upgrade; rejects
	 * with `rejected`/`unauthorized`/`connect`/`timeout` otherwise.
	 */
	connect(url: string, headers: Record<string, string>): Promise<CloudTunnelConnection>;
}

const MAX_MESSAGE_BYTES = 1_048_576;
const CONNECT_TIMEOUT_MS = 15_000;
const CLOSE_LINGER_MS = 500;

class WsTunnelConnection implements CloudTunnelConnection {
	private readonly decoder = new WsFrameDecoder({ expectMasked: false, maxPayloadBytes: MAX_MESSAGE_BYTES });
	private socket: Socket | undefined;
	private messageHandler: ((message: string) => void) | undefined;
	private closeHandler: ((error?: CloudTunnelTransportError) => void) | undefined;
	private fragments: Buffer[] | undefined;
	private closed = false;

	constructor(socket: Socket) {
		this.socket = socket;
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", (error: Error) =>
			this.onTransportError(new CloudTunnelTransportError("closed", `socket error: ${error.message}`)),
		);
		socket.on("close", () => this.onClosed());
		socket.setNoDelay(true);
	}

	send(message: string): void {
		const bytes = Buffer.byteLength(message, "utf8");
		if (this.closed || this.socket === undefined) return;
		if (bytes > MAX_MESSAGE_BYTES) {
			this.onTransportError(new CloudTunnelTransportError("too_big", "outbound message exceeds the frame limit"));
			return;
		}
		this.socket.write(encodeWsText(message, true));
	}

	close(reason = "client closing"): void {
		if (this.closed) return;
		this.closed = true;
		if (this.socket !== undefined) {
			try {
				this.socket.write(encodeWsClose(1000, reason, true));
			} catch {
				// The socket may already be gone; the close event still fires.
			}
			const socket = this.socket;
			setTimeout(() => socket.destroy(), CLOSE_LINGER_MS).unref();
		}
	}

	onMessage(handler: (message: string) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: (error?: CloudTunnelTransportError) => void): void {
		this.closeHandler = handler;
	}

	private onData(chunk: Buffer): void {
		let frames: WsFrame[];
		try {
			frames = this.decoder.push(chunk);
		} catch (error) {
			this.onTransportError(
				new CloudTunnelTransportError("protocol", error instanceof Error ? error.message : String(error), {
					cause: error,
				}),
			);
			return;
		}
		for (const frame of frames) {
			if (frame.opcode === WS_OPCODE.close) {
				if (this.socket !== undefined) {
					try {
						this.socket.write(encodeWsClose(1000, "", true));
					} catch {
						// Already closing.
					}
				}
				this.onClosed();
				return;
			}
			if (frame.opcode === WS_OPCODE.ping) {
				this.socket?.write(encodeWsFrame(WS_OPCODE.pong, frame.payload, true));
				continue;
			}
			if (frame.opcode === WS_OPCODE.pong) continue;
			if (frame.opcode === WS_OPCODE.text) {
				if (frame.fin) {
					this.emitMessage(frame.payload);
					this.fragments = undefined;
				} else {
					this.fragments = [frame.payload];
				}
				continue;
			}
			if (frame.opcode === WS_OPCODE.continuation) {
				if (this.fragments === undefined) {
					this.onTransportError(new CloudTunnelTransportError("protocol", "unexpected continuation frame"));
					return;
				}
				this.fragments.push(frame.payload);
				if (frame.fin) {
					this.emitMessage(Buffer.concat(this.fragments));
					this.fragments = undefined;
				}
				continue;
			}
			if (frame.opcode === WS_OPCODE.binary) {
				this.onTransportError(
					new CloudTunnelTransportError("protocol", "binary frames are not part of the protocol"),
				);
				return;
			}
			this.onTransportError(new CloudTunnelTransportError("protocol", "unsupported opcode"));
			return;
		}
	}

	private emitMessage(payload: Buffer): void {
		const text = payload.toString("utf8");
		if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
			this.onTransportError(new CloudTunnelTransportError("too_big", "inbound message exceeds the limit"));
			return;
		}
		this.messageHandler?.(text);
	}

	private onTransportError(error: CloudTunnelTransportError): void {
		// Gate on the handler, not on `closed`: a locally initiated close must
		// still deliver exactly one close notification when the socket dies.
		this.closed = true;
		const handler = this.closeHandler;
		if (handler === undefined) return;
		this.closeHandler = undefined;
		this.socket?.destroy();
		handler(error);
	}

	private onClosed(): void {
		// Fires exactly once for every terminal outcome, including the close
		// handshake this side initiated; callers await it to finish shutdown.
		this.closed = true;
		const handler = this.closeHandler;
		if (handler === undefined) return;
		this.closeHandler = undefined;
		handler(
			this.decoder.endedIncomplete()
				? new CloudTunnelTransportError("closed", "connection closed mid-frame")
				: undefined,
		);
	}
}

/** Real WebSocket transport over http(s) with edge basic auth headers. */
export class WsTunnelTransport implements CloudTunnelTransport {
	private readonly connectTimeoutMs: number;

	constructor(options: { connectTimeoutMs?: number } = {}) {
		this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
	}

	connect(url: string, headers: Record<string, string>): Promise<CloudTunnelConnection> {
		return new Promise((resolve, reject) => {
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				reject(new CloudTunnelTransportError("connect", `invalid tunnel url: ${url}`));
				return;
			}
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
				reject(new CloudTunnelTransportError("connect", "tunnel url must be http(s)"));
				return;
			}
			const key = newSecWebSocketKey();
			const requestHeaders: Record<string, string> = {
				...headers,
				Connection: "Upgrade",
				Upgrade: "websocket",
				"Sec-WebSocket-Key": key,
				"Sec-WebSocket-Version": "13",
			};
			const request = (parsed.protocol === "https:" ? https : http).request({
				protocol: parsed.protocol,
				hostname: parsed.hostname,
				port: parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port),
				path: `${parsed.pathname}${parsed.search}`,
				headers: requestHeaders,
				method: "GET",
			});
			const timer = setTimeout(() => {
				request.destroy();
				reject(
					new CloudTunnelTransportError(
						"timeout",
						`tunnel connect timed out after ${String(this.connectTimeoutMs)}ms`,
					),
				);
			}, this.connectTimeoutMs);
			request.once("upgrade", (response: http.IncomingMessage, socket: Duplex) => {
				clearTimeout(timer);
				const accept = response.headers["sec-websocket-accept"];
				if (typeof accept !== "string" || accept !== webSocketAccept(key)) {
					socket.destroy();
					reject(new CloudTunnelTransportError("protocol", "tunnel edge sent an invalid websocket accept"));
					return;
				}
				resolve(new WsTunnelConnection(socket as Socket));
			});
			request.once("response", (response: http.IncomingMessage) => {
				clearTimeout(timer);
				const status = response.statusCode ?? 0;
				const code = status === 401 || status === 403 ? "unauthorized" : "rejected";
				response.resume();
				request.destroy();
				reject(
					new CloudTunnelTransportError(
						code,
						`tunnel edge rejected the websocket upgrade with HTTP ${String(status)}`,
						{ status },
					),
				);
			});
			request.once("error", (error: Error) => {
				clearTimeout(timer);
				reject(
					new CloudTunnelTransportError("connect", `tunnel connect failed: ${error.message}`, { cause: error }),
				);
			});
			request.end();
		});
	}
}
