import type * as childProcess from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildBatchShimInvocation,
	ensureKernelPython,
	windowsExecutableCandidates,
} from "../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn<typeof childProcess.spawn>() }));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof childProcess>()),
	spawn,
}));

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "prime-kernel-cmd-"));
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("buildBatchShimInvocation", () => {
	it("keeps argument values out of the cmd.exe command string", () => {
		const invocation = buildBatchShimInvocation(
			"C:\\Tools & More\\uv.cmd",
			["with space", "%PATH%", "a&b", "pipe|value"],
			{ PATH: "original" },
			"testtoken",
		);
		expect(invocation.args).toEqual([
			"/d",
			"/v:off",
			"/s",
			"/c",
			'""%PRIME_AGENT_BATCH_testtoken_0%" "%PRIME_AGENT_BATCH_testtoken_1%" "%PRIME_AGENT_BATCH_testtoken_2%" "%PRIME_AGENT_BATCH_testtoken_3%" "%PRIME_AGENT_BATCH_testtoken_4%""',
		]);
		expect(invocation.args.join(" ")).not.toContain("Tools & More");
		expect(invocation.args.join(" ")).not.toContain("%PATH%");
		expect(invocation.env.PRIME_AGENT_BATCH_testtoken_0).toBe("C:\\Tools & More\\uv.cmd");
		expect(invocation.env.PRIME_AGENT_BATCH_testtoken_2).toBe("%PATH%");
	});

	it.each(['a"b', "line\nbreak", "line\rbreak", "null\0byte"])("rejects unsafe command or argument %j", (value) => {
		expect(() => buildBatchShimInvocation("uv.cmd", [value], {}, "testtoken")).toThrow(/cannot contain/);
		expect(() => buildBatchShimInvocation(value, [], {}, "testtoken")).toThrow(/cannot contain/);
	});

	it("rejects tokens that could alter the cmd.exe command string", () => {
		expect(() => buildBatchShimInvocation("uv.cmd", [], {}, "bad%PATH%")).toThrow(/unsupported characters/);
	});
});

