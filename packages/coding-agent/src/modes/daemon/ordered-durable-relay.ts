import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { encodeJournalRecordV1, type JournalRecordV1 } from "./b03-journal-record-codec.js";
import {
	type DurableFrameState,
	type DurableJournalEntry,
	type DurableReceipt,
	DurableRelayStore,
	type DurableRelayStoreResult,
	type DurableReplayPage,
} from "./durable-relay-store.js";
import type { RemoteHostAckFrame, RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { canonicalDigest, decodeEnvelope } from "./remote-host-frame-codec.js";

const INPUT_KEYS = new Set(["application", "identity", "incomingStore", "outgoingStore", "transport"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const TRANSPORT_KEYS = new Set(["close", "send"]);
const APPLICATION_KEYS = new Set(["apply", "close"]);
const STATUS_KEYS = new Set(["status"]);
const SEND_TIMEOUT_MS = 30_000;
const APPLY_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;
const QUERY_MAX_PAGES = 128;
const QUERY_MAX_RECORDS = 8_192;

export type OrderedRelayErrorCode =
	| "APPLICATION_FAILED"
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "EVIDENCE_CONFLICT"
	| "INVALID_ARGUMENT"
	| "PERSISTENCE_FAILED"
	| "POISONED"
	| "REENTRANT_CALL"
	| "TRANSPORT_UNCERTAIN";

export type OrderedRelayFailure = Readonly<{
	readonly ok: false;
	readonly error: Readonly<{ code: OrderedRelayErrorCode }>;
}>;

export type OrderedRelayResult<T> = Readonly<{ ok: true; value: T }> | OrderedRelayFailure;

export type OrderedRelayReceiveAction =
	| "applied"
	| "applied_and_acknowledged"
	| "acknowledged_outbound"
	| "replayed"
	| "replayed_ack";

export interface OrderedRelayReceiveResult {
	readonly action: OrderedRelayReceiveAction;
	readonly frameId: string;
	readonly acknowledgment: RemoteHostFrameEnvelope | null;
}

export interface OrderedRelaySendResult {
	readonly frameId: string;
	readonly replay: boolean;
	readonly journalReceipt: DurableReceipt;
}

export interface OutgoingAcknowledgmentEvidence {
	readonly frameId: string;
	readonly outgoingJournalReceipt: DurableReceipt;
	readonly ackEnvelopeId: string;
	readonly ackEnvelopeDigest: string;
}

export interface OrderedRelayReplayResult {
	readonly sent: number;
	readonly nextCursor: number | null;
}

export type CreateOrderedDurableRelayResult =
	| Readonly<{ ok: true; relay: OrderedDurableRelay }>
	| Readonly<{ ok: false; error: Readonly<{ code: OrderedRelayErrorCode }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type OwnedClose = () => Promise<boolean>;

type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

interface TransportCapability {
	readonly send: BoundMethod;
	readonly close: OwnedClose;
}

interface ApplicationCapability {
	readonly apply: BoundMethod;
	readonly close: OwnedClose;
}

interface BoundStore {
	readonly raw: DurableRelayStore;
	readonly status: NonNullable<ReturnType<typeof readStoreStatus>>;
	readonly publish: (raw: unknown) => Promise<DurableRelayStoreResult<unknown>>;
	readonly markPending: (raw: unknown) => Promise<DurableRelayStoreResult<unknown>>;
	readonly markDelivered: (raw: unknown) => Promise<DurableRelayStoreResult<unknown>>;
	readonly query: (frameId: unknown) => Promise<DurableRelayStoreResult<DurableFrameState>>;
	readonly replayJournals: (raw: unknown) => Promise<DurableRelayStoreResult<DurableReplayPage<DurableJournalEntry>>>;
	readonly close: OwnedClose;
}

function failure(code: OrderedRelayErrorCode): OrderedRelayFailure {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function success<T>(value: T): OrderedRelayResult<T> {
	return Object.freeze({ ok: true as const, value });
}

function rawDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const descriptors = rawDescriptors(raw);
	if (!descriptors) return null;
	const names = Object.getOwnPropertyNames(descriptors);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return descriptors;
}

function bind(raw: object, descriptor: PropertyDescriptor): BoundMethod | null {
	if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
	try {
		if (types.isProxy(descriptor.value)) return null;
		const callable = descriptor.value as CallableFunction;
		return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
	} catch {
		return null;
	}
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observePromise(raw: unknown, timeoutMs: number): Promise<Observed> {
	if (!isNativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value }));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "rejected" as const }));
				},
			]);
		} catch {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function invoke(call: () => unknown, timeoutMs: number): Promise<Observed> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
	return observePromise(raw, timeoutMs);
}

