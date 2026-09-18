import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildIncidentReport,
	collectIncidentEvents,
	collectWorkerPidMap,
	computeIncidentAnomalies,
	type IncidentLogEntry,
	IncidentUsageError,
	parseIncidentDaemonLogLine,
	parseIncidentLogLine,
	parseIncidentOptions,
	parseIncidentTimeBound,
	runIncident,
} from "../src/cli/incident.js";
import { ENV_AGENT_DIR } from "../src/config.js";

function agentLogLine(fields: Record<string, unknown>): string {
	return JSON.stringify({ ts: "2026-09-10T20:00:00.000Z", level: "warn", ...fields });
}

function entry(line: string): IncidentLogEntry {
	return parseIncidentLogLine(line)!;
}

const sinceMs = Date.parse("2026-09-10T20:00:00Z");
const untilMs = Date.parse("2026-09-10T20:30:00Z");

function reportFor(lines: string[], options: { since?: number; until?: number; session?: string } = {}) {
	const entries = lines.map((line) => parseIncidentLogLine(line)!).filter((item) => item !== undefined);
	return stripAnsi(
		buildIncidentReport(entries, {
			sinceMs: options.since ?? sinceMs,
			untilMs: options.until ?? untilMs,
			...(options.session !== undefined ? { session: options.session } : {}),
		}).text,
	);
}

/** Supervisor-side log line (daemon-supervisor component). */
function supervisorLine(ts: string, msg: string, extra: Record<string, unknown> = {}): string {
	return agentLogLine({ ts, component: "coding-agent.daemon-supervisor", ...extra, msg });
}

/** Worker daemon startup line, the pid sighting that anchors attribution. */
function workerStartLine(ts: string, socketPath: string, pid: number): string {
	return agentLogLine({
		ts,
		component: "coding-agent.daemon",
		socketPath,
		pid,
		msg: `Prime Agent daemon listening on ${socketPath}`,
	});
}

/** Worker daemon log line for a worker running under the fixture pid. */
function daemonLine(ts: string, socketPath: string, msg: string): string {
	return agentLogLine({ ts, component: "coding-agent.daemon", socketPath, pid: 53615, msg });
}

/** Provider stream failure line (rate_limit 429) attributed by pid. */
function providerFailureLine(ts: string, pid: number): string {
	return agentLogLine({
		ts,
		level: "error",
		component: "ai.provider",
		pid,
		msg: "provider stream failure",
		kind: "rate_limit",
		status: 429,
	});
}

// ---------------------------------------------------------------------------
// Green run: normal startup, worker start/stop, no errors.
// ---------------------------------------------------------------------------

describe("incident timeline for a clean run", () => {
	it("shows supervisor and worker events with no anomaly entries", () => {
		const text = reportFor(
			[
				[
					"2026-09-10T20:00:05.000Z",
					"Prime Agent daemon supervisor e14de15c listening on /tmp/prime-agent-501/daemon.sock",
				],
				[
					"2026-09-10T20:01:00.000Z",
					"Session worker 477fef4e85a8 stderr: Prime Agent daemon listening on /tmp/prime-agent-501/worker-a-477fef4e85a8.sock",
				],
				["2026-09-10T20:02:00.000Z", "Migrated 2 scheduled jobs into session artifacts"],
				[
					"2026-09-10T20:10:00.000Z",
					"Session worker 477fef4e85a8 stderr: shutdown command received over socket; 1 active session(s) will be closed",
				],
				[
					"2026-09-10T20:10:01.000Z",
					"Session worker 477fef4e85a8 stderr: shutting down (exit 0); closing 1 active session(s)",
				],
				[
					"2026-09-10T20:11:00.000Z",
					"Evicted empty session worker 477fef4e85a8 root=01a0-abc on last client detach",
				],
			].map(([ts, msg]) => supervisorLine(ts, msg, { pid: 15026 })),
		);
		expect(text).toContain("Supervisor events");
		expect(text).toContain("worker 477fef4e85a8 started");
		expect(text).toContain("worker 477fef4e85a8 stop requested (1 active session(s))");
		expect(text).toContain("worker 477fef4e85a8 stopped (exit 0, 1 session(s) closed)");
		expect(text).toContain("evicted empty session worker 477fef4e85a8 on last detach");
		expect(text).toContain("migrated 2 scheduled jobs into session artifacts");
		const anomalies = text.split("Session anomalies")[1]!.split("Recovery")[0]!;
		expect(anomalies).toContain("(none)");
		expect(anomalies).not.toContain("timeout");
		expect(text).not.toContain("critical");
	});
});

