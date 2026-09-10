import type { Agent, AgentContext, AgentMessage, GetContinuationMessagesContext } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import {
	createGoalContextMessage,
	GOAL_CONTEXT_CUSTOM_TYPE,
	type GoalHostResponse,
	type GoalState,
	goalHostResponse,
	validateGoalBudget,
	validateGoalObjective,
} from "../../core/goals.js";
import type { ActionStore } from "../../core/session-action-store.js";
import { parseGoalSlashCommand } from "../../goals/commands.js";
import type { GoalController } from "../../goals/controller.js";
import type { SessionInputAdmission } from "../input/input-admission.js";
import type { SessionInputScheduler } from "../input/input-scheduler.js";
import {
	createPreparedTurnAction,
	normalizeMessageContent,
	primaryDeliveryRecord,
	type QueuedSessionAction,
} from "../prepared-actions.js";

export interface SessionGoalContinuationHost {
	getGoalState(): GoalState;
	queuePrompt: SessionInputAdmission["queuePreparedPrompt"];
	getScheduler(): Pick<SessionInputScheduler, "admissionPaused" | "suspended">;
	isDisposed(): boolean;
	isDisposing(): boolean;
	hasUnsettledChildWork(): boolean;
	ensureRuntimeActive(context?: AgentContext): void;
	admit: SessionInputAdmission["admitSessionInput"];
	cancelActions(predicate: (action: QueuedSessionAction) => boolean, error: Error): QueuedSessionAction[];
	clearPendingGoalContexts(): void;
	emitQueueUpdate(): void;
	emitGoalUpdate(): void;
	validate(): Promise<void>;
	isStreaming(): boolean;
	includesGoals(): boolean;
	getAgent(): Pick<Agent, "removeQueuedMessages">;
}
export class SessionGoalContinuation {
	private _awaitsChildWork = false;
	private _abortInProgress = false;
	private _thresholdContinuation: AgentMessage | undefined;
	constructor(
		readonly controller: GoalController,
		private readonly actions: Pick<ActionStore<QueuedSessionAction>, "unfinishedActions">,
		private readonly host: SessionGoalContinuationHost,
	) {}
	get awaitsChildWork(): boolean {
		return this._awaitsChildWork;
	}

	get abortInProgress(): boolean {
		return this._abortInProgress;
	}

	get thresholdContinuation(): AgentMessage | undefined {
		return this._thresholdContinuation;
	}

	beginAbort(): void {
		this._abortInProgress = this.controller.state.status === "active";
	}

	finishAbort(): void {
		this._abortInProgress = false;
	}

	deferUntilChildSettlement(): void {
		this._awaitsChildWork = true;
	}

	accountAssistantBudget(message: AssistantMessage): Promise<boolean> | undefined {
		if (!this.controller.accountAssistantMessage(message)) return undefined;
		const notice = createGoalContextMessage(this.controller.state, "budget_limit");
		const normalized = normalizeMessageContent(notice.content);
		return this.host.queuePrompt("steer", normalized.text, normalized.images, {
			message: notice,
			resumeIfIdle: true,
		});
	}

