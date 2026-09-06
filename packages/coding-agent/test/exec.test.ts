import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { isProcessAlive } from "../src/utils/child-process.js";

const SIGKILL_EXIT_CODE = 128 + constants.signals.SIGKILL;

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!existsSync(path)) {
		if (Date.now() >= deadline) throw new Error("Child did not become ready");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (isProcessAlive(pid)) {
		if (Date.now() >= deadline) throw new Error(`Process ${pid} did not exit`);
		await new Promise((resolve) => setTimeout(resolve, 25));
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

describe.skipIf(process.platform !== "win32")("execCommand on Windows", () => {
	it("cancels a running process tree", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-windows-test-"));
		const grandchildPidFile = join(testDir, "grandchild.pid");
		const controller = new AbortController();
		let grandchildPid: number | undefined;
		let resultPromise: Promise<Awaited<ReturnType<typeof execCommand>>> | undefined;
		try {
			resultPromise = execCommand(
				process.execPath,
				[
					"-e",
					`const { spawn } = require("node:child_process"); const { writeFileSync } = require("node:fs"); const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000);`,
					grandchildPidFile,
				],
				process.cwd(),
				{ signal: controller.signal },
			);
			await waitForFile(grandchildPidFile);
			grandchildPid = Number.parseInt(readFileSync(grandchildPidFile, "utf8"), 10);
			expect(isProcessAlive(grandchildPid)).toBe(true);

			controller.abort();
			const result = await resultPromise;
			expect(result.killed).toBe(true);
			await waitForProcessExit(grandchildPid);
		} finally {
			controller.abort();
			await resultPromise;
			if (grandchildPid && isProcessAlive(grandchildPid)) {
				try {
					process.kill(grandchildPid, "SIGKILL");
				} catch {
					// The process may have exited after the liveness check.
				}
			}
			rmSync(testDir, { recursive: true, force: true });
		}
	});
});
