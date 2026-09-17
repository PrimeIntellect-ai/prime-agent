import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
