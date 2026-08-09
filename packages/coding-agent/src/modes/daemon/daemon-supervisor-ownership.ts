import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { compareProcessStartIds, getProcessStartId } from "../../core/session-lease.js";
import { defaultDaemonSocketDir } from "./daemon-socket.js";

const DAEMON_SUPERVISOR_REGISTRY_DIR_ENV = "PRIME_AGENT_INTERNAL_DAEMON_SUPERVISOR_REGISTRY_DIR";

const OWNER_VERSION = 1;
const REGISTRY_LOCK_STALE_MS = 5000;
const REGISTRY_LOCK_UPDATE_MS = 1000;
const REGISTRY_LOCK_RETRIES = 500;
const REGISTRY_LOCK_RETRY_MS = 10;
const STARTUP_FENCE_POLL_MS = 250;
const SHUTDOWN_ADMISSION_FILE_NAME = "shutdown-admission.json";
const SHUTDOWN_ADMISSION_LEASE_MS = 5000;
const SHUTDOWN_ADMISSION_REFRESH_MS = 1000;
const SHUTDOWN_ADMISSION_WAIT_MS = 50;

type DaemonSupervisorOwnerPhase = "starting" | "owner" | "stopping";

interface ProcessIdentity {
	pid: number;
	processStartId?: string;
}

interface DaemonSupervisorOwnerRecord extends ProcessIdentity {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	appVersion: string;
	phase: DaemonSupervisorOwnerPhase;
	createdAt: string;
	updatedAt: string;
}

interface DaemonShutdownAdmissionRecord extends ProcessIdentity {
	version: 1;
	token: string;
	createdAt: string;
	updatedAt: string;
	expiresAt: string;
}

interface DaemonSupervisorOwnerScope {
	version: 1;
	role: "supervisor";
	token: string;
	generation: string;
	socketPath: string;
	descriptorDir: string;
}

interface DaemonStartupFenceRecord extends ProcessIdentity {
	version: 1;
	token: string;
	ownerToken: string;
	socketPath: string;
	supervisorGeneration: string;
	createdAt: string;
}

interface DaemonSupervisorHelloIdentity {
	supervisorGeneration?: string;
	supervisorOwnerToken?: string;
	supervisorPid?: number;
	supervisorProcessStartId?: string;
	supervisorSocketPath?: string;
}

interface AcquireDaemonSupervisorOwnershipOptions {
	socketPath: string;
	descriptorDir: string;
	agentDir: string;
	generation: string;
	appVersion: string;
	registryDir?: string;
}

class DaemonSupervisorAlreadyRunningError extends Error {
	readonly code = "daemon_supervisor_already_running" as const;

	constructor(readonly owner: DaemonSupervisorOwnerRecord) {
		super(`Daemon supervisor ${owner.generation} already owns ${owner.socketPath}`);
		this.name = "DaemonSupervisorAlreadyRunningError";
	}
}

class DaemonSupervisorOwnershipLostError extends Error {
	readonly code = "supervisor_generation_stale" as const;

	constructor(generation: string) {
		super(`Daemon supervisor generation ${generation} no longer owns its registry entry`);
		this.name = "DaemonSupervisorOwnershipLostError";
	}
}

class DaemonShutdownAdmissionError extends Error {
	readonly code = "daemon_shutdown_in_progress" as const;

	constructor(message = "Daemon shutdown is in progress") {
		super(message);
		this.name = "DaemonShutdownAdmissionError";
	}
}

class DaemonSupervisorOwnership {
	private released = false;

	constructor(
		readonly record: DaemonSupervisorOwnerRecord,
		private readonly registryDir: string,
		private readonly ownerDirectory: string,
	) {}

	async assertCurrent(): Promise<void> {
		if (this.released) {
			throw new DaemonSupervisorOwnershipLostError(this.record.generation);
		}
		const current = readOwnerRecord(this.ownerDirectory);
		if (!current || !sameOwnerRecord(current, this.record)) {
			throw new DaemonSupervisorOwnershipLostError(this.record.generation);
		}
	}

