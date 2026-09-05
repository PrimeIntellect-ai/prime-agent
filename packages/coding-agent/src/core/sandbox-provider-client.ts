/**
 * B14a sandbox-side provider proxy client.
 *
 * Transport-neutral adapter that converts model stream requests into the typed
 * ProxyFrame protocol, correlates chunks/completion/errors by requestId,
 * handles cancellation and disconnect. Never receives credentials, base URLs,
 * or headers -- all auth lives on the home side.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, parseStreamingJson } from "@earendil-works/pi-ai";
import { v4 as uuidv4 } from "uuid";
import type {
	ProxyCancelFrame,
	ProxyRequestFrame,
	ProxyRequestMessage,
	ProxyToolResultContentBlock,
	ProxyUserContentBlock,
} from "./home-provider-proxy-types.js";
import type { FrameTransport, ModelLookup, SandboxProviderClientConfig } from "./sandbox-provider-client-types.js";

// ─── Constants ────────────────────────────────────────────────────────────

const MAX_REQUEST_ID_LENGTH = 256;
const MAX_DELTA_LENGTH = 1_000_000;
const MAX_CONTENT_BLOCKS = 256;
const _ERROR_REDACTED_MSG = "An internal provider error occurred";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// ─── Validation predicates ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function _isValidStopReason(value: unknown): value is StopReason {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function isValidDoneReason(value: unknown): value is "stop" | "length" | "toolUse" {
	return value === "stop" || value === "length" || value === "toolUse";
}

function isValidErrorReason(value: unknown): value is "error" | "aborted" {
	return value === "error" || value === "aborted";
}

function isValidContentIndex(value: unknown): value is number {
	return isFiniteNonNegative(value) && Number.isInteger(value) && value < MAX_CONTENT_BLOCKS;
}

function isValidDelta(value: unknown): value is string {
	return typeof value === "string" && value.length <= MAX_DELTA_LENGTH;
}

function _isValidCostEntry(value: unknown): value is number {
	return isFiniteNonNegative(value);
}

function isValidUsage(value: unknown): value is Usage {
	if (!isRecord(value)) return false;
	if (!isFiniteNonNegative(value.totalTokens)) return false;
	if (!isFiniteNonNegative(value.input)) return false;
	if (!isFiniteNonNegative(value.output)) return false;
	if (!isFiniteNonNegative(value.cacheRead)) return false;
	if (!isFiniteNonNegative(value.cacheWrite)) return false;
	// Validate nested cost object
	const cost = value.cost;
	if (!isRecord(cost)) return false;
	if (!isFiniteNonNegative(cost.input)) return false;
	if (!isFiniteNonNegative(cost.output)) return false;
	if (!isFiniteNonNegative(cost.cacheRead)) return false;
	if (!isFiniteNonNegative(cost.cacheWrite)) return false;
	if (!isFiniteNonNegative(cost.total)) return false;
	return true;
}

function isValidContentBlock(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const t = value.type;
	if (t === "text" && typeof value.text === "string") return true;
	if (t === "thinking" && typeof value.thinking === "string") return true;
	if (t === "toolCall" && typeof value.id === "string" && typeof value.name === "string") return true;
	return false;
}

function isValidContentBlockArray(value: unknown): value is unknown[] {
	if (!Array.isArray(value)) return false;
	if (value.length > MAX_CONTENT_BLOCKS) return false;
	for (const b of value) {
		if (!isValidContentBlock(b)) return false;
	}
	return true;
}

// ─── Message conversion ──────────────────────────────────────────────────

function convertMessageToProxy(msg: Message): ProxyRequestMessage {
	if (msg.role === "user") {
		if (typeof msg.content === "string") {
			return { role: "user", content: msg.content, timestamp: msg.timestamp };
		}
		const blocks: ProxyUserContentBlock[] = msg.content.map((b) => {
			if (b.type === "image") {
				return { type: "image", data: b.data, mimeType: b.mimeType };
			}
			return { type: "text", text: b.text };
		});
		return { role: "user", content: blocks, timestamp: msg.timestamp };
	}

	if (msg.role === "toolResult") {
		const blocks: ProxyToolResultContentBlock[] = msg.content.map((b) => {
			if (b.type === "image") {
				return { type: "image", data: b.data, mimeType: b.mimeType };
			}
			return { type: "text", text: b.text };
		});
		return {
			role: "toolResult",
			toolCallId: msg.toolCallId,
			toolName: msg.toolName,
			content: blocks,
			isError: msg.isError,
			timestamp: msg.timestamp,
		};
	}

	if (msg.role === "assistant") {
		return {
			role: "assistant",
			content: msg.content,
			stopReason: msg.stopReason,
			responseId: msg.responseId,
			responseModel: msg.responseModel,
		};
	}

	// Unsupported message type -- fail with stable local error
	throw new Error("Unsupported message role");
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeEmptyAssistantMessage(
	api: Api,
	provider: string,
	modelId: string,
	stopReason: StopReason,
): AssistantMessage {
	return {
		role: "assistant",
		stopReason,
		content: [],
		api,
		provider,
		model: modelId,
		usage: { ...EMPTY_USAGE },
		timestamp: Date.now(),
	};
}

// ─── Stream entry ─────────────────────────────────────────────────────────

interface StreamEntry {
	requestId: string;
	eventStream: AssistantMessageEventStream;
	partial: AssistantMessage;
	finished: boolean;
	/** Cleanup function for the external AbortSignal listener */
	cleanupSignal?: () => void;
}

