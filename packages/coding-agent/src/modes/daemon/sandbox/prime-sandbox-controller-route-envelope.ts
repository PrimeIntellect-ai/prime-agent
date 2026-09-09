// Controller Route Envelope V1 — transport-selection codec.
//
// Wraps already-encoded V16 request bytes with the four-field
// HostedRlmRuntimeIdentity (childId, sessionId, sessionName,
// modelSelector) so a shared V31 mux can route stream 2/3 requests
// from multiple logical children. Unwraps on Home for registry selection.
// Replies remain bare V16 bytes (V31 correlates them by requestId).
//
// Fixed binary format (no JSON, no base64, no dependency):
//   [0..7]  8-byte magic  43 52 54 52 45 4e 56 00  "CRTRENV\0"
//   [8]     1-byte childId length (1..128)
//   [9]     1-byte sessionId length (1..128)
//   [10]    1-byte sessionName length (1..128)
//   [11]    1-byte modelSelector length (1..128)
//   [12..15] 4-byte big-endian inner payload length (1..262108)
//   [16..]  childId bytes, sessionId bytes, sessionName bytes,
//           modelSelector bytes, inner payload bytes
//
// Maximum total frame = 262128 (V31 application payload limit).
// With header (16) and four minimum 1-byte identity fields, maximum
// inner payload is 262108. With four 128-byte fields, maximum inner
// payload is 261600. Encoder checks 16 + sum(actual id bytes) +
// inner.length <= 262128. Decoder rejects any frame over 262128
// and requires exact match.
//
// Inner payload is never empty because an encoded V16 request is
// always non-zero length.
//
// No casts, asserts, throws, spreads, any, non-null assertions,
// instanceof at hostile boundary, no suppression directives,
// Object.setPrototypeOf, broad errors, structural brands, or
// swallowed catches.

import { types } from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

// ---------- constants ----------

const MAGIC0: number = 0x43;
const MAGIC1: number = 0x52;
const MAGIC2: number = 0x54;
const MAGIC3: number = 0x52;
const MAGIC4: number = 0x45;
const MAGIC5: number = 0x4e;
const MAGIC6: number = 0x56;
const MAGIC7: number = 0x00;

const HEADER_SIZE: number = 16;
const MIN_FIELD_LENGTH: number = 1;
const MAX_FIELD_LENGTH: number = 128;
const MIN_INNER_LENGTH: number = 1;
const MAX_TOTAL: number = 262128;

const ID_PATTERN: RegExp = /^[a-zA-Z0-9_./:-]{1,128}$/;

// ---------- captured intrinsics ----------

const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _keys: typeof Object.keys = Object.keys;
const _freeze: typeof Object.freeze = Object.freeze;
const _numberIsSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _numberIsInteger: typeof Number.isInteger = Number.isInteger;
const _uint8ArrayConstructor: Uint8ArrayConstructor = Uint8Array;
const _isNaN: typeof Number.isNaN = Number.isNaN;
const _isProxy: (value: object) => boolean = types.isProxy;
const _objectPrototype: object = Object.prototype;
const _idPatternTest: (value: string) => boolean = ID_PATTERN.test.bind(ID_PATTERN);
const _textEncoderInstance = new TextEncoder();
const _textDecoderASCIIInstance = new TextDecoder("ascii", { fatal: true });
const _encodeStr: (input?: string) => Uint8Array = _textEncoderInstance.encode.bind(_textEncoderInstance);
const _decodeASCIIFatal: (input: Uint8Array) => string =
	_textDecoderASCIIInstance.decode.bind(_textDecoderASCIIInstance);

// ---------- result types ----------

export interface ControllerRouteEncodeSuccess {
	readonly ok: true;
	readonly bytes: Uint8Array;
}

export interface ControllerRouteEncodeFailure {
	readonly ok: false;
	readonly code: "INPUT_INVALID" | "INPUT_TOO_LARGE" | "IDENTITY_INVALID" | "INNER_INVALID";
}

export type ControllerRouteEncodeResult = ControllerRouteEncodeSuccess | ControllerRouteEncodeFailure;

export interface ControllerRouteDecodeSuccess {
	readonly ok: true;
	readonly identity: Readonly<{
		readonly childId: string;
		readonly sessionId: string;
		readonly sessionName: string;
		readonly modelSelector: string;
	}>;
	readonly inner: Uint8Array;
}

export interface ControllerRouteDecodeFailure {
	readonly ok: false;
	readonly code:
		| "INPUT_INVALID"
		| "INPUT_TOO_LARGE"
		| "BAD_MAGIC"
		| "BAD_FIELD_LENGTH"
		| "BAD_INNER_LENGTH"
		| "TRUNCATED"
		| "TRAILING"
		| "NON_ASCII_IDENTITY"
		| "IDENTITY_PATTERN";
}

