import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.js";
import { createDeferred } from "../scheduling.js";

describe("session input and turn ownership", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("resolves public admission wrappers installed after construction and waits for completion", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const started = createDeferred();
		const response = createDeferred();
		harness.setResponses([
			async () => {
				started.resolve();
				await response.promise;
				return fauxAssistantMessage("complete");
			},
		]);
		const admit = vi.spyOn(harness.session, "promptUntilAccepted");
		let completed = false;
		const prompt = harness.session.promptAndWait("work", { agentMessageId: "correlation" }).then(() => {
			completed = true;
		});
		await started.promise;
		expect(admit).toHaveBeenCalledWith("work", { agentMessageId: "correlation" });
		expect(completed).toBe(false);
		response.resolve();
		await prompt;
		expect(completed).toBe(true);
	});

	it("keeps correlation waiters isolated across sessions and rejects only disposed work", async () => {
		const first = await createHarness();
		const second = await createHarness();
		harnesses.push(first, second);
		const firstDelivery = first.session.waitForAgentMessagePromptDelivery("same-id");
		const secondDelivery = second.session.waitForAgentMessagePromptDelivery("same-id");
		const firstRejected = expect(firstDelivery).rejects.toThrow("disposed");
		first.session.dispose();
		await firstRejected;
		second.setResponses([fauxAssistantMessage("received")]);
		await second.session.promptAndWait("second session", { agentMessageId: "same-id" });
		await expect(secondDelivery).resolves.toBeUndefined();
		expect(getUserTexts(first)).toEqual([]);
		expect(getUserTexts(second)).toEqual(["second session"]);
	});
});
