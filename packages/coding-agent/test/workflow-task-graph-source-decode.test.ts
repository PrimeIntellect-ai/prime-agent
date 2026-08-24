import { describe, expect, it } from "vitest";
import { normalizeWorkflowTaskGraphSource } from "../src/core/workflow/brainstorm.js";

const GRAPH = {
	schemaVersion: 1,
	graphRevision: 1,
	tasks: [
		{
			taskId: "fix-add",
			objective: "Change add() in calc.py to return a + b",
			requirementIds: ["req-add-correct"],
			completionCriteria: ["test_calc.py passes"],
			dependencyTaskIds: [],
			boundaryIds: ["inv-no-test-edit"],
			inputRefs: [],
			outputRefs: ["calc.py"],
			evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
			budget: { tokenLimit: 20000, wallTimeLimitSeconds: 300, spendLimitMicrounits: 0 },
			recovery: "retry",
			authority: ["read_workspace"],
			computeClass: "standard",
			role: "implementation",
		},
		{
			taskId: "verify-add",
			objective: "Run test_calc.py and confirm it passes",
			requirementIds: ["check-test-passes"],
			completionCriteria: ["inv-no-test-edit"],
			dependencyTaskIds: ["fix-add"],
			boundaryIds: ["inv-no-test-edit"],
			inputRefs: [],
			outputRefs: ["artifacts/verify-add.json"],
			evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
			budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
			recovery: "retry",
			authority: ["read_workspace"],
			computeClass: "standard",
			role: "verification",
		},
		{
			taskId: "attack-add",
			objective: "Attempt to break add() with edge-case inputs",
			requirementIds: ["check-test-passes"],
			completionCriteria: ["inv-no-test-edit"],
			dependencyTaskIds: ["verify-add"],
			boundaryIds: ["inv-no-test-edit"],
			inputRefs: [],
			outputRefs: ["artifacts/attack-add.json"],
			evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
			budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
			recovery: "retry",
			authority: ["read_workspace"],
			computeClass: "deep",
			role: "red-team",
		},
	],
};

/**
 * Planners routinely emit a nested object tool parameter as a JSON string. Rejecting that
 * stalled the whole workflow at the planning gate even when the graph content was correct.
 */
describe("task graph source decoding", () => {
	it("accepts a stringified graph and produces the identical result", () => {
		const fromObject = normalizeWorkflowTaskGraphSource(GRAPH);
		const fromString = normalizeWorkflowTaskGraphSource(JSON.stringify(GRAPH));
		expect(fromString.graphDigest).toBe(fromObject.graphDigest);
		// Tasks are sorted canonically by id, so look the task up rather than trusting position.
		expect(fromString.tasks.find((task) => task.taskId === "fix-add")?.computeClass).toBe("standard");
		expect(fromString.tasks.find((task) => task.taskId === "attack-add")?.computeClass).toBe("deep");
	});

	it("still rejects a string that is not a valid graph", () => {
		expect(() => normalizeWorkflowTaskGraphSource("not json")).toThrow(/workflow_task_graph_source_invalid/);
		expect(() => normalizeWorkflowTaskGraphSource(JSON.stringify({ schemaVersion: 2 }))).toThrow();
	});
});
