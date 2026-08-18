import { describe, expect, test } from "vitest";

import {
	collectMarkedImages,
	evictImagesToBudget,
	formatImageMarker,
	imageMarkerIds,
	remapImageMarkers,
} from "../src/modes/interactive/image-markers.js";

describe("image markers", () => {
	test("formatImageMarker round-trips through imageMarkerIds", () => {
		expect(formatImageMarker(7)).toBe("[image #7]");
		expect(imageMarkerIds(`see ${formatImageMarker(7)}`)).toEqual([7]);
	});

	test("imageMarkerIds returns ids in order of appearance", () => {
		expect(imageMarkerIds("a [image #2] b [image #1] c")).toEqual([2, 1]);
		expect(imageMarkerIds("no markers here")).toEqual([]);
	});

	test("imageMarkerIds ignores ids outside the safe integer range", () => {
		expect(imageMarkerIds("[image #7] [image #9007199254740992]")).toEqual([7]);
	});

	test("remapImageMarkers replaces every spelling of the numeric id", () => {
		expect(remapImageMarkers("[image #1] [image #01] [image #2]", new Map([[1, 7]]))).toBe(
			"[image #7] [image #7] [image #2]",
		);
	});

	test("collectMarkedImages returns images in paste order, not text order", () => {
		const pending = new Map([
			[1, "first"],
			[2, "second"],
		]);
		// Markers appear reversed in the text, but paste order is preserved.
		expect(collectMarkedImages(pending, "[image #2] then [image #1]")).toEqual(["first", "second"]);
	});

	test("collectMarkedImages skips images whose marker was deleted", () => {
		const pending = new Map([
			[1, "a"],
			[2, "b"],
		]);
		expect(collectMarkedImages(pending, "kept [image #1] only")).toEqual(["a"]);
	});

	test("collectMarkedImages returns each image at most once for duplicate markers", () => {
		const pending = new Map([[1, "a"]]);
		expect(collectMarkedImages(pending, "[image #1] [image #1]")).toEqual(["a"]);
	});

	test("collectMarkedImages returns nothing for empty input", () => {
		expect(collectMarkedImages(new Map(), "[image #1]")).toEqual([]);
		expect(collectMarkedImages(new Map([[1, "a"]]), "")).toEqual([]);
	});

	test("a restored marker still resolves its image (undo-safe)", () => {
		const pending = new Map([[1, "a"]]);
		// Marker deleted then brought back (e.g. via editor undo). Because images are
		// never pruned mid-edit, the restored marker still resolves at submit time.
		expect(collectMarkedImages(pending, "no marker")).toEqual([]);
		expect(collectMarkedImages(pending, "back [image #1]")).toEqual(["a"]);
	});

	const size = (s: string) => s.length;

	test("evictImagesToBudget drops oldest entries until within budget", () => {
		const images = new Map([
			[1, "aaaa"],
			[2, "bbbb"],
			[3, "cccc"],
		]);
		evictImagesToBudget(images, size, 8, new Set());
		// Oldest (1) evicted; 2 and 3 (8 bytes) fit.
		expect([...images.keys()]).toEqual([2, 3]);
	});

	test("evictImagesToBudget never evicts kept ids, even past budget", () => {
		const images = new Map([
			[1, "aaaa"],
			[2, "bbbb"],
			[3, "cccc"],
		]);
		// id 1 is live (kept) so it survives; 2 is evicted to get under budget.
		evictImagesToBudget(images, size, 8, new Set([1]));
		expect([...images.keys()]).toEqual([1, 3]);
	});

	test("evictImagesToBudget keeps everything when all ids are kept", () => {
		const images = new Map([
			[1, "aaaa"],
			[2, "bbbb"],
		]);
		evictImagesToBudget(images, size, 1, new Set([1, 2]));
		expect([...images.keys()]).toEqual([1, 2]);
	});

	test("evictImagesToBudget is a no-op within budget", () => {
		const images = new Map([[1, "aa"]]);
		evictImagesToBudget(images, size, 100, new Set());
		expect([...images.keys()]).toEqual([1]);
	});
});
