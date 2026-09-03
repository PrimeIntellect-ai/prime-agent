import { describe, expect, it } from "vitest";
import {
	createRemoteRelayDispatcher,
	type RemoteRelayDispatcher,
	type RemoteRelayEnsureResult,
} from "../src/modes/daemon/b10-remote-relay-dispatcher.js";
import type { DurableReceipt } from "../src/modes/daemon/durable-relay-store.js";
import type { RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import { canonicalDigest } from "../src/modes/daemon/remote-host-frame-codec.js";

function envelope(frameId = "frame-1", messageId = "agentmsg-1"): RemoteHostFrameEnvelope {
	return Object.freeze({
		type: "frame" as const,
		frameId,
		protocol: Object.freeze({ name: "prime-agent.remote-host" as const, version: 1 as const }),
		sentAt: "2025-01-01T00:00:00.000Z",
		frame: Object.freeze({
			type: "agent_message" as const,
			id: messageId,
			fromActiveSessionId: "parent-1",
			targetActiveSessionId: "child-1",
			message: "hello",
		}),
	});
}

function input(value = envelope()): Readonly<{ envelope: RemoteHostFrameEnvelope; semanticDigest: string }> {
	const digest = canonicalDigest(value.frame);
	if (!digest.ok) throw new Error("test digest failed");
	return Object.freeze({ envelope: value, semanticDigest: digest.value });
}

function journalReceipt(seq = 1): Readonly<{ sequence: number; size: number; sha256: string }> {
	return Object.freeze({ sequence: seq, size: 100, sha256: "a".repeat(64) });
}

function successfulRelay(onSend?: (raw: unknown) => unknown) {
	return Object.freeze({
		send(raw: unknown): unknown {
			if (onSend) return onSend(raw);
			const source = inputEnvelope(raw);
			return Promise.resolve(
				Object.freeze({
					ok: true as const,
					value: Object.freeze({
						frameId: source?.frameId ?? "invalid",
						replay: false,
						journalReceipt: journalReceipt(),
					}),
				}),
			);
		},
	});
}

function inputEnvelope(raw: unknown): RemoteHostFrameEnvelope | null {
	if (typeof raw !== "object" || raw === null) return null;
	const descriptor = Object.getOwnPropertyDescriptor(raw, "frameId");
	return descriptor && "value" in descriptor && typeof descriptor.value === "string"
		? envelope(descriptor.value)
		: null;
}

async function dispatcher(
	getOutboundRelay: () => unknown,
	onClose: () => unknown = async () => Object.freeze({ status: "closed" as const }),
): Promise<RemoteRelayDispatcher> {
	const created = await createRemoteRelayDispatcher({ close: onClose, getOutboundRelay });
	if (!created.ok) throw new Error("dispatcher factory failed");
	return created.dispatcher;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolveValue: (value: T) => void = () => {
		throw new Error("deferred not initialized");
	};
	const promise = new Promise<T>((resolve) => {
		resolveValue = resolve;
	});
	return { promise, resolve: resolveValue };
}

describe("B10 remote relay dispatcher", () => {
	it("sends through an available non-owning relay and returns persisted", async () => {
		let receiver: unknown;
		const relay = successfulRelay();
		const owner = {
			close: async () => Object.freeze({ status: "closed" as const }),
			getOutboundRelay() {
				receiver = this;
				return Object.freeze({ status: "available" as const, relay });
			},
		};
		const created = await createRemoteRelayDispatcher(owner);
		if (!created.ok) throw new Error("factory failed");
		const result = await created.dispatcher.ensure(input());
		expect(result).toEqual({ status: "persisted" });
		expect(receiver).toBe(owner);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("returns deferred when the relay is unavailable", async () => {
		const subject = await dispatcher(() => Object.freeze({ status: "unavailable" as const }));
		expect(await subject.ensure(input())).toEqual({ status: "deferred" });
	});

	it.each(["CLOSED", "PERSISTENCE_FAILED", "POISONED", "TRANSPORT_UNCERTAIN"])(
		"maps transient relay error %s to deferred",
		async (code) => {
			const relay = successfulRelay(() =>
				Promise.resolve(Object.freeze({ ok: false as const, error: Object.freeze({ code }) })),
			);
			const subject = await dispatcher(() => ({ status: "available", relay }));
			expect(await subject.ensure(input())).toEqual({ status: "deferred" });
		},
	);

	it("rejects send result with missing or malformed journalReceipt", async () => {
		const missing = await dispatcher(() => ({
			status: "available",
			relay: successfulRelay(() => Promise.resolve({ ok: true, value: { frameId: "frame-1", replay: false } })),
		}));
		expect(await missing.ensure(input())).toEqual({ status: "error" });

		const badSha = await dispatcher(() => ({
			status: "available",
			relay: successfulRelay(() =>
				Promise.resolve({
					ok: true,
					value: {
						frameId: "frame-1",
						replay: false,
						journalReceipt: { sequence: 1, size: 100, sha256: "not-a-valid-sha" },
					},
				}),
			),
		}));
		expect(await badSha.ensure(input())).toEqual({ status: "error" });
	});

	it("poisons on malformed or fatal relay outcomes", async () => {
		let calls = 0;
		const relay = successfulRelay(() => {
			calls += 1;
			return Promise.resolve({
				ok: true,
				value: { frameId: "wrong", replay: false, journalReceipt: journalReceipt() },
			});
		});
		const subject = await dispatcher(() => ({ status: "available", relay }));
		expect(await subject.ensure(input())).toEqual({ status: "error" });
		expect(await subject.ensure(input())).toEqual({ status: "error" });
		expect(calls).toBe(1);
	});

	it("rejects invalid semantic input before relay lookup", async () => {
		let calls = 0;
		const subject = await dispatcher(() => {
			calls += 1;
			return { status: "available", relay: successfulRelay() };
		});
		expect(await subject.ensure({ ...input(), semanticDigest: "0".repeat(64) })).toEqual({ status: "error" });
		expect(await subject.ensure({ ...input(), extra: true })).toEqual({ status: "error" });
		expect(calls).toBe(0);
	});

	it("rejects hostile nested envelopes without invoking accessors or proxy traps", async () => {
		let getterCalls = 0;
		const hostileFrame = Object.create(null);
		Object.defineProperty(hostileFrame, "type", {
			enumerable: true,
			get: () => {
				getterCalls += 1;
				return "agent_message";
			},
		});
		const raw = { ...input(), envelope: { ...envelope(), frame: hostileFrame } };
		const subject = await dispatcher(() => ({ status: "available", relay: successfulRelay() }));
		expect(await subject.ensure(raw)).toEqual({ status: "error" });
		expect(getterCalls).toBe(0);
		const proxied = new Proxy(envelope().frame, {
			getPrototypeOf: () => {
				throw new Error("trap");
			},
		});
		expect(await subject.ensure({ ...input(), envelope: { ...envelope(), frame: proxied } })).toEqual({
			status: "error",
		});
	});

	it("requires exact native Promise send results", async () => {
		const thenableRelay = successfulRelay(() => {
			// biome-ignore lint/suspicious/noThenProperty: explicitly exercise hostile thenable rejection
			return { then: () => undefined };
		});
		const first = await dispatcher(() => ({ status: "available", relay: thenableRelay }));
		expect(await first.ensure(input())).toEqual({ status: "deferred" });

		class PromiseSubclass<T> extends Promise<T> {}
		const subclassRelay = successfulRelay(() =>
			PromiseSubclass.resolve({
				ok: true,
				value: { frameId: "frame-1", replay: false, journalReceipt: journalReceipt() },
			}),
		);
		const second = await dispatcher(() => ({ status: "available", relay: subclassRelay }));
		expect(await second.ensure(input())).toEqual({ status: "deferred" });

		const owned = Promise.resolve({
			ok: true,
			value: { frameId: "frame-1", replay: false, journalReceipt: journalReceipt() },
		});
		Object.defineProperty(owned, "extra", { value: true });
		const third = await dispatcher(() => ({ status: "available", relay: successfulRelay(() => owned) }));
		expect(await third.ensure(input())).toEqual({ status: "deferred" });
	});

	it("serializes admitted sends FIFO", async () => {
		const gate =
			deferred<
				Readonly<{ ok: true; value: Readonly<{ frameId: string; replay: false; journalReceipt: DurableReceipt }> }>
			>();
		const calls: string[] = [];
		const relay = successfulRelay((raw) => {
			const source = inputEnvelope(raw);
			const frameId = source?.frameId ?? "invalid";
			calls.push(frameId);
			if (frameId === "first") return gate.promise;
			return Promise.resolve({
				ok: true as const,
				value: { frameId, replay: false as const, journalReceipt: journalReceipt() },
			});
		});
		const subject = await dispatcher(() => ({ status: "available", relay }));
		const first = subject.ensure(input(envelope("first", "message-first")));
		const second = subject.ensure(input(envelope("second", "message-second")));
		await Promise.resolve();
		expect(calls).toEqual(["first"]);
		gate.resolve(
			Object.freeze({
				ok: true as const,
				value: Object.freeze({ frameId: "first", replay: false, journalReceipt: journalReceipt(1) }),
			}),
		);
		expect(await first).toEqual({ status: "persisted" });
		expect(await second).toEqual({ status: "persisted" });
		expect(calls).toEqual(["first", "second"]);
	});

	it("drains admitted work before one shared logical close", async () => {
		const gate =
			deferred<
				Readonly<{ ok: true; value: Readonly<{ frameId: string; replay: false; journalReceipt: DurableReceipt }> }>
			>();
		const subject = await dispatcher(() => ({
			status: "available",
			relay: successfulRelay(() => gate.promise),
		}));
		const admitted = subject.ensure(input());
		const firstClose = subject.close();
		const secondClose = subject.close();
		expect(firstClose).toBe(secondClose);
		expect(await subject.ensure(input())).toEqual({ status: "error" });
		let closeSettled = false;
		firstClose.then(() => {
			closeSettled = true;
		});
		await Promise.resolve();
		expect(closeSettled).toBe(false);
		gate.resolve(
			Object.freeze({
				ok: true as const,
				value: Object.freeze({ frameId: "frame-1", replay: false, journalReceipt: journalReceipt(1) }),
			}),
		);
		expect(await admitted).toEqual({ status: "persisted" });
		expect(await firstClose).toEqual({ status: "closed" });
	});

	it("rejects synchronous getter reentry without deadlock", async () => {
		let subject: RemoteRelayDispatcher | null = null;
		let nested: Promise<RemoteRelayEnsureResult> | null = null;
		subject = await dispatcher(() => {
			nested = subject?.ensure(input()) ?? null;
			return { status: "unavailable" };
		});
		expect(await subject.ensure(input())).toEqual({ status: "deferred" });
		if (!nested) throw new Error("missing nested ensure");
		expect(await nested).toEqual({ status: "error" });
	});

	it("rejects synchronous send reentry without deadlock", async () => {
		let subject: RemoteRelayDispatcher | null = null;
		let nested: Promise<RemoteRelayEnsureResult> | null = null;
		const relay = successfulRelay(() => {
			nested = subject?.ensure(input()) ?? null;
			return Promise.resolve({
				ok: true,
				value: { frameId: "frame-1", replay: false, journalReceipt: journalReceipt() },
			});
		});
		subject = await dispatcher(() => ({ status: "available", relay }));
		expect(await subject.ensure(input())).toEqual({ status: "persisted" });
		if (!nested) throw new Error("missing nested ensure");
		expect(await nested).toEqual({ status: "error" });
	});

	it("returns fresh frozen result records", async () => {
		const subject = await dispatcher(() => ({ status: "unavailable" }));
		const first = await subject.ensure(input());
		const second = await subject.ensure(input());
		expect(first).not.toBe(second);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(second)).toBe(true);
	});

	it("propagates one checked context close after admitted work", async () => {
		let closes = 0;
		const subject = await dispatcher(
			() => ({ status: "unavailable" }),
			async () => {
				closes += 1;
				return Object.freeze({ status: "closed" as const });
			},
		);
		const first = subject.close();
		const second = subject.close();
		expect(first).toBe(second);
		expect(await first).toEqual({ status: "closed" });
		expect(closes).toBe(1);
	});

	it("contains context-close throw and malformed Promise outcomes", async () => {
		const throwing = await dispatcher(
			() => ({ status: "unavailable" }),
			() => {
				throw new Error("raw close");
			},
		);
		expect(await throwing.close()).toEqual({ status: "error" });

		const thenable = await dispatcher(
			() => ({ status: "unavailable" }),
			() => {
				// biome-ignore lint/suspicious/noThenProperty: explicitly exercise hostile thenable rejection
				return { then: () => undefined };
			},
		);
		expect(await thenable.close()).toEqual({ status: "error" });
	});

	it("preliminary-closes malformed factory input and lets uncertainty dominate", async () => {
		let closes = 0;
		const invalid = await createRemoteRelayDispatcher({
			close: async () => {
				closes += 1;
				return { status: "closed" as const };
			},
			getOutboundRelay: () => ({ status: "unavailable" }),
			extra: true,
		});
		expect(invalid).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(closes).toBe(1);

		const uncertain = await createRemoteRelayDispatcher({
			close: async () => ({ status: "error" as const }),
			getOutboundRelay: () => ({ status: "unavailable" }),
			extra: true,
		});
		expect(uncertain).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("rejects synchronous context-close reentry", async () => {
		let subject: RemoteRelayDispatcher | null = null;
		let nested: Promise<RemoteRelayEnsureResult> | null = null;
		subject = await dispatcher(
			() => ({ status: "unavailable" }),
			async () => {
				nested = subject?.ensure(input()) ?? null;
				return { status: "closed" as const };
			},
		);
		expect(await subject.close()).toEqual({ status: "closed" });
		if (!nested) throw new Error("missing nested ensure");
		expect(await nested).toEqual({ status: "error" });
	});

	it("rejects hostile factory and lookup capabilities", async () => {
		expect(await createRemoteRelayDispatcher(null)).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(
			await createRemoteRelayDispatcher({
				close: async () => ({ status: "closed" as const }),
				getOutboundRelay: () => null,
				extra: true,
			}),
		).toEqual({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
		const functionProxy = new Proxy(() => null, {});
		expect(
			await createRemoteRelayDispatcher({
				close: async () => ({ status: "closed" as const }),
				getOutboundRelay: functionProxy,
			}),
		).toEqual({
			ok: false,
			error: { code: "INVALID_ARGUMENT" },
		});
		const subject = await dispatcher(() => ({ status: "available", relay: new Proxy(successfulRelay(), {}) }));
		expect(await subject.ensure(input())).toEqual({ status: "error" });
	});
});
