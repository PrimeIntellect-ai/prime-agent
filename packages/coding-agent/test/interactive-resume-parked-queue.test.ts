import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type FakeMode = {
	connectionState: { isStreaming: boolean; sessionActions: { queuedCount: number } } | undefined;
	agentConnection: { resumeQueuedWork: ReturnType<typeof vi.fn> };
	showError: ReturnType<typeof vi.fn>;
};

const proto = InteractiveMode.prototype as unknown as {
	resumeParkedQueueIfIdle(this: FakeMode): Promise<boolean>;
	isAgentStreaming(this: FakeMode): boolean;
	getQueuedActionCount(this: FakeMode): number;
};

function fakeMode(state: { isStreaming: boolean; queuedCount: number } | undefined): FakeMode {
	return {
		connectionState: state
			? { isStreaming: state.isStreaming, sessionActions: { queuedCount: state.queuedCount } }
			: undefined,
		agentConnection: { resumeQueuedWork: vi.fn(async () => true) },
		showError: vi.fn(),
		isAgentStreaming: proto.isAgentStreaming,
		getQueuedActionCount: proto.getQueuedActionCount,
	} as unknown as FakeMode;
}

describe("resumeParkedQueueIfIdle", () => {
	it("resumes the parked queue when idle with queued messages", async () => {
		const mode = fakeMode({ isStreaming: false, queuedCount: 1 });
		await expect(proto.resumeParkedQueueIfIdle.call(mode)).resolves.toBe(true);
		expect(mode.agentConnection.resumeQueuedWork).toHaveBeenCalledOnce();
	});

	it("does nothing while streaming", async () => {
		const mode = fakeMode({ isStreaming: true, queuedCount: 1 });
		await expect(proto.resumeParkedQueueIfIdle.call(mode)).resolves.toBe(false);
		expect(mode.agentConnection.resumeQueuedWork).not.toHaveBeenCalled();
	});

	it("does nothing when the queue is empty", async () => {
		const mode = fakeMode({ isStreaming: false, queuedCount: 0 });
		await expect(proto.resumeParkedQueueIfIdle.call(mode)).resolves.toBe(false);
		expect(mode.agentConnection.resumeQueuedWork).not.toHaveBeenCalled();
	});

	it("surfaces resume errors instead of throwing", async () => {
		const mode = fakeMode({ isStreaming: false, queuedCount: 2 });
		mode.agentConnection.resumeQueuedWork = vi.fn(async () => {
			throw new Error("boom");
		});
		await expect(proto.resumeParkedQueueIfIdle.call(mode)).resolves.toBe(false);
		expect(mode.showError).toHaveBeenCalledWith("boom");
	});
});
