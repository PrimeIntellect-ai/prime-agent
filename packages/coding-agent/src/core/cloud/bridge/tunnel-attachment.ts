import { randomUUID } from "node:crypto";
import {
	CLOUD_PROTOCOL_VERSION,
	type CloudCommandReceipt,
	type CloudCommandRequest,
	type CloudEvent,
	type CloudMessage,
	type CloudSessionId,
	cloudRequestDigest,
	cloudRequestProblem,
	newCloudClientId,
	parseCloudMessage,
} from "../protocol.js";
import type { CloudTunnelConnection, CloudTunnelTransport } from "./tunnel-transport.js";

/**
 * Durable, reconnectable tunnel attachment.
 *
 * One instance owns the local side of one delegated session's tunnel bridge:
 *
 * - Connect over the public tunnel URL with edge basic auth, then authenticate
 *   the session protocol itself with the bridge token in `hello`. Both layers
 *   are required: the edge gates anyone who reaches the URL, the protocol
 *   token gates anyone who survives the edge.
 * - Mirror guest events: append each new guest event (deduplicated by guest
 *   sequence) through the injected sink, flush the local durable trace, and
 *   only then acknowledge the guest cursor. Acknowledgement strictly follows
 *   local durability, so a crashed daemon never loses an acknowledged event.
 * - Submit commands idempotently: a submit stays pending until its receipt is
 *   observed, and is re-sent with the same command id and digest after every
 *   reconnect. The guest journal deduplicates, so a replay can never double a
 *   steer or cancel.
 * - Reconnect with capped exponential backoff and jitter; periodically verify
 *   the tunnel registration still exists, and stop cleanly (the delegation
 *   falls back to gateway-only monitoring) when it does not.
 *
 * Everything external is injected: the transport, the event sink, the tunnel
 * liveness probe, the session liveness probe, and the sleep function, so the
 * supervisor is fully testable against a fake bridge.
 */

export interface CloudTunnelAttachmentTarget {
	url: string;
	httpUser: string;
	httpPassword: string;
	bridgeToken: string;
}

/**
 * Durable guest-mirror position, persisting the two generations separately:
 * the sandbox generation fences incarnations, the event generation fences
 * event-log epochs (retention bumps it without a new sandbox). One field
 * cannot express both: after a trim the epochs differ, and a cursor saved
 * then must still resume the same sandbox's renumbered log on restart.
 */
export interface CloudGuestCursorRecord {
	/** Sandbox incarnation the position was recorded under. */
	sandboxGeneration: number;
	/** Event-log epoch the position names. */
	eventGeneration: number;
	/** Last event sequence consumed in that epoch. */
	sequence: number;
}

export interface CloudTunnelAttachmentCallbacks {
	/** Resolve the tunnel target before every connection; undefined releases. */
	resolveTarget(): CloudTunnelAttachmentTarget | undefined;
	/** Append one guest event to the local durable outbox. */
	appendGuestEvent(event: CloudEvent): void;
	/** Flush the local trace; resolve only after the append is fsynced. */
	flushTrace(): Promise<void>;
	/** Persist the guest cursor durably before it is acknowledged. */
	persistGuestCursor(cursor: CloudGuestCursorRecord): void;
	/** Load the durably persisted guest cursor. */
	loadGuestCursor(): CloudGuestCursorRecord | undefined;
	/** Record the per-attachment identity on every successful connection. */
	recordAttachment(attachmentUuid: string): void;
	/** True while the delegation can still be steered. */
	isSessionLive(): boolean;
	/** Tunnel REST probe; false means the registration is gone. */
	checkTunnelAlive(): Promise<boolean>;
	/** Non-fatal operational error, recorded on the session. */
	onAttachmentError(message: string): void;
	/** The tunnel is unrecoverable; the supervisor stops itself. */
	onTerminal(reason: string): void;
}

export interface CloudTunnelAttachmentOptions {
	sessionId: CloudSessionId;
	generation: number;
	transport: CloudTunnelTransport;
	callbacks: CloudTunnelAttachmentCallbacks;
	/** Initial reconnect delay; grows to `maxReconnectDelayMs`. */
	reconnectDelayMs?: number;
	maxReconnectDelayMs?: number;
	/** Check tunnel liveness after this many consecutive failed attempts. */
	checkTunnelAfterFailures?: number;
	/** Wait for a submit receipt before reporting the command as queued. */
	submitWaitMs?: number;
	/** Injectable sleep for tests. */
	sleepFn?: (ms: number) => Promise<void>;
}

export type CloudSteerOutcome = { state: "acknowledged"; receipt: CloudCommandReceipt } | { state: "queued" };

