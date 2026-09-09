/**
 * Canonical 320-byte hosted session write-ahead record codec.
 *
 * The codec owns no provider decisions. It accepts exact frozen inputs,
 * copies byte fields at the boundary, and clears every internal byte copy.
 */

import { createHash, type Hash } from "node:crypto";
import { types } from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _freeze: typeof Object.freeze = Object.freeze;
const _isFrozen: typeof Object.isFrozen = Object.isFrozen;
const _isProxy: typeof types.isProxy = types.isProxy;
const _isArray: typeof Array.isArray = Array.isArray;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _reflectApply: typeof Reflect.apply = Reflect.apply;
const _StringConstructor: StringConstructor = String;
const _BigIntConstructor: BigIntConstructor = BigInt;
const _ArrayPrototype: object = Array.prototype;
const _ObjectPrototype: object = Object.prototype;
const _Uint8ArrayConstructor: Uint8ArrayConstructor = Uint8Array;
const _Uint8ArrayPrototype: object = _Uint8ArrayConstructor.prototype;
const _ArrayBufferConstructor: ArrayBufferConstructor = ArrayBuffer;
const _ArrayBufferPrototype: object = _ArrayBufferConstructor.prototype;
const _DataViewConstructor: DataViewConstructor = DataView;
const _setBigUint64: DataView["setBigUint64"] = _DataViewConstructor.prototype.setBigUint64;
const _TypedArrayPrototype: object = _getPrototypeOf(_Uint8ArrayPrototype);

function _captureTypedArrayGetter(name: string): unknown {
	const descriptor: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(_TypedArrayPrototype, name);
	return descriptor === undefined ? undefined : descriptor.get;
}

const _typedArrayLengthGetter: unknown = _captureTypedArrayGetter("length");
const _typedArrayByteLengthGetter: unknown = _captureTypedArrayGetter("byteLength");
const _typedArrayBufferGetter: unknown = _captureTypedArrayGetter("buffer");
const _typedArrayByteOffsetGetter: unknown = _captureTypedArrayGetter("byteOffset");
const _createHash: typeof createHash = createHash;
const _HashPrototype: object = _getPrototypeOf(_createHash("sha256"));
function _captureHashUpdate(): Hash["update"] {
	const hash: Hash = _createHash("sha256");
	return hash.update;
}

function _captureHashDigest(): Hash["digest"] {
	const hash: Hash = _createHash("sha256");
	return hash.digest;
}

const _hashUpdate: Hash["update"] = _captureHashUpdate();
const _hashDigest: Hash["digest"] = _captureHashDigest();

const RECORD_SIZE = 320;
const DIGEST_SIZE = 32;
const MAX_CHAIN_LENGTH = 7;
const MIN_REVISION = 1n;
const MAX_REVISION = 0xffffffffffffffffn;

const ALLOCATED = 1;
const CREATE_DISPATCHED = 2;
const PRESENT = 3;
const RUNTIME_DISPATCHED = 4;
const RUNNING = 5;
const DELETE_DISPATCHED = 6;
const ABSENT = 7;
const RETIRED_ABSENT = 8;

const TERMINAL_STATUS_NULL = 0;
const TERMINAL_STATUS_COMPLETED = 1;
const TERMINAL_STATUS_ERROR = 2;
const TERMINAL_STATUS_CANCELLED = 3;

const TERMINAL_CODE_NULL = 0;
const TERMINAL_CODE_SUCCESS = 1;
const TERMINAL_CODE_FAILURE = 2;
const TERMINAL_CODE_TIMEOUT = 3;
const TERMINAL_CODE_EVICTED = 4;
const TERMINAL_CODE_USER_STOP = 5;
const TERMINAL_CODE_PARENT_STOP = 6;
const TERMINAL_CODE_REVOKED = 7;
const TERMINAL_CODE_MAX_DEPTH = 8;
const TERMINAL_CODE_INTERNAL = 9;
const TERMINAL_CODE_UNKNOWN = 10;

export type HostedSessionWalEncodeErrorCode =
	| "INPUT_INVALID"
	| "STATE_INVALID"
	| "TERMINAL_STATUS_INVALID"
	| "TERMINAL_CODE_INVALID"
	| "TERMINAL_PAIR_INVALID"
	| "REVISION_INVALID"
	| "DIGEST_INVALID";