	clearQueuedGoalContexts(): void {
		this._awaitsChildWork = false;
		this.host.clearPendingGoalContexts();
		this.host
			.getAgent()
			.removeQueuedMessages(
				(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_CUSTOM_TYPE,
			);
		this.host.cancelActions(
			(action) =>
				action.payload.kind === "turn" && action.payload.customMessage?.customType === GOAL_CONTEXT_CUSTOM_TYPE,
			new Error("Queued goal context was cleared before delivery."),
		);
		this.host.emitQueueUpdate();
	}

	startGoal(objectiveText: string, tokenBudget: number | undefined): GoalState {
		const objective = validateGoalObjective(objectiveText);
		const budget = validateGoalBudget(tokenBudget);
		this._awaitsChildWork = false;
		return this.controller.start(objective, budget);
	}

	clearGoal(): void {
		this.clearQueuedGoalContexts();
		this.controller.clear();
	}

	pauseGoal(): void {
		this.clearQueuedGoalContexts();
		this.controller.pause();
	}

	async resumeGoal(): Promise<void> {
		if (this.controller.resume()) {
			await this.runOrQueueGoalContext("continuation");
		}
	}

	finishGoalForTerminalAssistantMessage(message: AssistantMessage): void {
		if (this.controller.state.status !== "active") {
			return;
		}

		if (message.stopReason === "aborted") {
			this._abortInProgress = false;
			return;
		}

		if (message.stopReason === "error") {
			if (this._abortInProgress) {
				this._abortInProgress = false;
				return;
			}
			this.controller.fail(message.errorMessage || "Assistant response failed");
		}
	}

	stopGoalContinuationForTerminalMessage(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			return false;
		}
		try {
			this.finishGoalForTerminalAssistantMessage(message);
		} catch {
			// Goal hooks must not reject; listener failures should not crash the agent loop.
		}
		return true;
	}

