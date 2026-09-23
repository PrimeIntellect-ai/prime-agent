import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { RlmChildAgentSnapshot } from "../src/core/agent-session.js";
import type { AgentSessionRuntimeDiagnostic } from "../src/core/agent-session-services.js";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import type { SessionActionSnapshot } from "../src/core/session-action-store.js";
import type { AgentStatus, SessionInfo } from "../src/core/session-manager.js";
import type { SessionUsageSummary } from "../src/core/usage.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import { passivatedWorkerRosterEntry, workerRosterEntryFromSummary } from "../src/modes/daemon/agent-roster.js";
import {
	buildRlmChildSnapshots,
	buildSessionList,
	latestMessageActivityAt,
	type MessageActivityMemo,
	resolveAttachModelFallbackMessage,
	type SessionSummary,
	sessionDisplayLabels,
	summaryForActiveSession,
} from "../src/modes/daemon/daemon-session-list.js";

describe("buildSessionList", () => {
	const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
	const currentSummary = { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"];

	// Activity/lifecycle projection: one row per state shape the view must render honestly.
	it.each([
		["a streaming session is working", { isStreaming: true, messages: oneMessage }, { activity: "working" }],
		[
			"a streaming session waiting on a tool is working",
			{ isStreaming: true, pendingToolCalls: ["tool-1"], messages: oneMessage },
			{ activity: "working" },
		],
		[
			"an attached settled session is idle",
			{ clients: 1, messages: oneMessage, summaryState: currentSummary },
			{ activity: "idle" },
		],
		[
			"a detached settled session is idle",
			{ messages: oneMessage, summaryState: currentSummary },
			{ activity: "idle" },
		],
		["an empty resident session is idle", {}, { activity: "idle" }],
		[
			"a finished subagent is idle instead of stuck working",
			{
				isStreaming: false,
				hasRunningRlmChildren: false,
				messages: oneMessage,
				metadata: { kind: "subagent" as const, createdAt: 1, parentActiveSessionId: "parent", rlmChildId: "c1" },
			},
			{ activity: "idle" },
		],
		[
			"an accepted in-flight prompt is working with no queued work",
			{ messages: oneMessage, summaryState: currentSummary, hasAcceptedPromptInFlight: true },
			{ activity: "working", sessionActions: { queuedCount: 0, active: { kind: "turn", phase: "running" } } },
		],
		[
			"the exact unfinished action count survives the visible action snapshot",
			{ unfinishedActionCount: 3, hasAcceptedPromptInFlight: true },
			{
				activity: "working",
				unfinishedActionCount: 3,
				sessionActions: { queuedCount: 0, active: { kind: "turn" } },
			},
		],
	])("%s", (_name, options, expected) => {
		const summary = summaryForActiveSession(makeState({ activeSessionId: "active-1", ...options }));

		expect(summary).toMatchObject(expected);
	});

	it("counts direct peers separately so the supervisor can add them to its own attachment count", () => {
		const state = makeState({ activeSessionId: "direct", sessionFile: "/tmp/direct.jsonl" });
		state.clients.add({ id: "supervisor", authenticationRole: "supervisor" } as unknown as DaemonSocketClient);
		state.clients.add({ id: "peer", authenticationRole: "session_client" } as unknown as DaemonSocketClient);

		const [summary] = buildSessionList([state], []);

		expect(summary).toMatchObject({ attachedClients: 2, directAttachedClients: 1 });
		// Passivated roster rows describe a session without a runtime; the live-only count must not survive.
		expect(
			passivatedWorkerRosterEntry(workerRosterEntryFromSummary(summary!)).summary.directAttachedClients,
		).toBeUndefined();
	});

	it("uses the stable session header time for active rows without a saved catalog entry", () => {
		const state = makeState({ activeSessionId: "active", sessionFile: "/tmp/active.jsonl" });
		const first = summaryForActiveSession(state);
		const second = summaryForActiveSession(state);
		expect(first.created).toBe("2026-05-01T00:00:00.000Z");
		expect(first.lastActivityAt).toBe("2026-05-01T00:00:00.000Z");
		expect(second.created).toBe(first.created);
	});

	it("takes last activity from custom messages and tool results", () => {
		const oldMessage = {
			role: "user",
			content: "old",
			timestamp: Date.parse("2026-05-02T00:00:00.000Z"),
		} as AgentMessage;
		const customTimestamp = Date.parse("2026-05-03T00:00:00.000Z");
		const customMessage = {
			role: "custom",
			customType: "activity",
			content: "newer",
			display: false,
			timestamp: customTimestamp,
		} as AgentMessage;
		const toolResultTimestamp = Date.parse("2026-05-04T00:00:00.000Z");
		const toolResult = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "example",
			content: [],
			isError: false,
			timestamp: toolResultTimestamp,
		} as AgentMessage;

		expect(
			summaryForActiveSession(makeState({ activeSessionId: "custom-active", messages: [oldMessage, customMessage] }))
				.lastActivityAt,
		).toBe(new Date(customTimestamp).toISOString());
		expect(
			summaryForActiveSession(makeState({ activeSessionId: "tool-active", messages: [oldMessage, toolResult] }))
				.lastActivityAt,
		).toBe(new Date(toolResultTimestamp).toISOString());
	});

	it("ignores message timestamps outside the valid Date range", () => {
		const validTimestamp = Date.parse("2026-05-04T00:00:00.000Z");
		const messages = [
			{ role: "user", content: "valid", timestamp: validTimestamp },
			{ role: "assistant", content: "corrupt", timestamp: 8.64e15 + 1 },
		] as AgentMessage[];

		const summary = summaryForActiveSession(makeState({ activeSessionId: "invalid-timestamp", messages }));

		expect(summary.lastActivityAt).toBe(new Date(validTimestamp).toISOString());
	});

	it("publishes own-session usage on active and saved rows", () => {
		const usage: SessionUsageSummary = { inputTokens: 12437, outputTokens: 1234, cost: 0.42 };
		const [active, saved] = buildSessionList(
			[makeState({ activeSessionId: "spender", usage })],
			[makeSessionInfo({ id: "saved-spender", path: "/tmp/saved-spender.jsonl", usage })],
		);
		expect(active?.usage).toEqual(usage);
		expect(saved?.usage).toEqual(usage);
	});

	it("keeps background subagents on the wire while the settled parent goes idle", () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const entries = buildSessionList(
			[
				makeState({
					activeSessionId: "parent",
					sessionFile: "/tmp/parent.jsonl",
					isStreaming: false,
					hasRunningRlmChildren: true,
					messages: oneMessage,
					summaryState: { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"],
				}),
			],
			[],
		);
		expect(entries[0]?.activity).toBe("idle");
		expect(entries[0]?.hasRunningRlmChildren).toBe(true);
	});

	it("marks sessions with active standard or RLM heartbeats", () => {
		const messages = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const summaryState = { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"];
		const activeSessionIds = ["heartbeat", "rlm-heartbeat", "paused-heartbeat", "cron"];
		const entries = buildSessionList(
			activeSessionIds.map((activeSessionId) => makeState({ activeSessionId, messages, summaryState })),
			[makeSessionInfo({ id: "passive", path: "/tmp/passive.jsonl" })],
			[
				makeCronJob({ id: "heartbeat-job", activeSessionId: "heartbeat", source: "heartbeat" }),
				makeCronJob({ id: "rlm-job", activeSessionId: "rlm-heartbeat", source: "rlm_heartbeat" }),
				makeCronJob({
					id: "paused-job",
					activeSessionId: "paused-heartbeat",
					source: "heartbeat",
					status: "paused",
				}),
				makeCronJob({ id: "cron-job", activeSessionId: "cron", source: "cron" }),
				makeCronJob({
					id: "passive-job",
					activeSessionId: "old-passive-active-id",
					sessionFile: "/tmp/passive.jsonl",
					source: "rlm_heartbeat",
				}),
			],
		);

		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.hasActiveHeartbeat]))).toEqual({
			heartbeat: true,
			"rlm-heartbeat": true,
			"paused-heartbeat": undefined,
			cron: undefined,
			passive: undefined,
		});
		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.hasRegisteredHeartbeat]))).toEqual({
			heartbeat: true,
			"rlm-heartbeat": true,
			"paused-heartbeat": undefined,
			cron: undefined,
			passive: true,
		});
		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.hasRegisteredCronJob]))).toEqual({
			heartbeat: undefined,
			"rlm-heartbeat": undefined,
			"paused-heartbeat": undefined,
			cron: true,
			passive: undefined,
		});
	});

	it("keeps file-keyed schedule pins on active rows while active ids are being rebound", () => {
		const sessionFile = "/tmp/child.jsonl";
		const [entry] = buildSessionList(
			[makeState({ activeSessionId: "new-active-id", sessionFile })],
			[makeSessionInfo({ id: "child-session", path: sessionFile })],
			[
				makeCronJob({
					id: "stale-heartbeat",
					activeSessionId: "old-active-id",
					sessionFile,
					source: "heartbeat",
				}),
				makeCronJob({
					id: "stale-cron",
					activeSessionId: "old-active-id",
					sessionFile,
					source: "cron",
				}),
			],
		);

		expect(entry).toMatchObject({ hasRegisteredHeartbeat: true, hasRegisteredCronJob: true });
	});

	it("marks a retained completed subagent with an active RLM heartbeat", () => {
		const messages = [{ role: "user", content: "initialize a heartbeat" }] as unknown as AgentMessage[];
		const entries = buildSessionList(
			[
				makeState({
					activeSessionId: "parent",
					sessionId: "parent-session",
					messages,
				}),
				makeState({
					activeSessionId: "child",
					sessionId: "child-session",
					sessionFile: "/tmp/child.jsonl",
					messages,
					metadata: {
						kind: "subagent",
						createdAt: 1,
						parentActiveSessionId: "parent",
						parentSessionId: "parent-session",
						rlmChildId: "child-1",
					},
				}),
			],
			[],
			[makeCronJob({ id: "rlm-job", activeSessionId: "child", source: "rlm_heartbeat" })],
		);

		expect(entries.find((entry) => entry.id === "child")).toMatchObject({
			runtimeKind: "subagent",
			activity: "idle",
			hasActiveHeartbeat: true,
		});
	});

	it("merges active records with saved sessions and marks inactive sessions", () => {
		const activePath = resolve("/tmp/project/active.jsonl");
		const sleepingPath = resolve("/tmp/project/sleeping.jsonl");
		const crashedPath = resolve("/tmp/project/crashed.jsonl");
		const savedSessions = [
			makeSessionInfo({ path: activePath, id: "saved-active", name: "active saved" }),
			makeSessionInfo({
				path: sleepingPath,
				id: "saved-sleeping",
				name: "sleeping saved",
				state: { status: "archived" },
			}),
			makeSessionInfo({ path: crashedPath, id: "saved-crashed", state: { status: "crash" } }),
		];

		const entries = buildSessionList(
			[
				makeState({
					activeSessionId: "active-1",
					sessionFile: activePath,
					sessionId: "saved-active",
					messages: [{ role: "user", content: "hi" }] as unknown as AgentMessage[],
					summaryState: { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"],
				}),
			],
			savedSessions,
		);

		expect(entries).toHaveLength(3);
		expect(entries.map((entry) => [entry.id, entry.sessionId, entry.lifecycle, entry.activity])).toEqual([
			["active-1", "saved-active", "live", "idle"],
			["saved-sleeping", "saved-sleeping", "archived", "idle"],
			["saved-crashed", "saved-crashed", "archived", "idle"],
		]);
		expect(entries[0]!.sessionName).toBe("session active-1");
	});

	it("keeps a resident message-less subagent live while a top-level one stays a draft", () => {
		const entries = buildSessionList(
			[
				makeState({
					activeSessionId: "child",
					metadata: { kind: "subagent", createdAt: 1, rlmChildId: "child-1" },
				}),
				makeState({ activeSessionId: "top" }),
			],
			[],
		);

		expect(entries.map((entry) => [entry.id, entry.lifecycle])).toEqual([
			["child", "live"],
			["top", "draft"],
		]);
	});

	it("treats a message-less on-disk active session as a hidden draft", () => {
		const emptyPath = resolve("/tmp/project/empty.jsonl");
		const usedPath = resolve("/tmp/project/used.jsonl");
		const entries = buildSessionList(
			[],
			[
				// Active record, no messages: a draft, hidden from the view (lifecycle is
				// message-based; any config it holds is still preserved on disk).
				makeSessionInfo({
					path: emptyPath,
					id: "empty",
					messageCount: 0,
					name: "named draft",
					state: { status: "active" },
				}),
				// Active record with a message: a real conversation, stays live.
				makeSessionInfo({
					path: usedPath,
					id: "used",
					messageCount: 1,
					state: { status: "active" },
				}),
			],
		);
		expect(entries.map((entry) => [entry.id, entry.lifecycle])).toEqual([
			["empty", "draft"],
			["used", "live"],
		]);
	});

	it("shows an off-daemon session with messages but no lifecycle entry as live", () => {
		// Older sessions never wrote a session_state entry; a missing state must not
		// be treated as archived, or those conversations vanish from the view.
		const [entry] = buildSessionList(
			[],
			[
				makeSessionInfo({
					path: resolve("/tmp/project/legacy.jsonl"),
					id: "legacy",
					messageCount: 4,
					state: undefined,
				}),
			],
		);
		expect(entry?.lifecycle).toBe("live");
	});

	it("carries the persisted recap and verdict for off-daemon sessions", () => {
		const path = resolve("/tmp/project/done.jsonl");
		const [entry] = buildSessionList(
			[],
			[
				makeSessionInfo({
					path,
					id: "done",
					messageCount: 3,
					state: { status: "active" },
					agentStatus: { summary: "Shipped the fix", taskState: "completed", basedOnMessageCount: 3 },
				}),
			],
		);
		expect(entry).toMatchObject({ summary: "Shipped the fix", taskState: "completed" });
	});

	it("drops a stale persisted verdict when later messages outpaced it", () => {
		const path = resolve("/tmp/project/stale.jsonl");
		const [entry] = buildSessionList(
			[],
			[
				makeSessionInfo({
					path,
					id: "stale",
					messageCount: 5,
					state: { status: "active" },
					// Verdict was based on an earlier turn (3 < 5), so it must not show.
					agentStatus: { summary: "Old recap", taskState: "completed", basedOnMessageCount: 3 },
				}),
			],
		);
		expect(entry?.summary).toBeUndefined();
		expect(entry?.taskState).toBeUndefined();
	});

	it("includes active subagent parent metadata", () => {
		const entries = buildSessionList(
			[
				makeState({ activeSessionId: "parent", sessionFile: "/tmp/parent.jsonl", sessionId: "parent-session" }),
				makeState({
					activeSessionId: "child",
					sessionFile: "/tmp/child.jsonl",
					sessionId: "child-session",
					metadata: {
						kind: "subagent",
						createdAt: 1,
						parentActiveSessionId: "parent",
						parentSessionId: "parent-session",
						parentSessionFile: "/tmp/parent.jsonl",
						rlmChildId: "rlm-child",
						rlmParentNodeId: "rlm-child",
						prompt: "Audit the   retry\nlogic for races",
					},
				}),
			],
			[],
		);

		expect(entries.find((entry) => entry.id === "child")).toMatchObject({
			runtimeKind: "subagent",
			parentActiveSessionId: "parent",
			parentSessionId: "parent-session",
			parentSessionPath: "/tmp/parent.jsonl",
			rlmChildId: "rlm-child",
			rlmParentNodeId: "rlm-child",
			// The spawn prompt doubles as the subagent's display title.
			firstMessage: "Audit the retry logic for races",
		});
	});

	it("uses runtime depth for live rows and catalog depth for saved-only rows", () => {
		const livePath = resolve("/tmp/project/live-depth.jsonl");
		const savedPath = resolve("/tmp/project/saved-depth.jsonl");
		const entries = buildSessionList(
			[makeState({ activeSessionId: "live", sessionFile: livePath, rlmDepth: 2 })],
			[
				makeSessionInfo({ path: livePath, id: "live", rlmDepth: 99 }),
				makeSessionInfo({ path: savedPath, id: "saved", rlmDepth: 3 }),
			],
		);

		expect(entries.find((entry) => entry.activeSessionId === "live")?.rlmDepth).toBe(2);
		expect(entries.find((entry) => entry.sessionFile === savedPath)?.rlmDepth).toBe(3);
	});
});

