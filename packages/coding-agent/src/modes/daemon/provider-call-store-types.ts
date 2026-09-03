import type { DurableReceipt } from "./provider-call-record-codec.js";
import type { RemoteHostProviderProxyFrame } from "./remote-agent-host-protocol.js";

// No DurableProviderCallStore import here to avoid circular dependency.
// The store type is referenced only through the companion module.

/**
 * Pure type definitions for DurableProviderCallStore.
 *
 * Re-exports DurableReceipt and record types from the codec.
 * Defines ProviderCallErrorCode, ProviderCallState, query types,
 * ProviderCallStoreStatus, ProviderCallOutputRecord,
 * ProviderCallReplayPage, and ProviderCallFixedErrorCode.
 *
 * No logic -- types only.  All result types are decomposed for
 * static inference; no aliased nested discriminated unions.
 */

// Re-export core codec types
export type {
	DurableReceipt,
	ProviderCallCancelRequestedRecordV1,
	ProviderCallChunkRecordV1,
	ProviderCallDeliveredRecordV1,
	ProviderCallJournaledRecordV1,
	ProviderCallRecordV1,
	ProviderCallStartedRecordV1,
	ProviderCallTerminalRecordV1,
} from "./provider-call-record-codec.js";

// Re-export recovery types
export type { ProviderCallIdentity } from "./provider-call-recovery.js";

// ===========================================================================
// ProviderCallErrorCode -- closed error code set
// ===========================================================================

export type ProviderCallErrorCode =
	| "CALL_ID_COLLISION"
	| "CHUNK_COLLISION"
	| "CHUNK_GAP"
	| "TERMINAL_COLLISION"
	| "DELIVERED_COLLISION"
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "INVALID_ARGUMENT"
	| "NOT_FOUND"
	| "POISONED"
	| "RECOVERY_FAILED"
	| "UNCERTAIN";

// ===========================================================================
// ProviderCallFixedErrorCode -- six fixed allowlisted wire codes
// ===========================================================================

export type ProviderCallFixedErrorCode =
	| "PROVIDER_CALL_INTERRUPTED"
	| "PROVIDER_ERROR"
	| "PROVIDER_CALL_CANCELLED"
	| "PERSISTENCE_ERROR"
	| "POLICY_DENIED"
	| "INVALID_REQUEST";

// ===========================================================================
// ProviderCallJournaledReceipt
// ===========================================================================

export interface ProviderCallJournaledReceipt {
	readonly receipt: DurableReceipt;
	readonly callId: string;
	readonly requestDigest: string;
	readonly canonicalRequestDigest: string;
}

// ===========================================================================
// ProviderCallTerminalReceipt
// ===========================================================================

export interface ProviderCallTerminalReceipt {
	readonly receipt: DurableReceipt;
	readonly callId: string;
	readonly terminalKind: "normal" | "interrupted" | "cancelled";
	readonly chunkCount: number;
	readonly terminalBytesDigest: string;
}

// ===========================================================================
// ProviderCallOutputRecord
// ===========================================================================

export interface ProviderCallChunkOutputRecord {
	readonly kind: "chunk";
	readonly chunkIndex: number;
	readonly frame: RemoteHostProviderProxyFrame;
}

export interface ProviderCallTerminalOutputRecord {
	readonly kind: "terminal";
	readonly frame: RemoteHostProviderProxyFrame;
}

export type ProviderCallOutputRecord = ProviderCallChunkOutputRecord | ProviderCallTerminalOutputRecord;

// ===========================================================================
// ProviderCallState -- discriminated by .state
// ===========================================================================

export interface ProviderCallJournaledState {
	readonly state: "journaled";
	readonly callId: string;
	readonly requestDigest: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
}

export interface ProviderCallStartedState {
	readonly state: "started";
	readonly callId: string;
	readonly requestDigest: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
	readonly startedReceipt: DurableReceipt;
}

export interface ProviderCallStreamingState {
	readonly state: "streaming";
	readonly callId: string;
	readonly requestDigest: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
	readonly startedReceipt: DurableReceipt;
	readonly chunkCount: number;
}

export interface ProviderCallTerminalState {
	readonly state: "terminal";
	readonly callId: string;
	readonly requestDigest: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
	readonly startedReceipt: DurableReceipt;
	readonly terminalReceipt: ProviderCallTerminalReceipt;
	readonly chunkCount: number;
}

export interface ProviderCallDeliveredState {
	readonly state: "delivered";
	readonly callId: string;
	readonly requestDigest: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
	readonly startedReceipt: DurableReceipt;
	readonly terminalReceipt: ProviderCallTerminalReceipt;
	readonly deliveredReceipt: DurableReceipt;
	readonly chunkCount: number;
}

export type ProviderCallState =
	| ProviderCallJournaledState
	| ProviderCallStartedState
	| ProviderCallStreamingState
	| ProviderCallTerminalState
	| ProviderCallDeliveredState;

// ===========================================================================
// ProviderCallReplayPage
// ===========================================================================

export interface ProviderCallReplayPage {
	readonly records: readonly ProviderCallOutputRecord[];
	readonly nextChunkIndex: number | null;
}

// ===========================================================================
// ProviderCallUndeliveredRecord -- secret-free summary for non-delivered calls
// ===========================================================================

export interface ProviderCallUndeliveredRecord {
	readonly callId: string;
	readonly state: "journaled" | "started" | "streaming" | "terminal";
	readonly requestDigest: string;
	readonly firstJournalSequence: number;
	readonly chunkCount: number;
}

// ===========================================================================
// ProviderCallUndeliveredPage -- bounded page of undelivered summaries
// ===========================================================================

export interface ProviderCallUndeliveredPage {
	readonly records: readonly ProviderCallUndeliveredRecord[];
	readonly nextCursor: number | null;
}

// ===========================================================================
// ProviderCallStoreStatus
// ===========================================================================

export interface ProviderCallStoreStatus {
	readonly callCount: number;
	readonly totalBytes: number;
	readonly nextSequence: number;
}

// ===========================================================================
// ProviderCallResult -- decomposed discriminated union per method
// ===========================================================================

export interface ProviderCallResultBase<T> {
	readonly ok: true;
	readonly value: T;
}

export interface ProviderCallErrorResult {
	readonly ok: false;
	readonly error: Readonly<{ code: ProviderCallErrorCode }>;
}

export type ProviderCallResult<T> = ProviderCallResultBase<T> | ProviderCallErrorResult;
