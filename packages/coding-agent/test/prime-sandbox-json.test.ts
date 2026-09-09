import { describe, expect, test } from "bun:test";
import { parseBoundedJson } from "../src/modes/daemon/sandbox/prime-sandbox-json.js";

function bytes(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

function expectInvalid(value: string): void {
	expect(parseBoundedJson(bytes(value))).toEqual({ ok: false, code: "INVALID_JSON" });
}

describe("bounded sandbox provider JSON", () => {
	test("parses and recursively freezes a bounded value", () => {
		const result = parseBoundedJson(bytes('{"outer":{"value":1},"rows":[true,null,"ok"]}'));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.value)).toBe(true);
		if (typeof result.value !== "object" || result.value === null) throw new Error("unexpected result");
		const outer = Object.getOwnPropertyDescriptor(result.value, "outer")?.value;
		expect(Object.isFrozen(outer)).toBe(true);
		const rows = Object.getOwnPropertyDescriptor(result.value, "rows")?.value;
		expect(Object.isFrozen(rows)).toBe(true);
	});

	test("accepts trailing JSON whitespace and rejects trailing data", () => {
		expect(parseBoundedJson(bytes('{"ok":true}\r\n\t ')).ok).toBe(true);
		expectInvalid('{"ok":true}x');
		expectInvalid('{"ok":true}{}');
	});

	test("rejects duplicate keys at every depth including escaped aliases", () => {
		expectInvalid('{"a":1,"a":2}');
		expectInvalid('{"nested":{"a":1,"\\u0061":2}}');
		expectInvalid('{"rows":[{"same":1,"same":2}]}');
	});

	test("rejects prototype mutation keys at every depth", () => {
		for (const key of ["__proto__", "prototype", "constructor"]) {
			expectInvalid(`{"nested":{"${key}":1}}`);
		}
	});

	test("accepts valid raw and escaped astral Unicode", () => {
		expect(parseBoundedJson(bytes('{"stdout":"😀"}')).ok).toBe(true);
		expect(parseBoundedJson(bytes('{"stdout":"\\ud83d\\ude00"}')).ok).toBe(true);
	});

	test("rejects escaped lone and reversed surrogates", () => {
		expectInvalid('{"stdout":"\\ud83d"}');
		expectInvalid('{"stdout":"\\ude00\\ud83d"}');
	});

	test("rejects BOM and malformed UTF-8", () => {
		const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
		expect(parseBoundedJson(bom)).toEqual({ ok: false, code: "INVALID_JSON" });
		const malformed = new Uint8Array([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xc0, 0xaf, 0x7d]);
		expect(parseBoundedJson(malformed)).toEqual({ ok: false, code: "INVALID_JSON" });
	});

	test("rejects invalid JSON number and token forms", () => {
		for (const value of ["01", "0x10", "1.", "1e", "+1", "NaN", "Infinity", "truex"]) expectInvalid(value);
	});

	test("enforces depth, object, array, node, and string bounds", () => {
		expectInvalid(`${"[".repeat(9)}0${"]".repeat(9)}`);
		const keys = Array.from({ length: 65 }, (_, index) => `"k${index}":0`).join(",");
		expectInvalid(`{${keys}}`);
		expectInvalid(`[${new Array(257).fill("0").join(",")}]`);
		const rows = new Array(256).fill('{"v":0}').join(",");
		expectInvalid(`[${rows}]`);
		const tooLong = "a".repeat(768 * 1024 + 1);
		expectInvalid(`"${tooLong}"`);
	});

	test("accepts arrays through the declared 256-item limit", () => {
		const value = `[${new Array(100).fill("0").join(",")}]`;
		expect(parseBoundedJson(bytes(value)).ok).toBe(true);
	});

	test("rejects numbers that JSON.parse converts to non-finite values", () => {
		expectInvalid("1e1000");
		expectInvalid("-1e1000");
	});

	test("accepts empty structures, escaped null, and negative zero", () => {
		for (const value of ["{}", "[]", '{"":1}', '"\\u0000"', "-0", '"\\u0061"']) {
			expect(parseBoundedJson(bytes(value)).ok).toBe(true);
		}
	});

	test("rejects bodies over one MiB before copying", () => {
		const value = new Uint8Array(1024 * 1024 + 1);
		expect(parseBoundedJson(value)).toEqual({ ok: false, code: "BODY_TOO_LARGE" });
	});

	test("rejects subclasses, shared backing stores, proxies, and shadowed views", () => {
		class DerivedBytes extends Uint8Array {}
		const derived = new DerivedBytes(bytes("{}"));
		expect(parseBoundedJson(derived)).toEqual({ ok: false, code: "INPUT_INVALID" });

		const shared = new Uint8Array(new SharedArrayBuffer(2));
		shared.set(bytes("{}"));
		expect(parseBoundedJson(shared)).toEqual({ ok: false, code: "INPUT_INVALID" });

		const proxied = new Proxy(bytes("{}"), {});
		expect(parseBoundedJson(proxied)).toEqual({ ok: false, code: "INPUT_INVALID" });
		const crafted = new Proxy(bytes("{}"), {
			get(target, property) {
				return Reflect.get(target, property, target);
			},
		});
		expect(parseBoundedJson(crafted)).toEqual({ ok: false, code: "INPUT_INVALID" });

		const shadowed = bytes("{}");
		let getterCalled = false;
		Object.defineProperty(shadowed, "byteLength", {
			get() {
				getterCalled = true;
				throw new Error("must not run");
			},
		});
		expect(parseBoundedJson(shadowed)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(getterCalled).toBe(false);
	});

	test("copies subarray input using its exact byte range", () => {
		const full = bytes('xx{"ok":true}yy');
		const slice = full.subarray(2, full.byteLength - 2);
		const result = parseBoundedJson(slice);
		expect(result.ok).toBe(true);
	});
});
