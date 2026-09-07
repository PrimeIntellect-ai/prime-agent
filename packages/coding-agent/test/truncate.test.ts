import { describe, expect, it } from "vitest";
import { truncateTail } from "../src/core/tools/truncate.js";

describe("truncateTail", () => {
	it("rescues the tail of an oversized line even when the output ends with a newline", () => {
		const result = truncateTail(`${"x".repeat(50_000)}\n`, { maxLines: 100, maxBytes: 1000 });

		expect(result.truncatedBy).toBe("bytes");
		// The trailing blank line survives, so line metadata describes the real file.
		expect(result.content).toBe(`${"x".repeat(999)}\n`);
		expect(result.outputLines).toBe(2);
		expect(result.lastLinePartial).toBe(true);
	});

	it("never returns more than maxBytes, whatever the trailing blank shape", () => {
		const fixtures = [
			"xxxx\n\n",
			"xxxx\n",
			`${"x".repeat(50)}\n\n\n\n`,
			"\n\n\n",
			"x\n\nx\n\n\n",
			`${"é".repeat(40)}\n\n`,
		];
		for (const content of fixtures) {
			for (const maxBytes of [1, 2, 3, 5, 8]) {
				const result = truncateTail(content, { maxLines: 100, maxBytes });
				expect(
					Buffer.byteLength(result.content, "utf-8"),
					`${JSON.stringify(content)} @ ${maxBytes}`,
				).toBeLessThanOrEqual(maxBytes);
			}
		}
	});
});
