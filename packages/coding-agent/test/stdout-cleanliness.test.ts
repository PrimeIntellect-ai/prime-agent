import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

const cliPath = resolve(__dirname, "../src/cli.ts");
const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
	const tempRoot = mkdtempSync(join(tmpdir(), "pi-stdout-clean-"));
	tempDirs.push(tempRoot);
	const agentDir = join(tempRoot, "agent");
	const projectDir = join(tempRoot, "project");
	const projectConfigDir = join(projectDir, ".prime", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectConfigDir, { recursive: true });

	const fakeNpmPath = join(tempRoot, "fake-npm.mjs");
	writeFileSync(fakeNpmPath, 'console.log("npm noise on stdout");\nprocess.exit(0);\n', "utf-8");
	writeFileSync(
		join(projectConfigDir, "settings.json"),
		JSON.stringify({ packages: ["npm:fake-package"], npmCommand: [process.execPath, fakeNpmPath] }),
		"utf-8",
	);

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, [tsxPath, cliPath, ...args], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

describe("stdout cleanliness in non-interactive modes", () => {
	it.each([[["--mode", "json", "--help"]], [["-p", "-h"]]])(
		"keeps stdout empty for %j without starting runtime packages",
		async (args) => {
			const result = await runCli(args);

			expect(result.code).toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).not.toContain("npm noise on stdout");
		},
	);
});
