import { types } from "node:util";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";
import {
	closeSandboxTransportChannel,
	copySandboxTransportSessionId,
	decryptSandboxTransportFrame,
	encryptSandboxTransportFrame,
	SANDBOX_TRANSPORT_HEADER_BYTES,
	SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES,
	SANDBOX_TRANSPORT_TAG_BYTES,
} from "./prime-sandbox-transport.js";

const CapturedPromise = Promise;
const CapturedArray = Array;
const CapturedUint8Array = Uint8Array;
const CapturedArrayBuffer = ArrayBuffer;
const CapturedDataView = DataView;
const capturedObjectPrototype = Object.prototype;
const capturedPromisePrototype = Promise.prototype;
const capturedSpeciesSymbol = Symbol.species;
const capturedApply = Reflect.apply;
const capturedOwnKeys = Reflect.ownKeys;
const capturedGetPrototypeOf = Object.getPrototypeOf;
const capturedGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const capturedGetOwnPropertyNames = Object.getOwnPropertyNames;
const capturedGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const capturedDefineProperty = Object.defineProperty;
const capturedDeleteProperty = Reflect.deleteProperty;
const capturedFreeze = Object.freeze;
const capturedIsFrozen = Object.isFrozen;
const capturedIsExtensible = Object.isExtensible;
const capturedIsProxy = types.isProxy;
const capturedIsPromise = types.isPromise;
const capturedArrayPush = Array.prototype.push;
const capturedArrayIndexOf = Array.prototype.indexOf;
const capturedArraySplice = Array.prototype.splice;
const capturedTypedArrayFill = Uint8Array.prototype.fill;
const capturedTypedArraySet = Uint8Array.prototype.set;
const capturedDataViewGetUint32 = DataView.prototype.getUint32;
const capturedPromiseThenDescriptor = capturedGetOwnPropertyDescriptor(capturedPromisePrototype, "then");
const capturedPromiseThen = capturedPromiseThenDescriptor?.value;

const IO_METHODS = capturedFreeze(["readExact", "writeExact", "close", "readClassified", "waitClosed"]);
const HEADER_PREFIX_BYTES = 24;
const READ_TIMEOUT_MS = 5_000;
const WRITE_TIMEOUT_MS = 5_000;
const MAX_WIRE_BYTES =
	SANDBOX_TRANSPORT_HEADER_BYTES + SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES + SANDBOX_TRANSPORT_TAG_BYTES;

const CAPTURE_FAILED =
	typeof capturedPromiseThen !== "function" ||
	typeof capturedTypedArrayFill !== "function" ||
	typeof capturedTypedArraySet !== "function" ||
	typeof capturedDataViewGetUint32 !== "function";

type Stream = 0 | 1 | 2 | 3 | 4;
type SendResult = Readonly<{ code: "SENT" | "FAILED" }>;
type RegisterResult = Readonly<{ code: "REGISTERED" | "ALREADY_EXISTS" | "FAILED" }>;
type CloseResult = Readonly<{ code: "CLOSED" | "FAILED" }>;

export type SandboxV31PhysicalPort = Readonly<{
	send(streamRaw: unknown, plaintextRaw: unknown): Promise<SendResult>;
	registerInbound(handlerRaw: unknown): RegisterResult;
	close(): Promise<CloseResult>;
}>;

export type SandboxV31PhysicalPortResult =
	| Readonly<{ ok: true; value: SandboxV31PhysicalPort }>
	| Readonly<{ ok: false; code: "INPUT_INVALID" }>;

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

interface OwnedPromiseChain {
	readonly actual: Promise<unknown>;
	readonly observer: Promise<unknown>;
	readonly tail: Promise<unknown>;
}

interface CapturedIo {
	readonly raw: object;
	readonly writeExact: unknown;
	readonly close: unknown;
	readonly readClassified: unknown;
	readonly waitClosed: unknown;
}

const localPromiseSpeciesHolder = capturedFreeze({
	[capturedSpeciesSymbol]: CapturedPromise,
});

function arrayPush<T>(array: T[], value: T): void {
	capturedApply(capturedArrayPush, array, [value]);
}

function arrayRemove<T>(array: T[], value: T): void {
	const index = capturedApply(capturedArrayIndexOf, array, [value]);
	if (typeof index === "number" && index >= 0) capturedApply(capturedArraySplice, array, [index, 1]);
}

