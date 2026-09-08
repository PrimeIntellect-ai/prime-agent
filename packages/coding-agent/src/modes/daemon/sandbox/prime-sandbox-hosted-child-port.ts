// Hosted sandbox child port V1 - MVP logical child port adapter.
//
// Wraps the V31 HomeMultiplexer.lifecycleToRuntime OriginSubmit and the
// HomeStreamRouter.registerLifecycleChild capability into a raw port whose
// 7-key order (identity, startInitialTask, awaitTerminal, abort, observe,
// subscribe, close) is compatible with the hardened createHostedRlmRuntimePort
// wrapper.
//
// Transport capabilities are captured once. Logical child cleanup does not
// close parent-owned shared transport resources.

import { types } from "node:util";
import type {
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmRuntimePortFactoryResult,
	HostedRlmTaskResult,
} from "../../../core/hosted-rlm-runtime-port.js";
import { createHostedRlmRuntimePort } from "../../../core/hosted-rlm-runtime-port.js";
import type { HomeStreamRouter, HostedRlmLifecycleSettle } from "./prime-sandbox-home-stream-router.js";
import { decodeLifecycleReply, encodeLifecycleRecord } from "./prime-sandbox-runtime-control-codec.js";
import { copySandboxStrictBytes } from "./prime-sandbox-strict-bytes.js";
import type { OriginSubmit } from "./prime-sandbox-v31-multiplexer.js";

// ---------- captured intrinsics ----------

const _freeze: typeof Object.freeze = Object.freeze;
const _NativePromise: PromiseConstructor = Promise;
const _promiseThen: typeof Promise.prototype.then = Promise.prototype.then;
const _reflectApply: typeof Reflect.apply = Reflect.apply;
const _typesIsProxy: (value: unknown) => boolean = types.isProxy;
const _ownPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _ownSymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _protoOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _isExtensible: typeof Object.isExtensible = Object.isExtensible;
const _nativePromiseProto: unknown = Promise.prototype;
const _objectProto: unknown = Object.prototype;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _queueMicrotask: typeof queueMicrotask = queueMicrotask;
const _arrayPush: typeof Array.prototype.push = Array.prototype.push;
const _arraySplice: typeof Array.prototype.splice = Array.prototype.splice;
const _uint8Array: typeof Uint8Array = Uint8Array;
const _uint8Proto: unknown = _uint8Array.prototype;
const _regexpTest: typeof RegExp.prototype.test = RegExp.prototype.test;
const _identityPattern = /^[a-zA-Z0-9_./:-]{1,128}$/;
const _maxActivePerChild: number = 32;

// ---------- exact key orders ----------

const _ORIGIN_KEYS: ReadonlyArray<string> = _freeze([
	"submit",
	"cancel",
	"pollDelivery",
	"pollReply",
	"awaitDelivery",
	"awaitReply",
]);

const _ROUTER_KEYS: ReadonlyArray<string> = _freeze(["dispatchApplication", "close", "registerLifecycleChild"]);
const _CODE_KEYS: ReadonlyArray<string> = _freeze(["code"]);
const _SUBMIT_KEYS: ReadonlyArray<string> = _freeze(["code", "ticket"]);
const _REPLY_KEYS: ReadonlyArray<string> = _freeze(["code", "payload"]);
const _REGISTRATION_KEYS: ReadonlyArray<string> = _freeze(["unregister"]);

// ---------- Deferred ----------

interface _Deferred<T> {
	readonly promise: Promise<T>;
	resolve: (value: T) => void;
}

function _defer<T>(): _Deferred<T> {
	var resolve: (value: T) => void = () => {};
	var promise: Promise<T> = new _NativePromise<T>((res: (value: T) => void): void => {
		resolve = res;
	});
	return { promise: promise, resolve: resolve };
}

// ---------- resolved / rejected helpers ----------

function _resolved<T>(value: T): Promise<T> {
	return new _NativePromise<T>((resolve: (value: T) => void): void => {
		resolve(value);
	});
}

