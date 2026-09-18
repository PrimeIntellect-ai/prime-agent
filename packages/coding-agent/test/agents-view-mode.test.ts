import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { DaemonAgentConnection } from "../src/modes/agent-connection/daemon-agent-connection.js";
import type { AgentConnectionSavedSessionInfo } from "../src/modes/agent-connection/types.js";
import {
	AgentsViewMode,
	type AgentsViewPersistentState,
	createInitialAgentsViewPersistentState,
	runAgentsViewMode,
	waitThroughDaemonUpdateRestart,
} from "../src/modes/agents-view/agents-view-mode.js";
import * as agentsViewState from "../src/modes/agents-view/agents-view-state.js";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	resolveAgentsViewLeftResult,
	type UnifiedSessionRecord,
} from "../src/modes/agents-view/agents-view-state.js";
import { DaemonSessionRecoveringError, DaemonUpdateRestartingError } from "../src/modes/daemon/daemon-errors.js";
import { DaemonControlPlaneTransportError } from "../src/modes/daemon/daemon-routed-client.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import * as savedSessionCatalog from "../src/modes/daemon/saved-session-catalog.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { initTheme, stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";
import { WORKING_ICON_INTERVAL_MS } from "../src/modes/interactive/theme/working-icon.js";

const modeMocks = vi.hoisted(() => ({
	interactiveRun: vi.fn<() => Promise<never>>(),
	teardownSessionUi: vi.fn(async () => undefined),
	dispose: vi.fn(async () => undefined),
	connectionPrompt: vi.fn(async () => undefined),
	clientRequest: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../src/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/config.js")>();
	return { ...actual, appendRotatingLog: vi.fn() };
});

vi.mock("../src/modes/daemon/daemon-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/daemon/daemon-client.js")>();
	return {
		...actual,
		DaemonClient: class {
			connect = vi.fn(async () => undefined);
			close = vi.fn();
			request = modeMocks.clientRequest;
		},
	};
});

vi.mock("../src/modes/agent-connection/daemon-agent-connection.js", () => ({
	DaemonAgentConnection: Object.assign(function DaemonAgentConnection() {}, {
		attach: vi.fn(async () => ({ prompt: modeMocks.connectionPrompt, dispose: modeMocks.dispose })),
	}),
}));

vi.mock("../src/modes/interactive/interactive-mode.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/interactive-mode.js")>();
	return {
		...actual,
		InteractiveMode: class {
			run = modeMocks.interactiveRun;
			teardownSessionUi = modeMocks.teardownSessionUi;
		},
	};
});

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		id: "scope-active",
		activeSessionId: "scope-active",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "scope-session",
		sessionFile: "/tmp/scope.jsonl",
		cwd: "/tmp",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function invoke(method: string, self: object, ...args: unknown[]): unknown {
	const member = Reflect.get(AgentsViewMode.prototype, method) as ((...a: unknown[]) => unknown) | undefined;
	if (typeof member !== "function") throw new Error(`AgentsViewMode.${method} no longer exists`);
	return member.call(self, ...args);
}

function savedSession(id: string): AgentConnectionSavedSessionInfo {
	return {
		id,
		path: `/tmp/${id}.jsonl`,
		cwd: "/tmp",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: id,
		allMessagesText: id,
	};
}

function deferredSavedCatalog() {
	let resolve!: (sessions: AgentConnectionSavedSessionInfo[]) => void;
	let reject!: (error: Error) => void;
	let onSession: ((session: AgentConnectionSavedSessionInfo) => void) | undefined;
	const promise = new Promise<AgentConnectionSavedSessionInfo[]>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	vi.spyOn(savedSessionCatalog, "listDaemonSavedSessions").mockImplementationOnce(
		async (_client, _context, _scope, callbacks) => {
			onSession = callbacks?.onSession;
			return promise;
		},
	);
	return {
		resolve,
		reject,
		emit(session: AgentConnectionSavedSessionInfo): void {
			if (!onSession) throw new Error("Saved catalog refresh has not started");
			onSession(session);
		},
	};
}

function catalogHarness(saved: AgentConnectionSavedSessionInfo[] = [], live: SessionSummary[] = []) {
	const persistentState: AgentsViewPersistentState = {
		savedSessions: saved,
		lastSuccessfulSavedSessions: saved,
		savedCatalogLoaded: true,
	};
	const self = {
		persistentState,
		lastListedSummaries: live,
		savedSessions: saved,
		lastSuccessfulSavedSessions: saved,
		heartbeats: [],
		rows: [] as AgentsViewRow[],
		selectedIndex: 0,
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		savedCatalogReady: true,
		savedCatalogRefreshPending: false,
		savedCatalogReconcileTimer: undefined as ReturnType<typeof setTimeout> | undefined,
		stopped: false,
		inactiveAgentIdentities: new Set<string>(),
		expandedSubagentParents: new Set<string>(),
		programShownParents: new Set<string>(),
		editor: { getText: vi.fn(() => "") },
		ui: { requestRender: vi.fn(), stop: vi.fn() },
		requireClient: () => ({}),
		getSavedSessionCatalogContext: () => ({ cwd: "/tmp" }),
		withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		getFilteredRecords(): UnifiedSessionRecord[] {
			return invoke("getFilteredRecords", self) as UnifiedSessionRecord[];
		},
		reconcileCatalogs: vi.fn((): void => {
			invoke("reconcileCatalogs", self);
		}),
		rebuildRows: vi.fn((): void => {
			invoke("rebuildRows", self);
		}),
		rearmSavedSearchFetch(): void {
			invoke("rearmSavedSearchFetch", self);
		},
		armSavedSearchFetch: vi.fn(),
		applyPendingAncestorExpansion: vi.fn(),
		restoreSelection: vi.fn(),
		syncSelectedRowState: vi.fn(),
		resolveMissingSelectionAnchor: vi.fn(),
		clearCtrlCExitHint: vi.fn(),
		clearDeleteConfirmation: vi.fn(),
		setStatusMessage: vi.fn(),
	};
	return self;
}

const settingsManager = {
	getTheme: () => "dark",
	getShowHardwareCursor: () => false,
	getClearOnShrink: () => false,
	getEditorPaddingX: () => 0,
	getAutocompleteMaxVisible: () => 5,
};