	async updatePhase(phase: DaemonSupervisorOwnerPhase): Promise<void> {
		if (this.released) {
			return;
		}
		const updated = await mutateDaemonSupervisorOwner(
			this.record.generation,
			this.record.token,
			(owner) => {
				owner.phase = phase;
			},
			this.registryDir,
		);
		if (!updated) {
			throw new Error(`Daemon supervisor ownership was lost for ${this.record.socketPath}`);
		}
		this.record.phase = phase;
		this.record.updatedAt = updated.updatedAt;
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		let releasedDirectory: string | undefined;
		try {
			await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
				const current = readOwnerRecord(this.ownerDirectory);
				if (!current || current.token !== this.record.token) {
					return;
				}
				releasedDirectory = `${this.ownerDirectory}.released-${randomUUID()}`;
				renameSync(this.ownerDirectory, releasedDirectory);
			});
			this.released = true;
		} finally {
			if (releasedDirectory) {
				rmSync(releasedDirectory, { recursive: true, force: true });
			}
		}
	}
}

class DaemonShutdownAdmission {
	private released = false;
	private lost = false;
	private refreshPromise?: Promise<void>;
	private readonly refreshTimer: ReturnType<typeof setInterval>;

	constructor(
		private readonly record: DaemonShutdownAdmissionRecord,
		private readonly registryDir: string,
	) {
		this.refreshTimer = setInterval(() => {
			this.refreshPromise ??= this.assertOrRenew()
				.catch(() => undefined)
				.finally(() => {
					this.refreshPromise = undefined;
				});
		}, SHUTDOWN_ADMISSION_REFRESH_MS);
		this.refreshTimer.unref();
	}

	async assertOrRenew(): Promise<void> {
		if (this.released || this.lost) {
			throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
		}
		try {
			await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
				const path = shutdownAdmissionPath(this.registryDir);
				const current = readShutdownAdmission(path);
				if (
					!current ||
					current.token !== this.record.token ||
					current.pid !== this.record.pid ||
					current.processStartId !== this.record.processStartId ||
					Date.parse(current.expiresAt) <= Date.now() ||
					!matchesExactProcessIdentity(this.record)
				) {
					throw new DaemonShutdownAdmissionError("Daemon shutdown admission was lost");
				}
				const now = Date.now();
				this.record.updatedAt = new Date(now).toISOString();
				this.record.expiresAt = new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString();
				writeJsonAtomically(path, this.record);
			});
		} catch (error) {
			this.lost = true;
			clearInterval(this.refreshTimer);
			throw error;
		}
	}

	async release(): Promise<void> {
		if (this.released) {
			return;
		}
		this.released = true;
		clearInterval(this.refreshTimer);
		await this.refreshPromise;
		await withDaemonSupervisorRegistryGuard(this.registryDir, () => {
			const path = shutdownAdmissionPath(this.registryDir);
			const current = readShutdownAdmission(path);
			if (current?.token === this.record.token) {
				rmSync(path, { force: true });
			}
		});
	}
}

function defaultDaemonSupervisorRegistryDir(environment: NodeJS.ProcessEnv = process.env): string {
	return environment[DAEMON_SUPERVISOR_REGISTRY_DIR_ENV] ?? resolve(defaultDaemonSocketDir(), "supervisor-owners");
}

async function withDaemonSupervisorRegistryGuard<T>(registryDir: string, action: () => T | Promise<T>): Promise<T> {
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(registryDir, {
		realpath: false,
		lockfilePath: resolve(registryDir, ".guard"),
		stale: REGISTRY_LOCK_STALE_MS,
		update: REGISTRY_LOCK_UPDATE_MS,
		retries: {
			retries: REGISTRY_LOCK_RETRIES,
			factor: 1,
			minTimeout: REGISTRY_LOCK_RETRY_MS,
			maxTimeout: REGISTRY_LOCK_RETRY_MS,
		},
	});
	try {
		return await action();
	} finally {
		await release();
	}
}

async function mutateDaemonSupervisorOwner(
	generation: string,
	expectedToken: string,
	mutation: (owner: DaemonSupervisorOwnerRecord) => void,
	registryDir: string = defaultDaemonSupervisorRegistryDir(),
): Promise<DaemonSupervisorOwnerRecord | undefined> {
	return withDaemonSupervisorRegistryGuard(registryDir, () => {
		const directory = ownerDirectoryPath(registryDir, generation);
		if (!existsSync(directory)) {
			return undefined;
		}
		const current = requireOwnerRecord(directory);
		if (current.token !== expectedToken) {
			return undefined;
		}
		mutation(current);
		current.updatedAt = new Date().toISOString();
		if (
			!isDaemonSupervisorOwnerRecord(current) ||
			current.generation !== generation ||
			current.token !== expectedToken
		) {
			throw new Error(`Invalid mutation for daemon supervisor owner ${generation}`);
		}
		writeOwnerRecord(directory, current);
		return current;
	});
}

