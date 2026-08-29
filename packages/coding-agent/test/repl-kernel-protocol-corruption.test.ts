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
let boot = "missing";
setInterval(() => {
  if (fs.existsSync(process.env.FAKE_REPL_EMIT_GARBAGE)) {
    fs.unlinkSync(process.env.FAKE_REPL_EMIT_GARBAGE);
    process.stdout.write("BROKEN-SPONTANEOUS\\n");
  }
}, 25);
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (count > 1 && fs.existsSync(process.env.FAKE_REPL_DIE_ON_BOOT)) {
  fs.writeFileSync(process.env.FAKE_REPL_DIE_ON_BOOT + "-died", "1");
  process.exit(1);
}
if (fs.existsSync(process.env.FAKE_REPL_CORRUPT_BOOT)) {
  process.stdout.write("BROKEN-BOOT\\n");
} else if (fs.existsSync(process.env.FAKE_REPL_READY_WITH_GARBAGE)) {
  process.stdout.write(
    JSON.stringify({ event: "ready", protocol: 3, python: process.version }) + "\\nBROKEN-WITH-READY\\n",
  );
} else if (!(count > 1 && fs.existsSync(process.env.FAKE_REPL_DELAY_READY))) {
  emit({ event: "ready", protocol: 3, python: process.version });
}
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "execute") {
    if (request.code === "hang") {
      emit({ event: "stdout", id: request.id, text: "hanging" });
      return;
    }
    if (request.code === "bootstrap" && fs.existsSync(process.env.FAKE_REPL_CORRUPT_BOOTSTRAP)) {
      fs.unlinkSync(process.env.FAKE_REPL_CORRUPT_BOOTSTRAP);
      process.stdout.write("BROKEN-BOOTSTRAP\\n");
      return;
    }
    if (request.code === "bootstrap" && fs.existsSync(process.env.FAKE_REPL_FAIL_BOOTSTRAP)) {
      emit({ event: "error", id: request.id, ename: "RuntimeError", evalue: "bootstrap refused", traceback: [] });
      emit({ event: "done", id: request.id, status: "error" });
      return;
    }
    if (request.code === "bootstrap") boot = "live";
    if (request.code === "read-boot") emit({ event: "stdout", id: request.id, text: boot });
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
    if (request.code === "slow-bootstrap") {
      setTimeout(() => {
        boot = "live";
        emit({ event: "done", id: request.id, status: "ok" });
      }, 250);
      return;
    }
    if (request.code === "corrupt-unknown-kind") {
      emit({ event: "bogus", id: request.id });
      return;
    }
    if (request.code === "corrupt-idless-done") {
      emit({ event: "done", status: "ok" });
      return;
    }
    if (request.code === "corrupt-empty-id-done") {
      emit({ event: "done", id: "", status: "ok" });
      return;
    }
    if (request.code === "corrupt-empty-id-host-request") {
      emit({ event: "host_request", id: "", data: { type: "noop" } });
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
    fs.appendFileSync(process.env.FAKE_REPL_RESTORE_LOG, "r");
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

function restoreCount(path: string): number {
	return existsSync(path) ? readFileSync(path, "utf8").length : 0;
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

	function newManager(options: { snapshot?: boolean; debounceMs?: number; bootstrapCode?: string } = {}): {
		manager: ReplKernelManager;
		bootCorruptionPath: string;
		bootstrapCorruptionPath: string;
		bootstrapFailurePath: string;
		countPath: string;
		delayReadyPath: string;
		dieOnBootPath: string;
		emitGarbagePath: string;
		readyGarbagePath: string;
		restoreLogPath: string;
		restoreCorruptionPath: string;
		restoreFailurePath: string;
		snapshotCorruptionPath: string;
		snapshotPath: string;
	} {
		const python = join(tempDir, "python");
		const bootCorruptionPath = join(tempDir, "corrupt-boot");
		const bootstrapCorruptionPath = join(tempDir, "corrupt-bootstrap");
		const bootstrapFailurePath = join(tempDir, "fail-bootstrap");
		const countPath = join(tempDir, "spawn-count");
		const delayReadyPath = join(tempDir, "delay-ready");
		const dieOnBootPath = join(tempDir, "die-on-boot");
		const emitGarbagePath = join(tempDir, "emit-garbage");
		const readyGarbagePath = join(tempDir, "ready-with-garbage");
		const restoreCorruptionPath = join(tempDir, "corrupt-restore");
		const restoreLogPath = join(tempDir, "restore-log");
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
					FAKE_REPL_CORRUPT_BOOTSTRAP: bootstrapCorruptionPath,
					FAKE_REPL_DIE_ON_BOOT: dieOnBootPath,
					FAKE_REPL_FAIL_BOOTSTRAP: bootstrapFailurePath,
					FAKE_REPL_CORRUPT_RESTORE: restoreCorruptionPath,
					FAKE_REPL_CORRUPT_SNAPSHOT: snapshotCorruptionPath,
					FAKE_REPL_DELAY_READY: delayReadyPath,
					FAKE_REPL_EMIT_GARBAGE: emitGarbagePath,
					FAKE_REPL_FAIL_RESTORE: restoreFailurePath,
					FAKE_REPL_READY_WITH_GARBAGE: readyGarbagePath,
					FAKE_REPL_RESTORE_LOG: restoreLogPath,
					FAKE_REPL_SPAWN_COUNT: countPath,
				},
				snapshot: options.snapshot
					? {
							path: snapshotPath,
							manifestPath: join(tempDir, "manifest.json"),
							debounceMs: options.debounceMs ?? 1,
						}
					: undefined,
				bootstrapCode: options.bootstrapCode,
			}),
			bootCorruptionPath,
			bootstrapCorruptionPath,
			bootstrapFailurePath,
			countPath,
			delayReadyPath,
			dieOnBootPath,
			emitGarbagePath,
			readyGarbagePath,
			restoreLogPath,
			restoreCorruptionPath,
			restoreFailurePath,
			snapshotCorruptionPath,
			snapshotPath,
		};
	}

	it("rejects an active request, replaces the child, and restores the last snapshot", async () => {
		const { manager, countPath, restoreLogPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);

			const corrupt = manager.execute("corrupt-active");
			await expect(corrupt).rejects.toThrow(/Kernel protocol error: unparseable protocol line: BROKEN-/);
			await expect(corrupt).rejects.not.toThrow("x".repeat(200));

			const result = await manager.execute("read");
			expect(result).toMatchObject({ status: "ok", stdout: "persisted" });
			expect(spawnCount(countPath)).toBe(2);
			// The repair's successful restore is the only one; the lazy path must not re-restore.
			expect(restoreCount(restoreLogPath)).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
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
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
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
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("gives up instead of respawn-looping when the replacement corrupts during restore", async () => {
		const { manager, countPath, restoreCorruptionPath, restoreLogPath, snapshotPath } = newManager({
			snapshot: true,
		});
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
			// The snapshot was the declared culprit: exactly one (failed) restore, no lazy retry.
			expect(restoreCount(restoreLogPath)).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("discards the replacement kernel when the repair restore fails", async () => {
		const { manager, countPath, restoreFailurePath, restoreLogPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(restoreFailurePath, "1");

			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(3);
			// The snapshot was the declared culprit: exactly one (failed) restore, no lazy retry.
			expect(restoreCount(restoreLogPath)).toBe(1);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("re-runs the runtime bootstrap on the repaired kernel", async () => {
		const { manager, countPath, snapshotPath } = newManager({ snapshot: true, bootstrapCode: "bootstrap" });
		try {
			await manager.execute("bootstrap");
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);

			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			await expect(manager.execute("read-boot")).resolves.toMatchObject({ status: "ok", stdout: "live" });
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "persisted" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("requeues a cell that was busy-waiting on an interrupted cell when corruption arrived", async () => {
		const { manager, countPath, emitGarbagePath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);

			// An aborted hung cell stays active, so the next cell busy-waits on it.
			const controller = new AbortController();
			let onHanging: () => void = () => {};
			const hanging = new Promise<void>((r) => {
				onHanging = r;
			});
			const hung = manager.execute("hang", { signal: controller.signal, onStream: () => onHanging() });
			await hanging;
			controller.abort();
			await expect(hung).resolves.toMatchObject({ status: "aborted" });

			const queued = manager.execute("read");
			await new Promise((r) => setTimeout(r, 100));
			writeFileSync(emitGarbagePath, "1");
			await expect(queued).resolves.toMatchObject({ status: "ok", stdout: "persisted" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("repairs an object frame with an unknown event kind instead of hanging the request", async () => {
		const { manager, countPath } = newManager();
		try {
			await expect(manager.execute("corrupt-unknown-kind")).rejects.toThrow(
				/Kernel protocol error: unknown protocol event/,
			);
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("repairs a done frame without an id instead of hanging the request", async () => {
		const { manager, countPath } = newManager();
		try {
			await expect(manager.execute("corrupt-idless-done")).rejects.toThrow(
				/Kernel protocol error: done frame without id/,
			);
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("repairs a done frame with an empty-string id instead of hanging the request", async () => {
		const { manager, countPath } = newManager();
		try {
			await expect(manager.execute("corrupt-empty-id-done")).rejects.toThrow(
				/Kernel protocol error: done frame without id/,
			);
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("repairs a host_request frame with an empty-string id instead of hanging the request", async () => {
		const { manager, countPath } = newManager();
		try {
			await expect(manager.execute("corrupt-empty-id-host-request")).rejects.toThrow(
				/Kernel protocol error: host_request frame without id/,
			);
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("fails startup when ready and a corrupt frame arrive in one chunk", async () => {
		const { manager, countPath, readyGarbagePath } = newManager();
		try {
			writeFileSync(readyGarbagePath, "1");
			await expect(manager.start()).rejects.toThrow("unparseable protocol line: BROKEN-WITH-READY");
			expect(manager.isRunning).toBe(false);
			expect(spawnCount(countPath)).toBe(1);

			rmSync(readyGarbagePath);
			await expect(manager.start()).resolves.toBeUndefined();
			expect(manager.isRunning).toBe(true);
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("restores the saved namespace on the fresh kernel when only the repair bootstrap failed", async () => {
		const { manager, bootstrapFailurePath, countPath, snapshotPath } = newManager({
			snapshot: true,
			bootstrapCode: "bootstrap",
		});
		try {
			await manager.execute("bootstrap");
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(bootstrapFailurePath, "1");

			// The repair restores kernel 2 fine but its bootstrap fails, and the
			// lazy attempt on kernel 3 fails the same way: the snapshot was never
			// the culprit, so neither discard may poison it.
			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			await expect(manager.execute("read")).rejects.toThrow("Kernel bootstrap failed after protocol repair");

			rmSync(bootstrapFailurePath);
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "persisted" });
			await expect(manager.execute("read-boot")).resolves.toMatchObject({ status: "ok", stdout: "live" });
			expect(spawnCount(countPath)).toBe(4);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("restores the saved namespace on the fresh kernel when the repair start failed", async () => {
		const { manager, countPath, dieOnBootPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(dieOnBootPath, "1");

			// The replacement dies before ready, so the repair start fails without
			// ever implicating the snapshot.
			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			await expect.poll(() => existsSync(`${dieOnBootPath}-died`)).toBe(true);
			rmSync(dieOnBootPath);

			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "persisted" });
			expect(spawnCount(countPath)).toBe(3);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("keeps the namespace restorable when corruption strikes after the repair's restore succeeded", async () => {
		const { manager, bootstrapCorruptionPath, countPath, restoreLogPath, snapshotPath } = newManager({
			snapshot: true,
			bootstrapCode: "bootstrap",
		});
		try {
			await manager.execute("bootstrap");
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(bootstrapCorruptionPath, "1");

			// Kernel 2 restores cleanly, then corrupts (one-shot) during the
			// repair's bootstrap: the snapshot was never implicated.
			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");

			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "persisted" });
			await expect(manager.execute("read-boot")).resolves.toMatchObject({ status: "ok", stdout: "live" });
			expect(spawnCount(countPath)).toBe(3);
			expect(restoreCount(restoreLogPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("final flush never overwrites the saved snapshot with an unrestored namespace", async () => {
		const { manager, dieOnBootPath, snapshotPath } = newManager({ snapshot: true });
		try {
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(dieOnBootPath, "1");

			// Repair-start failure leaves the namespace pending restore.
			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			await expect.poll(() => existsSync(`${dieOnBootPath}-died`)).toBe(true);
			rmSync(dieOnBootPath);

			// restart() resurrects a running kernel without ever reprovisioning it;
			// the teardown's final flush must not snapshot that empty namespace
			// over the strictly fresher saved one.
			await manager.restart();
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
		expect(JSON.parse(readFileSync(snapshotPath, "utf8"))).toEqual({ value: "persisted" });
	});

	it("re-runs the bootstrap on the fresh kernel after a discarded repair", async () => {
		const { manager, countPath, restoreFailurePath, snapshotPath } = newManager({
			snapshot: true,
			bootstrapCode: "bootstrap",
		});
		try {
			await manager.execute("bootstrap");
			await manager.execute("seed");
			await expect.poll(() => existsSync(snapshotPath)).toBe(true);
			writeFileSync(restoreFailurePath, "1");

			// The repair's restore fails, so the replacement kernel is discarded.
			await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");
			// The lazily started fresh kernel must carry the runtime bootstrap again.
			await expect(manager.execute("read-boot")).resolves.toMatchObject({ status: "ok", stdout: "live" });
			expect(spawnCount(countPath)).toBe(3);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("stays bounded when a teardown races the lazy re-bootstrap of a fresh kernel", async () => {
		const { manager, countPath, restoreFailurePath, snapshotPath } = newManager({
			snapshot: true,
			bootstrapCode: "slow-bootstrap",
		});
		await manager.execute("slow-bootstrap");
		await manager.execute("seed");
		await expect.poll(() => existsSync(snapshotPath)).toBe(true);
		writeFileSync(restoreFailurePath, "1");
		await expect(manager.execute("corrupt-active")).rejects.toThrow("Kernel protocol error");

		// The fresh kernel's re-bootstrap (internal + protocolRepair) is in flight
		// when the teardown starts: it must pass the final-flush execution guard,
		// so the flush's queue wait settles and the shutdown stays bounded.
		const pending = manager.execute("read-boot");
		pending.catch(() => undefined);
		await expect.poll(() => spawnCount(countPath)).toBe(3);
		// The fake journals its spawn before ready: wait for "running" so the
		// teardown deterministically races the re-bootstrap, not the boot.
		await expect.poll(() => manager.isRunning).toBe(true);
		await expect(manager.shutdown({ snapshot: true, drainHostRequests: true })).resolves.toBe(true);

		expect(manager.isRunning).toBe(false);
		expect(spawnCount(countPath)).toBe(3);
		// The raced cell must settle either way — served before the teardown or
		// rejected by it — never hang.
		const outcome = await pending.then(
			(r) => `${r.status}:${r.stdout}`,
			(e) => String(e),
		);
		expect(outcome).toMatch(/ok:live|shut down|shutting down/);
	});

	it("repairs a non-object frame received while idle", async () => {
		const { manager, countPath } = newManager();
		try {
			await expect(manager.execute("corrupt-idle")).resolves.toMatchObject({ status: "ok" });
			await expect(manager.execute("read")).resolves.toMatchObject({ status: "ok", stdout: "fresh" });
			expect(spawnCount(countPath)).toBe(2);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
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
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});

	it("does not repair corruption during the dispose snapshot flush", async () => {
		const { manager, countPath, snapshotCorruptionPath } = newManager({
			snapshot: true,
			debounceMs: 60_000,
		});
		await manager.start();
		writeFileSync(snapshotCorruptionPath, "1");

		await manager.shutdown({ snapshot: true, drainHostRequests: true });

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
			// The superseded repair's booting replacement is hard-killed (it never
			// reached "running", so no graceful protocol shutdown); it may die
			// before it journals its spawn. Nothing new may spawn afterwards.
			const spawnsAfterShutdown = spawnCount(countPath);
			expect(spawnsAfterShutdown).toBeLessThanOrEqual(2);
			await expect(manager.execute("read")).rejects.toThrow("Kernel has been shut down");
			await new Promise((r) => setTimeout(r, 200));
			expect(spawnCount(countPath)).toBe(spawnsAfterShutdown);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
		}
	});
});
