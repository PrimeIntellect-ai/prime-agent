import { clearDefaultTerminalColors, setDefaultTerminalColors, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, test } from "vitest";
import { styleArgumentTokens } from "../src/modes/interactive/components/prompt-highlight.js";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

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

	test("highlights flags and @path references in slash command arguments", () => {
		initTheme("dark");
		const rendered = new UserMessageComponent("/new --name foo @src/foo.ts", undefined, (name) => name === "new")
			.render(60)
			.join("\n");

		expect(rendered).toContain(theme.fg("accent", "/new"));
		expect(rendered).toContain(theme.fg("mdLink", "--name"));
		expect(rendered).toContain(theme.fg("success", "@src/foo.ts"));
	});

	test("highlights a bare -- separator only in recognized slash commands", () => {
		initTheme("dark");
		const recognized = (name: string) => name === "new";
		const command = new UserMessageComponent("/new --name bla -- hello", undefined, recognized).render(60).join("\n");
		const plain = new UserMessageComponent("this -- however -- is fine", undefined, recognized).render(60).join("\n");

		expect(command).toContain(theme.fg("mdLink", "--"));
		expect(plain).not.toContain(theme.fg("mdLink", "--"));
	});

	test("does not highlight --- or glued -- as a separator", () => {
		initTheme("dark");
		const recognized = (name: string) => name === "new";
		const triple = new UserMessageComponent("/new a --- b", undefined, recognized).render(60).join("\n");
		const glued = new UserMessageComponent("/new x-- y", undefined, recognized).render(60).join("\n");
		const plain = new UserMessageComponent("a --- b").render(60).join("\n");

		expect(triple).not.toContain(theme.fg("mdLink", "--"));
		expect(glued).not.toContain(theme.fg("mdLink", "--"));
		expect(plain).not.toContain(theme.fg("mdLink", "--"));
	});

	test("highlights @path references in plain user messages", () => {
		initTheme("dark");
		const rendered = new UserMessageComponent("check @src/foo.ts please").render(60).join("\n");

		expect(rendered).toContain(theme.fg("success", "@src/foo.ts"));
	});

	test("highlights leading and newline-leading @path references in plain user messages", () => {
		initTheme("dark");
		const leading = new UserMessageComponent("@src/foo.ts please").render(60).join("\n");
		const newline = new UserMessageComponent("hello\n@foo").render(60).join("\n");

		expect(leading).toContain(theme.fg("success", "@src/foo.ts"));
		expect(newline).toContain(theme.fg("success", "@foo"));
	});

	test("highlights every wrapped fragment of a long @path", () => {
		initTheme("dark");
		const rendered = new UserMessageComponent("check @src/very-long-file-name.ts please").render(16).join("\n");

		expect(rendered).toContain(theme.fg("success", "@src/very-lo"));
		expect(rendered).toContain(theme.fg("success", "ng-file-name"));
		expect(rendered).toContain(theme.fg("success", ".ts"));
	});

	test("keeps quoted @paths highlighted across narrow wraps", () => {
		initTheme("dark");
		const rendered = new UserMessageComponent('open @"docs/some very long name.txt" now').render(16).join("\n");

		expect(rendered).toContain(theme.fg("success", '@"docs/some '));
		expect(rendered).toContain(theme.fg("success", "very long na"));
		expect(rendered).toContain(theme.fg("success", 'me.txt"'));
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

	test("does not highlight @ or -- without a whitespace boundary", () => {
		initTheme("dark");
		const email = new UserMessageComponent("email me@example.com").render(60).join("\n");
		const dashes = new UserMessageComponent("a---b").render(60).join("\n");

		expect(email).not.toContain(theme.fg("success", "@example.com"));
		expect(dashes).not.toContain(theme.fg("mdLink", "--b"));
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

	test("renders a literal mask-range character before an @token uncorrupted", () => {
		initTheme("dark");
		const plain = new UserMessageComponent("\uE000 check @foo")
			.render(60)
			.map((line) => line.replace(/\x1b\[[0-9;]*m|\x1b\]133;[ABC]\x07/g, ""))
			.join("\n");

		expect(plain).toContain("\uE000 check @foo");
	});
});
