/** Run a command without inheriting live Prime Agent orchestration state. */

const [requestedCommand, ...args] = process.argv.slice(2);
if (!requestedCommand) {
	console.error("Usage: bun scripts/run-with-clean-env.ts <command> [args...]");
	process.exit(2);
}

const env = { ...process.env };
for (const name of Object.keys(env)) {
	if (name.startsWith("PRIME_AGENT_INTERNAL_") || name.startsWith("RLM_")) {
		delete env[name];
	}
}
for (const name of ["PRIME_AGENT_CODING_AGENT_DIR", "PRIME_AGENT_KERNEL_OWNER_PID"]) {
	delete env[name];
}

const command = requestedCommand === "bun" ? process.execPath : requestedCommand;
const child = Bun.spawn([command, ...args], {
	cwd: process.cwd(),
	env,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		child.kill(signal);
	});
}

process.exit(await child.exited);
