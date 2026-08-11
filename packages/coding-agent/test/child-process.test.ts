import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isProcessAlive, isZombieProcess, waitForChildProcess } from "../src/utils/child-process.js";

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

describe("process liveness", () => {
	it("treats the current process as alive and not a zombie", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isZombieProcess(process.pid)).toBe(false);
	});

	it("treats an exited process as dead", async () => {
		const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		// Node reaps its own children on exit, so the pid is fully gone.
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("treats a zombie process as dead", async () => {
		// A parent that forks and never reaps leaves the child as a zombie.
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
