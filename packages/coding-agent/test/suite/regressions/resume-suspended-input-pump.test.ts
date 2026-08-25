import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.js";

describe("suspended input pump resumes on programmatic admission", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("delivers a queued agent message at idle after an abort suspended the pump", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("agent mail handled")]);

		// An abort at idle leaves the input pump suspended.
		harness.session.requestAbort();
		await harness.session.agent.waitForIdle();

		await harness.session.queueAgentMessagePrompt("queued agent mail", "followUp");

		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("agent mail handled"));
		expect(getUserTexts(harness)).toContain("queued agent mail");
	});

	it("delivers items queued before an abort once a later programmatic admission arrives", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("backlog handled"), fauxAssistantMessage("second handled")]);

		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.queueAgentMessagePrompt("queued before abort", "followUp");
		harness.session.requestAbort();
		pause.release();
		await harness.session.agent.waitForIdle();

		// Without the fix, the backlog starves forever: only a user-typed prompt or
		// resumeQueuedWork() revives delivery.
		await harness.session.queueAgentMessagePrompt("queued after abort", "followUp");

		await vi.waitFor(() => {
			const users = getUserTexts(harness);
			expect(users).toContain("queued before abort");
			expect(users).toContain("queued after abort");
		});
	});

	it("resumes the pump when a coalesced follow-up re-fires at idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("wake handled")]);

		const pause = harness.session.acquireQueuedWorkPause();
		await harness.session.followUp("wake fire", undefined, { queueKey: "wake:test" });
		harness.session.requestAbort();
		pause.release();
		await harness.session.agent.waitForIdle();

		// A re-fire with the same queueKey coalesces into the queued owner. Without the
		// fix it is dropped without resuming the pump, so the owner starves forever.
		await harness.session.followUp("wake fire", undefined, { queueKey: "wake:test" });

		await vi.waitFor(() => expect(getUserTexts(harness)).toContain("wake fire"));
		expect(getAssistantTexts(harness)).toContain("wake handled");
	});

	it("does not resume a pump suspended for an update restart", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("should not run during restart hold")]);

		// A restart hold must survive into the restart manifest: it is a different
		// suspension reason than an ordinary abort and must not be auto-resumed by
		// programmatic admission.
		harness.session.abortForUpdateRestart();
		await harness.session.agent.waitForIdle();

		await harness.session.queueAgentMessagePrompt("queued during restart hold", "followUp");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(getAssistantTexts(harness)).not.toContain("should not run during restart hold");

		harness.session.resumeQueuedWork();
		await vi.waitFor(() => expect(getAssistantTexts(harness)).toContain("should not run during restart hold"));
	});
});
