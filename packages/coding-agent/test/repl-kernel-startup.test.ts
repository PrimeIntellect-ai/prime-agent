import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
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
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake runtime died before ready" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before ready[\s\S]*fake runtime died before ready/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("lands the exact kernel stderr bytes in the log file", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				"printf 'progress 1\\rprogress 2\\rcaf\\303' >&2",
				"sleep 0.2",
				"printf '\\251\\n' >&2",
				// Trailing lone \303: the kernel dies mid-character.
				'printf "final stderr line\\303" >&2',
				"exit 42",
				"",
			].join("\n"),
		);
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				// The \ufffd from the flushed decoder can land after the host's exit
				// diagnostic (exit/EOF order differs by platform).
				/Kernel exited before ready[\s\S]*caf\u00e9[\s\S]*final stderr line[\s\S]*\ufffd/,
			);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			const expected = Buffer.concat([
				Buffer.from("progress 1\rprogress 2\rcaf\u00e9\nfinal stderr line", "utf8"),
				Buffer.from([0o303]),
			]);
			expect(readFileSync(stderrLogPath).equals(expected)).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("caps the stderr log at the write budget while draining pre-ready spew", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				// 6 MiB of spew: over the 5 MiB write budget, and far beyond the pipe
				// buffer, so the script only finishes if the host keeps draining.
				"head -c 6291456 /dev/zero | tr '\\0' x >&2",
				"printf 'SPEW TAIL' >&2",
				"exit 42",
				"",
			].join("\n"),
		);
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			// The in-memory tail still surfaces the kernel's last words even though
			// the on-disk log stopped at the budget.
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before ready[\s\S]*SPEW TAIL/);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			const marker = "[stderr log budget exhausted]\n";
			const log = readFileSync(stderrLogPath, "utf8");
			expect(log.endsWith(marker)).toBe(true);
			expect(statSync(stderrLogPath).size).toBeLessThanOrEqual(5 * 1024 * 1024 + marker.length);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("keeps logging to the oversized file when rotation fails", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fresh incarnation" >&2', "exit 42", ""].join("\n"));
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		writeFileSync(stderrLogPath, Buffer.alloc(5 * 1024 * 1024 + 1, "x"));
		// A directory at the .old path makes the rotation's rm/rename throw.
		mkdirSync(`${stderrLogPath}.old`);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/cannot rotate kernel stderr log[\s\S]*fresh incarnation/,
			);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			expect(readFileSync(stderrLogPath, "utf8").endsWith("fresh incarnation\n")).toBe(true);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("rotates an oversized stderr log at spawn", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fresh incarnation" >&2', "exit 42", ""].join("\n"));
		const stderrLogPath = join(tempDir, "kernel-stderr.log");
		const previous = Buffer.alloc(5 * 1024 * 1024 + 1, "x");
		writeFileSync(stderrLogPath, previous);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir, stderrLogPath });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before ready/);
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			expect(statSync(`${stderrLogPath}.old`).size).toBe(previous.length);
			expect(readFileSync(stderrLogPath, "utf8")).toBe("fresh incarnation\n");
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("fails a runtime announcing an unexpected protocol version", async () => {
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			["#!/bin/sh", `echo '{"event":"ready","protocol":1,"python":"3.13.0"}'`, "exec sleep 60", ""].join("\n"),
		);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/speaks protocol 1, expected 3/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("rejects promptly when the kernel process fails to spawn", async () => {
		const python = join(tempDir, "does-not-exist");
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			// Without prompt rejection this would ride out the 30s ready timeout.
			await expect(manager.start()).rejects.toThrow(/ENOENT/);
		} finally {
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("times out a runtime that never sends ready", async () => {
		vi.useFakeTimers();
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "exec sleep 120", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new ReplKernelManager({ python, cwd: tempDir });

		try {
			const startPromise = manager.start();
			const expectation = expect(startPromise).rejects.toThrow(/did not become ready within 30000ms/);
			await vi.advanceTimersByTimeAsync(30_000);
			// The failure path runs a graceful shutdown bounded by its own deadline.
			await vi.advanceTimersByTimeAsync(5_000);
			await expectation;
		} finally {
			vi.useRealTimers();
			errorSpy.mockRestore();
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});