describe("batch shim round-trip (Windows only)", () => {
	it.skipIf(process.platform !== "win32")(
		"passes metacharacter arguments exactly through cmd /s /c + .cmd shim",
		async () => {
			const shimDir = join(tempDir, "工具 & shims!");
			mkdirSync(shimDir, { recursive: true });
			const shimPath = join(shimDir, "capture.cmd");
			const captureJs = join(shimDir, "capture.cjs");
			const outPath = join(shimDir, "args.json");

			// Capture the arguments received by Node.
			writeFileSync(
				captureJs,
				[
					"// capture args as JSON",
					`require("fs").writeFileSync("${outPath.replace(/\\/g, "\\\\")}", JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");`,
				].join("\n"),
				"utf8",
			);

			// .cmd shim that delegates to the capture script.
			// %* passes through the shell-split arguments as cmd.exe split them.
			writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "%~dp0capture.cjs" %*\r\n`, "utf8");

			const testArgs = [
				"simple",
				"with space",
				"%PATH%",
				"100%",
				"bang!",
				"caret^here",
				"ampers&nd",
				"pipe|char",
				"less<than",
				"greater>than",
				"",
				"工具",
				"(parens)",
				")closeParen(",
			];
			const invocation = buildBatchShimInvocation(shimPath, testArgs, process.env, "roundtrip");
			const comSpec = process.env.ComSpec ?? "cmd.exe";

			const { spawn: realSpawn } = await vi.importActual<typeof childProcess>("node:child_process");
			await new Promise<void>((resolve, reject) => {
				const child = realSpawn(comSpec, invocation.args, {
					env: invocation.env,
					stdio: "ignore",
					windowsVerbatimArguments: true,
				});
				child.on("error", reject);
				child.on("exit", (code) => {
					if (code === 0) resolve();
					else reject(new Error(`cmd.exe exited with code ${code}`));
				});
			});

			const raw = readFileSync(outPath, "utf8").trim();
			const actual = JSON.parse(raw) as string[];
			expect(actual).toEqual(testArgs);
		},
	);
});

describe("windowsExecutableCandidates", () => {
	it.each([
		{ name: "uv", pathext: ".COM;.EXE;.BAT;.CMD", expected: ["uv", "uv.com", "uv.exe", "uv.bat", "uv.cmd"] },
		{ name: "uv.exe", pathext: ".EXE;.CMD", expected: ["uv.exe"] },
		{ name: "build.cmd", pathext: ".COM;.EXE;.BAT;.CMD", expected: ["build.cmd"] },
		{ name: "UV.CMD", pathext: ".cmd;.exe", expected: ["UV.CMD"] },
		{ name: "uv.exe", pathext: undefined, expected: ["uv.exe"] },
		{ name: "uv", pathext: ".EXE;.exe;.BAT;.bat", expected: ["uv", "uv.exe", "uv.bat"] },
		{ name: "uv", pathext: "", expected: ["uv", "uv.COM", "uv.EXE", "uv.BAT", "uv.CMD"] },
		{ name: "uv", pathext: ".EXE; .BAT", expected: ["uv", "uv.exe", "uv.bat"] },
		{ name: "uv", pathext: ".JS;.EXE;.VBS;.CMD", expected: ["uv", "uv.exe", "uv.cmd"] },
	])("resolves $name with PATHEXT $pathext", ({ name, pathext, expected }) => {
		expect(windowsExecutableCandidates(name, pathext)).toEqual(expected);
	});
});

describe("Windows kernel subprocesses", () => {
	const originalPlatform = process.platform;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
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
	});

	it("forces UTF-8 for the hidden background Python bootstrap without changing the parent environment", async () => {
		process.env.PRIME_AGENT_KERNEL_PYTHON = join(tempDir, "python.exe");
		await expect(ensureKernelPython()).rejects.toThrow("PRIME_AGENT_KERNEL_PYTHON");
		expect(spawn.mock.calls[0]?.[2]).toMatchObject({ windowsHide: true, stdio: "ignore", env: { PYTHONUTF8: "1" } });
		expect(process.env.PYTHONUTF8).toBe("0");
	});

	it.each(["cmd", "bat"])("rejects a .%s Python override instead of accepting an unowned child", async (extension) => {
		process.env.PRIME_AGENT_KERNEL_PYTHON = join(tempDir, `Python & tools!.${extension}`);
		await expect(ensureKernelPython()).rejects.toThrow("must point directly to a Python executable");
		expect(spawn).not.toHaveBeenCalled();
	});

	it("finds a uv.cmd shim through PATHEXT and launches it hidden", async () => {
		delete process.env.PRIME_AGENT_KERNEL_PYTHON;
		process.env.PRIME_AGENT_KERNEL_VENV = join(tempDir, "venv");
		process.env.PATH = tempDir;
		process.env.PATHEXT = ".CMD";
		const uv = join(tempDir, "uv.cmd");
		writeFileSync(uv, "@echo off\r\n");
		chmodSync(uv, 0o755);

		await expect(ensureKernelPython({ onProgress: () => {} })).rejects.toThrow("spawn refused by test");

		const call = spawn.mock.calls.at(-1);
		expect(call?.[0]).toBe(process.env.ComSpec ?? "cmd.exe");
		expect(call?.[2]).toMatchObject({ windowsHide: true, windowsVerbatimArguments: true, stdio: "ignore" });
		expect(Object.values(call?.[2]?.env ?? {})).toContain(uv);
	});

	it("launches the canonical piped CPython REPL directly with UTF-8", async () => {
		const python = join(tempDir, "python.exe");
		const manager = new ReplKernelManager({ python, cwd: tempDir, env: { PYTHONUTF8: "0" } });
		try {
			await expect(manager.start()).rejects.toThrow("spawn refused by test");
			const call = spawn.mock.calls.at(-1);
			expect(call?.[0]).toBe(python);
			expect(call?.[1]).toEqual(["-m", "rlm.repl"]);
			expect(call?.[2]).toMatchObject({
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				env: { PYTHONUTF8: "1", PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid) },
			});
			expect(call?.[2]?.windowsVerbatimArguments).toBeUndefined();
		} finally {
			await manager.shutdown();
		}
	});

	it("preserves the configured Python encoding and direct launch outside Windows", async () => {
		Object.defineProperty(process, "platform", { value: "linux" });
		const python = join(tempDir, "python.cmd");
		process.env.PRIME_AGENT_KERNEL_PYTHON = python;
		await expect(ensureKernelPython()).rejects.toThrow("PRIME_AGENT_KERNEL_PYTHON");
		expect(spawn.mock.calls[0]?.[0]).toBe(python);
		expect(spawn.mock.calls[0]?.[2]?.env?.PYTHONUTF8).toBe("0");
	});
});
