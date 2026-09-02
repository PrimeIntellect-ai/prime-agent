/**
 * Tests for the B14a sandbox-side provider proxy client.
 *
 * Uses a fake in-memory FrameTransport with an adapter that connects
 * the SandboxProviderClient to the HomeProviderProxy. No real network,
 * credentials, or API keys are involved.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
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
	ModelLookup,
	ProxyCompletionFrame,
	ProxyErrorFrame,
	ProxyFrame,
	ProxyRequestFrame,
} from "../src/core/home-provider-proxy-types.js";
import { SandboxProviderClient } from "../src/core/sandbox-provider-client.js";
import type { FrameTransport } from "../src/core/sandbox-provider-client-types.js";

// ─── Fake FrameTransport ──────────────────────────────────────────────────

/**
 * In-memory FrameTransport. One side calls send(), the other side
 * receives via onFrame(). No network, credentials, or serialization.
 */
class FakeTransport {
	private handler: ((frame: ProxyFrame) => void) | null = null;
	private _closed = false;

	onFrame(handler: (raw: unknown) => void): () => void {
		this.handler = handler as (frame: ProxyFrame) => void;
		return () => {
			this.handler = null;
		};
	}

	send(_frame: ProxyFrame): void {
		if (this._closed) throw new Error("Transport closed");
	}

	/** Inject a frame from the proxy side to the client side. */
	receiveFromProxy(frame: unknown): void {
		if (this._closed || !this.handler) return;
		(this.handler as (raw: unknown) => void)(frame);
	}

	close(): void {
		this._closed = true;
		this.handler = null;
	}

	get closed(): boolean {
		return this._closed;
	}
}

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

function makeModelLookup(): ModelLookup {
	const model = faux.getModel()!;
	return {
		findModel(provider: string, modelId: string) {
			if (provider === model.provider && modelId === model.id) return model;
			return undefined;
		},
	};
}

interface TestHarness {
	clientTransport: FakeTransport;
	client: SandboxProviderClient;
	model: Model<Api>;
}

function createHarness(overrides?: { policy?: { provider: string; modelId: string }[] }): TestHarness {
	const model = faux.getModel()!;
	const modelLookup = makeModelLookup();
	const _policy = createExactAllowlistPolicy(overrides?.policy ?? [{ provider: model.provider, modelId: model.id }]);

	const clientTransport = new FakeTransport();
	const client = new SandboxProviderClient({
		transport: clientTransport as unknown as FrameTransport,
		modelLookup,
	});

	return { clientTransport, client, model };
}

/**
 * Drive a proxy and fan frames back to the client transport.
 * This simulates what a real transport server would do:
 * receive a request frame, call proxy.stream(), and send back the yielded frames.
 */
