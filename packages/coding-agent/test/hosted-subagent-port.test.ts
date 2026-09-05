import { describe, expect, expectTypeOf, test } from "vitest";
import {
	createHostedSubagentPort,
	extractHostedProviderUsage,
	type HostedProviderUsage,
	type HostedSubagentIdentity,
} from "../src/modes/daemon/hosted-subagent-port.js";
import type { RemoteHostFrameEnvelope } from "../src/modes/daemon/remote-agent-host-protocol.js";
import type { RemoteObservationSnapshotV1 } from "../src/modes/daemon/remote-observation-snapshot.js";

const IDENTITY: HostedSubagentIdentity = { hostId: "host-1", generation: "gen-1", sessionId: "sess-1" };

function envelope(frame: RemoteHostFrameEnvelope["frame"] = { type: "health", healthSeq: 1, status: "connected" }) {
	return {
		type: "frame",
		frameId: "frame-1",
		protocol: { name: "prime-agent.remote-host", version: 1 },
		sentAt: "2025-01-01T00:00:00.000Z",
		frame,
	};
}

function snapshot(overrides: Partial<RemoteObservationSnapshotV1> = {}): RemoteObservationSnapshotV1 {
	return {
		version: "1",
		hostId: "host-1",
		generation: "gen-1",
		sessionId: "sess-1",
		capturedAt: "2025-01-01T00:00:00.000Z",
		cursor: 0,
		cursorTimestamp: "",
		hasGap: false,
		needsReplay: false,
		nextMessageIndex: 0,
		records: [],
		messageCount: 0,
		agentRunning: false,
		sessionState: null,
		compacting: false,
		checkpointing: false,
		bash: null,
		recap: [],
		lastFailure: { type: "none" },
		...overrides,
	};
}

function makeCapability() {
	let callback: ((raw: unknown) => void) | null = null;
	const calls = { send: 0, subscribe: 0, unsubscribe: 0, observe: 0, close: 0 };
	const capability = {
		async send(_value: RemoteHostFrameEnvelope): Promise<unknown> {
			calls.send += 1;
			return { status: "accepted" };
		},
		subscribe(value: (raw: unknown) => void): unknown {
			calls.subscribe += 1;
			callback = value;
			return {
				status: "subscribed",
				unsubscribe() {
					calls.unsubscribe += 1;
					return { status: "unsubscribed" };
				},
			};
		},
		async observe(): Promise<unknown> {
			calls.observe += 1;
			return snapshot();
		},
		async close(): Promise<unknown> {
			calls.close += 1;
			return { status: "closed" };
		},
	};
	return {
		capability,
		calls,
		emit(raw: unknown) {
			callback?.(raw);
		},
	};
}

function portFrom(box = makeCapability()) {
	const result = createHostedSubagentPort({ identity: IDENTITY, capability: box.capability });
	if (!result.ok) throw new Error(`unexpected ${result.code}`);
	return { ...box, port: result.value };
}

