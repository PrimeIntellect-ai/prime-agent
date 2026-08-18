import { resolve } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { AgentCronJob } from "../src/core/cron-jobs.js";
import type { SessionInfo } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	buildRlmChildSnapshots,
	buildSessionList,
	resolveAttachModelFallbackMessage,
	type SessionSummary,
	summaryForActiveSession,
} from "../src/modes/daemon/daemon-session-list.js";

describe("buildSessionList", () => {
	it("derives active session lifecycle and activity", () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const currentSummary = { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"];
		const entries = buildSessionList(
			[
				makeState({
					activeSessionId: "model",
					sessionFile: "/tmp/model.jsonl",
					isStreaming: true,
					messages: oneMessage,
				}),
				makeState({
					activeSessionId: "tool",
					sessionFile: "/tmp/tool.jsonl",
					isStreaming: true,
					pendingToolCalls: ["tool-1"],
					messages: oneMessage,
				}),
				makeState({
					activeSessionId: "needs-user",
					sessionFile: "/tmp/needs-user.jsonl",
					clients: 1,
					messages: oneMessage,
					summaryState: currentSummary,
				}),
				makeState({
					activeSessionId: "done",
					sessionFile: "/tmp/done.jsonl",
					messages: oneMessage,
					summaryState: currentSummary,
				}),
			],
			[],
		);

		expect(entries.map((entry) => [entry.id, entry.lifecycle, entry.activity])).toEqual([
			["model", "live", "working"],
			["tool", "live", "working"],
			["needs-user", "live", "idle"],
			["done", "live", "idle"],
		]);
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

	it("keeps a session working while background subagents run", () => {
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
		expect(entries[0]?.activity).toBe("working");
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

	it("reports accepted in-flight prompts as active with no queued work", () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const summary = summaryForActiveSession(
			makeState({
				activeSessionId: "accepted",
				messages: oneMessage,
				summaryState: { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"],
				hasAcceptedPromptInFlight: true,
			}),
		);

		expect(summary.sessionActions).toMatchObject({ queuedCount: 0, active: { kind: "turn", phase: "running" } });
		expect(summary.activity).toBe("working");
	});

	it("reports the exact unfinished action count independently of the visible action snapshot", () => {
		const summary = summaryForActiveSession(
			makeState({
				activeSessionId: "batched",
				unfinishedActionCount: 3,
				hasAcceptedPromptInFlight: true,
			}),
		);

		expect(summary.sessionActions).toMatchObject({ queuedCount: 0, active: { kind: "turn" } });
		expect(summary.unfinishedActionCount).toBe(3);
	});

	it("marks a finished subagent idle instead of holding it at working", () => {
		const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];
		const entries = buildSessionList(
			[
				makeState({
					activeSessionId: "child",
					sessionFile: "/tmp/child.jsonl",
					isStreaming: false,
					hasRunningRlmChildren: false,
					messages: oneMessage,
					// No current summary verdict — a resident finished subagent never gets one.
					metadata: { kind: "subagent", createdAt: 1, parentActiveSessionId: "parent", rlmChildId: "c1" },
				}),
			],
			[],
		);
		expect(entries[0]?.activity).toBe("idle");
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

	it("surfaces both recap and verdict while the summary matches the turn", () => {
		const summary = summaryForActiveSession(
			makeState({
				activeSessionId: "s1",
				messages: twoMessages,
				summaryState: { summary: "Editing the router", taskState: "completed", basedOnMessageCount: 2 },
			}),
		);
		expect(summary.summary).toBe("Editing the router");
		expect(summary.taskState).toBe("completed");
	});

	it("keeps showing the prior recap once a new turn outpaces the summary", () => {
		// New messages arrived (count 3) but the summary is still based on 2; the
		// recap text must survive so the agents view does not flicker to blank.
		const summary = summaryForActiveSession(
			makeState({
				activeSessionId: "s1",
				messages: [...twoMessages, { role: "user", content: "next" } as AgentMessage],
				summaryState: { summary: "Editing the router", taskState: "completed", basedOnMessageCount: 2 },
			}),
		);
		expect(summary.summary).toBe("Editing the router");
		// ...but a stale "completed" verdict must not show on a turn that is active again.
		expect(summary.taskState).toBeUndefined();
	});

	it("omits the recap entirely when there is no summary yet", () => {
		const summary = summaryForActiveSession(makeState({ activeSessionId: "s1", messages: twoMessages }));
		expect(summary.summary).toBeUndefined();
		expect(summary.taskState).toBeUndefined();
	});
});

describe("buildRlmChildSnapshots", () => {
	it("collects children and grandchildren with event-compatible parent ids", () => {
		const parent = makeState({ activeSessionId: "parent", sessionFile: "/tmp/parent.jsonl" });
		const child = makeState({
			activeSessionId: "child",
			model: { provider: "anthropic", id: "claude-opus-4-7" },
			isStreaming: true,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-aaa",
				rlmParentNodeId: "sub-aaa",
				prompt: "Summarize   the repo\nlayout",
				sessionDir: "/tmp/artifacts/sub-aaa",
			},
			messages: [
				{ role: "user", content: "Summarize the repo layout" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "The repo is an npm workspace." },
						{ type: "toolCall", id: "tool-1", name: "ipython", arguments: {} },
					],
				},
			] as AgentMessage[],
			contextTokens: 41_000,
		});
		const grandchild = makeState({
			activeSessionId: "grandchild",
			metadata: {
				kind: "subagent",
				createdAt: 2,
				parentActiveSessionId: "child",
				rlmChildId: "sub-bbb",
				rlmParentNodeId: "sub-bbb",
				prompt: "Read the docs",
				sessionDir: "/tmp/artifacts/sub-aaa/sub-bbb",
			},
		});
		const unrelated = makeState({
			activeSessionId: "unrelated-child",
			metadata: {
				kind: "subagent",
				createdAt: 3,
				parentActiveSessionId: "someone-else",
				rlmChildId: "sub-ccc",
			},
		});

		const snapshots = buildRlmChildSnapshots("parent", [parent, child, grandchild, unrelated]);

		expect(snapshots.map((snapshot) => [snapshot.id, snapshot.parentId, snapshot.status])).toEqual([
			["sub-aaa", undefined, "running"],
			["sub-bbb", "sub-aaa", "done"],
		]);
		expect(snapshots[0]).toMatchObject({
			model: "anthropic/claude-opus-4-7",
			label: "Summarize the repo layout",
			answerPreview: "The repo is an npm workspace.",
			toolUseCount: 1,
			tokenCount: 41_000,
			sessionDir: "/tmp/artifacts/sub-aaa",
			activeSessionId: "child",
		});
	});

	it("prefers the parent's run status over the streaming heuristic", () => {
		// An idle child session is still part of an active run; only the parent's
		// run tracker knows that.
		const parent = makeState({
			activeSessionId: "parent",
			sessionFile: "/tmp/parent.jsonl",
			childRunStatuses: { "sub-aaa": "running" },
		});
		const idleChild = makeState({
			activeSessionId: "child",
			isStreaming: false,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-aaa",
				rlmParentNodeId: "sub-aaa",
				prompt: "Slow task",
				sessionDir: "/tmp/artifacts/sub-aaa",
			},
		});

		const snapshots = buildRlmChildSnapshots("parent", [parent, idleChild]);

		expect(snapshots.map((snapshot) => [snapshot.id, snapshot.status])).toEqual([["sub-aaa", "running"]]);
	});

	it("keeps terminal run status while projecting a retained child's active follow-up", () => {
		const parent = makeState({
			activeSessionId: "parent",
			childRunStatuses: { "sub-aaa": "done" },
		});
		const activeRetainedChild = makeState({
			activeSessionId: "child",
			isStreaming: true,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-aaa",
			},
		});

		expect(buildRlmChildSnapshots("parent", [parent, activeRetainedChild])[0]).toMatchObject({
			status: "done",
			activity: { kind: "writing" },
		});
	});

	it("includes in-flight assistant output in child snapshots", () => {
		const parent = makeState({ activeSessionId: "parent" });
		const child = makeState({
			activeSessionId: "child",
			isStreaming: true,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId: "parent",
				rlmChildId: "sub-aaa",
			},
			streamingMessage: {
				role: "assistant",
				content: [
					{ type: "text", text: "Still investigating" },
					{ type: "toolCall", id: "tool-1", name: "search", arguments: {} },
				],
			} as AgentMessage,
		});

		expect(buildRlmChildSnapshots("parent", [parent, child])[0]).toMatchObject({
			answerPreview: "Still investigating",
			toolUseCount: 1,
		});
	});

	it("returns no snapshots for sessions without children", () => {
		const solo = makeState({ activeSessionId: "solo" });
		expect(buildRlmChildSnapshots("solo", [solo])).toEqual([]);
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

	it("prefers the daemon's own fallback message", () => {
		const summary = makeSummary({ modelFallbackMessage: "Could not restore model a/b. Using c/d" });

		expect(resolveAttachModelFallbackMessage(summary, startupMessage)).toBe("Could not restore model a/b. Using c/d");
	});

	it("ignores the attaching process's snapshot when the session has a model", () => {
		const summary = makeSummary({ model: { provider: "prime-inference", id: "gpt-5.5" } as SessionSummary["model"] });

		expect(resolveAttachModelFallbackMessage(summary, startupMessage)).toBeUndefined();
	});

	it("falls back to the attaching process's snapshot when the session has no model", () => {
		expect(resolveAttachModelFallbackMessage(makeSummary({}), startupMessage)).toBe(startupMessage);
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
	childRunStatuses?: Record<string, "queued" | "running" | "done" | "error" | "cancelled">;
	hasRunningRlmChildren?: boolean;
	hasAcceptedPromptInFlight?: boolean;
	unfinishedActionCount?: number;
	contextTokens?: number;
	streamingMessage?: AgentMessage;
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
				getRlmChildRunStatus: (childId: string) => options.childRunStatuses?.[childId],
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
