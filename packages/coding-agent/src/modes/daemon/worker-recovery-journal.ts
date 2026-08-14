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
import { lockSync } from "proper-lockfile";

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
 * Validated v2 recovery authority checkpoint. An unchanged busy authority
 * reuses one `operationId`; any authority change starts a new epoch so stale
 * completion cannot clear newer work. Idle also ends the epoch.
 */
export interface WorkerRecoveryRecordV2 {
	version: 2;
	activeSessionId: string;
	sessionId: string;
	/** Lease namespace the catalog must use to recover the canonical session path. */
	agentDir: string;
	sessionFile: string;
	/** Exact active branch head; null for an empty branch. */
	headEntryId: string | null;
	/** Latest assistant entry on the active branch, when one exists. */
	assistantEntryId: string | null;
	/** Exact unresolved `{ id, name }` set declared by the assistant entry. */
	toolCalls: ReadonlyArray<WorkerRecoveryToolCall>;
	/** SHA-256 over the ordered active branch identities and parent links. */
	lineageDigest: string;
	/** Stable id for this exact-authority busy epoch. */
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
	toolCalls?: ReadonlyArray<WorkerRecoveryToolCall>;
	lineageDigest?: string;
}

export function isV2WorkerRecoveryRecord(record: WorkerRecoveryRecord): record is WorkerRecoveryRecordV2 {
	return record.version === 2;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isToolCall(value: unknown): value is WorkerRecoveryToolCall {
	if (typeof value !== "object" || value === null) return false;
	const call = value as WorkerRecoveryToolCall;
	return isNonEmptyString(call.id) && isNonEmptyString(call.name);
}

function hasUniqueToolCallIds(value: readonly unknown[]): boolean {
	const ids = value.map((call) => (call as WorkerRecoveryToolCall).id);
	return new Set(ids).size === ids.length;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseV2(record: Record<string, unknown>): WorkerRecoveryRecordV2 | undefined {
	if (record.version !== 2) {
		return undefined;
	}
	if (
		!isNonEmptyString(record.activeSessionId) ||
		!isNonEmptyString(record.sessionId) ||
		!isNonEmptyString(record.agentDir) ||
		!isNonEmptyString(record.sessionFile) ||
		typeof record.busy !== "boolean" ||
		!isNonEmptyString(record.operation) ||
		!isNonEmptyString(record.operationId) ||
		!isUuid(record.operationId) ||
		typeof record.lineageDigest !== "string" ||
		!/^[0-9a-f]{64}$/i.test(record.lineageDigest) ||
		!isNonEmptyString(record.recordedAt) ||
		Number.isNaN(Date.parse(record.recordedAt)) ||
		(typeof record.headEntryId !== "string" && record.headEntryId !== null) ||
		(typeof record.headEntryId === "string" && record.headEntryId.length === 0) ||
		(typeof record.assistantEntryId !== "string" && record.assistantEntryId !== null) ||
		(typeof record.assistantEntryId === "string" && record.assistantEntryId.length === 0) ||
		!Array.isArray(record.toolCalls) ||
		!record.toolCalls.every(isToolCall) ||
		!hasUniqueToolCallIds(record.toolCalls) ||
		(record.headEntryId === null && record.assistantEntryId !== null) ||
		(record.assistantEntryId === null && record.toolCalls.length > 0)
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

/**
 * Recover the session identity from an invalid checkpoint when it was written
 * far enough to include the complete JSON string. Journal serialization places
 * activeSessionId before every authority field, so a torn prefix without a
 * complete identity cannot contain a later authority change.
 */
function malformedActiveSessionId(line: string): string | undefined {
	try {
		const parsed = JSON.parse(line) as unknown;
		if (typeof parsed === "object" && parsed !== null) {
			const activeSessionId = (parsed as Record<string, unknown>).activeSessionId;
			if (isNonEmptyString(activeSessionId)) return activeSessionId;
		}
	} catch {
		// A truncated JSON object may still contain the complete identity token.
	}
	const token = /"activeSessionId"\s*:\s*("(?:\\.|[^"\\])*")/.exec(line)?.[1];
	if (!token) return undefined;
	try {
		const activeSessionId = JSON.parse(token) as unknown;
		return isNonEmptyString(activeSessionId) ? activeSessionId : undefined;
	} catch {
		return undefined;
	}
}

function parseRecords(path: string): Map<string, WorkerRecoveryRecord> {
	const indexed = new Map<string, { record: WorkerRecoveryRecord; index: number }>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
		throw error;
	}
	const lastMalformedIndex = new Map<string, number>();
	const lines = contents.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		if (!line) continue;
		const record = parseRecord(line);
		if (record) {
			indexed.set(record.activeSessionId, { record, index });
		} else {
			const activeSessionId = malformedActiveSessionId(line);
			if (activeSessionId) lastMalformedIndex.set(activeSessionId, index);
		}
	}
	const latest = new Map<string, WorkerRecoveryRecord>();
	for (const [activeSessionId, { record, index }] of indexed) {
		// A malformed later checkpoint for this session could contain an authority
		// change that was only partially persisted. Never fall back to that session's
		// older busy v2 authority; unrelated session records remain recoverable.
		const malformedIndex = lastMalformedIndex.get(activeSessionId) ?? -1;
		if (record.version === 2 && record.busy && index < malformedIndex) continue;
		latest.set(activeSessionId, record);
	}
	return latest;
}

function withJournalGuard<T>(path: string, action: () => T): T {
	let release: (() => void) | undefined;
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			release = lockSync(path, {
				realpath: false,
				lockfilePath: `${path}.guard`,
				stale: 5000,
			});
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ELOCKED") {
				throw error;
			}
			if (attempt === 99) {
				throw new Error(`Could not coordinate worker recovery journal: ${path}`);
			}
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
		}
	}
	if (!release) {
		throw new Error(`Could not coordinate worker recovery journal: ${path}`);
	}
	try {
		return action();
	} finally {
		release();
	}
}

