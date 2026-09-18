import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudCommandJournal } from "../src/core/cloud/command-journal.js";
import {
	type CloudCommand,
	type CloudCommandRequest,
	canonicalJson,
	cloudRequestDigest,
	parseCloudMessage,
	serializeCloudMessage,
} from "../src/core/cloud/protocol.js";

const promptA: CloudCommandRequest = { kind: "prompt", text: "hello cloud", queueIfBusy: true };
const promptB: CloudCommandRequest = { kind: "prompt", text: "hello again" };
const steerRequest: CloudCommandRequest = { kind: "steer", text: "step faster" };
const cancelChildRequest: CloudCommandRequest = { kind: "cancel_child", childId: "child-1" };

describe("CloudCommandJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-cloud-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	function recordCount(path: string): number {
		return readFileSync(path, "utf8")
			.split("\n")
			.filter((line) => line.length > 0).length;
	}

	it("admits durably before acknowledging", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		const admitted = journal.admit("cmd-a", promptA);
		expect(admitted.status).toBe("new");
		expect(admitted.receipt).toMatchObject({
			commandId: "cmd-a",
			digest: cloudRequestDigest(promptA),
			state: "accepted",
			uncertain: false,
		});
		expect(admitted.receipt.submittedAt).toEqual(admitted.receipt.updatedAt);
		// The admit record is on disk the moment admit returns.
		expect(readFileSync(path, "utf8")).toContain('"type":"admit"');
		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toMatchObject({ commandId: "cmd-a", state: "accepted" });
	});

	it("replays receipts for duplicate submits and never re-admits", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		expect(journal.admit("cmd-a", promptA).status).toBe("duplicate");
		expect(journal.admit("cmd-a", { queueIfBusy: true, text: "hello cloud", kind: "prompt" }).status).toBe(
			"duplicate",
		);
		expect(recordCount(path)).toBe(1);
	});

	it("rejects a same commandId submit with a different digest", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		const conflict = journal.admit("cmd-a", promptB);
		expect(conflict.status).toBe("conflict");
		expect(conflict.receipt.digest).toEqual(cloudRequestDigest(promptA));
		expect(recordCount(path)).toBe(1);

		const restored = new CloudCommandJournal(path);
		expect(restored.admit("cmd-a", promptB).status).toBe("conflict");
		expect(restored.admit("cmd-a", promptA).status).toBe("duplicate");
		expect(restored.admit("cmd-a", cancelChildRequest).status).toBe("conflict");
	});

	it("claims the oldest dispatchable command and fsyncs running before handing it out", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		journal.admit("cmd-b", promptB);

		const claimed = journal.claimNextPending();
		expect(claimed?.receipt).toMatchObject({ commandId: "cmd-a", state: "running" });
		expect(JSON.parse(claimed?.request ?? "null")).toEqual(promptA);
		// The running transition is durable the moment the claim returns.
		expect(new CloudCommandJournal(path).getReceipt("cmd-a")?.state).toBe("running");

		const second = journal.claimNextPending();
		expect(second?.receipt.commandId).toBe("cmd-b");
		expect(journal.claimNextPending()).toBeUndefined();
	});

	it("never replays uncertain work after a crash", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		journal.claimNextPending();

		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toMatchObject({ state: "running", uncertain: true });
		expect(restored.claimNextPending()).toBeUndefined();
		expect(restored.listPending()).toEqual([]);
		expect(restored.listUncertain().map((receipt) => receipt.commandId)).toEqual(["cmd-a"]);
		expect(() => restored.markRunning("cmd-a")).toThrow(/uncertain after restore/);

		restored.requeue("cmd-a");
		const reclaimed = restored.claimNextPending();
		expect(reclaimed?.receipt).toMatchObject({ commandId: "cmd-a", state: "running", uncertain: false });
	});

	it("restores accepted commands as pending because a claim fsyncs running first", () => {
		const path = createPath();
		new CloudCommandJournal(path).admit("cmd-a", promptA);

		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toMatchObject({ state: "accepted", uncertain: false });
		expect(restored.listUncertain()).toEqual([]);
		const duplicate = restored.admit("cmd-a", promptA);
		expect(duplicate.status).toBe("duplicate");
		expect(duplicate.receipt.uncertain).toBe(false);

		const claimed = restored.claimNextPending();
		expect(claimed?.receipt).toMatchObject({ commandId: "cmd-a", state: "running" });
	});

	it("keeps terminal states across restarts and never re-executes them", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		journal.claimNextPending();
		journal.complete("cmd-a");
		journal.admit("cmd-b", steerRequest);
		journal.claimNextPending();
		journal.fail("cmd-b", "model refused");
		journal.admit("cmd-c", cancelChildRequest);
		journal.claimNextPending();
		journal.cancel("cmd-c");

		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toMatchObject({ state: "completed", uncertain: false });
		expect(restored.getReceipt("cmd-b")).toMatchObject({ state: "failed", error: "model refused" });
		expect(restored.getReceipt("cmd-c")).toMatchObject({ state: "cancelled" });
		expect(restored.listUncertain()).toEqual([]);
		expect(restored.claimNextPending()).toBeUndefined();
		expect(restored.admit("cmd-a", promptA).receipt.state).toBe("completed");
		expect(restored.admit("cmd-a", promptB).status).toBe("conflict");
	});

	it("guards transition misuse", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		journal.claimNextPending();
		journal.complete("cmd-a");
		expect(() => journal.complete("cmd-a")).toThrow(/terminal state completed/);
		expect(() => journal.markRunning("cmd-a")).toThrow(/terminal state completed/);
		expect(() => journal.requeue("cmd-a")).toThrow(/is not uncertain/);
		expect(() => journal.complete("cmd-b")).toThrow(/unknown command/);
		expect(() => journal.fail("cmd-a", "x".repeat(3000))).toThrow(/failure error/);
		expect(() => journal.admit("", promptA)).toThrow();
		expect(() => journal.admit("cmd-x", { kind: "prompt" } as unknown as CloudCommandRequest)).toThrow(
			/invalid command request/,
		);
		expect(() => journal.admit("cmd-x", { kind: "start_task" } as unknown as CloudCommandRequest)).toThrow(
			/invalid command request/,
		);
		expect(() =>
			journal.admit("cmd-x", { kind: "steer", taskId: "task-1", text: "hi" } as unknown as CloudCommandRequest),
		).toThrow(/invalid command request/);
		expect(new CloudCommandJournal(createPath()).claimNextPending()).toBeUndefined();
	});

	it("ignores repeated running reports and truncated final appends", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		journal.claimNextPending();
		journal.markRunning("cmd-a");
		expect(recordCount(path)).toBe(2);

		appendFileSync(path, '{"version":1,"type":"tr');
		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toMatchObject({ state: "running", uncertain: true });
	});

	it("skips malformed and orphaned records", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		const digest = cloudRequestDigest(promptA);
		appendFileSync(
			path,
			[
				"not json",
				JSON.stringify({ version: 1, type: "transition", commandId: "cmd-z", state: "running", recordedAt: "x" }),
				JSON.stringify({
					version: 1,
					type: "admit",
					commandId: "cmd-b",
					digest,
					request: "{not json",
					recordedAt: "2026-09-16T00:00:00.000Z",
				}),
				JSON.stringify({ version: 2, type: "admit" }),
			]
				.map((line) => `${line}\n`)
				.join(""),
		);

		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")?.commandId).toBe("cmd-a");
		expect(restored.getReceipt("cmd-b")).toBeUndefined();
		expect(restored.getReceipt("cmd-z")).toBeUndefined();
	});

	it("compacts atomically without losing uncertain commands", () => {
		const path = createPath();
		const first = new CloudCommandJournal(path, { compactAfterRecords: 4 });
		first.admit("cmd-a", promptA);
		first.claimNextPending();
		expect(recordCount(path)).toBe(2);

		// Crash: cmd-a restores as uncertain running.
		const second = new CloudCommandJournal(path, { compactAfterRecords: 4 });
		second.admit("cmd-b", promptB);
		second.admit("cmd-c", cancelChildRequest);
		// The fourth record triggers compaction, which must preserve cmd-a's uncertainty.
		expect(recordCount(path)).toBe(4);

		const third = new CloudCommandJournal(path);
		expect(third.getReceipt("cmd-a")).toMatchObject({ state: "running", uncertain: true });
		expect(third.listUncertain().map((receipt) => receipt.commandId)).toEqual(["cmd-a"]);
		// Restored accepted commands were never dispatched, so they stay claimable.
		expect(third.claimNextPending()?.receipt.commandId).toBe("cmd-b");
		expect(third.claimNextPending()?.receipt.commandId).toBe("cmd-c");
		expect(third.claimNextPending()).toBeUndefined();

		third.requeue("cmd-a");
		const reclaimed = third.claimNextPending();
		expect(reclaimed?.receipt).toMatchObject({ commandId: "cmd-a", state: "running", uncertain: false });
	});

	it("never drops the record that triggers compaction", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path, { compactAfterRecords: 2 });
		journal.admit("cmd-a", promptA);
		journal.admit("cmd-b", promptB);
		const contents = readFileSync(path, "utf8");
		expect(contents).toContain('"commandId":"cmd-a"');
		expect(contents).toContain('"commandId":"cmd-b"');
		expect(recordCount(path)).toBe(2);

		const transitionJournal = new CloudCommandJournal(path, { compactAfterRecords: 3 });
		transitionJournal.claimNextPending();
		transitionJournal.complete("cmd-a");
		// One admit plus one latest-state transition per command.
		expect(recordCount(path)).toBe(3);

		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toMatchObject({ state: "completed" });
		expect(restored.getReceipt("cmd-b")).toMatchObject({ state: "accepted", uncertain: false });
	});

	it("skips admit records whose digest does not match their request", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		// A digest in valid format, but computed over a different request.
		const mismatchedDigest = cloudRequestDigest(promptB);
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				type: "admit",
				commandId: "cmd-b",
				digest: mismatchedDigest,
				request: canonicalJson(promptA),
				recordedAt: "2026-09-16T00:00:00.000Z",
			})}\n`,
		);

		const restored = new CloudCommandJournal(path);
		expect(restored.getReceipt("cmd-a")).toBeDefined();
		expect(restored.getReceipt("cmd-b")).toBeUndefined();
		expect(restored.admit("cmd-b", promptA).status).toBe("new");
	});

	it("exposes journal receipts through protocol command frames", () => {
		const path = createPath();
		const journal = new CloudCommandJournal(path);
		journal.admit("cmd-a", promptA);
		const claimed = journal.claimNextPending();
		if (claimed === undefined) {
			throw new Error("claim missing");
		}

		const command: CloudCommand = {
			type: "command",
			sessionId: "sess-1",
			generation: 2,
			receipt: claimed.receipt,
			request: canonicalJson(promptA),
		};
		const parsed = parseCloudMessage(serializeCloudMessage(command));
		expect(parsed.ok).toBe(true);
		expect(parsed.ok ? parsed.message : undefined).toEqual(command);
		expect((parsed.ok ? (parsed.message as CloudCommand).receipt : undefined)?.state).toBe("running");
	});
});
