// V15 Application Frame Codec — pure codec module
// 16-byte app header inside decrypted plaintext.
// No casts, asserts, throws, spreads, any, non-null assertions,
// instanceof at hostile boundary, suppression directives,
// Object.setPrototypeOf, broad errors, structural brands, or
// swallowed catches. Same applies to tests and mutation test.
//
// Imports copySandboxStrictBytes for ALL hostile byte input
// (both encode payloads and decode inputs). Does not duplicate
// strict-byte logic. Encoder calls copySandboxStrictBytes
// exactly once for data-kind payloads (even for zero-length);
// decoder calls it exactly once for the whole frame input.
//
// Every result is a deep-frozen discriminated union.
// Public encode function accepts unknown for kind/stream/requestId
// and narrows internally — never throws on wrong runtime types.
//
// Decoder zeros the copied strict-bytes buffer on every exit after
// acquisition. Encoder zeros the copied payload bytes after every
// frame construction exit.

import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

// ---- V15 wire constants ----

export const KIND_REQUEST: 1 = 1;
export const KIND_DELIVERY_ACK: 2 = 2;
export const KIND_REPLY: 3 = 3;
export const KIND_CANCEL: 4 = 4;
export const KIND_CANCEL_ACK: 5 = 5;

const HEADER_SIZE: 16 = 16;
const MIN_UNPADDED: 16 = 16;
const MAX_UNPADDED: 262144 = 262144;
const MAX_PAYLOAD: 262128 = 262128;
const MAX_STREAM: 4 = 4;
const MAX_REQUEST_ID: bigint = 0xffff_ffff_ffff_ffffn;

function isDataKind(kind: number): boolean {
	return kind === KIND_REQUEST || kind === KIND_REPLY;
}

function isControlKind(kind: number): boolean {
	return kind === KIND_DELIVERY_ACK || kind === KIND_CANCEL || kind === KIND_CANCEL_ACK;
}

// ---- Encode result types ----

export interface EncodeOk {
	readonly ok: true;
	readonly frame: Uint8Array;
}

export interface EncodeBadKindType {
	readonly ok: false;
	readonly code: "BAD_KIND_TYPE";
}

export interface EncodeInvalidKind {
	readonly ok: false;
	readonly code: "INVALID_KIND";
}

export interface EncodeBadStreamType {
	readonly ok: false;
	readonly code: "BAD_STREAM_TYPE";
}

export interface EncodeInvalidStream {
	readonly ok: false;
	readonly code: "INVALID_STREAM";
}

export interface EncodeBadRequestIdType {
	readonly ok: false;
	readonly code: "BAD_REQUEST_ID_TYPE";
}

export interface EncodeInvalidRequestId {
	readonly ok: false;
	readonly code: "INVALID_REQUEST_ID";
}

export interface EncodeControlPayloadProvided {
	readonly ok: false;
	readonly code: "CONTROL_PAYLOAD_PROVIDED";
}

export interface EncodePayloadInvalid {
	readonly ok: false;
	readonly code: "PAYLOAD_INVALID";
}

export interface EncodePayloadTooLarge {
	readonly ok: false;
	readonly code: "PAYLOAD_TOO_LARGE";
}

export interface EncodePayloadExceedsMax {
	readonly ok: false;
	readonly code: "PAYLOAD_EXCEEDS_MAX";
}

export interface EncodeDataPayloadRequired {
	readonly ok: false;
	readonly code: "DATA_PAYLOAD_REQUIRED";
}

export type EncodeFailFrame =
	| EncodeBadKindType
	| EncodeInvalidKind
	| EncodeBadStreamType
	| EncodeInvalidStream
	| EncodeBadRequestIdType
	| EncodeInvalidRequestId
	| EncodeControlPayloadProvided
	| EncodeDataPayloadRequired
	| EncodePayloadInvalid
	| EncodePayloadTooLarge
	| EncodePayloadExceedsMax;

export type EncodeResult = EncodeOk | EncodeFailFrame;

// ---- Decode result types (discriminated by exact kind/stream literals) ----

export interface DecodeRequestFrame {
	readonly ok: true;
	readonly kind: 1;
	readonly stream: 0 | 1 | 2 | 3 | 4;
	readonly requestId: bigint;
	readonly payload: Uint8Array;
}

export interface DecodeDeliveryAckFrame {
	readonly ok: true;
	readonly kind: 2;
	readonly stream: 0 | 1 | 2 | 3 | 4;
	readonly requestId: bigint;
}

