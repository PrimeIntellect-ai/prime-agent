import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acquireDaemonSocketPathLease,
	cleanupDaemonSocketPath,
	prepareDaemonSocketPath,
} from "../src/modes/daemon/daemon-socket.js";

const isWindows = process.platform === "win32";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.skipIf(isWindows)("daemon socket path lease", () => {
	// proper-lockfile refreshes the lock's mtime on a timer and, when that refresh
	// finds the lock gone, calls onCompromised - which defaults to rethrowing from
	// inside the filesystem callback. The supervisor holds this lease for its whole
	// lifetime and installs no uncaughtException handler, so a lock steal used to
	// take the entire control plane down. Any regression surfaces here as an
	// unhandled error rather than as a failed assertion.
	it("records a stolen lease instead of throwing from the refresh callback", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-socket-lease-"));
		const socketPath = join(dir, "daemon.sock");

		const lease = await acquireDaemonSocketPathLease(socketPath);
		expect(lease).toBeDefined();
		if (!lease) return;

		// Simulate another process judging the lock stale and taking it over.
		rmSync(`${socketPath}.lock`, { recursive: true, force: true });
		await delay(2_000);

		expect(lease.compromisedError).toBeDefined();
		await lease.release().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}, 15_000);

	it("fails startup and skips cleanup once the lease is compromised", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-socket-lease-"));
		const socketPath = join(dir, "daemon.sock");

		const lease = await acquireDaemonSocketPathLease(socketPath);
		expect(lease).toBeDefined();
		if (!lease) return;

		rmSync(`${socketPath}.lock`, { recursive: true, force: true });
		await delay(2_000);

		await expect(prepareDaemonSocketPath(socketPath, lease)).rejects.toThrow(/compromised/);
		// Cleanup must not unlink a path a successor may already own, and must not throw.
		expect(() => cleanupDaemonSocketPath(socketPath, undefined, lease)).not.toThrow();

		await lease.release().catch(() => undefined);
		rmSync(dir, { recursive: true, force: true });
	}, 15_000);
});
