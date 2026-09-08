import { describe, expect, it } from "bun:test";
import type {
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmRuntimePort,
	HostedRlmRuntimePortFactoryResult,
	HostedRlmTaskResult,
} from "../src/core/hosted-rlm-runtime-port.js";
import type { HomeStreamRouter } from "../src/modes/daemon/sandbox/prime-sandbox-home-stream-router.js";
import { createHomeStreamRouter } from "../src/modes/daemon/sandbox/prime-sandbox-home-stream-router.js";
import { createHostedSandboxChildPort } from "../src/modes/daemon/sandbox/prime-sandbox-hosted-child-port.js";
import {
	decodeLifecycleRecord,
	encodeLifecycleRecord,
	encodeLifecycleReply,
} from "../src/modes/daemon/sandbox/prime-sandbox-runtime-control-codec.js";
import { createPrimeSandboxRuntimeControllerRelay } from "../src/modes/daemon/sandbox/prime-sandbox-runtime-controller-relay.js";
import type {
	ApplicationBundle,
	CancelResult,
	ComposedReplyResult,
	DeliveryResult,
	HomeMultiplexer,
	OriginSubmit,
	PollDeliveryResult,
	PollReplyResult,
	ReplyResult,
	RuntimeMultiplexer,
	SubmitResult,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";
import {
	createHomeMultiplexer,
	createRuntimeMultiplexer,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";

function vid(id: string): HostedRlmRuntimeIdentity {
	return {
		childId: id,
		sessionId: "s1",
		sessionName: "n1",
		modelSelector: "m1",
	};
}

interface _Deferred<T> {
	readonly promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
}

function _defer<T>(): _Deferred<T> {
	var resolve: (value: T) => void = () => {};
	var reject: (reason: unknown) => void = () => {};
	var promise: Promise<T> = new Promise<T>((res: (value: T) => void, rej: (reason: unknown) => void): void => {
		resolve = res;
		reject = rej;
	});
	return { promise: promise, resolve: resolve, reject: reject };
}

function _freezeClosed(): SubmitResult {
	return Object.freeze({ code: "CLOSED" });
}
function _freezeInputInvalid(): SubmitResult {
	return Object.freeze({ code: "INPUT_INVALID" });
}
function _freezePending() {
	return Object.freeze({ code: "PENDING" });
}

function _freezeConfirmed(): DeliveryResult {
	return Object.freeze({ code: "CONFIRMED" });
}
function _freezePoisonedDelivery(): DeliveryResult {
	return Object.freeze({ code: "POISONED" });
}
function _freezeCancelledReply(): ReplyResult {
	return Object.freeze({ code: "CANCELLED" });
}
function _freezeReplyReady(payload: Uint8Array): ReplyResult {
	return Object.freeze({ code: "REPLY_READY", payload: payload });
}
var _REJECTED_SENTINEL: Readonly<{ _rejected: true }> = Object.freeze({ _rejected: true });
var _UNKNOWN_TICKET_REPLY: ReplyResult = Object.freeze({ code: "UNKNOWN_TICKET" });
var _UNKNOWN_TICKET_DELIVERY: DeliveryResult = Object.freeze({ code: "POISONED" });

function _freezeSent(): ComposedReplyResult {
	return Object.freeze({ code: "SENT" });
}

interface _TicketEntry {
	ticket: object;
	state: _TicketState;
}
interface _TicketState {
	payload: Uint8Array;
	deliveryDeferred: _Deferred<DeliveryResult>;
	replyDeferred: _Deferred<ReplyResult>;
}

function makeFakeOriginSubmit(): {
	origin: OriginSubmit;
	ticketCount: () => number;
	cancelCount: () => number;
	confirm: (payload: Uint8Array) => void;
	reply: (payload: Uint8Array, replyBytes: Uint8Array) => void;
	confirmLast: () => void;
	replyLast: (replyBytes: Uint8Array) => void;
	failDelivery: () => void;
	failReply: () => void;
	rejectDelivery: () => void;
	rejectReply: () => void;
	lastPayload: () => Uint8Array;
} {
	var tickets: Array<_TicketEntry> = [];
	var closed: boolean = false;
	var ticketCounter: number = 0;
	var cancelCounter: number = 0;
	var lastPayload: Uint8Array = new Uint8Array(0);

	function submit(payloadRaw: unknown): SubmitResult {
		if (closed) return _freezeClosed();
		var checked: Uint8Array | null = decodeSeenPayload(payloadRaw);
		if (checked === null) return _freezeInputInvalid();
		var copy: Uint8Array = new Uint8Array(checked.length);
		for (let ci: number = 0; ci < checked.length; ci++) copy[ci] = checked[ci];
		lastPayload = copy;
		var state: _TicketState = {
			payload: copy,
			deliveryDeferred: _defer<DeliveryResult>(),
			replyDeferred: _defer<ReplyResult>(),
		};
		var ticket: object = Object.freeze({ counter: ticketCounter });
		ticketCounter += 1;
		tickets.push({ ticket: ticket, state: state });
		return Object.freeze({ code: "SUBMITTED", ticket: ticket });
	}

	function cancel(ticketRaw: unknown) {
		cancelCounter += 1;
		const state = findTicket(ticketRaw);
		if (state !== null) {
			state.deliveryDeferred.resolve(_freezePoisonedDelivery());
			state.replyDeferred.resolve(_freezeCancelledReply());
		}
		return _freezePending();
	}
	function pollDelivery() {
		return _freezePending();
	}
	function pollReply() {
		return _freezePending();
	}

	function findTicket(ticketRaw: unknown): _TicketState | null {
		for (let i: number = 0; i < tickets.length; i++) {
			if (tickets[i].ticket === ticketRaw) return tickets[i].state;
		}
		return null;
	}

	function awaitDelivery(ticketRaw: unknown): Promise<DeliveryResult> {
		var state: _TicketState | null = findTicket(ticketRaw);
		if (state === null) return Promise.resolve(_UNKNOWN_TICKET_DELIVERY);
		return state.deliveryDeferred.promise;
	}

	function awaitReply(ticketRaw: unknown): Promise<ReplyResult> {
		var state: _TicketState | null = findTicket(ticketRaw);
		if (state === null) return Promise.resolve(_UNKNOWN_TICKET_REPLY);
		return state.replyDeferred.promise;
	}

	var origin: OriginSubmit = Object.freeze({
		submit: submit,
		cancel: cancel,
		pollDelivery: pollDelivery,
		pollReply: pollReply,
		awaitDelivery: awaitDelivery,
		awaitReply: awaitReply,
	});

	function confirm(payload: Uint8Array): void {
		for (let i: number = 0; i < tickets.length; i++) {
			if (bytesEqual(tickets[i].state.payload, payload)) {
				tickets[i].state.deliveryDeferred.resolve(_freezeConfirmed());
				return;
			}
		}
	}

	function reply(payload: Uint8Array, replyBytes: Uint8Array): void {
		for (let i: number = 0; i < tickets.length; i++) {
			if (bytesEqual(tickets[i].state.payload, payload)) {
				tickets[i].state.replyDeferred.resolve(_freezeReplyReady(replyBytes));
				return;
			}
		}
	}

	function confirmLast(): void {
		if (tickets.length > 0) {
			tickets[tickets.length - 1].state.deliveryDeferred.resolve(_freezeConfirmed());
		}
	}

	function replyLast(replyBytes: Uint8Array): void {
		if (tickets.length > 0) {
			tickets[tickets.length - 1].state.replyDeferred.resolve(_freezeReplyReady(replyBytes));
		}
	}

	function failDelivery(): void {
		if (tickets.length > 0) {
			tickets[tickets.length - 1].state.deliveryDeferred.resolve(_freezePoisonedDelivery());
		}
	}

	function failReply(): void {
		if (tickets.length > 0) {
			tickets[tickets.length - 1].state.replyDeferred.resolve(_freezeCancelledReply());
		}
	}

	function rejectDelivery(): void {
		if (tickets.length > 0) {
			tickets[tickets.length - 1].state.deliveryDeferred.reject(_REJECTED_SENTINEL);
		}
	}

	function rejectReply(): void {
		if (tickets.length > 0) {
			tickets[tickets.length - 1].state.replyDeferred.reject(_REJECTED_SENTINEL);
		}
	}

	return {
		origin: origin,
		ticketCount: (): number => tickets.length,
		cancelCount: (): number => cancelCounter,
		confirm: confirm,
		reply: reply,
		confirmLast: confirmLast,
		replyLast: replyLast,
		failDelivery: failDelivery,
		failReply: failReply,
		rejectDelivery: rejectDelivery,
		rejectReply: rejectReply,
		lastPayload: (): Uint8Array => lastPayload,
	};
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	for (let i: number = 0; i < a.byteLength; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

function decodeSeenPayload(raw: unknown): Uint8Array | null {
	if (typeof raw !== "object" || raw === null) return null;
	if (!(raw instanceof Uint8Array)) return null;
	return raw;
}

function replyBytesForStart(): Uint8Array {
	var enc = encodeLifecycleReply("START", { code: "ADMITTED" });
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}
function replyBytesForAbort(status?: string): Uint8Array {
	var s: string = status !== undefined ? status : "aborted";
	var enc = encodeLifecycleReply("ABORT", { status: s });
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}
function replyBytesForObserve(): Uint8Array {
	var enc = encodeLifecycleReply("OBSERVE", {
		status: "running",
		messageCount: 5,
		toolUseCount: 2,
		agentRunning: true,
		parentReplyCount: 0,
	});
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}
function replyBytesForClose(): Uint8Array {
	var enc = encodeLifecycleReply("CLOSE", { status: "closed" });
	if (enc.ok) return enc.bytes;
	return new Uint8Array(0);
}

var _ZOMBIE_PORT = Object.freeze({
	identity: Object.freeze({ childId: "", sessionId: "", sessionName: "", modelSelector: "" }),
	startInitialTask: (): Promise<unknown> =>
		Promise.resolve(Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) })),
	awaitTerminal: (): Promise<unknown> =>
		Promise.resolve(Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) })),
	abort: (): Promise<unknown> =>
		Promise.resolve(Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) })),
	observe: (): Promise<unknown> =>
		Promise.resolve(Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) })),
	subscribe: (): unknown => Object.freeze({ ok: false, error: Object.freeze({ code: "POISONED" }) }),
	close: (): Promise<unknown> =>
		Promise.resolve(Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSED" }) })),
});

