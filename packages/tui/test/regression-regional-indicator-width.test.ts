import assert from "node:assert";
import { describe, it } from "node:test";
import { visibleWidth, wrapTextWithAnsi } from "../src/utils.js";

describe("regional indicator width regression", () => {
	it("treats partial flag grapheme as full-width to avoid streaming render drift", () => {
		const partialFlag = "🇨";
		const listLine = "      - 🇨";

		assert.strictEqual(visibleWidth(partialFlag), 2);
		assert.strictEqual(visibleWidth(listLine), 10);
	});

	it("wraps intermediate partial-flag list line before overflow", () => {
		const wrapped = wrapTextWithAnsi("      - 🇨", 9);

		assert.strictEqual(wrapped.length, 2);
		assert.strictEqual(visibleWidth(wrapped[0] || ""), 7);
		assert.strictEqual(visibleWidth(wrapped[1] || ""), 2);
	});

	it("treats all regional-indicator singleton graphemes as width 2", () => {
		for (let cp = 0x1f1e6; cp <= 0x1f1ff; cp++) {
			const regionalIndicator = String.fromCodePoint(cp);
			assert.strictEqual(
				visibleWidth(regionalIndicator),
				2,
				`Expected ${regionalIndicator} (U+${cp.toString(16).toUpperCase()}) to be width 2`,
			);
		}
	});

	it("keeps full flag pairs at width 2", () => {
		const samples = ["🇯🇵", "🇺🇸", "🇬🇧", "🇨🇳", "🇩🇪", "🇫🇷"];
		for (const flag of samples) {
			assert.strictEqual(visibleWidth(flag), 2, `Expected ${flag} to be width 2`);
		}
	});

	it("keeps common streaming emoji intermediates at stable width", () => {
		const samples = ["👍", "👍🏻", "✅", "⚡", "⚡️", "👨", "👨‍💻", "🏳️‍🌈"];
		for (const sample of samples) {
			assert.strictEqual(visibleWidth(sample), 2, `Expected ${sample} to be width 2`);
		}
	});
});
