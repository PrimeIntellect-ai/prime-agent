import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type FauxProviderRegistration,
	type FauxResponseStep,
	fauxAssistantMessage,
	registerFauxProvider,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	CloudTunnelAttachment,
	type CloudTunnelAttachmentCallbacks,
	type CloudTunnelAttachmentTarget,
} from "../src/core/cloud/bridge/tunnel-attachment.js";
import type {
	CloudTunnelConnection,
	CloudTunnelTransport,
	CloudTunnelTransportError,
} from "../src/core/cloud/bridge/tunnel-transport.js";
import {
	CLOUD_MAX_MESSAGE_BYTES,
	type CloudInferenceEnd,
	type CloudInferenceError,
	type CloudInferenceEvent,
	type CloudInferenceRequest,
	type CloudMessage,
	serializeCloudMessage,
} from "../src/core/cloud/protocol.js";
import { CloudInferenceBroker } from "../src/modes/daemon/cloud-inference-broker.js";

/**
 * The local half of brokered cloud inference, pinned against a file-driven
 * faux provider: the broker's request -> stream -> response frames contract
 * (order, echoed ids, failures, usage, the response bound), the payload and
 * options convention it serves, and the tunnel attachment's dispatch of
 * guest inference_request frames back over its live connection.
 */

type ResponseFrame = CloudInferenceEvent | CloudInferenceEnd | CloudInferenceError;

const registrations: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) registration.unregister();
});

/** A faux model typed the way the broker's resolver returns models. */
function fauxModel(registration: FauxProviderRegistration): Model<Api> | undefined {
	return registration.getModel() as unknown as Model<Api>;
}

/** Broker plus a response-frame recorder over the faux provider. */
function fauxBroker(options: {
	resolveModel?: (selector: { provider: string; modelId: string }) => Model<Api> | undefined;
	onUsage?: (sessionId: string, remoteSessionId: string, usage: unknown) => void;
	maxResponseFrames?: number;
}): { broker: CloudInferenceBroker; frames: ResponseFrame[] } {
	const registration = registerFauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
	registrations.push(registration);
	registration.setResponses([fauxAssistantMessage("hello world")]);
	const frames: ResponseFrame[] = [];
	const broker = new CloudInferenceBroker({
		resolveModel: options.resolveModel ?? (() => fauxModel(registration)),
		sendFrame: (frame) => frames.push(frame),
		...(options.onUsage !== undefined ? { onUsage: options.onUsage } : {}),
		...(options.maxResponseFrames !== undefined ? { maxResponseFrames: options.maxResponseFrames } : {}),
	});
	return { broker, frames };
}

/** A broker over its own registration when the test scripts the responses. */
function scriptedBroker(
	responses: FauxResponseStep[],
	options: { maxResponseFrames?: number } = {},
): { broker: CloudInferenceBroker; frames: ResponseFrame[] } {
	const registration = registerFauxProvider({ models: [{ id: "faux-1" }] });
	registrations.push(registration);
	registration.setResponses(responses);
	const frames: ResponseFrame[] = [];
	const broker = new CloudInferenceBroker({
		resolveModel: () => fauxModel(registration),
		sendFrame: (frame) => frames.push(frame),
		...(options.maxResponseFrames !== undefined ? { maxResponseFrames: options.maxResponseFrames } : {}),
	});
	return { broker, frames };
}

function inferenceRequest(overrides: Partial<CloudInferenceRequest> = {}): CloudInferenceRequest {
	return {
		type: "inference_request",
		sessionId: "sess_broker_1",
		remoteSessionId: "sess_remote_1",
		requestId: "req_1",
		model: { provider: "faux", modelId: "faux-1" },
		payload: { messages: [{ role: "user", content: "say it", timestamp: 1 }] },
		...overrides,
	};
}

function eventTypes(frames: ResponseFrame[]): string[] {
	return frames
		.filter((frame): frame is CloudInferenceEvent => frame.type === "inference_event")
		.map((frame) => String(frame.event.type));
}

