import type { Usage } from "@earendil-works/pi-ai";
import type { ActCancellationCapability } from "./act-cancellation.js";

export const ACT_EVENT_PROMPT_MAX_CHARS = 16_384;
export const ACT_EVENT_CELL_TEXT_MAX_CHARS = 65_536;
export const ACT_EVENT_ERROR_MAX_CHARS = 4096;

export interface ActEventModel {
	provider: string;
	id: string;
	name?: string;
}

interface ActEventBase {
	type: "act_event";
	actId: string;
	depth?: number;
	parentActId?: string;
	outerToolCallId: string;
	sequence: number;
}

export function actEventDepth(event: { depth?: number }): number {
	return Number.isSafeInteger(event.depth) && (event.depth ?? 0) > 0 ? (event.depth as number) : 1;
}

export interface ActStartEvent extends ActEventBase {
	event: "start";
	prompt: string;
	promptTruncated: boolean;
	model: ActEventModel;
	thinkingLevel?: string;
	directingModel?: ActEventModel;
	directingThinkingLevel?: string;
	cancellationCapability: ActCancellationCapability;
}

export interface ActAssistantDeltaEvent extends ActEventBase {
	event: "assistant_delta";
	stream: "thinking" | "text";
	text: string;
	textTruncated: boolean;
}

export interface ActCellStartEvent extends ActEventBase {
	event: "cell_start";
	cellId: string;
	code: string;
	codeTruncated: boolean;
}

export interface ActCellTerminalEvent extends ActEventBase {
	event: "cell_terminal";
	cellId: string;
	durationMs?: number;
	status: "ok" | "error" | "cancelled";
	stdout: string;
	stdoutTruncated: boolean;
	stderr: string;
	stderrTruncated: boolean;
	result?: string;
	resultTruncated: boolean;
	error?: string;
	errorTruncated: boolean;
}

export interface ActTerminalEvent extends ActEventBase {
	event: "terminal";
	status: "done" | "cancelled" | "error";
	prompt: string;
	promptTruncated: boolean;
	model: ActEventModel;
	thinkingLevel?: string;
	directingModel?: ActEventModel;
	directingThinkingLevel?: string;
	cancellationCapability: ActCancellationCapability;
	usage: Usage;
	error?: string;
	errorTruncated: boolean;
}

export type ActProjectionEvent =
	| ActStartEvent
	| ActAssistantDeltaEvent
	| ActCellStartEvent
	| ActCellTerminalEvent
	| ActTerminalEvent;

export function truncateActEventText(text: string, maxChars: number): { text: string; truncated: boolean } {
	if (text.length <= maxChars) return { text, truncated: false };
	return { text: text.slice(0, maxChars), truncated: true };
}
