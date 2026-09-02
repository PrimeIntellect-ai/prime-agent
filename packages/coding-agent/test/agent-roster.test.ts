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
		expect(classifyAgentStatus({ resident: false, queuedChild: true, busy: false, hasActiveHeartbeat: false })).toBe(
			"running",
		);
		expect(classifyAgentStatus({ resident: false, queuedChild: false, busy: true, hasActiveHeartbeat: true })).toBe(
			"inactive",
		);
		expect(classifySubagentSnapshotStatus({ ...childFor(false, false), status: "queued" }, new Set())).toBe(
			"running",
		);
		for (const busy of [false, true]) {
			for (const heartbeat of [false, true]) {
				const expected = classifyAgentStatus({
					resident: true,
					queuedChild: false,
					busy,
					hasActiveHeartbeat: heartbeat,
				});
				expect(expected).toBe(busy || heartbeat ? "running" : "idle");
				const heartbeatIds = new Set(heartbeat ? ["as-1"] : []);
				expect(classifySessionRosterStatus(summaryFor(true, busy, heartbeat)), `busy=${busy} hb=${heartbeat}`).toBe(
					expected,
				);
				expect(
					classifySubagentSnapshotStatus(childFor(true, busy), heartbeatIds),
					`busy=${busy} hb=${heartbeat}`,
				).toBe(expected);
			}
		}
		expect(classifySessionRosterStatus(summaryFor(false, false, false))).toBe("inactive");
		expect(classifySubagentSnapshotStatus(childFor(false, false), new Set())).toBe("inactive");
	});

	it("keeps a session with only delegated child work out of running", () => {
		const delegating: SessionSummary = { ...summaryFor(true, false, false), hasRunningRlmChildren: true };
		expect(classifySessionRosterStatus(delegating)).toBe("idle");
		const streaming: SessionSummary = { ...summaryFor(true, true, false), hasRunningRlmChildren: true };
		expect(classifySessionRosterStatus(streaming)).toBe("running");
	});
});
