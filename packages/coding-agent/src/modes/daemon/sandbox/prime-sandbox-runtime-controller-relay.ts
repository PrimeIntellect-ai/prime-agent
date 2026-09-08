// Runtime Controller Relay V1 — Runtime-side V31 streaming relay for V16
// controller invocation.  Minimal adapter factory that translates V16
// invoke(method, body, signal) into OriginSubmit submit + awaitDelivery +
// awaitReply over a shared V31 mux.  Returns an exact `{invoke}` adapter
// acceptable to createControllerInvocationAuthorityManager.createSession.

import { types } from "node:util";
import { encodeControllerRouteEnvelope } from "./prime-sandbox-controller-route-envelope.js";
import { decodeReply, type V16ReplyDecodeResult, type V16WireIdentity } from "./prime-sandbox-v16-reply-codec.js";
import { encodeRequest, type V16EncodeResult } from "./prime-sandbox-v16-request-codec.js";
import type { DeliveryResult, ReplyResult } from "./prime-sandbox-v31-multiplexer.js";
import { isExactAbortSignal } from "./prime-sandbox-validation.js";

const _freeze = Object.freeze;
const _getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _getOwnPropertyNames = Object.getOwnPropertyNames;
const _isExtensible = Object.isExtensible;
const _keys = Object.keys;
const _isSafeInteger = Number.isSafeInteger;
const _isNaN = Number.isNaN;
const _Promise = Promise;
const _promisePrototype = Promise.prototype;
const _promiseThen = Promise.prototype.then;
const _ReflectApply = Reflect.apply;
const _addEventListener = AbortSignal.prototype.addEventListener;
const _removeEventListener = AbortSignal.prototype.removeEventListener;
const _isProxy = types.isProxy;
const _isPromise = types.isPromise;
const _objectPrototype = Object.prototype;
const _uint8ArrayPrototype = Uint8Array.prototype;
const _queueMicrotask = queueMicrotask;

let _signalAbortedGet: ((this: AbortSignal) => boolean) | undefined;
try {
	const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(AbortSignal.prototype, "aborted");
	if (desc !== undefined && typeof desc.get === "function") {
		_signalAbortedGet = desc.get;
	}
} catch {
	_signalAbortedGet = undefined;
}

interface RelaySentinel {
	readonly ok: false;
	readonly code: "RELAY_FAILURE";
}
const RELAY_FAILURE: RelaySentinel = _freeze({ ok: false, code: "RELAY_FAILURE" });

interface HostedRouteIdentity {
	readonly childId: string;
	readonly sessionId: string;
	readonly sessionName: string;
	readonly modelSelector: string;
}

interface CapturedOrigin {
	readonly receiver: object;
	readonly submit: CallableFunction;
	readonly cancel: CallableFunction;
	readonly awaitDelivery: CallableFunction;
	readonly awaitReply: CallableFunction;
}

interface PrimeSandboxRuntimeControllerRelay {
	readonly invoke: (method: string, body: unknown, signal: AbortSignal) => Promise<unknown>;
}

interface CreateRelaySuccess {
	readonly ok: true;
	readonly adapter: PrimeSandboxRuntimeControllerRelay;
}
interface CreateRelayFailure {
	readonly ok: false;
	readonly code: "INPUT_INVALID" | "IDENTITY_MISMATCH";
}
type CreateRelayResult = CreateRelaySuccess | CreateRelayFailure;

