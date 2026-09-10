import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { formatConversationDetailStatus } from "../src/modes/interactive/components/keybinding-hints.js";
import { PromptContextLine } from "../src/modes/interactive/components/prompt-context-line.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

interface DetailMode {
	toolOutputExpanded: boolean;
	editDiffsExpanded: boolean;
	getPromptContextLabel(width: number): string | undefined;
	getTrayContextLabel(): string | undefined;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
}
function createMode(): DetailMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		toolOutputExpanded: false,
		editDiffsExpanded: false,
		applyChatExpansion: vi.fn(),
		isInlinePickerOpen: () => false,
		getTrayGoalLabel: () => undefined,
		getTrayHeartbeatLabel: () => undefined,
		getConnectionContextUsage: () => undefined,
		getCurrentModel: () => ({ id: "glm-5.3", provider: "prime", reasoning: true }),
		connectionState: { thinkingLevel: "high" },
	});
}

describe("conversation detail status", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("tracks the complete three-stage cycle above the prompt while keeping recap on the left", () => {
		const mode = createMode();
		const bar = new PromptContextLine(
			() => "Updated files",
			(width) => mode.getPromptContextLabel(width),
		);
		for (const expected of [
			"Showing overview (Ctrl+O to expand)",
			"Showing details (Ctrl+O to expand)",
			"Showing all output (Ctrl+O to collapse)",
			"Showing overview (Ctrl+O to expand)",
		]) {
			expect(mode.getPromptContextLabel(120)).toBe(theme.fg("dim", expected));
			const line = stripAnsi(bar.render(120)[1]!);
			expect(line).toMatch(/^ Recap: Updated files\s+/);
			expect(line.trimEnd().endsWith(expected)).toBe(true);
			expect(visibleWidth(line)).toBe(120);
			mode.toggleToolOutputExpansion();
		}
	});

	it("uses the configured primary key and omits an unbound shortcut without an empty wrapper", () => {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": ["ctrl+e", "alt+e"] }));
		expect(formatConversationDetailStatus(false, false)).toBe("Showing overview (Ctrl+E to expand)");
		expect(formatConversationDetailStatus(false, true)).toBe("Showing details (Ctrl+E to expand)");
		expect(formatConversationDetailStatus(true, true)).toBe("Showing all output (Ctrl+E to collapse)");
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		expect(formatConversationDetailStatus(false, false)).toBe("Showing overview");
		expect(formatConversationDetailStatus(false, true)).toBe("Showing details");
		expect(formatConversationDetailStatus(true, true)).toBe("Showing all output");
	});

	it("reflects extension expansion setters", () => {
		const mode = createMode();
		mode.setToolsExpanded(true);
		expect(stripAnsi(mode.getPromptContextLabel(120)!)).toBe("Showing all output (Ctrl+O to collapse)");
		mode.setToolsExpanded(false);
		expect(stripAnsi(mode.getPromptContextLabel(120)!)).toBe("Showing overview (Ctrl+O to expand)");
	});

	it("preserves top-row bounds while the lower tray retains model metadata and navigation overrides", () => {
		const mode = createMode();
		const bar = new SubagentSummaryLine(
			() => "manage",
			() => mode.getTrayContextLabel(),
			() => "Press Ctrl+C again to exit",
		);
		expect(stripAnsi(bar.render(120)[0]!)).toMatch(/^Press Ctrl\+C again to exit\s+glm-5.3:high$/);
		const top = new PromptContextLine(
			() => "Long recap needing truncation",
			(width) => mode.getPromptContextLabel(width),
		);
		for (const width of [1, 10, 30, 40, 80]) {
			for (const line of [...bar.render(width), ...top.render(width)])
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