describe("summaryForActiveSession recap currency", () => {
	const twoMessages = [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: "ok" },
	] as AgentMessage[];

	it.each([
		[
			"surfaces both recap and verdict while the summary matches the turn",
			twoMessages,
			{ summary: "Editing the router", taskState: "completed" as const, basedOnMessageCount: 2 },
			{ summary: "Editing the router", taskState: "completed" },
		],
		[
			// The recap text must survive so the agents view does not flicker to blank, but a
			// stale "completed" verdict must not show on a turn that is active again.
			"keeps the prior recap and drops the stale verdict once a new turn outpaces the summary",
			[...twoMessages, { role: "user", content: "next" } as AgentMessage],
			{ summary: "Editing the router", taskState: "completed" as const, basedOnMessageCount: 2 },
			{ summary: "Editing the router", taskState: undefined },
		],
		[
			"omits the recap entirely when there is no summary yet",
			twoMessages,
			undefined,
			{ summary: undefined, taskState: undefined },
		],
	])("%s", (_name, messages, summaryState, expected) => {
		const summary = summaryForActiveSession(
			makeState({
				activeSessionId: "s1",
				messages,
				summaryState: summaryState as ActiveSessionState["summaryState"],
			}),
		);

		expect(summary.summary).toBe(expected.summary);
		expect(summary.taskState).toBe(expected.taskState);
	});
});

