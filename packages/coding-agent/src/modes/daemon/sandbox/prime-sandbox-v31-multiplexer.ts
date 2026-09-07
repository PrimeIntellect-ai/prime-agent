import { types } from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";
import {
	type DecodeResult,
	decodeAppFrame,
	encodeAppFrame,
	KIND_CANCEL,
	KIND_CANCEL_ACK,
	KIND_DELIVERY_ACK,
	KIND_REPLY,
	KIND_REQUEST,
} from "./prime-sandbox-v15-application-codec.js";

const CapturedPromise = Promise;
const CapturedArray = Array;
const CapturedMap = Map;
const CapturedSet = Set;
const CapturedWeakMap = WeakMap;
const CapturedAbortController = AbortController;
const capturedObjectPrototype = Object.prototype;
const capturedSpeciesSymbol = Symbol.species;
const capturedPromisePrototype = Promise.prototype;
const capturedAbortSignalPrototype = AbortSignal.prototype;
function capturePromiseThen(): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(capturedPromisePrototype, "then");
	return descriptor === undefined ? undefined : descriptor.value;
}
const capturedPromiseThen = capturePromiseThen();
const capturedArrayPrototype = Array.prototype;
const capturedMapPrototype = Map.prototype;
const capturedSetPrototype = Set.prototype;
const capturedWeakMapPrototype = WeakMap.prototype;
const capturedAbortControllerPrototype = AbortController.prototype;
const capturedApply = Reflect.apply;
const capturedDeleteProperty = Reflect.deleteProperty;
const capturedFreeze = Object.freeze;
const capturedDefineProperty = Object.defineProperty;
const capturedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const capturedGetPrototypeOf = Object.getPrototypeOf;
const capturedOwnKeys = Reflect.ownKeys;
const capturedGetOwnPropertyNames = Object.getOwnPropertyNames;
const capturedGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const capturedIsExtensible = Object.isExtensible;
const capturedIsPromise = types.isPromise;
const capturedIsProxy = types.isProxy;
const capturedArrayIndexOf = capturedArrayPrototype.indexOf;
const capturedArrayPush = capturedArrayPrototype.push;
const capturedArrayShift = capturedArrayPrototype.shift;
const capturedArraySplice = capturedArrayPrototype.splice;
const capturedArrayUnshift = capturedArrayPrototype.unshift;
const capturedMapDelete = capturedMapPrototype.delete;
const capturedMapClear = capturedMapPrototype.clear;
const capturedMapGet = capturedMapPrototype.get;
const capturedMapHas = capturedMapPrototype.has;
const capturedMapSet = capturedMapPrototype.set;
const capturedMapValues = capturedMapPrototype.values;
const capturedSetAdd = capturedSetPrototype.add;
const capturedSetClear = capturedSetPrototype.clear;
const capturedSetDelete = capturedSetPrototype.delete;
const capturedSetHas = capturedSetPrototype.has;
const capturedSetValues = capturedSetPrototype.values;
const capturedWeakMapDelete = capturedWeakMapPrototype.delete;
const capturedWeakMapGet = capturedWeakMapPrototype.get;
const capturedWeakMapHas = capturedWeakMapPrototype.has;
const capturedWeakMapSet = capturedWeakMapPrototype.set;
const capturedAbort = capturedAbortControllerPrototype.abort;
const capturedAbortSignalDescriptor = Object.getOwnPropertyDescriptor(capturedAbortControllerPrototype, "signal");
const capturedAbortSignalGet =
	capturedAbortSignalDescriptor === undefined ? undefined : capturedAbortSignalDescriptor.get;
const capturedAbortAbortedDescriptor = Object.getOwnPropertyDescriptor(capturedAbortSignalPrototype, "aborted");
const capturedAbortAbortedGet =
	capturedAbortAbortedDescriptor === undefined ? undefined : capturedAbortAbortedDescriptor.get;
const capturedMapIteratorPrototype = capturedGetPrototypeOf(
	capturedApply(capturedMapValues, new CapturedMap<unknown, unknown>(), []),
);
const capturedSetIteratorPrototype = capturedGetPrototypeOf(
	capturedApply(capturedSetValues, new CapturedSet<unknown>(), []),
);
const capturedMapIteratorNextDescriptor = Object.getOwnPropertyDescriptor(capturedMapIteratorPrototype, "next");
const capturedSetIteratorNextDescriptor = Object.getOwnPropertyDescriptor(capturedSetIteratorPrototype, "next");
const capturedMapIteratorNext =
	capturedMapIteratorNextDescriptor === undefined ? undefined : capturedMapIteratorNextDescriptor.value;
const capturedSetIteratorNext =
	capturedSetIteratorNextDescriptor === undefined ? undefined : capturedSetIteratorNextDescriptor.value;

const CAPTURE_FAILED =
	typeof capturedPromiseThen !== "function" ||
	typeof capturedAbortSignalGet !== "function" ||
	typeof capturedAbortAbortedGet !== "function" ||
	typeof capturedMapIteratorNext !== "function" ||
	typeof capturedSetIteratorNext !== "function";
const MAX_LIVE_PER_ORIGIN = 32;
const MAX_LIVE_TOTAL = 64;
const MAX_WINDOW = 64n;
const MAX_QUEUED_FRAMES = 128;
const MAX_QUEUED_BYTES = 16_778_240;
const MAX_REQUEST_ID = 0xffff_ffff_ffff_ffffn;
const MAX_PAYLOAD_BYTES = 262_128;

type Stream = 0 | 1 | 2 | 3 | 4;
type EndpointSide = "Runtime" | "Home";
type SimpleCode =
	| "QUEUE_FULL"
	| "ENDPOINT_EXHAUSTED"
	| "POISONED"
	| "CLOSED"
	| "INPUT_INVALID"
	| "PENDING"
	| "CANCELLED"
	| "UNKNOWN_TICKET"
	| "FORBIDDEN_STATE"
	| "CONFIRMED"
	| "SENT"
	| "CLEAN"
	| "INIT_FAILURE";
type SimpleResult<C extends SimpleCode> = Readonly<{ code: C }>;
type PhysicalObservedResult = Readonly<{ code: "SENT" | "FAILED" | "CLOSED" }>;

function fixed<C extends SimpleCode>(code: C): SimpleResult<C> {
	return capturedFreeze({ code });
}

const RESULT_QUEUE_FULL = fixed("QUEUE_FULL");
const RESULT_EXHAUSTED = fixed("ENDPOINT_EXHAUSTED");
const RESULT_POISONED = fixed("POISONED");
const RESULT_CLOSED = fixed("CLOSED");
const RESULT_INPUT_INVALID = fixed("INPUT_INVALID");
const RESULT_PENDING = fixed("PENDING");
const RESULT_CANCELLED = fixed("CANCELLED");
const RESULT_UNKNOWN_TICKET = fixed("UNKNOWN_TICKET");
const RESULT_FORBIDDEN_STATE = fixed("FORBIDDEN_STATE");
const RESULT_CONFIRMED = fixed("CONFIRMED");
const RESULT_SENT = fixed("SENT");
const RESULT_CLEAN = fixed("CLEAN");
const RESULT_INIT_FAILURE = fixed("INIT_FAILURE");

export type SubmitResult =
	| Readonly<{ code: "SUBMITTED"; ticket: object }>
	| SimpleResult<"QUEUE_FULL" | "ENDPOINT_EXHAUSTED" | "POISONED" | "CLOSED" | "INPUT_INVALID">;
export type CancelResult = SimpleResult<
	"PENDING" | "CANCELLED" | "POISONED" | "CLOSED" | "UNKNOWN_TICKET" | "INPUT_INVALID" | "FORBIDDEN_STATE"
>;
export type PollDeliveryResult = SimpleResult<
	"CONFIRMED" | "PENDING" | "POISONED" | "CLOSED" | "UNKNOWN_TICKET" | "INPUT_INVALID"
>;
export type PollReplyResult =
	| Readonly<{ code: "REPLY_READY"; payload: Uint8Array }>
	| SimpleResult<"PENDING" | "CANCELLED" | "POISONED" | "CLOSED" | "UNKNOWN_TICKET" | "INPUT_INVALID">;
export type DeliveryResult = SimpleResult<"CONFIRMED" | "POISONED" | "CLOSED">;
export type ReplyResult =
	| Readonly<{ code: "REPLY_READY"; payload: Uint8Array }>
	| SimpleResult<"CANCELLED" | "POISONED" | "CLOSED" | "UNKNOWN_TICKET">;
export type ComposedReplyResult = SimpleResult<"SENT" | "CANCELLED" | "POISONED" | "CLOSED" | "INPUT_INVALID">;
export type CleanupResult = SimpleResult<"CLEAN" | "POISONED">;

export interface ApplicationBundle {
	readonly origin: EndpointSide;
	readonly stream: Stream;
	readonly payload: Uint8Array;
	readonly signal: AbortSignal;
	readonly reply: (payloadRaw: unknown) => Promise<ComposedReplyResult>;
}