function isRecord(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

function safeIsProxy(value: object): boolean {
	try {
		return _isProxy(value);
	} catch {
		return true;
	}
}

interface DescriptorTable {
	readonly names: ReadonlyArray<string>;
	readonly table: Record<string, PropertyDescriptor>;
}

function captureDescriptors(value: object): DescriptorTable | undefined {
	if (safeIsProxy(value)) return undefined;
	let proto: object | null;
	try {
		proto = _getPrototypeOf(value);
	} catch {
		return undefined;
	}
	if (proto !== _objectPrototype) return undefined;
	let symbols: ReadonlyArray<symbol>;
	try {
		symbols = _getOwnPropertySymbols(value);
	} catch {
		return undefined;
	}
	if (symbols.length !== 0) return undefined;
	let table: Record<string, PropertyDescriptor>;
	try {
		table = _getOwnPropertyDescriptors(value);
	} catch {
		return undefined;
	}
	const names: ReadonlyArray<string> = _keys(table);
	for (let index: number = 0; index < names.length; index++) {
		const descriptor: PropertyDescriptor | undefined = table[names[index]];
		if (descriptor === undefined) return undefined;
		if (!("value" in descriptor)) return undefined;
		if (descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
		if (!descriptor.enumerable) return undefined;
	}
	return { names: names, table: table };
}

function captureExactKeySet(
	value: object,
	expected: ReadonlyArray<string>,
): Record<string, PropertyDescriptor> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	for (let index: number = 0; index < ct.names.length; index++) {
		const name: string = ct.names[index];
		let found: boolean = false;
		for (let ei: number = 0; ei < expected.length; ei++) {
			if (name === expected[ei]) {
				found = true;
				break;
			}
		}
		if (!found) return undefined;
	}
	return ct.table;
}

function captureExactKeysOrdered(
	value: object,
	expected: ReadonlyArray<string>,
): Record<string, PropertyDescriptor> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	for (let index: number = 0; index < expected.length; index++) {
		if (ct.names[index] !== expected[index]) return undefined;
	}
	return ct.table;
}

function captureCallable(table: Record<string, PropertyDescriptor>, name: string): CallableFunction | undefined {
	const descriptor: PropertyDescriptor | undefined = table[name];
	if (descriptor === undefined) return undefined;
	const value: unknown = descriptor.value;
	if (typeof value !== "function") return undefined;
	try {
		if (_isProxy(value)) return undefined;
	} catch {
		return undefined;
	}
	return value;
}

function isRouteIdPattern(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 1 || value.length > 128) return false;
	for (let index: number = 0; index < value.length; index++) {
		const cc: number = value.charCodeAt(index);
		const ok: boolean =
			(cc >= 65 && cc <= 90) ||
			(cc >= 97 && cc <= 122) ||
			(cc >= 48 && cc <= 57) ||
			cc === 95 ||
			cc === 46 ||
			cc === 47 ||
			cc === 58 ||
			cc === 45;
		if (!ok) return false;
	}
	return true;
}

function isBoundedIdentifier(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length < 1 || value.length > 128) return false;
	for (let index: number = 0; index < value.length; index++) {
		const code: number = value.charCodeAt(index);
		const letter: boolean = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
		const digit: boolean = code >= 48 && code <= 57;
		if (index === 0) {
			if (!letter && !digit) return false;
		} else if (!letter && !digit && code !== 95 && code !== 45) {
			return false;
		}
	}
	return true;
}

function isExactNativePromise(value: unknown): value is Promise<unknown> {
	if (typeof value !== "object" || value === null) return false;
	if (safeIsProxy(value)) return false;
	if (!_isPromise(value)) return false;
	try {
		if (_getPrototypeOf(value) !== _promisePrototype) return false;
	} catch {
		return false;
	}
	try {
		const ownNames: string[] = _getOwnPropertyNames(value);
		if (ownNames.length !== 0) return false;
	} catch {
		return false;
	}
	try {
		const ownSymbols: symbol[] = _getOwnPropertySymbols(value);
		if (ownSymbols.length !== 0) return false;
	} catch {
		return false;
	}
	try {
		if (!_isExtensible(value)) return false;
	} catch {
		return false;
	}
	return true;
}

function _isStrictObjectWithExactKeys(
	raw: unknown,
	expected: ReadonlyArray<string>,
): Record<string, PropertyDescriptor> | undefined {
	if (!isRecord(raw)) return undefined;
	if (safeIsProxy(raw)) return undefined;
	try {
		const proto: object | null = _getPrototypeOf(raw);
		if (proto !== _objectPrototype) return undefined;
	} catch {
		return undefined;
	}
	try {
		const symbols: ReadonlyArray<symbol> = _getOwnPropertySymbols(raw);
		if (symbols.length !== 0) return undefined;
	} catch {
		return undefined;
	}
	try {
		const table: Record<string, PropertyDescriptor> = _getOwnPropertyDescriptors(raw);
		const names: ReadonlyArray<string> = _keys(table);
		if (names.length !== expected.length) return undefined;
		for (let i: number = 0; i < expected.length; i++) {
			const d: PropertyDescriptor | undefined = table[expected[i]];
			if (d === undefined) return undefined;
			if (!("value" in d)) return undefined;
			if (d.get !== undefined || d.set !== undefined) return undefined;
			if (!d.enumerable) return undefined;
		}
		return table;
	} catch {
		return undefined;
	}
}