describe("summary compose memoization", () => {
	const messageAt = (iso: string, content = "hello") =>
		({ role: "user", content, timestamp: Date.parse(iso) }) as AgentMessage;

	it("returns the same summary object when nothing changed", () => {
		const state = makeState({ activeSessionId: "steady", messages: [messageAt("2026-05-01T00:00:00.000Z")] });
		const first = summaryForActiveSession(state);
		expect(first).toMatchObject({ messageCount: 1, lastActivityAt: "2026-05-01T00:00:00.000Z" });
		// Roster flushes recompose every session each cycle; an unchanged session
		// must reuse the previous summary instead of recomposing it.
		expect(summaryForActiveSession(state)).toBe(first);
		expect(Object.isFrozen(first)).toBe(true);
	});

	it("recomposes when a message is appended and folds only the new tail", () => {
		const messages = [messageAt("2026-05-01T00:00:00.000Z")];
		const state = makeState({ activeSessionId: "append", messages });
		const first = summaryForActiveSession(state);
		messages.push(messageAt("2026-05-02T00:00:00.000Z"));
		const second = summaryForActiveSession(state);
		expect(second).not.toBe(first);
		expect(second).toMatchObject({ messageCount: 2, lastActivityAt: "2026-05-02T00:00:00.000Z" });
		// A stale appended timestamp must not unseat the existing latest activity.
		messages.push(messageAt("2026-05-01T12:00:00.000Z"));
		const third = summaryForActiveSession(state);
		expect(third).not.toBe(second);
		expect(third.lastActivityAt).toBe("2026-05-02T00:00:00.000Z");
	});

	it("recomposes when a compose input changes without an append", () => {
		const state = makeState({ activeSessionId: "inputs", messages: [messageAt("2026-05-01T00:00:00.000Z")] });
		const session = state.runtime.session as unknown as Record<string, unknown> & { state: Record<string, unknown> };
		const runtime = state.runtime as unknown as { diagnostics: unknown[]; metadata: Record<string, unknown> };
		const actions: SessionActionSnapshot = { queuedCount: 1, steering: ["revised plan"], followUps: [] };
		const usage: SessionUsageSummary = { inputTokens: 120, outputTokens: 40, cost: 0.03 };
		const model = { provider: "p", id: "m" } as SessionSummary["model"];
		const streaming = messageAt("2026-05-01T00:00:01.000Z");
		const diagnostic: AgentSessionRuntimeDiagnostic = { type: "warning", message: "rebuilt" };
		const verdict: AgentStatus = { summary: "Editing the router", taskState: "completed", basedOnMessageCount: 1 };
		const mutations: Array<[() => unknown, Partial<SessionSummary>]> = [
			[() => Object.assign(state, { summaryState: verdict }), { summary: "Editing the router" }],
			[() => Object.assign(session, { getSessionActionSnapshot: () => actions }), { sessionActions: actions }],
			[() => Object.assign(session, { getOwnUsageSummary: () => usage }), { usage }],
			[() => Object.assign(session, { model }), { model }],
			[() => Object.assign(session.state, { streamingMessage: streaming }), { streamingMessage: streaming }],
			[() => Object.assign(runtime, { diagnostics: [diagnostic] }), { diagnostics: [diagnostic] }],
			[() => Object.assign(runtime.metadata, { spawnCode: "rlm.spawn('x')" }), { spawnCode: "rlm.spawn('x')" }],
			[() => Object.assign(session, { isSessionActive: true }), { activity: "working" }],
			[() => Object.assign(session, { isStreaming: true }), { isStreaming: true }],
		];
		let previous = summaryForActiveSession(state);
		for (const [mutate, expected] of mutations) {
			mutate();
			const next = summaryForActiveSession(state);
			expect(next).not.toBe(previous);
			expect(next).toMatchObject(expected);
			previous = next;
		}
	});

	it("recomposes when heartbeat registration flags differ per call site", () => {
		const state = makeState({ activeSessionId: "flags" });
		const unflagged = summaryForActiveSession(state);
		expect(unflagged.hasActiveHeartbeat).toBeUndefined();
		const flagged = summaryForActiveSession(state, undefined, true);
		expect(flagged).not.toBe(unflagged);
		expect(flagged.hasActiveHeartbeat).toBe(true);
		expect(summaryForActiveSession(state, undefined, true)).toBe(flagged);
	});
});

