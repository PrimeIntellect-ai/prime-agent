import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "../../core/model-registry.js";
import type { AgentStatus, AgentTaskState } from "../../core/session-manager.js";
import type { ActiveSessionState } from "./active-session-state.js";

const SWEEP_INTERVAL_MS = 25_000;
// Collapse a tool-use loop's rapid turn_end bursts into one summarization.
const SETTLE_DEBOUNCE_MS = 2_000;

const SUMMARY_MODEL_PROVIDER = "prime-inference";
const SUMMARY_MODEL_ID = "qwen/qwen3-30b-a3b-instruct-2507";

const SUMMARY_CONTEXT_MESSAGES = 8;
const SUMMARY_MAX_CHARS_PER_MESSAGE = 600;
// Generous so a chatty model still closes the tags before truncation.
const SUMMARY_MAX_TOKENS = 400;

export const AGENT_STATUS_SYSTEM_PROMPT = `You generate a status line for an AI coding agent dashboard. You are given the recent conversation between a user and the agent, plus whether the agent is currently working or idle.

Output ONLY these two tags, nothing before, between, or after. Do not think out loud, explain, or count words.
<recap>a present-tense clause, at most 12 words, saying what the agent is doing or just did, no trailing period</recap>
<status>one of NEEDS_INPUT, COMPLETED</status>

STATUS meaning:
- COMPLETED: the agent finished its turn AND the user's request is fully done with nothing left.
- NEEDS_INPUT: the agent finished its turn but the task is not fully done — it asked a question, hit a blocker, or needs more prompting.
When you are unsure between COMPLETED and NEEDS_INPUT, choose NEEDS_INPUT.

Example:
<recap>Refactoring the auth middleware and updating its tests</recap>
<status>NEEDS_INPUT</status>`;

export interface AgentStatusResult {
	summary: string;
	taskState?: AgentTaskState;
}

/** Resolve the cheap summary model, or undefined when it has no configured auth. */
export function resolveSummaryModel(registry: ModelRegistry): Model<Api> | undefined {
	const model = registry.find(SUMMARY_MODEL_PROVIDER, SUMMARY_MODEL_ID);
	if (model && registry.hasConfiguredAuth(model)) {
		return model;
	}
	return undefined;
}

function messageText(content: unknown): { text: string; tools: string[] } {
	if (typeof content === "string") {
		return { text: content, tools: [] };
	}
	if (!Array.isArray(content)) {
		return { text: "", tools: [] };
	}
	const parts: string[] = [];
	const tools: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) {
			continue;
		}
		const type = (block as { type?: unknown }).type;
		if (type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		} else if (type === "tool_use" || type === "toolUse") {
			const name = (block as { name?: unknown }).name;
			if (typeof name === "string") {
				tools.push(name);
			}
		}
	}
	return { text: parts.join("\n"), tools };
}

function clamp(text: string, max: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

/** Serialize the trailing messages into a compact prompt body (tool calls by name only). */
export function buildStatusContext(messages: readonly AgentMessage[], isWorking: boolean): string {
	const recent = messages.slice(-SUMMARY_CONTEXT_MESSAGES);
	const lines: string[] = [];
	for (const message of recent) {
		const role = message.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult" && role !== "custom") {
			continue;
		}
		const { text, tools } = messageText(message.content);
		const body = clamp(text, SUMMARY_MAX_CHARS_PER_MESSAGE);
		const toolNote = tools.length > 0 ? `[tools: ${[...new Set(tools)].join(", ")}]` : "";
		const rendered = [body, toolNote].filter((part) => part.length > 0).join(" ");
		if (rendered) {
			lines.push(`${role}: ${rendered}`);
		}
	}
	const state = isWorking ? "working" : "idle (finished its turn)";
	return `<agent-state>${state}</agent-state>\n<conversation>\n${lines.join("\n")}\n</conversation>`;
}

