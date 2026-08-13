import type { SessionInfo } from "./session-manager.js";
import { SessionManager } from "./session-manager.js";

/** Thrown when several sessions in the same directory carry the same name. */
export class AmbiguousSessionNameError extends Error {
	constructor(
		readonly name: string,
		readonly matches: SessionInfo[],
	) {
		super(`Several sessions in this directory are named "${name}". Use --list-sessions and open one by id.`);
		this.name = "AmbiguousSessionNameError";
	}
}

/**
 * Look up a session by its user-defined name within one working directory.
 * Names live in the session's own `session_info` entries, so there is no second index
 * to keep in sync and a name in one project can never resolve to another project's session.
 */
export async function findSessionByName(
	name: string,
	cwd: string,
	sessionDir?: string,
): Promise<SessionInfo | undefined> {
	const sessions = await SessionManager.list(cwd, sessionDir);
	const matches = sessions.filter((session) => session.name === name);
	if (matches.length > 1) {
		throw new AmbiguousSessionNameError(name, matches);
	}
	return matches[0];
}
