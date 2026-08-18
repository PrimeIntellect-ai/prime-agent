import { existsSync, writeFileSync } from "node:fs";
import {
	closeOwnedSessionWorkerOwnerWatch,
	installOwnedSessionWorkerOwnerWatch,
	maybeRunOwnedSessionWorkerFrontend,
} from "../../src/cli/owned-session-worker.js";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.js";

const args = process.argv.slice(2);
if (process.env.PRIME_AGENT_TEST_STDIN_TTY) {
	Object.defineProperty(process.stdin, "isTTY", { value: process.env.PRIME_AGENT_TEST_STDIN_TTY === "1" });
}
const pidPath = process.env.PRIME_AGENT_TEST_OWNED_PID_PATH;
installOwnedSessionWorkerOwnerWatch();

if (process.env.PRIME_AGENT_INTERNAL_OWNED_WORKER === "1") {
	if (pidPath) {
		writeFileSync(`${pidPath}.ppid`, `${process.ppid}\n`);
		writeFileSync(`${pidPath}.profile`, `${process.env.PRIME_AGENT_INTERNAL_OWNED_PROFILE ?? ""}\n`);
		writeFileSync(pidPath, `${process.pid}\n`);
		process.once("SIGTERM", () => {
			writeFileSync(`${pidPath}.terminated`, "terminated\n");
			process.exit(0);
		});
	}
	if (process.env.PRIME_AGENT_TEST_KEEP_ALIVE === "1") {
		setInterval(() => {}, 1000);
	}
	if (args.includes("--mode") && args.includes("rpc")) {
		const reversedCommands: Array<{ id?: string; type: string; marker?: string }> = [];
		const outputResponse = (command: { id?: string; type: string; marker?: string }) => {
			process.stdout.write(
				serializeJsonLine({
					...(command.id ? { id: command.id } : {}),
					type: "response",
					command: command.type,
					success: true,
					...(command.marker ? { marker: command.marker } : {}),
				}),
			);
		};
		attachJsonlLineReader(process.stdin, (line) => {
			const command = JSON.parse(line) as { id?: string; type: string; marker?: string };
			if (process.env.PRIME_AGENT_TEST_EXIT_ZERO_ON_COMMAND === command.type) {
				process.exit(0);
			}
			if (process.env.PRIME_AGENT_TEST_CRASH_ON_COMMAND === command.type) {
				process.exit(1);
			}
			if (command.type === "ack_result") {
				if (process.env.PRIME_AGENT_TEST_CRASH_ON_ACK === "1" && pidPath && !existsSync(`${pidPath}.crashed`)) {
					writeFileSync(`${pidPath}.crashed`, "crashed\n");
					const recoveryPath = process.env.PRIME_AGENT_INTERNAL_OWNED_RECOVERY_DESCRIPTOR;
					if (recoveryPath) {
						writeFileSync(
							recoveryPath,
							`${JSON.stringify({
								version: 1,
								profile: "rpc",
								sessionId: "fixture-session",
								sessionFile: `${pidPath}.jsonl`,
								cwd: process.cwd(),
								updatedAt: new Date().toISOString(),
							})}\n`,
						);
					}
					process.exit(1);
				}
				return;
			}
			if (process.env.PRIME_AGENT_TEST_INVALID_RPC_OUTPUT === "1") {
				process.stdout.write("truncated-json\n");
				process.stdout.write("null\n");
			}
			if (process.env.PRIME_AGENT_TEST_REVERSE_RPC_RESPONSES === "1") {
				reversedCommands.push(command);
				if (reversedCommands.length === 2) {
					for (const pending of reversedCommands.reverse()) {
						outputResponse(pending);
					}
				}
				return;
			}
			outputResponse(command);
		});
		process.stdin.once("end", closeOwnedSessionWorkerOwnerWatch);
		process.stdin.resume();
	} else {
		process.stdin.pipe(process.stdout);
		if (process.env.PRIME_AGENT_TEST_KEEP_ALIVE !== "1") {
			process.stdin.once("end", closeOwnedSessionWorkerOwnerWatch);
		}
	}
} else {
	if (pidPath) {
		writeFileSync(`${pidPath}.frontend`, `${process.pid}\n`);
	}
	await maybeRunOwnedSessionWorkerFrontend(args);
}
