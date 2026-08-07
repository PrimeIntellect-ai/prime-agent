import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, UserMessage } from "@earendil-works/pi-ai";
import type { InputSource } from "./extensions/index.js";
import type { CustomMessage } from "./messages.js";
import type { SessionSlashCommand } from "./slash-commands.js";

export type DeliveryPolicy = "next_turn_boundary" | "when_run_idle";
export type WakePolicy = "immediate" | "on_lower_boundary" | "external_resume";

export type QueuedMessageLane = "steering" | "followUp";

export function queuedMessageLaneDeliveryPolicy(lane: QueuedMessageLane): DeliveryPolicy {
	return lane === "steering" ? "next_turn_boundary" : "when_run_idle";
}

export type QueuedMessageMutation =
	| { type: "delete" }
	| { type: "move"; direction: -1 | 1 }
	| { type: "replace"; text: string; images?: ImageContent[]; lane: QueuedMessageLane };
export type QueuedMessageMutationStatus = "applied" | "rejected" | "invalid";

export interface SessionActionSnapshot {
	queuedCount: number;
	steering: readonly string[];
	followUps: readonly string[];
	active?: {
		kind: "turn" | "session_command";
		phase: "preparing" | "committing" | "running";
		label?: string;
	};
}

export interface DeliveryRecord {
	id: string;
	role: "primary" | "prefix" | "next_turn";
	message: UserMessage | CustomMessage;
	started: boolean;
	durable: boolean;
	ownerActionId: string;
}

export interface SessionTurnPayload {
	kind: "turn";
	records: DeliveryRecord[];
	text: string;
	preview?: string;
}

export interface SessionCommandPayload {
	kind: "session_command";
	command: SessionSlashCommand;
	text: string;
}

export type SessionActionPayload = SessionTurnPayload | SessionCommandPayload;

export type ActionLifecycle =
	| { state: "queued" }
	| { state: "selected" }
	| { state: "preparing"; preparation?: object }
	| { state: "committing" }
	| { state: "running"; execution: "agent_turn" | "session_command" }
	| { state: "completed" }
	| { state: "failed"; error: Error }
	| { state: "cancelled" };

export interface SessionAction<TPayload extends SessionActionPayload = SessionActionPayload> {
	id: string;
	source: InputSource | "internal";
	delivery: DeliveryPolicy;
	wake: WakePolicy;
	payload: TPayload;
	lifecycle: ActionLifecycle;
	queueKey?: string;
	agentMessageId?: string;
	suppressAutonomousContinuation?: boolean;
}

export interface RollbackProof {
	dispatchSettled: true;
	transcript: readonly AgentMessage[];
}

const TERMINAL_STATES = new Set<ActionLifecycle["state"]>(["completed", "failed", "cancelled"]);
const ACTIVE_STATES = new Set<ActionLifecycle["state"]>(["selected", "preparing", "committing", "running"]);
const CLEARABLE_STATES = new Set<ActionLifecycle["state"]>(["queued", "selected", "preparing"]);

function isClearable(action: SessionAction): boolean {
	return CLEARABLE_STATES.has(action.lifecycle.state);
}

const LEGAL_TRANSITIONS: Readonly<Record<ActionLifecycle["state"], ReadonlySet<ActionLifecycle["state"]>>> = {
	queued: new Set(["selected", "failed", "cancelled"]),
	selected: new Set(["queued", "preparing", "running", "failed", "cancelled"]),
	preparing: new Set(["queued", "committing", "failed", "cancelled"]),
	committing: new Set(["queued", "running", "failed", "cancelled"]),
	running: new Set(["completed", "failed", "cancelled"]),
	completed: new Set(),
	failed: new Set(),
	cancelled: new Set(),
};

function primaryRecords(action: SessionAction): readonly DeliveryRecord[] {
	return action.payload.kind === "turn" ? action.payload.records.filter((record) => record.role === "primary") : [];
}

export function transitionSessionAction(
	action: SessionAction,
	next: ActionLifecycle,
	options: { rollbackProof?: RollbackProof } = {},
): void {
	const previous = action.lifecycle.state;
	if (!LEGAL_TRANSITIONS[previous].has(next.state)) {
		throw new Error(`Illegal session action lifecycle transition: ${previous} -> ${next.state}`);
	}
	if (previous === "committing" && next.state === "queued") {
		const proof = options.rollbackProof;
		if (!proof?.dispatchSettled) {
			throw new Error("Committing session action rollback requires a settled dispatch and transcript proof");
		}
		const transcript = new Set(proof.transcript);
		if (primaryRecords(action).some((record) => transcript.has(record.message))) {
			throw new Error("Cannot roll back a session action whose primary message is durable in the transcript");
		}
	}
	action.lifecycle = next;
}

export type AdmissionDisposition = "starts_when_admitted" | "queued";
export type SubmissionOutcome =
	| { status: "accepted"; actionId: string; disposition: AdmissionDisposition }
	| { status: "coalesced"; existingActionId: string }
	| { status: "handled_without_turn" }
	| { status: "extension_command"; completion: Promise<void> };
