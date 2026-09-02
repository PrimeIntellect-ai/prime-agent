import { describe, expect, it } from "vitest";
import {
	createDurableAgentMessageApplication,
	type DurableAgentMessageApplicationCapability,
} from "../src/modes/daemon/durable-agent-message-application.js";
import {
	REMOTE_HOST_PROTOCOL_NAME,
	REMOTE_HOST_PROTOCOL_VERSION,
	type RemoteHostFrameEnvelope,
} from "../src/modes/daemon/remote-agent-host-protocol.js";

function messageEnvelope(frameId = "transport-frame-1", messageId = "semantic-message-1"): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId,
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: {
			type: "agent_message",
			id: messageId,
			fromActiveSessionId: "source-session",
			targetActiveSessionId: "target-session",
			message: "hello",
			deliveryMode: "direct",
		},
	};
}

function healthEnvelope(): RemoteHostFrameEnvelope {
	return {
		type: "frame",
		frameId: "health-frame",
		protocol: { name: REMOTE_HOST_PROTOCOL_NAME, version: REMOTE_HOST_PROTOCOL_VERSION },
		sentAt: "2025-01-15T10:30:00.000Z",
		frame: { type: "health", healthSeq: 1, status: "connected" },
	};
}

interface RouterHarness {
	readonly router: Readonly<Record<string, unknown>>;
	readonly authorized: Array<Readonly<Record<string, unknown>>>;
	readonly delivered: Array<Readonly<Record<string, unknown>>>;
	readonly closeCount: () => number;
}

function routerHarness(
	overrides?: Readonly<{
		authorize?: (raw: unknown) => Promise<unknown>;
		deliver?: (raw: unknown) => Promise<unknown>;
		close?: () => Promise<unknown>;
	}>,
): RouterHarness {
	const authorized: Array<Readonly<Record<string, unknown>>> = [];
	const delivered: Array<Readonly<Record<string, unknown>>> = [];
	let closes = 0;
	const router = {
		authorize(raw: unknown): Promise<unknown> {
			authorized.push(raw as Readonly<Record<string, unknown>>);
			return overrides?.authorize?.(raw) ?? Promise.resolve({ status: "allowed" });
		},
		deliverIdempotently(raw: unknown): Promise<unknown> {
			const input = raw as Readonly<Record<string, unknown>>;
			delivered.push(input);
			return (
				overrides?.deliver?.(raw) ??
				Promise.resolve({
					status: "delivered",
					messageId: input.messageId,
					targetActiveSessionId: input.targetActiveSessionId,
				})
			);
		},
		close(): Promise<unknown> {
			closes += 1;
			return overrides?.close?.() ?? Promise.resolve({ status: "closed" });
		},
	};
	return { router, authorized, delivered, closeCount: () => closes };
}

async function opened(
	harness = routerHarness(),
): Promise<Readonly<{ application: DurableAgentMessageApplicationCapability; harness: RouterHarness }>> {
	const created = await createDurableAgentMessageApplication({ router: harness.router });
	expect(created.ok).toBe(true);
	if (!created.ok) throw new Error("application failed to open");
	return { application: created.application, harness };
}

