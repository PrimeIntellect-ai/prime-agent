import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareProcessStartIds, getProcessStartId } from "../../core/session-lease.js";
import { evaluateOperationDeadline, resolveOperationTimeoutPolicy } from "./operation-timeout-policy.js";

export const OPERATION_LEDGER_SCHEMA_VERSION = 1 as const;
export type OperationKind =
	| "turn"
	| "provider"
	| "tool"
	| "kernel"
	| "child"
	| "bash"
	| "compaction"
	| "retry"
	| "session"
	| "unknown";
export type OperationPhase =
	| "admitted"
	| "starting"
	| "active"
	| "waiting_external"
	| "cancelling"
	| "cleanup"
	| "completed"
	| "failed"
	| "cancelled"
	| "uncertain";
export type OperationOutcome = "completed" | "failed" | "cancelled" | "uncertain";
export type OperationProgressKind = "semantic" | "bookkeeping";

export interface OperationRecord {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	operationId: string;
	activeSessionId: string;
	sessionId?: string;
	parentOperationId?: string;
	kind: OperationKind;
	phase: OperationPhase;
	status: "open" | "terminal";
	startedAt: string;
	updatedAt: string;
	lastMeaningfulProgressAt: string;
	deadlineAt?: string;
	timeoutClass?: string;
	timeoutPolicySource?: string;
	deadlineExtensionCount?: number;
	maxDeadlineExtensions?: number;
	lastDeadlineExtendedAt?: string;
	deadlineExtensionSource?: "human" | "parent" | "verified_external";
	budgetState?: "within_budget" | "budget_exhausted";
	ownershipStatus?: "owned" | "unowned" | "uncertain";
	cleanupStatus?: "not_started" | "in_progress" | "verified" | "cleanup_uncertain";
	outcome?: OperationOutcome;
	detail?: string;
}

// Monotonic per-group totals. Terminal records are trimmed to a bounded window, so any count derived
// from `operations` forgets old evidence. Calibration must not: an uncertain outcome that aged out of
// the window still happened, and hard enforcement eligibility has to reckon with it.
export interface OperationLifetimeCounts {
	terminalCount: number;
	uncertainOutcomeCount: number;
	cleanupUncertainCount: number;
}

export interface OperationLedgerSnapshot {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	instanceId: string;
	pid: number;
	processStartId?: string;
	role: "daemon" | "worker" | "standalone";
	processState: "active" | "closed";
	persistenceState: "durable" | "memory_only";
	persistenceError?: string;
	startedAt: string;
	heartbeatAt: string;
	operations: OperationRecord[];
	lifetimeByGroup?: Record<string, OperationLifetimeCounts>;
}

export function operationGroupKey(record: Pick<OperationRecord, "kind" | "timeoutClass">): string {
	return `${record.kind}:${record.timeoutClass ?? "unclassified"}`;
}

interface OperationLedgerOptions {
	rootDir: string;
	instanceId?: string;
	pid?: number;
	processStartId?: string;
	role?: OperationLedgerSnapshot["role"];
	now?: () => number;
	heartbeatIntervalMs?: number;
}

interface OpenOperationInput {
	operationId?: string;
	activeSessionId: string;
	sessionId?: string;
	parentOperationId?: string;
	kind: OperationKind;
	phase?: OperationPhase;
	deadlineAt?: string;
	timeoutClass?: string;
	timeoutPolicySource?: string;
	maxDeadlineExtensions?: number;
	ownershipStatus?: OperationRecord["ownershipStatus"];
	cleanupStatus?: OperationRecord["cleanupStatus"];
	detail?: string;
}

interface ProgressOperationInput {
	progressKind: OperationProgressKind;
	phase?: OperationPhase;
	detail?: string;
	deadlineAt?: string;
	budgetState?: OperationRecord["budgetState"];
	ownershipStatus?: OperationRecord["ownershipStatus"];
	cleanupStatus?: OperationRecord["cleanupStatus"];
}

interface CloseOperationInput {
	phase: Extract<OperationPhase, "completed" | "failed" | "cancelled" | "uncertain">;
	outcome: OperationOutcome;
	detail?: string;
	cleanupStatus?: OperationRecord["cleanupStatus"];
}

interface OperationJournalEvent {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	transition: "open" | "progress" | "close";
	recordedAt: string;
	progressKind?: OperationProgressKind;
	record: OperationRecord;
}