export type DeliveryOutcome = { status: "delivered" } | { status: "not_applicable" };

export interface ActionTicket {
	id: string;
	accepted: Promise<SubmissionOutcome>;
	delivered: Promise<DeliveryOutcome>;
	completed: Promise<void>;
}

interface Deferred<T> {
	promise: Promise<T>;
	settle(value: T): boolean;
	reject(error: Error): boolean;
}

function createDeferred<T>(): Deferred<T> {
	let settled = false;
	let resolvePromise!: (value: T) => void;
	let rejectPromise!: (error: Error) => void;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);
	return {
		promise,
		settle: (value) => {
			if (settled) return false;
			settled = true;
			resolvePromise(value);
			return true;
		},
		reject: (error) => {
			if (settled) return false;
			settled = true;
			rejectPromise(error);
			return true;
		},
	};
}

export class ActionTicketController {
	readonly ticket: ActionTicket;
	private readonly accepted = createDeferred<SubmissionOutcome>();
	private readonly delivered = createDeferred<DeliveryOutcome>();
	private readonly completed = createDeferred<void>();

	constructor(id: string) {
		this.ticket = {
			id,
			accepted: this.accepted.promise,
			delivered: this.delivered.promise,
			completed: this.completed.promise,
		};
	}

	settleAccepted(outcome: SubmissionOutcome): boolean {
		return this.accepted.settle(outcome);
	}

	settleDelivered(outcome: DeliveryOutcome): boolean {
		return this.delivered.settle(outcome);
	}

	rejectDelivered(error: Error): boolean {
		return this.delivered.reject(error);
	}

	settleCompleted(error?: Error): boolean {
		return error ? this.completed.reject(error) : this.completed.settle();
	}
}

export class ActionStore<TAction extends SessionAction = SessionAction> {
	private readonly nextTurnBoundary: TAction[] = [];
	private readonly whenRunIdle: TAction[] = [];
	private readonly tickets = new Map<string, ActionTicketController>();

	enqueue(action: TAction): void {
		this.assertNewAction(action);
		this.list(action.delivery).push(action);
		this.tickets.set(action.id, new ActionTicketController(action.id));
	}

	enqueueFront(action: TAction): void {
		this.assertNewAction(action);
		const list = this.list(action.delivery);
		const firstQueued = list.findIndex((item) => item.lifecycle.state === "queued");
		list.splice(firstQueued < 0 ? list.length : firstQueued, 0, action);
		this.tickets.set(action.id, new ActionTicketController(action.id));
	}

	selectFirst(): TAction | undefined {
		const action =
			this.nextTurnBoundary.find((item) => item.lifecycle.state === "queued") ??
			this.whenRunIdle.find((item) => item.lifecycle.state === "queued");
		if (action) transitionSessionAction(action, { state: "selected" });
		return action;
	}

	remove(predicate: (action: TAction) => boolean, candidates = this.clearableActions()): TAction[] {
		const removed = candidates.filter(predicate);
		for (const action of removed) transitionSessionAction(action, { state: "cancelled" });
		return removed;
	}

	rollback(action: TAction, proof?: RollbackProof): void {
		transitionSessionAction(action, { state: "queued" }, { rollbackProof: proof });
	}

	swapQueued(left: TAction, right: TAction): void {
		if (left.lifecycle.state !== "queued" || right.lifecycle.state !== "queued" || left.delivery !== right.delivery) {
			throw new Error("Only queued actions in the same lane can be swapped");
		}
		const list = this.list(left.delivery);
		const leftIndex = list.indexOf(left);
		const rightIndex = list.indexOf(right);
		if (leftIndex < 0 || rightIndex < 0) throw new Error("Queued action is not owned by this store");
		[list[leftIndex], list[rightIndex]] = [right, left];
	}

	moveQueued(action: TAction, delivery: DeliveryPolicy, index: number): void {
		if (action.lifecycle.state !== "queued") throw new Error("Only queued actions can be moved");
		const source = this.list(action.delivery);
		const sourceIndex = source.indexOf(action);
		if (sourceIndex < 0) throw new Error(`Session action ${action.id} is not owned by this store`);
		source.splice(sourceIndex, 1);
		action.delivery = delivery;
		const target = this.list(delivery);
		const queued = target.filter((item) => item.lifecycle.state === "queued");
		const before = queued[Math.max(0, Math.min(index, queued.length))];
		target.splice(before ? target.indexOf(before) : target.length, 0, action);
	}

	queuedActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter((action) => action.lifecycle.state === "queued");
	}

	clearableActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter(isClearable);
	}

	snapshotActions(): readonly TAction[] {
		return this.queuedActions();
	}

	unfinishedActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter((action) => !TERMINAL_STATES.has(action.lifecycle.state));
	}

	activeActions(policy?: DeliveryPolicy): readonly TAction[] {
		return this.actions(policy).filter((action) => ACTIVE_STATES.has(action.lifecycle.state));
	}

	queuePreview(policy: DeliveryPolicy): readonly string[] {
		return this.queuedActions(policy).map((action) =>
			action.payload.kind === "turn" ? (action.payload.preview ?? action.payload.text) : action.payload.text,
		);
	}

	ticketFor(action: TAction): ActionTicketController {
		const ticket = this.tickets.get(action.id);
		if (!ticket) throw new Error(`Session action ${action.id} is not owned by this store`);
		return ticket;
	}

	ownedActions(): readonly TAction[] {
		return this.actions();
	}

	actionsForMessage(message: UserMessage | CustomMessage): readonly TAction[] {
		return this.actions().filter(
			(action) =>
				action.payload.kind === "turn" && action.payload.records.some((record) => record.message === message),
		);
	}

	releaseTerminal(action: TAction): void {
		if (!TERMINAL_STATES.has(action.lifecycle.state)) {
			throw new Error(`Cannot release nonterminal session action ${action.id}`);
		}
		const list = this.list(action.delivery);
		const index = list.indexOf(action);
		if (index >= 0) list.splice(index, 1);
		this.tickets.delete(action.id);
	}

	private actions(policy?: DeliveryPolicy): readonly TAction[] {
		if (policy) return this.list(policy);
		return [...this.nextTurnBoundary, ...this.whenRunIdle];
	}

	private list(policy: DeliveryPolicy): TAction[] {
		return policy === "next_turn_boundary" ? this.nextTurnBoundary : this.whenRunIdle;
	}

	private assertNewAction(action: TAction): void {
		if (action.lifecycle.state !== "queued") throw new Error("Only queued session actions can be enqueued");
		if (this.tickets.has(action.id)) throw new Error(`Duplicate session action id: ${action.id}`);
	}
}

export interface RuntimeActivity {
	lowerAgentRun: boolean;
	compaction: boolean;
	retry: boolean;
	bash: boolean;
	refinementApply: boolean;
	branchMutation: boolean;
	schedulerPauseCount: number;
	disposing: boolean;
}

export type IdleEvictionMinutes = number | "off";

export interface SessionEvictionSnapshot {
	isSessionActive: boolean;
	attachedClients: number;
	hasRegisteredHeartbeat: boolean;
	hasRegisteredCronJob: boolean;
	lastActivityAt: number;
}

export interface SessionPassivationSnapshot extends SessionEvictionSnapshot {
	hasParent: boolean;
	hasNonPassiveDescendants: boolean;
	isHydrating: boolean;
}

export interface WorkerEvictionSnapshot {
	lifecycle: "starting" | "ready" | "recovering" | "failed";
	isConnected: boolean;
	isStopping: boolean;
	hasOwnerClient: boolean;
	isPreparingUpdateRestart: boolean;
	sessions: readonly SessionEvictionSnapshot[];
}

function isIdleEvictionThresholdMet(
	session: SessionEvictionSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now: number,
): boolean {
	if (idleEvictionMinutes === "off" || !Number.isFinite(idleEvictionMinutes) || idleEvictionMinutes <= 0) {
		return false;
	}
	return (
		!session.isSessionActive &&
		session.attachedClients === 0 &&
		!session.hasRegisteredHeartbeat &&
		!session.hasRegisteredCronJob &&
		Number.isFinite(session.lastActivityAt) &&
		now - session.lastActivityAt >= idleEvictionMinutes * 60_000
	);
}

/** Pure per-node residency policy. Roots remain owned by whole-worker eviction. */
export function canPassivateSession(
	session: SessionPassivationSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now = Date.now(),
): boolean {
	return (
		session.hasParent &&
		!session.hasNonPassiveDescendants &&
		!session.isHydrating &&
		isIdleEvictionThresholdMet(session, idleEvictionMinutes, now)
	);
}

/** Pure whole-tree residency policy. Callers must supply supervisor-owned attachment state. */
export function canEvictWorker(
	worker: WorkerEvictionSnapshot,
	idleEvictionMinutes: IdleEvictionMinutes,
	now = Date.now(),
): boolean {
	if (
		worker.lifecycle !== "ready" ||
		!worker.isConnected ||
		worker.isStopping ||
		worker.hasOwnerClient ||
		worker.isPreparingUpdateRestart ||
		worker.sessions.length === 0
	) {
		return false;
	}
	return worker.sessions.every((session) => isIdleEvictionThresholdMet(session, idleEvictionMinutes, now));
}

export function canSelectSessionAction(activity: RuntimeActivity): boolean {
	return (
		!activity.lowerAgentRun &&
		!activity.compaction &&
		!activity.retry &&
		!activity.bash &&
		!activity.refinementApply &&
		!activity.branchMutation &&
		activity.schedulerPauseCount === 0 &&
		!activity.disposing
	);
}
