import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { types } from "node:util";
import WebSocket, { WebSocketServer } from "ws";

const INPUT_KEYS = new Set(["closeTimeoutMs", "maxPayloadBytes"]);
const LISTEN_KEYS = new Set(["host", "onDrop", "onTcp"]);
const REJECT_KEYS = new Set(["statusCode"]);
const UPGRADE_KEYS = new Set(["head", "request"]);
const LOOPBACK_HOST = "127.0.0.1";
const MAX_TIMEOUT_MS = 120_000;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type UpgradeCallback = (request: unknown, head: unknown) => void;
type TcpCallback = (socket: unknown) => void;
type UpgradeEvent = Readonly<{ authRequest: object; head: Buffer; request: IncomingMessage }>;

export type CreateNodeSandboxRelayServerResult =
	| Readonly<{
			ok: true;
			server: Readonly<{
				listen: (raw: unknown) => Promise<unknown>;
				close: () => Promise<unknown>;
				closed: Promise<unknown>;
			}>;
	  }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" }>;

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (
			types.isProxy(raw) ||
			Object.getPrototypeOf(raw) !== Object.prototype ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(descriptors);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return descriptors;
	} catch {
		return null;
	}
}

function callable(raw: unknown): raw is CallableFunction {
	if (typeof raw !== "function") return false;
	try {
		return !types.isProxy(raw);
	} catch {
		return false;
	}
}

function eraseHead(head: Buffer): void {
	try {
		Buffer.prototype.fill.call(head, 0);
	} catch {
		/* Node retains ownership of an invalid head. */
	}
}

function scrubRequest(request: IncomingMessage): void {
	try {
		const rawHeaders = request.rawHeaders;
		if (Array.isArray(rawHeaders)) {
			for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
				if (typeof rawHeaders[index] === "string" && rawHeaders[index].toLowerCase() === "x-prime-grant")
					rawHeaders[index + 1] = "";
			}
		}
		const headers = request.headers;
		if (typeof headers === "object" && headers !== null) delete headers["x-prime-grant"];
	} catch {
		/* The socket is destroyed without inspecting the rejected request further. */
	}
}

function requestCredentialIsScrubbed(request: IncomingMessage): boolean {
	try {
		if (Object.hasOwn(request.headers, "x-prime-grant")) return false;
		const rawHeaders = request.rawHeaders;
		for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
			if (rawHeaders[index]?.toLowerCase() === "x-prime-grant") return false;
		}
		return true;
	} catch {
		return false;
	}
}

function safeRequest(request: IncomingMessage): object | null {
	try {
		const method = request.method;
		const url = request.url;
		const rawHeaders = request.rawHeaders;
		const headers = request.headers;
		if (
			typeof method !== "string" ||
			typeof url !== "string" ||
			!Array.isArray(rawHeaders) ||
			typeof headers !== "object" ||
			headers === null
		)
			return null;
		return { method, url, rawHeaders, headers };
	} catch {
		return null;
	}
}

function closedDeferred() {
	let resolve!: (value: Readonly<{ status: "closed" }>) => void;
	const promise = new Promise<Readonly<{ status: "closed" }>>((accepted) => {
		resolve = accepted;
	});
	let settled = false;
	return Object.freeze({
		promise,
		resolve: () => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "closed" as const }));
		},
		settled: () => settled,
	});
}

class NodeWsOwner {
	private readonly observation = closedDeferred();
	private closePromise: Promise<Readonly<{ status: "closing" | "closed" }>> | null = null;
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly ws: WebSocket,
		private readonly socket: Duplex,
		private readonly closeTimeoutMs: number,
	) {
		ws.once("close", () => {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			this.observation.resolve();
		});
		ws.on("error", () => {
			try {
				ws.terminate();
			} catch {
				/* Closure observation remains authoritative. */
			}
		});
	}

	capability(): object {
		return Object.freeze({
			handle: this.ws,
			closed: this.observation.promise,
			resume: () => {
				try {
					if (this.ws.readyState !== WebSocket.OPEN || this.socket.destroyed)
						return Object.freeze({ status: "error" });
					this.socket.resume();
					return Object.freeze({ status: "resumed" });
				} catch {
					return Object.freeze({ status: "error" });
				}
			},
			close: () => this.close(),
		});
	}

	private close(): Promise<Readonly<{ status: "closing" | "closed" }>> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = Promise.resolve().then(() => {
			if (this.observation.settled()) return Object.freeze({ status: "closed" as const });
			try {
				this.ws.close(1001);
			} catch {
				try {
					this.ws.terminate();
				} catch {
					/* Observed close decides certainty. */
				}
			}
			this.timer = setTimeout(() => {
				this.timer = null;
				if (!this.observation.settled()) {
					try {
						this.ws.terminate();
					} catch {
						/* Observed close decides certainty. */
					}
				}
			}, this.closeTimeoutMs);
			return Object.freeze({ status: "closing" as const });
		});
		return this.closePromise;
	}
}

