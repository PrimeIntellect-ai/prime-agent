import stripAnsi from "strip-ansi";
import { describe, expect, test, vi } from "vitest";
import { AgentsViewMode } from "../../../src/modes/agents-view/agents-view-mode.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { initTheme } from "../../../src/modes/interactive/theme/theme.js";
import { createDeferred as deferred } from "../scheduling.js";

function summary(id: string): SessionSummary {
	return {
		id,
		activeSessionId: id,
		sessionId: `session-${id}`,
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
	};
}

function rawSavedSession(id: string) {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "/tmp/project",
		state: "idle",
		created: new Date(0).toISOString(),
		modified: new Date(0).toISOString(),
		messageCount: 1,
	};
}

function savedSession(id: string) {
	return { path: `/tmp/${id}.jsonl`, id };
}

function refreshHarness() {
	const applySessionList = vi.fn();
	const reconcileCatalogs = vi.fn();
	const persistentState: {
		savedSessions?: unknown[];
		lastSuccessfulSavedSessions?: unknown[];
		heartbeats?: unknown[];
		savedCatalogGeneration?: number;
	} = {};
	return {
		reconnectPromise: undefined,
		daemonShutdownReceived: false,
		options: {},
		liveCatalogGeneration: 0,
		savedCatalogGeneration: 0,
		heartbeatCatalogGeneration: 0,
		liveCatalogRefreshPending: false,
		savedCatalogRefreshPending: false,
		heartbeats: [] as unknown[],
		persistentState,
		applySessionList,
		reconcileCatalogs,
		resolveMissingSelectionAnchor: vi.fn(),
		setStatusMessage: vi.fn(),
		startClientReconnect: vi.fn(),
	};
}

function privateMethod<T>(name: string): T {
	const member = Reflect.get(AgentsViewMode.prototype, name) as T;
	if (typeof member !== "function") {
		throw new Error(`AgentsViewMode.${name} no longer exists; update this regression harness`);
	}
	return member;
}

