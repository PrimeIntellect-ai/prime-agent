import { describe, expect, it } from "vitest";
import {
	type DecodeResult,
	decodeAppFrame,
	encodeAppFrame,
	KIND_CANCEL,
	KIND_CANCEL_ACK,
	KIND_DELIVERY_ACK,
	KIND_REPLY,
	KIND_REQUEST,
} from "../src/modes/daemon/sandbox/prime-sandbox-v15-application-codec.js";
import {
	type ApplicationBundle,
	createHomeMultiplexer,
	createRuntimeMultiplexer,
	type HomeMultiplexer,
	type OriginSubmit,
	type RuntimeMultiplexer,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";

type InboundHandler = (streamRaw: unknown, plaintextRaw: unknown) => void;
type WireResult = Readonly<{ code: "SENT" | "FAILED" }>;
type CloseResult = Readonly<{ code: "CLOSED" | "FAILED" }>;

interface Gate<T> {
	promise: Promise<T>;
	settle: (value: T) => void;
}
interface CapturedSend {
	streamRaw: unknown;
	bytesRaw: unknown;
	gate: Gate<WireResult>;
}
interface HarnessOptions {
	runtimeDispatch?: (bundle: ApplicationBundle) => unknown;
	homeDispatch?: (bundle: ApplicationBundle) => unknown;
}
interface Harness {
	runtime: RuntimeMultiplexer;
	home: HomeMultiplexer;
	runtimeSends: Array<CapturedSend>;
	homeSends: Array<CapturedSend>;
	runtimeBundles: Array<ApplicationBundle>;
	homeBundles: Array<ApplicationBundle>;
	runtimeInbound: InboundHandler;
	homeInbound: InboundHandler;
	runtimeCloseGate: Gate<CloseResult>;
	homeCloseGate: Gate<CloseResult>;
	runtimeCloseCount: () => number;
	homeCloseCount: () => number;
}
interface RoundTripResult {
	ticket: object;
	bundle: ApplicationBundle;
	request: DecodeResult;
}

function gate<T>(): Gate<T> {
	let resolver: ((value: T) => void) | null = null;
	const promise = new Promise<T>((resolve) => {
		resolver = resolve;
	});
	return {
		promise,
		settle: (value: T): void => {
			if (resolver !== null) resolver(value);
		},
	};
}

function bytes(values: Array<number>): Uint8Array {
	const result = new Uint8Array(values.length);
	for (let index = 0; index < values.length; index += 1) result[index] = values[index];
	return result;
}

function isExactUint8Array(value: unknown): value is Uint8Array {
	return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Uint8Array.prototype;
}

function tick(): Promise<void> {
	return new Promise<void>((resolve) => resolve());
}

function makeHarness(options?: HarnessOptions): Harness | null {
	const runtimeSends: Array<CapturedSend> = [];
	const homeSends: Array<CapturedSend> = [];
	const runtimeBundles: Array<ApplicationBundle> = [];
	const homeBundles: Array<ApplicationBundle> = [];
	const runtimeCloseGate = gate<CloseResult>();
	const homeCloseGate = gate<CloseResult>();
	let runtimeInboundValue: InboundHandler | null = null;
	let homeInboundValue: InboundHandler | null = null;
	let runtimeCloseCalls = 0;
	let homeCloseCalls = 0;

	const runtimePhysical = {
		send: (streamRaw: unknown, bytesRaw: unknown): Promise<WireResult> => {
			const sendGate = gate<WireResult>();
			runtimeSends.push({ streamRaw, bytesRaw, gate: sendGate });
			return sendGate.promise;
		},
		registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
			runtimeInboundValue = handler;
			return Object.freeze({ code: "REGISTERED" });
		},
		close: (): Promise<CloseResult> => {
			runtimeCloseCalls += 1;
			return runtimeCloseGate.promise;
		},
	};
	const homePhysical = {
		send: (streamRaw: unknown, bytesRaw: unknown): Promise<WireResult> => {
			const sendGate = gate<WireResult>();
			homeSends.push({ streamRaw, bytesRaw, gate: sendGate });
			return sendGate.promise;
		},
		registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
			homeInboundValue = handler;
			return Object.freeze({ code: "REGISTERED" });
		},
		close: (): Promise<CloseResult> => {
			homeCloseCalls += 1;
			return homeCloseGate.promise;
		},
	};
	const runtimeDispatch = {
		dispatchApplication: (bundle: ApplicationBundle): unknown => {
			runtimeBundles.push(bundle);
			return options === undefined || options.runtimeDispatch === undefined
				? undefined
				: options.runtimeDispatch(bundle);
		},
	};
	const homeDispatch = {
		dispatchApplication: (bundle: ApplicationBundle): unknown => {
			homeBundles.push(bundle);
			return options === undefined || options.homeDispatch === undefined ? undefined : options.homeDispatch(bundle);
		},
	};

	const runtimeResult = createRuntimeMultiplexer(runtimePhysical, runtimeDispatch);
	const homeResult = createHomeMultiplexer(homePhysical, homeDispatch);
	if ("code" in runtimeResult || "code" in homeResult) return null;
	if (runtimeInboundValue === null || homeInboundValue === null) return null;
	const runtimeInbound: InboundHandler = runtimeInboundValue;
	const homeInbound: InboundHandler = homeInboundValue;
	return {
		runtime: runtimeResult,
		home: homeResult,
		runtimeSends,
		homeSends,
		runtimeBundles,
		homeBundles,
		runtimeInbound,
		homeInbound,
		runtimeCloseGate,
		homeCloseGate,
		runtimeCloseCount: (): number => runtimeCloseCalls,
		homeCloseCount: (): number => homeCloseCalls,
	};
}

function ticketFrom(group: OriginSubmit, payload: Uint8Array): object | null {
	const result = group.submit(payload);
	return result.code === "SUBMITTED" ? result.ticket : null;
}

function settleSend(sends: Array<CapturedSend>, index: number, code: "SENT" | "FAILED"): void {
	const send = sends[index];
	if (send !== undefined) send.gate.settle(Object.freeze({ code }));
}

function wireSend(sends: Array<CapturedSend>, index: number, inbound: InboundHandler): void {
	const send = sends[index];
	if (send !== undefined) inbound(send.streamRaw, send.bytesRaw);
}

async function roundTrip(
	harness: Harness,
	group: OriginSubmit,
	runtimeOrigin: boolean,
	requestValue: number,
	replyValue: number,
): Promise<RoundTripResult | null> {
	const originSends = runtimeOrigin ? harness.runtimeSends : harness.homeSends;
	const destinationSends = runtimeOrigin ? harness.homeSends : harness.runtimeSends;
	const destinationBundles = runtimeOrigin ? harness.homeBundles : harness.runtimeBundles;
	const destinationInbound = runtimeOrigin ? harness.homeInbound : harness.runtimeInbound;
	const originInbound = runtimeOrigin ? harness.runtimeInbound : harness.homeInbound;
	const requestIndex = originSends.length;
	const bundleIndex = destinationBundles.length;
	const ticket = ticketFrom(group, bytes([requestValue]));
	if (ticket === null) return null;
	const requestSend = originSends[requestIndex];
	if (requestSend === undefined) return null;
	const request = decodeAppFrame(requestSend.bytesRaw);
	wireSend(originSends, requestIndex, destinationInbound);
	settleSend(originSends, requestIndex, "SENT");
	await tick();
	const ackIndex = destinationSends.length - 1;
	wireSend(destinationSends, ackIndex, originInbound);
	settleSend(destinationSends, ackIndex, "SENT");
	await tick();
	const bundle = destinationBundles[bundleIndex];
	if (bundle === undefined) return null;
	const replyPromise = bundle.reply(bytes([replyValue]));
	const replyIndex = destinationSends.length - 1;
	wireSend(destinationSends, replyIndex, originInbound);
	settleSend(destinationSends, replyIndex, "SENT");
	await tick();
	expect(await replyPromise).toEqual({ code: "SENT" });
	const reply = await group.awaitReply(ticket);
	expect(reply.code).toBe("REPLY_READY");
	if (reply.code === "REPLY_READY") expect(Array.from(reply.payload)).toEqual([replyValue]);
	return { ticket, bundle, request };
}

