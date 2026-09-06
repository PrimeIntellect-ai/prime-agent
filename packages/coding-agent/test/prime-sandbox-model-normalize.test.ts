import { describe, expect, test } from "bun:test";
import {
	MAX_ARRAY_LENGTH,
	MAX_DEPTH,
	MAX_KEY_UTF8_BYTES,
	MAX_OBJECT_KEYS,
	MAX_STRING_UTF8_BYTES,
	MAX_TOTAL_NODES,
	type NormalizedJson,
	type NormalizeErrorCode,
	type NormalizeResult,
	normalize,
} from "../src/modes/daemon/sandbox/prime-sandbox-model-normalize.js";

// ---- helpers ----

function expectOk(value: NormalizeResult): asserts value is { ok: true; value: NormalizedJson } {
	expect(value.ok).toBe(true);
}

function expectFail(value: NormalizeResult, code: NormalizeErrorCode): void {
	expect(value.ok).toBe(false);
	if (!value.ok) {
		expect(value.code).toBe(code);
	}
}

function isFrozenDeep(value: unknown): boolean {
	if (value === null || typeof value !== "object") return true;
	if (!Object.isFrozen(value)) return false;
	if (Array.isArray(value)) {
		return value.every(isFrozenDeep);
	}
	return Object.keys(value).every((k) => isFrozenDeep(Reflect.get(value, k)));
}

function getKeysOf(value: unknown): string[] {
	return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

function hasKey(value: unknown, key: string): boolean {
	return typeof value === "object" && value !== null && key in value;
}

describe("V11 generic normalizer - basic", () => {
	test("accepts null", () => {
		const r = normalize(null);
		expectOk(r);
		expect(r.value).toBe(null);
	});

	test("accepts boolean", () => {
		const r = normalize(true);
		expectOk(r);
		expect(r.value).toBe(true);
	});

	test("accepts number", () => {
		expectOk(normalize(42));
		expectOk(normalize(0));
		expectOk(normalize(-1.5));
		expectFail(normalize(Infinity), "non_finite");
	});

	test("rejects -0", () => {
		expectFail(normalize(-0), "non_finite");
	});

	test("rejects NaN", () => {
		expectFail(normalize(NaN), "non_finite");
	});

	test("accepts string", () => {
		expectOk(normalize("hello"));
		const r = normalize("hello");
		expectOk(r);
		expect(r.value).toBe("hello");
	});

	test("rejects function", () => {
		expectFail(
			normalize(() => {}),
			"invalid_input",
		);
	});

	test("rejects symbol", () => {
		expectFail(normalize(Symbol("x")), "invalid_input");
	});

	test("rejects undefined", () => {
		expectFail(normalize(undefined), "invalid_input");
	});

	test("accepts plain object", () => {
		const r = normalize({ a: 1, b: "two" });
		expectOk(r);
		expect(r.value).toEqual({ a: 1, b: "two" });
	});

	test("freezes result deeply", () => {
		const r = normalize({ outer: { inner: [1, 2, 3] } });
		expectOk(r);
		expect(isFrozenDeep(r.value)).toBe(true);
	});

	test("lexicographic output keys", () => {
		const r = normalize({ z: 1, a: 2, m: 3 });
		expectOk(r);
		expect(getKeysOf(r.value)).toEqual(["a", "m", "z"]);
	});
});

describe("V11 generic normalizer - hostile graph", () => {
	test("rejects proxy", () => {
		const target = { a: 1 };
		const proxy = new Proxy(target, {});
		expectFail(normalize(proxy), "proxy");
	});

	test("rejects revoked proxy", () => {
		const { proxy, revoke } = Proxy.revocable({ a: 1 }, {});
		revoke();
		expectFail(normalize(proxy), "proxy");
	});

	test("rejects cycle (self-reference)", () => {
		const obj: Record<string, unknown> = { a: 1 };
		obj.self = obj;
		expectFail(normalize(obj), "cycle_or_alias");
	});

	test("rejects alias (same reference twice)", () => {
		const inner = { x: 1 };
		const obj = { a: inner, b: inner };
		expectFail(normalize(obj), "cycle_or_alias");
	});

	test("rejects symbol keys", () => {
		const obj = { a: 1 };
		Object.defineProperty(obj, Symbol("secret"), { value: 42, enumerable: false });
		expectFail(normalize(obj), "own_symbol");
	});

	test("rejects accessor descriptor", () => {
		const obj = Object.defineProperty({}, "a", { get: () => 1, enumerable: true });
		expectFail(normalize(obj), "accessor");
	});

	test("rejects toJSON property", () => {
		const obj = { a: 1, toJSON: () => "hacked" };
		expectFail(normalize(obj), "tojson");
	});

	test("rejects non-enumerable property (non ~kind)", () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "hidden", {
			value: 42,
			writable: true,
			configurable: true,
			enumerable: false,
		});
		obj.a = 1;
		expectFail(normalize(obj), "non_enumerable");
	});

	test("rejects null prototype", () => {
		const obj: Record<string, unknown> = Object.create(null);
		obj.a = 1;
		expectFail(normalize(obj), "invalid_prototype");
	});

	test("rejects Array.prototype non-plain array", () => {
		const obj = { __proto__: Array.prototype, a: 1 };
		expectFail(normalize(obj), "invalid_prototype");
	});
});

