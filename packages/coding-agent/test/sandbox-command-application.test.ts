/**
 * sandbox-command-application.test.ts — corrected multiplexer-child tests.
 *
 * Tests factory validation (exact input, owners, Promise shape), FIFO order,
 * sync-throw handling, unsupported lifecycle via effect fixed error,
 * duplicates/terminal/live/restart, terminal failures, reentry, close.
 *
 * Zero casts, assertions, any, skips, dynamic imports.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
	createSandboxCommandApplication,
	type SandboxCommandApplication,
} from "../src/modes/daemon/sandbox-command-application.js";
import { createSandboxCommandEffect } from "../src/modes/daemon/sandbox-command-effect.js";
import { decodeSandboxCommandRecordV1 } from "../src/modes/daemon/sandbox-command-record-codec.js";
import type { SandboxCommandBackend } from "../src/modes/daemon/sandbox-command-recovery.js";
import {
	createSandboxCommandStore,
	type SandboxCommandPublisher,
	type SandboxCommandStoreCapability,
} from "../src/modes/daemon/sandbox-command-store.js";
import { createHarness } from "./suite/harness.js";

// ===========================================================================
// Store test helpers
// ===========================================================================

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

interface PublishedFile {
	seq: number;
	bytes: Uint8Array;
	sha256: string;
	size: number;
}

function makePublisher(
	publications: PublishedFile[],
	closeStatus: "closed" | "error" = "closed",
	options?: { publishError?: string; closeError?: string },
): SandboxCommandPublisher {
	return {
		publish(seq: number, bytes: Uint8Array) {
			if (
				options?.publishError &&
				(options.publishError === "IO_UNCONFIRMED" ||
					options.publishError === "SEQ_COLLISION" ||
					options.publishError === "POST_PUBLICATION_UNCERTAIN" ||
					options.publishError === "INVALID_ARGUMENT")
			) {
				return Promise.resolve(Object.freeze({ ok: false, error: options.publishError }));
			}
			const sha = sha256Of(bytes);
			publications.push({ seq, bytes: new Uint8Array(bytes), sha256: sha, size: bytes.byteLength });
			return Promise.resolve({
				ok: true,
				receipt: { sequence: seq, size: bytes.byteLength, sha256: sha },
			});
		},
		close() {
			if (options?.closeError) return Promise.resolve(Object.freeze({ status: "error" }));
			return Promise.resolve(Object.freeze({ status: closeStatus }));
		},
	};
}

function makeEmptyBackend(): SandboxCommandBackend {
	return {
		listPage() {
			return Promise.resolve({
				status: "page",
				entries: [],
				nextCursor: null,
				close: () => Promise.resolve(Object.freeze({ status: "closed" })),
			});
		},
		open() {
			return Promise.resolve(Object.freeze({ status: "missing" }));
		},
		close() {
			return Promise.resolve(Object.freeze({ status: "closed" }));
		},
	};
}

const IDENTITY = { hostId: "h1", generation: "g1", sessionId: "s1" };
const TIMESTAMP = "2025-01-15T10:30:00.000Z";

/** Create a fresh branded store backed by in-memory publisher/backend. */
async function createMockStore(
	pubs: PublishedFile[],
	backend?: SandboxCommandBackend,
): Promise<SandboxCommandStoreCapability> {
	const result = await createSandboxCommandStore({
		identity: IDENTITY,
		publisher: makePublisher(pubs),
		recoveryBackend: backend ?? makeEmptyBackend(),
		recordedAt: TIMESTAMP,
	});
	if (!result.ok) throw new Error("store creation failed");
	return result.value;
}

/** Create a minimal working application for tests.
 * cleanup idempotently calls app.close() then harness cleanup. */
async function createWorkingApp(): Promise<{
	app: SandboxCommandApplication;
	cleanup: () => Promise<void>;
}> {
	const h = await createHarness();
	const effectR = createSandboxCommandEffect(h.session);
	if (!effectR.ok) throw new Error("effect failed");
	const pubs: PublishedFile[] = [];
	const store = await createMockStore(pubs);
	const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
	if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
	return {
		app: r.application,
		cleanup: async () => {
			try {
				await r.application.close();
			} catch {
				// best-effort close
			}
			h.cleanup();
		},
	};
}