describe("AgentsViewMode", () => {
	beforeAll(() => setKeybindings(new KeybindingsManager()));
	beforeEach(() => vi.clearAllMocks());

	it("keeps the queried selection when a remembered session arrives later", () => {
		const remembered = summary({
			id: "remembered",
			activeSessionId: "remembered",
			sessionId: "remembered-session",
			sessionFile: "/tmp/remembered.jsonl",
			sessionName: "match remembered",
		});
		const fallback = summary({ sessionName: "match fallback" });
		const persistentState = createInitialAgentsViewPersistentState({ initialSession: remembered });
		persistentState.savedCatalogLoaded = true;
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		try {
			Reflect.set(view, "lastListedSummaries", [fallback]);
			invoke("reconcileCatalogs", view);
			expect(Reflect.get(view, "selectionAnchorPending")).toBe(true);

			invoke("setSearchQuery", view, "match");
			expect(Reflect.get(view, "selectionAnchorPending")).toBe(false);
			expect(persistentState.selectedSessionKey?.sessionId).toBe(fallback.sessionId);

			Reflect.set(view, "lastListedSummaries", [remembered, fallback]);
			invoke("reconcileCatalogs", view);
			const rows = Reflect.get(view, "rows") as AgentsViewRow[];
			expect(rows[Reflect.get(view, "selectedIndex") as number]?.summary.sessionId).toBe(fallback.sessionId);
		} finally {
			stopThemeWatcher();
		}
	});

	it("loads the saved catalog on view entry without a search query", () => {
		const self = {
			savedSearchFetchStarted: false,
			persistentState: {},
			refreshSavedSessions: vi.fn(async () => true),
		};

		invoke("armSavedSearchFetch", self);

		expect(self.refreshSavedSessions).toHaveBeenCalledOnce();
		expect(self.savedSearchFetchStarted).toBe(true);
	});
	// [name, row state, daemon delete capability, cancel result, warning]
	// A subagent row is only ever stopped, never deleted, while its subtree still works.
	it.each([
		[
			"an idle row whose subtree still works",
			{ kind: "subagent", section: "idle", runningSubagentCount: 1, summary: summary({ id: "crew-parent" }) },
			true,
			true,
			undefined,
		],
		["a subagent that started running during confirmation", { section: "running" }, true, true, undefined],
		[
			"a daemon that cannot delete subagents",
			{ section: "inactive", runningSubagentCount: 0, summary: summary() },
			false,
			false,
			"The daemon cannot delete subagents; it was left unchanged",
		],
	] as const)("stops instead of deleting for %s", async (_name, row, supportsDelete, cancelled, warning) => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => supportsDelete }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};

		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			row,
		);

		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
		if (warning) {
			expect(self.setStatusMessage).toHaveBeenCalledWith(warning, { render: false, tone: "warning" });
		}
	});

	it("re-resolves subagent state before choosing stop or delete intent", async () => {
		const child = summary({
			id: "passive-child-session",
			activeSessionId: undefined,
			sessionId: "passive-child-session",
			runtimeKind: "subagent",
			rlmChildId: "passive-child",
		});
		const request = vi.fn(async (command: { type: string }) => ({
			success: true as const,
			data: command.type === "cancel_rlm_child" ? { cancelled: false } : { deleted: true },
		}));
		const client = { request, supportsServerCapability: vi.fn(() => true) };
		const self = {
			rows: [
				{
					kind: "subagent",
					section: "running",
					summary: child,
					selectable: true,
					identity: "child-row",
					parentIdentity: "root-row",
				},
				{
					kind: "agent",
					section: "idle",
					summary: summary({ id: "root-active", activeSessionId: "root-active", sessionId: "root-session" }),
					selectable: true,
					identity: "root-row",
				},
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			pendingKillSubagent: undefined,
			deleteConfirmExpiresAt: 0,
			deleteConfirmTimer: undefined,
			ui: { requestRender: vi.fn() },
			requireClient: () => client,
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			handleKillSubagentSelected(row: unknown) {
				return invoke("handleKillSubagentSelected", self, row);
			},
			findSubagentRootRow(row: unknown) {
				return invoke("findSubagentRootRow", self, row);
			},
			isDeleteConfirmationVisible() {
				return invoke("isDeleteConfirmationVisible", self);
			},
			showDeleteConfirmation() {
				return invoke("showDeleteConfirmation", self);
			},
			clearDeleteConfirmation(options: unknown) {
				return invoke("clearDeleteConfirmation", self, options);
			},
			killSubagent(pending: unknown, row: unknown) {
				return invoke("killSubagent", self, pending, row);
			},
		};

		await invoke("handleDeleteSelected", self);
		expect(request).not.toHaveBeenCalled();

		// The child finishes during confirmation. The second keypress must use the
		// current row state rather than the original running state.
		self.rows[0]!.section = "inactive";
		await invoke("handleDeleteSelected", self);
		expect(request).toHaveBeenCalledWith({
			type: "delete_rlm_subagent",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "cancel_rlm_child" }));
		expect(self.setStatusMessage).toHaveBeenCalledWith("Subagent deleted", { render: false });
	});

	it("uses the opened session as the crash-path back target", async () => {
		const opened = summary({ sessionName: "opened" });
		const previous = summary({ id: "previous", activeSessionId: "previous", sessionId: "previous" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockResolvedValueOnce({ type: "open", summary: opened })
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.backSession).toMatchObject({ sessionId: opened.sessionId });
				return Promise.resolve({ type: "exit" });
			});
		modeMocks.interactiveRun.mockRejectedValueOnce(new Error("post-attach crash"));

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp", telemetryDisabled: true } as never,
			initialSession: previous,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		expect(modeMocks.teardownSessionUi).toHaveBeenCalledWith({ preserveAltScreen: true });
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(
			expect.anything(),
			opened.activeSessionId,
			expect.objectContaining({ telemetryDisabled: true }),
		);
		runView.mockRestore();
	});

	// A frame change in either direction must invalidate the persisted scope root so the
	// next mount re-resolves it from the live catalog.
	it.each([
		["popping", "scope_back", 2, 1],
		["pushing", "open", 1, 2],
	] as const)(
		"invalidates the persisted scope root after %s a scope frame",
		async (_direction, resultType, initialFrames, expectedFrames) => {
			const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
			const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
			const frameOf = (session: SessionSummary) => ({
				scope: { sessionId: session.sessionId, activeSessionId: session.activeSessionId },
			});
			const stateOf = (view: AgentsViewMode) =>
				(view as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
			const runView = vi
				.spyOn(AgentsViewMode.prototype, "run")
				.mockImplementationOnce(function (this: AgentsViewMode) {
					const state = stateOf(this);
					state.scopeFrames = initialFrames === 2 ? [frameOf(parent), frameOf(child)] : [frameOf(parent)];
					state.scopeRootSummary = initialFrames === 2 ? child : parent;
					return Promise.resolve(
						resultType === "scope_back"
							? {
									type: "scope_back" as const,
									selection: child,
									expandedAncestorSessionIds: [],
									hasChildren: false,
								}
							: { type: "open" as const, summary: child },
					);
				})
				.mockImplementationOnce(function (this: AgentsViewMode) {
					const state = stateOf(this);
					expect(state.scopeFrames).toHaveLength(expectedFrames);
					expect(state.scopeRootSummary).toBeUndefined();
					return Promise.resolve({ type: "exit" as const });
				});
			if (resultType === "open") {
				modeMocks.interactiveRun.mockResolvedValueOnce({
					type: "scoped_agents_view",
					source: {
						activeSessionId: child.activeSessionId,
						sessionFile: child.sessionFile,
						sessionId: child.sessionId,
						sessionName: child.sessionName,
						cwd: child.cwd,
					},
				} as never);
			}

			await runAgentsViewMode({
				socketPath: "/tmp/fake-daemon.sock",
				config: { cwd: "/tmp" } as never,
				uiServices: createUiServices(),
			});

			runView.mockRestore();
		},
	);

	it("does not discard scope while the saved-session refresh is in flight", async () => {
		let finishRefresh: ((value: { success: true; data: { sessions: unknown[] } }) => void) | undefined;
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: { sessions: unknown[] } }>((resolve) => {
					finishRefresh = resolve;
				}),
		);
		const scopeSummary = summary();
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: scopeSummary.sessionId, activeSessionId: scopeSummary.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			options: { config: { cwd: "/tmp" } },
			persistentState,
			savedCatalogGeneration: 0,
			savedCatalogReady: true,
			savedCatalogRefreshPending: false,
			lastSuccessfulSavedSessions: [],
			savedSessions: [],
			requireClient: () => ({ request }),
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp" }),
			reconcileCatalogs: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
		};

		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
		expect(self.savedCatalogReady).toBe(false);

		Object.assign(self, {
			lastListedSummaries: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		});
		self.reconcileCatalogs = () => invoke("reconcileCatalogs", self);
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeFrames).toHaveLength(1);

		const saved: AgentConnectionSavedSessionInfo = {
			path: "/tmp/scope.jsonl",
			id: "scope-session",
			cwd: "/tmp",
			created: new Date("2026-01-01T00:00:00Z"),
			modified: new Date("2026-01-01T00:00:00Z"),
			messageCount: 1,
			firstMessage: "scope",
			allMessagesText: "scope",
		};
		finishRefresh?.({
			success: true,
			data: {
				sessions: [
					{
						...saved,
						created: saved.created.toISOString(),
						modified: saved.modified.toISOString(),
					},
				],
			},
		});
		await expect(refresh).resolves.toBe(true);
		expect(persistentState.scopeFrames).toHaveLength(1);
	});

	it("carries the resolved scope root across view remounts", () => {
		const root = summary({ sessionName: "Scoped root" });
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
		};
		const self: Record<string, unknown> = {
			persistentState,
			lastListedSummaries: [root],
			savedSessions: [],
			heartbeats: [],
			inactiveAgentIdentities: new Set(),
			pendingDeleteAgent: undefined,
			savedCatalogReady: true,
			scopeKey: persistentState.scopeFrames?.[0]?.scope,
			expandedSubagentParents: new Set(),
			programShownParents: new Set(),
			editor: { getText: () => "" },
			getFilteredRecords: () => Reflect.get(self, "scopedRecords"),
			applyPendingAncestorExpansion: vi.fn(),
			restoreSelection: vi.fn(),
			ui: { requestRender: vi.fn() },
			setStatusMessage: vi.fn(),
			withPendingDeleteSession: (sessions: SessionSummary[]) => sessions,
		};
		invoke("reconcileCatalogs", self);
		expect(persistentState.scopeRootSummary).toMatchObject({ sessionId: root.sessionId });

		const remount = new AgentsViewMode(
			{
				config: { cwd: "/tmp" } as never,
				uiServices: {
					settingsManager: settingsManager as never,
					modelRegistry: {} as never,
					getInitialCwd: () => "/tmp",
					getInitialSessionName: () => undefined,
					getThemes: () => [],
				},
			},
			persistentState,
		) as AgentsViewMode & Record<string, unknown>;
		const remountedRoot = Reflect.get(remount, "scopeRootSummary") as SessionSummary;
		expect(remountedRoot).toMatchObject({ sessionName: "Scoped root" });
		expect(resolveAgentsViewLeftResult(remountedRoot)).toMatchObject({
			type: "scope_back",
			selection: { sessionId: root.sessionId },
		});
	});

	it("restores expanded subagent lists across view remounts", () => {
		const persistentState: AgentsViewPersistentState = {};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		try {
			(Reflect.get(view, "expandedSubagentParents") as Set<string>).add("file:/tmp/root.jsonl");
			(Reflect.get(view, "programShownParents") as Set<string>).add("file:/tmp/root.jsonl");

			const remount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect((Reflect.get(remount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(
				true,
			);
			expect((Reflect.get(remount, "programShownParents") as Set<string>).has("file:/tmp/root.jsonl")).toBe(true);

			// A collapsed-back list persists that way too.
			(Reflect.get(remount, "expandedSubagentParents") as Set<string>).delete("file:/tmp/root.jsonl");
			const collapsedRemount = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
			expect(
				(Reflect.get(collapsedRemount, "expandedSubagentParents") as Set<string>).has("file:/tmp/root.jsonl"),
			).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});
});

function createUiServices(): InteractiveModeUiServices {
	return {
		settingsManager: SettingsManager.inMemory({ theme: "dark" }),
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => process.cwd(),
		getInitialSessionName: () => undefined,
		getThemes: () => [],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("AgentsViewMode persistent catalog state", () => {
	it("applies an initial handoff scope from the first pushed roster refresh", async () => {
		const root = summary();
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		const persistentState = createInitialAgentsViewPersistentState({
			initialScopeKey: scope,
			initialSession: root,
		});
		persistentState.lastSuccessfulSavedSessions = [];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "rosterStore", { summaries: () => [root] });
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("refreshSessions", view)).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: root }]);
			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([root]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("re-arms reconnect from the heartbeat poll over a dead socket and never overwrites a sticky notice", async () => {
		const harness = (isConnected: boolean, statusMessageSticky: boolean) => {
			const client = {
				isConnected,
				request: vi.fn(async () => {
					throw new Error("heartbeats unavailable");
				}),
			};
			return {
				client,
				heartbeatCatalogGeneration: 0,
				reconnectPromise: undefined,
				daemonShutdownReceived: false,
				statusMessageSticky,
				requireClient: () => client,
				startClientReconnect: vi.fn(),
				setStatusMessage: vi.fn(),
			};
		};

		const reconnecting = harness(false, false);
		await expect(invoke("refreshHeartbeats", reconnecting)).resolves.toBe(false);
		expect(reconnecting.startClientReconnect).toHaveBeenCalledWith(reconnecting.client, expect.any(Error));
		expect(reconnecting.setStatusMessage).not.toHaveBeenCalled();

		const sticky = harness(true, true);
		await expect(invoke("refreshHeartbeats", sticky)).resolves.toBe(false);
		expect(sticky.startClientReconnect).not.toHaveBeenCalled();
		expect(sticky.setStatusMessage).not.toHaveBeenCalled();
	});

	it("keeps a live-only scope after a fresh instance's first live poll fails", async () => {
		const root = summary({
			id: "root-active",
			activeSessionId: "root-active",
			isSessionActive: true,
			runtimeKind: "top-level",
			sessionId: "root-session",
			cwd: process.cwd(),
		});
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } }],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		Reflect.set(view, "client", {
			isConnected: true,
			request: vi.fn(async () => {
				throw new Error("transient list failure");
			}),
		});

		try {
			await expect(invoke("refreshSessions", view, { preserveStatusOnError: true })).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([
				{ scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } },
			]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a live-only scope through reconnect timeout and settles it on the next successful list", async () => {
		vi.useFakeTimers();
		const root = summary();
		const frame = { scope: { sessionId: root.sessionId, activeSessionId: root.activeSessionId } };
		const persistentState: AgentsViewPersistentState = {
			scopeFrames: [frame],
			lastSuccessfulLiveSummaries: [root],
			lastSuccessfulSavedSessions: [],
		};
		const view = new AgentsViewMode(
			{ config: {}, uiServices: createUiServices(), reconnectTimeoutMs: 0 },
			persistentState,
		);
		const client = { isConnected: false, reconnect: vi.fn() };
		Reflect.set(view, "client", client);
		Reflect.set(view, "savedCatalogReady", true);

		try {
			await expect(invoke("reconnectClient", view, client, new Error("disconnected"))).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([frame]);
			expect(Reflect.get(view, "lastListedSummaries")).toEqual([root]);

			Reflect.set(view, "client", { isConnected: true });
			Reflect.set(view, "rosterStore", { summaries: () => [] });
			await expect(invoke("refreshSessions", view)).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("applies the roster snapshot produced during reconnect heartbeat refresh", async () => {
		const beforeRefresh = summary({ id: "before", sessionId: "before" });
		const afterRefresh = summary({ id: "after", sessionId: "after" });
		let current = [beforeRefresh];
		let finishHeartbeatRefresh: (() => void) | undefined;
		const heartbeatRefresh = new Promise<void>((resolve) => {
			finishHeartbeatRefresh = resolve;
		});
		const client = { reconnect: vi.fn(async () => undefined) };
		const self = {
			options: { recoverDaemon: vi.fn(async () => undefined) },
			client,
			rosterStore: {
				attach: vi.fn(async () => true),
				summaries: vi.fn(() => current),
			},
			refreshHeartbeats: vi.fn(async () => {
				await heartbeatRefresh;
				return true;
			}),
			daemonShutdownReceived: false,
			reconnectTimedOut: true,
			setStatusMessage: vi.fn(),
			applySessionList: vi.fn(),
			armSavedSearchFetch: vi.fn(),
		};

		const reconnect = invoke("reconnectClient", self, client, new Error("disconnected")) as Promise<void>;
		await vi.waitFor(() => expect(self.refreshHeartbeats).toHaveBeenCalledOnce());
		current = [afterRefresh];
		finishHeartbeatRefresh?.();
		await reconnect;

		expect(self.applySessionList).toHaveBeenCalledWith([afterRefresh], true);
	});

	it("keeps a newly pushed scope and the existing live cache when its first poll fails", async () => {
		const root = summary();
		const other = summary({ id: "other-active", activeSessionId: "other-active", sessionId: "other-session" });
		const returnedRoot = { ...root, sessionName: "Updated root" };
		const scope = { sessionId: root.sessionId, activeSessionId: root.activeSessionId };
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			const persistentState = Reflect.get(this, "persistentState") as AgentsViewPersistentState;
			if (runs === 1) {
				persistentState.lastSuccessfulLiveSummaries = [other];
				persistentState.lastSuccessfulSavedSessions = [];
				return { type: "open", summary: root, hasChildren: false };
			}

			expect(persistentState.lastSuccessfulLiveSummaries).toEqual([other, returnedRoot]);
			Reflect.set(this, "client", {
				isConnected: true,
				request: vi.fn(async () => {
					throw new Error("transient list failure");
				}),
			});
			await expect(invoke("refreshSessions", this, { preserveStatusOnError: true })).resolves.toBeUndefined();
			expect(persistentState.scopeFrames).toEqual([{ scope, returnChat: returnedRoot }]);
			return { type: "exit" };
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "scoped_agents_view",
			source: {
				activeSessionId: root.activeSessionId!,
				sessionId: root.sessionId,
				sessionName: returnedRoot.sessionName,
				cwd: root.cwd,
			},
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(runs).toBe(2);
	});
});

describe("AgentsViewMode catalog performance", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("coalesces bursts without copying snapshots per item and flushes during a continuous stream", async () => {
		const previous = [savedSession("previous")];
		const self = catalogHarness(previous);
		const catalog = deferredSavedCatalog();
		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		const first = savedSession("first");
		const updatedFirst = { ...first, path: "/tmp/./first.jsonl", name: "updated first" };
		const second = savedSession("second");
		const third = savedSession("third");
		catalog.emit(first);
		const firstTimer = self.savedCatalogReconcileTimer;
		await vi.advanceTimersByTimeAsync(25);
		catalog.emit(updatedFirst);
		catalog.emit(second);
		await vi.advanceTimersByTimeAsync(25);
		catalog.emit(third);
		await vi.advanceTimersByTimeAsync(24);

		expect(self.savedSessions).toBe(previous);
		expect(self.persistentState.savedSessions).toBe(previous);
		expect(self.savedCatalogReconcileTimer).toBe(firstTimer);
		expect(self.reconcileCatalogs).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(self.reconcileCatalogs).toHaveBeenCalledOnce();
		expect(self.savedSessions).toEqual([previous[0], updatedFirst, second, third]);
		expect(self.persistentState.savedSessions).toBe(self.savedSessions);
		expect(self.rows.map((row) => row.summary.sessionId).sort()).toEqual(["first", "previous", "second", "third"]);
		expect(self.rows.find((row) => row.summary.sessionId === "first")?.title).toBe("updated first");
		expect(self.savedCatalogReady).toBe(false);
		expect(self.savedCatalogRefreshPending).toBe(true);
		expect(self.lastSuccessfulSavedSessions).toBe(previous);
		expect(self.persistentState.lastSuccessfulSavedSessions).toBe(previous);
		expect(self.savedCatalogReconcileTimer).toBeUndefined();

		const firstSnapshot = self.savedSessions;
		const fourth = savedSession("fourth");
		const fifth = savedSession("fifth");
		catalog.emit(fourth);
		await vi.advanceTimersByTimeAsync(50);
		catalog.emit(fifth);
		await vi.advanceTimersByTimeAsync(24);
		expect(self.savedSessions).toBe(firstSnapshot);
		expect(self.persistentState.savedSessions).toBe(firstSnapshot);
		expect(self.reconcileCatalogs).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(1);
		expect(self.reconcileCatalogs).toHaveBeenCalledTimes(2);
		expect(self.savedSessions).toEqual([...firstSnapshot, fourth, fifth]);
		expect(self.rows).toHaveLength(6);
		expect(self.savedCatalogRefreshPending).toBe(true);

		catalog.resolve([updatedFirst, second, third, fourth, fifth]);
		await expect(refresh).resolves.toBe(true);
	});

	it("publishes the final canonical catalog immediately and cancels its pending batch", async () => {
		const self = catalogHarness([savedSession("previous")]);
		const catalog = deferredSavedCatalog();
		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		catalog.emit(savedSession("partial"));
		const final = [savedSession("canonical")];
		catalog.resolve(final);
		await expect(refresh).resolves.toBe(true);

		expect(self.savedSessions).toBe(final);
		expect(self.lastSuccessfulSavedSessions).toBe(final);
		expect(self.persistentState.savedSessions).toBe(final);
		expect(self.persistentState.lastSuccessfulSavedSessions).toBe(final);
		expect(self.persistentState.savedCatalogLoaded).toBe(true);
		expect(self.savedCatalogReady).toBe(true);
		expect(self.savedCatalogRefreshPending).toBe(false);
		expect(self.rows.map((row) => row.summary.sessionId)).toEqual(["canonical"]);
		expect(self.resolveMissingSelectionAnchor).toHaveBeenCalledOnce();
		expect(self.savedCatalogReconcileTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(150);
		expect(self.savedSessions).toBe(final);
		expect(self.reconcileCatalogs).toHaveBeenCalledOnce();
	});

	it.each([false, true])("restores the last successful catalog after failure (batch flushed: %s)", async (flushed) => {
		const previous = [savedSession("previous")];
		const self = catalogHarness(previous);
		const catalog = deferredSavedCatalog();
		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		catalog.emit(savedSession("partial"));
		if (flushed) {
			await vi.advanceTimersByTimeAsync(75);
			expect(self.rows.map((row) => row.summary.sessionId).sort()).toEqual(["partial", "previous"]);
			catalog.emit(savedSession("pending"));
		}
		catalog.reject(new Error("scan failed"));
		await expect(refresh).resolves.toBe(false);

		expect(self.savedSessions).toBe(previous);
		expect(self.persistentState.savedSessions).toBe(previous);
		expect(self.lastSuccessfulSavedSessions).toBe(previous);
		expect(self.persistentState.lastSuccessfulSavedSessions).toBe(previous);
		expect(self.rows.map((row) => row.summary.sessionId)).toEqual(["previous"]);
		expect(self.savedCatalogReady).toBe(true);
		expect(self.savedCatalogRefreshPending).toBe(false);
		expect(self.setStatusMessage).toHaveBeenCalledWith("Failed to load saved sessions: scan failed");
		expect(self.savedCatalogReconcileTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		await vi.advanceTimersByTimeAsync(150);
		expect(self.savedSessions).toBe(previous);
		expect(self.reconcileCatalogs).toHaveBeenCalledTimes(flushed ? 2 : 1);
	});

	it.each(["success", "failure"])("fences a superseded scan's timer, callback, and terminal %s", async (outcome) => {
		const previous = [savedSession("previous")];
		const self = catalogHarness(previous);
		const older = deferredSavedCatalog();
		const newer = deferredSavedCatalog();
		const oldRefresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		older.emit(savedSession("old-partial"));
		await vi.advanceTimersByTimeAsync(25);
		const newRefresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		expect(self.savedCatalogGeneration).toBe(2);
		expect(self.persistentState.savedCatalogGeneration).toBe(2);
		expect(self.savedCatalogReconcileTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		older.emit(savedSession("old-late"));
		expect(vi.getTimerCount()).toBe(0);
		const replacement = savedSession("new-partial");
		newer.emit(replacement);
		const newTimer = self.savedCatalogReconcileTimer;
		if (outcome === "success") older.resolve([savedSession("old-final")]);
		else older.reject(new Error("old scan failed"));
		await expect(oldRefresh).resolves.toBe(false);
		expect(self.savedCatalogReconcileTimer).toBe(newTimer);
		expect(self.savedCatalogRefreshPending).toBe(true);
		expect(self.savedCatalogReady).toBe(false);
		expect(self.resolveMissingSelectionAnchor).not.toHaveBeenCalled();
		expect(self.setStatusMessage).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(50);
		expect(self.savedSessions).toBe(previous);
		expect(self.reconcileCatalogs).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(25);
		expect(self.savedSessions).toEqual([...previous, replacement]);
		expect(self.rows.map((row) => row.summary.sessionId).sort()).toEqual(["new-partial", "previous"]);
		expect(self.reconcileCatalogs).toHaveBeenCalledOnce();
		const final = [savedSession("new-final")];
		newer.resolve(final);
		await expect(newRefresh).resolves.toBe(true);
		await vi.advanceTimersByTimeAsync(150);
		expect(self.savedSessions).toBe(final);
		expect(self.persistentState.savedSessions).toBe(final);
		expect(self.reconcileCatalogs).toHaveBeenCalledTimes(2);
	});

	it.each(["success", "failure"])("finish cancels pending batches and ignores late catalog %s", async (outcome) => {
		const previous = [savedSession("previous")];
		const self = catalogHarness(previous);
		const catalog = deferredSavedCatalog();
		const refresh = invoke("refreshSavedSessions", self) as Promise<boolean>;
		catalog.emit(savedSession("partial"));
		expect(vi.getTimerCount()).toBe(1);
		invoke("finish", self, { type: "exit" });
		expect(self.stopped).toBe(true);
		expect(self.savedCatalogReconcileTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
		catalog.emit(savedSession("late"));
		if (outcome === "success") catalog.resolve([savedSession("final")]);
		else catalog.reject(new Error("late failure"));
		await expect(refresh).resolves.toBe(false);
		await vi.advanceTimersByTimeAsync(150);

		expect(self.savedSessions).toBe(previous);
		expect(self.persistentState.savedSessions).toBe(previous);
		expect(self.lastSuccessfulSavedSessions).toBe(previous);
		expect(self.reconcileCatalogs).not.toHaveBeenCalled();
		expect(self.ui.requestRender).not.toHaveBeenCalled();
		expect(self.resolveMissingSelectionAnchor).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("ticks stale ages and working icons without rebuilding rows or rendering an unchanged idle list", async () => {
		initTheme("dark");
		vi.setSystemTime(new Date("2026-01-01T00:00:10Z"));
		const rows = buildAgentsViewRows([summary({ lastHeardFromAt: "2026-01-01T00:00:00Z" })]);
		const self = {
			rows,
			selectedIndex: -1,
			workingIconFrame: 0,
			savedCatalogGeneration: 0,
			heartbeatCatalogGeneration: 0,
			persistentState: {
				rosterClient: { isConnected: true, onMessage: vi.fn(() => vi.fn()) },
				rosterStore: {
					attach: vi.fn(async () => true),
					onUpdate: vi.fn(() => vi.fn()),
					summaries: () => [],
				},
			},
			ui: {
				addChild: vi.fn(),
				setFocus: vi.fn(),
				start: vi.fn(),
				enterFullscreen: vi.fn(),
				requestRender: vi.fn(),
				invalidate: vi.fn(),
				stop: vi.fn(),
			},
			subscribeToClientClose: vi.fn(),
			applySessionList: vi.fn(),
			armSavedSearchFetch: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
			refreshHeartbeats: vi.fn(async () => true),
			loadStartupNotices: vi.fn(),
			refreshIncidentNotices: vi.fn(),
			rebuildRows: vi.fn(),
			clearCtrlCExitHint: vi.fn(),
			clearDeleteConfirmation: vi.fn(),
			setStatusMessage: vi.fn(),
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon(section: AgentsViewRow["section"]): string {
				return invoke("getRowIcon", self, section) as string;
			},
			formatRowIcon(section: AgentsViewRow["section"], icon: string): string {
				return invoke("formatRowIcon", self, section, icon) as string;
			},
		};
		const render = (row = self.rows[0]!) => stripAnsi(invoke("renderRow", self, row, 160) as string);
		const run = invoke("run", self) as Promise<unknown>;
		try {
			await vi.advanceTimersByTimeAsync(0);
			expect(self.ui.start).toHaveBeenCalledOnce();
			expect(render()).toContain("last heard 10s ago");
			self.ui.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(1000);
			expect(self.ui.requestRender).toHaveBeenCalledTimes(1000 / WORKING_ICON_INTERVAL_MS);
			expect(self.rebuildRows).not.toHaveBeenCalled();
			expect(self.rows).toBe(rows);
			expect(rows[0]?.statusLabel).toBe("last heard 10s ago");
			expect(render()).toContain("last heard 11s ago");
			expect(self.workingIconFrame).toBe(0);

			self.rows = buildAgentsViewRows([summary({ activity: "working", isStreaming: true })]);
			self.ui.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(WORKING_ICON_INTERVAL_MS);
			expect(self.workingIconFrame).toBe(1);
			expect(self.ui.requestRender).toHaveBeenCalledOnce();
			expect(render()).toContain("◈");
			expect(render()).not.toContain("thinking");

			self.rows = buildAgentsViewRows([summary()]);
			self.ui.requestRender.mockClear();
			await vi.advanceTimersByTimeAsync(WORKING_ICON_INTERVAL_MS);
			expect(self.workingIconFrame).toBe(1);
			expect(self.ui.requestRender).not.toHaveBeenCalled();
			expect(self.rebuildRows).not.toHaveBeenCalled();

			const recovering = buildAgentsViewRows([
				summary({ statusLabel: "recovering", lastHeardFromAt: "2026-01-01T00:00:00Z" }),
			])[0]!;
			recovering.heartbeat = { activeCount: 1 };
			const failed = buildAgentsViewRows([summary({ statusLabel: "failed" })])[0]!;
			const statusLabel = vi.spyOn(agentsViewState, "getSessionStatusLabel");
			expect(render(recovering)).toContain("recovering");
			expect(render(recovering)).not.toContain("last heard");
			expect(render(failed)).toContain("failed");
			expect(render()).not.toContain("needs input");
			expect(statusLabel).toHaveBeenCalledTimes(2);
			expect(statusLabel).toHaveBeenCalledWith(recovering.summary, recovering.heartbeat);
		} finally {
			invoke("finish", self, { type: "exit" });
			await run;
		}
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reuses the catalog index and recursive totals across searches until reconciliation", () => {
		const parent = summary({ sessionName: "parent", usage: { inputTokens: 0, outputTokens: 0, cost: 1 } });
		const child = summary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child",
			sessionFile: "/tmp/child.jsonl",
			sessionName: "child",
			runtimeKind: "subagent",
			parentActiveSessionId: parent.activeSessionId,
			usage: { inputTokens: 0, outputTokens: 0, cost: 2 },
		});
		const grandchild = summary({
			id: "grandchild",
			activeSessionId: "grandchild",
			sessionId: "grandchild",
			sessionFile: "/tmp/grandchild.jsonl",
			sessionName: "grandchild",
			runtimeKind: "subagent",
			parentActiveSessionId: child.activeSessionId,
			usage: { inputTokens: 0, outputTokens: 0, cost: 4 },
		});
		const self = catalogHarness([], [parent, child, grandchild]);
		const computeRollups = vi.spyOn(agentsViewState, "computeRecursiveRollups");
		const buildIndex = vi.spyOn(agentsViewState, "buildUnifiedSessionIndex");
		const filterEmpty = vi.spyOn(agentsViewState, "filterEmptyAgentsViewSessions");
		const filterSearch = vi.spyOn(agentsViewState, "filterUnifiedSessions");
		const buildRows = vi.spyOn(agentsViewState, "buildAgentsViewRows");
		self.reconcileCatalogs();
		const index = Reflect.get(self, "unifiedIndex");
		const rollups = Reflect.get(self, "recursiveRollups");
		expect(rollups).toBeInstanceOf(Map);
		const parentRow = () => self.rows.find((row) => row.summary.sessionId === parent.sessionId);
		expect(parentRow()).toMatchObject({ recursiveCost: 7, descendantCount: 2 });

		for (const query of ["parent", "grandchild", "no match", ""]) {
			self.editor.getText.mockReturnValue(query);
			invoke("queryChanged", self);
			expect(Reflect.get(self, "unifiedIndex")).toBe(index);
			expect(Reflect.get(self, "recursiveRollups")).toBe(rollups);
			if (query === "no match") expect(self.rows).toEqual([]);
			else expect(parentRow()).toMatchObject({ recursiveCost: 7, descendantCount: 2 });
		}
		expect(computeRollups).toHaveBeenCalledOnce();
		expect(buildIndex).toHaveBeenCalledOnce();
		expect(filterEmpty).toHaveBeenCalledTimes(5);
		expect(filterSearch).toHaveBeenCalledTimes(3);
		for (const call of [...filterEmpty.mock.calls, ...filterSearch.mock.calls]) expect(call[2]).toBe(index);
		for (const call of buildRows.mock.calls) expect(call[4]).toBe(rollups);

		self.lastListedSummaries = [
			parent,
			child,
			{ ...grandchild, usage: { inputTokens: 0, outputTokens: 0, cost: 10 } },
			{ ...child, id: "new", activeSessionId: "new", sessionId: "new", sessionFile: "/tmp/new.jsonl" },
		];
		self.reconcileCatalogs();
		expect(Reflect.get(self, "unifiedIndex")).not.toBe(index);
		expect(Reflect.get(self, "recursiveRollups")).not.toBe(rollups);
		expect(computeRollups).toHaveBeenCalledTimes(2);
		expect(buildIndex).toHaveBeenCalledTimes(2);
		expect(parentRow()).toMatchObject({ recursiveCost: 15, descendantCount: 3 });
		self.editor.getText.mockReturnValue("parent");
		invoke("queryChanged", self);
		expect(parentRow()).toMatchObject({ recursiveCost: 15, descendantCount: 3 });
		expect(computeRollups).toHaveBeenCalledTimes(2);
	});
});

describe("agents view reply delivery on inactive sessions", () => {
	function replySummary(overrides: Partial<SessionSummary>): SessionSummary {
		return {
			id: "saved-1",
			lifecycle: "archived",
			activity: "idle",
			sessionId: "saved-1",
			cwd: process.cwd(),
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 3,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			...overrides,
			isSessionActive: overrides.isSessionActive ?? false,
		};
	}

	function editorWithText(initial: string) {
		let text = initial;
		return {
			getText: () => text,
			setText: vi.fn((next: string) => {
				text = next;
			}),
		};
	}

	const savedSummary = replySummary({
		sessionFile: "/tmp/sessions/saved-1.jsonl",
		cwd: process.cwd(),
		summary: "Persisted recap text",
		firstMessage: "opener",
	});

	it("arms a saved reply from its persisted recap and lets ctrl+c disarm it", async () => {
		const requestRender = vi.fn();
		const handleCtrlC = vi.fn();
		const self: Record<string, unknown> = {
			rows: [
				{ kind: "agent", selectable: true, identity: "file:/tmp/sessions/saved-1.jsonl", summary: savedSummary },
			],
			selectedIndex: 0,
			pendingDeleteAgent: undefined,
			replyTarget: undefined,
			renameTarget: undefined,
			setReplyTarget: vi.fn((target: unknown) => {
				self.replyTarget = target;
			}),
			ui: { requestRender },
			clearStickyStatusMessage: vi.fn(),
			keybindings: { matches: (_data: string, action: string) => action === "app.clear" },
			handleCtrlC,
		};

		await invoke("toggleReplyTarget", self);
		expect(self.replyTarget).toEqual({ key: "saved-1", summary: savedSummary });
		expect(self.replyLastAssistantText).toBe("Persisted recap text");
		expect(requestRender).toHaveBeenCalledOnce();

		invoke("handleInput", self, "\x03");
		expect(self.replyTarget).toBeUndefined();
		expect(handleCtrlC).not.toHaveBeenCalled();
	});

	it("keeps the cwd-fallback notice visible after the reply is sent", async () => {
		const savedWithMissingCwd = { ...savedSummary, cwd: "/definitely/not/a/real/dir/for/this/test" };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...savedWithMissingCwd, lifecycle: "live", activeSessionId: "active-9" },
		}));
		const setStatusMessage = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage,
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "saved-1", summary: savedWithMissingCwd }, "wake up");

		expect(setStatusMessage).toHaveBeenLastCalledWith(expect.stringContaining("Original directory is missing"), {
			sticky: true,
		});
	});

	it("submits alt+enter as a follow-up only for an armed non-empty reply", () => {
		const submit = vi.fn(async () => {});
		invoke("handleReplyFollowUp", { replyTarget: undefined, editor: { getExpandedText: () => "text" }, submit });
		invoke("handleReplyFollowUp", {
			replyTarget: { key: "active-1", summary: savedSummary },
			editor: { getExpandedText: () => "   " },
			submit,
		});
		expect(submit).not.toHaveBeenCalled();

		invoke("handleReplyFollowUp", {
			replyTarget: { key: "active-1", summary: savedSummary },
			editor: { getExpandedText: () => "expanded paste body" },
			submit,
		});
		expect(submit).toHaveBeenCalledWith("expanded paste body", "followUp");
	});

	// [the view finishes mid-create, the requests the dedicated connection carries]
	it.each([
		["opens it", false, ["create"]],
		["kills a session created after the view already finished", true, ["create", "kill"]],
	] as const)(
		"creates a new daemon session over a dedicated connection and %s",
		async (_name, stopsDuringCreate, requestTypes) => {
			const created = replySummary({ id: "active-new", activeSessionId: "active-new", lifecycle: "live" });
			const requests: { type: string }[] = [];
			const close = vi.fn();
			const self: Record<string, unknown> = {
				creatingNewSession: false,
				stopped: false,
				options: { config: {} },
				connectDedicatedClient: vi.fn(async () => ({
					close,
					request: vi.fn(async (command: { type: string }) => {
						requests.push(command);
						// The view finishes while create is in flight.
						if (stopsDuringCreate) self.stopped = true;
						return { success: true, data: created };
					}),
				})),
				setStatusMessage: vi.fn(),
				selectSummary: vi.fn(),
				finish: vi.fn(),
			};

			const result = await invoke("createNewSession", self);

			expect(requests.map((r) => r.type)).toEqual(requestTypes);
			if (stopsDuringCreate) {
				expect(self.finish).not.toHaveBeenCalled();
				expect(self.selectSummary).not.toHaveBeenCalled();
			} else {
				expect(result).toBe(true);
				expect(self.selectSummary).toHaveBeenCalledWith(created);
				expect(self.finish).toHaveBeenCalledWith({ type: "open", summary: created });
				expect(close).toHaveBeenCalledOnce();
				expect(self.creatingNewSession).toBe(false);
			}
		},
	);

	it("resumes a saved session before delivering the reply", async () => {
		const request = vi.fn(async (command: { type: string }) => {
			if (command.type === "create") {
				return {
					success: true,
					data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9", isStreaming: true },
				};
			}
			return { success: true, data: {} };
		});
		const target = { key: "saved-1", summary: savedSummary };
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			replyTarget: target,
			// Stale pre-resume rows do not know the resumed session; scheduling must
			// come from the resume response instead.
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, target, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-9", "wake up", "steer");
		expect(self.selectSummary).toHaveBeenCalledWith(expect.objectContaining({ activeSessionId: "active-9" }));
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
	});

	it("does not select a resumed session after its reply target is cancelled", async () => {
		let finishResume: ((result: { success: true; data: SessionSummary }) => void) | undefined;
		let signalResumeStarted!: () => void;
		const resumeStarted = new Promise<void>((resolve) => {
			signalResumeStarted = resolve;
		});
		const request = vi.fn(
			() =>
				new Promise<{ success: true; data: SessionSummary }>((resolve) => {
					finishResume = resolve;
					signalResumeStarted();
				}),
		);
		const target = { key: "saved-1", summary: savedSummary };
		const selection = { activeSessionId: "active-2" };
		const selectSummary = vi.fn((next: SessionSummary) => {
			selection.activeSessionId = next.activeSessionId ?? next.id;
		});
		const sendPrompt = vi.fn(async () => {});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set(["file:/tmp/sessions/saved-1.jsonl"]),
			replyTarget: target,
			setStatusMessage: vi.fn(),
			selectSummary,
			sendPrompt,
		};

		const reply = invoke("sendReply", self, target, "wake up") as Promise<boolean>;
		await resumeStarted;
		expect(request).toHaveBeenCalledOnce();
		self.replyTarget = undefined;
		finishResume?.({
			success: true,
			data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
		});

		await expect(reply).resolves.toBe(true);
		expect(selectSummary).not.toHaveBeenCalled();
		expect(selection.activeSessionId).toBe("active-2");
		expect(sendPrompt).toHaveBeenCalledWith("active-9", "wake up", undefined);
		expect(self.inactiveAgentIdentities).not.toContain("file:/tmp/sessions/saved-1.jsonl");
	});

	// [re-armed target survives, text entered mid-send survives]
	it.each([
		["preserves a replacement composer when an older reply succeeds", true],
		["preserves new text entered while the same reply succeeds", false],
	] as const)("%s", async (_name, rearmed) => {
		const editor = editorWithText("old reply");
		const oldTarget = { key: "saved-1", summary: savedSummary };
		const newTarget = {
			key: "active-2",
			summary: replySummary({ id: "active-2", activeSessionId: "active-2", lifecycle: "live" }),
		};
		const self: Record<string, unknown> = {
			replyTarget: oldTarget,
			options: {},
			editor,
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			sendReply: vi.fn(async () => {
				if (rearmed) self.replyTarget = newTarget;
				editor.setText("next reply");
				return true;
			}),
		};

		await invoke("submit", self, "old reply");

		expect(self.replyTarget).toBe(rearmed ? newTarget : oldTarget);
		expect(editor.getText()).toBe("next reply");
		expect(self.setReplyTarget).not.toHaveBeenCalled();
		if (rearmed) expect(self.refreshSessions).toHaveBeenCalledWith();
	});

	it.each([
		{ name: "resume failure", failure: "resume", remainsInactive: true },
		{ name: "send failure", failure: "send", remainsInactive: false },
		{
			name: "replacement text entered during send failure",
			failure: "send",
			replacement: "replacement",
			remainsInactive: false,
		},
	] as const)("handles $name", async ({ failure, replacement, remainsInactive }) => {
		const editor = editorWithText("wake up");
		const target = { key: "saved-1", summary: savedSummary };
		const inactiveAgentIdentities = new Set(["file:/tmp/sessions/saved-1.jsonl"]);
		const request = vi.fn(async () => {
			if (failure === "resume") throw new Error("resume failed");
			return {
				success: true,
				data: { ...savedSummary, lifecycle: "live", activeSessionId: "active-9" },
			};
		});
		const sendPrompt = vi.fn(async () => {
			if (replacement) editor.setText(replacement);
			throw new Error("send failed");
		});
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities,
			replyTarget: target,
			editor,
			setStatusMessage: vi.fn(),
			setReplyTarget: vi.fn(),
			refreshSessions: vi.fn(async () => true),
			selectSummary: vi.fn(),
			sendPrompt,
			sendReply: (replyTarget: unknown, text: string) => invoke("sendReply", self, replyTarget, text),
		};

		await invoke("submit", self, "wake up");

		expect(request).toHaveBeenCalledOnce();
		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(sendPrompt).toHaveBeenCalledTimes(failure === "resume" ? 0 : 1);
		expect(self.selectSummary).toHaveBeenCalledTimes(failure === "resume" ? 0 : 1);
		expect(self.setStatusMessage).toHaveBeenLastCalledWith(`Failed to send reply: ${failure} failed`);
		expect(self.replyTarget).toBe(target);
		expect(self.setReplyTarget).not.toHaveBeenCalled();
		expect(editor.setText).toHaveBeenNthCalledWith(1, "");
		expect(editor.getText()).toBe(replacement ?? "wake up");
		expect(inactiveAgentIdentities.has("file:/tmp/sessions/saved-1.jsonl")).toBe(remainsInactive);
		expect(self.refreshSessions).toHaveBeenCalledTimes(remainsInactive ? 0 : 1);
		if (!remainsInactive) {
			expect(self.refreshSessions).toHaveBeenCalledWith();
		}
	});

	it("resumes the current saved row when an armed live target becomes inactive", async () => {
		const capturedLive = replySummary({
			activeSessionId: "active-dead",
			lifecycle: "live",
			sessionFile: savedSummary.sessionFile,
		});
		const currentSaved = { ...savedSummary, activeSessionId: undefined };
		const request = vi.fn(async () => ({
			success: true,
			data: { ...currentSaved, lifecycle: "live", activeSessionId: "active-new" },
		}));
		const self: Record<string, unknown> = {
			options: { config: { cwd: process.cwd() } },
			requireClient: () => ({ request }),
			unifiedRecords: [
				{
					daemon: currentSaved,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "inactive",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			inactiveAgentIdentities: new Set<string>(),
			replyTarget: undefined,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};

		await invoke("sendReply", self, { key: "active-dead", summary: capturedLive }, "wake up");

		expect(request).toHaveBeenCalledWith(
			expect.objectContaining({ type: "create", sessionPath: savedSummary.sessionFile }),
		);
		expect(self.sendPrompt).toHaveBeenCalledWith("active-new", "wake up", undefined);
		expect(self.sendPrompt).not.toHaveBeenCalledWith("active-dead", expect.anything(), expect.anything());
	});

	it("replies to live sessions without resuming, steering or queueing per delivery", async () => {
		let liveSummary = replySummary({ activeSessionId: "active-1", lifecycle: "live" });
		const request = vi.fn();
		const self: Record<string, unknown> = {
			options: { config: {} },
			requireClient: () => ({ request }),
			findSummaryByActiveSessionId: () => liveSummary,
			setStatusMessage: vi.fn(),
			selectSummary: vi.fn(),
			sendPrompt: vi.fn(async () => {}),
		};
		const target = () => ({ key: "active-1", summary: liveSummary });

		await invoke("sendReply", self, target(), "hello");
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "hello", undefined);

		liveSummary = replySummary({ activeSessionId: "active-1", lifecycle: "live", isStreaming: true });
		await invoke("sendReply", self, target(), "change course");
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "change course", "steer");

		await invoke("sendReply", self, target(), "later please", "followUp");
		expect(self.sendPrompt).toHaveBeenCalledWith("active-1", "later please", "followUp");

		expect(request).not.toHaveBeenCalled();
		expect(self.selectSummary).not.toHaveBeenCalled();
	});

	it("does not disarm a composer that was re-armed during the command", async () => {
		const live = replySummary({ activeSessionId: "active-1", lifecycle: "live" });
		const originalTarget = { key: "active-1", summary: live };
		const newTarget = { key: "active-2", summary: replySummary({ activeSessionId: "active-2" }) };
		const setReplyTarget = vi.fn();
		const self: Record<string, unknown> = {
			requireClient: () => ({
				request: vi.fn(async () => {
					// The user re-arms against a different agent mid-RPC.
					self.replyTarget = newTarget;
					return { success: true, data: {} };
				}),
			}),
			editor: editorWithText(""),
			setStatusMessage: vi.fn(),
			setReplyTarget,
			replyTarget: originalTarget,
			refreshSessions: vi.fn(async () => true),
		};

		await invoke("runAgentsViewCommand", self, { name: "kill", args: "" }, live);

		expect(setReplyTarget).not.toHaveBeenCalled();
	});

	it("re-resolves the armed target before dispatching a view command", async () => {
		const stale = replySummary({ sessionFile: "/tmp/sessions/saved-1.jsonl" });
		const liveNow = replySummary({
			sessionFile: "/tmp/sessions/saved-1.jsonl",
			activeSessionId: "active-9",
			lifecycle: "live",
		});
		const runAgentsViewCommand = vi.fn(async () => true);
		const self: Record<string, unknown> = {
			replyTarget: { key: "saved-1", summary: stale },
			options: {},
			unifiedRecords: [
				{
					daemon: liveNow,
					identity: "file:/tmp/sessions/saved-1.jsonl",
					identityAliases: ["file:/tmp/sessions/saved-1.jsonl"],
					section: "idle",
					searchableText: "",
				},
			],
			findSummaryByActiveSessionId: () => undefined,
			editor: editorWithText(""),
			runAgentsViewCommand,
		};

		await invoke("submit", self, "/kill");

		expect(runAgentsViewCommand).toHaveBeenCalledWith(
			{ name: "kill", args: "" },
			expect.objectContaining({ activeSessionId: "active-9" }),
		);
	});
});

