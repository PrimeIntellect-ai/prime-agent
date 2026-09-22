import assert from "node:assert";
import { describe, it } from "node:test";
import {
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeKitty,
	isImageLine,
} from "../src/terminal-image.js";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"CMUX_WORKSPACE_ID",
] as const;

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("isImageLine", () => {
	// A 304k-char line regressed the detection regex into catastrophic backtracking.
	const LONG_LINE = `Text prefix \x1b]1337;File=size=800,600;inline=1:${"A".repeat(100).repeat(3000)} suffix`;

	const cases: Array<[name: string, line: string, expected: boolean]> = [
		["iTerm2 sequence surrounded by text", "Some text \x1b]1337;File=inline=1:base64data==\x07 more text", true],
		["Kitty sequence surrounded by text", "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\", true],
		["mixed Kitty and iTerm2 sequences", "\x1b_Ga=T...\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07", true],
		["304k-char line with an image sequence", LONG_LINE, true],
		["plain text", "This is just a regular text line without any escape sequences", false],
		["ANSI styling only", "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m", false],
		["iTerm2 marker without the escape byte", "Some text with ]1337;File but missing ESC at start", false],
		["Kitty marker without the escape byte", "Some text with _G but missing ESC at start", false],
		["file path containing the iTerm2 keyword", "/path/to/File_1337_backup/image.jpg", false],
		["empty line", "", false],
	];

	assert.ok(LONG_LINE.length > 300000);

	for (const [name, line, expected] of cases) {
		it(`${expected ? "detects" : "ignores"} ${name}`, () => {
			assert.strictEqual(isImageLine(line), expected);
		});
	}
});

describe("detectCapabilities", () => {
	const cases: Array<{
		name: string;
		env: Record<string, string | undefined>;
		hyperlinks: boolean;
		images?: string | null;
	}> = [
		{ name: "unknown terminal", env: {}, hyperlinks: false, images: null },
		{
			name: "tmux wrapping ghostty",
			env: { TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" },
			hyperlinks: false,
			images: null,
		},
		{
			name: "TERM=tmux-256color wrapping iTerm2",
			env: { TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" },
			hyperlinks: false,
			images: null,
		},
		{ name: "TERM=screen-256color", env: { TERM: "screen-256color" }, hyperlinks: false, images: null },
		{ name: "ghostty", env: { TERM_PROGRAM: "ghostty" }, hyperlinks: true, images: "kitty" },
		{
			name: "ghostty inside cmux",
			env: { TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" },
			hyperlinks: true,
			images: "kitty",
		},
		{ name: "kitty", env: { KITTY_WINDOW_ID: "1" }, hyperlinks: true },
		{ name: "wezterm", env: { WEZTERM_PANE: "0" }, hyperlinks: true },
		{ name: "iTerm2", env: { TERM_PROGRAM: "iterm.app" }, hyperlinks: true },
		{ name: "vscode", env: { TERM_PROGRAM: "vscode" }, hyperlinks: true },
	];

	for (const testCase of cases) {
		it(`reports capabilities for ${testCase.name}`, () => {
			withEnv(testCase.env, () => {
				const caps = detectCapabilities();
				assert.strictEqual(caps.hyperlinks, testCase.hyperlinks);
				if (testCase.images !== undefined) assert.strictEqual(caps.images, testCase.images);
			});
		});
	}
});

describe("Kitty protocol sequences", () => {
	it("encodes placements without cursor movement and suppresses replies on deletes", () => {
		assert.ok(
			encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false }).startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;"),
		);
		assert.strictEqual(deleteKittyImage(42), "\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		assert.strictEqual(deleteAllKittyImages(), "\x1b_Ga=d,d=A,q=2\x1b\\");
	});
});