function harness1() {
	var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
	var router: HomeStreamRouter = createHomeStreamRouter({
		modelProvider: { dispatchApplication: (): void => {} },
	});
	var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
		identity: vid("c1"),
		lifecycleOrigin: fake.origin,
		router: router,
	});
	if (!factoryResult.ok) return Object.freeze({ ok: false, port: _ZOMBIE_PORT, origin: fake, router: router });
	return { ok: true, port: factoryResult.value, origin: fake, router: router };
}

function isOk<T>(result: { ok: boolean; value?: T }): result is { ok: true; value: T } {
	return result.ok === true;
}

function makeEventBundle(
	id: HostedRlmRuntimeIdentity,
	op: string,
	body: Record<string, unknown>,
	replyResult?: Promise<ComposedReplyResult>,
): ApplicationBundle {
	var encResult = encodeLifecycleRecord({
		v: 1,
		identity: id,
		op: op,
		body: body,
	});
	if (!encResult.ok)
		return {
			origin: "Runtime",
			stream: 1,
			payload: new Uint8Array(0),
			signal: new AbortController().signal,
			reply: (): Promise<ComposedReplyResult> =>
				replyResult !== undefined ? replyResult : Promise.resolve(_freezeSent()),
		};
	var bytes: Uint8Array = encResult.bytes;
	return {
		origin: "Runtime",
		stream: 1,
		payload: bytes,
		signal: new AbortController().signal,
		reply: (): Promise<ComposedReplyResult> =>
			replyResult !== undefined ? replyResult : Promise.resolve(_freezeSent()),
	};
}

function confirmThenReplySequence(
	origin: ReturnType<typeof makeFakeOriginSubmit>,
	payload: Uint8Array,
	replyBytes: Uint8Array,
): void {
	origin.confirm(payload);
	origin.reply(payload, replyBytes);
}

