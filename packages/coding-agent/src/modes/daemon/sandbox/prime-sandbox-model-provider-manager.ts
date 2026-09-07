// Model Stream Provider Manager V34
// Root: MODEL_STREAM_PROVIDER_MANAGER_V34_ROOT_CORRECTIONS.md

import { isPromise, isProxy } from "node:util/types";
import { decodeModelRequestBytes, encodeModelReply } from "./prime-sandbox-model-codec.js";

const apply: typeof Reflect.apply = Reflect.apply;
const then: typeof Promise.prototype.then = Promise.prototype.then;
const freeze: typeof Object.freeze = Object.freeze;
const isFrozen: typeof Object.isFrozen = Object.isFrozen;
const getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const ownKeys: typeof Reflect.ownKeys = Reflect.ownKeys;
const numberIsInteger: typeof Number.isInteger = Number.isInteger;
const stringValue: StringConstructor = String;
const NativePromise: PromiseConstructor = Promise;
const NativeArray: ArrayConstructor = Array;
const promisePrototype: object = Promise.prototype;
const objectPrototype: object = Object.prototype;
const abortSignalPrototype: object = AbortSignal.prototype;
const arrayBufferPrototype: object = ArrayBuffer.prototype;
const typedArrayPrototype: object = getPrototypeOf(Uint8Array.prototype);
const uint8ArrayPrototype: object = Uint8Array.prototype;
const addEventListener: typeof EventTarget.prototype.addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener: typeof EventTarget.prototype.removeEventListener = EventTarget.prototype.removeEventListener;
const fillBytes: typeof Uint8Array.prototype.fill = Uint8Array.prototype.fill;
const speciesSymbol: symbol = Symbol.species;

const abortedDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(abortSignalPrototype, "aborted");
const bufferDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(typedArrayPrototype, "buffer");
const byteLengthDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteLength",
);
const byteOffsetDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(
	typedArrayPrototype,
	"byteOffset",
);
const arrayBufferLengthDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(
	arrayBufferPrototype,
	"byteLength",
);
const promiseConstructorDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(
	promisePrototype,
	"constructor",
);
const promiseSpeciesDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(NativePromise, speciesSymbol);
const nativeElementDescriptor: PropertyDescriptor | undefined = getOwnPropertyDescriptor(new Uint8Array(1), "0");

const abortedGetter: (() => unknown) | null =
	abortedDescriptor !== undefined && typeof abortedDescriptor.get === "function" ? abortedDescriptor.get : null;
const bufferGetter: (() => unknown) | null =
	bufferDescriptor !== undefined && typeof bufferDescriptor.get === "function" ? bufferDescriptor.get : null;
const byteLengthGetter: (() => unknown) | null =
	byteLengthDescriptor !== undefined && typeof byteLengthDescriptor.get === "function"
		? byteLengthDescriptor.get
		: null;
const byteOffsetGetter: (() => unknown) | null =
	byteOffsetDescriptor !== undefined && typeof byteOffsetDescriptor.get === "function"
		? byteOffsetDescriptor.get
		: null;
const arrayBufferLengthGetter: (() => unknown) | null =
	arrayBufferLengthDescriptor !== undefined && typeof arrayBufferLengthDescriptor.get === "function"
		? arrayBufferLengthDescriptor.get
		: null;
const promiseSpeciesGetter: (() => unknown) | null =
	promiseSpeciesDescriptor !== undefined && typeof promiseSpeciesDescriptor.get === "function"
		? promiseSpeciesDescriptor.get
		: null;

const MAX_PROVIDER_TASKS = 32;
const MAX_TASKS = 64;

type ShutdownResult = Readonly<{ code: "SHUT_DOWN" }> | Readonly<{ code: "POISONED" }>;
type PhysicalResult = Readonly<{ code: "SHUT_DOWN" }> | Readonly<{ code: "FAILED" }>;
type AbortOutcome = Readonly<{ kind: "CANCELLED" }> | Readonly<{ kind: "REVOKED" }>;
type RaceOutcome =
	| Readonly<{ kind: "PROVIDER_VALUE"; value: unknown }>
	| Readonly<{ kind: "PROVIDER_REJECTED" }>
	| AbortOutcome;

type Manager = Readonly<{
	dispatchApplication: (bundleRaw: unknown) => void;
	shutdown: () => Promise<ShutdownResult>;
}>;

type ReplyCall = (value: unknown) => unknown;

type ProviderInvoke = (request: unknown, signal: AbortSignal) => unknown;

interface ProviderPort {
	readonly invoke: ProviderInvoke;
}

type ShutdownCall = () => unknown;

