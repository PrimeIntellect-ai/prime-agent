import { afterEach, describe, expect, test, vi } from "vitest";
import {
	createHostedRlmRuntimePort,
	type HostedRlmPortResult,
	type HostedRlmRuntimeIdentity,
	type HostedRlmRuntimePort,
} from "../src/core/hosted-rlm-runtime-port.js";

const IDENTITY: HostedRlmRuntimeIdentity = {
	childId: "child-001",
	sessionId: "session-001",
	sessionName: "reviewer",
	modelSelector: "prime-inference/deepseek/deepseek-v4-flash",
};
const TASK = Object.freeze({
	status: "completed",
	durationMs: 35_001,
	parentReplyCount: 1,
	toolUseCount: 2,
	answerPreview: "done",
	usage: Object.freeze({ inputTokens: 11, outputTokens: 7 }),
});
const SNAPSHOT = Object.freeze({
	status: "running",
	messageCount: 3,
	toolUseCount: 2,
	agentRunning: true,
	parentReplyCount: 1,
});

type Deferred = {
	promise: Promise<unknown>;
	resolve: (value: unknown) => void;
	reject: () => void;
};

type Calls = {
	start: number;
	terminal: number;
	abort: number;
	observe: number;
	subscribe: number;
	unsubscribe: number;
	close: number;
};

type RawPort = {
	identity: unknown;
	startInitialTask: (input: unknown) => unknown;
	awaitTerminal: () => unknown;
	abort: () => unknown;
	observe: () => unknown;
	subscribe: (listener: (event: unknown) => void) => unknown;
	close: () => unknown;
};

function deferred(): Deferred {
	let resolveValue: (value: unknown) => void = () => undefined;
	let rejectValue: () => void = () => undefined;
	const promise = new Promise<unknown>((resolve, reject) => {
		resolveValue = resolve;
		rejectValue = () => reject(new Error("remote"));
	});
	return { promise, resolve: resolveValue, reject: rejectValue };
}

