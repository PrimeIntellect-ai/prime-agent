import { type AssistantMessage, type AssistantMessageEvent, parseStreamingJson } from "@prime-intellect/prime-agent-ai";
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
	private readonly toolCallJson = new Map<string, string>();

	seed(activeSessionId: string, message: AssistantMessage): void {
		this.partialMessages.set(activeSessionId, message);
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
				this.toolCallJson.set(this.toolCallKey(delta.activeSessionId, event.contentIndex), "");
				break;
			case "toolcall_delta": {
				const content = partial.content[event.contentIndex];
				if (content?.type !== "toolCall") {
					return undefined;
				}
				if (delta.toolCallArguments) {
					content.arguments = delta.toolCallArguments;
				} else {
					const key = this.toolCallKey(delta.activeSessionId, event.contentIndex);
					const partialJson = `${this.toolCallJson.get(key) ?? ""}${event.delta}`;
					this.toolCallJson.set(key, partialJson);
					content.arguments = parseStreamingJson<Record<string, unknown>>(partialJson);
				}
				break;
			}
			case "toolcall_end":
				partial.content[event.contentIndex] = event.toolCall;
				this.toolCallJson.delete(this.toolCallKey(delta.activeSessionId, event.contentIndex));
				break;
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
		for (const key of this.toolCallJson.keys()) {
			if (key.startsWith(`${activeSessionId}:`)) {
				this.toolCallJson.delete(key);
			}
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