function _rejected(): Promise<never> {
	return new _NativePromise<never>((_resolve: (value: never) => void, reject: (reason: unknown) => void): void => {
		reject(_CLOSE_SENTINEL);
	});
}

function _zeroBytes(bytes: Uint8Array): void {
	for (let i: number = 0; i < bytes.length; i++) bytes[i] = 0;
}

// ---------- sentinel ----------

const _CLOSE_SENTINEL: Readonly<{ _sentinel: true }> = _freeze({ _sentinel: true });

// ---------- exact record validation ----------

function _validateExactRecord(raw: unknown, allowedKeys: ReadonlyArray<string>): Record<string, unknown> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (_typesIsProxy(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (_protoOf(raw) !== _objectProto) return null;
	} catch {
		return null;
	}
	try {
		if (_isExtensible(raw)) return null;
	} catch {
		return null;
	}
	var names: string[];
	try {
		names = _ownPropertyNames(raw);
	} catch {
		return null;
	}
	var symbols: symbol[];
	try {
		symbols = _ownSymbols(raw);
	} catch {
		return null;
	}
	if (names.length !== allowedKeys.length) return null;
	if (symbols.length !== 0) return null;
	for (let ki: number = 0; ki < allowedKeys.length; ki++) {
		if (names[ki] !== allowedKeys[ki]) return null;
	}
	var descs: Record<string, PropertyDescriptor>;
	try {
		descs = _getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
	var result: Record<string, unknown> = {};
	for (let ki: number = 0; ki < allowedKeys.length; ki++) {
		const key: string = allowedKeys[ki];
		const desc: PropertyDescriptor | undefined = descs[key];
		if (
			desc === undefined ||
			!("value" in desc) ||
			!desc.enumerable ||
			desc.configurable !== false ||
			desc.writable !== false
		)
			return null;
		result[key] = desc.value;
	}
	return result;
}

// ---------- type guard helpers ----------

function _isCallable(raw: unknown): raw is CallableFunction {
	if (typeof raw !== "function") return false;
	try {
		if (_typesIsProxy(raw)) return false;
	} catch {
		return false;
	}
	return true;
}

function _isExactUint8Array(raw: unknown): raw is Uint8Array {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (_typesIsProxy(raw)) return false;
		if (_protoOf(raw) !== _uint8Proto) return false;
	} catch {
		return false;
	}
	return true;
}

function _validIdentityPart(raw: unknown): raw is string {
	if (typeof raw !== "string") return false;
	try {
		return _reflectApply(_regexpTest, _identityPattern, [raw]);
	} catch {
		return false;
	}
}

function _captureIdentity(raw: unknown): HostedRlmRuntimeIdentity | null {
	if (typeof raw !== "object" || raw === null) return null;
	let names: string[];
	let symbols: symbol[];
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		if (_typesIsProxy(raw) || _protoOf(raw) !== _objectProto) return null;
		names = _ownPropertyNames(raw);
		symbols = _ownSymbols(raw);
		descriptors = _getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
	if (names.length !== 4 || symbols.length !== 0) return null;
	for (let index = 0; index < names.length; index++) {
		const name = names[index];
		if (name !== "childId" && name !== "sessionId" && name !== "sessionName" && name !== "modelSelector") {
			return null;
		}
	}
	const childIdDescriptor = descriptors.childId;
	const sessionIdDescriptor = descriptors.sessionId;
	const sessionNameDescriptor = descriptors.sessionName;
	const modelSelectorDescriptor = descriptors.modelSelector;
	if (
		childIdDescriptor === undefined ||
		!("value" in childIdDescriptor) ||
		!childIdDescriptor.enumerable ||
		sessionIdDescriptor === undefined ||
		!("value" in sessionIdDescriptor) ||
		!sessionIdDescriptor.enumerable ||
		sessionNameDescriptor === undefined ||
		!("value" in sessionNameDescriptor) ||
		!sessionNameDescriptor.enumerable ||
		modelSelectorDescriptor === undefined ||
		!("value" in modelSelectorDescriptor) ||
		!modelSelectorDescriptor.enumerable
	) {
		return null;
	}
	const childId = childIdDescriptor.value;
	const sessionId = sessionIdDescriptor.value;
	const sessionName = sessionNameDescriptor.value;
	const modelSelector = modelSelectorDescriptor.value;
	if (
		!_validIdentityPart(childId) ||
		!_validIdentityPart(sessionId) ||
		!_validIdentityPart(sessionName) ||
		!_validIdentityPart(modelSelector)
	) {
		return null;
	}
	return _freeze({ childId, sessionId, sessionName, modelSelector });
}

