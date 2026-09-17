import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type CloudOutboxEvent, DurableCloudEventOutbox } from "../src/core/cloud/event-outbox.js";
import { CloudTraceMirrorError, type CloudTraceSink, DurableCloudTraceMirror } from "../src/core/cloud/trace-mirror.js";

const roots: string[] = [];
function root(): string {
	const value = mkdtempSync(join(tmpdir(), "cloud-mirror-test-"));
	roots.push(value);
	return value;
}
function eventsAt(rootPath: string, count: number): CloudOutboxEvent[] {
	const outbox = new DurableCloudEventOutbox({ directory: join(rootPath, "remote"), sessionId: "sess_test" });
	return Array.from({ length: count }, (_, index) =>
		outbox.append({ kind: "session_status", recordedAt: `t${index}`, status: index % 2 === 0 ? "idle" : "busy" }),
	);
}
class Sink implements CloudTraceSink {
	readonly events: CloudOutboxEvent[] = [];
	fail = false;
	async persistCloudEvent(event: CloudOutboxEvent): Promise<void> {
		if (this.fail) throw new Error("disk unavailable");
		this.events.push(event);
	}
}
async function rejected(work: Promise<unknown>): Promise<CloudTraceMirrorError> {
	try {
		await work;
	} catch (error) {
		expect(error).toBeInstanceOf(CloudTraceMirrorError);
		return error as CloudTraceMirrorError;
	}
	throw new Error("expected rejection");
}

afterEach(() => {
	for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("DurableCloudTraceMirror", () => {
	it("persists events in order before returning an acknowledgement", async () => {
		const path = root();
		const sink = new Sink();
		const mirror = new DurableCloudTraceMirror({ directory: join(path, "local"), sessionId: "sess_test", sink });
		const events = eventsAt(path, 2);
		const ack = await mirror.import(events);
		expect(sink.events).toEqual(events);
		expect(ack).toEqual({ type: "ack", sessionId: "sess_test", cursor: { generation: 1, sequence: 2 } });
		expect(statSync(join(path, "local", "trace-mirror.json")).mode & 0o777).toBe(0o600);
	});

	it("restores its cursor and deduplicates an identical replay", async () => {
		const path = root();
		const sink = new Sink();
		const events = eventsAt(path, 2);
		await new DurableCloudTraceMirror({ directory: join(path, "local"), sessionId: "sess_test", sink }).import(
			events,
		);
		const restored = new DurableCloudTraceMirror({ directory: join(path, "local"), sessionId: "sess_test", sink });
		await restored.import(events);
		expect(sink.events).toHaveLength(2);
		expect(restored.cursor).toEqual({ generation: 1, sequence: 2 });
	});

	it("rejects gaps, tampered ids, and mismatched duplicate payloads", async () => {
		const path = root();
		const sink = new Sink();
		const [first, second] = eventsAt(path, 2);
		if (!first || !second) throw new Error("missing fixture");
		const mirror = new DurableCloudTraceMirror({ directory: join(path, "local"), sessionId: "sess_test", sink });
		expect((await rejected(mirror.import([second]))).code).toBe("sequence-gap");
		await mirror.import([first]);
		const tampered = { ...first, eventId: `${first.eventId}bad` };
		expect((await rejected(mirror.import([tampered]))).code).toBe("duplicate-mismatch");
		const unknown = { ...first, eventId: second.eventId };
		expect((await rejected(mirror.import([unknown]))).code).toBe("duplicate-mismatch");
	});

	it("does not advance durable state when the sink fails", async () => {
		const path = root();
		const sink = new Sink();
		sink.fail = true;
		const mirror = new DurableCloudTraceMirror({ directory: join(path, "local"), sessionId: "sess_test", sink });
		const [first] = eventsAt(path, 1);
		if (!first) throw new Error("missing fixture");
		await expect(mirror.import([first])).rejects.toThrow("disk unavailable");
		expect(mirror.cursor).toBeUndefined();
		sink.fail = false;
		await mirror.import([first]);
		expect(mirror.cursor).toEqual({ generation: 1, sequence: 1 });
	});

	it("accepts a newer generation only from sequence one", async () => {
		const path = root();
		const sink = new Sink();
		const remote = new DurableCloudEventOutbox({ directory: join(path, "remote"), sessionId: "sess_test" });
		const first = remote.append({ kind: "session_status", recordedAt: "a", status: "idle" });
		const mirror = new DurableCloudTraceMirror({ directory: join(path, "local"), sessionId: "sess_test", sink });
		await mirror.import([first]);
		remote.ack({ generation: 1, sequence: 1 });
		remote.trimAcknowledged();
		const next = remote.append({ kind: "session_status", recordedAt: "b", status: "busy" });
		await mirror.import([next]);
		expect(mirror.cursor).toEqual({ generation: 2, sequence: 1 });
	});

	it("bounds retained ids and fails closed on corrupt restart state", async () => {
		const path = root();
		const sink = new Sink();
		const local = join(path, "local");
		const mirror = new DurableCloudTraceMirror({
			directory: local,
			sessionId: "sess_test",
			sink,
			maxRecentEventIds: 2,
		});
		await mirror.import(eventsAt(path, 3));
		const state = JSON.parse(readFileSync(join(local, "trace-mirror.json"), "utf8")) as { recentEventIds: string[] };
		expect(state.recentEventIds).toHaveLength(2);
		writeFileSync(join(local, "trace-mirror.json"), "{}\n");
		expect(() => new DurableCloudTraceMirror({ directory: local, sessionId: "sess_test", sink })).toThrow(
			CloudTraceMirrorError,
		);
	});
});