export type HostedSessionWalDecodeErrorCode =
	| "HOSTILE_INPUT"
	| "TOO_LARGE"
	| "TRUNCATED"
	| "MAGIC_MISMATCH"
	| "STATE_UNKNOWN"
	| "TERMINAL_STATUS_UNKNOWN"
	| "TERMINAL_CODE_UNKNOWN"
	| "TERMINAL_PAIR_INVALID"
	| "RESERVED_NONZERO";

export type HostedSessionWalChainErrorCode =
	| "HOSTILE_INPUT"
	| "EMPTY_CHAIN"
	| "CHAIN_TOO_LONG"
	| "STATE_INVALID"
	| "TERMINAL_STATUS_INVALID"
	| "TERMINAL_CODE_INVALID"
	| "TERMINAL_PAIR_INVALID"
	| "DIGEST_INVALID"
	| "DECODE_FAILURE"
	| "NON_MONOTONIC_REVISION"
	| "FORK_DETECTED"
	| "GAP_DETECTED"
	| "PREV_DIGEST_MISMATCH"
	| "INVALID_TRANSITION"
	| "GENERATION_DIGEST_CHANGED"
	| "LIFECYCLE_DIGEST_CHANGED"
	| "IDENTITY_DIGEST_CHANGED"
	| "ARTIFACT_DIGEST_CHANGED"
	| "CONFIG_DIGEST_CHANGED";

export interface HostedSessionWalRecord {
	readonly state: number;
	readonly terminalStatus: number;
	readonly terminalCode: number;
	readonly revision: bigint;
	readonly lifecycleDigest: Uint8Array;
	readonly generationKey: Uint8Array;
	readonly previousRecordDigest: Uint8Array;
	readonly identityRecordDigest: Uint8Array;
	readonly releaseDigest: Uint8Array;
	readonly manifestDigest: Uint8Array;
	readonly bootstrapDigest: Uint8Array;
	readonly trustDigest: Uint8Array;
	readonly runtimeConfigDigest: Uint8Array;
}

export interface EncodeHostedSessionWalRecordSuccess {
	readonly ok: true;
	readonly value: Uint8Array;
}

export interface EncodeHostedSessionWalRecordFailure {
	readonly ok: false;
	readonly code: HostedSessionWalEncodeErrorCode;
}

export type EncodeHostedSessionWalRecordResult =
	| EncodeHostedSessionWalRecordSuccess
	| EncodeHostedSessionWalRecordFailure;

export interface DecodeHostedSessionWalRecordSuccess {
	readonly ok: true;
	readonly value: HostedSessionWalRecord;
}

export interface DecodeHostedSessionWalRecordFailure {
	readonly ok: false;
	readonly code: HostedSessionWalDecodeErrorCode;
}

export type DecodeHostedSessionWalRecordResult =
	| DecodeHostedSessionWalRecordSuccess
	| DecodeHostedSessionWalRecordFailure;

export interface VerifyHostedSessionWalChainSuccess {
	readonly ok: true;
}

export interface VerifyHostedSessionWalChainFailure {
	readonly ok: false;
	readonly errors: readonly HostedSessionWalChainErrorCode[];
}

export type VerifyHostedSessionWalChainResult = VerifyHostedSessionWalChainSuccess | VerifyHostedSessionWalChainFailure;

interface _FieldRead {
	readonly value: unknown;
}

interface _InternalDecodeSuccess {
	readonly ok: true;
	readonly record: HostedSessionWalRecord;
	readonly raw: Uint8Array | undefined;
}

interface _InternalDecodeFailure {
	readonly ok: false;
	readonly code: HostedSessionWalDecodeErrorCode;
}

type _InternalDecodeResult = _InternalDecodeSuccess | _InternalDecodeFailure;

interface _DecodedChainEntry {
	readonly record: HostedSessionWalRecord;
	readonly raw: Uint8Array;
}

function _typedArrayLength(value: Uint8Array): number | undefined {
	if (
		typeof _typedArrayLengthGetter !== "function" ||
		typeof _typedArrayByteLengthGetter !== "function" ||
		typeof _typedArrayBufferGetter !== "function" ||
		typeof _typedArrayByteOffsetGetter !== "function"
	) {
		return undefined;
	}
	const length: unknown = _reflectApply(_typedArrayLengthGetter, value, []);
	const byteLength: unknown = _reflectApply(_typedArrayByteLengthGetter, value, []);
	const buffer: unknown = _reflectApply(_typedArrayBufferGetter, value, []);
	const byteOffset: unknown = _reflectApply(_typedArrayByteOffsetGetter, value, []);
	if (typeof length !== "number" || !_isSafeInteger(length) || length < 0) return undefined;
	if (typeof byteLength !== "number" || !_isSafeInteger(byteLength) || byteLength !== length) return undefined;
	if (typeof byteOffset !== "number" || !_isSafeInteger(byteOffset) || byteOffset < 0) return undefined;
	if (typeof buffer !== "object" || buffer === null || _getPrototypeOf(buffer) !== _ArrayBufferPrototype) {
		return undefined;
	}
	return length;
}

