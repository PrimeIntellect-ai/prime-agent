import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer as createNetServer, type Server, type Socket } from "node:net";
import { CloudCommandJournal } from "../../core/cloud/command-journal.js";
import { type CloudEventInput, DurableCloudEventOutbox } from "../../core/cloud/event-outbox.js";
import {
	CLOUD_MAX_MESSAGE_BYTES,
	CLOUD_MAX_QUEUED_COMMANDS,
	CLOUD_MAX_SNAPSHOT_EVENTS,
	CLOUD_PROTOCOL_VERSION,
	type CloudCommandId,
	type CloudCommandReceipt,
	type CloudCommandRequest,
	type CloudCursor,
	type CloudEvent,
	type CloudMessage,
	type CloudSessionId,
	type CloudSessionState,
	type CloudSessionStatus,
	canonicalJson,
	cloudEventProblem,
	cloudMessageProblem,
	cloudRequestJsonProblem,
	cloudRequestProblem,
	newCloudClientId,
	serializeCloudMessage,
} from "../../core/cloud/protocol.js";

/**
 * Server for the resident cloud session protocol (prime-agent.cloud v2).
 *
 * The guest daemon serves this on a VM-local 0700 unix socket; the uploaded
 * bridge is a byte pump between that socket and the tunnel WebSocket. The
 * server owns the durability contract end to end:
 *
 * - every event is appended to the durable outbox (fsync) before it is pushed;
 * - every submit is admitted through the command journal (fsync) with the
 *   canonical digest, so retries deduplicate and a crash never re-executes
 *   uncertain work;
 * - hello fences stale generations and requires the bridge token;
 * - replay comes from the acked-cursor position, never from a memory window.
 *
 * The daemon is stateless about transport: clients come and go, the outbox and
 * journal stay.
 */

export interface CloudProtocolDispatchResult {
	state: "completed" | "failed" | "cancelled";
	error?: string;
}

export interface CloudProtocolServerCallbacks {
	/** The pre-allocated cloud session id this daemon hosts. */
	sessionId(): CloudSessionId;
	/**
	 * The sandbox generation (one sandbox incarnation); fences stale
	 * attachments at hello. The event-log (outbox) generation is separate:
	 * retention may bump it without fencing anyone off.
	 */
	generation(): number;
	/** The bridge protocol token; compared timing-safely against hello. */
	protocolToken(): string;
	/** The guest session status for snapshots. */
	status(): CloudSessionStatus;
	/** The guest session state for snapshots. */
	snapshotState(): CloudSessionState;
	/**
	 * Execute one claimed command. Resolves with the command's terminal state;
	 * never throws (failures come back as state "failed" with an error).
	 */
	dispatch(request: CloudCommandRequest, commandId: CloudCommandId): Promise<CloudProtocolDispatchResult>;
	/** The outbox event was appended (e.g. retention bookkeeping). */
	onEventAppended?(event: CloudEvent): void;
	/**
	 * The durable log is full and nothing is acknowledged: mirroring stalls
	 * honestly instead of crash-looping. Surfaces in the daemon's status
	 * record; the next successful append clears the stall.
	 */
	onRetentionStalled?(): void;
	/** The stall recovered after acknowledgement freed retention space. */
	onRetentionRecovered?(): void;
	/** Non-fatal dispatch/settlement error, recorded for honest diagnostics. */
	onDispatchError?(message: string): void;
}

interface ClientConnection {
	id: string;
	socket: Socket;
	authenticated: boolean;
	subscribed: boolean;
	closed: boolean;
	lastSentSequence: number;
	/** Raw bytes; a line decodes only once its \n byte arrived, so a multibyte UTF-8 sequence split across TCP chunks stays intact. */
	received: Buffer;
	/** Unauthenticated connections are dropped on a deadline like the bridge. */
	helloTimer?: NodeJS.Timeout;
}

const HELLO_TIMEOUT_MS = 15_000;

const MAX_CLIENTS = 4;
const MAX_BATCH_BYTES = 524_288;
/** Bound on bytes buffered without a newline across all framed clients. */
const MAX_UNFRAMED_BUFFER_BYTES = CLOUD_MAX_MESSAGE_BYTES * 2;

