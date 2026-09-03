import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
	HomeProviderProxyConfig,
	ProviderProxyPolicy,
	ProxyAssistantMessage,
	ProxyCompletionFrame,
	ProxyContentBlock,
	ProxyErrorFrame,
	ProxyRequestFrame,
	ProxyStreamEventFrame,
	ProxyStreamOutput,
} from "./home-provider-proxy-types.js";
import { PROXY_ERROR_CODES } from "./home-provider-proxy-types.js";

const ALLOWED_OPTION_KEYS = new Set([
	"temperature",
	"maxTokens",
	"reasoning",
	"cacheRetention",
	"sessionId",
	"transport",
	"serviceTier",
	"thinkingBudgets",
]);

const ERROR_REDACTED_MSG = "An internal provider error occurred";

// Size limits
const MAX_REQUEST_ID_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 128;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_SYSTEM_PROMPT_LENGTH = 1_000_000;
const MAX_MESSAGES = 1024;
const MAX_TOOLS = 256;
const MAX_PENDING_CANCEL_REGS = 4096;

// ─── Policy ──────────────────────────────────────────────────────────────

function makeExactAllowlist(allowed: readonly { provider: string; modelId: string }[]): ProviderProxyPolicy {
	return {
		allowed,
		isAllowed(modelRef) {
			return allowed.some((e) => e.provider === modelRef.provider && e.modelId === modelRef.modelId);
		},
	};
}

// ─── JSON safety ──────────────────────────────────────────────────────────

function toSafeAssistantMessage(msg: AssistantMessage): ProxyAssistantMessage {
	return {
		role: "assistant",
		content: msg.content as ProxyContentBlock[],
		stopReason: msg.stopReason,
		responseId: msg.responseId,
		responseModel: msg.responseModel,
	};
}

function redactedErrorFrame(requestId: string, code: string, message: string): ProxyErrorFrame {
	return { type: "error", requestId, stopReason: "error", code, message };
}

function translateEvent(
	requestId: string,
	event: AssistantMessageEvent,
): ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame {
	const base = { type: "streamEvent" as const, requestId };

	switch (event.type) {
		case "start":
			return {
				...base,
				eventType: "start" as const,
				content: event.partial.content as ProxyContentBlock[],
			};

		case "text_start":
			return {
				...base,
				eventType: "text_start" as const,
				contentIndex: event.contentIndex,
				content: event.partial.content as ProxyContentBlock[],
			};
		case "text_delta":
			return { ...base, eventType: "text_delta" as const, contentIndex: event.contentIndex, delta: event.delta };
		case "text_end":
			return {
				...base,
				eventType: "text_end" as const,
				contentIndex: event.contentIndex,
				content: event.partial.content as ProxyContentBlock[],
			};

		case "thinking_start":
			return {
				...base,
				eventType: "thinking_start" as const,
				contentIndex: event.contentIndex,
				content: event.partial.content as ProxyContentBlock[],
			};
		case "thinking_delta":
			return { ...base, eventType: "thinking_delta" as const, contentIndex: event.contentIndex, delta: event.delta };
		case "thinking_end":
			return {
				...base,
				eventType: "thinking_end" as const,
				contentIndex: event.contentIndex,
				content: event.partial.content as ProxyContentBlock[],
			};

		case "toolcall_start":
			return {
				...base,
				eventType: "toolcall_start" as const,
				contentIndex: event.contentIndex,
				content: event.partial.content as ProxyContentBlock[],
			};
		case "toolcall_delta":
			return { ...base, eventType: "toolcall_delta" as const, contentIndex: event.contentIndex, delta: event.delta };
		case "toolcall_end":
			return {
				...base,
				eventType: "toolcall_end" as const,
				contentIndex: event.contentIndex,
				content: event.partial.content as ProxyContentBlock[],
			};

		case "done":
			return {
				...base,
				eventType: "done" as const,
				stopReason: event.reason,
				content: event.message.content as ProxyContentBlock[],
				usage: event.message.usage,
			};

		case "error":
			return {
				...base,
				eventType: "error" as const,
				stopReason: event.reason,
				usage: event.error.usage,
			};
	}
}

// ─── Request validator ────────────────────────────────────────────────────

const KNOWN_MESSAGE_ROLES = new Set(["user", "assistant", "toolResult"]);
const KNOWN_USER_CONTENT_TYPES = new Set(["text", "image"]);
const KNOWN_TOOLRESULT_CONTENT_TYPES = new Set(["text", "image"]);

type ValidationResult = { ok: true } | { ok: false; code: string; message: string };

function ok(): ValidationResult {
	return { ok: true };
}

