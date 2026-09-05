import { describe, expect, it } from "vitest";
import { createBidirectionalTargetInboxEntry } from "../src/modes/daemon/b10-bidirectional-target-inbox-entry.js";
import { createTargetInboxRegistry } from "../src/modes/daemon/target-inbox-registry.js";

function ok(): Promise<Readonly<{ ok: true; value: undefined }>> {
	return Promise.resolve(Object.freeze({ ok: true as const, value: undefined }));
}

function failed(): Promise<Readonly<{ ok: false; error: Readonly<{ code: string }> }>> {
	return Promise.resolve(Object.freeze({ ok: false as const, error: Object.freeze({ code: "DOWNSTREAM" }) }));
}

function closable(
	label: string,
	calls: string[],
	options: Readonly<{ closeFails?: boolean; receive?: (raw: unknown) => unknown }> = Object.freeze({}),
) {
	return Object.freeze({
		close() {
			calls.push(`close:${label}`);
			return options.closeFails ? failed() : ok();
		},
		receive(raw: unknown) {
			calls.push(`receive:${label}:${String(raw)}`);
			return options.receive ? options.receive(raw) : ok();
		},
	});
}

function outbound(
	calls: string[],
	options: Readonly<{
		closeFails?: boolean;
		dispatch?: () => unknown;
		send?: (raw: unknown) => unknown;
	}> = Object.freeze({}),
) {
	return Object.freeze({
		authorizeAdmit(raw: unknown) {
			calls.push(`send:${String(raw)}`);
			return options.send ? options.send(raw) : ok();
		},
		close() {
			calls.push("close:outbound");
			return options.closeFails ? failed() : ok();
		},
		dispatchPending() {
			calls.push("dispatch:outbound");
			return options.dispatch ? options.dispatch() : ok();
		},
	});
}

function retry(calls: string[], operation: () => unknown = ok) {
	return Object.freeze({
		dispatchPending() {
			calls.push("dispatch:inbound");
			return operation();
		},
	});
}

function input(
	relay: unknown,
	outboundInbox: unknown,
	inboundRetry: unknown,
): Readonly<{ relay: unknown; outboundInbox: unknown; inboundRetry: unknown }> {
	return Object.freeze({ inboundRetry, outboundInbox, relay });
}

function deferred<T>() {
	let complete: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		complete = resolve;
	});
	return Object.freeze({
		promise,
		resolve(value: T) {
			if (complete) complete(value);
		},
	});
}

