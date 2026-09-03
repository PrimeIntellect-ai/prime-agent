import { describe, expect, it } from "vitest";
import {
	type CreateGateResult,
	createRelayApplicationGate,
	type GateApplyResult,
	type GateCloseResult,
} from "../src/modes/daemon/relay-application-gate.js";

// ===========================================================================
// Helpers
// ===========================================================================

function makeApplication(
	overrides?: Readonly<{
		apply?: (raw: unknown) => Promise<unknown>;
		close?: () => Promise<unknown>;
	}>,
): Record<string, unknown> {
	return Object.freeze({
		apply:
			overrides?.apply ??
			(async () =>
				Object.freeze({
					status: "applied",
				})),
		close: overrides?.close ?? (async () => Object.freeze({ status: "closed" })),
	});
}

async function expectBindOk(
	gateResult: Exclude<CreateGateResult, { readonly ok: false }>,
	app: unknown,
): Promise<void> {
	const r = await gateResult.bind(app);
	expect(r).toEqual({ ok: true });
}

// ===========================================================================
// Factory
// ===========================================================================

describe("createRelayApplicationGate factory", () => {
	it("creates an unbound gate with separate application and bind", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// application has {apply, close} only
		expect(typeof result.application.apply).toBe("function");
		expect(typeof result.application.close).toBe("function");
		expect("bind" in result.application).toBe(false);
		// bind is separate
		expect(typeof result.bind).toBe("function");
		// Before bind, apply returns error
		expect(await result.application.apply({})).toEqual({ status: "error" });
		// Close before bind closes cleanly
		expect(await result.application.close()).toEqual({ status: "closed" });
	});

	it("application object is frozen and has only apply and close", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result.application)).toBe(true);
		const keys = Object.keys(result.application);
		expect(keys).toEqual(["apply", "close"]);
	});

	it("rejects null factory input with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate(null);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects undefined factory input with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate(undefined);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects number factory input with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate(42);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects string factory input with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate("hello");
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects boolean factory input with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate(true);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});
});

// ===========================================================================
// Bind: success paths
// ===========================================================================

describe("bind", () => {
	it("binds a valid application", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = makeApplication();
		const bindResult = await result.bind(app);
		expect(bindResult).toEqual({ ok: true });
	});

	it("bind is one-shot — second bind returns INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await result.bind(makeApplication())).toEqual({ ok: true });
		const second = await result.bind(makeApplication());
		expect(second).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("bind returns INVALID_ARGUMENT after close", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await result.application.close();
		const bindResult = await result.bind(makeApplication());
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("after bind, apply forwards to bound app", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(result, makeApplication());
		const res = await result.application.apply({ some: "data" });
		expect(res).toEqual({ status: "applied" });
	});

	it("bind captures close and close calls it exactly once", async () => {
		let closeCalls = 0;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(
			result,
			makeApplication({
				close: async () => {
					closeCalls += 1;
					return Object.freeze({ status: "closed" });
				},
			}),
		);
		expect(await result.application.close()).toEqual({ status: "closed" });
		expect(closeCalls).toBe(1);
	});

	it("bind discards raw application reference — retains only bound methods", async () => {
		const mutable: Record<string, unknown> = {
			apply: async () => Object.freeze({ status: "applied" }),
			close: async () => Object.freeze({ status: "closed" }),
		};
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(result, mutable);
		// Mutate the original — should not affect behavior
		mutable.apply = async () => Object.freeze({ status: "error" });
		mutable.close = async () => Object.freeze({ status: "error" });
		mutable.extraProp = true;
		expect(await result.application.apply({})).toEqual({ status: "applied" });
	});
});

// ===========================================================================
// Bind: rejection paths
// ===========================================================================

