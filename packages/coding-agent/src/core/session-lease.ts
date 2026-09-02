import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { lockSync } from "proper-lockfile";

export const SESSION_LEASES_ENABLED_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASES";
export const SESSION_LEASE_OWNER_ID_ENV = "PRIME_AGENT_INTERNAL_SESSION_LEASE_OWNER_ID";

interface SessionLeaseOwner {
	version: 1;
	token: string;
	pid: number;
	processStartId?: string;
	activeSessionId?: string;
	sessionPath: string;
	createdAt: string;
}

export class SessionAlreadyActiveError extends Error {
	readonly code = "session_already_active" as const;

	constructor(
		readonly sessionPath: string,
		readonly activeSessionId?: string,
	) {
		super(
			activeSessionId
				? `Session is already active in ${activeSessionId}: ${sessionPath}`
				: `Session is already active in another process: ${sessionPath}`,
		);
		this.name = "SessionAlreadyActiveError";
	}
}

export class SessionLease {
	private released = false;

	constructor(
		readonly sessionPath: string,
		private readonly directory: string,
		private readonly token: string,
	) {}

	release(): void {
		if (this.released) {
			return;
		}
		this.released = true;
		try {
			withLeaseGuard(this.directory, () => {
				const owner = readLeaseOwner(this.directory);
				if (owner?.token === this.token) {
					reclaimStaleLease(this.directory);
				}
			});
		} catch {
			// Lease cleanup is best-effort. A stale owner is reclaimed by the next process.
		}
	}
}

function leasesEnabled(environment: NodeJS.ProcessEnv): boolean {
	const value = environment[SESSION_LEASES_ENABLED_ENV]?.toLowerCase();
	return value === "1" || value === "true" || value === "yes";
}

function leaseDirectory(agentDir: string, sessionPath: string): string {
	const key = createHash("sha256").update(sessionPath).digest("hex");
	return join(agentDir, "session-leases", `${key}.lock`);
}

export function canonicalSessionPath(sessionPath: string): string {
	const resolvedPath = resolve(sessionPath);
	try {
		return realpathSync(resolvedPath);
	} catch {
		try {
			return join(realpathSync(dirname(resolvedPath)), basename(resolvedPath));
		} catch {
			return resolvedPath;
		}
	}
}

