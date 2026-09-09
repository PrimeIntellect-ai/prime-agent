import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentDir } from "../src/config.js";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { observeInstalledRuntimeReady } from "../src/core/telemetry-installation.js";
import { AgentsViewMode, type AgentsViewRunResult } from "../src/modes/agents-view/agents-view-mode.js";

vi.mock("../src/core/telemetry-installation.js", () => ({
	observeInstalledRuntimeReady: vi.fn(async () => undefined),
}));

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve: (value: T) => resolve(value) };
}

function createView(config: AgentSessionRuntimeConfig = {}) {
	const attached = deferred<boolean>();
	const client = { isConnected: true, onMessage: vi.fn(() => () => {}) };
	const roster = {
		attach: vi.fn(() => attached.promise),
		onUpdate: vi.fn(() => () => {}),
		summaries: vi.fn(() => []),
	};
	const settingsManager = SettingsManager.inMemory({ telemetry: { enabled: true } });
	const self = {
		options: {
			config,
			uiServices: { settingsManager, getInitialCwd: () => "/synthetic/initial-cwd" },
		},
		persistentState: { rosterClient: client, rosterStore: roster },
		ui: {
			addChild: vi.fn(),
			setFocus: vi.fn(),
			start: vi.fn(),
			enterFullscreen: vi.fn(),
			requestRender: vi.fn(),
		},
		fullscreenDock: {},
		resolveRun: undefined as ((result: AgentsViewRunResult) => void) | undefined,
		heartbeatPollTimer: undefined as NodeJS.Timeout | undefined,
		animationTimer: undefined as NodeJS.Timeout | undefined,
		subscribeToClientClose: vi.fn(),
		applySessionList: vi.fn(),
		armSavedSearchFetch: vi.fn(),
		resolveMissingSelectionAnchor: vi.fn(),
		refreshHeartbeats: vi.fn(async () => true),
		loadStartupNotices: vi.fn(),
	};
	return {
		self,
		attached,
		settingsManager,
		run: () => AgentsViewMode.prototype.run.call(self as unknown as AgentsViewMode),
		dispose: () => {
			clearInterval(self.heartbeatPollTimer);
			clearInterval(self.animationTimer);
		},
	};
}

describe("agents-view installation readiness", () => {
	const views: ReturnType<typeof createView>[] = [];
	beforeEach(() => vi.mocked(observeInstalledRuntimeReady).mockReset().mockResolvedValue(undefined));
	afterEach(() => {
		for (const view of views.splice(0)) view.dispose();
	});

	it("observes readiness only after roster attachment and UI setup, then waits for delivery on exit", async () => {
		const delivery = deferred<void>();
		vi.mocked(observeInstalledRuntimeReady).mockImplementation(() => delivery.promise);
		const view = createView({ agentDir: "/synthetic/agent", cwd: "/synthetic/current-cwd" });
		views.push(view);
		const run = view.run();
		expect(observeInstalledRuntimeReady).not.toHaveBeenCalled();
		expect(view.self.ui.start).not.toHaveBeenCalled();

		view.attached.resolve(true);
		await vi.waitFor(() => expect(observeInstalledRuntimeReady).toHaveBeenCalledOnce());
		expect(view.self.ui.start).toHaveBeenCalledOnce();
		expect(view.self.ui.enterFullscreen).toHaveBeenCalledOnce();
		expect(view.self.applySessionList).toHaveBeenCalledWith([], true);
		expect(view.self.applySessionList.mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(observeInstalledRuntimeReady).mock.invocationCallOrder[0]!,
		);
		expect(observeInstalledRuntimeReady).toHaveBeenCalledWith({
			agentDir: "/synthetic/agent",
			cwd: "/synthetic/current-cwd",
			settingsManager: view.settingsManager,
			telemetryDisabled: undefined,
			readyKind: "interactive",
			executionMode: "interactive",
		});

		const completed = vi.fn();
		void run.then(completed);
		view.self.resolveRun?.({ type: "exit" });
		await Promise.resolve();
		await Promise.resolve();
		expect(completed).not.toHaveBeenCalled();
		delivery.resolve();
		await expect(run).resolves.toEqual({ type: "exit" });
	});

	it("does not claim readiness when roster attachment fails", async () => {
		const view = createView();
		views.push(view);
		const run = view.run();
		view.attached.resolve(false);
		await expect(run).rejects.toThrow();
		expect(observeInstalledRuntimeReady).not.toHaveBeenCalled();
		expect(view.self.ui.start).not.toHaveBeenCalled();
	});

	it("passes the runtime opt-out and fallback directories to the readiness consent check", async () => {
		const view = createView({ telemetryDisabled: true });
		views.push(view);
		const run = view.run();
		view.attached.resolve(true);
		await vi.waitFor(() => expect(observeInstalledRuntimeReady).toHaveBeenCalledOnce());
		expect(observeInstalledRuntimeReady).toHaveBeenCalledWith({
			agentDir: getAgentDir(),
			cwd: "/synthetic/initial-cwd",
			settingsManager: view.settingsManager,
			telemetryDisabled: true,
			readyKind: "interactive",
			executionMode: "interactive",
		});
		view.self.resolveRun?.({ type: "exit" });
		await expect(run).resolves.toEqual({ type: "exit" });
	});
});
