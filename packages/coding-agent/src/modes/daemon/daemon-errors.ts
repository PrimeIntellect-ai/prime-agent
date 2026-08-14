import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

export class DaemonShutdownAuthorityError extends Error {
	readonly code = "shutdown_authority_rejected" as const;

	constructor() {
		super(
			"Daemon shutdown authority rejected: the connection's supervisor identity does not match the running supervisor",
		);
		this.name = "DaemonShutdownAuthorityError";
	}
}

export function serializeDaemonError(error: unknown): DaemonErrorInfo | undefined {
	if (error instanceof DaemonShutdownAuthorityError) {
		return { code: error.code };
	}
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
	if (errorInfo?.code === "shutdown_authority_rejected") {
		return new DaemonShutdownAuthorityError();
	}
	return new Error(response.error);
}