describe("latestMessageActivityAt memo", () => {
	const messageAt = (iso: string, content = "hello") =>
		({ role: "user", content, timestamp: Date.parse(iso) }) as AgentMessage;

	function countingArray(messages: AgentMessage[]): { reads: number[]; array: AgentMessage[] } {
		const reads: number[] = [];
		const array = new Proxy(messages, {
			get(target, property, receiver) {
				if (typeof property === "string" && /^\d+$/.test(property)) reads.push(Number(property));
				return Reflect.get(target, property, receiver);
			},
		});
		return { reads, array };
	}

	function freshMemo(): MessageActivityMemo {
		return { source: undefined, scannedLength: 0, tailRef: undefined, latest: undefined };
	}

	it("scans the whole array once and then only appended messages", () => {
		// Twenty messages stand in for a large transcript: the memo must never
		// re-walk the old prefix once it has scanned it.
		const messages = Array.from({ length: 20 }, (_, index) =>
			messageAt(new Date(Date.UTC(2026, 4, 1, 0, 0, index)).toISOString()),
		);
		const { reads, array } = countingArray(messages);
		const memo = freshMemo();

		const latestIso = new Date(Date.UTC(2026, 4, 1, 0, 0, 19)).toISOString();
		expect(latestMessageActivityAt(array, memo)).toBe(latestIso);
		expect(reads).toContain(0);
		expect(memo.scannedLength).toBe(20);

		// Unchanged array: O(1) boundary/tail reads only, no message walk.
		reads.length = 0;
		expect(latestMessageActivityAt(array, memo)).toBe(latestIso);
		expect(reads.length).toBeGreaterThan(0);
		expect(reads.every((index) => index >= 19)).toBe(true);

		// One append: the boundary check plus the new element, nothing older.
		messages.push(messageAt("2026-06-01T00:00:00.000Z"));
		reads.length = 0;
		expect(latestMessageActivityAt(array, memo)).toBe("2026-06-01T00:00:00.000Z");
		expect(reads.every((index) => index >= 19)).toBe(true);
		expect(reads).toContain(20);
		expect(memo.scannedLength).toBe(21);
	});

	it("rescans everything after a mid-array insert shifts the boundary", () => {
		const messages = [messageAt("2026-05-01T00:00:00.000Z"), messageAt("2026-05-04T00:00:00.000Z")];
		const memo = freshMemo();
		expect(latestMessageActivityAt(messages, memo)).toBe("2026-05-04T00:00:00.000Z");
		// Insert before the tail: the pre-error splice path in agent-session.
		messages.splice(1, 0, messageAt("2026-05-03T00:00:00.000Z"));
		expect(latestMessageActivityAt(messages, memo)).toBe("2026-05-04T00:00:00.000Z");
		expect(memo.scannedLength).toBe(3);
		expect(memo.latest).toBe(Date.parse("2026-05-04T00:00:00.000Z"));
	});

	it("rescans when the array is replaced or shrinks", () => {
		const messages = [messageAt("2026-05-01T00:00:00.000Z"), messageAt("2026-05-02T00:00:00.000Z")];
		const memo = freshMemo();
		expect(latestMessageActivityAt(messages, memo)).toBe("2026-05-02T00:00:00.000Z");
		// Compaction and filtering reassign the array; the memo must not trust the old scan.
		const replacement = [...messages];
		expect(latestMessageActivityAt(replacement, memo)).toBe("2026-05-02T00:00:00.000Z");
		replacement.pop();
		expect(latestMessageActivityAt(replacement, memo)).toBe("2026-05-01T00:00:00.000Z");
		expect(memo.scannedLength).toBe(1);
	});

	it("keeps ignoring invalid timestamps on appended messages", () => {
		const messages = [messageAt("2026-05-01T00:00:00.000Z")];
		const memo = freshMemo();
		expect(latestMessageActivityAt(messages, memo)).toBe("2026-05-01T00:00:00.000Z");
		messages.push({
			role: "assistant",
			content: "corrupt",
			timestamp: 8.64e15 + 1,
		} as unknown as AgentMessage);
		expect(latestMessageActivityAt(messages, memo)).toBe("2026-05-01T00:00:00.000Z");
		expect(memo.scannedLength).toBe(2);
	});

	it("matches a full rescan on every mutation pattern", () => {
		const build = (count: number) =>
			Array.from({ length: count }, (_, index) => messageAt(new Date(2026, 4, 1, 0, 0, index).toISOString()));
		const messages = build(25);
		const memo = freshMemo();
		const fullScan = () => latestMessageActivityAt(messages);
		for (const mutation of [
			() => messages.push(messageAt("2026-06-01T00:00:00.000Z")),
			() => messages.splice(10, 0, messageAt("2026-05-15T00:00:00.000Z")),
			() => messages.pop(),
			() => messages.push(messageAt("2026-04-01T00:00:00.000Z")),
		]) {
			mutation();
			expect(latestMessageActivityAt(messages, memo)).toBe(fullScan());
		}
	});
});

