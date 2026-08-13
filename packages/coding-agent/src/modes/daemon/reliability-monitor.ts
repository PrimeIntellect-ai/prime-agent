import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { compareProcessStartIds, getProcessStartId } from "../../core/session-lease.js";
import { acquireSyncFileLock, errorCode } from "../../utils/sync-file-lock.js";
import { OperationExtensionInbox } from "./operation-extension-inbox.js";
import {
	type OperationLedgerSnapshot,
	type OperationSnapshotEvidence,
	readOperationLedgerEvidence,
} from "./operation-ledger.js";
import {
	beginReliabilityMonitorServiceRunInDirectory,
	completeReliabilityMonitorServiceRunInDirectory,
	failReliabilityMonitorServiceRunInDirectory,
	RELIABILITY_MONITOR_SERVICE_LABEL,
	RELIABILITY_MONITOR_SERVICE_STALE_MS,
	type ReliabilityMonitorServiceState,
} from "./reliability-monitor-service.js";

export const DEFAULT_SILENCE_WARNING_MS = 4 * 60_000;
export const DEFAULT_MONITOR_INTERVAL_MS = 60_000;
export const DEFAULT_NOTIFICATION_RETRY_BASE_MS = 60_000;
export const DEFAULT_NOTIFICATION_RETRY_MAX_MS = 15 * 60_000;
export const DEFAULT_NOTIFICATION_REMINDER_INTERVAL_MS = 15 * 60_000;
export type ReliabilityAlertKind =
	| "operation_silent"
	| "operation_deadline_exceeded"
	| "heartbeat_stale"
	| "process_missing"
	| "operation_journal_corrupt"
	| "monitor_service_failed"
	| "monitor_service_stale";

export interface ReliabilityAlert {
	alertKey: string;
	kind: ReliabilityAlertKind;
	severity: "warning";
	message: string;
	instanceId: string;
	operationId?: string;
	activeSessionId?: string;
	detectedAt?: string;
}

interface EvaluateSnapshotOptions {
	now?: number;
	silenceWarningMs?: number;
	processAlive?: (snapshot: OperationLedgerSnapshot) => boolean;
}

function defaultProcessAlive(snapshot: OperationLedgerSnapshot): boolean {
	try {
		process.kill(snapshot.pid, 0);
	} catch {
		return false;
	}
	// Only a positive "mismatch" proves PID reuse. A cross-format comparison — a legacy `ps:` token
	// against the current `ps2:` rendering — is unverifiable, not a mismatch, and must not be reported
	// as a missing process: doing so both raises a false alert and suppresses the snapshot's real
	// alerts below. This matches OperationLedger's own liveness check.
	return compareProcessStartIds(snapshot.processStartId, getProcessStartId(snapshot.pid)) !== "mismatch";
}