function zero(value: unknown): void {
	if (value === undefined) return;
	try {
		capturedApply(capturedTypedArrayFill, value, [0]);
	} catch {
		// The caller has already revoked the operation. There is no alternate byte sink.
	}
}

function fixed<C extends string>(code: C): Readonly<{ code: C }> {
	return capturedFreeze({ code });
}

function makeDeferred<T>(): Deferred<T> {
	let resolver: ((value: T) => void) | undefined;
	const promise = new CapturedPromise<T>((resolve) => {
		resolver = resolve;
	});
	return {
		promise,
		resolve(value: T): void {
			resolver?.(value);
		},
	};
}

function exactNativePromise(raw: unknown): raw is Promise<unknown> {
	try {
		return (
			typeof raw === "object" &&
			raw !== null &&
			!capturedIsProxy(raw) &&
			capturedIsPromise(raw) &&
			capturedGetPrototypeOf(raw) === capturedPromisePrototype &&
			capturedGetOwnPropertyNames(raw).length === 0 &&
			capturedGetOwnPropertySymbols(raw).length === 0 &&
			capturedIsExtensible(raw)
		);
	} catch {
		return false;
	}
}

function observePromise(
	promise: Promise<unknown>,
	fulfilled: (value: unknown) => void,
	rejected: () => void,
	callbackFault: () => void,
): Promise<unknown> | undefined {
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
	return installed && removed && exactNativePromise(result) ? result : undefined;
}

