import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/** One unresolved tool call declared by the authorized assistant entry. */
export interface WorkerRecoveryToolCall {
	id: string;
	name: string;
}

/**
 * Legacy busy journal record without v2 mutation authority. Kept parseable for
 * backward compatibility; it cannot authorize recovery mutation or completion.
 */
export interface WorkerRecoveryRecordV1 {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

/**
 * Validated v2 recovery authority checkpoint. Every busy epoch has one stable
 * `operationId`, created at the first durable busy checkpoint and reused until
 * the session becomes idle. Changes to session generation, agent dir, path,
 * head, assistant entry, tool calls, or lineage force a new record.
 */
export interface WorkerRecoveryRecordV2 {
	version: 2;
	activeSessionId: string;
	sessionId: string;
	/** Lease namespace the catalog must use to recover the canonical session path. */
	agentDir: string;
	sessionFile?: string;
	/** Exact active branch head; null for an empty branch. */
	headEntryId: string | null;
	/** Latest assistant entry on the active branch, when one exists. */
	assistantEntryId: string | null;
	/** Exact unresolved `{ id, name }` set declared by the assistant entry. */
	toolCalls: WorkerRecoveryToolCall[];
	/** SHA-256 over the ordered active branch identities and parent links. */
	lineageDigest: string;
	/** Stable id for the busy epoch; a new id is allocated after the session becomes idle. */
	operationId: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

export type WorkerRecoveryRecord = WorkerRecoveryRecordV1 | WorkerRecoveryRecordV2;

export interface WorkerRecoveryRecordInput {
	activeSessionId: string;
	sessionId: string;
	agentDir?: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	headEntryId?: string | null;
	assistantEntryId?: string | null;
	toolCalls?: WorkerRecoveryToolCall[];
	lineageDigest?: string;
}

export function isV2WorkerRecoveryRecord(record: WorkerRecoveryRecord): record is WorkerRecoveryRecordV2 {
	return record.version === 2;
}

function isToolCall(value: unknown): value is WorkerRecoveryToolCall {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const call = value as WorkerRecoveryToolCall;
	return typeof call.id === "string" && typeof call.name === "string";
}

function parseV2(record: Record<string, unknown>): WorkerRecoveryRecordV2 | undefined {
	if (record.version !== 2) {
		return undefined;
	}
	if (
		typeof record.activeSessionId !== "string" ||
		typeof record.sessionId !== "string" ||
		typeof record.agentDir !== "string" ||
		typeof record.busy !== "boolean" ||
		typeof record.operation !== "string" ||
		typeof record.operationId !== "string" ||
		typeof record.lineageDigest !== "string" ||
		typeof record.recordedAt !== "string" ||
		(typeof record.sessionFile !== "undefined" && typeof record.sessionFile !== "string") ||
		(typeof record.headEntryId !== "string" && record.headEntryId !== null) ||
		(typeof record.assistantEntryId !== "string" && record.assistantEntryId !== null) ||
		!Array.isArray(record.toolCalls) ||
		!record.toolCalls.every(isToolCall)
	) {
		return undefined;
	}
	return record as unknown as WorkerRecoveryRecordV2;
}

function parseV1(record: Record<string, unknown>): WorkerRecoveryRecordV1 | undefined {
	if (record.version !== 1) {
		return undefined;
	}
	if (
		typeof record.activeSessionId !== "string" ||
		typeof record.sessionId !== "string" ||
		typeof record.busy !== "boolean" ||
		typeof record.operation !== "string" ||
		typeof record.recordedAt !== "string" ||
		(typeof record.sessionFile !== "undefined" && typeof record.sessionFile !== "string")
	) {
		return undefined;
	}
	return record as unknown as WorkerRecoveryRecordV1;
}

function parseRecord(line: string): WorkerRecoveryRecord | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	return parseV2(parsed as Record<string, unknown>) ?? parseV1(parsed as Record<string, unknown>);
}

function parseRecords(path: string): Map<string, WorkerRecoveryRecord> {
	const latest = new Map<string, WorkerRecoveryRecord>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return latest;
		}
		throw error;
	}
	for (const line of contents.split("\n")) {
		if (!line) {
			continue;
		}
		const record = parseRecord(line);
		if (record) {
			latest.set(record.activeSessionId, record);
		}
	}
	return latest;
}

function toolCallsEqual(a: WorkerRecoveryToolCall[], b: WorkerRecoveryToolCall[]): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i]!.id !== b[i]!.id || a[i]!.name !== b[i]!.name) {
			return false;
		}
	}
	return true;
}

