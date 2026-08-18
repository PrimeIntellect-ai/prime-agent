import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { getDaemonLogPath } from "../../config.js";
import { attachJsonlLineReader, serializeJsonLine } from "../rpc/jsonl.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION,
	DAEMON_PROTOCOL_VERSION,
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonCommandCompatibility,
	type DaemonCommandEnvelope,
	type DaemonOutbound,
	type DaemonProtocolVersion,
	type DaemonRequestProgress,
	type DaemonResponse,
	type DaemonSavedSessionInfo,
	type DaemonServerCapability,
	getDaemonCommandCompatibilities,
	isDaemonMutatingCommand,
} from "./daemon-protocol.js";
import type { DaemonWorkerCommand, DaemonWorkerCommandBody } from "./daemon-worker-protocol.js";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DaemonCommandBody = DistributiveOmit<DaemonCommand, "id">;

type DaemonWireCommandBody = DaemonCommandBody | DaemonWorkerCommandBody;

export type DaemonHello = Extract<DaemonOutbound, { type: "daemon_hello" }>;

export type DaemonClientMessageListener = (message: DaemonOutbound) => void;
export type DaemonClientCloseListener = (error: Error) => void;
export type DaemonClientProgressListener = (message: DaemonRequestProgress) => void;

export interface DaemonClientRequestOptions {
	onProgress?: DaemonClientProgressListener;
}

interface PendingDaemonRequest {
	resolve: (response: DaemonResponse) => void;
	reject: (error: Error) => void;
	timeout?: ReturnType<typeof setTimeout>;
	timeoutMs: number;
	commandType: string;
	onProgress?: DaemonClientProgressListener;
	wireData: string;
	awaitingReconnect: boolean;
	acknowledgeResult: boolean;
	/** Re-checked against the new hello before a reconnect replay. */
	compatibilities: readonly DaemonCommandCompatibility[];
}

function daemonEndpointDetails(socketPath: string): string {
	return `Socket: ${socketPath}. Daemon log: ${getDaemonLogPath(socketPath)}.`;
}

export class DaemonSocketClosedError extends Error {
	constructor(
		socketPath: string,
		readonly daemonClosingReason?: DaemonClosingReason,
		cause?: string,
	) {
		const reasonDetails = daemonClosingReason ? ` Reason: ${daemonClosingReason}.` : "";
		const causeDetails = cause ? ` Cause: ${cause}.` : "";
		super(
			`Connection to the Prime Agent daemon closed.${reasonDetails}${causeDetails} ${daemonEndpointDetails(socketPath)}`,
		);
		this.name = "DaemonSocketClosedError";
	}
}

export class DaemonCapabilityUnavailableError extends Error {
	constructor(
		readonly command: DaemonCommand["type"],
		readonly capability: DaemonServerCapability | undefined,
		readonly afterReconnect = false,
	) {
		super(
			capability
				? `The running Prime Agent daemon does not support ${capability}.`
				: `The running Prime Agent daemon does not support ${command}.`,
		);
		this.name = "DaemonCapabilityUnavailableError";
	}
}

export function getDaemonSocketCloseReason(error: Error): DaemonClosingReason | undefined {
	return error instanceof DaemonSocketClosedError ? error.daemonClosingReason : undefined;
}

export type DaemonClientReconnectStatus =
	| { status: "reconnecting"; error: string }
	| { status: "connected" }
	| { status: "failed"; error: string };

export interface DaemonClientReconnectOptions {
	recoverDaemon: () => Promise<void>;
	timeoutMs?: number;
	onStatus?: (status: DaemonClientReconnectStatus) => void;
}

const DEFAULT_RECONNECT_TIMEOUT_MS = 60_000;
const RECONNECT_CONNECT_TIMEOUT_MS = 1000;
const RECONNECT_HELLO_TIMEOUT_MS = 3000;
const MAX_RECONNECT_DELAY_MS = 2000;

