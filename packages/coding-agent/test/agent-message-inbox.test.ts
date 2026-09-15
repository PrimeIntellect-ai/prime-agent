import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE,
	AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE,
	AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE,
	AgentMessageInbox,
} from "../src/core/agent-message-inbox.js";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	AGENT_MESSAGE_SOURCE,
	createAgentSessionMessage,
	createAgentSessionMessageId,
} from "../src/core/agent-messages.js";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { HostRequestHandlers } from "../src/core/kernel/index.js";
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

describe("agent message inbox", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-inbox-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("appends, lists, reads, and replays read state from durable entries", () => {
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const inbox = new AgentMessageInbox(sessionManager);
		const message = createAgentSessionMessage({
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message: "REPORT 481",
			from: { activeSessionId: "child-active", sessionName: "child-1" },
			fromRelationship: "child",
			target: { activeSessionId: "parent-active", sessionId: "parent-session", sessionName: "parent" },
		});

		inbox.append(message);
		expect(inbox.unreadCount()).toBe(1);
		expect(inbox.list()[0]).toMatchObject({
			from: { activeSessionId: "child-active", sessionName: "child-1" },
			fromRelationship: "child",
			read: false,
			preview: "REPORT 481",
		});

		const { entries, unread } = inbox.read();
		expect(entries[0]?.content).toBe("REPORT 481");
		expect(unread).toBe(0);
		expect(inbox.list()[0]?.read).toBe(true);

		// Replay: a fresh inbox over the same durable store keeps entries and read state.
		const reloaded = new AgentMessageInbox(sessionManager);
		expect(reloaded.totalCount()).toBe(1);
		expect(reloaded.unreadCount()).toBe(0);
		const types = sessionManager
			.getEntries()
			.map((entry) => (entry.type === "custom" ? entry.customType : entry.type));
		expect(types).toContain(AGENT_MESSAGE_INBOX_ENTRY_CUSTOM_TYPE);
		expect(types).toContain(AGENT_MESSAGE_INBOX_READ_ENTRY_CUSTOM_TYPE);
	});

	it("reads only the requested ids and ignores unknown ones", () => {
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const inbox = new AgentMessageInbox(sessionManager);
		for (const body of ["one", "two"]) {
			inbox.append(
				createAgentSessionMessage({
					id: createAgentSessionMessageId(),
					source: AGENT_MESSAGE_SOURCE,
					message: body,
					from: { activeSessionId: "sender" },
					fromRelationship: "sibling",
					target: { activeSessionId: "target", sessionId: "target" },
				}),
			);
		}
		const { entries, unread } = inbox.read([inbox.list()[0]?.id as string]);
		expect(entries).toHaveLength(1);
		expect(unread).toBe(1);
		expect(inbox.read(["not-an-id"]).entries).toHaveLength(0);
	});
});

describe("agent message digest lane", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-agent-digest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession(agentMessageDigest: boolean): AgentSession {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: createAssistantMessage("") });
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("Done") });
				});
				return stream;
			},
		});
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
			agentMessageDigest,
		});
		return session;
	}

	function childMessage(body: string, relationship: "child" | "parent" = "child") {
		return createAgentSessionMessage({
			id: createAgentSessionMessageId(),
			source: AGENT_MESSAGE_SOURCE,
			message: body,
			from: { activeSessionId: "sender-active", sessionName: "sender" },
			fromRelationship: relationship,
			target: { activeSessionId: "target", sessionId: session.sessionId },
		});
	}

	function kernelHandlers(): HostRequestHandlers {
		return (session as unknown as { _createKernelHostHandlers(): HostRequestHandlers })._createKernelHostHandlers();
	}

	it("digests child messages, wakes once per batch, and exposes them via rlm.inbox", async () => {
		createSession(true);
		const first = childMessage("REPORT 481");
		await session.acceptAgentMessagePrompt(first.content, { customMessage: first });
		await session.waitForSessionInputIdle();
		await session.agent.waitForIdle();

		// The payload itself never prompted; the digest notice drove the only turn.
		const customTypes = session.agent.state.messages.map((m) => ("customType" in m ? m.customType : undefined));
		expect(customTypes).toContain(AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE);
		expect(customTypes).not.toContain(AGENT_MESSAGE_CUSTOM_TYPE);
		expect(session.messagingStats().arrivals.total).toBe(1);
		expect(session.messagingStats().inbox).toEqual({ unread: 1, total: 1 });

		const handlers = kernelHandlers();
		const listing = (await handlers["rlm.inbox.list"]!({})) as { entries: { content: string }[]; unread: number };
		expect(listing.unread).toBe(1);
		expect(listing.entries[0]?.content).toBe("REPORT 481");

		const read = (await handlers["rlm.inbox.read"]!({})) as { entries: { content: string }[]; unread: number };
		expect(read.entries[0]?.content).toBe("REPORT 481");
		expect(read.unread).toBe(0);
		expect(session.messagingStats().inbox).toEqual({ unread: 0, total: 1 });
	});

	it("cancels a pending digest notice when the inbox is read before delivery", async () => {
		const target = createSession(true);
		const internal = target as unknown as {
			_sessionInputPumpSuspended: boolean;
			_digestNoticeActionIds: Set<string>;
		};
		internal._sessionInputPumpSuspended = true;

		const message = childMessage("REPORT 777");
		await session.acceptAgentMessagePrompt(message.content, { customMessage: message });
		expect(internal._digestNoticeActionIds.size).toBe(1);
		const messageCountBeforeRead = session.agent.state.messages.length;

		const handlers = kernelHandlers();
		await handlers["rlm.inbox.read"]!({});
		expect(internal._digestNoticeActionIds.size).toBe(0);

		internal._sessionInputPumpSuspended = false;
		await session.agent.waitForIdle();
		expect(session.agent.state.messages.length).toBe(messageCountBeforeRead);
	});

	it("keeps parent-to-child instructions on the push lane even in digest mode", async () => {
		createSession(true);
		const parent = childMessage("instruction from parent", "parent");
		await session.acceptAgentMessagePrompt(parent.content, { customMessage: parent });
		await session.agent.waitForIdle();

		const customTypes = session.agent.state.messages.map((m) => ("customType" in m ? m.customType : undefined));
		expect(customTypes).toContain(AGENT_MESSAGE_CUSTOM_TYPE);
		expect(customTypes).not.toContain(AGENT_MESSAGE_DIGEST_NOTICE_CUSTOM_TYPE);
		expect(session.messagingStats().inbox.total).toBe(0);
	});

	it("delivers agent messages on the push lane by default and can switch at runtime", async () => {
		const target = createSession(false);
		expect(target.agentMessageDigestMode).toBe(false);

		const pushed = childMessage("pushed");
		await session.acceptAgentMessagePrompt(pushed.content, { customMessage: pushed });
		await session.agent.waitForIdle();
		expect(session.messagingStats().inbox.total).toBe(0);

		target.setAgentMessageDigestMode(true);
		const digested = childMessage("digested");
		await session.acceptAgentMessagePrompt(digested.content, { customMessage: digested });
		await session.agent.waitForIdle();
		expect(session.messagingStats().inbox).toEqual({ unread: 1, total: 1 });
	});
});
