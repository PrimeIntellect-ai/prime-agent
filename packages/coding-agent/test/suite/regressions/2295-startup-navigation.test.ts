import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.js";
import * as shell from "../../../src/utils/shell.js";
import { createHarness, type Harness } from "../harness.js";

describe("back navigation during chat startup", () => {
	let harness: Harness;
	beforeEach(async () => {
		harness = await createHarness();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		harness.cleanup();
	});

	it("finishes binding the chat without waiting for optional heartbeat metadata", async () => {
		let resolveHeartbeats!: (heartbeats: []) => void;
		const heartbeats = new Promise<[]>((resolve) => {
			resolveHeartbeats = resolve;
		});
		const mode = {
			uiServices: { getThemes: () => [] },
			toolDefinitionCache: new Map(),
			agentConnection: {
				getState: async () => ({ sessionActions: harness.session.getSessionActionSnapshot() }),
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
		const state = {
			sessionId: harness.session.sessionId,
			cwd: harness.tempDir,
			compactionCount: 0,
			model: harness.getModel(),
		};
		const dispose = vi.fn(async () => {
			connected = false;
		});
		const getInitialSnapshot = vi.fn(async () => {
			if (phase === "snapshot") {
				loading();
				await pending;
			}
			if (!connected) throw new Error("Cannot send get_connection_state: daemon is not connected");
			return { state, messages: harness.session.messages };
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
			getSessionContextFromConnectionSnapshot: () => harness.session.buildSessionContext(),
			seedSubagentSummary: vi.fn(),
			applyConnectionStateSnapshot: vi.fn(),
			restoreTurnStartFromMessages: vi.fn(),
			renderSessionContext: vi.fn(async () => {}),
			restoreStreamingMessageFromSnapshot: vi.fn(async () => {}),
			showLoadedResources: vi.fn(),
			restorePromptStashOnOpen: vi.fn(),
			modelRegistry: harness.session.modelRegistry,
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

	it.each(["shutdown", "SIGTERM"])("allows %s to interrupt Back while startup is stalled", async (action) => {
		let resume!: () => void;
		const initializationPromise = new Promise<void>((resolve) => {
			resume = resolve;
		});
		const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(shell, "killTrackedDetachedChildren").mockImplementation(() => {});
		const mode = {
			initializationPromise,
			isShuttingDown: false,
			signalCleanupHandlers: [] as Array<() => void>,
			agentConnection: {
				getSessionStats: vi.fn(async () => harness.session.getSessionStats()),
				dispose: vi.fn(async () => {}),
			},
			ui: { terminal: { drainInput: vi.fn(async () => {}) } },
			options: { onShutdown: vi.fn(async () => {}) },
			clearCtrlCExitHint: vi.fn(),
			stop: vi.fn(),
			stashDraftForAgentsView: vi.fn(),
			teardownSessionUi: vi.fn(async () => {}),
			onInputCallback: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		Reflect.get(mode, "registerSignalHandlers").call(mode);
		const terminate = process.listeners("SIGTERM")[0]!;
		const handoff = Reflect.get(mode, "returnToAgentsView").call(mode);
		try {
			if (action === "SIGTERM") terminate("SIGTERM");
			else await Reflect.get(mode, "shutdown").call(mode);
			await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
			expect(mode.agentConnection.dispose).toHaveBeenCalledOnce();
			expect(mode.options.onShutdown).toHaveBeenCalledOnce();
		} finally {
			resume();
			await handoff;
			Reflect.get(mode, "unregisterSignalHandlers").call(mode);
		}
		expect(mode.agentConnection.dispose).toHaveBeenCalledOnce();
		expect(mode.teardownSessionUi).not.toHaveBeenCalled();
		expect(mode.onInputCallback).not.toHaveBeenCalled();
	});
});