describe("sessionDisplayLabels", () => {
	it("mirrors the summary's session name and first message", () => {
		const state = makeState({
			activeSessionId: "labels",
			messages: [{ role: "user", content: "first prompt" } as AgentMessage],
		});
		const labels = sessionDisplayLabels(state);
		const summary = summaryForActiveSession(state);
		expect(labels.sessionName).toBe(summary.sessionName);
		expect(labels.firstMessage).toBe(summary.firstMessage);
	});

	it("uses the spawn prompt as the subagent title", () => {
		const state = makeState({
			activeSessionId: "spawned",
			metadata: { kind: "subagent", createdAt: 1, prompt: "Audit the   retry\nlogic", rlmChildId: "c1" },
		});
		expect(sessionDisplayLabels(state).firstMessage).toBe("Audit the retry logic");
	});
});

describe("buildRlmChildSnapshots", () => {
	it("uses the AgentSession projection and adds resident active session ids", () => {
		const queued = {
			id: "sub-queued",
			label: "Queued task",
			status: "queued" as const,
			sessionDir: "/tmp/artifacts/sub-queued",
		};
		const executing = {
			id: "sub-running",
			label: "Running task",
			status: "running" as const,
			sessionDir: "/tmp/artifacts/sub-running",
			activity: { kind: "executing" as const, toolName: "ipython" },
		};
		const parent = makeState({
			activeSessionId: "parent",
			childSnapshots: [queued, executing],
		});
		const residentChild = makeState({
			activeSessionId: "running-child",
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-running",
			},
		});

		expect(buildRlmChildSnapshots("parent", [parent, residentChild])).toEqual([
			{ ...queued, activeSessionId: undefined },
			{ ...executing, activeSessionId: "running-child" },
		]);
	});

	it("returns no snapshots when the root is not resident", () => {
		expect(buildRlmChildSnapshots("missing", [])).toEqual([]);
	});
});

