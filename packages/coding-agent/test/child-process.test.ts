import type * as ChildProcessModule from "node:child_process";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	execFileHidden,
	execFileSyncHidden,
	execSyncHidden,
	isProcessAlive,
	isZombieProcess,
	processGroupExists,
	processGroupHasLiveMember,
	signalProcessGroupIfHeld,
	signalProcessGroupOrProcess,
	spawnHidden,
	spawnSyncHidden,
	waitForChildProcess,
} from "../src/utils/child-process.js";

import { spawnZombieProcess } from "./fixtures/zombie-process.js";

const recordedWindowsHide = vi.hoisted(() => [] as Array<boolean | undefined>);

const __childProcess = createRequire(import.meta.url)("node:child_process") as typeof ChildProcessModule;
vi.mock("node:child_process", () => {
	const actual = __childProcess;
	const wrap =
		<A extends unknown[], R>(fn: (...args: A) => R, optionsIndex: number) =>
		(...args: A): R => {
			recordedWindowsHide.push((args[optionsIndex] as { windowsHide?: boolean } | undefined)?.windowsHide);
			return fn(...args);
		};
	return {
		...actual,
		spawn: wrap(actual.spawn, 2),
		spawnSync: wrap(actual.spawnSync, 2),
		execSync: wrap(actual.execSync, 1),
		execFileSync: wrap(actual.execFileSync, 2),
		execFile: wrap(actual.execFile, 2),
	};
});

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

it("hidden child-process wrappers force windowsHide on every wrapped spawn/exec form", async () => {
	recordedWindowsHide.length = 0;
	const child = spawnHidden(process.execPath, ["--version"], { stdio: "ignore" });
	await waitForChildProcess(child);
	spawnSyncHidden(process.execPath, ["--version"], { stdio: "ignore" });
	execSyncHidden(`"${process.execPath}" --version`, { stdio: "ignore" });
	execFileSyncHidden(process.execPath, ["--version"], { stdio: "ignore" });
	await new Promise<void>((resolveDone) => {
		execFileHidden(process.execPath, ["--version"], {}, () => resolveDone());
	});
	expect(recordedWindowsHide).toEqual([true, true, true, true, true]);
});