	maybeResumeGoalContinuationAfterRlmWork(): void {
		if (!this._awaitsChildWork) return;
		if (this.host.isDisposed() || this.host.isDisposing() || this.host.hasUnsettledChildWork()) return;
		if (this.controller.state.status !== "active" || !this.controller.state.objective) {
			this._awaitsChildWork = false;
			return;
		}
		// Keep the deferral while admission is paused or the pump is suspended
		// (post-abort); the pause release and resumeQueuedWork retry.
		if (this.host.getScheduler().admissionPaused || this.host.getScheduler().suspended) return;
		const goalBeforeResume = this.controller.checkpoint();
		try {
			this.host.ensureRuntimeActive();
			this.controller.recordContinuation();
			const message = createGoalContextMessage(this.controller.state, "continuation");
			const normalized = normalizeMessageContent(message.content);
			// No front: a settling child's terminal notice must be read first.
			this.host.admit(
				createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				}),
			);
			this._awaitsChildWork = false;
		} catch {
			// Admission can race a new pause; roll back so the retry re-counts.
			this.controller.restore(goalBeforeResume, { restoreClock: false });
		}
	}

	runOrQueueGoalContext(kind: "continuation" | "objective_updated", images?: ImageContent[]): void {
		if (!this.controller.state.objective) return;
		this.host.ensureRuntimeActive();
		const message = createGoalContextMessage(this.controller.state, kind, images);
		const normalized = normalizeMessageContent(message.content);
		const action = createPreparedTurnAction("followUp", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
		});
		this.host.admit(action, { front: true, wake: false });
	}

	async handleGoalSlashCommand(text: string, images: ImageContent[] | undefined): Promise<boolean> {
		const command = parseGoalSlashCommand(text);
		if (!command) {
			return false;
		}

		if (command.kind === "status") {
			this.host.emitGoalUpdate();
			return true;
		}

		if (command.kind === "clear") {
			this.clearGoal();
			return true;
		}

		if (command.kind === "pause") {
			this.pauseGoal();
			return true;
		}

		if (command.kind === "resume") {
			await this.resumeGoal();
			return true;
		}

		const previousWasActive = this.controller.state.status === "active";
		if (!this.host.isStreaming()) {
			await this.host.validate();
		}
		this.host.ensureRuntimeActive();
		this.clearQueuedGoalContexts();
		this.startGoal(command.objective, command.tokenBudget);
		await this.runOrQueueGoalContext(previousWasActive ? "objective_updated" : "continuation", images);
		return true;
	}

	queueGoalContinuationForThresholdCompaction(message: AssistantMessage): boolean {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this.controller.state.status !== "active" || !this.controller.state.objective) {
			return false;
		}
		const alreadyQueued = this._thresholdContinuation;
		if (
			alreadyQueued !== undefined &&
			this.actions.unfinishedActions().some((action) => {
				if (action.payload.kind !== "turn" || primaryDeliveryRecord(action).message !== alreadyQueued) return false;
				// A running continuation may already need a successor; only undelivered actions deduplicate.
				return (
					action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					action.lifecycle.state === "committing"
				);
			})
		) {
			return true;
		}
		try {
			this.host.ensureRuntimeActive();
			this.controller.recordContinuation();
			const goalMessage = createGoalContextMessage(this.controller.state, "continuation");
			const normalized = normalizeMessageContent(goalMessage.content);
			this.host.admit(
				createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: goalMessage,
				}),
			);
			this._thresholdContinuation = goalMessage;
			return true;
		} catch {
			return false;
		}
	}

	clearQueuedGoalContinuationAfterCancelledThresholdCompaction(
		queuedGoalContinuation: AgentMessage | undefined,
	): void {
		if (queuedGoalContinuation === undefined) return;
		const cancelled = this.host.cancelActions(
			(action) => action.payload.kind === "turn" && primaryDeliveryRecord(action).message === queuedGoalContinuation,
			new Error("Queued goal continuation was cleared before delivery."),
		);
		this._thresholdContinuation = undefined;
		// A stale marker (continuation already consumed) matches no action; only an
		// actual cancellation may roll back its queue-time continuationsUsed increment.
		if (cancelled.length === 0) return;
		this.controller.cancelContinuation();
		this.host.emitQueueUpdate();
	}

	handleGoalHostRequest(type: string, payload: Record<string, unknown> = {}): GoalHostResponse {
		if (!this.host.includesGoals()) {
			throw new Error("goals are disabled in this session");
		}
		switch (type) {
			case "goal.get":
				return goalHostResponse(this.host.getGoalState(), false);
			case "goal.create": {
				if (typeof payload.objective !== "string") {
					throw new Error("goal.create objective must be a string");
				}
				if (payload.token_budget !== undefined && typeof payload.token_budget !== "number") {
					throw new Error("goal.create token_budget must be an integer when provided");
				}
				return goalHostResponse(this.createGoalFromHost(payload.objective, payload.token_budget), false);
			}
			case "goal.complete":
				return goalHostResponse(this.completeGoalFromHost(), true);
			default:
				throw new Error(`unknown goal request type "${type}"`);
		}
	}

	createGoalFromHost(objective: string, tokenBudget: number | undefined): GoalState {
		switch (this.controller.state.status) {
			case "active":
				throw new Error(
					"cannot create a new goal because this thread already has an active goal; run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear",
				);
			case "paused":
				throw new Error(
					"cannot create a new goal because a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			case "budget_limited":
				throw new Error(
					"cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			default:
				// idle, or a terminal record (complete / error): nothing pending, start fresh.
				return this.startGoal(objective, tokenBudget);
		}
	}

	completeGoalFromHost(): GoalState {
		// Accounting precedes the completing ipython cell, so its budget-limit
		// context may already be queued and must be withdrawn before completion.
		return this.controller.complete(() => this.clearQueuedGoalContexts());
	}

	async getGoalContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this.stopGoalContinuationForTerminalMessage(context.message)) {
			return [];
		}
		if (signal?.aborted || this.controller.state.status !== "active" || !this.controller.state.objective) {
			return [];
		}
		// Delegating and ending the turn is correct behavior; hold the continuation
		// until descendants settle instead of re-prompting a waiting parent.
		if (this.host.hasUnsettledChildWork()) {
			this._awaitsChildWork = true;
			return [];
		}
		this._awaitsChildWork = false;
		try {
			this.host.ensureRuntimeActive(context.context);
			this.controller.recordContinuation();
			return [createGoalContextMessage(this.controller.state, "continuation")];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this.controller.fail(message);
			} catch {
				// The continuation hook must not reject; listener failures should not crash the agent loop.
			}
			return [];
		}
	}
}
