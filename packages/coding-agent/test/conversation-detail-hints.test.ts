import { setKeybindings } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("conversation detail hints", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("keeps notifications readable and expandable without inline detail hints", () => {
		const cards = [
			{
				component: new CompactionSummaryMessageComponent({
					role: "compactionSummary",
					summary: "Preserved context details",
					tokensBefore: 12000,
					timestamp: 0,
				}),
				label: "Compacted from 12,000 tokens",
				body: "Preserved context details",
			},
			{
				component: new BranchSummaryMessageComponent({
					role: "branchSummary",
					summary: "Earlier branch details",
					fromId: "branch-1",
					timestamp: 0,
				}),
				label: "Branch summary",
				body: "Earlier branch details",
			},
			{
				component: new SkillInvocationMessageComponent({
					name: "review",
					location: "/tmp/review/SKILL.md",
					content: "Review instructions",
					userMessage: undefined,
				}),
				label: "review",
				body: "Review instructions",
			},
		];
		for (const { component, label, body } of cards) {
			const collapsed = stripAnsi(component.render(100).join("\n"));
			expect(collapsed).toContain(label);
			expect(collapsed).not.toContain(body);
			expect(collapsed).not.toContain("Ctrl+O");
			expect(collapsed).not.toMatch(/\(\s*\)|·\s*$/m);

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(100).join("\n"));
			expect(expanded).toContain(body);
			expect(expanded).not.toContain("Ctrl+O");
		}
	});
});