interface PendingSubmit {
	commandId: string;
	request: CloudCommandRequest;
	digest: string;
	resolvers: Set<(outcome: CloudSteerOutcome) => void>;
}

export class CloudTunnelAttachment {
	readonly sessionId: CloudSessionId;
	readonly generation: number;
	private readonly transport: CloudTunnelTransport;
	private readonly callbacks: CloudTunnelAttachmentCallbacks;
	private readonly reconnectDelayMs: number;
	private readonly maxReconnectDelayMs: number;
	private readonly checkTunnelAfterFailures: number;
	private readonly submitWaitMs: number;
	private readonly sleepFn: (ms: number) => Promise<void>;

	private connection: CloudTunnelConnection | undefined;
	private connectionClosed: (() => void) | undefined;
	private readonly pending = new Map<string, PendingSubmit>();
	private guestSequence = 0;
	/**
	 * The guest EVENT-LOG generation currently mirrored - distinct from the
	 * sandbox generation. Retention trims bump it (renumbering sequences from
	 * one); the sandbox generation never changes within one incarnation. All
	 * subscribe and ack frames, sequence deduplication, and the persisted
	 * cursor use this epoch, so a trim resyncs the position instead of
	 * wedging the attachment.
	 */
	private guestGeneration = 0;
	/** Durable resume point of the current connection, used for subscribe. */
	private subscribeFromSequence = 0;
	private subscribed = false;
	private run: Promise<void> | undefined;
	private stopped = false;
	private terminal = false;
	private consecutiveFailures = 0;
	private wake: (() => void) | undefined;

