import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomicSync } from "../../utils/atomic-file.js";
import {
	CLOUD_MAX_ERROR_CHARS,
	CLOUD_MAX_RECEIPT_RESULT_CHARS,
	type CloudCommandId,
	type CloudCommandReceipt,
	type CloudCommandRequest,
	type CloudCommandState,
	canonicalJson,
	cloudDigest,
	cloudIdProblem,
	cloudRequestProblem,
	isCloudCommandState,
	isCloudDigest,
	isTerminalCloudCommandState,
} from "./protocol.js";

interface AdmitRecord {
	version: 1;
	type: "admit";
	commandId: CloudCommandId;
	digest: string;
	/** Canonical JSON of the admitted CloudCommandRequest. */
	request: string;
	recordedAt: string;
}

interface TransitionRecord {
	version: 1;
	type: "transition";
	commandId: CloudCommandId;
	state: CloudCommandState;
	/** Written by compaction so an uncertain command restores as uncertain. */
	uncertain?: true;
	error?: string;
	/** Terminal result payload (v3), e.g. a message delivery status. */
	result?: string;
	recordedAt: string;
}

type CloudJournalRecord = AdmitRecord | TransitionRecord;

interface JournalEntry {
	commandId: CloudCommandId;
	digest: string;
	request: string;
	submittedAt: string;
	updatedAt: string;
	state: CloudCommandState;
	uncertain: boolean;
	error?: string;
	result?: string;
}

export interface CloudCommandJournalOptions {
	/** Rewrite the journal atomically once this many records have accumulated. */
	compactAfterRecords?: number;
}

export type CloudAdmitStatus =
	| { status: "new"; receipt: CloudCommandReceipt }
	| { status: "duplicate"; receipt: CloudCommandReceipt }
	| { status: "conflict"; receipt: CloudCommandReceipt };

export interface CloudClaimedCommand {
	receipt: CloudCommandReceipt;
	/** Canonical JSON of the claimed command's request. */
	request: string;
}

const COMPACT_AFTER_RECORDS = 4096;

/**
 * Durable append-only command journal for one cloud session. Admissions and
 * transitions are fsynced before the call acknowledges them, so a crash after
 * any return value can never lose state. Claiming fsyncs the running
 * transition before the request is handed out, so a command restored accepted
 * was never dispatched and stays pending; a command restored running may have
 * started executing and is marked uncertain: claiming skips it until the host
 * explicitly requeues or settles it.
 */
export class CloudCommandJournal {
	private readonly entries = new Map<string, JournalEntry>();
	private readonly order: CloudCommandId[] = [];
	private recordCount = 0;
	private readonly compactAfterRecords: number;

	constructor(
		private readonly path: string,
		options: CloudCommandJournalOptions = {},
	) {
		this.compactAfterRecords = options.compactAfterRecords ?? COMPACT_AFTER_RECORDS;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		this.load();
	}

	/**
	 * Admit a command. The admit record is fsynced before the receipt is
	 * returned, so a duplicate or conflict response always reflects durable
	 * state. A retry with the same commandId and the same request digest
	 * replays the stored receipt; the same commandId with a different request
	 * is rejected as a conflict and never re-admitted.
	 */
	admit(commandId: CloudCommandId, request: CloudCommandRequest): CloudAdmitStatus {
		const idProblem = cloudIdProblem(commandId, "commandId");
		if (idProblem !== undefined) {
			throw new Error(idProblem);
		}
		const requestProblem = cloudRequestProblem(request);
		if (requestProblem !== undefined) {
			throw new Error(`invalid command request: ${requestProblem}`);
		}
		const requestJson = canonicalJson(request);
		const digest = cloudDigest(requestJson);
		const existing = this.entries.get(commandId);
		if (existing !== undefined) {
			return {
				status: existing.digest === digest ? "duplicate" : "conflict",
				receipt: receiptOf(existing),
			};
		}
		const recordedAt = new Date().toISOString();
		this.append({
			version: 1,
			type: "admit",
			commandId,
			digest,
			request: requestJson,
			recordedAt,
		});
		const entry: JournalEntry = {
			commandId,
			digest,
			request: requestJson,
			submittedAt: recordedAt,
			updatedAt: recordedAt,
			state: "accepted",
			uncertain: false,
		};
		this.entries.set(commandId, entry);
		this.order.push(commandId);
		this.maybeCompact();
		return { status: "new", receipt: receiptOf(entry) };
	}

