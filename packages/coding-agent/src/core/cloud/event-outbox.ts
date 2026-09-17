import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type CloudCursor, type CloudEvent, type CloudSessionId, canonicalJson } from "./protocol.js";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type CloudEventInput = DistributiveOmit<CloudEvent, "sequence">;

export interface CloudOutboxEvent {
	readonly eventId: string;
	readonly generation: number;
	readonly event: CloudEvent;
}

interface OutboxMeta {
	version: 1;
	sessionId: CloudSessionId;
	generation: number;
	ackedSequence: number;
	eventsFile: string;
}

export interface CloudEventOutboxOptions {
	readonly directory: string;
	readonly sessionId: CloudSessionId;
	readonly maxRecords?: number;
	readonly maxEventBytes?: number;
}

export type CloudEventOutboxErrorCode =
	| "corrupt"
	| "cursor-expired"
	| "generation-mismatch"
	| "invalid-cursor"
	| "invalid-event"
	| "limit-exceeded";

export class CloudEventOutboxError extends Error {
	constructor(
		message: string,
		readonly code: CloudEventOutboxErrorCode,
	) {
		super(message);
		this.name = "CloudEventOutboxError";
	}
}

const DEFAULT_MAX_RECORDS = 50_000;
const DEFAULT_MAX_EVENT_BYTES = 1_048_576;
const META_FILE = "outbox-meta.json";
const EVENTS_FILE = "outbox-events.ndjson";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveInteger(value: number, label: string): void {
	if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
}

