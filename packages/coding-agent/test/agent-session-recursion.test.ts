import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionMessageController,
	createAgentSessionMessage,
	isAgentSessionMessage,
} from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { LoadExtensionsResult } from "../src/core/extensions/index.js";
import { type HostRequestHandlers, KernelManager } from "../src/core/kernel/index.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	createDefaultRlmSubagentSessionName,
	createRlmDeleteSubagentHostHandler,
	createRlmRunHostHandler,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager, type SettingsStorage } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import type { BashOperations } from "../src/core/tools/bash.js";
import { type ActiveSessionState, resolveActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const lastMessage = context.messages[context.messages.length - 1] as AgentMessage | undefined;
	if (!lastMessage) return "";
	if (isAgentSessionMessage(lastMessage)) {
		return lastMessage.content.replace(/^\[task from parent\]\n\n/, "");
	}
	if (lastMessage.role !== "user") return "";
	if (typeof lastMessage.content === "string") {
		return lastMessage.content.replace(/^\[task from parent\]\n\n/, "");
	}
	const text = lastMessage.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return text.replace(/^\[task from parent\]\n\n/, "");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function assistantMessage(text: string, messageUsage = usage()): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: messageUsage,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = assistantMessage(text);
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

interface TestCommMessage {
	header: { msg_type: string };
	parent_header: Record<string, unknown>;
	metadata: Record<string, unknown>;
	content: Record<string, unknown>;
}

interface KernelCommTestApi {
	handleCommMessage(incoming: TestCommMessage): void;
	sendCommMessage(commId: string, data: Record<string, unknown>): Promise<void>;
}

interface CapturedCommReply {
	commId: string;
	data: Record<string, unknown>;
}

interface InspectableRlmRun {
	id: string;
	prompt?: string;
	sessionName?: string;
	sessionDir: string;
	model?: typeof model;
	abort: () => void;
	status: string;
	settled: boolean;
	error?: string;
	abandonedForQuiescence?: boolean;
	publication?: { promise: Promise<void>; resolve(): void; reject(error: Error): void };
	settlement?: { promise: Promise<void>; resolve(): void; reject(error: Error): void };
	detachedDeletion?: Awaited<ReturnType<AgentSession["listRlmSubagents"]>>["subagents"][number];
	session?: AgentSession;
}

interface InspectableRlmSession {
	_disposing: boolean;
	_activeRlmChildRuns: Map<string, InspectableRlmRun>;
	_unsettledRlmChildRuns: Set<InspectableRlmRun>;
	_deletingRlmChildren: Map<
		string,
		{
			subagent: Awaited<ReturnType<AgentSession["listRlmSubagents"]>>["subagents"][number];
			promise: Promise<unknown>;
		}
	>;
	_rlmChildCleanupFailures: Map<string, Awaited<ReturnType<AgentSession["listRlmSubagents"]>>["subagents"][number]>;
	_rlmChildSessions: Map<string, AgentSession>;
	_rlmChildUnsubscribes: Map<string, () => void>;
	_deletedRlmChildIds: Set<string>;
	_rlmQuiescenceWaitAborts: Set<AbortController>;
	_createKernelHostHandlers(): HostRequestHandlers;
	_reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void>;
}

interface KernelPumpTestApi {
	iopub: AsyncIterable<Buffer[]> & { close(): void };
	startIopubPump(): void;
}

interface KernelExecuteTestApi {
	start: () => Promise<void>;
	state: "idle" | "starting" | "running" | "shutdown";
	activeExecution?: unknown;
	shell?: {
		send(frames: Buffer[]): Promise<void>;
		close(): void;
	};
	connection?: {
		ip: string;
		transport: "tcp";
		shell_port: number;
		iopub_port: number;
		stdin_port: number;
		control_port: number;
		hb_port: number;
		signature_scheme: "hmac-sha256";
		key: string;
		kernel_name: string;
	};
}

function rlmCommOpenData(commId: string, data: Record<string, unknown>): TestCommMessage {
	return {
		header: { msg_type: "comm_open" },
		parent_header: {},
		metadata: {},
		content: {
			comm_id: commId,
			target_name: "host.request",
			data,
		},
	};
}

function rlmCommOpen(commId: string, prompt: string, kwargs: Record<string, unknown> = {}): TestCommMessage {
	return rlmCommOpenData(commId, { type: "rlm.run", prompt, kwargs });
}

function encodeTestMessage(message: TestCommMessage): Buffer[] {
	return [
		Buffer.from("<IDS|MSG>"),
		Buffer.from(""),
		Buffer.from(JSON.stringify(message.header)),
		Buffer.from(JSON.stringify(message.parent_header)),
		Buffer.from(JSON.stringify(message.metadata)),
		Buffer.from(JSON.stringify(message.content)),
	];
}

function asyncFrames(frames: Buffer[][]): AsyncIterable<Buffer[]> & { close(): void } {
	return {
		close: () => {},
		async *[Symbol.asyncIterator]() {
			for (const frame of frames) {
				await sleep(0);
				yield frame;
			}
		},
	};
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for condition");
		}
		await sleep(10);
	}
}

async function expectSettlesWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
	const result = await Promise.race([
		promise.then(() => "settled" as const),
		sleep(timeoutMs).then(() => "timeout" as const),
	]);
	expect(result).toBe("settled");
}

function findLastMessage(
	messages: readonly AgentMessage[],
	predicate: (message: AgentMessage) => boolean,
): AgentMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message && predicate(message)) return message;
	}
	return undefined;
}

