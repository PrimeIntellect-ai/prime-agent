import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";

interface IdentityHarness {
	stopWorker(worker: object, removeDescriptor: boolean, force?: boolean): Promise<void>;
	adoptOrRecoverWorker(worker: object): Promise<void>;
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

// An unrelated live process stands in for a recycled pid: each descriptor
// records the worker's original process start id, which no longer matches.
function reusedPidWorker(bystander: ChildProcess, descriptorOverrides: object = {}) {
	return {
		stopRevision: 0,
		transcriptCaches: new Map(),
		snapshotCache: new Map(),
		descriptor: {
			workerId: "reused-pid-worker",
			pid: bystander.pid,
			processStartId: "ps:not-the-worker-start-time",
			lifecycle: "failed",
			createCommand: { type: "create", config: {} },
			...descriptorOverrides,
		},
	};
}

function identityHarness(workers: Map<string, object>): IdentityHarness {
	return Object.assign(Object.create(DaemonSupervisor.prototype), {
		workers,
		shuttingDown: true,
		assertRecoveryAllowed: vi.fn(async () => undefined),
		persistWorker: vi.fn(),
		deleteWorkerDescriptor: vi.fn(),
		log: vi.fn(),
	}) as IdentityHarness;
}

async function expectUntouched(bystander: ChildProcess): Promise<void> {
	// Give a wrongly delivered SIGTERM/SIGKILL time to surface as an exit
	// event before asserting that the bystander was left untouched.
	await new Promise((resolveSettle) => setTimeout(resolveSettle, 250));
	expect(bystander.exitCode).toBeNull();
	expect(bystander.signalCode).toBeNull();
}

describe("daemon supervisor stop process identity", () => {
	it("treats a reused worker pid as already stopped instead of signalling the imposter", async () => {
		const bystander = await spawnBystander();
		try {
			const worker = reusedPidWorker(bystander);
			const workers = new Map<string, object>([[worker.descriptor.workerId, worker]]);
			const supervisor = identityHarness(workers);

			// Before the identity check, this signalled the bystander's process
			// group and then reported "did not stop after SIGKILL", leaving the
			// worker descriptor stuck at lifecycle "failed".
			await supervisor.stopWorker(worker, true, true);

			expect(workers.size).toBe(0);
			await expectUntouched(bystander);
		} finally {
			try {
				bystander.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});

	it("adopts a tombstoned descriptor with a reused pid without signalling or failing", async () => {
		const bystander = await spawnBystander();
		try {
			const worker = reusedPidWorker(bystander, {
				workerId: "tombstoned-reused-pid-worker",
				lifecycle: "recovering",
				stopRequestedAt: new Date().toISOString(),
			});
			const workers = new Map<string, object>([[worker.descriptor.workerId, worker]]);
			const supervisor = identityHarness(workers);

			// Before the identity check, adoption pre-killed the descriptor's pid
			// unconditionally, so the bystander was SIGKILLed here.
			await supervisor.adoptOrRecoverWorker(worker);

			expect(worker.descriptor.lifecycle).not.toBe("failed");
			expect(workers.size).toBe(0);
			await expectUntouched(bystander);
		} finally {
			try {
				bystander.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		}
	});
});
