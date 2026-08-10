import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createStreamingJsonParseState,
	type StreamingJsonParseState,
} from "@earendil-works/pi-ai";
import type { DaemonEventMeta, DaemonOutbound } from "./daemon-protocol.js";

type SessionEvent = Extract<DaemonOutbound, { type: "session_event" }>["event"];
type MessageUpdateEvent = Extract<SessionEvent, { type: "message_update" }>;
type WithoutPartial<T> = T extends { partial: AssistantMessage } ? Omit<T, "partial"> : T;
type CompactAssistantMessageEvent = WithoutPartial<MessageUpdateEvent["assistantMessageEvent"]>;

export interface CompactAssistantDelta {
	type: "assistant_stream_delta";
	activeSessionId: string;
	assistantMessageEvent: CompactAssistantMessageEvent;
	contentStart?: AssistantMessage["content"][number];
	toolCallArguments?: Record<string, unknown>;
	meta?: DaemonEventMeta;
}

export function createCompactAssistantDelta(message: DaemonOutbound): CompactAssistantDelta | undefined {
	if (message.type !== "session_event" || message.event.type !== "message_update") {
		return undefined;
	}
	if (message.event.message.role !== "assistant") {
		return undefined;
	}
	const { partial: _partial, ...assistantMessageEvent } = message.event
		.assistantMessageEvent as AssistantMessageEvent & {
		partial?: AssistantMessage;
	};
	const contentStart = compactContentStart(message.event.message, assistantMessageEvent);
	const toolCallArguments = compactToolCallArguments(message.event.message, assistantMessageEvent);
	return {
		type: "assistant_stream_delta",
		activeSessionId: message.activeSessionId,
		assistantMessageEvent: assistantMessageEvent as CompactAssistantMessageEvent,
		...(contentStart ? { contentStart } : {}),
		...(toolCallArguments ? { toolCallArguments } : {}),
		...(message.meta ? { meta: message.meta } : {}),
	};
}

function compactToolCallArguments(
	message: AssistantMessage,
	event: CompactAssistantMessageEvent,
): Record<string, unknown> | undefined {
	if (event.type !== "toolcall_delta") {
		return undefined;
	}
	const content = message.content[event.contentIndex];
	return content?.type === "toolCall" ? content.arguments : undefined;
}

function compactContentStart(
	message: AssistantMessage,
	event: CompactAssistantMessageEvent,
): AssistantMessage["content"][number] | undefined {
	if (event.type !== "text_start" && event.type !== "thinking_start" && event.type !== "toolcall_start") {
		return undefined;
	}
	const content = message.content[event.contentIndex];
	if (event.type === "text_start" && content?.type === "text") {
		return { ...content, text: "" };
	}
	if (event.type === "thinking_start" && content?.type === "thinking") {
		return { ...content, thinking: "" };
	}
	if (event.type === "toolcall_start" && content?.type === "toolCall") {
		return { ...content, arguments: {} };
	}
	return undefined;
}

export class CompactAssistantStreamReconstructor {
	private readonly partialMessages = new Map<string, AssistantMessage>();
	private readonly toolCallParsers = new Map<string, StreamingJsonParseState<Record<string, unknown>>>();
	private readonly toolCallSnapshots = new Set<string>();

	seed(activeSessionId: string, message: AssistantMessage): void {
		this.partialMessages.set(activeSessionId, message);
		for (const [contentIndex, content] of message.content.entries()) {
			if (content.type === "toolCall") this.toolCallSnapshots.add(this.toolCallKey(activeSessionId, contentIndex));
		}
	}

	observe(message: DaemonOutbound): void {
		if (message.type !== "session_event") {
			if (
				message.type === "session_replaced" ||
				message.type === "session_resynced" ||
				message.type === "session_closed"
			) {
				this.clear(message.activeSessionId);
			}
			return;
		}
		if (message.event.type === "message_start" && message.event.message.role === "assistant") {
			this.partialMessages.set(message.activeSessionId, message.event.message);
			return;
		}
		if (message.event.type === "message_end") {
			this.clear(message.activeSessionId);
		}
	}