describe("resolveAttachModelFallbackMessage", () => {
	const startupMessage = "No models available. Use /login...";

	function makeSummary(overrides: Partial<SessionSummary>): SessionSummary {
		return {
			id: "active-1",
			lifecycle: "draft",
			activity: "idle",
			sessionId: "session-1",
			cwd: "/tmp/project",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount: 0,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			...overrides,
			isSessionActive: overrides.isSessionActive ?? false,
		};
	}

	it.each([
		[
			"prefers the daemon's own fallback message",
			{ modelFallbackMessage: "Could not restore model a/b. Using c/d" },
			"Could not restore model a/b. Using c/d",
		],
		[
			"ignores the attaching process's snapshot when the session has a model",
			{ model: { provider: "prime-inference", id: "gpt-5.5" } as SessionSummary["model"] },
			undefined,
		],
		["falls back to the attaching process's snapshot when the session has no model", {}, startupMessage],
	])("%s", (_name, overrides, expected) => {
		expect(resolveAttachModelFallbackMessage(makeSummary(overrides), startupMessage)).toBe(expected);
	});
});

interface StateOptions {
	activeSessionId: string;
	model?: { provider: string; id: string };
	sessionFile?: string;
	sessionId?: string;
	isStreaming?: boolean;
	pendingToolCalls?: string[];
	clients?: number;
	messages?: AgentMessage[];
	hasUserContent?: boolean;
	summaryState?: ActiveSessionState["summaryState"];
	usage?: SessionUsageSummary;
	hasRunningRlmChildren?: boolean;
	hasAcceptedPromptInFlight?: boolean;
	unfinishedActionCount?: number;
	contextTokens?: number;
	streamingMessage?: AgentMessage;
	childSnapshots?: RlmChildAgentSnapshot[];
	rlmDepth?: number;
	metadata?: {
		kind: "top-level" | "subagent";
		createdAt: number;
		parentActiveSessionId?: string;
		parentSessionId?: string;
		parentSessionFile?: string;
		rlmChildId?: string;
		rlmParentNodeId?: string;
		prompt?: string;
		sessionDir?: string;
	};
}