export interface CloudProtocolServerOptions {
	/** Unix socket path; parent directory must exist. 0700 file mode enforced. */
	socketPath: string;
	/** Durable state directory for the journal and outbox (one per session). */
	stateDirectory: string;
	sessionId: string;
	generation: number;
	callbacks: CloudProtocolServerCallbacks;
	/** Optional test seam for the outbox bounds. */
	maxOutboxRecords?: number;
}

export class CloudProtocolServer {
	private server?: Server;
	private readonly clients = new Map<string, ClientConnection>();
	private readonly journal: CloudCommandJournal;
	private readonly outbox: DurableCloudEventOutbox;
	private stopping = false;
	private stalled = false;

	constructor(private readonly options: CloudProtocolServerOptions) {
		this.journal = new CloudCommandJournal(`${options.stateDirectory}/command-journal.ndjson`);
		this.outbox = new DurableCloudEventOutbox({
			directory: `${options.stateDirectory}/event-outbox`,
			sessionId: options.sessionId,
			maxRecords: options.maxOutboxRecords ?? 50_000,
		});
	}

	get socketPath(): string {
		return this.options.socketPath;
	}

	/** Terminal receipts restored without a settle record; surfaced honestly. */
	listUncertainCommands(): CloudCommandReceipt[] {
		return this.journal.listUncertain();
	}

	/** Ids of admitted commands the dispatcher has not claimed yet. */
	listPendingCommandIds(): readonly CloudCommandId[] {
		return this.journal.listPending().map((receipt) => receipt.commandId);
	}

	/** Admit-then-claim loop: claims are sequential, the dispatched work is not. */
	async start(): Promise<void> {
		const socketPath = this.options.socketPath;
		// A hard-killed daemon leaves its socket file behind; remove the stale
		// inode before listening or the restart wedges on EADDRINUSE forever.
		if (existsSync(socketPath)) {
			try {
				unlinkSync(socketPath);
			} catch {
				// The path is about to be replaced by listen(); a failure here
				// surfaces through the listen error below.
			}
		}
		await new Promise<void>((resolve, reject) => {
			this.server = createNetServer((socket) => this.acceptConnection(socket));
			this.server.once("error", reject);
			this.server.listen(socketPath, () => {
				this.server?.removeListener("error", reject);
				resolve();
			});
		});
		// 0700: only the same VM user (the bridge) can reach the guest sessions.
		chmodSync(socketPath, 0o700);
		void this.dispatchLoop();
	}

