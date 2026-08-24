import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { getProcessStartId } from "../src/core/session-lease.js";
import { DaemonSupervisor } from "../src/modes/daemon/daemon-supervisor.js";
import {
	acquireDaemonShutdownAdmission,
	acquireDaemonSupervisorOwnership,
	assertDaemonSupervisorOwnerCurrent,
	persistDaemonStartupFenceFromOwner,
} from "../src/modes/daemon/daemon-supervisor-ownership.js";
import { isZombieProcess } from "../src/utils/child-process.js";

type Ownership = Awaited<ReturnType<typeof acquireDaemonSupervisorOwnership>>;

interface OwnerRecord {
	token: string;
	generation: string;
	updatedAt: string;
	[key: string]: unknown;
}

const registryDirEnv = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";
const previousRegistryDirEnv = process.env[registryDirEnv];
const cleanupDirs: string[] = [];

afterEach(() => {
	if (previousRegistryDirEnv === undefined) {
		delete process.env[registryDirEnv];
	} else {
		process.env[registryDirEnv] = previousRegistryDirEnv;
	}
	while (cleanupDirs.length > 0) {
		const dir = cleanupDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

function createPaths(): {
	root: string;
	registryDir: string;
	socketPath: string;
	agentDir: string;
	descriptorDir: string;
} {
	const root = mkdtempSync(join(tmpdir(), "ownership-registry-"));
	cleanupDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	return {
		root,
		registryDir: join(root, "registry"),
		socketPath: join(root, "daemon.sock"),
		agentDir,
		descriptorDir: join(root, "workers"),
	};
}

async function acquire(paths: ReturnType<typeof createPaths>, generation = "registry-owner"): Promise<Ownership> {
	return acquireDaemonSupervisorOwnership({
		agentDir: paths.agentDir,
		appVersion: "test",
		descriptorDir: paths.descriptorDir,
		generation,
		registryDir: paths.registryDir,
		socketPath: paths.socketPath,
	});
}

function ownerDir(paths: ReturnType<typeof createPaths>, generation: string): string {
	return join(paths.registryDir, `${generation}.owner`);
}

function readJson(path: string): OwnerRecord {
	return JSON.parse(readFileSync(path, "utf8")) as OwnerRecord;
}

/**
 * Leave an unreaped child behind: the shell execs into `sleep` before the
 * background child exits, so nothing is left to wait on it.
 */
async function spawnZombie(): Promise<{ pid: number; cleanup: () => void }> {
	const parent = spawn("/bin/sh", ["-c", "sleep 0.3 & echo $!; exec sleep 30"], {
		stdio: ["ignore", "pipe", "ignore"],
	});
	const cleanup = () => parent.kill("SIGKILL");
	try {
		const pid = await new Promise<number>((resolvePid, rejectPid) => {
			const timer = setTimeout(() => rejectPid(new Error("timed out reading the zombie pid")), 5000);
			parent.stdout.once("data", (chunk: Buffer) => {
				clearTimeout(timer);
				resolvePid(Number(chunk.toString("utf8").trim()));
			});
			parent.once("error", (error) => {
				clearTimeout(timer);
				rejectPid(error);
			});
		});
		if (!Number.isInteger(pid) || pid <= 0) throw new Error(`unexpected zombie pid: ${pid}`);
		const deadline = Date.now() + 5000;
		while (!isZombieProcess(pid)) {
			if (Date.now() >= deadline) throw new Error(`process ${pid} never became a zombie`);
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
		}
		return { pid, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

describe("daemon supervisor ownership registry", () => {
	it("finds a live pre-move owner through the legacy registry when persisting a fence", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-owner",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
		});
		const record = legacyOwner.record;
		expect(record.processStartId).toBeDefined();
		const hello = {
			supervisorGeneration: record.generation,
			supervisorOwnerToken: record.token,
			supervisorPid: record.pid,
			supervisorProcessStartId: record.processStartId,
			supervisorSocketPath: record.socketPath,
		};
		const legacyOwnerPath = join(legacyDir, "legacy-owner.owner", "owner.json");
		const legacyBytes = readFileSync(legacyOwnerPath, "utf8");

		await persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir, legacyDir);

		expect(readdirSync(join(paths.registryDir, "startup-fences"))).toHaveLength(1);
		expect(readFileSync(legacyOwnerPath, "utf8")).toBe(legacyBytes);

		await expect(persistDaemonStartupFenceFromOwner(paths.socketPath, hello, paths.registryDir)).rejects.toThrow(
			/does not match/,
		);
		await legacyOwner.release();
	});

	it("validates a pre-move owner claim through the legacy registry", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const legacyOwner = await acquireDaemonSupervisorOwnership({
			agentDir: paths.agentDir,
			appVersion: "test",
			descriptorDir: paths.descriptorDir,
			generation: "legacy-claim-owner",
			registryDir: legacyDir,
			socketPath: paths.socketPath,
		});
		const identity = {
			generation: legacyOwner.record.generation,
			pid: legacyOwner.record.pid,
			...(legacyOwner.record.processStartId ? { processStartId: legacyOwner.record.processStartId } : {}),
			socketPath: legacyOwner.record.socketPath,
		};
		mkdirSync(paths.registryDir, { recursive: true });

		await expect(
			assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir, legacyDir),
		).resolves.toEqual(expect.any(String));

		await expect(assertDaemonSupervisorOwnerCurrent(identity, undefined, paths.registryDir)).rejects.toMatchObject({
			code: "supervisor_generation_stale",
		});
		await legacyOwner.release();
	});

	it("legacy registry reads never reclaim abandoned legacy directories", async () => {
		const paths = createPaths();
		const legacyDir = join(paths.root, "legacy-registry");
		const abandoned = join(legacyDir, "abandoned.owner");
		mkdirSync(abandoned, { recursive: true });

		await expect(
			persistDaemonStartupFenceFromOwner(paths.socketPath, {}, paths.registryDir, legacyDir),
		).rejects.toThrow(/does not match/);

		expect(existsSync(abandoned)).toBe(true);
	});

	it("marks ownership lost when the record is mismatched or absent", async () => {
		const paths = createPaths();
		const mismatched = await acquire(paths, "mismatched-owner");
		const mismatchedPath = join(ownerDir(paths, "mismatched-owner"), "owner.json");
		const foreign = { ...readJson(mismatchedPath), token: "successor-token" };
		writeFileSync(mismatchedPath, `${JSON.stringify(foreign, null, 2)}\n`);

		await expect(mismatched.assertCurrent()).rejects.toMatchObject({
			code: "supervisor_generation_stale",
			name: "DaemonSupervisorOwnershipLostError",
		});
		expect(readJson(mismatchedPath).token).toBe("successor-token");
		await mismatched.release();
		rmSync(ownerDir(paths, "mismatched-owner"), { recursive: true, force: true });

		const reaped = await acquire(paths, "reaped-owner");
		const reapedDir = ownerDir(paths, "reaped-owner");
		rmSync(reapedDir, { recursive: true, force: true });
		await expect(reaped.assertCurrent()).rejects.toMatchObject({ code: "supervisor_generation_stale" });
		expect(existsSync(reapedDir)).toBe(false);
		await reaped.release();
	});

	it("does not resurrect the shutdown admission when release overtakes an in-flight renew", async () => {
		const paths = createPaths();
		mkdirSync(paths.registryDir, { recursive: true, mode: 0o700 });
		process.env[registryDirEnv] = paths.registryDir;
		const admission = await acquireDaemonShutdownAdmission();
		const admissionPath = join(paths.registryDir, "shutdown-admission.json");
		expect(existsSync(admissionPath)).toBe(true);
		const dropGuard = await lockfile.lock(paths.registryDir, {
			realpath: false,
			lockfilePath: join(paths.registryDir, ".guard"),
		});
		const pending = admission.assertOrRenew();
		pending.catch(() => undefined);
		const releasing = admission.release();
		await dropGuard();
		await expect(pending).rejects.toMatchObject({ code: "daemon_shutdown_in_progress" });
		await releasing;
		expect(existsSync(admissionPath)).toBe(false);
	});

	it("disambiguates never-acquired from lost-on-disk ownership errors", async () => {
		const paths = createPaths();
		const supervisor = Object.assign(Object.create(DaemonSupervisor.prototype) as object, {
			ownership: undefined,
			generation: "unowned-generation",
			socketPath: paths.socketPath,
		});
		const assertCurrentOwnership = Reflect.get(supervisor, "assertCurrentOwnership") as () => Promise<void>;
		const neverAcquired = await assertCurrentOwnership
			.call(supervisor)
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!neverAcquired) throw new Error("assertCurrentOwnership did not throw");
		expect(neverAcquired.code).toBe("supervisor_generation_stale");
		expect(neverAcquired.message).toContain("holds no registry ownership");
		expect(neverAcquired.message).toContain(paths.socketPath);
		expect(neverAcquired.message).toContain("sessions are preserved");

		const ownership = await acquire(paths);
		const ownerPath = join(ownerDir(paths, ownership.record.generation), "owner.json");
		const foreign = { ...readJson(ownerPath), token: "successor-token" };
		writeFileSync(ownerPath, `${JSON.stringify(foreign, null, 2)}\n`);
		const lostOnDisk = await ownership
			.assertCurrent()
			.then(() => undefined)
			.catch((error: unknown) => error as Error & { code?: string });
		if (!lostOnDisk) throw new Error("assertCurrent did not throw");
		expect(lostOnDisk.code).toBe("supervisor_generation_stale");
		expect(lostOnDisk.message).toContain("no longer owns its registry entry");
		expect(lostOnDisk.message).toContain(paths.socketPath);
		expect(lostOnDisk.message).toContain(paths.registryDir);
		expect(lostOnDisk.message).toContain("sessions are preserved");
		expect(lostOnDisk.message).not.toBe(neverAcquired.message);
		await ownership.release();
	});

	it.skipIf(process.platform === "win32")("reclaims an owner whose process is an unreaped zombie", async () => {
		const paths = createPaths();
		const zombie = await spawnZombie();
		try {
			const abandoned = await acquire(paths, "zombie-owner");
			const abandonedPath = join(ownerDir(paths, "zombie-owner"), "owner.json");
			const startId = getProcessStartId(zombie.pid);
			writeFileSync(
				abandonedPath,
				`${JSON.stringify(
					{
						...readJson(abandonedPath),
						pid: zombie.pid,
						...(startId ? { processStartId: startId } : {}),
					},
					null,
					2,
				)}\n`,
			);

			// A zombie still answers kill(pid, 0), so a bare existence probe would
			// wedge every later launch behind DaemonSupervisorAlreadyRunningError.
			const successor = await acquire(paths, "successor-owner");
			expect(successor.record.pid).toBe(process.pid);
			expect(existsSync(ownerDir(paths, "zombie-owner"))).toBe(false);
			await successor.release();
			await abandoned.release().catch(() => undefined);
		} finally {
			zombie.cleanup();
		}
	});
});
