import { describe, expect, test, vi } from "vitest";
import {
	createHostedOrderedRelayTransport,
	type HostedRelayIncomingController,
	type HostedRelaySubscribeResult,
	type HostedRelayTransport,
} from "../src/modes/daemon/hosted-ordered-relay-transport.js";
import type { RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";

interface RawPort {
	identity: unknown;
	send: (envelope: unknown) => unknown;
	subscribe: (listener: (envelope: unknown) => void) => unknown;
	observe: () => unknown;
	close: () => unknown;
}

interface Harness {
	port: RawPort;
	calls: { send: number; subscribe: number; unsubscribe: number; close: number };
	emit: (value: unknown) => void;
}

interface AdapterHarness extends Harness {
	transport: HostedRelayTransport;
	incoming: HostedRelayIncomingController;
}

function envelope(frameId = "frame-1"): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId,
		protocol: { name: "prime-agent.remote-host", version: 1 },
		sentAt: "2025-01-01T00:00:00.000Z",
		frame: { type: "health", healthSeq: 1, status: "connected" },
	};
}

function deferred<T>() {
	let resolveValue: (value: T) => void = () => undefined;
	let rejectValue: () => void = () => undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolveValue = resolve;
		rejectValue = () => reject(new Error("test rejection"));
	});
	return { promise, resolve: resolveValue, reject: rejectValue };
}

function makeHarness(): Harness {
	const calls = { send: 0, subscribe: 0, unsubscribe: 0, close: 0 };
	let callback: ((value: unknown) => void) | undefined;
	const port: RawPort = {
		identity: { hostId: "host-1", generation: "generation-1", sessionId: "session-1" },
		send: () => {
			calls.send += 1;
			return Promise.resolve({ ok: true, value: "ACCEPTED" });
		},
		subscribe: (listener) => {
			calls.subscribe += 1;
			callback = listener;
			return {
				ok: true,
				value: {
					unsubscribe() {
						calls.unsubscribe += 1;
						return { ok: true, code: "UNSUBSCRIBED" };
					},
				},
			};
		},
		observe: () => Promise.resolve({ ok: true, value: {} }),
		close: () => {
			calls.close += 1;
			return Promise.resolve({ ok: true, code: "CLOSED" });
		},
	};
	return { port, calls, emit: (value) => callback?.(value) };
}

async function makeAdapter(harness = makeHarness()): Promise<AdapterHarness> {
	const created = await createHostedOrderedRelayTransport({ port: harness.port });
	if (!created.ok) throw new Error(created.error.code);
	return { ...harness, transport: created.transport, incoming: created.incoming };
}

function subscribeRaw(incoming: HostedRelayIncomingController, listener: () => unknown): HostedRelaySubscribeResult {
	return Reflect.apply(incoming.subscribe, incoming, [listener]);
}

function promiseWithOwnProperty<T>(value: T): Promise<T> {
	const promise = Promise.resolve(value);
	Object.defineProperty(promise, "extra", { value: true });
	return promise;
}

function promiseWithOwnSymbol<T>(value: T): Promise<T> {
	const promise = Promise.resolve(value);
	Object.defineProperty(promise, Symbol("extra"), { value: true });
	return promise;
}

