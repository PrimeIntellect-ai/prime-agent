import { describe, expect, test, vi } from "vitest";
import {
	createHostedRlmRuntimePort,
	type HostedRlmAbortResult,
	type HostedRlmObservationSnapshot,
	type HostedRlmPortResult,
	type HostedRlmRuntimeEvent,
	type HostedRlmRuntimeIdentity,
	type HostedRlmRuntimePort,
	type HostedRlmSubscribeResult,
	type HostedRlmTaskResult,
} from "../src/core/hosted-rlm-runtime-port.js";

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

interface RawFactory {
	identity: unknown;
	startInitialTask: (input: unknown) => unknown;
	abort: () => unknown;
	observe: () => unknown;
	subscribe: (listener: (event: unknown) => void) => unknown;
}

interface Harness {
	raw: RawFactory;
	port: HostedRlmRuntimePort;
	calls: { start: number; abort: number; observe: number; subscribe: number; unsubscribe: number };
	emit: (event: unknown) => void;
}

function success<T>(result: HostedRlmPortResult<T>): T {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function subscription(result: HostedRlmSubscribeResult) {
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error(result.error.code);
	return result.value;
}

function makeHarness(overrides: Partial<RawFactory> = {}): Harness {
	const calls = { start: 0, abort: 0, observe: 0, subscribe: 0, unsubscribe: 0 };
	let callback: ((event: unknown) => void) | undefined;
	const raw: RawFactory = {
		identity: { ...IDENTITY },
		startInitialTask: () => {
			calls.start += 1;
			return Promise.resolve(TASK);
		},
		abort: () => {
			calls.abort += 1;
			return Promise.resolve<HostedRlmAbortResult>({ status: "aborted" });
		},
		observe: () => {
			calls.observe += 1;
			return Promise.resolve(SNAPSHOT);
		},
		subscribe: (listener) => {
			calls.subscribe += 1;
			callback = listener;
			return {
				unsubscribe() {
					calls.unsubscribe += 1;
					return { status: "unsubscribed" };
				},
			};
		},
		...overrides,
	};
	const created = createHostedRlmRuntimePort(raw);
	if (!created.ok) throw new Error(created.code);
	return { raw, port: created.value, calls, emit: (event) => callback?.(event) };
}

function expectPortError<T>(result: HostedRlmPortResult<T>, code: string): void {
	expect(result).toEqual({ ok: false, error: { code } });
}

function makePort(raw: RawFactory): HostedRlmRuntimePort {
	const result = createHostedRlmRuntimePort(raw);
	if (!result.ok) throw new Error(result.code);
	return result.value;
}

describe("createHostedRlmRuntimePort", () => {
	test("returns an immutable fresh identity and port", () => {
		const harness = makeHarness();
		expect(harness.port.identity).toEqual(IDENTITY);
		expect(harness.port.identity).not.toBe(harness.raw.identity);
		expect(Object.isFrozen(harness.port.identity)).toBe(true);
		expect(Object.isFrozen(harness.port)).toBe(true);
		expect(Object.keys(harness.port)).toEqual(["identity", "startInitialTask", "abort", "observe", "subscribe"]);
	});

	test.each([undefined, null, true, 4, "raw", [], () => undefined])("rejects invalid outer value %#", (raw) => {
		expect(createHostedRlmRuntimePort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test.each(["identity", "startInitialTask", "abort", "observe", "subscribe"])("rejects missing %s", (key) => {
		const raw = makeHarness().raw;
		const candidate: Record<string, unknown> = { ...raw };
		Reflect.deleteProperty(candidate, key);
		expect(createHostedRlmRuntimePort(candidate)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects outer Proxy without reading it", () => {
		const reads = vi.fn();
		const raw = new Proxy(makeHarness().raw, {
			get() {
				reads();
				throw new Error("secret");
			},
		});
		expect(createHostedRlmRuntimePort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(reads).not.toHaveBeenCalled();
	});

	test("rejects accessors without invoking them", () => {
		const getter = vi.fn();
		const raw: Record<string, unknown> = { ...makeHarness().raw };
		Object.defineProperty(raw, "identity", {
			enumerable: true,
			get() {
				getter();
				return IDENTITY;
			},
		});
		expect(createHostedRlmRuntimePort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(getter).not.toHaveBeenCalled();
	});

	test.each(["startInitialTask", "abort", "observe", "subscribe"])("rejects proxied method %s", (key) => {
		const raw: Record<string, unknown> = { ...makeHarness().raw };
		raw[key] = new Proxy(() => undefined, {});
		expect(createHostedRlmRuntimePort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects symbols, extras, custom prototypes, and invalid identities", () => {
		const base = makeHarness().raw;
		expect(createHostedRlmRuntimePort({ ...base, extra: true })).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(createHostedRlmRuntimePort({ ...base, [Symbol("x")]: true })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		const custom = Object.create(null);
		Object.assign(custom, base);
		expect(createHostedRlmRuntimePort(custom)).toEqual({ ok: false, code: "INVALID_INPUT" });
		for (const childId of ["", "has space", "x".repeat(129)]) {
			expect(createHostedRlmRuntimePort({ ...base, identity: { ...IDENTITY, childId } })).toEqual({
				ok: false,
				code: "INVALID_INPUT",
			});
		}
		expect(createHostedRlmRuntimePort({ ...base, identity: { ...IDENTITY, extra: true } })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
	});

	test("binds all raw methods to the original owner", async () => {
		let owner: RawFactory | undefined;
		const raw: RawFactory = {
			identity: { ...IDENTITY },
			startInitialTask() {
				if (this !== owner) throw new Error("this");
				return Promise.resolve(TASK);
			},
			abort() {
				if (this !== owner) throw new Error("this");
				return Promise.resolve({ status: "aborted" });
			},
			observe() {
				if (this !== owner) throw new Error("this");
				return Promise.resolve(SNAPSHOT);
			},
			subscribe() {
				if (this !== owner) throw new Error("this");
				return {
					unsubscribe() {
						return { status: "unsubscribed" };
					},
				};
			},
		};
		owner = raw;
		const port = makePort(raw);
		expect(success(await port.startInitialTask({ prompt: "go" })).status).toBe("completed");
		expect(success(await port.abort()).status).toBe("aborted");
		expect(success(await port.observe()).status).toBe("running");
		expect(subscription(port.subscribe(() => undefined)).unsubscribe()).toEqual({ ok: true });
	});
});

describe("task calls", () => {
	test("validates, copies, freezes, and returns a successful task result", async () => {
		let captured: unknown;
		const harness = makeHarness({
			startInitialTask: (input) => {
				captured = input;
				return Promise.resolve(TASK);
			},
		});
		const value = success(await harness.port.startInitialTask({ prompt: "go", spawnCode: "rlm('x')" }));
		expect(value).toEqual(TASK);
		expect(value).not.toBe(TASK);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.usage)).toBe(true);
		expect(captured).toEqual({ prompt: "go", spawnCode: "rlm('x')" });
		expect(Object.isFrozen(captured)).toBe(true);
	});

	test.each(["", "x".repeat(32_769)])("rejects invalid prompt %#", async (prompt) => {
		const harness = makeHarness();
		expectPortError(await harness.port.startInitialTask({ prompt }), "INVALID_ARGUMENT");
		expect(harness.calls.start).toBe(0);
	});

	test("rejects present undefined, extras, symbols, accessors, and Proxy input", async () => {
		const extraInput = { prompt: "go", extra: true };
		const symbolInput = { prompt: "go", [Symbol("x")]: true };
		const inputs = [extraInput, symbolInput];
		const undefinedInput = { prompt: "go" };
		Object.defineProperty(undefinedInput, "spawnCode", { enumerable: true, value: undefined });
		inputs.push(undefinedInput);
		const getterInput = { prompt: "go" };
		Object.defineProperty(getterInput, "spawnCode", {
			enumerable: true,
			get() {
				throw new Error("secret");
			},
		});
		inputs.push(getterInput);
		inputs.push(new Proxy({ prompt: "go" }, {}));
		for (const input of inputs) {
			const harness = makeHarness();
			expectPortError(await harness.port.startInitialTask(input), "INVALID_ARGUMENT");
			expect(harness.calls.start).toBe(0);
		}
	});

	test("is one-shot but invalid caller input does not consume start", async () => {
		const harness = makeHarness();
		expectPortError(await harness.port.startInitialTask({ prompt: "" }), "INVALID_ARGUMENT");
		expect(success(await harness.port.startInitialTask({ prompt: "one" })).status).toBe("completed");
		expectPortError(await harness.port.startInitialTask({ prompt: "two" }), "CALL_UNCERTAIN");
		expect(harness.calls.start).toBe(1);
	});

	test.each([
		{ status: "cancelled", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "CANCELLED" },
		{ status: "error", durationMs: 2, parentReplyCount: 0, toolUseCount: 1, errorCode: "TIMEOUT" },
		{ status: "error", durationMs: 3, parentReplyCount: 1, toolUseCount: 0, errorCode: "ADMISSION_FAILED" },
		{ status: "error", durationMs: 4, parentReplyCount: 0, toolUseCount: 0, errorCode: "INTERNAL_ERROR" },
	])("accepts exact semantic task result %#", async (task) => {
		const harness = makeHarness({ startInitialTask: () => Promise.resolve(task) });
		expect(success(await harness.port.startInitialTask({ prompt: "go" }))).toEqual(task);
	});

	test.each([
		{ ...TASK, extra: true },
		{ ...TASK, durationMs: -1 },
		{ ...TASK, answerPreview: undefined },
		{ ...TASK, errorCode: "INTERNAL_ERROR" },
		{ status: "cancelled", durationMs: 1, parentReplyCount: 0, toolUseCount: 0 },
		{ status: "error", durationMs: 1, parentReplyCount: 0, toolUseCount: 0, errorCode: "CANCELLED" },
	])("rejects malformed semantic task result %#", async (task) => {
		const harness = makeHarness({ startInitialTask: () => Promise.resolve(task) });
		expectPortError(await harness.port.startInitialTask({ prompt: "go" }), "MALFORMED_RESULT");
		expectPortError(await harness.port.observe(), "CALL_UNCERTAIN");
	});

	test.each(["throw", "nonpromise", "reject", "subclass", "own", "proxy"])(
		"rejects uncertain Promise boundary %s",
		async (mode) => {
			const promise = Promise.resolve(TASK);
			let call: () => unknown;
			if (mode === "throw")
				call = () => {
					throw new Error("secret");
				};
			else if (mode === "nonpromise") call = () => TASK;
			else if (mode === "reject") call = () => Promise.reject(new Error("secret"));
			else if (mode === "subclass")
				call = () => new (class extends Promise<HostedRlmTaskResult> {})((resolve) => resolve(TASK));
			else if (mode === "own") {
				Object.defineProperty(promise, "x", { value: true });
				call = () => promise;
			} else call = () => new Proxy(promise, {});
			const harness = makeHarness({ startInitialTask: call });
			expectPortError(await harness.port.startInitialTask({ prompt: "go" }), "CALL_UNCERTAIN");
			expectPortError(await harness.port.observe(), "CALL_UNCERTAIN");
		},
	);
});

describe("abort and observe", () => {
	test("shares one abort Promise and returns copied exact results", async () => {
		const harness = makeHarness();
		const first = harness.port.abort();
		const second = harness.port.abort();
		expect(first).toBe(second);
		expect(success(await first)).toEqual({ status: "aborted" });
		expect(harness.calls.abort).toBe(1);
	});

	test("accepts already_terminal and rejects malformed abort results without fabrication", async () => {
		const terminal = makeHarness({ abort: () => Promise.resolve({ status: "already_terminal" }) });
		expect(success(await terminal.port.abort())).toEqual({ status: "already_terminal" });
		for (const raw of ["bad", { status: "aborted", extra: true }, { status: "unknown" }]) {
			const harness = makeHarness({ abort: () => Promise.resolve(raw) });
			expectPortError(await harness.port.abort(), "MALFORMED_RESULT");
		}
	});

	test.each(["throw", "nonpromise", "reject"])("reports uncertain abort %s and shares the failure", async (mode) => {
		let call: () => unknown;
		if (mode === "throw")
			call = () => {
				throw new Error("secret");
			};
		else if (mode === "nonpromise") call = () => ({ status: "aborted" });
		else call = () => Promise.reject(new Error("secret"));
		const harness = makeHarness({ abort: call });
		const first = harness.port.abort();
		expectPortError(await first, "CALL_UNCERTAIN");
		expect(harness.port.abort()).toBe(first);
	});

	test("copies and deeply freezes exact observation snapshots", async () => {
		const harness = makeHarness();
		const value = success(await harness.port.observe());
		expect(value).toEqual(SNAPSHOT);
		expect(value).not.toBe(SNAPSHOT);
		expect(Object.isFrozen(value)).toBe(true);
		expect(Object.isFrozen(value.usage)).toBe(true);
	});

	test.each([
		{ ...SNAPSHOT, extra: true },
		{ ...SNAPSHOT, messageCount: -1 },
		{ ...SNAPSHOT, status: "completed", agentRunning: true },
		{ ...SNAPSHOT, answerPreview: undefined },
		{ ...SNAPSHOT, usage: { inputTokens: 1, outputTokens: -1 } },
	])("rejects malformed observation %#", async (snapshot) => {
		const harness = makeHarness({ observe: () => Promise.resolve(snapshot) });
		expectPortError(await harness.port.observe(), "MALFORMED_RESULT");
	});

	test.each(["throw", "nonpromise", "reject"])(
		"reports uncertain observation %s and poisons the port",
		async (mode) => {
			let call: () => unknown;
			if (mode === "throw")
				call = () => {
					throw new Error("secret");
				};
			else if (mode === "nonpromise") call = () => SNAPSHOT;
			else call = () => Promise.reject(new Error("secret"));
			const harness = makeHarness({ observe: call });
			expectPortError(await harness.port.observe(), "CALL_UNCERTAIN");
			expectPortError(await harness.port.startInitialTask({ prompt: "go" }), "CALL_UNCERTAIN");
		},
	);
});

describe("subscriptions", () => {
	test("delivers fresh frozen exact events and unsubscribes once", () => {
		const received: HostedRlmRuntimeEvent[] = [];
		const harness = makeHarness();
		const token = subscription(harness.port.subscribe((event) => received.push(event)));
		const raw = {
			type: "child_update",
			status: "running",
			toolUseCount: 2,
			parentReplyCount: 1,
			answerPreview: "ok",
		};
		harness.emit(raw);
		expect(received).toEqual([raw]);
		expect(received[0]).not.toBe(raw);
		expect(Object.isFrozen(received[0])).toBe(true);
		const first = token.unsubscribe();
		expect(first).toEqual({ ok: true });
		expect(token.unsubscribe()).toBe(first);
		expect(harness.calls.unsubscribe).toBe(1);
	});

	test.each([
		{ type: "agent_start" },
		{ type: "agent_end" },
		{ type: "waiting" },
		{ type: "writing", answerPreview: "text" },
		{ type: "executing", toolName: "bash" },
		{ type: "child_update", status: "completed", toolUseCount: 3, parentReplyCount: 2 },
	])("accepts event %#", (event) => {
		const received: HostedRlmRuntimeEvent[] = [];
		const harness = makeHarness();
		subscription(harness.port.subscribe((value) => received.push(value)));
		harness.emit(event);
		expect(received).toHaveLength(1);
	});

	test("rejects invalid and proxied listeners without calling raw subscribe", () => {
		const harness = makeHarness();
		const invalidResult = Reflect.apply(harness.port.subscribe, harness.port, ["bad"]);
		expect(invalidResult).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(harness.port.subscribe(new Proxy(() => undefined, {}))).toEqual({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
		expect(harness.calls.subscribe).toBe(0);
	});

	test("buffers synchronous events until an exact token is acquired", () => {
		const delivered: string[] = [];
		let owner: object | undefined;
		const harness = makeHarness({
			subscribe(listener) {
				listener({ type: "agent_start" });
				listener({ type: "waiting" });
				const token = {
					unsubscribe() {
						expect(this).toBe(owner);
						return { status: "unsubscribed" };
					},
				};
				owner = token;
				return token;
			},
		});
		const token = subscription(harness.port.subscribe((event) => delivered.push(event.type)));
		expect(delivered).toEqual(["agent_start", "waiting"]);
		expect(token.unsubscribe()).toEqual({ ok: true });
	});

	test("decodes all synchronous events before delivering any", async () => {
		const listener = vi.fn();
		let rawUnsubscribes = 0;
		const harness = makeHarness({
			subscribe(callback) {
				callback({ type: "agent_start" });
				callback({ type: "writing", answerPreview: undefined });
				return {
					unsubscribe() {
						rawUnsubscribes += 1;
						return { status: "unsubscribed" };
					},
				};
			},
		});
		expect(harness.port.subscribe(listener)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
		expect(listener).not.toHaveBeenCalled();
		expect(rawUnsubscribes).toBe(1);
		expectPortError(await harness.port.observe(), "CALL_UNCERTAIN");
	});

	test("a malformed later event unsubscribes and poisons", async () => {
		const listener = vi.fn();
		const harness = makeHarness();
		const token = subscription(harness.port.subscribe(listener));
		harness.emit({ type: "writing", answerPreview: undefined });
		expect(listener).not.toHaveBeenCalled();
		expect(harness.calls.unsubscribe).toBe(1);
		expect(token.unsubscribe()).toEqual({ ok: true });
		expect(harness.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "POISONED" } });
		expectPortError(await harness.port.observe(), "CALL_UNCERTAIN");
	});

	test("contains listener throws without poisoning", async () => {
		const harness = makeHarness();
		const token = subscription(
			harness.port.subscribe(() => {
				throw new Error("caller");
			}),
		);
		harness.emit({ type: "agent_start" });
		expect(token.unsubscribe()).toEqual({ ok: true });
		expect(success(await harness.port.observe()).status).toBe("running");
	});

	test.each(["throw", "proxy", "accessor", "extra"])(
		"backs out acquired subscription ownership for hostile token %s",
		(mode) => {
			let rawUnsubscribes = 0;
			const unsubscribe = () => {
				rawUnsubscribes += 1;
				return { status: "unsubscribed" };
			};
			const harness = makeHarness({
				subscribe: () => {
					if (mode === "throw") throw new Error("secret");
					if (mode === "proxy") return new Proxy({ unsubscribe }, {});
					if (mode === "accessor") {
						const token: Record<string, unknown> = {};
						Object.defineProperty(token, "unsubscribe", {
							enumerable: true,
							get() {
								throw new Error("secret");
							},
						});
						return token;
					}
					return { unsubscribe, extra: true };
				},
			});
			expect(harness.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
			expect(rawUnsubscribes).toBe(mode === "extra" ? 1 : 0);
		},
	);

	test("preserves uncertainty when raw unsubscribe throws", async () => {
		const harness = makeHarness({
			subscribe: () => ({
				unsubscribe() {
					throw new Error("secret");
				},
			}),
		});
		const token = subscription(harness.port.subscribe(() => undefined));
		const first = token.unsubscribe();
		expect(first).toEqual({ ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } });
		expect(token.unsubscribe()).toBe(first);
		expect(harness.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "POISONED" } });
		expectPortError(await harness.port.observe(), "CALL_UNCERTAIN");
	});

	test("allows a new subscription only after exact unsubscribe", () => {
		const harness = makeHarness();
		const first = subscription(harness.port.subscribe(() => undefined));
		expect(harness.port.subscribe(() => undefined)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
		expect(first.unsubscribe()).toEqual({ ok: true });
		const second = subscription(harness.port.subscribe(() => undefined));
		expect(second.unsubscribe()).toEqual({ ok: true });
		expect(harness.calls.subscribe).toBe(2);
	});
});
