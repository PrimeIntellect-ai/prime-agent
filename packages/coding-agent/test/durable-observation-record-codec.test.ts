import { describe, expect, it } from "vitest";
import {
	computeDurableObservationId,
	type DurableObservationRecord,
	decodeDurableObservationRecord,
	encodeDurableObservationRecord,
} from "../src/modes/daemon/durable-observation-record-codec.js";
import type { RemoteHostEventFrame, RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { REMOTE_HOST_PROTOCOL_INFO } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";
import { RemoteObservationMirror } from "../src/modes/daemon/remote-observation-mirror.js";

const identity = Object.freeze({ hostId: "host-1", generation: "gen-1", sessionId: "sess-1" });

function fixture(state: "pending" | "applied" = "applied"): DurableObservationRecord {
	const mirror = new RemoteObservationMirror(identity);
	const preSnapshot = mirror.captureSnapshot();
	const frame: RemoteHostEventFrame = Object.freeze({
		type: "event",
		id: "event-1",
		sequence: 1,
		cursor: Object.freeze({ ...identity, sequence: 1 }),
		emittedAt: "2025-01-01T00:00:00.000Z",
		body: Object.freeze({ type: "session_created", sessionId: "sess-1", workspaceId: "workspace-1" }),
	});
	const envelope: RemoteHostFrameEnvelope = Object.freeze({
		type: "frame",
		frameId: "transport-1",
		protocol: Object.freeze({ ...REMOTE_HOST_PROTOCOL_INFO }),
		sentAt: "2025-01-01T00:00:00.000Z",
		frame,
	});
	const digest = canonicalDigest(envelope);
	if (!digest.ok) throw new Error("digest failed");
	const observationId = computeDurableObservationId(
		Object.freeze({
			version: 1,
			...identity,
			frameId: envelope.frameId,
			eventId: frame.id,
			eventSequence: frame.sequence,
			envelopeDigest: digest.value,
		}),
	);
	if (!observationId.ok) throw new Error("observation id failed");
	const base = Object.freeze({
		version: 1 as const,
		...identity,
		observationId: observationId.value,
		frameId: envelope.frameId,
		eventId: frame.id,
		eventSequence: frame.sequence,
		envelopeDigest: digest.value,
		envelope,
		preSnapshot,
	});
	if (state === "pending") return Object.freeze({ ...base, state });
	const applied = mirror.ingestEvent(frame);
	if (!applied.accepted) throw new Error("event failed");
	return Object.freeze({ ...base, state, postSnapshot: mirror.captureSnapshot() });
}

describe("durable observation record codec", () => {
	it.each(["pending", "applied"] as const)("roundtrips one canonical %s record and consumes input bytes", (state) => {
		const encoded = encodeDurableObservationRecord(fixture(state));
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		const transferred = encoded.bytes;
		const before = new Uint8Array(transferred);
		const decoded = decodeDurableObservationRecord(transferred, identity);
		expect(decoded.ok).toBe(true);
		expect([...transferred].every((value) => value === 0)).toBe(true);
		expect([...before].some((value) => value !== 0)).toBe(true);
		if (decoded.ok) {
			expect(decoded.value.frameId).toBe("transport-1");
			expect(decoded.value.eventId).toBe("event-1");
			expect(decoded.value.eventSequence).toBe(1);
		}
	});

	it("rejects and consumes noncanonical JSON", () => {
		const encoded = encodeDurableObservationRecord(fixture());
		if (!encoded.ok) throw new Error("encode failed");
		const text = new TextDecoder().decode(encoded.bytes);
		const bytes = new TextEncoder().encode(`${text} `);
		expect(decodeDurableObservationRecord(bytes, identity)).toEqual({ ok: false, error: { code: "NON_CANONICAL" } });
		expect([...bytes].every((value) => value === 0)).toBe(true);
	});

	it("binds transport frame, semantic event, sequence, envelope digest, and identity independently", () => {
		for (const patch of [
			{ frameId: "other-frame" },
			{ eventId: "other-event" },
			{ eventSequence: 2 },
			{ envelopeDigest: "0".repeat(64) },
			{ hostId: "other-host" },
		]) {
			const encoded = encodeDurableObservationRecord(Object.freeze({ ...fixture(), ...patch }));
			expect(encoded.ok).toBe(false);
		}
	});

	it("rejects an event cursor identity that diverges from the durable record", () => {
		const original = fixture("pending");
		const event = original.envelope.frame;
		if (event.type !== "event") throw new Error("expected event");
		const envelope = Object.freeze({
			...original.envelope,
			frame: Object.freeze({ ...event, cursor: Object.freeze({ ...event.cursor, hostId: "other-host" }) }),
		});
		const digest = canonicalDigest(envelope);
		if (!digest.ok) throw new Error("digest failed");
		const observationId = computeDurableObservationId(
			Object.freeze({
				version: 1,
				...identity,
				frameId: envelope.frameId,
				eventId: event.id,
				eventSequence: event.sequence,
				envelopeDigest: digest.value,
			}),
		);
		if (!observationId.ok) throw new Error("id failed");
		const record = Object.freeze({
			...original,
			envelope,
			envelopeDigest: digest.value,
			observationId: observationId.value,
		});
		expect(encodeDurableObservationRecord(record)).toEqual({ ok: false, error: { code: "ENVELOPE_INVALID" } });
	});

	it("rejects a valid record under a different expected identity and still erases it", () => {
		const encoded = encodeDurableObservationRecord(fixture());
		if (!encoded.ok) throw new Error("encode failed");
		expect(
			decodeDurableObservationRecord(encoded.bytes, Object.freeze({ ...identity, generation: "gen-2" })),
		).toEqual({ ok: false, error: { code: "IDENTITY_MISMATCH" } });
		expect([...encoded.bytes].every((value) => value === 0)).toBe(true);
	});

	it("rejects Buffer, subview, SharedArrayBuffer, and proxy bytes without taking ownership", () => {
		const buffer = Buffer.from("{}", "utf8");
		const backing = new Uint8Array([1, 2, 3]);
		const subview = backing.subarray(1);
		const shared = new Uint8Array(new SharedArrayBuffer(2));
		const proxy = new Proxy(new Uint8Array([1, 2]), {});
		for (const value of [buffer, subview, shared, proxy]) {
			expect(decodeDurableObservationRecord(value, identity)).toEqual({
				ok: false,
				error: { code: "BYTES_INVALID" },
			});
		}
		expect([...backing]).toEqual([1, 2, 3]);
		expect(buffer.toString("utf8")).toBe("{}");
	});

	it("rejects aliases and hostile record descriptors without invoking them", () => {
		let reads = 0;
		const hostile = Object.defineProperty({}, "state", {
			enumerable: true,
			get() {
				reads += 1;
				return "pending";
			},
		});
		expect(encodeDurableObservationRecord(hostile).ok).toBe(false);
		expect(reads).toBe(0);
		const proxy = new Proxy(fixture(), {});
		expect(encodeDurableObservationRecord(proxy).ok).toBe(false);
	});
});
