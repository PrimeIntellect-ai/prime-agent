import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageDirs = ["tui", "ai", "agent", "coding-agent"] as const;
const dryRun = process.argv.includes("--dry-run");

for (const packageDir of packageDirs) {
	const command = [process.execPath, "publish", "--access", "public", "--ignore-scripts"];
	if (dryRun) command.push("--dry-run");
	const result = Bun.spawnSync(command, {
		cwd: join(rootDir, "packages", packageDir),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	if (result.exitCode !== 0) process.exit(result.exitCode);
}
