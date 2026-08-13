import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
	closeSync,
	existsSync,
	fsyncSync,
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
import type { WorkflowJournal, WorkflowJournalEntry, WorkflowJournalStart, WorkflowUsage } from "./runtime.js";

export type { WorkflowJournal, WorkflowJournalEntry } from "./runtime.js";

export const WORKFLOW_RUN_RECORD_VERSION = 2 as const;
export const WORKFLOW_JOURNAL_RECORD_VERSION = 2 as const;

const PROJECT_WORKFLOW_COMPONENTS = [".prime", "agent", "workflows"] as const;
const SAFE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export type WorkflowRunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

export interface WorkflowAgentProgress {
	id: number;
	label: string;
	phase?: string;
	prompt?: string;
	model?: string;
	effort?: string;
	usage?: WorkflowUsage;
	status: "running" | "completed" | "failed" | "replayed" | "stopped";
	startedAt?: string;
	completedAt?: string;
	error?: string;
	resultPreview?: string;
}

export interface WorkflowRunProgress {
	currentPhase?: string;
	agents: WorkflowAgentProgress[];
}

export interface WorkflowRunRecord {
	version: typeof WORKFLOW_RUN_RECORD_VERSION;
	runId: string;
	taskId: string;
	workflowName: string;
	description?: string;
	cwd: string;
	sessionId?: string;
	args?: unknown;
	status: WorkflowRunStatus;
	startedAt: string;
	updatedAt: string;
	completedAt?: string;
	result?: unknown;
	error?: string;
	logs?: string[];
	phases?: string[];
	agentCount?: number;
	replayedCount?: number;
	durationMs?: number;
	usage?: WorkflowUsage;
	progress?: WorkflowRunProgress;
	metadata?: Record<string, unknown>;
}

export interface WorkflowRunPaths {
	projectDirectory: string;
	runDirectory: string;
	recordPath: string;
	scriptPath: string;
	journalPath: string;
}

export interface CreateWorkflowRunOptions {
	cwd: string;
	workflowName: string;
	description?: string;
	script: string;
	runId?: string;
	taskId?: string;
	sessionId?: string;
	args?: unknown;
	status?: WorkflowRunStatus;
	startedAt?: string;
	metadata?: Record<string, unknown>;
	agentDir?: string;
}

export type WorkflowRunUpdate = Partial<
	Omit<WorkflowRunRecord, "version" | "runId" | "taskId" | "workflowName" | "cwd" | "startedAt" | "updatedAt">
>;