export interface OriginSubmit {
	submit(payloadRaw: unknown): SubmitResult;
	cancel(ticket: unknown): CancelResult;
	pollDelivery(ticket: unknown): PollDeliveryResult;
	pollReply(ticket: unknown): PollReplyResult;
	awaitDelivery(ticket: unknown): Promise<DeliveryResult>;
	awaitReply(ticket: unknown): Promise<ReplyResult>;
}

export interface RuntimeMultiplexer {
	readonly modelToHome: OriginSubmit;
	readonly lifecycleToHome: OriginSubmit;
	readonly messagesToHome: OriginSubmit;
	readonly observeRequestsToHome: OriginSubmit;
	readonly observeRepliesToHome: OriginSubmit;
	readonly close: () => Promise<CleanupResult>;
}
export type RuntimeInitResult = RuntimeMultiplexer | SimpleResult<"INIT_FAILURE">;

export interface HomeMultiplexer {
	readonly lifecycleToRuntime: OriginSubmit;
	readonly messagesToRuntime: OriginSubmit;
	readonly observeRequestsToRuntime: OriginSubmit;
	readonly observeRepliesToRuntime: OriginSubmit;
	readonly close: () => Promise<CleanupResult>;
}
export type HomeInitResult = HomeMultiplexer | SimpleResult<"INIT_FAILURE">;

type OutboundState =
	| "REQUEST_QUEUED"
	| "AWAIT_ACK"
	| "DELIVERED"
	| "CANCEL_WAITING"
	| "CANCEL_SENT"
	| "REPLY_READY"
	| "REPLY_READY_CANCEL"
	| "REPLY_READY_BOTH"
	| "CANCELLED_TERMINAL"
	| "POISONED";
type InboundState =
	| "ACK_QUEUED"
	| "WAITING"
	| "REPLY_QUEUED"
	| "CANCEL_ACK_QUEUED"
	| "BOTH_QUEUED"
	| "COMPLETE"
	| "POISONED";
type OutboundCompanion = "REPLY" | "CANCEL_ACK";
type InboundCompanion = "CANCEL" | "CANCEL_PENDING";

interface PrivateIssuer {
	issue: () => object;
	prototype: object;
}
interface WindowState<H> {
	floor: bigint;
	next: bigint;
	occupied: Set<bigint>;
	history: Map<bigint, H>;
}
interface OutboundFlow {
	stream: Stream;
	id: bigint;
	ticket: object;
	window: WindowState<OutboundCompanion>;
	state: OutboundState;
	cancelWanted: boolean;
	ackEarly: boolean;
	released: boolean;
	replyClaimed: boolean;
	replyBytes: Uint8Array | null;
	deliveryPromise: Promise<DeliveryResult> | null;
	deliveryResolve: ((value: DeliveryResult) => void) | null;
	replyPromise: Promise<ReplyResult> | null;
	replyResolve: ((value: ReplyResult) => void) | null;
}
interface InboundFlow {
	stream: Stream;
	id: bigint;
	window: WindowState<InboundCompanion>;
	state: InboundState;
	released: boolean;
	cancelSeen: boolean;
	replyUsed: boolean;
	sourceBytes: Uint8Array | null;
	controller: AbortController | null;
	replySendDone: boolean;
	cancelAckSendDone: boolean;
	replyCallPromise: Promise<ComposedReplyResult> | null;
	replyCallResolve: ((value: ComposedReplyResult) => void) | null;
}
interface QueueEntry {
	kind: number;
	stream: Stream;
	bytes: Uint8Array;
	onSettled: (sent: boolean) => void;
	actual: Promise<unknown> | null;
	observer: Promise<unknown> | null;
	completion: Promise<unknown>;
	completionResolve: (value: PhysicalObservedResult) => void;
	tail: Promise<unknown>;
	tailFirstObserver: Promise<unknown> | null;
	tailSecondObserver: Promise<unknown> | null;
}
interface FamilyRecord {
	owner: object;
	stream: Stream;
}
interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}
interface PromiseJoin {
	promise: Promise<unknown>;
	firstObserver: Promise<unknown> | null;
	secondObserver: Promise<unknown> | null;
}
interface FailedInitializationCleanup {
	actual: Promise<unknown> | null;
	observer: Promise<unknown> | null;
	completion: Promise<unknown>;
	reaction: Promise<unknown> | null;
}
interface IterationResult<T> {
	done: boolean;
	value: T;
}
interface PreparedPayload {
	bytes: Uint8Array;
	paddedLength: number;
}
interface Core {
	createOrigin: (stream: Stream) => OriginSubmit;
	close: () => Promise<CleanupResult>;
}

function copyBytes(value: Uint8Array): Uint8Array {
	const result = new Uint8Array(value.length);
	for (let index = 0; index < value.length; index += 1) result[index] = value[index];
	return result;
}

function zeroBytes(value: Uint8Array): void {
	for (let index = 0; index < value.length; index += 1) value[index] = 0;
}

function preparePayload(raw: unknown): PreparedPayload | null {
	const copied = copySandboxStrictBytes(raw, MAX_PAYLOAD_BYTES);
	if (!copied.ok) return null;
	const unpaddedLength = 16 + copied.value.length;
	const paddedLength = ((unpaddedLength + 15) >>> 0) & ~15;
	return { bytes: copied.value, paddedLength };
}

function makeDataFrame(
	kind: 1 | 3,
	stream: Stream,
	requestId: bigint,
	payload: Uint8Array,
	length: number,
): Uint8Array {
	const frame = new Uint8Array(length);
	frame[0] = kind;
	frame[1] = stream;
	frame[4] = Number((requestId >> 56n) & 0xffn);
	frame[5] = Number((requestId >> 48n) & 0xffn);
	frame[6] = Number((requestId >> 40n) & 0xffn);
	frame[7] = Number((requestId >> 32n) & 0xffn);
	frame[8] = Number((requestId >> 24n) & 0xffn);
	frame[9] = Number((requestId >> 16n) & 0xffn);
	frame[10] = Number((requestId >> 8n) & 0xffn);
	frame[11] = Number(requestId & 0xffn);
	const unpaddedLength = 16 + payload.length;
	frame[12] = (unpaddedLength >>> 24) & 0xff;
	frame[13] = (unpaddedLength >>> 16) & 0xff;
	frame[14] = (unpaddedLength >>> 8) & 0xff;
	frame[15] = unpaddedLength & 0xff;
	for (let index = 0; index < payload.length; index += 1) frame[16 + index] = payload[index];
	return frame;
}

function makeDeferred<T>(): Deferred<T> {
	let resolver: ((value: T) => void) | null = null;
	const promise = new CapturedPromise<T>((resolve) => {
		resolver = resolve;
	});
	return {
		promise,
		resolve: (value: T): void => {
			if (resolver !== null) resolver(value);
		},
	};
}

function resolved<T>(value: T): Promise<T> {
	return new CapturedPromise<T>((resolve) => resolve(value));
}

function arrayIndexOf<T>(array: Array<T>, value: T): number {
	return capturedApply(capturedArrayIndexOf, array, [value]);
}

function arrayPush<T>(array: Array<T>, value: T): void {
	capturedApply(capturedArrayPush, array, [value]);
}

function arrayShift<T>(array: Array<T>): T | undefined {
	return capturedApply(capturedArrayShift, array, []);
}

function arraySpliceOne<T>(array: Array<T>, index: number): void {
	capturedApply(capturedArraySplice, array, [index, 1]);
}

function arrayUnshift<T>(array: Array<T>, value: T): void {
	capturedApply(capturedArrayUnshift, array, [value]);
}

function mapDelete<K, V>(map: Map<K, V>, key: K): void {
	capturedApply(capturedMapDelete, map, [key]);
}

function mapClear<K, V>(map: Map<K, V>): void {
	capturedApply(capturedMapClear, map, []);
}

function mapGet<K, V>(map: Map<K, V>, key: K): V | undefined {
	return capturedApply(capturedMapGet, map, [key]);
}

function mapHas<K, V>(map: Map<K, V>, key: K): boolean {
	return capturedApply(capturedMapHas, map, [key]);
}

function mapSet<K, V>(map: Map<K, V>, key: K, value: V): void {
	capturedApply(capturedMapSet, map, [key, value]);
}

function mapValues<K, V>(map: Map<K, V>): object {
	return capturedApply(capturedMapValues, map, []);
}

function setAdd<T>(set: Set<T>, value: T): void {
	capturedApply(capturedSetAdd, set, [value]);
}

function setClear<T>(set: Set<T>): void {
	capturedApply(capturedSetClear, set, []);
}

function setDelete<T>(set: Set<T>, value: T): void {
	capturedApply(capturedSetDelete, set, [value]);
}

function setHas<T>(set: Set<T>, value: T): boolean {
	return capturedApply(capturedSetHas, set, [value]);
}

function setValues<T>(set: Set<T>): object {
	return capturedApply(capturedSetValues, set, []);
}

function weakMapDelete<K extends object, V>(map: WeakMap<K, V>, key: K): void {
	capturedApply(capturedWeakMapDelete, map, [key]);
}

function weakMapGet<K extends object, V>(map: WeakMap<K, V>, key: K): V | undefined {
	return capturedApply(capturedWeakMapGet, map, [key]);
}

function weakMapHas<K extends object, V>(map: WeakMap<K, V>, key: K): boolean {
	return capturedApply(capturedWeakMapHas, map, [key]);
}

