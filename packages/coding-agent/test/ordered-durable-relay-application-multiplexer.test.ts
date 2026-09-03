import { describe, expect, it } from "vitest";
import { createRelayApplicationMultiplexer } from "../src/modes/daemon/ordered-durable-relay-application-multiplexer.js";

// ===========================================================================
// Helpers
// ===========================================================================

function makeCapability(
	overrides?: Readonly<{
		apply?: (raw: unknown) => Promise<unknown>;
		close?: () => Promise<unknown>;
	}>,
): Record<string, unknown> {
	return Object.freeze({
		apply:
			overrides?.apply ??
			(async () =>
				Object.freeze({
					status: "applied",
				})),
		close: overrides?.close ?? (async () => Object.freeze({ status: "closed" })),
	});
}

function envelope(frameType = "command"): Record<string, unknown> {
	const base: Record<string, unknown> = {
		type: "frame",
		frameId: "f-1",
		protocol: { name: "prime-agent.remote-host", version: 1 },
		sentAt: "2025-01-01T00:00:00.000Z",
		frame: { type: frameType },
	};
	if (frameType === "command") {
		(base.frame as Record<string, unknown>).commandId = "cmd-1";
		(base.frame as Record<string, unknown>).body = { type: "create_session", workspaceId: "w-1" };
	} else if (frameType === "event") {
		(base.frame as Record<string, unknown>).id = "evt-1";
		(base.frame as Record<string, unknown>).sequence = 1;
		(base.frame as Record<string, unknown>).cursor = {
			hostId: "h-1",
			generation: "g-1",
			sessionId: "s-1",
			sequence: 1,
		};
		(base.frame as Record<string, unknown>).emittedAt = "2025-01-01T00:00:01.000Z";
		(base.frame as Record<string, unknown>).body = { type: "agent_start" };
	} else if (frameType === "agent_message") {
		(base.frame as Record<string, unknown>).id = "msg-1";
		(base.frame as Record<string, unknown>).fromActiveSessionId = "parent-1";
		(base.frame as Record<string, unknown>).targetActiveSessionId = "child-1";
		(base.frame as Record<string, unknown>).message = "hello";
	} else if (frameType === "provider_proxy") {
		(base.frame as Record<string, unknown>).proxyType = "model_call_request";
		(base.frame as Record<string, unknown>).callId = "call-1";
		(base.frame as Record<string, unknown>).provider = "anthropic";
		(base.frame as Record<string, unknown>).model = "claude-3";
		(base.frame as Record<string, unknown>).messages = [];
	} else if (frameType === "ack") {
		(base.frame as Record<string, unknown>).ackId = "ack-1";
		(base.frame as Record<string, unknown>).acknowledges = "f-0";
		(base.frame as Record<string, unknown>).status = "delivered";
	} else if (frameType === "handshake") {
		(base.frame as Record<string, unknown>).direction = "home_to_host";
		(base.frame as Record<string, unknown>).hostId = "h-1";
		(base.frame as Record<string, unknown>).generation = "g-1";
		(base.frame as Record<string, unknown>).runtime = {
			buildId: "b-1",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 1,
		};
		(base.frame as Record<string, unknown>).capabilities = [];
	} else if (frameType === "handshake_ack") {
		(base.frame as Record<string, unknown>).hostId = "h-1";
		(base.frame as Record<string, unknown>).sessionId = "s-1";
		(base.frame as Record<string, unknown>).protocol = { name: "prime-agent.remote-host", version: 1 };
		(base.frame as Record<string, unknown>).accepted = true;
		(base.frame as Record<string, unknown>).capabilities = [];
		(base.frame as Record<string, unknown>).linkId = "l-1";
		(base.frame as Record<string, unknown>).remoteBuildIdentity = {
			buildId: "b-2",
			daemonProtocolVersion: 1,
			daemonSchemaRevision: 1,
		};
	} else if (frameType === "health") {
		(base.frame as Record<string, unknown>).healthSeq = 1;
		(base.frame as Record<string, unknown>).status = "connected";
	} else if (frameType === "error") {
		(base.frame as Record<string, unknown>).code = "ERR";
		(base.frame as Record<string, unknown>).message = "test error";
	}
	return Object.freeze(base);
}

function makeFactoryInput(
	overrides?: Readonly<{
		command?: Record<string, unknown>;
		event?: Record<string, unknown>;
		agentMessage?: Record<string, unknown>;
		providerProxy?: Record<string, unknown>;
	}>,
): Record<string, unknown> {
	return Object.freeze({
		command: overrides?.command ?? makeCapability(),
		event: overrides?.event ?? makeCapability(),
		agentMessage: overrides?.agentMessage ?? makeCapability(),
		providerProxy: overrides?.providerProxy ?? makeCapability(),
	});
}