describe("factory and dependency validation", () => {
	it("creates exact role-local endpoints", () => {
		const harness = makeHarness();
		expect(harness).not.toBeNull();
		if (harness === null) return;
		expect(Object.keys(harness.runtime).sort()).toEqual([
			"close",
			"lifecycleToHome",
			"messagesToHome",
			"modelToHome",
			"observeRepliesToHome",
			"observeRequestsToHome",
		]);
		expect(Object.keys(harness.home).sort()).toEqual([
			"close",
			"lifecycleToRuntime",
			"messagesToRuntime",
			"observeRepliesToRuntime",
			"observeRequestsToRuntime",
		]);
		expect(Object.isFrozen(harness.runtime)).toBe(true);
		expect(Object.isFrozen(harness.home)).toBe(true);
	});

	it("rejects malformed dependencies", () => {
		const dispatch = { dispatchApplication: (): void => {} };
		expect(createRuntimeMultiplexer(null, dispatch)).toEqual({ code: "INIT_FAILURE" });
		expect(createRuntimeMultiplexer({}, dispatch)).toEqual({ code: "INIT_FAILURE" });
		expect(
			createRuntimeMultiplexer(
				{ send: (): void => {}, registerInbound: (): void => {}, close: (): void => {} },
				null,
			),
		).toEqual({ code: "INIT_FAILURE" });
		const physical = {
			send: (): Promise<WireResult> => Promise.resolve({ code: "SENT" }),
			registerInbound: (): Readonly<{ code: "REGISTERED" }> => ({ code: "REGISTERED" }),
			close: (): Promise<CloseResult> => Promise.resolve({ code: "CLOSED" }),
		};
		expect(createRuntimeMultiplexer(new Proxy(physical, {}), dispatch)).toEqual({ code: "INIT_FAILURE" });
		const accessorPhysical = {
			get send(): () => Promise<WireResult> {
				return () => Promise.resolve({ code: "SENT" });
			},
			registerInbound: (): Readonly<{ code: "REGISTERED" }> => ({ code: "REGISTERED" }),
			close: (): Promise<CloseResult> => Promise.resolve({ code: "CLOSED" }),
		};
		expect(createRuntimeMultiplexer(accessorPhysical, dispatch)).toEqual({ code: "INIT_FAILURE" });
	});

	it("registers once and closes on registration refusal", () => {
		let registrations = 0;
		let closes = 0;
		const physical = {
			send: (): Promise<WireResult> => Promise.resolve({ code: "SENT" }),
			registerInbound: (): Readonly<{ code: "ALREADY_EXISTS" }> => {
				registrations += 1;
				return { code: "ALREADY_EXISTS" };
			},
			close: (): Promise<CloseResult> => {
				closes += 1;
				return Promise.resolve({ code: "CLOSED" });
			},
		};
		expect(createRuntimeMultiplexer(physical, { dispatchApplication: (): void => {} })).toEqual({
			code: "INIT_FAILURE",
		});
		expect(registrations).toBe(1);
		expect(closes).toBe(1);
	});

	it("uses one close owner for reentrant registration poison and drains its delayed actual", async () => {
		const closeGate = gate<CloseResult>();
		let closes = 0;
		const result = createRuntimeMultiplexer(
			{
				send: (): Promise<WireResult> => Promise.resolve({ code: "SENT" }),
				registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
					handler(9, bytes([1]));
					return Object.freeze({ code: "REGISTERED" });
				},
				close: (): Promise<CloseResult> => {
					closes += 1;
					return closeGate.promise;
				},
			},
			{ dispatchApplication: (): void => {} },
		);
		expect(result).toEqual({ code: "INIT_FAILURE" });
		expect(closes).toBe(1);
		expect(Bun.peek(closeGate.promise)).toBe(closeGate.promise);
		closeGate.settle(Object.freeze({ code: "CLOSED" }));
		await tick();
		expect(Bun.peek(closeGate.promise)).toEqual({ code: "CLOSED" });
		expect(closes).toBe(1);
	});

	it("owns a delayed failed-init close rejection without an unhandled result", () => {
		const script = `
import { createRuntimeMultiplexer } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.ts";
function run() {
	let closeReject = null;
	const closeActual = new Promise((_resolve, reject) => {
		closeReject = reject;
	});
	let closeCalls = 0;
	let unhandled = 0;
	process.on("unhandledRejection", () => {
		unhandled += 1;
	});
	const result = createRuntimeMultiplexer(
		{
			send: () => new Promise((resolve) => resolve(Object.freeze({ code: "SENT" }))),
			registerInbound: (handler) => {
				handler(9, new Uint8Array([1]));
				return Object.freeze({ code: "REGISTERED" });
			},
			close: () => {
				closeCalls += 1;
				return closeActual;
			},
		},
		{ dispatchApplication: () => undefined },
	);
	if (result.code !== "INIT_FAILURE" || closeCalls !== 1 || closeReject === null) process.exit(43);
	setTimeout(() => {
		if (closeReject === null) process.exit(44);
		closeReject(Object.freeze({ code: "FAILED" }));
		setTimeout(() => {
			if (unhandled !== 0 || closeCalls !== 1) process.exit(45);
			if (Object.getOwnPropertyDescriptor(closeActual, "constructor") !== undefined) process.exit(46);
			process.exit(0);
		}, 10);
	}, 10);
}
run();
`;
		const probe = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(probe.exitCode).toBe(0);
	});

	it("uses captured physical functions", () => {
		let originalCalls = 0;
		let replacementCalls = 0;
		let inbound: InboundHandler | null = null;
		const closeGate = gate<CloseResult>();
		const physical = {
			send: (): Promise<WireResult> => {
				originalCalls += 1;
				return new Promise<WireResult>(() => {});
			},
			registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
				inbound = handler;
				return { code: "REGISTERED" };
			},
			close: (): Promise<CloseResult> => closeGate.promise,
		};
		const result = createRuntimeMultiplexer(physical, { dispatchApplication: (): void => {} });
		physical.send = (): Promise<WireResult> => {
			replacementCalls += 1;
			return Promise.resolve({ code: "SENT" });
		};
		expect(inbound).not.toBeNull();
		if ("code" in result) return;
		expect(ticketFrom(result.modelToHome, bytes([1]))).not.toBeNull();
		expect(originalCalls).toBe(1);
		expect(replacementCalls).toBe(0);
	});
});

describe("capability ownership", () => {
	it("mints frozen zero-member private tickets", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		expect(ticket).not.toBeNull();
		if (ticket === null) return;
		expect(Object.isFrozen(ticket)).toBe(true);
		expect(Reflect.ownKeys(ticket)).toEqual([]);
		const prototype = Object.getPrototypeOf(ticket);
		expect(Object.isFrozen(prototype)).toBe(true);
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "constructor");
		expect(descriptor === undefined ? undefined : descriptor.value).toBe(null);
	});

	it("distinguishes unknown and wrong-group tickets", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		expect(harness.home.lifecycleToRuntime.cancel(ticket)).toEqual({ code: "INPUT_INVALID" });
		expect(harness.runtime.modelToHome.cancel(Object.freeze({}))).toEqual({ code: "INPUT_INVALID" });
		expect(harness.runtime.modelToHome.cancel(null)).toEqual({ code: "INPUT_INVALID" });
		expect(harness.runtime.modelToHome.cancel(5)).toEqual({ code: "INPUT_INVALID" });
		expect(harness.runtime.lifecycleToHome.cancel(ticket)).toEqual({ code: "POISONED" });
		expect(harness.runtime.modelToHome.pollReply(ticket)).toEqual({ code: "POISONED" });
		expect(ticketFrom(harness.runtime.lifecycleToHome, bytes([2]))).not.toBeNull();
	});

	it("globally poisons a same-prototype forged ticket and drains close", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		const prototype = Object.getPrototypeOf(ticket);
		if (prototype === null) return;
		const forged: object = Object.freeze(Object.create(prototype));
		expect(Reflect.ownKeys(forged)).toEqual([]);
		expect(harness.runtime.modelToHome.cancel(forged)).toEqual({ code: "POISONED" });
		expect(harness.runtime.modelToHome.pollReply(ticket)).toEqual({ code: "POISONED" });
		expect(harness.runtimeCloseCount()).toBe(1);
		const closePromise = harness.runtime.close();
		let settled = false;
		async function observeClose(): Promise<void> {
			await closePromise;
			settled = true;
		}
		observeClose();
		await tick();
		expect(settled).toBe(false);
		settleSend(harness.runtimeSends, 0, "SENT");
		harness.runtimeCloseGate.settle({ code: "CLOSED" });
		expect(await closePromise).toEqual({ code: "POISONED" });
	});

	it("returns CLOSED before capability lookup", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		const closePromise = harness.runtime.close();
		expect(harness.runtime.modelToHome.cancel(ticket)).toEqual({ code: "CLOSED" });
		expect(harness.runtime.modelToHome.cancel({})).toEqual({ code: "CLOSED" });
		settleSend(harness.runtimeSends, 0, "SENT");
		harness.runtimeCloseGate.settle({ code: "CLOSED" });
		expect(await closePromise).toEqual({ code: "CLEAN" });
	});
});

