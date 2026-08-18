import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
	createReadStream: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		createReadStream: fsMocks.createReadStream,
	};
});

const { readLinesAsBuffers } = await import("../src/utils/file-lines.js");

afterEach(() => {
	fsMocks.createReadStream.mockReset();
	vi.restoreAllMocks();
});

describe("readLinesAsBuffers", () => {
	it("releases pending chunks before yielding a newline-terminated multi-chunk record", async () => {
		const chunkSize = 64 * 1024;
		const firstPart = Buffer.alloc(chunkSize, 0x61);
		const secondPart = Buffer.concat([Buffer.alloc(chunkSize, 0x62), Buffer.from("\ntail\n")]);
		fsMocks.createReadStream.mockReturnValue(Readable.from([firstPart, secondPart]));
		const concatSpy = vi.spyOn(Buffer, "concat");

		const lines = readLinesAsBuffers("/unused");
		const first = await lines.next();

		expect(first.done).toBe(false);
		expect(first.value?.toString("utf8")).toBe("a".repeat(chunkSize) + "b".repeat(chunkSize));
		expect(concatSpy).toHaveBeenCalledOnce();
		expect(concatSpy.mock.calls[0]?.[0]).toHaveLength(0);

		const second = await lines.next();
		expect(second.done).toBe(false);
		expect(second.value?.toString("utf8")).toBe("tail");
		expect((await lines.next()).done).toBe(true);
	});

	it("releases pending chunks before yielding an EOF-terminated multi-chunk record", async () => {
		const chunkSize = 64 * 1024;
		const firstPart = Buffer.alloc(chunkSize, 0x61);
		const secondPart = Buffer.alloc(chunkSize, 0x62);
		fsMocks.createReadStream.mockReturnValue(Readable.from([firstPart, secondPart]));
		const concatSpy = vi.spyOn(Buffer, "concat");

		const lines = readLinesAsBuffers("/unused");
		const line = await lines.next();

		expect(line.done).toBe(false);
		expect(line.value?.toString("utf8")).toBe("a".repeat(chunkSize) + "b".repeat(chunkSize));
		expect(concatSpy).toHaveBeenCalledOnce();
		expect(concatSpy.mock.calls[0]?.[0]).toHaveLength(0);
		expect((await lines.next()).done).toBe(true);
	});
});
