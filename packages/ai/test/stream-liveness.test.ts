import { describe, expect, test } from "vitest";
import {
	createStreamLivenessWatchdog,
	DEFAULT_STREAM_LIVENESS_POLICY,
	STREAM_LIVENESS_COUNTER_MAX,
	type StreamLivenessPolicy,
	type StreamLivenessScheduler,
} from "../src/utils/stream-liveness.js";

class FakeRuntime {
	nowMs = 0;
	private nextTimerId = 1;
	private readonly timers = new Map<number, { at: number; callback: () => void }>();

	now = (): number => this.nowMs;

	setTimeout = (callback: () => void, delayMs: number): number => {
		const id = this.nextTimerId++;
		this.timers.set(id, { at: this.nowMs + delayMs, callback });
		return id;
	};

	clearTimeout = (id: unknown): void => {
		if (typeof id === "number") this.timers.delete(id);
	};

	advance(deltaMs: number): void {
		if (deltaMs < 0) throw new Error("test clock cannot move backwards");
		this.nowMs += deltaMs;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.at <= this.nowMs)
				.sort(([, left], [, right]) => left.at - right.at)[0];
			if (!due) return;
			this.timers.delete(due[0]);
			due[1].callback();
		}
	}
}

const policy = (overrides: Partial<StreamLivenessPolicy> = {}): StreamLivenessPolicy => ({
	connectingTimeoutMs: 100,
	headersTimeoutMs: 100,
	streamingIdleTimeoutMs: 100,
	finalizingTimeoutMs: 100,
	progressExtensionMs: 50,
	maxProgressExtensionMs: 150,
	...overrides,
});

function makeWatchdog(
	runtime: FakeRuntime,
	options: {
		policy?: StreamLivenessPolicy;
		abortable?: boolean;
		onTerminal?: (outcome: unknown) => void;
		identity?: { provider: string; model: string; transport: string };
	} = {},
) {
	const selectedPolicy = options.policy ?? policy();
	return createStreamLivenessWatchdog({
		clock: { now: runtime.now },
		scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
		identity: options.identity ?? { provider: "provider-a", model: "model-a", transport: "sse" },
		policyResolver: () => selectedPolicy,
		abortability: options.abortable === false ? "not_abortable" : "abortable",
		requestId: "request-1",
		attemptId: "attempt-1",
		onTerminal: options.onTerminal,
	});
}