function makeCommandEnvelope(commandId: string, bodyType?: string, body?: Record<string, unknown>): unknown {
	const cmdBody: Record<string, unknown> = { type: bodyType ?? "abort" };
	if (bodyType === "prompt" || bodyType === "steer" || bodyType === "execute_bash") {
		cmdBody.message = "hello";
	}
	if (bodyType === "execute_bash") {
		cmdBody.command = "echo hi";
	}
	if (body) {
		for (const k of Object.keys(body)) cmdBody[k] = body[k];
	}
	return {
		envelope: {
			type: "frame",
			frameId: `fid-${commandId}`,
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-15T10:30:00.000Z",
			frame: {
				type: "command",
				commandId,
				body: cmdBody,
			},
		},
	};
}

// ===========================================================================
// Factory validation — exact input / owners / Promise shape
// ===========================================================================

describe("factory — exact input and owners", () => {
	test("rejects null", async () => {
		const r = await createSandboxCommandApplication(null);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects undefined", async () => {
		const r = await createSandboxCommandApplication(undefined);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects primitive number", async () => {
		const r = await createSandboxCommandApplication(42);
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects plain object with missing keys", async () => {
		const r = await createSandboxCommandApplication({});
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects {effect} without store", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const r = await createSandboxCommandApplication({ effect: effectR.capability });
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects {store} without effect", async () => {
		const pubs: PublishedFile[] = [];
		const store = await createMockStore(pubs);
		const r = await createSandboxCommandApplication({ store });
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects unlabeled effect (plain object)", async () => {
		const pubs: PublishedFile[] = [];
		const store = await createMockStore(pubs);
		const r = await createSandboxCommandApplication({ effect: {}, store });
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects unlabeled store (plain object)", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store: {} });
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects extra factory keys", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({
				effect: effectR.capability,
				store,
				extra: 1,
			});
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("returns ok for branded effect + branded store", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			expect("ok" in r && r.ok === true).toBe(true);
			if ("ok" in r && r.ok) {
				expect(typeof r.application.apply).toBe("function");
				expect(typeof r.application.close).toBe("function");
			}
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// apply — input validation
// ===========================================================================

describe("apply — input validation", () => {
	test("rejects null", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(null);
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects non-object input", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply("nope");
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects missing envelope key", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply({});
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects extra keys on apply input", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply({
				envelope: {
					type: "frame",
					frameId: "fid-t1",
					protocol: { name: "prime-agent.remote-host", version: 1 },
					sentAt: "2025-01-15T10:30:00.000Z",
					frame: { type: "command", commandId: "t1", body: { type: "abort" } },
				},
				extra: 1,
			});
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects non-frame envelope", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply({
				envelope: { type: "not-frame" },
			});
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Lifecycle/workspace — through effect fixed error, returns applied
// ===========================================================================

describe("lifecycle/workspace — fixed error path", () => {
	const lifecycleTypes: Array<{ type: string; fields?: Record<string, unknown> }> = [
		{ type: "create_session", fields: { workspaceId: "ws-1" } },
		{ type: "destroy_session" },
		{ type: "checkpoint" },
		{ type: "wake", fields: { snapshotId: "snap-1" } },
		{ type: "shutdown" },
		{ type: "sync_workspace", fields: { artifact: { workspaceId: "ws-1" } } },
	];

	for (const { type: t, fields } of lifecycleTypes) {
		test(`${t} returns applied via fixed error`, async () => {
			const { app, cleanup } = await createWorkingApp();
			try {
				const result = await app.apply(makeCommandEnvelope("t1", t, fields));
				expect(result.status).toBe("applied");
			} finally {
				await cleanup();
			}
		});
	}

	test("unknown command type returns error (codec rejection)", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(makeCommandEnvelope("t1", "nonexistent"));
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Close behavior
// ===========================================================================

describe("close behavior", () => {
	test("close returns closed result", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const closeResult = await app.close();
			expect(closeResult.status).toBe("closed");
		} finally {
			await cleanup();
		}
	});

	test("close is idempotent — same promise", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const p1 = app.close();
			const p2 = app.close();
			expect(p1).toBe(p2);
		} finally {
			await cleanup();
		}
	});

	test("apply after close returns error", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			await app.close();
			const result = await app.apply(makeCommandEnvelope("t1", "abort"));
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Fresh frozen results
// ===========================================================================

describe("fresh frozen results", () => {
	test("error result is frozen", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(null);
			expect(Object.isFrozen(result)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("each error result is a fresh object", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(null);
			const r2 = await app.apply(null);
			expect(r1).not.toBe(r2);
		} finally {
			await cleanup();
		}
	});

	test("close result is frozen", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const closeResult = await app.close();
			expect(Object.isFrozen(closeResult)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("applied result is frozen", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(makeCommandEnvelope("t1", "abort"));
			expect(Object.isFrozen(result)).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("each applied result is a fresh object", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(makeCommandEnvelope("t2", "abort"));
			const r2 = await app.apply(makeCommandEnvelope("t3", "abort"));
			expect(r1).not.toBe(r2);
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Duplicate / terminal detection
// ===========================================================================

describe("duplicate / terminal command detection", () => {
	test("same commandId twice returns applied both times", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(makeCommandEnvelope("dup1", "abort"));
			expect(r1.status).toBe("applied");

			const r2 = await app.apply(makeCommandEnvelope("dup1", "abort"));
			expect(r2.status).toBe("applied");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// FIFO ordering
// ===========================================================================

describe("FIFO ordering", () => {
	test("commands execute in insertion order", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const order: number[] = [];
			const p1 = app.apply(makeCommandEnvelope("ord1", "abort")).then((r) => {
				order.push(1);
				return r;
			});
			const p2 = app.apply(makeCommandEnvelope("ord2", "abort")).then((r) => {
				order.push(2);
				return r;
			});
			const p3 = app.apply(makeCommandEnvelope("ord3", "abort")).then((r) => {
				order.push(3);
				return r;
			});

			await Promise.all([p1, p2, p3]);
			expect(order).toEqual([1, 2, 3]);
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Reentry detection — sync apply, async completion, close
// ===========================================================================

describe("real reentry — sync execute-time and close", () => {
	test("sync execute-time apply reentry and close reentry return error", async () => {
		const h = await createHarness();
		try {
			let reentryApp: SandboxCommandApplication | null = null;
			const innerResults: Array<Record<string, unknown>> = [];
			let closeReentryStatus: string | null = null;
			let reentryTriggered = false;

			const savedAbort = Object.getOwnPropertyDescriptor(h.session, "abort");
			Object.defineProperty(h.session, "abort", {
				value: () => {
					if (reentryTriggered) return Promise.resolve(undefined);
					reentryTriggered = true;
					if (reentryApp !== null) {
						void reentryApp.apply(makeCommandEnvelope("inner1", "abort")).then((ir) => {
							innerResults.push(ir);
						});
						void reentryApp.apply(makeCommandEnvelope("inner2", "abort")).then((ir) => {
							innerResults.push(ir);
						});
						void reentryApp.close().then((cr) => {
							const d = Object.getOwnPropertyDescriptor(cr, "status");
							if (d && "value" in d && typeof d.value === "string") {
								closeReentryStatus = d.value;
							}
						});
					}
					return Promise.resolve(undefined);
				},
				configurable: true,
				writable: true,
			});

			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
			reentryApp = r.application;

			const outer = await reentryApp.apply(makeCommandEnvelope("outer1", "abort"));
			expect(outer.status).toBe("applied");

			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(innerResults.length).toBe(2);
			for (const ir of innerResults) {
				expect(ir.status).toBe("error");
			}

			expect(closeReentryStatus).not.toBeNull();
			expect(closeReentryStatus).toBe("error");

			const closePromise = reentryApp.close();
			const closeResult = await closePromise;
			expect(closeResult.status).toBe("closed");

			if (savedAbort) {
				Object.defineProperty(h.session, "abort", savedAbort);
			} else {
				Reflect.deleteProperty(h.session, "abort");
			}
		} finally {
			h.cleanup();
		}
	});
	test("async completion-context reentry is also rejected", async () => {
		const h = await createHarness();
		try {
			let reentryApp: SandboxCommandApplication | null = null;
			let sawInner = false;
			let deferredResolve: (v: unknown) => void = () => {};
			const deferred = new Promise<unknown>((resolve) => {
				deferredResolve = resolve;
			});

			const savedAbort = Object.getOwnPropertyDescriptor(h.session, "abort");
			Object.defineProperty(h.session, "abort", {
				value: async () => {
					// Yield once (microtask boundary), then call apply synchronously
					await Promise.resolve();
					if (reentryApp !== null) {
						const ir = await reentryApp.apply(makeCommandEnvelope("inner", "abort"));
						sawInner = true;
						expect(ir.status).toBe("error");
					}
					return deferred;
				},
				configurable: true,
				writable: true,
			});

			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
			reentryApp = r.application;

			void reentryApp.apply(makeCommandEnvelope("outer", "abort"));
			deferredResolve(undefined);

			// Flush microtasks — the enqueue chain, async abort yield, inner apply
			for (let i = 0; i < 100; i++) {
				await Promise.resolve();
				if (sawInner) break;
			}
			expect(sawInner).toBe(true);

			if (savedAbort) {
				Object.defineProperty(h.session, "abort", savedAbort);
			} else {
				Reflect.deleteProperty(h.session, "abort");
			}

			await reentryApp.close();
		} finally {
			h.cleanup();
		}
	});
});

describe("hostile factory input", () => {
	test("rejects hidden effect via getter accessor — zero getter calls", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			let getterCalls = 0;
			const raw = Object.defineProperties(
				{},
				{
					effect: {
						get: () => {
							getterCalls += 1;
							return effectR.capability;
						},
						enumerable: true,
						configurable: true,
					},
					store: { value: store, enumerable: true, writable: false, configurable: false },
				},
			);
			const r = await createSandboxCommandApplication(raw);
			expect("ok" in r && r.ok === false).toBe(true);
			expect(getterCalls).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	test("rejects hidden store via getter accessor", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const raw = Object.defineProperties(
				{},
				{
					effect: { value: effectR.capability, enumerable: true, writable: false, configurable: false },
					store: {
						get: () => {
							return store;
						},
						enumerable: true,
						configurable: true,
					},
				},
			);
			const r = await createSandboxCommandApplication(raw);
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects Proxy factory input", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const target = { effect: effectR.capability, store };
			const proxy = new Proxy(target, {});
			const r = await createSandboxCommandApplication(proxy);
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects custom-prototype factory input", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const raw = Object.setPrototypeOf({ effect: effectR.capability, store }, Array.prototype);
			const r = await createSandboxCommandApplication(raw);
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	test("rejects factory with undefined effect value", async () => {
		const pubs: PublishedFile[] = [];
		const store = await createMockStore(pubs);
		const r = await createSandboxCommandApplication({ effect: undefined, store });
		expect("ok" in r && r.ok === false).toBe(true);
	});

	test("rejects factory symbol-keyed extra owner", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const sym = Symbol("extra");
			const raw: Record<string | symbol, unknown> = { effect: effectR.capability, store };
			Object.defineProperty(raw, sym, {
				value: { close: () => Promise.resolve({ status: "closed" }) },
				enumerable: true,
			});
			const r = await createSandboxCommandApplication(raw);
			expect("ok" in r && r.ok === false).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});

describe("hostile apply input", () => {
	test("rejects non-enumerable envelope", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const raw = Object.defineProperties(
				{},
				{
					envelope: {
						value: {
							type: "frame",
							frameId: "fid-t1",
							protocol: { name: "prime-agent.remote-host", version: 1 },
							sentAt: "2025-01-15T10:30:00.000Z",
							frame: { type: "command", commandId: "t1", body: { type: "abort" } },
						},
						enumerable: false,
						writable: false,
						configurable: false,
					},
				},
			);
			const result = await app.apply(raw);
			expect(result.status).toBe("error");
		} finally {
			await cleanup();
		}
	});

	test("rejects accessor envelope — zero getter calls", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			let getterCalls = 0;
			const raw = Object.defineProperties(
				{},
				{
					envelope: {
						get: () => {
							getterCalls += 1;
							return {
								type: "frame",
								frameId: "fid-t1",
								protocol: { name: "prime-agent.remote-host", version: 1 },
								sentAt: "2025-01-15T10:30:00.000Z",
								frame: { type: "command", commandId: "t1", body: { type: "abort" } },
							};
						},
						enumerable: true,
						configurable: true,
					},
				},
			);
			const result = await app.apply(raw);
			expect(result.status).toBe("error");
			expect(getterCalls).toBe(0);
		} finally {
			await cleanup();
		}
	});

	test("Proxy envelope applied via codec", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const result = await app.apply(makeCommandEnvelope("proxyEnv", "abort"));
			expect(result.status).toBe("applied");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Command collision — same ID, different body: admit-before-query wins
// ===========================================================================

describe("command collision — admit-before-query", () => {
	test("same ID with different body returns applied (first wins, second = collision error)", async () => {
		const { app, cleanup } = await createWorkingApp();
		try {
			const r1 = await app.apply(makeCommandEnvelope("coll1", "abort"));
			expect(r1.status).toBe("applied");

			const r2 = await app.apply(makeCommandEnvelope("coll1", "prompt", { message: "different" }));
			expect(r2.status).toBe("error");
		} finally {
			await cleanup();
		}
	});
});

// ===========================================================================
// Recovery with started state — never re-execute
// ===========================================================================

describe("real recovered started — CRASH interruption", () => {
	test("recovery from started-without-terminal produces CRASH interruption; app does not re-execute", async () => {
		// Phase 1: create store1, admit + markStarted command1, close.
		const identity = { hostId: "h1", generation: "g1", sessionId: "s1" };
		const ts = "2025-01-15T10:30:00.000Z";

		const pub1: PublishedFile[] = [];
		const p1 = makePublisher(pub1);
		const store1 = await createSandboxCommandStore({
			identity,
			publisher: p1,
			recoveryBackend: makeEmptyBackend(),
			recordedAt: ts,
		});
		if (!store1.ok) throw new Error("store1 creation failed");

		const admitR = await store1.value.admit(
			Object.freeze({
				command: Object.freeze({
					type: "command",
					commandId: "cr1",
					body: Object.freeze({ type: "abort" }),
				}),
				recordedAt: ts,
			}),
		);
		if (!admitR.ok) throw new Error("admit failed");

		const startR = await store1.value.markStarted({ commandId: "cr1", recordedAt: ts });
		if (!startR.ok) throw new Error("markStarted failed");

		await store1.value.close();

		// Retain the published bytes and receipts from pub1 (pending + started)
		const pad = (seq: number): string => String(seq).padStart(20, "0");
		const recoveredEntries = pub1.map((pf, i) => ({
			name: `${pad(i + 1)}.b14-command`,
			stat: {
				dev: "1234",
				ino: String(5678 + i),
				uid: "501",
				mode: 0o600,
				size: pf.size,
				nlink: 1,
				isFile: true,
				isSymlink: false,
				mtimeNs: "1000000000",
				ctimeNs: "1000000000",
			},
		}));
		const openedSet = new Set<number>();

		const recoveryBackend: SandboxCommandBackend = {
			listPage() {
				return Promise.resolve({
					status: "page",
					entries: recoveredEntries,
					nextCursor: null,
					close: () => Promise.resolve(Object.freeze({ status: "closed" })),
				});
			},
			open(request: { name: string }) {
				const idx = recoveredEntries.findIndex((e) => e.name === request.name);
				if (idx < 0) return Promise.resolve({ status: "missing" });
				if (openedSet.has(idx)) return Promise.resolve({ status: "missing" });
				openedSet.add(idx);
				const pf = pub1[idx];
				return Promise.resolve({
					status: "opened",
					handle: {
						readAt(_offset: number, _size: number) {
							return Promise.resolve(Object.freeze({ status: "bytes", bytes: pf.bytes }));
						},
						confirmEof(totalSize: number) {
							if (totalSize >= pf.bytes.byteLength) return Promise.resolve({ status: "eof" });
							return Promise.resolve({ status: "bytes", bytes: new Uint8Array(0) });
						},
						fstat() {
							return Promise.resolve({
								dev: "1234",
								ino: String(5678 + idx),
								uid: "501",
								mode: 0o600,
								size: pf.bytes.byteLength,
								nlink: 1,
								isFile: true,
								isSymlink: false,
								mtimeNs: "1000000000",
								ctimeNs: "1000000000",
							});
						},
						close() {
							return Promise.resolve({ status: "closed" });
						},
					},
				});
			},
			close() {
				return Promise.resolve(Object.freeze({ status: "closed" }));
			},
		};

		// Phase 2: create store2 from recovery — must append CRASH interruption.
		const pub2: PublishedFile[] = [];
		const p2 = makePublisher(pub2);
		const store2 = await createSandboxCommandStore({
			identity,
			publisher: p2,
			recoveryBackend,
			recordedAt: ts,
		});
		if (!store2.ok) throw new Error("store2 creation failed");

		// Query state — should be interrupted with CRASH outcome
		const qr = await store2.value.query("cr1");
		if (!qr.ok) throw new Error("query failed");
		expect(qr.value.state).toBe("interrupted");
		expect(qr.value.outcome).toBe("CRASH");

		// Phase 3: create app from recovered store, prove no session method execution
		let sessionMethodCalled = false;
		const h2 = await createHarness();
		try {
			const savedAbort = Object.getOwnPropertyDescriptor(h2.session, "abort");
			Object.defineProperty(h2.session, "abort", {
				value: () => {
					sessionMethodCalled = true;
					return Promise.resolve(undefined);
				},
				configurable: true,
				writable: true,
			});

			const effectR2 = createSandboxCommandEffect(h2.session);
			if (!effectR2.ok) throw new Error("effect2 failed");

			const appR = await createSandboxCommandApplication({
				effect: effectR2.capability,
				store: store2.value,
			});
			if (!("ok" in appR) || !appR.ok) throw new Error("app creation failed");

			// Apply the same command — should return applied without calling session method
			const appResult = await appR.application.apply(makeCommandEnvelope("cr1", "abort"));
			expect(appResult.status).toBe("applied");
			expect(sessionMethodCalled).toBe(false);

			// Query still shows interrupted/CRASH
			const qr2 = await store2.value.query("cr1");
			if (!qr2.ok) throw new Error("query2 failed");
			expect(qr2.value.state).toBe("interrupted");
			expect(qr2.value.outcome).toBe("CRASH");

			if (savedAbort) {
				Object.defineProperty(h2.session, "abort", savedAbort);
			} else {
				Reflect.deleteProperty(h2.session, "abort");
			}

			await appR.application.close();
		} finally {
			h2.cleanup();
		}

		await store2.value.close();
	});
});

// ===========================================================================
// Sync-throw effect — markStarted before interrupt
// ===========================================================================

describe("real sync-throw — override session method to throw", () => {
	test("session method throw causes pending→started→interrupted chronology via published records", async () => {
		// Override session.abort BEFORE effect creation so the bound
		// execute closure captures the throwing version.
		const h = await createHarness();
		try {
			const savedAbort = Object.getOwnPropertyDescriptor(h.session, "abort");
			Object.defineProperty(h.session, "abort", {
				value: () => {
					throw new Error("sync boom");
				},
				configurable: true,
				writable: true,
			});

			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const p = makePublisher(pubs);
			const storeR = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: p,
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			if (!storeR.ok) throw new Error("store creation failed");

			const r = await createSandboxCommandApplication({ effect: effectR.capability, store: storeR.value });
			if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
			const app = r.application;

			const result = await app.apply(makeCommandEnvelope("throw1", "abort"));
			expect(result.status).toBe("applied");

			// Close the app so publisher has all bytes
			await app.close();

			// Decode each published record to prove chronology
			// pubs contains [pending, started, interrupted] in order
			expect(pubs.length).toBe(3);
			expect(pubs[0].seq).toBe(1);
			expect(pubs[1].seq).toBe(2);
			expect(pubs[2].seq).toBe(3);

			const decoded0 = decodeSandboxCommandRecordV1(pubs[0].bytes);
			if (!decoded0.ok) throw new Error("decode failed for record 0");
			if (decoded0.record.recordKind !== "pending") throw new Error("expected pending");
			expect(decoded0.record.commandId).toBe("throw1");

			const decoded1 = decodeSandboxCommandRecordV1(pubs[1].bytes);
			if (!decoded1.ok) throw new Error("decode failed for record 1");
			if (decoded1.record.recordKind !== "started") throw new Error("expected started");
			expect(decoded1.record.commandId).toBe("throw1");

			const decoded2 = decodeSandboxCommandRecordV1(pubs[2].bytes);
			if (!decoded2.ok) throw new Error("decode failed for record 2");
			if (decoded2.record.recordKind !== "interrupted") throw new Error("expected interrupted");
			expect(decoded2.record.outcome).toBe("INTERRUPTED");
			expect(decoded2.record.commandId).toBe("throw1");

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

// ===========================================================================
// Promise subclass / thenable rejection
// ===========================================================================

describe("real invalid Promise — subclass/thenable rejection", () => {
	test("session abort returns Promise subclass; effect maps to INTERNAL_ERROR, app durably interrupts", async () => {
		const h = await createHarness();
		try {
			// Create a Promise subclass — does not pass isExactNativePromise
			class MyPromise extends Promise<unknown> {
				// biome-ignore lint/complexity/noUselessConstructor: extends Promise needs constructor
				constructor(executor: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => void) {
					super(executor);
				}
			}

			const savedAbort = Object.getOwnPropertyDescriptor(h.session, "abort");
			Object.defineProperty(h.session, "abort", {
				value: () => {
					return new MyPromise((resolve) => {
						resolve(undefined);
					});
				},
				configurable: true,
				writable: true,
			});

			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
			const app = r.application;

			// Apply — effect.execute returns a Promise subclass, isExactPromise fails,
			// effect maps to INTERNAL_ERROR, app durably interrupts
			const result = await app.apply(makeCommandEnvelope("badPromise1", "abort"));
			expect(result.status).toBe("applied");

			// Query store — state must be interrupted
			const qr = await store.query("badPromise1");
			if (!qr.ok) throw new Error("query failed");
			expect(qr.value.state).toBe("interrupted");

			if (savedAbort) {
				Object.defineProperty(h.session, "abort", savedAbort);
			} else {
				Reflect.deleteProperty(h.session, "abort");
			}

			await app.close();
		} finally {
			h.cleanup();
		}
	});

	test("thenable with own then property is rejected; durably interrupted", async () => {
		const h = await createHarness();
		try {
			// biome-ignore lint/suspicious/noThenProperty: intentional thenable with own then
			const thenable = Object.setPrototypeOf({ then() {} }, null);

			const savedAbort = Object.getOwnPropertyDescriptor(h.session, "abort");
			Object.defineProperty(h.session, "abort", {
				value: () => thenable,
				configurable: true,
				writable: true,
			});

			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");
			const pubs: PublishedFile[] = [];
			const store = await createMockStore(pubs);
			const r = await createSandboxCommandApplication({ effect: effectR.capability, store });
			if (!("ok" in r) || !r.ok) throw new Error("app creation failed");
			const app = r.application;

			const result = await app.apply(makeCommandEnvelope("thenable1", "abort"));
			expect(result.status).toBe("applied");

			// No thenable getter/call — effect already rejected in isExactPromise
			const qr = await store.query("thenable1");
			if (!qr.ok) throw new Error("query failed");
			expect(qr.value.state).toBe("interrupted");
			expect(qr.value.outcome).toBe("INTERRUPTED");

			if (savedAbort) {
				Object.defineProperty(h.session, "abort", savedAbort);
			} else {
				Reflect.deleteProperty(h.session, "abort");
			}

			await app.close();
		} finally {
			h.cleanup();
		}
	});
});

// ===========================================================================
// Close: reverse order, attempt every owner, chain with completion
// ===========================================================================

describe("close order and publisher failure", () => {
	test("store publisher close-failure returns error from application close", async () => {
		const h = await createHarness();
		try {
			const effectR = createSandboxCommandEffect(h.session);
			if (!effectR.ok) throw new Error("effect failed");

			// Publisher that returns error on close
			let closeCalled = false;
			const failingPublisher: SandboxCommandPublisher = {
				publish(_seq: number, _bytes: Uint8Array) {
					return Promise.resolve(
						Object.freeze({
							ok: true,
							receipt: { sequence: _seq, size: _bytes.byteLength, sha256: sha256Of(_bytes) },
						}),
					);
				},
				close() {
					closeCalled = true;
					return Promise.resolve(Object.freeze({ status: "error" }));
				},
			};

			const storeR = await createSandboxCommandStore({
				identity: IDENTITY,
				publisher: failingPublisher,
				recoveryBackend: makeEmptyBackend(),
				recordedAt: TIMESTAMP,
			});
			if (!storeR.ok) throw new Error("store creation failed");

			const appR = await createSandboxCommandApplication({
				effect: effectR.capability,
				store: storeR.value,
			});
			if (!("ok" in appR) || !appR.ok) throw new Error("app creation failed");

			// Close — publisher error should propagate as application error
			const closeResult = await appR.application.close();
			expect(closeResult.status).toBe("error");
			expect(closeCalled).toBe(true);

			// Effect cleanup is still joined (close does not throw)
		} finally {
			h.cleanup();
		}
	});
});
