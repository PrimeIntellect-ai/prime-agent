import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type StreamFn } from "@earendil-works/pi-agent-core";
import { type Context, createAssistantMessageEventStream, getModel, type Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { PromptTemplate } from "../src/core/prompt-templates.js";
import { createTestResourceLoader } from "./utilities.js";

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

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i]!;
		if (message.role === "user") {
			return typeof message.content === "string"
				? message.content
				: message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
		}
	}
	return "";
}

function makeTemplate(name: string): PromptTemplate {
	return {
		name,
		description: `Test template ${name}`,
		content: `TEMPLATE_BODY_${name.toUpperCase()}`,
		sourceInfo: { source: "local", scope: "project", baseDir: "/tmp" } as PromptTemplate["sourceInfo"],
		filePath: `/tmp/${name}.md`,
	};
}

describe("AgentSession slash-command typo guard", () => {
	let tempDir: string;
	let prompts: PromptTemplate[];
	let promptCalls: string[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-slash-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		prompts = [];
		promptCalls = [];
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createSession() {
		const streamFn: StreamFn = (_model, context) => {
			promptCalls.push(lastUserText(context));
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "ok" }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: usage(),
						stopReason: "stop",
						timestamp: Date.now(),
					},
				});
			});
			return stream;
		};
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn,
		});
		const resourceLoader = createTestResourceLoader();
		const loader = resourceLoader as unknown as {
			getPrompts: () => { prompts: PromptTemplate[]; diagnostics: unknown[] };
		};
		loader.getPrompts = () => ({ prompts, diagnostics: [] });
		return { agent, resourceLoader };
	}

	it("rejects slash-command typos with a suggestion before any model call", async () => {
		const { agent, resourceLoader } = createSession();
		const authStorage = AuthStorage.create(join(tempDir, "auth2.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const { SessionManager } = await import("../src/core/session-manager.js");
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader,
		});
		try {
			await expect(session.prompt("/resuem")).rejects.toThrow("Unknown command: /resuem. Did you mean /resume?");
			expect(promptCalls).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it("passes through slash-prefixed prompts without a near command match", async () => {
		const { agent, resourceLoader } = createSession();
		const authStorage = AuthStorage.create(join(tempDir, "auth3.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const { SessionManager } = await import("../src/core/session-manager.js");
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions2")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models2.json")),
			resourceLoader,
		});
		try {
			await session.prompt("/etc/hosts is where hostname lookups start");
			expect(promptCalls).toEqual(["/etc/hosts is where hostname lookups start"]);
		} finally {
			session.dispose();
		}
	});

	it("expands registered templates instead of guarding them", async () => {
		prompts.push(makeTemplate("worktree-check"));
		const { agent, resourceLoader } = createSession();
		const authStorage = AuthStorage.create(join(tempDir, "auth4.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const { SessionManager } = await import("../src/core/session-manager.js");
		const { SettingsManager } = await import("../src/core/settings-manager.js");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions3")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models3.json")),
			resourceLoader,
		});
		try {
			await session.prompt("/worktree-check");
			expect(promptCalls).toEqual(["TEMPLATE_BODY_WORKTREE-CHECK"]);
		} finally {
			session.dispose();
		}
	});
});