function makeState(options: StateOptions): ActiveSessionState {
	const clients = new Set<DaemonSocketClient>();
	for (let index = 0; index < (options.clients ?? 0); index++) {
		clients.add({ id: `client-${index}` } as unknown as DaemonSocketClient);
	}

	return {
		activeSessionId: options.activeSessionId,
		clients,
		lastEventSequence: 0,
		summaryState: options.summaryState,
		runtime: {
			metadata: options.metadata ?? { kind: "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				model: options.model,
				thinkingLevel: "off",
				isStreaming: options.isStreaming ?? false,
				isCompacting: false,
				sessionFile: options.sessionFile,
				sessionId: options.sessionId ?? `session-${options.activeSessionId}`,
				rlmDepth: options.rlmDepth ?? 0,
				sessionName: `session ${options.activeSessionId}`,
				sessionManager: {
					getCwd: () => "/tmp/project",
					getHeader: () => ({ timestamp: "2026-05-01T00:00:00.000Z" }),
					getSessionDir: () => "/tmp/sessions",
					hasUserContent: () => options.hasUserContent ?? false,
				},
				messages: options.messages ?? ([] as AgentMessage[]),
				getRlmChildSnapshots: () => options.childSnapshots ?? [],
				getOwnUsageSummary: () => options.usage,
				hasRunningRlmChildren: () => options.hasRunningRlmChildren ?? false,
				hasAcceptedPromptInFlight: options.hasAcceptedPromptInFlight ?? false,
				unfinishedActionCount: options.unfinishedActionCount ?? (options.hasAcceptedPromptInFlight ? 1 : 0),
				isSessionActive: options.isStreaming === true || options.hasAcceptedPromptInFlight === true,
				getCurrentRecap: () => undefined,
				_contextTokensForCurrentMessages: () => options.contextTokens,
				getSessionActionSnapshot: () => ({
					queuedCount: 0,
					steering: [],
					followUps: [],
					...(options.hasAcceptedPromptInFlight
						? { active: { kind: "turn" as const, phase: "running" as const } }
						: {}),
				}),
				state: {
					streamingMessage: options.streamingMessage,
					pendingToolCalls: new Set(options.pendingToolCalls ?? []),
				},
			},
		},
	} as unknown as ActiveSessionState;
}

