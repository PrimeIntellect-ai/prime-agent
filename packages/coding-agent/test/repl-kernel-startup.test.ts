import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

// Failing-start tests settle well inside the 30s ready timeout.
const START_FAILURE_TIMEOUT_MS = 15_000;

/** A fake kernel runtime (usually one that dies before ready) at the manager's python path. */
function fakeRuntime(...lines: string[]): string {
	const python = join(tempDir, "python");
	writeFileSync(python, lines.join("\n"));
	chmodSync(python, 0o755);
	return python;
}

/** Runs a manager against a fake runtime with console noise muted, then always shuts it down. */
async function withManager(
	python: string,
	body: (manager: ReplKernelManager) => Promise<void>,
	stderrLogPath?: string,
): Promise<void> {
	const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });
	try {
		await body(manager);
	} finally {
		errorSpy.mockRestore();
		await manager.shutdown({ snapshot: true, drainHostRequests: true });
	}
}

describe("ReplKernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before ready with the stderr tail", async () => {
		const python = fakeRuntime("#!/bin/sh", 'echo "fake runtime died before ready" >&2', "exit 42");
		await withManager(python, async (manager) => {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*fake runtime died before ready/,
			);
		});
	});

	it(
		"completes teardown while an inherited grandchild keeps writing stderr",
		async () => {
			// A busy writer inherits fd 2 and survives the kernel: its stream never
			// goes quiet and never EOFs.
			const python = fakeRuntime("#!/bin/sh", "sh -c 'while :; do echo post-mortem noise; done' >&2 &", "exit 42");
			const stderrLogPath = join(tempDir, "artifacts", "kernel-stderr.log");
			await withManager(
				python,
				async (manager) => {
					// Well under the ready timeout: teardown must not wait for the
					// grandchild (destroying the pipe kills it with SIGPIPE).
					await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before ready/);
					expect(statSync(stderrLogPath).mode & 0o777).toBe(0o600);
					expect(statSync(join(tempDir, "artifacts")).mode & 0o777).toBe(0o700);
				},
				stderrLogPath,
			);
		},
		START_FAILURE_TIMEOUT_MS,
	);

	it(
		"tightens a rotated kernel stderr log that was world-readable",
		async () => {
			const stderrLogPath = join(tempDir, "kernel-stderr.log");
			writeFileSync(stderrLogPath, Buffer.alloc(5 * 1024 * 1024 + 1), { mode: 0o644 });
			const python = fakeRuntime("#!/bin/sh", "exit 42");
			await withManager(
				python,
				async (manager) => {
					await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before ready/);
					// The rotated file holds the historical exception payloads.
					expect(statSync(`${stderrLogPath}.old`).mode & 0o777).toBe(0o600);
					expect(statSync(stderrLogPath).mode & 0o777).toBe(0o600);
				},
				stderrLogPath,
			);
		},
		START_FAILURE_TIMEOUT_MS,
	);

	it("fails a runtime announcing an unexpected protocol version", async () => {
		const python = fakeRuntime(
			"#!/bin/sh",
			`echo '{"event":"ready","protocol":1,"python":"3.13.0"}'`,
			"exec sleep 60",
		);
		await withManager(python, async (manager) => {
			await expect(manager.execute("print(1)")).rejects.toThrow(/speaks protocol 1, expected 3/);
		});
	});

	it("rejects promptly when the kernel process fails to spawn", async () => {
		// Without prompt rejection this would ride out the 30s ready timeout.
		await withManager(join(tempDir, "does-not-exist"), async (manager) => {
			await expect(manager.start()).rejects.toThrow(/ENOENT/);
		});
	});

	it("times out a runtime that never sends ready", async () => {
		vi.useFakeTimers();
		try {
			await withManager(fakeRuntime("#!/bin/sh", "exec sleep 120"), async (manager) => {
				const startPromise = manager.start();
				const expectation = expect(startPromise).rejects.toThrow(/did not become ready within 30000ms/);
				await vi.advanceTimersByTimeAsync(30_000);
				// The failure path runs a graceful shutdown bounded by its own deadline.
				await vi.advanceTimersByTimeAsync(5_000);
				await expectation;
			});
		} finally {
			vi.useRealTimers();
		}
	});
});
