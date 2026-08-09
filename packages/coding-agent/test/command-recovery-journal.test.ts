import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CommandRecoveryJournal, createCommandIdempotencyKey } from "../src/modes/daemon/command-recovery-journal.js";

describe("CommandRecoveryJournal", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPath(): string {
		const root = mkdtempSync(join(tmpdir(), "prime-agent-command-journal-"));
		roots.push(root);
		return join(root, "commands.jsonl");
	}

	it("marks received commands uncertain instead of replaying them", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("rejects reusing one idempotency key for a different command type", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });

		expect(() => journal.lookup("client-a", "command-a", "shutdown")).toThrow(
			/already received as prompt and cannot be reused as shutdown/,
		);
		expect(() => journal.begin("client-a", "command-a", "shutdown")).toThrow(
			/already received as prompt and cannot be reused as shutdown/,
		);
		expect(journal.lookup("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("looks up prior commands without inserting new receipts", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.lookup("client-a", "missing")).toBeUndefined();
		expect(journal.begin("client-a", "pending", "prompt")).toEqual({ status: "new" });
		expect(journal.lookup("client-a", "pending")).toEqual({ status: "pending" });
	});

	it("does not collide when client and command ids contain separators", () => {
		const journal = new CommandRecoveryJournal(createPath());
		expect(journal.begin("client:a", "command", "prompt")).toEqual({ status: "new" });
		expect(journal.begin("client", "a:command", "prompt")).toEqual({ status: "new" });
	});

	it("returns a durable stored result for a repeated idempotency key", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({
			status: "complete",
			response: {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: true,
			},
		});
	});

	it("requires durable response metadata to match the received command", () => {
		const journal = new CommandRecoveryJournal(createPath());
		journal.begin("client-a", "command-a", "prompt");

		expect(() =>
			journal.recordResult("client-a", "command-a", {
				id: "different-id",
				type: "response",
				command: "prompt",
				success: true,
			}),
		).toThrow(/does not match received command id/);
		expect(() =>
			journal.recordResult("client-a", "command-a", {
				id: "command-a",
				type: "response",
				command: "shutdown",
				success: true,
			}),
		).toThrow(/does not match received command type/);
		expect(journal.lookup("client-a", "command-a")).toEqual({ status: "pending" });
	});

	it("accepts a structurally identical repeated result but rejects a conflicting replacement", () => {
		const journal = new CommandRecoveryJournal(createPath());
		journal.begin("client-a", "command-a", "prompt");
		const response = {
			id: "command-a",
			type: "response" as const,
			command: "prompt" as const,
			success: true as const,
		};
		journal.recordResult("client-a", "command-a", response);
		const sameResponseDifferentKeyOrder = {
			success: true as const,
			command: "prompt" as const,
			type: "response" as const,
			id: "command-a",
		};
		expect(() => journal.recordResult("client-a", "command-a", sameResponseDifferentKeyOrder)).not.toThrow();
		expect(() =>
			journal.recordResult("client-a", "command-a", {
				id: "command-a",
				type: "response",
				command: "prompt",
				success: false,
				error: "conflicting result",
			}),
		).toThrow(/conflicting response/);
	});

	it("ignores a truncated final append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, '{"version":1,"type":"result"');

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "pending" });
	});

	it("fails closed on malformed journal data before the final partial append", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		appendFileSync(path, "{not valid json}\n");

		expect(() => new CommandRecoveryJournal(path)).toThrow(/line 2: malformed JSON/);
	});

	it("fails closed when a received record carries a non-canonical key", () => {
		const path = createPath();
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				type: "received",
				key: createCommandIdempotencyKey("other-client", "other-command"),
				clientId: "client-a",
				commandId: "command-a",
				commandType: "prompt",
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/non-canonical key/);
	});

	it("fails closed when a result has no preceding durable receipt", () => {
		const path = createPath();
		appendFileSync(
			path,
			`${JSON.stringify({
				version: 1,
				type: "result",
				key: createCommandIdempotencyKey("client-a", "command-a"),
				response: {
					id: "command-a",
					type: "response",
					command: "prompt",
					success: true,
				},
				recordedAt: new Date().toISOString(),
			})}\n`,
		);

		expect(() => new CommandRecoveryJournal(path)).toThrow(/no preceding received record/);
	});

	it("durably removes acknowledged results", () => {
		const path = createPath();
		const journal = new CommandRecoveryJournal(path);
		journal.begin("client-a", "command-a", "prompt");
		journal.recordResult("client-a", "command-a", {
			id: "command-a",
			type: "response",
			command: "prompt",
			success: true,
		});
		journal.acknowledge("client-a", "command-a");

		const restored = new CommandRecoveryJournal(path);
		expect(restored.begin("client-a", "command-a", "prompt")).toEqual({ status: "new" });
	});
});