describe("agents view open during a daemon update restart", () => {
	beforeEach(() => vi.clearAllMocks());

	it.each([
		[
			"waits through the update restart and surfaces the wait notice",
			true,
			"Waited for the Prime Agent daemon update restart to finish",
		],
		[
			"surfaces a permanent create failure unmasked by the wait",
			false,
			"Failed to open agent: File not found: /tmp/scope.jsonl",
		],
	] as const)("%s", async (_name, reachesSession, expectedMessage) => {
		const saved = summary({ activeSessionId: undefined, lifecycle: "archived" });
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) return { type: "open", summary: saved, hasChildren: false };
			expect(String(Reflect.get(this, "persistentState").statusMessage)).toContain(expectedMessage);
			return { type: "exit" };
		});
		modeMocks.clientRequest
			.mockResolvedValueOnce({
				success: false,
				error: "Daemon is preparing an update restart",
			})
			.mockResolvedValueOnce(
				reachesSession
					? { success: true, data: { ...saved, activeSessionId: "resumed-after-update", lifecycle: "live" } }
					: { success: false, error: "File not found: /tmp/scope.jsonl" },
			);
		modeMocks.interactiveRun.mockResolvedValue({
			type: "agents_view",
			source: { activeSessionId: "resumed-after-update", sessionId: saved.sessionId, cwd: saved.cwd },
		} as never);

		await runAgentsViewMode({
			config: { cwd: process.cwd() },
			socketPath: "/tmp/agents-view-test.sock",
			uiServices: createUiServices(),
		});

		expect(modeMocks.clientRequest).toHaveBeenCalledTimes(2);
		expect(modeMocks.interactiveRun).toHaveBeenCalledTimes(reachesSession ? 1 : 0);
		expect(runs).toBe(2);
	});
});