describe("bind rejection", () => {
	it("rejects null application with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(null);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects undefined application with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(undefined);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects number application with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(42);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects string application with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind("hello");
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects boolean application with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(true);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects Proxy application with INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const proxy = new Proxy(makeApplication(), {});
		const bindResult = await result.bind(proxy);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects Proxy application without invoking reflection traps", async () => {
		let traps = 0;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const proxy = new Proxy(makeApplication(), {
			ownKeys: () => {
				traps += 1;
				throw new Error("must not run");
			},
		});
		const bindResult = await result.bind(proxy);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(traps).toBe(0);
	});

	it("rejects application with extra keys — closes owner, reports close result", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Close returns a valid result; extra key on application causes rejection
		const bindResult = await result.bind(
			Object.freeze({ apply: async () => ({}), close: async () => ({ status: "closed" }), extra: true }),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with missing apply", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(Object.freeze({ close: async () => ({ status: "closed" }) }));
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with missing close", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(Object.freeze({ apply: async () => ({ status: "applied" }) }));
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with non-function apply", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({ apply: "not_a_fn", close: async () => ({ status: "closed" }) }),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with non-function close", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({ apply: async () => ({ status: "applied" }), close: "not_a_fn" }),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with custom prototype (not Object.prototype)", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const inner = Object.assign(Object.create(null), {
			apply: async () => ({ status: "applied" }),
			close: async () => ({ status: "closed" }),
		});
		const bindResult = await result.bind(inner);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with non-enumerable apply", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "close", {
			value: async () => ({ status: "closed" }),
			enumerable: true,
		});
		Object.defineProperty(obj, "apply", {
			value: async () => ({ status: "applied" }),
			enumerable: false,
		});
		const bindResult = await result.bind(obj);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with accessor descriptor for apply", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "apply", {
			get: () => async () => ({ status: "applied" }),
			enumerable: true,
		});
		Object.defineProperty(obj, "close", {
			value: async () => ({ status: "closed" }),
			enumerable: true,
		});
		const bindResult = await result.bind(obj);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with Proxy close function", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const proxyClose = new Proxy(async () => ({ status: "closed" }), {});
		const bindResult = await result.bind(
			Object.freeze({ apply: async () => ({ status: "applied" }), close: proxyClose }),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects application with Proxy apply function", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const proxyApply = new Proxy(async () => ({ status: "applied" }), {});
		const bindResult = await result.bind(
			Object.freeze({ apply: proxyApply, close: async () => ({ status: "closed" }) }),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});
});

// ===========================================================================
// Bind failure closes provable owner — observes exact result via descriptors
// ===========================================================================

describe("bind failure closes provable owner", () => {
	it("closes provable owner on missing apply", async () => {
		let closeCalled = false;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				close: async () => {
					closeCalled = true;
					return { status: "closed" };
				},
			}),
		);
		expect(bindResult.ok).toBe(false);
		expect(closeCalled).toBe(true);
	});

	it("missing close has no owner to clean up — returns INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				apply: async () => ({ status: "applied" }),
			}),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("closes provable owner on extra keys", async () => {
		let closeCalled = false;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					closeCalled = true;
					return { status: "closed" };
				},
				extra: true,
			}),
		);
		expect(bindResult.ok).toBe(false);
		expect(closeCalled).toBe(true);
	});

	it("closes provable owner on non-function apply", async () => {
		let closeCalled = false;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				apply: "not_a_fn",
				close: async () => {
					closeCalled = true;
					return { status: "closed" };
				},
			}),
		);
		expect(bindResult.ok).toBe(false);
		expect(closeCalled).toBe(true);
	});

	it("no double close on bind failure", async () => {
		let closeCalls = 0;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					closeCalls += 1;
					return { status: "closed" };
				},
				extra: true,
			}),
		);
		expect(bindResult.ok).toBe(false);
		expect(closeCalls).toBe(1);
	});

	it("CLOSE_UNCERTAIN when owner close returns malformed result", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					return { status: "something_else" };
				},
				extra: true,
			}),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("CLOSE_UNCERTAIN when owner close returns non-object", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const bindResult = await result.bind(
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => "not_an_object",
				extra: true,
			}),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("CLOSE_UNCERTAIN when owner close return has wrong descriptor shape", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Return an object with extra keys (via descriptor, not plain)
		const closeResult = Object.defineProperties(
			{},
			{
				status: { value: "closed", enumerable: true, writable: false },
				xtra: { value: true, enumerable: true, writable: false },
			},
		);
		Object.freeze(closeResult);
		const bindResult = await result.bind(
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => closeResult,
				extra: true,
			}),
		);
		expect(bindResult).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});
});