export function evaluateReliabilitySnapshot(
	snapshot: OperationLedgerSnapshot,
	options: EvaluateSnapshotOptions = {},
): ReliabilityAlert[] {
	const now = options.now ?? Date.now();
	const threshold = options.silenceWarningMs ?? DEFAULT_SILENCE_WARNING_MS;
	const processAlive = options.processAlive ?? defaultProcessAlive;
	const detectedAt = new Date(now).toISOString();
	if (snapshot.processState === "closed") return [];
	const alerts: ReliabilityAlert[] = [];
	// A missing process is reported alongside the snapshot's other alerts, never instead of them.
	// Short-circuiting here meant one liveness misjudgement silently discarded every genuine deadline
	// and silence alert for that daemon — the alerts most worth having when something has gone wrong.
	if (!processAlive(snapshot)) {
		alerts.push({
			alertKey: `process_missing:${snapshot.instanceId}`,
			kind: "process_missing",
			severity: "warning",
			message: `Prime Agent ${snapshot.role} process ${snapshot.pid} is missing while its reliability ledger remains.`,
			instanceId: snapshot.instanceId,
			detectedAt,
		});
	}
	const heartbeatAgeMs = now - Date.parse(snapshot.heartbeatAt);
	if (Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs >= threshold) {
		alerts.push({
			alertKey: `heartbeat_stale:${snapshot.instanceId}`,
			kind: "heartbeat_stale",
			severity: "warning",
			message: `Prime Agent ${snapshot.role} heartbeat is ${Math.floor(heartbeatAgeMs / 1000)} seconds old.`,
			instanceId: snapshot.instanceId,
			detectedAt,
		});
	}
	for (const operation of snapshot.operations) {
		if (operation.status !== "open") continue;
		const deadlineMs = operation.deadlineAt ? Date.parse(operation.deadlineAt) : Number.NaN;
		if (Number.isFinite(deadlineMs) && deadlineMs <= now) {
			alerts.push({
				alertKey: `operation_deadline_exceeded:${snapshot.instanceId}:${operation.operationId}`,
				kind: "operation_deadline_exceeded",
				severity: "warning",
				message: `${operation.kind} operation ${operation.operationId} exceeded its persisted ${operation.timeoutClass ?? "operation"} deadline (phase: ${operation.phase}).`,
				instanceId: snapshot.instanceId,
				operationId: operation.operationId,
				activeSessionId: operation.activeSessionId,
				detectedAt,
			});
			continue;
		}
		const silenceMs = now - Date.parse(operation.lastMeaningfulProgressAt);
		if (!Number.isFinite(silenceMs) || silenceMs < threshold) continue;
		alerts.push({
			alertKey: `operation_silent:${snapshot.instanceId}:${operation.operationId}`,
			kind: "operation_silent",
			severity: "warning",
			message: `${operation.kind} operation ${operation.operationId} has made no meaningful progress for ${Math.floor(silenceMs / 1000)} seconds (phase: ${operation.phase}).`,
			instanceId: snapshot.instanceId,
			operationId: operation.operationId,
			activeSessionId: operation.activeSessionId,
			detectedAt,
		});
	}
	return alerts;
}

export function evaluateReliabilityMonitorServiceState(
	state: ReliabilityMonitorServiceState,
	now: number = Date.now(),
): ReliabilityAlert | undefined {
	const detectedAt = new Date(now).toISOString();
	if (state.status === "failed") {
		return {
			alertKey: "monitor_service_failed",
			kind: "monitor_service_failed",
			severity: "warning",
			message: `Prime Agent reliability monitor service failed${state.lastError ? `: ${state.lastError}` : "."}`,
			instanceId: RELIABILITY_MONITOR_SERVICE_LABEL,
			detectedAt,
		};
	}
	const referenceAt = state.status === "running" ? state.lastStartedAt : state.lastCompletedAt;
	if (!referenceAt) return undefined;
	const ageMs = now - Date.parse(referenceAt);
	if (!Number.isFinite(ageMs) || ageMs < RELIABILITY_MONITOR_SERVICE_STALE_MS) return undefined;
	return {
		alertKey: "monitor_service_stale",
		kind: "monitor_service_stale",
		severity: "warning",
		message:
			state.status === "running"
				? `Prime Agent reliability monitor service has been running for ${Math.floor(ageMs / 1000)} seconds without completing.`
				: `Prime Agent reliability monitor service last completed ${Math.floor(ageMs / 1000)} seconds ago.`,
		instanceId: RELIABILITY_MONITOR_SERVICE_LABEL,
		detectedAt,
	};
}

export interface NotificationAttempt {
	attemptedAt: string;
	channel: string;
	status: "delivered" | "failed";
	receipt?: string;
	error?: string;
}

export interface NotificationRecord extends ReliabilityAlert {
	id: string;
	createdAt: string;
	updatedAt: string;
	status: "pending" | "failed" | "delivered" | "acknowledged";
	attempts: NotificationAttempt[];
	acknowledgedAt?: string;
	retryCount: number;
	nextAttemptAt?: string;
}

type PersistedNotificationRecord = Omit<NotificationRecord, "retryCount" | "nextAttemptAt"> & {
	retryCount?: number;
	nextAttemptAt?: string;
};

interface NotificationOutboxFile {
	schemaVersion: 1;
	records: PersistedNotificationRecord[];
}

function writeJsonAtomically(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporaryPath, path);
	} catch (error) {
		try {
			unlinkSync(temporaryPath);
		} catch {
			// Best-effort cleanup; preserve the original error.
		}
		throw error;
	}
}

export class NotificationOutbox {
	private records: NotificationRecord[] = [];

	constructor(
		private readonly path: string,
		private readonly now: () => number = Date.now,
	) {
		this.withLock(() => undefined);
	}