// ─── SandboxProviderClient ────────────────────────────────────────────────

export class SandboxProviderClient {
	private transport: FrameTransport;
	private modelLookup: ModelLookup | null;
	private activeStreams: Map<string, StreamEntry> = new Map();
	private disconnected = false;
	private unsubHandleFrame: (() => void) | null = null;

	constructor(config: SandboxProviderClientConfig) {
		this.transport = config.transport;
		this.modelLookup = config.modelLookup;

		this.unsubHandleFrame = this.transport.onFrame((raw: unknown) => {
			this.processFrame(raw);
		});
	}

	// ── Frame dispatch ────────────────────────────────────────────────────

	private processFrame(raw: unknown): void {
		if (this.disconnected) return;

		// Extract bounded requestId safely before any validation
		let requestId = "";
		if (isRecord(raw) && typeof raw.requestId === "string" && raw.requestId.length > 0) {
			requestId = raw.requestId.slice(0, MAX_REQUEST_ID_LENGTH);
		}
		if (!requestId) return; // No requestId to route to -- silently drop

		const entry = this.activeStreams.get(requestId);
		if (!entry || entry.finished) return;

		// Validate frame type -- only known types
		if (!isRecord(raw) || typeof raw.type !== "string") {
			this.failEntry(entry, "error");
			return;
		}

		switch (raw.type) {
			case "streamEvent":
				this.processStreamEvent(raw, entry);
				break;
			case "completion":
				this.processCompletion(raw, entry);
				break;
			case "error":
				this.processError(raw, entry);
				break;
			case "cancel":
				// Cancel frames are outbound-only from the sandbox side
				break;
			default:
				// Unknown frame type -- terminal error on this stream
				this.failEntry(entry, "error");
				break;
		}
	}

	// ── failEntry: push redacted error terminal then finish ───────────────

	private failEntry(entry: StreamEntry, reason: "error" | "aborted"): void {
		if (entry.finished) return;
		entry.partial.stopReason = reason;
		entry.eventStream.push({
			type: "error",
			reason,
			error: entry.partial,
		});
		this.finishEntry(entry);
	}

	// ── Stream event processing ───────────────────────────────────────────

	private processStreamEvent(raw: Record<string, unknown>, entry: StreamEntry): void {
		// Validate required fields
		if (typeof raw.eventType !== "string") {
			this.failEntry(entry, "error");
			return;
		}

		const event = this.convertStreamEvent(raw, entry.partial);
		if (!event) {
			this.failEntry(entry, "error");
			return;
		}

		entry.eventStream.push(event);

		if (event.type === "done" || event.type === "error") {
			this.finishEntry(entry);
		}
	}

	private processCompletion(raw: Record<string, unknown>, entry: StreamEntry): void {
		// Validate completion-specific fields
		const message = raw.message;
		if (!isRecord(message)) {
			this.failEntry(entry, "error");
			return;
		}
		const stopReason = message.stopReason;
		if (!isValidDoneReason(stopReason)) {
			this.failEntry(entry, "error");
			return;
		}
		// Require valid content and usage in every completion
		if (!isValidContentBlockArray(message.content)) {
			this.failEntry(entry, "error");
			return;
		}
		const usage = raw.usage;
		if (!usage || !isValidUsage(usage)) {
			this.failEntry(entry, "error");
			return;
		}

		const msg = entry.partial;
		msg.content = message.content as AssistantMessage["content"];
		msg.usage = { ...EMPTY_USAGE, ...(usage as Usage) };
		msg.stopReason = stopReason as StopReason;

		entry.eventStream.push({
			type: "done",
			reason: stopReason as "stop" | "length" | "toolUse",
			message: msg,
		});
		this.finishEntry(entry);
	}

