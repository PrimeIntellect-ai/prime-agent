import { EventEmitter } from "node:events";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	AGENT_FAMILY_REACH_ERROR,
	type AgentSessionMessageController,
	createAgentMessageHostHandlers,
	DEFAULT_AGENT_MESSAGE_MAX_CHARS,
	sessionNameReservationKey,
} from "../src/core/agent-messages.js";
import type { AgentObserveController } from "../src/core/agent-observe.js";
import type { CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import type { AgentCronJob, AgentCronJobStore } from "../src/core/cron-jobs.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createDefaultRlmSubagentSessionName,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import { canonicalSessionPath } from "../src/core/session-lease.js";
import { readSessionInfo, type SessionInfo, SessionManager } from "../src/core/session-manager.js";
import type { ActiveSessionState, DaemonSocketClient } from "../src/modes/daemon/active-session-state.js";
import {
	AgentDaemon,
	cancelPendingExtensionUiRequests,
	detachClientFromActiveSession,
	finishClientSnapshotStreaming,
	getChildActiveSessionStates,
	markClientSnapshotStreaming,
	setDaemonClientSessionCapabilities,
	shouldSendDaemonOutboundToClient,
} from "../src/modes/daemon/daemon-mode.js";
import {
	createDaemonCommandEnvelope,
	DAEMON_PROTOCOL_INFO,
	DAEMON_SCHEMA_ID,
	DAEMON_SCHEMA_REVISION,
	type DaemonAttachResult,
	type DaemonCommand,
	type DaemonOutbound,
	failure,
} from "../src/modes/daemon/daemon-protocol.js";
import type { SessionSummary } from "../src/modes/daemon/daemon-session-list.js";
import { DAEMON_WORKER_SUPERVISOR_SOCKET_ENV } from "../src/modes/daemon/daemon-worker-protocol.js";
import { RlmSpawnLedger } from "../src/modes/daemon/rlm-ledger.js";

describe("daemon mode helpers", () => {
	it("preserves envelope client identity while registering prompt admission", () => {
		const daemon = new AgentDaemon("/tmp/unused-daemon.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const client = makeClient("worker-socket", "active");
		const parse = Reflect.get(daemon, "parseCommandAndRegisterPromptAdmission").bind(daemon);

		parse(client, JSON.stringify(createDaemonCommandEnvelope({ type: "list" }, "request-1", "public-client")));
		expect(client.id).toBe("public-client");
	});

	it("waits for overlapping Bash commands with a bounded close deadline", async () => {
		vi.useFakeTimers();
		try {
			const daemon = new AgentDaemon("/tmp/unused-daemon.sock", {
				defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
				createRuntime: vi.fn(),
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
				abortBashForClose(state: ActiveSessionState): Promise<void>;
			};

			let resolveFirstBash!: () => void;
			let resolveSecondBash!: () => void;
			const firstBash = new Promise<void>((resolve) => {
				resolveFirstBash = resolve;
			});
			const secondBash = new Promise<void>((resolve) => {
				resolveSecondBash = resolve;
			});
			let isBashRunning = false;
			const abortBash = vi.fn();
			const state = makeState("active");
			state.runtime = {
				...state.runtime,
				session: {
					get isBashRunning() {
						return isBashRunning;
					},
					runUserBash: vi.fn(() => {
						isBashRunning = true;
						return firstBash;
					}),
					executeBash: vi.fn(() => secondBash),
					abortBash,
				},
			} as never;
			internals.sessions.set(state.activeSessionId, state);
			const client = makeClient("client", state.activeSessionId);

			await internals.handleCommand(client, {
				id: "first",
				type: "execute_bash",
				activeSessionId: state.activeSessionId,
				command: "first",
			});
			const secondResponse = internals.handleCommand(client, {
				id: "second",
				type: "execute_bash_and_wait",
				activeSessionId: state.activeSessionId,
				command: "second",
			});
			resolveSecondBash();
			await secondResponse;

			const closing = internals.abortBashForClose(state);
			expect(await Promise.race([closing.then(() => "done"), Promise.resolve("pending")])).toBe("pending");
			resolveFirstBash();
			await expect(closing).resolves.toBeUndefined();
			expect(abortBash).toHaveBeenCalledOnce();

			let isStalledBashRunning = false;
			const abortStalledBash = vi.fn();
			const stalledState = makeState("stalled");
			stalledState.runtime = {
				...stalledState.runtime,
				session: {
					get isBashRunning() {
						return isStalledBashRunning;
					},
					runUserBash: vi.fn(() => {
						isStalledBashRunning = true;
						return new Promise<void>(() => {});
					}),
					abortBash: abortStalledBash,
				},
			} as never;
			internals.sessions.set(stalledState.activeSessionId, stalledState);
			await internals.handleCommand(makeClient("stalled-client", stalledState.activeSessionId), {
				id: "stalled",
				type: "execute_bash",
				activeSessionId: stalledState.activeSessionId,
				command: "stalled",
			});

			const stalledClose = internals.abortBashForClose(stalledState);
			await vi.advanceTimersByTimeAsync(4999);
			expect(await Promise.race([stalledClose.then(() => "done"), Promise.resolve("pending")])).toBe("pending");
			await vi.advanceTimersByTimeAsync(1);
			await expect(stalledClose).resolves.toBeUndefined();
			expect(abortStalledBash).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

	it("normalizes daemon session names before validation and persistence", async () => {
		const daemon = new AgentDaemon("/tmp/unused-daemon.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const setSessionName = vi.fn();
		const state = makeState("active");
		state.runtime = {
			...state.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: { setSessionName },
		} as never;
		const assertStateSessionNameAvailable = vi.fn(async () => {});
		const internals = daemon as unknown as {
			assertStateSessionNameAvailable: typeof assertStateSessionNameAvailable;
			setStateSessionName(state: ActiveSessionState, name: string): Promise<void>;
		};
		internals.assertStateSessionNameAvailable = assertStateSessionNameAvailable;

		await internals.setStateSessionName(state, "  normalized  ");

		expect(assertStateSessionNameAvailable).toHaveBeenCalledWith(state, "normalized");
		expect(setSessionName).toHaveBeenCalledWith("normalized");
		await expect(internals.setStateSessionName(state, "   ")).rejects.toThrow("Session name cannot be empty");
		expect(setSessionName).toHaveBeenCalledOnce();
	});

	it("uses a supervisor-approved worker session name without validating it again", async () => {
		const daemon = new AgentDaemon("/tmp/unused-worker.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
			worker: { authenticationToken: "token" },
		});
		const setSessionName = vi.fn();
		const state = makeState("active");
		state.runtime = {
			...state.runtime,
			session: { setSessionName },
		} as never;
		const assertStateSessionNameAvailable = vi.fn(async () => {
			throw new Error("stale peer name");
		});
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			assertStateSessionNameAvailable: typeof assertStateSessionNameAvailable;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.assertStateSessionNameAvailable = assertStateSessionNameAvailable;

		await expect(
			internals.handleCommand(makeClient("supervisor", state.activeSessionId), {
				type: "set_session_name",
				activeSessionId: state.activeSessionId,
				name: "approved",
			}),
		).resolves.toMatchObject({ success: true });
		expect(assertStateSessionNameAvailable).not.toHaveBeenCalled();
		expect(setSessionName).toHaveBeenCalledWith("approved");
	});

	it("treats a depth-zero fork as a sibling of another root", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-fork-family.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const fork = makeState("fork");
		fork.runtime = {
			...fork.runtime,
			metadata: {
				kind: "top-level",
				createdAt: 1,
				parentSessionId: "fork-origin",
				parentSessionFile: "/tmp/fork-origin.jsonl",
			},
			session: {
				sessionId: "session-fork",
				sessionFile: "/tmp/fork.jsonl",
				rlmDepth: 0,
				sessionManager: { getHeader: () => ({ parentSession: "/tmp/fork-origin.jsonl" }) },
			},
		} as never;
		const root = makeState("root");
		root.runtime = {
			...root.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: "session-root",
				sessionFile: "/tmp/root.jsonl",
				rlmDepth: 0,
			},
		} as never;
		const internals = daemon as unknown as {
			agentFamilyEntry(state: ActiveSessionState): {
				parentSessionId?: string;
				parentSessionPath?: string;
			};
			isAgentFamilyReachable(current: ActiveSessionState, target: ActiveSessionState): boolean;
		};

		expect(internals.agentFamilyEntry(fork)).not.toHaveProperty("parentSessionId");
		expect(internals.agentFamilyEntry(fork)).not.toHaveProperty("parentSessionPath");
		expect(internals.isAgentFamilyReachable(root, fork)).toBe(true);
		expect(internals.isAgentFamilyReachable(fork, root)).toBe(true);
	});

	it("finds only direct child active sessions", () => {
		const parent = makeState("parent");
		const child = makeState("child", "parent");
		const grandchild = makeState("grandchild", "child");
		const sibling = makeState("sibling");
		const selfLinked = makeState("self-linked", "self-linked");
		const sessions = new Map<string, ActiveSessionState>(
			[parent, child, grandchild, sibling, selfLinked].map((state) => [state.activeSessionId, state]),
		);

		expect(getChildActiveSessionStates(sessions, parent).map((state) => state.activeSessionId)).toEqual(["child"]);
	});

	it("cancels pending extension UI requests when the last client detaches", () => {
		const firstClient = makeClient("client-1", "active");
		const secondClient = makeClient("client-2", "active");
		const firstResolve = vi.fn();
		const secondResolve = vi.fn();
		const state = {
			...makeState("active"),
			clients: new Set<DaemonSocketClient>([firstClient, secondClient]),
			extensionUiRequests: new Map([
				["request-1", { resolve: firstResolve }],
				["request-2", { resolve: secondResolve }],
			]),
		};

		detachClientFromActiveSession(firstClient, state);

		expect(state.extensionUiRequests.size).toBe(2);
		expect(firstResolve).not.toHaveBeenCalled();
		expect(firstClient.attachedActiveSessionIds.has("active")).toBe(false);

		detachClientFromActiveSession(secondClient, state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(firstResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondResolve).toHaveBeenCalledWith({ cancelled: true });
		expect(secondClient.attachedActiveSessionIds.has("active")).toBe(false);
	});

	it("releases owner-scoped ACP MCP config when its daemon client detaches", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-acp-owner.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const owner = makeClient("owner", "active");
		const other = makeClient("other", "active");
		const replaceAcpMcpServers = vi.fn();
		const releaseAcpMcpServers = vi.fn(async () => {});
		const state = makeState("active");
		state.clientEnv = {};
		state.clients.add(owner);
		state.clients.add(other);
		state.extensionUiRequests = new Map();
		state.runtime = {
			...state.runtime,
			session: {
				isStreaming: false,
				replaceAcpMcpServers,
				releaseAcpMcpServers,
				acquireSessionInputPause: () => ({ release: vi.fn() }),
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonOutbound | undefined>;
			detachClientFromSession(client: DaemonSocketClient, state: ActiveSessionState): void;
			write: ReturnType<typeof vi.fn>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.write = vi.fn();

		replaceAcpMcpServers.mockImplementationOnce(() => {
			throw new Error("replacement failed");
		});
		await expect(
			internals.handleCommand(owner, {
				type: "replace_acp_mcp_servers",
				activeSessionId: state.activeSessionId,
				ownerId: "owner-token",
				servers: [{ name: "failed", type: "http", url: "https://failed.example/mcp", headers: {} }],
			}),
		).rejects.toThrow("replacement failed");
		expect(releaseAcpMcpServers).toHaveBeenLastCalledWith("owner-token", ["failed"]);

		await internals.handleCommand(owner, {
			type: "replace_acp_mcp_servers",
			activeSessionId: state.activeSessionId,
			ownerId: "owner-token",
			servers: [{ name: "task", type: "http", url: "https://task.example/mcp", headers: {} }],
		});
		const releaseCount = releaseAcpMcpServers.mock.calls.length;
		(state.runtime.session as unknown as { isStreaming: boolean }).isStreaming = true;
		await expect(
			internals.handleCommand(owner, {
				type: "replace_acp_mcp_servers",
				activeSessionId: state.activeSessionId,
				ownerId: "owner-token",
				servers: [{ name: "next", type: "http", url: "https://next.example/mcp", headers: {} }],
			}),
		).rejects.toThrow("while the agent is running");
		expect(releaseAcpMcpServers).toHaveBeenCalledTimes(releaseCount);
		(state.runtime.session as unknown as { isStreaming: boolean }).isStreaming = false;

		await expect(
			internals.handleCommand(other, {
				type: "replace_acp_mcp_servers",
				activeSessionId: state.activeSessionId,
				ownerId: "other-token",
				servers: [{ name: "other", type: "http", url: "https://other.example/mcp", headers: {} }],
			}),
		).rejects.toThrow("owned by another daemon client");

		internals.detachClientFromSession(owner, state);
		expect(releaseAcpMcpServers).toHaveBeenCalledWith("owner-token", ["task"]);

		await internals.handleCommand(other, {
			type: "replace_acp_mcp_servers",
			activeSessionId: state.activeSessionId,
			ownerId: "other-token",
			servers: [{ name: "other", type: "http", url: "https://other.example/mcp", headers: {} }],
		});
		expect(replaceAcpMcpServers).toHaveBeenLastCalledWith(
			[{ name: "other", type: "http", url: "https://other.example/mcp", headers: {} }],
			"other-token",
		);

		await internals.handleCommand(other, {
			type: "replace_acp_mcp_servers",
			activeSessionId: state.activeSessionId,
			ownerId: "other-token",
			servers: [],
		});
		expect(releaseAcpMcpServers).toHaveBeenLastCalledWith("other-token", ["other"]);
	});

	it("fails fast on unknown worker commands instead of dropping them", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-unknown-worker-command.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const internals = daemon as unknown as {
			handleWorkerCommand(client: DaemonSocketClient, command: unknown): Promise<void>;
			write: ReturnType<typeof vi.fn>;
		};
		internals.write = vi.fn();
		const client = makeClient("legacy-supervisor", "active");

		await internals.handleWorkerCommand(client, { id: "legacy-1", type: "worker_sync_agent_peers", peers: [] });

		expect(internals.write).toHaveBeenCalledWith(
			client,
			expect.objectContaining({ id: "legacy-1", command: "worker_sync_agent_peers", success: false }),
		);
	});

	it("cancels pending extension UI requests directly", () => {
		const resolve = vi.fn();
		const state = {
			...makeState("active"),
			extensionUiRequests: new Map([["request-1", { resolve }]]),
		};

		cancelPendingExtensionUiRequests(state);

		expect(state.extensionUiRequests.size).toBe(0);
		expect(resolve).toHaveBeenCalledWith({ cancelled: true });
	});

	it("acknowledges agent messages after target prompt preflight succeeds", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const fromState = makeState("source");
		const targetState = makeState("target") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					sessionId: string;
					sessionName: string;
					isStreaming: boolean;
					unfinishedActionCount: number;
					acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
				};
			};
		};
		let resolvePrompt: () => void = () => {};
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return new Promise<void>((resolve) => {
					resolvePrompt = resolve;
				});
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
			session: {
				sessionId: "session-source",
				sessionName: "Source",
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

		const send = internals.sendAgentSessionMessage({
			targetSelector: targetState.activeSessionId,
			message: "please continue",
			fromState,
			origin: "agent",
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		resolvePrompt();
		await expect(send).resolves.toMatchObject({
			deliveryStatus: "delivered",
			target: { activeSessionId: targetState.activeSessionId },
		});
	});

	it("classifies local roster status with heartbeat and running-child activity", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-status-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const state = makeState("local-active");
		let hasRunningChildren = true;
		state.runtime = {
			...state.runtime,
			cwd: "/tmp",
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: "local-session",
				isSessionActive: false,
				isStreaming: false,
				unfinishedActionCount: 0,
				hasRunningRlmChildren: () => hasRunningChildren,
			},
		} as never;
		const internals = daemon as unknown as {
			cronStore: {
				getHeartbeat(activeSessionId: string): AgentCronJob | undefined;
				listRlmHeartbeats(activeSessionId: string): AgentCronJob[];
			};
			createAgentMessageAgentSummary(state: ActiveSessionState): { status?: string };
		};
		const getHeartbeat = vi.spyOn(internals.cronStore, "getHeartbeat").mockReturnValue(undefined);
		const listRlmHeartbeats = vi.spyOn(internals.cronStore, "listRlmHeartbeats").mockReturnValue([]);

		expect(internals.createAgentMessageAgentSummary(state).status).toBe("running");
		hasRunningChildren = false;
		state.runtime = {
			...state.runtime,
			metadata: { kind: "subagent", createdAt: 1 },
		} as ActiveSessionState["runtime"];
		expect(internals.createAgentMessageAgentSummary(state).status).toBe("idle");
		getHeartbeat.mockReturnValue({ status: "active" } as AgentCronJob);
		expect(internals.createAgentMessageAgentSummary(state).status).toBe("running");
		getHeartbeat.mockReturnValue(undefined);
		listRlmHeartbeats.mockReturnValue([{ status: "active" } as AgentCronJob]);
		expect(internals.createAgentMessageAgentSummary(state).status).toBe("running");
	});

	it("reserves a session name across equivalent session-relative parent headers", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-name-reservation.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const first = makeState("first");
		const second = makeState("second");
		first.runtime = {
			...first.runtime,
			session: {
				sessionId: "first-session",
				sessionFile: "/tmp/children/first.jsonl",
				rlmDepth: 1,
				sessionManager: { getHeader: vi.fn(() => ({ parentSession: "../parent.jsonl" })) },
				setSessionName: vi.fn(),
			},
		} as never;
		second.runtime = {
			...second.runtime,
			session: {
				sessionId: "second-session",
				sessionFile: "/tmp/children/nested/second.jsonl",
				rlmDepth: 1,
				sessionManager: { getHeader: vi.fn(() => ({ parentSession: "../../parent.jsonl" })) },
				setSessionName: vi.fn(),
			},
		} as never;
		let releaseValidation!: () => void;
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		const internals = daemon as unknown as {
			assertStateSessionNameAvailable: ReturnType<typeof vi.fn>;
			setStateSessionName(state: ActiveSessionState, name: string): Promise<void>;
		};
		internals.assertStateSessionNameAvailable = vi.fn(async () => validationGate);

		const firstRename = internals.setStateSessionName(first, "shared");
		await expect(internals.setStateSessionName(second, "shared")).rejects.toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);
		releaseValidation();
		await expect(firstRename).resolves.toBeUndefined();
		expect(first.runtime.session.setSessionName).toHaveBeenCalledWith("shared");
		expect(second.runtime.session.setSessionName).not.toHaveBeenCalled();
	});

	it("allows concurrent same-name renames under different parents", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-scoped-name-reservation.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const first = makeState("first", "parent-a");
		const second = makeState("second", "parent-b");
		first.runtime = {
			...first.runtime,
			metadata: { ...first.runtime.metadata, parentSessionId: "parent-session-a" },
			session: {
				sessionId: "first-session",
				rlmDepth: 1,
				sessionManager: { getHeader: vi.fn(() => undefined) },
				setSessionName: vi.fn(),
			},
		} as never;
		second.runtime = {
			...second.runtime,
			metadata: { ...second.runtime.metadata, parentSessionId: "parent-session-b" },
			session: {
				sessionId: "second-session",
				rlmDepth: 1,
				sessionManager: { getHeader: vi.fn(() => undefined) },
				setSessionName: vi.fn(),
			},
		} as never;
		let releaseValidation!: () => void;
		const validationGate = new Promise<void>((resolve) => {
			releaseValidation = resolve;
		});
		const internals = daemon as unknown as {
			assertStateSessionNameAvailable: ReturnType<typeof vi.fn>;
			setStateSessionName(state: ActiveSessionState, name: string): Promise<void>;
		};
		internals.assertStateSessionNameAvailable = vi.fn(async () => validationGate);

		const firstRename = internals.setStateSessionName(first, "worker");
		const secondRename = internals.setStateSessionName(second, "worker");
		await vi.waitFor(() => expect(internals.assertStateSessionNameAvailable).toHaveBeenCalledTimes(2));
		releaseValidation();

		await expect(Promise.all([firstRename, secondRename])).resolves.toEqual([undefined, undefined]);
		expect(first.runtime.session.setSessionName).toHaveBeenCalledWith("worker");
		expect(second.runtime.session.setSessionName).toHaveBeenCalledWith("worker");
	});

	it("scopes a switched child rename from its session-relative persisted parent header", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-switched-child-name-"));
		try {
			const parentPath = join(tempDir, "parent.jsonl");
			const childDir = join(tempDir, "child");
			const childPath = join(childDir, "child.jsonl");
			mkdirSync(childDir);
			writeFileSync(parentPath, "");
			const state = makeState("switched-child");
			state.runtime = {
				...state.runtime,
				metadata: { kind: "top-level", createdAt: 1 },
				session: {
					sessionId: "session-child",
					sessionFile: childPath,
					rlmDepth: 1,
					sessionManager: { getHeader: () => ({ parentSession: "../parent.jsonl" }) },
				},
			} as never;
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime: vi.fn(),
			});
			const internals = daemon as unknown as {
				createAgentFamilyCatalog: ReturnType<typeof vi.fn>;
				assertStateSessionNameAvailable(state: ActiveSessionState, name: string): Promise<void>;
			};
			internals.createAgentFamilyCatalog = vi.fn(async () => [
				{
					id: "sibling",
					name: "taken",
					depth: 1,
					status: "idle",
					parentSessionPath: canonicalSessionPath(parentPath),
				},
			]);

			await expect(internals.assertStateSessionNameAvailable(state, "taken")).rejects.toThrow(
				"an agent of that name already exists at depth 1 under this parent",
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("canonicalizes symlinked parent paths in name reservations", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-family-catalog-paths-"));
		try {
			const realDir = join(tempDir, "real");
			const aliasDir = join(tempDir, "alias");
			mkdirSync(realDir);
			symlinkSync(realDir, aliasDir, "dir");
			expect(
				sessionNameReservationKey({
					name: "worker",
					depth: 1,
					parentSessionPath: join(realDir, "parent.jsonl"),
				}),
			).toBe(
				sessionNameReservationKey({
					name: "worker",
					depth: 1,
					parentSessionPath: join(aliasDir, "parent.jsonl"),
				}),
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lists and sends agent messages to completed retained subagents", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const parentState = makeState("parent");
		parentState.runtime = {
			...parentState.runtime,
			cwd: "/tmp",
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: "session-parent",
				sessionName: "Parent",
				isStreaming: false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
			},
		} as never;
		const defaultSubagentName = createDefaultRlmSubagentSessionName("retained worker", "child-1");
		const subagentState = makeState("child", "parent") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					sessionId: string;
					sessionName: string;
					isStreaming: boolean;
					unfinishedActionCount: number;
					acceptAgentMessagePrompt: ReturnType<typeof vi.fn>;
				};
			};
		};
		const acceptAgentMessagePrompt = vi.fn(
			(message: string, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
				options?.preflightResult?.(true);
				return Promise.resolve(message);
			},
		);
		subagentState.runtime = {
			...subagentState.runtime,
			cwd: "/tmp",
			metadata: {
				...subagentState.runtime.metadata,
				rlmChildId: "child-1",
			},
			session: {
				sessionId: "session-child",
				sessionName: defaultSubagentName,
				isStreaming: false,
				sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
		};
		internals.sessions.set(parentState.activeSessionId, parentState);
		// A successfully completed RLM child remains idle in this daemon registry.
		internals.sessions.set(subagentState.activeSessionId, subagentState);

		const controller = internals.createAgentMessageController(() => parentState);
		const subagentSummary = (await controller.listAgents()).agents.find(
			(agent) => agent.activeSessionId === subagentState.activeSessionId,
		);
		expect(subagentSummary).toMatchObject({
			sessionName: defaultSubagentName,
			runtimeKind: "subagent",
			parentActiveSessionId: parentState.activeSessionId,
			rlmChildId: "child-1",
		});
		if (!subagentSummary?.sessionName) {
			throw new Error("Missing default subagent session name");
		}

		await expect(
			controller.sendAgentMessage({
				target: subagentSummary.sessionName,
				message: "report current progress",
			}),
		).resolves.toMatchObject({
			deliveryStatus: "delivered",
			target: { activeSessionId: subagentState.activeSessionId, runtimeKind: "subagent" },
		});
		expect(acceptAgentMessagePrompt).toHaveBeenCalledOnce();
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[0]).toContain(`To: ${defaultSubagentName}, active child`);
		expect(acceptAgentMessagePrompt.mock.calls[0]?.[0]).toContain("report current progress");
	});

	it("closes a hosted child through the release hook and persists cancellation", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-daemon-release-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const parentState = makeState("parent");
		const childState = makeState("child", parentState.activeSessionId);
		Object.assign(childState.runtime.metadata, {
			kind: "subagent",
			parentActiveSessionId: parentState.activeSessionId,
			rlmChildId: "child-1",
		});
		let internals: {
			sessions: Map<string, ActiveSessionState>;
			closeSession: (state: ActiveSessionState, reason: "completed" | "killed") => Promise<void>;
			recordRlmSubagentDeletion(parentState: ActiveSessionState, childId: string): Promise<void>;
			createSubagentRuntimeHost(parentState: ActiveSessionState): SubagentRuntimeHost;
		};
		const closeSession = vi.fn(async (state: ActiveSessionState) => {
			internals.sessions.delete(state.activeSessionId);
		});
		internals = daemon as unknown as typeof internals;
		internals.sessions.set(parentState.activeSessionId, parentState);
		internals.sessions.set(childState.activeSessionId, childState);
		internals.closeSession = closeSession;
		const recordDeletion = vi.fn(async () => undefined);
		internals.recordRlmSubagentDeletion = recordDeletion;

		await internals
			.createSubagentRuntimeHost(parentState)
			.releaseRlmSubagentRuntime?.(
				{ session: childState.runtime.session },
				{ id: "child-1" } as CreateRlmSubagentRuntimeOptions,
				"error",
			);

		expect(recordDeletion).not.toHaveBeenCalled();
		expect(closeSession).toHaveBeenCalledWith(childState, "completed");
		internals.sessions.set(childState.activeSessionId, childState);
		await internals
			.createSubagentRuntimeHost(parentState)
			.releaseRlmSubagentRuntime?.(
				{ session: childState.runtime.session },
				{ id: "child-1" } as CreateRlmSubagentRuntimeOptions,
				"cancelled",
			);
		expect(recordDeletion).toHaveBeenCalledWith(parentState, "child-1", "revoked");
		expect(recordDeletion.mock.invocationCallOrder[0]).toBeLessThan(closeSession.mock.invocationCallOrder[1]!);
		expect(closeSession).toHaveBeenLastCalledWith(childState, "killed");
		expect(internals.sessions.has(childState.activeSessionId)).toBe(false);

		// A registry failure must not strand the cancelled child as a stale resident session.
		internals.sessions.set(childState.activeSessionId, childState);
		internals.recordRlmSubagentDeletion = vi.fn(async () => {
			throw new Error("registry write failed");
		});
		await expect(
			internals
				.createSubagentRuntimeHost(parentState)
				.releaseRlmSubagentRuntime?.(
					{ session: childState.runtime.session },
					{ id: "child-1" } as CreateRlmSubagentRuntimeOptions,
					"cancelled",
				),
		).rejects.toThrow("registry write failed");
		expect(closeSession).toHaveBeenLastCalledWith(childState, "killed");
		expect(internals.sessions.has(childState.activeSessionId)).toBe(false);
	});

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
			const roster = await internals.createAgentMessageController(() => parentState).roster?.();
			const passiveRosterEntry = roster?.entries.find((entry) => entry.name === "real-worker");
			expect(passiveRosterEntry).toMatchObject({ relationship: "child", status: "inactive" });
			expect(passiveRosterEntry).not.toHaveProperty("repliedSinceTask");
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

	it("discovers a non-resident child left running in the persisted registry", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-orphan-running-child-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const registryPath = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const entry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, unknown>;
			entry.status = "running";
			delete entry.sessionDir;
			writeFileSync(registryPath, `${JSON.stringify(entry)}\n`);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<Array<{ entry: { childId: string; status: string } }>>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			expect((await internals.listPassiveRlmSubagents()).map(({ entry }) => entry)).toContainEqual(
				expect.objectContaining({ childId: fixture.childId, status: "running" }),
			);
			await expect(internals.createAgentMessageController(() => parentState).roster?.()).resolves.toMatchObject({
				entries: [expect.objectContaining({ relationship: "child", name: "renamed-worker" })],
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("persists explicit child depth for an in-memory daemon parent", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-in-memory-parent-depth-"));
		try {
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
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: join(tempDir, "sessions") },
				createRuntime,
			});
			const internals = daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<ActiveSessionState["runtime"]>;
			};
			const parentState = await internals.createRuntime({ type: "create", noSession: true });
			const child = await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "persist depth",
				sessionName: "depth-child",
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

			expect(parentState.runtime.session.sessionFile).toBeUndefined();
			expect(child.session.sessionManager.getHeader()).toMatchObject({ rlmDepth: 1 });
			expect(child.session.sessionManager.getHeader()?.parentSession).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("defers RLM heartbeats while a subagent is binding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-binding-heartbeat-"));
		let releaseChildBinding: (() => void) | undefined;
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			const parentSessionFile = parentManager.getSessionFile();
			if (!parentSessionFile) {
				throw new Error("Missing parent session file");
			}
			const childSessionDir = join(parentManager.getSessionArtifactDir() ?? tempDir, "child-1");
			let markChildBindingStarted: (() => void) | undefined;
			const childBindingStarted = new Promise<void>((resolve) => {
				markChildBindingStarted = resolve;
			});
			const childBindingGate = new Promise<void>((resolve) => {
				releaseChildBinding = resolve;
			});
			const promptHeartbeat = vi.fn(
				async (_job: AgentCronJob, options?: { preflightResult?: (didSucceed: boolean) => void }) => {
					options?.preflightResult?.(true);
				},
			);
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				Object.assign(session, {
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					isBashRunning: false,
					hasAcceptedPromptInFlight: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					promptHeartbeat,
				});
				if (options.sessionOptions?.rlmSessionDir === childSessionDir) {
					session.bindExtensions = vi.fn(async () => {
						markChildBindingStarted?.();
						await childBindingGate;
					});
				}
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				cronScheduler: { runDue(now: Date): Promise<number> };
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<ActiveSessionState["runtime"]>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: parentSessionFile });
			const childRuntimePromise = internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "initialize a heartbeat",
				sessionName: "heartbeat-child",
				sessionDir: childSessionDir,
				model: {} as Model<Api>,
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
			await childBindingStarted;
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === "child-1",
			);
			const childSessionFile = childState?.runtime.session.sessionFile;
			if (!childState || !childSessionFile) {
				throw new Error("Missing binding child session");
			}
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			expect(await internals.cronScheduler.runDue(new Date("2026-07-16T00:00:00.000Z"))).toBe(0);
			expect(promptHeartbeat).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 0,
			});

			if (!releaseChildBinding) {
				throw new Error("Missing child binding release");
			}
			releaseChildBinding();
			releaseChildBinding = undefined;
			await childRuntimePromise;
			expect(await internals.cronScheduler.runDue(new Date("2027-01-01T00:00:00.000Z"))).toBe(1);
			expect(promptHeartbeat).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 1,
			});
		} finally {
			releaseChildBinding?.();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("skips a cron job cancelled while its prompt waits for admission", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-cron-admission-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			manager.newSession();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Missing session file");
			}
			let cancelJobDuringAdmission: (() => void) | undefined;
			const promptUntilAccepted = vi.fn(async (_prompt: string, options?: { admissionCommitted?: () => void }) => {
				cancelJobDuringAdmission?.();
				options?.admissionCommitted?.();
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				Object.assign(session, {
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					isBashRunning: false,
					unfinishedActionCount: 0,
					hasAcceptedPromptInFlight: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					promptUntilAccepted,
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				cronScheduler: { runDue(now: Date): Promise<number> };
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			const state = await internals.createRuntime({ type: "create", sessionPath: sessionFile });
			const job = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: state.runtime.session.sessionId,
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "scheduled work",
			});
			cancelJobDuringAdmission = () => {
				internals.cronStore.cancel(job.id);
			};

			expect(await internals.cronScheduler.runDue(new Date(Date.now() + 10 * 60 * 1000))).toBe(0);
			expect(promptUntilAccepted).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)?.status).toBe("cancelled");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("skips a heartbeat whose instruction changed while its prompt waits for admission", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-admission-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const manager = SessionManager.create(tempDir, sessionDir);
			manager.newSession();
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Missing session file");
			}
			let updateHeartbeatDuringAdmission: (() => void) | undefined;
			const promptHeartbeat = vi.fn(async (_job: AgentCronJob, options?: { admissionCommitted?: () => void }) => {
				updateHeartbeatDuringAdmission?.();
				updateHeartbeatDuringAdmission = undefined;
				options?.admissionCommitted?.();
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				Object.assign(session, {
					isStreaming: false,
					isCompacting: false,
					isRetrying: false,
					isBashRunning: false,
					unfinishedActionCount: 0,
					hasAcceptedPromptInFlight: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
					promptHeartbeat,
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				cronScheduler: { runDue(now: Date): Promise<number> };
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			const state = await internals.createRuntime({ type: "create", sessionPath: sessionFile });
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: state.runtime.session.sessionId,
				sessionFile,
				cwd: tempDir,
				runtimeKind: "top-level",
				scheduleText: "every 5m",
				prompt: "old instruction",
			});
			updateHeartbeatDuringAdmission = () => {
				internals.cronStore.updateRlmHeartbeat(state.activeSessionId, heartbeat.id, { prompt: "new instruction" });
			};

			expect(await internals.cronScheduler.runDue(new Date(Date.now() + 10 * 60 * 1000))).toBe(0);
			expect(promptHeartbeat).toHaveBeenCalledOnce();
			expect(promptHeartbeat.mock.calls[0]?.[0]).toMatchObject({ prompt: "old instruction" });
			expect(internals.cronStore.list().find((candidate) => candidate.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 0,
			});

			expect(await internals.cronScheduler.runDue(new Date(Date.now() + 20 * 60 * 1000))).toBe(1);
			expect(promptHeartbeat).toHaveBeenCalledTimes(2);
			expect(promptHeartbeat.mock.calls[1]?.[0]).toMatchObject({ prompt: "new instruction" });
			expect(internals.cronStore.list().find((candidate) => candidate.id === heartbeat.id)).toMatchObject({
				status: "active",
				runCount: 1,
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
		expect(closeSession).toHaveBeenCalledWith(childState, "killed", false);
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

	it("hides daemon sessions from messaging and observation while they are closing", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const parentState = makeState("parent");
		const childState = makeState("child", parentState.activeSessionId);
		const sessionPrompt = vi.fn(async () => {});
		for (const [state, sessionId] of [
			[parentState, "session-parent"],
			[childState, "session-child"],
		] as const) {
			state.runtime = {
				...state.runtime,
				cwd: "/tmp",
				session: {
					sessionId,
					sessionName: sessionId,
					prompt: sessionPrompt,
					isStreaming: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				},
			} as unknown as ActiveSessionState["runtime"];
		}
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			closingSessions: Map<string, { promise: Promise<void>; reason: "shutdown" }>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
			getBoundSessionState(id: string): ActiveSessionState;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(parentState.activeSessionId, parentState);
		internals.sessions.set(childState.activeSessionId, childState);
		internals.closingSessions.set(childState.activeSessionId, { promise: Promise.resolve(), reason: "shutdown" });

		const controller = internals.createAgentMessageController(() => parentState);
		const listed = await controller.listAgents();
		expect(listed.agents).not.toContainEqual(
			expect.objectContaining({ activeSessionId: childState.activeSessionId }),
		);
		expect(() => internals.getBoundSessionState(childState.activeSessionId)).toThrow("is closing");
		await expect(
			controller.sendAgentMessage({ target: childState.activeSessionId, message: "continue" }),
		).rejects.toThrow("is closing");
		const client = makeClient("client-1", childState.activeSessionId);
		for (const command of [
			{ id: "prompt", type: "prompt", activeSessionId: childState.activeSessionId, message: "continue" },
			{ id: "steer", type: "steer", activeSessionId: childState.activeSessionId, message: "continue" },
			{ id: "follow-up", type: "follow_up", activeSessionId: childState.activeSessionId, message: "continue" },
		] as const) {
			await expect(internals.handleCommand(client, command)).rejects.toThrow("is closing");
		}
	});

	it("removes a closing daemon session even when runtime disposal fails", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("child");
		const dispose = vi.fn(async () => {
			throw new Error("dispose failed");
		});
		state.runtime = {
			...state.runtime,
			dispose,
			session: {
				sessionId: "session-child",
				sessionFile: undefined,
				abort: vi.fn(() => new Promise<void>(() => {})),
			},
		} as unknown as ActiveSessionState["runtime"];
		state.extensionUiRequests = new Map();
		state.unsubscribe = vi.fn();
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			closingSessions: Map<string, { promise: Promise<void>; reason: "shutdown" }>;
			closeSession(state: ActiveSessionState, reason: "killed", waitForAbort?: boolean): Promise<void>;
			closeChildSessions: ReturnType<typeof vi.fn>;
			isEmptyDraftContent: ReturnType<typeof vi.fn>;
			abortBashForClose: ReturnType<typeof vi.fn>;
			recordWorkerRecoveryState: ReturnType<typeof vi.fn>;
			broadcastToSession: ReturnType<typeof vi.fn>;
			cancelScheduledJobsForSession: ReturnType<typeof vi.fn>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.closeChildSessions = vi.fn(async () => undefined);
		internals.isEmptyDraftContent = vi.fn(() => true);
		internals.abortBashForClose = vi.fn(async () => {});
		internals.recordWorkerRecoveryState = vi.fn();
		internals.broadcastToSession = vi.fn();
		internals.cancelScheduledJobsForSession = vi.fn();

		await expect(internals.closeSession(state, "killed", false)).rejects.toThrow("dispose failed");

		expect(dispose).toHaveBeenCalledOnce();
		expect(internals.sessions.has(state.activeSessionId)).toBe(false);
		expect(internals.closingSessions.has(state.activeSessionId)).toBe(false);
	});

	it("returns no peers when the supervisor query fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-peer-query-failure-"));
		const previousSupervisorSocket = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = join(tempDir, "missing.sock");
			const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: vi.fn(),
				worker: { authenticationToken: "worker-token" },
			});
			const listSupervisorAgentPeers = (
				daemon as unknown as { listSupervisorAgentPeers(): Promise<unknown[]> }
			).listSupervisorAgentPeers.bind(daemon);

			await expect(listSupervisorAgentPeers()).resolves.toEqual([]);
		} finally {
			if (previousSupervisorSocket === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSupervisorSocket;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("lists and role-addresses root siblings hosted by another worker", async () => {
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
		const remoteSelector = "remote is closing";
		const receipt = {
			id: "agentmsg-remote",
			source: "agent_message",
			target: { activeSessionId: remoteSelector, sessionId: "session-remote" },
			message: "continue remotely",
			deliveryStatus: "delivered",
			deliveredAt: "2026-01-01T00:00:00.000Z",
			deliveryMode: "auto",
		};
		const sendRemoteAgentSessionMessage = vi.fn().mockResolvedValue(receipt);
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			listSupervisorAgentPeers: ReturnType<typeof vi.fn>;
			createAgentMessageListResult(
				current: ActiveSessionState,
			): Promise<{ agents: Array<{ activeSessionId: string }> }>;
			createAgentMessageController(getCurrentState: () => ActiveSessionState): AgentSessionMessageController;
			sendRemoteAgentSessionMessage: typeof sendRemoteAgentSessionMessage;
		};
		internals.sessions.set(source.activeSessionId, source);
		internals.listSupervisorAgentPeers = vi.fn(async () => [
			{
				activeSessionId: remoteSelector,
				sessionId: "session-remote",
				sessionName: "Remote",
				runtimeKind: "top-level",
				cwd: "/tmp/remote",
				isStreaming: false,
				unfinishedActionCount: 0,
			},
		]);
		internals.sendRemoteAgentSessionMessage = sendRemoteAgentSessionMessage;

		expect((await internals.createAgentMessageListResult(source)).agents).toContainEqual(
			expect.objectContaining({ activeSessionId: remoteSelector }),
		);
		const listAll = vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
		try {
			const handlers = createAgentMessageHostHandlers(internals.createAgentMessageController(() => source));
			const roster = await handlers["agent_message.list_agents"]!({});
			expect(roster.current).toMatchObject({ name: "Source", id: "session-source", depth: 0 });
			expect(roster.entries).toContainEqual({
				relationship: "sibling",
				name: "Remote",
				id: "session-remote",
				depth: 0,
				status: "idle",
			});
			await expect(
				handlers["agent_message.send"]!({
					message: "continue remotely",
					receiver_role: "sibling",
					receiver_name: "Remote",
				}),
			).resolves.toEqual(receipt);
			expect(sendRemoteAgentSessionMessage).toHaveBeenCalledWith(source, "session-remote", "continue remotely");
		} finally {
			listAll.mockRestore();
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

	it("rejects invalid nonresident agent messages before remote fallback", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const source = makeState("source");
		const sendRemoteAgentSessionMessage = vi.fn();
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
				targetSelector: "nonresident-target",
				message: " ",
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Agent session message cannot be empty");
		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: "nonresident-target",
				message: "x".repeat(DEFAULT_AGENT_MESSAGE_MAX_CHARS + 1),
				fromState: source,
				origin: "agent",
			}),
		).rejects.toThrow("Agent session message is too long");
		expect(sendRemoteAgentSessionMessage).not.toHaveBeenCalled();
	});

	it("does not retry supervisor agent-message rejections", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-msg-"));
		const socketPath = join(tempDir, "d.sock");
		let connectionCount = 0;
		const server: Server = createServer((socket) => {
			connectionCount++;
			socket.on("error", () => undefined);
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaId: DAEMON_SCHEMA_ID,
					clientId: "supervisor",
					serverCapabilities: [],
				})}\n`,
			);
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const wire = JSON.parse(buffer.slice(0, newline)) as {
					id: string;
					command?: { type: string };
					type: string;
				};
				const command = wire.command ?? wire;
				socket.write(
					`${JSON.stringify({
						type: "response",
						id: wire.id,
						command: command.type,
						success: false,
						error: "Target session has too many pending messages",
					})}\n`,
				);
			});
		});
		const previousSupervisorSocket = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
				defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
				worker: { authenticationToken: "worker-token" },
			});
			const sendRemoteAgentSessionMessage = (
				daemon as unknown as {
					sendRemoteAgentSessionMessage(
						fromState: ActiveSessionState,
						targetSelector: string,
						message: string,
					): Promise<unknown>;
				}
			).sendRemoteAgentSessionMessage.bind(daemon);

			await expect(sendRemoteAgentSessionMessage(makeState("source"), "remote", "continue")).rejects.toThrow(
				"Target session has too many pending messages",
			);
			expect(connectionCount).toBe(1);
		} finally {
			if (previousSupervisorSocket === undefined) {
				delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			} else {
				process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSupervisorSocket;
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not retry after the supervisor receives an agent message", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-msg-disconnect-"));
		const socketPath = join(tempDir, "d.sock");
		let requestCount = 0;
		const server: Server = createServer((socket) => {
			socket.on("error", () => undefined);
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaId: DAEMON_SCHEMA_ID,
					clientId: "supervisor",
					serverCapabilities: [],
				})}\n`,
			);
			let buffer = "";
			socket.on("data", (chunk) => {
				buffer += chunk.toString();
				const newline = buffer.indexOf("\n");
				if (newline === -1) return;
				const wire = JSON.parse(buffer.slice(0, newline)) as {
					id: string;
					command?: { type: string };
					type: string;
				};
				const command = wire.command ?? wire;
				requestCount++;
				if (requestCount === 1) {
					socket.destroy();
					return;
				}
				socket.write(
					`${JSON.stringify({
						type: "response",
						id: wire.id,
						command: command.type,
						success: true,
						data: {},
					})}\n`,
				);
			});
		});
		const previousSupervisorSocket = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
				defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
				worker: { authenticationToken: "worker-token" },
			});
			const sendRemoteAgentSessionMessage = (
				daemon as unknown as {
					sendRemoteAgentSessionMessage(
						fromState: ActiveSessionState,
						targetSelector: string,
						message: string,
					): Promise<unknown>;
				}
			).sendRemoteAgentSessionMessage.bind(daemon);

			await expect(sendRemoteAgentSessionMessage(makeState("source"), "remote", "continue")).rejects.toThrow(
				"Connection to the Prime Agent daemon closed",
			);
			expect(requestCount).toBe(1);
		} finally {
			if (previousSupervisorSocket === undefined) {
				delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			} else {
				process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSupervisorSocket;
			}
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("routes worker-local session renames through the supervisor", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-worker-rename-"));
		const socketPath = join(tempDir, "s");
		let receivedCommand: Record<string, unknown> | undefined;
		let releaseResponse: () => void = () => {};
		const responseGate = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		const server = createServer((socket) => {
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaRevision: DAEMON_SCHEMA_REVISION,
					serverCapabilities: [],
					clientId: "worker-rename-test",
				})}\n`,
			);
			let buffered = "";
			socket.on("data", (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				const newline = buffered.indexOf("\n");
				if (newline < 0 || receivedCommand) return;
				const wire = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
				receivedCommand = (wire.command as Record<string, unknown> | undefined) ?? wire;
				void responseGate.then(() => {
					socket.write(
						`${JSON.stringify({
							id: wire.id,
							type: "response",
							command: "set_session_name",
							success: true,
						})}\n`,
					);
				});
			});
		});
		const previousSocketPath = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = new AgentDaemon(join(tempDir, "worker.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: vi.fn(),
				worker: { authenticationToken: "token" },
			});
			const setSessionName = vi.fn((_name: string) => undefined);
			const state = makeState("active");
			Object.assign(state.runtime, { session: { setSessionName } });
			const controller = (
				daemon as unknown as {
					createAgentMessageController(getCurrentState: () => ActiveSessionState): AgentSessionMessageController;
				}
			).createAgentMessageController(() => state);

			const rename = controller.setSessionName?.("shared-root");
			// Workers and supervisors ship in one process tree, so no capability gate is needed; the
			// optional field remains compatible with old supervisors because envelope parsing preserves extra fields.
			await vi.waitFor(() =>
				expect(receivedCommand).toMatchObject({
					type: "set_session_name",
					activeSessionId: "active",
					name: "shared-root",
					workerToken: "token",
				}),
			);
			expect(setSessionName).not.toHaveBeenCalled();
			releaseResponse();
			await expect(rename).resolves.toBeUndefined();
		} finally {
			if (previousSocketPath === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSocketPath;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not retry permanent ambiguity errors from the supervisor", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pa-ambiguous-"));
		const socketPath = join(tempDir, "s");
		let requestCount = 0;
		const server = createServer((socket) => {
			socket.write(
				`${JSON.stringify({
					type: "daemon_hello",
					socketPath,
					protocol: DAEMON_PROTOCOL_INFO,
					schemaRevision: DAEMON_SCHEMA_REVISION,
					serverCapabilities: [],
				})}\n`,
			);
			let buffered = "";
			socket.on("data", (chunk: Buffer) => {
				buffered += chunk.toString("utf8");
				const newline = buffered.indexOf("\n");
				if (newline < 0 || requestCount > 0) return;
				const command = JSON.parse(buffered.slice(0, newline)) as { id?: string };
				requestCount++;
				socket.write(
					`${JSON.stringify(failure(command.id, "send_message", new Error('Ambiguous session selector "duplicate"')))}\n`,
				);
			});
		});
		const previousSocketPath = process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(socketPath, resolve);
			});
			process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = socketPath;
			const daemon = new AgentDaemon(join(tempDir, "worker.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: vi.fn(),
			});
			const source = makeState("source");
			const internals = daemon as unknown as {
				sendRemoteAgentSessionMessage(
					fromState: ActiveSessionState,
					targetSelector: string,
					message: string,
				): Promise<unknown>;
			};

			await expect(internals.sendRemoteAgentSessionMessage(source, "duplicate", "hello")).rejects.toThrow(
				'Ambiguous session selector "duplicate"',
			);
			expect(requestCount).toBe(1);
		} finally {
			if (previousSocketPath === undefined) delete process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
			else process.env[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV] = previousSocketPath;
			await new Promise<void>((resolve) => server.close(() => resolve()));
			rmSync(tempDir, { recursive: true, force: true });
		}
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

	it("ignores a legacy follow-up mode and always steers agent messages", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		const acceptAgentMessagePrompt = vi.fn(
			(_message: string, options?: { preflightResult?: (accepted: boolean, queued?: boolean) => void }) => {
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
				isStreaming: true,
				isCompacting: false,
				isRetrying: false,
				isBashRunning: false,
				unfinishedActionCount: 0,
				acceptAgentMessagePrompt,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const response = await internals.handleCommand(makeClient("legacy-client", targetState.activeSessionId), {
			type: "send_message",
			targetActiveSessionId: targetState.activeSessionId,
			message: "do not defer",
			deliveryMode: "follow_up",
		});

		expect(response).toMatchObject({ data: { deliveryStatus: "queued", deliveryMode: "steer" } });
		expect(acceptAgentMessagePrompt).toHaveBeenCalledWith(
			expect.stringContaining("do not defer"),
			expect.objectContaining({
				streamingBehavior: "steer",
				customMessage: expect.objectContaining({ customType: "agent_message" }),
			}),
		);
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

	it("clears only queued agent-message prompts", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const targetState = makeState("target");
		const clearQueuedAgentMessages = vi.fn(() => ({ steering: ["agent message"], followUp: [] }));
		const clearQueue = vi.fn(() => ({ steering: ["user prompt"], followUp: ["heartbeat"] }));
		targetState.runtime = {
			...targetState.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				isStreaming: false,
				unfinishedActionCount: 2,
				clearQueuedAgentMessages,
				clearQueue,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		await internals.handleCommand(makeClient("client-1", targetState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_clear",
			activeSessionId: targetState.activeSessionId,
		});

		expect(clearQueuedAgentMessages).toHaveBeenCalledOnce();
		expect(clearQueue).not.toHaveBeenCalled();
	});

	it("pause clears queued agent-message prompts from all sessions", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const firstState = makeState("target-1");
		const secondState = makeState("target-2");
		const firstClear = vi.fn(() => ({ steering: [], followUp: ["agent message"] }));
		const secondClear = vi.fn(() => ({ steering: ["agent message"], followUp: [] }));
		for (const [state, clearQueuedAgentMessages] of [
			[firstState, firstClear],
			[secondState, secondClear],
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
			agentMessageRateLimiter: { clear: () => void };
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.agentMessageRateLimiter.clear = vi.fn();
		internals.sessions.set(firstState.activeSessionId, firstState);
		internals.sessions.set(secondState.activeSessionId, secondState);

		await internals.handleCommand(makeClient("client-1", firstState.activeSessionId), {
			id: "command-1",
			type: "agent_messages_pause",
		});

		expect(internals.agentMessageRateLimiter.clear).toHaveBeenCalledOnce();
		expect(firstClear).toHaveBeenCalledOnce();
		expect(secondClear).toHaveBeenCalledOnce();
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

	it("reports accepted in-flight agent messages in agent-message lists", async () => {
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
				unfinishedActionCount: 3,
				hasAcceptedPromptInFlight: true,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageListResult(current: ActiveSessionState): Promise<{
				agents: Array<{ unfinishedActionCount: number }>;
			}>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		expect((await internals.createAgentMessageListResult(targetState)).agents[0]?.unfinishedActionCount).toBe(3);
	});

	it("reports non-streaming busy sessions as active in agent-observe summaries", async () => {
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
			diagnostics: [],
			modelFallbackMessage: undefined,
			session: {
				sessionId: "session-target",
				sessionName: "Target",
				sessionFile: undefined,
				sessionManager: { getCwd: () => "/tmp" },
				model: undefined,
				thinkingLevel: "off",
				isStreaming: false,
				isCompacting: false,
				isBashRunning: false,
				isRetrying: false,
				hasAcceptedPromptInFlight: false,
				unfinishedActionCount: 1,
				isSessionActive: true,
				getSessionActionSnapshot: () => ({ queuedCount: 1, steering: [], followUps: [] }),
				messages: [],
				state: { pendingToolCalls: new Set(), streamingMessage: undefined },
				hasRunningRlmChildren: () => false,
			},
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentObserveListResult(current: ActiveSessionState): Promise<{ current: { status: string } }>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		expect((await internals.createAgentObserveListResult(targetState)).current.status).toBe("busy");

		(targetState.runtime.session as { isCompacting: boolean; unfinishedActionCount: number }).isCompacting = true;
		(targetState.runtime.session as { isCompacting: boolean; unfinishedActionCount: number }).unfinishedActionCount =
			0;

		expect((await internals.createAgentObserveListResult(targetState)).current.status).toBe("compacting");
	});

	it("canonicalizes symlinked family paths before comparison", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-family-paths-"));
		try {
			const realDir = join(tempDir, "real");
			const aliasDir = join(tempDir, "alias");
			mkdirSync(realDir);
			symlinkSync(realDir, aliasDir, "dir");
			const daemon = new AgentDaemon("/tmp/prime-agent-family-paths.sock", {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: vi.fn(),
			});
			const parent = makeState("parent");
			const child = makeState("child", "parent");
			parent.runtime = {
				...parent.runtime,
				metadata: { ...parent.runtime.metadata, kind: "top-level" },
				session: { sessionId: "session-parent", sessionFile: join(realDir, "parent.jsonl") },
			} as never;
			child.runtime = {
				...child.runtime,
				metadata: {
					...child.runtime.metadata,
					parentSessionId: "session-parent",
					parentSessionFile: join(aliasDir, "parent.jsonl"),
				},
				session: { sessionId: "session-child", sessionFile: join(realDir, "child.jsonl") },
			} as never;
			const internals = daemon as unknown as {
				assertAgentFamilyReachable(current: ActiveSessionState, target: ActiveSessionState): void;
			};

			expect(() => internals.assertAgentFamilyReachable(parent, child)).not.toThrow();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
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

	it("uses the persisted header parent after a runtime session replacement", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-applied-family.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const originalParent = makeState("original-parent");
		const persistedParent = makeState("persisted-parent");
		const child = makeState("child");
		originalParent.runtime = {
			...originalParent.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: { sessionId: "session-original", sessionFile: "/tmp/original-parent.jsonl" },
		} as never;
		persistedParent.runtime = {
			...persistedParent.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: { sessionId: "session-persisted", sessionFile: "/tmp/persisted-parent.jsonl" },
		} as never;
		child.runtime = {
			...child.runtime,
			metadata: {
				kind: "subagent",
				createdAt: 1,
				parentSessionId: "session-original",
				parentSessionFile: "/tmp/original-parent.jsonl",
			},
			session: {
				sessionId: "session-child",
				sessionFile: "/tmp/child.jsonl",
				rlmDepth: 1,
				sessionManager: { getHeader: () => ({ parentSession: "/tmp/persisted-parent.jsonl" }) },
			},
		} as never;
		const internals = daemon as unknown as {
			assertAgentFamilyReachable(current: ActiveSessionState, target: ActiveSessionState): void;
		};

		expect(() => internals.assertAgentFamilyReachable(child, persistedParent)).not.toThrow();
		expect(() => internals.assertAgentFamilyReachable(child, originalParent)).toThrow(AGENT_FAMILY_REACH_ERROR);
	});

	it("labels a reopened header-linked child and parent consistently with family reach", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-header-relationship.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const parent = makeState("parent");
		const child = makeState("reopened-child");
		parent.runtime = {
			...parent.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: "session-parent",
				sessionFile: "/tmp/parent.jsonl",
				sessionManager: { getHeader: () => ({ parentSession: undefined }) },
			},
		} as never;
		child.runtime = {
			...child.runtime,
			metadata: { kind: "top-level", createdAt: 1 },
			session: {
				sessionId: "session-child",
				sessionFile: "/tmp/children/child.jsonl",
				rlmDepth: 1,
				sessionManager: { getHeader: () => ({ parentSession: "../parent.jsonl" }) },
			},
		} as never;
		const internals = daemon as unknown as {
			agentMessageRelationship(from: ActiveSessionState, target: ActiveSessionState): string | undefined;
		};

		expect(internals.agentMessageRelationship(child, parent)).toBe("child");
		expect(internals.agentMessageRelationship(parent, child)).toBe("parent");
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

		expect((await observe.listAgents()).agents.map((agent) => agent.activeSessionId)).toEqual([
			"root",
			"child",
			"sibling",
			"grandchild",
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

	it("keeps a session ID ambiguous when a reachable agent uses it as its name", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-family-id-ambiguity.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const parent = makeAgentFamilyState("parent", "parent");
		const observer = makeAgentFamilyState("observer", "observer", parent.state);
		const sibling = makeAgentFamilyState("sibling", parent.state.runtime.session.sessionId, parent.state);
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
			createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
		};
		for (const fixture of [parent, observer, sibling]) {
			internals.sessions.set(fixture.state.activeSessionId, fixture.state);
		}
		const expectedError = `Ambiguous active session "${parent.state.runtime.session.sessionId}"`;

		await expect(
			internals.createAgentObserveController(() => observer.state).getAgent(parent.state.runtime.session.sessionId),
		).rejects.toThrow(expectedError);
		await expect(
			internals
				.createAgentMessageController(() => observer.state)
				.sendAgentMessage({ target: parent.state.runtime.session.sessionId, message: "report progress" }),
		).rejects.toThrow(expectedError);
		expect(parent.acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(sibling.acceptAgentMessagePrompt).not.toHaveBeenCalled();
	});

	it("keeps a duplicate session name ambiguous when two family agents are reachable", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-family-name-ambiguity.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const parent = makeAgentFamilyState("parent", "helper");
		const observer = makeAgentFamilyState("observer", "observer", parent.state);
		const sibling = makeAgentFamilyState("sibling", "helper", parent.state);
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAgentMessageController(
				getCurrentState: () => ActiveSessionState | undefined,
			): AgentSessionMessageController;
			createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
		};
		for (const fixture of [parent, observer, sibling]) {
			internals.sessions.set(fixture.state.activeSessionId, fixture.state);
		}
		const expectedError = 'Ambiguous active session "helper"';

		await expect(internals.createAgentObserveController(() => observer.state).getAgent("helper")).rejects.toThrow(
			expectedError,
		);
		await expect(
			internals
				.createAgentMessageController(() => observer.state)
				.sendAgentMessage({ target: "helper", message: "report progress" }),
		).rejects.toThrow(expectedError);
		expect(parent.acceptAgentMessagePrompt).not.toHaveBeenCalled();
		expect(sibling.acceptAgentMessagePrompt).not.toHaveBeenCalled();
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

	it("rejects agent messages to the sending session", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("self");
		state.runtime = {
			...state.runtime,
			cwd: "/tmp",
			session: {
				sessionId: "session-self",
				sessionName: "Self",
				isStreaming: false,
				unfinishedActionCount: 0,
				prompt: vi.fn(async () => {}),
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
		internals.sessions.set(state.activeSessionId, state);

		await expect(
			internals.sendAgentSessionMessage({
				targetSelector: state.activeSessionId,
				message: "self",
				fromState: state,
				origin: "agent",
			}),
		).rejects.toThrow("Agent messaging cannot target the sending session");
		expect(state.runtime.session.prompt).not.toHaveBeenCalled();
	});

	it("sends dialog extension UI requests only to UI-capable clients", () => {
		const lineClient = makeClient("line-client", "active", false);
		const uiClient = makeClient("ui-client", "active", true);
		const dialogRequest = {
			type: "extension_ui_request",
			activeSessionId: "active",
			id: "request-1",
			method: "confirm",
			payload: {},
		} as const;

		expect(shouldSendDaemonOutboundToClient(lineClient, dialogRequest)).toBe(false);
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(lineClient, {
				...dialogRequest,
				method: "notify",
			}),
		).toBe(true);

		setDaemonClientSessionCapabilities(uiClient, "active", new Set(["extension_ui"]));
		setDaemonClientSessionCapabilities(uiClient, "other", new Set());
		expect(shouldSendDaemonOutboundToClient(uiClient, dialogRequest)).toBe(true);
		expect(
			shouldSendDaemonOutboundToClient(uiClient, {
				...dialogRequest,
				activeSessionId: "other",
			}),
		).toBe(false);
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

	it("clears a scheduled catch-up retry when the client disconnects", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("active");
		state.extensionUiRequests = new Map();
		const socketState = { destroyed: false };
		const socket = Object.assign(new EventEmitter(), {
			get destroyed() {
				return socketState.destroyed;
			},
			write: vi.fn((_data: unknown) => true),
		}) as unknown as Socket;
		const createAttachResult = vi.fn(async () => {
			throw new Error("snapshot creation failed");
		});
		const internals = daemon as unknown as {
			clients: Set<DaemonSocketClient>;
			sessions: Map<string, ActiveSessionState>;
			handleConnection(socket: Socket): void;
			createAttachResult: typeof createAttachResult;
			queueClientCatchup(client: DaemonSocketClient, activeSessionId: string): void;
			catchUpBackpressuredClient(client: DaemonSocketClient): Promise<void>;
		};
		internals.handleConnection(socket);
		const client = [...internals.clients][0]!;
		client.attachedActiveSessionIds.add(state.activeSessionId);
		state.clients.add(client);
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = createAttachResult;
		internals.queueClientCatchup(client, state.activeSessionId);

		await internals.catchUpBackpressuredClient(client);

		expect(client.catchupRetryTimer).toBeDefined();
		socketState.destroyed = true;
		socket.emit("close");
		expect(client.catchupRetryTimer).toBeUndefined();
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(createAttachResult).toHaveBeenCalledOnce();
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

	it("rejects an attach when its session closes during snapshot creation", async () => {
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
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAttachResult: ReturnType<typeof vi.fn>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = vi.fn(async () => {
			await snapshotGate;
			return { activeSessionId: state.activeSessionId, snapshot: {}, lastEventSequence: 0 };
		});

		const attach = internals.handleCommand(client, { type: "attach", activeSessionId: state.activeSessionId });
		await vi.waitFor(() => expect(state.pendingAttaches).toBe(1));
		internals.sessions.delete(state.activeSessionId);
		releaseSnapshot();

		await expect(attach).rejects.toThrow(`Active session ${state.activeSessionId} closed during attach`);
		expect(state.pendingAttaches).toBe(0);
		expect(state.clients).not.toContain(client);
		expect(client.attachedActiveSessionIds).not.toContain(state.activeSessionId);
	});

	it("drops a backpressure catch-up when the client detaches during snapshot creation", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const state = makeState("active");
		const write = vi.fn(() => true);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write } as unknown as Socket;
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
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.createAttachResult = vi.fn(async () => {
			await snapshotGate;
			return result;
		});

		const catchup = internals.drainBackpressuredClientCatchups(client);
		await vi.waitFor(() => expect(internals.createAttachResult).toHaveBeenCalledOnce());
		state.clients.delete(client);
		client.attachedActiveSessionIds.delete(state.activeSessionId);
		releaseSnapshot();
		await catchup;
		expect(write).not.toHaveBeenCalled();
	});

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
				snapshot: { summary: {}, state: {}, messages: [] },
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
					summary: {},
					state: {},
					messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 1), timestamp: 0 }],
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

	it("drains queued catch-up after replacement snapshot preparation outlives its session", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const state = makeState("closing");
		state.eventGeneration = "generation-1";
		const otherState = makeState("queued");
		const client = makeClient("client-1", state.activeSessionId);
		client.transport = "private-framed";
		setDaemonClientSessionCapabilities(client, state.activeSessionId, new Set(["chunked_snapshot"]));
		state.clients.add(client);
		let resolveAttach: (result: DaemonAttachResult) => void = () => {};
		const pendingAttach = new Promise<DaemonAttachResult>((resolve) => {
			resolveAttach = resolve;
		});
		const catchUpBackpressuredClient = vi.fn(async (target: DaemonSocketClient) => {
			target.catchupActiveSessionIds?.clear();
		});
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			createAttachResult: ReturnType<typeof vi.fn>;
			catchUpBackpressuredClient: typeof catchUpBackpressuredClient;
			broadcastToSession(state: ActiveSessionState, message: DaemonOutbound): void;
		};
		internals.sessions.set(state.activeSessionId, state);
		internals.sessions.set(otherState.activeSessionId, otherState);
		internals.createAttachResult = vi.fn(() => pendingAttach);
		internals.catchUpBackpressuredClient = catchUpBackpressuredClient;

		internals.broadcastToSession(state, {
			type: "session_replaced",
			activeSessionId: state.activeSessionId,
			state: {},
			messages: [],
		} as unknown as DaemonOutbound);
		client.catchupActiveSessionIds = new Set([otherState.activeSessionId]);
		internals.sessions.delete(state.activeSessionId);
		resolveAttach({
			activeSessionId: state.activeSessionId,
			snapshot: { summary: {}, state: {}, messages: [] },
			lastEventSequence: 0,
		} as unknown as DaemonAttachResult);

		await vi.waitFor(() => expect(catchUpBackpressuredClient).toHaveBeenCalledWith(client));
		expect(client.snapshotStreaming).toBe(false);
		expect(client.catchupActiveSessionIds).toEqual(new Set());
	});

	it.each([
		["explicit session file", (sessionPath: string) => ({ type: "create" as const, sessionPath })],
		["continue recent", (_sessionPath: string) => ({ type: "create" as const, continueRecent: true })],
	])("deduplicates concurrent creates after resolving the %s", async (_label, commandFor) => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-open-race-"));
		try {
			const recent = SessionManager.create(tempDir, tempDir);
			const sessionPath = recent.materializeSessionFile();
			recent.appendSessionInfo("Recent");
			let releaseCreate: () => void = () => {};
			const createBarrier = new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				await createBarrier;
				return {
					session: makeRuntimeSession(options.sessionManager),
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			const first = create(commandFor(sessionPath));
			const second = create(commandFor(sessionPath));
			// The pre-create session resolution is async (continueRecent scans the
			// session dir); wait on a deadline, not a fixed number of ticks.
			await vi.waitFor(() => {
				expect(createRuntime).toHaveBeenCalledTimes(1);
			});
			releaseCreate();
			const [firstState, secondState] = await Promise.all([first, second]);
			expect(secondState).toBe(firstState);
			expect(firstState.runtime.session.sessionFile).toBe(sessionPath);
			expect(createRuntime).toHaveBeenCalledTimes(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("adopts client env on session reuse only when the session has none", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-env-"));
		try {
			const sessionPath = join(tempDir, "session.jsonl");
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				return {
					session: makeRuntimeSession(options.sessionManager),
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			// Created env-less (e.g. by a cron job), then opened by an env-carrying
			// client: the session adopts the client's allowlisted identity.
			const state = await create({ type: "create", sessionPath });
			expect(state.clientEnv).toBeUndefined();
			const adopted = await create({
				type: "create",
				sessionPath,
				env: { HERDR_PANE_ID: "w1:p1", PATH: "/evil" },
			});
			expect(adopted).toBe(state);
			expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });

			// A later client with a different env must not rebind the identity
			// that extensions already captured.
			await create({ type: "create", sessionPath, env: { HERDR_PANE_ID: "w2:p9" } });
			expect(state.clientEnv).toEqual({ HERDR_PANE_ID: "w1:p1" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses the binding session as its own list and roster context", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-controller-race-"));
		try {
			let listedAgentsDuringBind = 0;
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					const controller = options.sessionOptions?.agentMessageController;
					const result = await controller?.listAgents();
					expect(result?.current?.activeSessionId).toBeTruthy();
					await expect(controller?.roster?.()).resolves.toMatchObject({
						current: { id: session.sessionId },
					});
					listedAgentsDuringBind++;
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const create = (
				daemon as unknown as {
					createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				}
			).createRuntime.bind(daemon);

			await create({ type: "create", sessionPath: join(tempDir, "session-1.jsonl") });
			await create({ type: "create", sessionPath: join(tempDir, "session-2.jsonl") });

			expect(listedAgentsDuringBind).toBe(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("restores a completed subagent through its parent when an RLM heartbeat becomes due", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-restore-subagent-heartbeat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "active" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}

			const childId = "heartbeat-child";
			const childSessionDir = join(parentArtifactDir, childId);
			const childManager = SessionManager.create(tempDir, childSessionDir);
			childManager.newSession({ parentSession: parentSessionFile });
			childManager.appendSessionInfo("heartbeat-child");
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}
			writeFileSync(
				join(parentArtifactDir, "rlm-subagents.jsonl"),
				`${JSON.stringify({
					type: "rlm_subagent",
					childId,
					sessionName: "heartbeat-child",
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
				})}\n`,
			);

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
				cronStore: AgentCronJobStore;
				getOrCreateCronJobSession(job: AgentCronJob, requirePersistedJob: boolean): Promise<ActiveSessionState>;
			};
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childManager.getSessionId(),
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			const childState = await internals.getOrCreateCronJobSession(heartbeat, true);

			expect(childState.runtime.metadata).toMatchObject({
				kind: "subagent",
				rlmChildId: childId,
			});
			expect(createRuntime).toHaveBeenCalledTimes(2);
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				activeSessionId: childState.activeSessionId,
				sessionId: childManager.getSessionId(),
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("replaces a resident top-level RLM child when restoring its heartbeat", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-replace-child-heartbeat-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentManager = SessionManager.open(fixture.parentSessionFile);
			parentManager.appendSessionState({ status: "active" });
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrCreateCronJobSession(
					job: AgentCronJob,
					requirePersistedJob: boolean,
				): Promise<ActiveSessionState | undefined>;
			};
			const topLevelState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
			});
			expect(topLevelState.runtime.metadata.kind).toBe("top-level");
			const topLevelAbort = topLevelState.runtime.session.abort as ReturnType<typeof vi.fn>;
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: topLevelState.runtime.session.sessionId,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			const childState = await internals.getOrCreateCronJobSession(heartbeat, true);

			expect(childState).toBeDefined();
			expect(childState).not.toBe(topLevelState);
			expect(childState?.runtime.metadata).toMatchObject({
				kind: "subagent",
				rlmChildId: fixture.childId,
			});
			expect(topLevelAbort).toHaveBeenCalledOnce();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
				activeSessionId: childState?.activeSessionId,
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels an RLM heartbeat for a resident top-level session that is not a registered child", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-nonchild-heartbeat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "active" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}
			const sessionManager = SessionManager.create(tempDir, join(parentArtifactDir, "unregistered-child"));
			sessionManager.newSession({ parentSession: parentSessionFile });
			sessionManager.appendSessionState({ status: "active" });
			const sessionFile = sessionManager.getSessionFile();
			if (!sessionFile) {
				throw new Error("Missing session file");
			}
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
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrCreateCronJobSession(
					job: AgentCronJob,
					requirePersistedJob: boolean,
				): Promise<ActiveSessionState | undefined>;
			};
			const topLevelState = await internals.createRuntime({ type: "create", sessionPath: sessionFile });
			const abort = topLevelState.runtime.session.abort as ReturnType<typeof vi.fn>;
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: topLevelState.activeSessionId,
				sessionId: sessionManager.getSessionId(),
				sessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			await expect(internals.getOrCreateCronJobSession(heartbeat, true)).resolves.toBeUndefined();
			expect(abort).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
			expect(createRuntime).toHaveBeenCalledTimes(2);
			expect(createRuntime.mock.calls[1]?.[0].sessionManager.getSessionFile()).toBe(parentSessionFile);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("waits for a concurrently hydrating heartbeat child to finish binding", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-hydration-race-"));
		let releasePassiveList!: () => void;
		const passiveListGate = new Promise<void>((resolve) => {
			releasePassiveList = resolve;
		});
		let markPassiveListStarted!: () => void;
		const passiveListStarted = new Promise<void>((resolve) => {
			markPassiveListStarted = resolve;
		});
		let releaseBinding!: () => void;
		const bindingGate = new Promise<void>((resolve) => {
			releaseBinding = resolve;
		});
		let markBindingStarted!: () => void;
		const bindingStarted = new Promise<void>((resolve) => {
			markBindingStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childBindingStarted: markBindingStarted,
				childBindingGate: bindingGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<unknown[]>;
				restoreRlmHeartbeatSession(job: AgentCronJob): Promise<ActiveSessionState | undefined>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childInfo.id,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			const listPassive = internals.listPassiveRlmSubagents.bind(fixture.daemon);
			let blockNextList = true;
			internals.listPassiveRlmSubagents = vi.fn(async () => {
				if (blockNextList) {
					blockNextList = false;
					markPassiveListStarted();
					await passiveListGate;
				}
				return listPassive();
			});

			let restored = false;
			const restoration = internals.restoreRlmHeartbeatSession(heartbeat).then((state) => {
				restored = true;
				return state;
			});
			await passiveListStarted;
			const hydration = internals.getOrHydrateBoundSessionState(fixture.childId);
			await bindingStarted;
			releasePassiveList();
			await Promise.resolve();
			expect(restored).toBe(false);
			releaseBinding();

			const [restoredState, hydratedState] = await Promise.all([restoration, hydration]);
			expect(restoredState).toBe(hydratedState);
		} finally {
			releasePassiveList();
			releaseBinding();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels a detached subagent heartbeat when its parent is archived", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-archived-subagent-heartbeat-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const parentManager = SessionManager.create(tempDir, sessionDir);
			parentManager.newSession();
			parentManager.appendSessionState({ status: "archived" });
			const parentSessionFile = parentManager.getSessionFile();
			const parentArtifactDir = parentManager.getSessionArtifactDir();
			if (!parentSessionFile || !parentArtifactDir) {
				throw new Error("Missing parent session paths");
			}
			const childManager = SessionManager.create(tempDir, join(parentArtifactDir, "child-1"));
			childManager.newSession({ parentSession: parentSessionFile });
			const childSessionFile = childManager.getSessionFile();
			if (!childSessionFile) {
				throw new Error("Missing child session file");
			}

			const createRuntime = vi.fn(async () => {
				throw new Error("archived parent must not be restored");
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				getOrCreateCronJobSession(
					job: AgentCronJob,
					requirePersistedJob: boolean,
				): Promise<ActiveSessionState | undefined>;
			};
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childManager.getSessionId(),
				sessionFile: childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "report exactly: hi",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});

			await expect(internals.getOrCreateCronJobSession(heartbeat, true)).resolves.toBeUndefined();
			expect(createRuntime).not.toHaveBeenCalled();
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

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
			const observeController = (
				fixture.daemon as unknown as {
					createAgentObserveController(getCurrentState: () => ActiveSessionState): AgentObserveController;
				}
			).createAgentObserveController(() => parentState);
			const observedAgents = await observeController.listAgents();
			expect(observedAgents.agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: expect.any(String),
					sessionName: "renamed-worker",
					runtimeKind: "subagent",
					status: "idle",
					messageCount: 1,
					rlmChildId: fixture.childId,
				}),
			);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();

			const messageController = internals.createAgentMessageController(() => parentState);
			await expect(messageController.roster?.()).resolves.toMatchObject({
				current: { id: parentState.runtime.session.sessionId, depth: 0 },
				entries: [
					expect.objectContaining({ relationship: "child", name: "renamed-worker", depth: 1, status: "inactive" }),
				],
			});
			await expect(
				messageController.assertSessionNameAvailable?.({
					name: "renamed-worker",
					depth: 1,
					parentSessionId: parentState.runtime.session.sessionId,
					parentSessionPath: fixture.parentSessionFile,
				}),
			).rejects.toThrow("an agent of that name already exists at depth 1 under this parent");
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

	it("prefers registry depth when listing a passive legacy child", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passive-legacy-depth-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const parentManager = SessionManager.open(fixture.parentSessionFile);
			parentManager.appendMessage({ role: "user", content: "parent task", timestamp: 0 });
			parentManager.flushNow();
			const lines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
			delete header.rlmDepth;
			lines[0] = JSON.stringify(header);
			writeFileSync(fixture.childSessionFile, lines.join("\n"));
			const registryFile = join(fixture.parentArtifactDir, "rlm-subagents.jsonl");
			const registryEntry = JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, unknown>;
			registryEntry.rlmDepth = 5;
			registryEntry.rlmMaxDepth = 8;
			writeFileSync(registryFile, `${JSON.stringify(registryEntry)}\n`);
			const parentInfo = await readSessionInfo(fixture.parentSessionFile);
			if (!parentInfo) throw new Error("Missing parent session info");
			const internals = fixture.daemon as unknown as {
				buildSessionListWithPassiveRlmSubagents(
					activeSessions: ActiveSessionState[],
					savedSessions: SessionInfo[],
					scheduledJobs: AgentCronJob[],
				): Promise<SessionSummary[]>;
			};

			const sessions = await internals.buildSessionListWithPassiveRlmSubagents([], [parentInfo], []);
			expect(sessions.find((session) => session.sessionFile === fixture.childSessionFile)?.rlmDepth).toBe(5);
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

	it("bounds snapshot stabilization when every child build replaces the runtime session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-snapshot-stabilization-bound-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSessionSnapshot(state: ActiveSessionState): Promise<DaemonAttachResult["snapshot"]>;
				createConnectionState: ReturnType<typeof vi.fn>;
				buildRlmChildSnapshotsWithPassiveRlmSubagents: ReturnType<typeof vi.fn>;
			};
			const state = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			internals.createConnectionState = vi.fn(() => ({}));
			let calls = 0;
			internals.buildRlmChildSnapshotsWithPassiveRlmSubagents = vi.fn(async () => {
				calls++;
				const replacementSession = Object.create(state.runtime.session) as typeof state.runtime.session;
				Object.defineProperties(replacementSession, {
					messages: {
						value: [{ role: "user", content: `transcript ${calls}`, timestamp: calls }],
					},
					sessionId: { value: `session-${calls}` },
				});
				(state.runtime as unknown as { _session: typeof replacementSession })._session = replacementSession;
				return [{ id: `child-${calls}`, status: "done", sessionDir: tempDir }];
			});

			await expect(internals.createSessionSnapshot(state)).resolves.toMatchObject({
				children: [expect.objectContaining({ id: "child-4" })],
				messages: [{ content: "transcript 4" }],
				summary: { sessionId: "session-4" },
			});
			expect(internals.buildRlmChildSnapshotsWithPassiveRlmSubagents).toHaveBeenCalledTimes(4);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("validates a requested passive child name before hydration", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passive-name-preflight-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				assertFamilySessionNameAvailable: ReturnType<typeof vi.fn>;
				hydratePassiveRlmSubagent: ReturnType<typeof vi.fn>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const nameError = new Error("sibling name collision");
			internals.assertFamilySessionNameAvailable = vi.fn(async () => {
				throw nameError;
			});
			internals.hydratePassiveRlmSubagent = vi.fn();

			await expect(
				internals.createRuntime({
					type: "create",
					sessionPath: fixture.childSessionFile,
					name: "  sibling  ",
				}),
			).rejects.toBe(nameError);
			expect(internals.assertFamilySessionNameAvailable).toHaveBeenCalledWith({
				name: "sibling",
				depth: 1,
				parentSessionId: parentState.runtime.session.sessionId,
				parentSessionPath: fixture.parentSessionFile,
				ignoreSessionId: expect.any(String),
			});
			expect(internals.hydratePassiveRlmSubagent).not.toHaveBeenCalled();
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
			expect([...internals.sessions.values()]).toEqual([parentState]);
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

	it("rehydrates a legacy child with depth inferred from its session file path", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-legacy-rlm-depth-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const lines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const header = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
			delete header.rlmDepth;
			lines[0] = JSON.stringify(header);
			writeFileSync(fixture.childSessionFile, lines.join("\n"));
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			await internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: "renamed-worker", message: "report progress" });

			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionOptions?.rlmDepth).toBe(1);
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

	it("rehydrates a legacy passive subagent at depth one", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-legacy-rlm-depth-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const childLines = readFileSync(fixture.childSessionFile, "utf8").split("\n");
			const childHeader = JSON.parse(childLines[0] ?? "{}") as Record<string, unknown>;
			delete childHeader.rlmDepth;
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

			expect(fixture.createRuntime.mock.calls[1]?.[0].sessionOptions?.rlmDepth).toBe(1);
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

	it("hydrates a passive child when agent_observe reads it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-observe-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentObserveController(getCurrentState: () => ActiveSessionState | undefined): AgentObserveController;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const controller = internals.createAgentObserveController(() => parentState);

			await expect(controller.getAgent("renamed-worker")).resolves.toMatchObject({
				agent: { runtimeKind: "subagent", sessionName: "renamed-worker" },
			});
			await expect(controller.recentMessages({ target: "renamed-worker" })).resolves.toMatchObject({
				agent: { runtimeKind: "subagent" },
				messages: [],
			});
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
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

	it("loads a passive child under the create command client env", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-passive-create-env-"));
		const inheritedPaneId = process.env.HERDR_PANE_ID;
		delete process.env.HERDR_PANE_ID;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const envAtRuntimeCreation: Array<string | undefined> = [];
			const createRuntime = fixture.createRuntime.getMockImplementation();
			if (!createRuntime) throw new Error("Missing fixture runtime factory");
			fixture.createRuntime.mockImplementation(async (runtimeOptions) => {
				envAtRuntimeCreation.push(process.env.HERDR_PANE_ID);
				return createRuntime(runtimeOptions);
			});
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			expect(parentState.clientEnv).toBeUndefined();

			const childState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
				env: { HERDR_PANE_ID: "pane-42" },
			});

			expect(envAtRuntimeCreation).toEqual([undefined, "pane-42"]);
			expect(parentState.clientEnv).toEqual({ HERDR_PANE_ID: "pane-42" });
			expect(childState.clientEnv).toEqual({ HERDR_PANE_ID: "pane-42" });
		} finally {
			if (inheritedPaneId === undefined) delete process.env.HERDR_PANE_ID;
			else process.env.HERDR_PANE_ID = inheritedPaneId;
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not adopt a failed passive opener env on the root parent", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-failed-passive-env-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const createRuntime = fixture.createRuntime.getMockImplementation();
			if (!createRuntime) throw new Error("Missing fixture runtime factory");
			let failHydration = true;
			const childEnvAtRuntimeCreation: Array<string | undefined> = [];
			fixture.createRuntime.mockImplementation(async (runtimeOptions) => {
				if (runtimeOptions.sessionManager.getSessionFile() === fixture.childSessionFile) {
					childEnvAtRuntimeCreation.push(process.env.HERDR_PANE_ID);
					if (failHydration) {
						failHydration = false;
						throw new Error("hydration failed");
					}
				}
				return createRuntime(runtimeOptions);
			});

			await expect(
				internals.createRuntime({
					type: "create",
					sessionPath: fixture.childSessionFile,
					env: { HERDR_PANE_ID: "failed-pane" },
				}),
			).rejects.toThrow("hydration failed");
			expect(parentState.clientEnv).toBeUndefined();

			const childState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
				env: { HERDR_PANE_ID: "successful-pane" },
			});
			expect(childEnvAtRuntimeCreation).toEqual(["failed-pane", "successful-pane"]);
			expect(parentState.clientEnv).toEqual({ HERDR_PANE_ID: "successful-pane" });
			expect(childState.clientEnv).toEqual({ HERDR_PANE_ID: "successful-pane" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("joins binding when advertised session ID resolution races passive hydration", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-resolve-race-"));
		let releasePassiveList!: () => void;
		const passiveListGate = new Promise<void>((resolve) => {
			releasePassiveList = resolve;
		});
		let releaseBinding!: () => void;
		const bindingGate = new Promise<void>((resolve) => {
			releaseBinding = resolve;
		});
		let markBindingStarted!: () => void;
		const bindingStarted = new Promise<void>((resolve) => {
			markBindingStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childBindingStarted: markBindingStarted,
				childBindingGate: bindingGate,
			});
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				listPassiveRlmSubagents(): Promise<unknown[]>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const listPassive = internals.listPassiveRlmSubagents.bind(fixture.daemon);
			let blockNextList = true;
			internals.listPassiveRlmSubagents = vi.fn(async () => {
				if (blockNextList) {
					blockNextList = false;
					await passiveListGate;
				}
				return listPassive();
			});

			let advertisedResolved = false;
			const advertisedLookup = internals.getOrHydrateBoundSessionState(childInfo.id).then((state) => {
				advertisedResolved = true;
				return state;
			});
			await Promise.resolve();
			const hydration = internals.getOrHydrateBoundSessionState(fixture.childId);
			await bindingStarted;
			releasePassiveList();
			await Promise.resolve();
			expect(advertisedResolved).toBe(false);
			releaseBinding();

			const hydrated = await hydration;
			await expect(advertisedLookup).resolves.toBe(hydrated);
		} finally {
			releasePassiveList();
			releaseBinding();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("rejects an ambiguous live selector before consulting passive children", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-ambiguous-passive-selector-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			for (const id of ["live-one", "live-two"]) {
				const state = makeState(id);
				Object.assign(state.runtime, {
					session: { sessionId: `${id}-session`, sessionName: "renamed-worker" },
					metadata: { kind: "root", createdAt: 1 },
				});
				internals.sessions.set(id, state);
			}

			await expect(internals.getOrHydrateBoundSessionState("renamed-worker")).rejects.toThrow(
				'Ambiguous active session "renamed-worker"',
			);
			expect(fixture.createRuntime).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("leaves passive hydration resident when its runtime-open guard is cancelled", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-guarded-hydration-"));
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
				childRuntimeStarted: markHydrationStarted,
				childRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getRunnableCronJob(id: string): AgentCronJob | undefined;
				runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSession.releaseRlmChildSession = vi.fn(() => vi.fn());
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childInfo.id,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "must not run",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			let runnable = true;
			internals.getRunnableCronJob = vi.fn(() => (runnable ? heartbeat : undefined));

			const run = internals.runCronJob(heartbeat);
			await hydrationStarted;
			runnable = false;
			releaseHydration();

			await expect(run).resolves.toBe("skipped");
			internals.cronStore.cancel(heartbeat.id);
			const childState = [...internals.sessions.values()].find(
				(state) => state.runtime.metadata.rlmChildId === fixture.childId,
			);
			expect(childState).toBeDefined();
			expect(fixture.runtimeSessions[1]?.disposeAsync).not.toHaveBeenCalled();
			expect(parentSession.releaseRlmChildSession).not.toHaveBeenCalled();

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(1);
			expect(internals.sessions.has(childState!.activeSessionId)).toBe(false);
			expect(fixture.runtimeSessions[1]?.disposeAsync).toHaveBeenCalledOnce();
			expect(parentSession.releaseRlmChildSession).toHaveBeenCalledWith(
				fixture.childId,
				childState!.runtime.session,
			);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an attach-owned passive hydration usable when a joining heartbeat is cancelled", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-shared-guarded-hydration-"));
		let releaseHydration!: () => void;
		const hydrationGate = new Promise<void>((resolve) => {
			releaseHydration = resolve;
		});
		let markHydrationStarted!: () => void;
		const hydrationStarted = new Promise<void>((resolve) => {
			markHydrationStarted = resolve;
		});
		let markHeartbeatJoinStarted!: () => void;
		const heartbeatJoinStarted = new Promise<void>((resolve) => {
			markHeartbeatJoinStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childRuntimeStarted: markHydrationStarted,
				childRuntimeGate: hydrationGate,
			});
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createAgentMessageController(
					getCurrentState: () => ActiveSessionState | undefined,
				): AgentSessionMessageController;
				getRunnableCronJob(id: string): AgentCronJob | undefined;
				runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const parentSession = parentState.runtime.session as unknown as {
				releaseRlmChildSession: ReturnType<typeof vi.fn>;
				registerRlmChildSession: ReturnType<typeof vi.fn>;
			};
			parentSession.releaseRlmChildSession = vi.fn(() => vi.fn());
			const childInfo = await readSessionInfo(fixture.childSessionFile);
			if (!childInfo) throw new Error("Missing child session info");
			const heartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: "stale-child-active-id",
				sessionId: childInfo.id,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				runtimeKind: "subagent",
				scheduleText: "every 30s",
				prompt: "must not run",
				now: new Date("2026-01-01T00:00:00.000Z"),
			});
			let runnable = true;
			internals.getRunnableCronJob = vi.fn(() => (runnable ? heartbeat : undefined));

			const attach = internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			await hydrationStarted;
			const hydratePassive = internals.hydratePassiveRlmSubagent.bind(fixture.daemon);
			internals.hydratePassiveRlmSubagent = vi.fn(async (passive) => {
				markHeartbeatJoinStarted();
				return hydratePassive(passive);
			});
			const run = internals.runCronJob(heartbeat);
			await heartbeatJoinStarted;
			runnable = false;
			releaseHydration();

			const attachedState = await attach;
			await expect(run).resolves.toBe("skipped");
			expect(internals.sessions.get(attachedState.activeSessionId)).toBe(attachedState);
			expect(fixture.runtimeSessions[1]?.disposeAsync).not.toHaveBeenCalled();
			expect(parentSession.releaseRlmChildSession).not.toHaveBeenCalled();
			expect(parentSession.registerRlmChildSession).toHaveBeenCalledWith(
				fixture.childId,
				attachedState.runtime.session,
			);

			await expect(
				internals
					.createAgentMessageController(() => parentState)
					.sendAgentMessage({ target: fixture.childId, message: "still usable" }),
			).resolves.toMatchObject({ deliveryStatus: "delivered", target: { runtimeKind: "subagent" } });
			expect(fixture.acceptAgentMessagePrompt).toHaveBeenCalledWith(
				expect.stringContaining("still usable"),
				expect.any(Object),
			);
		} finally {
			releaseHydration();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("repairs a wrong-kind pending open while preserving the passive row id", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-wrong-kind-open-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				openingSessions: Map<string, Promise<ActiveSessionState>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = (await internals.findPassiveRlmSubagent(fixture.childId)) as { info: { id: string } };
			const wrongState = makeState("wrong-kind");
			Object.assign(wrongState, { extensionUiRequests: new Map(), eventGeneration: "wrong", lastEventSequence: 0 });
			Object.assign(wrongState.runtime, {
				dispose: vi.fn(async () => {}),
				metadata: { kind: "root", createdAt: 1 },
				session: makeRuntimeSession(SessionManager.open(fixture.childSessionFile, fixture.childSessionDir)),
			});
			internals.sessions.set(wrongState.activeSessionId, wrongState);
			internals.openingSessions.set(resolve(fixture.childSessionFile), Promise.resolve(wrongState));

			const childState = await internals.hydratePassiveRlmSubagent(passive);

			expect(childState.activeSessionId).toBe(passive.info.id);
			expect(childState.runtime.metadata).toMatchObject({ kind: "subagent", rlmChildId: fixture.childId });
			expect(internals.sessions.has(wrongState.activeSessionId)).toBe(false);
		} finally {
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

	it("returns a resident target when a concurrent opener wins a parent-change restart", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-parent-change-open-race-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				openingSessions: Map<string, Promise<ActiveSessionState>>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<unknown>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
				rehydrateCompletedRlmSubagent(
					parent: ActiveSessionState,
					entry: { childId: string; sessionFile: string },
				): Promise<ActiveSessionState>;
				waitForPassivation(sessionFile: string): Promise<void>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = await internals.findPassiveRlmSubagent(fixture.grandchildId);
			if (!passive) throw new Error("Missing passive grandchild");
			const staleParent = makeState("stale-parent", rootState.activeSessionId);
			Object.assign(staleParent.runtime, { session: { sessionFile: fixture.childSessionFile } });
			const residentGrandchild = makeState("resident-grandchild", staleParent.activeSessionId);
			Object.assign(residentGrandchild.runtime, {
				metadata: {
					kind: "subagent",
					createdAt: 1,
					parentActiveSessionId: staleParent.activeSessionId,
					rlmChildId: fixture.grandchildId,
				},
				session: { sessionFile: fixture.grandchildSessionFile },
			});
			let hydrationAttempts = 0;
			internals.rehydrateCompletedRlmSubagent = vi.fn(async () => {
				if (++hydrationAttempts === 1) {
					internals.sessions.set(staleParent.activeSessionId, staleParent);
					return staleParent;
				}
				return residentGrandchild;
			});
			const findPassiveRlmSubagent = internals.findPassiveRlmSubagent.bind(fixture.daemon);
			internals.findPassiveRlmSubagent = vi.fn(async (id: string) => {
				if (id === fixture.grandchildSessionFile) return passive;
				return findPassiveRlmSubagent(id);
			});
			internals.waitForPassivation = vi.fn(async (sessionFile) => {
				if (sessionFile !== fixture.grandchildSessionFile) return;
				internals.sessions.delete(staleParent.activeSessionId);
				internals.sessions.set(residentGrandchild.activeSessionId, residentGrandchild);
				internals.openingSessions.set(resolve(fixture.grandchildSessionFile), Promise.resolve(residentGrandchild));
			});

			await expect(internals.hydratePassiveRlmSubagent(passive)).resolves.toBe(residentGrandchild);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("re-walks the passive chain when an intermediate parent passivates between entries", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-chain-parent-passivation-race-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				findPassiveRlmSubagent(id: string): Promise<
					| {
							rootParentState: ActiveSessionState;
							entry: { childId: string; sessionFile: string };
							chain: Array<{ childId: string; sessionFile: string }>;
					  }
					| undefined
				>;
				hydratePassiveRlmSubagent(passive: unknown): Promise<ActiveSessionState>;
				waitForPassivation(sessionFile: string): Promise<void>;
				rehydrateCompletedRlmSubagent(
					parent: ActiveSessionState,
					entry: { childId: string; sessionFile: string },
				): Promise<ActiveSessionState>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const passive = await internals.findPassiveRlmSubagent(fixture.grandchildId);
			if (!passive) throw new Error("Missing passive grandchild");

			const staleParent = makeState("stale-parent", rootState.activeSessionId);
			const refreshedParent = makeState("refreshed-parent", rootState.activeSessionId);
			const grandchild = makeState("rehydrated-grandchild", refreshedParent.activeSessionId);
			for (const [state, sessionFile] of [
				[staleParent, fixture.childSessionFile],
				[refreshedParent, fixture.childSessionFile],
				[grandchild, fixture.grandchildSessionFile],
			] as const) {
				Object.assign(state.runtime, { session: { sessionFile } });
			}

			let childHydrations = 0;
			internals.rehydrateCompletedRlmSubagent = vi.fn(async (_parent, entry) => {
				const hydrated =
					entry.childId === fixture.childId
						? ++childHydrations === 1
							? staleParent
							: refreshedParent
						: grandchild;
				internals.sessions.set(hydrated.activeSessionId, hydrated);
				return hydrated;
			});
			let grandchildWaits = 0;
			internals.waitForPassivation = vi.fn(async (sessionFile) => {
				if (sessionFile === fixture.grandchildSessionFile && ++grandchildWaits === 1) {
					internals.sessions.delete(staleParent.activeSessionId);
				}
			});
			internals.findPassiveRlmSubagent = vi.fn(async () => passive);

			await expect(internals.hydratePassiveRlmSubagent(passive)).resolves.toBe(grandchild);
			expect(childHydrations).toBe(2);
			expect(internals.rehydrateCompletedRlmSubagent).toHaveBeenCalledWith(
				refreshedParent,
				passive.entry,
				expect.anything(),
				undefined,
			);
			expect(internals.rehydrateCompletedRlmSubagent).not.toHaveBeenCalledWith(
				staleParent,
				passive.entry,
				expect.anything(),
				undefined,
			);
		} finally {
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

	it("rehydrates a passivated parent before publishing its racing child", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-parent-passivation-race-"));
		let releaseParentDispose!: () => void;
		const parentDisposeGate = new Promise<void>((resolve) => {
			releaseParentDispose = resolve;
		});
		let markParentDisposeStarted!: () => void;
		const parentDisposeStarted = new Promise<void>((resolve) => {
			markParentDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childDisposeStarted: markParentDisposeStarted,
				childDisposeGate: parentDisposeGate,
			});
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				getOrHydrateBoundSessionState(id: string): Promise<ActiveSessionState>;
				passivateIdleChildren(threshold: number, now: number, limit: number): Promise<number>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			(
				rootState.runtime.session as unknown as { releaseRlmChildSession: ReturnType<typeof vi.fn> }
			).releaseRlmChildSession = vi.fn(() => vi.fn());

			const passivation = internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1);
			await parentDisposeStarted;
			const hydration = internals.getOrHydrateBoundSessionState(fixture.grandchildId);
			let hydrationSettled = false;
			void hydration.finally(() => {
				hydrationSettled = true;
			});
			await Promise.resolve();
			expect(hydrationSettled).toBe(false);
			releaseParentDispose();

			await expect(passivation).resolves.toBe(1);
			const grandchildState = await hydration;
			const reboundParentId = grandchildState.runtime.metadata.parentActiveSessionId;
			expect(internals.sessions.has(parentState.activeSessionId)).toBe(false);
			expect(reboundParentId).toBeDefined();
			expect(internals.sessions.has(reboundParentId!)).toBe(true);
			expect(grandchildState.runtime.metadata.rlmChildId).toBe(fixture.grandchildId);
		} finally {
			releaseParentDispose();
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
			hasRegisteredHeartbeat: false,
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

	it("keeps an idle child resident while an agent message waits for admission", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-admission-passivation-race-"));
		let releaseAdmission!: () => void;
		const admissionGate = new Promise<void>((resolve) => {
			releaseAdmission = resolve;
		});
		let markAdmissionStarted!: () => void;
		const admissionStarted = new Promise<void>((resolve) => {
			markAdmissionStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir, {
				childAdmissionStarted: markAdmissionStarted,
				childAdmissionGate: admissionGate,
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

			const delivery = internals
				.createAgentMessageController(() => parentState)
				.sendAgentMessage({ target: fixture.childId, message: "admit after gate" });
			await admissionStarted;

			await expect(internals.passivateIdleChildren(90, Date.parse("2036-08-01T12:00:00Z"), 1)).resolves.toBe(0);
			expect(internals.sessions.get(childState.activeSessionId)).toBe(childState);
			releaseAdmission();
			await expect(delivery).resolves.toMatchObject({ deliveryStatus: "delivered" });
		} finally {
			releaseAdmission();
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

	it("hydrates a passive child when it is opened from its saved-session row", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-open-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			const childState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.childSessionFile,
				name: "explicit-new-name",
				env: { HERDR_PANE_ID: "pane-42" },
			});

			expect(childState.runtime.metadata).toMatchObject({ kind: "subagent", rlmChildId: fixture.childId });
			expect(childState.runtime.session.sessionName).toBe("explicit-new-name");
			expect(childState.clientEnv).toEqual({ HERDR_PANE_ID: "pane-42" });
			expect(fixture.createRuntime).toHaveBeenCalledTimes(2);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a passive child row id when attach hydrates it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-lazy-rlm-attach-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: fixture.parentSessionFile,
			});
			const client = makeClient("client-1", parentState.activeSessionId);
			client.socket.write = vi.fn(() => true);
			const listResponse = (await internals.handleCommand(client, { type: "list" })) as {
				data: { sessions: SessionSummary[] };
			};
			const passiveRow = listResponse.data.sessions.find(
				(session) => session.sessionFile === fixture.childSessionFile,
			);
			if (!passiveRow) throw new Error("Missing passive child row");
			expect(passiveRow.activeSessionId).toBeUndefined();

			const attachResponse = (await internals.handleCommand(client, {
				type: "attach",
				activeSessionId: passiveRow.id,
			})) as { data: DaemonAttachResult };

			expect(attachResponse.data.activeSessionId).toBe(passiveRow.id);
			expect(internals.sessions.get(passiveRow.id)?.activeSessionId).toBe(passiveRow.id);
			expect(client.attachedActiveSessionIds).toContain(passiveRow.id);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps cancel pure when a retained or unknown child has no active run", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-rlm-cancel-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const parentSession = parentState.runtime.session as unknown as {
				cancelRlmChildRun: ReturnType<typeof vi.fn>;
				deleteRlmSubagent: ReturnType<typeof vi.fn>;
			};
			parentSession.cancelRlmChildRun = vi.fn(() => false);
			parentSession.deleteRlmSubagent = vi.fn();

			for (const childId of [fixture.childId, "unknown-child"]) {
				const result = (await internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
					type: "cancel_rlm_child",
					activeSessionId: parentState.activeSessionId,
					childId,
				})) as { data: { cancelled: boolean } };
				expect(result.data.cancelled).toBe(false);
			}
			expect(parentSession.deleteRlmSubagent).not.toHaveBeenCalled();
		} finally {
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

	it("refuses to delete a busy nested resident child through the root session", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-nested-rlm-delete-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const rootState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const nestedState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			const nestedSession = nestedState.runtime.session;
			nestedState.runtime = {
				...nestedState.runtime,
				metadata: {
					...nestedState.runtime.metadata,
					parentActiveSessionId: "intermediate-active",
				},
				session: nestedSession,
			} as ActiveSessionState["runtime"];
			Object.defineProperty(nestedState.runtime.session, "isStreaming", { get: () => true });
			Object.defineProperty(nestedState.runtime.session, "unfinishedActionCount", { get: () => 0 });
			const rootSession = rootState.runtime.session as unknown as {
				deleteInactiveRlmSubagent: ReturnType<typeof vi.fn>;
			};
			const deleteSpy = vi.fn(async () => "deleted" as const);
			rootSession.deleteInactiveRlmSubagent = deleteSpy;

			const result = (await internals.handleCommand(makeClient("client-1", rootState.activeSessionId), {
				type: "delete_rlm_subagent",
				activeSessionId: rootState.activeSessionId,
				childId: fixture.childId,
			})) as { data: { deleted: boolean; reason?: string } };

			expect(result.data).toEqual({ deleted: false, reason: "running" });
			expect(deleteSpy).not.toHaveBeenCalled();
			expect(internals.sessions.get(nestedState.activeSessionId)).toBe(nestedState);
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

	// chmod-based read-only dirs don't block root, so skip when running as uid 0.
	it.skipIf(process.getuid?.() === 0)("does not fail a deletion when the artifact dir cannot be removed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-artifact-rm-failure-"));
		let lockedRoot: string | undefined;
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const nestedArtifactsRoot = resolve(fixture.childArtifactDir, "..");
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			chmodSync(nestedArtifactsRoot, 0o555);
			lockedRoot = nestedArtifactsRoot;

			// Cache cleanup is best-effort: the rm failure must not surface.
			await internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId);

			expect(existsSync(fixture.childArtifactDir)).toBe(true);
			// Both tombstones are still durable.
			const display = JSON.parse(readFileSync(join(fixture.childSessionDir, "rlm-subagent.json"), "utf8")) as {
				status: string;
			};
			expect(display).toMatchObject({ status: "deleted" });
			const ledgerFile = readdirSync(join(tempDir, "rlm-ledger")).find((name) => name.endsWith(".jsonl"));
			if (!ledgerFile) throw new Error("Missing RLM ledger file");
			const ledgerOps = readFileSync(join(tempDir, "rlm-ledger", ledgerFile), "utf8")
				.trim()
				.split(/\r?\n/)
				.map((line) => JSON.parse(line) as { op: string; childId?: string });
			expect(ledgerOps.some((record) => record.op === "delete" && record.childId === fixture.childId)).toBe(true);
		} finally {
			if (lockedRoot) chmodSync(lockedRoot, 0o755);
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("still sweeps and resolves when scheduled-job cancellation throws", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-artifact-cancel-throw-"));
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			writeFileSync(join(fixture.childArtifactDir, "kernel-state.dill"), "payload");
			const internals = fixture.daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createSubagentRuntimeHost(parent: ActiveSessionState): SubagentRuntimeHost;
				cancelScheduledJobsForSessionFile(sessionFile: string): void;
			};
			internals.cancelScheduledJobsForSessionFile = vi.fn(() => {
				throw new Error("corrupt scheduled-jobs.json");
			});
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });

			// Jobs-store bookkeeping must not fail the deletion or skip the sweep.
			await internals.createSubagentRuntimeHost(parentState).deleteRlmSubagentRuntime(fixture.childId);

			expect(internals.cancelScheduledJobsForSessionFile).toHaveBeenCalledOnce();
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

	it("gives RLM subagents messaging controllers for their own nested children", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-nested-controller-"));
		try {
			const sessionNamesDuringBind: Array<string | undefined> = [];
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.bindExtensions = vi.fn(async () => {
					sessionNamesDuringBind.push(options.sessionManager.getSessionName());
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				bindingSessions: Set<string>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: join(tempDir, "parent.jsonl"),
			});
			const childSessionName = createDefaultRlmSubagentSessionName("spawn a nested worker", "child-1");
			let publishedWhileBinding = false;
			await internals.createRlmSubagentRuntime(parentState, {
				parentSession: parentState.runtime.session,
				id: "child-1",
				prompt: "spawn a nested worker",
				sessionName: childSessionName,
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
				onSessionPublished: (session) => {
					expect(session.sessionName).toBe(childSessionName);
					const state = [...internals.sessions.values()].find(
						(candidate) => candidate.runtime.session === session,
					);
					publishedWhileBinding = !!state && internals.bindingSessions.has(state.activeSessionId);
				},
			});
			expect(publishedWhileBinding).toBe(true);

			const childOptions = createRuntime.mock.calls[1]?.[0];
			const childController = childOptions?.sessionOptions?.agentMessageController;
			expect(childController).toBeDefined();
			const currentChild = (await childController?.listAgents())?.current;
			const childActiveSessionId = currentChild?.activeSessionId;
			expect(childActiveSessionId).toBeTruthy();
			expect(currentChild?.sessionName).toBe(childSessionName);
			expect(sessionNamesDuringBind[1]).toBeUndefined();

			const grandchildState = makeState("grandchild", childActiveSessionId);
			grandchildState.runtime = {
				...grandchildState.runtime,
				cwd: tempDir,
				metadata: { ...grandchildState.runtime.metadata, rlmChildId: "grandchild-1" },
				session: {
					sessionId: "session-grandchild",
					sessionName: "Grandchild",
					isStreaming: false,
					sessionActions: { queuedCount: 0, steering: [], followUps: [] },
				},
			} as never;
			internals.sessions.set(grandchildState.activeSessionId, grandchildState);
			expect((await childController?.listAgents())?.agents).toContainEqual(
				expect.objectContaining({
					activeSessionId: grandchildState.activeSessionId,
					parentActiveSessionId: childActiveSessionId,
					rlmChildId: "grandchild-1",
				}),
			);

			const sessionsBeforeCancelledStartup = internals.sessions.size;
			vi.mocked(parentState.runtime.session.getRlmChildRunStatus).mockReturnValue("cancelled");
			await expect(
				internals.createRlmSubagentRuntime(parentState, {
					parentSession: parentState.runtime.session,
					id: "cancelled-child",
					prompt: "delete during daemon startup",
					sessionName: "cancelled-worker",
					sessionDir: join(tempDir, "cancelled-child"),
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
					rlmParentNodeId: "cancelled-child",
				}),
			).rejects.toThrow();
			expect(parentState.runtime.session.getRlmChildRunStatus).toHaveBeenCalledWith("cancelled-child");
			expect(internals.sessions.size).toBe(sessionsBeforeCancelledStartup);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("disposes a newly opened runtime when its requested root name collides", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-root-name-failure-"));
		try {
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => ({
				session: makeRuntimeSession(options.sessionManager),
				extensionsResult: { extensions: [], errors: [], runtime: {} } as never,
				services: { cwd: options.cwd, agentDir: options.agentDir } as never,
				diagnostics: [],
			}));
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
			};
			await internals.createRuntime({ type: "create", sessionPath: join(tempDir, "first.jsonl"), name: "taken" });
			await expect(
				internals.createRuntime({ type: "create", sessionPath: join(tempDir, "second.jsonl"), name: "taken" }),
			).rejects.toThrow("an agent of that name already exists at depth 0 under this parent");

			const failedSession = createRuntime.mock.results[1]?.value
				? (await createRuntime.mock.results[1].value).session
				: undefined;
			expect(failedSession?.disposeAsync).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("closes a registered RLM runtime when its requested session name cannot be persisted", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-child-name-failure-"));
		try {
			let failingChildSession: ReturnType<typeof makeRuntimeSession> | undefined;
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				if (createRuntime.mock.calls.length > 1) {
					failingChildSession = session;
					session.setSessionName = vi.fn(() => {
						throw new Error("name persistence failed");
					});
				}
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				createRlmSubagentRuntime(
					parentState: ActiveSessionState,
					options: CreateRlmSubagentRuntimeOptions,
				): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({
				type: "create",
				sessionPath: join(tempDir, "parent.jsonl"),
			});
			await expect(
				internals.createRlmSubagentRuntime(parentState, {
					parentSession: parentState.runtime.session,
					id: "child-name-failure",
					prompt: "fail while naming",
					sessionName: "requested-name",
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
					rlmParentNodeId: "child-name-failure",
				}),
			).rejects.toThrow("name persistence failed");

			expect(failingChildSession).toBeDefined();
			expect(failingChildSession?.disposeAsync).toHaveBeenCalledOnce();
			expect(internals.sessions.size).toBe(1);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("waits for extension binding before targeting half-bound sessions", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-binding-gate-"));
		try {
			let releaseBind: () => void = () => {};
			const bindBarrier = new Promise<void>((resolve) => {
				releaseBind = resolve;
			});
			const createRuntime = vi.fn(async (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => {
				const session = makeRuntimeSession(options.sessionManager);
				session.acceptAgentMessagePrompt = vi.fn(
					(_message: string, promptOptions?: { preflightResult?: (accepted: boolean) => void }) => {
						promptOptions?.preflightResult?.(true);
						return Promise.resolve();
					},
				);
				session.bindExtensions = vi.fn(async () => {
					await bindBarrier;
				});
				return {
					session,
					extensionsResult: { extensions: [], errors: [], runtime: {} } as unknown as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["extensionsResult"],
					services: { cwd: options.cwd, agentDir: options.agentDir } as Awaited<
						ReturnType<CreateAgentSessionRuntimeFactory>
					>["services"],
					diagnostics: [],
				};
			});
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir: tempDir },
				createRuntime,
			});
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
				createAgentMessageListResult(current: ActiveSessionState): Promise<{
					agents: Array<{ activeSessionId: string }>;
				}>;
				sendAgentSessionMessage(options: {
					targetSelector: string;
					message: string;
					fromState?: ActiveSessionState;
					origin: "agent" | "cli";
				}): Promise<unknown>;
			};
			const fromState = makeState("source");
			fromState.runtime = {
				...fromState.runtime,
				cwd: tempDir,
				session: {
					sessionId: "session-source",
					sessionName: "Source",
					isStreaming: false,
					unfinishedActionCount: 0,
				},
			} as never;
			internals.sessions.set(fromState.activeSessionId, fromState);

			const created = internals.createRuntime({ type: "create", sessionPath: join(tempDir, "session.jsonl") });
			for (let attempt = 0; attempt < 50 && internals.sessions.size < 2; attempt++) {
				await Promise.resolve();
			}
			const bindingId = [...internals.sessions.keys()].find((id) => id !== fromState.activeSessionId);
			expect(bindingId).toBeTruthy();

			const message = internals.sendAgentSessionMessage({
				targetSelector: bindingId as string,
				message: "wait for binding",
				fromState,
				origin: "agent",
			});
			const attach = Promise.resolve(
				internals.handleCommand(makeClient("client-1", bindingId as string), {
					id: "command-1",
					type: "attach",
					activeSessionId: bindingId as string,
				}),
			);
			let messageSettled = false;
			let attachSettled = false;
			void message.then(
				() => {
					messageSettled = true;
				},
				() => {
					messageSettled = true;
				},
			);
			void attach.then(
				() => {
					attachSettled = true;
				},
				() => {
					attachSettled = true;
				},
			);
			await Promise.resolve();
			expect(messageSettled).toBe(false);
			expect(attachSettled).toBe(false);
			expect(
				(await internals.createAgentMessageListResult(fromState)).agents.map((agent) => agent.activeSessionId),
			).toEqual([fromState.activeSessionId]);

			releaseBind();
			await created;
			await expect(message).resolves.toBeDefined();
			await attach.catch(() => undefined);

			expect(
				(await internals.createAgentMessageListResult(fromState)).agents.map((agent) => agent.activeSessionId),
			).toEqual(expect.arrayContaining([fromState.activeSessionId, bindingId]));
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("includes paused jobs in the default cron list", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-cron-list-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: {
					agentDir: tempDir,
					cwd: tempDir,
				},
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			internals.cronStore.pauseHeartbeat("active-1", new Date("2026-01-01T12:01:00.000Z"));

			const response = (await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "cron_list",
			})) as { data: { jobs: AgentCronJob[] } };

			expect(response.data.jobs).toEqual([expect.objectContaining({ id: heartbeat.id, status: "paused" })]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels scheduled jobs when a live session is killed", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-cron-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: {
					agentDir: tempDir,
					cwd: tempDir,
				},
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const sessionFile = join(tempDir, "session.jsonl");
			const removeQueuedFollowUp = vi.fn();
			const abort = vi.fn(async () => {});
			const dispose = vi.fn(async () => {});
			const appendSessionState = vi.fn();
			const state = makeState("active-1") as ActiveSessionState;
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "top-level", createdAt: 1 },
				cwd: tempDir,
				dispose,
				session: {
					sessionId: "session-1",
					sessionFile,
					messages: ["user message"],
					sessionManager: {
						appendSessionState,
						hasUserContent: () => true,
					},
					abort,
					removeQueuedFollowUp,
				},
			} as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check long run",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep working",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			internals.cronStore.pauseHeartbeat(state.activeSessionId, new Date("2026-01-01T12:01:00.000Z"));
			const rlmHeartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				runtimeKind: "top-level",
				scheduleText: "every 10m",
				prompt: "keep internal work moving",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});

			for (const id of [cron.id, heartbeat.id, rlmHeartbeat.id]) {
				expect(internals.cronStore.list().find((job) => job.id === id)).toMatchObject({ status: "cancelled" });
				expect(internals.cronStore.list().find((job) => job.id === id)).not.toHaveProperty("nextRunAt");
			}
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${heartbeat.id}`);
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${rlmHeartbeat.id}`);
			expect(abort).toHaveBeenCalledOnce();
			expect(dispose).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("applies killed effects when kill joins a passivation close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-passivation-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const sessionFile = join(tempDir, "session.jsonl");
			const appendSessionState = vi.fn();
			const state = makeState("active-1");
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "subagent", createdAt: 1 },
				cwd: tempDir,
				dispose: vi.fn(async () => {
					markDisposeStarted();
					await disposeGate;
				}),
				session: {
					sessionId: "session-1",
					sessionFile,
					messages: ["user message"],
					isBashRunning: false,
					sessionManager: { appendSessionState, hasUserContent: () => true },
					abort: vi.fn(async () => {}),
				},
			} as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				closeSession(
					state: ActiveSessionState,
					reason: "shutdown",
					waitForAbort: boolean,
					cascadeChildren: boolean,
				): Promise<void>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check long run",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const passivationClose = internals.closeSession(state, "shutdown", true, false);
			await disposeStarted;
			const kill = internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});
			releaseDispose();

			await expect(Promise.all([passivationClose, kill])).resolves.toBeDefined();
			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "cancelled" });
			expect(appendSessionState).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("applies a stronger reason after the joined close rejects", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-failed-close-race-"));
		let rejectClose!: (error: Error) => void;
		const failedClose = new Promise<void>((_resolve, reject) => {
			rejectClose = reject;
		});
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const appendSessionState = vi.fn();
			const state = makeState("active-1");
			state.runtime = {
				...state.runtime,
				cwd: tempDir,
				session: {
					sessionId: "session-1",
					sessionFile: join(tempDir, "session.jsonl"),
					sessionManager: { appendSessionState },
				},
			} as never;
			const existingClose = {
				promise: failedClose,
				reason: "shutdown" as const,
				descendants: new Set<ActiveSessionState>(),
			};
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				closingSessions: Map<string, typeof existingClose>;
				closeSession(state: ActiveSessionState, reason: "killed"): Promise<void>;
			};
			internals.closingSessions.set(state.activeSessionId, existingClose);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "scheduled work",
			});

			const kill = internals.closeSession(state, "killed");
			rejectClose(new Error("dispose failed"));

			await expect(kill).rejects.toThrow("dispose failed");
			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "cancelled" });
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
			expect(existingClose.reason).toBe("killed");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("finishes a reason upgrade after one target fails to archive", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-archive-failure-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const parent = makeState("parent");
			const child = makeState("child", parent.activeSessionId);
			const parentArchive = vi.fn(() => {
				throw new Error("archive failed");
			});
			const childArchive = vi.fn();
			for (const [state, sessionId, appendSessionState] of [
				[parent, "session-parent", parentArchive],
				[child, "session-child", childArchive],
			] as const) {
				state.runtime = {
					...state.runtime,
					cwd: tempDir,
					session: {
						sessionId,
						sessionFile: join(tempDir, `${sessionId}.jsonl`),
						sessionManager: { appendSessionState },
					},
				} as never;
			}
			const existingClose = {
				promise: Promise.resolve(),
				reason: "shutdown" as "shutdown" | "killed",
				descendants: new Set([child]),
			};
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				closingSessions: Map<string, typeof existingClose>;
				closeSession(state: ActiveSessionState, reason: "killed"): Promise<void>;
			};
			internals.closingSessions.set(parent.activeSessionId, existingClose);
			const jobs = [parent, child].map((state) =>
				internals.cronStore.create({
					activeSessionId: state.activeSessionId,
					sessionId: state.runtime.session.sessionId,
					sessionFile: state.runtime.session.sessionFile!,
					cwd: tempDir,
					scheduleText: "in 1h",
					prompt: "scheduled work",
				}),
			);

			await expect(internals.closeSession(parent, "killed")).rejects.toThrow("archive failed");

			for (const job of jobs) {
				expect(internals.cronStore.list().find((candidate) => candidate.id === job.id)).toMatchObject({
					status: "cancelled",
				});
			}
			expect(parentArchive).toHaveBeenCalledOnce();
			expect(childArchive).toHaveBeenCalledWith({ status: "archived" });
			expect(existingClose.reason).toBe("killed");
			await expect(internals.closeSession(parent, "killed")).resolves.toBeUndefined();
			expect(parentArchive).toHaveBeenCalledOnce();
			expect(childArchive).toHaveBeenCalledOnce();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("upgrades resident descendants when kill joins a parent shutdown close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-parent-shutdown-race-"));
		let releaseParentDispose!: () => void;
		const parentDisposeGate = new Promise<void>((resolve) => {
			releaseParentDispose = resolve;
		});
		let markParentDisposeStarted!: () => void;
		const parentDisposeStarted = new Promise<void>((resolve) => {
			markParentDisposeStarted = resolve;
		});
		try {
			const fixture = makePersistedRlmDaemonFixture(tempDir);
			const internals = fixture.daemon as unknown as {
				cronStore: AgentCronJobStore;
				createRuntime(command: Extract<DaemonCommand, { type: "create" }>): Promise<ActiveSessionState>;
				closeSession(state: ActiveSessionState, reason: "shutdown"): Promise<void>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const parentState = await internals.createRuntime({ type: "create", sessionPath: fixture.parentSessionFile });
			const childState = await internals.createRuntime({ type: "create", sessionPath: fixture.childSessionFile });
			parentState.runtime.dispose = vi.fn(async () => {
				markParentDisposeStarted();
				await parentDisposeGate;
			});
			const childJob = internals.cronStore.create({
				activeSessionId: childState.activeSessionId,
				sessionId: childState.runtime.session.sessionId,
				sessionFile: fixture.childSessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "scheduled child work",
			});

			const shutdownClose = internals.closeSession(parentState, "shutdown");
			await parentDisposeStarted;
			const kill = internals.handleCommand(makeClient("client-1", parentState.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: parentState.activeSessionId,
			});
			releaseParentDispose();

			await expect(Promise.all([shutdownClose, kill])).resolves.toBeDefined();
			expect(internals.cronStore.list().find((job) => job.id === childJob.id)).toMatchObject({
				status: "cancelled",
			});
			expect(SessionManager.open(fixture.childSessionFile).getSessionState()).toEqual({ status: "archived" });
		} finally {
			releaseParentDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("does not duplicate effects when kill joins a completed close", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-kill-completed-race-"));
		let releaseDispose!: () => void;
		const disposeGate = new Promise<void>((resolve) => {
			releaseDispose = resolve;
		});
		let markDisposeStarted!: () => void;
		const disposeStarted = new Promise<void>((resolve) => {
			markDisposeStarted = resolve;
		});
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const appendSessionState = vi.fn();
			const state = makeState("active-1");
			state.extensionUiRequests = new Map();
			state.runtime = {
				metadata: { kind: "subagent", createdAt: 1 },
				cwd: tempDir,
				dispose: vi.fn(async () => {
					markDisposeStarted();
					await disposeGate;
				}),
				session: {
					sessionId: "session-1",
					sessionFile: join(tempDir, "session.jsonl"),
					messages: ["user message"],
					isBashRunning: false,
					sessionManager: { appendSessionState, hasUserContent: () => true },
				},
			} as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				closeSession(state: ActiveSessionState, reason: "completed"): Promise<void>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const cron = internals.cronStore.create({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check completed run",
			});

			const completedClose = internals.closeSession(state, "completed");
			await disposeStarted;
			const kill = internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "kill",
				activeSessionId: state.activeSessionId,
			});
			releaseDispose();

			await expect(Promise.all([completedClose, kill])).resolves.toBeDefined();
			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "cancelled" });
			expect(appendSessionState).toHaveBeenCalledOnce();
			expect(appendSessionState).toHaveBeenCalledWith({ status: "archived" });
		} finally {
			releaseDispose();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("cancels scheduled jobs when a saved session is deleted", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-cron-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: {
					agentDir: tempDir,
					cwd: tempDir,
				},
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const sessionFile = join(tempDir, "saved-session.jsonl");
			const otherSessionFile = join(tempDir, "other-session.jsonl");
			const cron = internals.cronStore.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check saved session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep saved session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const unrelated = internals.cronStore.create({
				activeSessionId: "active-2",
				sessionId: "session-2",
				sessionFile: otherSessionFile,
				cwd: tempDir,
				scheduleText: "in 2h",
				prompt: "keep other session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			});

			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "cancelled" });
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "cancelled",
			});
			expect(internals.cronStore.list().find((job) => job.id === unrelated.id)).toMatchObject({ status: "active" });
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("streams detached saved-session catalog requests", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-saved-session-catalog-"));
		try {
			const sessionDir = join(tempDir, "sessions");
			const session = SessionManager.create(tempDir, sessionDir);
			session.appendSessionState({ status: "active" });
			session.appendAgentStatus({
				summary: "Finished the task",
				taskState: "completed",
				basedOnMessageCount: 0,
			});
			session.appendSessionState({ status: "active" });
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir, sessionDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const writes: string[] = [];
			const client = {
				...makeClient("client-1", "detached"),
				socket: {
					destroyed: false,
					write: (line: string) => {
						writes.push(line);
						return true;
					},
				} as unknown as Socket,
			};

			const response = (await internals.handleCommand(client, {
				id: "list-1",
				type: "list_saved_sessions",
				cwd: tempDir,
				sessionDir,
				scope: "current",
			})) as {
				data: {
					sessions: Array<{
						id: string;
						agentStatus?: {
							summary: string;
							taskState?: "needs_input" | "completed";
							basedOnMessageCount: number;
						};
					}>;
				};
			};
			const updates = writes.map((line) => JSON.parse(line) as { type: string; activeSessionId?: string });

			expect(response.data.sessions).toEqual([
				expect.objectContaining({
					id: session.getSessionId(),
					agentStatus: { summary: "Finished the task", taskState: "completed", basedOnMessageCount: 0 },
				}),
			]);
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						id: "list-1",
						type: "session_list_progress",
						command: "list_saved_sessions",
						loaded: 1,
						total: 1,
					}),
					expect.objectContaining({
						id: "list-1",
						type: "session_list_item",
						command: "list_saved_sessions",
						session: expect.objectContaining({
							id: session.getSessionId(),
							agentStatus: { summary: "Finished the task", taskState: "completed", basedOnMessageCount: 0 },
						}),
					}),
				]),
			);
			expect(updates.every((update) => update.activeSessionId === undefined)).toBe(true);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps saved session jobs when file deletion fails", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-delete-cron-fail-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: {
					agentDir: tempDir,
					cwd: tempDir,
				},
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const deleteSavedSessionFile = vi.fn(async () => ({ ok: false, error: "delete failed" }) as const);
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				deleteSavedSessionFile: typeof deleteSavedSessionFile;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.deleteSavedSessionFile = deleteSavedSessionFile;
			const sessionFile = join(tempDir, "saved-session.jsonl");
			const cron = internals.cronStore.create({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "in 1h",
				prompt: "check saved session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "active-1",
				sessionId: "session-1",
				sessionFile,
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "keep saved session alive",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const response = await internals.handleCommand(makeClient("client-1", "active-1"), {
				id: "command-1",
				type: "delete_saved_session",
				sessionPath: sessionFile,
			});

			expect(response).toMatchObject({ data: { ok: false, error: "delete failed" } });
			expect(deleteSavedSessionFile).toHaveBeenCalledWith(sessionFile, {
				afterFileRemoved: expect.any(Function),
			});
			expect(internals.cronStore.list().find((job) => job.id === cron.id)).toMatchObject({ status: "active" });
			expect(internals.cronStore.list().find((job) => job.id === heartbeat.id)).toMatchObject({
				status: "active",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves omitted global scope on daemon refine commands", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const refine = vi.fn(async () => ({
			id: "refine_daemon",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
		}));
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					refine: typeof refine;
				};
			};
		};
		state.runtime.session = { refine } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "refine",
			activeSessionId: state.activeSessionId,
			instructions: "record local lesson",
		});

		expect(refine).toHaveBeenCalledWith({
			instructions: "record local lesson",
			rollbackId: undefined,
			global: undefined,
		});
	});

	it("routes queued message mutation to the active session", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const mutateQueuedMessage = vi.fn(() => "applied" as const);
		const state = makeState("active-1") as ActiveSessionState;
		(state.runtime as { session: unknown }).session = { mutateQueuedMessage };
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		const mutation = { type: "replace", text: "edited", lane: "followUp" } as const;
		await expect(
			internals.handleCommand(client, {
				type: "mutate_queued_message",
				activeSessionId: state.activeSessionId,
				lane: "followUp",
				index: 0,
				expectedText: "edited",
				mutation,
			}),
		).resolves.toMatchObject({ success: true, data: { status: "applied" } });
		expect(mutateQueuedMessage).toHaveBeenCalledWith("followUp", 0, "edited", mutation);
	});

	it("gets and sets RLM max depth directly on the active session", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const getRlmMaxDepthStatus = vi.fn(() => ({ maxDepth: 2, source: "chat" as const }));
		const setRlmMaxDepth = vi.fn(async () => ({
			maxDepth: 3,
			source: "chat" as const,
			globalSaved: true,
		}));
		const state = makeState("active-1") as ActiveSessionState;
		(state.runtime as { session: unknown }).session = { getRlmMaxDepthStatus, setRlmMaxDepth };
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);

		await expect(
			internals.handleCommand(client, {
				type: "get_rlm_max_depth_status",
				activeSessionId: state.activeSessionId,
			}),
		).resolves.toMatchObject({ success: true, data: { maxDepth: 2, source: "chat" } });
		await expect(
			internals.handleCommand(client, {
				type: "set_rlm_max_depth",
				activeSessionId: state.activeSessionId,
				maxDepth: 3,
				global: true,
			}),
		).resolves.toMatchObject({ success: true, data: { maxDepth: 3, globalSaved: true } });
		expect(setRlmMaxDepth).toHaveBeenCalledWith(3, { global: true });
	});

	it.each([
		{
			name: "defers busy heartbeat cron jobs instead of queueing a follow-up",
			activity: { isStreaming: true },
			jobs: [{ id: "heartbeat-1", source: "heartbeat", deliveryMode: "follow_up" }],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: false,
		},
		{
			name: "defers separate RLM heartbeat cron jobs while the session is busy",
			activity: { isStreaming: true },
			jobs: [
				{ id: "rlm-1", source: "rlm_heartbeat", deliveryMode: "follow_up" },
				{ id: "rlm-2", source: "rlm_heartbeat", deliveryMode: "follow_up" },
			],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: false,
		},
		{
			name: "does not enqueue another heartbeat when one is already pending",
			activity: { isStreaming: true, hasPendingSessionWork: true, unfinishedActionCount: 1 },
			jobs: [{ id: "heartbeat-1", source: "heartbeat" }],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: true,
		},
		{
			name: "defers heartbeat cron jobs while the target is accepting an agent message",
			activity: {},
			jobs: [{ id: "heartbeat-1", source: "heartbeat" }],
			acceptingAgentMessage: true,
			assertQueuedHeartbeatUntouched: false,
		},
		{
			name: "defers heartbeat cron jobs while an accepted agent message prompt is in flight",
			activity: { unfinishedActionCount: 1 },
			jobs: [{ id: "heartbeat-1", source: "heartbeat" }],
			acceptingAgentMessage: false,
			assertQueuedHeartbeatUntouched: false,
		},
	] as const)("$name", async ({ activity, jobs, acceptingAgentMessage, assertQueuedHeartbeatUntouched }) => {
		const fixture = makeCronAdmissionFixture(activity, { acceptingAgentMessage });

		const results = [];
		for (const job of jobs) {
			results.push(await fixture.runCronJob(makeCronJob({ ...job, activeSessionId: fixture.activeSessionId })));
		}

		expect(results).toEqual(jobs.map(() => "skipped"));
		expect(fixture.prompt).not.toHaveBeenCalled();
		expect(fixture.promptHeartbeat).not.toHaveBeenCalled();
		expect(fixture.followUp).not.toHaveBeenCalled();
		if (assertQueuedHeartbeatUntouched) {
			expect(fixture.removeQueuedFollowUp).not.toHaveBeenCalled();
		}
	});

	it.each([
		{
			name: "queues generic cron jobs while the target is accepting an agent message",
			activity: {},
			acceptingAgentMessage: true,
		},
		{
			name: "queues generic cron jobs behind accepted agent message prompts",
			activity: { unfinishedActionCount: 1 },
			acceptingAgentMessage: false,
		},
		{
			name: "queues generic cron jobs behind pending messages",
			activity: { unfinishedActionCount: 1 },
			acceptingAgentMessage: false,
		},
	] as const)("$name", async ({ activity, acceptingAgentMessage }) => {
		const fixture = makeCronAdmissionFixture(activity, { acceptingAgentMessage });

		await fixture.runCronJob(makeCronJob({ id: "cron-1", source: "cron", activeSessionId: fixture.activeSessionId }));

		expect(fixture.followUp).toHaveBeenCalledWith("heartbeat prompt", undefined, { resumeIfIdle: true });
		expect(fixture.prompt).not.toHaveBeenCalled();
		expect(fixture.promptHeartbeat).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "delivers heartbeats with a steering behavior by default",
			job: { id: "heartbeat-1", source: "heartbeat" },
			streamingBehavior: "steer",
			method: "promptHeartbeat",
		},
		{
			name: "delivers follow-up heartbeats with a followUp behavior and coalescing key",
			job: { id: "heartbeat-1", source: "heartbeat", deliveryMode: "follow_up" },
			streamingBehavior: "followUp",
			method: "promptHeartbeat",
		},
		{
			name: "prompts idle generic cron jobs without a heartbeat coalescing key",
			job: { id: "cron-1", source: "cron" },
			streamingBehavior: "followUp",
			method: "prompt",
		},
	] as const)("$name", async ({ job, streamingBehavior, method }) => {
		const fixture = makeCronAdmissionFixture();

		await fixture.runCronJob(makeCronJob({ ...job, activeSessionId: fixture.activeSessionId }));

		const expectedOptions = expect.objectContaining({ streamingBehavior, source: "rpc" });
		if (method === "promptHeartbeat") {
			expect(fixture.promptHeartbeat).toHaveBeenCalledWith(
				expect.objectContaining({ id: job.id, prompt: "heartbeat prompt" }),
				expectedOptions,
			);
			expect(fixture.promptHeartbeat.mock.calls[0]?.[1]).toMatchObject({
				followUpQueueKey: `heartbeat:${job.id}`,
			});
			expect(fixture.prompt).not.toHaveBeenCalled();
		} else {
			expect(fixture.prompt).toHaveBeenCalledWith("heartbeat prompt", expectedOptions);
			expect(fixture.prompt.mock.calls[0]?.[1]).not.toHaveProperty("followUpQueueKey");
			expect(fixture.promptHeartbeat).not.toHaveBeenCalled();
		}
		expect(fixture.followUp).not.toHaveBeenCalled();
	});

	it("clears prompt admission registered before unauthenticated worker rejection", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
			worker: { authenticationToken: "worker-token" },
		});
		const client = makeClient("unauthenticated", "active-1");
		const end = vi.fn();
		client.socket = { destroyed: false, write: vi.fn(() => true), end } as unknown as Socket;
		const internals = daemon as unknown as {
			promptAdmissions: Map<string, unknown>;
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};

		await internals.handleLine(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: "active-1",
				message: "unauthorized",
				admissionId: "leaked-admission",
			}),
		);

		expect(end).toHaveBeenCalledOnce();
		expect(internals.promptAdmissions.size).toBe(0);
	});

	it("clears prompt admission when restart fencing rejects before dispatch", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const client = makeClient("client", "active-1");
		client.socket = { destroyed: false, write: vi.fn(() => true), end: vi.fn() } as unknown as Socket;
		const internals = daemon as unknown as {
			promptAdmissions: Map<string, unknown>;
			updateRestart: { phase: "fencing" };
			handleLine(client: DaemonSocketClient, line: string): Promise<void>;
		};
		internals.updateRestart = { phase: "fencing" };

		await internals.handleLine(
			client,
			JSON.stringify({
				id: "prompt-1",
				type: "prompt",
				activeSessionId: "active-1",
				message: "blocked",
				admissionId: "retryable-admission",
			}),
		);

		expect(internals.promptAdmissions.size).toBe(0);
	});

	it.each(["success", "late-failure", "replacement"] as const)(
		"handles cancellation followed by supervisor-claim %s without affecting the wrong socket binding",
		async (outcome) => {
			const daemon = new AgentDaemon("/tmp/prime-agent-worker-test.sock", {
				defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
				worker: { authenticationToken: "worker-token" },
			});
			const client = makeClient("authenticated", "active-1");
			client.authenticated = true;
			const end = vi.fn();
			client.socket = { destroyed: false, write: vi.fn(() => true), end } as unknown as Socket;
			const claim = {
				supervisorGeneration: "generation",
				supervisorPid: process.pid,
				supervisorSocketPath: "/tmp/supervisor.sock",
			};
			let resolveClaim!: (fingerprint: string) => void;
			let rejectClaim!: (error: Error) => void;
			const claimCheck = new Promise<string>((resolve, reject) => {
				resolveClaim = resolve;
				rejectClaim = reject;
			});
			const internals = daemon as unknown as {
				promptAdmissions: Map<string, { controller?: AbortController }>;
				supervisorClaims: Map<DaemonSocketClient, { claim: typeof claim; ownerFingerprint: string }>;
				assertSupervisorClaimCurrent: ReturnType<typeof vi.fn>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
				handleLine(client: DaemonSocketClient, line: string): Promise<void>;
			};
			const originalBinding = { claim, ownerFingerprint: "owner" };
			internals.supervisorClaims.set(client, originalBinding);
			internals.assertSupervisorClaimCurrent = vi.fn(() => claimCheck);

			const handling = internals.handleLine(
				client,
				JSON.stringify({
					type: "prompt",
					activeSessionId: "active-1",
					message: "cancel during claim check",
					admissionId: "claim-admission",
				}),
			);
			await vi.waitFor(() => expect(internals.promptAdmissions.size).toBe(1));
			await internals.handleCommand(client, {
				type: "cancel_prompt_admission",
				activeSessionId: "active-1",
				admissionId: "claim-admission",
			});
			await handling;

			expect(internals.promptAdmissions.size).toBe(0);
			expect(end).not.toHaveBeenCalled();
			if (outcome === "replacement") {
				internals.supervisorClaims.set(client, { claim: { ...claim }, ownerFingerprint: "replacement" });
			}
			if (outcome === "success") resolveClaim("refreshed");
			else rejectClaim(new Error("late stale claim"));
			await Promise.resolve();
			await Promise.resolve();

			if (outcome === "late-failure") {
				expect(end).toHaveBeenCalledOnce();
				expect(internals.supervisorClaims.has(client)).toBe(false);
			} else {
				expect(end).not.toHaveBeenCalled();
			}
			if (outcome === "success") expect(originalBinding.ownerFingerprint).toBe("owner");
			if (outcome === "replacement")
				expect(internals.supervisorClaims.get(client)?.ownerFingerprint).toBe("replacement");
		},
	);

	it("capability-gates cancellation after prompt ownership", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		let promptOptions: { signal?: AbortSignal; admissionCommitted?: () => void } | undefined;
		let rejectPrompt: ((error: Error) => void) | undefined;
		const promptUntilAccepted = vi.fn(
			async (_message: string, options?: { signal?: AbortSignal; admissionCommitted?: () => void }) => {
				promptOptions = options;
				await new Promise<void>((_resolve, reject) => {
					rejectPrompt = reject;
					options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
				});
			},
		);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & { session: { promptUntilAccepted: typeof promptUntilAccepted } };
		};
		state.runtime = { ...state.runtime, session: { promptUntilAccepted } } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			promptAdmissions: Map<string, unknown>;
			parseCommandAndRegisterPromptAdmission(client: DaemonSocketClient, line: string): unknown;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
		};
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		client.socket = { destroyed: false, write: vi.fn(() => true) } as unknown as Socket;

		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: state.activeSessionId,
				message: "blocked",
				admissionId: "admission-1",
			}),
		);
		internals.handleCommand(client, {
			id: "prompt-1",
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "blocked",
			admissionId: "admission-1",
		});
		await vi.waitFor(() => expect(promptUntilAccepted).toHaveBeenCalledOnce());
		await expect(
			internals.handleCommand(client, {
				id: "cancel-1",
				type: "cancel_prompt_admission",
				activeSessionId: state.activeSessionId,
				admissionId: "admission-1",
			}),
		).resolves.toMatchObject({ success: true, data: { status: "cancelled" } });
		await vi.waitFor(() => expect(internals.promptAdmissions.size).toBe(0));

		// Old clients retain the pre-ownership-only behavior.
		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: state.activeSessionId,
				message: "owned",
				admissionId: "admission-2",
			}),
		);
		internals.handleCommand(client, {
			id: "prompt-2",
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "owned",
			admissionId: "admission-2",
		});
		await vi.waitFor(() => expect(promptUntilAccepted).toHaveBeenCalledTimes(2));
		promptOptions?.admissionCommitted?.();
		await expect(
			internals.handleCommand(client, {
				id: "cancel-2",
				type: "cancel_prompt_admission",
				activeSessionId: state.activeSessionId,
				admissionId: "admission-2",
			}),
		).resolves.toMatchObject({ success: true, data: { status: "owned" } });
		expect(promptOptions?.signal?.aborted).toBe(false);

		// New clients request the capability-gated session-owned cancellation.
		await expect(
			internals.handleCommand(client, {
				id: "cancel-3",
				type: "cancel_prompt_admission",
				activeSessionId: state.activeSessionId,
				admissionId: "admission-2",
				cancelOwned: true,
			}),
		).resolves.toMatchObject({ success: true, data: { status: "owned" } });
		expect(promptOptions?.signal?.aborted).toBe(true);
		rejectPrompt?.(new Error("test cleanup"));
	});

	it("aborts waiting prompt admissions when their session closes", () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const internals = daemon as unknown as {
			promptAdmissions: Map<string, { status: string; controller?: AbortController }>;
			parseCommandAndRegisterPromptAdmission(client: DaemonSocketClient, line: string): unknown;
			abortWaitingPromptAdmissionsForSession(activeSessionId: string): void;
		};
		const client = makeClient("client-closing", "closing-session");
		internals.parseCommandAndRegisterPromptAdmission(
			client,
			JSON.stringify({
				type: "prompt",
				activeSessionId: "closing-session",
				message: "blocked",
				admissionId: "closing-admission",
			}),
		);
		const admission = [...internals.promptAdmissions.values()][0]!;
		internals.abortWaitingPromptAdmissionsForSession("closing-session");
		expect(admission.status).toBe("cancelled");
		expect(admission.controller?.signal.aborted).toBe(true);
	});

	it("uses the queued default lane for old-client prompts on a new daemon", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const promptUntilAccepted = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & { session: { promptUntilAccepted: typeof promptUntilAccepted } };
		};
		state.runtime = { ...state.runtime, session: { promptUntilAccepted } } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown> | undefined;
		};
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("legacy-client", state.activeSessionId);
		const write = vi.fn((_data: unknown) => true);
		client.socket = { destroyed: false, write } as unknown as Socket;

		internals.handleCommand(client, {
			id: "command-1",
			type: "prompt",
			activeSessionId: state.activeSessionId,
			message: "legacy prompt",
			streamingBehavior: "followUp",
		});

		await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
		expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toMatchObject({ success: true, command: "prompt" });
		expect(promptUntilAccepted).toHaveBeenCalledWith(
			"legacy prompt",
			expect.objectContaining({ streamingBehavior: "followUp", queueIfBusy: true }),
		);
	});

	it("routes resume_queue through the session scheduler", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const resumeQueuedWork = vi.fn(() => true);
		const continueAgent = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: { resumeQueuedWork: typeof resumeQueuedWork; agent: { continue: typeof continueAgent } };
			};
		};
		state.runtime = { ...state.runtime, session: { resumeQueuedWork, agent: { continue: continueAgent } } } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await expect(
			internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "resume_queue",
				activeSessionId: state.activeSessionId,
			}),
		).resolves.toMatchObject({ success: true, command: "resume_queue" });
		expect(resumeQueuedWork).toHaveBeenCalledOnce();
		expect(continueAgent).not.toHaveBeenCalled();
	});

	it.each(["steer", "follow_up"] as const)("routes correlated daemon %s commands", async (type) => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const steer = vi.fn(async () => {});
		const followUp = vi.fn(async () => true);
		const restoreSteeringMessage = vi.fn(async () => {});
		const restoreFollowUpMessage = vi.fn(async () => true);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					steer: typeof steer;
					followUp: typeof followUp;
					restoreSteeringMessage: typeof restoreSteeringMessage;
					restoreFollowUpMessage: typeof restoreFollowUpMessage;
				};
			};
		};
		state.runtime.session = { steer, followUp, restoreSteeringMessage, restoreFollowUpMessage } as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);
		const client = makeClient("client-1", state.activeSessionId);
		const base = { type, activeSessionId: state.activeSessionId } as const;

		await internals.handleCommand(client, {
			...base,
			message: "expanded prompt",
			queueKey: "heartbeat:expanded",
			agentMessageId: `agentmsg_expanded_${type}`,
		});
		const queue = type === "steer" ? steer : followUp;
		expect(queue).toHaveBeenCalledWith("expanded prompt", undefined, {
			queueKey: "heartbeat:expanded",
			agentMessageId: `agentmsg_expanded_${type}`,
			resumeIfIdle: true,
		});

		const replayFields = {
			content: [{ type: "text" as const, text: "restored content" }],
			customMessage: {
				role: "custom" as const,
				customType: "restored",
				content: "restored custom message",
				display: false,
				timestamp: 1,
			},
			prefixMessages: [
				{
					role: "custom" as const,
					customType: "restored-prefix",
					content: "restored prefix",
					display: false,
					timestamp: 1,
				},
			],
		};
		for (const expandPromptTemplates of [undefined, true]) {
			await expect(
				internals.handleCommand(client, {
					...base,
					message: "invalid replay",
					expandPromptTemplates,
					...replayFields,
				}),
			).rejects.toThrow("require expandPromptTemplates=false");
		}

		await internals.handleCommand(client, {
			...base,
			message: "restored prompt",
			queueKey: "heartbeat:job-1",
			agentMessageId: `agentmsg_${type}`,
			expandPromptTemplates: false,
			...replayFields,
		});
		const restore = type === "steer" ? restoreSteeringMessage : restoreFollowUpMessage;
		expect(restore).toHaveBeenCalledWith("restored prompt", undefined, {
			queueKey: "heartbeat:job-1",
			agentMessageId: `agentmsg_${type}`,
			...replayFields,
		});
		expect(queue).toHaveBeenCalledOnce();

		await expect(
			internals.handleCommand(client, { ...base, message: "invalid", agentMessageId: "" }),
		).rejects.toThrow("agentMessageId must not be empty");
	});

	it("rejects invalid heartbeat delivery modes before persisting", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-delivery-mode-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const sessionFile = join(tempDir, "session.jsonl");
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						sessionFile: string;
						sessionId: string;
					};
				};
			};
			state.runtime = {
				...state.runtime,
				cwd: tempDir,
				session: {
					sessionFile,
					sessionId: "session-1",
				},
			} as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);

			await expect(
				internals.handleCommand(makeClient("client-1", state.activeSessionId), {
					id: "command-1",
					type: "heartbeat_set",
					activeSessionId: state.activeSessionId,
					schedule: "every 5m",
					prompt: "check the run",
					deliveryMode: "followup" as never,
				}),
			).rejects.toThrow('Heartbeat delivery mode must be "steer" or "follow_up"');
			expect(internals.cronStore.getHeartbeat(state.activeSessionId)).toBeUndefined();
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves the current heartbeat delivery mode when replacement omits it", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-preserve-delivery-mode-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						removeQueuedFollowUp: ReturnType<typeof vi.fn>;
						sessionFile: string;
						sessionId: string;
					};
				};
			};
			state.runtime = {
				...state.runtime,
				cwd: tempDir,
				session: {
					removeQueuedFollowUp: vi.fn(() => false),
					sessionFile: join(tempDir, "session.jsonl"),
					sessionId: "session-1",
				},
			} as never;
			const internals = daemon as unknown as {
				sessions: Map<string, ActiveSessionState>;
				handleCommand(
					client: DaemonSocketClient,
					command: DaemonCommand,
				): Promise<{
					data: { heartbeat: AgentCronJob };
				}>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const client = makeClient("client-1", state.activeSessionId);

			await internals.handleCommand(client, {
				id: "command-1",
				type: "heartbeat_set",
				activeSessionId: state.activeSessionId,
				schedule: "every 5m",
				prompt: "first instruction",
				deliveryMode: "follow_up",
			});
			const replacement = await internals.handleCommand(client, {
				id: "command-2",
				type: "heartbeat_set",
				activeSessionId: state.activeSessionId,
				schedule: "every 10m",
				prompt: "replacement instruction",
			});

			expect(replacement.data.heartbeat).toMatchObject({
				prompt: "replacement instruction",
				deliveryMode: "follow_up",
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes queued RLM heartbeat follow-ups when only delivery mode changes", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-rlm-delivery-mode-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const removeQueuedFollowUp = vi.fn(() => true);
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						removeQueuedFollowUp: typeof removeQueuedFollowUp;
					};
				};
			};
			state.runtime.session = { removeQueuedFollowUp } as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				updateRlmHeartbeatForState(
					state: ActiveSessionState,
					input: { id: string; deliveryMode: "steer" | "follow_up" },
				): AgentCronJob | undefined;
			};
			const rlmHeartbeat = internals.cronStore.createRlmHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check internal state",
				deliveryMode: "follow_up",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			const updated = internals.updateRlmHeartbeatForState(state, {
				id: rlmHeartbeat.id,
				deliveryMode: "steer",
			});

			expect(updated).toMatchObject({ id: rlmHeartbeat.id, deliveryMode: "steer" });
			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${rlmHeartbeat.id}`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("removes queued heartbeat follow-ups when a heartbeat is cleared", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-heartbeat-clear-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const removeQueuedFollowUp = vi.fn(() => true);
			const state = makeState("active-1") as ActiveSessionState & {
				runtime: ActiveSessionState["runtime"] & {
					session: ActiveSessionState["runtime"]["session"] & {
						removeQueuedFollowUp: typeof removeQueuedFollowUp;
					};
				};
			};
			state.runtime.session = { removeQueuedFollowUp } as never;
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				sessions: Map<string, ActiveSessionState>;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			internals.sessions.set(state.activeSessionId, state);
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: state.activeSessionId,
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
				now: new Date("2026-01-01T12:00:00.000Z"),
			});

			await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
				id: "command-1",
				type: "heartbeat_update",
				activeSessionId: state.activeSessionId,
				action: "clear",
			});

			expect(removeQueuedFollowUp).toHaveBeenCalledWith(`heartbeat:${heartbeat.id}`);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("manages a persisted heartbeat after its session unloads", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "prime-agent-daemon-unloaded-heartbeat-"));
		try {
			const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
				defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
				createRuntime: async () => {
					throw new Error("unexpected runtime creation");
				},
			});
			const internals = daemon as unknown as {
				cronStore: AgentCronJobStore;
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			};
			const heartbeat = internals.cronStore.createHeartbeat({
				activeSessionId: "unloaded-session",
				sessionId: "session-1",
				sessionFile: join(tempDir, "session.jsonl"),
				cwd: tempDir,
				scheduleText: "every 5m",
				prompt: "check on the session",
			});

			const response = await internals.handleCommand(makeClient("client-1", "unloaded-session"), {
				id: "command-1",
				type: "heartbeat_manage",
				activeSessionId: "unloaded-session",
				jobId: heartbeat.id,
				action: "stop",
			});

			expect(response).toMatchObject({
				success: true,
				data: { heartbeat: { id: heartbeat.id, status: "cancelled" } },
			});
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("sets models without waiting for model_select extension handlers while running", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const setModel = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					modelRegistry: {
						refreshAvailableModels(): Promise<unknown[]>;
					};
					isStreaming: boolean;
					isCompacting: boolean;
					setModel(model: unknown, options?: { waitForExtensions?: boolean }): Promise<void>;
				};
			};
		};
		state.runtime.session = {
			modelRegistry: {
				refreshAvailableModels: vi.fn(async () => [model]),
			},
			isStreaming: true,
			isCompacting: false,
			setModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "set_model",
			activeSessionId: state.activeSessionId,
			provider: "faux",
			modelId: "faux-2",
		});

		expect(setModel).toHaveBeenCalledWith(model, { waitForExtensions: false });
	});

	it("waits for model_select extension handlers when setting models while idle", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const setModel = vi.fn(async () => {});
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					modelRegistry: {
						refreshAvailableModels(): Promise<unknown[]>;
					};
					isStreaming: boolean;
					isCompacting: boolean;
					setModel(model: unknown, options?: { waitForExtensions?: boolean }): Promise<void>;
				};
			};
		};
		state.runtime.session = {
			modelRegistry: {
				refreshAvailableModels: vi.fn(async () => [model]),
			},
			isStreaming: false,
			isCompacting: false,
			setModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "set_model",
			activeSessionId: state.activeSessionId,
			provider: "faux",
			modelId: "faux-2",
		});

		expect(setModel).toHaveBeenCalledWith(model, { waitForExtensions: true });
	});

	it("cycles models without waiting for model_select extension handlers while running", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const cycleResult = { model, thinkingLevel: "off" as const, isScoped: false };
		const cycleModel = vi.fn(async () => cycleResult);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isCompacting: boolean;
					cycleModel(
						direction?: "forward" | "backward",
						options?: { waitForExtensions?: boolean },
					): Promise<typeof cycleResult | undefined>;
				};
			};
		};
		state.runtime.session = {
			isStreaming: true,
			isCompacting: false,
			cycleModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "cycle_model",
			activeSessionId: state.activeSessionId,
			direction: "backward",
		});

		expect(cycleModel).toHaveBeenCalledWith("backward", { waitForExtensions: false });
	});

	it("waits for model_select extension handlers when cycling models while idle", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const model: Model<Api> = {
			provider: "faux",
			id: "faux-2",
			name: "Two",
			api: "openai-completions",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 4096,
		};
		const cycleResult = { model, thinkingLevel: "off" as const, isScoped: false };
		const cycleModel = vi.fn(async () => cycleResult);
		const state = makeState("active-1") as ActiveSessionState & {
			runtime: ActiveSessionState["runtime"] & {
				session: {
					isStreaming: boolean;
					isCompacting: boolean;
					cycleModel(
						direction?: "forward" | "backward",
						options?: { waitForExtensions?: boolean },
					): Promise<typeof cycleResult | undefined>;
				};
			};
		};
		state.runtime.session = {
			isStreaming: false,
			isCompacting: false,
			cycleModel,
		} as never;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
		};
		internals.sessions.set(state.activeSessionId, state);

		await internals.handleCommand(makeClient("client-1", state.activeSessionId), {
			id: "command-1",
			type: "cycle_model",
			activeSessionId: state.activeSessionId,
		});

		expect(cycleModel).toHaveBeenCalledWith(undefined, { waitForExtensions: true });
	});

	it("validates active sessions before reading a heartbeat", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
			defaultSessionConfig: {
				agentDir: "/tmp/prime-agent-test-agent",
				cwd: "/tmp",
			},
			createRuntime: async () => {
				throw new Error("unexpected runtime creation");
			},
		});
		const handleCommand = (
			daemon as unknown as {
				handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<unknown>;
			}
		).handleCommand.bind(daemon);

		await expect(
			handleCommand(makeClient("client-1", "missing"), {
				id: "command-1",
				type: "heartbeat_get",
				activeSessionId: "missing",
			}),
		).rejects.toThrow("Unknown active session: missing");
	});
});