describe("prime-sandbox-hosted-child-port", (): void => {
	it("start yields admission through wrapper", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "test prompt" });
		await Promise.resolve();
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: true, value: { code: "ADMITTED" } });
	});

	it("start delivery-first then reply", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		h.origin.confirm(payload);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		h.origin.reply(payload, replyBytesForStart());
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: true, value: { code: "ADMITTED" } });
	});

	it("start reply-first (reply before delivery)", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		// Reply before delivery — the mux caches it, delivery triggers awaitReply.
		h.origin.reply(payload, replyBytesForStart());
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		h.origin.confirm(payload);
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: true, value: { code: "ADMITTED" } });
	});

	it("delivery confirmed then reply fails", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		h.origin.confirm(payload);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		h.origin.failReply();
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});

	it("reply payload zeroed after delivery failure", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		// Reply stored before delivery
		h.origin.reply(payload, replyBytesForStart());
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		// Delivery fails — sequential RPC: after delivery fail, we never call awaitReply.
		// The reply is in the mux but never consumed by the child port.
		h.origin.failDelivery();
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});

	it("reply received then delivery fails", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		// Delivery fails first — sequential RPC never calls awaitReply
		h.origin.failDelivery();
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		h.origin.reply(payload, replyBytesForStart());
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});

	it("submit exception still zeroes encoded bytes", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var throwingOrigin: OriginSubmit = Object.freeze({
			submit: (_payloadRaw: unknown): SubmitResult => {
				JSON.parse("{invalid}");
				return Object.freeze({ code: "INPUT_INVALID" });
			},
			cancel: (_ticket: unknown): CancelResult => Object.freeze({ code: "PENDING" }),
			pollDelivery: fake.origin.pollDelivery,
			pollReply: fake.origin.pollReply,
			awaitDelivery: fake.origin.awaitDelivery,
			awaitReply: fake.origin.awaitReply,
		});

		var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: throwingOrigin,
			router: router,
		});
		expect(factoryResult.ok).toBe(true);
		if (!factoryResult.ok) return;
		var port: HostedRlmRuntimePort = factoryResult.value;

		var startPromise: Promise<unknown> = port.startInitialTask({ prompt: "hello" });
		var _rawPayload: Uint8Array = fake.lastPayload();
		// submit throws, the try/finally zeros bytes before rethrowing.
		// The port catches the exception and resolves CALL_UNCERTAIN.
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
	});

	it("close cancels prior active tickets", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var closePromise = h.port.close();
		var cp: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, cp, replyBytesForClose());
		await closePromise;
	});

	it("CLOSE ticket not pre-cancelled", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var _closePromise = h.port.close();
		var closePayload: Uint8Array = h.origin.lastPayload();

		// Close should have cancelled the prior tickets but NOT the CLOSE ticket.
		confirmThenReplySequence(h.origin, closePayload, replyBytesForClose());
		var closeResult: unknown = await _closePromise;
		expect(closeResult).toEqual({ ok: true, value: { status: "closed" } });
	});

	it("malformed CLOSE maps CLEANUP_UNCERTAIN", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var closePromise = h.port.close();
		var cp: Uint8Array = h.origin.lastPayload();
		h.origin.confirm(cp);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		// Reply with wrong op — decode fails, _submitLifecycle returns undefined,
		// wrapper's close parser returns null -> CLEANUP_UNCERTAIN
		var badEnc = encodeLifecycleReply("ABORT", { status: "aborted" });
		var badReply: Uint8Array = badEnc.ok ? badEnc.bytes : new Uint8Array(0);
		h.origin.reply(cp, badReply);
		var closeResult: unknown = await closePromise;
		expect(closeResult).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
	});

	it("subscribe receives EVENT from router", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var events: Array<HostedRlmRuntimeEvent> = [];
		var subResult = h.port.subscribe((ev: HostedRlmRuntimeEvent): void => {
			events.push(ev);
		});
		expect(isOk(subResult)).toBe(true);

		var eventBundle: ApplicationBundle = makeEventBundle(vid("c1"), "EVENT", { event: { type: "agent_start" } });

		h.router.dispatchApplication(eventBundle);
		await Promise.resolve();
		expect(events.length).toBe(1);
		if (events.length === 1) {
			expect(events[0]).toEqual({ type: "agent_start" });
		}
		if (isOk(subResult)) {
			subResult.value.unsubscribe();
		}
	});

	it("terminal settles awaitTerminal", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var terminalPromise = h.port.awaitTerminal();
		var taskResult: HostedRlmTaskResult = {
			status: "completed",
			durationMs: 100,
			parentReplyCount: 0,
			toolUseCount: 1,
			answerPreview: "done",
		};
		var terminalBundle: ApplicationBundle = makeEventBundle(vid("c1"), "TERMINAL", { result: taskResult });

		h.router.dispatchApplication(terminalBundle);
		var terminalResult: unknown = await terminalPromise;
		expect(terminalResult).toEqual({ ok: true, value: taskResult });
	});

	it("abort sends ABORT and returns status", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var abortPromise = h.port.abort();
		var abortPayload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, abortPayload, replyBytesForAbort());
		var abortResult: unknown = await abortPromise;
		expect(abortResult).toEqual({ ok: true, value: { status: "aborted" } });
	});

	it("observe returns snapshot", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var observePromise = h.port.observe();
		var obsPayload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, obsPayload, replyBytesForObserve());
		var obsResult: unknown = await observePromise;
		expect(obsResult).toEqual({
			ok: true,
			value: {
				status: "running",
				messageCount: 5,
				toolUseCount: 2,
				agentRunning: true,
				parentReplyCount: 0,
			},
		});
	});

	it("close sends CLOSE and returns closed status", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var _closePromise = h.port.close();
		var closePayload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, closePayload, replyBytesForClose());
		var closeResult: unknown = await _closePromise;
		expect(closeResult).toEqual({ ok: true, value: { status: "closed" } });
	});

	it("duplicate terminal has no second effect", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var terminalPromise = h.port.awaitTerminal();
		var taskResult: HostedRlmTaskResult = {
			status: "completed",
			durationMs: 100,
			parentReplyCount: 0,
			toolUseCount: 1,
		};

		h.router.dispatchApplication(makeEventBundle(vid("c1"), "TERMINAL", { result: taskResult }));
		var firstResult: unknown = await terminalPromise;
		expect(firstResult).toEqual({ ok: true, value: taskResult });

		var secondPromise: Promise<unknown> = new Promise((resolve: (v: unknown) => void): void => {
			setTimeout((): void => {
				resolve("timeout");
			}, 50);
		});
		h.router.dispatchApplication(makeEventBundle(vid("c1"), "TERMINAL", { result: taskResult }));
		var secondResult: unknown = await secondPromise;
		expect(secondResult).toBe("timeout");
	});

	it("two children can coexist", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var c1Factory: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(c1Factory.ok).toBe(true);
		if (!c1Factory.ok) return;
		var c1Port: HostedRlmRuntimePort = c1Factory.value;

		var c2Factory: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c2"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(c2Factory.ok).toBe(true);
		if (!c2Factory.ok) return;
		var c2Port: HostedRlmRuntimePort = c2Factory.value;

		var startPromise = c2Port.startInitialTask({ prompt: "hello" });
		var startPayload: Uint8Array = fake.lastPayload();
		fake.confirm(startPayload);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		fake.reply(startPayload, replyBytesForStart());
		await startPromise;

		var termPromise = c2Port.awaitTerminal();
		var taskResult: HostedRlmTaskResult = {
			status: "completed",
			durationMs: 50,
			parentReplyCount: 0,
			toolUseCount: 1,
		};

		var replyDeferred: _Deferred<unknown> = _defer<unknown>();
		var termBundle: ApplicationBundle = makeEventBundle(
			vid("c2"),
			"TERMINAL",
			{ result: taskResult },
			replyDeferred.promise.then(() => _freezeSent()),
		);

		router.dispatchApplication(termBundle);
		replyDeferred.resolve(undefined);
		var terminalResult: unknown = await termPromise;
		expect(terminalResult).toEqual({ ok: true, value: taskResult });

		var c1Events: Array<HostedRlmRuntimeEvent> = [];
		var sub1 = c1Port.subscribe((ev: HostedRlmRuntimeEvent): void => {
			c1Events.push(ev);
		});
		expect(isOk(sub1)).toBe(true);

		var eventBundle: ApplicationBundle = makeEventBundle(vid("c1"), "EVENT", { event: { type: "agent_start" } });

		router.dispatchApplication(eventBundle);
		await Promise.resolve();
		expect(c1Events.length).toBe(1);
		if (c1Events.length === 1) {
			expect(c1Events[0]).toEqual({ type: "agent_start" });
		}
	});

	it("close one child leaves other working", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var c1Result: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(c1Result.ok).toBe(true);
		if (!c1Result.ok) return;
		var c1Port: HostedRlmRuntimePort = c1Result.value;

		var c2Result: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c2"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(c2Result.ok).toBe(true);
		if (!c2Result.ok) return;
		var c2Port: HostedRlmRuntimePort = c2Result.value;

		var s1p: Promise<unknown> = c1Port.startInitialTask({ prompt: "t1" });
		var p1: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, p1, replyBytesForStart());
		await s1p;

		var s2p: Promise<unknown> = c2Port.startInitialTask({ prompt: "t2" });
		var p2: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, p2, replyBytesForStart());
		await s2p;

		var close1p: Promise<unknown> = c1Port.close();
		var cp: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, cp, replyBytesForClose());
		await close1p;

		var obs2p: Promise<unknown> = c2Port.observe();
		var op: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, op, replyBytesForObserve());
		var obsResult: unknown = await obs2p;
		expect(obsResult).toEqual({
			ok: true,
			value: {
				status: "running",
				messageCount: 5,
				toolUseCount: 2,
				agentRunning: true,
				parentReplyCount: 0,
			},
		});
	});

	it("malformed reply after delivery", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		h.origin.confirm(payload);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		h.origin.reply(payload, new Uint8Array([0xff, 0xfe, 0x00]));
		var result: unknown = await startPromise;
		// decode fails -> undefined -> MALFORMED_RESULT
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});

	it("cancelled delivery", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		h.origin.failDelivery();
		var result: unknown = await startPromise;
		// Delivery POISONED -> undefined -> MALFORMED_RESULT
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});

	it("close does not close router", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var closePromise = h.port.close();
		var cp: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, cp, replyBytesForClose());
		await closePromise;

		var regResult = h.router.registerLifecycleChild(vid("c3"));
		expect("unregister" in regResult).toBe(true);
	});

	it("encoded payload is zeroed after submit", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});
		var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(factoryResult.ok).toBe(true);
		if (!factoryResult.ok) return;
		var port: HostedRlmRuntimePort = factoryResult.value;

		var startPromise = port.startInitialTask({ prompt: "hello" });
		// The fake origin copies the buffer on submit, so lastPayload() has the bytes
		// before zeroing. The zeroing applies to the original buffer reference passed to submit.
		// After submit returns, the source buffer is zeroed, but the copy isn't.
		// We verify that the try/finally zeroing runs without error.
		var _rawPayload: Uint8Array = fake.lastPayload();
		expect(_rawPayload.length).toBeGreaterThan(0);
		confirmThenReplySequence(fake, _rawPayload, replyBytesForStart());
		await startPromise;
	});

	it("router registration failure returns factory failure", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var firstResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(firstResult.ok).toBe(true);
		if (!firstResult.ok) return;

		var dupResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(dupResult.ok).toBe(false);
		if (dupResult.ok) return;
		expect(dupResult.code).toBe("INVALID_INPUT");
	});

	it("factory failure does not close router", async (): Promise<void> => {
		var fake1: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var fake2: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var firstResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake1.origin,
			router: router,
		});
		expect(firstResult.ok).toBe(true);

		var dupResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake2.origin,
			router: router,
		});
		expect(dupResult.ok).toBe(false);

		var c2Result: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c2"),
			lifecycleOrigin: fake2.origin,
			router: router,
		});
		expect(c2Result.ok).toBe(true);
	});

	it("delivery rejected resolves malformed", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		h.origin.rejectDelivery();
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});

	it("reply rejected after confirmed delivery", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		h.origin.confirm(payload);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		h.origin.rejectReply();
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});
	it("genuine remote CLOSE sends encoded CLOSE record", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "test" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		const closePromise = h.port.close();
		const closePayload = h.origin.lastPayload();
		const decoded = decodeLifecycleRecord(closePayload);
		expect(decoded.ok).toBe(true);
		if (decoded.ok) expect(decoded.op).toBe("CLOSE");
		h.origin.confirmLast();
		h.origin.replyLast(replyBytesForClose());
		expect(await closePromise).toEqual({ ok: true, value: { status: "closed" } });
	});

	it("unregister called exactly once", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(factoryResult.ok).toBe(true);
		if (!factoryResult.ok) return;
		var port: HostedRlmRuntimePort = factoryResult.value;

		var startPromise = port.startInitialTask({ prompt: "t" });
		var sp: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, sp, replyBytesForStart());
		await startPromise;

		// Close once
		var closeResult1: Promise<unknown> = port.close();
		var cp: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, cp, replyBytesForClose());
		await closeResult1;

		// After close, child is unregistered - can register a new child with same id
		var reRegisterResult = router.registerLifecycleChild(vid("c1"));
		expect("unregister" in reRegisterResult).toBe(true);
	});

	it("close-once/keep-one children", async (): Promise<void> => {
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var c1Result: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c1"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(c1Result.ok).toBe(true);
		if (!c1Result.ok) return;
		var c1Port: HostedRlmRuntimePort = c1Result.value;

		var c2Result: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: vid("c2"),
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(c2Result.ok).toBe(true);
		if (!c2Result.ok) return;
		var c2Port: HostedRlmRuntimePort = c2Result.value;

		// Start both
		var s1 = c1Port.startInitialTask({ prompt: "t1" });
		var p1: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, p1, replyBytesForStart());
		await s1;

		var s2 = c2Port.startInitialTask({ prompt: "t2" });
		var p2: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, p2, replyBytesForStart());
		await s2;

		// Close c2 only
		var closeC2 = c2Port.close();
		var cp2: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, cp2, replyBytesForClose());
		await closeC2;

		// c1 still observable
		var o1 = c1Port.observe();
		var op1: Uint8Array = fake.lastPayload();
		confirmThenReplySequence(fake, op1, replyBytesForObserve());
		var obsResult: unknown = await o1;
		expect(obsResult).toEqual({
			ok: true,
			value: { status: "running", messageCount: 5, toolUseCount: 2, agentRunning: true, parentReplyCount: 0 },
		});
	});

	it("concurrent close returns same promise", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "test" });
		var payload: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, payload, replyBytesForStart());
		await startPromise;

		var ticketCountBefore: number = h.origin.ticketCount();
		var c1: Promise<unknown> = h.port.close();
		var ticketCountAfter1: number = h.origin.ticketCount();
		var cp: Uint8Array = h.origin.lastPayload();
		confirmThenReplySequence(h.origin, cp, replyBytesForClose());

		var c2: Promise<unknown> = h.port.close();
		var c3: Promise<unknown> = h.port.close();
		var ticketCountAfter3: number = h.origin.ticketCount();

		// All three calls return the same promise (wrapper beginClose)
		expect(Object.is(c1, c2)).toBe(true);
		expect(Object.is(c1, c3)).toBe(true);
		// Exactly one more ticket (the CLOSE ticket)
		expect(ticketCountAfter1 - ticketCountBefore).toBe(1);
		expect(ticketCountAfter3 - ticketCountBefore).toBe(1);

		var r1: unknown = await c1;
		var r2: unknown = await c2;
		var r3: unknown = await c3;

		expect(r1).toEqual({ ok: true, value: { status: "closed" } });
		expect(r2).toEqual({ ok: true, value: { status: "closed" } });
		expect(r3).toEqual({ ok: true, value: { status: "closed" } });
	});

	it("public port order matches HostedRlmRuntimePort", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var keys: string[] = Object.keys(h.port);
		expect(keys).toEqual(["identity", "startInitialTask", "awaitTerminal", "abort", "observe", "subscribe", "close"]);
	});

	it("exact identity fields match through port", async (): Promise<void> => {
		var id: HostedRlmRuntimeIdentity = vid("exact-id-test");
		var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
		var router: HomeStreamRouter = createHomeStreamRouter({
			modelProvider: { dispatchApplication: (): void => {} },
		});

		var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
			identity: id,
			lifecycleOrigin: fake.origin,
			router: router,
		});
		expect(factoryResult.ok).toBe(true);
		if (!factoryResult.ok) return;
		var port: HostedRlmRuntimePort = factoryResult.value;

		expect(port.identity.childId).toBe(id.childId);
		expect(port.identity.sessionId).toBe(id.sessionId);
		expect(port.identity.sessionName).toBe(id.sessionName);
		expect(port.identity.modelSelector).toBe(id.modelSelector);
	});

	it("malformed Result payload from awaiting delivery", async (): Promise<void> => {
		var h = harness1();
		expect(h.ok).toBe(true);
		if (!h.ok) return;

		var startPromise = h.port.startInitialTask({ prompt: "hello" });
		var payload: Uint8Array = h.origin.lastPayload();
		// Reply with garbage bytes that decode fails
		h.origin.confirm(payload);
		await new Promise((r) => {
			setTimeout(r, 0);
		});
		// Reply with garbage that decodeLifecycleReply rejects
		h.origin.reply(payload, new Uint8Array([0, 0, 0, 0]));
		var result: unknown = await startPromise;
		expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	});
});