function _parseSubmitTicket(raw: unknown): { code: string; ticket: object } | undefined {
	const table: Record<string, PropertyDescriptor> | undefined = _isStrictObjectWithExactKeys(raw, ["code", "ticket"]);
	if (table === undefined) return undefined;
	const cv: unknown = table.code.value;
	if (typeof cv !== "string") return undefined;
	const tv: unknown = table.ticket.value;
	if (typeof tv !== "object" || tv === null) return undefined;
	if (safeIsProxy(tv)) return undefined;
	return { code: cv, ticket: tv };
}

function _parseDeliveryCode(raw: unknown): string | undefined {
	const table: Record<string, PropertyDescriptor> | undefined = _isStrictObjectWithExactKeys(raw, ["code"]);
	if (table === undefined) return undefined;
	const cv: unknown = table.code.value;
	if (typeof cv !== "string") return undefined;
	return cv;
}

function _parseReplyReady(raw: unknown): { code: string; payload: Uint8Array } | undefined {
	const table: Record<string, PropertyDescriptor> | undefined = _isStrictObjectWithExactKeys(raw, ["code", "payload"]);
	if (table === undefined) return undefined;
	const cv: unknown = table.code.value;
	if (typeof cv !== "string") return undefined;
	const pv: unknown = table.payload.value;
	if (typeof pv !== "object" || pv === null) return undefined;
	if (safeIsProxy(pv)) return undefined;
	try {
		if (_getPrototypeOf(pv) !== _uint8ArrayPrototype) return undefined;
	} catch {
		return undefined;
	}
	const u8: Uint8Array | undefined = _isExactUint8Array(pv) ? pv : undefined;
	if (u8 === undefined) return undefined;
	return { code: cv, payload: u8 };
}

function _isExactUint8Array(value: unknown): value is Uint8Array {
	if (typeof value !== "object" || value === null) return false;
	if (safeIsProxy(value)) return false;
	try {
		return _getPrototypeOf(value) === _uint8ArrayPrototype;
	} catch {
		return false;
	}
}

function _extractPayload(raw: unknown): Uint8Array | undefined {
	if (!isRecord(raw)) return undefined;
	try {
		const desc: PropertyDescriptor | undefined = _getOwnPropertyDescriptor(raw, "payload");
		if (desc === undefined || !("value" in desc)) return undefined;
		const payload: unknown = desc.value;
		if (_isExactUint8Array(payload)) return payload;
		return undefined;
	} catch {
		return undefined;
	}
}

const ROUTE_IDENTITY_KEYS: ReadonlyArray<string> = _freeze(["childId", "sessionId", "sessionName", "modelSelector"]);
const CONTROLLER_IDENTITY_KEYS: ReadonlyArray<string> = _freeze([
	"activeSessionId",
	"sessionId",
	"rlmChildId",
	"depth",
	"sessionName",
]);
const ORIGIN_KEYS: ReadonlyArray<string> = _freeze([
	"submit",
	"cancel",
	"pollDelivery",
	"pollReply",
	"awaitDelivery",
	"awaitReply",
]);

function utf8ByteCount(value: string): number {
	let count: number = 0;
	const len: number = value.length;
	for (let i: number = 0; i < len; i++) {
		const cc: number = value.charCodeAt(i);
		if (cc <= 0x7f) {
			count += 1;
		} else if (cc <= 0x7ff) {
			count += 2;
		} else if (cc >= 0xd800 && cc <= 0xdbff) {
			if (i + 1 < len) {
				const next: number = value.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					count += 4;
					i += 1;
				} else {
					count += 3;
				}
			} else {
				count += 3;
			}
		} else if (cc >= 0xdc00 && cc <= 0xdfff) {
			count += 3;
		} else {
			count += 3;
		}
	}
	return count;
}