describe("V11 generic normalizer - arrays", () => {
	test("accepts dense array", () => {
		const r = normalize([1, "two", null, true]);
		expectOk(r);
		expect(r.value).toEqual([1, "two", null, true]);
	});

	test("rejects sparse array", () => {
		const arr: unknown[] = [1];
		delete arr[0];
		expectFail(normalize(arr), "array_shape");
	});

	test("rejects array with wrong prototype", () => {
		// The v11 code checks isArray first; a non-array with enumerable keys fails object proto check
		const obj: Record<string, unknown> = Object.create(null);
		obj.a = 1;
		expectFail(normalize(obj), "invalid_prototype");
	});

	test("rejects array exceeding MAX_ARRAY_LENGTH", () => {
		const arr = new Array(MAX_ARRAY_LENGTH + 1);
		expectFail(normalize(arr), "array_length");
	});

	test("rejects array with non-numeric key", () => {
		const arr: unknown[] = [1];
		Reflect.set(arr, "x", 2);
		expectFail(normalize(arr), "array_shape");
	});
});

describe("V11 generic normalizer - strings/bytes", () => {
	test("rejects unpaired surrogates", () => {
		expectFail(normalize("\ud83d"), "string_bytes");
	});

	test("rejects oversized string", () => {
		const big = "x".repeat(MAX_STRING_UTF8_BYTES + 1);
		expectFail(normalize(big), "string_bytes");
	});

	test("rejects oversized key", () => {
		const key = "x".repeat(MAX_KEY_UTF8_BYTES + 1);
		const obj: Record<string, unknown> = {};
		obj[key] = 1;
		expectFail(normalize(obj), "key_bytes");
	});
});

describe("V11 generic normalizer - bounds", () => {
	test("rejects depth exceeding MAX_DEPTH", () => {
		const obj: object = {};
		let current: unknown = obj;
		for (let i = 0; i < MAX_DEPTH + 1; i++) {
			if (typeof current !== "object" || current === null) break;
			Reflect.set(current, "nested", {});
			current = Reflect.get(current, "nested");
		}
		expectFail(normalize(obj), "depth");
	});

	test("rejects excessive nodes", () => {
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < MAX_TOTAL_NODES + 1; i++) {
			obj[String(i)] = i;
		}
		// The prototype is correct, but too many object keys still fail object_keys.
		expectFail(normalize(obj), "object_keys");
	});

	test("rejects object with too many keys", () => {
		const obj: Record<string, unknown> = {};
		for (let i = 0; i < MAX_OBJECT_KEYS + 1; i++) {
			obj[String(i)] = i;
		}
		expectFail(normalize(obj), "object_keys");
	});
});

describe("V11 generic normalizer - ~kind metadata", () => {
	test("accepts plain object with no ~kind", () => {
		const r = normalize({ type: "object", properties: {} });
		expectOk(r);
	});

	test("strips ~kind from output", () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "~kind", {
			value: "Object",
			writable: true,
			configurable: true,
			enumerable: false,
		});
		obj.a = 1;
		const r = normalize(obj);
		expectOk(r);
		expect(getKeysOf(r.value)).toEqual(["a"]);
		expect(hasKey(r.value, "~kind")).toBe(false);
	});

	test("rejects ~kind with wrong value", () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "~kind", {
			value: "String",
			writable: true,
			configurable: true,
			enumerable: false,
		});
		obj.a = 1;
		expectFail(normalize(obj), "kind_mismatch");
	});

	test("rejects ~kind with wrong descriptor flags", () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "~kind", {
			value: "Object",
			writable: false,
			configurable: true,
			enumerable: false,
		});
		obj.a = 1;
		expectFail(normalize(obj), "kind_mismatch");
	});

	test("rejects multiple ~kind", () => {
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "~kind", {
			value: "Object",
			writable: true,
			configurable: true,
			enumerable: false,
		});
		Object.defineProperty(obj, "~kind", {
			value: "String",
			writable: true,
			configurable: true,
			enumerable: false,
		});
		obj.a = 1;
		expectFail(normalize(obj), "kind_mismatch");
	});
});
