import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as kernelBootstrap from "../src/core/kernel/bootstrap.js";
import { ReplKernelManager } from "../src/core/kernel/index.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";

const ensureKernelPythonMock = vi.hoisted(() => vi.fn());

vi.mock("../src/core/kernel/bootstrap.js", async (importOriginal) => {
	const original = await importOriginal<typeof kernelBootstrap>();
	return { ...original, ensureKernelPython: ensureKernelPythonMock };
});

let tempDir = "";
const savedJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

function writeFakePython(script: string[]): string {
	const python = join(tempDir, "python");
	writeFileSync(python, script.join("\n"));
	chmodSync(python, 0o755);
	return python;
}

interface JournalRecord {
	pid: number;
	ownerPid: number;
	active: boolean;
}

function readJournalRecords(path: string): JournalRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as JournalRecord);
}

describe("repl kernel parent watchdog", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-watchdog-"));
	});

	afterEach(() => {
		ensureKernelPythonMock.mockReset();
		if (savedJournalPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = savedJournalPath;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("spawn sets PRIME_AGENT_KERNEL_OWNER_PID and journals the kernel pid", async () => {
		const envDump = join(tempDir, "kernel-env");
		const python = writeFakePython(["#!/bin/sh", `env > "${envDump}"`, "exit 42", ""]);
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before ready/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}

		expect(readFileSync(envDump, "utf8")).toMatch(new RegExp(`^PRIME_AGENT_KERNEL_OWNER_PID=${process.pid}$`, "m"));

		// Self-exited child: the kill signals nothing, so the record must stay active.
		await vi.waitFor(() => {
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(1);
			expect(records[0]?.ownerPid).toBe(process.pid);
			expect(records[0]?.active).toBe(true);
		});
	});

	it("leaves the journal record active when the kill signals nothing", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = new ReplKernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			child?: { pid?: number; kill(signal: string): boolean };
			cleanupResources(): void;
		};

		try {
			internals.child = { pid: 999999, kill: () => false };
			internals.cleanupResources();

			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === 999999 && !r.active)).toBe(false);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("writes the inactive journal record when a signaled kill proves ownership", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = new ReplKernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			child?: { pid?: number; kill(signal: string): boolean };
			cleanupResources(signal?: NodeJS.Signals): void;
		};

		try {
			internals.child = { pid: 999999, kill: () => true };
			internals.cleanupResources("SIGKILL");

			const records = readJournalRecords(journalPath);
			expect(records.some((r) => r.pid === 999999 && !r.active)).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("a stale doStart resumed after a concurrent teardown never touches the new kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		let resolvePython: (python: string) => void = () => {};
		ensureKernelPythonMock.mockReturnValue(
			new Promise<string>((resolve) => {
				resolvePython = resolve;
			}),
		);
		const manager = new ReplKernelManager({ cwd: tempDir });
		const internals = manager as unknown as {
			state: string;
			child?: { pid?: number; kill(signal: string): boolean };
		};
		const killB = vi.fn(() => true);
		const childB = { pid: 222222, kill: killB };

		try {
			// Start A blocks inside `await ensureKernelPython(...)`.
			const staleStart = manager.start();
			staleStart.catch(() => {});
			await vi.waitFor(() => expect(ensureKernelPythonMock).toHaveBeenCalledTimes(1));

			// A concurrent teardown bumps the start generation and brings up a new
			// running kernel B.
			await manager.kill();
			internals.state = "running";
			internals.child = childB;

			// The stale doStart resumes: it must fail without touching B or spawning.
			resolvePython("/nonexistent/python");
			await expect(staleStart).rejects.toThrow(/Kernel start superseded/);

			expect(internals.state).toBe("running");
			expect(internals.child).toBe(childB);
			expect(killB).not.toHaveBeenCalled();
			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === childB.pid)).toBe(false);
		} finally {
			internals.child = undefined;
			internals.state = "idle";
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("a shutdown superseded by a concurrent kill reports not-owner so recovery cannot resurrect to idle", async () => {
		const manager = new ReplKernelManager({ python: "/nonexistent-python", cwd: tmpdir() });
		const internals = manager as unknown as {
			state: string;
			child: unknown;
			writeLine: (request: Record<string, unknown>) => Promise<void>;
			shutdown(): Promise<boolean>;
			kill(): Promise<void>;
		};
		internals.state = "running";
		// A live child handle keeps waitForKernelExit parked so the send actually blocks the shutdown.
		const child = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: () => true,
			pid: undefined,
			stdin: { destroyed: false, destroy: () => {} },
			stdout: { destroy: () => {} },
			stderr: { destroy: () => {} },
		});
		internals.child = child;
		let releaseSend: () => void = () => {};
		internals.writeLine = () =>
			new Promise<void>((resolve) => {
				releaseSend = resolve;
			});
		const shutdownResult = internals.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 10)); // park in the stdin write
		await internals.kill(); // concurrent teardown wins ownership
		releaseSend();
		child.emit("exit", 0, null);
		expect(await shutdownResult).toBe(false); // recovery must not set idle
		expect(internals.state).toBe("shutdown");
	});

	it("a stale shutdown parked in its stdin-write await never cleans up a successor kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		let releaseSend: () => void = () => {};
		const parkedSend = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});
		const killA = vi.fn(() => true);
		const killB = vi.fn(() => true);
		const childA = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: killA,
			pid: 111111,
			stdin: { destroyed: false, destroy: () => {} },
			stdout: { destroy: () => {} },
			stderr: { destroy: () => {} },
		});
		const childB = Object.assign(new EventEmitter(), {
			exitCode: null,
			signalCode: null,
			kill: killB,
			pid: 222222,
			stdin: { destroyed: false, destroy: () => {} },
			stdout: { destroy: () => {} },
			stderr: { destroy: () => {} },
		});
		const manager = new ReplKernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			state: string;
			child?: unknown;
			writeLine: (request: Record<string, unknown>) => Promise<void>;
			startPromise?: Promise<void>;
		};

		try {
			// Kernel A is running with a stdin write that parks forever until
			// released — shutdown() will suspend inside its await window after
			// having synchronously set state = "shutdown".
			internals.state = "running";
			internals.child = childA;
			internals.writeLine = () => parkedSend;
			const staleShutdown = manager.shutdown();

			// While A's shutdown is parked, a concurrent teardown reclaims A and a
			// new start brings up kernel B.
			await manager.kill();
			internals.state = "running";
			internals.child = childB;
			const startPromiseB = Promise.resolve();
			internals.startPromise = startPromiseB;

			// A's stale shutdown resumes: it must not clean up B or clear B's start.
			releaseSend();
			await staleShutdown;

			expect(internals.state).toBe("running");
			expect(internals.child).toBe(childB);
			expect(killB).not.toHaveBeenCalled();
			expect(internals.startPromise).toBe(startPromiseB);
			// A was reclaimed by kill(); B must never gain an inactive journal record.
			expect(killA).toHaveBeenCalledWith("SIGKILL");
			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === childB.pid && !r.active)).toBe(false);
		} finally {
			internals.child = undefined;
			internals.startPromise = undefined;
			internals.state = "idle";
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const replPython = resolveReplPython();
const describeIf = replPython && process.platform !== "win32" ? describe : describe.skip;

describeIf("repl runtime outlives-owner watchdog (real runtime)", { tags: ["kernel-heavy"] }, () => {
	it("runtime exits after its owner is SIGKILLed (stdin EOF watchdog)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-watchdog-int-"));
		const pidFile = join(dir, "runtime.pid");
		// The owner must be a separate killable process; it replicates the
		// manager's exact spawn line: piped stdin, so owner death delivers EOF.
		const ownerScript = [
			`const { spawn } = require("node:child_process");`,
			`const { writeFileSync } = require("node:fs");`,
			`const k = spawn(${JSON.stringify(replPython)}, ["-m", "rlm.repl"], {`,
			`  env: { ...process.env, PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid) },`,
			`  stdio: ["pipe", "ignore", "ignore"],`,
			`});`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(k.pid));`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const owner = spawn(process.execPath, ["-e", ownerScript], { stdio: ["ignore", "ignore", "inherit"] });
		let runtimePid = 0;

		try {
			await vi.waitFor(
				() => {
					runtimePid = Number(readFileSync(pidFile, "utf8"));
					expect(runtimePid).toBeGreaterThan(0);
					expect(() => process.kill(runtimePid, 0)).not.toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);

			owner.kill("SIGKILL");

			await vi.waitFor(
				() => {
					expect(() => process.kill(runtimePid, 0)).toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);
		} finally {
			if (runtimePid > 0) {
				try {
					process.kill(runtimePid, "SIGKILL");
				} catch {
					// Already exited (the expected outcome).
				}
			}
			try {
				owner.kill("SIGKILL");
			} catch {
				// Already exited.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);

	it("runtime exits after owner death even while a non-yielding cell holds the loop", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-watchdog-busy-"));
		const pidFile = join(dir, "runtime.pid");
		const busyFile = join(dir, "busy.marker");
		// The cell marks the file, then spins synchronously: the asyncio loop is
		// monopolized, so the stdin-EOF shutdown can never run — only the
		// watchdog thread can take the runtime down.
		const busyRequest = JSON.stringify({
			type: "execute",
			id: "busy-cell",
			code: `open(${JSON.stringify(busyFile)}, "w").write("busy")\nwhile True: pass`,
		});
		const ownerScript = [
			`const { spawn } = require("node:child_process");`,
			`const { writeFileSync } = require("node:fs");`,
			`const k = spawn(${JSON.stringify(replPython)}, ["-m", "rlm.repl"], {`,
			`  env: { ...process.env, PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid) },`,
			`  stdio: ["pipe", "ignore", "ignore"],`,
			`});`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(k.pid));`,
			`k.stdin.write(${JSON.stringify(`${busyRequest}\n`)});`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const owner = spawn(process.execPath, ["-e", ownerScript], { stdio: ["ignore", "ignore", "inherit"] });
		let runtimePid = 0;

		try {
			await vi.waitFor(
				() => {
					runtimePid = Number(readFileSync(pidFile, "utf8"));
					expect(runtimePid).toBeGreaterThan(0);
					expect(() => process.kill(runtimePid, 0)).not.toThrow();
					// The marker proves the busy cell has entered its spin.
					expect(existsSync(busyFile)).toBe(true);
				},
				{ timeout: 20_000, interval: 500 },
			);

			owner.kill("SIGKILL");

			await vi.waitFor(
				() => {
					expect(() => process.kill(runtimePid, 0)).toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);
		} finally {
			if (runtimePid > 0) {
				try {
					process.kill(runtimePid, "SIGKILL");
				} catch {
					// Already exited (the expected outcome).
				}
			}
			try {
				owner.kill("SIGKILL");
			} catch {
				// Already exited.
			}
			rmSync(dir, { recursive: true, force: true });
		}
	}, 30_000);
});
