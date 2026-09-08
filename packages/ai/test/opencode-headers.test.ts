import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getModels } from "../src/models.js";
import { complete, completeSimple } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.js";

const context: Context = { messages: [{ role: "user", content: "Reply OK", timestamp: 1 }] };
const models = (["opencode", "opencode-go"] as const).flatMap((provider) => {
	const catalog = getModels(provider);
	return [...new Set(catalog.map((model) => model.api))].map((api) => catalog.find((model) => model.api === api)!);
});

let server: Server;
let baseUrl: string;
let requests: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[];
let enforceContract: boolean;

beforeAll(async () => {
	server = createServer(async (req, res) => {
		let raw = "";
		for await (const chunk of req) raw += chunk.toString();
		const body = JSON.parse(raw) as Record<string, unknown>;
		requests.push({ headers: req.headers, body });
		if (
			enforceContract &&
			(!req.headers["x-opencode-session"] || !req.headers["user-agent"]?.startsWith("prime-agent"))
		) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Missing OpenCode identity" } }));
			return;
		}

		res.writeHead(200, { "content-type": "text/event-stream" });
		const event = (type: string, data: Record<string, unknown>) =>
			res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
		if (req.url?.includes("/messages")) {
			event("message_start", {
				message: {
					id: "fixture-message",
					type: "message",
					role: "assistant",
					model: body.model,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: { input_tokens: 1, output_tokens: 0 },
				},
			});
			event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
			event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "OK" } });
			event("content_block_stop", { index: 0 });
			event("message_delta", {
				delta: { stop_reason: "end_turn", stop_sequence: null },
				usage: { output_tokens: 1 },
			});
			event("message_stop", {});
		} else if (req.url?.includes("/responses")) {
			const item = {
				id: "fixture-output",
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "OK", annotations: [] }],
			};
			event("response.created", { response: { id: "fixture-response", status: "in_progress", output: [] } });
			event("response.output_item.added", {
				output_index: 0,
				item: { ...item, status: "in_progress", content: [] },
			});
			event("response.content_part.added", {
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			});
			event("response.output_text.delta", { output_index: 0, content_index: 0, delta: "OK" });
			event("response.output_item.done", { output_index: 0, item });
			event("response.completed", {
				response: {
					id: "fixture-response",
					status: "completed",
					output: [item],
					usage: { input_tokens: 1, output_tokens: 1 },
				},
			});
		} else if (req.url?.includes(":streamGenerateContent")) {
			res.write(
				`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] })}\n\n`,
			);
		} else {
			res.write(
				`data: ${JSON.stringify({ id: "fixture-completion", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\n`,
			);
			res.write("data: [DONE]\n\n");
		}
		res.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
	requests = [];
	enforceContract = true;
});

function expectSuccess(result: AssistantMessage) {
	expect(result.stopReason, result.errorMessage).toBe("stop");
	expect(
		result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join(""),
	).toBe("OK");
}

describe.each(models)("OpenCode identity: $provider/$api", (catalogModel) => {
	function request(options: SimpleStreamOptions = {}, model: Model<Api> = catalogModel, simple = true) {
		return (simple ? completeSimple : complete)({ ...model, baseUrl }, context, {
			apiKey: "fixture-not-a-real-key",
			sessionId: "conversation-a",
			maxTokens: 512,
			transport: "sse",
			signal: AbortSignal.timeout(5000),
			...options,
		});
	}

	it.each([true, false])("identifies repeated and distinct conversations (simple=%s)", async (simple) => {
		for (const sessionId of ["conversation-a", "conversation-a", "conversation-b"]) {
			const result = await request({ sessionId }, catalogModel, simple);
			const headers = requests.at(-1)?.headers;
			expect({ session: headers?.["x-opencode-session"], userAgent: headers?.["user-agent"] }).toEqual({
				session: sessionId,
				userAgent: expect.stringMatching(/^prime-agent(?:\/|$)/),
			});
			expectSuccess(result);
		}
	});

	it.each(["none", "short", "long"] as const)(
		"identifies conversations with cacheRetention=%s",
		async (cacheRetention) => {
			const result = await request({ cacheRetention });
			expect(requests.at(-1)?.headers["x-opencode-session"]).toBe("conversation-a");
			expectSuccess(result);
			if (cacheRetention === "none") {
				expect(requests.at(-1)?.body.prompt_cache_key).toBeUndefined();
				expect(requests.at(-1)?.headers.session_id).toBeUndefined();
			}
		},
	);

	it("accepts explicit identification headers as a contract control", async () => {
		const result = await request({
			headers: { "X-OpenCode-Session": "manual-conversation", "User-Agent": "prime-agent-control/1" },
		});
		expectSuccess(result);
		expect(requests.at(-1)?.headers["x-opencode-session"]).toBe("manual-conversation");
		expect(requests.at(-1)?.headers["user-agent"]).toBe("prime-agent-control/1");
	});

	it("preserves model headers and lets request headers override them regardless of casing", async () => {
		const model = {
			...catalogModel,
			headers: {
				"User-Agent": "prime-agent-model/1",
				"X-OpenCode-Session": "model-conversation",
				"X-Fixture": "model",
			},
		};
		expectSuccess(await request({}, model));
		expect(requests.at(-1)?.headers["user-agent"]).toBe("prime-agent-model/1");
		expect(requests.at(-1)?.headers["x-opencode-session"]).toBe("model-conversation");
		expectSuccess(
			await request(
				{
					headers: {
						"user-agent": "prime-agent-request/1",
						"x-opencode-session": "request-conversation",
						"x-fixture": "request",
					},
				},
				model,
			),
		);
		expect(requests.at(-1)?.headers["user-agent"]).toBe("prime-agent-request/1");
		expect(requests.at(-1)?.headers["x-opencode-session"]).toBe("request-conversation");
		expect(requests.at(-1)?.headers["x-fixture"]).toBe("request");
		expect(model.headers["X-Fixture"]).toBe("model");
	});

	it.each([undefined, ""])("does not invent a conversation when sessionId=%s", async (sessionId) => {
		enforceContract = false;
		expectSuccess(await request({ sessionId }));
		expect(requests.at(-1)?.headers["x-opencode-session"]).toBeUndefined();
		expect(requests.at(-1)?.headers["user-agent"]).toMatch(/^prime-agent(?:\/|$)/);
	});

	it("does not add OpenCode identity for unrelated providers", async () => {
		enforceContract = false;
		expectSuccess(await request({}, { ...catalogModel, provider: "fixture-provider" }));
		expect(requests.at(-1)?.headers["x-opencode-session"]).toBeUndefined();
		expect(requests.at(-1)?.headers["user-agent"]).not.toMatch(/^prime-agent(?:\/|$)/);
	});
});
