import { Buffer } from "node:buffer";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import {
	collectIncidentEvents,
	collectWorkerPidMap,
	computeIncidentAnomalies,
	type IncidentLogEntry,
	type IncidentSeverity,
	parseIncidentLogLine,
} from "../../cli/incident.js";
import { theme } from "../interactive/theme/theme.js";

/**
 * Daemon incident notices for the agents view.
 *
 * `prime-agent incident` (the classifier in src/cli/incident.ts) already
 * reconstructs daemon incidents from the shared structured log
 * (~/.prime/agent/logs/agent.jsonl); this module reuses that classifier —
 * never re-implementing it — to surface a single collapsed, dismissible
 * notice line in the agents-view header. A notice appears when the recent
 * window of the log contains a worker crash, a command-timeout burst, or an
 * update restart (a supervisor replacement), so the operator sees the
 * incident without running the CLI by hand.
 */

/** Recent-log window, matching the `prime-agent incident` default. */
export const INCIDENT_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Initial tail bound: incidents older than the tail bytes are simply not seen. */
export const INCIDENT_NOTICE_TAIL_BYTES = 512 * 1024;
/** How often the agents view re-reads appended agent.jsonl bytes. */
export const INCIDENT_NOTICE_POLL_INTERVAL_MS = 30_000;

const INCIDENT_NOTICE_POINTER = "— run prime-agent incident for the timeline";
const NEWLINE_BYTE = 0x0a;
const SEVERITY_RANK: Record<IncidentSeverity, number> = { critical: 3, error: 2, warn: 1, info: 0 };

export type IncidentNoticeKind = "worker-crash" | "timeout-burst" | "update-restart";

export interface IncidentNotice {
	kind: IncidentNoticeKind;
	/** Dismissal key (`${kind}|${subject}`): incidents at or before the horizon stay hidden. */
	key: string;
	severity: IncidentSeverity;
	subject: string;
	timeMs: number;
	/** Sentence without the pointer suffix; formatIncidentNoticeLine renders the visible line. */
	text: string;
}

/** Per-run incident notice state, cached on the agents view's persistentState. */
export interface IncidentNoticeState {
	/** Windowed log entries parsed so far, oldest first. */
	entries: IncidentLogEntry[];
	/** Byte offset consumed in agent.jsonl; undefined before the first tail read. */
	logOffset: number | undefined;
	/** `dev:ino` of agent.jsonl at the last read; a change means rotation or replacement. */
	logFileId: string | undefined;
	/** Dismissal horizons by notice key: incidents at or before this timeMs stay hidden. */
	dismissedHorizons: Record<string, number>;
	/** The collapsed notice currently worth showing, if any. */
	notice: IncidentNotice | undefined;
}

export function createIncidentNoticeState(): IncidentNoticeState {
	return {
		entries: [],
		logOffset: undefined,
		logFileId: undefined,
		dismissedHorizons: {},
		notice: undefined,
	};
}

/**
 * Local time of an incident, for "worker x crashed at 14:32". A bare HH:MM only
 * reads as today, so an incident from another local calendar day gets the date
 * prefixed (the tree-selector.ts label-timestamp style): "9/14 23:10", or
 * "26/9/14 23:10" across a year boundary.
 */
