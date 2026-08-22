import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KernelManager } from "../src/core/kernel/index.js";

/** Find a python that can launch an ipykernel with JEP-91 subshells, or null to skip. */
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

/** Start a hang cell; resolves once the execute call settles (post-recovery). */
function startHang(manager: KernelManager, code: string) {
	const promise = manager.execute(code);
	promise.catch(() => undefined);
	return promise;
}

async function letCellWedge(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1500));
}

describeIfKernel("kernel stuck-cell recovery (real kernel)", { tags: ["kernel-heavy"], timeout: 120_000 }, () => {
	let manager: KernelManager | undefined;

	afterEach(async () => {
		await manager?.dispose();
		manager = undefined;
	});

	function newManager(): KernelManager {
		manager = new KernelManager({ python: python as string, cwd: process.cwd() });
		return manager;
	}

	it("recovers a stuck top-level await via cross-thread task cancel", async () => {
		const m = newManager();
		const hang = startHang(m, "import asyncio\nv1 = 'kept'\nawait asyncio.Future()");
		await letCellWedge();

		const result = await m.recoverStuckExecution();
		expect(result).toEqual({ outcome: "recovered", weapon: "task-cancel" });

		const stuck = await hang;
		expect(stuck.status).toBe("error");

		const after = await m.execute("print('main', v1)");
		expect(after.status).toBe("ok");
		expect(after.stdout).toContain("main kept");
	});

	it("recovers a sync sleep via interrupt", async () => {
		const m = newManager();
		const hang = startHang(m, "import time\nv2 = 'kept'\ntime.sleep(3600)");
		await letCellWedge();

		const result = await m.recoverStuckExecution();
		expect(result).toEqual({ outcome: "recovered", weapon: "interrupt" });

		await hang;
		const after = await m.execute("print('main', v2)");
		expect(after.status).toBe("ok");
		expect(after.stdout).toContain("main kept");
	});

	it("recovers sync-blocking-inside-async via gated async-exc", async () => {
		const m = newManager();
		const hang = startHang(m, "import time\nasync def _blk():\n    time.sleep(3600)\nv3 = 'kept'\nawait _blk()");
		await letCellWedge();

		const result = await m.recoverStuckExecution();
		expect(result).toEqual({ outcome: "recovered", weapon: "async-exc" });

		await hang;
		const after = await m.execute("print('main', v3)");
		expect(after.status).toBe("ok");
		expect(after.stdout).toContain("main kept");
	});

	it("runs recovery-lane cells over the shared namespace while a cell is stuck, without disturbing it", async () => {
		const m = newManager();
		const hang = startHang(m, "import asyncio\nshared = 41\nawait asyncio.Future()");
		await letCellWedge();

		expect(await m.probeControlAlive()).toBe(true);
		const lane = await m.executeInRecoverySubshell("print('lane sees', shared)\nshared2 = shared + 1");
		expect(lane.status).toBe("ok");
		expect(lane.output).toContain("lane sees 41");

		// non-destructive: the stuck cell is still running (execute promise pending)
		let hangSettled = false;
		void hang.finally(() => {
			hangSettled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(hangSettled).toBe(false);

		// then recover; lane writes must be visible from the main shell
		const result = await m.recoverStuckExecution();
		expect(result.outcome).toBe("recovered");
		await hang;
		const after = await m.execute("print('shared2 =', shared2)");
		expect(after.stdout).toContain("shared2 = 42");
	});

	it("degrades to recovery-lane-only when the cell swallows cancellation", async () => {
		const m = newManager();
		const hang = startHang(
			m,
			[
				"import asyncio",
				"v6 = 'kept'",
				"async def _st():",
				"    while True:",
				"        try:",
				"            await asyncio.sleep(3600)",
				"        except BaseException:",
				"            continue",
				"await _st()",
			].join("\n"),
		);
		hang.catch(() => undefined);
		await letCellWedge();

		const result = await m.recoverStuckExecution();
		expect(result.outcome).toBe("recovery-lane-only");

		const lane = await m.executeInRecoverySubshell("print('lane', v6)");
		expect(lane.status).toBe("ok");
		expect(lane.output).toContain("lane kept");
	});

	it("reports kernel-unresponsive within seconds when the GIL is held", async () => {
		const m = newManager();
		const hang = startHang(m, "import re\nre.match(r'(a+)+$', 'a'*40 + 'b')");
		hang.catch(() => undefined);
		await letCellWedge();

		const started = Date.now();
		const result = await m.recoverStuckExecution();
		expect(result.outcome).toBe("kernel-unresponsive");
		expect(Date.now() - started).toBeLessThan(15_000);
	});

	it("survives repeated hang/recover cycles on one kernel", async () => {
		const m = newManager();
		await m.execute("counter = 0");
		const hangs = [
			"import asyncio\nawait asyncio.Future()",
			"import time\ntime.sleep(3600)",
			"import asyncio\nawait asyncio.Future()",
		];
		for (let i = 0; i < hangs.length; i++) {
			const hang = startHang(m, `counter += 1\n${hangs[i]}`);
			await letCellWedge();
			const result = await m.recoverStuckExecution();
			expect(result.outcome).toBe("recovered");
			await hang;
			const check = await m.execute(`print('cycle', counter)`);
			expect(check.stdout).toContain(`cycle ${i + 1}`);
		}
	});
});