function exactPlainFrozen(raw: unknown, names: readonly string[]): raw is object {
	try {
		if (
			typeof raw !== "object" ||
			raw === null ||
			capturedIsProxy(raw) ||
			capturedGetPrototypeOf(raw) !== capturedObjectPrototype ||
			!capturedIsFrozen(raw)
		)
			return false;
		const keys = capturedOwnKeys(raw);
		if (keys.length !== names.length) return false;
		for (const key of keys) {
			if (typeof key !== "string") return false;
			let found = false;
			for (const name of names) {
				if (name === key) found = true;
			}
			if (!found) return false;
			const descriptor = capturedGetOwnPropertyDescriptor(raw, key);
			if (descriptor === undefined || !("value" in descriptor)) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function ownValue(raw: object, name: string): unknown {
	try {
		const descriptor = capturedGetOwnPropertyDescriptor(raw, name);
		return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function isFunction(raw: unknown): boolean {
	try {
		return typeof raw === "function" && !capturedIsProxy(raw);
	} catch {
		return false;
	}
}

function invoke(target: unknown, receiver: unknown, argumentsList: Array<unknown>): unknown {
	return typeof target === "function" ? capturedApply(target, receiver, argumentsList) : undefined;
}

function captureIo(raw: unknown): CapturedIo | undefined {
	try {
		if (typeof raw !== "object" || raw === null || capturedIsProxy(raw)) return undefined;
		if (capturedGetPrototypeOf(raw) !== capturedObjectPrototype) return undefined;
		const keys = capturedOwnKeys(raw);
		if (keys.length !== IO_METHODS.length) return undefined;
		for (const name of IO_METHODS) {
			const descriptor = capturedGetOwnPropertyDescriptor(raw, name);
			if (descriptor === undefined || !("value" in descriptor) || typeof descriptor.value !== "function") {
				return undefined;
			}
		}
		for (const key of keys) {
			if (typeof key !== "string") return undefined;
			let found = false;
			for (const name of IO_METHODS) {
				if (name === key) found = true;
			}
			if (!found) return undefined;
		}
		const writeExact = ownValue(raw, "writeExact");
		const close = ownValue(raw, "close");
		const readClassified = ownValue(raw, "readClassified");
		const waitClosed = ownValue(raw, "waitClosed");
		if (!isFunction(writeExact) || !isFunction(close) || !isFunction(readClassified) || !isFunction(waitClosed))
			return undefined;
		return { raw, writeExact, close, readClassified, waitClosed };
	} catch {
		return undefined;
	}
}

function validStream(raw: unknown): raw is Stream {
	return raw === 0 || raw === 1 || raw === 2 || raw === 3 || raw === 4;
}

function transportStream(stream: Stream): bigint {
	if (stream === 0) return 0n;
	if (stream === 1) return 1n;
	if (stream === 2) return 2n;
	if (stream === 3) return 3n;
	return 4n;
}

function decryptedStream(stream: bigint): Stream | undefined {
	if (stream === 0n) return 0;
	if (stream === 1n) return 1;
	if (stream === 2n) return 2;
	if (stream === 3n) return 3;
	if (stream === 4n) return 4;
	return undefined;
}

function takeTransportBytes(raw: unknown, maximum: number): Uint8Array | undefined {
	if (!exactPlainFrozen(raw, ["ok", "value"]) || ownValue(raw, "ok") !== true) return undefined;
	const source = ownValue(raw, "value");
	const copied = copySandboxStrictBytes(source, maximum);
	zero(source);
	return copied.ok ? copied.value : undefined;
}

function takeDecryptedFrame(raw: unknown): { stream: Stream; plaintext: Uint8Array } | undefined {
	if (!exactPlainFrozen(raw, ["ok", "value"]) || ownValue(raw, "ok") !== true) return undefined;
	const frame = ownValue(raw, "value");
	if (!exactPlainFrozen(frame, ["streamId", "plaintext"])) return undefined;
	const source = ownValue(frame, "plaintext");
	const streamId = ownValue(frame, "streamId");
	if (typeof streamId !== "bigint" || streamId < 0n || streamId > 4n) {
		zero(source);
		return undefined;
	}
	const copied = copySandboxStrictBytes(source, SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES);
	zero(source);
	if (!copied.ok) return undefined;
	const stream = decryptedStream(streamId);
	if (stream === undefined) {
		zero(copied.value);
		return undefined;
	}
	return { stream, plaintext: copied.value };
}

function takeReadData(raw: unknown, length: number): Uint8Array | undefined {
	if (!exactPlainFrozen(raw, ["type", "data"]) || ownValue(raw, "type") !== "DATA") return undefined;
	const source = ownValue(raw, "data");
	const copied = copySandboxStrictBytes(source, length);
	zero(source);
	if (!copied.ok || copied.value.byteLength !== length) {
		if (copied.ok) zero(copied.value);
		return undefined;
	}
	return copied.value;
}

function discardReadData(raw: unknown): void {
	if (exactPlainFrozen(raw, ["type", "data"]) && ownValue(raw, "type") === "DATA") {
		zero(ownValue(raw, "data"));
	}
}

function concatenate(first: Uint8Array, second: Uint8Array): Uint8Array | undefined {
	try {
		const result = new CapturedUint8Array(new CapturedArrayBuffer(first.byteLength + second.byteLength));
		capturedApply(capturedTypedArraySet, result, [first, 0]);
		capturedApply(capturedTypedArraySet, result, [second, first.byteLength]);
		return result;
	} catch {
		return undefined;
	}
}

function plaintextLength(header: Uint8Array): number | undefined {
	try {
		const view = new CapturedDataView(header.buffer, header.byteOffset, header.byteLength);
		const value = capturedApply(capturedDataViewGetUint32, view, [16, false]);
		return typeof value === "number" && value <= SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES ? value : undefined;
	} catch {
		return undefined;
	}
}

export function createSandboxV31PhysicalPort(ioRaw: unknown, channelRaw: unknown): SandboxV31PhysicalPortResult {
	if (CAPTURE_FAILED) return capturedFreeze({ ok: false, code: "INPUT_INVALID" });
	const capturedIo = captureIo(ioRaw);
	if (capturedIo === undefined) return capturedFreeze({ ok: false, code: "INPUT_INVALID" });
	const io = capturedIo;
	let sessionId: Uint8Array | undefined;
	try {
		sessionId = copySandboxTransportSessionId(channelRaw);
	} catch {
		sessionId = undefined;
	}
	if (sessionId === undefined) return capturedFreeze({ ok: false, code: "INPUT_INVALID" });
	zero(sessionId);

	let registered = false;
	let handler: unknown;
	let stopped = false;
	let poisoned = false;
	let sendBusy = false;
	let pendingDrains = 0;
	let waitClosedDone = false;
	let waitClosedSucceeded = false;
	let closeIoSucceeded = true;
	let closeChannelSucceeded = true;
	let shutdownStarted = false;
	const closeWaiters = new CapturedArray<Deferred<CloseResult>>();
	const promiseChains = new CapturedArray<OwnedPromiseChain>();
	let activeSendPromise: Promise<unknown> | null = null;

	function finishCloseWaiters(): void {
		if (!shutdownStarted || !waitClosedDone || pendingDrains !== 0 || activeSendPromise !== null) return;
		const succeeded = !poisoned && waitClosedSucceeded && closeIoSucceeded && closeChannelSucceeded;
		while (closeWaiters.length > 0) {
			const waiter = closeWaiters[0];
			if (waiter === undefined) return;
			arrayRemove(closeWaiters, waiter);
			waiter.resolve(fixed(succeeded ? "CLOSED" : "FAILED"));
		}
	}

	function markDrain(): void {
		pendingDrains -= 1;
		finishCloseWaiters();
	}

	function track(actualRaw: unknown, fulfilled: (value: unknown) => void, rejected: () => void): boolean {
		if (!exactNativePromise(actualRaw)) return false;
		const actual = actualRaw;
		pendingDrains += 1;
		const observer = observePromise(actual, fulfilled, rejected, (): void => {
			try {
				rejected();
			} catch {
				failOperation();
				return;
			}
			failOperation();
		});
		if (observer === undefined) {
			pendingDrains -= 1;
			return false;
		}
		let record: OwnedPromiseChain | undefined;
		let finished = false;
		const finish = (): void => {
			if (finished) return;
			finished = true;
			if (record !== undefined) arrayRemove(promiseChains, record);
			markDrain();
		};
		const tail = observePromise(observer, finish, finish, (): void => {
			failOperation();
			finish();
		});
		if (tail === undefined) {
			pendingDrains -= 1;
			return false;
		}
		record = { actual, observer, tail };
		arrayPush(promiseChains, record);
		return true;
	}

	function beginShutdown(asPoison: boolean): void {
		if (asPoison) poisoned = true;
		stopped = true;
		if (shutdownStarted) {
			finishCloseWaiters();
			return;
		}
		shutdownStarted = true;
		try {
			invoke(io.close, io.raw, []);
		} catch {
			closeIoSucceeded = false;
		}
		try {
			closeChannelSucceeded = closeSandboxTransportChannel(channelRaw);
		} catch {
			closeChannelSucceeded = false;
		}
		let waitActual: unknown;
		try {
			waitActual = invoke(io.waitClosed, io.raw, []);
		} catch {
			waitActual = undefined;
		}
		const tracked = track(
			waitActual,
			(): void => {
				waitClosedSucceeded = true;
				waitClosedDone = true;
			},
			(): void => {
				waitClosedDone = true;
			},
		);
		if (!tracked) waitClosedDone = true;
		finishCloseWaiters();
	}

	function failOperation(): void {
		beginShutdown(true);
	}

	function invokeRead(length: number, fulfilled: (value: unknown) => void, failed: () => void = failOperation): void {
		if (stopped) return;
		let actual: unknown;
		try {
			actual = invoke(io.readClassified, io.raw, [length, READ_TIMEOUT_MS]);
		} catch {
			failed();
			return;
		}
		if (!track(actual, fulfilled, failed)) failed();
	}

	function receiveHeader(): void {
		invokeRead(HEADER_PREFIX_BYTES, (raw: unknown): void => {
			if (stopped) {
				discardReadData(raw);
				return;
			}
			const prefix = takeReadData(raw, HEADER_PREFIX_BYTES);
			if (prefix === undefined) {
				failOperation();
				return;
			}
			const length = plaintextLength(prefix);
			if (length === undefined) {
				zero(prefix);
				failOperation();
				return;
			}
			const remainderLength =
				SANDBOX_TRANSPORT_HEADER_BYTES - HEADER_PREFIX_BYTES + length + SANDBOX_TRANSPORT_TAG_BYTES;
			invokeRead(
				remainderLength,
				(tailRaw: unknown): void => {
					if (stopped) {
						discardReadData(tailRaw);
						zero(prefix);
						return;
					}
					const remainder = takeReadData(tailRaw, remainderLength);
					if (remainder === undefined) {
						zero(prefix);
						failOperation();
						return;
					}
					const wire = concatenate(prefix, remainder);
					zero(prefix);
					zero(remainder);
					if (wire === undefined || wire.byteLength > MAX_WIRE_BYTES) {
						zero(wire);
						failOperation();
						return;
					}
					let decryptActual: unknown;
					try {
						decryptActual = decryptSandboxTransportFrame(channelRaw, wire);
					} catch {
						zero(wire);
						failOperation();
						return;
					}
					const tracked = track(
						decryptActual,
						(result: unknown): void => {
							zero(wire);
							if (stopped) {
								const discarded = takeDecryptedFrame(result);
								if (discarded !== undefined) zero(discarded.plaintext);
								return;
							}
							const frame = takeDecryptedFrame(result);
							if (frame === undefined) {
								failOperation();
								return;
							}
							const dispatchCopy = copySandboxStrictBytes(
								frame.plaintext,
								SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES,
							);
							zero(frame.plaintext);
							if (!dispatchCopy.ok) {
								failOperation();
								return;
							}
							let callbackFailed = false;
							const inboundHandler = handler;
							if (inboundHandler === undefined) {
								zero(dispatchCopy.value);
								failOperation();
								return;
							}
							try {
								invoke(inboundHandler, undefined, [frame.stream, dispatchCopy.value]);
							} catch {
								callbackFailed = true;
							} finally {
								zero(dispatchCopy.value);
							}
							if (callbackFailed) {
								failOperation();
								return;
							}
							if (!stopped) receiveHeader();
						},
						(): void => {
							zero(wire);
							if (!stopped) failOperation();
						},
					);
					if (!tracked) {
						zero(wire);
						failOperation();
					}
				},
				(): void => {
					zero(prefix);
					failOperation();
				},
			);
		});
	}

	function send(streamRaw: unknown, plaintextRaw: unknown): Promise<SendResult> {
		const deferred = makeDeferred<SendResult>();
		if (stopped || sendBusy || !validStream(streamRaw)) {
			deferred.resolve(fixed("FAILED"));
			return deferred.promise;
		}
		const copied = copySandboxStrictBytes(plaintextRaw, SANDBOX_TRANSPORT_MAX_PLAINTEXT_BYTES);
		if (!copied.ok) {
			deferred.resolve(fixed("FAILED"));
			return deferred.promise;
		}
		const plaintext = copied.value;
		activeSendPromise = deferred.promise;
		sendBusy = true;
		let encryptActual: unknown;
		try {
			encryptActual = encryptSandboxTransportFrame(channelRaw, transportStream(streamRaw), plaintext);
		} catch {
			encryptActual = undefined;
		}
		const encryptTracked = track(
			encryptActual,
			(result: unknown): void => {
				const wire = takeTransportBytes(result, MAX_WIRE_BYTES);
				if (stopped) {
					zero(plaintext);
					zero(wire);
					sendBusy = false;
					activeSendPromise = null;
					deferred.resolve(fixed("FAILED"));
					return;
				}
				if (wire === undefined) {
					zero(plaintext);
					sendBusy = false;
					activeSendPromise = null;
					deferred.resolve(fixed("FAILED"));
					failOperation();
					return;
				}
				let writeActual: unknown;
				try {
					writeActual = invoke(io.writeExact, io.raw, [wire, WRITE_TIMEOUT_MS]);
				} catch {
					writeActual = undefined;
				}
				const writeTracked = track(
					writeActual,
					(value: unknown): void => {
						const sent = value === true && !stopped;
						deferred.resolve(fixed(sent ? "SENT" : "FAILED"));
						zero(plaintext);
						zero(wire);
						sendBusy = false;
						activeSendPromise = null;
						if (!sent && !stopped) failOperation();
					},
					(): void => {
						deferred.resolve(fixed("FAILED"));
						zero(plaintext);
						zero(wire);
						sendBusy = false;
						activeSendPromise = null;
						if (!stopped) failOperation();
					},
				);
				if (!writeTracked) {
					deferred.resolve(fixed("FAILED"));
					zero(plaintext);
					zero(wire);
					sendBusy = false;
					activeSendPromise = null;
					failOperation();
				}
			},
			(): void => {
				deferred.resolve(fixed("FAILED"));
				zero(plaintext);
				sendBusy = false;
				activeSendPromise = null;
				if (!stopped) failOperation();
			},
		);
		if (!encryptTracked) {
			deferred.resolve(fixed("FAILED"));
			zero(plaintext);
			sendBusy = false;
			activeSendPromise = null;
			failOperation();
		}
		return deferred.promise;
	}

	function registerInbound(handlerRaw: unknown): RegisterResult {
		if (registered) return fixed("ALREADY_EXISTS");
		if (stopped || !isFunction(handlerRaw)) return fixed("FAILED");
		handler = handlerRaw;
		registered = true;
		receiveHeader();
		return fixed(stopped ? "FAILED" : "REGISTERED");
	}

	function close(): Promise<CloseResult> {
		const deferred = makeDeferred<CloseResult>();
		arrayPush(closeWaiters, deferred);
		beginShutdown(false);
		finishCloseWaiters();
		return deferred.promise;
	}

	try {
		const physical = capturedFreeze({ send, registerInbound, close });
		return capturedFreeze({ ok: true, value: physical });
	} catch {
		return capturedFreeze({ ok: false, code: "INPUT_INVALID" });
	}
}