function deferred<T = void>(): {
	promise: Promise<T>;
	resolve: (value: T | PromiseLike<T>) => void;
	reject: (reason?: unknown) => void;
} {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

describe("AgentSession rlm recursion", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-recursion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		options: {
			depth?: number;
			maxDepth?: number;
			streamFn?: StreamFn;
			agentMessageController?: AgentSessionMessageController;
			subagentRuntimeHost?: SubagentRuntimeHost;
			customTools?: ConstructorParameters<typeof AgentSession>[0]["customTools"];
			rlmSessionDir?: string;
			sessionManager?: SessionManager;
			settingsManager?: SettingsManager;
			extensionsResult?: LoadExtensionsResult;
		} = {},
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = options.settingsManager ?? SettingsManager.create(tempDir, tempDir);

		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "",
				tools: [],
				thinkingLevel: "off",
			},
			streamFn: options.streamFn ?? ((_model, context) => streamAnswer(`child answer: ${userText(context)}`)),
		});

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({
				extensionsResult: options.extensionsResult,
				skills: options.agentMessageController
					? [
							{
								name: "agent-message",
								description: "test",
								filePath: join(tempDir, "SKILL.md"),
								baseDir: tempDir,
								sourceInfo: createSyntheticSourceInfo(join(tempDir, "SKILL.md"), { source: "test" }),
								disableModelInvocation: false,
								kind: "python",
								python: {
									importName: "agent_message",
									packagePath: tempDir,
									pyprojectPath: join(tempDir, "pyproject.toml"),
								},
							},
						]
					: undefined,
			}),
			agentMessageController: options.agentMessageController,
			subagentRuntimeHost: options.subagentRuntimeHost,
			customTools: options.customTools,
			rlmDepth: options.depth,
			rlmMaxDepth: options.maxDepth,
			rlmSessionDir: options.rlmSessionDir,
		});
		return session;
	}

	function createAbortInsensitiveChild(): {
		child: AgentSession;
		completion: ReturnType<typeof deferred<void>>;
		hasStarted: () => boolean;
	} {
		const completion = deferred<void>();
		let started = false;
		const child = createSession({
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				started = true;
				void completion.promise.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("child stopped") });
				});
				return stream;
			},
		});
		vi.spyOn(child, "abort").mockResolvedValue();
		return { child, completion, hasStarted: () => started };
	}

	it("propagates skipped-running deletion outcomes through the host handler", async () => {
		const subagent = {
			rlm_child_id: "running-child",
			active_session_id: "running-session",
			session_id: "running-session",
			session_name: "running-worker",
			session_dir: join(tempDir, "running-child"),
			status: "running" as const,
		};
		const deleteHandler = createRlmDeleteSubagentHostHandler(async () => ({
			subagent,
			outcome: "skipped_running",
		}));

		await expect(deleteHandler({ target: subagent.rlm_child_id })).resolves.toEqual({
			subagent,
			outcome: "skipped_running",
		});
	});

	it("persists RLM_DEPTH for a fresh session and reports the seeded depth", () => {
		vi.stubEnv("RLM_DEPTH", "1");
		try {
			const fresh = createSession({ maxDepth: 2 });
			fresh.sessionManager.flushNow();
			if (!fresh.sessionFile) throw new Error("Missing fresh session file");

			const header = JSON.parse(readFileSync(fresh.sessionFile, "utf8").split("\n")[0] ?? "{}");
			expect(header.rlmDepth).toBe(1);
			expect(fresh.rlmDepth).toBe(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("prefers persisted depth over RLM_DEPTH when resuming a session", () => {
		const persistedManager = SessionManager.create(tempDir, join(tempDir, "resumed-sessions"));
		persistedManager.newSession({ rlmDepth: 2 });
		persistedManager.flushNow();
		vi.stubEnv("RLM_DEPTH", "1");
		try {
			const resumed = createSession({ maxDepth: 3, sessionManager: persistedManager });
			expect(resumed.rlmDepth).toBe(2);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it.each([-1, "0"])("ignores invalid persisted RLM depth %j", (invalidDepth) => {
		const persistedManager = SessionManager.create(tempDir, join(tempDir, "invalid-depth-sessions"));
		persistedManager.newSession({ rlmDepth: 2 });
		persistedManager.flushNow();
		const sessionFile = persistedManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing persisted session file");
		const lines = readFileSync(sessionFile, "utf8").split("\n");
		lines[0] = JSON.stringify({ ...JSON.parse(lines[0] ?? "{}"), rlmDepth: invalidDepth });
		writeFileSync(sessionFile, lines.join("\n"));
		const reopened = SessionManager.open(sessionFile, join(tempDir, "invalid-depth-sessions"));
		vi.stubEnv("RLM_DEPTH", "1");
		try {
			expect(createSession({ maxDepth: 2, sessionManager: reopened }).rlmDepth).toBe(1);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps a forked root at depth zero so recursion remains allowed", async () => {
		const source = SessionManager.create(tempDir, join(tempDir, "source-sessions"));
		source.newSession({ rlmDepth: 0 });
		source.appendMessage({ role: "user", content: "source prompt", timestamp: 1 });
		source.flushNow();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("Missing source session file");
		const forkedManager = SessionManager.forkFrom(sourceFile, tempDir, join(tempDir, "forked-sessions"));
		const forked = createSession({ maxDepth: 1, sessionManager: forkedManager });

		expect(forked.rlmDepth).toBe(0);
		const spawned = await forked.runRlmChild("recursion remains available");
		expect(spawned.rlm_child_id).toMatch(/^sub-/);
		await waitFor(() => forked.getRlmChildSession(spawned.rlm_child_id)?.getLastAssistantText() !== undefined);
	});

	it("creates readable collision-resistant default subagent session names", () => {
		expect(createDefaultRlmSubagentSessionName("Summarize the HTTP API!", "sub-a1b2c3d4")).toBe(
			"subagent-summarize-the-http-api-a1b2c3d4",
		);
		expect(createDefaultRlmSubagentSessionName("Summarize the HTTP API!", "sub-eeeeffff")).not.toBe(
			createDefaultRlmSubagentSessionName("Summarize the HTTP API!", "sub-a1b2c3d4"),
		);
		expect(createDefaultRlmSubagentSessionName("same task", "sub-aBcDeFgH")).not.toBe(
			createDefaultRlmSubagentSessionName("same task", "sub-AbCdEfGh"),
		);
		expect(createDefaultRlmSubagentSessionName("x".repeat(200), "sub-a1b2c3d4")).toHaveLength(64);
	});

	it("persists the spawned child's parent edge and derived runtime depth in its header", async () => {
		const root = createSession({ depth: 2, maxDepth: 4 });
		const result = await root.runRlmChild("persist my tree position");
		if (!result.session_dir) throw new Error("Missing child session directory");
		const child = root.getRlmChildSession(basename(result.session_dir));
		if (!child?.sessionFile || !root.sessionFile) throw new Error("Missing persisted session paths");

		const header = JSON.parse(readFileSync(child.sessionFile, "utf8").split("\n")[0] ?? "{}");
		expect(header).toMatchObject({ parentSession: root.sessionFile, rlmDepth: 3 });
		expect(child.rlmDepth).toBe(3);
	});

	it("lets the orchestrator choose a unique subagent session name", async () => {
		const root = createSession();
		const result = await root.runRlmChild("inspect the API", { name: "  api-reviewer  " });
		if (!result.session_dir) {
			throw new Error("Missing child session directory");
		}
		const childId = basename(result.session_dir);
		const childSession = root.getRlmChildSession(childId);
		if (!childSession) {
			throw new Error("Missing retained child session");
		}
		expect(childSession.sessionName).toBe("api-reviewer");
		expect((await root.listRlmSubagents()).subagents[0]?.session_name).toBe("api-reviewer");

		await expect(root.runRlmChild("inspect another API", { name: "api-reviewer" })).rejects.toThrow(
			'Agent name "api-reviewer" is unavailable: an agent of that name already exists at depth 1 under this parent',
		);
		await expect(root.runRlmChild("invalid name", { name: "   " })).rejects.toThrow("rlm.run name must not be empty");
		await expect(root.runRlmChild("reserved name", { name: "all" })).rejects.toThrow(
			"Broadcast agent messaging is not supported",
		);
	});

	it("falls back to listed family metadata when a controller lacks name validation", async () => {
		const listAgents = vi.fn(() => ({
			current: { activeSessionId: "parent-active", sessionId: "unrelated-current" },
			agents: [
				{
					activeSessionId: "passive-active",
					sessionId: "passive-session",
					sessionName: "passive-worker",
					runtimeKind: "subagent" as const,
					cwd: tempDir,
					isStreaming: false,
					unfinishedActionCount: 0,
					parentSessionId: "parent-session",
					parentSessionPath: parentPath,
					rlmDepth: 1,
					status: "idle" as const,
				},
				{
					activeSessionId: "other-active",
					sessionId: "other-session",
					sessionName: "other-family-worker",
					runtimeKind: "subagent" as const,
					cwd: tempDir,
					isStreaming: false,
					unfinishedActionCount: 0,
					parentSessionId: "other-parent",
					rlmDepth: 1,
				},
			],
		}));
		const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		manager.newSession({ id: "parent-session" });
		const parentPath = manager.getSessionFile();
		if (!parentPath) throw new Error("Missing parent session path");
		const root = createSession({
			sessionManager: manager,
			agentMessageController: {
				listAgents,
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});

		await expect(root.runRlmChild("duplicate passive", { name: "passive-worker" })).rejects.toThrow(
			'Agent name "passive-worker" is unavailable',
		);
		await expect(root.runRlmChild("different family", { name: "other-family-worker" })).resolves.toMatchObject({
			name: "other-family-worker",
		});
		expect(listAgents).toHaveBeenCalled();
	});

	it("throws loud ambiguity when a child name equals a sibling session id for send and delete", async () => {
		const first = createSession({ rlmSessionDir: join(tempDir, "first") });
		const second = createSession({ rlmSessionDir: join(tempDir, "second") });
		second.setSessionName(first.sessionId);
		const root = createSession();
		expect(root.registerRlmChildSession("first-child", first)).toBe(true);
		expect(root.registerRlmChildSession("second-child", second)).toBe(true);
		const states = new Map<string, ActiveSessionState>([
			[
				"first-active",
				{
					activeSessionId: "first-active",
					runtime: { session: first },
				} as ActiveSessionState,
			],
			[
				"second-active",
				{
					activeSessionId: "second-active",
					runtime: { session: second },
				} as ActiveSessionState,
			],
		]);

		expect(() => resolveActiveSessionState(states, first.sessionId)).toThrow("Ambiguous active session");
		await expect(root.deleteRlmSubagent(first.sessionId)).rejects.toThrow("is ambiguous");
	});

	it("reserves a running child's current name after it is renamed", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(`child answer: ${userText(context)}`),
					});
				});
				return stream;
			},
		});
		const runPromise = root.runRlmChild("rename while running", { name: "spawn-worker" });
		await waitFor(() => childStarted);
		const running = (await root.listRlmSubagents()).subagents[0];
		if (!running) {
			throw new Error("Missing running child");
		}
		if (!running.session_id) {
			throw new Error("Missing running child session ID");
		}
		root.getRlmChildSession(running.rlm_child_id)?.setSessionName("renamed-running-worker");
		expect((await root.listRlmSubagents()).subagents[0]?.session_name).toBe("renamed-running-worker");

		await expect(root.runRlmChild("reuse renamed selector", { name: "renamed-running-worker" })).rejects.toThrow(
			'Agent name "renamed-running-worker" is unavailable: an agent of that name already exists at depth 1 under this parent',
		);
		releaseChild();
		await runPromise;
	});

	it("makes an externally restored retained child listable and deletable", async () => {
		const childId = "restored-child";
		const childDir = join(tempDir, childId);
		mkdirSync(childDir, { recursive: true });
		const child = createSession({ rlmSessionDir: childDir });
		child.setSessionName("restored-worker");
		const disposeChild = vi.spyOn(child, "disposeAsync");
		const root = createSession();
		const childStatuses: string[] = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update" && event.child.id === childId) {
				childStatuses.push(event.child.status);
			}
		});

		expect(root.registerRlmChildSession(childId, child)).toBe(true);
		expect((await root.listRlmSubagents()).subagents).toEqual([
			expect.objectContaining({
				rlm_child_id: childId,
				session_name: "restored-worker",
				status: "completed",
			}),
		]);

		await expect(root.deleteRlmSubagent("restored-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: childId, session_name: "restored-worker" },
		});
		expect(disposeChild).toHaveBeenCalledOnce();
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(childStatuses).toEqual(["cancelled"]);
	});

	it("retries and releases failed retained child cleanup on the next compaction", async () => {
		const childId = "retained-retry-child";
		const childDir = join(tempDir, childId);
		mkdirSync(childDir, { recursive: true });
		const child = createSession({ rlmSessionDir: childDir });
		child.setSessionName("retained-retry-worker");
		let deleteAttempts = 0;
		const deleteRuntime = vi.fn(async (_childId: string, session: AgentSession) => {
			deleteAttempts++;
			if (deleteAttempts === 1) {
				throw new Error("retained close failed");
			}
			await session.disposeAsync();
		});
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
		const extensionsResult = await createTestExtensionsResult([
			(pi) => {
				pi.on("session_before_compact", async (event) => ({
					compaction: {
						summary: "cleanup retry compaction",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						details: { source: "extension" },
					},
				}));
			},
		]);
		const root = createSession({
			settingsManager,
			extensionsResult,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});
		root.sessionManager.appendMessage({ role: "user", content: "history before cleanup", timestamp: Date.now() });
		root.sessionManager.appendMessage(assistantMessage("history response"));
		expect(root.registerRlmChildSession(childId, child)).toBe(true);

		await expect(root.deleteRlmSubagent("retained-retry-worker")).rejects.toThrow("retained close failed");
		const internals = root as unknown as InspectableRlmSession;
		expect(internals._rlmChildCleanupFailures.size).toBe(1);

		await root.compact();

		expect(deleteRuntime).toHaveBeenCalledTimes(2);
		expect(internals._rlmChildCleanupFailures.size).toBe(0);
		expect(internals._rlmChildSessions.size).toBe(0);
		await expect(root.runRlmChild("replacement", { name: "retained-retry-worker" })).resolves.toMatchObject({
			name: "retained-retry-worker",
		});
	});

	it("keeps live nested children visible when their direct parent is hidden by deletion", () => {
		const root = createSession();
		const rootInternals = root as unknown as InspectableRlmSession;
		const hiddenParents = [
			{ id: "deleted-parent", hiding: "deleted" as const },
			{ id: "deleting-parent", hiding: "deleting" as const },
			{ id: "detached-parent", hiding: "detached" as const },
		];
		const parentInternalsToClear: InspectableRlmSession[] = [];

		for (const [index, { id, hiding }] of hiddenParents.entries()) {
			const parent = createSession({ rlmSessionDir: join(tempDir, id) });
			const parentInternals = parent as unknown as InspectableRlmSession;
			parentInternalsToClear.push(parentInternals);
			const nestedId = `${id}-live-grandchild`;
			parentInternals._activeRlmChildRuns.set(nestedId, {
				id: nestedId,
				prompt: "still working",
				sessionName: nestedId,
				sessionDir: join(tempDir, nestedId),
				model,
				abort: () => {},
				status: index === 1 ? "queued" : "running",
				settled: false,
			});

			if (hiding === "detached") {
				rootInternals._activeRlmChildRuns.set(id, {
					id,
					prompt: "hidden parent",
					sessionName: id,
					sessionDir: join(tempDir, id),
					model,
					abort: () => {},
					status: "cancelled",
					settled: false,
					detachedDeletion: {
						rlm_child_id: id,
						active_session_id: null,
						session_id: null,
						session_name: id,
						session_dir: join(tempDir, id),
						status: "running",
					},
					session: parent,
				});
				// The same child can be visible in both lifecycle registries while
				// deletion settles; it must be traversed exactly once and remain hidden.
				rootInternals._rlmChildSessions.set(id, parent);
			} else {
				rootInternals._rlmChildSessions.set(id, parent);
				if (hiding === "deleted") {
					rootInternals._deletedRlmChildIds.add(id);
				} else {
					rootInternals._deletingRlmChildren.set(id, {
						subagent: {
							rlm_child_id: id,
							active_session_id: null,
							session_id: null,
							session_name: id,
							session_dir: join(tempDir, id),
							status: "completed",
						},
						promise: Promise.resolve({
							subagent: {
								rlm_child_id: id,
								active_session_id: null,
								session_id: null,
								session_name: id,
								session_dir: join(tempDir, id),
								status: "completed",
							},
						}),
					});
				}
			}
		}

		const snapshots = root.getRlmChildSnapshots();
		expect(snapshots.map((snapshot) => snapshot.id).sort()).toEqual(
			hiddenParents.map(({ id }) => `${id}-live-grandchild`).sort(),
		);
		expect(snapshots.map((snapshot) => snapshot.status).sort()).toEqual(["queued", "running", "running"]);
		// These are deliberately minimal lifecycle records; remove them before
		// fixture teardown asks real runs to settle.
		rootInternals._activeRlmChildRuns.clear();
		rootInternals._rlmChildSessions.clear();
		for (const parentInternals of parentInternalsToClear) parentInternals._activeRlmChildRuns.clear();
		root.dispose();
	});

	it("makes an orchestrator-chosen name override a custom runtime's preexisting name", async () => {
		const hostedChild = createSession();
		hostedChild.setSessionName("factory-assigned-name");
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		await root.runRlmChild("inspect custom runtime", { name: "orchestrator-name" });

		expect(hostedChild.sessionName).toBe("orchestrator-name");
	});

	it("runs a child session under a sub directory and returns an RLM-shaped result", async () => {
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({
					current: { activeSessionId: "root-active", sessionId: "root-session" },
					agents: [],
				}),
				sendAgentMessage: vi.fn(),
			},
		});
		const childUpdates: Array<{
			status: string;
			label: string;
			answerPreview?: string;
			tokenCount?: number;
			toolUseCount?: number;
		}> = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				childUpdates.push(event.child);
			}
		});

		const result = await root.runRlmChild("summarize shard 1");

		expect(result.rlm_child_id).toBe(basename(result.session_dir));
		expect(result.session_dir).not.toBeNull();
		expect(basename(result.session_dir!)).toMatch(/^sub-/);
		expect(dirname(result.session_dir!)).toBe(root.sessionManager.getSessionArtifactDir());
		expect(existsSync(result.session_dir!)).toBe(true);
		await waitFor(() => readdirSync(result.session_dir).some((name) => name.endsWith(".jsonl")));
		expect(childUpdates[0]?.status).toBe("queued");
		expect(childUpdates[0]?.label).toBe("summarize shard 1");
		await waitFor(() => childUpdates.some((update) => update.status === "done"));
		const doneUpdate = [...childUpdates].reverse().find((update) => update.status === "done");
		expect(doneUpdate?.answerPreview).toBe("child answer: summarize shard 1");
		const child = root.getRlmChildSession(result.rlm_child_id);
		expect(child?.messages[0]).toMatchObject({
			role: "custom",
			customType: "agent_message",
			content: "[task from parent]\n\nsummarize shard 1",
			display: true,
			details: {
				id: `spawn:${result.rlm_child_id}`,
				message: "summarize shard 1",
				from: { sessionId: root.sessionId, activeSessionId: "root-active" },
				fromRelationship: "parent",
			},
		});
		// Context tokens from the child's own assistant usage (input 7 + output 3); no tools ran.
		expect(doneUpdate?.tokenCount).toBe(10);
		expect(doneUpdate?.toolUseCount).toBeUndefined();
	});

	it("marks an in-cell roled send to the parent as replied", async () => {
		const sendAgentMessage = vi.fn(async () => ({
			id: "agentmsg-reply",
			source: "agent_message" as const,
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			message: "done",
			deliveryStatus: "delivered" as const,
		}));
		const child = createSession({
			depth: 1,
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({
					current: { name: "child", id: "child-session", depth: 1 },
					entries: [{ relationship: "parent", name: "parent", id: "parent-session", depth: 0, status: "idle" }],
				}),
				sendAgentMessage,
			},
		});
		const handlers = (child as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const send = handlers["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		expect(child.repliedToParentSinceTask).toBe(false);
		await expect(send({ message: "done", receiver_role: "parent" })).resolves.toMatchObject({
			message: "done",
		});
		expect(sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ target: "parent-session", message: "done" }),
		);
		expect(child.repliedToParentSinceTask).toBe(true);
	});

	it("resolves a spawned child handle to its published session before a roled send", async () => {
		let publishChild: (() => void) | undefined;
		const publicationGate = new Promise<void>((resolve) => {
			publishChild = resolve;
		});
		let publishedChild: AgentSession | undefined;
		const sendAgentMessage = vi.fn(async (input: { target: string; message: string }) => ({
			id: "agentmsg-child",
			source: "agent_message" as const,
			target: { activeSessionId: "child-active", sessionId: input.target },
			message: input.message,
			deliveryStatus: "delivered" as const,
		}));
		const roster = vi.fn(() => ({
			current: { name: "root", id: root.sessionId, depth: 0 },
			entries: publishedChild
				? [
						{
							relationship: "child" as const,
							name: publishedChild.sessionName ?? publishedChild.sessionId,
							id: publishedChild.sessionId,
							depth: 1,
							status: "running" as const,
						},
					]
				: [],
		}));
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster,
				sendAgentMessage,
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async (options) => {
					await publicationGate;
					const child = createSession({ rlmSessionDir: options.sessionDir });
					child.setSessionName(options.sessionName);
					publishedChild = child;
					options.onSessionPublished?.(child);
					return { session: child };
				},
				deleteRlmSubagentRuntime: async (_id, child) => child?.disposeAsync(),
			},
		});
		const spawned = await root.runRlmChild("pending task", { name: "pending-child" });
		const handlers = (root as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const send = handlers["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		const pendingSend = send({
			message: "hello",
			receiver_role: "child",
			receiver_name: spawned.rlm_child_id,
		});
		await sleep(0);
		expect(roster).not.toHaveBeenCalled();
		expect(sendAgentMessage).not.toHaveBeenCalled();
		publishChild?.();

		await expect(pendingSend).resolves.toMatchObject({ message: "hello" });
		expect(roster).toHaveBeenCalledTimes(1);
		expect(sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ target: publishedChild?.sessionId, message: "hello" }),
		);
	});

	it("delivers an id-addressed send after a completed child durably admits its terminal notice", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "completed-child") });
		const sendAgentMessage = vi.fn(async (input: { target: string; message: string }) => ({
			id: "agentmsg-completed-child",
			source: "agent_message" as const,
			target: { activeSessionId: "child-active", sessionId: input.target },
			message: input.message,
			deliveryStatus: "delivered" as const,
		}));
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({
					current: { name: "root", id: root.sessionId, depth: 0 },
					entries: [
						{
							relationship: "child" as const,
							name: child.sessionName ?? child.sessionId,
							id: child.sessionId,
							depth: 1,
							status: "idle" as const,
						},
					],
				}),
				sendAgentMessage,
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async (_id, session) => session?.disposeAsync(),
			},
		});
		const spawned = await root.runRlmChild("completed task", { name: "completed-worker" });
		await waitFor(() => root.getRlmChildSession(spawned.rlm_child_id) === child);
		const internals = root as unknown as InspectableRlmSession;
		const send = internals._createKernelHostHandlers()["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		await expect(
			send({ message: "follow-up", receiver_role: "child", receiver_name: spawned.rlm_child_id }),
		).resolves.toMatchObject({ message: "follow-up" });
		expect(sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ target: child.sessionId, message: "follow-up" }),
		);
	});

	it("propagates pending child startup failure to an immediate roled send", async () => {
		let rejectStartup: ((error: Error) => void) | undefined;
		const startupGate = new Promise<never>((_resolve, reject) => {
			rejectStartup = reject;
		});
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({
					current: { name: "root", id: root.sessionId, depth: 0 },
					entries: [],
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: () => startupGate,
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		const spawned = await root.runRlmChild("pending task", { name: "failing-child" });
		const handlers = (root as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const send = handlers["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		const pendingSend = send({ message: "hello", receiver_role: "child", receiver_name: spawned.name });
		rejectStartup?.(new Error("child startup failed"));

		await expect(pendingSend).rejects.toThrow("child startup failed");
	});

	it("falls through a retained failed child name to a healthy roster child", async () => {
		let releaseFailureInjection: () => void = () => {};
		const failureInjectionGate = new Promise<void>((resolve) => {
			releaseFailureInjection = resolve;
		});
		const sendAgentMessage = vi.fn(async (input: { target: string; message: string }) => ({
			id: "agentmsg-healthy-child",
			source: "agent_message" as const,
			target: { activeSessionId: "healthy-active", sessionId: input.target },
			message: input.message,
			deliveryStatus: "delivered" as const,
		}));
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({
					current: { name: "root", id: root.sessionId, depth: 0 },
					entries: [
						{
							relationship: "child" as const,
							name: "shared-child",
							id: "healthy-child-session",
							depth: 1,
							status: "idle" as const,
						},
					],
				}),
				sendAgentMessage,
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("child startup failed");
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		const promptInjectedMessage = vi.fn(async () => failureInjectionGate);
		(root as unknown as { _promptInjectedMessage: typeof promptInjectedMessage })._promptInjectedMessage =
			promptInjectedMessage;
		await root.runRlmChild("failing task", { name: "shared-child" });
		await waitFor(() =>
			[...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.values()].some(
				(run) => run.status === "error",
			),
		);
		const handlers = (root as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const send = handlers["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		await expect(
			send({ message: "hello", receiver_role: "child", receiver_name: "shared-child" }),
		).resolves.toMatchObject({ message: "hello" });
		expect(sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ target: "healthy-child-session", message: "hello" }),
		);
		releaseFailureInjection();
	});

	it("falls through a delete-before-startup tombstone during a roled send", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const hostedChild = createSession();
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({
					current: { name: "root", id: root.sessionId, depth: 0 },
					entries: [],
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: async (_id, child) => child?.disposeAsync(),
			},
		});
		await root.runRlmChild("blocked startup", { name: "deleted-child" });
		await waitFor(() => runtimeCreationStarted);
		await root.deleteRlmSubagent("deleted-child");
		const handlers = (root as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const send = handlers["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		await expect(send({ message: "hello", receiver_role: "child", receiver_name: "deleted-child" })).rejects.toThrow(
			'No child matches "deleted-child"',
		);
		releaseRuntimeCreation();
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);
	});

	it("marks a broadcast delivery to the parent as replied without reloading the roster", async () => {
		const roster = vi.fn(() => ({
			current: { name: "child", id: "child-session", depth: 1 },
			entries: [
				{
					relationship: "parent" as const,
					name: "parent",
					id: "parent-session",
					depth: 0,
					status: "idle" as const,
				},
			],
		}));
		const sendAgentMessage = vi.fn(async () => ({
			id: "agentmsg-broadcast-reply",
			source: "agent_message" as const,
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			message: "status",
			deliveryStatus: "delivered" as const,
		}));
		const child = createSession({
			depth: 1,
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster,
				sendAgentMessage,
			},
		});
		const handlers = (child as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const send = handlers["agent_message.send"];
		if (!send) throw new Error("Missing agent_message.send host handler");

		await expect(send({ target: "all", message: "status" })).resolves.toMatchObject({
			receipts: [{ message: "status" }],
		});
		expect(roster).toHaveBeenCalledTimes(1);
		expect(child.repliedToParentSinceTask).toBe(true);
	});

	it("routes family messages with sender-perspective labels and resets parent steer reply state", async () => {
		const parent = createSession();
		parent.setSessionName("parent");
		const child = createSession({ depth: 1 });
		child.setSessionName("worker");
		(child as unknown as { _repliedToParentSinceTask: boolean })._repliedToParentSinceTask = true;

		const daemon = new AgentDaemon(join(tempDir, "daemon.sock"), {
			defaultSessionConfig: { agentDir: tempDir, cwd: tempDir },
			createRuntime: vi.fn(),
		});
		const parentState = {
			activeSessionId: "parent-active",
			clients: new Set(),
			pendingAttaches: 0,
			lastEventSequence: 0,
			runtime: {
				metadata: { kind: "top-level", createdAt: 1 },
				session: parent,
			},
		} as unknown as ActiveSessionState;
		const childState = {
			activeSessionId: "child-active",
			clients: new Set(),
			pendingAttaches: 0,
			lastEventSequence: 0,
			runtime: {
				metadata: {
					kind: "subagent",
					createdAt: 1,
					parentActiveSessionId: "parent-active",
					parentSessionId: parent.sessionId,
				},
				session: child,
			},
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			sendAgentSessionMessage(options: {
				targetSelector: string;
				message: string;
				fromState: ActiveSessionState;
				origin: "agent";
			}): Promise<unknown>;
		};
		internals.sessions.set(parentState.activeSessionId, parentState);
		internals.sessions.set(childState.activeSessionId, childState);

		await internals.sendAgentSessionMessage({
			targetSelector: parentState.activeSessionId,
			message: "done",
			fromState: childState,
			origin: "agent",
		});
		const reply = findLastMessage(parent.messages, isAgentSessionMessage);
		expect(reply && isAgentSessionMessage(reply) ? reply.content : undefined).toContain("[from child:worker]");

		await internals.sendAgentSessionMessage({
			targetSelector: childState.activeSessionId,
			message: "continue",
			fromState: parentState,
			origin: "agent",
		});
		const steer = findLastMessage(child.messages, isAgentSessionMessage);
		expect(steer && isAgentSessionMessage(steer) ? steer.content : undefined).toContain("[from parent]");
		expect(child.repliedToParentSinceTask).toBe(false);
	});

	it("resets replied state when a parent message is accepted", async () => {
		const child = createSession({ depth: 1 });
		(child as unknown as { _repliedToParentSinceTask: boolean })._repliedToParentSinceTask = true;
		const message = createAgentSessionMessage({
			id: "agentmsg-parent-task",
			source: "agent_message",
			message: "new task",
			fromRelationship: "parent",
			target: { activeSessionId: "child-active", sessionId: child.sessionId },
		});

		await child.acceptAgentMessagePrompt(message.content as string, { customMessage: message });

		expect(child.repliedToParentSinceTask).toBe(false);
	});

	it("resets replied state when a parent follow-up is queued", async () => {
		const child = createSession({ depth: 1 });
		(child as unknown as { _repliedToParentSinceTask: boolean })._repliedToParentSinceTask = true;
		const message = createAgentSessionMessage({
			id: "agentmsg-parent-follow-up",
			source: "agent_message",
			message: "continue",
			fromRelationship: "parent",
			target: { activeSessionId: "child-active", sessionId: child.sessionId },
		});

		await child.queueAgentMessagePrompt(message.content as string, "followUp", message);

		expect(child.repliedToParentSinceTask).toBe(false);
	});

	it("leaves replied state unknown when a child session is rehydrated", () => {
		const manager = SessionManager.create(tempDir, join(tempDir, "resumed-child"));
		manager.newSession({ rlmDepth: 1 });
		manager.appendMessage({ role: "user", content: "previous task", timestamp: 1 });
		manager.flushNow();

		const resumed = createSession({ depth: 1, sessionManager: manager });
		expect(resumed.repliedToParentSinceTask).toBeUndefined();
	});

	it("surfaces post-admission startup failure in the parent transcript and subagent registry", async () => {
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("kernel startup failed");
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("start failing child", { name: "failing-worker" });
		await vi.waitFor(async () => {
			expect((await root.listRlmSubagents()).subagents).toContainEqual(
				expect.objectContaining({ rlm_child_id: spawned.rlm_child_id, status: "error" }),
			);
		});
		await vi.waitFor(() => {
			expect(root.messages).toContainEqual(
				expect.objectContaining({
					role: "custom",
					customType: "rlm_child_failure",
					content: expect.stringContaining("failing-worker"),
				}),
			);
			expect(root.messages).toContainEqual(
				expect.objectContaining({ content: expect.stringContaining("kernel startup failed") }),
			);
		});
	});

	it("injects exactly one cancellation notice when a child run is cancelled", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("late child answer") });
				});
				return stream;
			},
		});

		const spawned = await root.runRlmChild("slow child", { name: "cancel-worker" });
		await waitFor(() => childStarted);
		expect(root.cancelRlmChildRun(spawned.rlm_child_id)).toBe(true);
		releaseChild();
		await vi.waitFor(() => {
			const notices = root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				content: expect.stringContaining(
					`RLM child cancel-worker (${spawned.rlm_child_id}) was cancelled: Cancelled by user`,
				),
				details: { kind: "cancelled", reason: "Cancelled by user" },
			});
		});
	});

	it("injects exactly one notice with a preview when a child completes without replying", async () => {
		const root = createSession();

		const spawned = await root.runRlmChild("silent child", { name: "silent-worker" });
		await vi.waitFor(() => {
			const notices = root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toMatchObject({
				content: expect.stringContaining(
					`RLM child silent-worker (${spawned.rlm_child_id}) completed without sending a reply`,
				),
				details: {
					kind: "completed_without_reply",
					lastAssistantTextPreview: "child answer: silent child",
				},
			});
		});
	});

	it("suppresses a done child's unsettled fallback notice at the cancellation cut", async () => {
		const root = createSession();
		let suppressed = false;
		root.subscribe((event) => {
			if (event.type === "rlm_child_update" && event.child.status === "done") {
				suppressed = root.cancelRlmChildRun(event.child.id);
			}
		});

		await root.runRlmChild("silent child at cancellation cut", { name: "suppressed-worker" });
		await root.waitForRlmQuiescence();
		expect(suppressed).toBe(true);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);
	});

	it("does not inject a terminal notice when a parent follow-up resets reply state after a reply", async () => {
		const child = createSession({
			depth: 1,
			rlmSessionDir: join(tempDir, "replying-child"),
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({
					current: { name: "reply-worker", id: child.sessionId, depth: 1 },
					entries: [{ relationship: "parent", name: "parent", id: "parent-session", depth: 0, status: "idle" }],
				}),
				sendAgentMessage: async () => ({
					id: "agentmsg-reply-before-follow-up",
					source: "agent_message",
					target: { activeSessionId: "parent-active", sessionId: "parent-session" },
					message: "done",
					deliveryStatus: "delivered",
				}),
			},
		});
		vi.spyOn(child, "promptAndWait").mockImplementation(async () => {
			const send = (child as unknown as InspectableRlmSession)._createKernelHostHandlers()["agent_message.send"];
			if (!send) throw new Error("Missing agent_message.send host handler");
			await send({ message: "done", receiver_role: "parent" });
			const followUp = createAgentSessionMessage({
				id: "agentmsg-parent-follow-up-after-reply",
				source: "agent_message",
				message: "continue cleanup",
				fromRelationship: "parent",
				target: { activeSessionId: "child-active", sessionId: child.sessionId },
			});
			await child.queueAgentMessagePrompt(followUp.content as string, "followUp", followUp);
			expect(child.repliedToParentSinceTask).toBe(false);
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("reply first", { name: "reply-worker" });
		await vi.waitFor(async () => {
			expect((await root.listRlmSubagents()).subagents).toContainEqual(
				expect.objectContaining({ rlm_child_id: spawned.rlm_child_id, status: "completed" }),
			);
		});
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);
	});

	it("notifies after detached startup deletion cleanup settles", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const child = createSession({ rlmSessionDir: join(tempDir, "deleted-child") });
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: child };
				},
				deleteRlmSubagentRuntime: async (_id, session) => session?.disposeAsync(),
			},
		});

		const spawned = await root.runRlmChild("delete before startup", { name: "deleted-worker" });
		await waitFor(() => runtimeCreationStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		releaseRuntimeCreation();
		await waitFor(() => !(root as unknown as InspectableRlmSession)._activeRlmChildRuns.has(spawned.rlm_child_id));
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ kind: "cancelled", reason: "Deleted by parent orchestrator" }),
			}),
		]);
	});

	it("fully deletes a settled startup failure and frees its session name", async () => {
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("kernel startup failed");
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		const spawned = await root.runRlmChild("start failing child", { name: "reusable-worker" });
		const internals = root as unknown as InspectableRlmSession;
		await vi.waitFor(() => expect(internals._activeRlmChildRuns.get(spawned.rlm_child_id)?.settled).toBe(true));

		await expect(root.deleteRlmSubagent(spawned.rlm_child_id)).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id, session_name: "reusable-worker" },
		});

		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
		await expect(root.runRlmChild("replacement child", { name: "reusable-worker" })).resolves.toMatchObject({
			name: "reusable-worker",
		});
	});

	it("releases a hosted child when its initial task fails", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "host-error-child") });
		vi.spyOn(child, "promptAndWait").mockRejectedValue(new Error("child prompt failed"));
		const releaseRlmSubagentRuntime = vi.fn(async () => {});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				releaseRlmSubagentRuntime,
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("fail hosted child");
		await vi.waitFor(() => {
			expect(releaseRlmSubagentRuntime).toHaveBeenCalledWith(
				expect.objectContaining({ session: child }),
				expect.objectContaining({ id: spawned.rlm_child_id }),
				"error",
			);
		});
	});

	it("strong quiescence yields to a real gated child bash while interactive idle remains resolved", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "bash-active-child") });
		const bashStarted = deferred<void>();
		const bashCompletion = deferred<void>();
		const operations: BashOperations = {
			exec: async () => {
				bashStarted.resolve();
				await bashCompletion.promise;
				return { exitCode: 0 };
			},
		};
		const bash = child.executeBash("gated", undefined, { operations });
		await bashStarted.promise;

		await expect(child.waitForIdle()).resolves.toBeUndefined();
		const root = createSession();
		expect(root.registerRlmChildSession("bash-active-child", child)).toBe(true);
		const originalHeadlessIdle = child.waitForHeadlessIdle.bind(child);
		let headlessIdleCalls = 0;
		vi.spyOn(child, "waitForHeadlessIdle").mockImplementation(async () => {
			if (++headlessIdleCalls > 100) throw new Error("RLM quiescence spun without yielding a macrotask");
			await originalHeadlessIdle();
		});

		const quiescence = root.waitForRlmQuiescence();
		const firstBoundary = await Promise.race([
			quiescence.then(
				() => "resolved" as const,
				() => "rejected" as const,
			),
			sleep(20).then(() => "timer" as const),
		]);
		expect(firstBoundary).toBe("timer");

		bashCompletion.resolve();
		await bash;
		await expect(quiescence).resolves.toBeUndefined();
		expect(headlessIdleCalls).toBeLessThan(100);
	});

	it("rechecks parent self-activity after a child quiescence boundary", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "boundary-active-child") });
		const childBashStarted = deferred<void>();
		const childBashCompletion = deferred<void>();
		const childBash = child.executeBash("child-boundary-gate", undefined, {
			operations: {
				exec: async () => {
					childBashStarted.resolve();
					await childBashCompletion.promise;
					return { exitCode: 0 };
				},
			},
		});
		await childBashStarted.promise;
		const parentBashStarted = deferred<void>();
		const parentBashCompletion = deferred<void>();
		const root = createSession();
		expect(root.registerRlmChildSession("boundary-active-child", child)).toBe(true);
		const originalChildQuiescence = child.waitForRlmQuiescence.bind(child);
		const childWaitStarted = deferred<void>();
		let parentBash: Promise<unknown> | undefined;
		vi.spyOn(child, "waitForRlmQuiescence").mockImplementation(async (signal) => {
			childWaitStarted.resolve();
			await originalChildQuiescence(signal);
			parentBash = root.executeBash("parent-boundary-gate", undefined, {
				operations: {
					exec: async () => {
						parentBashStarted.resolve();
						await parentBashCompletion.promise;
						return { exitCode: 0 };
					},
				},
			});
		});

		const quiescence = root.waitForRlmQuiescence();
		await childWaitStarted.promise;
		childBashCompletion.resolve();
		await childBash;
		const parentBoundaryStarted = await Promise.race([
			parentBashStarted.promise.then(() => true),
			sleep(200).then(() => false),
		]);
		expect(parentBoundaryStarted).toBe(true);
		const boundary = await Promise.race([
			quiescence.then(() => "quiesced" as const),
			sleep(20).then(() => "active" as const),
		]);
		expect(boundary).toBe("active");

		parentBashCompletion.resolve();
		await parentBash;
		const finalBoundary = await Promise.race([
			quiescence.then(() => "quiesced" as const),
			sleep(200).then(() => "blocked" as const),
		]);
		expect(finalBoundary).toBe("quiesced");
	});

	it("propagates root quiescence cancellation into a child self-active waiter", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "cancelled-bash-active-child") });
		const bashStarted = deferred<void>();
		const bashCompletion = deferred<void>();
		const operations: BashOperations = {
			exec: async () => {
				bashStarted.resolve();
				await bashCompletion.promise;
				return { exitCode: 0 };
			},
		};
		const bash = child.executeBash("cancelled-gate", undefined, { operations });
		await bashStarted.promise;
		const root = createSession();
		expect(root.registerRlmChildSession("cancelled-bash-active-child", child)).toBe(true);

		const quiescence = root.waitForRlmQuiescence();
		await vi.waitFor(() => expect((child as unknown as InspectableRlmSession)._rlmQuiescenceWaitAborts.size).toBe(1));
		root.requestAbort();
		await expect(quiescence).rejects.toThrow("RLM quiescence wait cancelled");
		expect(child.isBashRunning).toBe(true);
		expect((child as unknown as InspectableRlmSession)._rlmQuiescenceWaitAborts.size).toBe(0);

		bashCompletion.resolve();
		await bash;
	});

	it("cancels sibling recursive waiters when one child quiescence wait fails", async () => {
		const childAStarted = deferred<void>();
		const childACompletion = deferred<void>();
		const childA = createSession({ rlmSessionDir: join(tempDir, "failing-wait-child") });
		const childABash = childA.executeBash("child-a-gate", undefined, {
			operations: {
				exec: async () => {
					childAStarted.resolve();
					await childACompletion.promise;
					return { exitCode: 0 };
				},
			},
		});
		const childBStarted = deferred<void>();
		const childBCompletion = deferred<void>();
		const childB = createSession({ rlmSessionDir: join(tempDir, "sibling-wait-child") });
		const childBBash = childB.executeBash("child-b-gate", undefined, {
			operations: {
				exec: async () => {
					childBStarted.resolve();
					await childBCompletion.promise;
					return { exitCode: 0 };
				},
			},
		});
		await Promise.all([childAStarted.promise, childBStarted.promise]);
		const root = createSession();
		expect(root.registerRlmChildSession("failing-wait-child", childA)).toBe(true);
		expect(root.registerRlmChildSession("sibling-wait-child", childB)).toBe(true);

		const quiescence = root.waitForRlmQuiescence();
		await vi.waitFor(() => {
			expect((childA as unknown as InspectableRlmSession)._rlmQuiescenceWaitAborts.size).toBe(1);
			expect((childB as unknown as InspectableRlmSession)._rlmQuiescenceWaitAborts.size).toBe(1);
		});
		childA.requestAbort();
		await expect(quiescence).rejects.toThrow("RLM quiescence wait cancelled");
		await vi.waitFor(() =>
			expect((childB as unknown as InspectableRlmSession)._rlmQuiescenceWaitAborts.size).toBe(0),
		);
		expect(childB.isBashRunning).toBe(true);

		childACompletion.resolve();
		childBCompletion.resolve();
		await Promise.all([childABash, childBBash]);
	});

	it("durably defers a child terminal notice across ACP-style input pause and scheduler suspension", async () => {
		const childStarted = deferred<void>();
		const childCompletion = deferred<void>();
		const synthesizedAgentMessageSend = vi.fn(async () => ({
			id: "unexpected-synthesized-send",
			source: "agent_message" as const,
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			message: "unexpected",
			deliveryStatus: "delivered" as const,
		}));
		const child = createSession({
			rlmSessionDir: join(tempDir, "paused-terminal-child"),
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				roster: () => ({ current: { name: "child", id: "child", depth: 1 }, entries: [] }),
				sendAgentMessage: synthesizedAgentMessageSend,
			},
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				childStarted.resolve();
				void childCompletion.promise.then(() => {
					stream.push({
						type: "done",
						reason: "stop",
						message: assistantMessage(`child answer: ${userText(context)}`),
					});
				});
				return stream;
			},
		});
		let parentNoticeTurns = 0;
		const root = createSession({
			streamFn: () => {
				parentNoticeTurns++;
				return streamAnswer("parent processed terminal notice");
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		await root.runRlmChild("finish during ACP close", { name: "paused-terminal-worker" });
		await childStarted.promise;
		const inputPause = root.acquireSessionInputPause();
		root.requestAbort();
		await expect(root.prompt("external prompt", { resumeIfIdle: false })).rejects.toThrow(
			"session input admission is paused",
		);

		childCompletion.resolve();
		const internals = root as unknown as InspectableRlmSession;
		const deferredNotices = () =>
			root
				.getPendingNextTurnMessageSnapshots()
				.filter((message) => message.customType === "rlm_child_terminal_notice");
		await vi.waitFor(() => expect(deferredNotices()).toHaveLength(1));
		expect(synthesizedAgentMessageSend).not.toHaveBeenCalled();
		const restartSnapshot = root.getPendingNextTurnMessageSnapshots();
		await vi.waitFor(() => expect(internals._unsettledRlmChildRuns.size).toBe(0));
		expect(root.unfinishedActionCount).toBe(0);
		const closeIdleBoundary = await Promise.race([
			root.waitForIdle().then(() => "idle" as const),
			sleep(50).then(() => "blocked" as const),
		]);
		expect(closeIdleBoundary).toBe("idle");
		const quiescence = root.waitForRlmQuiescence();
		const strongBoundary = await Promise.race([
			quiescence.then(() => "quiesced" as const),
			sleep(20).then(() => "paused" as const),
		]);
		expect(strongBoundary).toBe("paused");
		expect(root.clearQueue()).toEqual({ steering: [], followUp: [] });
		expect(deferredNotices()).toHaveLength(1);

		root.resumeQueuedWork();
		await expect(root.waitForIdle()).resolves.toBeUndefined();
		expect(parentNoticeTurns).toBe(0);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);

		inputPause.release();
		await expect(quiescence).resolves.toBeUndefined();
		expect(parentNoticeTurns).toBe(1);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(1);

		let restoredNoticeTurns = 0;
		const restored = createSession({
			streamFn: () => {
				restoredNoticeTurns++;
				return streamAnswer("restored parent processed terminal notice");
			},
		});
		restored.restorePendingNextTurnMessages(restartSnapshot);
		await restored.waitForRlmQuiescence();
		expect(restoredNoticeTurns).toBe(1);
		expect(
			restored.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(1);
		root.dispose();
	});

	it("demotes a pre-admitted terminal action when ACP close suspends before delivery", async () => {
		const childStarted = deferred<void>();
		const childCompletion = deferred<void>();
		const child = createSession({
			rlmSessionDir: join(tempDir, "pre-admitted-terminal-child"),
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted.resolve();
				void childCompletion.promise.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("child finished") });
				});
				return stream;
			},
		});
		let parentNoticeTurns = 0;
		const root = createSession({
			streamFn: () => {
				parentNoticeTurns++;
				return streamAnswer("parent processed pre-admitted terminal notice");
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		await root.runRlmChild("finish before ACP close cut", { name: "pre-admitted-terminal-worker" });
		await childStarted.promise;
		const dispatchGate = vi
			.spyOn(root as unknown as { _scheduleSessionInputPump(): void }, "_scheduleSessionInputPump")
			.mockImplementation(() => {});
		childCompletion.resolve();
		await vi.waitFor(() => expect(root.unfinishedActionCount).toBe(1));
		expect(
			root
				.getPendingNextTurnMessageSnapshots()
				.filter((message) => message.customType === "rlm_child_terminal_notice"),
		).toHaveLength(0);

		const inputPause = root.acquireSessionInputPause();
		root.requestAbort();
		await vi.waitFor(() => expect(root.unfinishedActionCount).toBe(0));
		expect(
			root
				.getPendingNextTurnMessageSnapshots()
				.filter((message) => message.customType === "rlm_child_terminal_notice"),
		).toHaveLength(1);
		dispatchGate.mockRestore();
		await expect(root.waitForIdle()).resolves.toBeUndefined();
		expect(root.clearQueue()).toEqual({ steering: [], followUp: [] });

		root.resumeQueuedWork();
		inputPause.release();
		await root.waitForRlmQuiescence();
		expect(parentNoticeTurns).toBe(1);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(1);
	});

	it("linearizes terminal retention after an update checkpoint snapshot", async () => {
		const childStarted = deferred<void>();
		const childCompletion = deferred<void>();
		const child = createSession({
			rlmSessionDir: join(tempDir, "update-checkpoint-terminal-child"),
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted.resolve();
				void childCompletion.promise.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("child finished for update") });
				});
				return stream;
			},
		});
		let parentNoticeTurns = 0;
		const root = createSession({
			streamFn: () => {
				parentNoticeTurns++;
				return streamAnswer("parent processed update terminal notice");
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("finish at update snapshot", { name: "update-terminal-worker" });
		await childStarted.promise;
		const updatePause = root.acquireQueuedWorkPause();
		childCompletion.resolve();
		const internals = root as unknown as InspectableRlmSession;
		await vi.waitFor(() => expect(internals._activeRlmChildRuns.get(spawned.rlm_child_id)?.status).toBe("done"));
		await root.waitForSessionInputCheckpoint();
		const pendingSnapshot = root.getPendingNextTurnMessageSnapshots();
		const actionSnapshot = root.getSessionActionRecoverySnapshot();
		expect(pendingSnapshot.filter((message) => message.customType === "rlm_child_terminal_notice")).toHaveLength(0);
		expect(
			actionSnapshot.actions.filter(
				(action) =>
					action.payload.kind === "turn" &&
					action.payload.customMessage?.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);
		expect(internals._unsettledRlmChildRuns.size).toBe(1);
		expect(internals._activeRlmChildRuns.get(spawned.rlm_child_id)?.settled).toBe(false);

		updatePause.release();
		await root.waitForRlmQuiescence();
		expect(parentNoticeTurns).toBe(1);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(1);
	});

	it("keeps settled error deletion in quiescence through cleanup retry", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "settled-error-child") });
		vi.spyOn(child, "promptAndWait").mockRejectedValue(new Error("child prompt failed"));
		const firstCleanup = deferred<void>();
		const retryCleanup = deferred<void>();
		let cleanupAttempts = 0;
		const deleteRlmSubagentRuntime = vi.fn(async (_id: string, session?: AgentSession) => {
			const cleanup = ++cleanupAttempts === 1 ? firstCleanup.promise : retryCleanup.promise;
			await cleanup;
			await session?.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				releaseRlmSubagentRuntime: async () => {},
				deleteRlmSubagentRuntime,
			},
		});

		const spawned = await root.runRlmChild("fail after startup", { name: "settled-error-worker" });
		const internals = root as unknown as InspectableRlmSession;
		await vi.waitFor(() => expect(internals._activeRlmChildRuns.get(spawned.rlm_child_id)?.settled).toBe(true));
		const run = internals._activeRlmChildRuns.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing settled error run");
		expect(run.status).toBe("error");
		expect(run.session).toBe(child);
		expect(internals._rlmChildSessions.has(spawned.rlm_child_id)).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(false);

		await expect(root.deleteRlmSubagent("settled-error-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		await expect(root.deleteRlmSubagent(spawned.rlm_child_id)).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		expect(deleteRlmSubagentRuntime).toHaveBeenCalledOnce();
		expect(run.settled).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(true);
		let quiesced = false;
		const quiescence = root.waitForRlmQuiescence().then(() => {
			quiesced = true;
		});
		await sleep(20);
		expect(quiesced).toBe(false);

		firstCleanup.reject(new Error("first cleanup failed"));
		await waitFor(() => internals._rlmChildCleanupFailures.has(spawned.rlm_child_id));
		await sleep(20);
		expect(quiesced).toBe(false);
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(true);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(true);
		await expect(root.runRlmChild("replacement before retry", { name: "settled-error-worker" })).rejects.toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);

		await expect(root.deleteRlmSubagent("settled-error-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		await expect(root.deleteRlmSubagent(spawned.rlm_child_id)).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		expect(deleteRlmSubagentRuntime).toHaveBeenCalledTimes(2);
		await sleep(20);
		expect(quiesced).toBe(false);

		retryCleanup.resolve();
		await quiescence;
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(false);
		expect(internals._deletingRlmChildren.has(spawned.rlm_child_id)).toBe(false);
		expect(deleteRlmSubagentRuntime).toHaveBeenCalledTimes(2);
		await expect(
			root.runRlmChild("replacement after cleanup", { name: "settled-error-worker" }),
		).resolves.toMatchObject({
			name: "settled-error-worker",
		});
	});

	it("notifies the runtime host when the initial child task completes", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "host-completion-child") });
		const completeRlmSubagentRuntime = vi.fn(() => true);
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				completeRlmSubagentRuntime,
				deleteRlmSubagentRuntime: async (_id, session) => session?.disposeAsync(),
			},
		});

		const spawned = await root.runRlmChild("persist completion");
		await vi.waitFor(() => {
			expect(completeRlmSubagentRuntime).toHaveBeenCalledWith(spawned.rlm_child_id, child);
		});
		expect((await root.listRlmSubagents()).subagents).toContainEqual(
			expect.objectContaining({ rlm_child_id: spawned.rlm_child_id, status: "completed" }),
		);
	});

	it("projects retained child follow-up turns into parent child-update activity", async () => {
		let releaseInitial: () => void = () => {};
		const initialGate = new Promise<void>((resolve) => {
			releaseInitial = resolve;
		});
		let releaseFollowUp: () => void = () => {};
		const followUpGate = new Promise<void>((resolve) => {
			releaseFollowUp = resolve;
		});
		const events: Array<{ status: string; activity?: { kind: string } }> = [];
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				void (text === "initial" ? initialGate : followUpGate).then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`answer: ${text}`) });
				});
				return stream;
			},
		});
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				events.push({ status: event.child.status, activity: event.child.activity });
			}
		});

		const spawned = await root.runRlmChild("initial");
		await waitFor(() => events.some((event) => event.status === "running" && event.activity?.kind === "waiting"));
		releaseInitial();
		await waitFor(() => root.getRlmChildSession(spawned.rlm_child_id) !== undefined);
		await waitFor(() => events.at(-1)?.status === "done" && events.at(-1)?.activity === undefined);

		const child = root.getRlmChildSession(spawned.rlm_child_id);
		if (!child) throw new Error("Missing retained child session");
		const followUp = child.prompt("follow-up");
		await waitFor(() => events.at(-1)?.status === "done" && events.at(-1)?.activity?.kind === "waiting");
		releaseFollowUp();
		await followUp;
		await waitFor(() => events.at(-1)?.status === "done" && events.at(-1)?.activity === undefined);
	});

	it("lists a completed child with its parent-scoped messaging identity until disposal", async () => {
		let daemonChildId = "";
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({
					current: { activeSessionId: "parent-active", sessionId: "parent-session" },
					agents: [
						{
							activeSessionId: "other-child-active",
							sessionId: "other-child-session",
							runtimeKind: "subagent",
							cwd: tempDir,
							isStreaming: false,
							unfinishedActionCount: 0,
							parentActiveSessionId: "other-parent",
							rlmChildId: daemonChildId,
						},
						{
							activeSessionId: "child-active",
							sessionId: "child-session",
							runtimeKind: "subagent",
							cwd: tempDir,
							isStreaming: false,
							unfinishedActionCount: 0,
							parentActiveSessionId: "parent-active",
							rlmChildId: daemonChildId,
						},
					],
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});

		const result = await root.runRlmChild("retained worker");
		if (!result.session_dir) {
			throw new Error("Missing child session directory");
		}
		daemonChildId = basename(result.session_dir);
		await waitFor(() => root.getRlmChildSession(daemonChildId)?.getLastAssistantText() !== undefined);

		expect(root.getRlmChildSession(daemonChildId)?.getLastAssistantText()).toBe("child answer: retained worker");
		const expectedSessionName = createDefaultRlmSubagentSessionName("retained worker", daemonChildId);
		expect(root.getRlmChildSession(daemonChildId)?.sessionName).toBe(expectedSessionName);
		const expectedRegistry = {
			subagents: [
				{
					rlm_child_id: daemonChildId,
					active_session_id: "child-active",
					session_id: "child-session",
					session_name: expectedSessionName,
					session_dir: result.session_dir,
					status: "completed",
				},
			],
		};
		expect(await root.listRlmSubagents()).toEqual(expectedRegistry);
		const inspectable = root as unknown as InspectableRlmSession;
		const conflictingDeletion = {
			...expectedRegistry.subagents[0],
			rlm_child_id: "deleting-child",
			session_name: daemonChildId,
			status: "completed" as const,
		};
		inspectable._deletingRlmChildren.set("deleting-child", {
			subagent: conflictingDeletion,
			promise: Promise.resolve({ subagent: conflictingDeletion }),
		});
		await expect(root.deleteRlmSubagent(daemonChildId)).rejects.toThrow("is ambiguous");
		inspectable._deletingRlmChildren.delete("deleting-child");

		const handlers = inspectable._createKernelHostHandlers();
		const listHandler = handlers["rlm.list_subagents"];
		const deleteHandler = handlers["rlm.delete_subagent"];
		if (!listHandler || !deleteHandler) {
			throw new Error("Missing RLM subagent registry host handlers");
		}
		await expect(listHandler({})).resolves.toEqual(expectedRegistry);
		await expect(deleteHandler({ target: expectedSessionName })).resolves.toEqual({
			subagent: expectedRegistry.subagents[0],
		});
		expect(root.getRlmChildSession(daemonChildId)).toBeUndefined();
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(deleteHandler({ target: expectedSessionName })).rejects.toThrow("No direct RLM subagent matches");

		root.dispose();

		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("lists passive daemon children using their nonresident registry outcomes", async () => {
		const deleteRlmSubagentRuntime = vi.fn(async () => {});
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({
					current: { activeSessionId: "parent-active", sessionId: "parent-session" },
					agents: (
						[
							["failed", "running"],
							["finished", "completed"],
						] as const
					).map(([name, registryStatus]) => ({
						activeSessionId: `${name}-session`,
						sessionId: `${name}-session`,
						sessionName: `${name}-worker`,
						runtimeKind: "subagent",
						cwd: tempDir,
						isStreaming: false,
						unfinishedActionCount: 0,
						parentActiveSessionId: "parent-active",
						rlmChildId: `${name}-child`,
						rlmChildRegistryStatus: registryStatus,
						sessionDir: join(tempDir, `${name}-child`),
					})),
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("unexpected hydration");
				},
				deleteRlmSubagentRuntime,
			},
		});
		const expected = [
			{
				rlm_child_id: "failed-child",
				active_session_id: "failed-session",
				session_id: "failed-session",
				session_name: "failed-worker",
				session_dir: join(tempDir, "failed-child"),
				status: "error" as const,
			},
			{
				rlm_child_id: "finished-child",
				active_session_id: "finished-session",
				session_id: "finished-session",
				session_name: "finished-worker",
				session_dir: join(tempDir, "finished-child"),
				status: "completed" as const,
			},
		];

		expect(await root.listRlmSubagents()).toEqual({ subagents: expected });
		await expect(root.deleteRlmSubagent("finished-worker")).resolves.toEqual({ subagent: expected[1] });
		expect(deleteRlmSubagentRuntime).toHaveBeenCalledWith("finished-child", undefined);
		expect(await root.listRlmSubagents()).toEqual({ subagents: [expected[0]] });
	});

	it("coalesces concurrent deletion of the same passive daemon child", async () => {
		let releaseListing!: () => void;
		const listingGate = new Promise<void>((resolve) => {
			releaseListing = resolve;
		});
		const deleteRlmSubagentRuntime = vi.fn(async () => {});
		const root = createSession({
			agentMessageController: {
				listAgents: async () => {
					await listingGate;
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [
							{
								activeSessionId: "passive-session",
								sessionId: "passive-session",
								sessionName: "passive-worker",
								runtimeKind: "subagent" as const,
								cwd: tempDir,
								isStreaming: false,
								unfinishedActionCount: 0,
								parentActiveSessionId: "parent-active",
								rlmChildId: "passive-child",
								sessionDir: join(tempDir, "passive-child"),
							},
						],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("unexpected hydration");
				},
				deleteRlmSubagentRuntime,
			},
		});

		const first = root.deleteRlmSubagent("passive-worker");
		const second = root.deleteRlmSubagent("passive-worker");
		releaseListing();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(deleteRlmSubagentRuntime).toHaveBeenCalledOnce();
	});

	it("disposes an inline child when setting its session name fails", async () => {
		const root = createSession();
		const appendSessionInfo = vi.spyOn(SessionManager.prototype, "appendSessionInfo").mockImplementation(() => {
			throw new Error("session info failed");
		});
		const dispose = vi.spyOn(AgentSession.prototype, "dispose");
		try {
			const spawned = await root.runRlmChild("inline naming failure", { name: "bad-name" });
			expect(spawned.rlm_child_id).toMatch(/^sub-/);
			await waitFor(() => dispose.mock.calls.length > 0);
		} finally {
			appendSessionInfo.mockRestore();
			dispose.mockRestore();
		}
	});

	it("emits updated child session names after a retained child is renamed", async () => {
		const root = createSession();
		const events: unknown[] = [];
		root.subscribe((event) => events.push(event));

		const result = await root.runRlmChild("rename after completion", { name: "original-worker" });
		if (!result.session_dir) {
			throw new Error("Missing child session directory");
		}
		const childId = basename(result.session_dir);
		const child = root.getRlmChildSession(childId);
		if (!child) {
			throw new Error("Missing retained child session");
		}

		child.setSessionName("renamed-worker");

		const childUpdates = events.filter(
			(event): event is { type: "rlm_child_update"; child: { sessionName?: string } } =>
				typeof event === "object" && event !== null && (event as { type?: string }).type === "rlm_child_update",
		);
		expect(childUpdates.at(-1)?.child.sessionName).toBe("renamed-worker");
	});

	it("surfaces a child's recap on its snapshot once the summarizer sets it", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		let root: AgentSession;
		root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
				});
				return stream;
			},
			agentMessageController: {
				listAgents: () => {
					const run = [...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.values()][0];
					return {
						current: { activeSessionId: "parent-active", sessionId: root.sessionId },
						agents: run?.session
							? [
									{
										activeSessionId: "running-active",
										sessionId: run.session.sessionId,
										runtimeKind: "subagent" as const,
										cwd: tempDir,
										isStreaming: true,
										unfinishedActionCount: 0,
										parentActiveSessionId: "parent-active",
										rlmChildId: run.id,
										sessionDir: run.sessionDir,
									},
								]
							: [],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
		});

		const recaps: Array<string | undefined> = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				recaps.push(event.child.recap);
			}
		});

		await root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const rootRun = [...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.values()][0];
		if (!rootRun?.session) {
			throw new Error("Missing child session on root run");
		}
		expect(await root.listRlmSubagents()).toEqual({
			subagents: [
				{
					rlm_child_id: rootRun.id,
					active_session_id: "running-active",
					session_id: rootRun.session.sessionId,
					session_name: createDefaultRlmSubagentSessionName("slow shard", rootRun.id),
					session_dir: rootRun.sessionDir,
					status: "running",
				},
			],
		});

		// What the daemon summarizer does for subagents: stash the recap on the session,
		// which emits recap_update and re-emits the parent's enriched child snapshot.
		rootRun.session.setCurrentRecap("Summarizing the slow shard");
		await waitFor(() => recaps.includes("Summarizing the slow shard"));

		releaseChild();
		await waitFor(() => rootRun.status === "done");
	});

	it("runs a child agent without requiring ripgrep", async () => {
		const streamFn = vi.fn((_model, context: Context) => streamAnswer(`child answer: ${userText(context)}`));
		const root = createSession({ streamFn });

		const result = await root.runRlmChild("summarize shard 1");

		expect(result.rlm_child_id).toMatch(/^sub-/);
		await waitFor(() => streamFn.mock.calls.length >= 1);
	});

	it("adds child usage to the parent session aggregate", async () => {
		const root = createSession();
		const parentAssistant = assistantMessage("running ipython", usage(0, 0));
		root.agent.state.messages.push(parentAssistant);
		root.sessionManager.appendMessage(parentAssistant);

		const before = root.getSessionStats();
		await root.runRlmChild("summarize shard 2");
		await waitFor(() => root.sessionManager.getEntries().some((entry) => entry.type === "child_usage_attributed"));
		const after = root.getSessionStats();

		expect(after.tokens.input).toBeGreaterThanOrEqual(before.tokens.input + 7);
		expect(after.tokens.output).toBeGreaterThanOrEqual(before.tokens.output + 3);
		expect(after.tokens.total).toBeGreaterThanOrEqual(before.tokens.total + 10);
		expect(after.cost).toBeGreaterThanOrEqual(before.cost + 10);
		expect(parentAssistant.usage.totalTokens).toBe(0);

		const parentEntry = root.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message === parentAssistant);
		if (!parentEntry || parentEntry.type !== "message" || parentEntry.message.role !== "assistant") {
			throw new Error("parent assistant entry was not recorded");
		}
		expect(parentEntry.message.usage.input).toBe(7);
		expect(parentEntry.message.usage.output).toBe(3);
		expect(parentEntry.message.usage.cost.total).toBe(10);

		const sessionFile = root.sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("parent session file was not created");
		expect(readFileSync(sessionFile, "utf-8")).toContain('"type":"child_usage_attributed"');
		const reloaded = SessionManager.open(sessionFile, join(tempDir, "sessions"));
		const attribution = reloaded.getEntries().find((entry) => entry.type === "child_usage_attributed");
		if (!attribution || attribution.type !== "child_usage_attributed") throw new Error("missing attribution");
		expect(attribution.childUsage.input).toBe(7);
		expect(attribution.childUsage.output).toBe(3);
		expect(attribution.aggregateUsage.cost.total).toBe(10);
	});

	it("attributes every tool-loop turn in the admitted task to spawn usage", async () => {
		const tool = {
			name: "echo",
			description: "Echo a value",
			label: "echo",
			parameters: Type.Object({ value: Type.String() }),
			execute: async (_toolCallId: string, params: { value: string }) => ({
				content: [{ type: "text" as const, text: params.value }],
				details: {},
			}),
		};
		const root = createSession({
			customTools: [tool],
			streamFn: (_model, context) => {
				const toolResultCount = context.messages.filter((message) => message.role === "toolResult").length;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message =
						toolResultCount === 0
							? {
									...assistantMessage("", usage(1, 1)),
									content: [
										{ type: "toolCall" as const, id: "echo-1", name: "echo", arguments: { value: "ok" } },
									],
									stopReason: "toolUse" as const,
								}
							: assistantMessage("done", usage(2, 2));
					stream.push({
						type: "done",
						reason: toolResultCount === 0 ? "toolUse" : "stop",
						message,
					});
				});
				return stream;
			},
		});
		const parentAssistant = assistantMessage("running ipython", usage(0, 0));
		root.agent.state.messages.push(parentAssistant);
		root.sessionManager.appendMessage(parentAssistant);

		await root.runRlmChild("use a tool");
		await vi.waitFor(() => {
			const attributions = root.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "child_usage_attributed");
			expect(attributions).toHaveLength(2);
			expect(attributions.map((entry) => entry.origin)).toEqual(["spawn_task", "spawn_task"]);
		});
	});

	it("gets and persists per-chat max-depth changes without transcript messages", async () => {
		const root = createSession();
		const originalMessages = [...root.messages];

		expect(root.getRlmMaxDepthStatus()).toEqual({ maxDepth: 1, source: "default" });
		await expect(root.setRlmMaxDepth(-1)).rejects.toThrow("non-negative integer");
		await root.setRlmMaxDepth(3);

		expect(root.getRlmMaxDepthStatus()).toEqual({ maxDepth: 3, source: "chat" });
		expect(root.messages).toEqual(originalMessages);
		const stateEntries = root.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "rlm_max_depth_state");
		expect(stateEntries.at(-1)).toMatchObject({ data: { maxDepth: 3 } });
	});

	it("applies max-depth immediately while a turn streams without aborting or entering the transcript", async () => {
		let releaseTurn!: () => void;
		const release = new Promise<void>((resolve) => {
			releaseTurn = resolve;
		});
		let turnStarted = false;
		const root = createSession({
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				turnStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("finished normally") });
				});
				return stream;
			},
		});

		const promptPromise = root.prompt("keep streaming");
		await waitFor(() => turnStarted);
		const messagesBeforeSet = [...root.messages];
		await root.setRlmMaxDepth(2);
		expect(root.rlmMaxDepth).toBe(2);
		expect(root.messages).toEqual(messagesBeforeSet);
		expect(root.isStreaming).toBe(true);

		releaseTurn();
		await promptPromise;
		await root.agent.waitForIdle();
		expect(root.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
	});

	it("uses a max-depth prompt update on the next turn of the active run", async () => {
		let releaseFirstTurn = () => {};
		const firstTurnPending = new Promise<void>((resolve) => {
			releaseFirstTurn = resolve;
		});
		const seenSystemPrompts: string[] = [];
		const root = createSession({
			streamFn: (_model, context) => {
				seenSystemPrompts.push(context.systemPrompt ?? "");
				if (seenSystemPrompts.length === 1) {
					const stream = createAssistantMessageEventStream();
					void firstTurnPending.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage("first turn") });
					});
					return stream;
				}
				return streamAnswer("second turn");
			},
		});

		const promptPromise = root.prompt("start");
		await waitFor(() => seenSystemPrompts.length === 1);
		expect(seenSystemPrompts[0]!).toContain("A callable `rlm`");

		await root.setRlmMaxDepth(0);
		await root.steer("continue after max-depth update");
		releaseFirstTurn();
		await promptPromise;

		expect(seenSystemPrompts).toHaveLength(2);
		expect(seenSystemPrompts[1]!).not.toContain("A callable `rlm`");
	});

	it("rehydrates chat max depth ahead of reconstruction config", async () => {
		const root = createSession();
		await root.setRlmMaxDepth(3);
		if (!root.sessionFile) throw new Error("Missing persisted session file");
		const sessionFile = root.sessionFile;
		root.dispose();

		const resumedManager = SessionManager.open(sessionFile, join(tempDir, "sessions"));
		const resumed = createSession({ sessionManager: resumedManager, maxDepth: 4 });
		expect(resumed.getRlmMaxDepthStatus()).toEqual({ maxDepth: 3, source: "chat" });
	});

	it("reloads max depth and its source when navigating to a branch without an override", async () => {
		vi.stubEnv("RLM_MAX_DEPTH", "0");
		try {
			const root = createSession();
			await root.prompt("baseline branch");
			await root.agent.waitForIdle();
			const baselineLeafId = root.sessionManager.getLeafId();
			if (!baselineLeafId) throw new Error("Missing baseline branch leaf");

			await root.setRlmMaxDepth(2);
			expect(root.systemPrompt).toContain("A callable `rlm`");
			await root.navigateTree(baselineLeafId, { summarize: false });
			expect(root.getRlmMaxDepthStatus()).toEqual({ maxDepth: 0, source: "env" });
			expect(root.systemPrompt).not.toContain("A callable `rlm`");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("applies --global to this chat and new sessions without changing existing sessions", async () => {
		const current = createSession();
		const existingSettings = SettingsManager.create(tempDir, tempDir);
		const existing = createSession({ settingsManager: existingSettings });

		await expect(current.setRlmMaxDepth(4, { global: true })).resolves.toMatchObject({
			maxDepth: 4,
			source: "chat",
			globalSaved: true,
		});
		expect(existing.rlmMaxDepth).toBe(1);
		const freshSettings = SettingsManager.create(tempDir, tempDir);
		const fresh = createSession({ settingsManager: freshSettings });
		expect(fresh.getRlmMaxDepthStatus()).toEqual({ maxDepth: 4, source: "global" });
		current.dispose();
		existing.dispose();
	});

	it("does not claim a failed global max-depth write was saved", async () => {
		const globalSettings = JSON.stringify({ rlmMaxDepth: 1 });
		const storage: SettingsStorage = {
			withLock(scope, update) {
				const current = scope === "global" ? globalSettings : undefined;
				const next = update(current);
				if (scope === "global" && next !== undefined) {
					throw new Error("EROFS: read-only file system");
				}
			},
		};
		const current = createSession({ settingsManager: SettingsManager.fromStorage(storage) });

		const result = await current.setRlmMaxDepth(5, { global: true });

		expect(result).toMatchObject({ maxDepth: 5, source: "chat", globalSaved: false });
		expect(result.globalError).toContain("EROFS: read-only file system");
		expect(SettingsManager.fromStorage(storage).getRlmMaxDepth()).toBe(1);
		expect(globalSettings).toBe(JSON.stringify({ rlmMaxDepth: 1 }));
	});

	it("does not attribute stale errors to a successful global max-depth write", async () => {
		const writes: Record<"global" | "project", string | undefined> = {
			global: JSON.stringify({ rlmMaxDepth: 1 }),
			project: undefined,
		};
		let failGlobal = true;
		let failProject = true;
		const storage: SettingsStorage = {
			withLock(scope, update) {
				const next = update(writes[scope]);
				if (scope === "global" && failGlobal && next !== undefined) {
					throw new Error("stale global failure");
				}
				if (scope === "project" && failProject && next !== undefined) {
					throw new Error("project warning");
				}
				writes[scope] = next;
			},
		};
		const settingsManager = SettingsManager.fromStorage(storage);
		settingsManager.setDefaultModelAndProvider("provider", "model");
		await settingsManager.flush();
		settingsManager.setProjectExtensionPaths(["broken-project-extension"]);
		await settingsManager.flush();
		// Preserve the queued project diagnostic while recovering the global store.
		failGlobal = false;
		failProject = false;
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const current = createSession({ settingsManager });

		const result = await current.setRlmMaxDepth(5, { global: true });

		expect(result).toMatchObject({ maxDepth: 5, source: "chat", globalSaved: true });
		expect(warn).toHaveBeenCalledWith("Warning: Earlier global settings write failed: stale global failure");
		expect(settingsManager.drainErrors()).toMatchObject([
			{ scope: "project", error: { message: "project warning" } },
		]);
		expect(JSON.parse(writes.global ?? "{}")).toMatchObject({ rlmMaxDepth: 5 });
		warn.mockRestore();
	});

	it("rolls back max-depth state when chat persistence fails", async () => {
		const root = createSession();
		const originalPrompt = root.systemPrompt;
		const flush = vi.spyOn(root.sessionManager, "flushNow").mockImplementation(() => {
			throw new Error("disk full");
		});

		await expect(root.setRlmMaxDepth(0)).rejects.toThrow("disk full");
		expect(root.rlmMaxDepth).toBe(1);
		expect(root.systemPrompt).toBe(originalPrompt);
		expect(
			root.sessionManager
				.getBranch()
				.some((entry) => entry.type === "custom" && entry.customType === "rlm_max_depth_state"),
		).toBe(false);

		flush.mockRestore();
		root.sessionManager.flushNow();
		expect(readFileSync(root.sessionFile!, "utf8")).not.toContain('"customType":"rlm_max_depth_state"');
	});
	it("falls through an invalid global max depth while navigating off a chat override", async () => {
		const original = createSession();
		await original.prompt("baseline branch");
		await original.agent.waitForIdle();
		const baselineLeafId = original.sessionManager.getLeafId();
		if (!baselineLeafId) throw new Error("Missing baseline branch leaf");
		await original.setRlmMaxDepth(2);
		const sessionFile = original.sessionFile;
		if (!sessionFile) throw new Error("Missing persisted session file");
		original.dispose();

		vi.stubEnv("RLM_MAX_DEPTH", "0");
		try {
			const resumed = createSession({
				sessionManager: SessionManager.open(sessionFile, join(tempDir, "sessions")),
				settingsManager: SettingsManager.inMemory({ rlmMaxDepth: -1 }),
			});
			expect(resumed.rlmMaxDepth).toBe(2);

			await expect(resumed.navigateTree(baselineLeafId, { summarize: false })).resolves.toMatchObject({
				cancelled: false,
			});
			expect(resumed.sessionManager.getLeafId()).toBe(baselineLeafId);
			expect(resumed.rlmMaxDepth).toBe(0);
			expect(resumed.systemPrompt).not.toContain("A callable `rlm`");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("keeps a spawned child's chat override when reconstructed with its inherited config", async () => {
		const root = createSession({ maxDepth: 2 });
		const childResult = await root.runRlmChild("child with a durable override");
		if (!childResult.session_dir) throw new Error("Missing child session directory");
		await waitFor(() => root.getRlmChildSession(childResult.rlm_child_id) !== undefined);
		const child = root.getRlmChildSession(childResult.rlm_child_id);
		if (!child?.sessionFile) throw new Error("Missing persisted child session");
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);

		expect(child.getRlmMaxDepthStatus()).toEqual({ maxDepth: 2, source: "inherited" });
		await child.setRlmMaxDepth(3);
		const childSessionFile = child.sessionFile;
		root.dispose();

		const rehydratedManager = SessionManager.open(childSessionFile, join(tempDir, "sessions"));
		const rehydratedChild = createSession({ sessionManager: rehydratedManager, depth: 1, maxDepth: 2 });
		expect(rehydratedChild.getRlmMaxDepthStatus()).toEqual({ maxDepth: 3, source: "chat" });
	});

	it("copies live max depth at spawn, keeps child overrides independent, and lets zero disable root spawning", async () => {
		const root = createSession();
		await root.setRlmMaxDepth(2);
		const childResult = await root.runRlmChild("first child");
		if (!childResult.session_dir) throw new Error("Missing child session directory");
		await waitFor(() => root.getRlmChildSession(childResult.rlm_child_id) !== undefined);
		const child = root.getRlmChildSession(childResult.rlm_child_id);
		if (!child) throw new Error("Missing retained child session");
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);
		expect(child.rlmMaxDepth).toBe(2);

		await child.setRlmMaxDepth(3);
		expect((child as unknown as InspectableRlmDirSession)._rlmKernelEnv().RLM_MAX_DEPTH).toBe("3");
		expect(root.rlmMaxDepth).toBe(2);
		const grandchildResult = await child.runRlmChild("grandchild after override");
		if (!grandchildResult.session_dir) throw new Error("Missing grandchild session directory");
		await waitFor(() => child.getRlmChildSession(grandchildResult.rlm_child_id) !== undefined);
		const grandchild = child.getRlmChildSession(grandchildResult.rlm_child_id);
		expect(grandchild?.rlmMaxDepth).toBe(3);

		await root.setRlmMaxDepth(0);
		expect(root.systemPrompt).not.toContain("A callable `rlm`");
		await expect(root.runRlmChild("blocked at root")).rejects.toThrow(
			"RLM recursion depth limit reached (RLM_DEPTH=0, RLM_MAX_DEPTH=0)",
		);
		expect(child.rlmMaxDepth).toBe(3);
	});

	it("lets a stale kernel depth cap defer to the live host gate", () => {
		const python =
			process.env.PRIME_AGENT_KERNEL_PYTHON ?? join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
		const runtime = join(process.cwd(), "..", "..", "prime-agent-runtime", "src");
		const probe = spawnSync(
			python,
			["-c", "import asyncio, rlm; rlm.Comm = None; asyncio.run(rlm.run('raised live cap'))"],
			{
				env: { ...process.env, PYTHONPATH: runtime, RLM_DEPTH: "1", RLM_MAX_DEPTH: "1" },
				encoding: "utf8",
			},
		);

		expect(probe.status).not.toBe(0);
		expect(probe.stderr).toContain("Jupyter comm support is unavailable in this kernel");
		expect(probe.stderr).not.toContain("RLM recursion depth limit reached");
	});

	it("rejects child creation at the configured recursion depth cap", async () => {
		const root = createSession({ depth: 1, maxDepth: 1 });

		await expect(root.runRlmChild("nested")).rejects.toThrow("RLM recursion depth limit reached");
	});

	it("rejects unsupported rlm.run kwargs loudly", async () => {
		const root = createSession();

		await expect(root.runRlmChild("nested", { temperature: 0 })).rejects.toThrow(
			"Unsupported rlm.run kwargs: temperature",
		);
	});

	it("rejects a non-string rlm.run thinking kwarg", async () => {
		const root = createSession();

		await expect(root.runRlmChild("nested", { thinking: 3 })).rejects.toThrow("rlm.run thinking must be a string");
	});

	it("rejects an unknown rlm.run thinking level", async () => {
		const root = createSession();
		await expect(root.runRlmChild("nested", { thinking: "ultra" })).rejects.toThrow("must be one of");
	});

	it("cancels active rlm children when the parent session is disposed", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		const spawned = await root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = [...runs.values()][0];

		root.dispose();

		expect(run.status).toBe("cancelled");
		expect(run.error).toBe("Parent session disposed");
		releaseChild();
		expect(spawned.rlm_child_id).toBe(run.id);
	});

	it("cancels active rlm children when the parent session is aborted", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		const spawned = await root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = [...runs.values()][0];

		await root.abort();

		expect(run.status).toBe("cancelled");
		expect(run.error).toBe("Parent session aborted");
		releaseChild();
		expect(spawned.rlm_child_id).toBe(run.id);
	});

	it("does not admit a child prompt when the parent is aborted while resolving the sender", async () => {
		let releaseAgentList: () => void = () => {};
		const agentListGate = new Promise<void>((resolve) => {
			releaseAgentList = resolve;
		});
		let agentListStarted = false;
		const child = createSession({ rlmSessionDir: join(tempDir, "pre-admission-child") });
		const promptAndWait = vi.spyOn(child, "promptAndWait");
		const root = createSession({
			agentMessageController: {
				assertSessionNameAvailable: () => {},
				listAgents: async () => {
					agentListStarted = true;
					await agentListGate;
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {
					await child.disposeAsync();
				},
			},
		});

		const spawned = await root.runRlmChild("cancel before admission", { name: "cancelled-worker" });
		await waitFor(() => agentListStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		const run = runs.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing running child");

		await root.abort();
		releaseAgentList();
		await waitFor(() => !runs.has(spawned.rlm_child_id));

		expect(run.status).toBe("cancelled");
		expect(run.error).toBe("Parent session aborted");
		expect(promptAndWait).not.toHaveBeenCalled();
	});

	it("cancels strong quiescence before abandoning children for an update restart", async () => {
		const deferred = () => {
			let resolve!: () => void;
			let reject!: (error: Error) => void;
			const promise = new Promise<void>((resolvePromise, rejectPromise) => {
				resolve = resolvePromise;
				reject = rejectPromise;
			});
			promise.catch(() => undefined);
			return { promise, resolve, reject };
		};
		const child = createSession({ rlmSessionDir: join(tempDir, "update-restart-parent") });
		const childInternals = child as unknown as InspectableRlmSession;
		childInternals._activeRlmChildRuns.set("live-grandchild", {
			id: "live-grandchild",
			prompt: "still working",
			sessionName: "live-grandchild",
			sessionDir: join(tempDir, "live-grandchild"),
			model,
			abort: () => {},
			status: "running",
			settled: false,
		});
		const root = createSession();
		const rootInternals = root as unknown as InspectableRlmSession;
		const run: InspectableRlmRun = {
			id: "update-restart-parent",
			prompt: "parent work",
			sessionName: "update-restart-parent",
			sessionDir: join(tempDir, "update-restart-parent"),
			model,
			abort: () => {},
			status: "running",
			settled: false,
			publication: deferred(),
			settlement: deferred(),
			session: child,
		};
		rootInternals._activeRlmChildRuns.set(run.id, run);
		rootInternals._unsettledRlmChildRuns.add(run);

		const quiescence = root.waitForRlmQuiescence();
		await Promise.resolve();
		root.abortForUpdateRestart();

		await expect(quiescence).rejects.toThrow("RLM quiescence wait cancelled");
		expect(run.abandonedForQuiescence).toBe(true);
		expect(root.getRlmChildSnapshots()).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: "live-grandchild", status: "running" })]),
		);

		rootInternals._activeRlmChildRuns.clear();
		rootInternals._unsettledRlmChildRuns.clear();
		childInternals._activeRlmChildRuns.clear();
		root.dispose();
		child.dispose();
	});

	it("does not carry an abandoned queued child into the next strong quiescence lifecycle", async () => {
		let releaseStartup: () => void = () => {};
		const startupGate = new Promise<void>((resolve) => {
			releaseStartup = resolve;
		});
		const child = createSession({ rlmSessionDir: join(tempDir, "abandoned-queued-child") });
		const promptAndWait = vi.spyOn(child, "promptAndWait");
		const root = createSession({
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: assistantMessage("next lifecycle done") });
				return stream;
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					await startupGate;
					return { session: child };
				},
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("blocked startup");
		root.requestAbort();
		expect(root.cancelRlmChildRun(spawned.rlm_child_id)).toBe(true);
		await expect(root.waitForRlmQuiescence()).resolves.toBeUndefined();
		root.resumeQueuedWork();
		await root.prompt("next lifecycle");
		await expect(root.waitForRlmQuiescence()).resolves.toBeUndefined();

		releaseStartup();
		await waitFor(() => !(root as unknown as InspectableRlmSession)._activeRlmChildRuns.has(spawned.rlm_child_id));
		expect(promptAndWait).not.toHaveBeenCalled();
	});

	it("does not cancel active rlm children when only the parent turn is interrupted", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});

		await root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = [...runs.values()][0];

		root.requestAbort();

		expect(run.status).toBe("running");
		expect(run.error).toBeUndefined();
		releaseChild();
		await waitFor(() => run.status === "done");
	});

	it("cancels a single rlm child run by id and reports unknown ids", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				}
				return stream;
			},
		});
		const childStatuses: string[] = [];
		root.subscribe((event) => {
			if (event.type === "rlm_child_update") {
				childStatuses.push(event.child.status);
			}
		});

		await root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const childId = [...runs.keys()][0];
		if (!childId) {
			throw new Error("Missing child run id");
		}
		const run = runs.get(childId);

		expect(root.cancelRlmChildRun("unknown-child")).toBe(false);
		expect(run?.status).toBe("running");

		expect(root.cancelRlmChildRun(childId)).toBe(true);
		expect(run?.status).toBe("cancelled");
		expect(run?.error).toBe("Cancelled by user");
		// The cancelled update is pushed at cancel time, before the (possibly
		// stuck) child unwinds; viewers must not keep showing a running child.
		expect(childStatuses[childStatuses.length - 1]).toBe("cancelled");
		releaseChild();
		await waitFor(() => !runs.has(childId));
		expect(childStatuses[childStatuses.length - 1]).toBe("cancelled");
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });

		// The run has finished; a second cancel finds nothing to stop.
		expect(root.cancelRlmChildRun(childId)).toBe(false);
	});

	it("reports a shared running outcome to concurrent inactive-delete callers", async () => {
		let runningChecks = 0;
		const isExternallyRunning = () => ++runningChecks >= 5;
		const deleteRuntime = vi.fn(async () => {});
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({
					current: { activeSessionId: "parent-active", sessionId: "parent-session" },
					agents: [
						{
							activeSessionId: "child-active",
							sessionId: "child-session",
							sessionName: "worker",
							runtimeKind: "subagent",
							cwd: tempDir,
							isStreaming: false,
							unfinishedActionCount: 0,
							parentActiveSessionId: "parent-active",
							rlmChildId: "child",
							sessionDir: join(tempDir, "child"),
						},
					],
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("unexpected hydration");
				},
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const first = root.deleteInactiveRlmSubagent("child", isExternallyRunning);
		const second = root.deleteInactiveRlmSubagent("child", isExternallyRunning);

		await expect(Promise.all([first, second])).resolves.toEqual(["running", "running"]);
		expect(deleteRuntime).not.toHaveBeenCalled();
	});

	it("deletes only inactive RLM children through the explicit inactive path", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const retainedChild = createSession({
			rlmSessionDir: join(tempDir, "retained-child"),
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("done") });
				});
				return stream;
			},
		});
		const deleteRuntime = vi.fn(async () => {});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: retainedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
				releaseRlmSubagentRuntime: async (runtime, options) => {
					options.parentSession.registerRlmChildSession(options.id, runtime.session);
				},
			},
		});

		const runPromise = root.runRlmChild("slow child", { name: "retained-worker" });
		await waitFor(() => childStarted);
		const childId = [...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.keys()][0]!;
		await expect(root.deleteInactiveRlmSubagent(childId)).resolves.toBe("running");
		expect(deleteRuntime).not.toHaveBeenCalled();

		releaseChild();
		await expect(runPromise).resolves.toMatchObject({ name: "retained-worker" });
		await waitFor(
			() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.get(childId)?.status !== "running",
		);
		await expect(root.deleteInactiveRlmSubagent(childId)).resolves.toBe("deleted");
		expect(deleteRuntime).toHaveBeenCalledWith(childId, retainedChild);
		await expect(root.deleteInactiveRlmSubagent("unknown-child")).resolves.toBe("not_found");
	});

	it("releases a hosted child when completion persistence fails", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "host-completion-failure-child") });
		const disposeChild = vi.spyOn(child, "disposeAsync");
		const releaseRlmSubagentRuntime = vi.fn(async () => {});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				completeRlmSubagentRuntime: () => false,
				releaseRlmSubagentRuntime,
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("finish without registry persistence");
		await vi.waitFor(() => {
			expect(releaseRlmSubagentRuntime).toHaveBeenCalledWith(
				expect.objectContaining({ session: child }),
				expect.objectContaining({ id: spawned.rlm_child_id }),
				"error",
			);
		});
		expect(disposeChild).not.toHaveBeenCalled();
		expect((root as unknown as InspectableRlmSession)._activeRlmChildRuns.size).toBe(0);
		expect(root.getRlmChildSession(spawned.rlm_child_id)).toBeUndefined();
	});

	it("aborts an active child tool and settles only after shared runtime cleanup", async () => {
		let toolStarted = false;
		let toolAborted = false;
		const tool = {
			name: "blocking_tool",
			description: "Block until cancellation",
			label: "blocking tool",
			parameters: Type.Object({}),
			execute: async (_toolCallId: string, _params: Record<string, never>, signal: AbortSignal) => {
				toolStarted = true;
				await new Promise<never>((_resolve, reject) => {
					const rejectAborted = () => {
						toolAborted = true;
						reject(new Error("tool aborted"));
					};
					if (signal.aborted) rejectAborted();
					else signal.addEventListener("abort", rejectAborted, { once: true });
				});
				throw new Error("unreachable");
			},
		};
		const hostedChild = createSession({
			customTools: [tool],
			streamFn: (_model, context) => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const hasToolResult = context.messages.some((message) => message.role === "toolResult");
					stream.push({
						type: "done",
						reason: hasToolResult ? "stop" : "toolUse",
						message: hasToolResult
							? assistantMessage("unexpected completion")
							: {
									...assistantMessage(""),
									content: [{ type: "toolCall" as const, id: "blocking-1", name: tool.name, arguments: {} }],
									stopReason: "toolUse" as const,
								},
					});
				});
				return stream;
			},
		});
		let releaseCleanup: () => void = () => {};
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		let cleanupStarted = false;
		const deleteRuntime = vi.fn(async () => {
			cleanupStarted = true;
			await cleanupGate;
			await hostedChild.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const spawned = await root.runRlmChild("use the blocking tool", { name: "tool-worker" });
		await waitFor(() => toolStarted);
		const firstDeletion = root.deleteRlmSubagent("tool-worker");
		const repeatedDeletion = root.deleteRlmSubagent(spawned.rlm_child_id);
		await expect(firstDeletion).resolves.toMatchObject({ subagent: { rlm_child_id: spawned.rlm_child_id } });
		await expect(repeatedDeletion).resolves.toMatchObject({ subagent: { rlm_child_id: spawned.rlm_child_id } });
		await waitFor(() => toolAborted && cleanupStarted);
		expect(deleteRuntime).toHaveBeenCalledOnce();

		let quiesced = false;
		const quiescence = root.waitForRlmQuiescence().then(() => {
			quiesced = true;
		});
		await sleep(20);
		expect(quiesced).toBe(false);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);

		releaseCleanup();
		await quiescence;
		expect(deleteRuntime).toHaveBeenCalledOnce();
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ kind: "cancelled", reason: "Deleted by parent orchestrator" }),
			}),
		]);
	});

	it("admits a private durable deletion notice only after runtime cleanup", async () => {
		let releaseChild: () => void = () => {};
		const childGate = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		let cleanupSucceeded = false;
		const sendAgentMessage = vi.fn(async () => {
			expect(cleanupSucceeded).toBe(true);
			return {
				id: "agentmsg-deletion-complete",
				source: "agent_message" as const,
				target: { activeSessionId: "parent-active", sessionId: "parent-session" },
				message: "deleted",
				deliveryStatus: "delivered" as const,
			};
		});
		const hostedChild = createSession({
			agentMessageController: {
				listAgents: () => ({
					current: { activeSessionId: "child-active", sessionId: "child-session" },
					agents: [],
				}),
				sendAgentMessage,
			},
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void childGate.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("child stopped") });
				});
				return stream;
			},
		});
		vi.spyOn(hostedChild, "abort").mockResolvedValue();
		let releaseCleanup: () => void = () => {};
		const cleanupGate = new Promise<void>((resolve) => {
			releaseCleanup = resolve;
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: () => cleanupGate,
			},
		});

		const spawned = await root.runRlmChild("controller ordering", { name: "controller-worker" });
		await waitFor(() => childStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		releaseChild();
		await sleep(20);
		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);

		cleanupSucceeded = true;
		releaseCleanup();
		await root.waitForRlmQuiescence();
		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toEqual([
			expect.objectContaining({
				content: expect.stringContaining("was cancelled: Deleted by parent orchestrator"),
			}),
		]);
	});

	it("preserves failed cleanup retry across transient preflight failure before abort-insensitive unwind", async () => {
		const { child: hostedChild, completion: childCompletion, hasStarted } = createAbortInsensitiveChild();
		const retryCleanup = deferred<void>();
		let cleanupAttempts = 0;
		let failNextDeletePreflight = false;
		const root = createSession({
			agentMessageController: {
				listAgents: async () => {
					if (failNextDeletePreflight) {
						failNextDeletePreflight = false;
						throw new Error("delete preflight failed");
					}
					return {
						current: { activeSessionId: "parent-active", sessionId: "parent-session" },
						agents: [],
					};
				},
				sendAgentMessage: async () => {
					throw new Error("unexpected direct send");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: () => {
					if (++cleanupAttempts === 1) throw new Error("cleanup failed synchronously");
					return retryCleanup.promise;
				},
			},
		});

		const spawned = await root.runRlmChild("abort-insensitive cleanup retry", { name: "retry-worker" });
		await waitFor(hasStarted);
		await expect(root.deleteRlmSubagent(spawned.rlm_child_id)).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		const internals = root as unknown as InspectableRlmSession;
		await waitFor(() => internals._rlmChildCleanupFailures.size === 1);
		const failureContent = await vi.waitFor(() => {
			const notice = root.messages.find(
				(message) => message.role === "custom" && message.customType === "rlm_child_failure",
			);
			if (!notice || notice.role !== "custom") throw new Error("Missing cleanup failure notice");
			return notice.content;
		});
		expect(failureContent).toEqual(expect.stringContaining("Deletion cleanup failed"));
		expect(failureContent).toEqual(expect.stringMatching(/retry/i));

		failNextDeletePreflight = true;
		await expect(root.deleteRlmSubagent("retry-worker")).rejects.toThrow("delete preflight failed");
		expect(cleanupAttempts).toBe(1);

		await expect(root.deleteRlmSubagent("retry-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		expect(cleanupAttempts).toBe(2);
		let quiesced = false;
		const quiescence = root.waitForRlmQuiescence().then(() => {
			quiesced = true;
		});
		retryCleanup.resolve();
		await sleep(20);
		expect(quiesced).toBe(false);

		childCompletion.resolve();
		await quiescence;
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(1);
		expect(internals._rlmChildCleanupFailures.size).toBe(0);
		await expect(root.runRlmChild("replacement", { name: "retry-worker" })).resolves.toMatchObject({
			name: "retry-worker",
		});
	});

	it("settles a pre-existing deletion cleanup failure during parent disposal", async () => {
		const { child: hostedChild, completion: childCompletion, hasStarted } = createAbortInsensitiveChild();
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");
		const deleteRuntime = vi.fn(() => Promise.reject(new Error("cleanup failed before dispose")));
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const spawned = await root.runRlmChild("pre-failed cleanup disposal", { name: "pre-failed-worker" });
		await waitFor(hasStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		const internals = root as unknown as InspectableRlmSession;
		const run = internals._activeRlmChildRuns.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing deleting run");
		await waitFor(() => internals._rlmChildCleanupFailures.size === 1);

		await root.disposeAsync();
		expect(deleteRuntime).toHaveBeenCalledOnce();
		expect(disposeHostedChild).toHaveBeenCalled();
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(false);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);
		childCompletion.resolve();
	});

	it("settles disposal after cleanup succeeds without waiting for abort-insensitive task unwind", async () => {
		const { child: hostedChild, completion: childCompletion, hasStarted } = createAbortInsensitiveChild();
		const cleanup = deferred<void>();
		const deleteRuntime = vi.fn(() => cleanup.promise);
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const spawned = await root.runRlmChild("successful cleanup disposal", { name: "dispose-success-worker" });
		await waitFor(hasStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		const internals = root as unknown as InspectableRlmSession;
		const run = internals._activeRlmChildRuns.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing deleting run");

		const disposal = root.disposeAsync();
		await waitFor(() => internals._disposing);
		cleanup.resolve();
		await disposal;
		expect(deleteRuntime).toHaveBeenCalledOnce();
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(false);
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toHaveLength(0);
		childCompletion.resolve();
	});

	it("settles and suppresses notices when deletion cleanup fails during parent disposal", async () => {
		const { child: hostedChild, completion: childCompletion, hasStarted } = createAbortInsensitiveChild();
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");
		const cleanup = deferred<void>();
		const deleteRuntime = vi.fn(() => cleanup.promise);
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const spawned = await root.runRlmChild("dispose during failed cleanup", { name: "dispose-worker" });
		await waitFor(hasStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		const internals = root as unknown as InspectableRlmSession;
		const run = internals._activeRlmChildRuns.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing deleting run");

		const disposal = root.disposeAsync();
		await waitFor(() => internals._disposing);
		cleanup.reject(new Error("cleanup failed during dispose"));
		childCompletion.resolve();
		await disposal;
		expect(deleteRuntime).toHaveBeenCalledOnce();
		expect(disposeHostedChild).toHaveBeenCalled();
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(false);
		expect(
			root.messages.filter(
				(message) =>
					message.role === "custom" &&
					(message.customType === "rlm_child_failure" || message.customType === "rlm_child_terminal_notice"),
			),
		).toHaveLength(0);
	});

	it("keeps deleted live runs in the RLM quiescence barrier until settlement", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const hostedChild = createSession({
			rlmSessionDir: join(tempDir, "deleted-live-child"),
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("child stopped") });
				});
				return stream;
			},
		});
		vi.spyOn(hostedChild, "abort").mockResolvedValue();
		const root = createSession({
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: assistantMessage("parent acknowledged") });
				return stream;
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("slow child", { name: "deleted-live-worker" });
		await waitFor(() => childStarted);
		let quiesced = false;
		const quiescence = root.waitForRlmQuiescence().then(() => {
			quiesced = true;
		});
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		await sleep(20);
		expect(quiesced).toBe(false);

		releaseChild();
		await quiescence;
		expect(quiesced).toBe(true);
	});

	it("does not add a cancellation notice when deletion races a durably admitted completion notice", async () => {
		const root = createSession();
		const dispatchGate = vi
			.spyOn(root as unknown as { _scheduleSessionInputPump(): void }, "_scheduleSessionInputPump")
			.mockImplementation(() => {});
		const spawned = await root.runRlmChild("fast child", { name: "fast-worker" });
		const internals = root as unknown as InspectableRlmSession;
		await waitFor(
			() =>
				root.getRlmChildSession(spawned.rlm_child_id) !== undefined &&
				!internals._activeRlmChildRuns.has(spawned.rlm_child_id),
		);
		expect(root.unfinishedActionCount).toBe(1);

		await expect(root.deleteRlmSubagent("fast-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: spawned.rlm_child_id },
		});
		dispatchGate.mockRestore();
		await root.waitForRlmQuiescence();
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(root.getRlmChildSession(spawned.rlm_child_id)).toBeUndefined();
		expect(
			root.messages.filter(
				(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
			),
		).toEqual([expect.objectContaining({ details: expect.objectContaining({ kind: "completed_without_reply" }) })]);
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
	});

	it("keeps failed closure retryable without hanging or late resurrection", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "retry-child") });
		child.setSessionName("release-worker");
		let attempts = 0;
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async (_id, session) => {
					if (++attempts === 1) throw new Error("close failed");
					await session?.disposeAsync();
				},
			},
		});
		expect(root.registerRlmChildSession("retry-child", child)).toBe(true);
		await expect(root.deleteRlmSubagent("release-worker")).rejects.toThrow("close failed");
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		expect((root as unknown as InspectableRlmSession)._rlmChildCleanupFailures.size).toBe(1);
		await expect(root.deleteRlmSubagent("release-worker")).resolves.toMatchObject({
			subagent: { rlm_child_id: "retry-child" },
		});
		expect((root as unknown as InspectableRlmSession)._rlmChildCleanupFailures.size).toBe(0);
	});

	it("does not restore failed delete retry state after parent teardown", async () => {
		const child = createSession({ rlmSessionDir: join(tempDir, "teardown-child") });
		child.setSessionName("teardown-worker");
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				deleteRlmSubagentRuntime: async () => {
					throw new Error("close failed during teardown");
				},
			},
		});
		expect(root.registerRlmChildSession("teardown-child", child)).toBe(true);
		await expect(root.deleteRlmSubagent("teardown-worker")).rejects.toThrow("close failed during teardown");
		root.dispose();
		const internals = root as unknown as InspectableRlmSession;
		expect(internals._activeRlmChildRuns.size).toBe(0);
		expect(internals._rlmChildSessions.size).toBe(0);
		expect(internals._rlmChildUnsubscribes.size).toBe(0);
		expect(internals._rlmChildCleanupFailures.size).toBe(0);
	});

	it("keeps an errored startup deletable after its failure notice is durably admitted", async () => {
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					throw new Error("startup failed");
				},
				deleteRlmSubagentRuntime: async () => undefined,
			},
		});

		await root.runRlmChild("failing startup", { name: "failed-worker" });
		await vi.waitFor(async () => {
			expect((await root.listRlmSubagents()).subagents[0]).toMatchObject({
				session_name: "failed-worker",
				status: "error",
			});
		});
		const failed = (await root.listRlmSubagents()).subagents[0];
		await expect(root.deleteRlmSubagent("failed-worker")).resolves.toEqual({ subagent: failed });
		const internals = root as unknown as InspectableRlmSession;
		expect(internals._activeRlmChildRuns.size).toBe(0);
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		await expect(root.runRlmChild("replacement", { name: "failed-worker" })).resolves.toMatchObject({
			name: "failed-worker",
		});
	});

	it("reserves a deleted queued child's name until startup settles", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const hostedChild = createSession();
		const setSessionName = vi.spyOn(hostedChild, "setSessionName");
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: async (_id, child) => child?.disposeAsync(),
			},
		});
		await root.runRlmChild("blocked before runtime creation", { name: "reserved-worker" });
		await waitFor(() => runtimeCreationStarted);

		await root.deleteRlmSubagent("reserved-worker");
		await expect(root.runRlmChild("replacement", { name: "reserved-worker" })).rejects.toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);

		releaseRuntimeCreation();
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);
		expect(setSessionName).not.toHaveBeenCalled();
		await expect(root.runRlmChild("replacement", { name: "reserved-worker" })).resolves.toMatchObject({
			name: "reserved-worker",
		});
	});

	it("deletes a queued child without waiting for blocked startup", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const hostedChild = createSession();
		const deleteRuntime = vi.fn(async () => {
			await hostedChild.disposeAsync();
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});
		await root.runRlmChild("blocked before runtime creation", { name: "queued-worker" });
		await waitFor(() => runtimeCreationStarted);
		const queued = (await root.listRlmSubagents()).subagents[0];
		expect(queued).toBeDefined();

		await expect(root.deleteRlmSubagent("queued-worker")).resolves.toEqual({ subagent: queued });
		expect((root as unknown as InspectableRlmSession)._activeRlmChildRuns.size).toBe(1);
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });

		releaseRuntimeCreation();
		await waitFor(() => deleteRuntime.mock.calls.length === 1);
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
	});

	it("keeps late startup cleanup retryable when release and fallback delete fail", async () => {
		let releaseRuntimeCreation: () => void = () => {};
		const runtimeCreationGate = new Promise<void>((resolve) => {
			releaseRuntimeCreation = resolve;
		});
		let runtimeCreationStarted = false;
		const hostedChild = createSession();
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");
		let deleteAttempts = 0;
		const deleteRuntime = vi.fn(async () => {
			deleteAttempts++;
			if (deleteAttempts === 1) {
				throw new Error("fallback delete failed");
			}
			await hostedChild.disposeAsync();
		});
		const releaseRuntime = vi.fn(async () => {
			throw new Error("cancelled release failed");
		});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					runtimeCreationStarted = true;
					await runtimeCreationGate;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: deleteRuntime,
				releaseRlmSubagentRuntime: releaseRuntime,
			},
		});

		await root.runRlmChild("delete during runtime creation", { name: "starting-worker" });
		await waitFor(() => runtimeCreationStarted);
		const starting = (await root.listRlmSubagents()).subagents[0];
		expect(starting).toBeDefined();

		await expect(root.deleteRlmSubagent("starting-worker")).resolves.toEqual({ subagent: starting });
		expect(deleteRuntime).not.toHaveBeenCalled();
		releaseRuntimeCreation();

		const internals = root as unknown as InspectableRlmSession;
		await waitFor(() => deleteRuntime.mock.calls.length === 1);
		await waitFor(() => internals._rlmChildCleanupFailures.size === 1);
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(disposeHostedChild).not.toHaveBeenCalled();

		await root.deleteRlmSubagent("starting-worker");
		await root.waitForRlmQuiescence();
		expect(deleteRuntime).toHaveBeenCalledTimes(2);
		expect(disposeHostedChild).toHaveBeenCalledOnce();
		expect(internals._rlmChildCleanupFailures.size).toBe(0);
	});

	it("accepts deletion of a running direct child without waiting for task unwind", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let childStarted = false;
		const root = createSession({
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				childStarted = true;
				void release.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
				});
				return stream;
			},
		});

		await root.runRlmChild("slow named shard", { name: "slow-worker" });
		await waitFor(() => childStarted);
		const running = (await root.listRlmSubagents()).subagents[0];
		if (!running) {
			throw new Error("Missing running child registry entry");
		}
		await expect(root.deleteRlmSubagent("slow-worker")).resolves.toEqual({ subagent: running });
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		releaseChild();
	});

	it("deletes an inactive nested RLM child through the root session", async () => {
		let releaseParent: () => void = () => {};
		const parentRelease = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		let parentStarted = false;
		const root = createSession({
			maxDepth: 2,
			streamFn: (_model, context) => {
				const text = userText(context);
				if (text !== "slow parent") {
					return streamAnswer(`child answer: ${text}`);
				}
				const stream = createAssistantMessageEventStream();
				parentStarted = true;
				void parentRelease.then(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("parent done") });
				});
				return stream;
			},
		});

		const parentPromise = root.runRlmChild("slow parent");
		await waitFor(() => parentStarted);
		const parentRun = [...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.values()][0];
		if (!parentRun?.session) {
			throw new Error("Missing parent child session");
		}
		const parentSession = parentRun.session;
		const nestedResult = await parentSession.runRlmChild("nested child");
		if (!nestedResult.session_dir) {
			throw new Error("Missing nested child session directory");
		}
		const nestedId = basename(nestedResult.session_dir);
		const nestedSession = parentSession.getRlmChildSession(nestedId);
		if (!nestedSession) {
			throw new Error("Missing retained nested child session");
		}
		const disposeNested = vi.spyOn(nestedSession, "disposeAsync");
		await waitFor(() => {
			const status = (parentSession as unknown as InspectableRlmSession)._activeRlmChildRuns.get(nestedId)?.status;
			return status !== "queued" && status !== "running";
		});

		await expect(root.deleteInactiveRlmSubagent(nestedId)).resolves.toBe("deleted");
		expect(await parentSession.listRlmSubagents()).toEqual({ subagents: [] });
		expect(disposeNested).toHaveBeenCalledOnce();
		expect(parentRun.status).toBe("running");

		releaseParent();
		await parentPromise;
		await waitFor(() => {
			const status = (root as unknown as InspectableRlmSession)._activeRlmChildRuns.get(parentRun.id)?.status;
			return status === undefined || status === "done";
		});
	});

	it("cancels nested rlm child runs through the root session", async () => {
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = resolve;
		});
		let releaseNested: () => void = () => {};
		const nestedRelease = new Promise<void>((resolve) => {
			releaseNested = resolve;
		});
		let childStarted = false;
		let nestedStarted = false;
		const root = createSession({
			maxDepth: 2,
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				if (text === "slow shard") {
					childStarted = true;
					void release.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				} else if (text === "nested shard") {
					nestedStarted = true;
					void nestedRelease.then(() => {
						stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
					});
				} else {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("cancellation acknowledged") });
				}
				return stream;
			},
		});

		await root.runRlmChild("slow shard");
		await waitFor(() => childStarted);
		const rootRuns = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		const rootRun = [...rootRuns.values()][0];
		if (!rootRun?.session) {
			throw new Error("Missing child session on root run");
		}

		const childSession = rootRun.session;
		const nestedSpawned = await childSession.runRlmChild("nested shard");
		await waitFor(() => nestedStarted);
		const nestedRuns = (childSession as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(nestedRuns.size).toBe(1);
		const nestedId = [...nestedRuns.keys()][0];
		if (!nestedId) {
			throw new Error("Missing nested run id");
		}

		await expect(root.deleteRlmSubagent(nestedId)).rejects.toThrow("No direct RLM subagent matches");
		expect(root.cancelRlmChildRun(nestedId)).toBe(true);
		releaseNested();
		await waitFor(() => !nestedRuns.has(nestedId));
		expect(nestedSpawned.rlm_child_id).toBe(nestedId);
		expect(rootRun.status).toBe("running");

		releaseChild();
		await waitFor(() => rootRun.status === "done");
	});

	it("runs parallel rlm comm requests independently", async () => {
		let active = 0;
		let maxActive = 0;
		let started = 0;
		let releaseChildren: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChildren = resolve;
		});
		const replies: CapturedCommReply[] = [];
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async ({ prompt }) => {
					active++;
					started++;
					maxActive = Math.max(maxActive, active);
					await release;
					active--;
					return {
						answer: `answer:${prompt}`,
						usage: { prompt_tokens: 1, completion_tokens: 1 },
						turns: 1,
						session_dir: null,
						model: "test/model",
					};
				}),
			},
		});

		try {
			const kernel = manager as unknown as KernelCommTestApi;
			kernel.sendCommMessage = async (commId, data) => {
				replies.push({ commId, data });
			};

			kernel.handleCommMessage(rlmCommOpen("comm-a", "first"));
			kernel.handleCommMessage(rlmCommOpen("comm-b", "second"));

			await waitFor(() => started === 2);
			expect(maxActive).toBe(2);

			releaseChildren();
			await waitFor(() => replies.length === 2);

			const byCommId = new Map(replies.map((reply) => [reply.commId, reply.data]));
			expect(byCommId.get("comm-a")).toEqual({
				status: "ok",
				answer: "answer:first",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				turns: 1,
				session_dir: null,
				model: "test/model",
			});
			expect(byCommId.get("comm-b")).toEqual({
				status: "ok",
				answer: "answer:second",
				usage: { prompt_tokens: 1, completion_tokens: 1 },
				turns: 1,
				session_dir: null,
				model: "test/model",
			});
		} finally {
			await manager.dispose();
		}
	});

	it("handles rlm comm requests from the iopub pump outside active execution", async () => {
		const replies: CapturedCommReply[] = [];
		let promptSeen = "";
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async ({ prompt }) => {
					promptSeen = prompt;
					return {
						answer: `answer:${prompt}`,
						usage: { prompt_tokens: 1, completion_tokens: 1 },
						turns: 1,
						session_dir: null,
						model: "test/model",
					};
				}),
			},
		});

		try {
			const kernel = manager as unknown as KernelCommTestApi & KernelPumpTestApi;
			kernel.sendCommMessage = async (commId, data) => {
				replies.push({ commId, data });
			};
			kernel.iopub = asyncFrames([encodeTestMessage(rlmCommOpen("comm-detached", "detached child"))]);

			kernel.startIopubPump();

			await waitFor(() => replies.length === 1);

			expect(promptSeen).toBe("detached child");
			expect(replies[0]).toEqual({
				commId: "comm-detached",
				data: {
					status: "ok",
					answer: "answer:detached child",
					usage: { prompt_tokens: 1, completion_tokens: 1 },
					turns: 1,
					session_dir: null,
					model: "test/model",
				},
			});
		} finally {
			await manager.dispose();
		}
	});

	it("handles rlm calls from asyncio tasks after the scheduling cell is idle", async () => {
		const prompts: string[] = [];
		const manager = new KernelManager({
			cwd: tempDir,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async ({ prompt }) => {
					prompts.push(prompt);
					return {
						rlm_child_id: "sub-detached",
						name: "detached-worker",
						session_dir: "/tmp/sub-detached",
						model: "test/model",
					};
				}),
			},
		});

		try {
			const scheduled = await manager.execute(`
import asyncio
import rlm

async def _delayed_rlm():
    await asyncio.sleep(0.05)
    return await rlm.run("detached child after idle")

_task = asyncio.create_task(_delayed_rlm())
print("scheduled")
`);

			expect(scheduled.status).toBe("ok");
			expect(scheduled.stdout.trim()).toBe("scheduled");
			await waitFor(() => prompts.includes("detached child after idle"));

			const finished = await manager.execute(`
_result = await _task
print(_result.name)
`);

			expect(finished.status).toBe("ok");
			expect(finished.stdout.trim()).toBe("detached-worker");
		} finally {
			await manager.dispose();
		}
	});

	it("clears active execution when execute_request send fails", async () => {
		const manager = new KernelManager({ python: process.execPath });
		const kernel = manager as unknown as KernelExecuteTestApi;
		const sendError = new Error("send failed");
		kernel.start = async () => {};
		kernel.state = "running";
		kernel.shell = {
			send: async (_frames: Buffer[]) => {
				throw sendError;
			},
			close: () => {},
		};
		kernel.connection = {
			ip: "127.0.0.1",
			transport: "tcp",
			shell_port: 1,
			iopub_port: 2,
			stdin_port: 3,
			control_port: 4,
			hb_port: 5,
			signature_scheme: "hmac-sha256",
			key: "",
			kernel_name: "python3",
		};

		try {
			await expect(manager.execute("print('hello')")).rejects.toThrow("send failed");
			expect(kernel.activeExecution).toBeUndefined();
		} finally {
			await manager.dispose();
		}
	});

	it("rejects removed background rlm comm request types", async () => {
		const replies: CapturedCommReply[] = [];
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async () => ({
					answer: "unused",
					usage: { prompt_tokens: 1, completion_tokens: 1 },
					turns: 1,
					session_dir: null,
					model: "test/model",
				})),
			},
		});

		try {
			const kernel = manager as unknown as KernelCommTestApi;
			kernel.sendCommMessage = async (commId, data) => {
				replies.push({ commId, data });
			};

			kernel.handleCommMessage(rlmCommOpenData("comm-bg", { type: "background", prompt: "slow", kwargs: {} }));

			await waitFor(() => replies.length === 1);

			expect(replies[0]).toEqual({
				commId: "comm-bg",
				data: {
					status: "error",
					error: 'host request type "background" is not available in this session',
				},
			});
		} finally {
			await manager.dispose();
		}
	});

	it("waits for in-flight rlm comm work during dispose and buffers failures", async () => {
		let started = false;
		let handlerSettled = false;
		let released = false;
		let releaseChild: () => void = () => {};
		const release = new Promise<void>((resolve) => {
			releaseChild = () => {
				if (released) return;
				released = true;
				resolve();
			};
		});
		const manager = new KernelManager({
			python: process.execPath,
			hostHandlers: {
				"rlm.run": createRlmRunHostHandler(async () => {
					started = true;
					try {
						await release;
						throw new Error("child failed after dispose");
					} finally {
						handlerSettled = true;
					}
				}),
			},
		});
		const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		try {
			const kernel = manager as unknown as KernelCommTestApi;

			kernel.handleCommMessage(rlmCommOpen("comm-dispose", "slow child"));

			await waitFor(() => started);
			const disposePromise = manager.dispose();
			let disposeSettled = false;
			const trackedDispose = disposePromise.then(() => {
				disposeSettled = true;
			});

			await sleep(25);
			expect(disposeSettled).toBe(false);

			releaseChild();
			await expectSettlesWithin(trackedDispose, 1000);
			expect(handlerSettled).toBe(true);

			const kernelStderr = (manager as unknown as { kernelStderr: string }).kernelStderr;
			expect(kernelStderr).toContain("[kernel] host request failed for comm comm-dispose");
			expect(kernelStderr).toContain("[kernel] failed to send host request error reply for comm comm-dispose");
			expect(stderrSpy).not.toHaveBeenCalled();
		} finally {
			releaseChild();
			await manager.dispose();
			stderrSpy.mockRestore();
		}
	});
});