describe("CloudInferenceBroker", () => {
	it("streams every event in order and finishes with one end frame, all echoing the request", async () => {
		const { broker, frames } = fauxBroker({});
		await broker.runRequest(inferenceRequest());
		expect(frames.length).toBeGreaterThan(2);
		const types = eventTypes(frames);
		expect(types[0]).toBe("start");
		expect(types).toContain("text_start");
		expect(types).toContain("text_delta");
		expect(types.indexOf("text_end")).toBeGreaterThan(types.indexOf("text_start"));
		// The terminal stream event never rides as an inference_event: the
		// end frame alone carries the final message.
		expect(types).not.toContain("done");
		expect(types).not.toContain("error");
		const end = frames.at(-1) as CloudInferenceEnd;
		expect(end.type).toBe("inference_end");
		expect(end.message).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "hello world" }],
		});
		for (const frame of frames) {
			expect(frame.sessionId).toBe("sess_broker_1");
			expect(frame.requestId).toBe("req_1");
		}
		// The provider-shaped message stays wire-serializable.
		expect(serializeCloudMessage(end as unknown as CloudMessage)).toBeTruthy();
	});

	it("answers an unknown model with one inference_error naming the selector", async () => {
		const { broker, frames } = fauxBroker({ resolveModel: () => undefined });
		await broker.runRequest(inferenceRequest({ model: { provider: "prime-inference", modelId: "internal/x" } }));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({
			type: "inference_error",
			sessionId: "sess_broker_1",
			requestId: "req_1",
			error: "unknown model: prime-inference/internal/x",
		});
	});

	it("records the finished request's usage for local accounting", async () => {
		const usages: Array<{ sessionId: string; remoteSessionId: string; usage: unknown }> = [];
		const { broker, frames } = fauxBroker({
			onUsage: (sessionId, remoteSessionId, usage) => usages.push({ sessionId, remoteSessionId, usage }),
		});
		await broker.runRequest(inferenceRequest());
		expect(frames.at(-1)?.type).toBe("inference_end");
		expect(usages).toHaveLength(1);
		expect(usages[0]).toMatchObject({ sessionId: "sess_broker_1", remoteSessionId: "sess_remote_1" });
		expect((usages[0].usage as { input: number; output: number }).input).toBeGreaterThan(0);
		expect((usages[0].usage as { input: number; output: number }).output).toBeGreaterThan(0);
	});

	it("serves a prime-inference selector: routing is the guest's choice, the broker filters nothing", async () => {
		const { broker, frames } = fauxBroker({});
		await broker.runRequest(
			inferenceRequest({ model: { provider: "prime-inference", modelId: "internal/glm-5.3-fast" } }),
		);
		expect(eventTypes(frames)[0]).toBe("start");
		expect(frames.at(-1)?.type).toBe("inference_end");
	});

	it("forwards the payload context and whitelisted options to the provider, never wire credentials", async () => {
		const registration = registerFauxProvider({ models: [{ id: "faux-1", reasoning: true }] });
		registrations.push(registration);
		const seen: Array<{ context: unknown; options: unknown }> = [];
		registration.setResponses([
			(context, options) => {
				seen.push({ context, options });
				return fauxAssistantMessage("ok");
			},
		]);
		const frames: ResponseFrame[] = [];
		const broker = new CloudInferenceBroker({
			resolveModel: () => fauxModel(registration),
			sendFrame: (frame) => frames.push(frame),
		});
		await broker.runRequest(
			inferenceRequest({
				thinking: "high",
				payload: {
					messages: [{ role: "user", content: "hello", timestamp: 5 }],
					options: {
						systemPrompt: "Be terse.",
						tools: [{ name: "ipython", description: "Run code", parameters: { type: "object" } }],
						temperature: 0.25,
						maxTokens: 512,
						sessionId: "cache-1",
						thinkingBudgets: { low: 1024 },
						apiKey: "wire-secret",
						headers: { "x-evil": "1" },
					},
				},
			}),
		);
		expect(seen).toHaveLength(1);
		const context = seen[0].context as {
			systemPrompt?: string;
			tools?: Array<{ name: string }>;
			messages: Array<{ role: string; content: unknown }>;
		};
		expect(context.systemPrompt).toBe("Be terse.");
		expect(context.tools?.[0]?.name).toBe("ipython");
		expect(context.messages[0]).toMatchObject({ role: "user" });
		expect(JSON.stringify(context.messages[0]?.content)).toContain("hello");
		const options = seen[0].options as Record<string, unknown>;
		expect(options.temperature).toBe(0.25);
		expect(options.maxTokens).toBe(512);
		expect(options.sessionId).toBe("cache-1");
		expect(options.thinkingBudgets).toEqual({ low: 1024 });
		expect(options.reasoning).toBe("high");
		expect(options.apiKey).toBeUndefined();
		expect(options.headers).toBeUndefined();
		expect(frames.at(-1)?.type).toBe("inference_end");
	});

	it.each([
		{
			what: "a provider stream error",
			response: fauxAssistantMessage("partial", { stopReason: "error", errorMessage: "provider exploded" }),
			error: "provider exploded",
		},
		{
			what: "an aborted stream",
			response: fauxAssistantMessage("partial", {
				stopReason: "aborted",
				errorMessage: "Request was aborted",
			}),
			error: "Request was aborted",
		},
	])("answers $what with one inference_error and no end frame", async ({ response, error }) => {
		const { broker, frames } = scriptedBroker([response]);
		await broker.runRequest(inferenceRequest());
		const last = frames.at(-1) as CloudInferenceError;
		expect(last.type).toBe("inference_error");
		expect(last.error).toContain(error);
		expect(frames.some((frame) => frame.type === "inference_end")).toBe(false);
		for (const frame of frames) {
			expect(frame.requestId).toBe("req_1");
		}
	});

	it("stops streaming past the response-frame bound with a single terminal frame", async () => {
		const { broker, frames } = scriptedBroker([fauxAssistantMessage("a long answer that streams many deltas")], {
			maxResponseFrames: 1,
		});
		await broker.runRequest(inferenceRequest());
		expect(frames).toHaveLength(2);
		expect(frames[0]?.type).toBe("inference_event");
		const last = frames[1] as CloudInferenceError;
		expect(last.type).toBe("inference_error");
		expect(last.error).toContain("response bound");
	});
});

