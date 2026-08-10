import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OperationExtensionInbox } from "../src/modes/daemon/operation-extension-inbox.js";
import { OperationLedger } from "../src/modes/daemon/operation-ledger.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "prime-operation-extension-"));
	roots.push(value);
	return value;
}

describe("operation deadline extensions", () => {
	it("caps human-only deadline extensions and persists their human source", () => {
		let now = Date.parse("2026-08-10T10:00:00.000Z");
		const dir = root();
		const ledger = new OperationLedger({ rootDir: dir, now: () => now, heartbeatIntervalMs: 0 });
		ledger.open({
			operationId: "op-1",
			activeSessionId: "active",
			kind: "tool",
			deadlineAt: "2026-08-10T10:10:00.000Z",
			maxDeadlineExtensions: 2,
		});

		const first = ledger.extendDeadline("op-1", 5 * 60_000);
		expect(first).toMatchObject({
			status: "applied",
			record: {
				deadlineAt: "2026-08-10T10:15:00.000Z",
				deadlineExtensionCount: 1,
				deadlineExtensionSource: "human",
			},
		});
		now += 60_000;
		expect(ledger.extendDeadline("op-1", 5 * 60_000)).toMatchObject({
			status: "applied",
			record: { deadlineAt: "2026-08-10T10:20:00.000Z", deadlineExtensionCount: 2 },
		});
		expect(ledger.extendDeadline("op-1", 5 * 60_000)).toEqual({
			status: "rejected",
			reason: "renewal_cap",
		});
		ledger.dispose();
	});

	it("persists a restart-safe request and delivery receipt", () => {
		let now = Date.parse("2026-08-10T10:00:00.000Z");
		const dir = root();
		const inbox = new OperationExtensionInbox(dir, () => now);
		const request = inbox.request("op-2", 10 * 60_000);
		expect(new OperationExtensionInbox(dir, () => now).pending()).toEqual([request]);

		const ledger = new OperationLedger({ rootDir: dir, now: () => now, heartbeatIntervalMs: 0 });
		ledger.open({
			operationId: "op-2",
			activeSessionId: "active",
			kind: "tool",
			deadlineAt: "2026-08-10T10:30:00.000Z",
		});
		now += 1_000;
		const result = ledger.extendDeadline(request.operationId, request.extensionMs);
		const receipt = inbox.record(request, result);
		expect(receipt).toMatchObject({
			status: "applied",
			deadlineAt: "2026-08-10T10:40:00.000Z",
		});
		expect(new OperationExtensionInbox(dir).pending()).toEqual([]);
		ledger.dispose();
	});

	it("atomically gives one winner when two consumers claim the same request concurrently", async () => {
		let now = Date.parse("2026-08-10T10:00:00.000Z");
		const dir = root();
		const writer = new OperationExtensionInbox(dir, () => now);
		writer.request("op-concurrent", 5 * 60_000);
		const firstConsumer = new OperationExtensionInbox(dir, () => now);
		const secondConsumer = new OperationExtensionInbox(dir, () => now);
		const firstRequest = firstConsumer.pending()[0];
		const secondRequest = secondConsumer.pending()[0];
		if (!firstRequest || !secondRequest) throw new Error("Expected both consumers to observe the pending request");

		const ledger = new OperationLedger({ rootDir: dir, now: () => now, heartbeatIntervalMs: 0 });
		ledger.open({
			operationId: "op-concurrent",
			activeSessionId: "active",
			kind: "tool",
			deadlineAt: "2026-08-10T10:10:00.000Z",
		});
		const consumers = [
			{ inbox: firstConsumer, request: firstRequest },
			{ inbox: secondConsumer, request: secondRequest },
		] as const;
		const claimResults = await Promise.all(
			consumers.map(({ inbox, request }) =>
				Promise.resolve().then(() => {
					try {
						return inbox.claim(request);
					} catch {
						return undefined;
					}
				}),
			),
		);

		now += 1_000;
		let appliedExtensions = 0;
		for (const [index, claimResult] of claimResults.entries()) {
			if (!claimResult) continue;
			const consumer = consumers[index];
			if (!consumer) throw new Error(`Missing consumer for claim attempt ${index}`);
			const result = ledger.extendDeadline(consumer.request.operationId, consumer.request.extensionMs);
			if (result.status === "applied") appliedExtensions += 1;
			consumer.inbox.record(consumer.request, result);
		}

		const events = new OperationExtensionInbox(dir).events();
		expect(claimResults.filter(Boolean)).toHaveLength(1);
		expect(appliedExtensions).toBe(1);
		expect(events.filter((event) => event.type === "claim")).toHaveLength(1);
		expect(events.filter((event) => event.type === "receipt")).toHaveLength(1);
		expect(new OperationExtensionInbox(dir).pending()).toEqual([]);
		expect(ledger.snapshot().operations[0]).toMatchObject({
			operationId: "op-concurrent",
			deadlineAt: "2026-08-10T10:15:00.000Z",
			deadlineExtensionCount: 1,
		});
		ledger.dispose();
	});

	it("ignores malformed and non-human requests from the durable inbox", () => {
		const dir = root();
		const inbox = new OperationExtensionInbox(dir);
		const valid = inbox.request("op-valid", 60_000);
		const invalidRequests = [
			{
				type: "request",
				schemaVersion: 1,
				requestId: "extension-non-human",
				operationId: "op-non-human",
				extensionMs: 60_000,
				source: "self",
				requestedAt: "2026-08-10T10:00:00.000Z",
			},
			{
				type: "request",
				schemaVersion: 1,
				requestId: "extension-invalid-duration",
				operationId: "op-invalid-duration",
				extensionMs: "60_000",
				source: "human",
				requestedAt: "2026-08-10T10:00:00.000Z",
			},
			{
				type: "request",
				schemaVersion: 1,
				requestId: 42,
				operationId: "op-invalid-request-id",
				extensionMs: 60_000,
				source: "human",
				requestedAt: "2026-08-10T10:00:00.000Z",
			},
			{
				type: "request",
				schemaVersion: 1,
				requestId: "extension-invalid-requested-at",
				operationId: "op-invalid-requested-at",
				extensionMs: 60_000,
				source: "human",
				requestedAt: 1,
			},
		];
		for (const invalid of invalidRequests) {
			appendFileSync(inbox.path, `${JSON.stringify(invalid)}\n`);
		}

		const restarted = new OperationExtensionInbox(dir);
		expect(restarted.events()).toEqual([valid]);
		expect(restarted.pending()).toEqual([valid]);
	});

	it("constructs without touching the filesystem and creates the directory on first write", () => {
		const dir = root();
		// A reliability root that cannot be created: the parent path component is a file.
		writeFileSync(join(dir, "not-a-directory"), "");
		const unusable = join(dir, "not-a-directory", "reliability");

		// Constructing must not throw — AgentDaemon builds this eagerly and must still start.
		const inbox = new OperationExtensionInbox(unusable);
		expect(inbox.pending()).toEqual([]);
		expect(inbox.events()).toEqual([]);
		expect(() => inbox.request("op-3", 60_000)).toThrow();

		// A usable root is created lazily on the first append, not in the constructor.
		const lazyRoot = join(dir, "created", "on", "demand");
		expect(existsSync(lazyRoot)).toBe(false);
		const lazyInbox = new OperationExtensionInbox(lazyRoot);
		expect(existsSync(lazyRoot)).toBe(false);
		const request = lazyInbox.request("op-4", 60_000);
		expect(existsSync(lazyRoot)).toBe(true);
		expect(new OperationExtensionInbox(lazyRoot).pending()).toEqual([request]);
	});
});
