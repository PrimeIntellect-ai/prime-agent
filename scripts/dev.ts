import { fileURLToPath } from "node:url";

const workspaceDirs = ["packages/ai", "packages/agent", "packages/coding-agent", "packages/tui"] as const;
const rootDir = fileURLToPath(new URL("..", import.meta.url));
const children = workspaceDirs.map((cwd) =>
	Bun.spawn([process.execPath, "run", "--bun", "--cwd", cwd, "dev"], {
		cwd: rootDir,
		env: process.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	}),
);

let stopping = false;

async function stop(signal: NodeJS.Signals, exitCode: number): Promise<never> {
	if (!stopping) {
		stopping = true;
		for (const child of children) {
			child.kill(signal);
		}
	}
	await Promise.allSettled(children.map((child) => child.exited));
	process.exit(exitCode);
}

process.once("SIGINT", () => {
	void stop("SIGINT", 130);
});
process.once("SIGTERM", () => {
	void stop("SIGTERM", 143);
});

const firstExit = await Promise.race(
	children.map(async (child, index) => ({ index, exitCode: await child.exited })),
);
if (!stopping) {
	console.error(`${workspaceDirs[firstExit.index]} watcher exited with code ${firstExit.exitCode}`);
	await stop("SIGTERM", firstExit.exitCode || 1);
}
