import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	clampThinkingLevel,
	type Model,
	type ModelThinkingLevel,
	type SimpleStreamOptions,
	streamSimple,
	type ThinkingBudgets,
	type Tool,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	CLOUD_MAX_ERROR_CHARS,
	type CloudInferenceEnd,
	type CloudInferenceError,
	type CloudInferenceEvent,
	type CloudInferenceRequest,
} from "../../core/cloud/protocol.js";
import { convertToLlm } from "../../core/messages.js";
import type { ResolvedRequestAuth } from "../../core/model-registry.js";

/**
 * Local side of brokered cloud inference.
 *
 * A cloud session's agent loop runs in the sandbox, but model calls for
 * anything but the scoped prime-inference key are brokered through this
 * daemon: the guest sends one `inference_request` frame per completion, the
 * broker resolves the selector against the user's LOCAL model catalog, streams
 * the completion with the same provider machinery a local session uses (local
 * credentials never enter the sandbox), and mirrors every stream event back
 * over the requesting session's tunnel attachment:
 *
 * - each non-terminal `AssistantMessageEvent` becomes one `inference_event`,
 * - terminal success becomes one `inference_end` carrying the final message,
 * - unknown models, auth failures, provider errors, aborts, and overruns
 *   become one bounded `inference_error`.
 *
 * One request always produces at most one terminal frame, bounded in total
 * by `maxResponseFrames` so a runaway delta loop cannot stream forever.
 */
export interface CloudInferenceBrokerOptions {
	/** Resolve one guest selector against the user's local model catalog. */
	resolveModel: (selector: { provider: string; modelId: string }) => Model<Api> | undefined;
	/** Route one response frame to the requesting session's tunnel attachment. */
	sendFrame: (frame: CloudInferenceEvent | CloudInferenceEnd | CloudInferenceError) => void;
	/**
	 * Provider credential resolution, the same seam a local session streams
	 * through; absent means the provider falls back to its own defaults.
	 */
	resolveAuth?: (model: Model<Api>) => Promise<ResolvedRequestAuth>;
	/** One finished request's usage, for local accounting on the cloud row. */
	onUsage?: (sessionId: string, remoteSessionId: string, usage: Usage) => void;
	/** Provider request timeout; the provider's own default applies when absent. */
	timeoutMs?: number;
	/** Bound on response frames for one request; past it the request errors. */
	maxResponseFrames?: number;
	log?: (message: string) => void;
}

const DEFAULT_MAX_RESPONSE_FRAMES = 50_000;