// ---------------------------------------------------------------------------
// Crash + recovery: the incident class from 2026-09-10 (attach timeouts
// 20:02-20:21, EPIPE worker crash, recovery holding backlogged operations).
// ---------------------------------------------------------------------------

function incidentFixtureLines(): string[] {
	const lines: string[] = [];
	const supervisor = {
		component: "coding-agent.daemon-supervisor",
		socketPath: "/tmp/prime-agent-501/daemon.sock",
		pid: 15026,
	};
	const crashedWorker = {
		component: "coding-agent.daemon",
		socketPath: "/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock",
		pid: 53615,
	};
	const supervisorMsg = (ts: string, msg: string) => agentLogLine({ ...supervisor, ts, msg });
	// Worker starts before the window; provider failures are attributed to it by pid.
	lines.push(workerStartLine("2026-09-10T19:42:09.064Z", crashedWorker.socketPath, 53615));
	// Attach timeouts 20:02-20:21.
	for (const [ts, command] of [
		["2026-09-10T20:02:39.764Z", "attach"],
		["2026-09-10T20:08:37.410Z", "attach"],
		["2026-09-10T20:09:16.853Z", "attach"],
		["2026-09-10T20:21:53.062Z", "attach"],
	] as const) {
		lines.push(
			supervisorMsg(
				ts,
				`Supervisor command ${command} failed: Error: Timed out waiting for daemon worker response to ${command}\n    at Timeout._onTimeout (node:internal/timers:618:7)`,
			),
		);
	}
	// Per-session catch-up timeouts for 2339fb7da605 and one other session.
	lines.push(
		supervisorMsg(
			"2026-09-10T20:02:33.708Z",
			"Failed to catch up client daemon-client:ac0fbf2a for dcdced964c0d: Error: Timed out waiting for daemon worker response to attach",
		),
	);
	for (const ts of ["2026-09-10T20:04:50.397Z", "2026-09-10T20:11:29.190Z", "2026-09-10T20:14:57.615Z"]) {
		lines.push(
			supervisorMsg(
				ts,
				"Failed to catch up client daemon-client:dc5ad892 for 2339fb7da605: Error: Timed out waiting for daemon worker response to attach",
			),
		);
	}
	lines.push(
		supervisorMsg(
			"2026-09-10T20:21:58.137Z",
			"Could not list heartbeats from a worker: Timed out waiting for daemon worker response to heartbeats_list",
		),
		supervisorMsg(
			"2026-09-10T20:02:30.000Z",
			"Supervisor command list_agent_peers failed: Error: Worker authentication failed\n    at handleCommand (chunk.js:1:1)",
		),
	);
	// Provider stream failures from the overloaded worker (real entries carry
	// only the worker pid, no socket path).
	for (let index = 0; index < 30; index++) {
		lines.push(
			agentLogLine({
				ts: `2026-09-10T20:${(2 + Math.floor(index / 2)).toString().padStart(2, "0")}:${(index % 60).toString().padStart(2, "0")}.000Z`,
				level: "error",
				component: "ai.provider",
				pid: 53615,
				msg: "provider stream failure",
				kind: index % 5 === 0 ? "server_error" : "rate_limit",
				status: index % 5 === 0 ? 504 : 429,
			}),
		);
	}
	// EPIPE crash: logged once by the worker and once via the stderr forward.
	lines.push(
		agentLogLine({
			...crashedWorker,
			ts: "2026-09-10T20:23:24.945Z",
			msg: "uncaught exception: Error: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:159:15)",
		}),
		supervisorMsg(
			"2026-09-10T20:23:24.945Z",
			"Session worker 5b1d3aeb91ee stderr: uncaught exception: Error: write EPIPE",
		),
		supervisorMsg(
			"2026-09-10T20:23:24.946Z",
			"Session worker 5b1d3aeb91ee stderr:     at afterWriteDispatched (node:internal/stream_base_commons:159:15)",
		),
	);
	// Recovery: worker replaced, backlogged uncertain operations held.
	const operations = [
		...Array<string>(408).fill("tool_execution_start"),
		...Array<string>(62).fill("auto_retry_end"),
		...Array<string>(47).fill("agent_end"),
		...Array<string>(16).fill("message_start"),
	].join(", ");
	lines.push(
		supervisorMsg(
			"2026-09-10T20:23:29.521Z",
			`Recovered worker 5b1d3aeb91ee without replaying uncertain operations: ${operations}`,
		),
		supervisorMsg(
			"2026-09-10T20:23:39.520Z",
			"Could not adopt worker 5b1d3aeb91ee: Error: Session worker process is no longer running",
		),
	);
	return lines;
}

