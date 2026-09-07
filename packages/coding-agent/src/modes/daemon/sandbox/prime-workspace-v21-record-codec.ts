import { createHash } from "node:crypto";
import { types } from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";

const Bytes = Uint8Array;
const ArrayValue = Array;
const ObjectValue = Object;
const ReflectValue = Reflect;
const freezeValue = ObjectValue.freeze;
const getPrototype = ObjectValue.getPrototypeOf;
const getDescriptor = ObjectValue.getOwnPropertyDescriptor;
const getOwnNames = ObjectValue.getOwnPropertyNames;
const getOwnSymbols = ObjectValue.getOwnPropertySymbols;
const objectHasOwn = ObjectValue.hasOwn;
const reflectApply = ReflectValue.apply;
const reflectGet = ReflectValue.get;
const arrayCheck = Array.isArray;
const proxyCheck = types.isProxy;
const safeInteger = Number.isSafeInteger;
const floorNumber = Math.floor;
const makeBigInt = BigInt;
const makeNumber = Number;
const makeString = String;
const objectPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const bytesPrototype = Uint8Array.prototype;
const stringPrototype = String.prototype;
const stringCharCodeAt = stringPrototype.charCodeAt;
const typedPrototype = getPrototype(bytesPrototype);
const typedLengthDescriptor = getDescriptor(typedPrototype, "length");
const hashCreate = createHash;

function captureHashMethods() {
	const probe = hashCreate("sha256");
	const update = probe.update;
	const digest = probe.digest;
	const probeDigest = reflectApply(digest, probe, []);
	zero(probeDigest);
	return frozen({ update, digest });
}

const hashMethods = captureHashMethods();
const hashUpdate = hashMethods.update;
const hashDigest = hashMethods.digest;

const HEADER_SIZE = 73;
const MAX_RECORD_BYTES = 1_048_576;
const MAX_PATH_BYTES = 4096;
const MAX_PATH_DEPTH = 64;
const MAX_COMPONENT_BYTES = 255;
const MAX_PLAN_ENTRIES = 1024;
const MAX_PLAN_DIRS = 4096;
const MAX_CHAIN_COUNT = 32763;
const MAX_TOTAL_BYTES = 1_073_741_824;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

export type RecordCodecFailureCode =
	| "INPUT_INVALID"
	| "INPUT_TOO_LARGE"
	| "TRUNCATED"
	| "TRAILING_BYTES"
	| "TAG_UNKNOWN"
	| "DIGEST_MISMATCH"
	| "REVISION_GAP"
	| "REVISION_DUPLICATE"
	| "REVISION_FORK"
	| "PATH_GRAMMAR"
	| "BOUNDS_PATH"
	| "BOUNDS_PAYLOAD"
	| "BOUNDS_ENTRIES"
	| "BOUNDS_DIRS"
	| "SEGMENT_ORDER"
	| "SEGMENT_GAP"
	| "TOMBSTONE_SIZE"
	| "PAYLOAD_INVALID";

interface ResultErr {
	readonly ok: false;
	readonly code: RecordCodecFailureCode;
}

interface OwnRead {
	readonly ok: boolean;
	readonly value: unknown;
}

function frozen<T extends object>(value: T): T {
	return freezeValue(value);
}

function failure(code: RecordCodecFailureCode): ResultErr {
	return frozen({ ok: false, code });
}

function descriptorHasExactFields(descriptor: PropertyDescriptor, expectedNames: readonly string[]): boolean {
	const names = getOwnNames(descriptor);
	const symbols = getOwnSymbols(descriptor);
	if (symbols.length !== 0 || names.length !== expectedNames.length) return false;
	for (let index = 0; index < expectedNames.length; index += 1) {
		if (reflectApply(objectHasOwn, ObjectValue, [descriptor, expectedNames[index]]) !== true) return false;
	}
	return true;
}

function descriptorOwnRead(descriptor: PropertyDescriptor, key: string): OwnRead {
	if (reflectApply(objectHasOwn, ObjectValue, [descriptor, key]) !== true) {
		return { ok: false, value: undefined };
	}
	return { ok: true, value: reflectApply(reflectGet, ReflectValue, [descriptor, key, descriptor]) };
}

function dataDescriptorRead(descriptor: PropertyDescriptor): OwnRead {
	if (!descriptorHasExactFields(descriptor, ["value", "writable", "enumerable", "configurable"])) {
		return { ok: false, value: undefined };
	}
	return descriptorOwnRead(descriptor, "value");
}

function typedLength(value: object): number {
	if (
		typedLengthDescriptor === undefined ||
		!descriptorHasExactFields(typedLengthDescriptor, ["get", "set", "enumerable", "configurable"])
	)
		return -1;
	const getterRead = descriptorOwnRead(typedLengthDescriptor, "get");
	if (!getterRead.ok || typeof getterRead.value !== "function") return -1;
	let found: unknown;
	try {
		found = reflectApply(getterRead.value, value, []);
	} catch {
		return -1;
	}
	if (typeof found !== "number") return -1;
	if (!safeInteger(found) || found < 0) return -1;
	return found;
}

function arrayLength(value: object): number {
	const descriptor = getDescriptor(value, "length");
	if (descriptor === undefined) return -1;
	const read = dataDescriptorRead(descriptor);
	if (!read.ok || typeof read.value !== "number") return -1;
	if (!safeInteger(read.value) || read.value < 0) return -1;
	return read.value;
}

function ownRead(value: object, key: string): OwnRead {
	const descriptor = getDescriptor(value, key);
	if (descriptor === undefined) return { ok: false, value: undefined };
	return dataDescriptorRead(descriptor);
}

function safeObject(value: unknown): value is object {
	if (typeof value !== "object" || value === null) return false;
	if (reflectApply(proxyCheck, undefined, [value]) === true) return false;
	return getPrototype(value) === objectPrototype;
}

function exactDataObject(value: unknown, expectedNames: readonly string[]): value is object {
	if (!safeObject(value)) return false;
	const names = getOwnNames(value);
	const symbols = getOwnSymbols(value);
	if (symbols.length !== 0 || names.length !== expectedNames.length) return false;
	for (let index = 0; index < expectedNames.length; index += 1) {
		const name = expectedNames[index];
		let found = false;
		for (let actualIndex = 0; actualIndex < names.length; actualIndex += 1) {
			if (names[actualIndex] === name) found = true;
		}
		if (!found) return false;
		const descriptor = getDescriptor(value, name);
		if (descriptor === undefined || !dataDescriptorRead(descriptor).ok) return false;
	}
	return true;
}

function resultFailed(value: AnyParsedRecord | ResultErr): value is ResultErr {
	if (!exactDataObject(value, ["ok", "code"])) return false;
	const okRead = ownRead(value, "ok");
	return okRead.ok && okRead.value === false;
}

function safeArray(value: unknown): value is readonly unknown[] {
	if (typeof value !== "object" || value === null) return false;
	if (reflectApply(proxyCheck, undefined, [value]) === true) return false;
	if (getPrototype(value) !== arrayPrototype || reflectApply(arrayCheck, undefined, [value]) !== true) return false;
	const length = arrayLength(value);
	if (length < 0) return false;
	const names = getOwnNames(value);
	const symbols = getOwnSymbols(value);
	if (symbols.length !== 0 || names.length !== length + 1) return false;
	for (let index = 0; index < length; index += 1) {
		const name = makeString(index);
		if (names[index] !== name) return false;
		const descriptor = getDescriptor(value, name);
		if (descriptor === undefined || !dataDescriptorRead(descriptor).ok) return false;
	}
	return names[length] === "length";
}

function genuineByteArray(value: unknown): value is Uint8Array {
	if (typeof value !== "object" || value === null) return false;
	if (reflectApply(proxyCheck, undefined, [value]) === true) return false;
	return getPrototype(value) === bytesPrototype;
}

function zero(bytes: Uint8Array): void {
	const count = typedLength(bytes);
	for (let index = 0; index < count; index += 1) bytes[index] = 0;
}

function copyOwned(bytes: Uint8Array): Uint8Array {
	const count = typedLength(bytes);
	const result = new Bytes(count);
	for (let index = 0; index < count; index += 1) result[index] = bytes[index];
	return result;
}

function copyRange(bytes: Uint8Array, start: number, end: number): Uint8Array {
	const result = new Bytes(end - start);
	for (let index = start; index < end; index += 1) result[index - start] = bytes[index];
	return result;
}

function concatenate(left: Uint8Array, right: Uint8Array): Uint8Array {
	const leftCount = typedLength(left);
	const rightCount = typedLength(right);
	const result = new Bytes(leftCount + rightCount);
	for (let index = 0; index < leftCount; index += 1) result[index] = left[index];
	for (let index = 0; index < rightCount; index += 1) result[leftCount + index] = right[index];
	return result;
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = (value >>> 8) & 0xff;
	bytes[offset + 1] = value & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = floorNumber(value / 16_777_216) & 0xff;
	bytes[offset + 1] = floorNumber(value / 65_536) & 0xff;
	bytes[offset + 2] = floorNumber(value / 256) & 0xff;
	bytes[offset + 3] = value & 0xff;
}

function readU16(bytes: Uint8Array, offset: number): number {
	return bytes[offset] * 256 + bytes[offset + 1];
}

