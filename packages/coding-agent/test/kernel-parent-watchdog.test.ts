import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type ForkedKernelHandle, ForkServerUnavailable } from "../src/core/kernel/fork-server.js";
import { KernelManager } from "../src/core/kernel/index.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../src/core/orphan-process-journal.js";

const forkKernelMock = vi.hoisted(() => vi.fn());
const forkEnabledMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("../src/core/kernel/fork-server.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/kernel/fork-server.js")>();
	return { ...original, forkKernel: forkKernelMock, isForkServerEnabled: forkEnabledMock };
});

let tempDir = "";
const savedForkFlag = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
const savedJournalPath = process.env[ORPHAN_PROCESS_JOURNAL_ENV];

beforeAll(() => {
	process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
});
afterAll(() => {
	if (savedForkFlag === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
	else process.env.PRIME_AGENT_KERNEL_FORKSERVER = savedForkFlag;
});

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

describe("kernel parent watchdog", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-watchdog-"));
	});

	afterEach(() => {
		forkEnabledMock.mockReturnValue(false);
		forkKernelMock.mockReset();
		if (savedJournalPath === undefined) delete process.env[ORPHAN_PROCESS_JOURNAL_ENV];
		else process.env[ORPHAN_PROCESS_JOURNAL_ENV] = savedJournalPath;
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("direct spawn sets JPY_PARENT_PID and journals the kernel pid", async () => {
		const envDump = join(tempDir, "kernel-env");
		const python = writeFakePython(["#!/bin/sh", `env > "${envDump}"`, "exit 42", ""]);
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before resolving ports/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}

		expect(readFileSync(envDump, "utf8")).toMatch(new RegExp(`^JPY_PARENT_PID=${process.pid}$`, "m"));

		// Self-exited child: the handle-based kill signals nothing, so the record must stay active.
		await vi.waitFor(() => {
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(1);
			expect(records[0]?.ownerPid).toBe(process.pid);
			expect(records[0]?.active).toBe(true);
		});
	});

	it("writes the inactive journal record only on a signaled forkserver kill outcome", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		forkEnabledMock.mockReturnValue(true);
		const killMock = vi.fn(async (): Promise<"signaled"> => "signaled");
		forkKernelMock.mockResolvedValue({
			pid: 999999,
			isAlive: async () => false,
			kill: killMock,
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before resolving ports/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}

		await vi.waitFor(() => {
			expect(killMock).toHaveBeenCalledTimes(1);
			expect(killMock).toHaveBeenCalledWith("TERM");
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(2);
			expect(records[0]).toMatchObject({ pid: 999999, active: true });
			expect(records[1]).toMatchObject({ pid: 999999, active: false });
		});
	});

	it("leaves the journal record active on an already-exited kill outcome (pid may be reused)", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		forkEnabledMock.mockReturnValue(true);
		const killMock = vi.fn(async (): Promise<"already-exited"> => "already-exited");
		forkKernelMock.mockResolvedValue({
			pid: 999999,
			isAlive: async () => false,
			kill: killMock,
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before resolving ports/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}

		await vi.waitFor(() => expect(killMock).toHaveBeenCalledTimes(1));
		// Let the resolved kill settle: no inactive record may ever follow.
		await new Promise((resolve) => setTimeout(resolve, 200));
		const records = readJournalRecords(journalPath);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ pid: 999999, active: true });
	});

	it("leaves the journal record active and never signals the pid when the kill is unconfirmed", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		forkEnabledMock.mockReturnValue(true);
		const killMock = vi.fn(async (): Promise<never> => {
			throw new ForkServerUnavailable("dead");
		});
		forkKernelMock.mockResolvedValue({
			pid: 999999,
			isAlive: async () => {
				throw new ForkServerUnavailable("dead");
			},
			kill: killMock,
		});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const killSpy = vi.spyOn(process, "kill");
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before resolving ports/);
			await manager.dispose();
			await vi.waitFor(() => expect(killMock).toHaveBeenCalled());
			// Let the rejected kill settle: no inactive record may ever follow.
			await new Promise((resolve) => setTimeout(resolve, 200));
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(1);
			expect(records[0]).toMatchObject({ pid: 999999, active: true });
			expect(killSpy.mock.calls.some((call) => call[0] === 999999)).toBe(false);
		} finally {
			killSpy.mockRestore();
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("leaves the direct-spawn journal record active when the kill signals nothing", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			kernel?: { pid?: number; kill(signal: string): boolean };
			cleanupResources(): void;
		};

		try {
			internals.kernel = { pid: 999999, kill: () => false };
			internals.cleanupResources();

			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === 999999 && !r.active)).toBe(false);
		} finally {
			await manager.dispose();
		}
	});

	it("maps SIGKILL to the forkserver KILL signal", async () => {
		forkEnabledMock.mockReturnValue(true);
		const isAliveMock = vi.fn(async () => true);
		const killMock = vi.fn(async (): Promise<"signaled"> => "signaled");
		forkKernelMock.mockResolvedValue({ pid: 999999, isAlive: isAliveMock, kill: killMock });
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });

		try {
			const execution = manager.execute("x");
			execution.catch(() => {});
			// The startup poll calls isAlive only after the handle is assigned, so
			// kill() below is guaranteed to reach the forked branch.
			await vi.waitFor(() => expect(isAliveMock).toHaveBeenCalled());
			await manager.kill();
			expect(killMock).toHaveBeenCalledWith("KILL");
			await expect(execution).rejects.toThrow();
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("a stale liveness probe resumed after restart never tears down the new kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		let resolveProbe: (alive: boolean) => void = () => {};
		const killA = vi.fn(async (): Promise<"signaled"> => "signaled");
		const killB = vi.fn(async (): Promise<"signaled"> => "signaled");
		const handleA: ForkedKernelHandle = {
			pid: 111111,
			isAlive: () =>
				new Promise<boolean>((resolve) => {
					resolveProbe = resolve;
				}),
			kill: killA,
		};
		const handleB: ForkedKernelHandle = { pid: 222222, isAlive: async () => true, kill: killB };
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			state: string;
			forkedKernel?: ForkedKernelHandle;
			checkForkedKernelDeath(): Promise<void>;
		};

		try {
			internals.state = "running";
			internals.forkedKernel = handleA;
			const probe = internals.checkForkedKernelDeath();
			// A restart completes while the probe is in flight: the manager is
			// "running" again, but on a different kernel.
			internals.forkedKernel = handleB;
			resolveProbe(false);
			await probe;

			expect(internals.state).toBe("running");
			expect(killB).not.toHaveBeenCalled();
			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === handleB.pid && !r.active)).toBe(false);
		} finally {
			internals.forkedKernel = undefined;
			internals.state = "idle";
			await manager.dispose();
		}
	});

	it("a timed-out liveness probe never tears down a possibly-healthy kernel", async () => {
		const kill = vi.fn(async (): Promise<"signaled"> => "signaled");
		const handle: ForkedKernelHandle = {
			pid: 111111,
			isAlive: async () => {
				throw new ForkServerUnavailable("forkserver request timed out after 10000ms", { timedOut: true });
			},
			kill,
		};
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			state: string;
			forkedKernel?: ForkedKernelHandle;
			checkForkedKernelDeath(): Promise<void>;
		};

		try {
			internals.state = "running";
			internals.forkedKernel = handle;
			await internals.checkForkedKernelDeath();

			expect(internals.state).toBe("running");
			expect(kill).not.toHaveBeenCalled();
		} finally {
			internals.forkedKernel = undefined;
			internals.state = "idle";
			await manager.dispose();
		}
	});

	it("a stale doStart resumed after a concurrent teardown never touches the new kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		forkEnabledMock.mockReturnValue(true);
		let resolveFork: (handle: ForkedKernelHandle) => void = () => {};
		const killA = vi.fn(async (): Promise<"signaled"> => "signaled");
		const killB = vi.fn(async (): Promise<"signaled"> => "signaled");
		const handleA: ForkedKernelHandle = { pid: 111111, isAlive: async () => true, kill: killA };
		const handleB: ForkedKernelHandle = { pid: 222222, isAlive: async () => true, kill: killB };
		forkKernelMock.mockReturnValue(
			new Promise<ForkedKernelHandle>((resolve) => {
				resolveFork = resolve;
			}),
		);
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as { state: string; forkedKernel?: ForkedKernelHandle };

		try {
			// Start A blocks inside `await forkKernel(...)`.
			const staleStart = manager.start();
			staleStart.catch(() => {});
			await vi.waitFor(() => expect(forkKernelMock).toHaveBeenCalledTimes(1));

			// A concurrent restart tears the starting kernel down (bumping the start
			// generation) and brings up a new running kernel B.
			await manager.kill();
			internals.state = "running";
			internals.forkedKernel = handleB;

			// The stale doStart resumes with handle A: it must fail without touching B.
			resolveFork(handleA);
			await expect(staleStart).rejects.toThrow(/Kernel start superseded/);

			expect(internals.state).toBe("running");
			expect(internals.forkedKernel).toBe(handleB);
			expect(killB).not.toHaveBeenCalled();
			// A is reclaimed via its own handle, never journaled.
			await vi.waitFor(() => expect(killA).toHaveBeenCalledWith("TERM"));
			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === handleA.pid)).toBe(false);
		} finally {
			internals.forkedKernel = undefined;
			internals.state = "idle";
			await manager.dispose();
		}
	});

	it("a shutdown superseded by a concurrent kill reports not-owner so recovery cannot resurrect to idle", async () => {
		const manager = new KernelManager({ python: "/nonexistent-python", cwd: tmpdir() });
		const internals = manager as unknown as {
			state: string;
			connection: unknown;
			control: unknown;
			kernel: unknown;
			shutdown(): Promise<boolean>;
			kill(): Promise<void>;
		};
		internals.state = "starting";
		internals.connection = { key: "" };
		// A live kernel handle keeps waitForKernelExit parked so the send actually blocks the shutdown.
		const kernel = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: () => true });
		internals.kernel = kernel;
		let releaseSend: () => void = () => {};
		internals.control = {
			send: () => new Promise<void>((resolve) => (releaseSend = resolve)),
			close: () => {},
		};
		const shutdownResult = internals.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 10)); // park in the control send
		await internals.kill(); // concurrent teardown wins ownership
		releaseSend();
		kernel.emit("exit", 0, null);
		expect(await shutdownResult).toBe(false); // recovery must not set idle
		expect(internals.state).toBe("shutdown");
	});

	it("a stale shutdown parked in its control-send await never cleans up a successor kernel", async () => {
		const journalPath = join(tempDir, "orphans.jsonl");
		process.env[ORPHAN_PROCESS_JOURNAL_ENV] = journalPath;
		let releaseSend: () => void = () => {};
		const parkedSend = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});
		const killA = vi.fn(async (): Promise<"signaled"> => "signaled");
		const killB = vi.fn(async (): Promise<"signaled"> => "signaled");
		const handleA: ForkedKernelHandle = { pid: 111111, isAlive: async () => true, kill: killA };
		const handleB: ForkedKernelHandle = { pid: 222222, isAlive: async () => true, kill: killB };
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			state: string;
			forkedKernel?: ForkedKernelHandle;
			control?: { send(frames: Buffer[]): Promise<void>; close(): void };
			connection?: { ip: string; transport: string; control_port: number; key: string };
			startPromise?: Promise<void>;
		};

		try {
			// Kernel A is running with a control channel whose send parks forever
			// until released — shutdown() will suspend inside its await window
			// after having synchronously set state = "shutdown".
			internals.state = "running";
			internals.forkedKernel = handleA;
			internals.control = { send: () => parkedSend, close: () => {} };
			internals.connection = { ip: "127.0.0.1", transport: "tcp", control_port: 1, key: "test-key" };
			const staleShutdown = manager.shutdown();

			// While A's shutdown is parked, a concurrent teardown reclaims A (this is
			// the cleanup restart() reaches via shutdown's already-shutdown fast path)
			// and a new start brings up kernel B.
			await manager.kill();
			internals.state = "running";
			internals.forkedKernel = handleB;
			const startPromiseB = Promise.resolve();
			internals.startPromise = startPromiseB;

			// A's stale shutdown resumes: it must not clean up B or clear B's start.
			releaseSend();
			await staleShutdown;

			expect(internals.state).toBe("running");
			expect(internals.forkedKernel).toBe(handleB);
			expect(killB).not.toHaveBeenCalled();
			expect(internals.startPromise).toBe(startPromiseB);
			// A was reclaimed by kill(); B must never gain an inactive journal record.
			await vi.waitFor(() => expect(killA).toHaveBeenCalledWith("KILL"));
			const records = existsSync(journalPath) ? readJournalRecords(journalPath) : [];
			expect(records.some((r) => r.pid === handleB.pid && !r.active)).toBe(false);
		} finally {
			internals.forkedKernel = undefined;
			internals.startPromise = undefined;
			internals.state = "idle";
			await manager.dispose();
		}
	});

	it("a hung liveness probe resolves alive once its budget expires", async () => {
		const manager = new KernelManager({ python: "/nonexistent/python", cwd: tempDir });
		const internals = manager as unknown as {
			forkedKernelDead(probed: ForkedKernelHandle, timeoutMs?: number): Promise<boolean>;
		};
		const handle: ForkedKernelHandle = {
			pid: 999999,
			isAlive: () => new Promise<boolean>(() => {}),
			kill: async () => "signaled",
		};

		try {
			const started = Date.now();
			// Unknown is not death, and the caller's budget bounds the wait.
			await expect(internals.forkedKernelDead(handle, 250)).resolves.toBe(false);
			expect(Date.now() - started).toBeLessThan(5_000);
		} finally {
			await manager.dispose();
		}
	});

	it("fork request env does not carry JPY_PARENT_PID (forked children watch the forkserver)", async () => {
		const python = writeFakePython(["#!/bin/sh", "exit 42", ""]);
		forkEnabledMock.mockReturnValue(true);
		forkKernelMock.mockRejectedValue(new ForkServerUnavailable("test"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("x")).rejects.toThrow(/Kernel exited before resolving ports/);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}

		expect(forkKernelMock).toHaveBeenCalledTimes(1);
		const spawnParams = forkKernelMock.mock.calls[0]?.[1] as { env?: Record<string, string | undefined> };
		expect(spawnParams.env?.JPY_PARENT_PID).toBeUndefined();
	});
});

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const kernelPython = resolveKernelPython();
const describeIf = kernelPython && process.platform !== "win32" ? describe : describe.skip;

