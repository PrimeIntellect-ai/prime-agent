import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudEventOutboxError, DurableCloudEventOutbox } from "../src/core/cloud/event-outbox.js";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "cloud-outbox-test-"));
	roots.push(value);
	return value;
}
function status(recordedAt: string, value: "idle" | "busy" = "idle") {
	return { kind: "session_status" as const, recordedAt, status: value };
}
function caught(work: () => unknown): CloudEventOutboxError {
	try {
		work();
	} catch (error) {
		expect(error).toBeInstanceOf(CloudEventOutboxError);
		return error as CloudEventOutboxError;
	}
	throw new Error("expected operation to fail");
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DurableCloudEventOutbox", () => {
	it("fsyncs durable ordered events with stable ids and restores them", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		const first = outbox.append(status("2026-01-01T00:00:00.000Z"));
		const second = outbox.append(status("2026-01-01T00:00:01.000Z", "busy"));
		expect(first.event.sequence).toBe(1);
		expect(second.event.sequence).toBe(2);
		expect(first.eventId).toMatch(/^evt_[0-9a-f]{64}$/);
		const restored = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		expect(restored.eventsAfter({ generation: 1, sequence: 0 })).toEqual([first, second]);
		expect(statSync(join(directory, "outbox-meta.json")).mode & 0o777).toBe(0o600);
		expect(statSync(join(directory, "outbox-events.ndjson")).mode & 0o777).toBe(0o600);
	});

	it("persists acknowledgements and rejects backward or beyond-tail movement", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		outbox.append(status("a"));
		outbox.append(status("b"));
		outbox.ack({ generation: 1, sequence: 1 });
		expect(new DurableCloudEventOutbox({ directory, sessionId: "sess_test" }).acknowledgedCursor.sequence).toBe(1);
		expect(caught(() => outbox.ack({ generation: 1, sequence: 0 })).code).toBe("invalid-cursor");
		expect(caught(() => outbox.ack({ generation: 1, sequence: 3 })).code).toBe("invalid-cursor");
	});

	it("atomically compacts only acknowledged events and fences the old generation", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		outbox.append(status("a"));
		outbox.append(status("b", "busy"));
		outbox.append(status("c"));
		outbox.ack({ generation: 1, sequence: 2 });
		outbox.trimAcknowledged();
		expect(outbox.generation).toBe(2);
		expect(outbox.acknowledgedCursor.sequence).toBe(0);
		const retained = outbox.eventsAfter({ generation: 2, sequence: 0 });
		expect(retained).toHaveLength(1);
		expect(retained[0]?.event).toMatchObject({ sequence: 1, recordedAt: "c" });
		expect(caught(() => outbox.eventsAfter({ generation: 1, sequence: 2 })).code).toBe("generation-mismatch");
	});

	it("recovers a truncated final write but rejects a corrupt complete record", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		const first = outbox.append(status("a"));
		appendFileSync(join(directory, "outbox-events.ndjson"), '{"eventId":"partial');
		const restored = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		expect(restored.eventsAfter({ generation: 1, sequence: 0 })).toEqual([first]);
		appendFileSync(join(directory, "outbox-events.ndjson"), "not-json\n");
		expect(caught(() => new DurableCloudEventOutbox({ directory, sessionId: "sess_test" })).code).toBe("corrupt");
	});

	it("bounds record count, payload bytes, read limits, and cursor positions", () => {
		const outbox = new DurableCloudEventOutbox({
			directory: root(),
			sessionId: "sess_test",
			maxRecords: 2,
			maxEventBytes: 90,
		});
		outbox.append(status("a"));
		outbox.append(status("b"));
		expect(outbox.eventsAfter({ generation: 1, sequence: 0 }, 1)).toHaveLength(1);
		expect(caught(() => outbox.append(status("c"))).code).toBe("limit-exceeded");
		expect(caught(() => outbox.eventsAfter({ generation: 1, sequence: 3 })).code).toBe("invalid-cursor");
	});

	it("unlinks superseded epoch files after a committed trim and keeps foreign files", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		outbox.append(status("a"));
		outbox.append(status("b", "busy"));
		outbox.ack({ generation: 1, sequence: 2 });
		outbox.trimAcknowledged();
		// The first committed trim replaces the base file with epoch g2: the
		// superseded base file is gone, and the log still restores.
		expect(existsSync(join(directory, "outbox-events.ndjson"))).toBe(false);
		expect(existsSync(join(directory, "outbox-events.g2.ndjson"))).toBe(true);
		const restoredOnce = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		expect(restoredOnce.tailCursor).toEqual({ generation: 2, sequence: 0 });

		// A crashed trim can leave a stale epoch file behind; a foreign file
		// in the same directory must never be touched.
		writeFileSync(join(directory, "outbox-events.g7.ndjson"), "stale orphan\n");
		writeFileSync(join(directory, "unrelated.txt"), "foreign\n");

		restoredOnce.append(status("c"));
		restoredOnce.append(status("d"));
		restoredOnce.ack({ generation: 2, sequence: 2 });
		restoredOnce.trimAcknowledged();
		// The second committed trim leaves exactly one events file - the
		// current epoch - plus metadata; the stale epoch and the foreign
		// files are swept or kept accordingly.
		expect(existsSync(join(directory, "outbox-events.g2.ndjson"))).toBe(false);
		expect(existsSync(join(directory, "outbox-events.g7.ndjson"))).toBe(false);
		expect(existsSync(join(directory, "unrelated.txt"))).toBe(true);
		const entries = readdirSync(directory).sort();
		expect(entries).toEqual(["outbox-events.g3.ndjson", "outbox-meta.json", "unrelated.txt"]);
		const restoredTwice = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		expect(restoredTwice.tailCursor).toEqual({ generation: 3, sequence: 0 });
	});

	it("ignores an orphaned next-generation file when compaction did not commit metadata", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		outbox.append(status("a"));
		writeFileSync(join(directory, "outbox-events.g2.ndjson"), "orphaned partial generation\n");
		const restored = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		expect(restored.tailCursor).toEqual({ generation: 1, sequence: 1 });
	});

	it("detects metadata and record tampering", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		outbox.append(status("a"));
		const eventsPath = join(directory, "outbox-events.ndjson");
		const line = JSON.parse(readFileSync(eventsPath, "utf8")) as Record<string, unknown>;
		line.eventId = "evt_bad";
		appendFileSync(eventsPath, `${JSON.stringify(line)}\n`);
		expect(caught(() => new DurableCloudEventOutbox({ directory, sessionId: "sess_test" })).code).toBe("corrupt");
		chmodSync(eventsPath, 0o600);
	});
});

