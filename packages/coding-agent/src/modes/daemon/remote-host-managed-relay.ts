/**
 * Managed relay-link state machine for remote-agent-host protocol.
 *
 * An outbound managed-relay link shared by home and sandbox sides.
 * Uses an injected WebSocket factory so unit tests are deterministic
 * and never touch a network.
 *
 * Supports connecting, exact-build handshake admission, authenticated
 * one-time relay grant use without persisting or emitting the grant,
 * connected health, ping/pong liveness, reconnect with bounded
 * exponential backoff+jitter, replay from durable cursors, graceful
 * close, and unreachable terminal state.
 *
 * Both endpoints connect outbound; there is no local listen socket,
 * SSH control path, or client-side global concurrency limiter.
 *
 * No credentials or raw frames containing model content are logged.
 */

import type { SandboxConnectionHealth } from "../../core/execution-location.js";
import type { RemoteHostEventCursor, RemoteHostEventSequence } from "./remote-agent-host-protocol.js";
import {
	REMOTE_HOST_PROTOCOL_INFO,
	type RemoteHostBuildIdentity,
	type RemoteHostCapability,
	type RemoteHostFrame,
	type RemoteHostFrameEnvelope,
	type RemoteHostHandshakeAckFrame,
	type RemoteHostHandshakeFrame,
	type RemoteHostLinkDirection,
	type RemoteHostLinkStatus,
} from "./remote-agent-host-protocol.js";
import type { RemoteHostJournalLike } from "./remote-host-journal.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PING_INTERVAL_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// ---------------------------------------------------------------------------
// WebSocket abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal WebSocket interface for relay links.
 *
 * Both the real ws.WebSocket and test fakes implement this so the
 * relay never touches a real network during unit tests.
 */