interface ShutdownPort {
	readonly invoke: ShutdownCall;
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

interface AbortCell {
	active: boolean;
	readonly signal: AbortSignal;
	readonly handler: (event: Event) => void;
	resolve: ((value: AbortOutcome) => void) | null;
}

interface Task {
	readonly index: number;
	providerReserved: boolean;
	suppressed: boolean;
	revoked: boolean;
	cancelled: boolean;
	providerObserved: boolean;
	providerBranchObserved: boolean;
	abortObserved: boolean;
	abortBranchObserved: boolean;
	decisionObserved: boolean;
	replyObserved: boolean;
	fixedReplyObserved: boolean;
	reply: ReplyCall | null;
	originalBytes: Uint8Array | null;
	encodedBytes: Uint8Array | null;
	abortCell: AbortCell | null;
	providerActual: Promise<unknown> | null;
	providerActualObserver: Promise<void> | null;
	abortSource: Promise<AbortOutcome> | null;
	abortSourceObserver: Promise<void> | null;
	raceOutcome: Promise<RaceOutcome> | null;
	providerRaceBranch: Promise<void> | null;
	providerRaceBranchObserver: Promise<void> | null;
	abortRaceBranch: Promise<void> | null;
	abortRaceBranchObserver: Promise<void> | null;
	decision: Promise<void> | null;
	decisionObserver: Promise<void> | null;
	replyActual: Promise<unknown> | null;
	replyActualObserver: Promise<void> | null;
	fixedErrorReplyActual: Promise<unknown> | null;
	fixedErrorReplyObserver: Promise<void> | null;
}

function thenApply<T, A, B>(
	promise: Promise<T>,
	onFulfilled: (value: T) => A | PromiseLike<A>,
	onRejected: (error: unknown) => B | PromiseLike<B>,
): Promise<A | B> {
	return apply(then, promise, [onFulfilled, onRejected]);
}

function resolved<T>(value: T): Promise<T> {
	return new NativePromise<T>((resolve: (result: T) => void): void => {
		resolve(value);
	});
}

function deferred<T>(): Deferred<T> | null {
	const box: { resolve: ((value: T) => void) | null } = { resolve: null };
	let promise: Promise<T>;
	try {
		promise = new NativePromise<T>((resolve: (value: T) => void): void => {
			box.resolve = resolve;
		});
	} catch {
		return null;
	}
	const resolve = box.resolve;
	if (resolve === null) return null;
	return { promise, resolve };
}

function frozenShutdown(code: "SHUT_DOWN" | "POISONED"): ShutdownResult {
	return freeze({ code });
}

function frozenPhysical(code: "SHUT_DOWN" | "FAILED"): PhysicalResult {
	return freeze({ code });
}

function internalError(): Readonly<{ ok: false; code: "INTERNAL_ERROR" }> {
	return freeze({ ok: false, code: "INTERNAL_ERROR" });
}

function proxyFree(value: object): boolean {
	try {
		return !isProxy(value);
	} catch {
		return false;
	}
}

function captureProvide(raw: unknown): ProviderPort | null {
	if ((typeof raw !== "object" && typeof raw !== "function") || raw === null) return null;
	if (!proxyFree(raw)) return null;
	try {
		if (!isFrozen(raw) || getPrototypeOf(raw) !== objectPrototype) return null;
		const keys = ownKeys(raw);
		if (keys.length !== 1 || keys[0] !== "provide") return null;
		const descriptor = getOwnPropertyDescriptor(raw, "provide");
		if (descriptor === undefined) return null;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
		const method: unknown = descriptor.value;
		if (typeof method !== "function" || !proxyFree(method)) return null;
		return {
			invoke: (request: unknown, signal: AbortSignal): unknown => apply(method, raw, [request, signal]),
		};
	} catch {
		return null;
	}
}

function captureShutdown(raw: unknown): ShutdownPort | null {
	if ((typeof raw !== "object" && typeof raw !== "function") || raw === null) return null;
	if (!proxyFree(raw)) return null;
	try {
		if (!isFrozen(raw) || getPrototypeOf(raw) !== objectPrototype) return null;
		const keys = ownKeys(raw);
		if (keys.length !== 1 || keys[0] !== "shutdown") return null;
		const descriptor = getOwnPropertyDescriptor(raw, "shutdown");
		if (descriptor === undefined) return null;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
		const method: unknown = descriptor.value;
		if (typeof method !== "function" || !proxyFree(method)) return null;
		return {
			invoke: (): unknown => apply(method, raw, []),
		};
	} catch {
		return null;
	}
}

function promiseInvariantsHold(): boolean {
	if (promiseSpeciesGetter === null) return false;
	if (promiseConstructorDescriptor === undefined || promiseSpeciesDescriptor === undefined) return false;
	try {
		const constructorNow = getOwnPropertyDescriptor(promisePrototype, "constructor");
		const speciesNow = getOwnPropertyDescriptor(NativePromise, speciesSymbol);
		if (constructorNow === undefined || speciesNow === undefined) return false;
		if (constructorNow.value !== NativePromise) return false;
		if (constructorNow.get !== undefined || constructorNow.set !== undefined) return false;
		if (constructorNow.writable !== promiseConstructorDescriptor.writable) return false;
		if (constructorNow.enumerable !== promiseConstructorDescriptor.enumerable) return false;
		if (constructorNow.configurable !== promiseConstructorDescriptor.configurable) return false;
		if (speciesNow.get !== promiseSpeciesGetter || speciesNow.set !== promiseSpeciesDescriptor.set) return false;
		if (speciesNow.enumerable !== promiseSpeciesDescriptor.enumerable) return false;
		if (speciesNow.configurable !== promiseSpeciesDescriptor.configurable) return false;
		return apply(promiseSpeciesGetter, NativePromise, []) === NativePromise;
	} catch {
		return false;
	}
}

function exactNativePromise(value: unknown): value is Promise<unknown> {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (!isPromise(value) || !proxyFree(value)) return false;
		if (getPrototypeOf(value) !== promisePrototype) return false;
		if (getOwnPropertyNames(value).length !== 0) return false;
		if (getOwnPropertySymbols(value).length !== 0) return false;
		return promiseInvariantsHold();
	} catch {
		return false;
	}
}

