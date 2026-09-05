/**
 * HomeProviderCallCoordinator types.
 *
 * The coordinator ties a local provider proxy to the durable provider-call
 * store and a borrowed relay {send, queryOutgoingAcknowledgment} view.
 *
 * Home owns the proxy and the ONE durable provider store.
 * Relay is a borrowed non-owning exact view -- never closed.
 */

import type { DurableReceipt } from "./provider-call-record-codec.js";
import type { ProviderCallJournaledReceipt } from "./provider-call-store-types.js";

// ===========================================================================
// Error codes
// ===========================================================================

export type CoordinatorErrorCode =
	| "CALL_ID_COLLISION"
	| "CALL_NOT_FOUND"
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "INVALID_ARGUMENT"
	| "INVALID_STATE"
	| "PERSISTENCE_FAILED"
	| "POISONED"
	| "PROXY_FAILED"
	| "RECOVERY_FAILED"
	| "RELAY_UNCERTAIN"
	| "STORE_FAILED"
	| "STREAM_FAILED"
	| "TERMINAL_MISMATCH"
	| "ACK_MISMATCH"
	| "RELATED_SEND_FAILED";

// ===========================================================================
// Coordinator result types
// ===========================================================================

export interface CoordinatorResultBase<T> {
	readonly ok: true;
	readonly value: T;
}

export interface CoordinatorError {
	readonly ok: false;
	readonly error: Readonly<{ code: CoordinatorErrorCode }>;
}

export type CoordinatorResult<T> = CoordinatorResultBase<T> | CoordinatorError;

export interface HandleRequestResult {
	readonly callId: string;
	readonly journaledReceipt: ProviderCallJournaledReceipt;
	readonly startedReceipt: DurableReceipt;
}

export interface HandleCancelResult {
	readonly callId: string;
	readonly cancelReceipt: DurableReceipt;
}

export interface ReconcileResult {
	readonly callId: string;
	readonly deliveredReceipt: DurableReceipt;
}

// ===========================================================================
// Broker relay port -- branded borrowed non-owning delivery-evidence capability
// ===========================================================================

export interface RelayBrokerPort {
	readonly send: (
		envelope: unknown,
	) => Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: Readonly<{ code: string }> }>>;
	readonly queryOutgoingAcknowledgment: (
		frameId: unknown,
	) => Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; error: Readonly<{ code: string }> }>>;
}

// ===========================================================================
// Coordinator capability
// ===========================================================================

export interface HomeProviderCallCoordinatorCapability {
	readonly handleRequest: (envelope: unknown) => Promise<CoordinatorResult<HandleRequestResult>>;
	readonly handleCancel: (callId: string, recordedAt: string) => Promise<CoordinatorResult<HandleCancelResult>>;
	readonly reconcile: (
		callId: string,
		terminalFrameId: string,
		recordedAt: string,
	) => Promise<CoordinatorResult<ReconcileResult>>;
	readonly close: () => Promise<CoordinatorResult<void>>;
}

// ===========================================================================
// Factory input -- expects branded instances verified in create()
// ===========================================================================

export interface CoordinatorFactoryInput {
	readonly store: unknown;
	readonly proxy: unknown;
	readonly relay: unknown;
	readonly identity: Readonly<{ hostId: string; generation: string; sessionId: string }>;
}

// ===========================================================================
// Internal helpers
// ===========================================================================

export const RECORDED_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
