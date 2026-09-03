import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	getModel,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { SubagentRuntimeHost } from "../src/core/rlm-runtime.js";
import {
	deriveSemanticEdges,
	IDEMPOTENCY_KEY_HEADER,
	MODEL_REQUEST_ID_HEADER,
	readSemanticEdgeLedger,
	SEMANTIC_EDGES_LEDGER_FILENAME,
	type SemanticEdgeLedgerEvent,
} from "../src/core/semantic-edges.js";
import { SessionManager } from "../src/core/session-manager.js";
import { type Settings, SettingsManager } from "../src/core/settings-manager.js";
import { startSideQuestion } from "../src/core/side-question.js";
import { createHarness, type Harness } from "./suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function usage(): Usage {
	return {
		input: 7,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 10,
		cost: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10 },
	};
}

function assistantMessage(text: string, options: { errorMessage?: string } = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: usage(),
		stopReason: options.errorMessage ? "error" : "stop",
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role !== "user") continue;
		if (typeof message.content === "string") return message.content;
		return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
	}
	return "";
}

type ScriptedResponse = { text: string; errorMessage?: string };

async function waitForAsync(condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await sleep(10);
	}
}

describe("AgentSession semantic edges", () => {
	let tempDir: string;
	let sessions: AgentSession[];
	let harnesses: Harness[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-semantic-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		sessions = [];
		harnesses = [];
	});

	afterEach(() => {
		for (const session of sessions) {
			session.dispose();
		}
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(
		options: {
			responses?: ScriptedResponse[];
			settings?: Partial<Settings>;
			sessionManager?: SessionManager;
			rlmSessionDir?: string;
			extensionsResult?: Awaited<ReturnType<typeof createTestExtensionsResult>>;
			subagentRuntimeHost?: SubagentRuntimeHost;
			hangMarker?: string;
			onChildCallStarted?: () => void;
		} = {},
	) {
		const capturedHeaders: Array<Record<string, string> | undefined> = [];
		const responses = options.responses;
		const streamFn: StreamFn = (_model, context, streamOptions) => {
			capturedHeaders.push(streamOptions?.headers);
			const stream = createAssistantMessageEventStream();
			if (options.hangMarker && lastUserText(context).includes(options.hangMarker)) {
				options.onChildCallStarted?.();
				return stream;
			}
			const next = responses?.shift() ?? { text: "ok" };
			queueMicrotask(() => {
				const message = assistantMessage(next.text, { errorMessage: next.errorMessage });
				if (next.errorMessage) {
					stream.push({ type: "error", reason: "error", error: message });
				} else {
					stream.push({ type: "done", reason: "stop", message });
				}
			});
			return stream;
		};

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = options.sessionManager ?? SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = options.settings
			? SettingsManager.inMemory(options.settings)
			: SettingsManager.create(tempDir, tempDir);

		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});

		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(
				options.extensionsResult ? { extensionsResult: options.extensionsResult } : undefined,
			),
			rlmSessionDir: options.rlmSessionDir,
			subagentRuntimeHost: options.subagentRuntimeHost,
		});
		sessions.push(session);
		return { session, sessionManager, capturedHeaders };
	}

	function ledgerFor(session: AgentSession): SemanticEdgeLedgerEvent[] {
		const artifactDir = session.sessionManager.getSessionArtifactDir();
		if (!artifactDir) throw new Error("Missing session artifact dir");
		return readSemanticEdgeLedger(join(artifactDir, SEMANTIC_EDGES_LEDGER_FILENAME));
	}

	function startedRequestIds(events: SemanticEdgeLedgerEvent[]): string[] {
		return events
			.filter((event) => event.type === "request_started")
			.map((event) => (event.type === "request_started" ? event.request_id : ""));
	}

	function childLedgerPath(sessionDir: string): string {
		return join(sessionDir, SEMANTIC_EDGES_LEDGER_FILENAME);
	}

	it("sends one ledger-backed request ID per turn on both wire headers", async () => {
		const { session, capturedHeaders } = createSession();

		await session.prompt("first");
		await session.prompt("second");

		expect(capturedHeaders).toHaveLength(2);
		const requestIds = capturedHeaders.map((headers) => headers?.[MODEL_REQUEST_ID_HEADER]);
		expect(requestIds[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(requestIds[1]).toMatch(/^[0-9a-f]{32}$/);
		expect(requestIds[0]).not.toBe(requestIds[1]);
		for (const headers of capturedHeaders) {
			expect(headers?.[IDEMPOTENCY_KEY_HEADER]).toBe(headers?.[MODEL_REQUEST_ID_HEADER]);
		}

		// Every wire request ID was written to the durable ledger before the call,
		// committed on stream completion, and the committed chain derives edges.
		const events = ledgerFor(session);
		expect(startedRequestIds(events)).toEqual(requestIds);
		expect(events.filter((event) => event.type === "request_finished")).toHaveLength(2);
		expect(deriveSemanticEdges([events]).edges).toEqual([
			{ source_request_id: requestIds[0], target_request_id: requestIds[1], type: "continuation" },
		]);
	});

	it("writes the request event before the provider call is made", async () => {
		const observed: Array<{ wireId: string | undefined; ledgerIds: string[] }> = [];
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const streamFn: StreamFn = (_model, _context, streamOptions) => {
			const ledgerPath = join(sessionManager.getSessionArtifactDir() ?? "", SEMANTIC_EDGES_LEDGER_FILENAME);
			observed.push({
				wireId: streamOptions?.headers?.[MODEL_REQUEST_ID_HEADER],
				ledgerIds: startedRequestIds(readSemanticEdgeLedger(ledgerPath)),
			});
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "done", reason: "stop", message: assistantMessage("ok") });
			});
			return stream;
		};
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);

		await session.prompt("prove ordering");

		expect(observed).toHaveLength(1);
		expect(observed[0]?.wireId).toBeDefined();
		expect(observed[0]?.ledgerIds).toContain(observed[0]?.wireId);
	});

	it("reuses the same request ID across auto-retry attempts of one call", async () => {
		const { session, capturedHeaders } = createSession({
			responses: [{ text: "", errorMessage: "overloaded_error" }, { text: "recovered" }],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
		});

		await session.prompt("retry me");

		expect(capturedHeaders).toHaveLength(2);
		expect(capturedHeaders[0]?.[MODEL_REQUEST_ID_HEADER]).toBeDefined();
		expect(capturedHeaders[1]?.[MODEL_REQUEST_ID_HEADER]).toBe(capturedHeaders[0]?.[MODEL_REQUEST_ID_HEADER]);

		// started, failed, re-logged start, finished — and no self-referential edges.
		const events = ledgerFor(session);
		const requestEvents = events.filter(
			(event) =>
				event.type === "request_started" || event.type === "request_failed" || event.type === "request_finished",
		);
		expect(requestEvents.map((event) => event.type)).toEqual([
			"request_started",
			"request_failed",
			"request_started",
			"request_finished",
		]);
		expect(deriveSemanticEdges([events]).edges).toEqual([]);
	});

	it("forfeits retry-ID reuse when a payload-mutating hook is registered", async () => {
		// before_provider_request rewrites the wire body AFTER the hash point, so a
		// reused Idempotency-Key could sit on two different bodies.
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi: any) => {
					pi.on("before_provider_request", async (payload: any) => payload);
				},
			],
			tempDir,
		);
		const { session, capturedHeaders } = createSession({
			responses: [{ text: "", errorMessage: "overloaded_error" }, { text: "recovered" }],
			settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
			extensionsResult,
		});

		await session.prompt("retry me");

		expect(capturedHeaders).toHaveLength(2);
		expect(capturedHeaders[1]?.[MODEL_REQUEST_ID_HEADER]).toBeDefined();
		expect(capturedHeaders[1]?.[MODEL_REQUEST_ID_HEADER]).not.toBe(capturedHeaders[0]?.[MODEL_REQUEST_ID_HEADER]);
	});

	it("excludes side questions from the ledger and the continuation chain", async () => {
		const { session, capturedHeaders } = createSession();

		await session.prompt("first");
		const events: string[] = [];
		const run = startSideQuestion(session.agent, "sq-1", "what changed?", (event) => {
			events.push(event.status);
		});
		await run.done;
		expect(events.at(-1)).toBe("complete");
		await session.prompt("second");

		// The side call reached the wire without provenance headers or ledger entries.
		expect(capturedHeaders).toHaveLength(3);
		expect(capturedHeaders[1]?.[MODEL_REQUEST_ID_HEADER]).toBeUndefined();
		const ledger = ledgerFor(session);
		const requestIds = startedRequestIds(ledger);
		expect(requestIds).toHaveLength(2);
		expect(deriveSemanticEdges([ledger]).edges).toEqual([
			{ source_request_id: requestIds[0], target_request_id: requestIds[1], type: "continuation" },
		]);
	});

	/** Attribution requires an active run: production spawns execute inside a turn's tool call. */
	function spawnDuringRun<T>(session: AgentSession, spawn: () => Promise<T>): Promise<T> {
		const activeRun = vi.spyOn(session, "isStreaming", "get").mockReturnValue(true);
		return spawn().finally(() => activeRun.mockRestore());
	}

	it("records spawned-child ancestry from the latest turn and returns it on success", async () => {
		const { session: root, capturedHeaders } = createSession();

		await root.prompt("parent turn one");
		await root.prompt("parent turn two");
		const spawned = await spawnDuringRun(root, () => root.runRlmChild("child task"));
		const childId = basename(spawned.session_dir);
		await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status === "completed");

		const rootEvents = ledgerFor(root);
		expect(existsSync(childLedgerPath(spawned.session_dir))).toBe(true);
		const childEvents = readSemanticEdgeLedger(childLedgerPath(spawned.session_dir));

		// Ancestry points at the latest parent request at spawn time, not the first.
		const rootRequestIds = startedRequestIds(rootEvents);
		expect(rootRequestIds.length).toBeGreaterThanOrEqual(2);
		expect(childEvents.find((event) => event.type === "session_registered")).toMatchObject({
			parent_session_id: root.sessionId,
			spawned_by_request_id: rootRequestIds[1],
		});

		// Exactly one committed child request, minted in the child ledger only, and on the wire.
		const childRequestIds = startedRequestIds(childEvents);
		expect(childRequestIds).toHaveLength(1);
		expect(rootRequestIds).not.toContain(childRequestIds[0]);
		expect(capturedHeaders.map((headers) => headers?.[MODEL_REQUEST_ID_HEADER])).toContain(childRequestIds[0]);

		// The parent claimed the successful return with the child's last commit.
		expect(rootEvents.filter((event) => event.type === "child_returned")).toEqual([
			{
				type: "child_returned",
				session_id: root.sessionId,
				child_session_id: root.getRlmChildSession(childId)?.sessionId,
				request_id: childRequestIds[0],
			},
		]);

		// The next committed parent request carries both the call and return edges.
		await root.prompt("after the child");
		const edges = deriveSemanticEdges([ledgerFor(root), childEvents]).edges;
		expect(edges).toContainEqual({
			source_request_id: rootRequestIds[1],
			target_request_id: childRequestIds[0],
			type: "subagent_call",
		});
		const returnEdges = edges.filter((edge) => edge.type === "subagent_return");
		expect(returnEdges).toHaveLength(1);
		expect(returnEdges[0]?.source_request_id).toBe(childRequestIds[0]);
	});

	it("records no spawn attribution for a child spawned outside an active run", async () => {
		const { session: root } = createSession();
		await root.prompt("completed turn");
		expect(root.semanticEdges.lastTurnRequestId).toBeDefined();

		const spawned = await root.runRlmChild("out-of-band child");
		await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status === "completed");

		const registration = readSemanticEdgeLedger(childLedgerPath(spawned.session_dir)).find(
			(event) => event.type === "session_registered",
		);
		expect(registration).toMatchObject({ parent_session_id: root.sessionId });
		expect(registration?.type === "session_registered" ? registration.spawned_by_request_id : "set").toBeUndefined();
		const childEvents = readSemanticEdgeLedger(childLedgerPath(spawned.session_dir));
		const edges = deriveSemanticEdges([ledgerFor(root), childEvents]).edges;
		expect(edges.filter((edge) => edge.type === "subagent_call")).toEqual([]);
	});

	it("restores spawn attribution from the ledger after a resume", async () => {
		const { session: first } = createSession();
		await first.prompt("turn before resume");
		const requestBeforeResume = startedRequestIds(ledgerFor(first))[0];
		const sessionFile = first.sessionFile;
		if (!sessionFile) throw new Error("Missing session file");
		first.dispose();

		const resumedManager = SessionManager.open(sessionFile, join(tempDir, "sessions"));
		const { session: resumed } = createSession({ sessionManager: resumedManager });
		const spawned = await spawnDuringRun(resumed, () => resumed.runRlmChild("child after resume"));
		await waitForAsync(async () => (await resumed.listRlmSubagents()).subagents[0]?.status === "completed");

		const childEvents = readSemanticEdgeLedger(childLedgerPath(spawned.session_dir));
		expect(childEvents.find((event) => event.type === "session_registered")).toMatchObject({
			parent_session_id: resumed.sessionId,
			spawned_by_request_id: requestBeforeResume,
		});
		const edges = deriveSemanticEdges([ledgerFor(resumed), childEvents]).edges;
		expect(edges.filter((edge) => edge.type === "subagent_call")).toHaveLength(1);
	});

	it("snapshots spawn ancestry at the spawn entry point, before preflight awaits", async () => {
		const { session: root } = createSession();
		await root.prompt("turn one");
		const firstId = startedRequestIds(ledgerFor(root))[0];

		// Advance the parent's lineage while runRlmChild is still awaiting preflight.
		const spawnPromise = spawnDuringRun(root, () => root.runRlmChild("child task"));
		const laterId = root.semanticEdges.startTurnRequest("later-body-hash");
		const spawned = await spawnPromise;
		await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status === "completed");

		const childEvents = readSemanticEdgeLedger(childLedgerPath(spawned.session_dir));
		const registration = childEvents.find((event) => event.type === "session_registered");
		expect(registration).toMatchObject({ spawned_by_request_id: firstId });
		expect(registration?.type === "session_registered" ? registration.spawned_by_request_id : undefined).not.toBe(
			laterId,
		);
	});

	function failingChildHost(options: { commitBeforeFailure: boolean }) {
		const state: { child?: AgentSession } = {};
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (hostOptions) => {
				const childManager = SessionManager.create(tempDir, hostOptions.sessionDir);
				const created = createSession({
					sessionManager: childManager,
					rlmSessionDir: hostOptions.sessionDir,
				}).session;
				if (options.commitBeforeFailure) {
					await created.prompt("child work before the failure");
				}
				vi.spyOn(created, "promptAndWait").mockRejectedValue(new Error("child run failed"));
				state.child = created;
				hostOptions.onSessionPublished?.(created);
				return { session: created };
			},
			deleteRlmSubagentRuntime: async (_childId, runtime) => {
				if (runtime && "session" in runtime) await runtime.session.disposeAsync();
			},
		};
		return { host, state };
	}

	it("claims a failed child's return with its last committed request", async () => {
		const { host, state } = failingChildHost({ commitBeforeFailure: true });
		const { session: root } = createSession({ subagentRuntimeHost: host });

		await root.prompt("parent turn");
		await root.runRlmChild("doomed child");
		await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status !== "running");

		const child = state.child;
		if (!child) throw new Error("Missing child session");
		const childCommitted = child.semanticEdges.lastCommittedRequestId;
		expect(childCommitted).toBeDefined();
		expect(ledgerFor(root).filter((event) => event.type === "child_returned")).toEqual([
			{
				type: "child_returned",
				session_id: root.sessionId,
				child_session_id: child.sessionId,
				request_id: childCommitted,
			},
		]);

		// The error outcome the parent consumes links the child's last commit forward.
		await root.prompt("after the failure");
		const edges = deriveSemanticEdges([ledgerFor(root)]).edges;
		const returns = edges.filter((edge) => edge.type === "subagent_return");
		expect(returns).toHaveLength(1);
		expect(returns[0]?.source_request_id).toBe(childCommitted);
	});

	it("never claims a return for a failed child with no committed request", async () => {
		const { host, state } = failingChildHost({ commitBeforeFailure: false });
		const { session: root } = createSession({ subagentRuntimeHost: host });

		await root.prompt("parent turn");
		await root.runRlmChild("doomed child");
		await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status !== "running");

		expect(state.child).toBeDefined();
		expect(ledgerFor(root).filter((event) => event.type === "child_returned")).toEqual([]);
		const edges = deriveSemanticEdges([ledgerFor(root)]).edges;
		expect(edges.filter((edge) => edge.type === "subagent_return")).toEqual([]);
	});

	it("never claims a return for a cancelled child run", async () => {
		let childStarted = false;
		const { session: root } = createSession({
			hangMarker: "hang-task",
			onChildCallStarted: () => {
				childStarted = true;
			},
		});

		await root.prompt("parent turn");
		const spawned = await root.runRlmChild("hang-task");
		await waitForAsync(async () => childStarted);
		expect(root.cancelRlmChildRun(basename(spawned.session_dir))).toBe(true);
		await waitForAsync(async () => {
			const entry = (await root.listRlmSubagents()).subagents[0];
			return entry === undefined || entry.status !== "running";
		});

		expect(ledgerFor(root).filter((event) => event.type === "child_returned")).toEqual([]);
	});

	it("never claims a return for a cancelled child even with committed work", async () => {
		let releaseRun: ((error: Error) => void) | undefined;
		const state: { child?: AgentSession } = {};
		const host: SubagentRuntimeHost = {
			createRlmSubagentRuntime: async (hostOptions) => {
				const childManager = SessionManager.create(tempDir, hostOptions.sessionDir);
				const created = createSession({
					sessionManager: childManager,
					rlmSessionDir: hostOptions.sessionDir,
				}).session;
				await created.prompt("child work before the cancellation");
				vi.spyOn(created, "promptAndWait").mockImplementation(
					() =>
						new Promise((_resolve, reject) => {
							releaseRun = reject;
						}),
				);
				state.child = created;
				hostOptions.onSessionPublished?.(created);
				return { session: created };
			},
			deleteRlmSubagentRuntime: async (_childId, runtime) => {
				if (runtime && "session" in runtime) await runtime.session.disposeAsync();
			},
		};
		const { session: root } = createSession({ subagentRuntimeHost: host });

		await root.prompt("parent turn");
		const spawned = await root.runRlmChild("cancel me later");
		await waitForAsync(async () => releaseRun !== undefined);
		expect(state.child?.semanticEdges.lastCommittedRequestId).toBeDefined();
		expect(root.cancelRlmChildRun(basename(spawned.session_dir))).toBe(true);
		releaseRun?.(new Error("run torn down"));
		await waitForAsync(async () => {
			const entry = (await root.listRlmSubagents()).subagents[0];
			return entry === undefined || entry.status !== "running";
		});

		// Cancelled runs return nothing, even when the child had committed work.
		expect(ledgerFor(root).filter((event) => event.type === "child_returned")).toEqual([]);
	});

	async function createCompactionSession() {
		const extensionsResult = await createTestExtensionsResult(
			[
				(pi: any) => {
					pi.on("session_before_compact", async (event: any) => {
						if (event.customInstructions === "cancel-me") {
							return { cancel: true };
						}
						return {
							compaction: {
								summary: "summarized",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
			tempDir,
		);

		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: () => {
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message: assistantMessage("answer") });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ compaction: { keepRecentTokens: 1 } }),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		sessions.push(session);
		return { session, sessionManager };
	}

	it("records extension compactions without a summary request or compaction edge", async () => {
		const { session } = await createCompactionSession();

		await session.prompt("one");
		await session.prompt("two");

		await expect(session.compact("cancel-me")).rejects.toThrow("Compaction cancelled");
		let events = ledgerFor(session);
		expect(events.filter((event) => event.type === "compaction_begun")).toHaveLength(1);
		expect(events.at(-1)).toMatchObject({ type: "compaction_finished", status: "cancelled" });

		await session.compact();
		events = ledgerFor(session);
		expect(events.filter((event) => event.type === "compaction_finished").at(-1)).toMatchObject({
			status: "completed",
		});
		// Extension-supplied summaries make no wire request.
		expect(startedRequestIds(events)).toHaveLength(2);

		// The chain continues across the compaction; there is no compaction edge without a summary request.
		await session.prompt("three");
		const requestIds = startedRequestIds(ledgerFor(session));
		const edges = deriveSemanticEdges([ledgerFor(session)]).edges;
		expect(edges).toEqual([
			{ source_request_id: requestIds[0], target_request_id: requestIds[1], type: "continuation" },
			{ source_request_id: requestIds[1], target_request_id: requestIds[2], type: "continuation" },
		]);
	});

	it("commits the completed-compaction ledger event before the transcript entry", async () => {
		const { session, sessionManager } = await createCompactionSession();
		await session.prompt("one");
		await session.prompt("two");

		const original = sessionManager.appendCompaction.bind(sessionManager);
		let finishedAtCommit: SemanticEdgeLedgerEvent[] = [];
		vi.spyOn(sessionManager, "appendCompaction").mockImplementation(((
			...args: Parameters<SessionManager["appendCompaction"]>
		) => {
			finishedAtCommit = ledgerFor(session).filter((event) => event.type === "compaction_finished");
			return original(...args);
		}) as SessionManager["appendCompaction"]);

		await session.compact();

		expect(finishedAtCommit).toEqual([expect.objectContaining({ status: "completed" })]);
	});

	it("does not double-finish the compaction when the transcript commit fails", async () => {
		const { session, sessionManager } = await createCompactionSession();
		await session.prompt("one");
		await session.prompt("two");

		vi.spyOn(sessionManager, "appendCompaction").mockImplementationOnce(() => {
			throw new Error("append failed");
		});

		await expect(session.compact()).rejects.toThrow("append failed");

		const finished = ledgerFor(session).filter((event) => event.type === "compaction_finished");
		expect(finished).toEqual([expect.objectContaining({ status: "completed" })]);
	});

	it("keeps prompting and settling children when the session ledger becomes unwritable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { session: root, capturedHeaders } = createSession();
			await root.prompt("first");
			expect(capturedHeaders[0]?.[MODEL_REQUEST_ID_HEADER]).toBeDefined();

			const artifactDir = root.sessionManager.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing session artifact dir");
			const ledgerPath = join(artifactDir, SEMANTIC_EDGES_LEDGER_FILENAME);
			rmSync(ledgerPath);
			mkdirSync(ledgerPath);

			// Prompts keep working, without request IDs on the wire.
			await root.prompt("second");
			expect(capturedHeaders[1]?.[MODEL_REQUEST_ID_HEADER]).toBeUndefined();
			expect(warn).toHaveBeenCalledOnce();

			// Child runs still settle normally; the parent's return claim is a no-op.
			await root.runRlmChild("child task");
			await waitForAsync(async () => (await root.listRlmSubagents()).subagents[0]?.status === "completed");
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it("still compacts when the session ledger becomes unwritable", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const { session, sessionManager } = await createCompactionSession();
			await session.prompt("one");
			await session.prompt("two");

			const artifactDir = sessionManager.getSessionArtifactDir();
			if (!artifactDir) throw new Error("Missing session artifact dir");
			const ledgerPath = join(artifactDir, SEMANTIC_EDGES_LEDGER_FILENAME);
			rmSync(ledgerPath);
			mkdirSync(ledgerPath);

			const result = await session.compact();
			expect(result.summary).toBe("summarized");
			expect(sessionManager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
			expect(warn).toHaveBeenCalledOnce();
		} finally {
			warn.mockRestore();
		}
	});

	it("propagates the original error when the completed-compaction ledger write fails", async () => {
		const { session } = await createCompactionSession();
		await session.prompt("one");
		await session.prompt("two");

		const finishCompaction = vi.spyOn(session.semanticEdges, "finishCompaction").mockImplementation(() => {
			throw new Error("ledger write failed");
		});

		await expect(session.compact()).rejects.toThrow("ledger write failed");

		// The consumed ID is never finished a second time, so nothing masks the I/O error.
		expect(finishCompaction).toHaveBeenCalledOnce();
		expect(finishCompaction).toHaveBeenCalledWith(expect.any(String), "completed");
		expect(ledgerFor(session).filter((event) => event.type === "compaction_finished")).toEqual([]);
	});

	it("fails the summary requests when compaction is aborted mid-summary", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const ledgerPath = join(harness.sessionManager.getSessionArtifactDir() ?? "", SEMANTIC_EDGES_LEDGER_FILENAME);

		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const preCompactionIds = startedRequestIds(readSemanticEdgeLedger(ledgerPath));

		const abortingStep = () => {
			harness.session.abortCompaction();
			return fauxAssistantMessage("partial summary");
		};
		harness.setResponses([abortingStep, abortingStep]);
		await expect(harness.session.compact()).rejects.toThrow("Compaction cancelled");

		// Aborted summaries may be partial: they must never commit into the chain.
		const events = readSemanticEdgeLedger(ledgerPath);
		const summaryIds = startedRequestIds(events).filter((requestId) => !preCompactionIds.includes(requestId));
		expect(summaryIds.length).toBeGreaterThanOrEqual(1);
		const finished = events
			.filter((event) => event.type === "request_finished")
			.map((event) => (event.type === "request_finished" ? event.request_id : ""));
		for (const summaryId of summaryIds) {
			expect(finished).not.toContain(summaryId);
		}
		expect(events.filter((event) => event.type === "compaction_finished").at(-1)).toMatchObject({
			status: "cancelled",
		});

		// The next turn continues from the PRE-compaction request.
		harness.setResponses([fauxAssistantMessage("after")]);
		await harness.session.prompt("after");
		const finalEvents = readSemanticEdgeLedger(ledgerPath);
		const afterId = startedRequestIds(finalEvents).at(-1);
		const inboundEdges = deriveSemanticEdges([finalEvents]).edges.filter(
			(edge) => edge.target_request_id === afterId,
		);
		expect(inboundEdges).toEqual([
			{ source_request_id: preCompactionIds.at(-1), target_request_id: afterId, type: "continuation" },
		]);
	});

	it("commits no summary slice when a racing split-turn sibling fails", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const ledgerPath = join(harness.sessionManager.getSessionArtifactDir() ?? "", SEMANTIC_EDGES_LEDGER_FILENAME);

		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const preCompactionIds = startedRequestIds(readSemanticEdgeLedger(ledgerPath));

		// One slice succeeds on the wire well before its sibling rejects the whole compaction.
		const successStep = () => fauxAssistantMessage("the summary");
		const failingStep = async () => {
			await sleep(25);
			return fauxAssistantMessage("nope", { stopReason: "error", errorMessage: "summary slice failed" });
		};
		harness.setResponses([successStep, failingStep]);
		await expect(harness.session.compact()).rejects.toThrow(/failed/);

		// A failed compaction leaves NO committed summary request for edges to attach to.
		const events = readSemanticEdgeLedger(ledgerPath);
		const summaryIds = startedRequestIds(events).filter((requestId) => !preCompactionIds.includes(requestId));
		expect(summaryIds).toHaveLength(2);
		const finished = events
			.filter((event) => event.type === "request_finished")
			.map((event) => (event.type === "request_finished" ? event.request_id : ""));
		for (const summaryId of summaryIds) {
			expect(finished).not.toContain(summaryId);
		}
		expect(events.filter((event) => event.type === "compaction_finished").at(-1)).toMatchObject({
			status: "failed",
		});

		// The next turn continues from the pre-compaction request, not the phantom slice.
		harness.setResponses([fauxAssistantMessage("after")]);
		await harness.session.prompt("after");
		const finalEvents = readSemanticEdgeLedger(ledgerPath);
		const afterId = startedRequestIds(finalEvents).at(-1);
		expect(deriveSemanticEdges([finalEvents]).edges.filter((edge) => edge.target_request_id === afterId)).toEqual([
			{ source_request_id: preCompactionIds.at(-1), target_request_id: afterId, type: "continuation" },
		]);
	});

	it("settles a slice that resolves after a sibling already failed the compaction", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const ledgerPath = join(harness.sessionManager.getSessionArtifactDir() ?? "", SEMANTIC_EDGES_LEDGER_FILENAME);

		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");
		const preCompactionIds = startedRequestIds(readSemanticEdgeLedger(ledgerPath));

		// The first slice rejects immediately; its sibling resolves only after the
		// compaction has already settled as failed and drained the slice list.
		const failingStep = () => fauxAssistantMessage("nope", { stopReason: "error", errorMessage: "slice failed" });
		const lateSuccessStep = async () => {
			await sleep(25);
			return fauxAssistantMessage("late summary");
		};
		harness.setResponses([failingStep, lateSuccessStep]);
		await expect(harness.session.compact()).rejects.toThrow(/failed/);

		// Every summary slice settles; a late success must not stay in-flight forever.
		await waitForAsync(async () => {
			const events = readSemanticEdgeLedger(ledgerPath);
			const summaryIds = startedRequestIds(events).filter((requestId) => !preCompactionIds.includes(requestId));
			const terminal = new Set(
				events
					.filter((event) => event.type === "request_failed" || event.type === "request_finished")
					.map((event) =>
						event.type === "request_failed" || event.type === "request_finished" ? event.request_id : "",
					),
			);
			return summaryIds.length === 2 && summaryIds.every((requestId) => terminal.has(requestId));
		});
		const events = readSemanticEdgeLedger(ledgerPath);
		const summaryIds = startedRequestIds(events).filter((requestId) => !preCompactionIds.includes(requestId));
		const finished = events
			.filter((event) => event.type === "request_finished")
			.map((event) => (event.type === "request_finished" ? event.request_id : ""));
		for (const requestId of summaryIds) {
			expect(finished).not.toContain(requestId);
		}
	});

	it("mints a distinct request identity for each split-turn summary call", async () => {
		const harness = await createHarness({
			persistSession: true,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		harnesses.push(harness);
		const fauxModel = harness.getModel();
		harness.session.modelRegistry.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: harness.faux.api,
			headers: { "x-semantic-sentinel": "keep-me" },
			models: harness.faux.models.map((registeredModel) => ({
				id: registeredModel.id,
				name: registeredModel.name,
				api: registeredModel.api,
				reasoning: registeredModel.reasoning,
				input: registeredModel.input,
				cost: registeredModel.cost,
				contextWindow: registeredModel.contextWindow,
				maxTokens: registeredModel.maxTokens,
				baseUrl: registeredModel.baseUrl,
			})),
		});
		const ledgerPath = join(harness.sessionManager.getSessionArtifactDir() ?? "", SEMANTIC_EDGES_LEDGER_FILENAME);

		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const captured: Array<Record<string, string> | undefined> = [];
		const ledgerAtCall: SemanticEdgeLedgerEvent[][] = [];
		const summaryStep = (_context: unknown, streamOptions: { headers?: Record<string, string> } | undefined) => {
			captured.push(streamOptions?.headers);
			ledgerAtCall.push(readSemanticEdgeLedger(ledgerPath));
			return fauxAssistantMessage("the summary");
		};
		// A split-turn compaction makes two summary calls with DIFFERENT bodies:
		// one shared Idempotency-Key would be rejected (or replayed) downstream.
		harness.setResponses([summaryStep, summaryStep]);
		await harness.session.compact();

		expect(captured).toHaveLength(2);
		const wireIds = captured.map((headers) => headers?.[MODEL_REQUEST_ID_HEADER]);
		expect(wireIds[0]).toMatch(/^[0-9a-f]{32}$/);
		expect(wireIds[1]).toMatch(/^[0-9a-f]{32}$/);
		expect(wireIds[0]).not.toBe(wireIds[1]);
		for (const [index, headers] of captured.entries()) {
			expect(headers?.["x-semantic-sentinel"]).toBe("keep-me");
			expect(headers?.[IDEMPOTENCY_KEY_HEADER]).toBe(wireIds[index]);
			// Each request event was durable before its own provider call went out.
			expect(ledgerAtCall[index]).toContainEqual(
				expect.objectContaining({ type: "request_started", request_id: wireIds[index] }),
			);
		}

		// Exactly one compaction edge, sourced at the last-committed summary slice.
		harness.setResponses([fauxAssistantMessage("after")]);
		await harness.session.prompt("after");
		const events = readSemanticEdgeLedger(ledgerPath);
		const committedSlices = events
			.filter((event) => event.type === "request_finished")
			.map((event) => (event.type === "request_finished" ? event.request_id : ""))
			.filter((requestId) => wireIds.includes(requestId));
		expect(committedSlices).toHaveLength(2);
		const edges = deriveSemanticEdges([events]).edges;
		const afterId = startedRequestIds(events).at(-1);
		const compactionEdges = edges.filter((edge) => edge.type === "compaction");
		expect(compactionEdges).toEqual([
			{ source_request_id: committedSlices[1], target_request_id: afterId, type: "compaction" },
		]);
		// The continuation from that slice is suppressed in favor of the compaction edge.
		expect(edges.filter((edge) => edge.target_request_id === afterId)).toHaveLength(1);
	});
});
