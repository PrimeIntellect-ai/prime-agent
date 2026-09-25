import { visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it } from "vitest";
import { createGoalContextMessage, emptyGoalState } from "../src/core/goals.js";
import { createCompactionSummaryMessage } from "../src/core/messages.js";
import { agentMessageBodyLines } from "../src/modes/interactive/components/agent-message.js";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { InjectedPromptMessageComponent } from "../src/modes/interactive/components/injected-prompt-message.js";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const goalPrompt = createGoalContextMessage({ ...emptyGoalState(), objective: "Ship." }, "continuation");
const skillBlock = { name: "review", location: "/tmp/SKILL.md", content: "Review the diff.", userMessage: undefined };
const branchSummary = { role: "branchSummary", summary: "Branch details", fromId: "b1", timestamp: 0 } as const;

describe("expandable event message gutter", () => {
	beforeEach(() => initTheme("dark"));

	it("expands compaction under the agent-message gutter, metadata on the header row", () => {
		const message = createCompactionSummaryMessage(`${"w".repeat(27)}\n\n|a|b|\n|-|-|\n|1|2|`, 480, "2026-09-09");
		const component = new CompactionSummaryMessageComponent(message);
		const collapsed = component.render(30);
		component.setExpanded(true);
		expect(component.render(60)[0]).toContain(theme.fg("refinementHeader", "◆ Context compacted"));
		expect(component.render(60)[0]).toContain(theme.fg("dim", " · Compacted from 480 tokens"));
		const rows = component.render(30);
		const body = rows.findIndex((line) => stripAnsi(line).includes("╰─"));
		const gutter = ` ${theme.fg("dim", "╰─ ")}`;
		expect(rows[body]!.slice(0, gutter.length)).toBe(gutter);
		expect(agentMessageBodyLines("text", 30)[0]!.slice(0, gutter.length)).toBe(gutter);
		expect(stripAnsi(rows[body]).endsWith(` ╰─ ${"w".repeat(26)}`)).toBe(true);
		expect(stripAnsi(rows[body + 1]).trimEnd()).toBe("    w");
		expect(rows.slice(body + 1).every((line) => /^ {4}/.test(stripAnsi(line)))).toBe(true);
		for (const line of rows) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		expect(component.getSelectionRegions()[0]!.tableLeft).toBe(4);
		expect(component.getClickRegions()[0]).toMatchObject({ line: 0, height: body });
		component.getClickRegions()[0]!.onClick({ row: 0, col: 0 });
		expect(component.render(30)).toEqual(collapsed);
	});

	it.each([
		["skill", () => new SkillInvocationMessageComponent(skillBlock)],
		["branch", () => new BranchSummaryMessageComponent(branchSummary)],
		["goal", () => new InjectedPromptMessageComponent(goalPrompt)],
	])("gutters the expanded %s body right below its header", (_name, create) => {
		const component = create();
		expect(component.render(60).join("\n")).not.toContain("╰─");
		component.setExpanded(true);
		const rows = component.render(60);
		expect(rows.filter((line) => stripAnsi(line).includes("╰─"))).toHaveLength(1);
		expect(stripAnsi(rows[rows.findIndex((line) => line.length > 0) + 1]!)).toContain("╰─");
	});
});
