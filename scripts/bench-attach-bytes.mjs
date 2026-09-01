#!/usr/bin/env bun
/**
 * Measures attach payload bytes for legacy vs slim_attach clients against a
 * daemon session loaded from a given session file. Uses an isolated agent dir
 * so no test sessions leak into the shared sessions directory.
 *
 *   bun scripts/bench-attach-bytes.mjs <session.jsonl>
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const entrypoint = join(repoRoot, "packages", "coding-agent", "dist", "cli.js");
const sourceSession = process.argv[2];
if (!sourceSession) {
	console.error("usage: bench-attach-bytes.mjs <session.jsonl>");
	process.exit(1);
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-attach-bench-"));
const socketPath = join(agentDir, "daemon.sock");
const sessionPath = join(agentDir, basename(sourceSession));
copyFileSync(sourceSession, sessionPath);

const daemon = spawn(process.execPath, [entrypoint, "--mode", "daemon", "--daemon-socket", socketPath], {
	stdio: "ignore",
	env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
});

function request(socket, command) {
	socket.write(`${JSON.stringify(command)}\n`);
}

function connectWhenReady() {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + 30000;
		const tryOnce = () => {
			const socket = connect(socketPath);
			socket.once("connect", () => resolve(socket));
			socket.once("error", () => {
				if (Date.now() > deadline) reject(new Error("daemon did not start"));
				else setTimeout(tryOnce, 50);
			});
		};
		tryOnce();
	});
}

/** Run commands on a fresh connection, resolving when `until(msg)` matches; returns bytes received. */
function session(commands, until) {
	return new Promise((resolve, reject) => {
		connectWhenReady().then((socket) => {
			let bytes = 0;
			let buffer = "";
			const t = setTimeout(() => reject(new Error("timeout")), 60000);
			socket.on("data", (chunk) => {
				bytes += chunk.length;
				buffer += chunk.toString("utf8");
				let idx = buffer.indexOf("\n");
				while (idx !== -1) {
					const line = buffer.slice(0, idx);
					buffer = buffer.slice(idx + 1);
					let msg;
					try {
						msg = JSON.parse(line);
					} catch {
						// non-JSON noise on the stream; skip the line
						idx = buffer.indexOf("\n");
						continue;
					}
					let next;
					try {
						next = until(msg);
					} catch (error) {
						clearTimeout(t);
						socket.destroy();
						reject(error);
						return;
					}
					if (next === "done") {
						clearTimeout(t);
						socket.destroy();
						resolve(bytes);
						return;
					}
					if (typeof next === "object" && next) {
						request(socket, next);
					}
					idx = buffer.indexOf("\n");
				}
			});
			for (const command of commands) {
				request(socket, command);
			}
		}, reject);
	});
}

// Open the session in the daemon once.
let activeSessionId;
await session([{ id: "c1", type: "create", sessionPath }], (msg) => {
	if (msg.type === "response" && msg.id === "c1") {
		if (!msg.success) throw new Error(msg.error);
		activeSessionId = msg.data.activeSessionId ?? msg.data.id;
		return "done";
	}
});
console.log(`session loaded: ${activeSessionId}`);

const measureAttach = (capabilities) =>
	session([], (msg) => {
		if (msg.type === "daemon_hello") {
			return { id: "a1", type: "attach", activeSessionId, ...(capabilities ? { capabilities } : {}) };
		}
		if (msg.type === "response" && msg.id === "a1") {
			if (!msg.success) throw new Error(msg.error);
			return "done";
		}
	});

const legacyBytes = await measureAttach(undefined); // default capabilities (legacy REPL shape)
const slimBytes = await measureAttach(["attach_snapshot", "event_sequence", "extension_ui", "slim_attach"]);

console.log(`legacy attach bytes: ${legacyBytes.toLocaleString()}`);
console.log(`slim attach bytes:   ${slimBytes.toLocaleString()}`);
console.log(`reduction:           ${(100 * (1 - slimBytes / legacyBytes)).toFixed(1)}%`);

daemon.kill("SIGTERM");
rmSync(agentDir, { recursive: true, force: true });
