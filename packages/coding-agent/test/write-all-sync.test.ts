import { describe, expect, it, vi } from "vitest";
import { type SyncBufferWriter, writeAllSync } from "../src/utils/write-all-sync.js";

describe("writeAllSync", () => {
	it("continues after short writes until every byte is accepted", () => {
		const data = Buffer.from("관측-data", "utf8");
		const output = Buffer.alloc(data.byteLength);
		const writtenChunks: number[] = [];
		const writer: SyncBufferWriter = (_descriptor, buffer, offset, length, position) => {
			expect(position).toBeNull();
			const written = Math.min(3, length);
			output.set(buffer.subarray(offset, offset + written), offset);
			writtenChunks.push(written);
			return written;
		};

		writeAllSync(17, data, writer);

		expect(output).toEqual(data);
		expect(writtenChunks.length).toBeGreaterThan(1);
		expect(writtenChunks.reduce((total, written) => total + written, 0)).toBe(data.byteLength);
	});

	it("does not invoke the writer for an empty buffer", () => {
		const writer = vi.fn<SyncBufferWriter>();

		writeAllSync(17, Buffer.alloc(0), writer);

		expect(writer).not.toHaveBeenCalled();
	});

	it("rejects a writer that makes no progress", () => {
		const writer: SyncBufferWriter = () => 0;

		expect(() => writeAllSync(17, Buffer.from("abc"), writer)).toThrow(/invalid byte count 0/);
	});

	it("rejects a writer that reports more bytes than remain", () => {
		const writer: SyncBufferWriter = (_descriptor, _buffer, _offset, length) => length + 1;

		expect(() => writeAllSync(17, Buffer.from("abc"), writer)).toThrow(/invalid byte count 4/);
	});

	it("propagates a write error after preserving the next byte offset", () => {
		const offsets: number[] = [];
		const writer: SyncBufferWriter = (_descriptor, _buffer, offset) => {
			offsets.push(offset);
			if (offset === 0) return 2;
			throw new Error("disk full");
		};

		expect(() => writeAllSync(17, Buffer.from("abcd"), writer)).toThrow("disk full");
		expect(offsets).toEqual([0, 2]);
	});
});