function ok<T>(result: HostedRlmPortResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function harness(overrides: Partial<RawPort> = {}): {
	raw: RawPort;
	port: HostedRlmRuntimePort;
	calls: Calls;
	emit: (event: unknown) => void;
} {
	const calls: Calls = { start: 0, terminal: 0, abort: 0, observe: 0, subscribe: 0, unsubscribe: 0, close: 0 };
	let callback: ((event: unknown) => void) | undefined;
	const raw: RawPort = {
		identity: overrides.identity === undefined ? { ...IDENTITY } : overrides.identity,
		startInitialTask(input) {
			calls.start += 1;
			if (overrides.startInitialTask !== undefined) {
				return Reflect.apply(overrides.startInitialTask, this, [input]);
			}
			return Promise.resolve(Object.freeze({ code: "ADMITTED" }));
		},
		awaitTerminal() {
			calls.terminal += 1;
			if (overrides.awaitTerminal !== undefined) return Reflect.apply(overrides.awaitTerminal, this, []);
			return Promise.resolve(TASK);
		},
		abort() {
			calls.abort += 1;
			if (overrides.abort !== undefined) return Reflect.apply(overrides.abort, this, []);
			return Promise.resolve(Object.freeze({ status: "aborted" }));
		},
		observe() {
			calls.observe += 1;
			if (overrides.observe !== undefined) return Reflect.apply(overrides.observe, this, []);
			return Promise.resolve(SNAPSHOT);
		},
		subscribe(listener) {
			calls.subscribe += 1;
			callback = listener;
			if (overrides.subscribe !== undefined) return Reflect.apply(overrides.subscribe, this, [listener]);
			return {
				unsubscribe() {
					calls.unsubscribe += 1;
					return Object.freeze({ status: "unsubscribed" });
				},
			};
		},
		close() {
			calls.close += 1;
			if (overrides.close !== undefined) return Reflect.apply(overrides.close, this, []);
			return Promise.resolve(Object.freeze({ status: "closed" }));
		},
	};
	const created = createHostedRlmRuntimePort(raw);
	if (!created.ok) throw new Error(created.code);
	return { raw, port: created.value, calls, emit: (event) => callback?.(event) };
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

describe("hosted runtime port contract", () => {
	test("normalizes an exact frozen seven-member capability in order", () => {
		const box = harness();
		expect(Object.keys(box.port)).toEqual([
			"identity",
			"startInitialTask",
			"awaitTerminal",
			"abort",
			"observe",
			"subscribe",
			"close",
		]);
		expect(Object.isFrozen(box.port)).toBe(true);
		expect(Object.isFrozen(box.port.identity)).toBe(true);
		expect(box.port.identity).toEqual(IDENTITY);
		expect(box.port.identity).not.toBe(box.raw.identity);
	});

	test("rejects proxies, accessors, extra members, and proxied methods before effects", () => {
		const base = harness().raw;
		const trap = vi.fn(() => {
			throw new Error("trap");
		});
		expect(createHostedRlmRuntimePort(new Proxy(base, { get: trap }))).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(trap).not.toHaveBeenCalled();
		const accessor = { ...base };
		Object.defineProperty(accessor, "identity", { enumerable: true, get: trap });
		expect(createHostedRlmRuntimePort(accessor)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(trap).not.toHaveBeenCalled();
		expect(createHostedRlmRuntimePort({ ...base, extra: true })).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(createHostedRlmRuntimePort({ ...base, close: new Proxy(base.close, {}) })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
	});

	test("binds every data-property method to its original receiver", async () => {
		let owner: RawPort | undefined;
		const box = harness({
			startInitialTask() {
				expect(this).toBe(owner);
				return Promise.resolve({ code: "ADMITTED" });
			},
			awaitTerminal() {
				expect(this).toBe(owner);
				return Promise.resolve(TASK);
			},
			abort() {
				expect(this).toBe(owner);
				return Promise.resolve({ status: "aborted" });
			},
			observe() {
				expect(this).toBe(owner);
				return Promise.resolve(SNAPSHOT);
			},
			close() {
				expect(this).toBe(owner);
				return Promise.resolve({ status: "closed" });
			},
		});
		owner = box.raw;
		expect(ok(await box.port.startInitialTask({ prompt: "go" }))).toEqual({ code: "ADMITTED" });
		expect(ok(await box.port.awaitTerminal())).toEqual(TASK);
		expect(ok(await box.port.abort())).toEqual({ status: "aborted" });
		expect(ok(await box.port.observe())).toEqual(SNAPSHOT);
		expect(ok(await box.port.close())).toEqual({ status: "closed" });
	});

	test("returns admission immediately while a task remains pending beyond 30 seconds", async () => {
		vi.useFakeTimers();
		const terminal = deferred();
		const box = harness({ awaitTerminal: () => terminal.promise });
		const admitted = box.port.startInitialTask({ prompt: "long task" });
		expect(Object.isExtensible(admitted)).toBe(true);
		expect(ok(await admitted)).toEqual({ code: "ADMITTED" });
		const first = box.port.awaitTerminal();
		const second = box.port.awaitTerminal();
		expect(first).toBe(second);
		await vi.advanceTimersByTimeAsync(35_001);
		let settled = false;
		void first.then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
		terminal.resolve(TASK);
		expect(ok(await first)).toEqual(TASK);
		expect(box.calls.terminal).toBe(1);
	});

	test("copies and freezes the exact start input and admits only once", async () => {
		let captured: unknown;
		const box = harness({
			startInitialTask(input) {
				captured = input;
				return Promise.resolve({ code: "ADMITTED" });
			},
		});
		const input = { prompt: "go", spawnCode: "rlm('x')" };
		expect(ok(await box.port.startInitialTask(input))).toEqual({ code: "ADMITTED" });
		expect(captured).toEqual(input);
		expect(captured).not.toBe(input);
		expect(Object.isFrozen(captured)).toBe(true);
		expect(await box.port.startInitialTask({ prompt: "again" })).toEqual({
			ok: false,
			error: { code: "CALL_UNCERTAIN" },
		});
		expect(box.calls.start).toBe(1);
	});

	test("invalid input revokes synchronously and starts authoritative close", async () => {
		const box = harness();
		const result = box.port.startInitialTask({ prompt: "" });
		expect(box.calls.close).toBe(1);
		expect(await result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(await box.port.observe()).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(ok(await box.port.close())).toEqual({ status: "closed" });
	});

	test("abort reaches the remote once while terminal wait is pending", async () => {
		const terminal = deferred();
		const box = harness({ awaitTerminal: () => terminal.promise });
		await box.port.startInitialTask({ prompt: "go" });
		const waiting = box.port.awaitTerminal();
		const firstAbort = box.port.abort();
		const secondAbort = box.port.abort();
		expect(firstAbort).toBe(secondAbort);
		expect(ok(await firstAbort)).toEqual({ status: "aborted" });
		expect(box.calls.abort).toBe(1);
		terminal.resolve(
			Object.freeze({
				status: "cancelled",
				durationMs: 7,
				parentReplyCount: 0,
				toolUseCount: 0,
				errorCode: "CANCELLED",
			}),
		);
		expect(ok(await waiting).status).toBe("cancelled");
	});

	test("abort caches synchronous uncertainty and never dispatches twice", async () => {
		const box = harness({
			abort() {
				throw new Error("after dispatch");
			},
		});
		await box.port.startInitialTask({ prompt: "go" });
		const first = box.port.abort();
		const second = box.port.abort();
		expect(first).toBe(second);
		expect(await first).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(box.calls.abort).toBe(1);
	});

	test("abort preinstalls its shared promise before hostile close reentrancy", async () => {
		let publicPort: HostedRlmRuntimePort | undefined;
		let reentered: Promise<HostedRlmPortResult<unknown>> | undefined;
		const box = harness({
			abort() {
				throw new Error("after dispatch");
			},
			close() {
				if (publicPort !== undefined) reentered = publicPort.abort();
				return Promise.resolve({ status: "closed" });
			},
		});
		publicPort = box.port;
		await box.port.startInitialTask({ prompt: "go" });
		const first = box.port.abort();
		expect(reentered).toBe(first);
		expect(await first).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(box.calls.abort).toBe(1);
		expect(box.calls.close).toBe(1);
	});

	test("close synchronously revokes, coalesces, and drains a pending terminal wait", async () => {
		vi.useFakeTimers();
		const terminal = deferred();
		const box = harness({ awaitTerminal: () => terminal.promise });
		const subscription = box.port.subscribe(() => undefined);
		expect(subscription.ok).toBe(true);
		await box.port.startInitialTask({ prompt: "go" });
		const waiting = box.port.awaitTerminal();
		const firstClose = box.port.close();
		const secondClose = box.port.close();
		expect(firstClose).toBe(secondClose);
		expect(box.calls.unsubscribe).toBe(1);
		expect(box.calls.close).toBe(1);
		let closeSettled = false;
		void firstClose.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		terminal.resolve(TASK);
		expect(ok(await waiting)).toEqual(TASK);
		expect(ok(await firstClose)).toEqual({ status: "closed" });
	});

	test("close reports cleanup uncertainty when drain exceeds its 30 second control deadline", async () => {
		vi.useFakeTimers();
		const terminal = deferred();
		const box = harness({ awaitTerminal: () => terminal.promise });
		await box.port.startInitialTask({ prompt: "go" });
		void box.port.awaitTerminal();
		const closing = box.port.close();
		await vi.advanceTimersByTimeAsync(30_001);
		expect(await closing).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
	});

	test("abort and observe keep 30 second control deadlines and start close on timeout", async () => {
		vi.useFakeTimers();
		const abortPending = deferred();
		const abortBox = harness({ abort: () => abortPending.promise });
		await abortBox.port.startInitialTask({ prompt: "go" });
		const aborting = abortBox.port.abort();
		expect(abortBox.calls.abort).toBe(1);
		await vi.advanceTimersByTimeAsync(30_001);
		expect(await aborting).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(abortBox.calls.close).toBe(1);

		const observePending = deferred();
		const observeBox = harness({ observe: () => observePending.promise });
		const observing = observeBox.port.observe();
		expect(observeBox.calls.observe).toBe(1);
		await vi.advanceTimersByTimeAsync(30_001);
		expect(await observing).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(observeBox.calls.close).toBe(1);
	});

	test("abort remains a reachable cleanup control after another lane poisons", async () => {
		const box = harness({ observe: () => Promise.resolve({ status: "running" }) });
		await box.port.startInitialTask({ prompt: "go" });
		expect(await box.port.observe()).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
		expect(box.calls.close).toBe(1);
		expect(ok(await box.port.abort())).toEqual({ status: "aborted" });
		expect(box.calls.abort).toBe(1);
	});

	test("malformed results and callback faults poison, revoke, and close without leaking", async () => {
		const malformed = harness({ observe: () => Promise.resolve({ status: "running" }) });
		expect(await malformed.port.observe()).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
		expect(malformed.calls.close).toBe(1);

		const events = harness();
		const subscribed = events.port.subscribe(() => {
			throw new Error("listener");
		});
		expect(subscribed.ok).toBe(true);
		expect(() => events.emit({ type: "agent_start" })).not.toThrow();
		expect(events.calls.unsubscribe).toBe(1);
		expect(events.calls.close).toBe(1);
	});

	test("bounds synchronous events at 16 and backs out before close", () => {
		let emitted = 0;
		const box = harness({
			subscribe(listener) {
				for (let index = 0; index < 17; index += 1) listener({ type: "waiting" });
				return {
					unsubscribe() {
						emitted += 1;
						return { status: "unsubscribed" };
					},
				};
			},
		});
		expect(box.port.subscribe(() => undefined)).toEqual({
			ok: false,
			error: { code: "SUBSCRIBE_UNCERTAIN" },
		});
		expect(emitted).toBe(1);
		expect(box.calls.close).toBe(1);
	});

	test("rejects proxied, subclassed, and constructor-poisoned promises and still closes", async () => {
		class HostilePromise extends Promise<unknown> {}
		const cases: unknown[] = [
			new Proxy(Promise.resolve({ code: "ADMITTED" }), {}),
			HostilePromise.resolve({ code: "ADMITTED" }),
		];
		const poisoned = Promise.resolve({ code: "ADMITTED" });
		Object.defineProperty(poisoned, "constructor", {
			get() {
				throw new Error("species");
			},
		});
		cases.push(poisoned);
		for (const candidate of cases) {
			const box = harness({ startInitialTask: () => candidate });
			expect(await box.port.startInitialTask({ prompt: "go" })).toEqual({
				ok: false,
				error: { code: "CALL_UNCERTAIN" },
			});
			expect(box.calls.close).toBe(1);
		}
	});

	test("close fences terminal queued before admission settles", async () => {
		const admission = deferred();
		const box = harness({ startInitialTask: () => admission.promise });
		const starting = box.port.startInitialTask({ prompt: "go" });
		const finishing = box.port.awaitTerminal();
		const closing = box.port.close();
		expect(await finishing).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(box.calls.terminal).toBe(0);
		admission.resolve({ code: "ADMITTED" });
		expect(ok(await starting)).toEqual({ code: "ADMITTED" });
		expect(ok(await closing)).toEqual({ status: "closed" });
		await Promise.resolve();
		expect(box.calls.terminal).toBe(0);
	});

	test("close fences terminal after raw admission settles but before its continuation", async () => {
		const admission = deferred();
		const box = harness({ startInitialTask: () => admission.promise });
		const starting = box.port.startInitialTask({ prompt: "go" });
		const finishing = box.port.awaitTerminal();
		admission.resolve({ code: "ADMITTED" });
		const closing = box.port.close();
		expect(await finishing).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(ok(await starting)).toEqual({ code: "ADMITTED" });
		expect(ok(await closing)).toEqual({ status: "closed" });
		await Promise.resolve();
		expect(box.calls.terminal).toBe(0);
	});

	test("first terminal request after close is CLOSED with no raw effect", async () => {
		const box = harness();
		expect(ok(await box.port.close())).toEqual({ status: "closed" });
		expect(await box.port.awaitTerminal()).toEqual({ ok: false, error: { code: "CLOSED" } });
		expect(box.calls.terminal).toBe(0);
	});

	test.each([
		["completed base", { status: "completed", durationMs: 1, parentReplyCount: 0, toolUseCount: 0 }],
		[
			"completed options",
			{
				status: "completed",
				durationMs: 2,
				parentReplyCount: 1,
				toolUseCount: 3,
				answerPreview: "ok",
				usage: { inputTokens: 4, outputTokens: 5 },
			},
		],
		[
			"cancelled",
			{ status: "cancelled", durationMs: 3, parentReplyCount: 0, toolUseCount: 0, errorCode: "CANCELLED" },
		],
		[
			"error with usage",
			{
				status: "error",
				durationMs: 4,
				parentReplyCount: 0,
				toolUseCount: 1,
				errorCode: "TIMEOUT",
				usage: { inputTokens: 6, outputTokens: 7 },
			},
		],
	])("accepts task result variant %s", async (_name, candidate) => {
		const box = harness({ awaitTerminal: () => Promise.resolve(candidate) });
		await box.port.startInitialTask({ prompt: "go" });
		const result = ok(await box.port.awaitTerminal());
		expect(result).toEqual(candidate);
		expect(Object.isFrozen(result)).toBe(true);
		if ("usage" in result) expect(Object.isFrozen(result.usage)).toBe(true);
	});

	test.each([
		[
			"completed error",
			{ status: "completed", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "TIMEOUT" },
		],
		[
			"cancelled answer",
			{
				status: "cancelled",
				durationMs: 1,
				parentReplyCount: 0,
				toolUseCount: 0,
				errorCode: "CANCELLED",
				answerPreview: "bad",
			},
		],
		[
			"cancelled code",
			{ status: "cancelled", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "TIMEOUT" },
		],
		[
			"error answer",
			{
				status: "error",
				durationMs: 1,
				parentReplyCount: 0,
				toolUseCount: 0,
				errorCode: "INTERNAL_ERROR",
				answerPreview: "bad",
			},
		],
		["error code", { status: "error", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "CANCELLED" }],
		["negative count", { status: "completed", durationMs: -1, parentReplyCount: 0, toolUseCount: 0 }],
	])("rejects malformed task result %s", async (_name, candidate) => {
		const box = harness({ awaitTerminal: () => Promise.resolve(candidate) });
		await box.port.startInitialTask({ prompt: "go" });
		expect(await box.port.awaitTerminal()).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
		expect(box.calls.close).toBe(1);
	});

	test.each([
		["bad status", { ...SNAPSHOT, status: "sleeping" }],
		["running false count", { ...SNAPSHOT, messageCount: -1 }],
		["completed running", { ...SNAPSHOT, status: "completed", agentRunning: true }],
		["empty preview", { ...SNAPSHOT, answerPreview: "" }],
		["bad usage", { ...SNAPSHOT, usage: { inputTokens: 1, outputTokens: -1 } }],
	])("rejects malformed observation %s", async (_name, candidate) => {
		const box = harness({ observe: () => Promise.resolve(candidate) });
		expect(await box.port.observe()).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
		expect(box.calls.close).toBe(1);
	});

	test("copies and freezes nested observation usage", async () => {
		const usage = { inputTokens: 8, outputTokens: 9 };
		const candidate = { ...SNAPSHOT, answerPreview: "working", usage };
		const box = harness({ observe: () => Promise.resolve(candidate) });
		const result = ok(await box.port.observe());
		expect(result).toEqual(candidate);
		expect(result).not.toBe(candidate);
		expect(result.usage).not.toBe(usage);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.usage)).toBe(true);
	});

	test.each([
		["agent_start", { type: "agent_start" }],
		["agent_end", { type: "agent_end" }],
		["waiting", { type: "waiting" }],
		["writing", { type: "writing", answerPreview: "draft" }],
		["executing", { type: "executing", toolName: "bash" }],
		[
			"child_update",
			{ type: "child_update", status: "running", toolUseCount: 2, parentReplyCount: 1, answerPreview: "child" },
		],
	])("delivers event variant %s as a frozen copy", (_name, candidate) => {
		const box = harness();
		const events: unknown[] = [];
		expect(box.port.subscribe((event) => events.push(event)).ok).toBe(true);
		box.emit(candidate);
		expect(events).toEqual([candidate]);
		expect(events[0]).not.toBe(candidate);
		expect(Object.isFrozen(events[0])).toBe(true);
	});

	test.each([
		["null", null],
		["extra", { unsubscribe: () => ({ status: "unsubscribed" }), extra: true }],
		["accessor", "accessor"],
		["proxy token", "proxy"],
		["proxied method", "method"],
	])("rejects hostile subscription token %s", (_name, kind) => {
		const trap = vi.fn(() => {
			throw new Error("trap");
		});
		let token: unknown = null;
		if (kind === "extra") token = { unsubscribe: () => ({ status: "unsubscribed" }), extra: true };
		if (kind === "accessor") {
			token = {};
			Object.defineProperty(token, "unsubscribe", { enumerable: true, get: trap });
		}
		if (kind === "proxy") token = new Proxy({ unsubscribe: () => ({ status: "unsubscribed" }) }, { get: trap });
		if (kind === "method") token = { unsubscribe: new Proxy(() => ({ status: "unsubscribed" }), {}) };
		const box = harness({ subscribe: () => token });
		expect(box.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
		expect(trap).not.toHaveBeenCalled();
		expect(box.calls.close).toBe(1);
	});

	test("binds subscribe and unsubscribe to their original receivers", () => {
		let rawOwner: RawPort | undefined;
		let tokenOwner: object | undefined;
		const token = {
			unsubscribe() {
				expect(this).toBe(tokenOwner);
				return { status: "unsubscribed" };
			},
		};
		tokenOwner = token;
		const box = harness({
			subscribe() {
				expect(this).toBe(rawOwner);
				return token;
			},
		});
		rawOwner = box.raw;
		const result = box.port.subscribe(() => undefined);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.unsubscribe()).toEqual({ ok: true });
	});

	test("raw unsubscribe throw is cached and forbids resubscribe", () => {
		let calls = 0;
		const box = harness({
			subscribe: () => ({
				unsubscribe() {
					calls += 1;
					throw new Error("remote");
				},
			}),
		});
		const first = box.port.subscribe(() => undefined);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.unsubscribe()).toEqual({ ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } });
		expect(first.value.unsubscribe()).toEqual({ ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } });
		expect(calls).toBe(1);
		expect(box.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "POISONED" } });
	});

	test("certain unsubscribe permits exact resubscribe", () => {
		const box = harness();
		const first = box.port.subscribe(() => undefined);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.unsubscribe()).toEqual({ ok: true });
		const second = box.port.subscribe(() => undefined);
		expect(second.ok).toBe(true);
		if (second.ok) expect(second.value.unsubscribe()).toEqual({ ok: true });
		expect(box.calls.subscribe).toBe(2);
		expect(box.calls.unsubscribe).toBe(2);
	});

	test.each(["start", "terminal", "abort", "observe", "close"])(
		"contains rejected malformed Promise from %s without unhandledRejection",
		async (lane) => {
			await withoutUnhandledRejection(async () => {
				const rejected = Promise.reject(new Error(`rejected ${lane}`));
				Object.defineProperty(rejected, "marker", { value: true, configurable: true });
				const overrides: Partial<RawPort> = {};
				if (lane === "start") overrides.startInitialTask = () => rejected;
				if (lane === "terminal") overrides.awaitTerminal = () => rejected;
				if (lane === "abort") overrides.abort = () => rejected;
				if (lane === "observe") overrides.observe = () => rejected;
				if (lane === "close") overrides.close = () => rejected;
				const box = harness(overrides);
				if (lane === "start") await box.port.startInitialTask({ prompt: "go" });
				if (lane === "terminal") {
					await box.port.startInitialTask({ prompt: "go" });
					await box.port.awaitTerminal();
				}
				if (lane === "abort") {
					await box.port.startInitialTask({ prompt: "go" });
					await box.port.abort();
				}
				if (lane === "observe") await box.port.observe();
				if (lane === "close") await box.port.close();
				expect(box.calls.close).toBeGreaterThanOrEqual(1);
			});
		},
	);

	test.each(["subclass", "species accessor", "constructor accessor"])(
		"contains rejected %s Promise without invoking hostile constructor",
		async (kind) => {
			await withoutUnhandledRejection(async () => {
				let getterCalls = 0;
				let rejected: Promise<unknown>;
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
					rejected = Promise.reject(new Error("constructor"));
					Object.defineProperty(rejected, "constructor", {
						configurable: true,
						get() {
							getterCalls += 1;
							throw new Error("must not run");
						},
					});
				}
				const box = harness({ startInitialTask: () => rejected });
				expect(await box.port.startInitialTask({ prompt: "go" })).toEqual({
					ok: false,
					error: { code: "CALL_UNCERTAIN" },
				});
				expect(getterCalls).toBe(0);
				expect(box.calls.close).toBe(1);
			});
		},
	);

	test.each([
		["admission rejection", "start"],
		["terminal rejection", "terminal"],
		["abort rejection", "abort"],
		["observe rejection", "observe"],
		["close rejection", "close"],
		["admission malformed", "start-malformed"],
		["abort malformed", "abort-malformed"],
		["close malformed", "close-malformed"],
	])("maps %s without fabricating success", async (_name, lane) => {
		const rejected = () => Promise.reject(new Error("remote"));
		const overrides: Partial<RawPort> = {};
		if (lane === "start") overrides.startInitialTask = rejected;
		if (lane === "terminal") overrides.awaitTerminal = rejected;
		if (lane === "abort") overrides.abort = rejected;
		if (lane === "observe") overrides.observe = rejected;
		if (lane === "close") overrides.close = rejected;
		if (lane === "start-malformed") overrides.startInitialTask = () => Promise.resolve({ code: "NO" });
		if (lane === "abort-malformed") overrides.abort = () => Promise.resolve({ status: "maybe" });
		if (lane === "close-malformed") overrides.close = () => Promise.resolve({ status: "open" });
		const box = harness(overrides);
		let result: HostedRlmPortResult<unknown>;
		if (lane.startsWith("start")) result = await box.port.startInitialTask({ prompt: "go" });
		else if (lane === "terminal") {
			await box.port.startInitialTask({ prompt: "go" });
			result = await box.port.awaitTerminal();
		} else if (lane.startsWith("abort")) {
			await box.port.startInitialTask({ prompt: "go" });
			result = await box.port.abort();
		} else if (lane === "observe") result = await box.port.observe();
		else result = await box.port.close();
		expect(result.ok).toBe(false);
		expect(box.calls.close).toBeGreaterThanOrEqual(1);
	});

	test("admission and close retain independent 30 second deadlines", async () => {
		vi.useFakeTimers();
		const admission = deferred();
		const box = harness({ startInitialTask: () => admission.promise });
		const starting = box.port.startInitialTask({ prompt: "go" });
		await vi.advanceTimersByTimeAsync(30_001);
		expect(await starting).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
		expect(box.calls.close).toBe(1);
		admission.resolve({ code: "ADMITTED" });
		await Promise.resolve();
	});

	test("raw close timeout reports cleanup uncertainty", async () => {
		vi.useFakeTimers();
		const remoteClose = deferred();
		const box = harness({ close: () => remoteClose.promise });
		const closing = box.port.close();
		await vi.advanceTimersByTimeAsync(30_001);
		expect(await closing).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
		expect(box.calls.close).toBe(1);
	});

	test("contains raw subscribe throw and starts close", () => {
		const box = harness({
			subscribe() {
				throw new Error("subscribe");
			},
		});
		expect(box.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
		expect(box.calls.subscribe).toBe(1);
		expect(box.calls.close).toBe(1);
	});

	test.each(["start", "close"])("observes rejected non-extensible native Promise from %s", async (lane) => {
		await withoutUnhandledRejection(async () => {
			const rejected = Promise.reject(new Error(`non-extensible ${lane}`));
			Object.preventExtensions(rejected);
			expect(Object.getOwnPropertyDescriptor(rejected, "constructor")).toBeUndefined();
			expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(rejected), "constructor")?.get).toBeUndefined();
			const box = harness(lane === "start" ? { startInitialTask: () => rejected } : { close: () => rejected });
			const result = lane === "start" ? await box.port.startInitialTask({ prompt: "go" }) : await box.port.close();
			expect(result).toEqual({
				ok: false,
				error: { code: lane === "start" ? "CALL_UNCERTAIN" : "CLEANUP_UNCERTAIN" },
			});
			expect(Object.isExtensible(rejected)).toBe(false);
			expect(Object.getOwnPropertyDescriptor(rejected, "constructor")).toBeUndefined();
		});
	});
});