interface InspectableRlmDirSession {
	_ensureRlmSessionDir(): string | undefined;
	_rlmKernelEnv(): Record<string, string>;
}

describe("AgentSession RLM session dir", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-rlm-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		sessionManager: SessionManager,
		agentDir?: string,
		serperKey?: string,
		loadWebsearchSkill = false,
		rlmSessionDir?: string,
	): AgentSession {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		if (serperKey !== undefined) {
			authStorage.set("serper", { type: "api_key", key: serperKey });
		}
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: () => streamAnswer("ignored"),
		});
		const skills: Skill[] = loadWebsearchSkill
			? [
					{
						kind: "markdown",
						name: "websearch",
						description: "",
						filePath: "/x/websearch/SKILL.md",
						baseDir: "/x/websearch",
						sourceInfo: createSyntheticSourceInfo("/x/websearch/SKILL.md", { source: "package" }),
						disableModelInvocation: false,
					},
				]
			: [];
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			agentDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({ skills }),
			rlmSessionDir,
		});
		return session;
	}

	it("does not create a /tmp dir or set RLM_SESSION_DIR for a non-persisted session", () => {
		const root = createSession(SessionManager.inMemory(tempDir));
		const inspectable = root as unknown as InspectableRlmDirSession;

		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("prime-agent-rlm-"));

		expect(inspectable._ensureRlmSessionDir()).toBeUndefined();
		const env = inspectable._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBeUndefined();
		expect(env.RLM_HARNESS_STATE_DIR).toBeUndefined();
		expect(env.RLM_GLOBAL_HARNESS_STATE_DIR).toBeDefined();
		expect(env).toMatchObject({ RLM_DEPTH: "0" });

		const after = readdirSync(tmpdir()).filter((name) => name.startsWith("prime-agent-rlm-"));
		expect(after).toEqual(before);
	});

	it("uses the persistent artifact dir and sets RLM_SESSION_DIR for a persisted session", () => {
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const root = createSession(sessionManager);
		const inspectable = root as unknown as InspectableRlmDirSession;

		const artifactDir = sessionManager.getSessionArtifactDir();
		expect(artifactDir).toBeDefined();
		expect(inspectable._ensureRlmSessionDir()).toBe(artifactDir);
		expect(inspectable._rlmKernelEnv().RLM_SESSION_DIR).toBe(artifactDir);
		expect(inspectable._rlmKernelEnv().RLM_HARNESS_STATE_DIR).toBe(join(artifactDir!, "harness"));
		expect(inspectable._rlmKernelEnv().RLM_GLOBAL_HARNESS_STATE_DIR).toBeDefined();
	});

	it("points RLM_HARNESS_STATE_DIR at the session's own artifact dir for subagent sessions", () => {
		// Subagent layout: the parent assigns rlmSessionDir, but the child's own
		// sessionManager persists artifacts (and reads local harness state) elsewhere.
		const subDir = join(tempDir, "parent-artifact", "sub-abc12345");
		mkdirSync(subDir, { recursive: true });
		const sessionManager = SessionManager.create(tempDir, subDir);
		const root = createSession(sessionManager, undefined, undefined, false, subDir);
		const inspectable = root as unknown as InspectableRlmDirSession;

		const artifactDir = sessionManager.getSessionArtifactDir();
		expect(artifactDir).toBeDefined();
		expect(artifactDir).not.toBe(subDir);
		const env = inspectable._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBe(subDir);
		expect(env.RLM_HARNESS_STATE_DIR).toBe(join(artifactDir!, "harness"));
	});

	it("falls back to the rlm session dir for RLM_HARNESS_STATE_DIR without an artifact dir", () => {
		const ephemeralDir = join(tempDir, "ephemeral-rlm");
		mkdirSync(ephemeralDir, { recursive: true });
		const root = createSession(SessionManager.inMemory(tempDir), undefined, undefined, false, ephemeralDir);
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBe(ephemeralDir);
		expect(env.RLM_HARNESS_STATE_DIR).toBe(join(ephemeralDir, "harness"));
	});

	it("loads the ephemeral RLM harness path into the host system prompt", () => {
		const ephemeralDir = join(tempDir, "ephemeral-rlm");
		mkdirSync(join(ephemeralDir, "harness"), { recursive: true });
		writeFileSync(
			join(ephemeralDir, "harness", "harness_state.json"),
			JSON.stringify({
				schema: 1,
				entries: {
					prompt: {},
					memory: {
						ephemeral_note: {
							id: "ephemeral_note",
							kind: "memory",
							title: "Ephemeral note",
							content: "Loaded from the RLM session harness path.",
							path: "000",
							scope: "local",
							reference: {},
							arguments: {},
							metadata: {},
							source: "test",
							created_at: "2026-01-01T00:00:00.000Z",
							updated_at: "2026-01-01T00:00:00.000Z",
							version: 1,
						},
					},
					skill: {},
					subagent: {},
				},
				refinements: [],
			}),
			"utf8",
		);
		const root = createSession(SessionManager.inMemory(tempDir), undefined, undefined, false, ephemeralDir);

		const prompt = root.systemPrompt;

		expect(prompt).toContain("Ephemeral note");
		expect(prompt).toContain("Loaded from the RLM session harness path.");
	});

	it("exports the configured agentDir to the kernel so skills find auth.json", () => {
		const agentDir = join(tempDir, "custom-agent-dir");
		const root = createSession(SessionManager.inMemory(tempDir), agentDir);
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(agentDir);
	});

	it("omits the agentDir env var when none is configured", () => {
		const root = createSession(SessionManager.inMemory(tempDir));
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBeUndefined();
	});

	it("exports agentDir but skips key injection when no websearch skill is loaded", () => {
		const agentDir = join(tempDir, "custom-agent-dir");
		const root = createSession(SessionManager.inMemory(tempDir), agentDir, "stored-key", false);
		const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
		expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(agentDir);
		expect(env.SERPER_API_KEY).toBeUndefined();
	});

	it("injects the key for a custom websearch skill even when bundled is off", () => {
		const previous = process.env.SERPER_API_KEY;
		delete process.env.SERPER_API_KEY;
		try {
			// loadWebsearchSkill=true models a --skill/project websearch; the bundled
			// setting is irrelevant because the gate checks the loaded skill, not settings.
			const root = createSession(SessionManager.inMemory(tempDir), undefined, "custom-key", true);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.SERPER_API_KEY).toBe("custom-key");
		} finally {
			if (previous === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previous;
		}
	});

	it("injects a literal stored Serper key into the kernel", () => {
		const previous = process.env.SERPER_API_KEY;
		delete process.env.SERPER_API_KEY;
		try {
			const root = createSession(SessionManager.inMemory(tempDir), undefined, "literal-serper-key", true);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.SERPER_API_KEY).toBe("literal-serper-key");
		} finally {
			if (previous === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previous;
		}
	});

	it("resolves an env-var-reference Serper key before injecting it", () => {
		const previousKey = process.env.SERPER_API_KEY;
		const previousRef = process.env.MY_SERPER_REF;
		delete process.env.SERPER_API_KEY;
		process.env.MY_SERPER_REF = "resolved-secret";
		try {
			const root = createSession(SessionManager.inMemory(tempDir), undefined, "MY_SERPER_REF", true);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.SERPER_API_KEY).toBe("resolved-secret");
		} finally {
			if (previousKey === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previousKey;
			if (previousRef === undefined) delete process.env.MY_SERPER_REF;
			else process.env.MY_SERPER_REF = previousRef;
		}
	});
});
