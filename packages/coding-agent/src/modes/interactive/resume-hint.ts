import { existsSync } from "node:fs";
import chalk from "chalk";
import { APP_NAME } from "../../config.js";
import type { SessionStats } from "../../core/session-stats.js";

export type ResumeHintStats = Pick<SessionStats, "sessionId" | "sessionFile" | "userMessages">;

/** Omit ephemeral and unflushed empty sessions because neither can be resumed. */
export function formatResumeHint(stats: ResumeHintStats | undefined): string | undefined {
	if (!stats?.sessionFile || stats.userMessages === 0) return undefined;
	// Persistence is lazy: nothing is written until the first assistant message
	// arrives, so exiting before then leaves no file to resume from.
	if (!existsSync(stats.sessionFile)) return undefined;
	return chalk.dim(`Resume this session with: ${APP_NAME} --resume ${stats.sessionId}`);
}