// ---------- origin capture at construction ----------

interface _CapturedOrigin {
	readonly submit: CallableFunction;
	readonly cancel: CallableFunction;
	readonly awaitDelivery: CallableFunction;
	readonly awaitReply: CallableFunction;
}

function _captureOrigin(raw: unknown): _CapturedOrigin | null {
	var record: Record<string, unknown> | null = _validateExactRecord(raw, _ORIGIN_KEYS);
	if (record === null) {
		return null;
	}

	if (
		!_isCallable(record.submit) ||
		!_isCallable(record.cancel) ||
		!_isCallable(record.pollDelivery) ||
		!_isCallable(record.pollReply) ||
		!_isCallable(record.awaitDelivery) ||
		!_isCallable(record.awaitReply)
	) {
		return null;
	}
	return {
		submit: record.submit,
		cancel: record.cancel,
		awaitDelivery: record.awaitDelivery,
		awaitReply: record.awaitReply,
	};
}

// ---------- router capture at construction ----------

interface _CapturedRouter {
	readonly registerLifecycleChild: CallableFunction;
}

function _captureRouter(raw: unknown): _CapturedRouter | null {
	const record = _validateExactRecord(raw, _ROUTER_KEYS);
	if (record === null) return null;
	if (
		!_isCallable(record.dispatchApplication) ||
		!_isCallable(record.close) ||
		!_isCallable(record.registerLifecycleChild)
	) {
		return null;
	}
	return { registerLifecycleChild: record.registerLifecycleChild };
}

// ---------- result validation helpers ----------

function _parseSubmitResult(raw: unknown): { code: string; ticket?: unknown } | null {
	const simple = _validateExactRecord(raw, _CODE_KEYS);
	if (simple !== null) {
		if (typeof simple.code !== "string") return null;
		return { code: simple.code };
	}
	const submitted = _validateExactRecord(raw, _SUBMIT_KEYS);
	if (submitted === null || submitted.code !== "SUBMITTED") return null;
	const ticket = submitted.ticket;
	if (typeof ticket !== "object" || ticket === null) return null;
	try {
		if (_typesIsProxy(ticket)) return null;
	} catch {
		return null;
	}
	return { code: "SUBMITTED", ticket };
}

function _parseSingleCode(raw: unknown): string | null {
	const record = _validateExactRecord(raw, _CODE_KEYS);
	if (record === null || typeof record.code !== "string") return null;
	return record.code;
}

function _parseDeliveryResult(raw: unknown): { code: string } | null {
	const code = _parseSingleCode(raw);
	if (code !== "CONFIRMED" && code !== "POISONED" && code !== "CLOSED") return null;
	return { code };
}

function _parseCancelResult(raw: unknown): { code: string } | null {
	const code = _parseSingleCode(raw);
	if (code === null) return null;
	return { code };
}

function _zeroOwnedReplyPayload(raw: unknown): void {
	if (typeof raw !== "object" || raw === null) return;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		if (_typesIsProxy(raw)) return;
		descriptors = _getOwnPropertyDescriptors(raw);
	} catch {
		return;
	}
	const payloadDescriptor = descriptors.payload;
	if (payloadDescriptor === undefined || !("value" in payloadDescriptor)) return;
	const payload = payloadDescriptor.value;
	if (!_isExactUint8Array(payload)) return;
	_zeroBytes(payload);
}

