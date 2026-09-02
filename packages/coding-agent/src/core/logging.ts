import { type LogEntry, setLogSink, stringifyLogEntry } from "@prime-intellect/prime-agent-ai";
import { appendRotatingLog, getAgentLogPath } from "../config.js";

const AGENT_LOG_MAX_BYTES = 20 * 1024 * 1024;

let context: Record<string, unknown> = {};

/** Merge late-bound fields (e.g. mode, sessionId) into every subsequent log entry. */
export function setLogContext(fields: Record<string, unknown>): void {
	Object.assign(context, fields);
}

/**
 * Route all structured logging (coding-agent and pi-ai) to the shared JSONL
 * log at ~/.prime/agent/logs/agent.jsonl. One master file, filterable by the
 * pid/context fields; writes are best-effort and size-bounded.
 */
export function installFileLogSink(fields?: Record<string, unknown>): void {
	context = { pid: process.pid, ...fields };
	setLogSink((entry: LogEntry) => {
		appendRotatingLog(getAgentLogPath(), stringifyLogEntry({ ...entry, ...context }), AGENT_LOG_MAX_BYTES);
	});
}
