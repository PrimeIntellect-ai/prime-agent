import { describe, expect, it } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import {
	type AgentRosterStatus,
	type AgentStatusInput,
	classifyAgentStatus,
} from "../src/modes/daemon/agent-roster.js";
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
	it("classifies from the four input bits", () => {
		const cases: Array<[AgentStatusInput, AgentRosterStatus]> = [
			// An admitted-but-sessionless child run is already working.
			[{ resident: false, queuedChild: true, busy: false, hasActiveHeartbeat: false }, "running"],
			// Nothing resurrects a non-resident agent except a queued child run.
			[{ resident: false, queuedChild: false, busy: true, hasActiveHeartbeat: true }, "inactive"],
			[{ resident: true, queuedChild: false, busy: true, hasActiveHeartbeat: false }, "running"],
			[{ resident: true, queuedChild: false, busy: false, hasActiveHeartbeat: true }, "running"],
			[{ resident: true, queuedChild: false, busy: false, hasActiveHeartbeat: false }, "idle"],
		];
		for (const [input, expected] of cases) {
			expect(classifyAgentStatus(input), JSON.stringify(input)).toBe(expected);
		}
	});

	it("keeps the agents-view and subagents-bar adapters equal to the shared formula", () => {
		for (const busy of [false, true]) {
			for (const heartbeat of [false, true]) {
				const expected = classifyAgentStatus({
					resident: true,
					queuedChild: false,
					busy,
					hasActiveHeartbeat: heartbeat,
				});
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
		// A passivated agent is inactive on both surfaces.
		expect(classifySessionRosterStatus(summaryFor(false, false, false))).toBe("inactive");
		expect(classifySubagentSnapshotStatus(childFor(false, false), new Set())).toBe("inactive");
	});

	it("treats a child run without a session yet as a running queued child", () => {
		expect(classifySubagentSnapshotStatus(childFor(false, true), new Set())).toBe("running");
		expect(classifySubagentSnapshotStatus({ ...childFor(false, false), status: "queued" }, new Set())).toBe(
			"running",
		);
	});
});
