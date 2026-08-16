import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationLedgerSnapshot } from "../src/modes/daemon/operation-ledger.js";
import type {
	NotificationAttempt,
	NotificationRecord,
	ReliabilityAlert,
} from "../src/modes/daemon/reliability-monitor.js";
import * as reliabilityMonitor from "../src/modes/daemon/reliability-monitor.js";
import type { ReliabilityMonitorServiceState } from "../src/modes/daemon/reliability-monitor-service.js";

function snapshot(overrides: Partial<OperationLedgerSnapshot> = {}): OperationLedgerSnapshot {
	return {
		schemaVersion: 1,
		instanceId: "worker-1",
		pid: 1234,
		processStartId: "start-1",
		role: "worker",
		processState: "active",
		persistenceState: "durable",
		startedAt: "2026-08-10T08:00:00.000Z",
		heartbeatAt: "2026-08-10T08:04:30.000Z",
		operations: [
			{
				schemaVersion: 1,
				operationId: "op-1",
				activeSessionId: "active-1",
				sessionId: "session-1",
				kind: "provider",
				phase: "active",
				status: "open",
				startedAt: "2026-08-10T08:00:00.000Z",
				updatedAt: "2026-08-10T08:00:00.000Z",
				lastMeaningfulProgressAt: "2026-08-10T08:00:00.000Z",
			},
		],
		...overrides,
	};
}

function notificationAlert(alertKey: string): ReliabilityAlert {
	return {
		alertKey,
		kind: "operation_silent",
		severity: "warning",
		message: "provider operation has made no meaningful progress",
		instanceId: "worker-1",
		operationId: "op-1",
	};
}

function failedAttempt(now: number, channel: string): NotificationAttempt {
	return {
		attemptedAt: new Date(now).toISOString(),
		channel,
		status: "failed",
		error: `${channel} unavailable`,
	};
}

function deliveredAttempt(now: number, channel: string): NotificationAttempt {
	return {
		attemptedAt: new Date(now).toISOString(),
		channel,
		status: "delivered",
		receipt: `${channel}:ok`,
	};
}

function serviceStatePath(root: string): string {
	return join(root, "monitor-service-state.json");
}

