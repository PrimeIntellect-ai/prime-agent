import { describe, expect, it } from "vitest";
import { truncateTail } from "../src/core/tools/truncate.js";

describe("truncateTail", () => {
	it("never returns more than maxBytes, whatever the trailing blank shape", () => {
		const fixtures = [
			"xxxx\n\n",
			"xxxx\n",
			`${"x".repeat(50)}\n\n\n\n`,
			"\n\n\n",
			"x\n\nx\n\n\n",
			`${"é".repeat(40)}\n\n`,
			`${"x".repeat(50_000)}\n`,
		];
		for (const content of fixtures) {
			for (const maxBytes of [1, 2, 3, 5, 8, 1000]) {
				const result = truncateTail(content, { maxLines: 100, maxBytes });
				expect(
					Buffer.byteLength(result.content, "utf-8"),
					`${JSON.stringify(content)} @ ${maxBytes}`,
				).toBeLessThanOrEqual(maxBytes);
			}
		}
	});
});
