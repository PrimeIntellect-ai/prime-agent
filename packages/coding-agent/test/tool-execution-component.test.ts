import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, resetCapabilitiesCache, setCapabilities, Text, TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.js";
import type { ToolDefinition } from "../src/core/extensions/types.js";
import { type BashOperations, createBashTool, createBashToolDefinition } from "../src/core/tools/bash.js";
import { createEditToolDefinition } from "../src/core/tools/edit.js";
import { createAgentConnectionToolDefinition } from "../src/modes/agent-connection/tool-definition.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { getWorkingPulseFrame, workingIconFrame } from "../src/modes/interactive/theme/working-icon.js";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

function createMetadataOnlyToolDefinition(definition: ToolDefinition<any, any>) {
	const metadata = createAgentConnectionToolDefinition(definition);
	if (!metadata) {
		throw new Error("expected tool metadata");
	}
	return metadata;
}

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test.each(["kitty", null] as const)("renders one compact image metadata row for %s capability", (protocol) => {
		setCapabilities({ images: protocol, trueColor: true, hyperlinks: true });
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-image-default",
				{},
				{ showImages: true },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).not.toContain("\x1b_G");
			expect(rendered).toContain("    ╰─ [image/png · 800×600]");
			expect(rendered.match(/image\/png/g)).toHaveLength(1);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("keeps image metadata escape-free across visibility toggles", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-image-history",
				{},
				{ showImages: true, includeImageDimensions: false },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });

			let rendered = component.render(120).join("\n");
			expect(rendered).not.toContain("\x1b_G");
			const fallbackLines = stripAnsi(rendered).split("\n");
			const fallbackIndex = fallbackLines.findIndex((line) => line.includes("[image/png"));
			expect(fallbackIndex).toBeGreaterThan(0);
			expect(fallbackLines[fallbackIndex - 1]?.trim()).not.toBe("");

			component.setShowImages(false);
			component.setShowImages(true);
			rendered = component.render(120).join("\n");
			expect(rendered).not.toContain("\x1b_G");
		} finally {
			resetCapabilitiesCache();
		}
	});
	test("does not duplicate replayed image fallbacks through built-in renderers", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const component = new ToolExecutionComponent(
				"bash",
				"tool-bash-image-history",
				{ command: "generate-image" },
				{ showImages: true, includeImageDimensions: false },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered.match(/image\/png/g)).toHaveLength(1);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test.each(["kitty", "iterm2", null] as const)(
		"keeps one visible IPython image row without emitting terminal graphics for %s capability",
		(protocol) => {
			setCapabilities({ images: protocol, trueColor: true, hyperlinks: true });
			try {
				const component = new ToolExecutionComponent(
					"ipython",
					`tool-ipython-image-${protocol}`,
					{ code: "display(image)" },
					{ showImages: true, includeImageDimensions: false },
					undefined,
					createFakeTui(),
					process.cwd(),
				);
				component.setExpanded(true);
				component.updateResult(
					{
						content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
						isError: false,
					},
					false,
				);

				const rendered = component.render(120).join("\n");
				expect(rendered).not.toContain("\x1b_G");
				expect(rendered).not.toContain("\x1b]1337;File=");
				const lines = stripAnsi(rendered).split("\n");
				expect(lines.filter((line) => line.includes("╰─ [image/png")).length).toBe(1);
			} finally {
				resetCapabilitiesCache();
			}
		},
	);

	test("uses the compact fallback for a live IPython image in fullscreen", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const terminal = new VirtualTerminal(120, 12);
		const tui = new TUI(terminal);
		try {
			const transcript = new Container();
			const dock = new Text("> prompt", 0, 0);
			const component = new ToolExecutionComponent(
				"ipython",
				"tool-ipython-image-fullscreen",
				{ code: "display(image)" },
				{ showImages: true },
				undefined,
				tui,
				process.cwd(),
			);
			component.setExpanded(true);
			component.updateResult(
				{ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false },
				false,
			);
			transcript.addChild(component);
			tui.addChild(transcript);
			tui.addChild(dock);
			tui.start();
			tui.enterFullscreen({ scroll: [transcript], dock });
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			expect(viewport.filter((line) => line.includes("    ╰─ [image/png · 800×600]")).length).toBe(1);
			expect(viewport.join("\n")).not.toContain("\x1b_G");
		} finally {
			tui.stop();
			resetCapabilitiesCache();
		}
	});

	test("historical image fallbacks include dimensions", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const onePixelPng =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-image-history-dims",
				{},
				{ showImages: true, includeImageDimensions: false },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({
				content: [{ type: "image", data: onePixelPng, mimeType: "image/png" }],
				isError: false,
			});

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).toContain("    ╰─ [image/png · 1×1]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("pending history components remain metadata-only when restored to live output", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-image-pending-history",
				{},
				{ showImages: true, includeImageDimensions: false },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }], isError: false });
			expect(component.render(120).join("\n")).not.toContain("\x1b_G");

			component.setIncludeImageDimensions(true);

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).not.toContain("\x1b_G");
			expect(rendered).toContain("    ╰─ [image/png · 800×600]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("preserves original image metadata when display is toggled back on", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const tinyJpeg =
				"/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AD3VTB3/2Q==";
			const component = new ToolExecutionComponent(
				"custom_tool",
				"tool-image-hidden-conversion",
				{},
				{ showImages: false },
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({
				content: [{ type: "image", data: tinyJpeg, mimeType: "image/jpeg" }],
				isError: false,
			});

			component.setShowImages(true);

			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).not.toContain("\x1b_G");
			expect(rendered).toContain("    ╰─ [image/jpeg · 2×2]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("does not apply legacy replay renderers to custom overrides without renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit · done");
		expect(rendered).not.toContain("README.md");
		expect(rendered).not.toContain("+1 after");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"tool-3",
			{ file_path: "README.md", oldText: "before", newText: "after" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
	});

	test("uses legacy replay renderers for metadata-only built-in definitions", () => {
		const bashComponent = new ToolExecutionComponent(
			"bash",
			"tool-3b",
			{ command: "echo hello" },
			{},
			createMetadataOnlyToolDefinition(createBashToolDefinition(process.cwd())),
			createFakeTui(),
			process.cwd(),
		);
		bashComponent.updateResult({ content: [{ type: "text", text: "hello" }], isError: false }, false);
		expect(stripAnsi(bashComponent.render(120).join("\n"))).toContain("$ echo hello");

		const legacyEditMetadata = {
			...createMetadataOnlyToolDefinition(createEditToolDefinition(process.cwd())),
			description: "Legacy edit metadata from an older session.",
			promptSnippet: "Legacy edit prompt.",
		};
		const editComponent = new ToolExecutionComponent(
			"edit",
			"tool-3c",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			legacyEditMetadata,
			createFakeTui(),
			process.cwd(),
		);
		editComponent.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		expect(stripAnsi(editComponent.render(120).join("\n"))).toContain("README.md");
	});

	test("does not use legacy replay renderers for metadata-only custom collisions", () => {
		const customEditDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
			parameters: Type.Object({
				path: Type.String(),
			}),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-3d",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			createMetadataOnlyToolDefinition(customEditDefinition),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit · done");
		expect(rendered).not.toContain("README.md");
		expect(rendered).not.toContain("+1 after");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"tool-4",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false },
			false,
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bedit\b/g)?.length ?? 0).toBe(1);
	});

	test("shows the built-in edit diff on collapsed tool calls when edit diffs are expanded", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"tool-4e",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [], details: { diff: "-1 before\n+1 after", firstChangedLine: 1 }, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).not.toContain("-1 before");
		expect(collapsed).toContain("+1 -1");
		// The collapsed `╰─ path +N -M` summary line carries the ctrl+j hint —
		// and it is the only carrier: the header must not duplicate it.
		expect(collapsed.split("\n").find((line) => line.includes("╰─"))).toContain("to expand");
		expect(collapsed.split("to expand").length - 1).toBe(1);

		component.setEditDiffsExpanded(true);
		const withDiffLines = stripAnsi(component.render(120).join("\n")).split("\n");
		// The summary line stays put; the diff renders under it, indented to its text column.
		const summaryIndex = withDiffLines.findIndex((line) => line.includes("╰─ README.md +1 -1"));
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		expect(withDiffLines[summaryIndex]).toContain("to collapse");
		const textColumn = withDiffLines[summaryIndex].indexOf("README.md");
		const removed = withDiffLines.find((line) => line.includes("-1 before"));
		const added = withDiffLines.find((line) => line.includes("+1 after"));
		expect(removed?.startsWith(" ".repeat(textColumn))).toBe(true);
		expect(added?.startsWith(" ".repeat(textColumn))).toBe(true);

		component.setEditDiffsExpanded(false);
		const collapsedAgain = stripAnsi(component.render(120).join("\n"));
		expect(collapsedAgain).not.toContain("-1 before");
		expect(collapsedAgain).toContain("+1 -1");
	});

	test("suppresses the built-in edit summary and diff when execution fails", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-failed-"));
		try {
			const filePath = join(dir, "sample.txt");
			await writeFile(filePath, "before\n", "utf8");
			const component = new ToolExecutionComponent(
				"edit",
				"tool-4err",
				{ path: filePath, edits: [{ oldText: "before", newText: "after" }] },

				{},
				createEditToolDefinition(dir),
				createFakeTui(),
				dir,
			);

			component.setEditDiffsExpanded(true);
			const deadline = Date.now() + 2000;
			while (Date.now() < deadline && !stripAnsi(component.render(120).join("\n")).includes("+1 -1")) {
				component.setArgsComplete();
				await new Promise((resolve) => setTimeout(resolve, 5));
			}
			expect(stripAnsi(component.render(120).join("\n"))).toContain("+1 -1");

			component.updateResult(
				{ content: [{ type: "text", text: "Could not edit file: sample.txt." }], isError: true },
				false,
			);
			const rendered = stripAnsi(component.render(120).join("\n"));
			expect(rendered).not.toContain("╰─");
			expect(rendered).not.toContain("+1 -1");
			expect(rendered).not.toContain("-1 before");
			expect(rendered).not.toContain("+1 after");

			// The header must switch to the error background even though the
			// async preview itself succeeded before execution failed.
			const rawRendered = component.render(120).join("\n");
			expect(rawRendered).toContain(theme.bg("toolErrorBg", "").slice(0, -"\x1b[49m".length));
			expect(rawRendered).not.toContain(theme.bg("toolSuccessBg", "").slice(0, -"\x1b[49m".length));
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("built-in edit summary truncates a long path to one row and keeps counts and hint", () => {
		const longPath = "deeply/nested/directory/structure/with/a/really/long/file-name-that-overflows.md";
		const component = new ToolExecutionComponent(
			"edit",
			"tool-4f",
			{ path: longPath, oldText: "before", newText: "after" },
			{},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [], details: { diff: "-1 before\n+1 after", firstChangedLine: 1 }, isError: false },
			false,
		);
		const lines = stripAnsi(component.render(40).join("\n")).split("\n");
		const summaryLines = lines.filter((line) => line.includes("╰─"));
		expect(summaryLines.length).toBe(1);
		expect(summaryLines[0]).toContain("…");
		expect(summaryLines[0]).toContain("+1 -1");
		expect(summaryLines[0]).toContain("to expand");
		for (const line of lines) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
	});

	test("built-in edit diff rows keep the summary text column when a diff line wraps", () => {
		const component = new ToolExecutionComponent(
			"edit",
			"tool-4g",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const longLine =
			"alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau";
		component.updateResult(
			{ content: [], details: { diff: `+1 ${longLine}`, firstChangedLine: 1 }, isError: false },
			false,
		);
		component.setEditDiffsExpanded(true);
		const lines = stripAnsi(component.render(60).join("\n")).split("\n");
		const summaryIndex = lines.findIndex((line) => line.includes("╰─ README.md"));
		expect(summaryIndex).toBeGreaterThanOrEqual(0);
		const textColumn = lines[summaryIndex].indexOf("README.md");
		const diffRows: string[] = [];
		for (let i = summaryIndex + 1; i < lines.length && lines[i].trim() !== ""; i++) {
			diffRows.push(lines[i]);
		}
		// The single logical diff line wraps; every continuation row stays anchored at the text column.
		expect(diffRows.length).toBeGreaterThan(1);
		for (const row of diffRows) {
			expect(row.startsWith(" ".repeat(textColumn))).toBe(true);
			expect(row[textColumn]).not.toBe(" ");
		}
		expect(diffRows.join(" ")).toContain("tau");
	});

	test("renders exactly one ctrl+j hint before and after the result lands", async () => {
		const dir = mkdtempSync(join(tmpdir(), "edit-hint-"));
		const filePath = join(dir, "sample.txt");
		writeFileSync(filePath, "before\n");
		try {
			const component = new ToolExecutionComponent(
				"edit",
				"tool-4h",
				{ path: filePath, oldText: "before", newText: "after" },
				{},
				createEditToolDefinition(dir),
				createFakeTui(),
				dir,
			);
			component.setArgsComplete();
			component.render(120);
			// The preview computes asynchronously; poll until it lands.
			await vi.waitFor(() => {
				expect(stripAnsi(component.render(120).join("\n"))).toContain("to expand");
			});
			// Pre-result: the preview's summary line already carries the hint.
			const preResult = stripAnsi(component.render(120).join("\n"));
			expect(preResult.split("\n").find((line) => line.includes("╰─"))).toContain("to expand");
			expect(preResult.split("to expand").length - 1).toBe(1);

			// A successful result keeps a single hint on the summary line.
			component.updateResult(
				{ content: [], details: { diff: "-1 before\n+1 after", firstChangedLine: 1 }, isError: false },
				false,
			);
			const settled = stripAnsi(component.render(120).join("\n"));
			expect(settled.split("\n").find((line) => line.includes("╰─"))).toContain("to expand");
			expect(settled.split("to expand").length - 1).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("uses the generic result fallback for legacy-named custom tools", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("bash"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"bash",
			"tool-4b",
			{ command: "echo hello" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("does not apply legacy replay call renderers to custom result renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("bash"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"bash",
			"tool-4c",
			{ command: "echo hello" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("echo hello");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createBashToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-4d",
			{ command: "echo hello" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("bash echo hello");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createBashTool(process.cwd());
		const component = new ToolExecutionComponent(
			"bash",
			"tool-4e",
			{ command: "echo hello" },
			{},
			{
				...createBaseToolDefinition("bash"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("renders default-shell tools in a rail panel with a labeled status header", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-7",
			{ command: "echo hello" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const queuedLines = component.render(100);
		expect(stripAnsi(queuedLines.join("\n"))).toContain("bash · queued");
		expect(stripAnsi(queuedLines[0])).toContain("bash · queued");

		component.markExecutionStarted();
		// Running status leads with the animated working glyph for the current frame.
		expect(stripAnsi(component.render(100).join("\n"))).toContain(
			`bash · ${workingIconFrame(getWorkingPulseFrame())} running`,
		);

		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const lines = component.render(100);
		const rendered = stripAnsi(lines.join("\n"));
		expect(rendered).toContain("bash · done");
		expect(rendered).toContain("$ echo hello");
		expect(rendered).toContain("hello");

		// Panel lines carry the neutral panel background across the full width.
		const panelLines = lines.filter((line) => line.includes("\x1b[48;"));
		expect(panelLines.length).toBeGreaterThan(0);
		for (const line of panelLines) {
			expect(line.startsWith("\x1b[48;")).toBe(true);
			expect(line.endsWith("\x1b[49m")).toBe(true);
		}
	});

	test("shows the error status in the rail panel header", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-8",
			{ command: "false" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult(
			{ content: [{ type: "text", text: "Command exited with code 1" }], details: undefined, isError: true },
			false,
		);
		const rendered = stripAnsi(component.render(100).join("\n"));
		expect(rendered).toContain("bash · error");
	});

	test("falls back when custom renderers are absent", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom_tool");
		expect(rendered).toContain("done");
	});
	test("does not add built-in edit stats to custom IPython renderers", () => {
		const component = new ToolExecutionComponent(
			"ipython",
			"custom-ipython",
			{},
			{},
			{
				...createBaseToolDefinition("ipython"),
				renderCall: () => new Text("custom ipython", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({
			content: [],
			details: { diffs: [{ path: "README.md", oldStr: "before", newStr: "after" }] },
			isError: false,
		});

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom ipython");
		expect(rendered).not.toContain("README.md +1 -1");
	});

	test("globally expands built-in IPython source associated with diffs", () => {
		const component = new ToolExecutionComponent(
			"ipython",
			"tool-ipython-edit",
			{
				code: 'hidden_side_effect = "only in full source"\nawait edit(path="README.md", old_str="before", new_str="after")',
			},
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.setArgsComplete();
		component.updateResult(
			{
				content: [],
				details: {
					status: "ok",
					diffs: [{ path: "README.md", oldStr: "before", newStr: "after", startLine: 1 }],
				},
				isError: false,
			},
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).not.toContain("hidden_side_effect");
		expect(collapsed).toContain("╰─ README.md +1 -1");
		expect(collapsed).not.toMatch(/1 - before/);
		expect(collapsed).not.toMatch(/1 \+ after/);

		// Tool expansion shows the full source but never the diff; that belongs to ctrl+j.
		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain('hidden_side_effect = "only in full source"');
		expect(expanded).toContain("╰─ README.md +1 -1");
		expect(expanded).not.toMatch(/1 - before/);

		component.setEditDiffsExpanded(true);
		const withDiffs = stripAnsi(component.render(120).join("\n"));
		const withDiffLines = withDiffs.split("\n");
		expect(withDiffLines.findIndex((line) => line.includes("hidden_side_effect ="))).toBeLessThan(
			withDiffLines.findIndex((line) => line.includes("╰─ README.md +1 -1")),
		);
		// Exactly one summary line — the cell owns the block; no extra component doubles it.
		expect(withDiffLines.filter((line) => line.includes("╰─ README.md +1 -1")).length).toBe(1);
		expect(withDiffs).toMatch(/1 - before/);
		expect(withDiffs).toMatch(/1 \+ after/);
	});
});
