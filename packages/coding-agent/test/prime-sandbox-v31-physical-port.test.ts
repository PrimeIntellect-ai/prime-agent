import { describe, expect, test } from "bun:test";
import {
	copySandboxEd25519PublicKey,
	copySandboxX25519PublicKey,
	createSandboxTransportChannel,
	deriveSandboxTransportKeys,
	encryptSandboxTransportFrame,
	generateSandboxEd25519KeyPair,
	generateSandboxX25519KeyPair,
	type SandboxTransportChannel,
	signSandboxHomeChallenge,
	signSandboxRuntimeChallenge,
} from "../src/modes/daemon/sandbox/prime-sandbox-transport.js";
import { encodeAppFrame, KIND_REQUEST } from "../src/modes/daemon/sandbox/prime-sandbox-v15-application-codec.js";
import { createRuntimeMultiplexer } from "../src/modes/daemon/sandbox/prime-sandbox-v31-multiplexer.js";
import {
	createSandboxV31PhysicalPort,
	type SandboxV31PhysicalPort,
} from "../src/modes/daemon/sandbox/prime-sandbox-v31-physical-port.js";

const NativePromise = Promise;
const nativePromisePrototype = Promise.prototype;
const nativeThen = Promise.prototype.then;

function sequence(start: number, length: number): Uint8Array<ArrayBuffer> {
	const value = new Uint8Array(new ArrayBuffer(length));
	for (let index = 0; index < length; index += 1) value[index] = (start + index) & 0xff;
	return value;
}

async function channels(): Promise<{ home: SandboxTransportChannel; runtime: SandboxTransportChannel } | undefined> {
	const runtimeIdentityResult = await generateSandboxEd25519KeyPair();
	const homeIdentityResult = await generateSandboxEd25519KeyPair();
	if (!runtimeIdentityResult.ok || !homeIdentityResult.ok) return undefined;
	const runtimePublic = copySandboxEd25519PublicKey(runtimeIdentityResult.value);
	const homePublic = copySandboxEd25519PublicKey(homeIdentityResult.value);
	if (runtimePublic === undefined || homePublic === undefined) return undefined;
	const protocolNonce = sequence(1, 32);
	const challenge1 = sequence(33, 32);
	const challenge2 = sequence(65, 32);
	const signature1 = await signSandboxRuntimeChallenge(runtimeIdentityResult.value, protocolNonce, challenge1);
	const signature2 = await signSandboxHomeChallenge(homeIdentityResult.value, protocolNonce, challenge2);
	const homeX = await generateSandboxX25519KeyPair();
	const runtimeX = await generateSandboxX25519KeyPair();
	if (!signature1.ok || !signature2.ok || !homeX.ok || !runtimeX.ok) return undefined;
	const homeXPublic = copySandboxX25519PublicKey(homeX.value);
	const runtimeXPublic = copySandboxX25519PublicKey(runtimeX.value);
	if (homeXPublic === undefined || runtimeXPublic === undefined) return undefined;
	const transcript = {
		protocolNonce,
		challenge1,
		signature1: signature1.value,
		challenge2,
		signature2: signature2.value,
		homeX25519PublicKey: homeXPublic,
		runtimeX25519PublicKey: runtimeXPublic,
		archiveSha256: sequence(97, 32),
	};
	const homeKeys = await deriveSandboxTransportKeys(homeX.value, "home", transcript);
	const runtimeKeys = await deriveSandboxTransportKeys(runtimeX.value, "runtime", transcript);
	if (!homeKeys.ok || !runtimeKeys.ok) return undefined;
	const home = createSandboxTransportChannel(homeKeys.value, "home");
	const runtime = createSandboxTransportChannel(runtimeKeys.value, "runtime");
	if (!home.ok || !runtime.ok) return undefined;
	return { home: home.value, runtime: runtime.value };
}

