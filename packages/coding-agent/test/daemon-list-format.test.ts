import type { Api, Model } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { formatSessionListTable } from "../src/cli/daemon-list-format.js";
import type {
	DaemonWorkflowStatusProjection,
	SessionActivity,
	SessionLifecycle,
	SessionSummary,
} from "../src/modes/daemon/daemon-session-list.js";

describe("formatSessionListTable", () => {
	it("sorts sessions by status and renders compact suffix ids", () => {
		const nowMs = Date.parse("2026-05-29T12:00:00.000Z");
		const table = stripAnsi(
			formatSessionListTable(
				[
					makeSummary({
						name: "sleep",
						id: "019e71ec-e08a-75a9-b573-fc10e9f8380f",
						lifecycle: "archived",
						activity: "idle",
					}),
					makeSummary({ name: "tool", id: "ccccddddeeee", lifecycle: "live", activity: "working" }),
					makeSummary({
						name: "crash",
						id: "019e71ec-e08a-75a9-b573-abcdef123456",
						lifecycle: "archived",
						activity: "idle",
					}),
					makeSummary({ name: "idle", id: "bbbbccccdddd", lifecycle: "live", activity: "idle" }),
					makeSummary({ name: "model", id: "ddddeeeeffff", lifecycle: "live", activity: "working" }),
					makeSummary({
						name: "approval",
						id: "eeeeffff1111",
						lifecycle: "live",
						activity: "idle",
						workflowStatus: {
							workflowId: "workflow-1",
							status: "awaiting_user",
							phase: "adjudicating",
							nextGate: "approval_gate",
							nextTask: "review-evidence",
							blocker: { kind: "awaiting_external", reason: "Approval is required" },
							headDigest: "head-immutable-1",
							approvalRequest: {
								approvalRequestId: "approval-1",
								question: "Choose a dispatch mode",
								expiresAt: "2026-05-01T01:00:00.000Z",
								expectedResponseSequence: 4,
								headDigest: "head-immutable-1",
								stateDigest: "state-1",
								options: [{ optionId: "approve", label: "Approve", effectDigest: "effect-1" }],
							},
						} satisfies DaemonWorkflowStatusProjection,
					}),
					makeSummary({
						name: "user",
						id: "aaaabbbbcccc",
						lifecycle: "live",
						activity: "idle",
						clients: 1,
						model: { provider: "openai-codex", id: "gpt-5.5" } as Model<Api>,
					}),
				],
				nowMs,
			),
		);

		const lines = table.split("\n");
		expect(lines[0]!.trim().split(/\s+/)).toEqual([
			"name",
			"id",
			"status",
			"workflow",
			"next",
			"blocker",
			"head",
			"age",
			"model",
			"messages",
			"clients",
		]);
		expect(lines.slice(1).map((line) => line.trim().split(/\s+/).slice(0, 3))).toEqual([
			["tool", "ccccddddeeee", "working"],
			["model", "ddddeeeeffff", "working"],
			["idle", "bbbbccccdddd", "idle"],
			["approval", "eeeeffff1111", "idle"],
			["user", "aaaabbbbcccc", "idle"],
			["sleep", "fc10e9f8380f", "archived"],
			["crash", "abcdef123456", "archived"],
		]);
		expect(table).toContain("openai-codex/gpt-5.5");
		expect(table).toContain("awaiting_user/adjudicating");
		expect(table).toContain("approval_gate/review-evidence/approval:approval-1");
		expect(table).toContain("awaiting_external:Approval is required");
		expect(table).toContain("head-immutable-1");
		expect(table).not.toContain("/tmp/project");
		expect(table).not.toContain("019e71ec-e08a");
	});
});

function makeSummary(options: {
	name: string;
	id: string;
	lifecycle: SessionLifecycle;
	activity: SessionActivity;
	clients?: number;
	model?: Model<Api>;
	workflowStatus?: DaemonWorkflowStatusProjection;
}): SessionSummary {
	return {
		id: options.id,
		lifecycle: options.lifecycle,
		activity: options.activity,
		isSessionActive: options.activity === "working",
		sessionId: options.id,
		sessionName: options.name,
		cwd: "/tmp/project",
		model: options.model,
		workflowStatus: options.workflowStatus,
		isStreaming: options.lifecycle === "live" && options.activity === "working",
		isCompacting: false,
		attachedClients: options.clients ?? 0,
		messageCount: 2,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		modified: "2026-05-29T10:00:00.000Z",
	};
}
