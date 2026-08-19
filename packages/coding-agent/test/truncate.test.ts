import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_BYTES, truncateTail } from "../src/core/tools/truncate.js";

const LONG_LINE = "A".repeat(2 * DEFAULT_MAX_BYTES);

describe("truncateTail", () => {
	it("keeps the tail of an oversized single line without a trailing newline", () => {
		const result = truncateTail(LONG_LINE);

		expect(result.content.length).toBeGreaterThan(0);
		expect(result.lastLinePartial).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("keeps the tail of an oversized last line when the output ends with a newline", () => {
		const result = truncateTail(`${LONG_LINE}\n`);

		// A trailing newline splits into an empty final element. That element must not
		// suppress the partial-line fallback, or the caller gets no output at all.
		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content.startsWith("A")).toBe(true);
		expect(result.lastLinePartial).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("keeps the tail when short lines precede an oversized last line", () => {
		const result = truncateTail(`short1\nshort2\n${LONG_LINE}\n`);

		expect(result.content.length).toBeGreaterThan(0);
		expect(result.content.startsWith("A")).toBe(true);
		expect(result.lastLinePartial).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("does not truncate content that fits both limits", () => {
		const result = truncateTail("line1\nline2\n");

		expect(result.truncated).toBe(false);
		expect(result.content).toBe("line1\nline2\n");
		expect(result.lastLinePartial).toBe(false);
	});

	it("still prefers whole trailing lines when they fit the byte budget", () => {
		const filler = "x".repeat(1024);
		const content = `${Array.from({ length: 200 }, () => filler).join("\n")}\ntail-line\n`;

		const result = truncateTail(content);

		expect(result.lastLinePartial).toBe(false);
		expect(result.content.endsWith("tail-line\n")).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
	});

	it("respects a maxBytes budget that is smaller than the last line", () => {
		const result = truncateTail(`${"B".repeat(500)}\n`, { maxBytes: 100 });

		expect(result.content.length).toBeGreaterThan(0);
		expect(result.lastLinePartial).toBe(true);
		expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(100);
	});
});