function fsyncDirectory(path: string): void {
	const fd = openSync(path, "r");
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function atomicWrite(path: string, bytes: string): void {
	const directory = dirname(path);
	const temp = join(directory, `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	const fd = openSync(temp, "wx", 0o600);
	try {
		writeSync(fd, bytes);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	fsyncDirectory(directory);
}

function eventId(sessionId: string, generation: number, event: CloudEvent): string {
	return `evt_${createHash("sha256").update(canonicalJson({ sessionId, generation, event })).digest("hex")}`;
}

function parseMeta(value: unknown, expectedSessionId: string): OutboxMeta {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		value.sessionId !== expectedSessionId ||
		!Number.isInteger(value.generation) ||
		(value.generation as number) < 1 ||
		!Number.isInteger(value.ackedSequence) ||
		(value.ackedSequence as number) < 0 ||
		(value.eventsFile !== undefined &&
			(typeof value.eventsFile !== "string" || !/^outbox-events(?:\.g[1-9][0-9]*)?\.ndjson$/.test(value.eventsFile)))
	) {
		throw new CloudEventOutboxError("Cloud event outbox metadata is corrupt", "corrupt");
	}
	return {
		...(value as unknown as Omit<OutboxMeta, "eventsFile">),
		eventsFile: (value.eventsFile as string | undefined) ?? EVENTS_FILE,
	};
}

function parseEnvelope(value: unknown, sessionId: string, generation: number): CloudOutboxEvent {
	if (
		!isRecord(value) ||
		typeof value.eventId !== "string" ||
		value.generation !== generation ||
		!isRecord(value.event)
	) {
		throw new CloudEventOutboxError("Cloud event outbox record is corrupt", "corrupt");
	}
	const event = value.event as unknown as CloudEvent;
	if (!Number.isInteger(event.sequence) || event.sequence < 1 || typeof event.kind !== "string") {
		throw new CloudEventOutboxError("Cloud event outbox record has an invalid event", "corrupt");
	}
	const expected = eventId(sessionId, generation, event);
	if (value.eventId !== expected) {
		throw new CloudEventOutboxError("Cloud event outbox record digest is corrupt", "corrupt");
	}
	return { eventId: expected, generation, event };
}

export class DurableCloudEventOutbox {
	readonly directory: string;
	readonly sessionId: CloudSessionId;
	private readonly metaPath: string;
	private readonly maxRecords: number;
	private readonly maxEventBytes: number;
	private meta: OutboxMeta;
	private events: CloudOutboxEvent[];

	constructor(options: CloudEventOutboxOptions) {
		if (!options.directory) throw new Error("directory must not be empty");
		if (!options.sessionId) throw new Error("sessionId must not be empty");
		this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
		this.maxEventBytes = options.maxEventBytes ?? DEFAULT_MAX_EVENT_BYTES;
		assertPositiveInteger(this.maxRecords, "maxRecords");
		assertPositiveInteger(this.maxEventBytes, "maxEventBytes");
		this.directory = options.directory;
		this.sessionId = options.sessionId;
		this.metaPath = join(this.directory, META_FILE);
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		this.meta = this.loadMeta();
		this.events = this.loadEvents();
		this.validateSequence();
	}

	private get eventsPath(): string {
		return join(this.directory, this.meta.eventsFile);
	}

	get generation(): number {
		return this.meta.generation;
	}

	get tailCursor(): CloudCursor {
		return { generation: this.meta.generation, sequence: this.events.at(-1)?.event.sequence ?? 0 };
	}

	get acknowledgedCursor(): CloudCursor {
		return { generation: this.meta.generation, sequence: this.meta.ackedSequence };
	}

	append(input: CloudEventInput): CloudOutboxEvent {
		if (this.events.length >= this.maxRecords) {
			throw new CloudEventOutboxError(`Cloud event outbox reached ${this.maxRecords} records`, "limit-exceeded");
		}
		const sequence = (this.events.at(-1)?.event.sequence ?? 0) + 1;
		const event = { ...input, sequence } as CloudEvent;
		let canonical: string;
		try {
			canonical = canonicalJson(event);
		} catch (error) {
			throw new CloudEventOutboxError(
				`Cloud event is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
				"invalid-event",
			);
		}
		if (Buffer.byteLength(canonical) > this.maxEventBytes) {
			throw new CloudEventOutboxError(`Cloud event exceeds ${this.maxEventBytes} bytes`, "limit-exceeded");
		}
		const envelope: CloudOutboxEvent = {
			eventId: eventId(this.sessionId, this.meta.generation, event),
			generation: this.meta.generation,
			event,
		};
		const fd = openSync(this.eventsPath, "a", 0o600);
		try {
			writeSync(fd, `${canonicalJson(envelope)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		this.events.push(envelope);
		return envelope;
	}

	eventsAfter(cursor: CloudCursor, limit = this.maxRecords): readonly CloudOutboxEvent[] {
		this.assertCursorGeneration(cursor);
		assertPositiveInteger(limit, "limit");
		const first = this.events[0]?.event.sequence;
		const tail = this.tailCursor.sequence;
		if (cursor.sequence > tail) {
			throw new CloudEventOutboxError("Cloud cursor is beyond the event tail", "invalid-cursor");
		}
		if (first !== undefined && cursor.sequence < first - 1) {
			throw new CloudEventOutboxError("Cloud cursor has expired after event trimming", "cursor-expired");
		}
		return this.events.filter((item) => item.event.sequence > cursor.sequence).slice(0, limit);
	}

	ack(cursor: CloudCursor): void {
		this.assertCursorGeneration(cursor);
		if (cursor.sequence < this.meta.ackedSequence) {
			throw new CloudEventOutboxError("Cloud acknowledgement cannot move backwards", "invalid-cursor");
		}
		if (cursor.sequence > this.tailCursor.sequence) {
			throw new CloudEventOutboxError("Cloud acknowledgement is beyond the event tail", "invalid-cursor");
		}
		if (cursor.sequence === this.meta.ackedSequence) return;
		this.meta = { ...this.meta, ackedSequence: cursor.sequence };
		this.persistMeta();
	}

	trimAcknowledged(): CloudCursor {
		if (this.meta.ackedSequence === 0) return this.tailCursor;
		const retained = this.events.filter((item) => item.event.sequence > this.meta.ackedSequence);
		const generation = this.meta.generation + 1;
		const rewritten = retained.map((item, index): CloudOutboxEvent => {
			const event = { ...item.event, sequence: index + 1 } as CloudEvent;
			return { eventId: eventId(this.sessionId, generation, event), generation, event };
		});
		const bytes = rewritten.map((item) => canonicalJson(item)).join("\n");
		const eventsFile = `outbox-events.g${generation}.ndjson`;
		atomicWrite(join(this.directory, eventsFile), bytes === "" ? "" : `${bytes}\n`);
		this.meta = { version: 1, sessionId: this.sessionId, generation, ackedSequence: 0, eventsFile };
		this.persistMeta();
		this.events = rewritten;
		return this.tailCursor;
	}

	private assertCursorGeneration(cursor: CloudCursor): void {
		if (!Number.isInteger(cursor.sequence) || cursor.sequence < 0) {
			throw new CloudEventOutboxError("Cloud cursor sequence is invalid", "invalid-cursor");
		}
		if (cursor.generation !== this.meta.generation) {
			throw new CloudEventOutboxError(
				`Cloud cursor generation ${cursor.generation} does not match ${this.meta.generation}`,
				"generation-mismatch",
			);
		}
	}

	private loadMeta(): OutboxMeta {
		if (!existsSync(this.metaPath)) {
			const meta: OutboxMeta = {
				version: 1,
				sessionId: this.sessionId,
				generation: 1,
				ackedSequence: 0,
				eventsFile: EVENTS_FILE,
			};
			atomicWrite(this.metaPath, `${canonicalJson(meta)}\n`);
			return meta;
		}
		try {
			return parseMeta(JSON.parse(readFileSync(this.metaPath, "utf8")), this.sessionId);
		} catch (error) {
			if (error instanceof CloudEventOutboxError) throw error;
			throw new CloudEventOutboxError("Cloud event outbox metadata is corrupt", "corrupt");
		}
	}

	private loadEvents(): CloudOutboxEvent[] {
		if (!existsSync(this.eventsPath)) {
			writeFileSync(this.eventsPath, "", { mode: 0o600 });
			const fd = openSync(this.eventsPath, "r");
			try {
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return [];
		}
		const bytes = readFileSync(this.eventsPath, "utf8");
		const ended = bytes.endsWith("\n");
		const lines = bytes.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (!ended && lines.length > 0) {
			lines.pop();
			atomicWrite(this.eventsPath, lines.length === 0 ? "" : `${lines.join("\n")}\n`);
		}
		return lines.map((line) => {
			try {
				return parseEnvelope(JSON.parse(line), this.sessionId, this.meta.generation);
			} catch (error) {
				if (error instanceof CloudEventOutboxError) throw error;
				throw new CloudEventOutboxError("Cloud event outbox record is corrupt", "corrupt");
			}
		});
	}

	private validateSequence(): void {
		for (let index = 0; index < this.events.length; index++) {
			if (this.events[index]?.event.sequence !== index + 1) {
				throw new CloudEventOutboxError("Cloud event outbox has a sequence gap", "corrupt");
			}
		}
		if (this.meta.ackedSequence > this.tailCursor.sequence) {
			throw new CloudEventOutboxError("Cloud event outbox acknowledgement is beyond its tail", "corrupt");
		}
	}

	private persistMeta(): void {
		atomicWrite(this.metaPath, `${canonicalJson(this.meta)}\n`);
	}
}