	enqueue(alert: ReliabilityAlert): NotificationRecord {
		return this.withLock(() => {
			const existing = this.records.find(
				(record) => record.alertKey === alert.alertKey && record.status !== "acknowledged",
			);
			if (existing) return structuredClone(existing);
			const timestamp = this.timestamp();
			const record: NotificationRecord = {
				...alert,
				id: `notification_${randomUUID()}`,
				createdAt: timestamp,
				updatedAt: timestamp,
				status: "pending",
				attempts: [],
				retryCount: 0,
			};
			this.records.push(record);
			this.persistUnlocked();
			return structuredClone(record);
		});
	}

	recordDeliveryCycle(id: string, attempts: NotificationAttempt[]): NotificationRecord {
		return this.withLock(() => {
			if (attempts.length === 0) {
				throw new Error("A notification delivery cycle requires at least one attempt.");
			}
			const record = this.require(id);
			record.attempts.push(...attempts);
			const cycleTimestamp = this.deliveryCycleTimestamp(attempts);
			record.updatedAt = cycleTimestamp;
			if (record.status !== "acknowledged") {
				if (attempts.some((attempt) => attempt.status === "delivered")) {
					record.status = "delivered";
					record.retryCount = 0;
					delete record.nextAttemptAt;
				} else {
					record.status = "failed";
					record.retryCount += 1;
					record.nextAttemptAt = new Date(
						Date.parse(cycleTimestamp) + notificationRetryDelayMs(record.retryCount),
					).toISOString();
				}
			}
			this.persistUnlocked();
			return structuredClone(record);
		});
	}

	acknowledge(id: string): NotificationRecord {
		return this.withLock(() => {
			const record = this.require(id);
			const timestamp = this.timestamp();
			record.status = "acknowledged";
			record.acknowledgedAt = timestamp;
			record.updatedAt = timestamp;
			delete record.nextAttemptAt;
			this.persistUnlocked();
			return structuredClone(record);
		});
	}

	pending(): NotificationRecord[] {
		return this.withLock(() =>
			this.records
				.filter((record) => record.status === "pending" || record.status === "failed")
				.map((record) => structuredClone(record)),
		);
	}

	dueForDelivery(reminderIntervalMs = DEFAULT_NOTIFICATION_REMINDER_INTERVAL_MS): NotificationRecord[] {
		return this.withLock(() => {
			const now = this.now();
			return this.records
				.filter((record) => {
					if (record.status === "acknowledged") return false;
					if (record.status === "pending") return true;
					if (record.status === "failed") {
						if (!record.nextAttemptAt) return true;
						const nextAttemptAt = Date.parse(record.nextAttemptAt);
						return !Number.isFinite(nextAttemptAt) || nextAttemptAt <= now;
					}
					const lastAttempt = record.attempts.at(-1);
					if (!lastAttempt) return true;
					const lastAttemptAt = Date.parse(lastAttempt.attemptedAt);
					return !Number.isFinite(lastAttemptAt) || now - lastAttemptAt >= reminderIntervalMs;
				})
				.map((record) => structuredClone(record));
		});
	}

	list(): NotificationRecord[] {
		return this.withLock(() => this.records.map((record) => structuredClone(record)));
	}

	private withLock<T>(operation: () => T): T {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		// Keyed on the outbox file, not its directory: proper-lockfile registers in-process locks by
		// target, and the monitor state lock already uses that directory as its own target.
		const release = acquireSyncFileLock(this.path, { lockfilePath: `${this.path}.lock`, staleMs: 30_000 });
		try {
			this.records = this.readUnlocked();
			return operation();
		} finally {
			release();
		}
	}

