import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { execCommand } from "../src/core/exec.js";
import { isProcessAlive } from "../src/utils/child-process.js";

import { captureWindowsProcessCreationTime } from "../src/utils/windows-process-signal.js";
import { cooperativeTreeScript, observe, waitUntil } from "./fixtures/windows-process-observation.js";

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

describe.skipIf(process.platform !== "win32")("execCommand on Windows", () => {
	it("cancels a running process tree", async () => {
		const started = Date.now();
		const testDir = mkdtempSync(join(tmpdir(), "prime-agent-exec-windows-test-"));
		const ready = join(testDir, "ready");
		const stop = join(testDir, "stop");
		const controller = new AbortController();
		const records: Array<{ pid: number; identity: string | null }> = [];
		const errors: unknown[] = [];
		let completed = false;
		const phase = (name: string, detail: unknown = null) =>
			console.error(
				JSON.stringify({
					case: "exec-tree",
					ms: Date.now() - started,
					phase: name,
					records,
					alive: records.map(({ pid }) => isProcessAlive(pid)),
					detail,
				}),
			);
		try {
			const resultPromise = execCommand(
				process.execPath,
				["-e", cooperativeTreeScript, ready, stop],
				process.cwd(),
				{
					signal: controller.signal,
				},
			);
			resultPromise.then(
				(result) => {
					completed = true;
					phase("exec-result", { ...result, stderr: result.stderr.slice(0, 4096) });
				},
				(error) => {
					completed = true;
					phase("exec-error", String(error));
				},
			);
			await waitForFile(ready); // <=10s readiness.
			const pids = JSON.parse(readFileSync(ready, "utf8")) as number[];
			records.push(...pids.map((pid) => ({ pid, identity: null })));
			phase("ready-before-capture");
			for (const record of records) record.identity = captureWindowsProcessCreationTime(record.pid);
			phase("identity-captured");
			expect(records.map(({ pid }) => isProcessAlive(pid))).toEqual([true, true]);
			const deadline = Date.now() + 15000;
			phase("abort-requested");
			controller.abort();
			const result = await observe(resultPromise, 15000, "exec cancellation result");
			expect(result.killed).toBe(true);
			await waitUntil(
				() => records.every(({ pid }) => !isProcessAlive(pid)),
				Math.max(0, deadline - Date.now()),
				"whole-tree exit",
			);
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
					() => completed && records.every(({ pid }) => !isProcessAlive(pid)),
					10000,
					"cooperative cleanup",
				);
			} catch (error) {
				errors.push(error);
			}
			phase("cleanup-complete", { errors: errors.map(String), preserved: testDir });
		}
		if (errors.length) throw new AggregateError(errors, "Exec tree test failed");
	}, 45000);
});
