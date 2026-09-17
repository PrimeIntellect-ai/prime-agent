import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
	encodePrivateFrame,
	type PrivateFrame,
	PrivateFrameDecoder,
	PrivateFramedChannel,
	type PrivateFrameHeaderValidator,
} from "../src/modes/session-worker/private-framing.js";

interface TestHeader {
	type: string;
	requestId?: string;
}

const isTestHeader: PrivateFrameHeaderValidator<TestHeader> = (value: unknown): value is TestHeader => {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as { type?: unknown; requestId?: unknown };
	return (
		typeof candidate.type === "string" &&
		(candidate.requestId === undefined || typeof candidate.requestId === "string")
	);
};

describe("private worker framing", () => {
	it("decodes headers and opaque payloads across arbitrary chunk boundaries", () => {
		const frames = [
			encodePrivateFrame({ type: "event", requestId: "one" }, Buffer.from([0, 1, 2, 255])),
			encodePrivateFrame({ type: "response", requestId: "two" }, Buffer.from("payload")),
			encodePrivateFrame({ type: "event" }, Buffer.alloc(0)),
		];
		const expected = [
			{ header: { type: "event", requestId: "one" }, payload: Buffer.from([0, 1, 2, 255]) },
			{ header: { type: "response", requestId: "two" }, payload: Buffer.from("payload") },
			{ header: { type: "event" }, payload: Buffer.alloc(0) },
		];
		// One byte at a time and three-byte chunks both cover splits at every boundary.
		const combined = Buffer.concat(frames);
		for (const chunkSize of [3, 1]) {
			const decoder = new PrivateFrameDecoder(isTestHeader);
			const decoded: PrivateFrame<TestHeader>[] = [];
			for (let offset = 0; offset < combined.length; offset += chunkSize) {
				decoded.push(...decoder.push(combined.subarray(offset, Math.min(offset + chunkSize, combined.length))));
			}
			decoder.finish();
			expect(decoded).toEqual(expected);
		}
	});

	it("rejects invalid lengths, JSON, and routing headers", () => {
		const oversized = Buffer.alloc(8);
		oversized.writeUInt32BE(1025, 0);
		expect(() =>
			new PrivateFrameDecoder(isTestHeader, { maxHeaderBytes: 1024, maxPayloadBytes: 1024 }).push(oversized),
		).toThrow("Invalid private frame header length");

		const invalidJson = Buffer.concat([Buffer.from([0, 0, 0, 1, 0, 0, 0, 0]), Buffer.from("{")]);
		expect(() => new PrivateFrameDecoder(isTestHeader).push(invalidJson)).toThrow(
			"Invalid private frame header JSON",
		);

		const invalidHeader = encodePrivateFrame({ missing: "type" }, Buffer.alloc(0));
		expect(() => new PrivateFrameDecoder(isTestHeader).push(invalidHeader)).toThrow(
			"Invalid private frame routing header",
		);
	});

	it("reports an incomplete trailing frame", () => {
		const decoder = new PrivateFrameDecoder(isTestHeader);
		decoder.push(encodePrivateFrame({ type: "event" }, Buffer.from("body")).subarray(0, 9));
		expect(() => decoder.finish()).toThrow("incomplete bytes");
	});

	it("tracks unread bytes while frames span chunk boundaries", () => {
		const frame = encodePrivateFrame({ type: "event" }, Buffer.from("a".repeat(100)));
		const decoder = new PrivateFrameDecoder(isTestHeader);
		expect(decoder.bufferedBytes).toBe(0);
		decoder.push(frame.subarray(0, 20));
		expect(decoder.bufferedBytes).toBe(20);
		decoder.push(frame.subarray(20, 50));
		expect(decoder.bufferedBytes).toBe(50);
		// A complete frame is decoded in one push; nothing stays buffered.
		const decoded = decoder.push(frame.subarray(50));
		expect(decoded).toEqual([{ header: { type: "event" }, payload: Buffer.from("a".repeat(100)) }]);
		expect(decoder.bufferedBytes).toBe(0);
		decoder.finish();
	});

	it("decodes large frames delivered in small chunks within per-size budgets", () => {
		// A decoder that re-copies its whole pending buffer per socket read is quadratic
		// in the chunk count; both vectors finish far under budget on the linear path.
		for (const [payloadBytes, chunkBytes, budgetMs] of [
			[8 * 1024 * 1024, 4096, 2000],
			[64 * 1024 * 1024, 256, 2500],
		] as const) {
			const frame = encodePrivateFrame({ type: "event", requestId: "large" }, Buffer.alloc(payloadBytes, 7));
			const decoder = new PrivateFrameDecoder(isTestHeader);

			const started = performance.now();
			const decoded: PrivateFrame<TestHeader>[] = [];
			for (let offset = 0; offset < frame.length; offset += chunkBytes) {
				decoded.push(...decoder.push(frame.subarray(offset, Math.min(offset + chunkBytes, frame.length))));
			}
			const elapsed = performance.now() - started;

			expect(decoded).toHaveLength(1);
			expect(decoded[0]?.header).toEqual({ type: "event", requestId: "large" });
			const payload = decoded[0]?.payload;
			expect(payload?.length).toBe(payloadBytes);
			expect(payload?.[0]).toBe(7);
			expect(payload?.[payloadBytes - 1]).toBe(7);
			expect(elapsed).toBeLessThan(budgetMs);
			decoder.finish();
		}
	});

	it("consumes a frame split across many chunks without calling Array.prototype.shift", () => {
		// The head cursor must skip spent chunks instead of shifting each one off
		// the front, which is quadratic in the chunk count.
		const frame = encodePrivateFrame({ type: "event", requestId: "large" }, Buffer.alloc(8 * 1024 * 1024, 3));
		const decoder = new PrivateFrameDecoder(isTestHeader);
		const decoded: PrivateFrame<TestHeader>[] = [];

		const originalShift = Array.prototype.shift;
		let shiftCalls = 0;
		Array.prototype.shift = function (this: unknown[]): unknown {
			shiftCalls += 1;
			return originalShift.apply(this);
		};
		try {
			for (let offset = 0; offset < frame.length; offset += 1024) {
				decoded.push(...decoder.push(frame.subarray(offset, Math.min(offset + 1024, frame.length))));
			}
		} finally {
			Array.prototype.shift = originalShift;
		}

		expect(shiftCalls).toBe(0);
		expect(decoded).toHaveLength(1);
		expect(decoded[0]?.header).toEqual({ type: "event", requestId: "large" });
		expect(decoded[0]?.payload.length).toBe(8 * 1024 * 1024);
		decoder.finish();
	});

	it("sends frames through a duplex channel without interpreting payload bytes", async () => {
		const stream = new PassThrough();
		const channel = new PrivateFramedChannel(stream, isTestHeader);
		const received = new Promise<{ header: TestHeader; payload: Buffer }>((resolve) => {
			channel.onFrame(resolve);
		});

		await channel.send({ type: "snapshot", requestId: "request" }, Buffer.from([9, 8, 7]));

		await expect(received).resolves.toEqual({
			header: { type: "snapshot", requestId: "request" },
			payload: Buffer.from([9, 8, 7]),
		});
		channel.close();
	});
});
