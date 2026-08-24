import { describe, expect, it } from "vitest";
import { workflowToolsForCapabilities } from "../src/core/workflow/default-task-runtime.js";

/**
 * A stage's declared capabilities must become the worker's actual tool set. Before this,
 * capabilities were validated for internal consistency but never consulted at dispatch, so a
 * spawned worker inherited every tool regardless of the role it was given.
 */
describe("capability to tool allowlist", () => {
	it("gives an adversarial role no way to edit the work it reviews", () => {
		const tools = workflowToolsForCapabilities(["read", "red_team"]);
		expect(tools).toBeDefined();
		expect(tools).not.toContain("edit");
		expect(tools).toContain("ipython");
	});

	it("grants edit only when the stage declares a writing capability", () => {
		expect(workflowToolsForCapabilities(["read"])).not.toContain("edit");
		expect(workflowToolsForCapabilities(["read", "write_owned_paths"])).toContain("edit");
		expect(workflowToolsForCapabilities(["read", "edit"])).toContain("edit");
	});

	it("returns undefined when nothing is declared, preserving existing behaviour", () => {
		expect(workflowToolsForCapabilities(undefined)).toBeUndefined();
		expect(workflowToolsForCapabilities([])).toBeUndefined();
	});

	it("ignores unknown capabilities rather than granting them tools", () => {
		expect(workflowToolsForCapabilities(["not_a_capability"])).toBeUndefined();
		expect(workflowToolsForCapabilities(["not_a_capability", "read"])).toEqual(["ipython"]);
	});

	it("is deterministic and deduplicated", () => {
		expect(workflowToolsForCapabilities(["read", "ipython", "verification"])).toEqual(["bash", "ipython"]);
	});
});