describe("nine request flows", () => {
	it("runs Runtime streams zero through three", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const groups: Array<OriginSubmit> = [
			harness.runtime.modelToHome,
			harness.runtime.lifecycleToHome,
			harness.runtime.messagesToHome,
			harness.runtime.observeRequestsToHome,
		];
		for (let stream = 0; stream <= 3; stream += 1) {
			const result = await roundTrip(harness, groups[stream], true, 10 + stream, 20 + stream);
			expect(result).not.toBeNull();
			if (result !== null && result.request.ok) {
				expect(result.request.kind).toBe(KIND_REQUEST);
				expect(result.request.stream).toBe(stream);
				expect(result.request.requestId).toBe(1n);
				expect(result.bundle.origin).toBe("Runtime");
				expect(result.bundle.stream).toBe(stream);
			}
		}
	});

	it("stream 4 observeRepliesToHome submit returns ENDPOINT_EXHAUSTED", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const result = harness.runtime.observeRepliesToHome.submit(bytes([14]));
		expect(result).toEqual({ code: "ENDPOINT_EXHAUSTED" });
	});

	it("runs Home streams one through three", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const groups: Array<OriginSubmit> = [
			harness.home.lifecycleToRuntime,
			harness.home.messagesToRuntime,
			harness.home.observeRequestsToRuntime,
		];
		for (let offset = 0; offset < 3; offset += 1) {
			const result = await roundTrip(harness, groups[offset], false, 30 + offset, 40 + offset);
			expect(result).not.toBeNull();
			if (result !== null && result.request.ok) {
				expect(result.request.stream).toBe(offset + 1);
				expect(result.request.requestId).toBe(1n);
				expect(result.bundle.origin).toBe("Home");
			}
		}
	});

	it("stream 4 observeRepliesToRuntime submit returns ENDPOINT_EXHAUSTED", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const result = harness.home.observeRepliesToRuntime.submit(bytes([14]));
		expect(result).toEqual({ code: "ENDPOINT_EXHAUSTED" });
	});
});

describe("delivery and dispatch", () => {
	it("does not reveal a bundle before ACK settlement", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([7]));
		if (ticket === null) return;
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		expect(harness.homeBundles).toHaveLength(0);
		expect(harness.runtime.modelToHome.pollDelivery(ticket)).toEqual({ code: "PENDING" });
		settleSend(harness.homeSends, 0, "SENT");
		wireSend(harness.homeSends, 0, harness.runtimeInbound);
		await tick();
		expect(harness.homeBundles).toHaveLength(1);
		expect(await harness.runtime.modelToHome.awaitDelivery(ticket)).toEqual({ code: "CONFIRMED" });
	});

	it("delivers a fresh mutable payload and opposite origin", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const source = bytes([3, 4]);
		const ticket = ticketFrom(harness.runtime.modelToHome, source);
		if (ticket === null) return;
		source[0] = 99;
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		const bundle = harness.homeBundles[0];
		expect(bundle).toBeDefined();
		if (bundle === undefined) return;
		expect(Array.from(bundle.payload)).toEqual([3, 4]);
		expect(bundle.origin).toBe("Runtime");
		expect(bundle.signal.aborted).toBe(false);
		bundle.payload[0] = 8;
		expect(bundle.payload[0]).toBe(8);
	});

	it("ignores dispatcher return values without assimilation", async () => {
		let assimilated = false;
		const harness = makeHarness({
			homeDispatch: (): object => {
				const value = {};
				Object.defineProperty(value, ["t", "h", "e", "n"].join(""), {
					value: (): void => {
						assimilated = true;
					},
				});
				return value;
			},
		});
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		expect(assimilated).toBe(false);
	});

	it("poisons the manager on a synchronous dispatcher fault", async () => {
		const harness = makeHarness({ homeDispatch: (): unknown => JSON.parse("{") });
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		expect(harness.homeCloseCount()).toBe(1);
		expect(harness.home.lifecycleToRuntime.submit(bytes([2]))).toEqual({ code: "POISONED" });
	});
	it("handles synchronous non-loopback delivery", async () => {
		let runtimeInbound: InboundHandler | null = null;
		let homeInbound: InboundHandler | null = null;
		const bundles: Array<ApplicationBundle> = [];
		const runtimePhysical = {
			send: (streamRaw: unknown, plaintextRaw: unknown): Promise<WireResult> => {
				if (homeInbound !== null) homeInbound(streamRaw, plaintextRaw);
				return Promise.resolve({ code: "SENT" });
			},
			registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
				runtimeInbound = handler;
				return { code: "REGISTERED" };
			},
			close: (): Promise<CloseResult> => Promise.resolve({ code: "CLOSED" }),
		};
		const homePhysical = {
			send: (streamRaw: unknown, plaintextRaw: unknown): Promise<WireResult> => {
				if (runtimeInbound !== null) runtimeInbound(streamRaw, plaintextRaw);
				return Promise.resolve({ code: "SENT" });
			},
			registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
				homeInbound = handler;
				return { code: "REGISTERED" };
			},
			close: (): Promise<CloseResult> => Promise.resolve({ code: "CLOSED" }),
		};
		const runtimeResult = createRuntimeMultiplexer(runtimePhysical, { dispatchApplication: (): void => {} });
		const homeResult = createHomeMultiplexer(homePhysical, {
			dispatchApplication: (bundle: ApplicationBundle): void => {
				bundles.push(bundle);
			},
		});
		if ("code" in runtimeResult || "code" in homeResult) return;
		const ticket = ticketFrom(runtimeResult.modelToHome, bytes([5]));
		if (ticket === null) return;
		await tick();
		await tick();
		expect(bundles).toHaveLength(1);
		expect(await runtimeResult.modelToHome.awaitDelivery(ticket)).toEqual({ code: "CONFIRMED" });
	});
});

describe("reply observation", () => {
	it("keeps the reply closure live after dispatch returns", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		wireSend(harness.homeSends, 0, harness.runtimeInbound);
		await tick();
		const bundle = harness.homeBundles[0];
		if (bundle === undefined) return;
		await tick();
		const sendPromise = bundle.reply(bytes([9, 8]));
		wireSend(harness.homeSends, 1, harness.runtimeInbound);
		settleSend(harness.homeSends, 1, "SENT");
		await tick();
		expect(await sendPromise).toEqual({ code: "SENT" });
		const reply = harness.runtime.modelToHome.pollReply(ticket);
		expect(reply.code).toBe("REPLY_READY");
		if (reply.code === "REPLY_READY") expect(Array.from(reply.payload)).toEqual([9, 8]);
		expect(harness.runtime.modelToHome.pollReply(ticket)).toEqual({ code: "POISONED" });
		expect(harness.runtimeCloseCount()).toBe(1);
	});

	it("allows only one reply call", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const opened = await roundTrip(harness, harness.runtime.modelToHome, true, 1, 2);
		if (opened === null) return;
		expect(await opened.bundle.reply(bytes([3]))).toEqual({ code: "POISONED" });
		const closePromise = harness.home.close();
		harness.homeCloseGate.settle({ code: "CLOSED" });
		expect(await closePromise).toEqual({ code: "POISONED" });
	});

	it("rejects invalid reply bytes before queue effects", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		const bundle = harness.homeBundles[0];
		if (bundle === undefined) return;
		const before = harness.homeSends.length;
		expect(await bundle.reply({})).toEqual({ code: "INPUT_INVALID" });
		expect(harness.homeSends).toHaveLength(before);
	});

	it("one pending await is the sole reply observer", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		const first = harness.runtime.modelToHome.awaitReply(ticket);
		expect(await harness.runtime.modelToHome.awaitReply(ticket)).toEqual({ code: "UNKNOWN_TICKET" });
		const closePromise = harness.runtime.close();
		settleSend(harness.runtimeSends, 0, "SENT");
		harness.runtimeCloseGate.settle({ code: "CLOSED" });
		expect(await first).toEqual({ code: "CLOSED" });
		expect(await closePromise).toEqual({ code: "CLEAN" });
	});
});

