import { types } from "node:util";

export function copyBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
	copy.set(value);
	return copy;
}

export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	let difference = 0;
	for (let index = 0; index < left.byteLength; index += 1) difference |= left[index] ^ right[index];
	return difference === 0;
}

export function isExactAbortSignal(value: unknown): value is AbortSignal {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === AbortSignal.prototype &&
			!Object.hasOwn(value, "aborted") &&
			!Object.hasOwn(value, "addEventListener") &&
			!Object.hasOwn(value, "removeEventListener")
		);
	} catch {
		return false;
	}
}

export function isExactUint8Array(value: unknown): value is Uint8Array {
	try {
		return (
			typeof value === "object" &&
			value !== null &&
			!types.isProxy(value) &&
			Object.getPrototypeOf(value) === Uint8Array.prototype &&
			!Object.hasOwn(value, "buffer") &&
			!Object.hasOwn(value, "byteOffset") &&
			!Object.hasOwn(value, "byteLength")
		);
	} catch {
		return false;
	}
}

export function readAbortState(value: unknown): boolean | undefined {
	if (value === undefined) return false;
	try {
		return isExactAbortSignal(value) ? value.aborted : undefined;
	} catch {
		return undefined;
	}
}
