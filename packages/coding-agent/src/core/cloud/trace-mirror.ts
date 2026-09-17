import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CloudOutboxEvent } from "./event-outbox.js";
import { type CloudAck, type CloudCursor, type CloudSessionId, canonicalJson } from "./protocol.js";

interface MirrorState {
	version: 1;
	sessionId: CloudSessionId;
	generation: number | null;
	lastSequence: number;
	recentEventIds: readonly string[];
}

export interface CloudTraceSink {
	/** Resolve only after the event is durably persisted by the local trace. */
	persistCloudEvent(event: CloudOutboxEvent): Promise<void>;
}

export interface CloudTraceMirrorOptions {
	readonly directory: string;
	readonly sessionId: CloudSessionId;
	readonly sink: CloudTraceSink;
	readonly maxRecentEventIds?: number;
}

export type CloudTraceMirrorErrorCode = "corrupt" | "duplicate-mismatch" | "generation-gap" | "sequence-gap";

export class CloudTraceMirrorError extends Error {
	constructor(
		message: string,
		readonly code: CloudTraceMirrorErrorCode,
	) {
		super(message);
		this.name = "CloudTraceMirrorError";
	}
}

const STATE_FILE = "trace-mirror.json";
const DEFAULT_MAX_RECENT_IDS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function atomicWrite(path: string, value: MirrorState): void {
	const directory = dirname(path);
	const temp = join(directory, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, `${JSON.stringify(value)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	fsyncDirectory(directory);
}

function parseState(value: unknown, sessionId: string): MirrorState {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.sessionId !== sessionId ||
		!(value.generation === null || (Number.isInteger(value.generation) && (value.generation as number) >= 1)) ||
		!Number.isInteger(value.lastSequence) ||
		(value.lastSequence as number) < 0 ||
		!Array.isArray(value.recentEventIds) ||
		!value.recentEventIds.every((item) => typeof item === "string")
	) {
		throw new CloudTraceMirrorError("Cloud trace mirror state is corrupt", "corrupt");
	}
	return value as unknown as MirrorState;
}

function validateEnvelope(item: CloudOutboxEvent): void {
	if (
		!item ||
		typeof item.eventId !== "string" ||
		!item.eventId.startsWith("evt_") ||
		!Number.isInteger(item.generation) ||
		item.generation < 1 ||
		!item.event ||
		!Number.isInteger(item.event.sequence) ||
		item.event.sequence < 1
	) {
		throw new CloudTraceMirrorError("Cloud trace event envelope is invalid", "corrupt");
	}
}

export class DurableCloudTraceMirror {
	private readonly statePath: string;
	private readonly sink: CloudTraceSink;
	private readonly maxRecentEventIds: number;
	private state: MirrorState;

	constructor(options: CloudTraceMirrorOptions) {
		if (!options.directory) throw new Error("directory must not be empty");
		if (!options.sessionId) throw new Error("sessionId must not be empty");
		this.maxRecentEventIds = options.maxRecentEventIds ?? DEFAULT_MAX_RECENT_IDS;
		if (!Number.isInteger(this.maxRecentEventIds) || this.maxRecentEventIds < 1) {
			throw new Error("maxRecentEventIds must be a positive integer");
		}
		this.sink = options.sink;
		mkdirSync(options.directory, { recursive: true, mode: 0o700 });
		this.statePath = join(options.directory, STATE_FILE);
		this.state = this.load(options.sessionId);
	}

	get cursor(): CloudCursor | undefined {
		return this.state.generation === null
			? undefined
			: { generation: this.state.generation, sequence: this.state.lastSequence };
	}

	async import(events: readonly CloudOutboxEvent[]): Promise<CloudAck | undefined> {
		for (const item of events) await this.importOne(item);
		const cursor = this.cursor;
		return cursor === undefined ? undefined : { type: "ack", sessionId: this.state.sessionId, cursor };
	}

	private async importOne(item: CloudOutboxEvent): Promise<void> {
		validateEnvelope(item);
		const expectedId = `evt_${createHash("sha256")
			.update(canonicalJson({ sessionId: this.state.sessionId, generation: item.generation, event: item.event }))
			.digest("hex")}`;
		if (item.eventId !== expectedId) {
			throw new CloudTraceMirrorError("Cloud trace event id does not match its payload", "duplicate-mismatch");
		}
		const currentGeneration = this.state.generation;
		let baseState = this.state;
		if (currentGeneration === null) {
			if (item.event.sequence !== 1) {
				throw new CloudTraceMirrorError("Initial cloud trace event must start at sequence 1", "sequence-gap");
			}
			baseState = { ...this.state, generation: item.generation };
		} else if (item.generation !== currentGeneration) {
			if (item.generation < currentGeneration || item.event.sequence !== 1) {
				throw new CloudTraceMirrorError(
					`Cloud trace generation changed from ${currentGeneration} to ${item.generation} without a sequence-1 reset`,
					"generation-gap",
				);
			}
			baseState = { ...this.state, generation: item.generation, lastSequence: 0, recentEventIds: [] };
		}

		const sequence = item.event.sequence;
		if (sequence <= baseState.lastSequence) {
			if (baseState.recentEventIds.includes(item.eventId)) return;
			throw new CloudTraceMirrorError(
				`Cloud trace replay for sequence ${sequence} does not match a retained event id`,
				"duplicate-mismatch",
			);
		}
		if (sequence !== baseState.lastSequence + 1) {
			throw new CloudTraceMirrorError(
				`Cloud trace sequence gap: expected ${baseState.lastSequence + 1}, received ${sequence}`,
				"sequence-gap",
			);
		}

		await this.sink.persistCloudEvent(item);
		const ids = [...baseState.recentEventIds, item.eventId].slice(-this.maxRecentEventIds);
		const nextState = { ...baseState, lastSequence: sequence, recentEventIds: ids };
		atomicWrite(this.statePath, nextState);
		this.state = nextState;
	}

	private load(sessionId: CloudSessionId): MirrorState {
		if (!existsSync(this.statePath)) {
			const state: MirrorState = {
				version: 1,
				sessionId,
				generation: null,
				lastSequence: 0,
				recentEventIds: [],
			};
			atomicWrite(this.statePath, state);
			return state;
		}
		try {
			return parseState(JSON.parse(readFileSync(this.statePath, "utf8")), sessionId);
		} catch (error) {
			if (error instanceof CloudTraceMirrorError) throw error;
			throw new CloudTraceMirrorError("Cloud trace mirror state is corrupt", "corrupt");
		}
	}
}