describe("#502 unified session view regressions", () => {
	test.each(["live", "heartbeat"] as const)(
		"an older overlapping %s poll cannot overwrite the newer response",
		async (kind) => {
			const old = deferred<unknown>();
			const newer = kind === "live" ? summary("new") : { job: { id: "new" } };
			const client = {
				isConnected: true,
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				request: vi
					.fn()
					.mockReturnValueOnce(old.promise)
					.mockResolvedValueOnce({
						success: true,
						data: kind === "live" ? { sessions: [newer] } : { heartbeats: [newer] },
					}),
			};
			const harness = { ...refreshHarness(), requireClient: () => client };
			const refresh = privateMethod<(this: typeof harness) => Promise<unknown>>(
				kind === "live" ? "refreshSessions" : "refreshHeartbeats",
			);

			const oldPoll = refresh.call(harness);
			await refresh.call(harness);
			old.resolve({
				success: true,
				data: kind === "live" ? { sessions: [summary("old")] } : { heartbeats: [{ job: { id: "old" } }] },
			});
			await oldPoll;

			if (kind === "live") expect(harness.applySessionList).toHaveBeenCalledWith([newer], true);
			else expect(harness.heartbeats).toEqual([newer]);
			expect(kind === "live" ? harness.applySessionList : harness.reconcileCatalogs).toHaveBeenCalledOnce();
		},
	);

	test("overlapping saved scans retain the last complete catalog after the newest scan fails", async () => {
		const previous = [savedSession("previous")];
		const older = deferred<{ success: true; data: { sessions: unknown[] } }>();
		const client = {
			request: vi
				.fn()
				.mockReturnValueOnce(older.promise)
				.mockImplementationOnce(
					async (
						_command: unknown,
						_timeout: unknown,
						options: { onProgress: (update: { type: string; session: unknown }) => void },
					) => {
						options.onProgress({ type: "session_list_session", session: rawSavedSession("streamed") });
						throw new Error("scan failed");
					},
				),
		};
		const harness = {
			...refreshHarness(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;
		const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

		const oldScan = refresh.call(harness);
		await Promise.resolve();
		expect(await refresh.call(harness)).toBe(false);
		older.resolve({ success: true, data: { sessions: [rawSavedSession("stale")] } });
		expect(await oldScan).toBe(false);

		expect([harness.savedSessions, harness.persistentState.savedSessions]).toEqual([previous, previous]);
		expect(harness.savedCatalogRefreshPending).toBe(false);
	});

	test("reconnect retries the saved catalog and fences a stale startup scan", async () => {
		const previous = [savedSession("previous")];
		const startup = deferred<{ success: true; data: { sessions: unknown[] } }>();
		const retried = deferred<{ success: true; data: { sessions: unknown[] } }>();
		const replacement = savedSession("retried");
		const client = {
			request: vi.fn().mockReturnValueOnce(startup.promise).mockReturnValueOnce(retried.promise),
		};
		const harness = {
			...refreshHarness(),
			reconnectPromise: undefined as Promise<void> | undefined,
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;
		const refresh =
			privateMethod<
				(
					this: typeof harness,
					options?: { duringReconnect?: boolean; preserveStatusOnError?: boolean },
				) => Promise<boolean>
			>("refreshSavedSessions");

		harness.reconnectPromise = undefined;
		const startupScan = refresh.call(harness);
		harness.reconnectPromise = Promise.resolve();
		const retry = refresh.call(harness, { duringReconnect: true, preserveStatusOnError: true });
		expect(harness.savedCatalogGeneration).toBe(2);
		expect(harness.persistentState.savedCatalogGeneration).toBe(2);

		retried.resolve({ success: true, data: { sessions: [rawSavedSession("retried")] } });
		expect(await retry).toBe(true);
		startup.resolve({ success: true, data: { sessions: [rawSavedSession("stale")] } });
		expect(await startupScan).toBe(false);
		expect(harness.savedSessions).toEqual([expect.objectContaining({ path: replacement.path })]);
	});

	test("failed saved retry during reconnect preserves status and complete catalog", async () => {
		const previous = [savedSession("previous")];
		const client = {
			request: async (
				_command: unknown,
				_timeout: unknown,
				options: { onProgress: (update: { type: string; session: unknown }) => void },
			) => {
				options.onProgress({ type: "session_list_session", session: rawSavedSession("partial") });
				throw new Error("retry failed");
			},
		};
		const harness = {
			...refreshHarness(),
			reconnectPromise: Promise.resolve(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;

		const refreshed = await privateMethod<
			(
				this: typeof harness,
				options: { duringReconnect: boolean; preserveStatusOnError: boolean },
			) => Promise<boolean>
		>("refreshSavedSessions").call(harness, { duringReconnect: true, preserveStatusOnError: false });

		expect(refreshed).toBe(false);
		expect(harness.savedSessions).toEqual(previous);
		expect(harness.persistentState.savedSessions).toEqual(previous);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("reconnect stays active until the heartbeat catalog refresh succeeds", async () => {
		vi.useFakeTimers();
		try {
			const firstHeartbeatAttempt = deferred<void>();
			let heartbeatAttempts = 0;
			const client = {
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				reconnect: vi.fn(async () => {}),
				request: vi.fn(async (command: { type: string }) => {
					if (command.type === "list") return { success: true, data: { sessions: [summary("live")] } };
					heartbeatAttempts += 1;
					if (heartbeatAttempts === 1) {
						firstHeartbeatAttempt.resolve();
						throw new Error("heartbeat connection lost");
					}
					return { success: true, data: { heartbeats: [{ job: { id: "healthy" } }] } };
				}),
			};
			const harness = {
				...refreshHarness(),
				stopped: false,
				reconnectTimedOut: false,
				client,
				options: { reconnectTimeoutMs: 10_000 },
				requireClient: () => client,
				refreshSavedSessions: vi.fn(async () => true),
				refreshHeartbeats: vi.fn(async (_options?: { duringReconnect?: boolean }) => false),
				reconnectClient: vi.fn(async (_reconnectingClient: typeof client, _error: unknown) => {}),
			};
			const refreshHeartbeats =
				privateMethod<(this: typeof harness, options?: { duringReconnect?: boolean }) => Promise<boolean>>(
					"refreshHeartbeats",
				);
			const reconnectClient =
				privateMethod<(this: typeof harness, reconnectingClient: typeof client, error: unknown) => Promise<void>>(
					"reconnectClient",
				);
			harness.refreshHeartbeats.mockImplementation((options) => refreshHeartbeats.call(harness, options));
			harness.reconnectClient.mockImplementation((reconnectingClient, error) =>
				reconnectClient.call(harness, reconnectingClient, error),
			);

			privateMethod<(this: typeof harness, reconnectingClient: typeof client, error: unknown) => void>(
				"startClientReconnect",
			).call(harness, client, new Error("disconnected"));
			await firstHeartbeatAttempt.promise;
			await Promise.resolve();

			expect(harness.reconnectPromise).toBeDefined();
			expect(harness.applySessionList).not.toHaveBeenCalled();
			expect(harness.setStatusMessage).not.toHaveBeenCalledWith("Daemon reconnected", { render: false });
			expect(client.reconnect).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1_000);
			await harness.reconnectPromise;

			expect(client.reconnect).toHaveBeenCalledTimes(2);
			expect(harness.applySessionList).toHaveBeenCalledWith([summary("live")], true);
			expect(harness.heartbeats).toEqual([{ job: { id: "healthy" } }]);
			expect(harness.reconnectPromise).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test("a pending saved scan cannot overwrite daemon shutdown status", async () => {
		const scan = deferred<void>();
		const client = {
			request: async () => {
				await scan.promise;
				throw new Error("scan failed");
			},
		};
		const harness = {
			...refreshHarness(),
			savedSessions: [],
			lastSuccessfulSavedSessions: [],
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};

		const pending = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions").call(harness);
		harness.daemonShutdownReceived = true;
		scan.resolve();
		expect(await pending).toBe(false);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});

	test("a missing selection anchor blocks open only until both catalogs settle", () => {
		const finish = vi.fn();
		const fallback = summary("fallback");
		const harness = {
			selectionAnchorPending: true,
			liveCatalogRefreshPending: false,
			savedCatalogRefreshPending: true,
			selectedIndex: 0,
			selectedActiveSessionId: undefined as string | undefined,
			selectedRowIdentity: "identity-intended",
			rows: [{ selectable: true, kind: "agent", summary: fallback }],
			isPendingDeleteRow: () => false,
			setStatusMessage: vi.fn(),
			finish,
		};

		privateMethod<(this: typeof harness) => void>("openSelected").call(harness);
		expect(finish).not.toHaveBeenCalled();
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		expect(harness.selectionAnchorPending).toBe(true);
		harness.savedCatalogRefreshPending = false;
		privateMethod<(this: typeof harness) => void>("resolveMissingSelectionAnchor").call(harness);
		// Open unblocks on the visible fallback row...
		expect(harness.selectionAnchorPending).toBe(false);
		expect(harness.selectedActiveSessionId).toBe(fallback.activeSessionId ?? fallback.id);
		// ...but the restored anchor identity survives so a late poll can still re-anchor.
		expect(harness.selectedRowIdentity).toBe("identity-intended");
	});
	test("rename uses the captured row after refresh removes it", async () => {
		const captured = summary("captured");
		const request = vi.fn(async () => ({ success: true, data: {} }));
		const harness = {
			renameTarget: { activeSessionId: captured.activeSessionId, summary: captured },
			rows: [],
			exitRenameMode: vi.fn(),
			setStatusMessage: vi.fn(),
			refreshBothCatalogs: vi.fn(async () => true),
			requireClient: () => ({ request }),
			renameSession: Reflect.get(AgentsViewMode.prototype, "renameSession"),
		};

		await privateMethod<(this: typeof harness, value: string) => Promise<void>>("confirmRename").call(
			harness,
			"Renamed",
		);

		expect(request).toHaveBeenCalledWith({
			type: "rename",
			activeSessionId: captured.activeSessionId,
			name: "Renamed",
		});
	});

	test("saved-only delete confirmation remains in the inactive catalog", () => {
		const savedOnly = { ...summary("saved"), lifecycle: "archived" as const, activeSessionId: undefined };
		const harness = {
			pendingDeleteAgent: { identity: "saved", summary: savedOnly, stopped: false },
			isDeleteConfirmationVisible: () => true,
		};

		expect(
			privateMethod<(this: typeof harness, sessions: SessionSummary[]) => SessionSummary[]>(
				"withPendingDeleteSession",
			).call(harness, []),
		).toEqual([]);
	});

	test("slow live polls are coalesced instead of repeatedly superseded", async () => {
		const slow = deferred<boolean>();
		const refreshSessions = vi.fn(() => slow.promise);
		const harness = { liveCatalogPollPromise: undefined, refreshSessions };
		const poll = privateMethod<(this: typeof harness) => void>("pollSessions");

		poll.call(harness);
		poll.call(harness);
		expect(refreshSessions).toHaveBeenCalledOnce();
		slow.resolve(true);
		await slow.promise;
		await Promise.resolve();
		poll.call(harness);
		expect(refreshSessions).toHaveBeenCalledTimes(2);
	});

	test.each([
		{ mode: "search", prompt: ["prompt top", "prompt input", "prompt bottom"] },
		{ mode: "reply", prompt: ["prompt top", "reply header", "reply gap", "prompt input", "prompt bottom"] },
	])("short content reserves the $mode editor and a session row ahead of startup chrome", ({ prompt }) => {
		const renderSessionRows = vi.fn(() => ["session row"]);
		const harness = {
			splash: { render: () => Array.from({ length: 8 }, () => "splash") },
			renderStartupNotices: () => Array.from({ length: 8 }, () => "notice"),
			renderPrompt: () => prompt,
			renderSessionRows,
		};
		const height = prompt.length + 2;

		const lines = privateMethod<(this: typeof harness, width: number, height: number) => string[]>(
			"renderContent",
		).call(harness, 80, height);

		expect(lines).toHaveLength(height);
		expect(lines).toEqual(expect.arrayContaining([...prompt, "session row"]));
		expect(renderSessionRows).toHaveBeenCalledWith(80, 1);
	});

	test.each(["reply", "rename"] as const)("%s refresh keeps the captured search filter", (mode) => {
		const harness = {
			replyTarget: mode === "reply" ? { key: "active", summary: {} } : undefined,
			renameTarget: mode === "rename" ? { identity: "target" } : undefined,
			actionModeSearchQuery: "needle",
			editor: { getText: () => "action editor text" },
			scopedRecords: [
				{ identity: "match", identityAliases: [], section: "idle", searchableText: "needle session" },
				{ identity: "other", identityAliases: [], section: "idle", searchableText: "other session" },
			],
		};

		const filtered =
			privateMethod<(this: typeof harness) => Array<{ identity: string }>>("getFilteredRecords").call(harness);
		expect(filtered.map((record) => record.identity)).toEqual(["match"]);
	});

	test("inactive rows give message count and age their full responsive cell", () => {
		const inactive = {
			kind: "agent" as const,
			section: "inactive" as const,
			summary: {
				...summary("archived"),
				activeSessionId: undefined,
				lifecycle: "archived" as const,
				messageCount: 123456,
				modified: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
			},
			title: "archived",
			subtitle: "",
			statusLabel: "inactive",
			depth: 0,
			selectable: true,
			runningSubagentCount: 0,
			identity: "archived",
		};
		const harness = {
			rows: [inactive],
			selectedIndex: 0,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "x",
			formatRowIcon: (_section: string, icon: string) => icon,
		};

		const rendered = stripAnsi(
			privateMethod<(this: typeof harness, row: typeof inactive, width: number) => string>("renderRow").call(
				harness,
				inactive,
				50,
			),
		);
		expect(rendered).toMatch(/123456 · 2h\s*$/);
	});

	test("scoped subagent rows keep model and effort ahead of summaries", () => {
		initTheme("dark");
		const subagent = {
			// Direct children in a scoped Agents View render as agent rows while
			// retaining their persisted subagent runtime kind.
			kind: "agent" as const,
			section: "idle" as const,
			summary: {
				...summary("effort-child"),
				runtimeKind: "subagent" as const,
				summary: "Investigate a variable background status that can be truncated",
				model: { provider: "prime-inference", id: "gpt-5.6-terra" } as SessionSummary["model"],
				thinkingLevel: "high" as SessionSummary["thinkingLevel"],
			} as SessionSummary,
			title: "Inspect agents view",
			subtitle: "",
			statusLabel: "idle",
			depth: 1,
			selectable: true,
			runningSubagentCount: 0,
			identity: "effort-child",
			parentIdentity: "parent",
		};
		const harness = {
			rows: [subagent],
			selectedIndex: -1,
			isPendingDeleteRow: () => false,
			isPendingKillSubagentRow: () => false,
			getRowIcon: () => "·",
			formatRowIcon: (_section: string, icon: string) => icon,
		};
		const render = (width: number) =>
			stripAnsi(
				privateMethod<(this: typeof harness, row: typeof subagent, width: number) => string>("renderRow").call(
					harness,
					subagent,
					width,
				),
			);

		const full = render(120);
		expect(full).toContain(
			"Inspect agents view · prime-inference/gpt-5.6-terra:high · Investigate a variable background status",
		);
		const narrow = render(75);
		expect(narrow).toContain("prime-inference/gpt-5.6-terra:high");
		expect(narrow).not.toContain("Investigate a variable background status");

		subagent.summary.summary = "";
		expect(render(100)).toContain("Inspect agents view · prime-inference/gpt-5.6-terra:high");

		// Older daemons identify subagents through persisted linkage instead of runtimeKind.
		subagent.summary.runtimeKind = undefined;
		subagent.summary.rlmChildId = "effort-child";
		expect(render(100)).toContain("Inspect agents view · prime-inference/gpt-5.6-terra:high");

		subagent.summary.thinkingLevel = "off";
		subagent.summary.summary = "A later summary";
		expect(render(100)).toContain("Inspect agents view · prime-inference/gpt-5.6-terra · A later summary");
		expect(render(100)).not.toContain(":off");

		expect(render(20)).toHaveLength(20);
	});
});
