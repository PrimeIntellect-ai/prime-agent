import type { Duplex } from "node:stream";

const FRAME_PREFIX_BYTES = 8;

/** Minimum spent entries before compaction splices the consumed prefix away. */
const PENDING_COMPACTION_MIN_HEAD = 32;

export interface PrivateFrameLimits {
	maxHeaderBytes: number;
	maxPayloadBytes: number;
}

export const DEFAULT_PRIVATE_FRAME_LIMITS: PrivateFrameLimits = {
	maxHeaderBytes: 1024 * 1024,
	maxPayloadBytes: 1024 * 1024 * 1024,
};

export interface PrivateFrame<THeader extends object> {
	header: THeader;
	payload: Buffer;
}

export type PrivateFrameHeaderValidator<THeader extends object> = (value: unknown) => value is THeader;

function assertFrameLength(name: string, value: number, maximum: number): void {
	if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
		throw new Error(`Invalid private frame ${name}: ${value}`);
	}
}

function isObjectHeader(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodePrivateFrame<THeader extends object>(
	header: THeader,
	payload: Uint8Array = Buffer.alloc(0),
	limits: PrivateFrameLimits = DEFAULT_PRIVATE_FRAME_LIMITS,
): Buffer {
	const headerBuffer = Buffer.from(JSON.stringify(header), "utf8");
	const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	assertFrameLength("header length", headerBuffer.length, limits.maxHeaderBytes);
	assertFrameLength("payload length", payloadBuffer.length, limits.maxPayloadBytes);
	if (headerBuffer.length === 0) {
		throw new Error("Private frame header cannot be empty");
	}

	const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + headerBuffer.length + payloadBuffer.length);
	frame.writeUInt32BE(headerBuffer.length, 0);
	frame.writeUInt32BE(payloadBuffer.length, 4);
	headerBuffer.copy(frame, FRAME_PREFIX_BYTES);
	payloadBuffer.copy(frame, FRAME_PREFIX_BYTES + headerBuffer.length);
	return frame;
}

export class PrivateFrameDecoder<THeader extends object> {
	/**
	 * Received-but-unparsed bytes, kept as the chunks the socket delivered.
	 *
	 * We never concatenate into a single growing buffer: appending to one
	 * accumulator on every socket read is O(n^2) when a single frame is split
	 * across many reads (e.g. a multi-MB snapshot response arriving in 8KB
	 * chunks). Instead, each chunk is stored as-is and a frame's bytes are
	 * joined exactly once, when the frame completes. Spent chunks are skipped
	 * via a head cursor rather than shifted off one per chunk — shifting every
	 * fully consumed chunk is itself quadratic in the chunk count — and the
	 * spent prefix is compacted in amortized O(1) per chunk. Mirrors the JSONL
	 * line reader's rationale in ../rpc/jsonl.ts.
	 */
	private pending: Buffer[] = [];
	private unreadBytes = 0;
	/** Index of the first chunk still holding unread bytes; entries before it are spent. */
	private head = 0;
	/** Bytes already consumed within pending[head]. */
	private offset = 0;

	constructor(
		private readonly validateHeader: PrivateFrameHeaderValidator<THeader>,
		private readonly limits: PrivateFrameLimits = DEFAULT_PRIVATE_FRAME_LIMITS,
	) {}

	get bufferedBytes(): number {
		return this.unreadBytes;
	}

