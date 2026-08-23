import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

// A stub python must be spawned directly; the default-on forkserver would add a
// handshake the stub never answers.
const savedForkFlag = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
beforeAll(() => {
	process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
});
afterAll(() => {
	if (savedForkFlag === undefined) delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
	else process.env.PRIME_AGENT_KERNEL_FORKSERVER = savedForkFlag;
});

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

describe("KernelManager startup", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-startup-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("surfaces kernels that exit before resolving ports", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", 'echo "fake kernel died before binding" >&2', "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const manager = new KernelManager({ python, cwd: tempDir });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(
				/Kernel exited before resolving ports[\s\S]*fake kernel died before binding/,
			);
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("fires onUnexpectedExit when a kernel dies on its own", async () => {
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "exit 42", ""].join("\n"));
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const onUnexpectedExit = vi.fn();
		const manager = new KernelManager({ python, cwd: tempDir, onUnexpectedExit });

		try {
			await expect(manager.execute("print(1)")).rejects.toThrow(/Kernel exited before resolving ports/);
			await vi.waitFor(() => expect(onUnexpectedExit).toHaveBeenCalledTimes(1));
		} finally {
			errorSpy.mockRestore();
			await manager.dispose();
		}
	});

	it("fires onUnexpectedExit at most once even across repeated exit signals", async () => {
		const onUnexpectedExit = vi.fn();
		const manager = new KernelManager({ cwd: tempDir, onUnexpectedExit });
		const internals = manager as unknown as { notifyUnexpectedExit: () => void };

		internals.notifyUnexpectedExit();
		internals.notifyUnexpectedExit();
		internals.notifyUnexpectedExit();

		expect(onUnexpectedExit).toHaveBeenCalledTimes(1);
	});

	it("does not fire onUnexpectedExit when the real exit handler sees a deliberate shutdown", async () => {
		// Drive the actual wiring: spawn a real (stub) child so doStart attaches its
		// exit handler, then flip to "shutdown" before the exit so the handler reads
		// the death as expected — exactly what dispose()/kill() do.
		const python = join(tempDir, "python");
		writeExecutable(python, ["#!/bin/sh", "sleep 30", ""].join("\n"));
		const onUnexpectedExit = vi.fn();
		const manager = new KernelManager({ python, cwd: tempDir, onUnexpectedExit });
		const internals = manager as unknown as {
			state: string;
			kernel?: { pid?: number; killed: boolean };
		};

		const startup = manager.start().catch(() => {});
		// Wait until doStart has spawned the child and attached the exit handler.
		await vi.waitFor(() => expect(internals.kernel?.pid).toBeGreaterThan(0));

		// A deliberate teardown moves us to "shutdown" first, then kills the child;
		// the exit handler must classify the resulting exit as expected.
		await manager.dispose();
		await startup;

		expect(onUnexpectedExit).not.toHaveBeenCalled();
		expect(internals.state).toBe("shutdown");
	});
});