/** True when the checkpoint matches the previous v2 record exactly (authority, busy, operation). */
function sameV2Checkpoint(previous: WorkerRecoveryRecord | undefined, record: WorkerRecoveryRecord): boolean {
	if (previous?.version !== 2 || record.version !== 2) {
		return false;
	}
	return (
		previous.sessionId === record.sessionId &&
		previous.agentDir === record.agentDir &&
		previous.sessionFile === record.sessionFile &&
		previous.headEntryId === record.headEntryId &&
		previous.assistantEntryId === record.assistantEntryId &&
		previous.lineageDigest === record.lineageDigest &&
		toolCallsEqual(previous.toolCalls, record.toolCalls) &&
		previous.busy === record.busy &&
		previous.operation === record.operation
	);
}

function isV2Input(input: WorkerRecoveryRecordInput): boolean {
	return (
		input.agentDir !== undefined ||
		input.headEntryId !== undefined ||
		input.assistantEntryId !== undefined ||
		input.toolCalls !== undefined ||
		input.lineageDigest !== undefined
	);
}

function assertV2Input(input: WorkerRecoveryRecordInput): void {
	if (
		typeof input.agentDir !== "string" ||
		(typeof input.headEntryId !== "string" && input.headEntryId !== null) ||
		(typeof input.assistantEntryId !== "string" && input.assistantEntryId !== null) ||
		!Array.isArray(input.toolCalls) ||
		typeof input.lineageDigest !== "string"
	) {
		throw new Error("v2 recovery checkpoints require the complete authority snapshot");
	}
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.latest = parseRecords(path);
	}

	record(input: WorkerRecoveryRecordInput): void {
		const previous = this.latest.get(input.activeSessionId);
		let record: WorkerRecoveryRecord;
		if (isV2Input(input)) {
			assertV2Input(input);
			record = this.buildV2Record(input, previous);
		} else if (previous?.version === 2) {
			// Backward-compatible v1-style input (e.g. the supervisor's recovery
			// hold) that follows a v2 checkpoint: inherit the epoch authority so the
			// journal stays one coherent v2 stream and completion stays idempotent.
			record = this.buildV2Record(
				{
					...input,
					agentDir: previous.agentDir,
					sessionFile: input.sessionFile ?? previous.sessionFile,
					headEntryId: previous.headEntryId,
					assistantEntryId: previous.assistantEntryId,
					toolCalls: previous.toolCalls,
					lineageDigest: previous.lineageDigest,
				},
				previous,
			);
		} else {
			record = {
				version: 1,
				...input,
				recordedAt: new Date().toISOString(),
			};
		}
		if (sameV2Checkpoint(previous, record)) {
			return;
		}
		this.append(record);
		this.latest.set(record.activeSessionId, record);
		this.compactIfAllIdle();
	}

	private buildV2Record(
		input: WorkerRecoveryRecordInput,
		previous: WorkerRecoveryRecord | undefined,
	): WorkerRecoveryRecordV2 {
		// One stable operation id per busy epoch: reused while busy follows busy,
		// inherited by the idle record that closes the epoch, and freshly allocated
		// for the first busy checkpoint and for any busy checkpoint after idle.
		const operationId = input.busy
			? previous?.version === 2 && previous.busy
				? previous.operationId
				: randomUUID()
			: previous?.version === 2
				? previous.operationId
				: randomUUID();
		return {
			version: 2,
			activeSessionId: input.activeSessionId,
			sessionId: input.sessionId,
			agentDir: input.agentDir!,
			...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
			headEntryId: input.headEntryId!,
			assistantEntryId: input.assistantEntryId!,
			toolCalls: input.toolCalls!,
			lineageDigest: input.lineageDigest!,
			operationId,
			busy: input.busy,
			operation: input.operation,
			recordedAt: new Date().toISOString(),
		};
	}

	/**
	 * Compare-and-set completion of a busy epoch. Re-reads the persisted latest
	 * record and closes the epoch only when it still carries `operationId`.
	 * Returns false when the latest record is legacy, absent, already superseded
	 * by a newer busy epoch, or owned by a different operation id.
	 */
	complete(activeSessionId: string, operationId: string): boolean {
		const latest = parseRecords(this.path).get(activeSessionId);
		if (!latest || latest.version !== 2 || latest.operationId !== operationId) {
			return false;
		}
		if (!latest.busy) {
			return true;
		}
		this.append({
			...latest,
			busy: false,
			operation: "recovery_complete",
			recordedAt: new Date().toISOString(),
		});
		this.latest.set(latest.activeSessionId, { ...latest, busy: false, operation: "recovery_complete" });
		this.compactIfAllIdle();
		return true;
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseRecords(path).values()];
	}

	private compactIfAllIdle(): void {
		if ([...this.latest.values()].every((entry) => !entry.busy)) {
			this.compact();
		}
	}

	private append(record: WorkerRecoveryRecord): void {
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.path, 0o600);
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(tempPath, `${[...this.latest.values()].map((record) => JSON.stringify(record)).join("\n")}\n`, {
			mode: 0o600,
		});
		chmodSync(tempPath, 0o600);
		renameSync(tempPath, this.path);
	}
}