	/** Claim the oldest dispatchable command; the running transition is fsynced before the request is handed out. */
	claimNextPending(): CloudClaimedCommand | undefined {
		for (const commandId of this.order) {
			const entry = this.entries.get(commandId);
			if (entry === undefined || entry.state !== "accepted" || entry.uncertain) {
				continue;
			}
			this.transitionTo(entry, "running");
			return { receipt: receiptOf(entry), request: entry.request };
		}
		return undefined;
	}

	markRunning(commandId: CloudCommandId): void {
		this.transitionTo(this.requireEntry(commandId), "running");
	}

	complete(commandId: CloudCommandId, result?: string): void {
		if (
			result !== undefined &&
			(typeof result !== "string" || result.length < 1 || result.length > CLOUD_MAX_RECEIPT_RESULT_CHARS)
		) {
			throw new Error(`result must be a string of at most ${CLOUD_MAX_RECEIPT_RESULT_CHARS} characters`);
		}
		this.transitionTo(this.requireEntry(commandId), "completed", undefined, result);
	}

	fail(commandId: CloudCommandId, error?: string): void {
		if (
			error !== undefined &&
			(typeof error !== "string" || error.length < 1 || error.length > CLOUD_MAX_ERROR_CHARS)
		) {
			throw new Error(`failure error must be a string of at most ${CLOUD_MAX_ERROR_CHARS} characters`);
		}
		this.transitionTo(this.requireEntry(commandId), "failed", error);
	}

	cancel(commandId: CloudCommandId): void {
		this.transitionTo(this.requireEntry(commandId), "cancelled");
	}

	/** Host assertion that an uncertain command never started; makes it dispatchable again. */
	requeue(commandId: CloudCommandId): void {
		const entry = this.requireEntry(commandId);
		if (!entry.uncertain) {
			throw new Error(`command ${commandId} is not uncertain`);
		}
		this.transitionTo(entry, "accepted");
	}

	getReceipt(commandId: CloudCommandId): CloudCommandReceipt | undefined {
		const entry = this.entries.get(commandId);
		return entry === undefined ? undefined : receiptOf(entry);
	}

	/** Receipts of commands restored without a terminal record, awaiting host reconciliation. */
	listUncertain(): CloudCommandReceipt[] {
		const receipts: CloudCommandReceipt[] = [];
		for (const commandId of this.order) {
			const entry = this.entries.get(commandId);
			if (entry !== undefined && entry.uncertain) {
				receipts.push(receiptOf(entry));
			}
		}
		return receipts;
	}

	/** Receipts of accepted commands the executor may claim, oldest first. */
	listPending(): CloudCommandReceipt[] {
		const receipts: CloudCommandReceipt[] = [];
		for (const commandId of this.order) {
			const entry = this.entries.get(commandId);
			if (entry !== undefined && entry.state === "accepted" && !entry.uncertain) {
				receipts.push(receiptOf(entry));
			}
		}
		return receipts;
	}

	private transitionTo(entry: JournalEntry, next: CloudCommandState, error?: string, result?: string): void {
		if (isTerminalCloudCommandState(entry.state)) {
			throw new Error(`command ${entry.commandId} already reached terminal state ${entry.state}`);
		}
		if (next === "running" && entry.uncertain) {
			throw new Error(`command ${entry.commandId} is uncertain after restore; requeue or settle it first`);
		}
		if (next === "running" && entry.state === "running") {
			return;
		}
		const recordedAt = new Date().toISOString();
		this.append({
			version: 1,
			type: "transition",
			commandId: entry.commandId,
			state: next,
			...(error === undefined ? {} : { error }),
			...(result === undefined ? {} : { result }),
			recordedAt,
		});
		entry.state = next;
		entry.updatedAt = recordedAt;
		entry.error = error;
		entry.result = result;
		// Both requeue (accepted) and terminal transitions settle uncertainty.
		entry.uncertain = false;
		this.maybeCompact();
	}