function validateRouteIdentity(raw: unknown): HostedRouteIdentity | undefined {
	if (!isRecord(raw)) return undefined;
	const ds: Record<string, PropertyDescriptor> | undefined = captureExactKeySet(raw, ROUTE_IDENTITY_KEYS);
	if (ds === undefined) return undefined;
	if (!isRouteIdPattern(ds.childId.value)) return undefined;
	if (!isRouteIdPattern(ds.sessionId.value)) return undefined;
	if (!isRouteIdPattern(ds.sessionName.value)) return undefined;
	if (!isRouteIdPattern(ds.modelSelector.value)) return undefined;
	return _freeze({
		childId: ds.childId.value,
		sessionId: ds.sessionId.value,
		sessionName: ds.sessionName.value,
		modelSelector: ds.modelSelector.value,
	});
}

function validateControllerIdentity(raw: unknown): V16WireIdentity | undefined {
	if (!isRecord(raw)) return undefined;
	const ds: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(raw, CONTROLLER_IDENTITY_KEYS);
	if (ds === undefined) return undefined;
	const asi: unknown = ds.activeSessionId.value;
	const si: unknown = ds.sessionId.value;
	const rlm: unknown = ds.rlmChildId.value;
	const depth: unknown = ds.depth.value;
	const sn: unknown = ds.sessionName.value;
	if (!isBoundedIdentifier(asi)) return undefined;
	if (!isBoundedIdentifier(si)) return undefined;
	if (!isBoundedIdentifier(rlm)) return undefined;
	if (typeof depth !== "number" || _isNaN(depth) || !_isSafeInteger(depth) || depth < 0 || depth > 255)
		return undefined;
	if (typeof sn !== "string" || utf8ByteCount(sn) > 256) return undefined;
	return _freeze({ activeSessionId: asi, sessionId: si, rlmChildId: rlm, depth: depth, sessionName: sn });
}

function captureOriginSubmit(raw: unknown): CapturedOrigin | undefined {
	if (!isRecord(raw)) return undefined;
	const ds: Record<string, PropertyDescriptor> | undefined = captureExactKeySet(raw, ORIGIN_KEYS);
	if (ds === undefined) return undefined;
	const submit = captureCallable(ds, "submit");
	const cancel = captureCallable(ds, "cancel");
	const awaitDelivery = captureCallable(ds, "awaitDelivery");
	const awaitReply = captureCallable(ds, "awaitReply");
	if (submit === undefined || cancel === undefined) return undefined;
	if (awaitDelivery === undefined || awaitReply === undefined) return undefined;
	return _freeze({
		receiver: raw,
		submit: submit,
		cancel: cancel,
		awaitDelivery: awaitDelivery,
		awaitReply: awaitReply,
	});
}

function isStream2Method(method: string): boolean {
	if (method === "list_agents") return true;
	if (method === "roster") return true;
	if (method === "await_pending") return true;
	if (method === "assert_name") return true;
	if (method === "set_name") return true;
	if (method === "send_message") return true;
	return false;
}
function isStream3Method(method: string): boolean {
	if (method === "observe_list") return true;
	if (method === "observe_get") return true;
	if (method === "observe_recent") return true;
	return false;
}

// safeCancelOnce returns true if cancel was actually called
function safeCancelOnce(capturedOrigin: CapturedOrigin, ticket: object | null, cancelDone: { done: boolean }): boolean {
	if (cancelDone.done) return false;
	cancelDone.done = true;
	if (ticket === null) return false;
	try {
		_ReflectApply(capturedOrigin.cancel, capturedOrigin.receiver, [ticket]);
		return true;
	} catch {
		return false;
	}
}

// safeRemoveListener returns true if listener was actually removed.
// Guards against double-removal via listenerState cell.
function safeRemoveListener(
	signal: AbortSignal,
	listener: (() => void) | undefined,
	listenerState: { installed: boolean; removed: boolean },
): boolean {
	if (listener === undefined) return false;
	if (!listenerState.installed || listenerState.removed) return false;
	listenerState.removed = true;
	try {
		_ReflectApply(_removeEventListener, signal, ["abort", listener]);
		return true;
	} catch {
		return false;
	}
}