export interface DecodeReplyFrame {
	readonly ok: true;
	readonly kind: 3;
	readonly stream: 0 | 1 | 2 | 3 | 4;
	readonly requestId: bigint;
	readonly payload: Uint8Array;
}

export interface DecodeCancelFrame {
	readonly ok: true;
	readonly kind: 4;
	readonly stream: 0 | 1 | 2 | 3 | 4;
	readonly requestId: bigint;
}

export interface DecodeCancelAckFrame {
	readonly ok: true;
	readonly kind: 5;
	readonly stream: 0 | 1 | 2 | 3 | 4;
	readonly requestId: bigint;
}

export type DecodeOkFrame =
	| DecodeRequestFrame
	| DecodeDeliveryAckFrame
	| DecodeReplyFrame
	| DecodeCancelFrame
	| DecodeCancelAckFrame;

// ---- Fixed literal decode error types ----

export interface DecodeInputInvalid {
	readonly ok: false;
	readonly code: "INPUT_INVALID";
}

export interface DecodeTooLarge {
	readonly ok: false;
	readonly code: "INPUT_TOO_LARGE";
}

export interface DecodeTooShort {
	readonly ok: false;
	readonly code: "TOO_SHORT";
}

export interface DecodeReservedNonZero {
	readonly ok: false;
	readonly code: "RESERVED_NONZERO";
}

export interface DecodeInvalidKind {
	readonly ok: false;
	readonly code: "INVALID_KIND";
}

export interface DecodeInvalidStream {
	readonly ok: false;
	readonly code: "INVALID_STREAM";
}

export interface DecodeInvalidRequestId {
	readonly ok: false;
	readonly code: "INVALID_REQUEST_ID";
}

export interface DecodeBadUnpaddedLength {
	readonly ok: false;
	readonly code: "BAD_UNPADDED_LENGTH";
}

export interface DecodeWrongPaddedLength {
	readonly ok: false;
	readonly code: "WRONG_PADDED_LENGTH";
}

export interface DecodePaddingNonZero {
	readonly ok: false;
	readonly code: "PADDING_NONZERO";
}

export interface DecodeControlWrongLength {
	readonly ok: false;
	readonly code: "CONTROL_WRONG_UNPADDED_LENGTH";
}

export type DecodeFailFrame =
	| DecodeInputInvalid
	| DecodeTooLarge
	| DecodeTooShort
	| DecodeReservedNonZero
	| DecodeInvalidKind
	| DecodeInvalidStream
	| DecodeInvalidRequestId
	| DecodeBadUnpaddedLength
	| DecodeWrongPaddedLength
	| DecodePaddingNonZero
	| DecodeControlWrongLength;

export type DecodeResult = DecodeOkFrame | DecodeFailFrame;

// ---- Internal helpers ----

function computePaddedLength(unpaddedLength: number): number {
	return ((unpaddedLength + 15) >>> 0) & ~15;
}

function writeHeader(buf: Uint8Array, kind: number, stream: number, requestId: bigint, unpaddedLength: number): void {
	buf[0] = kind;
	buf[1] = stream;
	buf[2] = 0;
	buf[3] = 0;
	buf[4] = Number((requestId >> 56n) & 0xffn);
	buf[5] = Number((requestId >> 48n) & 0xffn);
	buf[6] = Number((requestId >> 40n) & 0xffn);
	buf[7] = Number((requestId >> 32n) & 0xffn);
	buf[8] = Number((requestId >> 24n) & 0xffn);
	buf[9] = Number((requestId >> 16n) & 0xffn);
	buf[10] = Number((requestId >> 8n) & 0xffn);
	buf[11] = Number(requestId & 0xffn);
	buf[12] = (unpaddedLength >>> 24) & 0xff;
	buf[13] = (unpaddedLength >>> 16) & 0xff;
	buf[14] = (unpaddedLength >>> 8) & 0xff;
	buf[15] = unpaddedLength & 0xff;
}

/** Narrow a runtime-unknown value to a valid V15 kind (1..5). */
function narrowKind(raw: unknown): number | undefined {
	if (typeof raw !== "number") return undefined;
	if (!Number.isInteger(raw)) return undefined;
	if (raw < 1 || raw > 5) return undefined;
	if (!Number.isFinite(raw)) return undefined;
	if (Object.is(raw, -0)) return undefined;
	return raw;
}

/** Narrow a runtime-unknown value to a valid V15 stream (0..4). */
function narrowStream(raw: unknown): number | undefined {
	if (typeof raw !== "number") return undefined;
	if (!Number.isInteger(raw)) return undefined;
	if (raw < 0 || raw > 4) return undefined;
	if (!Number.isFinite(raw)) return undefined;
	if (Object.is(raw, -0)) return undefined;
	return raw;
}

