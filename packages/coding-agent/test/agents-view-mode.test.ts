import { getModel } from "@earendil-works/pi-ai";
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
	buildCompactAgentsViewLayout,
	combineAgentsViewStartupNotices,
	createInitialAgentsViewPersistentState,
	runAgentsViewMode,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	type AgentsViewRow,
	buildAgentsViewRows,
	reconcileUnifiedSessions,
	resolveAgentsViewLeftResult,
} from "../src/modes/agents-view/agents-view-state.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import { stopThemeWatcher, theme } from "../src/modes/interactive/theme/theme.js";

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

vi.mock("../src/modes/daemon/daemon-client.js", () => ({
	DaemonClient: class {
		connect = vi.fn(async () => undefined);
		close = vi.fn();
		request = modeMocks.clientRequest;
	},
	getDaemonSocketCloseReason: vi.fn(),
}));

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

	it("keeps the selection chosen by row rebuilding when the query changes", () => {
		const self = {
			editor: { getText: () => "matching query" },
			persistentState: { query: "" },
			savedSearchFetchStarted: true,
			// Searching claims the visible row even while a remembered anchor is
			// still waiting for its catalog row: user intent supersedes restore.
			selectionAnchorPending: true,
			selectedIndex: 4,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
			armSavedSearchFetch(): void {
				invoke("armSavedSearchFetch", self);
			},
		};

		invoke("queryChanged", self);

		expect(self.persistentState.query).toBe("matching query");
		expect(self.rebuildRows).toHaveBeenCalledOnce();
		expect(self.selectedIndex).toBe(4);
		expect(self.syncSelectedRowState).toHaveBeenCalledOnce();
	});

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

	it("stops instead of deleting when an idle row's subtree still works", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => true }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		const idleWithBusyCrew = {
			kind: "subagent",
			section: "idle",
			runningSubagentCount: 1,
			summary: summary({ id: "crew-parent", activeSessionId: "crew-parent", sessionId: "crew-parent-session" }),
		};

		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "crew-parent-child" },
			idleWithBusyCrew,
		);

		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "crew-parent-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
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

	it("uses cancel when an inactive subagent starts running during confirmation", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: true } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => true }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			{ section: "running" },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(request).not.toHaveBeenCalledWith(expect.objectContaining({ type: "delete_rlm_subagent" }));
	});

	it("falls back to cancel-only when subagent deletion is unsupported", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: { cancelled: false } }));
		const self = {
			requireClient: () => ({ request, supportsServerCapability: () => false }),
			setStatusMessage: vi.fn(),
			refreshSessions: vi.fn(async () => true),
		};
		await invoke(
			"killSubagent",
			self,
			{ identity: "child-row", rootActiveSessionId: "root-active", childId: "passive-child" },
			{ section: "inactive", runningSubagentCount: 0, summary: summary() },
		);
		expect(request).toHaveBeenCalledWith({
			type: "cancel_rlm_child",
			activeSessionId: "root-active",
			childId: "passive-child",
		});
		expect(self.setStatusMessage).toHaveBeenCalledWith("The daemon cannot delete subagents; it was left unchanged", {
			render: false,
			tone: "warning",
		});
	});

	it("checks telemetry policy before replying from an opted-out agents view", async () => {
		const client = { close: vi.fn() };
		const connectDedicatedClient = vi.fn(async () => client);
		const self = {
			options: {
				config: { telemetryDisabled: true },
				recoverDaemon: vi.fn(async () => undefined),
				reconnectTimeoutMs: 1234,
			},
			connectDedicatedClient,
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "followUp");

		expect(connectDedicatedClient).toHaveBeenCalledOnce();
		expect(DaemonAgentConnection.attach).toHaveBeenCalledWith(client, "active-1", {
			closeClientOnDispose: true,
			supportsExtensionUi: false,
			recoverDaemon: self.options.recoverDaemon,
			reconnectTimeoutMs: 1234,
			telemetryDisabled: true,
		});
		expect(modeMocks.connectionPrompt).toHaveBeenCalledWith("private prompt", {
			streamingBehavior: "followUp",
		});
		expect(modeMocks.dispose).toHaveBeenCalledOnce();
	});

	it("keeps direct agents-view replies when telemetry is enabled", async () => {
		const request = vi.fn(async () => ({ success: true as const, data: undefined }));
		const self = {
			options: { config: {} },
			requireClient: () => ({ request }),
		};

		await invoke("sendPrompt", self, "active-1", "private prompt", "steer");

		expect(request).toHaveBeenCalledWith({
			type: "prompt",
			activeSessionId: "active-1",
			message: "private prompt",
			streamingBehavior: "steer",
		});
		expect(DaemonAgentConnection.attach).not.toHaveBeenCalled();
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

	it("invalidates the persisted scope root after popping a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [
					{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } },
					{ scope: { sessionId: child.sessionId, activeSessionId: child.activeSessionId } },
				];
				state.scopeRootSummary = child;
				return Promise.resolve({
					type: "scope_back",
					selection: child,
					expandedAncestorSessionIds: [],
					hasChildren: false,
				});
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(1);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});

		await runAgentsViewMode({
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

	it("invalidates the persisted scope root after pushing a scope frame", async () => {
		const parent = summary({ id: "parent", activeSessionId: "parent", sessionId: "parent" });
		const child = summary({ id: "child", activeSessionId: "child", sessionId: "child" });
		const runView = vi
			.spyOn(AgentsViewMode.prototype, "run")
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				state.scopeFrames = [{ scope: { sessionId: parent.sessionId, activeSessionId: parent.activeSessionId } }];
				state.scopeRootSummary = parent;
				return Promise.resolve({ type: "open", summary: child });
			})
			.mockImplementationOnce(function (this: AgentsViewMode) {
				const state = (this as unknown as { persistentState: AgentsViewPersistentState }).persistentState;
				expect(state.scopeFrames).toHaveLength(2);
				expect(state.scopeRootSummary).toBeUndefined();
				return Promise.resolve({ type: "exit" });
			});
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

		await runAgentsViewMode({
			socketPath: "/tmp/fake-daemon.sock",
			config: { cwd: "/tmp" } as never,
			uiServices: {
				settingsManager: settingsManager as never,
				modelRegistry: {} as never,
				getInitialCwd: () => "/tmp",
				getInitialSessionName: () => undefined,
				getThemes: () => [],
			},
		});

		runView.mockRestore();
	});

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

	it("keeps subagent expansion across the active-to-persisted identity flip", () => {
		const rowsOf = (self: Record<string, unknown>) => Reflect.get(self, "rows") as AgentsViewRow[];
		const buildView = (expand: boolean) => {
			const parent = summary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionFile: undefined,
				runtimeKind: "top-level",
			});
			const child = summary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: undefined,
				runtimeKind: "subagent",
				parentSessionId: "root-session",
				parentActiveSessionId: "root-active",
			});
			const expandedSubagentParents = new Set<string>();
			const self: Record<string, unknown> = {
				persistentState: {},
				lastListedSummaries: [parent, child],
				savedSessions: [],
				heartbeats: [],
				inactiveAgentIdentities: new Set(),
				pendingDeleteAgent: undefined,
				savedCatalogReady: true,
				expandedSubagentParents,
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
			if (expand) {
				const parentRow = rowsOf(self).find(
					(row) => row.kind === "agent" && row.summary.sessionId === "root-session",
				);
				expect(parentRow?.identity).toBe("session:root-session");
				expandedSubagentParents.add(parentRow!.identity);
				invoke("reconcileCatalogs", self);
				expect(rowsOf(self).some((row) => row.kind === "subagent")).toBe(true);
			}
			// The runtime flushes the session file; the record identity flips to file:.
			self.lastListedSummaries = [{ ...parent, sessionFile: "/tmp/root.jsonl" }, child];
			invoke("reconcileCatalogs", self);
			return { self, expandedSubagentParents };
		};

		const expandedView = buildView(true);
		const expandedRows = rowsOf(expandedView.self);
		expect(
			expandedRows.find((row) => row.kind === "agent" && row.summary.sessionId === "root-session")?.identity,
		).toBe("file:/tmp/root.jsonl");
		expect(expandedRows.some((row) => row.kind === "subagent-summary")).toBe(false);
		expect(expandedRows.some((row) => row.kind === "subagent" && row.summary.sessionId === "child-session")).toBe(
			true,
		);
		expect([...expandedView.expandedSubagentParents]).toEqual(["file:/tmp/root.jsonl"]);

		const collapsedView = buildView(false);
		const collapsedRows = rowsOf(collapsedView.self);
		expect(collapsedRows.some((row) => row.kind === "subagent-summary" && row.expanded)).toBe(false);
		expect(collapsedRows.some((row) => row.kind === "subagent")).toBe(false);
		expect(collapsedView.expandedSubagentParents.size).toBe(0);
	});

	it("toggles subagent list expansion from the parent row", () => {
		const expandedSubagentParents = new Set(["root-row"]);
		const programShownParents = new Set(["root-row"]);
		const persistentState: AgentsViewPersistentState = {
			expandedSubagentParents,
			programShownParents,
		};
		const self: Record<string, unknown> = {
			persistentState,
			expandedSubagentParents,
			programShownParents,
			rebuildRows: vi.fn(),
			syncSelectedRowState: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const summaryRow = { kind: "agent", identity: "root-row", expanded: true };

		invoke("toggleSubagentList", self, summaryRow);
		expect(expandedSubagentParents.size).toBe(0);
		// Collapsing the list hides its revealed program too.
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(1);

		invoke("toggleSubagentList", self, { ...summaryRow, expanded: false });
		expect(expandedSubagentParents).toEqual(new Set(["root-row"]));
		expect(programShownParents.size).toBe(0);
		expect(self.rebuildRows).toHaveBeenCalledTimes(2);
	});

	it("renders roster recovery and stale-worker status labels", () => {
		const rows = buildAgentsViewRows([
			summary({ id: "recovering", sessionId: "recovering", statusLabel: "recovering" }),
			summary({
				id: "stale",
				sessionId: "stale",
				lastHeardFromAt: new Date(Date.now() - 60_000).toISOString(),
			}),
		]);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		Reflect.set(view, "rows", rows);

		try {
			expect(invoke("renderRow", view, rows[0], 160)).toContain("recovering");
			expect(invoke("renderRow", view, rows[1], 160)).toContain("last heard");
		} finally {
			stopThemeWatcher();
		}
	});

	it("shows each session model and aligned total cost including collapsed descendants", () => {
		const created = new Date(Date.now() - 120_000).toISOString();
		const parent = summary({
			id: "spender",
			activeSessionId: "spender",
			sessionId: "spender-session",
			sessionName: "spender",
			model: { ...getModel("openai", "gpt-4o"), id: "gpt-5.6-sol" },
			created,
			summary: "Analyzing runtime composition",
			usage: { inputTokens: 12437, outputTokens: 1234, cost: 0.42 },
		});
		const child = summary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child-session",
			sessionFile: "/tmp/child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: "spender",
			model: { ...getModel("openai", "gpt-4o"), provider: "prime-inference", id: "glm-5.2-fast" },
			created,
			usage: { inputTokens: 500, outputTokens: 50, cost: 0.68 },
		});
		const inactive = summary({
			id: "saved",
			activeSessionId: undefined,
			sessionId: "saved-session",
			sessionFile: "/tmp/saved.jsonl",
			rosterStatus: "inactive",
			created,
			model: { ...getModel("openai", "gpt-4o"), provider: "prime-inference", id: "glm-5.2-fast" },
			usage: { inputTokens: 900, outputTokens: 80, cost: 123.45 },
		});
		const rows = buildAgentsViewRows([parent, child, inactive]);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		Reflect.set(view, "rows", rows);
		Reflect.set(view, "selectedIndex", -1);
		try {
			const parentRow = rows.find((row) => row.summary.sessionId === parent.sessionId)!;
			const savedRow = rows.find((row) => row.summary.sessionId === inactive.sessionId)!;
			const render = (row: AgentsViewRow, width: number) =>
				stripAnsi(invoke("renderRow", view, row, width, buildCompactAgentsViewLayout(rows, width)) as string);
			const parentLine = render(parentRow, 120);
			const savedLine = render(savedRow, 120);
			expect(parentLine).toContain("gpt-5.6-sol");
			expect(savedLine).toContain("glm-5.2-fast");
			expect(parentLine).toContain("$1.10");
			expect(parentLine).not.toContain("$0.42");
			expect(parentLine).not.toMatch(/[↑↓]/);
			expect(parentLine).toMatch(/2m\s*$/);
			expect(parentLine.indexOf("$1.10") + "$1.10".length).toBe(savedLine.indexOf("$123.45") + "$123.45".length);
			for (const width of [60, 80]) {
				const narrow = render(parentRow, width);
				expect(narrow).toContain("gpt-5.6-sol");
				expect(narrow).toContain("$1.10");
				expect(narrow).toMatch(/2m\s*$/);
				expect(narrow.length).toBeLessThanOrEqual(width);
			}
		} finally {
			stopThemeWatcher();
		}
	});

	it("renders one column header across status groups without repeating subagent hints", () => {
		const summaries = [
			summary({
				id: "busy",
				activeSessionId: "busy",
				sessionId: "busy-session",
				sessionName: "busy",
				activity: "working",
				isStreaming: true,
			}),
			summary({
				id: "idle",
				activeSessionId: "idle",
				sessionId: "idle-session",
				sessionName: "idle",
				sessionFile: "/tmp/idle.jsonl",
			}),
			summary({
				id: "child",
				sessionId: "child-session",
				sessionFile: "/tmp/child.jsonl",
				runtimeKind: "subagent",
				parentActiveSessionId: "busy",
			}),
		];
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			Reflect.set(view, "lastListedSummaries", summaries);
			invoke("reconcileCatalogs", view);
			Reflect.set(view, "selectedIndex", -1);
			Reflect.set(view, "ui", { terminal: { rows: 60 }, requestRender: () => {} });
			const rendered = invoke("renderSessionRows", view, 120, 40) as string[];
			const lines = rendered.map(stripAnsi);
			expect(lines.filter((line) => /Model/.test(line) && /Age/i.test(line))).toHaveLength(1);
			expect(rendered[0]).toBe(
				theme.bold(buildCompactAgentsViewLayout(Reflect.get(view, "rows") as AgentsViewRow[], 120).legend),
			);
			expect(lines[1]).toBe("");
			expect(lines[2]).toBe("Running (1)");
			expect(rendered[2]).toContain(theme.fg("muted", "Running (1)"));
			expect(lines).toContain("Idle (1)");
			expect(lines).not.toContain("Inactive (0)");
			expect(lines.join("\n")).not.toMatch(/show program|#sub|\$agent|↑in|↓out/);
			const rows = Reflect.get(view, "rows") as AgentsViewRow[];
			expect(rows.filter((row) => row.kind === "subagent-summary")).toHaveLength(0);
			for (const line of rendered) {
				expect(invoke("finalizeRenderedLine", view, line, 120)).not.toContain("\x1b[48");
			}
		} finally {
			stopThemeWatcher();
		}
	});

	it("renders a shared color-coded status circle for idle and inactive rows", () => {
		const summaries = [
			summary({
				id: "busy",
				activeSessionId: "busy",
				sessionId: "busy-session",
				sessionName: "busy",
				activity: "working",
				isStreaming: true,
			}),
			summary({
				id: "idle",
				activeSessionId: "idle",
				sessionId: "idle-session",
				sessionName: "idle",
				sessionFile: "/tmp/idle.jsonl",
			}),
		];
		const archived: AgentConnectionSavedSessionInfo = {
			id: "archived",
			path: "/tmp/archived.jsonl",
			cwd: "/tmp/project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 2,
			firstMessage: "Fix authentication",
			allMessagesText: "",
			name: "archived session",
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		try {
			Reflect.set(view, "lastListedSummaries", summaries);
			Reflect.set(view, "savedSessions", [archived]);
			invoke("reconcileCatalogs", view);
			Reflect.set(view, "selectedIndex", -1);
			Reflect.set(view, "ui", { terminal: { rows: 60 }, requestRender: () => {} });
			const rendered = invoke("renderSessionRows", view, 120, 40) as string[];
			const output = rendered.map(stripAnsi).join("\n");
			expect(output).toContain("Running (1)");
			expect(output).toContain("Idle (1)");
			expect(output).toContain("Inactive (1)");
			const runningRow = rendered.find((line) => stripAnsi(line).includes("busy"))!;
			const idleRow = rendered.find((line) => stripAnsi(line).includes("idle"))!;
			const inactiveRow = rendered.find((line) => stripAnsi(line).includes("archived session"))!;
			expect(runningRow).toContain(theme.bold("◇"));
			expect(idleRow).toContain(theme.bold(theme.fg("warning", "•")));
			expect(inactiveRow).toContain(theme.bold(theme.fg("dim", "•")));
			expect(stripAnsi(runningRow)).toMatch(/◇ busy/u);
			expect(stripAnsi(idleRow)).toMatch(/• idle/u);
			expect(stripAnsi(inactiveRow)).toMatch(/• archived session/u);
			expect(output).not.toContain("●");
			expect(output).not.toContain("✓");
		} finally {
			stopThemeWatcher();
		}
	});

	it("omits empty status categories and keeps feedback when no sessions match", () => {
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, { savedCatalogLoaded: true });
		const finish = vi.fn();
		Reflect.set(view, "finish", finish);
		const render = () => (invoke("renderSessionRows", view, 120, 20) as string[]).map(stripAnsi);
		const expectEmptyList = (message: string) => {
			expect(render()).toEqual([message]);
			expect(Reflect.get(view, "rows")).toEqual([]);
			invoke("moveSelection", view, 1);
			invoke("openSelected", view);
			expect(finish).not.toHaveBeenCalled();
		};
		try {
			invoke("reconcileCatalogs", view);
			expectEmptyList("No sessions yet.");
			Reflect.set(view, "lastListedSummaries", [summary({ sessionName: "Review changes" })]);
			invoke("reconcileCatalogs", view);
			expect(render()).not.toContain("Running (0)");
			expect(render()).toContain("Idle (1)");
			expect(render()).not.toContain("Inactive (0)");
			invoke("setSearchQuery", view, "unmatched-session");
			expectEmptyList("No sessions match your search.");
			invoke("setSearchQuery", view, "");
			invoke("moveSelection", view, 1);
			invoke("openSelected", view);
			expect(finish).toHaveBeenCalledWith(
				expect.objectContaining({ summary: expect.objectContaining({ sessionName: "Review changes" }) }),
			);
		} finally {
			stopThemeWatcher();
		}
	});

	it("always renders inactive sessions; search is the only filter", () => {
		const live = summary({ sessionName: "live" });
		const saved = summary({
			id: "saved",
			activeSessionId: undefined,
			sessionId: "saved-session",
			sessionName: "archive-match",
			sessionFile: "/tmp/saved.jsonl",
			rosterStatus: "inactive",
			lifecycle: "archived",
		});
		// The stale pre-removal collapse flag must be ignored.
		const persistentState = { savedCatalogLoaded: true, inactiveExpanded: false } as AgentsViewPersistentState;
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		const rows = () => Reflect.get(view, "rows") as AgentsViewRow[];
		const showsSaved = () => rows().some((row) => row.summary.sessionId === saved.sessionId);
		try {
			Reflect.set(view, "lastListedSummaries", [live]);
			Reflect.set(view, "savedSessions", [
				{
					path: saved.sessionFile!,
					id: saved.sessionId,
					cwd: saved.cwd,
					name: saved.sessionName,
					created: new Date(),
					modified: new Date(),
					messageCount: 1,
					firstMessage: "archive-match",
					allMessagesText: "archive-match",
				},
			]);
			invoke("reconcileCatalogs", view);
			expect(showsSaved()).toBe(true);
			// The removed Alt+I chord must not hide anything.
			view.handleInput("\x1bi");
			expect(showsSaved()).toBe(true);
			invoke("setSearchQuery", view, "no-such-session");
			expect(showsSaved()).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("opens a parent with Enter and reveals its spawn program only on request", () => {
		const parent = summary({ sessionName: "parent" });
		const child = summary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child-session",
			sessionFile: "/tmp/child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: parent.activeSessionId,
			spawnCode: 'await rlm("Inspect the code")',
		});
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		const rows = () => Reflect.get(view, "rows") as AgentsViewRow[];
		try {
			Reflect.set(view, "lastListedSummaries", [parent, child]);
			invoke("reconcileCatalogs", view);
			expect(rows().map((row) => row.kind)).toEqual(["agent"]);
			const finish = vi.fn();
			Reflect.set(view, "finish", finish);
			invoke("openSelected", view);
			expect(finish).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "open",
					summary: expect.objectContaining({ sessionId: parent.sessionId }),
				}),
			);
			invoke("cycleProgramForSelected", view);
			expect(rows().some((row) => row.kind === "subagent-code" && row.code === child.spawnCode)).toBe(true);
			expect(rows().some((row) => row.kind === "subagent" && row.summary.sessionId === child.sessionId)).toBe(true);
			expect(rows().some((row) => row.kind === "subagent-summary")).toBe(false);
			invoke("cycleProgramForSelected", view);
			expect(rows().some((row) => row.kind === "subagent-code")).toBe(false);
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps a selection at the end of the list visible when the leading ellipsis is shown", () => {
		const summaries = Array.from({ length: 12 }, (_, index) =>
			summary({
				id: `saved-${index}`,
				activeSessionId: undefined,
				sessionId: `saved-${index}-session`,
				sessionName: `saved-${index}`,
				sessionFile: `/tmp/saved-${index}.jsonl`,
				rosterStatus: "inactive" as const,
				created: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
			}),
		);
		const rows = buildAgentsViewRows(summaries);
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			Reflect.set(view, "rows", rows);
			Reflect.set(view, "selectedIndex", rows.length - 1);
			Reflect.set(view, "ui", { terminal: { rows: 13 }, requestRender: () => {} });
			const lines = (invoke("renderSessionRows", view, 120, 4) as string[]).map(stripAnsi);
			expect(lines[1]).toBe("");
			expect(lines[2]).toContain("...");
			expect(lines).toHaveLength(4);
			const lastTitle = rows.at(-1)!.title;
			expect(lines.some((line) => line.includes(lastTitle))).toBe(true);
			for (let maxRows = 1; maxRows <= 10; maxRows += 1) {
				for (let selectedIndex = 0; selectedIndex < rows.length; selectedIndex += 1) {
					Reflect.set(view, "selectedIndex", selectedIndex);
					const viewport = invoke("renderSessionRows", view, 120, maxRows) as string[];
					const selected = viewport.filter((line) => line.includes("\0agents-view-selected-row\0"));
					expect(viewport.length).toBeLessThanOrEqual(maxRows);
					expect(selected).toHaveLength(1);
					expect(selected[0]).toContain(rows[selectedIndex]!.title);
				}
			}
		} finally {
			stopThemeWatcher();
		}
	});

	it("strips provider prefixes from compact row model labels", () => {
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, { savedCatalogLoaded: true });
		try {
			Reflect.set(view, "lastListedSummaries", [
				summary({
					model: { ...getModel("openai", "gpt-4o"), provider: "prime-inference", id: "internal/glm-5.3-fast" },
					usage: { inputTokens: 100, outputTokens: 10, cost: 0.12 },
				}),
			]);
			invoke("reconcileCatalogs", view);
			const rows = (invoke("renderSessionRows", view, 120, 20) as string[]).map(stripAnsi).join("\n");
			expect(rows).toContain("glm-5.3-fast");
			expect(rows).not.toContain("internal/");
			expect(rows).not.toContain("prime-inference");
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps search to a quiet single row and reports nested depth in three metadata lines", () => {
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, { savedCatalogLoaded: true });
		try {
			Reflect.set(view, "lastListedSummaries", [summary({ sessionName: "Review changes" })]);
			invoke("reconcileCatalogs", view);
			const prompt = invoke("renderPrompt", view, 80) as string[];
			expect(prompt).toHaveLength(1);
			expect(stripAnsi(prompt[0]!)).toContain("Search sessions");
			expect(prompt[0]).not.toContain("\x1b[48;");
			const globalLines = (invoke("renderContent", view, 100, 40) as string[]).map(stripAnsi);
			const searchIndex = globalLines.findIndex((line) => line.includes("Search sessions"));
			expect(globalLines[searchIndex - 1]).toBe("");
			expect(globalLines[searchIndex - 2]!.trim()).not.toBe("");
			expect(globalLines[searchIndex + 1]).toBe("");
			expect(globalLines[searchIndex + 2]).toMatch(/Session\s+Model/);
			expect(globalLines.join("\n")).not.toContain("All sessions");
			expect(globalLines.join("\n")).not.toContain("back ·");
			expect(globalLines.filter((line) => /prime agent|agents \d|cwd /.test(line))).toHaveLength(3);
			expect(globalLines.join("\n")).toContain("cwd /tmp");
			expect(globalLines.join("\n")).not.toMatch(/depth\s+|model\s+/);
			for (let height = 1; height <= 6; height += 1) {
				const shortLines = (invoke("renderContent", view, 80, height) as string[]).map(stripAnsi);
				expect(shortLines.length).toBeLessThanOrEqual(height);
				expect(shortLines.join("\n")).toContain("Search sessions");
				if (height > 1) expect(shortLines.join("\n")).toContain("Review changes");
			}
			Reflect.set(view, "scopeRootSummary", summary({ sessionName: "Fix authentication", rlmDepth: 3 }));
			for (const width of [40, 100]) {
				const lines = (invoke("renderContent", view, width, 40) as string[]).map(stripAnsi);
				expect(lines.filter((line) => /prime agent|agents \d|depth /.test(line))).toHaveLength(3);
				expect(lines.join("\n")).toContain("depth 4");
				expect(lines.join("\n")).not.toMatch(/scope\s+|cwd\s+|model\s+/);
				if (width === 100) expect(lines.join("\n")).toContain("← back · Fix authentication › subagents");
			}
			Reflect.set(view, "scopeRootSummary", undefined);
			const restored = (invoke("renderContent", view, 100, 40) as string[]).map(stripAnsi).join("\n");
			expect(restored).toContain("cwd /tmp");
			expect(restored).not.toContain("depth ");
		} finally {
			stopThemeWatcher();
		}
	});

	it("keeps abandoned saved entries out of rows and section counts before, during, and after search", () => {
		const abandoned: AgentConnectionSavedSessionInfo = {
			path: "/tmp/abandoned.jsonl",
			id: "abandoned-session",
			cwd: "/tmp/project",
			created: new Date(0),
			modified: new Date(0),
			messageCount: 0,
			firstMessage: "(no messages)",
			allMessagesText: "",
		};
		const persistentState: AgentsViewPersistentState = { savedCatalogLoaded: true, savedSessions: [abandoned] };
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, persistentState);
		try {
			Reflect.set(view, "lastListedSummaries", [summary({ sessionName: "active", messageCount: 0 })]);
			invoke("reconcileCatalogs", view);
			const rowIds = () => (Reflect.get(view, "rows") as AgentsViewRow[]).map((row) => row.summary.sessionId);
			const expectNoAbandonedRows = () => {
				expect(rowIds()).not.toContain("abandoned-session");
				const rendered = (invoke("renderSessionRows", view, 120, 20) as string[]).map(stripAnsi).join("\n");
				expect(rendered).not.toContain("Inactive");
				expect(rendered).not.toContain("(no messages)");
				expect(invoke("getAgentCountsText", view)).toBe(`0 running, ${rowIds().length} idle, 0 inactive`);
			};
			expect(rowIds()).toEqual(["scope-session"]);
			expectNoAbandonedRows();
			for (const query of ["abandoned-session", "(no messages)", "project", "active"]) {
				invoke("setSearchQuery", view, query);
				expectNoAbandonedRows();
			}
			expect(rowIds()).toEqual(["scope-session"]);
			invoke("setSearchQuery", view, "");
			expect(rowIds()).toEqual(["scope-session"]);
			expectNoAbandonedRows();
			expect(persistentState.savedSessions).toEqual([abandoned]);
		} finally {
			stopThemeWatcher();
		}
	});

	it("shows running-subagent counts only while collapsed and work remains", () => {
		const parent = summary({ sessionName: "parent" });
		const child = summary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child-session",
			sessionFile: "/tmp/child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: parent.activeSessionId,
			activity: "working",
			isStreaming: true,
		});
		const secondChild = {
			...child,
			id: "child-2",
			activeSessionId: "child-2",
			sessionId: "child-session-2",
			sessionFile: "/tmp/child-2.jsonl",
		};
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		const rows = () => Reflect.get(view, "rows") as AgentsViewRow[];
		const lines = () => (invoke("renderSessionRows", view, 120, 20) as string[]).map(stripAnsi);
		try {
			Reflect.set(view, "lastListedSummaries", [parent, child, secondChild]);
			invoke("reconcileCatalogs", view);
			expect(rows()).toHaveLength(1);
			const collapsedRow = invoke("renderRow", view, rows()[0], 120) as string;
			expect(collapsedRow).not.toContain("▸");
			expect(collapsedRow).not.toContain("▾");
			const collapsed = lines();
			const parentIndex = collapsed.findIndex((line) => line.includes("parent"));
			expect(collapsed[parentIndex + 1]).toBe("  2 subagents running");
			invoke("moveSelection", view, 1);
			expect(Reflect.get(view, "selectedIndex")).toBe(0);
			view.handleInput("\x1b[1;3C");
			expect(rows().map((row) => row.kind)).toEqual(["agent", "subagent", "subagent"]);
			expect(lines().join("\n")).not.toContain("subagents running");
			const expandedRow = invoke("renderRow", view, rows()[0], 120) as string;
			expect(expandedRow).not.toContain("▸");
			expect(expandedRow).not.toContain("▾");
			view.handleInput("\x1b[1;3C");
			expect(rows()).toHaveLength(1);
			expect(lines()).toContain("  2 subagents running");
			const idleChild = { ...child, activity: "idle", isStreaming: false };
			Reflect.set(view, "lastListedSummaries", [parent, idleChild, secondChild]);
			invoke("reconcileCatalogs", view);
			expect(lines()).toContain("  1 subagent running");
			Reflect.set(view, "lastListedSummaries", [
				parent,
				idleChild,
				{ ...secondChild, activity: "idle", isStreaming: false },
			]);
			invoke("reconcileCatalogs", view);
			expect(lines().join("\n")).not.toMatch(/subagents? running/);
		} finally {
			stopThemeWatcher();
		}
	});

	it("dims a paused-only heartbeat badge and keeps active badges in the error color", () => {
		const job = (status: "active" | "paused") => ({
			job: {
				id: `${status}-job`,
				status,
				activeSessionId: "scope-active",
				sessionId: "scope-session",
				sessionFile: "/tmp/scope.jsonl",
				cwd: "/tmp",
				prompt: "tick",
				schedule: { kind: "interval" as const, expression: "5m" },
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				runCount: 0,
			},
		});
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});

		try {
			const [pausedRow] = buildAgentsViewRows(reconcileUnifiedSessions([summary()], [], [job("paused")]));
			Reflect.set(view, "rows", [pausedRow]);
			const pausedLine = invoke("renderRow", view, pausedRow, 160) as string;
			expect(pausedLine).toContain(theme.fg("dim", "♥ 1"));
			expect(pausedRow).toMatchObject({ section: "idle" });

			const [activeRow] = buildAgentsViewRows(reconcileUnifiedSessions([summary()], [], [job("active")]));
			Reflect.set(view, "rows", [activeRow]);
			const activeLine = invoke("renderRow", view, activeRow, 160) as string;
			expect(activeLine).toContain(theme.fg("error", "♥ 1"));
		} finally {
			stopThemeWatcher();
		}
	});

	it("warns about the armed heartbeat in the delete confirmation", () => {
		const view = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		Reflect.set(view, "deleteConfirmExpiresAt", Date.now() + 10_000);
		const confirmLine = (row: AgentsViewRow): string => {
			Reflect.set(view, "rows", [row]);
			Reflect.set(view, "pendingDeleteAgent", { identity: row.identity, summary: row.summary, stopped: false });
			return stripAnsi(invoke("renderRow", view, row, 160) as string);
		};

		try {
			const [armedRow] = buildAgentsViewRows([summary({ hasActiveHeartbeat: true })]);
			expect(confirmLine(armedRow!)).toContain("has an armed heartbeat — ");
			const [plainRow] = buildAgentsViewRows([summary()]);
			expect(confirmLine(plainRow!)).not.toContain("armed heartbeat");
			expect(confirmLine(plainRow!)).toContain("again to remove");
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
	it("treats only a previously loaded saved catalog as settled on mount", () => {
		const fresh = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, {});
		const loaded = new AgentsViewMode({ config: {}, uiServices: createUiServices() }, { savedCatalogLoaded: true });

		try {
			expect(Reflect.get(fresh, "savedCatalogReady")).toBe(false);
			expect(Reflect.get(loaded, "savedCatalogReady")).toBe(true);
		} finally {
			stopThemeWatcher();
		}
	});

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

describe("agents view startup notices", () => {
	it("combines the open fallback and cwd fallback without dropping either notice", () => {
		expect(combineAgentsViewStartupNotices("Child unavailable", "Original directory is missing")).toBe(
			"Child unavailable · Original directory is missing",
		);
		expect(combineAgentsViewStartupNotices("Child unavailable", undefined)).toBe("Child unavailable");
		expect(combineAgentsViewStartupNotices(undefined, "Original directory is missing")).toBe(
			"Original directory is missing",
		);
	});

	it("persists the combined open and cwd fallback notices after returning to agents view", async () => {
		const root = summary({
			activeSessionId: undefined,
			cwd: "/definitely/not/a/real/dir/for/this/test",
			lifecycle: "archived",
			sessionFile: "/tmp/root.jsonl",
		});
		let runs = 0;
		vi.spyOn(AgentsViewMode.prototype, "run").mockImplementation(async function (this: AgentsViewMode) {
			runs += 1;
			if (runs === 1) {
				return {
					type: "open",
					summary: root,
					hasChildren: false,
					statusMessage: "Child unavailable",
				};
			}
			expect(Reflect.get(this, "persistentState")).toMatchObject({
				statusMessage: `Child unavailable · Original directory is missing (${root.cwd}); opened in ${process.cwd()} instead.`,
			});
			return { type: "exit" };
		});
		modeMocks.clientRequest.mockResolvedValue({
			type: "response",
			command: "create",
			success: true,
			data: { ...root, cwd: process.cwd(), activeSessionId: "resumed-active", lifecycle: "live" },
		});
		modeMocks.interactiveRun.mockResolvedValue({
			type: "agents_view",
			source: {
				activeSessionId: "resumed-active",
				sessionId: root.sessionId,
				cwd: process.cwd(),
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