class NodeSocketOwner {
	private readonly observation = closedDeferred();
	private state: "owned" | "consumed" | "closed" = "owned";
	private callback: UpgradeCallback | null = null;
	private event: UpgradeEvent | null = null;
	private subscriptionClosed = false;
	private closePromise: Promise<unknown> | null = null;

	constructor(
		private readonly socket: Duplex,
		private readonly wss: WebSocketServer,
		private readonly closeTimeoutMs: number,
		private readonly onTerminal: () => void,
	) {
		socket.once("close", () => {
			this.state = "closed";
			this.observation.resolve();
			this.onTerminal();
		});
		socket.on("error", () => {
			try {
				socket.destroy();
			} catch {
				/* Close event remains authoritative. */
			}
		});
	}

	capability(): object {
		return Object.freeze({
			closed: this.observation.promise,
			pause: () => {
				if (this.state !== "owned") return Object.freeze({ status: "error" });
				try {
					this.socket.pause();
					return Object.freeze({ status: "paused" });
				} catch {
					return Object.freeze({ status: "error" });
				}
			},
			subscribeUpgrade: (raw: unknown) => this.subscribe(raw),
			upgrade: (raw: unknown) => this.upgrade(raw),
			reject: (raw: unknown) => this.reject(raw),
			close: () => this.close(),
		});
	}

	deliver(request: IncomingMessage, head: Buffer): void {
		if (this.state !== "owned" || this.event || this.subscriptionClosed) {
			scrubRequest(request);
			eraseHead(head);
			try {
				this.socket.destroy();
			} catch {
				/* Close event remains authoritative. */
			}
			return;
		}
		const authRequest = safeRequest(request);
		if (!authRequest) {
			scrubRequest(request);
			eraseHead(head);
			try {
				this.socket.destroy();
			} catch {
				/* Close event remains authoritative. */
			}
			return;
		}
		this.event = Object.freeze({ authRequest, head, request });
		try {
			this.callback?.(authRequest, head);
		} catch {
			scrubRequest(request);
			eraseHead(head);
			try {
				this.socket.destroy();
			} catch {
				/* Close event remains authoritative. */
			}
		}
	}

	private subscribe(raw: unknown): unknown {
		if (!callable(raw) || this.state !== "owned" || this.subscriptionClosed || this.callback)
			return Object.freeze({ status: "error" });
		this.callback = (request: unknown, head: unknown) => Reflect.apply(raw, undefined, [request, head]);
		const event = this.event;
		if (event) this.callback(event.authRequest, event.head);
		let promise: Promise<Readonly<{ status: "closed" }>> | null = null;
		return Object.freeze({
			close: () => {
				if (promise) return promise;
				promise = Promise.resolve().then(() => {
					this.subscriptionClosed = true;
					this.callback = null;
					return Object.freeze({ status: "closed" as const });
				});
				return promise;
			},
		});
	}

