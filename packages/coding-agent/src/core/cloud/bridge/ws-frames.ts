import { createHash, randomBytes } from "node:crypto";

/**
 * Minimal RFC 6455 WebSocket codec for the local tunnel attachment.
 *
 * The guest bridge ships its own copy of this logic inside the standalone
 * bridge script (see `guest-bridge-script.ts`); this module is the compiled
 * local-side counterpart. It supports exactly what the cloud session protocol
 * needs: text frames, ping/pong, and the close handshake, with strict
 * validation so a hostile or broken edge can never force unbounded buffering.
 *
 * Rules enforced here:
 * - Client-to-server frames MUST be masked; server-to-client frames MUST NOT
 *   be. The decoder is configured with the direction it serves and rejects the
 *   other, per RFC 6455.
 * - Frames are bounded (`maxPayloadBytes`); oversize frames are a protocol
 *   error, not a truncated success.
 * - Control frames (close/ping/pong) must be single frames of at most 125
 *   bytes and never fragmented.
 */

export const WS_OPCODE = {
	continuation: 0x0,
	text: 0x1,
	binary: 0x2,
	close: 0x8,
	ping: 0x9,
	pong: 0xa,
} as const;

export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_PROTOCOL_ERROR = 1002;
export const WS_CLOSE_POLICY_VIOLATION = 1008;
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class WsFrameError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WsFrameError";
	}
}

/** Value the server must echo in `Sec-WebSocket-Accept` for the given key. */
export function webSocketAccept(secWebSocketKey: string): string {
	return createHash("sha1").update(`${secWebSocketKey}${WS_GUID}`).digest("base64");
}

/** A fresh `Sec-WebSocket-Key` for a client handshake. */
export function newSecWebSocketKey(): string {
	return randomBytes(16).toString("base64");
}

export interface WsFrame {
	fin: boolean;
	opcode: number;
	payload: Buffer;
}

/**
 * Incremental frame decoder over one socket direction.
 *
 * `push` returns the frames completed by the chunk. `end()` reports whether a
 * message ended mid-frame (a truncated stream is a protocol error).
 */
export class WsFrameDecoder {
	private buffer: Buffer = Buffer.alloc(0);
	private fragments: Buffer[] | undefined;

	constructor(
		private readonly options: {
			/** True when the peer is a client (frames must be masked). */
			expectMasked: boolean;
			maxPayloadBytes: number;
		},
	) {}

	/** Bytes still buffered (for diagnostics; never contains a secret). */
	get bufferedBytes(): number {
		return this.buffer.byteLength;
	}

	push(chunk: Buffer): WsFrame[] {
		this.buffer = this.buffer.byteLength === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const frames: WsFrame[] = [];
		for (;;) {
			const frame = this.readFrame();
			if (frame === undefined) break;
			frames.push(frame);
		}
		return frames;
	}

	/** True when the stream ended in the middle of a frame or message. */
	endedIncomplete(): boolean {
		return this.buffer.byteLength > 0 || this.fragments !== undefined;
	}

	private readFrame(): WsFrame | undefined {
		const buffer = this.buffer;
		if (buffer.byteLength < 2) return undefined;
		const first = buffer[0];
		const second = buffer[1];
		const fin = (first & 0x80) !== 0;
		const opcode = first & 0x0f;
		const masked = (second & 0x80) !== 0;
		if (masked !== this.options.expectMasked) {
			throw new WsFrameError(`frame masking violation (masked=${String(masked)})`);
		}
		const isControl = (opcode & 0x8) !== 0;
		if (isControl && !fin) {
			throw new WsFrameError("control frames must not be fragmented");
		}
		const lengthKind = second & 0x7f;
		let offset = 2;
		let length: number;
		if (lengthKind === 126) {
			if (buffer.byteLength < offset + 2) return undefined;
			length = buffer.readUInt16BE(offset);
			offset += 2;
		} else if (lengthKind === 127) {
			if (buffer.byteLength < offset + 8) return undefined;
			const high = buffer.readUInt32BE(offset);
			const low = buffer.readUInt32BE(offset + 4);
			if (high !== 0) throw new WsFrameError("frame length exceeds 32 bits");
			length = low;
			offset += 8;
		} else {
			length = lengthKind;
		}
		if (isControl && length > 125) {
			throw new WsFrameError("control frame payload exceeds 125 bytes");
		}
		if (length > this.options.maxPayloadBytes) {
			throw new WsFrameError(`frame payload of ${String(length)} bytes exceeds the limit`);
		}
		const maskBytes = masked ? 4 : 0;
		if (buffer.byteLength < offset + maskBytes + length) return undefined;
		const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
		const payload = Buffer.from(buffer.subarray(offset + maskBytes, offset + maskBytes + length));
		if (mask !== undefined) {
			for (let index = 0; index < payload.byteLength; index++) payload[index] ^= mask[index & 3];
		}
		this.buffer = buffer.subarray(offset + maskBytes + length);
		return { fin, opcode, payload };
	}
}

/** Encode one frame; `mask` must be true only for client-to-server frames. */
export function encodeWsFrame(opcode: number, payload: Buffer, mask: boolean): Buffer {
	const length = payload.byteLength;
	let header: Buffer;
	if (length < 126) {
		header = Buffer.from([0x80 | opcode, mask ? 0x80 | length : length]);
	} else if (length <= 0xffff) {
		header = Buffer.alloc(4);
		header[0] = 0x80 | opcode;
		header[1] = mask ? 0x80 | 126 : 126;
		header.writeUInt16BE(length, 2);
	} else {
		header = Buffer.alloc(10);
		header[0] = 0x80 | opcode;
		header[1] = mask ? 0x80 | 127 : 127;
		header.writeUInt32BE(0, 2);
		header.writeUInt32BE(length, 6);
	}
	if (!mask) return Buffer.concat([header, payload]);
	const maskBytes = randomBytes(4);
	const masked = Buffer.from(payload);
	for (let index = 0; index < masked.byteLength; index++) masked[index] ^= maskBytes[index & 3];
	return Buffer.concat([header, maskBytes, masked]);
}

/** Encode a text frame; `mask` true only for client-to-server frames. */
export function encodeWsText(text: string, mask: boolean): Buffer {
	return encodeWsFrame(WS_OPCODE.text, Buffer.from(text, "utf8"), mask);
}

/** Encode a close frame with a status code and optional reason. */
export function encodeWsClose(code: number, reason = "", mask: boolean): Buffer {
	const reasonBytes = Buffer.from(reason, "utf8").subarray(0, 123);
	const payload = Buffer.alloc(2 + reasonBytes.byteLength);
	payload.writeUInt16BE(code, 0);
	reasonBytes.copy(payload, 2);
	return encodeWsFrame(WS_OPCODE.close, payload, mask);
}

/** Decode a close frame's status code; 1005/1006 have no payload semantics. */
export function decodeWsCloseCode(frame: WsFrame): { code: number; reason: string } {
	if (frame.payload.byteLength === 0) return { code: 1005, reason: "" };
	if (frame.payload.byteLength === 1) throw new WsFrameError("close frame payload of 1 byte is invalid");
	const code = frame.payload.readUInt16BE(0);
	return { code, reason: frame.payload.subarray(2).toString("utf8") };
}
