import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { getAgentDir } from "../../config.js";
import type {
	WorkflowJournal,
	WorkflowJournalEntry,
	WorkflowJournalStart,
	WorkflowUsage,
} from "./artifact-contracts.js";

export type {
	WorkflowJournal,
	WorkflowJournalEntry,
	WorkflowJournalStart,
	WorkflowUsage,
} from "./artifact-contracts.js";

export const WORKFLOW_RUN_ARTIFACT_VERSION = 1 as const;
export const WORKFLOW_JOURNAL_RECORD_VERSION = 1 as const;
export const MAX_WORKFLOW_SOURCE_BYTES = 256 * 1024;
export const MAX_WORKFLOW_RECORD_BYTES = 1024 * 1024;
export const MAX_WORKFLOW_JOURNAL_LINE_BYTES = 64 * 1024;
export const MAX_WORKFLOW_JOURNAL_SEQUENCE = 512;
export const MAX_WORKFLOW_JOURNAL_BYTES = MAX_WORKFLOW_JOURNAL_LINE_BYTES * MAX_WORKFLOW_JOURNAL_SEQUENCE * 4;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RUN_STATUSES: ReadonlySet<WorkflowRunArtifactStatus> = new Set(["pending", "completed", "failed", "interrupted"]);

export type WorkflowRunArtifactStatus = "pending" | "completed" | "failed" | "interrupted";

export interface WorkflowRunArtifact {
	version: typeof WORKFLOW_RUN_ARTIFACT_VERSION;
	runId: string;
	workflowName: string;
	cwd: string;
	sourceHash: string;
	status: WorkflowRunArtifactStatus;
	createdAt: string;
	updatedAt: string;
	sessionId?: string;
	completedAt?: string;
	result?: unknown;
	error?: string;
	usage?: WorkflowUsage;
}

export interface WorkflowRunArtifactPaths {
	projectDirectory: string;
	runDirectory: string;
	recordPath: string;
	terminalPath: string;
	sourcePath: string;
	journalPath: string;
}

export interface CreateWorkflowRunArtifactOptions {
	cwd: string;
	workflowName: string;
	source: string;
	runId?: string;
	sessionId?: string;
	createdAt?: string;
	agentDir?: string;
}

export interface WorkflowRunArtifactUpdate {
	status: Exclude<WorkflowRunArtifactStatus, "pending">;
	completedAt?: string;
	result?: unknown;
	error?: string;
	usage?: WorkflowUsage;
}

export interface StoredWorkflowRunArtifact {
	record: WorkflowRunArtifact;
	source: string;
	paths: WorkflowRunArtifactPaths;
}

interface PersistedWorkflowJournalStart extends WorkflowJournalStart {
	version: typeof WORKFLOW_JOURNAL_RECORD_VERSION;
	event: "started";
	recordedAt: string;
}

interface PersistedWorkflowJournalCompletion extends WorkflowJournalEntry {
	version: typeof WORKFLOW_JOURNAL_RECORD_VERSION;
	event: "completed";
	recordedAt: string;
}

type PersistedWorkflowJournalRecord = PersistedWorkflowJournalStart | PersistedWorkflowJournalCompletion;

export function workflowProjectKey(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex");
}

export function getWorkflowArtifactProjectDirectory(cwd: string, agentDir: string = getAgentDir()): string {
	return join(resolve(agentDir), "workflow-runs", "projects", workflowProjectKey(cwd));
}

export function isSafeWorkflowRunId(runId: string): boolean {
	return SAFE_ID_PATTERN.test(runId);
}

export function assertSafeWorkflowRunId(runId: string): void {
	if (!isSafeWorkflowRunId(runId)) {
		throw new Error(
			"Workflow run ID must be a path-safe identifier containing only letters, digits, underscores, and hyphens.",
		);
	}
}