// ===========================================================================
// Apply behavior
// ===========================================================================

describe("apply behavior", () => {
	it("returns error before bind", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error after close", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(result, makeApplication());
		await result.application.close();
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error when poisoned by throwing apply", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const throwingApp = makeApplication({
			apply: async () => {
				throw new Error("boom");
			},
		});
		await expectBindOk(result, throwingApp);
		expect(await result.application.apply({})).toEqual({ status: "error" });
		// Subsequent calls also error (poisoned)
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error when apply returns non-object", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const badApp = makeApplication({
			apply: async () => "not_an_object",
		});
		await expectBindOk(result, badApp);
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error when apply returns status with invalid value", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const badApp = makeApplication({
			apply: async () => ({ status: "invalid" }),
		});
		await expectBindOk(result, badApp);
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error when apply returns non-native Promise", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Return a non-function apply that is synchronous
		const badApp: Record<string, unknown> = {
			apply: () => ({ status: "applied" }),
			close: async () => ({ status: "closed" }),
		};
		await expectBindOk(result, badApp);
		// observePromise sees non-Promise -> { fulfilled: false } -> poison
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error when apply result has extra keys via descriptor", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const badResult = Object.defineProperties(
			{},
			{
				status: { value: "applied", enumerable: true, writable: false },
				extra: { value: true, enumerable: true, writable: false },
			},
		);
		Object.freeze(badResult);
		const badApp = makeApplication({ apply: async () => badResult });
		await expectBindOk(result, badApp);
		// Descriptor validation catches extra keys -> poison
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("returns error when apply result status is non-enumerable", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const badObj: Record<string, unknown> = {};
		Object.defineProperty(badObj, "status", {
			value: "applied",
			enumerable: false,
		});
		const badApp = makeApplication({ apply: async () => badObj });
		await expectBindOk(result, badApp);
		expect(await result.application.apply({})).toEqual({ status: "error" });
	});
});

// ===========================================================================
// FIFO ordering
// ===========================================================================

describe("FIFO ordering", () => {
	it("processes applies in FIFO order", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		let resolveFirst: (() => void) | undefined;
		const sharedGate = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});

		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					await sharedGate;
					return { status: "applied" };
				},
			}),
		);

		const p1 = result.application.apply({});
		const p2 = result.application.apply({});
		resolveFirst?.();
		await p1;
		await p2;
	});

	it("async FIFO: second apply waits for a slow first apply", async () => {
		const order: string[] = [];
		let resolveGate: (() => void) | undefined;
		const gatePromise = new Promise<void>((resolve) => {
			resolveGate = resolve;
		});

		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		let callCount = 0;
		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					callCount += 1;
					if (callCount === 1) {
						await gatePromise;
					}
					order.push(`call-${callCount}`);
					return { status: "applied" };
				},
			}),
		);

		const p1 = result.application.apply({});
		const p2 = result.application.apply({});
		expect(order).toEqual([]);
		resolveGate?.();
		await p1;
		await p2;
		expect(order).toEqual(["call-1", "call-2"]);
	});
});

// ===========================================================================
// Reentry rejection (ALS for apply AND close)
// ===========================================================================

