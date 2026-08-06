import type { Duplex } from "node:stream";

const FRAME_PREFIX_BYTES = 8;

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
	private chunks: Buffer<ArrayBufferLike>[] = [];
	private firstChunkIndex = 0;
	private firstChunkOffset = 0;
	private bufferedLength = 0;

	constructor(
		private readonly validateHeader: PrivateFrameHeaderValidator<THeader>,
		private readonly limits: PrivateFrameLimits = DEFAULT_PRIVATE_FRAME_LIMITS,
	) {}

	get bufferedBytes(): number {
		return this.bufferedLength;
	}

	push(chunk: Uint8Array): PrivateFrame<THeader>[] {
		if (chunk.length > 0) {
			this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			this.bufferedLength += chunk.length;
		}

		const frames: PrivateFrame<THeader>[] = [];
		while (this.bufferedLength >= FRAME_PREFIX_BYTES) {
			const prefix = this.peekBytes(FRAME_PREFIX_BYTES);
			const headerLength = prefix.readUInt32BE(0);
			const payloadLength = prefix.readUInt32BE(4);
			assertFrameLength("header length", headerLength, this.limits.maxHeaderBytes);
			assertFrameLength("payload length", payloadLength, this.limits.maxPayloadBytes);
			if (headerLength === 0) {
				throw new Error("Private frame header cannot be empty");
			}

			const frameLength = FRAME_PREFIX_BYTES + headerLength + payloadLength;
			if (this.bufferedLength < frameLength) {
				break;
			}

			const headerBuffer = this.peekBytes(FRAME_PREFIX_BYTES + headerLength).subarray(FRAME_PREFIX_BYTES);
			let decoded: unknown;
			try {
				decoded = JSON.parse(headerBuffer.toString("utf8"));
			} catch (error) {
				throw new Error(
					`Invalid private frame header JSON: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			if (!isObjectHeader(decoded) || !this.validateHeader(decoded)) {
				throw new Error("Invalid private frame routing header");
			}

			this.consumeBytes(FRAME_PREFIX_BYTES + headerLength);
			frames.push({ header: decoded, payload: this.readBytes(payloadLength) });
		}
		return frames;
	}

	finish(): void {
		if (this.bufferedLength !== 0) {
			throw new Error(`Private frame channel ended with ${this.bufferedLength} incomplete bytes`);
		}
	}

	private peekBytes(length: number): Buffer<ArrayBufferLike> {
		const first = this.chunks[this.firstChunkIndex];
		if (first && first.length - this.firstChunkOffset >= length) {
			return first.subarray(this.firstChunkOffset, this.firstChunkOffset + length);
		}

		const result = Buffer.allocUnsafe(length);
		this.copyBytes(result, length);
		return result;
	}

	private readBytes(length: number): Buffer<ArrayBufferLike> {
		const result = Buffer.allocUnsafe(length);
		this.copyBytes(result, length);
		this.consumeBytes(length);
		return result;
	}

	private copyBytes(target: Buffer<ArrayBufferLike>, length: number): void {
		let chunkIndex = this.firstChunkIndex;
		let chunkOffset = this.firstChunkOffset;
		let targetOffset = 0;
		while (targetOffset < length) {
			const chunk = this.chunks[chunkIndex];
			if (!chunk) {
				throw new Error("Private frame decoder buffer underflow");
			}
			const copyLength = Math.min(length - targetOffset, chunk.length - chunkOffset);
			chunk.copy(target, targetOffset, chunkOffset, chunkOffset + copyLength);
			targetOffset += copyLength;
			chunkOffset += copyLength;
			if (chunkOffset === chunk.length) {
				chunkIndex++;
				chunkOffset = 0;
			}
		}
	}

	private consumeBytes(length: number): void {
		let remaining = length;
		while (remaining > 0) {
			const chunk = this.chunks[this.firstChunkIndex];
			if (!chunk) {
				throw new Error("Private frame decoder buffer underflow");
			}
			const consumed = Math.min(remaining, chunk.length - this.firstChunkOffset);
			remaining -= consumed;
			this.firstChunkOffset += consumed;
			if (this.firstChunkOffset === chunk.length) {
				this.firstChunkIndex++;
				this.firstChunkOffset = 0;
			}
		}

		this.bufferedLength -= length;
		if (this.bufferedLength === 0) {
			this.chunks = [];
			this.firstChunkIndex = 0;
			this.firstChunkOffset = 0;
		} else if (this.firstChunkIndex >= 1024) {
			this.chunks = this.chunks.slice(this.firstChunkIndex);
			this.firstChunkIndex = 0;
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
