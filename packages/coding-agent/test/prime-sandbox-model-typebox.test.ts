import { describe, expect, test } from "bun:test";
import type { NormalizedJson } from "../src/modes/daemon/sandbox/prime-sandbox-model-normalize.js";
import {
	type NormalizeResult,
	normalizeTypeBoxSchema,
	type V3ErrorCode,
} from "../src/modes/daemon/sandbox/prime-sandbox-model-typebox.js";

// ---- helpers ----

function expectOk(result: NormalizeResult): asserts result is { ok: true; value: NormalizedJson } {
	expect(result.ok).toBe(true);
}

function expectFail(result: NormalizeResult, code: V3ErrorCode): void {
	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.code).toBe(code);
	}
}

function setHidden(obj: object, key: string, value: unknown, opts?: Partial<PropertyDescriptor>): void {
	const desc: PropertyDescriptor = { value, writable: true, configurable: true, enumerable: false };
	if (opts) {
		for (const k of Object.keys(opts)) {
			const v: unknown = Reflect.get(opts, k);
			if (v !== undefined) {
				Reflect.set(desc, k, v);
			}
		}
	}
	Object.defineProperty(obj, key, desc);
}

function kindOf(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const obj: Record<string, unknown> = Object.assign({}, extra);
	setHidden(obj, "~kind", kind);
	return obj;
}

function _propObj(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return kindOf(kind, extra);
}

function getKeysOf(value: unknown): string[] {
	return typeof value === "object" && value !== null ? Object.keys(value) : [];
}

// ---- V3 §4.10: E_INVALID_INPUT ----

describe("normalizeTypeBoxSchema - E_INVALID_INPUT", () => {
	test("rejects null", () => {
		expectFail(normalizeTypeBoxSchema(null), "E_INVALID_INPUT");
	});

	test("rejects boolean", () => {
		expectFail(normalizeTypeBoxSchema(true), "E_INVALID_INPUT");
		expectFail(normalizeTypeBoxSchema(false), "E_INVALID_INPUT");
	});

	test("rejects number", () => {
		expectFail(normalizeTypeBoxSchema(42), "E_INVALID_INPUT");
	});

	test("rejects string", () => {
		expectFail(normalizeTypeBoxSchema("hello"), "E_INVALID_INPUT");
	});

	test("rejects function", () => {
		expectFail(
			normalizeTypeBoxSchema(() => {}),
			"E_INVALID_INPUT",
		);
	});

	test("rejects symbol", () => {
		expectFail(normalizeTypeBoxSchema(Symbol("x")), "E_INVALID_INPUT");
	});

	test("rejects undefined", () => {
		expectFail(normalizeTypeBoxSchema(undefined), "E_INVALID_INPUT");
	});

	test("rejects -0", () => {
		expectFail(normalizeTypeBoxSchema(-0), "E_INVALID_INPUT");
	});
});

// ---- V3 §4.10: E_PROXY ----

describe("normalizeTypeBoxSchema - E_PROXY", () => {
	test("rejects proxy", () => {
		const target = kindOf("Object", { type: "object", properties: {} });
		const proxy = new Proxy(target, {});
		expectFail(normalizeTypeBoxSchema(proxy), "E_PROXY");
	});

	test("rejects revoked proxy", () => {
		const target = kindOf("Object", { type: "object", properties: {} });
		const { proxy, revoke } = Proxy.revocable(target, {});
		revoke();
		expectFail(normalizeTypeBoxSchema(proxy), "E_PROXY");
	});
});

// ---- V3 §4.10: E_OWN_SYMBOL ----

describe("normalizeTypeBoxSchema - E_OWN_SYMBOL", () => {
	test("rejects symbol keys", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		Object.defineProperty(obj, Symbol("x"), { value: 1, enumerable: false });
		expectFail(normalizeTypeBoxSchema(obj), "E_OWN_SYMBOL");
	});
});

// ---- V3 §4.10: E_ACCESSOR ----

