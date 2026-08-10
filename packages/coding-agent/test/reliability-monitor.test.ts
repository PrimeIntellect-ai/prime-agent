import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OperationLedgerSnapshot } from "../src/modes/daemon/operation-ledger.js";
import { evaluateReliabilitySnapshot, NotificationOutbox } from "../src/modes/daemon/reliability-monitor.js";

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

describe("reliability monitor", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("warns by the four-minute observation threshold so a one-minute observer meets five minutes", () => {
		const alerts = evaluateReliabilitySnapshot(snapshot(), {
			now: Date.parse("2026-08-10T08:04:01.000Z"),
			processAlive: () => true,
			silenceWarningMs: 4 * 60_000,
		});
		expect(alerts).toEqual([
			expect.objectContaining({ kind: "operation_silent", operationId: "op-1", severity: "warning" }),
		]);
	});

	it("detects process death independently of daemon/client connectivity", () => {
		const alerts = evaluateReliabilitySnapshot(snapshot({ operations: [] }), {
			now: Date.parse("2026-08-10T08:04:31.000Z"),
			processAlive: () => false,
		});
		expect(alerts).toEqual([expect.objectContaining({ kind: "process_missing", severity: "warning" })]);
	});

	it("surfaces a persisted deadline separately from generic silence", () => {
		const base = snapshot();
		base.operations[0]!.deadlineAt = "2026-08-10T08:03:00.000Z";
		base.operations[0]!.timeoutClass = "provider-advisory-cap";
		const alerts = evaluateReliabilitySnapshot(base, {
			now: Date.parse("2026-08-10T08:04:01.000Z"),
			processAlive: () => true,
		});
		expect(alerts).toEqual([expect.objectContaining({ kind: "operation_deadline_exceeded", operationId: "op-1" })]);
	});

	it("deduplicates durable alerts, records channel receipts, retries failures, and supports acknowledgement", () => {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-outbox-"));
		roots.push(root);
		let now = Date.parse("2026-08-10T08:05:00.000Z");
		const outbox = new NotificationOutbox(join(root, "outbox.json"), () => now);
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
		outbox.recordAttempt(first.id, { channel: "macos", status: "failed", error: "not available" });
		expect(outbox.pending()).toHaveLength(1);
		now += 60_000;
		outbox.recordAttempt(first.id, { channel: "webhook", status: "delivered", receipt: "http:202" });
		expect(outbox.pending()).toHaveLength(0);
		now += 16 * 60_000;
		expect(outbox.dueForDelivery()).toHaveLength(1);
		outbox.acknowledge(first.id);
		expect(outbox.list()[0]).toMatchObject({ status: "acknowledged" });
		expect(outbox.dueForDelivery()).toHaveLength(0);
	});
});
