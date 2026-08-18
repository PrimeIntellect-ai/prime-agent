import { createConnection, type Socket } from "node:net";
import { serializeJsonLine } from "../rpc/jsonl.js";
import { type PrivateFrame, PrivateFramedChannel } from "../session-worker/private-framing.js";
import type { DaemonCommand, DaemonOutbound, DaemonResponse } from "./daemon-protocol.js";
import {
	type DaemonWorkerCommand,
	type DaemonWorkerCommandBody,
	type DaemonWorkerFrameHeader,
	isDaemonWorkerFrameHeader,
} from "./daemon-worker-protocol.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;
type DaemonWorkerWireCommandBody = DaemonCommandBody | DaemonWorkerCommandBody;
type DaemonWorkerWireCommand = DaemonCommand | DaemonWorkerCommand;
type DaemonWorkerAuthentication = Omit<Extract<DaemonWorkerCommand, { type: "worker_auth" }>, "id" | "type" | "token">;

export type DaemonWorkerFrameListener = (frame: PrivateFrame<DaemonWorkerFrameHeader>) => void;
export type DaemonWorkerCloseListener = (error: Error) => void;
type DaemonHello = Extract<DaemonOutbound, { type: "daemon_hello" }>;

export class DaemonWorkerClient {
	private socket?: Socket;
	private channel?: PrivateFramedChannel<DaemonWorkerFrameHeader>;
	private readonly frameListeners = new Set<DaemonWorkerFrameListener>();
	private readonly closeListeners = new Set<DaemonWorkerCloseListener>();
	private readonly pending = new Map<
		string,
		{
			resolve: (response: DaemonResponse) => void;
			reject: (error: Error) => void;
			timeout: ReturnType<typeof setTimeout>;
		}
	>();
	private requestId = 0;
	private hello?: DaemonHello;
	private readonly helloWaiters = new Set<{
		resolve: (hello: DaemonHello) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly socketPath: string) {}

	async connect(timeoutMs = 3000): Promise<void> {
		if (this.socket) {
			throw new Error("Daemon worker client is already connected");
		}
		const socket = createConnection(this.socketPath);
		this.socket = socket;
		this.channel = new PrivateFramedChannel(socket, isDaemonWorkerFrameHeader);
		this.channel.onFrame((frame) => this.handleFrame(frame));

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				socket.destroy();
				reject(new Error(`Timed out connecting to daemon worker socket: ${this.socketPath}`));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timeout);
				socket.off("connect", onConnect);
				socket.off("error", onError);
			};
			const onConnect = () => {
				cleanup();
				resolve();
			};
			const onError = (error: Error) => {
				cleanup();
				reject(error);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});

		socket.on("error", (error) => this.notifyClosed(socket, error));
		socket.on("close", () => this.notifyClosed(socket, new Error("Daemon worker socket closed")));
	}

	waitForHello(timeoutMs = 3000): Promise<DaemonHello> {
		if (this.hello) {
			return Promise.resolve(this.hello);
		}
		if (!this.socket || this.socket.destroyed) {
			return Promise.reject(new Error("Daemon worker client is not connected"));
		}
		return new Promise((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.helloWaiters.delete(waiter);
					reject(new Error("Timed out waiting for daemon worker hello"));
				}, timeoutMs),
			};
			this.helloWaiters.add(waiter);
		});
	}

	onFrame(listener: DaemonWorkerFrameListener): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onClose(listener: DaemonWorkerCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	request(command: DaemonCommandBody, timeoutMs = 30_000): Promise<DaemonResponse> {
		return this.requestWire(command, timeoutMs);
	}

	requestWorker(command: DaemonWorkerCommandBody, timeoutMs = 30_000): Promise<DaemonResponse> {
		return this.requestWire(command, timeoutMs);
	}

	async authenticateWorker(token: string, owner: DaemonWorkerAuthentication, timeoutMs = 3000): Promise<void> {
		const response = await this.requestWorker({ type: "worker_auth", token, ...owner }, timeoutMs);
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	close(): void {
		this.rejectAll(new Error("Daemon worker client closed"));
		this.channel?.close();
		this.channel = undefined;
		this.socket?.destroy();
		this.socket = undefined;
	}

	private async requestWire(command: DaemonWorkerWireCommandBody, timeoutMs: number): Promise<DaemonResponse> {
		if (!this.channel || !this.socket || this.socket.destroyed) {
			throw new Error("Daemon worker client is not connected");
		}
		const id = `worker_${++this.requestId}`;
		const fullCommand = { ...command, id } as DaemonWorkerWireCommand;
		const response = new Promise<DaemonResponse>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Timed out waiting for daemon worker response to ${command.type}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timeout });
		});
		try {
			await this.channel.send(
				{ kind: "command", requestId: id, commandType: command.type },
				Buffer.from(serializeJsonLine(fullCommand)),
			);
		} catch (error) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timeout);
				this.pending.delete(id);
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
		return response;
	}

	private handleFrame(frame: PrivateFrame<DaemonWorkerFrameHeader>): void {
		if (frame.header.kind !== "outbound") {
			return;
		}
		if (frame.header.outboundType === "response" && frame.header.requestId) {
			const pending = this.pending.get(frame.header.requestId);
			if (pending) {
				let response: unknown;
				try {
					response = JSON.parse(frame.payload.toString("utf8"));
				} catch (error) {
					clearTimeout(pending.timeout);
					this.pending.delete(frame.header.requestId);
					pending.reject(new Error(`Invalid daemon worker response: ${String(error)}`));
					return;
				}
				if (isDaemonResponse(response)) {
					clearTimeout(pending.timeout);
					this.pending.delete(frame.header.requestId);
					pending.resolve(response);
					return;
				}
			}
		}
		if (frame.header.outboundType === "daemon_hello") {
			try {
				const parsed = JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound;
				if (parsed.type === "daemon_hello") {
					this.hello = parsed;
					for (const waiter of [...this.helloWaiters]) {
						clearTimeout(waiter.timeout);
						this.helloWaiters.delete(waiter);
						waiter.resolve(parsed);
					}
				}
			} catch {
				// Invalid hello payloads are rejected by the timeout.
			}
		}
		for (const listener of this.frameListeners) {
			listener(frame);
		}
	}

	private rejectAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(error);
			this.pending.delete(id);
		}
		for (const waiter of [...this.helloWaiters]) {
			clearTimeout(waiter.timeout);
			this.helloWaiters.delete(waiter);
			waiter.reject(error);
		}
	}

	private notifyClosed(socket: Socket, error: Error): void {
		if (this.socket !== socket) {
			return;
		}
		this.socket = undefined;
		this.channel = undefined;
		this.rejectAll(error);
		for (const listener of [...this.closeListeners]) {
			listener(error);
		}
	}
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; command?: unknown; success?: unknown };
	return (
		candidate.type === "response" && typeof candidate.command === "string" && typeof candidate.success === "boolean"
	);
}
