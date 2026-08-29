import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReplKernelManager } from "../src/core/kernel/index.js";

function resolveReplPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		resolve(__dirname, "..", "..", "..", "prime-agent-runtime", ".venv", "bin", "python"),
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import rlm.repl, dill"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveReplPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel("repl kernel state snapshot round-trip (real runtime)", { tags: ["kernel-heavy"] }, () => {
	let dir = "";
	let snapshotPath = "";
	let manifestPath = "";

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-roundtrip-"));
		snapshotPath = join(dir, "session.dill");
		manifestPath = join(dir, "session.json");
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	function newManager(): ReplKernelManager {
		return new ReplKernelManager({
			python: python as string,
			cwd: dir,
			snapshot: { path: snapshotPath, manifestPath },
		});
	}

	it("saves picklable names, reports unpicklable ones, then revives them in a fresh runtime", async () => {
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
			await writer.shutdown({ snapshot: true, drainHostRequests: true });
		}

		const reader = newManager();
		try {
			const restore = await reader.restoreState();
			expect(restore?.restored).toEqual(expect.arrayContaining(["df", "double", "x"]));
			expect(restore?.failed.map((f) => f.name) ?? []).not.toContain("x");

			const echo = await reader.execute("print(x, double(x), sum(df))");
			expect(echo.stdout.trim()).toBe("42 84 6");
		} finally {
			await reader.shutdown({ snapshot: true, drainHostRequests: true });
		}
	}, 60_000);

	it("treats a missing snapshot as an empty restore (clean start)", async () => {
		const freshDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-empty-"));
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: freshDir,
			snapshot: { path: join(freshDir, "missing.dill"), manifestPath: join(freshDir, "missing.json") },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore).toEqual({ restored: [], failed: [], path: join(freshDir, "missing.dill") });
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(freshDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("restores a snapshot artifact containing IPython-injected blobs, skipping those names", async () => {
		// Synthesize the artifact shape an IPython-kernel snapshot writes: a dict of
		// dill blobs including In/Out/get_ipython entries.
		const ipythonArtifactDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-ipython-artifact-"));
		const ipythonArtifactPath = join(ipythonArtifactDir, "kernel-state.dill");
		const buildScript = [
			"import dill",
			"dill.settings['recurse'] = True",
			"payload = {",
			"    'kept_number': dill.dumps(41),",
			"    'kept_text': dill.dumps('hello'),",
			"    'In': dill.dumps(['print(1)']),",
			"    'Out': dill.dumps({1: 'x'}),",
			"    'get_ipython': dill.dumps(None),",
			"}",
			`with open(${JSON.stringify(ipythonArtifactPath)}, "wb") as fh:`,
			"    dill.dump(payload, fh)",
		].join("\n");
		const build = spawnSync(python as string, ["-c", buildScript], { encoding: "utf8" });
		expect(build.status).toBe(0);

		const manager = new ReplKernelManager({
			python: python as string,
			cwd: ipythonArtifactDir,
			snapshot: { path: ipythonArtifactPath, manifestPath: join(ipythonArtifactDir, "kernel-state.json") },
		});
		try {
			const restore = await manager.restoreState();
			expect(restore?.restored).toEqual(["kept_number", "kept_text"]);
			expect(restore?.failed).toEqual([]);
			const echo = await manager.execute("print(kept_number + 1, kept_text, 'In' in dir(), 'Out' in dir())");
			expect(echo.stdout.trim()).toBe("42 hello False False");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(ipythonArtifactDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("lists live user-defined names, filtering internals and live handles", async () => {
		const listDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-list-"));
		const manager = new ReplKernelManager({ python: python as string, cwd: listDir });
		try {
			expect(await manager.listNamespaceNames()).toBeNull();
			await manager.execute("alpha = 1\ndef helper(n):\n    return n\n_hidden = 2\nrlm = object()");
			const names = await manager.listNamespaceNames();
			expect(names).toEqual(expect.arrayContaining(["alpha", "helper"]));
			expect(names).not.toContain("_hidden");
			expect(names).not.toContain("rlm");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(listDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("prunes oversized variables via a compaction snapshot", async () => {
		const boundedDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-bounded-"));
		const manager = new ReplKernelManager({
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
			await manager.execute('small_text = "a" * 100\nlarge_text = "x" * 16_384');
			const snapshot = await manager.snapshotState();
			expect(snapshot?.skipped.map(({ name }) => name)).toContain("large_text");
			expect(snapshot?.saved).toContain("small_text");

			const compacted = await manager.pruneOversizedVariables();
			expect(compacted?.pruned).toEqual(["large_text"]);
			const remaining = await manager.listNamespaceNames();
			expect(remaining).toContain("small_text");
			expect(remaining).not.toContain("large_text");
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(boundedDir, { recursive: true, force: true });
		}
	}, 60_000);

	it("auto-snapshots after a successful execution (debounced)", async () => {
		const autoDir = mkdtempSync(join(tmpdir(), "prime-agent-repl-state-auto-"));
		const autoPath = join(autoDir, "auto.dill");
		const manager = new ReplKernelManager({
			python: python as string,
			cwd: autoDir,
			snapshot: { path: autoPath, manifestPath: join(autoDir, "auto.json"), debounceMs: 50 },
		});
		try {
			await manager.execute("auto_var = 'persisted'");
			await expect.poll(() => existsSync(autoPath), { timeout: 10_000 }).toBe(true);
		} finally {
			await manager.shutdown({ snapshot: true, drainHostRequests: true });
			rmSync(autoDir, { recursive: true, force: true });
		}
	}, 60_000);
});