function ownedClose(raw: unknown, expectedKeys: ReadonlySet<string>): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (!descriptor) return null;
		const close = bind(raw, descriptor);
		if (!close) return null;
		let used = false;
		return async (): Promise<boolean> => {
			if (used) return false;
			used = true;
			const observed = await invoke(() => close(), CLOSE_TIMEOUT_MS);
			if (observed.status !== "fulfilled") return false;
			const result = exact(observed.value, expectedKeys);
			return result?.status?.value === "closed";
		};
	} catch {
		return null;
	}
}

function storeClose(raw: unknown): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== DurableRelayStore.prototype) return null;
		let used = false;
		return async (): Promise<boolean> => {
			if (used) return false;
			used = true;
			let result: DurableRelayStoreResult<void>;
			try {
				result = await Reflect.apply(DurableRelayStore.prototype.close, raw, []);
			} catch {
				return false;
			}
			return result.ok;
		};
	} catch {
		return null;
	}
}

function readStoreStatus(raw: DurableRelayStore): Readonly<{
	identity: Readonly<{ hostId: string; generation: string; sessionId: string }>;
	direction: "sent" | "received";
}> | null {
	try {
		const status = Reflect.get(DurableRelayStore.prototype, "status", raw) as unknown;
		const descriptors = rawDescriptors(status);
		const identity = snapshotIdentity(descriptors?.identity?.value);
		const direction = descriptors?.direction?.value;
		if (!identity || (direction !== "sent" && direction !== "received")) return null;
		return Object.freeze({ identity, direction });
	} catch {
		return null;
	}
}

function bindStore(raw: unknown, close: OwnedClose): BoundStore | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== DurableRelayStore.prototype) return null;
		const status = readStoreStatus(raw as DurableRelayStore);
		if (!status) return null;
		return Object.freeze({
			raw: raw as DurableRelayStore,
			status,
			publish: (value: unknown) => Reflect.apply(DurableRelayStore.prototype.publish, raw, [value]),
			markPending: (value: unknown) => Reflect.apply(DurableRelayStore.prototype.markPending, raw, [value]),
			markDelivered: (value: unknown) => Reflect.apply(DurableRelayStore.prototype.markDelivered, raw, [value]),
			query: (frameId: unknown) => Reflect.apply(DurableRelayStore.prototype.query, raw, [frameId]),
			replayJournals: (value: unknown) => Reflect.apply(DurableRelayStore.prototype.replayJournals, raw, [value]),
			close,
		});
	} catch {
		return null;
	}
}

async function closeAll(closes: readonly OwnedClose[]): Promise<boolean> {
	const results = await Promise.all([...new Set(closes)].map((close) => close()));
	return results.every((closed) => closed);
}

function snapshotTransport(raw: unknown, close: OwnedClose): TransportCapability | null {
	const descriptors = exact(raw, TRANSPORT_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const send = bind(raw, descriptors.send);
	return send ? Object.freeze({ send, close }) : null;
}

function snapshotApplication(raw: unknown, close: OwnedClose): ApplicationCapability | null {
	const descriptors = exact(raw, APPLICATION_KEYS);
	if (!descriptors || typeof raw !== "object" || raw === null) return null;
	const apply = bind(raw, descriptors.apply);
	return apply ? Object.freeze({ apply, close }) : null;
}

function validId(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return false;
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index);
		if (code <= 0x20 || code >= 0x7f) return false;
	}
	return true;
}

function snapshotIdentity(raw: unknown): Readonly<{ hostId: string; generation: string; sessionId: string }> | null {
	const descriptors = exact(raw, IDENTITY_KEYS);
	const hostId = descriptors?.hostId?.value;
	const generation = descriptors?.generation?.value;
	const sessionId = descriptors?.sessionId?.value;
	if (!validId(hostId) || !validId(generation) || !validId(sessionId)) return null;
	return Object.freeze({ hostId, generation, sessionId });
}

function newPersistenceInput(
	envelope: RemoteHostFrameEnvelope,
	direction: "sent" | "received",
	identity: Readonly<{ hostId: string; generation: string; sessionId: string }>,
): Readonly<Record<string, unknown>> {
	return Object.freeze({
		version: 1,
		direction,
		hostId: identity.hostId,
		generation: identity.generation,
		sessionId: identity.sessionId,
		recordedAt: envelope.sentAt,
		envelope,
	});
}

