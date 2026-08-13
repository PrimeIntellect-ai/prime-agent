import { describe, expect, it } from "vitest";
import { formatTokenCount } from "../src/cli/list-models.js";

describe("formatTokenCount", () => {
	it("renders the unbounded-output sentinel", () => {
		expect(formatTokenCount(0)).toBe("unbounded");
		expect(formatTokenCount(-1)).toBe("unbounded");
	});

	it("still formats published token limits", () => {
		expect(formatTokenCount(500_000)).toBe("500K");
		expect(formatTokenCount(1_000_000)).toBe("1M");
	});
});
