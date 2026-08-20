import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

/**
 * A queued input must still be delivered after an abort.
 *
 * Regression: requestAbort() suspends the input pump, and the only recovery lived in
 * abort()'s finally block gated on _hasSelectableAgentMessageInput() — true only for
 * agent-to-agent messages. Any other queued input (follow-up, heartbeat, cron) left the pump
 * suspended forever: the queue filled and never popped.
 */
interface PumpInternals {
	_sessionInputPumpSuspended: boolean;
	_hasSelectableSessionInput(): boolean;
	_hasSelectableAgentMessageInput(): boolean;
	_resumeSessionInputPumpAfterAbort(): void;
}

describe("session input pump resumes after abort", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("resumes for a queued follow-up, which is not an agent message", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as PumpInternals;

		await harness.session.followUp("continue please", undefined, { resumeIfIdle: false });

		// The precondition that made this bug invisible: there IS selectable input, but the
		// old recovery predicate does not see it.
		expect(session._hasSelectableSessionInput()).toBe(true);
		expect(session._hasSelectableAgentMessageInput()).toBe(false);

		session._sessionInputPumpSuspended = true;
		session._resumeSessionInputPumpAfterAbort();

		expect(session._sessionInputPumpSuspended).toBe(false);
	});

	it("stays suspended when nothing is queued", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as PumpInternals;

		expect(session._hasSelectableSessionInput()).toBe(false);
		session._sessionInputPumpSuspended = true;
		session._resumeSessionInputPumpAfterAbort();

		expect(session._sessionInputPumpSuspended).toBe(true);
	});
});
