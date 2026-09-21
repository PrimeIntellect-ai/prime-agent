import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getAgentLogPath, getLogsDir } from "../config.js";

/**
 * `prime-agent incident` reconstructs what the daemon did during a time window
 * from its diagnostic logs, so an operator does not have to grep hundreds of
 * raw log lines by hand. The primary source is the shared structured log
 * (~/.prime/agent/logs/agent.jsonl, one JSON object per line, written by the
 * coding-agent.daemon-supervisor, coding-agent.daemon, and ai.provider
 * components). When that file is missing or unreadable, the newest per-daemon
 * log file (~/.prime/agent/logs/<socket>.<hash>.log, plain-text lines) is used
 * as a fallback.
 *
 * Message shapes below match the strings the supervisor and session worker
 * actually emit (the DaemonSupervisor.log / DaemonMode.log call sites).
 * Unknown warning lines fall through to a generic per-line summary so new log
 * messages degrade to a readable timeline instead of disappearing.
 */

export type IncidentSeverity = "critical" | "error" | "warn" | "info";

export type IncidentCategory = "supervisor" | "anomaly" | "recovery";

export interface IncidentLogEntry {
	timeMs: number;
	level: string;
	component: string;
	msg: string;
	socketPath?: string;
	pid?: number;
	/** Raw log-record fields, used for provider failure details (kind/status). */
	fields: Record<string, unknown>;
}

export interface IncidentEvent {
	timeMs: number;
	severity: IncidentSeverity;
	category: IncidentCategory;
	eventClass: string;
	subject: string;
	summary: string;
	tokens: string[];
}

export interface IncidentCommandOptions {
	since?: string;
	until?: string;
	session?: string;
}

export interface IncidentReportOptions {
	sinceMs: number;
	untilMs: number;
	session?: string;
	source?: string;
	scannedCount?: number;
	skippedCount?: number;
}

export interface IncidentReport {
	text: string;
}

export interface IncidentLogSource {
	entries: IncidentLogEntry[];
	scannedCount: number;
	skippedCount: number;
	source: string;
}

export class IncidentUsageError extends Error {}

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALL_GAP_MS = 10 * 60 * 1000;
const ERROR_BURST_THRESHOLD = 3;
/** A burst is several warnings/errors close together; isolated failures far apart are not one incident. */
const ERROR_BURST_WINDOW_MS = 10 * 60 * 1000;
/**
 * A stall is repeated command timeouts close together, like the burst window
 * above; timeouts further apart than this never merge into one stall, whatever
 * the report window is. The agents-view dismissal horizon derives from the
 * same bound via latestIncidentStallTimeoutBySubject.
 */
const TIMEOUT_STALL_WINDOW_MS = 30 * 60 * 1000;
const SUMMARY_TRUNCATION = 120;
const RECOVERY_BREAKDOWN_LIMIT = 4;
const WORKER_SOCKET_PATTERN = /^(?:prime-agent-)?worker-[0-9a-f]+-([0-9a-f]{12})(?:\.sock)?$/;
// Per-daemon logs are named `<socket basename>.<hash8>.log` (config.ts
// getDaemonLogPath); the socket basename itself may lack `.sock` for custom
// sockets and Windows named pipes, so key on the hash suffix instead.
const DAEMON_LOG_FILE_PATTERN = /\.[0-9a-f]{8}\.log$/;
const BURST_CLASSES = new Set(["command-failure", "auth", "diagnostic"]);
const LIFECYCLE_CLASSES = new Set(["worker-start", "worker-stop", "worker-crash", "worker-passivation"]);

// ---------------------------------------------------------------------------
// Time parsing
// ---------------------------------------------------------------------------

const FULL_TIME_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const TIME_ONLY_PATTERN = /^(\d{2}):(\d{2})$/;

/**
 * Parse a --since/--until bound. Times without a timezone are read as UTC,
 * matching the timestamps the daemon logs; "20:02" means today at 20:02 UTC.
 */
export function parseIncidentTimeBound(value: string, now: Date, flag: string): number {
	const raw = value.trim();
	if (!raw) {
		throw new IncidentUsageError(`${flag} requires a time.`);
	}
	const invalid = () =>
		new IncidentUsageError(
			`Invalid time for ${flag}: "${value}". Use "2026-09-16T20:02", "2026-09-16", or "20:02" (today, UTC).`,
		);
	const timeOnly = TIME_ONLY_PATTERN.exec(raw);
	if (timeOnly) {
		const hour = Number(timeOnly[1]);
		const minute = Number(timeOnly[2]);
		if (hour > 23 || minute > 59) {
			throw invalid();
		}
		return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute);
	}
	const full = FULL_TIME_PATTERN.exec(raw);
	if (!full) {
		throw invalid();
	}
	const [, year, month, day, hour, minute, second, fraction, zone] = full;
	const baseMs = Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		hour !== undefined ? Number(hour) : 0,
		minute !== undefined ? Number(minute) : 0,
		second !== undefined ? Number(second) : 0,
		fraction !== undefined ? Number(fraction.padEnd(3, "0")) : 0,
	);
	const base = new Date(baseMs);
	if (
		base.getUTCFullYear() !== Number(year) ||
		base.getUTCMonth() !== Number(month) - 1 ||
		base.getUTCDate() !== Number(day) ||
		(hour !== undefined && base.getUTCHours() !== Number(hour)) ||
		(minute !== undefined && base.getUTCMinutes() !== Number(minute))
	) {
		throw invalid();
	}
	if (!zone || zone === "Z") {
		return baseMs;
	}
	const sign = zone[0] === "-" ? -1 : 1;
	const digits = zone.slice(1).replace(":", "");
	const offsetMinute = Number(digits.slice(2) || 0);
	const offsetMinutes = Number(digits.slice(0, 2)) * 60 + offsetMinute;
	if (!Number.isFinite(offsetMinutes) || offsetMinutes >= 24 * 60 || offsetMinute >= 60) {
		throw invalid();
	}
	return baseMs - sign * offsetMinutes * 60_000;
}