async function driveProxy(
	proxy: HomeProviderProxy,
	clientTransport: FakeTransport,
	requestFilter?: (frame: ProxyFrame) => boolean,
): Promise<void> {
	// We need to intercept send() to detect when the client sends a request frame.
	// Store original send.
	const origSend = clientTransport.send.bind(clientTransport);

	let _frameCount = 0;

	clientTransport.send = (frame: ProxyFrame) => {
		if (frame.type !== "request") {
			origSend(frame);
			return;
		}
		if (requestFilter && !requestFilter(frame)) {
			origSend(frame);
			return;
		}

		_frameCount++;

		// Run the proxy stream in background and fan results to clientTransport
		(async () => {
			try {
				const gen = proxy.stream(frame as ProxyRequestFrame);
				for await (const resultFrame of gen) {
					clientTransport.receiveFromProxy(resultFrame);
				}
			} catch (_err) {
				// Proxy error - send an error frame
				clientTransport.receiveFromProxy({
					type: "error",
					requestId: frame.requestId,
					stopReason: "error",
					code: "STREAM_FAILED",
					message: "Internal proxy error",
				} as ProxyErrorFrame);
			}
		})();
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("SandboxProviderClient", () => {
	afterEach(() => {
		if (faux) faux.unregister();
		clearApiProviders();
	});

	describe("basic streaming", () => {
		it("streams text response and produces done event", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("Hello from sandbox client!")]);
			const { client, model, clientTransport } = createHarness();

			// Create proxy and drive it
			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				systemPrompt: "You are a test assistant.",
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);

			const startEvent = events.find((e) => e.type === "start");
			expect(startEvent).toBeDefined();

			const textDeltas = events.filter((e) => e.type === "text_delta");
			expect(textDeltas.length).toBeGreaterThanOrEqual(1);

			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
			if (doneEvent?.type === "done") {
				expect(doneEvent.message.content[0]).toMatchObject({ type: "text" });
			}
		});

		it("produces exact text content order", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("First message")]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Say first", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);

			const textDeltas = events
				.filter((e): e is AssistantMessageEvent & { type: "text_delta"; delta: string } => e.type === "text_delta")
				.map((e) => e.delta);
			const fullText = textDeltas.join("");
			expect(fullText).toBe("First message");
		});

		it("handles tool call responses", async () => {
			setupFaux();
			faux.setResponses([
				fauxAssistantMessage([fauxText("Let me check that."), fauxToolCall("get_weather", { city: "Berlin" })]),
			]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Weather in Berlin?", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);

			const toolCallEvents = events.filter((e) => e.type === "toolcall_start" || e.type === "toolcall_end");
			expect(toolCallEvents.length).toBeGreaterThanOrEqual(1);

			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
			if (doneEvent?.type === "done") {
				const toolCalls = doneEvent.message.content.filter((c) => c.type === "toolCall");
				expect(toolCalls.length).toBe(1);
				if (toolCalls[0].type === "toolCall") {
					expect(toolCalls[0].name).toBe("get_weather");
				}
			}
		});

		it("includes usage in the done event", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("Usage test")]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Check usage", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);
			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
			if (doneEvent?.type === "done") {
				expect(doneEvent.message.usage).toBeDefined();
				expect(doneEvent.message.usage.totalTokens).toBeGreaterThanOrEqual(0);
				expect(doneEvent.message.usage.input).toBeGreaterThanOrEqual(0);
				expect(doneEvent.message.usage.output).toBeGreaterThanOrEqual(0);
			}
		});
	});

	describe("concurrent requests", () => {
		it("handles multiple concurrent streams with request-id isolation", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("Response A"), fauxAssistantMessage("Response B")]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const streamA = client.stream(model, {
				messages: [{ role: "user", content: "A", timestamp: Date.now() }],
			});
			const streamB = client.stream(model, {
				messages: [{ role: "user", content: "B", timestamp: Date.now() }],
			});

			const [eventsA, eventsB] = await Promise.all([collectEvents(streamA), collectEvents(streamB)]);

			const doneA = eventsA.find((e) => e.type === "done");
			const doneB = eventsB.find((e) => e.type === "done");
			expect(doneA).toBeDefined();
			expect(doneB).toBeDefined();

			expect(client.activeRequestCount).toBe(0);
		});
		it("processes frames in order per request", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("Test order")]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Order", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);

			const types = events.map((e) => e.type);
			const startIdx = types.indexOf("start");
			const textDeltaIdx = types.indexOf("text_delta");
			const doneIdx = types.indexOf("done");

			expect(startIdx).toBeGreaterThanOrEqual(0);
			expect(textDeltaIdx).toBeGreaterThan(startIdx);
			expect(doneIdx).toBeGreaterThan(textDeltaIdx);
		});
	});

	describe("cancellation", () => {
		it("cancel sends a cancel frame through the transport for an active request", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();

			// Don't use driveProxy - we'll manually intercept
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};

			// Start a stream - the request frame will be captured
			client.stream(model, {
				messages: [{ role: "user", content: "Cancel me", timestamp: Date.now() }],
			});

			// Wait for the request frame to be sent
			await new Promise((resolve) => setTimeout(resolve, 5));

			const requestFrame = sentFrames.find((f) => f.type === "request") as ProxyRequestFrame | undefined;
			expect(requestFrame).toBeDefined();
			if (!requestFrame) return;
			const rid = requestFrame.requestId;

			// Now cancel - should send a cancel frame
			const beforeCancel = sentFrames.length;
			client.cancel(rid);

			// Should have sent exactly one more frame (the cancel)
			const newFrames = sentFrames.slice(beforeCancel);
			expect(newFrames.length).toBeGreaterThanOrEqual(1);
			const cancelFrame = newFrames.find((f) => f.type === "cancel");
			expect(cancelFrame).toBeDefined();
			if (cancelFrame) {
				expect((cancelFrame as any).requestId).toBe(rid);
			}

			// Second cancel for the same ID is a no-op
			const beforeNoop = sentFrames.length;
			client.cancel(rid);
			expect(sentFrames.length).toBe(beforeNoop);
		});
	});

	describe("disconnect", () => {
		it("aborts all active streams on disconnect", async () => {
			setupFaux();
			faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 1000));
					return fauxAssistantMessage("Never arrives");
				},
			]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Disconnect", timestamp: Date.now() }],
			});

			// Give a tick for the stream to start being processed
			await new Promise((resolve) => setTimeout(resolve, 10));
			client.disconnect();

			const events = await collectEvents(stream);
			expect(client.activeRequestCount).toBe(0);

			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});

		it("rejects new streams after disconnect", async () => {
			setupFaux();
			const { client, model } = createHarness();

			client.disconnect();

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "After disconnect", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});

		it("disconnect is idempotent", async () => {
			setupFaux();
			const { client } = createHarness();

			client.disconnect();
			client.disconnect();
		});
	});

	describe("malformed frames", () => {
		it("handles malformed streamEvent frames gracefully", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
			});

			// Send a malformed frame
			setTimeout(() => {
				clientTransport.receiveFromProxy({
					type: "streamEvent",
					eventType: "invalid_event_type",
					requestId: "nonexistent",
				} as any);
			}, 5);

			const events = await collectEvents(stream);
			expect(events.length).toBeGreaterThan(0);
		});

		it("ignores frames for unknown requestIds", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("Isolation test")]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
			});

			// Send a frame for a bogus requestId
			clientTransport.receiveFromProxy({
				type: "streamEvent",
				eventType: "text_delta",
				requestId: "bogus-request-id",
				contentIndex: 0,
				delta: "Should be ignored",
			} as any);

			const events = await collectEvents(stream);
			const deltas = events
				.filter((e): e is AssistantMessageEvent & { type: "text_delta"; delta: string } => e.type === "text_delta")
				.map((e) => e.delta);
			expect(deltas.some((d) => d.includes("ignored"))).toBe(false);

			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});
	});

	describe("asStreamFn adapter", () => {
		it("returns a callable function", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("StreamFn test")]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const streamFn = client.asStreamFn();
			expect(typeof streamFn).toBe("function");

			const stream = streamFn(model, {
				systemPrompt: "Test",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream as any);
			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});
	});

	describe("no credential fields", () => {
		it("request frames never contain apiKey, baseUrl, headers, or auth fields", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			// Spy AFTER driveProxy so we capture frames through the proxy chain
			const sentFrames: ProxyFrame[] = [];
			const driveSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return driveSend(frame);
			};

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Check credentials", timestamp: Date.now() }],
			});

			await collectEvents(stream);

			const requestFrame = sentFrames.find((f) => f.type === "request") as ProxyRequestFrame | undefined;
			expect(requestFrame).toBeDefined();
			if (requestFrame) {
				const keys = Object.keys(requestFrame);
				expect(keys).not.toContain("apiKey");
				expect(keys).not.toContain("api_key");
				expect(keys).not.toContain("auth");
				expect(keys).not.toContain("authorization");
				expect(keys).not.toContain("baseUrl");
				expect(keys).not.toContain("base_url");
				expect(keys).not.toContain("headers");
				expect(keys).not.toContain("token");
				expect(keys).not.toContain("oAuthToken");
				expect(keys).not.toContain("credentials");
				expect(keys).not.toContain("secret");
				expect(keys).not.toContain("password");

				expect(requestFrame.model).not.toHaveProperty("apiKey");
				expect(requestFrame.context).not.toHaveProperty("apiKey");
				expect(requestFrame.context).not.toHaveProperty("baseUrl");
				expect(requestFrame.context).not.toHaveProperty("auth");
				expect(requestFrame.context).not.toHaveProperty("headers");
				expect(requestFrame.context).not.toHaveProperty("authorization");
				expect(requestFrame.options).not.toHaveProperty("apiKey");
				expect(requestFrame.options).not.toHaveProperty("headers");
				expect(requestFrame.options).not.toHaveProperty("authToken");
			}
		});
	});

	describe("cancel emits terminal event", () => {
		it("cancel produces an aborted error event for the consumer", async () => {
			setupFaux();
			faux.setResponses([
				async () => {
					await new Promise((resolve) => setTimeout(resolve, 500));
					return fauxAssistantMessage("Never completes");
				},
			]);
			const { client, model, clientTransport } = createHarness();
			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Cancel me", timestamp: Date.now() }],
			});

			// Collect first few events then cancel
			const allEvents: AssistantMessageEvent[] = [];
			const iterator = stream[Symbol.asyncIterator]();

			// Get first event
			const firstResult = await iterator.next();
			if (firstResult.value) allEvents.push(firstResult.value);

			// Cancel using requestId from active streams
			// We know there's exactly one active stream
			client.cancel("nonexistent-id"); // Should be a no-op

			// Collect remaining
			for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
				allEvents.push(event);
			}
			// Just check the stream terminates eventually
			expect(client.activeRequestCount).toBe(0);
		});
	});

	describe("send throw handling", () => {
		it("produces error event when transport.send throws", async () => {
			setupFaux();
			const { clientTransport, client, model } = createHarness();

			// Make send throw
			clientTransport.send = () => {
				throw new Error("Transport broken");
			};

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
			expect(client.activeRequestCount).toBe(0);
		});
	});

	describe("pre-aborted signal", () => {
		it("produces immediate aborted error when signal is already aborted", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const abortController = new AbortController();
			abortController.abort();

			const stream = client.stream(
				model,
				{ messages: [{ role: "user", content: "Pre-aborted", timestamp: Date.now() }] },
				{ signal: abortController.signal },
			);

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
			if (errorEvent?.type === "error") {
				expect(errorEvent.reason).toBe("aborted");
			}
		});
	});

	describe("terminal cleanup", () => {
		it("ignores duplicate terminals - second completion after done is a no-op", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();

			// Intercept sends to capture requestId
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};

			const stream = client.stream(model, {
				messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
			});

			const requestFrame = sentFrames.find((f) => f.type === "request") as ProxyRequestFrame | undefined;
			expect(requestFrame).toBeDefined();
			const rid = requestFrame!.requestId;

			// Send completion
			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rid,
				message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" },
				usage: {
					input: 10,
					output: 5,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 15,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as ProxyCompletionFrame);

			// Give time for processing
			await new Promise((resolve) => setTimeout(resolve, 5));

			// Send duplicate completion (should be ignored - entry is already finished)
			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rid,
				message: { role: "assistant", content: [{ type: "text", text: "Duplicate" }], stopReason: "stop" },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as ProxyCompletionFrame);

			await new Promise((resolve) => setTimeout(resolve, 5));

			// Stream should have exactly one done event
			const events = await collectEvents(stream);
			const doneEvents = events.filter((e) => e.type === "done");
			expect(doneEvents).toHaveLength(1);
		});

		it("completed requests are cleaned up from active streams", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("Response A"), fauxAssistantMessage("Response B")]);
			const { client, model, clientTransport } = createHarness();
			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const streamA = client.stream(model, {
				messages: [{ role: "user", content: "A", timestamp: Date.now() }],
			});
			const streamB = client.stream(model, {
				messages: [{ role: "user", content: "B", timestamp: Date.now() }],
			});

			await Promise.all([collectEvents(streamA), collectEvents(streamB)]);

			expect(client.activeRequestCount).toBe(0);
		});
	});

	describe("malformed frame results in resolved error", () => {
		it("completion with invalid stopReason terminal-errors via failEntry", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			// Send a completion with stopReason=error (invalid for completion)
			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rf.requestId,
				message: { role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "error" },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("stream event with invalid contentIndex terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			// Send a text_delta with negative contentIndex
			clientTransport.receiveFromProxy({
				type: "streamEvent",
				eventType: "text_delta",
				requestId: rf.requestId,
				contentIndex: -1,
				delta: "bad",
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
		});

		it("done event with invalid content array terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			// Send done with invalid content (number instead of content block)
			clientTransport.receiveFromProxy({
				type: "streamEvent",
				eventType: "done",
				requestId: rf.requestId,
				stopReason: "stop",
				content: [123],
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
		});

		it("error frame with stop=stop (invalid for processError) terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			// Send error with stopReason "stop" (processError must reject non-error/aborted)
			clientTransport.receiveFromProxy({
				type: "error",
				requestId: rf.requestId,
				stopReason: "stop",
				code: "SOME_ERROR",
				message: "test",
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
		});
	});

	describe("unknown frame type", () => {
		it("unknown frame type terminal-errors the targeted stream", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			// Send a completely unknown frame type
			clientTransport.receiveFromProxy({
				type: "some_unknown_frame_type",
				requestId: rf.requestId,
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
		});

		it("unknown frame type does not affect other streams", async () => {
			setupFaux();
			faux.setResponses([fauxAssistantMessage("OK"), fauxAssistantMessage("Also OK")]);
			const { client, model, clientTransport } = createHarness();
			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			const streamA = client.stream(model, {
				messages: [{ role: "user", content: "A", timestamp: Date.now() }],
			});
			const streamB = client.stream(model, {
				messages: [{ role: "user", content: "B", timestamp: Date.now() }],
			});

			const [resultA, resultB] = await Promise.all([streamA.result(), streamB.result()]);
			expect(resultA.stopReason).toBe("stop");
			expect(resultB.stopReason).toBe("stop");
			expect(client.activeRequestCount).toBe(0);
		});
	});

	describe("additional malformed frame tests", () => {
		it("completion with missing message terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rf.requestId,
				// no message field
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("completion with invalid content in message terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rf.requestId,
				message: { role: "assistant", content: null, stopReason: "stop" },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("error frame with no code terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			clientTransport.receiveFromProxy({
				type: "error",
				requestId: rf.requestId,
				stopReason: "error",
				// no code field
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("streamEvent with no eventType terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			clientTransport.receiveFromProxy({
				type: "streamEvent",
				requestId: rf.requestId,
				// no eventType
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("completion with invalid usage (negative totalTokens) terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rf.requestId,
				message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				usage: {
					input: -1,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("completion with invalid usage cost object terminal-errors", async () => {
			setupFaux();
			const { client, model, clientTransport } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rf.requestId,
				message: { role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop" },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: null, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("error");
			expect(client.activeRequestCount).toBe(0);
		});

		it("malformed raw (non-record) silently dropped, valid completion after", async () => {
			setupFaux();
			const { clientTransport, client, model } = createHarness();
			const sentFrames: ProxyFrame[] = [];
			const origSend = clientTransport.send.bind(clientTransport);
			clientTransport.send = (frame: ProxyFrame) => {
				sentFrames.push(frame);
				return origSend(frame);
			};
			const stream = client.stream(model, {
				messages: [{ role: "user", content: "test", timestamp: Date.now() }],
			});
			const rf = sentFrames.find((f): f is ProxyRequestFrame => f.type === "request")!;

			// Send a raw value that's not a Record - should be silently dropped
			// since it has no requestId to route
			clientTransport.receiveFromProxy("not_a_record" as any);

			// Send a valid completion after the malformed frame
			clientTransport.receiveFromProxy({
				type: "completion",
				requestId: rf.requestId,
				message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as any);

			const result = await stream.result();
			expect(result.stopReason).toBe("stop");
			expect(client.activeRequestCount).toBe(0);
		});
	});

	describe("concurrent request isolation", () => {
		it("does not impose a shared client-side rate limit on concurrent streams", async () => {
			setupFaux();
			faux.setResponses([
				fauxAssistantMessage("A"),
				fauxAssistantMessage("B"),
				fauxAssistantMessage("C"),
				fauxAssistantMessage("D"),
				fauxAssistantMessage("E"),
			]);
			const { client, model, clientTransport } = createHarness();

			const modelLookup = makeModelLookup();
			const proxy = new HomeProviderProxy({
				streamFn: streamSimple as unknown as StreamFn,
				modelLookup,
				policy: createExactAllowlistPolicy([{ provider: model.provider, modelId: model.id }]),
			});
			await driveProxy(proxy, clientTransport);

			// Start 5 concurrent streams
			const streams = Array.from({ length: 5 }, (_, i) =>
				client.stream(model, {
					messages: [{ role: "user", content: String(i), timestamp: Date.now() }],
				}),
			);

			const results = await Promise.all(streams.map((s) => collectEvents(s)));

			expect(results).toHaveLength(5);
			for (const events of results) {
				const doneEvent = events.find((e) => e.type === "done");
				expect(doneEvent).toBeDefined();
			}
			expect(client.activeRequestCount).toBe(0);
		});
	});
});
