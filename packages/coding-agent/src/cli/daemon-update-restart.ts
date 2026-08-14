import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import lockfile from "proper-lockfile";
import { ENV_AGENT_DIR, SELF_UPDATE_INTERACTIVE_CHILD_ENV } from "../config.js";
import { ORPHAN_PROCESS_JOURNAL_ENV } from "../core/orphan-process-journal.js";
import {
	compareProcessStartIds,
	getProcessStartId,
	SESSION_LEASE_OWNER_ID_ENV,
	SESSION_LEASES_ENABLED_ENV,
} from "../core/session-lease.js";
import { defaultDaemonSocketDir, defaultDaemonSocketPath } from "../modes/daemon/daemon-socket.js";
import {
	DAEMON_WORKER_ACTIVE_SESSION_ID_ENV,
	DAEMON_WORKER_RECOVERY_JOURNAL_ENV,
	DAEMON_WORKER_ROLE_ENV,
	DAEMON_WORKER_SUPERVISOR_SOCKET_ENV,
	DAEMON_WORKER_TOKEN_ENV,
} from "../modes/daemon/daemon-worker-protocol.js";
import { createCliSubprocessLaunchSpec } from "./subprocess-launch.js";

export const DAEMON_UPDATE_RESTART_COORDINATOR_FLAG = "--internal-update-restart-coordinator";
export const DAEMON_UPDATE_RESTART_STATUS_FLAG = "--internal-update-restart-status";
export const DAEMON_UPDATE_RESTART_ORIGIN_FLAG = "--internal-update-restart-origin";

export type DaemonUpdateRestartPhase =
	| "starting"
	| "preparing"
	| "stopping"
	| "starting_daemon"
	| "restoring"
	| "complete"
	| "skipped"
	| "failed";

export interface DaemonUpdateRestartCounts {
	total: number;
	restored: number;
	resumed: number;
	failed: number;
}

export interface DaemonUpdateRestartFailure {
	sessionFile: string;
	message: string;
}

export interface DaemonUpdateRestartProcessIdentity {
	pid: number;
	processStartId?: string;
	supervisorGeneration?: string;
	supervisorOwnerToken?: string;
}

export interface DaemonUpdateRestartStatus {
	version: 1;
	requestId: string;
	socketPath: string;
	phase: DaemonUpdateRestartPhase;
	coordinator: DaemonUpdateRestartProcessIdentity;
	predecessor?: DaemonUpdateRestartProcessIdentity;
	successor?: DaemonUpdateRestartProcessIdentity;
	counts: DaemonUpdateRestartCounts;
	failures?: DaemonUpdateRestartFailure[];
	message?: string;
	startedAt: string;
	updatedAt: string;
	heartbeatAt?: string;
}

export interface DaemonUpdateRestartReport {
	info: string[];
	warnings: string[];
}

export interface DaemonUpdateRestartCoordinatorRecord extends DaemonUpdateRestartProcessIdentity {
	version: 1;
	token: string;
	requestId: string;
	socketPath: string;
	statusPath: string;
	createdAt: string;
}

export interface LaunchDaemonUpdateRestartCoordinatorOptions {
	socketPath: string;
	agentDir: string;
	cwd?: string;
	originActiveSessionId?: string;
	timeoutMs?: number;
}

export interface AcquireDaemonUpdateRestartCoordinatorOptions {
	requestId: string;
	socketPath: string;
	statusPath: string;
	registryDir?: string;
}

export function resolveDaemonUpdateRestartSocketPath(socketPath?: string): string {
	const selectedSocketPath = socketPath ?? defaultDaemonSocketPath();
	return process.platform === "win32" ? selectedSocketPath : resolve(selectedSocketPath);
}

const TERMINAL_PHASES: ReadonlySet<DaemonUpdateRestartPhase> = new Set(["complete", "skipped", "failed"]);
const ALL_PHASES: ReadonlySet<DaemonUpdateRestartPhase> = new Set([
	"starting",
	"preparing",
	"stopping",
	"starting_daemon",
	"restoring",
	"complete",
	"skipped",
	"failed",
]);
const DEFAULT_COORDINATOR_PROGRESS_TIMEOUT_MS = 30 * 60_000;
const COORDINATOR_LIVENESS_TIMEOUT_MS = 180_000;
const COORDINATOR_STATUS_HEARTBEAT_MS = 5000;
const COORDINATOR_REGISTRY_LOCK_STALE_MS = 5000;
const COORDINATOR_REGISTRY_LOCK_UPDATE_MS = 1000;
const COORDINATOR_REGISTRY_LOCK_RETRIES = 500;
const COORDINATOR_REGISTRY_LOCK_RETRY_MS = 10;
const PROCESS_START_ID_RECHECK_MS = 1000;