const MAX_RETAINED_TERMINAL_OPERATIONS = 500;
const MAX_DEADLINE_EXTENSION_MS = 60 * 60_000;
const DEFAULT_MAX_DEADLINE_EXTENSIONS = 3;

export type DeadlineExtensionSource = "human" | "parent" | "verified_external";
export type DeadlineExtensionResult =
	| { status: "applied"; record: OperationRecord }
	| {
			status: "rejected";
			reason: "not_open" | "no_deadline" | "invalid_source" | "invalid_duration" | "renewal_cap";
	  };

function writeJsonAtomically(path: string, value: unknown): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Best-effort cleanup; preserve the original write error.
		}
		throw error;
	}
}

export class OperationLedger {
	readonly snapshotPath: string;
	readonly journalPath: string;
	private readonly records = new Map<string, OperationRecord>();
	private readonly operationDir: string;
	private readonly reconciledSessions = new Set<string>();
	private readonly now: () => number;
	private readonly snapshotState: OperationLedgerSnapshot;
	private readonly heartbeatTimer?: ReturnType<typeof setInterval>;

	constructor(options: OperationLedgerOptions) {
		const pid = options.pid ?? process.pid;
		const now = options.now ?? Date.now;
		const instanceId = options.instanceId ?? `${pid}-${randomUUID()}`;
		this.operationDir = join(options.rootDir, "operations");
		this.snapshotPath = join(this.operationDir, `${instanceId}.json`);
		this.journalPath = join(this.operationDir, `${instanceId}.jsonl`);
		let persistenceError: string | undefined;
		try {
			mkdirSync(this.operationDir, { recursive: true, mode: 0o700 });
		} catch (error) {
			persistenceError = error instanceof Error ? error.message : String(error);
		}
		this.now = now;
		const timestamp = new Date(now()).toISOString();
		this.snapshotState = {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			instanceId,
			pid,
			processStartId: options.processStartId ?? getProcessStartId(pid),
			role: options.role ?? "standalone",
			processState: "active",
			persistenceState: persistenceError ? "memory_only" : "durable",
			persistenceError,
			startedAt: timestamp,
			heartbeatAt: timestamp,
			operations: [],
		};
		this.persist();
		const intervalMs = options.heartbeatIntervalMs ?? 30_000;
		if (intervalMs > 0) {
			this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
			this.heartbeatTimer.unref?.();
		}
	}

	open(input: OpenOperationInput): OperationRecord {
		const timestamp = this.timestamp();
		const record: OperationRecord = {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			operationId: input.operationId ?? `op_${randomUUID()}`,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			parentOperationId: input.parentOperationId,
			kind: input.kind,
			phase: input.phase ?? "active",
			status: "open",
			startedAt: timestamp,
			updatedAt: timestamp,
			lastMeaningfulProgressAt: timestamp,
			deadlineAt: input.deadlineAt,
			timeoutClass: input.timeoutClass,
			timeoutPolicySource: input.timeoutPolicySource,
			deadlineExtensionCount: input.deadlineAt ? 0 : undefined,
			maxDeadlineExtensions: input.deadlineAt
				? (input.maxDeadlineExtensions ?? DEFAULT_MAX_DEADLINE_EXTENSIONS)
				: undefined,
			budgetState: input.deadlineAt ? "within_budget" : undefined,
			ownershipStatus: input.ownershipStatus,
			cleanupStatus: input.cleanupStatus,
			detail: input.detail,
		};
		this.records.set(record.operationId, record);
		this.commit("open", record);
		return { ...record };
	}

	progress(operationId: string, input: ProgressOperationInput): OperationRecord | undefined {
		const previous = this.records.get(operationId);
		if (!previous || previous.status !== "open") return undefined;
		const timestamp = this.timestamp();
		const record: OperationRecord = {
			...previous,
			phase: input.phase ?? previous.phase,
			updatedAt: timestamp,
			lastMeaningfulProgressAt: input.progressKind === "semantic" ? timestamp : previous.lastMeaningfulProgressAt,
			deadlineAt: input.deadlineAt ?? previous.deadlineAt,
			budgetState: input.budgetState ?? previous.budgetState,
			ownershipStatus: input.ownershipStatus ?? previous.ownershipStatus,
			cleanupStatus: input.cleanupStatus ?? previous.cleanupStatus,
			detail: input.detail ?? previous.detail,
		};
		this.records.set(operationId, record);
		this.commit("progress", record, input.progressKind);
		return { ...record };
	}