function createPrimeSandboxRuntimeControllerRelay(
	routeIdentityRaw: unknown,
	controllerIdentityRaw: unknown,
	messagesToHomeRaw: unknown,
	observeRequestsToHomeRaw: unknown,
): CreateRelayResult {
	const routeIdentity: HostedRouteIdentity | undefined = validateRouteIdentity(routeIdentityRaw);
	if (routeIdentity === undefined) return _freeze({ ok: false, code: "INPUT_INVALID" });
	const controllerIdentity: V16WireIdentity | undefined = validateControllerIdentity(controllerIdentityRaw);
	if (controllerIdentity === undefined) return _freeze({ ok: false, code: "INPUT_INVALID" });
	if (routeIdentity.childId !== controllerIdentity.rlmChildId)
		return _freeze({ ok: false, code: "IDENTITY_MISMATCH" });
	if (routeIdentity.sessionId !== controllerIdentity.sessionId)
		return _freeze({ ok: false, code: "IDENTITY_MISMATCH" });
	if (routeIdentity.sessionName !== controllerIdentity.sessionName)
		return _freeze({ ok: false, code: "IDENTITY_MISMATCH" });

	const messagesToHome: CapturedOrigin | undefined = captureOriginSubmit(messagesToHomeRaw);
	if (messagesToHome === undefined) return _freeze({ ok: false, code: "INPUT_INVALID" });
	const observeRequestsToHome: CapturedOrigin | undefined = captureOriginSubmit(observeRequestsToHomeRaw);
	if (observeRequestsToHome === undefined) return _freeze({ ok: false, code: "INPUT_INVALID" });

	const _routeIdentity: HostedRouteIdentity = routeIdentity;
	const _controllerIdentity: V16WireIdentity = controllerIdentity;

	const _invoke: (method: string, body: unknown, signal: AbortSignal) => Promise<unknown> = (
		method: string,
		body: unknown,
		signal: AbortSignal,
	): Promise<unknown> => {
		if (!isExactAbortSignal(signal)) {
			return new _Promise(function executor(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			): void {
				reject(RELAY_FAILURE);
			});
		}
		if (typeof method !== "string") {
			return new _Promise(function executor(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			): void {
				reject(RELAY_FAILURE);
			});
		}
		const isStream2: boolean = isStream2Method(method);
		const isStream3: boolean = isStream3Method(method);
		if (!isStream2 && !isStream3) {
			return new _Promise(function executor(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			): void {
				reject(RELAY_FAILURE);
			});
		}
		const capturedOrigin: CapturedOrigin = isStream2 ? messagesToHome : observeRequestsToHome;

		// Check aborted before any effects
		if (_signalAbortedGet !== undefined) {
			let abortedBefore: boolean;
			try {
				abortedBefore = _ReflectApply(_signalAbortedGet, signal, []);
			} catch {
				return new _Promise(function executor(
					_resolve: (value: unknown) => void,
					reject: (reason: unknown) => void,
				): void {
					reject(RELAY_FAILURE);
				});
			}
			if (abortedBefore) {
				return new _Promise(function executor(
					_resolve: (value: unknown) => void,
					reject: (reason: unknown) => void,
				): void {
					reject(RELAY_FAILURE);
				});
			}
		}

		// Encode request
		const encResult: V16EncodeResult = encodeRequest({ method: method, body: body });
		if (!encResult.ok) {
			return new _Promise(function executor(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			): void {
				reject(RELAY_FAILURE);
			});
		}
		const encodedBytes: Uint8Array = encResult.bytes;

		const envelopeResult = encodeControllerRouteEnvelope(_routeIdentity, encodedBytes);
		if (!envelopeResult.ok) {
			for (let zi: number = 0; zi < encodedBytes.length; zi++) encodedBytes[zi] = 0;
			return new _Promise(function executor(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			): void {
				reject(RELAY_FAILURE);
			});
		}
		const envelopeBytes: Uint8Array = envelopeResult.bytes;

		// Submit — keep result as-opaque parse via descriptors
		let ticket: object | null = null;
		try {
			const submitResult: unknown = _ReflectApply(capturedOrigin.submit, capturedOrigin.receiver, [envelopeBytes]);
			for (let zi: number = 0; zi < encodedBytes.length; zi++) encodedBytes[zi] = 0;
			for (let zi: number = 0; zi < envelopeBytes.length; zi++) envelopeBytes[zi] = 0;

			const parsedSubmit: { code: string; ticket: object } | undefined = _parseSubmitTicket(submitResult);
			if (parsedSubmit === undefined || parsedSubmit.code !== "SUBMITTED") {
				return new _Promise(function executor(
					_resolve: (value: unknown) => void,
					reject: (reason: unknown) => void,
				): void {
					reject(RELAY_FAILURE);
				});
			}
			ticket = parsedSubmit.ticket;
		} catch {
			for (let zi: number = 0; zi < encodedBytes.length; zi++) encodedBytes[zi] = 0;
			for (let zi: number = 0; zi < envelopeBytes.length; zi++) envelopeBytes[zi] = 0;
			return new _Promise(function executor(
				_resolve: (value: unknown) => void,
				reject: (reason: unknown) => void,
			): void {
				reject(RELAY_FAILURE);
			});
		}

		// Submit succeeded. Build the operation promise.
		return new _Promise(function executor(
			resolve: (value: unknown) => void,
			reject: (reason: unknown) => void,
		): void {
			let settled: boolean = false;
			let abortListener: (() => void) | undefined;
			const listenerState: { installed: boolean; removed: boolean } = { installed: false, removed: false };
			const cancelDone: { done: boolean } = { done: false };
			const opRec: {
				deliveryStarted: boolean;
				replyStarted: boolean;
				deliveryDone: boolean;
				replyDone: boolean;
				deliveryOp: object | null;
				deliveryThen: object | null;
				replyOp: object | null;
				replyThen: object | null;
			} = {
				deliveryStarted: false,
				replyStarted: false,
				deliveryDone: false,
				replyDone: false,
				deliveryOp: null,
				deliveryThen: null,
				replyOp: null,
				replyThen: null,
			};

			function scheduleRecordClear(): void {
				_queueMicrotask(function clearRec(): void {
					if (!settled) return;
					const deliveryBranchDone: boolean = !opRec.deliveryStarted || opRec.deliveryDone;
					const replyBranchDone: boolean = !opRec.replyStarted || opRec.replyDone;
					if (deliveryBranchDone && replyBranchDone) {
						opRec.deliveryOp = null;
						opRec.deliveryThen = null;
						opRec.replyOp = null;
						opRec.replyThen = null;
					}
				});
			}

			function onAbort(): void {
				if (settled) return;
				settled = true;
				safeCancelOnce(capturedOrigin, ticket, cancelDone);
				safeRemoveListener(signal, abortListener, listenerState);
				reject(RELAY_FAILURE);
				scheduleRecordClear();
			}

			// Install abort listener
			abortListener = onAbort;
			try {
				_ReflectApply(_addEventListener, signal, ["abort", onAbort]);
				listenerState.installed = true;
			} catch {
				safeCancelOnce(capturedOrigin, ticket, cancelDone);
				settled = true;
				reject(RELAY_FAILURE);
				return;
			}

			// Re-read aborted state to close check/listen race
			let reReadAborted: boolean = false;
			if (_signalAbortedGet !== undefined) {
				try {
					reReadAborted = _ReflectApply(_signalAbortedGet, signal, []);
				} catch {
					reReadAborted = true;
				}
			}
			if (reReadAborted) {
				onAbort();
				return;
			}

			// Phase 1: await delivery
			try {
				opRec.deliveryOp = _ReflectApply(capturedOrigin.awaitDelivery, capturedOrigin.receiver, [ticket]);
				opRec.deliveryStarted = true;
			} catch {
				safeRemoveListener(signal, abortListener, listenerState);
				safeCancelOnce(capturedOrigin, ticket, cancelDone);
				settled = true;
				reject(RELAY_FAILURE);
				return;
			}

			if (!isExactNativePromise(opRec.deliveryOp)) {
				safeRemoveListener(signal, abortListener, listenerState);
				safeCancelOnce(capturedOrigin, ticket, cancelDone);
				settled = true;
				reject(RELAY_FAILURE);
				return;
			}

			function onDeliveryResult(deliveryResultRaw: DeliveryResult): void {
				opRec.deliveryDone = true;
				if (settled) {
					scheduleRecordClear();
					return;
				}

				const deliveryCode: string | undefined = _parseDeliveryCode(deliveryResultRaw);
				if (deliveryCode === undefined || deliveryCode !== "CONFIRMED") {
					safeRemoveListener(signal, abortListener, listenerState);
					safeCancelOnce(capturedOrigin, ticket, cancelDone);
					settled = true;
					reject(RELAY_FAILURE);
					scheduleRecordClear();
					return;
				}

				// Phase 2: awaitReply
				try {
					opRec.replyOp = _ReflectApply(capturedOrigin.awaitReply, capturedOrigin.receiver, [ticket]);
					opRec.replyStarted = true;
				} catch {
					safeRemoveListener(signal, abortListener, listenerState);
					safeCancelOnce(capturedOrigin, ticket, cancelDone);
					settled = true;
					reject(RELAY_FAILURE);
					scheduleRecordClear();
					return;
				}

				if (!isExactNativePromise(opRec.replyOp)) {
					safeRemoveListener(signal, abortListener, listenerState);
					safeCancelOnce(capturedOrigin, ticket, cancelDone);
					settled = true;
					reject(RELAY_FAILURE);
					scheduleRecordClear();
					return;
				}

				function onReplyResult(replyResultRaw: ReplyResult): void {
					opRec.replyDone = true;
					if (settled) {
						_attemptZeroReplyPayload(replyResultRaw);
						scheduleRecordClear();
						return;
					}
					safeRemoveListener(signal, abortListener, listenerState);

					const parsedReply: { code: string; payload: Uint8Array } | undefined = _parseReplyReady(replyResultRaw);
					if (parsedReply === undefined || parsedReply.code !== "REPLY_READY") {
						safeCancelOnce(capturedOrigin, ticket, cancelDone);
						settled = true;
						reject(RELAY_FAILURE);
						scheduleRecordClear();
						return;
					}

					const replyPayload: Uint8Array = parsedReply.payload;
					try {
						const decResult: V16ReplyDecodeResult = decodeReply(replyPayload, method, _controllerIdentity);
						if (decResult.ok) {
							settled = true;
							resolve(decResult.reply.body);
						} else {
							safeCancelOnce(capturedOrigin, ticket, cancelDone);
							settled = true;
							reject(RELAY_FAILURE);
						}
					} catch {
						safeCancelOnce(capturedOrigin, ticket, cancelDone);
						settled = true;
						reject(RELAY_FAILURE);
					} finally {
						for (let zi: number = 0; zi < replyPayload.length; zi++) replyPayload[zi] = 0;
					}
					scheduleRecordClear();
				}

				function onReplyReject(): void {
					opRec.replyDone = true;
					if (settled) {
						scheduleRecordClear();
						return;
					}
					safeRemoveListener(signal, abortListener, listenerState);
					safeCancelOnce(capturedOrigin, ticket, cancelDone);
					settled = true;
					reject(RELAY_FAILURE);
					scheduleRecordClear();
				}

				try {
					opRec.replyThen = _ReflectApply(_promiseThen, opRec.replyOp, [onReplyResult, onReplyReject]);
				} catch {
					safeRemoveListener(signal, abortListener, listenerState);
					safeCancelOnce(capturedOrigin, ticket, cancelDone);
					settled = true;
					reject(RELAY_FAILURE);
					scheduleRecordClear();
					return;
				}
			}

			function onDeliveryReject(): void {
				opRec.deliveryDone = true;
				if (settled) {
					scheduleRecordClear();
					return;
				}
				safeRemoveListener(signal, abortListener, listenerState);

				safeCancelOnce(capturedOrigin, ticket, cancelDone);
				settled = true;
				reject(RELAY_FAILURE);
				scheduleRecordClear();
			}

			try {
				opRec.deliveryThen = _ReflectApply(_promiseThen, opRec.deliveryOp, [onDeliveryResult, onDeliveryReject]);
			} catch {
				safeRemoveListener(signal, abortListener, listenerState);

				safeCancelOnce(capturedOrigin, ticket, cancelDone);
				settled = true;
				reject(RELAY_FAILURE);
				return;
			}
		});
	};

	const adapter: PrimeSandboxRuntimeControllerRelay = _freeze({ invoke: _invoke });
	return _freeze({ ok: true, adapter: adapter });
}

function _attemptZeroReplyPayload(raw: unknown): boolean {
	try {
		const payload: unknown = _extractPayload(raw);
		if (_isExactUint8Array(payload)) {
			for (let zi: number = 0; zi < payload.length; zi++) payload[zi] = 0;
			return true;
		}
		return false;
	} catch {
		return false;
	}
}

export type { CreateRelayFailure, CreateRelayResult, CreateRelaySuccess, PrimeSandboxRuntimeControllerRelay };
export { createPrimeSandboxRuntimeControllerRelay };