function deterministicId(domain: "ack" | "frame", state: DurableFrameState): string {
	const hash = createHash("sha256");
	hash.update(domain);
	hash.update("\0");
	hash.update(state.record.hostId);
	hash.update("\0");
	hash.update(state.record.generation);
	hash.update("\0");
	hash.update(state.record.sessionId);
	hash.update("\0");
	hash.update(state.record.envelope.frameId);
	hash.update("\0");
	hash.update(state.record.envelopeDigest);
	return `relay-${domain}-${hash.digest("hex")}`;
}

function acknowledgmentFor(state: DurableFrameState): RemoteHostFrameEnvelope {
	return Object.freeze({
		type: "frame" as const,
		frameId: deterministicId("frame", state),
		protocol: state.record.envelope.protocol,
		sentAt: state.record.recordedAt,
		frame: Object.freeze({
			type: "ack" as const,
			ackId: deterministicId("ack", state),
			acknowledges: state.record.envelope.frameId,
			status: "delivered" as const,
		}),
	});
}

function needsAcknowledgment(envelope: RemoteHostFrameEnvelope): boolean {
	return (
		envelope.frame.type === "command" ||
		envelope.frame.type === "event" ||
		envelope.frame.type === "agent_message" ||
		envelope.frame.type === "provider_proxy"
	);
}

function acceptedApplicationEnvelope(envelope: RemoteHostFrameEnvelope): boolean {
	return (
		envelope.frame.type === "command" ||
		envelope.frame.type === "event" ||
		envelope.frame.type === "agent_message" ||
		envelope.frame.type === "provider_proxy" ||
		envelope.frame.type === "ack"
	);
}

function acceptedDomainSendEnvelope(envelope: RemoteHostFrameEnvelope): boolean {
	return (
		envelope.frame.type === "command" ||
		envelope.frame.type === "event" ||
		envelope.frame.type === "agent_message" ||
		envelope.frame.type === "provider_proxy"
	);
}

function erase(bytes: Uint8Array | null): void {
	if (bytes === null) return;
	try {
		Uint8Array.prototype.fill.call(bytes, 0);
	} catch {
		// best effort
	}
}

function revalidateRecord(entry: DurableJournalEntry): JournalRecordV1 | null {
	const input = Object.freeze({
		version: entry.record.version,
		journalSeq: entry.record.journalSeq,
		direction: entry.record.direction,
		hostId: entry.record.hostId,
		generation: entry.record.generation,
		sessionId: entry.record.sessionId,
		recordedAt: entry.record.recordedAt,
		envelope: entry.record.envelope,
	});
	const encoded = encodeJournalRecordV1(input);
	if (!encoded.ok) return null;
	if (encoded.record.envelopeDigest !== entry.record.envelopeDigest) {
		erase(encoded.bytes);
		return null;
	}
	// Verify journal sequence is bound to receipt sequence
	if (entry.receipt.sequence !== entry.record.journalSeq) {
		erase(encoded.bytes);
		return null;
	}
	const rehash = createHash("sha256").update(encoded.bytes).digest("hex");
	if (rehash !== entry.receipt.sha256 || encoded.bytes.byteLength !== entry.receipt.size) {
		erase(encoded.bytes);
		return null;
	}
	erase(encoded.bytes);
	return encoded.record;
}

function validateReceipt(raw: unknown): DurableReceipt | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const d = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(d);
		if (names.length !== 3) return null;
		if (!names.includes("sequence") || !names.includes("size") || !names.includes("sha256")) return null;
		for (const name of names) {
			const desc = d[name];
			if (!desc || !desc.enumerable || !("value" in desc) || desc.value === undefined) return null;
		}
		const seq = d.sequence.value;
		const size = d.size.value;
		const sha = d.sha256.value;
		if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1 || seq > 20000) return null;
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > 1310720) return null;
		if (typeof sha !== "string" || !/^[0-9a-f]{64}$/.test(sha)) return null;
		return Object.freeze({ sequence: seq, size, sha256: sha });
	} catch {
		return null;
	}
}

export class OrderedDurableRelay {
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<OrderedRelayResult<void>> | null = null;
	private readonly applicationContext = new AsyncLocalStorage<boolean>();
	private closed = false;
	private poisoned = false;

