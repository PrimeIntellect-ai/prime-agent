import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isProcessAlive,
	isZombieProcess,
	signalProcessGroupOrProcess,
	waitForChildProcess,
} from "../src/utils/child-process.js";

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error(`File was not created: ${path}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
	}
}

function forceKillOnWindows(pid: number | undefined): void {
	if (!pid || !isProcessAlive(pid)) return;
	try {
		execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
	} catch {
		// The process may have exited between the liveness check and taskkill.
	}
}

describe("waitForChildProcess", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});
});

describe("signalProcessGroupOrProcess", () => {
	it("does not throw for a running child pid", async () => {
		const child = spawn(process.execPath, ["--eval", "setTimeout(() => {}, 1000)"], { stdio: "ignore" });
		await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
		expect(() => signalProcessGroupOrProcess(child.pid!, "SIGTERM")).not.toThrow();
		await new Promise<void>((resolve) => child.once("exit", () => resolve()));
	});

	it("does not throw for a nonexistent pid", () => {
		expect(() => signalProcessGroupOrProcess(999999999, "SIGKILL")).not.toThrow();
	});

	it.skipIf(process.platform !== "win32")("finishes a tree kill after the signaling process exits", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-taskkill-test-"));
		const grandchildPidFile = join(testDir, "grandchild.pid");
		let target: ChildProcess | undefined;
		let grandchildPid: number | undefined;
		try {
			target = spawn(
				process.execPath,
				[
					"--eval",
					`const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`,
					grandchildPidFile,
				],
				{ stdio: "ignore" },
			);
			await waitForFile(grandchildPidFile);
			grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);
			expect(isProcessAlive(target.pid!)).toBe(true);
			expect(isProcessAlive(grandchildPid)).toBe(true);

			const helperUrl = pathToFileURL(resolve(import.meta.dirname, "../src/utils/child-process.ts")).href;
			const killer = spawn(
				process.execPath,
				[
					"--eval",
					`import { signalProcessGroupOrProcess } from ${JSON.stringify(helperUrl)}; signalProcessGroupOrProcess(${target.pid}, "SIGKILL");`,
				],
				{ stdio: "ignore" },
			);
			const killerCode = await new Promise<number | null>((resolveExit, rejectExit) => {
				killer.once("error", rejectExit);
				killer.once("exit", resolveExit);
			});
			expect(killerCode).toBe(0);
			await waitForProcessExit(target.pid!);
			await waitForProcessExit(grandchildPid);
		} finally {
			forceKillOnWindows(target?.pid);
			forceKillOnWindows(grandchildPid);
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

describe("process liveness", () => {
	it("treats the current process as alive and not a zombie", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isZombieProcess(process.pid)).toBe(false);
	});

	it("treats an exited process as dead", async () => {
		const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("treats a zombie process as dead", async () => {
		const parent = spawn(
			"perl",
			["-e", '$| = 1; my $pid = fork(); if ($pid) { print "$pid\\n"; sleep 30 } else { exit 0 }'],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		try {
			const zombiePid = await new Promise<number>((resolvePid, rejectPid) => {
				let output = "";
				const timer = setTimeout(() => rejectPid(new Error("Timed out waiting for the zombie pid")), 5000);
				parent.stdout.on("data", (chunk: Buffer) => {
					output += chunk.toString();
					const parsed = Number.parseInt(output.trim(), 10);
					if (Number.isInteger(parsed) && parsed > 0) {
						clearTimeout(timer);
						resolvePid(parsed);
					}
				});
			});
			const deadline = Date.now() + 5000;
			while (!isZombieProcess(zombiePid) && Date.now() < deadline) {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
			}
			expect(isZombieProcess(zombiePid)).toBe(true);
			expect(isProcessAlive(zombiePid)).toBe(false);
		} finally {
			parent.kill("SIGKILL");
		}
	});
});