// --- attachment dispatch (fake transport) ---------------------------------------

const target: CloudTunnelAttachmentTarget = {
	url: "https://tun-broker.tunnels.example.com",
	httpUser: "prime-agent",
	httpPassword: "edge-password",
	bridgeToken: "bridge-token-0123456789abcdef",
};

class FakeConnection implements CloudTunnelConnection {
	readonly sent: string[] = [];
	closed = false;
	private messageHandler: ((message: string) => void) | undefined;
	private closeHandler: ((error?: CloudTunnelTransportError) => void) | undefined;

	send(message: string): void {
		this.sent.push(message);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeHandler?.();
	}

	onMessage(handler: (message: string) => void): void {
		this.messageHandler = handler;
	}

	onClose(handler: (error?: CloudTunnelTransportError) => void): void {
		this.closeHandler = handler;
	}

	receive(message: CloudMessage): void {
		this.messageHandler?.(JSON.stringify(message));
	}

	receiveRaw(text: string): void {
		this.messageHandler?.(text);
	}
}

class FakeTransport implements CloudTunnelTransport {
	readonly connections: FakeConnection[] = [];

	async connect(): Promise<CloudTunnelConnection> {
		const connection = new FakeConnection();
		this.connections.push(connection);
		return connection;
	}
}

function attachmentCallbacks(overrides: Partial<CloudTunnelAttachmentCallbacks> = {}): CloudTunnelAttachmentCallbacks {
	return {
		resolveTarget: () => target,
		appendGuestEvent: () => undefined,
		flushTrace: async () => {},
		persistGuestCursor: () => undefined,
		loadGuestCursor: () => undefined,
		recordAttachment: () => undefined,
		isSessionLive: () => true,
		checkTunnelAlive: async () => true,
		onAttachmentError: () => undefined,
		onTerminal: () => undefined,
		...overrides,
	};
}

/** One attachment whose wired broker answers over the attachment itself. */
function brokeredAttachment(
	transport: FakeTransport,
	options: { withoutInferenceBroker?: boolean } = {},
): { attachment: CloudTunnelAttachment; requests: CloudInferenceRequest[] } {
	const requests: CloudInferenceRequest[] = [];
	let attachment: CloudTunnelAttachment | undefined;
	const registration = registerFauxProvider({ models: [{ id: "faux-1" }] });
	registrations.push(registration);
	registration.setResponses([fauxAssistantMessage("hello world")]);
	const broker = new CloudInferenceBroker({
		resolveModel: () => fauxModel(registration),
		sendFrame: (frame) => attachment?.sendInferenceResponse(frame),
	});
	attachment = new CloudTunnelAttachment({
		sessionId: "sess_broker_1",
		generation: 1,
		transport,
		callbacks: attachmentCallbacks({
			...(options.withoutInferenceBroker === true
				? {}
				: {
						onInferenceRequest: (inferenceRequest) => {
							requests.push(inferenceRequest);
							return broker.runRequest(inferenceRequest);
						},
					}),
		}),
		reconnectDelayMs: 5,
		maxReconnectDelayMs: 5,
		submitWaitMs: 50,
		sleepFn: async () => {},
	});
	return { attachment, requests };
}

