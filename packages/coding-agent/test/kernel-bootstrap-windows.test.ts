import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBatchShimInvocation } from "../src/core/kernel/bootstrap.js";

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

	it("rejects values that cannot be represented safely", () => {
		expect(() => buildBatchShimInvocation("uv.cmd", ['a"b'], {}, "testtoken")).toThrow(/cannot contain/);
		expect(() => buildBatchShimInvocation("uv.cmd", ["line\nbreak"], {}, "testtoken")).toThrow(/cannot contain/);
	});
});

describe("batch shim round-trip (Windows only)", () => {
	it.skipIf(process.platform !== "win32")(
		"passes metacharacter arguments exactly through cmd /s /c + .cmd shim",
		async () => {
			const shimDir = join(tempDir, "roundtrip-shim");
			mkdirSync(shimDir, { recursive: true });
			const shimPath = join(shimDir, "capture.cmd");
			const captureJs = join(shimDir, "capture.cjs");
			const outPath = join(shimDir, "args.json");

			// Bun/Node.js capture script: writes its argv (slice(2)) as JSON.
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
