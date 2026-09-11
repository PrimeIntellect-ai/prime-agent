import type { Agent, AgentEvent, AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ServiceTier, Usage } from "@earendil-works/pi-ai";
import { startsAgentRun } from "../../core/agent-messages.js";
import { addLoginGuidanceToAuthError, isLikelyAuthenticationError } from "../../core/auth-guidance.js";
import type {
	ExtensionRunner,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	TurnEndEvent,
	TurnStartEvent,
} from "../../core/extensions/index.js";
import type { KernelSentAgentMessage } from "../../core/kernel/index.js";
import {
	type ActionStore,
	type SessionActionSnapshot,
	transitionSessionAction,
} from "../../core/session-action-store.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { RlmChildAgentSnapshot } from "../children/child-types.js";
import type { SessionCompaction, SessionCompactionEvent } from "../compaction/controller.js";
import type { GoalState } from "../goals/contracts.js";
import { primaryDeliveryRecord, type QueuedSessionAction } from "../prepared-actions.js";
import type { SessionRefinement } from "../refinement/controller.js";
import type { RefinementResult } from "../refinement/types.js";
import type { SessionBashEvent } from "../tools/bash.js";
import type { SessionRetry, SessionRetryEvent } from "./retry.js";

export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "ipython_sent_agent_message";
			toolCallId: string;
			message: KernelSentAgentMessage;
	  }
	| { type: "session_action_update"; actions: SessionActionSnapshot }
	| SessionCompactionEvent
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; serviceTier: ServiceTier }
	| SessionRetryEvent
	| { type: "rlm_child_update"; child: RlmChildAgentSnapshot }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| SessionBashEvent
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export interface SessionEventsHost {
	getAgent(): Pick<Agent, "subscribe"> & { state: { messages: AgentMessage[]; errorMessage?: string } };
	getStore(): Pick<SessionManager, "recordGitStateIfChanged" | "appendCustomMessageEntry" | "appendMessage">;
	getExtensions(): Pick<ExtensionRunner, "emit" | "emitMessageEnd">;
	getRetry(): Pick<
		SessionRetry,
		| "observeAgentEnd"
		| "resolve"
		| "observeAssistantEnd"
		| "isRetrying"
		| "retryError"
		| "attempt"
		| "finishActiveRetryWithFailure"
	>;
	getCompaction(): Pick<SessionCompaction, "resetOverflowRecovery">;
	getRefinement(): Pick<
		SessionRefinement,
		"observeAssistantEnd" | "serialized" | "_consumePendingRequestedRefine" | "_scheduleAutoRefineAfterAgentEnd"
	>;
	addAutonomousUsage(usage: Usage): void;
	applyLateMessages(message: AgentMessage): void;
	notifyCheckpoints(): void;
	settleAgentMessage(id: string | undefined, leg: "delivery" | "completion", error?: Error): void;
	getSnapshot(): SessionActionSnapshot;
	accountAssistantBudget(message: AssistantMessage): Promise<boolean> | undefined;
	finishGoal(message: AssistantMessage): void;
	checkCompaction(message: AssistantMessage): Promise<boolean>;
}
export class SessionEvents {
	private listeners: AgentSessionEventListener[] = [];
	private lastSnapshot: SessionActionSnapshot = { queuedCount: 0, steering: [], followUps: [] };
	private _queue: Promise<void> = Promise.resolve();
	get queue(): Promise<void> {
		return this._queue;
	}
	private lastAssistant: AssistantMessage | undefined;
	private turnIndex = 0;
	private unsubscribeAgent?: () => void;
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionEventsHost,
	) {}
	enqueue(work: () => void): void {
		this._queue = this._queue.then(work, work);
		this._queue.catch(() => {});
	}
	dispose(): void {
		this.disconnectFromAgent();
		this.listeners = [];
	}

	emit(event: AgentSessionEvent): void {
		for (const l of this.listeners) {
			try {
				l(event);
			} catch {
				// A failing observer must not prevent other subscribers from
				// receiving lifecycle and persistence events.
			}
		}
	}

	emitQueueUpdate(): void {
		const actions = this.host.getSnapshot();
		if (JSON.stringify(actions) === JSON.stringify(this.lastSnapshot)) return;
		this.lastSnapshot = actions;
		this.emit({ type: "session_action_update", actions });
	}

	capturingCancelledAction(message: AgentMessage): QueuedSessionAction | undefined {
		return this.actions
			.ownedActions()
			.find(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages?.has(message) === true,
			);
	}

	hasCancelledDispatchCapture(): boolean {
		return this.actions
			.ownedActions()
			.some(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages !== undefined,
			);
	}

	handleAgentEvent = (event: AgentEvent): void => {
		this.host.getRetry().observeAgentEnd(event);
		if (event.type === "message_start" || event.type === "message_end") {
			for (const action of this.actions.ownedActions()) {
				if (
					action.payload.kind !== "turn" ||
					!action.payload.captureRunMessages ||
					action.payload.cancelledDispatchEnded
				) {
					continue;
				}
				const primary = primaryDeliveryRecord(action);
				if (event.message === primary.message || primary.started) {
					action.payload.captureRunMessages.add(event.message);
				}
			}
		} else if (event.type === "agent_end") {
			const captured = new Set<AgentMessage>();
			for (const action of this.actions.ownedActions()) {
				if (action.payload.kind === "turn" && action.payload.captureRunMessages) {
					for (const message of action.payload.captureRunMessages) captured.add(message);
					action.payload.cancelledDispatchEnded = true;
				}
			}
			if (captured.size > 0) {
				this.host.getAgent().state.messages = this.host
					.getAgent()
					.state.messages.filter((message) => !captured.has(message));
			}
		}
		if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "custom")) {
			for (const action of this.actions.actionsForMessage(event.message)) {
				const record =
					action.payload.kind === "turn"
						? action.payload.records.find((candidate) => candidate.message === event.message)
						: undefined;
				if (record) record.started = true;
				if (record?.role === "primary") {
					this.actions.ticketFor(action).settleDelivered({ status: "delivered" });
					this.host.settleAgentMessage(action.agentMessageId, "delivery");
				}
			}
		} else if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "custom")) {
			for (const action of this.actions.actionsForMessage(event.message)) {
				const record =
					action.payload.kind === "turn"
						? action.payload.records.find((candidate) => candidate.message === event.message)
						: undefined;
				if (record) record.durable = true;
				if (record?.role === "primary" && action.lifecycle.state === "committing") {
					transitionSessionAction(action, {
						state: "running",
						execution: "agent_turn",
					});
					this.host.notifyCheckpoints();
					this.emitQueueUpdate();
				}
			}
		}
		this._queue = this._queue.then(
			() => this.processAgentEvent(event),
			() => this.processAgentEvent(event),
		);
		this._queue.catch(() => {});
	};

	findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	addLoginGuidanceToAuthError(event: AgentEvent): void {
		const message =
			event.type === "message_end" && event.message.role === "assistant"
				? (event.message as AssistantMessage)
				: event.type === "agent_end"
					? this.findLastAssistantInMessages(event.messages)
					: undefined;
		if (!message || message.stopReason !== "error" || !message.errorMessage) {
			return;
		}
		if (!isLikelyAuthenticationError(message.errorMessage)) {
			return;
		}
		message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
	}

	async processAgentEvent(event: AgentEvent): Promise<void> {
		let clearedDispatchEnded = false;
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
			this.host.applyLateMessages(event.message);
		}
		if (event.type === "message_start" || event.type === "message_end") {
			const cleared = this.capturingCancelledAction(event.message);
			if (cleared?.payload.kind === "turn" && cleared.payload.captureRunMessages) {
				const captured = cleared.payload.captureRunMessages;
				this.host.getAgent().state.messages = this.host
					.getAgent()
					.state.messages.filter((message) => !captured.has(message));
				return;
			}
		}
		if (event.type === "agent_end") {
			const cleared = this.actions
				.ownedActions()
				.filter(
					(action) =>
						action.lifecycle.state === "cancelled" &&
						action.payload.kind === "turn" &&
						action.payload.captureRunMessages !== undefined,
				);
			if (cleared.length > 0) {
				clearedDispatchEnded = true;
				const removed = new Set(
					cleared.flatMap((action) =>
						action.payload.kind === "turn" ? [...(action.payload.captureRunMessages ?? [])] : [],
					),
				);
				this.host.getAgent().state.messages = this.host
					.getAgent()
					.state.messages.filter((message) => !removed.has(message));
				this.host.getAgent().state.errorMessage = undefined;
				this.lastAssistant = undefined;
				for (const action of cleared) this.actions.releaseTerminal(action);
				this.host.notifyCheckpoints();
				this.host.getRetry().resolve();
			}
		}

		if (event.type === "message_start" && startsAgentRun(event.message)) {
			this.host.getCompaction().resetOverflowRecovery();
		}

		await this.emitExtensionEvent(event);
		if (event.type === "message_start" || event.type === "message_end") {
			const cleared = this.capturingCancelledAction(event.message);
			if (cleared?.payload.kind === "turn" && cleared.payload.captureRunMessages) {
				const captured = cleared.payload.captureRunMessages;
				this.host.getAgent().state.messages = this.host
					.getAgent()
					.state.messages.filter((message) => !captured.has(message));
				return;
			}
		}

		this.addLoginGuidanceToAuthError(event);

		this.emit(event);

		if (event.type === "message_end") {
			if (event.message.role === "custom") {
				this.host
					.getStore()
					.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
					);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				this.host.getStore().appendMessage(event.message);
			}

			if (event.message.role === "assistant") {
				this.lastAssistant = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error") {
					this.host.addAutonomousUsage(assistantMsg.usage);
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					this.host.getRefinement().observeAssistantEnd();
					// In serialized mode, kick off background refinement planning
					// immediately after the primary stream finishes, while tools
					// are still executing. The plan is awaited at shouldStopAfterTurn
					// before applying, so planning overlaps tools only — never another
					// model request.
				}
				if (assistantMsg.stopReason !== "error") {
					this.host.getCompaction().resetOverflowRecovery();
				}
				this.host.getRetry().observeAssistantEnd(assistantMsg);
				const budgetNotice = this.host.accountAssistantBudget(assistantMsg);
				if (budgetNotice) await budgetNotice;
			}
		}

		if (clearedDispatchEnded) {
			return;
		}

		if (event.type === "agent_end") {
			const msg =
				this.lastAssistant ??
				(this.host.getRetry().isRetrying ? this.findLastAssistantInMessages(event.messages) : undefined);
			this.lastAssistant = undefined;
			if (!msg) {
				this.host.getRetry().resolve();
				return;
			}

			const retry = this.host.getRetry().retryError(msg);
			if (retry && (await retry)) return;

			const compactionWillRetry = await this.host.checkCompaction(msg);
			if (compactionWillRetry && this.host.getRetry().attempt > 0) {
				return;
			}
			this.host.getRetry().finishActiveRetryWithFailure(msg);
			this.host.getRetry().resolve();
			if (!compactionWillRetry) {
				this.host.finishGoal(msg);
				// In serialized mode, agent-callable refine.run is serviced
				// at the shouldStopAfterTurn boundary, not here at agent_end.
				if (!this.host.getRefinement().serialized) {
					const consumedRequestedRefine = this.host.getRefinement()._consumePendingRequestedRefine();
					if (!consumedRequestedRefine) {
						this.host.getRefinement()._scheduleAutoRefineAfterAgentEnd();
					}
				}
			}
		}
	}

	replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _processAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	async emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this.turnIndex = 0;
			this.host.getStore().recordGitStateIfChanged();
			await this.host.getExtensions().emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			// Also capture at end of turn so commits made during the run (e.g. via a bash tool) land.
			this.host.getStore().recordGitStateIfChanged();
			await this.host.getExtensions().emit({
				type: "agent_end",
				messages: event.messages,
			});
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this.turnIndex,
				timestamp: Date.now(),
			};
			await this.host.getExtensions().emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this.turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this.host.getExtensions().emit(extensionEvent);
			this.turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this.host.getExtensions().emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this.host.getExtensions().emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this.host.getExtensions().emitMessageEnd(extensionEvent);
			if (replacement) {
				this.replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this.host.getExtensions().emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this.host.getExtensions().emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this.host.getExtensions().emit(extensionEvent);
		}
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.push(listener);

		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) {
				this.listeners.splice(index, 1);
			}
		};
	}

	disconnectFromAgent(): void {
		if (this.unsubscribeAgent) {
			this.unsubscribeAgent();
			this.unsubscribeAgent = undefined;
		}
	}

	reconnectToAgent(): void {
		if (this.unsubscribeAgent) return; // Already connected
		this.unsubscribeAgent = this.host.getAgent().subscribe(this.handleAgentEvent);
	}
}