function weakMapSet<K extends object, V>(map: WeakMap<K, V>, key: K, value: V): void {
	capturedApply(capturedWeakMapSet, map, [key, value]);
}

function nextMapValue<T>(iterator: object): IterationResult<T> {
	return capturedApply(capturedMapIteratorNext, iterator, []);
}

function nextSetValue<T>(iterator: object): IterationResult<T> {
	return capturedApply(capturedSetIteratorNext, iterator, []);
}

function forEachMapValue<K, V>(map: Map<K, V>, callback: (value: V) => void): void {
	const iterator = mapValues(map);
	let result = nextMapValue<V>(iterator);
	while (!result.done) {
		callback(result.value);
		result = nextMapValue<V>(iterator);
	}
}

function forEachSetValue<T>(set: Set<T>, callback: (value: T) => void): void {
	const iterator = setValues(set);
	let result = nextSetValue<T>(iterator);
	while (!result.done) {
		callback(result.value);
		result = nextSetValue<T>(iterator);
	}
}

function abortController(controller: AbortController): void {
	capturedApply(capturedAbort, controller, []);
}

function exactAbortSignal(raw: unknown): raw is AbortSignal {
	if (typeof raw !== "object" || raw === null || capturedIsProxy(raw)) return false;
	if (capturedGetPrototypeOf(raw) !== capturedAbortSignalPrototype) return false;
	if (capturedOwnKeys(raw).length !== 0) return false;
	if (typeof capturedAbortAbortedGet !== "function") return false;
	let aborted: unknown;
	try {
		aborted = capturedApply(capturedAbortAbortedGet, raw, []);
	} catch {
		return false;
	}
	return typeof aborted === "boolean";
}

function abortSignal(controller: AbortController): AbortSignal | null {
	if (typeof capturedAbortSignalGet !== "function") return null;
	let signal: unknown;
	try {
		signal = capturedApply(capturedAbortSignalGet, controller, []);
	} catch {
		return null;
	}
	return exactAbortSignal(signal) ? signal : null;
}

function exactPlainData(raw: unknown, names: Array<string>): raw is object {
	if (typeof raw !== "object" || raw === null || capturedIsProxy(raw)) return false;
	if (capturedGetPrototypeOf(raw) !== capturedObjectPrototype) return false;
	const keys = capturedOwnKeys(raw);
	if (keys.length !== names.length) return false;
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index];
		if (typeof key !== "string") return false;
		let found = false;
		for (let nameIndex = 0; nameIndex < names.length; nameIndex += 1) {
			if (names[nameIndex] === key) found = true;
		}
		if (!found) return false;
		const descriptor = capturedGetOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) return false;
	}
	return true;
}

function captureFunction(raw: object, name: string): unknown {
	const descriptor = capturedGetOwnPropertyDescriptor(raw, name);
	if (descriptor === undefined) return null;
	const value: unknown = descriptor.value;
	if (typeof value !== "function") return null;
	return value;
}

function invokeCaptured(target: unknown, receiver: unknown, argumentsList: Array<unknown>): unknown {
	if (typeof target !== "function") return undefined;
	return capturedApply(target, receiver, argumentsList);
}

function exactCode(raw: unknown): string | undefined {
	if (!exactPlainData(raw, ["code"])) return undefined;
	const descriptor = capturedGetOwnPropertyDescriptor(raw, "code");
	if (descriptor === undefined) return undefined;
	const value: unknown = descriptor.value;
	return typeof value === "string" ? value : undefined;
}

function exactNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null || capturedIsProxy(raw)) return false;
	if (!capturedIsPromise(raw)) return false;
	if (capturedGetPrototypeOf(raw) !== capturedPromisePrototype) return false;
	if (capturedGetOwnPropertyNames(raw).length !== 0) return false;
	if (capturedGetOwnPropertySymbols(raw).length !== 0) return false;
	return capturedIsExtensible(raw);
}

const localPromiseSpeciesHolder = capturedFreeze({
	[capturedSpeciesSymbol]: CapturedPromise,
});

function observePromise(
	promise: Promise<unknown>,
	fulfilled: (value: unknown) => void,
	rejected: () => void,
	callbackFault: () => void,
): Promise<unknown> | null {
	if (typeof capturedPromiseThen !== "function") return null;
	let result: unknown;
	let installed = false;
	try {
		capturedDefineProperty(promise, "constructor", {
			value: localPromiseSpeciesHolder,
			writable: false,
			enumerable: false,
			configurable: true,
		});
		installed = true;
		result = capturedApply(capturedPromiseThen, promise, [
			(value: unknown): void => {
				try {
					fulfilled(value);
				} catch {
					callbackFault();
				}
			},
			(): void => {
				try {
					rejected();
				} catch {
					callbackFault();
				}
			},
		]);
	} catch {
		installed = false;
	}
	let removed = false;
	try {
		removed = capturedDeleteProperty(promise, "constructor");
		if (capturedGetOwnPropertyDescriptor(promise, "constructor") !== undefined) removed = false;
	} catch {
		removed = false;
	}
	if (!installed || !removed) return null;
	return exactNativePromise(result) ? result : null;
}

function joinPromises(first: Promise<unknown>, second: Promise<unknown>): PromiseJoin {
	const deferred = makeDeferred<unknown>();
	let remaining = 2;
	const settled = (): void => {
		remaining -= 1;
		if (remaining === 0) deferred.resolve(true);
	};
	const firstObserver = observePromise(first, settled, settled, settled);
	const secondObserver = observePromise(second, settled, settled, settled);
	if (firstObserver === null || secondObserver === null) deferred.resolve(false);
	return { promise: deferred.promise, firstObserver, secondObserver };
}

function makePrivateIssuer(): PrivateIssuer | null {
	try {
		const box: { issue: (() => object) | null } = { issue: null };
		class PrivateToken {
			private constructor() {}
			static {
				box.issue = (): object => capturedFreeze(new PrivateToken());
			}
		}
		capturedDefineProperty(PrivateToken.prototype, "constructor", {
			value: null,
			writable: false,
			configurable: false,
		});
		capturedFreeze(PrivateToken.prototype);
		capturedFreeze(PrivateToken);
		if (typeof box.issue !== "function") return null;
		return { issue: box.issue, prototype: PrivateToken.prototype };
	} catch {
		return null;
	}
}

function makeWindow<H>(): WindowState<H> {
	return { floor: 1n, next: 1n, occupied: new CapturedSet<bigint>(), history: new CapturedMap<bigint, H>() };
}

function advanceWindow<H>(window: WindowState<H>): void {
	while (
		window.floor < window.next &&
		!setHas(window.occupied, window.floor) &&
		!mapHas(window.history, window.floor)
	) {
		window.floor += 1n;
	}
}

function windowCanReserve<H>(window: WindowState<H>): boolean {
	let floor = window.floor;
	while (floor < window.next && !setHas(window.occupied, floor) && !mapHas(window.history, floor)) floor += 1n;
	while (window.next - floor >= MAX_WINDOW) {
		if (!mapHas(window.history, floor)) return false;
		floor += 1n;
		while (floor < window.next && !setHas(window.occupied, floor) && !mapHas(window.history, floor)) floor += 1n;
	}
	return window.next <= MAX_REQUEST_ID;
}

function reserveWindow<H>(window: WindowState<H>): boolean {
	advanceWindow(window);
	while (window.next - window.floor >= MAX_WINDOW) {
		if (!mapHas(window.history, window.floor)) return false;
		mapDelete(window.history, window.floor);
		window.floor += 1n;
		advanceWindow(window);
	}
	return window.next <= MAX_REQUEST_ID;
}

function narrowStream(raw: unknown): Stream | undefined {
	if (raw === 0) return 0;
	if (raw === 1) return 1;
	if (raw === 2) return 2;
	if (raw === 3) return 3;
	if (raw === 4) return 4;
	return undefined;
}

function decodedPlaintextLength(frame: DecodeResult): number {
	if (!frame.ok) return 0;
	if (frame.kind !== KIND_REQUEST && frame.kind !== KIND_REPLY) return 16;
	const unpaddedLength = 16 + frame.payload.length;
	return ((unpaddedLength + 15) >>> 0) & ~15;
}

