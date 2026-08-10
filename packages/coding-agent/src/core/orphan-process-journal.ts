import {
	chmodSync,
	closeSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { dirname } from "node:path";
import { writeAllSync } from "../utils/write-all-sync.js";
import { getProcessStartId } from "./session-lease.js";

export const ORPHAN_PROCESS_JOURNAL_ENV = "PRIME_AGENT_INTERNAL_ORPHAN_PROCESS_JOURNAL";

interface OrphanProcessRecord {
	version: 1;
	pid: number;
	ownerPid: number;
	processStartId?: string;
	active: boolean;
	recordedAt: string;
}

export interface ActiveOrphanProcess {
	pid: number;
	processStartId: string;
}

const LINE_FEED = 0x0a;

function journalCorruption(lineNumber: number, reason: string): Error {
	return new Error(`Invalid orphan process journal record at line ${lineNumber}: ${reason}`);
}

function parseRecord(value: unknown, lineNumber: number): OrphanProcessRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw journalCorruption(lineNumber, "record must be a JSON object");
	}
	const record = value as Partial<OrphanProcessRecord>;
	if (
		record.version !== 1 ||
		!Number.isInteger(record.pid) ||
		(record.pid ?? 0) <= 0 ||
		!Number.isInteger(record.ownerPid) ||
		(record.ownerPid ?? 0) <= 0 ||
		(record.processStartId !== undefined && typeof record.processStartId !== "string") ||
		typeof record.active !== "boolean" ||
		typeof record.recordedAt !== "string" ||
		!Number.isFinite(Date.parse(record.recordedAt))
	) {
		throw journalCorruption(lineNumber, "unsupported version or invalid process identity fields");
	}
	return record as OrphanProcessRecord;
}

function parseLine(line: string, lineNumber: number): OrphanProcessRecord | undefined {
	try {
		return parseRecord(JSON.parse(line) as unknown, lineNumber);
	} catch {
		// Orphan cleanup is best effort. One damaged record must not prevent later
		// valid process identities from being reaped during supervisor recovery.
		return undefined;
	}
}

function parseJournal(path: string): OrphanProcessRecord[] {
	let contents: Buffer;
	try {
		contents = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return [];
		}
		throw error;
	}

	const records: OrphanProcessRecord[] = [];
	const hasTrailingNewline = contents.length === 0 || contents[contents.length - 1] === LINE_FEED;
	const lastNewlineIndex = hasTrailingNewline ? contents.length - 1 : contents.lastIndexOf(LINE_FEED);
	const completeByteLength = hasTrailingNewline ? contents.length : lastNewlineIndex + 1;
	const completeLines = contents.subarray(0, completeByteLength).toString("utf8").split("\n");

	for (let index = 0; index < completeLines.length; index++) {
		const line = completeLines[index];
		if (!line) continue;
		const record = parseLine(line, index + 1);
		if (record) records.push(record);
	}

	if (hasTrailingNewline) return records;

	const tail = contents.subarray(completeByteLength).toString("utf8");
	const record = parseLine(tail, completeLines.length);
	if (record) records.push(record);
	return records;
}

function repairFinalAppend(path: string): void {
	let contents: Buffer;
	try {
		contents = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (contents.length === 0 || contents[contents.length - 1] === LINE_FEED) return;

	const lastNewlineIndex = contents.lastIndexOf(LINE_FEED);
	const completeByteLength = lastNewlineIndex + 1;
	const tail = contents.subarray(completeByteLength).toString("utf8");
	let tailIsComplete = false;
	try {
		JSON.parse(tail);
		tailIsComplete = true;
	} catch {
		// A syntactically incomplete final append is the only record we truncate.
		// A complete but invalid record is preserved and skipped by the reader.
	}

	const descriptor = openSync(path, tailIsComplete ? "a" : "r+");
	try {
		if (tailIsComplete) {
			writeAllSync(descriptor, Buffer.from([LINE_FEED]));
		} else {
			ftruncateSync(descriptor, completeByteLength);
		}
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

export function recordOrphanProcessState(pid: number, active: boolean): void {
	const path = process.env[ORPHAN_PROCESS_JOURNAL_ENV];
	if (!path || !Number.isInteger(pid) || pid <= 0) {
		return;
	}
	const processStartId = active ? getProcessStartId(pid) : undefined;
	const record: OrphanProcessRecord = {
		version: 1,
		pid,
		ownerPid: process.pid,
		...(processStartId ? { processStartId } : {}),
		active,
		recordedAt: new Date().toISOString(),
	};
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		repairFinalAppend(path);
		const descriptor = openSync(path, "a+", 0o600);
		const originalSize = fstatSync(descriptor).size;
		try {
			writeAllSync(descriptor, Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
			fsyncSync(descriptor);
		} catch (error) {
			try {
				ftruncateSync(descriptor, originalSize);
				fsyncSync(descriptor);
			} catch {
				// Preserve the original write error; a later writer repairs only the
				// final partial append before accepting another record.
			}
			throw error;
		} finally {
			closeSync(descriptor);
		}
		chmodSync(path, 0o600);
	} catch {
		// Process tracking must not make a successfully spawned command fail.
	}
}

export function readActiveOrphanProcesses(path: string, ownerPid: number): ActiveOrphanProcess[] {
	const latest = new Map<number, OrphanProcessRecord>();
	for (const record of parseJournal(path)) {
		if (record.ownerPid === ownerPid) latest.set(record.pid, record);
	}
	return [...latest.values()]
		.filter(
			(record): record is OrphanProcessRecord & { processStartId: string } =>
				record.active && typeof record.processStartId === "string",
		)
		.map((record) => ({ pid: record.pid, processStartId: record.processStartId }));
}

export function isOrphanProcessIdentityCurrent(orphan: ActiveOrphanProcess): boolean {
	return getProcessStartId(orphan.pid) === orphan.processStartId;
}

export function clearOrphanProcessJournal(path: string): void {
	rmSync(path, { force: true });
	try {
		const directoryDescriptor = openSync(dirname(path), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
	} catch {
		// Directory fsync is unavailable on some platforms. The journal has already
		// been unlinked, and a stale file is still safe because process-start identity
		// checks prevent PID reuse from killing an unrelated process.
	}
}