export function generateWorkflowRunId(): string {
	return `wf_${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export function getWorkflowRunArtifactPaths(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): WorkflowRunArtifactPaths {
	assertSafeWorkflowRunId(runId);
	const projectDirectory = getWorkflowArtifactProjectDirectory(cwd, agentDir);
	const runDirectory = join(projectDirectory, runId);
	return {
		projectDirectory,
		runDirectory,
		recordPath: join(runDirectory, "run.json"),
		terminalPath: join(runDirectory, "terminal.json"),
		sourcePath: join(runDirectory, "source.txt"),
		journalPath: join(runDirectory, "journal"),
	};
}

export function createWorkflowRunArtifact(options: CreateWorkflowRunArtifactOptions): WorkflowRunArtifact {
	const cwd = resolve(options.cwd);
	const agentDir = resolve(options.agentDir ?? getAgentDir());
	if (typeof options.source !== "string") throw new Error("Workflow source must be a string.");
	assertByteLimit(options.source, MAX_WORKFLOW_SOURCE_BYTES, "Workflow source");
	const workflowName = options.workflowName.trim();
	if (!workflowName || workflowName.length > 256) {
		throw new Error("Workflow name must contain between 1 and 256 characters.");
	}
	const suppliedRunId = options.runId;
	if (suppliedRunId !== undefined) assertSafeWorkflowRunId(suppliedRunId);
	const createdAt = options.createdAt ?? new Date().toISOString();
	if (!isIsoDate(createdAt)) throw new Error("Workflow creation time must be an ISO timestamp.");
	if (Date.parse(createdAt) > Date.now()) throw new Error("Workflow creation time cannot be in the future.");

	ensureArtifactProjectDirectory(cwd, agentDir);
	for (let attempt = 0; attempt < 5; attempt++) {
		const runId = suppliedRunId ?? generateWorkflowRunId();
		const paths = getWorkflowRunArtifactPaths(cwd, runId, agentDir);
		const record: WorkflowRunArtifact = {
			version: WORKFLOW_RUN_ARTIFACT_VERSION,
			runId,
			workflowName,
			cwd,
			sourceHash: createHash("sha256").update(options.source).digest("hex"),
			status: "pending",
			createdAt,
			updatedAt: createdAt,
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
		};
		const serializedRecord = serializeBoundedJson(record, "Workflow run artifact", MAX_WORKFLOW_RECORD_BYTES);
		try {
			mkdirSync(paths.runDirectory, { mode: 0o700 });
		} catch (error) {
			if (suppliedRunId === undefined && isErrno(error, "EEXIST")) continue;
			throw error;
		}
		const validateAnchor = () => assertSafeArtifactRunDirectory(cwd, runId, agentDir);
		validateAnchor();
		ensureChildDirectory(paths.runDirectory, "journal");
		validateAnchor();
		atomicWriteFile(paths.sourcePath, options.source, validateAnchor);
		atomicWriteFile(paths.recordPath, serializedRecord, validateAnchor);
		return record;
	}
	throw new Error("Unable to allocate a unique workflow run ID.");
}

function readWorkflowRunArtifact(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): WorkflowRunArtifact | undefined {
	const resolvedCwd = resolve(cwd);
	const paths = getWorkflowRunArtifactPaths(resolvedCwd, runId, agentDir);
	if (!isSafeArtifactRunDirectory(resolvedCwd, runId, agentDir)) return undefined;
	const recordPath = pathExists(paths.terminalPath) ? paths.terminalPath : paths.recordPath;
	const parsed = readBoundedJsonFile(recordPath, MAX_WORKFLOW_RECORD_BYTES);
	if (
		!isWorkflowRunArtifact(parsed) ||
		parsed.runId !== runId ||
		resolve(parsed.cwd) !== resolvedCwd ||
		!isSafeArtifactRunDirectory(resolvedCwd, runId, agentDir)
	) {
		return undefined;
	}
	return parsed;
}

export function loadWorkflowRunArtifact(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): StoredWorkflowRunArtifact | undefined {
	const record = readWorkflowRunArtifact(cwd, runId, agentDir);
	if (!record) return undefined;
	const paths = getWorkflowRunArtifactPaths(cwd, runId, agentDir);
	const source = readBoundedTextFile(paths.sourcePath, MAX_WORKFLOW_SOURCE_BYTES);
	if (
		source === undefined ||
		createHash("sha256").update(source).digest("hex") !== record.sourceHash ||
		!isSafeArtifactRunDirectory(cwd, runId, agentDir) ||
		!isRealDirectory(paths.journalPath)
	) {
		return undefined;
	}
	return { record, source, paths };
}

export function updateWorkflowRunArtifact(
	cwd: string,
	runId: string,
	update: WorkflowRunArtifactUpdate,
	agentDir: string = getAgentDir(),
): WorkflowRunArtifact {
	const stored = loadWorkflowRunArtifact(cwd, runId, agentDir);
	if (!stored) throw new Error(`Workflow run artifact not found: ${runId}`);
	const current = stored.record;
	if (current.status !== "pending") throw new Error(`Workflow run artifact is already terminal: ${runId}`);
	if (!isIsoDate(update.completedAt)) {
		throw new Error("A terminal workflow run artifact requires an ISO completion time.");
	}
	if (Date.parse(update.completedAt) < Date.parse(current.createdAt)) {
		throw new Error("Workflow run artifact completion time cannot precede its creation time.");
	}
	if (Date.parse(update.completedAt) > Date.now()) {
		throw new Error("Workflow run artifact completion time cannot be in the future.");
	}
	const next: WorkflowRunArtifact = {
		...current,
		...update,
		version: WORKFLOW_RUN_ARTIFACT_VERSION,
		runId: current.runId,
		workflowName: current.workflowName,
		cwd: current.cwd,
		sourceHash: current.sourceHash,
		createdAt: current.createdAt,
		updatedAt: new Date().toISOString(),
	};
	const serialized = serializeBoundedJson(next, "Workflow run artifact", MAX_WORKFLOW_RECORD_BYTES);
	const persisted: unknown = JSON.parse(serialized);
	if (
		!isWorkflowRunArtifact(persisted) ||
		(("result" in update || "error" in update || "usage" in update) &&
			(!isRecord(persisted) ||
				("result" in update && !("result" in persisted)) ||
				("error" in update && !("error" in persisted)) ||
				("usage" in update && !("usage" in persisted))))
	) {
		throw new Error("Workflow run artifact serialization produced an invalid record.");
	}
	const terminalPath = getWorkflowRunArtifactPaths(cwd, runId, agentDir).terminalPath;
	const validateAnchor = () => assertSafeArtifactRunDirectory(cwd, runId, agentDir);
	try {
		atomicCreateFile(terminalPath, serialized, validateAnchor);
	} catch (error) {
		if (isErrno(error, "EEXIST")) throw new Error(`Workflow run artifact is already terminal: ${runId}`);
		throw error;
	}
	return persisted;
}

export function listWorkflowRunArtifacts(cwd: string, agentDir: string = getAgentDir()): WorkflowRunArtifact[] {
	const projectDirectory = getWorkflowArtifactProjectDirectory(cwd, agentDir);
	if (!isSafeArtifactProjectDirectory(cwd, agentDir)) return [];
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(projectDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EACCES")) return [];
		throw error;
	}
	const artifacts: WorkflowRunArtifact[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isSafeWorkflowRunId(entry.name)) continue;
		try {
			const stored = loadWorkflowRunArtifact(cwd, entry.name, agentDir);
			if (stored) artifacts.push(stored.record);
		} catch {
			// Corrupt, oversized, symlinked, or concurrently removed artifacts do not break discovery.
		}
	}
	return artifacts.sort((left, right) => {
		const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
		return byUpdatedAt || left.runId.localeCompare(right.runId);
	});
}

class FileWorkflowJournal implements WorkflowJournal {
	readonly path: string;
	readonly #records: PersistedWorkflowJournalRecord[] = [];
	readonly #replayPrefix = new Map<number, PersistedWorkflowJournalCompletion>();
	readonly #starts = new Map<number, PersistedWorkflowJournalStart>();
	readonly #validateAnchor: () => void;

	constructor(path: string, validateAnchor: () => void) {
		this.path = path;
		this.#validateAnchor = validateAnchor;
		this.#load();
	}

	start(entry: WorkflowJournalStart): void {
		assertJournalIdentity(entry.sequence, entry.key, entry.occurrence);
		const record: PersistedWorkflowJournalStart = {
			...entry,
			version: WORKFLOW_JOURNAL_RECORD_VERSION,
			event: "started",
			recordedAt: new Date().toISOString(),
		};
		const path = this.#recordPath(entry.sequence, "started");
		try {
			this.#createRecord(path, record);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			const existing = readPersistedWorkflowJournalRecord(path);
			if (
				existing?.event !== "started" ||
				existing.sequence !== entry.sequence ||
				existing.key !== entry.key ||
				existing.occurrence !== entry.occurrence
			) {
				throw new Error(`Workflow journal sequence ${entry.sequence} already has a different start identity.`);
			}
		}
		this.#load();
	}

	replay(entry: WorkflowJournalStart): WorkflowJournalEntry | undefined {
		assertJournalIdentity(entry.sequence, entry.key, entry.occurrence);
		const record = this.#replayPrefix.get(entry.sequence);
		if (!record || record.key !== entry.key || record.occurrence !== entry.occurrence) return undefined;
		return journalEntry(record);
	}

	record(entry: WorkflowJournalEntry): void {
		assertJournalIdentity(entry.sequence, entry.key, entry.occurrence);
		this.#load();
		const started = this.#starts.get(entry.sequence);
		if (!started || started.key !== entry.key || started.occurrence !== entry.occurrence) {
			throw new Error(`Workflow journal sequence ${entry.sequence} has no matching start record.`);
		}
		const record: PersistedWorkflowJournalCompletion = {
			...entry,
			version: WORKFLOW_JOURNAL_RECORD_VERSION,
			event: "completed",
			recordedAt: new Date().toISOString(),
		};
		try {
			this.#createRecord(this.#recordPath(entry.sequence, "completed"), record);
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
			this.#load();
			const completed = this.#records.find(
				(candidate): candidate is PersistedWorkflowJournalCompletion =>
					candidate.event === "completed" && candidate.sequence === entry.sequence,
			);
			if (!completed || completed.key !== entry.key || completed.occurrence !== entry.occurrence) {
				throw new Error(
					`Workflow journal sequence ${entry.sequence} is already completed with a different identity.`,
				);
			}
			return;
		}
		this.#load();
	}

	entries(): WorkflowJournalEntry[] {
		return this.#records
			.filter((record): record is PersistedWorkflowJournalCompletion => record.event === "completed")
			.sort((left, right) => left.sequence - right.sequence)
			.map(journalEntry);
	}

	#createRecord(path: string, record: PersistedWorkflowJournalRecord): void {
		const serialized = serializeBoundedJson(record, "Workflow journal record", MAX_WORKFLOW_JOURNAL_LINE_BYTES);
		const persisted: unknown = JSON.parse(serialized);
		if (!isPersistedWorkflowJournalRecord(persisted)) {
			throw new Error("Workflow journal serialization produced an invalid record.");
		}
		this.#validateAnchor();
		atomicCreateFile(path, serialized, this.#validateAnchor);
	}

	#recordPath(sequence: number, event: "started" | "completed"): string {
		return join(this.path, `${sequence.toString().padStart(12, "0")}.${event}.json`);
	}

	#load(): void {
		this.#validateAnchor();
		if (!isRealDirectory(this.path)) throw new Error(`Refusing unsafe workflow journal directory: ${this.path}`);
		let entries: Dirent<string>[];
		try {
			entries = readdirSync(this.path, { withFileTypes: true, encoding: "utf8" });
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new Error(`Workflow journal directory not found: ${this.path}`);
			throw error;
		}
		const records: PersistedWorkflowJournalRecord[] = [];
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (entry.name.startsWith(".")) continue;
			const match = /^(\d{12})\.(started|completed)\.json$/.exec(entry.name);
			if (!entry.isFile() || !match)
				throw new Error(`Workflow journal contains an invalid record path: ${entry.name}`);
			const record = readPersistedWorkflowJournalRecord(join(this.path, entry.name));
			const sequence = Number(match[1]);
			if (!record || record.sequence !== sequence || record.event !== match[2]) {
				throw new Error(`Workflow journal contains a corrupt record: ${entry.name}`);
			}
			records.push(record);
		}
		this.#records.splice(0, this.#records.length, ...records);
		this.#rebuildReplayPrefix();
	}

	#rebuildReplayPrefix(): void {
		this.#starts.clear();
		this.#replayPrefix.clear();
		const completions = new Map<number, PersistedWorkflowJournalCompletion>();
		for (const record of this.#records) {
			if (record.event === "started") this.#starts.set(record.sequence, record);
			else completions.set(record.sequence, record);
		}
		for (const [sequence, completed] of completions) {
			const started = this.#starts.get(sequence);
			if (!started || started.key !== completed.key || started.occurrence !== completed.occurrence) {
				throw new Error(`Workflow journal completion ${sequence} has no matching start record.`);
			}
		}
		for (let sequence = 1; sequence <= MAX_WORKFLOW_JOURNAL_SEQUENCE; sequence++) {
			const completed = completions.get(sequence);
			if (!completed) break;
			this.#replayPrefix.set(sequence, completed);
		}
	}
}

export function createWorkflowJournal(cwd: string, runId: string, agentDir: string = getAgentDir()): WorkflowJournal {
	const paths = getWorkflowRunArtifactPaths(cwd, runId, agentDir);
	const validateAnchor = () => {
		assertSafeArtifactRunDirectory(cwd, runId, agentDir);
		if (!isRealDirectory(paths.journalPath)) {
			throw new Error(`Workflow journal not found or has an unsafe directory path: ${runId}`);
		}
	};
	validateAnchor();
	return new FileWorkflowJournal(paths.journalPath, validateAnchor);
}

function readPersistedWorkflowJournalRecord(path: string): PersistedWorkflowJournalRecord | undefined {
	const parsed = readBoundedJsonFile(path, MAX_WORKFLOW_JOURNAL_LINE_BYTES);
	return isPersistedWorkflowJournalRecord(parsed) ? parsed : undefined;
}

function journalEntry(record: PersistedWorkflowJournalCompletion): WorkflowJournalEntry {
	return {
		sequence: record.sequence,
		key: record.key,
		occurrence: record.occurrence,
		result: cloneJsonValue(record.result),
		...(record.usage !== undefined ? { usage: { ...record.usage } } : {}),
	};
}

// These checks reject pre-existing symlink substitution. They do not claim to defend against
// concurrent filesystem mutation by another process running as the same OS user.
function assertSafeArtifactRunDirectory(cwd: string, runId: string, agentDir: string): void {
	if (!isSafeArtifactRunDirectory(cwd, runId, agentDir)) {
		throw new Error(`Workflow run artifact not found or has an unsafe directory path: ${runId}`);
	}
}

function isSafeArtifactRunDirectory(cwd: string, runId: string, agentDir: string): boolean {
	assertSafeWorkflowRunId(runId);
	return isSafeArtifactDirectoryTree(cwd, agentDir, runId);
}

function isSafeArtifactProjectDirectory(cwd: string, agentDir: string): boolean {
	return isSafeArtifactDirectoryTree(cwd, agentDir);
}

function isSafeArtifactDirectoryTree(cwd: string, agentDir: string, runId?: string): boolean {
	const components = ["workflow-runs", "projects", workflowProjectKey(cwd), ...(runId === undefined ? [] : [runId])];
	let current = resolve(agentDir);
	if (!isRealDirectory(current)) return false;
	for (const component of components) {
		current = join(current, component);
		if (!isRealDirectory(current)) return false;
	}
	return true;
}

function ensureArtifactProjectDirectory(cwd: string, agentDir: string): void {
	ensureDirectory(agentDir, "agent directory");
	const workflowRuns = ensureChildDirectory(agentDir, "workflow-runs");
	const projects = ensureChildDirectory(workflowRuns, "projects");
	ensureChildDirectory(projects, workflowProjectKey(cwd));
}

function ensureDirectory(path: string, description: string): void {
	try {
		const stats = lstatSync(path);
		if (!stats.isDirectory()) throw new Error(`Refusing non-directory ${description}: ${path}`);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
		mkdirSync(path, { recursive: true, mode: 0o700 });
		if (!lstatSync(path).isDirectory()) throw new Error(`Refusing non-directory ${description}: ${path}`);
	}
}

function ensureChildDirectory(parent: string, name: string): string {
	const path = join(parent, name);
	try {
		const stats = lstatSync(path);
		if (!stats.isDirectory() || stats.isSymbolicLink())
			throw new Error(`Refusing unsafe workflow artifact directory: ${path}`);
	} catch (error) {
		if (!isErrno(error, "ENOENT")) throw error;
		mkdirSync(path, { mode: 0o700 });
	}
	return path;
}

function atomicCreateFile(path: string, contents: string, validateParent: () => void): void {
	const base = parse(path).base;
	const temporaryPath = join(dirname(path), `.${base}.stage.${process.pid}.${randomUUID()}`);
	const pendingPath = join(dirname(path), `.${base}.pending`);
	let descriptor: number | undefined;
	let createdStage = false;
	let createdPending = false;
	let installedTarget = false;
	let operationError: unknown;
	try {
		validateParent();
		cleanupStaleAtomicStages(dirname(path), base, validateParent);
		descriptor = openSync(temporaryPath, "wx", 0o600);
		createdStage = true;
		validateParent();
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		validateParent();
		try {
			linkSync(temporaryPath, pendingPath);
			createdPending = true;
			fsyncDirectory(dirname(path));
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		try {
			linkSync(pendingPath, path);
			installedTarget = true;
			fsyncDirectory(dirname(path));
		} catch (error) {
			if (
				!isErrno(error, "EEXIST") ||
				!createdPending ||
				readBoundedTextFile(path, Buffer.byteLength(contents, "utf8")) !== contents
			) {
				throw error;
			}
			installedTarget = true;
		}
		if (!createdPending) operationError = errnoError("EEXIST", `Another writer prepared ${path}.`);
	} catch (error) {
		operationError ??= error;
	}
	if (descriptor !== undefined) {
		try {
			closeSync(descriptor);
		} catch (error) {
			operationError ??= error;
		}
	}
	if (createdStage) {
		try {
			validateParent();
			rmSync(temporaryPath, { force: true });
		} catch (error) {
			if (!installedTarget) operationError ??= error;
		}
	}
	if (operationError !== undefined) throw operationError;
}

function cleanupStaleAtomicStages(directory: string, base: string, validateParent: () => void): void {
	const prefix = `.${base}.stage.`;
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isErrno(error, "ENOENT")) return;
		throw error;
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
		const ownerPid = Number(entry.name.slice(prefix.length).split(".", 1)[0]);
		if (Number.isSafeInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) continue;
		validateParent();
		rmSync(join(directory, entry.name), { force: true });
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !isErrno(error, "ESRCH");
	}
}

function errnoError(code: string, message: string): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}

function atomicWriteFile(path: string, contents: string, validateParent: () => void): void {
	const temporaryPath = join(dirname(path), `.${parse(path).base}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		validateParent();
		descriptor = openSync(temporaryPath, "wx", 0o600);
		validateParent();
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		validateParent();
		renameSync(temporaryPath, path);
		fsyncDirectory(dirname(path));
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		try {
			validateParent();
			rmSync(temporaryPath, { force: true });
		} catch {
			// Leave an inert temporary file rather than clean through an untrusted ancestor path.
		}
		throw error;
	}
}

