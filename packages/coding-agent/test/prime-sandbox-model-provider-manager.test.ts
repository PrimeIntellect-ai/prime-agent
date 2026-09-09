import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { decodeModelReplyBytes, encodeModelRequest } from "../src/modes/daemon/sandbox/prime-sandbox-model-codec.ts";
import { createModelStreamProviderManager } from "../src/modes/daemon/sandbox/prime-sandbox-model-provider-manager.ts";

function frozen<T extends object>(value: T): Readonly<T> {
	return Object.freeze(value);
}

const apply: typeof Reflect.apply = Reflect.apply;
const then: typeof Promise.prototype.then = Promise.prototype.then;

function thenApply<T, A, B>(
	promise: Promise<T>,
	onFulfilled: (value: T) => A | PromiseLike<A>,
	onRejected: (error: unknown) => B | PromiseLike<B>,
): Promise<A | B> {
	return apply(then, promise, [onFulfilled, onRejected]);
}

function tick(): Promise<void> {
	return new Promise<void>((resolve: () => void): void => queueMicrotask(resolve));
}

interface Gate<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function gate<T>(): Gate<T> {
	const box: { resolve: ((value: T) => void) | null } = { resolve: null };
	const promise = new Promise<T>((resolve: (value: T) => void): void => {
		box.resolve = resolve;
	});
	return {
		promise,
		resolve(value: T): void {
			const resolve = box.resolve;
			if (resolve !== null) resolve(value);
		},
	};
}

function validModelBytes(): Uint8Array {
	const encoded = encodeModelRequest(
		{ systemPrompt: null, messages: [], tools: null },
		{
			cacheRetention: null,
			maxTokens: null,
			reasoning: null,
			serviceTier: null,
			sessionId: null,
			temperature: null,
			thinkingBudgets: null,
		},
	);
	if (!encoded.ok) return new Uint8Array();
	return encoded.bytes;
}

function assistantMessage(): Readonly<Record<string, unknown>> {
	return frozen({
		role: "assistant",
		content: frozen([]),
		api: "test",
		provider: "test",
		model: "test",
		responseModel: null,
		responseId: null,
		diagnostics: null,
		usage: frozen({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: frozen({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }),
		}),
		stopReason: "stop",
		stopReasonRaw: null,
		errorMessage: null,
		timestamp: 0,
	});
}

function successOutcome(): Readonly<{ ok: true; message: Readonly<Record<string, unknown>> }> {
	return frozen({ ok: true, message: assistantMessage() });
}

function sent(): Readonly<{ code: "SENT" }> {
	return frozen({ code: "SENT" });
}

const providerOk = frozen({ provide: (): Promise<unknown> => Promise.resolve(successOutcome()) });
const physicalOk = frozen({ shutdown: (): Promise<unknown> => Promise.resolve(frozen({ code: "SHUT_DOWN" })) });

interface PhysicalCounter {
	calls: number;
	readonly port: Readonly<{ shutdown: () => Promise<unknown> }>;
}

function physicalCounter(code: "SHUT_DOWN" | "FAILED" = "SHUT_DOWN"): PhysicalCounter {
	const state: PhysicalCounter = {
		calls: 0,
		port: frozen({
			shutdown: (): Promise<unknown> => {
				state.calls += 1;
				return Promise.resolve(frozen({ code }));
			},
		}),
	};
	return state;
}

interface ReplyCapture {
	readonly copies: Array<Uint8Array>;
	readonly references: Array<Uint8Array>;
	readonly reply: (raw: unknown) => Promise<unknown>;
}

function replyCapture(): ReplyCapture {
	const copies: Uint8Array[] = [];
	const references: Uint8Array[] = [];
	return {
		copies,
		references,
		reply(raw: unknown): Promise<unknown> {
			if (raw instanceof Uint8Array) {
				references[references.length] = raw;
				const copy = new Uint8Array(raw.byteLength);
				copy.set(raw);
				copies[copies.length] = copy;
			}
			return Promise.resolve(sent());
		},
	};
}

function bundle(
	payload: Uint8Array,
	signal: AbortSignal,
	reply: (raw: unknown) => unknown,
): Readonly<Record<string, unknown>> {
	return frozen({ origin: "Runtime", stream: 0, payload, signal, reply });
}

function allZero(bytes: Uint8Array): boolean {
	for (let index = 0; index < bytes.length; index += 1) if (bytes[index] !== 0) return false;
	return true;
}