function _zeroBytes(value: Uint8Array): void {
	const length: number | undefined = _typedArrayLength(value);
	if (length === undefined) return;
	for (let index = 0; index < length; index += 1) value[index] = 0;
}

function _zeroByteList(values: Uint8Array[]): void {
	const length: number = values.length;
	for (let index = 0; index < length; index += 1) _zeroBytes(values[index]);
}

function _appendByteValue(values: Uint8Array[], value: Uint8Array): void {
	values[values.length] = value;
}

function _copyRange(source: Uint8Array, start: number, end: number): Uint8Array {
	const output: Uint8Array = new _Uint8ArrayConstructor(end - start);
	for (let index = start; index < end; index += 1) output[index - start] = source[index];
	return output;
}

function _copyInto(target: Uint8Array, source: Uint8Array, offset: number): boolean {
	const length: number | undefined = _typedArrayLength(source);
	if (length === undefined) return false;
	for (let index = 0; index < length; index += 1) target[offset + index] = source[index];
	return true;
}

function _sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	const leftLength: number | undefined = _typedArrayLength(left);
	const rightLength: number | undefined = _typedArrayLength(right);
	if (leftLength === undefined || rightLength === undefined || leftLength !== rightLength) return false;
	let difference = 0;
	for (let index = 0; index < leftLength; index += 1) difference |= left[index] ^ right[index];
	return difference === 0;
}

function _allZero(value: Uint8Array): boolean {
	const length: number | undefined = _typedArrayLength(value);
	if (length === undefined) return false;
	let combined = 0;
	for (let index = 0; index < length; index += 1) combined |= value[index];
	return combined === 0;
}

function _validState(value: number): boolean {
	return (
		value === ALLOCATED ||
		value === CREATE_DISPATCHED ||
		value === PRESENT ||
		value === RUNTIME_DISPATCHED ||
		value === RUNNING ||
		value === DELETE_DISPATCHED ||
		value === ABSENT ||
		value === RETIRED_ABSENT
	);
}

function _validTerminalStatus(value: number): boolean {
	return (
		value === TERMINAL_STATUS_NULL ||
		value === TERMINAL_STATUS_COMPLETED ||
		value === TERMINAL_STATUS_ERROR ||
		value === TERMINAL_STATUS_CANCELLED
	);
}

function _validTerminalCode(value: number): boolean {
	return (
		value === TERMINAL_CODE_NULL ||
		value === TERMINAL_CODE_SUCCESS ||
		value === TERMINAL_CODE_FAILURE ||
		value === TERMINAL_CODE_TIMEOUT ||
		value === TERMINAL_CODE_EVICTED ||
		value === TERMINAL_CODE_USER_STOP ||
		value === TERMINAL_CODE_PARENT_STOP ||
		value === TERMINAL_CODE_REVOKED ||
		value === TERMINAL_CODE_MAX_DEPTH ||
		value === TERMINAL_CODE_INTERNAL ||
		value === TERMINAL_CODE_UNKNOWN
	);
}

function _validTerminalPair(state: number, status: number, code: number): boolean {
	if (state === DELETE_DISPATCHED) return status !== TERMINAL_STATUS_NULL && code !== TERMINAL_CODE_NULL;
	return status === TERMINAL_STATUS_NULL && code === TERMINAL_CODE_NULL;
}

function _validTransition(from: number, to: number): boolean {
	if (from === ALLOCATED) return to === CREATE_DISPATCHED;
	if (from === CREATE_DISPATCHED) return to === PRESENT || to === RETIRED_ABSENT;
	if (from === PRESENT) return to === RUNTIME_DISPATCHED;
	if (from === RUNTIME_DISPATCHED) return to === RUNNING;
	if (from === RUNNING) return to === DELETE_DISPATCHED;
	if (from === DELETE_DISPATCHED) return to === ABSENT;
	return false;
}