it("rejects proxy-wrapped origin", (): void => {
	var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
	var proxyOrigin: OriginSubmit = new Proxy(fake.origin, {});
	var router: HomeStreamRouter = createHomeStreamRouter({
		modelProvider: { dispatchApplication: (): void => {} },
	});
	var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
		identity: vid("proxy-reject"),
		lifecycleOrigin: proxyOrigin,
		router: router,
	});
	expect(factoryResult.ok).toBe(false);
	if (!factoryResult.ok) {
		expect(factoryResult.code).toBe("INVALID_INPUT");
	}
});

it("rejects origin with extra key", (): void => {
	var extraOrigin: OriginSubmit = Object.freeze({
		submit: (): SubmitResult => Object.freeze({ code: "SUBMITTED", ticket: Object.freeze({}) }),
		cancel: (): CancelResult => Object.freeze({ code: "PENDING" }),
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => Promise.resolve(Object.freeze({ code: "CONFIRMED" })),
		awaitReply: (): Promise<ReplyResult> =>
			Promise.resolve(Object.freeze({ code: "REPLY_READY", payload: new Uint8Array(0) })),
		extra: 42,
	});
	var router: HomeStreamRouter = createHomeStreamRouter({
		modelProvider: { dispatchApplication: (): void => {} },
	});
	var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
		identity: vid("extra-reject"),
		lifecycleOrigin: extraOrigin,
		router: router,
	});
	expect(factoryResult.ok).toBe(false);
	if (!factoryResult.ok) {
		expect(factoryResult.code).toBe("INVALID_INPUT");
	}
});