describe("cancellation and races", () => {
	it("records pre-ACK intent but still sends REQUEST", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		expect(harness.runtime.modelToHome.cancel(ticket)).toEqual({ code: "PENDING" });
		expect(harness.runtimeSends).toHaveLength(1);
		const request = decodeAppFrame(harness.runtimeSends[0].bytesRaw);
		expect(request.ok && request.kind === KIND_REQUEST).toBe(true);
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		expect(harness.runtimeSends).toHaveLength(1);
		settleSend(harness.homeSends, 0, "SENT");
		wireSend(harness.homeSends, 0, harness.runtimeInbound);
		await tick();
		expect(harness.runtimeSends).toHaveLength(2);
		const cancel = decodeAppFrame(harness.runtimeSends[1].bytesRaw);
		expect(cancel.ok && cancel.kind === KIND_CANCEL).toBe(true);
	});

	it("aborts the exact bundle and returns CANCELLED", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		wireSend(harness.homeSends, 0, harness.runtimeInbound);
		await tick();
		const bundle = harness.homeBundles[0];
		if (bundle === undefined) return;
		expect(harness.runtime.modelToHome.cancel(ticket)).toEqual({ code: "PENDING" });
		wireSend(harness.runtimeSends, 1, harness.homeInbound);
		settleSend(harness.runtimeSends, 1, "SENT");
		await tick();
		expect(bundle.signal.aborted).toBe(true);
		expect(await bundle.reply(bytes([2]))).toEqual({ code: "CANCELLED" });
		const cancelAckIndex = harness.homeSends.length - 1;
		wireSend(harness.homeSends, cancelAckIndex, harness.runtimeInbound);
		settleSend(harness.homeSends, cancelAckIndex, "SENT");
		await tick();
		expect(await harness.runtime.modelToHome.awaitReply(ticket)).toEqual({ code: "CANCELLED" });
	});

	it("dispatches an already-aborted bundle after an early CANCEL", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		const cancel = encodeAppFrame(KIND_CANCEL, 0, 1n, undefined);
		if (!cancel.ok) return;
		harness.homeInbound(0, cancel.frame);
		expect(harness.homeBundles).toHaveLength(0);
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		expect(harness.homeBundles).toHaveLength(1);
		expect(harness.homeBundles[0].signal.aborted).toBe(true);
	});

	it("queues one CANCEL_ACK for a reentrant cancel and reply during dispatch", async () => {
		let homeInboundValue: InboundHandler | null = null;
		let composedReplyPromise: Promise<
			Readonly<{ code: "SENT" | "CANCELLED" | "POISONED" | "CLOSED" | "INPUT_INVALID" }>
		> | null = null;
		const harness = makeHarness({
			homeDispatch: (bundle: ApplicationBundle): void => {
				composedReplyPromise = bundle.reply(bytes([9]));
				const cancel = encodeAppFrame(KIND_CANCEL, 0, 1n, undefined);
				const inbound = homeInboundValue;
				if (cancel.ok && inbound !== null) inbound(0, cancel.frame);
			},
		});
		if (harness === null) return;
		homeInboundValue = harness.homeInbound;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		expect(harness.homeSends).toHaveLength(2);
		const reply = decodeAppFrame(harness.homeSends[1].bytesRaw);
		expect(reply.ok && reply.kind === KIND_REPLY).toBe(true);
		settleSend(harness.homeSends, 1, "SENT");
		await tick();
		expect(harness.homeSends).toHaveLength(3);
		const cancelAck = decodeAppFrame(harness.homeSends[2].bytesRaw);
		expect(cancelAck.ok && cancelAck.kind === KIND_CANCEL_ACK).toBe(true);
		settleSend(harness.homeSends, 2, "SENT");
		await tick();
		expect(harness.homeSends).toHaveLength(3);
		const replyPromise = composedReplyPromise;
		if (replyPromise !== null) expect(await replyPromise).toEqual({ code: "SENT" });
	});

	it("accepts REPLY followed by one CANCEL_ACK", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		wireSend(harness.homeSends, 0, harness.runtimeInbound);
		await tick();
		harness.runtime.modelToHome.cancel(ticket);
		const reply = encodeAppFrame(KIND_REPLY, 0, 1n, bytes([7]));
		if (!reply.ok) return;
		harness.runtimeInbound(0, reply.frame);
		const observed = await harness.runtime.modelToHome.awaitReply(ticket);
		expect(observed.code).toBe("REPLY_READY");
		const cancelAck = encodeAppFrame(KIND_CANCEL_ACK, 0, 1n, undefined);
		if (!cancelAck.ok) return;
		harness.runtimeInbound(0, cancelAck.frame);
		expect(ticketFrom(harness.runtime.lifecycleToHome, bytes([2]))).not.toBeNull();
		harness.runtimeInbound(0, cancelAck.frame);
		expect(harness.runtime.lifecycleToHome.submit(bytes([3]))).toEqual({ code: "POISONED" });
	});

	it("accepts CANCEL_ACK followed by one ignored REPLY", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		wireSend(harness.homeSends, 0, harness.runtimeInbound);
		await tick();
		harness.runtime.modelToHome.cancel(ticket);
		const cancelAck = encodeAppFrame(KIND_CANCEL_ACK, 0, 1n, undefined);
		if (!cancelAck.ok) return;
		harness.runtimeInbound(0, cancelAck.frame);
		expect(harness.runtime.modelToHome.pollReply(ticket)).toEqual({ code: "CANCELLED" });
		const reply = encodeAppFrame(KIND_REPLY, 0, 1n, bytes([6]));
		if (!reply.ok) return;
		harness.runtimeInbound(0, reply.frame);
		expect(ticketFrom(harness.runtime.lifecycleToHome, bytes([2]))).not.toBeNull();
		harness.runtimeInbound(0, reply.frame);
		expect(harness.runtime.lifecycleToHome.submit(bytes([3]))).toEqual({ code: "POISONED" });
	});
});

describe("captured collection operations", () => {
	it("survives mutation of every used Array, Map, Set, and WeakMap method", () => {
		const script = `
import { createRuntimeMultiplexer } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.ts";
import { encodeAppFrame, KIND_DELIVERY_ACK } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v15-application-codec.ts";
const mapIteratorPrototype = Object.getPrototypeOf(new Map().values());
const setIteratorPrototype = Object.getPrototypeOf(new Set().values());
const cases = [
	[Array.prototype, "indexOf"],
	[Array.prototype, "splice"],
	[Array.prototype, "push"],
	[Array.prototype, "shift"],
	[Array.prototype, "unshift"],
	[Map.prototype, "get"],
	[Map.prototype, "set"],
	[Map.prototype, "has"],
	[Map.prototype, "delete"],
	[Map.prototype, "clear"],
	[Map.prototype, "values"],
	[Map.prototype, Symbol.iterator],
	[mapIteratorPrototype, "next"],
	[Set.prototype, "add"],
	[Set.prototype, "has"],
	[Set.prototype, "delete"],
	[Set.prototype, "clear"],
	[Set.prototype, "values"],
	[Set.prototype, Symbol.iterator],
	[setIteratorPrototype, "next"],
	[WeakMap.prototype, "get"],
	[WeakMap.prototype, "set"],
	[WeakMap.prototype, "has"],
	[WeakMap.prototype, "delete"],
];
async function exercise(prototype, name) {
	let inbound = null;
	let sendSettle = null;
	let closeSettle = null;
	const sendPromise = new Promise((resolve) => {
		sendSettle = resolve;
	});
	const closePromise = new Promise((resolve) => {
		closeSettle = resolve;
	});
	const result = createRuntimeMultiplexer(
		{
			send: () => sendPromise,
			registerInbound: (handler) => {
				inbound = handler;
				return Object.freeze({ code: "REGISTERED" });
			},
			close: () => closePromise,
		},
		{ dispatchApplication: () => undefined },
	);
	if ("code" in result || inbound === null || sendSettle === null || closeSettle === null) return false;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
	if (descriptor === undefined) return false;
	let okay = true;
	try {
		Object.defineProperty(prototype, name, {
			configurable: descriptor.configurable,
			enumerable: descriptor.enumerable,
			value: () => JSON.parse("{"),
			writable: descriptor.writable,
		});
		const submitted = result.modelToHome.submit(new Uint8Array([1]));
		if (submitted.code !== "SUBMITTED") okay = false;
		sendSettle(Object.freeze({ code: "SENT" }));
		await Promise.resolve();
		const ack = encodeAppFrame(KIND_DELIVERY_ACK, 0, 1n, undefined);
		if (!ack.ok) okay = false;
		else inbound(0, ack.frame);
		if (submitted.code === "SUBMITTED") {
			const prototypeValue = Object.getPrototypeOf(submitted.ticket);
			if (prototypeValue === null) okay = false;
			else {
				const forged = Object.freeze(Object.create(prototypeValue));
				if (result.modelToHome.cancel(forged).code !== "POISONED") okay = false;
			}
		}
		const managerClose = result.close();
		closeSettle(Object.freeze({ code: "CLOSED" }));
		const closeResult = await managerClose;
		if (closeResult.code !== "POISONED") okay = false;
	} catch {
		okay = false;
	} finally {
		Object.defineProperty(prototype, name, descriptor);
	}
	return okay;
}
for (let index = 0; index < cases.length; index += 1) {
	const entry = cases[index];
	if (!(await exercise(entry[0], entry[1]))) process.exit(20 + index);
}
`;
		const probe = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(probe.exitCode).toBe(0);
	}, 20_000);
});

