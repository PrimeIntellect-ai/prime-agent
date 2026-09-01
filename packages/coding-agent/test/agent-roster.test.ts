import { describe, expect, it } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import { classifyAgentStatus } from "../src/modes/daemon/agent-roster.js";
import { classifySessionRosterStatus, type SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { classifySubagentSnapshotStatus } from "../src/modes/interactive/components/subagent-summary-line.js";

function summaryFor(resident: boolean, busy: boolean, heartbeat: boolean): SessionSummary {
	return {
		id: "s-1",
		...(resident ? { activeSessionId: "as-1" } : {}),
		lifecycle: "live",
		activity: "idle",
		isSessionActive: busy,
		...(heartbeat ? { hasActiveHeartbeat: true } : {}),
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: busy,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function childFor(resident: boolean, busy: boolean): AgentConnectionRlmChildAgentSnapshot {
	return {
		id: "child-1",
		label: "child-1",
		status: busy ? "running" : "done",
		sessionDir: "/tmp/child-1",
		...(resident ? { activeSessionId: "as-1" } : {}),
	};
}

describe("classifyAgentStatus", () => {
	it("classifies once and both surface adapters agree with it", () => {
		// The formula's three defining rows: a queued child runs before any session
		// exists, nothing else resurrects a non-resident agent, residents split on work.
		expect(classifyAgentStatus({ resident: false, queuedChild: true, busy: false })).toBe("running");
		expect(classifyAgentStatus({ resident: false, queuedChild: false, busy: true })).toBe("inactive");
		expect(classifySubagentSnapshotStatus({ ...childFor(false, false), status: "queued" })).toBe("running");
		for (const busy of [false, true]) {
			const expected = classifyAgentStatus({ resident: true, queuedChild: false, busy });
			expect(expected).toBe(busy ? "running" : "idle");
			// An armed heartbeat between firings is not work: it never lifts a
			// resident session out of idle.
			for (const heartbeat of [false, true]) {
				expect(classifySessionRosterStatus(summaryFor(true, busy, heartbeat)), `busy=${busy} hb=${heartbeat}`).toBe(
					expected,
				);
			}
			expect(classifySubagentSnapshotStatus(childFor(true, busy)), `busy=${busy}`).toBe(expected);
		}
		expect(classifySessionRosterStatus(summaryFor(false, false, true))).toBe("inactive");
		expect(classifySubagentSnapshotStatus(childFor(false, false))).toBe("inactive");
	});
});
