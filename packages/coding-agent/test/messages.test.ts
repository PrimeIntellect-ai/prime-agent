import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Message, registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { addElapsedMessageTimes, convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const assistantFields = {
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-sonnet",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop" as const,
};

describe("addElapsedMessageTimes", () => {
	it("prefixes every message role while preserving content order and images", () => {
		const messages: Message[] = [
			{ role: "user", content: "first", timestamp: 1_000 },
			{
				role: "user",
				content: [
					{ type: "text", text: "before image" },
					{ type: "image", data: "image-data", mimeType: "image/png" },
				],
				timestamp: 2_500,
			},
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "signed reasoning" },
					{ type: "text", text: "answer" },
					{ type: "toolCall", id: "call-1", name: "ipython", arguments: {} },
				],
				...assistantFields,
				timestamp: 4_999,
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "ipython",
				content: [{ type: "image", data: "result-image", mimeType: "image/jpeg" }],
				isError: false,
				timestamp: 6_501,
			},
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "call-2", name: "ipython", arguments: { code: "1 + 1" } }],
				...assistantFields,
				timestamp: 7_000,
			},
		];

		const converted = addElapsedMessageTimes(messages, 1_000);

		expect(converted.map((message) => message.content)).toEqual([
			[
				{ type: "text", text: "[T+0s]" },
				{ type: "text", text: "first" },
			],
			[
				{ type: "text", text: "[T+1s]" },
				{ type: "text", text: "before image" },
				{ type: "image", data: "image-data", mimeType: "image/png" },
			],
			[
				{ type: "thinking", thinking: "signed reasoning" },
				{ type: "text", text: "[T+3s]" },
				{ type: "text", text: "answer" },
				{ type: "toolCall", id: "call-1", name: "ipython", arguments: {} },
			],
			[
				{ type: "text", text: "[T+5s]" },
				{ type: "image", data: "result-image", mimeType: "image/jpeg" },
			],
			[
				{ type: "text", text: "[T+6s]" },
				{ type: "toolCall", id: "call-2", name: "ipython", arguments: { code: "1 + 1" } },
			],
		]);
	});

	it("falls back to the earliest finite timestamp, floors seconds, and clamps early messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "later", timestamp: 5_000 },
			{ role: "user", content: "earliest", timestamp: 4_999 },
			{ role: "toolResult", toolCallId: "call", toolName: "tool", content: [], isError: false, timestamp: 6_123 },
		];

		expect(addElapsedMessageTimes(messages, Number.NaN).map((message) => message.content)).toEqual([
			[
				{ type: "text", text: "[T+0s]" },
				{ type: "text", text: "later" },
			],
			[
				{ type: "text", text: "[T+0s]" },
				{ type: "text", text: "earliest" },
			],
			[{ type: "text", text: "[T+1s]" }],
		]);
		expect(addElapsedMessageTimes([messages[0]], 6_000)[0]?.content).toEqual([
			{ type: "text", text: "[T+0s]" },
			{ type: "text", text: "later" },
		]);
	});

	it("uses a persisted filtered message as the SDK anchor before and after resume", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-sdk-message-time-"));
		let liveSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		let resumedSession: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const startedAt = 10_000;
			const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
			const hiddenMessageId = manager.appendMessage({
				role: "custom",
				customType: "hidden",
				content: "filtered",
				display: false,
				timestamp: startedAt,
			});
			const visibleTimestamp = startedAt + 2_345;
			manager.appendMessage({ role: "user", content: "visible", timestamp: visibleTimestamp });
			const assistantMessageId = manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				...assistantFields,
				timestamp: visibleTimestamp,
			});
			const authStorage = AuthStorage.inMemory();
			const faux = registerFauxProvider();
			const createSession = (sessionManager: SessionManager) =>
				createAgentSession({
					model: faux.getModel(),
					sessionManager,
					settingsManager: SettingsManager.inMemory(),
					resourceLoader: createTestResourceLoader(),
					authStorage,
					modelRegistry: ModelRegistry.inMemory(authStorage),
					noTools: "all",
				});

			liveSession = (await createSession(manager)).session;
			const liveConverted = await liveSession.agent.convertToLlm(manager.buildSessionContext().messages);
			const liveUser = liveConverted.find((message) => message.role === "user");
			expect(liveUser?.content).toEqual([
				{ type: "text", text: "[T+2s]" },
				{ type: "text", text: "visible" },
			]);

			const branchFile = manager.createBranchedSession(assistantMessageId)!;
			const resumedManager = SessionManager.open(branchFile);
			resumedSession = (await createSession(resumedManager)).session;
			const resumedConverted = await resumedSession.agent.convertToLlm(
				resumedManager.buildSessionContext().messages,
			);
			const resumedUser = resumedConverted.find((message) => message.role === "user");
			expect(resumedUser?.content).toEqual(liveUser?.content);

			resumedManager.appendCompaction("summary", hiddenMessageId, 2);
			expect(resumedManager.getConversationStartedAt()).toBe(startedAt);
		} finally {
			if (resumedSession) await resumedSession.disposeAsync();
			if (liveSession) await liveSession.disposeAsync();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps the first message timestamp across branch extraction and resume", () => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-message-time-"));
		try {
			const startedAt = 10_000;
			const manager = SessionManager.create("/tmp", sessionDir);
			const firstMessageId = manager.appendMessage({ role: "user", content: "first", timestamp: startedAt });
			const assistantMessageId = manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "answer" }],
				...assistantFields,
				timestamp: startedAt + 2_345,
			});
			expect(manager.getConversationStartedAt()).toBe(startedAt);

			const before = addElapsedMessageTimes(
				convertToLlm(manager.buildSessionContext().messages),
				manager.getConversationStartedAt()!,
			);
			const branchFile = manager.createBranchedSession(assistantMessageId);
			const resumed = SessionManager.open(branchFile!);
			expect(resumed.getConversationStartedAt()).toBe(startedAt);
			const after = addElapsedMessageTimes(
				convertToLlm(resumed.buildSessionContext().messages),
				resumed.getConversationStartedAt()!,
			);
			expect(after.map((message) => message.content)).toEqual(before.map((message) => message.content));

			resumed.appendCompaction("summary", firstMessageId, 2);
			expect(resumed.getConversationStartedAt()).toBe(startedAt);
			expect(
				addElapsedMessageTimes([{ role: "user", content: "later", timestamp: startedAt + 2_345 }], startedAt)[0]
					?.content,
			).toEqual([
				{ type: "text", text: "[T+2s]" },
				{ type: "text", text: "later" },
			]);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	it("does not mutate messages or provider-native payloads", () => {
		const providerPayload = {
			type: "openaiResponsesHistory" as const,
			provider: "openai-codex",
			items: [{ type: "message", content: "opaque" }],
		};
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "hello" }], providerPayload, timestamp: 2_000 },
		];
		const original = structuredClone(messages);

		const converted = addElapsedMessageTimes(messages, 1_000);

		expect(messages).toEqual(original);
		expect(converted).not.toBe(messages);
		expect(converted[0]).not.toBe(messages[0]);
		expect(converted[0]?.content).not.toBe(messages[0]?.content);
		expect(converted[0]?.content[1]).not.toBe(messages[0]?.content[0]);
		if (converted[0]?.role !== "user") throw new Error("expected a user message");
		expect(converted[0].providerPayload).toBe(providerPayload);
	});
});