function exactAbortSignal(value: unknown): value is AbortSignal {
	if (typeof value !== "object" || value === null || abortedGetter === null) return false;
	try {
		if (!proxyFree(value) || getPrototypeOf(value) !== abortSignalPrototype) return false;
		if (getOwnPropertyNames(value).length !== 0 || getOwnPropertySymbols(value).length !== 0) return false;
		return typeof apply(abortedGetter, value, []) === "boolean";
	} catch {
		return false;
	}
}

function signalAborted(signal: AbortSignal): boolean | null {
	if (abortedGetter === null) return null;
	try {
		const value: unknown = apply(abortedGetter, signal, []);
		return typeof value === "boolean" ? value : null;
	} catch {
		return null;
	}
}

function exactOwnedBytes(value: unknown): value is Uint8Array {
	if (typeof value !== "object" || value === null) return false;
	if (
		bufferGetter === null ||
		byteLengthGetter === null ||
		byteOffsetGetter === null ||
		arrayBufferLengthGetter === null ||
		nativeElementDescriptor === undefined
	) {
		return false;
	}
	try {
		if (!proxyFree(value) || getPrototypeOf(value) !== uint8ArrayPrototype) return false;
		const offset: unknown = apply(byteOffsetGetter, value, []);
		const length: unknown = apply(byteLengthGetter, value, []);
		const buffer: unknown = apply(bufferGetter, value, []);
		if (typeof offset !== "number" || offset !== 0) return false;
		if (typeof length !== "number" || !numberIsInteger(length) || length < 0) return false;
		if (typeof buffer !== "object" || buffer === null || !proxyFree(buffer)) return false;
		if (getPrototypeOf(buffer) !== arrayBufferPrototype) return false;
		const bufferLength: unknown = apply(arrayBufferLengthGetter, buffer, []);
		if (bufferLength !== length) return false;
		if (getOwnPropertySymbols(value).length !== 0) return false;
		const names = getOwnPropertyNames(value);
		if (names.length !== length) return false;
		for (let index = 0; index < names.length; index += 1) {
			const name = names[index];
			if (name !== stringValue(index)) return false;
			const descriptor = getOwnPropertyDescriptor(value, name);
			if (descriptor === undefined) return false;
			if (descriptor.get !== undefined || descriptor.set !== undefined) return false;
			if (descriptor.writable !== nativeElementDescriptor.writable) return false;
			if (descriptor.enumerable !== nativeElementDescriptor.enumerable) return false;
			if (descriptor.configurable !== nativeElementDescriptor.configurable) return false;
			if (typeof descriptor.value !== "number") return false;
			if (!numberIsInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > 255) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function zeroBytes(value: Uint8Array): boolean {
	try {
		return apply(fillBytes, value, [0]) === value;
	} catch {
		return false;
	}
}

function exactCode(value: unknown, code: string): boolean {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (!proxyFree(value) || getPrototypeOf(value) !== objectPrototype) return false;
		const keys = ownKeys(value);
		if (keys.length !== 1 || keys[0] !== "code") return false;
		const descriptor = getOwnPropertyDescriptor(value, "code");
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return false;
		return descriptor.value === code;
	} catch {
		return false;
	}
}

function invalidExactBundlePayload(raw: unknown): Uint8Array | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (!proxyFree(raw) || !isFrozen(raw) || getPrototypeOf(raw) !== objectPrototype) return null;
		const keys = ownKeys(raw);
		if (keys.length !== 5) return null;
		const expected = ["origin", "stream", "payload", "signal", "reply"];
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index];
			if (typeof key !== "string") return null;
			let found = false;
			for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
				if (key === expected[expectedIndex]) found = true;
			}
			if (!found) return null;
			const descriptor = getOwnPropertyDescriptor(raw, key);
			if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return null;
		}
		const payloadDescriptor = getOwnPropertyDescriptor(raw, "payload");
		if (payloadDescriptor === undefined) return null;
		const payload: unknown = payloadDescriptor.value;
		return exactOwnedBytes(payload) ? payload : null;
	} catch {
		return null;
	}
}