describeIf("kernel outlives-owner watchdog (real kernel)", { tags: ["kernel-heavy"] }, () => {
	it("kernel exits after its owner is SIGKILLed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-watchdog-int-"));
		const pidFile = join(dir, "kernel.pid");
		const connectionFile = join(dir, "connection.json");
		// The owner must be a separate killable process; it replicates KernelManager's
		// exact spawn line (T1 above proves the manager emits that env).
		const ownerScript = [
			`const { spawn } = require("node:child_process");`,
			`const { writeFileSync } = require("node:fs");`,
			`const k = spawn(${JSON.stringify(kernelPython)}, ["-m", "ipykernel_launcher", "-f", ${JSON.stringify(connectionFile)}], {`,
			`  env: { ...process.env, JPY_PARENT_PID: String(process.pid) },`,
			`  stdio: "ignore",`,
			`});`,
			`writeFileSync(${JSON.stringify(pidFile)}, String(k.pid));`,
			`setInterval(() => {}, 1000);`,
		].join("\n");
		const owner = spawn(process.execPath, ["-e", ownerScript], { stdio: ["ignore", "ignore", "inherit"] });
		let kernelPid = 0;

		try {
			await vi.waitFor(
				() => {
					kernelPid = Number(readFileSync(pidFile, "utf8"));
					expect(kernelPid).toBeGreaterThan(0);
					expect(() => process.kill(kernelPid, 0)).not.toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);

			owner.kill("SIGKILL");

			await vi.waitFor(
				() => {
					expect(() => process.kill(kernelPid, 0)).toThrow();
				},
				{ timeout: 20_000, interval: 500 },
			);
		} finally {
			if (kernelPid > 0) {
				try {
					process.kill(kernelPid, "SIGKILL");
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