function guestSnapshot(): CloudMessage {
	return {
		type: "snapshot",
		sessionId: "sess_broker_1",
		generation: 1,
		cursor: { generation: 1, sequence: 0 },
		status: "idle",
		state: { cwd: "/w", modelId: "image-default", queuedCommandIds: [] },
		events: [],
	};
}

/** Drives the event loop (no clock) until the condition holds. */
async function settle(predicate: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 1_000 && !predicate(); attempt++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
	expect(predicate(), `timed out waiting for ${what}`).toBe(true);
}

function inferenceFrames(connection: FakeConnection): Array<Record<string, unknown>> {
	return connection.sent
		.map((raw) => JSON.parse(raw) as Record<string, unknown>)
		.filter((frame) => typeof frame.type === "string" && frame.type.startsWith("inference_"));
}

describe("CloudTunnelAttachment brokered inference dispatch", () => {
	it("runs a wired broker request and writes the response frames to the live connection", async () => {
		const transport = new FakeTransport();
		const { attachment, requests } = brokeredAttachment(transport);
		attachment.start();
		await settle(() => transport.connections.length > 0, "first connection");
		const connection = transport.connections[0] as FakeConnection;
		connection.receive(guestSnapshot());
		await settle(() => attachment.attached, "attachment");
		connection.receive(inferenceRequest());
		await settle(
			() => inferenceFrames(connection).some((frame) => frame.type === "inference_end"),
			"end frame on the wire",
		);
		expect(requests).toHaveLength(1);
		const frames = inferenceFrames(connection);
		expect(frames.at(-1)?.type).toBe("inference_end");
		expect(frames.slice(0, -1).every((frame) => frame.type === "inference_event")).toBe(true);
		expect(frames.length).toBeGreaterThan(2);
		for (const frame of frames) {
			expect(frame.sessionId).toBe("sess_broker_1");
			expect(frame.requestId).toBe("req_1");
		}
		expect(attachment.attached).toBe(true);
		await attachment.stop();
	});

	it("answers an inference request with one error frame when no broker is wired", async () => {
		const transport = new FakeTransport();
		const { attachment } = brokeredAttachment(transport, { withoutInferenceBroker: true });
		attachment.start();
		await settle(() => transport.connections.length > 0, "first connection");
		const connection = transport.connections[0] as FakeConnection;
		connection.receive(guestSnapshot());
		await settle(() => attachment.attached, "attachment");
		connection.receive(inferenceRequest());
		await settle(
			() => inferenceFrames(connection).some((frame) => frame.type === "inference_error"),
			"unavailable error frame",
		);
		const errors = inferenceFrames(connection).filter((frame) => frame.type === "inference_error");
		expect(errors).toHaveLength(1);
		expect(String(errors[0]?.error)).toContain("not available");
		expect(attachment.attached).toBe(true);
		await attachment.stop();
	});

	it("drops an oversized request frame without wedging and serves after the reconnect", async () => {
		const transport = new FakeTransport();
		const { attachment } = brokeredAttachment(transport);
		attachment.start();
		await settle(() => transport.connections.length > 0, "first connection");
		const first = transport.connections[0] as FakeConnection;
		first.receive(guestSnapshot());
		await settle(() => attachment.attached, "attachment");
		// The protocol rejects anything above the 1 MiB bound at parse; the
		// attachment drops the poison frame and reconnects.
		first.receiveRaw("x".repeat(CLOUD_MAX_MESSAGE_BYTES + 1));
		await settle(() => first.closed, "poisoned connection closed");
		await settle(() => transport.connections.length > 1, "reconnect");
		const second = transport.connections.at(-1) as FakeConnection;
		second.receive(guestSnapshot());
		await settle(() => attachment.attached, "attachment after reconnect");
		second.receive(inferenceRequest());
		await settle(
			() => inferenceFrames(second).some((frame) => frame.type === "inference_end"),
			"end frame after reconnect",
		);
		await attachment.stop();
	});
});
