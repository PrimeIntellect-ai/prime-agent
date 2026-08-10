import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	it("rejects self-renewal and caps explicit human extensions", () => {
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

		expect(ledger.extendDeadline("op-1", 5 * 60_000, "self")).toEqual({
			status: "rejected",
			reason: "invalid_source",
		});
		const first = ledger.extendDeadline("op-1", 5 * 60_000, "human");
		expect(first).toMatchObject({
			status: "applied",
			record: {
				deadlineAt: "2026-08-10T10:15:00.000Z",
				deadlineExtensionCount: 1,
				deadlineExtensionSource: "human",
			},
		});
		now += 60_000;
		expect(ledger.extendDeadline("op-1", 5 * 60_000, "human")).toMatchObject({
			status: "applied",
			record: { deadlineAt: "2026-08-10T10:20:00.000Z", deadlineExtensionCount: 2 },
		});
		expect(ledger.extendDeadline("op-1", 5 * 60_000, "human")).toEqual({
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
		const result = ledger.extendDeadline(request.operationId, request.extensionMs, request.source);
		const receipt = inbox.record(request, result);
		expect(receipt).toMatchObject({
			status: "applied",
			deadlineAt: "2026-08-10T10:40:00.000Z",
		});
		expect(new OperationExtensionInbox(dir).pending()).toEqual([]);
		ledger.dispose();
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
