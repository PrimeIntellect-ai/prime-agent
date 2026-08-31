import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.js";
import type { AgentSessionRuntimeConfig } from "../../src/core/agent-session-config.js";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { SubagentRuntimeHost } from "../../src/core/rlm-runtime.js";
import { SessionManager } from "../../src/core/session-manager.js";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../../src/index.js";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

type RuntimeSubagentMapAccess = {
	subagentRuntimes: Map<string, AgentSessionRuntime>;
};

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			inMemory?: boolean;
			sessionConfig?: AgentSessionRuntimeConfig;
			sessionManager?: SessionManager;
			sessionOptions?: Parameters<CreateAgentSessionRuntimeFactory>[0]["sessionOptions"];
			onCreateRuntime?: (options: Parameters<CreateAgentSessionRuntimeFactory>[0]) => void;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const serviceOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
			options?.onCreateRuntime?.(runtimeOptions);
			const { cwd, sessionManager, sessionStartEvent } = runtimeOptions;
			const services = await createAgentSessionServices({
				...serviceOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: serviceOptions.model,
					thinkingLevel: serviceOptions.thinkingLevel,
					...runtimeOptions.sessionOptions,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager:
				options?.sessionManager ??
				(options?.inMemory
					? SessionManager.inMemory(tempDir)
					: SessionManager.create(tempDir, join(tempDir, "sessions"))),
			sessionConfig: options?.sessionConfig,
			sessionOptions: options?.sessionOptions,
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir };
	}

	function createRuntimeWithFakeSession(options?: { onShutdown?: () => void }) {
		const disposeSession = vi.fn();
		const session = {
			extensionRunner: {
				hasHandlers: (event: string) => event === "session_shutdown" && options?.onShutdown !== undefined,
				emit: async () => {
					options?.onShutdown?.();
				},
			},
			setSubagentRuntimeHost: vi.fn(),
			dispose: disposeSession,
			disposeAsync: disposeSession,
		} as unknown as AgentSession;
		const services = { cwd: "/tmp", agentDir: "/tmp" } as unknown as AgentSessionServices;
		const createRuntime: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("unexpected runtime creation");
		};
		const runtime = new AgentSessionRuntime(session, services, createRuntime);
		return { runtime, disposeSession };
	}

	it("passes session config to replacement runtimes", async () => {
		const calls: Array<Parameters<CreateAgentSessionRuntimeFactory>[0]> = [];
		const sessionConfig: AgentSessionRuntimeConfig = {
			cwd: "/tmp/session-config-cwd",
			model: "faux-2",
			tools: ["bash"],
		};
		const { runtime } = await createRuntimeForTest(() => {}, {
			sessionConfig,
			onCreateRuntime: (call) => calls.push(call),
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessionConfig).toBe(sessionConfig);

		await runtime.newSession();

		expect(calls).toHaveLength(2);
		expect(calls[1]?.sessionConfig).toBe(sessionConfig);
	});

	it("copies depth across new-session parent reference edges", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const parentSession = runtime.session.sessionFile;
		if (!parentSession) throw new Error("Missing parent session file");

		await runtime.newSession({ parentSession });

		expect(runtime.session.sessionManager.getHeader()).toMatchObject({ parentSession, rlmDepth: 0 });
	});

	it("uses effective runtime depth for a parented new session from a legacy header", async () => {
		const tempDir = join(tmpdir(), `pi-runtime-legacy-new-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		sessionManager.newSession({ rlmDepth: undefined });
		const parentSession = sessionManager.getSessionFile();
		if (!parentSession) throw new Error("Missing parent session file");
		const { runtime } = await createRuntimeForTest(() => {}, {
			cwd: tempDir,
			sessionManager,
			sessionOptions: { rlmDepth: 2 },
		});

		await runtime.newSession({ parentSession });

		expect(runtime.session.sessionManager.getHeader()).toMatchObject({ parentSession, rlmDepth: 2 });
	});

	it.each([false, true])(
		"uses the effective runtime depth when forking a legacy session before its first entry (inMemory=%s)",
		async (inMemory) => {
			const tempDir = join(tmpdir(), `pi-runtime-legacy-fork-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const sessionManager = inMemory
				? SessionManager.inMemory(tempDir)
				: SessionManager.create(tempDir, join(tempDir, "sessions"));
			sessionManager.newSession({ rlmDepth: undefined });
			const firstEntry = sessionManager.appendMessage({ role: "user", content: "fork here", timestamp: 1 });
			const { runtime } = await createRuntimeForTest(() => {}, {
				cwd: tempDir,
				sessionManager,
				sessionOptions: { rlmDepth: 2 },
			});

			await runtime.fork(firstEntry);

			expect(runtime.session.sessionManager.getHeader()?.rlmDepth).toBe(2);
			expect(runtime.session.rlmDepth).toBe(2);
		},
	);

	it("disposes a runtime only once across repeated teardown calls", async () => {
		const shutdownEvents: SessionShutdownEvent[] = [];
		const beforeInvalidate = vi.fn();
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_shutdown", (event) => {
				shutdownEvents.push(event);
			});
		});
		runtime.setBeforeSessionInvalidate(beforeInvalidate);

		await Promise.all([runtime.dispose(), runtime.dispose()]);
		await runtime.dispose();

		expect(shutdownEvents).toEqual([{ type: "session_shutdown", reason: "quit" }]);
		expect(beforeInvalidate).toHaveBeenCalledTimes(1);
	});

	it("does not replay shutdown events when runtime disposal throws", async () => {
		let shutdownCount = 0;
		const { runtime, disposeSession } = createRuntimeWithFakeSession({
			onShutdown: () => {
				shutdownCount += 1;
			},
		});
		runtime.setBeforeSessionInvalidate(() => {
			throw new Error("invalidate failed");
		});

		await expect(runtime.dispose()).rejects.toThrow("invalidate failed");
		await expect(runtime.dispose()).rejects.toThrow("invalidate failed");

		expect(shutdownCount).toBe(1);
		expect(disposeSession).toHaveBeenCalledTimes(1);
	});

	it("continues disposing tracked subagents after one child dispose fails", async () => {
		const { runtime } = createRuntimeWithFakeSession();
		const firstDispose = vi.fn(async () => {
			throw new Error("first child failed");
		});
		const secondDispose = vi.fn(async () => {});
		const firstChild = { dispose: firstDispose } as unknown as AgentSessionRuntime;
		const secondChild = { dispose: secondDispose } as unknown as AgentSessionRuntime;
		const runtimeWithSubagents = runtime as unknown as RuntimeSubagentMapAccess;
		runtimeWithSubagents.subagentRuntimes.set("first", firstChild);
		runtimeWithSubagents.subagentRuntimes.set("second", secondChild);

		await expect(runtime.dispose()).rejects.toThrow("first child failed");

		expect(firstDispose).toHaveBeenCalledTimes(1);
		expect(secondDispose).toHaveBeenCalledTimes(1);
	});

	it("deletes exact and replaced in-process RLM child runtimes and retained sessions", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const childSession = {} as AgentSession;
		const disposeRuntime = vi.fn(async () => {});
		const childRuntime = { session: childSession, dispose: disposeRuntime } as unknown as AgentSessionRuntime;
		const runtimeWithSubagents = runtime as unknown as RuntimeSubagentMapAccess;
		runtimeWithSubagents.subagentRuntimes.set("child-1", childRuntime);

		await runtime.deleteRlmSubagentRuntime("child-1", childSession);

		expect(disposeRuntime).toHaveBeenCalledOnce();
		expect(runtimeWithSubagents.subagentRuntimes.has("child-1")).toBe(false);

		const currentSession = {} as AgentSession;
		const disposeReplacedRuntime = vi.fn(async () => {});
		const replacedRuntime = {
			session: currentSession,
			dispose: disposeReplacedRuntime,
		} as unknown as AgentSessionRuntime;
		const disposeStaleSession = vi.fn(async () => {});
		const staleSession = { disposeAsync: disposeStaleSession } as unknown as AgentSession;
		runtimeWithSubagents.subagentRuntimes.set("replaced-child", replacedRuntime);

		await runtime.deleteRlmSubagentRuntime("replaced-child", staleSession);

		expect(disposeReplacedRuntime).toHaveBeenCalledOnce();
		expect(disposeStaleSession).toHaveBeenCalledOnce();
		expect(runtimeWithSubagents.subagentRuntimes.has("replaced-child")).toBe(false);

		const disposeRetained = vi.fn(async () => {});
		const retainedSession = { disposeAsync: disposeRetained } as unknown as AgentSession;
		await runtime.deleteRlmSubagentRuntime("retained-child", retainedSession);
		expect(disposeRetained).toHaveBeenCalledOnce();
	});

	it("publishes in-process RLM sessions before create resolves and rejects cancelled startup", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {});
		const parentSession = runtime.session;
		const getRunStatus = vi.spyOn(parentSession, "getRlmChildRunStatus").mockReturnValue("running");
		let createResolved = false;
		const onSessionPublished = vi.fn((session: AgentSession) => {
			expect(createResolved).toBe(false);
			expect(session.sessionName).toBe("in-process-worker");
		});
		const baseOptions = {
			parentSession,
			prompt: "run in process",
			model: faux.getModel(),
			thinkingLevel: "off" as const,
			serviceTier: null,
			scopedModels: [],
			activeToolNames: [],
			customTools: [],
			includeGoals: false,
			includeCompactSkill: false,
			rlmDepth: 1,
			rlmMaxDepth: 2,
		};

		const childRuntime = await runtime.createRlmSubagentRuntime({
			...baseOptions,
			id: "in-process-child",
			sessionName: "in-process-worker",
			sessionDir: join(tempDir, "in-process-child"),
			rlmParentNodeId: "in-process-child",
			onSessionPublished,
		});
		createResolved = true;
		expect(onSessionPublished).toHaveBeenCalledOnce();
		await runtime.deleteRlmSubagentRuntime("in-process-child", childRuntime.session);

		getRunStatus.mockReturnValue("cancelled");
		await expect(
			runtime.createRlmSubagentRuntime({
				...baseOptions,
				id: "cancelled-child",
				sessionName: "cancelled-worker",
				sessionDir: join(tempDir, "cancelled-child"),
				rlmParentNodeId: "cancelled-child",
			}),
		).rejects.toThrow("startup was cancelled");
		expect((runtime as unknown as RuntimeSubagentMapAccess).subagentRuntimes.has("cancelled-child")).toBe(false);
	});

	it("releases a failed child run from the inline runtime host", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		const deleteRlmSubagentRuntime = vi.spyOn(runtime, "deleteRlmSubagentRuntime");
		vi.spyOn(runtime, "createRlmSubagentRuntime").mockImplementationOnce(async (options) => {
			const childRuntime = await AgentSessionRuntime.prototype.createRlmSubagentRuntime.call(runtime, options);
			vi.spyOn(childRuntime.session, "promptAndWait").mockRejectedValue(new Error("child run failed"));
			return childRuntime;
		});

		await runtime.session.runRlmChild("fail after startup");

		await vi.waitFor(() => expect(deleteRlmSubagentRuntime).toHaveBeenCalledOnce());
		expect(runtime.listSubagentRuntimes()).toEqual([]);
	});

	it("plumbs the parent agent identity into runtime-created child prompts", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		runtime.session.setSessionName("parent-worker");
		const childRuntime = await runtime.createRlmSubagentRuntime({
			parentSession: runtime.session,
			id: "parent-agent-child",
			prompt: "inspect parent identity",
			sessionName: "child-worker",
			sessionDir: join(runtime.cwd, "parent-agent-child"),
			model: runtime.session.model!,
			thinkingLevel: "off",
			serviceTier: null,
			scopedModels: [],
			activeToolNames: [],
			customTools: [],
			includeGoals: false,
			includeCompactSkill: false,
			rlmDepth: 1,
			rlmMaxDepth: 2,
			rlmParentNodeId: "parent-agent-child",
		});

		expect(childRuntime.session.systemPrompt).toContain("spawned by parent-worker");
		await runtime.deleteRlmSubagentRuntime("parent-agent-child", childRuntime.session);
	});

	it("disposes hosted RLM children during session replacement", async () => {
		const disposeRlmSubagentRuntimes = vi.fn(async () => {});
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async () => {
				throw new Error("unexpected child creation");
			},
			deleteRlmSubagentRuntime: async () => {},
			disposeRlmSubagentRuntimes,
		};
		const { runtime } = await createRuntimeForTest(() => {});
		runtime.setSubagentRuntimeHost(host);

		await runtime.newSession();

		expect(disposeRlmSubagentRuntimes).toHaveBeenCalledTimes(1);
	});

	it("persists message_end assistant replacements to the session manager", async () => {
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("message_end", (event) => {
				if (event.message.role !== "assistant") return;

				return {
					message: {
						...event.message,
						usage: {
							...event.message.usage,
							cost: {
								...event.message.usage.cost,
								total: 0.123,
							},
						},
					},
				};
			});
		});

		await runtime.session.prompt("hello");

		const sessionAssistant = runtime.session.messages.find((message) => message.role === "assistant");
		expect(sessionAssistant?.role).toBe("assistant");
		if (sessionAssistant?.role !== "assistant") {
			throw new Error("missing assistant message");
		}
		expect(sessionAssistant.usage.cost.total).toBe(0.123);

		const persistedAssistant = runtime.session.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message)
			.find((message) => message.role === "assistant");
		expect(persistedAssistant?.role).toBe("assistant");
		if (persistedAssistant?.role !== "assistant") {
			throw new Error("missing persisted assistant message");
		}
		expect(persistedAssistant.usage.cost.total).toBe(0.123);
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;
		const originalSession = runtime.session;

		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(runtime.session).not.toBe(originalSession);
		expect(runtime.session.messages).toEqual([]);
		const secondSessionFile = runtime.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;

		const switchResult = await runtime.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation for new and resume", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelReason: "new" | "resume" | undefined;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => {
				events.push(event);
				if (event.reason === cancelReason) {
					return { cancel: true };
				}
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		await runtime.session.prompt("hello");
		const originalSessionFile = runtime.session.sessionFile;

		cancelReason = "new";
		const newResult = await runtime.newSession();
		expect(newResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);

		events.length = 0;
		const otherDir = join(tmpdir(), `pi-runtime-other-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(otherDir, { recursive: true });
		const otherSession = SessionManager.create(otherDir, join(otherDir, "sessions"));
		otherSession.appendMessage({ role: "user", content: [{ type: "text", text: "other" }], timestamp: Date.now() });
		const otherSessionFile = otherSession.getSessionFile();
		cancelReason = "resume";
		const resumeResult = await runtime.switchSession(otherSessionFile!);
		expect(resumeResult.cancelled).toBe(true);
		expect(runtime.session.sessionFile).toBe(originalSessionFile);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			pi.on("session_shutdown", (event) => {
				events.push(event);
			});
			pi.on("session_start", (event) => {
				events.push(event);
			});
		});

		events.length = 0;
		await runtime.session.prompt("hello");
		const userMessage = runtime.session.getUserMessagesForForking()[0]!;
		const previousSessionFile = runtime.session.sessionFile;

		const successResult = await runtime.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtime.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtime.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtime.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});

	it("forks before a selected middle prompt and preserves its selection metadata", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("Say one");
		await runtime.session.prompt("Say two");
		await runtime.session.prompt("Say three");
		const userMessages = runtime.session.getUserMessagesForForking();
		expect(userMessages.map((message) => message.text)).toEqual(["Say one", "Say two", "Say three"]);

		const result = await runtime.fork(userMessages[1]!.entryId);

		expect(result).toEqual({ cancelled: false, selectedText: "Say two" });
		expect(
			runtime.session.messages.map((message) =>
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: message.role,
			),
		).toEqual(["Say one", "assistant"]);
		expect(runtime.session.sessionFile).toBeDefined();
	});

	it("forks before the first prompt in-memory and preserves its selection metadata", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { inMemory: true });
		await runtime.session.prompt("Say one");
		const userMessages = runtime.session.getUserMessagesForForking();

		const result = await runtime.fork(userMessages[0]!.entryId);

		expect(result).toEqual({ cancelled: false, selectedText: "Say one" });
		expect(runtime.session.messages).toEqual([]);
		expect(runtime.session.sessionFile).toBeUndefined();
	});

	it("duplicates the current active branch when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const previousSessionFile = runtime.session.sessionFile;
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).not.toBe(previousSessionFile);
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("duplicates the current active branch in-memory when forking at the current position", async () => {
		const { runtime } = await createRuntimeForTest(() => {}, { inMemory: true });

		await runtime.session.prompt("hello");
		await runtime.session.prompt("again");

		const beforeMessages = runtime.session.messages.map((message) => ({
			role: message.role,
			text:
				message.role === "user"
					? typeof message.content === "string"
						? message.content
						: message.content
								.filter((part): part is { type: "text"; text: string } => part.type === "text")
								.map((part) => part.text)
								.join("")
					: undefined,
		}));
		const leafId = runtime.session.sessionManager.getLeafId();
		expect(leafId).toBeTruthy();
		expect(runtime.session.sessionFile).toBeUndefined();

		const result = await runtime.fork(leafId!, { position: "at" });
		expect(result).toEqual({ cancelled: false, selectedText: undefined });
		expect(runtime.session.sessionFile).toBeUndefined();
		expect(
			runtime.session.messages.map((message) => ({
				role: message.role,
				text:
					message.role === "user"
						? typeof message.content === "string"
							? message.content
							: message.content
									.filter((part): part is { type: "text"; text: string } => part.type === "text")
									.map((part) => part.text)
									.join("")
						: undefined,
			})),
		).toEqual(beforeMessages);
	});

	it("throws when forking with an invalid entry id", async () => {
		const { runtime } = await createRuntimeForTest(() => {});
		await expect(runtime.fork("missing-entry")).rejects.toThrow("Invalid entry ID for forking");
	});

	it("updates the runtime session cwd on cross-cwd session replacement", async () => {
		const firstDir = join(tmpdir(), `pi-runtime-cwd-a-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const secondDir = join(tmpdir(), `pi-runtime-cwd-b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(firstDir, { recursive: true });
		mkdirSync(secondDir, { recursive: true });
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, { cwd: firstDir });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: secondDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(secondDir, join(secondDir, "sessions")),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.prompt("other");
		const otherSessionFile = otherRuntime.session.sessionFile!;
		await otherRuntime.dispose();

		await runtime.switchSession(otherSessionFile);

		expect(realpathSync(runtime.session.sessionManager.getCwd())).toBe(realpathSync(secondDir));
		expect(realpathSync(runtime.cwd)).toBe(realpathSync(secondDir));
	});

	it("restores model and thinking state from the destination session", async () => {
		const { runtime, faux, tempDir } = await createRuntimeForTest(() => {}, {
			bootstrapModel: false,
			bootstrapThinkingLevel: false,
		});
		const otherDir = join(tempDir, "other");
		mkdirSync(otherDir, { recursive: true });
		const otherAuthStorage = AuthStorage.inMemory();
		otherAuthStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const otherRuntimeOptions = {
			agentDir: tempDir,
			authStorage: otherAuthStorage,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createOtherRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({
				...otherRuntimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const otherRuntime = await createAgentSessionRuntime(createOtherRuntime, {
			cwd: otherDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(otherDir, join(otherDir, "sessions")),
		});
		cleanups.push(async () => {
			await otherRuntime.dispose();
		});
		await otherRuntime.session.setModel(faux.getModel("faux-2")!);
		otherRuntime.session.setThinkingLevel("off");
		await otherRuntime.session.prompt("hello");
		const targetSessionFile = otherRuntime.session.sessionFile!;
		await otherRuntime.dispose();

		await runtime.switchSession(targetSessionFile);

		expect(runtime.session.model?.id).toBe("faux-2");
		expect(runtime.session.thinkingLevel).toBe("off");
	});
});