	push(chunk: Uint8Array): PrivateFrame<THeader>[] {
		if (chunk.length > 0) {
			this.pending.push(Buffer.isBuffer(chunk) ? (chunk as Buffer) : Buffer.from(chunk));
			this.unreadBytes += chunk.length;
		}

		const frames: PrivateFrame<THeader>[] = [];
		while (this.unreadBytes >= FRAME_PREFIX_BYTES) {
			const prefix = this.slice(0, FRAME_PREFIX_BYTES);
			const headerLength = prefix.readUInt32BE(0);
			const payloadLength = prefix.readUInt32BE(4);
			assertFrameLength("header length", headerLength, this.limits.maxHeaderBytes);
			assertFrameLength("payload length", payloadLength, this.limits.maxPayloadBytes);
			if (headerLength === 0) {
				throw new Error("Private frame header cannot be empty");
			}

			const frameLength = FRAME_PREFIX_BYTES + headerLength + payloadLength;
			if (this.unreadBytes < frameLength) {
				break;
			}

			const headerStart = FRAME_PREFIX_BYTES;
			const payloadStart = headerStart + headerLength;
			let decoded: unknown;
			try {
				decoded = JSON.parse(this.slice(headerStart, payloadStart).toString("utf8"));
			} catch (error) {
				throw new Error(
					`Invalid private frame header JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!isObjectHeader(decoded) || !this.validateHeader(decoded)) {
				throw new Error("Invalid private frame routing header");
			}

			frames.push({
				header: decoded,
				payload: this.slice(payloadStart, frameLength),
			});
			this.consume(frameLength);
		}

		return frames;
	}

	finish(): void {
		if (this.unreadBytes !== 0) {
			throw new Error(`Private frame channel ended with ${this.unreadBytes} incomplete bytes`);
		}
	}

	/** Copy [start, endExclusive) of the unread bytes across pending chunks. */
	private slice(start: number, endExclusive: number): Buffer {
		const parts: Buffer[] = [];
		let position = 0;
		for (let index = this.head; index < this.pending.length && position < endExclusive; index++) {
			const chunk = this.pending[index];
			const usable = index === this.head ? chunk.subarray(this.offset) : chunk;
			const chunkEnd = position + usable.length;
			if (chunkEnd > start) {
				parts.push(
					usable.subarray(Math.max(start, position) - position, Math.min(endExclusive, chunkEnd) - position),
				);
			}
			position = chunkEnd;
		}
		if (parts.length === 1) {
			return Buffer.from(parts[0]);
		}
		return Buffer.concat(parts, endExclusive - start);
	}

	private consume(count: number): void {
		this.unreadBytes -= count;
		this.offset += count;
		while (this.head < this.pending.length && this.offset >= this.pending[this.head].length) {
			this.offset -= this.pending[this.head].length;
			this.head++;
		}

		// Fully drained: clear in one shot instead of one shift per chunk.
		if (this.head === this.pending.length) {
			this.pending.length = 0;
			this.head = 0;
			this.offset = 0;
			return;
		}

		// Splicing moves pending.length - head entries. At this threshold that is
		// at most head, and head only advances by one per consumed chunk, so
		// compaction stays amortized O(1) per chunk.
		if (this.head >= PENDING_COMPACTION_MIN_HEAD && this.head * 2 >= this.pending.length) {
			this.pending.splice(0, this.head);
			this.head = 0;
		}
	}
}

export type PrivateFrameListener<THeader extends object> = (frame: PrivateFrame<THeader>) => void;

export class PrivateFramedChannel<THeader extends object> {
	private readonly decoder: PrivateFrameDecoder<THeader>;
	private readonly listeners = new Set<PrivateFrameListener<THeader>>();
	private closed = false;

	constructor(
		private readonly stream: Duplex,
		validateHeader: PrivateFrameHeaderValidator<THeader>,
		private readonly limits: PrivateFrameLimits = DEFAULT_PRIVATE_FRAME_LIMITS,
	) {
		this.decoder = new PrivateFrameDecoder(validateHeader, limits);
		stream.on("data", this.handleData);
		stream.on("end", this.handleEnd);
		stream.on("close", this.handleClose);
	}

	onFrame(listener: PrivateFrameListener<THeader>): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async send(header: THeader, payload?: Uint8Array): Promise<void> {
		if (this.closed || this.stream.destroyed) {
			throw new Error("Private frame channel is closed");
		}
		const frame = encodePrivateFrame(header, payload, this.limits);
		await new Promise<void>((resolve, reject) => {
			this.stream.write(frame, (error?: Error | null) => {
				if (error) {
					reject(error);
				} else {
					resolve();
				}
			});
		});
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.detach();
		this.stream.end();
	}

	private readonly handleData = (chunk: Buffer): void => {
		try {
			for (const frame of this.decoder.push(chunk)) {
				for (const listener of this.listeners) {
					listener(frame);
				}
			}
		} catch (error) {
			this.stream.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	};

	private readonly handleEnd = (): void => {
		try {
			this.decoder.finish();
		} catch (error) {
			this.stream.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	};

	private readonly handleClose = (): void => {
		this.closed = true;
		this.detach();
	};

	private detach(): void {
		this.stream.off("data", this.handleData);
		this.stream.off("end", this.handleEnd);
		this.stream.off("close", this.handleClose);
		this.listeners.clear();
	}
}
