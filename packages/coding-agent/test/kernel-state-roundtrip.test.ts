import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("kernel state snapshot round-trip (real kernel)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let snapshotPath = "";
	let manifestPath = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-state-roundtrip-"));
		snapshotPath = join(dir, "session.dill");
		manifestPath = join(dir, "session.json");
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function newManager(): KernelManager {
		return new KernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path: snapshotPath, manifestPath },
		});
	}

	it("saves picklable names, reports unpicklable ones, then revives them in a fresh kernel", async () => {
		const writer = newManager();
		try {
			await writer.execute("x = 42");
			await writer.execute("df = [1, 2, 3]");
			await writer.execute("def double(n):\n    return n * 2");
			await writer.execute("gen = (n for n in range(3))");

			const snap = await writer.snapshotState();
			expect(snap).not.toBeNull();
			expect(snap?.saved).toEqual(expect.arrayContaining(["x", "df", "double"]));
			expect(snap?.skipped.map((s) => s.name)).toContain("gen");
			expect(existsSync(snapshotPath)).toBe(true);
			expect(existsSync(manifestPath)).toBe(true);
		} finally {
			await writer.dispose();
		}

		const reader = newManager();
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toEqual(expect.arrayContaining(["x", "df", "double"]));
			expect(restore?.failed.map((f) => f.name) ?? []).not.toContain("x");

			const echo = await reader.execute("print(x, double(x), sum(df))");
			expect(echo.stdout.trim()).toBe("42 84 6");
		} finally {
			await reader.dispose();
		}
	}, 60_000);

	it("treats a missing snapshot as an empty restore (clean start)", async () => {
		const freshDir = mkdtempSync(join(tmpdir(), "prime-agent-state-empty-"));
		const manager = new KernelManager({
			python: python as string,
			cwd: freshDir,
			snapshot: { path: join(freshDir, "missing.dill"), manifestPath: join(freshDir, "missing.json") },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore).toEqual({ restored: [], failed: [], missing: true, path: join(freshDir, "missing.dill") });
		} finally {
			await manager.dispose();
			rmSync(freshDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("fails visibly when a required snapshot is missing instead of starting fresh", async () => {
		const freshDir = mkdtempSync(join(tmpdir(), "prime-agent-state-required-missing-"));
		const manager = new KernelManager({
			python: python as string,
			cwd: freshDir,
			snapshot: {
				path: join(freshDir, "missing.dill"),
				manifestPath: join(freshDir, "missing.json"),
				requiredNames: ["required_value"],
			},
		});
		try {
			await expect(manager.restoreState()).rejects.toThrow(/required|missing|fresh/i);
		} finally {
			await manager.kill();
			rmSync(freshDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("snapshots and revives user variables that shadow builtins", async () => {
		const dir = mkdtempSync(join(tmpdir(), "prime-agent-state-shadow-"));
		const path = join(dir, "shadow.dill");
		const cfg = { path, manifestPath: join(dir, "shadow.json") };
		const writer = new KernelManager({ python: python as string, cwd: dir, snapshot: cfg });
		try {
			await writer.execute("list = [10, 20]\nprint = 'shadowed'\nid = 99");
			const snap = await writer.snapshotState();
			expect(snap).not.toBeNull();
			expect(snap?.saved).toEqual(expect.arrayContaining(["list", "print", "id"]));
		} finally {
			await writer.dispose();
		}

		const reader = new KernelManager({ python: python as string, cwd: dir, snapshot: cfg });
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toEqual(expect.arrayContaining(["list", "print", "id"]));
		} finally {
			await reader.dispose();
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	it("fails closed on a corrupt (non-dict) snapshot instead of silently starting fresh", async () => {
		const badDir = mkdtempSync(join(tmpdir(), "prime-agent-state-corrupt-"));
		const badPath = join(badDir, "corrupt.dill");
		const manager = new KernelManager({
			python: python as string,
			cwd: badDir,
			snapshot: { path: badPath, manifestPath: join(badDir, "corrupt.json") },
		});
		try {
			await manager.execute("value = 1");
			await manager.snapshotState();
			// Replace a committed payload with a valid dill list, not the expected name->bytes dict.
			await manager.execute(`import dill\nopen(${JSON.stringify(badPath)}, "wb").write(dill.dumps([1, 2, 3]))`);
			await expect(manager.restoreState()).rejects.toThrow(/failed closed|corrupt|unverifiable/i);
		} finally {
			await manager.dispose();
			rmSync(badDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("omits declared transient state and externalizes an approved large value through verified CAS", async () => {
		const casDir = mkdtempSync(join(tmpdir(), "prime-agent-state-cas-"));
		const path = join(casDir, "state.dill");
		const cfg = {
			path,
			manifestPath: join(casDir, "state.json"),
			maxBytes: 512,
			transientNames: ["frame", "tool_output", "logs", "cache"],
			reproducibleNames: ["dataset"],
		};
		const writer = new KernelManager({ python: python as string, cwd: casDir, snapshot: cfg });
		try {
			await writer.execute(
				"frame = list(range(200))\ntool_output = 'raw output'\nlogs = 'tail'\ncache = {'x': 1}\ngoal = 'host-owned goal'\nworkflow = {'host': 'workflow'}\nworkflow_ledger = {'host': 'ledger'}\nledger = {'host': 'ledger'}\nlease = {'host': 'lease'}\nleases = [{'host': 'lease'}]\nworker = {'host': 'worker'}\nmessage_obligations = [{'host': 'message'}]\ndataset = 'd' * 8192",
			);
			const snapshot = await writer.snapshotState();
			expect(snapshot?.saved).not.toContain("frame");
			expect(snapshot?.saved).not.toContain("tool_output");
			expect(snapshot?.saved).not.toContain("logs");
			expect(snapshot?.saved).not.toContain("cache");
			expect(snapshot?.saved).not.toContain("goal");
			expect(snapshot?.saved).not.toContain("workflow");
			expect(snapshot?.saved).not.toContain("workflow_ledger");
			expect(snapshot?.saved).not.toContain("ledger");
			expect(snapshot?.saved).not.toContain("lease");
			expect(snapshot?.saved).not.toContain("leases");
			expect(snapshot?.saved).not.toContain("worker");
			expect(snapshot?.saved).not.toContain("message_obligations");
			expect(snapshot?.retainedValues).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						valueId: "dataset",
						classification: "artifact_ref",
						representation: "durable",
					}),
				]),
			);
			expect(snapshot?.serializationDurationMs).toBeGreaterThanOrEqual(0);
			expect(snapshot?.growthBytesPerTurn).toBeNull();
			expect(readFileSync(cfg.manifestPath, "utf8")).not.toContain("raw output");
			await writer.execute("checkpoint_marker = 'durable'");
			const nextSnapshot = await writer.snapshotState();
			expect(nextSnapshot?.checkpointTurn).toBeGreaterThan(snapshot?.checkpointTurn ?? 0);
			expect(nextSnapshot?.growthBytesPerTurn).not.toBeNull();
		} finally {
			await writer.kill();
		}

		const reader = new KernelManager({ python: python as string, cwd: casDir, snapshot: cfg });
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toContain("dataset");
			expect(restore?.restoreDurationMs).toBeGreaterThanOrEqual(0);
			const echo = await reader.execute(
				"print(len(dataset), [name in globals() for name in ('frame', 'goal', 'workflow', 'workflow_ledger', 'ledger', 'lease', 'leases', 'worker', 'message_obligations')])",
			);
			expect(echo.stdout.trim()).toBe("8192 [False, False, False, False, False, False, False, False, False]");
		} finally {
			await reader.kill();
			rmSync(casDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("fails visibly when required state is unpicklable", async () => {
		const requiredDir = mkdtempSync(join(tmpdir(), "prime-agent-state-required-"));
		const manager = new KernelManager({
			python: python as string,
			cwd: requiredDir,
			snapshot: {
				path: join(requiredDir, "required.dill"),
				manifestPath: join(requiredDir, "required.json"),
				requiredNames: ["generator"],
			},
		});
		try {
			await manager.execute("generator = (n for n in range(3))");
			await expect(manager.snapshotState()).rejects.toThrow(/required|unpicklable|durable/i);
			await expect(manager.dispose()).rejects.toThrow(/required|unpicklable|durable/i);
		} finally {
			await manager.kill();
			rmSync(requiredDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("fails visibly when required state exceeds the inline durable budget", async () => {
		const requiredDir = mkdtempSync(join(tmpdir(), "prime-agent-state-budget-"));
		const manager = new KernelManager({
			python: python as string,
			cwd: requiredDir,
			snapshot: {
				path: join(requiredDir, "required.dill"),
				manifestPath: join(requiredDir, "required.json"),
				maxBytes: 512,
				requiredNames: ["too_big"],
			},
		});
		try {
			await manager.execute("too_big = 'x' * 8192");
			await expect(manager.snapshotState()).rejects.toThrow(/required|budget|durable/i);
		} finally {
			await manager.kill();
			rmSync(requiredDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("fails visibly when the current required-state registry is absent from a committed checkpoint", async () => {
		const requiredDir = mkdtempSync(join(tmpdir(), "prime-agent-state-required-missing-"));
		const path = join(requiredDir, "state.dill");
		const manifestPath = join(requiredDir, "state.json");
		const writer = new KernelManager({
			python: python as string,
			cwd: requiredDir,
			snapshot: { path, manifestPath },
		});
		try {
			await writer.execute("ordinary = 1");
			await writer.snapshotState();
		} finally {
			await writer.kill();
		}
		const reader = new KernelManager({
			python: python as string,
			cwd: requiredDir,
			snapshot: { path, manifestPath, requiredNames: ["must_exist"] },
		});
		try {
			await expect(reader.restoreState()).rejects.toThrow(/required|registry|missing/i);
		} finally {
			await reader.kill();
			rmSync(requiredDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("lists live user-defined names, filtering internals and live handles", async () => {
		const listDir = mkdtempSync(join(tmpdir(), "prime-agent-state-list-"));
		const manager = new KernelManager({ python: python as string, cwd: listDir });
		try {
			expect(await manager.listNamespaceNames()).toBeNull();
			await manager.execute("alpha = 1\ndef helper(n):\n    return n\n_hidden = 2\nrlm = object()");
			const names = await manager.listNamespaceNames();
			expect(names).toEqual(expect.arrayContaining(["alpha", "helper"]));
			expect(names).not.toContain("_hidden");
			expect(names).not.toContain("rlm");
		} finally {
			await manager.dispose();
			rmSync(listDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("caps each variable without reducing the aggregate snapshot budget", async () => {
		const boundedDir = mkdtempSync(join(tmpdir(), "prime-agent-state-bounded-"));
		const manager = new KernelManager({
			python: python as string,
			cwd: boundedDir,
			snapshot: {
				path: join(boundedDir, "bounded.dill"),
				manifestPath: join(boundedDir, "bounded.json"),
				maxBytes: 10 * 1024,
				maxVariableBytes: 8 * 1024,
			},
		});
		try {
			await manager.execute(`pickle_count = 0
class _Counted:
    def __reduce__(self):
        global pickle_count
        pickle_count += 1
        return (dict, ())
large_records = [_Counted() for _ in range(100_000)]
large_text = "x" * 16_384
small_text_one = "a" * 4_000
small_text_two = "b" * 4_000
aggregate_only = "c" * 4_000
late_small = "d" * 1_000`);
			await manager.execute("large_text");

			const snapshot = await manager.snapshotState();
			expect(snapshot?.skipped.map(({ name }) => name)).toEqual(
				expect.arrayContaining(["large_records", "large_text", "aggregate_only"]),
			);
			expect(snapshot?.saved).toEqual(expect.arrayContaining(["small_text_one", "small_text_two", "late_small"]));
			expect(await manager.listNamespaceNames()).toEqual(expect.arrayContaining(["large_records", "large_text"]));

			const compacted = await manager.pruneOversizedVariables();
			expect(compacted?.pruned).toEqual(expect.arrayContaining(["large_records", "large_text"]));
			const remaining = await manager.listNamespaceNames();
			expect(remaining).toEqual(
				expect.arrayContaining(["small_text_one", "small_text_two", "aggregate_only", "late_small"]),
			);
			expect(remaining).not.toContain("large_records");
			expect(remaining).not.toContain("large_text");
			const outputCache = await manager.execute(
				"print(any(isinstance(value, str) and len(value) == 16_384 for value in Out.values()))",
			);
			expect(outputCache.stdout.trim()).toBe("False");
			const count = await manager.execute("print(pickle_count)");
			expect(Number(count.stdout.trim())).toBeLessThan(100_000);
		} finally {
			await manager.dispose();
			rmSync(boundedDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("keeps oversized variables when the compaction snapshot cannot be written", async () => {
		const failedDir = mkdtempSync(join(tmpdir(), "prime-agent-state-prune-failure-"));
		const blocker = join(failedDir, "not-a-directory");
		writeFileSync(blocker, "block snapshot parent");
		const manager = new KernelManager({
			python: python as string,
			cwd: failedDir,
			snapshot: {
				path: join(blocker, "state.dill"),
				manifestPath: join(blocker, "state.json"),
				maxBytes: 64 * 1024,
				maxVariableBytes: 8 * 1024,
			},
		});
		try {
			await manager.execute('large_text = "x" * 16_384');
			expect(await manager.pruneOversizedVariables()).toBeNull();
			expect(await manager.listNamespaceNames()).toContain("large_text");
		} finally {
			await manager.dispose();
			rmSync(failedDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("auto-snapshots after a successful execution (debounced)", async () => {
		const autoDir = mkdtempSync(join(tmpdir(), "prime-agent-state-auto-"));
		const autoPath = join(autoDir, "auto.dill");
		const manager = new KernelManager({
			python: python as string,
			cwd: autoDir,
			snapshot: { path: autoPath, manifestPath: join(autoDir, "auto.json"), debounceMs: 50 },
		});
		try {
			await manager.execute("auto_var = 'persisted'");
			await expect.poll(() => existsSync(autoPath), { timeout: 10_000 }).toBe(true);
		} finally {
			await manager.dispose();
			rmSync(autoDir, { recursive: true, force: true });
		}
	}, 60_000);
});
