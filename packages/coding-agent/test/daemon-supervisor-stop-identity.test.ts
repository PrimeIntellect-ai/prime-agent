import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface StopHarness {
	stopWorker(worker: object, removeDescriptor: boolean, force?: boolean): Promise<void>;
}

async function spawnBystander(): Promise<ChildProcess> {
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000);"], {
		stdio: "ignore",
		detached: true,
	});
	await new Promise<void>((resolveSpawn, rejectSpawn) => {
		child.once("spawn", () => resolveSpawn());
		child.once("error", rejectSpawn);
	});
	return child;
}

describe("daemon supervisor stop process identity", () => {
	it("treats a reused worker pid as already stopped instead of signalling the imposter", async () => {
		// An unrelated live process stands in for a recycled pid: the descriptor
		// records the worker's original process start id, which no longer matches.
		const bystander = await spawnBystander();
		try {
			const worker = {
				stopRevision: 0,
				transcriptCaches: new Map(),
				snapshotCache: new Map(),
				descriptor: {
					workerId: "reused-pid-worker",
					pid: bystander.pid,
					processStartId: "ps:not-the-worker-start-time",
					lifecycle: "failed",
					createCommand: { type: "create", config: {} },
				},
			};
			const workers = new Map<string, object>([[worker.descriptor.workerId, worker]]);
			const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype), {
				workers,
				shuttingDown: true,
				persistWorker: vi.fn(),
				deleteWorkerDescriptor: vi.fn(),
				log: vi.fn(),
			}) as StopHarness;

			// Before the identity check, this signalled the bystander's process
			// group and then reported "did not stop after SIGKILL", leaving the
			// worker descriptor stuck at lifecycle "failed".
			await supervisor.stopWorker(worker, true, true);

			expect(workers.size).toBe(0);

			// Give a wrongly delivered SIGTERM/SIGKILL time to surface as an exit
			// event before asserting that the bystander was left untouched.
			await new Promise((resolveSettle) => setTimeout(resolveSettle, 250));
			expect(bystander.exitCode).toBeNull();
			expect(bystander.signalCode).toBeNull();
		} finally {
			try {
				bystander.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});
});
