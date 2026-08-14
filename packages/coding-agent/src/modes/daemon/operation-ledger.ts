import { createHash, randomUUID } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { compareProcessStartIds, getProcessStartId } from "../../core/session-lease.js";
import { evaluateOperationDeadline, resolveOperationTimeoutPolicy } from "./operation-timeout-policy.js";

export const OPERATION_LEDGER_SCHEMA_VERSION = 1 as const;
export type OperationKind = "turn" | "provider" | "tool" | "kernel" | "bash" | "compaction" | "retry";
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
	deadlineExtensionSource?: "human";
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

export interface OperationReconciliationMarker {
	ownerInstanceId: string;
	operationId: string;
	activeSessionId: string;
	sessionId?: string;
	reconciledAt: string;
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
	reconciliationMarkers?: OperationReconciliationMarker[];
	// Snapshots written before the bounded journal did not have a cursor. Readers retain a
	// timestamp fallback for those snapshots; new snapshots use this monotonic cursor instead.
	journalSequence?: number;
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
	maxJournalBytes?: number;
	maxJournalRecords?: number;
}

interface OpenOperationInput {
	operationId?: string;
	activeSessionId: string;
	sessionId?: string;
	parentOperationId?: string;
	kind: OperationKind;
	phase?: Exclude<OperationPhase, OperationOutcome>;
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
	phase?: Exclude<OperationPhase, OperationOutcome>;
	detail?: string;
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

type OperationJournalTransition = "checkpoint" | "state" | "open" | "progress" | "close";

interface OperationJournalCheckpointBase {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	transition: "checkpoint";
	recordedAt: string;
	sequence: number;
}

interface OperationJournalInlineCheckpointEvent extends OperationJournalCheckpointBase {
	snapshot: OperationLedgerSnapshot;
	encoding?: never;
	snapshotData?: never;
	snapshotFile?: never;
	snapshotSha256?: never;
}

interface OperationJournalCompressedCheckpointEvent extends OperationJournalCheckpointBase {
	encoding: "deflate-raw-base64";
	snapshotData: string;
	snapshotSha256: string;
	snapshot?: never;
	snapshotFile?: never;
}

interface OperationJournalExternalCheckpointEvent extends OperationJournalCheckpointBase {
	encoding: "deflate-raw-file";
	snapshotFile: string;
	snapshotSha256: string;
	snapshot?: never;
	snapshotData?: never;
}

type OperationJournalCheckpointEvent =
	| OperationJournalInlineCheckpointEvent
	| OperationJournalCompressedCheckpointEvent
	| OperationJournalExternalCheckpointEvent;

interface OperationJournalState {
	processState: OperationLedgerSnapshot["processState"];
	heartbeatAt: string;
	persistenceState: OperationLedgerSnapshot["persistenceState"];
	persistenceError?: string;
}

interface OperationJournalStateEvent {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	transition: "state";
	recordedAt: string;
	sequence: number;
	state: OperationJournalState;
}

interface OperationJournalRecordEvent {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	transition: "open" | "progress" | "close";
	recordedAt: string;
	sequence: number;
	progressKind?: OperationProgressKind;
	record: OperationRecord;
}

export type OperationJournalEvent =
	| OperationJournalCheckpointEvent
	| OperationJournalStateEvent
	| OperationJournalRecordEvent;

interface ReadableOperationJournalCheckpointEvent {
	schemaVersion: typeof OPERATION_LEDGER_SCHEMA_VERSION;
	transition: "checkpoint";
	recordedAt: string;
	sequence?: number;
	snapshot: OperationLedgerSnapshot;
}

type ReadableOperationJournalEvent =
	| ReadableOperationJournalCheckpointEvent
	| (Omit<OperationJournalStateEvent, "sequence"> & { sequence?: number })
	| (Omit<OperationJournalRecordEvent, "sequence"> & { sequence?: number });

interface PreparedJournalCheckpoint {
	serialized: string;
	externalBlob?: {
		fileName: string;
		data: Buffer;
	};
}

export interface OperationJournalWarning {
	type: "operation_journal_corrupt";
	path: string;
	error: string;
	instanceId?: string;
}

export interface OperationSnapshotEvidence {
	snapshots: OperationLedgerSnapshot[];
	warnings: OperationJournalWarning[];
}

const OPERATION_KINDS = ["turn", "provider", "tool", "kernel", "bash", "compaction", "retry"] as const;
const OPEN_OPERATION_PHASES = ["admitted", "starting", "active", "waiting_external", "cancelling", "cleanup"] as const;
const TERMINAL_OPERATION_PHASES = ["completed", "failed", "cancelled", "uncertain"] as const;
const OPERATION_PHASES = [...OPEN_OPERATION_PHASES, ...TERMINAL_OPERATION_PHASES] as const;
const OPERATION_OUTCOMES = ["completed", "failed", "cancelled", "uncertain"] as const;
const OPERATION_PROGRESS_KINDS = ["semantic", "bookkeeping"] as const;
const OPERATION_STATUSES = ["open", "terminal"] as const;
const OPERATION_ROLES = ["daemon", "worker", "standalone"] as const;
const PROCESS_STATES = ["active", "closed"] as const;
const PERSISTENCE_STATES = ["durable", "memory_only"] as const;
const BUDGET_STATES = ["within_budget", "budget_exhausted"] as const;
const OWNERSHIP_STATES = ["owned", "unowned", "uncertain"] as const;
const CLEANUP_STATES = ["not_started", "in_progress", "verified", "cleanup_uncertain"] as const;

const MAX_RETAINED_TERMINAL_OPERATIONS = 500;
const MAX_DEADLINE_EXTENSION_MS = 60 * 60_000;
const DEFAULT_MAX_DEADLINE_EXTENSIONS = 3;
export const DEFAULT_MAX_JOURNAL_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_JOURNAL_RECORDS = 4096;

export type DeadlineExtensionResult =
	| { status: "applied"; record: OperationRecord }
	| {
			status: "rejected";
			reason: "not_open" | "no_deadline" | "invalid_duration" | "renewal_cap";
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

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(value: unknown, choices: T): value is T[number] {
	return typeof value === "string" && (choices as readonly string[]).includes(value);
}

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isOptionalString(value: Record<string, unknown>, key: string): boolean {
	return value[key] === undefined || typeof value[key] === "string";
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOperationRecord(value: unknown): OperationRecord | undefined {
	if (
		!isObject(value) ||
		value.schemaVersion !== OPERATION_LEDGER_SCHEMA_VERSION ||
		!isNonEmptyString(value.operationId) ||
		!isNonEmptyString(value.activeSessionId) ||
		!isOneOf(value.kind, OPERATION_KINDS) ||
		!isOneOf(value.phase, OPERATION_PHASES) ||
		!isOneOf(value.status, OPERATION_STATUSES) ||
		!isTimestamp(value.startedAt) ||
		!isTimestamp(value.updatedAt) ||
		!isTimestamp(value.lastMeaningfulProgressAt) ||
		!isOptionalString(value, "sessionId") ||
		!isOptionalString(value, "parentOperationId") ||
		(value.deadlineAt !== undefined && !isTimestamp(value.deadlineAt)) ||
		!isOptionalString(value, "timeoutClass") ||
		!isOptionalString(value, "timeoutPolicySource") ||
		(value.deadlineExtensionCount !== undefined && !isNonNegativeInteger(value.deadlineExtensionCount)) ||
		(value.maxDeadlineExtensions !== undefined && !isNonNegativeInteger(value.maxDeadlineExtensions)) ||
		(value.lastDeadlineExtendedAt !== undefined && !isTimestamp(value.lastDeadlineExtendedAt)) ||
		(value.deadlineExtensionSource !== undefined && value.deadlineExtensionSource !== "human") ||
		(value.budgetState !== undefined && !isOneOf(value.budgetState, BUDGET_STATES)) ||
		(value.ownershipStatus !== undefined && !isOneOf(value.ownershipStatus, OWNERSHIP_STATES)) ||
		(value.cleanupStatus !== undefined && !isOneOf(value.cleanupStatus, CLEANUP_STATES)) ||
		(value.outcome !== undefined && !isOneOf(value.outcome, OPERATION_OUTCOMES)) ||
		!isOptionalString(value, "detail") ||
		(value.status === "open" && (!isOneOf(value.phase, OPEN_OPERATION_PHASES) || value.outcome !== undefined)) ||
		(value.status === "terminal" &&
			(!isOneOf(value.phase, TERMINAL_OPERATION_PHASES) || value.outcome !== value.phase)) ||
		(isNonNegativeInteger(value.deadlineExtensionCount) &&
			isNonNegativeInteger(value.maxDeadlineExtensions) &&
			value.deadlineExtensionCount > value.maxDeadlineExtensions)
	) {
		return undefined;
	}
	return {
		schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
		operationId: value.operationId,
		activeSessionId: value.activeSessionId,
		kind: value.kind,
		phase: value.phase,
		status: value.status,
		startedAt: value.startedAt,
		updatedAt: value.updatedAt,
		lastMeaningfulProgressAt: value.lastMeaningfulProgressAt,
		...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
		...(typeof value.parentOperationId === "string" ? { parentOperationId: value.parentOperationId } : {}),
		...(isTimestamp(value.deadlineAt) ? { deadlineAt: value.deadlineAt } : {}),
		...(typeof value.timeoutClass === "string" ? { timeoutClass: value.timeoutClass } : {}),
		...(typeof value.timeoutPolicySource === "string" ? { timeoutPolicySource: value.timeoutPolicySource } : {}),
		...(isNonNegativeInteger(value.deadlineExtensionCount)
			? { deadlineExtensionCount: value.deadlineExtensionCount }
			: {}),
		...(isNonNegativeInteger(value.maxDeadlineExtensions)
			? { maxDeadlineExtensions: value.maxDeadlineExtensions }
			: {}),
		...(isTimestamp(value.lastDeadlineExtendedAt) ? { lastDeadlineExtendedAt: value.lastDeadlineExtendedAt } : {}),
		...(value.deadlineExtensionSource === "human" ? { deadlineExtensionSource: "human" as const } : {}),
		...(isOneOf(value.budgetState, BUDGET_STATES) ? { budgetState: value.budgetState } : {}),
		...(isOneOf(value.ownershipStatus, OWNERSHIP_STATES) ? { ownershipStatus: value.ownershipStatus } : {}),
		...(isOneOf(value.cleanupStatus, CLEANUP_STATES) ? { cleanupStatus: value.cleanupStatus } : {}),
		...(isOneOf(value.outcome, OPERATION_OUTCOMES) ? { outcome: value.outcome } : {}),
		...(typeof value.detail === "string" ? { detail: value.detail } : {}),
	};
}

function addTerminalToLifetimeCounts(
	counts: Record<string, OperationLifetimeCounts>,
	record: Pick<OperationRecord, "kind" | "timeoutClass" | "outcome" | "cleanupStatus">,
): void {
	const key = operationGroupKey(record);
	counts[key] ??= { terminalCount: 0, uncertainOutcomeCount: 0, cleanupUncertainCount: 0 };
	const group = counts[key];
	group.terminalCount += 1;
	if (record.outcome === "uncertain") group.uncertainOutcomeCount += 1;
	if (record.cleanupStatus === "cleanup_uncertain") group.cleanupUncertainCount += 1;
}

function lifetimeCountsRegressed(
	previous: OperationLifetimeCounts,
	next: OperationLifetimeCounts | undefined,
): boolean {
	return (
		!next ||
		next.terminalCount < previous.terminalCount ||
		next.uncertainOutcomeCount < previous.uncertainOutcomeCount ||
		next.cleanupUncertainCount < previous.cleanupUncertainCount
	);
}

function parseLifetimeCounts(value: unknown): Record<string, OperationLifetimeCounts> | undefined {
	if (!isObject(value)) return undefined;
	const counts: Record<string, OperationLifetimeCounts> = {};
	for (const [key, rawCounts] of Object.entries(value)) {
		if (
			key.length === 0 ||
			!isObject(rawCounts) ||
			!isNonNegativeInteger(rawCounts.terminalCount) ||
			!isNonNegativeInteger(rawCounts.uncertainOutcomeCount) ||
			!isNonNegativeInteger(rawCounts.cleanupUncertainCount) ||
			rawCounts.uncertainOutcomeCount > rawCounts.terminalCount ||
			rawCounts.cleanupUncertainCount > rawCounts.terminalCount
		) {
			return undefined;
		}

		counts[key] = {
			terminalCount: rawCounts.terminalCount,
			uncertainOutcomeCount: rawCounts.uncertainOutcomeCount,
			cleanupUncertainCount: rawCounts.cleanupUncertainCount,
		};
	}
	return counts;
}

function parseReconciliationMarkers(value: unknown): OperationReconciliationMarker[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const markers: OperationReconciliationMarker[] = [];
	const identities = new Set<string>();
	for (const rawMarker of value) {
		if (
			!isObject(rawMarker) ||
			!isNonEmptyString(rawMarker.ownerInstanceId) ||
			!isNonEmptyString(rawMarker.operationId) ||
			!isNonEmptyString(rawMarker.activeSessionId) ||
			!isOptionalString(rawMarker, "sessionId") ||
			!isTimestamp(rawMarker.reconciledAt)
		) {
			return undefined;
		}
		const identity = `${rawMarker.ownerInstanceId}\u0000${rawMarker.operationId}`;
		if (identities.has(identity)) return undefined;
		identities.add(identity);
		markers.push({
			ownerInstanceId: rawMarker.ownerInstanceId,
			operationId: rawMarker.operationId,
			activeSessionId: rawMarker.activeSessionId,
			...(typeof rawMarker.sessionId === "string" ? { sessionId: rawMarker.sessionId } : {}),
			reconciledAt: rawMarker.reconciledAt,
		});
	}
	return markers;
}

function parseOperationLedgerSnapshot(value: unknown): OperationLedgerSnapshot | undefined {
	if (
		!isObject(value) ||
		value.schemaVersion !== OPERATION_LEDGER_SCHEMA_VERSION ||
		!isNonEmptyString(value.instanceId) ||
		!isNonNegativeInteger(value.pid) ||
		value.pid === 0 ||
		!isOneOf(value.role, OPERATION_ROLES) ||
		!isOneOf(value.processState, PROCESS_STATES) ||
		!isOneOf(value.persistenceState, PERSISTENCE_STATES) ||
		!isTimestamp(value.startedAt) ||
		!isTimestamp(value.heartbeatAt) ||
		!Array.isArray(value.operations) ||
		!isOptionalString(value, "processStartId") ||
		!isOptionalString(value, "persistenceError") ||
		(value.journalSequence !== undefined && !isNonNegativeInteger(value.journalSequence))
	) {
		return undefined;
	}
	const operations: OperationRecord[] = [];
	const operationIds = new Set<string>();
	for (const rawOperation of value.operations) {
		const operation = parseOperationRecord(rawOperation);
		if (!operation || operationIds.has(operation.operationId)) return undefined;
		operationIds.add(operation.operationId);
		operations.push(operation);
	}
	const lifetimeByGroup = value.lifetimeByGroup === undefined ? undefined : parseLifetimeCounts(value.lifetimeByGroup);
	if (value.lifetimeByGroup !== undefined && !lifetimeByGroup) return undefined;
	if (lifetimeByGroup) {
		const retainedCounts: Record<string, OperationLifetimeCounts> = {};
		for (const operation of operations) {
			if (operation.status === "terminal") addTerminalToLifetimeCounts(retainedCounts, operation);
		}
		for (const [key, retained] of Object.entries(retainedCounts)) {
			if (lifetimeCountsRegressed(retained, lifetimeByGroup[key])) return undefined;
		}
	}
	const reconciliationMarkers =
		value.reconciliationMarkers === undefined ? undefined : parseReconciliationMarkers(value.reconciliationMarkers);
	if (value.reconciliationMarkers !== undefined && !reconciliationMarkers) return undefined;
	return {
		schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
		instanceId: value.instanceId,
		pid: value.pid,
		role: value.role,
		processState: value.processState,
		persistenceState: value.persistenceState,
		startedAt: value.startedAt,
		heartbeatAt: value.heartbeatAt,
		operations,
		...(typeof value.processStartId === "string" ? { processStartId: value.processStartId } : {}),
		...(typeof value.persistenceError === "string" ? { persistenceError: value.persistenceError } : {}),
		...(lifetimeByGroup ? { lifetimeByGroup } : {}),
		...(reconciliationMarkers ? { reconciliationMarkers } : {}),
		...(isNonNegativeInteger(value.journalSequence) ? { journalSequence: value.journalSequence } : {}),
	};
}

function cloneSnapshot(snapshot: OperationLedgerSnapshot): OperationLedgerSnapshot {
	return {
		...snapshot,
		operations: snapshot.operations.map((record) => ({ ...record })),
		...(snapshot.lifetimeByGroup
			? {
					lifetimeByGroup: Object.fromEntries(
						Object.entries(snapshot.lifetimeByGroup).map(([key, counts]) => [key, { ...counts }]),
					),
				}
			: {}),
		...(snapshot.reconciliationMarkers
			? { reconciliationMarkers: snapshot.reconciliationMarkers.map((marker) => ({ ...marker })) }
			: {}),
	};
}

function parseJournalState(value: unknown): OperationJournalState | undefined {
	if (
		!isObject(value) ||
		!isOneOf(value.processState, PROCESS_STATES) ||
		!isTimestamp(value.heartbeatAt) ||
		!isOneOf(value.persistenceState, PERSISTENCE_STATES) ||
		!isOptionalString(value, "persistenceError")
	) {
		return undefined;
	}
	return {
		processState: value.processState,
		heartbeatAt: value.heartbeatAt,
		persistenceState: value.persistenceState,
		...(typeof value.persistenceError === "string" ? { persistenceError: value.persistenceError } : {}),
	};
}

function sha256(value: Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function parseCheckpointSnapshot(
	value: Record<string, unknown>,
	journalPath: string,
): OperationLedgerSnapshot | undefined {
	const journalFileName = basename(journalPath);
	const journalInstanceId = journalFileName.endsWith(".jsonl") ? journalFileName.slice(0, -".jsonl".length) : "";
	if (!journalInstanceId) return undefined;
	if (value.encoding === undefined) {
		if (value.snapshotData !== undefined || value.snapshotFile !== undefined || value.snapshotSha256 !== undefined) {
			return undefined;
		}
		const snapshot = parseOperationLedgerSnapshot(value.snapshot);
		return snapshot?.instanceId === journalInstanceId ? snapshot : undefined;
	}
	let compressed: Buffer;
	if (value.encoding === "deflate-raw-base64") {
		if (
			!isNonEmptyString(value.snapshotData) ||
			!isNonEmptyString(value.snapshotSha256) ||
			value.snapshot !== undefined ||
			value.snapshotFile !== undefined
		) {
			return undefined;
		}
		compressed = Buffer.from(value.snapshotData, "base64");
		if (compressed.toString("base64") !== value.snapshotData) return undefined;
	} else if (value.encoding === "deflate-raw-file") {
		const ownerPrefix = `.checkpoint-${sha256(Buffer.from(journalInstanceId))}-`;
		if (
			!isNonEmptyString(value.snapshotFile) ||
			!/^\.checkpoint-[a-f0-9]{64}-\d+-[a-f0-9-]+\.deflate$/.test(value.snapshotFile) ||
			!value.snapshotFile.startsWith(ownerPrefix) ||
			!isNonEmptyString(value.snapshotSha256) ||
			value.snapshot !== undefined ||
			value.snapshotData !== undefined
		) {
			return undefined;
		}
		try {
			compressed = readFileSync(join(dirname(journalPath), value.snapshotFile));
		} catch {
			return undefined;
		}
	} else {
		return undefined;
	}
	if (!/^[a-f0-9]{64}$/.test(value.snapshotSha256) || sha256(compressed) !== value.snapshotSha256) {
		return undefined;
	}
	try {
		const inflated = inflateRawSync(compressed).toString("utf8");
		const snapshot = parseOperationLedgerSnapshot(JSON.parse(inflated) as unknown);
		return snapshot?.instanceId === journalInstanceId ? snapshot : undefined;
	} catch {
		return undefined;
	}
}

function parseJournalEvent(value: unknown, journalPath: string): ReadableOperationJournalEvent | undefined {
	if (
		!isObject(value) ||
		value.schemaVersion !== OPERATION_LEDGER_SCHEMA_VERSION ||
		!isTimestamp(value.recordedAt) ||
		(value.sequence !== undefined && (!isNonNegativeInteger(value.sequence) || value.sequence === 0)) ||
		typeof value.transition !== "string"
	) {
		return undefined;
	}
	const sequence = isNonNegativeInteger(value.sequence) ? { sequence: value.sequence } : {};
	if (value.transition === "checkpoint") {
		const snapshot = parseCheckpointSnapshot(value, journalPath);
		if (
			!snapshot ||
			(isNonNegativeInteger(value.sequence) &&
				snapshot.journalSequence !== undefined &&
				snapshot.journalSequence !== value.sequence)
		) {
			return undefined;
		}
		return {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			transition: "checkpoint",
			recordedAt: value.recordedAt,
			snapshot,
			...sequence,
		};
	}
	if (
		value.encoding !== undefined ||
		value.snapshot !== undefined ||
		value.snapshotData !== undefined ||
		value.snapshotFile !== undefined ||
		value.snapshotSha256 !== undefined
	) {
		return undefined;
	}
	if (value.transition === "state") {
		const state = parseJournalState(value.state);
		return state
			? {
					schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
					transition: "state",
					recordedAt: value.recordedAt,
					state,
					...sequence,
				}
			: undefined;
	}
	if (value.transition !== "open" && value.transition !== "progress" && value.transition !== "close") return undefined;
	const record = parseOperationRecord(value.record);
	if (
		!record ||
		(value.transition === "progress" &&
			value.progressKind !== undefined &&
			!isOneOf(value.progressKind, OPERATION_PROGRESS_KINDS)) ||
		(value.transition !== "progress" && value.progressKind !== undefined) ||
		((value.transition === "open" || value.transition === "progress") && record.status !== "open") ||
		(value.transition === "close" && record.status !== "terminal")
	) {
		return undefined;
	}
	return {
		schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
		transition: value.transition,
		recordedAt: value.recordedAt,
		record,
		...(value.transition === "progress" && isOneOf(value.progressKind, OPERATION_PROGRESS_KINDS)
			? { progressKind: value.progressKind }
			: {}),
		...sequence,
	};
}

function readJournal(path: string): { events: ReadableOperationJournalEvent[]; error?: string } {
	if (!existsSync(path)) return { events: [] };
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return { events: [], error: error instanceof Error ? error.message : String(error) };
	}
	const lines = text.split("\n");
	const finalLineMayBeTorn = text.length > 0 && !text.endsWith("\n");
	const events: ReadableOperationJournalEvent[] = [];
	let previousSequence = 0;
	let lifetimeByGroup: Record<string, OperationLifetimeCounts> | undefined;
	let records = new Map<string, OperationRecord>();
	let reconciliationIdentities = new Set<string>();
	for (const [index, line] of lines.entries()) {
		if (!line.trim()) continue;
		const event = (() => {
			try {
				return parseJournalEvent(JSON.parse(line) as unknown, path);
			} catch {
				return undefined;
			}
		})();
		if (!event) {
			if (finalLineMayBeTorn && index === lines.length - 1) continue;
			return { events: [], error: `Invalid operation journal entry at line ${index + 1}` };
		}
		if (event.sequence !== undefined) {
			if (event.sequence <= previousSequence) {
				return { events: [], error: `Non-monotonic operation journal sequence at line ${index + 1}` };
			}
			previousSequence = event.sequence;
		}
		if (event.transition === "checkpoint") {
			const nextLifetime = event.snapshot.lifetimeByGroup ?? {};
			if (lifetimeByGroup) {
				for (const [key, previous] of Object.entries(lifetimeByGroup)) {
					if (lifetimeCountsRegressed(previous, nextLifetime[key])) {
						return { events: [], error: `Non-monotonic lifetime counters at line ${index + 1}` };
					}
				}
			}
			const nextReconciliationIdentities = new Set(
				(event.snapshot.reconciliationMarkers ?? []).map(
					(marker) => `${marker.ownerInstanceId}\u0000${marker.operationId}`,
				),
			);
			for (const identity of reconciliationIdentities) {
				if (!nextReconciliationIdentities.has(identity)) {
					return { events: [], error: `Non-monotonic reconciliation markers at line ${index + 1}` };
				}
			}
			lifetimeByGroup = Object.fromEntries(
				Object.entries(nextLifetime).map(([key, counts]) => [key, { ...counts }]),
			);
			records = new Map(event.snapshot.operations.map((record) => [record.operationId, { ...record }]));
			reconciliationIdentities = nextReconciliationIdentities;
		} else if (event.transition === "open") {
			const previous = records.get(event.record.operationId);
			if (previous?.status === "terminal") {
				return { events: [], error: `Operation reopened after terminal close at line ${index + 1}` };
			}
			records.set(event.record.operationId, { ...event.record });
		} else if (event.transition === "progress") {
			const previous = records.get(event.record.operationId);
			const previousExtensionCount = previous?.deadlineExtensionCount ?? 0;
			const nextExtensionCount = event.record.deadlineExtensionCount ?? 0;
			if (previous?.status === "terminal" || nextExtensionCount < previousExtensionCount) {
				return { events: [], error: `Non-monotonic operation progress at line ${index + 1}` };
			}
			records.set(event.record.operationId, { ...event.record });
		} else if (event.transition === "close") {
			if (records.get(event.record.operationId)?.status === "terminal") {
				return { events: [], error: `Operation closed more than once at line ${index + 1}` };
			}
			records.set(event.record.operationId, { ...event.record });
			lifetimeByGroup ??= {};
			addTerminalToLifetimeCounts(lifetimeByGroup, event.record);
		}
		events.push(event);
	}
	return { events };
}

function recordLifetimeTerminal(snapshot: OperationLedgerSnapshot, record: OperationRecord): void {
	snapshot.lifetimeByGroup ??= {};
	addTerminalToLifetimeCounts(snapshot.lifetimeByGroup, record);
}

function trimSnapshotTerminalRecords(snapshot: OperationLedgerSnapshot): void {
	const terminal = snapshot.operations.filter((record) => record.status === "terminal");
	if (terminal.length <= MAX_RETAINED_TERMINAL_OPERATIONS) return;
	const discarded = new Set(
		terminal
			.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
			.slice(0, terminal.length - MAX_RETAINED_TERMINAL_OPERATIONS)
			.map((record) => record.operationId),
	);
	snapshot.operations = snapshot.operations.filter((record) => !discarded.has(record.operationId));
}

function replayJournalEvents(
	base: OperationLedgerSnapshot,
	events: ReadableOperationJournalEvent[],
	shouldReplay: (event: ReadableOperationJournalEvent) => boolean,
): OperationLedgerSnapshot {
	let snapshot = cloneSnapshot(base);
	let records = new Map(snapshot.operations.map((record) => [record.operationId, { ...record }]));
	let closedOperationIds = new Set(
		snapshot.operations.filter((record) => record.status === "terminal").map((record) => record.operationId),
	);
	for (const event of events) {
		if (!shouldReplay(event)) continue;
		if (event.transition === "checkpoint") {
			snapshot = cloneSnapshot(event.snapshot);
			records = new Map(snapshot.operations.map((record) => [record.operationId, { ...record }]));
			closedOperationIds = new Set(
				snapshot.operations.filter((record) => record.status === "terminal").map((record) => record.operationId),
			);
		} else if (event.transition === "state") {
			snapshot.processState = event.state.processState;
			snapshot.heartbeatAt = event.state.heartbeatAt;
			snapshot.persistenceState = event.state.persistenceState;
			if (event.state.persistenceError) snapshot.persistenceError = event.state.persistenceError;
			else delete snapshot.persistenceError;
		} else if (event.transition === "open") {
			const existing = records.get(event.record.operationId);
			if (!existing || existing.status !== "terminal") records.set(event.record.operationId, { ...event.record });
		} else if (event.transition === "progress") {
			if (records.get(event.record.operationId)?.status !== "terminal") {
				records.set(event.record.operationId, { ...event.record });
			}
		} else if (!closedOperationIds.has(event.record.operationId)) {
			records.set(event.record.operationId, { ...event.record });
			closedOperationIds.add(event.record.operationId);
			recordLifetimeTerminal(snapshot, event.record);
		}
		if (event.sequence !== undefined) snapshot.journalSequence = event.sequence;
		if (event.recordedAt > snapshot.heartbeatAt) snapshot.heartbeatAt = event.recordedAt;
	}
	snapshot.operations = [...records.values()];
	trimSnapshotTerminalRecords(snapshot);
	return snapshot;
}

function eventIsNewerThanSnapshot(event: ReadableOperationJournalEvent, snapshot: OperationLedgerSnapshot): boolean {
	if (event.sequence !== undefined && snapshot.journalSequence !== undefined) {
		return event.sequence > snapshot.journalSequence;
	}
	return Date.parse(event.recordedAt) > Date.parse(snapshot.heartbeatAt);
}

function recoverSnapshotFromJournal(events: ReadableOperationJournalEvent[]): OperationLedgerSnapshot | undefined {
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index];
		if (event.transition !== "checkpoint") continue;
		return replayJournalEvents(event.snapshot, events.slice(index + 1), () => true);
	}
	return undefined;
}

export function readOperationLedgerEvidence(rootDir: string): OperationSnapshotEvidence {
	const operationDir = join(rootDir, "operations");
	let entries: string[];
	try {
		entries = readdirSync(operationDir);
	} catch {
		return { snapshots: [], warnings: [] };
	}
	const instanceIds = new Set<string>();
	for (const entry of entries) {
		if (entry.endsWith(".json")) instanceIds.add(entry.slice(0, -".json".length));
		if (entry.endsWith(".jsonl")) instanceIds.add(entry.slice(0, -".jsonl".length));
	}
	const snapshots: OperationLedgerSnapshot[] = [];
	const warnings: OperationJournalWarning[] = [];
	for (const instanceId of [...instanceIds].sort()) {
		const snapshotPath = join(operationDir, `${instanceId}.json`);
		const journalPath = join(operationDir, `${instanceId}.jsonl`);
		let snapshot: OperationLedgerSnapshot | undefined;
		if (existsSync(snapshotPath)) {
			try {
				snapshot = parseOperationLedgerSnapshot(JSON.parse(readFileSync(snapshotPath, "utf8")) as unknown);
			} catch {
				// A corrupt snapshot may still be recovered from a complete checkpoint journal.
			}
		}
		const journal = readJournal(journalPath);
		if (journal.error) {
			warnings.push({ type: "operation_journal_corrupt", path: journalPath, error: journal.error, instanceId });
			if (snapshot) snapshots.push(snapshot);
			continue;
		}
		const recovered = snapshot
			? replayJournalEvents(snapshot, journal.events, (event) => eventIsNewerThanSnapshot(event, snapshot))
			: recoverSnapshotFromJournal(journal.events);
		if (recovered) snapshots.push(recovered);
	}
	return { snapshots, warnings };
}

export class OperationLedger {
	readonly snapshotPath: string;
	readonly journalPath: string;
	private readonly records = new Map<string, OperationRecord>();
	private readonly rootDir: string;
	private readonly operationDir: string;
	private readonly reconciledSessions = new Set<string>();
	private readonly now: () => number;
	private readonly snapshotState: OperationLedgerSnapshot;
	private readonly maxJournalBytes: number;
	private readonly maxJournalRecords: number;
	private readonly checkpointBlobPrefix: string;
	private journalSequence = 0;
	private journalByteCount = 0;
	private journalRecordCount = 0;
	private readonly heartbeatTimer?: ReturnType<typeof setInterval>;

