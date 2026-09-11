import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, isContextOverflow, type Model } from "@earendil-works/pi-ai";
import { formatNoModelSelectedMessage } from "../../core/auth-guidance.js";
import type { ContextUsage } from "../../core/extensions/index.js";
import type { ModelRegistry } from "../../core/model-registry.js";
import { getLatestCompactionEntry, type SessionManager } from "../../core/session-manager.js";
import {
	type CompactionOutcome,
	type CompactionOutcomeReason,
	type CustomMessage,
	createCompactionOutcomeMessage,
} from "../context/messages.js";
import { calculateContextTokens, estimateContextTokens } from "../context/token-estimate.js";
import { type CompactionExecutionOptions, CompactionSkippedError } from "./execution.js";
import { prepareCompaction, shouldCompact } from "./summary.js";
import type { CompactionResult, CompactionSettings } from "./types.js";

export type CompactionReason = "manual" | "threshold" | "overflow" | "requested";
export type SessionCompactionEvent =
	| { type: "compaction_start"; reason: CompactionReason; customInstructions?: string }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
	  };

export interface SessionCompactionHost {
	includesCompactSkill(): boolean;
	getContextUsage(): ContextUsage | undefined;
	getSettings(): CompactionSettings;
	runAutomatic(reason: "overflow" | "threshold" | "requested", willRetry: boolean): Promise<boolean>;
	queueGoalContinuation(message: AssistantMessage): boolean;
	queueAutonomousContinuation(message: AssistantMessage): Promise<AgentMessage | undefined>;
	beginRefinementAbort(): { promise: Promise<unknown>; finish(): void } | undefined;
	getModel(): Model<Api> | undefined;
	isStreaming(): boolean;
	getRequiredAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	getAuth(model: Model<Api>): ReturnType<ModelRegistry["getApiKeyAndHeaders"]>;
	perform(options: CompactionExecutionOptions): Promise<CompactionResult>;
	disconnect(): void;
	reconnect(): void;
	abortSession(): Promise<void>;
	getContinuationState(): { scheduled: boolean; continueAfterSessionInput: boolean };
	afterManualCompaction(signal: AbortSignal, wasScheduled: boolean, continueAfterSessionInput: boolean): void;
	getMessages(): AgentMessage[];
	replaceMessages(messages: AgentMessage[]): void;
	hasAgentQueuedMessages(): boolean;
	hasPendingSessionWork(): boolean;
	scheduleContinuation(continueAfterSessionInput?: boolean): void;
	scheduleRefinement(willContinue: boolean): void;
	takeThresholdAutonomousMessages(): AgentMessage[];
	getThresholdGoalContinuation(): AgentMessage | undefined;
	clearAutonomousContinuations(shouldContinue: boolean, messages: AgentMessage[]): void;
	clearGoalContinuation(message: AgentMessage | undefined): void;
	getSessionStore(): Pick<SessionManager, "appendCustomMessageEntryWithRollback" | "getBranch">;
	retainUnpersistedOutcome(message: CustomMessage): void;
	emit(event: SessionCompactionEvent | Extract<AgentEvent, { type: "message_start" | "message_end" }>): void;
	notifyCheckpoints(): void;
	scheduleInput(): void;
}

export class SessionCompaction {
	private manualAbort: AbortController | undefined;
	private automaticAbort: AbortController | undefined;
	private activeOperation: Promise<void> | undefined;
	private overflowStage: "idle" | "attempted" | "reported" = "idle";
	private pendingRequest: { customInstructions?: string } | undefined;
	private continueAfterThreshold = false;

	constructor(private readonly host: SessionCompactionHost) {}

	handleCompactHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		if (!this.host.includesCompactSkill()) {
			throw new Error("the compact skill is disabled in this session");
		}
		switch (type) {
			case "compact.status": {
				const usage = this.host.getContextUsage();
				return {
					tokens: usage?.tokens ?? null,
					context_window: usage?.contextWindow ?? null,
					percent: usage?.percent ?? null,
					scheduled: this.hasPendingRequest,
				};
			}
			case "compact.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("compact.run instructions must be a string when provided");
				}
				if (!this.host.isStreaming()) {
					return {
						scheduled: false,
						reason: "no active turn; compaction can only be requested while a turn is running",
					};
				}
				const preparation = prepareCompaction(this.host.getSessionStore().getBranch(), this.host.getSettings());
				if (!preparation) {
					const lastEntry = this.host.getSessionStore().getBranch().at(-1);
					return {
						scheduled: false,
						reason: lastEntry?.type === "compaction" ? "already compacted" : "session is too short to compact",
					};
				}
				this.request(instructions);
				return {
					scheduled: true,
					note: "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown compact request type "${type}"`);
		}
	}

	private get model(): Model<Api> | undefined {
		return this.host.getModel();
	}
	get operation(): Promise<void> | undefined {
		return this.activeOperation;
	}
	get isRunning(): boolean {
		return this.automaticAbort !== undefined || this.manualAbort !== undefined;
	}
	get hasPendingRequest(): boolean {
		return this.pendingRequest !== undefined;
	}
	get overflowRecovery(): "idle" | "attempted" | "reported" {
		return this.overflowStage;
	}

	request(customInstructions?: string): void {
		this.pendingRequest = { customInstructions };
	}
	clearRequest(): void {
		this.pendingRequest = undefined;
	}
	requestContinuation(): void {
		this.continueAfterThreshold = true;
	}
	resetContinuation(): void {
		this.continueAfterThreshold = false;
	}
	resetOverflowRecovery(): void {
		this.overflowStage = "idle";
	}
	markOverflowAttempted(): void {
		this.overflowStage = "attempted";
	}
	markOverflowReported(): void {
		this.overflowStage = "reported";
	}
	abort(): void {
		this.manualAbort?.abort();
		this.automaticAbort?.abort();
	}
	abortAutomatic(): void {
		this.automaticAbort?.abort();
	}

	getThresholdContextTokens(
		assistantMessage: AssistantMessage,
		compactionTimestamp: number | undefined,
	): number | undefined {
		const messages = this.host.getMessages();
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex !== null) {
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionTimestamp !== undefined &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= compactionTimestamp
			) {
				return undefined;
			}
			return estimate.tokens;
		}
		if (assistantMessage.stopReason === "error") return undefined;
		return calculateContextTokens(assistantMessage.usage);
	}

	async check(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		queueAutonomousContinuation = true,
	): Promise<boolean> {
		// An abort drops any compaction the model requested this turn, even on the
		// pre-prompt path (skipAbortedCheck=false) which continues to threshold checks.
		if (assistantMessage.stopReason === "aborted") {
			this.clearRequest();
			const refinementAbort = this.host.beginRefinementAbort();
			if (refinementAbort) {
				await refinementAbort.promise.catch(() => undefined);
				refinementAbort.finish();
			}
			if (skipAbortedCheck) return false;
		}

		const settings = this.host.getSettings();
		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip overflow/threshold checks if this assistant message is older than the
		// latest compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.host.getSessionStore().getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		const assistantIsFromBeforeCompaction =
			compactionTimestamp !== undefined && assistantMessage.timestamp <= compactionTimestamp;

		// Case 1: Overflow - takes priority over a pending model request so the error
		// strip + retry still happen; the compaction it runs consumes the request.
		if (
			!assistantIsFromBeforeCompaction &&
			(settings.enabled || this.hasPendingRequest) &&
			sameModel &&
			isContextOverflow(assistantMessage, contextWindow)
		) {
			if (this.overflowRecovery !== "idle") {
				if (this.overflowRecovery === "attempted") {
					this.markOverflowReported();
					this.endUnsuccessfully(
						"overflow",
						"failed",
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
					);
				}
				return false;
			}

			this.markOverflowAttempted();
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.host.getMessages();
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.host.replaceMessages(messages.slice(0, -1));
			}
			return await this.host.runAutomatic("overflow", true);
		}

		if (this.hasPendingRequest) {
			return await this.host.runAutomatic("requested", false);
		}

		if (!settings.enabled || assistantIsFromBeforeCompaction) return false;

		// Case 3: Threshold - context is getting large.
		// Use the full-session estimate so messages appended after the last successful
		// assistant usage are included, matching the /usage context display.
		const contextTokens = this.getThresholdContextTokens(assistantMessage, compactionTimestamp);
		if (contextTokens === undefined) return false;
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			if (queueAutonomousContinuation && this.host.queueGoalContinuation(assistantMessage)) {
				this.requestContinuation();
			} else if (queueAutonomousContinuation && (await this.host.queueAutonomousContinuation(assistantMessage))) {
				this.requestContinuation();
			}
			return await this.host.runAutomatic("threshold", false);
		}
		return false;
	}

	async compact(customInstructions?: string, options: { skipAbort?: boolean } = {}): Promise<CompactionResult> {
		if (options.skipAbort && this.host.isStreaming()) {
			throw new Error("Cannot compact without aborting while the agent is running.");
		}
		const { scheduled: hadPostCompactionContinue, continueAfterSessionInput } = this.host.getContinuationState();
		this.host.disconnect();
		if (!options.skipAbort) await this.host.abortSession();
		let didCompact = false;
		const compactionAbort = new AbortController();
		this.manualAbort = compactionAbort;
		let resolveCompactionOperation: () => void = () => {};
		const compactionOperation = new Promise<void>((resolve) => {
			resolveCompactionOperation = resolve;
		});
		this.activeOperation = compactionOperation;
		this.host.emit({
			type: "compaction_start",
			reason: "manual",
			customInstructions,
		});

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers } = await this.host.getRequiredAuth(this.model);
			const result = await this.host.perform({
				model: this.model,
				apiKey,
				headers,
				customInstructions,
				signal: compactionAbort.signal,
			});

			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result,
				aborted: false,
				willRetry: false,
				customInstructions,
			});
			didCompact = true;
			// A manual compaction satisfies any pending model request; on failure the
			// request stays scheduled for the next turn boundary.
			this.pendingRequest = undefined;
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const skipped = error instanceof CompactionSkippedError;
			this.host.emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : skipped ? message : `Compaction failed: ${message}`,
				errorSeverity: skipped ? "warning" : "error",
				customInstructions,
			});
			throw error;
		} finally {
			this.manualAbort = undefined;
			this.host.reconnect();
			if (this.activeOperation === compactionOperation) {
				this.activeOperation = undefined;
			}
			resolveCompactionOperation();
			this.host.notifyCheckpoints();
			this.host.scheduleInput();
			if (didCompact) {
				this.host.afterManualCompaction(
					compactionAbort.signal,
					hadPostCompactionContinue,
					continueAfterSessionInput,
				);
			}
		}
	}

	endUnsuccessfully(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
		options: {
			aborted?: boolean;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
		} = {},
	): void {
		this.persistOutcome(reason, outcome, message);
		this.host.emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted: options.aborted ?? false,
			willRetry: false,
			// Aborts are user-initiated; they carry no error message on the event.
			errorMessage: options.aborted ? undefined : message,
			errorSeverity: options.errorSeverity,
			customInstructions: options.customInstructions,
		});
	}

	private persistOutcome(reason: CompactionOutcomeReason, outcome: CompactionOutcome, message: string): void {
		let outcomeMessage = createCompactionOutcomeMessage(message, {
			reason,
			outcome,
		});
		try {
			this.host
				.getSessionStore()
				.appendCustomMessageEntryWithRollback(
					outcomeMessage.customType,
					outcomeMessage.content,
					outcomeMessage.display,
					outcomeMessage.details,
				);
		} catch (error) {
			const persistenceError = error instanceof Error ? error.message : String(error);
			outcomeMessage = createCompactionOutcomeMessage(
				`${message}\n\nThis compaction outcome could not be saved to session history: ${persistenceError}`,
				{ reason, outcome },
			);
			// Not in the session file, so context rebuilds would drop the disclosure.
			this.host.retainUnpersistedOutcome(outcomeMessage);
		}
		this.host.getMessages().push(outcomeMessage);
		this.host.emit({ type: "message_start", message: outcomeMessage });
		this.host.emit({ type: "message_end", message: outcomeMessage });
	}

	async runAutomatic(reason: "overflow" | "threshold" | "requested", willRetry: boolean): Promise<boolean> {
		// Any compaction consumes a pending model request and honors its instructions
		// (overflow recovery can fire first and take the request with it).
		const pending = this.pendingRequest;
		this.pendingRequest = undefined;
		const customInstructions = pending?.customInstructions;
		const shouldContinueAfterCompaction =
			(reason === "threshold" || reason === "requested") && this.continueAfterThreshold;
		const queuedAutonomousContinuationsForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction ? this.host.takeThresholdAutonomousMessages() : [];
		const queuedGoalContinuationForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction ? this.host.getThresholdGoalContinuation() : undefined;
		this.continueAfterThreshold = false;

		// Requested/threshold stop the loop on purpose, so a failed or skipped compaction must not stall it.
		// Overflow stays excluded: a failed overflow recovery must not re-issue the overflowing request.
		const resumeAfterFailure = () => {
			if (
				(reason === "requested" || reason === "threshold") &&
				(shouldContinueAfterCompaction || this.host.hasAgentQueuedMessages() || this.host.hasPendingSessionWork())
			) {
				this.host.scheduleContinuation(shouldContinueAfterCompaction);
			}
		};

		this.host.emit({ type: "compaction_start", reason, customInstructions });
		this.automaticAbort = new AbortController();
		let resolveCompactionOperation: () => void = () => {};
		const compactionOperation = new Promise<void>((resolve) => {
			resolveCompactionOperation = resolve;
		});
		this.activeOperation = compactionOperation;

		try {
			const authResult = this.model ? await this.host.getAuth(this.model) : undefined;
			if (!this.model || !authResult || !authResult.ok || !authResult.apiKey) {
				const detail =
					!this.model || !authResult
						? "no model is selected"
						: authResult.ok
							? "no API key is available"
							: authResult.error;
				this.endUnsuccessfully(reason, "failed", `Compaction failed: ${detail}`);
				this.host.clearAutonomousContinuations(
					reason === "threshold" && shouldContinueAfterCompaction,
					queuedAutonomousContinuationsForThisCompaction,
				);
				resumeAfterFailure();
				return false;
			}

			const result = await this.host.perform({
				model: this.model,
				apiKey: authResult.apiKey,
				headers: authResult.headers,
				customInstructions,
				signal: this.automaticAbort.signal,
			});

			this.host.emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
				customInstructions,
			});
			// Queued work lives in both the agent queues and the session-owned queues.
			const hasQueuedMessages = this.host.hasAgentQueuedMessages() || this.host.hasPendingSessionWork();
			const willContinueAfterCompaction = willRetry || shouldContinueAfterCompaction || hasQueuedMessages;

			if (willRetry) {
				const messages = this.host.getMessages();
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.host.replaceMessages(messages.slice(0, -1));
				}

				this.host.scheduleContinuation(true);
				this.host.scheduleRefinement(willContinueAfterCompaction);
				return true;
			} else if (shouldContinueAfterCompaction || hasQueuedMessages) {
				// Compaction can intentionally stop a tool loop between turns.
				// Queued follow-up/steering/custom messages can also be waiting.
				this.host.scheduleContinuation(shouldContinueAfterCompaction);
				this.host.scheduleRefinement(willContinueAfterCompaction);
			} else {
				this.host.scheduleRefinement(willContinueAfterCompaction);
			}
			return false;
		} catch (error) {
			this.host.clearAutonomousContinuations(
				reason === "threshold" && shouldContinueAfterCompaction,
				queuedAutonomousContinuationsForThisCompaction,
			);
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted =
				errorMessage === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			if (aborted) {
				this.host.clearGoalContinuation(queuedGoalContinuationForThisCompaction);
				this.endUnsuccessfully(
					reason,
					"cancelled",
					`${reason === "requested" ? "Requested c" : "C"}ompaction cancelled`,
					{ aborted: true, customInstructions },
				);
				return false;
			}
			if (error instanceof CompactionSkippedError) {
				this.endUnsuccessfully(
					reason,
					"skipped",
					reason === "requested"
						? `Requested compaction skipped: ${errorMessage}`
						: `Auto-compaction skipped: ${errorMessage}`,
					{ errorSeverity: "warning", customInstructions },
				);
				resumeAfterFailure();
				return false;
			}
			this.endUnsuccessfully(
				reason,
				"failed",
				reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: reason === "requested"
						? `Requested compaction failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
				{ customInstructions },
			);
			resumeAfterFailure();
			return false;
		} finally {
			this.automaticAbort = undefined;
			if (this.activeOperation === compactionOperation) {
				this.activeOperation = undefined;
			}
			resolveCompactionOperation();
			this.host.notifyCheckpoints();
			this.host.scheduleInput();
		}
	}
}
