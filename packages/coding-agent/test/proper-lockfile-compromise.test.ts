import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lockState = vi.hoisted(() => ({ compromiseAsync: false, compromiseSync: false }));

type LockOptions = { onCompromised?: (error: Error) => void };
const releaseAsync = vi.fn(async () => {});
const releaseSync = vi.fn(() => {});

vi.mock("proper-lockfile", () => {
	const lock = vi.fn(async (_path: string, options?: LockOptions) => {
		if (lockState.compromiseAsync) options?.onCompromised?.(new Error("async lock compromised"));
		return releaseAsync;
	});
	const lockSync = vi.fn((_path: string, options?: LockOptions) => {
		if (lockState.compromiseSync) options?.onCompromised?.(new Error("sync lock compromised"));
		return releaseSync;
	});
	return { default: { lock, lockSync }, lock, lockSync };
});

import { acquireDaemonUpdateRestartCoordinator } from "../src/cli/daemon-update-restart.js";
import { FileAuthStorageBackend } from "../src/core/auth-storage.js";
import { AgentCronJobStore } from "../src/core/cron-jobs.js";
import { acquireSessionLease, SESSION_LEASES_ENABLED_ENV } from "../src/core/session-lease.js";
import { FileSettingsStorage } from "../src/core/settings-manager.js";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";
import { acquireDaemonSupervisorOwnership } from "../src/modes/daemon/daemon-supervisor-ownership.js";

const tempDirs: string[] = [];

beforeEach(() => {
	lockState.compromiseAsync = false;
	lockState.compromiseSync = false;
	releaseAsync.mockClear();
	releaseSync.mockClear();
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("proper-lockfile compromise boundaries", () => {
	it("records a socket lease compromise and fails before preparing the socket", async () => {
		lockState.compromiseAsync = true;
		const socketPath = join(tempDir("pa-lock-socket-"), "daemon.sock");
		const lease = await acquireDaemonSocketPathLease(socketPath);

		expect(lease?.compromise?.message).toBe("async lock compromised");
		await expect(prepareDaemonSocketPath(socketPath, lease)).rejects.toThrow(/was compromised/);
	});

	it.skipIf(process.platform === "win32")(
		"does not unlink a socket when the cleanup guard is compromised",
		async () => {
			lockState.compromiseSync = true;
			const socketPath = join(tempDir("pa-lock-cleanup-"), "daemon.sock");
			const server = createServer();
			try {
				await new Promise<void>((resolve) => server.listen(socketPath, resolve));
				cleanupDaemonSocketPath(socketPath);
				expect(existsSync(socketPath)).toBe(true);
			} finally {
				await new Promise<void>((resolve) => server.close(() => resolve()));
			}
		},
	);

	it("fails the supervisor ownership mutation closed", async () => {
		lockState.compromiseAsync = true;
		const root = tempDir("pa-lock-owner-");
		const registryDir = join(root, "registry");
		await expect(
			acquireDaemonSupervisorOwnership({
				socketPath: join(root, "daemon.sock"),
				descriptorDir: join(root, "descriptors"),
				agentDir: join(root, "agent"),
				generation: "compromised-owner",
				appVersion: "test",
				registryDir,
			}),
		).rejects.toThrow(/registry guard was compromised/);
		expect(existsSync(join(registryDir, "compromised-owner.owner"))).toBe(false);
	});

	it("fails the update coordinator mutation closed", async () => {
		lockState.compromiseAsync = true;
		const root = tempDir("pa-lock-update-");
		const registryDir = join(root, "registry");
		await expect(
			acquireDaemonUpdateRestartCoordinator({
				requestId: "request-1",
				socketPath: join(root, "daemon.sock"),
				statusPath: join(root, "status.json"),
				registryDir,
			}),
		).rejects.toThrow(/Coordinator registry guard was compromised/);
		expect(readdirSync(registryDir).filter((name) => name.endsWith(".json"))).toEqual([]);
	});

	it("does not create a session lease after its guard is compromised", () => {
		lockState.compromiseSync = true;
		const agentDir = tempDir("pa-lock-session-");
		expect(() =>
			acquireSessionLease(join(agentDir, "session.jsonl"), agentDir, { [SESSION_LEASES_ENABLED_ENV]: "1" }),
		).toThrow(/Session lease guard was compromised/);
		expect(readdirSync(join(agentDir, "session-leases"))).toEqual([]);
	});

	it("does not mutate auth storage after its lock is compromised", () => {
		lockState.compromiseSync = true;
		const authPath = join(tempDir("pa-lock-auth-"), "auth.json");
		const storage = new FileAuthStorageBackend(authPath);
		expect(() => storage.withLock(() => ({ result: undefined, next: "mutated" }))).toThrow(/lock compromised/);
		expect(readFileSync(authPath, "utf8")).toBe("{}");
	});

	it("does not mutate settings after its lock is compromised", () => {
		lockState.compromiseSync = true;
		const root = tempDir("pa-lock-settings-");
		const storage = new FileSettingsStorage(root, join(root, "agent"));
		expect(() => storage.withLock("global", () => "mutated")).toThrow(/lock compromised/);
		expect(existsSync(join(root, "agent", "settings.json"))).toBe(false);
	});

	it("does not mutate scheduled jobs after a lock compromise", () => {
		lockState.compromiseSync = true;
		const root = tempDir("pa-lock-cron-");
		const artifactDir = join(root, "artifact");
		const store = AgentCronJobStore.forSessionArtifacts();
		store.registerSessionArtifact("session-1", artifactDir);
		expect(() => store.recoverSessionArtifact("session-1")).toThrow(/Cron jobs lock compromised/);
		expect(existsSync(join(artifactDir, "scheduled-jobs.json"))).toBe(false);
	});
});