export async function acquireDaemonSupervisorOwnership(
	options: AcquireDaemonSupervisorOwnershipOptions,
): Promise<DaemonSupervisorOwnership> {
	const registryDir = options.registryDir ?? defaultDaemonSupervisorRegistryDir();
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const token = randomUUID();
	const processStartId = getProcessStartId(process.pid);
	const now = new Date().toISOString();
	const record: DaemonSupervisorOwnerRecord = {
		version: OWNER_VERSION,
		role: "supervisor",
		token,
		generation: options.generation,
		pid: process.pid,
		...(processStartId ? { processStartId } : {}),
		socketPath: normalizeSocketPath(options.socketPath),
		descriptorDir: canonicalizeFilesystemPath(options.descriptorDir),
		agentDir: canonicalizeFilesystemPath(options.agentDir),
		appVersion: options.appVersion,
		phase: "starting",
		createdAt: now,
		updatedAt: now,
	};
	const candidateDirectory = resolve(registryDir, `.candidate-${process.pid}-${token}`);
	const ownerDirectory = ownerDirectoryPath(registryDir, options.generation);
	mkdirSync(candidateDirectory, { mode: 0o700 });
	const staleDirectories: string[] = [];
	try {
		writeOwnerScope(candidateDirectory, record);
		writeOwnerRecord(candidateDirectory, record);
		await withDaemonSupervisorRegistryGuard(registryDir, () => {
			if (readActiveShutdownAdmission(registryDir)) {
				throw new DaemonShutdownAdmissionError();
			}
			for (const directory of listOwnerDirectories(registryDir)) {
				const owner = readOwnerRecordForScope(directory, (scope) => ownerConflicts(scope, record));
				if (!owner) {
					continue;
				}
				if (!ownerConflicts(owner, record)) {
					continue;
				}
				if (isProcessIdentityAlive(owner)) {
					throw new DaemonSupervisorAlreadyRunningError(owner);
				}
				const staleDirectory = `${directory}.stale-${randomUUID()}`;
				renameSync(directory, staleDirectory);
				staleDirectories.push(staleDirectory);
			}
			renameSync(candidateDirectory, ownerDirectory);
		});
	} catch (error) {
		rmSync(candidateDirectory, { recursive: true, force: true });
		throw error;
	} finally {
		for (const directory of staleDirectories) {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	return new DaemonSupervisorOwnership(record, registryDir, ownerDirectory);
}

export async function assertDaemonSupervisorOwnerCurrent(
	owner: {
		generation: string;
		pid: number;
		processStartId?: string;
		socketPath: string;
	},
	validatedFingerprint?: string,
): Promise<string> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	const current = readOwnerRecord(ownerDirectoryPath(registryDir, owner.generation));
	if (
		!current ||
		current.pid !== owner.pid ||
		current.processStartId !== owner.processStartId ||
		current.socketPath !== normalizeSocketPath(owner.socketPath) ||
		!isProcessAlive(current.pid)
	) {
		throw new DaemonSupervisorOwnershipLostError(owner.generation);
	}
	const fingerprint = ownerRecordFingerprint(current);
	if (fingerprint !== validatedFingerprint && !isProcessIdentityAlive(current)) {
		throw new DaemonSupervisorOwnershipLostError(owner.generation);
	}
	return fingerprint;
}

export async function acquireDaemonShutdownAdmission(): Promise<DaemonShutdownAdmission> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	const processStartId = getProcessStartId(process.pid);
	while (true) {
		let acquired: DaemonShutdownAdmissionRecord | undefined;
		await withDaemonSupervisorRegistryGuard(registryDir, () => {
			if (readActiveShutdownAdmission(registryDir)) {
				return;
			}
			const now = Date.now();
			acquired = {
				version: OWNER_VERSION,
				token: randomUUID(),
				pid: process.pid,
				...(processStartId ? { processStartId } : {}),
				createdAt: new Date(now).toISOString(),
				updatedAt: new Date(now).toISOString(),
				expiresAt: new Date(now + SHUTDOWN_ADMISSION_LEASE_MS).toISOString(),
			};
			writeJsonAtomically(shutdownAdmissionPath(registryDir), acquired);
		});
		if (acquired) {
			return new DaemonShutdownAdmission(acquired, registryDir);
		}
		await delay(SHUTDOWN_ADMISSION_WAIT_MS);
	}
}

