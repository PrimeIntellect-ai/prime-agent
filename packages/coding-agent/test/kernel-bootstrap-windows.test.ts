import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBatchShimInvocation, windowsExecutableCandidates } from "../src/core/kernel/bootstrap.js";

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

			await new Promise<void>((resolve, reject) => {
				const child = spawn(comSpec, invocation.args, {
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
	it("appends PATHEXT extensions in order for a bare name", () => {
		const candidates = windowsExecutableCandidates("uv", ".COM;.EXE;.BAT;.CMD");
		expect(candidates).toEqual(["uv", "uv.com", "uv.exe", "uv.bat", "uv.cmd"]);
	});

	it("returns the name as-is when it already carries a known extension", () => {
		expect(windowsExecutableCandidates("uv.exe", ".EXE;.CMD")).toEqual(["uv.exe"]);
		expect(windowsExecutableCandidates("build.cmd", ".COM;.EXE;.BAT;.CMD")).toEqual(["build.cmd"]);
		expect(windowsExecutableCandidates("UV.CMD", ".cmd;.exe")).toEqual(["UV.CMD"]);
		expect(windowsExecutableCandidates("uv.exe", ".CMD")).toEqual(["uv.exe"]);
		expect(windowsExecutableCandidates("uv.exe", undefined)).toEqual(["uv.exe"]);
	});

	it("skips duplicate candidates when PATHEXT has duplicate entries", () => {
		const candidates = windowsExecutableCandidates("uv", ".EXE;.exe;.BAT;.bat");
		expect(candidates.filter((c) => c.toLowerCase().endsWith(".exe"))).toHaveLength(1);
		expect(candidates.filter((c) => c.toLowerCase().endsWith(".bat"))).toHaveLength(1);
	});

	it("falls back to WINDOWS_PATHEXT_DEFAULT when pathext is empty", () => {
		const candidates = windowsExecutableCandidates("uv", "");
		expect(candidates).toContain("uv.EXE");
		expect(candidates).toContain("uv.CMD");
		expect(candidates).toContain("uv.BAT");
	});

	it("trims whitespace from PATHEXT entries", () => {
		const candidates = windowsExecutableCandidates("uv", ".EXE; .BAT");
		expect(candidates).toEqual(["uv", "uv.exe", "uv.bat"]);
	});

	it("ignores PATHEXT entries that CreateProcess cannot execute", () => {
		expect(windowsExecutableCandidates("uv", ".JS;.EXE;.VBS;.CMD")).toEqual(["uv", "uv.exe", "uv.cmd"]);
	});
});
