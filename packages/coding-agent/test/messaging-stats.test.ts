import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_SOURCE,
	createAgentSessionMessage,
	createAgentSessionMessageId,
} from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { HostRequestHandlers } from "../src/core/kernel/index.js";
import { estimateMessagingTokens, MessagingStats } from "../src/core/messaging-stats.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

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
		model: "mock",
		usage: {
			input: 700,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("messaging stats counters", () => {
	it("counts arrivals, steps, and windows", () => {
		const stats = new MessagingStats({ windowMs: 1_000, maxEvents: 10 });
		const t0 = 1_000_000;
		stats.recordArrival(t0);
		stats.recordArrival(t0 + 500);
		stats.recordArrival(t0 + 6_000); // in the window at snapshot time
		stats.recordModelStep(800, true, t0);
		stats.recordModelStep(600, false, t0 + 600);
		stats.recordModelStep(400, false, t0 + 6_000); // in the window at snapshot time

		const snapshot = stats.snapshot({ contextTokens: 2_000, estimatedAgentMessageTokens: 200 }, t0 + 6_500);
		expect(snapshot.arrivals).toEqual({ total: 3, last5m: 1 });
		expect(snapshot.model_steps).toEqual({ total: 3, last5m: 1, tokens: 1_800 });
		expect(snapshot.ingestion_steps).toEqual({ total: 1, last5m: 0, tokens: 800 });
		expect(snapshot.context).toEqual({
			estimated_agent_message_tokens: 200,
			context_tokens: 2_000,
			share: 0.1,
		});
		expect(estimateMessagingTokens(801)).toBe(201);
	});

	it("reports a null share without context tokens and counts send outcomes", () => {
		const stats = new MessagingStats();
		stats.recordSendAttempt(false);
		stats.recordSendAttempt(true);
		expect(stats.snapshot({ contextTokens: undefined, estimatedAgentMessageTokens: 50 })).toMatchObject({
			context: { context_tokens: null, share: null },
			sends: { attempts: 2, failures: 1 },
		});
	});
});

describe("messaging stats session wiring", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-messaging-stats-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});

		return session;
	}

	function kernelHandlers(): HostRequestHandlers {
		return (session as unknown as { _createKernelHostHandlers(): HostRequestHandlers })._createKernelHostHandlers();
	}

	it("counts an agent-message arrival and its ingestion step, then a plain step separately", async () => {
		createSession();
		const agentMessage = createAgentSessionMessage({
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message: "reply body",
			from: { activeSessionId: "active-sender", sessionName: "sender" },
			fromRelationship: "child",
			target: { activeSessionId: "target", sessionId: session.sessionId },
		});

		await session.acceptAgentMessagePrompt(agentMessage.content, {
			expandPromptTemplates: false,
			customMessage: agentMessage,
		});
		await session.agent.waitForIdle();
		await session.prompt("plain user turn");
		await session.agent.waitForIdle();

		const snapshot = session.messagingStats();
		expect(snapshot.arrivals).toEqual({ total: 1, last5m: 1 });
		expect(snapshot.model_steps.total).toBe(2);
		expect(snapshot.ingestion_steps).toEqual({ total: 1, last5m: 1, tokens: 800 });
		expect(snapshot.model_steps.tokens).toBe(1_600);
		expect(snapshot.context.estimated_agent_message_tokens).toBe(
			estimateMessagingTokens(agentMessage.content.length),
		);
		expect(snapshot.context.context_tokens).toBe(800);
	});

	it("exposes the snapshot through the rlm.messaging_stats host handler", async () => {
		createSession();
		const handlers = kernelHandlers();
		await session.prompt("warm up");
		await session.agent.waitForIdle();

		const snapshot = (await handlers["rlm.messaging_stats"]!({})) as {
			model_steps: { total: number };
			context: { context_tokens: number | null };
		};
		expect(snapshot.model_steps.total).toBe(1);
		expect(snapshot.context.context_tokens).toBe(800);
	});
});