	private require(id: string): NotificationRecord {
		const record = this.records.find((candidate) => candidate.id === id);
		if (!record) throw new Error(`Unknown notification: ${id}`);
		return record;
	}

	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}

	private deliveryCycleTimestamp(attempts: NotificationAttempt[]): string {
		let latest = Number.NEGATIVE_INFINITY;
		for (const attempt of attempts) {
			const attemptedAt = Date.parse(attempt.attemptedAt);
			if (Number.isFinite(attemptedAt) && attemptedAt > latest) latest = attemptedAt;
		}
		return Number.isFinite(latest) ? new Date(latest).toISOString() : this.timestamp();
	}

	private readUnlocked(): NotificationRecord[] {
		// Preserves an unreadable outbox instead of replacing it: the next persist would otherwise
		// drop every pending notification and receipt the file still holds.
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.path, "utf8"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") return [];
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to read notification outbox ${this.path}: ${message}`);
		}
		if (!isNotificationOutboxFile(parsed)) {
			throw new Error(`Invalid notification outbox ${this.path}: expected a notification outbox document`);
		}
		return parsed.records.map((record) => normalizeNotificationRecord(record));
	}

	private persistUnlocked(): void {
		writeJsonAtomically(this.path, { schemaVersion: 1, records: this.records } satisfies NotificationOutboxFile);
	}
}

function notificationRetryDelayMs(retryCount: number): number {
	const exponentialDelay = DEFAULT_NOTIFICATION_RETRY_BASE_MS * 2 ** Math.max(0, retryCount - 1);
	return Math.min(exponentialDelay, DEFAULT_NOTIFICATION_RETRY_MAX_MS);
}

function normalizeNotificationRecord(record: PersistedNotificationRecord): NotificationRecord {
	let retryCount = record.status === "failed" ? 1 : 0;
	if (record.retryCount !== undefined && Number.isInteger(record.retryCount) && record.retryCount >= 0) {
		retryCount = record.retryCount;
	}
	const normalized: NotificationRecord = { ...structuredClone(record), retryCount };
	if (normalized.status !== "failed") {
		delete normalized.nextAttemptAt;
		return normalized;
	}
	const nextAttemptAt = normalized.nextAttemptAt ? Date.parse(normalized.nextAttemptAt) : Number.NaN;
	if (Number.isFinite(nextAttemptAt)) return normalized;
	let retryFrom = Number.NaN;
	for (let index = normalized.attempts.length - 1; index >= 0; index -= 1) {
		const attempt = normalized.attempts[index]!;
		const attemptedAt = Date.parse(attempt.attemptedAt);
		if (attempt.status === "failed" && Number.isFinite(attemptedAt)) {
			retryFrom = attemptedAt;
			break;
		}
	}
	if (!Number.isFinite(retryFrom)) retryFrom = Date.parse(normalized.updatedAt);
	if (Number.isFinite(retryFrom)) {
		normalized.nextAttemptAt = new Date(retryFrom + notificationRetryDelayMs(normalized.retryCount)).toISOString();
	} else {
		delete normalized.nextAttemptAt;
	}
	return normalized;
}

function isNotificationOutboxFile(value: unknown): value is NotificationOutboxFile {
	if (typeof value !== "object" || value === null || !("schemaVersion" in value) || !("records" in value)) {
		return false;
	}
	return (
		value.schemaVersion === 1 && Array.isArray(value.records) && value.records.every(isPersistedNotificationRecord)
	);
}

function isPersistedNotificationRecord(value: unknown): value is PersistedNotificationRecord {
	if (typeof value !== "object" || value === null) return false;
	if (
		!("alertKey" in value) ||
		typeof value.alertKey !== "string" ||
		!("kind" in value) ||
		typeof value.kind !== "string" ||
		!isReliabilityAlertKind(value.kind) ||
		!("severity" in value) ||
		value.severity !== "warning" ||
		!("message" in value) ||
		typeof value.message !== "string" ||
		!("instanceId" in value) ||
		typeof value.instanceId !== "string" ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!("createdAt" in value) ||
		typeof value.createdAt !== "string" ||
		!("updatedAt" in value) ||
		typeof value.updatedAt !== "string" ||
		!("status" in value) ||
		typeof value.status !== "string" ||
		!isNotificationStatus(value.status) ||
		!("attempts" in value) ||
		!Array.isArray(value.attempts) ||
		!value.attempts.every(isNotificationAttempt)
	) {
		return false;
	}
	if ("operationId" in value && value.operationId !== undefined && typeof value.operationId !== "string") {
		return false;
	}
	if ("activeSessionId" in value && value.activeSessionId !== undefined && typeof value.activeSessionId !== "string") {
		return false;
	}
	if ("detectedAt" in value && value.detectedAt !== undefined && typeof value.detectedAt !== "string") {
		return false;
	}
	if ("acknowledgedAt" in value && value.acknowledgedAt !== undefined && typeof value.acknowledgedAt !== "string") {
		return false;
	}
	if ("retryCount" in value && value.retryCount !== undefined && typeof value.retryCount !== "number") {
		return false;
	}
	if ("nextAttemptAt" in value && value.nextAttemptAt !== undefined && typeof value.nextAttemptAt !== "string") {
		return false;
	}
	return true;
}

function isNotificationAttempt(value: unknown): value is NotificationAttempt {
	if (typeof value !== "object" || value === null) return false;
	if (
		!("attemptedAt" in value) ||
		typeof value.attemptedAt !== "string" ||
		!("channel" in value) ||
		typeof value.channel !== "string" ||
		!("status" in value) ||
		(value.status !== "delivered" && value.status !== "failed")
	) {
		return false;
	}
	if ("receipt" in value && value.receipt !== undefined && typeof value.receipt !== "string") return false;
	if ("error" in value && value.error !== undefined && typeof value.error !== "string") return false;
	return true;
}

function isReliabilityAlertKind(value: string): value is ReliabilityAlertKind {
	return (
		value === "operation_silent" ||
		value === "operation_deadline_exceeded" ||
		value === "heartbeat_stale" ||
		value === "process_missing" ||
		value === "operation_journal_corrupt" ||
		value === "monitor_service_failed" ||
		value === "monitor_service_stale"
	);
}

function isNotificationStatus(value: string): value is NotificationRecord["status"] {
	return value === "pending" || value === "failed" || value === "delivered" || value === "acknowledged";
}

export interface ReliabilityMonitorResult {
	scannedSnapshots: number;
	alerts: ReliabilityAlert[];
	attemptedNotifications: number;
	pendingNotifications: number;
	settledExtensionRequests: number;
}

export function readOperationSnapshotEvidence(rootDir: string): OperationSnapshotEvidence {
	return readOperationLedgerEvidence(rootDir);
}

export function readOperationSnapshots(rootDir: string): OperationLedgerSnapshot[] {
	return readOperationSnapshotEvidence(rootDir).snapshots;
}

function escapeAppleScript(value: string): string {
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function deliverMacOsNotification(record: NotificationRecord): NotificationAttempt {
	const attemptedAt = new Date().toISOString();
	if (process.platform !== "darwin") {
		return { attemptedAt, channel: "macos", status: "failed", error: "macOS notification channel unavailable" };
	}
	const script = `display notification "${escapeAppleScript(record.message)}" with title "Prime Agent warning"`;
	const result = spawnSync("osascript", ["-e", script], { encoding: "utf8", timeout: 10_000 });
	if (result.error || result.status !== 0) {
		return {
			attemptedAt,
			channel: "macos",
			status: "failed",
			error: result.error?.message ?? String(result.stderr || `exit ${result.status}`),
		};
	}
	return { attemptedAt, channel: "macos", status: "delivered", receipt: "osascript:0" };
}

export async function deliverWebhookNotification(
	record: NotificationRecord,
	webhookUrl: string,
): Promise<NotificationAttempt> {
	const attemptedAt = new Date().toISOString();
	try {
		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				id: record.id,
				severity: record.severity,
				kind: record.kind,
				message: record.message,
				activeSessionId: record.activeSessionId,
				operationId: record.operationId,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		if (!response.ok) {
			return { attemptedAt, channel: "webhook", status: "failed", error: `http:${response.status}` };
		}
		return { attemptedAt, channel: "webhook", status: "delivered", receipt: `http:${response.status}` };
	} catch (error) {
		return {
			attemptedAt,
			channel: "webhook",
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runReliabilityMonitorOnce(options: {
	rootDir: string;
	outboxPath?: string;
	webhookUrl?: string;
	now?: number;
	processAlive?: (snapshot: OperationLedgerSnapshot) => boolean;
	deliveryAttempts?: (record: NotificationRecord) => Promise<NotificationAttempt[]>;
}): Promise<ReliabilityMonitorResult> {
	const now = options.now ?? Date.now();
	const cycleClock = () => now;
	const serviceClock = options.now === undefined ? Date.now : cycleClock;
	const runStart = beginReliabilityMonitorServiceRunInDirectory(options.rootDir, serviceClock);
	try {
		const evidence = readOperationSnapshotEvidence(options.rootDir);
		const snapshots = evidence.snapshots;
		const openOperationIds = new Set(
			snapshots.flatMap((snapshot) =>
				snapshot.operations
					.filter((operation) => operation.status === "open")
					.map((operation) => operation.operationId),
			),
		);
		const extensionInbox = new OperationExtensionInbox(options.rootDir, cycleClock);
		let settledExtensionRequests = 0;
		// Settling stale extension requests is best-effort; alert delivery below remains available if the
		// inbox is unwritable. A corrupt journal may hide a newer open operation behind an otherwise
		// valid snapshot, so never turn that uncertainty into a durable not-open receipt.
		if (evidence.warnings.length === 0) {
			for (const request of extensionInbox.pending()) {
				if (openOperationIds.has(request.operationId)) continue;
				if (now - Date.parse(request.requestedAt) < DEFAULT_MONITOR_INTERVAL_MS) continue;
				try {
					extensionInbox.claim(request);
					extensionInbox.record(request, { status: "rejected", reason: "not_open" });
					settledExtensionRequests += 1;
				} catch {
					break;
				}
			}
		}
		const detectedAt = new Date(now).toISOString();
		const serviceAlert = runStart.previousState
			? evaluateReliabilityMonitorServiceState(runStart.previousState, now)
			: undefined;
		const serviceStateUnreadableAlert: ReliabilityAlert | undefined = runStart.previousStateError
			? {
					alertKey: "monitor_service_state_unreadable",
					kind: "monitor_service_failed",
					severity: "warning",
					message: `Prime Agent reliability monitor service state is unreadable: ${runStart.previousStateError}`,
					instanceId: RELIABILITY_MONITOR_SERVICE_LABEL,
					detectedAt,
				}
			: undefined;
		const alerts = [
			...(serviceAlert ? [serviceAlert] : []),
			...(serviceStateUnreadableAlert ? [serviceStateUnreadableAlert] : []),
			...evidence.warnings.map(
				(warning): ReliabilityAlert => ({
					alertKey: `operation_journal_corrupt:${warning.path}`,
					kind: "operation_journal_corrupt",
					severity: "warning",
					message: `Operation journal is corrupt at ${warning.path}: ${warning.error}`,
					instanceId: warning.instanceId ?? warning.path,
					detectedAt,
				}),
			),
			...snapshots.flatMap((snapshot) =>
				evaluateReliabilitySnapshot(snapshot, { now, processAlive: options.processAlive }),
			),
		];
		const outbox = new NotificationOutbox(
			options.outboxPath ?? join(options.rootDir, "notification-outbox.json"),
			cycleClock,
		);
		for (const alert of alerts) outbox.enqueue(alert);
		let attemptedNotifications = 0;
		for (const record of outbox.dueForDelivery()) {
			const attempts = options.deliveryAttempts
				? await options.deliveryAttempts(record)
				: await collectNotificationDeliveryAttempts(record, options.webhookUrl);
			if (attempts.length === 0) continue;
			outbox.recordDeliveryCycle(record.id, attempts);
			attemptedNotifications += attempts.length;
		}
		const result: ReliabilityMonitorResult = {
			scannedSnapshots: snapshots.length,
			alerts,
			attemptedNotifications,
			pendingNotifications: outbox.pending().length,
			settledExtensionRequests,
		};
		completeReliabilityMonitorServiceRunInDirectory(
			options.rootDir,
			{
				scannedSnapshots: result.scannedSnapshots,
				alertCount: result.alerts.length,
				attemptedNotifications: result.attemptedNotifications,
				pendingNotifications: result.pendingNotifications,
				settledExtensionRequests: result.settledExtensionRequests,
			},
			serviceClock,
		);
		return result;
	} catch (error) {
		failReliabilityMonitorServiceRunInDirectory(
			options.rootDir,
			error instanceof Error ? error.message : String(error),
			{ exitCode: 1, now: serviceClock },
		);
		throw error;
	}
}

async function collectNotificationDeliveryAttempts(
	record: NotificationRecord,
	webhookUrl: string | undefined,
): Promise<NotificationAttempt[]> {
	const localAttempt = deliverMacOsNotification(record);
	const attempts = [localAttempt];
	if (localAttempt.status === "failed" && webhookUrl) {
		attempts.push(await deliverWebhookNotification(record, webhookUrl));
	}
	return attempts;
}
