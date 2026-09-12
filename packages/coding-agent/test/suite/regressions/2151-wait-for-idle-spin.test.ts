import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { createHarness, getAssistantTexts } from "../harness.js";

it("parks idle waits while bash blocks the input pump and drains later prompts in order", async () => {
	const harness = await createHarness();
	let releaseBash = () => {};
	const bashGate = new Promise<void>((resolve) => {
		releaseBash = resolve;
	});
	const session = harness.session as unknown as { _scheduleSessionInputPump(): void };
	const schedule = session._scheduleSessionInputPump.bind(session);
	const bash = harness.session.executeBash("held bash", undefined, {
		transient: true,
		operations: {
			exec: async () => {
				await bashGate;
				return { exitCode: 0 };
			},
		},
	});
	try {
		expect(harness.session.isBashRunning).toBe(true);
		harness.setResponses([fauxAssistantMessage("first done"), fauxAssistantMessage("second done")]);
		const first = harness.session.prompt("first");
		await yieldToEventLoop();
		let schedules = 0;
		session._scheduleSessionInputPump = () => {
			schedules++;
			// Release even under the regression so microtask starvation cannot hang the test runner.
			if (schedules === 200) releaseBash();
			schedule();
		};
		const idle = harness.session.waitForIdle();
		await yieldToEventLoop();
		const second = harness.session.prompt("second");
		releaseBash();
		await Promise.all([idle, bash, first, second]);
		expect(schedules).toBeLessThan(200);
		expect(getAssistantTexts(harness)).toEqual(["first done", "second done"]);
	} finally {
		session._scheduleSessionInputPump = schedule;
		releaseBash();
		await bash;
		harness.cleanup();
	}
});