function _parseReplyResult(raw: unknown): { code: string; payload?: unknown } | null {
	const simple = _validateExactRecord(raw, _CODE_KEYS);
	if (simple !== null) {
		if (typeof simple.code !== "string") return null;
		return { code: simple.code };
	}
	const ready = _validateExactRecord(raw, _REPLY_KEYS);
	if (ready === null || ready.code !== "REPLY_READY") return null;
	return { code: "REPLY_READY", payload: ready.payload };
}

interface _CapturedRegistration {
	readonly receiver: object;
	readonly unregister: CallableFunction;
}

function _parseRegistrationResult(raw: unknown): _CapturedRegistration | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = _validateExactRecord(raw, _REGISTRATION_KEYS);
	if (record === null || !_isCallable(record.unregister)) return null;
	return { receiver: raw, unregister: record.unregister };
}

function _captureUnregisterForCleanup(raw: unknown): _CapturedRegistration | null {
	if (typeof raw !== "object" || raw === null) return null;
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		if (_typesIsProxy(raw)) return null;
		descriptors = _getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
	const descriptor = descriptors.unregister;
	if (descriptor === undefined || !("value" in descriptor) || !_isCallable(descriptor.value)) return null;
	return { receiver: raw, unregister: descriptor.value };
}

// ---------- native Promise brand check (exact) ----------