describe("DurableCloudEventOutbox with v2 session events", () => {
	it("stores every v2 event kind with stable ids and replays them in order", () => {
		const directory = root();
		const outbox = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		const entry = outbox.append({
			kind: "session_entry",
			recordedAt: "2026-01-01T00:00:00.000Z",
			sessionId: "sess-remote-1",
			entryId: "entry-1",
			entry: {
				type: "message",
				id: "entry-1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: "hi" },
			},
		});
		const live = outbox.append({
			kind: "session_event",
			recordedAt: "2026-01-01T00:00:01.000Z",
			sessionId: "sess-remote-1",
			event: { type: "message_update", message: { role: "assistant", content: "partial" } },
		});
		const meta = outbox.append({
			kind: "session_meta",
			recordedAt: "2026-01-01T00:00:02.000Z",
			sessionId: "sess-remote-1",
			streaming: false,
			runningTools: 0,
			queue: 0,
			recap: "done",
			taskState: "completed",
		});
		const roster = outbox.append({
			kind: "roster_delta",
			recordedAt: "2026-01-01T00:00:03.000Z",
			rows: [{ childId: "child-1", status: "running", depth: 1 }],
		});
		const child = outbox.append({
			kind: "child_update",
			recordedAt: "2026-01-01T00:00:04.000Z",
			childId: "child-1",
			status: "completed",
			answerPreview: "ok",
		});
		const usage = outbox.append({
			kind: "usage",
			recordedAt: "2026-01-01T00:00:05.000Z",
			sessionId: "sess-remote-1",
			totals: { inputTokens: 1, outputTokens: 2, requests: 1 },
			revision: 1,
		});
		const restored = new DurableCloudEventOutbox({ directory, sessionId: "sess_test" });
		const replayed = restored.eventsAfter({ generation: 1, sequence: 0 });
		expect(replayed).toEqual([entry, live, meta, roster, child, usage]);
		expect(replayed[0]?.eventId).toBe(entry.eventId);
	});

	it("rejects a session_entry event that exceeds the inline bound", () => {
		const outbox = new DurableCloudEventOutbox({
			directory: root(),
			sessionId: "sess_test",
			maxEventBytes: 256,
		});
		expect(
			caught(() =>
				outbox.append({
					kind: "session_entry",
					recordedAt: "2026-01-01T00:00:00.000Z",
					sessionId: "sess-remote-1",
					entryId: "entry-1",
					entry: {
						type: "message",
						id: "entry-1",
						timestamp: "t",
						message: { role: "user", content: "x".repeat(1_000) },
					},
				}),
			).code,
		).toBe("limit-exceeded");
	});
});