describe("incident timeline for a crash + recovery", () => {
	it("reconstructs the incident narrative in one report", () => {
		const text = reportFor(incidentFixtureLines());
		// Timeouts aggregated with count and span.
		expect(text).toContain("command attach failed: timed out waiting for worker response (x4, until 09-10 20:21:53)");
		expect(text).toContain(
			"client catch-up failed for session 2339fb7da605: Timed out waiting for daemon worker response to attach (x3, until 09-10 20:14:57)",
		);
		expect(text).toContain("command list_agent_peers failed: worker authentication failed");
		// The crash appears once, critical, with the EPIPE cause.
		expect(text.match(/crashed/g)?.length).toBe(1);
		expect(text).toContain(
			"09-10 20:23:24  critical  worker 5b1d3aeb91ee crashed: uncaught exception: Error: write EPIPE",
		);
		// Recovery with the held backlog and its operation breakdown.
		expect(text).toContain(
			"worker 5b1d3aeb91ee recovered; 533 uncertain operations not replayed (tool_execution_start x408, auto_retry_end x62, agent_end x47, message_start x16)",
		);
		expect(text).toContain("could not adopt worker 5b1d3aeb91ee: Session worker process is no longer running");
		// Anomalies: a timeout stall, an auth failure, and provider failures attributed to the crashed worker.
		expect(text).toContain("/tmp/prime-agent-501/daemon.sock: 5 command timeouts over 19m18s");
		expect(text).toContain("session 2339fb7da605: 3 command timeouts over 10m7s");
		expect(text).toContain("provider stream failure (rate_limit 429) for worker 5b1d3aeb91ee (x24");
		expect(text).toContain("provider stream failure (server_error 504) for worker 5b1d3aeb91ee (x6");
	});
});

// ---------------------------------------------------------------------------
// Window and session filtering.
// ---------------------------------------------------------------------------

