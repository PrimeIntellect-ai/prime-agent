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
	computeClass: "standard",
};

function graph(
	verifierOwned: readonly string[],
	options: { readonly viaIntermediate?: boolean } = {},
): Record<string, unknown> {
	const build = {
		...BASE,
		taskId: "build",
		objective: "Write the model",
		dependencyTaskIds: [],
		outputRefs: ["src/model.py"],
		ownedPaths: ["src"],
		role: "implementation",
	};
	const middle = {
		...BASE,
		taskId: "middle",
		objective: "Integrate",
		dependencyTaskIds: ["build"],
		outputRefs: ["artifacts/mid.json"],
		ownedPaths: ["artifacts/mid"],
		role: "integration",
	};
	const verify = {
		...BASE,
		taskId: "verify",
		objective: "Check the model",
		dependencyTaskIds: options.viaIntermediate === true ? ["middle"] : ["build"],
		outputRefs: ["artifacts/verify.json"],
		ownedPaths: verifierOwned,
		role: "verification",
	};
	const attack = {
		...BASE,
		taskId: "attack",
		objective: "Break it",
		dependencyTaskIds: ["verify"],
		outputRefs: ["artifacts/attack.json"],
		ownedPaths: ["artifacts/attack"],
		role: "red-team",
	};
	const tasks = options.viaIntermediate === true ? [build, middle, verify, attack] : [build, verify, attack];
	return { schemaVersion: 1, graphRevision: 1, tasks };
}

describe("checker independence", () => {
	it("accepts a verifier that owns only its own artifact", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph(["artifacts/verify"]))).not.toThrow();
	});

	it("refuses a verifier that owns the paths it checks", () => {
		// Overlapping ownership between a task and its dependency is permitted by the graph validator,
		// so without this the verifier could rewrite src/ and then attest it.
		expect(() => normalizeWorkflowTaskGraphSource(graph(["src"]))).toThrow(
			"workflow_task_graph_source_checker_owns_checked_paths_verify_build",
		);
	});

	it("refuses a narrower path inside what it checks", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph(["src/model.py"]))).toThrow(
			"workflow_task_graph_source_checker_owns_checked_paths_verify_build",
		);
	});

	it("refuses across an intermediate task, since two hops is not independence", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph(["src"], { viaIntermediate: true }))).toThrow(
			"workflow_task_graph_source_checker_owns_checked_paths_verify_build",
		);
	});

	it("does not confuse a sibling directory for the checked one", () => {
		expect(() => normalizeWorkflowTaskGraphSource(graph(["srcfoo"]))).not.toThrow();
	});
});
