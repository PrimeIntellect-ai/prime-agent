import {
	type CustomMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "../core/messages.js";
import type { ActionStore, DeliveryRecord } from "../core/session-action-store.js";
import { waitForPromiseOrAbort } from "../utils/wait-for-abort.js";
import type { SessionCommitFence, SessionCommitLease } from "./commit-fence.js";
import type { SessionInputScheduler } from "./input-scheduler.js";
import {
	cloneCustomMessage,
	createPreparedTurnAction,
	primaryDeliveryRecord,
	type QueuedSessionAction,
} from "./prepared-actions.js";
import { createTurnExecutionPolicy } from "./turn-preparation.js";

export interface SessionPendingContextHost {
	getScheduler(): Pick<SessionInputScheduler, "admissionPaused" | "suspended" | "queuedWorkPauseCount">;
	getFence(): Pick<SessionCommitFence, "disposeSignal">;
	isDisposed(): boolean;
	isDisposing(): boolean;
	admit(action: QueuedSessionAction, options: { wake: false }): { accepted: boolean };
	scheduleInput(): void;
	addCheckpointWaiter(waiter: () => void): void;
	removeCheckpointWaiter(waiter: () => void): void;
	acquireFence(signal: AbortSignal): Promise<SessionCommitLease>;
	cancelActions(
		predicate: (action: QueuedSessionAction) => boolean,
		error: Error,
		candidates: QueuedSessionAction[],
	): QueuedSessionAction[];
}
export class SessionPendingContext {
	private messages: CustomMessage[] = [];
	private readonly terminalNoticeActionIds = new Set<string>();
	constructor(
		private readonly actions: ActionStore<QueuedSessionAction>,
		private readonly host: SessionPendingContextHost,
	) {}
	appendMessages(...messages: CustomMessage[]): void {
		this.messages.push(...messages);
	}

	prependMessages(messages: readonly CustomMessage[]): void {
		this.messages.unshift(...messages);
	}

	removeMessagesMatching(predicate: (message: CustomMessage) => boolean): void {
		this.messages = this.messages.filter((message) => !predicate(message));
	}

	retainTerminalNotice(id: string): void {
		this.terminalNoticeActionIds.add(id);
	}

	releaseTerminalNotice(id: string): void {
		this.terminalNoticeActionIds.delete(id);
	}

	isRetainedTerminalNotice(id: string): boolean {
		return this.terminalNoticeActionIds.has(id);
	}

	dispose(): void {
		this.messages = [];
	}

	isRlmTerminalNotice(message: CustomMessage): boolean {
		return (
			message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE
		);
	}

	assertRlmTerminalNotice(message: CustomMessage): void {
		if (!this.isRlmTerminalNotice(message)) {
			throw new Error("Deferred terminal admission only accepts RLM child terminal notices.");
		}
	}

	isRlmTerminalNoticeAction(action: QueuedSessionAction): boolean {
		if (action.payload.kind !== "turn") return false;
		const message = primaryDeliveryRecord(action).message;
		return message.role === "custom" && this.isRlmTerminalNotice(message);
	}

	hasDeferredRlmTerminalNotices(): boolean {
		return this.messages.some((message) => this.isRlmTerminalNotice(message));
	}

	enqueueRlmTerminalNoticeAction(message: CustomMessage): void {
		this.assertRlmTerminalNotice(message);
		const action = createPreparedTurnAction("followUp", message.content as string, undefined, {
			message,
			suppressAutonomousContinuation: true,
			resumeIfIdle: false,
			source: "internal",
			executionPolicy: createTurnExecutionPolicy("injected"),
			queueVisible: false,
		});
		this.terminalNoticeActionIds.add(action.id);
		try {
			const result = this.host.admit(action, { wake: false });
			if (!result.accepted) throw new Error("RLM child terminal notice was not admitted.");
		} catch (error) {
			this.terminalNoticeActionIds.delete(action.id);
			throw error;
		}
	}

	flushDeferredRlmTerminalNotices(): void {
		if (
			this.host.getScheduler().admissionPaused ||
			this.host.getScheduler().suspended ||
			this.host.getScheduler().queuedWorkPauseCount > 0 ||
			this.host.isDisposed() ||
			this.host.isDisposing()
		) {
			return;
		}
		while (true) {
			const index = this.messages.findIndex((message) => this.isRlmTerminalNotice(message));
			if (index < 0) break;
			const message = this.messages[index];
			try {
				this.enqueueRlmTerminalNoticeAction(message);
			} catch {
				return;
			}
			this.messages.splice(index, 1);
		}
		this.host.scheduleInput();
	}

	async acquireRlmTerminalNoticeRetentionFence(): Promise<{ owner: symbol; release(): void } | undefined> {
		const disposeSignal = this.host.getFence().disposeSignal;
		while (!this.host.isDisposed() && !this.host.isDisposing() && !disposeSignal.aborted) {
			if (this.host.getScheduler().queuedWorkPauseCount > 0) {
				let wake = () => {};
				const pauseReleased = new Promise<void>((resolve) => {
					wake = resolve;
					this.host.addCheckpointWaiter(resolve);
				});
				try {
					await waitForPromiseOrAbort(pauseReleased, disposeSignal, "Terminal notice retention cancelled");
				} catch {
					return undefined;
				} finally {
					this.host.removeCheckpointWaiter(wake);
				}
				continue;
			}
			let fence: { owner: symbol; release(): void };
			try {
				fence = await this.host.acquireFence(disposeSignal);
			} catch {
				return undefined;
			}
			if (this.host.getScheduler().queuedWorkPauseCount === 0 && !this.host.isDisposed() && !this.host.isDisposing())
				return fence;
			fence.release();
		}
		return undefined;
	}

	async deferRlmTerminalNotice(message: CustomMessage): Promise<void> {
		this.assertRlmTerminalNotice(message);
		const fence = await this.acquireRlmTerminalNoticeRetentionFence();
		if (!fence) return;
		try {
			if (this.host.isDisposed() || this.host.isDisposing()) return;
			this.messages.push(cloneCustomMessage(message));
			this.flushDeferredRlmTerminalNotices();
		} finally {
			fence.release();
		}
	}

	demoteRlmTerminalNoticeActions(): void {
		const actions = this.actions.clearableActions().filter((action) => this.terminalNoticeActionIds.has(action.id));
		if (actions.length === 0) return;
		for (const action of actions) {
			if (!this.isRlmTerminalNoticeAction(action)) continue;
			const message = primaryDeliveryRecord(action).message;
			if (message.role === "custom") this.messages.push(cloneCustomMessage(message));
		}
		const ids = new Set(actions.map((action) => action.id));
		this.host.cancelActions(
			(action) => ids.has(action.id),
			new Error("RLM child terminal notice deferred across session input suspension."),
			actions,
		);
		for (const id of ids) this.terminalNoticeActionIds.delete(id);
	}

	takePendingNextTurnMessages(): CustomMessage[] {
		const messages = this.messages;
		this.messages = [];
		return messages;
	}

	getPendingNextTurnMessageSnapshots(): readonly CustomMessage[] {
		const messages = this.messages.map((message) => cloneCustomMessage(message));
		for (const action of this.actions.unfinishedActions()) {
			if (
				action.payload.kind !== "turn" ||
				!action.payload.acceptedAgentMessage ||
				!primaryDeliveryRecord(action).started
			) {
				continue;
			}
			messages.push(
				...action.payload.records
					.filter(
						(record): record is DeliveryRecord & { message: CustomMessage } =>
							(record.role === "next_turn" || record.role === "prefix") &&
							record.message.role === "custom" &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message)),
			);
		}
		return messages;
	}

	restorePendingNextTurnMessages(messages: readonly CustomMessage[]): void {
		this.messages.push(...messages.map((message) => cloneCustomMessage(message)));
		this.flushDeferredRlmTerminalNotices();
	}
}