function readU32(bytes: Uint8Array, offset: number): number {
	return bytes[offset] * 16_777_216 + bytes[offset + 1] * 65_536 + bytes[offset + 2] * 256 + bytes[offset + 3];
}

function readU64(bytes: Uint8Array, offset: number): bigint {
	let value = 0n;
	for (let index = 0; index < 8; index += 1) value = (value << 8n) | makeBigInt(bytes[offset + index]);
	return value;
}

function byteEqual(left: Uint8Array, right: Uint8Array): boolean {
	const count = typedLength(left);
	if (count !== typedLength(right)) return false;
	for (let index = 0; index < count; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function digestHasData(value: Uint8Array): boolean {
	const count = typedLength(value);
	for (let index = 0; index < count; index += 1) if (value[index] !== 0) return true;
	return false;
}

function pathPrefix(left: Uint8Array, right: Uint8Array): boolean {
	const leftCount = typedLength(left);
	const rightCount = typedLength(right);
	if (leftCount >= rightCount) return false;
	if (right[leftCount] !== 0x2f) return false;
	for (let index = 0; index < leftCount; index += 1) {
		if (left[index] !== right[index]) return false;
	}
	return true;
}

function hexEncode(bytes: Uint8Array): string {
	const table = "0123456789abcdef";
	const count = typedLength(bytes);
	let result = "";
	for (let index = 0; index < count; index += 1) {
		result += table[bytes[index] >> 4];
		result += table[bytes[index] & 0x0f];
	}
	return result;
}

function sha256(bytes: Uint8Array): Uint8Array {
	const hash = hashCreate("sha256");
	reflectApply(hashUpdate, hash, [bytes]);
	const digest = reflectApply(hashDigest, hash, []);
	const count = typedLength(digest);
	const result = new Bytes(count);
	for (let index = 0; index < count; index += 1) result[index] = digest[index];
	zero(digest);
	return result;
}

function domainHash(prefix: Uint8Array, parts: readonly Uint8Array[], count: number): Uint8Array {
	const hash = hashCreate("sha256");
	reflectApply(hashUpdate, hash, [prefix]);
	const sizeBytes = new Bytes(8);
	for (let partIndex = 0; partIndex < count; partIndex += 1) {
		const part = parts[partIndex];
		let size = makeBigInt(typedLength(part));
		for (let index = 7; index >= 0; index -= 1) {
			sizeBytes[index] = makeNumber(size & 0xffn);
			size >>= 8n;
		}
		reflectApply(hashUpdate, hash, [sizeBytes]);
		reflectApply(hashUpdate, hash, [part]);
	}
	zero(sizeBytes);
	const digest = reflectApply(hashDigest, hash, []);
	const digestCount = typedLength(digest);
	const result = new Bytes(digestCount);
	for (let index = 0; index < digestCount; index += 1) result[index] = digest[index];
	zero(digest);
	zero(prefix);
	return result;
}

function domainTx(): Uint8Array {
	const value = new Bytes(3);
	value[0] = 0x54;
	value[1] = 0x58;
	return value;
}

function domainPlan(): Uint8Array {
	const value = new Bytes(4);
	value[0] = 0x50;
	value[1] = 0x4c;
	value[2] = 0x4e;
	return value;
}

function domainPlanEntry(): Uint8Array {
	const value = new Bytes(4);
	value[0] = 0x50;
	value[1] = 0x45;
	value[2] = 0x4e;
	return value;
}

function domainEntryAggregate(): Uint8Array {
	const value = new Bytes(4);
	value[0] = 0x45;
	value[1] = 0x41;
	value[2] = 0x47;
	return value;
}

function domainVector(): Uint8Array {
	const value = new Bytes(4);
	value[0] = 0x45;
	value[1] = 0x56;
	value[2] = 0x56;
	return value;
}

function domainAbsent(): Uint8Array {
	const value = new Bytes(4);
	value[0] = 0x41;
	value[1] = 0x42;
	value[2] = 0x53;
	return value;
}

function pathFailure(path: Uint8Array): ResultErr | undefined {
	const count = typedLength(path);
	if (count > MAX_PATH_BYTES) return failure("BOUNDS_PATH");
	if (count === 0) return failure("PATH_GRAMMAR");
	if (path[0] === 0x2f || path[count - 1] === 0x2f) return failure("PATH_GRAMMAR");
	let componentStart = 0;
	let componentCount = 0;
	for (let index = 0; index <= count; index += 1) {
		if (index < count) {
			const byte = path[index];
			if (byte === 0 || byte === 1 || byte === 0x5c || byte === 0x60) return failure("PATH_GRAMMAR");
			if (byte !== 0x2f && (byte < 0x21 || byte > 0x7e)) return failure("PATH_GRAMMAR");
		}
		if (index === count || path[index] === 0x2f) {
			const componentSize = index - componentStart;
			componentCount += 1;
			if (componentCount > MAX_PATH_DEPTH || componentSize > MAX_COMPONENT_BYTES) return failure("BOUNDS_PATH");
			if (componentSize === 0) return failure("PATH_GRAMMAR");
			if (componentSize === 1 && path[componentStart] === 0x2e) return failure("PATH_GRAMMAR");
			if (componentSize === 2 && path[componentStart] === 0x2e && path[componentStart + 1] === 0x2e) {
				return failure("PATH_GRAMMAR");
			}
			componentStart = index + 1;
		}
	}
	return undefined;
}

export interface JournalRecordHeader {
	readonly schemaTag: number;
	readonly revision: number;
	readonly prevRecordDigest: Uint8Array;
	readonly payloadDigest: Uint8Array;
	readonly payloadLen: number;
}

export interface Parsed01Payload {
	readonly entryCount: number;
	readonly totalBytes: number;
	readonly txId: Uint8Array;
	readonly txDigest: Uint8Array;
	readonly entryAggregateDigest: Uint8Array;
}

export interface Parsed02Payload {
	readonly kind: number;
	readonly path: Uint8Array;
	readonly preDigest: Uint8Array;
	readonly preSize: number;
	readonly preMode: number;
	readonly postDigest: Uint8Array;
	readonly postSize: number;
	readonly postMode: number;
}

export interface Parsed03Payload {
	readonly path: Uint8Array;
}

export interface Parsed04Payload {
	readonly entryCount: number;
	readonly dirCount: number;
	readonly planDigest: Uint8Array;
}

export interface Parsed05Payload {
	readonly pathSha: Uint8Array;
	readonly fileDigest: Uint8Array;
	readonly fileSize: number;
}

export type Parsed06Payload = Parsed05Payload;

export interface Parsed07Payload {
	readonly path: Uint8Array;
	readonly validated: number;
}

export interface Parsed0APayload {
	readonly path: Uint8Array;
	readonly wasCreated: number;
}

export interface Parsed0BPayload {
	readonly entryIndex: number;
	readonly planEntryDigest: Uint8Array;
	readonly postState: number;
}

export interface Parsed0EPayload {
	readonly txId: Uint8Array;
	readonly planDigest: Uint8Array;
	readonly vectorCommitment: Uint8Array;
	readonly vectorLen: bigint;
	readonly provenanceTicket: Uint8Array;
}

export interface Parsed0FPayload {
	readonly txId: Uint8Array;
}

export interface ParsedRecord01 {
	readonly tag: 0x01;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed01Payload;
}
export interface ParsedRecord02 {
	readonly tag: 0x02;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed02Payload;
}
export interface ParsedRecord03 {
	readonly tag: 0x03;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed03Payload;
}
export interface ParsedRecord04 {
	readonly tag: 0x04;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed04Payload;
}
export interface ParsedRecord05 {
	readonly tag: 0x05;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed05Payload;
}
export interface ParsedRecord06 {
	readonly tag: 0x06;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed06Payload;
}
export interface ParsedRecord07 {
	readonly tag: 0x07;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed07Payload;
}
export interface ParsedRecord08 {
	readonly tag: 0x08;
	readonly header: JournalRecordHeader;
	readonly payload: Uint8Array;
}
export interface ParsedRecord09 {
	readonly tag: 0x09;
	readonly header: JournalRecordHeader;
	readonly payload: Uint8Array;
}
export interface ParsedRecord0A {
	readonly tag: 0x0a;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed0APayload;
}
export interface ParsedRecord0B {
	readonly tag: 0x0b;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed0BPayload;
}
export interface ParsedRecord0C {
	readonly tag: 0x0c;
	readonly header: JournalRecordHeader;
	readonly payload: Uint8Array;
}
export interface ParsedRecord0D {
	readonly tag: 0x0d;
	readonly header: JournalRecordHeader;
	readonly payload: Uint8Array;
}
export interface ParsedRecord0E {
	readonly tag: 0x0e;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed0EPayload;
}
export interface ParsedRecord0F {
	readonly tag: 0x0f;
	readonly header: JournalRecordHeader;
	readonly payload: Parsed0FPayload;
}

export type AnyParsedRecord =
	| ParsedRecord01
	| ParsedRecord02
	| ParsedRecord03
	| ParsedRecord04
	| ParsedRecord05
	| ParsedRecord06
	| ParsedRecord07
	| ParsedRecord08
	| ParsedRecord09
	| ParsedRecord0A
	| ParsedRecord0B
	| ParsedRecord0C
	| ParsedRecord0D
	| ParsedRecord0E
	| ParsedRecord0F;

function makeHeader(bytes: Uint8Array): JournalRecordHeader {
	return frozen({
		schemaTag: bytes[0],
		revision: readU32(bytes, 1),
		prevRecordDigest: copyRange(bytes, 5, 37),
		payloadDigest: copyRange(bytes, 37, 69),
		payloadLen: readU32(bytes, 69),
	});
}

function zeroHeader(header: JournalRecordHeader): void {
	zero(header.prevRecordDigest);
	zero(header.payloadDigest);
}

function decodePayload(tag: number, payload: Uint8Array, header: JournalRecordHeader): AnyParsedRecord | ResultErr {
	const count = typedLength(payload);
	if (tag === 0x01) {
		if (count !== 104) return failure("TRUNCATED");
		const value = frozen({
			entryCount: readU32(payload, 0),
			totalBytes: readU32(payload, 4),
			txId: copyRange(payload, 8, 40),
			txDigest: copyRange(payload, 40, 72),
			entryAggregateDigest: copyRange(payload, 72, 104),
		});
		return frozen({ tag: 0x01, header, payload: value });
	}
	if (tag === 0x02) {
		if (count < 79) return failure("TRUNCATED");
		const pathCount = readU16(payload, 1);
		const expected = 79 + pathCount;
		if (count < expected) return failure("TRUNCATED");
		if (count > expected) return failure("TRAILING_BYTES");
		const firstDigest = 3 + pathCount;
		const secondDigest = firstDigest + 38;
		const value = frozen({
			kind: payload[0],
			path: copyRange(payload, 3, firstDigest),
			preDigest: copyRange(payload, firstDigest, firstDigest + 32),
			preSize: readU32(payload, firstDigest + 32),
			preMode: readU16(payload, firstDigest + 36),
			postDigest: copyRange(payload, secondDigest, secondDigest + 32),
			postSize: readU32(payload, secondDigest + 32),
			postMode: readU16(payload, secondDigest + 36),
		});
		return frozen({ tag: 0x02, header, payload: value });
	}
	if (tag === 0x03) {
		if (count < 2) return failure("TRUNCATED");
		const expected = 2 + readU16(payload, 0);
		if (count < expected) return failure("TRUNCATED");
		if (count > expected) return failure("TRAILING_BYTES");
		return frozen({ tag: 0x03, header, payload: frozen({ path: copyRange(payload, 2, expected) }) });
	}
	if (tag === 0x04) {
		if (count !== 40) return failure("TRUNCATED");
		return frozen({
			tag: 0x04,
			header,
			payload: frozen({
				entryCount: readU32(payload, 0),
				dirCount: readU32(payload, 4),
				planDigest: copyRange(payload, 8, 40),
			}),
		});
	}
	if (tag === 0x05 || tag === 0x06) {
		if (count !== 68) return failure("TRUNCATED");
		const value = frozen({
			pathSha: copyRange(payload, 0, 32),
			fileDigest: copyRange(payload, 32, 64),
			fileSize: readU32(payload, 64),
		});
		if (tag === 0x05) return frozen({ tag: 0x05, header, payload: value });
		return frozen({ tag: 0x06, header, payload: value });
	}
	if (tag === 0x07 || tag === 0x0a) {
		if (count < 3) return failure("TRUNCATED");
		const expected = 3 + readU16(payload, 0);
		if (count < expected) return failure("TRUNCATED");
		if (count > expected) return failure("TRAILING_BYTES");
		const path = copyRange(payload, 2, expected - 1);
		if (tag === 0x07)
			return frozen({ tag: 0x07, header, payload: frozen({ path, validated: payload[expected - 1] }) });
		return frozen({ tag: 0x0a, header, payload: frozen({ path, wasCreated: payload[expected - 1] }) });
	}
	if (tag === 0x08 || tag === 0x09 || tag === 0x0c || tag === 0x0d) {
		if (count !== 32) return failure("TRUNCATED");
		const value = copyOwned(payload);
		if (tag === 0x08) return frozen({ tag: 0x08, header, payload: value });
		if (tag === 0x09) return frozen({ tag: 0x09, header, payload: value });
		if (tag === 0x0c) return frozen({ tag: 0x0c, header, payload: value });
		return frozen({ tag: 0x0d, header, payload: value });
	}
	if (tag === 0x0b) {
		if (count !== 35) return failure("TRUNCATED");
		return frozen({
			tag: 0x0b,
			header,
			payload: frozen({
				entryIndex: readU16(payload, 0),
				planEntryDigest: copyRange(payload, 2, 34),
				postState: payload[34],
			}),
		});
	}
	if (tag === 0x0e) {
		if (count !== 136) return failure("TOMBSTONE_SIZE");
		const value = frozen({
			txId: copyRange(payload, 0, 32),
			planDigest: copyRange(payload, 32, 64),
			vectorCommitment: copyRange(payload, 64, 96),
			vectorLen: readU64(payload, 96),
			provenanceTicket: copyRange(payload, 104, 136),
		});
		return frozen({ tag: 0x0e, header, payload: value });
	}
	if (tag === 0x0f) {
		if (count !== 32) return failure("TOMBSTONE_SIZE");
		return frozen({ tag: 0x0f, header, payload: frozen({ txId: copyOwned(payload) }) });
	}
	return failure("TAG_UNKNOWN");
}

function zeroPayload(record: AnyParsedRecord): void {
	const tag = record.tag;
	if (tag === 0x01) {
		zero(record.payload.txId);
		zero(record.payload.txDigest);
		zero(record.payload.entryAggregateDigest);
	} else if (tag === 0x02) {
		zero(record.payload.path);
		zero(record.payload.preDigest);
		zero(record.payload.postDigest);
	} else if (tag === 0x03) {
		zero(record.payload.path);
	} else if (tag === 0x04) {
		zero(record.payload.planDigest);
	} else if (tag === 0x05 || tag === 0x06) {
		zero(record.payload.pathSha);
		zero(record.payload.fileDigest);
	} else if (tag === 0x07 || tag === 0x0a) {
		zero(record.payload.path);
	} else if (tag === 0x08 || tag === 0x09 || tag === 0x0c || tag === 0x0d) {
		zero(record.payload);
	} else if (tag === 0x0b) {
		zero(record.payload.planEntryDigest);
	} else if (tag === 0x0e) {
		zero(record.payload.txId);
		zero(record.payload.planDigest);
		zero(record.payload.vectorCommitment);
		zero(record.payload.provenanceTicket);
	} else {
		zero(record.payload.txId);
	}
}

function parseOwnedRecord(
	bytes: Uint8Array,
): { readonly ok: true; readonly value: AnyParsedRecord; readonly name: string } | ResultErr {
	const count = typedLength(bytes);
	if (count < HEADER_SIZE + 1) return failure("TRUNCATED");
	const header = makeHeader(bytes);
	const expected = HEADER_SIZE + header.payloadLen;
	if (count < expected) {
		zeroHeader(header);
		return failure("TRUNCATED");
	}
	if (count > expected) {
		zeroHeader(header);
		return failure("TRAILING_BYTES");
	}
	const payload = copyRange(bytes, HEADER_SIZE, expected);
	const computed = sha256(payload);
	if (!byteEqual(computed, header.payloadDigest)) {
		zero(computed);
		zero(payload);
		zeroHeader(header);
		return failure("DIGEST_MISMATCH");
	}
	zero(computed);
	const digest = sha256(bytes);
	const name = hexEncode(digest);
	zero(digest);
	const decoded = decodePayload(header.schemaTag, payload, header);
	zero(payload);
	if (resultFailed(decoded)) {
		zeroHeader(header);
		return failure(decoded.code);
	}
	return frozen({ ok: true, value: decoded, name });
}

function payloadPathValid(payload: Uint8Array, start: number, count: number): boolean {
	const path = copyRange(payload, start, start + count);
	const pathError = pathFailure(path);
	zero(path);
	return pathError === undefined;
}

function payloadSizeValid(tag: number, payload: Uint8Array): boolean {
	const count = typedLength(payload);
	if (tag === 0x01)
		return (
			count === 104 &&
			readU32(payload, 0) >= 1 &&
			readU32(payload, 0) <= MAX_PLAN_ENTRIES &&
			readU32(payload, 4) <= MAX_TOTAL_BYTES
		);
	if (tag === 0x02) {
		if (count < 79) return false;
		const pathCount = readU16(payload, 1);
		return payload[0] <= 2 && count === 79 + pathCount && payloadPathValid(payload, 3, pathCount);
	}
	if (tag === 0x03) {
		if (count < 2) return false;
		const pathCount = readU16(payload, 0);
		return count === 2 + pathCount && payloadPathValid(payload, 2, pathCount);
	}
	if (tag === 0x04)
		return (
			count === 40 &&
			readU32(payload, 0) >= 1 &&
			readU32(payload, 0) <= MAX_PLAN_ENTRIES &&
			readU32(payload, 4) <= MAX_PLAN_DIRS
		);
	if (tag === 0x05 || tag === 0x06) return count === 68;
	if (tag === 0x07 || tag === 0x0a) {
		if (count < 3) return false;
		const pathCount = readU16(payload, 0);
		return count === 3 + pathCount && payload[count - 1] <= 1 && payloadPathValid(payload, 2, pathCount);
	}
	if (tag === 0x08 || tag === 0x09 || tag === 0x0c || tag === 0x0d || tag === 0x0f) return count === 32;
	if (tag === 0x0b)
		return count === 35 && readU16(payload, 0) < MAX_PLAN_ENTRIES && payload[34] >= 1 && payload[34] <= 3;
	return count === 136 && readU64(payload, 96) > 0n && readU64(payload, 96) <= makeBigInt(MAX_CHAIN_COUNT);
}

export function encodeRecord(
	tag: unknown,
	revision: unknown,
	prevDigest: unknown,
	payload: unknown,
): { readonly ok: true; readonly bytes: Uint8Array; readonly name: string } | ResultErr {
	if (typeof tag !== "number" || !safeInteger(tag) || tag < 1 || tag > 15) return failure("INPUT_INVALID");
	if (typeof revision !== "number" || !safeInteger(revision) || revision < 0 || revision > 0xffffffff)
		return failure("INPUT_INVALID");
	const previous = copySandboxStrictBytes(prevDigest, 32);
	if (!previous.ok) return failure(previous.code);
	if (typedLength(previous.value) !== 32) {
		zero(previous.value);
		return failure("INPUT_INVALID");
	}
	const payloadCopy = copySandboxStrictBytes(payload, MAX_RECORD_BYTES - HEADER_SIZE);
	if (!payloadCopy.ok) {
		zero(previous.value);
		return failure(payloadCopy.code);
	}
	if (!payloadSizeValid(tag, payloadCopy.value)) {
		zero(previous.value);
		zero(payloadCopy.value);
		return failure("PAYLOAD_INVALID");
	}
	const header = new Bytes(HEADER_SIZE);
	header[0] = tag;
	writeU32(header, 1, revision);
	for (let index = 0; index < 32; index += 1) header[5 + index] = previous.value[index];
	const payloadDigest = sha256(payloadCopy.value);
	for (let index = 0; index < 32; index += 1) header[37 + index] = payloadDigest[index];
	writeU32(header, 69, typedLength(payloadCopy.value));
	const record = concatenate(header, payloadCopy.value);
	const recordDigest = sha256(record);
	const name = hexEncode(recordDigest);
	zero(previous.value);
	zero(payloadCopy.value);
	zero(payloadDigest);
	zero(header);
	zero(recordDigest);
	return frozen({ ok: true, bytes: record, name });
}

export function parseRecord(
	input: unknown,
): { readonly ok: true; readonly value: AnyParsedRecord; readonly name: string } | ResultErr {
	const copied = copySandboxStrictBytes(input, MAX_RECORD_BYTES);
	if (!copied.ok) return failure(copied.code);
	const result = parseOwnedRecord(copied.value);
	zero(copied.value);
	return result;
}

export function parseRecordHeader(
	input: unknown,
): { readonly ok: true; readonly value: JournalRecordHeader } | ResultErr {
	const copied = copySandboxStrictBytes(input, MAX_RECORD_BYTES);
	if (!copied.ok) return failure(copied.code);
	if (typedLength(copied.value) < HEADER_SIZE) {
		zero(copied.value);
		return failure("TRUNCATED");
	}
	const header = makeHeader(copied.value);
	zero(copied.value);
	return frozen({ ok: true, value: header });
}

export function recordName(input: unknown): { readonly ok: true; readonly name: string } | ResultErr {
	const copied = copySandboxStrictBytes(input, MAX_RECORD_BYTES);
	if (!copied.ok) return failure(copied.code);
	const digest = sha256(copied.value);
	const name = hexEncode(digest);
	zero(copied.value);
	zero(digest);
	return frozen({ ok: true, name });
}

export function validatePath(
	input: unknown,
): { readonly ok: true; readonly components: readonly Uint8Array[] } | ResultErr {
	const copied = copySandboxStrictBytes(input, MAX_PATH_BYTES);
	if (!copied.ok) {
		if (copied.code === "INPUT_TOO_LARGE") return failure("BOUNDS_PATH");
		return failure("INPUT_INVALID");
	}
	const pathError = pathFailure(copied.value);
	if (pathError !== undefined) {
		zero(copied.value);
		return pathError;
	}
	const count = typedLength(copied.value);
	let componentCount = 1;
	for (let index = 0; index < count; index += 1) if (copied.value[index] === 0x2f) componentCount += 1;
	const components = new ArrayValue<Uint8Array>(componentCount);
	let start = 0;
	let componentIndex = 0;
	for (let index = 0; index <= count; index += 1) {
		if (index === count || copied.value[index] === 0x2f) {
			components[componentIndex] = copyRange(copied.value, start, index);
			componentIndex += 1;
			start = index + 1;
		}
	}
	zero(copied.value);
	freezeValue(components);
	return frozen({ ok: true, components });
}

export interface NamedJournalRecordInput {
	readonly name: string;
	readonly bytes: Uint8Array;
}

export interface ScannedJournalRecord {
	readonly name: string;
	readonly value: AnyParsedRecord;
}

function recordNameValid(value: unknown): value is string {
	if (typeof value !== "string" || value.length !== 64) return false;
	for (let index = 0; index < value.length; index += 1) {
		const code: unknown = reflectApply(stringCharCodeAt, value, [index]);
		if (typeof code !== "number" || !((code >= 0x30 && code <= 0x39) || (code >= 0x61 && code <= 0x66))) {
			return false;
		}
	}
	return true;
}

function zeroParsedRecords(records: AnyParsedRecord[], count: number): void {
	for (let index = 0; index < count; index += 1) {
		zeroPayload(records[index]);
		zeroHeader(records[index].header);
	}
}

function zeroRawRecords(records: Uint8Array[], count: number): void {
	for (let index = 0; index < count; index += 1) zero(records[index]);
}

/**
 * Scans journal files only. V24 phase-3 FINALIZED and phase-5 ABSENT recovery
 * results belong to the fixed-root integration, not to this record codec.
 */
export function scanJournalRecords(
	input: unknown,
): { readonly ok: true; readonly records: readonly ScannedJournalRecord[] } | ResultErr {
	if (!safeArray(input)) return failure("INPUT_INVALID");
	const count = arrayLength(input);
	if (count === 0) return failure("TRUNCATED");
	if (count > MAX_CHAIN_COUNT) return failure("BOUNDS_PAYLOAD");
	const rawReferences = new ArrayValue<Uint8Array>(count);
	const rawRecords = new ArrayValue<Uint8Array>(count);
	const names = new ArrayValue<string>(count);
	let totalBytes = 0;
	for (let index = 0; index < count; index += 1) {
		const itemRead = ownRead(input, makeString(index));
		if (!itemRead.ok || !exactDataObject(itemRead.value, ["name", "bytes"])) {
			return failure("INPUT_INVALID");
		}
		const nameRead = ownRead(itemRead.value, "name");
		const bytesRead = ownRead(itemRead.value, "bytes");
		if (!nameRead.ok || !recordNameValid(nameRead.value) || !bytesRead.ok || !genuineByteArray(bytesRead.value)) {
			return failure("INPUT_INVALID");
		}
		const rawLength = typedLength(bytesRead.value);
		if (rawLength < 0) return failure("INPUT_INVALID");
		if (rawLength > MAX_RECORD_BYTES) return failure("INPUT_TOO_LARGE");
		totalBytes += rawLength;
		if (totalBytes > MAX_JOURNAL_BYTES) return failure("BOUNDS_PAYLOAD");
		rawReferences[index] = bytesRead.value;
		names[index] = nameRead.value;
	}
	let copiedCount = 0;
	for (let index = 0; index < count; index += 1) {
		const copied = copySandboxStrictBytes(rawReferences[index], MAX_RECORD_BYTES);
		if (!copied.ok) {
			zeroRawRecords(rawRecords, copiedCount);
			return failure(copied.code);
		}
		rawRecords[index] = copied.value;
		copiedCount += 1;
	}
	const parsedRecords = new ArrayValue<AnyParsedRecord>(count);
	const parsedNames = new ArrayValue<string>(count);
	let parsedCount = 0;
	for (let index = 0; index < count; index += 1) {
		const parsed = parseOwnedRecord(rawRecords[index]);
		zero(rawRecords[index]);
		if (!parsed.ok) {
			zeroRawRecords(rawRecords, count);
			zeroParsedRecords(parsedRecords, parsedCount);
			return parsed;
		}
		if (parsed.name !== names[index]) {
			zeroPayload(parsed.value);
			zeroHeader(parsed.value.header);
			zeroRawRecords(rawRecords, count);
			zeroParsedRecords(parsedRecords, parsedCount);
			return failure("DIGEST_MISMATCH");
		}
		parsedRecords[index] = parsed.value;
		parsedNames[index] = parsed.name;
		parsedCount += 1;
	}
	const orderedRecords = new ArrayValue<AnyParsedRecord>(count);
	const orderedNames = new ArrayValue<string>(count);
	for (let index = 0; index < count; index += 1) {
		const revision = parsedRecords[index].header.revision;
		if (revision >= count) {
			zeroParsedRecords(parsedRecords, parsedCount);
			return failure("REVISION_GAP");
		}
		if (orderedRecords[revision] !== undefined) {
			zeroParsedRecords(parsedRecords, parsedCount);
			return failure("REVISION_DUPLICATE");
		}
		orderedRecords[revision] = parsedRecords[index];
		orderedNames[revision] = parsedNames[index];
	}
	const zeroDigest = new Bytes(32);
	const validGenesis = byteEqual(orderedRecords[0].header.prevRecordDigest, zeroDigest);
	zero(zeroDigest);
	if (!validGenesis) {
		zeroParsedRecords(parsedRecords, parsedCount);
		return failure("REVISION_FORK");
	}
	for (let revision = 1; revision < count; revision += 1) {
		if (hexEncode(orderedRecords[revision].header.prevRecordDigest) !== orderedNames[revision - 1]) {
			zeroParsedRecords(parsedRecords, parsedCount);
			return failure("REVISION_FORK");
		}
	}
	const grammar = validateGrammar(orderedRecords);
	if (!grammar.ok) {
		zeroParsedRecords(parsedRecords, parsedCount);
		return grammar;
	}
	const records = new ArrayValue<ScannedJournalRecord>(count);
	for (let index = 0; index < count; index += 1)
		records[index] = frozen({ name: orderedNames[index], value: orderedRecords[index] });
	freezeValue(records);
	return frozen({ ok: true, records });
}

function parseRootTombstone(
	input: unknown,
	tag: 0x0e | 0x0f,
): { readonly ok: true; readonly value: ParsedRecord0E | ParsedRecord0F; readonly name: string } | ResultErr {
	const copied = copySandboxStrictBytes(input, tag === 0x0e ? 209 : 105);
	if (!copied.ok) return failure(copied.code);
	const parsed = parseOwnedRecord(copied.value);
	zero(copied.value);
	if (!parsed.ok) return parsed;
	if (parsed.value.tag !== tag) {
		zeroPayload(parsed.value);
		zeroHeader(parsed.value.header);
		return failure("TAG_UNKNOWN");
	}
	if (tag === 0x0e && parsed.value.tag === 0x0e) {
		const payload = parsed.value.payload;
		if (
			!digestHasData(payload.txId) ||
			!digestHasData(payload.planDigest) ||
			!digestHasData(payload.vectorCommitment) ||
			payload.vectorLen < 1n ||
			payload.vectorLen > makeBigInt(MAX_CHAIN_COUNT) ||
			!digestHasData(payload.provenanceTicket)
		) {
			zeroPayload(parsed.value);
			zeroHeader(parsed.value.header);
			return failure("PAYLOAD_INVALID");
		}
		return frozen({ ok: true, value: parsed.value, name: parsed.name });
	}
	if (parsed.value.tag !== 0x0f || !digestHasData(parsed.value.payload.txId)) {
		zeroPayload(parsed.value);
		zeroHeader(parsed.value.header);
		return failure("PAYLOAD_INVALID");
	}
	return frozen({ ok: true, value: parsed.value, name: parsed.name });
}

export function parseCommitTombstone(
	input: unknown,
): { readonly ok: true; readonly value: ParsedRecord0E; readonly name: string } | ResultErr {
	const result = parseRootTombstone(input, 0x0e);
	if (!result.ok) return failure(result.code);
	if (result.value.tag !== 0x0e) {
		zeroPayload(result.value);
		zeroHeader(result.value.header);
		return failure("TAG_UNKNOWN");
	}
	return frozen({ ok: true, value: result.value, name: result.name });
}

export function parseAbortTombstone(
	input: unknown,
): { readonly ok: true; readonly value: ParsedRecord0F; readonly name: string } | ResultErr {
	const result = parseRootTombstone(input, 0x0f);
	if (!result.ok) return failure(result.code);
	if (result.value.tag !== 0x0f) {
		zeroPayload(result.value);
		zeroHeader(result.value.header);
		return failure("TAG_UNKNOWN");
	}
	return frozen({ ok: true, value: result.value, name: result.name });
}

function zeroRecordSummaries(
	records: { name: string; header: JournalRecordHeader; tag: number }[],
	count: number,
): void {
	for (let index = 0; index < count; index += 1) zeroHeader(records[index].header);
}

export function parseRecords(input: unknown):
	| {
			readonly ok: true;
			readonly records: readonly {
				readonly name: string;
				readonly header: JournalRecordHeader;
				readonly tag: number;
			}[];
	  }
	| ResultErr {
	if (!safeArray(input)) return failure("INPUT_INVALID");
	const count = arrayLength(input);
	if (count === 0) return failure("TRUNCATED");
	if (count > MAX_CHAIN_COUNT) return failure("BOUNDS_PAYLOAD");
	const rawReferences = new ArrayValue<Uint8Array>(count);
	let totalBytes = 0;
	for (let index = 0; index < count; index += 1) {
		const item = ownRead(input, makeString(index));
		if (!item.ok || !genuineByteArray(item.value)) return failure("INPUT_INVALID");
		const rawLength = typedLength(item.value);
		if (rawLength < 0) return failure("INPUT_INVALID");
		if (rawLength > MAX_RECORD_BYTES) return failure("INPUT_TOO_LARGE");
		totalBytes += rawLength;
		if (totalBytes > MAX_JOURNAL_BYTES) return failure("BOUNDS_PAYLOAD");
		rawReferences[index] = item.value;
	}
	const records = new ArrayValue<{ name: string; header: JournalRecordHeader; tag: number }>(count);
	let produced = 0;
	let previousName = "";
	let previousRevision = -1;
	for (let index = 0; index < count; index += 1) {
		const copied = copySandboxStrictBytes(rawReferences[index], MAX_RECORD_BYTES);
		if (!copied.ok) {
			zeroRecordSummaries(records, produced);
			return failure(copied.code);
		}
		const parsed = parseOwnedRecord(copied.value);
		zero(copied.value);
		if (!parsed.ok) {
			zeroRecordSummaries(records, produced);
			return parsed;
		}
		zeroPayload(parsed.value);
		const header = parsed.value.header;
		if (index === 0) {
			if (header.revision !== 0) {
				zeroHeader(header);
				zeroRecordSummaries(records, produced);
				return failure("REVISION_GAP");
			}
			const zeroDigest = new Bytes(32);
			const matches = byteEqual(header.prevRecordDigest, zeroDigest);
			zero(zeroDigest);
			if (!matches) {
				zeroHeader(header);
				zeroRecordSummaries(records, produced);
				return failure("REVISION_FORK");
			}
		} else {
			if (header.revision === previousRevision) {
				zeroHeader(header);
				zeroRecordSummaries(records, produced);
				return failure("REVISION_DUPLICATE");
			}
			if (header.revision !== previousRevision + 1) {
				zeroHeader(header);
				zeroRecordSummaries(records, produced);
				return failure("REVISION_GAP");
			}
			if (hexEncode(header.prevRecordDigest) !== previousName) {
				zeroHeader(header);
				zeroRecordSummaries(records, produced);
				return failure("REVISION_FORK");
			}
		}
		records[index] = frozen({ name: parsed.name, header, tag: header.schemaTag });
		produced += 1;
		previousName = parsed.name;
		previousRevision = header.revision;
	}
	freezeValue(records);
	return frozen({ ok: true, records });
}

function numberField(value: object, key: string): number {
	const read = ownRead(value, key);
	if (!read.ok || typeof read.value !== "number" || !safeInteger(read.value)) return -1;
	return read.value;
}

function pathField(value: object, key: string): { readonly ok: true; readonly value: Uint8Array } | ResultErr {
	const read = ownRead(value, key);
	if (!read.ok) return failure("INPUT_INVALID");
	const copied = copySandboxStrictBytes(read.value, MAX_PATH_BYTES);
	if (!copied.ok) {
		if (copied.code === "INPUT_TOO_LARGE") return failure("BOUNDS_PATH");
		return failure("INPUT_INVALID");
	}
	return { ok: true, value: copied.value };
}

function exactByteField(value: object, key: string, size: number): Uint8Array | undefined {
	const read = ownRead(value, key);
	if (!read.ok) return undefined;
	const copied = copySandboxStrictBytes(read.value, size);
	if (!copied.ok) return undefined;
	if (typedLength(copied.value) !== size) {
		zero(copied.value);
		return undefined;
	}
	return copied.value;
}

function exactByteValue(value: unknown, size: number): Uint8Array | undefined {
	const copied = copySandboxStrictBytes(value, size);
	if (!copied.ok) return undefined;
	if (typedLength(copied.value) !== size) {
		zero(copied.value);
		return undefined;
	}
	return copied.value;
}

function zeroTracked(values: Uint8Array[], count: number): void {
	for (let index = 0; index < count; index += 1) zero(values[index]);
}

function grammarFailure(code: RecordCodecFailureCode, tracked: Uint8Array[], count: number): ResultErr {
	zeroTracked(tracked, count);
	return failure(code);
}

function entryDigestFromFields(
	kind: number,
	path: Uint8Array,
	preDigest: Uint8Array,
	preSize: number,
	preMode: number,
	postDigest: Uint8Array,
	postSize: number,
	postMode: number,
): Uint8Array {
	const kindPart = new Bytes(1);
	kindPart[0] = kind;
	const pathSizePart = new Bytes(2);
	writeU16(pathSizePart, 0, typedLength(path));
	const preSizePart = new Bytes(4);
	writeU32(preSizePart, 0, preSize);
	const preModePart = new Bytes(2);
	writeU16(preModePart, 0, preMode);
	const postSizePart = new Bytes(4);
	writeU32(postSizePart, 0, postSize);
	const postModePart = new Bytes(2);
	writeU16(postModePart, 0, postMode);
	const parts = [
		kindPart,
		pathSizePart,
		path,
		preDigest,
		preSizePart,
		preModePart,
		postDigest,
		postSizePart,
		postModePart,
	];
	const result = domainHash(domainPlanEntry(), parts, 9);
	zero(kindPart);
	zero(pathSizePart);
	zero(preSizePart);
	zero(preModePart);
	zero(postSizePart);
	zero(postModePart);
	return result;
}

function byteOrder(left: Uint8Array, right: Uint8Array): number {
	const count = typedLength(left);
	for (let index = 0; index < count; index += 1) {
		if (left[index] < right[index]) return -1;
		if (left[index] > right[index]) return 1;
	}
	return 0;
}

function aggregateDigest(values: Uint8Array[], count: number): Uint8Array {
	const ordered = new ArrayValue<Uint8Array>(count);
	for (let index = 0; index < count; index += 1) ordered[index] = values[index];
	for (let index = 1; index < count; index += 1) {
		const current = ordered[index];
		let position = index;
		while (position > 0 && byteOrder(current, ordered[position - 1]) < 0) {
			ordered[position] = ordered[position - 1];
			position -= 1;
		}
		ordered[position] = current;
	}
	return domainHash(domainEntryAggregate(), ordered, count);
}

function payloadShapeValid(tag: number, value: unknown): value is object {
	if (tag === 0x01)
		return exactDataObject(value, ["entryCount", "totalBytes", "txId", "txDigest", "entryAggregateDigest"]);
	if (tag === 0x02)
		return exactDataObject(value, [
			"kind",
			"path",
			"preDigest",
			"preSize",
			"preMode",
			"postDigest",
			"postSize",
			"postMode",
		]);
	if (tag === 0x03) return exactDataObject(value, ["path"]);
	if (tag === 0x04) return exactDataObject(value, ["entryCount", "dirCount", "planDigest"]);
	if (tag === 0x05 || tag === 0x06) return exactDataObject(value, ["pathSha", "fileDigest", "fileSize"]);
	if (tag === 0x07) return exactDataObject(value, ["path", "validated"]);
	if (tag === 0x0a) return exactDataObject(value, ["path", "wasCreated"]);
	if (tag === 0x0b) return exactDataObject(value, ["entryIndex", "planEntryDigest", "postState"]);
	return tag === 0x08 || tag === 0x09 || tag === 0x0c || tag === 0x0d;
}

function fixedPayloadLength(tag: number): number {
	if (tag === 0x01) return 104;
	if (tag === 0x04) return 40;
	if (tag === 0x05 || tag === 0x06) return 68;
	if (tag === 0x08 || tag === 0x09 || tag === 0x0c || tag === 0x0d) return 32;
	if (tag === 0x0b) return 35;
	return -1;
}

function variablePayloadLength(tag: number, path: Uint8Array): number {
	if (tag === 0x02) return 79 + typedLength(path);
	if (tag === 0x03) return 2 + typedLength(path);
	if (tag === 0x07 || tag === 0x0a) return 3 + typedLength(path);
	return -1;
}

export function validateGrammar(input: unknown): { readonly ok: true } | ResultErr {
	if (!safeArray(input)) return failure("INPUT_INVALID");
	const recordCount = arrayLength(input);
	if (recordCount === 0) return failure("TRUNCATED");
	if (recordCount > MAX_CHAIN_COUNT + 1) return failure("BOUNDS_PAYLOAD");
	const tracked = new ArrayValue<Uint8Array>(recordCount * 8 + MAX_PLAN_DIRS + 16);
	let trackedCount = 0;
	const entryDigests = new ArrayValue<Uint8Array>(MAX_PLAN_ENTRIES);
	const entryPaths = new ArrayValue<Uint8Array>(MAX_PLAN_ENTRIES);
	const entryKinds = new ArrayValue<number>(MAX_PLAN_ENTRIES);
	const entryPreDigests = new ArrayValue<Uint8Array>(MAX_PLAN_ENTRIES);
	const entryPostDigests = new ArrayValue<Uint8Array>(MAX_PLAN_ENTRIES);
	const entryPreSizes = new ArrayValue<number>(MAX_PLAN_ENTRIES);
	const entryPostSizes = new ArrayValue<number>(MAX_PLAN_ENTRIES);
	const dirPaths = new ArrayValue<Uint8Array>(MAX_PLAN_DIRS);
	const expectedDirPaths = new ArrayValue<Uint8Array>(MAX_PLAN_DIRS);
	let expectedDirCount = 0;
	let expectedEntries = -1;
	let expectedTotalBytes = -1;
	let entryCount = 0;
	let dirCount = 0;
	let stageIndex = 0;
	let backupIndex = 0;
	let prepareIndex = 0;
	let appliedDirIndex = 0;
	let appliedEntryIndex = 0;
	let sealedDigest: Uint8Array | undefined;
	let declaredAggregate: Uint8Array | undefined;
	let phase = 0;
	let sawHeader = false;
	let sawPrepare = false;
	let sawCommit = false;
	let sawVerify = false;

	for (let recordIndex = 0; recordIndex < recordCount; recordIndex += 1) {
		const recordRead = ownRead(input, makeString(recordIndex));
		if (!recordRead.ok || !exactDataObject(recordRead.value, ["tag", "header", "payload"]))
			return grammarFailure("INPUT_INVALID", tracked, trackedCount);
		const record = recordRead.value;
		const tag = numberField(record, "tag");
		const headerRead = ownRead(record, "header");
		const payloadRead = ownRead(record, "payload");
		if (
			tag < 1 ||
			tag > 0x0d ||
			!headerRead.ok ||
			!exactDataObject(headerRead.value, [
				"schemaTag",
				"revision",
				"prevRecordDigest",
				"payloadDigest",
				"payloadLen",
			]) ||
			!payloadRead.ok ||
			!payloadShapeValid(tag, payloadRead.value)
		)
			return grammarFailure("INPUT_INVALID", tracked, trackedCount);
		const header = headerRead.value;
		const revision = numberField(header, "revision");
		const payloadLen = numberField(header, "payloadLen");
		const fixedLength = fixedPayloadLength(tag);
		if (
			numberField(header, "schemaTag") !== tag ||
			revision < 0 ||
			revision > 0xffffffff ||
			payloadLen < 0 ||
			payloadLen > MAX_RECORD_BYTES - HEADER_SIZE ||
			(fixedLength >= 0 && payloadLen !== fixedLength)
		)
			return grammarFailure("INPUT_INVALID", tracked, trackedCount);
		const previousDigest = exactByteField(header, "prevRecordDigest", 32);
		if (previousDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
		tracked[trackedCount] = previousDigest;
		trackedCount += 1;
		const payloadDigest = exactByteField(header, "payloadDigest", 32);
		if (payloadDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
		tracked[trackedCount] = payloadDigest;
		trackedCount += 1;
		const payloadValue = payloadRead.value;

		if (phase === 0) {
			if (tag === 0x01) {
				if (sawHeader || !safeObject(payloadValue)) return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
				expectedEntries = numberField(payloadValue, "entryCount");
				expectedTotalBytes = numberField(payloadValue, "totalBytes");
				if (expectedEntries < 1 || expectedEntries > MAX_PLAN_ENTRIES)
					return grammarFailure("BOUNDS_ENTRIES", tracked, trackedCount);
				if (expectedTotalBytes < 0 || expectedTotalBytes > MAX_TOTAL_BYTES)
					return grammarFailure("BOUNDS_PAYLOAD", tracked, trackedCount);
				const txId = exactByteField(payloadValue, "txId", 32);
				if (txId === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				tracked[trackedCount] = txId;
				trackedCount += 1;
				const txDigest = exactByteField(payloadValue, "txDigest", 32);
				if (txDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				tracked[trackedCount] = txDigest;
				trackedCount += 1;
				const headerAggregate = exactByteField(payloadValue, "entryAggregateDigest", 32);
				if (headerAggregate === undefined || typedLength(headerAggregate) !== 32)
					return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				tracked[trackedCount] = headerAggregate;
				trackedCount += 1;
				declaredAggregate = headerAggregate;
				sawHeader = true;
				continue;
			}
			if (tag === 0x02) {
				if (!sawHeader || !safeObject(payloadValue)) return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
				if (entryCount >= expectedEntries) return grammarFailure("BOUNDS_ENTRIES", tracked, trackedCount);
				const kind = numberField(payloadValue, "kind");
				const preSize = numberField(payloadValue, "preSize");
				const preMode = numberField(payloadValue, "preMode");
				const postSize = numberField(payloadValue, "postSize");
				const postMode = numberField(payloadValue, "postMode");
				const pathRead = pathField(payloadValue, "path");
				if (!pathRead.ok) return grammarFailure(pathRead.code, tracked, trackedCount);
				const path = pathRead.value;
				tracked[trackedCount] = path;
				trackedCount += 1;
				if (payloadLen !== variablePayloadLength(tag, path))
					return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				const preDigest = exactByteField(payloadValue, "preDigest", 32);
				if (preDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				tracked[trackedCount] = preDigest;
				trackedCount += 1;
				const postDigest = exactByteField(payloadValue, "postDigest", 32);
				if (postDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				tracked[trackedCount] = postDigest;
				trackedCount += 1;
				if (typedLength(preDigest) !== 32 || typedLength(postDigest) !== 32)
					return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				const pathError = pathFailure(path);
				if (pathError !== undefined) return grammarFailure(pathError.code, tracked, trackedCount);
				for (let prior = 0; prior < entryCount; prior += 1) {
					if (
						byteEqual(path, entryPaths[prior]) ||
						pathPrefix(path, entryPaths[prior]) ||
						pathPrefix(entryPaths[prior], path)
					)
						return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
				}
				if (kind < 0 || kind > 2 || preSize < 0 || preSize > 0xffffffff || postSize < 0 || postSize > 0xffffffff)
					return grammarFailure("PAYLOAD_INVALID", tracked, trackedCount);
				if (preMode < 0 || preMode > 0xffff || postMode < 0 || postMode > 0xffff)
					return grammarFailure("PAYLOAD_INVALID", tracked, trackedCount);
				const pathSize = new Bytes(2);
				writeU16(pathSize, 0, typedLength(path));
				const expectedAbsence = domainHash(domainAbsent(), [pathSize, path], 2);
				zero(pathSize);
				tracked[trackedCount] = expectedAbsence;
				trackedCount += 1;
				let semantic = false;
				if (kind === 0)
					semantic =
						preMode === 0 &&
						preSize === 0 &&
						postMode === 0o600 &&
						byteEqual(preDigest, expectedAbsence) &&
						digestHasData(postDigest);
				if (kind === 1)
					semantic =
						preMode === 0o600 &&
						postMode === 0 &&
						postSize === 0 &&
						byteEqual(postDigest, expectedAbsence) &&
						digestHasData(preDigest);
				if (kind === 2)
					semantic =
						preMode === 0o600 && postMode === 0o600 && digestHasData(preDigest) && digestHasData(postDigest);
				if (!semantic || byteEqual(preDigest, postDigest))
					return grammarFailure("PAYLOAD_INVALID", tracked, trackedCount);
				const pathCount = typedLength(path);
				for (let pathIndex = 0; pathIndex < pathCount; pathIndex += 1) {
					if (path[pathIndex] !== 0x2f) continue;
					const parent = copyRange(path, 0, pathIndex);
					let known = false;
					for (let prior = 0; prior < expectedDirCount; prior += 1)
						if (byteEqual(parent, expectedDirPaths[prior])) known = true;
					if (known) {
						zero(parent);
					} else {
						if (expectedDirCount >= MAX_PLAN_DIRS) {
							zero(parent);
							return grammarFailure("BOUNDS_DIRS", tracked, trackedCount);
						}
						expectedDirPaths[expectedDirCount] = parent;
						expectedDirCount += 1;
						tracked[trackedCount] = parent;
						trackedCount += 1;
					}
				}
				const digest = entryDigestFromFields(
					kind,
					path,
					preDigest,
					preSize,
					preMode,
					postDigest,
					postSize,
					postMode,
				);
				tracked[trackedCount] = digest;
				trackedCount += 1;
				entryPaths[entryCount] = path;
				entryPreDigests[entryCount] = preDigest;
				entryPostDigests[entryCount] = postDigest;
				entryDigests[entryCount] = digest;
				entryKinds[entryCount] = kind;
				entryPreSizes[entryCount] = preSize;
				entryPostSizes[entryCount] = postSize;
				entryCount += 1;
				continue;
			}
			if (tag === 0x03) {
				if (!sawHeader || entryCount !== expectedEntries || !safeObject(payloadValue))
					return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
				if (dirCount >= expectedDirCount) return grammarFailure("BOUNDS_DIRS", tracked, trackedCount);
				const pathRead = pathField(payloadValue, "path");
				if (!pathRead.ok) return grammarFailure(pathRead.code, tracked, trackedCount);
				const path = pathRead.value;
				tracked[trackedCount] = path;
				trackedCount += 1;
				if (payloadLen !== variablePayloadLength(tag, path))
					return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				const pathError = pathFailure(path);
				if (pathError !== undefined) return grammarFailure(pathError.code, tracked, trackedCount);
				if (!byteEqual(path, expectedDirPaths[dirCount]))
					return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
				dirPaths[dirCount] = path;
				dirCount += 1;
				continue;
			}
			if (tag === 0x04) {
				if (!sawHeader || entryCount !== expectedEntries || !safeObject(payloadValue))
					return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
				if (numberField(payloadValue, "entryCount") !== entryCount)
					return grammarFailure("BOUNDS_ENTRIES", tracked, trackedCount);
				if (dirCount !== expectedDirCount || numberField(payloadValue, "dirCount") !== dirCount)
					return grammarFailure("BOUNDS_DIRS", tracked, trackedCount);
				const planDigest = exactByteField(payloadValue, "planDigest", 32);
				if (declaredAggregate === undefined || planDigest === undefined || typedLength(planDigest) !== 32)
					return grammarFailure("INPUT_INVALID", tracked, trackedCount);
				tracked[trackedCount] = planDigest;
				trackedCount += 1;
				const aggregate = aggregateDigest(entryDigests, entryCount);
				tracked[trackedCount] = aggregate;
				trackedCount += 1;
				if (!byteEqual(aggregate, declaredAggregate))
					return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
				const expectedPlan = domainHash(domainPlan(), [aggregate], 1);
				tracked[trackedCount] = expectedPlan;
				trackedCount += 1;
				if (!byteEqual(expectedPlan, planDigest)) return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
				let total = 0;
				for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1)
					if (entryKinds[entryIndex] !== 1) total += entryPostSizes[entryIndex];
				if (total !== expectedTotalBytes) return grammarFailure("BOUNDS_PAYLOAD", tracked, trackedCount);
				sealedDigest = planDigest;
				phase = 1;
				continue;
			}
			return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
		}

		if (phase === 1 && tag === 0x05) {
			while (stageIndex < entryCount && entryKinds[stageIndex] === 1) stageIndex += 1;
			if (stageIndex >= entryCount || !safeObject(payloadValue))
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			const pathSha = exactByteField(payloadValue, "pathSha", 32);
			if (pathSha === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = pathSha;
			trackedCount += 1;
			const fileDigest = exactByteField(payloadValue, "fileDigest", 32);
			if (fileDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = fileDigest;
			trackedCount += 1;
			const expectedPathSha = sha256(entryPaths[stageIndex]);
			tracked[trackedCount] = expectedPathSha;
			trackedCount += 1;
			if (
				!byteEqual(pathSha, expectedPathSha) ||
				!byteEqual(fileDigest, entryPostDigests[stageIndex]) ||
				numberField(payloadValue, "fileSize") !== entryPostSizes[stageIndex]
			)
				return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			stageIndex += 1;
			continue;
		}
		if (phase === 1) {
			while (stageIndex < entryCount && entryKinds[stageIndex] === 1) stageIndex += 1;
			if (stageIndex !== entryCount) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			phase = 2;
		}
		if (phase === 2 && tag === 0x06) {
			while (backupIndex < entryCount && entryKinds[backupIndex] === 0) backupIndex += 1;
			if (backupIndex >= entryCount || !safeObject(payloadValue))
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			const pathSha = exactByteField(payloadValue, "pathSha", 32);
			if (pathSha === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = pathSha;
			trackedCount += 1;
			const fileDigest = exactByteField(payloadValue, "fileDigest", 32);
			if (fileDigest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = fileDigest;
			trackedCount += 1;
			const expectedPathSha = sha256(entryPaths[backupIndex]);
			tracked[trackedCount] = expectedPathSha;
			trackedCount += 1;
			if (
				!byteEqual(pathSha, expectedPathSha) ||
				!byteEqual(fileDigest, entryPreDigests[backupIndex]) ||
				numberField(payloadValue, "fileSize") !== entryPreSizes[backupIndex]
			)
				return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			backupIndex += 1;
			continue;
		}
		if (phase === 2) {
			while (backupIndex < entryCount && entryKinds[backupIndex] === 0) backupIndex += 1;
			if (backupIndex !== entryCount) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			phase = 3;
		}
		if (phase === 3 && tag === 0x07) {
			if (prepareIndex >= dirCount || !safeObject(payloadValue))
				return grammarFailure("BOUNDS_DIRS", tracked, trackedCount);
			const pathRead = pathField(payloadValue, "path");
			if (!pathRead.ok) return grammarFailure(pathRead.code, tracked, trackedCount);
			const path = pathRead.value;
			tracked[trackedCount] = path;
			trackedCount += 1;
			if (payloadLen !== variablePayloadLength(tag, path))
				return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			const validated = numberField(payloadValue, "validated");
			if (!byteEqual(path, dirPaths[prepareIndex]) || (validated !== 0 && validated !== 1))
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			prepareIndex += 1;
			continue;
		}
		if (phase === 3 && tag === 0x08) {
			if (prepareIndex !== dirCount) return grammarFailure("BOUNDS_DIRS", tracked, trackedCount);
			if (!safeObject(payloadValue) && typeof payloadValue !== "object")
				return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			const copied = exactByteValue(payloadValue, 32);
			if (copied === undefined || sealedDigest === undefined)
				return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = copied;
			trackedCount += 1;
			if (!byteEqual(copied, sealedDigest)) return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			sawPrepare = true;
			phase = 4;
			continue;
		}
		if (phase === 4 && tag === 0x09) {
			if (!sawPrepare || sealedDigest === undefined) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			const copied = exactByteValue(payloadValue, 32);
			if (copied === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = copied;
			trackedCount += 1;
			if (!byteEqual(copied, sealedDigest)) return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			sawCommit = true;
			phase = 5;
			continue;
		}
		if (phase === 5 && tag === 0x0a) {
			if (!sawCommit || appliedDirIndex >= dirCount || !safeObject(payloadValue))
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			const pathRead = pathField(payloadValue, "path");
			if (!pathRead.ok) return grammarFailure(pathRead.code, tracked, trackedCount);
			const path = pathRead.value;
			tracked[trackedCount] = path;
			trackedCount += 1;
			if (payloadLen !== variablePayloadLength(tag, path))
				return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			const created = numberField(payloadValue, "wasCreated");
			if (!byteEqual(path, dirPaths[appliedDirIndex]) || (created !== 0 && created !== 1))
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			appliedDirIndex += 1;
			continue;
		}
		if (phase === 5) {
			if (tag === 0x0b && appliedDirIndex !== dirCount) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			phase = 6;
		}
		if (phase === 6 && tag === 0x0b) {
			if (appliedEntryIndex >= entryCount || !safeObject(payloadValue))
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			const digest = exactByteField(payloadValue, "planEntryDigest", 32);
			if (digest === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = digest;
			trackedCount += 1;
			const postState = numberField(payloadValue, "postState");
			if (numberField(payloadValue, "entryIndex") !== appliedEntryIndex)
				return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
			if (!byteEqual(digest, entryDigests[appliedEntryIndex]))
				return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			if (postState !== entryKinds[appliedEntryIndex] + 1)
				return grammarFailure("PAYLOAD_INVALID", tracked, trackedCount);
			appliedEntryIndex += 1;
			continue;
		}
		if (phase === 6) {
			if (tag === 0x0c && appliedEntryIndex !== entryCount)
				return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			phase = 7;
		}
		if (phase === 7 && tag === 0x0c) {
			if (sealedDigest === undefined) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			const copied = exactByteValue(payloadValue, 32);
			if (copied === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = copied;
			trackedCount += 1;
			if (!byteEqual(copied, sealedDigest)) return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			sawVerify = true;
			phase = 8;
			continue;
		}
		if (phase === 8 && tag === 0x0d) {
			if (!sawVerify || sealedDigest === undefined) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
			const copied = exactByteValue(payloadValue, 32);
			if (copied === undefined) return grammarFailure("INPUT_INVALID", tracked, trackedCount);
			tracked[trackedCount] = copied;
			trackedCount += 1;
			if (!byteEqual(copied, sealedDigest)) return grammarFailure("DIGEST_MISMATCH", tracked, trackedCount);
			phase = 9;
			continue;
		}
		return grammarFailure("SEGMENT_ORDER", tracked, trackedCount);
	}
	if (!sawHeader || phase === 0) return grammarFailure("SEGMENT_GAP", tracked, trackedCount);
	zeroTracked(tracked, trackedCount);
	return frozen({ ok: true });
}

export function computeTxDigest(body: unknown): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	const copied = copySandboxStrictBytes(body, MAX_RECORD_BYTES);
	if (!copied.ok) return failure(copied.code);
	const size = new Bytes(4);
	writeU32(size, 0, typedLength(copied.value));
	const digest = domainHash(domainTx(), [size, copied.value], 2);
	zero(size);
	zero(copied.value);
	return frozen({ ok: true, digest });
}

export function computePlanEntryDigest(
	kind: unknown,
	path: unknown,
	preDigest: unknown,
	preSize: unknown,
	preMode: unknown,
	postDigest: unknown,
	postSize: unknown,
	postMode: unknown,
): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	if (typeof kind !== "number" || !safeInteger(kind) || kind < 0 || kind > 255) return failure("INPUT_INVALID");
	if (typeof preSize !== "number" || !safeInteger(preSize) || preSize < 0 || preSize > 0xffffffff)
		return failure("INPUT_INVALID");
	if (typeof postSize !== "number" || !safeInteger(postSize) || postSize < 0 || postSize > 0xffffffff)
		return failure("INPUT_INVALID");
	if (typeof preMode !== "number" || !safeInteger(preMode) || preMode < 0 || preMode > 0xffff)
		return failure("INPUT_INVALID");
	if (typeof postMode !== "number" || !safeInteger(postMode) || postMode < 0 || postMode > 0xffff)
		return failure("INPUT_INVALID");
	const pathCopy = copySandboxStrictBytes(path, MAX_PATH_BYTES);
	if (!pathCopy.ok) return failure(pathCopy.code);
	const preCopy = copySandboxStrictBytes(preDigest, 32);
	if (!preCopy.ok) {
		zero(pathCopy.value);
		return failure(preCopy.code);
	}
	const postCopy = copySandboxStrictBytes(postDigest, 32);
	if (!postCopy.ok) {
		zero(pathCopy.value);
		zero(preCopy.value);
		return failure(postCopy.code);
	}
	if (typedLength(preCopy.value) !== 32 || typedLength(postCopy.value) !== 32) {
		zero(pathCopy.value);
		zero(preCopy.value);
		zero(postCopy.value);
		return failure("INPUT_INVALID");
	}
	const digest = entryDigestFromFields(
		kind,
		pathCopy.value,
		preCopy.value,
		preSize,
		preMode,
		postCopy.value,
		postSize,
		postMode,
	);
	zero(pathCopy.value);
	zero(preCopy.value);
	zero(postCopy.value);
	return frozen({ ok: true, digest });
}

export function computeEntryAggregateDigest(
	digests: unknown,
): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	if (!safeArray(digests)) return failure("INPUT_INVALID");
	const count = arrayLength(digests);
	if (count === 0 || count > MAX_PLAN_ENTRIES) return failure("BOUNDS_ENTRIES");
	const parts = new ArrayValue<Uint8Array>(count);
	let copiedCount = 0;
	for (let index = 0; index < count; index += 1) {
		const read = ownRead(digests, makeString(index));
		if (!read.ok) {
			zeroTracked(parts, copiedCount);
			return failure("INPUT_INVALID");
		}
		const copied = copySandboxStrictBytes(read.value, 32);
		if (!copied.ok) {
			zeroTracked(parts, copiedCount);
			return failure(copied.code);
		}
		if (typedLength(copied.value) !== 32) {
			zero(copied.value);
			zeroTracked(parts, copiedCount);
			return failure("INPUT_INVALID");
		}
		parts[index] = copied.value;
		copiedCount += 1;
	}
	const digest = aggregateDigest(parts, count);
	zeroTracked(parts, copiedCount);
	return frozen({ ok: true, digest });
}

export function computePlanDigest(
	entryAggregateDigest: unknown,
): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	const copied = copySandboxStrictBytes(entryAggregateDigest, 32);
	if (!copied.ok) return failure(copied.code);
	if (typedLength(copied.value) !== 32) {
		zero(copied.value);
		return failure("INPUT_INVALID");
	}
	const digest = domainHash(domainPlan(), [copied.value], 1);
	zero(copied.value);
	return frozen({ ok: true, digest });
}

export function computeVectorCommitment(
	digests: unknown,
): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	if (!safeArray(digests)) return failure("INPUT_INVALID");
	const count = arrayLength(digests);
	if (count === 0 || count > MAX_CHAIN_COUNT + 1) return failure("BOUNDS_PAYLOAD");
	const parts = new ArrayValue<Uint8Array>(count + 1);
	const size = new Bytes(4);
	writeU32(size, 0, count);
	parts[0] = size;
	let copiedCount = 1;
	for (let index = 0; index < count; index += 1) {
		const read = ownRead(digests, makeString(index));
		if (!read.ok) {
			zeroTracked(parts, copiedCount);
			return failure("INPUT_INVALID");
		}
		const copied = copySandboxStrictBytes(read.value, 32);
		if (!copied.ok) {
			zeroTracked(parts, copiedCount);
			return failure(copied.code);
		}
		if (typedLength(copied.value) !== 32) {
			zero(copied.value);
			zeroTracked(parts, copiedCount);
			return failure("INPUT_INVALID");
		}
		parts[index + 1] = copied.value;
		copiedCount += 1;
	}
	const digest = domainHash(domainVector(), parts, count + 1);
	zeroTracked(parts, copiedCount);
	return frozen({ ok: true, digest });
}

export function computeTerminalRecordDigest(
	recordBytes: unknown,
): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	const copied = copySandboxStrictBytes(recordBytes, MAX_RECORD_BYTES);
	if (!copied.ok) return failure(copied.code);
	const digest = sha256(copied.value);
	zero(copied.value);
	return frozen({ ok: true, digest });
}

export function computeAbsencePostimage(path: unknown): { readonly ok: true; readonly digest: Uint8Array } | ResultErr {
	const copied = copySandboxStrictBytes(path, MAX_PATH_BYTES);
	if (!copied.ok) return failure(copied.code);
	const size = new Bytes(2);
	writeU16(size, 0, typedLength(copied.value));
	const digest = domainHash(domainAbsent(), [size, copied.value], 2);
	zero(size);
	zero(copied.value);
	return frozen({ ok: true, digest });
}
