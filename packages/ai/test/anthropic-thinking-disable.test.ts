import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { type AnthropicOptions, streamAnthropic } from "../src/providers/anthropic.js";
import { streamSimple } from "../src/stream.js";
import type { Context, Model, SimpleStreamOptions, Tool } from "../src/types.js";
import { getFixtureModel } from "./fixture-models.js";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
	temperature?: number;
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

describe("Anthropic thinking disable payload", () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5")!);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-6")!);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.7 when thinking is off", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-7")!);

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.7 when reasoning is enabled", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-7")!, {
			reasoning: "high",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-7")!, {
			reasoning: "xhigh",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.7", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-7")!, {
			reasoning: "max",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-6")!, {
			reasoning: "max",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("clamps xhigh reasoning to effort=max for Claude Opus 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-6")!, {
			reasoning: "xhigh",
		});

		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("maps max reasoning to effort=max for Claude Sonnet 4.6 (no native xhigh)", async () => {
		const payload = await capturePayload(getFixtureModel<"anthropic-messages">("anthropic", "claude-sonnet-4-6")!, {
			reasoning: "max",
		});

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	it("omits the thinking param for Claude Fable 5 when reasoning is off (explicit disabled is a 400)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5")!);

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("drops temperature for Claude Fable 5 (sampling params are rejected)", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5")!, { temperature: 0.5 });

		expect(payload.temperature).toBeUndefined();
		expect(payload.thinking).toBeUndefined();
	});

	it("uses adaptive thinking with effort=xhigh for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5")!, { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("maps max reasoning to effort=max for Claude Fable 5", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5")!, { reasoning: "max" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "max" });
	});

	// Opus 5.5 ships via the catalog and the snapshot's Opus 5 entry is an
	// openai-completions variant: use the release id over an Anthropic surface.
	it("omits thinking disabled and temperature for Claude Opus 5.5", async () => {
		const base = getModel("anthropic", "claude-fable-5")!;
		const opus55: Model<"anthropic-messages"> = { ...base, id: "claude-opus-5-5" };
		const payload = await capturePayload(opus55, { temperature: 0.5 });
		expect(payload.thinking).toBeUndefined();
		expect(payload.temperature).toBeUndefined();
		const adaptive = await capturePayload(opus55, { reasoning: "xhigh" });
		expect(adaptive.output_config).toEqual({ effort: "xhigh" });
	});
});

interface CapturedRequest {
	headers: IncomingMessage["headers"];
	body: Record<string, unknown>;
}