	async stop(): Promise<void> {
		this.stopping = true;
		for (const client of this.clients.values()) {
			// The stopping status is durable in the outbox; a reconnecting
			// client sees it in replay. Nothing is promised to a live socket.
			client.socket.destroy();
		}
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
		});
	}

	/** Append one event to the durable log and push it to subscribers. */
	appendEvent(input: CloudEventInput): CloudEvent | undefined {
		// Invalid events never enter the durable log: one bad field would
		// otherwise poison every replay frame that carries it.
		const problem = cloudEventProblem({ sequence: this.outbox.tailCursor.sequence + 1, ...input }, "event");
		if (problem !== undefined) {
			this.options.callbacks.onDispatchError?.(`dropping invalid cloud event: ${problem}`);
			return undefined;
		}
		let envelope: ReturnType<DurableCloudEventOutbox["append"]> | undefined;
		try {
			envelope = this.outbox.append(input);
		} catch (error) {
			// The durable log hit its record bound. Retention is a settled
			// protocol, never a crash loop: acknowledged history is trimmed
			// (the outbox generation bumps, and a client holding a pre-bump
			// cursor resyncs from the snapshot), and a full log with nothing
			// acknowledged stalls the mirror honestly - the session keeps
			// running and the status record reports the stall until an ack
			// frees space.
			if (!this.isRecordBound(error)) {
				throw error;
			}
			this.trimAcknowledgedHistory();
			try {
				envelope = this.outbox.append(input);
			} catch (retryError) {
				if (!this.isRecordBound(retryError)) throw retryError;
				this.markStalled();
				return undefined;
			}
		}
		if (this.stalled) {
			this.stalled = false;
			this.options.callbacks.onRetentionRecovered?.();
		}
		this.options.callbacks.onEventAppended?.(envelope.event);
		for (const client of this.clients.values()) {
			if (!client.subscribed || !client.authenticated) continue;
			try {
				this.sendDue(client);
			} catch {
				// One client's stale position never loses the durable append;
				// resync it and keep the rest of the fan-out alive.
				client.subscribed = false;
				this.resyncClient(client, "push");
			}
		}
		return envelope.event;
	}

	private isRecordBound(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return message.includes("reached");
	}

	private trimAcknowledgedHistory(): void {
		try {
			this.outbox.trimAcknowledged();
		} catch {
			// Corruption here is outbox-owned and fatal there; the retention
			// path only guarantees no crash loop on a full log.
		}
	}

	private markStalled(): void {
		if (this.stalled) return;
		this.stalled = true;
		this.options.callbacks.onRetentionStalled?.();
	}

	/** True while the durable log is full with nothing acknowledged. */
	get retentionStalled(): boolean {
		return this.stalled;
	}

	/** Current event-log generation (may have been bumped by retention). */
	currentGeneration(): number {
		return this.outbox.generation;
	}

	/** The guest's durable event tail. */
	tailCursor(): CloudCursor {
		return this.outbox.tailCursor;
	}

	// --- connections ---------------------------------------------------------------

	private acceptConnection(socket: Socket): void {
		if (this.clients.size >= MAX_CLIENTS) {
			socket.destroy();
			return;
		}
		const client: ClientConnection = {
			id: newCloudClientId(),
			socket,
			authenticated: false,
			subscribed: false,
			closed: false,
			lastSentSequence: 0,
			received: Buffer.alloc(0),
			helloTimer: setTimeout(() => {
				if (!client.authenticated) this.dropClient(client);
			}, HELLO_TIMEOUT_MS),
		};
		this.clients.set(client.id, client);
		socket.setNoDelay(true);
		socket.on("data", (chunk: Buffer) => this.onClientData(client, chunk));
		socket.on("error", () => this.dropClient(client));
		socket.on("close", () => this.dropClient(client));
	}

	private dropClient(client: ClientConnection): void {
		if (client.closed) return;
		client.closed = true;
		if (client.helloTimer !== undefined) {
			clearTimeout(client.helloTimer);
			client.helloTimer = undefined;
		}
		this.clients.delete(client.id);
		try {
			client.socket.destroy();
		} catch {
			// The socket is already gone.
		}
	}

	private onClientData(client: ClientConnection, chunk: Buffer): void {
		if (client.closed) return;
		client.received = Buffer.concat([client.received, chunk]);
		// An unbounded line is a memory-exhaustion vector: a pre-auth client
		// that never sends a newline is dropped once it exceeds one frame.
		if (!client.authenticated && client.received.byteLength > CLOUD_MAX_MESSAGE_BYTES) {
			this.dropClient(client);
			return;
		}
		if (client.received.byteLength > MAX_UNFRAMED_BUFFER_BYTES) {
			this.dropClient(client);
			return;
		}
		for (;;) {
			const newline = client.received.indexOf(0x0a);
			if (newline < 0) break;
			// The line is complete on a byte boundary: decode it in full, so a
			// multibyte UTF-8 sequence split across TCP chunks stays intact.
			const line = client.received.subarray(0, newline).toString("utf8").trim();
			client.received = client.received.subarray(newline + 1);
			if (line.length === 0) continue;
			if (Buffer.byteLength(line, "utf8") > CLOUD_MAX_MESSAGE_BYTES) {
				this.dropClient(client);
				return;
			}
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				this.dropClient(client);
				return;
			}
			const problem = cloudMessageProblem(value);
			if (problem !== undefined) {
				this.dropClient(client);
				return;
			}
			this.handleMessage(client, value as CloudMessage);
		}
	}

	private handleMessage(client: ClientConnection, message: CloudMessage): void {
		switch (message.type) {
			case "hello":
				this.handleHello(client, message);
				return;
			case "subscribe":
				this.handleSubscribe(client, message);
				return;
			case "submit":
				this.handleSubmit(client, message);
				return;
			case "get_command":
				this.handleGetCommand(client, message);
				return;
			case "ack":
				this.handleAck(client, message);
				return;
			default:
				// The server never receives snapshot/events/command.
				this.dropClient(client);
		}
	}

	private handleHello(client: ClientConnection, hello: Extract<CloudMessage, { type: "hello" }>): void {
		const expected = this.options.callbacks;
		if (hello.protocolVersion !== CLOUD_PROTOCOL_VERSION) {
			this.dropClient(client);
			return;
		}
		// The hello fences on the SANDBOX generation: one sandbox incarnation.
		// Retention may have bumped the event-log generation since, which must
		// never wedge a reconnecting attachment.
		if (hello.sessionId !== expected.sessionId() || hello.generation !== this.options.generation) {
			this.dropClient(client);
			return;
		}
		const token = Buffer.from(String(hello.authToken ?? ""), "utf8");
		const expectedToken = Buffer.from(expected.protocolToken(), "utf8");
		if (token.byteLength !== expectedToken.byteLength || !timingSafeEqual(token, expectedToken)) {
			this.dropClient(client);
			return;
		}
		client.authenticated = true;
		if (client.helloTimer !== undefined) {
			clearTimeout(client.helloTimer);
			client.helloTimer = undefined;
		}
		client.subscribed = false;
		client.lastSentSequence = this.outbox.tailCursor.sequence;
		// A cursor from the client's last observed position resumes replay when
		// it still names this event-log generation; anything older resnapshots.
		if (hello.cursor !== undefined) {
			if (hello.cursor.generation === this.currentGeneration()) {
				client.lastSentSequence = Math.min(hello.cursor.sequence, client.lastSentSequence);
			} else {
				client.lastSentSequence = 0;
			}
		}
		this.resyncClient(client, "hello");
	}

	private handleSubscribe(client: ClientConnection, message: Extract<CloudMessage, { type: "subscribe" }>): void {
		if (!client.authenticated) {
			this.dropClient(client);
			return;
		}
		const cursor = message.cursor;
		if (cursor.sequence > this.outbox.tailCursor.sequence) {
			this.dropClient(client);
			return;
		}
		// A cursor from a previous event-log generation (retention trimmed and
		// renumbered) resnapshots instead of wedging: the snapshot carries the
		// new cursor and live delivery continues from it.
		if (cursor.generation !== this.currentGeneration()) {
			client.subscribed = false;
			this.resyncClient(client, "subscribe epoch");
			return;
		}
		client.lastSentSequence = cursor.sequence;
		client.subscribed = true;
		try {
			this.sendDue(client);
		} catch {
			// The retained window moved past the cursor: resnapshot.
			client.subscribed = false;
			this.resyncClient(client, "subscribe replay");
		}
	}

	private handleSubmit(client: ClientConnection, message: Extract<CloudMessage, { type: "submit" }>): void {
		if (!client.authenticated) {
			this.dropClient(client);
			return;
		}
		// Submits fence on the sandbox generation like hello; the event-log
		// generation never gates control traffic.
		if (message.generation !== this.options.generation) {
			this.dropClient(client);
			return;
		}
		const requestProblem = cloudRequestProblem(message.request);
		if (requestProblem === undefined) {
			// The byte bound is part of admission: a request that fits every
			// field but exceeds the frame budget never reaches the journal.
			const boundProblem = cloudRequestJsonProblem(message.request);
			if (boundProblem !== undefined) {
				this.dropClient(client);
				return;
			}
		}
		if (requestProblem !== undefined) {
			this.dropClient(client);
			return;
		}
		const admitted = this.journal.admit(message.commandId, message.request);
		if (admitted.status === "conflict") {
			this.dropClient(client);
			return;
		}
		if (admitted.status === "new") {
			this.appendEvent({
				kind: "command_accepted",
				recordedAt: new Date().toISOString(),
				receipt: admitted.receipt,
			});
			if (this.journal.listPending().length > CLOUD_MAX_QUEUED_COMMANDS) {
				// The durable admission stays honest: the receipt fails rather
				// than silently wedging behind an unbounded queue.
				this.journal.fail(message.commandId, "guest command queue is full");
			}
		}
		this.writeLine(client, serializeCloudMessage(this.commandFrame(admitted.receipt)));
		this.appendEvent({
			kind: "command_state",
			recordedAt: new Date().toISOString(),
			receipt: this.journal.getReceipt(message.commandId) ?? admitted.receipt,
		});
	}

	private handleGetCommand(client: ClientConnection, message: Extract<CloudMessage, { type: "get_command" }>): void {
		if (
			!client.authenticated ||
			message.generation !== this.options.generation ||
			message.claim === true ||
			message.commandId === undefined
		) {
			this.dropClient(client);
			return;
		}
		const receipt = this.journal.getReceipt(message.commandId);
		if (receipt === undefined) {
			this.dropClient(client);
			return;
		}
		this.writeLine(client, serializeCloudMessage(this.commandFrame(receipt)));
	}

	private handleAck(client: ClientConnection, message: Extract<CloudMessage, { type: "ack" }>): void {
		if (!client.authenticated) {
			this.dropClient(client);
			return;
		}
		if (message.cursor.generation !== this.currentGeneration()) {
			// A stale-generation ack names positions that retention already
			// renumbered; it is meaningless, not a violation. Ignore it so an
			// in-flight client survives a trim.
			return;
		}
		try {
			this.outbox.ack(message.cursor);
		} catch {
			this.dropClient(client);
		}
	}

	private commandFrame(receipt: CloudCommandReceipt): CloudMessage {
		return {
			type: "command",
			sessionId: this.options.sessionId,
			generation: this.currentGeneration(),
			receipt,
		};
	}

	/**
	 * Serve one client's resync snapshot, isolating its serialization or
	 * send failure: the error is reported for honest diagnostics and this
	 * client is dropped - never the daemon crashed or every other
	 * subscriber's delivery lost. The client reconnects and resyncs from
	 * its own cursor.
	 */
	private resyncClient(client: ClientConnection, stage: string): void {
		try {
			this.sendSnapshot(client);
		} catch (error) {
			this.options.callbacks.onDispatchError?.(
				`client ${stage} resync failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			this.dropClient(client);
		}
	}

	private sendSnapshot(client: ClientConnection): void {
		const tail = this.outbox.tailCursor.sequence;
		// A pre-trim cursor beyond the renumbered tail names nothing in this
		// epoch: serve the full new log (from zero) instead of clamping to the
		// tail, or the resync would silently skip the renumbered head.
		const from = client.lastSentSequence > tail ? 0 : Math.min(client.lastSentSequence, tail);
		const events: CloudEvent[] = [];
		// The cursor names only what this snapshot actually carries: a backlog
		// larger than one bounded page parks the client at the page boundary,
		// and the subscribe after it drains the remaining pages before the
		// client is current. Reporting the tail here would let a client
		// persist and acknowledge events it never received - and the frame
		// would not even serialize, because the wire requires the cursor to
		// match the last included event.
		let includedThrough = from;
		if (tail > from) {
			const due = this.outbox.eventsAfter({ generation: this.currentGeneration(), sequence: from });
			let bytes = 0;
			for (const envelope of due.slice(0, CLOUD_MAX_SNAPSHOT_EVENTS)) {
				// The wire bound is UTF-8 bytes, not JavaScript characters: a
				// CJK payload is three bytes per character, so counting
				// characters would pack several-megabyte frames that cannot
				// serialize.
				const size = Buffer.byteLength(canonicalJson(envelope.event), "utf8") + 1;
				if (events.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
				events.push(envelope.event);
				bytes += size;
				includedThrough = envelope.event.sequence;
			}
		}
		const message: CloudMessage = {
			type: "snapshot",
			sessionId: this.options.sessionId,
			generation: this.currentGeneration(),
			cursor: { generation: this.currentGeneration(), sequence: includedThrough },
			status: this.options.callbacks.status(),
			state: this.options.callbacks.snapshotState(),
			events,
			capabilities: [
				"event_stream",
				"command_receipts",
				"session_entries",
				"session_events",
				"roster_stream",
				"family_messages",
				"extension_ui",
				"artifact_refs",
			],
		};
		client.lastSentSequence = includedThrough;
		client.subscribed = false;
		this.writeLine(client, serializeCloudMessage(message));
	}

	private sendDue(client: ClientConnection): void {
		if (client.lastSentSequence > this.outbox.tailCursor.sequence) {
			// Retention renumbered the log past this client's cursor: resync
			// from a snapshot instead of throwing on the stale position.
			client.subscribed = false;
			this.resyncClient(client, "retention");
			return;
		}
		// Paged catch-up: each page is bounded by CLOUD_MAX_SNAPSHOT_EVENTS
		// and MAX_BATCH_BYTES, and the loop ends only at the true tail, so a
		// backlog larger than one page drains in this pass instead of
		// stalling until the next append pushes another page.
		for (;;) {
			const due = this.outbox.eventsAfter(
				{ generation: this.currentGeneration(), sequence: client.lastSentSequence },
				CLOUD_MAX_SNAPSHOT_EVENTS,
			);
			if (due.length === 0) break;
			const batch: CloudEvent[] = [];
			let bytes = 0;
			for (const envelope of due) {
				// Byte-counted like sendSnapshot: a frame of CJK deltas is
				// three times its JavaScript length on the wire.
				const size = Buffer.byteLength(canonicalJson(envelope.event), "utf8") + 1;
				if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
				batch.push(envelope.event);
				bytes += size;
			}
			this.writeLine(
				client,
				serializeCloudMessage({
					type: "events",
					sessionId: this.options.sessionId,
					generation: this.currentGeneration(),
					events: batch,
				}),
			);
			client.lastSentSequence = batch[batch.length - 1]?.sequence ?? client.lastSentSequence;
			if (client.lastSentSequence >= this.outbox.tailCursor.sequence) break;
		}
	}

	private writeLine(client: ClientConnection, line: string): void {
		if (client.closed) return;
		client.socket.write(`${line}\n`);
	}

	// --- command dispatch ------------------------------------------------------------

	private async dispatchLoop(): Promise<void> {
		// Restored uncertain commands are never replayed automatically; their
		// receipts surface `uncertain` so the local side reports honestly.
		for (;;) {
			if (this.stopping) return;
			try {
				const claimed = this.journal.claimNextPending();
				if (claimed === undefined) {
					await new Promise((resolve) => setTimeout(resolve, 20));
					continue;
				}
				const commandId = claimed.receipt.commandId;
				this.appendEvent({
					kind: "command_state",
					recordedAt: new Date().toISOString(),
					receipt: claimed.receipt,
				});
				const request = parseRequest(claimed.request);
				if (request === undefined) {
					this.settleCommand(commandId, {
						state: "failed",
						error: "command request failed canonical parse",
					});
					continue;
				}
				// Abort settles the run, not itself: it must bypass the queue so a
				// wedged long command cannot trap it behind itself.
				if (request.kind === "abort") {
					void this.executeCommand(commandId, request).catch(() => undefined);
					continue;
				}
				await this.executeCommand(commandId, request);
			} catch (error) {
				// One corrupt record or a stalled log must never kill command
				// supervision; the loop reports and continues.
				const message = error instanceof Error ? error.message : String(error);
				this.options.callbacks.onDispatchError?.(message);
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		}
	}

	private async executeCommand(commandId: CloudCommandId, request: CloudCommandRequest): Promise<void> {
		let outcome: CloudProtocolDispatchResult;
		try {
			outcome = await this.options.callbacks.dispatch(request, commandId);
		} catch (error) {
			outcome = {
				state: "failed",
				error: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
			};
		}
		this.settleCommand(commandId, outcome);
	}

	private settleCommand(commandId: CloudCommandId, outcome: CloudProtocolDispatchResult): void {
		let receipt: CloudCommandReceipt | undefined;
		try {
			if (outcome.state === "completed") {
				this.journal.complete(commandId);
			} else if (outcome.state === "failed") {
				this.journal.fail(commandId, outcome.error ?? "command failed");
			} else {
				this.journal.cancel(commandId);
			}
			receipt = this.journal.getReceipt(commandId);
		} catch (error) {
			// A settle that cannot journal (corruption, restart race) stays
			// visible: the receipt keeps its pre-settle state and the honest
			// uncertain path still reports it after a restore.
			this.options.callbacks.onDispatchError?.(
				`settling ${commandId} failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (receipt !== undefined) {
			this.appendEvent({
				kind: "command_state",
				recordedAt: new Date().toISOString(),
				receipt,
			});
		}
	}
}

function parseRequest(canonical: string): CloudCommandRequest | undefined {
	const problem = cloudRequestProblem(JSON.parse(canonical));
	if (problem !== undefined) return undefined;
	return JSON.parse(canonical) as CloudCommandRequest;
}
