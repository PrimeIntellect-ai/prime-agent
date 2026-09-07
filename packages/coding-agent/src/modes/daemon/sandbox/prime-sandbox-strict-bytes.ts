import { types } from "node:util";

const reflectApply = Reflect.apply;
const objectConstructor = Object;
const getPrototypeOf = objectConstructor.getPrototypeOf;
const getOwnPropertyDescriptor = objectConstructor.getOwnPropertyDescriptor;
const getOwnPropertyNames = objectConstructor.getOwnPropertyNames;
const getOwnPropertySymbols = objectConstructor.getOwnPropertySymbols;
const freeze = objectConstructor.freeze;
const freezeObject: (value: object) => object = freeze;
const numberConstructor = Number;
const numberIsSafeInteger = numberConstructor.isSafeInteger;
const numberIsInteger = numberConstructor.isInteger;
const stringConstructor = String;
const uint8ArrayConstructor = Uint8Array;
const uint8ArrayPrototype = uint8ArrayConstructor.prototype;
const arrayBufferConstructor = ArrayBuffer;
const arrayBufferPrototype = arrayBufferConstructor.prototype;
const typedArrayPrototype = reflectApply(getPrototypeOf, objectConstructor, [uint8ArrayPrototype]);
const utilTypes = types;
const utilTypesIsProxy = utilTypes.isProxy;
const inspectionFailed = reflectApply(freezeObject, objectConstructor, [{}]);
const maximumStrictByteLength = 1_048_576;

type CapturedGetter = (target: unknown) => unknown;

function captureGetter(prototype: object, name: string): CapturedGetter | undefined {
	const descriptor = reflectApply(getOwnPropertyDescriptor, objectConstructor, [prototype, name]);
	if (descriptor === undefined) return undefined;
	const getter: unknown = descriptor.get;
	if (typeof getter !== "function") return undefined;
	return (target: unknown): unknown => reflectApply(getter, target, []);
}

function captureTypedArrayZeroer(prototype: object): CapturedGetter | undefined {
	const descriptor = reflectApply(getOwnPropertyDescriptor, objectConstructor, [prototype, "fill"]);
	if (descriptor === undefined) return undefined;
	const method: unknown = descriptor.value;
	if (typeof method !== "function") return undefined;
	return (target: unknown): unknown => reflectApply(method, target, [0]);
}

const getTypedArrayBuffer = captureGetter(typedArrayPrototype, "buffer");
const getTypedArrayByteOffset = captureGetter(typedArrayPrototype, "byteOffset");
const getTypedArrayByteLength = captureGetter(typedArrayPrototype, "byteLength");
const getTypedArrayLength = captureGetter(typedArrayPrototype, "length");
const getArrayBufferByteLength = captureGetter(arrayBufferPrototype, "byteLength");
const getArrayBufferDetached = captureGetter(arrayBufferPrototype, "detached");
const getArrayBufferResizable = captureGetter(arrayBufferPrototype, "resizable");
const zeroTypedArray = captureTypedArrayZeroer(typedArrayPrototype);

export type SandboxStrictByteCopyCode = "INPUT_INVALID" | "INPUT_TOO_LARGE";

export interface SandboxStrictByteCopySuccess {
	readonly ok: true;
	readonly value: Uint8Array;
}

export interface SandboxStrictByteCopyFailure {
	readonly ok: false;
	readonly code: SandboxStrictByteCopyCode;
}

export type SandboxStrictByteCopyResult = SandboxStrictByteCopySuccess | SandboxStrictByteCopyFailure;

const freezeFailure: (value: SandboxStrictByteCopyFailure) => SandboxStrictByteCopyFailure = freeze;
const freezeSuccess: (value: SandboxStrictByteCopySuccess) => SandboxStrictByteCopySuccess = freeze;
const invalidResult = reflectApply(freezeFailure, objectConstructor, [{ ok: false, code: "INPUT_INVALID" }]);
const tooLargeResult = reflectApply(freezeFailure, objectConstructor, [{ ok: false, code: "INPUT_TOO_LARGE" }]);

function proxyOrInspectionFailure(value: object): boolean {
	try {
		return reflectApply(utilTypesIsProxy, utilTypes, [value]);
	} catch {
		return true;
	}
}

function inspectPrototype(value: object): object | null {
	try {
		return reflectApply(getPrototypeOf, objectConstructor, [value]);
	} catch {
		return inspectionFailed;
	}
}

function inspectNames(value: object): readonly string[] | undefined {
	try {
		return reflectApply(getOwnPropertyNames, objectConstructor, [value]);
	} catch {
		return undefined;
	}
}

