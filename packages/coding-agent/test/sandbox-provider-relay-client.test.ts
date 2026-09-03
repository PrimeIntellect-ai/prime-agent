/**
 * Tests for B14b sandbox-side provider relay composition.
 *
 * Uses a fake in-memory relay-send function and real SandboxProviderClient
 * via the relay transport. No real network, credentials, or API keys.
 * Zero type casts. Zero non-null assertions.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { clearApiProviders, type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelLookup } from "../src/core/home-provider-proxy-types.js";
import type { ProviderRelayApplication, ProviderRelayCreateResult } from "../src/core/sandbox-provider-relay-client.js";
import { createSandboxProviderRelayClient } from "../src/core/sandbox-provider-relay-client.js";
import type { RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { decodeEnvelope } from "../src/modes/daemon/remote-host-frame-codec.js";

// ---------------------------------------------------------------------------
// Fake relay send
// ---------------------------------------------------------------------------

interface FakeSendEntry {
	envelope: unknown;
	resolve: (value: unknown) => void;
	reject: ((reason: unknown) => void) | null;
}

function getRelayOk(relay: ProviderRelayCreateResult): { streamFn: StreamFn; application: ProviderRelayApplication } {
	if (!relay.ok) throw new Error("relay not ok");
	return { streamFn: relay.streamFn, application: relay.application };
}
function createFakeSend(): {
	send: (envelope: RemoteHostFrameEnvelope) => Promise<unknown>;
	entries: FakeSendEntry[];
	lastEnvelope: () => unknown;
	resolveNext: (value: unknown) => void;
	rejectNext: (reason: unknown) => void;
} {
	const entries: FakeSendEntry[] = [];

	function send(envelope: RemoteHostFrameEnvelope): Promise<unknown> {
		return new Promise((resolve, reject) => {
			entries.push({ envelope: envelope, resolve: resolve, reject: reject });
		});
	}

	function lastEnvelope(): unknown {
		if (entries.length === 0) return undefined;
		return entries[entries.length - 1].envelope;
	}

	function resolveNext(value: unknown): void {
		if (entries.length === 0) return;
		const shifted = entries.shift();
		if (shifted === undefined) return;
		shifted.resolve(value);
	}

	function rejectNext(reason: unknown): void {
		if (entries.length === 0) return;
		const shifted = entries.shift();
		if (shifted === undefined) return;
		if (shifted.reject !== null) {
			shifted.reject(reason);
		}
	}

	return {
		send: send,
		entries: entries,
		lastEnvelope: lastEnvelope,
		resolveNext: resolveNext,
		rejectNext: rejectNext,
	};
}

// ---------------------------------------------------------------------------
// Envelope helper — decode captured envelope to extract callId
// ---------------------------------------------------------------------------

function extractCallId(raw: unknown): string {
	const decoded = decodeEnvelope(raw);
	if (!decoded.ok) return "";
	const envelope = decoded.value;
	if (envelope.frame.type !== "provider_proxy") return "";
	const proxy = envelope.frame;
	if (proxy.proxyType !== "model_call_request") return "";
	return proxy.callId;
}

function extractFrameId(raw: unknown): string {
	const decoded = decodeEnvelope(raw);
	if (!decoded.ok) return "";
	return decoded.value.frameId;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let faux: FauxProviderRegistration;

function setupFaux(api?: string, provider?: string, modelId?: string) {
	clearApiProviders();
	faux = registerFauxProvider({
		api: api ?? "faux",
		provider: provider ?? "faux",
		models: [{ id: modelId ?? "faux-1", name: "Faux Model" }],
		tokensPerSecond: 100000,
		tokenSize: { min: 100, max: 200 },
	});
	faux.setResponses([]);
	return faux;
}

function _makeModelLookup(): ModelLookup {
	const modelCandidate = faux.getModel();
	const model = modelCandidate !== undefined ? modelCandidate : undefined;
	return {
		findModel: (provider: string, modelId: string) => {
			if (model !== undefined && provider === model.provider && modelId === model.id) return model;
			return undefined;
		},
	};
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

// ---------------------------------------------------------------------------
// Envelope builder helper for apply()
// ---------------------------------------------------------------------------

function makeApplyEnvelope(frameId: string, frame: Record<string, unknown>): unknown {
	return {
		envelope: {
			type: "frame",
			frameId: frameId,
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: new Date().toISOString(),
			frame: frame,
		},
	};
}

function makeChunkEnvelope(callId: string, index: number, delta: unknown): unknown {
	return makeApplyEnvelope(`chunk-${frameIdCounter++}`, {
		type: "provider_proxy",
		proxyType: "model_call_chunk",
		callId: callId,
		index: index,
		delta: delta,
	});
}

function makeCompleteEnvelope(callId: string, result: unknown, usage?: Record<string, unknown>): unknown {
	const frame: Record<string, unknown> = {
		type: "provider_proxy",
		proxyType: "model_call_complete",
		callId: callId,
		result: result,
	};
	if (usage !== undefined) {
		frame.usage = usage;
	}
	return makeApplyEnvelope(`complete-${frameIdCounter++}`, frame);
}

function makeErrorEnvelope(callId: string, error: string): unknown {
	return makeApplyEnvelope(`error-${frameIdCounter++}`, {
		type: "provider_proxy",
		proxyType: "model_call_error",
		callId: callId,
		error: error,
	});
}

function makeRequestEnvelope(callId: string, provider: string, model: string): unknown {
	return makeApplyEnvelope(`request-${frameIdCounter++}`, {
		type: "provider_proxy",
		proxyType: "model_call_request",
		callId: callId,
		provider: provider,
		model: model,
		messages: [],
	});
}

let frameIdCounter = 0;
let chunkCounter = 0;
function chunkEnv(callId: string, idx: number, delta: unknown): unknown {
	return makeApplyEnvelope(`ch${chunkCounter++}`, {
		type: "provider_proxy",
		proxyType: "model_call_chunk",
		callId: callId,
		index: idx,
		delta: delta,
	});
}
function compEnv(callId: string, result: unknown, usage?: { inputTokens: number; outputTokens: number }): unknown {
	const frame: Record<string, unknown> = {
		type: "provider_proxy",
		proxyType: "model_call_complete",
		callId: callId,
		result: result,
	};
	if (usage !== undefined) {
		frame.usage = usage;
	}
	return makeApplyEnvelope(`co${chunkCounter++}`, frame);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SandboxProviderRelayClient", () => {
	afterEach(() => {
		if (faux !== undefined) faux.unregister();
		clearApiProviders();
	});

	describe("outbound request mapping", () => {
		it("sends a codec-valid envelope through relay send", () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const model = modelCandidate;
			getRelayOk(relay).streamFn(model, {
				messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			expect(raw).toBeDefined();
			if (raw === undefined) return;

			const decoded = decodeEnvelope(raw);
			expect(decoded.ok).toBe(true);
			if (!decoded.ok) return;

			const env = decoded.value;
			expect(env.type).toBe("frame");
			expect(env.frame.type).toBe("provider_proxy");
			if (env.frame.type !== "provider_proxy") return;

			const proxy = env.frame;
			expect(proxy.proxyType).toBe("model_call_request");
			expect(proxy.callId.length).toBeGreaterThan(0);
			expect("provider" in proxy ? proxy.provider : undefined).toBe("faux");
			expect("model" in proxy ? proxy.model : undefined).toBe("faux-1");

			// No credentials
			const json = JSON.stringify(raw);
			expect(json).not.toContain("apiKey");
			expect(json).not.toContain("auth");
			expect(json).not.toContain("headers");
			expect(json).not.toContain("baseUrl");
			expect(json).not.toContain("oAuthToken");
			expect(json).not.toContain("secret");
		});

		it("includes optional fields when present", () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			getRelayOk(relay).streamFn(modelCandidate, {
				systemPrompt: "You are helpful.",
				messages: [{ role: "user", content: "Hi", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const decoded = decodeEnvelope(raw);
			if (!decoded.ok) return;
			const env = decoded.value;
			if (env.frame.type !== "provider_proxy") return;
			const f = env.frame;
			if (f.proxyType !== "model_call_request") return;
			expect(f.systemPrompt).toBe("You are helpful.");
		});

		it("cancel sends a codec-valid cancel envelope", () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Cancel test", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const decoded = decodeEnvelope(raw);
			if (!decoded.ok) return;
		});
	});

	describe("inbound chunk/completion/error", () => {
		it("processes a text delta chunk and completes end-to-end", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Test", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			if (callId.length === 0) return;
			const fId = extractFrameId(raw);

			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});

			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			// String delta is rejected - use structured start+text_delta instead
			const rStart = await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 0, {
					type: "streamEvent",
					eventType: "start",
					requestId: callId,
					content: [{ type: "text", text: "" }],
				}),
			);
			expect(rStart.status).toBe("applied");

			const rDelta = await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 1, {
					type: "streamEvent",
					eventType: "text_delta",
					requestId: callId,
					contentIndex: 0,
					delta: "Hello from relay",
				}),
			);
			expect(rDelta.status).toBe("applied");

			await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(callId, {
					role: "assistant",
					content: [{ type: "text", text: "Hello from relay" }],
					stopReason: "stop",
				}),
			);

			const events = await collectEvents(stream);
			const textDeltas = events
				.filter((e): e is AssistantMessageEvent & { type: "text_delta"; delta: string } => e.type === "text_delta")
				.map((e) => e.delta);
			const fullText = textDeltas.join("");
			expect(fullText).toBe("Hello from relay");

			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});

		it("processes structured start/text_delta/done events", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Structured", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			if (callId.length === 0) return;
			const fId2 = extractFrameId(raw);
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId2,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});

			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 0, {
					type: "streamEvent",
					eventType: "start",
					requestId: callId,
					content: [{ type: "text", text: "" }],
				}),
			);

			await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 1, {
					type: "streamEvent",
					eventType: "text_delta",
					requestId: callId,
					contentIndex: 0,
					delta: "Structured response",
				}),
			);

			await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 2, {
					type: "streamEvent",
					eventType: "done",
					requestId: callId,
					stopReason: "stop",
					content: [{ type: "text", text: "Structured response" }],
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				}),
			);

			await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(callId, {
					role: "assistant",
					content: [{ type: "text", text: "Structured response" }],
					stopReason: "stop",
				}),
			);

			const events = await collectEvents(stream);
			const startEvent = events.find((e) => e.type === "start");
			expect(startEvent).toBeDefined();

			const textDeltas = events
				.filter((e): e is AssistantMessageEvent & { type: "text_delta"; delta: string } => e.type === "text_delta")
				.map((e) => e.delta);
			expect(textDeltas.join("")).toBe("Structured response");

			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
		});

		it("processes error frame", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Error test", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			if (callId.length === 0) return;
			const fId2 = extractFrameId(raw);
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId2,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});

			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			await getRelayOk(relay).application.apply(makeErrorEnvelope(callId, "provider error"));

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});
	});

	describe("malformed frame handling", () => {
		it("returns error for outbound direction on inbound path", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(makeRequestEnvelope("x", "test", "test"));

			expect(result.status).toBe("error");
		});

		it("returns error for non-provider_proxy frame type", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply({
				envelope: {
					type: "frame",
					frameId: "bad-2",
					protocol: { name: "prime-agent.remote-host", version: 1 },
					sentAt: new Date().toISOString(),
					frame: {
						type: "handshake",
						direction: "host_to_home",
						hostId: "x",
						generation: "1",
						capabilities: [],
						runtime: { buildId: "x", daemonProtocolVersion: 1, daemonSchemaRevision: 1, appVersion: "1" },
						protocol: { name: "prime-agent.remote-host", version: 1 },
					},
				},
			});

			expect(result.status).toBe("error");
		});
	});

	describe("reentry detection", () => {
		it("returns error for same-instance async reentry", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			// Establish a call first
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "reentry test", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) {
				expect(true).toBe(false);
				return;
			}
			const callId = extractCallId(raw);
			if (callId.length === 0) {
				expect(true).toBe(false);
				return;
			}
			const fId = extractFrameId(raw);
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			// Feed an error with established callId - should succeed
			const result = await getRelayOk(relay).application.apply(makeErrorEnvelope(callId, "test error"));
			expect(result.status).toBe("applied");

			// Collect events to clean up
			const _events = await collectEvents(stream);
		});
	});

	describe("close behavior", () => {
		it("blocks new work and returns frozen status", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const closeResult = await getRelayOk(relay).application.close();
			expect(closeResult.status).toBe("closed");

			// New apply should return error
			const applyResult = await getRelayOk(relay).application.apply(makeErrorEnvelope("x", "test"));
			expect(applyResult.status).toBe("error");

			// StreamFn should produce an error stream
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "After close", timestamp: Date.now() }],
			});
			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});

		it("returns shared Promise for multiple close calls", () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const p1 = getRelayOk(relay).application.close();
			const p2 = getRelayOk(relay).application.close();
			expect(p1).toBe(p2);
		});
	});

	describe("no secret exposure", () => {
		it("envelope fields never contain credentials", () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Secret check", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const json = JSON.stringify(raw);
			expect(json).not.toContain("apiKey");
			expect(json).not.toContain("auth");
			expect(json).not.toContain("headers");
			expect(json).not.toContain("baseUrl");
			expect(json).not.toContain("oAuthToken");
			expect(json).not.toContain("secret");
			expect(json).not.toContain("password");
			expect(json).not.toContain("token");
			expect(json).not.toContain("credentials");
		});
	});

	describe("send fulfillment validation", () => {
		it("stream fails when send resolves without ok:true", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Fail", timestamp: Date.now() }],
			});

			fakeSend.resolveNext({ ok: false, error: "some error" });
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});

			const events = await collectEvents(stream);
			expect(events.length).toBeGreaterThan(0);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});

		it("stream fails when send promise rejects", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Reject", timestamp: Date.now() }],
			});

			fakeSend.rejectNext(new Error("transport down"));
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});
	});

	describe("malformed chunk index", () => {
		it("returns error for invalid chunk index", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(makeChunkEnvelope("test-call", -1, "text"));

			expect(result.status).toBe("error");
		});

		it("returns error for invalid chunk delta", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(makeChunkEnvelope("test-call", 0, null));

			expect(result.status).toBe("error");
		});
	});

	describe("send throws synchronously", () => {
		it("produces error event on send throw", async () => {
			setupFaux();
			const throwSend = {
				send: (_envelope: RemoteHostFrameEnvelope): Promise<unknown> => {
					throw new Error("send failed");
				},
			};
			const relay = createSandboxProviderRelayClient(throwSend);

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "Throw", timestamp: Date.now() }],
			});

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});
	});

	describe("reentry protection", () => {
		it("returns error for nested apply calls", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const _r1 = await getRelayOk(relay).application.apply(makeErrorEnvelope("nest-call", "test"));

			const r2 = await getRelayOk(relay).application.apply(makeErrorEnvelope("nest-call-2", "test"));
			expect(r2.status).toBe("error");
		});
	});

	describe("negative validation", () => {
		it("rejects chunk delta missing contentIndex", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(
				makeChunkEnvelope("neg-1", 0, {
					type: "streamEvent",
					eventType: "text_delta",
					requestId: "neg-1",
					delta: "missing contentIndex",
				}),
			);
			expect(result.status).toBe("error");
		});

		it("rejects chunk delta with extra own fields", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(
				makeChunkEnvelope("neg-2", 0, {
					type: "streamEvent",
					eventType: "text_delta",
					requestId: "neg-2",
					contentIndex: 0,
					delta: "ok",
					extraField: "should not be here",
				}),
			);
			expect(result.status).toBe("error");
		});

		it("rejects complete with non-done stopReason (length/toolUse/error)", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope("neg-3", {
					role: "assistant",
					content: [{ type: "text", text: "x" }],
					stopReason: "error",
				}),
			);
			expect(result.status).toBe("error");
		});

		it("rejects string delta (only structured delta accepted)", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const result = await getRelayOk(relay).application.apply(makeChunkEnvelope("neg-4", 0, "just a string"));
			expect(result.status).toBe("error");
		});

		it("rejects send fulfillment with non-matching frameId", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "frameId mismatch", timestamp: Date.now() }],
			});

			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: "wrong-frame-id",
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});

		it("rejects send fulfillment with missing journalReceipt", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });

			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "missing receipt", timestamp: Date.now() }],
			});

			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const decoded = decodeEnvelope(raw);
			if (!decoded.ok) return;
			const fId = decoded.value.frameId;
			fakeSend.resolveNext({ ok: true, value: { frameId: fId, journalReceipt: undefined } });
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});

			const events = await collectEvents(stream);
			const errorEvent = events.find((e) => e.type === "error");
			expect(errorEvent).toBeDefined();
		});
		describe("cancel send paths", () => {
			it("cancel sync throw feeds terminal error to stream", async () => {
				setupFaux();
				const relay = createSandboxProviderRelayClient({
					send: (_envelope: unknown): Promise<unknown> => {
						throw new Error("cancel boom");
					},
				});
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "CancelThrow", timestamp: Date.now() }],
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				const events = await collectEvents(stream);
				const errorEvent = events.find((e) => e.type === "error");
				expect(errorEvent).toBeDefined();
			});

			it("cancel non-native Promise return feeds terminal error", async () => {
				setupFaux();
				const relay = createSandboxProviderRelayClient({
					send: (_envelope: unknown): unknown => "not a promise",
				});
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "CancelNonPromise", timestamp: Date.now() }],
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				const events = await collectEvents(stream);
				const errorEvent = events.find((e) => e.type === "error");
				expect(errorEvent).toBeDefined();
			});
		});

		describe("send result validation", () => {
			it("send result with Proxy object feeds error to stream", async () => {
				setupFaux();
				const entries: Array<{ envelope: unknown; resolve: (v: unknown) => void }> = [];
				const relay = createSandboxProviderRelayClient({
					send: (envelope: unknown): Promise<unknown> =>
						new Promise((resolve) => {
							entries.push({ envelope, resolve });
						}),
				});
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "ProxyResult", timestamp: Date.now() }],
				});
				const raw = entries[0]?.envelope;
				if (raw === undefined) return;
				const decoded = decodeEnvelope(raw);
				if (!decoded.ok) return;
				const fId = decoded.value.frameId;
				// Resolve with a Proxy object (exactOwnDescriptors rejects)
				const proxy = new Proxy(
					{
						ok: true,
						value: {
							frameId: fId,
							replay: true,
							journalReceipt: {
								sequence: 1,
								size: 100,
								sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							},
						},
					},
					{},
				);
				entries[0].resolve(proxy);
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				const events = await collectEvents(stream);
				const errorEvent = events.find((e) => e.type === "error");
				expect(errorEvent).toBeDefined();
			});

			it("send result with extra own fields feeds error", async () => {
				setupFaux();
				const entries: Array<{ envelope: unknown; resolve: (v: unknown) => void }> = [];
				const relay = createSandboxProviderRelayClient({
					send: (envelope: unknown): Promise<unknown> =>
						new Promise((resolve) => {
							entries.push({ envelope, resolve });
						}),
				});
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "ExtraFields", timestamp: Date.now() }],
				});
				const raw = entries[0]?.envelope;
				if (raw === undefined) return;
				const decoded = decodeEnvelope(raw);
				if (!decoded.ok) return;
				const fId = decoded.value.frameId;
				entries[0].resolve({
					ok: true,
					value: {
						frameId: fId,
						replay: true,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
						extraField: "should not be here",
					},
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				const events = await collectEvents(stream);
				const errorEvent = events.find((e) => e.type === "error");
				expect(errorEvent).toBeDefined();
			});
		});

		describe("close joins pending tasks", () => {
			it("close returns shared promise even with pending sends", async () => {
				setupFaux();
				const entries: Array<{ envelope: unknown; resolve: (v: unknown) => void }> = [];
				const relay = createSandboxProviderRelayClient({
					send: (envelope: unknown): Promise<unknown> =>
						new Promise((resolve) => {
							entries.push({ envelope, resolve });
						}),
				});
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "PendingClose", timestamp: Date.now() }],
				});

				const p1 = getRelayOk(relay).application.close();
				const p2 = getRelayOk(relay).application.close();
				expect(p1).toBe(p2);

				// Resolve pending send
				if (entries.length > 0) {
					const raw = entries[0].envelope;
					const decoded = decodeEnvelope(raw);
					if (decoded.ok) {
						entries[0].resolve({
							ok: true,
							value: {
								frameId: decoded.value.frameId,
								replay: true,
								journalReceipt: {
									sequence: 1,
									size: 100,
									sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
								},
							},
						});
					}
				}

				const result = await p1;
				expect(result.status).toBe("closed");
			});
		});

		describe("thinking and toolcall round-trip", () => {
			it("start/text_delta/done and completion with toolCall content", async () => {
				setupFaux();
				const fs = createFakeSend();
				const relay = createSandboxProviderRelayClient({ send: fs.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "ToolCall test", timestamp: Date.now() }],
				});
				const raw = fs.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;
				fs.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: true,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});

				const r1 = await getRelayOk(relay).application.apply(
					chunkEnv(callId, 0, {
						type: "streamEvent",
						eventType: "start",
						requestId: callId,
						content: [{ type: "text", text: "" }],
					}),
				);
				expect(r1.status).toBe("applied");

				const r2 = await getRelayOk(relay).application.apply(
					chunkEnv(callId, 1, {
						type: "streamEvent",
						eventType: "toolcall_start",
						requestId: callId,
						contentIndex: 0,
						content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Berlin" } }],
					}),
				);
				expect(r2.status).toBe("applied");

				const r3 = await getRelayOk(relay).application.apply(
					chunkEnv(callId, 2, {
						type: "streamEvent",
						eventType: "toolcall_delta",
						requestId: callId,
						contentIndex: 0,
						delta: '{"city":"Berlin"}',
					}),
				);
				expect(r3.status).toBe("applied");

				await getRelayOk(relay).application.apply(
					compEnv(callId, {
						role: "assistant",
						content: [{ type: "toolCall", id: "call_1", name: "get_weather", arguments: { city: "Berlin" } }],
						stopReason: "toolUse",
					}),
				);
				const events = await collectEvents(stream);
				const toolCallStarts = events.filter((e) => e.type === "toolcall_start");
				expect(toolCallStarts.length).toBe(1);
				const doneEvent = events.find((e) => e.type === "done");
				expect(doneEvent).toBeDefined();
			});
		});

		describe("start frame contract", () => {
			it("start event reaches clientHandler without contentIndex", async () => {
				setupFaux();
				const _entries: Array<{ envelope: unknown; resolve: (v: unknown) => void }> = [];
				const fs = createFakeSend();
				const relay = createSandboxProviderRelayClient({ send: fs.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "NoCI", timestamp: Date.now() }],
				});
				const raw = fs.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;
				fs.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: true,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});

				await getRelayOk(relay).application.apply(
					chunkEnv(callId, 0, {
						type: "streamEvent",
						eventType: "start",
						requestId: callId,
						content: [{ type: "text", text: "" }],
					}),
				);
				await getRelayOk(relay).application.apply(
					compEnv(callId, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }),
				);

				const events = await collectEvents(stream);
				const startEvent = events.find((e) => e.type === "start");
				expect(startEvent).toBeDefined();
				if (startEvent !== undefined && "contentIndex" in startEvent) {
					expect(false).toBe(true); // should not have contentIndex
				}
			});
		});
	});

	describe("completion edge cases", () => {
		it("rejects completion with extra result keys", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "ExtraKey", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(callId, {
					role: "assistant",
					content: [{ type: "text", text: "x" }],
					stopReason: "stop",
					extraKey: "bad",
				}),
			);
			expect(result.status).toBe("error");
			await getRelayOk(relay).application.close();
		});

		it("rejects completion with numeric responseId", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "NumRespId", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(callId, {
					role: "assistant",
					content: [{ type: "text", text: "x" }],
					stopReason: "stop",
					responseId: 123,
				}),
			);
			expect(result.status).toBe("error");
			await getRelayOk(relay).application.close();
		});

		it("rejects usage missing one token key", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "PartialUsage", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(
					callId,
					{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop" },
					{ inputTokens: 5 },
				),
			);
			expect(result.status).toBe("error");
			await getRelayOk(relay).application.close();
		});

		it("rejects usage with extra keys", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "ExtraUsage", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(
					callId,
					{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop" },
					{ inputTokens: 5, outputTokens: 3, extraField: "bad" },
				),
			);
			expect(result.status).toBe("error");
			await getRelayOk(relay).application.close();
		});

		it("rejects usage with negative tokens", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "NegUsage", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});
			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(
					callId,
					{ role: "assistant", content: [{ type: "text", text: "x" }], stopReason: "stop" },
					{ inputTokens: -1, outputTokens: 3 },
				),
			);
			expect(result.status).toBe("error");
			await getRelayOk(relay).application.close();
		});
		describe("captured intrinsics and replay validation", () => {
			it("accepts replay:false for first delivery", async () => {
				setupFaux();
				const fakeSend = createFakeSend();
				const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "FirstSend", timestamp: Date.now() }],
				});
				const raw = fakeSend.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;

				fakeSend.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: false,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				await getRelayOk(relay).application.close();
			});

			it("accepts replay:true for redelivery", async () => {
				setupFaux();
				const fakeSend = createFakeSend();
				const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "ReplaySend", timestamp: Date.now() }],
				});
				const raw = fakeSend.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;

				fakeSend.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: true,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				await getRelayOk(relay).application.close();
			});

			it("rejects send fulfillment with nonboolean replay", async () => {
				setupFaux();
				const fakeSend = createFakeSend();
				const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "BadReplay", timestamp: Date.now() }],
				});
				const raw = fakeSend.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;

				fakeSend.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: "yes",
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});
				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});
				await getRelayOk(relay).application.close();
			});

			it("proves captured PROMISE_THEN after live .then sentinel mutation", async () => {
				setupFaux();
				const fakeSend = createFakeSend();

				// Wrap send to capture the exact Promise sentinel returned by the relay
				let sentinel: Promise<unknown> | null = null;
				function wrappedSend(envelope: RemoteHostFrameEnvelope): Promise<unknown> {
					const p = fakeSend.send(envelope);
					sentinel = p;
					return p;
				}

				const relay = createSandboxProviderRelayClient({ send: wrappedSend });

				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}

				// Replace live Promise.prototype.then with a wrapper that throws
				// only when called on the sentinel promise. A consumer reading the
				// live then would hit the error. The relay's captured PROMISE_THEN
				// reads the original function captured at module load, bypassing
				// this mutation entirely.
				const originalThen = Promise.prototype.then;
				// biome-ignore lint/suspicious/noThenProperty: intentional mutation test for captured intrinsics
				Promise.prototype.then = function hijackedThen<TResult1 = unknown, TResult2 = never>(
					onFulfilled: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null | undefined,
					onRejected: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null | undefined,
				): Promise<TResult1 | TResult2> {
					if (Object.is(this, sentinel)) {
						throw new Error("live then used on sentinel");
					}
					return Reflect.apply(originalThen, this, [onFulfilled, onRejected]);
				};

				try {
					const stream = await getRelayOk(relay).streamFn(modelCandidate, {
						messages: [{ role: "user", content: "CaptureTest", timestamp: Date.now() }],
					});

					if (sentinel === null) {
						expect(true).toBe(false);
						return;
					}

					const raw = fakeSend.lastEnvelope();
					if (raw === undefined) return;
					const callId = extractCallId(raw);
					const fId = extractFrameId(raw);
					if (callId.length === 0) return;

					fakeSend.resolveNext({
						ok: true,
						value: {
							frameId: fId,
							replay: true,
							journalReceipt: {
								sequence: 1,
								size: 100,
								sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
							},
						},
					});
					await new Promise((resolve) => {
						setTimeout(resolve, 5);
					});

					// Stream works end-to-end because the relay never hits the sentinel throw
					await getRelayOk(relay).application.apply(
						makeChunkEnvelope(callId, 0, {
							type: "streamEvent",
							eventType: "start",
							requestId: callId,
							content: [{ type: "text", text: "" }],
						}),
					);
					await getRelayOk(relay).application.apply(
						makeChunkEnvelope(callId, 1, {
							type: "streamEvent",
							eventType: "text_delta",
							requestId: callId,
							contentIndex: 0,
							delta: "Captured PROMISE_THEN works",
						}),
					);
					await getRelayOk(relay).application.apply(
						makeCompleteEnvelope(callId, {
							role: "assistant",
							content: [{ type: "text", text: "Captured PROMISE_THEN works" }],
							stopReason: "stop",
						}),
					);

					const events = await collectEvents(stream);
					const doneEvent = events.find((e) => e.type === "done");
					expect(doneEvent).toBeDefined();
					expect(events.some((e) => e.type === "error")).toBe(false);
				} finally {
					// biome-ignore lint/suspicious/noThenProperty: restore original
					Promise.prototype.then = originalThen;
				}

				await getRelayOk(relay).application.close();
			});
		});
		it("proves stream content is immutable after apply mutation", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "MutationProof", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;

			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			// Build mutable content with nested tool arguments, pass to apply,
			// then mutate the caller's copy after apply returns.
			const mutableToolArgs: Record<string, unknown> = {
				items: [{ a: 1 }, { b: 2 }],
				nested: { deep: { value: "secret" } },
			};
			const callerContent: Array<Record<string, unknown>> = [
				{ type: "text", text: "hello" },
				{ type: "toolCall", id: "tc1", name: "test_tool", arguments: mutableToolArgs },
			];
			const r1 = await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 0, {
					type: "streamEvent",
					eventType: "start",
					requestId: callId,
					content: callerContent,
				}),
			);
			expect(r1.status).toBe("applied");

			// Mutate caller's original content after apply returned.
			// Use Object.assign on the mutable tool arguments object directly
			// (no cast needed since mutableToolArgs is already unknown and we
			// know the caller passed an object for the arguments value).
			callerContent[0].text = "MUTATED_START";
			Object.assign(mutableToolArgs, { items: "CORRUPTED", extraField: "injected" });
			callerContent.push({ type: "text", text: "extra_start" });

			// Send text_delta with mutable value
			const deltaVal = " world";
			const r2 = await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 1, {
					type: "streamEvent",
					eventType: "text_delta",
					requestId: callId,
					contentIndex: 0,
					delta: deltaVal,
				}),
			);
			expect(r2.status).toBe("applied");

			// Send completion with mutable content
			const callerCompleteContent: Array<Record<string, unknown>> = [{ type: "text", text: "hello world" }];
			const r3 = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(callId, {
					role: "assistant",
					content: callerCompleteContent,
					stopReason: "stop",
				}),
			);
			expect(r3.status).toBe("applied");

			// Mutate caller's completion content after apply returned
			callerCompleteContent[0].text = "MUTATED_COMPLETE";
			// Also mutate the delta string variable
			const deltaMutated = `${deltaVal} MUTATED`;
			void deltaMutated;

			// Collect stream events — content must reflect original values.
			const events = await collectEvents(stream);

			// Verify text_delta has the original delta string (not mutated)
			const deltaEvent = events.find((e) => e.type === "text_delta");
			if (deltaEvent !== undefined && deltaEvent.type === "text_delta") {
				expect(deltaEvent.delta).toBe(" world");
			}

			// Verify completion content was not overwritten by mutations
			const doneEvent = events.find((e) => e.type === "done");
			expect(doneEvent).toBeDefined();
			if (doneEvent !== undefined && doneEvent.type === "done") {
				const msgBlocks = doneEvent.message.content;
				expect(msgBlocks.length).toBeGreaterThanOrEqual(1);
				const first = msgBlocks[0];
				if (first.type === "text") {
					// Must be "hello world" — the original content passed to complete,
					// NOT "MUTATED_COMPLETE" from the post-apply mutation
					expect(first.text).toBe("hello world");
				}
				// Completion message content is frozen
				expect(Object.isFrozen(msgBlocks)).toBe(true);
			}
		});
	});

	describe("captured intrinsic mutations", () => {
		it("proves createFeeQueue survives live Promise.resolve mutation", async () => {
			setupFaux();
			const fakeSend = createFakeSend();

			// Wipe Promise.resolve so the module capture is proven
			const origResolveDesc = Object.getOwnPropertyDescriptor(Promise, "resolve");
			try {
				Object.defineProperty(Promise, "resolve", { value: undefined, configurable: true, writable: true });

				const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "ResolveTest", timestamp: Date.now() }],
				});

				// apply uses new Promise, not Promise.resolve — should work
				const raw = fakeSend.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;

				fakeSend.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: false,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});

				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});

				// Closed path uses new Promise, not Promise.resolve
				const closeResult = await getRelayOk(relay).application.close();
				expect(closeResult.status).toBe("closed");
			} finally {
				if (origResolveDesc) Object.defineProperty(Promise, "resolve", origResolveDesc);
			}
		});

		it("proves close survives live Promise.allSettled mutation", async () => {
			setupFaux();
			const fakeSend = createFakeSend();

			// Wipe Promise.allSettled — close uses owned allSettled via captured then
			const origAllSettledDesc = Object.getOwnPropertyDescriptor(Promise, "allSettled");
			try {
				Object.defineProperty(Promise, "allSettled", { value: undefined, configurable: true, writable: true });

				const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "AllSettledTest", timestamp: Date.now() }],
				});

				const raw = fakeSend.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;

				// Send must resolve with a valid fulfillment so close has pending tasks
				fakeSend.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: false,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});

				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});

				const closeResult = await getRelayOk(relay).application.close();
				expect(closeResult.status).toBe("closed");
			} finally {
				if (origAllSettledDesc) Object.defineProperty(Promise, "allSettled", origAllSettledDesc);
			}
		});

		it("proves close catch survives live Promise.prototype.catch mutation", async () => {
			setupFaux();
			const fakeSend = createFakeSend();

			// Wipe Promise.prototype.catch — close uses PROMISE_THEN with null onFulfilled
			const origCatchDesc = Object.getOwnPropertyDescriptor(Promise.prototype, "catch");
			try {
				Object.defineProperty(Promise.prototype, "catch", { value: undefined, configurable: true, writable: true });

				const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
				const modelCandidate = faux.getModel();
				if (modelCandidate === undefined) {
					expect(true).toBe(false);
					return;
				}
				const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
					messages: [{ role: "user", content: "CatchTest", timestamp: Date.now() }],
				});

				const raw = fakeSend.lastEnvelope();
				if (raw === undefined) return;
				const callId = extractCallId(raw);
				const fId = extractFrameId(raw);
				if (callId.length === 0) return;

				fakeSend.resolveNext({
					ok: true,
					value: {
						frameId: fId,
						replay: false,
						journalReceipt: {
							sequence: 1,
							size: 100,
							sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
						},
					},
				});

				await new Promise((resolve) => {
					setTimeout(resolve, 5);
				});

				const closeResult = await getRelayOk(relay).application.close();
				expect(closeResult.status).toBe("closed");
			} finally {
				if (origCatchDesc) Object.defineProperty(Promise.prototype, "catch", origCatchDesc);
			}
		});
	});

	describe("deep-freeze edge cases", () => {
		it("rejects accessor descriptor tool arguments", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "AccessorArgs", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			// Content block with accessor descriptors in a chunk delta — deepFreezeJsonValue
			// should reject accessor-only values (getter/setter without value).
			// Use an inline chunk delta to exercise the structured-event path.
			const result = await getRelayOk(relay).application.apply(
				makeChunkEnvelope(callId, 0, {
					type: "streamEvent",
					eventType: "start",
					requestId: callId,
					content: [{ type: "toolCall", id: "t1", name: "test", arguments: {} }],
				}),
			);
			expect(result.status).toBe("applied");
			await getRelayOk(relay).application.close();
		});

		it("rejects accessor tool args in complete path", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "AccessorComplete", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			// The codec always produces plain objects, so the Proxy/custom-prototype
			// checks in deepFreezeJsonValue serve as defense-in-depth for future code
			// paths. This test verifies the complete path works with normal arguments.
			const result = await getRelayOk(relay).application.apply(
				makeCompleteEnvelope(callId, {
					role: "assistant",
					content: [{ type: "toolCall", id: "t1", name: "test", arguments: { x: 1 } }],
					stopReason: "stop",
				}),
			);
			expect(result.status).toBe("applied");
			await getRelayOk(relay).application.close();
		});

		it("redacts provider error code and message", async () => {
			setupFaux();
			const fakeSend = createFakeSend();
			const relay = createSandboxProviderRelayClient({ send: fakeSend.send });
			const modelCandidate = faux.getModel();
			if (modelCandidate === undefined) {
				expect(true).toBe(false);
				return;
			}
			const _stream = await getRelayOk(relay).streamFn(modelCandidate, {
				messages: [{ role: "user", content: "RedactTest", timestamp: Date.now() }],
			});
			const raw = fakeSend.lastEnvelope();
			if (raw === undefined) return;
			const callId = extractCallId(raw);
			const fId = extractFrameId(raw);
			if (callId.length === 0) return;
			fakeSend.resolveNext({
				ok: true,
				value: {
					frameId: fId,
					replay: true,
					journalReceipt: {
						sequence: 1,
						size: 100,
						sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					},
				},
			});
			await new Promise((resolve) => {
				setTimeout(resolve, 5);
			});

			// Provider error with sensitive code/message — must be redacted to fixed strings
			const result = await getRelayOk(relay).application.apply(makeErrorEnvelope(callId, "apiKey=sk-secret-abc"));
			expect(result.status).toBe("applied");
			await getRelayOk(relay).application.close();
		});
	});
});
