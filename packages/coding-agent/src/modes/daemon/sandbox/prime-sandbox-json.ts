import { types } from "node:util";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DEPTH = 8;
const MAX_OBJECT_KEYS = 64;
const MAX_ARRAY_ITEMS = 256;
const MAX_NODES = 512;
const MAX_STRING_BYTES = 768 * 1024;

export type BoundedJsonResult =
	| Readonly<{ ok: true; value: unknown }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" | "BODY_TOO_LARGE" | "INVALID_JSON" }>;

interface ScanState {
	readonly text: string;
	index: number;
	depth: number;
	nodes: number;
}

function failed(code: "INPUT_INVALID" | "BODY_TOO_LARGE" | "INVALID_JSON"): BoundedJsonResult {
	return Object.freeze({ ok: false, code });
}

function copyInput(
	value: Uint8Array,
): Readonly<{ ok: true; value: Uint8Array<ArrayBuffer> }> | Readonly<{ ok: false; tooLarge: boolean }> {
	try {
		if (types.isProxy(value)) return Object.freeze({ ok: false, tooLarge: false });
		if (Object.getPrototypeOf(value) !== Uint8Array.prototype) return Object.freeze({ ok: false, tooLarge: false });
		if (Object.hasOwn(value, "buffer") || Object.hasOwn(value, "byteOffset") || Object.hasOwn(value, "byteLength")) {
			return Object.freeze({ ok: false, tooLarge: false });
		}
		const buffer = value.buffer;
		if (Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) return Object.freeze({ ok: false, tooLarge: false });
		const offset = value.byteOffset;
		const length = value.byteLength;
		if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
			return Object.freeze({ ok: false, tooLarge: false });
		}
		if (length > MAX_BODY_BYTES) return Object.freeze({ ok: false, tooLarge: true });
		const source = new Uint8Array(buffer, offset, length);
		const copy = new Uint8Array(new ArrayBuffer(length));
		copy.set(source);
		return Object.freeze({ ok: true, value: copy });
	} catch {
		return Object.freeze({ ok: false, tooLarge: false });
	}
}

function utf8Size(value: string): number | undefined {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const unit = value.charCodeAt(index);
		if (unit <= 0x7f) bytes += 1;
		else if (unit <= 0x7ff) bytes += 2;
		else if (unit >= 0xd800 && unit <= 0xdbff) {
			if (index + 1 >= value.length) return undefined;
			const next = value.charCodeAt(index + 1);
			if (next < 0xdc00 || next > 0xdfff) return undefined;
			bytes += 4;
			index += 1;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return undefined;
		else bytes += 3;
		if (bytes > MAX_STRING_BYTES) return undefined;
	}
	return bytes;
}

function skipWhitespace(state: ScanState): void {
	while (state.index < state.text.length) {
		const unit = state.text.charCodeAt(state.index);
		if (unit !== 0x20 && unit !== 0x09 && unit !== 0x0a && unit !== 0x0d) return;
		state.index += 1;
	}
}

function scanString(state: ScanState): string | undefined {
	const start = state.index;
	if (state.text.charCodeAt(start) !== 0x22) return undefined;
	let escaped = false;
	state.index += 1;
	while (state.index < state.text.length) {
		const unit = state.text.charCodeAt(state.index);
		if (!escaped && unit === 0x22) {
			state.index += 1;
			const token = state.text.slice(start, state.index);
			let decoded: unknown;
			try {
				decoded = JSON.parse(token);
			} catch {
				return undefined;
			}
			if (typeof decoded !== "string" || utf8Size(decoded) === undefined) return undefined;
			return decoded;
		}
		if (!escaped && unit <= 0x1f) return undefined;
		if (escaped) escaped = false;
		else if (unit === 0x5c) escaped = true;
		state.index += 1;
	}
	return undefined;
}

function scanNumber(state: ScanState): boolean {
	let index = state.index;
	const end = state.text.length;
	if (state.text.charCodeAt(index) === 0x2d) {
		index += 1;
		if (index >= end) return false;
	}
	if (state.text.charCodeAt(index) === 0x30) {
		index += 1;
		if (index < end) {
			const next = state.text.charCodeAt(index);
			if (next >= 0x30 && next <= 0x39) return false;
		}
	} else {
		const first = state.text.charCodeAt(index);
		if (first < 0x31 || first > 0x39) return false;
		index += 1;
		while (index < end) {
			const unit = state.text.charCodeAt(index);
			if (unit < 0x30 || unit > 0x39) break;
			index += 1;
		}
	}
	if (index < end && state.text.charCodeAt(index) === 0x2e) {
		index += 1;
		if (index >= end) return false;
		const first = state.text.charCodeAt(index);
		if (first < 0x30 || first > 0x39) return false;
		while (index < end) {
			const unit = state.text.charCodeAt(index);
			if (unit < 0x30 || unit > 0x39) break;
			index += 1;
		}
	}
	if (index < end) {
		const exponent = state.text.charCodeAt(index);
		if (exponent === 0x45 || exponent === 0x65) {
			index += 1;
			if (index < end) {
				const sign = state.text.charCodeAt(index);
				if (sign === 0x2b || sign === 0x2d) index += 1;
			}
			if (index >= end) return false;
			const first = state.text.charCodeAt(index);
			if (first < 0x30 || first > 0x39) return false;
			while (index < end) {
				const unit = state.text.charCodeAt(index);
				if (unit < 0x30 || unit > 0x39) break;
				index += 1;
			}
		}
	}
	state.index = index;
	return true;
}