describe("factory ownership and validation", () => {
	test.each([undefined, null, false, 1, "raw", [], () => undefined])("rejects ownerless input %#", async (raw) => {
		expect(await createHostedOrderedRelayTransport(raw)).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	test("rejects missing port without inventing cleanup", async () => {
		expect(await createHostedOrderedRelayTransport({})).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	test("does not invoke an outer accessor", async () => {
		const getter = vi.fn();
		const raw: Record<string, unknown> = {};
		Object.defineProperty(raw, "port", {
			enumerable: true,
			get() {
				getter();
				return makeHarness().port;
			},
		});
		expect(await createHostedOrderedRelayTransport(raw)).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(getter).not.toHaveBeenCalled();
	});

	test("rejects outer Proxy without reflection", async () => {
		const trap = vi.fn();
		const raw = new Proxy(
			{ port: makeHarness().port },
			{
				getOwnPropertyDescriptor() {
					trap();
					throw new Error("trap");
				},
			},
		);
		expect(await createHostedOrderedRelayTransport(raw)).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(trap).not.toHaveBeenCalled();
	});

	test.each(["extra", "symbol", "custom", "nonenumerable"])(
		"closes acquired port for invalid outer %s",
		async (mode) => {
			const harness = makeHarness();
			let raw: object;
			if (mode === "extra") raw = { port: harness.port, extra: true };
			else if (mode === "symbol") raw = { port: harness.port, [Symbol("x")]: true };
			else if (mode === "custom") raw = Object.assign(Object.create(null), { port: harness.port });
			else {
				raw = {};
				Object.defineProperty(raw, "port", { value: harness.port, enumerable: false });
			}
			expect(await createHostedOrderedRelayTransport(raw)).toEqual({
				ok: false,
				error: { code: "INVALID_ARGUMENT" },
			});
			expect(harness.calls.close).toBe(1);
		},
	);

	test("returns close uncertainty when acquired factory cleanup is malformed", async () => {
		const harness = makeHarness();
		harness.port.close = () => {
			harness.calls.close += 1;
			return { ok: true, code: "CLOSED" };
		};
		expect(await createHostedOrderedRelayTransport({ port: harness.port, extra: true })).toEqual({
			ok: false,
			error: { code: "CLOSE_UNCERTAIN" },
		});
		expect(harness.calls.close).toBe(1);
	});

	test.each(["missing", "extra", "symbol", "custom", "identity", "methodProxy", "observeProxy"])(
		"closes acquired invalid port %s",
		async (mode) => {
			const harness = makeHarness();
			let port: object = harness.port;
			if (mode === "missing") {
				const candidate: Record<string, unknown> = { ...harness.port };
				Reflect.deleteProperty(candidate, "send");
				port = candidate;
			} else if (mode === "extra") port = { ...harness.port, extra: true };
			else if (mode === "symbol") port = { ...harness.port, [Symbol("x")]: true };
			else if (mode === "custom") port = Object.assign(Object.create(null), harness.port);
			else if (mode === "identity")
				port = { ...harness.port, identity: { hostId: "bad id", generation: "g", sessionId: "s" } };
			else if (mode === "methodProxy") port = { ...harness.port, send: new Proxy(harness.port.send, {}) };
			else port = { ...harness.port, observe: new Proxy(harness.port.observe, {}) };
			expect(await createHostedOrderedRelayTransport({ port })).toEqual({
				ok: false,
				error: { code: "INVALID_ARGUMENT" },
			});
			expect(harness.calls.close).toBe(1);
		},
	);

	test("rejects a proxied port as cleanup-uncertain", async () => {
		const harness = makeHarness();
		expect(await createHostedOrderedRelayTransport({ port: new Proxy(harness.port, {}) })).toEqual({
			ok: false,
			error: { code: "CLOSE_UNCERTAIN" },
		});
		expect(harness.calls.close).toBe(0);
	});

	test("rejects a proxied close method as cleanup-uncertain", async () => {
		const harness = makeHarness();
		const port = { ...harness.port, close: new Proxy(harness.port.close, {}) };
		expect(await createHostedOrderedRelayTransport({ port })).toEqual({
			ok: false,
			error: { code: "CLOSE_UNCERTAIN" },
		});
		expect(harness.calls.close).toBe(0);
	});

	test("binds raw port methods to their original owner", async () => {
		const harness = makeHarness();
		let owner: RawPort | undefined;
		const port: RawPort = {
			identity: harness.port.identity,
			send() {
				if (this !== owner) throw new Error("this");
				return Promise.resolve({ ok: true, value: "ACCEPTED" });
			},
			subscribe() {
				if (this !== owner) throw new Error("this");
				return {
					ok: true,
					value: {
						unsubscribe() {
							return { ok: true, code: "UNSUBSCRIBED" };
						},
					},
				};
			},
			observe() {
				if (this !== owner) throw new Error("this");
				return Promise.resolve({ ok: true, value: {} });
			},
			close() {
				if (this !== owner) throw new Error("this");
				return Promise.resolve({ ok: true, code: "CLOSED" });
			},
		};
		owner = port;
		const created = await createHostedOrderedRelayTransport({ port });
		if (!created.ok) throw new Error(created.error.code);
		expect(await created.transport.send({ envelope: envelope() })).toEqual({ status: "sent" });
		expect(created.incoming.subscribe(() => Promise.resolve({ status: "accepted" })).ok).toBe(true);
		expect(await created.transport.close()).toEqual({ status: "closed" });
	});

	test("returns frozen, separate views", async () => {
		const adapter = await makeAdapter();
		expect(adapter.transport).not.toBe(adapter.incoming);
		expect(Object.isFrozen(adapter.transport)).toBe(true);
		expect(Object.isFrozen(adapter.incoming)).toBe(true);
		expect(Object.keys(adapter.transport)).toEqual(["send", "close"]);
		expect(Object.keys(adapter.incoming)).toEqual(["subscribe"]);
	});
});

describe("ordered transport send", () => {
	test("decodes a fresh envelope and maps exact acceptance", async () => {
		const harness = makeHarness();
		let captured: unknown;
		harness.port.send = (value) => {
			harness.calls.send += 1;
			captured = value;
			return Promise.resolve({ ok: true, value: "ACCEPTED" });
		};
		const adapter = await makeAdapter(harness);
		const raw = envelope();
		expect(await adapter.transport.send({ envelope: raw })).toEqual({ status: "sent" });
		expect(captured).toEqual(raw);
		expect(captured).not.toBe(raw);
		expect(adapter.calls.send).toBe(1);
	});

	test.each(["extra", "symbol", "custom", "proxy", "accessor", "badEnvelope"])(
		"rejects hostile input %s without calling raw send",
		async (mode) => {
			const adapter = await makeAdapter();
			let input: object;
			if (mode === "extra") input = { envelope: envelope(), extra: true };
			else if (mode === "symbol") input = { envelope: envelope(), [Symbol("x")]: true };
			else if (mode === "custom") input = Object.assign(Object.create(null), { envelope: envelope() });
			else if (mode === "proxy") input = new Proxy({ envelope: envelope() }, {});
			else if (mode === "accessor") {
				input = {};
				Object.defineProperty(input, "envelope", {
					enumerable: true,
					get() {
						throw new Error("secret");
					},
				});
			} else input = { envelope: { ...envelope(), extra: true } };
			const result = await Reflect.apply(adapter.transport.send, adapter.transport, [input]);
			expect(result).toEqual({ status: "error" });
			expect(adapter.calls.send).toBe(0);
			expect(await adapter.transport.close()).toEqual({ status: "error" });
			expect(adapter.calls.close).toBe(1);
		},
	);

	test.each(["throw", "nonpromise", "reject", "subclass", "own", "symbol", "proxy", "malformed"])(
		"poisons on hostile raw send %s",
		async (mode) => {
			const harness = makeHarness();
			const accepted = { ok: true, value: "ACCEPTED" };
			const native = Promise.resolve(accepted);
			if (mode === "throw")
				harness.port.send = () => {
					throw new Error("secret");
				};
			else if (mode === "nonpromise") harness.port.send = () => accepted;
			else if (mode === "reject") harness.port.send = () => Promise.reject(new Error("secret"));
			else if (mode === "subclass")
				harness.port.send = () => new (class extends Promise<unknown> {})((resolve) => resolve(accepted));
			else if (mode === "own") harness.port.send = () => promiseWithOwnProperty(accepted);
			else if (mode === "symbol") harness.port.send = () => promiseWithOwnSymbol(accepted);
			else if (mode === "proxy") harness.port.send = () => new Proxy(native, {});
			else harness.port.send = () => Promise.resolve({ ok: true, value: "ACCEPTED", extra: true });
			const adapter = await makeAdapter(harness);
			expect(await adapter.transport.send({ envelope: envelope() })).toEqual({ status: "error" });
			expect(await adapter.transport.send({ envelope: envelope("frame-2") })).toEqual({ status: "error" });
			expect(await adapter.transport.close()).toEqual({ status: "error" });
			expect(adapter.calls.close).toBe(1);
		},
	);

	test("serializes concurrent sends", async () => {
		const harness = makeHarness();
		const first = deferred<unknown>();
		const order: string[] = [];
		harness.port.send = (value) => {
			const id =
				typeof value === "object" && value !== null
					? Object.getOwnPropertyDescriptor(value, "frameId")?.value
					: undefined;
			order.push(String(id));
			return id === "frame-1" ? first.promise : Promise.resolve({ ok: true, value: "ACCEPTED" });
		};
		const adapter = await makeAdapter(harness);
		const one = adapter.transport.send({ envelope: envelope("frame-1") });
		const two = adapter.transport.send({ envelope: envelope("frame-2") });
		await Promise.resolve();
		expect(order).toEqual(["frame-1"]);
		first.resolve({ ok: true, value: "ACCEPTED" });
		expect(await one).toEqual({ status: "sent" });
		expect(await two).toEqual({ status: "sent" });
		expect(order).toEqual(["frame-1", "frame-2"]);
	});

	test("close waits for an admitted send and rejects later sends", async () => {
		const harness = makeHarness();
		const pending = deferred<unknown>();
		const order: string[] = [];
		harness.port.send = () => {
			order.push("send");
			return pending.promise;
		};
		harness.port.close = () => {
			harness.calls.close += 1;
			order.push("close");
			return Promise.resolve({ ok: true, code: "CLOSED" });
		};
		const adapter = await makeAdapter(harness);
		const send = adapter.transport.send({ envelope: envelope() });
		const close = adapter.transport.close();
		expect(await adapter.transport.send({ envelope: envelope("later") })).toEqual({ status: "error" });
		expect(order).toEqual(["send"]);
		pending.resolve({ ok: true, value: "ACCEPTED" });
		expect(await send).toEqual({ status: "sent" });
		expect(await close).toEqual({ status: "closed" });
		expect(order).toEqual(["send", "close"]);
	});
});

describe("incoming subscription", () => {
	test("rejects invalid and Proxy listeners before raw subscribe", async () => {
		const adapter = await makeAdapter();
		expect(Reflect.apply(adapter.incoming.subscribe, adapter.incoming, ["bad"])).toEqual({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
		expect(adapter.incoming.subscribe(new Proxy(() => Promise.resolve({ status: "accepted" }), {}))).toEqual({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
		expect(adapter.calls.subscribe).toBe(0);
	});

	test("buffers synchronous events and binds raw unsubscribe owner", async () => {
		const harness = makeHarness();
		const delivered: string[] = [];
		let tokenOwner: object | undefined;
		harness.port.subscribe = (callback) => {
			callback(envelope("frame-1"));
			callback(envelope("frame-2"));
			const token = {
				unsubscribe() {
					expect(this).toBe(tokenOwner);
					harness.calls.unsubscribe += 1;
					return { ok: true, code: "UNSUBSCRIBED" };
				},
			};
			tokenOwner = token;
			return { ok: true, value: token };
		};
		const adapter = await makeAdapter(harness);
		const result = adapter.incoming.subscribe(async (value) => {
			delivered.push(value.frameId);
			return { status: "accepted" };
		});
		if (!result.ok) throw new Error(result.error.code);
		await result.value.unsubscribe();
		expect(delivered).toEqual(["frame-1", "frame-2"]);
		expect(harness.calls.unsubscribe).toBe(1);
	});

	test("decodes all synchronous events before delivering any", async () => {
		const harness = makeHarness();
		const listener = vi.fn(async (): Promise<Readonly<{ status: "accepted" }>> => ({ status: "accepted" }));
		harness.port.subscribe = (callback) => {
			callback(envelope());
			callback({ ...envelope("bad"), extra: true });
			return {
				ok: true,
				value: {
					unsubscribe() {
						harness.calls.unsubscribe += 1;
						return { ok: true, code: "UNSUBSCRIBED" };
					},
				},
			};
		};
		const adapter = await makeAdapter(harness);
		expect(adapter.incoming.subscribe(listener)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
		expect(listener).not.toHaveBeenCalled();
		expect(harness.calls.unsubscribe).toBe(1);
		expect(await adapter.transport.close()).toEqual({ status: "error" });
	});

	test("bounds the synchronous raw buffer", async () => {
		const harness = makeHarness();
		const listener = vi.fn(async (): Promise<Readonly<{ status: "accepted" }>> => ({ status: "accepted" }));
		harness.port.subscribe = (callback) => {
			for (let index = 0; index < 17; index += 1) callback(envelope(`frame-${index}`));
			return {
				ok: true,
				value: {
					unsubscribe() {
						harness.calls.unsubscribe += 1;
						return { ok: true, code: "UNSUBSCRIBED" };
					},
				},
			};
		};
		const adapter = await makeAdapter(harness);
		expect(adapter.incoming.subscribe(listener)).toEqual({ ok: false, error: { code: "SUBSCRIBE_UNCERTAIN" } });
		expect(listener).not.toHaveBeenCalled();
		expect(harness.calls.unsubscribe).toBe(1);
	});

	test.each(["throw", "proxyResult", "extraResult", "proxyToken", "extraToken", "accessorToken"])(
		"backs out or preserves uncertainty for hostile subscribe %s",
		async (mode) => {
			const harness = makeHarness();
			let unsubscribeCalls = 0;
			const unsubscribe = () => {
				unsubscribeCalls += 1;
				return { ok: true, code: "UNSUBSCRIBED" };
			};
			harness.port.subscribe = () => {
				if (mode === "throw") throw new Error("secret");
				if (mode === "proxyResult") return new Proxy({ ok: true, value: { unsubscribe } }, {});
				if (mode === "extraResult") return { ok: true, value: { unsubscribe }, extra: true };
				if (mode === "proxyToken") return { ok: true, value: new Proxy({ unsubscribe }, {}) };
				if (mode === "extraToken") return { ok: true, value: { unsubscribe, extra: true } };
				const token: Record<string, unknown> = {};
				Object.defineProperty(token, "unsubscribe", {
					enumerable: true,
					get() {
						throw new Error("secret");
					},
				});
				return { ok: true, value: token };
			};
			const adapter = await makeAdapter(harness);
			expect(adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }))).toEqual({
				ok: false,
				error: {
					code: mode === "extraResult" || mode === "extraToken" ? "INVALID_ARGUMENT" : "SUBSCRIBE_UNCERTAIN",
				},
			});
			expect(unsubscribeCalls).toBe(mode === "extraResult" || mode === "extraToken" ? 1 : 0);
		},
	);

	test("later malformed envelope immediately unsubscribes and poisons", async () => {
		const adapter = await makeAdapter();
		const listener = vi.fn(async (): Promise<Readonly<{ status: "accepted" }>> => ({ status: "accepted" }));
		const result = adapter.incoming.subscribe(listener);
		if (!result.ok) throw new Error(result.error.code);
		adapter.emit({ ...envelope(), extra: true });
		expect(adapter.calls.unsubscribe).toBe(1);
		expect(listener).not.toHaveBeenCalled();
		expect(adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }))).toEqual({
			ok: false,
			error: { code: "POISONED" },
		});
		expect(await result.value.unsubscribe()).toEqual({ ok: true });
		expect(await adapter.transport.send({ envelope: envelope("later") })).toEqual({ status: "error" });
	});

	test("delivers later callbacks in FIFO order", async () => {
		const adapter = await makeAdapter();
		const first = deferred<Readonly<{ status: "accepted" }>>();
		const order: string[] = [];
		const result = adapter.incoming.subscribe((value) => {
			order.push(value.frameId);
			return value.frameId === "frame-1" ? first.promise : Promise.resolve({ status: "accepted" });
		});
		if (!result.ok) throw new Error(result.error.code);
		adapter.emit(envelope("frame-1"));
		adapter.emit(envelope("frame-2"));
		await Promise.resolve();
		expect(order).toEqual(["frame-1"]);
		first.resolve({ status: "accepted" });
		expect(await result.value.unsubscribe()).toEqual({ ok: true });
		expect(order).toEqual(["frame-1", "frame-2"]);
	});

	test.each(["throw", "nonpromise", "reject", "subclass", "own", "symbol", "proxy", "error", "malformed"])(
		"poisons and unsubscribes on hostile listener %s",
		async (mode) => {
			const adapter = await makeAdapter();
			const accepted = { status: "accepted" };
			const native = Promise.resolve(accepted);
			let listener: () => unknown;
			if (mode === "throw")
				listener = () => {
					throw new Error("secret");
				};
			else if (mode === "nonpromise") listener = () => accepted;
			else if (mode === "reject") listener = () => Promise.reject(new Error("secret"));
			else if (mode === "subclass")
				listener = () => new (class extends Promise<unknown> {})((resolve) => resolve(accepted));
			else if (mode === "own") listener = () => promiseWithOwnProperty(accepted);
			else if (mode === "symbol") listener = () => promiseWithOwnSymbol(accepted);
			else if (mode === "proxy") listener = () => new Proxy(native, {});
			else if (mode === "error") listener = () => Promise.resolve({ status: "error" });
			else listener = () => Promise.resolve({ status: "accepted", extra: true });
			const subscribed = subscribeRaw(adapter.incoming, listener);
			if (!subscribed.ok) throw new Error(subscribed.error.code);
			adapter.emit(envelope());
			const cleanup = await subscribed.value.unsubscribe();
			expect(cleanup.ok).toBe(true);
			expect(adapter.calls.unsubscribe).toBe(1);
			expect(await adapter.transport.send({ envelope: envelope("later") })).toEqual({ status: "error" });
			expect(await adapter.transport.close()).toEqual({ status: "error" });
		},
	);

	test("public unsubscribe drains callbacks and shares one Promise", async () => {
		const adapter = await makeAdapter();
		const pending = deferred<Readonly<{ status: "accepted" }>>();
		const subscribed = adapter.incoming.subscribe(() => pending.promise);
		if (!subscribed.ok) throw new Error(subscribed.error.code);
		adapter.emit(envelope());
		await Promise.resolve();
		const first = subscribed.value.unsubscribe();
		const second = subscribed.value.unsubscribe();
		expect(first).toBe(second);
		expect(adapter.calls.unsubscribe).toBe(0);
		pending.resolve({ status: "accepted" });
		expect(await first).toEqual({ ok: true });
		expect(adapter.calls.unsubscribe).toBe(1);
	});

	test("unsubscribe uncertainty is stable and poisons", async () => {
		const harness = makeHarness();
		harness.port.subscribe = () => ({
			ok: true,
			value: {
				unsubscribe() {
					harness.calls.unsubscribe += 1;
					return { ok: false, code: "TRANSPORT" };
				},
			},
		});
		const adapter = await makeAdapter(harness);
		const subscribed = adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }));
		if (!subscribed.ok) throw new Error(subscribed.error.code);
		const first = subscribed.value.unsubscribe();
		expect(await first).toEqual({ ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } });
		expect(subscribed.value.unsubscribe()).toBe(first);
		expect(adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }))).toEqual({
			ok: false,
			error: { code: "POISONED" },
		});
		expect(await adapter.transport.close()).toEqual({ status: "error" });
		expect(adapter.calls.unsubscribe).toBe(1);
	});

	test("allows another subscription only after exact cleanup", async () => {
		const adapter = await makeAdapter();
		const first = adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }));
		if (!first.ok) throw new Error(first.error.code);
		expect(adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }))).toEqual({
			ok: false,
			error: { code: "SUBSCRIPTION_ACTIVE" },
		});
		expect(await first.value.unsubscribe()).toEqual({ ok: true });
		const second = adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }));
		if (!second.ok) throw new Error(second.error.code);
		expect(await second.value.unsubscribe()).toEqual({ ok: true });
		expect(adapter.calls.subscribe).toBe(2);
	});
});

