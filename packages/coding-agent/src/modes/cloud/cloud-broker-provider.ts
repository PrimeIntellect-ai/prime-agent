import { randomUUID } from "node:crypto";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type CloudClientId,
	type CloudInferenceEnd,
	type CloudInferenceError,
	type CloudInferenceEvent,
	type CloudInferenceRequest,
	type CloudModelMetadata,
	type CloudSessionId,
	canonicalCloudModelSelector,
	splitCloudModelSelector,
} from "../../core/cloud/protocol.js";
import type { ModelRegistry } from "../../core/model-registry.js";

/**
 * The guest half of brokered cloud inference.
 *
 * The sandbox holds no provider credentials by design, so non-prime models
 * cannot run inside it. The cloud-broker api provider packages each
 * completion as an inference_request frame, writes it to the attached
 * local client through the protocol server, and relays the local side's
 * inference_event frames into the AssistantMessageEventStream the agent
 * loop consumes. Exactly one terminal frame (inference_end or
 * inference_error) settles each request.
 */

export const CLOUD_BROKER_API = "cloud-broker" as const;
export const CLOUD_BROKER_PROVIDER_ID = "cloud-broker";
/** Sentinel: the broker stub never makes an HTTP request. */
const CLOUD_BROKER_BASE_URL = "cloud-broker://local-daemon";
/**
 * Inert placeholder key for the cloud-broker provider config. It only marks
 * the provider as configured for the model-registry auth gate; it is never
 * a real credential and never leaves the sandbox process.
 */
const CLOUD_BROKER_PLACEHOLDER_KEY = "cloud-broker-local";
export const DEFAULT_CLOUD_INFERENCE_TIMEOUT_MS = 10 * 60_000;

const DEFAULT_STUB_CONTEXT_WINDOW = 200_000;
const DEFAULT_STUB_MAX_TOKENS = 8_192;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** The wire plumbing the guest daemon wires up at start. */
export interface CloudBrokerTransport {
	/** The guest daemon's cloud session id; rides every request frame. */
	cloudSessionId: CloudSessionId;
	/** Bound on the wait for terminal response frames. */
	timeoutMs: number;
	/**
	 * Writes one request frame to an attached local client; returns the
	 * client id that carried it, or undefined when no client can serve it.
	 */
	sendRequest(frame: CloudInferenceRequest): CloudClientId | undefined;
}

let currentTransport: CloudBrokerTransport | undefined;

/** One guest process hosts one daemon; the transport is process-global. */
export function setCloudBrokerTransport(transport: CloudBrokerTransport): void {
	currentTransport = transport;
}

interface PendingBrokerRequest {
	requestId: string;
	/** The client the request was written to; its drop fails the stream. */
	clientId: CloudClientId | undefined;
	model: Model<Api>;
	stream: AssistantMessageEventStream;
	timer: NodeJS.Timeout;
	signal: AbortSignal | undefined;
	onAbort: (() => void) | undefined;
}

const pendingRequests = new Map<string, PendingBrokerRequest>();

/**
 * The guest's stub for a model the local daemon runs. The id is the
 * canonical selector: the relay splits it back into the {provider, modelId}
 * the local side resolves against its own catalog, and the transcript
 * displays the full selector. Metadata comes from the local side's
 * open_session; absent metadata falls back to bounded defaults (the local
 * sender gap is reported, never hidden).
 */
export function createCloudBrokerStubModel(
	provider: string,
	modelId: string,
	metadata: CloudModelMetadata | undefined,
): Model<Api> {
	return {
		id: canonicalCloudModelSelector({ provider, id: modelId }),
		name: metadata?.name ?? `${provider}/${modelId}`,
		api: CLOUD_BROKER_API,
		provider: CLOUD_BROKER_PROVIDER_ID,
		baseUrl: CLOUD_BROKER_BASE_URL,
		reasoning: metadata?.reasoning ?? false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: metadata?.contextWindow ?? DEFAULT_STUB_CONTEXT_WINDOW,
		maxTokens: metadata?.maxTokens ?? DEFAULT_STUB_MAX_TOKENS,
	};
}

function brokerErrorAssistantMessage(model: Model<Api>, message: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
		stopReason: "error",
		errorMessage: message,
		timestamp: Date.now(),
	};
}

function disposePending(pending: PendingBrokerRequest): void {
	pendingRequests.delete(pending.requestId);
	clearTimeout(pending.timer);
	if (pending.signal !== undefined && pending.onAbort !== undefined) {
		pending.signal.removeEventListener("abort", pending.onAbort);
	}
}

function failPending(pending: PendingBrokerRequest, message: string): void {
	disposePending(pending);
	const error = brokerErrorAssistantMessage(pending.model, message);
	pending.stream.push({ type: "error", reason: "error", error });
	pending.stream.end(error);
}

/** Route one local-side response frame to its waiting request. */
export function handleCloudBrokerFrame(frame: CloudInferenceEvent | CloudInferenceEnd | CloudInferenceError): void {
	const pending = pendingRequests.get(frame.requestId);
	if (pending === undefined) return;
	switch (frame.type) {
		case "inference_event":
			// The local side's stream events arrive as loose wire objects.
			pending.stream.push(frame.event as unknown as AssistantMessageEvent);
			return;
		case "inference_end": {
			disposePending(pending);
			const message = frame.message as unknown as AssistantMessage;
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				pending.stream.push({ type: "error", reason: message.stopReason, error: message });
				pending.stream.end(message);
				return;
			}
			pending.stream.push({ type: "done", reason: message.stopReason ?? "stop", message });
			pending.stream.end(message);
			return;
		}
		case "inference_error":
			failPending(pending, frame.error);
			return;
	}
}

