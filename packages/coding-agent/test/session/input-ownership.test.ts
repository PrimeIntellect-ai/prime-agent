import { describe, expect, it } from "vitest";
import * as legacySession from "../../src/core/agent-session.js";
import * as legacyAutonomy from "../../src/core/autonomous.js";
import * as legacyAdmission from "../../src/core/prompt-admission.js";
import * as legacyRlm from "../../src/core/rlm-runtime.js";
import * as legacyActions from "../../src/core/session-action-store.js";
import * as residency from "../../src/modes/daemon/workers/residency-policy.js";
import * as session from "../../src/session/agent-session.js";
import * as autonomy from "../../src/session/autonomy/autonomous.js";
import * as autonomousContinuation from "../../src/session/autonomy/continuation.js";
import * as childRequests from "../../src/session/children/host-requests.js";
import * as spawnOptions from "../../src/session/children/spawn-options.js";
import * as actions from "../../src/session/input/action-store.js";
import * as bashRequests from "../../src/session/input/bash-host-requests.js";
import * as prepared from "../../src/session/input/prepared-actions.js";
import * as admission from "../../src/session/input/prompt-admission.js";
import * as modelSearch from "../../src/session/models/model-search.js";
import * as legacyPrepared from "../../src/session/prepared-actions.js";
import * as legacyAutonomousContinuation from "../../src/session/turns/autonomous-continuation.js";

describe("session ownership compatibility", () => {
	it.each([
		["session facade", legacySession, session],
		["autonomy", legacyAutonomy, autonomy],
		["autonomous continuation", legacyAutonomousContinuation, autonomousContinuation],
		["prompt admission", legacyAdmission, admission],
		["prepared actions", legacyPrepared, prepared],
		["actions and daemon residency", legacyActions, { ...actions, ...residency }],
		["RLM request adapters", legacyRlm, { ...childRequests, ...spawnOptions, ...bashRequests, ...modelSearch }],
	])("retains identical runtime exports from the former %s path", (_name, legacy, canonical) => {
		expect(Object.keys(legacy).sort()).toEqual(Object.keys(canonical).sort());
		for (const [name, value] of Object.entries(legacy)) {
			expect(value, name).toBe((canonical as Record<string, unknown>)[name]);
		}
	});

	it("shares cancellation class identity across paths", async () => {
		const abort = new AbortController();
		abort.abort();
		await expect(admission.waitForPromptAdmission(Promise.resolve(), abort.signal)).rejects.toBeInstanceOf(
			legacyAdmission.PromptAdmissionCancelledError,
		);
	});
});
