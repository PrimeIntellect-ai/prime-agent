/**
 * Workspace Authority V1 — public verification result types.
 * No authority/handle/callback/helper/fd types exposed.
 */

export type WorkspaceVerificationCode = "OPEN_ROOT_FAILED" | "LOCK_FAILED" | "HELPER_FAILED" | "INTERNAL_ERROR";

export type WorkspaceVerificationResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; code: WorkspaceVerificationCode }>;
