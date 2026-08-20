import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateAgentSessionRuntimeFactory } from "../../../src/core/agent-session-runtime.js";
import type { AgentCronJobStore } from "../../../src/core/cron-jobs.js";
import type { CreateRlmSubagentRuntimeOptions } from "../../../src/core/rlm-runtime.js";
import {
	acquireSessionLease,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
} from "../../../src/core/session-lease.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { AgentDaemon, getChildActiveSessionStates } from "../../../src/modes/daemon/daemon-mode.js";
import type { DaemonCommand, DaemonResponse } from "../../../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../../../src/modes/daemon/daemon-session-list.js";
import { assistantMsg, userMsg } from "../../utilities.js";

type RuntimeFactoryOptions = Parameters<CreateAgentSessionRuntimeFactory>[0];
type RuntimeFactoryResult = Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>;

type DaemonInternals = {
	sessions: Map<string, ActiveSessionState>;
	cronStore: AgentCronJobStore;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
	createRlmSubagentRuntime(
		parentState: ActiveSessionState,
		options: CreateRlmSubagentRuntimeOptions,
	): Promise<ActiveSessionState["runtime"]>;
};

function makeRuntimeSession(sessionManager: SessionManager): RuntimeFactoryResult["session"] {
	return {
		sessionManager,
		messages: [],
		extensionRunner: {
			hasHandlers: vi.fn(() => false),
			emit: vi.fn(async () => {}),
		},
		sessionFile: sessionManager.getSessionFile(),
		sessionId: sessionManager.getSessionId(),
		get sessionName() {
			return sessionManager.getSessionName();
		},
		setSubagentRuntimeHost: vi.fn(),
		getRlmChildRunStatus: vi.fn(() => "running"),
		registerRlmChildSession: vi.fn(() => true),
		releaseRlmChildSession: vi.fn(() => vi.fn()),
		subscribe: vi.fn(() => vi.fn()),
		bindExtensions: vi.fn(async () => {}),
		setExecEnvProvider: vi.fn(),
		getAvailableThinkingLevels: vi.fn(() => []),
		scopedModels: [],
		getActiveToolNames: vi.fn(() => []),
		getContextUsage: vi.fn(() => undefined),
		setSessionName: vi.fn((name: string) => sessionManager.appendSessionInfo(name)),
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		isSessionActive: false,
		hasAcceptedPromptInFlight: false,
		unfinishedActionCount: 0,
		state: { pendingToolCalls: new Set() },
		hasRunningRlmChildren: () => false,
		getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
		sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		promptAndWait: vi.fn(async (_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			options?.preflightResult?.(true);
		}),
		dispose: vi.fn(),
		disposeAsync: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	} as unknown as RuntimeFactoryResult["session"];
}

function makeClient(id: string, activeSessionId: string): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as DaemonSocketClient["socket"],
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi: false,
		capabilities: new Set(),
	} as unknown as DaemonSocketClient;
}

function responseData<T>(response: DaemonResponse | undefined): T {
	if (!response || !response.success) {
		throw new Error(`Daemon command failed: ${response && !response.success ? response.error : "no response"}`);
	}
	return response.data as T;
}