describe("close ownership", () => {
	test("is one shared Promise and closes once", async () => {
		const adapter = await makeAdapter();
		const first = adapter.transport.close();
		const second = adapter.transport.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ status: "closed" });
		expect(adapter.calls.close).toBe(1);
		expect(adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }))).toEqual({
			ok: false,
			error: { code: "CLOSED" },
		});
	});

	test("shares actual unsubscribe cleanup with close in either race order", async () => {
		for (const unsubscribeFirst of [true, false]) {
			const adapter = await makeAdapter();
			const subscribed = adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }));
			if (!subscribed.ok) throw new Error(subscribed.error.code);
			const unsubscribe = unsubscribeFirst ? subscribed.value.unsubscribe() : undefined;
			const close = adapter.transport.close();
			const laterUnsubscribe = unsubscribe ?? subscribed.value.unsubscribe();
			expect(await laterUnsubscribe).toEqual({ ok: true });
			expect(await close).toEqual({ status: "closed" });
			expect(adapter.calls.unsubscribe).toBe(1);
			expect(adapter.calls.close).toBe(1);
		}
	});

	test("closes the port after unsubscribe and despite poison", async () => {
		const harness = makeHarness();
		const order: string[] = [];
		harness.port.subscribe = () => ({
			ok: true,
			value: {
				unsubscribe() {
					harness.calls.unsubscribe += 1;
					order.push("unsubscribe");
					return { ok: true, code: "UNSUBSCRIBED" };
				},
			},
		});
		harness.port.close = () => {
			harness.calls.close += 1;
			order.push("close");
			return Promise.resolve({ ok: true, code: "CLOSED" });
		};
		const adapter = await makeAdapter(harness);
		const subscribed = adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }));
		if (!subscribed.ok) throw new Error(subscribed.error.code);
		expect(await adapter.transport.send({ envelope: { bad: true } })).toEqual({ status: "error" });
		expect(await adapter.transport.close()).toEqual({ status: "error" });
		expect(order).toEqual(["unsubscribe", "close"]);
	});

	test.each(["throw", "nonpromise", "reject", "subclass", "own", "symbol", "proxy", "malformed"])(
		"returns close error for hostile port close %s",
		async (mode) => {
			const harness = makeHarness();
			const closed = { ok: true, code: "CLOSED" };
			const native = Promise.resolve(closed);
			if (mode === "throw")
				harness.port.close = () => {
					harness.calls.close += 1;
					throw new Error("secret");
				};
			else if (mode === "nonpromise")
				harness.port.close = () => {
					harness.calls.close += 1;
					return closed;
				};
			else if (mode === "reject")
				harness.port.close = () => {
					harness.calls.close += 1;
					return Promise.reject(new Error("secret"));
				};
			else if (mode === "subclass")
				harness.port.close = () => {
					harness.calls.close += 1;
					return new (class extends Promise<unknown> {})((resolve) => resolve(closed));
				};
			else if (mode === "own")
				harness.port.close = () => {
					harness.calls.close += 1;
					return promiseWithOwnProperty(closed);
				};
			else if (mode === "symbol")
				harness.port.close = () => {
					harness.calls.close += 1;
					return promiseWithOwnSymbol(closed);
				};
			else if (mode === "proxy")
				harness.port.close = () => {
					harness.calls.close += 1;
					return new Proxy(native, {});
				};
			else
				harness.port.close = () => {
					harness.calls.close += 1;
					return Promise.resolve({ ...closed, extra: true });
				};
			const adapter = await makeAdapter(harness);
			expect(await adapter.transport.close()).toEqual({ status: "error" });
			expect(harness.calls.close).toBe(1);
		},
	);

	test("does not fabricate unsubscribe success after close cleanup fails", async () => {
		const harness = makeHarness();
		harness.port.subscribe = () => ({
			ok: true,
			value: {
				unsubscribe() {
					harness.calls.unsubscribe += 1;
					throw new Error("secret");
				},
			},
		});
		const adapter = await makeAdapter(harness);
		const subscribed = adapter.incoming.subscribe(() => Promise.resolve({ status: "accepted" }));
		if (!subscribed.ok) throw new Error(subscribed.error.code);
		const close = adapter.transport.close();
		const unsubscribe = subscribed.value.unsubscribe();
		expect(await close).toEqual({ status: "error" });
		expect(await unsubscribe).toEqual({ ok: false, error: { code: "UNSUBSCRIBE_UNCERTAIN" } });
		expect(harness.calls.unsubscribe).toBe(1);
		expect(harness.calls.close).toBe(1);
	});
});