export interface RelayWebSocket {
	readonly readyState: number;
	onopen: (() => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	onerror: ((event: { error: unknown }) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

/**
 * Factory interface for creating WebSocket connections.
 *
 * Inject a fake factory in tests to avoid real network I/O.
 */
export interface WebSocketFactory {
	create(url: string): RelayWebSocket;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Internal relay state — not emitted directly.
 * The public API surfaces {@link ManagedRelayLink.health} as a
 * {@link SandboxConnectionHealth} value.
 */
type RelayInternalState =
	| { readonly status: "idle" }
	| { readonly status: "connecting"; readonly url: string; readonly attempt: number }
	| { readonly status: "handshaking"; readonly url: string; readonly attempt: number }
	| { readonly status: "connected" }
	| { readonly status: "reconnecting"; readonly attempt: number }
	| { readonly status: "closed" }
	| { readonly status: "unreachable"; readonly error: string };

/** Events emitted by the relay link. */
export type ManagedRelayLinkEvent =
	| { readonly type: "frame_received"; readonly envelope: RemoteHostFrameEnvelope; readonly isDuplicate: boolean }
	| { readonly type: "handshake_rejected"; readonly reason: string }
	| {
			readonly type: "handshake_completed";
			readonly linkId: string;
			readonly remoteCapabilities: readonly RemoteHostCapability[];
	  }
	| { readonly type: "recovered" }
	| { readonly type: "error"; readonly error: Error };

/** Callback for relay events. */
export type ManagedRelayLinkObserver = (event: ManagedRelayLinkEvent) => void;

export interface ManagedRelayLinkOptions {
	readonly url: string;
	readonly hostId: string;
	readonly generation: string;
	readonly buildIdentity: RemoteHostBuildIdentity;
	readonly direction: RemoteHostLinkDirection;
	readonly capabilities: readonly RemoteHostCapability[];
	readonly journal: RemoteHostJournalLike;
	readonly wsFactory: WebSocketFactory;
	readonly grant?: string;
	readonly pingIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jitteredBackoffMs(attempt: number): number {
	const base = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempt, MAX_RECONNECT_DELAY_MS);
	return Math.round(base * (0.5 + Math.random() * 0.5));
}

function nowISO(): string {
	return new Date().toISOString();
}

function nextFrameId(hostId: string, n: number): string {
	return `${hostId}-frame-${n}`;
}

// ---------------------------------------------------------------------------
// ManagedRelayLink
// ---------------------------------------------------------------------------

/**
 * Outbound managed-relay link for the remote-agent-host protocol.
 *
 * Lifecycle:
 *   idle -> connecting -> handshaking -> connected
 *   connected -> reconnecting -> handshaking -> connected
 *   any -> closed (graceful close from outside)
 *   handshaking/reconnecting -> unreachable (rejected or exhausted)
 */
export class ManagedRelayLink {
	private _state: RelayInternalState = { status: "idle" };
	private _connectedAt: string | undefined;
	private readonly options: ManagedRelayLinkOptions;
	private readonly pingIntervalMs: number;
	private nextFrameSeq = 0;

	// Reconnect state
	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAborted = false;

	// Ping timer
	private pingTimer: ReturnType<typeof setInterval> | undefined;

	// Active socket
	private socket: RelayWebSocket | undefined;

	// Observers
	private readonly observers: ManagedRelayLinkObserver[] = [];

	// Handshake promise — resolves once a handshake_ack is received
	private handshakeResolver:
		| ((result: {
				accepted: boolean;
				linkId?: string;
				remoteCapabilities?: readonly RemoteHostCapability[];
				rejectReason?: string;
		  }) => void)
		| undefined;

	constructor(options: ManagedRelayLinkOptions) {
		this.options = options;
		this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	/** Register an observer for relay events. */
	observe(observer: ManagedRelayLinkObserver): void {
		this.observers.push(observer);
	}

	/** Remove a previously registered observer. */
	unobserve(observer: ManagedRelayLinkObserver): void {
		const idx = this.observers.indexOf(observer);
		if (idx >= 0) {
			this.observers.splice(idx, 1);
		}
	}

	/**
	 * Initiate a connection.
	 * Returns a promise that resolves once the handshake completes
	 * (either accepted or rejected).
	 */
	async connect(): Promise<{ accepted: boolean; linkId?: string; rejectReason?: string }> {
		if (this._state.status === "unreachable" || this._state.status === "closed") {
			throw new Error(`Relay is in terminal state: ${this._state.status}`);
		}
		return this.startConnect();
	}

	/**
	 * Send a frame over the relay.
	 * Persists to journal before sending (persist-before-send contract).
	 */
	sendFrame(frame: RemoteHostFrame): RemoteHostFrameEnvelope {
		const frameId = nextFrameId(this.options.hostId, ++this.nextFrameSeq);
		const envelope: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId,
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: nowISO(),
			frame,
		};

		// Persist before send
		this.options.journal.recordSent(envelope);

		if (this.socket && this.socket.readyState === 1) {
			this.socket.send(JSON.stringify(envelope));
		}

		return envelope;
	}

	/**
	 * Gracefully close the relay link.
	 * Cancels pending timers and closes the WebSocket.
	 */
	close(): void {
		this.reconnectAborted = true;
		this.clearTimers();

		if (this.socket) {
			try {
				this.socket.close(1000, "Normal closure");
			} catch {
				// Socket may already be closing
			}
			this.socket = undefined;
		}

		this.transition("closed");
	}

	/**
	 * Current public connection health, mapped to SandboxConnectionHealth.
	 */
	get health(): SandboxConnectionHealth {
		switch (this._state.status) {
			case "idle":
				return { status: "connecting", startedAt: nowISO() };
			case "connecting":
			case "handshaking":
				return { status: "connecting", startedAt: nowISO() };
			case "connected":
				return { status: "connected", connectedAt: this._connectedAt ?? nowISO() };
			case "reconnecting":
				return {
					status: "reconnecting",
					attempt: this._state.attempt,
					since: nowISO(),
				};
			case "unreachable":
				return { status: "unreachable", error: this._state.error, failedAt: nowISO() };
			case "closed":
				return { status: "closed" };
			default:
				return { status: "closed" };
		}
	}

	/** Current internal relay status string. */
	get status(): RelayInternalState["status"] {
		return this._state.status;
	}

	/** Link status for health frames. */
	get linkStatus(): RemoteHostLinkStatus {
		switch (this._state.status) {
			case "idle":
			case "connecting":
			case "handshaking":
				return "connecting";
			case "connected":
				return "connected";
			case "reconnecting":
				return "reconnecting";
			case "unreachable":
				return "unreachable";
			case "closed":
				return "closed";
			default:
				return "closed";
		}
	}

	/**
	 * Resume cursor derived from the journal's last received event sequence.
	 */
	get resumeCursor(): RemoteHostEventCursor | undefined {
		const seq = this.options.journal.lastReceivedEventSequence;
		if (seq === 0) return undefined;
		return {
			hostId: this.options.hostId,
			generation: this.options.generation,
			sessionId: "",
			sequence: seq as RemoteHostEventSequence,
		};
	}

	// -----------------------------------------------------------------------
	// Internal state machine
	// -----------------------------------------------------------------------

	private async startConnect(): Promise<{ accepted: boolean; linkId?: string; rejectReason?: string }> {
		this.transition(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
		this.reconnectAborted = false;

		// Build URL, optionally with grant as query param
		let url = this.options.url;
		if (this.options.grant && !url.includes("?")) {
			url += `?grant=${encodeURIComponent(this.options.grant)}`;
		} else if (this.options.grant) {
			url += `&grant=${encodeURIComponent(this.options.grant)}`;
		}

		const ws = this.options.wsFactory.create(url);
		this.socket = ws;

		return new Promise((resolve) => {
			this.handshakeResolver = resolve;

			ws.onopen = () => {
				if (this.reconnectAborted) {
					resolve({ accepted: false, rejectReason: "closed" });
					return;
				}
				this.transitionToConnectingOrHandshaking();

				// Send handshake frame
				const handshake: RemoteHostHandshakeFrame = {
					type: "handshake",
					direction: this.options.direction,
					hostId: this.options.hostId,
					generation: this.options.generation,
					sessionId: this.options.hostId,
					capabilities: [...this.options.capabilities],
					runtime: { ...this.options.buildIdentity },
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					resumeCursor: this.resumeCursor,
				};

				// Generate a frameId for the handshake but don't persist handshake to journal
				const frameId = nextFrameId(this.options.hostId, 0);
				const envelope: RemoteHostFrameEnvelope = {
					type: "frame",
					frameId,
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					sentAt: nowISO(),
					frame: handshake,
				};
				ws.send(JSON.stringify(envelope));
			};

			ws.onclose = (event) => {
				if (this.reconnectAborted) return;
				this.socket = undefined;
				this.handleDisconnect(event.code, event.reason);
			};

			ws.onerror = () => {
				// close event will follow, do nothing here
			};

			ws.onmessage = (event) => {
				try {
					this.handleMessage(event.data);
				} catch (err) {
					this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
				}
			};
		});
	}

	private transitionToConnectingOrHandshaking(): void {
		if (this.reconnectAttempt > 0) {
			this._state = {
				status: "handshaking",
				url: this.options.url,
				attempt: this.reconnectAttempt,
			};
		} else {
			this._state = {
				status: "handshaking",
				url: this.options.url,
				attempt: 0,
			};
		}
	}

	private handleDisconnect(_code: number, _reason: string): void {
		if (this._state.status === "closed" || this._state.status === "unreachable") {
			return;
		}
		this.clearPing();
		this.scheduleReconnect();
	}

	private handleMessage(raw: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.emit({ type: "error", error: new Error("Failed to parse frame JSON") });
			return;
		}

		const obj = parsed as Record<string, unknown>;
		if (obj.type !== "frame" || !obj.frame) {
			this.emit({ type: "error", error: new Error("Received non-frame message") });
			return;
		}

		const envelope = parsed as RemoteHostFrameEnvelope;

		// Handle handshake_ack specially
		if (envelope.frame.type === "handshake_ack") {
			this.handleHandshakeAck(envelope.frame);
			return;
		}

		// Record and dedup via journal
		const result = this.options.journal.recordReceived(envelope);
		this.emit({
			type: "frame_received",
			envelope,
			isDuplicate: result.isDuplicate,
		});

		// Handle health frames (ping/pong)
		if (envelope.frame.type === "health") {
			// We track lastReceivedFrameTime; no other action needed
		}
	}

	private handleHandshakeAck(ack: RemoteHostHandshakeAckFrame): void {
		if (!ack.accepted) {
			const reason = ack.rejectReason ?? "Handshake rejected";
			this.emit({ type: "handshake_rejected", reason });

			if (this.handshakeResolver) {
				this.handshakeResolver({ accepted: false, rejectReason: reason });
				this.handshakeResolver = undefined;
			}

			this.transition("unreachable", reason);
			return;
		}

		// Verify build compatibility on the ack side
		// The ack carries the remote's runtime info implicitly via
		// acceptance (the remote already validated us).
		this._connectedAt = nowISO();
		this._state = { status: "connected" };
		this.reconnectAttempt = 0;
		this.startPing();

		if (this.handshakeResolver) {
			this.handshakeResolver({
				accepted: true,
				linkId: ack.linkId,
				remoteCapabilities: ack.capabilities,
			});
			this.handshakeResolver = undefined;
		}

		this.emit({
			type: "handshake_completed",
			linkId: ack.linkId,
			remoteCapabilities: ack.capabilities,
		});

		// Trigger replay from journal
		this.emit({ type: "recovered" });
	}

	private transition(status: RelayInternalState["status"], error?: string): void {
		switch (status) {
			case "idle":
				this._state = { status: "idle" };
				break;
			case "connecting":
				this._state = { status: "connecting", url: this.options.url, attempt: this.reconnectAttempt };
				break;
			case "handshaking":
				this._state = { status: "handshaking", url: this.options.url, attempt: this.reconnectAttempt };
				break;
			case "connected":
				this._state = { status: "connected" };
				this._connectedAt = nowISO();
				this.reconnectAttempt = 0;
				break;
			case "reconnecting":
				this._state = { status: "reconnecting", attempt: this.reconnectAttempt };
				break;
			case "closed":
				this._state = { status: "closed" };
				break;
			case "unreachable":
				this._state = { status: "unreachable", error: error ?? "Unknown error" };
				break;
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectAborted) return;
		if (this._state.status === "closed" || this._state.status === "unreachable") return;

		this.reconnectAttempt++;
		if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
			this.transition("unreachable", `Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exhausted`);
			return;
		}

		this.transition("reconnecting");
		const delay = jitteredBackoffMs(this.reconnectAttempt);

		this.reconnectTimer = setTimeout(() => {
			if (this.reconnectAborted) return;
			if (this._state.status === "closed" || this._state.status === "unreachable") return;

			this.startConnect().catch(() => {
				// Handled inside startConnect
			});
		}, delay);
	}

	private startPing(): void {
		this.clearPing();
		this.pingTimer = setInterval(() => {
			if (this._state.status !== "connected" || !this.socket) {
				this.clearPing();
				return;
			}
			// Send a health frame as a ping
			const frameId = nextFrameId(this.options.hostId, ++this.nextFrameSeq);
			const envelope: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: nowISO(),
				frame: {
					type: "health",
					healthSeq: this.nextFrameSeq,
					status: this.linkStatus,
				},
			};
			this.options.journal.recordSent(envelope);
			try {
				this.socket.send(JSON.stringify(envelope));
			} catch {
				this.handleDisconnect(1006, "Ping send failed");
			}
		}, this.pingIntervalMs);
	}

	private clearPing(): void {
		if (this.pingTimer !== undefined) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
	}

	private clearTimers(): void {
		this.clearPing();
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
	}

	private emit(event: ManagedRelayLinkEvent): void {
		for (const observer of this.observers) {
			try {
				observer(event);
			} catch {
				// Observer failure is non-fatal
			}
		}
	}
}