function _isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (_typesIsProxy(raw)) return false;
		if (_protoOf(raw) !== _nativePromiseProto) return false;
		if (!_isExtensible(raw)) return false;
		if (_ownPropertyNames(raw).length !== 0) return false;
		if (_ownSymbols(raw).length !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

// ---------- state per child ----------

interface _TicketRecord {
	readonly ticket: unknown;
	settled: boolean;
	cancelOnce: boolean;
	uncertainCancel: boolean;
	deliveryActual: Promise<unknown> | null;
	deliveryObserver: unknown | null;
	replyActual: Promise<unknown> | null;
	replyObserver: unknown | null;
}

interface _ChildState {
	started: boolean;
	closed: boolean;
	closing: boolean;
	closedSettleDone: boolean;
	closeRejected: boolean;
	closeActual: Promise<unknown> | null;
	closeObserver: unknown | null;
	unregister: _CapturedRegistration | null;
	terminalDeferred: _Deferred<HostedRlmTaskResult> | null;
	terminalResult: HostedRlmTaskResult | null;
	terminalSettled: boolean;
	currentListener: ((event: HostedRlmRuntimeEvent) => void) | null;
	subscribed: boolean;
	activeTickets: _TicketRecord[];
}

function _makeState(): _ChildState {
	return {
		started: false,
		closed: false,
		closing: false,
		closedSettleDone: false,
		closeRejected: false,
		closeActual: null,
		closeObserver: null,
		unregister: null,
		terminalDeferred: null,
		terminalResult: null,
		terminalSettled: false,
		currentListener: null,
		subscribed: false,
		activeTickets: [],
	};
}

// ---------- clear retained promises after their reactions return ----------

function _runClearLater(clear: () => void): boolean {
	try {
		_queueMicrotask(clear);
		return true;
	} catch {
		return false;
	}
}

function _clearRecordLater(records: _TicketRecord[], record: _TicketRecord): boolean {
	const clear = (): void => {
		record.deliveryActual = null;
		record.deliveryObserver = null;
		record.replyActual = null;
		record.replyObserver = null;
		for (let index = 0; index < records.length; index++) {
			if (records[index] !== record) continue;
			_reflectApply(_arraySplice, records, [index, 1]);
			return;
		}
	};
	return _runClearLater(clear);
}

function _clearCloseLater(st: _ChildState): void {
	const clear = (): void => {
		st.closeActual = null;
		st.closeObserver = null;
	};
	_runClearLater(clear);
}

// ---------- CLOSE cancellation sentinel ----------

const _CANCELLED_TERMINAL: HostedRlmTaskResult = _freeze({
	status: "cancelled",
	durationMs: 0,
	parentReplyCount: 0,
	toolUseCount: 0,
	errorCode: "CANCELLED",
});

// ---------- guarded ticket cancel ----------

function _cancelOnce(record: _TicketRecord, cancelFn: CallableFunction, receiver: unknown): boolean {
	if (record.cancelOnce) return record.uncertainCancel;
	record.cancelOnce = true;
	var raw: unknown;
	try {
		raw = _reflectApply(cancelFn, receiver, [record.ticket]);
	} catch {
		record.uncertainCancel = true;
		return record.uncertainCancel;
	}
	var parsed: { code: string } | null = _parseCancelResult(raw);
	if (parsed === null) {
		record.uncertainCancel = true;
		return record.uncertainCancel;
	}
	if (parsed.code !== "PENDING" && parsed.code !== "CANCELLED") {
		record.uncertainCancel = true;
	}
	return record.uncertainCancel;
}

// ---------- public factory ----------

export interface HostedSandboxChildPortInput {
	readonly identity: HostedRlmRuntimeIdentity;
	readonly lifecycleOrigin: OriginSubmit;
	readonly router: HomeStreamRouter;
	readonly controllerDispatcher?: unknown;
}

export function createHostedSandboxChildPort(input: HostedSandboxChildPortInput): HostedRlmRuntimePortFactoryResult {
	const identity = _captureIdentity(input.identity);
	if (identity === null) return _freeze({ ok: false, code: "INVALID_INPUT" });
	var rawOrigin: OriginSubmit = input.lifecycleOrigin;
	var rawRouter: HomeStreamRouter = input.router;
	var controllerDispatcher: unknown = input.controllerDispatcher;
	var st: _ChildState = _makeState();

	// ---------- capture origin and router at construction ----------

	var capturedOrigin: _CapturedOrigin | null = _captureOrigin(rawOrigin);
	if (capturedOrigin === null) {
		return _freeze({ ok: false, code: "INVALID_INPUT" });
	}
	var origin: _CapturedOrigin = capturedOrigin;

	var capturedRouter: _CapturedRouter | null = _captureRouter(rawRouter);
	if (capturedRouter === null) {
		return _freeze({ ok: false, code: "INVALID_INPUT" });
	}
	var routerCtx: _CapturedRouter = capturedRouter;

	// ---------- bounded active RPC accounting ----------

	function _activeTicketCount(): number {
		let count = 0;
		for (let index = 0; index < st.activeTickets.length; index++) {
			const record = st.activeTickets[index];
			if (!record.settled && !record.cancelOnce) count += 1;
		}
		return count;
	}

	// ---------- submit lifecycle record helper ----------
	//
	// Sequential V31 RPC: submit, awaitDelivery, awaitReply.
	// Never calls awaitReply before exact CONFIRMED.

	function _submitLifecycle(op: string, body: Record<string, unknown>): Promise<unknown> {
		var encodedResult = encodeLifecycleRecord({
			v: 1,
			identity: identity,
			op: op,
			body: body,
		});
		if (!encodedResult.ok) return _resolved<unknown>(undefined);

		var encodedBytes: Uint8Array = encodedResult.bytes;

		if (op !== "CLOSE" && (st.closed || st.closing)) {
			_zeroBytes(encodedBytes);
			return _rejected();
		}

		// Cap active tickets at 32
		if (_activeTicketCount() >= _maxActivePerChild) {
			_zeroBytes(encodedBytes);
			return _resolved<unknown>(undefined);
		}

		var submitResult: unknown;
		try {
			submitResult = _reflectApply(origin.submit, rawOrigin, [encodedBytes]);
		} finally {
			_zeroBytes(encodedBytes);
		}

		var parsedSubmit: { code: string; ticket?: unknown } | null = _parseSubmitResult(submitResult);
		if (parsedSubmit === null) return _resolved<unknown>(undefined);
		if (parsedSubmit.code === "CLOSED") return _rejected();
		if (parsedSubmit.code !== "SUBMITTED") return _resolved<unknown>(undefined);
		var ticket: unknown = parsedSubmit.ticket;
		if (ticket === undefined) return _resolved<unknown>(undefined);

		const record: _TicketRecord = {
			ticket,
			settled: false,
			cancelOnce: false,
			uncertainCancel: false,
			deliveryActual: null,
			deliveryObserver: null,
			replyActual: null,
			replyObserver: null,
		};
		_reflectApply(_arrayPush, st.activeTickets, [record]);

		var deferred: _Deferred<unknown> = _defer<unknown>();
		var settleGuard: boolean = false;

		function _recordSettle(value: unknown, retain: boolean = false): void {
			if (settleGuard) return;
			settleGuard = true;
			record.settled = true;
			deferred.resolve(value);
			if (!retain && !_clearRecordLater(st.activeTickets, record)) st.closing = true;
		}

		// Phase 1: awaitDelivery -- guard supplier call
		let deliveryRaw: unknown;
		try {
			deliveryRaw = _reflectApply(origin.awaitDelivery, rawOrigin, [ticket]);
		} catch {
			_cancelOnce(record, origin.cancel, rawOrigin);
			_recordSettle(undefined);
			return deferred.promise;
		}
		if (!_isNativePromise(deliveryRaw)) {
			_cancelOnce(record, origin.cancel, rawOrigin);
			_recordSettle(undefined);
			return deferred.promise;
		}
		const deliveryActual: Promise<unknown> = deliveryRaw;
		record.deliveryActual = deliveryActual;

		const deliveryFulfilled = (value: unknown): void => {
			if (settleGuard) return;
			var parsedDelivery: { code: string } | null = _parseDeliveryResult(value);
			if (parsedDelivery === null) {
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined);
				return;
			}
			if (parsedDelivery.code !== "CONFIRMED") {
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined);
				return;
			}

			// Phase 2: awaitReply -- only after exact CONFIRMED
			let replyRaw: unknown;
			try {
				replyRaw = _reflectApply(origin.awaitReply, rawOrigin, [ticket]);
			} catch {
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined);
				return;
			}
			if (!_isNativePromise(replyRaw)) {
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined);
				return;
			}
			const replyActual: Promise<unknown> = replyRaw;
			record.replyActual = replyActual;

			const replyFulfilled = (replyValue: unknown): void => {
				if (settleGuard) {
					_zeroOwnedReplyPayload(replyValue);
					return;
				}
				const parsedReply = _parseReplyResult(replyValue);
				if (parsedReply === null) {
					_zeroOwnedReplyPayload(replyValue);
					_cancelOnce(record, origin.cancel, rawOrigin);
					_recordSettle(undefined);
					return;
				}
				if (parsedReply.code === "REPLY_READY") {
					const payload = parsedReply.payload;
					if (!_isExactUint8Array(payload)) {
						_cancelOnce(record, origin.cancel, rawOrigin);
						_recordSettle(undefined);
						return;
					}
					let validated: Uint8Array | null = null;
					try {
						const copyResult = copySandboxStrictBytes(payload, 262144);
						if (copyResult.ok) validated = copyResult.value;
					} catch {
						validated = null;
					} finally {
						_zeroBytes(payload);
					}
					if (validated === null) {
						_cancelOnce(record, origin.cancel, rawOrigin);
						_recordSettle(undefined);
						return;
					}
					let decodeOk = false;
					let decoded: unknown;
					try {
						const decodeResult = decodeLifecycleReply(validated, op);
						if (decodeResult.ok) {
							decodeOk = true;
							decoded = decodeResult.body;
						}
					} catch {
						decodeOk = false;
					} finally {
						_zeroBytes(validated);
					}
					if (decodeOk) {
						_recordSettle(decoded);
						return;
					}
					_cancelOnce(record, origin.cancel, rawOrigin);
					_recordSettle(undefined);
					return;
				}
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined);
			};

			var replyRejected = (): void => {
				if (settleGuard) return;
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined);
			};

			var replyObserver: unknown;
			try {
				replyObserver = _reflectApply(_promiseThen, replyActual, [replyFulfilled, replyRejected]);
				record.replyObserver = replyObserver;
			} catch {
				st.closing = true;
				_cancelOnce(record, origin.cancel, rawOrigin);
				_recordSettle(undefined, true);
			}
		};

		var deliveryRejected = (): void => {
			if (settleGuard) return;
			_cancelOnce(record, origin.cancel, rawOrigin);
			_recordSettle(undefined);
		};

		var deliveryObserver: unknown;
		try {
			deliveryObserver = _reflectApply(_promiseThen, deliveryActual, [deliveryFulfilled, deliveryRejected]);
			record.deliveryObserver = deliveryObserver;
		} catch {
			st.closing = true;
			_cancelOnce(record, origin.cancel, rawOrigin);
			_recordSettle(undefined, true);
		}

		return deferred.promise;
	}

	// ---------- terminal settle ----------

	function _terminalSettle(result: HostedRlmTaskResult): void {
		if (st.terminalSettled) return;
		st.terminalSettled = true;
		st.terminalResult = result;
		var resolve: (value: HostedRlmTaskResult) => void;
		if (st.terminalDeferred !== null) {
			resolve = st.terminalDeferred.resolve;
			st.terminalDeferred = null;
			resolve(result);
		}
	}

	// ---------- port methods ----------

	function startInitialTask(input: { prompt: string; spawnCode?: string }): Promise<unknown> {
		if (st.closed || st.closing) return _rejected();
		if (st.started) return _resolved<unknown>(undefined);
		st.started = true;
		var body: Record<string, unknown> = {};
		body.prompt = input.prompt;
		if (input.spawnCode !== undefined) {
			body.spawnCode = input.spawnCode;
		}
		return _submitLifecycle("START", body);
	}

	function awaitTerminal(): Promise<unknown> {
		if (st.closed) return _rejected();
		if (!st.started) return _resolved<unknown>(undefined);
		if (st.terminalSettled && st.terminalResult !== null) return _resolved<unknown>(st.terminalResult);
		if (st.terminalDeferred === null) st.terminalDeferred = _defer<HostedRlmTaskResult>();
		return st.terminalDeferred.promise;
	}

	function abort(): Promise<unknown> {
		if (st.closed || st.closing) return _rejected();
		var body: Record<string, unknown> = {};
		return _submitLifecycle("ABORT", body);
	}

	function observe(): Promise<unknown> {
		if (st.closed || st.closing) return _rejected();
		var body: Record<string, unknown> = {};
		return _submitLifecycle("OBSERVE", body);
	}

	function subscribe(listener: (event: HostedRlmRuntimeEvent) => void): unknown {
		if (st.closed || st.closing) {
			return _freeze({ ok: false, error: _freeze({ code: "POISONED" }) });
		}
		if (typeof listener !== "function") {
			return _freeze({ ok: false, error: _freeze({ code: "INVALID_ARGUMENT" }) });
		}
		if (st.subscribed) {
			return _freeze({ ok: false, error: _freeze({ code: "SUBSCRIBE_UNCERTAIN" }) });
		}
		st.subscribed = true;
		st.currentListener = listener;
		var publicUnsubscribe = (): unknown => {
			if (st.currentListener === null) {
				return _freeze({ status: "unsubscribed" });
			}
			st.currentListener = null;
			st.subscribed = false;
			return _freeze({ status: "unsubscribed" });
		};
		return _freeze({ unsubscribe: publicUnsubscribe });
	}

	function close(): Promise<unknown> {
		if (st.closedSettleDone) {
			if (st.closeRejected) return _rejected();
			return _resolved<unknown>(undefined);
		}

		var deferred: _Deferred<unknown> = _defer<unknown>();
		st.closed = true;
		st.closing = true;

		// Cancel every unsettled prior ticket exactly once.
		let cancelUncertain = false;
		let resolveTerminal: (value: HostedRlmTaskResult) => void;
		for (let index = 0; index < st.activeTickets.length; index++) {
			const record = st.activeTickets[index];
			if (record.settled || record.cancelOnce) continue;
			if (_cancelOnce(record, origin.cancel, rawOrigin)) cancelUncertain = true;
		}

		// Settle a pending terminal wait.
		if (st.terminalDeferred !== null) {
			resolveTerminal = st.terminalDeferred.resolve;
			st.terminalDeferred = null;
			if (!st.terminalSettled) {
				st.terminalSettled = true;
				resolveTerminal(_CANCELLED_TERMINAL);
			}
		}

		// Guarded unregister; never skips CLOSE.
		let unregisterUncertain = false;
		if (st.unregister !== null) {
			const registration = st.unregister;
			try {
				_reflectApply(registration.unregister, registration.receiver, []);
			} catch {
				unregisterUncertain = true;
			}
			st.unregister = null;
		}

		// Submit CLOSE -- genuine remote CLOSE sequentially after unregister.
		var body: Record<string, unknown> = {};
		var closeResult: Promise<unknown> = _submitLifecycle("CLOSE", body);
		st.closeActual = closeResult;

		var closedSettled: boolean = false;

		var fulfilled = (value: unknown): void => {
			if (closedSettled) return;
			closedSettled = true;
			st.closedSettleDone = true;
			st.closing = false;
			st.closeRejected = cancelUncertain || unregisterUncertain;
			if (cancelUncertain || unregisterUncertain) {
				deferred.resolve(undefined);
				_clearCloseLater(st);
				return;
			}
			deferred.resolve(value);
			_clearCloseLater(st);
		};

		var rejected = (): void => {
			if (closedSettled) return;
			closedSettled = true;
			st.closedSettleDone = true;
			st.closing = false;
			st.closeRejected = true;
			deferred.resolve(undefined);
			_clearCloseLater(st);
		};

		try {
			st.closeObserver = _reflectApply(_promiseThen, closeResult, [fulfilled, rejected]);
		} catch {
			if (closedSettled) return deferred.promise;
			closedSettled = true;
			st.closedSettleDone = true;
			st.closing = false;
			st.closeRejected = true;
			deferred.resolve(undefined);
		}

		return deferred.promise;
	}

	// ---------- register with router ----------

	const settle: HostedRlmLifecycleSettle = _freeze({
		listener: (event: HostedRlmRuntimeEvent): void => {
			if (st.closed) return;
			if (st.currentListener !== null) st.currentListener(event);
		},
		terminalSettle: _terminalSettle,
	});

	var registerArg: unknown = controllerDispatcher !== undefined ? controllerDispatcher : undefined;
	var registerResult: unknown;
	try {
		registerResult = _reflectApply(routerCtx.registerLifecycleChild, rawRouter, [identity, settle, registerArg]);
	} catch {
		st.closed = true;
		st.closing = false;
		st.closedSettleDone = true;
		return _freeze({ ok: false, code: "INVALID_INPUT" });
	}

	const parsedReg = _parseRegistrationResult(registerResult);
	if (parsedReg === null) {
		const cleanup = _captureUnregisterForCleanup(registerResult);
		if (cleanup !== null) {
			try {
				_reflectApply(cleanup.unregister, cleanup.receiver, []);
			} catch {
				st.closeRejected = true;
			}
		}
		st.closed = true;
		st.closing = false;
		st.closedSettleDone = true;
		return _freeze({ ok: false, code: "INVALID_INPUT" });
	}

	st.unregister = parsedReg;

	var rawPort: unknown = _freeze({
		identity: identity,
		startInitialTask: startInitialTask,
		awaitTerminal: awaitTerminal,
		abort: abort,
		observe: observe,
		subscribe: subscribe,
		close: close,
	});

	return createHostedRlmRuntimePort(rawPort);
}
