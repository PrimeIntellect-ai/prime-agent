import { afterEach, describe, expect, test, vi } from "vitest";
import { createHostedRlmRunController, type HostedRlmRunController } from "../src/core/hosted-rlm-run-controller.js";
import {
	createHostedRlmRuntimePort,
	type HostedRlmAbortResult,
	type HostedRlmAdmissionResult,
	type HostedRlmCloseResult,
	type HostedRlmObservationSnapshot,
	type HostedRlmPortResult,
	type HostedRlmRuntimeIdentity,
	type HostedRlmRuntimePort,
	type HostedRlmSubscribeResult,
	type HostedRlmSubscription,
	type HostedRlmTaskResult,
} from "../src/core/hosted-rlm-runtime-port.js";

const IDENTITY: HostedRlmRuntimeIdentity = {
	childId: "child-001",
	sessionId: "session-001",
	sessionName: "reviewer",
	modelSelector: "prime-inference/deepseek/deepseek-v4-flash",
};
const TASK = Object.freeze({
	status: "completed",
	durationMs: 42_000,
	parentReplyCount: 1,
	toolUseCount: 2,
	answerPreview: "done",
});
const SNAPSHOT = Object.freeze({
	status: "running",
	messageCount: 2,
	toolUseCount: 1,
	agentRunning: true,
	parentReplyCount: 0,
});

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void };
type Calls = {
	start: number;
	terminal: number;
	abort: number;
	observe: number;
	subscribe: number;
	unsubscribe: number;
	close: number;
};
type Overrides = {
	start?: () => unknown;
	terminal?: () => unknown;
	abort?: () => unknown;
	observe?: () => unknown;
	close?: () => unknown;
};

type PortOverrides = { -readonly [K in keyof HostedRlmRuntimePort]?: HostedRlmRuntimePort[K] };