	private processError(raw: Record<string, unknown>, entry: StreamEntry): void {
		// processError must accept only error/aborted reasons
		const stopReason = raw.stopReason;
		if (!isValidErrorReason(stopReason)) {
			this.failEntry(entry, "error");
			return;
		}
		if (typeof raw.code !== "string" || raw.code.length > 128) {
			this.failEntry(entry, "error");
			return;
		}

		entry.partial.stopReason = stopReason as StopReason;
		entry.eventStream.push({
			type: "error",
			reason: stopReason as "error" | "aborted",
			error: entry.partial,
		});
		this.finishEntry(entry);
	}

	// ── Unified finish (exactly once per entry) ───────────────────────────

	private finishEntry(entry: StreamEntry): void {
		if (entry.finished) return;
		entry.finished = true;

		this.activeStreams.delete(entry.requestId);

		if (entry.cleanupSignal) {
			entry.cleanupSignal();
			entry.cleanupSignal = undefined;
		}

		entry.eventStream.end();
	}

	// ── Stream event conversion ───────────────────────────────────────────

	private convertStreamEvent(
		raw: Record<string, unknown>,
		partial: AssistantMessage,
	): AssistantMessageEvent | undefined {
		const eventType = raw.eventType as string;

		switch (eventType) {
			case "start": {
				// Validate content array before cast
				const content = raw.content;
				if (!isValidContentBlockArray(content)) return undefined;
				partial.content = content as AssistantMessage["content"];
				return { type: "start", partial };
			}

			case "text_start": {
				const contentIndex = raw.contentIndex;
				if (!isValidContentIndex(contentIndex)) return undefined;
				const content = raw.content;
				if (
					isValidContentBlockArray(content) &&
					isValidContentBlock(content[contentIndex]) &&
					(content[contentIndex] as Record<string, unknown>).type === "text"
				) {
					partial.content[contentIndex] = content[contentIndex] as TextContent;
				} else {
					partial.content[contentIndex] = { type: "text", text: "" };
				}
				return { type: "text_start", contentIndex, partial };
			}
			case "text_delta": {
				const contentIndex = raw.contentIndex;
				const delta = raw.delta;
				if (!isValidContentIndex(contentIndex) || !isValidDelta(delta)) return undefined;
				const block = partial.content[contentIndex];
				if (block?.type === "text") {
					block.text += delta;
					return { type: "text_delta", contentIndex, delta, partial };
				}
				return undefined;
			}
			case "text_end": {
				const contentIndex = raw.contentIndex;
				if (!isValidContentIndex(contentIndex)) return undefined;
				const content = raw.content;
				if (
					isValidContentBlockArray(content) &&
					isValidContentBlock(content[contentIndex]) &&
					(content[contentIndex] as Record<string, unknown>).type === "text"
				) {
					partial.content[contentIndex] = content[contentIndex] as TextContent;
				}
				const block = partial.content[contentIndex];
				if (block?.type === "text") {
					return { type: "text_end", contentIndex, content: block.text, partial };
				}
				return undefined;
			}

			case "thinking_start": {
				const contentIndex = raw.contentIndex;
				if (!isValidContentIndex(contentIndex)) return undefined;
				const content = raw.content;
				if (
					isValidContentBlockArray(content) &&
					isValidContentBlock(content[contentIndex]) &&
					(content[contentIndex] as Record<string, unknown>).type === "thinking"
				) {
					partial.content[contentIndex] = content[contentIndex] as ThinkingContent;
				} else {
					partial.content[contentIndex] = { type: "thinking", thinking: "" };
				}
				return { type: "thinking_start", contentIndex, partial };
			}
			case "thinking_delta": {
				const contentIndex = raw.contentIndex;
				const delta = raw.delta;
				if (!isValidContentIndex(contentIndex) || !isValidDelta(delta)) return undefined;
				const block = partial.content[contentIndex];
				if (block?.type === "thinking") {
					block.thinking += delta;
					return { type: "thinking_delta", contentIndex, delta, partial };
				}
				return undefined;
			}
			case "thinking_end": {
				const contentIndex = raw.contentIndex;
				if (!isValidContentIndex(contentIndex)) return undefined;
				const content = raw.content;
				if (
					isValidContentBlockArray(content) &&
					isValidContentBlock(content[contentIndex]) &&
					(content[contentIndex] as Record<string, unknown>).type === "thinking"
				) {
					partial.content[contentIndex] = content[contentIndex] as ThinkingContent;
				}
				const block = partial.content[contentIndex];
				if (block?.type === "thinking") {
					return { type: "thinking_end", contentIndex, content: block.thinking, partial };
				}
				return undefined;
			}

			case "toolcall_start": {
				const contentIndex = raw.contentIndex;
				if (!isValidContentIndex(contentIndex)) return undefined;
				const content = raw.content;
				const srcBlock =
					isValidContentBlockArray(content) &&
					isValidContentBlock(content[contentIndex]) &&
					(content[contentIndex] as Record<string, unknown>).type === "toolCall"
						? content[contentIndex]
						: null;
				partial.content[contentIndex] = {
					type: "toolCall",
					id: (srcBlock as { id?: string })?.id ?? "",
					name: (srcBlock as { name?: string })?.name ?? "",
					arguments: {},
				} satisfies ToolCall;
				return { type: "toolcall_start", contentIndex, partial };
			}
			case "toolcall_delta": {
				const contentIndex = raw.contentIndex;
				const delta = raw.delta;
				if (!isValidContentIndex(contentIndex) || !isValidDelta(delta)) return undefined;
				const block = partial.content[contentIndex];
				if (block?.type === "toolCall") {
					const stash = getToolCallStash(block);
					stash.partialJson = (stash.partialJson ?? "") + delta;
					block.arguments = parseStreamingJson(stash.partialJson);
					return { type: "toolcall_delta", contentIndex, delta, partial };
				}
				return undefined;
			}
			case "toolcall_end": {
				const contentIndex = raw.contentIndex;
				if (!isValidContentIndex(contentIndex)) return undefined;
				const block = partial.content[contentIndex];
				if (block?.type === "toolCall") {
					const stash = getToolCallStash(block);
					delete stash.partialJson;
					return { type: "toolcall_end", contentIndex, toolCall: block, partial };
				}
				return undefined;
			}

			case "done": {
				const stopReason = raw.stopReason;
				if (!isValidDoneReason(stopReason)) return undefined;
				const content = raw.content;
				if (!isValidContentBlockArray(content)) return undefined;
				partial.content = content as AssistantMessage["content"];
				const usage = raw.usage;
				if (usage && isValidUsage(usage)) {
					partial.usage = { ...partial.usage, ...(usage as Usage) };
				}
				partial.stopReason = stopReason as StopReason;
				return { type: "done", reason: stopReason as "stop" | "length" | "toolUse", message: partial };
			}
			case "error": {
				const stopReason = raw.stopReason;
				if (!isValidErrorReason(stopReason)) return undefined;
				const usage = raw.usage;
				if (usage && isValidUsage(usage)) {
					partial.usage = { ...partial.usage, ...(usage as Usage) };
				}
				partial.stopReason = stopReason as StopReason;
				return { type: "error", reason: stopReason as "error" | "aborted", error: partial };
			}
		}
	}