	private constructor(
		private readonly identity: Readonly<{ hostId: string; generation: string; sessionId: string }>,
		private readonly incoming: BoundStore,
		private readonly outgoing: BoundStore,
		private readonly transport: TransportCapability,
		private readonly application: ApplicationCapability,
	) {}

	static async create(raw: unknown): Promise<CreateOrderedDurableRelayResult> {
		const preliminary = rawDescriptors(raw);
		const incomingRaw =
			preliminary?.incomingStore && "value" in preliminary.incomingStore
				? preliminary.incomingStore.value
				: undefined;
		const outgoingRaw =
			preliminary?.outgoingStore && "value" in preliminary.outgoingStore
				? preliminary.outgoingStore.value
				: undefined;
		const transportRaw =
			preliminary?.transport && "value" in preliminary.transport ? preliminary.transport.value : undefined;
		const applicationRaw =
			preliminary?.application && "value" in preliminary.application ? preliminary.application.value : undefined;
		const storeCache = new Map<object, OwnedClose | null>();
		const captureStore = (candidate: unknown): OwnedClose | null => {
			if (typeof candidate !== "object" || candidate === null) return storeClose(candidate);
			if (storeCache.has(candidate)) return storeCache.get(candidate) ?? null;
			const captured = storeClose(candidate);
			storeCache.set(candidate, captured);
			return captured;
		};
		const capabilityCache = new Map<object, OwnedClose | null>();
		const captureCapability = (candidate: unknown): OwnedClose | null => {
			if (typeof candidate !== "object" || candidate === null) return ownedClose(candidate, STATUS_KEYS);
			if (capabilityCache.has(candidate)) return capabilityCache.get(candidate) ?? null;
			const captured = ownedClose(candidate, STATUS_KEYS);
			capabilityCache.set(candidate, captured);
			return captured;
		};
		const incomingClose = captureStore(incomingRaw);
		const outgoingClose = captureStore(outgoingRaw);
		const transportClose = captureCapability(transportRaw);
		const applicationClose = captureCapability(applicationRaw);
		const owned = [...new Set([incomingClose, outgoingClose, transportClose, applicationClose])].filter(
			(close): close is OwnedClose => close !== null,
		);
		const failCreate = async (code: OrderedRelayErrorCode): Promise<CreateOrderedDurableRelayResult> =>
			(await closeAll(owned)) ? failure(code) : failure("CLOSE_UNCERTAIN");
		const descriptors = exact(raw, INPUT_KEYS);
		if (
			!descriptors ||
			!incomingClose ||
			!outgoingClose ||
			!transportClose ||
			!applicationClose ||
			incomingRaw === outgoingRaw ||
			transportRaw === applicationRaw
		) {
			return await failCreate("INVALID_ARGUMENT");
		}
		const identity = snapshotIdentity(descriptors.identity.value);
		const incoming = bindStore(incomingRaw, incomingClose);
		const outgoing = bindStore(outgoingRaw, outgoingClose);
		const transport = snapshotTransport(transportRaw, transportClose);
		const application = snapshotApplication(applicationRaw, applicationClose);
		if (
			!identity ||
			!incoming ||
			!outgoing ||
			!transport ||
			!application ||
			incoming.status.direction !== "received" ||
			outgoing.status.direction !== "sent" ||
			incoming.status.identity.hostId !== identity.hostId ||
			incoming.status.identity.generation !== identity.generation ||
			incoming.status.identity.sessionId !== identity.sessionId ||
			outgoing.status.identity.hostId !== identity.hostId ||
			outgoing.status.identity.generation !== identity.generation ||
			outgoing.status.identity.sessionId !== identity.sessionId
		) {
			return await failCreate("INVALID_ARGUMENT");
		}
		return Object.freeze({
			ok: true as const,
			relay: new OrderedDurableRelay(identity, incoming, outgoing, transport, application),
		});
	}

	receive(raw: unknown): Promise<OrderedRelayResult<OrderedRelayReceiveResult>> {
		if (this.applicationContext.getStore() === true) return Promise.resolve(failure("REENTRANT_CALL"));
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const decoded = decodeEnvelope(raw);
		if (!decoded.ok || !acceptedApplicationEnvelope(decoded.value)) {
			return Promise.resolve(failure("INVALID_ARGUMENT"));
		}
		return this.enqueue(() => this.receiveOrdered(decoded.value));
	}

