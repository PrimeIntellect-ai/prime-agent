import {
	chmodSync,
	closeSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DaemonClientId, DaemonCommandId, DaemonResponse } from "./daemon-protocol.js";

interface ReceivedRecord {
	version: 1;
	type: "received";
	key: string;
	clientId: DaemonClientId;
	commandId: DaemonCommandId;
	commandType: string;
	recordedAt: string;
}

interface ResultRecord {
	version: 1;
	type: "result";
	key: string;
	response: DaemonResponse;
	recordedAt: string;
}

interface AcknowledgedRecord {
	version: 1;
	type: "acknowledged";
	key: string;
	recordedAt: string;
}

type JournalRecord = ReceivedRecord | ResultRecord | AcknowledgedRecord;

interface JournalEntry {
	received: ReceivedRecord;
	response?: DaemonResponse;
}

export type CommandJournalBeginResult =
	| { status: "new" }
	| { status: "pending" }
	| { status: "complete"; response: DaemonResponse };

const COMPACT_AFTER_RECORDS = 4096;
const LINE_FEED = 0x0a;

export function createCommandIdempotencyKey(clientId: DaemonClientId, commandId: DaemonCommandId): string {
	return JSON.stringify([clientId, commandId]);
}

function journalCorruption(lineNumber: number, reason: string): Error {
	return new Error(`Invalid command recovery journal record at line ${lineNumber}: ${reason}`);
}

function assertCommandTypeMatches(entry: JournalEntry, key: string, commandType: string): void {
	if (entry.received.commandType === commandType) return;
	throw new Error(
		`Daemon idempotency key ${key} was already received as ${entry.received.commandType} and cannot be reused as ${commandType}`,
	);
}

function assertResponseMatchesReceipt(entry: JournalEntry, key: string, response: DaemonResponse): void {
	if (response.id !== entry.received.commandId) {
		throw new Error(
			`Daemon response id ${response.id} does not match received command id ${entry.received.commandId} for ${key}`,
		);
	}
	if (response.command !== entry.received.commandType) {
		throw new Error(
			`Daemon response command ${response.command} does not match received command type ${entry.received.commandType} for ${key}`,
		);
	}
}

function responsesEqual(left: DaemonResponse, right: DaemonResponse): boolean {
	return isDeepStrictEqual(left, right);
}

/**
 * Append-only command journal used at the supervisor boundary. A received
 * record is durable before a mutating command is dispatched; a missing result
 * after a crash is therefore treated as uncertain and is never replayed.
 *
 * The pair [clientId, commandId] identifies one logical command for the life of
 * the journal. Reusing that key for a different command type or recording a
 * response whose id/type does not match the durable receipt is rejected before
 * the inconsistent state can be persisted.
 */
export class CommandRecoveryJournal {
	private readonly entries = new Map<string, JournalEntry>();
	private recordCount = 0;

	constructor(private readonly path: string) {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.load();
	}

	lookup(
		clientId: DaemonClientId,
		commandId: DaemonCommandId,
		commandType?: string,
	): Exclude<CommandJournalBeginResult, { status: "new" }> | undefined {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const existing = this.entries.get(key);
		if (existing && commandType !== undefined) {
			assertCommandTypeMatches(existing, key, commandType);
		}
		if (existing?.response) {
			return { status: "complete", response: existing.response };
		}
		return existing ? { status: "pending" } : undefined;
	}

	begin(clientId: DaemonClientId, commandId: DaemonCommandId, commandType: string): CommandJournalBeginResult {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const entry = this.entries.get(key);
		if (entry) {
			assertCommandTypeMatches(entry, key, commandType);
			return entry.response ? { status: "complete", response: entry.response } : { status: "pending" };
		}
		const received: ReceivedRecord = {
			version: 1,
			type: "received",
			key,
			clientId,
			commandId,
			commandType,
			recordedAt: new Date().toISOString(),
		};
		this.append(received);
		this.entries.set(key, { received });
		return { status: "new" };
	}

	recordResult(clientId: DaemonClientId, commandId: DaemonCommandId, response: DaemonResponse): void {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const entry = this.entries.get(key);
		if (!entry) {
			throw new Error(`Cannot record a result before command receipt: ${key}`);
		}
		assertResponseMatchesReceipt(entry, key, response);
		if (entry.response) {
			if (responsesEqual(entry.response, response)) return;
			throw new Error(`Cannot replace the durable result for daemon command ${key} with a conflicting response`);
		}
		const record: ResultRecord = {
			version: 1,
			type: "result",
			key,
			response,
			recordedAt: new Date().toISOString(),
		};
		this.append(record);
		entry.response = response;
		if (this.recordCount >= COMPACT_AFTER_RECORDS) {
			this.compact();
		}
	}

	acknowledge(clientId: DaemonClientId, commandId: DaemonCommandId): void {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const entry = this.entries.get(key);
		if (!entry) {
			return;
		}
		if (!entry.response) {
			throw new Error(`Cannot acknowledge daemon command ${key} before its result is durable`);
		}
		this.append({
			version: 1,
			type: "acknowledged",
			key,
			recordedAt: new Date().toISOString(),
		});
		this.entries.delete(key);
		if (this.entries.size === 0 || this.recordCount >= COMPACT_AFTER_RECORDS) {
			this.compact();
		}
	}

