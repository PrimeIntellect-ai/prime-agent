// ========================================================================
// Model V11 TypeBox Schema Normalizer (V3 Corrected)
// Architecture: iterative preflight engine → build plain JSON Schema tree
// → call accepted generic normalize exactly once.
// Root non-object values reject E_INVALID_INPUT.  Zero casts.
// ========================================================================

import * as types from "node:util/types";
import type { NormalizeResult as GenericResult, NormalizedJson } from "./prime-sandbox-model-normalize.js";
import { normalize as genericNormalize } from "./prime-sandbox-model-normalize.js";

// ---- Captured intrinsics ----

const { isProxy: _isProxy } = types;

const _getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols = Object.getOwnPropertySymbols;
const { defineProperty, getPrototypeOf } = Object;
const { isArray } = Array;
const _isFinite = Number.isFinite;

const _textEncoder = new TextEncoder();
const _encode = _textEncoder.encode.bind(_textEncoder);

const ObjectProto = Object.prototype;
const ArrayProto = Array.prototype;

// ---- Helpers ----

function _utf8Bytes(s: string): number {
	return _encode(s).length;
}

function _hasUnpairedSurrogate(s: string): boolean {
	for (let i = 0; i < s.length; i++) {
		const cp = s.charCodeAt(i);
		if (cp >= 0xd800 && cp <= 0xdfff) {
			if (cp <= 0xdbff) {
				if (i + 1 >= s.length) return true;
				const next = s.charCodeAt(i + 1);
				if (next < 0xdc00 || next > 0xdfff) return true;
				i++;
			} else {
				return true;
			}
		}
	}
	return false;
}

function _isObj(x: unknown): x is object {
	return x !== null && typeof x === "object";
}

function _isProxyClosed(value: object): boolean {
	try {
		return _isProxy(value);
	} catch {
		return true;
	}
}

function _in(list: readonly string[], name: string): boolean {
	for (let i = 0; i < list.length; i++) {
		if (list[i] === name) return true;
	}
	return false;
}

// ---- V3 §4.10 exact error union ----

export type V3ErrorCode =
	| "E_INVALID_INPUT"
	| "E_PROXY"
	| "E_INVALID_PROTOTYPE"
	| "E_OWN_SYMBOL"
	| "E_ACCESSOR"
	| "E_ENUMERABLE_KIND"
	| "E_NON_ENUMERABLE_NON_HIDDEN"
	| "E_UNKNOWN_HIDDEN_KEY"
	| "E_INVALID_HIDDEN_FLAG"
	| "E_INVALID_HIDDEN_CONTEXT"
	| "E_ROOT_NOT_OBJECT"
	| "E_UNSUPPORTED_KIND"
	| "E_REFINE"
	| "E_UNSAFE_UNSUPPORTED"
	| "E_REQUIRED_MISMATCH"
	| "E_MISSING_KEYWORD"
	| "E_UNKNOWN_ENUMERABLE_KEYWORD"
	| "E_DEPTH"
	| "E_NODES"
	| "E_CYCLE_OR_ALIAS"
	| "E_RECORD_KEY_TOO_LONG"
	| "E_NOT_A_SCHEMA";

export type NormalizeErrorCode = V3ErrorCode;

export interface NormalizeOk {
	readonly ok: true;
	readonly value: NormalizedJson;
}
export interface NormalizeFail {
	readonly ok: false;
	readonly code: V3ErrorCode;
}
export type NormalizeResult = NormalizeOk | NormalizeFail;

function okResult(value: NormalizedJson): NormalizeResult {
	const result: NormalizeOk = { ok: true, value };
	return result;
}

function failResult(code: V3ErrorCode): NormalizeResult {
	const result: NormalizeFail = { ok: false, code };
	return result;
}

// ---- Generic failure mapper ----