	extendDeadline(
		operationId: string,
		extensionMs: number,
		source: DeadlineExtensionSource | "self",
	): DeadlineExtensionResult {
		const previous = this.records.get(operationId);
		if (!previous || previous.status !== "open") return { status: "rejected", reason: "not_open" };
		if (!previous.deadlineAt) return { status: "rejected", reason: "no_deadline" };
		if (!(["human", "parent", "verified_external"] as const).includes(source as DeadlineExtensionSource)) {
			return { status: "rejected", reason: "invalid_source" };
		}
		const validatedSource = source as DeadlineExtensionSource;
		if (!Number.isFinite(extensionMs) || extensionMs <= 0 || extensionMs > MAX_DEADLINE_EXTENSION_MS) {
			return { status: "rejected", reason: "invalid_duration" };
		}
		const extensionCount = previous.deadlineExtensionCount ?? 0;
		const maxExtensions = previous.maxDeadlineExtensions ?? DEFAULT_MAX_DEADLINE_EXTENSIONS;
		if (extensionCount >= maxExtensions) return { status: "rejected", reason: "renewal_cap" };
		const nowMs = this.now();
		const currentDeadlineMs = Date.parse(previous.deadlineAt);
		if (!Number.isFinite(currentDeadlineMs)) return { status: "rejected", reason: "no_deadline" };
		const timestamp = new Date(nowMs).toISOString();
		const record: OperationRecord = {
			...previous,
			deadlineAt: new Date(Math.max(nowMs, currentDeadlineMs) + extensionMs).toISOString(),
			deadlineExtensionCount: extensionCount + 1,
			lastDeadlineExtendedAt: timestamp,
			deadlineExtensionSource: validatedSource,
			budgetState: "within_budget",
			updatedAt: timestamp,
		};
		this.records.set(operationId, record);
		this.commit("progress", record, "bookkeeping");
		return { status: "applied", record: { ...record } };
	}

	close(operationId: string, input: CloseOperationInput): OperationRecord | undefined {
		const previous = this.records.get(operationId);
		if (!previous || previous.status !== "open") return undefined;
		const timestamp = this.timestamp();
		const record: OperationRecord = {
			...previous,
			phase: input.phase,
			status: "terminal",
			updatedAt: timestamp,
			outcome: input.outcome,
			cleanupStatus: input.cleanupStatus ?? previous.cleanupStatus,
			detail: input.detail ?? previous.detail,
		};
		this.records.set(operationId, record);
		this.recordLifetimeTerminal(record);
		this.trimTerminalRecords();
		this.commit("close", record);
		return { ...record };
	}

	reconcileSession(activeSessionId: string, sessionId?: string): OperationRecord[] {
		const key = sessionId ?? activeSessionId;
		if (this.reconciledSessions.has(key)) return [];
		this.reconciledSessions.add(key);
		const recovered: OperationRecord[] = [];
		let files: string[];
		try {
			files = readdirSync(this.operationDir).filter((file) => file.endsWith(".json"));
		} catch {
			return [];
		}
		for (const file of files) {
			const path = join(this.operationDir, file);
			if (path === this.snapshotPath) continue;
			let snapshot: OperationLedgerSnapshot;
			try {
				snapshot = JSON.parse(readFileSync(path, "utf8")) as OperationLedgerSnapshot;
			} catch {
				continue;
			}
			if (snapshot.schemaVersion !== OPERATION_LEDGER_SCHEMA_VERSION || this.snapshotOwnerAlive(snapshot)) continue;
			for (const previous of snapshot.operations ?? []) {
				if (previous.status !== "open") continue;
				if (previous.activeSessionId !== activeSessionId && (!sessionId || previous.sessionId !== sessionId))
					continue;
				if (this.records.has(previous.operationId)) continue;
				const record: OperationRecord = {
					...previous,
					activeSessionId,
					sessionId: sessionId ?? previous.sessionId,
					status: "terminal",
					phase: "uncertain",
					outcome: "uncertain",
					cleanupStatus:
						previous.ownershipStatus === "owned"
							? "cleanup_uncertain"
							: (previous.cleanupStatus ?? "not_started"),
					updatedAt: this.timestamp(),
					detail: [
						previous.detail,
						`reconciled after owner ${snapshot.instanceId} stopped; operation was not replayed`,
					]
						.filter(Boolean)
						.join("; "),
				};
				this.records.set(record.operationId, record);
				this.commit("close", record);
				recovered.push({ ...record });
			}
		}
		return recovered;
	}