function deferred(): Deferred {
	let resolveValue: (value: unknown) => void = () => undefined;
	const promise = new Promise<unknown>((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}

function value<T>(result: HostedRlmPortResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function box(overrides: Overrides = {}): {
	port: HostedRlmRuntimePort;
	calls: Calls;
	emit: (event: unknown) => void;
} {
	const calls: Calls = { start: 0, terminal: 0, abort: 0, observe: 0, subscribe: 0, unsubscribe: 0, close: 0 };
	let listener: ((event: unknown) => void) | undefined;
	const raw = {
		identity: { ...IDENTITY },
		startInitialTask() {
			calls.start += 1;
			return overrides.start === undefined ? Promise.resolve({ code: "ADMITTED" }) : overrides.start();
		},
		awaitTerminal() {
			calls.terminal += 1;
			return overrides.terminal === undefined ? Promise.resolve(TASK) : overrides.terminal();
		},
		abort() {
			calls.abort += 1;
			return overrides.abort === undefined ? Promise.resolve({ status: "aborted" }) : overrides.abort();
		},
		observe() {
			calls.observe += 1;
			return overrides.observe === undefined ? Promise.resolve(SNAPSHOT) : overrides.observe();
		},
		subscribe(callback: (event: unknown) => void) {
			calls.subscribe += 1;
			listener = callback;
			return {
				unsubscribe() {
					calls.unsubscribe += 1;
					return { status: "unsubscribed" };
				},
			};
		},
		close() {
			calls.close += 1;
			return overrides.close === undefined ? Promise.resolve({ status: "closed" }) : overrides.close();
		},
	};
	const normalized = createHostedRlmRuntimePort(raw);
	if (!normalized.ok) throw new Error(normalized.code);
	return { port: normalized.value, calls, emit: (event) => listener?.(event) };
}

function controller(port: HostedRlmRuntimePort, listener?: (event: never) => void): HostedRlmRunController {
	const created = createHostedRlmRunController(
		listener === undefined ? { port, expectedIdentity: IDENTITY } : { port, expectedIdentity: IDENTITY, listener },
	);
	if (!created.ok) throw new Error(created.code);
	return created.value;
}

function directPort(overrides: Partial<HostedRlmRuntimePort> = {}): HostedRlmRuntimePort {
	const port: HostedRlmRuntimePort = {
		identity: IDENTITY,
		startInitialTask: () => Promise.resolve({ ok: true, value: { code: "ADMITTED" } }),
		awaitTerminal: () => Promise.resolve({ ok: true, value: TASK }),
		abort: () => Promise.resolve({ ok: true, value: { status: "aborted" } }),
		observe: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
		subscribe: () => ({ ok: true, value: { unsubscribe: () => ({ ok: true }) } }),
		close: () => Promise.resolve({ ok: true, value: { status: "closed" } }),
	};
	return Object.freeze({
		identity: overrides.identity === undefined ? port.identity : overrides.identity,
		startInitialTask: overrides.startInitialTask === undefined ? port.startInitialTask : overrides.startInitialTask,
		awaitTerminal: overrides.awaitTerminal === undefined ? port.awaitTerminal : overrides.awaitTerminal,
		abort: overrides.abort === undefined ? port.abort : overrides.abort,
		observe: overrides.observe === undefined ? port.observe : overrides.observe,
		subscribe: overrides.subscribe === undefined ? port.subscribe : overrides.subscribe,
		close: overrides.close === undefined ? port.close : overrides.close,
	});
}

async function withoutUnhandledRejection(action: () => Promise<void>): Promise<void> {
	const reasons: unknown[] = [];
	const listener = (reason: unknown): void => {
		reasons.push(reason);
	};
	process.on("unhandledRejection", listener);
	try {
		await action();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(reasons).toEqual([]);
	} finally {
		process.off("unhandledRejection", listener);
	}
}

afterEach(() => vi.useRealTimers());

describe("hosted RLM run controller", () => {
	test("matches identity before effects and returns an exact frozen controller", () => {
		const runtime = box();
		const mismatch = createHostedRlmRunController({
			port: runtime.port,
			expectedIdentity: { ...IDENTITY, sessionId: "other" },
		});
		expect(mismatch).toEqual({ ok: false, code: "IDENTITY_MISMATCH" });
		expect(runtime.calls.subscribe).toBe(0);
		expect(runtime.calls.close).toBe(0);
		const created = createHostedRlmRunController({ port: runtime.port, expectedIdentity: IDENTITY });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(Object.keys(created.value)).toEqual(["identity", "start", "requestAbort", "finish", "observe", "close"]);
		expect(Object.isFrozen(created.value)).toBe(true);
		expect(Object.isFrozen(created.value.identity)).toBe(true);
		expect(runtime.calls.subscribe).toBe(1);
	});

	test("rejects hostile ports and input accessors without effects", () => {
		const runtime = box();
		const trap = vi.fn(() => {
			throw new Error("trap");
		});
		expect(
			createHostedRlmRunController(new Proxy({ port: runtime.port, expectedIdentity: IDENTITY }, { get: trap })),
		).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		expect(trap).not.toHaveBeenCalled();
		const input: Record<string, unknown> = { port: runtime.port, expectedIdentity: IDENTITY };
		Object.defineProperty(input, "expectedIdentity", { enumerable: true, get: trap });
		expect(createHostedRlmRunController(input)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(trap).not.toHaveBeenCalled();
	});

	test("start returns ADMITTED and finish has no whole-task timeout", async () => {
		vi.useFakeTimers();
		const terminal = deferred();
		const runtime = box({ terminal: () => terminal.promise });
		const run = controller(runtime.port);
		const admitted = run.start({ prompt: "long task" });
		expect(Object.isExtensible(admitted)).toBe(true);
		expect(value(await admitted)).toEqual({ code: "ADMITTED" });
		const finishing = run.finish();
		await vi.advanceTimersByTimeAsync(35_000);
		let settled = false;
		void finishing.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		terminal.resolve(TASK);
		expect(value(await finishing)).toEqual(TASK);
		expect(runtime.calls.start).toBe(1);
		expect(runtime.calls.terminal).toBe(1);
		expect(runtime.calls.unsubscribe).toBe(1);
	});

	test("concurrent and repeated finish calls coalesce one terminal wait and unsubscribe", async () => {
		const terminal = deferred();
		const runtime = box({ terminal: () => terminal.promise });
		const run = controller(runtime.port);
		await run.start({ prompt: "go" });
		const first = run.finish();
		const second = run.finish();
		expect(first).toBe(second);
		terminal.resolve(TASK);
		expect(value(await first)).toEqual(TASK);
		expect(runtime.calls.terminal).toBe(1);
		expect(runtime.calls.unsubscribe).toBe(1);
	});

	test("requestAbort remains available while finish waits and reaches remote once", async () => {
		const terminal = deferred();
		const runtime = box({ terminal: () => terminal.promise });
		const run = controller(runtime.port);
		await run.start({ prompt: "go" });
		const finishing = run.finish();
		const first = run.requestAbort();
		const second = run.requestAbort();
		expect(first).toBe(second);
		expect(value(await first)).toEqual({ status: "aborted" });
		expect(runtime.calls.abort).toBe(1);
		terminal.resolve({
			status: "cancelled",
			durationMs: 3,
			parentReplyCount: 0,
			toolUseCount: 0,
			errorCode: "CANCELLED",
		});
		expect(value(await finishing).status).toBe("cancelled");
	});

	test("synchronous abort uncertainty is cached across retries", async () => {
		const runtime = box({
			abort() {
				throw new Error("after dispatch");
			},
		});
		const run = controller(runtime.port);
		await run.start({ prompt: "go" });
		const first = run.requestAbort();
		const second = run.requestAbort();
		expect(first).toBe(second);
		expect(await first).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(runtime.calls.abort).toBe(1);
	});

	test("abort and close preinstall shared promises before hostile reentrancy", async () => {
		let run: HostedRlmRunController | undefined;
		let abortCalls = 0;
		let closeCalls = 0;
		let reenteredAbort: Promise<HostedRlmPortResult<unknown>> | undefined;
		let reenteredClose: Promise<HostedRlmPortResult<unknown>> | undefined;
		const fake = Object.freeze({
			identity: Object.freeze({ ...IDENTITY }),
			startInitialTask: () => Promise.resolve({ ok: true, value: { code: "ADMITTED" } }),
			awaitTerminal: () => Promise.resolve({ ok: true, value: TASK }),
			abort() {
				abortCalls += 1;
				throw new Error("after dispatch");
			},
			observe: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
			subscribe: () => Object.freeze({ ok: true, value: Object.freeze({ unsubscribe: () => ({ ok: true }) }) }),
			close() {
				closeCalls += 1;
				if (run !== undefined) {
					reenteredAbort = run.requestAbort();
					reenteredClose = run.close();
				}
				return Promise.resolve({ ok: true, value: { status: "closed" } });
			},
		});
		const created = createHostedRlmRunController({ port: fake, expectedIdentity: IDENTITY });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		run = created.value;
		await run.start({ prompt: "go" });
		const firstAbort = run.requestAbort();
		expect(reenteredAbort).toBe(firstAbort);
		expect(reenteredClose).toBe(run.close());
		expect(await firstAbort).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(value(await run.close())).toEqual({ status: "closed" });
		expect(abortCalls).toBe(1);
		expect(closeCalls).toBe(1);
	});

	test("duplicate start does not dispatch twice", async () => {
		const runtime = box();
		const run = controller(runtime.port);
		expect(value(await run.start({ prompt: "one" }))).toEqual({ code: "ADMITTED" });
		expect(await run.start({ prompt: "two" })).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(runtime.calls.start).toBe(1);
	});

	test("finish without start unsubscribes exactly once and returns uncertainty", async () => {
		const runtime = box();
		const run = controller(runtime.port);
		expect(await run.finish()).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(runtime.calls.unsubscribe).toBe(1);
		expect(runtime.calls.terminal).toBe(0);
		expect(await run.finish()).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(runtime.calls.unsubscribe).toBe(1);
	});

	test("close is synchronous in revocation, asynchronous in result, and coalesced", async () => {
		const runtime = box();
		const run = controller(runtime.port);
		const first = run.close();
		const second = run.close();
		expect(first).toBe(second);
		expect(runtime.calls.unsubscribe).toBe(1);
		expect(runtime.calls.close).toBe(1);
		expect(value(await first)).toEqual({ status: "closed" });
		expect(await run.observe()).toEqual({ ok: false, error: { code: "CLOSED" } });
	});

	test("finish and close race share unsubscribe ownership", async () => {
		const terminal = deferred();
		const runtime = box({ terminal: () => terminal.promise });
		const run = controller(runtime.port);
		await run.start({ prompt: "go" });
		const finishing = run.finish();
		const closing = run.close();
		expect(runtime.calls.unsubscribe).toBe(1);
		expect(await finishing).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(runtime.calls.terminal).toBe(0);
		terminal.resolve(TASK);
		expect(value(await closing)).toEqual({ status: "closed" });
		expect(runtime.calls.unsubscribe).toBe(1);
		expect(runtime.calls.close).toBe(1);
	});

	test("buffers synchronous events until token validation and rejects hostile events", () => {
		let listenerCalls = 0;
		let unsubscribeCalls = 0;
		let closeCalls = 0;
		const hostileEvent = new Proxy(
			{ type: "waiting" },
			{
				get() {
					throw new Error("event trap");
				},
			},
		);
		const fake = Object.freeze({
			identity: Object.freeze({ ...IDENTITY }),
			startInitialTask: () => Promise.resolve({ ok: true, value: { code: "ADMITTED" } }),
			awaitTerminal: () => Promise.resolve({ ok: true, value: TASK }),
			abort: () => Promise.resolve({ ok: true, value: { status: "aborted" } }),
			observe: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
			subscribe(callback: (event: unknown) => void) {
				callback(hostileEvent);
				return Object.freeze({
					ok: true,
					value: Object.freeze({
						unsubscribe() {
							unsubscribeCalls += 1;
							return { ok: true };
						},
					}),
				});
			},
			close() {
				closeCalls += 1;
				return Promise.resolve({ ok: true, value: { status: "closed" } });
			},
		});
		const created = createHostedRlmRunController({
			port: fake,
			expectedIdentity: IDENTITY,
			listener: () => {
				listenerCalls += 1;
			},
		});
		expect(created).toEqual({ ok: false, code: "CLEANUP_UNCERTAIN" });
		expect(listenerCalls).toBe(0);
		expect(unsubscribeCalls).toBe(1);
		expect(closeCalls).toBe(1);
	});

	test("listener faults close the run without escaping the event callback", async () => {
		const runtime = box();
		const run = controller(runtime.port, () => {
			throw new Error("listener");
		});
		expect(() => runtime.emit({ type: "agent_start" })).not.toThrow();
		expect(runtime.calls.unsubscribe).toBe(1);
		expect(runtime.calls.close).toBe(1);
		expect(value(await run.close())).toEqual({ status: "closed" });
	});

	test("observe returns a fresh frozen snapshot", async () => {
		const runtime = box();
		const run = controller(runtime.port);
		const observed = run.observe();
		expect(Object.isExtensible(observed)).toBe(true);
		const snapshot = value(await observed);
		expect(snapshot).toEqual(SNAPSHOT);
		expect(snapshot).not.toBe(SNAPSHOT);
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	test("malformed public results trigger close and return uncertainty", async () => {
		let closeCalls = 0;
		let unsubscribeCalls = 0;
		const fake = Object.freeze({
			identity: Object.freeze({ ...IDENTITY }),
			startInitialTask: () => Promise.resolve(Object.freeze({ ok: true, value: Object.freeze({ code: "WRONG" }) })),
			awaitTerminal: () => Promise.resolve(Object.freeze({ ok: true, value: TASK })),
			abort: () => Promise.resolve(Object.freeze({ ok: true, value: Object.freeze({ status: "aborted" }) })),
			observe: () => Promise.resolve(Object.freeze({ ok: true, value: SNAPSHOT })),
			subscribe: () =>
				Object.freeze({
					ok: true,
					value: Object.freeze({
						unsubscribe: () => {
							unsubscribeCalls += 1;
							return Object.freeze({ ok: true });
						},
					}),
				}),
			close: () => {
				closeCalls += 1;
				return Promise.resolve(Object.freeze({ ok: true, value: Object.freeze({ status: "closed" }) }));
			},
		});
		const created = createHostedRlmRunController({ port: fake, expectedIdentity: IDENTITY });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.value.start({ prompt: "go" })).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(unsubscribeCalls).toBe(1);
		expect(closeCalls).toBe(1);
	});

	test("hostile Promise species is rejected without invoking it and close still dispatches", async () => {
		let getterCalls = 0;
		let closeCalls = 0;
		const hostile = Promise.resolve(Object.freeze({ ok: true, value: Object.freeze({ code: "ADMITTED" }) }));
		Object.defineProperty(hostile, "constructor", {
			get() {
				getterCalls += 1;
				throw new Error("species");
			},
		});
		const fake = Object.freeze({
			identity: Object.freeze({ ...IDENTITY }),
			startInitialTask: () => hostile,
			awaitTerminal: () => Promise.resolve({ ok: true, value: TASK }),
			abort: () => Promise.resolve({ ok: true, value: { status: "aborted" } }),
			observe: () => Promise.resolve({ ok: true, value: SNAPSHOT }),
			subscribe: () => Object.freeze({ ok: true, value: Object.freeze({ unsubscribe: () => ({ ok: true }) }) }),
			close: () => {
				closeCalls += 1;
				return Promise.resolve({ ok: true, value: { status: "closed" } });
			},
		});
		const created = createHostedRlmRunController({ port: fake, expectedIdentity: IDENTITY });
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.value.start({ prompt: "go" })).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(getterCalls).toBe(0);
		expect(closeCalls).toBe(1);
	});

	test("close during pending admission fences finish and later terminal dispatch", async () => {
		const admission = deferred();
		const runtime = box({ start: () => admission.promise });
		const run = controller(runtime.port);
		const starting = run.start({ prompt: "go" });
		const finishing = run.finish();
		const closing = run.close();
		expect(await finishing).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(runtime.calls.terminal).toBe(0);
		admission.resolve({ code: "ADMITTED" });
		expect(value(await starting)).toEqual({ code: "ADMITTED" });
		expect(value(await closing)).toEqual({ status: "closed" });
		await Promise.resolve();
		expect(runtime.calls.terminal).toBe(0);
	});

	test("first finish after close is CLOSED and never dispatches terminal", async () => {
		const runtime = box();
		const run = controller(runtime.port);
		expect(value(await run.close())).toEqual({ status: "closed" });
		expect(await run.finish()).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(runtime.calls.terminal).toBe(0);
	});

	test("finish before start permanently fences later start", async () => {
		const runtime = box();
		const run = controller(runtime.port);
		expect(await run.finish()).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(await run.start({ prompt: "orphan" })).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(runtime.calls.start).toBe(0);
		expect(runtime.calls.terminal).toBe(0);
	});

	test("synchronous raw start reentry into finish joins preinstalled admission", async () => {
		let run: HostedRlmRunController | undefined;
		let reentered: Promise<HostedRlmPortResult<unknown>> | undefined;
		const runtime = box({
			start() {
				if (run !== undefined) reentered = run.finish();
				return Promise.resolve({ code: "ADMITTED" });
			},
		});
		run = controller(runtime.port);
		expect(value(await run.start({ prompt: "go" }))).toEqual({ code: "ADMITTED" });
		expect(reentered).toBeDefined();
		if (reentered === undefined) return;
		expect(value(await reentered)).toEqual(TASK);
		expect(run.finish()).toBe(reentered);
		expect(runtime.calls.start).toBe(1);
		expect(runtime.calls.terminal).toBe(1);
	});

	test.each(["own property", "subclass", "species accessor", "constructor accessor"])(
		"controller contains rejected %s Promise without unhandledRejection",
		async (kind) => {
			await withoutUnhandledRejection(async () => {
				let getterCalls = 0;
				let rejected: Promise<never>;
				if (kind === "subclass") {
					class SupplierPromise<T> extends Promise<T> {}
					rejected = SupplierPromise.reject(new Error("subclass"));
				} else if (kind === "species accessor") {
					class SupplierPromise<T> extends Promise<T> {
						static get [Symbol.species](): PromiseConstructor {
							getterCalls += 1;
							throw new Error("must not run");
						}
					}
					rejected = SupplierPromise.reject(new Error("species"));
				} else {
					rejected = Promise.reject(new Error(kind));
					if (kind === "own property")
						Object.defineProperty(rejected, "marker", { value: true, configurable: true });
					else {
						Object.defineProperty(rejected, "constructor", {
							configurable: true,
							get() {
								getterCalls += 1;
								throw new Error("must not run");
							},
						});
					}
				}
				let closeCalls = 0;
				const port = directPort({
					startInitialTask: () => rejected,
					close: () => {
						closeCalls += 1;
						return Promise.resolve({ ok: true, value: { status: "closed" } });
					},
				});
				const run = controller(port);
				expect(await run.start({ prompt: "go" })).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
				expect(getterCalls).toBe(0);
				expect(closeCalls).toBe(1);
			});
		},
	);

	test.each(["rejected own close", "malformed close", "constructor close"])(
		"controller contains %s Promise result",
		async (kind) => {
			await withoutUnhandledRejection(async () => {
				let getterCalls = 0;
				const close = (): Promise<HostedRlmPortResult<{ status: "closed" }>> => {
					if (kind === "malformed close")
						return Promise.resolve({ ok: true, value: { status: "closed", extra: true } });
					const rejected = Promise.reject(new Error(kind));
					if (kind === "rejected own close")
						Object.defineProperty(rejected, "marker", { value: true, configurable: true });
					else {
						Object.defineProperty(rejected, "constructor", {
							configurable: true,
							get() {
								getterCalls += 1;
								throw new Error("must not run");
							},
						});
					}
					return rejected;
				};
				const run = controller(directPort({ close }));
				expect(await run.close()).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
				expect(getterCalls).toBe(0);
			});
		},
	);

	test("controller copies terminal attribution and freezes nested values", async () => {
		const terminalUsage = { inputTokens: 10, outputTokens: 11 };
		const terminal = {
			status: "completed" as const,
			durationMs: 12,
			parentReplyCount: 1,
			toolUseCount: 2,
			answerPreview: "done",
			usage: terminalUsage,
			lastCommittedRequestId: "request-001",
		};
		const terminalRun = controller(
			directPort({ awaitTerminal: () => Promise.resolve({ ok: true, value: terminal }) }),
		);
		await terminalRun.start({ prompt: "go" });
		const terminalResult = value(await terminalRun.finish());
		expect(terminalResult).toEqual(terminal);
		expect(terminalResult).not.toBe(terminal);
		expect(terminalResult.usage).not.toBe(terminalUsage);
		expect(Object.keys(terminalResult)).toEqual([
			"status",
			"durationMs",
			"parentReplyCount",
			"toolUseCount",
			"answerPreview",
			"usage",
			"lastCommittedRequestId",
		]);
		expect(Object.isFrozen(terminalResult)).toBe(true);
		expect(Object.isFrozen(terminalResult.usage)).toBe(true);
		terminal.lastCommittedRequestId = "request-mutated";
		terminalUsage.inputTokens = 99;
		expect(terminalResult.lastCommittedRequestId).toBe("request-001");
		expect(terminalResult.usage).toEqual({ inputTokens: 10, outputTokens: 11 });

		const observationUsage = { inputTokens: 12, outputTokens: 13 };
		const snapshot = { ...SNAPSHOT, answerPreview: "work", usage: observationUsage };
		const observationRun = controller(directPort({ observe: () => Promise.resolve({ ok: true, value: snapshot }) }));
		const observationResult = value(await observationRun.observe());
		expect(observationResult).toEqual(snapshot);
		expect(observationResult).not.toBe(snapshot);
		expect(observationResult.usage).not.toBe(observationUsage);
		expect(Object.isFrozen(observationResult)).toBe(true);
		expect(Object.isFrozen(observationResult.usage)).toBe(true);
	});

	test.each([
		"empty",
		"space",
		"non-ASCII",
		"over 128",
		"accessor",
		"symbol value",
		"own symbol key",
		"cancelled presence",
		"error presence",
		"Proxy",
	])("real port and controller reject terminal attribution case %s without leaks", async (kind) => {
		const completed: Record<string, unknown> = {
			status: "completed",
			durationMs: 1,
			parentReplyCount: 0,
			toolUseCount: 0,
		};
		const probes: Array<() => unknown> = [];
		let candidate: unknown;
		if (kind === "empty") candidate = { ...completed, lastCommittedRequestId: "" };
		else if (kind === "space") candidate = { ...completed, lastCommittedRequestId: "request 001" };
		else if (kind === "non-ASCII") candidate = { ...completed, lastCommittedRequestId: "réquest-001" };
		else if (kind === "over 128") candidate = { ...completed, lastCommittedRequestId: "r".repeat(129) };
		else if (kind === "symbol value") candidate = { ...completed, lastCommittedRequestId: Symbol("request") };
		else if (kind === "own symbol key") {
			candidate = { ...completed, lastCommittedRequestId: "request-001", [Symbol("extra")]: true };
		} else if (kind === "cancelled presence") {
			candidate = {
				status: "cancelled",
				durationMs: 1,
				parentReplyCount: 0,
				toolUseCount: 0,
				errorCode: "CANCELLED",
				lastCommittedRequestId: "request-001",
			};
		} else if (kind === "error presence") {
			candidate = {
				status: "error",
				durationMs: 1,
				parentReplyCount: 0,
				toolUseCount: 0,
				errorCode: "INTERNAL_ERROR",
				lastCommittedRequestId: "request-001",
			};
		} else if (kind === "accessor") {
			const getter = vi.fn(() => "request-001");
			probes.push(getter);
			candidate = completed;
			Object.defineProperty(completed, "lastCommittedRequestId", { enumerable: true, get: getter });
		} else {
			const getter = vi.fn(() => "request-001");
			const trap = vi.fn(() => {
				throw new Error("must not inspect Proxy");
			});
			Object.defineProperty(completed, "lastCommittedRequestId", { enumerable: true, get: getter });
			probes.push(getter, trap);
			candidate = new Proxy(completed, {
				getOwnPropertyDescriptor: trap,
				getPrototypeOf: trap,
				ownKeys: trap,
			});
		}

		const runtime = box({ terminal: () => Promise.resolve(candidate) });
		const listener = vi.fn();
		const run = controller(runtime.port, listener);
		expect(value(await run.start({ prompt: "go" }))).toEqual({ code: "ADMITTED" });
		const result = await run.finish();
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
		expect(Object.keys(result)).toEqual(["ok", "error"]);
		expect(JSON.stringify(result)).not.toContain("lastCommittedRequestId");
		expect(listener).not.toHaveBeenCalled();
		for (const probe of probes) expect(probe).not.toHaveBeenCalled();
		expect(runtime.calls).toEqual({
			start: 1,
			terminal: 1,
			abort: 0,
			observe: 0,
			subscribe: 1,
			unsubscribe: 1,
			close: 1,
		});

		const directCalls: Calls = {
			start: 0,
			terminal: 0,
			abort: 0,
			observe: 0,
			subscribe: 0,
			unsubscribe: 0,
			close: 0,
		};
		const directPortCandidate = Object.freeze({
			identity: Object.freeze({ ...IDENTITY }),
			startInitialTask: () => {
				directCalls.start += 1;
				return Promise.resolve({ ok: true, value: { code: "ADMITTED" } });
			},
			awaitTerminal: () => {
				directCalls.terminal += 1;
				return Promise.resolve({ ok: true, value: candidate });
			},
			abort: () => {
				directCalls.abort += 1;
				return Promise.resolve({ ok: true, value: { status: "aborted" } });
			},
			observe: () => {
				directCalls.observe += 1;
				return Promise.resolve({ ok: true, value: SNAPSHOT });
			},
			subscribe: () => {
				directCalls.subscribe += 1;
				return {
					ok: true,
					value: {
						unsubscribe: () => {
							directCalls.unsubscribe += 1;
							return { ok: true };
						},
					},
				};
			},
			close: () => {
				directCalls.close += 1;
				return Promise.resolve({ ok: true, value: { status: "closed" } });
			},
		});
		const directListener = vi.fn();
		const directCreated = createHostedRlmRunController({
			port: directPortCandidate,
			expectedIdentity: IDENTITY,
			listener: directListener,
		});
		expect(directCreated.ok).toBe(true);
		if (!directCreated.ok) return;
		expect(value(await directCreated.value.start({ prompt: "go" }))).toEqual({ code: "ADMITTED" });
		const directResult = await directCreated.value.finish();
		expect(directResult).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(Object.keys(directResult)).toEqual(["ok", "error"]);
		expect(JSON.stringify(directResult)).not.toContain("lastCommittedRequestId");
		expect(directListener).not.toHaveBeenCalled();
		for (const probe of probes) expect(probe).not.toHaveBeenCalled();
		expect(directCalls).toEqual({
			start: 1,
			terminal: 1,
			abort: 0,
			observe: 0,
			subscribe: 1,
			unsubscribe: 1,
			close: 1,
		});
	});

	test.each([
		["agent_start", { type: "agent_start" }],
		["agent_end", { type: "agent_end" }],
		["waiting", { type: "waiting" }],
		["writing", { type: "writing", answerPreview: "draft" }],
		["executing", { type: "executing", toolName: "bash" }],
		["child_update", { type: "child_update", status: "running", toolUseCount: 1, parentReplyCount: 2 }],
	])("controller delivers event variant %s", (_name, event) => {
		const runtime = box();
		const delivered: unknown[] = [];
		controller(runtime.port, (value) => delivered.push(value));
		runtime.emit(event);
		expect(delivered).toEqual([event]);
		expect(delivered[0]).not.toBe(event);
		expect(Object.isFrozen(delivered[0])).toBe(true);
	});

	test.each(["finish unsubscribe failure", "finish unsubscribe throw", "abort then finish unsubscribe failure"])(
		"reports cleanup uncertainty for %s",
		async (kind) => {
			let unsubscribeCalls = 0;
			const port = directPort({
				subscribe: () => ({
					ok: true,
					value: {
						unsubscribe() {
							unsubscribeCalls += 1;
							if (kind === "finish unsubscribe throw") throw new Error("unsubscribe");
							return { ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } };
						},
					},
				}),
			});
			const run = controller(port);
			await run.start({ prompt: "go" });
			if (kind.startsWith("abort")) await run.requestAbort();
			expect(await run.finish()).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
			expect(unsubscribeCalls).toBe(1);
		},
	);

	test.each(["start", "terminal", "abort", "observe", "close"])("controller binds %s receiver", async (lane) => {
		let owner: HostedRlmRuntimePort | undefined;
		let receiverMatched = false;
		const base = directPort();
		const overrides: PortOverrides = {};
		if (lane === "start")
			overrides.startInitialTask = function (
				this: HostedRlmRuntimePort,
			): Promise<HostedRlmPortResult<HostedRlmAdmissionResult>> {
				receiverMatched = this === owner;
				return Promise.resolve({ ok: true, value: { code: "ADMITTED" } });
			};
		if (lane === "terminal")
			overrides.awaitTerminal = function (
				this: HostedRlmRuntimePort,
			): Promise<HostedRlmPortResult<HostedRlmTaskResult>> {
				receiverMatched = this === owner;
				return Promise.resolve({ ok: true, value: TASK });
			};
		if (lane === "abort")
			overrides.abort = function (this: HostedRlmRuntimePort): Promise<HostedRlmPortResult<HostedRlmAbortResult>> {
				receiverMatched = this === owner;
				return Promise.resolve({ ok: true, value: { status: "aborted" } });
			};
		if (lane === "observe")
			overrides.observe = function (
				this: HostedRlmRuntimePort,
			): Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>> {
				receiverMatched = this === owner;
				return Promise.resolve({ ok: true, value: SNAPSHOT });
			};
		if (lane === "close")
			overrides.close = function (this: HostedRlmRuntimePort): Promise<HostedRlmPortResult<HostedRlmCloseResult>> {
				receiverMatched = this === owner;
				return Promise.resolve({ ok: true, value: { status: "closed" } });
			};
		owner = directPort({ ...base, ...overrides });
		const run = controller(owner);
		if (lane === "start") await run.start({ prompt: "go" });
		if (lane === "terminal") {
			await run.start({ prompt: "go" });
			await run.finish();
		}
		if (lane === "abort") {
			await run.start({ prompt: "go" });
			await run.requestAbort();
		}
		if (lane === "observe") await run.observe();
		if (lane === "close") await run.close();
		expect(receiverMatched).toBe(true);
	});

	test("controller binds subscribe and unsubscribe receivers", () => {
		let portOwner: HostedRlmRuntimePort | undefined;
		let tokenOwner: object | undefined;
		let subscribeReceiver = false;
		let unsubscribeReceiver = false;
		const token: HostedRlmSubscription = {
			unsubscribe() {
				unsubscribeReceiver = this === tokenOwner;
				return { ok: true };
			},
		};
		tokenOwner = token;
		const subscribe = function (this: HostedRlmRuntimePort): HostedRlmSubscribeResult {
			subscribeReceiver = this === portOwner;
			return { ok: true, value: token };
		};
		portOwner = directPort({ subscribe });
		const run = controller(portOwner);
		expect(subscribeReceiver).toBe(true);
		void run.finish();
		expect(unsubscribeReceiver).toBe(true);
	});

	test("close settles finish even after raw terminal dispatch and still drains remote work", async () => {
		const terminal = deferred();
		const runtime = box({ terminal: () => terminal.promise });
		const run = controller(runtime.port);
		await run.start({ prompt: "go" });
		const finishing = run.finish();
		await Promise.resolve();
		expect(runtime.calls.terminal).toBe(1);
		const closing = run.close();
		expect(await finishing).toEqual({ ok: false, error: { code: "CLOSED" } });
		let closeSettled = false;
		void closing.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		terminal.resolve(TASK);
		expect(value(await closing)).toEqual({ status: "closed" });
		expect(runtime.calls.terminal).toBe(1);
	});

	test.each(["start", "close"])("controller observes rejected non-extensible native Promise from %s", async (lane) => {
		await withoutUnhandledRejection(async () => {
			const rejected = Promise.reject(new Error(`non-extensible ${lane}`));
			Object.preventExtensions(rejected);
			expect(Object.getOwnPropertyDescriptor(rejected, "constructor")).toBeUndefined();
			expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rejected), "constructor")?.get).toBeUndefined();
			const run = controller(
				directPort(lane === "start" ? { startInitialTask: () => rejected } : { close: () => rejected }),
			);
			const result = lane === "start" ? await run.start({ prompt: "go" }) : await run.close();
			expect(result).toEqual({
				ok: false,
				error: { code: lane === "start" ? "CALL_UNCERTAIN" : "CLEANUP_UNCERTAIN" },
			});
			expect(Object.isExtensible(rejected)).toBe(false);
			expect(Object.getOwnPropertyDescriptor(rejected, "constructor")).toBeUndefined();
		});
	});
});