function _knownEncodeField(name: string): boolean {
	return (
		name === "state" ||
		name === "terminalStatus" ||
		name === "terminalCode" ||
		name === "revision" ||
		name === "lifecycleDigest" ||
		name === "generationKey" ||
		name === "previousRecordDigest" ||
		name === "identityRecordDigest" ||
		name === "releaseDigest" ||
		name === "manifestDigest" ||
		name === "bootstrapDigest" ||
		name === "trustDigest" ||
		name === "runtimeConfigDigest"
	);
}

function _arrayNameCount(names: readonly unknown[]): number | undefined {
	const descriptor: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(names, "length");
	if (descriptor === undefined) return undefined;
	const value: unknown = descriptor.value;
	if (typeof value !== "number" || !_isSafeInteger(value) || value < 0) return undefined;
	return value;
}

function _namePresent(names: readonly string[], wanted: string): boolean {
	const length: number | undefined = _arrayNameCount(names);
	if (length === undefined) return false;
	for (let index = 0; index < length; index += 1) {
		if (names[index] === wanted) return true;
	}
	return false;
}

function _readFrozenDataField(input: object, name: string): _FieldRead | undefined {
	const descriptor: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(input, name);
	if (descriptor === undefined) return undefined;
	if (descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
	if (descriptor.writable !== false || descriptor.enumerable !== true || descriptor.configurable !== false) {
		return undefined;
	}
	return _freeze({ value: descriptor.value });
}

function _validEncodeShape(input: object): boolean {
	if (_isProxy(input)) return false;
	if (_getPrototypeOf(input) !== _ObjectPrototype) return false;
	if (_isFrozen(input) !== true) return false;
	const symbols: symbol[] = _getOwnPropertySymbols(input);
	if (_arrayNameCount(symbols) !== 0) return false;
	const names: string[] = _getOwnPropertyNames(input);
	const length: number | undefined = _arrayNameCount(names);
	if (length !== 13) return false;
	for (let index = 0; index < length; index += 1) {
		if (!_knownEncodeField(names[index])) return false;
	}
	return true;
}

function _copyDigest(value: unknown, owned: Uint8Array[]): Uint8Array | undefined {
	const result = copySandboxStrictBytes(value, DIGEST_SIZE);
	if (result.ok === false) return undefined;
	const copy: Uint8Array = result.value;
	_appendByteValue(owned, copy);
	if (_typedArrayLength(copy) !== DIGEST_SIZE) return undefined;
	return copy;
}

function _encodeFailure(code: HostedSessionWalEncodeErrorCode): EncodeHostedSessionWalRecordFailure {
	return _freeze({ ok: false, code });
}

export function encodeHostedSessionWalRecord(inputRaw: unknown): EncodeHostedSessionWalRecordResult {
	const ownedDigests: Uint8Array[] = [];
	let output: Uint8Array | undefined;
	let outputTransferred = false;
	try {
		if (typeof inputRaw !== "object" || inputRaw === null || !_validEncodeShape(inputRaw)) {
			return _encodeFailure("INPUT_INVALID");
		}

		const stateField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "state");
		const statusField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "terminalStatus");
		const codeField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "terminalCode");
		const revisionField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "revision");
		const lifecycleField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "lifecycleDigest");
		const generationField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "generationKey");
		const previousField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "previousRecordDigest");
		const identityField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "identityRecordDigest");
		const releaseField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "releaseDigest");
		const manifestField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "manifestDigest");
		const bootstrapField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "bootstrapDigest");
		const trustField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "trustDigest");
		const runtimeField: _FieldRead | undefined = _readFrozenDataField(inputRaw, "runtimeConfigDigest");
		if (
			stateField === undefined ||
			statusField === undefined ||
			codeField === undefined ||
			revisionField === undefined ||
			lifecycleField === undefined ||
			generationField === undefined ||
			previousField === undefined ||
			identityField === undefined ||
			releaseField === undefined ||
			manifestField === undefined ||
			bootstrapField === undefined ||
			trustField === undefined ||
			runtimeField === undefined
		) {
			return _encodeFailure("INPUT_INVALID");
		}

		const stateValue: unknown = stateField.value;
		if (typeof stateValue !== "number" || !_isSafeInteger(stateValue) || !_validState(stateValue)) {
			return _encodeFailure("STATE_INVALID");
		}
		const statusValue: unknown = statusField.value;
		if (typeof statusValue !== "number" || !_isSafeInteger(statusValue) || !_validTerminalStatus(statusValue)) {
			return _encodeFailure("TERMINAL_STATUS_INVALID");
		}
		const codeValue: unknown = codeField.value;
		if (typeof codeValue !== "number" || !_isSafeInteger(codeValue) || !_validTerminalCode(codeValue)) {
			return _encodeFailure("TERMINAL_CODE_INVALID");
		}
		if (!_validTerminalPair(stateValue, statusValue, codeValue)) return _encodeFailure("TERMINAL_PAIR_INVALID");

		const revisionValue: unknown = revisionField.value;
		if (typeof revisionValue !== "bigint" || revisionValue < MIN_REVISION || revisionValue > MAX_REVISION) {
			return _encodeFailure("REVISION_INVALID");
		}

		const lifecycle: Uint8Array | undefined = _copyDigest(lifecycleField.value, ownedDigests);
		const generation: Uint8Array | undefined = _copyDigest(generationField.value, ownedDigests);
		const previous: Uint8Array | undefined = _copyDigest(previousField.value, ownedDigests);
		const identity: Uint8Array | undefined = _copyDigest(identityField.value, ownedDigests);
		const release: Uint8Array | undefined = _copyDigest(releaseField.value, ownedDigests);
		const manifest: Uint8Array | undefined = _copyDigest(manifestField.value, ownedDigests);
		const bootstrap: Uint8Array | undefined = _copyDigest(bootstrapField.value, ownedDigests);
		const trust: Uint8Array | undefined = _copyDigest(trustField.value, ownedDigests);
		const runtime: Uint8Array | undefined = _copyDigest(runtimeField.value, ownedDigests);
		if (
			lifecycle === undefined ||
			generation === undefined ||
			previous === undefined ||
			identity === undefined ||
			release === undefined ||
			manifest === undefined ||
			bootstrap === undefined ||
			trust === undefined ||
			runtime === undefined
		) {
			return _encodeFailure("DIGEST_INVALID");
		}

		const buffer: ArrayBuffer = new _ArrayBufferConstructor(RECORD_SIZE);
		output = new _Uint8ArrayConstructor(buffer);
		const view: DataView = new _DataViewConstructor(buffer);
		output[0] = 0x50;
		output[1] = 0x49;
		output[2] = 0x48;
		output[3] = 0x4f;
		output[4] = 0x53;
		output[5] = 0x54;
		output[6] = 0x57;
		output[7] = 0x41;
		output[8] = 0x4c;
		output[9] = 0x56;
		output[10] = 0x31;
		output[16] = stateValue;
		output[17] = statusValue;
		output[18] = codeValue;
		_reflectApply(_setBigUint64, view, [24, revisionValue, false]);
		if (
			!_copyInto(output, lifecycle, 32) ||
			!_copyInto(output, generation, 64) ||
			!_copyInto(output, previous, 96) ||
			!_copyInto(output, identity, 128) ||
			!_copyInto(output, release, 160) ||
			!_copyInto(output, manifest, 192) ||
			!_copyInto(output, bootstrap, 224) ||
			!_copyInto(output, trust, 256) ||
			!_copyInto(output, runtime, 288)
		) {
			return _encodeFailure("DIGEST_INVALID");
		}
		const success: EncodeHostedSessionWalRecordSuccess = _freeze({ ok: true, value: output });
		outputTransferred = true;
		return success;
	} finally {
		_zeroByteList(ownedDigests);
		if (!outputTransferred && output !== undefined) _zeroBytes(output);
	}
}

