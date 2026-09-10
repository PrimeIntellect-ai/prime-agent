import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { formatConversationDetailStatus } from "../src/modes/interactive/components/keybinding-hints.js";
import { SubagentSummaryLine } from "../src/modes/interactive/components/subagent-summary-line.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

interface DetailMode {
	toolOutputExpanded: boolean;
	editDiffsExpanded: boolean;
	getTrayContextLabel(): string | undefined;
	toggleToolOutputExpansion(): void;
	setToolsExpanded(expanded: boolean): void;
}
function createMode(): DetailMode {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		toolOutputExpanded: false,
		editDiffsExpanded: false,
		applyChatExpansion: vi.fn(),
		getTrayGoalLabel: () => undefined,
		getTrayHeartbeatLabel: () => undefined,
		getConnectionContextUsage: () => undefined,
	});
}

describe("conversation detail status", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	it("tracks the complete three-stage cycle at the bottom right while keeping the left label", () => {
		const mode = createMode();
		const bar = new SubagentSummaryLine(
			() => "manage",
			() => mode.getTrayContextLabel(),
		);
		for (const expected of [
			"Showing overview (Ctrl+O to expand)",
			"Showing details (Ctrl+O to expand)",
			"Showing all output (Ctrl+O to collapse)",
			"Showing overview (Ctrl+O to expand)",
		]) {
			expect(mode.getTrayContextLabel()).toBe(expected);
			const line = stripAnsi(bar.render(120)[0]!);
			expect(line).toMatch(/^manage\s+/);
			expect(line.endsWith(expected)).toBe(true);
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
		expect(mode.getTrayContextLabel()).toBe("Showing all output (Ctrl+O to collapse)");
		mode.setToolsExpanded(false);
		expect(mode.getTrayContextLabel()).toBe("Showing overview (Ctrl+O to expand)");
	});

	it("preserves bounds in narrow terminals and remains visible through a left-side override", () => {
		const mode = createMode();
		const bar = new SubagentSummaryLine(
			() => "manage",
			() => mode.getTrayContextLabel(),
			() => "Press Ctrl+C again to exit",
		);
		expect(stripAnsi(bar.render(120)[0]!)).toMatch(
			/^Press Ctrl\+C again to exit\s+Showing overview \(Ctrl\+O to expand\)$/,
		);
		for (const width of [1, 10, 30, 40, 80])
			for (const line of bar.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});
});
