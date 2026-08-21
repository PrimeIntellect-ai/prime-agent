import { describe, expect, it } from "vitest";
import { normalizeWorkflowTaskGraphSource, workflowBrainstormPrompt } from "../src/core/workflow/brainstorm.js";

/**
 * The worked example is the shape a planner copies most directly, and the rules it has to satisfy
 * live in a different function from the text that teaches them. That is the producer/validator split
 * that has caused every expensive defect on this workflow, with the difference that here both sides
 * are mine. Extract the example from the real prompt rather than a copy, so the two cannot drift.
 */
function workedExampleGraph(): unknown {
	const prompt = workflowBrainstormPrompt({
		version: 1,
		draftId: "draft",
		workflowId: "workflow",
		prompt: "objective",
		previousToolNames: [],
		status: "draft",
		createdAt: new Date(0).toISOString(),
	});
	const marker = "taskGraphSource ";
	const start = prompt.indexOf(marker, prompt.indexOf("Worked example"));
	if (start === -1) throw new Error("worked example taskGraphSource not found in the prompt");
	const json = prompt.slice(start + marker.length);
	// Walk to the matching close brace so the assertion does not depend on what follows the example.
	let depth = 0;
	for (let index = 0; index < json.length; index += 1) {
		if (json[index] === "{") depth += 1;
		if (json[index] === "}") {
			depth -= 1;
			if (depth === 0) return JSON.parse(json.slice(0, index + 1));
		}
	}
	throw new Error("worked example taskGraphSource is not balanced");
}

describe("the plan guidance's worked example", () => {
	it("is accepted by the validator that judges real plans", () => {
		expect(() => normalizeWorkflowTaskGraphSource(workedExampleGraph())).not.toThrow();
	});

	it("demonstrates the roles the validator requires", () => {
		const source = normalizeWorkflowTaskGraphSource(workedExampleGraph());
		const roles = new Set(source.tasks.map((task) => task.role));
		expect(roles).toContain("verification");
		expect(roles).toContain("red-team");
	});

	it("shows the red-team task last, which is what terminal means", () => {
		const source = normalizeWorkflowTaskGraphSource(workedExampleGraph());
		const dependedUpon = new Set(source.tasks.flatMap((task) => task.dependencyTaskIds));
		const redTeam = source.tasks.filter((task) => task.role === "red-team");
		expect(redTeam).toHaveLength(1);
		expect(dependedUpon.has(redTeam[0]!.taskId)).toBe(false);
		expect(redTeam[0]!.dependencyTaskIds.length).toBeGreaterThan(0);
	});

	it("obeys the ownership rules it teaches: writer owns a workspace root, checkers own nothing", () => {
		// The guidance tells a plan to declare ownedPaths for code and keep it under a workspace root,
		// and refuses a checker that owns what it checks. An example that broke either rule would be
		// copied straight into a rejected plan.
		const source = normalizeWorkflowTaskGraphSource(workedExampleGraph());
		const byRole = new Map(source.tasks.map((task) => [task.role, task]));
		expect(byRole.get("implementation")?.ownedPaths).toEqual(["src"]);
		expect(byRole.get("implementation")?.outputRefs?.every((ref) => ref.startsWith("src/"))).toBe(true);
		expect(byRole.get("verification")?.ownedPaths ?? []).toEqual([]);
		expect(byRole.get("red-team")?.ownedPaths ?? []).toEqual([]);
	});
});
