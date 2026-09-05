import assert from "node:assert";
import { describe, it } from "node:test";
import {
	extractTableCellSelectionRegions,
	markTableCell,
	markTableEnd,
	markTableStart,
} from "../src/selection-metadata.js";

describe("selection metadata", () => {
	it("marks cells containing lone surrogates without throwing", () => {
		// The lone surrogate is replaced with U+FFFD, not crashed on.
		const line = markTableEnd(markTableStart("") + markTableCell("cell text", 0, 0, 0, "broken \uD800 surrogate"));
		const { regions } = extractTableCellSelectionRegions([line], () => ({}));
		assert.equal(regions[0]?.content, "broken \uFFFD surrogate");
	});
});