export type ControllerRouteDecodeResult = ControllerRouteDecodeSuccess | ControllerRouteDecodeFailure;

// ---------- frozen failure constants ----------

const FAIL_ENCODE_INPUT_INVALID: ControllerRouteEncodeFailure = _freeze({
	ok: false,
	code: "INPUT_INVALID",
});
const FAIL_ENCODE_INPUT_TOO_LARGE: ControllerRouteEncodeFailure = _freeze({
	ok: false,
	code: "INPUT_TOO_LARGE",
});
const FAIL_ENCODE_IDENTITY_INVALID: ControllerRouteEncodeFailure = _freeze({
	ok: false,
	code: "IDENTITY_INVALID",
});
const FAIL_ENCODE_INNER_INVALID: ControllerRouteEncodeFailure = _freeze({
	ok: false,
	code: "INNER_INVALID",
});

const FAIL_DECODE_INPUT_INVALID: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "INPUT_INVALID",
});
const FAIL_DECODE_INPUT_TOO_LARGE: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "INPUT_TOO_LARGE",
});
const FAIL_DECODE_BAD_MAGIC: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "BAD_MAGIC",
});
const FAIL_DECODE_BAD_FIELD_LENGTH: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "BAD_FIELD_LENGTH",
});
const FAIL_DECODE_BAD_INNER_LENGTH: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "BAD_INNER_LENGTH",
});
const FAIL_DECODE_TRUNCATED: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "TRUNCATED",
});
const FAIL_DECODE_TRAILING: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "TRAILING",
});
const FAIL_DECODE_NON_ASCII_IDENTITY: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "NON_ASCII_IDENTITY",
});
const FAIL_DECODE_IDENTITY_PATTERN: ControllerRouteDecodeFailure = _freeze({
	ok: false,
	code: "IDENTITY_PATTERN",
});

// ---------- helpers ----------

function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
	buf[offset] = (value >>> 24) & 0xff;
	buf[offset + 1] = (value >>> 16) & 0xff;
	buf[offset + 2] = (value >>> 8) & 0xff;
	buf[offset + 3] = value & 0xff;
}

function readUint32BE(buf: Uint8Array, offset: number): number {
	return (
		((buf[offset] << 24) >>> 0) + ((buf[offset + 1] << 16) >>> 0) + ((buf[offset + 2] << 8) >>> 0) + buf[offset + 3]
	);
}

function isCanonicalFieldLength(raw: unknown): raw is number {
	if (typeof raw !== "number") return false;
	if (_isNaN(raw)) return false;
	if (!_numberIsInteger(raw)) return false;
	if (raw < MIN_FIELD_LENGTH || raw > MAX_FIELD_LENGTH) return false;
	return true;
}

function isASCIIByte(byte: number): boolean {
	return byte >= 0x20 && byte <= 0x7e;
}

// ---------- identity validation ----------

interface ValidatedIdentity {
	readonly childId: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly modelSelector: string;
}

function validateIdentity(raw: unknown): ValidatedIdentity | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	var isProxied: boolean;
	try {
		isProxied = _isProxy(raw);
	} catch {
		return undefined;
	}
	if (isProxied) return undefined;

	var proto: object | null;
	try {
		proto = _getPrototypeOf(raw);
	} catch {
		return undefined;
	}
	if (proto !== _objectPrototype) return undefined;

	var symbols: ReadonlyArray<symbol>;
	try {
		symbols = _getOwnPropertySymbols(raw);
	} catch {
		return undefined;
	}
	if (symbols.length !== 0) return undefined;

	var descs: Record<string, PropertyDescriptor>;
	try {
		descs = _getOwnPropertyDescriptors(raw);
	} catch {
		return undefined;
	}

	var childId: string | undefined;
	var sessionId: string | undefined;
	var sessionName: string | undefined;
	var modelSelector: string | undefined;

	var keyNames: ReadonlyArray<string> = _keys(descs);
	for (let keyIndex: number = 0; keyIndex < keyNames.length; keyIndex++) {
		const key: string = keyNames[keyIndex];
		const desc: PropertyDescriptor | undefined = descs[key];
		if (desc === undefined) return undefined;
		if (desc.get !== undefined || desc.set !== undefined) return undefined;
		if (desc.enumerable !== true) return undefined;
		const value: unknown = desc.value;
		if (typeof value !== "string") return undefined;
		if (key === "childId") {
			childId = value;
		} else if (key === "sessionId") {
			sessionId = value;
		} else if (key === "sessionName") {
			sessionName = value;
		} else if (key === "modelSelector") {
			modelSelector = value;
		} else {
			return undefined;
		}
	}

	if (childId === undefined || sessionId === undefined || sessionName === undefined || modelSelector === undefined) {
		return undefined;
	}
	if (
		!_idPatternTest(childId) ||
		!_idPatternTest(sessionId) ||
		!_idPatternTest(sessionName) ||
		!_idPatternTest(modelSelector)
	) {
		return undefined;
	}
	return {
		childId: childId,
		sessionId: sessionId,
		sessionName: sessionName,
		modelSelector: modelSelector,
	};
}