describe("captured abort operations", () => {
	it("uses captured AbortController signal and abort operations", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const signalDescriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, "signal");
		const abortDescriptor = Object.getOwnPropertyDescriptor(AbortController.prototype, "abort");
		if (signalDescriptor === undefined || abortDescriptor === undefined) return;
		try {
			Object.defineProperty(AbortController.prototype, "signal", {
				configurable: signalDescriptor.configurable,
				enumerable: signalDescriptor.enumerable,
				get: (): unknown => JSON.parse("{"),
			});
			Object.defineProperty(AbortController.prototype, "abort", {
				configurable: abortDescriptor.configurable,
				enumerable: abortDescriptor.enumerable,
				value: (): unknown => JSON.parse("{"),
				writable: abortDescriptor.writable,
			});
			const request = encodeAppFrame(KIND_REQUEST, 1, 1n, bytes([1]));
			if (!request.ok) return;
			harness.runtimeInbound(1, request.frame);
			settleSend(harness.runtimeSends, 0, "SENT");
			await tick();
			const cancel = encodeAppFrame(KIND_CANCEL, 1, 1n, undefined);
			if (!cancel.ok) return;
			harness.runtimeInbound(1, cancel.frame);
		} finally {
			Object.defineProperty(AbortController.prototype, "signal", signalDescriptor);
			Object.defineProperty(AbortController.prototype, "abort", abortDescriptor);
		}
		expect(harness.runtimeBundles).toHaveLength(1);
		expect(harness.runtimeBundles[0].signal.aborted).toBe(true);
	});

	it("ignores a permanent AbortSignal has-instance hook and poisons a signal-path callback fault", () => {
		const script = `
import { createRuntimeMultiplexer } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.ts";
import { encodeAppFrame, KIND_REQUEST } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v15-application-codec.ts";
function run() {
	let inbound = null;
	let sendSettle = null;
	let closeSettle = null;
	const sendActual = new Promise((resolve) => {
		sendSettle = resolve;
	});
	const closeActual = new Promise((resolve) => {
		closeSettle = resolve;
	});
	let closeCalls = 0;
	let hookReads = 0;
	let unhandled = 0;
	process.on("unhandledRejection", () => {
		unhandled += 1;
	});
	const abortedDescriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
	if (abortedDescriptor === undefined || typeof abortedDescriptor.get !== "function") process.exit(20);
	const result = createRuntimeMultiplexer(
		{
			send: () => sendActual,
			registerInbound: (handler) => {
				inbound = handler;
				return Object.freeze({ code: "REGISTERED" });
			},
			close: () => {
				closeCalls += 1;
				return closeActual;
			},
		},
		{
			dispatchApplication: () => Reflect.apply(abortedDescriptor.get, {}, []),
		},
	);
	if ("code" in result || inbound === null) process.exit(21);
	Object.defineProperty(AbortSignal, Symbol.hasInstance, {
		configurable: false,
		enumerable: false,
		get: () => {
			hookReads += 1;
			return JSON.parse("{");
		},
	});
	const request = encodeAppFrame(KIND_REQUEST, 1, 1n, new Uint8Array([1]));
	if (!request.ok) process.exit(22);
	inbound(1, request.frame);
	if (sendSettle === null) process.exit(23);
	sendSettle(Object.freeze({ code: "SENT" }));
	setTimeout(() => {
		if (hookReads !== 0 || closeCalls !== 1 || unhandled !== 0) process.exit(24);
		if (result.modelToHome.submit(new Uint8Array([2])).code !== "POISONED") process.exit(25);
		const managerClose = result.close();
		if (Bun.peek(managerClose) !== managerClose) process.exit(26);
		if (closeSettle === null) process.exit(27);
		closeSettle(Object.freeze({ code: "CLOSED" }));
		setTimeout(() => {
			const closeResult = Bun.peek(managerClose);
			if (closeResult === managerClose || closeResult.code !== "POISONED") process.exit(28);
			if (closeCalls !== 1 || unhandled !== 0 || hookReads !== 0) process.exit(29);
			process.exit(0);
		}, 10);
	}, 10);
}
run();
`;
		const probe = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(probe.exitCode).toBe(0);
	});
});

describe("bounds and windows", () => {
	it("enforces 32 local live slots across groups", () => {
		const harness = makeHarness();
		if (harness === null) return;
		for (let index = 0; index < 16; index += 1) {
			expect(ticketFrom(harness.runtime.modelToHome, bytes([index]))).not.toBeNull();
			expect(ticketFrom(harness.runtime.lifecycleToHome, bytes([index]))).not.toBeNull();
		}
		expect(harness.runtime.messagesToHome.submit(bytes([1]))).toEqual({ code: "ENDPOINT_EXHAUSTED" });
	});

	it("keeps local and remote origin quotas independent up to 64 total", () => {
		const harness = makeHarness();
		if (harness === null) return;
		for (let index = 1; index <= 32; index += 1) {
			const request = encodeAppFrame(KIND_REQUEST, 1, BigInt(index), bytes([index]));
			if (request.ok) harness.runtimeInbound(1, request.frame);
		}
		for (let index = 0; index < 32; index += 1) {
			expect(ticketFrom(harness.runtime.modelToHome, bytes([index]))).not.toBeNull();
		}
		expect(harness.runtime.lifecycleToHome.submit(bytes([1]))).toEqual({ code: "ENDPOINT_EXHAUSTED" });
	});

	it("does not spend an ID on rejected input", () => {
		const harness = makeHarness();
		if (harness === null) return;
		expect(harness.runtime.modelToHome.submit({})).toEqual({ code: "INPUT_INVALID" });
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		const frame = decodeAppFrame(harness.runtimeSends[0].bytesRaw);
		expect(frame.ok && frame.requestId === 1n).toBe(true);
	});

	it("advances request IDs after terminal replies", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		for (let index = 1; index <= 65; index += 1) {
			const result = await roundTrip(harness, harness.runtime.modelToHome, true, index & 255, index & 255);
			expect(result).not.toBeNull();
			if (result !== null && result.request.ok) expect(result.request.requestId).toBe(BigInt(index));
		}
	});

	it("rejects payloads above the protocol maximum", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const payload = new Uint8Array(262_129);
		expect(harness.runtime.modelToHome.submit(payload)).toEqual({ code: "INPUT_INVALID" });
		expect(harness.runtimeSends).toHaveLength(0);
	});

	it("evicts the oldest retained companion at 64 IDs", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		let sendIndex = 0;
		for (let index = 1; index <= 65; index += 1) {
			const ticket = ticketFrom(harness.runtime.modelToHome, bytes([index & 255]));
			expect(ticket).not.toBeNull();
			if (ticket === null) return;
			settleSend(harness.runtimeSends, sendIndex, "SENT");
			await tick();
			const ack = encodeAppFrame(KIND_DELIVERY_ACK, 0, BigInt(index), undefined);
			if (!ack.ok) return;
			harness.runtimeInbound(0, ack.frame);
			expect(harness.runtime.modelToHome.cancel(ticket)).toEqual({ code: "PENDING" });
			sendIndex += 1;
			settleSend(harness.runtimeSends, sendIndex, "SENT");
			await tick();
			const cancelAck = encodeAppFrame(KIND_CANCEL_ACK, 0, BigInt(index), undefined);
			if (!cancelAck.ok) return;
			harness.runtimeInbound(0, cancelAck.frame);
			expect(harness.runtime.modelToHome.pollReply(ticket)).toEqual({ code: "CANCELLED" });
			sendIndex += 1;
		}
		const oldReply = encodeAppFrame(KIND_REPLY, 0, 1n, bytes([1]));
		if (!oldReply.ok) return;
		harness.runtimeInbound(0, oldReply.frame);
		expect(harness.runtime.lifecycleToHome.submit(bytes([1]))).toEqual({ code: "POISONED" });
	});

	it("bounds unobserved cancel-won ticket state", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		let heldTicket: object | null = null;
		let sendIndex = 0;
		for (let index = 1; index <= 65; index += 1) {
			const ticket = ticketFrom(harness.runtime.modelToHome, bytes([index & 255]));
			expect(ticket).not.toBeNull();
			if (ticket === null) return;
			if (index === 1) heldTicket = ticket;
			settleSend(harness.runtimeSends, sendIndex, "SENT");
			await tick();
			const ack = encodeAppFrame(KIND_DELIVERY_ACK, 0, BigInt(index), undefined);
			if (!ack.ok) return;
			harness.runtimeInbound(0, ack.frame);
			expect(harness.runtime.modelToHome.cancel(ticket)).toEqual({ code: "PENDING" });
			sendIndex += 1;
			settleSend(harness.runtimeSends, sendIndex, "SENT");
			await tick();
			const cancelAck = encodeAppFrame(KIND_CANCEL_ACK, 0, BigInt(index), undefined);
			if (!cancelAck.ok) return;
			harness.runtimeInbound(0, cancelAck.frame);
			sendIndex += 1;
		}
		if (heldTicket === null) return;
		expect(harness.runtime.modelToHome.pollReply(heldTicket)).toEqual({ code: "CANCELLED" });
		expect(ticketFrom(harness.runtime.modelToHome, bytes([66]))).not.toBeNull();
	});

	it("poisons on inbound skips and replays", () => {
		const skipped = makeHarness();
		if (skipped === null) return;
		const skipFrame = encodeAppFrame(KIND_REQUEST, 1, 2n, bytes([1]));
		if (skipFrame.ok) skipped.runtimeInbound(1, skipFrame.frame);
		expect(skipped.runtime.modelToHome.submit(bytes([1]))).toEqual({ code: "POISONED" });
		const replayed = makeHarness();
		if (replayed === null) return;
		const first = encodeAppFrame(KIND_REQUEST, 1, 1n, bytes([1]));
		if (!first.ok) return;
		replayed.runtimeInbound(1, first.frame);
		replayed.runtimeInbound(1, first.frame);
		expect(replayed.runtime.modelToHome.submit(bytes([1]))).toEqual({ code: "POISONED" });
	});
});

