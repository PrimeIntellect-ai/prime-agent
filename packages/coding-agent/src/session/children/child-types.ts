import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../agent-session.js";
import type { RlmSubagentRegistryEntry } from "./runtime-contracts.js";

export type RlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface RlmChildAgentActivity {
	kind: "waiting" | "writing" | "executing";
	toolName?: string;
}

export interface RlmChildAgentSnapshot {
	id: string;
	parentId?: string;
	activeSessionId?: string;
	sessionName?: string;
	model?: string;
	label: string;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount?: number;
	tokenCount?: number;
	recap?: string;
	sessionDir: string;
	activity?: RlmChildAgentActivity;
	repliedSinceTask?: boolean;
	error?: string;
}

export interface RlmChildRun {
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<Api>;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount: number;
	activity?: RlmChildAgentActivity;
	error?: string;
	abort: () => void;
	publication: ChildDeferred;
	/** Resolves after terminal result publication and detached-run cleanup finish. */
	settlement: ChildDeferred;
	/** Child session, once its runtime exists. Used to cancel nested child runs. */
	session?: AgentSession;
	settled: boolean;
	/** Do not inject a late terminal notice after the parent session is aborted. */
	suppressTerminalNotice?: boolean;
	/** Excluded from future strong barriers after an authoritative cancellation cut. */
	abandonedForQuiescence?: boolean;
	/** Selector snapshot for an admitted explicit delete. */
	detachedDeletion?: RlmSubagentRegistryEntry;
	/** Shared physical runtime cleanup owned by the explicit-delete path. */
	deletionCleanup?: Promise<void>;
	deletionCleanupObserver?: Promise<boolean>;
	/** Resolves when a deletion may release its selector reservation. */
	deletionReservation: ChildDeferred;
	deletionCleanupFailed?: boolean;
	deletionRunFinished?: boolean;
	deletionNotice?: Promise<void>;
	deletionFailureNotice?: Promise<void>;
	deletionNeedsCompletionNotice?: boolean;
	completeDeletion?: () => Promise<void>;
	reportDeletionCleanupFailure?: (error: unknown) => Promise<void>;
	emitUpdate?: () => void;
	lastEmittedUpdate?: string;
	unsubscribe?: () => void;
}

export interface RetainedRlmChild {
	session: AgentSession;
	run?: RlmChildRun;
}

export interface ChildDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

export function createChildDeferred(): ChildDeferred {
	const deferred = {} as ChildDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

export function compactRlmText(text: string, maxLength = 160): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

// Child-agent label: collapse to one line but keep the full prompt — the TUI
// truncates to the visible width and elides shared prefixes, so capping here
// would only hide the divergence between near-identical sibling prompts.
export function rlmChildLabel(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim() || "child agent";
}

export function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

export function noopRlmChildAbort(): void {}
export function noopRlmChildEventUnsubscribe(): void {}
