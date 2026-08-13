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
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Login to Anthropic");
		expect(output).toContain("Browser sign-in");
		expect(output).toContain("Sign-in link");
		expect(output).toContain("https://example.com/oauth?client_id=test");
		expect(output).toContain("C copy");
		expect(output).toContain("Next step");
		expect(output).toContain("Complete login in your browser.");
		expect(output).not.toContain("click to open");
		expect(output).not.toContain("─");
		expect(output).not.toContain("> ");
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

			expect(mocks.execFile).toHaveBeenCalledWith(command, [...prefixArgs, url], expect.any(Function));
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
		expect(output).toContain(firstLogoLine);
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

	it("keeps the Prime Inference brand header centered and within the panel", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "prime-inference", () => {}, "Prime Inference");

		dialog.showProgress("Checking existing Prime CLI credentials...");
		const lines = dialog.render(88);
		const output = stripAnsi(lines.join("\n"));
		const titleLine = output.split("\n").find((line) => line.includes("Login to Prime Inference"));
		const titleOffset = titleLine?.indexOf("Login to Prime Inference") ?? -1;

		expect(titleOffset).toBeGreaterThan(20);
		expect(output).toContain("Connect your Prime Intellect account to enable Prime Inference models.");
		expect(output).toContain("Preparing authentication");
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(88);
		}
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

	it("renders API key prompts without shell input markers", () => {
		const dialog = new LoginDialogComponent(createFakeTui(), "openai", () => {}, "OpenAI");

		void dialog.showPrompt("Enter API key:");
		const output = stripAnsi(dialog.render(88).join("\n"));

		expect(output).toContain("Login to OpenAI");
		expect(output).toContain("Enter API key:");
		expect(output).not.toContain("─");
		expect(output).not.toContain("> ");
	});
});
