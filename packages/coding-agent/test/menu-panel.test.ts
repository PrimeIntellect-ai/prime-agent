import { Container } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, it } from "vitest";
import {
	inlineMenuPanelTopRuleRows,
	MenuPanel,
	MenuSearchInput,
} from "../src/modes/interactive/components/menu-panel.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("MenuPanel inline separator rule", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("opens inline panels with exactly one rule by default", () => {
		// A titled inline panel draws its separator rule above the title, and a
		// headerless panel led by the bordered search input keeps the input's own
		// top border as its one rule — never two adjacent rules.
		const titled = new MenuPanel({ title: "Accounts", inline: true });
		titled.addChild(new MenuSearchInput("Search", true));
		const titledLines = titled.render(24).map(stripAnsi);
		expect(titledLines[0]).toBe("─".repeat(24));

		const search = new MenuPanel({ title: "", inline: true });
		search.addChild(new MenuSearchInput("Search", true));
		const searchLines = search.render(24).map(stripAnsi);
		expect(searchLines[0]).toBe("─".repeat(24));
		expect(searchLines[1]).not.toBe("─".repeat(24));
		expect(searchLines[1]).toContain("Search");
	});

	it("an empty leading child never doubles the inline separator (bugbot #2330)", () => {
		// The model picker adds an empty header-help Container before its search
		// input; counting that placeholder as the panel opener drew the panel rule
		// directly on top of the search box's own border (two stacked rules and a
		// wasted list row).
		const withPlaceholder = new MenuPanel({ title: "", inline: true });
		withPlaceholder.addChild(new Container());
		withPlaceholder.addChild(new MenuSearchInput("Search models", true));

		const direct = new MenuPanel({ title: "", inline: true });
		direct.addChild(new MenuSearchInput("Search models", true));

		const rules = (panel: MenuPanel) =>
			panel
				.render(80)
				.map((line) => stripAnsi(line))
				.filter((line) => line.trim().startsWith("─")).length;

		expect(rules(withPlaceholder)).toBe(rules(direct));
		expect(inlineMenuPanelTopRuleRows({ children: withPlaceholder.children })).toBe(0);
		// A populated header still owns the rule.
		const populated = new MenuPanel({ title: "", inline: true });
		const header = new Container();
		header.addChild(new MenuSearchInput("Signed-in providers first.", true));
		populated.addChild(header);
		populated.addChild(new MenuSearchInput("Search models", true));
		expect(inlineMenuPanelTopRuleRows({ children: populated.children })).toBe(1);
	});
});