describe("bidirectional target inbox entry", () => {
	it("routes both directions and retries inbound before outbound", async () => {
		const calls: string[] = [];
		const created = await createBidirectionalTargetInboxEntry(
			input(closable("relay", calls), outbound(calls), retry(calls)),
		);
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(await created.value.receive("remote")).toEqual({ ok: true, value: undefined });
		expect(await created.value.send("home")).toEqual({ ok: true, value: undefined });
		expect(await created.value.dispatchPending()).toEqual({ ok: true, value: undefined });
		expect(calls).toEqual(["receive:relay:remote", "send:home", "dispatch:inbound", "dispatch:outbound"]);
	});

	it("accepts exact non-void successes from receive and authorize-admit", async () => {
		const calls: string[] = [];
		const relay = closable("relay", calls, {
			receive: () => Promise.resolve(Object.freeze({ ok: true as const, value: Object.freeze({ ack: "a" }) })),
		});
		const outboundInbox = outbound(calls, {
			send: () => Promise.resolve(Object.freeze({ ok: true as const, value: Object.freeze({ receipt: "r" }) })),
		});
		const created = await createBidirectionalTargetInboxEntry(input(relay, outboundInbox, retry(calls)));
		if (!created.ok) return;
		expect(await created.value.receive("remote")).toEqual({ ok: true, value: undefined });
		expect(await created.value.send("home")).toEqual({ ok: true, value: undefined });
	});

	it("serializes receive and send globally", async () => {
		const calls: string[] = [];
		const gate = deferred<Readonly<{ ok: true; value: undefined }>>();
		const relay = closable("relay", calls, { receive: () => gate.promise });
		const created = await createBidirectionalTargetInboxEntry(input(relay, outbound(calls), retry(calls)));
		if (!created.ok) return;
		const first = created.value.receive("one");
		const second = created.value.send("two");
		await Promise.resolve();
		expect(calls).toEqual(["receive:relay:one"]);
		gate.resolve(Object.freeze({ ok: true as const, value: undefined }));
		expect(await first).toEqual({ ok: true, value: undefined });
		expect(await second).toEqual({ ok: true, value: undefined });
		expect(calls).toEqual(["receive:relay:one", "send:two"]);
	});

	it("close drains admitted work then closes outbound and relay once", async () => {
		const calls: string[] = [];
		const gate = deferred<Readonly<{ ok: true; value: undefined }>>();
		const created = await createBidirectionalTargetInboxEntry(
			input(closable("relay", calls, { receive: () => gate.promise }), outbound(calls), retry(calls)),
		);
		if (!created.ok) return;
		const operation = created.value.receive("one");
		const closeOne = created.value.close();
		const closeTwo = created.value.close();
		expect(closeOne).toBe(closeTwo);
		expect(await created.value.send("late")).toEqual({ ok: false, error: { code: "CLOSED" } });
		gate.resolve(Object.freeze({ ok: true as const, value: undefined }));
		await operation;
		expect(await closeOne).toEqual({ status: "closed" });
		expect(calls).toEqual(["receive:relay:one", "close:outbound", "close:relay"]);
	});

	it("maps a checked downstream failure without exposing its code", async () => {
		const calls: string[] = [];
		const created = await createBidirectionalTargetInboxEntry(
			input(closable("relay", calls), outbound(calls, { send: failed }), retry(calls)),
		);
		if (!created.ok) return;
		expect(await created.value.send("x")).toEqual({ ok: false, error: { code: "UNCERTAIN" } });
		expect(await created.value.receive("y")).toEqual({ ok: true, value: undefined });
	});

	it("poisons on malformed and non-native operation promises", async () => {
		// biome-ignore lint/suspicious/noThenProperty: this intentionally exercises a hostile thenable.
		const hostileThenable = Object.freeze(Object.defineProperty({}, "then", { enumerable: true, value() {} }));
		for (const receive of [
			() => Promise.resolve(Object.freeze({ extra: true, ok: true, value: 1 })),
			() => hostileThenable,
		]) {
			const calls: string[] = [];
			const created = await createBidirectionalTargetInboxEntry(
				input(closable("relay", calls, { receive }), outbound(calls), retry(calls)),
			);
			if (!created.ok) continue;
			expect(await created.value.receive("x")).toEqual({ ok: false, error: { code: "UNCERTAIN" } });
			expect(await created.value.send("y")).toEqual({ ok: false, error: { code: "UNCERTAIN" } });
		}
	});

	it("rejects synchronous injected reentry", async () => {
		const calls: string[] = [];
		let reentered: Promise<unknown> | undefined;
		let entry: { receive: (raw: unknown) => Promise<unknown> } | undefined;
		const relay = closable("relay", calls, {
			receive: () => {
				reentered = entry?.receive("nested");
				return ok();
			},
		});
		const created = await createBidirectionalTargetInboxEntry(input(relay, outbound(calls), retry(calls)));
		if (!created.ok) return;
		entry = created.value;
		expect(await created.value.receive("outer")).toEqual({ ok: true, value: undefined });
		expect(await reentered).toEqual({ ok: false, error: { code: "REENTRY" } });
	});

	it("rejects hostile shapes and closes acquired owners in reverse", async () => {
		for (const scenario of [
			{
				expected: ["close:outbound", "close:relay"],
				mutate: (raw: Record<string, unknown>) => Reflect.set(raw, "extra", true),
			},
			{
				expected: ["close:outbound"],
				mutate: (raw: Record<string, unknown>) => Object.defineProperty(raw, "relay", { get: () => undefined }),
			},
			{
				expected: ["close:outbound", "close:relay"],
				mutate: (raw: Record<string, unknown>) => Reflect.setPrototypeOf(raw, null),
			},
		]) {
			const calls: string[] = [];
			const raw: Record<string, unknown> = {
				inboundRetry: retry(calls),
				outboundInbox: outbound(calls),
				relay: closable("relay", calls),
			};
			scenario.mutate(raw);
			const result = await createBidirectionalTargetInboxEntry(raw);
			expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
			expect(calls).toEqual(scenario.expected);
		}
	});

	it("rejects a proxied function and cleans both owners", async () => {
		const calls: string[] = [];
		const relay = {
			close() {
				calls.push("close:relay");
				return ok();
			},
			receive: new Proxy(function receive() {
				return ok();
			}, {}),
		};
		const result = await createBidirectionalTargetInboxEntry(input(relay, outbound(calls), retry(calls)));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(calls).toEqual(["close:outbound", "close:relay"]);
	});

	it("closes one aliased owner exactly once", async () => {
		const calls: string[] = [];
		const aliased = {
			authorizeAdmit() {
				return ok();
			},
			close() {
				calls.push("close:alias");
				return ok();
			},
			dispatchPending() {
				return ok();
			},
			receive() {
				return ok();
			},
		};
		const result = await createBidirectionalTargetInboxEntry(input(aliased, aliased, retry(calls)));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(calls).toEqual(["close:alias"]);
	});

	it("lets cleanup uncertainty dominate invalid input", async () => {
		const calls: string[] = [];
		const result = await createBidirectionalTargetInboxEntry(
			Object.freeze({
				extra: true,
				inboundRetry: retry(calls),
				outboundInbox: outbound(calls, { closeFails: true }),
				relay: closable("relay", calls),
			}),
		);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(calls).toEqual(["close:outbound", "close:relay"]);
	});

	it("reports close uncertainty but still closes every owner", async () => {
		const calls: string[] = [];
		const created = await createBidirectionalTargetInboxEntry(
			input(closable("relay", calls, { closeFails: true }), outbound(calls, { closeFails: true }), retry(calls)),
		);
		if (!created.ok) return;
		expect(await created.value.close()).toEqual({ status: "error" });
		expect(calls).toEqual(["close:outbound", "close:relay"]);
	});

	it("rejects close reentry without deadlocking", async () => {
		const calls: string[] = [];
		let nested: Promise<unknown> | undefined;
		let entry: { close: () => Promise<unknown> } | undefined;
		const relay = Object.freeze({
			close() {
				calls.push("close:relay");
				nested = entry?.close();
				return ok();
			},
			receive() {
				return ok();
			},
		});
		const created = await createBidirectionalTargetInboxEntry(input(relay, outbound(calls), retry(calls)));
		if (!created.ok) return;
		entry = created.value;
		expect(await created.value.close()).toEqual({ status: "closed" });
		expect(await nested).toEqual({ status: "error" });
	});

	it("is accepted directly as a permanent registry factory result", async () => {
		const calls: string[] = [];
		const relay = closable("relay", calls, {
			receive: () => Promise.resolve(Object.freeze({ ok: true as const, value: Object.freeze({ ack: "a" }) })),
		});
		const outgoing = outbound(calls, {
			send: () => Promise.resolve(Object.freeze({ ok: true as const, value: Object.freeze({ receipt: "r" }) })),
		});
		const catalog = Object.freeze({
			close() {
				calls.push("close:catalog");
				return Promise.resolve(Object.freeze({ status: "closed" as const }));
			},
			isCurrent() {
				return Promise.resolve(Object.freeze({ status: "current" as const }));
			},
		});
		const factory = Object.freeze({
			close() {
				calls.push("close:factory");
				return Promise.resolve(Object.freeze({ status: "closed" as const }));
			},
			create() {
				return createBidirectionalTargetInboxEntry(input(relay, outgoing, retry(calls)));
			},
		});
		const registryResult = await createTargetInboxRegistry(Object.freeze({ catalog, factory }));
		expect(registryResult.ok).toBe(true);
		if (!registryResult.ok) return;
		const identity = Object.freeze({ generation: "g-1", hostId: "h-1", sessionId: "s-1" });
		const found = await registryResult.value.get(identity);
		expect(found.ok).toBe(true);
		if (!found.ok) return;
		expect(await found.value.receive("remote")).toEqual({ ok: true, value: undefined });
		expect(await found.value.send("home")).toEqual({ ok: true, value: undefined });
		expect(await registryResult.value.close()).toEqual({ ok: true, value: undefined });
		expect(calls.slice(-4)).toEqual(["close:outbound", "close:relay", "close:factory", "close:catalog"]);
	});

	it("returns fresh frozen public results", async () => {
		const calls: string[] = [];
		const first = await createBidirectionalTargetInboxEntry(Object.freeze({}));
		const second = await createBidirectionalTargetInboxEntry(Object.freeze({}));
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		const created = await createBidirectionalTargetInboxEntry(
			input(closable("relay", calls), outbound(calls), retry(calls)),
		);
		if (!created.ok) return;
		const one = await created.value.send("one");
		const two = await created.value.send("two");
		expect(one).not.toBe(two);
		expect(Object.isFrozen(one)).toBe(true);
	});
});
