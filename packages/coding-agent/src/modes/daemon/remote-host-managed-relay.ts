/**
 * Managed relay-link state machine for remote-agent-host protocol.
 */

import { randomUUID } from "node:crypto";
import type { SandboxConnectionHealth } from "../../core/execution-location.js";
import type { RemoteHostEventCursor, RemoteHostEventSequence } from "./remote-agent-host-protocol.js";
import {
	isRemoteHostBuildCompatible,
	isRemoteHostProtocolCompatible,
	REMOTE_HOST_PROTOCOL_INFO,
	type RemoteHostBuildIdentity,
	type RemoteHostCapability,
	type RemoteHostFrame,
	type RemoteHostFrameEnvelope,
	type RemoteHostHandshakeAckFrame,
	type RemoteHostHandshakeFrame,
	type RemoteHostLinkDirection,
	type RemoteHostLinkStatus,
	validateRemoteHostFrame,
	validateRemoteHostHandshakeAck,
} from "./remote-agent-host-protocol.js";
import type { RemoteHostJournalLike } from "./remote-host-journal.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PING_INTERVAL_MS = 30_000;
const DEFAULT_PONG_TIMEOUT_MS = 60_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;
const MAX_REPLAY_PAGES = 10;

// ---------------------------------------------------------------------------
// WebSocket abstraction
// ---------------------------------------------------------------------------

