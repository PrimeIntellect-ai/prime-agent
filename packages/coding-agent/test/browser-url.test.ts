import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("child_process", () => ({ execFile: mocks.execFile }));

import { openUrlInBrowser, sanitizeUrlForDisplay, validateBrowserUrl } from "../src/utils/browser-url.js";

describe("validateBrowserUrl", () => {
	it.each([
		"https://auth.example.org/authorize?x=1&state=abc",
		"http://localhost:53700/callback?code=1",
		"https://example.com/oauth?state=$(touch /tmp/pwned);whoami&pipe=|id",
	])("accepts the http(s) URL %s unchanged", (url) => {
		expect(validateBrowserUrl(url)).toBe(url);
	});

	it.each([
		["file URL", "file:///etc/passwd"],
		["javascript URL", "javascript:alert(1)"],
		["data URL", "data:text/html,hi"],
		["custom scheme", "ms-settings:windowsupdate"],
		["embedded credentials", "https://user:secret@example.com/"],
		["ESC in path", "https://x.test/\x1b]52;c;QUFB\x07"],
		["newline", "https://x.test/\npath"],
		["C1 control", "https://x.test/\u0085path"],
		["relative path", "/etc/passwd"],
		["not a URL", "open me"],
		["empty", ""],
		["over the length cap", `https://x.test/${"a".repeat(8200)}`],
	])("rejects %s", (_label, url) => {
		expect(validateBrowserUrl(url)).toBeUndefined();
	});
});

describe("sanitizeUrlForDisplay", () => {
	it("strips control characters and caps the length", () => {
		expect(sanitizeUrlForDisplay("https://x.test/\x1b]52;c;QUFB\x07end")).toBe("https://x.test/]52;c;QUFBend");
		expect(sanitizeUrlForDisplay(`https://x.test/${"a".repeat(600)}`)).toHaveLength(513);
	});
});

describe("openUrlInBrowser", () => {
	it("launches the platform opener only for validated URLs", () => {
		mocks.execFile.mockClear();
		expect(openUrlInBrowser("file:///etc/passwd")).toBe(false);
		expect(openUrlInBrowser("javascript:alert(1)")).toBe(false);
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(openUrlInBrowser("https://auth.example.org/authorize")).toBe(true);
		expect(mocks.execFile).toHaveBeenCalledTimes(1);
		expect(mocks.execFile.mock.calls[0]?.[1]).toContain("https://auth.example.org/authorize");
	});
});