	send(raw: unknown): Promise<OrderedRelayResult<OrderedRelaySendResult>> {
		if (this.applicationContext.getStore() === true) return Promise.resolve(failure("REENTRANT_CALL"));
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const decoded = decodeEnvelope(raw);
		if (!decoded.ok || !acceptedDomainSendEnvelope(decoded.value)) {
			return Promise.resolve(failure("INVALID_ARGUMENT"));
		}
		return this.enqueue(() => this.sendOrdered(decoded.value));
	}

	replayOutgoing(raw: unknown): Promise<OrderedRelayResult<OrderedRelayReplayResult>> {
		if (this.applicationContext.getStore() === true) return Promise.resolve(failure("REENTRANT_CALL"));
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		return this.enqueue(() => this.replayOutgoingOrdered(raw));
	}

	queryOutgoingAcknowledgment(frameId: unknown): Promise<OrderedRelayResult<OutgoingAcknowledgmentEvidence | null>> {
		if (this.applicationContext.getStore() === true) return Promise.resolve(failure("REENTRANT_CALL"));
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		if (!validId(frameId)) return Promise.resolve(failure("INVALID_ARGUMENT"));
		return this.enqueue(() => this.queryOutgoingAcknowledgmentOrdered(frameId));
	}

	close(): Promise<OrderedRelayResult<void>> {
		if (this.applicationContext.getStore() === true) return Promise.resolve(failure("REENTRANT_CALL"));
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;
		this.closePromise = this.tail.then(
			() => this.closeResources(),
			() => this.closeResources(),
		);
		this.tail = this.closePromise.then(() => undefined);
		return this.closePromise;
	}

	private enqueue<T>(operation: () => Promise<OrderedRelayResult<T>>): Promise<OrderedRelayResult<T>> {
		if (this.closed) return Promise.resolve(failure("CLOSED"));
		const attempted = this.tail.then(
			() => (this.poisoned ? failure("POISONED") : operation()),
			() => {
				this.poisoned = true;
				return failure("POISONED");
			},
		);
		const result = attempted.then(
			(value) => value,
			() => {
				this.poisoned = true;
				return failure("POISONED");
			},
		);
		this.tail = result.then(() => undefined);
		return result;
	}

	private async closeResources(): Promise<OrderedRelayResult<void>> {
		const closed = await closeAll([
			this.incoming.close,
			this.outgoing.close,
			this.transport.close,
			this.application.close,
		]);
		return closed ? success(undefined) : failure("CLOSE_UNCERTAIN");
	}

	private async persistIncoming(envelope: RemoteHostFrameEnvelope): Promise<DurableFrameState | null> {
		const published = await this.incoming.publish(newPersistenceInput(envelope, "received", this.identity));
		if (!published.ok) return null;
		const queried = await this.incoming.query(envelope.frameId);
		return queried.ok ? queried.value : null;
	}

	private async stateAfterPending(state: DurableFrameState): Promise<DurableFrameState | null> {
		if (state.state !== "new") return state;
		const marked = await this.incoming.markPending(
			Object.freeze({ frameId: state.record.envelope.frameId, recordedAt: state.record.recordedAt }),
		);
		if (!marked.ok) return null;
		const queried = await this.incoming.query(state.record.envelope.frameId);
		return queried.ok ? queried.value : null;
	}

	private async apply(envelope: RemoteHostFrameEnvelope): Promise<boolean> {
		const observed = await this.applicationContext.run(true, () =>
			invoke(() => this.application.apply(Object.freeze({ envelope })), APPLY_TIMEOUT_MS),
		);
		if (observed.status !== "fulfilled") return false;
		const result = exact(observed.value, STATUS_KEYS);
		return result?.status?.value === "applied";
	}

	private async sendTransport(envelope: RemoteHostFrameEnvelope): Promise<boolean> {
		const observed = await invoke(() => this.transport.send(Object.freeze({ envelope })), SEND_TIMEOUT_MS);
		if (observed.status !== "fulfilled") return false;
		const result = exact(observed.value, STATUS_KEYS);
		return result?.status?.value === "sent";
	}