	private snapshotOwnerAlive(snapshot: OperationLedgerSnapshot): boolean {
		if (snapshot.processState !== "active") return false;
		try {
			process.kill(snapshot.pid, 0);
		} catch {
			return false;
		}
		return compareProcessStartIds(snapshot.processStartId, getProcessStartId(snapshot.pid)) !== "mismatch";
	}

	heartbeat(): void {
		this.snapshotState.heartbeatAt = this.timestamp();
		this.persist();
	}

	snapshot(): OperationLedgerSnapshot {
		return {
			...this.snapshotState,
			operations: [...this.records.values()].map((record) => ({ ...record })),
		};
	}

	dispose(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.snapshotState.processState = "closed";
		this.heartbeat();
	}

	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}

	private commit(
		transition: OperationJournalEvent["transition"],
		record: OperationRecord,
		progressKind?: OperationProgressKind,
	): void {
		const event: OperationJournalEvent = {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			transition,
			recordedAt: this.timestamp(),
			progressKind,
			record,
		};
		this.snapshotState.heartbeatAt = event.recordedAt;
		if (this.snapshotState.persistenceState === "durable") {
			try {
				appendFileSync(this.journalPath, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
			} catch (error) {
				this.markPersistenceUnavailable(error);
			}
		}
		this.persist();
	}

	private persist(): void {
		this.snapshotState.operations = [...this.records.values()];
		if (this.snapshotState.persistenceState !== "durable") return;
		try {
			writeJsonAtomically(this.snapshotPath, this.snapshotState);
		} catch (error) {
			this.markPersistenceUnavailable(error);
		}
	}

	private markPersistenceUnavailable(error: unknown): void {
		this.snapshotState.persistenceState = "memory_only";
		this.snapshotState.persistenceError = error instanceof Error ? error.message : String(error);
	}

	// Deliberately independent of the retained-record window: these totals only ever increase.
	private recordLifetimeTerminal(record: OperationRecord): void {
		this.snapshotState.lifetimeByGroup ??= {};
		const lifetime = this.snapshotState.lifetimeByGroup;
		const key = operationGroupKey(record);
		lifetime[key] ??= { terminalCount: 0, uncertainOutcomeCount: 0, cleanupUncertainCount: 0 };
		const counts = lifetime[key];
		counts.terminalCount += 1;
		if (record.outcome === "uncertain") counts.uncertainOutcomeCount += 1;
		if (record.cleanupStatus === "cleanup_uncertain") counts.cleanupUncertainCount += 1;
	}

	private trimTerminalRecords(): void {
		const terminal = [...this.records.values()].filter((record) => record.status === "terminal");
		if (terminal.length <= MAX_RETAINED_TERMINAL_OPERATIONS) return;
		for (const record of terminal
			.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
			.slice(0, terminal.length - MAX_RETAINED_TERMINAL_OPERATIONS)) {
			this.records.delete(record.operationId);
		}
	}
}

export interface OperationTrackerSummary {
	openOperationCount: number;
	lastMeaningfulProgressAt?: string;
	operations: OperationRecord[];
}

interface OperationTrackerIdentity {
	activeSessionId: string;
	sessionId?: string;
	now?: () => number;
}

const EVENT_START_KIND: Record<string, OperationKind> = {
	agent_start: "turn",
	tool_execution_start: "tool",
	compaction_start: "compaction",
	auto_retry_start: "retry",
	bash_start: "bash",
};
const EVENT_END_KIND: Record<string, OperationKind> = {
	agent_end: "turn",
	tool_execution_end: "tool",
	compaction_end: "compaction",
	auto_retry_end: "retry",
	bash_end: "bash",
};

