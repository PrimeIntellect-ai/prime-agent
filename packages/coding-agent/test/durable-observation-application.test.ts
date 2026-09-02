import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDurableObservationApplication } from "../src/modes/daemon/durable-observation-application.js";
import {
	computeDurableObservationId,
	type DurableObservationAppliedRecord,
	type DurableObservationPendingRecord,
	encodeDurableObservationRecord,
} from "../src/modes/daemon/durable-observation-record-codec.js";
import type { RemoteHostEventFrame, RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { REMOTE_HOST_PROTOCOL_INFO } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";
import { RemoteObservationMirror } from "../src/modes/daemon/remote-observation-mirror.js";
import type { RemoteObservationSnapshotV1 } from "../src/modes/daemon/remote-observation-snapshot.js";

const identity = Object.freeze({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });
type Stored = Readonly<{ sequence: number; bytes: Uint8Array }>;
type BackendOptions = Readonly<{
	failApplied?: boolean;
	malformedTail?: boolean;
	pageCloseError?: boolean;
	nonNativeRecover?: boolean;
}>;

function envelope(sequence: number): RemoteHostFrameEnvelope {
	const frame: RemoteHostEventFrame = Object.freeze({
		type: "event",
		id: `event-${sequence}`,
		sequence,
		cursor: Object.freeze({ ...identity, sequence }),
		emittedAt: `2025-01-01T00:00:0${sequence}.000Z`,
		body: Object.freeze(
			sequence === 1
				? { type: "session_created", sessionId: "sess-1", workspaceId: "workspace-1" }
				: { type: "agent_start" },
		),
	});
	return Object.freeze({
		type: "frame",
		frameId: `frame-${sequence}`,
		protocol: Object.freeze({ ...REMOTE_HOST_PROTOCOL_INFO }),
		sentAt: frame.emittedAt,
		frame,
	});
}

function recordPair(
	sequence: number,
	preSnapshot: RemoteObservationSnapshotV1,
): Readonly<{ pending: DurableObservationPendingRecord; applied: DurableObservationAppliedRecord }> {
	const env = envelope(sequence);
	if (env.frame.type !== "event") throw new Error("event required");
	const digest = canonicalDigest(env);
	if (!digest.ok) throw new Error("digest failed");
	const id = computeDurableObservationId(
		Object.freeze({
			version: 1,
			...identity,
			frameId: env.frameId,
			eventId: env.frame.id,
			eventSequence: env.frame.sequence,
			envelopeDigest: digest.value,
		}),
	);
	if (!id.ok) throw new Error("id failed");
	const pending = Object.freeze({
		version: 1 as const,
		state: "pending" as const,
		...identity,
		observationId: id.value,
		frameId: env.frameId,
		eventId: env.frame.id,
		eventSequence: env.frame.sequence,
		envelopeDigest: digest.value,
		envelope: env,
		preSnapshot,
	});
	const restored = RemoteObservationMirror.fromSnapshot(preSnapshot, identity);
	if (!restored.success || !restored.mirror.ingestEvent(env.frame).accepted) throw new Error("transition failed");
	const captured = restored.mirror.captureSnapshot();
	const postSnapshot = Object.freeze({ ...captured, capturedAt: env.frame.emittedAt });
	return Object.freeze({ pending, applied: Object.freeze({ ...pending, state: "applied" as const, postSnapshot }) });
}

function storeRecord(
	records: Stored[],
	record: DurableObservationPendingRecord | DurableObservationAppliedRecord,
): void {
	const encoded = encodeDurableObservationRecord(record);
	if (!encoded.ok) throw new Error("encode failed");
	records.push(Object.freeze({ sequence: records.length + 1, bytes: encoded.bytes }));
}

function backend(records: Stored[], options: BackendOptions = {}) {
	let closes = 0;
	let pageCloses = 0;
	let reenter: (() => Promise<unknown>) | null = null;
	const recoveryBytes: Uint8Array[] = [];
	const capability = Object.freeze({
		recoverPage: (raw: unknown): unknown => {
			if (options.nonNativeRecover) return Object.create(Promise.prototype) as Promise<unknown>;
			const request = raw as { cursor: number | null; maxCount: number };
			const selected = records
				.filter((entry) => request.cursor === null || entry.sequence > request.cursor)
				.slice(0, request.maxCount);
			const pageEntries = selected.map((entry) => {
				const bytes = new Uint8Array(entry.bytes);
				recoveryBytes.push(bytes);
				return Object.freeze({
					sequence: entry.sequence,
					bytes,
					size: bytes.byteLength,
					sha256: createHash("sha256").update(bytes).digest("hex"),
				});
			});
			if (options.malformedTail) {
				const bytes = new TextEncoder().encode("bad");
				recoveryBytes.push(bytes);
				pageEntries.push(
					Object.freeze({
						sequence: selected.length + 1,
						bytes,
						size: bytes.byteLength,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					}),
				);
			}
			const entries = Object.freeze(pageEntries);
			const owner = Object.freeze({
				close: () => {
					pageCloses += 1;
					return Promise.resolve(Object.freeze({ status: options.pageCloseError ? "error" : "closed" }));
				},
			});
			return Promise.resolve(Object.freeze({ status: "page", entries, nextCursor: null, owner }));
		},
		publishPending: async (raw: unknown) => {
			const request = raw as {
				bytes: Uint8Array;
				observationId: string;
				sha256: string;
				size: number;
				state: "pending";
			};
			if (reenter) await reenter();
			records.push(Object.freeze({ sequence: records.length + 1, bytes: request.bytes }));
			return Object.freeze({
				status: "persisted",
				state: request.state,
				observationId: request.observationId,
				sequence: records.length,
				size: request.size,
				sha256: request.sha256,
			});
		},
		publishApplied: async (raw: unknown) => {
			const request = raw as {
				bytes: Uint8Array;
				observationId: string;
				sha256: string;
				size: number;
				state: "applied";
			};
			if (options.failApplied)
				return Object.freeze({
					status: "error",
					state: request.state,
					observationId: request.observationId,
					sequence: records.length + 1,
					size: request.size,
					sha256: request.sha256,
				});
			records.push(Object.freeze({ sequence: records.length + 1, bytes: request.bytes }));
			return Object.freeze({
				status: "persisted",
				state: request.state,
				observationId: request.observationId,
				sequence: records.length,
				size: request.size,
				sha256: request.sha256,
			});
		},
		close: () => {
			closes += 1;
			return Promise.resolve(Object.freeze({ status: "closed" }));
		},
	});
	return {
		capability,
		closes: () => closes,
		pageCloses: () => pageCloses,
		recoveryBytes,
		setReenter: (fn: () => Promise<unknown>) => {
			reenter = fn;
		},
	};
}

describe("durable observation application", () => {
	it("recovers before exposure and durably applies before swapping the complete view", async () => {
		const records: Stored[] = [];
		const b = backend(records);
		const created = await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(Object.keys(created.application).sort()).toEqual(["apply", "close"]);
		const before = created.view.snapshot();
		expect(before.cursor).toBe(0);
		expect(await created.application.apply(Object.freeze({ envelope: envelope(1) }))).toEqual({ status: "applied" });
		expect(records).toHaveLength(2);
		expect(created.view.snapshot().cursor).toBe(1);
		expect(created.view.snapshot().capturedAt).toBe("2025-01-01T00:00:01.000Z");
	});

	it("serializes concurrent event applications", async () => {
		const records: Stored[] = [];
		const b = backend(records);
		const created = await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }));
		if (!created.ok) throw new Error("create failed");
		expect(
			await Promise.all([
				created.application.apply(Object.freeze({ envelope: envelope(1) })),
				created.application.apply(Object.freeze({ envelope: envelope(2) })),
			]),
		).toEqual([{ status: "applied" }, { status: "applied" }]);
		expect(created.view.snapshot().cursor).toBe(2);
		expect(records).toHaveLength(4);
	});

	it("replays one terminal pending record and publishes applied before exposure", async () => {
		const initial = new RemoteObservationMirror(identity).captureSnapshot();
		const pair = recordPair(1, initial);
		const records: Stored[] = [];
		storeRecord(records, pair.pending);
		const b = backend(records);
		const created = await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }));
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(records).toHaveLength(2);
		expect(created.view.snapshot()).toEqual(pair.applied.postSnapshot);
	});

	it("rejects an applied snapshot that does not match its pending transition", async () => {
		const initial = new RemoteObservationMirror(identity).captureSnapshot();
		const pair = recordPair(1, initial);
		const records: Stored[] = [];
		storeRecord(records, pair.pending);
		storeRecord(records, Object.freeze({ ...pair.applied, postSnapshot: initial }));
		const b = backend(records);
		expect(await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }))).toEqual({
			ok: false,
			error: { code: "RECOVERY_CORRUPT" },
		});
		expect(b.closes()).toBe(1);
	});

	it("keeps the live view unchanged and poisons after applied publication fails", async () => {
		const records: Stored[] = [];
		const b = backend(records, { failApplied: true });
		const created = await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }));
		if (!created.ok) throw new Error("create failed");
		const before = created.view.snapshot();
		expect(await created.application.apply(Object.freeze({ envelope: envelope(1) }))).toEqual({ status: "error" });
		expect(created.view.snapshot()).toBe(before);
		expect(records).toHaveLength(1);
		expect(created.view.status().poisoned).toBe(true);
	});

	it("recovers an exact applied snapshot without recomputing capturedAt", async () => {
		const initial = new RemoteObservationMirror(identity).captureSnapshot();
		const pair = recordPair(1, initial);
		const records: Stored[] = [];
		storeRecord(records, pair.pending);
		storeRecord(records, pair.applied);
		const created = await createDurableObservationApplication(
			Object.freeze({ backend: backend(records).capability, identity }),
		);
		expect(created.ok).toBe(true);
		if (created.ok) expect(created.view.snapshot()).toEqual(pair.applied.postSnapshot);
	});

	it("rejects a reused transport frame id without publishing another pending record", async () => {
		const records: Stored[] = [];
		const created = await createDurableObservationApplication(
			Object.freeze({ backend: backend(records).capability, identity }),
		);
		if (!created.ok) throw new Error("create failed");
		expect((await created.application.apply(Object.freeze({ envelope: envelope(1) }))).status).toBe("applied");
		const second = Object.freeze({ ...envelope(2), frameId: "frame-1" });
		expect(await created.application.apply(Object.freeze({ envelope: second }))).toEqual({ status: "error" });
		expect(records).toHaveLength(2);
	});

	it("rejects a malformed page tail atomically, erases every acquired byte, and closes owners", async () => {
		const initial = new RemoteObservationMirror(identity).captureSnapshot();
		const records: Stored[] = [];
		storeRecord(records, recordPair(1, initial).pending);
		const b = backend(records, { malformedTail: true });
		expect(await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }))).toEqual({
			ok: false,
			error: { code: "RECOVERY_CORRUPT" },
		});
		expect(b.recoveryBytes.every((bytes) => [...bytes].every((value) => value === 0))).toBe(true);
		expect(b.pageCloses()).toBe(1);
		expect(b.closes()).toBe(1);
	});

	it("lets page close uncertainty fail recovery", async () => {
		const b = backend([], { pageCloseError: true });
		expect(await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }))).toEqual({
			ok: false,
			error: { code: "RECOVERY_UNCERTAIN" },
		});
		expect(b.pageCloses()).toBe(1);
		expect(b.closes()).toBe(1);
	});

	it("rejects a hostile non-native recovery promise and closes the backend", async () => {
		const b = backend([], { nonNativeRecover: true });
		expect(await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }))).toEqual({
			ok: false,
			error: { code: "RECOVERY_UNCERTAIN" },
		});
		expect(b.closes()).toBe(1);
	});

	it("poisons reentrant application calls without deadlocking", async () => {
		const records: Stored[] = [];
		const b = backend(records);
		const created = await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }));
		if (!created.ok) throw new Error("create failed");
		let nested: unknown;
		b.setReenter(async () => {
			nested = await created.application.apply(Object.freeze({ envelope: envelope(1) }));
		});
		expect(await created.application.apply(Object.freeze({ envelope: envelope(1) }))).toEqual({ status: "error" });
		expect(nested).toEqual({ status: "error" });
		expect(records).toHaveLength(1);
		expect(created.view.snapshot().cursor).toBe(0);
	});

	it("waits for an in-flight apply before closing its backend", async () => {
		const records: Stored[] = [];
		const b = backend(records);
		let release!: () => void;
		let reached!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const entered = new Promise<void>((resolve) => {
			reached = resolve;
		});
		const capability = Object.freeze({
			recoverPage: b.capability.recoverPage,
			publishPending: async (raw: unknown) => {
				reached();
				await gate;
				return await b.capability.publishPending(raw);
			},
			publishApplied: b.capability.publishApplied,
			close: b.capability.close,
		});
		const created = await createDurableObservationApplication(Object.freeze({ backend: capability, identity }));
		if (!created.ok) throw new Error("create failed");
		const applying = created.application.apply(Object.freeze({ envelope: envelope(1) }));
		await entered;
		const closing = created.application.close();
		expect(b.closes()).toBe(0);
		release();
		expect(await applying).toEqual({ status: "applied" });
		expect(await closing).toEqual({ status: "closed" });
		expect(b.closes()).toBe(1);
	});

	it("returns one shared close promise and closes the backend once", async () => {
		const b = backend([]);
		const created = await createDurableObservationApplication(Object.freeze({ backend: b.capability, identity }));
		if (!created.ok) throw new Error("create failed");
		const first = created.application.close();
		const second = created.application.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ status: "closed" });
		expect(b.closes()).toBe(1);
	});
});