function mapGenericFail(code: string): V3ErrorCode {
	if (code === "proxy") return "E_PROXY";
	if (code === "invalid_prototype") return "E_INVALID_PROTOTYPE";
	if (code === "depth") return "E_DEPTH";
	if (code === "nodes") return "E_NODES";
	if (code === "own_symbol") return "E_OWN_SYMBOL";
	if (code === "cycle_or_alias") return "E_CYCLE_OR_ALIAS";
	if (code === "accessor") return "E_ACCESSOR";
	if (code === "non_finite" || code === "invalid_input") return "E_INVALID_INPUT";
	if (code === "non_enumerable") return "E_NON_ENUMERABLE_NON_HIDDEN";
	if (code === "string_bytes" || code === "key_bytes") return "E_RECORD_KEY_TOO_LONG";
	return "E_NOT_A_SCHEMA";
}

// ---- Constants ----

const MAX_DEPTH = 32;
const MAX_TOTAL_NODES = 1024;
const MAX_STRING_BYTES = 65536;

const RECOGNIZED_HIDDEN = ["~kind", "~optional", "~unsafe", "~readonly", "~refine"];
const SUPPORTED_KINDS = [
	"Object",
	"String",
	"Number",
	"Integer",
	"Boolean",
	"Array",
	"Union",
	"Literal",
	"Null",
	"Record",
];
const META_KEYS = ["description", "default", "examples", "title", "deprecated"];

function _allowSet(specific: readonly string[]): Set<string> {
	const s = new Set<string>();
	for (let i = 0; i < specific.length; i++) s.add(specific[i]);
	for (let i = 0; i < META_KEYS.length; i++) s.add(META_KEYS[i]);
	return s;
}

