import type * as childProcess from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ensureKernelPython } from "../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn<typeof childProcess.spawn>() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn,
}));

const originalPlatform = process.platform;
let root = "";
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "prime-kernel-windows-"));
	originalEnv = { ...process.env };
	spawn.mockReset().mockImplementation(() => {
		throw new Error("spawn refused by test");
	});
	Object.defineProperty(process, "platform", { value: "win32" });
	process.env.PYTHONUTF8 = "0";
});

afterEach(() => {
	Object.defineProperty(process, "platform", { value: originalPlatform });
	process.env = originalEnv;
	spawn.mockReset();
	rmSync(root, { recursive: true, force: true });
});

describe("Windows kernel subprocesses", () => {
	test("forces UTF-8 for background Python bootstrap without changing the parent environment", async () => {
		process.env.PRIME_AGENT_KERNEL_PYTHON = join(root, "python.exe");
		await expect(ensureKernelPython()).rejects.toThrow("PRIME_AGENT_KERNEL_PYTHON");
		expect(spawn.mock.calls[0]?.[2]).toMatchObject({
			windowsHide: true,
			stdio: "ignore",
			env: { PYTHONUTF8: "1" },
		});
		expect(process.env.PYTHONUTF8).toBe("0");
	});

	test.each(["cmd", "bat"])(
		"rejects a .%s Python override instead of accepting an unowned child",
		async (extension) => {
			process.env.PRIME_AGENT_KERNEL_PYTHON = join(root, `Python & tools!.${extension}`);
			await expect(ensureKernelPython()).rejects.toThrow("must point directly to a Python executable");
			expect(spawn).not.toHaveBeenCalled();
		},
	);

	test("finds a uv.cmd shim through PATHEXT and launches it hidden", async () => {
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		process.env.PRIME_AGENT_KERNEL_VENV = join(root, "venv");
		process.env.PATH = root;
		process.env.PATHEXT = ".CMD";
		const uv = join(root, "uv.cmd");
		writeFileSync(uv, "@echo off\r\n");
		chmodSync(uv, 0o755);
		await expect(ensureKernelPython({ onProgress: () => {} })).rejects.toThrow("spawn refused by test");
		const call = spawn.mock.calls.at(-1);
		expect(call?.[0]).toBe(process.env.ComSpec ?? "cmd.exe");
		expect(call?.[2]).toMatchObject({ windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore" });
		expect(Object.values(call?.[2]?.env ?? {})).toContain(uv);
	});

	test("launches the canonical piped CPython REPL directly with UTF-8", async () => {
		const python = join(root, "python.exe");
		const manager = new ReplKernelManager({ python, cwd: root, env: { PYTHONUTF8: "0" } });
		try {
			await expect(manager.start()).rejects.toThrow("spawn refused by test");
			const call = spawn.mock.calls.at(-1);
			expect(call?.[2]).toMatchObject({
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: { PYTHONUTF8: "1", PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid) },
			});
			expect(call?.[0]).toBe(python);
			expect(call?.[1]).toEqual(["-m", "rlm.repl"]);
			expect(call?.[2]?.windowsVerbatimArguments).toBeUndefined();
		} finally {
			await manager.shutdown();
		}
	});

	test("preserves the configured Python encoding and direct launch outside Windows", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		const python = join(root, "python.cmd");
		process.env.PRIME_AGENT_KERNEL_PYTHON = python;
		await expect(ensureKernelPython()).rejects.toThrow("PRIME_AGENT_KERNEL_PYTHON");
		expect(spawn.mock.calls[0]?.[0]).toBe(python);
		expect(spawn.mock.calls[0]?.[2]?.env?.PYTHONUTF8).toBe("0");
	});
});