	private load(): void {
		let contents: Buffer;
		try {
			contents = readFileSync(this.path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
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
			this.applyParsedRecord(this.parseCompleteLine(line, index + 1), index + 1);
		}

		if (hasTrailingNewline) {
			return;
		}

		const finalLineNumber = completeLines.length;
		const tail = contents.subarray(completeByteLength).toString("utf8");
		let parsedTail: unknown;
		try {
			parsedTail = JSON.parse(tail) as unknown;
		} catch {
			// A crash may leave one incomplete final append. Remove it now so a
			// subsequent append cannot concatenate a valid record onto corrupt bytes.
			this.truncateTo(completeByteLength);
			return;
		}

		// A complete final record whose line feed was not persisted remains valid.
		// Apply it and restore the append boundary before accepting new writes.
		this.applyParsedRecord(parsedTail, finalLineNumber);
		this.appendMissingLineFeed();
	}

	private parseCompleteLine(line: string, lineNumber: number): unknown {
		try {
			return JSON.parse(line) as unknown;
		} catch {
			throw journalCorruption(lineNumber, "malformed JSON outside the final partial append");
		}
	}

	private applyParsedRecord(parsedValue: unknown, lineNumber: number): void {
		if (typeof parsedValue !== "object" || parsedValue === null || Array.isArray(parsedValue)) {
			throw journalCorruption(lineNumber, "record must be a JSON object");
		}
		const parsed = parsedValue as Record<string, unknown>;
		if (parsed.version !== 1 || typeof parsed.type !== "string" || typeof parsed.key !== "string") {
			throw journalCorruption(lineNumber, "unsupported version or missing type/key");
		}
		if (parsed.type !== "received" && parsed.type !== "result" && parsed.type !== "acknowledged") {
			throw journalCorruption(lineNumber, `unknown record type ${JSON.stringify(parsed.type)}`);
		}

		const record = parsed as unknown as JournalRecord;
		this.recordCount++;
		if (record.type === "received") {
			if (
				typeof record.clientId !== "string" ||
				typeof record.commandId !== "string" ||
				typeof record.commandType !== "string"
			) {
				throw journalCorruption(lineNumber, "received record is missing clientId, commandId, or commandType");
			}
			const expectedKey = createCommandIdempotencyKey(record.clientId, record.commandId);
			if (record.key !== expectedKey) {
				throw journalCorruption(lineNumber, `non-canonical key ${record.key}; expected ${expectedKey}`);
			}
			const existing = this.entries.get(record.key);
			if (existing) {
				try {
					assertCommandTypeMatches(existing, record.key, record.commandType);
				} catch (error) {
					throw journalCorruption(lineNumber, (error as Error).message);
				}
				return;
			}
			this.entries.set(record.key, { received: record });
			return;
		}

		const entry = this.entries.get(record.key);
		if (!entry) {
			throw journalCorruption(lineNumber, `${record.type} record has no preceding received record`);
		}
		if (record.type === "acknowledged") {
			if (!entry.response) {
				throw journalCorruption(lineNumber, "acknowledged record has no preceding durable result");
			}
			this.entries.delete(record.key);
			return;
		}
		if (!record.response || record.response.type !== "response") {
			throw journalCorruption(lineNumber, "result record is missing a daemon response");
		}
		try {
			assertResponseMatchesReceipt(entry, record.key, record.response);
		} catch (error) {
			throw journalCorruption(lineNumber, (error as Error).message);
		}
		if (entry.response && !responsesEqual(entry.response, record.response)) {
			throw journalCorruption(lineNumber, "conflicting durable results for one idempotency key");
		}
		entry.response = record.response;
	}

	private truncateTo(byteLength: number): void {
		const descriptor = openSync(this.path, "r+");
		try {
			ftruncateSync(descriptor, byteLength);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
	}

	private appendMissingLineFeed(): void {
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			const written = writeSync(descriptor, "\n");
			if (written !== 1) {
				throw new Error(`Could not restore command journal line boundary: wrote ${written} bytes`);
			}
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.path, 0o600);
	}

	private append(record: JournalRecord): void {
		const descriptor = openSync(this.path, "a", 0o600);
		try {
			writeSync(descriptor, `${JSON.stringify(record)}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		chmodSync(this.path, 0o600);
		this.recordCount++;
	}

	private compact(): void {
		const tempPath = `${this.path}.${process.pid}.tmp`;
		const records: JournalRecord[] = [];
		for (const [key, entry] of this.entries) {
			records.push(entry.received);
			if (entry.response) {
				records.push({
					version: 1,
					type: "result",
					key,
					response: entry.response,
					recordedAt: new Date().toISOString(),
				});
			}
		}
		const descriptor = openSync(tempPath, "w", 0o600);
		try {
			writeSync(descriptor, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
			fsyncSync(descriptor);
		} finally {
			closeSync(descriptor);
		}
		renameSync(tempPath, this.path);
		const directoryDescriptor = openSync(dirname(this.path), "r");
		try {
			fsyncSync(directoryDescriptor);
		} finally {
			closeSync(directoryDescriptor);
		}
		this.recordCount = records.length;
	}
}