export interface RelayWebSocket {
	readonly readyState: number;
	onopen: (() => void) | null;
	onclose: ((event: { code: number; reason: string }) => void) | null;
	onerror: ((event: { error: unknown }) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface WebSocketFactory {
	create(url: string, auth?: { grant?: string }): RelayWebSocket;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RelayInternalState =
	| { readonly status: "idle" }
	| { readonly status: "connecting"; readonly attempt: number }
	| { readonly status: "handshaking"; readonly attempt: number }
	| { readonly status: "connected"; readonly linkId: string }
	| { readonly status: "reconnecting"; readonly attempt: number }
	| { readonly status: "closed" }
	| { readonly status: "unreachable"; readonly error: string; readonly failedAt: string };

export type ManagedRelayLinkEvent =
	| { readonly type: "frame_received"; readonly envelope: RemoteHostFrameEnvelope; readonly isDuplicate: boolean }
	| { readonly type: "handshake_rejected"; readonly reason: string }
	| {
			readonly type: "handshake_completed";
			readonly linkId: string;
			readonly remoteCapabilities: readonly RemoteHostCapability[];
	  }
	| { readonly type: "recovered" }
	| { readonly type: "replay_resync_required"; readonly reason: string }
	| { readonly type: "error"; readonly error: Error };

export type ManagedRelayLinkObserver = (event: ManagedRelayLinkEvent) => void;

export type Disposer = () => void;

interface ConnectResult {
	accepted: boolean;
	linkId?: string;
	rejectReason?: string;
}

export interface ManagedRelayLinkOptions {
	readonly url: string;
	readonly hostId: string;
	readonly generation: string;
	readonly sessionId: string;
	readonly expectedRemoteHostId: string;
	readonly expectedRemoteSessionId: string;
	readonly buildIdentity: RemoteHostBuildIdentity;
	readonly direction: RemoteHostLinkDirection;
	readonly capabilities: readonly RemoteHostCapability[];
	readonly journal: RemoteHostJournalLike;
	readonly wsFactory: WebSocketFactory;
	readonly grantProvider?: () => Promise<string>;
	readonly pingIntervalMs?: number;
	readonly pongTimeoutMs?: number;
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

// ---------------------------------------------------------------------------
// ManagedRelayLink
// ---------------------------------------------------------------------------

export class ManagedRelayLink {
	private _state: RelayInternalState = { status: "idle" };
	private readonly options: ManagedRelayLinkOptions;
	private readonly pingIntervalMs: number;
	private readonly pongTimeoutMs: number;

	private connectingSince: string | undefined;
	private connectedAt: string | undefined;
	private reconnectingSince: string | undefined;
	private lastPongAt = 0;
	private healthSeqCounter = 0;

	private reconnectAttempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private reconnectAborted = false;

	private pingTimer: ReturnType<typeof setInterval> | undefined;

	private generation = 0;

	private socket: RelayWebSocket | undefined;

	private observers: ManagedRelayLinkObserver[] = [];

	private connectPromise: Promise<ConnectResult> | undefined;
	private connectResolve: ((result: ConnectResult) => void) | undefined;
	private handshakeTimer: ReturnType<typeof setTimeout> | undefined;
	private replayAborted = false;

	constructor(options: ManagedRelayLinkOptions) {
		// Validate identity fields: all must be nonempty bounded strings.
		const maxIdLen = 128;
		if (typeof options.hostId !== "string" || options.hostId.length === 0 || options.hostId.length > maxIdLen) {
			throw new Error("Invalid or missing hostId");
		}
		if (
			typeof options.generation !== "string" ||
			options.generation.length === 0 ||
			options.generation.length > maxIdLen
		) {
			throw new Error("Invalid or missing generation");
		}
		if (
			typeof options.sessionId !== "string" ||
			options.sessionId.length === 0 ||
			options.sessionId.length > maxIdLen
		) {
			throw new Error("Invalid or missing sessionId");
		}
		if (
			typeof options.expectedRemoteHostId !== "string" ||
			options.expectedRemoteHostId.length === 0 ||
			options.expectedRemoteHostId.length > maxIdLen
		) {
			throw new Error("Invalid or missing expectedRemoteHostId");
		}
		if (
			typeof options.expectedRemoteSessionId !== "string" ||
			options.expectedRemoteSessionId.length === 0 ||
			options.expectedRemoteSessionId.length > maxIdLen
		) {
			throw new Error("Invalid or missing expectedRemoteSessionId");
		}
		// Validate build identity: all fields must be nonnegative integers.
		if (
			typeof options.buildIdentity.buildId !== "string" ||
			options.buildIdentity.buildId.length === 0 ||
			options.buildIdentity.buildId.length > maxIdLen
		) {
			throw new Error("Invalid or missing buildIdentity.buildId");
		}
		if (
			typeof options.buildIdentity.daemonProtocolVersion !== "number" ||
			!Number.isInteger(options.buildIdentity.daemonProtocolVersion) ||
			options.buildIdentity.daemonProtocolVersion < 0
		) {
			throw new Error("Invalid buildIdentity.daemonProtocolVersion");
		}
		if (
			typeof options.buildIdentity.daemonSchemaRevision !== "number" ||
			!Number.isInteger(options.buildIdentity.daemonSchemaRevision) ||
			options.buildIdentity.daemonSchemaRevision < 0
		) {
			throw new Error("Invalid buildIdentity.daemonSchemaRevision");
		}
		this.options = options;
		this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
		this.pongTimeoutMs = options.pongTimeoutMs ?? DEFAULT_PONG_TIMEOUT_MS;
	}

	// -----------------------------------------------------------------------
	// Public API
	// -----------------------------------------------------------------------

	observe(observer: ManagedRelayLinkObserver): Disposer {
		this.observers.push(observer);
		return () => {
			const idx = this.observers.indexOf(observer);
			if (idx >= 0) this.observers.splice(idx, 1);
		};
	}

	async connect(): Promise<ConnectResult> {
		if (this._state.status === "unreachable" || this._state.status === "closed") {
			throw new Error("Relay is in terminal state");
		}
		if (this.connectPromise) {
			return this.connectPromise;
		}
		// Cancel pending reconnect timer so this call creates a fresh socket.
		if (this._state.status === "reconnecting" && this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this.connectPromise = this.startConnect();
		return this.connectPromise;
	}

	sendFrame(frame: RemoteHostFrame): RemoteHostFrameEnvelope {
		const frameId = randomUUID();
		const envelope: RemoteHostFrameEnvelope = {
			type: "frame",
			frameId,
			protocol: REMOTE_HOST_PROTOCOL_INFO,
			sentAt: nowISO(),
			frame,
		};
		this.options.journal.recordSent(envelope);
		if (this.socket && this.socket.readyState === 1) {
			try {
				this.socket.send(JSON.stringify(envelope));
			} catch {
				this.teardownSocket();
				this.handleDisconnect();
			}
		}
		return envelope;
	}

	close(): void {
		this.replayAborted = true;
		this.reconnectAborted = true;
		this.clearTimers();
		this.resolveConnect({ accepted: false, rejectReason: "closed" });
		this.teardownSocket();
		this.transition("closed");
		this.observers = [];
	}

	get health(): SandboxConnectionHealth {
		switch (this._state.status) {
			case "idle":
			case "connecting":
			case "handshaking":
				return { status: "connecting", startedAt: this.connectingSince ?? nowISO() };
			case "connected":
				return { status: "connected", connectedAt: this.connectedAt ?? nowISO() };
			case "reconnecting":
				return {
					status: "reconnecting",
					attempt: this._state.attempt,
					since: this.reconnectingSince ?? nowISO(),
				};
			case "unreachable":
				return { status: "unreachable", error: this._state.error, failedAt: this._state.failedAt };
			case "closed":
				return { status: "closed" };
			default:
				return { status: "closed" };
		}
	}

	get status(): RelayInternalState["status"] {
		return this._state.status;
	}

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

	get resumeCursor(): RemoteHostEventCursor | undefined {
		const seq = this.options.journal.lastReceivedEventSequence;
		if (seq === 0) return undefined;
		return {
			hostId: this.options.hostId,
			generation: this.options.generation,
			sessionId: this.options.sessionId,
			sequence: seq as RemoteHostEventSequence,
		};
	}

	// -----------------------------------------------------------------------
	// Internal
	// -----------------------------------------------------------------------

	private async startConnect(): Promise<ConnectResult> {
		this.transition("connecting");
		this.reconnectAborted = false;
		this.connectingSince = nowISO();

		const gen = ++this.generation;

		let auth: { grant?: string } | undefined;
		if (this.options.grantProvider) {
			try {
				const grant = await this.options.grantProvider();
				auth = { grant };
			} catch {
				this.connectPromise = undefined;
				this.resolveConnect({ accepted: false, rejectReason: "grant_failed" });
				this.teardownSocket();
				this.handleDisconnect();
				return { accepted: false, rejectReason: "grant_failed" };
			}
		}

		if (this.options.grantProvider && !auth) {
			return { accepted: false, rejectReason: "grant_failed" };
		}

		const ws = this.options.wsFactory.create(this.options.url, auth);
		this.socket = ws;

		const guard = (): boolean => {
			if (
				this.reconnectAborted ||
				this.generation !== gen ||
				this._state.status === "closed" ||
				this._state.status === "unreachable"
			) {
				return false;
			}
			return true;
		};

		return new Promise<ConnectResult>((resolve) => {
			this.connectResolve = resolve;

			ws.onopen = () => {
				if (!guard()) {
					resolve({ accepted: false, rejectReason: "stale" });
					return;
				}
				this.transition("handshaking");

				const handshake: RemoteHostHandshakeFrame = {
					type: "handshake",
					direction: this.options.direction,
					hostId: this.options.hostId,
					generation: this.options.generation,
					sessionId: this.options.sessionId,
					capabilities: [...this.options.capabilities],
					runtime: { ...this.options.buildIdentity },
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					resumeCursor: this.resumeCursor,
				};

				const envelope: RemoteHostFrameEnvelope = {
					type: "frame",
					frameId: randomUUID(),
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					sentAt: nowISO(),
					frame: handshake,
				};
				try {
					ws.send(JSON.stringify(envelope));
				} catch {
					this.teardownSocket();
					resolve({ accepted: false, rejectReason: "send_failed" });
					this.connectPromise = undefined;
					this.disconnectAndReconnect();
					return;
				}

				this.handshakeTimer = setTimeout(() => {
					if (!guard()) return;
					this.teardownSocket();
					resolve({ accepted: false, rejectReason: "handshake_timeout" });
					this.connectPromise = undefined;
					this.disconnectAndReconnect();
				}, HANDSHAKE_TIMEOUT_MS);
			};

			ws.onclose = (event) => {
				if (this.generation !== gen) return;
				this.socket = undefined;
				if (!guard() && this._state.status !== "reconnecting" && this._state.status !== "unreachable") {
					return;
				}
				this.clearHandshakeTimer();
				resolve({ accepted: false, rejectReason: `close:${event.code}` });
				this.connectPromise = undefined;
				this.handleDisconnect();
			};

			ws.onerror = () => {
				if (this.generation !== gen) return;
				this.teardownSocket();
				this.clearHandshakeTimer();
				resolve({ accepted: false, rejectReason: "socket_error" });
				this.connectPromise = undefined;
				this.handleDisconnect();
			};

			ws.onmessage = (event) => {
				if (this.generation !== gen) return;
				try {
					this.handleMessage(event.data, gen);
				} catch (err) {
					this.emit({ type: "error", error: err instanceof Error ? err : new Error(String(err)) });
				}
			};
		});
	}

	private handleDisconnect(): void {
		if (this._state.status === "closed" || this._state.status === "unreachable") {
			return;
		}
		this.clearPing();
		this.scheduleReconnect();
	}

	private handleMessage(raw: string, gen: number): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			this.emit({ type: "error", error: new Error("Failed to parse frame JSON") });
			return;
		}

		const validationError = validateRemoteHostFrame(parsed);
		if (validationError) {
			this.emit({ type: "error", error: new Error(`Frame validation failed: ${validationError.code}`) });
			return;
		}

		const envelope = parsed as RemoteHostFrameEnvelope;
		this.lastPongAt = Date.now();

		if (envelope.frame.type === "handshake_ack") {
			const validationError = validateRemoteHostHandshakeAck(envelope.frame);
			if (validationError) {
				this.teardownSocket();
				this.resolveConnect({ accepted: false, rejectReason: `malformed_ack${validationError.code}` });
				this.emit({ type: "handshake_rejected", reason: validationError.code });
				this.transition("unreachable", validationError.code);
				return;
			}
			this.handleHandshakeAck(envelope.frame as RemoteHostHandshakeAckFrame, gen);
			return;
		}

		if (envelope.frame.type === "health") {
			return;
		}

		// Persist received frame BEFORE the ack return so ACK state is recorded.
		const result = this.options.journal.recordReceived(envelope);

		if (envelope.frame.type === "ack") {
			return;
		}

		// ACK every durable application frame.
		if (
			envelope.frame.type === "event" ||
			envelope.frame.type === "command" ||
			envelope.frame.type === "agent_message" ||
			envelope.frame.type === "provider_proxy"
		) {
			const ackFrame: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId: randomUUID(),
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: nowISO(),
				frame: {
					type: "ack",
					ackId: randomUUID(),
					acknowledges: envelope.frameId,
					status: (result.isDuplicate ? "replayed" : "delivered") as "replayed" | "delivered",
				},
			};
			if (this.socket) {
				try {
					this.socket.send(JSON.stringify(ackFrame));
				} catch {
					this.teardownSocket();
					this.handleDisconnect();
				}
			}
		}

		if (result.isDuplicate) {
			return;
		}

		this.emit({
			type: "frame_received",
			envelope,
			isDuplicate: false,
		});
	}

	private handleHandshakeAck(ack: RemoteHostHandshakeAckFrame, gen: number): void {
		this.clearHandshakeTimer();

		if (this.generation !== gen) return;

		if (this._state.status !== "handshaking") {
			this.teardownSocket();
			return;
		}

		if (!ack.accepted) {
			this.teardownSocket();
			this.emit({ type: "handshake_rejected", reason: "remote_rejected" });
			this.resolveConnect({ accepted: false, rejectReason: "remote_rejected" });
			this.transition("unreachable", "remote_rejected");
			return;
		}

		if (ack.hostId !== this.options.expectedRemoteHostId) {
			this.teardownSocket();
			this.emit({ type: "handshake_rejected", reason: "remote_host_mismatch" });
			this.resolveConnect({ accepted: false, rejectReason: "remote_host_mismatch" });
			this.transition("unreachable", "remote_host_mismatch");
			return;
		}

		if (ack.sessionId !== this.options.expectedRemoteSessionId) {
			this.teardownSocket();
			this.emit({ type: "handshake_rejected", reason: "remote_session_mismatch" });
			this.resolveConnect({ accepted: false, rejectReason: "remote_session_mismatch" });
			this.transition("unreachable", "remote_session_mismatch");
			return;
		}

		if (!isRemoteHostProtocolCompatible(REMOTE_HOST_PROTOCOL_INFO, ack.protocol)) {
			this.teardownSocket();
			const reason = "protocol_incompatible";
			this.emit({ type: "handshake_rejected", reason });
			this.resolveConnect({ accepted: false, rejectReason: reason });
			this.transition("unreachable", reason);
			return;
		}

		const buildOk =
			ack.remoteBuildIdentity && isRemoteHostBuildCompatible(this.options.buildIdentity, ack.remoteBuildIdentity);
		if (!buildOk) {
			this.teardownSocket();
			const reason = "build_identity_mismatch";
			this.emit({ type: "handshake_rejected", reason });
			this.resolveConnect({ accepted: false, rejectReason: reason });
			this.transition("unreachable", reason);
			return;
		}

		this.connectedAt = nowISO();
		this.reconnectingSince = undefined;
		this._state = { status: "connected", linkId: ack.linkId };
		this.reconnectAttempt = 0;
		this.lastPongAt = Date.now();

		const replayOk = this.collectAndReplay(ack);
		if (!replayOk) {
			this.teardownSocket();
			const reason = "replay_resync_required";
			this.emit({ type: "replay_resync_required", reason });
			this.resolveConnect({ accepted: false, rejectReason: reason });
			this.transition("unreachable", reason);
			return;
		}

		this.startPing();

		this.resolveConnect({ accepted: true, linkId: ack.linkId });

		this.emit({
			type: "handshake_completed",
			linkId: ack.linkId,
			remoteCapabilities: ack.capabilities,
		});

		if (ack.cursor && ack.cursor.sequence > 0) {
			this.emit({ type: "recovered" });
		}
	}

	/**
	 * Replay unacknowledged sent entries (with original IDs) then paged
	 * event catch-up from cursor. Returns false if a resync is required
	 * (gap, unavailable, or page overflow).
	 */
	private collectAndReplay(ack: RemoteHostHandshakeAckFrame): boolean {
		this.replayAborted = false;
		const frames: Array<{ frameId: string; frame: RemoteHostFrame }> = [];
		const alreadySeen = new Set<string>();

		// 1. Collect unacknowledged durable sent entries (bounded by MAX_REPLAY_PAGES).
		const unacked = this.options.journal.getUnacknowledgedSentEntries();
		if (unacked.length > MAX_REPLAY_PAGES * 200) {
			return false;
		}
		for (const entry of unacked) {
			if (this.replayAborted) return false;
			alreadySeen.add(entry.frameId);
			frames.push({ frameId: entry.frameId, frame: entry.frame });
		}

		// 2. Collect event catch-up from cursor with pagination.
		const cursor = ack.cursor;
		if (!cursor) {
			if (!this.sendReplayFrames(frames)) {
				return false;
			}
			return true;
		}

		const seq = cursor.sequence > 0 ? cursor.sequence : 0;
		const replayCursor: RemoteHostEventCursor = {
			hostId: cursor.hostId,
			generation: cursor.generation,
			sessionId: cursor.sessionId,
			sequence: seq as RemoteHostEventSequence,
		};

		let afterSeq = seq;
		const pageLimit = 200;
		let retries = 0;
		let completed = false;

		while (retries < MAX_REPLAY_PAGES) {
			retries++;
			const replayResult = this.options.journal.getReplayEntries(replayCursor, pageLimit, "sent");
			if (replayResult.status === "unavailable") {
				return false;
			}
			if (replayResult.status === "partial" && replayResult.reason === "event_sequence_gap") {
				return false;
			}
			for (const entry of replayResult.entries) {
				if (this.replayAborted) return false;
				if (alreadySeen.has(entry.frameId)) continue;
				alreadySeen.add(entry.frameId);
				if (entry.eventSequence !== undefined && entry.eventSequence > afterSeq) {
					afterSeq = entry.eventSequence;
				}
				frames.push({ frameId: entry.frameId, frame: entry.frame });
			}
			if (replayResult.status === "complete") {
				completed = true;
				break;
			}
			replayCursor.sequence = afterSeq as RemoteHostEventSequence;
		}

		if (!completed) {
			return false;
		}

		// All frames validated and collected; now send them.
		if (!this.sendReplayFrames(frames)) {
			return false;
		}
		return true;
	}

	private sendReplayFrames(frames: Array<{ frameId: string; frame: RemoteHostFrame }>): boolean {
		if (!this.socket) return false;
		for (const { frameId, frame } of frames) {
			if (this.replayAborted) return false;
			const envelope: RemoteHostFrameEnvelope = {
				type: "frame",
				frameId,
				protocol: REMOTE_HOST_PROTOCOL_INFO,
				sentAt: nowISO(),
				frame,
			};
			try {
				this.socket.send(JSON.stringify(envelope));
			} catch {
				return false;
			}
		}
		return true;
	}

	private resolveConnect(result: ConnectResult): void {
		if (this.connectResolve) {
			this.connectResolve(result);
			this.connectResolve = undefined;
		}
		this.connectPromise = undefined;
	}

	private transition(status: RelayInternalState["status"], error?: string): void {
		switch (status) {
			case "idle":
				this._state = { status: "idle" };
				break;
			case "connecting":
				this._state = { status: "connecting", attempt: this.reconnectAttempt };
				break;
			case "handshaking":
				this._state = { status: "handshaking", attempt: this.reconnectAttempt };
				break;
			case "connected":
				this._state = { status: "connected", linkId: "" };
				this.connectedAt = nowISO();
				this.reconnectingSince = undefined;
				this.reconnectAttempt = 0;
				break;
			case "reconnecting":
				this._state = { status: "reconnecting", attempt: this.reconnectAttempt };
				this.reconnectingSince = nowISO();
				break;
			case "closed":
				this._state = { status: "closed" };
				break;
			case "unreachable":
				this._state = {
					status: "unreachable",
					error: error ?? "Unknown error",
					failedAt: nowISO(),
				};
				break;
		}
	}

	private teardownSocket(): void {
		if (this.socket) {
			try {
				this.socket.onopen = null;
				this.socket.onclose = null;
				this.socket.onerror = null;
				this.socket.onmessage = null;
				this.socket.close(1000);
			} catch {
				// Socket may already be closing
			}
			this.socket = undefined;
		}
	}

	private disconnectAndReconnect(): void {
		this.teardownSocket();
		this.clearPing();
		if (this._state.status !== "closed" && this._state.status !== "unreachable") {
			this.reconnectAborted = false;
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (this.reconnectAborted) return;
		if (this._state.status === "closed" || this._state.status === "unreachable") return;

		this.reconnectAttempt++;
		if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
			this.transition("unreachable", "Max reconnect attempts reached");
			return;
		}

		this.transition("reconnecting");
		const delay = jitteredBackoffMs(this.reconnectAttempt);

		this.reconnectTimer = setTimeout(() => {
			if (this.reconnectAborted) return;
			if (this._state.status === "closed" || this._state.status === "unreachable") return;
			this.connectPromise = undefined;
			this.startConnect().catch(() => {});
		}, delay);
	}

	private startPing(): void {
		this.clearPing();
		this.pingTimer = setInterval(() => {
			if (this._state.status !== "connected") {
				this.clearPing();
				return;
			}

			const elapsed = Date.now() - this.lastPongAt;
			if (elapsed > this.pongTimeoutMs) {
				this.teardownSocket();
				this.handleDisconnect();
				return;
			}

			if (this.socket && this.socket.readyState === 1) {
				const envelope: RemoteHostFrameEnvelope = {
					type: "frame",
					frameId: randomUUID(),
					protocol: REMOTE_HOST_PROTOCOL_INFO,
					sentAt: nowISO(),
					frame: {
						type: "health",
						healthSeq: ++this.healthSeqCounter,
						status: this.linkStatus,
					},
				};
				try {
					this.socket.send(JSON.stringify(envelope));
				} catch {
					this.teardownSocket();
					this.handleDisconnect();
				}
			}
		}, this.pingIntervalMs);
	}

	private clearPing(): void {
		if (this.pingTimer !== undefined) {
			clearInterval(this.pingTimer);
			this.pingTimer = undefined;
		}
	}

	private clearHandshakeTimer(): void {
		if (this.handshakeTimer !== undefined) {
			clearTimeout(this.handshakeTimer);
			this.handshakeTimer = undefined;
		}
	}

	private clearTimers(): void {
		this.clearPing();
		this.clearHandshakeTimer();
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
