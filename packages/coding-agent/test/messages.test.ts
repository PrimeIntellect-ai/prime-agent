import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { addElapsedSystemPrompt, convertToLlm } from "../src/core/messages.js";
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

describe("addElapsedSystemPrompt", () => {
	it("keeps provider context stable until each 30-second boundary", () => {
		const base = "You are a coding agent.";
		expect(addElapsedSystemPrompt(base, 1_000, 30_999)).toBe(base);
		expect(addElapsedSystemPrompt(base, 1_000, 31_000)).toBe(
			`${base}\n\n<session-elapsed-time>\nT+30s since the first persisted session message.\n</session-elapsed-time>`,
		);
		expect(addElapsedSystemPrompt(base, 1_000, 60_999)).toContain("T+30s");
		expect(addElapsedSystemPrompt(base, 1_000, 61_000)).toContain("T+60s");
	});

	it("omits invalid and early hints and supports an empty system prompt", () => {
		expect(addElapsedSystemPrompt("base", Number.NaN, 60_000)).toBe("base");
		expect(addElapsedSystemPrompt("base", 60_000, 30_000)).toBe("base");
		expect(addElapsedSystemPrompt("", 0, 30_000)).toBe(
			"<session-elapsed-time>\nT+30s since the first persisted session message.\n</session-elapsed-time>",
		);
	});

	it("sends the hint to the provider without adding a transcript message", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-provider-time-"));
		const faux = registerFauxProvider();
		let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
		try {
			const manager = SessionManager.create(tempDir, join(tempDir, "sessions"));
			manager.appendMessage({
				role: "custom",
				customType: "hidden-anchor",
				content: "anchor",
				display: false,
				timestamp: Date.now() - 65_000,
			});
			let providerSystemPrompt = "";
			let providerMessages = "";
			faux.setResponses([
				(context) => {
					providerSystemPrompt = context.systemPrompt ?? "";
					providerMessages = JSON.stringify(context.messages);
					return fauxAssistantMessage("done");
				},
			]);
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			({ session } = await createAgentSession({
				model: faux.getModel(),
				sessionManager: manager,
				settingsManager: SettingsManager.inMemory(),
				resourceLoader: createTestResourceLoader(),
				authStorage,
				modelRegistry: ModelRegistry.inMemory(authStorage),
				noTools: "all",
			}));
			await session.prompt("run");
			await session.waitForIdle();
			expect(providerSystemPrompt).toContain("T+60s");
			expect(providerMessages).not.toContain("T+");
			expect(JSON.stringify(session.messages)).not.toContain("T+");
		} finally {
			if (session) await session.disposeAsync();
			faux.unregister();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps elapsed hints out of transcript and TUI messages across resume", () => {
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
			const beforeMessages = convertToLlm(manager.buildSessionContext().messages);
			expect(JSON.stringify(beforeMessages)).not.toContain("T+");
			expect(addElapsedSystemPrompt("base", manager.getConversationStartedAt()!, startedAt + 65_000)).toContain(
				"T+60s",
			);

			const branchFile = manager.createBranchedSession(assistantMessageId)!;
			const resumed = SessionManager.open(branchFile);
			expect(resumed.getConversationStartedAt()).toBe(startedAt);
			expect(convertToLlm(resumed.buildSessionContext().messages)).toEqual(beforeMessages);
			expect(addElapsedSystemPrompt("base", resumed.getConversationStartedAt()!, startedAt + 65_000)).toContain(
				"T+60s",
			);

			resumed.appendCompaction("summary", firstMessageId, 2);
			expect(resumed.getConversationStartedAt()).toBe(startedAt);
		} finally {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});
});

describe("convertToLlm hidden custom messages", () => {
	it("admits only model-context records without changing their journal fields", () => {
		const messages = [
			{
				role: "custom" as const,
				customType: "model-context",
				content: "model-only context",
				display: false,
				details: { source: "extension" },
				timestamp: 1,
			},
			{
				role: "custom" as const,
				customType: "hidden-diagnostic",
				content: "do not send",
				display: false,
				timestamp: 2,
			},
		];

		expect(convertToLlm(messages)).toEqual([
			{ role: "user", content: [{ type: "text", text: "model-only context" }], timestamp: 1 },
		]);
		expect(messages).toEqual([
			expect.objectContaining({ customType: "model-context", display: false, details: { source: "extension" } }),
			expect.objectContaining({ customType: "hidden-diagnostic", display: false }),
		]);
	});
});