function _zeroRecord(record: HostedSessionWalRecord): void {
	_zeroBytes(record.lifecycleDigest);
	_zeroBytes(record.generationKey);
	_zeroBytes(record.previousRecordDigest);
	_zeroBytes(record.identityRecordDigest);
	_zeroBytes(record.releaseDigest);
	_zeroBytes(record.manifestDigest);
	_zeroBytes(record.bootstrapDigest);
	_zeroBytes(record.trustDigest);
	_zeroBytes(record.runtimeConfigDigest);
}

function _decodeFailure(code: HostedSessionWalDecodeErrorCode): _InternalDecodeFailure {
	return _freeze({ ok: false, code });
}

function _magicMatches(value: Uint8Array): boolean {
	return (
		value[0] === 0x50 &&
		value[1] === 0x49 &&
		value[2] === 0x48 &&
		value[3] === 0x4f &&
		value[4] === 0x53 &&
		value[5] === 0x54 &&
		value[6] === 0x57 &&
		value[7] === 0x41 &&
		value[8] === 0x4c &&
		value[9] === 0x56 &&
		value[10] === 0x31 &&
		value[11] === 0 &&
		value[12] === 0 &&
		value[13] === 0 &&
		value[14] === 0 &&
		value[15] === 0
	);
}

function _readRevision(value: Uint8Array): bigint {
	let revision = 0n;
	for (let index = 24; index < 32; index += 1) {
		revision = (revision << 8n) | _BigIntConstructor(value[index]);
	}
	return revision;
}