describe("normalizeTypeBoxSchema - E_ACCESSOR", () => {
	test("rejects getter", () => {
		const obj = kindOf("Object", { type: "object" });
		Object.defineProperty(obj, "properties", { get: () => ({}), enumerable: true, configurable: true });
		expectFail(normalizeTypeBoxSchema(obj), "E_ACCESSOR");
	});
});

// ---- V3 §4.10: E_ROOT_NOT_OBJECT ----

describe("normalizeTypeBoxSchema - E_ROOT_NOT_OBJECT", () => {
	test("rejects root non-Object kind", () => {
		expectFail(normalizeTypeBoxSchema(kindOf("String", { type: "string" })), "E_ROOT_NOT_OBJECT");
	});

	test("rejects root Union", () => {
		expectFail(normalizeTypeBoxSchema(kindOf("Union", { anyOf: [] })), "E_ROOT_NOT_OBJECT");
	});
});

// ---- V3 §4.10: E_UNSUPPORTED_KIND ----

describe("normalizeTypeBoxSchema - E_UNSUPPORTED_KIND", () => {
	const unsupported = [
		"Ref",
		"This",
		"Cyclic",
		"Generic",
		"Deferred",
		"Dependent",
		"Function",
		"Constructor",
		"Call",
		"Rest",
		"Parameter",
		"Identifier",
		"Any",
		"Unknown",
		"Never",
		"Undefined",
		"Void",
		"Symbol",
		"BigInt",
		"Intersect",
		"Tuple",
		"Enum",
	];

	for (const kind of unsupported) {
		test(`rejects ${kind}`, () => {
			const obj = kindOf("Object", {
				type: "object",
				properties: {
					field: kindOf(kind, { type: "string" }),
				},
			});
			expectFail(normalizeTypeBoxSchema(obj), "E_UNSUPPORTED_KIND");
		});
	}
});

// ---- V3 §4.10: E_REFINE ----