export class DaemonClient {
	private socket?: Socket;
	private detachReader?: () => void;
	private readonly listeners = new Set<DaemonClientMessageListener>();
	private readonly closeListeners = new Set<DaemonClientCloseListener>();
	private readonly pendingRequests = new Map<string, PendingDaemonRequest>();
	private requestId = 0;
	private readonly protocolClientId = `daemon-client:${randomUUID()}`;
	private requestRecoveryEnabled = false;
	private reconnectOptions?: DaemonClientReconnectOptions;
	private autoReconnectPromise?: Promise<void>;
	private closed = false;
	private helloMessage?: DaemonHello;
	private daemonClosingReason?: DaemonClosingReason;
	private reconnectPromise?: Promise<void>;
	private readonly helloWaiters = new Set<{
		resolve: (hello: DaemonHello) => void;
		reject: (error: Error) => void;
		timeout: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly socketPath: string) {}

	get hello(): DaemonHello | undefined {
		return this.helloMessage;
	}

	get isConnected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	supportsServerCapability(capability: DaemonServerCapability): boolean {
		return this.helloMessage?.serverCapabilities?.includes(capability) === true;
	}

	/** Wait for the daemon_hello greeting sent on connect. */
	async waitForHello(timeoutMs = 3000): Promise<DaemonHello> {
		if (this.helloMessage) {
			return this.helloMessage;
		}
		if (!this.socket || this.socket.destroyed) {
			throw new Error(
				`Cannot wait for the Prime Agent daemon handshake because the daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`,
			);
		}
		return new Promise<DaemonHello>((resolve, reject) => {
			const waiter = {
				resolve,
				reject,
				timeout: setTimeout(() => {
					this.helloWaiters.delete(waiter);
					reject(
						new Error(
							`Timed out after ${timeoutMs}ms waiting for the Prime Agent daemon handshake. ${daemonEndpointDetails(this.socketPath)}`,
						),
					);
				}, timeoutMs),
			};
			this.helloWaiters.add(waiter);
		});
	}