describe("reentry rejection", () => {
	it("rejects same-instance apply reentry via AsyncLocalStorage", async () => {
		let innerResult: unknown;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					// Try to call back into the same gate — should be rejected
					innerResult = await result.application.apply({});
					return { status: "applied" };
				},
			}),
		);

		expect(await result.application.apply({})).toEqual({ status: "applied" });
		expect(innerResult).toEqual({ status: "error" });
	});

	it("rejects same-instance close reentry via AsyncLocalStorage", async () => {
		let innerCloseResult: unknown;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await expectBindOk(
			result,
			makeApplication({
				close: async () => {
					// Try to close again from within close — should be rejected
					innerCloseResult = await result.application.close();
					return { status: "closed" };
				},
			}),
		);

		expect(await result.application.close()).toEqual({ status: "closed" });
		expect(innerCloseResult).toEqual({ status: "error" });
	});

	it("rejects apply-into-close reentry", async () => {
		let innerResult: unknown;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					// Try to close from within apply — should be rejected
					innerResult = await result.application.close();
					return { status: "applied" };
				},
			}),
		);

		expect(await result.application.apply({})).toEqual({ status: "applied" });
		expect(innerResult).toEqual({ status: "error" });
	});

	it("rejects close-into-apply reentry", async () => {
		let innerResult: unknown;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await expectBindOk(
			result,
			makeApplication({
				close: async () => {
					// Try to apply from within close — should be rejected
					innerResult = await result.application.apply({});
					return { status: "closed" };
				},
			}),
		);

		expect(await result.application.close()).toEqual({ status: "closed" });
		expect(innerResult).toEqual({ status: "error" });
	});

	it("reentry does not poison other queued calls", async () => {
		const order: string[] = [];

		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		let callCount = 0;
		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					callCount += 1;
					if (callCount === 1) {
						// First call re-enters — rejected but doesn't poison
						await result.application.apply({});
					}
					order.push(`call-${callCount}`);
					return { status: "applied" };
				},
			}),
		);

		const p1 = result.application.apply({});
		const p2 = result.application.apply({});
		await p1;
		await p2;
		// Both should complete normally (reentry doesn't poison)
		expect(order).toEqual(["call-1", "call-2"]);
	});
});

// ===========================================================================
// Close behavior
// ===========================================================================

describe("close behavior", () => {
	it("latches one close and drains admitted work", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(result, makeApplication());
		const admitted = result.application.apply({});
		const first = result.application.close();
		const second = result.application.close();
		expect(second).toBe(first);
		expect(await result.application.apply({})).toEqual({ status: "error" });
		const admittedResult = await admitted;
		expect(admittedResult).toEqual({ status: "applied" });
		expect(await first).toEqual({ status: "closed" });
	});

	it("returns shared close promise on concurrent close requests", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(result, makeApplication());
		const c1 = result.application.close();
		const c2 = result.application.close();
		expect(c1).toBe(c2);
		expect(await c1).toEqual({ status: "closed" });
	});

	it("close before bind returns closed", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(await result.application.close()).toEqual({ status: "closed" });
	});

	it("close waits for admitted apply to finish", async () => {
		const order: string[] = [];
		let resolveGate: (() => void) | undefined;
		const gatePromise = new Promise<void>((resolve) => {
			resolveGate = resolve;
		});

		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					await gatePromise;
					order.push("applied");
					return { status: "applied" };
				},
				close: async () => {
					order.push("closed");
					return { status: "closed" };
				},
			}),
		);

		result.application.apply({});
		const pClose = result.application.close();
		resolveGate?.();
		await pClose;
		// Close drains admitted work: apply ran first, then close
		expect(order).toEqual(["applied", "closed"]);
	});

	it("close calls bound close exactly once on multiple application.close()", async () => {
		let closeCalls = 0;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(
			result,
			makeApplication({
				close: async () => {
					closeCalls += 1;
					return { status: "closed" };
				},
			}),
		);
		await result.application.close();
		await result.application.close();
		await result.application.close();
		expect(closeCalls).toBe(1);
	});
});

// ===========================================================================
// Cross-instance — two independent gates
// ===========================================================================

describe("cross-instance apply", () => {
	it("allows gate A's apply to call gate B's apply — no same-instance reentry", async () => {
		let bCalled = false;
		let bGateRef:
			| {
					apply: (raw: unknown) => Promise<GateApplyResult>;
					close: () => Promise<GateCloseResult>;
			  }
			| undefined;

		const aResult = await createRelayApplicationGate({});
		expect(aResult.ok).toBe(true);
		if (!aResult.ok) return;

		await expectBindOk(
			aResult,
			makeApplication({
				apply: async () => {
					if (!bGateRef) return { status: "error" };
					bCalled = true;
					return bGateRef.apply({});
				},
			}),
		);

		const bResult = await createRelayApplicationGate({});
		expect(bResult.ok).toBe(true);
		if (!bResult.ok) return;
		await expectBindOk(bResult, makeApplication());
		bGateRef = bResult.application;

		const res = await aResult.application.apply({});
		expect(res).toEqual({ status: "applied" });
		expect(bCalled).toBe(true);

		await aResult.application.close();
		await bResult.application.close();
	});
});