// ---------------------------------------------------------------------------
// Log line parsing
// ---------------------------------------------------------------------------

function timestampToMs(ts: string): number {
	const ms = Date.parse(ts);
	return Number.isNaN(ms) ? Number.NaN : ms;
}

/** Parse one agent.jsonl line; malformed lines return undefined. */
export function parseIncidentLogLine(line: string): IncidentLogEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	if (typeof record.ts !== "string" || typeof record.msg !== "string") {
		return undefined;
	}
	const timeMs = timestampToMs(record.ts);
	if (!Number.isFinite(timeMs)) {
		return undefined;
	}
	return {
		timeMs,
		level: typeof record.level === "string" ? record.level : "warn",
		component: typeof record.component === "string" ? record.component : "unknown",
		msg: record.msg,
		...(typeof record.socketPath === "string" ? { socketPath: record.socketPath } : {}),
		...(typeof record.pid === "number" ? { pid: record.pid } : {}),
		fields: record,
	};
}

/** Parse one per-daemon log line: `[<ISO>] supervisor: <msg>` or `[<ISO>] <msg>`. */
export function parseIncidentDaemonLogLine(line: string): IncidentLogEntry | undefined {
	const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line.trim());
	if (!match) {
		return undefined;
	}
	const [, ts, rest] = match;
	if (!ts || rest === undefined || !rest.trim()) {
		return undefined;
	}
	const timeMs = timestampToMs(ts);
	if (!Number.isFinite(timeMs)) {
		return undefined;
	}
	const supervisorLine = rest.startsWith("supervisor:");
	const msg = supervisorLine ? rest.slice("supervisor:".length).trim() : rest;
	if (!msg) {
		return undefined;
	}
	return {
		timeMs,
		level: "warn",
		component: supervisorLine ? "coding-agent.daemon-supervisor" : "coding-agent.daemon",
		msg,
		fields: {},
	};
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function firstLine(text: string): string {
	return text.split("\n")[0]!.trim();
}

function truncateText(text: string, max: number): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function errorMessage(message: string): string {
	return message.replace(/^Error:\s*/, "");
}

function workerIdFromSocketPath(socketPath: string | undefined): string | undefined {
	if (!socketPath) {
		return undefined;
	}
	// Split on both separators so Windows named-pipe paths (`\\.\pipe\...`)
	// resolve to their last segment on any platform, not only on win32.
	const name = socketPath.split(/[\\/]/).pop()!;
	return WORKER_SOCKET_PATTERN.exec(name)?.[1];
}

/** One log sighting of a worker id owning a pid at a timestamp. */
export interface WorkerPidSighting {
	timeMs: number;
	workerId: string;
}

/**
 * pid -> worker-id sightings, ordered by time. A pid can be reused by a later
 * worker, so attribution picks the owner at the event time, not the union of
 * every id ever seen on the pid.
 */
export type WorkerPidMap = ReadonlyMap<number, ReadonlyArray<WorkerPidSighting>>;

/** Map pid -> worker-id sightings from entries whose socket path names a worker socket. */
export function collectWorkerPidMap(entries: readonly IncidentLogEntry[]): WorkerPidMap {
	const map = new Map<number, WorkerPidSighting[]>();
	for (const entry of entries) {
		const workerId = workerIdFromSocketPath(entry.socketPath);
		if (workerId === undefined || entry.pid === undefined) {
			continue;
		}
		const sightings = map.get(entry.pid) ?? [];
		sightings.push({ timeMs: entry.timeMs, workerId });
		map.set(entry.pid, sightings);
	}
	for (const sightings of map.values()) {
		sightings.sort((a, b) => a.timeMs - b.timeMs);
	}
	return map;
}

/** The worker that owned `pid` at `timeMs`: the latest sighting at or before it. */
function workerIdForPid(workerPids: WorkerPidMap, pid: number | undefined, timeMs: number): string | undefined {
	if (pid === undefined) {
		return undefined;
	}
	const sightings = workerPids.get(pid);
	if (sightings === undefined || sightings.length === 0) {
		return undefined;
	}
	let workerId: string | undefined;
	for (const sighting of sightings) {
		if (sighting.timeMs <= timeMs) {
			workerId = sighting.workerId;
		} else {
			break;
		}
	}
	return workerId;
}

