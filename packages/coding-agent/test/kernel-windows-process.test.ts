import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { acquireBootstrapLock, ensureKernelPython } from "../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";

const actualFs = { ...fsPromises };
const actualSpawn = childProcess.spawn;
const rename = vi.fn(actualFs.rename);
const spawn = vi.fn(actualSpawn);
vi.mock("node:fs/promises", () => ({ ...actualFs, rename }));
vi.mock("node:child_process", () => ({ ...childProcess, spawn }));

const originalPlatform = process.platform;
let root = "";
let originalEnv: NodeJS.ProcessEnv;
let restoreClock = () => {};

beforeEach(() => {
	root = mkdtempSync(join(os.tmpdir(), "prime-kernel-windows-"));
	originalEnv = { ...process.env };
	rename.mockReset().mockImplementation(actualFs.rename);
	spawn.mockReset().mockImplementation(actualSpawn);
	Object.defineProperty(process, "platform", { value: "win32" });
});

afterEach(() => {
	restoreClock();
	restoreClock = () => {};
	Object.defineProperty(process, "platform", { value: originalPlatform });
	process.env = originalEnv;
	rename.mockReset().mockImplementation(actualFs.rename);
	spawn.mockReset().mockImplementation(actualSpawn);
	rmSync(root, { recursive: true, force: true });
});

describe("Windows bootstrap rename recovery", () => {
	test.each(["acquire", "reclaim", "release"] as const)("retries sharing violations during %s", async (phase) => {
		const venv = join(root, "venv");
		const lockDir = `${venv}.bootstrap.lock`;
		if (phase === "reclaim") {
			mkdirSync(lockDir);
			const old = new Date(Date.now() - 60_000);
			utimesSync(lockDir, old, old);
		}
		const errors = ["EBUSY", "EPERM", "EACCES"];
		let failures = 0;
		rename.mockImplementation(async (source, target) => {
			const matches =
				phase === "acquire"
					? String(target) === lockDir
					: String(target).includes(`.${phase === "reclaim" ? "stale" : "released"}-`);
			if (matches && failures < errors.length) {
				throw Object.assign(new Error("held source handle"), { code: errors[failures++] });
			}
			return actualFs.rename(source, target);
		});

		const release = await acquireBootstrapLock(venv);
		try {
			expect(readFileSync(join(lockDir, "pid"), "utf8").trim()).toBe(String(process.pid));
		} finally {
			await release();
		}
		expect(failures).toBe(3);
		expect(readdirSync(root)).toEqual([]);
	});

	test("bounds persistent sharing failures and removes only its candidate", async () => {
		const venv = join(root, "venv");
		const denied = Object.assign(new Error("permission denied"), { code: "EPERM" });
		let attempts = 0;
		rename.mockImplementation(async () => {
			if (++attempts === 2) {
				const expired = Date.now() + 20_000;
				const clock = vi.spyOn(Date, "now").mockReturnValue(expired);
				restoreClock = () => clock.mockRestore();
			}
			throw denied;
		});
		await expect(acquireBootstrapLock(venv)).rejects.toBe(denied);
		expect(attempts).toBe(2);
		expect(readdirSync(root)).toEqual([]);
	});

	test.each([
		["win32", "EIO"],
		["linux", "EACCES"],
	] as const)("does not retry %s %s failures", async (platform, code) => {
		Object.defineProperty(process, "platform", { value: platform });
		const failure = Object.assign(new Error("rename failed"), { code });
		rename.mockRejectedValue(failure);
		await expect(acquireBootstrapLock(join(root, "venv"))).rejects.toBe(failure);
		expect(rename).toHaveBeenCalledTimes(1);
		expect(readdirSync(root)).toEqual([]);
	});
});

describe("Windows kernel subprocess visibility", () => {
	beforeEach(() => {
		spawn.mockImplementation(() => {
			throw new Error("spawn refused by test");
		});
	});

	test.each(["python.exe", "python.cmd"])("hides background bootstrap for %s", async (executable) => {
		process.env.PRIME_AGENT_KERNEL_PYTHON = join(root, executable);
		await expect(ensureKernelPython()).rejects.toThrow("PRIME_AGENT_KERNEL_PYTHON");
		expect(spawn).toHaveBeenCalled();
		expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, stdio: "ignore" });
	});

	test("keeps the interactive installer subprocess visible", async () => {
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		process.env.PRIME_AGENT_KERNEL_VENV = join(root, "venv");
		process.env.HOME = root;
		process.env.USERPROFILE = root;
		process.env.PATH = "";
		process.env.PRIME_AGENT_INSTALL_UV = "1";
		const home = vi.spyOn(os, "homedir").mockReturnValue(root);
		try {
			await expect(ensureKernelPython()).rejects.toThrow("couldn't install uv");
			expect(spawn.mock.calls.at(-1)?.[2]).toMatchObject({ stdio: "inherit" });
			expect(spawn.mock.calls.at(-1)?.[2]?.windowsHide).not.toBe(true);
		} finally {
			home.mockRestore();
		}
		expect(existsSync(`${process.env.PRIME_AGENT_KERNEL_VENV}.bootstrap.lock`)).toBe(false);
	});

	test("hides the piped persistent REPL", async () => {
		const manager = new ReplKernelManager({ python: join(root, "python.exe"), cwd: root });
		try {
			await expect(manager.start()).rejects.toThrow("spawn refused by test");
			expect(spawn.mock.calls.at(-1)?.[2]).toMatchObject({ windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		} finally {
			await manager.shutdown();
		}
	});
});
