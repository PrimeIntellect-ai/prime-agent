/**
 * Pure type definitions for SandboxEventOutboxStore.
 *
 * Re-exports DurableReceipt from provider-call-record-codec and
 * SandboxEventOutboxRecordV1 variant types from the event codec.
 * Defines error codes, event state types, query types, status type,
 * capability interface, and result unions.
 *
 * No logic -- types only.  All result types are decomposed for
 * static inference; no aliased nested discriminated unions.
 */

import type { DurableReceipt } from "./provider-call-record-codec.js";
import type { RemoteHostAckFrame, RemoteHostEventFrame } from "./remote-agent-host-protocol.js";
import type { SandboxEventOutboxPendingRecordV1 } from "./sandbox-event-outbox-record-codec.js";

// ===========================================================================
// EventOutboxErrorCode -- closed error code set
// ===========================================================================

export type EventOutboxErrorCode =
	| "EVENT_ID_COLLISION"
	| "EVENT_SEQUENCE_COLLISION"
	| "DELIVERED_COLLISION"
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "POISONED"
	| "RECOVERY_FAILED"
	| "UNCERTAIN";

// ===========================================================================
// EventOutboxEnqueueReceipt
// ===========================================================================

export interface EventOutboxEnqueueReceipt {
	readonly receipt: DurableReceipt;
	readonly eventId: string;
	readonly eventDigest: string;
	readonly eventSequence: number;
}

// ===========================================================================
// EventOutboxDeliveredReceipt
// ===========================================================================

export interface EventOutboxDeliveredReceipt {
	readonly receipt: DurableReceipt;
	readonly eventId: string;
	readonly ackDigest: string;
	readonly eventSequence: number;
}

// ===========================================================================
// EventOutboxEventState -- discriminated by .state
// ===========================================================================

export interface EventOutboxPendingState {
	readonly state: "pending";
	readonly eventId: string;
	readonly eventDigest: string;
	readonly eventSequence: number;
	readonly enqueueReceipt: EventOutboxEnqueueReceipt;
	readonly event: RemoteHostEventFrame;
}

export interface EventOutboxDeliveredState {
	readonly state: "delivered";
	readonly eventId: string;
	readonly eventDigest: string;
	readonly eventSequence: number;
	readonly enqueueReceipt: EventOutboxEnqueueReceipt;
	readonly deliveredReceipt: EventOutboxDeliveredReceipt;
	readonly event: RemoteHostEventFrame;
	readonly ack: RemoteHostAckFrame;
}

export type EventOutboxEventState = EventOutboxPendingState | EventOutboxDeliveredState;

// ===========================================================================
// EventOutboxReplayPage
// ===========================================================================

export interface EventOutboxReplayPage {
	readonly records: readonly SandboxEventOutboxPendingRecordV1[];
	readonly nextEventSequence: number | null;
	readonly totalBytes: number;
}

// ===========================================================================
// EventOutboxStoreStatus
// ===========================================================================

export interface EventOutboxStoreStatus {
	readonly eventCount: number;
	readonly totalBytes: number;
	readonly nextJournalSeq: number;
	readonly nextEventSequence: number;
}

// ===========================================================================
// EventOutboxResult -- decomposed discriminated union per method
// ===========================================================================

export interface EventOutboxResultBase<T> {
	readonly ok: true;
	readonly value: T;
}

export interface EventOutboxErrorResult {
	readonly ok: false;
	readonly error: Readonly<{ code: EventOutboxErrorCode }>;
}

export type EventOutboxResult<T> = EventOutboxResultBase<T> | EventOutboxErrorResult;

// ===========================================================================
// Capability
// ===========================================================================

export interface SandboxEventOutboxStoreCapability {
	readonly enqueue: (
		input: Readonly<{ event: RemoteHostEventFrame; recordedAt: string }>,
	) => Promise<EventOutboxResult<EventOutboxEnqueueReceipt>>;
	readonly markDelivered: (
		input: Readonly<{ eventId: string; ack: RemoteHostAckFrame; recordedAt: string }>,
	) => Promise<EventOutboxResult<EventOutboxDeliveredReceipt>>;
	readonly query: (eventId: string) => Promise<EventOutboxResult<EventOutboxEventState>>;
	readonly replayPending: (
		cursor: number | null,
		maxCount: number,
	) => Promise<EventOutboxResult<EventOutboxReplayPage>>;
	readonly status: () => Promise<EventOutboxResult<EventOutboxStoreStatus>>;
	readonly close: () => Promise<EventOutboxResult<void>>;
}
