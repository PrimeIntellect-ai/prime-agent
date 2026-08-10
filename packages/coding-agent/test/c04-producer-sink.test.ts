import { describe, expect, it } from "vitest";
import { C04ProducerSink } from "../src/core/agent-session.js";

describe("C04 producer sink", () => {
	it("starts consumption before terminal generation, bounds buffering, and closes an overflow once", async () => {
		const sink = new C04ProducerSink();
		const iterator = sink[Symbol.asyncIterator]();
		const waiting = iterator.next();
		sink.push("first");
		expect(new TextDecoder().decode((await waiting).value)).toBe("first");
		sink.push("x".repeat(128 * 1024 + 1));
		sink.push("ignored-after-overflow");
		await expect(iterator.next()).rejects.toThrow("bounded buffer");
		await expect(iterator.next()).resolves.toMatchObject({ done: true });
	});

	it("chunks at 64KiB and does not duplicate terminal bytes after close", async () => {
		const sink = new C04ProducerSink();
		sink.push("x".repeat(96 * 1024));
		sink.close();
		sink.push("late");
		const chunks: Uint8Array[] = [];
		for await (const chunk of sink) chunks.push(chunk);
		expect(chunks.map((chunk) => chunk.length)).toEqual([64 * 1024, 32 * 1024]);
		expect(Buffer.concat(chunks).byteLength).toBe(96 * 1024);
	});
});