describe("incident window and session filtering", () => {
	it("excludes events outside the window", () => {
		const lines = incidentFixtureLines();
		const text = reportFor(lines, {
			since: Date.parse("2026-09-10T20:05:00Z"),
			until: Date.parse("2026-09-10T20:10:00Z"),
		});
		expect(text).toContain("command attach failed: timed out waiting for worker response (x2, until 09-10 20:09:16)");
		expect(text).not.toContain("20:21:53");
		expect(text).not.toContain("write EPIPE");
		expect(text).not.toContain("Recovered worker");
	});

	it("filters to events naming the session, with prefix matching", () => {
		const lines = incidentFixtureLines();
		const full = reportFor(lines);
		const filtered = reportFor(lines, { session: "2339fb7" });
		expect(filtered).toContain("client catch-up failed for session 2339fb7da605");
		expect(filtered).toContain("session 2339fb7da605: 3 command timeouts over 10m7s");
		expect(filtered).toContain("Session filter: 2339fb7");
		expect(filtered).not.toContain("command attach failed: timed out");
		expect(filtered).not.toContain("write EPIPE");
		expect(filtered).not.toContain("dcdced964c0d");
		expect(full).toContain("dcdced964c0d");
	});

	it("matches session names quoted in log messages", () => {
		const text = reportFor(
			[
				supervisorLine(
					"2026-09-10T20:05:00.000Z",
					'Supervisor command set_session_name failed: Error: Agent name "Faerie" is unavailable',
				),
			],
			{ session: "Faerie" },
		);
		expect(text).toContain('Agent name "Faerie" is unavailable');
	});

	it("does not let a passivation event with an empty session name match every filter", () => {
		// daemon-mode logs `name=""` when the session has no name; that empty
		// token must not prefix-match every --session value.
		const text = reportFor(
			[
				daemonLine(
					"2026-09-10T20:05:00.000Z",
					"/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock",
					'Passivated idle child sessionId=feedface1234 name="" idleMinutes=5',
				),
			],
			{ session: "aabbccddeeff" },
		);
		expect(text).toContain('reference session "aabbccddeeff"');
	});

	it("keeps session tokens from worker command failures", () => {
		const text = reportFor(
			[
				daemonLine(
					"2026-09-10T20:05:00.000Z",
					"/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock",
					'daemon command "set_session_name" failed: Error: Agent name "Faerie" is unavailable',
				),
			],
			{ session: "Faerie" },
		);
		expect(text).toContain('Agent name "Faerie" is unavailable');
	});

	it("says clearly when nothing in the window references the session", () => {
		const text = reportFor(incidentFixtureLines(), { session: "deadbeef1234" });
		expect(text).toContain('reference session "deadbeef1234"');
	});
});

// ---------------------------------------------------------------------------
// Time parsing and option parsing.
// ---------------------------------------------------------------------------

describe("parseIncidentTimeBound", () => {
	const now = new Date(Date.parse("2026-09-16T22:30:00Z"));

	it("parses ISO date-times, dates, and bare times as UTC", () => {
		expect(parseIncidentTimeBound("2026-09-16T20:02", now, "--since")).toBe(Date.parse("2026-09-16T20:02:00.000Z"));
		expect(parseIncidentTimeBound("2026-09-16", now, "--since")).toBe(Date.parse("2026-09-16T00:00:00.000Z"));
		expect(parseIncidentTimeBound("20:02", now, "--since")).toBe(Date.parse("2026-09-16T20:02:00.000Z"));
		expect(parseIncidentTimeBound("2026-09-16T20:02:53Z", now, "--since")).toBe(
			Date.parse("2026-09-16T20:02:53.000Z"),
		);
		expect(parseIncidentTimeBound("2026-09-16T22:02+02:00", now, "--since")).toBe(
			Date.parse("2026-09-16T20:02:00.000Z"),
		);
	});

	it("accepts fractional seconds pasted from the log", () => {
		expect(parseIncidentTimeBound("2026-09-16T20:02:39.764Z", now, "--since")).toBe(
			Date.parse("2026-09-16T20:02:39.764Z"),
		);
		expect(parseIncidentTimeBound("2026-09-16T20:02:39.764", now, "--since")).toBe(
			Date.parse("2026-09-16T20:02:39.764Z"),
		);
		expect(parseIncidentTimeBound("2026-09-16T20:02:39.7", now, "--since")).toBe(
			Date.parse("2026-09-16T20:02:39.700Z"),
		);
	});

	it("rejects timezone offsets with an invalid minute component", () => {
		// RFC 3339 offsets allow minutes 00-59 only; +00:60 must not shift by an hour.
		for (const garbage of ["2026-09-16T20:02+00:60", "2026-09-16T20:02-05:90", "2026-09-16T20:02+24:00"]) {
			expect(() => parseIncidentTimeBound(garbage, now, "--since")).toThrow(IncidentUsageError);
		}
		expect(parseIncidentTimeBound("2026-09-16T20:02+05:45", now, "--since")).toBe(
			Date.parse("2026-09-16T14:17:00.000Z"),
		);
	});

	it("rejects garbage and impossible dates with a clear usage error", () => {
		for (const garbage of ["yesterday", "2026-13-01", "2026-09-32", "25:00", "2026-09-16T"]) {
			expect(() => parseIncidentTimeBound(garbage, now, "--since")).toThrow(IncidentUsageError);
		}
		const message = (() => {
			try {
				parseIncidentTimeBound("garbage", now, "--since");
			} catch (error) {
				return (error as Error).message;
			}
		})();
		expect(message).toContain("--since");
		expect(message).toContain("20:02");
	});
});