// ---------- encode ----------

export function encodeControllerRouteEnvelope(identityRaw: unknown, innerRaw: unknown): ControllerRouteEncodeResult {
	var identity: ValidatedIdentity | undefined = validateIdentity(identityRaw);
	if (identity === undefined) return FAIL_ENCODE_IDENTITY_INVALID;

	// One strict copy per hostile byte input (inner bytes).
	var innerResult = copySandboxStrictBytes(innerRaw, MAX_TOTAL);
	if (!innerResult.ok) {
		if (innerResult.code === "INPUT_TOO_LARGE") return FAIL_ENCODE_INPUT_TOO_LARGE;
		return FAIL_ENCODE_INPUT_INVALID;
	}
	var innerBytes: Uint8Array = innerResult.value;

	if (innerBytes.length < MIN_INNER_LENGTH) {
		for (let zi: number = 0; zi < innerBytes.length; zi++) innerBytes[zi] = 0;
		return FAIL_ENCODE_INNER_INVALID;
	}

	var childIdBytes: Uint8Array = _encodeStr(identity.childId);
	var sessionIdBytes: Uint8Array = _encodeStr(identity.sessionId);
	var sessionNameBytes: Uint8Array = _encodeStr(identity.sessionName);
	var modelSelectorBytes: Uint8Array = _encodeStr(identity.modelSelector);

	if (
		childIdBytes.length < MIN_FIELD_LENGTH ||
		childIdBytes.length > MAX_FIELD_LENGTH ||
		sessionIdBytes.length < MIN_FIELD_LENGTH ||
		sessionIdBytes.length > MAX_FIELD_LENGTH ||
		sessionNameBytes.length < MIN_FIELD_LENGTH ||
		sessionNameBytes.length > MAX_FIELD_LENGTH ||
		modelSelectorBytes.length < MIN_FIELD_LENGTH ||
		modelSelectorBytes.length > MAX_FIELD_LENGTH
	) {
		for (let zi: number = 0; zi < innerBytes.length; zi++) innerBytes[zi] = 0;
		return FAIL_ENCODE_IDENTITY_INVALID;
	}

	var innerLength: number = innerBytes.length;
	var fieldsTotal: number =
		childIdBytes.length + sessionIdBytes.length + sessionNameBytes.length + modelSelectorBytes.length;
	var totalLength: number = HEADER_SIZE + fieldsTotal + innerLength;
	if (totalLength > MAX_TOTAL) {
		for (let zi: number = 0; zi < innerBytes.length; zi++) innerBytes[zi] = 0;
		return FAIL_ENCODE_INPUT_TOO_LARGE;
	}

	var frame: Uint8Array = new _uint8ArrayConstructor(totalLength);
	frame[0] = MAGIC0;
	frame[1] = MAGIC1;
	frame[2] = MAGIC2;
	frame[3] = MAGIC3;
	frame[4] = MAGIC4;
	frame[5] = MAGIC5;
	frame[6] = MAGIC6;
	frame[7] = MAGIC7;
	frame[8] = childIdBytes.length;
	frame[9] = sessionIdBytes.length;
	frame[10] = sessionNameBytes.length;
	frame[11] = modelSelectorBytes.length;
	writeUint32BE(frame, 12, innerLength);

	var offset: number = HEADER_SIZE;
	for (let i0: number = 0; i0 < childIdBytes.length; i0++) {
		frame[offset] = childIdBytes[i0];
		offset++;
	}
	for (let i1: number = 0; i1 < sessionIdBytes.length; i1++) {
		frame[offset] = sessionIdBytes[i1];
		offset++;
	}
	for (let i2: number = 0; i2 < sessionNameBytes.length; i2++) {
		frame[offset] = sessionNameBytes[i2];
		offset++;
	}
	for (let i3: number = 0; i3 < modelSelectorBytes.length; i3++) {
		frame[offset] = modelSelectorBytes[i3];
		offset++;
	}
	for (let i4: number = 0; i4 < innerBytes.length; i4++) {
		frame[offset] = innerBytes[i4];
		offset++;
	}

	// Zero the inner bytes copy.
	for (let zi: number = 0; zi < innerBytes.length; zi++) {
		innerBytes[zi] = 0;
	}

	return _freeze({ ok: true, bytes: frame });
}