/** Fail every pending request bound to one client (its connection dropped). */
export function failCloudBrokerRequestsForClient(clientId: CloudClientId, message: string): void {
	for (const pending of [...pendingRequests.values()]) {
		if (pending.clientId === clientId) failPending(pending, message);
	}
}

/** Fail every pending request (release, shutdown). */
export function failAllCloudBrokerRequests(message: string): void {
	for (const pending of [...pendingRequests.values()]) failPending(pending, message);
}

/**
 * Build the request frame from the LLM context. The wire carries plain JSON:
 * the canonical serializer rejects undefined-valued fields, so the round
 * trip strips them and the local side receives exactly the context the
 * guest computed. Options carry the context's system prompt and tools plus
 * the whitelisted provider knobs; the reasoning level rides request.thinking.
 */
function buildInferenceRequest(
	transport: CloudBrokerTransport,
	requestId: string,
	selector: { provider: string; modelId: string },
	context: Context,
	options: SimpleStreamOptions | undefined,
): CloudInferenceRequest {
	const payloadOptions: Record<string, unknown> = {};
	if (context.systemPrompt !== undefined && context.systemPrompt.length > 0) {
		payloadOptions.systemPrompt = context.systemPrompt;
	}
	if (context.tools !== undefined && context.tools.length > 0) {
		payloadOptions.tools = JSON.parse(JSON.stringify(context.tools));
	}
	if (options?.temperature !== undefined) payloadOptions.temperature = options.temperature;
	if (options?.maxTokens !== undefined) payloadOptions.maxTokens = options.maxTokens;
	if (options?.serviceTier !== undefined && options.serviceTier !== null) {
		payloadOptions.serviceTier = options.serviceTier;
	}
	if (options?.cacheRetention !== undefined) payloadOptions.cacheRetention = options.cacheRetention;
	if (options?.sessionId !== undefined) payloadOptions.sessionId = options.sessionId;
	if (options?.thinkingBudgets !== undefined) payloadOptions.thinkingBudgets = options.thinkingBudgets;
	return {
		type: "inference_request",
		sessionId: transport.cloudSessionId,
		remoteSessionId: options?.sessionId ?? transport.cloudSessionId,
		requestId,
		model: { provider: selector.provider, modelId: selector.modelId },
		...(options?.reasoning !== undefined ? { thinking: options.reasoning } : {}),
		payload: {
			messages: JSON.parse(JSON.stringify(context.messages)) as unknown[],
			...(Object.keys(payloadOptions).length > 0 ? { options: payloadOptions } : {}),
		},
	};
}

/**
 * The cloud-broker stream: request, relay, terminate. Request and runtime
 * failures are encoded in the stream per the provider contract, never
 * thrown.
 */
export function cloudBrokerStreamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const outer = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const transport = currentTransport;
		if (transport === undefined) {
			const error = brokerErrorAssistantMessage(model, "cloud inference broker is not available");
			outer.push({ type: "error", reason: "error", error });
			outer.end(error);
			return;
		}
		const selector = splitCloudModelSelector(model.id);
		if (selector === undefined) {
			const error = brokerErrorAssistantMessage(model, `invalid brokered model selector ${model.id}`);
			outer.push({ type: "error", reason: "error", error });
			outer.end(error);
			return;
		}
		const requestId = `infr_${randomUUID()}`;
		const pending: PendingBrokerRequest = {
			requestId,
			clientId: undefined,
			model,
			stream: outer,
			timer: setTimeout(() => {
				const still = pendingRequests.get(requestId);
				if (still !== undefined) {
					failPending(still, "cloud inference broker did not respond");
				}
			}, transport.timeoutMs),
			signal: options?.signal,
			onAbort: undefined,
		};
		pending.timer.unref?.();
		pendingRequests.set(requestId, pending);
		// An aborted turn settles the guest stream locally; late frames for
		// the request id are dropped by the pending lookup.
		if (options?.signal !== undefined) {
			pending.onAbort = () => {
				const still = pendingRequests.get(requestId);
				if (still === undefined) return;
				disposePending(still);
				const aborted: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } },
					stopReason: "aborted",
					errorMessage: "Request was aborted",
					timestamp: Date.now(),
				};
				outer.push({ type: "error", reason: "aborted", error: aborted });
				outer.end(aborted);
			};
			options.signal.addEventListener("abort", pending.onAbort, { once: true });
		}
		let clientId: CloudClientId | undefined;
		try {
			clientId = transport.sendRequest(buildInferenceRequest(transport, requestId, selector, context, options));
		} catch (error) {
			failPending(
				pending,
				`cloud inference request was rejected: ${error instanceof Error ? error.message : String(error)}`,
			);
			return;
		}
		if (clientId === undefined) {
			failPending(pending, "cloud inference broker is not connected");
			return;
		}
		pending.clientId = clientId;
	});
	return outer;
}

/**
 * Register the cloud-broker api provider on one runtime's model registry.
 * The registry re-applies provider configs after every refresh, so the
 * relay survives catalog reloads, and the provider's inert placeholder key
 * marks the broker as configured for the setModel auth gate without any
 * real credential. Registering no models keeps the catalog clean: stub
 * models are constructed per selection, never listed.
 */
export function registerCloudBrokerApiProvider(modelRegistry: ModelRegistry): void {
	modelRegistry.registerProvider(CLOUD_BROKER_PROVIDER_ID, {
		api: CLOUD_BROKER_API,
		apiKey: CLOUD_BROKER_PLACEHOLDER_KEY,
		streamSimple: cloudBrokerStreamSimple,
		models: [],
	});
}
