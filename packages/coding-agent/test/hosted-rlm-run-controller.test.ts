import { describe, expect, test } from "vitest";
import {
	type CreateHostedRlmRunControllerResult,
	createHostedRlmRunController,
	type HostedRlmRunController,
} from "../src/core/hosted-rlm-run-controller.js";
import type {
	HostedRlmObservationSnapshot,
	HostedRlmPortResult,
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmTaskResult,
} from "../src/core/hosted-rlm-runtime-port.js";
import { createHostedRlmRuntimePort } from "../src/core/hosted-rlm-runtime-port.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const IDENTITY: HostedRlmRuntimeIdentity = {
	childId: "child-001",
	sessionId: "session-001",
	sessionName: "reviewer",
	modelSelector: "prime-inference/deepseek/deepseek-v4-flash",
};

const TASK: HostedRlmTaskResult = {
	status: "completed",
	durationMs: 15,
	parentReplyCount: 2,
	toolUseCount: 3,
	answerPreview: "done",
	usage: { inputTokens: 11, outputTokens: 7 },
};

const SNAPSHOT: HostedRlmObservationSnapshot = {
	status: "running",
	messageCount: 4,
	toolUseCount: 3,
	agentRunning: true,
	parentReplyCount: 2,
	answerPreview: "work",
	usage: { inputTokens: 9, outputTokens: 5 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function success<T>(result: HostedRlmPortResult<T>): T {
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function expectUncertain<T>(result: HostedRlmPortResult<T>): void {
	expect(result).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
}

function makePortResult(ok: true, value: unknown): unknown;
function makePortResult(ok: false, error: { code: string }): unknown;
function makePortResult(ok: boolean, valueOrError: unknown): unknown {
	if (ok) return { ok: true, value: valueOrError };
	return { ok: false, error: valueOrError };
}

interface HarnessCalls {
	start: number;
	abort: number;
	observe: number;
	subscribe: number;
	unsubscribe: number;
}

interface Harness {
	port: Record<string, unknown>;
	getCalls: () => HarnessCalls;
	emit: (event: HostedRlmRuntimeEvent) => void;
}

/** Build a Record-based public port whose subscribe results and unsubscribe
 *  returns match the HOSTED PORT CONTRACT: subscribe returns
 *  {ok:true, value:{unsubscribe: fn}} where fn() returns {ok:true}. */
function makePort(
	config: {
		startResult?: unknown;
		startDelay?: number;
		abortResult?: unknown;
		subscribeResult?: unknown;
		unsubscribeResult?: unknown;
	} = {},
): Harness {
	const calls: HarnessCalls = { start: 0, abort: 0, observe: 0, subscribe: 0, unsubscribe: 0 };
	let callback: ((event: HostedRlmRuntimeEvent) => void) | undefined;

	const startResult = config.startResult !== undefined ? config.startResult : makePortResult(true, TASK);
	const startDelay = config.startDelay ?? 0;
	const abortResult =
		config.abortResult !== undefined ? config.abortResult : makePortResult(true, { status: "aborted" });

	const unsubFn = (): unknown => {
		calls.unsubscribe += 1;
		if (config.unsubscribeResult !== undefined) return config.unsubscribeResult;
		return { ok: true };
	};

	const subscribeFn = (): unknown => {
		if (config.subscribeResult !== undefined) return config.subscribeResult;
		return {
			ok: true,
			value: { unsubscribe: unsubFn },
		};
	};

	const port: Record<string, unknown> = {
		identity: { ...IDENTITY },
		startInitialTask(_input: unknown): unknown {
			calls.start += 1;
			if (startDelay > 0) return new Promise((r) => setTimeout(r, startDelay)).then(() => startResult);
			return Promise.resolve(startResult);
		},
		abort(): unknown {
			calls.abort += 1;
			return Promise.resolve(abortResult);
		},
		observe(): unknown {
			calls.observe += 1;
			return Promise.resolve(makePortResult(true, SNAPSHOT));
		},
		subscribe(listener: unknown): unknown {
			calls.subscribe += 1;
			if (typeof listener === "function") {
				const cb = (event: HostedRlmRuntimeEvent) => {
					Reflect.apply(listener, undefined, [event]);
				};
				callback = cb;
			}
			return subscribeFn();
		},
	};

	return {
		port,
		getCalls: () => ({ ...calls }),
		emit: (event) => {
			if (callback) callback(event);
		},
	};
}

function createController(
	overrides: { port?: Record<string, unknown>; expectedIdentity?: HostedRlmRuntimeIdentity; listener?: unknown } = {},
): HostedRlmRunController {
	const port = overrides.port !== undefined ? overrides.port : makePort().port;
	const result = createHostedRlmRunController({
		port,
		expectedIdentity: overrides.expectedIdentity ?? IDENTITY,
		...(overrides.listener !== undefined ? { listener: overrides.listener } : undefined),
	});
	if (!result.ok) throw new Error(`createController failed: ${result.code}`);
	return result.value;
}

function expectCreate(input: unknown): CreateHostedRlmRunControllerResult {
	return createHostedRlmRunController(input);
}

// ---------------------------------------------------------------------------
// Tests: createHostedRlmRunController factory
// ---------------------------------------------------------------------------

describe("createHostedRlmRunController", () => {
	test("returns a frozen controller with matching identity", () => {
		const box = makePort();
		const result = expectCreate({ port: box.port, expectedIdentity: IDENTITY });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value.identity)).toBe(true);
		expect(result.value.identity).toEqual(IDENTITY);
		expect(Object.keys(result.value)).toEqual(["identity", "start", "requestAbort", "finish", "observe"]);
	});

	test.each([undefined, null, true, 4, "raw", [], () => undefined])("rejects invalid outer value %#", (raw) => {
		expect(expectCreate(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test.each(["port", "expectedIdentity"])("rejects missing %s", (key) => {
		const box = makePort();
		const raw: Record<string, unknown> = {
			port: box.port,
			expectedIdentity: IDENTITY,
		};
		delete raw[key];
		expect(expectCreate(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects port with mismatched identity", () => {
		const box = makePort();
		const wrong = { ...IDENTITY, childId: "wrong-id" };
		expect(expectCreate({ port: box.port, expectedIdentity: wrong })).toEqual({
			ok: false,
			code: "IDENTITY_MISMATCH",
		});
	});

	test("rejects port with extra keys, proxy, accessors, symbols", () => {
		const box = makePort();
		const withExtra = { ...box.port, extra: true };
		expect(expectCreate({ port: withExtra, expectedIdentity: IDENTITY })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		expect(expectCreate({ port: new Proxy(box.port, {}), expectedIdentity: IDENTITY })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		const accessorPort: Record<string, unknown> = {};
		Object.assign(accessorPort, box.port);
		Object.defineProperty(accessorPort, "identity", {
			enumerable: true,
			get: () => IDENTITY,
		});
		expect(expectCreate({ port: accessorPort, expectedIdentity: IDENTITY })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		const sym = Symbol("hide");
		const withSymbol = { ...box.port, [sym]: true };
		expect(expectCreate({ port: withSymbol, expectedIdentity: IDENTITY })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
	});

	test("rejects proxied port methods", () => {
		const box = makePort();
		const raw: Record<string, unknown> = { ...box.port };
		raw.startInitialTask = new Proxy(() => undefined, {});
		expect(expectCreate({ port: raw, expectedIdentity: IDENTITY })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
	});

	test("rejects invalid expectedIdentity fields", () => {
		const box = makePort();
		for (const childId of ["", "has space", "x".repeat(129)]) {
			expect(
				expectCreate({
					port: box.port,
					expectedIdentity: {
						childId,
						sessionId: "s",
						sessionName: "n",
						modelSelector: "m",
					},
				}),
			).toEqual({ ok: false, code: "INVALID_INPUT" });
		}
	});

	test("rejects extra keys on expectedIdentity", () => {
		const box = makePort();
		expect(
			expectCreate({
				port: box.port,
				expectedIdentity: { ...IDENTITY, extra: true },
			}),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects non-function and proxied listener", () => {
		const box = makePort();
		expect(
			expectCreate({
				port: box.port,
				expectedIdentity: IDENTITY,
				listener: "bad",
			}),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(
			expectCreate({
				port: box.port,
				expectedIdentity: IDENTITY,
				listener: new Proxy(() => undefined, {}),
			}),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("binds port methods to original owner", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask(this: unknown) {
				if (this !== port) throw new Error("unbound start");
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort(this: unknown) {
				if (this !== port) throw new Error("unbound abort");
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe(this: unknown) {
				if (this !== port) throw new Error("unbound observe");
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe(this: unknown, _listener: unknown) {
				if (this !== port) throw new Error("unbound subscribe");
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expect(success(await controller.start({ prompt: "go" }))).toEqual(TASK);
	});

	test("subscribes before start", () => {
		const box = makePort();
		const events: HostedRlmRuntimeEvent[] = [];
		const listener = (event: HostedRlmRuntimeEvent) => events.push(event);
		createController({ port: box.port, listener });
		expect(box.getCalls().subscribe).toBe(1);
		expect(box.getCalls().start).toBe(0);
		box.emit({ type: "agent_start" });
		expect(events).toEqual([{ type: "agent_start" }]);
	});

	test("subscribes even without user listener (internal no-op)", () => {
		const box = makePort();
		createController({ port: box.port });
		expect(box.getCalls().subscribe).toBe(1);
	});

	test("rejects factory when subscribe fails", () => {
		const box = makePort({
			subscribeResult: { ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } },
		});
		expect(expectCreate({ port: box.port, expectedIdentity: IDENTITY })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
	});

	test("factory failure results are fresh and frozen", () => {
		const r1 = expectCreate(null);
		const r2 = expectCreate(null);
		expect(r1).not.toBe(r2);
		expect(Object.isFrozen(r1)).toBe(true);
		expect(Object.isFrozen(r2)).toBe(true);

		const box = makePort();
		const r3 = expectCreate({ port: box.port, expectedIdentity: { ...IDENTITY, childId: "x" } });
		const r4 = expectCreate({ port: box.port, expectedIdentity: { ...IDENTITY, childId: "x" } });
		expect(r3).not.toBe(r4);
		expect(Object.isFrozen(r3)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: start
// ---------------------------------------------------------------------------

describe("start", () => {
	test("one-shot: subsequent calls return CALL_UNCERTAIN without calling port start", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		const first = await controller.start({ prompt: "go" });
		expect(success(first)).toEqual(TASK);
		expect(box.getCalls().start).toBe(1);
		expectUncertain(await controller.start({ prompt: "again" }));
		expect(box.getCalls().start).toBe(1);
	});

	test("rejects raw throw from port method", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				throw new Error("secret");
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});

	test("rejects non-Promise return from port start", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return makePortResult(true, TASK);
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});

	test("rejects port returning ok:false result", async () => {
		const box = makePort({
			startResult: makePortResult(false, { code: "CALL_UNCERTAIN" }),
		});
		const controller = createController({ port: box.port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});

	test("rejects start after finishStarted", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		controller.finish();
		expectUncertain(await controller.start({ prompt: "again" }));
	});

	test("rejects start after finish completes", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		await controller.finish();
		expectUncertain(await controller.start({ prompt: "again" }));
	});
});

// ---------------------------------------------------------------------------
// Tests: requestAbort
// ---------------------------------------------------------------------------

describe("requestAbort", () => {
	test("pre-start returns fresh CALL_UNCERTAIN each time without caching", async () => {
		const controller = createController();
		expectUncertain(await controller.requestAbort());
		await controller.start({ prompt: "go" });
		const first = controller.requestAbort();
		const second = controller.requestAbort();
		expect(first).toBe(second);
		expect(success(await first)).toEqual({ status: "aborted" });
	});

	test("rejected during finish", async () => {
		const controller = createController();
		await controller.start({ prompt: "go" });
		const finishP = controller.finish();
		expectUncertain(await controller.requestAbort());
		await finishP;
	});

	test("rejected after finish", async () => {
		const controller = createController();
		await controller.start({ prompt: "go" });
		await controller.finish();
		expectUncertain(await controller.requestAbort());
	});

	test("pre-start fresh each call (identity check)", async () => {
		const controller = createController();
		const a1 = controller.requestAbort();
		const a2 = controller.requestAbort();
		expect(a1).not.toBe(a2);
		expectUncertain(await a1);
		expectUncertain(await a2);
	});
});

// ---------------------------------------------------------------------------
// Tests: finish
// ---------------------------------------------------------------------------

describe("finish", () => {
	test("returns CALL_UNCERTAIN without start, still unsubscribes", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		expectUncertain(await controller.finish());
		// Subscription was cleaned up
		expect(box.getCalls().unsubscribe).toBe(1);
	});

	test("joins start + admitted abort + unsubscribe exactly once", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		await controller.requestAbort();
		const result = await controller.finish();
		expect(success(result)).toEqual(TASK);
		expect(box.getCalls().unsubscribe).toBe(1);
	});

	test("finish is one-shot: same promise returned", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		const first = controller.finish();
		const second = controller.finish();
		expect(first).toBe(second);
	});

	test("single finish promise returned after completion", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		const first = await controller.finish();
		expect(success(first)).toEqual(TASK);
		const second = controller.finish();
		expect(await second).toEqual(first);
	});

	test("cleanup uncertainty: unsubscribe failure makes finish uncertain", async () => {
		const box = makePort({
			unsubscribeResult: { ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } },
		});
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		expectUncertain(await controller.finish());
	});

	test("unsubscribe uncertainty preserves the one finish promise", async () => {
		const { port } = makePort({ unsubscribeResult: { ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } } });
		const controller = createController({ port });
		await controller.start({ prompt: "go" });
		const first = controller.finish();
		expectUncertain(await first);
		const second = controller.finish();
		expect(second).toBe(first);
		expectUncertain(await second);
	});

	test("abort uncertainty during finish still unsubscribes", async () => {
		const box = makePort({
			abortResult: makePortResult(false, { code: "CALL_UNCERTAIN" }),
		});
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		await controller.requestAbort();
		expectUncertain(await controller.finish());
		// Subscribe was still cleaned up despite abort uncertainty
		expect(box.getCalls().unsubscribe).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: listener isolation
// ---------------------------------------------------------------------------

describe("listener isolation", () => {
	test("listener throw does not poison the controller", async () => {
		const box = makePort();
		const controller = createController({
			port: box.port,
			listener: () => {
				throw new Error("caller");
			},
		});
		box.emit({ type: "agent_start" });
		await controller.start({ prompt: "go" });
		expect(success(await controller.finish())).toEqual(TASK);
	});

	test("listener receives frozen exact events", async () => {
		const box = makePort();
		const events: HostedRlmRuntimeEvent[] = [];
		const listener = (event: HostedRlmRuntimeEvent) => events.push(event);
		createController({ port: box.port, listener });
		box.emit({ type: "agent_start" });
		expect(events).toHaveLength(1);
		expect(events[0]).toEqual({ type: "agent_start" });
		expect(Object.isFrozen(events[0])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: malformed subscription from public port
// ---------------------------------------------------------------------------

describe("malformed subscription from public port", () => {
	test("hostile subscribe result with extras rejects", () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
						extra: true,
					},
				};
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("hostile subscribe throws", () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				throw new Error("secret");
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
	});

	test("hostile subscribe returns proxy token", () => {
		const token = new Proxy({ unsubscribe: () => ({ ok: true }) }, {});
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return { ok: true, value: token };
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
	});

	test("hostile subscribe returns ok:false", () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return { ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } };
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("hostile subscribe returns non-object", () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return "bad";
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
	});
});

// ---------------------------------------------------------------------------
// Tests: malformed subscribe backout / cleanup uncertainty
// ---------------------------------------------------------------------------

describe("subscribe backout and cleanup uncertainty", () => {
	test("subscribe result with non-function inner unsubscribe resolves with backout", () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: { unsubscribe: "not a function" },
				};
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
	});

	test("subscribe backout success: backout result is {ok:true}, factory returns INVALID_INPUT", () => {
		let unsubCalled = false;
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						// biome-ignore lint/suspicious/noThenProperty: intentional hostile test
						then: () => undefined,
						unsubscribe() {
							unsubCalled = true;
							return { ok: true };
						},
					},
				};
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(unsubCalled).toBe(true);
	});

	test("subscribe backout failure: backout result is {ok:false}, factory returns CLEANUP_UNCERTAIN", () => {
		let unsubCalled = false;
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						// biome-ignore lint/suspicious/noThenProperty: intentional hostile test
						then: () => undefined,
						unsubscribe() {
							unsubCalled = true;
							return { ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } };
						},
					},
				};
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
		expect(unsubCalled).toBe(true);
	});

	test("subscribe backout failure: backout throws, factory returns CLEANUP_UNCERTAIN", () => {
		let unsubCalled = false;
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						// biome-ignore lint/suspicious/noThenProperty: intentional hostile test
						then: () => undefined,
						unsubscribe() {
							unsubCalled = true;
							throw new Error("crash");
						},
					},
				};
			},
		};
		expect(expectCreate({ port, expectedIdentity: IDENTITY })).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
		expect(unsubCalled).toBe(true);
	});

	test("subscribe backout result is CLEANUP_UNCERTAIN and result is frozen", () => {
		let unsubCalled = false;
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						// biome-ignore lint/suspicious/noThenProperty: intentional hostile test
						then: () => undefined,
						unsubscribe() {
							unsubCalled = true;
							throw new Error("crash");
						},
					},
				};
			},
		};
		const result = expectCreate({ port, expectedIdentity: IDENTITY });
		expect(Object.isFrozen(result)).toBe(true);
		expect(unsubCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: sync events and overflow
// ---------------------------------------------------------------------------

describe("sync events and overflow", () => {
	test("sync events are decoded before delivery and delivered in order", () => {
		const delivered: string[] = [];
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe(listener: unknown) {
				if (typeof listener === "function") {
					Reflect.apply(listener, undefined, [{ type: "agent_start" }]);
					Reflect.apply(listener, undefined, [{ type: "waiting" }]);
				}
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const listener = (event: HostedRlmRuntimeEvent) => delivered.push(event.type);
		createController({ port, listener });
		expect(delivered).toEqual(["agent_start", "waiting"]);
	});

	test("malformed sync event before token validation poisons and backout runs", () => {
		const delivered: string[] = [];
		let unsubCalled = false;
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve(makePortResult(true, TASK));
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe(listener: unknown) {
				if (typeof listener === "function") {
					Reflect.apply(listener, undefined, [{ type: "writing", answerPreview: undefined }]);
				}
				return {
					ok: true,
					value: {
						unsubscribe() {
							unsubCalled = true;
							return { ok: true };
						},
					},
				};
			},
		};
		const listener = (event: HostedRlmRuntimeEvent) => delivered.push(event.type);
		expect(
			expectCreate({
				port,
				expectedIdentity: IDENTITY,
				listener,
			}),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(unsubCalled).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Tests: abort sharing
// ---------------------------------------------------------------------------

describe("abort sharing", () => {
	test("multiple abort calls share one promise after start", async () => {
		const controller = createController();
		await controller.start({ prompt: "go" });
		const first = controller.requestAbort();
		const second = controller.requestAbort();
		expect(first).toBe(second);
		expect(success(await first)).toEqual({ status: "aborted" });
	});
});

// ---------------------------------------------------------------------------
// Tests: finish join + unsubscribe uncertainty
// ---------------------------------------------------------------------------

describe("finish join + unsubscribe uncertainty", () => {
	test("finish returns uncertainty when abort result is non-ok, still unsubscribes", async () => {
		const box = makePort({
			abortResult: makePortResult(false, { code: "MALFORMED_RESULT" }),
		});
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		await controller.requestAbort();
		expectUncertain(await controller.finish());
		expect(box.getCalls().unsubscribe).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Tests: controller.observe
// ---------------------------------------------------------------------------

describe("controller.observe", () => {
	test("delegates to validated port observe", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		const result = await controller.observe();
		expect(success(result)).toEqual(SNAPSHOT);
		expect(box.getCalls().observe).toBe(1);
	});

	test("works before start", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		const result = await controller.observe();
		expect(success(result)).toEqual(SNAPSHOT);
	});

	test("works after finish", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		await controller.start({ prompt: "go" });
		await controller.finish();
		const result = await controller.observe();
		expect(success(result)).toEqual(SNAPSHOT);
	});
});

// ---------------------------------------------------------------------------
// Tests: hostile port results
// ---------------------------------------------------------------------------

describe("hostile port results", () => {
	test("hostile thenable rejected as uncertain", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				const thenable = {
					// biome-ignore lint/suspicious/noThenProperty: intentional hostile test
					then: (resolve: (v: unknown) => void) => resolve(makePortResult(true, TASK)),
				};
				return thenable;
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});

	test("non-Promise object with own properties rejected", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				const fake: Record<string, unknown> = {};
				Object.setPrototypeOf(fake, Promise.prototype);
				Object.defineProperty(fake, "custom", {
					value: 1,
					enumerable: true,
				});
				return fake;
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});

	test("port method throw produces uncertain", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				throw new Error("crash");
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});

	test("malformed public port result (wrong keys) rejected", async () => {
		const port: Record<string, unknown> = {
			identity: { ...IDENTITY },
			startInitialTask() {
				return Promise.resolve({ status: "mystery", data: TASK });
			},
			abort() {
				return Promise.resolve(makePortResult(true, { status: "aborted" }));
			},
			observe() {
				return Promise.resolve(makePortResult(true, SNAPSHOT));
			},
			subscribe() {
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true };
						},
					},
				};
			},
		};
		const controller = createController({ port });
		expectUncertain(await controller.start({ prompt: "go" }));
	});
});

// ---------------------------------------------------------------------------
// Tests: races with no casts
// ---------------------------------------------------------------------------

describe("races with no casts", () => {
	test("finish before start resolves still unsubscribes", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		expectUncertain(await controller.finish());
		expect(box.getCalls().unsubscribe).toBe(1);
	});

	test("start + immediate finish waits for start", async () => {
		const box = makePort();
		const controller = createController({ port: box.port });
		const startP = controller.start({ prompt: "go" });
		const finishP = controller.finish();
		const startResult = await startP;
		expect(success(startResult)).toEqual(TASK);
		const finishResult = await finishP;
		expect(success(finishResult)).toEqual(TASK);
	});

	test("abort before start not cached", async () => {
		const controller = createController();
		const a1 = controller.requestAbort();
		const a2 = controller.requestAbort();
		expect(a1).not.toBe(a2);
		expectUncertain(await a1);
		expectUncertain(await a2);
	});

	test("abort after start cached", async () => {
		const controller = createController();
		await controller.start({ prompt: "go" });
		const a1 = controller.requestAbort();
		const a2 = controller.requestAbort();
		expect(a1).toBe(a2);
	});
});

// ---------------------------------------------------------------------------
// Tests: finish start-started but no start yet
// ---------------------------------------------------------------------------

describe("finish lifecycle races", () => {
	test("finish waits for start when start is pending", async () => {
		const box = makePort({ startDelay: 10 });
		const controller = createController({ port: box.port });
		const startP = controller.start({ prompt: "go" });
		// finish before start resolves
		const finishP = controller.finish();
		expect(success(await startP)).toEqual(TASK);
		expect(success(await finishP)).toEqual(TASK);
	});
});

// ---------------------------------------------------------------------------
// Tests: regression — actual createHostedRlmRuntimePort input
// ---------------------------------------------------------------------------

describe("regression: accepted hosted port", () => {
	function makeAcceptedPort(): Record<string, unknown> {
		const rawIdentity = { ...IDENTITY };
		// Raw functions return SEMANTIC VALUES (not port results).
		// createHostedRlmRuntimePort wraps them into port results itself.
		const rawStart = (_input: unknown): unknown => Promise.resolve(TASK);
		const rawAbort = (): unknown => Promise.resolve({ status: "aborted" as const });
		const rawObserve = (): unknown => Promise.resolve(SNAPSHOT);
		const rawSubRes = Object.freeze({
			unsubscribe: Object.freeze(() => Object.freeze({ status: "unsubscribed" as const })),
		});
		const rawSubscribe = (_cb: unknown): unknown => rawSubRes;
		const adapter = Object.freeze({
			identity: rawIdentity,
			startInitialTask: rawStart,
			abort: rawAbort,
			observe: rawObserve,
			subscribe: rawSubscribe,
		});
		const fp = createHostedRlmRuntimePort(adapter);
		if (!fp.ok) throw new Error("port factory failed");
		const port = fp.value;
		const raw: Record<string, unknown> = {};
		raw.identity = port.identity;
		raw.startInitialTask = port.startInitialTask;
		raw.abort = port.abort;
		raw.observe = port.observe;
		raw.subscribe = port.subscribe;
		return raw;
	}

	test("controller accepts an actual hosted port and completes successfully", async () => {
		const port = makeAcceptedPort();
		const controller = createController({
			port,
			expectedIdentity: IDENTITY,
		});
		expect(controller.identity).toEqual(IDENTITY);
		expect(success(await controller.start({ prompt: "go" }))).toEqual(TASK);
		expect(success(await controller.finish())).toEqual(TASK);
	});

	test("accepted port: finish before start unsubscribes and returns uncertain", async () => {
		const port = makeAcceptedPort();
		const controller = createController({ port, expectedIdentity: IDENTITY });
		expectUncertain(await controller.finish());
	});

	test("accepted port: abort then finish works", async () => {
		const port = makeAcceptedPort();
		const controller = createController({ port, expectedIdentity: IDENTITY });
		await controller.start({ prompt: "go" });
		await controller.requestAbort();
		const result = await controller.finish();
		expect(success(result)).toEqual(TASK);
	});

	test("accepted port: observe works", async () => {
		const port = makeAcceptedPort();
		const controller = createController({ port, expectedIdentity: IDENTITY });
		const snapshot = await controller.observe();
		expect(success(snapshot)).toEqual(SNAPSHOT);
	});

	test("accepted port: sync subscribe events deliver in order", () => {
		const delivered: string[] = [];
		const rawIdentity = { ...IDENTITY };
		// Raw functions return semantic values. createHostedRlmRuntimePort wraps them.
		const rawStart = (_input: unknown): unknown => Promise.resolve(TASK);
		const rawAbort = (): unknown => Promise.resolve({ status: "aborted" as const });
		const rawObserve = (): unknown => Promise.resolve(SNAPSHOT);
		const rawSubRes = Object.freeze({
			unsubscribe: Object.freeze(() => Object.freeze({ status: "unsubscribed" as const })),
		});
		const rawSubscribe = (cb: unknown): unknown => {
			if (typeof cb === "function") {
				Reflect.apply(cb, undefined, [{ type: "agent_start" }]);
				Reflect.apply(cb, undefined, [{ type: "waiting" }]);
			}
			return rawSubRes;
		};
		const adapter = Object.freeze({
			identity: rawIdentity,
			startInitialTask: rawStart,
			abort: rawAbort,
			observe: rawObserve,
			subscribe: rawSubscribe,
		});
		const fp = createHostedRlmRuntimePort(adapter);
		if (!fp.ok) throw new Error("port factory failed");
		const port: Record<string, unknown> = {};
		port.identity = fp.value.identity;
		port.startInitialTask = fp.value.startInitialTask;
		port.abort = fp.value.abort;
		port.observe = fp.value.observe;
		port.subscribe = fp.value.subscribe;

		const listener = (event: HostedRlmRuntimeEvent) => delivered.push(event.type);
		createController({ port, expectedIdentity: IDENTITY, listener });
		expect(delivered).toEqual(["agent_start", "waiting"]);
	});

	test("accepted port: malformed subscription returns INVALID_INPUT", () => {
		const rawIdentity = { ...IDENTITY };
		// Raw functions return semantic values. createHostedRlmRuntimePort wraps them.
		const rawStart = (_input: unknown): unknown => Promise.resolve(TASK);
		const rawAbort = (): unknown => Promise.resolve({ status: "aborted" as const });
		const rawObserve = (): unknown => Promise.resolve(SNAPSHOT);
		const rawSubRes = Object.freeze({
			unsubscribe: Object.freeze(() => Object.freeze({ status: "unsubscribed" as const })),
		});
		const rawSubscribe = (cb: unknown): unknown => {
			if (typeof cb === "function") {
				// Send a malformed event before returning
				Reflect.apply(cb, undefined, [{ type: "writing", answerPreview: undefined }]);
			}
			return rawSubRes;
		};
		const adapter = Object.freeze({
			identity: rawIdentity,
			startInitialTask: rawStart,
			abort: rawAbort,
			observe: rawObserve,
			subscribe: rawSubscribe,
		});
		const fp = createHostedRlmRuntimePort(adapter);
		if (!fp.ok) throw new Error("port factory failed");
		const port: Record<string, unknown> = {};
		port.identity = fp.value.identity;
		port.startInitialTask = fp.value.startInitialTask;
		port.abort = fp.value.abort;
		port.observe = fp.value.observe;
		port.subscribe = fp.value.subscribe;

		const result = expectCreate({ port, expectedIdentity: IDENTITY });
		expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("accepted port: abort uncertainty during finish still unsubscribes", async () => {
		let unsubCalled = false;
		const rawIdentity = { ...IDENTITY };
		// Raw functions return semantic values. createHostedRlmRuntimePort wraps them.
		const rawStart = (_input: unknown): unknown => Promise.resolve(TASK);
		const rawAbort = (): unknown => Promise.reject(new Error("abort failed"));
		const rawObserve = (): unknown => Promise.resolve(SNAPSHOT);
		const rawSubRes = Object.freeze({
			unsubscribe: Object.freeze(() => {
				unsubCalled = true;
				return Object.freeze({ status: "unsubscribed" as const });
			}),
		});
		const rawSubscribe = (_cb: unknown): unknown => rawSubRes;
		const adapter = Object.freeze({
			identity: rawIdentity,
			startInitialTask: rawStart,
			abort: rawAbort,
			observe: rawObserve,
			subscribe: rawSubscribe,
		});
		const fp = createHostedRlmRuntimePort(adapter);
		if (!fp.ok) throw new Error("port factory failed");
		const port: Record<string, unknown> = {};
		port.identity = fp.value.identity;
		port.startInitialTask = fp.value.startInitialTask;
		port.abort = fp.value.abort;
		port.observe = fp.value.observe;
		port.subscribe = fp.value.subscribe;

		const controller = createController({ port, expectedIdentity: IDENTITY });
		await controller.start({ prompt: "go" });
		await controller.requestAbort();
		expectUncertain(await controller.finish());
		expect(unsubCalled).toBe(true);
	});
});