const CLOUD_THINKING_LEVELS: readonly ModelThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export class CloudInferenceBroker {
	private readonly resolveModel: CloudInferenceBrokerOptions["resolveModel"];
	private readonly sendFrame: CloudInferenceBrokerOptions["sendFrame"];
	private readonly resolveAuth: CloudInferenceBrokerOptions["resolveAuth"];
	private readonly onUsage: CloudInferenceBrokerOptions["onUsage"];
	private readonly timeoutMs: number | undefined;
	private readonly maxResponseFrames: number;
	private readonly log: ((message: string) => void) | undefined;

	constructor(options: CloudInferenceBrokerOptions) {
		this.resolveModel = options.resolveModel;
		this.sendFrame = options.sendFrame;
		this.resolveAuth = options.resolveAuth;
		this.onUsage = options.onUsage;
		this.timeoutMs = options.timeoutMs;
		this.maxResponseFrames = options.maxResponseFrames ?? DEFAULT_MAX_RESPONSE_FRAMES;
		this.log = options.log;
	}

	/** Serve one guest inference request; never throws (failures answer on the wire). */
	async runRequest(request: CloudInferenceRequest): Promise<void> {
		let terminal = false;
		const sendTerminal = (frame: CloudInferenceEnd | CloudInferenceError): void => {
			if (terminal) return;
			terminal = true;
			this.sendFrame(frame);
		};
		const errorFrame = (error: string): CloudInferenceError => ({
			type: "inference_error",
			sessionId: request.sessionId,
			requestId: request.requestId,
			error: error.slice(0, CLOUD_MAX_ERROR_CHARS),
		});
		try {
			const model = this.resolveModel(request.model);
			if (model === undefined) {
				sendTerminal(errorFrame(`unknown model: ${request.model.provider}/${request.model.modelId}`));
				return;
			}
			const options = this.streamOptions(request, model);
			let requestModel = model;
			if (this.resolveAuth !== undefined) {
				const auth = await this.resolveAuth(model);
				if (!auth.ok) {
					sendTerminal(errorFrame(auth.error));
					return;
				}
				options.apiKey = auth.apiKey;
				if (auth.headers !== undefined) options.headers = auth.headers;
				requestModel = auth.requestModel ?? model;
			}
			const controller = new AbortController();
			options.signal = controller.signal;
			const stream: AssistantMessageEventStream = streamSimple(requestModel, this.context(request), options);
			let frames = 0;
			for await (const event of stream) {
				if (event.type === "done") {
					this.onUsage?.(request.sessionId, request.remoteSessionId, event.message.usage);
					sendTerminal({
						type: "inference_end",
						sessionId: request.sessionId,
						requestId: request.requestId,
						// Provider messages carry undefined optional fields, which
						// canonical JSON rejects: frames ride JSON-safe payloads.
						message: jsonSafe(event.message) as unknown as Record<string, unknown>,
					});
					return;
				}
				if (event.type === "error") {
					sendTerminal(errorFrame(event.error.errorMessage ?? `model stream failed (${event.error.stopReason})`));
					return;
				}
				frames += 1;
				if (frames > this.maxResponseFrames) {
					controller.abort();
					sendTerminal(
						errorFrame(`brokered inference exceeded the ${this.maxResponseFrames}-frame response bound`),
					);
					return;
				}
				this.sendFrame({
					type: "inference_event",
					sessionId: request.sessionId,
					requestId: request.requestId,
					event: jsonSafe(event) as unknown as Record<string, unknown>,
				});
			}
			sendTerminal(errorFrame("model stream ended without a final message"));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			this.log?.(`cloud inference broker failed for ${request.sessionId}/${request.requestId}: ${reason}`);
			sendTerminal(errorFrame(reason));
		}
	}

	/** The provider context for one request: converted messages plus the system prompt and tools from the payload options. */
	private context(request: CloudInferenceRequest): Context {
		const options = request.payload.options ?? {};
		const tools = Array.isArray(options.tools) ? (options.tools as Tool[]) : undefined;
		return {
			// Idempotent for already-converted LlmMessages (the guest's normal
			// shape); raw AgentMessages convert exactly like a local session.
			messages: convertToLlm(request.payload.messages as AgentMessage[]),
			...(typeof options.systemPrompt === "string" ? { systemPrompt: options.systemPrompt } : {}),
			...(tools !== undefined && tools.length > 0 ? { tools } : {}),
		};
	}

	/**
	 * The whitelisted provider options for one request. Only known-safe
	 * SimpleStreamOptions fields ride from the wire; credentials, signals,
	 * and callbacks never do.
	 */
	private streamOptions(request: CloudInferenceRequest, model: Model<Api>): SimpleStreamOptions {
		const raw = request.payload.options ?? {};
		const options: SimpleStreamOptions = {};
		if (typeof raw.temperature === "number" && Number.isFinite(raw.temperature)) {
			options.temperature = raw.temperature;
		}
		if (typeof raw.maxTokens === "number" && Number.isInteger(raw.maxTokens) && raw.maxTokens > 0) {
			options.maxTokens = raw.maxTokens;
		}
		if (
			raw.serviceTier === "auto" ||
			raw.serviceTier === "default" ||
			raw.serviceTier === "flex" ||
			raw.serviceTier === "scale" ||
			raw.serviceTier === "priority"
		) {
			options.serviceTier = raw.serviceTier;
		}
		if (raw.cacheRetention === "none" || raw.cacheRetention === "short" || raw.cacheRetention === "long") {
			options.cacheRetention = raw.cacheRetention;
		}
		if (typeof raw.sessionId === "string" && raw.sessionId.length > 0) {
			options.sessionId = raw.sessionId;
		}
		if (isThinkingBudgets(raw.thinkingBudgets)) {
			options.thinkingBudgets = raw.thinkingBudgets;
		}
		if (this.timeoutMs !== undefined) {
			options.timeoutMs = this.timeoutMs;
		}
		if (
			typeof request.thinking === "string" &&
			CLOUD_THINKING_LEVELS.includes(request.thinking as ModelThinkingLevel)
		) {
			// The same clamp a local session applies: a level the model does
			// not support falls back to its nearest supported level.
			options.reasoning = clampThinkingLevel(model, request.thinking as ModelThinkingLevel);
		}
		return options;
	}
}

/** One wire-frame payload with undefined values dropped, so it always canonicalizes. */
function jsonSafe<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function isThinkingBudgets(value: unknown): value is ThinkingBudgets {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return Object.keys(record).every(
		(key) =>
			(key === "minimal" || key === "low" || key === "medium" || key === "high") &&
			typeof record[key] === "number" &&
			Number.isFinite(record[key]),
	);
}
