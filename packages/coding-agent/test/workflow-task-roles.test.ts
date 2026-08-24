import { describe, expect, it } from "vitest";
import { normalizeWorkflowTaskGraphSource } from "../src/core/workflow/brainstorm.js";

const ACCEPT = ["check-test-passes"];
const INVARIANTS = ["inv-test-file-unmodified"];

function task(taskId: string, role: string | undefined, dependencyTaskIds: string[] = []): unknown {
	return {
		taskId,
		objective: `do ${taskId}`,
		requirementIds: ACCEPT,
		completionCriteria: INVARIANTS,
		dependencyTaskIds,
		boundaryIds: INVARIANTS,
		inputRefs: [],
		outputRefs: [`${taskId}.py`],
		evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
		budget: { tokenLimit: 20000, wallTimeLimitSeconds: 300, spendLimitMicrounits: 0 },
		recovery: "retry",
		authority: ["read_workspace"],
		...(role === undefined ? {} : { role }),
	};
}

function graph(tasks: unknown[]): unknown {
	return { schemaVersion: 1, graphRevision: 1, tasks };
}

describe("task roles are a closed list the planner cannot opt out of", () => {
	it("rejects a graph of pure implementation nodes, which would skip every check", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph([task("fix-add", undefined)]))).toThrow(
			/missing_role_verification/,
		);
	});

	it("accepts a graph that declares the required check roles", () => {
		const source = normalizeWorkflowTaskGraphSource(
			graph([
				task("fix-add", "implementation"),
				task("verify-add", "verification", ["fix-add"]),
				task("attack-add", "red-team", ["verify-add"]),
			]),
		) as { tasks: readonly { taskId: string; role?: string }[] };

		expect(source.tasks.map((t) => t.role).sort()).toEqual(["implementation", "red-team", "verification"]);
	});

	it("rejects a red-team task that reviews nothing, which would satisfy the rule vacuously", () => {
		// red-team first, depending on nothing: the role is present but it reviews an empty tree.
		expect(() =>
			normalizeWorkflowTaskGraphSource(
				graph([
					task("attack-first", "red-team"),
					task("fix-add", "implementation"),
					task("v", "verification", ["fix-add"]),
				]),
			),
		).toThrow(/red_team_not_terminal/);
	});

	it("rejects a red-team task that other work depends on, since it would not see the finished artifact", () => {
		expect(() =>
			normalizeWorkflowTaskGraphSource(
				graph([
					task("fix-add", "implementation"),
					task("attack-mid", "red-team", ["fix-add"]),
					task("v", "verification", ["attack-mid"]),
				]),
			),
		).toThrow(/red_team_not_terminal/);
	});

	it("rejects a role outside the vocabulary rather than treating it as implementation", () => {
		expect(() =>
			normalizeWorkflowTaskGraphSource(
				graph([task("a", "reviewer-ish"), task("v", "verification"), task("r", "red-team")]),
			),
		).toThrow(/role_invalid/);
	});
});
