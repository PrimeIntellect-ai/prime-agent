/**
 * Shared constants and validators for remote observation (B11).
 * Neutral module with no imports — safe for both mirror and snapshot to import.
 */

export const KNOWN_OBSERVATION_ERROR_CODES: readonly [
	"INTERNAL_ERROR",
	"UNKNOWN_COMMAND",
	"INVALID_SESSION",
	"SESSION_DESTROYED",
	"SESSION_TIMEOUT",
	"COMPACT_FAILED",
	"CHECKPOINT_FAILED",
	"BASH_FAILED",
	"RESOURCE_EXHAUSTED",
	"UNAUTHORIZED",
	"PROTOCOL_ERROR",
	"BUILD_MISMATCH",
	"CAPABILITY_MISMATCH",
	"UNKNOWN",
] = Object.freeze([
	"INTERNAL_ERROR",
	"UNKNOWN_COMMAND",
	"INVALID_SESSION",
	"SESSION_DESTROYED",
	"SESSION_TIMEOUT",
	"COMPACT_FAILED",
	"CHECKPOINT_FAILED",
	"BASH_FAILED",
	"RESOURCE_EXHAUSTED",
	"UNAUTHORIZED",
	"PROTOCOL_ERROR",
	"BUILD_MISMATCH",
	"CAPABILITY_MISMATCH",
	"UNKNOWN",
]);

export type KnownObservationErrorCode = (typeof KNOWN_OBSERVATION_ERROR_CODES)[number];

/** Closed-set guard: only exact known error codes pass. */
export function isKnownObservationErrorCode(code: string): code is KnownObservationErrorCode {
	return (KNOWN_OBSERVATION_ERROR_CODES as readonly string[]).includes(code);
}
