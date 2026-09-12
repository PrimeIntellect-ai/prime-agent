import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const describeIf = python ? describe : describe.skip;

describeIf("ReplKernelManager pipe errors (real runtime)", () => {
	let dir = "";
	let manager: ReplKernelManager | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "prime-agent-repl-pipe-"));
	});

	afterEach(async () => {
		await manager?.shutdown({ snapshot: true, drainHostRequests: true });
		manager = undefined;
		if (dir) {
			rmSync(dir, { recursive: true, force: true });
			dir = "";
		}
	});

	it("absorbs kernel pipe write errors instead of crashing the host process", async () => {
		manager = new ReplKernelManager({ python: python as string, cwd: dir });
		const first = await manager.execute("x = 1");
		expect(first.status).toBe("ok");

		const child = (manager as unknown as { child?: ChildProcess }).child;
		expect(child?.stdin).toBeDefined();
		expect(child?.stdout).toBeDefined();
		// A write racing the kernel's death lands as an 'error' event on the pipe;
		// without a listener Node would crash the worker (observed in production as
		// "uncaught exception: Error: write EPIPE").
		expect(() => child?.stdin?.emit("error", new Error("write EPIPE"))).not.toThrow();
		expect(() => child?.stdout?.emit("error", new Error("read ECONNRESET"))).not.toThrow();

		// The kernel is still healthy: further cells keep executing and shutdown
		// (afterEach) still completes.
		const second = await manager.execute("x + 1");
		expect(second.status).toBe("ok");
		expect(second.result).toBe("2");
	}, 30_000);
});
