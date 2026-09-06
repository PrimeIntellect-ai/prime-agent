import * as types from "node:util/types";

// ---- Captured intrinsics (module initialization) ----

const { isProxy: isProxyRaw } = types;

const _getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertyNames = Object.getOwnPropertyNames;
const { getOwnPropertySymbols, freeze, defineProperty, getPrototypeOf } = Object;

const { isArray } = Array;
const { isFinite: numIsFinite, isInteger: numIsInteger } = Number;

const encoder = new TextEncoder();

// ---- Private helpers ----

/** Proxy check, fail-closed. Returns true for any proxy including revoked. */
function isProxyFailClosed(value: object): boolean {
	try {
		return isProxyRaw(value);
	} catch {
		return true;
	}
}

function utf8ByteCount(s: string): number {
	return encoder.encode(s).length;
}

/** Safe runtime type guard: is this value a non-null object? */
function isNonNullObject(x: unknown): x is object {
	return x !== null && typeof x === "object";
}

/**
 * Safe descriptor map capture.
 * Returns a fresh null-prototype-owned copy of the descriptor map so that
 * hostile own `__proto__` on the original does not invoke a setter.
 * Returns null on failure.
 */
function safeCaptureDescriptors(value: object): Record<string, PropertyDescriptor> | null {
	let raw: PropertyDescriptorMap;
	try {
		raw = _getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
	// Own a null-prototype copy so __proto__ never invokes a setter
	const out: Record<string, PropertyDescriptor> = Object.create(null);
	const names = _getOwnPropertyNames(raw);
	for (const n of names) {
		defineProperty(out, n, {
			value: raw[n],
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return out;
}

/** Create a frozen failure result. */
function fail(code: NormalizeErrorCode): NormalizeResult {
	return freeze({ ok: false, code });
}

/** Check whether a string contains unpaired surrogates. */
function hasUnpairedSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const cp = s.charCodeAt(i);
		if (cp >= 0xd800 && cp <= 0xdfff) {
			if (cp <= 0xdbff) {
				// High surrogate; must be followed by low surrogate
				if (i + 1 >= s.length) return true;
				const next = s.charCodeAt(i + 1);
				if (next < 0xdc00 || next > 0xdfff) return true;
				i++; // skip low surrogate
			} else {
				// Lone low surrogate
				return true;
			}
		}
	}
	return false;
}

// ---- Bounds ----

export const MAX_DEPTH = 32;
export const MAX_TOTAL_NODES = 1024;
export const MAX_STRING_UTF8_BYTES = 65536;
export const MAX_KEY_UTF8_BYTES = 512;
export const MAX_ARRAY_LENGTH = 256;
export const MAX_OBJECT_KEYS = 256;

// ---- Public types ----

export type NormalizedJson =
	| null
	| boolean
	| number
	| string
	| ReadonlyArray<NormalizedJson>
	| { readonly [key: string]: NormalizedJson };

export type NormalizeErrorCode =
	| "invalid_input"
	| "non_finite"
	| "proxy"
	| "invalid_prototype"
	| "depth"
	| "nodes"
	| "string_bytes"
	| "key_bytes"
	| "array_length"
	| "array_shape"
	| "object_keys"
	| "accessor"
	| "non_enumerable"
	| "own_symbol"
	| "tojson"
	| "cycle_or_alias"
	| "kind_mismatch"
	| "descriptor";

export type NormalizeOk = { readonly ok: true; readonly value: NormalizedJson };
export type NormalizeFail = { readonly ok: false; readonly code: NormalizeErrorCode };
export type NormalizeResult = NormalizeOk | NormalizeFail;

// ---- Slot types ----

interface RootBox {
	result: NormalizedJson | null;
}

type Slot =
	| { kind: "root"; box: RootBox; slot: null }
	| { kind: "array"; box: NormalizedJson[]; slot: number }
	| { kind: "object"; box: Record<string, NormalizedJson>; slot: string };

// ---- Frame types ----

interface DoneFrame {
	t: "done";
	value: NormalizedJson;
	to: Slot;
}

interface EnterFrame {
	t: "enter";
	value: unknown;
	depth: number;
	to: Slot;
}

type Frame = EnterFrame | DoneFrame;

// ---- Assign a completed value to its parent slot ----

function assign(to: Slot, value: NormalizedJson): void {
	if (to.kind === "root") {
		to.box.result = value;
	} else if (to.kind === "array") {
		to.box[to.slot] = value;
	} else {
		defineProperty(to.box, to.slot, {
			value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
}

// ---- Validate a captured dense-array descriptor map ----
// Returns null on success, or a NormalizeFail on rejection.

function checkArrayShape(descs: Record<string, PropertyDescriptor>, length: number): NormalizeResult | null {
	// Validate length descriptor
	const lengthDesc = descs.length;
	if (!lengthDesc) return fail("array_shape");
	if (typeof lengthDesc.get !== "undefined" || typeof lengthDesc.set !== "undefined") {
		return fail("array_shape");
	}
	if (typeof lengthDesc.value === "undefined") return fail("array_shape");
	if (lengthDesc.enumerable !== false || lengthDesc.configurable !== false) {
		return fail("array_shape");
	}

	// Validate length value
	const lenVal = lengthDesc.value;
	if (typeof lenVal !== "number" || !numIsFinite(lenVal) || !numIsInteger(lenVal) || lenVal < 0) {
		return fail("array_shape");
	}
	if (lenVal !== length) {
		// The length arg is from a prior first-pass; mismatch means corruption
		return fail("array_shape");
	}
	if (lenVal > MAX_ARRAY_LENGTH) {
		return fail("array_length");
	}

	// Validate each index
	let dataCount = 0;
	for (const name of _getOwnPropertyNames(descs)) {
		if (name === "length") continue;

		if (!/^\d+$/.test(name)) return fail("array_shape");
		const idx = Number(name);
		if (idx < 0 || idx >= lenVal || idx !== parseInt(name, 10)) return fail("array_shape");

		const desc = descs[name];
		if (!desc) return fail("descriptor");
		if (typeof desc.get !== "undefined" || typeof desc.set !== "undefined") return fail("accessor");
		if (typeof desc.value === "undefined") return fail("descriptor");
		if (desc.enumerable !== true) {
			return fail("array_shape");
		}
		dataCount++;
	}

	if (dataCount !== lenVal) return fail("array_shape");

	return null;
}

// ---- Validate a captured plain-object descriptor map ----

function checkObjectShape(descs: Record<string, PropertyDescriptor>): NormalizeResult | null {
	let kindSeen = false;
	let keyCount = 0;

	const names = _getOwnPropertyNames(descs);
	for (const name of names) {
		const desc = descs[name];
		if (!desc) return fail("descriptor");
		if (typeof desc.get !== "undefined" || typeof desc.set !== "undefined") return fail("accessor");
		if (typeof desc.value === "undefined") return fail("descriptor");

		if (name === "toJSON") return fail("tojson");

		if (name === "~kind") {
			if (desc.enumerable !== false || desc.writable !== true || desc.configurable !== true) {
				return fail("kind_mismatch");
			}
			if (desc.value !== "Object") return fail("kind_mismatch");
			if (kindSeen) return fail("kind_mismatch");
			kindSeen = true;
			continue;
		}

		if (!desc.enumerable) return fail("non_enumerable");
		keyCount++;
	}

	if (keyCount > MAX_OBJECT_KEYS) {
		return fail("object_keys");
	}

	return null;
}

// ---- Build sorted enumerable keys from descriptor map ----

function buildSortedKeys(descs: Record<string, PropertyDescriptor>): { keys: string[]; err: NormalizeResult | null } {
	const names = _getOwnPropertyNames(descs);
	const list: string[] = [];
	for (const name of names) {
		if (name === "~kind") continue;
		const d = descs[name];
		if (!d || !d.enumerable) continue;
		const keyBytes = utf8ByteCount(name);
		if (keyBytes > MAX_KEY_UTF8_BYTES) {
			return { keys: [], err: fail("key_bytes") };
		}
		list.push(name);
	}

	list.sort();
	return { keys: list, err: null };
}

// ---- Main entry point ----

export function normalize(input: unknown): NormalizeResult {
	const seen = new WeakMap<object, true>();
	let nodeCount = 0;

	const rootBox: RootBox = { result: null };
	const stack: Frame[] = [
		{
			t: "enter",
			value: input,
			depth: 0,
			to: { kind: "root", box: rootBox, slot: null },
		},
	];

	while (stack.length > 0) {
		const frame = stack[stack.length - 1];

		// ***** 1. Done frame: freeze then assign, pop *****
		if (frame.t === "done") {
			const val = frame.value;
			if (val !== null && typeof val === "object") {
				freeze(val);
			}
			assign(frame.to, val);
			stack.pop();
			continue;
		}

		// ***** 2. frame is now EnterFrame *****

		// ---- Primitives ----

		if (frame.value === null) {
			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return fail("nodes");
			assign(frame.to, null);
			stack.pop();
			continue;
		}

		if (typeof frame.value === "boolean") {
			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return fail("nodes");
			assign(frame.to, frame.value);
			stack.pop();
			continue;
		}

		if (typeof frame.value === "number") {
			if (!numIsFinite(frame.value) || Object.is(frame.value, -0)) {
				return fail("non_finite");
			}
			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return fail("nodes");
			assign(frame.to, frame.value);
			stack.pop();
			continue;
		}

		if (typeof frame.value === "string") {
			const sv = frame.value;
			const bytes = utf8ByteCount(sv);
			if (bytes > MAX_STRING_UTF8_BYTES) return fail("string_bytes");
			if (hasUnpairedSurrogate(sv)) return fail("string_bytes");
			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return fail("nodes");
			assign(frame.to, sv);
			stack.pop();
			continue;
		}

		// ---- Rejected typeof values ----
		if (
			typeof frame.value === "function" ||
			typeof frame.value === "bigint" ||
			typeof frame.value === "undefined" ||
			typeof frame.value === "symbol"
		) {
			return fail("invalid_input");
		}

		// ---- From here: typeof frame.value === 'object' && frame.value !== null ----
		if (!isNonNullObject(frame.value)) {
			return fail("invalid_input");
		}
		const obj: object = frame.value;

		// Proxy check – fail-closed
		if (isProxyFailClosed(obj)) return fail("proxy");

		// Depth
		if (frame.depth >= MAX_DEPTH) return fail("depth");

		// Cycle/alias
		if (seen.has(obj)) return fail("cycle_or_alias");

		// Symbol keys
		if (getOwnPropertySymbols(obj).length > 0) return fail("own_symbol");

		// ---- Capture descriptors ONCE ----
		const descs = safeCaptureDescriptors(obj);
		if (descs === null) return fail("descriptor");

		// ---- Dense array ----
		if (isArray(obj)) {
			const proto = getPrototypeOf(obj);
			if (proto !== Array.prototype) return fail("invalid_prototype");

			const lengthDesc = descs.length;
			if (!lengthDesc || typeof lengthDesc.value === "undefined") return fail("array_shape");
			const length = lengthDesc.value;
			if (typeof length !== "number" || !numIsFinite(length) || !numIsInteger(length) || length < 0) {
				return fail("array_shape");
			}

			const arrErr = checkArrayShape(descs, length);
			if (arrErr !== null) return arrErr;

			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return fail("nodes");
			seen.set(obj, true);

			const out: NormalizedJson[] = new Array(length);
			stack.pop();
			stack.push({ t: "done", value: out, to: frame.to });

			for (let i = length - 1; i >= 0; i--) {
				const key = String(i);
				const childDesc = descs[key];
				if (!childDesc || typeof childDesc.value === "undefined") return fail("descriptor");
				stack.push({
					t: "enter",
					value: childDesc.value,
					depth: frame.depth + 1,
					to: { kind: "array", box: out, slot: i },
				});
			}
			continue;
		}

		// ---- Plain object ----
		const proto = getPrototypeOf(obj);
		if (proto !== Object.prototype) return fail("invalid_prototype");

		const objErr = checkObjectShape(descs);
		if (objErr !== null) return objErr;

		const { keys: sortedKeys, err: keyErr } = buildSortedKeys(descs);
		if (keyErr !== null) return keyErr;

		nodeCount++;
		if (nodeCount > MAX_TOTAL_NODES) return fail("nodes");
		seen.set(obj, true);

		const out: Record<string, NormalizedJson> = {};

		stack.pop();
		stack.push({ t: "done", value: out, to: frame.to });

		for (let i = sortedKeys.length - 1; i >= 0; i--) {
			const key = sortedKeys[i];
			const childDesc = descs[key];
			if (!childDesc || typeof childDesc.value === "undefined") return fail("descriptor");
			stack.push({
				t: "enter",
				value: childDesc.value,
				depth: frame.depth + 1,
				to: { kind: "object", box: out, slot: key },
			});
		}
	}

	// ---- Stack exhausted ----
	const result = rootBox.result;
	if (result === null) {
		return freeze({ ok: true, value: null });
	}
	return freeze({ ok: true, value: result });
}
