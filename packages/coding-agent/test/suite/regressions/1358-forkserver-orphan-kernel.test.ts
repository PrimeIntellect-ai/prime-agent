// Regression: a forked kernel must not outlive its forkserver. When the forkserver
// exits (as it does when a session ends), it must reap the kernels it forked so they
// cannot reparent to the init system and leak their memory.
//
// This spawns the real forkserver script and a real ipykernel, so it is skipped where
// the kernel Python (ipykernel) is unavailable rather than mocked.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { FORK_SERVER_SCRIPT } from "../../../src/core/kernel/fork-server-script.js";

function resolveKernelPython(): string | null {
	const candidate =
		process.env.PRIME_AGENT_KERNEL_PYTHON ??
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python");
	const probe = spawnSync(candidate, ["-c", "import ipykernel"], { stdio: "ignore" });
	return probe.status === 0 ? candidate : null;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("forkserver orphan kernel", () => {
	const python = resolveKernelPython();

	it.skipIf(python === null || process.platform !== "linux")(
		"kills the forked kernel when the forkserver exits",
		async () => {
			const dir = mkdtempSync(join(tmpdir(), "forkserver-regression-"));
			const socketPath = join(dir, "control.sock");
			const connectionPath = join(dir, "connection.json");

			let conn: Socket | undefined;
			let buffer = "";
			const lines: string[] = [];
			const server = createServer((socket) => {
				conn = socket;
				socket.setEncoding("utf8");
				socket.on("data", (chunk) => {
					buffer += chunk;
					for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
						lines.push(buffer.slice(0, i));
						buffer = buffer.slice(i + 1);
					}
				});
			});
			await new Promise<void>((resolve) => server.listen(socketPath, resolve));

			const proc = spawn(python!, ["-c", FORK_SERVER_SCRIPT, socketPath], {
				stdio: ["ignore", "ignore", "ignore"],
			});

			try {
				const nextLine = async (): Promise<Record<string, unknown>> => {
					for (let i = 0; i < 300; i++) {
						const line = lines.shift();
						if (line?.trim()) return JSON.parse(line);
						await sleep(50);
					}
					throw new Error("forkserver produced no line in time");
				};

				const ready = await nextLine();
				expect(ready.type).toBe("ready");

				conn!.write(`${JSON.stringify({ id: 1, connectionPath, cwd: dir, env: {} })}\n`);
				const forked = await nextLine();
				const kernelPid = forked.pid as number;
				expect(typeof kernelPid).toBe("number");

				await sleep(500);
				expect(pidAlive(kernelPid)).toBe(true);

				proc.kill("SIGTERM");

				let dead = false;
				for (let i = 0; i < 60; i++) {
					if (!pidAlive(kernelPid)) {
						dead = true;
						break;
					}
					await sleep(50);
				}
				if (!dead) process.kill(kernelPid, "SIGKILL");
				expect(dead).toBe(true);
			} finally {
				proc.kill("SIGKILL");
				server.close();
				rmSync(dir, { recursive: true, force: true });
			}
		},
		20_000,
	);
});
