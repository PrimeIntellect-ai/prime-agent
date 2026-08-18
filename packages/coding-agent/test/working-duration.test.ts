import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

type WorkingDurationFormatter = {
	formatWorkingElapsed(elapsedMs: number): string;
};

const formatWorkingElapsed = (InteractiveMode.prototype as unknown as WorkingDurationFormatter).formatWorkingElapsed;

describe("working duration", () => {
	test.each([
		[59_999, "59s"],
		[60_000, "1m 00s"],
		[3_599_999, "59m 59s"],
		[3_600_000, "1h 00m 00s"],
		[86_399_999, "23h 59m 59s"],
		[86_400_000, "1d 00h 00m 00s"],
		[(1_543 * 60 + 49) * 1_000, "1d 01h 43m 49s"],
	])("formats %dms as %s", (elapsedMs, expected) => {
		expect(formatWorkingElapsed(elapsedMs)).toBe(expected);
	});
});