type ReadResult =
	| Readonly<{ type: "DATA"; data: Uint8Array<ArrayBuffer> }>
	| Readonly<{ type: "EOF" }>
	| Readonly<{ type: "IO_FAILURE" }>;

interface PendingRead {
	readonly length: number;
	readonly resolve: (value: ReadResult) => void;
}

interface EndpointState {
	readonly chunks: Uint8Array<ArrayBuffer>[];
	buffered: number;
	closed: boolean;
	peerEnded: boolean;
	pending: PendingRead | undefined;
	peer: EndpointState | undefined;
	readonly closedPromise: Promise<void>;
	readonly resolveClosed: () => void;
	fragment: number;
	delayWrites: boolean;
	pendingWrite: (() => void) | undefined;
}

interface FakeEndpoint {
	readonly io: object;
	readonly inject: (bytes: Uint8Array) => void;
	readonly endPeer: () => void;
	readonly releaseWrite: () => void;
	readonly closed: () => boolean;
}

function makeState(fragment: number): EndpointState {
	let resolveClosed = (): void => {};
	const closedPromise = new NativePromise<void>((resolve) => {
		resolveClosed = resolve;
	});
	return {
		chunks: [],
		buffered: 0,
		closed: false,
		peerEnded: false,
		pending: undefined,
		peer: undefined,
		closedPromise,
		resolveClosed,
		fragment,
		delayWrites: false,
		pendingWrite: undefined,
	};
}

function take(state: EndpointState, length: number): Uint8Array<ArrayBuffer> | undefined {
	if (state.buffered < length) return undefined;
	const result = new Uint8Array(new ArrayBuffer(length));
	let offset = 0;
	while (offset < length) {
		const chunk = state.chunks[0];
		if (chunk === undefined) return undefined;
		const count = Math.min(length - offset, chunk.byteLength);
		result.set(chunk.subarray(0, count), offset);
		offset += count;
		if (count === chunk.byteLength) state.chunks.shift();
		else {
			const rest = new Uint8Array(new ArrayBuffer(chunk.byteLength - count));
			rest.set(chunk.subarray(count));
			chunk.fill(0);
			state.chunks[0] = rest;
		}
	}
	state.buffered -= length;
	return result;
}

function pump(state: EndpointState): void {
	const pending = state.pending;
	if (pending === undefined) return;
	const data = take(state, pending.length);
	if (data !== undefined) {
		state.pending = undefined;
		pending.resolve(Object.freeze({ type: "DATA", data }));
		return;
	}
	if (state.peerEnded) {
		state.pending = undefined;
		pending.resolve(Object.freeze({ type: state.buffered === 0 ? "EOF" : "IO_FAILURE" }));
	}
}

function deliver(state: EndpointState, bytes: Uint8Array): void {
	let offset = 0;
	while (offset < bytes.byteLength) {
		const length = Math.min(state.fragment, bytes.byteLength - offset);
		const chunk = new Uint8Array(new ArrayBuffer(length));
		chunk.set(bytes.subarray(offset, offset + length));
		state.chunks.push(chunk);
		state.buffered += length;
		offset += length;
	}
	pump(state);
}