	reconstruct(delta: CompactAssistantDelta): DaemonOutbound | undefined {
		const partial = this.partialMessages.get(delta.activeSessionId);
		if (!partial) {
			return undefined;
		}
		const event = delta.assistantMessageEvent;
		switch (event.type) {
			case "text_start":
				partial.content[event.contentIndex] = delta.contentStart ?? { type: "text", text: "" };
				break;
			case "text_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "text") {
					return undefined;
				}
				content.text += event.delta;
				break;
			}
			case "text_end": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "text") {
					return undefined;
				}
				content.text = event.content;
				break;
			}
			case "thinking_start":
				partial.content[event.contentIndex] = delta.contentStart ?? { type: "thinking", thinking: "" };
				break;
			case "thinking_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "thinking") {
					return undefined;
				}
				content.thinking += event.delta;
				break;
			}
			case "thinking_end": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "thinking") {
					return undefined;
				}
				content.thinking = event.content;
				break;
			}
			case "toolcall_start":
				if (!delta.contentStart || delta.contentStart.type !== "toolCall") {
					return undefined;
				}
				partial.content[event.contentIndex] = delta.contentStart;
				this.toolCallParsers.set(
					this.toolCallKey(delta.activeSessionId, event.contentIndex),
					createStreamingJsonParseState(),
				);
				break;
			case "toolcall_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "toolCall") {
					return undefined;
				}
				const key = this.toolCallKey(delta.activeSessionId, event.contentIndex);
				if (delta.toolCallArguments) {
					// Producer snapshots are already materialized; never reconstruct them.
					content.arguments = delta.toolCallArguments;
					this.toolCallSnapshots.add(key);
				} else {
					// A snapshot has no corresponding raw prefix. Ask the caller to resync
					// rather than treating a later raw suffix as a whole document.
					if (this.toolCallSnapshots.has(key)) return undefined;
					const parser = this.toolCallParsers.get(key);
					if (!parser) return undefined;
					content.arguments = parser.append(event.delta);
				}
				break;
			}
			case "toolcall_end": {
				partial.content[event.contentIndex] = event.toolCall;
				const key = this.toolCallKey(delta.activeSessionId, event.contentIndex);
				this.toolCallParsers.delete(key);
				this.toolCallSnapshots.delete(key);
				break;
			}
			case "start":
			case "done":
			case "error":
				return undefined;
		}
		return {
			type: "session_event",
			activeSessionId: delta.activeSessionId,
			event: {
				type: "message_update",
				message: { ...partial, content: [...partial.content] },
				assistantMessageEvent: event as MessageUpdateEvent["assistantMessageEvent"],
			},
			...(delta.meta ? { meta: delta.meta } : {}),
		};
	}

	clear(activeSessionId: string): void {
		this.partialMessages.delete(activeSessionId);
		for (const key of this.toolCallParsers.keys()) {
			if (key.startsWith(`${activeSessionId}:`)) this.toolCallParsers.delete(key);
		}
		for (const key of this.toolCallSnapshots) {
			if (key.startsWith(`${activeSessionId}:`)) this.toolCallSnapshots.delete(key);
		}
	}

	private toolCallKey(activeSessionId: string, contentIndex: number): string {
		return `${activeSessionId}:${contentIndex}`;
	}
}

export function isCompactAssistantDelta(value: unknown): value is CompactAssistantDelta {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; activeSessionId?: unknown; assistantMessageEvent?: unknown };
	return (
		candidate.type === "assistant_stream_delta" &&
		typeof candidate.activeSessionId === "string" &&
		typeof candidate.assistantMessageEvent === "object" &&
		candidate.assistantMessageEvent !== null
	);
}
