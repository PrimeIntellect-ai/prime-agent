import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
	isProcessAlive,
	isZombieProcess,
	processGroupExists,
	processGroupHasLiveMember,
	signalProcessGroupIfHeld,
	signalProcessGroupOrProcess,
	waitForChildProcess,
} from "../src/utils/child-process.js";
import { spawnZombieProcess } from "./fixtures/zombie-process.js";

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
		const { zombiePid, dispose } = await spawnZombieProcess();
		try {
			expect(isZombieProcess(zombiePid)).toBe(true);
			expect(isProcessAlive(zombiePid)).toBe(false);
		} finally {
			dispose();
		}
	});

	it.skipIf(process.platform === "win32")("does not let an unreaped zombie block group-stop completion", async () => {
		// setpgrp makes the zombie its group's only member: the group exists, but
		// a stop waiting on it must complete because nothing is left running.
		const { zombiePid, dispose } = await spawnZombieProcess("setpgrp(0, 0);");
		try {
			expect(isZombieProcess(zombiePid)).toBe(true);
			expect(processGroupExists(zombiePid)).toBe(true);
			expect(processGroupHasLiveMember(zombiePid)).toBe(false);
		} finally {
			dispose();
		}
	});

	it.skipIf(process.platform === "win32")("keeps a process group alive after its leader exits", async () => {
		const childless = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
		const childlessExited = new Promise<void>((resolveExit) => childless.once("exit", () => resolveExit()));
		const leader = spawn("sh", ["-c", "sleep 30 & echo started"], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const leaderExited = new Promise<void>((resolveExit) => leader.once("exit", () => resolveExit()));
		const pgid = leader.pid!;
		try {
			await new Promise<void>((resolveStart, rejectStart) => {
				const timer = setTimeout(() => rejectStart(new Error("Timed out waiting for the group member")), 5000);
				leader.stdout?.once("data", () => {
					clearTimeout(timer);
					resolveStart();
				});
			});
			await leaderExited;
			expect(isProcessAlive(pgid)).toBe(false);
			expect(processGroupExists(pgid)).toBe(true);
			expect(processGroupHasLiveMember(pgid)).toBe(true);
			// A held group signals; a fully-gone group refuses (pgid-reuse gate).
			expect(signalProcessGroupIfHeld(pgid, "SIGKILL")).toBe(true);
			await childlessExited;
			expect(processGroupExists(childless.pid!)).toBe(false);
			expect(signalProcessGroupIfHeld(childless.pid!, "SIGKILL")).toBe(false);
		} finally {
			signalProcessGroupOrProcess(pgid, "SIGKILL");
		}
	});
});