export async function isDaemonShutdownAdmissionActive(): Promise<boolean> {
	const registryDir = defaultDaemonSupervisorRegistryDir();
	return withDaemonSupervisorRegistryGuard(registryDir, () => readActiveShutdownAdmission(registryDir) !== undefined);
}

export async function persistDaemonStartupFenceFromOwner(
	socketPath: string,
	hello: DaemonSupervisorHelloIdentity,
	registryDir: string = defaultDaemonSupervisorRegistryDir(),
): Promise<void> {
	mkdirSync(registryDir, { recursive: true, mode: 0o700 });
	const fenceDirectory = resolve(registryDir, "startup-fences");
	mkdirSync(fenceDirectory, { recursive: true, mode: 0o700 });
	const path = startupFencePath(fenceDirectory, socketPath);
	const normalizedSocketPath = normalizeSocketPath(socketPath);
	return withDaemonSupervisorRegistryGuard(registryDir, () => {
		const owners = listOwnerDirectories(registryDir).flatMap((directory) => {
			const owner = readOwnerRecordForScope(directory, (scope) => scope.socketPath === normalizedSocketPath);
			return owner ? [owner] : [];
		});
		const matchingOwners = owners.filter((owner) => owner.socketPath === normalizedSocketPath);
		if (matchingOwners.length === 0) {
			throw new Error(`Daemon supervisor owner does not match ${socketPath}`);
		}
		if (matchingOwners.length > 1) {
			throw new Error(`Multiple daemon supervisor owners match ${socketPath}`);
		}
		const owner = matchingOwners[0];
		if (!owner) {
			throw new Error(`Daemon supervisor owner disappeared for ${socketPath}`);
		}
		const helloSocketPath = hello.supervisorSocketPath;
		if (
			!Number.isInteger(hello.supervisorPid) ||
			hello.supervisorPid !== owner.pid ||
			hello.supervisorGeneration !== owner.generation ||
			hello.supervisorOwnerToken !== owner.token ||
			typeof helloSocketPath !== "string" ||
			normalizeSocketPath(helloSocketPath) !== owner.socketPath ||
			typeof owner.processStartId !== "string" ||
			hello.supervisorProcessStartId !== owner.processStartId
		) {
			throw new Error(`Daemon supervisor hello does not match its durable owner for ${socketPath}`);
		}
		const observedProcessStartId = getProcessStartId(owner.pid);
		if (compareProcessStartIds(owner.processStartId, observedProcessStartId) === "mismatch") {
			throw new Error(`Daemon supervisor process identity changed for ${socketPath}`);
		}
		const record: DaemonStartupFenceRecord = {
			version: OWNER_VERSION,
			token: randomUUID(),
			ownerToken: owner.token,
			pid: owner.pid,
			processStartId: owner.processStartId,
			socketPath: owner.socketPath,
			supervisorGeneration: owner.generation,
			createdAt: new Date().toISOString(),
		};
		writeJsonAtomically(path, record);
	});
}

export async function waitForDaemonStartupFence(
	socketPath: string,
	timeoutMs = 10_000,
	registryDir: string = defaultDaemonSupervisorRegistryDir(),
): Promise<void> {
	const path = startupFencePath(resolve(registryDir, "startup-fences"), socketPath);
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const fence = readStartupFence(path);
		if (!fence) {
			return;
		}
		if (fence.socketPath !== normalizeSocketPath(socketPath)) {
			throw new Error(`Daemon startup fence does not match ${socketPath}`);
		}
		if (!isProcessIdentityAlive(fence)) {
			const cleared = await withDaemonSupervisorRegistryGuard(registryDir, () => {
				const current = readStartupFence(path);
				if (!current) {
					return true;
				}
				if (current?.token === fence.token) {
					rmSync(path, { force: true });
					return true;
				}
				return false;
			});
			if (cleared) {
				return;
			}
			continue;
		}
		if (Date.now() >= deadline) {
			throw new Error(`Timed out waiting for predecessor daemon process ${fence.pid} to exit`);
		}
		await delay(STARTUP_FENCE_POLL_MS);
	}
}