type CronAdmissionActivity = Partial<{
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	hasPendingSessionWork: boolean;
	unfinishedActionCount: number;
}>;

function makeCronAdmissionFixture(
	activity: CronAdmissionActivity = {},
	options: { acceptingAgentMessage?: boolean } = {},
) {
	const activeSessionId = "active-1";
	const daemon = new AgentDaemon("/tmp/prime-agent-test.sock", {
		defaultSessionConfig: { agentDir: "/tmp/prime-agent-test-agent", cwd: "/tmp" },
		createRuntime: async () => {
			throw new Error("unexpected runtime creation");
		},
	});
	const prompt = vi.fn(
		async (
			_message: string,
			_options?: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string; source?: string },
		) => {},
	);
	const promptHeartbeat = vi.fn(
		async (
			_job: AgentCronJob,
			_options?: { streamingBehavior?: "steer" | "followUp"; followUpQueueKey?: string; source?: string },
		) => {},
	);
	const followUp = vi.fn(async () => true);
	const removeQueuedFollowUp = vi.fn(() => true);
	const state = makeState(activeSessionId) as ActiveSessionState & {
		runtime: ActiveSessionState["runtime"] & { session: Record<string, unknown> };
	};
	state.runtime = {
		...state.runtime,
		session: {
			isStreaming: false,
			isCompacting: false,
			isRetrying: false,
			isBashRunning: false,
			hasPendingSessionWork: options.acceptingAgentMessage === true,
			unfinishedActionCount: options.acceptingAgentMessage === true ? 1 : 0,
			...activity,
			prompt,
			promptUntilAccepted: prompt,
			promptHeartbeat,
			followUp,
			removeQueuedFollowUp,
		},
	} as never;
	const internals = daemon as unknown as {
		sessions: Map<string, ActiveSessionState>;
		runCronJob(job: AgentCronJob): Promise<"skipped" | undefined>;
	};
	internals.sessions.set(activeSessionId, state);

	return {
		activeSessionId,
		prompt,
		promptHeartbeat,
		followUp,
		removeQueuedFollowUp,
		runCronJob: internals.runCronJob.bind(daemon),
	};
}

function makeCronJob(input: {
	id: string;
	source: AgentCronJob["source"];
	activeSessionId: string;
	deliveryMode?: AgentCronJob["deliveryMode"];
}): AgentCronJob {
	return {
		id: input.id,
		status: "active",
		source: input.source,
		...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
		activeSessionId: input.activeSessionId,
		sessionId: "session-1",
		sessionFile: "/tmp/session.jsonl",
		cwd: "/tmp",
		prompt: "heartbeat prompt",
		schedule: { kind: "interval", expression: "every 5m", intervalMs: 300_000 },
		createdAt: "2026-01-01T12:00:00.000Z",
		updatedAt: "2026-01-01T12:00:00.000Z",
		nextRunAt: "2026-01-01T12:05:00.000Z",
		runCount: 0,
	};
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
