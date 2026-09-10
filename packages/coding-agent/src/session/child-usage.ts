import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { isAgentSessionMessage } from "../core/agent-messages.js";
import type {
	ChildUsageAttributionEntry,
	SessionEntry,
	SessionManager,
	SessionMessageEntry,
} from "../core/session-manager.js";
import { addAssistantUsage, cloneUsage, emptyUsage, subtractAssistantUsage } from "../core/usage.js";

export interface ChildUsageHost {
	sessionManager: Pick<SessionManager, "getEntries" | "appendChildUsageAttribution">;
	afterParentDrain(flush: () => void): void;
	invalidateOwnUsage(): void;
}
export interface ChildUsageTracker {
	record(messages: readonly AgentMessage[], assistant: AssistantMessage): void;
	flush(): void;
	flushIfStale(): void;
}

// Bounds how much accumulated child usage a parent process crash can lose.
const RLM_CHILD_USAGE_FLUSH_MAX_PENDING_MS = 60_000;

/** Label a child completion's usage by the nearest preceding prompt that triggered it. */
function rlmChildUsageOrigin(
	messages: readonly AgentMessage[],
	assistant: AssistantMessage,
): ChildUsageAttributionEntry["origin"] {
	for (let index = messages.lastIndexOf(assistant) - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user" && message.role !== "custom") continue;
		return message.role === "custom" && isAgentSessionMessage(message)
			? message.details.id.startsWith("spawn:")
				? "spawn_task"
				: "agent_message"
			: "direct_user";
	}
	return "direct_user";
}

function attributeChildUsage(parentUsage: Usage, childUsage: Usage): void {
	const parentContextTokens =
		parentUsage.totalTokens ||
		parentUsage.input + parentUsage.output + parentUsage.cacheRead + parentUsage.cacheWrite;
	// Recursive children are launched from an assistant tool call, so the parent assistant
	// message carries their billable usage for session-level cost totals.
	addAssistantUsage(parentUsage, childUsage);
	// Child work affects session-level billable totals, not the parent's model-facing context size.
	parentUsage.totalTokens = parentContextTokens;
}