/** Narrow a runtime-unknown value to a valid V15 requestId (1n .. 2^64-1n). */
function narrowRequestId(raw: unknown): bigint | undefined {
	if (typeof raw !== "bigint") return undefined;
	if (raw < 1n || raw > MAX_REQUEST_ID) return undefined;
	return raw;
}

// ---- Encode ----

export function encodeAppFrame(kind: unknown, stream: unknown, requestId: unknown, payload: unknown): EncodeResult {
	const narrowedKind: number | undefined = narrowKind(kind);
	if (narrowedKind === undefined) {
		if (typeof kind !== "number") {
			return Object.freeze<EncodeBadKindType>({ ok: false, code: "BAD_KIND_TYPE" });
		}
		return Object.freeze<EncodeInvalidKind>({ ok: false, code: "INVALID_KIND" });
	}

	const narrowedStream: number | undefined = narrowStream(stream);
	if (narrowedStream === undefined) {
		if (typeof stream !== "number") {
			return Object.freeze<EncodeBadStreamType>({ ok: false, code: "BAD_STREAM_TYPE" });
		}
		return Object.freeze<EncodeInvalidStream>({ ok: false, code: "INVALID_STREAM" });
	}

	const narrowedId: bigint | undefined = narrowRequestId(requestId);
	if (narrowedId === undefined) {
		if (typeof requestId !== "bigint") {
			return Object.freeze<EncodeBadRequestIdType>({ ok: false, code: "BAD_REQUEST_ID_TYPE" });
		}
		return Object.freeze<EncodeInvalidRequestId>({ ok: false, code: "INVALID_REQUEST_ID" });
	}

	let unpaddedLength: number;
	let payloadBytes: Uint8Array;

	if (isControlKind(narrowedKind)) {
		if (payload !== undefined) {
			return Object.freeze<EncodeControlPayloadProvided>({ ok: false, code: "CONTROL_PAYLOAD_PROVIDED" });
		}
		unpaddedLength = MIN_UNPADDED;
		payloadBytes = new Uint8Array(0);
	} else {
		if (payload === undefined) {
			return Object.freeze<EncodeDataPayloadRequired>({ ok: false, code: "DATA_PAYLOAD_REQUIRED" });
		}

		const strict = copySandboxStrictBytes(payload, MAX_PAYLOAD);
		if (!strict.ok) {
			if (strict.code === "INPUT_TOO_LARGE") {
				return Object.freeze<EncodePayloadTooLarge>({ ok: false, code: "PAYLOAD_TOO_LARGE" });
			}
			return Object.freeze<EncodePayloadInvalid>({ ok: false, code: "PAYLOAD_INVALID" });
		}

		payloadBytes = strict.value;
		const payloadLen: number = payloadBytes.length;
		unpaddedLength = HEADER_SIZE + payloadLen;
		if (unpaddedLength > MAX_UNPADDED) {
			// Zero the acquired payload bytes before returning error
			for (let i = 0; i < payloadBytes.length; i += 1) payloadBytes[i] = 0;
			return Object.freeze<EncodePayloadExceedsMax>({ ok: false, code: "PAYLOAD_EXCEEDS_MAX" });
		}
	}

	const paddedLength = computePaddedLength(unpaddedLength);
	const buf = new Uint8Array(paddedLength);

	writeHeader(buf, narrowedKind, narrowedStream, narrowedId, unpaddedLength);

	const payloadLen: number = payloadBytes.length;
	for (let i = 0; i < payloadLen; i += 1) {
		buf[HEADER_SIZE + i] = payloadBytes[i];
	}

	// Zero payloadBytes copy now that frame is built
	for (let i = 0; i < payloadBytes.length; i += 1) payloadBytes[i] = 0;

	return Object.freeze<EncodeOk>({ ok: true, frame: buf });
}

// ---- Internal decode: processes a fresh copied buffer, returns result.
// Caller zeroes buf after this returns.