	private async persistGeneratedAcknowledgment(acknowledgment: RemoteHostFrameEnvelope): Promise<boolean> {
		const published = await this.outgoing.publish(newPersistenceInput(acknowledgment, "sent", this.identity));
		if (!published.ok) return false;
		const queried = await this.outgoing.query(acknowledgment.frameId);
		if (!queried.ok) return false;
		if (queried.value.state === "new") {
			const pending = await this.outgoing.markPending(
				Object.freeze({ frameId: acknowledgment.frameId, recordedAt: acknowledgment.sentAt }),
			);
			if (!pending.ok) return false;
		}
		const afterPending = await this.outgoing.query(acknowledgment.frameId);
		if (!afterPending.ok) return false;
		if (afterPending.value.state === "pending") {
			const delivered = await this.outgoing.markDelivered(
				Object.freeze({ frameId: acknowledgment.frameId, recordedAt: acknowledgment.sentAt }),
			);
			if (!delivered.ok) return false;
		}
		const finalState = await this.outgoing.query(acknowledgment.frameId);
		return finalState.ok && finalState.value.state === "delivered";
	}

	private async finishIncoming(state: DurableFrameState): Promise<boolean> {
		const delivered = await this.incoming.markDelivered(
			Object.freeze({ frameId: state.record.envelope.frameId, recordedAt: state.record.recordedAt }),
		);
		return delivered.ok;
	}

	private async receiveOrdered(
		envelope: RemoteHostFrameEnvelope,
	): Promise<OrderedRelayResult<OrderedRelayReceiveResult>> {
		let state = await this.persistIncoming(envelope);
		if (!state) return this.poison("PERSISTENCE_FAILED");
		if (state.state === "delivered") {
			if (!needsAcknowledgment(state.record.envelope)) {
				return success(
					Object.freeze({
						action: "replayed" as const,
						frameId: envelope.frameId,
						acknowledgment: null,
					}),
				);
			}
			const acknowledgment = acknowledgmentFor(state);
			if (!(await this.persistGeneratedAcknowledgment(acknowledgment))) {
				return this.poison("PERSISTENCE_FAILED");
			}
			if (!(await this.sendTransport(acknowledgment))) {
				return this.poison("TRANSPORT_UNCERTAIN");
			}
			return success(
				Object.freeze({
					action: "replayed_ack" as const,
					frameId: envelope.frameId,
					acknowledgment,
				}),
			);
		}
		state = await this.stateAfterPending(state);
		if (!state || state.state !== "pending") return this.poison("PERSISTENCE_FAILED");
		if (state.record.envelope.frame.type === "ack") {
			const acknowledgment = state.record.envelope.frame as RemoteHostAckFrame;
			// Rejected ACK: peer explicitly failed the message
			if (acknowledgment.status === "rejected") {
				// Finish incoming (deterministic persistence of the rejection)
				if (!(await this.finishIncoming(state))) return this.poison("PERSISTENCE_FAILED");
				// Return failure: outgoing stays pending, seeker must recover
				return this.poison("APPLICATION_FAILED");
			}
			const outgoing = await this.outgoing.query(acknowledgment.acknowledges);
			if (!outgoing.ok || outgoing.value.state === "new") {
				return this.poison("PERSISTENCE_FAILED");
			}
			if (outgoing.value.state === "pending") {
				const delivered = await this.outgoing.markDelivered(
					Object.freeze({
						frameId: acknowledgment.acknowledges,
						recordedAt: state.record.recordedAt,
					}),
				);
				if (!delivered.ok) return this.poison("PERSISTENCE_FAILED");
			}
			if (!(await this.finishIncoming(state))) return this.poison("PERSISTENCE_FAILED");
			return success(
				Object.freeze({
					action: "acknowledged_outbound" as const,
					frameId: envelope.frameId,
					acknowledgment: null,
				}),
			);
		}
		if (!(await this.apply(state.record.envelope))) {
			return this.poison("APPLICATION_FAILED");
		}
		if (!needsAcknowledgment(state.record.envelope)) {
			if (!(await this.finishIncoming(state))) return this.poison("PERSISTENCE_FAILED");
			return success(
				Object.freeze({
					action: "applied" as const,
					frameId: envelope.frameId,
					acknowledgment: null,
				}),
			);
		}
		const acknowledgment = acknowledgmentFor(state);
		if (!(await this.persistGeneratedAcknowledgment(acknowledgment))) {
			return this.poison("PERSISTENCE_FAILED");
		}
		if (!(await this.finishIncoming(state))) return this.poison("PERSISTENCE_FAILED");
		if (!(await this.sendTransport(acknowledgment))) {
			return this.poison("TRANSPORT_UNCERTAIN");
		}
		return success(
			Object.freeze({
				action: "applied_and_acknowledged" as const,
				frameId: envelope.frameId,
				acknowledgment,
			}),
		);
	}

