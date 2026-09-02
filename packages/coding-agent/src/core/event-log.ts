import {
	closeSync,
	existsSync,
	fstatSync,
	fsyncSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	readFileSync,
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
 * caller needs durability. Replay tolerates exactly one torn FINAL line
 * (unparseable AND unterminated: a crashed writer's in-progress append) and
 * fails closed on any malformed interior line. Repair happens only on
 * append, never on read — a viewer may replay a live writer's log: an
 * unparseable torn tail is truncated at its byte offset, and a parseable
 * unterminated tail is completed by prefixing the next append's payload with
 * its missing newline.
 */

export interface EventLogOptions {
	/** Fail closed beyond these bounds on every full read, including the repair path. */
	maxBytes?: number;
	maxRecords?: number;
	log?: (message: string) => void;
}

function readAllSync(fd: number, maxBytes: number | undefined): Buffer {
	const size = fstatSync(fd).size;
	if (maxBytes !== undefined && size > maxBytes) {
		throw new Error(`event log exceeds ${maxBytes} bytes (${size}); refusing to read`);
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

export class EventLog {
	constructor(
		readonly path: string,
		private readonly options: EventLogOptions = {},
	) {}

	/**
	 * Replay every line through `parse`. `parse` throws for a line it rejects
	 * (fail-closed for interior lines, tolerated for a torn final line) and
	 * returns undefined for a line it deliberately skips.
	 */
	replaySync<T>(parse: (line: string, index: number) => T | undefined): T[] {
		if (!existsSync(this.path)) return [];
		const { maxBytes, maxRecords } = this.options;
		const size = statSync(this.path).size;
		if (maxBytes !== undefined && size > maxBytes) {
			throw new Error(`event log ${this.path} exceeds ${maxBytes} bytes (${size}); refusing to read`);
		}
		const contents = readFileSync(this.path, "utf8");
		const endsWithNewline = contents.endsWith("\n");
		const rawLines = contents.split("\n");
		const events: T[] = [];
		let recordCount = 0;
		for (let index = 0; index < rawLines.length; index++) {
			const line = rawLines[index].trim();
			if (!line) continue;
			if (maxRecords !== undefined && ++recordCount > maxRecords) {
				throw new Error(`event log ${this.path} exceeds ${maxRecords} records; refusing to read`);
			}
			let event: T | undefined;
			try {
				event = parse(line, index);
			} catch (error) {
				if (index === rawLines.length - 1 && !endsWithNewline) {
					this.options.log?.(`ignored torn final line: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				throw error;
			}
			if (event !== undefined) events.push(event);
		}
		return events;
	}

	/**
	 * Append events as one write; `durable` fsyncs before returning. When the
	 * file is created by this append, `onCreate`'s records lead the payload.
	 */
	appendSync(events: unknown[], options?: { durable?: boolean; onCreate?: () => unknown[] }): void {
		mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
		let lead: unknown[] = [];
		let prefix = "";
		if (existsSync(this.path)) {
			prefix = this.repairTailSync();
		} else {
			lead = options?.onCreate?.() ?? [];
		}
		const payload = prefix + [...lead, ...events].map((event) => `${JSON.stringify(event)}\n`).join("");
		const handle = openSync(this.path, "a", 0o600);
		try {
			writeSync(handle, payload);
			if (options?.durable) fsyncSync(handle);
		} finally {
			closeSync(handle);
		}
	}

	/**
	 * Repair a torn final line from a crashed writer before appending:
	 * otherwise the append would turn a tolerable torn tail into a fail-closed
	 * interior line. Returns the newline that completes a parseable
	 * unterminated tail (its bytes are committed data), after truncating an
	 * unparseable one (its bytes never were).
	 */
	private repairTailSync(): "" | "\n" {
		const { maxBytes } = this.options;
		let size: number;
		try {
			size = statSync(this.path).size;
		} catch {
			return "";
		}
		if (size === 0) return "";
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
				if (readSync(fd, lastByte, 0, 1, size - 1) !== 1 || lastByte[0] === 0x0a) return "";
				const first = readAllSync(fd, maxBytes);
				const tail = first.subarray(first.lastIndexOf(0x0a) + 1).toString("utf8");
				try {
					JSON.parse(tail);
					return "\n";
				} catch {
					// Unparseable tail: truncate, guarded by a double-read stability
					// check (cheap cross-process hardening; a racing append between
					// the check and the ftruncate stays in the same trust bucket as
					// the documented O_APPEND small-write atomicity assumption).
					const second = readAllSync(fd, maxBytes);
					if (second.length !== first.length || !second.equals(first)) return "";
					if (fstatSync(fd).size !== first.length) return "";
					const keep = first.lastIndexOf(0x0a) + 1;
					ftruncateSync(fd, keep);
					this.options.log?.(`truncated torn final line (${first.length - keep} bytes)`);
				}
			} finally {
				closeSync(fd);
			}
		} catch {
			// Leave the tail for the reader's torn-line tolerance.
		}
		return "";
	}
}