function endpoint(state: EndpointState): FakeEndpoint {
	const io = Object.freeze({
		readExact(_length: unknown, _timeoutMs: unknown): Promise<undefined> {
			return new NativePromise((resolve) => resolve(undefined));
		},
		writeExact(bytes: unknown, timeoutMs: unknown): Promise<boolean> {
			return new NativePromise((resolve) => {
				if (
					state.closed ||
					state.peer === undefined ||
					state.peer.closed ||
					!(bytes instanceof Uint8Array) ||
					timeoutMs !== 5_000
				) {
					resolve(false);
					return;
				}
				const peer = state.peer;
				if (peer === undefined) {
					resolve(false);
					return;
				}
				const complete = (): void => {
					deliver(peer, bytes);
					resolve(true);
				};
				if (state.delayWrites) state.pendingWrite = complete;
				else complete();
			});
		},
		close(): void {
			if (state.closed) return;
			state.closed = true;
			state.resolveClosed();
			if (state.pending !== undefined) {
				const pending = state.pending;
				state.pending = undefined;
				pending.resolve(Object.freeze({ type: "IO_FAILURE" }));
			}
			if (state.peer !== undefined) {
				state.peer.peerEnded = true;
				pump(state.peer);
			}
			state.pendingWrite?.();
			state.pendingWrite = undefined;
		},
		readClassified(length: unknown, timeoutMs: unknown): Promise<ReadResult> {
			return new NativePromise((resolve) => {
				if (
					state.closed ||
					state.pending !== undefined ||
					typeof length !== "number" ||
					!Number.isSafeInteger(length) ||
					length < 1 ||
					timeoutMs !== 5_000
				) {
					resolve(Object.freeze({ type: "IO_FAILURE" }));
					return;
				}
				const data = take(state, length);
				if (data !== undefined) {
					resolve(Object.freeze({ type: "DATA", data }));
					return;
				}
				if (state.peerEnded) {
					resolve(Object.freeze({ type: state.buffered === 0 ? "EOF" : "IO_FAILURE" }));
					return;
				}
				state.pending = { length, resolve };
			});
		},
		waitClosed(): Promise<void> {
			return state.closedPromise;
		},
	});
	return {
		io,
		inject(bytes: Uint8Array): void {
			deliver(state, bytes);
		},
		endPeer(): void {
			state.peerEnded = true;
			pump(state);
		},
		releaseWrite(): void {
			state.pendingWrite?.();
			state.pendingWrite = undefined;
		},
		closed(): boolean {
			return state.closed;
		},
	};
}

function duplex(fragment = 7): { home: FakeEndpoint; runtime: FakeEndpoint; homeState: EndpointState } {
	const homeState = makeState(fragment);
	const runtimeState = makeState(fragment);
	homeState.peer = runtimeState;
	runtimeState.peer = homeState;
	return { home: endpoint(homeState), runtime: endpoint(runtimeState), homeState };
}

function port(result: ReturnType<typeof createSandboxV31PhysicalPort>): SandboxV31PhysicalPort | undefined {
	expect(result.ok).toBe(true);
	return result.ok ? result.value : undefined;
}

async function turn(): Promise<void> {
	await new NativePromise<void>((resolve) => setTimeout(resolve, 0));
}