export function buildDaemonUpdateRestartReport(status: DaemonUpdateRestartStatus): DaemonUpdateRestartReport {
	const report: DaemonUpdateRestartReport = { info: [], warnings: [] };
	if (status.phase === "failed") {
		report.warnings.push(`Updated, but could not restart the daemon (${status.message ?? "unknown error"}).`);
	}
	if (status.phase !== "complete" && status.phase !== "failed") {
		return report;
	}
	if (status.counts.total > 0) {
		report.info.push(`Restored ${status.counts.restored} daemon session${status.counts.restored === 1 ? "" : "s"}`);
	}
	if (status.counts.resumed > 0) {
		report.info.push(`Resumed ${status.counts.resumed} interrupted session${status.counts.resumed === 1 ? "" : "s"}`);
	}
	if (status.counts.failed > 0) {
		report.warnings.push(
			`${status.counts.failed} daemon session${status.counts.failed === 1 ? "" : "s"} could not be restored.`,
		);
	}
	for (const failure of status.failures ?? []) {
		report.warnings.push(`Could not restore ${failure.sessionFile}: ${failure.message}`);
	}
	return report;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function statusLivenessId(status: DaemonUpdateRestartStatus): string {
	return status.heartbeatAt ?? status.updatedAt;
}

function socketKey(socketPath: string): string {
	const normalized = process.platform === "win32" ? socketPath.toLowerCase() : resolve(socketPath);
	return createHash("sha256").update(normalized).digest("hex");
}

function writeJsonAtomically(path: string, value: unknown): void {
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

function isProcessIdentity(value: unknown): value is DaemonUpdateRestartProcessIdentity {
	if (!value || typeof value !== "object") {
		return false;
	}
	const identity = value as Partial<DaemonUpdateRestartProcessIdentity>;
	return (
		Number.isInteger(identity.pid) &&
		(identity.pid ?? 0) > 0 &&
		(identity.processStartId === undefined || typeof identity.processStartId === "string") &&
		(identity.supervisorGeneration === undefined || typeof identity.supervisorGeneration === "string") &&
		(identity.supervisorOwnerToken === undefined || typeof identity.supervisorOwnerToken === "string")
	);
}

function isCounts(value: unknown): value is DaemonUpdateRestartCounts {
	if (!value || typeof value !== "object") {
		return false;
	}
	const counts = value as Partial<DaemonUpdateRestartCounts>;
	return [counts.total, counts.restored, counts.resumed, counts.failed].every(
		(entry) => Number.isInteger(entry) && (entry ?? -1) >= 0,
	);
}

function isFailures(value: unknown): value is DaemonUpdateRestartFailure[] {
	return (
		Array.isArray(value) &&
		value.every(
			(failure) =>
				failure !== null &&
				typeof failure === "object" &&
				typeof (failure as Partial<DaemonUpdateRestartFailure>).sessionFile === "string" &&
				typeof (failure as Partial<DaemonUpdateRestartFailure>).message === "string",
		)
	);
}

function isDaemonUpdateRestartStatus(value: unknown): value is DaemonUpdateRestartStatus {
	if (!value || typeof value !== "object") {
		return false;
	}
	const status = value as Partial<DaemonUpdateRestartStatus>;
	return (
		status.version === 1 &&
		typeof status.requestId === "string" &&
		typeof status.socketPath === "string" &&
		typeof status.phase === "string" &&
		ALL_PHASES.has(status.phase as DaemonUpdateRestartPhase) &&
		isProcessIdentity(status.coordinator) &&
		(status.predecessor === undefined || isProcessIdentity(status.predecessor)) &&
		(status.successor === undefined || isProcessIdentity(status.successor)) &&
		isCounts(status.counts) &&
		(status.failures === undefined || isFailures(status.failures)) &&
		(status.message === undefined || typeof status.message === "string") &&
		typeof status.startedAt === "string" &&
		typeof status.updatedAt === "string" &&
		(status.heartbeatAt === undefined || typeof status.heartbeatAt === "string")
	);
}

export function readDaemonUpdateRestartStatus(path: string): DaemonUpdateRestartStatus | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isDaemonUpdateRestartStatus(value) ? value : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function readTerminalDaemonUpdateRestartStatus(path: string): DaemonUpdateRestartStatus | undefined {
	const status = readDaemonUpdateRestartStatus(path);
	return status && TERMINAL_PHASES.has(status.phase) ? status : undefined;
}

export class DaemonUpdateRestartStatusWriter {
	private status: DaemonUpdateRestartStatus;

	constructor(
		private readonly path: string,
		requestId: string,
		socketPath: string,
	) {
		const now = new Date().toISOString();
		const processStartId = getProcessStartId(process.pid);
		this.status = {
			version: 1,
			requestId,
			socketPath,
			phase: "starting",
			coordinator: { pid: process.pid, ...(processStartId ? { processStartId } : {}) },
			counts: { total: 0, restored: 0, resumed: 0, failed: 0 },
			startedAt: now,
			updatedAt: now,
			heartbeatAt: now,
		};
		this.persist();
	}

	update(
		update: Partial<Omit<DaemonUpdateRestartStatus, "version" | "requestId" | "socketPath" | "coordinator">>,
	): void {
		const now = new Date().toISOString();
		this.status = {
			...this.status,
			...update,
			counts: update.counts ? { ...update.counts } : this.status.counts,
			failures: update.failures
				? update.failures.map((failure) => ({ ...failure }))
				: this.status.failures?.map((failure) => ({ ...failure })),
			updatedAt: now,
			heartbeatAt: now,
		};
		this.persist();
	}

	current(): DaemonUpdateRestartStatus {
		return {
			...this.status,
			counts: { ...this.status.counts },
			failures: this.status.failures?.map((failure) => ({ ...failure })),
		};
	}

	touch(): void {
		this.status = { ...this.status, heartbeatAt: new Date().toISOString() };
		this.persist();
	}

	startHeartbeat(): () => void {
		const heartbeat = setInterval(() => {
			try {
				this.touch();
			} catch {
				// A later phase write will retry; otherwise the parent detects the stale heartbeat.
			}
		}, COORDINATOR_STATUS_HEARTBEAT_MS);
		heartbeat.unref();
		return () => clearInterval(heartbeat);
	}

	private persist(): void {
		writeJsonAtomically(this.path, this.status);
	}
}

function defaultCoordinatorRegistryDir(): string {
	return resolve(defaultDaemonSocketDir(), "update-restart-coordinators");
}

function coordinatorRecordPath(registryDir: string, socketPath: string): string {
	return resolve(registryDir, `${socketKey(socketPath)}.json`);
}

async function withCoordinatorRegistryGuard<T>(registryDir: string, action: () => T | Promise<T>): Promise<T> {
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(registryDir, {
		realpath: false,
		lockfilePath: resolve(registryDir, ".guard"),
		stale: COORDINATOR_REGISTRY_LOCK_STALE_MS,
		update: COORDINATOR_REGISTRY_LOCK_UPDATE_MS,
		retries: {
			retries: COORDINATOR_REGISTRY_LOCK_RETRIES,
			factor: 1,
			minTimeout: COORDINATOR_REGISTRY_LOCK_RETRY_MS,
			maxTimeout: COORDINATOR_REGISTRY_LOCK_RETRY_MS,
		},
	});
	try {
		return await action();
	} finally {
		await release();
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
	return true;
}

function matchesProcessStartId(identity: DaemonUpdateRestartProcessIdentity): boolean {
	if (!identity.processStartId) {
		return true;
	}
	const observed = getProcessStartId(identity.pid);
	return compareProcessStartIds(identity.processStartId, observed) !== "mismatch";
}

function isProcessIdentityAlive(identity: DaemonUpdateRestartProcessIdentity): boolean {
	return isProcessAlive(identity.pid) && matchesProcessStartId(identity);
}

function createProcessIdentityLivenessCheck(identity: DaemonUpdateRestartProcessIdentity): () => boolean {
	let lastStartIdCheckAt: number | undefined;
	return () => {
		if (!isProcessAlive(identity.pid)) {
			return false;
		}
		if (!identity.processStartId) {
			return true;
		}
		const now = Date.now();
		if (lastStartIdCheckAt !== undefined && now - lastStartIdCheckAt < PROCESS_START_ID_RECHECK_MS) {
			return true;
		}
		lastStartIdCheckAt = now;
		return matchesProcessStartId(identity);
	};
}

function readCoordinatorRecord(path: string): DaemonUpdateRestartCoordinatorRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			return undefined;
		}
		const record = value as Partial<DaemonUpdateRestartCoordinatorRecord>;
		if (
			record.version !== 1 ||
			typeof record.token !== "string" ||
			typeof record.requestId !== "string" ||
			typeof record.socketPath !== "string" ||
			typeof record.statusPath !== "string" ||
			typeof record.createdAt !== "string" ||
			!isProcessIdentity(record)
		) {
			return undefined;
		}
		return record as DaemonUpdateRestartCoordinatorRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

export class DaemonUpdateRestartCoordinatorLease {
	private released = false;

	constructor(
		readonly record: DaemonUpdateRestartCoordinatorRecord,
		private readonly registryDir: string,
		private readonly path: string,
	) {}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		await withCoordinatorRegistryGuard(this.registryDir, () => {
			const current = readCoordinatorRecord(this.path);
			if (current?.token === this.record.token) {
				rmSync(this.path, { force: true });
			}
		});
		this.released = true;
	}
}

export class DaemonUpdateRestartCoordinatorAlreadyRunningError extends Error {
	constructor(readonly record: DaemonUpdateRestartCoordinatorRecord) {
		super(`Another daemon update restart is already running for ${record.socketPath}`);
		this.name = "DaemonUpdateRestartCoordinatorAlreadyRunningError";
	}
}

export async function acquireDaemonUpdateRestartCoordinator(
	options: AcquireDaemonUpdateRestartCoordinatorOptions,
): Promise<DaemonUpdateRestartCoordinatorLease> {
	const registryDir = options.registryDir ?? defaultCoordinatorRegistryDir();
	const path = coordinatorRecordPath(registryDir, options.socketPath);
	const token = randomUUID();
	const processStartId = getProcessStartId(process.pid);
	const record: DaemonUpdateRestartCoordinatorRecord = {
		version: 1,
		token,
		requestId: options.requestId,
		pid: process.pid,
		...(processStartId ? { processStartId } : {}),
		socketPath: options.socketPath,
		statusPath: options.statusPath,
		createdAt: new Date().toISOString(),
	};
	await withCoordinatorRegistryGuard(registryDir, () => {
		const current = readCoordinatorRecord(path);
		if (current && isProcessIdentityAlive(current)) {
			throw new DaemonUpdateRestartCoordinatorAlreadyRunningError(current);
		}
		rmSync(path, { force: true });
		writeJsonAtomically(path, record);
	});
	return new DaemonUpdateRestartCoordinatorLease(record, registryDir, path);
}

export async function waitForActiveDaemonUpdateRestartCoordinator(
	record: DaemonUpdateRestartCoordinatorRecord,
	progressTimeoutMs = DEFAULT_COORDINATOR_PROGRESS_TIMEOUT_MS,
): Promise<DaemonUpdateRestartStatus> {
	const coordinatorIsAlive = createProcessIdentityLivenessCheck(record);
	let observedUpdatedAt: string | undefined;
	let observedLivenessId: string | undefined;
	let lastProgressAt = Date.now();
	let lastLivenessAt = Date.now();
	while (true) {
		const status = readDaemonUpdateRestartStatus(record.statusPath);
		if (status && status.updatedAt !== observedUpdatedAt) {
			observedUpdatedAt = status.updatedAt;
			lastProgressAt = Date.now();
		}
		if (status && statusLivenessId(status) !== observedLivenessId) {
			observedLivenessId = statusLivenessId(status);
			lastLivenessAt = Date.now();
		}
		if (status && TERMINAL_PHASES.has(status.phase)) {
			return status;
		}
		if (!coordinatorIsAlive()) {
			const terminalStatus = readTerminalDaemonUpdateRestartStatus(record.statusPath);
			if (terminalStatus) {
				return terminalStatus;
			}
			throw new Error(`Active daemon update restart coordinator exited for ${record.socketPath}`);
		}
		if (Date.now() - lastLivenessAt >= COORDINATOR_LIVENESS_TIMEOUT_MS) {
			throw new Error(`Active daemon update restart coordinator stopped reporting liveness on ${record.socketPath}`);
		}
		if (Date.now() - lastProgressAt >= progressTimeoutMs) {
			throw new Error(`Timed out waiting for active daemon update restart progress on ${record.socketPath}`);
		}
		await delay(50);
	}
}

function createStatusPath(agentDir: string, socketPath: string, requestId: string): string {
	const directory = resolve(agentDir, "update-restarts");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	return resolve(directory, `${socketKey(socketPath).slice(0, 16)}-${requestId}.json`);
}

function coordinatorEnvironment(agentDir: string): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	environment[ENV_AGENT_DIR] = agentDir;
	delete environment[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
	delete environment[DAEMON_WORKER_ROLE_ENV];
	delete environment[DAEMON_WORKER_TOKEN_ENV];
	delete environment[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
	delete environment[DAEMON_WORKER_RECOVERY_JOURNAL_ENV];
	delete environment[DAEMON_WORKER_SUPERVISOR_SOCKET_ENV];
	delete environment[ORPHAN_PROCESS_JOURNAL_ENV];
	delete environment[SESSION_LEASES_ENABLED_ENV];
	delete environment[SESSION_LEASE_OWNER_ID_ENV];
	return environment;
}

export async function launchDaemonUpdateRestartCoordinator(
	options: LaunchDaemonUpdateRestartCoordinatorOptions,
): Promise<DaemonUpdateRestartStatus> {
	const requestId = randomUUID();
	const agentDir = resolve(options.agentDir);
	const socketPath = resolveDaemonUpdateRestartSocketPath(options.socketPath);
	const statusPath = createStatusPath(agentDir, socketPath, requestId);
	const inheritedOrigin = process.env[DAEMON_WORKER_ACTIVE_SESSION_ID_ENV];
	const originActiveSessionId = options.originActiveSessionId ?? inheritedOrigin;
	const launch = createCliSubprocessLaunchSpec([
		"update",
		DAEMON_UPDATE_RESTART_COORDINATOR_FLAG,
		"--daemon-socket",
		socketPath,
		DAEMON_UPDATE_RESTART_STATUS_FLAG,
		statusPath,
		...(originActiveSessionId ? [DAEMON_UPDATE_RESTART_ORIGIN_FLAG, originActiveSessionId] : []),
	]);
	const child = spawn(launch.command, launch.args, {
		cwd: options.cwd ?? process.cwd(),
		detached: true,
		env: coordinatorEnvironment(agentDir),
		stdio: "ignore",
	});
	let launchError: Error | undefined;
	let exitDescription: string | undefined;
	child.once("error", (error) => {
		launchError = error;
	});
	child.once("exit", (code, signal) => {
		exitDescription = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
	});
	child.unref();

	const progressTimeoutMs = options.timeoutMs ?? DEFAULT_COORDINATOR_PROGRESS_TIMEOUT_MS;
	let observedUpdatedAt: string | undefined;
	let observedLivenessId: string | undefined;
	let lastProgressAt = Date.now();
	let lastLivenessAt = Date.now();
	while (true) {
		const status = readDaemonUpdateRestartStatus(statusPath);
		if (status && status.updatedAt !== observedUpdatedAt) {
			observedUpdatedAt = status.updatedAt;
			lastProgressAt = Date.now();
		}
		if (status && statusLivenessId(status) !== observedLivenessId) {
			observedLivenessId = statusLivenessId(status);
			lastLivenessAt = Date.now();
		}
		if (status && TERMINAL_PHASES.has(status.phase)) {
			return status;
		}
		if (launchError) {
			throw launchError;
		}
		if (exitDescription) {
			const terminalStatus = readTerminalDaemonUpdateRestartStatus(statusPath);
			if (terminalStatus) {
				return terminalStatus;
			}
			throw new Error(`Daemon update restart coordinator exited with ${exitDescription}`);
		}
		if (Date.now() - lastLivenessAt >= COORDINATOR_LIVENESS_TIMEOUT_MS) {
			throw new Error(`Daemon update restart coordinator stopped reporting liveness on ${socketPath}`);
		}
		if (Date.now() - lastProgressAt >= progressTimeoutMs) {
			throw new Error(`Timed out waiting for daemon update restart progress on ${socketPath}`);
		}
		await delay(50);
	}
}
