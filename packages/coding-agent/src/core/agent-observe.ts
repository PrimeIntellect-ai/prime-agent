import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const AGENT_OBSERVE_SKILL_NAME = "agent-observe";
export const AGENT_OBSERVE_IMPORT_NAME = "agent_observe";
export const ORCHESTRATION_HEARTBEAT_SKILL_NAME = "orchestration-heartbeat";

export interface AgentObserveAgentSummary {
	activeSessionId: string;
	sessionId: string;
	sessionName?: string;
	runtimeKind?: "top-level" | "subagent";
	cwd: string;
	status: string;
	isCurrent: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount: number;
	queuedCount: number;
	isSessionActive: boolean;
	parentActiveSessionId?: string;
	parentSessionId?: string;
	rlmChildId?: string;
	rlmParentNodeId?: string;
	firstMessage?: string;
	latestMessage?: AgentObserveMessagePreview;
}

export interface AgentObserveListResult {
	current: AgentObserveAgentSummary;
	agents: AgentObserveAgentSummary[];
}

export interface AgentObserveAgentSnapshot {
	agent: AgentObserveAgentSummary;
}

export interface AgentObserveRecentMessagesInput {
	target: string;
	limit?: number;
	maxChars?: number;
}

export interface AgentObserveRecentMessagesResult {
	agent: AgentObserveAgentSummary;
	messages: AgentObserveMessagePreview[];
	limit: number;
	maxChars: number;
	truncated: boolean;
}

export interface AgentObserveMessagePreview {
	index: number;
	role: string;
	timestamp?: number;
	text: string;
	truncated: boolean;
	toolCalls?: string[];
	customType?: string;
}

export interface AgentObserveController {
	listAgents(): AgentObserveListResult | Promise<AgentObserveListResult>;
	getAgent(target: string): AgentObserveAgentSnapshot | Promise<AgentObserveAgentSnapshot>;
	recentMessages(
		input: AgentObserveRecentMessagesInput,
	): AgentObserveRecentMessagesResult | Promise<AgentObserveRecentMessagesResult>;
}

export function createAgentObserveHostHandlers(controller: AgentObserveController) {
	return {
		"agent_observe.list": async () => controller.listAgents() as unknown as Record<string, unknown>,
		"agent_observe.get": async (payload: Record<string, unknown> = {}) => {
			if (typeof payload.target !== "string") {
				throw new Error("agent_observe.get target must be a string");
			}
			return (await controller.getAgent(payload.target)) as unknown as Record<string, unknown>;
		},
		"agent_observe.recent": async (payload: Record<string, unknown> = {}) => {
			if (typeof payload.target !== "string") {
				throw new Error("agent_observe.recent target must be a string");
			}
			return (await controller.recentMessages({
				target: payload.target,
				limit: normalizeOptionalInteger(payload.limit, "agent_observe.recent limit"),
				maxChars: normalizeOptionalInteger(payload.max_chars ?? payload.maxChars, "agent_observe.recent max_chars"),
			})) as unknown as Record<string, unknown>;
		},
	};
}

export function normalizeObserveLimit(limit: number | undefined, defaultLimit = 8): number {
	return clampInteger(limit ?? defaultLimit, 1, 50, "agent_observe limit");
}

export function normalizeObserveMaxChars(maxChars: number | undefined, defaultMaxChars = 800): number {
	return clampInteger(maxChars ?? defaultMaxChars, 80, 2_000, "agent_observe max_chars");
}

export function createAgentObserveMessagePreview(
	message: AgentMessage,
	index: number,
	maxChars: number,
): AgentObserveMessagePreview {
	const text = messageText(message);
	const clipped = truncate(text, maxChars);
	const toolCalls = message.role === "assistant" ? assistantToolCalls(message) : undefined;
	return {
		index,
		role: message.role,
		...(message.timestamp ? { timestamp: message.timestamp } : {}),
		text: clipped.text,
		truncated: clipped.truncated,
		...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
		...(message.role === "custom" ? { customType: message.customType } : {}),
	};
}

function normalizeOptionalInteger(value: unknown, label: string): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${label} must be an integer when provided`);
	}
	return value;
}

function clampInteger(value: number, min: number, max: number, label: string): number {
	if (!Number.isInteger(value)) {
		throw new Error(`${label} must be an integer`);
	}
	if (value < min || value > max) {
		throw new Error(`${label} must be between ${min} and ${max}`);
	}
	return value;
}

function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) {
		return { text, truncated: false };
	}
	return { text: text.slice(0, maxChars), truncated: true };
}

function messageText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
		case "assistant":
			return contentText(message.content);
		case "toolResult":
			return contentText(message.content);
		case "bashExecution":
			return [message.command, message.output].filter(Boolean).join("\n");
		case "custom":
			return typeof message.content === "string" ? message.content : contentText(message.content);
		case "branchSummary":
			return message.summary;
		case "compactionSummary":
			return message.summary;
		default: {
			const exhaustive: never = message;
			return JSON.stringify(exhaustive);
		}
	}
}

function contentText(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((block) => {
			if (!block || typeof block !== "object" || !("type" in block)) {
				return "";
			}
			if (block.type === "text" && "text" in block && typeof block.text === "string") {
				return block.text;
			}
			if (block.type === "thinking" && "thinking" in block && typeof block.thinking === "string") {
				return block.thinking;
			}
			if (block.type === "image") {
				return "[image]";
			}
			if (block.type === "toolCall" && "name" in block && typeof block.name === "string") {
				return `[tool_call:${block.name}]`;
			}
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function assistantToolCalls(message: Extract<AgentMessage, { role: "assistant" }>): string[] {
	return message.content.filter((block) => block.type === "toolCall").map((block) => block.name);
}
