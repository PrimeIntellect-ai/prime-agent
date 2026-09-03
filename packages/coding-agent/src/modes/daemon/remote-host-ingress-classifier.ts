/**
 * Pure side-specific remote-host ingress classifier.
 *
 * Codec-validates an incoming envelope against the remote-host protocol,
 * then classifies the inner frame by side (home | sandbox) without
 * mutating journals, generating ACKs, calling relay, reflecting errors,
 * or writing any state.
 *
 * Classification rules (pre-B03 admission boundary):
 *   - All accepted frames (domain frames + ACK) → relay.receive.
 *     The relay owns journal/application/ACK; nothing goes directly
 *     to a domain app.
 *   - Control frames: handshake, handshake_ack, health, error →
 *     fixed control (transport only).
 *   - Impossible direction → fixed invalid-direction (category only,
 *     no envelope).
 *   - Codec validation failure → codec-error (category only, no
 *     error detail).
 *
 * All returned DTOs are freshly constructed and frozen. The codec
 * provides the fresh frozen envelope; the result wrapper is frozen
 * with Object.freeze on a new exact literal. No deepFreeze, no casts.
 */

import { decodeEnvelope } from "./remote-host-frame-codec.js";

// ===========================================================================
// Side type
// ===========================================================================

export type IngressSide = "home" | "sandbox";

// ===========================================================================
// Classification result — discriminated union
// ===========================================================================

import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";

export interface IngressRelayReceive {
	readonly category: "relay";
	readonly action: "receive";
	readonly envelope: RemoteHostFrameEnvelope;
}

export interface IngressControl {
	readonly category: "control";
	readonly envelope: RemoteHostFrameEnvelope;
}

export interface IngressInvalidDirection {
	readonly category: "invalid-direction";
}

export interface IngressCodecError {
	readonly category: "codec-error";
}

export type IngressClassification = IngressRelayReceive | IngressControl | IngressInvalidDirection | IngressCodecError;

// ===========================================================================
// Known frame types for dispatch
// ===========================================================================

const CONTROL_FRAME_TYPES = new Set(["handshake", "handshake_ack", "health", "error"]);

const HOME_DOMAIN_FRAME_TYPES = new Set(["event", "agent_message", "provider_proxy"]);

const SANDBOX_DOMAIN_FRAME_TYPES = new Set(["command", "agent_message", "provider_proxy"]);

// Provider proxy subtypes valid per side
const HOME_PROVIDER_PROXY_TYPES = new Set(["model_call_request", "model_call_cancel"]);
const SANDBOX_PROVIDER_PROXY_TYPES = new Set(["model_call_chunk", "model_call_complete", "model_call_error"]);

// ===========================================================================
// Typed fixed builders — each constructs an exact literal and freezes it.
// No generic freshFrozen, no as-type assertion, no deepFreeze.
// The codec envelope is already frozen; we do not refreeze it.
// ===========================================================================

function buildRelayReceive(envelope: RemoteHostFrameEnvelope): IngressRelayReceive {
	return Object.freeze({ category: "relay", action: "receive", envelope });
}

function buildControl(envelope: RemoteHostFrameEnvelope): IngressControl {
	return Object.freeze({ category: "control", envelope });
}

function buildInvalidDirection(): IngressInvalidDirection {
	return Object.freeze({ category: "invalid-direction" });
}

function buildCodecError(): IngressCodecError {
	return Object.freeze({ category: "codec-error" });
}

// ===========================================================================
// Runtime side validation — side is validated as unknown, no casts
// ===========================================================================

function isValidSide(v: unknown): v is IngressSide {
	return v === "home" || v === "sandbox";
}

// ===========================================================================
// Narrow a provider_proxy frame via discriminant on proxyType.
// The codec has already validated the shape; we only read proxyType
// through a direct property access for discriminant narrowing.
// ===========================================================================

function isHomeProxyType(frame: RemoteHostFrameEnvelope["frame"]): boolean {
	if (frame.type !== "provider_proxy") return false;
	const { proxyType } = frame;
	return HOME_PROVIDER_PROXY_TYPES.has(proxyType);
}

function isSandboxProxyType(frame: RemoteHostFrameEnvelope["frame"]): boolean {
	if (frame.type !== "provider_proxy") return false;
	const { proxyType } = frame;
	return SANDBOX_PROVIDER_PROXY_TYPES.has(proxyType);
}

// ===========================================================================
// Main classifier entry point
// ===========================================================================

/**
 * Codec-validate an incoming envelope and classify the inner frame
 * against the given side without mutating any state.
 *
 * The `side` parameter is validated at runtime; pass exactly "home"
 * or "sandbox".
 *
 * Both ACK frames and accepted domain frames produce
 * `{category:"relay", action:"receive", envelope}`, which feeds
 * the relay's `receive()` method (journal / application / ACK).
 * Control frames (handshake, handshake_ack, health, error) produce
 * `{category:"control"}` for transport-level handling.
 * Invalid direction and codec-error return category-only results
 * with no envelope or detail.
 *
 * @param side - The receiving side: "home" or "sandbox" (unknown,
 *               validated at runtime).
 * @param raw  - Raw unknown input (typically a parsed JSON object).
 * @returns A freshly constructed frozen `IngressClassification` result.
 */
export function classifyIngress(side: unknown, raw: unknown): IngressClassification {
	// 0. Runtime-validate side; reject unknown values
	if (!isValidSide(side)) {
		return buildInvalidDirection();
	}

	// 1. Codec-validate the envelope
	const decoded = decodeEnvelope(raw);
	if (!decoded.ok) {
		return buildCodecError();
	}

	const envelope = decoded.value;
	const frameType = envelope.frame.type;

	// 2. Control frames: transport-level handling, never domain
	if (CONTROL_FRAME_TYPES.has(frameType)) {
		return buildControl(envelope);
	}

	// 3. ACK frames feed relay.receive (unified with domain path)
	if (frameType === "ack") {
		return buildRelayReceive(envelope);
	}

	// 4. Domain frames: side-specific acceptance; all go to relay.receive
	if (side === "home") {
		if (!HOME_DOMAIN_FRAME_TYPES.has(frameType)) {
			return buildInvalidDirection();
		}
		if (frameType === "provider_proxy" && !isHomeProxyType(envelope.frame)) {
			return buildInvalidDirection();
		}
	} else {
		// side === "sandbox"
		if (!SANDBOX_DOMAIN_FRAME_TYPES.has(frameType)) {
			return buildInvalidDirection();
		}
		if (frameType === "provider_proxy" && !isSandboxProxyType(envelope.frame)) {
			return buildInvalidDirection();
		}
	}

	return buildRelayReceive(envelope);
}
