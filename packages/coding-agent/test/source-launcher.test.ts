import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.js";

const execFileAsync = promisify(execFile);
const launcherPath = resolve(__dirname, "../../../prime-agent.sh");
const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("source launcher", () => {
	it.each([false, true])("starts outside the checkout with an inherited tsconfig: %s", async (inheritTsconfig) => {
		const directory = mkdtempSync(join(tmpdir(), "prime-source-launcher-"));
		tempDirs.push(directory);
		const projectDir = join(directory, "project with spaces");
		mkdirSync(projectDir);
		const tsconfigPath = join(projectDir, "tsconfig.json");
		writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { paths: {} } }));

		const result = await execFileAsync("bash", [launcherPath, "--help"], {
			cwd: projectDir,
			env: {
				...process.env,
				[ENV_AGENT_DIR]: join(directory, "agent"),
				TSX_TSCONFIG_PATH: inheritTsconfig ? tsconfigPath : undefined,
				DO_NOT_TRACK: "1",
			},
			timeout: 20_000,
		});

		expect(result.stdout + result.stderr).toContain("Usage:");
	});
});
