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

	it("leads the line with the speed readout, keeping the name and spend on that row", () => {
		const bar = new TopBar({
			getChatName: () => "demo",
			getCostUsd: () => 1.42,
			getSpeedText: () => "120 tok/s · avg 88.9",
		});
		const [line] = bar.render(60);
		expect(stripAnsi(line)).toBe(`120 tok/s · avg 88.9${" ".repeat(8)}demo  $1.42`);
	});

	it("keeps the name clear of the speed readout on narrow terminals", () => {
		const bar = new TopBar({
			getChatName: () => "demo",
			getCostUsd: () => undefined,
			getSpeedText: () => "long-name-speed",
		});
		expect(stripAnsi(bar.render(24)[0])).toBe(`long-name-speed  demo`);
	});

	it("renders the plain name and spend when the speed readout is off", () => {
		const bar = new TopBar({
			getChatName: () => "demo",
			getCostUsd: () => 1.42,
			getSpeedText: () => undefined,
		});
		expect(stripAnsi(bar.render(21)[0])).toBe("        demo  $1.42");
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

	it("still shows the speed readout when the chat name is empty", () => {
		// A session launched from a path with no basename (POSIX `/`) has no name;
		// the readout must not disappear with it.
		const bar = new TopBar({
			getChatName: () => undefined,
			getCostUsd: () => 1.42,
			getSpeedText: () => "120 tok/s · avg 88.9",
		});
		expect(stripAnsi(bar.render(40)[0])).toBe("120 tok/s · avg 88.9");
	});

	it("truncates to the terminal width", () => {
		const bar = new TopBar({ getChatName: () => "a-very-long-chat-name-that-overflows", getCostUsd: () => 9.99 });
		const [line] = bar.render(12);
		expect(stripAnsi(line).length).toBeLessThanOrEqual(12);
	});
});
