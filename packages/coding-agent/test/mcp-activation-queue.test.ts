import { beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentConnectionSessionEvent } from "../src/modes/agent-connection/index.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type ActivationQueueThis = {
	connectionState: { isStreaming: boolean; isCompacting: boolean; messageCount: number };
	pendingPostRunActivation: { message: string; successMessage: string } | undefined;
	pulseTimer: ReturnType<typeof setInterval> | undefined;
	ui: { requestRender: ReturnType<typeof vi.fn> };
	showStatus: ReturnType<typeof vi.fn>;
	showWarning: ReturnType<typeof vi.fn>;
	handleReloadCommand: ReturnType<typeof vi.fn>;
};

function createFakeMode(): ActivationQueueThis {
	const fake: ActivationQueueThis = {
		connectionState: { isStreaming: false, isCompacting: false, messageCount: 0 },
		pendingPostRunActivation: undefined,
		pulseTimer: undefined,
		ui: { requestRender: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		handleReloadCommand: vi.fn(async () => true),
	};
	Object.setPrototypeOf(fake, InteractiveMode.prototype);
	return fake;
}

function callPrivate<TThis extends object, TResult>(name: string, self: TThis, ...args: unknown[]): TResult {
	const method = (InteractiveMode.prototype as unknown as Record<string, (...args: unknown[]) => TResult>)[name];
	return method.apply(self, args);
}

async function flushAsync(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ENG-6108 MCP activation queue at safe boundaries", () => {
	let mode: ActivationQueueThis;

	beforeEach(() => {
		mode = createFakeMode();
	});

	test("queues a login made mid-stream and activates automatically at agent end — never says /reload", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");

		// Deferred: no reload yet, and the message must not tell the user to run /reload.
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();
		expect(mode.showStatus).toHaveBeenCalledWith(
			"Connected Notion. It will activate automatically when the current turn finishes.",
		);
		expect(JSON.stringify(mode.showStatus.mock.calls)).not.toContain("/reload");

		// The turn (including any in-flight tool call) ends: activation runs.
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(mode.showStatus).toHaveBeenCalledWith("Connected Notion.");
		expect(mode.pendingPostRunActivation).toBeUndefined();
	});

	test("activates at the compaction boundary when queued during compaction", async () => {
		mode.connectionState.isCompacting = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Linear.", "Connected Linear.");
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();

		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	test("waits for both streaming and compaction to finish before activating", async () => {
		mode.connectionState.isStreaming = true;
		mode.connectionState.isCompacting = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");

		// Streaming ends but compaction still holds the boundary.
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).not.toHaveBeenCalled();

		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});

	test("keeps the change queued when the boundary reload fails, with an honest warning", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");
		mode.handleReloadCommand.mockResolvedValue(false);

		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
		expect(mode.showWarning).toHaveBeenCalledWith(
			"Connected Notion. The change remains saved, but it is not active in this session.",
		);
	});

	test("a queued activation runs once even if both boundaries fire", async () => {
		mode.connectionState.isStreaming = true;
		await callPrivate("reloadAfterMcpChange", mode, "Connected Notion.");
		callPrivate("updateConnectionStateFromEvent", mode, { type: "agent_end" } as AgentConnectionSessionEvent);
		await flushAsync();
		callPrivate("updateConnectionStateFromEvent", mode, {
			type: "compaction_end",
		} as AgentConnectionSessionEvent);
		await flushAsync();
		expect(mode.handleReloadCommand).toHaveBeenCalledTimes(1);
	});
});
