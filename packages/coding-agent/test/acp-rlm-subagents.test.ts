import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
	getModel,
	type TextContent,
	type Usage,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { convertToLlm } from "../src/core/messages.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { PRIME_AGENT_META_NAMESPACE } from "../src/modes/acp/acp-meta.js";
import { runAcpModeWithConnection } from "../src/modes/acp/index.js";
import { InProcessAgentConnection } from "../src/modes/agent-connection/in-process-agent-connection.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function userText(context: Context): string {
	const last = context.messages.at(-1);
	if (!last || last.role !== "user") return "";
	if (typeof last.content === "string") return last.content;
	return last.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function usage(input = 7, output = 3): Usage {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input, output, cacheRead: 0, cacheWrite: 0, total: input + output },
	};
}

function streamAnswer(text: string): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: usage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		stream.push({ type: "done", reason: "stop", message });
	});
	return stream;
}

/**
 * Proves RLM subagent activity reaches an ACP client.
 *
 * Uses real AgentSession instances with a stubbed stream function (no API key,
 * no network) so subagent spawn is genuine rather than mocked at the mapper.
 */

function runtimeHostFor(session: AgentSession): AgentSessionRuntime {
	return {
		session,
		setRebindSession() {},
		setBeforeSessionInvalidate() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
}

describe("ACP mode surfaces RLM subagents", () => {
	let tempDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-acp-rlm-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		session?.dispose();
		session = undefined;
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("streams subagent lifecycle to an ACP client as namespaced metadata", async () => {
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const agent = new Agent({
			convertToLlm,
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "", tools: [], thinkingLevel: "off" },
			streamFn: (_model, context) => streamAnswer(`child answer: ${userText(context)}`),
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRegistry: ModelRegistry.create(authStorage, join(tempDir, "models.json")),
			resourceLoader: createTestResourceLoader(),
		});

		const connection = new InProcessAgentConnection(runtimeHostFor(session));
		const toAgent = new TransformStream<Uint8Array, Uint8Array>();
		const toClient = new TransformStream<Uint8Array, Uint8Array>();
		const updates: any[] = [];
		void runAcpModeWithConnection(connection, {
			stream: acp.ndJsonStream(toClient.writable, toAgent.readable),
		} as any);
		const handle = acp
			.client({ name: "rlm-client" })
			.onNotification("session/update", (ctx: any) => {
				updates.push(ctx.params);
			})
			.connect(acp.ndJsonStream(toAgent.writable, toClient.readable));

		await handle.agent.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: {},
		});
		const acpSession = await handle.agent.request("session/new", { cwd: tempDir, mcpServers: [] });

		// No prompt turn: a fire-and-forget subagent must still reach the client,
		// which is only true if ACP subscribes for the session lifetime.
		await session.runRlmChild("summarize shard 1");

		// Drain the async notification queue.
		await new Promise((resolve) => setTimeout(resolve, 50));

		const subagentMeta = updates
			.map((u) => u.update?._meta?.[PRIME_AGENT_META_NAMESPACE]?.subagents)
			.filter(Boolean)
			.flat();
		expect(acpSession.sessionId).toBeTruthy();
		expect(subagentMeta.length, "subagent updates must reach the ACP client").toBeGreaterThan(0);
		expect(subagentMeta.some((entry: any) => entry.status === "running")).toBe(true);
		expect(subagentMeta.some((entry: any) => entry.status === "done")).toBe(true);
	}, 30_000);
});
