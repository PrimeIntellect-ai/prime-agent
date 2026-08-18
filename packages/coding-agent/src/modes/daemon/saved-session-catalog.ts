import type { DeleteSessionFileResult } from "../../core/session-file-actions.js";
import type {
	AgentConnectionSavedSessionInfo,
	AgentConnectionSavedSessionScope,
	AgentConnectionSessionListCallbacks,
} from "../agent-connection/types.js";
import type { DaemonClient } from "./daemon-client.js";
import { deserializeDaemonError } from "./daemon-errors.js";
import type {
	DaemonCommand,
	DaemonDeleteSavedSessionResult,
	DaemonSavedSessionInfo,
	DaemonSavedSessionListCommand,
} from "./daemon-protocol.js";
import { deserializeSavedSessionInfo } from "./saved-session-info.js";

export { deserializeSavedSessionInfo } from "./saved-session-info.js";

export type DaemonSavedSessionCatalogContext = { activeSessionId: string } | { cwd: string; sessionDir?: string };

export async function listDaemonSavedSessions(
	client: DaemonClient,
	context: DaemonSavedSessionCatalogContext,
	scope: AgentConnectionSavedSessionScope,
	callbacks?: AgentConnectionSessionListCallbacks,
): Promise<AgentConnectionSavedSessionInfo[]> {
	const command: DaemonSavedSessionListCommand =
		"activeSessionId" in context
			? { type: "list_saved_sessions", activeSessionId: context.activeSessionId, scope }
			: { type: "list_saved_sessions", cwd: context.cwd, sessionDir: context.sessionDir, scope };
	const response = await client.request(command, 30000, {
		onProgress: (update) => {
			if (update.type === "session_list_progress") {
				callbacks?.onProgress?.(update.loaded, update.total);
			} else {
				callbacks?.onSession?.(deserializeSavedSessionInfo(update.session));
			}
		},
	});
	if (!response.success) {
		throw deserializeDaemonError(response);
	}
	const data = response.data as { sessions: DaemonSavedSessionInfo[] };
	return data.sessions.map(deserializeSavedSessionInfo);
}

export async function renameDaemonSavedSession(
	client: DaemonClient,
	context: DaemonSavedSessionCatalogContext,
	sessionPath: string,
	name: string,
): Promise<void> {
	const command: Extract<DaemonCommand, { type: "rename_saved_session" }> =
		"activeSessionId" in context
			? { type: "rename_saved_session", activeSessionId: context.activeSessionId, sessionPath, name }
			: { type: "rename_saved_session", sessionPath, name };
	const response = await client.request(command);
	if (!response.success) {
		throw deserializeDaemonError(response);
	}
}

export async function deleteDaemonSavedSession(
	client: DaemonClient,
	context: DaemonSavedSessionCatalogContext,
	sessionPath: string,
): Promise<DeleteSessionFileResult> {
	const command: Extract<DaemonCommand, { type: "delete_saved_session" }> =
		"activeSessionId" in context
			? { type: "delete_saved_session", activeSessionId: context.activeSessionId, sessionPath }
			: { type: "delete_saved_session", sessionPath };
	const response = await client.request(command);
	if (!response.success) {
		throw deserializeDaemonError(response);
	}
	return response.data as DaemonDeleteSavedSessionResult;
}