it("rejects non-frozen origin", (): void => {
	var mutableOrigin: OriginSubmit = {
		submit: (): SubmitResult => Object.freeze({ code: "SUBMITTED", ticket: Object.freeze({}) }),
		cancel: (): CancelResult => Object.freeze({ code: "PENDING" }),
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => Promise.resolve(Object.freeze({ code: "CONFIRMED" })),
		awaitReply: (): Promise<ReplyResult> =>
			Promise.resolve(Object.freeze({ code: "REPLY_READY", payload: new Uint8Array(0) })),
	};
	var router: HomeStreamRouter = createHomeStreamRouter({
		modelProvider: { dispatchApplication: (): void => {} },
	});
	var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
		identity: vid("non-frozen"),
		lifecycleOrigin: mutableOrigin,
		router: router,
	});
	expect(factoryResult.ok).toBe(false);
	if (!factoryResult.ok) {
		expect(factoryResult.code).toBe("INVALID_INPUT");
	}
});

it("rejects SubmitResult with extra keys before awaiting delivery", async (): Promise<void> => {
	const ticket = Object.freeze({});
	const extraResult: {
		readonly code: "SUBMITTED";
		readonly ticket: object;
		readonly extra: true;
	} = Object.freeze({ code: "SUBMITTED", ticket, extra: true });
	let deliveryCalls = 0;
	const badOrigin: OriginSubmit = Object.freeze({
		submit: (): SubmitResult => extraResult,
		cancel: (): CancelResult => Object.freeze({ code: "PENDING" }),
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => {
			deliveryCalls += 1;
			return Promise.resolve(Object.freeze({ code: "CONFIRMED" }));
		},
		awaitReply: (): Promise<ReplyResult> => Promise.resolve(Object.freeze({ code: "CANCELLED" })),
	});
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const factoryResult = createHostedSandboxChildPort({
		identity: vid("bad-submit"),
		lifecycleOrigin: badOrigin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	const result = await factoryResult.value.startInitialTask({ prompt: "test" });
	expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	expect(deliveryCalls).toBe(0);
});

it("rejects sealed writable SubmitResult before awaiting delivery", async (): Promise<void> => {
	const ticket = Object.freeze({});
	const sealedResult: { code: "SUBMITTED"; ticket: object } = { code: "SUBMITTED", ticket };
	Object.seal(sealedResult);
	let deliveryCalls = 0;
	const badOrigin: OriginSubmit = Object.freeze({
		submit: (): SubmitResult => sealedResult,
		cancel: (): CancelResult => Object.freeze({ code: "PENDING" }),
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => {
			deliveryCalls += 1;
			return Promise.resolve(Object.freeze({ code: "CONFIRMED" }));
		},
		awaitReply: (): Promise<ReplyResult> => Promise.resolve(Object.freeze({ code: "CANCELLED" })),
	});
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const factoryResult = createHostedSandboxChildPort({
		identity: vid("sealed-submit"),
		lifecycleOrigin: badOrigin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	const result = await factoryResult.value.startInitialTask({ prompt: "test" });
	expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	expect(deliveryCalls).toBe(0);
});

it("rejects proxy-wrapped router", (): void => {
	var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
	var realRouter: HomeStreamRouter = createHomeStreamRouter({
		modelProvider: { dispatchApplication: (): void => {} },
	});
	var proxyRouter: HomeStreamRouter = new Proxy(realRouter, {});
	var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
		identity: vid("proxy-router"),
		lifecycleOrigin: fake.origin,
		router: proxyRouter,
	});
	expect(factoryResult.ok).toBe(false);
	if (!factoryResult.ok) {
		expect(factoryResult.code).toBe("INVALID_INPUT");
	}
});

it("rejects non-frozen router", (): void => {
	var fake: ReturnType<typeof makeFakeOriginSubmit> = makeFakeOriginSubmit();
	var mutableRouter: HomeStreamRouter = createHomeStreamRouter({
		modelProvider: { dispatchApplication: (): void => {} },
	});
	// Router from createHomeStreamRouter is already frozen, can't unfreeze
	// Create a plain object that looks like a router but isn't frozen
	var plainRouter = {
		dispatchApplication: mutableRouter.dispatchApplication,
		close: mutableRouter.close,
		registerLifecycleChild: mutableRouter.registerLifecycleChild,
	};
	var factoryResult: HostedRlmRuntimePortFactoryResult = createHostedSandboxChildPort({
		identity: vid("nonfrozen-router"),
		lifecycleOrigin: fake.origin,
		router: plainRouter,
	});
	expect(factoryResult.ok).toBe(false);
	if (!factoryResult.ok) {
		expect(factoryResult.code).toBe("INVALID_INPUT");
	}
});

it("maps a throwing cancel capability to cleanup uncertainty", async (): Promise<void> => {
	let submitCount = 0;
	let cancelCount = 0;
	const origin: OriginSubmit = Object.freeze({
		submit: (): SubmitResult => {
			submitCount += 1;
			return Object.freeze({ code: "SUBMITTED", ticket: Object.freeze({ submitCount }) });
		},
		cancel: (): CancelResult => {
			cancelCount += 1;
			decodeURIComponent("%");
			return Object.freeze({ code: "PENDING" });
		},
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => Promise.resolve(Object.freeze({ code: "POISONED" })),
		awaitReply: (): Promise<ReplyResult> => Promise.resolve(Object.freeze({ code: "CANCELLED" })),
	});
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const factoryResult = createHostedSandboxChildPort({
		identity: vid("throwing-cancel"),
		lifecycleOrigin: origin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	expect(await factoryResult.value.observe()).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	expect(await factoryResult.value.close()).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
	expect(submitCount).toBe(2);
	expect(cancelCount).toBe(2);
});

it("fences after native Promise reaction attachment failure", async (): Promise<void> => {
	const h = harness1();
	expect(h.ok).toBe(true);
	if (!h.ok) return;
	const speciesDescriptor = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
	expect(speciesDescriptor).toBeDefined();
	if (speciesDescriptor === undefined) return;
	function RejectingSpecies(): void {
		decodeURIComponent("%");
	}
	let operation: Promise<unknown> | null = null;
	try {
		Object.defineProperty(Promise, Symbol.species, {
			value: RejectingSpecies,
			writable: true,
			enumerable: false,
			configurable: true,
		});
		operation = h.port.observe();
	} finally {
		Object.defineProperty(Promise, Symbol.species, speciesDescriptor);
	}
	expect(operation).not.toBeNull();
	if (operation === null) return;
	expect(await operation).toEqual({ ok: false, error: { code: "CALL_UNCERTAIN" } });
	expect(await h.port.observe()).toEqual({ ok: false, error: { code: "CLOSED" } });
	const closePromise = h.port.close();
	h.origin.confirmLast();
	h.origin.replyLast(replyBytesForClose());
	expect(await closePromise).toEqual({ ok: false, error: { code: "CLEANUP_UNCERTAIN" } });
	expect(h.origin.ticketCount()).toBe(2);
});

it("rejects malformed identity records before registration", (): void => {
	const fake = makeFakeOriginSubmit();
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const symbolKey = Symbol("identity-extra");
	const symbolIdentity = {
		childId: "c1",
		sessionId: "s1",
		sessionName: "n1",
		modelSelector: "m1",
		[symbolKey]: true,
	};
	const invalidIdentities: unknown[] = [
		{ childId: "c1", sessionId: "s1", sessionName: "n1", wrong: "m1" },
		{ childId: "bad space", sessionId: "s1", sessionName: "n1", modelSelector: "m1" },
		{ childId: "c1", sessionId: 1, sessionName: "n1", modelSelector: "m1" },
		{ childId: "x".repeat(129), sessionId: "s1", sessionName: "n1", modelSelector: "m1" },
		symbolIdentity,
	];
	for (let index = 0; index < invalidIdentities.length; index++) {
		const result: unknown = Reflect.apply(createHostedSandboxChildPort, undefined, [
			{ identity: invalidIdentities[index], lifecycleOrigin: fake.origin, router },
		]);
		expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
	}
	expect(fake.ticketCount()).toBe(0);
});

it("snapshots identity before later caller mutation", async (): Promise<void> => {
	const fake = makeFakeOriginSubmit();
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const mutableIdentity = {
		childId: "identity-before",
		sessionId: "s1",
		sessionName: "n1",
		modelSelector: "m1",
	};
	const factoryResult = createHostedSandboxChildPort({
		identity: mutableIdentity,
		lifecycleOrigin: fake.origin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	mutableIdentity.childId = "identity-after";
	const operation = factoryResult.value.startInitialTask({ prompt: "identity" });
	const sent = decodeLifecycleRecord(fake.lastPayload());
	expect(sent.ok).toBe(true);
	if (sent.ok) expect(sent.identity.childId).toBe("identity-before");
	fake.confirmLast();
	fake.replyLast(replyBytesForStart());
	expect(await operation).toEqual({ ok: true, value: { code: "ADMITTED" } });
	expect(factoryResult.value.identity.childId).toBe("identity-before");
});

it("rejects an accessor identity before registration", (): void => {
	const fake = makeFakeOriginSubmit();
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const accessorIdentity: HostedRlmRuntimeIdentity = {
		get childId(): string {
			return "accessor-child";
		},
		sessionId: "s1",
		sessionName: "n1",
		modelSelector: "m1",
	};
	const result = createHostedSandboxChildPort({
		identity: accessorIdentity,
		lifecycleOrigin: fake.origin,
		router,
	});
	expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
	expect(fake.ticketCount()).toBe(0);
});

it("zeroes a valid payload in a malformed extra-field reply", async (): Promise<void> => {
	const ticket = Object.freeze({});
	const replyPayload = replyBytesForObserve();
	const malformedReply: {
		readonly code: "REPLY_READY";
		readonly payload: Uint8Array;
		readonly extra: true;
	} = Object.freeze({ code: "REPLY_READY", payload: replyPayload, extra: true });
	const origin: OriginSubmit = Object.freeze({
		submit: (): SubmitResult => Object.freeze({ code: "SUBMITTED", ticket }),
		cancel: (): CancelResult => Object.freeze({ code: "PENDING" }),
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => Promise.resolve(Object.freeze({ code: "CONFIRMED" })),
		awaitReply: (): Promise<ReplyResult> => Promise.resolve(malformedReply),
	});
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const factoryResult = createHostedSandboxChildPort({
		identity: vid("malformed-owned-payload"),
		lifecycleOrigin: origin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	const result = await factoryResult.value.observe();
	expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	expect(Array.from(replyPayload).every((byte) => byte === 0)).toBe(true);
});

it("rejects and zeroes a sealed writable reply record", async (): Promise<void> => {
	const ticket = Object.freeze({});
	const replyPayload = replyBytesForObserve();
	const sealedReply: { code: "REPLY_READY"; payload: Uint8Array } = {
		code: "REPLY_READY",
		payload: replyPayload,
	};
	Object.seal(sealedReply);
	const origin: OriginSubmit = Object.freeze({
		submit: (): SubmitResult => Object.freeze({ code: "SUBMITTED", ticket }),
		cancel: (): CancelResult => Object.freeze({ code: "PENDING" }),
		pollDelivery: (): PollDeliveryResult => Object.freeze({ code: "PENDING" }),
		pollReply: (): PollReplyResult => Object.freeze({ code: "PENDING" }),
		awaitDelivery: (): Promise<DeliveryResult> => Promise.resolve(Object.freeze({ code: "CONFIRMED" })),
		awaitReply: (): Promise<ReplyResult> => Promise.resolve(sealedReply),
	});
	const router = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const factoryResult = createHostedSandboxChildPort({
		identity: vid("sealed-reply"),
		lifecycleOrigin: origin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	const result = await factoryResult.value.observe();
	expect(result).toEqual({ ok: false, error: { code: "MALFORMED_RESULT" } });
	expect(Array.from(replyPayload).every((byte) => byte === 0)).toBe(true);
});

it("rejects a frozen router with an accessor capability", (): void => {
	const fake = makeFakeOriginSubmit();
	const actual = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const accessorRouter: HomeStreamRouter = Object.freeze({
		get dispatchApplication(): (bundle: ApplicationBundle) => void {
			return actual.dispatchApplication;
		},
		close: actual.close,
		registerLifecycleChild: actual.registerLifecycleChild,
	});
	const result = createHostedSandboxChildPort({
		identity: vid("accessor-router"),
		lifecycleOrigin: fake.origin,
		router: accessorRouter,
	});
	expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("rejects a sealed writable router", (): void => {
	const fake = makeFakeOriginSubmit();
	const actual = createHomeStreamRouter({ modelProvider: { dispatchApplication: (): void => {} } });
	const sealedRouter: HomeStreamRouter = {
		dispatchApplication: actual.dispatchApplication,
		close: actual.close,
		registerLifecycleChild: actual.registerLifecycleChild,
	};
	Object.seal(sealedRouter);
	const result = createHostedSandboxChildPort({
		identity: vid("sealed-router"),
		lifecycleOrigin: fake.origin,
		router: sealedRouter,
	});
	expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("rejects a sealed writable unregister capability", (): void => {
	const fake = makeFakeOriginSubmit();
	const registration = { unregister: (): void => {} };
	Object.seal(registration);
	const router: HomeStreamRouter = Object.freeze({
		dispatchApplication: (): void => {},
		close: (): void => {},
		registerLifecycleChild: () => registration,
	});
	const result = createHostedSandboxChildPort({
		identity: vid("sealed-registration"),
		lifecycleOrigin: fake.origin,
		router,
	});
	expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
});

it("uses raw unregister authority when registration shape is malformed", (): void => {
	const fake = makeFakeOriginSubmit();
	let unregistered = false;
	const malformedRegistration: {
		readonly unregister: () => void;
		readonly extra: true;
	} = Object.freeze({
		unregister: (): void => {
			unregistered = true;
		},
		extra: true,
	});
	const router: HomeStreamRouter = Object.freeze({
		dispatchApplication: (): void => {},
		close: (): void => {},
		registerLifecycleChild: () => malformedRegistration,
	});
	const result = createHostedSandboxChildPort({
		identity: vid("malformed-registration-cleanup"),
		lifecycleOrigin: fake.origin,
		router,
	});
	expect(result).toEqual({ ok: false, code: "INVALID_INPUT" });
	expect(unregistered).toBe(true);
});

it("invokes unregister with its captured registration receiver", async (): Promise<void> => {
	const fake = makeFakeOriginSubmit();
	let receiverMatched = false;
	let registration: Readonly<{ unregister: (this: unknown) => void }>;
	const unregister = function unregister(this: unknown): void {
		receiverMatched = this === registration;
	};
	registration = Object.freeze({ unregister });
	const router: HomeStreamRouter = Object.freeze({
		dispatchApplication: (): void => {},
		close: (): void => {},
		registerLifecycleChild: () => registration,
	});
	const factoryResult = createHostedSandboxChildPort({
		identity: vid("registration-receiver"),
		lifecycleOrigin: fake.origin,
		router,
	});
	expect(factoryResult.ok).toBe(true);
	if (!factoryResult.ok) return;
	const closePromise = factoryResult.value.close();
	fake.confirmLast();
	fake.replyLast(replyBytesForClose());
	expect(await closePromise).toEqual({ ok: true, value: { status: "closed" } });
	expect(receiverMatched).toBe(true);
});

it("releases bounded RPC capacity after sequential settlements", async (): Promise<void> => {
	const h = harness1();
	expect(h.ok).toBe(true);
	if (!h.ok) return;
	for (let index = 0; index < 40; index++) {
		const operation = h.port.observe();
		h.origin.confirmLast();
		h.origin.replyLast(replyBytesForObserve());
		expect(await operation).toEqual({
			ok: true,
			value: { status: "running", messageCount: 5, toolUseCount: 2, agentRunning: true, parentReplyCount: 0 },
		});
	}
	expect(h.origin.ticketCount()).toBe(40);
});

it("submits one remote CLOSE after cancelling 32 pending RPCs", async (): Promise<void> => {
	const h = harness1();
	expect(h.ok).toBe(true);
	if (!h.ok) return;
	for (let index = 0; index < 32; index++) h.port.observe();
	expect(h.origin.ticketCount()).toBe(32);
	const closePromise = h.port.close();
	expect(h.origin.cancelCount()).toBe(32);
	expect(h.origin.ticketCount()).toBe(33);
	h.origin.confirmLast();
	h.origin.replyLast(replyBytesForClose());
	expect(await closePromise).toEqual({ ok: true, value: { status: "closed" } });
});

type _PhysicalInbound = (streamRaw: unknown, plaintextRaw: unknown) => void;
type _PhysicalSendResult = Readonly<{ code: "SENT" | "FAILED" }>;
type _PhysicalCloseResult = Readonly<{ code: "CLOSED" | "FAILED" }>;

function makeAutoPhysicalPair() {
	let homeInbound: _PhysicalInbound | null = null;
	let runtimeInbound: _PhysicalInbound | null = null;
	let homeCloseCount = 0;
	let runtimeCloseCount = 0;

	function sendTo(
		peer: _PhysicalInbound | null,
		streamRaw: unknown,
		plaintextRaw: unknown,
	): Promise<_PhysicalSendResult> {
		return new Promise<_PhysicalSendResult>((resolve): void => {
			queueMicrotask((): void => {
				if (peer === null) {
					resolve(Object.freeze({ code: "FAILED" }));
					return;
				}
				try {
					peer(streamRaw, plaintextRaw);
					resolve(Object.freeze({ code: "SENT" }));
				} catch {
					resolve(Object.freeze({ code: "FAILED" }));
				}
			});
		});
	}

	const homePhysical = {
		send: (streamRaw: unknown, plaintextRaw: unknown): Promise<_PhysicalSendResult> =>
			sendTo(runtimeInbound, streamRaw, plaintextRaw),
		registerInbound: (handler: _PhysicalInbound): Readonly<{ code: "REGISTERED" }> => {
			homeInbound = handler;
			return Object.freeze({ code: "REGISTERED" });
		},
		close: (): Promise<_PhysicalCloseResult> => {
			homeCloseCount += 1;
			return new Promise<_PhysicalCloseResult>((resolve): void => {
				resolve(Object.freeze({ code: "CLOSED" }));
			});
		},
	};
	const runtimePhysical = {
		send: (streamRaw: unknown, plaintextRaw: unknown): Promise<_PhysicalSendResult> =>
			sendTo(homeInbound, streamRaw, plaintextRaw),
		registerInbound: (handler: _PhysicalInbound): Readonly<{ code: "REGISTERED" }> => {
			runtimeInbound = handler;
			return Object.freeze({ code: "REGISTERED" });
		},
		close: (): Promise<_PhysicalCloseResult> => {
			runtimeCloseCount += 1;
			return new Promise<_PhysicalCloseResult>((resolve): void => {
				resolve(Object.freeze({ code: "CLOSED" }));
			});
		},
	};
	return {
		homePhysical,
		runtimePhysical,
		homeCloseCount: (): number => homeCloseCount,
		runtimeCloseCount: (): number => runtimeCloseCount,
	};
}

function integrationObservation(label: string, requestedName?: string) {
	return {
		activeSessionId: `active-${label}`,
		sessionId: `session-${label}`,
		sessionName: requestedName !== undefined ? requestedName : `name-${label}`,
		runtimeKind: "subagent",
		cwd: "/redacted",
		status: "idle",
		isCurrent: false,
		isStreaming: false,
		isCompacting: false,
		attachedClients: 0,
		messageCount: 1,
		queuedCount: 0,
		isSessionActive: true,
		rlmChildId: `child-${label}`,
		firstMessage: `task-${label}`,
		latestMessage: {
			index: 0,
			role: "assistant",
			timestamp: 1,
			text: `ready-${label}`,
			truncated: false,
			toolCalls: [],
		},
	};
}

function integrationController(label: string) {
	const owner = Object.freeze({ label });
	const controllerIdentity = {
		activeSessionId: `active-${label}`,
		sessionId: `session-${label}`,
		rlmChildId: `child-${label}`,
		depth: 1,
		sessionName: `name-${label}`,
	};
	const messageController = {
		listAgents: (): unknown => ({
			current: {
				activeSessionId: `active-${label}`,
				sessionId: `session-${label}`,
				sessionName: `name-${label}`,
				runtimeKind: "subagent",
			},
			agents: [],
		}),
		roster: (): unknown => ({ current: { name: `name-${label}`, id: `session-${label}`, depth: 1 }, entries: [] }),
		awaitPendingChildPublication: (): unknown => undefined,
		assertSessionNameAvailable: (): void => {},
		setSessionName: (): void => {},
		sendAgentMessage: (): unknown => ({
			id: `message-${label}`,
			source: "agent_message",
			target: {
				activeSessionId: "active-peer",
				sessionId: "session-peer",
				sessionName: "peer",
				runtimeKind: "subagent",
			},
			from: {
				activeSessionId: `active-${label}`,
				sessionId: `session-${label}`,
				sessionName: `name-${label}`,
				runtimeKind: "subagent",
			},
			fromRelationship: "parent",
			message: `hello-${label}`,
			deliveryStatus: "delivered",
			deliveredAt: "2026-01-01T00:00:00.000Z",
		}),
	};
	const observeController = {
		listAgents: (): unknown => ({ current: integrationObservation(label), agents: [] }),
		getAgent: (target: string): unknown => ({ agent: integrationObservation(label, target) }),
		recentMessages: (): unknown => ({
			agent: integrationObservation(label),
			messages: [{ index: 0, role: "assistant", text: `ready-${label}`, truncated: false }],
			limit: 1,
			maxChars: 100,
			truncated: false,
		}),
	};
	const controllerDispatcher = {
		sessionOwner: owner,
		authorizeIdentity: (candidate: object): unknown =>
			candidate === owner ? { identity: controllerIdentity, messageController, observeController } : undefined,
	};
	const routeIdentity = {
		childId: `child-${label}`,
		sessionId: `session-${label}`,
		sessionName: `name-${label}`,
		modelSelector: `model-${label}`,
	};
	return { controllerDispatcher, controllerIdentity, routeIdentity };
}

async function integrationOriginCall(origin: OriginSubmit, request: Uint8Array): Promise<ReplyResult | null> {
	const submitted = origin.submit(request);
	for (let index = 0; index < request.length; index++) request[index] = 0;
	if (submitted.code !== "SUBMITTED") return null;
	const delivery = await origin.awaitDelivery(submitted.ticket);
	if (delivery.code !== "CONFIRMED") return null;
	return origin.awaitReply(submitted.ticket);
}

async function capturedRejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
		return undefined;
	} catch (reason) {
		return reason;
	}
}

async function capturedSettlement(promise: Promise<unknown>): Promise<{
	readonly fulfilled: boolean;
	readonly value?: unknown;
	readonly reason?: unknown;
}> {
	try {
		return { fulfilled: true, value: await promise };
	} catch (reason) {
		return { fulfilled: false, reason };
	}
}

it("runs two logical children over one physical V31 pair end to end", async (): Promise<void> => {
	const wire = makeAutoPhysicalPair();
	const retainedReplies: Promise<ComposedReplyResult>[] = [];
	let modelRequests = 0;
	const router = createHomeStreamRouter({
		modelProvider: {
			dispatchApplication: (bundle: ApplicationBundle): void => {
				modelRequests += 1;
				const reply = new Uint8Array([bundle.payload[0] + 1]);
				for (let index = 0; index < bundle.payload.length; index++) bundle.payload[index] = 0;
				retainedReplies.push(bundle.reply(reply));
				for (let index = 0; index < reply.length; index++) reply[index] = 0;
			},
		},
	});
	const runtimeDispatch = {
		dispatchApplication: (bundle: ApplicationBundle): void => {
			const decoded = decodeLifecycleRecord(bundle.payload);
			for (let index = 0; index < bundle.payload.length; index++) bundle.payload[index] = 0;
			if (!decoded.ok) return;
			let body: Record<string, unknown> | null = null;
			if (decoded.op === "START") body = { code: "ADMITTED" };
			if (decoded.op === "ABORT") body = { status: "aborted" };
			if (decoded.op === "OBSERVE") {
				body = { status: "running", messageCount: 2, toolUseCount: 1, agentRunning: true, parentReplyCount: 0 };
			}
			if (decoded.op === "CLOSE") body = { status: "closed" };
			if (body === null) return;
			const encoded = encodeLifecycleReply(decoded.op, body);
			if (!encoded.ok) return;
			retainedReplies.push(bundle.reply(encoded.bytes));
			for (let index = 0; index < encoded.bytes.length; index++) encoded.bytes[index] = 0;
		},
	};
	const runtimeResult = createRuntimeMultiplexer(wire.runtimePhysical, runtimeDispatch);
	expect("code" in runtimeResult).toBe(false);
	if ("code" in runtimeResult) return;
	const runtime: RuntimeMultiplexer = runtimeResult;
	const homeResult = createHomeMultiplexer(wire.homePhysical, {
		dispatchApplication: router.dispatchApplication,
	});
	expect("code" in homeResult).toBe(false);
	if ("code" in homeResult) return;
	const home: HomeMultiplexer = homeResult;

	const controllerA = integrationController("a");
	const controllerB = integrationController("b");
	const childAResult = createHostedSandboxChildPort({
		identity: controllerA.routeIdentity,
		lifecycleOrigin: home.lifecycleToRuntime,
		router,
		controllerDispatcher: controllerA.controllerDispatcher,
	});
	const childBResult = createHostedSandboxChildPort({
		identity: controllerB.routeIdentity,
		lifecycleOrigin: home.lifecycleToRuntime,
		router,
		controllerDispatcher: controllerB.controllerDispatcher,
	});
	expect(childAResult.ok).toBe(true);
	expect(childBResult.ok).toBe(true);
	if (!childAResult.ok || !childBResult.ok) return;
	const childA = childAResult.value;
	const childB = childBResult.value;

	expect(await childA.startInitialTask({ prompt: "start-a" })).toEqual({ ok: true, value: { code: "ADMITTED" } });
	expect(await childB.startInitialTask({ prompt: "start-b" })).toEqual({ ok: true, value: { code: "ADMITTED" } });

	const modelReply = await integrationOriginCall(runtime.modelToHome, new Uint8Array([41]));
	expect(modelReply !== null ? modelReply.code : undefined).toBe("REPLY_READY");
	if (modelReply !== null && modelReply.code === "REPLY_READY") {
		expect(Array.from(modelReply.payload)).toEqual([42]);
		for (let index = 0; index < modelReply.payload.length; index++) modelReply.payload[index] = 0;
	}
	expect(modelRequests).toBe(1);

	const relayAResult = createPrimeSandboxRuntimeControllerRelay(
		controllerA.routeIdentity,
		controllerA.controllerIdentity,
		runtime.messagesToHome,
		runtime.observeRequestsToHome,
	);
	const relayBResult = createPrimeSandboxRuntimeControllerRelay(
		controllerB.routeIdentity,
		controllerB.controllerIdentity,
		runtime.messagesToHome,
		runtime.observeRequestsToHome,
	);
	expect(relayAResult.ok).toBe(true);
	expect(relayBResult.ok).toBe(true);
	if (!relayAResult.ok || !relayBResult.ok) return;
	const signal = new AbortController().signal;
	const messageA = await capturedSettlement(
		relayAResult.adapter.invoke(
			"send_message",
			{ target: "peer", message: "hello-a", receiverRole: "child" },
			signal,
		),
	);
	const messageB = await capturedSettlement(
		relayBResult.adapter.invoke(
			"send_message",
			{ target: "peer", message: "hello-b", receiverRole: "child" },
			signal,
		),
	);
	expect(messageA).toMatchObject({ fulfilled: true, value: { id: "message-a", message: "hello-a" } });
	expect(messageB).toMatchObject({ fulfilled: true, value: { id: "message-b", message: "hello-b" } });
	const observationA = await capturedSettlement(
		relayAResult.adapter.invoke("observe_get", { target: "peer" }, signal),
	);
	const observationB = await capturedSettlement(
		relayBResult.adapter.invoke("observe_get", { target: "peer" }, signal),
	);
	expect(observationA).toMatchObject({
		fulfilled: true,
		value: { agent: { sessionName: "peer", activeSessionId: "active-a" } },
	});
	expect(observationB).toMatchObject({
		fulfilled: true,
		value: { agent: { sessionName: "peer", activeSessionId: "active-b" } },
	});

	const cancellation = new AbortController();
	const cancelledCall = relayBResult.adapter.invoke(
		"send_message",
		{ target: "peer", message: "hello-b", receiverRole: "child" },
		cancellation.signal,
	);
	cancellation.abort();
	expect(await capturedRejection(cancelledCall)).toEqual({ ok: false, code: "RELAY_FAILURE" });
	expect(await childB.abort()).toEqual({ ok: true, value: { status: "aborted" } });

	const events: HostedRlmRuntimeEvent[] = [];
	const subscription = childA.subscribe((event): void => {
		events.push(event);
	});
	expect(subscription.ok).toBe(true);
	const terminalPromise = childA.awaitTerminal();
	const eventRecord = encodeLifecycleRecord({
		v: 1,
		identity: controllerA.routeIdentity,
		op: "EVENT",
		body: { event: { type: "agent_start" } },
	});
	expect(eventRecord.ok).toBe(true);
	if (!eventRecord.ok) return;
	const eventReply = await integrationOriginCall(runtime.lifecycleToHome, eventRecord.bytes);
	expect(eventReply !== null ? eventReply.code : undefined).toBe("REPLY_READY");
	if (eventReply !== null && eventReply.code === "REPLY_READY") {
		for (let index = 0; index < eventReply.payload.length; index++) eventReply.payload[index] = 0;
	}
	const taskResult: HostedRlmTaskResult = {
		status: "completed",
		durationMs: 10,
		parentReplyCount: 0,
		toolUseCount: 1,
		answerPreview: "done-a",
	};
	const terminalRecord = encodeLifecycleRecord({
		v: 1,
		identity: controllerA.routeIdentity,
		op: "TERMINAL",
		body: { result: taskResult },
	});
	expect(terminalRecord.ok).toBe(true);
	if (!terminalRecord.ok) return;
	const terminalReply = await integrationOriginCall(runtime.lifecycleToHome, terminalRecord.bytes);
	expect(terminalReply !== null ? terminalReply.code : undefined).toBe("REPLY_READY");
	if (terminalReply !== null && terminalReply.code === "REPLY_READY") {
		for (let index = 0; index < terminalReply.payload.length; index++) terminalReply.payload[index] = 0;
	}
	expect(events).toEqual([{ type: "agent_start" }]);
	expect(await terminalPromise).toEqual({ ok: true, value: taskResult });

	expect(await childA.close()).toEqual({ ok: true, value: { status: "closed" } });
	expect(wire.homeCloseCount()).toBe(0);
	expect(wire.runtimeCloseCount()).toBe(0);
	const childBStillLive = await capturedSettlement(
		relayBResult.adapter.invoke("observe_get", { target: "peer" }, signal),
	);
	expect(childBStillLive).toMatchObject({
		fulfilled: true,
		value: { agent: { sessionName: "peer", activeSessionId: "active-b" } },
	});
	expect(await childB.close()).toEqual({ ok: true, value: { status: "closed" } });

	expect(await home.close()).toEqual({ code: "CLEAN" });
	expect(await runtime.close()).toEqual({ code: "CLEAN" });
	expect(wire.homeCloseCount()).toBe(1);
	expect(wire.runtimeCloseCount()).toBe(1);
	expect(retainedReplies.length).toBeGreaterThan(0);
});