function _decodeInternal(inputRaw: unknown, retainRaw: boolean): _InternalDecodeResult {
	let owned: Uint8Array | undefined;
	const outputFields: Uint8Array[] = [];
	let rawOutput: Uint8Array | undefined;
	let outputsTransferred = false;
	try {
		const copyResult = copySandboxStrictBytes(inputRaw, RECORD_SIZE);
		if (copyResult.ok === false) {
			if (copyResult.code === "INPUT_TOO_LARGE") return _decodeFailure("TOO_LARGE");
			return _decodeFailure("HOSTILE_INPUT");
		}
		owned = copyResult.value;
		const length: number | undefined = _typedArrayLength(owned);
		if (length === undefined) return _decodeFailure("HOSTILE_INPUT");
		if (length !== RECORD_SIZE) return _decodeFailure("TRUNCATED");
		if (!_magicMatches(owned)) return _decodeFailure("MAGIC_MISMATCH");

		const state: number = owned[16];
		if (!_validState(state)) return _decodeFailure("STATE_UNKNOWN");
		const terminalStatus: number = owned[17];
		if (!_validTerminalStatus(terminalStatus)) return _decodeFailure("TERMINAL_STATUS_UNKNOWN");
		const terminalCode: number = owned[18];
		if (!_validTerminalCode(terminalCode)) return _decodeFailure("TERMINAL_CODE_UNKNOWN");
		for (let index = 19; index < 24; index += 1) {
			if (owned[index] !== 0) return _decodeFailure("RESERVED_NONZERO");
		}
		if (!_validTerminalPair(state, terminalStatus, terminalCode)) {
			return _decodeFailure("TERMINAL_PAIR_INVALID");
		}
		const revision: bigint = _readRevision(owned);
		if (revision < MIN_REVISION || revision > MAX_REVISION) return _decodeFailure("HOSTILE_INPUT");

		const lifecycleDigest: Uint8Array = _copyRange(owned, 32, 64);
		_appendByteValue(outputFields, lifecycleDigest);
		const generationKey: Uint8Array = _copyRange(owned, 64, 96);
		_appendByteValue(outputFields, generationKey);
		const previousRecordDigest: Uint8Array = _copyRange(owned, 96, 128);
		_appendByteValue(outputFields, previousRecordDigest);
		const identityRecordDigest: Uint8Array = _copyRange(owned, 128, 160);
		_appendByteValue(outputFields, identityRecordDigest);
		const releaseDigest: Uint8Array = _copyRange(owned, 160, 192);
		_appendByteValue(outputFields, releaseDigest);
		const manifestDigest: Uint8Array = _copyRange(owned, 192, 224);
		_appendByteValue(outputFields, manifestDigest);
		const bootstrapDigest: Uint8Array = _copyRange(owned, 224, 256);
		_appendByteValue(outputFields, bootstrapDigest);
		const trustDigest: Uint8Array = _copyRange(owned, 256, 288);
		_appendByteValue(outputFields, trustDigest);
		const runtimeConfigDigest: Uint8Array = _copyRange(owned, 288, 320);
		_appendByteValue(outputFields, runtimeConfigDigest);

		const record: HostedSessionWalRecord = _freeze({
			state,
			terminalStatus,
			terminalCode,
			revision,
			lifecycleDigest,
			generationKey,
			previousRecordDigest,
			identityRecordDigest,
			releaseDigest,
			manifestDigest,
			bootstrapDigest,
			trustDigest,
			runtimeConfigDigest,
		});
		if (retainRaw) {
			rawOutput = _copyRange(owned, 0, RECORD_SIZE);
			const success: _InternalDecodeSuccess = _freeze({ ok: true, record, raw: rawOutput });
			outputsTransferred = true;
			return success;
		}
		const success: _InternalDecodeSuccess = _freeze({ ok: true, record, raw: undefined });
		outputsTransferred = true;
		return success;
	} finally {
		if (owned !== undefined) _zeroBytes(owned);
		if (!outputsTransferred) {
			_zeroByteList(outputFields);
			if (rawOutput !== undefined) _zeroBytes(rawOutput);
		}
	}
}