describe("hosted-subagent port accepted-type boundary", () => {
	test("aliases accepted frame, snapshot, identity, and provider usage types", () => {
		expectTypeOf<HostedSubagentIdentity>().toMatchTypeOf<
			Pick<{ hostId: string; generation: string; sessionId: string }, "hostId" | "generation" | "sessionId">
		>();
		expectTypeOf<HostedProviderUsage>().toMatchTypeOf<{ inputTokens: number; outputTokens: number }>();
		expectTypeOf<RemoteObservationSnapshotV1>().toBeObject();
	});

	test.each([undefined, null, 1, "x", {}, [], () => {}])("rejects invalid factory input %#", (raw) => {
		expect(createHostedSubagentPort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test.each(["identity", "capability"])("rejects missing %s", (key) => {
		const box = makeCapability();
		const raw: Record<string, unknown> = { identity: IDENTITY, capability: box.capability };
		delete raw[key];
		expect(createHostedSubagentPort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects outer Proxy without traps", () => {
		let reads = 0;
		const raw = new Proxy(
			{ identity: IDENTITY, capability: makeCapability().capability },
			{
				get() {
					reads += 1;
					throw new Error("raw");
				},
			},
		);
		expect(createHostedSubagentPort(raw)).toEqual({ ok: false, code: "INVALID_INPUT" });
		expect(reads).toBe(0);
	});

	test("rejects identity getters without invoking them", () => {
		let reads = 0;
		const identity = { generation: "gen-1", sessionId: "sess-1" } as Record<string, unknown>;
		Object.defineProperty(identity, "hostId", {
			enumerable: true,
			get() {
				reads += 1;
				return "host-1";
			},
		});
		expect(createHostedSubagentPort({ identity, capability: makeCapability().capability })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		expect(reads).toBe(0);
	});

	test.each(["", "bad id", "x".repeat(129)])("rejects invalid identity %s", (hostId) => {
		expect(
			createHostedSubagentPort({ identity: { ...IDENTITY, hostId }, capability: makeCapability().capability }),
		).toEqual({ ok: false, code: "INVALID_INPUT" });
	});

	test("rejects capability getter and Proxy without invoking either", () => {
		let reads = 0;
		const capability = { ...makeCapability().capability } as Record<string, unknown>;
		Object.defineProperty(capability, "send", {
			enumerable: true,
			get() {
				reads += 1;
				return () => {};
			},
		});
		expect(createHostedSubagentPort({ identity: IDENTITY, capability })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		expect(reads).toBe(0);
		const proxy = new Proxy(makeCapability().capability, {
			get() {
				reads += 1;
				throw new Error("raw");
			},
		});
		expect(createHostedSubagentPort({ identity: IDENTITY, capability: proxy })).toEqual({
			ok: false,
			code: "INVALID_INPUT",
		});
		expect(reads).toBe(0);
	});

	test("returns a frozen port and frozen identity copy", () => {
		const { port } = portFrom();
		expect(Object.isFrozen(port)).toBe(true);
		expect(Object.isFrozen(port.identity)).toBe(true);
		expect(port.identity).not.toBe(IDENTITY);
	});
});

describe("send and provider usage", () => {
	test("decodes and sends an accepted envelope", async () => {
		const box = portFrom();
		expect(await box.port.send(envelope())).toEqual({ ok: true, value: "ACCEPTED" });
		expect(box.calls.send).toBe(1);
	});

	test.each([null, {}, { ...envelope(), extra: true }])("rejects malformed envelope %#", async (raw) => {
		const box = portFrom();
		expect(await box.port.send(raw)).toEqual({ ok: false, code: "INVALID_FRAME" });
		expect(box.calls.send).toBe(0);
	});

	test("validates exact capability send result", async () => {
		const box = makeCapability();
		box.capability.send = async () => ({ status: "accepted", extra: true });
		const { port } = portFrom(box);
		expect(await port.send(envelope())).toEqual({ ok: false, code: "TRANSPORT" });
	});

	test("maps send throw to fixed transport failure", async () => {
		const box = makeCapability();
		box.capability.send = async () => {
			throw new Error("credential raw");
		};
		const { port } = portFrom(box);
		expect(await port.send(envelope())).toEqual({ ok: false, code: "TRANSPORT" });
	});

	test("uses snapshotted methods after capability mutation", async () => {
		const box = portFrom();
		box.capability.send = async () => ({ status: "bad" });
		expect(await box.port.send(envelope())).toEqual({ ok: true, value: "ACCEPTED" });
	});

	test("extracts only accepted complete-frame usage", () => {
		const complete = envelope({
			type: "provider_proxy",
			proxyType: "model_call_complete",
			callId: "call-1",
			result: { text: "ok" },
			usage: { inputTokens: 4, outputTokens: 5 },
		});
		const usage = extractHostedProviderUsage(complete);
		expect(usage).toEqual({ inputTokens: 4, outputTokens: 5 });
		expect(Object.isFrozen(usage)).toBe(true);
		expect(extractHostedProviderUsage(envelope())).toBeNull();
		expect(extractHostedProviderUsage({ ...complete, extra: true })).toBeNull();
	});

	test("does not invent zero usage when usage is absent", () => {
		const complete = envelope({
			type: "provider_proxy",
			proxyType: "model_call_complete",
			callId: "call-1",
			result: null,
		});
		expect(extractHostedProviderUsage(complete)).toBeNull();
	});
});

describe("subscription ownership", () => {
	test("decodes incoming envelopes and freezes the delivered result", () => {
		const box = portFrom();
		const received: unknown[] = [];
		const result = box.port.subscribe((value: unknown) => received.push(value));
		expect(result.ok).toBe(true);
		box.emit(envelope());
		expect(received).toHaveLength(1);
		expect(received[0]).toMatchObject({ ok: true });
		expect(Object.isFrozen(received[0])).toBe(true);
	});

	test("delivers fixed failure for a malformed incoming envelope", () => {
		const box = portFrom();
		const received: unknown[] = [];
		box.port.subscribe((value: unknown) => received.push(value));
		box.emit({ secret: "must-not-escape" });
		expect(received).toEqual([{ ok: false, code: "INVALID_FRAME" }]);
	});

	test("swallows application listener throws", () => {
		const box = portFrom();
		box.port.subscribe(() => {
			throw new Error("application");
		});
		expect(() => box.emit(envelope())).not.toThrow();
	});

	test("buffers synchronous registration callbacks until exact ownership returns", () => {
		const box = makeCapability();
		const received: unknown[] = [];
		box.capability.subscribe = (callback) => {
			callback(envelope());
			expect(received).toHaveLength(0);
			return { status: "subscribed", unsubscribe: () => ({ status: "unsubscribed" }) };
		};
		const { port } = portFrom(box);
		expect(port.subscribe((value: unknown) => received.push(value)).ok).toBe(true);
		expect(received).toHaveLength(1);
	});

	test("drops synchronous and late callbacks when registration reports error", () => {
		const box = makeCapability();
		let callback: ((raw: unknown) => void) | null = null;
		box.capability.subscribe = (value) => {
			callback = value;
			value(envelope());
			return { status: "error" };
		};
		const { port } = portFrom(box);
		const received: unknown[] = [];
		expect(port.subscribe((value: unknown) => received.push(value))).toEqual({ ok: false, code: "TRANSPORT" });
		Reflect.apply(callback as unknown as CallableFunction, undefined, [envelope()]);
		expect(received).toHaveLength(0);
	});

	test("consumes safely discoverable cleanup from a malformed success result", () => {
		const box = makeCapability();
		box.capability.subscribe = () => ({
			status: "subscribed",
			unsubscribe: () => {
				box.calls.unsubscribe += 1;
				return { status: "unsubscribed" };
			},
			extra: true,
		});
		const { port } = portFrom(box);
		expect(port.subscribe(() => {})).toEqual({ ok: false, code: "TRANSPORT" });
		expect(box.calls.unsubscribe).toBe(1);
		expect(port.subscribe(() => {}).ok).toBe(false);
	});

	test("retains malformed-result cleanup uncertainty through close", async () => {
		const box = makeCapability();
		box.capability.subscribe = () => ({
			status: "subscribed",
			unsubscribe: () => ({ status: "error" }),
			extra: true,
		});
		const { port } = portFrom(box);
		expect(port.subscribe(() => {})).toEqual({ ok: false, code: "TRANSPORT" });
		expect(await port.close()).toEqual({ ok: false, code: "TRANSPORT" });
	});

	test("rejects registration overflow and consumes returned ownership once", () => {
		const box = makeCapability();
		box.capability.subscribe = (callback) => {
			for (let index = 0; index < 17; index += 1) callback(envelope());
			return {
				status: "subscribed",
				unsubscribe: () => {
					box.calls.unsubscribe += 1;
					return { status: "unsubscribed" };
				},
			};
		};
		const { port } = portFrom(box);
		expect(port.subscribe(() => {})).toEqual({ ok: false, code: "TRANSPORT" });
		expect(box.calls.unsubscribe).toBe(1);
	});

	test("unsubscribe consumes ownership once and allows a new subscription", () => {
		const box = portFrom();
		const first = box.port.subscribe(() => {});
		if (!first.ok) throw new Error("unexpected");
		expect(first.value.unsubscribe()).toEqual({ ok: true, code: "UNSUBSCRIBED" });
		expect(first.value.unsubscribe()).toEqual({ ok: true, code: "UNSUBSCRIBED" });
		expect(box.calls.unsubscribe).toBe(1);
		expect(box.port.subscribe(() => {}).ok).toBe(true);
	});

	test("unsubscribe uncertainty blocks replacement and poisons close", async () => {
		const box = makeCapability();
		box.capability.subscribe = () => ({ status: "subscribed", unsubscribe: () => ({ status: "error" }) });
		const { port } = portFrom(box);
		const sub = port.subscribe(() => {});
		if (!sub.ok) throw new Error("unexpected");
		expect(sub.value.unsubscribe()).toEqual({ ok: false, code: "TRANSPORT" });
		expect(port.subscribe(() => {})).toEqual({ ok: false, code: "SUBSCRIPTION_ACTIVE" });
		expect(await port.close()).toEqual({ ok: false, code: "TRANSPORT" });
	});

	test("rejects nonfunction and Proxy listeners", () => {
		const { port } = portFrom();
		expect(port.subscribe(null)).toEqual({ ok: false, code: "INVALID_INPUT" });
		const listener = new Proxy(() => {}, {
			apply() {
				throw new Error("raw");
			},
		});
		expect(port.subscribe(listener)).toEqual({ ok: false, code: "INVALID_INPUT" });
	});
});

describe("observation and close", () => {
	test("decodes an exact identity-bound snapshot", async () => {
		const { port } = portFrom();
		const result = await port.observe();
		expect(result.ok).toBe(true);
		if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
	});

	test("rejects snapshot identity mismatch and malformed snapshots", async () => {
		const box = makeCapability();
		box.capability.observe = async () => snapshot({ hostId: "wrong" });
		let wrapped = portFrom(box);
		expect(await wrapped.port.observe()).toEqual({ ok: false, code: "INVALID_SNAPSHOT" });
		const box2 = makeCapability();
		box2.capability.observe = async () => ({ secret: "raw" });
		wrapped = portFrom(box2);
		expect(await wrapped.port.observe()).toEqual({ ok: false, code: "INVALID_SNAPSHOT" });
	});

	test("maps observation throw to fixed transport failure", async () => {
		const box = makeCapability();
		box.capability.observe = async () => {
			throw new Error("raw");
		};
		const { port } = portFrom(box);
		expect(await port.observe()).toEqual({ ok: false, code: "TRANSPORT" });
	});

	test("close unsubscribes, consumes close once, and returns the same promise", async () => {
		const box = portFrom();
		box.port.subscribe(() => {});
		const one = box.port.close();
		const two = box.port.close();
		expect(one).toBe(two);
		expect(await one).toEqual({ ok: true, code: "CLOSED" });
		expect(box.calls.unsubscribe).toBe(1);
		expect(box.calls.close).toBe(1);
		expect(await box.port.send(envelope())).toEqual({ ok: false, code: "CLOSED" });
		expect(await box.port.observe()).toEqual({ ok: false, code: "CLOSED" });
		expect(box.port.subscribe(() => {})).toEqual({ ok: false, code: "CLOSED" });
	});

	test("close throw and malformed result fail closed without retry", async () => {
		const box = makeCapability();
		box.capability.close = async () => {
			box.calls.close += 1;
			throw new Error("raw");
		};
		let wrapped = portFrom(box);
		expect(await wrapped.port.close()).toEqual({ ok: false, code: "TRANSPORT" });
		expect(await wrapped.port.close()).toEqual({ ok: false, code: "TRANSPORT" });
		expect(box.calls.close).toBe(1);
		const box2 = makeCapability();
		box2.capability.close = async () => ({ status: "closed", extra: true });
		wrapped = portFrom(box2);
		expect(await wrapped.port.close()).toEqual({ ok: false, code: "TRANSPORT" });
	});
});