const KW_OBJECT = _allowSet([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"minProperties",
	"maxProperties",
	"unevaluatedProperties",
	"propertyNames",
]);
const KW_STRING = _allowSet(["type", "pattern", "format", "minLength", "maxLength"]);
const KW_NUMBER = _allowSet(["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const KW_INTEGER = _allowSet(["type", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const KW_BOOLEAN = _allowSet(["type"]);
const KW_ARRAY = _allowSet(["type", "items", "minItems", "maxItems", "uniqueItems"]);
const KW_UNION = _allowSet(["anyOf"]);
const KW_LITERAL = _allowSet(["type", "const"]);
const KW_NULL = _allowSet(["type"]);
const KW_RECORD = _allowSet([
	"type",
	"patternProperties",
	"minProperties",
	"maxProperties",
	"additionalProperties",
	"propertyNames",
]);

function _getAllow(kind: string): Set<string> | undefined {
	if (kind === "Object") return KW_OBJECT;
	if (kind === "String") return KW_STRING;
	if (kind === "Number") return KW_NUMBER;
	if (kind === "Integer") return KW_INTEGER;
	if (kind === "Boolean") return KW_BOOLEAN;
	if (kind === "Array") return KW_ARRAY;
	if (kind === "Union") return KW_UNION;
	if (kind === "Literal") return KW_LITERAL;
	if (kind === "Null") return KW_NULL;
	if (kind === "Record") return KW_RECORD;
	return undefined;
}

// ---- Safe descriptor capture ----

function _captureDescs(value: object): Record<string, PropertyDescriptor> | null {
	let raw: PropertyDescriptorMap;
	try {
		raw = _getOwnPropertyDescriptors(value);
	} catch {
		return null;
	}
	const out: Record<string, PropertyDescriptor> = Object.create(null);
	const names = _getOwnPropertyNames(raw);
	for (let i = 0; i < names.length; i++) {
		const n = names[i];
		defineProperty(out, n, {
			value: raw[n],
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
	return out;
}

// ---- Hidden preflight (V3 §4.2-4.5) ----

interface PreflightOk {
	ok: true;
	kind: string | null;
	hasOptional: boolean;
}
interface PreflightFail {
	ok: false;
	code: V3ErrorCode;
}
type PreflightResult = PreflightOk | PreflightFail;

function _preflight(descs: Record<string, PropertyDescriptor>): PreflightResult {
	const names = _getOwnPropertyNames(descs);
	let kind: string | null = null;
	let hasOptional = false;

	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		const d = descs[name];
		if (d === undefined) return { ok: false, code: "E_NOT_A_SCHEMA" };
		if (typeof d.get !== "undefined" || typeof d.set !== "undefined") return { ok: false, code: "E_ACCESSOR" };
		if (typeof d.value === "undefined") return { ok: false, code: "E_NOT_A_SCHEMA" };

		if (name.startsWith("~")) {
			if (!_in(RECOGNIZED_HIDDEN, name)) return { ok: false, code: "E_UNKNOWN_HIDDEN_KEY" };
			if (d.enumerable === true) return { ok: false, code: "E_ENUMERABLE_KIND" };
			if (d.writable !== true || d.configurable !== true || d.enumerable !== false) {
				return { ok: false, code: "E_INVALID_HIDDEN_FLAG" };
			}
			if (name === "~kind") {
				if (typeof d.value !== "string") return { ok: false, code: "E_INVALID_HIDDEN_FLAG" };
				kind = d.value;
			} else if (name === "~optional") {
				if (d.value !== true) return { ok: false, code: "E_INVALID_HIDDEN_FLAG" };
				hasOptional = true;
			} else if (name === "~readonly") {
				if (d.value !== true) return { ok: false, code: "E_INVALID_HIDDEN_FLAG" };
			} else if (name === "~unsafe") {
				if (d.value !== null) return { ok: false, code: "E_INVALID_HIDDEN_FLAG" };
			} else if (name === "~refine") {
				return { ok: false, code: "E_REFINE" };
			}
		} else if (!d.enumerable) {
			return { ok: false, code: "E_NON_ENUMERABLE_NON_HIDDEN" };
		}
	}
	return { ok: true, kind, hasOptional };
}

// ---- Validate StringEnum (V3 §4.9) ----

function _checkStringEnum(descs: Record<string, PropertyDescriptor>): V3ErrorCode | null {
	const td = descs.type;
	if (td === undefined || !td.enumerable || td.value !== "string") return "E_UNSAFE_UNSUPPORTED";
	const ed = descs.enum;
	if (ed === undefined || !ed.enumerable || !isArray(ed.value)) return "E_UNSAFE_UNSUPPORTED";
	const arr = ed.value;
	if (arr.length === 0) return "E_UNSAFE_UNSUPPORTED";
	for (let i = 0; i < arr.length; i++) {
		if (typeof arr[i] !== "string") return "E_UNSAFE_UNSUPPORTED";
	}
	return null;
}

// ---- Kind keyword requirement check (V3 §4.6) ----

function _checkReq(descs: Record<string, PropertyDescriptor>, kind: string): V3ErrorCode | null {
	let req: readonly string[];
	let typeVal: string | null = null;
	if (kind === "Object") {
		req = ["type", "properties"];
		typeVal = "object";
	} else if (kind === "String") {
		req = ["type"];
		typeVal = "string";
	} else if (kind === "Number") {
		req = ["type"];
		typeVal = "number";
	} else if (kind === "Integer") {
		req = ["type"];
		typeVal = "integer";
	} else if (kind === "Boolean") {
		req = ["type"];
		typeVal = "boolean";
	} else if (kind === "Array") {
		req = ["type", "items"];
		typeVal = "array";
	} else if (kind === "Union") {
		req = ["anyOf"];
		typeVal = null;
	} else if (kind === "Literal") {
		req = ["type", "const"];
		typeVal = null;
	} else if (kind === "Null") {
		req = ["type"];
		typeVal = "null";
	} else if (kind === "Record") {
		req = ["type", "patternProperties"];
		typeVal = "object";
	} else return "E_UNSUPPORTED_KIND";

	for (let i = 0; i < req.length; i++) {
		const k = req[i];
		const d = descs[k];
		if (d === undefined || !d.enumerable || typeof d.value === "undefined") return "E_MISSING_KEYWORD";
		if (k === "type" && typeVal !== null && d.value !== typeVal) return "E_MISSING_KEYWORD";
	}
	return null;
}

// ---- Required vs ~optional (V3 §4.7) ----

function _checkRequired(descs: Record<string, PropertyDescriptor>): V3ErrorCode | null {
	const rd = descs.required;
	if (rd === undefined) return null;
	if (!rd.enumerable) return "E_REQUIRED_MISMATCH";
	if (!isArray(rd.value)) return "E_REQUIRED_MISMATCH";
	const reqLen = rd.value.length;
	const reqStr: string[] = [];
	for (let i = 0; i < reqLen; i++) {
		if (typeof rd.value[i] !== "string") return "E_REQUIRED_MISMATCH";
		for (let j = 0; j < i; j++) {
			if (reqStr[j] === rd.value[i]) return "E_REQUIRED_MISMATCH";
		}
		reqStr.push(rd.value[i]);
	}

	const pd = descs.properties;
	if (pd === undefined) return null;
	if (!pd.enumerable) return "E_MISSING_KEYWORD";
	const pv = pd.value;
	if (!_isObj(pv)) return "E_MISSING_KEYWORD";

	const pDescs = _captureDescs(pv);
	if (pDescs === null) return "E_NOT_A_SCHEMA";
	const pNames = _getOwnPropertyNames(pDescs);

	const computed: string[] = [];
	for (let i = 0; i < pNames.length; i++) {
		const pn = pNames[i];
		const pDesc = pDescs[pn];
		if (pDesc === undefined) return "E_NOT_A_SCHEMA";
		if (typeof pDesc.get !== "undefined" || typeof pDesc.set !== "undefined") return "E_ACCESSOR";
		if (typeof pDesc.value === "undefined") return "E_NOT_A_SCHEMA";

		let optional = false;
		const pv2 = pDesc.value;
		if (_isObj(pv2)) {
			const pvDescs = _captureDescs(pv2);
			if (pvDescs !== null) {
				const od = pvDescs["~optional"];
				if (od !== undefined && od.value === true) optional = true;
			}
		}
		if (!optional) computed.push(pn);
	}

	if (reqLen !== computed.length) return "E_REQUIRED_MISMATCH";
	for (let i = 0; i < reqLen; i++) {
		if (reqStr[i] !== computed[i]) return "E_REQUIRED_MISMATCH";
	}
	return null;
}

// ---- Sorted enumerable keys (lexicographic) ----

function _sortedEnumKeys(descs: Record<string, PropertyDescriptor>): string[] | null {
	const names = _getOwnPropertyNames(descs);
	const list: string[] = [];
	for (let i = 0; i < names.length; i++) {
		const n = names[i];
		if (n.startsWith("~")) continue;
		const d = descs[n];
		if (d === undefined || !d.enumerable) continue;
		if (_utf8Bytes(n) > 512) return null;
		list.push(n);
	}
	list.sort();
	return list;
}

// ---- Check if hidden keys exist ----

function _hasHiddenKeys(descs: Record<string, PropertyDescriptor>): boolean {
	const names = _getOwnPropertyNames(descs);
	for (let i = 0; i < names.length; i++) {
		if (names[i].startsWith("~")) return true;
	}
	return false;
}

// ---- Iterative stack machine ----
// Internal building uses unknown for values to avoid readonly-type casts.
// Only the final genericNormalize call produces typed NormalizedJson.

interface RootBox {
	result: unknown;
}

type Slot =
	| { kind: "root"; box: RootBox; slot: null }
	| { kind: "array"; box: unknown[]; slot: number }
	| { kind: "object"; box: Record<string, unknown>; slot: string };

interface EnterFrame {
	tag: "enter";
	value: unknown;
	depth: number;
	isObjProp: boolean;
	to: Slot;
}

interface DoneFrame {
	tag: "done";
	value: unknown;
	to: Slot;
}

type Frame = EnterFrame | DoneFrame;

function _assign(to: Slot, value: unknown): void {
	if (to.kind === "root") {
		to.box.result = value;
	} else if (to.kind === "array") {
		to.box[to.slot] = value;
	} else {
		to.box[to.slot] = value;
	}
}

// ========================================================================
// MAIN ENTRY: normalizeToolSchema
// Root primitives → E_INVALID_INPUT per V3 §4.10
// ========================================================================

export function normalizeTypeBoxSchema(input: unknown): NormalizeResult {
	// Root must be non-null object per V3 §4.10
	if (input === null || typeof input === "boolean" || typeof input === "number" || typeof input === "string") {
		return failResult("E_INVALID_INPUT");
	}
	if (
		typeof input === "function" ||
		typeof input === "bigint" ||
		typeof input === "undefined" ||
		typeof input === "symbol"
	) {
		return failResult("E_INVALID_INPUT");
	}
	if (!_isObj(input)) return failResult("E_INVALID_INPUT");

	// ---- Iterative stack machine ----
	const seen = new WeakMap<object, true>();
	let nodeCount = 0;

	const rootBox: RootBox = { result: null };
	const stack: Frame[] = [
		{ tag: "enter", value: input, depth: 0, isObjProp: false, to: { kind: "root", box: rootBox, slot: null } },
	];

	while (stack.length > 0) {
		const frame = stack[stack.length - 1];

		// ---- Done frame ----
		if (frame.tag === "done") {
			_assign(frame.to, frame.value);
			stack.pop();
			continue;
		}

		// ---- Enter frame ----
		if (!_isObj(frame.value)) {
			// Primitives inside objects/arrays — pass through
			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return failResult("E_NODES");
			if (typeof frame.value === "number" && (!_isFinite(frame.value) || Object.is(frame.value, -0))) {
				return failResult("E_INVALID_INPUT");
			}
			if (typeof frame.value === "string") {
				if (_utf8Bytes(frame.value) > MAX_STRING_BYTES) return failResult("E_RECORD_KEY_TOO_LONG");
				if (_hasUnpairedSurrogate(frame.value)) return failResult("E_RECORD_KEY_TOO_LONG");
			}
			_assign(frame.to, frame.value);
			stack.pop();
			continue;
		}

		const obj: object = frame.value;

		if (_isProxyClosed(obj)) return failResult("E_PROXY");
		if (frame.depth >= MAX_DEPTH) return failResult("E_DEPTH");
		if (_getOwnPropertySymbols(obj).length > 0) return failResult("E_OWN_SYMBOL");

		const descs = _captureDescs(obj);
		if (descs === null) return failResult("E_NOT_A_SCHEMA");

		// ---- Array branch ----
		if (isArray(obj)) {
			const proto = getPrototypeOf(obj);
			if (proto !== ArrayProto) return failResult("E_INVALID_PROTOTYPE");

			const lenD = descs.length;
			if (lenD === undefined || typeof lenD.value === "undefined") return failResult("E_NOT_A_SCHEMA");
			const len = lenD.value;
			if (typeof len !== "number" || !_isFinite(len)) return failResult("E_NOT_A_SCHEMA");
			const lenVal = Math.floor(len);
			if (lenVal < 0 || lenVal > 256) return failResult("E_NOT_A_SCHEMA");

			let dataCount = 0;
			const dNames = _getOwnPropertyNames(descs);
			for (let di = 0; di < dNames.length; di++) {
				const dn = dNames[di];
				if (dn === "length") {
					if (lenD.enumerable !== false) return failResult("E_NOT_A_SCHEMA");
					continue;
				}
				const dd = descs[dn];
				if (dd === undefined) return failResult("E_NOT_A_SCHEMA");
				if (typeof dd.get !== "undefined" || typeof dd.set !== "undefined") return failResult("E_ACCESSOR");
				if (typeof dd.value === "undefined") return failResult("E_NOT_A_SCHEMA");
				if (dd.enumerable !== true) return failResult("E_NOT_A_SCHEMA");

				const idx = Number(dn);
				if (String(idx) !== dn || idx < 0 || idx !== Math.floor(idx) || idx >= lenVal) {
					return failResult("E_NOT_A_SCHEMA");
				}
				dataCount++;
			}
			if (dataCount !== lenVal) return failResult("E_NOT_A_SCHEMA");

			if (seen.has(obj)) return failResult("E_CYCLE_OR_ALIAS");
			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return failResult("E_NODES");
			seen.set(obj, true);

			const outArr: unknown[] = new Array(lenVal);
			stack.pop();
			stack.push({ tag: "done", value: outArr, to: frame.to });

			for (let i = lenVal - 1; i >= 0; i--) {
				const key = String(i);
				const dd = descs[key];
				if (dd === undefined) return failResult("E_NOT_A_SCHEMA");
				stack.push({
					tag: "enter",
					value: dd.value,
					depth: frame.depth + 1,
					isObjProp: false,
					to: { kind: "array", box: outArr, slot: i },
				});
			}
			continue;
		}

		// ---- Plain object: preflight ----
		const preflight = _preflight(descs);
		if (!preflight.ok) return failResult(preflight.code);
		const kind = preflight.kind;
		const hasOptional = preflight.hasOptional;

		if (hasOptional && !frame.isObjProp) return failResult("E_INVALID_HIDDEN_CONTEXT");
		if (seen.has(obj)) return failResult("E_CYCLE_OR_ALIAS");

		const hasHidden = _hasHiddenKeys(descs);

		// ---- TypeBox branch ----
		if (hasHidden) {
			if (kind === null) {
				let hasUnsafe = false;
				const hn = _getOwnPropertyNames(descs);
				for (let hi = 0; hi < hn.length; hi++) {
					if (hn[hi] === "~unsafe") {
						hasUnsafe = true;
						break;
					}
				}
				if (hasUnsafe) {
					const ue = _checkStringEnum(descs);
					if (ue !== null) return failResult(ue);
					nodeCount++;
					if (nodeCount > MAX_TOTAL_NODES) return failResult("E_NODES");
					seen.set(obj, true);
					_buildPlain(descs, frame, stack, frame.depth);
					continue;
				}
				return failResult("E_NOT_A_SCHEMA");
			}

			if (!_in(SUPPORTED_KINDS, kind)) return failResult("E_UNSUPPORTED_KIND");
			if (frame.depth === 0 && kind !== "Object") return failResult("E_ROOT_NOT_OBJECT");

			const re = _checkReq(descs, kind);
			if (re !== null) return failResult(re);

			const allow = _getAllow(kind);
			if (allow === undefined) return failResult("E_UNSUPPORTED_KIND");

			const allN = _getOwnPropertyNames(descs);
			for (let i = 0; i < allN.length; i++) {
				const n = allN[i];
				if (n.startsWith("~")) continue;
				const d = descs[n];
				if (d === undefined) return failResult("E_NOT_A_SCHEMA");
				if (!d.enumerable) continue;
				if (!allow.has(n)) return failResult("E_UNKNOWN_ENUMERABLE_KEYWORD");
			}

			if (kind === "Object") {
				const rm = _checkRequired(descs);
				if (rm !== null) return failResult(rm);
			}

			nodeCount++;
			if (nodeCount > MAX_TOTAL_NODES) return failResult("E_NODES");
			seen.set(obj, true);

			if (kind === "Object") {
				const out: Record<string, unknown> = {};
				stack.pop();
				stack.push({ tag: "done", value: out, to: frame.to });

				// Process properties with isObjProp: true for ~optional context
				const pdVal = descs.properties;
				if (pdVal !== undefined && pdVal.enumerable) {
					const pv = pdVal.value;
					if (_isObj(pv)) {
						const mapOut: Record<string, unknown> = {};
						out.properties = mapOut;
						const pDescs = _captureDescs(pv);
						if (pDescs !== null) {
							const pNames = _getOwnPropertyNames(pDescs);
							for (let pi = pNames.length - 1; pi >= 0; pi--) {
								const pn = pNames[pi];
								const pd2 = pDescs[pn];
								if (pd2 === undefined) continue;
								if (typeof pd2.value === "undefined") continue;
								if (!pd2.enumerable) continue;
								stack.push({
									tag: "enter",
									value: pd2.value,
									depth: frame.depth + 1,
									isObjProp: true,
									to: { kind: "object", box: mapOut, slot: pn },
								});
							}
						}
					}
				}

				// Process patternProperties
				const ppd = descs.patternProperties;
				if (ppd !== undefined && ppd.enumerable) {
					const ppv = ppd.value;
					if (_isObj(ppv)) {
						const ppOut: Record<string, unknown> = {};
						out.patternProperties = ppOut;
						const ppDescs = _captureDescs(ppv);
						if (ppDescs !== null) {
							const ppNames = _getOwnPropertyNames(ppDescs);
							for (let pi = ppNames.length - 1; pi >= 0; pi--) {
								const pn = ppNames[pi];
								const ppd2 = ppDescs[pn];
								if (ppd2 === undefined) continue;
								if (typeof ppd2.value === "undefined") continue;
								if (!ppd2.enumerable) continue;
								stack.push({
									tag: "enter",
									value: ppd2.value,
									depth: frame.depth + 1,
									isObjProp: false,
									to: { kind: "object", box: ppOut, slot: pn },
								});
							}
						}
					}
				}

				// Remaining enumerable keys (required, type, additionalProperties, etc.)
				const sk = _sortedEnumKeys(descs);
				if (sk === null) continue;
				for (let si = 0; si < sk.length; si++) {
					const key = sk[si];
					if (key === "properties" || key === "patternProperties") continue;
					const cd = descs[key];
					if (cd === undefined || typeof cd.value === "undefined") continue;
					const cv = cd.value;
					if (_isObj(cv) || isArray(cv)) {
						stack.push({
							tag: "enter",
							value: cv,
							depth: frame.depth + 1,
							isObjProp: false,
							to: { kind: "object", box: out, slot: key },
						});
					} else {
						out[key] = cv;
					}
				}
			} else {
				_buildPlain(descs, frame, stack, frame.depth);
			}

			// Record key length check
			if (kind === "Record") {
				const ppd = descs.patternProperties;
				if (ppd !== undefined && ppd.enumerable) {
					const ppv = ppd.value;
					if (_isObj(ppv)) {
						const ppDescs = _captureDescs(ppv);
						if (ppDescs !== null) {
							const ppNames = _getOwnPropertyNames(ppDescs);
							for (let pi = 0; pi < ppNames.length; pi++) {
								if (_utf8Bytes(ppNames[pi]) > 512) return failResult("E_RECORD_KEY_TOO_LONG");
							}
						}
					}
				}
			}

			continue;
		}

		// ---- Plain JSON Schema branch ----
		const proto = getPrototypeOf(obj);
		if (proto !== ObjectProto && proto !== null) return failResult("E_INVALID_PROTOTYPE");

		if (frame.depth === 0) {
			const td = descs.type;
			if (td === undefined || !td.enumerable || td.value !== "object") return failResult("E_NOT_A_SCHEMA");
		}

		let hasEnum = false;
		const allN = _getOwnPropertyNames(descs);
		for (let i = 0; i < allN.length; i++) {
			const d = descs[allN[i]];
			if (d !== undefined && d.enumerable) {
				hasEnum = true;
				break;
			}
		}
		if (!hasEnum) return failResult("E_NOT_A_SCHEMA");

		for (let i = 0; i < allN.length; i++) {
			const d = descs[allN[i]];
			if (d === undefined) return failResult("E_NOT_A_SCHEMA");
			if (typeof d.get !== "undefined" || typeof d.set !== "undefined") return failResult("E_ACCESSOR");
			if (typeof d.value === "undefined") return failResult("E_NOT_A_SCHEMA");
		}

		nodeCount++;
		if (nodeCount > MAX_TOTAL_NODES) return failResult("E_NODES");
		seen.set(obj, true);

		_buildPlain(descs, frame, stack, frame.depth);
	}

	// ---- Stack exhausted ----
	const result = rootBox.result;
	if (result === null) return okResult(null);
	// Feed through accepted generic normalizer
	const genericResult: GenericResult = genericNormalize(result);
	if (!genericResult.ok) {
		return failResult(mapGenericFail(genericResult.code));
	}
	return okResult(genericResult.value);
}

// ---- Build plain output (copy enumerable keys, strip ~) ----
// Internal only — uses unknown/Record<string, unknown> for zero casts.
// Final output fed to genericNormalize which returns typed NormalizedJson.

function _buildPlain(
	descs: Record<string, PropertyDescriptor>,
	frame: EnterFrame,
	stack: Frame[],
	depth: number,
): void {
	const out: Record<string, unknown> = {};
	stack.pop();
	stack.push({ tag: "done", value: out, to: frame.to });

	const sk = _sortedEnumKeys(descs);
	if (sk === null) {
		// Key too long — will be caught by calling code
		return;
	}

	for (let si = 0; si < sk.length; si++) {
		const key = sk[si];
		const cd = descs[key];
		if (cd === undefined || typeof cd.value === "undefined") continue;
		const cv = cd.value;
		if (_isObj(cv) || isArray(cv)) {
			stack.push({
				tag: "enter",
				value: cv,
				depth: depth + 1,
				isObjProp: false,
				to: { kind: "object", box: out, slot: key },
			});
		} else {
			out[key] = cv;
		}
	}
}

// ---- Forward alias ----
export { normalizeTypeBoxSchema as normalizeToolSchema };
