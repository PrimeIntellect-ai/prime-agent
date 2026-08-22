import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.js";
import { createIpythonToolDefinition, IpythonKernelProvisioner } from "../src/core/tools/ipython.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((p): p is string => Boolean(p));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(
			python,
			["-c", "import ipykernel; assert int(ipykernel.__version__.split('.')[0]) >= 7"],
			{
				encoding: "utf8",
			},
		);
		if (check.status === 0) return python;
	}
	return null;
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;

describeIfKernel(
	"ipython tool stuck-cell auto-recovery (real kernel)",
	{ tags: ["kernel-heavy"], timeout: 180_000 },
	() => {
		let provisioner: IpythonKernelProvisioner | undefined;
		const savedEnv: Record<string, string | undefined> = {};

		function setEnv(key: string, value: string): void {
			savedEnv[key] = process.env[key];
			process.env[key] = value;
		}

		afterEach(async () => {
			for (const [key, value] of Object.entries(savedEnv)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await provisioner?.dispose();
			provisioner = undefined;
		});

		it("backgrounds a stuck cell, establishes stuckness across short re-polls, then auto-recovers", async () => {
			setEnv("PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS", "4000");
			setEnv("PRIME_AGENT_IPYTHON_REPOLL_TIMEOUT_MS", "2000");
			setEnv("PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS", "2");
			setEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);

			provisioner = new IpythonKernelProvisioner(process.cwd(), {});
			const tool = createIpythonToolDefinition(process.cwd(), { provisioner });
			const noUpdate = () => undefined;

			// Call 1: stuck cell -> backgrounded on the full (4s) budget, poll 1
			const first = await tool.execute(
				"call-1",
				{ code: "import asyncio\nmarker = 'kept'\nawait asyncio.Future()" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(first.details?.status).toBe("backgrounded");

			// Call 2: queues behind the stuck cell, re-polls on the short (2s) budget
			// -> silent poll 2 reaches the threshold -> ladder fires -> either this
			// call already returns its own result, or it reports the recovery.
			const second = await tool.execute(
				"call-2",
				{ code: "print('after', marker)" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			const recovered =
				second.details?.status === "ok" ||
				(second.details?.status === "backgrounded" &&
					typeof second.details?.recovery === "object" &&
					second.details.recovery.outcome === "recovered");
			expect(recovered).toBe(true);

			// Call 3: the kernel must be fully usable with pre-hang state intact.
			const third = await tool.execute(
				"call-3",
				{ code: "print('final', marker)" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(third.details?.status).toBe("ok");
			expect(third.details?.stdout).toContain("final kept");
		});

		it("does not fire weapons at a slow cell that prints progress", async () => {
			setEnv("PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS", "3000");
			setEnv("PRIME_AGENT_IPYTHON_REPOLL_TIMEOUT_MS", "2000");
			setEnv("PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS", "2");
			setEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);

			provisioner = new IpythonKernelProvisioner(process.cwd(), {});
			const tool = createIpythonToolDefinition(process.cwd(), { provisioner });
			const noUpdate = () => undefined;

			// Slow but healthy: prints every second for ~9s against a 3s timeout.
			const first = await tool.execute(
				"slow-1",
				{
					code: [
						"import time",
						"acc = 0",
						"for _i in range(9):",
						"    time.sleep(1)",
						"    acc += 1",
						"    print('tick', acc, flush=True)",
						"print('slow done', acc)",
					].join("\n"),
				},
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(first.details?.status).toBe("backgrounded");

			// Re-poll repeatedly; output keeps growing, so recovery must never fire
			// and the cell must eventually complete with acc == 9.
			let sawDone = false;
			for (let i = 0; i < 8 && !sawDone; i++) {
				const poll = await tool.execute(
					`slow-poll-${i}`,
					{ code: "print('acc =', acc)" },
					undefined,
					noUpdate,
					{} as ExtensionContext,
				);
				expect(poll.details?.recovery ?? undefined).toBeUndefined();
				if (poll.details?.status === "ok") {
					sawDone = true;
					expect(poll.details?.stdout).toContain("acc = 9");
				}
			}
			expect(sawDone).toBe(true);
		});

		it("restores the full timeout budget after a backgrounded cell completes", async () => {
			setEnv("PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS", "3000");
			setEnv("PRIME_AGENT_IPYTHON_REPOLL_TIMEOUT_MS", "1000");
			setEnv("PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS", "10");
			setEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);

			provisioner = new IpythonKernelProvisioner(process.cwd(), {});
			const tool = createIpythonToolDefinition(process.cwd(), { provisioner });
			const noUpdate = () => undefined;

			// Cell 1 exceeds the 3s budget but finishes on its own shortly after.
			const first = await tool.execute(
				"finishes-late",
				{ code: "import time\ntime.sleep(5)\nprint('late done')" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(first.details?.status).toBe("backgrounded");

			// Poll until the late cell's completion is consumed by a queued call.
			let completed = false;
			for (let i = 0; i < 8 && !completed; i++) {
				const poll = await tool.execute(
					`late-poll-${i}`,
					{ code: "print('ping')" },
					undefined,
					noUpdate,
					{} as ExtensionContext,
				);
				if (poll.details?.status === "ok") completed = true;
			}
			expect(completed).toBe(true);

			// A fresh independent cell needing ~2s must now get the FULL 3s budget,
			// not the 1s re-poll budget (which would background it).
			const fresh = await tool.execute(
				"fresh-after-recovery",
				{ code: "import time\ntime.sleep(2.5)\nprint('fresh ok')" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(fresh.details?.status).toBe("ok");
			expect(fresh.details?.stdout).toContain("fresh ok");
		});

		it("does not misclassify a verbose cell as stuck once retained output hits the cap", async () => {
			setEnv("PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS", "2000");
			setEnv("PRIME_AGENT_IPYTHON_REPOLL_TIMEOUT_MS", "1500");
			setEnv("PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS", "2");
			setEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);

			provisioner = new IpythonKernelProvisioner(process.cwd(), {});
			const tool = createIpythonToolDefinition(process.cwd(), { provisioner });
			const noUpdate = () => undefined;

			// Saturate the 64KiB retained-output cap immediately, then keep printing
			// (slowly) for ~8s. Capped stdout stops growing, but the uncapped stream
			// counter must keep the stuckness count at zero.
			const first = await tool.execute(
				"verbose-1",
				{
					code: [
						"import time",
						"print('x' * 70000)",
						"vdone = 0",
						"for _i in range(8):",
						"    time.sleep(1)",
						"    print('tick', _i, flush=True)",
						"vdone = 1",
						"print('verbose done')",
					].join("\n"),
				},
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(first.details?.status).toBe("backgrounded");

			let sawDone = false;
			for (let i = 0; i < 8 && !sawDone; i++) {
				const poll = await tool.execute(
					`verbose-poll-${i}`,
					{ code: "print('vdone =', vdone)" },
					undefined,
					noUpdate,
					{} as ExtensionContext,
				);
				expect(poll.details?.recovery ?? undefined).toBeUndefined();
				if (poll.details?.status === "ok") {
					sawDone = true;
					expect(poll.details?.stdout).toContain("vdone = 1");
				}
			}
			expect(sawDone).toBe(true);
		});

		it("keeps the short re-poll cadence when the queued cell is still running after a recovery", async () => {
			setEnv("PRIME_AGENT_IPYTHON_TOOL_TIMEOUT_MS", "3000");
			setEnv("PRIME_AGENT_IPYTHON_REPOLL_TIMEOUT_MS", "2000");
			setEnv("PRIME_AGENT_IPYTHON_STUCK_CELL_POLLS", "2");
			setEnv("PRIME_AGENT_KERNEL_PYTHON", python as string);

			provisioner = new IpythonKernelProvisioner(process.cwd(), {});
			const tool = createIpythonToolDefinition(process.cwd(), { provisioner });
			const noUpdate = () => undefined;

			// Stuck cell -> backgrounded with silent poll 1 counted.
			const first = await tool.execute(
				"reseed-stuck",
				{ code: "import asyncio\nawait asyncio.Future()" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			expect(first.details?.status).toBe("backgrounded");

			// Queued behind the stuck cell, this call re-polls on the 2s budget,
			// counts silent poll 2, and fires recovery; its own cell (sleep 8)
			// then runs but cannot finish inside the 3s settle window ->
			// backgrounded with the tracker re-seeded to the NEW execution.
			const second = await tool.execute(
				"reseed-long",
				{ code: "import time\ntime.sleep(8)\nprint('long done')" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			if (second.details?.status !== "backgrounded") {
				// The recovery's interrupt can also hit this call's own queued cell
				// (residual SIGINT) or the cell can finish inside the settle window;
				// both yield a real result, which correctly resets the tracker. The
				// re-seed path only exists for a backgrounded return.
				return;
			}

			// The next call must run on the short 2s re-poll budget, not the full
			// 3s first-call budget stacked behind an 8s cell (which would take ~8s).
			const started = Date.now();
			const third = await tool.execute(
				"reseed-poll",
				{ code: "print('quick')" },
				undefined,
				noUpdate,
				{} as ExtensionContext,
			);
			const elapsed = Date.now() - started;
			if (third.details?.status === "backgrounded") {
				expect(elapsed).toBeLessThan(4000);
			}
		});
	},
);
