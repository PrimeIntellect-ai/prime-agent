import { writeFileSync } from "node:fs";
import { launchDaemonUpdateRestartCoordinator } from "../../src/cli/daemon-update-restart.js";

function requireEnvironment(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing ${name}`);
	}
	return value;
}

const agentDir = requireEnvironment("ENG_4606_AGENT_DIR");
const cliPath = requireEnvironment("ENG_4606_CLI_PATH");
const completionPath = requireEnvironment("ENG_4606_COMPLETION_PATH");
const pidPath = requireEnvironment("ENG_4606_PID_PATH");
const socketPath = requireEnvironment("ENG_4606_SOCKET_PATH");
const originActiveSessionId = requireEnvironment("PRIME_AGENT_INTERNAL_DAEMON_WORKER_ACTIVE_SESSION_ID");

process.argv[1] = cliPath;
process.execArgv.splice(0, process.execArgv.length);
writeFileSync(pidPath, `${process.pid}\n`);

await launchDaemonUpdateRestartCoordinator({
	socketPath,
	agentDir,
	cwd: agentDir,
	originActiveSessionId,
});

writeFileSync(completionPath, "launcher survived\n");
