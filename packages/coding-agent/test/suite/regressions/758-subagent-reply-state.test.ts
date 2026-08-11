import { describe, expect, it } from "vitest";
import { type AgentFamilyCatalogEntry, buildAgentFamilyRoster } from "../../../src/core/agent-messages.js";

function entry(
	overrides: Partial<AgentFamilyCatalogEntry> & Pick<AgentFamilyCatalogEntry, "id">,
): AgentFamilyCatalogEntry {
	return { depth: 0, status: "idle", ...overrides };
}

function child(id: string, repliedSinceTask?: boolean): AgentFamilyCatalogEntry {
	return entry({
		id,
		name: id,
		depth: 1,
		parentSessionId: "parent",
		...(repliedSinceTask === undefined ? {} : { repliedSinceTask }),
	});
}

function rosterFor(children: AgentFamilyCatalogEntry[]) {
	const parent = entry({ id: "parent", name: "lead", depth: 0 });
	return buildAgentFamilyRoster(parent, [parent, ...children]);
}

function byId(roster: ReturnType<typeof buildAgentFamilyRoster>, id: string) {
	return roster.entries.find((row) => row.id === id);
}

/**
 * `repliedSinceTask` looked non-deterministic to orchestrators: the same child
 * reported `True` on one poll and a falsy value on the next. It is not a race. The
 * flag is three-valued — replied, not replied, and unknown — but the third state is
 * encoded as an absent key, so it is indistinguishable from `False` to any caller
 * that reads it with a falsy check or a defaulted lookup. A child is unknown
 * whenever the daemon cannot read its live session, which includes a child that
 * replied and was then evicted.
 *
 * These cases pin the contract the reporter tripped on so the three states stay
 * distinguishable at the roster boundary.
 */
describe("issue #758 subagent reply state", () => {
	it("distinguishes replied from not replied", () => {
		const roster = rosterFor([child("answered", true), child("silent", false)]);

		expect(byId(roster, "answered")?.repliedSinceTask).toBe(true);
		expect(byId(roster, "silent")?.repliedSinceTask).toBe(false);
	});

	it("encodes unknown as an absent key, never as false", () => {
		const row = byId(rosterFor([child("evicted")]), "evicted");

		expect(row).not.toHaveProperty("repliedSinceTask");
		expect(row?.repliedSinceTask).toBeUndefined();
		// The distinction that made the flag look unreliable: a child that replied and
		// was then evicted is unknown, not "has not replied".
		expect(row?.repliedSinceTask).not.toBe(false);
	});

	it("keeps unknown separable from not-replied in the same roster", () => {
		const roster = rosterFor([child("silent", false), child("evicted")]);

		expect(Object.hasOwn(byId(roster, "silent")!, "repliedSinceTask")).toBe(true);
		expect(Object.hasOwn(byId(roster, "evicted")!, "repliedSinceTask")).toBe(false);
	});

	it("leaves non-child rows without the flag", () => {
		const parent = entry({ id: "parent", name: "lead", depth: 1, parentSessionId: "grandparent" });
		const self = entry({ id: "self", name: "self", depth: 2, parentSessionId: "parent" });
		const sibling = entry({ id: "sibling", name: "sibling", depth: 2, parentSessionId: "parent" });
		const roster = buildAgentFamilyRoster(self, [parent, self, sibling]);

		expect(byId(roster, "parent")).not.toHaveProperty("repliedSinceTask");
		expect(byId(roster, "sibling")).not.toHaveProperty("repliedSinceTask");
	});
});
