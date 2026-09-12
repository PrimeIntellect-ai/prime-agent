import type { Agent } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { isAgentSessionMessage, isAgentSessionMessagePrompt } from "../../core/agent-messages.js";
import { parseSessionSlashCommand } from "../../core/slash-commands.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	type AsyncBashCompletionDetails,
	type CustomMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
} from "../context/messages.js";
import {
	type ActionStore,
	type DeliveryPolicy,
	type DeliveryRecord,
	type QueuedMessageLane,
	type QueuedMessageMutation,
	type QueuedMessageMutationStatus,
	queuedMessageLaneDeliveryPolicy,
	type SessionAction,
	type SessionActionSnapshot,
} from "./action-store.js";
import type { SessionInputScheduler } from "./input-scheduler.js";
import {
	cloneCustomMessage,
	type createPreparedTurnAction,
	createSessionCommandAction,
	type PreparedTurnPayload,
	primaryDeliveryRecord,
	type QueuedSessionAction,
	queuedAgentMessagePreview,
	type RestoredPromptInput,
	type SessionInputSchedule,
	visibleSessionActionProjection,
} from "./prepared-actions.js";

export interface SessionActionQueueHost {
	formatLabel(text: string): string;
	getScheduler(): Pick<SessionInputScheduler, "invalidatePreparation">;
	getAgent(): Pick<Agent, "state" | "clearAllQueues" | "abort">;
	rearmDigest(): void;
	restoreNextTurnMessages(messages: CustomMessage[]): void;
	notifyCheckpoints(): void;
	emitQueueUpdate(): void;
	settleAgentMessage(id: string | undefined, leg: "delivery" | "completion", error?: Error): void;
	rejectAgentMessage(id: string | undefined, error: Error): void;
	admit(action: QueuedSessionAction, options: { restore: true }): { accepted: boolean };
	queuePrompt(
		schedule: SessionInputSchedule,
		text: string,
		images: ImageContent[] | undefined,
		options: Parameters<typeof createPreparedTurnAction>[3],
	): Promise<boolean>;
	resumeQueuedWork(): boolean;
}
export class SessionActionQueue {
	private _clearEpoch: number = 0;
	get clearEpoch(): number {
		return this._clearEpoch;
	}
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionActionQueueHost,
	) {}
	get steeringStopPending(): boolean {
		return (
			this.actions.queuedActions("next_turn_boundary").length > 0 ||
			this.actions
				.activeActions("next_turn_boundary")
				.some(
					(action) =>
						action.payload.kind === "turn" &&
						(action.lifecycle.state === "selected" || action.lifecycle.state === "preparing"),
				)
		);
	}

	get hasPendingSessionWork(): boolean {
		return this.actions.unfinishedActions().some((action) => {
			const state = action.lifecycle.state;
			return (
				state === "queued" ||
				state === "selected" ||
				state === "preparing" ||
				(state === "committing" && action.payload.kind === "turn" && !primaryDeliveryRecord(action).durable)
			);
		});
	}

	get hasAcceptedPromptInFlight(): boolean {
		return this.actions
			.unfinishedActions()
			.some(
				(action) =>
					action.payload.kind === "turn" &&
					!action.payload.queueVisible &&
					action.payload.acceptedBeforeCompletion,
			);
	}

	cancelSessionActions(
		predicate: (action: QueuedSessionAction) => boolean,
		error: Error,
		candidates = this.actions.clearableActions(),
	): QueuedSessionAction[] {
		const matching = candidates.filter(predicate);
		const previousStates = new Map(matching.map((action) => [action.id, action.lifecycle.state]));
		const preparing = this.actions
			.activeActions()
			.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" && action.lifecycle.state === "preparing",
			);
		const previousAnchor = preparing.at(-1);
		const actions = this.actions.remove(predicate, candidates);
		const restorableMessages: CustomMessage[] = [];
		const removed = new Set(actions);
		if (previousAnchor && removed.has(previousAnchor)) {
			for (const action of preparing) {
				if (!removed.has(action)) action.payload.prepared = undefined;
			}
		}
		for (const action of actions) {
			const ticket = this.actions.ticketFor(action);
			if (
				action.payload.kind === "turn" &&
				(action.payload.acceptedAgentMessage ||
					!action.payload.queueVisible ||
					previousStates.get(action.id) !== "queued")
			) {
				ticket.rejectDelivered(error);
			} else {
				ticket.settleDelivered({ status: "not_applicable" });
			}
			ticket.settleCompleted(error);
			const dispatched = previousStates.get(action.id) === "committing" && action.payload.kind === "turn";
			if (action.payload.kind === "turn") {
				const payload = action.payload;
				const restorable = payload.records
					.filter(
						(record): record is DeliveryRecord & { message: CustomMessage } =>
							(record.role === "next_turn" || (payload.acceptedAgentMessage && record.role === "prefix")) &&
							record.message.role === "custom" &&
							record.message.customType !== HARNESS_DIGEST_CUSTOM_TYPE &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message));
				restorableMessages.push(...restorable);
				// Lazy injection owns digest delivery: a cancelled turn re-arms it
				// instead of restoring a possibly stale digest message.
				if (
					payload.records.some(
						(record) =>
							record.message.role === "custom" && record.message.customType === HARNESS_DIGEST_CUSTOM_TYPE,
					)
				) {
					this.host.rearmDigest();
				}
				if (dispatched) {
					payload.captureRunMessages = new Set(payload.records.map((record) => record.message));
					this.host.getAgent().state.messages = this.host
						.getAgent()
						.state.messages.filter((message) => !payload.captureRunMessages?.has(message));
				}
			}
			if (!dispatched) {
				this.actions.releaseTerminal(action);
			}
		}
		this.host.restoreNextTurnMessages(restorableMessages);
		if (actions.length > 0) this.host.notifyCheckpoints();
		return actions;
	}

	/**
	 * The kernel read the command's result before the notice reached the model, so
	 * the notice has nothing left to report: drop it while it is still queued.
	 * Delivered notices are no longer clearable, which makes this a no-op.
	 */
	withdrawAsyncBashCompletionNotice(details: { pid: number; command: string }): void {
		// One read withdraws one notice: pid reuse can queue an identical key twice,
		// and the read belongs to the older handle, which is the earlier notice.
		const notice = this.actions
			.clearableActions()
			.find((action) => this.isAsyncBashCompletionActionFor(action, details));
		if (!notice) return;
		this.cancelSessionActions(
			(action) => action === notice,
			new Error("Background command completion notice withdrawn: the kernel read the result first."),
		);
		this.host.emitQueueUpdate();
	}

	private isAsyncBashCompletionActionFor(
		action: QueuedSessionAction,
		details: { pid: number; command: string },
	): boolean {
		if (action.payload.kind !== "turn") return false;
		const message = primaryDeliveryRecord(action).message;
		if (message.role !== "custom" || message.customType !== ASYNC_BASH_COMPLETION_CUSTOM_TYPE) return false;
		// pids are reused across handles, so the command has to match too.
		const completion = message.details as AsyncBashCompletionDetails | undefined;
		return completion?.pid === details.pid && completion.command === details.command;
	}

	restoreSessionCommand(
		text: string,
		customMessage: CustomMessage | undefined,
		images: ImageContent[] | undefined,
		schedule: SessionInputSchedule,
		agentMessageId: string | undefined,
	): boolean | undefined {
		if (!isSessionSlashCommandMessage(customMessage) || text !== customMessage.details.command.text) {
			return undefined;
		}
		return this.host.admit(
			createSessionCommandAction(text, customMessage.details.command, images, schedule, {
				agentMessageId,
				source: "internal",
			}),
			{ restore: true },
		).accepted;
	}

	restorePromptInput(schedule: SessionInputSchedule, snapshot: RestoredPromptInput): Promise<boolean> {
		return this.host.queuePrompt(schedule, snapshot.text, snapshot.images, {
			queueKey: snapshot.queueKey,
			agentMessageId: snapshot.agentMessageId,
			content: snapshot.content,
			message: snapshot.customMessage,
			prefixMessages: snapshot.prefixMessages,
			source: "internal",
		});
	}

	async restoreSteeringMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<void> {
		if (
			this.restoreSessionCommand(text, options.customMessage, images, "steer", options.agentMessageId) !== undefined
		)
			return;

		await this.restorePromptInput("steer", {
			text,
			images,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			customMessage: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	async restoreFollowUpMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<boolean> {
		const restoredCommand = this.restoreSessionCommand(
			text,
			options.customMessage,
			images,
			"followUp",
			options.agentMessageId,
		);
		if (restoredCommand !== undefined) return restoredCommand;

		return this.restorePromptInput("followUp", {
			text,
			images,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			customMessage: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const clearable = this.actions
			.clearableActions()
			.filter((action) => action.payload.kind === "session_command" || action.payload.queueVisible);
		if (clearable.some((action) => action.payload.kind === "turn" && action.lifecycle.state === "preparing")) {
			this.host.getScheduler().invalidatePreparation();
		}
		const steering = clearable
			.filter((action) => action.delivery === "next_turn_boundary")
			.map((action) => action.payload.text);
		const followUp = clearable
			.filter((action) => action.delivery === "when_run_idle")
			.map((action) => action.payload.text);
		const promptError = new Error("Queued prompt was cleared before delivery.");
		const agentMessageError = new Error("Queued agent message was cleared before delivery.");
		for (const action of clearable) {
			const error =
				action.payload.kind === "turn" && action.lifecycle.state === "preparing" ? promptError : agentMessageError;
			this.host.settleAgentMessage(action.agentMessageId, "delivery", error);
			this.host.settleAgentMessage(action.agentMessageId, "completion", error);
		}
		const clearableIds = new Set(clearable.map((action) => action.id));
		this.cancelSessionActions((action) => clearableIds.has(action.id), agentMessageError);
		this.host.getAgent().clearAllQueues();
		this.host.emitQueueUpdate();
		return { steering, followUp };
	}

	invalidateQueuedPromptPreparation(): void {
		for (const action of this.actions.clearableActions()) {
			if (action.payload.kind === "turn") action.payload.prepared = undefined;
		}
	}

	clearQueuedAgentMessages(): { steering: string[]; followUp: string[] } {
		this._clearEpoch++;
		// customType identifies agent messages; the text parser covers persisted pre-grammar prompts.
		return this.clearQueuedTurnActionsMatching(
			(action) =>
				isAgentSessionMessage(primaryDeliveryRecord(action).message) ||
				isAgentSessionMessagePrompt(action.payload.text),
		);
	}

	clearQueuedUserMessagesMatching(predicate: (text: string) => boolean): { steering: string[]; followUp: string[] } {
		return this.clearQueuedTurnActionsMatching((action) => predicate(action.payload.text));
	}

	private clearQueuedTurnActionsMatching(matches: (action: QueuedSessionAction) => boolean): {
		steering: string[];
		followUp: string[];
	} {
		const ownedActions = this.actions.ownedActions();
		const dispatchedTurnCount = ownedActions.filter(
			(action) =>
				action.payload.kind === "turn" &&
				(action.lifecycle.state === "committing" || action.lifecycle.state === "running"),
		).length;
		const matching = ownedActions.filter(
			(action) =>
				action.payload.kind === "turn" &&
				action.agentMessageId !== undefined &&
				matches(action) &&
				(action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					(action.lifecycle.state === "committing" &&
						dispatchedTurnCount === 1 &&
						!primaryDeliveryRecord(action).started)),
		);
		if (matching.length === 0) return { steering: [], followUp: [] };
		const removedTexts = (delivery: DeliveryPolicy) =>
			[
				...matching.filter((action) => action.delivery === delivery && action.lifecycle.state === "queued"),
				...matching.filter((action) => action.delivery === delivery && action.lifecycle.state !== "queued"),
			].map((action) => action.payload.text);
		const removedSteering = removedTexts("next_turn_boundary");
		const removedFollowUp = removedTexts("when_run_idle");
		const acceptedError = new Error("Accepted agent message was cleared before delivery.");
		const queuedError = new Error("Queued agent message was cleared before delivery.");
		for (const action of matching) {
			const error =
				action.payload.kind === "turn" && action.payload.acceptedAgentMessage ? acceptedError : queuedError;
			this.host.rejectAgentMessage(action.agentMessageId, error);
		}
		for (const [accepted, error] of [
			[true, acceptedError],
			[false, queuedError],
		] as const) {
			const ids = new Set(
				matching
					.filter((action) => action.payload.kind === "turn" && action.payload.acceptedAgentMessage === accepted)
					.map((action) => action.id),
			);
			if (ids.size > 0) this.cancelSessionActions((action) => ids.has(action.id), error, matching);
		}
		if (
			matching.some(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages,
			)
		) {
			this.host.getAgent().abort();
		}
		this.host.emitQueueUpdate();
		return { steering: removedSteering, followUp: removedFollowUp };
	}

	mutateQueuedMessage(
		lane: QueuedMessageLane,
		index: number,
		expectedText: string,
		mutation: QueuedMessageMutation,
	): QueuedMessageMutationStatus {
		const policy = queuedMessageLaneDeliveryPolicy(lane);
		const projection = visibleSessionActionProjection(this.actions.queuedActions(policy));
		const item = projection[index];
		if (!item || queuedAgentMessagePreview(item) !== expectedText) return "rejected";
		if (mutation.type === "delete") {
			const error = new Error("Queued prompt was deleted before delivery.");
			this.host.rejectAgentMessage(item.agentMessageId, error);
			this.cancelSessionActions((candidate) => candidate === item, error);
			this.host.emitQueueUpdate();
			this.host.resumeQueuedWork();
			return "applied";
		}
		if (mutation.type === "move") {
			const neighbor = projection[index + mutation.direction];
			if (!neighbor) return "rejected";
			this.actions.swapQueued(item, neighbor);
			this.host.emitQueueUpdate();
			return "applied";
		}
		if (
			item.payload.kind === "turn" &&
			(item.payload.acceptedAgentMessage ||
				item.payload.records.some((record) => record.role === "primary" && record.message.role !== "user"))
		) {
			return "rejected";
		}
		const images = mutation.images?.map((image) => ({ ...image }));
		if (item.payload.kind === "session_command") {
			const command = parseSessionSlashCommand(mutation.text);
			if (!command) return "invalid";
			item.payload.text = mutation.text;
			item.payload.command = command;
			if (mutation.images !== undefined) item.payload.images = images?.length ? images : undefined;
		} else {
			item.payload.text = mutation.text;
			const text = { type: "text" as const, text: mutation.text };
			if (mutation.images !== undefined) {
				item.payload.images = images?.length ? images : undefined;
				item.payload.content = [text, ...(images?.map((image) => ({ ...image })) ?? [])];
			} else if (item.payload.content) {
				item.payload.content = [text, ...item.payload.content.filter((block) => block.type !== "text")];
			}
			item.payload.preview = undefined;
			item.payload.prepared = undefined;
			for (const record of item.payload.records) {
				if (record.role === "primary" && record.message.role === "user") {
					record.message.content = item.payload.content?.map((block) => ({ ...block })) ?? mutation.text;
				}
			}
		}
		const targetPolicy = queuedMessageLaneDeliveryPolicy(mutation.lane);
		if (targetPolicy !== policy) {
			item.queueKey = undefined;
			item.wake = mutation.lane === "steering" ? "on_lower_boundary" : "external_resume";
			this.actions.moveQueued(item, targetPolicy, this.actions.queuedActions(targetPolicy).length);
		}
		this.host.resumeQueuedWork();
		this.host.emitQueueUpdate();
		return "applied";
	}

	getSessionActionSnapshot(): SessionActionSnapshot {
		const steering = visibleSessionActionProjection(this.actions.queuedActions("next_turn_boundary")).map(
			queuedAgentMessagePreview,
		);
		const followUps = visibleSessionActionProjection(this.actions.queuedActions("when_run_idle")).map(
			queuedAgentMessagePreview,
		);
		const active = visibleSessionActionProjection(this.actions.activeActions())[0];
		const activeState = active?.lifecycle.state;
		const phase =
			activeState === "selected"
				? "preparing"
				: activeState === "preparing" || activeState === "committing" || activeState === "running"
					? activeState
					: undefined;
		return {
			queuedCount: steering.length + followUps.length,
			steering,
			followUps,
			...(active && phase
				? {
						active: {
							kind: active.payload.kind,
							phase,
							label: this.host.formatLabel(active.payload.text),
						},
					}
				: {}),
		};
	}

	getSteeringMessages(): readonly string[] {
		return visibleSessionActionProjection(this.actions.queuedActions("next_turn_boundary")).map(
			(action) => action.payload.text,
		);
	}

	getSteeringMessagePreviews(): readonly string[] {
		return visibleSessionActionProjection(this.actions.queuedActions("next_turn_boundary")).map(
			queuedAgentMessagePreview,
		);
	}

	getFollowUpMessages(): readonly string[] {
		return visibleSessionActionProjection(this.actions.queuedActions("when_run_idle")).map(
			(action) => action.payload.text,
		);
	}

	getFollowUpMessagePreviews(): readonly string[] {
		return visibleSessionActionProjection(this.actions.queuedActions("when_run_idle")).map(queuedAgentMessagePreview);
	}

	removeQueuedFollowUp(queueKey: string): boolean {
		const matching = this.actions
			.clearableActions()
			.filter((action) => action.payload.kind === "turn" && action.queueKey === queueKey);
		if (matching.length === 0) return false;
		const error = new Error("Queued agent message was cleared before delivery.");
		for (const action of matching) this.host.rejectAgentMessage(action.agentMessageId, error);
		const ids = new Set(matching.map((action) => action.id));
		this.cancelSessionActions((action) => ids.has(action.id), error);
		this.host.emitQueueUpdate();
		return true;
	}
}
