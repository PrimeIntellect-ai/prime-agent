import { type ClickRegion, Container, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { createCompactionSummaryMessage } from "../src/core/messages.js";
import { CollapsibleErrorComponent } from "../src/modes/interactive/components/collapsible-error.js";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.js";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { TOOL_PANEL_PADDING_X, ToolPanel } from "../src/modes/interactive/components/tool-panel.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.js";

const mockTui = { requestRender: vi.fn(), setFocus: vi.fn(), terminal: { rows: 24 } } as unknown as TUI;
function regionFor(lines: string[], regions: ReadonlyArray<ClickRegion>, needle: string): ClickRegion {
	const region = regions.find((region) => stripAnsi(lines[region.line] ?? "").includes(needle));
	expect(region, `region for ${needle}`).toBeDefined();
	return region!;
}
describe("conversation click regions", () => {
	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
		vi.clearAllMocks();
	});

	test("a summary-row click toggles only that item and Ctrl+O resets all detail globally", () => {
		const tool = new ToolExecutionComponent("read", "call-1", { path: "/tmp/x" }, {}, undefined, mockTui, "/tmp");
		tool.markExecutionStarted();
		tool.setArgsComplete();
		tool.updateResult({
			content: [{ type: "text", text: Array.from({ length: 10 }, (_, i) => `out ${i}`).join("\n") }],
			isError: false,
		});
		const compaction = new CompactionSummaryMessageComponent(
			createCompactionSummaryMessage("Retained the current task.", 100, "2026-09-16"),
		);
		const chat = new Container();
		chat.addChild(tool);
		chat.addChild(compaction);

		const collapsedTool = tool.render(80).join("\n");
		const collapsedCompaction = compaction.render(80).join("\n");
		const lines = chat.render(80);
		const regions = chat.getClickRegions();
		const toolRegion = regionFor(lines, regions, "read");
		const compactionRegion = regionFor(lines, regions, "Retained the current task.");

		toolRegion.onClick({ row: 0, col: 0 });
		expect(tool.render(80).join("\n")).toContain("out 9");
		expect(compaction.render(80).join("\n")).toBe(collapsedCompaction);
		compactionRegion.onClick({ row: 0, col: 0 });
		expect(compaction.render(80).join("\n")).not.toBe(collapsedCompaction);
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			chatContainer: chat,
			pendingBashComponents: [],
			toolOutputExpanded: false,
			editDiffsExpanded: false,
			hideThinkingBlock: true,
			ui: { isFullscreen: () => true, requestRender: vi.fn() },
		});
		Reflect.get(InteractiveMode.prototype, "applyChatExpansion").call(mode);
		expect(tool.render(80).join("\n")).toBe(collapsedTool);
		expect(compaction.render(80).join("\n")).toBe(collapsedCompaction);
	});
	test("ToolPanel offsets child regions past its header and separator rows", () => {
		const calls: { row: number; col: number }[] = [];
		const panel = new ToolPanel();
		panel.addChild({
			render: () => ["body"],
			invalidate: () => {},
			getClickRegions: () => [{ line: 0, col: 0, width: 5, height: 1, onClick: (p) => calls.push(p) }],
		});
		expect(panel.render(40)).toHaveLength(3);
		const regions = panel.getClickRegions();
		expect(regions).toHaveLength(1);
		expect(regions[0]!.line).toBe(2);
		expect(regions[0]!.col).toBe(TOOL_PANEL_PADDING_X);
		regions[0]!.onClick({ row: 0, col: 1 });
		expect(calls).toEqual([{ row: 0, col: 1 }]);
	});

	test.each([
		[8, 5],
		[0, 1],
	])("editor col %i places the cursor at text col %i through header rows and hidden prefixes", (col, textCol) => {
		const editor = new CustomEditor(mockTui, getEditorTheme(), new KeybindingsManager(), { promptPrefix: "> " });
		editor.getHeaderLine = () => "context: /tmp";
		editor.setText("!echo hi");
		const lines = editor.render(40);
		const regions = editor.getClickRegions();
		expect(regions).toHaveLength(1);
		expect(regions[0]!.line).toBe(3);
		expect(lines.length).toBeGreaterThan(regions[0]!.line);
		regions[0]!.onClick({ row: 0, col });
		expect(editor.getCursor()).toEqual({ line: 0, col: textCol });
		expect(mockTui.setFocus).toHaveBeenCalledWith(editor);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
	});

	test("wrapped collapsed errors expose every summary row", () => {
		const error = new CollapsibleErrorComponent({ text: "first\nsecond", summary: "a summary long enough to wrap" });
		const lines = error.render(12);
		expect(lines.length).toBeGreaterThan(1);
		expect(error.getClickRegions()[0]!.height).toBe(lines.length);
	});
});
