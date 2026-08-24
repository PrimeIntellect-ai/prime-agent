import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";
import { createStreamLivenessHost, type StreamLivenessHost } from "../src/utils/stream-liveness.js";

interface TestWebSocket {
	on(event: "close", listener: () => void): TestWebSocket;
}

interface TestWebSocketServer {
	on(event: "connection", listener: (socket: TestWebSocket) => void): TestWebSocketServer;
	close(callback?: () => void): void;
}

interface WsTestModule {
	WebSocketServer: new (options: { server: Server }) => TestWebSocketServer;
	WebSocket: new (url: string, options?: { headers?: Record<string, string> }) => object;
}

const requireCommonJs = createRequire(import.meta.url);
const { WebSocketServer, WebSocket: WsWebSocket } = requireCommonJs("ws") as WsTestModule;

const servers: Server[] = [];
const webSocketServers: TestWebSocketServer[] = [];
const originalWebSocket = globalThis.WebSocket;

afterEach(async () => {
	globalThis.WebSocket = originalWebSocket;
	for (const webSocketServer of webSocketServers.splice(0)) {
		await new Promise<void>((resolve) => {
			try {
				webSocketServer.close(() => resolve());
			} catch {
				resolve();
			}
		});
	}
	for (const server of servers.splice(0)) {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

function token(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function codexModel(baseUrl: string): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function openAIResponsesModel(baseUrl: string): Model<"openai-responses"> {
	return {
		id: "gpt-test",
		name: "GPT test",
		api: "openai-responses",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function openAICompletionsModel(baseUrl: string): Model<"openai-completions"> {
	return {
		id: "gpt-test",
		name: "GPT test",
		api: "openai-completions",
		provider: "openai",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

const context: Context = {
	systemPrompt: "You are a helpful assistant.",
	messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
};

describe("provider stream liveness boundary", () => {
	type OpenAIStreamFactory = (
		baseUrl: string,
		streamLiveness: StreamLivenessHost,
	) => ReturnType<typeof streamOpenAIResponses>;

	const expectSilentOpenAIStream = async (createStream: OpenAIStreamFactory): Promise<void> => {
		let requestClosed = false;
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			_request.on("close", () => {
				requestClosed = true;
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		expect(address && typeof address === "object").toBe(true);
		if (!address || typeof address !== "object") return;

		const stream = createStream(
			`http://127.0.0.1:${address.port}/v1`,
			createStreamLivenessHost({
				policyResolver: () => ({
					connectingTimeoutMs: 100,
					headersTimeoutMs: 25,
					streamingIdleTimeoutMs: 25,
					finalizingTimeoutMs: 25,
					progressExtensionMs: 10,
					maxProgressExtensionMs: 20,
				}),
			}),
		);

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider_stream_stalled");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "provider_stream_stalled" })]),
		);
		expect(result.diagnostics?.filter((diagnostic) => diagnostic.type === "provider_stream_stalled")).toHaveLength(1);

		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 500;
			const poll = () => {
				if (requestClosed) {
					resolve();
					return;
				}
				if (Date.now() >= deadline) {
					reject(new Error("silent OpenAI request was not closed"));
					return;
				}
				setTimeout(poll, 5);
			};
			poll();
		});
	};

	test("settles a silent OpenAI Responses response and closes the request", async () => {
		await expectSilentOpenAIStream((baseUrl, streamLiveness) =>
			streamOpenAIResponses(openAIResponsesModel(baseUrl), context, {
				apiKey: "test-key",
				streamLiveness,
			}),
		);
	});

	test("settles a silent OpenAI Completions response and closes the request", async () => {
		await expectSilentOpenAIStream((baseUrl, streamLiveness) =>
			streamOpenAICompletions(openAICompletionsModel(baseUrl), context, {
				apiKey: "test-key",
				streamLiveness,
			}),
		);
	});

	test("settles a silent SSE response with a structured stall and closes the request", async () => {
		let requestClosed = false;
		const server = createServer((_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			_request.on("close", () => {
				requestClosed = true;
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		expect(address && typeof address === "object").toBe(true);
		if (!address || typeof address !== "object") return;

		const stream = streamOpenAICodexResponses(codexModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: token(),
			transport: "sse",
			streamLiveness: createStreamLivenessHost({
				policyResolver: () => ({
					connectingTimeoutMs: 100,
					headersTimeoutMs: 25,
					streamingIdleTimeoutMs: 25,
					finalizingTimeoutMs: 25,
					progressExtensionMs: 10,
					maxProgressExtensionMs: 20,
				}),
			}),
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider_stream_stalled");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "provider_stream_stalled" })]),
		);

		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 500;
			const poll = () => {
				if (requestClosed) {
					resolve();
					return;
				}
				if (Date.now() >= deadline) {
					reject(new Error("silent SSE request was not closed"));
					return;
				}
				setTimeout(poll, 5);
			};
			poll();
		});
	});

	test("settles a silent WebSocket response and closes the socket", async () => {
		let socketClosed = false;
		const server = createServer();
		const webSocketServer = new WebSocketServer({ server });
		webSocketServers.push(webSocketServer);
		webSocketServer.on("connection", (socket) => {
			socket.on("close", () => {
				socketClosed = true;
			});
		});
		servers.push(server);
		globalThis.WebSocket = WsWebSocket as unknown as typeof WebSocket;
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
		const address = server.address();
		expect(address && typeof address === "object").toBe(true);
		if (!address || typeof address !== "object") return;

		const stream = streamOpenAICodexResponses(codexModel(`http://127.0.0.1:${address.port}`), context, {
			apiKey: token(),
			transport: "websocket",
			streamLiveness: createStreamLivenessHost({
				policyResolver: () => ({
					connectingTimeoutMs: 100,
					headersTimeoutMs: 25,
					streamingIdleTimeoutMs: 25,
					finalizingTimeoutMs: 25,
					progressExtensionMs: 10,
					maxProgressExtensionMs: 20,
				}),
			}),
		});

		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("provider_stream_stalled");
		expect(result.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "provider_stream_stalled" })]),
		);

		await new Promise<void>((resolve, reject) => {
			const deadline = Date.now() + 500;
			const poll = () => {
				if (socketClosed) {
					resolve();
					return;
				}
				if (Date.now() >= deadline) {
					reject(new Error("silent WebSocket was not closed"));
					return;
				}
				setTimeout(poll, 5);
			};
			poll();
		});
	});
});
