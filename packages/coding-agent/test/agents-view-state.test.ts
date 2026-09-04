import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { SettingsManager } from "../src/core/settings-manager.js";
import {
	createAgentsViewListCommand,
	createAgentsViewReplyHeadline,
	createAgentsViewResumeConfig,
	createInitialAgentsViewPersistentState,
	createInitialAgentsViewScopeFrames,
	createScopeBackReturnChatOpenResult,
	formatAgentsViewRelativeTime,
	formatAgentsViewStatusLine,
	getAgentsViewDepth,
	resolveAgentsViewActiveSummaryForPath,
	resolveAgentsViewOpenCwd,
	resolveAgentsViewSessionUiServices,
	shouldReconnectAgentsViewDaemon,
} from "../src/modes/agents-view/agents-view-mode.js";
import { summaryForUnifiedRecord } from "../src/modes/agents-view/agents-view-state.js";
import {
	type AgentsViewScopeFrame,
	aggregateSessionHeartbeats,
	buildAgentsViewRows,
	buildUnifiedSessionIndex,
	classifyAgentsViewSession,
	computeRecursiveCosts,
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
import { formatAgentDepthLabel } from "../src/modes/interactive/interactive-mode.js";
import type { InteractiveModeUiServices } from "../src/modes/interactive/interactive-mode-services.js";
import type { Theme } from "../src/modes/interactive/theme/theme.js";

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

	test("classifies sessions by live runtime status at any depth", () => {
		expect(classifyAgentsViewSession(makeSummary({ isStreaming: true, activity: "working" }))).toBe("running");
		expect(
			classifyAgentsViewSession(
				makeSummary({ sessionActions: { queuedCount: 1, steering: [], followUps: [] }, activity: "working" }),
			),
		).toBe("running");
		expect(classifyAgentsViewSession(makeSummary({ activity: "working" }))).toBe("running");
		expect(
			classifyAgentsViewSession(
				makeSummary({ runtimeKind: "subagent", rlmDepth: 3, activity: "working", isSessionActive: true }),
			),
		).toBe("running");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", messageCount: 2 }))).toBe("idle");
		expect(classifyAgentsViewSession(makeSummary({ runtimeKind: "subagent", activity: "idle" }))).toBe("idle");
		expect(
			classifyAgentsViewSession(
				makeSummary({
					activeSessionId: undefined,
					runtimeKind: "subagent",
					rlmDepth: 3,
					activity: "working",
					isSessionActive: true,
					hasActiveHeartbeat: true,
				}),
			),
		).toBe("inactive");
	});

	test("places all non-busy resident sessions in Idle", () => {
		// Working is heuristic and ignores taskState.
		expect(
			classifyAgentsViewSession(makeSummary({ isStreaming: true, activity: "working", taskState: "completed" })),
		).toBe("running");
		// Secondary completion verdicts do not create extra sections.
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: "needs_input" }))).toBe("idle");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: "completed" }))).toBe("idle");
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: undefined }))).toBe("idle");
	});

	test("armed heartbeats stay Idle between firings; only real work is Running", () => {
		expect(classifyAgentsViewSession(makeSummary({ activity: "working", hasActiveHeartbeat: true }))).toBe("running");
		expect(
			classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: "completed", hasActiveHeartbeat: true })),
		).toBe("idle");

		const [row] = buildAgentsViewRows([makeSummary({ activity: "idle", hasActiveHeartbeat: true })]);
		expect(row).toMatchObject({ section: "idle", statusLabel: "heartbeat active" });
		const [busyRow] = buildAgentsViewRows([
			makeSummary({ activity: "working", hasActiveHeartbeat: true, isStreaming: true, isRunningTools: true }),
		]);
		expect(busyRow).toMatchObject({ section: "running", statusLabel: "running tools" });
		expect(sectionTitle("idle")).toBe("Idle");
	});

	test("labels replied subagents with active heartbeats as heartbeat active", () => {
		const summaries = [
			makeSummary({
				id: "replied-child",
				activeSessionId: "replied-child",
				sessionId: "replied-child-session",
				sessionName: "Replied child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				repliedSinceTask: true,
				hasActiveHeartbeat: true,
				activity: "idle",
			}),
			makeSummary({ id: "parent-active", activeSessionId: "parent-active", sessionId: "parent-session" }),
		];
		const collapsed = buildAgentsViewRows(summaries);
		const expanded = buildAgentsViewRows(summaries, new Set([collapsed[0]?.identity ?? ""]));

		expect(expanded.find((row) => row.title === "Replied child")).toMatchObject({
			section: "idle",
			statusLabel: "heartbeat active",
		});
	});

	test("defaults an idle session with no verdict to needs-input", () => {
		// A slow, failed, or absent classification never lingers in Working; only
		// an explicit completed verdict moves an idle session out of needs-input.
		expect(classifyAgentsViewSession(makeSummary({ activity: "idle", taskState: undefined }))).toBe("idle");
	});

	test("sorts rows by section and creation time", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "completed",
				sessionId: "completed",
				sessionName: "completed",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
				created: "2026-01-03T00:00:00Z",
			}),
			makeSummary({
				id: "older-working",
				sessionId: "older-working",
				sessionName: "older working",
				activity: "working",
				isStreaming: true,
				created: "2026-01-01T00:00:00Z",
			}),
			makeSummary({
				id: "newer-working",
				sessionId: "newer-working",
				sessionName: "newer working",
				activity: "working",
				isStreaming: true,
				created: "2026-01-02T00:00:00Z",
			}),
			makeSummary({
				sessionName: "heartbeat",
				activity: "idle",
				hasActiveHeartbeat: true,
				modified: "2026-01-03T00:00:00Z",
			}),
		]);

		expect(rows.map((row) => row.title)).toEqual(["newer working", "older working", "completed", "heartbeat"]);
		expect(rows.map((row) => row.section)).toEqual(["running", "running", "idle", "idle"]);
	});

	test("keeps row order stable when activity and modification times and daemon input order change", () => {
		const older = makeSummary({
			id: "older",
			sessionId: "older",
			sessionName: "older",
			activity: "working",
			created: "2026-01-01T00:00:00Z",
			modified: "2026-01-04T00:00:00Z",
			lastActivityAt: "2026-01-04T00:00:00Z",
		});
		const newer = makeSummary({
			id: "newer",
			sessionId: "newer",
			sessionName: "newer",
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

	test("uses deterministic fallbacks when creation times are unavailable", () => {
		const rows = buildAgentsViewRows([
			makeSummary({ id: "beta-2", sessionId: "beta-2", sessionName: "beta", modified: "2026-01-03T00:00:00Z" }),
			makeSummary({ id: "alpha", sessionId: "alpha", sessionName: "alpha", modified: "2026-01-02T00:00:00Z" }),
			makeSummary({ id: "beta-1", sessionId: "beta-1", sessionName: "beta", modified: "2026-01-01T00:00:00Z" }),
		]);

		expect(rows.map((row) => row.summary.sessionId)).toEqual(["alpha", "beta-1", "beta-2"]);
	});

	test("sorts idle rows by last message activity, newest first", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "created-newest",
				sessionId: "created-newest",
				sessionName: "created newest",
				activity: "idle",
				created: "2026-01-03T00:00:00Z",
				lastActivityAt: "2026-01-01T00:00:00Z",
			}),
			makeSummary({
				id: "middle",
				sessionId: "middle",
				sessionName: "middle",
				activity: "idle",
				created: "2026-01-02T00:00:00Z",
				lastActivityAt: "2026-01-02T00:00:00Z",
			}),
			makeSummary({
				id: "active-newest",
				sessionId: "active-newest",
				sessionName: "active newest",
				activity: "idle",
				created: "2026-01-01T00:00:00Z",
				lastActivityAt: "2026-01-03T00:00:00Z",
			}),
			makeSummary({
				id: "running-oldest",
				sessionId: "running-oldest",
				sessionName: "running oldest",
				activity: "working",
				isStreaming: true,
				created: "2025-12-31T00:00:00Z",
				lastActivityAt: "2025-12-31T00:00:00Z",
			}),
		]);

		expect(rows.map((row) => row.summary.sessionId)).toEqual([
			"running-oldest",
			"active-newest",
			"middle",
			"created-newest",
		]);
		expect(rows.map((row) => row.section)).toEqual(["running", "idle", "idle", "idle"]);
	});

	test("armed heartbeats rank first within the inactive section", () => {
		const rows = buildAgentsViewRows([
			makeSummary({
				id: "recent",
				activeSessionId: undefined,
				sessionId: "recent",
				sessionName: "recent",
				lastActivityAt: "2026-01-03T00:00:00Z",
			}),
			makeSummary({
				id: "beating",
				activeSessionId: undefined,
				sessionId: "beating",
				sessionName: "beating",
				hasActiveHeartbeat: true,
				lastActivityAt: "2026-01-01T00:00:00Z",
			}),
		]);

		expect(rows.map((row) => row.section)).toEqual(["inactive", "inactive"]);
		expect(rows.map((row) => row.summary.sessionId)).toEqual(["beating", "recent"]);
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

	test("surfaces an idle retained subagent heartbeat while its parent is collapsed", () => {
		const summaries = [
			makeSummary({
				id: "heartbeat-child",
				activeSessionId: "heartbeat-child",
				sessionId: "heartbeat-child-session",
				sessionName: "Heartbeat child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				hasActiveHeartbeat: true,
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed[0]).toMatchObject({
			kind: "agent",
			section: "idle",
			statusLabel: "completed",
		});
		expect(collapsed[1]).toMatchObject({
			kind: "subagent-summary",
			section: "idle",
			title: "1 subagent · 1 heartbeat active",
			runningSubagentCount: 0,
		});
		const expanded = buildAgentsViewRows(summaries, new Set([collapsed[0]?.identity ?? ""]));
		expect(expanded[1]).toMatchObject({ kind: "subagent-summary", expanded: true });
		expect(expanded[2]).toMatchObject({
			kind: "subagent",
			section: "idle",
			statusLabel: "heartbeat active",
		});
	});

	test("counts a busy grandchild on every idle ancestor without promoting them", () => {
		const summaries = [
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				activity: "idle",
				taskState: "completed",
				hasRunningRlmChildren: true,
				messageCount: 2,
			}),
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				taskState: "completed",
			}),
			makeSummary({
				id: "grandchild-active",
				activeSessionId: "grandchild-active",
				sessionId: "grandchild-session",
				sessionName: "Grandchild",
				runtimeKind: "subagent",
				parentActiveSessionId: "child-active",
				activity: "working",
				isSessionActive: true,
				isStreaming: true,
			}),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed[0]).toMatchObject({ kind: "agent", section: "idle", runningSubagentCount: 1 });
		expect(collapsed[0]?.statusLabel).toBe("completed");
		expect(collapsed[1]).toMatchObject({ kind: "subagent-summary", section: "idle", title: "1 subagent running" });

		const expanded = buildAgentsViewRows(summaries, new Set([collapsed[0]?.identity ?? ""]));
		const childRow = expanded.find((row) => row.title === "Child");
		expect(childRow).toMatchObject({ kind: "subagent", section: "idle", runningSubagentCount: 1 });
	});

	test("keeps heartbeat-armed descendants out of the busy tally", () => {
		const summaries = [
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				taskState: "completed",
			}),
			makeSummary({
				id: "grandchild-active",
				activeSessionId: "grandchild-active",
				sessionId: "grandchild-session",
				sessionName: "Heartbeat grandchild",
				runtimeKind: "subagent",
				parentActiveSessionId: "child-active",
				hasActiveHeartbeat: true,
				activity: "idle",
			}),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed[0]?.runningSubagentCount).toBe(0);
		expect(collapsed[1]).toMatchObject({ kind: "subagent-summary", section: "idle", title: "1 subagent" });
		const expanded = buildAgentsViewRows(summaries, new Set([collapsed[0]?.identity ?? ""]));
		expect(expanded.find((row) => row.title === "Child")?.runningSubagentCount).toBe(0);
	});

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
		const costs = computeRecursiveCosts(records);
		const filtered = filterUnifiedSessions(records, (text) => text.includes("Searchable"));

		expect(filtered).toHaveLength(1);
		const rows = buildAgentsViewRows(filtered, new Set(), new Set(), undefined, costs);
		expect(rows[0]?.summary.usage?.cost).toBe(0.42);
		expect(rows[0]?.recursiveCost).toBeCloseTo(1.28);
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
		const beforeTotal = computeRecursiveCosts(before).get(before[0]!);

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
		const afterTotal = computeRecursiveCosts(after).get(after[0]!);

		expect(beforeTotal).toBeCloseTo(1.1);
		expect(afterTotal).toBe(beforeTotal);
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

	test("leaves completed ancestors idle while a descendant heartbeat is armed", () => {
		const summaries = [
			makeSummary({
				id: "heartbeat-grandchild",
				activeSessionId: "heartbeat-grandchild",
				sessionId: "heartbeat-grandchild-session",
				sessionName: "Heartbeat grandchild",
				runtimeKind: "subagent",
				parentActiveSessionId: "child-active",
				hasActiveHeartbeat: true,
				activity: "idle",
				taskState: "completed",
			}),
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "root-active",
				activity: "idle",
				taskState: "completed",
			}),
			makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionName: "Root",
				activity: "idle",
				taskState: "completed",
			}),
		];

		const rootIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		const oneLevel = buildAgentsViewRows(summaries, new Set([rootIdentity]));
		const child = oneLevel.find((row) => row.title === "Child");
		expect(oneLevel[0]).toMatchObject({ section: "idle", statusLabel: "completed" });
		expect(child).toMatchObject({ section: "idle", statusLabel: "completed" });

		const childIdentity = child?.identity ?? "";
		const expanded = buildAgentsViewRows(summaries, new Set([rootIdentity, childIdentity]));
		expect(
			expanded
				.filter((row) => row.kind === "agent" || row.kind === "subagent")
				.map((row) => [row.title, row.section, row.statusLabel]),
		).toEqual([
			["Root", "idle", "completed"],
			["Child", "idle", "completed"],
			["Heartbeat grandchild", "idle", "heartbeat active"],
		]);
	});

	test("expands subagent rows for expanded parents and collapses otherwise", () => {
		const summaries = [
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionFile: "/tmp/child.jsonl",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "completed-child-active",
				activeSessionId: "completed-child-active",
				sessionId: "completed-child-session",
				sessionFile: "/tmp/completed-child.jsonl",
				sessionName: "Completed child",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				activity: "idle",
				taskState: "completed",
				messageCount: 2,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionFile: "/tmp/parent.jsonl",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
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
			makeSummary({
				id: "grandchild-active",
				activeSessionId: "grandchild-active",
				sessionId: "grandchild-session",
				sessionName: "Grandchild",
				runtimeKind: "subagent",
				parentActiveSessionId: "child-active",
				parentSessionId: "child-session",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "child-active",
				activeSessionId: "child-active",
				sessionId: "child-session",
				sessionName: "Child",
				runtimeKind: "subagent",
				parentActiveSessionId: "root-active",
				parentSessionId: "root-session",
				isStreaming: true,
				activity: "working",
			}),
			makeSummary({
				id: "root-active",
				activeSessionId: "root-active",
				sessionId: "root-session",
				sessionName: "Root",
				isStreaming: true,
				activity: "working",
			}),
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

	test("groups expanded subagents by spawn code and reveals the program", () => {
		const codeA = "task = sleep(60)\nfor i in range(2):\n    run_subagent(i, task)";
		const codeB = ["a = 1", "b = 2", "c = 3", "d = 4", "e = 5", "f = 6"].join("\n");
		const summaries = [
			makeSummary({
				id: "a1",
				activeSessionId: "a1",
				sessionId: "a1-session",
				sessionName: "A1",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: codeA,
				modified: "2026-01-01T00:00:04Z",
			}),
			makeSummary({
				id: "a2",
				activeSessionId: "a2",
				sessionId: "a2-session",
				sessionName: "A2",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: codeA,
				modified: "2026-01-01T00:00:03Z",
			}),
			makeSummary({
				id: "b1",
				activeSessionId: "b1",
				sessionId: "b1-session",
				sessionName: "B1",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: codeB,
				modified: "2026-01-01T00:00:02Z",
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
		];

		const collapsed = buildAgentsViewRows(summaries);
		expect(collapsed[1]?.kind).toBe("subagent-summary");
		expect(collapsed[1]?.hasSpawnCode).toBe(true);

		const parentIdentity = collapsed[0]?.identity ?? "";
		const expandedNoProgram = buildAgentsViewRows(summaries, new Set([parentIdentity]));
		// Without the program toggle, only the summary and grouped subagent rows render.
		expect(expandedNoProgram.map((row) => row.kind)).toEqual([
			"agent",
			"subagent-summary",
			"subagent",
			"subagent",
			"subagent",
		]);

		const expanded = buildAgentsViewRows(summaries, new Set([parentIdentity]), new Set([parentIdentity]));
		// Each spawn cell renders in full, once, directly above the subagents it
		// launched — padded with a blank panel line above and below, no truncation.
		expect(expanded.map((row) => [row.kind, row.code ?? row.title])).toEqual([
			["agent", "Parent"],
			["subagent-summary", "3 subagents"],
			["subagent-code", ""],
			["subagent-code", "task = sleep(60)"],
			["subagent-code", "for i in range(2):"],
			["subagent-code", "    run_subagent(i, task)"],
			["subagent-code", ""],
			["subagent", "A1"],
			["subagent", "A2"],
			["subagent-code", ""],
			["subagent-code", "a = 1"],
			["subagent-code", "b = 2"],
			["subagent-code", "c = 3"],
			["subagent-code", "d = 4"],
			["subagent-code", "e = 5"],
			["subagent-code", "f = 6"],
			["subagent-code", ""],
			["subagent", "B1"],
		]);
		expect(expanded.every((row) => row.kind !== "subagent-code" || !row.selectable)).toBe(true);
	});

	test("caps spawn code at 10 lines with a remainder note", () => {
		const longCode = Array.from({ length: 25 }, (_, i) => `line_${i}`).join("\n");
		const summaries = [
			makeSummary({
				id: "c1",
				activeSessionId: "c1",
				sessionId: "c1-session",
				sessionName: "C1",
				runtimeKind: "subagent",
				parentActiveSessionId: "parent-active",
				spawnCode: longCode,
			}),
			makeSummary({
				id: "parent-active",
				activeSessionId: "parent-active",
				sessionId: "parent-session",
				sessionName: "Parent",
				isStreaming: true,
				activity: "working",
			}),
		];
		const parentIdentity = buildAgentsViewRows(summaries)[0]?.identity ?? "";
		const rows = buildAgentsViewRows(summaries, new Set([parentIdentity]), new Set([parentIdentity]));
		const codeLines = rows.filter((row) => row.kind === "subagent-code").map((row) => row.code);
		// 10 capped body lines + the "more" note + two blank pad lines.
		const bodyLines = codeLines.filter((line) => line !== "");
		expect(bodyLines).toHaveLength(11);
		expect(bodyLines.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => `line_${i}`));
		expect(bodyLines[10]).toBe("… +15 more lines");
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

	test("keeps sessions of non-ready workers visible and labels them with the worker state", () => {
		for (const workerState of ["starting", "recovering", "stopping", "failed"] as const) {
			const summary = makeSummary({ lifecycle: "live", workerState });
			expect(shouldShowAgentsViewSession(summary), workerState).toBe(true);
			expect(buildAgentsViewRows([summary])[0]?.statusLabel, workerState).toBe(workerState);
		}
		expect(buildAgentsViewRows([makeSummary({ workerState: "ready" })])[0]?.statusLabel).toBe("needs input");
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

	test("derives the reply headline from the first line of the latest assistant text", () => {
		expect(createAgentsViewReplyHeadline("  Done.\nNext step?  ")).toBe("Done.");
		expect(createAgentsViewReplyHeadline("\n\n  spread   over \nlines")).toBe("spread over");
		expect(createAgentsViewReplyHeadline("   \n  ")).toBeUndefined();
		expect(createAgentsViewReplyHeadline(undefined)).toBeUndefined();
	});

	test("formats relative timestamps for the reply header", () => {
		const now = Date.parse("2026-01-02T12:00:00Z");
		expect(formatAgentsViewRelativeTime("2026-01-02T11:59:30Z", now)).toBe("30s");
		expect(formatAgentsViewRelativeTime("2026-01-02T11:15:00Z", now)).toBe("45m");
		expect(formatAgentsViewRelativeTime("2026-01-02T06:00:00Z", now)).toBe("6h");
		expect(formatAgentsViewRelativeTime("2025-12-30T12:00:00Z", now)).toBe("3d");
		expect(formatAgentsViewRelativeTime(undefined, now)).toBe("");
		expect(formatAgentsViewRelativeTime("not a timestamp", now)).toBe("");
	});

	test("flattens multiline status messages so they fit the single-row hint slot", () => {
		expect(formatAgentsViewStatusLine("Failed to send reply: connection lost\nat Socket.emit\nat process")).toBe(
			"Failed to send reply: connection lost at Socket.emit at process",
		);
		expect(formatAgentsViewStatusLine('Failed:\r\n\t{\r\n\t"error": "boom"\r\n}')).toBe(
			'Failed: { "error": "boom" }',
		);
		expect(formatAgentsViewStatusLine("  already   flat  ")).toBe("already flat");
		expect(formatAgentsViewStatusLine("\n \r\n ")).toBe("");
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

	describe("stored depth display", () => {
		test("labels the global agents view as depth zero and scoped views at their child level", () => {
			expect(getAgentsViewDepth(undefined)).toBe(0);
			expect(getAgentsViewDepth(makeSummary({ rlmDepth: 0 }))).toBe(1);
			expect(getAgentsViewDepth(makeSummary({ rlmDepth: 3 }))).toBe(4);
		});

		test("never infers a chat depth when the persisted field is absent", () => {
			expect(formatAgentDepthLabel(undefined, true)).toBeUndefined();
			expect(formatAgentDepthLabel(0, false)).toBeUndefined();
			expect(formatAgentDepthLabel(0, true)).toBe("depth 0");
			expect(formatAgentDepthLabel(3, false)).toBe("depth 3");
		});
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