	constructor(options: OperationLedgerOptions) {
		const pid = options.pid ?? process.pid;
		const now = options.now ?? Date.now;
		const instanceId = options.instanceId ?? `${pid}-${randomUUID()}`;
		this.rootDir = options.rootDir;
		this.operationDir = join(options.rootDir, "operations");
		this.checkpointBlobPrefix = `.checkpoint-${sha256(Buffer.from(instanceId))}-`;
		this.snapshotPath = join(this.operationDir, `${instanceId}.json`);
		this.journalPath = join(this.operationDir, `${instanceId}.jsonl`);
		this.maxJournalBytes =
			typeof options.maxJournalBytes === "number" &&
			Number.isFinite(options.maxJournalBytes) &&
			options.maxJournalBytes > 0
				? Math.floor(options.maxJournalBytes)
				: DEFAULT_MAX_JOURNAL_BYTES;
		this.maxJournalRecords =
			typeof options.maxJournalRecords === "number" &&
			Number.isFinite(options.maxJournalRecords) &&
			options.maxJournalRecords > 0
				? Math.floor(options.maxJournalRecords)
				: DEFAULT_MAX_JOURNAL_RECORDS;
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
			journalSequence: this.journalSequence,
		};
		this.persist();
		this.writeCheckpoint();
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
			budgetState: input.budgetState ?? previous.budgetState,
			ownershipStatus: input.ownershipStatus ?? previous.ownershipStatus,
			cleanupStatus: input.cleanupStatus ?? previous.cleanupStatus,
			detail: input.detail ?? previous.detail,
		};
		this.records.set(operationId, record);
		this.commit("progress", record, input.progressKind);
		return { ...record };
	}

	extendDeadline(operationId: string, extensionMs: number): DeadlineExtensionResult {
		const previous = this.records.get(operationId);
		if (!previous || previous.status !== "open") return { status: "rejected", reason: "not_open" };
		if (!previous.deadlineAt) return { status: "rejected", reason: "no_deadline" };
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
			deadlineExtensionSource: "human",
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
		if (input.phase !== input.outcome) {
			throw new Error(`Terminal phase ${input.phase} must match outcome ${input.outcome}`);
		}
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
		recordLifetimeTerminal(this.snapshotState, record);
		this.trimTerminalRecords();
		this.commit("close", record);
		return { ...record };
	}

	reconcileSession(activeSessionId: string, sessionId?: string): OperationRecord[] {
		const key = sessionId ?? activeSessionId;
		if (this.reconciledSessions.has(key)) return [];
		this.reconciledSessions.add(key);
		const snapshots = readOperationLedgerEvidence(this.rootDir).snapshots;
		// A marker names the original owner and operation, so a later generation can distinguish
		// reconciliation from an unrelated owner that happened to reuse an operation id. Terminal
		// identities retain exact-once compatibility with journals written before markers existed.
		const reconciliationIdentities = new Set<string>();
		const legacyTerminalIdentities = new Set<string>();
		for (const snapshot of snapshots) {
			for (const marker of snapshot.reconciliationMarkers ?? []) {
				reconciliationIdentities.add(`${marker.ownerInstanceId}\u0000${marker.operationId}`);
			}
			for (const operation of snapshot.operations) {
				if (operation.status !== "terminal") continue;
				legacyTerminalIdentities.add(
					`${operation.activeSessionId}\u0000${operation.sessionId ?? ""}\u0000${operation.operationId}`,
				);
			}
		}

		const recovered: OperationRecord[] = [];
		for (const snapshot of snapshots) {
			if (snapshot.instanceId === this.snapshotState.instanceId || this.snapshotOwnerAlive(snapshot)) continue;
			for (const previous of snapshot.operations) {
				if (previous.status !== "open") continue;
				if (previous.activeSessionId !== activeSessionId && (!sessionId || previous.sessionId !== sessionId)) {
					continue;
				}
				const reconciliationIdentity = `${snapshot.instanceId}\u0000${previous.operationId}`;
				const terminalIdentity = `${previous.activeSessionId}\u0000${previous.sessionId ?? ""}\u0000${previous.operationId}`;
				if (
					this.records.has(previous.operationId) ||
					reconciliationIdentities.has(reconciliationIdentity) ||
					legacyTerminalIdentities.has(terminalIdentity)
				) {
					continue;
				}
				const reconciledAt = this.timestamp();
				const marker: OperationReconciliationMarker = {
					ownerInstanceId: snapshot.instanceId,
					operationId: previous.operationId,
					activeSessionId: previous.activeSessionId,
					...(previous.sessionId ? { sessionId: previous.sessionId } : {}),
					reconciledAt,
				};
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
					updatedAt: reconciledAt,
					detail: [
						previous.detail,
						`reconciled after owner ${snapshot.instanceId} stopped; operation was not replayed`,
					]
						.filter(Boolean)
						.join("; "),
				};
				this.snapshotState.reconciliationMarkers ??= [];
				this.snapshotState.reconciliationMarkers.push(marker);
				this.records.set(record.operationId, record);
				recordLifetimeTerminal(this.snapshotState, record);
				this.trimTerminalRecords();
				this.commit("close", record);
				reconciliationIdentities.add(reconciliationIdentity);
				legacyTerminalIdentities.add(terminalIdentity);
				recovered.push({ ...record });
			}
		}
		if (recovered.length > 0) {
			// A close record alone cannot identify its dead owner after snapshot loss. Replace the
			// active journal with a complete checkpoint so the owner-qualified marker is recoverable.
			this.writeCheckpoint();
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
		const timestamp = this.timestamp();
		this.snapshotState.heartbeatAt = timestamp;
		this.commitState(timestamp);
	}

	snapshot(): OperationLedgerSnapshot {
		return {
			...this.snapshotState,
			operations: [...this.records.values()].map((record) => ({ ...record })),
			...(this.snapshotState.lifetimeByGroup
				? {
						lifetimeByGroup: Object.fromEntries(
							Object.entries(this.snapshotState.lifetimeByGroup).map(([key, counts]) => [key, { ...counts }]),
						),
					}
				: {}),
			...(this.snapshotState.reconciliationMarkers
				? { reconciliationMarkers: this.snapshotState.reconciliationMarkers.map((marker) => ({ ...marker })) }
				: {}),
		};
	}

	dispose(): void {
		clearInterval(this.heartbeatTimer);
		this.snapshotState.processState = "closed";
		this.heartbeat();
	}
	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}

	private nextJournalSequence(): number {
		return this.journalSequence + 1;
	}

	private appendJournal(event: OperationJournalEvent): boolean {
		if (this.snapshotState.persistenceState !== "durable") return false;
		const serializedEvent = `${JSON.stringify(event)}\n`;
		try {
			appendFileSync(this.journalPath, serializedEvent, { encoding: "utf8", mode: 0o600 });
			this.journalSequence = event.sequence;
			this.snapshotState.journalSequence = event.sequence;
			this.journalByteCount += Buffer.byteLength(serializedEvent);
			this.journalRecordCount += 1;
			return true;
		} catch (error) {
			this.markPersistenceUnavailable(error);
			return false;
		}
	}

	private commit(
		transition: Extract<OperationJournalTransition, "open" | "progress" | "close">,
		record: OperationRecord,
		progressKind?: OperationProgressKind,
	): void {
		const recordedAt = this.timestamp();
		this.snapshotState.heartbeatAt = recordedAt;
		const event: OperationJournalRecordEvent = {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			transition,
			recordedAt,
			sequence: this.nextJournalSequence(),
			record: { ...record },
			...(progressKind ? { progressKind } : {}),
		};
		this.appendJournal(event);
		this.persist();
		this.compactJournalIfNeeded();
	}

	private commitState(recordedAt: string): void {
		const event: OperationJournalStateEvent = {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			transition: "state",
			recordedAt,
			sequence: this.nextJournalSequence(),
			state: {
				processState: this.snapshotState.processState,
				heartbeatAt: this.snapshotState.heartbeatAt,
				persistenceState: this.snapshotState.persistenceState,
				...(this.snapshotState.persistenceError ? { persistenceError: this.snapshotState.persistenceError } : {}),
			},
		};
		this.appendJournal(event);
		this.persist();
		this.compactJournalIfNeeded();
	}

	private persist(): void {
		this.snapshotState.operations = [...this.records.values()].map((record) => ({ ...record }));
		if (this.snapshotState.persistenceState !== "durable") return;
		try {
			writeJsonAtomically(this.snapshotPath, this.snapshotState);
		} catch (error) {
			this.markPersistenceUnavailable(error);
		}
	}

	private compactJournalIfNeeded(): void {
		if (
			this.snapshotState.persistenceState !== "durable" ||
			(this.journalByteCount <= this.maxJournalBytes && this.journalRecordCount <= this.maxJournalRecords)
		) {
			return;
		}
		this.writeCheckpoint();
	}

	private prepareCheckpoint(sequence: number): PreparedJournalCheckpoint {
		// Preserve the exact snapshot at every tier: plain JSON when it fits, deterministic raw
		// deflate inline next, then a hash-bound owner-specific sidecar when base64 overhead is too
		// large. The journal remains one bounded JSONL checkpoint without dropping detail or records.
		const snapshot = this.snapshot();
		snapshot.journalSequence = sequence;
		const base = {
			schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
			transition: "checkpoint" as const,
			recordedAt: this.timestamp(),
			sequence,
		};
		const inline: OperationJournalInlineCheckpointEvent = { ...base, snapshot };
		const serializedInline = `${JSON.stringify(inline)}\n`;
		if (Buffer.byteLength(serializedInline) <= this.maxJournalBytes) {
			return { serialized: serializedInline };
		}

		const compressed = deflateRawSync(Buffer.from(JSON.stringify(snapshot)));
		const snapshotSha256 = sha256(compressed);
		const compressedInline: OperationJournalCompressedCheckpointEvent = {
			...base,
			encoding: "deflate-raw-base64",
			snapshotData: compressed.toString("base64"),
			snapshotSha256,
		};
		const serializedCompressed = `${JSON.stringify(compressedInline)}\n`;
		if (Buffer.byteLength(serializedCompressed) <= this.maxJournalBytes) {
			return { serialized: serializedCompressed };
		}

		const fileName = `${this.checkpointBlobPrefix}${sequence}-${randomUUID()}.deflate`;
		const external: OperationJournalExternalCheckpointEvent = {
			...base,
			encoding: "deflate-raw-file",
			snapshotFile: fileName,
			snapshotSha256,
		};
		const serializedExternal = `${JSON.stringify(external)}\n`;
		if (Buffer.byteLength(serializedExternal) > this.maxJournalBytes) {
			throw new Error(`Operation journal byte cap ${this.maxJournalBytes} cannot hold checkpoint metadata`);
		}
		return {
			serialized: serializedExternal,
			externalBlob: { fileName, data: compressed },
		};
	}

	private writeCheckpoint(): void {
		if (this.snapshotState.persistenceState !== "durable") return;
		const sequence = this.nextJournalSequence();
		// Install an external blob before the journal reference. A crash before the journal rename
		// leaves the previous journal authoritative; a crash after it leaves a complete hash-bound
		// checkpoint. Old sidecars are removed only after the replacement is visible.
		const temporaryJournalPath = `${this.journalPath}.${process.pid}.${randomUUID()}.tmp`;
		let temporaryBlobPath: string | undefined;
		let retainedBlobFile: string | undefined;
		try {
			const checkpoint = this.prepareCheckpoint(sequence);
			if (checkpoint.externalBlob) {
				retainedBlobFile = checkpoint.externalBlob.fileName;
				const blobPath = join(this.operationDir, retainedBlobFile);
				temporaryBlobPath = `${blobPath}.${process.pid}.${randomUUID()}.tmp`;
				writeFileSync(temporaryBlobPath, checkpoint.externalBlob.data, { mode: 0o600 });
				renameSync(temporaryBlobPath, blobPath);
				temporaryBlobPath = undefined;
			}
			writeFileSync(temporaryJournalPath, checkpoint.serialized, { encoding: "utf8", mode: 0o600 });
			renameSync(temporaryJournalPath, this.journalPath);
			this.journalSequence = sequence;
			this.snapshotState.journalSequence = sequence;
			this.journalByteCount = Buffer.byteLength(checkpoint.serialized);
			this.journalRecordCount = 1;
			this.persist();
			try {
				for (const entry of readdirSync(this.operationDir)) {
					if (
						entry.startsWith(this.checkpointBlobPrefix) &&
						entry.endsWith(".deflate") &&
						entry !== retainedBlobFile
					) {
						try {
							unlinkSync(join(this.operationDir, entry));
						} catch {
							// Orphan cleanup is best effort; the active checkpoint never references it.
						}
					}
				}
			} catch {
				// Checkpoint durability does not depend on best-effort orphan discovery.
			}
		} catch (error) {
			for (const temporaryPath of [temporaryJournalPath, temporaryBlobPath]) {
				if (!temporaryPath) continue;
				try {
					unlinkSync(temporaryPath);
				} catch {
					// A failed replacement leaves the previous complete journal authoritative.
				}
			}
			this.markPersistenceUnavailable(error);
		}
	}

	private markPersistenceUnavailable(error: unknown): void {
		this.snapshotState.persistenceState = "memory_only";
		this.snapshotState.persistenceError = error instanceof Error ? error.message : String(error);
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