describe("reliability monitor", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("warns by the four-minute observation threshold so a one-minute observer meets five minutes", () => {
		const alerts = reliabilityMonitor.evaluateReliabilitySnapshot(snapshot(), {
			now: Date.parse("2026-08-10T08:04:01.000Z"),
			processAlive: () => true,
			silenceWarningMs: 4 * 60_000,
		});
		expect(alerts).toEqual([
			expect.objectContaining({ kind: "operation_silent", operationId: "op-1", severity: "warning" }),
		]);
	});

	it("detects process death independently of daemon/client connectivity", () => {
		const alerts = reliabilityMonitor.evaluateReliabilitySnapshot(snapshot({ operations: [] }), {
			now: Date.parse("2026-08-10T08:04:31.000Z"),
			processAlive: () => false,
		});
		expect(alerts).toEqual([expect.objectContaining({ kind: "process_missing", severity: "warning" })]);
	});

	it("surfaces a persisted deadline separately from generic silence", () => {
		const base = snapshot();
		base.operations[0]!.deadlineAt = "2026-08-10T08:03:00.000Z";
		base.operations[0]!.timeoutClass = "provider-advisory-cap";
		const alerts = reliabilityMonitor.evaluateReliabilitySnapshot(base, {
			now: Date.parse("2026-08-10T08:04:01.000Z"),
			processAlive: () => true,
		});
		expect(alerts).toEqual([expect.objectContaining({ kind: "operation_deadline_exceeded", operationId: "op-1" })]);
	});

	it("deduplicates durable alerts, records channel receipts, retries failures, and supports acknowledgement", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-"));
		roots.push(root);
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		const outbox = new reliabilityMonitor.NotificationOutbox(join(root, "outbox.json"), () => now);
		const alert = {
			alertKey: "operation_silent:worker-1:op-1",
			kind: "operation_silent" as const,
			severity: "warning" as const,
			message: "provider operation has made no meaningful progress",
			instanceId: "worker-1",
			operationId: "op-1",
		};
		const first = outbox.enqueue(alert);
		expect(outbox.enqueue(alert).id).toBe(first.id);
		outbox.recordDeliveryCycle(first.id, [failedAttempt(now, "macos")]);
		expect(outbox.pending()).toHaveLength(1);
		now += 60_000;
		outbox.recordDeliveryCycle(first.id, [deliveredAttempt(now, "webhook")]);
		expect(outbox.pending()).toHaveLength(0);
		now += 16 * 60_000;
		expect(outbox.dueForDelivery()).toHaveLength(1);
		outbox.acknowledge(first.id);
		expect(outbox.list()[0]).toMatchObject({ status: "acknowledged" });
		expect(outbox.dueForDelivery()).toHaveLength(0);
	});

	it("reloads every outbox view and preserves concurrent durable mutations from long-lived instances", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-reload-"));
		roots.push(root);
		const path = join(root, "outbox.json");
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		const firstOutbox = new reliabilityMonitor.NotificationOutbox(path, () => now);
		const secondOutbox = new reliabilityMonitor.NotificationOutbox(path, () => now);
		const first = firstOutbox.enqueue(notificationAlert("operation_silent:worker-1:op-1"));

		expect(secondOutbox.list()).toEqual([expect.objectContaining({ id: first.id })]);
		const second = secondOutbox.enqueue(notificationAlert("operation_silent:worker-1:op-2"));
		now += 1;
		firstOutbox.acknowledge(first.id);
		now += 1;
		secondOutbox.recordDeliveryCycle(second.id, [failedAttempt(now, "webhook")]);

		const persisted = new reliabilityMonitor.NotificationOutbox(path, () => now).list();
		expect(persisted).toHaveLength(2);
		expect(persisted).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: first.id, status: "acknowledged" }),
				expect.objectContaining({ id: second.id, status: "failed", retryCount: 1 }),
			]),
		);
		expect(secondOutbox.pending()).toEqual([expect.objectContaining({ id: second.id, status: "failed" })]);
	});

	it("refuses to read a corrupt outbox and leaves the durable file untouched", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-corrupt-"));
		roots.push(root);
		const path = join(root, "outbox.json");
		const now = Date.parse("2026-08-10T08:05:00.000Z");
		const record = new reliabilityMonitor.NotificationOutbox(path, () => now).enqueue(
			notificationAlert("operation_silent:worker-1:op-1"),
		);
		expect(record.status).toBe("pending");

		const corrupt = '{"schemaVersion":1,"records":[{"id":';
		writeFileSync(path, corrupt);

		expect(() => new reliabilityMonitor.NotificationOutbox(path, () => now)).toThrow(
			/Failed to read notification outbox/,
		);
		expect(readFileSync(path, "utf8")).toBe(corrupt);
	});

	it("commits all channel receipts in one delivery cycle and persists its terminal retry state", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-cycle-"));
		roots.push(root);
		const path = join(root, "outbox.json");
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		const outbox = new reliabilityMonitor.NotificationOutbox(path, () => now);
		const record = outbox.enqueue(notificationAlert("operation_silent:worker-1:op-1"));

		const failed = outbox.recordDeliveryCycle(record.id, [
			failedAttempt(now, "macos"),
			failedAttempt(now, "webhook"),
		]);
		expect(failed).toMatchObject({
			status: "failed",
			retryCount: 1,
			nextAttemptAt: "2026-08-10T08:06:00.000Z",
		});
		expect(failed.attempts).toHaveLength(2);

		now += 60_000;
		const delivered = outbox.recordDeliveryCycle(record.id, [
			failedAttempt(now, "macos"),
			deliveredAttempt(now, "webhook"),
		]);
		expect(delivered).toMatchObject({ status: "delivered", retryCount: 0 });
		expect(delivered.nextAttemptAt).toBeUndefined();
		expect(delivered.attempts.map((attempt) => attempt.channel)).toEqual(["macos", "webhook", "macos", "webhook"]);
		expect(new reliabilityMonitor.NotificationOutbox(path, () => now).list()[0]).toMatchObject({
			status: "delivered",
			retryCount: 0,
		});
	});

	it("keeps acknowledgement authoritative when a late delivery cycle appends receipts", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-ack-"));
		roots.push(root);
		const path = join(root, "outbox.json");
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		const owner = new reliabilityMonitor.NotificationOutbox(path, () => now);
		const record = owner.enqueue(notificationAlert("operation_silent:worker-1:op-1"));
		const lateDelivery = new reliabilityMonitor.NotificationOutbox(path, () => now);

		now += 1_000;
		const acknowledged = owner.acknowledge(record.id);
		now += 1_000;
		lateDelivery.recordDeliveryCycle(record.id, [failedAttempt(now, "macos")]);

		const persisted = new reliabilityMonitor.NotificationOutbox(path, () => now).list()[0]!;
		expect(persisted).toMatchObject({
			id: record.id,
			status: "acknowledged",
			acknowledgedAt: acknowledged.acknowledgedAt,
		});
		expect(persisted.attempts).toContainEqual(expect.objectContaining({ channel: "macos", status: "failed" }));
	});

	it("uses durable 1/2/4/8/15-minute retry scheduling without making failed records due early", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-backoff-"));
		roots.push(root);
		const path = join(root, "outbox.json");
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		let outbox = new reliabilityMonitor.NotificationOutbox(path, () => now);
		const record = outbox.enqueue(notificationAlert("operation_silent:worker-1:op-1"));

		for (const delayMinutes of [1, 2, 4, 8, 15]) {
			const cycle = outbox.recordDeliveryCycle(record.id, [
				failedAttempt(now, "macos"),
				failedAttempt(now, "webhook"),
			]);
			const retryAt = now + delayMinutes * 60_000;
			expect(cycle).toMatchObject({
				retryCount: [1, 2, 4, 8, 15].indexOf(delayMinutes) + 1,
				nextAttemptAt: new Date(retryAt).toISOString(),
			});
			outbox = new reliabilityMonitor.NotificationOutbox(path, () => now);
			now = retryAt - 1;
			expect(outbox.dueForDelivery()).toEqual([]);
			now += 1;
			expect(outbox.dueForDelivery()).toEqual([expect.objectContaining({ id: record.id })]);
		}
	});

	it("repeats delivered but unacknowledged notifications only at the fifteen-minute reminder interval", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-reminder-"));
		roots.push(root);
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		const outbox = new reliabilityMonitor.NotificationOutbox(join(root, "outbox.json"), () => now);
		const record = outbox.enqueue(notificationAlert("operation_silent:worker-1:op-1"));

		outbox.recordDeliveryCycle(record.id, [deliveredAttempt(now, "macos")]);
		now += 15 * 60_000 - 1;
		expect(outbox.dueForDelivery()).toEqual([]);
		now += 1;
		expect(outbox.dueForDelivery()).toEqual([expect.objectContaining({ id: record.id, status: "delivered" })]);
	});

	it("derives a base-delay retry for legacy failed records that lack durable retry fields", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-legacy-"));
		roots.push(root);
		const path = join(root, "outbox.json");
		const failedAt = Date.parse("2026-08-10T08:05:00.000Z");
		const alert = notificationAlert("operation_silent:worker-1:op-1");
		writeFileSync(
			path,
			`${JSON.stringify({
				schemaVersion: 1,
				records: [
					{
						...alert,
						id: "notification_legacy",
						createdAt: new Date(failedAt).toISOString(),
						updatedAt: new Date(failedAt).toISOString(),
						status: "failed",
						attempts: [failedAttempt(failedAt, "macos")],
					},
				],
			})}\n`,
		);
		let now = failedAt + 60_000 - 1;
		const outbox = new reliabilityMonitor.NotificationOutbox(path, () => now);

		expect(outbox.list()).toEqual([
			expect.objectContaining({
				id: "notification_legacy",
				retryCount: 1,
				nextAttemptAt: "2026-08-10T08:06:00.000Z",
			}),
		]);
		expect(outbox.dueForDelivery()).toEqual([]);
		now += 1;
		expect(outbox.dueForDelivery()).toEqual([expect.objectContaining({ id: "notification_legacy" })]);
	});

	it("persists the exact owner-only service state after a successful monitor cycle", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-state-success-"));
		roots.push(root);
		const now = Date.parse("2026-08-10T08:05:00.000Z");

		const result = await reliabilityMonitor.runReliabilityMonitorOnce({ rootDir: root, now });

		expect(result).toEqual({
			scannedSnapshots: 0,
			alerts: [],
			attemptedNotifications: 0,
			pendingNotifications: 0,
			settledExtensionRequests: 0,
		});
		const statePath = serviceStatePath(root);
		expect(JSON.parse(readFileSync(statePath, "utf8")) as unknown).toEqual({
			schemaVersion: 1,
			status: "succeeded",
			lastStartedAt: "2026-08-10T08:05:00.000Z",
			lastCompletedAt: "2026-08-10T08:05:00.000Z",
			lastExitCode: 0,
			lastResult: {
				scannedSnapshots: 0,
				alertCount: 0,
				attemptedNotifications: 0,
				pendingNotifications: 0,
				settledExtensionRequests: 0,
			},
		});
		expect(statSync(statePath).mode & 0o777).toBe(0o600);
	});

	it("writes failed service state before rethrowing a monitor failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-state-failure-"));
		roots.push(root);
		const operationDir = join(root, "operations");
		mkdirSync(operationDir, { recursive: true });
		writeFileSync(join(operationDir, "worker-1.json"), JSON.stringify(snapshot({ operations: [] })));
		const now = Date.parse("2026-08-10T08:05:00.000Z");

		await expect(
			reliabilityMonitor.runReliabilityMonitorOnce({
				rootDir: root,
				now,
				processAlive: () => {
					throw new Error("liveness probe exploded");
				},
			}),
		).rejects.toThrow("liveness probe exploded");

		expect(JSON.parse(readFileSync(serviceStatePath(root), "utf8")) as unknown).toMatchObject({
			schemaVersion: 1,
			status: "failed",
			lastStartedAt: "2026-08-10T08:05:00.000Z",
			lastExitCode: 1,
			lastError: "liveness probe exploded",
		});
	});

	it("emits failed and stale monitor liveness alerts through the next successful monitor cycle", async () => {
		const now = Date.parse("2026-08-10T08:05:00.000Z");
		const scenarios: Array<{ state: ReliabilityMonitorServiceState; kind: string }> = [
			{
				state: {
					schemaVersion: 1,
					status: "failed",
					lastStartedAt: new Date(now - 1_000).toISOString(),
					lastCompletedAt: new Date(now - 1_000).toISOString(),
					lastExitCode: 1,
					lastError: "monitor command exited 1",
				},
				kind: "monitor_service_failed",
			},
			{
				state: {
					schemaVersion: 1,
					status: "running",
					lastStartedAt: new Date(now - 180_001).toISOString(),
				},
				kind: "monitor_service_stale",
			},
			{
				state: {
					schemaVersion: 1,
					status: "succeeded",
					lastStartedAt: new Date(now - 180_001).toISOString(),
					lastCompletedAt: new Date(now - 180_001).toISOString(),
					lastExitCode: 0,
					lastResult: {
						scannedSnapshots: 0,
						alertCount: 0,
						attemptedNotifications: 0,
						pendingNotifications: 0,
						settledExtensionRequests: 0,
					},
				},
				kind: "monitor_service_stale",
			},
		];

		for (const scenario of scenarios) {
			const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-liveness-"));
			roots.push(root);
			writeFileSync(serviceStatePath(root), `${JSON.stringify(scenario.state)}\n`);
			const delivered: NotificationRecord[] = [];
			const result = await reliabilityMonitor.runReliabilityMonitorOnce({
				rootDir: root,
				now,
				deliveryAttempts: async (record) => {
					delivered.push(record);
					return [deliveredAttempt(now, "test")];
				},
			});

			expect(result.alerts).toContainEqual(expect.objectContaining({ kind: scenario.kind }));
			expect(delivered).toEqual([expect.objectContaining({ alertKey: scenario.kind })]);
		}
	});

	it("emits an alert for a corrupt service state instead of silently discarding it", async () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-monitor-corrupt-state-"));
		roots.push(root);
		const now = Date.parse("2026-08-10T08:05:00.000Z");
		writeFileSync(serviceStatePath(root), "{ not valid json");
		const delivered: NotificationRecord[] = [];

		const result = await reliabilityMonitor.runReliabilityMonitorOnce({
			rootDir: root,
			now,
			deliveryAttempts: async (record) => {
				delivered.push(record);
				return [deliveredAttempt(now, "test")];
			},
		});

		expect(result.alerts).toContainEqual(
			expect.objectContaining({
				alertKey: "monitor_service_state_unreadable",
				kind: "monitor_service_failed",
			}),
		);
		expect(delivered).toEqual([expect.objectContaining({ alertKey: "monitor_service_state_unreadable" })]);
	});
});