	private requireEntry(commandId: CloudCommandId): JournalEntry {
		const entry = this.entries.get(commandId);
		if (entry === undefined) {
			throw new Error(`unknown command: ${commandId}`);
		}
		return entry;
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
			if (line.length === 0) {
				continue;
			}
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				// A crash may leave only the final append truncated.
				continue;
			}
			this.foldRecord(record);
		}
		// A claim fsyncs the running transition before the request leaves the
		// journal, so an accepted command on disk was never dispatched: it
		// restores as pending. A running command may have started executing;
		// it is uncertain and must never be replayed automatically.
		for (const entry of this.entries.values()) {
			if (entry.state === "running") {
				entry.uncertain = true;
			}
		}
	}

	private foldRecord(value: unknown): void {
		if (!isRecord(value)) {
			return;
		}
		if (value.version !== 1) {
			return;
		}
		this.recordCount++;
		if (value.type === "admit") {
			this.foldAdmit(value);
			return;
		}
		if (value.type === "transition") {
			this.foldTransition(value);
		}
	}

	private foldAdmit(record: Record<string, unknown>): void {
		const commandId = record.commandId;
		const digest = record.digest;
		const request = record.request;
		const recordedAt = record.recordedAt;
		if (
			typeof commandId !== "string" ||
			cloudIdProblem(commandId, "commandId") !== undefined ||
			typeof digest !== "string" ||
			!isCloudDigest(digest) ||
			typeof request !== "string" ||
			typeof recordedAt !== "string"
		) {
			return;
		}
		let parsedRequest: unknown;
		try {
			parsedRequest = JSON.parse(request);
		} catch {
			return;
		}
		if (cloudRequestProblem(parsedRequest) !== undefined) {
			return;
		}
		// The stored digest must match the stored request; a mismatched pair is corruption.
		if (cloudDigest(canonicalJson(parsedRequest)) !== digest) {
			return;
		}
		// Admits are create-only; a repeated admit line (hand-edited journal) keeps the first.
		if (this.entries.has(commandId)) {
			return;
		}
		const entry: JournalEntry = {
			commandId,
			digest,
			request,
			submittedAt: recordedAt,
			updatedAt: recordedAt,
			state: "accepted",
			uncertain: false,
		};
		this.entries.set(commandId, entry);
		this.order.push(commandId);
	}

	private foldTransition(record: Record<string, unknown>): void {
		const commandId = record.commandId;
		const state = record.state;
		const recordedAt = record.recordedAt;
		const error = record.error;
		if (
			typeof commandId !== "string" ||
			cloudIdProblem(commandId, "commandId") !== undefined ||
			typeof state !== "string" ||
			!isCloudCommandState(state) ||
			typeof recordedAt !== "string"
		) {
			return;
		}
		if (
			error !== undefined &&
			(typeof error !== "string" || error.length < 1 || error.length > CLOUD_MAX_ERROR_CHARS)
		) {
			return;
		}
		// A transition without an admit line cannot be trusted; drop it.
		const entry = this.entries.get(commandId);
		if (entry === undefined) {
			return;
		}
		const result = record.result;
		if (
			result !== undefined &&
			(typeof result !== "string" || result.length < 1 || result.length > CLOUD_MAX_RECEIPT_RESULT_CHARS)
		) {
			return;
		}
		entry.state = state;
		entry.updatedAt = recordedAt;
		entry.uncertain = record.uncertain === true;
		entry.error = error;
		entry.result = result;
	}

	private append(record: CloudJournalRecord): void {
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

	/** Compaction must observe the caller's completed state mutation, so it never runs inside append. */
	private maybeCompact(): void {
		if (this.recordCount >= this.compactAfterRecords) {
			this.compact();
		}
	}

	private compact(): void {
		const records: CloudJournalRecord[] = [];
		for (const commandId of this.order) {
			const entry = this.entries.get(commandId);
			if (entry === undefined) {
				continue;
			}
			records.push({
				version: 1,
				type: "admit",
				commandId,
				digest: entry.digest,
				request: entry.request,
				recordedAt: entry.submittedAt,
			});
			if (entry.state !== "accepted" || entry.uncertain || entry.error !== undefined || entry.result !== undefined) {
				records.push({
					version: 1,
					type: "transition",
					commandId,
					state: entry.state,
					...(entry.uncertain ? { uncertain: true } : {}),
					...(entry.error === undefined ? {} : { error: entry.error }),
					...(entry.result === undefined ? {} : { result: entry.result }),
					recordedAt: entry.updatedAt,
				});
			}
		}
		const contents = records.map((record) => JSON.stringify(record)).join("\n");
		writeFileAtomicSync(this.path, records.length === 0 ? "" : `${contents}\n`, {
			mode: 0o600,
			fsync: true,
			fsyncDir: true,
		});
		this.recordCount = records.length;
	}
}

function receiptOf(entry: JournalEntry): CloudCommandReceipt {
	return {
		commandId: entry.commandId,
		digest: entry.digest,
		state: entry.state,
		submittedAt: entry.submittedAt,
		updatedAt: entry.updatedAt,
		uncertain: entry.uncertain,
		...(entry.error === undefined ? {} : { error: entry.error }),
		...(entry.result === undefined ? {} : { result: entry.result }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
