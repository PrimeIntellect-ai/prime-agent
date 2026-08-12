import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const expectedSessionDir = join(agentDir, "sessions");
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("rebuilds provider-native history for an explicit resume model", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();
		const sessionManager = SessionManager.inMemory(cwd);
		sessionManager.appendModelChange("openai-codex", "gpt-5.3-codex");
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "history before native compaction" }],
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			...fauxAssistantMessage("old response"),
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.3-codex",
		});
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "retained message" }],
			timestamp: Date.now(),
		});
		sessionManager.appendCompaction(
			"provider-native placeholder",
			firstKeptEntryId,
			100,
			undefined,
			false,
			undefined,
			{
				provider: "openai-codex",
				replacementHistory: [{ type: "compaction", encrypted_content: "opaque-state" }],
				compactionItem: { type: "compaction", encrypted_content: "opaque-state" },
			},
		);

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(JSON.stringify(session.messages)).toContain("history before native compaction");
		expect(session.messages.some((message) => "providerPayload" in message)).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
			tools: ["ipython"],
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Working directory: ${sessionCwd}`);

		const ipythonTool = session.agent.state.tools.find((tool) => tool.name === "ipython");
		expect(ipythonTool).toBeTruthy();
		const result = await ipythonTool!.execute("test", { code: "%%bash\npwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});
