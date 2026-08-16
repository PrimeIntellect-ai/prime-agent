import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KernelManager } from "../../../src/core/kernel/index.js";

// Regression for #1049. dispose() killed the kernel and removed its temp
// directory in the same synchronous pass, so the promise resolved while the
// child was still exiting. The kernel is spawned with cwd set to that
// directory, and Windows holds it open until the process is really gone, so a
// caller deleting it after an awaited dispose() got EPERM.
//
// The defect is not Windows-specific — nothing ever waited for "exit" — so it
// is asserted here on the process itself rather than on a filesystem error:
// once dispose() resolves, the kernel pid must be gone.

let tempDir = "";

function writeExecutable(filePath: string, content: string): void {
	writeFileSync(filePath, content);
	chmodSync(filePath, 0o755);
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM means the pid exists but is not ours to signal: still alive.
		return error instanceof Error && (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return predicate();
}

describe("kernel dispose waits for the child to exit (#1049)", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-1049-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	it("does not resolve until the kernel process is gone", async () => {
		const pidFile = join(tempDir, "kernel.pid");
		const python = join(tempDir, "python");
		// Records its pid, then delays exit on SIGTERM the way a real kernel
		// does while it tears down. Without the fix dispose() returns during
		// this window.
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				`echo $$ > "${pidFile}"`,
				"trap 'sleep 0.3; exit 0' TERM",
				"while true; do sleep 0.05; done",
				"",
			].join("\n"),
		);

		const manager = new KernelManager({ python, cwd: tempDir });
		// The fake never binds ports, so this rejects; it is only here to make
		// the manager spawn the child.
		const started = manager.execute("print(1)").catch(() => undefined);

		const spawned = await waitFor(() => existsSync(pidFile), 5000);
		expect(spawned, "fake kernel never started").toBe(true);
		const pid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
		expect(Number.isFinite(pid)).toBe(true);
		expect(isAlive(pid), "fake kernel should be running before dispose").toBe(true);

		await manager.dispose();

		// The assertion that fails on unpatched code: dispose() resolved while
		// the child was still shutting down.
		expect(isAlive(pid), "dispose() resolved before the kernel exited").toBe(false);

		await started;
	}, 20000);

	it("removes the kernel temp directory once dispose resolves", async () => {
		const pidFile = join(tempDir, "kernel.pid");
		const python = join(tempDir, "python");
		writeExecutable(
			python,
			[
				"#!/bin/sh",
				`echo $$ > "${pidFile}"`,
				"trap 'sleep 0.3; exit 0' TERM",
				"while true; do sleep 0.05; done",
				"",
			].join("\n"),
		);

		const manager = new KernelManager({ python, cwd: tempDir });
		const started = manager.execute("print(1)").catch(() => undefined);
		await waitFor(() => existsSync(pidFile), 5000);

		await manager.dispose();

		// The connection temp dir is the manager's own, not `cwd`; deleting the
		// caller-owned directory must succeed immediately after dispose().
		expect(() => rmSync(tempDir, { recursive: true, force: true })).not.toThrow();
		tempDir = "";

		await started;
	}, 20000);
});