describe("waitThroughDaemonUpdateRestart", () => {
	const updateRestartDeadline =
		/The Prime Agent daemon did not finish its update restart within \d+ seconds\. Try opening this agent again once the update finishes\. Last error: Daemon is preparing an update restart/;

	// Post-arm transient shapes only; arming is pinned at the loop/deadline layers.
	it("retries every restart-transient failure and reports that it waited", async () => {
		const transientFailures = [
			() => new Error("Failed to connect to the Prime Agent daemon: connect ENOENT"),
			() => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
			() => new Error("Connection to the Prime Agent daemon closed."),
			() => new Error('Timed out after 30000ms waiting for the Prime Agent daemon response to "create".'),
			() => new DaemonControlPlaneTransportError(new Error("Connection to the Prime Agent daemon closed.")),
			() => new Error("Unknown active session: update-restart-session"),
			() => new DaemonSessionRecoveringError("update-restart-session"),
		];
		let attempts = 0;
		const outcome = await waitThroughDaemonUpdateRestart(
			async () => {
				attempts += 1;
				if (attempts === 1) throw new DaemonUpdateRestartingError();
				const failure = transientFailures[attempts - 2];
				if (failure) throw failure();
				return "opened";
			},
			{ waitMs: 5_000, retryMs: 1 },
		);
		expect(outcome).toEqual({ result: "opened", waitedForUpdateRestart: true });
	});

	it("propagates a non-update failure before any update-restart signal", async () => {
		let attempts = 0;
		await expect(
			waitThroughDaemonUpdateRestart(async () => {
				attempts += 1;
				throw new Error("spawn EMFILE");
			}),
		).rejects.toThrow("spawn EMFILE");
		expect(attempts).toBe(1);
	});

	// The deadline races every attempt so an in-flight create cannot hold the open past the budget.
	it("fails at the deadline even when an in-flight attempt would block past it", async () => {
		vi.useFakeTimers();
		const inFlight = new Promise<string>(() => {});
		let attempts = 0;
		try {
			const opening = waitThroughDaemonUpdateRestart(
				async () => {
					attempts += 1;
					if (attempts === 1) throw new DaemonUpdateRestartingError();
					return inFlight;
				},
				{ waitMs: 60, retryMs: 5 },
			).then(
				() => "unexpectedly opened",
				(error: Error) => error.message,
			);
			await vi.advanceTimersByTimeAsync(60);
			expect(await opening).toMatch(updateRestartDeadline);
			expect(attempts).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});
});
