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
 * Appends are single O_APPEND writes (PIPE_BUF-scale atomicity), fsynced only
 * when the caller needs durability. Tail rule (union of every consumer's
 * safety): an unterminated final line is an uncommitted append — skipped on
 * read even when it parses, truncated at its byte offset on the next append,
 * never newline-completed (completion turns a line a strict parser rejects
 * into permanent fail-closed interior poison). Interior malformed lines fail
 * closed. Repair runs only on append, never on read: a viewer may replay a
 * live writer's log.
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
	 * Replay every terminated line through `parse`: throw to reject a line,
	 * return undefined to skip one. The missing-file decision is made at the
	 * open, so no check-then-read window exists.
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
			const buffer = Buffer.from(payload, "utf8");
			const written = writeSync(handle, buffer);
			if (written < buffer.length) {
				// A short O_APPEND write (ENOSPC-class) fails the append: reporting
				// success would break write-before-action callers, completing it with
				// a second write could weld into a rival process's append, and
				// reclaiming the prefix could destroy a rival's committed record that
				// merely ends in the same bytes. The torn tail is the one tolerated
				// shape: skipped on read, truncated by any writer's next repair.
				throw new Error(`event log ${this.path}: short write (${written} of ${buffer.length} bytes)`);
			}
			if (options?.durable) fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
	}

	/**
	 * Truncate an unterminated tail before appending (the module-doc tail
	 * rule). A repair failure propagates and gates the append: writing through
	 * an unrepaired tail would weld it to the new record as permanent
	 * fail-closed interior corruption.
	 */
	private repairTailSync(): void {
		const { maxBytes } = this.options;
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		if (size === 0) return;
		if (maxBytes !== undefined && size > maxBytes) {
			throw new Error(`event log ${this.path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
		}
		// All offsets are BYTE offsets on raw buffers: string indices diverge
		// from byte offsets as soon as any record carries multi-byte UTF-8,
		// and ftruncate takes bytes.
		const fd = openSync(this.path, "r+");
		try {
			const lastByte = Buffer.alloc(1);
			if (readSync(fd, lastByte, 0, 1, size - 1) !== 1 || lastByte[0] === 0x0a) return;
			// Truncate guarded by a double-read stability check: unstable bytes
			// mean a live concurrent writer whose own append terminates the tail
			// (the documented O_APPEND small-write atomicity trust bucket).
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
	}
}
