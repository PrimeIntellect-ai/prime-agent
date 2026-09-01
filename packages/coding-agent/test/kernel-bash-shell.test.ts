import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	existsSync: vi.fn(),
	spawnSync: vi.fn(),
}));

const __fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
vi.mock("node:fs", () => {
	// Module-load reads (config.ts) must see the real fs; tests override per case.
	mocks.existsSync.mockImplementation(__fs.existsSync);
	return { ...__fs, existsSync: mocks.existsSync };
});

const __childProcess = createRequire(import.meta.url)("child_process") as typeof import("child_process");
vi.mock("child_process", () => ({ ...__childProcess, spawnSync: mocks.spawnSync }));

import { resolveKernelBashShell } from "../src/utils/shell.js";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

function stubWin32(): void {
	Object.defineProperty(process, "platform", { value: "win32" });
}

afterEach(() => {
	if (originalPlatform) {
		Object.defineProperty(process, "platform", originalPlatform);
	}
	mocks.existsSync.mockClear();
	mocks.spawnSync.mockClear();
});

describe("resolveKernelBashShell on win32", () => {
	it("returns undefined without consulting PATH when no Git Bash is installed", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell()).toBeUndefined();
		// The old fallback shelled out to `where bash.exe`; a repo-controlled
		// PATH/where.exe must never pick the kernel shell.
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns the canonical Git Bash install path when present", () => {
		stubWin32();
		const canonical = "C:\\Program Files\\Git\\bin\\bash.exe";
		mocks.existsSync.mockImplementation((path: string) => path === canonical);

		expect(resolveKernelBashShell()).toBe(canonical);
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	it("returns an explicit shellPath as-is", () => {
		stubWin32();
		mocks.existsSync.mockReturnValue(false);

		expect(resolveKernelBashShell("D:\\tools\\bash.exe")).toBe("D:\\tools\\bash.exe");
		expect(mocks.existsSync).not.toHaveBeenCalled();
	});
});
