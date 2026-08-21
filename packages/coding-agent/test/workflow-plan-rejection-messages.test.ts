import { describe, expect, it } from "vitest";
import { normalizeWorkflowTaskGraphSource } from "../src/core/workflow/brainstorm.js";

const BASE = {
	requirementIds: ["check-a"],
	completionCriteria: ["inv-a"],
	boundaryIds: ["inv-a"],
	inputRefs: [] as string[],
	evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
	budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
	recovery: "retry",
	authority: ["read_workspace"],
};

function graph(tasks: readonly Record<string, unknown>[]): Record<string, unknown> {
	return { schemaVersion: 1, graphRevision: 1, tasks };
}

function build(role: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...BASE, taskId: "build", objective: "o", dependencyTaskIds: [], outputRefs: ["src/a.py"], role, ...extra };
}

/**
 * A rejected plan is corrective, not fatal: agent-loop turns a thrown tool error into
 * createErrorToolResult(error.message), so the planner reads this text and revises. A bare code
 * costs it turns guessing; these assert the remedy travels with the code.
 */
describe("plan rejection messages carry a remedy", () => {
	it("names the role to add when one is missing", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph([build("implementation")]))).toThrow(
			/missing_role_verification: add a task with "role": "verification"/,
		);
	});

	it("says what terminal means for a red-team task", () => {
		const tasks = [
			build("implementation"),
			{ ...BASE, taskId: "attack", objective: "o", dependencyTaskIds: [], outputRefs: ["a.json"], role: "red-team" },
			{
				...BASE,
				taskId: "v",
				objective: "o",
				dependencyTaskIds: ["attack"],
				outputRefs: ["v.json"],
				role: "verification",
			},
		];
		expect(() => normalizeWorkflowTaskGraphSource(graph(tasks))).toThrow(
			/red_team_not_terminal: .*nothing depending on it/,
		);
	});

	it("lists the legal compute classes", () => {
		expect(() =>
			normalizeWorkflowTaskGraphSource(graph([build("implementation", { computeClass: "huge" })])),
		).toThrow(/compute_class_invalid: computeClass must be "cheap", "standard", or "deep"/);
	});

	it("lists the legal roles", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph([build("supervisor")]))).toThrow(
			/role_invalid: role must be one of .*implementation/,
		);
	});

	it("tells a checker what to own instead", () => {
		const tasks = [
			{ ...build("implementation"), ownedPaths: ["src"] },
			{
				...BASE,
				taskId: "verify",
				objective: "o",
				dependencyTaskIds: ["build"],
				outputRefs: ["v.json"],
				ownedPaths: ["src"],
				role: "verification",
			},
			{
				...BASE,
				taskId: "attack",
				objective: "o",
				dependencyTaskIds: ["verify"],
				outputRefs: ["a.json"],
				role: "red-team",
			},
		];
		expect(() => normalizeWorkflowTaskGraphSource(graph(tasks))).toThrow(
			/checks "build" and must not own paths that "build" owns/,
		);
	});
});