function decodeCopiedFrame(buf: Uint8Array): DecodeResult {
	const bufLen: number = buf.length;

	if (bufLen < HEADER_SIZE) {
		return Object.freeze<DecodeTooShort>({ ok: false, code: "TOO_SHORT" });
	}

	const kind: number = buf[0];
	const stream: number = buf[1];
	const reservedByte0: number = buf[2];
	const reservedByte1: number = buf[3];

	if (reservedByte0 !== 0 || reservedByte1 !== 0) {
		return Object.freeze<DecodeReservedNonZero>({ ok: false, code: "RESERVED_NONZERO" });
	}

	if (!isDataKind(kind) && !isControlKind(kind)) {
		return Object.freeze<DecodeInvalidKind>({ ok: false, code: "INVALID_KIND" });
	}

	if (stream < 0 || stream > MAX_STREAM) {
		return Object.freeze<DecodeInvalidStream>({ ok: false, code: "INVALID_STREAM" });
	}

	const requestId: bigint =
		(BigInt(buf[4]) << 56n) |
		(BigInt(buf[5]) << 48n) |
		(BigInt(buf[6]) << 40n) |
		(BigInt(buf[7]) << 32n) |
		(BigInt(buf[8]) << 24n) |
		(BigInt(buf[9]) << 16n) |
		(BigInt(buf[10]) << 8n) |
		BigInt(buf[11]);

	if (requestId === 0n || requestId > MAX_REQUEST_ID) {
		return Object.freeze<DecodeInvalidRequestId>({ ok: false, code: "INVALID_REQUEST_ID" });
	}

	const unpaddedLength: number = (buf[12] << 24) | (buf[13] << 16) | (buf[14] << 8) | buf[15];

	if (unpaddedLength < MIN_UNPADDED || unpaddedLength > MAX_UNPADDED) {
		return Object.freeze<DecodeBadUnpaddedLength>({ ok: false, code: "BAD_UNPADDED_LENGTH" });
	}

	const paddedLength: number = computePaddedLength(unpaddedLength);
	if (bufLen !== paddedLength) {
		return Object.freeze<DecodeWrongPaddedLength>({ ok: false, code: "WRONG_PADDED_LENGTH" });
	}

	for (let i = unpaddedLength; i < paddedLength; i += 1) {
		if (buf[i] !== 0) {
			return Object.freeze<DecodePaddingNonZero>({ ok: false, code: "PADDING_NONZERO" });
		}
	}

	const payloadLength: number = unpaddedLength - HEADER_SIZE;

	if (isControlKind(kind)) {
		if (unpaddedLength !== MIN_UNPADDED) {
			return Object.freeze<DecodeControlWrongLength>({ ok: false, code: "CONTROL_WRONG_UNPADDED_LENGTH" });
		}
	}

	let payload: Uint8Array;
	if (payloadLength > 0) {
		payload = new Uint8Array(payloadLength);
		for (let i = 0; i < payloadLength; i += 1) {
			payload[i] = buf[HEADER_SIZE + i];
		}
	} else {
		payload = new Uint8Array(0);
	}

	const narrowedStream: 0 | 1 | 2 | 3 | 4 =
		stream === 0 ? 0 : stream === 1 ? 1 : stream === 2 ? 2 : stream === 3 ? 3 : 4;

	if (kind === KIND_REQUEST) {
		return Object.freeze<DecodeRequestFrame>({
			ok: true,
			kind: 1,
			stream: narrowedStream,
			requestId,
			payload,
		});
	}
	if (kind === KIND_DELIVERY_ACK) {
		return Object.freeze<DecodeDeliveryAckFrame>({
			ok: true,
			kind: 2,
			stream: narrowedStream,
			requestId,
		});
	}
	if (kind === KIND_REPLY) {
		return Object.freeze<DecodeReplyFrame>({
			ok: true,
			kind: 3,
			stream: narrowedStream,
			requestId,
			payload,
		});
	}
	if (kind === KIND_CANCEL) {
		return Object.freeze<DecodeCancelFrame>({
			ok: true,
			kind: 4,
			stream: narrowedStream,
			requestId,
		});
	}
	return Object.freeze<DecodeCancelAckFrame>({
		ok: true,
		kind: 5,
		stream: narrowedStream,
		requestId,
	});
}

// ---- Decode ----

export function decodeAppFrame(input: unknown): DecodeResult {
	const strictResult = copySandboxStrictBytes(input, MAX_UNPADDED);
	if (!strictResult.ok) {
		if (strictResult.code === "INPUT_TOO_LARGE") {
			return Object.freeze<DecodeTooLarge>({ ok: false, code: "INPUT_TOO_LARGE" });
		}
		return Object.freeze<DecodeInputInvalid>({ ok: false, code: "INPUT_INVALID" });
	}

	const buf: Uint8Array = strictResult.value;

	// decodeCopiedFrame never aliases buf into its returned payload;
	// returned payload bytes are always fresh caller-owned copies.
	const result: DecodeResult = decodeCopiedFrame(buf);

	// Zero the copied strict buffer on every exit path
	for (let i = 0; i < buf.length; i += 1) buf[i] = 0;

	return result;
}
