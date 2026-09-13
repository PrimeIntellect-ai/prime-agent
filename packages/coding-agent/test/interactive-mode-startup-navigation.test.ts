import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("back navigation during chat startup", () => {
	it("finishes binding the chat without waiting for optional heartbeat metadata", async () => {
		let resolveHeartbeats!: (heartbeats: []) => void;
		const heartbeats = new Promise<[]>((resolve) => {
			resolveHeartbeats = resolve;
		});
		const mode = {
			uiServices: { getThemes: () => [] },
			toolDefinitionCache: new Map(),
			agentConnection: {
				getState: async () => ({ sessionActions: {} }),
				listHeartbeats: vi.fn(() => heartbeats),
			},
			applyRuntimeSettings: vi.fn(),
			refreshConnectionCatalog: vi.fn(async () => {}),
			setupAutocompleteProvider: vi.fn(),
			subscribeToAgent: vi.fn(),
			subscribeToRosterBar: vi.fn(async () => {}),
			patchConnectionState: vi.fn(),
			refreshQueueSelectionFromState: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			updateAvailableProviderCount: vi.fn(async () => {}),
			updateEditorBorderColor: vi.fn(),
			updateTerminalTitle: vi.fn(),
			setGoalAnnouncementBaseline: vi.fn(),
			getGoalState: vi.fn(),
			syncGoalTray: vi.fn(),
			syncWorkingLoader: vi.fn(),
			applyHeartbeatCatalog: vi.fn(),
			isShuttingDown: false,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const binding = Reflect.get(InteractiveMode.prototype, "rebindCurrentSession").call(mode);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const outcome = await Promise.race([
				binding.then(() => "bound"),
				new Promise<string>((resolve) => {
					timer = setTimeout(() => resolve("blocked"), 1000);
				}),
			]);
			expect(outcome).toBe("bound");
			expect(mode.agentConnection.listHeartbeats).toHaveBeenCalledOnce();
			mode.isShuttingDown = true;
			resolveHeartbeats([]);
			await Reflect.get(mode, "heartbeatRefreshPromise");
			expect(mode.applyHeartbeatCatalog).not.toHaveBeenCalled();
		} finally {
			clearTimeout(timer);
			resolveHeartbeats([]);
			await binding;
		}
	});

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
			runStartupOnboarding: vi.fn(() => new Promise<boolean>(() => {})),
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
		expect(mode.runStartupOnboarding).not.toHaveBeenCalled();
	});
});