function consumeLiteral(state: ScanState, literal: string): boolean {
	if (state.text.slice(state.index, state.index + literal.length) !== literal) return false;
	state.index += literal.length;
	return true;
}

function scanValue(state: ScanState): boolean {
	skipWhitespace(state);
	if (state.index >= state.text.length || state.nodes >= MAX_NODES) return false;
	state.nodes += 1;
	const unit = state.text.charCodeAt(state.index);
	if (unit === 0x22) return scanString(state) !== undefined;
	if (unit === 0x7b) return scanObject(state);
	if (unit === 0x5b) return scanArray(state);
	if (unit === 0x74) return consumeLiteral(state, "true");
	if (unit === 0x66) return consumeLiteral(state, "false");
	if (unit === 0x6e) return consumeLiteral(state, "null");
	if (unit === 0x2d || (unit >= 0x30 && unit <= 0x39)) return scanNumber(state);
	return false;
}

function scanObject(state: ScanState): boolean {
	if (state.depth >= MAX_DEPTH) return false;
	state.depth += 1;
	state.index += 1;
	skipWhitespace(state);
	const keys = new Set<string>();
	let count = 0;
	if (state.text.charCodeAt(state.index) === 0x7d) {
		state.index += 1;
		state.depth -= 1;
		return true;
	}
	while (state.index < state.text.length) {
		if (count >= MAX_OBJECT_KEYS) return false;
		const key = scanString(state);
		if (key === undefined || key === "__proto__" || key === "prototype" || key === "constructor") return false;
		if (keys.has(key)) return false;
		keys.add(key);
		count += 1;
		skipWhitespace(state);
		if (state.text.charCodeAt(state.index) !== 0x3a) return false;
		state.index += 1;
		if (!scanValue(state)) return false;
		skipWhitespace(state);
		const separator = state.text.charCodeAt(state.index);
		if (separator === 0x7d) {
			state.index += 1;
			state.depth -= 1;
			return true;
		}
		if (separator !== 0x2c) return false;
		state.index += 1;
		skipWhitespace(state);
	}
	return false;
}

function scanArray(state: ScanState): boolean {
	if (state.depth >= MAX_DEPTH) return false;
	state.depth += 1;
	state.index += 1;
	skipWhitespace(state);
	let count = 0;
	if (state.text.charCodeAt(state.index) === 0x5d) {
		state.index += 1;
		state.depth -= 1;
		return true;
	}
	while (state.index < state.text.length) {
		if (count >= MAX_ARRAY_ITEMS || !scanValue(state)) return false;
		count += 1;
		skipWhitespace(state);
		const separator = state.text.charCodeAt(state.index);
		if (separator === 0x5d) {
			state.index += 1;
			state.depth -= 1;
			return true;
		}
		if (separator !== 0x2c) return false;
		state.index += 1;
		skipWhitespace(state);
	}
	return false;
}

function deepFreeze(value: unknown, depth: number): boolean {
	if (typeof value === "number") return Number.isFinite(value);
	if (value === null || typeof value !== "object") return true;
	if (depth > MAX_DEPTH) return false;
	let keys: readonly string[];
	try {
		const prototype = Object.getPrototypeOf(value);
		const array = Array.isArray(value);
		if (array) {
			if (prototype !== Array.prototype || value.length > MAX_ARRAY_ITEMS) return false;
		} else if (prototype !== Object.prototype) return false;
		keys = Object.keys(value);
		if (keys.length > (array ? MAX_ARRAY_ITEMS : MAX_OBJECT_KEYS)) return false;
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
			if (!deepFreeze(descriptor.value, depth + 1)) return false;
		}
		Object.freeze(value);
		return true;
	} catch {
		return false;
	}
}

export function parseBoundedJson(value: Uint8Array): BoundedJsonResult {
	const copied = copyInput(value);
	if (!copied.ok) return failed(copied.tooLarge ? "BODY_TOO_LARGE" : "INPUT_INVALID");
	const bytes = copied.value;
	if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return failed("INVALID_JSON");
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return failed("INVALID_JSON");
	}
	const state: ScanState = { text, index: 0, depth: 0, nodes: 0 };
	if (!scanValue(state)) return failed("INVALID_JSON");
	skipWhitespace(state);
	if (state.index !== text.length || state.depth !== 0) return failed("INVALID_JSON");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return failed("INVALID_JSON");
	}
	if (!deepFreeze(parsed, 0)) return failed("INVALID_JSON");
	return Object.freeze({ ok: true, value: parsed });
}
