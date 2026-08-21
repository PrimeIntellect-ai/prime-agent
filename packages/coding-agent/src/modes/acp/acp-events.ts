import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { type ActProjectionEvent, type ActStartEvent, actEventDepth } from "../../core/act-events.js";
import type { AgentConnectionSessionEvent } from "../agent-connection/types.js";
import type { PrimeAgentIpythonMeta, PrimeAgentSessionMeta } from "./acp-meta.js";
import { primeAgentMeta } from "./acp-meta.js";

/**
 * Translate prime-agent session events into ACP `session/update` payloads.
 *
 * Kept as a pure function so the mapping is testable without a live ACP client
 * or a running agent. Returning an array lets one prime-agent event fan out to
 * several ACP updates (or none, for events ACP has no place for).
 */

export type AcpToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type AcpToolStatus = "pending" | "in_progress" | "completed" | "failed";

export type AcpSessionUpdate = SessionUpdate;

/** prime-agent's model-facing tool is IPython; bash is the secondary escape hatch. */
export const IPYTHON_TOOL_NAME = "ipython";

export function acpToolKind(toolName: string): AcpToolKind {
	switch (toolName) {
		case IPYTHON_TOOL_NAME:
		case "bash":
			return "execute";
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		default:
			return "other";
	}
}