function inspectSymbols(value: object): readonly symbol[] | undefined {
	try {
		return reflectApply(getOwnPropertySymbols, objectConstructor, [value]);
	} catch {
		return undefined;
	}
}

function callCaptured(getter: CapturedGetter | undefined, target: object): unknown {
	if (getter === undefined) return inspectionFailed;
	try {
		return getter(target);
	} catch {
		return inspectionFailed;
	}
}

function discardOwnedCopy(copy: Uint8Array): SandboxStrictByteCopyFailure {
	if (zeroTypedArray === undefined) return invalidResult;
	try {
		zeroTypedArray(copy);
	} catch {
		return invalidResult;
	}
	return invalidResult;
}

function isSafeLength(value: unknown): value is number {
	return typeof value === "number" && reflectApply(numberIsSafeInteger, numberConstructor, [value]) && value >= 0;
}

function makeSuccess(value: Uint8Array): SandboxStrictByteCopySuccess {
	return reflectApply(freezeSuccess, objectConstructor, [{ ok: true, value }]);
}

export function copySandboxStrictBytes(input: unknown, maxBytes: number): SandboxStrictByteCopyResult {
	if (
		!reflectApply(numberIsSafeInteger, numberConstructor, [maxBytes]) ||
		maxBytes < 0 ||
		maxBytes > maximumStrictByteLength
	)
		return invalidResult;
	if (typeof input !== "object" || input === null) return invalidResult;
	if (proxyOrInspectionFailure(input)) return invalidResult;
	if (inspectPrototype(input) !== uint8ArrayPrototype) return invalidResult;

	const lengthValue = callCaptured(getTypedArrayLength, input);
	const byteLengthValue = callCaptured(getTypedArrayByteLength, input);
	const byteOffsetValue = callCaptured(getTypedArrayByteOffset, input);
	const bufferValue = callCaptured(getTypedArrayBuffer, input);
	if (!isSafeLength(lengthValue) || !isSafeLength(byteLengthValue) || !isSafeLength(byteOffsetValue)) {
		return invalidResult;
	}
	if (lengthValue !== byteLengthValue || byteOffsetValue !== 0) return invalidResult;
	if (byteLengthValue > maxBytes) return tooLargeResult;
	if (typeof bufferValue !== "object" || bufferValue === null) return invalidResult;
	if (proxyOrInspectionFailure(bufferValue)) return invalidResult;
	if (inspectPrototype(bufferValue) !== arrayBufferPrototype) return invalidResult;

	const bufferNames = inspectNames(bufferValue);
	const bufferSymbols = inspectSymbols(bufferValue);
	if (bufferNames === undefined || bufferSymbols === undefined) return invalidResult;
	if (bufferNames.length !== 0 || bufferSymbols.length !== 0) return invalidResult;

	const bufferLengthValue = callCaptured(getArrayBufferByteLength, bufferValue);
	const detachedValue = callCaptured(getArrayBufferDetached, bufferValue);
	const resizableValue = callCaptured(getArrayBufferResizable, bufferValue);
	if (!isSafeLength(bufferLengthValue)) return invalidResult;
	if (detachedValue !== false || resizableValue !== false) return invalidResult;
	if (bufferLengthValue !== byteLengthValue) return invalidResult;

	const ownNames = inspectNames(input);
	const ownSymbols = inspectSymbols(input);
	if (ownNames === undefined || ownSymbols === undefined) return invalidResult;
	if (ownSymbols.length !== 0 || ownNames.length !== lengthValue) return invalidResult;

	if (zeroTypedArray === undefined) return invalidResult;
	const copy = new uint8ArrayConstructor(lengthValue);
	for (let index = 0; index < lengthValue; index += 1) {
		const name = reflectApply(stringConstructor, undefined, [index]);
		if (ownNames[index] !== name) return discardOwnedCopy(copy);
		let descriptor: PropertyDescriptor | undefined;
		try {
			descriptor = reflectApply(getOwnPropertyDescriptor, objectConstructor, [input, name]);
		} catch {
			return discardOwnedCopy(copy);
		}
		if (descriptor === undefined) return discardOwnedCopy(copy);
		if (descriptor.get !== undefined || descriptor.set !== undefined) return discardOwnedCopy(copy);
		if (descriptor.writable !== true || descriptor.enumerable !== true || descriptor.configurable !== true) {
			return discardOwnedCopy(copy);
		}
		const byte: unknown = descriptor.value;
		if (
			typeof byte !== "number" ||
			!reflectApply(numberIsInteger, numberConstructor, [byte]) ||
			byte < 0 ||
			byte > 255
		)
			return discardOwnedCopy(copy);
		copy[index] = byte;
	}

	return makeSuccess(copy);
}