function fsyncDirectory(directory: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(directory, "r");
		fsyncSync(descriptor);
	} catch {
		// Some platforms do not support syncing a directory; the rename remains atomic.
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function serializeBoundedJson(value: unknown, description: string, maxBytes: number): string {
	try {
		const serialized = `${JSON.stringify(value, null, 2)}\n`;
		assertByteLimit(serialized, maxBytes, description);
		return serialized;
	} catch (error) {
		if (error instanceof Error && error.message.includes("exceeds")) throw error;
		throw new Error(`${description} must be JSON-serializable.`, { cause: error });
	}
}

function assertByteLimit(value: string, maxBytes: number, description: string): void {
	if (Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`${description} exceeds ${maxBytes} bytes.`);
}

function readBoundedJsonFile(path: string, maxBytes: number): unknown {
	const contents = readBoundedTextFile(path, maxBytes);
	if (contents === undefined) return undefined;
	try {
		return JSON.parse(contents) as unknown;
	} catch {
		return undefined;
	}
}

function readBoundedTextFile(path: string, maxBytes: number): string | undefined {
	try {
		return readRegularFile(path, maxBytes, "Workflow artifact file");
	} catch {
		return undefined;
	}
}

function readRegularFile(path: string, maxBytes: number, description: string): string | undefined {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const stats = fstatSync(descriptor);
		if (!stats.isFile()) throw new Error(`Refusing non-regular ${description.toLowerCase()} path: ${path}`);
		if (stats.size > maxBytes) throw new Error(`${description} exceeds its size limit.`);
		const contents = readFileSync(descriptor, "utf8");
		if (Buffer.byteLength(contents, "utf8") > maxBytes) throw new Error(`${description} exceeds its size limit.`);
		return contents;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return undefined;
		throw error;
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function cloneJsonValue(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value)) as unknown;
}