	private async sendOrdered(envelope: RemoteHostFrameEnvelope): Promise<OrderedRelayResult<OrderedRelaySendResult>> {
		const published = await this.outgoing.publish(newPersistenceInput(envelope, "sent", this.identity));
		if (!published.ok) return this.poison("PERSISTENCE_FAILED");
		// Fresh-copy the ACTUAL published receipt (never substitute query receipt)
		const pubReceipt = validateReceipt(published.value);
		if (!pubReceipt) return this.poison("PERSISTENCE_FAILED");
		const queried = await this.outgoing.query(envelope.frameId);
		if (!queried.ok) return this.poison("PERSISTENCE_FAILED");
		// Validate query receipt through validateReceipt before comparison
		const qjr = validateReceipt(queried.value.journal);
		if (!qjr) return this.poison("PERSISTENCE_FAILED");
		if (qjr.sequence !== pubReceipt.sequence || qjr.size !== pubReceipt.size || qjr.sha256 !== pubReceipt.sha256) {
			return this.poison("PERSISTENCE_FAILED");
		}
		const replay = queried.value.state !== "new";
		const journalReceipt = pubReceipt;
		if (queried.value.state === "delivered") {
			return success(Object.freeze({ frameId: envelope.frameId, replay: true, journalReceipt }));
		}
		if (queried.value.state === "new") {
			const pending = await this.outgoing.markPending(
				Object.freeze({ frameId: envelope.frameId, recordedAt: envelope.sentAt }),
			);
			if (!pending.ok) return this.poison("PERSISTENCE_FAILED");
		}
		if (!(await this.sendTransport(envelope))) return this.poison("TRANSPORT_UNCERTAIN");
		return success(Object.freeze({ frameId: envelope.frameId, replay, journalReceipt }));
	}

	private async replayOutgoingOrdered(raw: unknown): Promise<OrderedRelayResult<OrderedRelayReplayResult>> {
		const page = await this.outgoing.replayJournals(raw);
		if (!page.ok) {
			return page.error.code === "INVALID_ARGUMENT"
				? failure("INVALID_ARGUMENT")
				: this.poison("PERSISTENCE_FAILED");
		}
		let sent = 0;
		for (const entry of page.value.entries) {
			const state = await this.outgoing.query(entry.record.envelope.frameId);
			if (!state.ok) return this.poison("PERSISTENCE_FAILED");
			if (state.value.state === "delivered") continue;
			if (state.value.state === "new") {
				const pending = await this.outgoing.markPending(
					Object.freeze({
						frameId: entry.record.envelope.frameId,
						recordedAt: entry.record.recordedAt,
					}),
				);
				if (!pending.ok) return this.poison("PERSISTENCE_FAILED");
			}
			if (!(await this.sendTransport(entry.record.envelope))) {
				return this.poison("TRANSPORT_UNCERTAIN");
			}
			sent += 1;
		}
		return success(Object.freeze({ sent, nextCursor: page.value.nextCursor }));
	}