function classifyCommandFailure(
	command: string,
	error: string,
): {
	severity: IncidentSeverity;
	eventClass: string;
	summary: string;
	tokens: string[];
} {
	const err = firstLine(error);
	if (err.includes("Timed out waiting for daemon worker response")) {
		return {
			severity: "error",
			eventClass: "timeout",
			summary: `command ${command} failed: timed out waiting for worker response`,
			tokens: [],
		};
	}
	if (/authentication failed/i.test(err)) {
		return {
			severity: "error",
			eventClass: "auth",
			summary: `command ${command} failed: worker authentication failed`,
			tokens: [],
		};
	}
	if (err.includes("Session worker is starting")) {
		return {
			severity: "warn",
			eventClass: "command-failure",
			summary: `command ${command} failed: session worker is starting`,
			tokens: [],
		};
	}
	if (err.includes("preparing an update")) {
		return {
			severity: "info",
			eventClass: "command-failure",
			summary: `command ${command} failed: update restart in preparation`,
			tokens: [],
		};
	}
	if (err.includes("Session worker is recovering")) {
		return {
			severity: "warn",
			eventClass: "command-failure",
			summary: `command ${command} failed: session worker is recovering`,
			tokens: [],
		};
	}
	const unknownSession = /Unknown active session: (\S+)/.exec(err);
	if (unknownSession) {
		const sessionId = unknownSession[1]!;
		return {
			severity: "warn",
			eventClass: "command-failure",
			summary: `command ${command} failed: unknown active session ${sessionId}`,
			tokens: [sessionId],
		};
	}
	// Quoted strings can carry session names (e.g. Agent name "Faerie").
	const quotedNames = [...err.matchAll(/"([^"\n]+)"/g)].map((match) => match[1]!);
	return {
		severity: "warn",
		eventClass: "command-failure",
		summary: `command ${command} failed: ${truncateText(errorMessage(err), 100)}`,
		tokens: quotedNames,
	};
}

/** Classify the body of a `Session worker <id> stderr: <body>` log line. */
function classifyWorkerStderrBody(
	workerId: string,
	body: string,
	includeGeneric = true,
): Omit<IncidentEvent, "timeMs" | "category"> | undefined {
	const tokens = [workerId];
	if (!body.trim() || /^\s*at\s/.test(body)) {
		// Stack frames and blank lines belong to the previous stderr event.
		return undefined;
	}
	const line = firstLine(body);
	if (/^Prime Agent daemon listening on \S+$/.test(line)) {
		return {
			severity: "info",
			eventClass: "worker-start",
			subject: `worker ${workerId}`,
			summary: `worker ${workerId} started`,
			tokens,
		};
	}
	const crash = /^(?:uncaught exception|unhandled rejection): (.+)$/.exec(line);
	if (crash) {
		return {
			severity: "critical",
			eventClass: "worker-crash",
			subject: `worker ${workerId}`,
			summary: `worker ${workerId} crashed: ${truncateText(line, 100)}`,
			tokens,
		};
	}
	const shutdown = /^shutting down \(exit (\d+)\); closing (\d+) active session\(s\)$/.exec(line);
	if (shutdown) {
		return {
			severity: "info",
			eventClass: "worker-stop",
			subject: `worker ${workerId}`,
			summary: `worker ${workerId} stopped (exit ${shutdown[1]}, ${shutdown[2]} session(s) closed)`,
			tokens,
		};
	}
	const signal = /^received (\S+); shutting down$/.exec(line);
	if (signal) {
		return {
			severity: "info",
			eventClass: "worker-stop",
			subject: `worker ${workerId}`,
			summary: `worker ${workerId} received ${signal[1]}; shutting down`,
			tokens,
		};
	}
	const stopRequested = /^shutdown command received over socket; (\d+) active session\(s\) will be closed$/.exec(line);
	if (stopRequested) {
		return {
			severity: "info",
			eventClass: "worker-stop",
			subject: `worker ${workerId}`,
			summary: `worker ${workerId} stop requested (${stopRequested[1]} active session(s))`,
			tokens,
		};
	}
	const passivated = /^Passivated idle child sessionId=(\S+) name=("[^"]*"|\S+) idleMinutes=(\d+)$/.exec(line);
	if (passivated) {
		// A missing session name logs as `name=""`; that empty token must not
		// become a filter key.
		const name = passivated[2].replace(/^"|"$/g, "");
		return {
			severity: "info",
			eventClass: "worker-passivation",
			subject: `session ${passivated[1]}`,
			summary: `passivated idle child session ${passivated[1]} (idle ${passivated[3]}m)`,
			tokens: name ? [workerId, passivated[1]!, name] : [workerId, passivated[1]!],
		};
	}
	if (!includeGeneric) {
		return undefined;
	}
	return {
		severity: "warn",
		eventClass: "worker-stderr",
		subject: `worker ${workerId}`,
		summary: `worker ${workerId} stderr: ${truncateText(line, 100)}`,
		tokens,
	};
}

function recoveryBreakdown(operations: string): { count: number; breakdown: string } {
	const list = operations
		.split(",")
		.map((operation) => operation.trim())
		.filter(Boolean);
	if (list.length === 0) {
		return { count: 0, breakdown: "none listed" };
	}
	const counts = new Map<string, number>();
	for (const operation of list) {
		counts.set(operation, (counts.get(operation) ?? 0) + 1);
	}
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const top = ranked.slice(0, RECOVERY_BREAKDOWN_LIMIT);
	const shownCount = top.reduce((sum, [, count]) => sum + count, 0);
	const rest = ranked.length > RECOVERY_BREAKDOWN_LIMIT ? `, +${list.length - shownCount} more` : "";
	const breakdown = top.map(([operation, count]) => `${operation} x${count}`).join(", ");
	return { count: list.length, breakdown: `${breakdown}${rest}` };
}

function event(
	entry: IncidentLogEntry,
	severity: IncidentSeverity,
	category: IncidentCategory,
	eventClass: string,
	subject: string,
	summary: string,
	tokens: string[] = [],
): IncidentEvent {
	return { timeMs: entry.timeMs, severity, category, eventClass, subject, summary, tokens };
}

/**
 * Key events on the entry's socket path so anomalies and aggregation never
 * mix entries from different daemons sharing one agent.jsonl; entries without
 * a socket field (the per-daemon fallback log) key on `daemon`.
 */
function daemonSubject(entry: IncidentLogEntry): string {
	return entry.socketPath ?? "daemon";
}