export function decodeHostedSessionWalRecord(inputRaw: unknown): DecodeHostedSessionWalRecordResult {
	const result: _InternalDecodeResult = _decodeInternal(inputRaw, false);
	if (result.ok === false) return _freeze({ ok: false, code: result.code });
	let transferred = false;
	try {
		const success: DecodeHostedSessionWalRecordSuccess = _freeze({ ok: true, value: result.record });
		transferred = true;
		return success;
	} finally {
		if (!transferred) _zeroRecord(result.record);
	}
}

function _chainFailure(code: HostedSessionWalChainErrorCode): VerifyHostedSessionWalChainFailure {
	const errors: HostedSessionWalChainErrorCode[] = [code];
	return _freeze({ ok: false, errors: _freeze(errors) });
}

function _chainShape(input: object): number | HostedSessionWalChainErrorCode {
	if (_isProxy(input) || !_isArray(input)) return "HOSTILE_INPUT";
	if (_getPrototypeOf(input) !== _ArrayPrototype || _isFrozen(input) !== true) return "HOSTILE_INPUT";
	const symbols: symbol[] = _getOwnPropertySymbols(input);
	if (_arrayNameCount(symbols) !== 0) return "HOSTILE_INPUT";
	const lengthDescriptor: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(input, "length");
	if (lengthDescriptor === undefined) return "HOSTILE_INPUT";
	const lengthValue: unknown = lengthDescriptor.value;
	if (typeof lengthValue !== "number" || !_isSafeInteger(lengthValue) || lengthValue < 0) return "HOSTILE_INPUT";
	if (
		lengthDescriptor.writable !== false ||
		lengthDescriptor.enumerable !== false ||
		lengthDescriptor.configurable !== false
	) {
		return "HOSTILE_INPUT";
	}
	if (lengthValue === 0) return "EMPTY_CHAIN";
	if (lengthValue > MAX_CHAIN_LENGTH) return "CHAIN_TOO_LONG";
	const names: string[] = _getOwnPropertyNames(input);
	if (_arrayNameCount(names) !== lengthValue + 1 || !_namePresent(names, "length")) return "HOSTILE_INPUT";
	for (let index = 0; index < lengthValue; index += 1) {
		const name: string = _StringConstructor(index);
		if (!_namePresent(names, name)) return "HOSTILE_INPUT";
		const descriptor: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(input, name);
		if (descriptor === undefined) return "HOSTILE_INPUT";
		if (descriptor.get !== undefined || descriptor.set !== undefined) return "HOSTILE_INPUT";
		if (descriptor.writable !== false || descriptor.enumerable !== true || descriptor.configurable !== false) {
			return "HOSTILE_INPUT";
		}
	}
	return lengthValue;
}

function _decodeCodeForChain(code: HostedSessionWalDecodeErrorCode): HostedSessionWalChainErrorCode {
	if (code === "STATE_UNKNOWN") return "STATE_INVALID";
	if (code === "TERMINAL_STATUS_UNKNOWN") return "TERMINAL_STATUS_INVALID";
	if (code === "TERMINAL_CODE_UNKNOWN") return "TERMINAL_CODE_INVALID";
	if (code === "TERMINAL_PAIR_INVALID") return "TERMINAL_PAIR_INVALID";
	if (code === "HOSTILE_INPUT" || code === "TOO_LARGE") return "HOSTILE_INPUT";
	return "DECODE_FAILURE";
}

function _sha256(value: Uint8Array): Uint8Array | undefined {
	let raw: Buffer | undefined;
	let output: Uint8Array | undefined;
	let outputTransferred = false;
	try {
		const hash: Hash = _createHash("sha256");
		if (_getPrototypeOf(hash) !== _HashPrototype) return undefined;
		_reflectApply(_hashUpdate, hash, [value]);
		const digest: Buffer = _reflectApply(_hashDigest, hash, []);
		raw = digest;
		if (_typedArrayLength(digest) !== DIGEST_SIZE) return undefined;
		output = _copyRange(digest, 0, DIGEST_SIZE);
		outputTransferred = true;
		return output;
	} finally {
		if (raw !== undefined) _zeroBytes(raw);
		if (!outputTransferred && output !== undefined) _zeroBytes(output);
	}
}