	private async queryOutgoingAcknowledgmentOrdered(
		frameId: string,
	): Promise<OrderedRelayResult<OutgoingAcknowledgmentEvidence | null>> {
		// 1. Query outgoing store for the frame's delivery state
		const outgoing = await this.outgoing.query(frameId);
		if (!outgoing.ok) {
			if (outgoing.error.code === "NOT_FOUND") return success(null);
			return this.poison("PERSISTENCE_FAILED");
		}
		const outgoingState = outgoing.value;

		// Validate and fresh-copy outgoing journal receipt
		const outgoingJournalReceipt = validateReceipt(outgoingState.journal);
		if (!outgoingJournalReceipt) return this.poison("EVIDENCE_CONFLICT");

		// Revalidate outgoing record through codec/digest/journal binding
		if (!revalidateRecord({ record: outgoingState.record, receipt: outgoingState.journal })) {
			return this.poison("EVIDENCE_CONFLICT");
		}

		// Require non-null delivered receipt when outgoing is delivered
		if (outgoingState.state === "delivered" && !validateReceipt(outgoingState.delivered)) {
			return this.poison("EVIDENCE_CONFLICT");
		}

		// Require outgoing delivered before returning evidence
		if (outgoingState.state !== "delivered") return success(null);

		// 2. Bounded scan of incoming durable journals for an ACK
		let cursor: number | null = null;
		let foundRecord: JournalRecordV1 | null = null;
		let foundReceipt: DurableReceipt | null = null;
		let pages = 0;
		let records = 0;

		while (pages < QUERY_MAX_PAGES) {
			pages += 1;
			const pageResult = await this.incoming.replayJournals(Object.freeze({ cursor, maxCount: 64 }));
			if (!pageResult.ok) return this.poison("PERSISTENCE_FAILED");

			const page = pageResult.value;

			// Verify cursor advances monotonically
			if (page.nextCursor !== null && cursor !== null && page.nextCursor <= cursor) {
				return this.poison("EVIDENCE_CONFLICT");
			}

			// If page cursor does not advance from request cursor, conflict
			if (page.nextCursor !== null && page.nextCursor === cursor) {
				return this.poison("EVIDENCE_CONFLICT");
			}

			for (const entry of page.entries) {
				records += 1;
				if (records > QUERY_MAX_RECORDS) return this.poison("EVIDENCE_CONFLICT");

				// Validate every journal entry through codec before reading
				const freshRecord = revalidateRecord(entry);
				if (!freshRecord) return this.poison("EVIDENCE_CONFLICT");

				// Skip non-ACK entries
				if (freshRecord.envelope.frame.type !== "ack") continue;
				const ackFrame = freshRecord.envelope.frame;
				if (ackFrame.type !== "ack") continue;
				if (ackFrame.acknowledges !== frameId) continue;

				// Reject rejected ACK -- peer explicitly failed the message
				if (ackFrame.status === "rejected") return this.poison("EVIDENCE_CONFLICT");

				// Found a matching ACK -- reject duplicates
				if (foundRecord !== null) return this.poison("EVIDENCE_CONFLICT");

				// Verify ACK is durably delivered in incoming store
				const ackIncoming = await this.incoming.query(freshRecord.envelope.frameId);
				if (!ackIncoming.ok || ackIncoming.value.state !== "delivered") return success(null);
				// Require non-null delivered receipt
				if (!validateReceipt(ackIncoming.value.delivered)) return this.poison("EVIDENCE_CONFLICT");

				// Full identity binding: frameId, envelopeDigest, journal seq+size+sha
				const ai = ackIncoming.value;
				if (ai.record.envelope.frameId !== freshRecord.envelope.frameId) {
					return this.poison("EVIDENCE_CONFLICT");
				}
				if (ai.record.envelopeDigest !== freshRecord.envelopeDigest) {
					return this.poison("EVIDENCE_CONFLICT");
				}
				if (ai.journal.sequence !== entry.receipt.sequence) {
					return this.poison("EVIDENCE_CONFLICT");
				}
				if (ai.journal.size !== entry.receipt.size) {
					return this.poison("EVIDENCE_CONFLICT");
				}
				if (ai.journal.sha256 !== entry.receipt.sha256) {
					return this.poison("EVIDENCE_CONFLICT");
				}

				// Verify recomputed envelope digest matches
				const ackDigestCheck = canonicalDigest(freshRecord.envelope);
				if (!ackDigestCheck.ok) return this.poison("EVIDENCE_CONFLICT");
				if (ackDigestCheck.value !== freshRecord.envelopeDigest) return this.poison("EVIDENCE_CONFLICT");

				foundRecord = freshRecord;
				foundReceipt = validateReceipt(entry.receipt);
				if (!foundReceipt) return this.poison("EVIDENCE_CONFLICT");
			}

			if (page.nextCursor === null) {
				cursor = null;
				break;
			}
			cursor = page.nextCursor;
		}

		// Track whether the scan actually completed (nextCursor was null on final page)
		const scanComplete = cursor === null;
		if (!scanComplete) return this.poison("EVIDENCE_CONFLICT");

		// 3. If no matching ACK found, conflict
		if (foundRecord === null || foundReceipt === null) return this.poison("EVIDENCE_CONFLICT");

		// 4. Build secret-free evidence (no outgoingEnvelope or ackEnvelope)
		return success(
			Object.freeze({
				frameId,
				outgoingJournalReceipt,
				ackEnvelopeId: foundRecord.envelope.frameId,
				ackEnvelopeDigest: foundRecord.envelopeDigest,
			}),
		);
	}

	private poison<T>(code: OrderedRelayErrorCode): OrderedRelayResult<T> {
		this.poisoned = true;
		return failure(code);
	}
}

export async function createOrderedDurableRelay(raw: unknown): Promise<CreateOrderedDurableRelayResult> {
	return await OrderedDurableRelay.create(raw);
}