describe("parseIncidentOptions", () => {
	it("parses separated and =-attached values", () => {
		expect(parseIncidentOptions(["--since", "20:02", "--until=21:00", "--session", "abc"])).toEqual({
			since: "20:02",
			until: "21:00",
			session: "abc",
		});
		expect(parseIncidentOptions([])).toEqual({});
	});

	it("rejects unknown options, missing values, and empty values", () => {
		expect(() => parseIncidentOptions(["--json"])).toThrow(IncidentUsageError);
		expect(() => parseIncidentOptions(["extra"])).toThrow(IncidentUsageError);
		expect(() => parseIncidentOptions(["--since"])).toThrow(IncidentUsageError);
		expect(() => parseIncidentOptions(["--since", ""])).toThrow(IncidentUsageError);
		expect(() => parseIncidentOptions(["--since="])).toThrow(IncidentUsageError);
		expect(() => parseIncidentOptions(["--session", "  "])).toThrow(IncidentUsageError);
	});
});

// ---------------------------------------------------------------------------
// Per-daemon log fallback and malformed-line robustness.
// ---------------------------------------------------------------------------

describe("parseIncidentDaemonLogLine", () => {
	it("parses supervisor and worker lines", () => {
		const supervisor = parseIncidentDaemonLogLine(
			"[2026-09-10T20:02:39.765Z] supervisor: Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
		);
		expect(supervisor?.component).toBe("coding-agent.daemon-supervisor");
		expect(supervisor?.timeMs).toBe(Date.parse("2026-09-10T20:02:39.765Z"));
		const worker = parseIncidentDaemonLogLine("[2026-09-10T20:23:24.945Z] uncaught exception: Error: write EPIPE");
		expect(worker?.component).toBe("coding-agent.daemon");
		expect(worker?.msg).toBe("uncaught exception: Error: write EPIPE");
	});

	it("returns undefined for malformed lines", () => {
		expect(parseIncidentDaemonLogLine("not a log line")).toBeUndefined();
		expect(parseIncidentDaemonLogLine("[not-a-timestamp] supervisor: msg")).toBeUndefined();
		expect(parseIncidentDaemonLogLine("[]")).toBeUndefined();
	});
});

