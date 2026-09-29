import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionListTable } from "../src/cli/daemon-list-format.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "local-active",
		activeSessionId: "local-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "local-session",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

const FIXED_NOW = new Date("2026-01-01T01:00:00Z").getTime();
const remoteRow = (overrides: Partial<SessionSummary> = {}) =>
	summary({
		id: "remote-active",
		activeSessionId: "remote-active",
		sessionId: "remote-session",
		sessionName: "mesh-agent",
		remoteHost: "milk.tailnet.ts.net",
		...overrides,
	});

describe("formatSessionListTable remote mesh rows", () => {
	it("keeps local tables column-identical and adds host + offline only for remote rows", () => {
		// A purely local table keeps its long-standing layout: no host column.
		const localHeader = stripAnsi(formatSessionListTable([summary()], FIXED_NOW)).split("\n")[0]!;
		expect(localHeader).not.toContain("host");
		const table = stripAnsi(
			formatSessionListTable(
				[
					summary({ sessionName: "local" }),
					remoteRow({ remoteModel: { provider: "anthropic", modelId: "claude-sonnet" } }),
					remoteRow({ id: "gone-active", sessionId: "gone-session", remoteOffline: true, activity: "working" }),
				],
				FIXED_NOW,
			),
		);
		const [header, localRow, reachableRow, offlineRow] = table.split("\n");
		expect(header).toContain("host");
		expect(localRow).not.toContain("milk.tailnet.ts.net");
		// Remote rows carry a display-only model identity instead of a full Model.
		expect(reachableRow).toContain("milk.tailnet.ts.net");
		expect(reachableRow).toContain("anthropic/claude-sonnet");
		expect(reachableRow).toContain("idle");
		// An unreachable peer reads offline even while its last known activity says working.
		expect(offlineRow).toContain("offline");
	});
});
