import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DIFF_DISPLAY_MIME, KernelManager } from "../src/core/kernel/index.js";

function resolveKernelPython(): string | null {
	const candidates = [
		process.env.PRIME_AGENT_KERNEL_PYTHON,
		join(homedir(), ".prime", "agent", "kernel-venv", "bin", "python"),
	].filter((path): path is string => Boolean(path));
	for (const python of candidates) {
		if (!existsSync(python)) continue;
		const check = spawnSync(python, ["-c", "import ipykernel, dill, IPython"], { encoding: "utf8" });
		if (check.status === 0) return python;
	}
	return null;
}

interface KernelInternals {
	activeExecution?: { requestMsgId: string };
}

const python = resolveKernelPython();
const describeIfKernel = python ? describe : describe.skip;
const runtimeSource = join(import.meta.dirname, "../../../prime-agent-runtime/src");

describeIfKernel("shared-kernel Act feasibility (real kernel)", { tags: ["kernel-heavy"] }, () => {
	let tempDir = "";
	let previousForkserver: string | undefined;

	beforeAll(() => {
		tempDir = mkdtempSync(join(tmpdir(), "prime-agent-kernel-act-"));
		previousForkserver = process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		process.env.PRIME_AGENT_KERNEL_FORKSERVER = "0";
	});

	afterAll(() => {
		if (previousForkserver === undefined) {
			delete process.env.PRIME_AGENT_KERNEL_FORKSERVER;
		} else {
			process.env.PRIME_AGENT_KERNEL_FORKSERVER = previousForkserver;
		}
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	function newManager(options: { snapshot?: { path: string; manifestPath: string } } = {}): KernelManager {
		return new KernelManager({
			python: python as string,
			cwd: tempDir,
			env: {
				PYTHONPATH: [runtimeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter),
			},
			snapshot: options.snapshot,
		});
	}

	it("runs full inner cells in the outer namespace and returns exact identity", async () => {
		const activeExecutions: object[] = [];
		let manager: KernelManager;
		manager = new KernelManager({
			python: python as string,
			cwd: tempDir,
			env: { PYTHONPATH: [runtimeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
			hostHandlers: {
				"act.probe.active": async () => {
					const execution = (manager as unknown as KernelInternals).activeExecution;
					if (!execution) throw new Error("Act probe has no outer active execution");
					activeExecutions.push(execution);
					return { request_msg_id: execution.requestMsgId };
				},
			},
		});
		try {
			const result = await manager.execute(`
import asyncio
import sys
from IPython.display import display
from rlm import host_request
from rlm._act import _run_cells, done

outer_object = object()
async def requested_cells():
    yield "inner_seen = outer_object\\nprint('inner-stdout')\\nprint('inner-stderr', file=sys.stderr)"
    yield "await asyncio.sleep(0)\\ntop_level_await = True"
    yield "%%bash\\necho inner-bash"
    yield """display({${JSON.stringify(DIFF_DISPLAY_MIME)}: {'path': '/tmp/act-proof', 'old_str': 'before', 'new_str': 'after'}}, raw=True)"""
    yield "first_active = await host_request('act.probe.active')"
    yield "second_active = await host_request('act.probe.active')"
    yield "done(outer_object)\\nafter_done = True"

returned = await _run_cells(requested_cells())
print('identity', returned is outer_object)
'outer-result'
`);

			expect(result.status).toBe("ok");
			expect(result.result).toBe("'outer-result'");
			expect(result.stdout).toContain("inner-stdout");
			expect(result.stdout).toContain("inner-bash");
			expect(result.stdout).toContain("identity True");
			expect(result.stderr).toContain("inner-stderr");
			expect(result.diffs).toEqual([
				{ path: "/tmp/act-proof", oldStr: "before", newStr: "after", startLine: undefined },
			]);
			expect(activeExecutions).toHaveLength(2);
			expect(activeExecutions[0]).toBe(activeExecutions[1]);

			const namespace = await manager.execute(
				"print(inner_seen is outer_object, top_level_await, 'after_done' in globals())",
			);
			expect(namespace.status).toBe("ok");
			expect(namespace.stdout.trim()).toBe("True True False");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("exchanges cells and completion over one duplex Act request", async () => {
		const manager = new KernelManager({
			python: python as string,
			cwd: tempDir,
			env: { PYTHONPATH: [runtimeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
			hostHandlers: {
				"rlm.act": async (_payload, _signal, channel) => {
					if (!channel) throw new Error("missing duplex channel");
					await channel.send({
						type: "cell",
						code: "shared_number = 21\nprint('lane-output')\nshared_number * 2",
					});
					const cellResult = await channel.receive();
					expect(cellResult).toMatchObject({
						type: "cell_result",
						stdout: "lane-output\n",
						result: "42",
						error: null,
					});
					await channel.send({ type: "cell", code: "rlm.done(outer_object)" });
					expect(await channel.receive()).toEqual({ type: "done" });
					return { outcome: "done" };
				},
			},
		});
		try {
			const result = await manager.execute(`
import rlm
outer_object = object()
returned = await rlm.act("use the shared object")
print(returned is outer_object, shared_number)
`);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("lane-output");
			expect(result.stdout.trimEnd()).toMatch(/True 21$/);
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("surfaces an ordinary inner error and leaves the kernel reusable", async () => {
		const manager = newManager();
		try {
			const result = await manager.execute(`
from rlm._act import _run_cells, done
async def requested_cells():
    yield "raise ValueError('inner boom')"
    yield "recovered_after_error = True\\ndone('recovered')"
returned = await _run_cells(requested_cells())
print(returned)
`);
			expect(result.status).toBe("error");
			expect(result.error).toMatchObject({ ename: "ValueError", evalue: "inner boom" });
			expect(result.stdout.trim()).toBe("recovered");

			const reuse = await manager.execute("print(recovered_after_error)");
			expect(reuse.status).toBe("ok");
			expect(reuse.stdout.trim()).toBe("True");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("cancels the inner cell cooperatively and accepts a later root cell", async () => {
		let releaseCancel: () => void = () => {};
		const cancelRequested = new Promise<void>((resolve) => {
			releaseCancel = resolve;
		});
		const manager = new KernelManager({
			python: python as string,
			cwd: tempDir,
			env: { PYTHONPATH: [runtimeSource, process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
			hostHandlers: {
				"act.probe.cancel": async () => {
					await cancelRequested;
					return {};
				},
			},
		});
		try {
			const result = await manager.execute(
				`from rlm import host_request
from rlm._act import _ActInterrupted, _run_cells
async def requested_cells():
    yield "print('inner-started', flush=True)\\nimport asyncio\\nawait asyncio.sleep(60)"
try:
    await _run_cells(requested_cells(), cancel=host_request('act.probe.cancel'))
except _ActInterrupted:
    print('act-cancelled')`,
				{
					onStream: (chunk) => {
						if (chunk.includes("inner-started")) releaseCancel();
					},
				},
			);
			expect(result.status).toBe("ok");
			expect(result.stdout).toContain("act-cancelled");

			const reuse = await manager.execute("print('reusable')");
			expect(reuse.status).toBe("ok");
			expect(reuse.stdout.trim()).toBe("reusable");
		} finally {
			await manager.dispose();
		}
	}, 60_000);

	it("snapshots completed state without replaying the Act", async () => {
		const snapshot = {
			path: join(tempDir, "act-state.dill"),
			manifestPath: join(tempDir, "act-state.json"),
		};
		const writer = newManager({ snapshot });
		try {
			const result = await writer.execute(`
from rlm._act import _run_cells, done
async def requested_cells():
    yield "snapshot_counter = globals().get('snapshot_counter', 0) + 1\\ndone(None)"
returned = await _run_cells(requested_cells())
print(returned is None)
`);
			expect(result.status).toBe("ok");
			expect(result.stdout.trim()).toBe("True");
			const saved = await writer.snapshotState();
			expect(saved?.saved).toContain("snapshot_counter");
		} finally {
			await writer.dispose();
		}

		const reader = newManager({ snapshot });
		try {
			const restored = await reader.restoreState();
			expect(restored?.restored).toContain("snapshot_counter");
			const state = await reader.execute("print(snapshot_counter)");
			expect(state.status).toBe("ok");
			expect(state.stdout.trim()).toBe("1");
		} finally {
			await reader.dispose();
		}
	}, 60_000);
});
