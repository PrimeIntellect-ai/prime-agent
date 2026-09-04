import { randomBytes } from "node:crypto";
import { createWriteStream, rmSync, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.js";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

/**
 * One spill lifecycle with exactly two terminal states: a COMPLETE file whose
 * path finalize() resolves, or a DEGRADED spill (failure at open, write, or
 * final flush) whose path is never advertised. finalize() never rejects; the
 * caller keeps its bounded in-memory tail either way.
 */
export class OutputSpill {
	private path?: string;
	private stream?: WriteStream;
	private failed = false;

	constructor(private readonly prefix: string) {}

	get isOpen(): boolean {
		return this.stream !== undefined;
	}

	/** Advertisable path; undefined once the spill degraded. */
	get currentPath(): string | undefined {
		return this.path;
	}

	/** Open once, writing `replay` first; a degraded spill never reopens. */
	open(replay: Iterable<Buffer | string>): void {
		if (this.stream || this.failed) {
			return;
		}
		this.path = defaultTempFilePath(this.prefix);
		const stream = createWriteStream(this.path);
		// An unlistened 'error' (ENOSPC, unwritable tmpdir) would crash the process.
		stream.on("error", () => {
			this.failed = true;
			const partial = this.path;
			this.path = undefined;
			if (this.stream === stream) {
				this.stream = undefined;
			}
			// The partial file would squat on the disk pressure that degraded the spill.
			stream.once("close", () => {
				try {
					if (partial) rmSync(partial, { force: true });
				} catch {
					// Best-effort cleanup: an EACCES/EBUSY here must not kill the process.
				}
			});
		});
		this.stream = stream;
		for (const chunk of replay) {
			stream.write(chunk);
		}
	}

	write(chunk: Buffer | string): void {
		this.stream?.write(chunk);
	}

	/** Flush and settle: the complete file's path, or undefined when degraded. */
	async finalize(): Promise<string | undefined> {
		const stream = this.stream;
		this.stream = undefined;
		if (stream && !stream.closed) {
			await new Promise<void>((resolve) => {
				// 'close' fires after finish AND after error, so this never rejects.
				stream.once("close", resolve);
				stream.end();
			});
		}
		return this.failed ? undefined : this.path;
	}
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private totalLines = 1;
	private currentLineBytes = 0;
	private finished = false;

	private readonly spill: OutputSpill;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
		this.spill = new OutputSpill(this.tempFilePrefix);
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.spill.isOpen || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.spill.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.spill.currentPath,
		};
	}

	/**
	 * Settle the spill; never rejects. Afterwards snapshot().fullOutputPath is
	 * terminal: a complete file, or undefined when the spill degraded.
	 */
	async closeTempFile(): Promise<void> {
		await this.spill.finalize();
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
		} else {
			this.totalLines += newlines;
			this.currentLineBytes = byteLength(text.slice(lastNewline + 1));
		}
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		this.spill.open(this.rawChunks);
		this.rawChunks = [];
	}
}
