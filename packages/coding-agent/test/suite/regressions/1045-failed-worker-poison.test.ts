import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getProcessStartId } from "../../../src/core/session-lease.js";
import type { DaemonSocketClient } from "../../../src/modes/daemon/active-session-state.js";
import { type DaemonCommand, type DaemonResponse, success } from "../../../src/modes/daemon/daemon-protocol.js";
import { DaemonSupervisor } from "../../../src/modes/daemon/daemon-supervisor.js";

/**
 * Issue #1045: Failed worker poisons heartbeats_list
 *
 * A failed worker with a recycled pid was being treated as alive and signalled
 * during stop, and a failed lifecycle prevented heartbeat aggregation from
 * succeeding even though the worker was never going to respond.
 */

interface IdentityHarness {
	stopWorker(worker: object, removeDescriptor: boolean, force?: boolean): Promise<void>;
	adoptOrRecoverWorker(worker: object): Promise<void>;
	deleteWorkerDescriptor: ReturnType<typeof vi.fn>;
}

interface SupervisorHarness {
	workers: Map<string, unknown>;
	forwardToWorker(worker: unknown, command: DaemonCommand, timeoutMs?: number): Promise<DaemonResponse>;
	handleCommand(client: DaemonSocketClient, command: DaemonCommand): Promise<DaemonResponse | undefined>;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

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
// The forged token uses the SAME format the platform observes - a mismatch is
// only trusted within one rendering format; cross-format inequality degrades
// to unverifiable by design.
function reusedPidWorker(bystander: ChildProcess, descriptorOverrides: object = {}) {
	const observed = getProcessStartId(bystander.pid ?? process.pid);
	const format = observed?.slice(0, observed.indexOf(":")) ?? "ps2";
	return {
		stopRevision: 0,
		transcriptCaches: new Map(),
		snapshotCache: new Map(),
		descriptor: {
			workerId: "reused-pid-worker",
			pid: bystander.pid,
			processStartId: `${format}:not-the-worker-start-time`,
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

function createSupervisorHarness(): SupervisorHarness {
	const directory = mkdtempSync(join(tmpdir(), "prime-supervisor-heartbeats-"));
	tempDirs.push(directory);
	return new DaemonSupervisor(join(directory, "daemon.sock"), {
		defaultSessionConfig: { agentDir: directory, cwd: directory },
		descriptorDir: join(directory, "workers"),
	}) as unknown as SupervisorHarness;
}

function worker(lifecycle: "ready" | "recovering", connected = true) {
	return {
		descriptor: { lifecycle },
		...(connected ? { client: {} } : {}),
	};
}

describe("issue #1045 failed worker poisons heartbeats_list", () => {
	describe("process identity verification", () => {
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

	describe("process identity portability", () => {
		it("renders the same portable start id regardless of the ambient timezone", () => {
			const original = process.env.TZ;
			try {
				process.env.TZ = "UTC";
				const underUtc = getProcessStartId(process.pid);
				process.env.TZ = "America/Los_Angeles";
				const underLa = getProcessStartId(process.pid);
				expect(underUtc).toBeDefined();
				expect(underLa).toBe(underUtc);
			} finally {
				if (original === undefined) delete process.env.TZ;
				else process.env.TZ = original;
			}
		});

		it("keeps a worker with a legacy-format start id tracked instead of reaping it", async () => {
			const bystander = await spawnBystander();
			try {
				// A descriptor recorded by an older build under an unknown ambient
				// timezone: inequality against today's pinned rendering proves
				// nothing about PID reuse, so the worker must stay tracked (and
				// must not be signalled either).
				const worker = reusedPidWorker(bystander, {
					workerId: "legacy-format-worker",
					processStartId: "ps:Sun Aug  9 08:38:24 2026",
				});
				const workers = new Map<string, object>([[worker.descriptor.workerId, worker]]);
				const supervisor = identityHarness(workers);

				await supervisor.stopWorker(worker, true, true).catch(() => undefined);

				// Unverifiable identity: the descriptor survives for a later sweep
				// with better evidence, and the bystander is untouched.
				expect(supervisor.deleteWorkerDescriptor).not.toHaveBeenCalled();
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

	describe("heartbeat aggregation", () => {
		it("skips failed workers instead of failing the whole global listing", async () => {
			const supervisor = createSupervisorHarness();
			const healthy = worker("ready");
			const failed = { descriptor: { lifecycle: "failed" } };
			supervisor.workers.set("healthy", healthy);
			supervisor.workers.set("failed", failed);
			supervisor.forwardToWorker = vi.fn(async (_target, command) =>
				success(command.id, command.type, { heartbeats: [{ job: { id: "heartbeat-1" } }] }),
			);

			const response = await supervisor.handleCommand({} as DaemonSocketClient, {
				id: "list-4",
				type: "heartbeats_list",
			});

			expect(response).toMatchObject({
				success: true,
				data: { heartbeats: [{ job: { id: "heartbeat-1" } }] },
			});
			expect(supervisor.forwardToWorker).toHaveBeenCalledOnce();
			expect(supervisor.forwardToWorker).toHaveBeenCalledWith(healthy, expect.anything(), expect.anything());
		});
	});
});