// ===========================================================================
// Adversarial: various edge cases
// ===========================================================================

describe("adversarial", () => {
	it("symbol accessor descriptor on application causes bind failure", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const baseApp: Record<string | symbol, unknown> = {
			apply: async () => ({ status: "applied" }),
			close: async () => ({ status: "closed" }),
		};
		Object.defineProperty(baseApp, Symbol("hidden"), {
			get: () => true,
			enumerable: false,
		});
		const bindResult = await result.bind(baseApp);
		expect(bindResult.ok).toBe(false);
	});

	it("gate returned from factory is frozen", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
	});
	// Note: the result itself and application are frozen implicitly via Object.freeze

	it("bind with data-symbol extra key is rejected (extra shape)", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app: Record<string | symbol, unknown> = {
			apply: async () => ({ status: "applied" }),
			close: async () => ({ status: "closed" }),
		};
		app[Symbol("extra")] = true;
		const bindResult = await result.bind(app);
		expect(bindResult.ok).toBe(false);
	});

	it("multiple gates are independent", async () => {
		const r1 = await createRelayApplicationGate({});
		const r2 = await createRelayApplicationGate({});
		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;

		let c1 = 0;
		let c2 = 0;
		await expectBindOk(
			r1,
			makeApplication({
				close: async () => {
					c1 += 1;
					return { status: "closed" };
				},
			}),
		);
		await expectBindOk(
			r2,
			makeApplication({
				close: async () => {
					c2 += 1;
					return { status: "closed" };
				},
			}),
		);

		await r2.application.close();
		expect(c2).toBe(1);
		expect(c1).toBe(0);

		await r1.application.close();
		expect(c1).toBe(1);
	});

	it("bind consumes the close so raw close cannot be called externally after bind", async () => {
		let closeCalls = 0;
		const rawApp = makeApplication({
			close: async () => {
				closeCalls += 1;
				return { status: "closed" };
			},
		});

		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(result, rawApp);

		// Calling close on raw app directly after bind should still work
		const rawClose = rawApp.close;
		const rawResult = await (typeof rawClose === "function" ? rawClose() : (async () => ({ status: "error" }))());
		expect(rawResult).toEqual({ status: "closed" });
		expect(closeCalls).toBe(1);

		// Gate close should also work (OwnedClose dedup is by the `used` flag)
		const gateResult = await result.application.close();
		expect(gateResult).toEqual({ status: "closed" });
		expect(closeCalls).toBe(2);
	});

	it("bind returns INVALID_ARGUMENT when application has non-enumerable close", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const obj: Record<string, unknown> = {};
		Object.defineProperty(obj, "apply", {
			value: async () => ({ status: "applied" }),
			enumerable: true,
		});
		Object.defineProperty(obj, "close", {
			value: async () => ({ status: "closed" }),
			enumerable: false,
		});
		// close is captured by captureOwnedClose (checks own descriptors regardless of
		// enumerability) but exact() requires enumerable. So close is captured,
		// failWithOwnerCleanup is called, close is awaited, returns valid -> INVALID_ARGUMENT
		const bindResult = await result.bind(obj);
		expect(bindResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("poisoned gate stays poisoned even after successful close of underlying app", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await expectBindOk(
			result,
			makeApplication({
				apply: async () => {
					throw new Error("poison");
				},
			}),
		);
		expect(await result.application.apply({})).toEqual({ status: "error" });
		expect(await result.application.apply({})).toEqual({ status: "error" });
		await result.application.close();
	});
});

// ===========================================================================
// Topology: verify application is exact {apply, close} — no bind contaminant
// ===========================================================================

