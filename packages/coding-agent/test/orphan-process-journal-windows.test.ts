import type { ChildProcess, ExecFileException } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/repl-manager.js";
import { liveKernels } from "../src/core/kernel/shared.js";
import {
	ORPHAN_PROCESS_JOURNAL_ENV,
	readActiveOrphanProcesses,
	reapKernelOrphanProcesses,
} from "../src/core/orphan-process-journal.js";
import * as childProcess from "../src/utils/child-process.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalJournal = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
const kernelPid = 999_999;
const orphanPid = 888_888;
let directory: string;
let journal: string;
let callbacks: ((error: ExecFileException | null, stdout: string, stderr: string) => void)[];

function record(processStartId: string | undefined): void {
	appendFileSync(
		journal,
		`${JSON.stringify({
			version: 1,
			pid: orphanPid,
			ownerPid: process.pid,
			kernelPid,
			processStartId,
			active: true,
			recordedAt: new Date().toISOString(),
		})}\n`,
	);
}

describe("Windows kernel orphan cleanup", () => {
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "prime-windows-orphans-"));
		journal = join(directory, "journal.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journal;
		Object.defineProperty(process, "platform", { value: "win32" });
		callbacks = [];
		vi.spyOn(childProcess, "execFileHidden").mockImplementation((_command, _args, _options, callback) => {
			callbacks.push(callback);
			return {} as ChildProcess;
		});
		vi.spyOn(childProcess, "execFileSyncHidden").mockImplementation(() => {
			throw new Error("Blocking process query");
		});
		vi.spyOn(childProcess, "spawnSyncHidden").mockImplementation(() => {
			throw new Error("Blocking tree kill");
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		Object.defineProperty(process, "platform", platform);
		if (originalJournal === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = originalJournal;
		rmSync(directory, { recursive: true, force: true });
	});

	it("keeps the event loop responsive while identity lookup and tree kill are pending", async () => {
		record("win:77");
		let settled = false;
		const reaping = Promise.resolve(reapKernelOrphanProcesses(kernelPid)).then(() => {
			settled = true;
		});
		expect(callbacks).toHaveLength(1);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		callbacks[0]!(null, "77\n", "");
		await vi.waitFor(() => expect(callbacks).toHaveLength(2));
		expect(settled).toBe(false);
		expect(readActiveOrphanProcesses(journal, process.pid)).toHaveLength(1);
		const calls = vi.mocked(childProcess.execFileHidden).mock.calls;
		expect(calls[0]![0]).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/);
		expect(calls[1]![0]).toMatch(/\\System32\\taskkill\.exe$/);
		expect(calls[1]![1]).toEqual(["/F", "/T", "/PID", String(orphanPid)]);
		for (const call of calls) {
			expect(call[2]).toMatchObject({ timeout: 10_000, env: { NoDefaultCurrentDirectoryInExePath: "1" } });
		}
		callbacks[1]!(null, "", "");
		await reaping;
		expect(readActiveOrphanProcesses(journal, process.pid)).toEqual([]);
		expect(childProcess.execFileSyncHidden).not.toHaveBeenCalled();
		expect(childProcess.spawnSyncHidden).not.toHaveBeenCalled();
	});

	it.each(["different identity", "query failure"])("preserves the record without killing on %s", async (mode) => {
		record("win:77");
		const reaping = reapKernelOrphanProcesses(kernelPid);
		expect(callbacks).toHaveLength(1);
		callbacks[0]!(mode === "query failure" ? new Error("lookup failed") : null, "88\n", "");
		await reaping;
		expect(callbacks).toHaveLength(1);
		expect(readActiveOrphanProcesses(journal, process.pid)).toHaveLength(1);
	});

	it("keeps the record active when the tree kill fails", async () => {
		record("win:77");
		const reaping = reapKernelOrphanProcesses(kernelPid);
		expect(callbacks).toHaveLength(1);
		callbacks[0]!(null, "77\n", "");
		await vi.waitFor(() => expect(callbacks).toHaveLength(2));
		callbacks[1]!(new Error("taskkill failed"), "", "");
		await reaping;
		expect(readActiveOrphanProcesses(journal, process.pid)).toHaveLength(1);
	});

	it("ignores identity-free records", async () => {
		record(undefined);
		await reapKernelOrphanProcesses(kernelPid);
		expect(callbacks).toHaveLength(0);
		expect(readActiveOrphanProcesses(journal, process.pid)).toHaveLength(1);
	});

	it("settles cancellation and kills the kernel while orphan cleanup is still pending", async () => {
		record("win:77");
		vi.useFakeTimers();
		const manager = new ReplKernelManager({ cwd: directory });
		const kill = vi.fn(() => true);
		const writeLine = vi.fn(async () => {});
		Object.assign(manager, { state: "running", start: async () => {}, writeLine, child: { pid: kernelPid, kill } });
		const abort = new AbortController();
		const execution = manager.execute("while True: pass", { signal: abort.signal, killOnAbortTimeout: true });
		for (let i = 0; i < 20 && writeLine.mock.calls.length === 0; i++) await Promise.resolve();
		abort.abort();
		await vi.advanceTimersByTimeAsync(1000);
		await expect(execution).resolves.toMatchObject({ status: "aborted" });
		expect(kill).toHaveBeenCalledWith("SIGKILL");
		expect(manager.isDefunct).toBe(true);
		expect(callbacks).toHaveLength(1);
		expect(childProcess.execFileSyncHidden).not.toHaveBeenCalled();
		expect(childProcess.spawnSyncHidden).not.toHaveBeenCalled();
		callbacks[0]!(new Error("process already exited"), "", "");
		await Promise.resolve();
	});

	it("waits for asynchronous orphan cleanup before graceful teardown resolves", async () => {
		record("win:77");
		const manager = new ReplKernelManager({ cwd: directory });
		const kill = vi.fn(() => true);
		Object.assign(manager, { state: "running", child: { pid: kernelPid, kill } });

		let settled = false;
		const shutdown = manager.shutdown().then(() => {
			settled = true;
		});
		expect(callbacks).toHaveLength(1);
		await Promise.resolve();
		expect(settled).toBe(false);

		callbacks[0]!(null, "77\n", "");
		await vi.waitFor(() => expect(callbacks).toHaveLength(2));
		expect(settled).toBe(false);
		callbacks[1]!(null, "", "");
		await shutdown;

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(readActiveOrphanProcesses(journal, process.pid)).toEqual([]);
	});

	it("joins orphan cleanup already started by a concurrent kernel kill", async () => {
		record("win:77");
		const manager = new ReplKernelManager({ cwd: directory });
		const kill = vi.fn(() => true);
		Object.assign(manager, { state: "running", child: { pid: kernelPid, kill } });

		const killing = manager.kill();
		expect(callbacks).toHaveLength(1);
		let shutdownSettled = false;
		const shutdown = manager.shutdown().then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		expect(shutdownSettled).toBe(false);

		callbacks[0]!(null, "77\n", "");
		await vi.waitFor(() => expect(callbacks).toHaveLength(2));
		expect(shutdownSettled).toBe(false);
		callbacks[1]!(null, "", "");
		await Promise.all([killing, shutdown]);

		expect(kill).toHaveBeenCalledWith("SIGKILL");
		expect(readActiveOrphanProcesses(journal, process.pid)).toEqual([]);
	});

	it("keeps a replacement kernel tracked when stale exit cleanup finishes", async () => {
		record("win:77");
		const manager = new ReplKernelManager({ cwd: directory });
		const createChild = (pid: number) =>
			Object.assign(new EventEmitter(), {
				pid,
				exitCode: null,
				signalCode: null,
				stdin: { destroy: vi.fn() },
				stdout: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
				stderr: Object.assign(new EventEmitter(), { destroy: vi.fn() }),
				kill: vi.fn(() => true),
			}) as unknown as ChildProcess;
		const oldChild = createChild(kernelPid);
		Object.assign(manager, { state: "running", child: oldChild });
		(manager as unknown as { wireChild(child: ChildProcess): void }).wireChild(oldChild);
		liveKernels.add(manager);

		oldChild.emit("exit", 1, null);
		expect(callbacks).toHaveLength(1);
		const replacement = createChild(kernelPid + 1);
		const replacementGeneration = (manager as unknown as { startGeneration: number }).startGeneration + 1;
		Object.assign(manager, { state: "running", startGeneration: replacementGeneration, child: replacement });

		callbacks[0]!(new Error("process already exited"), "", "");
		try {
			await new Promise<void>((resolve) => globalThis.setImmediate(resolve));
			expect(liveKernels.has(manager)).toBe(true);
		} finally {
			liveKernels.delete(manager);
		}
	});

	it("completes identity-checked orphan cleanup synchronously during process exit", () => {
		record("win:77");
		vi.mocked(childProcess.execFileSyncHidden).mockReturnValue("77\n" as never);
		vi.mocked(childProcess.spawnSyncHidden).mockReturnValue({ status: 0 } as ReturnType<
			typeof childProcess.spawnSyncHidden
		>);
		const manager = new ReplKernelManager({ cwd: directory });
		const kill = vi.fn(() => true);
		Object.assign(manager, { state: "running", child: { pid: kernelPid, kill } });

		manager.disposeSync();

		expect(kill).toHaveBeenCalledWith("SIGTERM");
		expect(childProcess.execFileHidden).not.toHaveBeenCalled();
		expect(childProcess.execFileSyncHidden).toHaveBeenCalledOnce();
		expect(childProcess.execFileSyncHidden).toHaveBeenCalledWith(
			expect.stringMatching(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/),
			expect.any(Array),
			expect.objectContaining({ encoding: "utf8", timeout: 10_000 }),
		);
		expect(childProcess.spawnSyncHidden).toHaveBeenCalledOnce();
		expect(childProcess.spawnSyncHidden).toHaveBeenCalledWith(
			expect.stringMatching(/\\System32\\taskkill\.exe$/),
			["/F", "/T", "/PID", String(orphanPid)],
			expect.objectContaining({ timeout: 10_000 }),
		);
		expect(readActiveOrphanProcesses(journal, process.pid)).toEqual([]);
	});
});