	async connect(timeoutMs = 3000): Promise<void> {
		if (this.socket) {
			throw new Error(`Prime Agent daemon client is already connected. ${daemonEndpointDetails(this.socketPath)}`);
		}
		this.helloMessage = undefined;
		this.daemonClosingReason = undefined;
		const socket = createConnection(this.socketPath);
		this.socket = socket;
		this.detachReader = attachJsonlLineReader(socket, (line) => this.handleLine(line));

		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => {
				cleanup();
				this.clearSocketReference(socket);
				socket.destroy();
				reject(
					new Error(
						`Timed out after ${timeoutMs}ms connecting to the Prime Agent daemon. ${daemonEndpointDetails(this.socketPath)}`,
					),
				);
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
				this.clearSocketReference(socket);
				reject(
					new Error(
						`Failed to connect to the Prime Agent daemon: ${error.message}. ${daemonEndpointDetails(this.socketPath)}`,
					),
				);
			};
			socket.once("connect", onConnect);
			socket.once("error", onError);
		});

		socket.on("error", (error) =>
			this.notifyClosed(
				socket,
				this.daemonClosingReason
					? new DaemonSocketClosedError(this.socketPath, this.daemonClosingReason, error.message)
					: error,
			),
		);
		socket.on("close", () =>
			this.notifyClosed(socket, new DaemonSocketClosedError(this.socketPath, this.daemonClosingReason)),
		);
	}

	async reconnect(timeoutMs = 3000): Promise<void> {
		if (this.reconnectPromise) {
			return this.reconnectPromise;
		}
		if (this.socket && !this.socket.destroyed) {
			return;
		}
		const reconnectPromise = this.connect(timeoutMs);
		this.reconnectPromise = reconnectPromise;
		try {
			await reconnectPromise;
		} finally {
			if (this.reconnectPromise === reconnectPromise) {
				this.reconnectPromise = undefined;
			}
		}
	}

	disconnectForReconnect(reason: DaemonClosingReason): void {
		const socket = this.socket;
		if (!socket || socket.destroyed) {
			return;
		}
		this.daemonClosingReason = reason;
		this.notifyClosed(socket, new DaemonSocketClosedError(this.socketPath, reason));
		socket.end();
		socket.destroy();
	}

	/** Discard a partially recovered transport so the next retry can reconnect cleanly. */
	resetTransportForReconnect(): void {
		const socket = this.socket;
		if (!socket) {
			return;
		}
		this.clearSocketReference(socket);
		this.rejectAll(
			new DaemonSocketClosedError(this.socketPath, undefined, "reconnect attempt did not complete"),
			this.requestRecoveryEnabled,
		);
		socket.destroy();
	}

	onMessage(listener: DaemonClientMessageListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	onClose(listener: DaemonClientCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => {
			this.closeListeners.delete(listener);
		};
	}

	/** Keep in-flight command promises alive and resend their stable envelopes after reconnect. */
	enableRequestRecovery(): void {
		this.requestRecoveryEnabled = true;
	}

	/** Reconnect a global/raw daemon client after supervisor replacement. */
	enableAutoReconnect(options: DaemonClientReconnectOptions): void {
		this.requestRecoveryEnabled = true;
		this.reconnectOptions = options;
	}

	async request(
		command: DaemonCommandBody,
		timeoutMs = 30000,
		options: DaemonClientRequestOptions = {},
	): Promise<DaemonResponse> {
		if (!this.socket || this.socket.destroyed) {
			throw new Error(
				`Cannot send daemon command "${command.type}" because the Prime Agent daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`,
			);
		}
		const hello = this.helloMessage ?? (await this.waitForHello());
		const compatibilities = getDaemonCommandCompatibilities(command);
		const missingCompatibility = compatibilities.find(
			(compatibility) => !this.meetsCommandCompatibility(hello, compatibility),
		);
		if (missingCompatibility) {
			throw new DaemonCapabilityUnavailableError(command.type, missingCompatibility.capability);
		}
		const envelopeProtocolVersion = Math.min(hello.protocol.version, DAEMON_PROTOCOL_VERSION);
		return this.requestWire(
			command,
			timeoutMs,
			options,
			envelopeProtocolVersion >= DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION ? envelopeProtocolVersion : undefined,
			compatibilities,
		);
	}

	private meetsCommandCompatibility(hello: DaemonHello, compatibility: DaemonCommandCompatibility): boolean {
		return (
			hello.protocol.version >= compatibility.minProtocol &&
			(compatibility.minSchemaRevision === undefined ||
				(hello.schemaRevision ?? 0) >= compatibility.minSchemaRevision) &&
			(compatibility.capability === undefined ||
				hello.serverCapabilities?.includes(compatibility.capability) === true)
		);
	}

	async authenticateWorker(token: string, timeoutMs = 3000): Promise<void> {
		const legacyAuthentication = { type: "worker_auth", token } as DaemonWorkerCommandBody;
		const response = await this.requestWire(legacyAuthentication, timeoutMs);
		if (!response.success) {
			throw new Error(response.error);
		}
	}

	async requestWorker(command: DaemonWorkerCommandBody, timeoutMs = 30000): Promise<DaemonResponse> {
		return this.requestWire(command, timeoutMs);
	}

	private async requestWire(
		command: DaemonWireCommandBody,
		timeoutMs: number,
		options: DaemonClientRequestOptions = {},
		publicEnvelopeProtocolVersion?: DaemonProtocolVersion,
		compatibilities: readonly DaemonCommandCompatibility[] = [],
	): Promise<DaemonResponse> {
		if (!this.socket || this.socket.destroyed) {
			throw new Error(
				`Cannot send daemon command "${command.type}" because the Prime Agent daemon is not connected. ${daemonEndpointDetails(this.socketPath)}`,
			);
		}

		const id = `daemon_${++this.requestId}`;
		const fullCommand = { ...command, id } as DaemonCommand | DaemonWorkerCommand;
		const wireCommand: DaemonCommand | DaemonWorkerCommand | DaemonCommandEnvelope = publicEnvelopeProtocolVersion
			? createDaemonCommandEnvelope(
					fullCommand as DaemonCommand,
					id,
					this.protocolClientId,
					publicEnvelopeProtocolVersion,
				)
			: fullCommand;
		const wireData = serializeJsonLine(wireCommand);
		const acknowledgeResult =
			publicEnvelopeProtocolVersion !== undefined && isDaemonMutatingCommand(fullCommand as DaemonCommand);

		return new Promise((resolve, reject) => {
			const pending: PendingDaemonRequest = {
				resolve,
				reject,
				timeoutMs,
				commandType: command.type,
				onProgress: options.onProgress,
				wireData,
				awaitingReconnect: false,
				acknowledgeResult,
				compatibilities,
			};
			this.pendingRequests.set(id, pending);
			this.armPendingRequestTimeout(id, pending);
			this.socket!.write(wireData);
		});
	}

	private armPendingRequestTimeout(id: string, pending: PendingDaemonRequest): void {
		pending.timeout = setTimeout(() => {
			this.pendingRequests.delete(id);
			pending.reject(
				new Error(
					`Timed out after ${pending.timeoutMs}ms waiting for the Prime Agent daemon response to "${pending.commandType}". ${daemonEndpointDetails(this.socketPath)}`,
				),
			);
		}, pending.timeoutMs);
	}

	close(): void {
		this.closed = true;
		this.reconnectOptions = undefined;
		this.detachReader?.();
		this.detachReader = undefined;
		this.rejectAll(
			new Error(
				`Prime Agent daemon client closed before the operation completed. ${daemonEndpointDetails(this.socketPath)}`,
			),
		);
		this.socket?.end();
		this.socket?.destroy();
		this.socket = undefined;
	}

	private clearSocketReference(socket: Socket): void {
		if (this.socket !== socket) {
			return;
		}
		this.detachReader?.();
		this.detachReader = undefined;
		this.socket = undefined;
	}

	private handleLine(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}

		if (isDaemonHello(message)) {
			this.helloMessage = message;
			for (const waiter of [...this.helloWaiters]) {
				clearTimeout(waiter.timeout);
				this.helloWaiters.delete(waiter);
				waiter.resolve(message);
			}
			if (this.socket && !this.socket.destroyed) {
				for (const [id, pending] of this.pendingRequests) {
					if (!pending.awaitingReconnect) {
						continue;
					}
					pending.awaitingReconnect = false;
					const missingCompatibility = pending.compatibilities.find(
						(compatibility) => !this.meetsCommandCompatibility(message, compatibility),
					);
					if (missingCompatibility) {
						this.pendingRequests.delete(id);
						pending.reject(
							new DaemonCapabilityUnavailableError(
								pending.commandType as DaemonCommand["type"],
								missingCompatibility.capability,
								true,
							),
						);
						continue;
					}
					this.armPendingRequestTimeout(id, pending);
					this.socket.write(pending.wireData);
				}
			}
		}
		if (isDaemonClosing(message)) {
			this.daemonClosingReason = message.reason;
		}

		if (isDaemonResponse(message) && message.id) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				if (pending.timeout) {
					clearTimeout(pending.timeout);
				}
				this.pendingRequests.delete(message.id);
				pending.resolve(message);
				if (pending.acknowledgeResult) {
					this.acknowledgeCommandResult(message.id);
				}
				return;
			}
		}
		if (isDaemonRequestProgress(message) && message.id) {
			const pending = this.pendingRequests.get(message.id);
			if (pending) {
				pending.onProgress?.(message);
				return;
			}
		}

		for (const listener of this.listeners) {
			try {
				listener(message as DaemonOutbound);
			} catch {
				// A consumer failure must not interrupt protocol parsing for other clients.
			}
		}
	}

	private acknowledgeCommandResult(commandId: string): void {
		const hello = this.helloMessage;
		if (
			!this.socket ||
			this.socket.destroyed ||
			!hello ||
			hello.protocol.version < DAEMON_COMMAND_ENVELOPE_MIN_PROTOCOL_VERSION
		) {
			return;
		}
		const id = `daemon_ack_${++this.requestId}`;
		const command: DaemonCommand = { id, type: "ack_result", commandId };
		const protocolVersion = Math.min(hello.protocol.version, DAEMON_PROTOCOL_VERSION);
		this.socket.write(
			serializeJsonLine(createDaemonCommandEnvelope(command, id, this.protocolClientId, protocolVersion)),
		);
	}

	private rejectAll(error: Error, preservePendingRequests = false): void {
		for (const [id, pending] of this.pendingRequests) {
			if (preservePendingRequests) {
				if (pending.timeout) {
					clearTimeout(pending.timeout);
					pending.timeout = undefined;
				}
				pending.awaitingReconnect = true;
				continue;
			}
			if (pending.timeout) {
				clearTimeout(pending.timeout);
			}
			pending.reject(error);
			this.pendingRequests.delete(id);
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
		this.clearSocketReference(socket);
		this.rejectAll(error, this.requestRecoveryEnabled);
		for (const listener of [...this.closeListeners]) {
			listener(error);
		}
		if (this.reconnectOptions && !this.closed) {
			void this.autoReconnect(error);
		}
	}

	private async autoReconnect(cause: Error): Promise<void> {
		if (this.autoReconnectPromise) {
			return this.autoReconnectPromise;
		}
		const options = this.reconnectOptions;
		if (!options || this.closed) {
			return;
		}
		this.emitReconnectStatus({ status: "reconnecting", error: cause.message });
		this.autoReconnectPromise = (async () => {
			const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_RECONNECT_TIMEOUT_MS);
			let attempt = 0;
			let lastError: Error = cause;
			while (!this.closed && this.reconnectOptions === options && Date.now() < deadline) {
				try {
					await options.recoverDaemon();
					if (this.closed || this.reconnectOptions !== options) {
						return;
					}
					await this.connect(RECONNECT_CONNECT_TIMEOUT_MS);
					await this.waitForHello(RECONNECT_HELLO_TIMEOUT_MS);
					this.emitReconnectStatus({ status: "connected" });
					return;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));
					this.resetTransportForReconnect();
					const remainingMs = deadline - Date.now();
					if (remainingMs <= 0) {
						break;
					}
					const delayMs = Math.min(remainingMs, MAX_RECONNECT_DELAY_MS, 100 * 2 ** Math.min(attempt, 5));
					attempt++;
					await delay(delayMs);
				}
			}
			if (this.closed || this.reconnectOptions !== options) {
				return;
			}
			const failure = new Error(`Daemon reconnection failed: ${lastError.message}`);
			this.rejectAll(failure);
			this.emitReconnectStatus({ status: "failed", error: failure.message });
			this.reconnectOptions = undefined;
		})().finally(() => {
			this.autoReconnectPromise = undefined;
		});
		return this.autoReconnectPromise;
	}

	private emitReconnectStatus(status: DaemonClientReconnectStatus): void {
		try {
			this.reconnectOptions?.onStatus?.(status);
		} catch {
			// UI status callbacks must never interrupt transport recovery.
		}
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isDaemonClosing(value: unknown): value is Extract<DaemonOutbound, { type: "daemon_closing" }> {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; reason?: unknown };
	return candidate.type === "daemon_closing" && (candidate.reason === "shutdown" || candidate.reason === "update");
}

