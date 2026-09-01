#!/usr/bin/env bun
/**
 * Measures daemon cold-start latency: spawn `--mode daemon` and poll the unix
 * socket until it accepts a connection. This is the readiness gate every
 * interactive cold start waits on.
 *
 *   bun scripts/bench-daemon-startup.mjs [--runs N]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(import.meta.url), "..", "..");
const entrypoint = join(repoRoot, "packages", "coding-agent", "dist", "bundle", "cli.js");
const runsIndex = process.argv.indexOf("--runs");
const runs = Number(runsIndex !== -1 ? process.argv[runsIndex + 1] : 3) || 3;

function tryConnect(socketPath) {
	return new Promise((resolve) => {
		const socket = connect(socketPath);
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function measureOnce(i) {
	const dir = mkdtempSync(join(tmpdir(), "pi-daemon-bench-"));
	const socketPath = join(dir, "daemon.sock");
	const start = performance.now();
	const child = spawn(process.execPath, [entrypoint, "--mode", "daemon", "--daemon-socket", socketPath], {
		stdio: "ignore",
		env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1" },
	});
	let ready;
	const deadline = performance.now() + 30000;
	for (;;) {
		if (await tryConnect(socketPath)) {
			ready = performance.now() - start;
			break;
		}
		if (performance.now() > deadline) {
			ready = Number.NaN;
			break;
		}
		await new Promise((r) => setTimeout(r, 5));
	}
	child.kill("SIGTERM");
	await new Promise((r) => child.once("exit", r));
	rmSync(dir, { recursive: true, force: true });
	console.log(`run ${i + 1}: socket ready in ${ready.toFixed(0)} ms`);
	return ready;
}

const results = [];
for (let i = 0; i < runs; i++) {
	results.push(await measureOnce(i));
}
const valid = results.filter((r) => !Number.isNaN(r));
console.log(`\nmean: ${(valid.reduce((a, b) => a + b, 0) / valid.length).toFixed(0)} ms over ${valid.length} runs`);