// ===========================================================================
// Factory: success
// ===========================================================================

describe("createRelayApplicationMultiplexer factory", () => {
	it("creates with valid capabilities", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(typeof result.application.apply).toBe("function");
		expect(typeof result.application.close).toBe("function");
		const closed = await result.application.close();
		expect(closed).toEqual({ status: "closed" });
	});

	it("rejects missing factory keys", async () => {
		const result = await createRelayApplicationMultiplexer(Object.freeze({}));
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects extra factory keys", async () => {
		const input = makeFactoryInput();
		const polluted = Object.freeze({ ...input, extra: true });
		const result = await createRelayApplicationMultiplexer(polluted);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects non-Object.prototype capability objects", async () => {
		const inner = Object.assign(Object.create(null), {
			apply: async () => ({ status: "applied" }),
			close: async () => ({ status: "closed" }),
		});
		const input = makeFactoryInput({ command: inner });
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(false);
	});

	it("reports CLOSE_UNCERTAIN for a Proxy outer input", async () => {
		const outer = new Proxy(makeFactoryInput(), {});
		const result = await createRelayApplicationMultiplexer(outer);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("reports CLOSE_UNCERTAIN for a Proxy capability", async () => {
		const proxy = new Proxy(makeCapability(), {});
		const input = makeFactoryInput({ command: proxy });
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(false);
	});

	it("rejects missing apply on capability", async () => {
		const input = makeFactoryInput({
			command: Object.freeze({ close: async () => ({ status: "closed" }) }),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects missing close on capability", async () => {
		const input = makeFactoryInput({
			command: Object.freeze({ apply: async () => ({ status: "applied" }) }),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects shared close function alias (same close function ref)", async () => {
		const sharedClose = async () => ({ status: "closed" });
		const cap = Object.freeze({
			apply: async () => ({ status: "applied" }),
			close: sharedClose,
		});
		const input = makeFactoryInput({ command: cap, event: cap });
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects shared close across all four slots", async () => {
		const sharedClose = async () => ({ status: "closed" });
		const cap = Object.freeze({
			apply: async () => ({ status: "applied" }),
			close: sharedClose,
		});
		const input = makeFactoryInput({
			command: cap,
			event: cap,
			agentMessage: cap,
			providerProxy: cap,
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("rejects same raw object in two slots", async () => {
		const cap = makeCapability();
		const input = makeFactoryInput({ command: cap, event: cap });
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
	});

	it("closes discovered owners on factory rejection in reverse acquisition order", async () => {
		const order: string[] = [];
		const makeTracked = (name: string) =>
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					order.push(name);
					return { status: "closed" };
				},
			});
		const input = makeFactoryInput({
			command: makeTracked("cmd"),
			event: makeTracked("evt"),
			agentMessage: makeTracked("amsg"),
			providerProxy: Object.freeze({
				// missing apply triggers factory failure
				close: async () => {
					order.push("pprox");
					return { status: "closed" };
				},
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		// captureOwnedClose captures pprox's close (even without apply).
		// Acquisition order: cmd, evt, amsg, pprox
		// Reverse: pprox, amsg, evt, cmd
		expect(order).toEqual(["pprox", "amsg", "evt", "cmd"]);
	});

	it("does not invoke outer accessors", async () => {
		let invoked = false;
		const outer: Record<string, unknown> = {};
		Object.defineProperty(outer, "command", {
			enumerable: true,
			get: (): unknown => {
				invoked = true;
				return makeCapability();
			},
		});
		Object.defineProperty(outer, "event", {
			enumerable: true,
			value: makeCapability(),
		});
		Object.defineProperty(outer, "agentMessage", {
			enumerable: true,
			value: makeCapability(),
		});
		Object.defineProperty(outer, "providerProxy", {
			enumerable: true,
			value: makeCapability(),
		});
		const result = await createRelayApplicationMultiplexer(outer);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(invoked).toBe(false);
	});

	it("closes all owners exactly once on factory failure", async () => {
		let commandCalls = 0;
		let eventCalls = 0;
		let agentMessageCalls = 0;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					commandCalls += 1;
					return { status: "closed" };
				},
			}),
			event: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					eventCalls += 1;
					return { status: "closed" };
				},
			}),
			agentMessage: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					agentMessageCalls += 1;
					return { status: "closed" };
				},
			}),
			// providerProxy missing -> factory fails (4th slot not present)
		});
		// Remove providerProxy to cause validation failure
		const partial = Object.freeze({
			command: input.command,
			event: input.event,
			agentMessage: input.agentMessage,
		});
		const result = await createRelayApplicationMultiplexer(partial);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(commandCalls).toBe(1);
		expect(eventCalls).toBe(1);
		expect(agentMessageCalls).toBe(1);
	});
});