function makeSessionInfo(overrides: Pick<SessionInfo, "path" | "id"> & Partial<SessionInfo>): SessionInfo {
	return {
		path: overrides.path,
		id: overrides.id,
		cwd: "/tmp/project",
		name: overrides.name,
		state: overrides.state,
		parentSessionPath: overrides.parentSessionPath,
		rlmDepth: overrides.rlmDepth ?? 0,
		created: new Date("2026-05-01T00:00:00.000Z"),
		modified: new Date("2026-05-02T00:00:00.000Z"),
		messageCount: overrides.messageCount ?? 2,
		firstMessage: "hello",
		allMessagesText: "hello world",
		agentStatus: overrides.agentStatus,
		usage: overrides.usage,
	};
}

function makeCronJob(overrides: Pick<AgentCronJob, "id" | "activeSessionId"> & Partial<AgentCronJob>): AgentCronJob {
	return {
		id: overrides.id,
		status: overrides.status ?? "active",
		source: overrides.source,
		activeSessionId: overrides.activeSessionId,
		sessionId: `session-${overrides.activeSessionId}`,
		sessionFile: overrides.sessionFile ?? `/tmp/${overrides.activeSessionId}.jsonl`,
		cwd: "/tmp/project",
		prompt: "Check for follow-up work",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-05-01T00:00:00.000Z",
		updatedAt: "2026-05-01T00:00:00.000Z",
		nextRunAt: "2026-05-01T00:05:00.000Z",
		runCount: 0,
	};
}
