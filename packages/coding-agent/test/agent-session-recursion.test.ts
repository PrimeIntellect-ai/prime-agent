import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
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
import { type HostRequestHandler, type HostRequestHandlers, ReplKernelManager } from "../src/core/kernel/index.js";
import { ASYNC_BASH_COMPLETION_CUSTOM_TYPE, convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import {
	createDefaultRlmSubagentSessionName,
	createRlmRunHostHandler,
	type SubagentRuntimeHost,
} from "../src/core/rlm-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { Skill } from "../src/core/skills.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
import { waitForHeadlessCompletion } from "../src/modes/headless-completion.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./suite/harness.js";
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
	activity?: { kind: string };
	progressNotes: string[];
	emitUpdate?: () => void;
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
	_rlmChildSessions: Map<string, { session: AgentSession; run?: InspectableRlmRun }>;
	_rlmChildUnsubscribes: Map<string, () => void>;
	_deletedRlmChildIds: Set<string>;
	_rlmQuiescenceWaitAborts: Set<AbortController>;
	_createKernelHostHandlers(): HostRequestHandlers;
	_reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void>;
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

function customNotices(session: AgentSession, customType: string): AgentMessage[] {
	return session.messages.filter((message) => message.role === "custom" && message.customType === customType);
}

/** Terminal child notices admitted into a parent transcript. */
function terminalNotices(session: AgentSession): AgentMessage[] {
	return customNotices(session, "rlm_child_terminal_notice");
}

/** Child failure notices admitted into a parent transcript. */
function failureNotices(session: AgentSession): AgentMessage[] {
	return customNotices(session, "rlm_child_failure");
}

describe("AgentSession rlm recursion", () => {
	const originalRlmDepth = process.env.RLM_DEPTH;
	const originalRlmMaxDepth = process.env.RLM_MAX_DEPTH;
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		delete process.env.RLM_DEPTH;
		delete process.env.RLM_MAX_DEPTH;
		tempDir = join(tmpdir(), `pi-rlm-recursion-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		if (originalRlmDepth === undefined) delete process.env.RLM_DEPTH;
		else process.env.RLM_DEPTH = originalRlmDepth;
		if (originalRlmMaxDepth === undefined) delete process.env.RLM_MAX_DEPTH;
		else process.env.RLM_MAX_DEPTH = originalRlmMaxDepth;
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

	/** Session with a zero-usage parent assistant whose child answers a tool loop: usages[i] per request, tool calls until the last, then stop. */
	function createToolLoopSession(requests: number, usages: Usage[], onRequest?: (toolResultCount: number) => void) {
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
				onRequest?.(toolResultCount);
				const last = toolResultCount >= requests - 1;
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					const message = last
						? assistantMessage("done", usages[toolResultCount])
						: {
								...assistantMessage("", usages[toolResultCount]),
								content: [
									{
										type: "toolCall" as const,
										id: `echo-${toolResultCount}`,
										name: "echo",
										arguments: { value: "ok" },
									},
								],
								stopReason: "toolUse" as const,
							};
					stream.push({ type: "done", reason: last ? "stop" : "toolUse", message });
				});
				return stream;
			},
		});
		const parentAssistant = assistantMessage("running ipython", usage(0, 0));
		root.agent.state.messages.push(parentAssistant);
		root.sessionManager.appendMessage(parentAssistant);
		return root;
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

	function hostHandler(target: AgentSession, name: string): HostRequestHandler {
		const handler = (target as unknown as InspectableRlmSession)._createKernelHostHandlers()[name];
		if (!handler) throw new Error(`Missing ${name} host handler`);
		return handler;
	}

	/** Root whose child turns block until released; gatedPrompts limits which prompts wait. */
	function createGatedRoot(
		options: Parameters<typeof createSession>[0] = {},
		gatedPrompts?: readonly string[],
	): {
		root: AgentSession;
		releaseChild: (prompt?: string) => void;
		hasStarted: () => boolean;
	} {
		const gates = new Map<string, ReturnType<typeof deferred<void>>>();
		const started = new Set<string>();
		const root = createSession({
			...options,
			streamFn: (_model, context) => {
				const text = userText(context);
				const stream = createAssistantMessageEventStream();
				const answer = () => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage(`child answer: ${text}`) });
				};
				if (gatedPrompts && !gatedPrompts.includes(text)) {
					queueMicrotask(answer);
					return stream;
				}
				started.add(text);
				let gate = gates.get(text);
				if (!gate) {
					gate = deferred<void>();
					gates.set(text, gate);
				}
				void gate.promise.then(answer);
				return stream;
			},
		});
		return {
			root,
			releaseChild: (prompt?: string) => {
				for (const [key, gate] of gates) if (prompt === undefined || key === prompt) gate.resolve();
			},
			hasStarted: () => started.size > 0,
		};
	}

	/** Root whose hosted child runtime creation blocks until released. */
	function createStartupGatedRoot(host: Partial<SubagentRuntimeHost> = {}): {
		root: AgentSession;
		hostedChild: AgentSession;
		releaseStartup: () => void;
		hasStarted: () => boolean;
	} {
		const gate = deferred<void>();
		let started = false;
		const hostedChild = createSession();
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => {
					started = true;
					await gate.promise;
					return { session: hostedChild };
				},
				deleteRlmSubagentRuntime: async (_id, child) => child?.disposeAsync(),
				...host,
			},
		});
		return { root, hostedChild, releaseStartup: () => gate.resolve(), hasStarted: () => started };
	}

	/** Child session holding one gated bash command, for quiescence boundaries. */
	function gatedBashChild(name: string): {
		session: AgentSession;
		started: Promise<void>;
		completion: ReturnType<typeof deferred<void>>;
		bash: Promise<unknown>;
	} {
		const started = deferred<void>();
		const completion = deferred<void>();
		const child = createSession({ rlmSessionDir: join(tempDir, name) });
		const bash = child.executeBash(name, undefined, {
			operations: {
				exec: async () => {
					started.resolve();
					await completion.promise;
					return { exitCode: 0 };
				},
			},
		});
		return { session: child, started: started.promise, completion, bash };
	}

	function quiescenceWaitAborts(target: AgentSession): number {
		return (target as unknown as InspectableRlmSession)._rlmQuiescenceWaitAborts.size;
	}

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

	it.each([
		{ persisted: 2, expected: 2 },
		{ persisted: -1, expected: 1 },
		{ persisted: "0", expected: 1 },
	])("resolves persisted RLM depth $persisted against RLM_DEPTH", ({ persisted, expected }) => {
		const persistedManager = SessionManager.create(tempDir, join(tempDir, "depth-sessions"));
		persistedManager.newSession({ rlmDepth: 2 });
		persistedManager.flushNow();
		const sessionFile = persistedManager.getSessionFile();
		if (!sessionFile) throw new Error("Missing persisted session file");
		const headerLines = readFileSync(sessionFile, "utf8").split("\n");
		headerLines[0] = JSON.stringify({ ...JSON.parse(headerLines[0] ?? "{}"), rlmDepth: persisted });
		writeFileSync(sessionFile, headerLines.join("\n"));
		vi.stubEnv("RLM_DEPTH", "1");
		try {
			const reopened = SessionManager.open(sessionFile, join(tempDir, "depth-sessions"));
			expect(createSession({ maxDepth: 3, sessionManager: reopened }).rlmDepth).toBe(expected);
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
		await expect(root.runRlmChild("invalid name", { name: "   " })).rejects.toThrow(
			"rlm.spawn name must not be empty",
		);
		await expect(root.runRlmChild("reserved name", { name: "all" })).rejects.toThrow(
			"Broadcast agent messaging is not supported",
		);
	});

	it("makes an externally restored retained child listable and deletable", async () => {
		const childId = "restored-child";
		const childDir = join(tempDir, childId);
		mkdirSync(childDir, { recursive: true });
		const child = createSession({ rlmSessionDir: childDir });
		child.setSessionName("restored-worker");
		const restoredAnswer = assistantMessage("restored answer", usage(7, 3));
		restoredAnswer.content.push({ type: "toolCall", id: "tool-1", name: "ipython", arguments: {} });
		child.agent.state.messages.push(restoredAnswer);
		child.setCurrentRecap("restored recap");
		const disposeChild = vi.spyOn(child, "disposeAsync");
		const root = createSession();

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

		const result = await root.runRlmChild("summarize shard 1");

		expect(result.rlm_child_id).toBe(basename(result.session_dir));
		expect(basename(result.session_dir!)).toMatch(/^sub-/);
		expect(dirname(result.session_dir!)).toBe(root.sessionManager.getSessionArtifactDir());
		await waitFor(() => readdirSync(result.session_dir).some((name) => name.endsWith(".jsonl")));
		await waitFor(() => root.getRlmChildSession(result.rlm_child_id)?.getLastAssistantText() !== undefined);
		const child = root.getRlmChildSession(result.rlm_child_id);
		expect(child?.getLastAssistantText()).toBe("child answer: summarize shard 1");
		expect(getMessageText(child?.messages[0])).toContain(
			"The persistent memories produced across this session so far:",
		);
		expect(child?.messages[1]).toMatchObject({
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
	});

	it("wakes the agent with a follow-up when a detached bash handle completes", async () => {
		const prompts: string[] = [];
		const root = createSession({
			streamFn: (_model, context) => {
				prompts.push(userText(context));
				return streamAnswer("checked shell result");
			},
		});
		const handlers = (root as unknown as InspectableRlmSession)._createKernelHostHandlers();
		const completed = handlers["bash.completed"];
		if (!completed) throw new Error("Missing bash.completed host handler");

		await expect(completed({ pid: 42, command: "npm test", exitCode: 1 })).resolves.toEqual({});
		await root.waitForIdle();

		expect(prompts).toEqual(['[bash-done pid:42 exit:1]\n\nCommand: "npm test"']);
		expect(root.messages).toContainEqual(
			expect.objectContaining({
				role: "custom",
				customType: ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
				details: { pid: 42, command: "npm test", exitCode: 1 },
			}),
		);
	});

	it.each([
		{ label: "an in-cell roled send", payload: { message: "done", receiver_role: "parent" } },
		{ label: "a broadcast delivery", payload: { target: "all", message: "done" } },
	])("marks $label to the parent as replied", async ({ payload }) => {
		const sendAgentMessage = vi.fn(async () => ({
			id: "agentmsg-reply",
			source: "agent_message" as const,
			target: { activeSessionId: "parent-active", sessionId: "parent-session" },
			message: "done",
			deliveryStatus: "delivered" as const,
		}));
		const family = vi.fn(async () => [
			{
				relationship: "parent" as const,
				entry: { id: "parent-session", name: "parent", depth: 0, status: "idle" as const },
			},
		]);
		const child = createSession({
			depth: 1,
			agentMessageController: { listAgents: () => ({ agents: [] }), family, sendAgentMessage },
		});
		const send = hostHandler(child, "agent_message.send");

		expect(child.repliedToParentSinceTask).toBe(false);
		await expect(send(payload)).resolves.toBeDefined();
		expect(sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ target: "parent-session", message: "done" }),
		);
		expect(family).toHaveBeenCalledTimes(1);
		expect(child.repliedToParentSinceTask).toBe(true);
	});

	it("resolves a spawned child handle to its published session before a roled send", async () => {
		const publication = deferred<void>();
		let publishedChild: AgentSession | undefined;
		const sendAgentMessage = vi.fn(async (input: { target: string; message: string }) => ({
			id: "agentmsg-child",
			source: "agent_message" as const,
			target: { activeSessionId: "child-active", sessionId: input.target },
			message: input.message,
			deliveryStatus: "delivered" as const,
		}));
		const family = vi.fn(async () =>
			publishedChild
				? [
						{
							relationship: "child" as const,
							entry: {
								id: publishedChild.sessionId,
								name: publishedChild.sessionName ?? publishedChild.sessionId,
								depth: 1,
								status: "running" as const,
							},
						},
					]
				: [],
		);
		const root = createSession({
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				family,
				sendAgentMessage,
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async (options) => {
					await publication.promise;
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
		const send = hostHandler(root, "agent_message.send");

		const pendingSend = send({
			message: "hello",
			receiver_role: "child",
			receiver_name: spawned.rlm_child_id,
		});
		await sleep(0);
		expect(family).not.toHaveBeenCalled();
		expect(sendAgentMessage).not.toHaveBeenCalled();
		publication.resolve();

		await expect(pendingSend).resolves.toMatchObject({ message: "hello" });
		expect(family).toHaveBeenCalledTimes(1);
		expect(sendAgentMessage).toHaveBeenCalledWith(
			expect.objectContaining({ target: publishedChild?.sessionId, message: "hello" }),
		);
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
		expect(reply && isAgentSessionMessage(reply) ? reply.content : undefined).toContain(
			"[agent-message from child:worker]",
		);

		await internals.sendAgentSessionMessage({
			targetSelector: childState.activeSessionId,
			message: "continue",
			fromState: parentState,
			origin: "agent",
		});
		const steer = findLastMessage(child.messages, isAgentSessionMessage);
		expect(steer && isAgentSessionMessage(steer) ? steer.content : undefined).toContain(
			"[agent-message from parent:",
		);
		expect(child.repliedToParentSinceTask).toBe(false);
	});

	it.each([
		{ label: "a parent message is accepted", queued: false },
		{ label: "a parent follow-up is queued", queued: true },
	])("resets replied state when $label", async ({ queued }) => {
		const child = createSession({ depth: 1 });
		(child as unknown as { _repliedToParentSinceTask: boolean })._repliedToParentSinceTask = true;
		const message = createAgentSessionMessage({
			id: "agentmsg-parent-task",
			source: "agent_message",
			message: "new task",
			fromRelationship: "parent",
			target: { activeSessionId: "child-active", sessionId: child.sessionId },
		});

		if (queued) await child.queueAgentMessagePrompt(message.content as string, "followUp", message);
		else await child.acceptAgentMessagePrompt(message.content as string, { customMessage: message });

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

	it.each([
		{
			label: "cancellation",
			cancel: true,
			expected: {
				content: "[child-exited: cancelled child:notice-worker]\n\nCancelled by user",
				details: { kind: "cancelled", reason: "Cancelled by user" },
			},
		},
		{
			label: "no-reply completion",
			cancel: false,
			expected: {
				content: "[child-exited: no-reply child:notice-worker]\n\nLast assistant text: child answer: notice task",
				details: { kind: "completed_without_reply", lastAssistantTextPreview: "child answer: notice task" },
			},
		},
	])("injects exactly one $label notice for a child run", async ({ cancel, expected }) => {
		const { root, releaseChild, hasStarted } = createGatedRoot();

		const spawned = await root.runRlmChild("notice task", { name: "notice-worker" });
		await waitFor(hasStarted);
		const noticeAdmitted = deferred<void>();
		const unsubscribe = root.subscribe((event) => {
			if (
				event.type === "message_start" &&
				event.message.role === "custom" &&
				event.message.customType === "rlm_child_terminal_notice"
			) {
				noticeAdmitted.resolve();
			}
		});
		try {
			if (cancel) expect(root.cancelRlmChildRun(spawned.rlm_child_id)).toBe(true);
			releaseChild();
			await noticeAdmitted.promise;
		} finally {
			unsubscribe();
		}

		expect(terminalNotices(root)).toHaveLength(1);
		expect(terminalNotices(root)[0]).toMatchObject(expected);
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
		expect(terminalNotices(root)).toHaveLength(0);
	});

	it("does not inject a terminal notice when a parent follow-up resets reply state after a reply", async () => {
		const child = createSession({
			depth: 1,
			rlmSessionDir: join(tempDir, "replying-child"),
			agentMessageController: {
				listAgents: () => ({ agents: [] }),
				family: async () => [
					{ relationship: "parent", entry: { id: "parent-session", name: "parent", depth: 0, status: "idle" } },
				],
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
		expect(terminalNotices(root)).toHaveLength(0);
	});

	it("notifies after detached startup deletion cleanup settles", async () => {
		const { root, releaseStartup, hasStarted } = createStartupGatedRoot();

		const spawned = await root.runRlmChild("delete before startup", { name: "deleted-worker" });
		await waitFor(hasStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		releaseStartup();
		await waitFor(() => !(root as unknown as InspectableRlmSession)._activeRlmChildRuns.has(spawned.rlm_child_id));
		expect(terminalNotices(root)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ kind: "cancelled", reason: "Deleted by parent orchestrator" }),
			}),
		]);
	});

	it.each([
		{ label: "its initial task fails", failCompletion: false },
		{ label: "completion persistence fails", failCompletion: true },
	])("releases a hosted child when $label", async ({ failCompletion }) => {
		const child = createSession({ rlmSessionDir: join(tempDir, "host-release-child") });
		const disposeChild = vi.spyOn(child, "disposeAsync");
		if (!failCompletion) vi.spyOn(child, "promptAndWait").mockRejectedValue(new Error("child prompt failed"));
		const releaseRlmSubagentRuntime = vi.fn(async () => {});
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child }),
				completeRlmSubagentRuntime: failCompletion ? () => false : undefined,
				releaseRlmSubagentRuntime,
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("release the hosted child");
		await root.waitForRlmQuiescence();
		expect(releaseRlmSubagentRuntime).toHaveBeenCalledWith(
			expect.objectContaining({ session: child }),
			expect.objectContaining({ id: spawned.rlm_child_id }),
			"error",
		);
		expect(disposeChild).not.toHaveBeenCalled();
		// A failed completion leaves no run behind; a failed task keeps the settled
		// error run addressable for deletion.
		expect((root as unknown as InspectableRlmSession)._activeRlmChildRuns.size).toBe(failCompletion ? 0 : 1);
		if (failCompletion) expect(root.getRlmChildSession(spawned.rlm_child_id)).toBeUndefined();
	});

	it("strong quiescence waits for a gated child bash activity change", async () => {
		const child = gatedBashChild("bash-active-child");
		await child.started;
		await expect(child.session.waitForIdle()).resolves.toBeUndefined();
		const root = createSession();
		expect(root.registerRlmChildSession("bash-active-child", child.session)).toBe(true);
		const originalHeadlessIdle = child.session.waitForHeadlessIdle.bind(child.session);
		let headlessIdleCalls = 0;
		vi.spyOn(child.session, "waitForHeadlessIdle").mockImplementation(async () => {
			headlessIdleCalls++;
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
		expect(headlessIdleCalls).toBe(1);

		child.completion.resolve();
		await child.bash;
		await expect(quiescence).resolves.toBeUndefined();
		expect(headlessIdleCalls).toBe(2);
	});

	it("rechecks parent self-activity after a child quiescence boundary", async () => {
		const child = gatedBashChild("boundary-active-child");
		await child.started;
		const parentBashStarted = deferred<void>();
		const parentBashCompletion = deferred<void>();
		const root = createSession();
		expect(root.registerRlmChildSession("boundary-active-child", child.session)).toBe(true);
		const originalChildQuiescence = child.session.waitForRlmQuiescence.bind(child.session);
		const childWaitStarted = deferred<void>();
		let parentBash: Promise<unknown> | undefined;
		vi.spyOn(child.session, "waitForRlmQuiescence").mockImplementation(async (signal) => {
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
		const firstBoundary = Promise.race([
			quiescence.then(() => "quiesced" as const),
			parentBashStarted.promise.then(() => "parent-active" as const),
		]);
		await childWaitStarted.promise;
		child.completion.resolve();
		await child.bash;
		expect(await firstBoundary).toBe("parent-active");

		parentBashCompletion.resolve();
		await parentBash;
		await expect(quiescence).resolves.toBeUndefined();
	});

	it.each([
		{ label: "the root aborts", abortRoot: true },
		{ label: "one child wait fails", abortRoot: false },
	])("cancels every recursive quiescence waiter when $label", async ({ abortRoot }) => {
		const childA = gatedBashChild("failing-wait-child");
		const childB = gatedBashChild("sibling-wait-child");
		await Promise.all([childA.started, childB.started]);
		const root = createSession();
		expect(root.registerRlmChildSession("failing-wait-child", childA.session)).toBe(true);
		expect(root.registerRlmChildSession("sibling-wait-child", childB.session)).toBe(true);
		const childAWaitStarted = deferred<void>();
		const childBWaitStarted = deferred<void>();
		const originalChildAWait = childA.session.waitForRlmQuiescence.bind(childA.session);
		const originalChildBWait = childB.session.waitForRlmQuiescence.bind(childB.session);
		vi.spyOn(childA.session, "waitForRlmQuiescence").mockImplementation(async (signal) => {
			childAWaitStarted.resolve();
			return originalChildAWait(signal);
		});
		vi.spyOn(childB.session, "waitForRlmQuiescence").mockImplementation(async (signal) => {
			childBWaitStarted.resolve();
			return originalChildBWait(signal);
		});

		const quiescence = root.waitForRlmQuiescence();
		await Promise.all([childAWaitStarted.promise, childBWaitStarted.promise]);
		expect(quiescenceWaitAborts(childA.session)).toBe(1);
		expect(quiescenceWaitAborts(childB.session)).toBe(1);
		if (abortRoot) root.requestAbort();
		else childA.session.requestAbort();

		await expect(quiescence).rejects.toThrow("RLM quiescence wait cancelled");
		expect(quiescenceWaitAborts(childA.session)).toBe(0);
		expect(quiescenceWaitAborts(childB.session)).toBe(0);
		expect(childB.session.isBashRunning).toBe(true);

		childA.completion.resolve();
		childB.completion.resolve();
		await Promise.all([childA.bash, childB.bash]);
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
				family: async () => [],
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
		expect(terminalNotices(root)).toHaveLength(0);

		inputPause.release();
		await expect(quiescence).resolves.toBeUndefined();
		expect(parentNoticeTurns).toBe(1);
		expect(terminalNotices(root)).toHaveLength(1);

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
		expect(terminalNotices(restored)).toHaveLength(1);
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
		expect(terminalNotices(root)).toHaveLength(1);
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

		// Name and id select the same settled run, and concurrent deletes coalesce.
		await expect(
			Promise.all([root.deleteRlmSubagent("settled-error-worker"), root.deleteRlmSubagent(spawned.rlm_child_id)]),
		).resolves.toHaveLength(2);
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
		if (!result.session_dir) throw new Error("Missing child session directory");
		daemonChildId = basename(result.session_dir);
		await waitFor(() => root.getRlmChildSession(daemonChildId)?.getLastAssistantText() !== undefined);

		// Only the parent's own daemon child contributes the messaging identity.
		const expectedSessionName = createDefaultRlmSubagentSessionName("retained worker", daemonChildId);
		const expectedRegistry = {
			subagents: [
				{
					rlm_child_id: daemonChildId,
					active_session_id: "child-active",
					session_id: "child-session",
					session_name: expectedSessionName,
					session_dir: result.session_dir,
					status: "completed",
					answer_preview: "child answer: retained worker",
					duration_ms: expect.any(Number),
					label: "retained worker",
					last_activity_at: expect.any(Number),
					replied_since_task: false,
				},
			],
		};
		expect(await root.listRlmSubagents()).toEqual(expectedRegistry);
		const listHandler = hostHandler(root, "rlm.list_subagents");
		const deleteHandler = hostHandler(root, "rlm.delete_subagent");
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

	it("coalesces the admitted task's tool-loop turns into one flushed spawn-usage attribution", async () => {
		const root = createToolLoopSession(2, [usage(1, 1), usage(2, 2)]);

		await root.runRlmChild("use a tool");
		await vi.waitFor(() => {
			const attributions = root.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "child_usage_attributed");
			expect(attributions).toHaveLength(1);
			expect(attributions[0]?.origin).toBe("spawn_task");
			expect(attributions[0]?.childUsage.input).toBe(3);
			expect(attributions[0]?.childUsage.output).toBe(3);
		});
	});

	it("flushes a stale pending usage batch before extending it, bounding crash loss", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			// The batch from the first two completions is older than the staleness
			// bound when the third lands.
			const root = createToolLoopSession(3, [usage(1, 1), usage(2, 2), usage(4, 4)], (toolResultCount) => {
				if (toolResultCount === 2) vi.setSystemTime(Date.now() + 61_000);
			});

			await root.runRlmChild("use a tool");
			await vi.waitFor(() => {
				const attributions = root.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "child_usage_attributed");
				expect(attributions.map((entry) => [entry.childUsage.input, entry.childUsage.output])).toEqual([
					[3, 3],
					[4, 4],
				]);
				expect(attributions.map((entry) => entry.origin)).toEqual(["spawn_task", "spawn_task"]);
				// Each aggregate covers exactly the completions durable with or
				// before it, so any prefix replays to the exact own spend.
				expect(attributions.map((entry) => entry.aggregateUsage.input)).toEqual([3, 7]);
			});

			const sessionFile = root.sessionManager.getSessionFile();
			if (!sessionFile) throw new Error("parent session file was not created");
			const reloadedAttributions = SessionManager.open(sessionFile, join(tempDir, "sessions"))
				.getEntries()
				.filter((entry) => entry.type === "child_usage_attributed");
			const childTotal = reloadedAttributions.reduce((total, entry) => total + entry.childUsage.input, 0);
			// Parent own spend is zero here, so the reloaded aggregate must equal the summed child usage.
			expect(reloadedAttributions.at(-1)?.aggregateUsage.input).toBe(childTotal);
		} finally {
			vi.useRealTimers();
		}
	});

	it("gets and persists per-chat max-depth changes without transcript messages", async () => {
		const root = createSession();
		const originalMessages = [...root.messages];

		expect(root.getRlmMaxDepthStatus()).toEqual({ maxDepth: 2, source: "default" });
		await expect(root.setRlmMaxDepth(-1)).rejects.toThrow("non-negative integer");
		await root.setRlmMaxDepth(3);

		expect(root.getRlmMaxDepthStatus()).toEqual({ maxDepth: 3, source: "chat" });
		expect(root.messages).toEqual(originalMessages);
		const stateEntries = root.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === "rlm_max_depth_state");
		expect(stateEntries.at(-1)).toMatchObject({ data: { maxDepth: 3 } });
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

	it("applies --global to this chat and new sessions without changing existing sessions", async () => {
		const current = createSession();
		const existingSettings = SettingsManager.create(tempDir, tempDir);
		const existing = createSession({ settingsManager: existingSettings });

		await expect(current.setRlmMaxDepth(4, { global: true })).resolves.toMatchObject({
			maxDepth: 4,
			source: "chat",
			globalSaved: true,
		});
		expect(existing.rlmMaxDepth).toBe(2);
		const freshSettings = SettingsManager.create(tempDir, tempDir);
		const fresh = createSession({ settingsManager: freshSettings });
		expect(fresh.getRlmMaxDepthStatus()).toEqual({ maxDepth: 4, source: "global" });
		current.dispose();
		existing.dispose();
	});

	it("rolls back max-depth state when chat persistence fails", async () => {
		const root = createSession();
		const originalPrompt = root.systemPrompt;
		const flush = vi.spyOn(root.sessionManager, "flushNow").mockImplementation(() => {
			throw new Error("disk full");
		});

		await expect(root.setRlmMaxDepth(0)).rejects.toThrow("disk full");
		expect(root.rlmMaxDepth).toBe(2);
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
		expect(root.systemPrompt).not.toContain("An `rlm` object");
		await expect(root.runRlmChild("blocked at root")).rejects.toThrow(
			"RLM recursion depth limit reached (RLM_DEPTH=0, RLM_MAX_DEPTH=0)",
		);
		expect(child.rlmMaxDepth).toBe(3);
	});

	it("creates an independent root session through the explicit daemon host operation", async () => {
		const createRlmSubagentRuntime = vi.fn(async () => {
			throw new Error("unexpected child spawn");
		});
		const createRlmRootSession = vi.fn(async () => ({
			active_session_id: "root-active",
			session_id: "root-session",
			name: "researcher",
			session_file: join(tempDir, "sessions", "root-session.jsonl"),
			model: `${model.provider}/${model.id}`,
		}));
		const assertSessionNameAvailable = vi.fn();
		const root = createSession({
			agentMessageController: {
				assertSessionNameAvailable,
				listAgents: async () => ({
					current: { activeSessionId: "current-root", sessionId: "current-session" },
					agents: [],
				}),
				sendAgentMessage: async () => {
					throw new Error("unexpected message");
				},
			},
			subagentRuntimeHost: {
				createRlmSubagentRuntime,
				createRlmRootSession,
				deleteRlmSubagentRuntime: vi.fn(async () => {}),
			},
		});

		await expect(
			root.createRlmSession("independent task", {
				name: "researcher",
				model: `${model.provider}/${model.id}`,
				thinking: "off",
				cwd: "other-project",
			}),
		).resolves.toEqual({
			active_session_id: "root-active",
			session_id: "root-session",
			name: "researcher",
			session_file: join(tempDir, "sessions", "root-session.jsonl"),
			model: `${model.provider}/${model.id}`,
		});
		expect(createRlmSubagentRuntime).not.toHaveBeenCalled();
		expect(assertSessionNameAvailable).toHaveBeenCalledWith({ name: "researcher", depth: 0 });
		expect(createRlmRootSession).toHaveBeenCalledWith({
			prompt: "independent task",
			sessionName: "researcher",
			cwd: join(tempDir, "other-project"),
			model,
			thinkingLevel: "off",
		});
		await expect(root.createRlmSession("task", { cwd: " " })).rejects.toThrow(
			"rlm.create_session cwd must be a non-empty string",
		);
		await expect(root.createRlmSession(" ")).rejects.toThrow("rlm.create_session prompt must not be empty");
		expect(createRlmRootSession).toHaveBeenCalledOnce();
	});

	it("keeps top-level session creation unavailable to nested or inline sessions", async () => {
		const createRlmRootSession = vi.fn();
		const nested = createSession({
			depth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: vi.fn(),
				createRlmRootSession,
				deleteRlmSubagentRuntime: vi.fn(async () => {}),
			},
		});
		await expect(nested.createRlmSession("escape to root")).rejects.toThrow("available only from a depth-0 session");
		expect(createRlmRootSession).not.toHaveBeenCalled();
		nested.dispose();

		const inline = createSession();
		await expect(inline.createRlmSession("detached root")).rejects.toThrow(
			"requires a daemon-backed depth-0 session",
		);
	});

	it.each<{ label: string; options: Record<string, unknown>; depth?: number; maxDepth?: number; error: string }>([
		{
			label: "the configured depth cap",
			options: {},
			depth: 1,
			maxDepth: 1,
			error: "RLM recursion depth limit reached",
		},
		{ label: "unsupported kwargs", options: { temperature: 0 }, error: "Unsupported rlm.spawn kwargs: temperature" },
		{ label: "a non-string thinking kwarg", options: { thinking: 3 }, error: "rlm.spawn thinking must be a string" },
		{ label: "an unknown thinking level", options: { thinking: "ultra" }, error: "must be one of" },
	])("rejects rlm.spawn for $label", async ({ options, depth, maxDepth, error }) => {
		const root = createSession({ depth, maxDepth });

		await expect(root.runRlmChild("nested", options)).rejects.toThrow(error);
	});

	it.each<{
		label: string;
		stop: (root: AgentSession) => void | Promise<void>;
		status: string;
		error: string | undefined;
	}>([
		{
			label: "the parent session is disposed",
			stop: (root) => root.dispose(),
			status: "cancelled",
			error: "Parent session disposed",
		},
		{
			label: "the parent session is aborted",
			stop: (root) => root.abort(),
			status: "cancelled",
			error: "Parent session aborted",
		},
		{
			label: "only the parent turn is interrupted",
			stop: (root) => root.requestAbort(),
			status: "running",
			error: undefined,
		},
	])("leaves an active rlm child $status when $label", async ({ stop, status, error }) => {
		const { root, releaseChild, hasStarted } = createGatedRoot();
		const spawned = await root.runRlmChild("slow shard");
		await waitFor(hasStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const run = runs.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing child run");

		await stop(root);

		expect(run.status).toBe(status);
		expect(run.error).toBe(error);
		releaseChild();
		if (status === "running") await waitFor(() => run.status === "done");
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
			progressNotes: [],
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
			progressNotes: [],
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

	it("cancels a single rlm child run by id and reports unknown ids", async () => {
		const { root, releaseChild, hasStarted } = createGatedRoot();
		const spawned = await root.runRlmChild("slow shard");
		await waitFor(hasStarted);
		const runs = (root as unknown as InspectableRlmSession)._activeRlmChildRuns;
		expect(runs.size).toBe(1);
		const childId = spawned.rlm_child_id;
		const run = runs.get(childId);

		expect(root.cancelRlmChildRun("unknown-child")).toBe(false);
		expect(run?.status).toBe("running");

		// Running work retained under the LIVE child: the abort cascade only
		// reaches active runs, so the cancel walk must descend here itself.
		await waitFor(() => run?.session !== undefined);
		const deepHost = createSession({ rlmSessionDir: join(tempDir, "deep-host") });
		const deepAbort = vi.fn();
		const deepRun = {
			id: "deep-1",
			status: "running",
			settled: false,
			abort: deepAbort,
			publication: { reject: vi.fn() },
			emitUpdate: vi.fn(),
		};
		(deepHost as unknown as { _activeRlmChildRuns: Map<string, typeof deepRun> })._activeRlmChildRuns.set(
			"deep-1",
			deepRun,
		);
		(run?.session as unknown as { _rlmChildSessions: Map<string, { session: AgentSession }> })._rlmChildSessions.set(
			"deep-host",
			{ session: deepHost },
		);

		expect(root.cancelRlmChildRun(childId)).toBe(true);
		expect(run?.status).toBe("cancelled");
		expect(run?.error).toBe("Cancelled by user");
		expect(deepRun.status).toBe("cancelled");
		expect(deepAbort).toHaveBeenCalled();
		releaseChild();
		await waitFor(() => !runs.has(childId));
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });

		// The run has finished; a second cancel finds nothing to stop.
		expect(root.cancelRlmChildRun(childId)).toBe(false);
	});

	it("cancels a deep dual-membership chain in one visit per session", async () => {
		const levels = 20;
		const sessions = Array.from({ length: levels + 1 }, (_, level) =>
			createSession({ rlmSessionDir: join(tempDir, `chain-${level}`) }),
		);
		let cancelPrimitiveCalls = 0;
		let runMapIterations = 0;
		for (const [level, session] of sessions.entries()) {
			const target = session as unknown as {
				_activeRlmChildRuns: Map<string, unknown>;
				_rlmChildSessions: Map<string, { session: AgentSession }>;
				_cancelRlmChildRun(run: unknown, reason: string): boolean;
			};
			const original = target._cancelRlmChildRun.bind(session);
			target._cancelRlmChildRun = (run, reason) => {
				cancelPrimitiveCalls++;
				return original(run, reason);
			};
			const originalValues = target._activeRlmChildRuns.values.bind(target._activeRlmChildRuns);
			target._activeRlmChildRuns.values = () => {
				runMapIterations++;
				return originalValues();
			};
			if (level === 0) continue;
			// A finished intermediate lives in BOTH parent maps until passivation.
			const parent = sessions[level - 1] as unknown as {
				_activeRlmChildRuns: Map<string, unknown>;
				_rlmChildSessions: Map<string, { session: AgentSession }>;
			};
			parent._activeRlmChildRuns.set(`chain-${level}`, {
				id: `chain-${level}`,
				status: "done",
				settled: true,
				session,
				abort: vi.fn(),
				publication: { reject: vi.fn() },
				emitUpdate: vi.fn(),
			});
			parent._rlmChildSessions.set(`chain-${level}`, { session });
		}
		const leafAbort = vi.fn();
		const leafRun = {
			id: "leaf-run",
			status: "running",
			settled: false,
			abort: leafAbort,
			publication: { reject: vi.fn() },
			emitUpdate: vi.fn(),
		};
		(sessions[levels] as unknown as { _activeRlmChildRuns: Map<string, typeof leafRun> })._activeRlmChildRuns.set(
			"leaf-run",
			leafRun,
		);

		expect(sessions[0]!.hasRunningRlmChildren()).toBe(true);
		expect(runMapIterations).toBeLessThanOrEqual(3 * (levels + 1));

		expect(sessions[0]!.cancelRunningRlmDescendants()).toBe(true);
		expect(leafRun.status).toBe("cancelled");
		expect(leafAbort).toHaveBeenCalled();
		// One visit per session, not 2^depth.
		expect(cancelPrimitiveCalls).toBeLessThanOrEqual(levels + 1);
		expect(sessions[0]!.hasRunningRlmChildren()).toBe(false);
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
		expect(terminalNotices(root)).toHaveLength(0);

		releaseCleanup();
		await quiescence;
		expect(deleteRuntime).toHaveBeenCalledOnce();
		expect(terminalNotices(root)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({ kind: "cancelled", reason: "Deleted by parent orchestrator" }),
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
		expect(terminalNotices(root)).toHaveLength(1);
		expect(internals._rlmChildCleanupFailures.size).toBe(0);
		await expect(root.runRlmChild("replacement", { name: "retry-worker" })).resolves.toMatchObject({
			name: "retry-worker",
		});
	});

	it.each([
		{ label: "a pre-existing cleanup failure", mode: "pre-failed" as const },
		{ label: "cleanup succeeding during disposal", mode: "succeeds" as const },
		{ label: "cleanup failing during disposal", mode: "fails" as const },
	])("settles parent disposal with $label and admits no terminal notice", async ({ mode }) => {
		const { child: hostedChild, completion: childCompletion, hasStarted } = createAbortInsensitiveChild();
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");
		const cleanup = deferred<void>();
		const deleteRuntime = vi.fn(() =>
			mode === "pre-failed" ? Promise.reject(new Error("cleanup failed before dispose")) : cleanup.promise,
		);
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: deleteRuntime,
			},
		});

		const spawned = await root.runRlmChild("disposal cleanup", { name: "dispose-worker" });
		await waitFor(hasStarted);
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		const internals = root as unknown as InspectableRlmSession;
		const run = internals._activeRlmChildRuns.get(spawned.rlm_child_id);
		if (!run) throw new Error("Missing deleting run");

		if (mode === "pre-failed") {
			await waitFor(() => internals._rlmChildCleanupFailures.size === 1);
			await root.disposeAsync();
		} else {
			const disposal = root.disposeAsync();
			await waitFor(() => internals._disposing);
			if (mode === "succeeds") {
				// Disposal must not wait for the abort-insensitive child task to unwind.
				cleanup.resolve();
			} else {
				cleanup.reject(new Error("cleanup failed during dispose"));
				childCompletion.resolve();
			}
			await disposal;
		}

		expect(deleteRuntime).toHaveBeenCalledOnce();
		if (mode !== "succeeds") expect(disposeHostedChild).toHaveBeenCalled();
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
		expect(internals._unsettledRlmChildRuns.has(run)).toBe(false);
		expect(terminalNotices(root)).toHaveLength(0);
		if (mode === "fails") expect(failureNotices(root)).toHaveLength(0);
		childCompletion.resolve();
	});

	it("keeps deleted live runs in the RLM quiescence barrier until settlement", async () => {
		const { child: hostedChild, completion, hasStarted } = createAbortInsensitiveChild();
		const root = createSession({
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: hostedChild }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});

		const spawned = await root.runRlmChild("slow child", { name: "deleted-live-worker" });
		await waitFor(hasStarted);
		let quiesced = false;
		const quiescence = root.waitForRlmQuiescence().then(() => {
			quiesced = true;
		});
		await root.deleteRlmSubagent(spawned.rlm_child_id);
		await sleep(20);
		expect(quiesced).toBe(false);

		completion.resolve();
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
		expect(terminalNotices(root)).toEqual([
			expect.objectContaining({ details: expect.objectContaining({ kind: "completed_without_reply" }) }),
		]);
		expect(internals._activeRlmChildRuns.has(spawned.rlm_child_id)).toBe(false);
	});

	it.each([
		{ label: "a retry succeeds", retry: true },
		{ label: "the parent tears down first", retry: false },
	])("keeps failed closure retryable until $label", async ({ retry }) => {
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
		const internals = root as unknown as InspectableRlmSession;

		await expect(root.deleteRlmSubagent("release-worker")).rejects.toThrow("close failed");
		expect(await root.listRlmSubagents()).toEqual({ subagents: [] });
		expect(internals._rlmChildCleanupFailures.size).toBe(1);

		if (retry) {
			await expect(root.deleteRlmSubagent("release-worker")).resolves.toMatchObject({
				subagent: { rlm_child_id: "retry-child" },
			});
		} else {
			root.dispose();
			expect(internals._activeRlmChildRuns.size).toBe(0);
			expect(internals._rlmChildSessions.size).toBe(0);
			expect(internals._rlmChildUnsubscribes.size).toBe(0);
		}
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
		const { root, hostedChild, releaseStartup, hasStarted } = createStartupGatedRoot();
		const setSessionName = vi.spyOn(hostedChild, "setSessionName");
		await root.runRlmChild("blocked before runtime creation", { name: "reserved-worker" });
		await waitFor(hasStarted);

		await root.deleteRlmSubagent("reserved-worker");
		await expect(root.runRlmChild("replacement", { name: "reserved-worker" })).rejects.toThrow(
			"an agent of that name already exists at depth 1 under this parent",
		);

		releaseStartup();
		await waitFor(() => (root as unknown as InspectableRlmSession)._activeRlmChildRuns.size === 0);
		expect(setSessionName).not.toHaveBeenCalled();
		await expect(root.runRlmChild("replacement", { name: "reserved-worker" })).resolves.toMatchObject({
			name: "reserved-worker",
		});
	});

	it("keeps late startup cleanup retryable when release and fallback delete fail", async () => {
		let deleteAttempts = 0;
		const deleteRuntime = vi.fn(async (_id: string, child?: AgentSession) => {
			if (++deleteAttempts === 1) throw new Error("fallback delete failed");
			await child?.disposeAsync();
		});
		const { root, hostedChild, releaseStartup, hasStarted } = createStartupGatedRoot({
			deleteRlmSubagentRuntime: deleteRuntime,
			releaseRlmSubagentRuntime: async () => {
				throw new Error("cancelled release failed");
			},
		});
		const disposeHostedChild = vi.spyOn(hostedChild, "disposeAsync");

		await root.runRlmChild("delete during runtime creation", { name: "starting-worker" });
		await waitFor(hasStarted);
		const starting = (await root.listRlmSubagents()).subagents[0];
		expect(starting).toBeDefined();

		await expect(root.deleteRlmSubagent("starting-worker")).resolves.toEqual({ subagent: starting });
		expect(deleteRuntime).not.toHaveBeenCalled();
		releaseStartup();

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

	/** Root over a gated child that owns a nested grandchild. */
	async function createNestedTree(gateNested: boolean): Promise<{
		root: AgentSession;
		parentRun: InspectableRlmRun;
		parentSession: AgentSession;
		nestedId: string;
		release: (prompt?: string) => void;
	}> {
		const gated = gateNested ? ["slow parent", "nested child"] : ["slow parent"];
		const { root, releaseChild, hasStarted } = createGatedRoot({ maxDepth: 2 }, gated);
		void root.runRlmChild("slow parent");
		await waitFor(hasStarted);
		const parentRun = [...(root as unknown as InspectableRlmSession)._activeRlmChildRuns.values()][0];
		if (!parentRun?.session) throw new Error("Missing parent child session");
		const parentSession = parentRun.session;
		const nested = await parentSession.runRlmChild("nested child");
		if (!nested.session_dir) throw new Error("Missing nested child session directory");
		const nestedId = basename(nested.session_dir);
		return { root, parentRun, parentSession, nestedId, release: releaseChild };
	}

	it("deletes an inactive nested RLM child through the root session", async () => {
		const { root, parentRun, parentSession, nestedId, release } = await createNestedTree(false);
		const nestedSession = parentSession.getRlmChildSession(nestedId);
		if (!nestedSession) throw new Error("Missing retained nested child session");
		const disposeNested = vi.spyOn(nestedSession, "disposeAsync");
		await waitFor(() => {
			const status = (parentSession as unknown as InspectableRlmSession)._activeRlmChildRuns.get(nestedId)?.status;
			return status !== "queued" && status !== "running";
		});

		await expect(root.deleteInactiveRlmSubagent(nestedId)).resolves.toBe("deleted");
		expect(await parentSession.listRlmSubagents()).toEqual({ subagents: [] });
		expect(disposeNested).toHaveBeenCalledOnce();
		expect(parentRun.status).toBe("running");

		release();
		await waitFor(() => {
			const status = (root as unknown as InspectableRlmSession)._activeRlmChildRuns.get(parentRun.id)?.status;
			return status === undefined || status === "done";
		});
	});

	it("cancels a running nested rlm child through the root session but never deletes it directly", async () => {
		const { root, parentRun, parentSession, nestedId, release } = await createNestedTree(true);
		const nestedRuns = (parentSession as unknown as InspectableRlmSession)._activeRlmChildRuns;
		await waitFor(() => nestedRuns.get(nestedId)?.status === "running");

		await expect(root.deleteRlmSubagent(nestedId)).rejects.toThrow("No direct RLM subagent matches");
		expect(root.cancelRlmChildRun(nestedId)).toBe(true);
		release("nested child");
		await waitFor(() => !nestedRuns.has(nestedId));
		expect(parentRun.status).toBe("running");

		release("slow parent");
		await waitFor(() => parentRun.status === "done");
	});

	it("handles rlm calls from asyncio tasks after the scheduling cell is idle", async () => {
		const prompts: string[] = [];
		const manager = new ReplKernelManager({
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
    return await rlm.spawn("detached child after idle", name="detached-worker")

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
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
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

	it.each([
		{ label: "a persisted session", subagentDir: undefined },
		{ label: "a subagent session under a parent-assigned dir", subagentDir: "parent-artifact/sub-abc12345" },
		{ label: "an ephemeral session without an artifact dir", subagentDir: "ephemeral-rlm" },
	])("resolves RLM_SESSION_DIR and RLM_HARNESS_STATE_DIR for $label", ({ subagentDir }) => {
		const ephemeral = subagentDir === "ephemeral-rlm";
		const rlmSessionDir = subagentDir ? join(tempDir, subagentDir) : undefined;
		if (rlmSessionDir) mkdirSync(rlmSessionDir, { recursive: true });
		const sessionManager = ephemeral
			? SessionManager.inMemory(tempDir)
			: SessionManager.create(tempDir, rlmSessionDir ?? join(tempDir, "sessions"));
		const root = createSession(sessionManager, undefined, undefined, false, rlmSessionDir);
		const inspectable = root as unknown as InspectableRlmDirSession;

		// Subagent layout: the parent assigns rlmSessionDir, but the child's own
		// sessionManager persists artifacts (and reads local harness state) elsewhere.
		const artifactDir = sessionManager.getSessionArtifactDir();
		const expectedSessionDir = rlmSessionDir ?? artifactDir;
		if (!ephemeral) expect(artifactDir).toBeDefined();
		if (!rlmSessionDir) expect(inspectable._ensureRlmSessionDir()).toBe(artifactDir);
		const env = inspectable._rlmKernelEnv();
		expect(env.RLM_SESSION_DIR).toBe(expectedSessionDir);
		expect(env.RLM_HARNESS_STATE_DIR).toBe(join(artifactDir ?? rlmSessionDir!, "harness"));
		expect(env.RLM_GLOBAL_HARNESS_STATE_DIR).toBeDefined();
	});

	it("loads the ephemeral RLM harness path into the session-start harness digest", () => {
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

		const digest = (
			root as unknown as {
				_harnessDigestWithFingerprint(): { digest: string; stateFingerprint: string };
			}
		)._harnessDigestWithFingerprint().digest;

		expect(root.systemPrompt).not.toContain("Ephemeral note");
		expect(digest).toContain("Ephemeral note");
		expect(digest).toContain("Loaded from the RLM session harness path.");
	});

	it.each([
		{
			label: "no agent dir and no websearch skill",
			agentDir: false,
			serperKey: undefined,
			websearch: false,
			key: undefined,
		},
		{
			label: "an agent dir but no websearch skill",
			agentDir: true,
			serperKey: "stored-key",
			websearch: false,
			key: undefined,
		},
		// loadWebsearchSkill models a --skill/project websearch; the bundled setting
		// is irrelevant because the gate checks the loaded skill, not settings.
		{
			label: "a literal key and a loaded websearch skill",
			agentDir: false,
			serperKey: "literal-key",
			websearch: true,
			key: "literal-key",
		},
		{
			label: "an env-var-reference key",
			agentDir: false,
			serperKey: "MY_SERPER_REF",
			websearch: true,
			key: "resolved-secret",
		},
	])("exports the kernel env for $label", ({ agentDir, serperKey, websearch, key }) => {
		const previousKey = process.env.SERPER_API_KEY;
		const previousRef = process.env.MY_SERPER_REF;
		delete process.env.SERPER_API_KEY;
		process.env.MY_SERPER_REF = "resolved-secret";
		const configuredAgentDir = agentDir ? join(tempDir, "custom-agent-dir") : undefined;
		try {
			const root = createSession(SessionManager.inMemory(tempDir), configuredAgentDir, serperKey, websearch);
			const env = (root as unknown as InspectableRlmDirSession)._rlmKernelEnv();
			expect(env.PRIME_AGENT_CODING_AGENT_DIR).toBe(configuredAgentDir);
			expect(env.SERPER_API_KEY).toBe(key);
		} finally {
			if (previousKey === undefined) delete process.env.SERPER_API_KEY;
			else process.env.SERPER_API_KEY = previousKey;
			if (previousRef === undefined) delete process.env.MY_SERPER_REF;
			else process.env.MY_SERPER_REF = previousRef;
		}
	});
});

describe("#617 subagent terminal agent messages", () => {
	const recursionHarnesses: Harness[] = [];

	afterEach(() => {
		for (const harness of recursionHarnesses.splice(0)) {
			harness.cleanup();
		}
	});

	function terminalNotices(messages: readonly AgentMessage[]): AgentMessage[] {
		return messages.filter(
			(message) => message.role === "custom" && message.customType === "rlm_child_terminal_notice",
		);
	}

	/** Synthesized terminal notices must never travel over the agent_message controller. */
	async function spawnTerminalNoticeChild(options: { serializedRefine?: boolean } = {}) {
		const sendAgentMessage = vi.fn(async () => {
			throw new Error("synthesized terminal notices must not use agent_message");
		});
		const child = await createHarness({
			agentMessageController: { listAgents: () => ({ agents: [] }), sendAgentMessage },
		});
		recursionHarnesses.push(child);
		const parent = await createHarness({
			...options,
			rlmDepth: 0,
			rlmMaxDepth: 1,
			subagentRuntimeHost: {
				createRlmSubagentRuntime: async () => ({ session: child.session }),
				deleteRlmSubagentRuntime: async () => {},
			},
		});
		recursionHarnesses.push(parent);
		child.setResponses([fauxAssistantMessage("child completed")]);
		return { parent, child, sendAgentMessage };
	}

	it("delivers a child completion without a reply through the private typed notice path", async () => {
		const { parent, sendAgentMessage } = await spawnTerminalNoticeChild();

		const spawned = await parent.session.runRlmChild("finish without replying", { name: "terminal-worker" });

		await waitForHeadlessCompletion(parent.session, { waitForRlmQuiescence: true });
		expect(terminalNotices(parent.session.messages)).toHaveLength(1);
		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(terminalNotices(parent.session.messages)[0]).toMatchObject({
			customType: "rlm_child_terminal_notice",
			details: {
				kind: "completed_without_reply",
				childId: spawned.rlm_child_id,
				sessionName: "terminal-worker",
			},
			content: expect.stringContaining("[child-exited: no-reply child:terminal-worker]"),
		});
	});

	it("waits for the parent to consume a child terminal notice", async () => {
		const { parent, sendAgentMessage } = await spawnTerminalNoticeChild({ serializedRefine: true });
		parent.setResponses([fauxAssistantMessage("parent consumed the child result")]);

		const spawned = await parent.session.runRlmChild("finish without replying", { name: "headless-worker" });
		await waitForHeadlessCompletion(parent.session, { waitForRlmQuiescence: true });

		expect(sendAgentMessage).not.toHaveBeenCalled();
		expect(terminalNotices(parent.session.messages)).toEqual([
			expect.objectContaining({
				details: expect.objectContaining({
					kind: "completed_without_reply",
					childId: spawned.rlm_child_id,
					sessionName: "headless-worker",
				}),
			}),
		]);
		expect(getAssistantTexts(parent)).toEqual(["parent consumed the child result"]);
		expect(parent.session.hasRunningRlmChildren()).toBe(false);
	});
});