describe("runIncident over a fixture agent dir", () => {
	let agentDir: string;
	let logs: string[];

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "prime-incident-test-"));
		logs = [];
		vi.spyOn(console, "log").mockImplementation((line: string) => {
			logs.push(line);
		});
		process.env[ENV_AGENT_DIR] = agentDir;
	});

	afterEach(() => {
		delete process.env[ENV_AGENT_DIR];
		vi.restoreAllMocks();
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("tolerates malformed lines and reports them as skipped", async () => {
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		const contents = [
			"this is not json",
			JSON.stringify({ noTs: true, msg: "missing ts" }),
			supervisorLine(
				"2026-09-10T20:02:39.764Z",
				"Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
			),
			"",
		].join("\n");
		writeFileSync(join(agentDir, "logs", "agent.jsonl"), `${contents}\n`);
		await runIncident({ since: "2026-09-10T20:00", until: "2026-09-10T20:30" });
		const text = stripAnsi(logs.join("\n"));
		expect(text).toContain("command attach failed: timed out waiting for worker response");
		expect(text).toContain("3 lines scanned, 1 events in window, 2 unreadable skipped");
	});

	it("falls back to the newest per-daemon log when agent.jsonl is absent", async () => {
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		writeFileSync(
			join(agentDir, "logs", "old-sock.a1b2c3d4.log"),
			"[2026-09-09T10:00:00.000Z] supervisor: Daemon supervisor startup failed: Error: Lock file is already being held\n",
		);
		writeFileSync(
			join(agentDir, "logs", "daemon.sock.98ed5cb2.log"),
			[
				"[2026-09-10T20:00:05.000Z] supervisor: Daemon supervisor startup failed: Error: Lock file is already being held",
				"[2026-09-10T20:23:24.945Z] uncaught exception: Error: write EPIPE",
				"[2026-09-10T20:23:29.521Z] supervisor: Recovered worker 5b1d3aeb91ee without replaying uncertain operations: tool_execution_start, agent_end",
			].join("\n"),
		);
		await runIncident({ since: "2026-09-10T20:00", until: "2026-09-10T20:30" });
		const text = stripAnsi(logs.join("\n"));
		expect(text).toContain("daemon.sock.98ed5cb2.log");
		expect(text).toContain("supervisor startup blocked: another daemon holds the lock");
		expect(text).toContain(
			"worker 5b1d3aeb91ee recovered; 2 uncertain operations not replayed (agent_end x1, tool_execution_start x1)",
		);
	});

	it("falls back to daemon logs whose socket basename does not end in .sock", async () => {
		// A daemon started with `--daemon-socket /tmp/prime-daemon` writes
		// prime-daemon.<hash>.log, which has no .sock segment to match on.
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		writeFileSync(
			join(agentDir, "logs", "prime-daemon.a1b2c3d4.log"),
			"[2026-09-10T20:00:05.000Z] supervisor: Daemon supervisor startup failed: Error: Lock file is already being held\n",
		);
		await runIncident({ since: "2026-09-10T20:00", until: "2026-09-10T20:30" });
		const text = stripAnsi(logs.join("\n"));
		expect(text).toContain("prime-daemon.a1b2c3d4.log");
		expect(text).toContain("supervisor startup blocked: another daemon holds the lock");
	});

	it("uses the pre-resolved window passed by the caller", async () => {
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		writeFileSync(
			join(agentDir, "logs", "agent.jsonl"),
			`${supervisorLine("2026-09-10T20:02:39.764Z", "Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach")}\n`,
		);
		await runIncident(
			{},
			{ sinceMs: Date.parse("2026-09-10T20:00:00Z"), untilMs: Date.parse("2026-09-10T20:30:00Z") },
		);
		const text = stripAnsi(logs.join("\n"));
		expect(text).toContain("Window: 09-10 20:00:00 → 09-10 20:30:00 UTC (30m)");
		expect(text).toContain("command attach failed: timed out waiting for worker response");
	});

	it("falls back to the per-daemon log when agent.jsonl is empty or unreadable", async () => {
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		const daemonLog = [
			"[2026-09-10T20:23:24.945Z] uncaught exception: Error: write EPIPE",
			"[2026-09-10T20:23:29.521Z] supervisor: Recovered worker 5b1d3aeb91ee without replaying uncertain operations: tool_execution_start, agent_end",
		].join("\n");
		writeFileSync(join(agentDir, "logs", "daemon.sock.98ed5cb2.log"), `${daemonLog}\n`);
		// Unreadable agent.jsonl: nothing parses.
		writeFileSync(join(agentDir, "logs", "agent.jsonl"), "this is not json\nalso not json\n");
		await runIncident({ since: "2026-09-10T20:00", until: "2026-09-10T20:30" });
		let text = stripAnsi(logs.join("\n"));
		expect(text).toContain("daemon.sock.98ed5cb2.log");
		expect(text).toContain("worker crashed: uncaught exception: Error: write EPIPE");
		expect(text).toContain("worker 5b1d3aeb91ee recovered; 2 uncertain operations not replayed");
		// Empty agent.jsonl: zero parsed entries also triggers the fallback.
		writeFileSync(join(agentDir, "logs", "agent.jsonl"), "");
		logs.length = 0;
		await runIncident({ since: "2026-09-10T20:00", until: "2026-09-10T20:30" });
		text = stripAnsi(logs.join("\n"));
		expect(text).toContain("daemon.sock.98ed5cb2.log");
		expect(text).toContain("worker crashed: uncaught exception: Error: write EPIPE");
	});

	it("does not fall back when agent.jsonl parses but has no in-window events", async () => {
		mkdirSync(join(agentDir, "logs"), { recursive: true });
		const outOfWindow = supervisorLine(
			"2026-09-01T10:00:00.000Z",
			"Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
		);
		writeFileSync(join(agentDir, "logs", "agent.jsonl"), `${outOfWindow}\n`);
		writeFileSync(
			join(agentDir, "logs", "daemon.sock.98ed5cb2.log"),
			"[2026-09-10T20:23:24.945Z] supervisor: Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach\n",
		);
		await runIncident({ since: "2026-09-10T20:00", until: "2026-09-10T20:30" });
		const text = stripAnsi(logs.join("\n"));
		expect(text).toContain("agent.jsonl");
		expect(text).not.toContain("daemon.sock.98ed5cb2.log");
		expect(text).toContain("(none)");
	});

	it("reports missing logs clearly", async () => {
		await runIncident({});
		const text = stripAnsi(logs.join("\n"));
		expect(text).toContain("No daemon logs found under");
	});
});

