/**
 * sandbox-command-effect.test.ts — controlled tests for the codec-backed
 * command effect port.
 *
 * Uses real branded createHarness session plus Object.defineProperty
 * overrides returning exact deferred/rejected/non-native values.
 * Proves synchronous method call, pending completion, rejection mapping,
 * same close Promise identity, abort rejection and sync abort exceptions,
 * original-task joining, no post-close effects, exact completion Promise.
 * Zero casts, assertions, any, skips, dynamic imports.
 */

import { types } from "node:util";
import { describe, expect, test } from "vitest";
import { isAgentSessionInstance } from "../src/core/agent-session.js";
import {
	createSandboxCommandEffect,
	isSandboxCommandEffectInstance,
	type SandboxCommandEffectCapability,
} from "../src/modes/daemon/sandbox-command-effect.js";
import { createHarness } from "./suite/harness.js";

// ===========================================================================
// Frame builder
// ===========================================================================

function bodyFrame(body: Record<string, unknown>): Record<string, unknown> {
	return { type: "command", commandId: "test", body };
}

// ===========================================================================
// Helpers
// ===========================================================================

function defer(): {
	promise: Promise<unknown>;
	resolve: (v: unknown) => void;
	reject: (e: unknown) => void;
} {
	let resolve: (v: unknown) => void = () => {};
	let reject: (e: unknown) => void = () => {};
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Create a harness, apply overrides via own-property descriptor,
 *  and patch cleanup so descriptors are restored. */
async function withOverrides(
	// biome-ignore lint/complexity/noBannedTypes: general function storage for Object.defineProperty
	overrides: Record<string, Function>,
	models?: Array<{ id: string }>,
): Promise<{
	harness: Awaited<ReturnType<typeof createHarness>>;
	capability: SandboxCommandEffectCapability;
}> {
	const h = await createHarness(models ? { models } : {});
	const session = h.session;
	const saved: Array<{ key: string; desc: PropertyDescriptor | undefined }> = [];
	for (const key of Object.keys(overrides)) {
		saved.push({ key, desc: Object.getOwnPropertyDescriptor(session, key) });
		Object.defineProperty(session, key, {
			value: overrides[key],
			configurable: true,
			writable: true,
		});
	}
	const restore = (): void => {
		for (const { key, desc } of saved) {
			if (desc) {
				Object.defineProperty(session, key, desc);
			} else {
				Reflect.deleteProperty(session, key);
			}
		}
	};
	const result = createSandboxCommandEffect(session);
	if (!result.ok) throw new Error("expected ok factory result");
	const origCleanup = h.cleanup.bind(h);
	h.cleanup = () => {
		restore();
		origCleanup();
	};
	return { harness: h, capability: result.capability };
}

// ===========================================================================
// Factory
// ===========================================================================

describe("factory (createSandboxCommandEffect)", () => {
	test("returns INVALID_SESSION for null", () => {
		const r = createSandboxCommandEffect(null);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error.code).toBe("INVALID_SESSION");
	});

	test("returns INVALID_SESSION for undefined", () => {
		const r = createSandboxCommandEffect(undefined);
		if (!r.ok) expect(r.error.code).toBe("INVALID_SESSION");
	});

	test("returns INVALID_SESSION for plain object", () => {
		const r = createSandboxCommandEffect({});
		if (!r.ok) expect(r.error.code).toBe("INVALID_SESSION");
	});

	test("returns INVALID_SESSION for mock-like object with abort method", () => {
		const r = createSandboxCommandEffect({ abort: () => {} });
		if (!r.ok) expect(r.error.code).toBe("INVALID_SESSION");
	});

	test("returns ok capability for branded session", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(typeof r.capability.execute).toBe("function");
				expect(typeof r.capability.close).toBe("function");
			}
		} finally {
			h.cleanup();
		}
	});

	test("capability is frozen", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			expect(Object.isFrozen(r.capability)).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Codec attacks
// ===========================================================================

// ===========================================================================
// WeakSet brand
// ===========================================================================

describe("WeakSet brand (isSandboxCommandEffectInstance)", () => {
	test("returns false for null", () => {
		expect(isSandboxCommandEffectInstance(null)).toBe(false);
	});

	test("returns false for undefined", () => {
		expect(isSandboxCommandEffectInstance(undefined)).toBe(false);
	});

	test("returns false for plain object", () => {
		expect(isSandboxCommandEffectInstance({})).toBe(false);
	});

	test("returns false for number", () => {
		expect(isSandboxCommandEffectInstance(42)).toBe(false);
	});

	test("returns true for actual capability from factory", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			expect(isSandboxCommandEffectInstance(r.capability)).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("capability is frozen", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			expect(Object.isFrozen(r.capability)).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});
describe("codec attacks", () => {
	test("Proxy frame is rejected (INVALID_INPUT)", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const proxy = new Proxy(
				{ type: "command", commandId: "p1", body: { type: "abort" } },
				{
					get() {
						return "trapped";
					},
					ownKeys() {
						return [];
					},
					getOwnPropertyDescriptor() {
						return undefined;
					},
				},
			);
			const handle = r.capability.execute(proxy);
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INVALID_INPUT");
		} finally {
			h.cleanup();
		}
	});

	test("accessor property on frame is rejected by codec", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const obj: Record<string, unknown> = {
				type: "command",
				commandId: "a1",
				body: { type: "abort" },
			};
			Object.defineProperty(obj, "body", {
				get() {
					return { type: "abort" };
				},
				enumerable: true,
				configurable: true,
			});
			const handle = r.capability.execute(obj);
			const result = await handle.completion;
			expect(result.ok).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	test("extra fields at frame level are rejected by codec", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const handle = r.capability.execute({
				type: "command",
				commandId: "test",
				body: { type: "abort" },
				extra: "nope",
			});
			const result = await handle.completion;
			expect(result.ok).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	test("non-plain-object input is rejected by codec", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const handle = r.capability.execute("nope");
			const result = await handle.completion;
			expect(result.ok).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	test("null input is rejected by codec", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const handle = r.capability.execute(null);
			const result = await handle.completion;
			expect(result.ok).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	test("symbol-owning object is rejected by codec", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const obj = {
				type: "command",
				commandId: "sym",
				body: { type: "abort" },
			};
			Object.defineProperty(obj, Symbol("x"), { value: "secret", enumerable: true });
			const handle = r.capability.execute(obj);
			const result = await handle.completion;
			expect(result.ok).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Unsupported commands
// ===========================================================================

describe("unsupported commands", () => {
	const unsupported: Array<{ type: string; fields?: Record<string, unknown> }> = [
		{ type: "create_session", fields: { workspaceId: "ws-1" } },
		{ type: "destroy_session" },
		{ type: "checkpoint" },
		{ type: "wake", fields: { snapshotId: "snap-1" } },
		{ type: "shutdown" },
		{ type: "sync_workspace", fields: { artifact: { workspaceId: "ws-1" } } },
	];

	for (const { type: t, fields } of unsupported) {
		test(`${t} returns UNSUPPORTED_COMMAND`, async () => {
			const h = await createHarness();
			try {
				const r = createSandboxCommandEffect(h.session);
				if (!r.ok) throw new Error("expected ok");
				const handle = r.capability.execute(bodyFrame({ type: t, ...fields }));
				const result = await handle.completion;
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_COMMAND");
			} finally {
				h.cleanup();
			}
		});
	}

	test("unknown command type returns UNSUPPORTED_COMMAND", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const handle = r.capability.execute(bodyFrame({ type: "nonexistent" }));
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_COMMAND");
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Controlled synchronous method call
// ===========================================================================

describe("controlled synchronous method call", () => {
	test("execute returns handle before session method settles — pending completion", async () => {
		let methodCalled = false;
		const d = defer();
		const { harness, capability } = await withOverrides({
			abort: () => {
				methodCalled = true;
				return d.promise;
			},
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			// Method was called synchronously
			expect(methodCalled).toBe(true);
			// Handle exists synchronously
			expect(typeof handle.completion.then).toBe("function");
			expect(handle.commandId).toBe("test");
			expect(Object.isFrozen(handle)).toBe(true);
			// Completion still pending
			let settled = false;
			void handle.completion.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
		} finally {
			d.resolve(undefined);
			harness.cleanup();
		}
	});

	test("completion stays pending until session promise resolves", async () => {
		const d = defer();
		const { harness, capability } = await withOverrides({
			abort: () => d.promise,
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			let settled = false;
			void handle.completion.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			d.resolve(undefined);
			await handle.completion;
			expect(settled).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});

// ===========================================================================
// Controlled rejection mapping
// ===========================================================================

describe("controlled rejection mapping", () => {
	test("session abort rejection becomes INTERNAL_ERROR", async () => {
		const d = defer();
		const { harness, capability } = await withOverrides({
			abort: () => d.promise,
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			d.reject(new Error("session error"));
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
		} finally {
			harness.cleanup();
		}
	});

	test("session sync throw becomes INTERNAL_ERROR", async () => {
		const { harness, capability } = await withOverrides({
			abort: () => {
				throw new Error("sync boom");
			},
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
		} finally {
			harness.cleanup();
		}
	});

	test("non-native session return becomes INTERNAL_ERROR", async () => {
		const { harness, capability } = await withOverrides({
			abort: () => "not-a-promise",
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
		} finally {
			harness.cleanup();
		}
	});

	test("non-Promise-prototype session return becomes INTERNAL_ERROR", async () => {
		// biome-ignore lint/suspicious/noThenProperty: intentional fake thenable for rejection test
		const fake = Object.setPrototypeOf({ then() {} }, null);
		const { harness, capability } = await withOverrides({
			abort: () => fake,
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("INTERNAL_ERROR");
		} finally {
			harness.cleanup();
		}
	});
});

// ===========================================================================
// Controlled close behavior
// ===========================================================================

describe("controlled close behavior", () => {
	test("close with no active tasks settles ok:true", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const result = await r.capability.close();
			expect(result.ok).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("close is idempotent — same close Promise identity", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const p1 = r.capability.close();
			const p2 = r.capability.close();
			expect(p1).toBe(p2);
			const result1 = await p1;
			expect(result1.ok).toBe(true);
			const result2 = await p2;
			expect(result2.ok).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("close waits for active deferred task", async () => {
		const d = defer();
		const { harness, capability } = await withOverrides({
			abort: () => d.promise,
		});
		try {
			capability.execute(bodyFrame({ type: "abort" }));
			let closeSettled = false;
			const closePromise = capability.close();
			void closePromise.then(() => {
				closeSettled = true;
			});
			await Promise.resolve();
			expect(closeSettled).toBe(false);
			d.resolve(undefined);
			await closePromise;
			expect(closeSettled).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("close invokes session.abort for prompt tasks", async () => {
		let abortCalled = false;
		const { harness, capability } = await withOverrides({
			abort: () => {
				abortCalled = true;
				return Promise.resolve(undefined);
			},
		});
		try {
			capability.execute(bodyFrame({ type: "prompt", message: "hi" }));
			const closeResult = await capability.close();
			expect(abortCalled).toBe(true);
			expect(closeResult.ok).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("close catches sync exception from abortBash", async () => {
		const { harness, capability } = await withOverrides({
			promptUntilAccepted: (_msg: string) => Promise.resolve(undefined),
			abort: () => Promise.resolve(undefined),
			abortBash: () => {
				throw new Error("bash abort boom");
			},
		});
		try {
			capability.execute(bodyFrame({ type: "prompt", message: "hi" }));
			capability.execute(bodyFrame({ type: "execute_bash", command: "echo hi" }));
			const closeResult = await capability.close();
			expect(closeResult.ok).toBe(false);
			if (!closeResult.ok) expect(closeResult.error.code).toBe("CLOSE_ABORT_FAILED");
		} finally {
			harness.cleanup();
		}
	});

	test("close catches sync exception from abortCompaction", async () => {
		const { harness, capability } = await withOverrides({
			compact: (_instr: string) => Promise.resolve(undefined),
			abort: () => Promise.resolve(undefined),
			abortCompaction: () => {
				throw new Error("compact abort boom");
			},
		});
		try {
			capability.execute(bodyFrame({ type: "compact" }));
			const closeResult = await capability.close();
			expect(closeResult.ok).toBe(false);
			if (!closeResult.ok) expect(closeResult.error.code).toBe("CLOSE_ABORT_FAILED");
		} finally {
			harness.cleanup();
		}
	});

	test("close joins original tasks and abort tails — close still pending until abort settles", async () => {
		const d1 = defer();
		const d2 = defer();
		const dAbort = defer();
		const { harness, capability } = await withOverrides({
			promptUntilAccepted: (_msg: string) => d1.promise,
			runUserBash: (_cmd: string) => d2.promise,
			abort: () => dAbort.promise,
		});
		try {
			const h1 = capability.execute(bodyFrame({ type: "prompt", message: "hello" }));
			const h2 = capability.execute(bodyFrame({ type: "execute_bash", command: "echo hi" }));

			let closeSettled = false;
			const closePromise = capability.close();
			void closePromise.then(() => {
				closeSettled = true;
			});
			await Promise.resolve();
			expect(closeSettled).toBe(false);

			// Resolve both original tasks — close should still wait for abort tail
			d1.resolve(undefined);
			d2.resolve(undefined);
			await Promise.resolve();
			expect(closeSettled).toBe(false);

			// Now settle the abort tail
			dAbort.resolve(undefined);
			const closeResult = await closePromise;
			expect(closeResult.ok).toBe(true);
			const r1 = await h1.completion;
			expect(r1.ok).toBe(true);
			const r2 = await h2.completion;
			expect(r2.ok).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("abort tail rejection causes CLOSE_ABORT_FAILED after original joins", async () => {
		const d1 = defer();
		const dAbort = defer();
		const { harness, capability } = await withOverrides({
			promptUntilAccepted: (_msg: string) => d1.promise,
			abort: () => dAbort.promise,
		});
		try {
			capability.execute(bodyFrame({ type: "prompt", message: "hello" }));

			let closeSettled = false;
			const closePromise = capability.close();
			void closePromise.then(() => {
				closeSettled = true;
			});
			await Promise.resolve();
			expect(closeSettled).toBe(false);

			// Resolve original task
			d1.resolve(undefined);
			await Promise.resolve();
			expect(closeSettled).toBe(false);

			// Reject abort tail
			dAbort.reject(new Error("abort failed"));
			const closeResult = await closePromise;
			expect(closeResult.ok).toBe(false);
			if (!closeResult.ok) expect(closeResult.error.code).toBe("CLOSE_ABORT_FAILED");
		} finally {
			harness.cleanup();
		}
	});

	test("execute after close returns CLOSED — no post-close effects", async () => {
		let abortCallCount = 0;
		const { harness, capability } = await withOverrides({
			abort: () => {
				abortCallCount += 1;
				return Promise.resolve(undefined);
			},
		});
		try {
			await capability.close();
			// Post-close execute must not call session methods
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			const result = await handle.completion;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("CLOSED");
			expect(abortCallCount).toBe(0);
		} finally {
			harness.cleanup();
		}
	});
});

// ===========================================================================
// Controlled exact completion Promise
// ===========================================================================

describe("controlled exact completion Promise", () => {
	test("completion is an exact native Promise", async () => {
		const { harness, capability } = await withOverrides({
			abort: () => Promise.resolve(undefined),
		});
		try {
			const handle = capability.execute(bodyFrame({ type: "abort" }));
			const p = handle.completion;
			expect(types.isPromise(p)).toBe(true);
			expect(Object.getPrototypeOf(p)).toBe(Promise.prototype);
			expect(Object.getOwnPropertyNames(p).length).toBe(0);
			expect(Object.getOwnPropertySymbols(p).length).toBe(0);
			const result = await p;
			expect(result.ok).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	test("completion resolves to fresh frozen result", async () => {
		const { harness, capability } = await withOverrides({
			abort: () => Promise.resolve(undefined),
		});
		try {
			const h1 = capability.execute(bodyFrame({ type: "abort" }));
			const h2 = capability.execute(bodyFrame({ type: "abort" }));
			const r1 = await h1.completion;
			const r2 = await h2.completion;
			expect(r1).not.toBe(r2);
			expect(Object.isFrozen(r1)).toBe(true);
			expect(Object.isFrozen(r2)).toBe(true);
		} finally {
			harness.cleanup();
		}
	});
});

// ===========================================================================
// Handle integrity
// ===========================================================================

describe("handle integrity", () => {
	test("handle is frozen with correct shape, no abort method", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const handle = r.capability.execute(bodyFrame({ type: "abort" }));
			expect(Object.isFrozen(handle)).toBe(true);
			expect(Object.keys(handle).sort()).toEqual(["commandId", "completion"]);
			expect("abort" in handle).toBe(false);
			await handle.completion;
		} finally {
			h.cleanup();
		}
	});

	test("commandId from frame is preserved", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const handle = r.capability.execute({
				type: "command",
				commandId: "my-custom-id",
				body: { type: "abort" },
			});
			expect(handle.commandId).toBe("my-custom-id");
			await handle.completion;
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Freshness — no shared result objects
// ===========================================================================

describe("freshness — no shared result objects", () => {
	test("each completion resolves to a fresh frozen result", async () => {
		const { harness, capability } = await withOverrides({
			abort: () => Promise.resolve(undefined),
		});
		try {
			const h1 = capability.execute(bodyFrame({ type: "abort" }));
			const h2 = capability.execute(bodyFrame({ type: "abort" }));
			const r1 = await h1.completion;
			const r2 = await h2.completion;
			expect(r1).not.toBe(r2);
		} finally {
			harness.cleanup();
		}
	});

	test("error results are fresh per call", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			const h1 = r.capability.execute("nope");
			const h2 = r.capability.execute("nope2");
			const r1 = await h1.completion;
			const r2 = await h2.completion;
			expect(r1).not.toBe(r2);
		} finally {
			h.cleanup();
		}
	});

	test("post-close CLOSED error is fresh per call", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("expected ok");
			await r.capability.close();
			const h1 = r.capability.execute(bodyFrame({ type: "abort" }));
			const h2 = r.capability.execute(bodyFrame({ type: "abort" }));
			const r1 = await h1.completion;
			const r2 = await h2.completion;
			expect(r1).not.toBe(r2);
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Non-owning boundary
// ===========================================================================

describe("non-owning boundary", () => {
	test("session is still branded after capability creation and use", async () => {
		const h = await createHarness();
		try {
			const r = createSandboxCommandEffect(h.session);
			expect(isAgentSessionInstance(h.session)).toBe(true);
			if (r.ok) {
				await r.capability.execute(bodyFrame({ type: "abort" })).completion;
				expect(isAgentSessionInstance(h.session)).toBe(true);
			}
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Post-factory mutation — captured methods ignore session replacement
// ===========================================================================

describe("post-factory mutation resistance", () => {
	test("session method replacement after factory is ignored by captured method", async () => {
		const h = await createHarness();
		try {
			// 1. Create effect with a known abort that returns good result
			let initialAbortCalled = false;
			const savedAbort = Object.getOwnPropertyDescriptor(h.session, "abort");
			Object.defineProperty(h.session, "abort", {
				value: () => {
					initialAbortCalled = true;
					return Promise.resolve(undefined);
				},
				configurable: true,
				writable: true,
			});

			const r = createSandboxCommandEffect(h.session);
			if (!r.ok) throw new Error("effect failed");

			// 2. Replace session.abort with a different function
			let replacementAbortCalled = false;
			Object.defineProperty(h.session, "abort", {
				value: () => {
					replacementAbortCalled = true;
					return Promise.resolve(undefined);
				},
				configurable: true,
				writable: true,
			});

			// 3. Execute via the captured capability — should use original, not replacement
			const handle = r.capability.execute({
				type: "command",
				commandId: "mutation1",
				body: { type: "abort" },
			});
			await handle.completion;

			expect(initialAbortCalled).toBe(true);
			expect(replacementAbortCalled).toBe(false);

			if (savedAbort) {
				Object.defineProperty(h.session, "abort", savedAbort);
			} else {
				Reflect.deleteProperty(h.session, "abort");
			}
		} finally {
			h.cleanup();
		}
	});
});