	// ── Public API ────────────────────────────────────────────────────────

	stream(
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions & { signal?: AbortSignal },
	): AssistantMessageEventStream {
		const requestId = `sandbox-${uuidv4()}`;

		if (options?.signal?.aborted) {
			const errStream = createAssistantMessageEventStream();
			setTimeout(() => {
				errStream.push({
					type: "error",
					reason: "aborted",
					error: makeEmptyAssistantMessage(model.api, model.provider, model.id, "aborted"),
				});
				errStream.end();
			}, 0);
			return errStream;
		}

		if (this.disconnected) {
			const errStream = createAssistantMessageEventStream();
			setTimeout(() => {
				errStream.push({
					type: "error",
					reason: "error",
					error: makeEmptyAssistantMessage(model.api, model.provider, model.id, "error"),
				});
				errStream.end();
			}, 0);
			return errStream;
		}

		if (this.modelLookup) {
			const admitted = this.modelLookup.findModel(model.provider, model.id);
			if (!admitted) {
				const errStream = createAssistantMessageEventStream();
				setTimeout(() => {
					errStream.push({
						type: "error",
						reason: "error",
						error: makeEmptyAssistantMessage(model.api, model.provider, model.id, "error"),
					});
					errStream.end();
				}, 0);
				return errStream;
			}
		}

		// Convert context messages before registering the entry
		let proxyMessages: ProxyRequestMessage[];
		try {
			proxyMessages = context.messages.map(convertMessageToProxy);
		} catch {
			const errStream = createAssistantMessageEventStream();
			setTimeout(() => {
				errStream.push({
					type: "error",
					reason: "error",
					error: makeEmptyAssistantMessage(model.api, model.provider, model.id, "error"),
				});
				errStream.end();
			}, 0);
			return errStream;
		}

		const partial = makeEmptyAssistantMessage(model.api, model.provider, model.id, "stop");
		const eventStream = createAssistantMessageEventStream();

		const entry: StreamEntry = {
			requestId,
			eventStream,
			partial,
			finished: false,
		};

		if (options?.signal) {
			const abortListener = () => this.cancel(requestId);
			options.signal.addEventListener("abort", abortListener, { once: true });
			entry.cleanupSignal = () => {
				try {
					options.signal?.removeEventListener("abort", abortListener);
				} catch {
					/* ignore */
				}
			};
		}

		this.activeStreams.set(requestId, entry);

		const requestFrame: ProxyRequestFrame = {
			type: "request",
			requestId,
			model: { provider: model.provider, modelId: model.id },
			context: {
				systemPrompt: context.systemPrompt,
				messages: proxyMessages,
				tools: Array.isArray(context.tools) ? context.tools : undefined,
			},
			options: {
				temperature: options?.temperature,
				maxTokens: options?.maxTokens,
				reasoning: options?.reasoning,
				cacheRetention: options?.cacheRetention,
				sessionId: options?.sessionId,
				transport: options?.transport,
				serviceTier: options?.serviceTier,
				thinkingBudgets: options?.thinkingBudgets,
			},
		};

		try {
			this.transport.send(requestFrame);
		} catch {
			entry.partial.stopReason = "error";
			entry.eventStream.push({
				type: "error",
				reason: "error",
				error: entry.partial,
			});
			this.finishEntry(entry);
			return entry.eventStream;
		}

		return eventStream;
	}