describe("V31 authenticated transport physical port", () => {
	test("moves fragmented authenticated frames on all five streams and preserves counters", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex(3);
		const homeResult = createSandboxV31PhysicalPort(link.home.io, pair.home);
		expect(homeResult.ok).toBe(true);
		expect(Object.isFrozen(homeResult)).toBe(true);
		const home = port(homeResult);
		if (home === undefined) return;
		expect(Object.isFrozen(home)).toBe(true);
		expect(Reflect.ownKeys(home)).toEqual(["send", "registerInbound", "close"]);
		const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
		if (runtime === undefined) return;
		expect(await home.send(5, sequence(1, 1))).toEqual({ code: "FAILED" });
		expect(await home.send(0, sequence(1, 262_145))).toEqual({ code: "FAILED" });
		const received: { stream: unknown; bytes: number[] }[] = [];
		expect(runtime.registerInbound(1)).toEqual({ code: "FAILED" });
		expect(
			runtime.registerInbound((stream: unknown, plaintext: unknown) => {
				expect(plaintext instanceof Uint8Array).toBe(true);
				if (!(plaintext instanceof Uint8Array)) return;
				received.push({ stream, bytes: Array.from(plaintext) });
			}),
		).toEqual({ code: "REGISTERED" });
		expect(runtime.registerInbound(() => {})).toEqual({ code: "ALREADY_EXISTS" });
		for (let stream = 0; stream <= 4; stream += 1) {
			expect(await home.send(stream, sequence(stream + 1, stream + 2))).toEqual({ code: "SENT" });
		}
		for (let index = 0; index < 20 && received.length < 5; index += 1) await turn();
		expect(received).toEqual([
			{ stream: 0, bytes: [1, 2] },
			{ stream: 1, bytes: [2, 3, 4] },
			{ stream: 2, bytes: [3, 4, 5, 6] },
			{ stream: 3, bytes: [4, 5, 6, 7, 8] },
			{ stream: 4, bytes: [5, 6, 7, 8, 9, 10] },
		]);
		expect(await home.close()).toEqual({ code: "CLOSED" });
		expect(await runtime.close()).toEqual({ code: "FAILED" });
	});

	test("publishes exact fresh extensible native promises for hostile inherited observation", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		const home = port(createSandboxV31PhysicalPort(link.home.io, pair.home));
		if (home === undefined) return;
		const first = home.send(0, sequence(1, 4));
		await turn();
		await turn();
		const second = home.send(0, sequence(2, 4));
		await turn();
		await turn();
		const closing = home.close();
		await turn();
		let hostileReads = 0;
		const oldConstructor = Object.getOwnPropertyDescriptor(nativePromisePrototype, "constructor");
		const oldSpecies = Object.getOwnPropertyDescriptor(NativePromise, Symbol.species);
		const observed: Promise<unknown>[] = [];
		const values: unknown[] = [];
		let shape: object | undefined;
		let readsAfterObservation = -1;
		try {
			Object.defineProperty(nativePromisePrototype, "constructor", {
				configurable: true,
				get(): unknown {
					hostileReads += 1;
					return JSON.parse("{");
				},
			});
			Object.defineProperty(NativePromise, Symbol.species, {
				configurable: true,
				get(): unknown {
					hostileReads += 1;
					return JSON.parse("{");
				},
			});
			const species = Object.freeze({ [Symbol.species]: NativePromise });
			for (const promise of [first, second, closing]) {
				Object.defineProperty(promise, "constructor", { configurable: true, value: species });
				observed.push(
					nativeThen.call(
						promise,
						(value: unknown) => values.push(value),
						() => values.push("REJECTED"),
					),
				);
				Reflect.deleteProperty(promise, "constructor");
			}
			readsAfterObservation = hostileReads;
			shape = {
				distinct: first !== second,
				firstPrototype: Object.getPrototypeOf(first),
				firstNames: Object.getOwnPropertyNames(first),
				firstSymbols: Object.getOwnPropertySymbols(first),
				firstExtensible: Object.isExtensible(first),
				closePrototype: Object.getPrototypeOf(closing),
				closeExtensible: Object.isExtensible(closing),
			};
		} finally {
			if (oldConstructor !== undefined) Object.defineProperty(nativePromisePrototype, "constructor", oldConstructor);
			if (oldSpecies !== undefined) Object.defineProperty(NativePromise, Symbol.species, oldSpecies);
		}
		await Promise.all(observed);
		expect(values).toEqual([{ code: "SENT" }, { code: "SENT" }, { code: "CLOSED" }]);
		expect(shape).toEqual({
			distinct: true,
			firstPrototype: nativePromisePrototype,
			firstNames: [],
			firstSymbols: [],
			firstExtensible: true,
			closePrototype: nativePromisePrototype,
			closeExtensible: true,
		});
		expect(readsAfterObservation).toBe(0);
	});

	test("fails closed when inherited Promise hooks are hostile before send", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		const home = port(createSandboxV31PhysicalPort(link.home.io, pair.home));
		if (home === undefined) return;
		let hostileReads = 0;
		const oldConstructor = Object.getOwnPropertyDescriptor(nativePromisePrototype, "constructor");
		const oldSpecies = Object.getOwnPropertyDescriptor(NativePromise, Symbol.species);
		let actual: Promise<Readonly<{ code: "SENT" | "FAILED" }>> | undefined;
		let shape: object | undefined;
		try {
			Object.defineProperty(nativePromisePrototype, "constructor", {
				configurable: true,
				get(): unknown {
					hostileReads += 1;
					return JSON.parse("{");
				},
			});
			Object.defineProperty(NativePromise, Symbol.species, {
				configurable: true,
				get(): unknown {
					hostileReads += 1;
					return JSON.parse("{");
				},
			});
			actual = home.send(0, sequence(1, 4));
			shape = {
				prototype: Object.getPrototypeOf(actual),
				names: Object.getOwnPropertyNames(actual),
				symbols: Object.getOwnPropertySymbols(actual),
				extensible: Object.isExtensible(actual),
			};
		} finally {
			if (oldConstructor !== undefined) Object.defineProperty(nativePromisePrototype, "constructor", oldConstructor);
			if (oldSpecies !== undefined) Object.defineProperty(NativePromise, Symbol.species, oldSpecies);
		}
		expect(actual).toBeDefined();
		if (actual === undefined) return;
		expect(shape).toEqual({ prototype: nativePromisePrototype, names: [], symbols: [], extensible: true });
		expect(hostileReads).toBeGreaterThan(0);
		expect(await actual).toEqual({ code: "FAILED" });
		await turn();
		expect(link.home.closed()).toBe(true);
		expect(await home.close()).toEqual({ code: "FAILED" });
	});

	test("revokes concurrent send admission and joins an active close race", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		link.homeState.delayWrites = true;
		const home = port(createSandboxV31PhysicalPort(link.home.io, pair.home));
		if (home === undefined) return;
		const first = home.send(2, sequence(1, 32));
		await turn();
		expect(await home.send(2, sequence(2, 32))).toEqual({ code: "FAILED" });
		const closing = home.close();
		link.home.releaseWrite();
		expect(await first).toEqual({ code: "FAILED" });
		expect(await closing).toEqual({ code: "CLOSED" });
	});

	test("poisons on authenticated replay, tamper, EOF, and oversized header", async () => {
		const faults: Array<"replay" | "tamper" | "eof" | "bound"> = ["replay", "tamper", "eof", "bound"];
		for (const fault of faults) {
			const pair = await channels();
			expect(pair).toBeDefined();
			if (pair === undefined) return;
			const link = duplex();
			const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
			if (runtime === undefined) return;
			const received: number[][] = [];
			expect(
				runtime.registerInbound((_stream: unknown, plaintext: unknown) => {
					if (plaintext instanceof Uint8Array) received.push(Array.from(plaintext));
				}),
			).toEqual({ code: "REGISTERED" });
			if (fault === "eof") link.runtime.endPeer();
			else if (fault === "bound") {
				const header = new Uint8Array(new ArrayBuffer(24));
				new DataView(header.buffer).setUint32(16, 262_145, false);
				link.runtime.inject(header);
			} else {
				const encrypted = await encryptSandboxTransportFrame(pair.home, 1n, sequence(9, 8));
				expect(encrypted.ok).toBe(true);
				if (!encrypted.ok) return;
				const wire = new Uint8Array(encrypted.value);
				if (fault === "tamper") wire[wire.byteLength - 1] ^= 1;
				link.runtime.inject(wire);
				if (fault === "replay") link.runtime.inject(wire);
			}
			await turn();
			await turn();
			expect(link.runtime.closed()).toBe(true);
			expect(await runtime.send(0, sequence(1, 1))).toEqual({ code: "FAILED" });
			expect(await runtime.close()).toEqual({ code: "FAILED" });
			expect(received.length).toBe(fault === "replay" ? 1 : 0);
		}
	});

	test("handles synchronous callback close reentry and callback faults", async () => {
		{
			const pair = await channels();
			expect(pair).toBeDefined();
			if (pair === undefined) return;
			const link = duplex();
			const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
			if (runtime === undefined) return;
			let reentrantSend: Promise<Readonly<{ code: "SENT" | "FAILED" }>> | undefined;
			let reentrantClose: Promise<Readonly<{ code: "CLOSED" | "FAILED" }>> | undefined;
			runtime.registerInbound(() => {
				reentrantSend = runtime.send(3, sequence(7, 2));
				reentrantClose = runtime.close();
			});
			const encrypted = await encryptSandboxTransportFrame(pair.home, 3n, sequence(1, 2));
			expect(encrypted.ok).toBe(true);
			if (!encrypted.ok) return;
			link.runtime.inject(encrypted.value);
			await turn();
			expect(reentrantSend).toBeDefined();
			expect(reentrantClose).toBeDefined();
			if (reentrantSend === undefined || reentrantClose === undefined) return;
			expect(await reentrantSend).toEqual({ code: "FAILED" });
			expect(await reentrantClose).toEqual({ code: "CLOSED" });
		}
		{
			const pair = await channels();
			expect(pair).toBeDefined();
			if (pair === undefined) return;
			const link = duplex();
			const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
			if (runtime === undefined) return;
			runtime.registerInbound(() => {
				JSON.parse("{");
			});
			const encrypted = await encryptSandboxTransportFrame(pair.home, 4n, sequence(1, 2));
			expect(encrypted.ok).toBe(true);
			if (!encrypted.ok) return;
			link.runtime.inject(encrypted.value);
			await turn();
			expect(await runtime.close()).toEqual({ code: "FAILED" });
		}
	});

	test("classifies a read timeout into benign idle without shutting down", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let closed = false;
		const io = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(false));
			},
			close(): void {
				closed = true;
			},
			readClassified(): Promise<Readonly<{ type: "TIMEOUT" }>> {
				return new NativePromise((resolve) => resolve(Object.freeze({ type: "TIMEOUT" })));
			},
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		const runtime = port(createSandboxV31PhysicalPort(io, pair.runtime));
		if (runtime === undefined) return;
		expect(runtime.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		for (let i = 0; i < 20; i += 1) await turn();
		expect(closed).toBe(false);
		expect(await runtime.close()).toEqual({ code: "CLOSED" });
	});

	test("lets V31 detect a decrypted transport/application stream mismatch", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		const runtimePhysical = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
		if (runtimePhysical === undefined) return;
		const runtime = createRuntimeMultiplexer(runtimePhysical, { dispatchApplication(): void {} });
		expect("code" in runtime).toBe(false);
		if ("code" in runtime) return;
		const encoded = encodeAppFrame(KIND_REQUEST, 2, 1n, sequence(1, 1));
		expect(encoded.ok).toBe(true);
		if (!encoded.ok) return;
		const encrypted = await encryptSandboxTransportFrame(pair.home, 1n, encoded.frame);
		expect(encrypted.ok).toBe(true);
		if (!encrypted.ok) return;
		link.runtime.inject(encrypted.value);
		await turn();
		await turn();
		expect(await runtime.close()).toEqual({ code: "POISONED" });
	});

	test("reports synchronous receive-arm failure during registration", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let closes = 0;
		const io = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(false));
			},
			close(): void {
				closes += 1;
			},
			readClassified(): null {
				return null;
			},
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		const physical = port(createSandboxV31PhysicalPort(io, pair.runtime));
		if (physical === undefined) return;
		expect(physical.registerInbound(() => {})).toEqual({ code: "FAILED" });
		expect(physical.registerInbound(() => {})).toEqual({ code: "ALREADY_EXISTS" });
		expect(closes).toBe(1);
		expect(await physical.close()).toEqual({ code: "FAILED" });
	});

	test("repeated 1000 header timeouts then valid frame dispatch", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
		if (runtime === undefined) return;
		const received: { stream: number; bytes: number[] }[] = [];
		expect(
			runtime.registerInbound((stream: unknown, plaintext: unknown) => {
				expect(typeof stream).toBe("number");
				expect(plaintext instanceof Uint8Array).toBe(true);
				if (typeof stream !== "number" || !(plaintext instanceof Uint8Array)) return;
				received.push({ stream, bytes: Array.from(plaintext) });
			}),
		).toEqual({ code: "REGISTERED" });
		for (let i = 0; i < 1000; i += 1) await turn();
		const encrypted = await encryptSandboxTransportFrame(pair.home, 2n, sequence(10, 5));
		expect(encrypted.ok).toBe(true);
		if (!encrypted.ok) return;
		link.runtime.inject(encrypted.value);
		for (let i = 0; i < 20; i += 1) await turn();
		expect(received).toEqual([{ stream: 2, bytes: [10, 11, 12, 13, 14] }]);
		expect(link.runtime.closed()).toBe(false);
		expect(await runtime.close()).toEqual({ code: "CLOSED" });
	});

	test("timeout-close reentrancy closes cleanly", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
		if (runtime === undefined) return;
		expect(runtime.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		await turn();
		const closing = runtime.close();
		expect(await closing).toEqual({ code: "CLOSED" });
		expect(link.runtime.closed()).toBe(true);
	});

	test("mid-frame timeout is terminal failure", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let callIndex = 0;
		let closed = false;
		const io = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(false));
			},
			close(): void {
				closed = true;
			},
			readClassified(length: unknown, timeoutMs: unknown): Promise<unknown> {
				callIndex += 1;
				if (typeof length !== "number" || typeof timeoutMs !== "number") {
					return new NativePromise((resolve) => resolve(Object.freeze({ type: "IO_FAILURE" })));
				}
				if (callIndex === 1) {
					const bytes = new Uint8Array(new ArrayBuffer(length));
					return new NativePromise((resolve) => resolve(Object.freeze({ type: "DATA", data: bytes })));
				}
				return new NativePromise((resolve) => resolve(Object.freeze({ type: "TIMEOUT" })));
			},
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		const mid = port(createSandboxV31PhysicalPort(io, pair.runtime));
		if (mid === undefined) return;
		expect(mid.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		for (let i = 0; i < 20; i += 1) await turn();
		expect(closed).toBe(true);
		expect(await mid.close()).toEqual({ code: "FAILED" });
	});

	test("malformed timeout variants are terminal failure", async () => {
		const malformed: Array<() => unknown> = [
			() => Object.freeze({ type: "TIMEOUT", extra: true }),
			() => ({ type: "TIMEOUT" }),
			() => {
				const obj = { type: "TIMEOUT" };
				Object.defineProperty(obj, "type", { get: () => "TIMEOUT" });
				return Object.freeze(obj);
			},
			() => new Proxy({ type: "TIMEOUT" }, {}),
		];
		for (const make of malformed) {
			const pair = await channels();
			expect(pair).toBeDefined();
			if (pair === undefined) return;
			let closed = false;
			const io = Object.freeze({
				readExact(): Promise<undefined> {
					return new NativePromise((resolve) => resolve(undefined));
				},
				writeExact(): Promise<boolean> {
					return new NativePromise((resolve) => resolve(false));
				},
				close(): void {
					closed = true;
				},
				readClassified(): Promise<unknown> {
					return new NativePromise((resolve) => resolve(make()));
				},
				waitClosed(): Promise<void> {
					return new NativePromise((resolve) => resolve());
				},
			});
			const p = port(createSandboxV31PhysicalPort(io, pair.runtime));
			if (p === undefined) return;
			expect(p.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
			await turn();
			expect(closed).toBe(true);
			expect(await p.close()).toEqual({ code: "FAILED" });
		}
	});

	test("timeout then IO or EOF is terminal failure", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		const link = duplex();
		const runtime = port(createSandboxV31PhysicalPort(link.runtime.io, pair.runtime));
		if (runtime === undefined) return;
		expect(runtime.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		link.runtime.endPeer();
		await turn();
		expect(link.runtime.closed()).toBe(true);
		expect(await runtime.close()).toEqual({ code: "FAILED" });
	});

	test("exact one pending read during timeout loops", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let pendingCount = 0;
		let maxPending = 0;
		const io = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(false));
			},
			close(): void {},
			readClassified(): Promise<Readonly<{ type: "TIMEOUT" }>> {
				pendingCount += 1;
				maxPending = Math.max(maxPending, pendingCount);
				return new NativePromise((resolve) => {
					setTimeout(() => {
						pendingCount -= 1;
						resolve(Object.freeze({ type: "TIMEOUT" }));
					}, 0);
				});
			},
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		const p = port(createSandboxV31PhysicalPort(io, pair.runtime));
		if (p === undefined) return;
		expect(p.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		for (let i = 0; i < 10; i += 1) await new NativePromise((r) => setTimeout(r, 0));
		expect(maxPending).toBeLessThanOrEqual(1);
		expect(await p.close()).toEqual({ code: "CLOSED" });
	});

	test("late timeout settlement after close is inert", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let resolveLate: ((value: unknown) => void) | undefined;
		let closed = false;
		const io = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(false));
			},
			close(): void {
				closed = true;
				resolveLate?.(Object.freeze({ type: "IO_FAILURE" }));
				resolveLate = undefined;
			},
			readClassified(): Promise<unknown> {
				return new NativePromise((resolve) => {
					resolveLate = (value: unknown) => resolve(value);
				});
			},
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		const p = port(createSandboxV31PhysicalPort(io, pair.runtime));
		if (p === undefined) return;
		expect(p.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		expect(await p.close()).toEqual({ code: "CLOSED" });
		expect(closed).toBe(true);
		resolveLate?.(Object.freeze({ type: "TIMEOUT" }));
		await turn();
		expect(await p.close()).toEqual({ code: "CLOSED" });
	});

	test("no stack overflow from rapid sequential header timeouts", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let count = 0;
		const io = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(false));
			},
			close(): void {},
			readClassified(): Promise<Readonly<{ type: "TIMEOUT" }>> {
				count += 1;
				return new NativePromise((resolve) => resolve(Object.freeze({ type: "TIMEOUT" })));
			},
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		const p = port(createSandboxV31PhysicalPort(io, pair.runtime));
		if (p === undefined) return;
		expect(p.registerInbound(() => {})).toEqual({ code: "REGISTERED" });
		for (let i = 0; i < 50; i += 1) await turn();
		expect(count).toBeGreaterThanOrEqual(50);
		expect(await p.close()).toEqual({ code: "CLOSED" });
	});

	test("rejects invalid factory inputs without taking ownership", async () => {
		const pair = await channels();
		expect(pair).toBeDefined();
		if (pair === undefined) return;
		let closes = 0;
		const badIo = Object.freeze({
			readExact(): Promise<undefined> {
				return new NativePromise((resolve) => resolve(undefined));
			},
			writeExact(): Promise<boolean> {
				return new NativePromise((resolve) => resolve(true));
			},
			close(): void {
				closes += 1;
			},
			readClassified: 1,
			waitClosed(): Promise<void> {
				return new NativePromise((resolve) => resolve());
			},
		});
		expect(createSandboxV31PhysicalPort(badIo, pair.home)).toEqual({ ok: false, code: "INPUT_INVALID" });
		expect(createSandboxV31PhysicalPort(new Proxy({}, {}), pair.home)).toEqual({
			ok: false,
			code: "INPUT_INVALID",
		});
		expect(closes).toBe(0);
		const link = duplex();
		const accepted = createSandboxV31PhysicalPort(link.home.io, pair.home);
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(await accepted.value.close()).toEqual({ code: "CLOSED" });
	});
});
