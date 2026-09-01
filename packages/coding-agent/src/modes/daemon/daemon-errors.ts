import { MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { SessionAlreadyActiveError } from "../../core/session-lease.js";
import type { DaemonErrorInfo, DaemonResponse } from "./daemon-protocol.js";

export class RlmChildRosterChangedError extends Error {
	constructor(
		readonly expectedRosterToken: string,
		readonly actualRosterToken: string,
	) {
		super("RLM child roster changed before cancellation; refresh the authoritative roster and retry");
		this.name = "RlmChildRosterChangedError";
	}
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
	if (error instanceof RlmChildRosterChangedError) {
		return {
			code: "rlm_child_roster_changed",
			expectedRosterToken: error.expectedRosterToken,
			actualRosterToken: error.actualRosterToken,
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
	if (errorInfo?.code === "rlm_child_roster_changed") {
		return new RlmChildRosterChangedError(errorInfo.expectedRosterToken, errorInfo.actualRosterToken);
	}
	return new Error(response.error);
}