export function formatIncidentNoticeTime(timeMs: number, nowMs: number): string {
	const date = new Date(timeMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
	const now = new Date(nowMs);
	if (
		date.getFullYear() === now.getFullYear() &&
		date.getMonth() === now.getMonth() &&
		date.getDate() === now.getDate()
	) {
		return time;
	}
	const month = date.getMonth() + 1;
	const day = date.getDate();
	if (date.getFullYear() === now.getFullYear()) {
		return `${month}/${day} ${time}`;
	}
	return `${date.getFullYear().toString().slice(-2)}/${month}/${day} ${time}`;
}

/** The styled one-line notice rendered in the agents-view header. */
export function formatIncidentNoticeLine(notice: IncidentNotice): string {
	return theme.fg("warning", `⚠ ${notice.text} ${INCIDENT_NOTICE_POINTER}`);
}

function createNotice(
	kind: IncidentNoticeKind,
	severity: IncidentSeverity,
	subject: string,
	timeMs: number,
	text: string,
): IncidentNotice {
	return { kind, key: `${kind}|${subject}`, severity, subject, timeMs, text };
}

/**
 * Derive the notices worth surfacing from windowed agent.jsonl entries, reusing
 * the incident CLI's classifier. Exactly three incident classes qualify:
 * worker crashes (any worker-crash event), command-timeout bursts (the
 * classifier's per-subject "N command timeouts over X" anomaly), and update
 * restarts (a supervisor-start whose subject already started within the
 * window, i.e. the supervisor was replaced). A first-ever supervisor start is
 * routine and never produces a notice. A timeout-burst notice carries the
 * LATEST timeout of its subject — the classifier anchors the anomaly at the
 * first timeout — so dismissing it records a horizon that only covers the
 * burst as dismissed: a later timeout extends the burst past the horizon and
 * re-surfaces the notice, instead of it staying hidden until the first
 * timeout ages out of the window.
 */
export function deriveIncidentNotices(entries: readonly IncidentLogEntry[], nowMs: number): IncidentNotice[] {
	const sinceMs = nowMs - INCIDENT_NOTICE_WINDOW_MS;
	const windowed = entries.filter((entry) => entry.timeMs >= sinceMs);
	const workerPids = collectWorkerPidMap(windowed);
	const events = collectIncidentEvents(windowed, workerPids);
	events.sort((a, b) => a.timeMs - b.timeMs);
	const notices: IncidentNotice[] = [];
	for (const event of events) {
		if (event.eventClass === "worker-crash") {
			// The subject already reads "worker <id>" ("worker" when the id is unknown).
			notices.push(
				createNotice(
					"worker-crash",
					event.severity,
					event.subject,
					event.timeMs,
					`${event.subject} crashed at ${formatIncidentNoticeTime(event.timeMs, nowMs)}`,
				),
			);
		}
	}
	for (const anomaly of computeIncidentAnomalies(events)) {
		if (anomaly.summary.includes("command timeouts")) {
			// The anomaly summary already reads "<subject>: N command timeouts over X";
			// the classifier anchors the anomaly at the burst's FIRST timeout. Anchor
			// the notice at the LATEST timeout of the subject instead: dismissal
			// records notice.timeMs as the horizon for the key, so a later timeout
			// that extends the burst past the horizon re-surfaces it rather than the
			// notice staying hidden until the first timeout ages out of the window.
			let latestTimeoutMs = anomaly.timeMs;
			for (const event of events) {
				if (event.eventClass === "timeout" && event.subject === anomaly.subject) {
					latestTimeoutMs = Math.max(latestTimeoutMs, event.timeMs);
				}
			}
			notices.push(
				createNotice("timeout-burst", anomaly.severity, anomaly.subject, latestTimeoutMs, anomaly.summary),
			);
		}
	}
	// The classifier also emits supervisor-start for failed spawns (lock held,
	// startup error) at warn/error severity; only a successful start — the
	// info-severity "listening on" event — counts toward a replacement, or two
	// failed spawns on one socket would read as a restart.
	const startedSubjects = new Set<string>();
	for (const event of events) {
		if (event.eventClass !== "supervisor-start" || event.severity !== "info") {
			continue;
		}
		if (startedSubjects.has(event.subject)) {
			notices.push(
				createNotice(
					"update-restart",
					event.severity,
					event.subject,
					event.timeMs,
					`daemon restarted for update at ${formatIncidentNoticeTime(event.timeMs, nowMs)}`,
				),
			);
		} else {
			startedSubjects.add(event.subject);
		}
	}
	return notices;
}

/**
 * Collapse the derived notices to the single line the header shows: the most
 * severe wins (critical > error > warn > info), the most recent breaks ties.
 * Repeated identical events aggregate here — the header never stacks copies.
 */
export function selectIncidentNotice(notices: readonly IncidentNotice[]): IncidentNotice | undefined {
	let best: IncidentNotice | undefined;
	for (const notice of notices) {
		if (
			best === undefined ||
			SEVERITY_RANK[notice.severity] > SEVERITY_RANK[best.severity] ||
			(SEVERITY_RANK[notice.severity] === SEVERITY_RANK[best.severity] && notice.timeMs > best.timeMs)
		) {
			best = notice;
		}
	}
	return best;
}

/** True when the notice sits at or before its key's dismissal horizon. */
export function isIncidentNoticeDismissed(notice: IncidentNotice, horizons: Record<string, number>): boolean {
	const horizon = horizons[notice.key];
	return horizon !== undefined && notice.timeMs <= horizon;
}

/**
 * Dismiss the notice currently showing. Records its timeMs as the horizon for
 * its key, so the same incident (and any older incident on that key) never
 * re-renders on later polls or view re-entry, while a newer qualifying
 * incident does. Returns false when no notice is showing.
 */
export function dismissIncidentNoticeState(state: IncidentNoticeState): boolean {
	const notice = state.notice;
	if (!notice) {
		return false;
	}
	state.dismissedHorizons[notice.key] = Math.max(state.dismissedHorizons[notice.key] ?? 0, notice.timeMs);
	state.notice = undefined;
	return true;
}

function sameIncidentNotice(a: IncidentNotice | undefined, b: IncidentNotice | undefined): boolean {
	return a?.key === b?.key && a?.timeMs === b?.timeMs && a?.text === b?.text;
}

interface IncidentLogChunk {
	lines: string[];
	nextOffset: number;
	fileId: string;
}

/**
 * Rotation-safe incremental read of agent.jsonl. Without a previous offset — or
 * after rotation (a changed inode), a shrink (recreation in place), or more
 * than one tail bound of new bytes — read the bounded tail and drop the leading
 * partial line; otherwise read only appended bytes (every read stays bounded).
 * A trailing partial line is held back (the offset stops at its newline), so a
 * mid-write line parses only once complete, on a later poll. A missing or
 * unreadable file returns undefined; offsets beyond the file size are never
 * re-processed.
 */
function readIncidentLogLines(
	logPath: string,
	previousOffset: number | undefined,
	previousFileId: string | undefined,
): IncidentLogChunk | undefined {
	let fd: number;
	try {
		fd = openSync(logPath, "r");
	} catch {
		return undefined;
	}
	try {
		const stats = fstatSync(fd);
		const fileId = `${stats.dev}:${stats.ino}`;
		const rotated = previousFileId !== undefined && fileId !== previousFileId;
		// Re-tail when nothing was read yet, after a rotation (a new file), when
		// the file shrank (recreated in place), or when more than one tail
		// bound appended since the last poll; every read stays bounded and
		// offsets are never re-processed.
		const retailed =
			previousOffset === undefined ||
			rotated ||
			previousOffset > stats.size ||
			stats.size - previousOffset > INCIDENT_NOTICE_TAIL_BYTES;
		const start = retailed ? Math.max(0, stats.size - INCIDENT_NOTICE_TAIL_BYTES) : previousOffset;
		if (start >= stats.size) {
			return { lines: [], nextOffset: stats.size, fileId };
		}
		const buffer = Buffer.allocUnsafe(stats.size - start);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
		let lineStart = 0;
		if (retailed && start > 0) {
			// The tail begins mid-line; drop the first (partial) line. A chunk
			// with no newline at all is one mid-write line: hold it back so the
			// completed line is still parsed by the next poll.
			const firstNewline = buffer.subarray(0, bytesRead).indexOf(NEWLINE_BYTE);
			if (firstNewline === -1) {
				return { lines: [], nextOffset: start, fileId };
			}
			lineStart = firstNewline + 1;
		}
		let end = bytesRead;
		if (end > 0 && buffer[end - 1] !== NEWLINE_BYTE) {
			// Hold back the partially-written final line until it completes.
			const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(NEWLINE_BYTE);
			if (lastNewline < lineStart) {
				return { lines: [], nextOffset: start, fileId };
			}
			end = lastNewline + 1;
		}
		const lines = buffer
			.toString("utf8", lineStart, end)
			.split("\n")
			.filter((line) => line.trim().length > 0);
		return { lines, nextOffset: start + end, fileId };
	} catch {
		return undefined;
	} finally {
		try {
			closeSync(fd);
		} catch {
			// Best-effort: a failed close must not mask the read result.
		}
	}
}

/**
 * Keep windowed entries in stable time order across polls: new entries append,
 * everything older than the window drops. Lines re-read after a rotation or a
 * re-tail collapse harmlessly — identical lifecycle events dedupe in the
 * classifier, and the collapsed line never stacks copies.
 */
function mergeIncidentWindowedEntries(
	entries: readonly IncidentLogEntry[],
	parsed: readonly IncidentLogEntry[],
	sinceMs: number,
): IncidentLogEntry[] {
	if (entries.length === 0 && parsed.length === 0) {
		return [];
	}
	const merged = [...entries, ...parsed];
	merged.sort((a, b) => a.timeMs - b.timeMs);
	return merged.filter((entry) => entry.timeMs >= sinceMs);
}

/**
 * One best-effort poll: read new agent.jsonl bytes, keep the 24h window,
 * re-derive the qualifying notices, apply the dismissal horizons, and keep the
 * single collapsed line worth showing. Returns true when that line changed so
 * the caller can re-render. Never throws for a missing or unreadable log —
 * that simply retries a bounded tail on the next poll.
 */
export function refreshIncidentNoticeState(state: IncidentNoticeState, logPath: string, nowMs: number): boolean {
	const chunk = readIncidentLogLines(logPath, state.logOffset, state.logFileId);
	if (chunk === undefined) {
		// Missing or unreadable: keep the consumed offset and file id. Resetting
		// them would make the next poll re-tail and re-parse consumed lines — a
		// phantom second supervisor start (a false update restart; the classifier
		// does not dedupe supervisor-start) and doubled timeout counts. A real
		// rotation is still caught by the file id changing (or the offset
		// passing the size) on the next successful read.
		return false;
	}
	state.logOffset = chunk.nextOffset;
	state.logFileId = chunk.fileId;
	const sinceMs = nowMs - INCIDENT_NOTICE_WINDOW_MS;
	const parsed = chunk.lines
		.map((line) => parseIncidentLogLine(line))
		.filter((entry): entry is IncidentLogEntry => entry !== undefined && entry.timeMs >= sinceMs);
	const previous = state.notice;
	state.entries = mergeIncidentWindowedEntries(state.entries, parsed, sinceMs);
	const notices = deriveIncidentNotices(state.entries, nowMs);
	state.notice = selectIncidentNotice(
		notices.filter((notice) => !isIncidentNoticeDismissed(notice, state.dismissedHorizons)),
	);
	return !sameIncidentNotice(previous, state.notice);
}
