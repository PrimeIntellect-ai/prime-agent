import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { Harness } from "./harness.js";
import { createWaitingHarness } from "./scheduling.js";

// Discussion #1476: a steering message queued mid-turn survives an abort, but the
// abort suspends the input pump, so the queue stays parked while the session sits
// idle. resumeQueuedWork() is the primitive the TUI offers on empty-editor Enter.
describe("aborted turn parks the steering queue", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it("preserves the queued steering message and drains it on resumeQueuedWork", { timeout: 20000 }, async () => {
		const { harness, releaseToolExecution, promptPromise, waitForToolStart } = await createWaitingHarness();
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("turn done"),
			fauxAssistantMessage("steered answer"),
		]);
		await waitForToolStart;
		await harness.session.steer("actually do this instead");
		expect(harness.session.queuedActionCount).toBe(1);

		const abort = harness.session.abort();
		releaseToolExecution();
		await abort;
		await promptPromise.catch(() => {});

		// The abort keeps the message but suspends draining: parked, not delivered.
		expect(harness.session.queuedActionCount).toBe(1);
		expect(harness.session.isQueuedWorkSuspended).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(harness.session.queuedActionCount).toBe(1);

		expect(harness.session.resumeQueuedWork()).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 200));
		await harness.session.waitForIdle();
		expect(harness.session.queuedActionCount).toBe(0);
		expect(harness.session.isQueuedWorkSuspended).toBe(false);
	});
});
