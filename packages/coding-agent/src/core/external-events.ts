import { DEFAULT_AGENT_MESSAGE_MAX_CHARS } from "./agent-messages.js";

/** EXTERNAL_EVENT_HOST_REQUEST_TYPE identifies event admission across the kernel host bridge. */
const EXTERNAL_EVENT_HOST_REQUEST_TYPE = "session.external_event.emit";
/** EXTERNAL_EVENT_CUSTOM_TYPE identifies literal external-event messages in session history. */
export const EXTERNAL_EVENT_CUSTOM_TYPE = "external_event";
/** EXTERNAL_EVENT_PREVIEW_LABEL labels external events in the visible session queue. */
export const EXTERNAL_EVENT_PREVIEW_LABEL = "External event";
/** EXTERNAL_EVENT_QUEUE_KEY_PREFIX distinguishes external-event actions from other session work. */
const EXTERNAL_EVENT_QUEUE_KEY_PREFIX = "external-event:";

/** EXTERNAL_EVENT_MAX_NAME_CHARS bounds producer names at the host boundary. */
const EXTERNAL_EVENT_MAX_NAME_CHARS = 128;
/** EXTERNAL_EVENT_MAX_ID_CHARS bounds producer event identities at the host boundary. */
const EXTERNAL_EVENT_MAX_ID_CHARS = 512;
/** EXTERNAL_EVENT_MAX_TEXT_CHARS matches the session message input bound. */
export const EXTERNAL_EVENT_MAX_TEXT_CHARS = DEFAULT_AGENT_MESSAGE_MAX_CHARS;
/** EXTERNAL_EVENT_MAX_RETAINED_IDS bounds session-local event identity retention. */
export const EXTERNAL_EVENT_MAX_RETAINED_IDS = 1_024;
/** EXTERNAL_EVENT_MAX_PENDING bounds unfinished external-event actions. */
export const EXTERNAL_EVENT_MAX_PENDING = 128;

/** ExternalEventDeliveryPolicy selects the existing busy-session delivery lane. */
export type ExternalEventDeliveryPolicy = "followUp" | "steer";
/** ExternalEventDeliveryStatus reports whether admission delivered, queued, or coalesced the event. */
export type ExternalEventDeliveryStatus = "coalesced" | "delivered" | "queued";

/** ExternalEventInput is the validated event passed into AgentSession admission. */
export interface ExternalEventInput {
	name: string;
	eventId: string;
	text: string;
	deliveryPolicy: ExternalEventDeliveryPolicy;
}

/** ExternalEventDetails carries producer provenance in the admitted custom message. */
export interface ExternalEventDetails {
	name: string;
	eventId: string;
}

/** ExternalEventReceipt describes the result of admitting an external event. */
export interface ExternalEventReceipt extends Record<string, unknown> {
	accepted: true;
	deliveryStatus: ExternalEventDeliveryStatus;
	name: string;
	eventId: string;
}

/** externalEventQueueKey returns the session action key for one producer event identity. */
export function externalEventQueueKey(name: string, eventId: string): string {
	return `${EXTERNAL_EVENT_QUEUE_KEY_PREFIX}${JSON.stringify([name, eventId])}`;
}

/** isExternalEventQueueKey reports whether a session action carries an external-event identity. */
export function isExternalEventQueueKey(queueKey: string | undefined): boolean {
	return queueKey?.startsWith(EXTERNAL_EVENT_QUEUE_KEY_PREFIX) ?? false;
}

/**
 * ExternalEventRegistry coalesces in-flight admissions and retains completed producer identities.
 * Completed retention is bounded and oldest-first, and disposal permanently closes admission.
 */
export class ExternalEventRegistry {
	private readonly pending = new Map<string, Promise<ExternalEventDeliveryStatus>>();
	private readonly retained = new Set<string>();
	private disposed = false;

	/** admit returns the first admission or coalesces only after its in-flight outcome succeeds. */
	async admit(
		name: string,
		eventId: string,
		emit: () => Promise<ExternalEventDeliveryStatus>,
	): Promise<ExternalEventDeliveryStatus> {
		if (this.disposed) throw new Error("Cannot admit an external event after its session was disposed.");
		const key = this.key(name, eventId);
		if (this.retained.has(key)) return "coalesced";
		const existing = this.pending.get(key);
		if (existing) {
			await existing;
			return "coalesced";
		}

		const admission = Promise.resolve().then(emit);
		this.pending.set(key, admission);
		try {
			const status = await admission;
			if (!this.disposed) this.retain(key);
			return status;
		} finally {
			if (this.pending.get(key) === admission) this.pending.delete(key);
		}
	}

	/** dispose clears retained state and rejects subsequent admission. */
	dispose(): void {
		this.disposed = true;
		this.pending.clear();
		this.retained.clear();
	}

	/** size reports the number of completed producer identities retained for coalescing. */
	get size(): number {
		return this.retained.size;
	}

	/** key separates producer and event identity without delimiter ambiguity. */
	private key(name: string, eventId: string): string {
		return JSON.stringify([name, eventId]);
	}

	/** retain records one completed identity and evicts the oldest entry at the bound. */
	private retain(key: string): void {
		this.retained.add(key);
		while (this.retained.size > EXTERNAL_EVENT_MAX_RETAINED_IDS) {
			const oldest = this.retained.values().next().value;
			if (oldest === undefined) break;
			this.retained.delete(oldest);
		}
	}
}

/** boundedField validates a non-empty string field without rewriting its value. */
function boundedField(payload: Record<string, unknown>, field: string, maxChars: number): string {
	const value = payload[field];
	if (typeof value !== "string") {
		throw new Error(`${EXTERNAL_EVENT_HOST_REQUEST_TYPE} ${field} must be a string`);
	}
	if (!value.trim()) throw new Error(`${EXTERNAL_EVENT_HOST_REQUEST_TYPE} ${field} cannot be empty`);
	if (value.length > maxChars) {
		throw new Error(`${EXTERNAL_EVENT_HOST_REQUEST_TYPE} ${field} is too long: maximum is ${maxChars} characters`);
	}
	return value;
}

/** deliveryPolicy validates the delivery lane named by an external producer. */
function deliveryPolicy(payload: Record<string, unknown>): ExternalEventDeliveryPolicy {
	const value = payload.delivery_policy;
	if (value !== "followUp" && value !== "steer") {
		throw new Error(`${EXTERNAL_EVENT_HOST_REQUEST_TYPE} delivery_policy must be "followUp" or "steer"`);
	}
	return value;
}

/**
 * createExternalEventHostHandler returns a bounded, retry-safe host-request handler.
 * A failed emit rejects in-flight duplicates and releases the identity for a later retry.
 */
export function createExternalEventHostHandler(
	registry: ExternalEventRegistry,
	emit: (input: ExternalEventInput) => Promise<ExternalEventDeliveryStatus>,
): (payload: Record<string, unknown>) => Promise<ExternalEventReceipt> {
	return async (payload) => {
		const name = boundedField(payload, "name", EXTERNAL_EVENT_MAX_NAME_CHARS).trim();
		const eventId = boundedField(payload, "event_id", EXTERNAL_EVENT_MAX_ID_CHARS).trim();
		const text = boundedField(payload, "text", EXTERNAL_EVENT_MAX_TEXT_CHARS);
		const policy = deliveryPolicy(payload);
		const deliveryStatus = await registry.admit(name, eventId, () =>
			emit({ name, eventId, text, deliveryPolicy: policy }),
		);
		return { accepted: true, deliveryStatus, name, eventId } satisfies ExternalEventReceipt;
	};
}
