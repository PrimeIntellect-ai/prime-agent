import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.js";
import { visibleWidth } from "../src/utils.js";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("marks truncated descriptions without resetting outer styles", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "This description is much too long for the available terminal width",
			},
		];
		const styledTheme = {
			...testTheme,
			selectedText: (text: string) => `\x1b[35m${text}\x1b[39m`,
		};

		const list = new SelectList(items, 5, styledTheme);
		const [line] = list.render(50);

		assert.ok(line?.includes("…"));
		assert.ok(visibleWidth(line ?? "") <= 50);
		assert.doesNotMatch(line ?? "", /\x1b\[0m/);
	});

	it("shows the selected description in a wrapped detail area", () => {
		const description = "This description is too long to fit on the selected row but remains available in full";
		const items = [{ value: "test", label: "test", description }];
		const list = new SelectList(items, 5, testTheme, { showSelectedDescription: true });

		const rendered = list.render(50);
		const detailLines = rendered.slice(2).map((line) => line.trim());

		assert.ok(rendered[0]?.includes("…"));
		assert.equal(detailLines.join(" "), description);
		assert.ok(rendered.every((line) => visibleWidth(line) <= 50));
	});

	it("sizes the detail area to the selected description", () => {
		const items = [
			{
				value: "long",
				label: "long",
				description: "A selected description that wraps across several lines at this terminal width",
			},
			{ value: "short", label: "short", description: "Short description" },
		];
		const list = new SelectList(items, 5, testTheme, { showSelectedDescription: true });

		const longSelection = list.render(32);
		list.setSelectedIndex(1);
		const shortSelection = list.render(32);

		assert.ok(shortSelection.length < longSelection.length);
		assert.equal(shortSelection.at(-1)?.trim(), "Short description");
	});

	it("shows slash metadata in rows and only the selected description below", () => {
		const items = [
			{
				value: "compact",
				label: "compact",
				description: "Compact the session context",
				argumentHint: "[instructions]",
			},
			{
				value: "skill:compact",
				label: "skill:compact",
				description: "Check context usage and compact the conversation",
				sourceTag: "#builtin",
			},
		];
		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
			showItemMetadata: true,
			showSelectedDescription: true,
		});

		const rendered = list.render(80);

		assert.match(rendered[0] ?? "", /compact\s+\[instructions\]/);
		assert.match(rendered[1] ?? "", /skill:compact\s+#builtin/);
		assert.ok(!rendered[0]?.includes("Compact the session context"));
		assert.equal(
			rendered
				.slice(3)
				.map((line) => line.trim())
				.join(" "),
			"Compact the session context",
		);
	});

	it("bounds styled Unicode metadata rows at narrow widths", () => {
		const items = [
			{
				value: "技能:圧縮",
				label: "技能:圧縮",
				argumentHint: "[非常に長い指示]",
				sourceTag: "#builtin",
			},
		];
		const styledTheme = {
			...testTheme,
			selectedPrefix: (text: string) => `\x1b[36m${text}\x1b[39m`,
			selectedText: (text: string) => `\x1b[35m${text}\x1b[39m`,
			argumentHint: (text: string) => `\x1b[33m${text}\x1b[39m`,
			sourceTag: (text: string) => `\x1b[32m${text}\x1b[39m`,
		};
		const list = new SelectList(items, 5, styledTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 32,
			showItemMetadata: true,
		});

		for (const width of [1, 2, 3, 4, 8, 12, 20, 40]) {
			const rendered = list.render(width);
			assert.ok(
				rendered.every((line) => visibleWidth(line) <= width),
				`render exceeded width ${width}`,
			);
		}
	});

	it("normalizes multiline metadata to a single row", () => {
		const list = new SelectList(
			[
				{
					value: "review",
					label: "review",
					argumentHint: "<first>\n<second>",
					sourceTag: "#project\nscope",
				},
			],
			5,
			testTheme,
			{
				minPrimaryColumnWidth: 12,
				maxPrimaryColumnWidth: 32,
				showItemMetadata: true,
			},
		);

		const rendered = list.render(80);

		assert.equal(rendered.length, 1);
		assert.doesNotMatch(rendered[0] ?? "", /[\r\n]/);
		assert.match(rendered[0] ?? "", /review\s+<first> <second>\s+#project scope/);
	});

	it("shows directional hidden counts at the top, middle, and bottom", () => {
		const items = Array.from({ length: 12 }, (_, index) => ({
			value: `item-${index}`,
			label: `item-${index}`,
		}));
		const list = new SelectList(items, 5, testTheme, { showDirectionalScrollInfo: true });

		assert.equal(list.render(80).at(-1)?.trim(), "↓ 7 more");
		list.setSelectedIndex(6);
		assert.equal(list.render(80).at(-1)?.trim(), "↑ 4 more  ↓ 3 more");
		list.setSelectedIndex(11);
		assert.equal(list.render(80).at(-1)?.trim(), "↑ 7 more");
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});
});
