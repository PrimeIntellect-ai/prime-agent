import type * as ChildProcessModule from "node:child_process";
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

import { captureWindowsProcessCreationTime } from "../src/utils/windows-process-signal.js";
import { cooperativeTreeScript, observe, waitUntil } from "./fixtures/windows-process-observation.js";

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

	it.skipIf(process.platform !== "win32")(
		"finishes a tree kill after the signaling process exits",
		async () => {
			const started = Date.now();
			const testDir = mkdtempSync(join(tmpdir(), "prime-agent-taskkill-test-"));
			const ready = join(testDir, "ready");
			const stop = join(testDir, "stop");
			const records: Array<{ pid: number; identity: string | null }> = [];
			const errors: unknown[] = [];
			let target: ChildProcess | undefined;
			let killer: ChildProcess | undefined;
			let killerStderr = "";
			const phase = (name: string, detail: unknown = null) =>
				console.error(
					JSON.stringify({
						case: "caller-exit",
						ms: Date.now() - started,
						phase: name,
						records,
						alive: records.map(({ pid }) => isProcessAlive(pid)),
						detail,
						killerStderr,
					}),
				);
			try {
				target = spawn(process.execPath, ["-e", cooperativeTreeScript, ready, stop], { stdio: "ignore" });
				target.once("error", (error) => {
					errors.push(error);
					phase("target-error", String(error));
				});
				await waitForFile(ready); // <=10s readiness.
				const pids = JSON.parse(readFileSync(ready, "utf8")) as number[];
				records.push(...pids.map((pid) => ({ pid, identity: null })));
				phase("ready-before-capture");
				for (const record of records) record.identity = captureWindowsProcessCreationTime(record.pid);
				phase("identity-captured");
				expect(records.map(({ pid }) => isProcessAlive(pid))).toEqual([true, true]);
				const helperUrl = pathToFileURL(resolve(import.meta.dirname, "../src/utils/child-process.ts")).href;
				killer = spawn(
					process.execPath,
					[
						"--eval",
						`import { signalProcessGroupOrProcess } from ${JSON.stringify(helperUrl)}; console.error("signal-enter", Date.now()); signalProcessGroupOrProcess(${target.pid}, "SIGKILL", error => console.error("signal-failure", Date.now(), error.message)); console.error("signal-return", Date.now());`,
					],
					{ stdio: ["ignore", "ignore", "pipe"] },
				);
				killer.stderr?.on("data", (data: Buffer) => {
					killerStderr += data.toString().slice(0, Math.max(0, 4096 - killerStderr.length));
				});
				killer.once("exit", (code, signal) => phase("caller-exit", { code, signal }));
				phase("signal-requested");
				expect(await observe(waitForChildProcess(killer), 5000, "caller exit")).toBe(0);
				await waitUntil(() => records.every(({ pid }) => !isProcessAlive(pid)), 15000, "both tree processes exit");
				expect(records.map(({ pid }) => isProcessAlive(pid))).toEqual([false, false]);
				phase("whole-tree-gone");
			} catch (error) {
				errors.push(error);
			} finally {
				phase("before-cleanup");
				try {
					writeFileSync(join(testDir, "records.json"), JSON.stringify(records));
				} catch (error) {
					errors.push(error);
				}
				try {
					writeFileSync(stop, "stop");
				} catch (error) {
					errors.push(error);
				}
				try {
					await waitUntil(
						() =>
							records.every(({ pid }) => !isProcessAlive(pid)) &&
							[target, killer].every((child) => !child || child.exitCode !== null || child.signalCode !== null),
						10000,
						"cooperative cleanup",
					);
				} catch (error) {
					errors.push(error);
				}
				phase("cleanup-complete", { errors: errors.map(String), preserved: testDir });
			}
			if (errors.length) throw new AggregateError(errors, "Caller-exit tree test failed");
		},
		45000,
	);
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