describe("normalizeTypeBoxSchema - E_REFINE", () => {
	test("rejects ~refine", () => {
		const obj = kindOf("String", { type: "string" });
		setHidden(obj, "~refine", []);
		const root = kindOf("Object", {
			type: "object",
			properties: { field: obj },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_REFINE");
	});
});

// ---- V3 §4.10: E_CYCLE_OR_ALIAS ----

describe("normalizeTypeBoxSchema - E_CYCLE_OR_ALIAS", () => {
	test("rejects alias (same ref twice)", () => {
		const inner = kindOf("String", { type: "string" });
		const root = kindOf("Object", {
			type: "object",
			properties: { a: inner, b: inner },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_CYCLE_OR_ALIAS");
	});

	test("rejects self-cycle", () => {
		const root: Record<string, unknown> = kindOf("Object", { type: "object" });
		root.properties = { self: root };
		expectFail(normalizeTypeBoxSchema(root), "E_CYCLE_OR_ALIAS");
	});
});

// ---- V3 §4.10: E_UNKNOWN_HIDDEN_KEY ----

describe("normalizeTypeBoxSchema - E_UNKNOWN_HIDDEN_KEY", () => {
	test("rejects unknown hidden key", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		setHidden(obj, "~unknown", "x");
		expectFail(normalizeTypeBoxSchema(obj), "E_UNKNOWN_HIDDEN_KEY");
	});

	test("rejects enumerable hidden key as unknown", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		Object.defineProperty(obj, "~unknown", {
			value: "x",
			writable: true,
			configurable: true,
			enumerable: true,
		});
		expectFail(normalizeTypeBoxSchema(obj), "E_UNKNOWN_HIDDEN_KEY");
	});
});

// ---- V3 §4.10: E_INVALID_HIDDEN_FLAG ----

describe("normalizeTypeBoxSchema - E_INVALID_HIDDEN_FLAG", () => {
	test("rejects ~optional value not true", () => {
		const prop = kindOf("String", { type: "string" });
		Object.defineProperty(prop, "~optional", {
			value: false,
			writable: true,
			configurable: true,
			enumerable: false,
		});
		const root = kindOf("Object", {
			type: "object",
			properties: { field: prop },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_INVALID_HIDDEN_FLAG");
	});

	test("rejects ~writable false on ~kind", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		Object.defineProperty(obj, "~kind", {
			value: "Object",
			writable: false,
			configurable: true,
			enumerable: false,
		});
		expectFail(normalizeTypeBoxSchema(obj), "E_INVALID_HIDDEN_FLAG");
	});

	test("rejects ~enumerable true on ~kind (E_ENUMERABLE_KIND)", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		Object.defineProperty(obj, "~kind", {
			value: "Object",
			writable: true,
			configurable: true,
			enumerable: true,
		});
		expectFail(normalizeTypeBoxSchema(obj), "E_ENUMERABLE_KIND");
	});
});

// ---- V3 §4.10: E_ENUMERABLE_KIND ----

describe("normalizeTypeBoxSchema - E_ENUMERABLE_KIND", () => {
	test("rejects enumerable ~optional", () => {
		const prop = kindOf("String", { type: "string" });
		Object.defineProperty(prop, "~optional", {
			value: true,
			writable: true,
			configurable: true,
			enumerable: true,
		});
		const root = kindOf("Object", {
			type: "object",
			properties: { field: prop },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_ENUMERABLE_KIND");
	});
});

// ---- V3 §4.10: E_INVALID_HIDDEN_CONTEXT ----

describe("normalizeTypeBoxSchema - E_INVALID_HIDDEN_CONTEXT", () => {
	test("rejects ~optional at root", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		setHidden(obj, "~optional", true);
		expectFail(normalizeTypeBoxSchema(obj), "E_INVALID_HIDDEN_CONTEXT");
	});

	test("rejects ~optional in array items", () => {
		const item = kindOf("String", { type: "string" });
		setHidden(item, "~optional", true);
		const root = kindOf("Object", {
			type: "object",
			properties: {
				arr: kindOf("Array", {
					type: "array",
					items: item,
				}),
			},
		});
		expectFail(normalizeTypeBoxSchema(root), "E_INVALID_HIDDEN_CONTEXT");
	});
});

// ---- V3 §4.10: E_REQUIRED_MISMATCH ----

describe("normalizeTypeBoxSchema - E_REQUIRED_MISMATCH", () => {
	test("rejects required array mismatch (missing field)", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				a: kindOf("String", { type: "string" }),
				b: kindOf("Number", { type: "number" }),
			},
			required: ["a"],
		});
		expectFail(normalizeTypeBoxSchema(root), "E_REQUIRED_MISMATCH");
	});

	test("rejects required array order mismatch", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				a: kindOf("String", { type: "string" }),
				b: kindOf("Number", { type: "number" }),
			},
			required: ["b", "a"],
		});
		expectFail(normalizeTypeBoxSchema(root), "E_REQUIRED_MISMATCH");
	});
});

// ---- V3 §4.10: E_MISSING_KEYWORD ----

describe("normalizeTypeBoxSchema - E_MISSING_KEYWORD", () => {
	test("rejects Object without properties", () => {
		expectFail(normalizeTypeBoxSchema(kindOf("Object", { type: "object" })), "E_MISSING_KEYWORD");
	});

	test("rejects String without type", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: { field: kindOf("String", {}) },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_MISSING_KEYWORD");
	});
});

// ---- V3 §4.10: E_UNKNOWN_ENUMERABLE_KEYWORD ----

describe("normalizeTypeBoxSchema - E_UNKNOWN_ENUMERABLE_KEYWORD", () => {
	test("rejects unknown key on String", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: { field: kindOf("String", { type: "string", unknownKey: "value" }) },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_UNKNOWN_ENUMERABLE_KEYWORD");
	});

	test("rejects unknown key on Object", () => {
		expectFail(
			normalizeTypeBoxSchema(kindOf("Object", { type: "object", properties: {}, unknownKey: 1 })),
			"E_UNKNOWN_ENUMERABLE_KEYWORD",
		);
	});
});

// ---- V3 §4.10: E_NON_ENUMERABLE_NON_HIDDEN ----