export interface StoredWorkflowRun {
	record: WorkflowRunRecord;
	script: string;
	paths: WorkflowRunPaths;
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

export type SavedWorkflowLocation = "project" | "user";

export interface SavedWorkflow {
	name: string;
	script: string;
	path: string;
	location: SavedWorkflowLocation;
	projectRoot?: string;
}

export interface SaveRunAsProjectWorkflowOptions {
	cwd: string;
	runId: string;
	name: string;
	agentDir?: string;
}

export type SaveRunAsUserWorkflowOptions = SaveRunAsProjectWorkflowOptions;

export function workflowProjectKey(cwd: string): string {
	return createHash("sha256").update(resolve(cwd)).digest("hex");
}

export function getWorkflowProjectDirectory(cwd: string, agentDir: string = getAgentDir()): string {
	return join(agentDir, "workflows", "projects", workflowProjectKey(cwd));
}

export function isSafeWorkflowRunId(runId: string): boolean {
	return SAFE_NAME_PATTERN.test(runId);
}

export function assertSafeWorkflowRunId(runId: string): void {
	if (!isSafeWorkflowRunId(runId)) {
		throw new Error(
			"Workflow run ID must be a path-safe identifier containing only letters, digits, underscores, and hyphens.",
		);
	}
}

export function isSafeWorkflowName(name: string): boolean {
	return SAFE_NAME_PATTERN.test(name);
}

export function assertSafeWorkflowName(name: string): void {
	if (!isSafeWorkflowName(name)) {
		throw new Error(
			"Workflow name must be a path-safe identifier containing only letters, digits, underscores, and hyphens.",
		);
	}
}

export function generateWorkflowRunId(): string {
	return `wf_${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export function generateWorkflowTaskId(): string {
	return `task_${Date.now().toString(36)}-${randomBytes(8).toString("hex")}`;
}

export function getWorkflowRunPaths(cwd: string, runId: string, agentDir: string = getAgentDir()): WorkflowRunPaths {
	assertSafeWorkflowRunId(runId);
	const projectDirectory = getWorkflowProjectDirectory(cwd, agentDir);
	const runDirectory = join(projectDirectory, runId);
	return {
		projectDirectory,
		runDirectory,
		recordPath: join(runDirectory, "run.json"),
		scriptPath: join(runDirectory, "script.py"),
		journalPath: join(runDirectory, "journal.jsonl"),
	};
}

export function createWorkflowRun(options: CreateWorkflowRunOptions): WorkflowRunRecord {
	const cwd = resolve(options.cwd);
	const agentDir = options.agentDir ?? getAgentDir();
	const suppliedRunId = options.runId;
	if (suppliedRunId !== undefined) assertSafeWorkflowRunId(suppliedRunId);
	const taskId = options.taskId ?? generateWorkflowTaskId();
	assertSafeWorkflowRunId(taskId);
	if (typeof options.script !== "string") throw new Error("Workflow script must be a string.");
	if (!options.workflowName.trim()) throw new Error("Workflow name must not be empty.");

	for (let attempt = 0; attempt < 5; attempt++) {
		const runId = suppliedRunId ?? generateWorkflowRunId();
		const paths = getWorkflowRunPaths(cwd, runId, agentDir);
		const startedAt = options.startedAt ?? new Date().toISOString();
		const record: WorkflowRunRecord = {
			version: WORKFLOW_RUN_RECORD_VERSION,
			runId,
			taskId,
			workflowName: options.workflowName,
			...(options.description !== undefined ? { description: options.description } : {}),
			cwd,
			...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
			...(options.args !== undefined ? { args: options.args } : {}),
			status: options.status ?? "running",
			startedAt,
			updatedAt: startedAt,
			...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
		};
		const serializedRecord = serializeJson(record, "Workflow run record");

		mkdirSync(paths.projectDirectory, { recursive: true, mode: 0o700 });
		try {
			mkdirSync(paths.runDirectory, { mode: 0o700 });
		} catch (error) {
			if (suppliedRunId === undefined && isErrno(error, "EEXIST")) continue;
			throw error;
		}

		try {
			atomicWriteFile(paths.scriptPath, options.script);
			atomicWriteFile(paths.recordPath, serializedRecord);
			return record;
		} catch (error) {
			rmSync(paths.runDirectory, { recursive: true, force: true });
			throw error;
		}
	}

	throw new Error("Unable to allocate a unique workflow run ID.");
}

export function readWorkflowRun(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): WorkflowRunRecord | undefined {
	const resolvedCwd = resolve(cwd);
	const paths = getWorkflowRunPaths(resolvedCwd, runId, agentDir);
	if (!isRealDirectory(paths.runDirectory)) return undefined;
	const parsed = readJsonFile(paths.recordPath);
	if (!isWorkflowRunRecord(parsed) || parsed.runId !== runId || resolve(parsed.cwd) !== resolvedCwd) return undefined;
	return parsed;
}

export function readWorkflowRunScript(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): string | undefined {
	const paths = getWorkflowRunPaths(cwd, runId, agentDir);
	if (!isRealDirectory(paths.runDirectory) || !isRealFile(paths.scriptPath)) return undefined;
	return readFileSync(paths.scriptPath, "utf8");
}

export function loadWorkflowRun(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): StoredWorkflowRun | undefined {
	const record = readWorkflowRun(cwd, runId, agentDir);
	const script = readWorkflowRunScript(cwd, runId, agentDir);
	if (!record || script === undefined) return undefined;
	return { record, script, paths: getWorkflowRunPaths(cwd, runId, agentDir) };
}

export function updateWorkflowRun(
	cwd: string,
	runId: string,
	update: WorkflowRunUpdate,
	agentDir: string = getAgentDir(),
): WorkflowRunRecord {
	const current = readWorkflowRun(cwd, runId, agentDir);
	if (!current) throw new Error(`Workflow run not found: ${runId}`);
	const next: WorkflowRunRecord = {
		...current,
		...update,
		version: WORKFLOW_RUN_RECORD_VERSION,
		runId: current.runId,
		taskId: current.taskId,
		workflowName: current.workflowName,
		cwd: current.cwd,
		startedAt: current.startedAt,
		updatedAt: new Date().toISOString(),
	};
	if (!isWorkflowRunRecord(next)) throw new Error("Workflow run update produced an invalid record.");
	atomicWriteFile(getWorkflowRunPaths(cwd, runId, agentDir).recordPath, serializeJson(next, "Workflow run record"));
	return next;
}

export function listWorkflowRuns(cwd: string, agentDir: string = getAgentDir()): WorkflowRunRecord[] {
	const projectDirectory = getWorkflowProjectDirectory(cwd, agentDir);
	let entries: Dirent<string>[];
	try {
		entries = readdirSync(projectDirectory, { withFileTypes: true, encoding: "utf8" });
	} catch (error) {
		if (isErrno(error, "ENOENT") || isErrno(error, "ENOTDIR") || isErrno(error, "EACCES")) return [];
		throw error;
	}

	const runs: WorkflowRunRecord[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !isSafeWorkflowRunId(entry.name)) continue;
		try {
			const record = readWorkflowRun(cwd, entry.name, agentDir);
			if (record) runs.push(record);
		} catch {
			// A corrupt or concurrently removed run must not break run discovery.
		}
	}
	return runs.sort((left, right) => {
		const byUpdatedAt = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
		return byUpdatedAt || left.runId.localeCompare(right.runId);
	});
}

export class FileWorkflowJournal implements WorkflowJournal {
	readonly path: string;
	readonly #records: PersistedWorkflowJournalRecord[] = [];
	readonly #replayPrefix = new Map<number, PersistedWorkflowJournalCompletion>();

	constructor(path: string) {
		this.path = path;
		assertRegularFileOrMissing(path, "workflow journal");
		this.#load();
	}

	start(entry: WorkflowJournalStart): void {
		assertJournalIdentity(entry.sequence, entry.key, entry.occurrence);
		this.#append({
			version: WORKFLOW_JOURNAL_RECORD_VERSION,
			event: "started",
			...entry,
			recordedAt: new Date().toISOString(),
		});
	}

	replay(entry: WorkflowJournalStart): WorkflowJournalEntry | undefined {
		assertJournalIdentity(entry.sequence, entry.key, entry.occurrence);
		const record = this.#replayPrefix.get(entry.sequence);
		if (!record || record.key !== entry.key || record.occurrence !== entry.occurrence) return undefined;
		return {
			sequence: record.sequence,
			key: record.key,
			occurrence: record.occurrence,
			result: record.result,
			...(record.usage !== undefined ? { usage: record.usage } : {}),
		};
	}

	record(entry: WorkflowJournalEntry): void {
		assertJournalIdentity(entry.sequence, entry.key, entry.occurrence);
		this.#append({
			version: WORKFLOW_JOURNAL_RECORD_VERSION,
			event: "completed",
			...entry,
			recordedAt: new Date().toISOString(),
		});
	}

	entries(): WorkflowJournalEntry[] {
		return this.#records
			.filter((record): record is PersistedWorkflowJournalCompletion => record.event === "completed")
			.map((record) => ({
				sequence: record.sequence,
				key: record.key,
				occurrence: record.occurrence,
				result: record.result,
				...(record.usage !== undefined ? { usage: record.usage } : {}),
			}));
	}

	#append(record: PersistedWorkflowJournalRecord): void {
		const line = serializeJsonLine(record, "Workflow journal record");
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		assertRegularFileOrMissing(this.path, "workflow journal");
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeFileSync(descriptor, line, "utf8");
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		this.#records.push(record);
		this.#rebuildReplayPrefix();
	}

	#load(): void {
		let contents: string;
		try {
			contents = readFileSync(this.path, "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) return;
			throw error;
		}
		for (const line of contents.split("\n")) {
			if (!line) continue;
			try {
				const parsed: unknown = JSON.parse(line);
				if (isPersistedWorkflowJournalRecord(parsed)) this.#records.push(parsed);
			} catch {
				// A process can stop after appending only part of its final record.
			}
		}
		this.#rebuildReplayPrefix();
	}

	#rebuildReplayPrefix(): void {
		this.#replayPrefix.clear();
		const starts = new Map<number, PersistedWorkflowJournalStart>();
		const completions = new Map<number, PersistedWorkflowJournalCompletion>();
		for (const record of this.#records) {
			if (record.event === "started") starts.set(record.sequence, record);
			else completions.set(record.sequence, record);
		}
		for (let sequence = 1; ; sequence++) {
			const started = starts.get(sequence);
			const completed = completions.get(sequence);
			if (!started || !completed || started.key !== completed.key || started.occurrence !== completed.occurrence) {
				break;
			}
			this.#replayPrefix.set(sequence, completed);
		}
	}
}
export function createWorkflowJournal(
	cwd: string,
	runId: string,
	agentDir: string = getAgentDir(),
): FileWorkflowJournal {
	const paths = getWorkflowRunPaths(cwd, runId, agentDir);
	if (!isRealDirectory(paths.runDirectory)) throw new Error(`Workflow run not found: ${runId}`);
	return new FileWorkflowJournal(paths.journalPath);
}

export function resolveSavedWorkflow(
	name: string,
	cwd: string,
	agentDir: string = getAgentDir(),
): SavedWorkflow | undefined {
	assertSafeWorkflowName(name);
	for (const projectRoot of ancestorDirectories(cwd)) {
		const directory = join(projectRoot, ...PROJECT_WORKFLOW_COMPONENTS);
		if (!isProjectWorkflowDirectorySafe(projectRoot, false)) continue;
		const path = join(directory, `${name}.py`);
		if (isRealFile(path)) {
			assertWorkflowFileSize(path);
			return { name, script: readFileSync(path, "utf8"), path, location: "project", projectRoot };
		}
	}

	const path = join(agentDir, "workflows", `${name}.py`);
	if (!isRealFile(path)) return undefined;
	assertWorkflowFileSize(path);
	return { name, script: readFileSync(path, "utf8"), path, location: "user" };
}

export function saveRunAsProjectWorkflow(options: SaveRunAsProjectWorkflowOptions): SavedWorkflow {
	assertSafeWorkflowName(options.name);
	const agentDir = options.agentDir ?? getAgentDir();
	const script = readWorkflowRunScript(options.cwd, options.runId, agentDir);
	if (script === undefined) throw new Error(`Workflow run not found: ${options.runId}`);

	const projectRoot =
		findClosestProjectWorkflowRoot(options.cwd) ?? findRepositoryRoot(options.cwd) ?? resolve(options.cwd);
	const directory = join(projectRoot, ...PROJECT_WORKFLOW_COMPONENTS);
	ensureProjectWorkflowDirectory(projectRoot);
	const path = join(directory, `${options.name}.py`);
	assertRegularFileOrMissing(path, "project workflow");
	atomicWriteFile(path, script);
	return { name: options.name, script, path, location: "project", projectRoot };
}

export function saveRunAsUserWorkflow(options: SaveRunAsUserWorkflowOptions): SavedWorkflow {
	assertSafeWorkflowName(options.name);
	const agentDir = options.agentDir ?? getAgentDir();
	const script = readWorkflowRunScript(options.cwd, options.runId, agentDir);
	if (script === undefined) throw new Error(`Workflow run not found: ${options.runId}`);
	const directory = join(agentDir, "workflows");
	if (existsSync(directory)) {
		const stat = lstatSync(directory);
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new Error(`Refusing unsafe user workflow directory: ${directory}`);
		}
	} else {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const path = join(directory, `${options.name}.py`);
	assertRegularFileOrMissing(path, "user workflow");
	atomicWriteFile(path, script);
	return { name: options.name, script, path, location: "user" };
}

function atomicWriteFile(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = join(dirname(path), `.${parse(path).base}.${process.pid}.${randomUUID()}.tmp`);
	let descriptor: number | undefined;
	try {
		descriptor = openSync(temporaryPath, "wx", 0o600);
		writeFileSync(descriptor, contents, "utf8");
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		renameSync(temporaryPath, path);
		fsyncDirectory(dirname(path));
	} catch (error) {
		if (descriptor !== undefined) closeSync(descriptor);
		rmSync(temporaryPath, { force: true });
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

function serializeJson(value: unknown, description: string): string {
	try {
		return `${JSON.stringify(value, null, 2)}\n`;
	} catch (error) {
		throw new Error(`${description} must be JSON-serializable.`, { cause: error });
	}
}

function serializeJsonLine(value: unknown, description: string): string {
	try {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) throw new Error("JSON.stringify returned undefined");
		return `${serialized}\n`;
	} catch (error) {
		throw new Error(`${description} must be JSON-serializable.`, { cause: error });
	}
}

function readJsonFile(path: string): unknown {
	if (!isRealFile(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function isWorkflowRunRecord(value: unknown): value is WorkflowRunRecord {
	if (!isRecord(value)) return false;
	return (
		value.version === WORKFLOW_RUN_RECORD_VERSION &&
		typeof value.runId === "string" &&
		isSafeWorkflowRunId(value.runId) &&
		typeof value.taskId === "string" &&
		isSafeWorkflowRunId(value.taskId) &&
		typeof value.workflowName === "string" &&
		value.workflowName.trim().length > 0 &&
		typeof value.cwd === "string" &&
		typeof value.status === "string" &&
		RUN_STATUSES.has(value.status as WorkflowRunStatus) &&
		isIsoDate(value.startedAt) &&
		isIsoDate(value.updatedAt) &&
		(value.completedAt === undefined || isIsoDate(value.completedAt)) &&
		isOptionalString(value.description) &&
		isOptionalString(value.sessionId) &&
		isOptionalString(value.error) &&
		isOptionalStringArray(value.logs) &&
		isOptionalStringArray(value.phases) &&
		isOptionalNonNegativeNumber(value.agentCount) &&
		isOptionalNonNegativeNumber(value.replayedCount) &&
		isOptionalNonNegativeNumber(value.durationMs) &&
		(value.usage === undefined || isWorkflowUsage(value.usage)) &&
		(value.progress === undefined || isWorkflowRunProgress(value.progress)) &&
		(value.metadata === undefined || isRecord(value.metadata))
	);
}

const RUN_STATUSES: ReadonlySet<WorkflowRunStatus> = new Set([
	"pending",
	"running",
	"paused",
	"completed",
	"failed",
	"stopped",
]);

function isPersistedWorkflowJournalRecord(value: unknown): value is PersistedWorkflowJournalRecord {
	if (
		!isRecord(value) ||
		value.version !== WORKFLOW_JOURNAL_RECORD_VERSION ||
		(value.event !== "started" && value.event !== "completed") ||
		!Number.isSafeInteger(value.sequence) ||
		(value.sequence as number) <= 0 ||
		typeof value.key !== "string" ||
		value.key.length === 0 ||
		!Number.isSafeInteger(value.occurrence) ||
		(value.occurrence as number) < 0 ||
		!isIsoDate(value.recordedAt)
	) {
		return false;
	}
	return (
		value.event === "started" ||
		("result" in value && (value.usage === undefined || isPartialWorkflowUsage(value.usage)))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isWorkflowRunProgress(value: unknown): value is WorkflowRunProgress {
	return (
		isRecord(value) &&
		isOptionalString(value.currentPhase) &&
		Array.isArray(value.agents) &&
		value.agents.every(
			(agent) =>
				isRecord(agent) &&
				Number.isSafeInteger(agent.id) &&
				(agent.id as number) > 0 &&
				typeof agent.label === "string" &&
				isOptionalString(agent.phase) &&
				isOptionalString(agent.prompt) &&
				isOptionalString(agent.model) &&
				isOptionalString(agent.effort) &&
				(agent.usage === undefined || isWorkflowUsage(agent.usage)) &&
				(agent.status === "running" ||
					agent.status === "completed" ||
					agent.status === "failed" ||
					agent.status === "replayed" ||
					agent.status === "stopped") &&
				(agent.startedAt === undefined || isIsoDate(agent.startedAt)) &&
				(agent.completedAt === undefined || isIsoDate(agent.completedAt)) &&
				isOptionalString(agent.error) &&
				isOptionalString(agent.resultPreview),
		)
	);
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

function isOptionalStringArray(value: unknown): boolean {
	return value === undefined || (Array.isArray(value) && value.every((entry) => typeof entry === "string"));
}

function isOptionalNonNegativeNumber(value: unknown): boolean {
	return value === undefined || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isWorkflowUsage(value: unknown): value is WorkflowUsage {
	return (
		isRecord(value) &&
		isOptionalNonNegativeNumber(value.input) &&
		value.input !== undefined &&
		isOptionalNonNegativeNumber(value.output) &&
		value.output !== undefined &&
		isOptionalNonNegativeNumber(value.totalTokens) &&
		value.totalTokens !== undefined &&
		isOptionalNonNegativeNumber(value.cost) &&
		value.cost !== undefined
	);
}

function isPartialWorkflowUsage(value: unknown): value is Partial<WorkflowUsage> {
	return (
		isRecord(value) &&
		isOptionalNonNegativeNumber(value.input) &&
		isOptionalNonNegativeNumber(value.output) &&
		isOptionalNonNegativeNumber(value.totalTokens) &&
		isOptionalNonNegativeNumber(value.cost)
	);
}

function isIsoDate(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function assertJournalIdentity(sequence: number, key: string, occurrence: number): void {
	if (!Number.isSafeInteger(sequence) || sequence <= 0) {
		throw new Error("Workflow journal sequence must be a positive safe integer.");
	}
	if (!key) throw new Error("Workflow journal key must not be empty.");
	if (!Number.isSafeInteger(occurrence) || occurrence < 0) {
		throw new Error("Workflow journal occurrence must be a non-negative safe integer.");
	}
}

function assertRegularFileOrMissing(path: string, description: string): void {
	try {
		if (!lstatSync(path).isFile()) throw new Error(`Refusing non-regular ${description} path: ${path}`);
	} catch (error) {
		if (isErrno(error, "ENOENT")) return;
		throw error;
	}
}

function assertWorkflowFileSize(path: string): void {
	if (lstatSync(path).size > 256 * 1024) throw new Error("workflow source exceeds 262144 bytes");
}

function isRealFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

function isRealDirectory(path: string): boolean {
	try {
		return lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

function* ancestorDirectories(cwd: string): Generator<string> {
	const repositoryRoot = findRepositoryRoot(cwd);
	for (const current of filesystemAncestors(cwd)) {
		yield current;
		if (repositoryRoot && current === repositoryRoot) return;
	}
}

function* filesystemAncestors(cwd: string): Generator<string> {
	let current = resolve(cwd);
	while (true) {
		yield current;
		const parent = dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

function findRepositoryRoot(cwd: string): string | undefined {
	for (const current of filesystemAncestors(cwd)) {
		try {
			const gitMarker = lstatSync(join(current, ".git"));
			if (!gitMarker.isSymbolicLink() && (gitMarker.isDirectory() || gitMarker.isFile())) return current;
		} catch {
			// Keep walking toward the filesystem root.
		}
	}
	return undefined;
}

function findClosestProjectWorkflowRoot(cwd: string): string | undefined {
	for (const projectRoot of ancestorDirectories(cwd)) {
		const candidate = join(projectRoot, ...PROJECT_WORKFLOW_COMPONENTS);
		if (existsSync(candidate)) return projectRoot;
	}
	return undefined;
}

function ensureProjectWorkflowDirectory(projectRoot: string): void {
	let current = projectRoot;
	for (const component of PROJECT_WORKFLOW_COMPONENTS) {
		current = join(current, component);
		if (existsSync(current)) {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink()) throw new Error(`Refusing symlinked project workflow path: ${current}`);
			if (!stat.isDirectory()) throw new Error(`Project workflow path component is not a directory: ${current}`);
			continue;
		}
		mkdirSync(current, { mode: 0o700 });
	}
	if (!isProjectWorkflowDirectorySafe(projectRoot, true)) {
		throw new Error(
			`Refusing unsafe project workflow directory: ${join(projectRoot, ...PROJECT_WORKFLOW_COMPONENTS)}`,
		);
	}
}

function isProjectWorkflowDirectorySafe(projectRoot: string, requireDirectory: boolean): boolean {
	let current = projectRoot;
	for (const component of PROJECT_WORKFLOW_COMPONENTS) {
		current = join(current, component);
		try {
			const stat = lstatSync(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
		} catch (error) {
			if (!requireDirectory && isErrno(error, "ENOENT")) return false;
			return false;
		}
	}
	return true;
}

function isErrno(error: unknown, code: string): boolean {
	return isRecord(error) && error.code === code;
}