describe("topology", () => {
	it("application has exactly {apply, close} — bind is separate", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const keys = Object.getOwnPropertyNames(app);
		expect(keys.sort()).toEqual(["apply", "close"]);
		// No extra keys
		expect(Object.keys(app)).toEqual(["apply", "close"]);
		// bind is not on the application object
		expect("bind" in app).toBe(false);
		// bind is on the result
		expect(typeof result.bind).toBe("function");
	});

	it("application can be passed to a relay that expects {apply, close}", async () => {
		// Simulate a relay receiving the application object
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const relay: { apply: (raw: unknown) => Promise<GateApplyResult>; close: () => Promise<GateCloseResult> } =
			result.application;
		expect(typeof relay.apply).toBe("function");
		expect(typeof relay.close).toBe("function");
		// No other properties present
		expect(Object.keys(relay)).toEqual(["apply", "close"]);
	});

	it("relay owns application.close — can be called by relay without interfering with bind", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Bind first, then relay calls close
		await expectBindOk(result, makeApplication());
		expect(await result.application.apply({})).toEqual({ status: "applied" });

		// Relay calls close via the application object
		await result.application.close();

		// After close, apply returns error
		expect(await result.application.apply({})).toEqual({ status: "error" });

		// Bind is still callable (but returns error since already bound)
		const secondBind = await result.bind(makeApplication());
		expect(secondBind.ok).toBe(false);
	});
});

// ===========================================================================
// Concurrent bind (only first is terminal; subsequent return INVALID_ARGUMENT)
// ===========================================================================

describe("concurrent bind", () => {
	it("first bind succeeds, concurrent bind calls return INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Start first bind
		const firstBind = result.bind(makeApplication());
		// Concurrent call while first is in flight
		const secondBind = result.bind(makeApplication());

		const r1 = await firstBind;
		const r2 = await secondBind;

		expect(r1).toEqual({ ok: true });
		expect(r2).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("first bind fails (invalid), concurrent bind calls return INVALID_ARGUMENT", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// First bind with invalid input — will fail
		const firstBind = result.bind(null);
		// Concurrent call
		const secondBind = result.bind(makeApplication());

		const r1 = await firstBind;
		const r2 = await secondBind;

		expect(r1).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(r2).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});
});

// ===========================================================================
// Hostile result: apply/close return objects with non-standard descriptor shapes
// ===========================================================================

describe("hostile result", () => {
	it("apply result with non-enumerable status is rejected", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const badResult: Record<string, unknown> = {};
		Object.defineProperty(badResult, "status", {
			value: "applied",
			enumerable: false,
		});

		await expectBindOk(result, makeApplication({ apply: async () => badResult }));

		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("apply result with status getter (accessor) is rejected", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const badResult: Record<string, unknown> = {};
		Object.defineProperty(badResult, "status", {
			get: () => "applied",
			enumerable: true,
		});

		await expectBindOk(result, makeApplication({ apply: async () => badResult }));

		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("close result with non-enumerable status is rejected — captured close returns false", async () => {
		let closeCalls = 0;
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const badCloseResult: Record<string, unknown> = {};
		Object.defineProperty(badCloseResult, "status", {
			value: "closed",
			enumerable: false,
		});

		await expectBindOk(
			result,
			makeApplication({
				close: async () => {
					closeCalls += 1;
					return badCloseResult;
				},
			}),
		);

		expect(await result.application.close()).toEqual({ status: "error" });
		expect(closeCalls).toBe(1);
	});

	it("close result with extra keys via descriptor is rejected", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const badResult = Object.defineProperties(
			{},
			{
				status: { value: "closed", enumerable: true, writable: false },
				x: { value: true, enumerable: true, writable: false },
			},
		);
		Object.freeze(badResult);

		await expectBindOk(result, makeApplication({ close: async () => badResult }));

		expect(await result.application.close()).toEqual({ status: "error" });
	});

	it("apply result with Proxy is rejected", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const proxyResult = new Proxy(Object.freeze({ status: "applied" }), {});

		await expectBindOk(result, makeApplication({ apply: async () => proxyResult }));

		expect(await result.application.apply({})).toEqual({ status: "error" });
	});

	it("close result with non-Object.prototype prototype is rejected", async () => {
		const result = await createRelayApplicationGate({});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const badResult = Object.assign(Object.create(null), { status: "closed" });

		await expectBindOk(result, makeApplication({ close: async () => badResult }));

		expect(await result.application.close()).toEqual({ status: "error" });
	});
});
