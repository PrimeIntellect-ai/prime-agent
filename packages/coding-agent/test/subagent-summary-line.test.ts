import { describe, expect, it } from "vitest";
import type { AgentConnectionRlmChildAgentSnapshot } from "../src/modes/agent-connection/types.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import {
	countRosterSubagentStatuses,
	countSubtreeSubagentStatuses,
} from "../src/modes/interactive/components/subagent-summary-line.js";

function child(
	id: string,
	status: AgentConnectionRlmChildAgentSnapshot["status"],
	overrides: Partial<AgentConnectionRlmChildAgentSnapshot> = {},
): AgentConnectionRlmChildAgentSnapshot {
	return { id, label: id, status, sessionDir: `/tmp/${id}`, ...overrides };
}

function summary(id: string, overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id,
		sessionId: id,
		lifecycle: "live",
		runtimeKind: "subagent",
		rlmChildId: id,
		...overrides,
	} as SessionSummary;
}

describe("subagent status projections", () => {
	it("counts the whole snapshot subtree using running, idle, and inactive projections", () => {
		const children = [
			child("running", "running"),
			child("queued", "queued"),
			child("active", "done", { activity: { kind: "writing" } }),
			child("heartbeat", "done", { activeSessionId: "heartbeat-session" }),
			child("idle-done", "done", { activeSessionId: "idle-done-session" }),
			child("idle-error", "error", { activeSessionId: "idle-error-session" }),
			child("inactive-done", "done"),
			child("inactive-error", "error"),
			child("cancelled", "cancelled"),
			child("grandchild", "running", { parentId: "running" }),
			child("great-grandchild", "done", { activeSessionId: "gg-session", parentId: "grandchild" }),
			child("foreign", "running", { parentId: "stranger" }),
		];

		expect(countSubtreeSubagentStatuses(children, undefined)).toEqual({
			total: 10,
			running: 4,
			idle: 4,
			inactive: 2,
		});
	});

	it("counts the whole roster subtree, not just direct children", () => {
		const rows = [
			summary("c1", { parentSessionId: "root-session", rosterStatus: "idle" }),
			summary("gc1", { activeSessionId: "gc1-active", parentSessionId: "c1", rosterStatus: "running" }),
			summary("gg1", { parentActiveSessionId: "gc1-active", rosterStatus: "running" }),
			summary("ac1", { lifecycle: "archived", parentSessionId: "root-session", rosterStatus: "inactive" }),
			summary("ag1", { parentSessionId: "ac1", rosterStatus: "running" }),
			summary("f1", { parentSessionId: "other-root", rosterStatus: "running" }),
		];

		expect(countRosterSubagentStatuses(rows, { sessionId: "root-session" })).toEqual({
			total: 4,
			running: 3,
			idle: 1,
			inactive: 0,
		});
	});
});