function expectInternalError(bytes: Uint8Array): void {
	const decoded = decodeModelReplyBytes(bytes);
	expect(decoded.ok).toBe(true);
	if (decoded.ok) expect(decoded.reply).toEqual({ ok: false, code: "INTERNAL_ERROR" });
}

async function settle(): Promise<void> {
	await tick();
	await tick();
	await tick();
	await tick();
}

describe("V34 model stream provider manager", () => {
	test("rejects a wrong origin and physically shuts down", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const signal = new AbortController().signal;
		const payload = validModelBytes();
		manager.dispatchApplication(frozen({ origin: "Home", stream: 0, payload, signal, reply: replyCapture().reply }));
		expect(allZero(payload)).toBe(true);
		expect(physical.calls).toBe(1);
	});

	test("rejects a wrong stream", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const signal = new AbortController().signal;
		const payload = validModelBytes();
		manager.dispatchApplication(
			frozen({ origin: "Runtime", stream: 1, payload, signal, reply: replyCapture().reply }),
		);
		expect(allZero(payload)).toBe(true);
		expect(physical.calls).toBe(1);
	});

	test("rejects a non-frozen bundle", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const signal = new AbortController().signal;
		manager.dispatchApplication({
			origin: "Runtime",
			stream: 0,
			payload: validModelBytes(),
			signal,
			reply: replyCapture().reply,
		});
		expect(physical.calls).toBe(1);
	});

	test("rejects a proxy bundle without invoking its traps", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		let traps = 0;
		const target = bundle(validModelBytes(), new AbortController().signal, replyCapture().reply);
		const proxy = new Proxy(target, {
			get(): unknown {
				traps += 1;
				return undefined;
			},
		});
		manager.dispatchApplication(proxy);
		expect(physical.calls).toBe(1);
		expect(traps).toBe(0);
	});

	test("rejects extra bundle keys", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const signal = new AbortController().signal;
		manager.dispatchApplication(
			frozen({
				origin: "Runtime",
				stream: 0,
				payload: validModelBytes(),
				signal,
				reply: replyCapture().reply,
				extra: 1,
			}),
		);
		expect(physical.calls).toBe(1);
	});

	test("rejects bundle symbols", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const raw = {
			origin: "Runtime",
			stream: 0,
			payload: validModelBytes(),
			signal: new AbortController().signal,
			reply: replyCapture().reply,
		};
		Object.defineProperty(raw, Symbol("extra"), { value: true });
		manager.dispatchApplication(frozen(raw));
		expect(physical.calls).toBe(1);
	});

	test("rejects getter bundle properties without invoking the getter", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		let reads = 0;
		const raw = Object.defineProperties(
			{},
			{
				origin: { value: "Runtime", enumerable: true },
				stream: { value: 0, enumerable: true },
				payload: { value: validModelBytes(), enumerable: true },
				signal: { value: new AbortController().signal, enumerable: true },
				reply: {
					get(): (raw: unknown) => unknown {
						reads += 1;
						return replyCapture().reply;
					},
					enumerable: true,
				},
			},
		);
		manager.dispatchApplication(frozen(raw));
		expect(reads).toBe(0);
		expect(physical.calls).toBe(1);
	});

	test("rejects a non-ordinary bundle prototype", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const raw = Object.create(null);
		Object.defineProperties(
			raw,
			Object.getOwnPropertyDescriptors({
				origin: "Runtime",
				stream: 0,
				payload: validModelBytes(),
				signal: new AbortController().signal,
				reply: replyCapture().reply,
			}),
		);
		manager.dispatchApplication(frozen(raw));
		expect(physical.calls).toBe(1);
	});

	test("rejects a fake AbortSignal", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		manager.dispatchApplication(
			frozen({
				origin: "Runtime",
				stream: 0,
				payload: validModelBytes(),
				signal: frozen({ aborted: false }),
				reply: replyCapture().reply,
			}),
		);
		expect(physical.calls).toBe(1);
	});

	test("rejects a non-Uint8Array payload", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		manager.dispatchApplication(
			frozen({
				origin: "Runtime",
				stream: 0,
				payload: new ArrayBuffer(8),
				signal: new AbortController().signal,
				reply: replyCapture().reply,
			}),
		);
		expect(physical.calls).toBe(1);
	});

	test("rejects Uint8Array extra string properties", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const payload = validModelBytes();
		Object.defineProperty(payload, "extra", { value: 1 });
		manager.dispatchApplication(bundle(payload, new AbortController().signal, replyCapture().reply));
		expect(physical.calls).toBe(1);
	});

	test("rejects Uint8Array symbols", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const payload = validModelBytes();
		Object.defineProperty(payload, Symbol("extra"), { value: 1 });
		manager.dispatchApplication(bundle(payload, new AbortController().signal, replyCapture().reply));
		expect(physical.calls).toBe(1);
	});

	test("rejects Uint8Array views into a larger buffer", () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const storage = new ArrayBuffer(32);
		const payload = new Uint8Array(storage, 1, 16);
		manager.dispatchApplication(bundle(payload, new AbortController().signal, replyCapture().reply));
		expect(physical.calls).toBe(1);
	});

	test("accepts an empty full-buffer Uint8Array when already aborted", async () => {
		let providerCalls = 0;
		let replyCalls = 0;
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (): Promise<unknown> => {
					providerCalls += 1;
					return Promise.resolve(successOutcome());
				},
			}),
			physical.port,
		);
		const controller = new AbortController();
		controller.abort();
		manager.dispatchApplication(
			bundle(new Uint8Array(), controller.signal, (): Promise<unknown> => {
				replyCalls += 1;
				return Promise.resolve(sent());
			}),
		);
		expect(providerCalls).toBe(0);
		expect(replyCalls).toBe(0);
		expect(physical.calls).toBe(0);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("already-aborted malformed bytes have zero decode, provider, and reply effects", async () => {
		let providerCalls = 0;
		let replyCalls = 0;
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (): Promise<unknown> => {
					providerCalls += 1;
					return Promise.resolve(successOutcome());
				},
			}),
			physical.port,
		);
		const controller = new AbortController();
		controller.abort();
		const payload = new Uint8Array([1, 2, 3]);
		manager.dispatchApplication(
			bundle(payload, controller.signal, (): Promise<unknown> => {
				replyCalls += 1;
				return Promise.resolve(sent());
			}),
		);
		expect(allZero(payload)).toBe(true);
		expect(providerCalls).toBe(0);
		expect(replyCalls).toBe(0);
		expect(physical.calls).toBe(0);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("the 33rd live provider gets a synchronous fresh INTERNAL_ERROR", async () => {
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => new Promise<unknown>(() => undefined) }),
			physicalOk,
		);
		for (let index = 0; index < 32; index += 1) {
			manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, replyCapture().reply));
		}
		const first = replyCapture();
		const second = replyCapture();
		const firstPayload = validModelBytes();
		const secondPayload = validModelBytes();
		manager.dispatchApplication(bundle(firstPayload, new AbortController().signal, first.reply));
		manager.dispatchApplication(bundle(secondPayload, new AbortController().signal, second.reply));
		expect(first.copies.length).toBe(1);
		expect(second.copies.length).toBe(1);
		expect(first.references[0]).not.toBe(second.references[0]);
		expect(allZero(first.references[0])).toBe(true);
		expect(allZero(second.references[0])).toBe(true);
		expect(allZero(firstPayload)).toBe(true);
		expect(allZero(secondPayload)).toBe(true);
		expectInternalError(first.copies[0]);
		expectInternalError(second.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("cancellation does not release provider quota before actual settlement", async () => {
		const gates: Gate<unknown>[] = [];
		let providerCalls = 0;
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (): Promise<unknown> => {
					const pending = gate<unknown>();
					gates[gates.length] = pending;
					providerCalls += 1;
					return pending.promise;
				},
			}),
			physicalOk,
		);
		const controllers: AbortController[] = [];
		for (let index = 0; index < 32; index += 1) {
			const controller = new AbortController();
			controllers[controllers.length] = controller;
			manager.dispatchApplication(bundle(validModelBytes(), controller.signal, replyCapture().reply));
		}
		for (let index = 0; index < controllers.length; index += 1) controllers[index].abort();
		const busy = replyCapture();
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, busy.reply));
		expect(providerCalls).toBe(32);
		expect(busy.copies.length).toBe(1);
		gates[0].resolve(successOutcome());
		await settle();
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, replyCapture().reply));
		expect(providerCalls).toBe(33);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("zeros the original payload after successful decode", () => {
		const manager = createModelStreamProviderManager(providerOk, physicalOk);
		const payload = validModelBytes();
		manager.dispatchApplication(bundle(payload, new AbortController().signal, replyCapture().reply));
		expect(allZero(payload)).toBe(true);
	});

	test("malformed hostile bytes zero the original and poison once", async () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		const payload = new Uint8Array([1, 2, 3]);
		manager.dispatchApplication(bundle(payload, new AbortController().signal, replyCapture().reply));
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, replyCapture().reply));
		expect(allZero(payload)).toBe(true);
		expect(physical.calls).toBe(1);
		expect((await manager.shutdown()).code).toBe("POISONED");
	});

	test("provider synchronous failure maps to INTERNAL_ERROR without leaking text", async () => {
		const capture = replyCapture();
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (): unknown => decodeURIComponent("%"),
			}),
			physicalOk,
		);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		expect(capture.copies.length).toBe(1);
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider rejection maps to INTERNAL_ERROR", async () => {
		const capture = replyCapture();
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => Promise.reject(new Error("private rejection")) }),
			physicalOk,
		);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		await settle();
		expect(capture.copies.length).toBe(1);
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider non-Promise return maps to INTERNAL_ERROR", async () => {
		const capture = replyCapture();
		const hostileKey = "then";
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): unknown => frozen({ [hostileKey]: true }) }),
			physicalOk,
		);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		expect(capture.copies.length).toBe(1);
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider Promise with an own then maps to INTERNAL_ERROR", async () => {
		const capture = replyCapture();
		const promise = Promise.resolve(successOutcome());
		const hostileKey = "then";
		Object.defineProperty(promise, hostileKey, { value: Promise.prototype.then });
		const manager = createModelStreamProviderManager(frozen({ provide: (): unknown => promise }), physicalOk);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider Promise with an own constructor maps to INTERNAL_ERROR", async () => {
		const capture = replyCapture();
		const promise = Promise.resolve(successOutcome());
		Object.defineProperty(promise, "constructor", { value: Promise });
		const manager = createModelStreamProviderManager(frozen({ provide: (): unknown => promise }), physicalOk);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider Promise with an own species symbol maps to INTERNAL_ERROR", async () => {
		const capture = replyCapture();
		const promise = Promise.resolve(successOutcome());
		Object.defineProperty(promise, Symbol.species, { value: Promise });
		const manager = createModelStreamProviderManager(frozen({ provide: (): unknown => promise }), physicalOk);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("malformed provider output maps to a fresh INTERNAL_ERROR", async () => {
		const capture = replyCapture();
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => Promise.resolve(frozen({ ok: true, message: "malformed" })) }),
			physicalOk,
		);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		await settle();
		expectInternalError(capture.copies[0]);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("encoder bytes are zero before reply Promise observation", async () => {
		const capture = replyCapture();
		const manager = createModelStreamProviderManager(providerOk, physicalOk);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
		await settle();
		expect(capture.copies.length).toBe(1);
		expect(allZero(capture.references[0])).toBe(true);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("reply synchronous failure still zeros encoder bytes and poisons", async () => {
		const references: Uint8Array[] = [];
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		function reply(raw: unknown): unknown {
			if (raw instanceof Uint8Array) references[references.length] = raw;
			return decodeURIComponent("%");
		}
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, reply));
		await settle();
		expect(allZero(references[0])).toBe(true);
		expect(physical.calls).toBe(1);
		expect((await manager.shutdown()).code).toBe("POISONED");
	});

	test("non-native reply Promise still zeros encoder bytes and poisons", async () => {
		const references: Uint8Array[] = [];
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		function reply(raw: unknown): unknown {
			if (raw instanceof Uint8Array) references[references.length] = raw;
			return frozen({ code: "SENT" });
		}
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, reply));
		await settle();
		expect(allZero(references[0])).toBe(true);
		expect(physical.calls).toBe(1);
		expect((await manager.shutdown()).code).toBe("POISONED");
	});

	test("abort before provider settlement suppresses reply", async () => {
		const provider = gate<unknown>();
		let replies = 0;
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => provider.promise }),
			physicalOk,
		);
		const controller = new AbortController();
		manager.dispatchApplication(
			bundle(validModelBytes(), controller.signal, (): Promise<unknown> => {
				replies += 1;
				return Promise.resolve(sent());
			}),
		);
		controller.abort();
		provider.resolve(successOutcome());
		await settle();
		expect(replies).toBe(0);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider settlement queued before abort wins the race", async () => {
		const provider = gate<unknown>();
		let replies = 0;
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => provider.promise }),
			physicalOk,
		);
		const controller = new AbortController();
		manager.dispatchApplication(
			bundle(validModelBytes(), controller.signal, (): Promise<unknown> => {
				replies += 1;
				return Promise.resolve(sent());
			}),
		);
		provider.resolve(successOutcome());
		controller.abort();
		await settle();
		expect(replies).toBe(1);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("physical shutdown synchronous reentry returns the first cached Promise", async () => {
		const state: {
			manager: ReturnType<typeof createModelStreamProviderManager> | null;
			reentered: Promise<unknown> | null;
			calls: number;
		} = { manager: null, reentered: null, calls: 0 };
		const physical = frozen({
			shutdown: (): Promise<unknown> => {
				state.calls += 1;
				const current = state.manager;
				if (current !== null) state.reentered = current.shutdown();
				return Promise.resolve(frozen({ code: "SHUT_DOWN" }));
			},
		});
		const manager = createModelStreamProviderManager(providerOk, physical);
		state.manager = manager;
		const first = manager.shutdown();
		expect(state.reentered).toBe(first);
		expect(manager.shutdown()).toBe(first);
		expect((await first).code).toBe("SHUT_DOWN");
		expect(state.calls).toBe(1);
	});

	test("listener removal failure revokes the cell and poisons once", async () => {
		const script = `
EventTarget.prototype.removeEventListener = function removeFailure() { return decodeURIComponent("%"); };
const codec = await import("./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-model-codec.ts");
const providerModule = await import("./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-model-provider-manager.ts");
const encoded = codec.encodeModelRequest(
  { systemPrompt: null, messages: [], tools: null },
  { cacheRetention: null, maxTokens: null, reasoning: null, serviceTier: null, sessionId: null, temperature: null, thinkingBudgets: null },
);
const shutdownState = { calls: 0 };
const message = Object.freeze({
  role: "assistant", content: Object.freeze([]), api: "test", provider: "test", model: "test",
  responseModel: null, responseId: null, diagnostics: null,
  usage: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }) }),
  stopReason: "stop", stopReasonRaw: null, errorMessage: null, timestamp: 0,
});
const manager = providerModule.createModelStreamProviderManager(
  Object.freeze({ provide: () => Promise.resolve(Object.freeze({ ok: true, message })) }),
  Object.freeze({ shutdown: () => { shutdownState.calls += 1; return Promise.resolve(Object.freeze({ code: "SHUT_DOWN" })); } }),
);
manager.dispatchApplication(Object.freeze({
  origin: "Runtime", stream: 0, payload: encoded.bytes, signal: new AbortController().signal,
  reply: () => Promise.resolve(Object.freeze({ code: "SENT" })),
}));
await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
const result = await manager.shutdown();
process.stdout.write(JSON.stringify({ code: result.code, calls: shutdownState.calls }));
`;
		const { stdout: output, stderr: errorOutput } = await promisify(execFile)("bun", ["-e", script], {
			cwd: process.cwd(),
		});
		expect(errorOutput).toBe("");
		expect(output.trim()).toBe('{"code":"POISONED","calls":1}');
	});

	test("shutdown returns one cached Promise and the manager is exact frozen", async () => {
		const manager = createModelStreamProviderManager(providerOk, physicalOk);
		expect(Object.isFrozen(manager)).toBe(true);
		expect(Object.getPrototypeOf(manager)).toBe(Object.prototype);
		expect(Reflect.ownKeys(manager)).toEqual(["dispatchApplication", "shutdown"]);
		const first = manager.shutdown();
		const second = manager.shutdown();
		expect(first).toBe(second);
		expect((await first).code).toBe("SHUT_DOWN");
	});

	test("failed physical shutdown waits for the provider inventory", async () => {
		const provider = gate<unknown>();
		const physical = physicalCounter("FAILED");
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => provider.promise }),
			physical.port,
		);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, replyCapture().reply));
		let settled = false;
		const shutdown = manager.shutdown();
		const observation = thenApply(
			shutdown,
			(): void => {
				settled = true;
			},
			(_error: unknown): void => {
				settled = true;
			},
		);
		await settle();
		expect(settled).toBe(false);
		provider.resolve(successOutcome());
		await observation;
		expect((await shutdown).code).toBe("POISONED");
	});

	test("failed physical shutdown also waits for an exact pending reply", async () => {
		const replyGate = gate<unknown>();
		const physical = physicalCounter("FAILED");
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		manager.dispatchApplication(
			bundle(validModelBytes(), new AbortController().signal, (): Promise<unknown> => replyGate.promise),
		);
		await settle();
		let settled = false;
		const shutdown = manager.shutdown();
		const observation = thenApply(
			shutdown,
			(): void => {
				settled = true;
			},
			(_error: unknown): void => {
				settled = true;
			},
		);
		await settle();
		expect(settled).toBe(false);
		replyGate.resolve(sent());
		await observation;
		expect((await shutdown).code).toBe("POISONED");
	});

	test("settled physical proof revokes a never-settling provider actual", async () => {
		const physical = gate<unknown>();
		const manager = createModelStreamProviderManager(
			frozen({ provide: (): Promise<unknown> => new Promise<unknown>(() => undefined) }),
			frozen({ shutdown: (): Promise<unknown> => physical.promise }),
		);
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, replyCapture().reply));
		const shutdown = manager.shutdown();
		physical.resolve(frozen({ code: "SHUT_DOWN" }));
		expect((await shutdown).code).toBe("SHUT_DOWN");
	});

	test("physical shutdown is invoked exactly once across poison and shutdown", async () => {
		const physical = physicalCounter();
		const manager = createModelStreamProviderManager(providerOk, physical.port);
		manager.dispatchApplication(frozen({ invalid: true }));
		manager.dispatchApplication(frozen({ invalid: true }));
		const first = manager.shutdown();
		const second = manager.shutdown();
		expect(first).toBe(second);
		expect((await first).code).toBe("POISONED");
		expect(physical.calls).toBe(1);
	});

	test("provider slots are reusable for more than 32 sequential requests", async () => {
		const providerState = { calls: 0 };
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (): Promise<unknown> => {
					providerState.calls += 1;
					return Promise.resolve(successOutcome());
				},
			}),
			physicalOk,
		);
		for (let index = 0; index < 40; index += 1) {
			const capture = replyCapture();
			manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, capture.reply));
			await settle();
			expect(capture.copies.length).toBe(1);
		}
		expect(providerState.calls).toBe(40);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("exact bundle signal is forwarded to provider", async () => {
		const captured: { signal: unknown } = { signal: null };
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (_request: unknown, signal: AbortSignal): Promise<unknown> => {
					captured.signal = signal;
					return Promise.resolve(successOutcome());
				},
			}),
			physicalOk,
		);
		const controller = new AbortController();
		manager.dispatchApplication(bundle(validModelBytes(), controller.signal, replyCapture().reply));
		await settle();
		expect(captured.signal).toBe(controller.signal);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("provider receives abort and manager suppresses reply", async () => {
		const providerGate = gate<unknown>();
		let abortFired = false;
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (_request: unknown, signal: AbortSignal): Promise<unknown> => {
					signal.addEventListener("abort", (): void => {
						abortFired = true;
					});
					return providerGate.promise;
				},
			}),
			physicalOk,
		);
		let replies = 0;
		const controller = new AbortController();
		manager.dispatchApplication(
			bundle(validModelBytes(), controller.signal, (): Promise<unknown> => {
				replies += 1;
				return Promise.resolve(sent());
			}),
		);
		controller.abort();
		providerGate.resolve(successOutcome());
		await settle();
		expect(abortFired).toBe(true);
		expect(replies).toBe(0);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("aborted provider slot is reusable for a subsequent dispatch", async () => {
		const providerGate = gate<unknown>();
		let calls = 0;
		const manager = createModelStreamProviderManager(
			frozen({
				provide: (_request: unknown, _signal: unknown): Promise<unknown> => {
					calls += 1;
					return providerGate.promise;
				},
			}),
			physicalOk,
		);
		const controller = new AbortController();
		manager.dispatchApplication(bundle(validModelBytes(), controller.signal, replyCapture().reply));
		controller.abort();
		providerGate.resolve(successOutcome());
		await settle();
		const second = replyCapture();
		manager.dispatchApplication(bundle(validModelBytes(), new AbortController().signal, second.reply));
		await settle();
		expect(second.copies.length).toBe(1);
		expect(calls).toBe(2);
		expect((await manager.shutdown()).code).toBe("SHUT_DOWN");
	});

	test("physical shutdown receives zero arguments", async () => {
		let shutdownArgCount = -1;
		const manager = createModelStreamProviderManager(
			providerOk,
			frozen({
				shutdown: function (): Promise<unknown> {
					// biome-ignore lint/complexity/noArguments: Exact zero-argument forwarding is the behavior under test.
					shutdownArgCount = arguments.length;
					return Promise.resolve(frozen({ code: "SHUT_DOWN" }));
				},
			}),
		);
		await manager.shutdown();
		expect(shutdownArgCount).toBe(0);
	});
});