function _recordDigestsConstant(
	current: HostedSessionWalRecord,
	prior: HostedSessionWalRecord,
): HostedSessionWalChainErrorCode | undefined {
	if (!_sameBytes(current.lifecycleDigest, prior.lifecycleDigest)) return "LIFECYCLE_DIGEST_CHANGED";
	if (!_sameBytes(current.generationKey, prior.generationKey)) return "GENERATION_DIGEST_CHANGED";
	if (!_sameBytes(current.identityRecordDigest, prior.identityRecordDigest)) return "IDENTITY_DIGEST_CHANGED";
	if (!_sameBytes(current.releaseDigest, prior.releaseDigest)) return "ARTIFACT_DIGEST_CHANGED";
	if (!_sameBytes(current.manifestDigest, prior.manifestDigest)) return "ARTIFACT_DIGEST_CHANGED";
	if (!_sameBytes(current.bootstrapDigest, prior.bootstrapDigest)) return "ARTIFACT_DIGEST_CHANGED";
	if (!_sameBytes(current.trustDigest, prior.trustDigest)) return "CONFIG_DIGEST_CHANGED";
	if (!_sameBytes(current.runtimeConfigDigest, prior.runtimeConfigDigest)) return "CONFIG_DIGEST_CHANGED";
	return undefined;
}

export function verifyHostedSessionWalChain(inputRaw: unknown): VerifyHostedSessionWalChainResult {
	if (typeof inputRaw !== "object" || inputRaw === null) return _chainFailure("HOSTILE_INPUT");
	const shape: number | HostedSessionWalChainErrorCode = _chainShape(inputRaw);
	if (typeof shape === "string") return _chainFailure(shape);
	const length: number = shape;
	const decoded: _DecodedChainEntry[] = [];
	try {
		for (let index = 0; index < length; index += 1) {
			const descriptor: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(
				inputRaw,
				_StringConstructor(index),
			);
			if (descriptor === undefined) return _chainFailure("HOSTILE_INPUT");
			const result: _InternalDecodeResult = _decodeInternal(descriptor.value, true);
			if (result.ok === false) return _chainFailure(_decodeCodeForChain(result.code));
			if (result.raw === undefined) {
				_zeroRecord(result.record);
				return _chainFailure("DECODE_FAILURE");
			}
			let entryTransferred = false;
			try {
				decoded[decoded.length] = _freeze({ record: result.record, raw: result.raw });
				entryTransferred = true;
			} finally {
				if (!entryTransferred) {
					_zeroBytes(result.raw);
					_zeroRecord(result.record);
				}
			}
		}

		const first: HostedSessionWalRecord = decoded[0].record;
		if (first.state !== ALLOCATED) return _chainFailure("STATE_INVALID");
		if (first.revision !== MIN_REVISION) return _chainFailure("NON_MONOTONIC_REVISION");
		if (!_allZero(first.previousRecordDigest)) return _chainFailure("PREV_DIGEST_MISMATCH");

		for (let index = 1; index < length; index += 1) {
			const prior: _DecodedChainEntry = decoded[index - 1];
			const current: _DecodedChainEntry = decoded[index];
			if (current.record.revision !== prior.record.revision + 1n) {
				if (current.record.revision <= prior.record.revision) return _chainFailure("FORK_DETECTED");
				return _chainFailure("GAP_DETECTED");
			}
			const priorDigest: Uint8Array | undefined = _sha256(prior.raw);
			if (priorDigest === undefined) return _chainFailure("DECODE_FAILURE");
			let digestMatches = false;
			try {
				digestMatches = _sameBytes(current.record.previousRecordDigest, priorDigest);
			} finally {
				_zeroBytes(priorDigest);
			}
			if (!digestMatches) return _chainFailure("PREV_DIGEST_MISMATCH");
			if (!_validTransition(prior.record.state, current.record.state)) {
				return _chainFailure("INVALID_TRANSITION");
			}
			const constantError: HostedSessionWalChainErrorCode | undefined = _recordDigestsConstant(
				current.record,
				prior.record,
			);
			if (constantError !== undefined) return _chainFailure(constantError);
		}
		return _freeze({ ok: true });
	} finally {
		const decodedLength: number = decoded.length;
		for (let index = 0; index < decodedLength; index += 1) {
			const entry: _DecodedChainEntry = decoded[index];
			_zeroBytes(entry.raw);
			_zeroRecord(entry.record);
		}
	}
}
