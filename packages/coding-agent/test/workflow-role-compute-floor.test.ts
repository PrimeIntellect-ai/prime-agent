import { describe, expect, it } from "vitest";
import { normalizeWorkflowTaskGraphSource } from "../src/core/workflow/brainstorm.js";
import { workflowComputeClassForRole } from "../src/core/workflow/recipes.js";

describe("role compute floor", () => {
	it("raises a planning task the plan declared cheap", () => {
		expect(workflowComputeClassForRole("planning", "cheap")).toBe("deep");
	});

	it("supplies a tier for a floored role that declared none", () => {
		expect(workflowComputeClassForRole("design", undefined)).toBe("deep");
	});

	it("never lowers a tier the plan asked for", () => {
		expect(workflowComputeClassForRole("red-team", "deep")).toBe("deep");
		expect(workflowComputeClassForRole("implementation", "deep")).toBe("deep");
	});

	it("leaves an unfloored role exactly as declared", () => {
		expect(workflowComputeClassForRole("implementation", "cheap")).toBe("cheap");
		expect(workflowComputeClassForRole("verification", undefined)).toBeUndefined();
		// architect is a builtin stage whose tier BUILTIN_STAGE_COMPUTE owns; the floor must not
		// second-guess it, or one name carries two answers.
		expect(workflowComputeClassForRole("architect", "standard")).toBe("standard");
	});

	it("applies the floor when decoding a plan, not just in the helper", () => {
		const source = normalizeWorkflowTaskGraphSource({
			schemaVersion: 1,
			graphRevision: 1,
			tasks: [
				{
					taskId: "plan-etl",
					objective: "Decide the ETL shape",
					requirementIds: ["check-a"],
					completionCriteria: ["inv-a"],
					dependencyTaskIds: [],
					boundaryIds: ["inv-a"],
					inputRefs: [],
					outputRefs: ["artifacts/plan.json"],
					evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
					budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
					recovery: "retry",
					authority: ["read_workspace"],
					// The plan under-tiers the task every later task depends on.
					computeClass: "cheap",
					role: "planning",
				},
				{
					taskId: "build-etl",
					objective: "Implement the ETL",
					requirementIds: ["check-a"],
					completionCriteria: ["inv-a"],
					dependencyTaskIds: ["plan-etl"],
					boundaryIds: ["inv-a"],
					inputRefs: [],
					outputRefs: ["etl.py"],
					evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
					budget: { tokenLimit: 20000, wallTimeLimitSeconds: 300, spendLimitMicrounits: 0 },
					recovery: "retry",
					authority: ["read_workspace"],
					computeClass: "standard",
					role: "implementation",
				},
				{
					taskId: "verify-etl",
					objective: "Verify the ETL output",
					requirementIds: ["check-a"],
					completionCriteria: ["inv-a"],
					dependencyTaskIds: ["build-etl"],
					boundaryIds: ["inv-a"],
					inputRefs: [],
					outputRefs: ["artifacts/verify.json"],
					evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
					budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
					recovery: "retry",
					authority: ["read_workspace"],
					computeClass: "standard",
					role: "verification",
				},
				{
					taskId: "attack-etl",
					objective: "Attempt to break the ETL",
					requirementIds: ["check-a"],
					completionCriteria: ["inv-a"],
					dependencyTaskIds: ["verify-etl"],
					boundaryIds: ["inv-a"],
					inputRefs: [],
					outputRefs: ["artifacts/attack.json"],
					evidencePolicy: { kind: "command", maxBytes: 4096, maxItems: 4, independent: true },
					budget: { tokenLimit: 8000, wallTimeLimitSeconds: 120, spendLimitMicrounits: 0 },
					recovery: "retry",
					authority: ["read_workspace"],
					computeClass: "cheap",
					role: "red-team",
				},
			],
		});
		const byId = new Map(source.tasks.map((task) => [task.taskId, task.computeClass]));
		expect(byId.get("plan-etl")).toBe("deep");
		expect(byId.get("attack-etl")).toBe("deep");
		expect(byId.get("build-etl")).toBe("standard");
	});
});
