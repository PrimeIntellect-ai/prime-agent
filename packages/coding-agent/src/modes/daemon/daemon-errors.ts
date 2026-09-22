import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

/** Rejection message for commands fenced out while the daemon prepares an update restart. */
export const UPDATE_RESTART_PREPARING_MESSAGE = "Daemon is preparing an update restart";

/** Machine-readable companion for {@link UPDATE_RESTART_PREPARING_MESSAGE} rejections. */
export const UPDATE_RESTART_PREPARING_ERROR_INFO: DaemonErrorInfo = { code: "update_restarting" };

/** A known session (a persisted descriptor names it) that cannot be routed to yet; retryable, unlike "Unknown active session". */
export class DaemonSessionRecoveringError extends Error {
	readonly code = "session_recovering" as const;

	constructor(readonly activeSessionId: string) {
		super(`Active session ${activeSessionId} is recovering; retry shortly`);
		this.name = "DaemonSessionRecoveringError";
	}
}

/**
 * The daemon is preparing an update restart: mutations (including session
 * opens) are rejected while the restart coordinator drains and checkpoints.
 * This is a normal transient state, so clients should wait through it and
 * retry, not surface it as a hard failure.
 */
export class DaemonUpdateRestartingError extends Error {
	readonly code = "update_restarting" as const;

	constructor(message = "Daemon is preparing an update restart") {
		super(message);
		this.name = "DaemonUpdateRestartingError";
	}
}

/**
 * True when an open failure is the update-restart transient state. Typed
 * errors come from current daemons; the exact-message fallback also recognizes
 * older daemons that reject with the same plain string.
 */
export function isDaemonUpdateRestartingError(error: unknown): boolean {
	return (
		error instanceof DaemonUpdateRestartingError ||
		(error instanceof Error && error.message === "Daemon is preparing an update restart")
	);
}

export function serializeDaemonError(error: unknown): DaemonErrorInfo | undefined {
	if (error instanceof MissingSessionCwdError) {
		return { code: "missing_session_cwd", issue: error.issue };
	}
	if (error instanceof SessionImportFileNotFoundError) {
		return { code: "session_import_file_not_found", filePath: error.filePath };
	}
	if (error instanceof SessionAlreadyActiveError) {
		return {
			code: "session_already_active",
			sessionPath: error.sessionPath,
			activeSessionId: error.activeSessionId,
		};
	}
	if (error instanceof DaemonSessionRecoveringError) {
		return { code: "session_recovering", activeSessionId: error.activeSessionId };
	}
	if (error instanceof DaemonUpdateRestartingError) {
		return { code: "update_restarting" };
	}
	return undefined;
}

export class DaemonSessionCreateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonSessionCreateError";
	}
}

/** Wraps untyped create failures so the CLI prints one line instead of rethrowing. */
export function deserializeDaemonCreateError(response: Extract<DaemonResponse, { success: false }>): Error {
	const error = deserializeDaemonError(response);
	if (response.errorInfo) return error;
	return new DaemonSessionCreateError(error.message);
}

export function deserializeDaemonError(response: Extract<DaemonResponse, { success: false }>): Error {
	const { errorInfo } = response;
	if (errorInfo?.code === "missing_session_cwd") {
		return new MissingSessionCwdError(errorInfo.issue);
	}
	if (errorInfo?.code === "session_import_file_not_found") {
		return new SessionImportFileNotFoundError(errorInfo.filePath);
	}
	if (errorInfo?.code === "session_already_active") {
		return new SessionAlreadyActiveError(errorInfo.sessionPath, errorInfo.activeSessionId);
	}
	if (errorInfo?.code === "session_recovering") {
		return new DaemonSessionRecoveringError(errorInfo.activeSessionId);
	}
	if (errorInfo?.code === "update_restarting") {
		return new DaemonUpdateRestartingError();
	}
	return new Error(response.error);
}
