import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { HostRequestHandlers } from "../src/core/kernel/index.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ActiveSessionState } from "../src/modes/daemon/active-session-state.js";
import { AgentDaemon } from "../src/modes/daemon/daemon-mode.js";
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

function statsSnapshot(overrides: Record<string, unknown> = {}) {
	return {
		arrivals: { total: 6, last5m: 6 },
		model_steps: { total: 10, last5m: 10, tokens: 10_000 },
		ingestion_steps: { total: 1, last5m: 1, tokens: 1_000 },
		context: { estimated_agent_message_tokens: 100, context_tokens: 1_000, share: 0.1 },
		sends: { attempts: 0, failures: 0 },
		inbox: { unread: 0, total: 0 },
		...overrides,
	};
}

describe("session digest pin", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-digest-pin-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const usage: Usage = {
			input: 700,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 800,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					const message: AssistantMessage = {
						role: "assistant",
						content: [{ type: "text", text: "Done" }],
						api: "anthropic-messages",
						provider: "anthropic",
						model: "mock",
						usage,
						stopReason: "stop",
						timestamp: Date.now(),
					};
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: "stop", message });
				});
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(
				AuthStorage.create(join(tempDir, "auth.json")),
				join(tempDir, "models.json"),
			),
			resourceLoader: createTestResourceLoader(),
		});
		return session;
	}

	it("pins push or digest and returns control with auto, via the host handler", async () => {
		const target = createSession();
		expect(target.agentMessageDigestPin).toBe("auto");
		const handlers = (
			target as unknown as { _createKernelHostHandlers(): HostRequestHandlers }
		)._createKernelHostHandlers();

		await expect(handlers["rlm.inbox.configure"]!({ mode: "sideways" })).rejects.toThrow(/must be/);

		const pinned = (await handlers["rlm.inbox.configure"]!({ mode: "digest" })) as {
			mode: string;
			pinned: boolean;
			digest: boolean;
		};
		expect(pinned).toEqual({ mode: "digest", pinned: true, digest: true });
		expect(target.agentMessageDigestMode).toBe(true);

		await handlers["rlm.inbox.configure"]!({ mode: "push" });
		expect(target.agentMessageDigestMode).toBe(false);

		const auto = (await handlers["rlm.inbox.configure"]!({ mode: "auto" })) as { pinned: boolean };
		expect(target.agentMessageDigestPin).toBe("auto");
		expect(auto.pinned).toBe(false);
	});
});

describe("daemon digest lane decision", () => {
	it("flips the target to digest when counters cross a trigger and the message digests", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-digest-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const setAgentMessageDigestMode = vi.fn((enabled: boolean) => {
			fakeSession.agentMessageDigestMode = enabled;
		});
		const fakeSession = {
			sessionId: "session-target",
			sessionName: "Target",
			agentMessageDigestPin: "auto" as const,
			agentMessageDigestMode: false,
			setAgentMessageDigestMode,
			messagingStats: vi.fn(() => statsSnapshot()),
			acceptAgentMessagePrompt: vi.fn(
				async (_text: string, options?: { preflightResult?: (s: boolean, q?: boolean, d?: boolean) => void }) => {
					options?.preflightResult?.(true, false, fakeSession.agentMessageDigestMode ? true : false);
				},
			),
		};
		const targetState = {
			activeSessionId: "target-active",
			clients: new Set(),
			pendingAttaches: 0,
			lastEventSequence: 0,
			runtime: { metadata: { kind: "subagent", createdAt: 1 }, session: fakeSession },
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			agentMessageDigestControllers: Map<string, unknown>;
			acceptAgentSessionMessage(
				targetState: ActiveSessionState,
				payload: unknown,
			): Promise<{
				status: string;
			}>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const receipt = await internals.acceptAgentSessionMessage(targetState, {
			id: "msg-1",
			source: "agent_message",
			message: "hello",
			from: { activeSessionId: "sender-active", sessionName: "sender" },
			fromRelationship: "child",
			target: { activeSessionId: "target-active", sessionId: "session-target" },
		});

		expect(setAgentMessageDigestMode).toHaveBeenCalledWith(true);
		expect(fakeSession.agentMessageDigestMode).toBe(true);
		expect(receipt.status).toBe("digest");
		expect(fakeSession.acceptAgentMessagePrompt).toHaveBeenCalledOnce();
	});

	it("never flips a session the user pinned", async () => {
		const daemon = new AgentDaemon("/tmp/prime-agent-digest-pin-test.sock", {
			defaultSessionConfig: { agentDir: "/tmp", cwd: "/tmp" },
			createRuntime: vi.fn(),
		});
		const setAgentMessageDigestMode = vi.fn();
		const fakeSession = {
			sessionId: "session-pinned",
			sessionName: "Pinned",
			agentMessageDigestPin: "push" as const,
			agentMessageDigestMode: false,
			setAgentMessageDigestMode,
			messagingStats: vi.fn(() => statsSnapshot()),
			acceptAgentMessagePrompt: vi.fn(async () => {}),
		};
		const targetState = {
			activeSessionId: "pinned-active",
			clients: new Set(),
			pendingAttaches: 0,
			lastEventSequence: 0,
			runtime: { metadata: { kind: "subagent", createdAt: 1 }, session: fakeSession },
		} as unknown as ActiveSessionState;
		const internals = daemon as unknown as {
			sessions: Map<string, ActiveSessionState>;
			acceptAgentSessionMessage(
				targetState: ActiveSessionState,
				payload: unknown,
			): Promise<{
				status: string;
			}>;
		};
		internals.sessions.set(targetState.activeSessionId, targetState);

		const receipt = await internals.acceptAgentSessionMessage(targetState, {
			id: "msg-2",
			source: "agent_message",
			message: "hello",
			from: { activeSessionId: "sender-active", sessionName: "sender" },
			fromRelationship: "child",
			target: { activeSessionId: "pinned-active", sessionId: "session-pinned" },
		});

		expect(setAgentMessageDigestMode).not.toHaveBeenCalled();
		expect(receipt.status).toBe("delivered");
	});
});
