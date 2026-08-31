import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

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
	return undefined;
}

export class DaemonSessionCreateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DaemonSessionCreateError";
	}
}

/**
 * Create failures without a dedicated typed error are wrapped so the CLI can
 * surface them as a clean one-line error instead of an unhandled throw.
 */
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
	return new Error(response.error);
}
