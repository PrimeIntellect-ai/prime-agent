import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeAll, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionOutcomeMessage, createCompactionSummaryMessage } from "../src/core/messages.js";
import { CompactionOutcomeMessageComponent } from "../src/modes/interactive/components/compaction-outcome-message.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

describe("compact compaction messages", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test("shows the result and details hint without a separate banner or blank rows", () => {
		const component = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage("## Next steps\n\nFinish the authentication fixes.", 120480, "2026-09-09"),
		);
		const collapsed = component.render(80).map((line) => stripAnsi(line).trimEnd());

		expect(collapsed).toEqual([" Compacted from 120,480 tokens", " Compaction (Ctrl+O to expand)"]);
		for (const line of collapsed) {
			expect(line.startsWith(" ")).toBe(true);
		}

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain("Next steps");
		expect(expanded).toContain("Finish the authentication fixes.");
		expect(expanded).toContain("Ctrl+O to collapse");

		component.setExpanded(false);
		expect(component.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual(collapsed);
	});

	test("keeps long focus instructions bounded in the preview and complete in the expanded view", () => {
		const focus =
			"Keep the authentication investigation, the remaining rollout decisions, and the exact reproduction steps.\nPreserve the failing command and the environment details for the next turn.";
		const component = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage("Full retained summary.", 12345, "2026-09-09", focus),
		);
		const lines = component.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(" Compacted from 12,345 tokens · focus:");
		for (const line of lines) {
			if (line.length > 0) expect(line.startsWith(" ")).toBe(true);
		}
		expect(lines[1]).toContain("…");
		expect(lines[2]).toContain("Ctrl+O to expand");

		for (const width of [12, 24, 40, 80]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n")).replace(/\s+/g, " ");
		expect(expanded).toContain(focus.replace(/\s+/g, " "));
		expect(expanded).toContain("Full retained summary.");
	});

	test.each(["skipped", "cancelled", "failed"] as const)("keeps the full %s explanation visible", (outcome) => {
		const content = `Auto-compaction ${outcome}: the context could not be compacted because the summary request did not complete. The original conversation remains available.`;
		const component = new CompactionOutcomeMessageComponent(
			createCompactionOutcomeMessage(content, { outcome, reason: "threshold" }),
		);
		const lines = component.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(
			lines
				.map((line) => line.trim())
				.join(" ")
				.trim(),
		).toBe(content);
		expect(lines.filter((line) => line === "")).toHaveLength(1);
		for (const line of lines) {
			if (line.length > 0) expect(line.startsWith(" ")).toBe(true);
		}
	});
});
