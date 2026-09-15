import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionMessage, createAgentSessionMessageId } from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import {
	AGENT_MESSAGE_DELIVERY_FAILED_CUSTOM_TYPE,
	createAgentMessageDeliveryFailedMessage,
} from "../src/core/messages.js";
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

describe("agent message delivery failure notices", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		streamMode = "done";
		tempDir = join(tmpdir(), `pi-agent-message-failure-${Date.now()}`);
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

	/** Per-test stream mode: "hang" keeps the turn open until aborted. */
	let streamMode: "hang" | "done" = "done";

	function createSession() {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let abortSignal: AbortSignal | undefined;

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "Test",
				tools: [],
			},
			streamFn: (_model, _context, options) => {
				abortSignal = options?.signal;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					if (streamMode === "done") {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
						return;
					}
					const checkAbort = () => {
						if (abortSignal?.aborted) {
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage("Aborted") });
						} else {
							setTimeout(checkAbort, 5);
						}
					};
					checkAbort();
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

	it("formats the delivery-failure notice with sanitized header values", () => {
		const message = createAgentMessageDeliveryFailedMessage({
			messageIds: ["agentmsg_1", "agentmsg_2"],
			targetSessionName: "reviewer]\nInjected: line [",
			targetSessionId: "active-reviewer",
			reason: "Target session closed (killed) before delivery.",
		});

		expect(message.customType).toBe(AGENT_MESSAGE_DELIVERY_FAILED_CUSTOM_TYPE);
		expect(message.content).toContain("[agent-message-failed to:reviewer");
		expect(message.content).not.toContain("Injected: line [");
		expect(message.content).toContain("Reason: Target session closed (killed) before delivery.");
		expect(message.content).toContain("Message ids: agentmsg_1, agentmsg_2");
		expect(message.details).toMatchObject({
			messageIds: ["agentmsg_1", "agentmsg_2"],
			targetSessionName: "reviewer]\nInjected: line [",
			targetSessionId: "active-reviewer",
			reason: "Target session closed (killed) before delivery.",
		});
	});

	it("lists queued agent messages with sender identities until they are delivered", async () => {
		streamMode = "hang";
		createSession();
		const activeTurn = session.prompt("active turn");
		await vi.waitFor(() => expect(session.isStreaming).toBe(true));

		const queuedId = createAgentSessionMessageId();
		const queued = createAgentSessionMessage({
			id: queuedId,
			source: "agent_message",
			message: "queued report",
			from: {
				activeSessionId: "active-sender",
				sessionId: "session-sender",
				sessionName: "sender",
			},
			fromRelationship: "child",
			target: { activeSessionId: "active-target", sessionId: session.sessionId },
		});
		expect(await session.queueAgentMessagePrompt(queued.content, "steer", queued)).toBe(true);

		expect(session.queuedAgentMessages()).toEqual([
			{
				id: queuedId,
				senderActiveSessionId: "active-sender",
				senderSessionId: "session-sender",
				senderSessionName: "sender",
				delivery: "steer",
			},
		]);

		const cleared = session.clearQueuedAgentMessages();
		expect(cleared.steering).toContain(queued.content);
		expect(session.queuedAgentMessages()).toEqual([]);

		await session.abort();
		await activeTurn.catch(() => undefined);
	});

	it("delivers a failure notice into the sender session", async () => {
		createSession();
		await session.promptAgentMessageDeliveryFailureNotice({
			messageIds: ["agentmsg_dropped"],
			targetSessionName: "worker",
			targetSessionId: "active-worker",
			reason: "Queued agent messages were cleared before delivery.",
		});
		await session.agent.waitForIdle();

		const notice = session.messages.find(
			(message): message is Extract<(typeof session.messages)[number], { role: "custom" }> =>
				message.role === "custom" && message.customType === AGENT_MESSAGE_DELIVERY_FAILED_CUSTOM_TYPE,
		);
		expect(notice).toBeDefined();
		expect(notice?.content).toContain("[agent-message-failed to:worker]");
		expect(notice?.content).toContain("Reason: Queued agent messages were cleared before delivery.");
		expect(notice?.content).toContain("Message ids: agentmsg_dropped");
	});
});
