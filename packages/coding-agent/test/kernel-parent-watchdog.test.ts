import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ForkServerUnavailable } from "../src/core/kernel/fork-server.js";
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

		await vi.waitFor(() => {
			const records = readJournalRecords(journalPath);
			expect(records).toHaveLength(2);
			expect(records[0]?.pid).toBe(records[1]?.pid);
			expect(records.every((r) => r.ownerPid === process.pid)).toBe(true);
			expect(records[0]?.active).toBe(true);
			expect(records[1]?.active).toBe(false);
		});
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
