import type { DaemonCommandBody } from "./daemon-client.js";
import { DaemonClient } from "./daemon-client.js";
import type { DaemonResponse } from "./daemon-protocol.js";

/**
 * Long-lived supervisor connection for a daemon worker.
 *
 * daemon-mode.ts used to open a fresh DaemonClient - connect, hello,
 * request, close - on every cross-worker interaction (agent messages,
 * roster reads, root-session creation, renames). SupervisorLink holds
 * one persistent connection instead and multiplexes requests over it.
 * Socket death is expected (supervisor restarts): the link tears down
 * on close, the next request reconnects, and one in-flight retry
 * preserves the old per-call-fresh-connection resilience.
 */

export interface DaemonClientLike {
	connect(timeoutMs: number): Promise<void>;
	waitForHello(timeoutMs?: number): Promise<unknown>;
	request(command: DaemonCommandBody, timeoutMs: number): Promise<DaemonResponse>;
	onClose(listener: () => void): () => void;
	close(): void;
}

export interface SupervisorLinkOptions {
	socketPath: string;
	connectTimeoutMs?: number;
	/** Request-level default; call sites may override per request. */
	requestTimeoutMs?: number;
	/** Test seam: client factory. */
	factory?: (socketPath: string) => DaemonClientLike;
}

export class SupervisorLink {
	private client?: DaemonClientLike;
	private connecting?: Promise<DaemonClientLike>;
	private closed = false;
	private readonly disposers = new Set<() => void>();

	constructor(private readonly options: SupervisorLinkOptions) {}

	/**
	 * Send one request over the persistent link. Never retries: daemon
	 * commands like create or send_message are not idempotent, so the
	 * link tears down on failure and the NEXT request reconnects. Call
	 * sites that need an establishment window use ensureConnected in
	 * their own retry loop.
	 */
	async request(
		command: DaemonCommandBody,
		timeoutMs: number = this.options.requestTimeoutMs ?? 30_000,
	): Promise<DaemonResponse> {
		if (this.closed) throw new Error("Supervisor link is closed");
		const client = await this.ensureConnected();
		try {
			return await client.request(command, timeoutMs);
		} catch (error) {
			this.teardown();
			throw error;
		}
	}

	/** Establish (or reuse) the authenticated connection. */
	async ensureConnected(): Promise<DaemonClientLike> {
		if (this.closed) throw new Error("Supervisor link is closed");
		return this.ensureConnectedInternal();
	}

	private async ensureConnectedInternal(): Promise<DaemonClientLike> {
		if (this.client) return this.client;
		this.connecting ??= (async () => {
			const client = (
				this.options.factory ?? ((socketPath: string) => new DaemonClient(socketPath) as DaemonClientLike)
			)(this.options.socketPath);
			const detach = client.onClose(() => this.teardown());
			this.disposers.add(detach);
			await client.connect(this.options.connectTimeoutMs ?? 1000);
			await client.waitForHello();
			this.client = client;
			return client;
		})();
		try {
			return await this.connecting;
		} finally {
			this.connecting = undefined;
		}
	}

	/** Drop the cached connection; the next request reconnects. */
	teardown(): void {
		const client = this.client;
		this.client = undefined;
		this.connecting = undefined;
		for (const detach of this.disposers) detach();
		this.disposers.clear();
		client?.close();
	}

	/** Stop the link permanently; further requests fail fast without reconnecting. */
	close(): void {
		this.closed = true;
		this.teardown();
	}
}
