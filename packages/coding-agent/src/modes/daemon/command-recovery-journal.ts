import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
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

export function createCommandIdempotencyKey(clientId: DaemonClientId, commandId: DaemonCommandId): string {
	return JSON.stringify([clientId, commandId]);
}

/**
 * Append-only command journal used at the supervisor boundary. A received
 * record is durable before a mutating command is dispatched; a missing result
 * after a crash is therefore treated as uncertain and is never replayed.
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
	): Exclude<CommandJournalBeginResult, { status: "new" }> | undefined {
		const existing = this.entries.get(createCommandIdempotencyKey(clientId, commandId));
		if (existing?.response) {
			return { status: "complete", response: existing.response };
		}
		return existing ? { status: "pending" } : undefined;
	}

	begin(clientId: DaemonClientId, commandId: DaemonCommandId, commandType: string): CommandJournalBeginResult {
		const key = createCommandIdempotencyKey(clientId, commandId);
		const existing = this.lookup(clientId, commandId);
		if (existing) return existing;
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
		if (!this.entries.has(key)) {
			return;
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
		let contents: string;
		try {
			contents = readFileSync(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return;
			}
			throw error;
		}
		for (const line of contents.split("\n")) {
			if (!line) {
				continue;
			}
			let record: JournalRecord;
			try {
				record = JSON.parse(line) as JournalRecord;
			} catch {
				// A crash may leave only the final append truncated.
				continue;
			}
			if (record.version !== 1 || typeof record.key !== "string") {
				continue;
			}
			this.recordCount++;
			if (record.type === "received") {
				if (
					typeof record.clientId === "string" &&
					typeof record.commandId === "string" &&
					typeof record.commandType === "string"
				) {
					this.entries.set(record.key, { received: record });
				}
				continue;
			}
			if (record.type === "acknowledged") {
				this.entries.delete(record.key);
				continue;
			}
			const entry = this.entries.get(record.key);
			if (entry && record.response?.type === "response") {
				entry.response = record.response;
			}
		}
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
