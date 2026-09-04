import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	execFileHidden,
	execFileSyncHidden,
	execSyncHidden,
	isProcessAlive,
	isZombieProcess,
	spawnHidden,
	spawnSyncHidden,
	waitForChildProcess,
} from "../src/utils/child-process.js";

const recordedWindowsHide = vi.hoisted(() => [] as Array<boolean | undefined>);

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	const recordWindowsHide = (options: unknown) => {
		recordedWindowsHide.push(
			typeof options === "object" && options !== null
				? (options as { windowsHide?: boolean }).windowsHide
				: undefined,
		);
	};
	return {
		...actual,
		spawn(...args: Parameters<typeof actual.spawn>) {
			recordWindowsHide(args[2]);
			return actual.spawn(...args);
		},
		spawnSync(...args: Parameters<typeof actual.spawnSync>) {
			recordWindowsHide(args[2]);
			return actual.spawnSync(...args);
		},
		execSync(...args: Parameters<typeof actual.execSync>) {
			recordWindowsHide(args[1]);
			return actual.execSync(...args);
		},
		execFileSync(...args: Parameters<typeof actual.execFileSync>) {
			recordWindowsHide(args[2]);
			return actual.execFileSync(...args);
		},
		execFile(...args: Parameters<typeof actual.execFile>) {
			recordWindowsHide(args[2]);
			return actual.execFile(...args);
		},
	};
});

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
});

describe("hidden child-process wrappers", () => {
	it("force windowsHide on every wrapped spawn/exec form", async () => {
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
