import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

/**
 * Mid-run agent-to-agent delivery is opt-in and bounded.
 *
 * Steering keeps the recipient's loop alive (the agent loop drains it and declines to stop),
 * so two agents can hold each other running indefinitely. These bounds are what make it safe:
 * off by default, no duplicate content, and a cap on back-to-back messages from one sender.
 */
interface SteerInternals {
	steerAgentMessage(prompt: string, message: unknown): boolean;
	isStreaming: boolean;
}

function agentMessage(from: string, content: string): unknown {
	return { content, details: { id: `${from}-${content}`, from: { sessionId: from } } };
}

describe("mid-run agent message delivery", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("declines when the setting is off, so behaviour is unchanged by default", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const session = harness.session as unknown as SteerInternals;
		expect(session.steerAgentMessage("hello", agentMessage("peer-1", "hello"))).toBe(false);
	});

	it("declines when the recipient is not mid-run, leaving the ordinary queue to deliver", async () => {
		const harness = await createHarness({ settings: { agentMessageMidRunDelivery: true } });
		harnesses.push(harness);
		const session = harness.session as unknown as SteerInternals;
		expect(session.isStreaming).toBe(false);
		expect(session.steerAgentMessage("hello", agentMessage("peer-1", "hello"))).toBe(false);
	});
});