interface Bundle {
	readonly payload: Uint8Array;
	readonly signal: AbortSignal;
	readonly reply: ReplyCall;
}

function captureBundle(raw: unknown): Bundle | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (!proxyFree(raw) || !isFrozen(raw) || getPrototypeOf(raw) !== objectPrototype) return null;
		const keys = ownKeys(raw);
		if (keys.length !== 5) return null;
		const expected = ["origin", "stream", "payload", "signal", "reply"];
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index];
			if (typeof key !== "string") return null;
			let found = false;
			for (let expectedIndex = 0; expectedIndex < expected.length; expectedIndex += 1) {
				if (key === expected[expectedIndex]) found = true;
			}
			if (!found) return null;
		}
		const originDescriptor = getOwnPropertyDescriptor(raw, "origin");
		const streamDescriptor = getOwnPropertyDescriptor(raw, "stream");
		const payloadDescriptor = getOwnPropertyDescriptor(raw, "payload");
		const signalDescriptor = getOwnPropertyDescriptor(raw, "signal");
		const replyDescriptor = getOwnPropertyDescriptor(raw, "reply");
		if (
			originDescriptor === undefined ||
			streamDescriptor === undefined ||
			payloadDescriptor === undefined ||
			signalDescriptor === undefined ||
			replyDescriptor === undefined
		) {
			return null;
		}
		const descriptors = [originDescriptor, streamDescriptor, payloadDescriptor, signalDescriptor, replyDescriptor];
		for (let index = 0; index < descriptors.length; index += 1) {
			const descriptor = descriptors[index];
			if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
		}
		if (originDescriptor.value !== "Runtime" || streamDescriptor.value !== 0) return null;
		const payload: unknown = payloadDescriptor.value;
		const signal: unknown = signalDescriptor.value;
		const reply: unknown = replyDescriptor.value;
		if (!exactOwnedBytes(payload) || !exactAbortSignal(signal)) return null;
		if (typeof reply !== "function" || !proxyFree(reply)) return null;
		return {
			payload,
			signal,
			reply: (value: unknown): unknown => apply(reply, undefined, [value]),
		};
	} catch {
		return null;
	}
}

function makeTask(index: number, reply: ReplyCall, payload: Uint8Array): Task {
	return {
		index,
		providerReserved: false,
		suppressed: false,
		revoked: false,
		cancelled: false,
		providerObserved: false,
		providerBranchObserved: false,
		abortObserved: false,
		abortBranchObserved: false,
		decisionObserved: false,
		replyObserved: false,
		fixedReplyObserved: false,
		reply,
		originalBytes: payload,
		encodedBytes: null,
		abortCell: null,
		providerActual: null,
		providerActualObserver: null,
		abortSource: null,
		abortSourceObserver: null,
		raceOutcome: null,
		providerRaceBranch: null,
		providerRaceBranchObserver: null,
		abortRaceBranch: null,
		abortRaceBranchObserver: null,
		decision: null,
		decisionObserver: null,
		replyActual: null,
		replyActualObserver: null,
		fixedErrorReplyActual: null,
		fixedErrorReplyObserver: null,
	};
}

