import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { mergeAgentSessionRuntimeConfig } from "../src/core/agent-session-config.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.js";
import { createTestResourceLoader } from "./utilities.js";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	takeOverStdout: vi.fn(),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	harnessMode?: "rpc-only";
}): {
	runtimeHost: AgentSessionRuntime;
	session: AgentSession;
	cleanup: () => Promise<void>;
} {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);
	if (options.withAuth) {
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader: createTestResourceLoader(),
		harnessMode: options.harnessMode,
		rlmMaxDepthCeiling: options.harnessMode === "rpc-only" ? 0 : undefined,
		actEnabled: options.harnessMode !== "rpc-only",
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		session,
		cleanup: async () => {
			try {
				if (session.isStreaming) {
					await session.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	harnessMode?: "rpc-only";
}): Promise<{
	lineHandler: (line: string) => void;
	session: AgentSession;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, session, cleanup } = createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, session, cleanup };
}

describe("RPC prompt response semantics", () => {
	it("merges launch ceilings monotonically", () => {
		expect(
			mergeAgentSessionRuntimeConfig(
				{ rlmMaxDepthCeiling: 0, disableRlmAct: true, harnessMode: "rpc-only" },
				{ rlmMaxDepthCeiling: 9, disableRlmAct: false },
			),
		).toMatchObject({ rlmMaxDepthCeiling: 0, disableRlmAct: true, harnessMode: "rpc-only" });
	});

	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("enforces the rpc-only harness boundary", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			harnessMode: "rpc-only",
		});

		try {
			await expect(session.promptHeartbeat({} as never)).rejects.toThrow("disabled in rpc-only");
			await expect(session.acceptAgentMessagePrompt("persisted peer input")).rejects.toThrow("disabled in rpc-only");
			await expect(session.queueAgentMessagePrompt("persisted queued input", "followUp")).rejects.toThrow(
				"disabled in rpc-only",
			);
			lineHandler(JSON.stringify({ id: "state", type: "get_state" }));
			lineHandler(JSON.stringify({ id: "tier", type: "set_service_tier", serviceTier: "default" }));
			for (const [id, type] of [
				["steer", "steer"],
				["goal", "follow_up"],
				["schedule", "add_schedule"],
				["heartbeat", "set_heartbeat"],
				["peer", "send_message"],
				["external", "get_commands"],
				["refine", "refine"],
			] as const) {
				lineHandler(JSON.stringify({ id, type, message: "bypass", schedule: "every 1m", prompt: "bypass" }));
			}
			lineHandler(JSON.stringify({ id: "literal", type: "prompt", message: "/goal bypass" }));

			await vi.waitFor(() => {
				const records = parseOutputLines(rpcIo.outputLines);
				expect(records).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: "state",
							success: true,
							data: expect.objectContaining({
								rpcProtocolVersion: 1,
								rpcSchemaRevision: 3,
								rlmMaxDepth: 0,
								actEnabled: false,
								retryEnabled: false,
								foregroundMode: "rpc_only",
							}),
						}),
						expect.objectContaining({ id: "tier", success: true }),
						expect.objectContaining({ id: "literal", success: true }),
					]),
				);
				for (const id of ["steer", "goal", "schedule", "heartbeat", "peer", "external", "refine"]) {
					expect(records).toEqual(
						expect.arrayContaining([
							expect.objectContaining({ id, success: false, error: expect.stringContaining("disabled") }),
						]),
					);
				}
			});
			await vi.waitFor(() =>
				expect(
					session.messages.some(
						(message) =>
							message.role === "user" &&
							Array.isArray(message.content) &&
							message.content.some((part) => part.type === "text" && part.text === "/goal bypass"),
					),
				).toBe(true),
			);
		} finally {
			await cleanup();
		}
	});
	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 250 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
				});
			});
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_start")).toBe(true);
			});
			expect(session.isStreaming).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("fences the aborted operation while preserving queued follow-up input", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 250 });

		try {
			lineHandler(JSON.stringify({ id: "abort-prompt", type: "prompt", message: "Hello" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).some((record) => record.type === "agent_start")).toBe(true);
			});
			lineHandler(
				JSON.stringify({
					id: "abort-follow-up",
					type: "prompt",
					message: "Remain queued",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "abort-follow-up")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "abort", type: "abort" }));
			await vi.waitFor(() => {
				expect(
					parseOutputLines(rpcIo.outputLines).some(
						(record) => record.id === "abort" && record.type === "response" && record.command === "abort",
					),
				).toBe(true);
			});

			const records = parseOutputLines(rpcIo.outputLines);
			const abortResponseIndex = records.findIndex(
				(record) => record.id === "abort" && record.type === "response" && record.command === "abort",
			);
			const terminalEventIndex = records.findIndex((record) => record.type === "agent_end");
			expect(terminalEventIndex).toBeGreaterThanOrEqual(0);
			expect(terminalEventIndex).toBeLessThan(abortResponseIndex);
			expect(records.filter((record) => record.type === "agent_start")).toHaveLength(1);
			expect(session.getFollowUpMessages()).toEqual(["Remain queued"]);
			lineHandler(JSON.stringify({ id: "abort-state", type: "get_state" }));
			await vi.waitFor(() => {
				const state = parseOutputLines(rpcIo.outputLines).find(
					(record) => record.id === "abort-state" && record.type === "response" && record.command === "get_state",
				);
				expect(state).toMatchObject({ data: { isStreaming: false } });
			});
			expect(session.isStreaming).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("drains a new turn before EOF after an abort", async () => {
		const exitCodes: number[] = [];
		const exit = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
			exitCodes.push(typeof code === "number" ? code : 0);
			return undefined as never;
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 50,
			harnessMode: "rpc-only",
		});

		try {
			lineHandler(JSON.stringify({ id: "first", type: "prompt", message: "First" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(
					1,
				);
			});
			lineHandler(JSON.stringify({ id: "abort", type: "abort" }));
			await vi.waitFor(() => {
				expect(
					parseOutputLines(rpcIo.outputLines).some(
						(record) => record.id === "abort" && record.type === "response" && record.command === "abort",
					),
				).toBe(true);
			});
			lineHandler(JSON.stringify({ id: "second", type: "prompt", message: "Second" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "second")).toHaveLength(1);
				expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(
					2,
				);
			});

			const endListeners = process.stdin.listeners("end");
			const endListener = endListeners[endListeners.length - 1];
			if (!endListener) throw new Error("RPC mode did not register an EOF listener");
			endListener();

			await vi.waitFor(() => expect(exitCodes).toEqual([0]));
			const records = parseOutputLines(rpcIo.outputLines);
			const secondStart = records.reduce(
				(index, record, current) => (record.type === "agent_start" ? current : index),
				-1,
			);
			const finalEnd = records.reduce(
				(index, record, current) => (record.type === "agent_end" ? current : index),
				-1,
			);
			expect(finalEnd).toBeGreaterThan(secondStart);
		} finally {
			exit.mockRestore();
			await cleanup();
		}
	});

	it("acknowledges an abort with no active operation", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "idle-abort", type: "abort" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toEqual(
					expect.arrayContaining([expect.objectContaining({ id: "idle-abort", command: "abort", success: true })]),
				);
			});
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("preserves omitted global scope on RPC refine commands", async () => {
		const { lineHandler, session, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const refine = vi.spyOn(session, "refine").mockResolvedValue({
			id: "refine_rpc",
			summary: "RPC refinement",
			rationale: "Test refine scope default",
			expectedOutcome: "Preserve local default",
			appliedEdits: [],
			harnessStatePath: "/tmp/harness_state.json",
			scope: "local",
		});

		try {
			lineHandler(JSON.stringify({ id: "r1", type: "refine", instructions: "record local lesson" }));

			await vi.waitFor(() => {
				expect(refine).toHaveBeenCalledWith({
					instructions: "record local lesson",
					rollbackId: undefined,
					global: undefined,
				});
				expect(parseOutputLines(rpcIo.outputLines)).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							id: "r1",
							type: "response",
							command: "refine",
							success: true,
						}),
					]),
				);
			});
		} finally {
			await cleanup();
		}
	});
});
