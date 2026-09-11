import type { Agent } from "@earendil-works/pi-agent-core";
import type { SessionManager } from "../../core/session-manager.js";
import { waitForPromiseOrAbort } from "../../utils/wait-for-abort.js";
import type { ContinuationToken, SessionContinuation } from "../turns/continuation.js";
import type { ActionStore } from "./action-store.js";
import type { SessionCommitFence, SessionCommitLease } from "./commit-fence.js";
import type { SessionInputScheduler } from "./input-scheduler.js";
import { primaryDeliveryRecord, type QueuedSessionAction } from "./prepared-actions.js";

export interface SessionInputCheckpointsHost {
	getFence(): Pick<SessionCommitFence, "isHeldByCurrentContext" | "disposeSignal">;
	getScheduler(): Pick<SessionInputScheduler, "queuedWorkPauseCount" | "suspended" | "pendingPump" | "requested">;
	getEventQueue(): Promise<void>;
	acquireFence(signal?: AbortSignal): Promise<SessionCommitLease>;
	getStore(): Pick<SessionManager, "flushNow">;
	assertAdmissionAvailable(): void;
	getContinuation(): Pick<SessionContinuation, "current">;
	scheduleInput(): void;
	getAgent(): Pick<Agent, "waitForIdle" | "state">;
	getUnfinishedCount(): number;
	waitForIdle(): Promise<void>;
}
export class SessionInputCheckpoints {
	private readonly waiters = new Set<() => void>();
	constructor(
		private readonly actions: Pick<ActionStore<QueuedSessionAction>, "activeActions" | "queuedActions">,
		private readonly host: SessionInputCheckpointsHost,
	) {}
	get hasWaiters(): boolean {
		return this.waiters.size > 0;
	}
	add(waiter: () => void): void {
		this.waiters.add(waiter);
	}
	remove(waiter: () => void): void {
		this.waiters.delete(waiter);
	}

	notifySessionInputCheckpointChange(): void {
		const waiters = [...this.waiters];
		this.waiters.clear();
		for (const resolve of waiters) resolve();
	}

	waitForSessionActivityChange(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = () => {
				this.waiters.delete(finish);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			this.waiters.add(finish);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
	}

	observeSessionActionDeferral(action: QueuedSessionAction): {
		deferred: Promise<void>;
		stop(): void;
	} {
		let resolveDeferral = () => {};
		const deferred = new Promise<void>((resolve) => {
			resolveDeferral = resolve;
		});
		const check = () => {
			if (action.lifecycle.state === "queued") resolveDeferral();
			else this.waiters.add(check);
		};
		this.waiters.add(check);
		return {
			deferred,
			stop: () => this.waiters.delete(check),
		};
	}

	async waitForSessionInputCheckpoint(signal?: AbortSignal): Promise<void> {
		const blocksCheckpoint = () =>
			this.actions.activeActions().some((action) => {
				if (action.payload.kind === "session_command") {
					return action.lifecycle.state === "selected" || action.lifecycle.state === "running";
				}
				return (
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					(action.lifecycle.state === "committing" && !primaryDeliveryRecord(action).durable)
				);
			});
		while (true) {
			while (blocksCheckpoint()) {
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				await new Promise<void>((resolve, reject) => {
					const onChange = () => {
						cleanup();
						resolve();
					};
					const onAbort = () => {
						cleanup();
						reject(new Error("Update restart preparation cancelled"));
					};
					const cleanup = () => {
						this.waiters.delete(onChange);
						signal?.removeEventListener("abort", onAbort);
					};
					this.waiters.add(onChange);
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
			}
			const commitFence = await this.host.acquireFence(signal);
			try {
				if (blocksCheckpoint()) continue;
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				await waitForPromiseOrAbort(this.host.getEventQueue(), signal, "Update restart preparation cancelled");
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				this.host.getStore().flushNow();
				return;
			} finally {
				commitFence.release();
			}
		}
	}

	async acquireDirectTurnAdmissionFence(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		if (this.host.getFence().isHeldByCurrentContext) {
			this.host.assertAdmissionAvailable();
			return this.host.acquireFence(signal);
		}
		const disposeSignal = this.host.getFence().disposeSignal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		while (true) {
			this.host.assertAdmissionAvailable();
			if (this.host.getScheduler().queuedWorkPauseCount > 0) {
				let wake = () => {};
				const pauseReleased = new Promise<void>((resolve) => {
					wake = resolve;
					this.waiters.add(resolve);
				});
				try {
					await waitForPromiseOrAbort(pauseReleased, waitSignal, "Update restart preparation cancelled");
				} catch (error) {
					if (disposeSignal.aborted) {
						throw new Error("Cannot admit a session action because the session is disposing or disposed.");
					}
					throw error;
				} finally {
					this.waiters.delete(wake);
				}
				continue;
			}
			const fence = await this.host.acquireFence(signal);
			try {
				if (this.host.getScheduler().queuedWorkPauseCount === 0) {
					this.host.assertAdmissionAvailable();
					return fence;
				}
			} catch (error) {
				fence.release();
				throw error;
			}
			fence.release();
		}
	}

	async waitForHeadlessIdle(): Promise<void> {
		while (true) {
			await this.host.waitForIdle();
			const postCompactionContinuation = this.host.getContinuation().current?.promise;
			if (!postCompactionContinuation) return;
			await postCompactionContinuation;
		}
	}

	async waitForIdleOrSettlement(settlement?: ContinuationToken): Promise<void> {
		while (settlement === undefined || this.host.getContinuation().current === settlement) {
			if (this.actions.queuedActions().length > 0) {
				if (this.host.getScheduler().suspended || this.host.getScheduler().queuedWorkPauseCount > 0) {
					let wake = () => {};
					const changed = new Promise<void>((resolve) => {
						wake = resolve;
						this.waiters.add(resolve);
					});
					try {
						await (settlement ? Promise.race([changed, settlement.promise]) : changed);
					} finally {
						this.waiters.delete(wake);
					}
					continue;
				}
				this.host.scheduleInput();
			}
			const pump = this.host.getScheduler().pendingPump;
			await pump;
			await this.host.getAgent().waitForIdle();
			const agentEventQueue = this.host.getEventQueue();
			await agentEventQueue;
			if (
				pump === this.host.getScheduler().pendingPump &&
				agentEventQueue === this.host.getEventQueue() &&
				!this.host.getScheduler().requested &&
				!this.host.getAgent().state.isStreaming &&
				this.host.getUnfinishedCount() === 0
			) {
				return;
			}
		}
	}
}