function isWorkflowRunArtifact(value: unknown): value is WorkflowRunArtifact {
	if (!isRecord(value)) return false;
	return (
		value.version === WORKFLOW_RUN_ARTIFACT_VERSION &&
		typeof value.runId === "string" &&
		isSafeWorkflowRunId(value.runId) &&
		typeof value.workflowName === "string" &&
		value.workflowName.trim().length > 0 &&
		value.workflowName.length <= 256 &&
		typeof value.cwd === "string" &&
		typeof value.sourceHash === "string" &&
		/^[a-f0-9]{64}$/.test(value.sourceHash) &&
		typeof value.status === "string" &&
		RUN_STATUSES.has(value.status as WorkflowRunArtifactStatus) &&
		isIsoDate(value.createdAt) &&
		isIsoDate(value.updatedAt) &&
		Date.parse(value.createdAt) <= Date.now() &&
		Date.parse(value.updatedAt) <= Date.now() &&
		Date.parse(value.updatedAt) >= Date.parse(value.createdAt) &&
		(value.sessionId === undefined || typeof value.sessionId === "string") &&
		(value.status === "pending"
			? value.completedAt === undefined &&
				!("result" in value) &&
				value.error === undefined &&
				value.usage === undefined
			: isIsoDate(value.completedAt) &&
				Date.parse(value.completedAt) >= Date.parse(value.createdAt) &&
				Date.parse(value.completedAt) <= Date.parse(value.updatedAt)) &&
		(!("result" in value) || isJsonValue(value.result)) &&
		(value.error === undefined || typeof value.error === "string") &&
		(value.usage === undefined || isWorkflowUsage(value.usage))
	);
}