describe("regression ENG-5180: non-destructive fork_export", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function makeFixture(tempDir: string) {
		vi.stubEnv(SESSION_LEASES_ENABLED_ENV, "1");
		const sessionDir = join(tempDir, "sessions");
		const sourceManager = SessionManager.create(tempDir, sessionDir);
		sourceManager.newSession();
		sourceManager.appendMessage(userMsg("first prompt"));
		sourceManager.appendMessage(assistantMsg("first answer"));
		const secondUserEntryId = sourceManager.appendMessage(userMsg("second prompt"));
		sourceManager.appendMessage(assistantMsg("second answer"));
		sourceManager.flushNow();
		const sourceSessionFile = sourceManager.getSessionFile();
		if (!sourceSessionFile) {
			throw new Error("Missing source session file");
		}

		const createRuntime = vi.fn(async (options: RuntimeFactoryOptions) => ({
			session: makeRuntimeSession(options.sessionManager),
			extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as NonNullable<
				RuntimeFactoryResult["extensionsResult"]
			>,
			services: { cwd: options.cwd, agentDir: options.agentDir } as RuntimeFactoryResult["services"],
			diagnostics: [],
		}));
		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
			createRuntime,
		});
		return {
			internals: daemon as unknown as DaemonInternals,
			createRuntime,
			sessionDir,
			sourceSessionFile,
			secondUserEntryId,
		};
	}

	it("keeps the original resident with its subagent, heartbeat, and lease when forking to a new session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-5180-fork-"));
		try {
			const fixture = makeFixture(tempDir);
			const { internals } = fixture;
			const client = makeClient("client-1", "unattached");

			const createdSummary = responseData<SessionSummary>(
				await internals.handleCommand(client, {
					id: "create-1",
					type: "create",
					sessionPath: fixture.sourceSessionFile,
				}),
			);
			const sourceActiveSessionId = createdSummary.activeSessionId;
			if (!sourceActiveSessionId) {
				throw new Error("Missing source active session id");
			}
			const sourceState = internals.sessions.get(sourceActiveSessionId);
			if (!sourceState) {
				throw new Error("Missing source session state");
			}
			const sourceSession = sourceState.runtime.session;

			await internals.createRlmSubagentRuntime(sourceState, {
				parentSession: sourceSession,
				id: "child-1",
				prompt: "keep running",
				sessionName: "fork-child",
				sessionDir: join(tempDir, "child"),
				model: {} as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 2,
				rlmParentNodeId: "child-1",
			});
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === "child-1",
			);
			if (!childState) {
				throw new Error("Missing child session state");
			}

			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: sourceActiveSessionId,
				sessionId: sourceSession.sessionId,
				sessionFile: fixture.sourceSessionFile,
				cwd: tempDir,
				runtimeKind: "top-level",
				scheduleText: "every 30s",
				prompt: "keep me alive",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			const exportResult = responseData<{ cancelled: boolean; sessionPath: string | null; selectedText?: string }>(
				await internals.handleCommand(client, {
					id: "fork-1",
					type: "fork_export",
					activeSessionId: sourceActiveSessionId,
					entryId: fixture.secondUserEntryId,
				}),
			);
			expect(exportResult.cancelled).toBe(false);
			expect(exportResult.selectedText).toBe("second prompt");
			expect(exportResult.sessionPath).toBeDefined();
			const forkPath = exportResult.sessionPath;
			if (!forkPath) {
				throw new Error("Missing exported fork path");
			}

			// The export must not tear the source runtime down.
			expect(internals.sessions.get(sourceActiveSessionId)).toBe(sourceState);
			expect(sourceState.runtime.session).toBe(sourceSession);
			expect(sourceSession.disposeAsync).not.toHaveBeenCalled();
			expect(childState.runtime.session.disposeAsync).not.toHaveBeenCalled();

			const forkSummary = responseData<SessionSummary>(
				await internals.handleCommand(client, { id: "create-2", type: "create", sessionPath: forkPath }),
			);
			const forkActiveSessionId = forkSummary.activeSessionId;
			if (!forkActiveSessionId) {
				throw new Error("Missing fork active session id");
			}
			expect(forkActiveSessionId).not.toBe(sourceActiveSessionId);
			expect(forkSummary.sessionFile).toBe(forkPath);

			const listed = responseData<{ sessions: SessionSummary[] }>(
				await internals.handleCommand(client, { id: "list-1", type: "list" }),
			);
			const listedRootIds = listed.sessions
				.filter((session) => session.runtimeKind !== "subagent")
				.map((session) => session.activeSessionId);
			expect(listedRootIds).toEqual(expect.arrayContaining([sourceActiveSessionId, forkActiveSessionId]));

			// The original is still promptable after the fork.
			await expect(
				internals.handleCommand(client, {
					id: "prompt-1",
					type: "prompt_and_wait",
					activeSessionId: sourceActiveSessionId,
					message: "still alive?",
				}),
			).resolves.toMatchObject({ success: true });
			expect(sourceSession.promptAndWait).toHaveBeenCalledWith("still alive?", expect.anything());

			// Resident children stay with the original; the fork starts with none.
			const forkState = internals.sessions.get(forkActiveSessionId);
			if (!forkState) {
				throw new Error("Missing fork session state");
			}
			expect(
				getChildActiveSessionStates(internals.sessions, sourceState).map((state) => state.activeSessionId),
			).toEqual([childState.activeSessionId]);
			expect(getChildActiveSessionStates(internals.sessions, forkState)).toEqual([]);

			// The heartbeat stays bound to the original instead of moving to the fork.
			const job = internals.cronStore.list().find((candidate) => candidate.id === heartbeat.id);
			expect(job).toMatchObject({
				activeSessionId: sourceActiveSessionId,
				sessionId: sourceSession.sessionId,
				sessionFile: fixture.sourceSessionFile,
				status: "active",
			});

			// Both session files are leased by their own runtimes.
			expect(() => acquireSessionLease(fixture.sourceSessionFile, tempDir)).toThrow(SessionAlreadyActiveError);
			expect(() => acquireSessionLease(forkPath, tempDir)).toThrow(SessionAlreadyActiveError);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