// ---------------------------------------------------------------------------
// Unit-level checks for pid attribution and anomaly computation.
// ---------------------------------------------------------------------------

describe("worker pid attribution and anomalies", () => {
	it("attributes provider failures to the worker that owns the pid", () => {
		const lines = [
			workerStartLine(
				"2026-09-10T19:42:09.064Z",
				"/tmp/prime-agent-501/worker-98ed5cb228d2-5b1d3aeb91ee.sock",
				53615,
			),
			providerFailureLine("2026-09-10T20:02:53.374Z", 53615),
		];
		const entries = lines.map((line) => entry(line));
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		expect(events.some((item) => item.summary.includes("for worker 5b1d3aeb91ee"))).toBe(true);
	});

	it("flags long gaps between events for the same session", () => {
		const base = {
			component: "coding-agent.daemon-supervisor",
			msg: "Failed to catch up client c1 for aabbccddeeff: Error: Daemon worker socket closed",
		};
		const entries = [
			entry(agentLogLine({ ...base, ts: "2026-09-10T20:00:00.000Z" })),
			entry(agentLogLine({ ...base, ts: "2026-09-10T20:05:00.000Z" })),
			entry(agentLogLine({ ...base, ts: "2026-09-10T20:30:00.000Z" })),
		];
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		const anomalies = computeIncidentAnomalies(events);
		const gap = anomalies.find((item) => item.summary.includes("event gap"));
		expect(gap?.summary).toBe("session aabbccddeeff: 25m event gap (no logged events)");
	});

	it("keeps anomalies and aggregation per daemon socket instead of merging daemons", () => {
		const daemonA = { component: "coding-agent.daemon-supervisor", socketPath: "/tmp/prime-agent-501/daemon.sock" };
		const daemonB = { component: "coding-agent.daemon-supervisor", socketPath: "/tmp/other/daemon.sock" };
		const times = [
			[daemonA, "20:02"],
			[daemonA, "20:08"],
			[daemonA, "20:09"],
			[daemonA, "20:21"],
			[daemonB, "20:03"],
			[daemonB, "20:10"],
			[daemonB, "20:30"],
		] as const;
		const text = reportFor(
			times.map(([daemon, time]) =>
				supervisorLine(
					`2026-09-10T${time}:00.000Z`,
					"Supervisor command attach failed: Error: Timed out waiting for daemon worker response to attach",
					daemon,
				),
			),
		);
		expect(text).toContain("/tmp/prime-agent-501/daemon.sock: 4 command timeouts over 19m");
		expect(text).toContain("/tmp/other/daemon.sock: 3 command timeouts over 27m");
		expect(text).toContain("command attach failed: timed out waiting for worker response (x4, until 09-10 20:21:00)");
	});

	it("does not report isolated failures days apart as one burst", () => {
		const base = {
			component: "coding-agent.daemon-supervisor",
			socketPath: "/tmp/prime-agent-501/daemon.sock",
			msg: "Supervisor command send_message failed: Error: Unknown active session: aabbccddeeff",
		};
		const entries = [
			entry(agentLogLine({ ...base, ts: "2026-09-10T20:00:00.000Z" })),
			entry(agentLogLine({ ...base, ts: "2026-09-12T20:00:00.000Z" })),
			entry(agentLogLine({ ...base, ts: "2026-09-14T20:00:00.000Z" })),
		];
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		const anomalies = computeIncidentAnomalies(events);
		expect(anomalies.some((item) => item.summary.includes("warnings/errors"))).toBe(false);
	});

	it("attributes provider failures to the worker owning the pid at that time", () => {
		const workerA = "/tmp/prime-agent-501/worker-98ed5cb228d2-aaaaaaaaaaaa.sock";
		const workerB = "/tmp/prime-agent-501/worker-98ed5cb228d2-bbbbbbbbbbbb.sock";
		const lines = [
			workerStartLine("2026-09-10T20:00:00.000Z", workerA, 53615),
			providerFailureLine("2026-09-10T20:01:00.000Z", 53615),
			// The same pid is reused by a replacement worker an hour later.
			workerStartLine("2026-09-10T21:00:00.000Z", workerB, 53615),
			providerFailureLine("2026-09-10T21:01:00.000Z", 53615),
		];
		const entries = lines.map((line) => entry(line));
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		const summaries = events.filter((item) => item.eventClass === "provider").map((item) => item.summary);
		expect(summaries).toEqual([
			"provider stream failure (rate_limit 429) for worker aaaaaaaaaaaa",
			"provider stream failure (rate_limit 429) for worker bbbbbbbbbbbb",
		]);
	});

	it("classifies worker events for Windows named-pipe socket paths", () => {
		const socketPath = "\\\\.\\pipe\\prime-agent-worker-98ed5cb228d2-5b1d3aeb91ee";
		const entries = [
			entry(workerStartLine("2026-09-10T20:00:00.000Z", socketPath, 53615)),
			entry(daemonLine("2026-09-10T20:23:24.945Z", socketPath, "uncaught exception: Error: write EPIPE")),
		];
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		expect(events.map((item) => item.eventClass)).toEqual(["worker-start", "worker-crash"]);
		expect(events.every((item) => item.subject === "worker 5b1d3aeb91ee")).toBe(true);
	});

	it("keys unknown worker diagnostics as worker events", () => {
		const socketPath = "/tmp/prime-agent-501/worker-98ed5cb228d2-aaaaaaaaaaaa.sock";
		const entries = [1, 2, 3].map((index) =>
			entry(daemonLine(`2026-09-10T20:0${index}:00.000Z`, socketPath, `unrecognized worker diagnostic ${index}`)),
		);
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		const anomalies = computeIncidentAnomalies(events);
		expect(anomalies.some((item) => item.summary.startsWith("worker aaaaaaaaaaaa: 3 warnings/errors over 2m"))).toBe(
			true,
		);
		expect(anomalies.some((item) => item.summary.includes(socketPath))).toBe(false);
	});

	it("does not attribute a provider failure to a worker sighted later on the pid", () => {
		const workerB = "/tmp/prime-agent-501/worker-98ed5cb228d2-bbbbbbbbbbbb.sock";
		const lines = [
			providerFailureLine("2026-09-10T10:00:00.000Z", 53615),
			// The pid's only sighting is a worker that starts ten minutes later;
			// a future sighting is never evidence of ownership at 10:00.
			workerStartLine("2026-09-10T10:10:00.000Z", workerB, 53615),
		];
		const entries = lines.map((line) => entry(line));
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		const summaries = events.filter((item) => item.eventClass === "provider").map((item) => item.summary);
		expect(summaries).toEqual(["provider stream failure (rate_limit 429) for pid 53615"]);
	});

	it("flags error bursts that are not timeouts", () => {
		const entries = [1, 2, 3].map((index) =>
			entry(
				supervisorLine(
					`2026-09-10T20:0${index}:00.000Z`,
					`Supervisor command send_message failed: Error: Unknown active session: aabbccdd${index}`,
				),
			),
		);
		const events = collectIncidentEvents(entries, collectWorkerPidMap(entries));
		const anomalies = computeIncidentAnomalies(events);
		expect(anomalies.some((item) => item.summary.includes("3 warnings/errors over 2m"))).toBe(true);
	});
});
