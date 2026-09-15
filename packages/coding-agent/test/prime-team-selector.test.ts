import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { PrimeTeamSelectorComponent } from "../src/modes/interactive/components/prime-team-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("PrimeTeamSelectorComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("renders personal and team options with current status", () => {
		const selector = new PrimeTeamSelectorComponent(
			[
				{ teamId: "team-1", name: "Research", slug: "research", role: "admin" },
				{ teamId: "team-2", name: "Infra", role: "member" },
			],
			"team-1",
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(100).join("\n"));

		expect(output).toContain("Select a Prime Team:");
		expect(output).toContain("Personal");
		expect(output).toContain("personal account");
		expect(output).toContain("Research");
		expect(output).toContain("slug: research, role: admin");
		expect(output).toContain("Infra");
		expect(output).toContain("role: member");
		expect(output).toContain("current");
	});

	it("marks personal as current when no team id is active", () => {
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research", slug: "research", role: "admin" }],
			undefined,
			() => {},
			() => {},
		);

		const lines = stripAnsi(selector.render(100).join("\n")).split("\n");
		const personalLine = lines.find((line) => line.includes("Personal"));
		const teamLine = lines.find((line) => line.includes("Research"));

		expect(personalLine).toContain("current");
		expect(teamLine).not.toContain("current");
	});

	it("selects a team from the menu", () => {
		let selectedTeamId: string | undefined;
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research", slug: "research", role: "admin" }],
			undefined,
			(team) => {
				selectedTeamId = team?.teamId;
			},
			() => {},
		);

		selector.handleInput("\x1B[B");
		selector.handleInput("\r");

		expect(selectedTeamId).toBe("team-1");
	});

	it("cancels without selecting a team", () => {
		let cancelled = false;
		const selector = new PrimeTeamSelectorComponent(
			[{ teamId: "team-1", name: "Research" }],
			undefined,
			() => {},
			() => {
				cancelled = true;
			},
		);

		selector.handleInput("\x1B");

		expect(cancelled).toBe(true);
	});
});
