import assert from "node:assert/strict";
import test from "node:test";
import type { AgentFamilyCatalogEntry } from "../src/core/agent-messages.js";
import { assertAgentSessionNameAvailable, sessionNameReservationKey } from "../src/core/agent-messages.js";

function entry(id: string, name: string, depth: number): AgentFamilyCatalogEntry {
	return { id, name, depth, status: "running" };
}

test("assertAgentSessionNameAvailable fails closed on a sibling name conflict", () => {
	const catalog = [entry("s1", "PA-AGI-Executor", 0)];
	assert.throws(
		() =>
			assertAgentSessionNameAvailable(catalog, {
				name: "PA-AGI-Executor",
				depth: 0,
				ignoreSessionId: undefined,
			}),
		/unavailable/,
	);
});

test("assertAgentSessionNameAvailable allows a distinct name", () => {
	const catalog = [entry("s1", "PA-AGI-Executor", 0)];
	assert.doesNotThrow(() =>
		assertAgentSessionNameAvailable(catalog, {
			name: "PA-AGI-Executor-2",
			depth: 0,
			ignoreSessionId: undefined,
		}),
	);
});

test("sessionNameReservationKey separates root siblings from child scopes", () => {
	const rootKey = sessionNameReservationKey({ name: "X", depth: 0 });
	const childKey = sessionNameReservationKey({ name: "X", depth: 1, parentSessionId: "p" });
	assert.notEqual(rootKey, childKey);
});
