import { AgentContinueError, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionCommitLease } from "../input/commit-fence.js";

export interface ContinuationToken {
	readonly promise: Promise<void>;
	readonly continueAfterSessionInput: boolean;
}

interface ContinuationSettlement extends ContinuationToken {
	continueAfterSessionInput: boolean;
	settled: boolean;
	resolve(): void;
	reject(error: Error): void;
}

function createSettlement(): ContinuationSettlement {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	promise.catch(() => undefined);
	return { promise, resolve, reject, continueAfterSessionInput: false, settled: false };
}

export interface SessionContinuationHost {
	waitForAgentIdle(): Promise<void>;
	waitForRetry(): Promise<void>;
	waitForRefinement(): Promise<void>;
	queuedWorkPauseCount(): number;
	addCheckpointWaiter(waiter: () => void): void;
	removeCheckpointWaiter(waiter: () => void): void;
	notifyCheckpoints(): void;
	compactionOperation(): Promise<void> | undefined;
	isRefinementApplying(): boolean;
	acquireCommitFence(): Promise<SessionCommitLease>;
	scheduleRefinement(): void;
	unfinishedActionCount(): number;
	isInputRequested(): boolean;
	scheduleInput(): void;
	continue(): Promise<void>;
	waitForIdleOrSettlement(token: ContinuationToken): Promise<void>;
	removeQueuedMessages(predicate: (message: AgentMessage) => boolean): AgentMessage[];
	followUp(message: AgentMessage): void;
	onMessageConsumed(message: AgentMessage): void;
}

/** Owns continuation settlement and message identity across cancellation and replacement runs. */
export class SessionContinuation {
	private scheduled = false;
	private settlement: ContinuationSettlement | undefined;
	private trackedMessages: AgentMessage[] = [];
	private scheduledMessages: AgentMessage[] = [];

	constructor(private readonly host: SessionContinuationHost) {}

	get isScheduled(): boolean {
		return this.scheduled;
	}
	get current(): ContinuationToken | undefined {
		return this.settlement;
	}
	get messages(): readonly AgentMessage[] {
		return this.trackedMessages;
	}
	track(message: AgentMessage): void {
		this.trackedMessages.push(message);
	}
	remove(messages: ReadonlySet<AgentMessage>): void {
		this.trackedMessages = this.trackedMessages.filter((message) => !messages.has(message));
	}

	private settle(error?: Error): void {
		if (!error && this.scheduled) return;
		const settlement = this.settlement;
		if (!settlement || settlement.settled) return;
		settlement.settled = true;
		this.settlement = undefined;
		if (error) settlement.reject(error);
		else settlement.resolve();
		this.host.notifyCheckpoints();
	}

	cancel(): void {
		this.scheduled = false;
		this.scheduledMessages = [];
		this.settle();
	}

	schedule(continueAfterSessionInput = false): void {
		if (!this.settlement || this.settlement.settled) {
			this.settlement = createSettlement();
		}
		const settlement = this.settlement;
		settlement.continueAfterSessionInput ||= continueAfterSessionInput;
		if (this.scheduled) {
			return;
		}
		this.scheduled = true;
		this.scheduledMessages = [...this.trackedMessages];
		void this.runScheduled(settlement)
			.catch(() => undefined)
			.finally(() => {
				if (this.settlement === settlement) {
					this.settle();
				}
			});
	}

	private ownsScheduledMessages(continuationMessages: AgentMessage[]): boolean {
		return continuationMessages.some((message) => this.trackedMessages.includes(message));
	}

	private async waitForQueuedWorkResume(settlement: ContinuationSettlement): Promise<void> {
		while (this.host.queuedWorkPauseCount() > 0 && this.settlement === settlement) {
			let resume = () => {};
			const resumed = new Promise<void>((resolve) => {
				resume = resolve;
				this.host.addCheckpointWaiter(resolve);
			});
			try {
				await Promise.race([resumed, settlement.promise]);
			} finally {
				this.host.removeCheckpointWaiter(resume);
			}
		}
	}

	private async runScheduled(settlement: ContinuationSettlement): Promise<void> {
		while (this.scheduled && this.settlement === settlement) {
			await this.host.waitForAgentIdle();
			await this.host.waitForRetry();
			await this.host.waitForRefinement();
			await this.waitForQueuedWorkResume(settlement);
			const compactionOperation = this.host.compactionOperation();
			if (compactionOperation) {
				await Promise.race([compactionOperation, settlement.promise]);
				continue;
			}

			const commitFence = await this.host.acquireCommitFence();
			let continuation: Promise<void> | undefined;
			let continuationMessages: AgentMessage[] = [];
			let waitForSessionInput = false;
			try {
				await this.host.waitForAgentIdle();
				if (!this.scheduled || this.settlement !== settlement) {
					return;
				}

				if (
					this.host.queuedWorkPauseCount() > 0 ||
					this.host.compactionOperation() ||
					this.host.isRefinementApplying()
				) {
					continue;
				}

				continuationMessages = [...this.scheduledMessages];
				if (continuationMessages.length > 0 && !this.ownsScheduledMessages(continuationMessages)) {
					this.cancel();
					this.host.scheduleRefinement();
					return;
				}
				if (this.host.unfinishedActionCount() > 0 || this.host.isInputRequested()) {
					this.host.scheduleInput();
					waitForSessionInput = true;
				} else {
					this.scheduled = false;
					continuation = this.host.continue();
				}
			} finally {
				commitFence.release();
			}

			if (waitForSessionInput) {
				await this.host.waitForIdleOrSettlement(settlement);
				if (this.settlement !== settlement) return;
				const shouldContinue =
					(settlement.continueAfterSessionInput && continuationMessages.length === 0) ||
					this.ownsScheduledMessages(continuationMessages);
				if (shouldContinue) {
					this.scheduledMessages = [...this.trackedMessages];
					continue;
				}
				this.scheduled = false;
				this.scheduledMessages = [];
				this.host.scheduleRefinement();
				return;
			}

			try {
				await continuation;
				if (this.settlement === settlement) {
					this.forgetConsumed(continuationMessages);
				}
				return;
			} catch (error) {
				const code = error instanceof AgentContinueError ? error.code : undefined;
				if (code === "busy") {
					if (this.settlement === settlement) {
						this.scheduled = true;
						this.scheduledMessages = [...this.trackedMessages];
					}
					continue;
				}
				if (code !== "nothing-to-continue" && this.settlement === settlement) {
					this.settle(error instanceof Error ? error : new Error(String(error)));
				}
				return;
			}
		}
	}

	forgetConsumed(continuationMessages: AgentMessage[]): void {
		if (continuationMessages.length === 0) {
			return;
		}
		const continuationMessageSet = new Set(continuationMessages);
		const stillQueued = new Set(this.host.removeQueuedMessages((message) => continuationMessageSet.has(message)));
		for (const message of stillQueued) {
			this.host.followUp(message);
		}
		for (const message of continuationMessages) {
			if (!stillQueued.has(message)) {
				this.host.onMessageConsumed(message);
			}
		}
		this.trackedMessages = this.trackedMessages.filter(
			(message) => !continuationMessageSet.has(message) || stillQueued.has(message),
		);
	}
}