describe("reentrant receive queue bounds", () => {
	// This test synchronously copies and decodes 65 protocol-maximum frames, which can take about 18 seconds on Bun.
	it("poisons when 65 maximum plaintext frames exceed the byte bound", async () => {
		const maxRequest = encodeAppFrame(KIND_REQUEST, 1, 2n, new Uint8Array(262_128));
		if (!maxRequest.ok) return;
		const sends: Array<CapturedSend> = [];
		const closeGate = gate<CloseResult>();
		const bundles: Array<ApplicationBundle> = [];
		const inbounds: Array<InboundHandler> = [];
		let closeCalls = 0;
		let poisonAt = 0;
		const physical = {
			send: (streamRaw: unknown, bytesRaw: unknown): Promise<WireResult> => {
				const sendGate = gate<WireResult>();
				sends.push({ streamRaw, bytesRaw, gate: sendGate });
				const decoded = decodeAppFrame(bytesRaw);
				const inbound = inbounds[0];
				if (decoded.ok && decoded.kind === KIND_CANCEL_ACK && inbound !== undefined) {
					for (let index = 0; index < 65; index += 1) {
						inbound(1, maxRequest.frame);
						if (closeCalls > 0 && poisonAt === 0) poisonAt = index + 1;
					}
				}
				return sendGate.promise;
			},
			registerInbound: (handler: InboundHandler): Readonly<{ code: "REGISTERED" }> => {
				inbounds.push(handler);
				return { code: "REGISTERED" };
			},
			close: (): Promise<CloseResult> => {
				closeCalls += 1;
				return closeGate.promise;
			},
		};
		const result = createHomeMultiplexer(physical, {
			dispatchApplication: (bundle: ApplicationBundle): void => {
				bundles.push(bundle);
			},
		});
		if ("code" in result) return;
		const inbound = inbounds[0];
		if (inbound === undefined) return;
		const request = encodeAppFrame(KIND_REQUEST, 1, 1n, bytes([1]));
		if (!request.ok) return;
		inbound(1, request.frame);
		settleSend(sends, 0, "SENT");
		await tick();
		expect(bundles).toHaveLength(1);
		const cancel = encodeAppFrame(KIND_CANCEL, 1, 1n, undefined);
		if (!cancel.ok) return;
		inbound(1, cancel.frame);
		expect(poisonAt).toBe(65);
		expect(closeCalls).toBe(1);
		expect(result.lifecycleToRuntime.submit(bytes([2]))).toEqual({ code: "POISONED" });
	}, 30_000);
});

describe("byte ownership", () => {
	it("zeros a sent REQUEST frame after settlement", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1, 2, 3]));
		const captured = harness.runtimeSends[0].bytesRaw;
		expect(isExactUint8Array(captured)).toBe(true);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		if (!isExactUint8Array(captured)) return;
		expect(Array.from(captured).every((value) => value === 0)).toBe(true);
	});

	it("zeros unsent queue entries during close", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		ticketFrom(harness.runtime.lifecycleToHome, bytes([2]));
		const unsent = harness.runtimeSends.length === 1 ? null : harness.runtimeSends[1].bytesRaw;
		const closePromise = harness.runtime.close();
		expect(harness.runtimeCloseCount()).toBe(1);
		settleSend(harness.runtimeSends, 0, "SENT");
		harness.runtimeCloseGate.settle({ code: "CLOSED" });
		expect(await closePromise).toEqual({ code: "CLEAN" });
		if (isExactUint8Array(unsent)) expect(Array.from(unsent).every((value) => value === 0)).toBe(true);
	});

	it("zeros late ignored REPLY bytes", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const frame = encodeAppFrame(KIND_REPLY, 0, 1n, bytes([9]));
		if (!frame.ok) return;
		harness.runtimeInbound(0, frame.frame);
		expect(Array.from(frame.frame).every((value) => value === 0)).toBe(false);
		expect(harness.runtime.modelToHome.submit(bytes([1]))).toEqual({ code: "POISONED" });
	});
});