function isDaemonHello(value: unknown): value is DaemonHello {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; protocol?: unknown };
	return candidate.type === "daemon_hello" && typeof candidate.protocol === "object" && candidate.protocol !== null;
}

function isDaemonResponse(value: unknown): value is DaemonResponse {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; success?: unknown; command?: unknown };
	return (
		candidate.type === "response" && typeof candidate.success === "boolean" && typeof candidate.command === "string"
	);
}

function isDaemonRequestProgress(value: unknown): value is DaemonRequestProgress {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as {
		type?: unknown;
		command?: unknown;
		id?: unknown;
		activeSessionId?: unknown;
		loaded?: unknown;
		total?: unknown;
		session?: unknown;
	};
	if (candidate.command !== "list_saved_sessions" || typeof candidate.id !== "string") {
		return false;
	}
	if (candidate.type === "session_list_progress") {
		return typeof candidate.loaded === "number" && typeof candidate.total === "number";
	}
	return candidate.type === "session_list_item" && isDaemonSavedSessionInfo(candidate.session);
}

function isDaemonSavedSessionInfo(value: unknown): value is DaemonSavedSessionInfo {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.id === "string" &&
		typeof candidate.cwd === "string" &&
		typeof candidate.created === "string" &&
		typeof candidate.modified === "string" &&
		typeof candidate.messageCount === "number" &&
		typeof candidate.firstMessage === "string" &&
		typeof candidate.allMessagesText === "string" &&
		(candidate.agentStatus === undefined || isDaemonSavedSessionAgentStatus(candidate.agentStatus))
	);
}

function isDaemonSavedSessionAgentStatus(value: unknown): boolean {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.summary === "string" &&
		typeof candidate.basedOnMessageCount === "number" &&
		(candidate.taskState === undefined ||
			candidate.taskState === "needs_input" ||
			candidate.taskState === "completed")
	);
}