/** Decoded byte length of a base64 payload, without materializing it. */
function base64ByteLength(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function textContent(text: string): { type: "text"; text: string } {
	return { type: "text", text };
}

/**
 * Map one streaming assistant event to an ACP chunk.
 *
 * The delta discriminator lives on the event itself (`text_delta` /
 * `thinking_delta`) and carries a plain string, so reasoning and visible answer
 * text are distinct ACP update kinds a client can render or hide separately.
 */
function assistantDeltaUpdates(event: AssistantMessageEvent): AcpSessionUpdate[] {
	if (event.type === "thinking_delta" && event.delta.length > 0) {
		return [{ sessionUpdate: "agent_thought_chunk", content: textContent(event.delta) }];
	}
	if (event.type === "text_delta" && event.delta.length > 0) {
		return [{ sessionUpdate: "agent_message_chunk", content: textContent(event.delta) }];
	}
	return [];
}

/** Extract the IPython cell source so a client can show what is executing. */
function ipythonCellSource(args: unknown): string | undefined {
	if (!args || typeof args !== "object") return undefined;
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function toolResultText(result: unknown): string | undefined {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return undefined;
	const output = (result as { output?: unknown }).output;
	if (typeof output === "string") return output;
	const content = (result as { content?: unknown }).content;
	if (Array.isArray(content)) {
		const parts = content
			.map((block) =>
				block && typeof block === "object" && (block as { type?: string }).type === "text"
					? ((block as { text?: string }).text ?? "")
					: "",
			)
			.filter(Boolean);
		if (parts.length > 0) return parts.join("\n");
	}
	return undefined;
}

/**
 * Rich IPython output that ACP has no content type for.
 *
 * The ipython tool reports media and diffs under `details` (images additionally
 * ride along as ACP image content blocks); mirror those exact fields rather than
 * inventing a MIME bundle the tool never produces.
 */
function ipythonRichOutput(result: unknown): PrimeAgentIpythonMeta | undefined {
	if (!result || typeof result !== "object") return undefined;
	const details = (result as { details?: unknown }).details;
	if (!details || typeof details !== "object") return undefined;
	const { attachments, diffs } = details as { attachments?: unknown; diffs?: unknown };
	const meta: PrimeAgentIpythonMeta = {};
	if (Array.isArray(attachments) && attachments.length > 0) {
		meta.attachments = attachments.map((attachment) => {
			// KernelAttachment exposes mimeType, base64 `data`, and an optional path.
			// Report the decoded size rather than a `bytes` field the kernel never
			// sends, and never inline the payload: ACP already carries images as
			// content blocks, so duplicating them here would bloat every update.
			const typed = (attachment ?? {}) as { mimeType?: unknown; path?: unknown; data?: unknown };
			return {
				...(typeof typed.mimeType === "string" ? { mimeType: typed.mimeType } : {}),
				...(typeof typed.path === "string" ? { path: typed.path } : {}),
				...(typeof typed.data === "string" ? { bytes: base64ByteLength(typed.data) } : {}),
			};
		});
	}
	if (Array.isArray(diffs) && diffs.length > 0) meta.diffCount = diffs.length;
	return meta.attachments || meta.diffCount !== undefined ? meta : undefined;
}

/**
 * Correlates stateful synthetic ACP tool calls.
 *
 * `bash_output` carries no `runId`, so the most recent `bash_start` supplies it.
 * An Act tool call accumulates standard content because ACP tool-call updates
 * replace the content collection rather than append to it.
 */
interface ActiveAcpAct {
	start: ActStartEvent;
	lastSequence: number;
	progressChunks: string[];
	progressChars: number;
	contentTruncated: boolean;
	truncationPublished: boolean;
	lastAssistantStream?: "thinking" | "text";
	pendingChars: number;
	progressUpdates: number;
}

export interface AcpEventMappingState {
	activeBashRunId?: string;
	activeActs?: Map<string, ActiveAcpAct>;
	closedActIds?: Set<string>;
}

const ACT_TOOL_CALL_PREFIX = "prime-agent-act";
export const ACP_ACT_CONTENT_MAX_CHARS = 32_768;
export const ACP_ACT_PROGRESS_UPDATE_MAX = 32;
const ACP_ACT_TERMINAL_RESERVE_CHARS = 4352;
const ACP_ACT_TRUNCATION_MARKER = "\n[Act progress truncated]";
const ACP_ACT_PROGRESS_MAX_CHARS =
	ACP_ACT_CONTENT_MAX_CHARS - ACP_ACT_TERMINAL_RESERVE_CHARS - ACP_ACT_TRUNCATION_MARKER.length - 1;
const ACP_ACT_ASSISTANT_FLUSH_CHARS = 1024;
const ACP_ACT_PENDING_CHUNK_MAX = 1024;

export function actToolCallId(actId: string): string {
	return `${ACT_TOOL_CALL_PREFIX}-${actId}`;
}

function activeActs(state: AcpEventMappingState): Map<string, ActiveAcpAct> {
	if (!state.activeActs) state.activeActs = new Map();
	return state.activeActs;
}

function closedActIds(state: AcpEventMappingState): Set<string> {
	if (!state.closedActIds) state.closedActIds = new Set();
	return state.closedActIds;
}

// Bound duplicate-terminal memory for long-lived ACP sessions.
const MAX_CLOSED_ACT_IDS = 256;

function rememberClosedAct(closed: Set<string>, actId: string): void {
	closed.add(actId);
	if (closed.size <= MAX_CLOSED_ACT_IDS) return;
	const oldest = closed.values().next().value;
	if (oldest !== undefined) closed.delete(oldest);
}

function actTruncatedFields(event: ActProjectionEvent): string[] | undefined {
	const fields: string[] = [];
	switch (event.event) {
		case "start":
		case "terminal":
			if (event.promptTruncated) fields.push("prompt");
			if (event.event === "terminal" && event.errorTruncated) fields.push("error");
			break;
		case "assistant_delta":
			if (event.textTruncated) fields.push("text");
			break;
		case "cell_start":
			if (event.codeTruncated) fields.push("code");
			break;
		case "cell_terminal":
			if (event.stdoutTruncated) fields.push("stdout");
			if (event.stderrTruncated) fields.push("stderr");
			if (event.resultTruncated) fields.push("result");
			if (event.errorTruncated) fields.push("error");
	}
	return fields.length > 0 ? fields : undefined;
}

function actMeta(
	event: ActProjectionEvent,
	start: ActStartEvent | undefined,
	contentTruncated = false,
): Record<string, unknown> {
	const truncatedFields = actTruncatedFields(event);
	return primeAgentMeta({
		act: {
			actId: event.actId,
			depth: actEventDepth(event),
			...(event.parentActId ? { parentActId: event.parentActId } : {}),
			outerToolCallId: event.outerToolCallId,
			sequence: event.sequence,
			event: event.event,
			model: event.event === "terminal" ? event.model : start?.model,
			cancellationCapability:
				event.event === "terminal" ? event.cancellationCapability : start?.cancellationCapability,
			...(event.event === "assistant_delta" ? { stream: event.stream } : {}),
			...(event.event === "cell_start" ? { cellId: event.cellId, cellStatus: "start" as const } : {}),
			...(event.event === "cell_terminal" ? { cellId: event.cellId, cellStatus: event.status } : {}),
			...(event.event === "terminal" ? { terminalStatus: event.status, usage: event.usage } : {}),
			contentTruncated,
			contentMaxChars: ACP_ACT_CONTENT_MAX_CHARS,
			...(truncatedFields ? { truncatedFields } : {}),
		},
	});
}

function compactActProgress(active: ActiveAcpAct): string {
	if (active.progressChunks.length === 1) return active.progressChunks[0] ?? "";
	const text = active.progressChunks.join("");
	active.progressChunks = text ? [text] : [];
	return text;
}

function appendActProgress(active: ActiveAcpAct, text: string): { changed: boolean; truncatedNow: boolean } {
	if (text.length === 0 || active.contentTruncated) return { changed: false, truncatedNow: false };
	const remaining = ACP_ACT_PROGRESS_MAX_CHARS - active.progressChars;
	const retained = text.slice(0, Math.max(0, remaining));
	if (retained) active.progressChunks.push(retained);
	active.progressChars += retained.length;
	active.pendingChars += retained.length;
	// Coalesce token-sized deltas even when the progress-update ceiling has
	// already stopped wire publication.
	if (active.progressChunks.length >= ACP_ACT_PENDING_CHUNK_MAX) compactActProgress(active);
	if (retained.length === text.length) return { changed: retained.length > 0, truncatedNow: false };
	active.contentTruncated = true;
	return { changed: retained.length > 0, truncatedNow: true };
}

function appendActAssistant(active: ActiveAcpAct, stream: "thinking" | "text", text: string) {
	if (text.length === 0) return { changed: false, truncatedNow: false };
	const label = active.lastAssistantStream === stream ? "" : `\n[${stream}]\n`;
	active.lastAssistantStream = stream;
	return appendActProgress(active, `${label}${text}`);
}

function actProgressContent(active: ActiveAcpAct): string {
	return `${compactActProgress(active)}${active.contentTruncated ? ACP_ACT_TRUNCATION_MARKER : ""}`;
}

function actTerminalContent(
	active: ActiveAcpAct | undefined,
	event: Extract<ActProjectionEvent, { event: "terminal" }>,
): { text: string; truncated: boolean } {
	const terminal = `Act ${event.status}.${event.error ? `\n${event.error}` : ""}`;
	const terminalTruncated = terminal.length > ACP_ACT_TERMINAL_RESERVE_CHARS;
	const terminalText = terminal.slice(0, ACP_ACT_TERMINAL_RESERVE_CHARS);
	const progress = active ? actProgressContent(active) : "";
	return {
		text: `${progress}${progress ? "\n" : ""}${terminalText}`,
		truncated: (active?.contentTruncated ?? false) || terminalTruncated,
	};
}

function actStandardContent(text: string) {
	return [{ type: "content" as const, content: textContent(text) }];
}

function shouldPublishActProgress(active: ActiveAcpAct, options: { force: boolean; truncatedNow: boolean }): boolean {
	if (active.progressUpdates >= ACP_ACT_PROGRESS_UPDATE_MAX) return false;
	const first = active.progressUpdates === 0;
	const flush = active.pendingChars >= ACP_ACT_ASSISTANT_FLUSH_CHARS;
	const publishTruncation = options.truncatedNow && !active.truncationPublished;
	if (!first && !options.force && !flush && !publishTruncation) return false;
	active.progressUpdates += 1;
	active.pendingChars = 0;
	if (active.contentTruncated) active.truncationPublished = true;
	return true;
}

function actCellTerminalText(event: Extract<ActProjectionEvent, { event: "cell_terminal" }>): string {
	const parts = [`Cell ${event.cellId} ${event.status}:`];
	if (event.stdout) parts.push(`stdout:\n${event.stdout}`);
	if (event.stderr) parts.push(`stderr:\n${event.stderr}`);
	if (event.result !== undefined) parts.push(`result:\n${event.result}`);
	if (event.error !== undefined) parts.push(`error:\n${event.error}`);
	return parts.join("\n");
}

function actUpdates(event: ActProjectionEvent, state: AcpEventMappingState): AcpSessionUpdate[] {
	const acts = activeActs(state);
	const closed = closedActIds(state);
	if (closed.has(event.actId)) return [];

	if (event.event === "start") {
		if (acts.has(event.actId)) return [];
		const active: ActiveAcpAct = {
			start: event,
			lastSequence: event.sequence,
			progressChunks: [],
			progressChars: 0,
			contentTruncated: false,
			truncationPublished: false,
			pendingChars: 0,
			progressUpdates: 0,
		};
		acts.set(event.actId, active);
		return [
			{
				sessionUpdate: "tool_call",
				toolCallId: actToolCallId(event.actId),
				title: `Act (${event.model.id})`,
				kind: "execute" satisfies AcpToolKind,
				status: "in_progress" satisfies AcpToolStatus,
				rawInput: { prompt: event.prompt },
				_meta: actMeta(event, event, active.contentTruncated),
			},
		];
	}

	const active = acts.get(event.actId);
	if (!active) {
		if (event.event !== "terminal") return [];
		rememberClosedAct(closed, event.actId);
		const terminalContent = actTerminalContent(undefined, event);
		return [
			{
				sessionUpdate: "tool_call",
				toolCallId: actToolCallId(event.actId),
				title: `Act (${event.model.id})`,
				kind: "execute" satisfies AcpToolKind,
				status: (event.status === "done" ? "completed" : "failed") satisfies AcpToolStatus,
				rawInput: { prompt: event.prompt },
				content: actStandardContent(terminalContent.text),
				_meta: actMeta(event, undefined, terminalContent.truncated),
			},
		];
	}
	if (event.sequence <= active.lastSequence) return [];
	active.lastSequence = event.sequence;

	let append = { changed: false, truncatedNow: false };
	let force = false;
	switch (event.event) {
		case "assistant_delta":
			append = appendActAssistant(active, event.stream, event.text);
			break;
		case "cell_start":
			append = appendActProgress(active, `\nCell ${event.cellId} start:\n${event.code}`);
			force = true;
			break;
		case "cell_terminal":
			append = appendActProgress(active, `\n${actCellTerminalText(event)}`);
			force = true;
			break;
		case "terminal": {
			acts.delete(event.actId);
			rememberClosedAct(closed, event.actId);
			const terminalContent = actTerminalContent(active, event);
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: actToolCallId(event.actId),
					status: (event.status === "done" ? "completed" : "failed") satisfies AcpToolStatus,
					content: actStandardContent(terminalContent.text),
					_meta: actMeta(event, active.start, terminalContent.truncated),
				},
			];
		}
	}

	if (!append.changed && !append.truncatedNow) return [];
	if (!shouldPublishActProgress(active, { force, truncatedNow: append.truncatedNow })) return [];
	return [
		{
			sessionUpdate: "tool_call_update",
			toolCallId: actToolCallId(event.actId),
			status: "in_progress" satisfies AcpToolStatus,
			content: actStandardContent(actProgressContent(active)),
			_meta: actMeta(event, active.start, active.contentTruncated),
		},
	];
}

