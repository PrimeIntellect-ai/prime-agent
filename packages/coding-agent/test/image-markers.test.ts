import { describe, expect, test } from "vitest";

import { collectMarkedImages, evictImagesToBudget } from "../src/modes/interactive/image-markers.js";

describe("image markers", () => {
	test("collectMarkedImages resolves only markers still present, in paste order", () => {
		const pending = new Map([
			[1, "first"],
			[2, "second"],
		]);
		expect(collectMarkedImages(pending, "[image #2] then [image #1]")).toEqual(["first", "second"]);
		expect(collectMarkedImages(pending, "kept [image #1] only")).toEqual(["first"]);
		expect(collectMarkedImages(pending, "[image #1] [image #1]")).toEqual(["first"]);
	});

	test("a restored marker still resolves its image (undo-safe)", () => {
		const pending = new Map([[1, "a"]]);
		expect(collectMarkedImages(pending, "no marker")).toEqual([]);
		expect(collectMarkedImages(pending, "back [image #1]")).toEqual(["a"]);
	});

	const size = (s: string) => s.length;

	test.each([
		{ name: "drops oldest entries until within budget", budget: 8, kept: [] as number[], expected: [2, 3] },
		{ name: "never evicts kept ids, even past budget", budget: 8, kept: [1], expected: [1, 3] },
		{ name: "keeps everything when all ids are kept", budget: 1, kept: [1, 2, 3], expected: [1, 2, 3] },
		{ name: "is a no-op within budget", budget: 100, kept: [], expected: [1, 2, 3] },
	])("evictImagesToBudget $name", ({ budget, kept, expected }) => {
		const images = new Map([
			[1, "aaaa"],
			[2, "bbbb"],
			[3, "cccc"],
		]);
		evictImagesToBudget(images, size, budget, new Set(kept));
		expect([...images.keys()]).toEqual(expected);
	});
});