describe("provider stream liveness watchdog", () => {
	test("stalls an opened stream with no provider event at the connecting bound", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		runtime.advance(99);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			type: "provider_stream_stalled",
			abortIntent: { requested: true },
			diagnostic: { type: "provider_stream_stalled", phase: "connecting" },
		});
		expect(watchdog.snapshot()).toMatchObject({
			phase: "connecting",
			startedAt: 0,
			abortability: "abortable",
		});
		expect(watchdog.snapshot().requestId).toMatch(/^h2-/);
		expect(watchdog.snapshot().attemptId).toMatch(/^h2-/);
	});

	test("keeps periodic meaningful reasoning alive only until the finite extension cap", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, {
			policy: policy({ progressExtensionMs: 100, maxProgressExtensionMs: 120 }),
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		watchdog.observe({ type: "thinking_delta", delta: "step 1" });
		runtime.advance(80);
		watchdog.observe({ type: "thinking_delta", delta: "step 2" });
		runtime.advance(80);
		watchdog.observe({ type: "thinking_delta", delta: "step 3" });
		runtime.advance(59);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ type: "provider_stream_stalled" });
	});

	test("does not treat whitespace or duplicate heartbeat events as progress", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		watchdog.observe({ type: "headers", receivedBytes: 4, blocks: 1 });
		runtime.advance(25);
		watchdog.observe({ type: "text_delta", delta: " \n\t" });
		watchdog.observe({ type: "provider_event", eventId: "heartbeat-1" });
		runtime.advance(25);
		watchdog.observe({ type: "provider_event", eventId: "heartbeat-1" });
		runtime.advance(49);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			type: "provider_stream_stalled",
			diagnostic: { phase: "headers" },
		});
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBeUndefined();
	});

	test("moves through headers without claiming streaming or extending the header bound", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		runtime.advance(50);
		watchdog.observe({ type: "headers", receivedBytes: 10, blocks: 1 });
		expect(watchdog.snapshot()).toMatchObject({ phase: "headers", lastProviderEventAt: 50 });
		runtime.advance(49);
		watchdog.observe({ type: "provider_event", eventId: "ready" });
		expect(watchdog.snapshot()).toMatchObject({ phase: "headers", lastProviderEventAt: 99 });
		runtime.advance(1);
		expect(outcomes).toHaveLength(0);
		runtime.advance(50);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ type: "provider_stream_stalled", diagnostic: { phase: "headers" } });
	});

	test("uses the finalizing phase bound after content stops", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		watchdog.observe({ type: "text_delta", delta: "answer" });
		runtime.advance(25);
		watchdog.markFinalizing();
		expect(watchdog.snapshot()).toMatchObject({ phase: "finalizing", lastDeltaAt: 0 });
		runtime.advance(99);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);

		expect(outcomes[0]).toMatchObject({
			type: "provider_stream_stalled",
			diagnostic: { phase: "finalizing", reason: "finalizing_timeout" },
		});
	});

	test("counts changed tool arguments as progress while canonical duplicates are ignored", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);

		watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args: { query: "one", page: 1 } });
		runtime.advance(10);
		watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args: { page: 1, query: "one" } });
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(0);
		runtime.advance(10);
		watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args: { page: 2, query: "one" } });
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(20);
		runtime.advance(10);
		watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args: { page: 2, query: "one" } });
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(20);
	});

	test("resolves provider/model policy from the host identity", () => {
		const runtime = new FakeRuntime();
		const resolved: Array<{ provider: string; model: string; transport: string }> = [];
		const outcomes: unknown[] = [];
		const watchdog = createStreamLivenessWatchdog({
			clock: { now: runtime.now },
			scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
			identity: { provider: "provider-a", model: "model-a", transport: "sse" },
			policyResolver: (identity) => {
				resolved.push(identity);
				return policy({ connectingTimeoutMs: identity.provider === "provider-a" ? 40 : 100 });
			},
			requestId: "request-1",
			attemptId: "attempt-1",
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		runtime.advance(39);
		expect(watchdog.snapshot().phase).toBe("connecting");
		runtime.advance(1);

		expect(resolved).toEqual([{ provider: "provider-a", model: "model-a", transport: "sse" }]);
		expect(outcomes).toHaveLength(1);
		expect(watchdog.snapshot().phase).toBe("connecting");

		const otherRuntime = new FakeRuntime();
		const otherOutcomes: unknown[] = [];
		createStreamLivenessWatchdog({
			clock: { now: otherRuntime.now },
			scheduler: { setTimeout: otherRuntime.setTimeout, clearTimeout: otherRuntime.clearTimeout },
			identity: { provider: "provider-b", model: "model-b", transport: "websocket" },
			policyResolver: (identity) => policy({ connectingTimeoutMs: identity.provider === "provider-a" ? 40 : 100 }),
			onTerminal: (outcome) => otherOutcomes.push(outcome),
		});
		otherRuntime.advance(40);
		expect(otherOutcomes).toHaveLength(0);
		otherRuntime.advance(60);
		expect(otherOutcomes).toHaveLength(1);
	});

	test("rejects a regressing monotonic clock", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);

		runtime.advance(10);
		watchdog.observe({ type: "provider_event" });
		runtime.nowMs = 9;
		expect(() => watchdog.observe({ type: "provider_event" })).toThrow(/clock/i);
	});

	test("saturates counters and redacts untrusted diagnostic values", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const aborts: unknown[] = [];
		const watchdog = createStreamLivenessWatchdog({
			clock: { now: runtime.now },
			scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
			identity: { provider: "provider-a", model: "model-a", transport: "sse" },
			policyResolver: () => policy(),
			requestId: "Bearer secret request id",
			attemptId: "attempt-secret-token",
			onTerminal: (outcome) => outcomes.push(outcome),
			abort: () => aborts.push("abort"),
		});

		watchdog.observe({
			type: "tool_call",
			id: "secret-tool-id",
			name: "secret-tool-name",
			args: { authorization: "Bearer secret" },
			receivedBytes: STREAM_LIVENESS_COUNTER_MAX,
			blocks: STREAM_LIVENESS_COUNTER_MAX,
		});
		watchdog.observe({ type: "provider_event", receivedBytes: 1, blocks: 1 });
		expect(watchdog.snapshot()).toMatchObject({
			receivedBytes: STREAM_LIVENESS_COUNTER_MAX,
			blocks: STREAM_LIVENESS_COUNTER_MAX,
		});

		runtime.advance(100);
		expect(aborts).toEqual(["abort"]);
		const diagnosticText = JSON.stringify(outcomes);
		expect(diagnosticText).not.toContain("Bearer secret");
		expect(diagnosticText).not.toContain("secret-tool-id");
		expect(diagnosticText).not.toContain("secret-tool-name");
	});

	test("records a stalled decision without invoking abort for a non-abortable stream", () => {
		const runtime = new FakeRuntime();
		const aborts: unknown[] = [];
		const outcomes: unknown[] = [];
		const watchdog = createStreamLivenessWatchdog({
			clock: { now: runtime.now },
			scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
			identity: { provider: "provider-a", model: "model-a", transport: "sse" },
			policyResolver: () => policy(),
			abortability: "not_abortable",
			abort: () => aborts.push("abort"),
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		runtime.advance(100);

		expect(aborts).toEqual([]);
		expect(watchdog.snapshot().abortability).toBe("not_abortable");
		expect(outcomes[0]).toMatchObject({
			type: "provider_stream_stalled",
			abortIntent: { requested: false, reason: "not_abortable" },
		});
	});

	test("commits exactly one terminal outcome when final/error races the watchdog abort", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		expect(watchdog.markFinal()).toMatchObject({ type: "provider_stream_final" });
		expect(watchdog.markError()).toBeUndefined();
		runtime.advance(200);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ type: "provider_stream_final" });

		const secondRuntime = new FakeRuntime();
		const secondOutcomes: unknown[] = [];
		const secondWatchdog = makeWatchdog(secondRuntime, { onTerminal: (outcome) => secondOutcomes.push(outcome) });
		secondRuntime.advance(100);
		expect(secondOutcomes).toHaveLength(1);
		expect(secondWatchdog.markFinal()).toBeUndefined();
		expect(secondWatchdog.markError()).toBeUndefined();
		expect(secondOutcomes).toHaveLength(1);
	});

	test("allows zero progress extension without scheduling an immediate stall", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, {
			policy: policy({ progressExtensionMs: 0, maxProgressExtensionMs: 0 }),
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		watchdog.observe({ type: "thinking_delta", delta: "first step" });
		expect(watchdog.snapshot().phase).toBe("streaming");
		runtime.advance(99);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);
		expect(outcomes).toHaveLength(1);
	});

	test("does not let first meaningful progress shorten the baseline streaming deadline", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, {
			policy: policy({ streamingIdleTimeoutMs: 100, progressExtensionMs: 10, maxProgressExtensionMs: 100 }),
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		watchdog.observe({ type: "text_delta", delta: "first answer" });
		runtime.advance(99);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);

		expect(outcomes).toHaveLength(1);
	});

	test("fails closed before normalizing an oversized semantic delta", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);

		watchdog.observe({ type: "text_delta", delta: "x".repeat(1_000_000) });

		expect(watchdog.snapshot()).toMatchObject({
			phase: "connecting",
			lastMeaningfulContentDeltaAt: undefined,
		});
	});

	test("does not extend for braille or half-fill blanks or standalone combining marks", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		watchdog.observe({ type: "headers" });
		for (const delta of ["\u2800", "\u303f", "\u0301\u0342", "\u2800\u0301\u303f"]) {
			runtime.advance(15);
			watchdog.observe({ type: "text_delta", delta });
			expect(watchdog.snapshot().phase).toBe("headers");
		}
		runtime.advance(40);

		expect(outcomes).toHaveLength(1);
	});

	test("deduplicates NFC-equivalent semantic text", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);

		watchdog.observe({ type: "text_delta", delta: "e\u0301" });
		runtime.advance(10);
		watchdog.observe({ type: "text_delta", delta: "é" });

		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(0);
	});

	test("keeps distinct invalid surrogate text deltas distinct without throwing", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);

		watchdog.observe({ type: "text_delta", delta: "\ud800" });
		runtime.advance(10);
		watchdog.observe({ type: "text_delta", delta: "\udc00" });

		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(10);
	});

	test("does not phase-game with zero-width or ANSI-only content", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		watchdog.observe({ type: "headers" });
		runtime.advance(25);
		watchdog.observe({ type: "text_delta", delta: " \u200b\u200d\u001b[31m\u001b[0m\t" });
		expect(watchdog.snapshot().phase).toBe("headers");
		runtime.advance(74);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);
		expect(outcomes).toHaveLength(1);
	});

	test("ignores default-ignorable, C0/C1, and ANSI control sequences", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		watchdog.observe({ type: "headers" });
		watchdog.observe({
			type: "text_delta",
			delta:
				"\u00ad\u034f\u061c\u180e\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e" +
				"\u2060\u2061\u2062\u2063\u2064\u2065\u2066\u2067\u2068\u2069\u206a\u206b\u206c\u206d\u206e\u206f" +
				"\ufeff\ufe0f\u{e0001}\u{e0020}\u{e007f}" +
				"\u001b7\u001b8\u001b[31m\u001b[0m\u001b]0;status\u0007\u009b31m" +
				String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)) +
				String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 0x80)),
		});

		expect(watchdog.snapshot()).toMatchObject({ phase: "headers", lastMeaningfulContentDeltaAt: undefined });
		runtime.advance(99);
		expect(outcomes).toHaveLength(0);
		runtime.advance(1);
		expect(outcomes).toHaveLength(1);
	});

	test("does not extend the deadline for alternating invisible deltas", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, { onTerminal: (outcome) => outcomes.push(outcome) });

		watchdog.observe({ type: "headers" });
		for (const delta of ["\u2061", "\u001b7", "\u009b31m", "\u001b8", "\u200f"]) {
			runtime.advance(15);
			watchdog.observe({ type: "text_delta", delta });
			expect(watchdog.snapshot().phase).toBe("headers");
		}
		runtime.advance(25);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			type: "provider_stream_stalled",
			diagnostic: { phase: "headers" },
		});
	});

	test("distinguishes known 32-bit hash collisions in semantic text", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);

		watchdog.observe({ type: "text_delta", delta: "72bit0De" });
		runtime.advance(10);
		watchdog.observe({ type: "text_delta", delta: "nYTYhaB4" });

		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(10);
	});

	test("hashes the full bounded semantic delta so middle changes count", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);
		const prefix = "a".repeat(4096);
		const suffix = "z".repeat(4096);

		watchdog.observe({ type: "text_delta", delta: `${prefix}middle-one${suffix}` });
		runtime.advance(10);
		watchdog.observe({ type: "text_delta", delta: `${prefix}middle-two${suffix}` });

		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(10);
	});

	test("snapshots policy from own data descriptors and rejects accessors or custom prototypes", () => {
		const runtime = new FakeRuntime();
		const accessorPolicy: StreamLivenessPolicy & Record<string, unknown> = { ...policy() };
		let getterReads = 0;
		Object.defineProperty(accessorPolicy, "connectingTimeoutMs", {
			configurable: true,
			enumerable: true,
			get: () => {
				getterReads++;
				return 100;
			},
		});

		expect(() =>
			createStreamLivenessWatchdog({
				clock: { now: runtime.now },
				scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
				identity: { provider: "provider-a", model: "model-a", transport: "sse" },
				policyResolver: () => accessorPolicy,
			}),
		).toThrow(/accessor|data property/i);
		expect(getterReads).toBe(0);

		const customPrototypePolicy = Object.assign(Object.create({ inherited: true }), policy());
		expect(() =>
			createStreamLivenessWatchdog({
				clock: { now: runtime.now },
				scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
				identity: { provider: "provider-a", model: "model-a", transport: "sse" },
				policyResolver: () => customPrototypePolicy,
			}),
		).toThrow(/prototype|plain/i);
	});

	test("bounds and fails closed on deeply nested or cyclic tool arguments", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);
		const deep: Record<string, unknown> = {};
		let cursor = deep;
		for (let index = 0; index < 1000; index++) {
			const child: Record<string, unknown> = {};
			cursor.child = child;
			cursor = child;
		}

		expect(() => watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args: deep })).not.toThrow();
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBeUndefined();

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => watchdog.observe({ type: "tool_call", id: "call-2", name: "lookup", args: cyclic })).not.toThrow();
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBeUndefined();
	});

	test("bounds tool argument key enumeration before allocating an unbounded key list", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);
		const args: Record<string, unknown> = {};
		for (let index = 0; index < 50_000; index++) args[`key-${index}`] = index;

		expect(() => watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args })).not.toThrow();
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBeUndefined();
	});

	test("snapshots tool argument accessors once per observation and fails closed on throws", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);
		let reads = 0;
		const args: Record<string, unknown> = {};
		Object.defineProperty(args, "query", {
			enumerable: true,
			get: () => {
				reads++;
				if (reads > 1) throw new Error("unstable tool args");
				return "one";
			},
		});

		watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args });
		expect(reads).toBe(1);
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(0);
		runtime.advance(10);
		expect(() => watchdog.observe({ type: "tool_call", id: "call-1", name: "lookup", args })).not.toThrow();
		expect(reads).toBe(2);
		expect(watchdog.snapshot().lastMeaningfulContentDeltaAt).toBe(0);
	});

	test("redacts identities from state and stalled diagnostics", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = createStreamLivenessWatchdog({
			clock: { now: runtime.now },
			scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
			identity: { provider: "Bearer provider-secret", model: "model-super-secret", transport: "secret-transport" },
			policyResolver: () => policy(),
			requestId: "Bearer request-secret",
			attemptId: "attempt-secret-token",
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		runtime.advance(100);
		const snapshot = watchdog.snapshot();
		const text = JSON.stringify({ snapshot, outcomes });
		expect(text).not.toContain("provider-secret");
		expect(text).not.toContain("model-super-secret");
		expect(text).not.toContain("secret-transport");
		expect(text).not.toContain("request-secret");
		expect(text).not.toContain("attempt-secret-token");
		expect(snapshot.provider).toMatch(/^h2-/);
		expect(snapshot.model).toMatch(/^h2-/);
		expect(snapshot.transport).toMatch(/^h2-/);
		expect(snapshot.requestId).toMatch(/^h2-/);
		expect(snapshot.attemptId).toMatch(/^h2-/);
	});

	test("rejects invalid host policy and handles extreme finite clocks", () => {
		const runtime = new FakeRuntime();
		expect(() => makeWatchdog(runtime, { policy: policy({ headersTimeoutMs: Number.MAX_VALUE }) })).toThrow(
			/policy|duration|overflow/i,
		);
		expect(() =>
			makeWatchdog(runtime, { policy: policy({ connectingTimeoutMs: Number.POSITIVE_INFINITY }) }),
		).toThrow(/finite/i);

		const extremeRuntime = new FakeRuntime();
		extremeRuntime.nowMs = Number.MAX_VALUE;
		expect(() => makeWatchdog(extremeRuntime)).not.toThrow();
	});

	test("makes post-terminal observation a no-op", () => {
		const runtime = new FakeRuntime();
		const watchdog = makeWatchdog(runtime);
		watchdog.markFinal();
		const before = watchdog.snapshot();
		runtime.nowMs = -1;
		expect(() =>
			watchdog.observe({ type: "text_delta", delta: "ignored", receivedBytes: -1, blocks: -1 }),
		).not.toThrow();
		expect(watchdog.snapshot()).toEqual(before);
	});

	test("still emits the terminal callback when abort throws", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const abortingWatchdog = createStreamLivenessWatchdog({
			clock: { now: runtime.now },
			scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
			identity: { provider: "provider-a", model: "model-a", transport: "sse" },
			policyResolver: () => policy(),
			abort: () => {
				throw new Error("abort failed");
			},
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		expect(() => runtime.advance(100)).not.toThrow();
		expect(abortingWatchdog.snapshot().terminal).toBe(true);
		expect(outcomes).toHaveLength(1);
	});

	test("still commits exactly once when clearTimeout throws", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = createStreamLivenessWatchdog({
			clock: { now: runtime.now },
			scheduler: {
				setTimeout: runtime.setTimeout,
				clearTimeout: () => {
					throw new Error("clear failed");
				},
			},
			identity: { provider: "provider-a", model: "model-a", transport: "sse" },
			policyResolver: () => policy(),
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		expect(() => watchdog.markFinal()).not.toThrow();
		expect(outcomes).toHaveLength(1);
		expect(watchdog.markError()).toBeUndefined();
		expect(outcomes).toHaveLength(1);
	});

	test("turns a throwing clock hook into one terminal outcome", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		let reads = 0;
		const watchdog = createStreamLivenessWatchdog({
			clock: {
				now: () => {
					reads++;
					if (reads > 1) throw new Error("clock failed");
					return runtime.now();
				},
			},
			scheduler: { setTimeout: runtime.setTimeout, clearTimeout: runtime.clearTimeout },
			identity: { provider: "provider-a", model: "model-a", transport: "sse" },
			policyResolver: () => policy(),
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		expect(() => watchdog.markFinal()).not.toThrow();
		expect(outcomes).toHaveLength(1);
		expect(watchdog.snapshot().terminal).toBe(true);
		expect(watchdog.markError()).toBeUndefined();
		expect(outcomes).toHaveLength(1);
	});

	test("rejects schedulers with invalid handles or synchronous callbacks", () => {
		const runtime = new FakeRuntime();
		expect(() =>
			createStreamLivenessWatchdog({
				clock: { now: runtime.now },
				scheduler: { setTimeout: () => 1 } as unknown as StreamLivenessScheduler,
				identity: { provider: "provider-a", model: "model-a", transport: "sse" },
				policyResolver: () => policy(),
			}),
		).toThrow(/clearTimeout/i);

		expect(() =>
			createStreamLivenessWatchdog({
				clock: { now: runtime.now },
				scheduler: { setTimeout: () => undefined, clearTimeout: () => undefined },
				identity: { provider: "provider-a", model: "model-a", transport: "sse" },
				policyResolver: () => policy(),
			}),
		).toThrow(/handle/i);

		expect(() =>
			createStreamLivenessWatchdog({
				clock: { now: runtime.now },
				scheduler: { setTimeout: () => null, clearTimeout: () => undefined },
				identity: { provider: "provider-a", model: "model-a", transport: "sse" },
				policyResolver: () => policy(),
			}),
		).toThrow(/handle/i);

		expect(() =>
			createStreamLivenessWatchdog({
				clock: { now: runtime.now },
				scheduler: {
					setTimeout: (callback: () => void) => {
						callback();
						return 1;
					},
					clearTimeout: () => undefined,
				},
				identity: { provider: "provider-a", model: "model-a", transport: "sse" },
				policyResolver: () => policy(),
			}),
		).toThrow(/synchronous/i);
	});
});

describe("default stream liveness policy headers bound", () => {
	// Observed 2026-08 with provider "openai-codex", model gpt-5.6-sol at thinking level "high":
	// headers at 319ms, one ~89KB response.created at 1045ms, then no wire traffic while the model
	// reasoned. The old 30s bound killed every substantial turn at elapsedMs 30319 / idleMs 29274.
	const replayIncidentHeaders = (runtime: FakeRuntime, outcomes: unknown[]) => {
		const watchdog = makeWatchdog(runtime, {
			policy: DEFAULT_STREAM_LIVENESS_POLICY,
			identity: { provider: "openai-codex", model: "gpt-5.6-sol", transport: "sse" },
			onTerminal: (outcome) => outcomes.push(outcome),
		});
		runtime.advance(319);
		watchdog.observe({ type: "headers" });
		runtime.advance(726);
		watchdog.observe({ type: "provider_event", eventId: "response.created", receivedBytes: 88_950 });
		return watchdog;
	};

	test("survives a reasoning model that emits no content block for the first 30 seconds", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = replayIncidentHeaders(runtime, outcomes);

		runtime.advance(29_955);
		expect(outcomes).toEqual([]);
		expect(watchdog.snapshot()).toMatchObject({ phase: "headers", receivedBytes: 88_950, blocks: 0 });

		runtime.advance(44_000);
		watchdog.observe({ type: "thinking_delta", delta: "first summary part" });
		expect(outcomes).toEqual([]);
		expect(watchdog.snapshot()).toMatchObject({ phase: "streaming" });
	});

	test("still stalls a dead stream at the finite headers bound", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, {
			policy: DEFAULT_STREAM_LIVENESS_POLICY,
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		runtime.advance(319);
		watchdog.observe({ type: "headers" });
		runtime.advance(299_999);
		expect(outcomes).toEqual([]);
		runtime.advance(1);

		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			type: "provider_stream_stalled",
			abortIntent: { requested: true },
			diagnostic: {
				phase: "headers",
				reason: "no_meaningful_content_progress",
				elapsedMs: 300_319,
				idleMs: 300_000,
				receivedBytes: 0,
				blocks: 0,
			},
		});
		expect(watchdog.snapshot().terminal).toBe(true);
	});

	test("never extends the headers deadline on byte-carrying provider events", () => {
		const runtime = new FakeRuntime();
		const outcomes: unknown[] = [];
		const watchdog = makeWatchdog(runtime, {
			policy: DEFAULT_STREAM_LIVENESS_POLICY,
			onTerminal: (outcome) => outcomes.push(outcome),
		});

		watchdog.observe({ type: "headers", receivedBytes: 1_024 });
		for (let tick = 1; tick <= 10; tick++) {
			runtime.advance(20_000);
			watchdog.observe({ type: "provider_event", eventId: `keepalive-${tick}`, receivedBytes: 40 });
			expect(watchdog.snapshot().deadlineAt).toBe(DEFAULT_STREAM_LIVENESS_POLICY.headersTimeoutMs);
		}

		runtime.advance(99_999);
		expect(outcomes).toEqual([]);
		runtime.advance(1);
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ diagnostic: { phase: "headers", elapsedMs: 300_000 } });
	});

	test("keeps the headers budget no larger than the streaming budget", () => {
		expect(DEFAULT_STREAM_LIVENESS_POLICY.headersTimeoutMs).toBe(300_000);
		expect(DEFAULT_STREAM_LIVENESS_POLICY.headersTimeoutMs).toBeLessThanOrEqual(
			DEFAULT_STREAM_LIVENESS_POLICY.streamingIdleTimeoutMs + DEFAULT_STREAM_LIVENESS_POLICY.maxProgressExtensionMs,
		);
		for (const value of Object.values(DEFAULT_STREAM_LIVENESS_POLICY)) {
			expect(Number.isFinite(value)).toBe(true);
			expect(value).toBeGreaterThan(0);
		}
	});
});
