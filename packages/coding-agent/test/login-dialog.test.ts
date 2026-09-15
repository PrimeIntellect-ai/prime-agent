import {
	resetCapabilitiesCache,
	setCapabilities,
	setKeybindings,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { PRIME_BUTTERFLY_LOGO } from "../src/themes/prime-logo.js";

const mocks = vi.hoisted(() => ({
	copyToClipboard: vi.fn(),
	execFile: vi.fn(),
}));

vi.mock("child_process", () => ({
	execFile: mocks.execFile,
}));

vi.mock("../src/utils/clipboard.js", () => ({
	copyToClipboard: mocks.copyToClipboard,
}));

function createFakeTui(): TUI {
	return {
		requestRender: vi.fn(),
	} as unknown as TUI;
}

describe("LoginDialogComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		mocks.copyToClipboard.mockReset();
		mocks.copyToClipboard.mockResolvedValue(undefined);
		mocks.execFile.mockClear();
	});

	afterEach(() => {
		resetCapabilitiesCache();
	});

	it("renders browser login without legacy border chrome", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");

		dialog.showAuth("https://example.com/oauth?client_id=test", "Complete login in your browser.");
		const lines = dialog.render(88);
		const output = stripAnsi(lines.join("\n"));

		expect(output).toContain("Login to Anthropic");
		expect(output).toContain("https://example.com/oauth?client_id=test");
		expect(output).toContain("C copy");
		expect(output).toContain("Complete login in your browser.");
		expect(output).not.toContain("click to open");
		expect(output).not.toContain("> ");
		// The top rule separates the inline login section from the chat above;
		// no other borders surround the content.
		const ruleLines = lines.filter((line) => stripAnsi(line).includes("─"));
		expect(ruleLines).toHaveLength(1);
		expect(stripAnsi(lines[0] ?? "")).toBe("─".repeat(88));
	});

	it("copies the raw sign-in URL with the configured shortcut", async () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");
		const url = "https://example.com/oauth?client_id=test&redirect_uri=https%3A%2F%2Flocalhost%2Fcallback";

		dialog.showAuth(url);
		dialog.handleInput("c");

		await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(url));
		expect(stripAnsi(dialog.render(48).join("\n"))).toContain("Copied sign-in link");
	});

	it("honors a customized login URL copy shortcut", async () => {
		setKeybindings(new KeybindingsManager({ "app.clipboard.copyLoginUrl": "ctrl+y" }));
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");
		const url = "https://example.com/oauth";

		dialog.showAuth(url);
		expect(stripAnsi(dialog.render(88).join("\n"))).toContain("Ctrl+Y copy");
		dialog.handleInput("c");
		expect(mocks.copyToClipboard).not.toHaveBeenCalled();

		dialog.handleInput("\x19");
		await vi.waitFor(() => expect(mocks.copyToClipboard).toHaveBeenCalledWith(url));
	});

	it.each([
		["darwin", []],
		["linux", []],
		["win32", ["url.dll,FileProtocolHandler"]],
	] as const)("passes hostile URLs as a single argument on %s", (platform, prefixArgs) => {
		const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
		try {
			const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");
			const url = "https://example.com/oauth?state=$(touch /tmp/pwned);whoami&pipe=|id";
			const command =
				platform === "darwin"
					? "open"
					: platform === "linux"
						? "xdg-open"
						: `${process.env.SystemRoot ?? String.raw`C:\Windows`}\\System32\\rundll32.exe`;

			dialog.showAuth(url);

			expect(mocks.execFile).toHaveBeenCalledWith(
				command,
				[...prefixArgs, url],
				{ windowsHide: true },
				expect.any(Function),
			);
		} finally {
			platformSpy.mockRestore();
		}
	});

	it("renders sign-in URLs as OSC 8 hyperlinks when supported", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");
		const url = "https://example.com/oauth?client_id=test";

		dialog.showAuth(url, "Complete login in your browser.");
		const rawOutput = dialog.render(88).join("\n");

		expect(rawOutput).toContain(`\x1b]8;;${url}\x07`);
		expect(rawOutput).toContain("\x1b]8;;\x07");
		expect(stripAnsi(rawOutput)).toContain(url);
	});

	it("renders plain sign-in URLs when OSC 8 hyperlinks are unsupported", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");
		const url = "https://example.com/oauth?client_id=test";

		dialog.showAuth(url, "Complete login in your browser.");
		const rawOutput = dialog.render(88).join("\n");

		expect(rawOutput).not.toContain("\x1b]8;;");
		expect(stripAnsi(rawOutput)).toContain(url);
	});

	it("renders verification codes as a distinct field", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");

		dialog.showAuth("https://example.com/challenge", "Code: abc-123");
		const output = stripAnsi(dialog.render(88).join("\n"));
		const firstLogoLine = PRIME_BUTTERFLY_LOGO.split("\n")[0]?.trim() ?? "";

		expect(output).toContain("Login to Prime Inference");
		// The compact inline panel never renders the butterfly logo.
		expect(firstLogoLine).not.toBe("");
		expect(output).not.toContain(firstLogoLine);
		expect(output).toContain("Verification code");
		expect(output).toContain("abc-123");
		expect(output).not.toContain("click to open");
		expect(output).not.toContain("Code: abc-123");
	});

	it("renders Prime Inference waiting status without an extra label", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");

		dialog.showAuth("https://example.com/challenge", "Code: abc-123");
		dialog.showWaiting("Waiting for browser authentication...");
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Waiting for browser authentication...");
		expect(output).not.toContain("Status");
	});

	it("renders the Prime Inference login with the compact inline header", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");

		dialog.showProgress("Checking existing Prime CLI credentials...");
		const lines = dialog.render(88);
		const output = stripAnsi(lines.join("\n"));
		const titleLine = output.split("\n").find((line) => line.includes("Login to Prime Inference"));
		const titleOffset = titleLine?.indexOf("Login to Prime Inference") ?? -1;

		// The title leads the inline panel.
		expect(titleOffset).toBe(1);
		expect(output).not.toContain("Connect your Prime Intellect account to enable Prime Inference models.");
		expect(output).toContain("Preparing authentication");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(88);
		}
	});

	it("keeps one blank row above the key hints across repeated prompts", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");
		dialog.showPrompt("Enter API key:");
		const first = dialog.render(80).length;
		dialog.showPrompt("Enter API key:");

		// The second prompt adds its own separator and title, and moves the blank
		// row above the key hints instead of stacking another one.
		expect(dialog.render(80).length - first).toBe(2);
	});

	it("quits the app from ctrl+c only while onboarding passes onExit", () => {
		const dialog = new LoginDialogComponent(
			createFakeTui(),
			"prime-inference",
			() => {},
			"Prime Inference",
			undefined,
			{ onExit: () => onExitCalls.push("exit") },
		);
		const onExitCalls: string[] = [];

		dialog.handleInput("\x03");

		expect(onExitCalls).toEqual(["exit"]);

		const plain = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");
		const prompt = plain.showPrompt("Enter API key:");
		plain.handleInput("\x03");
		// Outside onboarding, ctrl+c keeps cancelling the prompt.
		expect(() => prompt).rejects.toThrow("Login cancelled");
	});

	it("cancels the prompt with esc and ctrl+c", async () => {
		for (const key of ["\x1b", "\x03"]) {
			const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");
			const prompt = dialog.showPrompt("Enter API key:");
			dialog.handleInput(key);
			await expect(prompt).rejects.toThrow("Login cancelled");
		}
	});

	it("re-arms manual input after an empty submission", async () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");
		dialog.showAuth("https://example.com/challenge", "Code: abc-123");

		const first = dialog.showManualInput("Or paste an API key below:");
		dialog.handleInput("\r");
		await expect(first).resolves.toBe("");

		const second = dialog.waitForInput();
		dialog.handleInput("p");
		dialog.handleInput("k");
		dialog.handleInput("\r");
		await expect(second).resolves.toBe("pk");
	});

	it("renders API key prompts with the bordered inline input", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "openai", () => {}, "OpenAI");

		void dialog.showPrompt("Enter API key:");
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Login to OpenAI");
		expect(output).toContain("Enter API key:");
		// The paste field matches the inline picker search box.
		expect(output).toContain("─");
		expect(output).toContain("Paste value");
		// One key-hint line carries submit and cancel.
		expect(output).toContain("Enter submit");
		expect(output).toContain("Esc/Ctrl+C cancel");
	});

	it("keeps the key-hint row last while waiting and polling", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "github-copilot", () => {}, "GitHub Copilot");

		dialog.showAuth("https://example.com/device");
		dialog.showWaiting("Waiting for browser authentication...");
		let rows = stripAnsi(dialog.render(88).join("\n"))
			.split("\n")
			.filter((line) => line.trim().length > 0);

		expect(rows.at(-1)).toContain("cancel");
		expect(rows.at(-1)).toContain("copy");
		expect(rows.at(-2)).toContain("Waiting for browser authentication...");

		dialog.showProgress("Waiting for browser sign-in...");
		rows = stripAnsi(dialog.render(88).join("\n"))
			.split("\n")
			.filter((line) => line.trim().length > 0);

		expect(rows.at(-1)).toContain("cancel");
		expect(rows.at(-2)).toContain("Waiting for browser sign-in...");
		expect(rows.at(-3)).toContain("Waiting for browser authentication...");
	});

	it("wraps long sign-in URLs into per-line hyperlinks with the full url", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const dialog = new LoginDialogComponent(createFakeTui(), "anthropic", () => {}, "Anthropic");
		const url = "https://example.com/oauth/authorize?client_id=test-client-123456&response_type=code&scope=openid";

		dialog.showAuth(url);
		const lines = dialog.render(40);
		const urlLines = lines.filter((line) => line.includes("\x1b]8;;"));

		// The wrapped URL keeps its hyperlink on every line: each segment re-opens
		// with the full url and closes again, so any line opens the whole link.
		expect(urlLines.length).toBeGreaterThan(1);
		for (const line of urlLines) {
			expect(line).toContain(`\x1b]8;;${url}\x07`);
			expect(line).toContain("\x1b]8;;\x07");
			expect(visibleWidth(line)).toBe(40);
		}
		const visibleUrl = urlLines.map((line) => stripAnsi(line).trim()).join("");
		expect(visibleUrl).toContain(url);
	});
});