// Cuts a word-counting trailer the model sometimes appends, e.g.
// `Sending X. That's 5 words? Count: X(1)... = 6 words.`. Kept to structural
// counting markers so plain words ("Waiting for CI") survive.
const REASONING_TRAILER = /\s*(?:["”]\s*)?(?:\bthat['’]?s\s+\d+\s*words?\b|\bcount\s*:|\(\d+\)|=\s*\d+\s*words?\b).*/i;
const COUNTING_ARTIFACT = /\(\d+\)|=\s*\d+\s*words?\b/i;
const MAX_RECAP_WORDS = 16;

function cleanRecap(raw: string): string | undefined {
	const value = raw
		.trim()
		.replace(REASONING_TRAILER, "")
		.replace(/^["“']+|["”']+$/g, "")
		.replace(/[.\s]+$/, "")
		.trim();
	if (!value || value.startsWith("<") || /present-tense|12 words/i.test(value)) {
		return undefined;
	}
	if (COUNTING_ARTIFACT.test(value) || value.split(/\s+/).length > MAX_RECAP_WORDS) {
		return undefined;
	}
	return value;
}

/** Take the content of the last `<recap>` and `<status>` tags; idle verdicts default to needs_input. */
export function parseAgentStatusResponse(text: string, isWorking: boolean): AgentStatusResult | undefined {
	// Normalize unicode angle-bracket lookalikes (‹ › ＜ ＞) so a tag written with them still parses.
	const cleaned = text.replace(/[‹＜]/g, "<").replace(/[›＞]/g, ">");

	const recapMatch = [...cleaned.matchAll(/<recap>([\s\S]*?)<\/recap>/gi)].at(-1);
	const summary = recapMatch ? cleanRecap(recapMatch[1]!) : undefined;
	if (!summary) {
		return undefined;
	}
	if (isWorking) {
		return { summary };
	}
	const statusMatch = [...cleaned.matchAll(/<status>\s*([a-z_]+)\s*<\/status>/gi)].at(-1);
	const status = statusMatch ? statusMatch[1]!.toUpperCase() : undefined;
	const taskState: AgentTaskState = status === "COMPLETED" ? "completed" : "needs_input";
	return { summary, taskState };
}

export interface GenerateAgentStatusParams {
	registry: ModelRegistry;
	messages: readonly AgentMessage[];
	isWorking: boolean;
	signal?: AbortSignal;
}

/** One cheap model call for a fresh status, or undefined if unavailable/empty/failed. */
export async function generateAgentStatus(params: GenerateAgentStatusParams): Promise<AgentStatusResult | undefined> {
	const { registry, messages, isWorking, signal } = params;
	if (messages.length === 0) {
		return undefined;
	}
	const model = resolveSummaryModel(registry);
	if (!model) {
		return undefined;
	}
	const auth = await registry.getApiKeyAndHeaders(model);
	if (!auth.ok || !auth.apiKey) {
		return undefined;
	}
	try {
		const response = await completeSimple(
			model,
			{
				systemPrompt: AGENT_STATUS_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: buildStatusContext(messages, isWorking) }],
						timestamp: Date.now(),
					},
				],
			},
			{ maxTokens: SUMMARY_MAX_TOKENS, apiKey: auth.apiKey, headers: auth.headers, signal },
		);
		if (response.stopReason === "error") {
			return undefined;
		}
		const textContent = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		return parseAgentStatusResponse(textContent, isWorking);
	} catch {
		return undefined;
	}
}

/** True when the new status differs enough from the stored one to be worth broadcasting. */
export function agentStatusChanged(previous: AgentStatus | undefined, next: AgentStatusResult): boolean {
	if (!previous) {
		return true;
	}
	return previous.summary !== next.summary || previous.taskState !== next.taskState;
}

function isSessionWorking(state: ActiveSessionState): boolean {
	const session = state.runtime.session;
	return session.isSessionActive;
}

/**
 * Background status summarization for daemon-hosted sessions, top-level and
 * subagents alike. A periodic sweep refreshes working sessions; debounced
 * turn-end activity drives the idle verdict. Status lives in memory; settled
 * idle verdicts are persisted.
 */
export class DaemonSessionSummarizer {
	private interval: ReturnType<typeof setInterval> | undefined;
	private readonly debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	// Controller per in-flight summary so a closing session can abort its write.
	private readonly inFlight = new Map<string, AbortController>();
	// Sessions requested while one was running; get one more pass on completion.
	private readonly rerunRequested = new Set<string>();

	constructor(
		private readonly listSessions: () => readonly ActiveSessionState[],
		private readonly onStatusChanged?: (state: ActiveSessionState) => void,
		// Injectable for tests.
		private readonly generate: (
			params: GenerateAgentStatusParams,
		) => Promise<AgentStatusResult | undefined> = generateAgentStatus,
	) {}

	start(): void {
		if (this.interval) {
			return;
		}
		this.interval = setInterval(() => {
			for (const state of this.listSessions()) {
				void this.summarize(state);
			}
		}, SWEEP_INTERVAL_MS);
		this.interval.unref?.();
	}