describe("normalizeTypeBoxSchema - E_NON_ENUMERABLE_NON_HIDDEN", () => {
	test("rejects non-enumerable non-hidden key", () => {
		const obj = kindOf("Object", { type: "object", properties: {} });
		Object.defineProperty(obj, "_internal", {
			value: "secret",
			writable: true,
			configurable: true,
			enumerable: false,
		});
		expectFail(normalizeTypeBoxSchema(obj), "E_NON_ENUMERABLE_NON_HIDDEN");
	});
});

// ---- V3 §4.10: E_UNSAFE_UNSUPPORTED ----

describe("normalizeTypeBoxSchema - E_UNSAFE_UNSUPPORTED", () => {
	test("rejects ~unsafe with non-StringEnum content", () => {
		const obj: Record<string, unknown> = { type: "number" };
		setHidden(obj, "~unsafe", null);
		const root = kindOf("Object", {
			type: "object",
			properties: { field: obj },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_UNSAFE_UNSUPPORTED");
	});

	test("rejects ~unsafe with empty enum", () => {
		const obj: Record<string, unknown> = { type: "string", enum: [] };
		setHidden(obj, "~unsafe", null);
		const root = kindOf("Object", {
			type: "object",
			properties: { field: obj },
		});
		expectFail(normalizeTypeBoxSchema(root), "E_UNSAFE_UNSUPPORTED");
	});
});

// ---- Supported kinds ----

describe("normalizeTypeBoxSchema - supported kinds", () => {
	test("Object with String and Number properties", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				command: kindOf("String", { type: "string", description: "Command" }),
				timeout: kindOf("Number", { type: "number", description: "Timeout" }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Object with required from non-optional properties", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				a: kindOf("String", { type: "string" }),
				b: kindOf("Number", { type: "number" }),
			},
			required: ["a", "b"],
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Object with optional property", () => {
		const optionalProp = kindOf("String", { type: "string" });
		setHidden(optionalProp, "~optional", true);

		const root = kindOf("Object", {
			type: "object",
			properties: {
				a: kindOf("String", { type: "string" }),
				b: optionalProp,
			},
			required: ["a"],
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Object with all optional properties", () => {
		const opt1 = kindOf("String", { type: "string" });
		setHidden(opt1, "~optional", true);
		const opt2 = kindOf("Number", { type: "number" });
		setHidden(opt2, "~optional", true);

		const root = kindOf("Object", {
			type: "object",
			properties: { a: opt1, b: opt2 },
		});
		// No required key at all
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Readonly modifier", () => {
		const readonlyProp = kindOf("String", { type: "string" });
		setHidden(readonlyProp, "~readonly", true);

		const root = kindOf("Object", {
			type: "object",
			properties: { field: readonlyProp },
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Union with String and Null", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				value: kindOf("Union", {
					anyOf: [kindOf("String", { type: "string" }), kindOf("Null", { type: "null" })],
				}),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Literal (string)", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				mode: kindOf("Literal", { type: "string", const: "auto" }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Literal (number)", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				count: kindOf("Literal", { type: "number", const: 42 }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Boolean", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				flag: kindOf("Boolean", { type: "boolean" }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Integer", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				port: kindOf("Integer", { type: "integer", minimum: 1, maximum: 65535 }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Array with String items", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				tags: kindOf("Array", {
					type: "array",
					items: kindOf("String", { type: "string" }),
				}),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Nested Array of Object", () => {
		const inner = kindOf("Object", {
			type: "object",
			properties: {
				x: kindOf("String", { type: "string" }),
				y: kindOf("String", { type: "string" }),
			},
			required: ["x", "y"],
		});
		const root = kindOf("Object", {
			type: "object",
			properties: {
				items: kindOf("Array", { type: "array", items: inner }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Record (String key, String value)", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				map: kindOf("Record", {
					type: "object",
					patternProperties: {
						"^.*$": kindOf("String", { type: "string" }),
					},
				}),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Unsafe StringEnum", () => {
		const obj: Record<string, unknown> = { type: "string", enum: ["add", "subtract"], description: "Operation" };
		setHidden(obj, "~unsafe", null);
		const root = kindOf("Object", {
			type: "object",
			properties: { op: obj },
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});

	test("Object with additionalProperties", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				name: kindOf("String", { type: "string" }),
			},
			required: ["name"],
			additionalProperties: false,
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
	});
});

// ---- Plain JSON Schema branch ----

describe("normalizeTypeBoxSchema - plain JSON Schema branch", () => {
	test("passes through simple JSON Schema", () => {
		const plain = {
			type: "object",
			properties: {
				name: { type: "string", description: "Name" },
			},
			required: ["name"],
		};
		const r = normalizeTypeBoxSchema(plain);
		expectOk(r);
	});

	test("rejects null-prototype root without type:object", () => {
		const obj = Object.create(null);
		Reflect.set(obj, "x", 1);
		expectFail(normalizeTypeBoxSchema(obj), "E_NOT_A_SCHEMA");
	});

	test("rejects null-prototype with type:object", () => {
		const obj = Object.create(null);
		Reflect.set(obj, "type", "object");
		Reflect.set(obj, "properties", {});
		expectFail(normalizeTypeBoxSchema(obj), "E_NOT_A_SCHEMA");
	});
});

// ---- Bounds ----

describe("normalizeTypeBoxSchema - bounds", () => {
	test("rejects exceeding max depth", () => {
		function nest(depth: number): Record<string, unknown> {
			if (depth === 0) return kindOf("String", { type: "string" });
			return kindOf("Object", {
				type: "object",
				properties: { n: nest(depth - 1) },
			});
		}
		const deep = nest(33);
		expectFail(normalizeTypeBoxSchema(deep), "E_DEPTH");
	});

	test("rejects alias across large depth", () => {
		const inner = kindOf("String", { type: "string" });
		const root = kindOf("Object", {
			type: "object",
			properties: {
				a: kindOf("Array", {
					type: "array",
					items: inner,
				}),
				b: inner,
			},
		});
		expectFail(normalizeTypeBoxSchema(root), "E_CYCLE_OR_ALIAS");
	});
});

// ---- Wire output verification ----

describe("normalizeTypeBoxSchema - wire output", () => {
	test("output has no hidden keys", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				name: kindOf("String", { type: "string", description: "Name" }),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
		const val = JSON.stringify(r.value);
		expect(val).not.toContain("~");
	});

	test("output keys sorted lexicographically", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				z: kindOf("String", { type: "string" }),
				a: kindOf("Number", { type: "number" }),
			},
			required: ["z", "a"],
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
		const keys = getKeysOf(r.value);
		expect(keys).toEqual(["properties", "required", "type"]);
	});

	test("output for StringEnum includes enum array", () => {
		const obj: Record<string, unknown> = { type: "string", enum: ["a", "b"] };
		setHidden(obj, "~unsafe", null);
		const root = kindOf("Object", {
			type: "object",
			properties: { op: obj },
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
		const outStr = JSON.stringify(r.value);
		expect(outStr).toContain('"enum"');
		expect(outStr).not.toContain("~unsafe");
	});

	test("output freezes deeply", () => {
		const root = kindOf("Object", {
			type: "object",
			properties: {
				inner: kindOf("Object", {
					type: "object",
					properties: {
						x: kindOf("String", { type: "string" }),
					},
				}),
			},
		});
		const r = normalizeTypeBoxSchema(root);
		expectOk(r);
		const checkLayer = (v: unknown): void => {
			if (typeof v !== "object" || v === null) return;
			expect(Object.isFrozen(v)).toBe(true);
			for (const key of Object.keys(v)) {
				checkLayer(Reflect.get(v, key));
			}
		};
		checkLayer(r.value);
	});
});

// ---- V3 §4.10: E_RECORD_KEY_TOO_LONG ----

describe("normalizeTypeBoxSchema - E_RECORD_KEY_TOO_LONG", () => {
	test("ensures key length bound exists", () => {
		// This exercises the record key length check path
		const longKey = "x".repeat(600);
		const root = kindOf("Object", {
			type: "object",
			properties: {
				map: kindOf("Record", {
					type: "object",
					patternProperties: {
						[longKey]: kindOf("String", { type: "string" }),
					},
				}),
			},
		});
		expectFail(normalizeTypeBoxSchema(root), "E_RECORD_KEY_TOO_LONG");
	});
});