	constructor(options: CloudTunnelAttachmentOptions) {
		this.sessionId = options.sessionId;
		this.generation = options.generation;
		this.transport = options.transport;
		this.callbacks = options.callbacks;
		this.reconnectDelayMs = positiveInt(options.reconnectDelayMs ?? 250, "reconnectDelayMs");
		this.maxReconnectDelayMs = positiveInt(options.maxReconnectDelayMs ?? 15_000, "maxReconnectDelayMs");
		if (this.maxReconnectDelayMs < this.reconnectDelayMs) {
			throw new Error("maxReconnectDelayMs must not be smaller than reconnectDelayMs");
		}
		this.checkTunnelAfterFailures = positiveInt(options.checkTunnelAfterFailures ?? 3, "checkTunnelAfterFailures");
		this.submitWaitMs = positiveInt(options.submitWaitMs ?? 20_000, "submitWaitMs");
		this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	get attached(): boolean {
		return this.connection !== undefined && this.subscribed;
	}

	get pendingCount(): number {
		return this.pending.size;
	}

	/** Start the background supervisor loop; idempotent. */
	start(): void {
		if (this.run !== undefined || this.stopped) return;
		const loop = this.loop();
		this.run = loop.finally(() => {
			if (this.run === loop) this.run = undefined;
		});
	}

	/** Stop the supervisor, release the connection, and unblock waiters as queued. */
	async stop(): Promise<void> {
		if (this.stopped) return;
		this.stopped = true;
		this.connection?.close("attachment stopped");
		this.connection = undefined;
		for (const pending of this.pending.values()) this.resolvePending(pending, { state: "queued" });
		this.pending.clear();
		this.wake?.();
		if (this.run !== undefined) await this.run;
	}

	/**
	 * Submit one command. Resolves with the guest's admission receipt when it
	 * arrives within `submitWaitMs` (immediately when attached and the guest
	 * answers), otherwise with `queued`: the command stays pending and is
	 * re-sent after every reconnect until its receipt is observed.
	 */
	submit(commandId: string, request: CloudCommandRequest): Promise<CloudSteerOutcome> {
		if (this.stopped || this.terminal) {
			return Promise.reject(new Error("tunnel attachment is not active"));
		}
		// Reject anything the guest would treat as a protocol violation: a
		// poison command would be replayed on every reconnect and wedge the
		// supervisor against a bridge that closes the connection each time.
		const requestProblem = cloudRequestProblem(request);
		if (requestProblem !== undefined) {
			return Promise.reject(new Error(`invalid tunnel command: ${requestProblem}`));
		}
		const digest = cloudRequestDigest(request);
		const existing = this.pending.get(commandId);
		if (existing !== undefined && existing.digest !== digest) {
			return Promise.reject(new Error("command id reuse with a different request"));
		}
		// The waiter registers before the first send: a bridge that answers
		// inline (or a fake in tests) may resolve the receipt synchronously.
		return new Promise<CloudSteerOutcome>((resolve) => {
			const pending = existing ?? {
				commandId,
				request,
				digest,
				resolvers: new Set<(outcome: CloudSteerOutcome) => void>(),
			};
			if (existing === undefined) this.pending.set(commandId, pending);
			pending.resolvers.add(resolve);
			setTimeout(() => {
				if (pending.resolvers.delete(resolve)) resolve({ state: "queued" });
			}, this.submitWaitMs);
			if (existing === undefined) this.sendSubmit(pending);
		});
	}

	private sendSubmit(pending: PendingSubmit): void {
		if (this.connection === undefined || !this.subscribed) return;
		this.connection.send(
			JSON.stringify({
				type: "submit",
				sessionId: this.sessionId,
				generation: this.generation,
				commandId: pending.commandId,
				request: pending.request,
				digest: pending.digest,
			}),
		);
	}

	private resolvePending(pending: PendingSubmit, outcome: CloudSteerOutcome): void {
		if (this.pending.get(pending.commandId) === pending) this.pending.delete(pending.commandId);
		for (const resolve of pending.resolvers) resolve(outcome);
		pending.resolvers.clear();
	}

	private async loop(): Promise<void> {
		let delay = this.reconnectDelayMs;
		while (!this.stopped && !this.terminal) {
			if (!this.callbacks.isSessionLive()) return;
			const target = this.callbacks.resolveTarget();
			if (target === undefined) {
				this.callbacks.onTerminal("the tunnel was released");
				return;
			}
			try {
				const connection = await this.transport.connect(target.url, {
					Authorization: `Basic ${Buffer.from(`${target.httpUser}:${target.httpPassword}`).toString("base64")}`,
				});
				if (this.stopped) {
					connection.close("attachment stopped during connect");
					return;
				}
				await this.runConnection(connection, target);
				delay = this.reconnectDelayMs;
				this.consecutiveFailures = 0;
			} catch (error) {
				this.consecutiveFailures += 1;
				this.callbacks.onAttachmentError(`tunnel attachment failed: ${errorMessage(error)}`);
				if (this.consecutiveFailures % this.checkTunnelAfterFailures === 0 && !(await this.probeTunnelAlive())) {
					this.callbacks.onTerminal("the tunnel registration is gone; steering is unavailable");
					return;
				}
			}
			if (this.stopped || this.terminal || !this.callbacks.isSessionLive()) return;
			const jitter = 0.8 + Math.random() * 0.4;
			await this.interruptibleSleep(Math.round(Math.min(delay, this.maxReconnectDelayMs) * jitter));
			delay = Math.min(delay * 2, this.maxReconnectDelayMs);
		}
	}

	/** Backoff sleep that `stop()` can cut short so shutdown is not delayed. */
	private interruptibleSleep(ms: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.wake = undefined;
				resolve();
			}, ms);
			this.wake = () => {
				clearTimeout(timer);
				this.wake = undefined;
				resolve();
			};
		});
	}

	private async probeTunnelAlive(): Promise<boolean> {
		try {
			return await this.callbacks.checkTunnelAlive();
		} catch (error) {
			// A transient REST failure says nothing about the tunnel.
			this.callbacks.onAttachmentError(`tunnel liveness probe failed: ${errorMessage(error)}`);
			return true;
		}
	}

	private async runConnection(connection: CloudTunnelConnection, target: CloudTunnelAttachmentTarget): Promise<void> {
		this.connection = connection;
		this.subscribed = false;
		this.callbacks.recordAttachment(randomUUID());
		const closed = new Promise<void>((resolve) => {
			this.connectionClosed = resolve;
		});
		connection.onMessage((message) => {
			void this.handleMessage(message);
		});
		connection.onClose((error) => {
			if (error !== undefined) this.callbacks.onAttachmentError(`tunnel connection lost: ${error.message}`);
			this.connection = undefined;
			this.subscribed = false;
			this.connectionClosed?.();
			this.connectionClosed = undefined;
		});
		const resumeCursor = this.callbacks.loadGuestCursor();
		if (resumeCursor !== undefined && resumeCursor.sandboxGeneration === this.generation) {
			// The saved position names THIS sandbox incarnation's event log,
			// so the event epoch and sequence resume even after a retention
			// trim bumped the epoch past the sandbox generation. The epoch is
			// reconciled on the first snapshot (another trim while detached
			// resyncs through it), and the retained events never re-import.
			// A cursor from another incarnation names a log that no longer
			// exists and is discarded.
			this.guestGeneration = resumeCursor.eventGeneration;
			this.guestSequence = Math.max(this.guestSequence, resumeCursor.sequence);
		}
		// Subscribe from the durable resume point, never from the snapshot's
		// tail: a bounded snapshot may not carry the whole backlog, and the
		// replay plus sequence deduplication keeps mirroring complete.
		this.subscribeFromSequence = this.guestSequence;
		connection.send(
			JSON.stringify({
				type: "hello",
				protocolVersion: CLOUD_PROTOCOL_VERSION,
				generation: this.generation,
				clientId: newCloudClientId(),
				sessionId: this.sessionId,
				authToken: target.bridgeToken,
				...(this.guestGeneration === this.generation && this.guestSequence > 0
					? { cursor: { generation: this.generation, sequence: this.guestSequence } }
					: {}),
			}),
		);
		await closed;
	}

	private async handleMessage(message: string): Promise<void> {
		const parsed = parseCloudMessage(message);
		if (!parsed.ok) {
			this.callbacks.onAttachmentError(`tunnel bridge sent an invalid message: ${parsed.error}`);
			this.connection?.close("invalid protocol message");
			return;
		}
		const value = parsed.message as CloudMessage;
		try {
			if (value.type === "snapshot") {
				const firstContact = this.guestGeneration === 0;
				const epochChanged = value.generation !== this.guestGeneration;
				if (epochChanged && !firstContact) {
					// Retention trimmed and renumbered: adopt the new epoch and
					// reset the mirror position before importing, so the
					// snapshot's events land and later frames dedupe against
					// the new numbering. The position advances only through
					// imported events: a bounded snapshot carries just the
					// first page, so the subscribe drains the remaining pages,
					// and the persisted cursor reaches the true tail only
					// after that delivery - never by trusting the cursor of a
					// page it did not receive.
					this.guestGeneration = value.generation;
					this.guestSequence = 0;
					this.subscribeFromSequence = 0;
					await this.importEvents(value.events);
					this.subscribeFromSequence = this.guestSequence;
					this.persistGuestCursor();
				} else {
					// First contact or same epoch: adopt the epoch when new,
					// but keep the durable resume position for the subscribe -
					// a bounded snapshot may not carry the whole backlog, and
					// the replay plus sequence deduplication keeps the mirror
					// complete.
					if (epochChanged) {
						this.guestGeneration = value.generation;
					}
					await this.importEvents(value.events);
				}
				this.sendSubscribe();
				// The snapshot confirms authentication: everything not yet
				// receipted is re-sent now, and the guest journal deduplicates.
				for (const pending of this.pending.values()) this.sendSubmit(pending);
				return;
			}
			if (value.type === "events") {
				if (value.generation !== this.guestGeneration) {
					// A trim landed between frames: the batch is already in the
					// new epoch, so reset the dedupe position before importing.
					this.guestGeneration = value.generation;
					this.guestSequence = 0;
				}
				await this.importEvents(value.events);
				return;
			}
			if (value.type === "command") {
				const pending = this.pending.get(value.receipt.commandId);
				if (pending !== undefined) this.resolvePending(pending, { state: "acknowledged", receipt: value.receipt });
				return;
			}
		} catch (error) {
			this.callbacks.onAttachmentError(`tunnel event mirroring failed: ${errorMessage(error)}`);
			this.connection?.close("event mirroring failed");
			return;
		}
		// The bridge never sends hello, subscribe, submit, get_command, or ack.
		this.callbacks.onAttachmentError(`tunnel bridge sent an unexpected message type: ${value.type}`);
	}

	private sendSubscribe(): void {
		if (this.connection === undefined) return;
		if (this.guestGeneration === 0) return;
		this.connection.send(
			JSON.stringify({
				type: "subscribe",
				sessionId: this.sessionId,
				cursor: { generation: this.guestGeneration, sequence: this.subscribeFromSequence },
			}),
		);
		this.subscribed = true;
	}

	private async importEvents(events: readonly CloudEvent[]): Promise<void> {
		let appended = 0;
		let tail = this.guestSequence;
		for (const event of events) {
			if (event.sequence <= this.guestSequence) continue;
			this.callbacks.appendGuestEvent(event);
			tail = event.sequence;
			appended += 1;
		}
		if (appended === 0) return;
		this.guestSequence = tail;
		this.persistGuestCursor();
		await this.callbacks.flushTrace();
		this.connection?.send(
			JSON.stringify({
				type: "ack",
				sessionId: this.sessionId,
				cursor: { generation: this.guestGeneration, sequence: tail },
			}),
		);
	}

	private persistGuestCursor(): void {
		if (this.guestGeneration === 0) return;
		this.callbacks.persistGuestCursor({
			sandboxGeneration: this.generation,
			eventGeneration: this.guestGeneration,
			sequence: this.guestSequence,
		});
	}
}

function positiveInt(value: number, label: string): number {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
	return value;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