function buildCore(side: EndpointSide, physicalRaw: unknown, dispatchRaw: unknown): Core | null {
	if (CAPTURE_FAILED) return null;
	if (!exactPlainData(physicalRaw, ["send", "registerInbound", "close"])) return null;
	if (!exactPlainData(dispatchRaw, ["dispatchApplication"])) return null;
	const capturedSendCandidate = captureFunction(physicalRaw, "send");
	const capturedRegisterCandidate = captureFunction(physicalRaw, "registerInbound");
	const capturedCloseCandidate = captureFunction(physicalRaw, "close");
	const capturedDispatchCandidate = captureFunction(dispatchRaw, "dispatchApplication");
	if (
		capturedSendCandidate === null ||
		capturedRegisterCandidate === null ||
		capturedCloseCandidate === null ||
		capturedDispatchCandidate === null
	) {
		return null;
	}
	const physicalSend: unknown = capturedSendCandidate;
	const physicalRegister: unknown = capturedRegisterCandidate;
	const physicalClose: unknown = capturedCloseCandidate;
	const dispatchApplication: unknown = capturedDispatchCandidate;

	const ownerIssuer = makePrivateIssuer();
	if (ownerIssuer === null) return null;
	let owner: object;
	try {
		owner = ownerIssuer.issue();
	} catch {
		return null;
	}

	const groupIssuers = new CapturedArray<PrivateIssuer | null>(null, null, null, null, null);
	const firstStream = side === "Runtime" ? 0 : 1;
	for (let streamIndex = firstStream; streamIndex <= 4; streamIndex += 1) {
		const issuer = makePrivateIssuer();
		if (issuer === null) return null;
		groupIssuers[streamIndex] = issuer;
	}

	const family = new CapturedWeakMap<object, FamilyRecord>();
	const tickets = new CapturedWeakMap<object, OutboundFlow>();
	const activeTickets = new CapturedSet<object>();
	const outWindows = new CapturedArray<WindowState<OutboundCompanion>>(
		makeWindow(),
		makeWindow(),
		makeWindow(),
		makeWindow(),
		makeWindow(),
	);
	const inWindows = new CapturedArray<WindowState<InboundCompanion>>(
		makeWindow(),
		makeWindow(),
		makeWindow(),
		makeWindow(),
		makeWindow(),
	);
	const outLive = new CapturedArray<Map<bigint, OutboundFlow>>(
		new CapturedMap<bigint, OutboundFlow>(),
		new CapturedMap<bigint, OutboundFlow>(),
		new CapturedMap<bigint, OutboundFlow>(),
		new CapturedMap<bigint, OutboundFlow>(),
		new CapturedMap<bigint, OutboundFlow>(),
	);
	const inLive = new CapturedArray<Map<bigint, InboundFlow>>(
		new CapturedMap<bigint, InboundFlow>(),
		new CapturedMap<bigint, InboundFlow>(),
		new CapturedMap<bigint, InboundFlow>(),
		new CapturedMap<bigint, InboundFlow>(),
		new CapturedMap<bigint, InboundFlow>(),
	);

	let localLive = 0;
	let remoteLive = 0;
	let totalLive = 0;
	let closed = false;
	let poisoned = false;
	let dirty = false;

	const sendQueue = new CapturedArray<QueueEntry>();
	const pendingCancels = new CapturedArray<OutboundFlow>();
	let queuedBytes = 0;
	let activeSend: QueueEntry | null = null;
	let sendTail: Promise<unknown> | null = null;

	const receiveQueue = new CapturedArray<DecodeResult>();
	let receiveQueuedBytes = 0;
	let receivePumping = false;

	let physicalCloseCalled = false;
	let physicalCloseActual: Promise<unknown> | null = null;
	let physicalCloseObserver: Promise<unknown> | null = null;
	let physicalCloseCompletion: Promise<PhysicalObservedResult> | null = null;
	let physicalCloseSucceeded = false;
	let closePromise: Promise<CleanupResult> | null = null;
	let closeDrainObserver: Promise<unknown> | null = null;
	const closeOwnedObservers = new CapturedArray<Promise<unknown>>();
	let failedInitializationCleanup: FailedInitializationCleanup | null = null;

	function queueFits(byteLength: number): boolean {
		return sendQueue.length < MAX_QUEUED_FRAMES && queuedBytes + byteLength <= MAX_QUEUED_BYTES;
	}

	function settleDelivery(flow: OutboundFlow, result: DeliveryResult): void {
		if (flow.deliveryResolve !== null) {
			flow.deliveryResolve(result);
			flow.deliveryResolve = null;
		}
	}

	function settleReply(flow: OutboundFlow, result: ReplyResult): void {
		if (flow.replyResolve !== null) {
			flow.replyResolve(result);
			flow.replyResolve = null;
		}
	}

	function releaseOutbound(flow: OutboundFlow): void {
		if (flow.released) return;
		flow.released = true;
		localLive -= 1;
		totalLive -= 1;
	}

	function releaseInbound(flow: InboundFlow): void {
		if (flow.released) return;
		flow.released = true;
		remoteLive -= 1;
		totalLive -= 1;
	}

	function removeOutboundLive(flow: OutboundFlow): void {
		mapDelete(outLive[flow.stream], flow.id);
		setDelete(flow.window.occupied, flow.id);
	}

	function removeInboundLive(flow: InboundFlow): void {
		mapDelete(inLive[flow.stream], flow.id);
		setDelete(flow.window.occupied, flow.id);
	}

	function finishTicket(flow: OutboundFlow): void {
		weakMapDelete(tickets, flow.ticket);
		setDelete(activeTickets, flow.ticket);
	}

	function addOutboundHistory(flow: OutboundFlow, companion: OutboundCompanion): void {
		removeOutboundLive(flow);
		mapSet(flow.window.history, flow.id, companion);
		advanceWindow(flow.window);
	}

	function finishOutboundWithoutHistory(flow: OutboundFlow): void {
		removeOutboundLive(flow);
		advanceWindow(flow.window);
	}

	function localPoisonOutbound(flow: OutboundFlow): void {
		if (flow.state === "POISONED") return;
		dirty = true;
		flow.state = "POISONED";
		if (flow.replyBytes !== null) {
			zeroBytes(flow.replyBytes);
			flow.replyBytes = null;
		}
		settleDelivery(flow, RESULT_POISONED);
		settleReply(flow, RESULT_POISONED);
		releaseOutbound(flow);
		removeOutboundLive(flow);
		mapDelete(flow.window.history, flow.id);
		advanceWindow(flow.window);
	}

	function localPoisonInbound(flow: InboundFlow): void {
		if (flow.state === "POISONED") return;
		dirty = true;
		flow.state = "POISONED";
		if (flow.sourceBytes !== null) {
			zeroBytes(flow.sourceBytes);
			flow.sourceBytes = null;
		}
		if (flow.controller !== null) abortController(flow.controller);
		if (flow.replyCallResolve !== null) {
			flow.replyCallResolve(RESULT_POISONED);
			flow.replyCallResolve = null;
		}
		releaseInbound(flow);
		removeInboundLive(flow);
		mapDelete(flow.window.history, flow.id);
		advanceWindow(flow.window);
	}

	function callPhysicalClose(): Promise<PhysicalObservedResult> {
		if (physicalCloseCompletion !== null) return physicalCloseCompletion;
		const deferred = makeDeferred<PhysicalObservedResult>();
		physicalCloseCompletion = deferred.promise;
		if (physicalCloseCalled) {
			dirty = true;
			deferred.resolve(capturedFreeze({ code: "FAILED" }));
			return physicalCloseCompletion;
		}
		physicalCloseCalled = true;
		let raw: unknown;
		try {
			raw = invokeCaptured(physicalClose, physicalRaw, []);
		} catch {
			dirty = true;
			deferred.resolve(capturedFreeze({ code: "FAILED" }));
			return physicalCloseCompletion;
		}
		if (!exactNativePromise(raw)) {
			dirty = true;
			deferred.resolve(capturedFreeze({ code: "FAILED" }));
			return physicalCloseCompletion;
		}
		physicalCloseActual = raw;
		const observer = observePromise(
			raw,
			(value: unknown): void => {
				physicalCloseSucceeded = exactCode(value) === "CLOSED";
				if (!physicalCloseSucceeded) dirty = true;
				deferred.resolve(
					capturedFreeze({
						code: physicalCloseSucceeded ? "CLOSED" : "FAILED",
					}),
				);
			},
			(): void => {
				dirty = true;
				physicalCloseSucceeded = false;
				deferred.resolve(capturedFreeze({ code: "FAILED" }));
			},
			(): void => {
				dirty = true;
				physicalCloseSucceeded = false;
				deferred.resolve(capturedFreeze({ code: "FAILED" }));
			},
		);
		physicalCloseObserver = observer;
		if (observer === null) {
			dirty = true;
			physicalCloseSucceeded = false;
			deferred.resolve(capturedFreeze({ code: "FAILED" }));
		}
		return physicalCloseCompletion;
	}

	function clearReceiveQueue(): void {
		for (let index = 0; index < receiveQueue.length; index += 1) {
			const frame = receiveQueue[index];
			if (frame.ok && (frame.kind === KIND_REQUEST || frame.kind === KIND_REPLY)) zeroBytes(frame.payload);
		}
		receiveQueue.length = 0;
		receiveQueuedBytes = 0;
	}

	function dropQueuedWork(result: "POISONED" | "CLOSED"): void {
		if (result === "CLOSED") clearReceiveQueue();
		for (let index = sendQueue.length - 1; index >= 0; index -= 1) {
			const entry = sendQueue[index];
			if (entry === activeSend) continue;
			arraySpliceOne(sendQueue, index);
			queuedBytes -= entry.bytes.length;
			zeroBytes(entry.bytes);
			let callbackFault = false;
			try {
				entry.onSettled(false);
			} catch {
				callbackFault = true;
			}
			entry.completionResolve(capturedFreeze({ code: "FAILED" }));
			if (callbackFault) {
				dirty = true;
				poisoned = true;
			}
		}
		pendingCancels.length = 0;
		if (result === "CLOSED") {
			forEachSetValue(activeTickets, (ticket: object): void => {
				const flow = weakMapGet(tickets, ticket);
				if (flow === undefined) return;
				if (flow.replyBytes !== null) {
					zeroBytes(flow.replyBytes);
					flow.replyBytes = null;
				}
				settleDelivery(flow, RESULT_CLOSED);
				settleReply(flow, RESULT_CLOSED);
				releaseOutbound(flow);
				removeOutboundLive(flow);
				weakMapDelete(tickets, ticket);
			});
			setClear(activeTickets);
			for (let stream = 0; stream <= 4; stream += 1) {
				forEachMapValue(inLive[stream], (flow: InboundFlow): void => {
					if (flow.sourceBytes !== null) {
						zeroBytes(flow.sourceBytes);
						flow.sourceBytes = null;
					}
					if (flow.controller !== null) abortController(flow.controller);
					if (flow.replyCallResolve !== null) {
						flow.replyCallResolve(RESULT_CLOSED);
						flow.replyCallResolve = null;
					}
					releaseInbound(flow);
					setDelete(flow.window.occupied, flow.id);
				});
				mapClear(inLive[stream]);
				mapClear(outWindows[stream].history);
				mapClear(inWindows[stream].history);
			}
		}
	}

	function abortVisibleInbound(): void {
		for (let stream = 0; stream <= 4; stream += 1) {
			forEachMapValue(inLive[stream], (flow: InboundFlow): void => {
				if (flow.controller !== null) abortController(flow.controller);
			});
		}
	}

	function globalPoison(): void {
		if (poisoned) return;
		poisoned = true;
		dirty = true;
		forEachSetValue(activeTickets, (ticket: object): void => {
			const flow = weakMapGet(tickets, ticket);
			if (flow !== undefined) localPoisonOutbound(flow);
		});
		for (let stream = 0; stream <= 4; stream += 1) {
			forEachMapValue(inLive[stream], (flow: InboundFlow): void => localPoisonInbound(flow));
			mapClear(outWindows[stream].history);
			mapClear(inWindows[stream].history);
		}
		clearReceiveQueue();
		dropQueuedWork("POISONED");
		callPhysicalClose();
	}

	function finishSend(entry: QueueEntry, sent: boolean): void {
		if (activeSend !== entry) {
			globalPoison();
			return;
		}
		const index = arrayIndexOf(sendQueue, entry);
		if (index >= 0) arraySpliceOne(sendQueue, index);
		queuedBytes -= entry.bytes.length;
		zeroBytes(entry.bytes);
		activeSend = null;
		if (!sent) dirty = true;
		let callbackFault = false;
		try {
			entry.onSettled(sent);
		} catch {
			callbackFault = true;
		}
		if (callbackFault) {
			globalPoison();
			return;
		}
		promoteCancels();
		startNextSend();
	}

	function sendObserverFault(entry: QueueEntry): void {
		dirty = true;
		if (activeSend === entry) {
			const index = arrayIndexOf(sendQueue, entry);
			if (index >= 0) arraySpliceOne(sendQueue, index);
			queuedBytes -= entry.bytes.length;
			zeroBytes(entry.bytes);
			activeSend = null;
		}
		entry.completionResolve(capturedFreeze({ code: "FAILED" }));
		globalPoison();
	}

	function revokeMalformedSend(entry: QueueEntry): void {
		dirty = true;
		globalPoison();
		const shutdown = physicalCloseCompletion;
		const release = (): void => {
			finishSend(entry, false);
			entry.completionResolve(capturedFreeze({ code: "FAILED" }));
		};
		if (shutdown === null) {
			release();
			return;
		}
		entry.observer = observePromise(shutdown, release, release, release);
		if (entry.observer === null) release();
	}

	function startNextSend(): void {
		if (activeSend !== null || sendQueue.length === 0 || closed || poisoned) return;
		let chosenIndex = 0;
		for (let index = 0; index < sendQueue.length; index += 1) {
			if (sendQueue[index].kind === KIND_CANCEL) {
				chosenIndex = index;
				break;
			}
		}
		const entry = sendQueue[chosenIndex];
		activeSend = entry;
		if (sendTail === null) entry.tail = entry.completion;
		else {
			const joinedTail = joinPromises(sendTail, entry.completion);
			entry.tail = joinedTail.promise;
			entry.tailFirstObserver = joinedTail.firstObserver;
			entry.tailSecondObserver = joinedTail.secondObserver;
		}
		sendTail = entry.tail;
		let raw: unknown;
		try {
			raw = invokeCaptured(physicalSend, physicalRaw, [entry.stream, entry.bytes]);
		} catch {
			finishSend(entry, false);
			entry.completionResolve(capturedFreeze({ code: "FAILED" }));
			return;
		}
		if (!exactNativePromise(raw)) {
			revokeMalformedSend(entry);
			return;
		}
		entry.actual = raw;
		const observer = observePromise(
			raw,
			(value: unknown): void => {
				const sent = exactCode(value) === "SENT";
				finishSend(entry, sent);
				entry.completionResolve(capturedFreeze({ code: sent ? "SENT" : "FAILED" }));
			},
			(): void => {
				finishSend(entry, false);
				entry.completionResolve(capturedFreeze({ code: "FAILED" }));
			},
			(): void => sendObserverFault(entry),
		);
		entry.observer = observer;
		if (observer === null) sendObserverFault(entry);
	}

	function enqueue(kind: number, stream: Stream, bytes: Uint8Array, onSettled: (sent: boolean) => void): boolean {
		if (!queueFits(bytes.length)) return false;
		const completion = makeDeferred<PhysicalObservedResult>();
		const entry: QueueEntry = {
			kind,
			stream,
			bytes,
			onSettled,
			actual: null,
			observer: null,
			completion: completion.promise,
			completionResolve: completion.resolve,
			tail: completion.promise,
			tailFirstObserver: null,
			tailSecondObserver: null,
		};
		arrayPush(sendQueue, entry);
		queuedBytes += bytes.length;
		startNextSend();
		return true;
	}

	function requestSendSettled(flow: OutboundFlow, sent: boolean): void {
		if (poisoned || closed || flow.state === "POISONED") return;
		if (!sent) {
			globalPoison();
			return;
		}
		flow.state = "AWAIT_ACK";
		if (flow.ackEarly) confirmDelivery(flow);
	}

	function confirmDelivery(flow: OutboundFlow): void {
		if (flow.state !== "AWAIT_ACK") {
			globalPoison();
			return;
		}
		settleDelivery(flow, RESULT_CONFIRMED);
		if (flow.cancelWanted) {
			flow.state = "CANCEL_WAITING";
			arrayPush(pendingCancels, flow);
			promoteCancels();
			return;
		}
		flow.state = "DELIVERED";
	}

	function promoteCancels(): void {
		if (closed || poisoned) return;
		while (pendingCancels.length > 0) {
			const flow = pendingCancels[0];
			if (flow.state !== "CANCEL_WAITING") {
				arrayShift(pendingCancels);
				continue;
			}
			if (!queueFits(16)) return;
			const encoded = encodeAppFrame(KIND_CANCEL, flow.stream, flow.id, undefined);
			if (!encoded.ok) {
				globalPoison();
				return;
			}
			flow.state = "CANCEL_SENT";
			arrayShift(pendingCancels);
			if (
				!enqueue(KIND_CANCEL, flow.stream, encoded.frame, (sent: boolean): void => {
					if (!sent && !closed) globalPoison();
				})
			) {
				zeroBytes(encoded.frame);
				flow.state = "CANCEL_WAITING";
				arrayUnshift(pendingCancels, flow);
				return;
			}
		}
	}

	function pendingCancelBlocks(): boolean {
		promoteCancels();
		return pendingCancels.length > 0 && !queueFits(16);
	}

	function consumeReply(flow: OutboundFlow): ReplyResult {
		if (flow.replyBytes === null) return RESULT_POISONED;
		const payload = copyBytes(flow.replyBytes);
		zeroBytes(flow.replyBytes);
		flow.replyBytes = null;
		releaseOutbound(flow);
		if (flow.state === "REPLY_READY_CANCEL") {
			addOutboundHistory(flow, "CANCEL_ACK");
		} else {
			finishOutboundWithoutHistory(flow);
		}
		finishTicket(flow);
		return capturedFreeze({ code: "REPLY_READY", payload });
	}

	function acceptReply(frame: DecodeResult): void {
		if (!frame.ok || frame.kind !== KIND_REPLY) {
			globalPoison();
			return;
		}
		const flow = mapGet(outLive[frame.stream], frame.requestId);
		if (flow === undefined) {
			const companion = mapGet(outWindows[frame.stream].history, frame.requestId);
			if (companion === "REPLY") {
				mapDelete(outWindows[frame.stream].history, frame.requestId);
				advanceWindow(outWindows[frame.stream]);
				return;
			}
			globalPoison();
			return;
		}
		if (flow.state === "DELIVERED") flow.state = "REPLY_READY";
		else if (flow.state === "CANCEL_SENT") flow.state = "REPLY_READY_CANCEL";
		else {
			globalPoison();
			return;
		}
		flow.replyBytes = copyBytes(frame.payload);
		if (flow.replyClaimed) {
			const result = consumeReply(flow);
			settleReply(flow, result);
		}
	}

	function acceptCancelAck(frame: DecodeResult): void {
		if (!frame.ok || frame.kind !== KIND_CANCEL_ACK) {
			globalPoison();
			return;
		}
		const flow = mapGet(outLive[frame.stream], frame.requestId);
		if (flow === undefined) {
			const companion = mapGet(outWindows[frame.stream].history, frame.requestId);
			if (companion === "CANCEL_ACK") {
				mapDelete(outWindows[frame.stream].history, frame.requestId);
				advanceWindow(outWindows[frame.stream]);
				return;
			}
			globalPoison();
			return;
		}
		if (flow.state === "CANCEL_SENT") {
			flow.state = "CANCELLED_TERMINAL";
			releaseOutbound(flow);
			setDelete(activeTickets, flow.ticket);
			addOutboundHistory(flow, "REPLY");
			if (flow.replyClaimed) {
				settleReply(flow, RESULT_CANCELLED);
				finishTicket(flow);
			}
			return;
		}
		if (flow.state === "REPLY_READY_CANCEL") {
			flow.state = "REPLY_READY_BOTH";
			return;
		}
		globalPoison();
	}

	function acceptDeliveryAck(frame: DecodeResult): void {
		if (!frame.ok || frame.kind !== KIND_DELIVERY_ACK) {
			globalPoison();
			return;
		}
		const flow = mapGet(outLive[frame.stream], frame.requestId);
		if (flow === undefined) {
			globalPoison();
			return;
		}
		if (flow.state === "REQUEST_QUEUED") {
			if (flow.ackEarly) globalPoison();
			else flow.ackEarly = true;
			return;
		}
		confirmDelivery(flow);
	}

	function finishInboundReply(flow: InboundFlow): void {
		if (flow.state === "BOTH_QUEUED" && !flow.cancelAckSendDone) return;
		releaseInbound(flow);
		removeInboundLive(flow);
		if (flow.state === "REPLY_QUEUED") mapSet(flow.window.history, flow.id, "CANCEL");
		flow.state = "COMPLETE";
		advanceWindow(flow.window);
	}

	function replySendSettled(flow: InboundFlow, sent: boolean): void {
		if (flow.state === "POISONED" || closed || poisoned) return;
		if (!sent) {
			globalPoison();
			return;
		}
		flow.replySendDone = true;
		if (flow.replyCallResolve !== null) {
			flow.replyCallResolve(RESULT_SENT);
			flow.replyCallResolve = null;
		}
		finishInboundReply(flow);
	}

	function cancelAckSendSettled(flow: InboundFlow, sent: boolean): void {
		if (flow.state === "POISONED" || closed || poisoned) return;
		if (!sent) {
			globalPoison();
			return;
		}
		flow.cancelAckSendDone = true;
		if (flow.state === "CANCEL_ACK_QUEUED") {
			releaseInbound(flow);
			removeInboundLive(flow);
			flow.state = "COMPLETE";
			advanceWindow(flow.window);
			return;
		}
		if (flow.state === "BOTH_QUEUED" && flow.replySendDone) finishInboundReply(flow);
	}

	function enqueueCancelAck(flow: InboundFlow): void {
		const encoded = encodeAppFrame(KIND_CANCEL_ACK, flow.stream, flow.id, undefined);
		if (!encoded.ok) {
			globalPoison();
			return;
		}
		if (
			!enqueue(KIND_CANCEL_ACK, flow.stream, encoded.frame, (sent: boolean): void =>
				cancelAckSendSettled(flow, sent),
			)
		) {
			zeroBytes(encoded.frame);
			globalPoison();
		}
	}

	function composedReply(flow: InboundFlow, payloadRaw: unknown): Promise<ComposedReplyResult> {
		if (closed) return resolved(RESULT_CLOSED);
		if (flow.replyUsed) {
			localPoisonInbound(flow);
			return resolved(RESULT_POISONED);
		}
		flow.replyUsed = true;
		if (flow.cancelSeen) return resolved(RESULT_CANCELLED);
		if (poisoned || flow.state === "POISONED") return resolved(RESULT_POISONED);
		if (flow.state !== "WAITING") {
			localPoisonInbound(flow);
			return resolved(RESULT_POISONED);
		}
		const prepared = preparePayload(payloadRaw);
		if (prepared === null) return resolved(RESULT_INPUT_INVALID);
		if (!queueFits(prepared.paddedLength)) {
			zeroBytes(prepared.bytes);
			globalPoison();
			return resolved(RESULT_POISONED);
		}
		const frame = makeDataFrame(KIND_REPLY, flow.stream, flow.id, prepared.bytes, prepared.paddedLength);
		zeroBytes(prepared.bytes);
		flow.state = "REPLY_QUEUED";
		const deferred = makeDeferred<ComposedReplyResult>();
		flow.replyCallPromise = deferred.promise;
		flow.replyCallResolve = deferred.resolve;
		if (!enqueue(KIND_REPLY, flow.stream, frame, (sent: boolean): void => replySendSettled(flow, sent))) {
			zeroBytes(frame);
			globalPoison();
			deferred.resolve(RESULT_POISONED);
		}
		return deferred.promise;
	}

	function dispatchInbound(flow: InboundFlow): void {
		if (closed || poisoned || flow.state !== "ACK_QUEUED") return;
		const source = flow.sourceBytes;
		if (source === null) {
			globalPoison();
			return;
		}
		const payload = copyBytes(source);
		zeroBytes(source);
		flow.sourceBytes = null;
		const controller = new CapturedAbortController();
		const signal = abortSignal(controller);
		if (signal === null) {
			zeroBytes(payload);
			globalPoison();
			return;
		}
		flow.controller = controller;
		if (flow.cancelSeen) abortController(controller);
		flow.state = "WAITING";
		const origin: EndpointSide = side === "Runtime" ? "Home" : "Runtime";
		const bundle: ApplicationBundle = capturedFreeze({
			origin,
			stream: flow.stream,
			payload,
			signal,
			reply: (payloadRaw: unknown): Promise<ComposedReplyResult> => composedReply(flow, payloadRaw),
		});
		try {
			invokeCaptured(dispatchApplication, dispatchRaw, [bundle]);
		} catch {
			zeroBytes(payload);
			globalPoison();
			return;
		}
		if (flow.cancelSeen && flow.state === "WAITING") {
			flow.state = "CANCEL_ACK_QUEUED";
			enqueueCancelAck(flow);
		}
	}

	function deliveryAckSettled(flow: InboundFlow, sent: boolean): void {
		if (closed || poisoned || flow.state === "POISONED") return;
		if (!sent) {
			globalPoison();
			return;
		}
		dispatchInbound(flow);
	}

	function admitInboundRequest(frame: DecodeResult): void {
		if (!frame.ok || frame.kind !== KIND_REQUEST) {
			globalPoison();
			return;
		}
		if (side === "Runtime" && frame.stream === 0) {
			globalPoison();
			return;
		}
		const window = inWindows[frame.stream];
		if (frame.requestId !== window.next) {
			globalPoison();
			return;
		}
		if (remoteLive >= MAX_LIVE_PER_ORIGIN || totalLive >= MAX_LIVE_TOTAL || !queueFits(16)) {
			globalPoison();
			return;
		}
		if (!reserveWindow(window)) {
			globalPoison();
			return;
		}
		const encoded = encodeAppFrame(KIND_DELIVERY_ACK, frame.stream, frame.requestId, undefined);
		if (!encoded.ok) {
			globalPoison();
			return;
		}
		const flow: InboundFlow = {
			stream: frame.stream,
			id: frame.requestId,
			window,
			state: "ACK_QUEUED",
			released: false,
			cancelSeen: false,
			replyUsed: false,
			sourceBytes: copyBytes(frame.payload),
			controller: null,
			replySendDone: false,
			cancelAckSendDone: false,
			replyCallPromise: null,
			replyCallResolve: null,
		};
		window.next += 1n;
		setAdd(window.occupied, flow.id);
		mapSet(inLive[flow.stream], flow.id, flow);
		remoteLive += 1;
		totalLive += 1;
		if (
			!enqueue(KIND_DELIVERY_ACK, flow.stream, encoded.frame, (sent: boolean): void =>
				deliveryAckSettled(flow, sent),
			)
		) {
			zeroBytes(encoded.frame);
			globalPoison();
		}
	}

	function enqueueHistoryCancelAck(stream: Stream, id: bigint, window: WindowState<InboundCompanion>): void {
		const encoded = encodeAppFrame(KIND_CANCEL_ACK, stream, id, undefined);
		if (!encoded.ok) {
			globalPoison();
			return;
		}
		mapSet(window.history, id, "CANCEL_PENDING");
		if (
			!enqueue(KIND_CANCEL_ACK, stream, encoded.frame, (sent: boolean): void => {
				if (!sent) {
					globalPoison();
					return;
				}
				mapDelete(window.history, id);
				advanceWindow(window);
			})
		) {
			zeroBytes(encoded.frame);
			globalPoison();
		}
	}

	function acceptInboundCancel(frame: DecodeResult): void {
		if (!frame.ok || frame.kind !== KIND_CANCEL) {
			globalPoison();
			return;
		}
		const flow = mapGet(inLive[frame.stream], frame.requestId);
		if (flow === undefined) {
			const companion = mapGet(inWindows[frame.stream].history, frame.requestId);
			if (companion === "CANCEL") {
				enqueueHistoryCancelAck(frame.stream, frame.requestId, inWindows[frame.stream]);
				return;
			}
			globalPoison();
			return;
		}
		if (flow.cancelSeen) {
			globalPoison();
			return;
		}
		flow.cancelSeen = true;
		if (flow.controller !== null) abortController(flow.controller);
		if (flow.state === "ACK_QUEUED") return;
		if (flow.state === "WAITING") flow.state = "CANCEL_ACK_QUEUED";
		else if (flow.state === "REPLY_QUEUED") flow.state = "BOTH_QUEUED";
		else {
			globalPoison();
			return;
		}
		enqueueCancelAck(flow);
	}

	function processFrame(frame: DecodeResult): void {
		if (!frame.ok) {
			globalPoison();
			return;
		}
		if (frame.kind === KIND_REQUEST) admitInboundRequest(frame);
		else if (frame.kind === KIND_DELIVERY_ACK) acceptDeliveryAck(frame);
		else if (frame.kind === KIND_REPLY) acceptReply(frame);
		else if (frame.kind === KIND_CANCEL) acceptInboundCancel(frame);
		else if (frame.kind === KIND_CANCEL_ACK) acceptCancelAck(frame);
		else globalPoison();
	}

	function pumpReceive(): void {
		if (receivePumping) return;
		receivePumping = true;
		while (receiveQueue.length > 0 && !poisoned && !closed) {
			const frame = arrayShift(receiveQueue);
			if (frame === undefined) continue;
			receiveQueuedBytes -= decodedPlaintextLength(frame);
			try {
				processFrame(frame);
			} finally {
				if (frame.ok && (frame.kind === KIND_REQUEST || frame.kind === KIND_REPLY)) zeroBytes(frame.payload);
			}
		}
		receivePumping = false;
	}

	function inboundHandler(streamRaw: unknown, plaintextRaw: unknown): void {
		if (closed || poisoned) return;
		const stream = narrowStream(streamRaw);
		if (stream === undefined) {
			globalPoison();
			return;
		}
		const decoded = decodeAppFrame(plaintextRaw);
		if (!decoded.ok || decoded.stream !== stream) {
			if (decoded.ok && (decoded.kind === KIND_REQUEST || decoded.kind === KIND_REPLY)) zeroBytes(decoded.payload);
			globalPoison();
			return;
		}
		const plaintextLength = decodedPlaintextLength(decoded);
		if (receiveQueue.length >= MAX_QUEUED_FRAMES || receiveQueuedBytes + plaintextLength > MAX_QUEUED_BYTES) {
			if (decoded.kind === KIND_REQUEST || decoded.kind === KIND_REPLY) zeroBytes(decoded.payload);
			globalPoison();
			return;
		}
		arrayPush(receiveQueue, decoded);
		receiveQueuedBytes += plaintextLength;
		pumpReceive();
	}

	function cleanupFailedInitialization(): void {
		const completion = callPhysicalClose();
		const cell: FailedInitializationCleanup = {
			actual: physicalCloseActual,
			observer: physicalCloseObserver,
			completion,
			reaction: null,
		};
		failedInitializationCleanup = cell;
		const release = (): void => {
			cell.actual = null;
			cell.observer = null;
			cell.reaction = null;
			if (failedInitializationCleanup === cell) failedInitializationCleanup = null;
		};
		cell.reaction = observePromise(completion, release, release, release);
		if (cell.reaction === null) dirty = true;
	}

	let registerRaw: unknown;
	try {
		registerRaw = invokeCaptured(physicalRegister, physicalRaw, [inboundHandler]);
	} catch {
		cleanupFailedInitialization();
		return null;
	}
	if (exactCode(registerRaw) !== "REGISTERED" || poisoned) {
		cleanupFailedInitialization();
		return null;
	}

	function checkCapability(
		candidate: unknown,
		expectedStream: Stream,
	): "CLOSED" | "POISONED" | "INPUT_INVALID" | "WRONG_OWNER" | "KNOWN" {
		if (closed) return "CLOSED";
		if (poisoned) return "POISONED";
		if (typeof candidate !== "object" || candidate === null || capturedIsProxy(candidate)) return "INPUT_INVALID";
		let prototype: object | null;
		try {
			prototype = capturedGetPrototypeOf(candidate);
		} catch {
			return "INPUT_INVALID";
		}
		if (prototype === null) return "INPUT_INVALID";
		const record = weakMapGet(family, prototype);
		if (record === undefined || record.owner !== owner) return "INPUT_INVALID";
		if (!weakMapHas(tickets, candidate)) {
			globalPoison();
			return "POISONED";
		}
		if (record.stream !== expectedStream) {
			const flow = weakMapGet(tickets, candidate);
			if (flow !== undefined) localPoisonOutbound(flow);
			return "WRONG_OWNER";
		}
		return "KNOWN";
	}

	function createOrigin(stream: Stream): OriginSubmit {
		const issuer = groupIssuers[stream];
		if (issuer === null) {
			return capturedFreeze({
				submit: (): SubmitResult => RESULT_EXHAUSTED,
				cancel: (): CancelResult => RESULT_INPUT_INVALID,
				pollDelivery: (): PollDeliveryResult => RESULT_INPUT_INVALID,
				pollReply: (): PollReplyResult => RESULT_INPUT_INVALID,
				awaitDelivery: (): Promise<DeliveryResult> => resolved(RESULT_POISONED),
				awaitReply: (): Promise<ReplyResult> => resolved(RESULT_POISONED),
			});
		}
		weakMapSet(family, issuer.prototype, { owner, stream });
		const originIssuer: PrivateIssuer = issuer;
		const window = outWindows[stream];

		function submit(payloadRaw: unknown): SubmitResult {
			if (closed) return RESULT_CLOSED;
			if (poisoned) return RESULT_POISONED;
			if (pendingCancelBlocks()) return RESULT_QUEUE_FULL;
			const prepared = preparePayload(payloadRaw);
			if (prepared === null) return RESULT_INPUT_INVALID;
			if (
				localLive >= MAX_LIVE_PER_ORIGIN ||
				totalLive >= MAX_LIVE_TOTAL ||
				!queueFits(prepared.paddedLength) ||
				!windowCanReserve(window)
			) {
				zeroBytes(prepared.bytes);
				return RESULT_EXHAUSTED;
			}
			if (!reserveWindow(window)) {
				zeroBytes(prepared.bytes);
				return RESULT_EXHAUSTED;
			}
			const id = window.next;
			const frame = makeDataFrame(KIND_REQUEST, stream, id, prepared.bytes, prepared.paddedLength);
			zeroBytes(prepared.bytes);
			let ticket: object;
			try {
				ticket = originIssuer.issue();
			} catch {
				zeroBytes(frame);
				globalPoison();
				return RESULT_POISONED;
			}
			const flow: OutboundFlow = {
				stream,
				id,
				ticket,
				window,
				state: "REQUEST_QUEUED",
				cancelWanted: false,
				ackEarly: false,
				released: false,
				replyClaimed: false,
				replyBytes: null,
				deliveryPromise: null,
				deliveryResolve: null,
				replyPromise: null,
				replyResolve: null,
			};
			window.next += 1n;
			setAdd(window.occupied, id);
			mapSet(outLive[stream], id, flow);
			weakMapSet(tickets, ticket, flow);
			setAdd(activeTickets, ticket);
			localLive += 1;
			totalLive += 1;
			if (!enqueue(KIND_REQUEST, stream, frame, (sent: boolean): void => requestSendSettled(flow, sent))) {
				zeroBytes(frame);
				globalPoison();
				return RESULT_POISONED;
			}
			if (poisoned) return RESULT_POISONED;
			return capturedFreeze({ code: "SUBMITTED", ticket });
		}

		function find(ticketRaw: unknown): OutboundFlow | CancelResult {
			const check = checkCapability(ticketRaw, stream);
			if (check === "CLOSED") return RESULT_CLOSED;
			if (check === "POISONED" || check === "WRONG_OWNER") return RESULT_POISONED;
			if (check === "INPUT_INVALID") return RESULT_INPUT_INVALID;
			if (typeof ticketRaw !== "object" || ticketRaw === null) return RESULT_INPUT_INVALID;
			const flow = weakMapGet(tickets, ticketRaw);
			if (flow !== undefined) return flow;
			globalPoison();
			return RESULT_POISONED;
		}

		function cancel(ticketRaw: unknown): CancelResult {
			const found = find(ticketRaw);
			if (!("stream" in found)) return found;
			const flow = found;
			if (flow.state === "POISONED") return RESULT_POISONED;
			if (flow.state === "REQUEST_QUEUED" || flow.state === "AWAIT_ACK") {
				flow.cancelWanted = true;
				return RESULT_PENDING;
			}
			if (flow.state === "DELIVERED") {
				flow.cancelWanted = true;
				flow.state = "CANCEL_WAITING";
				arrayPush(pendingCancels, flow);
				promoteCancels();
				return RESULT_PENDING;
			}
			if (flow.state === "CANCEL_WAITING" || flow.state === "CANCEL_SENT") return RESULT_PENDING;
			if (
				flow.state === "REPLY_READY" ||
				flow.state === "REPLY_READY_CANCEL" ||
				flow.state === "REPLY_READY_BOTH" ||
				flow.state === "CANCELLED_TERMINAL"
			) {
				return RESULT_CANCELLED;
			}
			return RESULT_FORBIDDEN_STATE;
		}

		function pollDelivery(ticketRaw: unknown): PollDeliveryResult {
			const found = find(ticketRaw);
			if (!("stream" in found)) {
				if (found.code === "CLOSED") return RESULT_CLOSED;
				if (found.code === "POISONED") return RESULT_POISONED;
				if (found.code === "UNKNOWN_TICKET") return RESULT_UNKNOWN_TICKET;
				return RESULT_INPUT_INVALID;
			}
			if (found.state === "POISONED") return RESULT_POISONED;
			return found.state === "REQUEST_QUEUED" || found.state === "AWAIT_ACK" ? RESULT_PENDING : RESULT_CONFIRMED;
		}

		function pollReply(ticketRaw: unknown): PollReplyResult {
			const found = find(ticketRaw);
			if (!("stream" in found)) {
				if (found.code === "CLOSED") return RESULT_CLOSED;
				if (found.code === "POISONED") return RESULT_POISONED;
				if (found.code === "UNKNOWN_TICKET") return RESULT_UNKNOWN_TICKET;
				return RESULT_INPUT_INVALID;
			}
			const flow = found;
			if (flow.state === "POISONED") return RESULT_POISONED;
			if (flow.replyClaimed) return RESULT_UNKNOWN_TICKET;
			if (flow.replyBytes !== null) {
				flow.replyClaimed = true;
				return consumeReply(flow);
			}
			if (flow.state === "CANCELLED_TERMINAL") {
				flow.replyClaimed = true;
				finishTicket(flow);
				return RESULT_CANCELLED;
			}
			return RESULT_PENDING;
		}

		function awaitDelivery(ticketRaw: unknown): Promise<DeliveryResult> {
			const found = find(ticketRaw);
			if (!("stream" in found)) {
				if (found.code === "CLOSED") return resolved(RESULT_CLOSED);
				return resolved(RESULT_POISONED);
			}
			const flow = found;
			if (flow.state === "POISONED") return resolved(RESULT_POISONED);
			if (flow.state !== "REQUEST_QUEUED" && flow.state !== "AWAIT_ACK") return resolved(RESULT_CONFIRMED);
			if (flow.deliveryPromise !== null) return flow.deliveryPromise;
			const deferred = makeDeferred<DeliveryResult>();
			flow.deliveryPromise = deferred.promise;
			flow.deliveryResolve = deferred.resolve;
			return deferred.promise;
		}

		function awaitReply(ticketRaw: unknown): Promise<ReplyResult> {
			const found = find(ticketRaw);
			if (!("stream" in found)) {
				if (found.code === "CLOSED") return resolved(RESULT_CLOSED);
				if (found.code === "UNKNOWN_TICKET") return resolved(RESULT_UNKNOWN_TICKET);
				return resolved(RESULT_POISONED);
			}
			const flow = found;
			if (flow.state === "POISONED") return resolved(RESULT_POISONED);
			if (flow.replyClaimed) return resolved(RESULT_UNKNOWN_TICKET);
			flow.replyClaimed = true;
			if (flow.replyBytes !== null) return resolved(consumeReply(flow));
			if (flow.state === "CANCELLED_TERMINAL") {
				finishTicket(flow);
				return resolved(RESULT_CANCELLED);
			}
			const deferred = makeDeferred<ReplyResult>();
			flow.replyPromise = deferred.promise;
			flow.replyResolve = deferred.resolve;
			return deferred.promise;
		}

		return capturedFreeze({ submit, cancel, pollDelivery, pollReply, awaitDelivery, awaitReply });
	}

	function appendCloseWait(chain: Promise<unknown>, promise: Promise<unknown>): Promise<unknown> {
		const joined = joinPromises(chain, promise);
		if (joined.firstObserver === null || joined.secondObserver === null) dirty = true;
		else {
			arrayPush(closeOwnedObservers, joined.firstObserver);
			arrayPush(closeOwnedObservers, joined.secondObserver);
		}
		arrayPush(closeOwnedObservers, joined.promise);
		return joined.promise;
	}

	function drainClosingSend(entry: QueueEntry): Promise<unknown> {
		const deferred = makeDeferred<unknown>();
		const completionObserver = observePromise(
			entry.completion,
			(): void => {
				let chain: Promise<unknown> = resolved(true);
				arrayPush(closeOwnedObservers, chain);
				if (entry.actual !== null) chain = appendCloseWait(chain, entry.actual);
				else if (entry.observer !== null) dirty = true;
				if (entry.observer !== null) chain = appendCloseWait(chain, entry.observer);
				else if (entry.actual !== null) dirty = true;
				chain = appendCloseWait(chain, entry.completion);
				chain = appendCloseWait(chain, entry.tail);
				if (entry.tailFirstObserver !== null) chain = appendCloseWait(chain, entry.tailFirstObserver);
				if (entry.tailSecondObserver !== null) chain = appendCloseWait(chain, entry.tailSecondObserver);
				const observer = observePromise(
					chain,
					(): void => deferred.resolve(true),
					(): void => {
						dirty = true;
						deferred.resolve(false);
					},
					(): void => {
						dirty = true;
						deferred.resolve(false);
					},
				);
				if (observer === null) {
					dirty = true;
					deferred.resolve(false);
				} else arrayPush(closeOwnedObservers, observer);
			},
			(): void => {
				dirty = true;
				deferred.resolve(false);
			},
			(): void => {
				dirty = true;
				deferred.resolve(false);
			},
		);
		if (completionObserver === null) {
			dirty = true;
			deferred.resolve(false);
		} else arrayPush(closeOwnedObservers, completionObserver);
		arrayPush(closeOwnedObservers, deferred.promise);
		return deferred.promise;
	}

	function drainClose(
		closingSend: QueueEntry | null,
		closingTail: Promise<unknown> | null,
		resolveClose: (value: CleanupResult) => void,
	): Promise<unknown> | null {
		let chain: Promise<unknown> = resolved(true);
		arrayPush(closeOwnedObservers, chain);
		if (physicalCloseActual !== null) chain = appendCloseWait(chain, physicalCloseActual);
		if (physicalCloseObserver !== null) chain = appendCloseWait(chain, physicalCloseObserver);
		if (physicalCloseCompletion !== null) chain = appendCloseWait(chain, physicalCloseCompletion);
		else dirty = true;
		if (closingSend !== null) chain = appendCloseWait(chain, drainClosingSend(closingSend));
		if (closingTail !== null) chain = appendCloseWait(chain, closingTail);
		const observer = observePromise(
			chain,
			(): void => {
				resolveClose(
					!dirty && physicalCloseSucceeded && closeDrainObserver !== null ? RESULT_CLEAN : RESULT_POISONED,
				);
			},
			(): void => {
				dirty = true;
				resolveClose(RESULT_POISONED);
			},
			(): void => {
				dirty = true;
				resolveClose(RESULT_POISONED);
			},
		);
		if (observer !== null) arrayPush(closeOwnedObservers, observer);
		else {
			dirty = true;
			resolveClose(RESULT_POISONED);
		}
		return observer;
	}

	function close(): Promise<CleanupResult> {
		if (closePromise !== null) return closePromise;
		const deferred = makeDeferred<CleanupResult>();
		closePromise = deferred.promise;
		closed = true;
		abortVisibleInbound();
		dropQueuedWork("CLOSED");
		const closingSend = activeSend;
		const closingTail = sendTail;
		callPhysicalClose();
		closeDrainObserver = drainClose(closingSend, closingTail, deferred.resolve);
		return closePromise;
	}

	return { createOrigin, close };
}

export function createRuntimeMultiplexer(physicalRaw: unknown, dispatchRaw: unknown): RuntimeInitResult {
	const core = buildCore("Runtime", physicalRaw, dispatchRaw);
	if (core === null) return RESULT_INIT_FAILURE;
	return capturedFreeze({
		modelToHome: core.createOrigin(0),
		lifecycleToHome: core.createOrigin(1),
		messagesToHome: core.createOrigin(2),
		observeRequestsToHome: core.createOrigin(3),
		observeRepliesToHome: core.createOrigin(4),
		close: core.close,
	});
}

export function createHomeMultiplexer(physicalRaw: unknown, dispatchRaw: unknown): HomeInitResult {
	const core = buildCore("Home", physicalRaw, dispatchRaw);
	if (core === null) return RESULT_INIT_FAILURE;
	return capturedFreeze({
		lifecycleToRuntime: core.createOrigin(1),
		messagesToRuntime: core.createOrigin(2),
		observeRequestsToRuntime: core.createOrigin(3),
		observeRepliesToRuntime: core.createOrigin(4),
		close: core.close,
	});
}
