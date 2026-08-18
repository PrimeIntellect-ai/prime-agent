import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.js";

describe("ENG-4653 queued messages after agent end", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function waitForDelivery(harness: Harness, expectedCalls: number): Promise<void> {
		await vi.waitFor(() => expect(harness.faux.state.callCount).toBe(expectedCalls));
		await harness.session.agent.waitForIdle();
		await vi.waitFor(() => expect(harness.session.queuedActionCount).toBe(0));
	}

	it("starts a new turn for steering queued from agent_end", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first turn complete"), fauxAssistantMessage("steering handled")]);

		let queued = false;
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			await harness.session.steer("stop heartbeat", undefined, { resumeIfIdle: true });
		});

		await harness.session.prompt("start");
		await waitForDelivery(harness, 2);
		unsubscribe();

		expect(getUserTexts(harness)).toEqual(["start", "stop heartbeat"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});

	it("starts a turn for an explicit steering message accepted while idle", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("idle steering handled")]);

		await harness.session.steer("recover stale routing", undefined, { resumeIfIdle: true });
		await waitForDelivery(harness, 1);

		expect(getUserTexts(harness)).toEqual(["recover stale routing"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
	});

	it("starts a new turn for a follow-up queued from agent_end", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first turn complete"), fauxAssistantMessage("follow-up handled")]);

		let queued = false;
		const unsubscribe = harness.session.agent.subscribe(async (event) => {
			if (event.type !== "agent_end" || queued) return;
			queued = true;
			await harness.session.followUp("continue after end", undefined, { resumeIfIdle: true });
		});

		await harness.session.prompt("start");
		await waitForDelivery(harness, 2);
		unsubscribe();

		expect(getUserTexts(harness)).toEqual(["start", "continue after end"]);
		expect(harness.eventsOfType("agent_start")).toHaveLength(2);
		expect(harness.eventsOfType("agent_end")).toHaveLength(2);
	});
});
