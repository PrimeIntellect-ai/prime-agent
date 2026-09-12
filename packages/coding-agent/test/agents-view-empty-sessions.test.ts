import { describe, expect, it } from "vitest";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import { filterEmptyAgentsViewSessions, reconcileUnifiedSessions } from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function saved(id: string, overrides: Partial<AgentConnectionSavedSessionInfo> = {}): AgentConnectionSavedSessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp/project",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 0,
		firstMessage: "(no messages)",
		allMessagesText: "",
		...overrides,
	};
}

function live(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: id,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 0,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

describe("agents view empty session filtering", () => {
	it("hides only abandoned empty saved sessions and leaves the catalog intact", () => {
		const records = reconcileUnifiedSessions(
			[],
			[
				saved("empty"),
				saved("conversation", { messageCount: 2, firstMessage: "Fix authentication" }),
				saved("named", { name: "My next task" }),
				saved("usage", { usage: { inputTokens: 20, outputTokens: 5, cost: 0.01 } }),
			],
		);
		expect(filterEmptyAgentsViewSessions(records).map((record) => record.saved?.id)).toEqual([
			"conversation",
			"named",
			"usage",
		]);
		expect(records).toHaveLength(4);
		expect(records[0]?.saved?.firstMessage).toBe("(no messages)");
	});

	it("preserves active sessions, the entered-from session, and scheduled sessions", () => {
		const records = reconcileUnifiedSessions(
			[live("idle"), live("working", { isSessionActive: true, isStreaming: true, activity: "working" })],
			[saved("anchor"), saved("scheduled"), saved("empty")],
		);
		expect(
			filterEmptyAgentsViewSessions(records, new Set(["anchor", "scheduled"])).map(
				(record) => record.daemon?.sessionId ?? record.saved?.id,
			),
		).toEqual(["idle", "working", "anchor", "scheduled"]);
	});

	it("retains empty ancestors and subagents so their hierarchy stays navigable", () => {
		const records = reconcileUnifiedSessions(
			[],
			[saved("parent"), saved("child", { parentSessionPath: "/tmp/parent.jsonl", rlmDepth: 1 }), saved("empty")],
		);
		expect(filterEmptyAgentsViewSessions(records).map((record) => record.saved?.id)).toEqual(["parent", "child"]);
	});
});
