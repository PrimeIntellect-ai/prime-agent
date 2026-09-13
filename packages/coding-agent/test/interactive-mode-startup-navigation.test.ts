import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("back navigation during chat startup", () => {
	it.each(["catalog", "snapshot"])("keeps the connection alive while loading the %s", async (phase) => {
		let resume!: () => void;
		const pending = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let loading!: () => void;
		const started = new Promise<void>((resolve) => {
			loading = resolve;
		});
		let connected = true;
		const state = { sessionId: "session", cwd: "/tmp/project", compactionCount: 0 };
		const dispose = vi.fn(async () => {
			connected = false;
		});
		const getInitialSnapshot = vi.fn(async () => {
			if (phase === "snapshot") {
				loading();
				await pending;
			}
			if (!connected) throw new Error("Cannot send get_connection_state: daemon is not connected");
			return { state, messages: [] };
		});
		const mode = {
			options: { returnToAgentsView: true, agentsViewOwnsStartupNotices: true },
			init: async () => {
				if (phase === "catalog") {
					loading();
					await pending;
				}
				await InteractiveMode.prototype.renderInitialMessages.call(mode as never);
			},
			agentConnection: { getInitialSnapshot, dispose },
			connectionState: state,
			editor: { getText: () => "" },
			getSessionContextFromConnectionSnapshot: () => ({ messages: [] }),
			seedSubagentSummary: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showLoadedResources: vi.fn(),
			restorePromptStashOnOpen: vi.fn(),
			modelRegistry: { getError: () => undefined },
			runStartupOnboarding: vi.fn(async () => false),
			getModelFallbackWarningAction: () => "suppress",
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			getCurrentCwd: () => state.cwd,
			stashDraftForAgentsView: vi.fn(),
			unregisterSignalHandlers: vi.fn(),
			teardownSessionUi: vi.fn(async () => {}),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const run = InteractiveMode.prototype.run.call(mode as never);
		// Observe the rejection immediately so the unfixed race is an assertion failure.
		const result = run.then(
			(value) => value,
			(error: unknown) => error,
		);
		await started;
		const navigate = Reflect.get(InteractiveMode.prototype, "returnToAgentsView");
		const handoff = navigate.call(mode);
		const repeatedHandoff = navigate.call(mode);
		await Promise.resolve();
		await Promise.resolve();
		const disposedDuringStartup = dispose.mock.calls.length;
		resume();
		await Promise.all([handoff, repeatedHandoff]);

		expect(await result).toMatchObject({
			type: "agents_view",
			source: { sessionId: state.sessionId, cwd: state.cwd },
		});
		expect(disposedDuringStartup).toBe(0);
		expect(getInitialSnapshot).toHaveBeenCalledOnce();
		expect(dispose).toHaveBeenCalledOnce();
		expect(mode.teardownSessionUi).toHaveBeenCalledOnce();
	});
});