describe("physical send and close", () => {
	it("constructs fresh extensible authenticated transport promises", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		expect(harness.runtime.modelToHome.submit(bytes([1])).code).toBe("SUBMITTED");
		const first = harness.runtimeSends[0];
		if (first === undefined) return;
		expect(Object.isExtensible(first.gate.promise)).toBe(true);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		expect(harness.runtime.modelToHome.submit(bytes([2])).code).toBe("SUBMITTED");
		const second = harness.runtimeSends[1];
		if (second === undefined) return;
		expect(second.gate.promise).not.toBe(first.gate.promise);
		expect(Object.isExtensible(second.gate.promise)).toBe(true);
		expect(Object.isExtensible(harness.runtimeCloseGate.promise)).toBe(true);
		settleSend(harness.runtimeSends, 1, "SENT");
		const closePromise = harness.runtime.close();
		harness.runtimeCloseGate.settle(Object.freeze({ code: "CLOSED" }));
		expect(await closePromise).toEqual({ code: "CLEAN" });
	});

	it("uses the captured Object extensibility check after initialization", () => {
		const script = `
import { createRuntimeMultiplexer } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.ts";
async function run() {
	let inbound = null;
	let closeCalls = 0;
	const result = createRuntimeMultiplexer(
		{
			send: () => new Promise((resolve) => resolve(Object.freeze({ code: "SENT" }))),
			registerInbound: (handler) => {
				inbound = handler;
				return Object.freeze({ code: "REGISTERED" });
			},
			close: () => {
				closeCalls += 1;
				return new Promise((resolve) => resolve(Object.freeze({ code: "CLOSED" })));
			},
		},
		{ dispatchApplication: () => undefined },
	);
	if ("code" in result || inbound === null) process.exit(40);
	Object.isExtensible = () => false;
	if (result.modelToHome.submit(new Uint8Array([1])).code !== "SUBMITTED") process.exit(41);
	await new Promise((resolve) => setTimeout(resolve, 0));
	const closed = await result.close();
	if (closed.code !== "CLEAN" || closeCalls !== 1) process.exit(42);
}
run();
`;
		const probe = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(probe.exitCode).toBe(0);
	});

	it("revokes a nonextensible send and waits for accepted physical shutdown", async () => {
		const sendGate = gate<WireResult>();
		const closeGate = gate<CloseResult>();
		let sentBytes: Uint8Array | null = null;
		let closes = 0;
		const result = createRuntimeMultiplexer(
			{
				send: (_streamRaw: unknown, bytesRaw: unknown): Promise<WireResult> => {
					if (isExactUint8Array(bytesRaw)) sentBytes = bytesRaw;
					return Object.preventExtensions(sendGate.promise);
				},
				registerInbound: (): Readonly<{ code: "REGISTERED" }> => Object.freeze({ code: "REGISTERED" }),
				close: (): Promise<CloseResult> => {
					closes += 1;
					return closeGate.promise;
				},
			},
			{ dispatchApplication: (): void => {} },
		);
		if ("code" in result) return;
		expect(result.modelToHome.submit(bytes([7])).code).toBe("POISONED");
		expect(closes).toBe(1);
		const retainedBytes = sentBytes;
		if (retainedBytes === null) return;
		expect(Array.from(retainedBytes).some((value) => value !== 0)).toBe(true);
		const managerClose = result.close();
		let settled = false;
		async function observeClose(): Promise<void> {
			await managerClose;
			settled = true;
		}
		const closeObserver = observeClose();
		await tick();
		expect(settled).toBe(false);
		expect(Array.from(retainedBytes).some((value) => value !== 0)).toBe(true);
		closeGate.settle(Object.freeze({ code: "CLOSED" }));
		expect(await managerClose).toEqual({ code: "POISONED" });
		await closeObserver;
		expect(Array.from(retainedBytes).every((value) => value === 0)).toBe(true);
		expect(Bun.peek(sendGate.promise)).toBe(sendGate.promise);
		expect(closes).toBe(1);
		sendGate.settle(Object.freeze({ code: "SENT" }));
	});

	it("bounds bytes and reports uncertainty when physical close is malformed", async () => {
		const sendGate = gate<WireResult>();
		const closeGate = gate<CloseResult>();
		let sentBytes: Uint8Array | null = null;
		let closes = 0;
		const result = createRuntimeMultiplexer(
			{
				send: (_streamRaw: unknown, bytesRaw: unknown): Promise<WireResult> => {
					if (isExactUint8Array(bytesRaw)) sentBytes = bytesRaw;
					return Object.preventExtensions(sendGate.promise);
				},
				registerInbound: (): Readonly<{ code: "REGISTERED" }> => Object.freeze({ code: "REGISTERED" }),
				close: (): Promise<CloseResult> => {
					closes += 1;
					return Object.preventExtensions(closeGate.promise);
				},
			},
			{ dispatchApplication: (): void => {} },
		);
		if ("code" in result) return;
		expect(result.modelToHome.submit(bytes([8])).code).toBe("POISONED");
		expect(await result.close()).toEqual({ code: "POISONED" });
		expect(closes).toBe(1);
		const releasedBytes = sentBytes;
		if (releasedBytes === null) return;
		expect(Array.from(releasedBytes).every((value) => value === 0)).toBe(true);
		expect(Bun.peek(sendGate.promise)).toBe(sendGate.promise);
		expect(Bun.peek(closeGate.promise)).toBe(closeGate.promise);
		sendGate.settle(Object.freeze({ code: "SENT" }));
		closeGate.settle(Object.freeze({ code: "CLOSED" }));
	});

	it("stores the send tail before a reentrant close from physical send", async () => {
		const sendGate = gate<WireResult>();
		const closeGate = gate<CloseResult>();
		let manager: RuntimeMultiplexer | null = null;
		let reentrantClose: Promise<Readonly<{ code: "CLEAN" | "POISONED" }>> | null = null;
		let closeCalls = 0;
		const physical = {
			send: (): Promise<WireResult> => {
				const current = manager;
				if (current !== null) reentrantClose = current.close();
				return sendGate.promise;
			},
			registerInbound: (): Readonly<{ code: "REGISTERED" }> => ({ code: "REGISTERED" }),
			close: (): Promise<CloseResult> => {
				closeCalls += 1;
				return closeGate.promise;
			},
		};
		const result = createRuntimeMultiplexer(physical, { dispatchApplication: (): void => {} });
		if ("code" in result) return;
		manager = result;
		expect(result.modelToHome.submit(bytes([1])).code).toBe("SUBMITTED");
		const closePromise = reentrantClose;
		if (closePromise === null) return;
		expect(closeCalls).toBe(1);
		let settled = false;
		async function observeClose(): Promise<void> {
			await closePromise;
			settled = true;
		}
		const observer = observeClose();
		closeGate.settle({ code: "CLOSED" });
		await tick();
		expect(settled).toBe(false);
		sendGate.settle({ code: "SENT" });
		expect(await closePromise).toEqual({ code: "CLEAN" });
		await observer;
	});

	it("poisons and drains when a physical settlement callback faults", () => {
		const script = `
import { createRuntimeMultiplexer } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.ts";
import { encodeAppFrame, KIND_REQUEST } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v15-application-codec.ts";
function run() {
	const Bytes = Uint8Array;
	let inbound = null;
	let sendSettle = null;
	let closeSettle = null;
	const sendActual = new Promise((resolve) => {
		sendSettle = resolve;
	});
	const closeActual = new Promise((resolve) => {
		closeSettle = resolve;
	});
	let closeCalls = 0;
	let unhandled = 0;
	process.on("unhandledRejection", () => {
		unhandled += 1;
	});
	const result = createRuntimeMultiplexer(
		{
			send: () => {
				globalThis.Uint8Array = function BrokenBytes() {
					return JSON.parse("{");
				};
				return sendActual;
			},
			registerInbound: (handler) => {
				inbound = handler;
				return Object.freeze({ code: "REGISTERED" });
			},
			close: () => {
				closeCalls += 1;
				return closeActual;
			},
		},
		{ dispatchApplication: () => undefined },
	);
	if ("code" in result || inbound === null) process.exit(30);
	const request = encodeAppFrame(KIND_REQUEST, 1, 1n, new Bytes([1]));
	if (!request.ok) process.exit(31);
	inbound(1, request.frame);
	if (sendSettle === null) process.exit(32);
	sendSettle(Object.freeze({ code: "SENT" }));
	setTimeout(() => {
		if (closeCalls !== 1 || unhandled !== 0) process.exit(33);
		if (result.modelToHome.submit(new Bytes([2])).code !== "POISONED") process.exit(34);
		const managerClose = result.close();
		if (Bun.peek(managerClose) !== managerClose) process.exit(35);
		if (closeSettle === null) process.exit(36);
		closeSettle(Object.freeze({ code: "CLOSED" }));
		setTimeout(() => {
			const closeResult = Bun.peek(managerClose);
			if (closeResult === managerClose || closeResult.code !== "POISONED") process.exit(37);
			if (closeCalls !== 1 || unhandled !== 0) process.exit(38);
			process.exit(0);
		}, 10);
	}, 10);
}
run();
`;
		const probe = Bun.spawnSync([process.execPath, "-e", script], {
			cwd: process.cwd(),
			stderr: "pipe",
			stdout: "pipe",
		});
		expect(probe.exitCode).toBe(0);
	});

	it("drains exact physical promises under permanent Promise mutations", () => {
		const cases = [
			["constructor", false],
			["species", false],
			["then", false],
			["combined", false],
			["constructor", true],
			["species", true],
			["then", true],
			["combined", true],
		];
		for (let index = 0; index < cases.length; index += 1) {
			const entry = cases[index];
			const which = entry[0];
			const duringSend = entry[1];
			const script = `
import { createRuntimeMultiplexer } from "./packages/coding-agent/src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.ts";
function mutate(which) {
	if (which === "constructor" || which === "combined") {
		Object.defineProperty(Promise.prototype, "constructor", {
			configurable: false,
			enumerable: false,
			get: () => JSON.parse("{"),
		});
	}
	if (which === "species" || which === "combined") {
		Object.defineProperty(Promise, Symbol.species, {
			configurable: false,
			enumerable: false,
			get: () => JSON.parse("{"),
		});
	}
	if (which === "then" || which === "combined") {
		Object.defineProperty(Promise.prototype, "then", {
			configurable: false,
			enumerable: false,
			value: () => JSON.parse("{"),
			writable: false,
		});
	}
}
function run() {
	const which = ${JSON.stringify(which)};
	const duringSend = ${JSON.stringify(duringSend)};
	let sendSettle = null;
	let closeSettle = null;
	const sendActual = new Promise((resolve) => {
		sendSettle = resolve;
	});
	const closeActual = new Promise((resolve) => {
		closeSettle = resolve;
	});
	let manager = null;
	let reentrantClose = null;
	let closeCalls = 0;
	let unhandled = 0;
	process.on("unhandledRejection", () => {
		unhandled += 1;
	});
	const result = createRuntimeMultiplexer(
		{
			send: () => {
				if (duringSend) {
					mutate(which);
					if (manager !== null) reentrantClose = manager.close();
				}
				return sendActual;
			},
			registerInbound: () => Object.freeze({ code: "REGISTERED" }),
			close: () => {
				closeCalls += 1;
				return closeActual;
			},
		},
		{ dispatchApplication: () => undefined },
	);
	if ("code" in result) process.exit(10);
	manager = result;
	if (!duringSend) mutate(which);
	const submitted = result.modelToHome.submit(new Uint8Array([1]));
	if (submitted.code !== "SUBMITTED") process.exit(11);
	const managerClose = reentrantClose === null ? result.close() : reentrantClose;
	if (closeCalls !== 1) process.exit(12);
	if (closeSettle === null || sendSettle === null) process.exit(13);
	closeSettle(Object.freeze({ code: "CLOSED" }));
	setTimeout(() => {
		if (Bun.peek(managerClose) !== managerClose) process.exit(14);
		sendSettle(Object.freeze({ code: "SENT" }));
		setTimeout(() => {
			const closeResult = Bun.peek(managerClose);
			if (closeResult === managerClose || closeResult.code !== "CLEAN") process.exit(15);
			if (closeCalls !== 1 || unhandled !== 0) process.exit(16);
			process.exit(0);
		}, 10);
	}, 10);
}
run();
`;
			const probe = Bun.spawnSync([process.execPath, "-e", script], {
				cwd: process.cwd(),
				stderr: "pipe",
				stdout: "pipe",
			});
			expect(probe.exitCode).toBe(0);
		}
	});

	it("invokes physical close immediately with a pending send", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		const first = harness.runtime.close();
		const second = harness.runtime.close();
		expect(first).toBe(second);
		expect(harness.runtimeCloseCount()).toBe(1);
		let settled = false;
		async function observeClose(): Promise<void> {
			await first;
			settled = true;
		}
		const observer = observeClose();
		harness.runtimeCloseGate.settle({ code: "CLOSED" });
		await tick();
		expect(settled).toBe(false);
		settleSend(harness.runtimeSends, 0, "SENT");
		expect(await first).toEqual({ code: "CLEAN" });
		await observer;
	});

	it("aborts visible inbound signals before physical close settles", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		ticketFrom(harness.runtime.modelToHome, bytes([1]));
		wireSend(harness.runtimeSends, 0, harness.homeInbound);
		settleSend(harness.runtimeSends, 0, "SENT");
		await tick();
		settleSend(harness.homeSends, 0, "SENT");
		await tick();
		const bundle = harness.homeBundles[0];
		if (bundle === undefined) return;
		const closePromise = harness.home.close();
		expect(bundle.signal.aborted).toBe(true);
		expect(harness.homeCloseCount()).toBe(1);
		harness.homeCloseGate.settle({ code: "CLOSED" });
		expect(await closePromise).toEqual({ code: "CLEAN" });
	});

	it("maps physical close failure to POISONED", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const closePromise = harness.runtime.close();
		harness.runtimeCloseGate.settle({ code: "FAILED" });
		expect(await closePromise).toEqual({ code: "POISONED" });
	});

	it("poisons on physical send failure", async () => {
		const harness = makeHarness();
		if (harness === null) return;
		const ticket = ticketFrom(harness.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		settleSend(harness.runtimeSends, 0, "FAILED");
		await tick();
		expect(harness.runtime.modelToHome.pollDelivery(ticket)).toEqual({ code: "POISONED" });
		expect(harness.runtimeCloseCount()).toBe(1);
	});

	it("poisons on stream mismatch and duplicate ACK", async () => {
		const mismatch = makeHarness();
		if (mismatch === null) return;
		const request = encodeAppFrame(KIND_REQUEST, 1, 1n, bytes([1]));
		if (request.ok) mismatch.runtimeInbound(2, request.frame);
		expect(mismatch.runtime.modelToHome.submit(bytes([1]))).toEqual({ code: "POISONED" });
		const duplicate = makeHarness();
		if (duplicate === null) return;
		const ticket = ticketFrom(duplicate.runtime.modelToHome, bytes([1]));
		if (ticket === null) return;
		settleSend(duplicate.runtimeSends, 0, "SENT");
		await tick();
		const ack = encodeAppFrame(KIND_DELIVERY_ACK, 0, 1n, undefined);
		if (!ack.ok) return;
		duplicate.runtimeInbound(0, ack.frame);
		duplicate.runtimeInbound(0, ack.frame);
		expect(duplicate.runtime.modelToHome.pollDelivery(ticket)).toEqual({ code: "POISONED" });
	});

	it("rejects Home-origin stream zero at Runtime", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const request = encodeAppFrame(KIND_REQUEST, 0, 1n, bytes([1]));
		if (request.ok) harness.runtimeInbound(0, request.frame);
		expect(harness.runtime.modelToHome.submit(bytes([2]))).toEqual({ code: "POISONED" });
	});

	it("inbound stream 4 KIND_REQUEST from Home poisons Runtime multiplexer", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const request = encodeAppFrame(KIND_REQUEST, 4, 1n, bytes([1]));
		if (request.ok) harness.runtimeInbound(4, request.frame);
		expect(harness.runtime.modelToHome.submit(bytes([2]))).toEqual({ code: "POISONED" });
	});

	it("inbound stream 4 KIND_REQUEST from Runtime poisons Home multiplexer", () => {
		const harness = makeHarness();
		if (harness === null) return;
		const request = encodeAppFrame(KIND_REQUEST, 4, 1n, bytes([1]));
		if (request.ok) harness.homeInbound(4, request.frame);
		expect(harness.home.lifecycleToRuntime.submit(bytes([2]))).toEqual({ code: "POISONED" });
	});

	it("Runtime stream 4 reserved submit does not consume local or total live capacity", () => {
		const harness = makeHarness();
		if (harness === null) return;
		for (let index = 0; index < 31; index += 1) {
			expect(ticketFrom(harness.runtime.modelToHome, bytes([index]))).not.toBeNull();
		}
		const exResult = harness.runtime.observeRepliesToHome.submit(bytes([31]));
		expect(exResult).toEqual({ code: "ENDPOINT_EXHAUSTED" });
		const submit32 = harness.runtime.modelToHome.submit(bytes([32]));
		expect(submit32.code).toBe("SUBMITTED");
		if (submit32.code === "SUBMITTED") expect(submit32.ticket).not.toBeUndefined();
		const submit33 = harness.runtime.modelToHome.submit(bytes([33]));
		expect(submit33).toEqual({ code: "ENDPOINT_EXHAUSTED" });
	});

	it("Home stream 4 reserved submit does not consume local or total live capacity", () => {
		const harness = makeHarness();
		if (harness === null) return;
		for (let index = 0; index < 31; index += 1) {
			expect(ticketFrom(harness.home.lifecycleToRuntime, bytes([index]))).not.toBeNull();
		}
		const exResult = harness.home.observeRepliesToRuntime.submit(bytes([31]));
		expect(exResult).toEqual({ code: "ENDPOINT_EXHAUSTED" });
		const submit32 = harness.home.lifecycleToRuntime.submit(bytes([32]));
		expect(submit32.code).toBe("SUBMITTED");
		if (submit32.code === "SUBMITTED") expect(submit32.ticket).not.toBeUndefined();
		const submit33 = harness.home.lifecycleToRuntime.submit(bytes([33]));
		expect(submit33).toEqual({ code: "ENDPOINT_EXHAUSTED" });
	});
});