function isProcessIdentityAlive(identity: ProcessIdentity): boolean {
	if (!isProcessAlive(identity.pid)) {
		return false;
	}
	if (!identity.processStartId) {
		return true;
	}
	const observed = getProcessStartId(identity.pid);
	return compareProcessStartIds(identity.processStartId, observed) !== "mismatch";
}

function matchesExactProcessIdentity(identity: ProcessIdentity): boolean {
	if (!isProcessAlive(identity.pid)) {
		return false;
	}
	return (
		identity.processStartId === undefined ||
		compareProcessStartIds(identity.processStartId, getProcessStartId(identity.pid)) === "match"
	);
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
	return true;
}

function normalizeSocketPath(socketPath: string): string {
	if (process.platform === "win32") {
		return socketPath.toLowerCase();
	}
	return resolve(socketPath);
}

function canonicalizeFilesystemPath(path: string): string {
	let existingAncestor = resolve(path);
	const missingSuffix: string[] = [];
	while (true) {
		try {
			const physicalAncestor = realpathSync.native(existingAncestor);
			const canonical = join(physicalAncestor, ...missingSuffix);
			return process.platform === "win32" ? canonical.toLowerCase() : canonical;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			const parent = dirname(existingAncestor);
			if (parent === existingAncestor) {
				const unresolved = resolve(path);
				return process.platform === "win32" ? unresolved.toLowerCase() : unresolved;
			}
			missingSuffix.unshift(basename(existingAncestor));
			existingAncestor = parent;
		}
	}
}

function ownerConflicts(left: DaemonSupervisorOwnerScope, right: DaemonSupervisorOwnerScope): boolean {
	return left.socketPath === right.socketPath || left.descriptorDir === right.descriptorDir;
}

function sameOwnerRecord(left: DaemonSupervisorOwnerRecord, right: DaemonSupervisorOwnerRecord): boolean {
	return (
		left.token === right.token &&
		left.generation === right.generation &&
		left.pid === right.pid &&
		left.processStartId === right.processStartId &&
		left.socketPath === right.socketPath
	);
}