	private reject(raw: unknown): Promise<unknown> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = Promise.resolve().then(() => {
			if (this.state !== "owned") return Object.freeze({ status: "error" });
			this.state = "consumed";
			this.callback = null;
			const values = exact(raw, REJECT_KEYS);
			const statusCode = values?.statusCode?.value;
			if (this.event) {
				scrubRequest(this.event.request);
				eraseHead(this.event.head);
			}
			if (typeof statusCode !== "number" || ![400, 403, 409, 429].includes(statusCode)) {
				try {
					this.socket.destroy();
				} catch {
					/* Close observation remains authoritative. */
				}
				return Object.freeze({ status: "error" });
			}
			try {
				this.socket.end(`HTTP/1.1 ${statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
				this.socket.destroy();
				return Object.freeze({ status: "rejected" });
			} catch {
				return Object.freeze({ status: "error" });
			}
		});
		return this.closePromise;
	}

	private close(): Promise<unknown> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = Promise.resolve().then(() => {
			if (this.state === "closed") return Object.freeze({ status: "closed" });
			if (this.state !== "owned") return Object.freeze({ status: "error" });
			this.state = "consumed";
			this.callback = null;
			if (this.event) {
				scrubRequest(this.event.request);
				eraseHead(this.event.head);
			}
			try {
				this.socket.destroy();
				return Object.freeze({ status: "closing" });
			} catch {
				return Object.freeze({ status: "error" });
			}
		});
		return this.closePromise;
	}

	private upgrade(raw: unknown): Promise<unknown> {
		const values = exact(raw, UPGRADE_KEYS);
		const head = values?.head?.value;
		const authRequest = values?.request?.value;
		const event = this.event;
		if (this.state !== "owned") return Promise.reject(new Error("upgrade rejected"));
		this.state = "consumed";
		this.callback = null;
		if (
			!event ||
			head !== event.head ||
			authRequest !== event.authRequest ||
			!requestCredentialIsScrubbed(event.request)
		) {
			if (event) {
				scrubRequest(event.request);
				eraseHead(event.head);
			}
			try {
				this.socket.destroy();
			} catch {
				/* Close observation remains authoritative. */
			}
			return Promise.reject(new Error("upgrade rejected"));
		}
		return new Promise((resolve, reject) => {
			let settled = false;
			let timer: NodeJS.Timeout | null = null;
			const finishError = () => {
				if (settled) return;
				settled = true;
				if (timer) {
					clearTimeout(timer);
					timer = null;
				}
				this.wss.off("wsClientError", onClientError);
				this.socket.off("close", finishError);
				try {
					this.socket.destroy();
				} catch {
					/* Close observation remains authoritative. */
				}
				reject(new Error("upgrade failed"));
			};
			const onClientError = (_error: Error, candidate: Duplex) => {
				if (candidate === this.socket) finishError();
			};
			timer = setTimeout(finishError, this.closeTimeoutMs);
			this.wss.on("wsClientError", onClientError);
			this.socket.once("close", finishError);
			try {
				this.socket.pause();
				this.wss.handleUpgrade(event.request, this.socket, event.head, (ws) => {
					if (settled) {
						try {
							ws.terminate();
						} catch {
							/* Late WS is still consumed. */
						}
						return;
					}
					settled = true;
					if (timer) {
						clearTimeout(timer);
						timer = null;
					}
					this.wss.off("wsClientError", onClientError);
					this.socket.off("close", finishError);
					const owner = new NodeWsOwner(ws, this.socket, this.closeTimeoutMs);
					resolve(Object.freeze({ status: "upgraded", webSocket: owner.capability() }));
				});
			} catch {
				finishError();
			}
		});
	}
}

class NodeRelayServer {
	private readonly server: HttpServer;
	private readonly wss: WebSocketServer;
	private readonly observation = closedDeferred();
	private readonly sockets = new Map<Duplex, NodeSocketOwner>();
	private acceptedOnce = false;
	private onDrop: (() => void) | null = null;
	private onTcp: TcpCallback | null = null;
	private state: "created" | "starting" | "listening" | "closing" | "closed" = "created";
	private closePromise: Promise<Readonly<{ status: "closing" | "closed" }>> | null = null;

	constructor(
		private readonly closeTimeoutMs: number,
		maxPayloadBytes: number,
	) {
		this.server = createServer((request: IncomingMessage, response: ServerResponse) => {
			scrubRequest(request);
			response.statusCode = 404;
			response.setHeader("Connection", "close");
			response.end();
		});
		this.server.maxConnections = 1;
		this.wss = new WebSocketServer({
			noServer: true,
			clientTracking: false,
			perMessageDeflate: false,
			maxPayload: maxPayloadBytes,
		});
		this.server.on("connection", (socket) => this.accept(socket));
		this.server.on("drop", () => {
			try {
				this.onDrop?.();
			} catch {
				this.close();
			}
		});
		this.server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
		this.server.on("close", () => {
			this.state = "closed";
			this.observation.resolve();
		});
		this.server.on("error", () => {
			if (this.state !== "closing" && this.state !== "closed") this.close();
		});
	}

	capability(): object {
		return Object.freeze({
			closed: this.observation.promise,
			listen: (raw: unknown) => this.listen(raw),
			close: () => this.close(),
		});
	}

	private listen(raw: unknown): Promise<unknown> {
		const values = exact(raw, LISTEN_KEYS);
		const host = values?.host?.value;
		const drop = values?.onDrop?.value;
		const callback = values?.onTcp?.value;
		if (this.state !== "created" || host !== LOOPBACK_HOST || !callable(drop) || !callable(callback))
			return Promise.resolve(Object.freeze({ status: "error", host: LOOPBACK_HOST, port: 0 }));
		this.state = "starting";
		this.onDrop = () => Reflect.apply(drop, undefined, []);
		this.onTcp = (socket: unknown) => Reflect.apply(callback, undefined, [socket]);
		return new Promise((resolve) => {
			let settled = false;
			const startupError = () => {
				if (settled) return;
				settled = true;
				this.server.off("listening", listening);
				resolve(Object.freeze({ status: "error", host: LOOPBACK_HOST, port: 0 }));
			};
			const listening = () => {
				if (settled) return;
				const address = this.server.address();
				settled = true;
				this.server.off("error", startupError);
				if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST || address.port < 1) {
					this.close();
					resolve(Object.freeze({ status: "error", host: LOOPBACK_HOST, port: 0 }));
					return;
				}
				this.state = "listening";
				resolve(Object.freeze({ status: "listening", host: LOOPBACK_HOST, port: address.port }));
			};
			this.server.once("error", startupError);
			this.server.once("listening", listening);
			try {
				this.server.listen({ host: LOOPBACK_HOST, port: 0 });
			} catch {
				startupError();
			}
		});
	}

	private accept(socket: Duplex): void {
		if (this.acceptedOnce) {
			try {
				socket.destroy();
			} catch {
				/* Node still owns the rejected duplicate. */
			}
			try {
				this.onDrop?.();
			} catch {
				this.close();
			}
			return;
		}
		this.acceptedOnce = true;
		const owner = new NodeSocketOwner(socket, this.wss, this.closeTimeoutMs, () => this.sockets.delete(socket));
		const capability = owner.capability() as { close: () => Promise<unknown> };
		this.sockets.set(socket, owner);
		const callback = this.onTcp;
		if (!callback || this.state !== "listening") {
			capability.close();
			return;
		}
		try {
			callback(capability);
		} catch {
			capability.close();
		}
	}

	private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		const owner = this.sockets.get(socket);
		if (!owner) {
			scrubRequest(request);
			eraseHead(head);
			try {
				socket.destroy();
			} catch {
				/* No owner was available. */
			}
			return;
		}
		owner.deliver(request, head);
	}

	private close(): Promise<Readonly<{ status: "closing" | "closed" }>> {
		if (this.closePromise) return this.closePromise;
		this.closePromise = Promise.resolve().then(() => {
			if (this.observation.settled()) return Object.freeze({ status: "closed" as const });
			this.state = "closing";
			this.onDrop = null;
			this.onTcp = null;
			try {
				this.server.close(() => this.observation.resolve());
			} catch {
				if (!this.server.listening) this.observation.resolve();
			}
			try {
				this.wss.close();
			} catch {
				/* It owns no listener in noServer mode. */
			}
			if (!this.server.listening && this.sockets.size === 0) this.observation.resolve();
			return Object.freeze({ status: "closing" as const });
		});
		return this.closePromise;
	}
}

export function createNodeSandboxRelayServer(raw: unknown): CreateNodeSandboxRelayServerResult {
	const values = exact(raw, INPUT_KEYS);
	const closeTimeoutMs = values?.closeTimeoutMs?.value;
	const maxPayloadBytes = values?.maxPayloadBytes?.value;
	if (
		typeof closeTimeoutMs !== "number" ||
		!Number.isSafeInteger(closeTimeoutMs) ||
		closeTimeoutMs < 1 ||
		closeTimeoutMs > MAX_TIMEOUT_MS ||
		typeof maxPayloadBytes !== "number" ||
		!Number.isSafeInteger(maxPayloadBytes) ||
		maxPayloadBytes < 1 ||
		maxPayloadBytes > MAX_PAYLOAD_BYTES
	)
		return Object.freeze({ ok: false as const, code: "INPUT_INVALID" as const });
	try {
		const implementation = new NodeRelayServer(closeTimeoutMs, maxPayloadBytes);
		return Object.freeze({
			ok: true as const,
			server: implementation.capability() as Readonly<{
				listen: (raw: unknown) => Promise<unknown>;
				close: () => Promise<unknown>;
				closed: Promise<unknown>;
			}>,
		});
	} catch {
		return Object.freeze({ ok: false as const, code: "INPUT_INVALID" as const });
	}
}