function isPersistedWorkflowJournalRecord(value: unknown): value is PersistedWorkflowJournalRecord {
	if (
		!isRecord(value) ||
		value.version !== WORKFLOW_JOURNAL_RECORD_VERSION ||
		(value.event !== "started" && value.event !== "completed") ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) <= 0 ||
		(value.sequence as number) > MAX_WORKFLOW_JOURNAL_SEQUENCE ||
		typeof value.key !== "string" ||
		value.key.length === 0 ||
		value.key.length > 512 ||
		!Number.isSafeInteger(value.occurrence) ||
		(value.occurrence as number) < 0 ||
		!isIsoDate(value.recordedAt) ||
		Date.parse(value.recordedAt) > Date.now()
	) {
		return false;
	}
	return (
		value.event === "started" ||
		("result" in value &&
			isJsonValue(value.result) &&
			(value.usage === undefined || isPartialWorkflowUsage(value.usage)))
	);
}

function isJsonValue(value: unknown, seen: WeakSet<object> = new WeakSet(), depth = 0): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object" || depth >= 100 || seen.has(value)) return false;
	seen.add(value);
	let valid: boolean;
	if (Array.isArray(value)) {
		valid = value.every((entry) => isJsonValue(entry, seen, depth + 1));
	} else if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		valid = false;
	} else {
		valid = Object.values(value).every((entry) => isJsonValue(entry, seen, depth + 1));
	}
	seen.delete(value);
	return valid;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkflowUsage(value: unknown): value is WorkflowUsage {
	return (
		isRecord(value) &&
		isNonNegativeNumber(value.input) &&
		isNonNegativeNumber(value.output) &&
		isNonNegativeNumber(value.totalTokens) &&
		isNonNegativeNumber(value.cost)
	);
}

