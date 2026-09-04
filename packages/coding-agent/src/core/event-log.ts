import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readSync,
	statSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * Append-only JSONL event log: the shared crash-safety substrate under the
 * RLM spawn ledger and the ACP semantic-edge ledger.
 *
 * Appends are single O_APPEND writes (PIPE_BUF-scale sizes, whose atomicity
 * multi-writer consumers rely on for interleaving), fsynced only when the
 * caller needs durability. An unterminated final line is a crashed writer's
 * uncommitted append: replay never surfaces it (even when it parses — data
 * the next append truncates must never be acted on) and fails closed on any
 * malformed interior line. Repair happens only on append, never on read — a
 * viewer may replay a live writer's log. EVERY unterminated tail is
 * truncated at its byte offset, even one that parses as JSON: completing it
 * with a newline would turn a line a strict consumer parser rejects into
 * permanent fail-closed interior poison. Unifying consumers keeps the union
 * of their safety behaviors.
 */

export interface EventLogOptions {
	/** Fail closed beyond these bounds on every full read, including the repair path. */
	maxBytes?: number;
	maxRecords?: number;
	log?: (message: string) => void;
}

/** Bounded read through the descriptor: the size check and the allocation see the same fd, so a concurrent grow cannot bypass the bound. */
function readAllSync(fd: number, maxBytes: number | undefined, path: string): Buffer {
	const size = fstatSync(fd).size;
	if (maxBytes !== undefined && size > maxBytes) {
		throw new Error(`event log ${path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
	}
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
		if (bytesRead === 0) break;
		offset += bytesRead;
	}
	return buffer.subarray(0, offset);
}

function serializeLine(event: unknown): string {
	const serialized = JSON.stringify(event);
	if (typeof serialized !== "string") {
		throw new TypeError("event is not JSON-serializable");
	}
	return `${serialized}\n`;
}

export class EventLog {
	constructor(
		readonly path: string,
		private readonly options: EventLogOptions = {},
	) {}

	/**
	 * Replay every terminated line through `parse`. `parse` throws for a line
	 * it rejects (fail-closed) and returns undefined for a line it deliberately
	 * skips; an unterminated final line never reaches it. A missing log is an
	 * empty history for owners and an error for explicit readers; the choice is
	 * made at the open so no check-then-read window exists.
	 */
	replaySync<T>(
		parse: (line: string, index: number) => T | undefined,
		options?: { missingFileThrows?: boolean },
	): T[] {
		const { maxBytes, maxRecords } = this.options;
		let fd: number;
		try {
			fd = openSync(this.path, "r");
		} catch (error) {
			if (!options?.missingFileThrows && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		let contents: string;
		try {
			contents = readAllSync(fd, maxBytes, this.path).toString("utf8");
		} finally {
			closeSync(fd);
		}
		const endsWithNewline = contents.endsWith("\n");
		const rawLines = contents.split("\n");
		const events: T[] = [];
		let recordCount = 0;
		for (let index = 0; index < rawLines.length; index++) {
			const line = rawLines[index].trim();
			if (!line) continue;
			if (index === rawLines.length - 1 && !endsWithNewline) {
				this.options.log?.("ignored torn final line");
				continue;
			}
			if (maxRecords !== undefined && ++recordCount > maxRecords) {
				throw new Error(`event log ${this.path} exceeds ${maxRecords} records; refusing to read`);
			}
			const event = parse(line, index);
			if (event !== undefined) events.push(event);
		}
		return events;
	}

	/**
	 * Append events as one write; `durable` fsyncs before returning. When the
	 * file is created by this append, `onCreate`'s records lead the payload.
	 * An unserializable event throws before any byte (including repair) is
	 * written.
	 */
	appendSync(events: unknown[], options?: { durable?: boolean; onCreate?: () => unknown[] }): void {
		const lines = events.map(serializeLine);
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		let leadLines: string[] = [];
		if (existsSync(this.path)) {
			this.repairTailSync();
		} else {
			leadLines = (options?.onCreate?.() ?? []).map(serializeLine);
		}
		const payload = [...leadLines, ...lines].join("");
		const handle = openSync(this.path, "a", 0o600);
		try {
			writeSync(handle, payload);
			if (options?.durable) fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
	}

	/**
	 * Truncate a torn final line from a crashed writer before appending:
	 * otherwise the append would turn a tolerable torn tail into a fail-closed
	 * interior line. The torn bytes were never readable data.
	 */
	private repairTailSync(): void {
		const { maxBytes } = this.options;
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			return;
		}
		if (size === 0) return;
		// Fail closed loudly at the read bound BEFORE the swallowing repair
		// try-block: an oversized log must never trigger a file-sized
		// allocation, and the error must not be silenced as a repair failure.
		if (maxBytes !== undefined && size > maxBytes) {
			throw new Error(`event log ${this.path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
		}
		// All offsets are BYTE offsets on raw buffers: string indices diverge
		// from byte offsets as soon as any record carries multi-byte UTF-8,
		// and ftruncate takes bytes.
		try {
			const fd = openSync(this.path, "r+");
			try {
				const lastByte = Buffer.alloc(1);
				if (readSync(fd, lastByte, 0, 1, size - 1) !== 1 || lastByte[0] === 0x0a) return;
				// Truncate guarded by a double-read stability check (cheap
				// cross-process hardening; a racing append between the check and
				// the ftruncate stays in the same trust bucket as the documented
				// O_APPEND small-write atomicity assumption).
				const first = readAllSync(fd, maxBytes, this.path);
				const second = readAllSync(fd, maxBytes, this.path);
				if (second.length !== first.length || !second.equals(first)) return;
				if (fstatSync(fd).size !== first.length) return;
				const keep = first.lastIndexOf(0x0a) + 1;
				ftruncateSync(fd, keep);
				this.options.log?.(`truncated torn final line (${first.length - keep} bytes)`);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Leave the tail for the reader's torn-line tolerance.
		}
	}
}