async function captureAnthropicRequest(
	model: Model<"anthropic-messages">,
	context: Context,
	options: AnthropicOptions,
): Promise<CapturedRequest> {
	let capturedRequest: CapturedRequest | undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		capturedRequest = {
			headers: request.headers,
			body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
		};
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	try {
		const s = streamAnthropic({ ...model, baseUrl: `http://127.0.0.1:${port}` }, context, options);
		for await (const event of s) {
			if (event.type === "done" || event.type === "error") break;
		}
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	if (!capturedRequest) throw new Error("Anthropic request was not captured");
	return capturedRequest;
}

function toolsOf(body: Record<string, unknown>): Array<Record<string, unknown>> {
	return (body.tools ?? []) as Array<Record<string, unknown>>;
}

function tool(name: string): Tool {
	return { name, description: `Tool ${name}`, parameters: Type.Object({ value: Type.String() }) };
}

const toolContext: Context = {
	messages: [{ role: "user", content: "Use the tool", timestamp: 1 }],
	tools: [tool("lookup")],
};

describe("Anthropic request wire contract", () => {
	const testModel = {
		...getFixtureModel<"anthropic-messages">("anthropic", "claude-opus-4-7")!,
		provider: "test-anthropic",
	} as Model<"anthropic-messages">;

	it.each([
		{
			name: "sends per-tool eager_input_streaming by default",
			compat: undefined,
			context: toolContext,
			eager: true,
			beta: undefined,
		},
		{
			name: "uses the legacy fine-grained beta when eager tool input streaming is disabled",
			compat: { supportsEagerToolInputStreaming: false },
			context: toolContext,
			eager: undefined,
			beta: "fine-grained-tool-streaming-2025-05-14",
		},
		{
			name: "omits the legacy fine-grained beta when there are no tools",
			compat: { supportsEagerToolInputStreaming: false },
			context: { messages: toolContext.messages } as Context,
			eager: undefined,
			beta: undefined,
		},
	])("$name", async ({ compat, context, eager, beta }) => {
		const request = await captureAnthropicRequest({ ...testModel, compat }, context, {
			apiKey: "test-key",
			cacheRetention: "none",
		});

		expect(toolsOf(request.body)[0]?.eager_input_streaming).toBe(eager);
		expect(request.headers["anthropic-beta"]).toBe(beta);
	});

	it("renames user tools to their Claude Code casing only for OAuth tokens", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
			tools: [tool("todowrite"), tool("find"), tool("my_custom_tool")],
		};

		const oauth = await captureAnthropicRequest(
			getFixtureModel<"anthropic-messages">("anthropic", "claude-sonnet-4-6")!,
			context,
			{
				apiKey: "sk-ant-oat-fake-token",
				cacheRetention: "none",
			},
		);
		expect(toolsOf(oauth.body).map((entry) => entry.name)).toEqual(["TodoWrite", "find", "my_custom_tool"]);
		// Subscription requests claim the Claude Code client identity, and the
		// claimed version must stay at or above what the API's model gates require
		// (opus-5.5 family rejects anything below 2.280).
		expect(oauth.headers["user-agent"]).toMatch(/^claude-cli\//);
		expect(oauth.headers["x-app"]).toBe("cli");
		expect((oauth.headers["anthropic-beta"] as string) ?? "").toContain("claude-code-20250219");

		const apiKey = await captureAnthropicRequest(
			getFixtureModel<"anthropic-messages">("anthropic", "claude-sonnet-4-6")!,
			context,
			{
				apiKey: "sk-ant-api-fake-token",
				cacheRetention: "none",
			},
		);
		expect(toolsOf(apiKey.body).map((entry) => entry.name)).toEqual(["todowrite", "find", "my_custom_tool"]);
	});

	it("sends Copilot bearer auth, Copilot headers, and a valid Anthropic Messages payload", async () => {
		const model = getFixtureModel<"anthropic-messages">("github-copilot", "claude-sonnet-4.6")!;
		expect(model.api).toBe("anthropic-messages");

		const request = await captureAnthropicRequest(
			model as Model<"anthropic-messages">,
			{ systemPrompt: "You are a helpful assistant.", messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ apiKey: "tid_copilot_session_test_token" },
		);

		expect(request.headers.authorization).toBe("Bearer tid_copilot_session_test_token");
		expect(request.headers["x-api-key"]).toBeUndefined();
		expect(request.headers["user-agent"]).toContain("GitHubCopilotChat");
		expect(request.headers["copilot-integration-id"]).toBe("vscode-chat");
		expect(request.headers["x-initiator"]).toBe("user");
		expect(request.headers["openai-intent"]).toBe("conversation-edits");
		expect(request.headers["anthropic-beta"] ?? "").not.toContain("fine-grained-tool-streaming");

		expect(request.body.model).toBe("claude-sonnet-4.6");
		expect(request.body.stream).toBe(true);
		expect(request.body.max_tokens as number).toBeGreaterThan(0);
		expect(Array.isArray(request.body.messages)).toBe(true);
	});

	it("includes the interleaved-thinking beta for non-adaptive Copilot Claude models", async () => {
		const request = await captureAnthropicRequest(
			getFixtureModel<"anthropic-messages">("github-copilot", "claude-haiku-4.5")! as Model<"anthropic-messages">,
			{ messages: [{ role: "user", content: "Hello", timestamp: 1 }] },
			{ apiKey: "tid_copilot_session_test_token", interleavedThinking: true },
		);

		expect(request.headers["anthropic-beta"]).toContain("interleaved-thinking-2025-05-14");
	});
});
