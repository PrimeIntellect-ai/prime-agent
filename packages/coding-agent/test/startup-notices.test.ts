import { beforeAll, describe, expect, test } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { formatTmuxWarningNotice } from "../src/modes/shared/startup-notices.js";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

describe("startup notice formatters", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("tmux warning notice is prefixed with the warning glyph", () => {
		const output = stripAnsi(formatTmuxWarningNotice("tmux extended-keys is off."));
		expect(output).toBe("⚠ tmux extended-keys is off.");
	});
});
