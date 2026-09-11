import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { turnExecutionPoliciesEqual } from "../turns/turn-preparation.js";
import {
	type ActionStore,
	canSelectSessionAction,
	type DeliveryPolicy,
	type RuntimeActivity,
	transitionSessionAction,
} from "./action-store.js";
import { DeferredSessionInputError, primaryDeliveryRecord, type QueuedSessionAction } from "./prepared-actions.js";

export interface SessionInputDispatcherHost {
	isDisposed(): boolean;
	getEpoch(): number;
	getActivity(): RuntimeActivity;
	isBusy(): boolean;
	isHandoffDeferred(epoch: number): boolean;
	getDeliveryMode(delivery: DeliveryPolicy): "all" | "one-at-a-time";
	waitForAgentIdle(): Promise<void>;
	hasCancelledDispatchCapture(): boolean;
	getEventQueue(): Promise<void>;
	waitForRefinement(): Promise<void>;
	getTranscript(): readonly AgentMessage[];
	startTurns(actions: QueuedSessionAction[], epoch: number): Promise<void>;
	executeCommand(action: QueuedSessionAction, epoch: number): Promise<void>;
	settleAgentMessage(id: string | undefined, leg: "delivery" | "completion", error?: Error): void;
	releaseTurn(id: string): void;
	notifyCheckpoints(): void;
	emitQueueUpdate(): void;
	surfaceError(error: unknown): void;
	schedule(): void;
}

export class SessionInputDispatcher {
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionInputDispatcherHost,
	) {}

	hasSelectableInput(): boolean {
		return (
			this.actions.queuedActions().length > 0 ||
			this.actions.activeActions().some((action) => action.lifecycle.state === "selected")
		);
	}

	async run(epoch: number): Promise<void> {
		let blocked = false;
		try {
			while (!this.host.isDisposed() && this.hasSelectableInput()) {
				await this.host.waitForAgentIdle();
				const preselected = this.actions.activeActions().find((action) => action.lifecycle.state === "selected");
				if (epoch !== this.host.getEpoch()) {
					if (preselected) {
						this.actions.rollback(preselected);
						this.host.notifyCheckpoints();
						this.host.emitQueueUpdate();
					}
					return;
				}
				if (!this.host.hasCancelledDispatchCapture()) await this.host.getEventQueue();
				if (!preselected || preselected.payload.kind === "session_command") await this.host.waitForRefinement();
				const activity = this.host.getActivity();
				const canSelectPreselectedTurn =
					preselected?.payload.kind === "turn" && canSelectSessionAction({ ...activity, refinementApply: false });
				if (
					this.host.isHandoffDeferred(epoch) ||
					(!canSelectPreselectedTurn && !canSelectSessionAction(activity))
				) {
					blocked = true;
					this.host.notifyCheckpoints();
					return;
				}
				const first = preselected ?? this.actions.selectFirst();
				if (!first) return;
				if (first.payload.kind === "session_command") {
					await this.host.executeCommand(first, epoch);
					return;
				}

				const mode = this.host.getDeliveryMode(first.delivery);
				const actions: QueuedSessionAction[] = [first];
				while (!preselected && mode === "all") {
					const next = this.actions.queuedActions(first.delivery)[0];
					if (
						!next ||
						next.payload.kind !== "turn" ||
						!turnExecutionPoliciesEqual(first.payload.executionPolicy, next.payload.executionPolicy)
					) {
						break;
					}
					this.actions.selectFirst();
					actions.push(next);
				}
				if (epoch !== this.host.getEpoch()) {
					for (const action of actions) this.actions.rollback(action);
					return;
				}
				for (const action of actions) transitionSessionAction(action, { state: "preparing" });
				this.host.notifyCheckpoints();
				this.host.emitQueueUpdate();
				try {
					await this.host.startTurns(actions, epoch);
					for (const action of actions) {
						if (action.lifecycle.state === "committing") {
							const primary = primaryDeliveryRecord(action);
							if (this.host.getTranscript().includes(primary.message)) {
								primary.durable = true;
								transitionSessionAction(action, {
									state: "running",
									execution: "agent_turn",
								});
							}
						}
						if (action.lifecycle.state === "running") {
							transitionSessionAction(action, { state: "completed" });
							this.actions.ticketFor(action).settleCompleted();
							this.host.settleAgentMessage(action.agentMessageId, "completion");
						}
					}
				} catch (error) {
					const transcript = this.host.getTranscript();
					const delivered = new Set(transcript);
					const undelivered: QueuedSessionAction[] = [];
					for (const action of actions) {
						if (action.payload.kind !== "turn" || action.lifecycle.state === "cancelled") continue;
						for (const record of action.payload.records) record.durable ||= delivered.has(record.message);
						action.payload.records = action.payload.records.filter((record) => {
							if (record.role === "prefix") return !record.durable;
							if (record.role === "next_turn") return record.durable;
							return true;
						});
						if (!primaryDeliveryRecord(action).durable) undelivered.push(action);
					}
					if (this.isDeferredError(error, epoch)) {
						for (const action of undelivered) {
							if (action.lifecycle.state === "committing") {
								this.actions.rollback(action, {
									dispatchSettled: true,
									transcript,
								});
							} else if (action.lifecycle.state === "preparing" || action.lifecycle.state === "selected") {
								this.actions.rollback(action);
							}
						}
						if (undelivered.length > 0) this.host.emitQueueUpdate();
						blocked = epoch !== this.host.getEpoch() || this.host.isBusy();
						if (blocked) return;
						continue;
					}
					const terminalError = error instanceof Error ? error : new Error(String(error));
					for (const action of actions) {
						if (action.lifecycle.state === "cancelled") continue;
						if (action.lifecycle.state !== "completed" && action.lifecycle.state !== "failed") {
							transitionSessionAction(action, {
								state: "failed",
								error: terminalError,
							});
						}
						const ticket = this.actions.ticketFor(action);
						if (undelivered.includes(action)) {
							ticket.rejectDelivered(terminalError);
							this.host.settleAgentMessage(action.agentMessageId, "delivery", terminalError);
						}
						this.host.settleAgentMessage(action.agentMessageId, "completion", terminalError);
						ticket.settleCompleted(terminalError);
					}
					if (actions.some((action) => action.payload.kind !== "turn" || action.payload.queueVisible)) {
						this.host.surfaceError(error);
					}
				} finally {
					for (const action of actions) {
						const retainedCancelledDispatch =
							action.lifecycle.state === "cancelled" &&
							action.payload.kind === "turn" &&
							action.payload.captureRunMessages !== undefined;
						if (
							!retainedCancelledDispatch &&
							(action.lifecycle.state === "completed" ||
								action.lifecycle.state === "failed" ||
								action.lifecycle.state === "cancelled")
						) {
							this.host.releaseTurn(action.id);
							this.actions.releaseTerminal(action);
						}
					}
					this.host.notifyCheckpoints();
					this.host.emitQueueUpdate();
				}
				if (epoch !== this.host.getEpoch() || blocked) return;
			}
		} finally {
			if (!blocked && epoch === this.host.getEpoch() && this.hasSelectableInput()) {
				this.host.schedule();
			}
		}
	}

	private isDeferredError(error: unknown, epoch: number): boolean {
		if (error instanceof DeferredSessionInputError) return true;
		if (epoch !== this.host.getEpoch()) return true;
		if (this.host.isBusy()) {
			this.host.surfaceError(error);
			return true;
		}
		return false;
	}
}