// ---------- decode ----------

export function decodeControllerRouteEnvelope(inputRaw: unknown): ControllerRouteDecodeResult {
	// One strict copy per hostile byte input.
	var copyResult = copySandboxStrictBytes(inputRaw, MAX_TOTAL);
	if (!copyResult.ok) {
		if (copyResult.code === "INPUT_TOO_LARGE") return FAIL_DECODE_INPUT_TOO_LARGE;
		return FAIL_DECODE_INPUT_INVALID;
	}
	var frame: Uint8Array = copyResult.value;

	if (frame.length < HEADER_SIZE) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_TRUNCATED;
	}

	if (
		frame[0] !== MAGIC0 ||
		frame[1] !== MAGIC1 ||
		frame[2] !== MAGIC2 ||
		frame[3] !== MAGIC3 ||
		frame[4] !== MAGIC4 ||
		frame[5] !== MAGIC5 ||
		frame[6] !== MAGIC6 ||
		frame[7] !== MAGIC7
	) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_BAD_MAGIC;
	}

	var childIdLen: number = frame[8];
	var sessionIdLen: number = frame[9];
	var sessionNameLen: number = frame[10];
	var modelSelectorLen: number = frame[11];

	if (
		!isCanonicalFieldLength(childIdLen) ||
		!isCanonicalFieldLength(sessionIdLen) ||
		!isCanonicalFieldLength(sessionNameLen) ||
		!isCanonicalFieldLength(modelSelectorLen)
	) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_BAD_FIELD_LENGTH;
	}

	var innerLength: number = readUint32BE(frame, 12);
	if (innerLength < MIN_INNER_LENGTH || _isNaN(innerLength) || !_numberIsSafeInteger(innerLength)) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_BAD_INNER_LENGTH;
	}

	var fieldsTotal: number = childIdLen + sessionIdLen + sessionNameLen + modelSelectorLen;
	var expectedTotal: number = HEADER_SIZE + fieldsTotal + innerLength;

	if (expectedTotal > MAX_TOTAL) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_BAD_INNER_LENGTH;
	}

	if (frame.length < expectedTotal) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_TRUNCATED;
	}
	if (frame.length > expectedTotal) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_TRAILING;
	}

	var offset: number = HEADER_SIZE;

	function readField(len: number, start: number): { str: string } | undefined {
		const bytes: Uint8Array = new _uint8ArrayConstructor(len);
		for (let fi: number = 0; fi < len; fi++) {
			const byteVal: number = frame[start + fi];
			if (!isASCIIByte(byteVal)) return undefined;
			bytes[fi] = byteVal;
		}
		var str: string;
		try {
			str = _decodeASCIIFatal(bytes);
		} catch {
			return undefined;
		}
		return { str: str };
	}

	var childIdResult = readField(childIdLen, offset);
	if (childIdResult === undefined) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_NON_ASCII_IDENTITY;
	}
	offset += childIdLen;

	var sessionIdResult = readField(sessionIdLen, offset);
	if (sessionIdResult === undefined) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_NON_ASCII_IDENTITY;
	}
	offset += sessionIdLen;

	var sessionNameResult = readField(sessionNameLen, offset);
	if (sessionNameResult === undefined) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_NON_ASCII_IDENTITY;
	}
	offset += sessionNameLen;

	var modelSelectorResult = readField(modelSelectorLen, offset);
	if (modelSelectorResult === undefined) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_NON_ASCII_IDENTITY;
	}
	offset += modelSelectorLen;

	if (
		!_idPatternTest(childIdResult.str) ||
		!_idPatternTest(sessionIdResult.str) ||
		!_idPatternTest(sessionNameResult.str) ||
		!_idPatternTest(modelSelectorResult.str)
	) {
		for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;
		return FAIL_DECODE_IDENTITY_PATTERN;
	}

	// Build fresh owned inner buffer.
	var innerBuf: Uint8Array = new _uint8ArrayConstructor(innerLength);
	for (let ii: number = 0; ii < innerLength; ii++) {
		innerBuf[ii] = frame[offset + ii];
	}

	// Zero the copied frame bytes.
	for (let zi: number = 0; zi < frame.length; zi++) frame[zi] = 0;

	return _freeze({
		ok: true,
		identity: _freeze({
			childId: childIdResult.str,
			sessionId: sessionIdResult.str,
			sessionName: sessionNameResult.str,
			modelSelector: modelSelectorResult.str,
		}),
		inner: innerBuf,
	});
}
