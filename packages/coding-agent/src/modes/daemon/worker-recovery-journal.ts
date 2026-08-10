import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { writeAllSync } from "../../utils/write-all-sync.js";

export interface WorkerRecoveryRecord {
	version: 1;
	activeSessionId: string;
	sessionId: string;
	sessionFile?: string;
	busy: boolean;
	operation: string;
	recordedAt: string;
}

const LINE_FEED = 0x0a;

function journalCorruption(lineNumber: number, reason: string): Error {
	return new Error(`Invalid worker recovery journal record at line ${lineNumber}: ${reason}`);
}

function parseRecord(value: unknown, lineNumber: number): WorkerRecoveryRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw journalCorruption(lineNumber, "record must be a JSON object");
	}
	const record = value as Partial<WorkerRecoveryRecord>;
	if (
		record.version !== 1 ||
		typeof record.activeSessionId !== "string" ||
		record.activeSessionId.length === 0 ||
		typeof record.sessionId !== "string" ||
		record.sessionId.length === 0 ||
		(record.sessionFile !== undefined && typeof record.sessionFile !== "string") ||
		typeof record.busy !== "boolean" ||
		typeof record.operation !== "string" ||
		record.operation.length === 0 ||
		typeof record.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(record.recordedAt))
	) {
		throw journalCorruption(lineNumber, "unsupported version or invalid recovery record fields");
	}
	return record as WorkerRecoveryRecord;
}

function parseLine(line: string, lineNumber: number): WorkerRecoveryRecord {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line) as unknown;
	} catch {
		throw journalCorruption(lineNumber, "malformed JSON outside the final partial append");
	}
	return parseRecord(parsed, lineNumber);
}

function applyRecord(latest: Map<string, WorkerRecoveryRecord>, record: WorkerRecoveryRecord): void {
	latest.set(record.activeSessionId, record);
}

function truncateTo(path: string, byteLength: number): void {
	const descriptor = openSync(path, "r+");
	try {
		ftruncateSync(descriptor, byteLength);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	chmodSync(path, 0o600);
}

function fsyncDirectoryBestEffort(path: string): void {
	try {
		const descriptor = openSync(path, "r");
		try {
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	} catch {
		// Some supported platforms do not allow opening or fsyncing directories.
		// The file was already fsynced and atomically renamed, so readers still see
		// either the old complete journal or the new complete journal.
	}
}

function appendMissingLineFeed(path: string): void {
	const descriptor = openSync(path, "a", 0o600);
	try {
		writeAllSync(descriptor, Buffer.from([LINE_FEED]));
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	chmodSync(path, 0o600);
}

function parseRecords(path: string, repairTail: boolean): Map<string, WorkerRecoveryRecord> {
	const latest = new Map<string, WorkerRecoveryRecord>();
	let contents: Buffer;
	try {
		contents = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return latest;
		}
		throw error;
	}

	const hasTrailingNewline = contents.length === 0 || contents[contents.length - 1] === LINE_FEED;
	const lastNewlineIndex = hasTrailingNewline ? contents.length - 1 : contents.lastIndexOf(LINE_FEED);
	const completeByteLength = hasTrailingNewline ? contents.length : lastNewlineIndex + 1;
	const completeLines = contents.subarray(0, completeByteLength).toString("utf8").split("\n");

	for (let index = 0; index < completeLines.length; index++) {
		const line = completeLines[index];
		if (!line) continue;
		applyRecord(latest, parseLine(line, index + 1));
	}

	if (hasTrailingNewline) {
		chmodSync(path, 0o600);
		return latest;
	}

	const finalLineNumber = completeLines.length;
	const tail = contents.subarray(completeByteLength).toString("utf8");
	let parsedTail: unknown;
	try {
		parsedTail = JSON.parse(tail) as unknown;
	} catch {
		if (repairTail) truncateTo(path, completeByteLength);
		return latest;
	}

	applyRecord(latest, parseRecord(parsedTail, finalLineNumber));
	if (repairTail) appendMissingLineFeed(path);
	return latest;
}

/**
 * Durable worker-operation journal used to decide whether a recovered session
 * was interrupted while busy. Only one incomplete final append is repairable;
 * malformed complete records fail closed because silently skipping one could
 * turn an interrupted mutation into an apparently idle session.
 */
export class WorkerRecoveryJournal {
	private readonly latest: Map<string, WorkerRecoveryRecord>;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.latest = parseRecords(path, true);
	}

	record(input: Omit<WorkerRecoveryRecord, "version" | "recordedAt">): void {
		const previous = this.latest.get(input.activeSessionId);
		if (
			previous?.sessionId === input.sessionId &&
			previous.busy === input.busy &&
			previous.operation === input.operation &&
			previous.sessionFile === input.sessionFile
		) {
			return;
		}
		const record: WorkerRecoveryRecord = {
			version: 1,
			...input,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		this.latest.set(record.activeSessionId, record);
		if ([...this.latest.values()].every((entry) => !entry.busy)) {
			try {
				this.compact();
			} catch {
				// The just-appended checkpoint is already durable. Compaction is only
				// bounded-size maintenance and will be retried after a later idle record.
			}
		}
	}

	getLatest(): WorkerRecoveryRecord[] {
		return [...this.latest.values()];
	}

	static readLatest(path: string): WorkerRecoveryRecord[] {
		return [...parseRecords(path, false).values()];
	}

	private append(record: WorkerRecoveryRecord): void {
		const descriptor = openSync(this.path, "a+", 0o600);
		const originalSize = fstatSync(descriptor).size;
		try {
			writeAllSync(descriptor, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
			fsyncSync(descriptor);
		} catch (error) {
			try {
				ftruncateSync(descriptor, originalSize);
				fsyncSync(descriptor);
			} catch {
				// Preserve the original append error. Constructor recovery will repair a
				// remaining final partial append before the next record is accepted.
			}
			throw error;
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.path, 0o600);
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
		const records = [...this.latest.values()];
		const encoded = Buffer.from(
			records.length > 0 ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
			"utf8",
		);
		try {
			const descriptor = openSync(tempPath, "wx", 0o600);
			try {
				writeAllSync(descriptor, encoded);
				fsyncSync(descriptor);
			} finally {
				closeSync(descriptor);
			}
			chmodSync(tempPath, 0o600);
			renameSync(tempPath, this.path);
			fsyncDirectoryBestEffort(dirname(this.path));
		} catch (error) {
			rmSync(tempPath, { force: true });
			throw error;
		}
	}
}
