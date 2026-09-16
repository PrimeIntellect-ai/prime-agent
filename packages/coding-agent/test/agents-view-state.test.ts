import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import {
	AgentsViewMode,
	createAgentsViewListCommand,
	createAgentsViewResumeConfig,
	createInitialAgentsViewPersistentState,
	createInitialAgentsViewScopeFrames,
	createScopeBackReturnChatOpenResult,
	resolveAgentsViewActiveSummaryForPath,
	resolveAgentsViewOpenCwd,
	resolveAgentsViewSessionUiServices,
	shouldReconnectAgentsViewDaemon,
} from "../src/modes/agents-view/agents-view-mode.js";
import {
	filterEmptyAgentsViewSessions,
	getAgentsViewSummaryIdentity,
	summaryForUnifiedRecord,
} from "../src/modes/agents-view/agents-view-state.js";
import * as agentRoster from "../src/modes/daemon/agent-roster.js";
import {
	type AgentsViewScopeFrame,
	aggregateSessionHeartbeats,
	buildAgentsViewRows,
	buildUnifiedSessionIndex,
	classifyAgentsViewSession,
	computeRecursiveRollups,
	createUnattachableChildOpenResult,
	filterUnifiedSessions,
	formatHeartbeatBadge,
	getAgentsViewSelectionKey,
	getUnifiedSessionAncestorSessionIds,
	hasUnifiedSessionChildren,
	reconcileUnifiedSessions,
	resolveAgentsViewLeftResult,
	resolveAgentsViewScopeFrames,
	resolveAgentsViewSelectionIndex,
	resolveAgentsViewSelectionState,
	type SessionSummary,
	scopeToSessionSubtree,
	sectionTitle,
	shouldApplyScopeResolution,
	shouldShowAgentsViewSession,
	transitionAgentsViewScope,
} from "../src/modes/index.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";
import * as paths from "../src/utils/paths.js";
import { createDeferred } from "./suite/scheduling.js";

function heartbeat(id: string, nextRunAt?: string, activeSessionId = "child", status: "active" | "paused" = "active") {
	return {
		job: {
			id,
			status,
			activeSessionId,
			sessionId: `${activeSessionId}-session`,
			sessionFile: `/tmp/${activeSessionId}.jsonl`,
			cwd: "/tmp",
			prompt: "tick",
			schedule: { kind: "interval" as const, expression: "5m" },
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T00:00:00Z",
			...(nextRunAt ? { nextRunAt } : {}),
			runCount: 0,
		},
	};
}

