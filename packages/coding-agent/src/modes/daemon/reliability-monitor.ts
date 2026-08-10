import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getProcessStartId } from "../../core/session-lease.js";
import type { OperationLedgerSnapshot } from "./operation-ledger.js";

export const DEFAULT_SILENCE_WARNING_MS = 4 * 60_000;
export const DEFAULT_MONITOR_INTERVAL_MS = 60_000;
export type ReliabilityAlertKind =
	| "operation_silent"
	| "operation_deadline_exceeded"
	| "heartbeat_stale"
	| "process_missing";

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
	return snapshot.processStartId === undefined || getProcessStartId(snapshot.pid) === snapshot.processStartId;
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
	if (!processAlive(snapshot)) {
		return [
			{
				alertKey: `process_missing:${snapshot.instanceId}`,
				kind: "process_missing",
				severity: "warning",
				message: `Prime Agent ${snapshot.role} process ${snapshot.pid} is missing while its reliability ledger remains.`,
				instanceId: snapshot.instanceId,
				detectedAt,
			},
		];
	}

	const alerts: ReliabilityAlert[] = [];
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
}

interface NotificationOutboxFile {
	schemaVersion: 1;
	records: NotificationRecord[];
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
	private records: NotificationRecord[];

	constructor(
		private readonly path: string,
		private readonly now: () => number = Date.now,
	) {
		this.records = this.read();
	}

	enqueue(alert: ReliabilityAlert): NotificationRecord {
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
		};
		this.records.push(record);
		this.persist();
		return structuredClone(record);
	}

	recordAttempt(
		id: string,
		attempt: Omit<NotificationAttempt, "attemptedAt"> & { attemptedAt?: string },
	): NotificationRecord {
		const record = this.require(id);
		const normalized: NotificationAttempt = { ...attempt, attemptedAt: attempt.attemptedAt ?? this.timestamp() };
		record.attempts.push(normalized);
		record.updatedAt = normalized.attemptedAt;
		record.status = normalized.status === "delivered" ? "delivered" : "failed";
		this.persist();
		return structuredClone(record);
	}

	acknowledge(id: string): NotificationRecord {
		const record = this.require(id);
		const timestamp = this.timestamp();
		record.status = "acknowledged";
		record.acknowledgedAt = timestamp;
		record.updatedAt = timestamp;
		this.persist();
		return structuredClone(record);
	}

	pending(): NotificationRecord[] {
		return this.records
			.filter((record) => record.status === "pending" || record.status === "failed")
			.map((record) => structuredClone(record));
	}

	dueForDelivery(reminderIntervalMs = 15 * 60_000): NotificationRecord[] {
		const now = this.now();
		return this.records
			.filter((record) => {
				if (record.status === "acknowledged") return false;
				if (record.status === "pending" || record.status === "failed") return true;
				const lastAttempt = record.attempts.at(-1);
				return !lastAttempt || now - Date.parse(lastAttempt.attemptedAt) >= reminderIntervalMs;
			})
			.map((record) => structuredClone(record));
	}

	list(): NotificationRecord[] {
		return this.records.map((record) => structuredClone(record));
	}

	private require(id: string): NotificationRecord {
		const record = this.records.find((candidate) => candidate.id === id);
		if (!record) throw new Error(`Unknown notification: ${id}`);
		return record;
	}

	private timestamp(): string {
		return new Date(this.now()).toISOString();
	}

	private read(): NotificationRecord[] {
		if (!existsSync(this.path)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.path, "utf8")) as NotificationOutboxFile;
			return parsed.schemaVersion === 1 && Array.isArray(parsed.records) ? parsed.records : [];
		} catch {
			return [];
		}
	}

	private persist(): void {
		writeJsonAtomically(this.path, { schemaVersion: 1, records: this.records } satisfies NotificationOutboxFile);
	}
}

export interface ReliabilityMonitorResult {
	scannedSnapshots: number;
	alerts: ReliabilityAlert[];
	attemptedNotifications: number;
	pendingNotifications: number;
}

export function readOperationSnapshots(rootDir: string): OperationLedgerSnapshot[] {
	const operationDir = join(rootDir, "operations");
	if (!existsSync(operationDir)) return [];
	const snapshots: OperationLedgerSnapshot[] = [];
	for (const entry of readdirSync(operationDir)) {
		if (!entry.endsWith(".json")) continue;
		try {
			const parsed = JSON.parse(readFileSync(join(operationDir, entry), "utf8")) as OperationLedgerSnapshot;
			if (parsed.schemaVersion === 1 && Array.isArray(parsed.operations)) snapshots.push(parsed);
		} catch {
			// A corrupt or concurrently-replaced snapshot is skipped this pass and retried next pass.
		}
	}
	return snapshots;
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
}): Promise<ReliabilityMonitorResult> {
	const snapshots = readOperationSnapshots(options.rootDir);
	const alerts = snapshots.flatMap((snapshot) =>
		evaluateReliabilitySnapshot(snapshot, { now: options.now, processAlive: options.processAlive }),
	);
	const outbox = new NotificationOutbox(options.outboxPath ?? join(options.rootDir, "notification-outbox.json"));
	for (const alert of alerts) outbox.enqueue(alert);
	let attemptedNotifications = 0;
	for (const record of outbox.dueForDelivery()) {
		const localAttempt = deliverMacOsNotification(record);
		outbox.recordAttempt(record.id, localAttempt);
		attemptedNotifications += 1;
		if (localAttempt.status === "failed" && options.webhookUrl) {
			outbox.recordAttempt(record.id, await deliverWebhookNotification(record, options.webhookUrl));
			attemptedNotifications += 1;
		}
	}
	return {
		scannedSnapshots: snapshots.length,
		alerts,
		attemptedNotifications,
		pendingNotifications: outbox.pending().length,
	};
}
