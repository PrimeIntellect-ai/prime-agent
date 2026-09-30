/**
 * Agent activity watches (swarm communication PR E).
 *
 * watch.agent subscribes this session to a direct child's activity. Notices
 * carry message-index ranges (never content) and status transitions, so an
 * orchestrator can see that a child progressed without a second wakeup per
 * message. Quiet by default: nothing is emitted until registered, and even
 * then notices are ranges only. On the digest lane the events land in the
 * inbox and wake the session once per batch.
 */

export const AGENT_WATCH_MAX_ACTIVE = 64;
export const AGENT_WATCH_MAX_TOTAL = 1_024;
export const AGENT_WATCH_POLL_INTERVAL_MS = 5_000;

export const AGENT_WATCH_NOTICE_CUSTOM_TYPE = "agent_watch_notice";

export interface AgentWatchSubscription {
	id: string;
	/** Direct child id (rlm child id) this watch resolves to. */
	childId: string;
	childName: string;
	lastSeenMessages: number;
	lastStatus: string;
}

export interface AgentWatchSnapshot {
	messageCount: number;
	status: string;
}

/** Emitted per change batch: ranges only, no content. */
export interface AgentWatchEvent {
	subscriptionId: string;
	childName: string;
	/** Inclusive start index of new messages (0-based transcript index). */
	fromIndex: number;
	/** Exclusive end index of new messages. */
	toIndex: number;
	/** Status transition, when the child's status changed; else undefined. */
	statusChange: { from: string; to: string } | undefined;
}

export interface AgentWatchState {
	messageCount: (childId: string) => AgentWatchSnapshot | undefined;
	onEvent: (event: AgentWatchEvent) => void;
}

export class AgentWatchRegistry {
	private readonly subscriptions = new Map<string, AgentWatchSubscription>();
	private totalRegistered = 0;

	/** Register a direct child; throws when limits are exceeded. */
	register(id: string, childId: string, childName: string, initial: AgentWatchSnapshot): AgentWatchSubscription {
		if (this.subscriptions.has(id)) throw new Error(`Agent watch ${id} already exists`);
		if (this.subscriptions.size >= AGENT_WATCH_MAX_ACTIVE) {
			throw new Error(`Agent watch limit reached (${AGENT_WATCH_MAX_ACTIVE} active)`);
		}
		if (this.totalRegistered >= AGENT_WATCH_MAX_TOTAL) {
			throw new Error(`Agent watch total limit reached (${AGENT_WATCH_MAX_TOTAL})`);
		}
		const subscription: AgentWatchSubscription = {
			id,
			childId,
			childName,
			lastSeenMessages: initial.messageCount,
			lastStatus: initial.status,
		};
		this.subscriptions.set(id, subscription);
		this.totalRegistered += 1;
		return subscription;
	}

	cancel(id: string): boolean {
		return this.subscriptions.delete(id);
	}

	list(): AgentWatchSubscription[] {
		return [...this.subscriptions.values()];
	}

	get(id: string): AgentWatchSubscription | undefined {
		return this.subscriptions.get(id);
	}

	get size(): number {
		return this.subscriptions.size;
	}

	/** Poll every subscription; emits one event per child with changes. */
	poll(state: AgentWatchState): void {
		for (const subscription of this.subscriptions.values()) {
			const snapshot = state.messageCount(subscription.childId);
			if (!snapshot) continue;
			let statusChange: { from: string; to: string } | undefined;
			if (snapshot.status !== subscription.lastStatus) {
				statusChange = { from: subscription.lastStatus, to: snapshot.status };
				subscription.lastStatus = snapshot.status;
			}
			const fromIndex = subscription.lastSeenMessages;
			if (snapshot.messageCount > fromIndex || statusChange) {
				subscription.lastSeenMessages = snapshot.messageCount;
				state.onEvent({
					subscriptionId: subscription.id,
					childName: subscription.childName,
					fromIndex,
					toIndex: snapshot.messageCount,
					statusChange,
				});
			}
		}
	}
}

/** Quiet notice text for one agent-watch event: ranges only. */
export function formatAgentWatchNotice(event: AgentWatchEvent): string {
	const parts = [`[watch-agent child:${event.childName}] messages ${event.fromIndex}..${event.toIndex}`];
	if (event.toIndex > event.fromIndex) {
		parts.push(`(+${event.toIndex - event.fromIndex})`);
	}
	if (event.statusChange) {
		parts.push(`status: ${event.statusChange.from} -> ${event.statusChange.to}`);
	}
	return parts.join(" ");
}

/** Quiet notice text for a job progress event: byte ranges only. */
export function formatJobWatchNotice(pid: number, fromBytes: number, toBytes: number, command: string): string {
	const commandLabel = command.length > 60 ? `${command.slice(0, 60)}...` : command;
	return `[watch-job pid:${pid}] output +${toBytes - fromBytes} bytes (${fromBytes}..${toBytes}) command: ${commandLabel}`;
}
