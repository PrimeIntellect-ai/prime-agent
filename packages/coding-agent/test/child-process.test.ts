import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isProcessAlive, isStoppedProcess, isZombieProcess, waitForChildProcess } from "../src/utils/child-process.js";

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

	it.skipIf(process.platform === "win32")(
		"detects a SIGSTOPped process as stopped, distinct from merely slow",
		async () => {
			const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
			try {
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
				expect(isStoppedProcess(child.pid!)).toBe(false);
				expect(isProcessAlive(child.pid!)).toBe(true);

				process.kill(child.pid!, "SIGSTOP");
				const stoppedDeadline = Date.now() + 5000;
				while (!isStoppedProcess(child.pid!) && Date.now() < stoppedDeadline) {
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
				}
				expect(isStoppedProcess(child.pid!)).toBe(true);
				// Stopped is not the same as dead or zombied: a recovery path must be
				// able to tell "frozen" apart from "gone" to react correctly.
				expect(isProcessAlive(child.pid!)).toBe(true);
				expect(isZombieProcess(child.pid!)).toBe(false);

				process.kill(child.pid!, "SIGCONT");
				const resumedDeadline = Date.now() + 5000;
				while (isStoppedProcess(child.pid!) && Date.now() < resumedDeadline) {
					await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
				}
				expect(isStoppedProcess(child.pid!)).toBe(false);
			} finally {
				child.kill("SIGKILL");
			}
		},
	);

	it("does not report a normal running process as stopped", () => {
		expect(isStoppedProcess(process.pid)).toBe(false);
	});
});
