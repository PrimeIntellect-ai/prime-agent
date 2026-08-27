import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

let tempDir = "";

function writeFakeRuntime(path: string): void {
	writeFileSync(
		path,
		`#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const countPath = process.env.FAKE_REPL_SPAWN_COUNT;
const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, "utf8")) + 1 : 1;
fs.writeFileSync(countPath, String(count));
let state = {};
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (fs.existsSync(process.env.FAKE_REPL_CORRUPT_BOOT)) {
  process.stdout.write("BROKEN-BOOT\\n");
} else if (!(count > 1 && fs.existsSync(process.env.FAKE_REPL_DELAY_READY))) {
  emit({ event: "ready", protocol: 2, python: process.version });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "seed") state.value = "persisted";
    if (request.code === "read") emit({ event: "stdout", id: request.id, text: state.value || "fresh" });
    if (request.code === "corrupt-active") {
      process.stdout.write("BROKEN-" + "x".repeat(400) + "\\n");
      return;
    }
    if (request.code === "corrupt-idle") {
      process.stdout.write(JSON.stringify({ event: "done", id: request.id, status: "ok" }) + "\\n42\\n");
      return;
    }
    emit({ event: "done", id: request.id, status: "ok" });
    return;
  }
  if (request.type === "snapshot") {
    if (fs.existsSync(process.env.FAKE_REPL_CORRUPT_SNAPSHOT)) {
      process.stdout.write("BROKEN-SNAPSHOT\\n");
      return;
    }
    fs.writeFileSync(request.path, JSON.stringify(state));
    fs.writeFileSync(request.manifest_path, "{}");
    emit({ event: "done", id: request.id, status: "ok", saved: Object.keys(state), skipped: [], bytes: 1 });
    return;
  }
  if (request.type === "restore") {
    if (fs.existsSync(process.env.FAKE_REPL_CORRUPT_RESTORE)) {
      process.stdout.write("BROKEN-RESTORE\\n");
      return;
    }
    if (fs.existsSync(process.env.FAKE_REPL_FAIL_RESTORE)) {
      emit({ event: "done", id: request.id, status: "error", reason: "restore refused" });
      return;
    }
    state = fs.existsSync(request.path) ? JSON.parse(fs.readFileSync(request.path, "utf8")) : {};
    emit({ event: "done", id: request.id, status: "ok", restored: Object.keys(state), failed: [] });
    return;
  }
  if (request.type === "shutdown") {
    emit({ event: "done", id: request.id, status: "ok" });
    process.exit(0);
  }
});
`,
	);
	chmodSync(path, 0o755);
}

function spawnCount(path: string): number {
	return existsSync(path) ? Number(readFileSync(path, "utf8")) : 0;
}

