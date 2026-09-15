import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AgentFamilyCatalogEntry,
	type AgentFamilyRelationship,
	isAgentFamilyParent,
	selectAgentFamily,
} from "./agent-messages.js";

export const AGENT_OBSERVE_SKILL_NAME = "agent-observe";
/** Shared cap for the message previews carried by roster rows. */
export const AGENT_OBSERVE_PREVIEW_MAX_CHARS = 240;
export const AGENT_OBSERVE_IMPORT_NAME = "agent_observe";
export const ORCHESTRATION_HEARTBEAT_SKILL_NAME = "orchestration-heartbeat";

/** Roster relationship: nuclear family roles plus read-only `descendant` rows. */
export type AgentObserveRelationship = AgentFamilyRelationship | "descendant";

export interface AgentObserveRosterMember {
	relationship: AgentObserveRelationship;
	entry: AgentFamilyCatalogEntry;
}

export interface AgentObserveListInput {
	/** Include descendants of the current agent beyond direct children. */
	recursive?: boolean;
}

/**
 * Roster for the current agent: the nuclear family, and when `recursive` is
 * set, every descendant below direct children as read-only `descendant` rows
 * in breadth-first name order. Discovery only: a descendant grants no extra
 * reach, and communication still relays through its parent.
 */
export function selectAgentObserveRoster(
	current: AgentFamilyCatalogEntry,
	catalog: readonly AgentFamilyCatalogEntry[],
	recursive = false,
): AgentObserveRosterMember[] {
	const family = selectAgentFamily(current, catalog);
	if (!recursive) return family;
	const included = new Set(family.map((member) => member.entry.id).concat(current.id));
	const descendants: AgentObserveRosterMember[] = [];
	// Walked ids bound the frontier even if malformed parent edges form a cycle.
	const walked = new Set([current.id]);
	let frontier: AgentFamilyCatalogEntry[] = [current];
	while (frontier.length > 0) {
		const next: AgentFamilyCatalogEntry[] = [];
		const level: AgentObserveRosterMember[] = [];
		for (const parent of frontier) {
			for (const entry of catalog) {
				if (!isAgentFamilyParent(parent, entry) || walked.has(entry.id)) continue;
				// Direct children already appear as nuclear rows, but their own
				// descendants still need the walk to continue through them.
				walked.add(entry.id);
				next.push(entry);
				if (included.has(entry.id)) continue;
				included.add(entry.id);
				level.push({ relationship: "descendant", entry });
			}
		}
		level.sort(
			(a, b) =>
				(a.entry.name ?? a.entry.id).localeCompare(b.entry.name ?? b.entry.id) ||
				a.entry.id.localeCompare(b.entry.id),
		);
		descendants.push(...level);
		frontier = next;
	}
	return [...family, ...descendants];
}

export interface AgentObserveAgentSummary {
	/** Absent for family members that have no live session in this daemon. */
	activeSessionId?: string;
	sessionId: string;
	sessionName?: string;
	/** Absent only for the current agent. */
	relationship?: AgentObserveRelationship;
	/** Canonical session file path, when known; supports read-only transcript inspection. */
	sessionPath?: string;
	runtimeKind?: "top-level" | "subagent";
	cwd?: string;
	status: string;
	isCurrent: boolean;
	isStreaming: boolean;
	isCompacting: boolean;
	attachedClients: number;
	messageCount?: number;
	queuedCount: number;
	isSessionActive: boolean;
	repliedSinceTask?: boolean;
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
	listAgents(input?: AgentObserveListInput): AgentObserveListResult | Promise<AgentObserveListResult>;
	getAgent(target: string): AgentObserveAgentSnapshot | Promise<AgentObserveAgentSnapshot>;
	recentMessages(
		input: AgentObserveRecentMessagesInput,
	): AgentObserveRecentMessagesResult | Promise<AgentObserveRecentMessagesResult>;
}

export function createAgentObserveHostHandlers(controller: AgentObserveController) {
	return {
		"agent_observe.list": async (payload: Record<string, unknown> = {}) =>
			(await controller.listAgents({
				recursive: normalizeObserveRecursive(payload.recursive),
			})) as unknown as Record<string, unknown>,
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

export function normalizeObserveRecursive(value: unknown): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") {
		throw new Error("agent_observe.list recursive must be a boolean");
	}
	return value;
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
