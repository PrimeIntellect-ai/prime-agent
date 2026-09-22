import { beforeEach, describe, expect, it } from "vitest";
import { TopBar } from "../src/modes/interactive/components/top-bar.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeEach(() => {
	initTheme("dark");
});

const stripAnsi = (value: string): string => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("TopBar", () => {
	it("centers the chat name and trails the spend beside it", () => {
		const bar = new TopBar({ getChatName: () => "demo", getCostUsd: () => 1.42 });
		const [line] = bar.render(21);
		const plain = stripAnsi(line);
		expect(plain).toBe("        demo  $1.42");
	});

	it("renders only the name when no spend is known", () => {
		const bar = new TopBar({ getChatName: () => "demo", getCostUsd: () => undefined });
		const [line] = bar.render(21);
		expect(stripAnsi(line)).toBe("        demo");
	});

	it("collapses embedded newlines so the bar stays a single row", () => {
		const bar = new TopBar({ getChatName: () => "line1\nline2" });
		const lines = bar.render(21);
		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0])).toContain("line1 line2");
	});

	it("strips terminal escape sequences from the chat name", () => {
		const bar = new TopBar({ getChatName: () => "a\u001b[2Jb\u001b]0;title\u0007c" });
		const [line] = bar.render(30);
		const plain = stripAnsi(line);
		expect(plain).not.toContain("\u001b");
		expect(plain).not.toContain("\u0007");
		expect(plain).toContain("a [2Jb ]0;title c");
	});

	it("returns a blank line when the chat name is empty", () => {
		const bar = new TopBar({ getChatName: () => undefined });
		expect(bar.render(21)).toEqual([""]);
	});

	it("truncates to the terminal width", () => {
		const bar = new TopBar({ getChatName: () => "a-very-long-chat-name-that-overflows", getCostUsd: () => 9.99 });
		const [line] = bar.render(12);
		expect(stripAnsi(line).length).toBeLessThanOrEqual(12);
	});
});