function ownerRecordFingerprint(record: DaemonSupervisorOwnerRecord): string {
	return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

function listOwnerDirectories(registryDir: string): string[] {
	return readdirSync(registryDir)
		.filter((name) => name.endsWith(".owner"))
		.map((name) => resolve(registryDir, name));
}

function ownerDirectoryPath(registryDir: string, generation: string): string {
	if (!/^[A-Za-z0-9._-]+$/.test(generation)) {
		throw new Error(`Invalid daemon supervisor generation: ${generation}`);
	}
	return resolve(registryDir, `${generation}.owner`);
}

function requireOwnerRecord(directory: string): DaemonSupervisorOwnerRecord {
	const owner = readOwnerRecord(directory);
	if (!owner) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return owner;
}

function readOwnerRecordForScope(
	directory: string,
	isRelevant: (scope: DaemonSupervisorOwnerScope) => boolean,
): DaemonSupervisorOwnerRecord | undefined {
	const owner = readOwnerRecord(directory);
	if (owner) {
		return owner;
	}
	const scope = readOwnerScope(directory);
	const entries = !scope ? readdirSync(directory) : [];
	if (!scope && !entries.includes("owner.json") && !entries.includes("scope.json")) {
		const abandonedDirectory = `${directory}.abandoned-${randomUUID()}`;
		renameSync(directory, abandonedDirectory);
		rmSync(abandonedDirectory, { recursive: true, force: true });
		return undefined;
	}
	if (!scope || isRelevant(scope)) {
		throw new Error(`Invalid daemon supervisor owner record: ${directory}`);
	}
	return undefined;
}

function readOwnerRecord(directory: string): DaemonSupervisorOwnerRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "owner.json"), "utf8")) as unknown;
		return isDaemonSupervisorOwnerRecord(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerRecord(value: unknown): value is DaemonSupervisorOwnerRecord {
	if (!value || typeof value !== "object") {
		return false;
	}
	const record = value as Partial<DaemonSupervisorOwnerRecord>;
	return (
		record.version === OWNER_VERSION &&
		record.role === "supervisor" &&
		typeof record.token === "string" &&
		typeof record.generation === "string" &&
		Number.isInteger(record.pid) &&
		(record.pid ?? 0) > 0 &&
		(record.processStartId === undefined || typeof record.processStartId === "string") &&
		typeof record.socketPath === "string" &&
		typeof record.descriptorDir === "string" &&
		typeof record.agentDir === "string" &&
		typeof record.appVersion === "string" &&
		(record.phase === "starting" || record.phase === "owner" || record.phase === "stopping") &&
		typeof record.createdAt === "string" &&
		typeof record.updatedAt === "string"
	);
}

function readOwnerScope(directory: string): DaemonSupervisorOwnerScope | undefined {
	try {
		const value = JSON.parse(readFileSync(resolve(directory, "scope.json"), "utf8")) as unknown;
		if (!isDaemonSupervisorOwnerScope(value)) {
			return undefined;
		}
		return ownerDirectoryPath(dirname(directory), value.generation) === directory ? value : undefined;
	} catch {
		return undefined;
	}
}

function isDaemonSupervisorOwnerScope(value: unknown): value is DaemonSupervisorOwnerScope {
	if (!value || typeof value !== "object") {
		return false;
	}
	const scope = value as Partial<DaemonSupervisorOwnerScope>;
	return (
		scope.version === OWNER_VERSION &&
		scope.role === "supervisor" &&
		typeof scope.token === "string" &&
		typeof scope.generation === "string" &&
		typeof scope.socketPath === "string" &&
		typeof scope.descriptorDir === "string"
	);
}

function writeOwnerScope(directory: string, owner: DaemonSupervisorOwnerRecord): void {
	const scope: DaemonSupervisorOwnerScope = {
		version: owner.version,
		role: owner.role,
		token: owner.token,
		generation: owner.generation,
		socketPath: owner.socketPath,
		descriptorDir: owner.descriptorDir,
	};
	writeJsonAtomically(resolve(directory, "scope.json"), scope);
}

function writeOwnerRecord(directory: string, record: DaemonSupervisorOwnerRecord): void {
	writeJsonAtomically(resolve(directory, "owner.json"), record);
}

function readStartupFence(path: string): DaemonStartupFenceRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		const fence = value as Partial<DaemonStartupFenceRecord>;
		if (
			fence.version !== OWNER_VERSION ||
			typeof fence.token !== "string" ||
			typeof fence.ownerToken !== "string" ||
			!Number.isInteger(fence.pid) ||
			(fence.pid ?? 0) <= 0 ||
			typeof fence.processStartId !== "string" ||
			typeof fence.socketPath !== "string" ||
			typeof fence.supervisorGeneration !== "string" ||
			typeof fence.createdAt !== "string"
		) {
			throw new Error(`Invalid daemon startup fence: ${path}`);
		}
		return fence as DaemonStartupFenceRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

function readActiveShutdownAdmission(registryDir: string): DaemonShutdownAdmissionRecord | undefined {
	const path = shutdownAdmissionPath(registryDir);
	const admission = readShutdownAdmission(path);
	if (!admission) {
		return undefined;
	}
	if (Date.parse(admission.expiresAt) > Date.now() && isProcessIdentityAlive(admission)) {
		return admission;
	}
	rmSync(path, { force: true });
	return undefined;
}

function readShutdownAdmission(path: string): DaemonShutdownAdmissionRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object") {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		const admission = value as Partial<DaemonShutdownAdmissionRecord>;
		if (
			admission.version !== OWNER_VERSION ||
			typeof admission.token !== "string" ||
			!Number.isInteger(admission.pid) ||
			(admission.pid ?? 0) <= 0 ||
			(admission.processStartId !== undefined && typeof admission.processStartId !== "string") ||
			typeof admission.createdAt !== "string" ||
			typeof admission.updatedAt !== "string" ||
			typeof admission.expiresAt !== "string" ||
			!Number.isFinite(Date.parse(admission.expiresAt))
		) {
			throw new Error(`Invalid daemon shutdown admission: ${path}`);
		}
		return admission as DaemonShutdownAdmissionRecord;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
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

function startupFencePath(directory: string, socketPath: string): string {
	const key = createHash("sha256").update(normalizeSocketPath(socketPath)).digest("hex");
	return resolve(directory, `${key}.json`);
}

function shutdownAdmissionPath(registryDir: string): string {
	return resolve(registryDir, SHUTDOWN_ADMISSION_FILE_NAME);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