export class SessionChildUsage {
	private _rlmDurableParentUsage = new WeakMap<AssistantMessage, Usage>();
	private _rlmUnindexedChildUsage = new WeakMap<AssistantMessage, Usage>();
	constructor(private readonly host: ChildUsageHost) {}
	createTracker(parent: AssistantMessage | undefined): ChildUsageTracker {
		const parentAssistantForUsage = parent;
		if (parentAssistantForUsage && !this._rlmDurableParentUsage.has(parentAssistantForUsage)) {
			this._rlmDurableParentUsage.set(parentAssistantForUsage, cloneUsage(parentAssistantForUsage.usage));
		}
		// Child completions accumulate per origin and flush one durable entry per
		// settle boundary (agent_end, settlement); the staleness checkpoints and
		// timer bound crash loss to one window of accumulated usage.
		const pendingChildUsage = new Map<ChildUsageAttributionEntry["origin"], Usage>();
		let pendingChildUsageSince = 0;
		let pendingChildUsageTimer: ReturnType<typeof setTimeout> | undefined;
		let parentEntryDrainScheduled = false;
		const flushPendingChildUsageAttribution = (afterParentDrain = false) => {
			if (pendingChildUsageTimer !== undefined) {
				clearTimeout(pendingChildUsageTimer);
				pendingChildUsageTimer = undefined;
			}
			if (pendingChildUsage.size === 0 || !parentAssistantForUsage) return;
			const parentEntry = this.host.sessionManager
				.getEntries()
				.find(
					(entry): entry is SessionMessageEntry =>
						entry.type === "message" && entry.message === parentAssistantForUsage,
				);
			if (!parentEntry) {
				if (!afterParentDrain && !parentEntryDrainScheduled) {
					parentEntryDrainScheduled = true;
					const flushAfterParentDrain = () => {
						parentEntryDrainScheduled = false;
						flushPendingChildUsageAttribution(true);
					};
					// A message_end extension may still be holding the parent assistant before its append.
					// The parent drain owns this retry; child settlement never waits for that queue.
					this.host.afterParentDrain(flushAfterParentDrain);
				}
				return;
			}
			const batches = [...pendingChildUsage.entries()];
			pendingChildUsage.clear();
			for (const [origin, childUsage] of batches) {
				const aggregateUsage = cloneUsage(this._rlmDurableParentUsage.get(parentAssistantForUsage)!);
				attributeChildUsage(aggregateUsage, childUsage);
				const liveUsage = parentAssistantForUsage.usage;
				const entryCount = this.host.sessionManager.getEntries().length;
				try {
					this.host.sessionManager.appendChildUsageAttribution(parentEntry.id, childUsage, aggregateUsage, origin);
					this._rlmDurableParentUsage.set(parentAssistantForUsage, aggregateUsage);
				} catch {
					// Attribution is recoverable bookkeeping; a failed append must not break run settlement.
				} finally {
					// The manager updates this same message; retain siblings' still-pending live usage.
					parentAssistantForUsage.usage = liveUsage;
					const indexed = this.host.sessionManager.getEntries()[entryCount];
					const unindexedUsage = this._rlmUnindexedChildUsage.get(parentAssistantForUsage);
					// _persist can throw after indexing. That row already participates in live own-usage subtraction.
					if (
						indexed?.type === "child_usage_attributed" &&
						indexed.targetId === parentEntry.id &&
						unindexedUsage
					) {
						subtractAssistantUsage(unindexedUsage, childUsage);
					}
					this.host.invalidateOwnUsage();
				}
			}
		};
		const flushPendingChildUsageIfStale = () => {
			if (
				pendingChildUsage.size > 0 &&
				Date.now() - pendingChildUsageSince >= RLM_CHILD_USAGE_FLUSH_MAX_PENDING_MS
			) {
				flushPendingChildUsageAttribution();
			}
		};
		return {
			flush: flushPendingChildUsageAttribution,
			flushIfStale: flushPendingChildUsageIfStale,
			record: (messages, assistant) => {
				// Flush before the fold: a persisted aggregate may only include
				// completions whose childUsage is durable with or before it.
				flushPendingChildUsageIfStale();
				attributeChildUsage(parentAssistantForUsage?.usage ?? emptyUsage(), assistant.usage);
				if (parentAssistantForUsage) {
					const unindexedUsage = this._rlmUnindexedChildUsage.get(parentAssistantForUsage) ?? emptyUsage();
					addAssistantUsage(unindexedUsage, assistant.usage);
					this._rlmUnindexedChildUsage.set(parentAssistantForUsage, unindexedUsage);
					this.host.invalidateOwnUsage();
					const origin = rlmChildUsageOrigin(messages, assistant);
					if (pendingChildUsage.size === 0) {
						pendingChildUsageSince = Date.now();
						// Wall-clock backstop for long tool runs without checkpoints.
						pendingChildUsageTimer = setTimeout(
							flushPendingChildUsageAttribution,
							RLM_CHILD_USAGE_FLUSH_MAX_PENDING_MS,
						);
						pendingChildUsageTimer.unref?.();
					}
					const bucket = pendingChildUsage.get(origin) ?? emptyUsage();
					addAssistantUsage(bucket, assistant.usage);
					pendingChildUsage.set(origin, bucket);
				}
			},
		};
	}
	getUnindexed(message: AssistantMessage): Usage | undefined {
		return this._rlmUnindexedChildUsage.get(message);
	}
	subtractUnindexed(ownUsage: Usage, entries: SessionEntry[]): void {
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const unindexedUsage = this._rlmUnindexedChildUsage.get(entry.message);
			if (unindexedUsage) subtractAssistantUsage(ownUsage, unindexedUsage);
		}
	}
}
