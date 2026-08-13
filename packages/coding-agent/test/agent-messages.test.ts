import { describe, expect, it } from "vitest";
import {
	AGENT_FAMILY_REACH_ERROR,
	assertAgentFamilyReach,
	buildAgentFamilyRoster,
} from "../src/core/agent-messages.js";

describe("agent message structural family validation", () => {
	it("excludes malformed family edges while retaining catalog-resolved depth-two siblings", () => {
		const root = { id: "root", depth: 0, status: "running" as const, sessionPath: "/root" };
		const otherRoot = { id: "other-root", depth: 0, status: "running" as const, sessionPath: "/other" };
		const child = {
			id: "child",
			depth: 1,
			status: "idle" as const,
			parentSessionPath: "/root",
			sessionPath: "/child",
		};
		const malformedRoot = {
			id: "malformed-root",
			depth: 0,
			status: "idle" as const,
			parentSessionId: "root",
			parentSessionPath: "/root",
		};
		const contradictoryChild = {
			id: "contradictory-child",
			depth: 1,
			status: "idle" as const,
			parentSessionId: "root",
			parentSessionPath: "/other",
		};
		const depthSkippingDescendant = {
			id: "depth-skipping-descendant",
			depth: 2,
			status: "idle" as const,
			parentSessionId: "root",
			parentSessionPath: "/root",
		};
		const malformedDeepSiblingA = {
			id: "malformed-deep-sibling-a",
			depth: 2,
			status: "idle" as const,
			parentSessionId: "root",
			parentSessionPath: "/root",
		};
		const malformedDeepSiblingB = {
			id: "malformed-deep-sibling-b",
			depth: 2,
			status: "idle" as const,
			parentSessionId: "root",
			parentSessionPath: "/root",
		};
		const catalog = [
			root,
			child,
			malformedRoot,
			contradictoryChild,
			depthSkippingDescendant,
			malformedDeepSiblingA,
			malformedDeepSiblingB,
		];

		// A root carrying a parent claim, contradictory dual claims, and a skipped
		// depth must not become a direct family edge.
		for (const malformed of [malformedRoot, contradictoryChild, depthSkippingDescendant]) {
			expect(() => assertAgentFamilyReach(root, malformed, catalog)).toThrow(AGENT_FAMILY_REACH_ERROR);
			expect(() => assertAgentFamilyReach(malformed, root, catalog)).toThrow(AGENT_FAMILY_REACH_ERROR);
		}
		expect(() => assertAgentFamilyReach(otherRoot, contradictoryChild, catalog)).toThrow(AGENT_FAMILY_REACH_ERROR);

		// Two malformed depth-two rows that claim the root are not pseudo-siblings,
		// and neither leaks into a roster.
		expect(() => assertAgentFamilyReach(malformedDeepSiblingA, malformedDeepSiblingB, catalog)).toThrow(
			AGENT_FAMILY_REACH_ERROR,
		);
		expect(buildAgentFamilyRoster(malformedDeepSiblingA, catalog).entries).toEqual([]);
		expect(buildAgentFamilyRoster(root, catalog).entries.map((entry) => entry.id)).toEqual(["child"]);

		// A real depth-one parent in the supplied catalog restores legitimate
		// depth-two siblings without weakening the malformed-edge exclusions above.
		const deepParent = { id: "deep-parent", depth: 1, status: "running" as const, sessionPath: "/deep-parent" };
		const deepSiblingA = {
			id: "deep-sibling-a",
			depth: 2,
			status: "idle" as const,
			parentSessionId: "deep-parent",
			parentSessionPath: "/deep-parent",
		};
		const deepSiblingB = {
			id: "deep-sibling-b",
			depth: 2,
			status: "idle" as const,
			parentSessionPath: "/deep-parent",
		};
		const deepCatalog = [deepParent, deepSiblingA, deepSiblingB];
		expect(() => assertAgentFamilyReach(deepSiblingA, deepSiblingB)).toThrow(AGENT_FAMILY_REACH_ERROR);
		expect(assertAgentFamilyReach(deepSiblingA, deepSiblingB, deepCatalog)).toBe("sibling");
		expect(assertAgentFamilyReach(deepSiblingB, deepSiblingA, deepCatalog)).toBe("sibling");
	});
});