describe("agents view state", () => {
	describe("session identity caches", () => {
		let root: string;

		beforeEach(() => {
			root = mkdtempSync(join(tmpdir(), "agents-view-path-cache-"));
		});

		afterEach(() => {
			vi.restoreAllMocks();
			rmSync(root, { recursive: true, force: true });
		});

		test("reuses successful canonical paths across reconciliation and row construction", () => {
			const real = join(root, "session.jsonl");
			const alias = join(root, "alias.jsonl");
			writeFileSync(real, "");
			symlinkSync(real, alias);
			const canonicalize = vi.spyOn(paths, "canonicalizePath");
			const saved = makeSessionInfo({ id: "cached", path: alias });
			const identity = `file:${realpathSync(real)}`;

			for (let rebuild = 0; rebuild < 3; rebuild++) {
				const records = reconcileUnifiedSessions([], [saved]);
				expect(records[0]?.identity).toBe(identity);
				expect(buildAgentsViewRows(records)[0]?.identity).toBe(identity);
			}
			expect(canonicalize.mock.calls).toEqual([[alias], [realpathSync(real)]]);
		});

		test("caches raw-path fallbacks for missing files", () => {
			const missing = join(root, "missing.jsonl");
			const canonicalize = vi.spyOn(paths, "canonicalizePath");
			const summary = makeSummary({ sessionFile: missing });

			for (let lookup = 0; lookup < 3; lookup++) {
				expect(getAgentsViewSummaryIdentity(summary)).toBe(`file:${resolve(missing)}`);
			}
			expect(canonicalize).toHaveBeenCalledExactlyOnceWith(missing);
			expect(canonicalize).toHaveReturnedWith(missing);
		});

		test.each(["missing", "symlink"] as const)("refreshes a cached %s after a fixed one-minute TTL", (kind) => {
			const first = join(root, "first.jsonl");
			const second = join(root, "second.jsonl");
			const alias = join(root, "alias.jsonl");
			writeFileSync(first, "");
			writeFileSync(second, "");
			if (kind === "symlink") symlinkSync(first, alias);
			const initialIdentity = `file:${kind === "symlink" ? realpathSync(first) : resolve(alias)}`;
			const summary = makeSummary({ sessionFile: alias });
			const start = Date.now();
			const now = vi.spyOn(Date, "now").mockReturnValue(start);
			const canonicalize = vi.spyOn(paths, "canonicalizePath");

			expect(getAgentsViewSummaryIdentity(summary)).toBe(initialIdentity);
			if (kind === "symlink") rmSync(alias);
			symlinkSync(second, alias);
			now.mockReturnValue(start + 59_999);
			expect(getAgentsViewSummaryIdentity(summary)).toBe(initialIdentity);
			expect(canonicalize).toHaveBeenCalledTimes(1);

			now.mockReturnValue(start + 60_000);
			expect(getAgentsViewSummaryIdentity(summary)).toBe(`file:${realpathSync(second)}`);
			expect(canonicalize).toHaveBeenCalledTimes(2);
		});

		test.each(["path", "roster"] as const)("evicts the least recently used %s identity at 4096 entries", (kind) => {
			vi.spyOn(Date, "now").mockReturnValue(Date.now());
			const compute =
				kind === "path"
					? vi.spyOn(paths, "canonicalizePath").mockImplementation((path) => path)
					: vi.spyOn(agentRoster, "rosterAgentIdForSummary").mockImplementation((summary) => summary.rlmChildId!);
			const createSummary = (id: string): SessionSummary =>
				makeSummary({
					sessionFile: join(root, `${id}.jsonl`),
					parentSessionPath: join(root, "parent.jsonl"),
					runtimeKind: kind === "roster" ? "subagent" : undefined,
					rlmChildId: id,
				});
			const summaries = Array.from({ length: 4096 }, (_, index) => createSummary(String(index)));
			for (const summary of summaries) getAgentsViewSummaryIdentity(summary);
			expect(compute).toHaveBeenCalledTimes(4096);

			getAgentsViewSummaryIdentity(summaries[0]!);
			expect(compute).toHaveBeenCalledTimes(4096);
			getAgentsViewSummaryIdentity(createSummary("overflow"));
			expect(compute).toHaveBeenCalledTimes(4097);
			getAgentsViewSummaryIdentity(summaries[0]!);
			expect(compute).toHaveBeenCalledTimes(4097);
			getAgentsViewSummaryIdentity(summaries[1]!);
			expect(compute).toHaveBeenCalledTimes(4098);
			expect(compute).toHaveBeenLastCalledWith(kind === "path" ? summaries[1]!.sessionFile : summaries[1]);
		});

		test.each(["symlink", "missing-file", "missing-directory", "active-parent", "no-parent"] as const)(
			"caches roster IDs with %s ancestry without changing their identity",
			(kind) => {
				const realDirectory = join(root, "real");
				const aliasDirectory = join(root, "alias");
				mkdirSync(realDirectory);
				symlinkSync(realDirectory, aliasDirectory, "dir");
				const parentPath = join(aliasDirectory, "parent.jsonl");
				if (kind === "symlink") writeFileSync(parentPath, "");
				const summary = makeSummary({
					runtimeKind: "subagent",
					rlmChildId: "cached-child",
					parentSessionPath:
						kind === "active-parent" || kind === "no-parent"
							? undefined
							: kind === "missing-directory"
								? join(root, "missing", "parent.jsonl")
								: parentPath,
					parentActiveSessionId: kind === "no-parent" ? undefined : "active-parent",
				});
				const originalRosterId = agentRoster.rosterAgentIdForSummary;
				const identity = `agent:${originalRosterId(summary)}`;
				const rosterId = vi.spyOn(agentRoster, "rosterAgentIdForSummary");

				for (let rebuild = 0; rebuild < 3; rebuild++) {
					expect(getAgentsViewSummaryIdentity({ ...summary })).toBe(identity);
					const records = reconcileUnifiedSessions([{ ...summary }], []);
					expect(records[0]?.identity).toBe(identity);
					expect(buildAgentsViewRows(records)[0]?.identity).toBe(identity);
				}
				expect(rosterId).toHaveBeenCalledExactlyOnceWith(summary);
				const otherChild = { ...summary, rlmChildId: "other-child" };
				expect(getAgentsViewSummaryIdentity(otherChild)).toBe(`agent:${originalRosterId(otherChild)}`);
				expect(rosterId).toHaveBeenCalledTimes(2);
			},
		);

		test("refreshes cached roster IDs after their parent symlink changes and the TTL expires", () => {
			const first = join(root, "first.jsonl");
			const second = join(root, "second.jsonl");
			const alias = join(root, "alias.jsonl");
			writeFileSync(first, "");
			writeFileSync(second, "");
			symlinkSync(first, alias);
			const summary = makeSummary({ runtimeKind: "subagent", rlmChildId: "child", parentSessionPath: alias });
			const start = Date.now();
			const now = vi.spyOn(Date, "now").mockReturnValue(start);
			const originalRosterId = agentRoster.rosterAgentIdForSummary;
			const identity = `agent:${originalRosterId(summary)}`;
			const rosterId = vi.spyOn(agentRoster, "rosterAgentIdForSummary");

			expect(getAgentsViewSummaryIdentity(summary)).toBe(identity);
			rmSync(alias);
			symlinkSync(second, alias);
			now.mockReturnValue(start + 59_999);
			expect(getAgentsViewSummaryIdentity(summary)).toBe(identity);
			expect(rosterId).toHaveBeenCalledTimes(1);

			now.mockReturnValue(start + 60_000);
			expect(getAgentsViewSummaryIdentity(summary)).toBe(`agent:${originalRosterId(summary)}`);
			expect(rosterId).toHaveBeenCalledTimes(2);
		});

		test("keeps relative parent roster IDs separate when the working directory changes", () => {
			const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
			const summary = makeSummary({
				runtimeKind: "subagent",
				rlmChildId: "relative-child",
				parentSessionPath: "parent.jsonl",
			});
			const originalRosterId = agentRoster.rosterAgentIdForSummary;
			const identity = `agent:${originalRosterId(summary)}`;
			const rosterId = vi.spyOn(agentRoster, "rosterAgentIdForSummary");

			expect(getAgentsViewSummaryIdentity(summary)).toBe(identity);
			cwd.mockReturnValue(join(root, "other"));
			expect(getAgentsViewSummaryIdentity(summary)).toBe(`agent:${originalRosterId(summary)}`);
			cwd.mockReturnValue(root);
			expect(getAgentsViewSummaryIdentity(summary)).toBe(identity);
			expect(rosterId).toHaveBeenCalledTimes(2);
		});

		test("keeps relative path entries separate when the working directory changes", () => {
			const cwd = vi.spyOn(process, "cwd").mockReturnValue(root);
			const canonicalize = vi.spyOn(paths, "canonicalizePath").mockImplementation((path) => resolve(path));
			const summary = makeSummary({ sessionFile: "relative-session.jsonl" });

			expect(getAgentsViewSummaryIdentity(summary)).toBe(`file:${join(root, "relative-session.jsonl")}`);
			cwd.mockReturnValue(join(root, "other"));
			expect(getAgentsViewSummaryIdentity(summary)).toBe(`file:${join(root, "other", "relative-session.jsonl")}`);
			cwd.mockReturnValue(root);
			expect(getAgentsViewSummaryIdentity(summary)).toBe(`file:${join(root, "relative-session.jsonl")}`);
			expect(canonicalize).toHaveBeenCalledTimes(2);
		});
	});

	test("classifies a saved orphan with rlmDepth > 0 as a subagent", () => {
		const saved = {
			path: "/tmp/sessions/child.jsonl",
			id: "child",
			cwd: "/tmp",
			rlmDepth: 2,
			created: new Date(0),
			modified: new Date(0),
			messageCount: 1,
			firstMessage: "",
			allMessagesText: "",
		};
		const summary = summaryForUnifiedRecord({
			saved,
			identity: "child",
			identityAliases: [],
			section: "archived",
			searchableText: "",
		} as never);
		// The parent edge can be reconciliation-dropped while the depth survives;
		// a depth > 0 session must never be presented as top-level.
		expect(summary.runtimeKind).toBe("subagent");
	});

	// Classification is driven by live runtime status, never by completion verdicts.
	// [name, summary overrides, expected section]
	test.each([
		["a streaming session", { isStreaming: true, activity: "working" }, "running"],
		[
			"a session with queued actions",
			{ sessionActions: { queuedCount: 1, steering: [], followUps: [] }, activity: "working" },
			"running",
		],
		["a working session", { activity: "working" }, "running"],
		[
			"a working subagent at depth",
			{ runtimeKind: "subagent", rlmDepth: 3, activity: "working", isSessionActive: true },
			"running",
		],
		// Working is heuristic and ignores taskState; secondary verdicts add no sections.
		[
			"a working session with a completed verdict",
			{ isStreaming: true, activity: "working", taskState: "completed" },
			"running",
		],
		["a working session with an armed heartbeat", { activity: "working", hasActiveHeartbeat: true }, "running"],
		["an idle session", { activity: "idle", messageCount: 2 }, "idle"],
		["an idle subagent", { runtimeKind: "subagent", activity: "idle" }, "idle"],
		["an idle session needing input", { activity: "idle", taskState: "needs_input" }, "idle"],
		["an idle completed session", { activity: "idle", taskState: "completed" }, "idle"],
		// A slow, failed, or absent classification never lingers in Working.
		["an idle session with no verdict", { activity: "idle", taskState: undefined }, "idle"],
		[
			"an idle session between heartbeat firings",
			{ activity: "idle", taskState: "completed", hasActiveHeartbeat: true },
			"idle",
		],
		[
			"a subagent whose runtime is gone",
			{
				activeSessionId: undefined,
				runtimeKind: "subagent",
				rlmDepth: 3,
				activity: "working",
				isSessionActive: true,
				hasActiveHeartbeat: true,
			},
			"inactive",
		],
	] as const)("classifies %s as %s", (_name, overrides, section) => {
		expect(classifyAgentsViewSession(makeSummary(overrides as Partial<SessionSummary>))).toBe(section);
	});

	test("labels rows by real work rather than by an armed heartbeat", () => {
		const [row] = buildAgentsViewRows([makeSummary({ activity: "idle", hasActiveHeartbeat: true })]);
		expect(row).toMatchObject({ section: "idle", statusLabel: "heartbeat active" });
		const [busyRow] = buildAgentsViewRows([
			makeSummary({ activity: "working", hasActiveHeartbeat: true, isStreaming: true, isRunningTools: true }),
		]);
		expect(busyRow).toMatchObject({ section: "running", statusLabel: "running tools" });
		expect(sectionTitle("idle")).toBe("Idle");
	});

	// Row order is section-first, then recency, with deterministic tie-breaks.
	// [name, summaries, expected session ids, expected sections]
	const orderingRow = (id: string, overrides: Partial<SessionSummary> = {}) =>
		makeSummary({ id, activeSessionId: id, sessionId: id, sessionName: id, ...overrides });
	const workingNow = { activity: "working" as const, isStreaming: true };
	const completedIdle = { activity: "idle" as const, taskState: "completed" as const, messageCount: 2 };
	const inactive = { activeSessionId: undefined };

	test.each([
		[
			"by section, then creation time",
			[
				orderingRow("completed", { ...completedIdle, created: "2026-01-03T00:00:00Z" }),
				orderingRow("older working", { ...workingNow, created: "2026-01-01T00:00:00Z" }),
				orderingRow("newer working", { ...workingNow, created: "2026-01-02T00:00:00Z" }),
				orderingRow("heartbeat", {
					activity: "idle",
					hasActiveHeartbeat: true,
					modified: "2026-01-03T00:00:00Z",
				}),
			],
			["newer working", "older working", "completed", "heartbeat"],
			["running", "running", "idle", "idle"],
		],
		[
			"by last message activity within Idle, newest first",
			[
				orderingRow("created-newest", {
					activity: "idle",
					created: "2026-01-03T00:00:00Z",
					lastActivityAt: "2026-01-01T00:00:00Z",
				}),
				orderingRow("middle", {
					activity: "idle",
					created: "2026-01-02T00:00:00Z",
					lastActivityAt: "2026-01-02T00:00:00Z",
				}),
				orderingRow("active-newest", {
					activity: "idle",
					created: "2026-01-01T00:00:00Z",
					lastActivityAt: "2026-01-03T00:00:00Z",
				}),
				orderingRow("running-oldest", {
					...workingNow,
					created: "2025-12-31T00:00:00Z",
					lastActivityAt: "2025-12-31T00:00:00Z",
				}),
			],
			["running-oldest", "active-newest", "middle", "created-newest"],
			["running", "idle", "idle", "idle"],
		],
		[
			"with armed heartbeats first inside Inactive",
			[
				orderingRow("recent", { ...inactive, lastActivityAt: "2026-01-03T00:00:00Z" }),
				orderingRow("beating", { ...inactive, hasActiveHeartbeat: true, lastActivityAt: "2026-01-01T00:00:00Z" }),
			],
			["beating", "recent"],
			["inactive", "inactive"],
		],
		[
			"by name then session id when creation times are missing",
			[
				orderingRow("beta-2", { sessionName: "beta", modified: "2026-01-03T00:00:00Z" }),
				orderingRow("alpha", { sessionName: "alpha", modified: "2026-01-02T00:00:00Z" }),
				orderingRow("beta-1", { sessionName: "beta", modified: "2026-01-01T00:00:00Z" }),
			],
			["alpha", "beta-1", "beta-2"],
			undefined,
		],
	])("sorts rows %s", (_name, summaries, expectedIds, expectedSections) => {
		const rows = buildAgentsViewRows(summaries);

		expect(rows.map((row) => row.summary.sessionId)).toEqual(expectedIds);
		if (expectedSections) expect(rows.map((row) => row.section)).toEqual(expectedSections);
	});

	test("keeps row order stable when activity and modification times and daemon input order change", () => {
		const older = orderingRow("older", {
			activity: "working",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-04T00:00:00Z",
			lastActivityAt: "2026-01-04T00:00:00Z",
		});
		const newer = orderingRow("newer", {
			activity: "working",
			created: "2026-01-02T00:00:00Z",
			modified: "2026-01-03T00:00:00Z",
			lastActivityAt: "2026-01-03T00:00:00Z",
		});

		const initialOrder = buildAgentsViewRows([older, newer]).map((row) => row.summary.sessionId);
		const refreshedOrder = buildAgentsViewRows([
			{ ...newer, modified: "2026-01-05T00:00:00Z", lastActivityAt: "2026-01-05T00:00:00Z" },
			{ ...older, modified: "2026-01-06T00:00:00Z", lastActivityAt: "2026-01-06T00:00:00Z" },
		]).map((row) => row.summary.sessionId);

		expect(initialOrder).toEqual(["newer", "older"]);
		expect(refreshedOrder).toEqual(initialOrder);
	});

	test("demotes empty sessions to the bottom of their section except the entered-from anchor", () => {
		const empty = orderingRow("empty", { ...inactive, messageCount: 0, lastActivityAt: "2026-01-04T00:00:00Z" });
		const anchor = orderingRow("anchor", { ...inactive, messageCount: 0, lastActivityAt: "2026-01-03T00:00:00Z" });
		const older = orderingRow("older", { ...inactive, messageCount: 3, lastActivityAt: "2026-01-02T00:00:00Z" });

		// The entered-from session keeps its recency slot even while empty.
		const anchored = buildAgentsViewRows(
			[empty, anchor, older],
			new Set(),
			new Set(),
			undefined,
			undefined,
			"anchor",
		);
		expect(anchored.map((row) => row.summary.sessionId)).toEqual(["anchor", "older", "empty"]);

		// Entered from elsewhere, every empty session sinks below non-empty ones.
		const unanchored = buildAgentsViewRows([empty, anchor, older]);
		expect(unanchored.map((row) => row.summary.sessionId)).toEqual(["older", "empty", "anchor"]);
	});

	test("summarizes subagents on their parent and omits subagent rows", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "second-child-active",
				activeSessionId: "second-child-active",
				sessionId: "second-child-session",
				sessionName: "Second child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				hasActiveHeartbeat: true,
				activity: "working",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				parentSessionId: "parent-session",
				activity: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind])).toEqual([
			["Parent", "agent"],
			["2 subagents running · 1 heartbeat active", "subagent-summary"],
			["Other", "agent"],
		]);
		expect(rows.map((row) => row.runningSubagentCount)).toEqual([2, 2, 0]);
		expect(rows.map((row) => row.depth)).toEqual([0, 1, 0]);
		expect(rows.map((row) => row.selectable)).toEqual([true, true, true]);
		expect(rows[1]?.parentIdentity).toBe(rows[0]?.identity);
		expect(rows[1]?.identity).not.toBe(rows[0]?.identity);
	});

	// Rollups walk the whole ancestor chain: a busy descendant raises the running tally on
	// every idle ancestor without promoting it out of Idle, and heartbeat-armed descendants
	// never count as busy.
	// [name, leaf state, chain depth, expected running tally, root summary, nested summary, leaf status label]
	test.each([
		[
			"a retained heartbeat one level down",
			"heartbeat",
			1,
			0,
			"1 subagent · 1 heartbeat active",
			"1 subagent · 1 heartbeat active",
			"heartbeat active",
		],
		["a busy grandchild", "working", 2, 1, "1 subagent running", "1 subagent running", undefined],
		[
			"a heartbeat-armed grandchild",
			"heartbeat",
			2,
			0,
			"1 subagent",
			"1 subagent · 1 heartbeat active",
			"heartbeat active",
		],
	] as const)(
		"rolls up %s onto every idle ancestor",
		(_name, leafState, depth, running, rootTitle, nestedTitle, leafLabel) => {
			const idleAncestor = (id: string, parent?: string) =>
				makeSummary({
					id,
					activeSessionId: id,
					sessionId: `${id}-session`,
					sessionName: id,
					activity: "idle",
					taskState: "completed",
					messageCount: 2,
					...(parent ? { runtimeKind: "subagent" as const, parentActiveSessionId: parent } : {}),
				});
			const ancestors = depth === 2 ? ["root", "child"] : ["root"];
			const summaries = [
				idleAncestor("root"),
				...(depth === 2 ? [idleAncestor("child", "root")] : []),
				makeSummary({
					id: "leaf",
					activeSessionId: "leaf",
					sessionId: "leaf-session",
					sessionName: "leaf",
					runtimeKind: "subagent",
					parentActiveSessionId: ancestors[ancestors.length - 1]!,
					...(leafState === "working"
						? { activity: "working" as const, isSessionActive: true, isStreaming: true }
						: { hasActiveHeartbeat: true, activity: "idle" as const, taskState: "completed" as const }),
				}),
			];

			const collapsed = buildAgentsViewRows(summaries);
			expect(collapsed[0]).toMatchObject({ kind: "agent", section: "idle", runningSubagentCount: running });
			expect(collapsed[0]?.statusLabel).toBe("completed");

			// Expanding each ancestor in turn keeps every level idle and exposes the
			// user-visible summary carrying the same recursive tally.
			const expandedIdentities = new Set<string>();
			let rows = collapsed;
			for (const [index, ancestor] of ancestors.entries()) {
				const row = rows.find((candidate) => candidate.title === ancestor);
				expect(row).toMatchObject({ section: "idle", statusLabel: "completed", runningSubagentCount: running });
				expect(
					rows.find(
						(candidate) => candidate.kind === "subagent-summary" && candidate.parentIdentity === row?.identity,
					),
				).toMatchObject({
					section: "idle",
					title: index === 0 ? rootTitle : nestedTitle,
					runningSubagentCount: running,
				});
				expandedIdentities.add(row?.identity ?? "");
				rows = buildAgentsViewRows(summaries, expandedIdentities);
				expect(
					rows.find(
						(candidate) => candidate.kind === "subagent-summary" && candidate.parentIdentity === row?.identity,
					),
				).toMatchObject({ expanded: true });
			}
			// Only the leaf itself is busy; its ancestors stay in Idle.
			const leaf = rows.find((row) => row.title === "leaf");
			expect(leaf).toMatchObject({ kind: "subagent", section: leafState === "working" ? "running" : "idle" });
			if (leafLabel) expect(leaf?.statusLabel).toBe(leafLabel);
			else expect(leaf?.statusLabel).not.toBe("heartbeat active");
		},
	);

	test("keeps the recursive total complete when search filters out a descendant", () => {
		const parent = makeSummary({
			id: "parent-active",
			activeSessionId: "parent-active",
			sessionId: "parent-session",
			sessionName: "Searchable parent",
			usage: { inputTokens: 100, outputTokens: 10, cost: 0.42 },
		});
		const child = makeSummary({
			id: "child-active",
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionName: "unrelated worker",
			runtimeKind: "subagent",
			parentActiveSessionId: "parent-active",
			usage: { inputTokens: 50, outputTokens: 5, cost: 0.68 },
		});
		const grandchild = makeSummary({
			id: "grandchild-active",
			activeSessionId: "grandchild-active",
			sessionId: "grandchild-session",
			sessionName: "unrelated nested worker",
			runtimeKind: "subagent",
			parentActiveSessionId: "child-active",
			usage: { inputTokens: 20, outputTokens: 2, cost: 0.18 },
		});
		const records = reconcileUnifiedSessions([parent, child, grandchild], []);
		const rollups = computeRecursiveRollups(records);
		const filtered = filterUnifiedSessions(records, (text) => text.includes("Searchable"));

		expect(filtered).toHaveLength(1);
		const rows = buildAgentsViewRows(filtered, new Set(), new Set(), undefined, rollups);
		expect(rows[0]?.summary.usage?.cost).toBe(0.42);
		expect(rows[0]?.recursiveCost).toBeCloseTo(1.28);
		expect(rows[0]?.descendantCount).toBe(2);
	});

	test("keeps a parent's recursive total when a passivated child survives only as a catalog row", () => {
		const parent = makeSummary({
			id: "parent-active",
			activeSessionId: "parent-active",
			sessionId: "parent-session",
			sessionFile: "/tmp/project/parent.jsonl",
			usage: { inputTokens: 100, outputTokens: 10, cost: 0.42 },
		});
		const liveChild = makeSummary({
			id: "child-active",
			activeSessionId: "child-active",
			sessionId: "child-session",
			sessionFile: "/tmp/project/child.jsonl",
			runtimeKind: "subagent",
			parentActiveSessionId: "parent-active",
			usage: { inputTokens: 50, outputTokens: 5, cost: 0.68 },
		});
		const before = reconcileUnifiedSessions([parent, liveChild], []);
		const beforeRollup = computeRecursiveRollups(before).get(before[0]!);

		// After a restart the child exists only as a saved-catalog row.
		const after = reconcileUnifiedSessions(
			[parent],
			[
				makeSessionInfo({
					path: "/tmp/project/child.jsonl",
					id: "child-session",
					parentSessionPath: "/tmp/project/parent.jsonl",
					rlmDepth: 1,
					usage: { inputTokens: 50, outputTokens: 5, cost: 0.68 },
				}),
			],
		);
		const afterRollup = computeRecursiveRollups(after).get(after[0]!);

		expect(beforeRollup?.cost).toBeCloseTo(1.1);
		expect(afterRollup).toEqual(beforeRollup);
		expect(afterRollup?.descendantCount).toBe(1);
	});

	test("rolls up spawned subagents but never a branched session's copied lineage", () => {
		const source = makeSummary({
			id: "src",
			activeSessionId: "src",
			sessionId: "src-session",
			sessionFile: "/tmp/project/src.jsonl",
			usage: { inputTokens: 100, outputTokens: 10, cost: 0.4 },
		});
		const branch = makeSessionInfo({
			path: "/tmp/project/branch.jsonl",
			id: "branch-session",
			parentSessionPath: "/tmp/project/src.jsonl",
			// Branch/fork headers keep the source's depth; only spawns go deeper.
			rlmDepth: 0,
			usage: { inputTokens: 100, outputTokens: 10, cost: 0.4 },
		});
		const child = makeSessionInfo({
			path: "/tmp/project/child.jsonl",
			id: "child-session",
			parentSessionPath: "/tmp/project/src.jsonl",
			rlmDepth: 1,
			usage: { inputTokens: 20, outputTokens: 2, cost: 0.1 },
		});

		const branchOnly = reconcileUnifiedSessions([source], [branch]);
		expect(computeRecursiveRollups(branchOnly).get(branchOnly[0]!)).toEqual({ cost: 0.4, descendantCount: 0 });

		const withChild = reconcileUnifiedSessions([source], [branch, child]);
		const rollup = computeRecursiveRollups(withChild).get(withChild[0]!);
		expect(rollup?.descendantCount).toBe(1);
		expect(rollup?.cost).toBeCloseTo(0.5);

		// The tree shares that definition of "child": the branch renders as its
		// own top-level session while only the spawned child nests and counts.
		const rows = buildAgentsViewRows(withChild, new Set(), new Set(), undefined, computeRecursiveRollups(withChild));
		expect(rows.find((row) => row.summary.sessionId === "branch-session")).toMatchObject({ kind: "agent", depth: 0 });
		expect(rows.find((row) => row.kind === "subagent-summary")).toMatchObject({ title: "1 subagent" });
	});

	test("tallies a very deep child chain without overflowing the stack", () => {
		const summaries = [
			makeSummary({
				id: "chain-root",
				activeSessionId: "chain-root",
				sessionId: "chain-root-session",
				sessionName: "Chain root",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
		];
		const depth = 10_000;
		for (let level = 1; level <= depth; level++) {
			summaries.push(
				makeSummary({
					id: `chain-${level}`,
					activeSessionId: `chain-${level}`,
					sessionId: `chain-${level}-session`,
					sessionName: `Chain ${level}`,
					runtimeKind: "subagent",
					parentActiveSessionId: level === 1 ? "chain-root" : `chain-${level - 1}`,
					...(level === depth
						? {
								activity: "working" as const,
								isSessionActive: true,
								isStreaming: true,
								usage: { inputTokens: 100, outputTokens: 10, cost: 0.5 },
							}
						: { activity: "idle" as const, taskState: "completed" as const }),
				}),
			);
		}

		const rows = buildAgentsViewRows(summaries);
		expect(rows[0]).toMatchObject({ kind: "agent", section: "idle", runningSubagentCount: 1 });
		expect(rows[0]?.recursiveCost).toBeCloseTo(0.5);
	});

	test("ranks idle rows with busy descendants above plain idle rows", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "plain-idle",
				activeSessionId: "plain-idle",
				sessionId: "plain-session",
				sessionName: "Plain idle",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
				lastActivityAt: "2026-09-02T00:00:00Z",
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Busy-subtree parent",
				activity: "idle",
				taskState: "completed",
				hasRunningRlmChildren: true,
				messageCount: 2,
				lastActivityAt: "2026-08-01T00:00:00Z",
			}),
			makeSummary({
				id: "busy-child",
				activeSessionId: "busy-child",
				sessionId: "busy-child-session",
				sessionName: "Busy child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "working",
				isSessionActive: true,
				isStreaming: true,
			}),
		]);

		expect(rows.filter((row) => row.kind === "agent").map((row) => [row.title, row.section])).toEqual([
			["Busy-subtree parent", "idle"],
			["Plain idle", "idle"],
		]);
	});

	test("keeps idle heartbeating subagents out of the running count", () => {
		const heartbeatChildren = Array.from({ length: 10 }, (_, index) =>
			makeSummary({
				id: `heartbeat-child-${index}`,
				activeSessionId: `heartbeat-child-${index}`,
				sessionId: `heartbeat-child-session-${index}`,
				sessionName: `Heartbeat child ${index}`,
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				hasActiveHeartbeat: true,
				activity: "idle",
				taskState: "completed",
			}),
		);
		const rows = buildAgentsViewRows([
			...heartbeatChildren,
			makeSummary({
				id: "busy-child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				isSessionActive: true,
				isRunningTools: true,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				activity: "idle",
				taskState: "completed",
			}),
		]);

		expect(rows[0]).toMatchObject({ section: "idle", runningSubagentCount: 1 });
		expect(rows[1]).toMatchObject({
			kind: "subagent-summary",
			title: "1 subagent running · 10 heartbeats active",
			runningSubagentCount: 1,
		});
	});

	// [id, name, parent id] with a shared working/streaming state.
	const workingSubagent = (id: string, name: string, parent?: string, extra: Partial<SessionSummary> = {}) =>
		makeSummary({
			id,
			activeSessionId: id,
			sessionId: `${id}-session`,
			sessionFile: `/tmp/${id}.jsonl`,
			sessionName: name,
			isStreaming: true,
			activity: "working",
			...(parent
				? { runtimeKind: "subagent" as const, parentActiveSessionId: parent, parentSessionId: `${parent}-session` }
				: {}),
			...extra,
		});

	test("expands subagent rows for expanded parents and collapses otherwise", () => {
		const summaries = [
			workingSubagent("child", "Child", "parent"),
			workingSubagent("completed-child", "Completed child", "parent", {
				isStreaming: false,
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
			workingSubagent("parent", "Parent"),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed.map((row) => row.kind)).toEqual(["agent", "subagent-summary"]);
		expect(collapsed[1]?.title).toBe("1 subagent running");
		expect(collapsed[1]?.expanded).toBe(false);

		const parentIdentity = collapsed[0]?.identity;
		const expanded = buildAgentsViewRows(summaries, new Set([parentIdentity ?? ""]));
		expect(expanded.map((row) => [row.title, row.kind, row.depth])).toEqual([
			["Parent", "agent", 0],
			["1 subagent running", "subagent-summary", 1],
			["Child", "subagent", 1],
			["Completed child", "subagent", 1],
		]);
		expect(expanded[1]?.expanded).toBe(true);
		expect(expanded.slice(1).every((row) => row.selectable && row.parentIdentity === parentIdentity)).toBe(true);
	});

	test("reveals a nested subagent only after its parent is also expanded", () => {
		const summaries = [
			workingSubagent("grandchild", "Grandchild", "child"),
			workingSubagent("child", "Child", "root"),
			workingSubagent("root", "Root"),
		];

		const rootIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		// Expanding only the root reveals the child but not the grandchild.
		const oneLevel = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		expect(oneLevel.map((row) => [row.title, row.kind])).toEqual([
			["Root", "agent"],
			["2 subagents running", "subagent-summary"],
			["Child", "subagent"],
			["1 subagent running", "subagent-summary"],
		]);

		const childIdentity = oneLevel.find((row) => row.title === "Child")?.identity ?? "";
		const twoLevel = buildAgentsViewRows(summaries, new Set([rootIdentity, childIdentity]));
		expect(twoLevel.map((row) => [row.title, row.kind, row.depth])).toEqual([
			["Root", "agent", 0],
			["2 subagents running", "subagent-summary", 1],
			["Child", "subagent", 1],
			["1 subagent running", "subagent-summary", 2],
			["Grandchild", "subagent", 2],
		]);
	});

	test("keeps finished subagents reachable via the summary row", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "done-child",
				activeSessionId: "done-child",
				sessionId: "done-child-session",
				sessionFile: "/tmp/done-child.jsonl",
				sessionName: "Done child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				sessionName: "Parent",
				activity: "idle",
				messageCount: 4,
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind])).toEqual([
			["Parent", "agent"],
			["1 subagent", "subagent-summary"],
		]);
		expect(rows[1]?.selectable).toBe(true);
	});

	test("treats parent-linked summaries without runtimeKind as subagents and re-roots unresolved ones", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "legacy-child",
				activeSessionId: "legacy-child",
				sessionId: "legacy-child-session",
				sessionName: "Legacy child",
				parentActiveSessionId: "parent-active",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "legacy-rlm-child",
				activeSessionId: "legacy-rlm-child",
				sessionId: "legacy-rlm-session",
				sessionName: "Legacy rlm child",
				rlmChildId: "node-1",
				activity: "idle",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind])).toEqual([
			["Parent", "agent"],
			["1 subagent running", "subagent-summary"],
			["Legacy rlm child", "agent"],
		]);
		expect(rows[0]?.runningSubagentCount).toBe(1);
	});

	test("re-roots live subagents when their parent is not visible", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "removed-parent-active",
				parentSessionId: "removed-parent-session",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "other-active",
				activeSessionId: "other-active",
				sessionId: "other-session",
				sessionName: "Other",
				activity: "idle",
				messageCount: 2,
			}),
		]);

		expect(rows.map((row) => [row.title, row.kind, row.depth])).toEqual([
			["Child", "agent", 0],
			["Other", "agent", 0],
		]);
	});

	test("shows daemon-resident sessions only", () => {
		const inactiveSleep = makeSummary({ lifecycle: "archived", activity: "idle" });
		delete inactiveSleep.activeSessionId;

		expect(shouldShowAgentsViewSession(inactiveSleep)).toBe(false);
		expect(shouldShowAgentsViewSession(makeSummary({ lifecycle: "live", activity: "idle" }))).toBe(true);
		expect(shouldShowAgentsViewSession(makeSummary({ lifecycle: "live", activity: "idle" }), true)).toBe(false);
	});

	test("does not override saved session cwd when reopening inactive agents", () => {
		const config: AgentSessionRuntimeConfig = {
			cwd: "/tmp/dashboard",
			agentDir: "/tmp/agents",
			sessionDir: "/tmp/sessions",
			model: "openai/gpt-5",
		};

		const resumeConfig = createAgentsViewResumeConfig(config);

		expect("cwd" in resumeConfig).toBe(false);
		expect(resumeConfig.agentDir).toBe("/tmp/agents");
		expect(resumeConfig.sessionDir).toBe("/tmp/sessions");
		expect(resumeConfig.model).toBe("openai/gpt-5");
		expect(config.cwd).toBe("/tmp/dashboard");
	});

	test("opens an existing-cwd session in its own directory with no override or notice", () => {
		const dir = mkdtempSync(join(tmpdir(), "agents-view-cwd-"));
		try {
			expect(resolveAgentsViewOpenCwd(makeSummary({ cwd: dir }), "/tmp/launch")).toEqual({});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("falls back to the launch cwd and explains it when the stored cwd is gone", () => {
		const missing = join(tmpdir(), "agents-view-missing-worktree-does-not-exist");
		const { overrideCwd, notice } = resolveAgentsViewOpenCwd(makeSummary({ cwd: missing }), "/tmp/launch");
		expect(overrideCwd).toBe("/tmp/launch");
		expect(notice).toContain(missing);
		expect(notice).toContain("/tmp/launch");
	});

	test("does not override when there is no fallback cwd to use", () => {
		const missing = join(tmpdir(), "agents-view-missing-worktree-does-not-exist");
		expect(resolveAgentsViewOpenCwd(makeSummary({ cwd: missing }), undefined)).toEqual({});
	});

	test("passes the override cwd through the resume config when the stored cwd is missing", () => {
		const config: AgentSessionRuntimeConfig = { cwd: "/tmp/launch", agentDir: "/tmp/agents" };
		const resumeConfig = createAgentsViewResumeConfig(config, "/tmp/launch");
		expect(resumeConfig.cwd).toBe("/tmp/launch");
	});

	test("requests only daemon-resident sessions for the agents view refresh", () => {
		expect(createAgentsViewListCommand()).toEqual({ type: "list" });
	});

	test("resolves active summaries by session file path", () => {
		const activeSummary = makeSummary({
			id: "active-runtime",
			activeSessionId: "active-runtime",
			sessionId: "saved-active",
			sessionFile: "/tmp/sessions/active.jsonl",
			sessionName: "Running",
		});
		const inactiveSummary = makeSummary({
			id: "inactive",
			activeSessionId: undefined,
			sessionId: "inactive",
			sessionFile: "/tmp/sessions/inactive.jsonl",
		});

		expect(
			resolveAgentsViewActiveSummaryForPath("/tmp/sessions/active.jsonl", [inactiveSummary, activeSummary]),
		).toBe(activeSummary);
		expect(resolveAgentsViewActiveSummaryForPath("/tmp/sessions/inactive.jsonl", [inactiveSummary])).toBeUndefined();
	});

	test("reconnects daemon restarts and crashes but stops after an intentional shutdown", () => {
		expect(shouldReconnectAgentsViewDaemon("update")).toBe(true);
		expect(shouldReconnectAgentsViewDaemon(undefined)).toBe(true);
		expect(shouldReconnectAgentsViewDaemon("shutdown")).toBe(false);
	});

	test("uses session-specific UI services when opening an agent", async () => {
		const dashboardServices = makeUiServices("/tmp/dashboard");
		const sessionServices = makeUiServices("/tmp/project");
		const summary = makeSummary({ cwd: "/tmp/project", sessionFile: "/tmp/project/session.jsonl" });
		const createUiServicesForSession = vi.fn(async () => sessionServices);

		await expect(
			resolveAgentsViewSessionUiServices(
				{
					uiServices: dashboardServices,
					createUiServicesForSession,
				},
				summary,
			),
		).resolves.toBe(sessionServices);
		expect(createUiServicesForSession).toHaveBeenCalledWith(summary);
	});

	test("reconciles canonical paths and session ids while retaining saved search text", () => {
		const saved = makeSessionInfo({
			path: "/tmp/sessions/../sessions/merged.jsonl",
			id: "merged-session",
			name: "Durable name",
			allMessagesText: "a uniquely searchable transcript",
			agentStatus: { summary: "Investigated the lunar regression", basedOnMessageCount: 1 },
		});
		const daemon = makeSummary({
			id: "runtime",
			activeSessionId: "runtime",
			sessionId: "merged-session",
			sessionFile: "/tmp/sessions/merged.jsonl",
			sessionName: "Live name",
		});

		const [record] = reconcileUnifiedSessions([daemon], [saved]);
		expect(record).toMatchObject({ daemon, saved, identity: "file:/tmp/sessions/merged.jsonl", section: "idle" });
		expect(record?.searchableText).toContain("uniquely searchable transcript");
		expect(record?.searchableText).toContain("lunar regression");
		expect(buildAgentsViewRows([record!])[0]).toMatchObject({
			title: "Live name",
			record,
		});
	});

	test("retains the ancestor chain when search matches only a nested subagent", () => {
		const summaries = [
			makeSummary({ id: "root", activeSessionId: "root", sessionId: "root-session", sessionName: "Root" }),
			makeSummary({
				id: "child",
				activeSessionId: "child",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "root",
			}),
			makeSummary({
				id: "match",
				activeSessionId: "match",
				sessionId: "match-session",
				sessionName: "Needle",
				runtimeKind: "subagent",
				parentActiveSessionId: "child",
			}),
			makeSummary({
				id: "newer",
				activeSessionId: "newer",
				sessionId: "newer-session",
				sessionName: "Needle peer",
				created: "2026-02-01T00:00:00Z",
			}),
		];
		const records = reconcileUnifiedSessions(summaries, []);
		const filtered = filterUnifiedSessions(records, (text) => text.includes("Needle"));

		expect(filtered.map((record) => record.daemon?.sessionId)).toEqual([
			"root-session",
			"child-session",
			"match-session",
			"newer-session",
		]);
		const rootIdentity = records[0]?.identity ?? "";
		const childIdentity = records[1]?.identity ?? "";
		expect(
			buildAgentsViewRows(filtered, new Set([rootIdentity, childIdentity])).map((row) => [
				row.summary.sessionId,
				row.depth,
			]),
		).toEqual([
			["newer-session", 0],
			["root-session", 0],
			["root-session", 1],
			["child-session", 1],
			["child-session", 2],
			["match-session", 2],
		]);
	});

	test.each(["search", "empty"] as const)("reuses a prebuilt index for the %s filter", (kind) => {
		const rootPath = "/tmp/agents-view-filter-index/root.jsonl";
		const childPath = "/tmp/agents-view-filter-index/child.jsonl";
		const records = reconcileUnifiedSessions(
			[
				makeSummary({
					id: "child",
					activeSessionId: "child",
					sessionId: "child-session",
					sessionFile: childPath,
					parentSessionPath: rootPath,
					runtimeKind: "subagent",
				}),
			],
			[
				makeSessionInfo({
					id: "root-session",
					path: rootPath,
					messageCount: 0,
					firstMessage: "",
					allMessagesText: "",
				}),
				makeSessionInfo({
					id: "grandchild-session",
					path: "/tmp/agents-view-filter-index/grandchild.jsonl",
					parentSessionPath: childPath,
					rlmDepth: 2,
					allMessagesText: "Needle",
				}),
				makeSessionInfo({
					id: "empty-session",
					path: "/tmp/agents-view-filter-index/empty.jsonl",
					messageCount: 0,
					firstMessage: "",
					allMessagesText: "",
				}),
				makeSessionInfo({
					id: "preserved-session",
					path: "/tmp/agents-view-filter-index/preserved.jsonl",
					messageCount: 0,
					firstMessage: "",
					allMessagesText: "",
				}),
			],
		);
		const matches = (text: string): boolean => text.includes("Needle");
		const preserved = new Set(["preserved-session"]);
		const expected =
			kind === "search"
				? filterUnifiedSessions(records, matches)
				: filterEmptyAgentsViewSessions(records, preserved);
		expect(expected.map((record) => summaryForUnifiedRecord(record).sessionId)).toEqual([
			"child-session",
			"root-session",
			"grandchild-session",
			...(kind === "empty" ? ["preserved-session"] : []),
		]);
		const index = buildUnifiedSessionIndex(records);
		const aliasIterators = records.map((record) => vi.spyOn(record.identityAliases, Symbol.iterator));
		const lookups = vi.spyOn(index.byKey, "get");
		try {
			const filtered =
				kind === "search"
					? filterUnifiedSessions(records, matches, index)
					: filterEmptyAgentsViewSessions(records, preserved, index);
			for (const iterator of aliasIterators) expect(iterator).not.toHaveBeenCalled();
			expect(lookups).toHaveBeenCalled();
			expect(filtered).toHaveLength(expected.length);
			for (const [position, record] of filtered.entries()) expect(record).toBe(expected[position]);

			const subset = records.filter((record) => record.saved?.id !== "root-session");
			const filteredSubset =
				kind === "search"
					? filterUnifiedSessions(subset, matches, index)
					: filterEmptyAgentsViewSessions(subset, preserved, index);
			expect(filteredSubset).toEqual(filtered.filter((record) => record.saved?.id !== "root-session"));
		} finally {
			for (const iterator of aliasIterators) iterator.mockRestore();
			lookups.mockRestore();
		}
	});

	test("deduplicates and protects sessions across symlink aliases", () => {
		const root = mkdtempSync(join(tmpdir(), "session-view-alias-"));
		try {
			const real = join(root, "session.jsonl");
			const alias = join(root, "alias.jsonl");
			writeFileSync(real, "");
			symlinkSync(real, alias);
			const daemon = makeSummary({ activeSessionId: "active", sessionFile: alias, sessionId: "same" });
			const saved = makeSessionInfo({ id: "same", path: real });
			expect(reconcileUnifiedSessions([daemon], [saved])).toHaveLength(1);
			expect(resolveAgentsViewActiveSummaryForPath(real, [daemon])).toBe(daemon);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("uses canonical path and fallback active-id keys for heartbeat ancestry", () => {
		const root = mkdtempSync(join(tmpdir(), "session-view-parent-alias-"));
		try {
			const path = join(root, "parent.jsonl");
			const alias = join(root, "alias.jsonl");
			writeFileSync(path, "");
			symlinkSync(path, alias);
			const summaries = [
				makeSummary({ id: "root", activeSessionId: undefined, sessionFile: path }),
				makeSummary({
					id: "parent",
					activeSessionId: undefined,
					parentSessionPath: alias,
					runtimeKind: "subagent",
				}),
				makeSummary({
					id: "child",
					activeSessionId: undefined,
					parentActiveSessionId: "parent",
					runtimeKind: "subagent",
				}),
			];
			const aggregates = aggregateSessionHeartbeats(summaries, [heartbeat("job", undefined, "child")]);
			expect(["root", "parent", "child"].map((id) => aggregates.get(id))).toEqual(
				Array.from({ length: 3 }, () => ({ activeCount: 1 })),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("shows a fallback heartbeat count while catalog details are unavailable", () => {
		const [record] = reconcileUnifiedSessions([makeSummary({ hasActiveHeartbeat: true })], []);
		expect(record).toMatchObject({ section: "idle", heartbeat: { activeCount: 1 } });
		expect(formatHeartbeatBadge(record?.heartbeat)).toBe("♥ 1");
	});

	test("preserves live identity and row state when saved metadata adds a file alias", () => {
		const saved = makeSessionInfo({ path: "/tmp/saved.jsonl", id: "saved", allMessagesText: "transcript" });
		const parent = makeSummary({
			id: "parent",
			activeSessionId: "parent",
			sessionId: "saved",
			sessionFile: undefined,
		});
		const child = makeSummary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "parent",
			spawnCode: "run_subagent()",
		});
		const [inactive] = reconcileUnifiedSessions([], [saved]);
		const [live] = reconcileUnifiedSessions([parent, child], []);
		const enrichedRecords = reconcileUnifiedSessions([parent, child], [saved]);
		const enriched = enrichedRecords.find((record) => record.daemon?.sessionId === parent.sessionId);
		const expanded = buildAgentsViewRows(enrichedRecords, new Set([live!.identity]), new Set([live!.identity]));

		expect(inactive).toMatchObject({ identity: "file:/tmp/saved.jsonl", section: "inactive" });
		expect(enriched).toMatchObject({ identity: live?.identity, section: "idle", saved });
		expect(enriched?.identityAliases).toContain("file:/tmp/saved.jsonl");
		expect(expanded.map((row) => row.kind)).toContain("subagent-code");
		expect(expanded.some((row) => row.kind === "subagent" && row.summary.sessionId === "child-session")).toBe(true);
	});

	test("aggregates active descendant heartbeats once and formats the soonest run", () => {
		const parent = makeSummary({ id: "parent", activeSessionId: "parent", sessionId: "parent-session" });
		const child = makeSummary({
			id: "child",
			activeSessionId: "child",
			sessionId: "child-session",
			runtimeKind: "subagent",
			parentActiveSessionId: "parent",
		});

		const aggregates = aggregateSessionHeartbeats(
			[parent, child],
			[heartbeat("one", "2026-01-01T00:10:00Z"), heartbeat("two", "2026-01-01T00:05:00Z")],
		);
		expect(aggregates.get("child")).toEqual({ activeCount: 2, nextRunAt: "2026-01-01T00:05:00Z" });
		expect(aggregates.get("parent")).toEqual({ activeCount: 2, nextRunAt: "2026-01-01T00:05:00Z" });
		const rows = buildAgentsViewRows(reconcileUnifiedSessions([parent, child], [], [heartbeat("one")]));
		expect(rows[0]).toMatchObject({ section: "idle", heartbeat: { activeCount: 1 } });
		expect(rows[1]).toMatchObject({ title: "1 subagent · 1 heartbeat active" });
		expect(formatHeartbeatBadge(aggregates.get("parent"), Date.parse("2026-01-01T00:00:00Z"))).toBe("♥ 2·5m");
		expect(
			formatHeartbeatBadge(
				{ activeCount: 1, nextRunAt: "2026-01-01T00:10:00Z" },
				Date.parse("2026-01-01T00:00:00Z"),
			),
		).toBe("♥ 1·10m");
		expect(formatHeartbeatBadge({ activeCount: 1 })).toBe("♥ 1");
		// Sub-minute countdowns show seconds instead of rounding up to 1m.
		expect(
			formatHeartbeatBadge(
				{ activeCount: 1, nextRunAt: "2026-01-01T00:00:42Z" },
				Date.parse("2026-01-01T00:00:00Z"),
			),
		).toBe("♥ 1·42s");
		expect(
			formatHeartbeatBadge(
				{ activeCount: 1, nextRunAt: "2026-01-01T00:00:59.700Z" },
				Date.parse("2026-01-01T00:00:00Z"),
			),
		).toBe("♥ 1·1m");
		expect(
			formatHeartbeatBadge(
				{ activeCount: 1, nextRunAt: "2026-01-01T00:00:00Z" },
				Date.parse("2026-01-01T00:00:00Z"),
			),
		).toBe("♥ 1·1s");

		const soonRows = buildAgentsViewRows(
			reconcileUnifiedSessions(
				[parent],
				[],
				[heartbeat("one", new Date(Date.now() + 5 * 60_000).toISOString(), "parent")],
			),
		);
		expect(soonRows[0]).toMatchObject({ section: "idle", statusLabel: "heartbeat · next 5m" });
	});

	test("counts paused heartbeats separately without affecting the section", () => {
		const parent = makeSummary({ id: "parent", activeSessionId: "parent", sessionId: "parent-session" });
		const paused = heartbeat("paused-job", undefined, "parent", "paused");
		const aggregates = aggregateSessionHeartbeats([parent], [paused]);
		expect(aggregates.get("parent")).toEqual({ activeCount: 0, pausedCount: 1 });
		expect(formatHeartbeatBadge(aggregates.get("parent"))).toBe("♥ 1");
		const [record] = reconcileUnifiedSessions([parent], [], [paused]);
		expect(record).toMatchObject({ section: "idle", heartbeat: { activeCount: 0, pausedCount: 1 } });
		expect(record?.daemon?.hasActiveHeartbeat).toBeUndefined();
	});

	describe("restores selection to the previously open session", () => {
		const opened = makeSummary({
			id: "active-open",
			activeSessionId: "active-open",
			sessionId: "session-open",
			sessionFile: "/tmp/project/open.jsonl",
			sessionName: "open",
		});
		const other = makeSummary({
			id: "active-other",
			activeSessionId: "active-other",
			sessionId: "session-other",
			sessionFile: "/tmp/project/other.jsonl",
			sessionName: "other",
		});
		const identity = `file:${opened.sessionFile}`;
		const key = getAgentsViewSelectionKey(opened);

		test("re-finds the session after a section change reorders the list", () => {
			const rows = buildAgentsViewRows([{ ...opened, activity: "working" }, other]);
			const openIndex = rows.findIndex((row) => row.summary.sessionId === "session-open");
			expect(openIndex).toBe(0);
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(openIndex);
		});

		test("falls back to activeSessionId when the row identity changed", () => {
			// Selected before the session had a file, so the stored identity is active:...
			const rows = buildAgentsViewRows([other, opened]);
			const staleIdentity = "active:active-open";
			expect(resolveAgentsViewSelectionIndex(rows, staleIdentity, key)).toBe(
				rows.findIndex((row) => row.summary.sessionId === "session-open"),
			);
		});

		test("prefers the current runtime over a stale saved-file identity", () => {
			const switched = {
				...opened,
				sessionId: "session-switched",
				sessionFile: "/tmp/project/switched.jsonl",
			};
			const staleSaved = makeSummary({
				id: "session-open",
				activeSessionId: undefined,
				sessionId: "session-open",
				sessionFile: opened.sessionFile,
				lifecycle: "archived",
			});
			const rows = buildAgentsViewRows([staleSaved, switched]);
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(
				rows.findIndex((row) => row.summary.sessionId === "session-switched"),
			);
		});

		test("falls back to sessionId after a daemon re-attach regenerates the active id", () => {
			// Re-attach gives a fresh activeSessionId, so only the sessionId still matches.
			const reattached = { ...opened, id: "active-open-2", activeSessionId: "active-open-2" };
			const rows = buildAgentsViewRows([other, reattached]);
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(
				rows.findIndex((row) => row.summary.sessionId === "session-open"),
			);
		});

		test("keeps an unresolved source anchor while streamed rows provide a visual fallback", () => {
			const partialRows = buildAgentsViewRows([other]);
			expect(resolveAgentsViewSelectionState(partialRows, 0, identity, key)).toEqual({
				index: 0,
				resolved: false,
			});
			const completeRows = buildAgentsViewRows([other, opened]);
			expect(resolveAgentsViewSelectionState(completeRows, 0, identity, key)).toEqual({
				index: completeRows.findIndex((row) => row.summary.sessionId === "session-open"),
				resolved: true,
			});
		});

		test("keeps a collapsed subagent summary selected across refreshes", () => {
			const child = makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: "/tmp/project/child.jsonl",
				runtimeKind: "subagent",
				parentActiveSessionId: opened.activeSessionId,
				parentSessionId: opened.sessionId,
			});
			const initialRows = buildAgentsViewRows([opened, child]);
			const selected = initialRows.find((row) => row.kind === "subagent-summary")!;
			const refreshedRows = buildAgentsViewRows([{ ...opened }, { ...child }]);
			const refreshedSummaryIndex = refreshedRows.findIndex((row) => row.kind === "subagent-summary");
			expect(
				resolveAgentsViewSelectionIndex(
					refreshedRows,
					selected.identity,
					getAgentsViewSelectionKey(selected.summary),
				),
			).toBe(refreshedSummaryIndex);
		});

		test("returns -1 when the session is gone so callers pick a default", () => {
			const rows = buildAgentsViewRows([other]);
			expect(resolveAgentsViewSelectionIndex(rows, identity, key)).toBe(-1);
		});

		test("returns -1 with no stored selection", () => {
			const rows = buildAgentsViewRows([opened, other]);
			expect(resolveAgentsViewSelectionIndex(rows, undefined, undefined)).toBe(-1);
		});
	});

	describe("scoped navigation", () => {
		const rootScope = { sessionId: "root-session", activeSessionId: "root-active" };
		const childScope = { sessionId: "child-session", activeSessionId: "child-active" };

		test("seeds handoff scope frames with the matching return chat", () => {
			const chat = makeSummary({ sessionId: "root-session", activeSessionId: "root-active" });
			const persistentState = createInitialAgentsViewPersistentState({
				initialScopeKey: rootScope,
				initialSession: chat,
			});
			const handoffFrame = persistentState.scopeFrames?.at(-1);

			// The scope root is never a row of its own children view: seeding it as
			// the selection anchor would only arm pending-anchor for the whole scan.
			expect(persistentState.selectedRowIdentity).toBeUndefined();
			expect(persistentState.selectedSessionKey).toBeUndefined();
			expect(persistentState.backSession).toBe(chat);
			const unscoped = createInitialAgentsViewPersistentState({ initialSession: chat });
			expect(unscoped.selectedRowIdentity).toBeDefined();

			expect(handoffFrame).toEqual({ scope: rootScope, returnChat: chat });
			expect(createInitialAgentsViewScopeFrames(rootScope, persistentState.backSession)).toEqual([handoffFrame]);
			expect(createInitialAgentsViewScopeFrames(rootScope, makeSummary({ sessionId: "stale-session" }))).toEqual([
				{ scope: rootScope },
			]);

			const leftResult = resolveAgentsViewLeftResult(chat, [], handoffFrame?.returnChat);
			expect(leftResult?.type).toBe("scope_back");
			if (leftResult?.type !== "scope_back") throw new Error("Expected scoped Left navigation");
			expect(createScopeBackReturnChatOpenResult({ ...leftResult, hasChildren: true })).toMatchObject({
				type: "open",
				summary: { sessionId: "root-session", activeSessionId: "root-active" },
			});
		});

		test("pushes and pops immutable scope frames with their return chats one level at a time", () => {
			const initial: AgentsViewScopeFrame[] = [];
			const rootChat = makeSummary({ sessionId: "root-session" });
			const childChat = makeSummary({ sessionId: "child-session" });
			const rootFrames = transitionAgentsViewScope(initial, {
				type: "push",
				scope: rootScope,
				returnChat: rootChat,
			});
			const childFrames = transitionAgentsViewScope(rootFrames, {
				type: "push",
				scope: childScope,
				returnChat: childChat,
			});

			expect(initial).toEqual([]);
			expect(childFrames.map((frame) => [frame.scope.sessionId, frame.returnChat?.sessionId])).toEqual([
				["root-session", "root-session"],
				["child-session", "child-session"],
			]);
			expect(JSON.parse(JSON.stringify(childFrames))).toEqual(childFrames);
			expect(transitionAgentsViewScope(childFrames, { type: "back" })).toEqual(rootFrames);
			expect(transitionAgentsViewScope(rootFrames, { type: "back" })).toEqual([]);
		});

		test("refreshes the current frame instead of duplicating the same session", () => {
			const frames = transitionAgentsViewScope([{ scope: rootScope }], {
				type: "push",
				scope: { ...rootScope, activeSessionId: "root-active-2" },
			});
			expect(frames).toEqual([{ scope: { ...rootScope, activeSessionId: "root-active-2" } }]);
		});

		test("Left is a no-op globally and returns through a surviving scoped chat", () => {
			const root = makeSummary({ sessionId: "root-session", activeSessionId: "root-active" });
			const recordedChat = makeSummary({ sessionId: "root-session", activeSessionId: "stale-active" });

			expect(resolveAgentsViewLeftResult(undefined)).toBeUndefined();
			expect(resolveAgentsViewLeftResult(root, [], recordedChat)).toMatchObject({
				type: "scope_back",
				selection: { sessionId: "root-session" },
				returnChat: { sessionId: "root-session", activeSessionId: "root-active" },
			});
		});

		test("Left falls back to the parent agents view when the recorded chat is gone", () => {
			const root = makeSummary({ sessionId: "replacement-session" });
			const deletedChat = makeSummary({ sessionId: "deleted-session" });

			expect(resolveAgentsViewLeftResult(root, ["parent-session"], deletedChat)).toEqual({
				type: "scope_back",
				selection: root,
				expandedAncestorSessionIds: ["parent-session"],
			});
		});

		test("carries expansion and child metadata when scope-back reopens its return chat", () => {
			const root = makeSummary({ sessionId: "root-session", activeSessionId: "root-active" });

			expect(
				createScopeBackReturnChatOpenResult({
					type: "scope_back",
					selection: root,
					returnChat: root,
					expandedAncestorSessionIds: ["ancestor-session", "parent-session"],
					hasChildren: true,
				}),
			).toEqual({
				type: "open",
				summary: root,
				expandedAncestorSessionIds: ["ancestor-session", "parent-session"],
				hasChildren: true,
			});
		});

		test("falls back to the nearest surviving scope frame, then global", () => {
			const root = makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
			});
			const frames = [{ scope: rootScope }, { scope: childScope }];
			const records = reconcileUnifiedSessions([root], []);

			expect(resolveAgentsViewScopeFrames(records, frames)).toMatchObject({
				frames: [{ scope: rootScope }],
				root: { daemon: { sessionId: "root-session" } },
				droppedFrames: 1,
			});
			expect(resolveAgentsViewScopeFrames([], frames)).toEqual({ frames: [], droppedFrames: 2 });
		});

		test("settles vanished scopes only after the saved catalog attempt finishes", () => {
			expect(shouldApplyScopeResolution(0, false)).toBe(true);
			expect(shouldApplyScopeResolution(1, false)).toBe(false);
			expect(shouldApplyScopeResolution(1, true)).toBe(true);
		});
	});

	describe("scoped unified records", () => {
		test("buildAgentsViewRows excludes the scope root", () => {
			const root = makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionName: "Root",
			});
			const scope = { sessionId: "root-session", activeSessionId: "root-active" };

			expect(buildAgentsViewRows([root], new Set(), new Set(), scope)).toEqual([]);
		});

		test("buildAgentsViewRows promotes direct scope children to root agent rows", () => {
			const root = makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionName: "Root",
			});
			const child = makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "root-active",
				parentSessionId: "root-session",
			});
			const scope = { sessionId: "root-session", activeSessionId: "root-active" };

			expect(buildAgentsViewRows([root, child], new Set(), new Set(), scope)).toMatchObject([
				{ kind: "agent", depth: 0, summary: { sessionId: "child-session" } },
			]);
		});

		test("buildAgentsViewRows re-roots a saved child whose parent file is missing", () => {
			const [child] = reconcileUnifiedSessions(
				[],
				[
					makeSessionInfo({
						id: "saved-child",
						path: "/tmp/project/saved-child.jsonl",
						parentSessionPath: "/tmp/project/missing-parent.jsonl",
						modified: new Date("2026-01-04T00:00:00Z"),
					}),
				],
			);

			expect(buildAgentsViewRows([child!])).toMatchObject([
				{
					kind: "agent",
					depth: 0,
					summary: { sessionId: "saved-child", lastActivityAt: "2026-01-04T00:00:00.000Z" },
				},
			]);
		});

		test("gets ancestor session ids from root to immediate parent", () => {
			const records = reconcileUnifiedSessions(
				[
					makeSummary({ id: "root", activeSessionId: "root", sessionId: "root-session" }),
					makeSummary({
						id: "child",
						activeSessionId: "child",
						sessionId: "child-session",
						runtimeKind: "subagent",
						parentActiveSessionId: "root",
					}),
					makeSummary({
						id: "grandchild",
						activeSessionId: "grandchild",
						sessionId: "grandchild-session",
						runtimeKind: "subagent",
						parentActiveSessionId: "child",
					}),
				],
				[],
			);
			const index = buildUnifiedSessionIndex(records);

			expect(
				getUnifiedSessionAncestorSessionIds(
					records,
					{ sessionId: "grandchild-session", activeSessionId: "grandchild" },
					index,
				),
			).toEqual(["root-session", "child-session"]);
		});

		test("reports no children for leaf and unresolvable scopes", () => {
			const records = reconcileUnifiedSessions(
				[makeSummary({ id: "leaf", activeSessionId: "leaf", sessionId: "leaf-session" })],
				[],
			);
			const index = buildUnifiedSessionIndex(records);

			expect(hasUnifiedSessionChildren(records, { sessionId: "leaf-session", activeSessionId: "leaf" }, index)).toBe(
				false,
			);
			expect(hasUnifiedSessionChildren(records, { sessionId: "missing" }, index)).toBe(false);
			expect(scopeToSessionSubtree(records, { sessionId: "missing" }, index)).toEqual([]);
		});
		test("includes registry-backed and saved-only passive descendants", () => {
			const rootPath = "/tmp/project/root.jsonl";
			const root = makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionFile: rootPath,
				rlmDepth: 0,
			});
			const registryChild = makeSummary({
				id: "registry-child",
				activeSessionId: undefined,
				sessionId: "registry-child",
				sessionFile: "/tmp/project/registry-child.jsonl",
				runtimeKind: "subagent",
				parentSessionId: "root-session",
				rlmDepth: 1,
			});
			const records = reconcileUnifiedSessions(
				[root, registryChild],
				[
					makeSessionInfo({ path: rootPath, id: "root-session", rlmDepth: 0 }),
					// The catalog also lists the resident child's file: it must merge, not duplicate.
					makeSessionInfo({
						path: "/tmp/project/registry-child.jsonl",
						id: "registry-child",
						parentSessionPath: rootPath,
						rlmDepth: 1,
					}),
					makeSessionInfo({
						path: "/tmp/project/saved-child.jsonl",
						id: "saved-child",
						parentSessionPath: rootPath,
						rlmDepth: 1,
					}),
				],
			);
			const scope = { sessionId: "root-session", activeSessionId: "root-active" };
			const scoped = scopeToSessionSubtree(records, scope);
			const rows = buildAgentsViewRows(scoped, new Set(), new Set(), scope);

			expect(hasUnifiedSessionChildren(records, scope)).toBe(true);
			expect(scoped.map((record) => record.daemon?.sessionId ?? record.saved?.id)).toEqual([
				"root-session",
				"registry-child",
				"saved-child",
			]);
			expect(rows).toHaveLength(2);
			expect(rows.every((row) => row.kind === "agent" && row.depth === 0 && row.section === "inactive")).toBe(true);
			expect(rows.find((row) => row.summary.sessionId === "registry-child")?.summary).toMatchObject({
				parentSessionId: "root-session",
				rlmDepth: 1,
			});
			expect(rows.find((row) => row.summary.sessionId === "saved-child")?.summary).toMatchObject({
				parentSessionPath: rootPath,
				rlmDepth: 1,
			});
		});
	});

	test("unattachable-child fallback preserves child selection and explains the parent open", () => {
		const child = makeSummary({ id: "child", sessionId: "child-session" });
		const parent = makeSummary({ id: "parent", sessionId: "parent-session" });
		const result = createUnattachableChildOpenResult(child, parent, ["root-session"], true);

		expect(result).toMatchObject({
			type: "open",
			summary: { sessionId: "parent-session" },
			selection: { sessionId: "child-session" },
			expandedAncestorSessionIds: ["root-session"],
			hasChildren: true,
			statusMessage: "Child session is unavailable; opened its parent instead",
		});
		expect(result.selection).not.toBe(result.summary);
	});
});

