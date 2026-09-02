import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	spawnSync: vi.fn(),
}));

const __fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
vi.mock("node:fs", () => {
	mocks.existsSync.mockImplementation(__fs.existsSync);
	return { ...__fs, existsSync: mocks.existsSync };
});

const __childProcess = createRequire(import.meta.url)("child_process") as typeof import("child_process");
vi.mock("child_process", () => ({ ...__childProcess, spawnSync: mocks.spawnSync }));

import { getShellConfig, resolveKernelBashShell } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalProgramFiles = process.env.ProgramFiles;
const originalProgramFilesX86 = process.env["ProgramFiles(x86)"];

function stubWin32(): void {
	Object.defineProperty(process, "platform", { value: "win32" });
	// Keep realistic Windows environment values while platform behavior is stubbed.
	process.env.ProgramFiles = "C:\\Program Files";
	(process.env as Record<string, string>)["ProgramFiles(x86)"] = "C:\\Program Files (x86)";
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	if (originalProgramFiles === undefined) delete process.env.ProgramFiles;
	else process.env.ProgramFiles = originalProgramFiles;
	if (originalProgramFilesX86 === undefined) delete process.env["ProgramFiles(x86)"];
	else process.env["ProgramFiles(x86)"] = originalProgramFilesX86;
	mocks.existsSync.mockClear();
	mocks.spawnSync.mockClear();
});

describe("getShellConfig on win32", () => {
	it("returns canonical 64-bit Git Bash when installed", () => {
		stubWin32();
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === gitBash);

		const config = getShellConfig();
		expect(config.shell).toBe(gitBash);
		expect(config.args).toEqual(["-c"]);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns canonical 32-bit Git Bash when the 64-bit path is absent", () => {
		stubWin32();
		const gitBash86 = "C:\\Program Files (x86)\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === gitBash86);

		const config = getShellConfig();
		expect(config.shell).toBe(gitBash86);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("never searches PATH for Cygwin, MSYS2, or WSL bash", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);
		// Even if 'where bash.exe' would find something on PATH, findBashOnPath
		// returns null on win32 — only canonical Git Bash paths are accepted.
		mocks.spawnSync.mockReturnValue({
			status: 0,
			stdout: "C:\\cygwin64\\bin\\bash.exe",
			stderr: "",
			error: undefined,
			pid: 0,
			output: ["", "C:\\cygwin64\\bin\\bash.exe", ""],
			signal: null,
		});

		expect(() => getShellConfig()).toThrow(/Git Bash not found/);
	});

	it("throws actionable error containing Git for Windows URL and shellPath guidance", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		try {
			getShellConfig();
			expect.fail("should have thrown");
		} catch (e) {
			const msg = (e as Error).message;
			expect(msg).toContain("Git Bash not found");
			expect(msg).toContain("https://git-scm.com/download/win");
			expect(msg).toContain("Set shellPath in settings.json");
			expect(msg).toContain("Searched:");
			// Must not reference Cygwin, MSYS2, or WSL
			expect(msg).not.toContain("Cygwin");
			expect(msg).not.toContain("MSYS2");
			expect(msg).not.toContain("WSL");
		}
	});

	it("returns explicit shellPath without PATH search", () => {
		stubWin32();
		mocks.existsSync.mockImplementation((path: string) => path === "D:\\tools\\bash.exe");

		const config = getShellConfig("D:\\tools\\bash.exe");
		expect(config.shell).toBe("D:\\tools\\bash.exe");
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("rejects non-existent explicit shellPath", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(() => getShellConfig("D:\\missing\\bash.exe")).toThrow(
			"Custom shell path not found: D:\\missing\\bash.exe",
		);
	});
});

describe("getShellConfig on non-win32", () => {
	it("returns /bin/bash when it exists", () => {
		mocks.existsSync.mockImplementation((path: string) => path === "/bin/bash");

		const config = getShellConfig();
		expect(config.shell).toBe("/bin/bash");
		expect(config.args).toEqual(["-c"]);
	});

	it("falls back to sh when /bin/bash and which bash are absent", () => {
		mocks.existsSync.mockReturnValue(false);
		mocks.spawnSync.mockReturnValue({
			status: 1,
			stdout: "",
			stderr: "",
			error: undefined,
			pid: 0,
			output: ["", "", ""],
			signal: null,
		});

		const config = getShellConfig();
		expect(config.shell).toBe("sh");
	});

	it("uses bash on PATH when /bin/bash is absent", () => {
		mocks.existsSync.mockReturnValue(false);
		mocks.spawnSync.mockReturnValue({
			status: 0,
			stdout: "/usr/local/bin/bash",
			stderr: "",
			error: undefined,
			pid: 0,
			output: ["", "/usr/local/bin/bash", ""],
			signal: null,
		});

		const config = getShellConfig();
		expect(config.shell).toBe("/usr/local/bin/bash");
	});
});

describe("resolveKernelBashShell", () => {
	it("returns explicit shellPath as-is on any platform", () => {
		mocks.existsSync.mockReturnValue(false);
		expect(resolveKernelBashShell("D:\\custom\\bash.exe")).toBe("D:\\custom\\bash.exe");
	});

	it("returns undefined on win32 when no Git Bash is installed", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);
		expect(resolveKernelBashShell()).toBeUndefined();
	});

	it("returns canonical Git Bash path on win32 when present", () => {
		stubWin32();
		const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === gitBash);
		expect(resolveKernelBashShell()).toBe(gitBash);
	});
});