function readLeaseOwner(directory: string): SessionLeaseOwner | undefined {
	const ownerPath = join(directory, "owner.json");
	let raw: string;
	try {
		raw = readFileSync(ownerPath, "utf8");
	} catch (error) {
		const err = error as NodeJS.ErrnoException;
		// ENOENT means no lease file exists - no owner.
		if (err.code === "ENOENT") {
			return undefined;
		}
		// EACCES/EPERM or any other read failure - fail closed rather than
		// reclaiming a possibly live lease we cannot read.
		throw error;
	}
	try {
		const parsed = JSON.parse(raw) as Partial<SessionLeaseOwner>;
		if (
			parsed.version !== 1 ||
			typeof parsed.token !== "string" ||
			typeof parsed.pid !== "number" ||
			typeof parsed.sessionPath !== "string" ||
			typeof parsed.createdAt !== "string"
		) {
			throw new TypeError(`Corrupt session lease owner file: ${ownerPath} (missing or invalid required fields)`);
		}
		return parsed as SessionLeaseOwner;
	} catch (error) {
		// Invalid/corrupt JSON or schema - fail closed instead of reclaiming.
		if (error instanceof SyntaxError || error instanceof TypeError) {
			throw new Error(`Corrupt session lease owner file: ${ownerPath} - ${(error as Error).message}`);
		}
		throw error;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

type ProcessQuery = (command: string, args: string[]) => string;

function runProcessQuery(command: string, args: string[]): string {
	return execFileSync(command, args, {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
}

export function getWindowsProcessStartId(pid: number, query: ProcessQuery = runProcessQuery): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	try {
		const startTicks = query("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`([System.Diagnostics.Process]::GetProcessById(${pid})).StartTime.ToUniversalTime().Ticks`,
		]).trim();
		return /^\d+$/.test(startTicks) ? `win:${startTicks}` : undefined;
	} catch {
		return undefined;
	}
}

export function getProcessStartId(pid: number): string | undefined {
	if (!Number.isInteger(pid) || pid <= 0) {
		return undefined;
	}
	if (process.platform === "win32") {
		return getWindowsProcessStartId(pid);
	}
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		const fields = stat.slice(commandEnd + 2).split(" ");
		const startTime = fields[19];
		if (startTime) {
			return `proc:${startTime}`;
		}
	} catch {
		// Fall through to the portable process listing used on macOS and BSD.
	}
	try {
		const startTime = runProcessQuery("ps", ["-p", String(pid), "-o", "lstart="]).trim();
		return startTime ? `ps:${startTime}` : undefined;
	} catch {
		return undefined;
	}
}

let currentProcessStartId: string | undefined;
let currentProcessStartIdRead = false;

function getCurrentProcessStartId(): string | undefined {
	if (!currentProcessStartIdRead) {
		currentProcessStartId = getProcessStartId(process.pid);
		currentProcessStartIdRead = true;
	}
	return currentProcessStartId;
}

function isLeaseOwnerAlive(owner: SessionLeaseOwner): boolean {
	if (!isProcessAlive(owner.pid)) {
		return false;
	}
	if (!owner.processStartId) {
		return true;
	}
	const currentStartId = getProcessStartId(owner.pid);
	return currentStartId === undefined || currentStartId === owner.processStartId;
}

function withLeaseGuard<T>(directory: string, action: () => T): T {
	let release: (() => void) | undefined;
	let guardCompromised = false;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(directory, {
				realpath: false,
				lockfilePath: `${directory}.guard`,
				stale: 5000,
				onCompromised: () => {
					guardCompromised = true;
				},
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw error;
			}
			if (attempt === 99) {
				throw new Error(`Could not coordinate session lease: ${directory}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) {
		throw new Error(`Could not coordinate session lease: ${directory}`);
	}
	const assertGuardHeld = () => {
		if (guardCompromised) throw new Error(`Session lease guard was compromised: ${directory}`);
	};
	try {
		assertGuardHeld();
		const result = action();
		assertGuardHeld();
		return result;
	} finally {
		if (guardCompromised) {
			try {
				release();
			} catch {
				// The compromised guard no longer owns a lock that can be safely released.
			}
		} else {
			release();
		}
	}
}

export function isRenameTargetContention(
	directory: string,
	code: string | undefined,
	platform: string = process.platform,
): boolean {
	// POSIX: renameSync into an existing directory raises EEXIST or ENOTEMPTY.
	if (code === "EEXIST" || code === "ENOTEMPTY") {
		return true;
	}
	// Windows: renameSync into an existing directory raises EPERM or EACCES
	// instead of EEXIST.  Only treat them as contention when the target
	// actually exists so real permission errors still propagate.
	if ((code === "EPERM" || code === "EACCES") && platform === "win32") {
		try {
			return existsSync(directory);
		} catch {
			return false;
		}
	}
	return false;
}

function reclaimStaleLease(directory: string): boolean {
	const stalePath = `${directory}.stale-${process.pid}-${randomUUID()}`;
	const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(directory, stalePath);
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return true;
			const transient = process.platform === "win32" && (code === "EBUSY" || code === "EPERM" || code === "EACCES");
			if (!transient || attempt >= 8) return false;
			Atomics.wait(sleepBuffer, 0, 0, 10 * attempt);
		}
	}
	try {
		rmSync(stalePath, { recursive: true, force: true, maxRetries: 8, retryDelay: 10 });
	} catch {
		// The quarantined directory no longer owns the lease path.
	}
	return true;
}

export function acquireSessionLease(
	sessionPath: string | undefined,
	agentDir: string,
	environment: NodeJS.ProcessEnv = process.env,
): SessionLease | undefined {
	if (!sessionPath || !leasesEnabled(environment)) {
		return undefined;
	}
	const canonicalPath = canonicalSessionPath(sessionPath);
	const root = join(agentDir, "session-leases");
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = leaseDirectory(agentDir, canonicalPath);

	return withLeaseGuard(directory, () => {
		for (let attempt = 0; attempt < 3; attempt++) {
			const token = randomUUID();
			const candidateDirectory = `${directory}.candidate-${process.pid}-${token}`;
			const owner: SessionLeaseOwner = {
				version: 1,
				token,
				pid: process.pid,
				processStartId: getCurrentProcessStartId(),
				activeSessionId: environment[SESSION_LEASE_OWNER_ID_ENV],
				sessionPath: canonicalPath,
				createdAt: new Date().toISOString(),
			};
			mkdirSync(candidateDirectory, { mode: 0o700 });
			writeFileSync(join(candidateDirectory, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
				mode: 0o600,
			});
			try {
				renameSync(candidateDirectory, directory);
				return new SessionLease(canonicalPath, directory, token);
			} catch (error) {
				const err = error as NodeJS.ErrnoException;
				rmSync(candidateDirectory, { recursive: true, force: true });
				if (err.code === "ENOENT") {
					// Candidate vanished - treat as retryable race.
					continue;
				}
				if (isRenameTargetContention(directory, err.code)) {
					const existingOwner = readLeaseOwner(directory);
					if (existingOwner && isLeaseOwnerAlive(existingOwner)) {
						throw new SessionAlreadyActiveError(canonicalPath, existingOwner.activeSessionId);
					}
					reclaimStaleLease(directory);
					continue;
				}
				throw error;
			}
		}

		const owner = existsSync(directory) ? readLeaseOwner(directory) : undefined;
		if (owner && isLeaseOwnerAlive(owner)) {
			throw new SessionAlreadyActiveError(canonicalPath, owner.activeSessionId);
		}
		throw new Error(`Could not acquire session lease: ${canonicalPath}`);
	});
}
