/**
 * B05 home-provider proxy types.
 *
 * Serializable frame protocol for proxying LLM provider requests across a
 * process boundary. Every frame type is JSON-serializable and carries no
 * credentials, Model objects, base URLs, OAuth tokens, or raw API keys.
 */

import type { StreamFn } from "@earendil-works/pi-agent-core";
import type {
	Api,
	CacheRetention,
	Model,
	ModelThinkingLevel,
	ServiceTier,
	StopReason,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Transport,
	Usage,
} from "@earendil-works/pi-ai";

export interface ProxyModelRef {
	provider: string;
	modelId: string;
}

export type ProxyContentBlock = TextContent | ThinkingContent | ToolCall;

export interface ProxyAssistantMessage {
	role: "assistant";
	content: ProxyContentBlock[];
	stopReason: StopReason;
	responseId?: string;
	responseModel?: string;
}

export interface ProxyTextBlock {
	type: "text";
	text: string;
}

export interface ProxyImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export type ProxyUserContentBlock = ProxyTextBlock | ProxyImageBlock;

export interface ProxyUserMessage {
	role: "user";
	content: ProxyUserContentBlock[] | string;
	timestamp: number;
}

export type ProxyToolResultContentBlock = ProxyTextBlock | ProxyImageBlock;

export interface ProxyToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: ProxyToolResultContentBlock[];
	isError: boolean;
	timestamp: number;
}

export type ProxyRequestMessage = ProxyUserMessage | ProxyToolResultMessage | ProxyAssistantMessage;

export interface ProxyContext {
	systemPrompt?: string;
	messages: ProxyRequestMessage[];
	tools?: Tool[];
}

export interface ProxyRequestOptions {
	temperature?: number;
	maxTokens?: number;
	reasoning?: ModelThinkingLevel;
	cacheRetention?: CacheRetention;
	sessionId?: string;
	transport?: Transport;
	serviceTier?: ServiceTier;
	thinkingBudgets?: {
		minimal?: number;
		high?: number;
		low?: number;
		medium?: number;
	};
}

export interface ProxyStreamStartFrame {
	type: "streamEvent";
	eventType: "start";
	requestId: string;
	content: ProxyContentBlock[];
}

export interface ProxyStreamTextStartFrame {
	type: "streamEvent";
	eventType: "text_start" | "text_end";
	requestId: string;
	contentIndex: number;
	content: ProxyContentBlock[];
}

export interface ProxyStreamTextDeltaFrame {
	type: "streamEvent";
	eventType: "text_delta";
	requestId: string;
	contentIndex: number;
	delta: string;
}

export interface ProxyStreamThinkingStartFrame {
	type: "streamEvent";
	eventType: "thinking_start" | "thinking_end";
	requestId: string;
	contentIndex: number;
	content: ProxyContentBlock[];
}

export interface ProxyStreamThinkingDeltaFrame {
	type: "streamEvent";
	eventType: "thinking_delta";
	requestId: string;
	contentIndex: number;
	delta: string;
}

export interface ProxyStreamToolCallStartFrame {
	type: "streamEvent";
	eventType: "toolcall_start" | "toolcall_end";
	requestId: string;
	contentIndex: number;
	content: ProxyContentBlock[];
}

export interface ProxyStreamToolCallDeltaFrame {
	type: "streamEvent";
	eventType: "toolcall_delta";
	requestId: string;
	contentIndex: number;
	delta: string;
}

export interface ProxyStreamDoneFrame {
	type: "streamEvent";
	eventType: "done";
	requestId: string;
	stopReason: "stop" | "length" | "toolUse";
	content: ProxyContentBlock[];
	usage: Usage;
}

export interface ProxyStreamErrorEventFrame {
	type: "streamEvent";
	eventType: "error";
	requestId: string;
	stopReason: "error" | "aborted";
	usage?: Usage;
}

export type ProxyStreamEventFrame =
	| ProxyStreamStartFrame
	| ProxyStreamTextStartFrame
	| ProxyStreamTextDeltaFrame
	| ProxyStreamThinkingStartFrame
	| ProxyStreamThinkingDeltaFrame
	| ProxyStreamToolCallStartFrame
	| ProxyStreamToolCallDeltaFrame
	| ProxyStreamDoneFrame
	| ProxyStreamErrorEventFrame;

export interface ProxyCancelFrame {
	type: "cancel";
	requestId: string;
}

export interface ProxyCompletionFrame {
	type: "completion";
	requestId: string;
	message: ProxyAssistantMessage;
	usage: Usage;
}

export interface ProxyErrorFrame {
	type: "error";
	requestId: string;
	stopReason: "error" | "aborted";
	code: string;
	message: string;
}

export type ProxyFrame =
	| ProxyRequestFrame
	| ProxyStreamEventFrame
	| ProxyCancelFrame
	| ProxyCompletionFrame
	| ProxyErrorFrame;

export interface ProxyRequestFrame {
	type: "request";
	requestId: string;
	model: ProxyModelRef;
	context: ProxyContext;
	options: ProxyRequestOptions;
}

export interface ModelAllowEntry {
	provider: string;
	modelId: string;
}

export interface ProviderProxyPolicy {
	allowed: readonly ModelAllowEntry[];
	isAllowed(modelRef: ProxyModelRef): boolean;
}

export interface ModelLookup {
	findModel(provider: string, modelId: string): Model<Api> | undefined;
}

export interface HomeProviderProxyConfig {
	streamFn: StreamFn;
	modelLookup: ModelLookup;
	policy: ProviderProxyPolicy;
}

export type ProxyStreamOutput = AsyncGenerator<
	ProxyStreamEventFrame | ProxyCompletionFrame | ProxyErrorFrame,
	void,
	unknown
>;

export const PROXY_ERROR_CODES = {
	POLICY_DENIED: "POLICY_DENIED",
	MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
	STREAM_FAILED: "STREAM_FAILED",
	DUPLICATE_REQUEST: "DUPLICATE_REQUEST",
	STREAM_ABORTED: "STREAM_ABORTED",
	UNKNOWN_OPTION: "UNKNOWN_OPTION",
	INVALID_REQUEST: "INVALID_REQUEST",
	REQUEST_CANCELLED: "REQUEST_CANCELLED",
} as const;