function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
	return {
		id: "active-1",
		activeSessionId: "active-1",
		lifecycle: "live",
		activity: "idle",
		isSessionActive: false,
		sessionId: "session-1",
		cwd: "/tmp/project",
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		...overrides,
	};
}

function makeSessionInfo(overrides: Partial<SessionInfo> & { path: string; id: string }): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: overrides.cwd ?? "/tmp/project",
		name: overrides.name,
		state: overrides.state,
		parentSessionPath: overrides.parentSessionPath,
		rlmDepth: overrides.rlmDepth ?? 0,
		created: overrides.created ?? new Date("2026-01-01T00:00:00Z"),
		modified: overrides.modified ?? new Date("2026-01-01T00:00:00Z"),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
		agentStatus: overrides.agentStatus,
		usage: overrides.usage,
	};
}

function makeUiServices(cwd: string): InteractiveModeUiServices {
	return {
		settingsManager: {} as SettingsManager,
		modelRegistry: {} as ModelRegistry,
		getInitialCwd: () => cwd,
		getInitialSessionName: () => undefined,
		getThemes: (): Theme[] => [],
	};
}

/**
 * Session catalog refresh races folded in from the #502 unified-session-view regression file:
 * overlapping polls, reconnect fences, and shutdown must never rewind the last complete catalog.
 */
