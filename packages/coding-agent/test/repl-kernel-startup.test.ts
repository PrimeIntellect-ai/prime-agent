import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