export function createModelStreamProviderManager(providerRaw: unknown, physicalShutdownRaw: unknown): Manager {
	const provider = captureProvide(providerRaw);
	const physical = captureShutdown(physicalShutdownRaw);
	const shutDownResult = frozenShutdown("SHUT_DOWN");
	const poisonedResult = frozenShutdown("POISONED");
	if (provider === null || physical === null || !promiseInvariantsHold()) {
		const failed = resolved(poisonedResult);
		return freeze({
			dispatchApplication: (_bundleRaw: unknown): void => {
				return;
			},
			shutdown: (): Promise<ShutdownResult> => failed,
		});
	}
	let providerCapability: ProviderInvoke | null = provider.invoke;
	let physicalCapability: ShutdownCall | null = physical.invoke;

	const tasks = new NativeArray<Task | null>(MAX_TASKS);
	for (let index = 0; index < MAX_TASKS; index += 1) tasks[index] = null;
	const startup: Promise<void> = resolved(undefined);
	let providerCount = 0;
	let closing = false;
	let poisoned = false;
	let physicalCalled = false;
	let physicalProved = false;
	let _physicalActual: Promise<unknown> | null = null;
	let physicalShutdownChain: Promise<PhysicalResult> | null = null;
	let shutdownSource: Promise<void> | null = null;
	let _shutdownJoin: Promise<void> | null = null;
	let _shutdownJoinObserver: Promise<ShutdownResult> | null = null;
	let _shutdownReturnedObserver: Promise<void> | null = null;
	let _shutdownOwnedObserver: Promise<void> | null = null;
	let _shutdownPhysicalObserver: Promise<void> | null = null;
	let _shutdownJoinBranches: Array<Promise<void>> | null = null;
	let cachedShutdownChain: Promise<ShutdownResult> | null = null;

	function releaseProvider(task: Task): void {
		if (!task.providerReserved) return;
		task.providerReserved = false;
		if (providerCount > 0) providerCount -= 1;
	}

	function clearTask(task: Task): void {
		task.revoked = true;
		task.suppressed = true;
		task.reply = null;
		if (task.originalBytes !== null) {
			zeroBytes(task.originalBytes);
			task.originalBytes = null;
		}
		if (task.encodedBytes !== null) {
			zeroBytes(task.encodedBytes);
			task.encodedBytes = null;
		}
		task.abortCell = null;
		task.providerActual = null;
		task.providerActualObserver = null;
		task.abortSource = null;
		task.abortSourceObserver = null;
		task.raceOutcome = null;
		task.providerRaceBranch = null;
		task.providerRaceBranchObserver = null;
		task.abortRaceBranch = null;
		task.abortRaceBranchObserver = null;
		task.decision = null;
		task.decisionObserver = null;
		task.replyActual = null;
		task.replyActualObserver = null;
		task.fixedErrorReplyActual = null;
		task.fixedErrorReplyObserver = null;
		tasks[task.index] = null;
	}

	function maybeRetire(task: Task): void {
		if (task.revoked) return;
		if (task.fixedErrorReplyActual !== null) {
			if (task.fixedReplyObserved) clearTask(task);
			return;
		}
		if (task.providerActual === null) {
			if (task.replyActual === null || task.replyObserved) clearTask(task);
			return;
		}
		if (!task.providerObserved || !task.providerBranchObserved) return;
		if (!task.abortObserved || !task.abortBranchObserved) return;
		if (!task.decisionObserved) return;
		if (task.replyActual !== null && !task.replyObserved) return;
		clearTask(task);
	}

	function allocateTask(reply: ReplyCall, payload: Uint8Array): Task | null {
		for (let index = 0; index < MAX_TASKS; index += 1) {
			if (tasks[index] === null) {
				const task = makeTask(index, reply, payload);
				tasks[index] = task;
				return task;
			}
		}
		return null;
	}

	function resolveAbort(task: Task, outcome: AbortOutcome): void {
		const cell = task.abortCell;
		if (cell === null || !cell.active) return;
		cell.active = false;
		const resolve = cell.resolve;
		cell.resolve = null;
		if (outcome.kind === "CANCELLED") task.cancelled = true;
		if (resolve !== null) resolve(outcome);
	}

	function callPhysical(): void {
		if (physicalCalled) return;
		physicalCalled = true;
		const capability = physicalCapability;
		physicalCapability = null;
		if (capability === null) {
			physicalShutdownChain = resolved(frozenPhysical("FAILED"));
			return;
		}
		let raw: unknown;
		try {
			raw = capability();
		} catch {
			physicalShutdownChain = resolved(frozenPhysical("FAILED"));
			return;
		}
		if (!exactNativePromise(raw)) {
			physicalShutdownChain = resolved(frozenPhysical("FAILED"));
			return;
		}
		_physicalActual = raw;
		physicalShutdownChain = thenApply(
			raw,
			(value: unknown): PhysicalResult => {
				if (!exactCode(value, "SHUT_DOWN")) return frozenPhysical("FAILED");
				physicalProved = true;
				for (let index = 0; index < MAX_TASKS; index += 1) {
					const task = tasks[index];
					if (task !== null) {
						releaseProvider(task);
						clearTask(task);
					}
				}
				return frozenPhysical("SHUT_DOWN");
			},
			(_error: unknown): PhysicalResult => frozenPhysical("FAILED"),
		);
	}

	function poison(): void {
		if (poisoned) return;
		poisoned = true;
		closing = true;
		providerCapability = null;
		for (let index = 0; index < MAX_TASKS; index += 1) {
			const task = tasks[index];
			if (task !== null) {
				task.suppressed = true;
				removeListener(task, freeze({ kind: "REVOKED" }));
			}
		}
		callPhysical();
	}

	function removeListener(task: Task, outcome: AbortOutcome): void {
		const cell = task.abortCell;
		if (cell === null) return;
		resolveAbort(task, outcome);
		let removal: unknown;
		try {
			removal = apply(removeEventListener, cell.signal, ["abort", cell.handler]);
		} catch {
			task.abortCell = null;
			poison();
			return;
		}
		task.abortCell = null;
		if (removal !== undefined) poison();
	}

	function observeReply(task: Task, raw: unknown, fixed: boolean): void {
		if (!exactNativePromise(raw)) {
			poison();
			return;
		}
		if (fixed) task.fixedErrorReplyActual = raw;
		else task.replyActual = raw;
		const observer = thenApply(
			raw,
			(value: unknown): void => {
				if (
					!exactCode(value, "SENT") &&
					!exactCode(value, "CANCELLED") &&
					!exactCode(value, "POISONED") &&
					!exactCode(value, "CLOSED")
				) {
					poison();
				}
				if (fixed) task.fixedReplyObserved = true;
				else task.replyObserved = true;
				maybeRetire(task);
			},
			(_error: unknown): void => {
				if (fixed) task.fixedReplyObserved = true;
				else task.replyObserved = true;
				poison();
				maybeRetire(task);
			},
		);
		if (fixed) task.fixedErrorReplyObserver = observer;
		else task.replyActualObserver = observer;
	}

	function commitEncoded(task: Task, outcome: unknown, fixed: boolean): void {
		if (task.suppressed || task.revoked || closing) return;
		let encoded: ReturnType<typeof encodeModelReply>;
		try {
			encoded = encodeModelReply(outcome);
		} catch {
			try {
				encoded = encodeModelReply(internalError());
			} catch {
				poison();
				return;
			}
		}
		if (!encoded.ok) {
			try {
				encoded = encodeModelReply(internalError());
			} catch {
				poison();
				return;
			}
		}
		if (!encoded.ok || !exactOwnedBytes(encoded.bytes)) {
			poison();
			return;
		}
		const bytes = encoded.bytes;
		task.encodedBytes = bytes;
		const reply = task.reply;
		if (reply === null) {
			zeroBytes(bytes);
			task.encodedBytes = null;
			poison();
			return;
		}
		let rawReply: unknown;
		let invoked = false;
		try {
			rawReply = reply(bytes);
			invoked = true;
		} catch {
			task.suppressed = true;
			poison();
		} finally {
			if (!zeroBytes(bytes)) poison();
			task.encodedBytes = null;
		}
		if (!invoked) return;
		observeReply(task, rawReply, fixed);
	}

	function commitInternalError(task: Task, fixed: boolean): void {
		commitEncoded(task, internalError(), fixed);
	}

	function installRace(task: Task, actual: Promise<unknown>, signal: AbortSignal): boolean {
		const abortDeferred = deferred<AbortOutcome>();
		const raceDeferred = deferred<RaceOutcome>();
		if (abortDeferred === null || raceDeferred === null) return false;
		const abortGate: Deferred<AbortOutcome> = abortDeferred;
		const raceGate: Deferred<RaceOutcome> = raceDeferred;
		task.providerActual = actual;
		task.abortSource = abortGate.promise;
		task.raceOutcome = raceGate.promise;
		let raceSettled = false;
		function settleRace(outcome: RaceOutcome): void {
			if (raceSettled) return;
			raceSettled = true;
			raceGate.resolve(outcome);
		}

		task.providerActualObserver = thenApply(
			actual,
			(_value: unknown): void => {
				task.providerObserved = true;
				releaseProvider(task);
				maybeRetire(task);
			},
			(_error: unknown): void => {
				task.providerObserved = true;
				releaseProvider(task);
				maybeRetire(task);
			},
		);
		task.abortSourceObserver = thenApply(
			abortGate.promise,
			(_value: AbortOutcome): void => {
				task.abortObserved = true;
				maybeRetire(task);
			},
			(_error: unknown): void => {
				task.abortObserved = true;
				poison();
				maybeRetire(task);
			},
		);
		task.providerRaceBranch = thenApply(
			actual,
			(value: unknown): void => {
				settleRace(freeze({ kind: "PROVIDER_VALUE", value }));
			},
			(_error: unknown): void => {
				settleRace(freeze({ kind: "PROVIDER_REJECTED" }));
			},
		);
		task.abortRaceBranch = thenApply(
			abortGate.promise,
			(value: AbortOutcome): void => {
				settleRace(value);
			},
			(_error: unknown): void => {
				poison();
				settleRace(freeze({ kind: "REVOKED" }));
			},
		);
		const providerBranch = task.providerRaceBranch;
		const abortBranch = task.abortRaceBranch;
		task.providerRaceBranchObserver = thenApply(
			providerBranch,
			(): void => {
				task.providerBranchObserved = true;
				maybeRetire(task);
			},
			(_error: unknown): void => {
				task.providerBranchObserved = true;
				poison();
				maybeRetire(task);
			},
		);
		task.abortRaceBranchObserver = thenApply(
			abortBranch,
			(): void => {
				task.abortBranchObserved = true;
				maybeRetire(task);
			},
			(_error: unknown): void => {
				task.abortBranchObserved = true;
				poison();
				maybeRetire(task);
			},
		);
		task.decision = thenApply(
			raceGate.promise,
			(outcome: RaceOutcome): void => {
				if (outcome.kind === "CANCELLED") {
					task.suppressed = true;
					removeListener(task, outcome);
					return;
				}
				if (outcome.kind === "REVOKED") return;
				removeListener(task, freeze({ kind: "REVOKED" }));
				if (task.suppressed || task.revoked || closing) return;
				if (outcome.kind === "PROVIDER_REJECTED") commitInternalError(task, false);
				else commitEncoded(task, outcome.value, false);
			},
			(_error: unknown): void => {
				task.suppressed = true;
				poison();
			},
		);
		const decision = task.decision;
		task.decisionObserver = thenApply(
			decision,
			(): void => {
				task.decisionObserved = true;
				maybeRetire(task);
			},
			(_error: unknown): void => {
				task.decisionObserved = true;
				poison();
				maybeRetire(task);
			},
		);

		const cell: AbortCell = {
			active: true,
			signal,
			handler: (_event: Event): void => {
				resolveAbort(task, freeze({ kind: "CANCELLED" }));
				removeListener(task, freeze({ kind: "CANCELLED" }));
			},
			resolve: abortGate.resolve,
		};
		task.abortCell = cell;
		try {
			const added: unknown = apply(addEventListener, signal, ["abort", cell.handler]);
			if (added !== undefined) {
				resolveAbort(task, freeze({ kind: "REVOKED" }));
				task.abortCell = null;
				poison();
				return false;
			}
		} catch {
			resolveAbort(task, freeze({ kind: "REVOKED" }));
			task.abortCell = null;
			poison();
			return false;
		}
		const afterInstall = signalAborted(signal);
		if (afterInstall === null) {
			removeListener(task, freeze({ kind: "REVOKED" }));
			poison();
			return false;
		}
		if (afterInstall) {
			resolveAbort(task, freeze({ kind: "CANCELLED" }));
			removeListener(task, freeze({ kind: "CANCELLED" }));
		}
		return true;
	}

	function fixedBusy(bundle: Bundle): void {
		const task = allocateTask(bundle.reply, bundle.payload);
		if (task === null) {
			zeroBytes(bundle.payload);
			poison();
			return;
		}
		try {
			commitInternalError(task, true);
		} finally {
			if (!zeroBytes(bundle.payload)) poison();
			task.originalBytes = null;
		}
		if (task.fixedErrorReplyActual === null && !task.revoked) {
			clearTask(task);
		}
	}

	function dispatchApplication(bundleRaw: unknown): void {
		if (closing || poisoned) return;
		const bundle = captureBundle(bundleRaw);
		if (bundle === null) {
			const exposedPayload = invalidExactBundlePayload(bundleRaw);
			if (exposedPayload !== null && !zeroBytes(exposedPayload)) {
				poison();
				return;
			}
			poison();
			return;
		}
		const initiallyAborted = signalAborted(bundle.signal);
		if (initiallyAborted === null) {
			zeroBytes(bundle.payload);
			poison();
			return;
		}
		if (initiallyAborted) {
			if (!zeroBytes(bundle.payload)) poison();
			return;
		}
		if (providerCount >= MAX_PROVIDER_TASKS) {
			fixedBusy(bundle);
			return;
		}
		const task = allocateTask(bundle.reply, bundle.payload);
		if (task === null) {
			zeroBytes(bundle.payload);
			poison();
			return;
		}
		task.providerReserved = true;
		providerCount += 1;
		let decoded: ReturnType<typeof decodeModelRequestBytes> | null = null;
		let decodeThrew = false;
		try {
			decoded = decodeModelRequestBytes(bundle.payload);
		} catch {
			decodeThrew = true;
		} finally {
			if (!zeroBytes(bundle.payload)) poison();
			task.originalBytes = null;
		}
		if (decodeThrew || decoded === null || !decoded.ok || closing || poisoned) {
			releaseProvider(task);
			if (!poisoned) poison();
			if (!task.revoked) clearTask(task);
			return;
		}
		if (!promiseInvariantsHold()) {
			releaseProvider(task);
			commitInternalError(task, false);
			return;
		}
		const capability = providerCapability;
		if (capability === null) {
			releaseProvider(task);
			poison();
			if (!task.revoked) clearTask(task);
			return;
		}
		let providerRawResult: unknown;
		let providerThrew = false;
		try {
			providerRawResult = capability(decoded.request, bundle.signal);
		} catch {
			providerThrew = true;
		}
		if (providerThrew) {
			releaseProvider(task);
			commitInternalError(task, false);
			maybeRetire(task);
			return;
		}
		if (!exactNativePromise(providerRawResult)) {
			releaseProvider(task);
			if (!promiseInvariantsHold()) poison();
			else commitInternalError(task, false);
			maybeRetire(task);
			return;
		}
		if (!installRace(task, providerRawResult, bundle.signal)) {
			task.suppressed = true;
		}
	}

	function appendInventory(list: Array<Promise<unknown>>, promise: Promise<unknown> | null): void {
		if (promise !== null) list[list.length] = promise;
	}

	function collectInventory(): Array<Promise<unknown>> {
		const inventory = new NativeArray<Promise<unknown>>();
		inventory[inventory.length] = startup;
		appendInventory(inventory, shutdownSource);
		for (let index = 0; index < MAX_TASKS; index += 1) {
			const task = tasks[index];
			if (task === null) continue;
			appendInventory(inventory, task.providerActual);
			appendInventory(inventory, task.providerActualObserver);
			appendInventory(inventory, task.abortSource);
			appendInventory(inventory, task.abortSourceObserver);
			appendInventory(inventory, task.raceOutcome);
			appendInventory(inventory, task.providerRaceBranch);
			appendInventory(inventory, task.providerRaceBranchObserver);
			appendInventory(inventory, task.abortRaceBranch);
			appendInventory(inventory, task.abortRaceBranchObserver);
			appendInventory(inventory, task.decision);
			appendInventory(inventory, task.decisionObserver);
			appendInventory(inventory, task.replyActual);
			appendInventory(inventory, task.replyActualObserver);
			appendInventory(inventory, task.fixedErrorReplyActual);
			appendInventory(inventory, task.fixedErrorReplyObserver);
		}
		return inventory;
	}

	function revokeAllListeners(): void {
		for (let index = 0; index < MAX_TASKS; index += 1) {
			const task = tasks[index];
			if (task !== null) {
				task.suppressed = true;
				removeListener(task, freeze({ kind: "REVOKED" }));
			}
		}
	}

	function clearManagerState(): void {
		providerCapability = null;
		physicalCapability = null;
		for (let index = 0; index < MAX_TASKS; index += 1) {
			const task = tasks[index];
			if (task !== null) {
				releaseProvider(task);
				clearTask(task);
			}
		}
		_physicalActual = null;
		physicalShutdownChain = null;
		shutdownSource = null;
		_shutdownJoin = null;
		_shutdownJoinObserver = null;
		_shutdownOwnedObserver = null;
		_shutdownPhysicalObserver = null;
		_shutdownJoinBranches = null;
	}

	function shutdown(): Promise<ShutdownResult> {
		if (cachedShutdownChain !== null) return cachedShutdownChain;
		const returned = deferred<ShutdownResult>();
		if (returned === null) {
			const failed = resolved(poisonedResult);
			cachedShutdownChain = failed;
			return failed;
		}
		const returnedGate: Deferred<ShutdownResult> = returned;
		cachedShutdownChain = returnedGate.promise;
		closing = true;
		providerCapability = null;
		for (let index = 0; index < MAX_TASKS; index += 1) {
			const task = tasks[index];
			if (task !== null) task.suppressed = true;
		}
		revokeAllListeners();
		callPhysical();
		const physicalChain = physicalShutdownChain;
		if (physicalChain === null) {
			poisoned = true;
			returnedGate.resolve(poisonedResult);
			return returnedGate.promise;
		}
		shutdownSource = resolved(undefined);
		const inventory = collectInventory();
		const owned = deferred<void>();
		const joined = deferred<void>();
		if (owned === null || joined === null) {
			poison();
			clearManagerState();
			returnedGate.resolve(poisonedResult);
			return returnedGate.promise;
		}
		const ownedGate: Deferred<void> = owned;
		const joinedGate: Deferred<void> = joined;
		_shutdownJoin = joinedGate.promise;
		const branches = new NativeArray<Promise<void>>(inventory.length);
		_shutdownJoinBranches = branches;
		let remaining = inventory.length;
		if (remaining === 0) ownedGate.resolve(undefined);
		function oneOwnedSettled(): void {
			if (remaining <= 0) return;
			remaining -= 1;
			if (remaining === 0) ownedGate.resolve(undefined);
		}
		for (let index = 0; index < inventory.length; index += 1) {
			branches[index] = thenApply(
				inventory[index],
				(_value: unknown): void => oneOwnedSettled(),
				(_error: unknown): void => oneOwnedSettled(),
			);
		}
		let ownedDone = false;
		let physicalDone = false;
		let physicalSucceeded = physicalProved;
		let joinResolved = false;
		function considerJoin(): void {
			if (joinResolved) return;
			if (physicalSucceeded || (physicalDone && ownedDone)) {
				joinResolved = true;
				joinedGate.resolve(undefined);
			}
		}
		_shutdownOwnedObserver = thenApply(
			ownedGate.promise,
			(): void => {
				ownedDone = true;
				considerJoin();
			},
			(_error: unknown): void => {
				ownedDone = true;
				poison();
				considerJoin();
			},
		);
		_shutdownPhysicalObserver = thenApply(
			physicalChain,
			(result: PhysicalResult): void => {
				physicalDone = true;
				physicalSucceeded = result.code === "SHUT_DOWN";
				if (!physicalSucceeded) poisoned = true;
				considerJoin();
			},
			(_error: unknown): void => {
				physicalDone = true;
				poisoned = true;
				considerJoin();
			},
		);
		_shutdownJoinObserver = thenApply(
			joinedGate.promise,
			(): ShutdownResult => {
				const result = poisoned ? poisonedResult : shutDownResult;
				clearManagerState();
				return result;
			},
			(_error: unknown): ShutdownResult => {
				poisoned = true;
				clearManagerState();
				return poisonedResult;
			},
		);
		const finalObserver = _shutdownJoinObserver;
		_shutdownReturnedObserver = thenApply(
			finalObserver,
			(result: ShutdownResult): void => {
				returnedGate.resolve(result);
				_shutdownReturnedObserver = null;
			},
			(_error: unknown): void => {
				returnedGate.resolve(poisonedResult);
				_shutdownReturnedObserver = null;
			},
		);
		return returnedGate.promise;
	}

	return freeze({ dispatchApplication, shutdown });
}