describe("durable agent-message application", () => {
	it("authorizes before idempotent delivery with independent transport and semantic IDs", async () => {
		const order: string[] = [];
		const harness = routerHarness({
			authorize: async () => {
				order.push("authorize");
				return { status: "allowed" };
			},
			deliver: async () => {
				order.push("deliver");
				return {
					status: "delivered",
					messageId: "semantic-message-1",
					targetActiveSessionId: "target-session",
				};
			},
		});
		const { application } = await opened(harness);
		expect(await application.apply({ envelope: messageEnvelope() })).toEqual({ status: "applied" });
		expect(order).toEqual(["authorize", "deliver"]);
		expect(harness.authorized[0]).toEqual({
			messageId: "semantic-message-1",
			transportFrameId: "transport-frame-1",
			fromActiveSessionId: "source-session",
			targetActiveSessionId: "target-session",
		});
		expect(harness.delivered[0]).toEqual({
			messageId: "semantic-message-1",
			idempotencyKey: "semantic-message-1",
			transportFrameId: "transport-frame-1",
			fromActiveSessionId: "source-session",
			targetActiveSessionId: "target-session",
			message: "hello",
			deliveryMode: "direct",
		});
		await application.close();
	});

	it("preserves the semantic idempotency key on a pending-handler replay", async () => {
		const { application, harness } = await opened();
		await application.apply({ envelope: messageEnvelope() });
		await application.apply({ envelope: messageEnvelope() });
		expect(harness.delivered).toHaveLength(2);
		expect(harness.delivered[0].idempotencyKey).toBe("semantic-message-1");
		expect(harness.delivered[1].idempotencyKey).toBe("semantic-message-1");
		await application.close();
	});

	it("accepts an exact queued receipt", async () => {
		const harness = routerHarness({
			deliver: async () => ({
				status: "queued",
				messageId: "semantic-message-1",
				targetActiveSessionId: "target-session",
			}),
		});
		const { application } = await opened(harness);
		expect(await application.apply({ envelope: messageEnvelope() })).toEqual({ status: "applied" });
		await application.close();
	});

	it("fails closed on authorization denial before delivery", async () => {
		const harness = routerHarness({ authorize: async () => ({ status: "denied" }) });
		const { application } = await opened(harness);
		expect(await application.apply({ envelope: messageEnvelope() })).toEqual({ status: "error" });
		expect(harness.delivered).toHaveLength(0);
		expect(await application.apply({ envelope: messageEnvelope("frame-2", "message-2") })).toEqual({
			status: "error",
		});
		await application.close();
	});

	it("rejects non-message and malformed envelopes without calling the router", async () => {
		const { application, harness } = await opened();
		expect(await application.apply({ envelope: healthEnvelope() })).toEqual({ status: "error" });
		expect(await application.apply({ envelope: { type: "frame" } })).toEqual({ status: "error" });
		expect(harness.authorized).toHaveLength(0);
		expect(harness.delivered).toHaveLength(0);
		await application.close();
	});

	it("serializes authorization and delivery operations", async () => {
		const gate: { release: (() => void) | null } = { release: null };
		let calls = 0;
		const first = new Promise<void>((resolve) => {
			gate.release = resolve;
		});
		const harness = routerHarness({
			authorize: async () => {
				calls += 1;
				if (calls === 1) await first;
				return { status: "allowed" };
			},
		});
		const { application } = await opened(harness);
		const one = application.apply({ envelope: messageEnvelope("frame-1", "message-1") });
		await Promise.resolve();
		const two = application.apply({ envelope: messageEnvelope("frame-2", "message-2") });
		await Promise.resolve();
		expect(calls).toBeLessThanOrEqual(1);
		gate.release?.();
		expect(await one).toEqual({ status: "applied" });
		expect(await two).toEqual({ status: "applied" });
		await application.close();
	});

	it("poisons on a non-native router promise", async () => {
		const harness = routerHarness({
			authorize: () => Promise.resolve({ status: "allowed" }),
			deliver: () => Object.create(Promise.prototype) as Promise<unknown>,
		});
		const { application } = await opened(harness);
		expect(await application.apply({ envelope: messageEnvelope() })).toEqual({ status: "error" });
		expect(await application.apply({ envelope: messageEnvelope("frame-2", "message-2") })).toEqual({
			status: "error",
		});
		await application.close();
	});

	it("latches close, drains accepted work, and closes the router once", async () => {
		const { application, harness } = await opened();
		const accepted = application.apply({ envelope: messageEnvelope() });
		const first = application.close();
		expect(application.close()).toBe(first);
		expect(await application.apply({ envelope: messageEnvelope("late", "late-message") })).toEqual({
			status: "error",
		});
		expect(await accepted).toEqual({ status: "applied" });
		expect(await first).toEqual({ status: "closed" });
		expect(harness.closeCount()).toBe(1);
	});

	it("closes a discovered router on unrelated factory rejection", async () => {
		const harness = routerHarness();
		const result = await createDurableAgentMessageApplication({ router: harness.router, extra: true });
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(harness.closeCount()).toBe(1);
	});

	it("lets close uncertainty dominate factory rejection", async () => {
		const harness = routerHarness({ close: () => Promise.reject(new Error("uncertain")) });
		const result = await createDurableAgentMessageApplication({ router: harness.router, extra: true });
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(harness.closeCount()).toBe(1);
	});

	it("does not invoke hostile application accessors", async () => {
		const { application } = await opened();
		let invoked = false;
		const hostile = Object.defineProperty({}, "envelope", {
			enumerable: true,
			get() {
				invoked = true;
				return messageEnvelope();
			},
		});
		expect(await application.apply(hostile)).toEqual({ status: "error" });
		expect(invoked).toBe(false);
		await application.close();
	});
});