function toolCallsEqual(a: ReadonlyArray<WorkerRecoveryToolCall>, b: ReadonlyArray<WorkerRecoveryToolCall>): boolean {
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

function sameV2Authority(
	previous: WorkerRecoveryRecord | undefined,
	record: Pick<
		WorkerRecoveryRecordV2,
		"sessionId" | "agentDir" | "sessionFile" | "headEntryId" | "assistantEntryId" | "toolCalls" | "lineageDigest"
	>,
): previous is WorkerRecoveryRecordV2 {
	return (
		previous?.version === 2 &&
		previous.sessionId === record.sessionId &&
		previous.agentDir === record.agentDir &&
		previous.sessionFile === record.sessionFile &&
		previous.headEntryId === record.headEntryId &&
		previous.assistantEntryId === record.assistantEntryId &&
		previous.lineageDigest === record.lineageDigest &&
		toolCallsEqual(previous.toolCalls, record.toolCalls)
	);
}

/** True when the checkpoint matches the previous v2 record exactly (authority, busy, operation). */
function sameV2Checkpoint(previous: WorkerRecoveryRecord | undefined, record: WorkerRecoveryRecord): boolean {
	return (
		record.version === 2 &&
		sameV2Authority(previous, record) &&
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
		!isNonEmptyString(input.activeSessionId) ||
		!isNonEmptyString(input.sessionId) ||
		!isNonEmptyString(input.agentDir) ||
		!isNonEmptyString(input.sessionFile) ||
		!isNonEmptyString(input.operation) ||
		(typeof input.headEntryId !== "string" && input.headEntryId !== null) ||
		(typeof input.headEntryId === "string" && input.headEntryId.length === 0) ||
		(typeof input.assistantEntryId !== "string" && input.assistantEntryId !== null) ||
		(typeof input.assistantEntryId === "string" && input.assistantEntryId.length === 0) ||
		!Array.isArray(input.toolCalls) ||
		!input.toolCalls.every(isToolCall) ||
		!hasUniqueToolCallIds(input.toolCalls) ||
		typeof input.lineageDigest !== "string" ||
		!/^[0-9a-f]{64}$/i.test(input.lineageDigest) ||
		(input.headEntryId === null && input.assistantEntryId !== null) ||
		(input.assistantEntryId === null && input.toolCalls.length > 0)
	) {
		throw new Error("v2 recovery checkpoints require a valid complete authority snapshot");
	}
}

export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.latest = parseRecords(path);
	}

	record(input: WorkerRecoveryRecordInput): WorkerRecoveryRecord {
		return withJournalGuard(this.path, () => {
			this.refreshLatest();
			const previous = this.latest.get(input.activeSessionId);
			let record: WorkerRecoveryRecord;
			if (isV2Input(input)) {
				assertV2Input(input);
				record = this.buildV2Record(input, previous);
			} else if (previous?.version === 2) {
				// Backward-compatible v1-style input following a v2 checkpoint keeps
				// the same authority. New recovery code completes epochs through CAS.
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
				// The checkpoint is byte-identical to the persisted latest record;
				// return that durable record rather than the reconstructed one so
				// callers observe the real persisted authority and recordedAt.
				return previous!;
			}
			this.append(record);
			this.latest.set(record.activeSessionId, record);
			this.compactIfAllIdle();
			return record;
		});
	}

	private buildV2Record(
		input: WorkerRecoveryRecordInput,
		previous: WorkerRecoveryRecord | undefined,
	): WorkerRecoveryRecordV2 {
		// Reuse only while the exact authority remains busy. Authority changes and
		// the first busy checkpoint after idle start a new CAS-fenced epoch; an idle
		// checkpoint inherits the operation id it closes.
		const authority = {
			sessionId: input.sessionId,
			agentDir: input.agentDir!,
			sessionFile: input.sessionFile!,
			headEntryId: input.headEntryId!,
			assistantEntryId: input.assistantEntryId!,
			toolCalls: input.toolCalls!,
			lineageDigest: input.lineageDigest!,
		};
		const operationId = input.busy
			? previous?.version === 2 && previous.busy && sameV2Authority(previous, authority)
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
			sessionFile: input.sessionFile!,
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
		return withJournalGuard(this.path, () => {
			this.refreshLatest();
			const latest = this.latest.get(activeSessionId);
			if (!latest || latest.version !== 2 || latest.operationId !== operationId) {
				return false;
			}
			if (!latest.busy) {
				return true;
			}
			const completed: WorkerRecoveryRecordV2 = {
				...latest,
				busy: false,
				operation: "recovery_complete",
				recordedAt: new Date().toISOString(),
			};
			this.append(completed);
			this.latest.set(latest.activeSessionId, completed);
			this.compactIfAllIdle();
			return true;
		});
	}

	/**
	 * Acknowledge one legacy busy record without granting it transcript mutation
	 * authority. The journal-local guard prevents a stale supervisor from
	 * overwriting a concurrently written v2 checkpoint for the same session.
	 */
	completeLegacy(activeSessionId: string): boolean {
		return withJournalGuard(this.path, () => {
			this.refreshLatest();
			const latest = this.latest.get(activeSessionId);
			if (!latest || latest.version !== 1 || !latest.busy) return false;
			const completed: WorkerRecoveryRecordV1 = {
				...latest,
				busy: false,
				operation: "legacy_recovery_stale",
				recordedAt: new Date().toISOString(),
			};
			this.append(completed);
			this.latest.set(activeSessionId, completed);
			this.compactIfAllIdle();
			return true;
		});
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseRecords(path).values()];
	}

	private refreshLatest(): void {
		this.latest.clear();
		for (const [activeSessionId, record] of parseRecords(this.path)) {
			this.latest.set(activeSessionId, record);
		}
	}

	private compactIfAllIdle(): void {
		if ([...this.latest.values()].every((entry) => !entry.busy)) {
			this.compact();
		}
	}

	private append(record: WorkerRecoveryRecord): void {
		let separator = "";
		try {
			const contents = readFileSync(this.path);
			if (contents.length > 0 && contents.at(-1) !== 0x0a) separator = "\n";
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, `${separator}${JSON.stringify(record)}\n`);
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
