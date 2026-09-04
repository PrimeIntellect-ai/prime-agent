import { describe, expect, it } from "vitest";
import { truncateTail } from "../src/core/tools/truncate.js";

describe("truncateTail", () => {
	it("rescues the tail of an oversized line even when the output ends with a newline", () => {
		const result = truncateTail(`${"x".repeat(50_000)}\n`, { maxLines: 100, maxBytes: 1000 });

		expect(result.truncatedBy).toBe("bytes");
		expect(result.content).toBe("x".repeat(1000));
	});
});