describe("#502 agents view catalog refresh races", () => {
	function privateMethod<T>(name: string): T {
		const member = Reflect.get(AgentsViewMode.prototype, name) as T;
		if (typeof member !== "function") {
			throw new Error(`AgentsViewMode.${name} no longer exists; update this regression harness`);
		}
		return member;
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
			savedCatalogGeneration: 0,
			heartbeatCatalogGeneration: 0,
			savedCatalogRefreshPending: false,
			heartbeats: [] as unknown[],
			savedSearchFetchStarted: false,
			persistentState,
			applySessionList: vi.fn(),
			reconcileCatalogs: vi.fn(),
			resolveMissingSelectionAnchor: vi.fn(),
			setStatusMessage: vi.fn(),
			startClientReconnect: vi.fn(),
			rearmSavedSearchFetch: privateMethod<(this: unknown) => void>("rearmSavedSearchFetch"),
		};
	}

	function savedScanHarness(previous: Array<{ path: string; id: string }>, client: unknown) {
		const harness = {
			...refreshHarness(),
			savedSessions: previous,
			lastSuccessfulSavedSessions: previous,
			requireClient: () => client,
			getSavedSessionCatalogContext: () => ({ cwd: "/tmp/project" }),
		};
		harness.persistentState.savedSessions = previous;
		return harness;
	}

	test("an older overlapping heartbeat poll cannot overwrite the newer response", async () => {
		const old = createDeferred<unknown>();
		const newer = { job: { id: "new" } };
		const client = {
			isConnected: true,
			hello: { protocol: { version: 3 } },
			supportsServerCapability: () => true,
			request: vi
				.fn()
				.mockReturnValueOnce(old.promise)
				.mockResolvedValueOnce({ success: true, data: { heartbeats: [newer] } }),
		};
		const harness = { ...refreshHarness(), requireClient: () => client };
		const refresh = privateMethod<(this: typeof harness) => Promise<unknown>>("refreshHeartbeats");

		const oldPoll = refresh.call(harness);
		await refresh.call(harness);
		old.resolve({ success: true, data: { heartbeats: [{ job: { id: "old" } }] } });
		await oldPoll;

		expect(harness.heartbeats).toEqual([newer]);
		expect(harness.reconcileCatalogs).toHaveBeenCalledOnce();
	});

	test("overlapping saved scans retain the last complete catalog after the newest scan fails", async () => {
		const previous = [savedSession("previous")];
		const older = createDeferred<{ success: true; data: { sessions: unknown[] } }>();
		const olderStarted = createDeferred();
		const harness = savedScanHarness(previous, {
			request: vi
				.fn()
				.mockImplementationOnce(() => {
					olderStarted.resolve();
					return older.promise;
				})
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
		});
		const refresh = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions");

		const oldScan = refresh.call(harness);
		await olderStarted.promise;
		expect(await refresh.call(harness)).toBe(false);
		older.resolve({ success: true, data: { sessions: [rawSavedSession("stale")] } });
		expect(await oldScan).toBe(false);

		expect([harness.savedSessions, harness.persistentState.savedSessions]).toEqual([previous, previous]);
		expect(harness.savedCatalogRefreshPending).toBe(false);
	});

	test("reconnect retries the saved catalog and fences a stale startup scan", async () => {
		const previous = [savedSession("previous")];
		const startup = createDeferred<{ success: true; data: { sessions: unknown[] } }>();
		const retried = createDeferred<{ success: true; data: { sessions: unknown[] } }>();
		const harness = {
			...savedScanHarness(previous, {
				request: vi.fn().mockReturnValueOnce(startup.promise).mockReturnValueOnce(retried.promise),
			}),
			reconnectPromise: undefined as Promise<void> | undefined,
		};
		const refresh =
			privateMethod<
				(
					this: typeof harness,
					options?: { duringReconnect?: boolean; preserveStatusOnError?: boolean },
				) => Promise<boolean>
			>("refreshSavedSessions");

		const startupScan = refresh.call(harness);
		harness.reconnectPromise = Promise.resolve();
		const retry = refresh.call(harness, { duringReconnect: true, preserveStatusOnError: true });
		expect([harness.savedCatalogGeneration, harness.persistentState.savedCatalogGeneration]).toEqual([2, 2]);

		retried.resolve({ success: true, data: { sessions: [rawSavedSession("retried")] } });
		expect(await retry).toBe(true);
		startup.resolve({ success: true, data: { sessions: [rawSavedSession("stale")] } });
		expect(await startupScan).toBe(false);
		expect(harness.savedSessions).toEqual([expect.objectContaining({ path: savedSession("retried").path })]);
	});

	test("failed saved retry during reconnect preserves status and complete catalog", async () => {
		const previous = [savedSession("previous")];
		const harness = {
			...savedScanHarness(previous, {
				request: async (
					_command: unknown,
					_timeout: unknown,
					options: { onProgress: (update: { type: string; session: unknown }) => void },
				) => {
					options.onProgress({ type: "session_list_session", session: rawSavedSession("partial") });
					throw new Error("retry failed");
				},
			}),
			reconnectPromise: Promise.resolve(),
		};

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
			const live = makeSummary({ id: "live", activeSessionId: "live", sessionId: "session-live" });
			const firstHeartbeatAttempt = createDeferred<void>();
			const retryScheduled = createDeferred<void>();
			const fakeSetTimeout = globalThis.setTimeout;
			vi.spyOn(globalThis, "setTimeout").mockImplementation(((...args: Parameters<typeof setTimeout>) => {
				const timer = fakeSetTimeout(...args);
				if (args[1] === 1_000) retryScheduled.resolve();
				return timer;
			}) as typeof setTimeout);
			let heartbeatAttempts = 0;
			const client = {
				hello: { protocol: { version: 3 } },
				supportsServerCapability: () => true,
				reconnect: vi.fn(async () => {}),
				request: vi.fn(async (command: { type: string }) => {
					if (command.type === "list") return { success: true, data: { sessions: [live] } };
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
				rosterStore: { attach: vi.fn(async () => true), summaries: () => [live] },
				refreshSavedSessions: vi.fn(async () => true),
				refreshHeartbeats: vi.fn(async (_options?: { duringReconnect?: boolean }) => false),
				armSavedSearchFetch: vi.fn(),
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
			await retryScheduled.promise;

			expect(harness.reconnectPromise).toBeDefined();
			expect(harness.applySessionList).not.toHaveBeenCalled();
			expect(client.reconnect).toHaveBeenCalledOnce();

			await vi.advanceTimersByTimeAsync(1_000);
			await harness.reconnectPromise;

			expect(client.reconnect).toHaveBeenCalledTimes(2);
			expect(harness.applySessionList).toHaveBeenCalledWith([live], true);
			expect(harness.heartbeats).toEqual([{ job: { id: "healthy" } }]);
			// A query that outlived the outage re-fetches the saved catalog through the one arm predicate.
			expect(harness.armSavedSearchFetch).toHaveBeenCalledWith({ duringReconnect: true });
			expect(harness.reconnectPromise).toBeUndefined();
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	test("a pending saved scan cannot overwrite daemon shutdown status", async () => {
		const scan = createDeferred<void>();
		const harness = savedScanHarness([], {
			request: async () => {
				await scan.promise;
				throw new Error("scan failed");
			},
		});

		const pending = privateMethod<(this: typeof harness) => Promise<boolean>>("refreshSavedSessions").call(harness);
		harness.daemonShutdownReceived = true;
		scan.resolve();
		expect(await pending).toBe(false);
		expect(harness.setStatusMessage).not.toHaveBeenCalled();
	});
});