// ===========================================================================
// Apply: happy paths
// ===========================================================================

describe("apply happy path", () => {
	it("applies command frame", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const res = await result.application.apply({ envelope: envelope("command") });
		expect(res).toEqual({ status: "applied" });
		await result.application.close();
	});

	it("applies event frame", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const res = await result.application.apply({ envelope: envelope("event") });
		expect(res).toEqual({ status: "applied" });
		await result.application.close();
	});

	it("applies agent_message frame", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const res = await result.application.apply({ envelope: envelope("agent_message") });
		expect(res).toEqual({ status: "applied" });
		await result.application.close();
	});

	it("applies provider_proxy frame", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const res = await result.application.apply({ envelope: envelope("provider_proxy") });
		expect(res).toEqual({ status: "applied" });
		await result.application.close();
	});

	it("routes each frame type to the matching application exactly once", async () => {
		let commandCalls = 0;
		let eventCalls = 0;
		let agentMessageCalls = 0;
		let providerProxyCalls = 0;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => {
					commandCalls += 1;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			event: Object.freeze({
				apply: async () => {
					eventCalls += 1;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			agentMessage: Object.freeze({
				apply: async () => {
					agentMessageCalls += 1;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			providerProxy: Object.freeze({
				apply: async () => {
					providerProxyCalls += 1;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.apply({ envelope: envelope("command") });
		expect(commandCalls).toBe(1);
		expect(eventCalls).toBe(0);
		await app.apply({ envelope: envelope("event") });
		expect(eventCalls).toBe(1);
		await app.apply({ envelope: envelope("agent_message") });
		expect(agentMessageCalls).toBe(1);
		await app.apply({ envelope: envelope("provider_proxy") });
		expect(providerProxyCalls).toBe(1);
		await app.close();
	});

	it("sends a fresh decoded envelope to target", async () => {
		let received: unknown;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async (raw: unknown) => {
					received = raw;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const original = envelope("command");
		await result.application.apply({ envelope: original });
		expect(received).toBeDefined();
		const r = received as Record<string, unknown>;
		expect(typeof r.envelope).toBe("object");
		const env = r.envelope as Record<string, unknown>;
		expect(env.frameId).toBe("f-1");
		expect(env.frame).toEqual(original.frame);
		expect(r.envelope).not.toBe(original);
		await result.application.close();
	});
});

// ===========================================================================
// ACK/health/error/handshake/handshake_ack rejection (no poison)
// ===========================================================================

describe("control frame rejection (no poison)", () => {
	for (const type of ["ack", "health", "error", "handshake", "handshake_ack"]) {
		it(`rejects ${type} frame without routing`, async () => {
			let commandCalled = false;
			const input = makeFactoryInput({
				command: Object.freeze({
					apply: async () => {
						commandCalled = true;
						return { status: "applied" };
					},
					close: async () => ({ status: "closed" }),
				}),
			});
			const result = await createRelayApplicationMultiplexer(input);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			const app = result.application;
			const res = await app.apply({ envelope: envelope(type) });
			expect(res).toEqual({ status: "error" });
			expect(commandCalled).toBe(false);
			await app.close();
		});
	}

	it("does NOT poison the multiplexer on ACK rejection", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		// Send a properly formed ACK frame
		await app.apply({ envelope: envelope("ack") });
		// Subsequent command should still work
		const res = await app.apply({ envelope: envelope("command") });
		expect(res).toEqual({ status: "applied" });
		await app.close();
	});
});

// ===========================================================================
// Hostile inputs
// ===========================================================================

describe("hostile inputs", () => {
	it("rejects non-{envelope} apply input", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		expect(await app.apply({})).toEqual({ status: "error" });
		expect(await app.apply(null)).toEqual({ status: "error" });
		expect(await app.apply(undefined)).toEqual({ status: "error" });
		expect(await app.apply("bad")).toEqual({ status: "error" });
		expect(await app.apply(42)).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons on malformed envelope", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({
			envelope: { type: "frame", frameId: "", protocol: { name: "bad", version: 1 } },
		});
		expect(res).toEqual({ status: "error" });
		// Poisoned - subsequent calls fail
		expect(await app.apply({ envelope: envelope("command") })).toEqual({ status: "error" });
		await app.close();
	});

	it("rejects apply with extra keys on {envelope}", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({ envelope: envelope("command"), extra: true });
		expect(res).toEqual({ status: "error" });
		await app.close();
	});

	it("rejects apply with no envelope key", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({ notEnvelope: "x" });
		expect(res).toEqual({ status: "error" });
		await app.close();
	});
});

// ===========================================================================
// Routing correctness
// ===========================================================================

describe("routing correctness", () => {
	it("routes command frame to command app only", async () => {
		let called: string | null = null;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => {
					called = "command";
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.apply({ envelope: envelope("command") });
		expect(called).toBe("command");
		await app.close();
	});

	it("routes event frame to event app only", async () => {
		let called: string | null = null;
		const input = makeFactoryInput({
			event: Object.freeze({
				apply: async () => {
					called = "event";
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.apply({ envelope: envelope("event") });
		expect(called).toBe("event");
		await app.close();
	});

	it("routes agent_message to agentMessage app only", async () => {
		let called: string | null = null;
		const input = makeFactoryInput({
			agentMessage: Object.freeze({
				apply: async () => {
					called = "agentMessage";
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.apply({ envelope: envelope("agent_message") });
		expect(called).toBe("agentMessage");
		await app.close();
	});

	it("routes provider_proxy to providerProxy app only", async () => {
		let called: string | null = null;
		const input = makeFactoryInput({
			providerProxy: Object.freeze({
				apply: async () => {
					called = "providerProxy";
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.apply({ envelope: envelope("provider_proxy") });
		expect(called).toBe("providerProxy");
		await app.close();
	});
});

// ===========================================================================
// FIFO ordering
// ===========================================================================

describe("global FIFO ordering", () => {
	it("processes applies in FIFO order", async () => {
		const order: number[] = [];
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => {
					order.push(1);
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			event: Object.freeze({
				apply: async () => {
					order.push(2);
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			agentMessage: Object.freeze({
				apply: async () => {
					order.push(3);
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			providerProxy: Object.freeze({
				apply: async () => {
					order.push(4);
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const p1 = app.apply({ envelope: envelope("command") });
		const p2 = app.apply({ envelope: envelope("event") });
		const p3 = app.apply({ envelope: envelope("agent_message") });
		const p4 = app.apply({ envelope: envelope("provider_proxy") });
		await Promise.all([p1, p2, p3, p4]);
		expect(order).toEqual([1, 2, 3, 4]);
		await app.close();
	});

	it("async FIFO: second apply waits for a slow first apply", async () => {
		const order: string[] = [];
		let resolveGate: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			resolveGate = resolve;
		});
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => {
					await gate;
					order.push("first");
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			event: Object.freeze({
				apply: async () => {
					order.push("second");
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const p1 = app.apply({ envelope: envelope("command") });
		const p2 = app.apply({ envelope: envelope("event") });
		await Promise.resolve();
		expect(order).toEqual([]);
		resolveGate?.();
		await p1;
		await p2;
		expect(order).toEqual(["first", "second"]);
		await app.close();
	});
});

// ===========================================================================
// Poison behavior
// ===========================================================================

describe("poison behavior", () => {
	it("poisons when target apply throws", async () => {
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => {
					throw new Error("boom");
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({ envelope: envelope("command") });
		expect(res).toEqual({ status: "error" });
		expect(await app.apply({ envelope: envelope("command") })).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons when target apply returns non-native-Promise", async () => {
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ ok: true }),
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({ envelope: envelope("command") });
		expect(res).toEqual({ status: "error" });
		expect(await app.apply({ envelope: envelope("command") })).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons when target apply returns non-{status}", async () => {
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ ok: true }),
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({ envelope: envelope("command") });
		expect(res).toEqual({ status: "error" });
		expect(await app.apply({ envelope: envelope("command") })).toEqual({ status: "error" });
		await app.close();
	});

	it("poisons when target apply returns status other than applied", async () => {
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ status: "error" }),
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const res = await app.apply({ envelope: envelope("command") });
		expect(res).toEqual({ status: "error" });
		expect(await app.apply({ envelope: envelope("command") })).toEqual({ status: "error" });
		await app.close();
	});
});

// ===========================================================================
// Close behavior
// ===========================================================================

describe("close behavior", () => {
	it("latches one close and drains admitted work", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const admitted = app.apply({ envelope: envelope("command") });
		const first = app.close();
		const second = app.close();
		expect(second).toBe(first);
		expect(await app.apply({ envelope: envelope("command") })).toEqual({ status: "error" });
		const admittedResult = await admitted;
		expect(admittedResult).toEqual({ status: "applied" });
		expect(await first).toEqual({ status: "closed" });
	});

	it("closes applications in reverse acquisition order", async () => {
		const order: string[] = [];
		const makeTracked = (name: string) =>
			Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					order.push(name);
					return { status: "closed" };
				},
			});
		const input = makeFactoryInput({
			command: makeTracked("cmd"),
			event: makeTracked("evt"),
			agentMessage: makeTracked("amsg"),
			providerProxy: makeTracked("pprox"),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.close();
		// Acquisition order: command, event, agentMessage, providerProxy
		// Reverse: providerProxy, agentMessage, event, command
		expect(order).toEqual(["pprox", "amsg", "evt", "cmd"]);
	});

	it("returns shared close promise on concurrent close requests", async () => {
		const result = await createRelayApplicationMultiplexer(makeFactoryInput());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const c1 = app.close();
		const c2 = app.close();
		expect(c1).toBe(c2);
		expect(await c1).toEqual({ status: "closed" });
	});

	it("each app close is called exactly once", async () => {
		let commandCloseCalls = 0;
		let eventCloseCalls = 0;
		let agentMessageCloseCalls = 0;
		let providerProxyCloseCalls = 0;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					commandCloseCalls += 1;
					return { status: "closed" };
				},
			}),
			event: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					eventCloseCalls += 1;
					return { status: "closed" };
				},
			}),
			agentMessage: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					agentMessageCloseCalls += 1;
					return { status: "closed" };
				},
			}),
			providerProxy: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					providerProxyCloseCalls += 1;
					return { status: "closed" };
				},
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		await app.close();
		expect(commandCloseCalls).toBe(1);
		expect(eventCloseCalls).toBe(1);
		expect(agentMessageCloseCalls).toBe(1);
		expect(providerProxyCloseCalls).toBe(1);
	});
});

// ===========================================================================
// Close drains admitted work before closing
// ===========================================================================

describe("close drains admitted work", () => {
	it("close waits for a slow admitted apply to finish", async () => {
		const order: string[] = [];
		let resolveGate2: (() => void) | undefined;
		const gate2 = new Promise<void>((resolve) => {
			resolveGate2 = resolve;
		});
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => {
					await gate2;
					order.push("applied");
					return { status: "applied" };
				},
				close: async () => {
					order.push("closed");
					return { status: "closed" };
				},
			}),
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;
		const pApply = app.apply({ envelope: envelope("command") });
		const pClose = app.close();
		await Promise.resolve();
		expect(order).toEqual([]);
		resolveGate2?.();
		await pApply;
		expect(order).toEqual(["applied"]);
		await pClose;
		expect(order).toEqual(["applied", "closed"]);
	});
});

// ===========================================================================
// Ownership-first: malformed capability with valid close cleanup
// ===========================================================================

describe("ownership-first close acquisition", () => {
	it("captures close owner even when apply is missing", async () => {
		let closeCalled = false;
		const input = makeFactoryInput({
			command: Object.freeze({
				// no apply — only close
				close: async () => {
					closeCalled = true;
					return { status: "closed" };
				},
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(closeCalled).toBe(true);
	});

	it("captures close owner even when apply throws on call", async () => {
		let closeCalled = false;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: "not_a_function" as unknown as () => Promise<unknown>,
				close: async () => {
					closeCalled = true;
					return { status: "closed" };
				},
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(closeCalled).toBe(true);
	});

	it("captures close owner when capability has extra keys", async () => {
		let closeCalled = false;
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					closeCalled = true;
					return { status: "closed" };
				},
				extra: true,
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(closeCalled).toBe(true);
	});

	it("captures close owner when capability has custom prototype", async () => {
		let closeCalled = false;
		const inner = Object.assign(Object.create(null), {
			apply: async () => ({ status: "applied" }),
			close: async () => {
				closeCalled = true;
				return { status: "closed" };
			},
		});
		const input = makeFactoryInput({ command: inner });
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "INVALID_ARGUMENT" } });
		expect(closeCalled).toBe(true);
	});

	it("captures close owner when capability has symbols", async () => {
		let closeCalled = false;
		const inner: Record<string | symbol, unknown> = {
			apply: async () => ({ status: "applied" }),
			close: async () => {
				closeCalled = true;
				return { status: "closed" };
			},
		};
		inner[Symbol("extra")] = true;
		const input = makeFactoryInput({ command: inner as Record<string, unknown> });
		const result = await createRelayApplicationMultiplexer(input);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(closeCalled).toBe(true);
	});
});

// ===========================================================================
// Preliminary extraction handles parent symbols while capturing values
// ===========================================================================

describe("preliminary parent extraction with symbols", () => {
	it("captures slot values and marks uncertainty when parent has symbols", async () => {
		const caps = makeFactoryInput();
		const outer: Record<string | symbol, unknown> = { ...caps };
		outer[Symbol("extra")] = true;
		const result = await createRelayApplicationMultiplexer(outer as Record<string, unknown>);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("captures slot values despite symbol, closes owners", async () => {
		let commandClosed = false;
		const caps = makeFactoryInput({
			command: Object.freeze({
				apply: async () => ({ status: "applied" }),
				close: async () => {
					commandClosed = true;
					return { status: "closed" };
				},
			}),
		});
		const outer: Record<string | symbol, unknown> = { ...caps };
		outer[Symbol("extra")] = true;
		const result = await createRelayApplicationMultiplexer(outer as Record<string, unknown>);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
		expect(commandClosed).toBe(true);
	});
});

// ===========================================================================
// Hidden slot (accessor descriptor) cleanup
// ===========================================================================

describe("hidden slot cleanup", () => {
	it("marks uncertainty when parent has accessor slot", async () => {
		const caps = makeFactoryInput();
		const outer: Record<string, unknown> = {};
		Object.defineProperty(outer, "command", {
			enumerable: true,
			value: caps.command,
		});
		Object.defineProperty(outer, "event", {
			enumerable: true,
			value: caps.event,
		});
		Object.defineProperty(outer, "agentMessage", {
			enumerable: true,
			value: caps.agentMessage,
		});
		Object.defineProperty(outer, "providerProxy", {
			enumerable: true,
			get: () => caps.providerProxy,
		});
		const result = await createRelayApplicationMultiplexer(outer);
		expect(result).toEqual({ ok: false, error: { code: "CLOSE_UNCERTAIN" } });
	});

	it("removes uncertainty and succeeds when all slots are value descriptors", async () => {
		const caps = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(caps);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await result.application.close();
	});
});

// ===========================================================================
// Nested deep freeze isolation
// ===========================================================================

describe("deep fresh envelope isolation", () => {
	it("does not expose mutable nested objects from input envelope", async () => {
		let received: unknown;
		const mutableFrame = {
			type: "command",
			commandId: "cmd-1",
			body: { type: "create_session", workspaceId: "w-1" },
		};
		const mutableEnvelope = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: mutableFrame,
		};
		const input = makeFactoryInput({
			command: Object.freeze({
				apply: async (raw: unknown) => {
					received = raw;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		await result.application.apply({ envelope: mutableEnvelope });
		// Mutate original — should not affect received
		mutableFrame.body = { type: "destroy_session" };
		mutableFrame.commandId = "cmd-2";
		(mutableEnvelope.frame as Record<string, unknown>).extra = true;
		const r = received as Record<string, unknown>;
		const env = r.envelope as Record<string, unknown>;
		const frame = env.frame as Record<string, unknown>;
		expect(frame.commandId).toBe("cmd-1");
		expect((frame.body as Record<string, unknown>).type).toBe("create_session");
		expect((env as Record<string, unknown>).extra).toBeUndefined();
		await result.application.close();
	});

	it("deep freezes nested arrays within frame", async () => {
		let received: unknown;
		const mutableBody = [{ x: 1 }, { y: 2 }];
		const mutableFrame = {
			type: "provider_proxy",
			proxyType: "model_call_request",
			callId: "call-1",
			provider: "anthropic",
			model: "claude-3",
			messages: mutableBody,
		};
		const input = makeFactoryInput({
			providerProxy: Object.freeze({
				apply: async (raw: unknown) => {
					received = raw;
					return { status: "applied" };
				},
				close: async () => ({ status: "closed" }),
			}),
		});
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const env = {
			envelope: {
				type: "frame",
				frameId: "f-2",
				protocol: { name: "prime-agent.remote-host", version: 1 },
				sentAt: "2025-01-01T00:00:00.000Z",
				frame: mutableFrame,
			},
		};
		await result.application.apply(env);
		mutableBody[0] = { x: 999 };
		mutableBody.push({ z: 3 });
		const r = received as Record<string, unknown>;
		const env2 = r.envelope as Record<string, unknown>;
		const frame = env2.frame as Record<string, unknown>;
		const msgs = frame.messages as unknown[];
		expect((msgs[0] as Record<string, unknown>).x).toBe(1);
		expect(msgs.length).toBe(2);
		await result.application.close();
	});
});
// ===========================================================================

// ===========================================================================

// ===========================================================================
// Hostile tests — audit-blacker corrections for v1
// ===========================================================================

describe("hostile — cast-free codec-normalized clone", () => {
	it("rejects frame with non-JSON-safe Date value (cast-free clone returns sentinel)", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;

		// Envelope with a Date value — deepCloneSafe returns undefined for
		// non-plain-object values, producing a sentinel frame that poisons.
		const env: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: { type: "command", body: new Date("2025-01-01") },
		};
		const applyResult = await app.apply({ envelope: env });
		expect(applyResult.status).toBe("error");
		await app.close();
	});

	it("rejects frame with undefined in tree (non-JSON-safe undefined)", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;

		const env: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: { type: "command", body: { a: undefined } },
		};
		const applyResult = await app.apply({ envelope: env });
		expect(applyResult.status).toBe("error");
		await app.close();
	});

	it("rejects frame with Function value (non-JSON-safe)", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;

		const env: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: { type: "command", body: () => "nope" },
		};
		const applyResult = await app.apply({ envelope: env });
		expect(applyResult.status).toBe("error");
		await app.close();
	});

	it("rejects frame with Set (non-plain-object)", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;

		const env: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: { type: "command", body: new Set([1, 2, 3]) },
		};
		const applyResult = await app.apply({ envelope: env });
		expect(applyResult.status).toBe("error");
		await app.close();
	});
});

describe("hostile — all-or-fail deep freeze at codec bounds", () => {
	it("rejects frame that exceeds max depth (64)", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;

		// Build a nested object at depth 65
		let deep: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < 65; i++) {
			deep = { nested: deep };
		}
		const env: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: { type: "command", body: deep },
		};
		const applyResult = await app.apply({ envelope: env });
		expect(applyResult.status).toBe("error");
		await app.close();
	});

	it("rejects frame that exceeds max node count (10k)", async () => {
		const input = makeFactoryInput();
		const result = await createRelayApplicationMultiplexer(input);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const app = result.application;

		// Array with 10001 items — exceeds 10000 node budget
		const bigBody: number[] = [];
		for (let i = 0; i < 10001; i++) {
			bigBody.push(i);
		}
		const env: Record<string, unknown> = {
			type: "frame",
			frameId: "f-1",
			protocol: { name: "prime-agent.remote-host", version: 1 },
			sentAt: "2025-01-01T00:00:00.000Z",
			frame: { type: "command", body: bigBody },
		};
		const applyResult = await app.apply({ envelope: env });
		expect(applyResult.status).toBe("error");
		await app.close();
	});
});

describe("hostile — hidden parent data slot captures close before rejection", () => {
	it("captures close from non-enumerable factory slot and returns INVALID_ARGUMENT (non-enumerable data is provable, not uncertain)", async () => {
		let hiddenClosed = false;
		const hiddenCap = makeCapability({
			close: async () => {
				hiddenClosed = true;
				return Object.freeze({ status: "closed" });
			},
		});

		// Create factory with non-enumerable `command` property
		const factory: Record<string, unknown> = {
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};
		Object.defineProperty(factory, "command", {
			value: hiddenCap,
			enumerable: false,
			writable: false,
			configurable: false,
		});

		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Non-enumerable data descriptor is provable — no uncertainty.
		// Hidden close is captured, shape is valid → INVALID_ARGUMENT only.
		expect(result.error.code).toBe("INVALID_ARGUMENT");

		// The hidden close MUST be called during rejection cleanup
		expect(hiddenClosed).toBe(true);
	});

	it("non-enumerable extra data key on a slot is provably invalid, not uncertain", async () => {
		let closeCalled = false;
		// Build unfrozen capability so we can add non-enumerable extra key
		const cmdCap: Record<string, unknown> = {
			apply: async () => Object.freeze({ status: "applied" }),
			close: async () => {
				closeCalled = true;
				return Object.freeze({ status: "closed" });
			},
		};
		Object.defineProperty(cmdCap, "extra", {
			value: true,
			enumerable: false,
		});

		const factory: Record<string, unknown> = {
			command: cmdCap,
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};
		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Non-enumerable extra key is provable data → no uncertainty → INVALID_ARGUMENT
		expect(result.error.code).toBe("INVALID_ARGUMENT");
		expect(closeCalled).toBe(true);
	});

	it("rejects accessor-descriptor factory slot with CLOSE_UNCERTAIN (no getter invocation)", async () => {
		let accessorClosed = false;
		const accessorCap = makeCapability({
			close: async () => {
				accessorClosed = true;
				return Object.freeze({ status: "closed" });
			},
		});

		const factory: Record<string, unknown> = {
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};
		Object.defineProperty(factory, "command", {
			get: () => accessorCap,
			enumerable: true,
			configurable: true,
		});

		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Accessor descriptor → ownership uncertain → total uncertain
		expect(result.error.code).toBe("CLOSE_UNCERTAIN");

		// The accessor is NOT invoked — captureAllOwners skips accessor descriptors
		expect(accessorClosed).toBe(false);
	});

	it("rejects proxy-slotted capability with CLOSE_UNCERTAIN (cannot inspect proxy)", async () => {
		let proxyClosed = false;
		const realCap = makeCapability({
			close: async () => {
				proxyClosed = true;
				return Object.freeze({ status: "closed" });
			},
		});
		const proxy = new Proxy(realCap, {});

		const factory: Record<string, unknown> = {
			command: proxy,
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};

		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		// Proxy → captureOwnedClose returns null, hasCapabilityUncertainty true
		expect(result.error.code).toBe("CLOSE_UNCERTAIN");

		// The proxy's close is NOT called — cannot safely capture from proxies
		expect(proxyClosed).toBe(false);
	});
});

describe("hostile — alias cleanup closes each raw object/close fn once", () => {
	it("closes shared raw object only once when same object is used in multiple slots", async () => {
		let closeCount = 0;
		const shared = makeCapability({
			close: async () => {
				closeCount++;
				return Object.freeze({ status: "closed" });
			},
		});

		// Same object for command and event — alias: rejection expected
		const factory: Record<string, unknown> = {
			command: shared,
			event: shared,
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};
		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_ARGUMENT");

		// closeCount should be exactly 1 (shared object closed once, not twice)
		expect(closeCount).toBe(1);
	});

	it("closes shared raw close function only once when slots share closeFn by reference", async () => {
		let closeCount = 0;
		const closeFn = async (): Promise<unknown> => {
			closeCount++;
			return Object.freeze({ status: "closed" });
		};

		const cmd = makeCapability({ close: closeFn });
		const evt = makeCapability({ close: closeFn });

		// Different objects but same closeFn — alias: rejection expected
		const factory: Record<string, unknown> = {
			command: cmd,
			event: evt,
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};
		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("INVALID_ARGUMENT");

		// closeFn called exactly once (not twice)
		expect(closeCount).toBe(1);
	});

	it("closes three distinct capabilities in reverse order", async () => {
		const order: number[] = [];
		const cap1 = makeCapability({
			close: async () => {
				order.push(1);
				return Object.freeze({ status: "closed" });
			},
		});
		const cap2 = makeCapability({
			close: async () => {
				order.push(2);
				return Object.freeze({ status: "closed" });
			},
		});
		const cap3 = makeCapability({
			close: async () => {
				order.push(3);
				return Object.freeze({ status: "closed" });
			},
		});

		const factory = makeFactoryInput({ command: cap1, event: cap2, agentMessage: cap3 });
		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		await result.application.close();
		// Reverse order: agentMessage (3) → event (2) → command (1)
		expect(order).toEqual([3, 2, 1]);
	});
});

describe("hostile — close uncertainty dominates", () => {
	it("returns CLOSE_UNCERTAIN when factory has symbols and validation fails", async () => {
		const factory: Record<string, unknown> = {
			command: makeCapability(),
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};
		// Add a symbol — triggers ownership uncertainty
		(factory as Record<symbol, unknown>)[Symbol("hidden")] = true;

		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;

		// Symbols cause ownership uncertainty → CLOSE_UNCERTAIN, not INVALID_ARGUMENT
		expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});

	it("returns CLOSE_UNCERTAIN when slot has capability uncertainty (proxy)", async () => {
		const proxyCap = new Proxy(makeCapability(), {});
		const factory: Record<string, unknown> = {
			command: proxyCap,
			event: makeCapability(),
			agentMessage: makeCapability(),
			providerProxy: makeCapability(),
		};

		const result = await createRelayApplicationMultiplexer(factory);
		expect(result.ok).toBe(false);
		if (result.ok) return;

		// Proxy causes capability uncertainty → CLOSE_UNCERTAIN, not INVALID_ARGUMENT
		expect(result.error.code).toBe("CLOSE_UNCERTAIN");
	});
});
