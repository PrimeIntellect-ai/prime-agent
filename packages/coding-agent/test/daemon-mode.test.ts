import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";
import { AGENT_FAMILY_REACH_ERROR, type AgentSessionMessageController } from "../src/core/agent-messages.js";
import type { AgentObserveController } from "../src/core/agent-observe.js";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import { installAgentTraceUpload } from "../src/core/agent-traces.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { type AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import { PRIME_AGENT_TRACES_PROVIDER_ID } from "../src/core/prime-inference-auth.js";
import type { CreateRlmSubagentRuntimeOptions, SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import {
	getSessionArtifactPathForFile,
	readSessionInfo,
	type SessionInfo,
	SessionManager,
} from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	finishClientSnapshotStreaming,
	markClientSnapshotStreaming,
	setDaemonClientSessionCapabilities,
} from "../src/modes/daemon/daemon-mode.js";
import {
	DAEMON_PROTOCOL_INFO,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import { type DaemonWorkerFrameHeader, isDaemonWorkerFrameHeader } from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";
import {
	createSnapshotTranscriptChunks,
	SnapshotTranscriptCache,
	type SnapshotTranscriptChunkSource,
} from "../src/modes/daemon/snapshot-transcript-cache.js";

import { type PrivateFrame, PrivateFrameDecoder } from "../src/modes/session-worker/private-framing.js";
import { seedSupervisorRoster } from "./fixtures/roster-seed.js";

describe("daemon mode helpers", () => {
	it("persists a real child completion for passive discovery, roster, and listing", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-real-completion-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionInfo("parent");
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentSessionFile) throw new Error("Missing parent session file");
			const childSessionDir = join(parentManager.getSessionArtifactDir()!, "child-1");
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["extensionsResult"],
				services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
					ReturnType<CreateAgentSessionRuntimeFactory>
				>["services"],
				diagnostics: [],
			}));
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<ActiveSessionState["runtime"]>;
				createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost;
				listPassiveRlmSubagents(): Promise<Array<{ entry: { childId: string } }>>;
				findPassiveRlmSubagent(target: string): Promise<{ entry: { childId: string } } | undefined>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				buildSessionListWithPassiveRlmSubagents(
					active: ActiveSessionState[],
					saved: Awaited<ReturnType<typeof SessionManager.listAll>>,
					jobs: AgentCronJob[],
				): Promise<Array<{ sessionFile?: string; rlmChildId?: string }>>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentSessionFile });
			Object.assign(parentState.runtime.session, {
				isSessionActive: false,
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				state: { pendingToolCalls: new Set(), streamingMessage: undefined },
				thinkingLevel: "off",
				hasRunningRlmChildren: () => false,
				getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			});
			const childRuntime = await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "complete and persist",
				sessionName: "real-worker",
				sessionDir: childSessionDir,
				model: { provider: "test", id: "model" } as Model<Api>,
				thinkingLevel: "off",
				serviceTier: null,
				scopedModels: [],
				activeToolNames: [],
				customTools: [],
				includeGoals: false,
				includeCompactSkill: false,
				rlmDepth: 1,
				rlmMaxDepth: 4,
				rlmParentNodeId: "child-1",
			});
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.session === childRuntime.session,
			);
			if (!childState?.runtime.session.sessionFile) throw new Error("Missing child state");
			const host = internals.createSubagentRuntimeHost(parentState);
			expect(host.completeRlmSubagentRuntime?.("child-1", childRuntime.session)).toBe(true);
			await (
				daemon as unknown as { closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void> }
			).closeSession(childState, "shutdown");

			expect((await internals.listPassiveRlmSubagents()).map(({ entry }) => entry.childId)).toContain("child-1");
			expect((await internals.findPassiveRlmSubagent("real-worker"))?.entry.childId).toBe("child-1");
			const family = await internals.createAgentMessageController(() => parentState).family?.();
			const passiveMember = family?.find((member) => member.entry.name === "real-worker");
			expect(passiveMember).toMatchObject({ relationship: "child", entry: { status: "inactive" } });
			expect(passiveMember?.entry).not.toHaveProperty("repliedSinceTask");
			const listed = await internals.buildSessionListWithPassiveRlmSubagents(
				[parentState],
				await SessionManager.listAll(undefined, sessionDir),
				[],
			);
			expect(listed).toContainEqual(
				expect.objectContaining({ sessionFile: childState.runtime.session.sessionFile, rlmChildId: "child-1" }),
			);
			// The registry is legacy read-only now: spawn and completion must land
			// in the per-child display file, never in rlm-subagents.jsonl.
			expect(existsSync(join(parentManager.getSessionArtifactDir()!, "rlm-subagents.jsonl"))).toBe(false);
			const display = JSON.parse(readFileSync(join(childSessionDir, "rlm-subagent.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(display).toMatchObject({
				childId: "child-1",
				sessionName: "real-worker",
				status: "completed",
				prompt: "complete and persist",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("closes the exact parent-scoped daemon runtime when a retained subagent is deleted", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const parentState = makeState("parent");
		parentState.runtime = {
			...parentState.runtime,
			session: {
				sessionManager: { getSessionArtifactDir: () => undefined },
			},
		} as ActiveSessionState["runtime"];
		const childState = makeState("child", parentState.activeSessionId);
		const foreignChildState = makeState("foreign-child", "other-parent");
		const childSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		const foreignSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		childState.runtime = {
			...childState.runtime,
			metadata: { ...childState.runtime.metadata, rlmChildId: "child-1" },
			session: childSession,
		} as ActiveSessionState["runtime"];
		foreignChildState.runtime = {
			...foreignChildState.runtime,
			metadata: { ...foreignChildState.runtime.metadata, rlmChildId: "child-1" },
			session: foreignSession,
		} as ActiveSessionState["runtime"];
		const closeSession = vi.fn(async () => {});
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			closeSession: typeof closeSession;
			createSubagentRuntimeHost(parent: ActiveSessionState): {
				deleteRlmSubagentRuntime(childId: string, session: ActiveSessionState["runtime"]["session"]): Promise<void>;
			};
		};
		internals.sessions.set(childState.activeSessionId, childState);
		internals.sessions.set(foreignChildState.activeSessionId, foreignChildState);
		internals.closeSession = closeSession;

		const staleParentReference = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		const host = internals.createSubagentRuntimeHost(parentState);
		await host.deleteRlmSubagentRuntime("child-1", staleParentReference);

		expect(closeSession).toHaveBeenCalledOnce();
		expect(closeSession).toHaveBeenCalledWith(childState, "killed", false, true, undefined, {
			kernelSnapshot: false,
		});
		expect(closeSession).not.toHaveBeenCalledWith(foreignChildState, expect.anything());
		expect(childSession.disposeAsync).not.toHaveBeenCalled();
		expect(staleParentReference.disposeAsync).toHaveBeenCalledOnce();

		const missingSession = {
			disposeAsync: vi.fn(async () => {}),
		} as unknown as ActiveSessionState["runtime"]["session"];
		await host.deleteRlmSubagentRuntime("missing-child", missingSession);
		expect(missingSession.disposeAsync).toHaveBeenCalledOnce();
	});

	it("cancels child jobs when deletion joins an in-flight passivation close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-passivation-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childDisposeStarted: markDisposeStarted,
				childDisposeGate: disposeGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());
			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await disposeStarted;
			const job = internals.cronStore.create({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "scheduled child work",
			});
			const deletion = internals
				.createSubagentRuntimeHost(parentState)
				.deleteRlmSubagentRuntime(fixture.childId, childState.runtime.session);
			releaseDispose();

			await Promise.all([passivation, deletion]);
			expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)?.status).toBe("cancelled");
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a child live when its durable deletion boundary cannot be read", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-registry-failure-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentArtifactDir) {
				throw new Error("Missing parent artifact directory");
			}
			mkdirSync(join(parentArtifactDir, "rlm-subagents.jsonl"), { recursive: true });

			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const parentState = makeState("parent");
			parentState.runtime = {
				...parentState.runtime,
				session: makeRuntimeSession(parentManager),
			} as ActiveSessionState["runtime"];
			const childState = makeState("child", parentState.activeSessionId);
			childState.runtime = {
				...childState.runtime,
				metadata: { ...childState.runtime.metadata, rlmChildId: "child-1" },
				session: { disposeAsync: vi.fn(async () => {}) },
			} as unknown as ActiveSessionState["runtime"];
			const closeSession = vi.fn(async () => {});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				closeSession: typeof closeSession;
				createSubagentRuntimeHost(parent: ActiveSessionState): {
					deleteRlmSubagentRuntime(
						childId: string,
						session: ActiveSessionState["runtime"]["session"],
					): Promise<void>;
				};
			};
			internals.sessions.set(childState.activeSessionId, childState);
			internals.closeSession = closeSession;

			await expect(
				internals
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime("child-1", childState.runtime.session),
			).rejects.toThrow();
			expect(closeSession).not.toHaveBeenCalled();
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("routes nonresident agent-message targets through the supervisor wake path", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const source = makeState("source");
		source.runtime = {
			...source.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-source",
				sessionName: "Source",
				isStreaming: false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			},
		} as never;
		const sendRemoteAgentSessionMessage = vi
			.fn()
			.mockRejectedValue(new Error("Unknown active session: deleted-child"));
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendRemoteAgentSessionMessage: typeof sendRemoteAgentSessionMessage;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState: ActiveSessionState;
				origin: "agent";
			}): Promise<unknown>;
		};
		internals.sessions.set(source.activeSessionId, source);
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: "deleted-child",
				message: "continue",
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Unknown active session: deleted-child");
		expect(sendRemoteAgentSessionMessage).toHaveBeenCalledWith(source, "deleted-child", "continue");
	});

	it("reports queued status when a direct accept races into the queue", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean, didQueue?: boolean) => void }) => {
				options?.preflightResult?.(true, true);
				return Promise.resolve();
			},
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				acceptAgentMessagePrompt,
			},
		} as never;
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "please continue",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "queued",
			target: { activeSessionId: targetState.activeSessionId },
		});
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[1]).toMatchObject({ streamingBehavior: "steer" });
	});

	it("rejects an agent message when pause wins core admission", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		let releaseAdmission: () => void = () => {};
		const admissionGate = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		let markAdmissionStarted: () => void = () => {};
		const admissionStarted = new Promise<void>((resolve) => {
			markAdmissionStarted = resolve;
		});
		const acceptAgentMessagePrompt = vi.fn(
			async (
				_message: string,
				options?: {
					admissionCommitted?: () => void;
					preflightResult?: (accepted: boolean) => void;
				},
			) => {
				markAdmissionStarted();
				await admissionGate;
				options?.admissionCommitted?.();
				options?.preflightResult?.(true);
			},
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				acceptAgentMessagePrompt,
				clearQueuedAgentMessages: vi.fn(() => ({ steering: [], followUp: [] })),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "pause race",
			origin: "agent",
		});
		await admissionStarted;
		await internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			type: "agent_messages_pause",
		});
		releaseAdmission();

		await expect(send).rejects.toThrow("Agent messaging is paused");
	});

	it("rate limits agent messages per sender and target pair", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetA = makeState("target-a");
		const targetB = makeState("target-b");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		for (const targetState of [targetA, targetB]) {
			targetState.runtime = {
				...targetState.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${targetState.activeSessionId}`,
					sessionName: targetState.activeSessionId,
					isStreaming: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					acceptAgentMessagePrompt: vi.fn(
						(_message: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
							options?.preflightResult?.(true);
							return Promise.resolve();
						},
					),
					followUp: vi.fn(async () => true),
					clearQueue: vi.fn(() => ({ cleared: 0 })),
					clearQueuedAgentMessages: vi.fn(() => ({ steering: [], followUp: [] })),
				},
			} as never;
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetA.activeSessionId, targetA);
		internals.sessions.set(targetB.activeSessionId, targetB);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: targetA.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				}),
			).resolves.toMatchObject({ target: { activeSessionId: targetA.activeSessionId } });
		}
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetA.activeSessionId,
				message: "over limit",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent messaging rate limit exceeded");
		await internals.handleCommand(makeClient("client-1", targetA.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetA.activeSessionId,
		});
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetA.activeSessionId,
				message: "after clear",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetA.activeSessionId } });
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetB.activeSessionId,
				message: "different target",
				fromState,
				origin: "agent",
			}),
		).resolves.toMatchObject({ target: { activeSessionId: targetB.activeSessionId } });
	});

	it("pause clears queued agent messages concurrently across sessions", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const blockedState = makeState("blocked");
		const readyState = makeState("ready");
		let resolveBlockedClear: () => void = () => {};
		const blockedClear = vi.fn(
			() =>
				new Promise<{ steering: string[]; followUp: string[] }>((resolve) => {
					resolveBlockedClear = () => resolve({ steering: [], followUp: [] });
				}),
		);
		const readyClear = vi.fn(() => ({ steering: [], followUp: ["agent message"] }));
		for (const [state, clearQueuedAgentMessages] of [
			[blockedState, blockedClear],
			[readyState, readyClear],
		] as const) {
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId: `session-${state.activeSessionId}`,
					sessionName: state.activeSessionId,
					isStreaming: false,
					unfinishedActionCount: 1,
					clearQueuedAgentMessages,
				},
			} as never;
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(blockedState.activeSessionId, blockedState);
		internals.sessions.set(readyState.activeSessionId, readyState);

		const pause = internals.handleCommand(makeClient("client-1", blockedState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(blockedClear).toHaveBeenCalledOnce();
		expect(readyClear).toHaveBeenCalledOnce();
		resolveBlockedClear();
		await pause;
	});

	it("refunds agent message rate limit tokens when delivery fails", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				unfinishedActionCount: 0,
				acceptAgentMessagePrompt: vi.fn(async () => {
					throw new Error("missing model");
				}),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.sendAgentSessionMessage({
					targetSelector: targetState.activeSessionId,
					message: `message ${i}`,
					fromState,
					origin: "agent",
				}),
			).rejects.toThrow("missing model");
		}
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "after failed sends",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("missing model");
	});

	it("resolves a reopened child's persisted header parent relative to its session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-header-family-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: vi.fn(),
			});
			const parent = makeState("parent");
			const child = makeState("reopened-child");
			const otherRoot = makeState("other-root");
			parent.runtime = {
				...parent.runtime,
				metadata: { kind: "top-level", createdAt: 1 },
				session: {
					sessionId: "session-parent",
					sessionFile: join(tempDir, "parent.jsonl"),
					sessionManager: { getHeader: () => ({ parentSession: undefined }) },
				},
			} as never;
			child.runtime = {
				...child.runtime,
				metadata: { kind: "top-level", createdAt: 1 },
				session: {
					sessionId: "session-child",
					sessionFile: join(tempDir, "children", "child.jsonl"),
					rlmDepth: 1,
					sessionManager: { getHeader: () => ({ parentSession: "../parent.jsonl" }) },
				},
			} as never;
			otherRoot.runtime = {
				...otherRoot.runtime,
				metadata: { kind: "top-level", createdAt: 1 },
				session: {
					sessionId: "session-other",
					sessionFile: join(tempDir, "other.jsonl"),
					sessionManager: { getHeader: () => ({ parentSession: undefined }) },
				},
			} as never;
			const internals = daemon as unknown as {
				assertAgentFamilyReachable(current: ActiveSessionState, target: ActiveSessionState): void;
			};

			expect(() => internals.assertAgentFamilyReachable(child, parent)).not.toThrow();
			expect(() => internals.assertAgentFamilyReachable(child, otherRoot)).toThrow(AGENT_FAMILY_REACH_ERROR);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("limits agent send and observation to the nuclear family", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-family-reach.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const states = [
			makeState("root"),
			makeState("child", "root"),
			makeState("sibling", "root"),
			makeState("grandchild", "child"),
			makeState("cousin", "sibling"),
		];
		const sessionIds = new Map(states.map((state) => [state.activeSessionId, `session-${state.activeSessionId}`]));
		for (const state of states) {
			const parentActiveSessionId = state.runtime.metadata.parentActiveSessionId;
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				diagnostics: [],
				modelFallbackMessage: undefined,
				metadata: {
					...state.runtime.metadata,
					kind: parentActiveSessionId ? "subagent" : "top-level",
					...(parentActiveSessionId
						? {
								parentSessionId: sessionIds.get(parentActiveSessionId),
								parentSessionFile: `/tmp/${parentActiveSessionId}.jsonl`,
							}
						: {}),
				},
				session: {
					sessionId: sessionIds.get(state.activeSessionId),
					sessionName: state.activeSessionId,
					sessionFile: `/tmp/${state.activeSessionId}.jsonl`,
					sessionManager: {
						getCwd: () => "/tmp",
						getHeader: () => ({ created: new Date(0).toISOString() }),
						getSessionArtifactDir: () => undefined,
					},
					runtimeKind: parentActiveSessionId ? "subagent" : "top-level",
					rlmDepth: parentActiveSessionId
						? state.activeSessionId === "grandchild" || state.activeSessionId === "cousin"
							? 2
							: 1
						: 0,
					isStreaming: false,
					isCompacting: false,
					isBashRunning: false,
					isRetrying: false,
					isSessionActive: false,
					hasAcceptedPromptInFlight: false,
					unfinishedActionCount: 0,
					messages: [],
					state: { pendingToolCalls: new Set(), streamingMessage: undefined },
					hasRunningRlmChildren: () => false,
					getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
				},
			} as never;
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageController(getCurrentState: () => ActiveSessionState): AgentSessionMessageController;
			createAgentObserveController(getCurrentState: () => ActiveSessionState): AgentObserveController;
		};
		for (const state of states) internals.sessions.set(state.activeSessionId, state);
		const child = states[1]!;
		const messaging = internals.createAgentMessageController(() => child);
		const observe = internals.createAgentObserveController(() => child);

		const observed = await observe.listAgents();
		expect(observed.current.activeSessionId).toBe("child");
		expect(observed.agents.map((agent) => [agent.relationship, agent.activeSessionId])).toEqual([
			["parent", "root"],
			["sibling", "sibling"],
			["child", "grandchild"],
		]);
		await expect(observe.getAgent("cousin")).rejects.toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
		await expect(observe.recentMessages({ target: "cousin" })).rejects.toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
		await expect(messaging.sendAgentMessage({ target: "cousin", message: "no" })).rejects.toThrow(
			"Agent reach is limited to parent, siblings, and children",
		);
	});

	it("resolves a duplicate session name to the only family-reachable agent", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-family-name-resolution.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const observer = makeAgentFamilyState("observer", "observer");
		const familyHelper = makeAgentFamilyState("family-helper", "helper", observer.state);
		const otherRoot = makeAgentFamilyState("other-root", "other-root");
		const unrelatedHelper = makeAgentFamilyState("unrelated-helper", "helper", otherRoot.state);
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
			createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
		};
		for (const fixture of [observer, familyHelper, otherRoot, unrelatedHelper]) {
			internals.sessions.set(fixture.state.activeSessionId, fixture.state);
		}

		const observe = internals.createAgentObserveController(() => observer.state);
		await expect(observe.getAgent("helper")).resolves.toMatchObject({
			agent: { activeSessionId: familyHelper.state.activeSessionId },
		});
		await expect(observe.recentMessages({ target: "helper" })).resolves.toMatchObject({
			agent: { activeSessionId: familyHelper.state.activeSessionId },
		});
		await expect(
			internals
				.createAgentMessageController(() => observer.state)
				.sendAgentMessage({ target: "helper", message: "report progress" }),
		).resolves.toMatchObject({ target: { activeSessionId: familyHelper.state.activeSessionId } });
		expect(familyHelper.acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(unrelatedHelper.acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("rejects agent messages when direct delivery preflight fails", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target");
		fromState.runtime = {
			...fromState.runtime,
			session: { sessionId: "session-source", sessionName: "Source" },
		} as never;
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(false);
				return Promise.resolve();
			},
		);
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				unfinishedActionCount: 0,
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState?: ActiveSessionState;
				origin: "agent" | "cli";
			}): Promise<unknown>;
		};
		internals.sessions.set(fromState.activeSessionId, fromState);
		internals.sessions.set(targetState.activeSessionId, targetState);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: targetState.activeSessionId,
				message: "not accepted",
				fromState,
				origin: "agent",
			}),
		).rejects.toThrow("Agent message was not accepted");
	});

	it("rate limits CLI agent messages by stable daemon identity", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				unfinishedActionCount: 0,
				acceptAgentMessagePrompt: vi.fn(
					(_message: string, options?: { preflightResult?: (accepted: boolean) => void }) => {
						options?.preflightResult?.(true);
						return Promise.resolve();
					},
				),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		for (let i = 0; i < 3; i++) {
			await expect(
				internals.handleCommand(makeClient(`client-${i}`, targetState.activeSessionId), {
					id: `command-${i}`,
					type: "send_message",
					targetActiveSessionId: targetState.activeSessionId,
					message: `message ${i}`,
				}),
			).resolves.toMatchObject({ success: true });
		}
		await expect(
			internals.handleCommand(makeClient("client-4", targetState.activeSessionId), {
				id: "command-4",
				type: "send_message",
				targetActiveSessionId: targetState.activeSessionId,
				message: "over limit",
			}),
		).rejects.toThrow("Agent messaging rate limit exceeded");
	});

	it("delivers session closure while a client is snapshotting and backpressured", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("active");
		state.eventGeneration = "generation-1";
		const write = vi.fn((_data: unknown) => false);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
		client.snapshotActiveSessionIds = new Set([state.activeSessionId]);
		client.snapshotStreaming = true;
		client.backpressured = true;
		client.catchupActiveSessionIds = new Set([state.activeSessionId]);
		state.clients.add(client);
		const internals = daemon as unknown as {
			broadcastToSession(
				state: ActiveSessionState,
				message: { type: "session_closed"; activeSessionId: string; reason: "killed" },
			): void;
		};

		internals.broadcastToSession(state, {
			type: "session_closed",
			activeSessionId: state.activeSessionId,
			reason: "killed",
		});

		expect(write).toHaveBeenCalledOnce();
		expect(String(write.mock.calls[0]?.[0])).toContain('"type":"session_closed"');
		expect(client.catchupActiveSessionIds).not.toContain(state.activeSessionId);
	});

	it("catches up on drain only after events are skipped behind a backpressured write", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("active");
		state.eventGeneration = "generation-1";
		const writes: string[] = [];
		const write = vi.fn((data: unknown) => {
			writes.push(String(data));
			return writes.length === 1;
		});
		const socket = Object.assign(new EventEmitter(), { destroyed: false, write }) as unknown as Socket;
		const internals = daemon as unknown as {
			clients: Set<DaemonSocketClient>;
			sessions: Map<string, ActiveSessionState>;
			handleConnection(socket: Socket): void;
			createAttachResult(client: DaemonSocketClient, state: ActiveSessionState): DaemonAttachResult;
			broadcastToSession(
				state: ActiveSessionState,
				message: {
					type: "extension_error";
					activeSessionId: string;
					extensionPath: string;
					event: string;
					error: string;
				},
			): void;
		};
		internals.handleConnection(socket);
		const client = [...internals.clients][0]!;
		client.attachedActiveSessionIds.add(state.activeSessionId);
		state.clients.add(client);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = () =>
			({
				activeSessionId: state.activeSessionId,
				snapshot: { lastEventSequence: state.lastEventSequence },
				lastEventSequence: state.lastEventSequence,
			}) as unknown as DaemonAttachResult;

		internals.broadcastToSession(state, {
			type: "extension_error",
			activeSessionId: state.activeSessionId,
			extensionPath: "x".repeat(1024 * 1024),
			event: "load",
			error: "first",
		});

		expect(client.backpressured).toBe(true);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(writes).toHaveLength(2);
		expect(writes[1]).toContain('"error":"first"');

		internals.broadcastToSession(state, {
			type: "extension_error",
			activeSessionId: state.activeSessionId,
			extensionPath: "/tmp/extension.ts",
			event: "load",
			error: "skipped",
		});

		expect(writes).toHaveLength(2);
		expect(client.catchupActiveSessionIds).toEqual(new Set([state.activeSessionId]));

		write.mockImplementation((data: unknown) => {
			writes.push(String(data));
			return true;
		});
		socket.emit("drain");
		await vi.waitFor(() => expect(writes).toHaveLength(3));

		expect(JSON.parse(writes[2] ?? "{}")).toMatchObject({
			type: "session_resynced",
			activeSessionId: state.activeSessionId,
			meta: { sequence: 2, cursor: { generation: "generation-1", sequence: 2 } },
			snapshot: { lastEventSequence: 2 },
		});
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it("automatically retries every pending catch-up after snapshot creation rejects", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const firstState = makeState("first");
		const secondState = makeState("second");
		firstState.eventGeneration = "generation-1";
		secondState.eventGeneration = "generation-2";
		const write = vi.fn((_data: unknown) => true);
		const client = makeClient("client-1", firstState.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
		firstState.clients.add(client);
		secondState.clients.add(client);
		const createAttachResult = vi.fn(async (_client: DaemonSocketClient, state: ActiveSessionState) => {
			if (createAttachResult.mock.calls.length === 1) {
				throw new Error("snapshot creation failed");
			}
			return {
				activeSessionId: state.activeSessionId,
				snapshot: {
					activeSessionId: state.activeSessionId,
					state: { activeSessionId: state.activeSessionId },
					messages: [],
					lastEventSequence: state.lastEventSequence,
				},
				lastEventSequence: state.lastEventSequence,
			} as unknown as DaemonAttachResult;
		});
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAttachResult: typeof createAttachResult;
			queueClientCatchup(
				client: DaemonSocketClient,
				activeSessionId: string,
				purpose?: "replacement" | "resync",
			): void;
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.sessions.set(firstState.activeSessionId, firstState);
		internals.sessions.set(secondState.activeSessionId, secondState);
		internals.createAttachResult = createAttachResult;
		internals.queueClientCatchup(client, firstState.activeSessionId, "replacement");
		internals.queueClientCatchup(client, secondState.activeSessionId, "resync");

		await internals.catchUpBackpressuredClient(client);

		expect(client.catchupActiveSessionIds).toEqual(
			new Set([firstState.activeSessionId, secondState.activeSessionId]),
		);
		expect(client.catchupPurposes).toEqual(
			new Map([
				[firstState.activeSessionId, "replacement"],
				[secondState.activeSessionId, "resync"],
			]),
		);
		expect(createAttachResult).toHaveBeenCalledOnce();

		await vi.waitFor(() => expect(createAttachResult).toHaveBeenCalledTimes(3));

		expect(client.catchupActiveSessionIds).toEqual(new Set());
		expect(client.catchupPurposes).toEqual(new Map());
		const messages = write.mock.calls.map(([data]) => JSON.parse(String(data)) as { type: string });
		expect(messages.map((message) => message.type)).toEqual(["session_replaced", "session_resynced"]);
	});

	it("does not attach a non-chunked client until its snapshot is ready", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const state = makeState("active");
		const client = makeClient("client-1", state.activeSessionId);
		client.attachedActiveSessionIds.clear();
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		const result = {
			activeSessionId: state.activeSessionId,
			snapshot: { summary: {}, state: {}, messages: [] },
			lastEventSequence: 0,
		} as unknown as DaemonAttachResult;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAttachResult: ReturnType<typeof vi.fn>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = vi.fn(async () => {
			await snapshotGate;
			return result;
		});

		const attach = internals.handleCommand(client, { type: "attach", activeSessionId: state.activeSessionId });
		await vi.waitFor(() => expect(internals.createAttachResult).toHaveBeenCalledOnce());
		expect(state.clients).not.toContain(client);
		expect(client.attachedActiveSessionIds).not.toContain(state.activeSessionId);
		releaseSnapshot();
		await attach;
		expect(state.clients).toContain(client);
		expect(client.attachedActiveSessionIds).toContain(state.activeSessionId);
	});

	it.each(["inline-detached", "chunked-detached", "chunked-failed"])(
		"releases a catch-up reservation: %s",
		async (outcome) => {
			const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
				defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
				createRuntime: vi.fn(),
			});
			const state = makeState("active");
			const write = vi.fn(() => true);
			const client = makeClient("client-1", state.activeSessionId);
			client.socket = { destroyed: false, write } as unknown as Socket;
			if (outcome.startsWith("chunked")) {
				client.transport = "private-framed";
				client.capabilities = new Set(["chunked_snapshot"]);
			}
			client.catchupActiveSessionIds = new Set([state.activeSessionId]);
			state.clients.add(client);
			let releaseSnapshot!: () => void;
			const snapshotGate = new Promise<void>((resolve) => {
				releaseSnapshot = resolve;
			});
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: { summary: {}, state: {}, messages: [], lastEventSequence: 0 },
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAttachResult: ReturnType<typeof vi.fn>;
				drainBackpressuredClientCatchups(client: DaemonSocketClient): Promise<void>;
				broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
			};
			internals.sessions.set(state.activeSessionId, state);
			let markSnapshotStarted!: () => void;
			const snapshotStarted = new Promise<void>((resolve) => {
				markSnapshotStarted = resolve;
			});
			internals.createAttachResult = vi.fn(async () => {
				markSnapshotStarted();
				await snapshotGate;
				if (outcome === "chunked-failed") throw new Error("snapshot preparation failed");
				return result;
			});

			const catchup = internals.drainBackpressuredClientCatchups(client);
			await snapshotStarted;
			expect(internals.createAttachResult).toHaveBeenCalledOnce();
			expect(client.snapshotStreaming).toBe(true);
			if (outcome.endsWith("detached")) {
				state.clients.delete(client);
				client.attachedActiveSessionIds.delete(state.activeSessionId);
			}
			releaseSnapshot();
			await catchup;
			clearTimeout(client.catchupRetryTimer);
			if (outcome === "chunked-failed") {
				internals.broadcastToSession(state, {
					type: "session_event",
					activeSessionId: state.activeSessionId,
					event: { type: "session_info_changed", name: "during retry" },
				});
				expect(client.deferredSessionFramesDropped?.has(state.activeSessionId)).toBe(true);
			}
			expect(write).not.toHaveBeenCalled();
			expect(client.snapshotStreaming).not.toBe(true);
			expect(client.snapshotActiveSessionCounts?.size ?? 0).toBe(0);
			expect(client.snapshotTransferAbortControllers?.size ?? 0).toBe(0);
			expect(client.catchupActiveSessionIds?.has(state.activeSessionId)).toBe(outcome === "chunked-failed");
		},
	);

	it("marks a chunked attach as snapshotting before deferred streaming", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-snapshot-order-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active");
			state.eventGeneration = "generation-1";
			const client = makeClient("client-1", state.activeSessionId);
			client.transport = "private-framed";
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: {
					activeSessionId: state.activeSessionId,
					summary: {},
					state: {},
					messages: [],
					lastEventSequence: 0,
					lastEventCursor: { generation: state.eventGeneration, sequence: 0 },
				},
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const streamWorkerSnapshot = vi.fn(async () => undefined);
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAttachResult: () => DaemonAttachResult;
				streamWorkerSnapshot: typeof streamWorkerSnapshot;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = () => result;
			internals.streamWorkerSnapshot = streamWorkerSnapshot;

			await internals.handleCommand(client, {
				type: "attach",
				activeSessionId: state.activeSessionId,
				capabilities: ["attach_snapshot", "event_sequence", "slim_attach", "chunked_snapshot"],
			});

			expect(client.snapshotActiveSessionIds).toContain(state.activeSessionId);
			expect(client.snapshotStreaming).toBe(true);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(streamWorkerSnapshot).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps overlapping snapshots active until every stream finishes", () => {
		const client = makeClient("client-1", "active");

		markClientSnapshotStreaming(client, "active");
		markClientSnapshotStreaming(client, "active");
		finishClientSnapshotStreaming(client, "active");

		expect(client.snapshotStreaming).toBe(true);
		expect(client.snapshotActiveSessionIds).toContain("active");
		expect(client.snapshotActiveSessionCounts?.get("active")).toBe(1);

		finishClientSnapshotStreaming(client, "active");
		expect(client.snapshotStreaming).toBe(false);
		expect(client.snapshotActiveSessionIds).not.toContain("active");
	});

	it("falls back to a full replacement when snapshot cache creation fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-daemon-replacement-fallback-"));
		try {
			const invalidAgentDir = join(root, "not-a-directory");
			writeFileSync(invalidAgentDir, "file");
			const daemon = new AgentDaemon(join(root, "daemon.sock"), {
				defaultSessionConfig: { agentDir: invalidAgentDir, cwd: root },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active");
			state.eventGeneration = "generation-1";
			const write = vi.fn((_data: unknown) => true);
			const client = makeClient("client-1", state.activeSessionId);
			client.socket = { destroyed: false, write } as unknown as Socket;
			client.transport = "private-framed";
			setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
			state.clients.add(client);
			const result = {
				activeSessionId: state.activeSessionId,
				snapshot: {
					activeSessionId: state.activeSessionId,
					summary: {},
					state: {},
					messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 1), timestamp: 0 }],
					lastEventSequence: 0,
					lastEventCursor: { generation: state.eventGeneration, sequence: 0 },
				},
				lastEventSequence: 0,
			} as unknown as DaemonAttachResult;
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAttachResult: () => Promise<DaemonAttachResult>;
				broadcastToSession(state: ActiveSessionState, message: unknown): void;
			};
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = async () => result;

			internals.broadcastToSession(state, {
				type: "session_replaced",
				activeSessionId: state.activeSessionId,
				state: {},
				messages: [],
			});

			await vi.waitFor(() => expect(write).toHaveBeenCalled());
			const frames = write.mock.calls.map((call) => String(call[0])).join("\n");
			expect(frames).toContain('"type":"session_replaced"');
			expect(frames).toContain('"snapshotFollows":true');
			expect(frames).toContain('"type":"session_snapshot_begin"');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["resolved", "rejected"] as const)(
		"does not send a replacement snapshot after the session closes while preparation is %s",
		async (outcome) => {
			const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
				defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active");
			state.eventGeneration = "generation-1";
			state.extensionUiRequests = new Map();
			state.unsubscribe = vi.fn();
			state.runtime = {
				...state.runtime,
				dispose: vi.fn(async () => {}),
				session: {
					sessionId: "session-active",
					sessionFile: undefined,
					isBashRunning: false,
					abort: vi.fn(async () => {}),
					sessionManager: { appendSessionState: vi.fn() },
				},
			} as unknown as ActiveSessionState["runtime"];
			const write = vi.fn((_data: unknown) => true);
			const client = makeClient("client-1", state.activeSessionId);
			client.socket = { destroyed: false, write } as unknown as Socket;
			client.transport = "private-framed";
			setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
			state.clients.add(client);
			let resolveAttach: (result: DaemonAttachResult) => void = () => {};
			let rejectAttach: (error: Error) => void = () => {};
			const pendingAttach = new Promise<DaemonAttachResult>((resolve, reject) => {
				resolveAttach = resolve;
				rejectAttach = reject;
			});
			const streamWorkerSnapshot = vi.fn(async () => {});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAttachResult: ReturnType<typeof vi.fn>;
				streamWorkerSnapshot: typeof streamWorkerSnapshot;
				closeSession(state: ActiveSessionState, reason: "killed"): Promise<void>;
				closeChildSessions: ReturnType<typeof vi.fn>;
				isEmptyDraftContent: ReturnType<typeof vi.fn>;
				abortBashForClose: ReturnType<typeof vi.fn>;
				recordWorkerRecoveryState: ReturnType<typeof vi.fn>;
				cancelScheduledJobsForSession: ReturnType<typeof vi.fn>;
				broadcastToSession(state: ActiveSessionState, message: unknown): void;
			};
			internals.sessions.set(state.activeSessionId, state);
			internals.createAttachResult = vi.fn(() => pendingAttach);
			internals.streamWorkerSnapshot = streamWorkerSnapshot;
			internals.closeChildSessions = vi.fn(async () => undefined);
			internals.isEmptyDraftContent = vi.fn(() => true);
			internals.abortBashForClose = vi.fn(async () => {});
			internals.recordWorkerRecoveryState = vi.fn();
			internals.cancelScheduledJobsForSession = vi.fn();

			internals.broadcastToSession(state, {
				type: "session_replaced",
				activeSessionId: state.activeSessionId,
				state: {},
				messages: [],
			});
			const snapshotSignal = client.snapshotTransferAbortControllers?.get(state.activeSessionId)?.signal;
			expect(snapshotSignal?.aborted).toBe(false);

			await internals.closeSession(state, "killed");
			expect(snapshotSignal?.aborted).toBe(true);

			if (outcome === "resolved") {
				resolveAttach({
					activeSessionId: state.activeSessionId,
					snapshot: { summary: {}, state: {}, messages: [] },
					lastEventSequence: 0,
				} as unknown as DaemonAttachResult);
			} else {
				rejectAttach(new Error("snapshot preparation failed after close"));
			}
			await vi.waitFor(() => expect(client.snapshotStreaming).toBe(false));

			const frames = write.mock.calls.map((call) => String(call[0])).join("\n");
			expect(frames).toContain('"type":"session_closed"');
			expect(frames).not.toContain('"type":"session_replaced"');
			expect(frames).not.toContain('"type":"session_snapshot_begin"');
			expect(streamWorkerSnapshot).not.toHaveBeenCalled();
		},
	);

	it("registers passive descendants' scheduled jobs when their root becomes resident", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passive-descendant-jobs-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const childSessionId = basename(fixture.childArtifactDir);
			const grandchildSessionId = basename(fixture.grandchildSessionFile, ".jsonl");
			const seedStore = AgentCronJobStore.forSessionArtifacts();
			seedStore.registerSessionArtifact(childSessionId, fixture.childArtifactDir);
			seedStore.registerSessionArtifact(
				grandchildSessionId,
				getSessionArtifactPathForFile(fixture.grandchildSessionFile, grandchildSessionId),
			);
			const makeJob = (sessionId: string, sessionFile: string) =>
				seedStore.createRlmHeartbeat({
					activeSessionId: `stale-${sessionId}`,
					sessionId,
					sessionFile,
					cwd: tempDir,
					runtimeKind: "subagent",
					scheduleText: "every 30s",
					prompt: "report exactly: hi",
				});
			makeJob(childSessionId, fixture.childSessionFile);
			const grandchildHeartbeat = makeJob(grandchildSessionId, fixture.grandchildSessionFile);

			const workerDaemon = new AgentDaemon(join(tempDir, "worker-daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: join(tempDir, "sessions") },
				createRuntime: fixture.createRuntime,
				worker: { authenticationToken: "worker-token" },
			});
			const internals = workerDaemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			// A corrupt child artifact must not strand the remaining descendants.
			const recover = internals.cronStore.recoverSessionArtifact.bind(internals.cronStore);
			vi.spyOn(internals.cronStore, "recoverSessionArtifact").mockImplementation((sessionId) => {
				if (sessionId === childSessionId) throw new Error("corrupt scheduled-jobs.json");
				return recover(sessionId);
			});

			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			await vi.waitFor(() =>
				expect(internals.cronStore.list().some((job) => job.id === grandchildHeartbeat.id)).toBe(true),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	function makePassiveMemoHarness(tempDir: string) {
		const fixture = makePersistedRlmDaemonFixture(tempDir);
		const internals = fixture.daemon as unknown as {
			createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			listPassiveRlmSubagents(): Promise<
				Array<{ entry: { childId: string; status: string }; info: { messageCount: number } }>
			>;
		};
		return { fixture, internals };
	}

	const passiveMessageLine = (id: string, text: string) =>
		`${JSON.stringify({
			type: "message",
			id,
			parentId: null,
			timestamp: "2026-01-01T00:00:02.000Z",
			message: { role: "user", content: text, timestamp: 3 },
		})}\n`;

	it("memoizes the passive topology walk until a topology input changes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passive-memo-"));
		try {
			const { fixture, internals } = makePassiveMemoHarness(tempDir);
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			// The first walk seeds the ledger, so it never memoizes; the second is
			// the first stable derivation and the third must reuse it.
			await internals.listPassiveRlmSubagents();
			const first = await internals.listPassiveRlmSubagents();
			expect(first.map(({ entry }) => entry.childId)).toEqual(
				expect.arrayContaining([fixture.childId, fixture.grandchildId]),
			);
			expect(await internals.listPassiveRlmSubagents()).toBe(first);

			// A child session append invalidates the memo and re-derives fresh infos.
			appendFileSync(fixture.childSessionFile, passiveMessageLine("m2", "one more instruction"));
			const third = await internals.listPassiveRlmSubagents();
			expect(third).not.toBe(first);
			expect(third.find(({ entry }) => entry.childId === fixture.childId)?.info.messageCount).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it.each(["display", "legacy"] as const)(
		"retries a transient %s metadata read failure without a stat change",
		async (source) => {
			const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passive-read-retry-"));
			const readFile = fsPromises.readFile;
			let readSpy: ReturnType<typeof vi.spyOn> | undefined;
			try {
				const { fixture, internals } = makePassiveMemoHarness(tempDir);
				await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
				// Seed the ledger before failing optional metadata reads.
				await internals.listPassiveRlmSubagents();
				const metadata = {
					type: "rlm_subagent",
					childId: fixture.childId,
					sessionName: "spawn-worker",
					sessionDir: fixture.childSessionDir,
					sessionFile: fixture.childSessionFile,
					rlmDepth: 1,
					rlmMaxDepth: 7,
					prompt: "recover the original task",
					model: { provider: "test-provider", modelId: "test-model" },
					status: "running",
					createdAt: 1,
					updatedAt: "2026-01-01T00:00:00.000Z",
				};
				const metadataPath =
					source === "display"
						? join(fixture.childSessionDir, "rlm-subagent.json")
						: join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
				writeFileSync(metadataPath, `${JSON.stringify(metadata)}\n`);
				const before = statSync(metadataPath);
				let metadataReads = 0;
				readSpy = vi.spyOn(fsPromises, "readFile").mockImplementation((...args) => {
					if (
						typeof args[0] === "string" &&
						canonicalSessionPath(args[0]) === canonicalSessionPath(metadataPath) &&
						++metadataReads === 1
					) {
						return Promise.reject(
							Object.assign(new Error("transient metadata read failure"), { code: "EACCES" }),
						);
					}
					return readFile(...args);
				});
				syncBuiltinESMExports();

				const fallback = await internals.listPassiveRlmSubagents();
				expect(fallback.find(({ entry }) => entry.childId === fixture.childId)?.entry.status).toBe("completed");
				expect(metadataReads).toBe(1);
				const recovered = await internals.listPassiveRlmSubagents();
				expect(recovered.find(({ entry }) => entry.childId === fixture.childId)?.entry).toMatchObject({
					prompt: metadata.prompt,
					model: metadata.model,
					rlmDepth: 1,
					rlmMaxDepth: 7,
					status: "running",
				});
				expect(metadataReads).toBe(2);
				const after = statSync(metadataPath);
				expect([after.size, after.mtimeMs, after.ino]).toEqual([before.size, before.mtimeMs, before.ino]);
				expect(await internals.listPassiveRlmSubagents()).toBe(recovered);
				expect(metadataReads).toBe(2);
			} finally {
				readSpy?.mockRestore();
				syncBuiltinESMExports();
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	);

	it("reports failed passive children as errors without creating child runtimes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-list-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			// Simulate children written before rlmDepth was added to the extensible header.
			// Their persisted registry rows remain the compatibility source after restart.
			for (const sessionFile of [fixture.childSessionFile, fixture.grandchildSessionFile]) {
				const lines = readFileSync(sessionFile, "utf8").split("\n");
				const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
				delete header.rlmDepth;
				lines[0] = JSON.stringify(header);
				writeFileSync(sessionFile, lines.join("\n"));
			}
			const parentRegistry = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const failedEntry = JSON.parse(readFileSync(parentRegistry, "utf8").trim()) as Record<string, unknown>;
			// Failed children retain their last "running" registry row after the runtime is released.
			writeFileSync(parentRegistry, `${JSON.stringify({ ...failedEntry, status: "running" })}\n`);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				buildRlmChildSnapshotsWithPassiveRlmSubagents(
					state: ActiveSessionState,
				): Promise<NonNullable<DaemonAttachResult["snapshot"]["children"]>>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};

			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			expect([...internals.sessions.values()]).toEqual([parentState]);
			const children = await internals.buildRlmChildSnapshotsWithPassiveRlmSubagents(parentState);
			expect(children).toEqual([
				expect.objectContaining({
					id: fixture.childId,
					status: "error",
				}),
				expect.objectContaining({
					id: fixture.grandchildId,
					parentId: fixture.childId,
					status: "done",
				}),
			]);
			expect(children.every((child) => child.activeSessionId === undefined)).toBe(true);
			// Snapshotting must reuse the passive registry walk without hydrating children.
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			const listedAgents = await internals.createAgentMessageController(() => parentState).listAgents();
			expect(listedAgents.agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: expect.any(String),
					sessionId: expect.any(String),
					sessionName: "renamed-worker",
					runtimeKind: "subagent",
					parentActiveSessionId: parentState.activeSessionId,
					status: "inactive",
					rlmChildId: fixture.childId,
					rlmChildRegistryStatus: "running",
				}),
			);
			expect(listedAgents.agents).toContainEqual(
				expect.objectContaining({
					sessionName: "nested-worker",
					status: "inactive",
					rlmChildId: fixture.grandchildId,
					rlmChildRegistryStatus: "completed",
				}),
			);
			const listResponse = (await internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
				type: "list",
				all: true,
			})) as { data: { sessions: Array<Record<string, unknown>> } };
			const passiveRow = listResponse.data.sessions.find(
				(session) => session.sessionFile === fixture.childSessionFile,
			);
			expect(passiveRow).toMatchObject({
				lifecycle: "live",
				sessionName: "renamed-worker",
				runtimeKind: "subagent",
				parentActiveSessionId: parentState.activeSessionId,
				rlmChildId: fixture.childId,
				parentSessionPath: fixture.parentSessionFile,
				rlmDepth: 1,
			});
			expect(passiveRow?.activeSessionId).toBeUndefined();
			const nestedRow = listResponse.data.sessions.find(
				(session) => session.sessionFile === fixture.grandchildSessionFile,
			);
			expect(nestedRow).toMatchObject({
				sessionName: "nested-worker",
				runtimeKind: "subagent",
				rlmChildId: fixture.grandchildId,
				parentSessionPath: fixture.childSessionFile,
				rlmDepth: 2,
			});

			const activeOnlyResponse = (await internals.handleCommand(
				makeClient("client-2", parentState.activeSessionId),
				{ type: "list" },
			)) as { data: { sessions: Array<Record<string, unknown>> } };
			expect(activeOnlyResponse.data.sessions).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ sessionFile: fixture.childSessionFile, rlmChildId: fixture.childId }),
					expect.objectContaining({
						sessionFile: fixture.grandchildSessionFile,
						rlmChildId: fixture.grandchildId,
						parentSessionPath: fixture.childSessionFile,
					}),
				]),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lists passive descendants under a nonresident saved root", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-nonresident-root-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentManager = SessionManager.open(fixture.parentSessionFile);
			parentManager.appendMessage({ role: "user", content: "parent task", timestamp: 0 });
			parentManager.flushNow();
			const parentInfo = await readSessionInfo(fixture.parentSessionFile);
			if (!parentInfo) throw new Error("Missing parent session info");
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				buildSessionListWithPassiveRlmSubagents(
					activeSessions: ActiveSessionState[],
					savedSessions: SessionInfo[],
					scheduledJobs: AgentCronJob[],
				): Promise<SessionSummary[]>;
			};

			expect(internals.sessions.size).toBe(0);
			const sessions = await internals.buildSessionListWithPassiveRlmSubagents([], [parentInfo], []);
			const child = sessions.find((session) => session.sessionFile === fixture.childSessionFile);
			expect(child).toMatchObject({
				runtimeKind: "subagent",
				parentSessionId: fixture.parentSessionId,
				parentSessionPath: fixture.parentSessionFile,
				rlmChildId: fixture.childId,
				rlmDepth: 1,
			});
			expect(child?.parentActiveSessionId).toBeUndefined();

			const grandchild = sessions.find((session) => session.sessionFile === fixture.grandchildSessionFile);
			expect(grandchild).toMatchObject({
				runtimeKind: "subagent",
				parentSessionPath: fixture.childSessionFile,
				rlmChildId: fixture.grandchildId,
				rlmDepth: 2,
			});
			expect(grandchild?.parentActiveSessionId).toBeUndefined();
			expect(fixture.createRuntime).not.toHaveBeenCalled();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers the per-child display file over the legacy registry for passive metadata", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-display-over-registry-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			// A post-consolidation write: the display file is fresher than the
			// stale pre-ledger registry entry left behind by an old daemon.
			writeFileSync(
				join(fixture.childSessionDir, "rlm-subagent.json"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: fixture.childId,
					sessionName: "renamed-worker",
					sessionDir: fixture.childSessionDir,
					sessionFile: fixture.childSessionFile,
					rlmMaxDepth: 6,
					rlmParentNodeId: fixture.childId,
					prompt: "fresher prompt",
					status: "completed",
					createdAt: 3,
					updatedAt: "2026-01-02T00:00:00.000Z",
				})}\n`,
			);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<
					Array<{ entry: { childId: string; prompt?: string; rlmMaxDepth?: number } }>
				>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			const passive = (await internals.listPassiveRlmSubagents()).find(
				({ entry }) => entry.childId === fixture.childId,
			);
			expect(passive?.entry).toMatchObject({ prompt: "fresher prompt", rlmMaxDepth: 6 });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("falls back to the legacy registry for a pre-ledger child without a display file", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-legacy-metadata-fallback-"));
		try {
			// The fixture writes registries exactly as the pre-consolidation daemon
			// did and no display files: the pure migration state.
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryPath, "utf8").trim()) as Record<string, unknown>;
			registryEntry.prompt = "legacy prompt";
			registryEntry.spawnCode = "await rlm('legacy prompt')";
			registryEntry.model = { provider: "test", modelId: "legacy-model" };
			writeFileSync(registryPath, `${JSON.stringify(registryEntry)}\n`);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<
					Array<{
						entry: {
							childId: string;
							prompt?: string;
							spawnCode?: string;
							model?: { provider: string; modelId: string };
							rlmMaxDepth?: number;
							status: string;
						};
					}>
				>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			const passive = (await internals.listPassiveRlmSubagents()).find(
				({ entry }) => entry.childId === fixture.childId,
			);
			expect(passive?.entry).toMatchObject({
				prompt: "legacy prompt",
				spawnCode: "await rlm('legacy prompt')",
				model: { provider: "test", modelId: "legacy-model" },
				rlmMaxDepth: 4,
				status: "completed",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("ignores a crashed registry tail and protects a nested cycle back to the root", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-corrupt-registry-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentRegistry = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			writeFileSync(parentRegistry, `${readFileSync(parentRegistry, "utf8")}{"type":"rlm_subagent","childId":`);

			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const childRegistry = join(
				fixture.parentArtifactDir,
				"session-artifacts",
				childInfo.id,
				"rlm-subagents.jsonl",
			);
			writeFileSync(
				childRegistry,
				`${readFileSync(childRegistry, "utf8")}${JSON.stringify({
					type: "rlm_subagent",
					childId: "cycle-to-root",
					sessionName: "cycle-to-root",
					sessionDir: join(tempDir, "sessions"),
					sessionFile: fixture.parentSessionFile,
					parentSessionId: childInfo.id,
					parentSessionFile: fixture.childSessionFile,
					status: "completed",
					createdAt: 3,
					updatedAt: "2026-01-01T00:00:02.000Z",
				})}
`,
			);

			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const response = (await internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
				type: "list",
			})) as { data: { sessions: Array<{ rlmChildId?: string }> } };

			expect(response.data.sessions.map((session) => session.rlmChildId).filter(Boolean)).toEqual([
				fixture.childId,
				fixture.grandchildId,
			]);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("recomputes snapshot children when the runtime session changes during the passive walk", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-snapshot-replacement-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSessionSnapshot(state: ActiveSessionState): Promise<DaemonAttachResult["snapshot"]>;
				createConnectionState: ReturnType<typeof vi.fn>;
				buildRlmChildSnapshotsWithPassiveRlmSubagents: ReturnType<typeof vi.fn>;
			};
			const state = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const originalSession = state.runtime.session;
			const replacementSession = Object.create(originalSession) as typeof originalSession;
			Object.defineProperty(replacementSession, "messages", {
				value: [{ role: "user", content: "new transcript", timestamp: 1 }],
			});
			internals.createConnectionState = vi.fn(() => ({}));
			let calls = 0;
			internals.buildRlmChildSnapshotsWithPassiveRlmSubagents = vi.fn(async () => {
				calls++;
				if (calls === 1)
					(state.runtime as unknown as { _session: typeof originalSession })._session =
						replacementSession as typeof originalSession;
				return [{ id: calls === 1 ? "old-child" : "new-child", status: "done", sessionDir: tempDir }];
			});

			const snapshot = await internals.createSessionSnapshot(state);

			expect(internals.buildRlmChildSnapshotsWithPassiveRlmSubagents).toHaveBeenCalledTimes(2);
			expect(snapshot.children).toEqual([expect.objectContaining({ id: "new-child" })]);
			expect(snapshot.messages).toBe(replacementSession.messages);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("hydrates a passive child on agent message and delivers to it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-message-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({
						target: "renamed-worker",
						message: "report progress",
					}),
			).resolves.toMatchObject({
				deliveryStatus: "delivered",
				target: { runtimeKind: "subagent", sessionName: "renamed-worker" },
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledOnce();
			expect(
				[...internals.sessions.values()].filter((state) => state.runtime.metadata.kind === "subagent"),
			).toHaveLength(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not match a renamed passive child by its stale registry name", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-renamed-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const siblingId = "child-2";
			const siblingSessionDir = join(fixture.parentArtifactDir, siblingId);
			const siblingManager = SessionManager.create(tempDir, siblingSessionDir);
			siblingManager.newSession({ parentSession: fixture.parentSessionFile });
			siblingManager.appendSessionInfo("spawn-worker");
			siblingManager.flushNow();
			const siblingSessionFile = siblingManager.getSessionFile();
			if (!siblingSessionFile) throw new Error("Missing sibling session file");
			const parentRegistry = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			writeFileSync(
				parentRegistry,
				`${readFileSync(parentRegistry, "utf8")}${JSON.stringify({
					type: "rlm_subagent",
					childId: siblingId,
					sessionName: "spawn-worker",
					sessionDir: siblingSessionDir,
					sessionFile: siblingSessionFile,
					parentSessionId: fixture.parentSessionId,
					parentSessionFile: fixture.parentSessionFile,
					status: "completed",
					createdAt: 2,
					updatedAt: "2026-01-01T00:00:01.000Z",
				})}\n`,
			);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({ target: "spawn-worker", message: "report progress" }),
			).resolves.toMatchObject({
				deliveryStatus: "delivered",
				target: { runtimeKind: "subagent", sessionName: "spawn-worker" },
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionManager.getSessionFile()).toBe(siblingSessionFile);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rehydrates completed children without rewriting their persisted completion", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-idempotent-rlm-hydration-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				recordRlmSubagentState: ReturnType<typeof vi.fn>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const before = readFileSync(registryPath, "utf8");
			internals.recordRlmSubagentState = vi.fn(() => false);

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({ target: "renamed-worker", message: "report progress" }),
			).resolves.toMatchObject({ deliveryStatus: "delivered" });

			expect(internals.recordRlmSubagentState).not.toHaveBeenCalled();
			expect(readFileSync(registryPath, "utf8")).toBe(before);
			expect(existsSync(join(fixture.childSessionDir, "rlm-subagent.json"))).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("prefers the persisted header depth when a legacy registry entry lacks one", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-legacy-header-depth-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const childLines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const childHeader = JSON.parse(childLines[0] ?? "{}") as Record<string, unknown>;
			childHeader.rlmDepth = 2;
			childLines[0] = JSON.stringify(childHeader);
			writeFileSync(fixture.childSessionFile, childLines.join("\n"));

			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryPath, "utf8").trim()) as Record<string, unknown>;
			delete registryEntry.rlmDepth;
			writeFileSync(registryPath, `${JSON.stringify(registryEntry)}\n`);

			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});

			await internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: "renamed-worker", message: "report progress" });

			// The nested header depth must win over the legacy depth-1 default so the
			// woken child does not come up shallower than persisted.
			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionOptions?.rlmDepth).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects direct messages to nested passive grandchildren without hydrating them", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-nested-message-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const reachError = "Agent reach is limited to parent, siblings, and children";

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({
						target: "nested-worker",
						message: "report nested progress",
					}),
			).rejects.toThrow(reachError);
			const observe = internals.createAgentObserveController(() => parentState);
			await expect(observe.getAgent("nested-worker")).rejects.toThrow(reachError);
			await expect(observe.recentMessages({ target: "nested-worker" })).rejects.toThrow(reachError);

			expect([...internals.sessions.values()]).toEqual([parentState]);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("waits for an explicit open reservation before hydrating a passive child", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-reservation-race-"));
		let releaseOpen!: () => void;
		const openGate = new Promise<void>((resolveGate) => {
			releaseOpen = resolveGate;
		});
		let markOpenStarted!: () => void;
		const openStarted = new Promise<void>((resolveStarted) => {
			markOpenStarted = resolveStarted;
		});
		const originalOpenAsync = SessionManager.openAsync;
		let openAsyncSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				reservingSessionOpens: Map<string, Promise<void>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(target: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const findPassiveRlmSubagent = internals.findPassiveRlmSubagent.bind(fixture.daemon);
			const passive = await findPassiveRlmSubagent(fixture.childId);
			if (!passive) throw new Error("Missing passive child");
			internals.findPassiveRlmSubagent = vi.fn(async (target: string) => {
				if (resolve(target) === resolve(fixture.childSessionFile)) {
					return undefined;
				}
				return findPassiveRlmSubagent(target);
			});
			openAsyncSpy = vi
				.spyOn(SessionManager, "openAsync")
				.mockImplementation(async (path, sessionDir, cwdOverride) => {
					if (resolve(path) === resolve(fixture.childSessionFile)) {
						markOpenStarted();
						await openGate;
					}
					return originalOpenAsync(path, sessionDir, cwdOverride);
				});

			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			await openStarted;
			expect(internals.reservingSessionOpens.has(resolve(fixture.childSessionFile))).toBe(true);

			const hydration = internals.hydratePassiveRlmSubagent(passive);
			const joined = Promise.all([explicitOpen, hydration]);
			releaseOpen();

			const [openedState, hydratedState] = await joined;
			expect(openedState.runtime.session.sessionFile).toBe(fixture.childSessionFile);
			expect(hydratedState.runtime.session.sessionFile).toBe(fixture.childSessionFile);
			// Kind fidelity may replace a non-subagent explicit open with a proper
			// subagent rehydration; either way the lazy path must join the explicit
			// open's lease instead of failing with a lease conflict, and exactly one
			// resident state may own the session file afterwards.
			const internalsAfter = fixture.daemon as unknown as { sessions: Map<string, ActiveSessionState> };
			const owners = [...internalsAfter.sessions.values()].filter(
				(state) => state.runtime.session.sessionFile === fixture.childSessionFile,
			);
			expect(owners).toHaveLength(1);
			expect(owners[0]).toBe(hydratedState);
		} finally {
			releaseOpen();
			openAsyncSpy?.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects passive hydration while an update restart is fenced", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-update-hydration-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				updateRestart: unknown;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			internals.updateRestart = { phase: "prepared" };

			await expect(internals.getOrHydrateBoundSessionState(fixture.childId)).rejects.toThrow(
				"Daemon is preparing an update restart",
			);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("coalesces a gated hydration with concurrent messaging and an explicit open", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-race-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolveGate) => {
			releaseHydration = resolveGate;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolveStarted) => {
			markHydrationStarted = resolveStarted;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childRuntimeStarted: markHydrationStarted,
				childRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const controller = internals.createAgentMessageController(() => parentState);

			const firstMessage = controller.sendAgentMessage({ target: fixture.childId, message: "first" });
			await hydrationStarted;
			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const secondMessage = controller.sendAgentMessage({ target: fixture.childId, message: "second" });
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);

			releaseHydration();
			const [, openedState] = await Promise.all([firstMessage, explicitOpen, secondMessage]);

			expect(openedState.runtime.metadata).toMatchObject({ kind: "subagent", rlmChildId: fixture.childId });
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			expect(
				[...internals.sessions.values()].filter((state) => state.runtime.metadata.kind === "subagent"),
			).toHaveLength(1);
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledTimes(2);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a parent resident while one of its passive descendants is hydrating", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-hydration-passivation-race-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolve) => {
			markHydrationStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				grandchildRuntimeStarted: markHydrationStarted,
				grandchildRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const rootState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
			});
			const rootSession = rootState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			rootSession.releaseRlmChildSession = vi.fn(() => vi.fn());

			const hydration = internals.getOrHydrateBoundSessionState(fixture.grandchildId);
			await hydrationStarted;
			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(internals.sessions.get(parentState.activeSessionId)).toBe(parentState);
			expect(rootSession.releaseRlmChildSession).not.toHaveBeenCalled();

			releaseHydration();
			const grandchildState = await hydration;
			expect(internals.sessions.get(parentState.activeSessionId)).toBe(parentState);
			expect(grandchildState.runtime.metadata).toMatchObject({
				parentActiveSessionId: parentState.activeSessionId,
				rlmChildId: fixture.grandchildId,
			});
			expect(
				(parentState.runtime.session as unknown as { registerRlmChildSession: ReturnType<typeof vi.fn> })
					.registerRlmChildSession,
			).toHaveBeenCalledWith(fixture.grandchildId, grandchildState.runtime.session);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("retries hydration when the target child starts passivating after the initial wait", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-child-hydration-passivation-race-"));
		let releasePassivation!: () => void;
		const passivationGate = new Promise<void>((resolve) => {
			releasePassivation = resolve;
		});
		let markRaceStarted!: () => void;
		const raceStarted = new Promise<void>((resolve) => {
			markRaceStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				closingSessions: Map<string, { promise: Promise<void>; reason: "shutdown"; killedEffects?: Promise<void> }>;
				passivatingSessions: Map<string, Promise<void>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
				rehydrateCompletedRlmSubagent(
					parent: ActiveSessionState,
					entry: { childId: string; sessionFile: string },
				): Promise<ActiveSessionState>;
				waitForBoundSession(state: ActiveSessionState): Promise<ActiveSessionState>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = await internals.findPassiveRlmSubagent(fixture.childId);
			if (!passive) throw new Error("Missing passive child");
			const closingChild = makeState("closing-child", rootState.activeSessionId);
			const refreshedChild = makeState("refreshed-child", rootState.activeSessionId);
			Object.assign(closingChild.runtime, { session: { sessionFile: fixture.childSessionFile } });
			Object.assign(refreshedChild.runtime, { session: { sessionFile: fixture.childSessionFile } });
			const passivation = passivationGate.then(() => {
				internals.sessions.delete(closingChild.activeSessionId);
				internals.closingSessions.delete(closingChild.activeSessionId);
				throw new Error("passivation failed");
			});
			let hydrationAttempts = 0;
			internals.rehydrateCompletedRlmSubagent = vi.fn(async () => {
				if (++hydrationAttempts === 1) {
					internals.sessions.set(closingChild.activeSessionId, closingChild);
					internals.closingSessions.set(closingChild.activeSessionId, {
						promise: passivation,
						reason: "shutdown",
					});
					internals.passivatingSessions.set(resolve(fixture.childSessionFile), passivation);
					markRaceStarted();
					return internals.waitForBoundSession(closingChild);
				}
				internals.sessions.set(refreshedChild.activeSessionId, refreshedChild);
				return refreshedChild;
			});
			internals.findPassiveRlmSubagent = vi.fn(async () => passive);

			const hydration = internals.hydratePassiveRlmSubagent(passive);
			await raceStarted;
			releasePassivation();

			await expect(hydration).resolves.toBe(refreshedChild);
			expect(hydrationAttempts).toBe(2);
		} finally {
			releasePassivation();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a child resident while an attach snapshot is in flight", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-attach-passivation-race-"));
		let releaseSnapshot!: () => void;
		const snapshotGate = new Promise<void>((resolve) => {
			releaseSnapshot = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAttachResult: ReturnType<typeof vi.fn>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const client = makeClient("attach-client", childState.activeSessionId);
			client.attachedActiveSessionIds.clear();
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => true);
			internals.createAttachResult = vi.fn(async () => {
				await snapshotGate;
				return { activeSessionId: childState.activeSessionId, snapshot: {}, lastEventSequence: 0 };
			});

			const attach = internals.handleCommand(client, {
				type: "attach",
				activeSessionId: childState.activeSessionId,
			});
			await vi.waitFor(() => expect(childState.pendingAttaches).toBe(1));
			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			expect(parentState.runtime.session.releaseRlmChildSession).not.toHaveBeenCalled();

			releaseSnapshot();
			await attach;
			expect(childState.pendingAttaches).toBe(0);
			expect(childState.clients).toContain(client);
			expect(client.attachedActiveSessionIds).toContain(childState.activeSessionId);
		} finally {
			releaseSnapshot();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not passivate a child that starts streaming during the fence snapshot", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passivation-stream-race-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents: ReturnType<typeof vi.fn>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const childSession = childState.runtime.session as unknown as {
				isStreaming: boolean;
				isSessionActive: boolean;
				abort: ReturnType<typeof vi.fn>;
			};
			let passiveListCalls = 0;
			internals.listPassiveRlmSubagents = vi.fn(async () => {
				passiveListCalls++;
				if (passiveListCalls === 2) {
					childSession.isStreaming = true;
					childSession.isSessionActive = true;
				}
				return [];
			});

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(passiveListCalls).toBe(2);
			expect(childSession.abort).not.toHaveBeenCalled();
			expect(parentState.runtime.session.releaseRlmChildSession).not.toHaveBeenCalled();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps ownership of a resident child until passivation succeeds", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passivation-close-failure-"));
		let releaseAbort!: () => void;
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		let markAbortStarted!: () => void;
		const abortStarted = new Promise<void>((resolve) => {
			markAbortStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			let parentOwnsChild = true;
			let forwarderActive = true;
			const parentUpdates: string[] = [];
			const emitChildUpdate = (recap: string) => {
				if (forwarderActive) parentUpdates.push(recap);
			};
			const unsubscribeForwarder = vi.fn(() => {
				forwarderActive = false;
			});
			parentSession.releaseRlmChildSession = vi.fn(() => {
				if (!parentOwnsChild) return false;
				return () => {
					parentOwnsChild = false;
					unsubscribeForwarder();
				};
			});
			childState.unsubscribe = vi
				.fn()
				.mockImplementationOnce(() => {
					throw new Error("unsubscribe failed");
				})
				.mockImplementation(() => undefined);
			const childSession = childState.runtime.session as unknown as { abort: ReturnType<typeof vi.fn> };
			childSession.abort = vi.fn(async () => {
				markAbortStarted();
				await abortGate;
			});

			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await abortStarted;
			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const delivery = internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: fixture.childId, message: "continue after failed passivation" });
			releaseAbort();

			await expect(passivation).rejects.toThrow("unsubscribe failed");
			await expect(explicitOpen).resolves.toBe(childState);
			await expect(delivery).resolves.toMatchObject({ deliveryStatus: "delivered" });
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			expect(parentOwnsChild).toBe(true);
			expect(unsubscribeForwarder).not.toHaveBeenCalled();
			emitChildUpdate("recap after failed close");
			expect(parentUpdates).toEqual(["recap after failed close"]);

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(1);
			expect(parentSession.releaseRlmChildSession).toHaveBeenCalledTimes(2);
			expect(unsubscribeForwarder).toHaveBeenCalledOnce();
			emitChildUpdate("recap after successful close");
			expect(parentUpdates).toEqual(["recap after failed close"]);
			expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
		} finally {
			releaseAbort();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("limits each worker sweep and leaves non-leaf children resident", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-passivation-cap.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const root = makeState("root");
		const oldestLeaf = makeState("oldest-leaf", "root");
		const nextLeaf = makeState("next-leaf", "root");
		const queuedLeaf = makeState("queued-leaf", "root");
		const nonLeaf = makeState("non-leaf", "root");
		const nested = makeState("nested", "non-leaf");
		const states = [root, oldestLeaf, nextLeaf, queuedLeaf, nonLeaf, nested];
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			listPassiveRlmSubagents: ReturnType<typeof vi.fn>;
			sessionPassivationSnapshot: ReturnType<typeof vi.fn>;
			passivateSession: ReturnType<typeof vi.fn>;
			passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
		};
		for (const state of states) internals.sessions.set(state.activeSessionId, state);
		const order = new Map([
			[oldestLeaf, 1],
			[nextLeaf, 2],
			[queuedLeaf, 3],
			[nested, 4],
			[nonLeaf, 5],
			[root, 6],
		]);
		internals.listPassiveRlmSubagents = vi.fn(async () => []);
		internals.sessionPassivationSnapshot = vi.fn(async (state: ActiveSessionState) => ({
			isSessionActive: false,
			attachedClients: 0,
			hasRegisteredCronJob: false,
			lastActivityAt: order.get(state) ?? 99,
			hasParent: state !== root,
			hasNonPassiveDescendants: state === nonLeaf,
			isHydrating: false,
		}));
		internals.passivateSession = vi.fn(async () => true);

		await expect(internals.passivateIdleChildren(90, 200 * 60_000, 2)).resolves.toBe(2);
		expect(internals.sessionPassivationSnapshot).toHaveBeenCalledTimes(states.length);
		expect(internals.passivateSession).toHaveBeenCalledTimes(2);
		expect(internals.passivateSession.mock.calls.map((call) => call[0])).toEqual([oldestLeaf, nextLeaf]);
		expect(internals.passivateSession).not.toHaveBeenCalledWith(nonLeaf, expect.anything(), expect.anything());
		expect(internals.passivateSession).not.toHaveBeenCalledWith(queuedLeaf, expect.anything(), expect.anything());
	});

	it("passivates an idle leaf and makes list, attach, and message use the normal passive wake path", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passivate-child-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				passivateIdleChildren(threshold: number | "off", now: number, limit: number): Promise<number>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const firstChild = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSession.releaseRlmChildSession = vi.fn(() => vi.fn());

			expect(await internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 2)).toBe(1);
			expect(internals.sessions.has(firstChild.activeSessionId)).toBe(false);
			expect(parentSession.releaseRlmChildSession).toHaveBeenCalledWith(fixture.childId, firstChild.runtime.session);
			expect(fixture.runtimeSessions[1]?.disposeAsync).toHaveBeenCalledOnce();

			const listed = (await internals.handleCommand(makeClient("list-client", parentState.activeSessionId), {
				type: "list",
			})) as { data: { sessions: Array<Record<string, unknown>> } };
			const passiveRow = listed.data.sessions.find((row) => row.sessionFile === fixture.childSessionFile);
			expect(passiveRow).toMatchObject({ rlmChildId: fixture.childId, sessionName: "renamed-worker" });
			expect(passiveRow?.activeSessionId).toBeUndefined();

			const attachedState = await (
				fixture.daemon as unknown as {
					getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				}
			).getOrHydrateBoundSessionState(String(passiveRow?.sessionId));
			expect(attachedState.runtime.metadata).toMatchObject({ rlmChildId: fixture.childId });

			// Detach so the same runtime can passivate again and prove a2a wake/delivery.
			attachedState?.clients.clear();
			const parentSessionAgain = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSessionAgain.releaseRlmChildSession = vi.fn(() => vi.fn());
			expect(await internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 2)).toBe(1);
			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({
						target: fixture.childId,
						message: "wake after passivation",
					}),
			).resolves.toMatchObject({ deliveryStatus: "delivered", target: { runtimeKind: "subagent" } });
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledWith(
				expect.stringContaining("wake after passivation"),
				expect.any(Object),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("waits for passivation before rehydrating and delivering a racing a2a message", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passivation-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childDisposeStarted: markDisposeStarted,
				childDisposeGate: disposeGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				parentState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());

			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await disposeStarted;
			// The child is still resident and closing while dispose is blocked. A child-ID
			// selector must join passivation instead of treating that resident state as targetable.
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			const delivery = internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({
					target: fixture.childId,
					message: "arrived while passivating",
				});
			const explicitOpen = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			await Promise.resolve();
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
			releaseDispose();

			await expect(passivation).resolves.toBe(1);
			await expect(delivery).resolves.toMatchObject({ deliveryStatus: "delivered" });
			await expect(explicitOpen).resolves.toMatchObject({
				runtime: { metadata: { rlmChildId: fixture.childId } },
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(3);
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledWith(
				expect.stringContaining("arrived while passivating"),
				expect.any(Object),
			);
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("refuses to delete a busy hydrated child and deletes it after it becomes idle", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-hydrated-rlm-delete-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			let isStreaming = true;
			Object.defineProperty(childState.runtime.session, "isStreaming", { get: () => isStreaming });
			Object.defineProperty(childState.runtime.session, "unfinishedActionCount", { get: () => 0 });
			const parentSession = parentState.runtime.session as unknown as {
				deleteInactiveRlmSubagent: ReturnType<typeof vi.fn>;
			};
			const deleteSpy = vi.fn(async (childId: string, isExternallyRunning: () => boolean) => {
				if (isExternallyRunning()) return "running" as const;
				await (
					fixture.daemon as unknown as {
						createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
					}
				)
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime(childId, childState.runtime.session);
				return "deleted" as const;
			});
			parentSession.deleteInactiveRlmSubagent = deleteSpy;
			const client = makeClient("client-1", parentState.activeSessionId);

			const busy = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean; reason?: string } };
			expect(busy.data).toEqual({ deleted: false, reason: "running" });
			expect(deleteSpy).not.toHaveBeenCalled();
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);

			isStreaming = false;
			const idle = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean } };
			expect(idle.data).toEqual({ deleted: true });
			expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("deletes a passive child without hydrating it and treats unknown children benignly", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-delete-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				deleteInactiveRlmSubagent: (childId: string) => Promise<"deleted" | "not_found">;
			};
			parentSession.deleteInactiveRlmSubagent = async (childId) => {
				if (childId !== fixture.childId) return "not_found";
				await (
					fixture.daemon as unknown as {
						createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
					}
				)
					.createSubagentRuntimeHost(parentState)
					.deleteRlmSubagentRuntime(childId);
				return "deleted";
			};
			const client = makeClient("client-1", parentState.activeSessionId);

			const unknown = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: "unknown-child",
			})) as { data: { deleted: boolean } };
			expect(unknown.data).toEqual({ deleted: false });

			const result = (await internals.handleCommand(client, {
				type: "delete_rlm_subagent",
				activeSessionId: parentState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean } };
			expect(result.data).toEqual({ deleted: true });
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			expect(existsSync(fixture.childSessionFile)).toBe(true);
			// The tombstone is durable in the child's display file ("deleted
			// deliberately, transcript retained") and in the ledger.
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				childId: string;
				status: string;
			};
			expect(display).toMatchObject({ childId: fixture.childId, status: "deleted" });
			const ledgerDir = join(tempDir, "rlm-ledger");
			const ledgerFile = readdirSync(ledgerDir).find((name) => name.endsWith(".jsonl"));
			if (!ledgerFile) throw new Error("Missing RLM ledger file");
			const ledgerOps = readFileSync(join(ledgerDir, ledgerFile), "utf8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line) as { op: string; childId?: string });
			expect(ledgerOps.at(-1)).toMatchObject({ op: "delete", childId: fixture.childId });

			// A retried delete of the now-tombstoned child still resolves the
			// session path and cancels its scheduled jobs.
			const cronStore = (fixture.daemon as unknown as { cronStore: AgentCronJobStore }).cronStore;
			const retryJob = cronStore.create({
				activeSessionId: "gone",
				sessionId: "gone",
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "left-behind heartbeat",
			});
			await (
				fixture.daemon as unknown as { createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost }
			)
				.createSubagentRuntimeHost(parentState)
				.deleteRlmSubagentRuntime(fixture.childId);
			expect(cronStore.list().find((candidate) => candidate.id === retryJob.id)?.status).toBe("cancelled");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes a deleted child's nested artifact dir but keeps its transcript and display tombstone", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-artifact-cleanup-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "payload");
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const host = internals.createSubagentRuntimeHost(parentState);
			await host.deleteRlmSubagentRuntime(fixture.childId);

			// Runtime cache gone; transcript + display tombstone (durable record) stay.
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
			// Depth-2 boundary: deleting a child never touches descendant transcripts.
			expect(existsSync(fixture.grandchildSessionFile)).toBe(true);
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				status: string;
			};
			expect(display).toMatchObject({ status: "deleted" });

			// Retry heal: a crash between the tombstone writes and the sweep (or a
			// pre-cleanup build) leaves the dir behind; a retried delete of the
			// tombstoned child sweeps it again.
			mkdirSync(fixture.childArtifactDir, { recursive: true });
			writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "leftover");
			await host.deleteRlmSubagentRuntime(fixture.childId);
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("resolves delete_subagent while the child's trace upload is still in flight, then the transcript upload completes", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-trace-outbox-"));
		const originalAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = tempDir;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const childManager = childState.runtime.session.sessionManager as SessionManager;
			const { calls, releaseFetch } = installGatedTraceUpload(childManager);
			childManager.appendMessage({ role: "user", content: "pending trace data", timestamp: 3 });
			childManager.flushNow();
			await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 5_000 });
			const transcriptAtUpload = readFileSync(fixture.childSessionFile, "utf8");

			// The fetch gate is still held: the delete must not await the upload.
			await internals
				.createSubagentRuntimeHost(parentState)
				.deleteRlmSubagentRuntime(fixture.childId, childState.runtime.session);
			expect(calls).toHaveLength(1);
			expect(childState.runtime.session.disposeAsync).toHaveBeenCalledWith({ kernelSnapshot: false });

			// The transcript survives deletion and its upload completes independently.
			releaseFetch();
			const entryKey = createHash("sha256").update(fixture.childSessionFile).digest("hex").slice(0, 32);
			await vi.waitFor(() => {
				const entry = JSON.parse(
					readFileSync(join(tempDir, "agent-traces-outbox", `${entryKey}.json`), "utf8"),
				) as { sessionFile: string; size?: number };
				expect(entry.size).toBeGreaterThan(0);
			});
			expect(calls[0]?.body).toBe(transcriptAtUpload);
		} finally {
			if (originalAgentDir === undefined) {
				delete process.env[ENV_AGENT_DIR];
			} else {
				process.env[ENV_AGENT_DIR] = originalAgentDir;
			}
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("reconciles a stale display status on a tombstoned ledger edge (idempotent delete)", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-reconcile-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const host = internals.createSubagentRuntimeHost(parentState);
			const displayPath = join(fixture.childSessionDir, "rlm-subagent.json");

			// First delete: write the deletion tombstone to the display and
			// append a delete record to the ledger.
			await host.deleteRlmSubagentRuntime(fixture.childId);
			expect(JSON.parse(readFileSync(displayPath, "utf8"))).toMatchObject({ status: "deleted" });

			// Simulate a stale overwrite by a completion write that raced
			// before the ledger tombstone was durable. The display now claims
			// the child is running again.
			writeFileSync(
				displayPath,
				`${JSON.stringify({
					type: "rlm_subagent",
					childId: fixture.childId,
					sessionName: "stale",
					sessionDir: fixture.childSessionDir,
					sessionFile: fixture.childSessionFile,
					status: "running",
					createdAt: 1,
					updatedAt: new Date().toISOString(),
				})}\n`,
			);

			// Retry the delete: the tombstoned-edge path must reconcile the
			// display back to "deleted" and sweep the artifact dir.
			await host.deleteRlmSubagentRuntime(fixture.childId);

			expect(JSON.parse(readFileSync(displayPath, "utf8"))).toMatchObject({ status: "deleted" });
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("sweeps the artifact dir even when child teardown throws", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-artifact-teardown-throw-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			// A dispose that flushes a fresh kernel snapshot (recreating the
			// artifact dir) and then fails.
			const throwingSession = {
				disposeAsync: vi.fn(async () => {
					mkdirSync(fixture.childArtifactDir, { recursive: true });
					writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "flushed");
					throw new Error("dispose failed");
				}),
			} as unknown as ActiveSessionState["runtime"]["session"];

			await expect(
				internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId, throwingSession),
			).rejects.toThrow("dispose failed");

			expect(throwingSession.disposeAsync).toHaveBeenCalledOnce();
			expect(existsSync(fixture.childArtifactDir)).toBe(false);
			expect(existsSync(fixture.childSessionFile)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels scheduled jobs when deleting a pre-ledger legacy child without hydrating it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-legacy-delete-jobs-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
				rlmSpawnLedger(): { appendDelete(input: unknown): Promise<void>; edges(all?: boolean): Promise<unknown[]> };
				cronStore: AgentCronJobStore;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			// Simulate a pre-ledger child the seed missed: only the legacy
			// registry knows it. Remove its seeded edge by deleting the ledger
			// files entirely and pointing the daemon at a fresh (empty) ledger.
			rmSync(join(tempDir, "rlm-ledger"), { recursive: true, force: true });
			(fixture.daemon as unknown as { rlmSpawnLedgerInstance?: unknown }).rlmSpawnLedgerInstance =
				new RlmSpawnLedger(tempDir, join(tempDir, "sessions"));
			const job = internals.cronStore.create({
				activeSessionId: "gone",
				sessionId: "gone",
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "legacy heartbeat",
			});

			await internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId);

			expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)?.status).toBe("cancelled");
			// The durable tombstone lands in the child's display file.
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				status: string;
			};
			expect(display).toMatchObject({ status: "deleted" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

/** Gated fetch stub on a session's trace-upload controller: observes whether a close awaits the upload. */
function installGatedTraceUpload(sessionManager: SessionManager): {
	calls: Array<{ url: string; body: string }>;
	releaseFetch: () => void;
} {
	const calls: Array<{ url: string; body: string }> = [];
	let releaseFetch: () => void = () => {};
	const gate = new Promise<void>((resolveGate) => {
		releaseFetch = resolveGate;
	});
	installAgentTraceUpload(sessionManager, {
		authStorage: AuthStorage.inMemory({
			[PRIME_AGENT_TRACES_PROVIDER_ID]: { type: "api_key", key: "trace-key" },
		}),
		settingsManager: SettingsManager.inMemory({ agentTraces: { enabled: true } }),
		baseUrl: "https://api.example.test",
		fetchFn: (async (input: unknown, init?: RequestInit) => {
			calls.push({ url: String(input), body: String(init?.body ?? "") });
			await gate;
			return new Response(JSON.stringify({ bytes_stored: 1 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as typeof fetch,
	});
	return { calls, releaseFetch };
}

function makePersistedRlmDaemonFixture(
	tempDir: string,
	options: {
		childRuntimeStarted?: () => void;
		childRuntimeGate?: Promise<void>;
		childBindingStarted?: () => void;
		childBindingGate?: Promise<void>;
		grandchildRuntimeStarted?: () => void;
		grandchildRuntimeGate?: Promise<void>;
		childDisposeStarted?: () => void;
		childDisposeGate?: Promise<void>;
		childAdmissionStarted?: () => void;
		childAdmissionGate?: Promise<void>;
	} = {},
) {
	const sessionDir = join(tempDir, "sessions");
	const parentManager = SessionManager.create(tempDir, sessionDir);
	parentManager.newSession();
	parentManager.appendSessionInfo("Parent");
	parentManager.appendSessionState({ status: "active" });
	const parentSessionFile = parentManager.getSessionFile();
	const parentArtifactDir = parentManager.getSessionArtifactDir();
	if (!parentSessionFile || !parentArtifactDir) {
		throw new Error("Missing parent session paths");
	}

	const childId = "child-1";
	const childSessionDir = join(parentArtifactDir, "sub-1234abcd");
	const childManager = SessionManager.create(tempDir, childSessionDir);
	childManager.newSession({ parentSession: parentSessionFile });
	childManager.appendSessionInfo("spawn-worker");
	childManager.appendSessionInfo("renamed-worker");
	childManager.appendMessage({ role: "user", content: "complete this task", timestamp: 1 });
	childManager.flushNow();
	const childSessionFile = childManager.getSessionFile();
	const childArtifactDir = childManager.getSessionArtifactDir();
	if (!childSessionFile || !childArtifactDir) {
		throw new Error("Missing child session paths");
	}
	const grandchildId = "grandchild-1";
	mkdirSync(childArtifactDir, { recursive: true });
	const grandchildSessionDir = join(childSessionDir, "sub-deadbeef");
	const grandchildManager = SessionManager.create(tempDir, grandchildSessionDir);
	grandchildManager.newSession({ parentSession: childSessionFile });
	grandchildManager.appendSessionInfo("nested-worker");
	grandchildManager.appendMessage({ role: "user", content: "complete the nested task", timestamp: 2 });
	grandchildManager.flushNow();
	const grandchildSessionFile = grandchildManager.getSessionFile();
	if (!grandchildSessionFile) throw new Error("Missing grandchild session file");
	writeFileSync(
		join(childArtifactDir, "rlm-subagents.jsonl"),
		`${JSON.stringify({
			type: "rlm_subagent",
			childId: grandchildId,
			sessionName: "nested-worker",
			sessionDir: grandchildSessionDir,
			sessionFile: grandchildSessionFile,
			parentSessionId: childManager.getSessionId(),
			parentSessionFile: childSessionFile,
			rlmDepth: 2,
			rlmMaxDepth: 4,
			rlmParentNodeId: grandchildId,
			status: "completed",
			createdAt: 2,
			updatedAt: "2026-01-01T00:00:01.000Z",
		})}
`,
	);
	writeFileSync(
		join(parentArtifactDir, "rlm-subagents.jsonl"),
		`${JSON.stringify({
			type: "rlm_subagent",
			childId,
			sessionName: "spawn-worker",
			sessionDir: childSessionDir,
			sessionFile: childSessionFile,
			parentSessionId: parentManager.getSessionId(),
			parentSessionFile,
			rlmDepth: 1,
			rlmMaxDepth: 4,
			rlmParentNodeId: childId,
			status: "completed",
			createdAt: 1,
			updatedAt: "2026-01-01T00:00:00.000Z",
		})}
`,
	);

	let admissionPending = false;
	const acceptAgentMessagePrompt = vi.fn(
		async (_message: string, promptOptions?: { preflightResult?: (didSucceed: boolean) => void }) => {
			admissionPending = true;
			try {
				if (options.childAdmissionGate) {
					options.childAdmissionStarted?.();
					await options.childAdmissionGate;
				}
				promptOptions?.preflightResult?.(true);
			} finally {
				admissionPending = false;
			}
		},
	);
	const runtimeSessions: Array<ReturnType<typeof makeRuntimeSession>> = [];
	const createRuntime = vi.fn(async (runtimeOptions: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
		const sessionFile = runtimeOptions.sessionManager.getSessionFile();
		const isChild = sessionFile === childSessionFile;
		const isGrandchild = sessionFile === grandchildSessionFile;
		if (isChild && options.childRuntimeGate) {
			options.childRuntimeStarted?.();
			await options.childRuntimeGate;
		}
		if (isGrandchild && options.grandchildRuntimeGate) {
			options.grandchildRuntimeStarted?.();
			await options.grandchildRuntimeGate;
		}
		const runtimeSession = makeRuntimeSession(runtimeOptions.sessionManager);
		runtimeSessions.push(runtimeSession);
		if (isChild && options.childBindingGate) {
			runtimeSession.bindExtensions = vi.fn(async () => {
				options.childBindingStarted?.();
				await options.childBindingGate;
			});
		}
		if (isChild && options.childDisposeGate) {
			runtimeSession.disposeAsync = vi.fn(async () => {
				options.childDisposeStarted?.();
				await options.childDisposeGate;
			});
		}
		Object.defineProperty(runtimeSession, "hasPendingAdmissionWaiters", {
			get: () => admissionPending,
		});
		Object.assign(runtimeSession, {
			isStreaming: false,
			isCompacting: false,
			isSessionActive: false,
			unfinishedActionCount: 0,
			state: { pendingToolCalls: new Set() },
			hasRunningRlmChildren: () => false,
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			acceptAgentMessagePrompt,
		});
		return {
			session: runtimeSession,
			extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
				ReturnType<CreateAgentSessionRuntimeFactory>
			>["extensionsResult"],
			services: { cwd: runtimeOptions.cwd, agentDir: runtimeOptions.agentDir } as Awaited<
				ReturnType<CreateAgentSessionRuntimeFactory>
			>["services"],
			diagnostics: [],
		};
	});
	const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
		defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
		createRuntime,
	});
	return {
		daemon,
		createRuntime,
		runtimeSessions,
		acceptAgentMessagePrompt,
		parentSessionFile,
		parentArtifactDir,
		parentSessionId: parentManager.getSessionId(),
		childId,
		childSessionFile,
		childSessionDir,
		childArtifactDir,
		grandchildId,
		grandchildSessionFile,
	};
}

function makeRuntimeSession(
	sessionManager: Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionManager"],
): Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"] {
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
		getRlmChildSnapshots: vi.fn(() => []),
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
		dispose: vi.fn(),
		disposeAsync: vi.fn(async () => {}),
		abort: vi.fn(async () => {}),
	} as unknown as Awaited<ReturnType<CreateAgentSessionRuntimeFactory>>["session"];
}

function makeAgentFamilyState(
	activeSessionId: string,
	sessionName: string,
	parent?: ActiveSessionState,
): { state: ActiveSessionState; acceptAgentMessagePrompt: ReturnType<typeof vi.fn> } {
	const state = makeState(activeSessionId, parent?.activeSessionId);
	const acceptAgentMessagePrompt = vi.fn(
		(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
			options?.preflightResult?.(true);
			return Promise.resolve();
		},
	);
	const parentSessionId = parent?.runtime.session.sessionId;
	state.runtime = {
		...state.runtime,
		cwd: "/tmp",
		diagnostics: [],
		metadata: {
			kind: parent ? "subagent" : "top-level",
			createdAt: 1,
			...(parent ? { parentActiveSessionId: parent.activeSessionId, parentSessionId } : {}),
		},
		session: {
			sessionId: `session-${activeSessionId}`,
			sessionName,
			runtimeKind: parent ? "subagent" : "top-level",
			rlmDepth: parent ? (parent.runtime.session.rlmDepth ?? 0) + 1 : 0,
			isStreaming: false,
			isCompacting: false,
			isBashRunning: false,
			isRetrying: false,
			isSessionActive: false,
			hasAcceptedPromptInFlight: false,
			unfinishedActionCount: 0,
			messages: [],
			state: { pendingToolCalls: new Set(), streamingMessage: undefined },
			sessionManager: {
				getCwd: () => "/tmp",
				getHeader: () => ({ created: new Date(0).toISOString() }),
			},
			hasRunningRlmChildren: () => false,
			getSessionActionSnapshot: () => ({ queuedCount: 0, steering: [], followUps: [] }),
			acceptAgentMessagePrompt,
		},
	} as never;
	return { state, acceptAgentMessagePrompt };
}

function makeState(activeSessionId: string, parentActiveSessionId?: string): ActiveSessionState {
	return {
		activeSessionId,
		clients: new Set(),
		pendingAttaches: 0,
		lastEventSequence: 0,
		runtime: {
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentActiveSessionId,
			},
		},
	} as unknown as ActiveSessionState;
}

function makeClient(id: string, activeSessionId: string, supportsExtensionUi = false): DaemonSocketClient {
	return {
		id,
		socket: { destroyed: false } as Socket,
		attachedActiveSessionIds: new Set([activeSessionId]),
		detachInput: vi.fn(),
		supportsExtensionUi,
		capabilities: new Set(supportsExtensionUi ? ["extension_ui"] : []),
	};
}

/**
 * Snapshot transfer coverage folded in from the ENG-4677 / ENG-4602 / ENG-4601 regression files:
 * catch-up drain gating and coalescing, snapshot generation replacement, and scoped snapshot
 * failures that must never drop a sibling session or its stream.
 */
describe("daemon snapshot transfers", () => {
	const snapshotSessionId = "active-snapshot";
	const siblingSessionId = "active-snapshot-sibling";
	const snapshotRoots: string[] = [];

	interface SnapshotWorkerHarness {
		descriptor: { workerId: string; rootActiveSessionId: string; lifecycle: "ready"; pid: number };
		client?: { close: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn> };
		summaries: Map<string, SessionSummary>;
		snapshotCache: Map<string, DaemonAttachResult>;
		transcriptCaches: Map<string, SnapshotTranscriptCache>;
		snapshotGenerations: Map<string, Map<string, unknown>>;
		snapshotLoads: Map<string, Promise<DaemonAttachResult>>;
		intentionalStop: boolean;
		stopRevision: number;
	}

	type CatchupDrain = (client: DaemonSocketClient) => Promise<void>;

	afterEach(() => {
		for (const root of snapshotRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function snapshotRoot(): string {
		const directory = mkdtempSync(join(tmpdir(), "daemon-snapshot-"));
		snapshotRoots.push(directory);
		return directory;
	}

	function snapshotSummary(activeSessionId: string, messageCount: number): SessionSummary {
		return {
			id: activeSessionId,
			activeSessionId,
			lifecycle: "live",
			activity: "idle",
			isSessionActive: false,
			sessionId: `session-${activeSessionId}`,
			cwd: "/tmp",
			isStreaming: false,
			isCompacting: false,
			attachedClients: 0,
			messageCount,
			sessionActions: { queuedCount: 0, steering: [], followUps: [] },
		};
	}

	function snapshotResult(
		snapshotId: string,
		messageCount: number,
		lastEventSequence: number,
		activeSessionId = snapshotSessionId,
	): DaemonAttachResult {
		return {
			protocol: DAEMON_PROTOCOL_INFO,
			activeSessionId,
			snapshot: {
				activeSessionId,
				summary: snapshotSummary(activeSessionId, messageCount),
				state: {
					activeSessionId,
					sessionId: `session-${activeSessionId}`,
				} as DaemonAttachResult["snapshot"]["state"],
				messages: [],
				lastEventSequence,
			},
			replay: { status: "complete", toSequence: lastEventSequence },
			lastEventSequence,
			snapshotStream: { id: snapshotId, messageCount, targetChunkBytes: 1 },
			client: { id: "supervisor", capabilities: ["chunked_snapshot"] },
		};
	}

	function snapshotWorker(result: DaemonAttachResult, transcript?: SnapshotTranscriptCache): SnapshotWorkerHarness {
		const close = vi.fn();
		const request = vi.fn(async () => {
			throw new Error("unexpected snapshot reload");
		});
		return {
			descriptor: {
				workerId: "worker-snapshot",
				rootActiveSessionId: snapshotSessionId,
				lifecycle: "ready",
				pid: 4677,
			},
			client: { close, request },
			summaries: new Map([[snapshotSessionId, result.snapshot.summary]]),
			snapshotCache: transcript ? new Map([[snapshotSessionId, result]]) : new Map(),
			transcriptCaches: transcript ? new Map([[snapshotSessionId, transcript]]) : new Map(),
			snapshotGenerations: new Map(),
			snapshotLoads: new Map(),
			intentionalStop: false,
			stopRevision: 0,
		};
	}

	function snapshotFrame(
		message: DaemonOutbound,
		purpose: "attach" | "replacement" | "catchup" = "replacement",
	): PrivateFrame<DaemonWorkerFrameHeader> {
		return {
			header: {
				kind: "outbound",
				outboundType: message.type,
				...("activeSessionId" in message ? { activeSessionId: message.activeSessionId } : {}),
				...("snapshotId" in message && typeof message.snapshotId === "string"
					? { snapshotId: message.snapshotId }
					: {}),
				payloadEncoding: "jsonl",
				snapshotPurpose: purpose,
			},
			payload: Buffer.from(JSON.stringify(message)),
		};
	}

	function snapshotClient(id: string): { client: DaemonSocketClient; socket: PassThrough } {
		const socket = new PassThrough();
		socket.on("error", () => {});
		return {
			socket,
			client: {
				id,
				socket: socket as unknown as Socket,
				transport: "private-framed",
				attachedActiveSessionIds: new Set([snapshotSessionId]),
				catchupActiveSessionIds: new Set<string>(),
				detachInput: () => {},
				supportsExtensionUi: false,
				capabilities: new Set(["chunked_snapshot"]),
			} as DaemonSocketClient,
		};
	}

	function makeSupervisor(root: string): DaemonSupervisor {
		return new DaemonSupervisor(join(root, "supervisor.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			descriptorDir: join(root, "state"),
		});
	}

	function makeWorkerDaemon(root: string): AgentDaemon {
		return new AgentDaemon(join(root, "worker.sock"), {
			defaultSessionConfig: { agentDir: root, cwd: root },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
	}

	/** Both catch-up channels (supervisor -> public client, worker -> supervisor link) share one contract. */
	function catchupChannel(channel: "supervisor" | "worker", root: string, drain: CatchupDrain) {
		if (channel === "supervisor") {
			const internals = makeSupervisor(root) as unknown as {
				drainClientCatchups: CatchupDrain;
				queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose?: "replacement" | "resync"): void;
				catchUpClient(client: DaemonSocketClient): Promise<void>;
			};
			internals.drainClientCatchups = drain;
			return {
				queue: (client: DaemonSocketClient, purpose?: "replacement" | "resync") =>
					internals.queueCatchup(client, snapshotSessionId, purpose),
				catchUp: (client: DaemonSocketClient) => internals.catchUpClient(client),
			};
		}
		const internals = makeWorkerDaemon(root) as unknown as {
			drainBackpressuredClientCatchups: CatchupDrain;
			queueClientCatchup(
				client: DaemonSocketClient,
				activeSessionId: string,
				purpose?: "replacement" | "resync",
			): void;
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.drainBackpressuredClientCatchups = drain;
		return {
			queue: (client: DaemonSocketClient, purpose?: "replacement" | "resync") =>
				internals.queueClientCatchup(client, snapshotSessionId, purpose),
			catchUp: (client: DaemonSocketClient) => internals.catchUpBackpressuredClient(client),
		};
	}

	it.each(["supervisor", "worker"] as const)(
		"ENG-4677: waits for the %s socket to drain before continuing catch-up",
		async (channel) => {
			const drain = vi.fn(async (target: DaemonSocketClient) => {
				target.catchupActiveSessionIds?.clear();
			});
			const { client, socket } = snapshotClient(`${channel}-backpressure`);
			client.backpressured = true;
			const { queue, catchUp } = catchupChannel(channel, snapshotRoot(), drain);
			queue(client);

			await catchUp(client);
			expect(drain).not.toHaveBeenCalled();
			expect(client.catchupActiveSessionIds).toContain(snapshotSessionId);

			client.backpressured = false;
			await catchUp(client);
			expect(drain).toHaveBeenCalledOnce();
			socket.destroy();
		},
	);

	it.each(["supervisor", "worker"] as const)(
		"ENG-4677: coalesces concurrent %s catch-up triggers into one drain",
		async (channel) => {
			let releaseFirstDrain!: () => void;
			const firstDrainBlocked = new Promise<void>((resolve) => {
				releaseFirstDrain = resolve;
			});
			let markSecondDrainStarted!: () => void;
			const secondDrainStarted = new Promise<void>((resolve) => {
				markSecondDrainStarted = resolve;
			});
			const drain = vi.fn(async (target: DaemonSocketClient) => {
				target.catchupActiveSessionIds?.clear();
				target.catchupPurposes?.clear();
				if (drain.mock.calls.length === 1) {
					await firstDrainBlocked;
				} else {
					markSecondDrainStarted();
				}
			});
			const { client, socket } = snapshotClient(`${channel}-coalesced`);
			const { queue, catchUp } = catchupChannel(channel, snapshotRoot(), drain);
			queue(client);

			const first = catchUp(client);
			expect(catchUp(client)).toBe(first);
			expect(drain).toHaveBeenCalledOnce();

			// A trigger that lands while the first drain is in flight must run exactly one follow-up drain.
			queue(client, "replacement");
			releaseFirstDrain();
			await Promise.all([first, secondDrainStarted]);

			expect(drain).toHaveBeenCalledTimes(2);
			expect(client.catchupActiveSessionIds?.size).toBe(0);
			socket.destroy();
		},
	);

	it("ENG-4677: lets a retained snapshot finish while a newer generation becomes current", async () => {
		const root = snapshotRoot();
		const supervisor = makeSupervisor(root);
		const firstSnapshotId = "snapshot-generation-a";
		const replacementSnapshotId = "snapshot-generation-b";
		const firstMessages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
		];
		const firstResult = snapshotResult(firstSnapshotId, firstMessages.length, 1);
		const firstTranscript = new SnapshotTranscriptCache({
			activeSessionId: snapshotSessionId,
			snapshotId: firstSnapshotId,
			messages: firstMessages,
			cacheRoot: root,
			targetChunkBytes: 1,
		});
		const worker = snapshotWorker(firstResult, firstTranscript);
		const { client, socket } = snapshotClient("slow-client");
		const written: DaemonOutbound[] = [];
		let releaseFirstChunk!: (accepted: boolean) => void;
		const firstChunkBlocked = new Promise<boolean>((resolve) => {
			releaseFirstChunk = resolve;
		});
		let firstChunkStarted!: () => void;
		const firstChunkReached = new Promise<void>((resolve) => {
			firstChunkStarted = resolve;
		});
		const writeSnapshotBuffer = vi.fn((_client: DaemonSocketClient, buffer: Uint8Array) => {
			const message = JSON.parse(Buffer.from(buffer).toString("utf8")) as DaemonOutbound;
			written.push(message);
			if (
				message.type === "session_snapshot_chunk" &&
				message.snapshotId === firstSnapshotId &&
				message.index === 0
			) {
				firstChunkStarted();
				return firstChunkBlocked;
			}
			return Promise.resolve(true);
		});
		const internals = supervisor as unknown as {
			clients: Set<DaemonSocketClient>;
			workers: Map<string, SnapshotWorkerHarness>;
			writeSnapshotBuffer: typeof writeSnapshotBuffer;
			syncWorkerExtensionUi: ReturnType<typeof vi.fn>;
			streamSnapshot(
				client: DaemonSocketClient,
				worker: SnapshotWorkerHarness,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptCache,
				purpose: "attach" | "replacement" | "resync",
			): Promise<void>;
			handleWorkerFrame(worker: SnapshotWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
			queueCatchup(client: DaemonSocketClient, activeSessionId: string, purpose: "replacement" | "resync"): void;
			catchUpClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.writeSnapshotBuffer = writeSnapshotBuffer;
		internals.syncWorkerExtensionUi = vi.fn(async () => {});

		const firstStream = internals.streamSnapshot(client, worker, firstResult, firstTranscript, "attach");
		await firstChunkReached;

		const { messages: _messages, ...replacementSnapshot } = snapshotResult(replacementSnapshotId, 1, 2).snapshot;
		for (const message of [
			{
				type: "session_snapshot_begin",
				activeSessionId: snapshotSessionId,
				snapshotId: replacementSnapshotId,
				snapshot: replacementSnapshot,
				messageCount: 1,
				targetChunkBytes: 1,
			},
			// A chunk from the retired generation must not land in the current transcript.
			{
				type: "session_snapshot_chunk",
				activeSessionId: snapshotSessionId,
				snapshotId: firstSnapshotId,
				index: 2,
				messages: [{ role: "user", content: "stale", timestamp: 3 }],
			},
			{
				type: "session_snapshot_chunk",
				activeSessionId: snapshotSessionId,
				snapshotId: replacementSnapshotId,
				index: 0,
				messages: [{ role: "user", content: "replacement", timestamp: 4 }],
			},
			{
				type: "session_snapshot_end",
				activeSessionId: snapshotSessionId,
				snapshotId: replacementSnapshotId,
				chunkCount: 1,
				lastEventSequence: 2,
			},
		] satisfies DaemonOutbound[]) {
			internals.handleWorkerFrame(worker, snapshotFrame(message));
		}

		expect(worker.transcriptCaches.get(snapshotSessionId)).toMatchObject({
			snapshotId: replacementSnapshotId,
			chunkCount: 1,
			complete: true,
		});

		releaseFirstChunk(true);
		await firstStream;

		expect(written.filter((message) => message.type === "session_snapshot_failed")).toHaveLength(0);
		expect(
			written.filter(
				(message) => message.type === "session_snapshot_chunk" && message.snapshotId === firstSnapshotId,
			),
		).toHaveLength(2);

		internals.clients.add(client);
		internals.workers.set(worker.descriptor.workerId, worker);
		seedSupervisorRoster(supervisor, worker);
		internals.queueCatchup(client, snapshotSessionId, "replacement");
		await internals.catchUpClient(client);

		expect(
			written.some(
				(message) =>
					message.type === "session_snapshot_begin" &&
					message.snapshotId === replacementSnapshotId &&
					message.purpose === "replacement",
			),
		).toBe(true);
		expect(worker.transcriptCaches.get(snapshotSessionId)?.snapshotId).toBe(replacementSnapshotId);
		socket.destroy();
	});

	it("ENG-4677: does not let a stale attach response replace a newer completed generation", async () => {
		const root = snapshotRoot();
		const supervisor = makeSupervisor(root);
		const firstSnapshotId = "snapshot-stale-a";
		const replacementSnapshotId = "snapshot-stale-b";
		const firstResult = snapshotResult(firstSnapshotId, 1, 1);
		const worker = snapshotWorker(firstResult);
		let resolveAttach!: (response: { success: true; data: DaemonAttachResult }) => void;
		let markAttachRequested!: () => void;
		const attachRequested = new Promise<void>((resolve) => {
			markAttachRequested = resolve;
		});
		worker.client = {
			close: vi.fn(),
			request: vi.fn(
				() =>
					new Promise<{ success: true; data: DaemonAttachResult }>((resolve) => {
						resolveAttach = resolve;
						markAttachRequested();
					}),
			),
		};
		const { client, socket } = snapshotClient("stale-attach");
		const internals = supervisor as unknown as {
			workers: Map<string, SnapshotWorkerHarness>;
			attachClient(
				client: DaemonSocketClient,
				command: { type: "attach"; activeSessionId: string; capabilities: ["chunked_snapshot"] },
			): Promise<{
				result: DaemonAttachResult;
				transcript?: SnapshotTranscriptCache;
				releaseTranscript?: () => void;
			}>;
			handleWorkerFrame(worker: SnapshotWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};
		internals.workers.set(worker.descriptor.workerId, worker);
		seedSupervisorRoster(supervisor, worker);
		const attaching = internals.attachClient(client, {
			type: "attach",
			activeSessionId: snapshotSessionId,
			capabilities: ["chunked_snapshot"],
		});
		await attachRequested;

		for (const result of [firstResult, snapshotResult(replacementSnapshotId, 1, 2)]) {
			const { messages: _messages, ...snapshot } = result.snapshot;
			const snapshotId = result.snapshotStream!.id;
			for (const message of [
				{
					type: "session_snapshot_begin",
					activeSessionId: snapshotSessionId,
					snapshotId,
					snapshot,
					messageCount: 1,
					targetChunkBytes: 1,
				},
				{
					type: "session_snapshot_chunk",
					activeSessionId: snapshotSessionId,
					snapshotId,
					index: 0,
					messages: [{ role: "user", content: snapshotId, timestamp: result.lastEventSequence }],
				},
				{
					type: "session_snapshot_end",
					activeSessionId: snapshotSessionId,
					snapshotId,
					chunkCount: 1,
					lastEventSequence: result.lastEventSequence,
				},
			] satisfies DaemonOutbound[]) {
				internals.handleWorkerFrame(worker, snapshotFrame(message));
			}
		}
		resolveAttach({ success: true, data: firstResult });

		const attached = await attaching;
		expect(attached.result.snapshotStream?.id).toBe(replacementSnapshotId);
		expect(attached.transcript).toMatchObject({ snapshotId: replacementSnapshotId, complete: true });
		expect(worker.transcriptCaches.get(snapshotSessionId)?.snapshotId).toBe(replacementSnapshotId);
		attached.releaseTranscript?.();
		socket.destroy();
	});

	/** A snapshot that fails mid-transfer is scoped to its own session on both transfer channels. */
	it.each(["worker channel", "public client"] as const)(
		"ENG-4602: fails one snapshot on the %s without dropping another session",
		async (channel) => {
			const root = snapshotRoot();
			const snapshotId = "snapshot-scoped-failure";
			const result = snapshotResult(snapshotId, 1, 1);
			const transcript = new SnapshotTranscriptCache({
				activeSessionId: snapshotSessionId,
				snapshotId,
				messages: [{ role: "user", content: "message", timestamp: 1 }],
				cacheRoot: root,
			});
			const streamError = new Error("chunk read failed");
			transcript.readChunk = vi.fn(() => {
				throw streamError;
			});
			const markFailed = vi.spyOn(transcript, "markFailed");
			const dispose = vi.spyOn(transcript, "dispose");
			const { client, socket } = snapshotClient("scoped-failure");
			client.attachedActiveSessionIds.add(siblingSessionId);
			const written: Buffer[] = [];
			socket.on("data", (chunk: Buffer) => written.push(Buffer.from(chunk)));
			const worker = snapshotWorker(result, transcript);

			let stream: Promise<void>;
			let decode: () => DaemonOutbound[];
			if (channel === "worker channel") {
				const internals = makeWorkerDaemon(root) as unknown as {
					streamWorkerSnapshot(
						client: DaemonSocketClient,
						result: DaemonAttachResult,
						transcript: SnapshotTranscriptCache,
					): Promise<void>;
				};
				stream = internals.streamWorkerSnapshot(client, result, transcript);
				decode = () =>
					new PrivateFrameDecoder(isDaemonWorkerFrameHeader)
						.push(Buffer.concat(written))
						.map((frame) => JSON.parse(frame.payload.toString("utf8")) as DaemonOutbound);
			} else {
				const supervisor = makeSupervisor(root);
				const internals = supervisor as unknown as {
					clients: Set<DaemonSocketClient>;
					streamSnapshot(
						client: DaemonSocketClient,
						worker: SnapshotWorkerHarness,
						result: DaemonAttachResult,
						transcript: SnapshotTranscriptCache,
					): Promise<void>;
				};
				const sibling = snapshotClient("sibling");
				internals.clients.add(client);
				internals.clients.add(sibling.client);
				stream = internals.streamSnapshot(client, worker, result, transcript);
				decode = () =>
					Buffer.concat(written)
						.toString("utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as DaemonOutbound);
			}

			await expect(stream).rejects.toBe(streamError);

			const records = decode();
			expect(records.map((record) => record.type)).toEqual(["session_snapshot_begin", "session_snapshot_failed"]);
			expect(records[1]).toMatchObject({
				type: "session_snapshot_failed",
				activeSessionId: snapshotSessionId,
				snapshotId,
				error: streamError.message,
			});
			expect(socket.destroyed).toBe(false);
			expect(client.attachedActiveSessionIds).toContain(siblingSessionId);
			expect(client.snapshotStreaming).toBe(false);
			expect(transcript.complete).toBe(false);
			expect(markFailed.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]!);
			if (channel === "public client") {
				expect(worker.client).toBeDefined();
				expect(worker.client!.close).not.toHaveBeenCalled();
			}
			socket.destroy();
		},
	);

	it("ENG-4602: keeps a multi-session worker connected after a scoped snapshot failure frame", () => {
		const root = snapshotRoot();
		const supervisor = makeSupervisor(root);
		const snapshotId = "snapshot-failure-frame";
		const transcript = new SnapshotTranscriptCache({
			activeSessionId: snapshotSessionId,
			snapshotId,
			cacheRoot: root,
		});
		const worker = snapshotWorker(snapshotResult(snapshotId, 1, 1), transcript);
		worker.summaries.set(siblingSessionId, snapshotSummary(siblingSessionId, 1));
		const internals = supervisor as unknown as {
			handleWorkerFrame(worker: SnapshotWorkerHarness, frame: PrivateFrame<DaemonWorkerFrameHeader>): void;
		};

		internals.handleWorkerFrame(
			worker,
			snapshotFrame({
				type: "session_snapshot_failed",
				activeSessionId: snapshotSessionId,
				snapshotId,
				error: "snapshot encoder failed",
			}),
		);

		expect(worker.client?.close).not.toHaveBeenCalled();
		expect(worker.descriptor.lifecycle).toBe("ready");
		expect(worker.summaries.has(siblingSessionId)).toBe(true);
		expect(worker.snapshotCache.has(snapshotSessionId)).toBe(false);
		expect(worker.transcriptCaches.has(snapshotSessionId)).toBe(false);
		expect(worker.snapshotGenerations.has(snapshotSessionId)).toBe(false);
	});

	it("ENG-4601: preserves legacy JSONL bytes from a stable message-array snapshot", () => {
		const transcript: AgentMessage[] = [{ role: "user", content: 'line1\n"quoted"\\tail', timestamp: 1 }];
		const chunks = createSnapshotTranscriptChunks({
			activeSessionId: 'active-"\\',
			snapshotId: "snapshot-\n",
			messages: transcript,
		});
		transcript.push({ role: "user", content: "late", timestamp: 2 });

		expect([...chunks].map((chunk) => chunk.toString("utf8"))).toEqual([
			'{"type":"session_snapshot_chunk","activeSessionId":"active-\\"\\\\","snapshotId":"snapshot-\\n","index":0,"messages":[{"role":"user","content":"line1\\n\\"quoted\\"\\\\tail","timestamp":1}]}\n',
		]);
		expect([
			...createSnapshotTranscriptChunks({
				activeSessionId: snapshotSessionId,
				snapshotId: "snapshot-empty",
				messages: [],
			}),
		]).toEqual([]);
	});

	it("ENG-4601: terminates an aborted worker snapshot without interrupting a sibling stream", async () => {
		const root = snapshotRoot();
		const snapshotId = "snapshot-aborted";
		const siblingSnapshotId = "snapshot-aborted-sibling";
		const { client, socket } = snapshotClient("worker-detach");
		client.attachedActiveSessionIds.add(siblingSessionId);
		const state = {
			activeSessionId: snapshotSessionId,
			clients: new Set([client]),
			extensionUiRequests: new Map(),
			runtime: { metadata: { kind: "subagent" } },
		} as unknown as ActiveSessionState;
		const written: DaemonOutbound[] = [];
		const produced: number[] = [];
		const signal = markClientSnapshotStreaming(client, snapshotSessionId);
		const siblingSignal = markClientSnapshotStreaming(client, siblingSessionId);
		const messages: AgentMessage[] = [
			{ role: "user", content: "first", timestamp: 1 },
			{ role: "user", content: "second", timestamp: 2 },
		];
		const encoded = createSnapshotTranscriptChunks({
			activeSessionId: snapshotSessionId,
			snapshotId,
			messages,
			targetChunkBytes: 1,
			signal,
		});
		const transcript: SnapshotTranscriptChunkSource = {
			*[Symbol.iterator]() {
				let index = 0;
				for (const chunk of encoded) {
					produced.push(index++);
					yield chunk;
				}
			},
		};
		const internals = makeWorkerDaemon(root) as unknown as {
			writeSerialized(client: DaemonSocketClient, buffer: string | Buffer, message?: DaemonOutbound): boolean;
			streamWorkerSnapshot(
				client: DaemonSocketClient,
				result: DaemonAttachResult,
				transcript: SnapshotTranscriptChunkSource,
				purpose: "attach",
				signal: AbortSignal,
				snapshotAlreadyMarked: boolean,
			): Promise<void>;
			detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
		};
		// Only the aborted session's writes stay backpressured; the sibling stream keeps draining.
		internals.writeSerialized = (_client, _buffer, message) => {
			if (message) written.push(message);
			return message?.type !== "session_snapshot_chunk" || message.activeSessionId === siblingSessionId;
		};
		const drainWaitStarted = new Promise<void>((resolve) => {
			const onNewListener = (event: string | symbol) => {
				if (event !== "drain") return;
				socket.off("newListener", onNewListener);
				resolve();
			};
			socket.on("newListener", onNewListener);
		});

		const stream = internals.streamWorkerSnapshot(
			client,
			snapshotResult(snapshotId, 2, 1),
			transcript,
			"attach",
			signal,
			true,
		);
		const siblingStream = internals.streamWorkerSnapshot(
			client,
			snapshotResult(siblingSnapshotId, 2, 1, siblingSessionId),
			createSnapshotTranscriptChunks({
				activeSessionId: siblingSessionId,
				snapshotId: siblingSnapshotId,
				messages,
				targetChunkBytes: 1,
				signal: siblingSignal,
			}),
			"attach",
			siblingSignal,
			true,
		);
		await drainWaitStarted;
		expect(socket.listenerCount("drain")).toBeGreaterThan(0);
		expect(produced).toEqual([0]);

		internals.detachClientFromSession(client, state);
		await Promise.all([stream, siblingStream]);

		expect(produced).toEqual([0]);
		expect(
			written.some(
				(message) => message.type === "session_snapshot_end" && message.activeSessionId === snapshotSessionId,
			),
		).toBe(false);
		expect(written).toContainEqual({
			type: "session_snapshot_failed",
			activeSessionId: snapshotSessionId,
			snapshotId,
			error: `Snapshot ${snapshotId} was aborted`,
		});
		expect(written).toContainEqual(
			expect.objectContaining({
				type: "session_snapshot_end",
				activeSessionId: siblingSessionId,
				snapshotId: siblingSnapshotId,
			}),
		);
		expect(state.clients.has(client)).toBe(false);
		expect(client.attachedActiveSessionIds.has(snapshotSessionId)).toBe(false);
		expect(client.attachedActiveSessionIds.has(siblingSessionId)).toBe(true);
		expect(client.snapshotStreaming).toBe(false);
		expect(client.snapshotActiveSessionIds?.size).toBe(0);
		expect(client.snapshotTransferAbortControllers?.size).toBe(0);
		expect(socket.listenerCount("drain")).toBe(0);
		expect(socket.destroyed).toBe(false);
		socket.destroy();
	});
});
