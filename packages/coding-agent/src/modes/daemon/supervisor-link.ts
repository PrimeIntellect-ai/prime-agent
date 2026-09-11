import type { DaemonCommandBody } from "./daemon-client.js";
import { DaemonClient, DaemonSocketClosedError } from "./daemon-client.js";
import type { DaemonResponse } from "./daemon-protocol.js";

/**
 * Long-lived supervisor connection for a daemon worker.
 *
 * Holds one persistent connection and multiplexes cross-worker requests
 * (agent messages, roster reads, root-session creation, renames) over
 * it. Socket death is expected during supervisor restarts: teardown
 * happens on close or handshake failure, and the next request
 * reconnects. Requests are never retried (daemon commands are not
 * idempotent).
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
			// A command-level failure (timeout, rejection) leaves a healthy
			// socket serving other in-flight requests; only socket death
			// invalidates the shared connection.
			if (error instanceof DaemonSocketClosedError) this.teardown();
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
			try {
				await client.connect(this.options.connectTimeoutMs ?? 1000);
				await client.waitForHello();
			} catch (error) {
				// DaemonClient fires onClose only after a successful connect,
				// so a failed handshake must close its own socket here.
				this.disposers.delete(detach);
				detach();
				client.close();
				throw error;
			}
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
