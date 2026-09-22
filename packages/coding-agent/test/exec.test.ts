import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const recordedWindowsHide = vi.hoisted(() => [] as Array<boolean | undefined>);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
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

import { execCommand } from "../src/core/exec.js";
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

const SIGKILL_EXIT_CODE = 128 + constants.signals.SIGKILL;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("Child did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe.skipIf(process.platform === "win32")("execCommand", () => {
	it("force kills a process that ignores SIGTERM and cleans up the fallback timer", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-test-"));
		const readyFile = join(testDir, "ready");
		const controller = new AbortController();
		let resultPromise: Promise<Awaited<ReturnType<typeof execCommand>>> | undefined;
		try {
			resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { writeFileSync } = require("node:fs"); process.on("SIGTERM", () => {}); writeFileSync(process.argv[1], ""); setInterval(() => {}, 1000);`,
					readyFile,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			await waitForFile(readyFile);

			vi.useFakeTimers();
			controller.abort();

			await vi.advanceTimersByTimeAsync(5000);
			const result = await resultPromise;

			expect(result.killed).toBe(true);
			expect(result.code).toBe(SIGKILL_EXIT_CODE);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
			controller.abort();
			await resultPromise;
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});

describe("process lifecycle", () => {
	it("reports signaled already-exited children as failures", async () => {
		const child = Object.assign(new EventEmitter(), {
			stdout: null,
			stderr: null,
			exitCode: null,
			signalCode: "SIGTERM" as NodeJS.Signals,
		});

		await expect(waitForChildProcess(child as unknown as ChildProcess)).resolves.toBe(143);
	});

	it("separates live processes from exited ones", async () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		expect(isZombieProcess(process.pid)).toBe(false);

		const child = spawn(process.execPath, ["--eval", "process.exit(0)"], { stdio: "ignore" });
		await new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
		expect(isProcessAlive(child.pid!)).toBe(false);
	});

	// test-policy: allow conditional-or-disabled-test -- Windows has no POSIX zombie or process-group semantics
	it.skipIf(process.platform === "win32")(
		"treats an unreaped zombie as dead and not a live group member",
		async () => {
			// setpgrp makes the zombie its group's only member: the group exists, but a
			// stop waiting on it must complete because nothing is left running.
			const { zombiePid, dispose } = await spawnZombieProcess("setpgrp(0, 0);");
			try {
				expect(isZombieProcess(zombiePid)).toBe(true);
				expect(isProcessAlive(zombiePid)).toBe(false);
				expect(processGroupExists(zombiePid)).toBe(true);
				expect(processGroupHasLiveMember(zombiePid)).toBe(false);
			} finally {
				dispose();
			}
		},
	);

	// test-policy: allow conditional-or-disabled-test -- Windows has no POSIX detached process-group signaling
	it.skipIf(process.platform === "win32")("keeps a process group alive after its leader exits", async () => {
		const childless = spawn("sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" });
		const childlessExited = new Promise<void>((resolveExit) => childless.once("exit", () => resolveExit()));
		const leader = spawn("sh", ["-c", "sleep 30 & echo started"], {
			detached: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const leaderExited = new Promise<void>((resolveExit) => leader.once("exit", () => resolveExit()));
		const leaderStdout = leader.stdout;
		if (!leaderStdout) throw new Error("Expected piped stdout from the process-group leader");
		const pgid = leader.pid!;
		try {
			await new Promise<void>((resolveStart) => leaderStdout.once("data", () => resolveStart()));
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

	it("forces windowsHide on every wrapped spawn/exec form", async () => {
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
});