function eventExternalId(event: Record<string, unknown>): string | undefined {
	for (const key of ["toolCallId", "callId", "runId", "id"]) {
		const value = event[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

function isAssistantMessageEvent(event: Record<string, unknown>): boolean {
	return (
		typeof event.message === "object" &&
		event.message !== null &&
		"role" in event.message &&
		(event.message as { role?: unknown }).role === "assistant"
	);
}

export class OperationTracker {
	private sequence = 0;
	private readonly openByKey = new Map<string, string[]>();

	constructor(
		private readonly ledger: OperationLedger,
		private readonly identity: OperationTrackerIdentity,
	) {
		this.ledger.reconcileSession(identity.activeSessionId, identity.sessionId);
	}

	handleSessionEvent(event: { type: string; [key: string]: unknown }): void {
		if (event.type === "process_ownership_update") {
			this.handleProcessOwnershipEvent(event);
			return;
		}
		if (event.type === "message_start" && isAssistantMessageEvent(event)) {
			this.begin("provider", eventExternalId(event));
			return;
		}
		if (event.type === "message_end" && isAssistantMessageEvent(event)) {
			this.finish("provider", eventExternalId(event));
			this.markAllOpenSemantic(event.type);
			return;
		}
		const startKind = EVENT_START_KIND[event.type];
		if (startKind) {
			this.begin(startKind, eventExternalId(event), typeof event.toolName === "string" ? event.toolName : undefined);
			return;
		}
		const endKind = EVENT_END_KIND[event.type];
		if (endKind) {
			this.finish(endKind, eventExternalId(event), event);
			return;
		}
		if (event.type === "message_update" || event.type === "message_end") {
			this.markAllOpenSemantic(event.type);
		}
	}

	private handleProcessOwnershipEvent(event: Record<string, unknown>): void {
		const pid = typeof event.pid === "number" ? event.pid : undefined;
		const processStartId = typeof event.processStartId === "string" ? event.processStartId : undefined;
		const status = typeof event.status === "string" ? event.status : "uncertain";
		const rawCleanupStatus = typeof event.cleanupStatus === "string" ? event.cleanupStatus : "not_attempted";
		const ownershipStatus: NonNullable<OperationRecord["ownershipStatus"]> =
			status === "owned" || status === "released" ? "owned" : status === "untracked" ? "unowned" : "uncertain";
		const cleanupStatus: OperationRecord["cleanupStatus"] =
			rawCleanupStatus === "verified"
				? "verified"
				: rawCleanupStatus === "uncertain"
					? "cleanup_uncertain"
					: undefined;
		const detail = [
			pid === undefined ? undefined : `pid=${pid}`,
			processStartId ? `start=${processStartId}` : undefined,
			typeof event.error === "string" ? event.error : undefined,
		]
			.filter((value): value is string => Boolean(value))
			.join(" ");
		const target = this.openOperations()
			.filter((operation) => operation.kind === "tool")
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
		if (target) {
			this.ledger.progress(target.operationId, {
				progressKind: "semantic",
				ownershipStatus,
				cleanupStatus,
				detail,
			});
			return;
		}
		if (!cleanupStatus) return;
		const receipt = this.ledger.open({
			activeSessionId: this.identity.activeSessionId,
			sessionId: this.identity.sessionId,
			kind: "kernel",
			phase: "cleanup",
			ownershipStatus,
			cleanupStatus,
			detail,
		});
		this.ledger.close(receipt.operationId, {
			phase: cleanupStatus === "verified" ? "completed" : "uncertain",
			outcome: cleanupStatus === "verified" ? "completed" : "uncertain",
			cleanupStatus,
			detail,
		});
	}

	handleBookkeeping(_label: string): void {
		for (const operation of this.openOperations()) {
			this.ledger.progress(operation.operationId, { progressKind: "bookkeeping" });
		}
	}

	// An operation still open when its session closes did not complete, whatever the session's own
	// reason was. Promoting it would fabricate exactly the false-completion this ledger exists to
	// prevent, and would feed calibration a clean sample that never happened. `completed` is
	// reachable only through the operation's own end event.
	closeAll(outcome: OperationOutcome = "cancelled", detail = "session closed"): void {
		const effective: OperationOutcome = outcome === "completed" ? "uncertain" : outcome;
		const resolvedDetail = effective === outcome ? detail : `${detail}; operation still open at session close`;
		for (const operation of this.openOperations()) {
			this.ledger.close(operation.operationId, { phase: effective, outcome: effective, detail: resolvedDetail });
		}
		this.openByKey.clear();
	}

	summary(): OperationTrackerSummary {
		const operations = this.ledger
			.snapshot()
			.operations.filter((operation) => operation.activeSessionId === this.identity.activeSessionId);
		const open = operations.filter((operation) => operation.status === "open");
		const lastMeaningfulProgressAt = open
			.map((operation) => operation.lastMeaningfulProgressAt)
			.sort()
			.at(-1);
		return { openOperationCount: open.length, lastMeaningfulProgressAt, operations };
	}

	claimExpiredCancellations(nowMs: number, allowOwnedCancellation: boolean): OperationRecord[] {
		const claimed: OperationRecord[] = [];
		for (const operation of this.openOperations()) {
			if (operation.phase === "cancelling") continue;
			const decision = evaluateOperationDeadline(operation, nowMs, allowOwnedCancellation);
			if (decision === "none") continue;
			if (decision === "warn") {
				if (operation.budgetState !== "budget_exhausted") {
					this.ledger.progress(operation.operationId, {
						progressKind: "bookkeeping",
						budgetState: "budget_exhausted",
					});
				}
				continue;
			}
			const updated = this.ledger.progress(operation.operationId, {
				progressKind: "semantic",
				phase: "cancelling",
				budgetState: "budget_exhausted",
				cleanupStatus: operation.cleanupStatus ?? "not_started",
				detail: "owned operation exceeded its persisted hard deadline; cancellation requested",
			});
			if (updated) claimed.push(updated);
		}
		return claimed;
	}

	private parentOperationFor(kind: OperationKind): OperationRecord | undefined {
		if (kind === "turn") return undefined;
		const open = this.openOperations().filter((operation) => operation.kind === "turn");
		return open.sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
	}

	private begin(kind: OperationKind, externalId?: string, detail?: string): void {
		const key = `${kind}:${externalId ?? "default"}`;
		const nowMs = this.identity.now?.() ?? Date.now();
		const policy = resolveOperationTimeoutPolicy(kind, detail, nowMs);
		const parent = this.parentOperationFor(kind);
		const parentDeadlineMs = parent?.deadlineAt ? Date.parse(parent.deadlineAt) : Number.POSITIVE_INFINITY;
		const ownDeadlineMs = policy.deadlineAt ? Date.parse(policy.deadlineAt) : Number.POSITIVE_INFINITY;
		const effectiveDeadlineMs = Math.min(parentDeadlineMs, ownDeadlineMs);
		const operation = this.ledger.open({
			operationId: `op_${this.identity.activeSessionId}_${kind}_${externalId ?? ++this.sequence}`,
			activeSessionId: this.identity.activeSessionId,
			sessionId: this.identity.sessionId,
			parentOperationId: parent?.operationId,
			kind,
			phase: "active",
			deadlineAt: Number.isFinite(effectiveDeadlineMs) ? new Date(effectiveDeadlineMs).toISOString() : undefined,
			timeoutClass: policy.timeoutClass,
			timeoutPolicySource: policy.timeoutPolicySource,
			detail,
		});
		const stack = this.openByKey.get(key) ?? [];
		stack.push(operation.operationId);
		this.openByKey.set(key, stack);
	}

	private finish(kind: OperationKind, externalId?: string, event?: Record<string, unknown>): void {
		const preferredKey = `${kind}:${externalId ?? "default"}`;
		let key = preferredKey;
		let stack = this.openByKey.get(key);
		if (!stack?.length && externalId !== undefined) {
			key = `${kind}:default`;
			stack = this.openByKey.get(key);
		}
		const operationId = stack?.pop();
		if (!operationId) return;
		if (stack?.length === 0) this.openByKey.delete(key);
		const result = event?.result as { details?: Record<string, unknown> } | undefined;
		const details = result?.details;
		const rawCleanupStatus = details?.cleanupStatus;
		const cleanupStatus: OperationRecord["cleanupStatus"] =
			rawCleanupStatus === "verified"
				? "verified"
				: rawCleanupStatus === "uncertain"
					? "cleanup_uncertain"
					: undefined;
		const isError = event?.isError === true;
		const wasAborted = details?.status === "aborted";
		const outcome: OperationOutcome =
			cleanupStatus === "cleanup_uncertain"
				? "uncertain"
				: wasAborted
					? "cancelled"
					: isError
						? "failed"
						: "completed";
		const phase: CloseOperationInput["phase"] = outcome === "completed" ? "completed" : outcome;
		this.ledger.close(operationId, {
			phase,
			outcome,
			cleanupStatus,
			detail:
				cleanupStatus === "cleanup_uncertain" && Array.isArray(details?.survivingProcessIds)
					? `surviving pids: ${details.survivingProcessIds.join(",")}`
					: undefined,
		});
	}

	private markAllOpenSemantic(detail: string): void {
		for (const operation of this.openOperations()) {
			this.ledger.progress(operation.operationId, { progressKind: "semantic", detail });
		}
	}

	private openOperations(): OperationRecord[] {
		return this.ledger
			.snapshot()
			.operations.filter(
				(operation) => operation.activeSessionId === this.identity.activeSessionId && operation.status === "open",
			);
	}
}
