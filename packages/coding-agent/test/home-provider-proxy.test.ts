/**
 * Tests for the B05 home-provider proxy.
 *
 * Uses the faux provider for all streaming so no real API keys, network,
 * or credentials are involved.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import {
	clearApiProviders,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
	streamSimple,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createExactAllowlistPolicy, HomeProviderProxy } from "../src/core/home-provider-proxy.js";
import type {
	HomeProviderProxyConfig,
	ModelLookup,
	ProxyCompletionFrame,
	ProxyErrorFrame,
	ProxyRequestFrame,
	ProxyStreamEventFrame,
} from "../src/core/home-provider-proxy-types.js";
import { PROXY_ERROR_CODES } from "../src/core/home-provider-proxy-types.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────

let faux: FauxProviderRegistration;

function setupFaux(api = "faux", provider = "faux", modelId = "faux-1") {
	clearApiProviders();
	faux = registerFauxProvider({
		api,
		provider,
		models: [{ id: modelId, name: "Faux Model" }],
		tokensPerSecond: 100000,
		tokenSize: { min: 100, max: 200 },
	});
	faux.setResponses([]);
	return faux;
}

function makeConfig(overrides?: Partial<HomeProviderProxyConfig>): HomeProviderProxyConfig {
	const model = faux.getModel()!;
	const modelLookup: ModelLookup = {
		findModel(provider: string, modelId: string) {
			if (provider === model.provider && modelId === model.id) return model;
			return undefined;
		},
	};
	return {
		streamFn: streamSimple as unknown as StreamFn,
		modelLookup,
		policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
		...overrides,
	};
}

function makeRequest(overrides?: Partial<ProxyRequestFrame>): ProxyRequestFrame {
	const model = faux.getModel()!;
	return {
		type: "request",
		requestId: "test-req-1",
		model: { provider: model.provider, modelId: model.id },
		context: {
			systemPrompt: "You are a test assistant.",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		},
		options: { temperature: 0.7, maxTokens: 100 },
		...overrides,
	};
}

async function collectFrames(
	gen: AsyncGenerator<ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame, void, unknown>,
): Promise<(ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame)[]> {
	const frames: (ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame)[] = [];
	for await (const f of gen) frames.push(f);
	return frames;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("HomeProviderProxy", () => {
	afterEach(() => {
		if (faux) faux.unregister();
		clearApiProviders();
	});

	it("streams text response through the proxy and yields a completion frame", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Hello from faux provider!")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));

		expect(frames.length).toBeGreaterThanOrEqual(4);

		const first = frames[0] as ProxyStreamEventFrame;
		expect(first.type).toBe("streamEvent");
		expect(first.eventType).toBe("start");

		const textDeltas = frames.filter(
			(f): f is ProxyStreamEventFrame => f.type === "streamEvent" && f.eventType === "text_delta",
		);
		expect(textDeltas.length).toBeGreaterThanOrEqual(1);

		const last = frames[frames.length - 1] as ProxyCompletionFrame;
		expect(last.type).toBe("completion");
		expect(last.message.content[0]).toMatchObject({ type: "text" });
		expect(last.usage.totalTokens).toBeGreaterThanOrEqual(0);
	});

	it("blocks disallowed provider/model with an error frame", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(
			makeConfig({ policy: createExactAllowlistPolicy([{ provider: "anthropic", modelId: "claude-3-5-sonnet" }]) }),
		);

		const frames = await collectFrames(
			proxy.stream(makeRequest({ model: { provider: "openai", modelId: "gpt-4" } })),
		);

		expect(frames).toHaveLength(1);
		const frame = frames[0] as ProxyErrorFrame;
		expect(frame.type).toBe("error");
		expect(frame.code).toBe(PROXY_ERROR_CODES.POLICY_DENIED);
		expect(frame.message).not.toContain("openai");
		expect(frame.message).not.toContain("gpt-4");
	});

	it("blocks same provider with wrong modelId", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(
			makeConfig({ policy: createExactAllowlistPolicy([{ provider: "faux", modelId: "faux-2" }]) }),
		);

		const frames = await collectFrames(proxy.stream(makeRequest({ model: { provider: "faux", modelId: "faux-1" } })));

		expect(frames).toHaveLength(1);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.POLICY_DENIED);
	});

	it("empty allowlist denies every request", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig({ policy: createExactAllowlistPolicy([]) }));

		const frames = await collectFrames(proxy.stream(makeRequest()));

		expect(frames).toHaveLength(1);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.POLICY_DENIED);
	});

	it("blocks unknown model IDs with an error frame", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(
			makeConfig({ policy: createExactAllowlistPolicy([{ provider: "faux", modelId: "nonexistent" }]) }),
		);

		const frames = await collectFrames(
			proxy.stream(makeRequest({ model: { provider: "faux", modelId: "nonexistent" } })),
		);

		expect(frames).toHaveLength(1);
		const frame = frames[0] as ProxyErrorFrame;
		expect(frame.type).toBe("error");
		expect(frame.code).toBe(PROXY_ERROR_CODES.MODEL_NOT_FOUND);
		expect(frame.message).not.toContain("nonexistent");
	});

	it("rejects duplicate requestId with an error frame", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const gen1 = proxy.stream(makeRequest());
		const gen2 = proxy.stream(makeRequest());

		const r1 = await gen1[Symbol.asyncIterator]().next();
		expect(r1.done).toBe(false);

		const frames2 = await collectFrames(gen2);
		expect(frames2).toHaveLength(1);
		const frame2 = frames2[0] as ProxyErrorFrame;
		expect(frame2.code).toBe(PROXY_ERROR_CODES.DUPLICATE_REQUEST);

		await collectFrames(gen1);
	});

	it("cancel before stream startup yields cancelled error frame", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Should not run")]);
		const proxy = new HomeProviderProxy(makeConfig());

		proxy.cancel("test-req-1");

		const frames = await collectFrames(proxy.stream(makeRequest()));
		expect(frames).toHaveLength(1);
		const frame = frames[0] as ProxyErrorFrame;
		expect(frame.type).toBe("error");
		expect(frame.code).toBe(PROXY_ERROR_CODES.REQUEST_CANCELLED);
		expect(proxy.activeRequestCount).toBe(0);
	});

	it("cancel during active stream yields aborted error frame", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Longer response that will be cancelled")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const gen = proxy.stream(makeRequest());
		const reader = gen[Symbol.asyncIterator]();

		const first = await reader.next();
		expect(first.done).toBe(false);

		proxy.cancel("test-req-1");

		const remaining: (ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame)[] = [];
		for await (const f of { [Symbol.asyncIterator]: () => reader }) {
			remaining.push(f);
		}

		const errorFrame = remaining.find((f) => f.type === "error") as ProxyErrorFrame | undefined;
		expect(errorFrame).toBeDefined();
		expect(errorFrame!.code).toBe(PROXY_ERROR_CODES.STREAM_ABORTED);
	});

	it("frames are JSON-serializable and carry no credentials", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Hello proxy!")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));

		for (const frame of frames) {
			const json = JSON.stringify(frame);
			expect(json).toBeTruthy();
			const lower = json.toLowerCase();
			expect(lower).not.toContain("api_key");
			expect(lower).not.toContain("apikey");
			expect(lower).not.toContain("authorization");
			expect(lower).not.toContain("bearer");
			expect(lower).not.toContain("x-api-key");
			expect(lower).not.toContain("oauth");
			expect(lower).not.toContain("baseurl");
		}
	});

	it("completion frame carries usage but no errorMessage", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Usage test")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));
		const completion = frames.find((f) => f.type === "completion") as ProxyCompletionFrame;

		expect(completion).toBeDefined();
		expect(typeof completion.usage.input).toBe("number");
		expect(typeof completion.usage.totalTokens).toBe("number");
		expect((completion.message as unknown as Record<string, unknown>).errorMessage).toBeUndefined();
	});

	it("activeRequestCount reflects in-flight streams", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Count test")]);
		const proxy = new HomeProviderProxy(makeConfig());

		expect(proxy.activeRequestCount).toBe(0);

		const gen = proxy.stream(makeRequest());
		const reader = gen[Symbol.asyncIterator]();
		await reader.next();

		expect(proxy.activeRequestCount).toBe(1);

		await collectFrames({ [Symbol.asyncIterator]: () => reader } as any);
		expect(proxy.activeRequestCount).toBe(0);
	});

	it("streams multi-block response (text + tool call)", async () => {
		setupFaux();
		faux.setResponses([
			fauxAssistantMessage([fauxText("Let me look that up."), fauxToolCall("search", { query: "test" })]),
		]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));

		const textStarts = frames.filter(
			(f): f is ProxyStreamEventFrame => f.type === "streamEvent" && f.eventType === "text_start",
		);
		expect(textStarts).toHaveLength(1);

		const toolcallStarts = frames.filter(
			(f): f is ProxyStreamEventFrame => f.type === "streamEvent" && f.eventType === "toolcall_start",
		);
		expect(toolcallStarts).toHaveLength(1);

		const completion = frames.find((f) => f.type === "completion") as ProxyCompletionFrame;
		expect(completion).toBeDefined();
		expect(completion.message.content).toHaveLength(2);
		expect(completion.message.content[0].type).toBe("text");
		expect(completion.message.content[1].type).toBe("toolCall");
	});

	it("rejects unknown option keys", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Should never run")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(
			proxy.stream(
				makeRequest({
					model: { provider: "faux", modelId: "faux-1" },
					options: { unknownOption: "bad" } as any,
				}),
			),
		);

		expect(frames).toHaveLength(1);
		const frame = frames[0] as ProxyErrorFrame;
		expect(frame.code).toBe(PROXY_ERROR_CODES.UNKNOWN_OPTION);
		expect(frame.message).not.toContain("unknownOption");
	});

	it("forwards reasoning option to the provider", async () => {
		setupFaux();
		faux.setResponses([
			(_ctx, opts) => {
				expect((opts as Record<string, unknown>)?.reasoning).toBe("high");
				return fauxAssistantMessage(`Reasoning mode: high`);
			},
		]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(
			proxy.stream(makeRequest({ options: { reasoning: "high" as any, temperature: 0.5 } })),
		);

		const completion = frames.find((f) => f.type === "completion") as ProxyCompletionFrame;
		expect(completion).toBeDefined();
	});

	it("forwards cacheRetention option", async () => {
		setupFaux();
		faux.setResponses([
			(_ctx, opts) => {
				expect((opts as Record<string, unknown>)?.cacheRetention).toBe("long");
				return fauxAssistantMessage("Cached");
			},
		]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest({ options: { cacheRetention: "long" as any } })));

		const completion = frames.find((f) => f.type === "completion") as ProxyCompletionFrame;
		expect(completion).toBeDefined();
	});

	it("forwards sessionId option", async () => {
		setupFaux();
		faux.setResponses([
			(_ctx, opts) => {
				expect((opts as Record<string, unknown>)?.sessionId).toBe("sess-123");
				return fauxAssistantMessage("Sessioned");
			},
		]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest({ options: { sessionId: "sess-123" as any } })));

		const completion = frames.find((f) => f.type === "completion") as ProxyCompletionFrame;
		expect(completion).toBeDefined();
	});

	it("error messages are redacted and contain no raw provider text", async () => {
		setupFaux();
		faux.setResponses([
			() =>
				fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "API key=sk-abc123 baseUrl=http://secret.internal.com",
				}),
		]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));

		const errorFrame = frames.find((f) => f.type === "error") as ProxyErrorFrame;
		expect(errorFrame).toBeDefined();
		const json = JSON.stringify(errorFrame);
		expect(json).not.toContain("sk-abc123");
		expect(json).not.toContain("secret.internal.com");
		expect(errorFrame.message).toBe("An internal provider error occurred");
	});

	it("serialized output never leaks model api/baseUrl/headers/keys", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Clean output")]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));

		const allJson = JSON.stringify(frames);
		const lower = allJson.toLowerCase();

		expect(lower).not.toContain("api_key");
		expect(lower).not.toContain("authorization");
		expect(lower).not.toContain("bearer");
		expect(lower).not.toContain("x-api-key");
		expect(lower).not.toContain("base_url");
		expect(lower).not.toContain("oauth");
		expect(allJson).not.toContain('"contextWindow"');
		expect(allJson).not.toContain('"maxTokens"');
	});

	// ─── Validation tests ─────────────────────────────────────────────────

	it("validates: empty requestId rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ requestId: "" })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: empty model provider rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ model: { provider: "", modelId: "m" } })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: empty messages rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ context: { messages: [] as any } })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: invalid temperature rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ options: { temperature: -1, maxTokens: 100 } })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: invalid maxTokens rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ options: { maxTokens: 0, temperature: 0.5 } })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: unknown message role rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(
			proxy.stream(makeRequest({ context: { messages: [{ role: "system", content: "hi", timestamp: 1 }] as any } })),
		);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: unknown user content block type rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(
			proxy.stream(
				makeRequest({
					context: { messages: [{ role: "user", content: [{ type: "video", url: "x" }], timestamp: 1 }] as any },
				}),
			),
		);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: assistant message missing stopReason rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(
			proxy.stream(
				makeRequest({
					context: {
						messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 1 }] as any,
					},
				}),
			),
		);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: toolResult missing required fields rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(
			proxy.stream(
				makeRequest({ context: { messages: [{ role: "toolResult", content: [], timestamp: 1 }] as any } }),
			),
		);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: options must be object when present", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ options: "invalid" as any })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: image block missing data/mimeType rejected", async () => {
		setupFaux();
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(
			proxy.stream(
				makeRequest({
					context: {
						messages: [{ role: "user", content: [{ type: "image", text: "nope" }], timestamp: 1 }] as any,
					},
				}),
			),
		);
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("completion frame has no errorMessage even when source has one", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Has error", { stopReason: "stop", errorMessage: "should-not-appear" })]);
		const proxy = new HomeProviderProxy(makeConfig());

		const frames = await collectFrames(proxy.stream(makeRequest()));

		const completion = frames.find((f) => f.type === "completion") as ProxyCompletionFrame;
		expect(completion).toBeDefined();
		expect((completion.message as unknown as Record<string, unknown>).errorMessage).toBeUndefined();
		expect(completion.message.stopReason).toBe("stop");
	});

	// ─── Error-safety tests ────────────────────────────────────────────

	it("validates: missing options rejected", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Should not run")]);
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ options: undefined as any })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("validates: null options rejected", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Should not run")]);
		const proxy = new HomeProviderProxy(makeConfig());
		const frames = await collectFrames(proxy.stream(makeRequest({ options: null as any })));
		expect((frames[0] as ProxyErrorFrame).code).toBe(PROXY_ERROR_CODES.INVALID_REQUEST);
	});

	it("catches throwing policy and yields redacted error", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Should not run")]);
		const proxy = new HomeProviderProxy(
			makeConfig({
				policy: {
					allowed: [],
					isAllowed() {
						throw new Error("API_KEY=sk-leaked");
					},
				},
			}),
		);

		const frames = await collectFrames(proxy.stream(makeRequest()));
		expect(frames).toHaveLength(1);
		const frame = frames[0] as ProxyErrorFrame;
		expect(frame.type).toBe("error");
		expect(frame.code).toBe(PROXY_ERROR_CODES.STREAM_FAILED);
		const json = JSON.stringify(frame);
		expect(json).not.toContain("sk-leaked");
	});

	it("catches throwing model lookup and yields redacted error", async () => {
		setupFaux();
		faux.setResponses([fauxAssistantMessage("Should not run")]);
		const proxy = new HomeProviderProxy(
			makeConfig({
				modelLookup: {
					findModel() {
						throw new Error("Bearer token=xyz");
					},
				},
			}),
		);

		const frames = await collectFrames(proxy.stream(makeRequest()));
		expect(frames).toHaveLength(1);
		const frame = frames[0] as ProxyErrorFrame;
		expect(frame.type).toBe("error");
		expect(frame.code).toBe(PROXY_ERROR_CODES.STREAM_FAILED);
		const json = JSON.stringify(frame);
		expect(json).not.toContain("Bearer");
		expect(json).not.toContain("xyz");
	});
});
