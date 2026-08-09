import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import {
	acquireSessionLease,
	canonicalSessionPath,
	getWindowsProcessStartId,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
	SessionAlreadyActiveError,
	sweepStaleSessionLeases,
} from "../src/core/session-lease.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const directory of tempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const directory = mkdtempSync(join(tmpdir(), "prime-session-lease-test-"));
	tempDirs.push(directory);
	return directory;
}

function enabledEnvironment(owner: string): NodeJS.ProcessEnv {
	return {
		[SESSION_LEASES_ENABLED_ENV]: "1",
		[SESSION_LEASE_OWNER_ID_ENV]: owner,
	};
}

describe("session leases", () => {
	it("reads an invariant process start identity on Windows", () => {
		const calls: Array<{ command: string; args: string[] }> = [];
		const processStartId = getWindowsProcessStartId(42, (command, args) => {
			calls.push({ command, args });
			return "638880485801234567\r\n";
		});

		expect(processStartId).toBe("win:638880485801234567");
		expect(calls).toEqual([
			{
				command: "powershell.exe",
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					"([System.Diagnostics.Process]::GetProcessById(42)).StartTime.ToUniversalTime().Ticks",
				],
			},
		]);
	});

	it("rejects invalid Windows process start identities", () => {
		let queryCount = 0;
		const query = () => {
			queryCount++;
			return "not-a-start-time";
		};

		expect(getWindowsProcessStartId(42, query)).toBeUndefined();
		expect(getWindowsProcessStartId(0, query)).toBeUndefined();
		expect(queryCount).toBe(1);
	});

	it("rejects a second live owner with a typed active-session error", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		try {
			acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		} catch (error) {
			expect(error).toMatchObject({
				code: "session_already_active",
				activeSessionId: "resident-a",
				sessionPath: canonicalSessionPath(sessionPath),
			});
		}

		first?.release();
		const second = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("owned-b"));
		expect(second?.sessionPath).toBe(canonicalSessionPath(sessionPath));
		second?.release();
	});

	it("reclaims a lease whose owner process is gone", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "stale.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: 2_147_483_647,
				activeSessionId: "dead-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("reports guard contention as a coordination failure", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(join(agentDir, "session.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const leaseRoot = join(agentDir, "session-leases");
		const lockDirectory = join(leaseRoot, `${key}.lock`);
		mkdirSync(leaseRoot, { recursive: true });
		const release = lockSync(lockDirectory, {
			realpath: false,
			lockfilePath: `${lockDirectory}.guard`,
			stale: 5000,
		});

		try {
			let thrown: unknown;
			try {
				acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect(thrown).not.toBeInstanceOf(SessionAlreadyActiveError);
			expect((thrown as Error).message).toContain("Could not coordinate session lease");
		} finally {
			release();
		}
	});

	it("treats symlink aliases as the same persisted session", () => {
		const agentDir = createTempDir();
		const sessionPath = join(agentDir, "session.jsonl");
		const aliasPath = join(agentDir, "session-alias.jsonl");
		writeFileSync(sessionPath, "");
		symlinkSync(sessionPath, aliasPath);
		const first = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("resident-a"));

		expect(() => acquireSessionLease(aliasPath, agentDir, enabledEnvironment("owned-b"))).toThrow(
			SessionAlreadyActiveError,
		);
		first?.release();
	});

	it("reclaims a lease after its pid has been reused", () => {
		const agentDir = createTempDir();
		const sessionPath = canonicalSessionPath(resolve(agentDir, "reused-pid.jsonl"));
		const key = createHash("sha256").update(sessionPath).digest("hex");
		const lockDirectory = join(agentDir, "session-leases", `${key}.lock`);
		mkdirSync(lockDirectory, { recursive: true });
		writeFileSync(
			join(lockDirectory, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: process.pid,
				processStartId: "different-process",
				activeSessionId: "old-owner",
				sessionPath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const lease = acquireSessionLease(sessionPath, agentDir, enabledEnvironment("replacement"));
		expect(lease?.sessionPath).toBe(sessionPath);
		lease?.release();
	});

	it("is inert for direct SDK runtimes unless worker isolation enables it", () => {
		const agentDir = createTempDir();
		expect(acquireSessionLease(join(agentDir, "session.jsonl"), agentDir, {})).toBeUndefined();
	});

	it("sweeps stale leases at startup while keeping live ones", () => {
		const agentDir = createTempDir();

		// Stale lease: owner PID does not exist.
		const stalePath = canonicalSessionPath(resolve(agentDir, "stale.jsonl"));
		const staleKey = createHash("sha256").update(stalePath).digest("hex");
		const staleDir = join(agentDir, "session-leases", `${staleKey}.lock`);
		mkdirSync(staleDir, { recursive: true });
		writeFileSync(
			join(staleDir, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "stale",
				pid: 2_147_483_647,
				activeSessionId: "dead-owner",
				sessionPath: stalePath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		// Live lease: owner is this process.
		const livePath = canonicalSessionPath(resolve(agentDir, "live.jsonl"));
		const liveKey = createHash("sha256").update(livePath).digest("hex");
		const liveDir = join(agentDir, "session-leases", `${liveKey}.lock`);
		mkdirSync(liveDir, { recursive: true });
		writeFileSync(
			join(liveDir, "owner.json"),
			JSON.stringify({
				version: 1,
				token: "live",
				pid: process.pid,
				activeSessionId: "this-process",
				sessionPath: livePath,
				createdAt: new Date(0).toISOString(),
			}),
		);

		const swept = sweepStaleSessionLeases(agentDir);
		expect(swept).toBe(1);
		expect(existsSync(staleDir)).toBe(false);
		expect(existsSync(liveDir)).toBe(true);
	});

	it("handles a missing session-leases directory gracefully", () => {
		const agentDir = createTempDir();
		expect(sweepStaleSessionLeases(agentDir)).toBe(0);
	});
});