export function acpUpdatesForSessionEvent(
	event: AgentConnectionSessionEvent,
	state: AcpEventMappingState = {},
): AcpSessionUpdate[] {
	switch (event.type) {
		case "act_event":
			return actUpdates(event, state);

		case "message_update":
			if (event.message.role !== "assistant") return [];
			return assistantDeltaUpdates(event.assistantMessageEvent);

		case "tool_execution_start": {
			const cell = event.toolName === IPYTHON_TOOL_NAME ? ipythonCellSource(event.args) : undefined;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: event.toolCallId,
					title: event.toolName === IPYTHON_TOOL_NAME ? "IPython cell" : event.toolName,
					kind: acpToolKind(event.toolName),
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: cell !== undefined ? { code: cell } : event.args,
				},
			];
		}

		case "tool_execution_end": {
			const text = toolResultText(event.result);
			const rich = event.toolName === IPYTHON_TOOL_NAME ? ipythonRichOutput(event.result) : undefined;
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: event.toolCallId,
					status: (event.isError ? "failed" : "completed") satisfies AcpToolStatus,
					...(text ? { content: [{ type: "content", content: textContent(text) }] } : {}),
					...(rich ? { _meta: primeAgentMeta({ ipython: rich }) } : {}),
				},
			];
		}

		// Bash runs outside the tool-call lifecycle, so it gets a synthetic tool
		// call keyed by run id to keep incremental output addressable.
		case "bash_start":
			state.activeBashRunId = event.runId;
			return [
				{
					sessionUpdate: "tool_call",
					toolCallId: bashToolCallId(event.runId),
					title: event.command,
					kind: "execute" satisfies AcpToolKind,
					status: "in_progress" satisfies AcpToolStatus,
					rawInput: { command: event.command },
				},
			];

		case "bash_output":
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(state.activeBashRunId),
					status: "in_progress" satisfies AcpToolStatus,
					content: [{ type: "content", content: textContent(event.chunk) }],
				},
			];

		case "bash_end":
			if (state.activeBashRunId === event.runId) state.activeBashRunId = undefined;
			return [
				{
					sessionUpdate: "tool_call_update",
					toolCallId: bashToolCallId(event.runId),
					status: (event.exitCode === 0 && !event.cancelled ? "completed" : "failed") satisfies AcpToolStatus,
				},
			];

		// Compaction, subagents, goals and recaps have no ACP equivalent: surface
		// them as namespaced metadata rather than distorting a standard update.
		case "compaction_end":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						compaction: {
							tokensBefore: event.result?.tokensBefore,
							summary: event.result?.summary,
						},
					}),
				},
			];

		case "rlm_child_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						subagents: [
							{
								id: event.child.id,
								sessionName: event.child.sessionName,
								status: event.child.status,
								model: event.child.model,
								tokenCount: event.child.tokenCount,
								error: event.child.error,
							},
						],
					}),
				},
			];

		// Goals, continual-harness refinement, and agent-to-agent messaging are
		// prime-agent concepts with no ACP counterpart. They are still part of a
		// turn's observable behavior, so they surface as namespaced metadata
		// instead of being dropped.
		case "goal_update":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						goal: {
							status: event.goal.status,
							objective: event.goal.objective,
							tokenBudget: event.goal.tokenBudget,
							tokensUsed: event.goal.tokensUsed,
						},
					}),
				},
			];

		case "refine_complete":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						refinement: {
							status: "complete",
							summary: event.result.summary,
							changes: event.result.appliedEdits
								?.filter((edit) => edit.applied)
								.map((edit) => `${edit.action} ${edit.kind}:${edit.id}`),
						},
					}),
				},
			];

		case "refine_failed":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({ refinement: { status: "failed", error: event.error } }),
				},
			];

		case "ipython_sent_agent_message":
			return [
				{
					sessionUpdate: "session_info_update",
					_meta: primeAgentMeta({
						agentMessage: {
							toolCallId: event.toolCallId,
							target: event.message.target.sessionName ?? event.message.target.sessionId,
							deliveryStatus: event.message.deliveryStatus,
						},
					}),
				},
			];

		default:
			return [];
	}
}

const BASH_TOOL_CALL_PREFIX = "prime-agent-bash";

export function bashToolCallId(runId: string | undefined): string {
	return runId ? `${BASH_TOOL_CALL_PREFIX}-${runId}` : BASH_TOOL_CALL_PREFIX;
}

export type { PrimeAgentSessionMeta };