	/**
	 * Cancel a specific request by requestId.
	 * Sends a cancel frame exactly once only for active entries.
	 */
	cancel(requestId: string): void {
		const entry = this.activeStreams.get(requestId);
		if (!entry || entry.finished) return;

		try {
			this.transport.send({
				type: "cancel",
				requestId,
			} satisfies ProxyCancelFrame);
		} catch {
			// Transport may already be closed
		}

		entry.partial.stopReason = "aborted";
		entry.eventStream.push({
			type: "error",
			reason: "aborted",
			error: entry.partial,
		});
		this.finishEntry(entry);
	}

	/**
	 * Disconnect the client, terminating all active streams.
	 */
	disconnect(): void {
		this.disconnected = true;

		if (this.unsubHandleFrame) {
			this.unsubHandleFrame();
			this.unsubHandleFrame = null;
		}

		// Snapshot entries before iterating since finishEntry deletes from the map
		const entries = [...this.activeStreams.values()];
		for (const entry of entries) {
			if (!entry.finished) {
				entry.partial.stopReason = "aborted";
				entry.eventStream.push({
					type: "error",
					reason: "aborted",
					error: entry.partial,
				});
				this.finishEntry(entry);
			}
		}

		this.activeStreams.clear();

		try {
			this.transport.close();
		} catch {
			// Ignore close errors
		}
	}

	asStreamFn(): StreamFn {
		return (model: Model<Api>, context: Context, options?: SimpleStreamOptions & { signal?: AbortSignal }) => {
			return this.stream(model, context, options);
		};
	}

	get activeRequestCount(): number {
		return this.activeStreams.size;
	}
}

// ─── Separate tool-call stash ────────────────────────────────────────────

const TOOL_CALL_STASH = new WeakMap<object, { partialJson?: string }>();

function getToolCallStash(block: object): { partialJson?: string } {
	let stash = TOOL_CALL_STASH.get(block);
	if (!stash) {
		stash = {};
		TOOL_CALL_STASH.set(block, stash);
	}
	return stash;
}