/** Classify a provider-failure entry into an aggregate-friendly anomaly event. */
function providerFailureEvent(entry: IncidentLogEntry, workerPids: WorkerPidMap): IncidentEvent | undefined {
	const workerId = workerIdForPid(workerPids, entry.pid, entry.timeMs);
	const subject = workerId ? `worker ${workerId}` : entry.pid !== undefined ? `pid ${entry.pid}` : "provider";
	if (entry.msg !== "provider stream failure") {
		return event(
			entry,
			"error",
			"anomaly",
			"provider",
			subject,
			truncateText(firstLine(entry.msg), SUMMARY_TRUNCATION),
			[],
		);
	}
	const kind = typeof entry.fields.kind === "string" ? entry.fields.kind : "unknown";
	const statusText = typeof entry.fields.status === "number" ? ` ${entry.fields.status}` : "";
	return {
		timeMs: entry.timeMs,
		severity: "error",
		category: "anomaly",
		eventClass: "provider",
		subject,
		summary: `provider stream failure (${kind}${statusText}) for ${subject}`,
		tokens: workerId ? [workerId] : [],
	};
}

/** Classify one log entry into an incident event; undefined when the entry is noise. */
export function classifyIncidentEntry(entry: IncidentLogEntry, workerPids: WorkerPidMap): IncidentEvent | undefined {
	const msg = firstLine(entry.msg);
	const workerId = workerIdFromSocketPath(entry.socketPath);

	if (entry.component === "ai.provider") {
		return providerFailureEvent(entry, workerPids);
	}

	const stderr = /^Session worker ([0-9a-f]{12}) stderr: ?([\s\S]*)$/.exec(entry.msg);
	if (stderr) {
		const body = classifyWorkerStderrBody(stderr[1]!, stderr[2] ?? "");
		if (!body) {
			return undefined;
		}
		return { ...body, timeMs: entry.timeMs, category: "supervisor" };
	}

	if (/^Prime Agent daemon supervisor \S+ listening on \S+$/.test(msg)) {
		return event(
			entry,
			"info",
			"supervisor",
			"supervisor-start",
			daemonSubject(entry),
			"daemon supervisor listening",
		);
	}
	const startupFailed = /^Daemon supervisor startup failed: (.+)$/.exec(msg);
	if (startupFailed) {
		const err = startupFailed[1]!;
		if (/lock file is already being held/i.test(err)) {
			return event(
				entry,
				"warn",
				"supervisor",
				"supervisor-start",
				daemonSubject(entry),
				"supervisor startup blocked: another daemon holds the lock",
			);
		}
		return event(
			entry,
			"error",
			"supervisor",
			"supervisor-start",
			daemonSubject(entry),
			`supervisor startup failed: ${truncateText(errorMessage(firstLine(err)), 100)}`,
		);
	}
	const supervisorCommand = /^Supervisor command (\S+) failed: (.+)$/.exec(msg);
	if (supervisorCommand) {
		const classified = classifyCommandFailure(supervisorCommand[1]!, supervisorCommand[2]!);
		return event(
			entry,
			classified.severity,
			"supervisor",
			classified.eventClass,
			daemonSubject(entry),
			classified.summary,
			classified.tokens,
		);
	}
	const daemonCommand = /^daemon command "([^"]+)" failed: (.+)$/.exec(msg);
	if (daemonCommand) {
		const classified = classifyCommandFailure(daemonCommand[1]!, daemonCommand[2]!);
		return event(
			entry,
			classified.severity,
			"supervisor",
			classified.eventClass,
			workerId ? `worker ${workerId}` : "worker",
			classified.summary,
			// Keep the session ids/names classified out of the error, not just the worker id.
			workerId ? [workerId, ...classified.tokens] : classified.tokens,
		);
	}
	const catchUp = /^(?:Failed|could not)(?: to)? catch up (?:snapshot )?client \S+(?: for (\S+))?: (.+)$/.exec(msg);
	if (catchUp) {
		const sessionId = catchUp[1];
		const err = catchUp[2]!;
		const timedOut = err.includes("Timed out waiting for daemon worker response");
		return event(
			entry,
			timedOut ? "error" : "warn",
			"supervisor",
			timedOut ? "timeout" : "command-failure",
			sessionId ? `session ${sessionId}` : daemonSubject(entry),
			`client catch-up failed${sessionId ? ` for session ${sessionId}` : ""}: ${truncateText(errorMessage(firstLine(err)), 100)}`,
			sessionId ? [sessionId] : [],
		);
	}
	const heartbeats = /^Could not list heartbeats from a worker: (.+)$/.exec(msg);
	if (heartbeats) {
		const timedOut = heartbeats[1]!.includes("Timed out waiting for daemon worker response");
		return event(
			entry,
			timedOut ? "error" : "warn",
			"supervisor",
			timedOut ? "timeout" : "command-failure",
			daemonSubject(entry),
			`worker heartbeat list failed: ${truncateText(errorMessage(firstLine(heartbeats[1]!)), 100)}`,
		);
	}

	const recovered = /^Recovered worker (\S+) without replaying uncertain operations: (.+)$/.exec(msg);
	if (recovered) {
		const worker = recovered[1]!;
		const { count, breakdown } = recoveryBreakdown(recovered[2]!);
		return event(
			entry,
			"warn",
			"recovery",
			"recovery-replay",
			`worker ${worker}`,
			`worker ${worker} recovered; ${count} uncertain operation${count === 1 ? "" : "s"} not replayed (${breakdown})`,
			[worker],
		);
	}
	const recoveredPlain = /^Recovered worker (\S+)$/.exec(msg);
	if (recoveredPlain) {
		const worker = recoveredPlain[1]!;
		return event(entry, "info", "recovery", "recovery-replay", `worker ${worker}`, `worker ${worker} recovered`, [
			worker,
		]);
	}
	const adoptFailed = /^Could not adopt worker (\S+): (.+)$/.exec(msg);
	if (adoptFailed) {
		const worker = adoptFailed[1]!;
		return event(
			entry,
			"warn",
			"recovery",
			"recovery-failure",
			`worker ${worker}`,
			`could not adopt worker ${worker}: ${truncateText(errorMessage(firstLine(adoptFailed[2]!)), 100)}`,
			[worker],
		);
	}
	const recoverFailed = /^Could not recover worker (\S+): (.+)$/.exec(msg);
	if (recoverFailed) {
		const worker = recoverFailed[1]!;
		return event(
			entry,
			"error",
			"recovery",
			"recovery-failure",
			`worker ${worker}`,
			`could not recover worker ${worker}: ${truncateText(errorMessage(firstLine(recoverFailed[2]!)), 100)}`,
			[worker],
		);
	}
	const failedAfterRetries = /^Worker (\S+) failed after three recovery attempts$/.exec(msg);
	if (failedAfterRetries) {
		const worker = failedAfterRetries[1]!;
		return event(
			entry,
			"error",
			"recovery",
			"recovery-failure",
			`worker ${worker}`,
			`worker ${worker} failed after three recovery attempts`,
			[worker],
		);
	}
	const unresponsive = /^Worker (\S+) is unresponsive; parked failed after \d+ probe rounds$/.exec(msg);
	if (unresponsive) {
		const worker = unresponsive[1]!;
		return event(entry, "error", "recovery", "recovery-failure", `worker ${worker}`, msg, [worker]);
	}
	const reclaimed = /^Reclaimed stale registration for stopped worker (\S+)$/.exec(msg);
	if (reclaimed) {
		const worker = reclaimed[1]!;
		return event(
			entry,
			"info",
			"recovery",
			"recovery-action",
			`worker ${worker}`,
			`reclaimed stale registration for stopped worker ${worker}`,
			[worker],
		);
	}
	const migrated = /^Migrated (\d+) scheduled jobs into session artifacts$/.exec(msg);
	if (migrated) {
		return event(
			entry,
			"info",
			"recovery",
			"recovery-action",
			daemonSubject(entry),
			`migrated ${migrated[1]} scheduled jobs into session artifacts`,
		);
	}
	const replacement = /^launched replacement supervisor on \S+$/.exec(msg);
	if (replacement) {
		return event(entry, "info", "recovery", "recovery-action", daemonSubject(entry), msg);
	}
	const woke = /^Woke session worker for a due scheduled job: \S+$/.exec(msg);
	if (woke) {
		// A scheduled wake is a supervisor lifecycle action, not crash recovery.
		return event(entry, "info", "supervisor", "supervisor-action", daemonSubject(entry), msg);
	}

	const evictedIdle = /^Evicted idle worker (\S+) root=\S* idleMinutes=(\d+) sessions=(\d+)$/.exec(msg);
	if (evictedIdle) {
		const worker = evictedIdle[1]!;
		return event(
			entry,
			"info",
			"supervisor",
			"worker-stop",
			`worker ${worker}`,
			`evicted idle worker ${worker} (idle ${evictedIdle[2]}m, ${evictedIdle[3]} session(s))`,
			[worker],
		);
	}
	const evictedEmpty = /^Evicted empty session worker (\S+) root=\S+ on last client detach$/.exec(msg);
	if (evictedEmpty) {
		const worker = evictedEmpty[1]!;
		return event(
			entry,
			"info",
			"supervisor",
			"worker-stop",
			`worker ${worker}`,
			`evicted empty session worker ${worker} on last detach`,
			[worker],
		);
	}

	if (entry.component === "coding-agent.daemon") {
		// The worker logs its own lifecycle lines; reusing the stderr-body
		// classifier gives them the same summaries as the supervisor's stderr
		// forward, so the duplicated log pair collapses in the timeline.
		if (workerId !== undefined) {
			const body = classifyWorkerStderrBody(workerId, msg, false);
			if (body) {
				return { ...body, timeMs: entry.timeMs, category: "supervisor" };
			}
		} else if (/^(?:uncaught exception|unhandled rejection): /.test(msg)) {
			return event(
				entry,
				"critical",
				"supervisor",
				"worker-crash",
				"worker",
				`worker crashed: ${truncateText(msg, 100)}`,
			);
		}
	}

	if (entry.component === "coding-agent.daemon-supervisor" || entry.component === "coding-agent.daemon") {
		// Unknown diagnostics still matter during an incident; summarize them.
		return event(
			entry,
			entry.level === "error" ? "error" : "warn",
			"supervisor",
			"diagnostic",
			workerId ? `worker ${workerId}` : daemonSubject(entry),
			truncateText(msg, SUMMARY_TRUNCATION),
		);
	}
	return undefined;
}

