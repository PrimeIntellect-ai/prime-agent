import { Container, setKeybindings, Text, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { convertToLlm, createCompactionOutcomeMessage, createCompactionSummaryMessage } from "../src/core/messages.js";
import { CompactionOutcomeMessageComponent } from "../src/modes/interactive/components/compaction-outcome-message.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

describe("compact compaction messages", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	test.each(["prime", "dark", "light"])("matches the refinement header and softer summary in the %s theme", (name) => {
		initTheme(name);
		const summary = "Finish the authentication fixes.";
		const component = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage(summary, 120480, "2026-09-09"),
		);
		const collapsed = component.render(80);
		expect(collapsed.map((line) => stripAnsi(line).trimEnd())).toEqual([
			" ◆ Context compacted",
			" Finish the authentication fixes.",
		]);
		expect(collapsed[0]).toContain(theme.fg("refinementHeader", "◆ Context compacted"));
		expect(collapsed[1]).toBe(theme.fg("refinementSummary", ` ${summary}`));
		expect(theme.getFgAnsi("refinementHeader")).not.toBe(theme.getFgAnsi("refinementSummary"));

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n"));
		expect(expanded).toContain(summary);
		expect(expanded).toContain("Compacted from 120,480 tokens");
		expect(expanded).not.toContain("Ctrl+O");
		component.setExpanded(false);
		expect(component.render(80)).toEqual(collapsed);
	});

	test("previews the stored summary instead of focus instructions and reveals all metadata on expansion", () => {
		const focus =
			"Keep the exact reproduction steps.\nPreserve the failing command and the environment details for the next turn.";
		const summary = `${"Retained the authentication investigation and rollout decisions. ".repeat(8)}Final retained detail.`;
		const message = createCompactionSummaryMessage(summary, 12345, "2026-09-09", focus);
		const before = JSON.stringify(message);
		const modelBefore = JSON.stringify(convertToLlm([message]));
		const component = new CompactionSummaryMessageComponent(message);
		const lines = component.render(80).map((line) => stripAnsi(line).trimEnd());
		expect(lines).toHaveLength(3);
		expect(lines[0]).toBe(" ◆ Context compacted");
		expect(lines[1]).toContain("Retained the authentication investigation");
		expect(lines[2]).toContain("…");
		expect(lines.join("\n")).not.toMatch(/focus:|12,345|Final retained detail/);

		for (const width of [12, 24, 40, 80]) {
			for (const line of component.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(80).join("\n")).replace(/\s+/g, " ");
		expect(expanded).toContain(summary);
		expect(expanded).toContain(focus.replace(/\s+/g, " "));
		expect(expanded).toContain("Compacted from 12,345 tokens");
		expect(JSON.stringify(message)).toBe(before);
		expect(JSON.stringify(convertToLlm([message]))).toBe(modelBefore);
	});

	test("preserves full Markdown and the supplied Markdown theme in all output", () => {
		const heading = vi.fn((text: string) => `heading:${text}`);
		const component = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage("## Next steps\n\nFinish the authentication fixes.", 100, "2026-09-09"),
			{ ...getMarkdownTheme(), heading },
		);
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("heading:Next steps");
		expect(heading).toHaveBeenCalled();
	});

	test("retains one leading gap in live and reopened chats through every display stage", () => {
		const message = createCompactionSummaryMessage("Retained the next task.", 100, "2026-09-09");
		const createMode = (expanded: boolean) =>
			Object.assign(Object.create(InteractiveMode.prototype), {
				chatContainer: new Container(),
				toolOutputExpanded: expanded,
				editDiffsExpanded: false,
				getMarkdownThemeWithSettings: getMarkdownTheme,
				ui: { isFullscreen: () => true, requestRender: vi.fn() },
			});
		const append = (mode: ReturnType<typeof createMode>) => {
			mode.chatContainer.addChild(new Text("Before compaction", 1, 0));
			Reflect.get(InteractiveMode.prototype, "addMessageToChat").call(mode, message);
		};
		const live = createMode(false);
		append(live);
		for (const [expanded, details] of [
			[false, false],
			[false, true],
			[true, true],
			[false, false],
		]) {
			Object.assign(live, { toolOutputExpanded: expanded, editDiffsExpanded: details });
			Reflect.get(InteractiveMode.prototype, "applyChatExpansion").call(live);
			const reopened = createMode(expanded!);
			append(reopened);
			expect(live.chatContainer.render(80)).toEqual(reopened.chatContainer.render(80));
			const lines = live.chatContainer.render(80).map((line: string) => stripAnsi(line).trimEnd());
			expect(lines.slice(0, 3)).toEqual([" Before compaction", "", " ◆ Context compacted"]);
			expect(lines.at(-1)).not.toBe("");
			expect(lines.join("\n").includes("Compacted from")).toBe(expanded);
			expect(lines.join("\n")).toContain("Retained the next task.");
		}
	});

	test("labels missing summaries without inventing a result", () => {
		const component = new CompactionSummaryMessageComponent(createCompactionSummaryMessage("  ", 100, "2026-09-09"));
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("No summary was recorded for this compaction.");
		}
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