function isPartialWorkflowUsage(value: unknown): value is Partial<WorkflowUsage> {
	return (
		isRecord(value) &&
		(value.input === undefined || isNonNegativeNumber(value.input)) &&
		(value.output === undefined || isNonNegativeNumber(value.output)) &&
		(value.totalTokens === undefined || isNonNegativeNumber(value.totalTokens)) &&
		(value.cost === undefined || isNonNegativeNumber(value.cost))
	);
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function assertJournalIdentity(sequence: number, key: string, occurrence: number): void {
	if (!Number.isSafeInteger(sequence) || sequence <= 0 || sequence > MAX_WORKFLOW_JOURNAL_SEQUENCE) {
		throw new Error(`Workflow journal sequence must be an integer from 1 to ${MAX_WORKFLOW_JOURNAL_SEQUENCE}.`);
	}
	if (!key || key.length > 512) throw new Error("Workflow journal key must contain between 1 and 512 characters.");
	if (!Number.isSafeInteger(occurrence) || occurrence < 0) {
		throw new Error("Workflow journal occurrence must be a non-negative safe integer.");
	}
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
}

function isRealDirectory(path: string): boolean {
	try {
		const stats = lstatSync(path);
		return stats.isDirectory() && !stats.isSymbolicLink();
	} catch {
		return false;
	}
}

function isErrno(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