/**
 * Classify every entry, dropping the duplicate event the daemon writes both
 * to the structured log and to the worker stderr forward (same summary, same
 * second).
 */
export function collectIncidentEvents(entries: readonly IncidentLogEntry[], workerPids: WorkerPidMap): IncidentEvent[] {
	const events: IncidentEvent[] = [];
	const lastSeen = new Map<string, { timeMs: number; component: string }>();
	for (const entry of entries) {
		const incident = classifyIncidentEntry(entry, workerPids);
		if (!incident) {
			continue;
		}
		// The daemon writes the same lifecycle event both to the structured log
		// (coding-agent.daemon) and to the worker stderr forward
		// (coding-agent.daemon-supervisor); drop the second copy when it lands
		// within 2s. A repeat from the SAME component is a real lifecycle
		// transition — a worker restarted on its durable id within 2s — and is
		// never a duplicate.
		if (LIFECYCLE_CLASSES.has(incident.eventClass)) {
			const key = `${incident.category}|${incident.summary}`;
			const previous = lastSeen.get(key);
			if (
				previous !== undefined &&
				previous.component !== entry.component &&
				Math.abs(incident.timeMs - previous.timeMs) <= 2000
			) {
				continue;
			}
			lastSeen.set(key, { timeMs: incident.timeMs, component: entry.component });
		}
		events.push(incident);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Anomaly computation
// ---------------------------------------------------------------------------

function formatIncidentDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const seconds = totalSeconds % 60;
	const minutes = Math.floor(totalSeconds / 60) % 60;
	const hours = Math.floor(totalSeconds / 3600);
	if (hours > 0) {
		return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
	}
	if (minutes > 0) {
		return `${minutes}m${seconds > 0 ? `${seconds}s` : ""}`;
	}
	return `${seconds}s`;
}

function maxSeverity(events: readonly IncidentEvent[]): IncidentSeverity {
	let severity: IncidentSeverity = "info";
	for (const item of events) {
		if (item.severity === "critical") return "critical";
		if (item.severity === "error") severity = "error";
		else if (item.severity === "warn" && severity !== "error") severity = "warn";
	}
	return severity;
}

/**
 * The densest run of time-sorted events within windowMs of each other,
 * returned as the run's start index and length. Shared by the stall and burst
 * scans: only events close together form one incident, so isolated events far
 * apart never merge, whatever the report window is.
 */
function densestWindowRun(items: readonly IncidentEvent[], windowMs: number): { start: number; count: number } {
	let bestStart = 0;
	let bestCount = 0;
	let start = 0;
	for (let end = 0; end < items.length; end++) {
		while (items[end]!.timeMs - items[start]!.timeMs > windowMs) {
			start++;
		}
		const count = end - start + 1;
		if (count > bestCount) {
			bestCount = count;
			bestStart = start;
		}
	}
	return { start: bestStart, count: bestCount };
}

/** Compute stall, error-burst, and event-gap anomaly lines from classified events. */
export function computeIncidentAnomalies(events: readonly IncidentEvent[]): IncidentEvent[] {
	const bySubject = new Map<string, IncidentEvent[]>();
	for (const incident of events) {
		if (incident.category === "anomaly") {
			continue;
		}
		const group = bySubject.get(incident.subject) ?? [];
		group.push(incident);
		bySubject.set(incident.subject, group);
	}

	const anomalies: IncidentEvent[] = [];
	const push = (timeMs: number, severity: IncidentSeverity, subject: string, summary: string) => {
		anomalies.push({ timeMs, severity, category: "anomaly", eventClass: "anomaly", subject, summary, tokens: [] });
	};

	for (const [subject, group] of bySubject) {
		group.sort((a, b) => a.timeMs - b.timeMs);
		const timeouts = group.filter((incident) => incident.eventClass === "timeout");
		if (timeouts.length >= 2) {
			// Only timeouts within TIMEOUT_STALL_WINDOW_MS of each other form a
			// stall; two isolated timeouts hours apart in a long window are not one.
			const run = densestWindowRun(timeouts, TIMEOUT_STALL_WINDOW_MS);
			if (run.count >= 2) {
				const cluster = timeouts.slice(run.start, run.start + run.count);
				const span = cluster[cluster.length - 1]!.timeMs - cluster[0]!.timeMs;
				push(
					cluster[0]!.timeMs,
					"error",
					subject,
					`${subject}: ${cluster.length} command timeouts over ${formatIncidentDuration(span)}`,
				);
			}
		}
		const burst = group.filter((incident) => BURST_CLASSES.has(incident.eventClass));
		if (burst.length >= ERROR_BURST_THRESHOLD) {
			// Only events within ERROR_BURST_WINDOW_MS of each other form a burst;
			// three isolated warnings days apart in a long window are not one.
			const run = densestWindowRun(burst, ERROR_BURST_WINDOW_MS);
			if (run.count >= ERROR_BURST_THRESHOLD) {
				const cluster = burst.slice(run.start, run.start + run.count);
				const span = cluster[cluster.length - 1]!.timeMs - cluster[0]!.timeMs;
				push(
					cluster[0]!.timeMs,
					maxSeverity(cluster),
					subject,
					`${subject}: ${cluster.length} warnings/errors over ${formatIncidentDuration(span)}`,
				);
			}
		}
		if (subject.startsWith("session ")) {
			for (let index = 1; index < group.length; index++) {
				const gap = group[index]!.timeMs - group[index - 1]!.timeMs;
				if (gap >= STALL_GAP_MS) {
					push(
						group[index - 1]!.timeMs,
						"warn",
						subject,
						`${subject}: ${formatIncidentDuration(gap)} event gap (no logged events)`,
					);
				}
			}
		}
	}
	return anomalies.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Per subject, the latest timeout of the stall cluster computeIncidentAnomalies
 * reports — the densest run within TIMEOUT_STALL_WINDOW_MS. The agents-view
 * notice anchors its dismissal horizon there, so the notice, its horizon, and
 * the reported cluster always describe the same incident, even when the window
 * holds several stalls on one subject.
 */
export function latestIncidentStallTimeoutBySubject(events: readonly IncidentEvent[]): Map<string, number> {
	const timeoutsBySubject = new Map<string, IncidentEvent[]>();
	for (const incident of events) {
		if (incident.eventClass !== "timeout") {
			continue;
		}
		const group = timeoutsBySubject.get(incident.subject) ?? [];
		group.push(incident);
		timeoutsBySubject.set(incident.subject, group);
	}
	const latestBySubject = new Map<string, number>();
	for (const [subject, timeouts] of timeoutsBySubject) {
		// Callers pass time-sorted events; sort defensively so the run scan
		// (which assumes ascending times) never sees them out of order.
		timeouts.sort((a, b) => a.timeMs - b.timeMs);
		const run = densestWindowRun(timeouts, TIMEOUT_STALL_WINDOW_MS);
		if (run.count >= 2) {
			latestBySubject.set(subject, timeouts[run.start + run.count - 1]!.timeMs);
		}
	}
	return latestBySubject;
}

// ---------------------------------------------------------------------------
// Timeline rendering
// ---------------------------------------------------------------------------

function formatIncidentTime(ms: number): string {
	const date = new Date(ms);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function colorizeSeverity(severity: IncidentSeverity, label: string): string {
	switch (severity) {
		case "critical":
		case "error":
			return chalk.red(label);
		case "warn":
			return chalk.yellow(label);
		case "info":
			return chalk.dim(label);
	}
}

interface AggregatedEvent {
	first: IncidentEvent;
	last: IncidentEvent;
	count: number;
}

function aggregateIncidentEvents(events: readonly IncidentEvent[]): AggregatedEvent[] {
	const groups = new Map<string, AggregatedEvent>();
	for (const incident of events) {
		const key = `${incident.category}|${incident.subject}|${incident.summary}`;
		const existing = groups.get(key);
		if (existing) {
			existing.count += 1;
			if (incident.timeMs > existing.last.timeMs) {
				existing.last = incident;
			}
			if (incident.timeMs < existing.first.timeMs) {
				existing.first = incident;
			}
		} else {
			groups.set(key, { first: incident, last: incident, count: 1 });
		}
	}
	return [...groups.values()].sort((a, b) => a.first.timeMs - b.first.timeMs);
}

function sessionMatches(incident: IncidentEvent, session: string): boolean {
	// An empty token (e.g. a missing session name) is a prefix of every value
	// and must not match every session filter.
	return incident.tokens.some((token) => token !== "" && (token.startsWith(session) || session.startsWith(token)));
}

/**
 * Build the full incident timeline text for a window: classified events are
 * grouped into Supervisor events / Session anomalies / Recovery sections,
 * repeated identical events are aggregated with counts, and per-subject
 * stalls, error bursts, and event gaps are surfaced as anomalies.
 */
export function buildIncidentReport(
	entries: readonly IncidentLogEntry[],
	options: IncidentReportOptions,
): IncidentReport {
	const workerPids = collectWorkerPidMap(entries);
	const allEvents = collectIncidentEvents(entries, workerPids);
	let events = allEvents.filter(
		(incident) => incident.timeMs >= options.sinceMs && incident.timeMs <= options.untilMs,
	);
	let filteredBySession = false;
	if (options.session !== undefined) {
		const session = options.session;
		const matching = events.filter((incident) => sessionMatches(incident, session));
		if (matching.length === 0 && events.length > 0) {
			return {
				text: `No daemon events between ${formatIncidentTime(options.sinceMs)} and ${formatIncidentTime(options.untilMs)} UTC reference session "${options.session}".`,
			};
		}
		events = matching;
		filteredBySession = true;
	}
	const anomalies = computeIncidentAnomalies(events.filter((incident) => incident.category !== "anomaly"));
	const timelineEvents = [...events, ...anomalies];

	const sections: Array<{ title: string; lines: string[] }> = [];
	for (const [title, category] of [
		["Supervisor events", "supervisor"],
		["Session anomalies", "anomaly"],
		["Recovery", "recovery"],
	] as const) {
		const aggregated = aggregateIncidentEvents(timelineEvents.filter((incident) => incident.category === category));
		const lines = aggregated.map((group) => {
			const suffix = group.count > 1 ? ` (x${group.count}, until ${formatIncidentTime(group.last.timeMs)})` : "";
			return `  ${formatIncidentTime(group.first.timeMs)}  ${colorizeSeverity(group.first.severity, group.first.severity.padEnd(8))}  ${group.first.summary}${suffix}`;
		});
		if (lines.length === 0) {
			lines.push(`  ${chalk.dim("(none)")}`);
		}
		sections.push({ title, lines });
	}

	const header = ["Prime Agent incident timeline"];
	const windowText = `Window: ${formatIncidentTime(options.sinceMs)} → ${formatIncidentTime(options.untilMs)} UTC (${formatIncidentDuration(options.untilMs - options.sinceMs)})`;
	header.push(windowText);
	if (options.source !== undefined) {
		const inWindow = allEvents.filter(
			(incident) => incident.timeMs >= options.sinceMs && incident.timeMs <= options.untilMs,
		).length;
		const skipped = options.skippedCount ?? 0;
		const skippedText = skipped > 0 ? `, ${skipped} unreadable skipped` : "";
		header.push(
			`Source: ${options.source} (${options.scannedCount ?? entries.length} lines scanned, ${inWindow} events in window${skippedText})`,
		);
	}
	if (filteredBySession) {
		header.push(`Session filter: ${options.session}`);
	}

	const text = [...header, "", ...sections.flatMap((section) => [section.title, ...section.lines, ""])]
		.join("\n")
		.trimEnd();
	return { text };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const INCIDENT_VALUE_FLAGS = new Set(["--since", "--until", "--session"]);

/** Parse `incident [--since <time>] [--until <time>] [--session <id>]` arguments. */
export function parseIncidentOptions(args: string[]): IncidentCommandOptions {
	const options: IncidentCommandOptions = {};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		let name = arg;
		let value: string | undefined;
		const equalsIndex = arg.indexOf("=");
		if (arg.startsWith("--") && equalsIndex !== -1) {
			name = arg.slice(0, equalsIndex);
			value = arg.slice(equalsIndex + 1);
		}
		if (!INCIDENT_VALUE_FLAGS.has(name)) {
			throw new IncidentUsageError(`Unknown option for incident: ${arg}`);
		}
		if (value === undefined) {
			value = args[++index];
			if (value === undefined) {
				throw new IncidentUsageError(`Option ${name} requires a value.`);
			}
		}
		if (!value.trim()) {
			throw new IncidentUsageError(`Option ${name} requires a value.`);
		}
		if (name === "--since") {
			options.since = value;
		} else if (name === "--until") {
			options.until = value;
		} else {
			options.session = value;
		}
	}
	return options;
}

/**
 * Read the daemon logs: agent.jsonl (plus its .old rotation) when it yields
 * entries, otherwise the newest per-daemon log file in the logs directory.
 * The fallback covers a missing, empty, or unreadable agent.jsonl and picks
 * only the newest per-daemon log; rotated per-daemon .old generations are not
 * included.
 */
export function readIncidentLogEntries(): IncidentLogSource {
	const logsDir = getLogsDir();
	const agentLogPath = getAgentLogPath();
	const structuredFiles = [`${agentLogPath}.old`, agentLogPath]
		.filter((candidate) => existsSync(candidate))
		.map((path) => ({ path, kind: "jsonl" as const }));
	const structured = scanIncidentLogFiles(structuredFiles);
	if (structured.entries.length > 0) {
		return structured;
	}
	// agent.jsonl is missing, empty, or unreadable: fall back to the newest
	// per-daemon log. Window filtering happens later; gate on parse yield only.
	const fallbackPath = newestDaemonLogPath(logsDir);
	if (fallbackPath === undefined) {
		return structured;
	}
	const fallback = scanIncidentLogFiles([{ path: fallbackPath, kind: "daemon" }]);
	return fallback.entries.length > 0 ? fallback : structured;
}

function scanIncidentLogFiles(files: ReadonlyArray<{ path: string; kind: "jsonl" | "daemon" }>): IncidentLogSource {
	const entries: IncidentLogEntry[] = [];
	let scannedCount = 0;
	let skippedCount = 0;
	for (const file of files) {
		let contents: string;
		try {
			contents = readFileSync(file.path, "utf8");
		} catch {
			continue;
		}
		for (const line of contents.split("\n")) {
			if (!line.trim()) {
				continue;
			}
			scannedCount += 1;
			const entry = file.kind === "jsonl" ? parseIncidentLogLine(line) : parseIncidentDaemonLogLine(line);
			if (entry) {
				entries.push(entry);
			} else {
				skippedCount += 1;
			}
		}
	}
	return { entries, scannedCount, skippedCount, source: files.map((file) => file.path).join(", ") };
}

function newestDaemonLogPath(logsDir: string): string | undefined {
	let names: string[] = [];
	try {
		names = readdirSync(logsDir);
	} catch {
		return undefined;
	}
	const candidates: Array<{ path: string; mtimeMs: number }> = [];
	for (const name of names) {
		if (!DAEMON_LOG_FILE_PATTERN.test(name)) {
			continue;
		}
		const path = join(logsDir, name);
		try {
			const stat = statSync(path);
			// A directory or other non-file matching the log pattern would be
			// picked as the fallback and then yield no entries (readFileSync
			// fails on it), hiding older valid daemon logs.
			if (!stat.isFile()) {
				continue;
			}
			candidates.push({ path, mtimeMs: stat.mtimeMs });
		} catch {
			// Lost a race with log rotation or permissions; skip the candidate.
		}
	}
	if (candidates.length === 0) {
		return undefined;
	}
	return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]!.path;
}

/** The resolved --since/--until window for an incident report. */
export interface IncidentWindow {
	sinceMs: number;
	untilMs: number;
}

/** Resolve --since/--until (default: last 24h until now); throws on bad or unordered times. */
export function resolveIncidentWindow(options: IncidentCommandOptions, now: Date): IncidentWindow {
	const sinceMs = options.since
		? parseIncidentTimeBound(options.since, now, "--since")
		: now.getTime() - DEFAULT_WINDOW_MS;
	const untilMs = options.until ? parseIncidentTimeBound(options.until, now, "--until") : now.getTime();
	if (untilMs <= sinceMs) {
		throw new IncidentUsageError("--until must be after --since.");
	}
	return { sinceMs, untilMs };
}

/**
 * Entry point for `prime-agent incident`; prints the timeline to stdout.
 * Callers that validate the window pass it back so relative `HH:MM` bounds
 * resolve exactly once instead of again against a later clock reading.
 */
export async function runIncident(options: IncidentCommandOptions, window?: IncidentWindow): Promise<void> {
	const { sinceMs, untilMs } = window ?? resolveIncidentWindow(options, new Date());
	const logSource = readIncidentLogEntries();
	if (logSource.entries.length === 0 && logSource.scannedCount === 0) {
		console.log(`No daemon logs found under ${getLogsDir()}.`);
		return;
	}
	const report = buildIncidentReport(logSource.entries, {
		sinceMs,
		untilMs,
		...(options.session !== undefined ? { session: options.session } : {}),
		source: logSource.source,
		scannedCount: logSource.scannedCount,
		skippedCount: logSource.skippedCount,
	});
	console.log(report.text);
}
