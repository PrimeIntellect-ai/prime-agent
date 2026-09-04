import { clearDefaultTerminalColors, setDefaultTerminalColors, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { styleArgumentTokens } from "../src/modes/interactive/components/prompt-highlight.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme, type ThemeColor, theme } from "../src/modes/interactive/theme/theme.js";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	afterEach(() => {
		clearDefaultTerminalColors();
	});

	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		setDefaultTerminalColors({
			foreground: { r: 255, g: 255, b: 255 },
			background: { r: 0, g: 0, b: 0 },
		});
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("uses the themed message background when terminal background is unknown", () => {
		clearDefaultTerminalColors();
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("colors only recognized leading slash commands", () => {
		clearDefaultTerminalColors();
		initTheme("dark");
		const recognized = (name: string) => name === "compact";

		const command = new UserMessageComponent("/compact focus on **errors**", undefined, recognized)
			.render(40)
			.join("\n");
		const unknown = new UserMessageComponent("/unknown focus here", undefined, recognized).render(40).join("\n");
		const embedded = new UserMessageComponent("Explain /compact", undefined, recognized).render(40).join("\n");

		expect(command).toContain(theme.fg("accent", "/compact"));
		expect(command).not.toContain("**errors**");
		expect(command).not.toBe(unknown);
		expect(unknown).not.toContain(theme.fg("accent", "/unknown"));
		expect(embedded).not.toContain(theme.fg("accent", "/compact"));
	});

	test.each([
		{
			name: "wide and multi-code-point command graphemes",
			message: "/命é令 arg **bold**",
			commandName: "命é令",
			expectedLines: ["", "/命é", "令", "arg", "bold", ""],
		},
		{
			name: "width-three command graphemes atomically",
			message: "/界ﾞx arg",
			commandName: "界ﾞx",
			expectedLines: ["", "/界ﾞ", "x", "arg", ""],
		},
	])("wraps $name at terminal width", ({ message, commandName, expectedLines }) => {
		initTheme("dark");
		const lines = new UserMessageComponent(message, undefined, (name) => name === commandName).render(8);
		const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]133;[ABC]\x07/g, "").trim());

		expect(lines.every((line) => visibleWidth(line) === 8)).toBe(true);
		expect(plainLines).toEqual(expectedLines);
	});

	const renderMessage = (text: string, width = 60, recognized: (name: string) => boolean = () => false) => {
		initTheme("dark");
		return new UserMessageComponent(text, undefined, recognized).render(width).join("\n");
	};

	const commandText = "/new --name foo @src/foo.ts";

	test.each<{ name: string; text: string; width?: number; color: ThemeColor; has?: string[]; lacks?: string[] }>([
		{ name: "the command accent", text: commandText, color: "accent", has: ["/new"] },
		{ name: "--flags in command arguments", text: commandText, color: "mdLink", has: ["--name"] },
		{ name: "@paths in command arguments", text: commandText, color: "success", has: ["@src/foo.ts"] },
		{ name: "@paths in plain messages", text: "check @src/foo.ts please", color: "success", has: ["@src/foo.ts"] },
		{ name: "a leading @path", text: "@src/foo.ts please", color: "success", has: ["@src/foo.ts"] },
		{ name: "a newline-leading @path", text: "hello\n@foo", color: "success", has: ["@foo"] },
		{
			name: "every wrapped fragment of a long @path",
			text: "check @src/very-long-file-name.ts please",
			width: 16,
			color: "success",
			has: ["@src/very-lo", "ng-file-name", ".ts"],
		},
		{
			name: "quoted @paths across narrow wraps",
			text: 'open @"docs/some very long name.txt" now',
			width: 16,
			color: "success",
			has: ['@"docs/some ', "very long na", 'me.txt"'],
		},
		{ name: "no mid-word @ (emails)", text: "email me@example.com", color: "success", lacks: ["@example.com"] },
		{ name: "no glued dashes", text: "a---b", color: "mdLink", lacks: ["--b"] },
	])("styles tokens: $name", ({ text, width, color, has, lacks }) => {
		const rendered = renderMessage(text, width, (name) => name === "new");

		for (const fragment of has ?? []) expect(rendered).toContain(theme.fg(color, fragment));
		for (const fragment of lacks ?? []) expect(rendered).not.toContain(theme.fg(color, fragment));
	});

	test("highlights a bare -- separator only in argument-taking slash commands", () => {
		const recognized = (name: string) => name === "new" || name === "compact";
		const separator = theme.fg("mdLink", "--");

		expect(renderMessage("/new --name bla -- hello", 60, recognized)).toContain(separator);
		// /compact is recognized but takes no argument, so it must match the editor and show no separator.
		const unhighlighted = [
			"/compact -- hello",
			"this -- however -- is fine",
			"/new a --- b",
			"/new x-- y",
			"a --- b",
		];
		for (const text of unhighlighted) expect(renderMessage(text, 60, recognized)).not.toContain(separator);
	});

	test("keeps multi-line quoted @paths on separate lines", () => {
		initTheme("dark");
		const lines = new UserMessageComponent('@"a\nb"').render(60);
		const plain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]133;[ABC]\x07/g, ""));
		const content = plain.map((line) => line.trim()).filter((line) => line.length > 0);

		expect(lines.every((line) => !line.includes("\n"))).toBe(true);
		expect(content).toEqual(['@"a', 'b"']);
		expect(lines.join("\n")).toContain(theme.fg("success", '@"a'));
	});

	test("normalizes tabs inside quoted @paths like Markdown does", () => {
		initTheme("dark");
		const lines = new UserMessageComponent('open @"a\tb.txt" now').render(30);

		expect(lines.some((line) => line.includes("\t"))).toBe(false);
		expect(lines.join("\n")).toContain(theme.fg("success", '@"a   b.txt"'));
	});

	test("styleArgumentTokens highlights quoted @paths", () => {
		initTheme("dark");
		expect(styleArgumentTokens('open @"a b.txt" now')).toBe(`open ${theme.fg("success", '@"a b.txt"')} now`);
	});

	test("preserves mask-like argument text across narrow wraps", () => {
		initTheme("dark");
		const command = "/averyveryverylongcommand";
		const lines = new UserMessageComponent(
			`${command} 界\uE000`,
			undefined,
			(name) => name === command.slice(1),
		).render(8);
		const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m|\x1b\]133;[ABC]\x07/g, "");

		expect(plain.replace(/\s+/g, "")).toContain(`${command}界\uE000`);
		expect(lines.every((line) => visibleWidth(line) === 8)).toBe(true);
	});

	test("forwards table-cell selection regions with unmasked content", () => {
		initTheme("dark");
		const component = new UserMessageComponent("| alpha | beta |\n| --- | --- |\n| @src/a.ts | two |");
		component.render(60);

		const contents = component.getSelectionRegions().map((region) => region.content);

		// Copying the token cell must yield its literal text, not mask placeholders.
		expect(contents).toContain("@src/a.ts");
		expect(contents).toContain("two");
	});

	test("renders a literal mask-range character before an @token uncorrupted", () => {
		initTheme("dark");
		const plain = new UserMessageComponent("\uE000 check @foo")
			.render(60)
			.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]133;[ABC]\x07/g, ""))
			.join("\n");

		expect(plain).toContain("\uE000 check @foo");
	});
});