function err(code: string): ValidationResult {
	return { ok: false, code, message: "Invalid request" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function validateRequest(input: unknown): ValidationResult {
	if (!isRecord(input)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	if (input.type !== "request") return err(PROXY_ERROR_CODES.INVALID_REQUEST);

	// requestId
	const rid = input.requestId;
	if (typeof rid !== "string" || rid.length === 0 || rid.length > MAX_REQUEST_ID_LENGTH) {
		return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}

	// model ref
	const model = input.model;
	if (!isRecord(model)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	const prov = model.provider;
	const mid = model.modelId;
	if (typeof prov !== "string" || prov.length === 0 || prov.length > MAX_PROVIDER_LENGTH) {
		return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}
	if (typeof mid !== "string" || mid.length === 0 || mid.length > MAX_MODEL_ID_LENGTH) {
		return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}

	// context
	const ctx = input.context;
	if (!isRecord(ctx)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);

	// systemPrompt
	const sp = ctx.systemPrompt;
	if (sp !== undefined && (typeof sp !== "string" || sp.length > MAX_SYSTEM_PROMPT_LENGTH)) {
		return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}

	// messages
	const msgs = ctx.messages;
	if (!Array.isArray(msgs) || msgs.length === 0 || msgs.length > MAX_MESSAGES) {
		return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}
	for (const msg of msgs) {
		if (!isRecord(msg)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
		const role = msg.role;
		if (typeof role !== "string" || !KNOWN_MESSAGE_ROLES.has(role)) {
			return err(PROXY_ERROR_CODES.INVALID_REQUEST);
		}

		if (role === "user") {
			const ts = msg.timestamp;
			if (!isFiniteNumber(ts) || ts <= 0) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			const content = msg.content;
			if (typeof content === "string") continue;
			if (!Array.isArray(content)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			for (const block of content) {
				if (!isRecord(block)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				const bt = block.type;
				if (typeof bt !== "string" || !KNOWN_USER_CONTENT_TYPES.has(bt)) {
					return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				}
				if (bt === "text" && typeof block.text !== "string") return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				if (bt === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) {
					return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				}
			}
			continue;
		}

		if (role === "toolResult") {
			const ts = msg.timestamp;
			if (!isFiniteNumber(ts) || ts <= 0) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			if (typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0)
				return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			if (typeof msg.toolName !== "string" || msg.toolName.length === 0)
				return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			if (typeof msg.isError !== "boolean") return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			const content = msg.content;
			if (!Array.isArray(content)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			for (const block of content) {
				if (!isRecord(block)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				const bt = block.type;
				if (typeof bt !== "string" || !KNOWN_TOOLRESULT_CONTENT_TYPES.has(bt)) {
					return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				}
				if (bt === "text" && typeof block.text !== "string") return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				if (bt === "image" && (typeof block.data !== "string" || typeof block.mimeType !== "string")) {
					return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				}
			}
			continue;
		}

		if (role === "assistant") {
			const content = msg.content;
			if (!Array.isArray(content)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
			for (const block of content) {
				if (!isRecord(block)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				// Only text, thinking, toolCall are valid assistant content blocks
				if (block.type === "text") {
					if (typeof block.text !== "string") return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				} else if (block.type === "thinking") {
					if (typeof block.thinking !== "string") return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				} else if (block.type === "toolCall") {
					if (typeof block.id !== "string" || typeof block.name !== "string") {
						return err(PROXY_ERROR_CODES.INVALID_REQUEST);
					}
					if (typeof block.arguments !== "object" || block.arguments === null) {
						return err(PROXY_ERROR_CODES.INVALID_REQUEST);
					}
				} else {
					return err(PROXY_ERROR_CODES.INVALID_REQUEST);
				}
			}
			// stopReason must be present on assistant messages
			if (typeof msg.stopReason !== "string") return err(PROXY_ERROR_CODES.INVALID_REQUEST);
		}
	}

	// tools
	const tools = ctx.tools;
	if (tools !== undefined) {
		if (!Array.isArray(tools) || tools.length > MAX_TOOLS) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}

	// options -- must be a record; empty {} is valid
	const opts = input.options;
	if (!isRecord(opts)) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	for (const key of Object.keys(opts)) {
		if (!ALLOWED_OPTION_KEYS.has(key)) return err(PROXY_ERROR_CODES.UNKNOWN_OPTION);
	}
	const temp = opts.temperature;
	if (temp !== undefined) {
		if (!isFiniteNumber(temp) || temp < 0 || temp > 2) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}
	const mt = opts.maxTokens;
	if (mt !== undefined) {
		if (!isFiniteNumber(mt) || mt < 1 || mt > 2_000_000) return err(PROXY_ERROR_CODES.INVALID_REQUEST);
	}

	return ok();
}

// ─── HomeProviderProxy ────────────────────────────────────────────────────

/** Module-private branding: only the constructor adds instances. */
const homeProviderProxyBrand = new WeakSet<object>();

export class HomeProviderProxy {
	private config: HomeProviderProxyConfig;
	private activeStreams: Map<string, AbortController> = new Map();
	private pendingCancel: Map<string, true> = new Map();

	constructor(config: HomeProviderProxyConfig) {
		homeProviderProxyBrand.add(this);
		this.config = config;
	}

	async *stream(request: ProxyRequestFrame): ProxyStreamOutput {
		const { requestId } = request;

		const vr = validateRequest(request);
		if (!vr.ok) {
			yield redactedErrorFrame(requestId, vr.code, vr.message);
			return;
		}

		try {
			// Check pending cancel before any real work.
			if (this.pendingCancel.delete(requestId)) {
				yield {
					type: "error",
					requestId,
					stopReason: "aborted",
					code: PROXY_ERROR_CODES.REQUEST_CANCELLED,
					message: "Request was cancelled before streaming began",
				};
				return;
			}

			// Policy check -- exact provider+modelId allowlist.
			if (!this.config.policy.isAllowed(request.model)) {
				yield redactedErrorFrame(
					requestId,
					PROXY_ERROR_CODES.POLICY_DENIED,
					"Requested provider/model is not allowed by proxy policy",
				);
				return;
			}

			// Resolve the real Model object (never serialized or sent out).
			const model = this.config.modelLookup.findModel(request.model.provider, request.model.modelId);
			if (!model) {
				yield redactedErrorFrame(
					requestId,
					PROXY_ERROR_CODES.MODEL_NOT_FOUND,
					"Requested model was not found in the model registry",
				);
				return;
			}

			// Guard against duplicate requestId.
			if (this.activeStreams.has(requestId)) {
				yield redactedErrorFrame(
					requestId,
					PROXY_ERROR_CODES.DUPLICATE_REQUEST,
					"A request with this ID is already active",
				);
				return;
			}

			const abortController = new AbortController();

			// Re-check pending cancel (race with cancel()).
			if (this.pendingCancel.delete(requestId)) {
				yield {
					type: "error",
					requestId,
					stopReason: "aborted",
					code: PROXY_ERROR_CODES.REQUEST_CANCELLED,
					message: "Request was cancelled before streaming began",
				};
				return;
			}

			this.activeStreams.set(requestId, abortController);

			try {
				// Build safe stream options.
				const streamOptions: SimpleStreamOptions = { signal: abortController.signal };
				const { options } = request;
				if (options.temperature !== undefined) streamOptions.temperature = options.temperature;
				if (options.maxTokens !== undefined) streamOptions.maxTokens = options.maxTokens;
				if (options.reasoning !== undefined) streamOptions.reasoning = options.reasoning;
				if (options.cacheRetention !== undefined) streamOptions.cacheRetention = options.cacheRetention;
				if (options.sessionId !== undefined) streamOptions.sessionId = options.sessionId;
				if (options.transport !== undefined) streamOptions.transport = options.transport;
				if (options.serviceTier !== undefined) streamOptions.serviceTier = options.serviceTier;
				if (options.thinkingBudgets !== undefined) streamOptions.thinkingBudgets = options.thinkingBudgets;

				const llmContext: Context = {
					systemPrompt: request.context.systemPrompt,
					messages: request.context.messages as Message[],
					tools: request.context.tools,
				};

				// Await because StreamFn can return Promise<AssistantMessageEventStream>.
				const llmStream = await this.config.streamFn(model, llmContext, streamOptions);

				for await (const event of llmStream) {
					if (event.type === "done") {
						yield {
							type: "completion",
							requestId,
							message: toSafeAssistantMessage(event.message),
							usage: event.message.usage,
						} satisfies ProxyCompletionFrame;
						return;
					}

					if (event.type === "error") {
						yield {
							type: "error",
							requestId,
							stopReason: event.reason,
							code:
								event.reason === "aborted" ? PROXY_ERROR_CODES.STREAM_ABORTED : PROXY_ERROR_CODES.STREAM_FAILED,
							message: ERROR_REDACTED_MSG,
						} satisfies ProxyErrorFrame;
						return;
					}

					yield translateEvent(requestId, event) as ProxyStreamEventFrame;
				}

				yield redactedErrorFrame(
					requestId,
					PROXY_ERROR_CODES.STREAM_FAILED,
					"Stream ended without a terminal event",
				);
			} finally {
				this.activeStreams.delete(requestId);
				this.pendingCancel.delete(requestId);
			}
		} catch (_error) {
			// Any throw from policy, lookup, streamFn, or iteration yields a redacted error.
			this.activeStreams.delete(requestId);
			this.pendingCancel.delete(requestId);
			yield {
				type: "error",
				requestId,
				stopReason: "error",
				code: PROXY_ERROR_CODES.STREAM_FAILED,
				message: ERROR_REDACTED_MSG,
			} satisfies ProxyErrorFrame;
			return;
		}
	}

	cancel(requestId: string): void {
		const ac = this.activeStreams.get(requestId);
		if (ac) {
			ac.abort();
		} else if (this.pendingCancel.size < MAX_PENDING_CANCEL_REGS) {
			// Request hasn't started yet -- mark for immediate rejection.
			this.pendingCancel.set(requestId, true);
		}
		// Silently drop when the set is full to avoid unbounded memory growth.
	}

	get activeRequestCount(): number {
		return this.activeStreams.size;
	}

	clearPendingCancels(): void {
		this.pendingCancel.clear();
	}
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function isHomeProviderProxyInstance(value: unknown): value is HomeProviderProxy {
	return typeof value === "object" && value !== null && !Array.isArray(value) && homeProviderProxyBrand.has(value);
}

export function createExactAllowlistPolicy(
	allowed: readonly { provider: string; modelId: string }[],
): ProviderProxyPolicy {
	return makeExactAllowlist(allowed);
}