	stop(): void {
		if (this.interval) {
			clearInterval(this.interval);
			this.interval = undefined;
		}
		for (const timer of this.debounceTimers.values()) {
			clearTimeout(timer);
		}
		this.debounceTimers.clear();
		for (const controller of this.inFlight.values()) {
			controller.abort();
		}
		this.rerunRequested.clear();
	}

	/** Drop any pending work for a session that is closing. */
	forget(activeSessionId: string): void {
		const timer = this.debounceTimers.get(activeSessionId);
		if (timer) {
			clearTimeout(timer);
			this.debounceTimers.delete(activeSessionId);
		}
		this.inFlight.get(activeSessionId)?.abort();
		this.rerunRequested.delete(activeSessionId);
	}

	/** Seed in-memory status from the persisted entry when a session is added. */
	seed(state: ActiveSessionState): void {
		if (state.summaryState) {
			return;
		}
		const persisted = state.runtime.session.sessionManager.getLatestAgentStatus();
		if (persisted) {
			state.summaryState = persisted;
		}
	}

	/** Called when a session finishes a turn; debounce until the agent settles. */
	notifyActivity(state: ActiveSessionState): void {
		const id = state.activeSessionId;
		const existing = this.debounceTimers.get(id);
		if (existing) {
			clearTimeout(existing);
		}
		const timer = setTimeout(() => {
			this.debounceTimers.delete(id);
			void this.summarize(state);
		}, SETTLE_DEBOUNCE_MS);
		timer.unref?.();
		this.debounceTimers.set(id, timer);
	}

	private async summarize(state: ActiveSessionState): Promise<void> {
		const id = state.activeSessionId;
		if (this.inFlight.has(id)) {
			this.rerunRequested.add(id); // run once more after the current pass
			return;
		}
		const session = state.runtime.session;
		const messages = session.messages;
		if (messages.length === 0) {
			return;
		}
		const messageCount = messages.length;
		const isWorking = isSessionWorking(state);
		const previous = state.summaryState;
		// Idle sessions with a current verdict need no refresh; working sessions
		// always refresh so the recap keeps up with the in-progress turn.
		const contentUnchanged = previous?.basedOnMessageCount === messageCount;
		const owesIdleVerdict = !isWorking && previous?.taskState === undefined;
		// A blank recap means the model call hasn't succeeded yet (e.g. the
		// needs_input fallback fired on a transient failure); keep retrying until a
		// real summary lands so the recap isn't left permanently empty.
		const owesSummary = !isWorking && !previous?.summary;
		if (contentUnchanged && !isWorking && !owesIdleVerdict && !owesSummary) {
			return;
		}
		// Include the in-progress message so a long streaming turn gets a live recap.
		const streaming = isWorking ? session.state.streamingMessage : undefined;
		const contextMessages = streaming ? [...messages, streaming] : messages;

		const controller = new AbortController();
		this.inFlight.set(id, controller);
		try {
			const generated = await this.generate({
				registry: session.modelRegistry,
				messages: contextMessages,
				isWorking,
				signal: controller.signal,
			});
			// A failed classification on an idle session would spin at "working"
			// forever (the activity axis holds unjudged idle sessions there), so
			// settle it to needs_input.
			const result =
				generated ??
				(!isWorking && (owesIdleVerdict || owesSummary)
					? { summary: previous?.summary ?? "", taskState: "needs_input" as const }
					: undefined);
			if (!result) {
				return;
			}
			// Discard if the session closed, was swapped, or moved to a new turn
			// during the async call — never write a verdict for stale state.
			if (
				controller.signal.aborted ||
				state.runtime.session !== session ||
				isSessionWorking(state) !== isWorking ||
				session.messages.length !== messageCount
			) {
				return;
			}
			// A working refresh carries no verdict; keep the prior one at the same
			// message count so a still-valid needs_input isn't dropped.
			const taskState =
				result.taskState ?? (previous?.basedOnMessageCount === messageCount ? previous?.taskState : undefined);
			const status: AgentStatus = {
				summary: result.summary,
				taskState,
				basedOnMessageCount: messageCount,
			};
			const changed = previous?.summary !== status.summary || previous?.taskState !== status.taskState;
			state.summaryState = status;
			// Persist only settled idle verdicts, never mid-stream.
			if (!isWorking) {
				try {
					session.sessionManager.appendAgentStatus(status);
				} catch {
					// best-effort; in-memory status still shows
				}
			}
			if (changed) {
				this.onStatusChanged?.(state);
			}
		} finally {
			this.inFlight.delete(id);
			// Re-debounce a request that arrived mid-pass instead of dropping it.
			if (this.rerunRequested.delete(id)) {
				this.notifyActivity(state);
			}
		}
	}
}