describe("ReplKernelManager corrupt protocol repair", () => {
	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-corrupt-"));
	});

	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	function newManager(options: { snapshot?: boolean; debounceMs?: number } = {}): {
		manager: ReplKernelManager;
		bootCorruptionPath: string;
		countPath: string;
		delayReadyPath: string;
		restoreCorruptionPath: string;
		restoreFailurePath: string;
		snapshotCorruptionPath: string;
		snapshotPath: string;
	} {
		const python = join(tempDir, "python");
		const bootCorruptionPath = join(tempDir, "corrupt-boot");
		const countPath = join(tempDir, "spawn-count");
		const delayReadyPath = join(tempDir, "delay-ready");
		const restoreCorruptionPath = join(tempDir, "corrupt-restore");
		const restoreFailurePath = join(tempDir, "fail-restore");
		const snapshotCorruptionPath = join(tempDir, "corrupt-snapshot");
		const snapshotPath = join(tempDir, "state.json");
		writeFakeRuntime(python);
		return {
			manager: new ReplKernelManager({
				python,
				cwd: tempDir,
				env: {
					FAKE_REPL_CORRUPT_BOOT: bootCorruptionPath,
					FAKE_REPL_CORRUPT_RESTORE: restoreCorruptionPath,
					FAKE_REPL_CORRUPT_SNAPSHOT: snapshotCorruptionPath,
					FAKE_REPL_DELAY_READY: delayReadyPath,
					FAKE_REPL_FAIL_RESTORE: restoreFailurePath,
					FAKE_REPL_SPAWN_COUNT: countPath,
				},
				snapshot: options.snapshot
					? {
							path: snapshotPath,
							manifestPath: join(tempDir, "manifest.json"),
							debounceMs: options.debounceMs ?? 1,
						}
					: undefined,
			}),
			bootCorruptionPath,
			countPath,
			delayReadyPath,
			restoreCorruptionPath,
			restoreFailurePath,
			snapshotCorruptionPath,
			snapshotPath,
		};
	}

	it("rejects an active request, replaces the child, and restores the last snapshot", async () => {
		const { manager, countPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);

			const corrupt = manager.execute("corrupt-active");
			await expect(corrupt).rejects.toThrow(/Kernel protocol error: unparseable protocol line: BROKEN-/);
			await expect(corrupt).rejects.not.toThrow("x".repeat(200));

			const result = await manager.execute("read");
			expect(result).toMatchObject({ status: "ok", stdout: "persisted" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.dispose();
		}
	});

	it("runs a queued execute only after the repair restores state", async () => {
		const { manager, countPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);

			const corrupt = manager.execute("corrupt-active");
			const queued = manager.execute("read");
			await expect(corrupt).rejects.toThrow("Kernel protocol error");
			await expect(queued).resolves.toMatchObject({ status: "ok", stdout: "persisted" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.dispose();
		}
	});

	it("returns an aborted result promptly while the repair is still starting up", async () => {
		const { manager, delayReadyPath } = newManager();
		try {
			await manager.start();
			writeFileSync(delayReadyPath, "1");
			await expect(manager.execute("corrupt-active")).rejects.toThrow("unparseable protocol line");

			const controller = new AbortController();
			const pending = manager.execute("read", { signal: controller.signal });
			controller.abort();
			await expect(pending).resolves.toMatchObject({ status: "aborted" });
		} finally {
			await manager.dispose();
		}
	});

	it("gives up instead of respawn-looping when the replacement corrupts during restore", async () => {
		const { manager, countPath, restoreCorruptionPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(restoreCorruptionPath, "1");

			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			// The single replacement is discarded and no further children spawn.
			await new Promise((r) => setTimeout(r, 400));
			expect(spawnCount(countPath)).toBe(2);
			// The next execute waits out the abandoned repair and starts a fresh kernel.
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(3);
		} finally {
			await manager.dispose();
		}
	});

	it("discards the replacement kernel when the repair restore fails", async () => {
		const { manager, countPath, restoreFailurePath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(restoreFailurePath, "1");

			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(3);
		} finally {
			await manager.dispose();
		}
	});

	it("repairs a non-object frame received while idle", async () => {
		const { manager, countPath } = newManager();
		try {
			await expect(manager.execute("corrupt-idle")).resolves.toMatchObject({ status: "ok" });
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.dispose();
		}
	});

	it("does not respawn repeatedly when startup emits a corrupt frame", async () => {
		const { manager, bootCorruptionPath, countPath } = newManager();
		try {
			writeFileSync(bootCorruptionPath, "1");
			await expect(manager.start()).rejects.toThrow("unparseable protocol line: BROKEN-BOOT");
			expect(spawnCount(countPath)).toBe(1);

			rmSync(bootCorruptionPath);
			await expect(manager.start()).resolves.toBeUndefined();
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.dispose();
		}
	});

	it("does not repair corruption during the dispose snapshot flush", async () => {
		const { manager, countPath, snapshotCorruptionPath } = newManager({
			snapshot: true,
			debounceMs: 60_000,
		});
		await manager.start();
		writeFileSync(snapshotCorruptionPath, "1");

		await manager.dispose();

		expect(manager.isRunning).toBe(false);
		expect(spawnCount(countPath)).toBe(1);
	});

	it("stands down when shutdown supersedes the repair", async () => {
		const { manager, countPath, delayReadyPath } = newManager();
		try {
			await manager.start();
			writeFileSync(delayReadyPath, "1");
			await expect(manager.execute("corrupt-active")).rejects.toThrow("unparseable protocol line");

			await expect(manager.shutdown()).resolves.toBe(true);
			expect(manager.isRunning).toBe(false);
			expect(spawnCount(countPath)).toBe(2);
			await expect(manager.execute("read")).rejects.toThrow("Kernel has been shut down");
		} finally {
			await manager.dispose();
		}
	});
});
