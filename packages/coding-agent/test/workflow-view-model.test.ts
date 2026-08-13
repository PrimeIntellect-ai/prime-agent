import { describe, expect, it } from "vitest";
import type { WorkflowRunRecord } from "../src/core/workflows/storage.js";
import { toWorkflowPanelData } from "../src/core/workflows/view-model.js";

function run(): WorkflowRunRecord {
	return {
		version: 2,
		runId: "wf_test",
		taskId: "task_test",
		workflowName: "audit",
		cwd: "/tmp/project",
		status: "running",
		startedAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:01.000Z",
		phases: ["Plan", "Verify"],
		progress: {
			agents: [
				{
					id: 2,
					label: "planner",
					phase: "Plan",
					status: "completed",
					prompt: "Plan the change",
					model: "github-copilot/gpt-4.1",
					usage: { input: 10, output: 5, totalTokens: 15, cost: 0.1 },
				},
			],
		},
	};
}

describe("toWorkflowPanelData", () => {
	it("groups persisted agents into declared phases and preserves inspector details", () => {
		const panel = toWorkflowPanelData(run(), ["Stop", "Back"], "/tmp/agent");
		expect(panel).toMatchObject({
			cwd: "/tmp/project",
			agentDir: "/tmp/agent",
			startedAt: "2026-01-01T00:00:00.000Z",
			phases: [
				{
					title: "Plan",
					agents: [expect.objectContaining({ id: 2, model: "github-copilot/gpt-4.1", totalTokens: 15 })],
				},
				{ title: "Verify", agents: [] },
			],
		});
	});
});
