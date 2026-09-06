// V16 Controller Invocation Proof — Authority Manager
//
// One public export: createControllerInvocationAuthorityManager.
// The authority manager owns a global-within-family WeakMap<object, ownerRecord>
// and a session registry. It creates isolated Controller session managers.
// No module-global mutable state. Every opaque capability registered with
// the exact issuing session. Cross-session cap use poisons the issuing session only.
// Unknown fabricated object poisons none.
//
// Each session manager: invoke(method, body) -> callClaim; cancel(callClaim);
// pollReply(callClaim) -> semantic reply body; pollDispatch() -> semantic bundle
// with method, body (V16RequestBody-only), AbortSignal. No public commit authority.
//
// Managed adapter tasks: Promise.race between provider promise and abort settlement.
// Tracked in _activeTasks Set; removed only on settlement in the task itself.
// Close/cleanup abort, await race tasks, then zero/revoke.
//
// Poison: aborts all AbortControllers via captured intrinsic, zeros reply bytes,
// settles call claims POISONED, revokes all cap->owner WeakMap entries,
// clears all per-session tracking sets.
// Bounded cleanup: all caps revoked, registry/cap counts prove zero.
//
// Brand is WeakMap membership — no public class, no static factory,
// no brand reader. Capabilities validated by WeakMap lookup.
//
// No public identity, bytes, frames, IDs, reply authority.
// Internal relay driver privately passes accepted codec bytes.
//
// Every adapter result calls encodeReply(method, rawOutput/fixed error, closure identity).
// No ad-hoc error property sniffing. METHOD_UNAVAILABLE rejected by codec on
// required methods falls back through second encodeReply with CONTROLLER_FAILURE.

import * as util from "node:util";
import {
	decodeReply,
	encodeReply,
	type V16ReplyDecodeResult,
	type V16ReplyEncodeResult,
	type V16WireIdentity,
} from "./prime-sandbox-v16-reply-codec.js";
import {
	decodeRequest,
	encodeRequest,
	type V16DecodeCorrelated,
	type V16EncodeResult,
	type V16EncodeSuccess,
	type V16Method,
	type V16RequestBody,
	type V16TypedRequest,
} from "./prime-sandbox-v16-request-codec.js";

// ---------- captured intrinsics (module-init, never rebound) ----------

const _getPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _getOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _getOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _getOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const _getOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _freeze: typeof Object.freeze = Object.freeze;
const _defineProperty: typeof Object.defineProperty = Object.defineProperty;
const _create: typeof Object.create = Object.create;
const _seal: typeof Object.seal = Object.seal;
const _isSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;
const _keys: typeof Object.keys = Object.keys;
const _Reflect_apply: typeof Reflect.apply = Reflect.apply;
const _abortPrototypeAbort: (this: AbortController, reason?: unknown) => void = AbortController.prototype.abort;
const _addEventListener: typeof AbortSignal.prototype.addEventListener = AbortSignal.prototype.addEventListener;
const _removeEventListener: typeof AbortSignal.prototype.removeEventListener =
	AbortSignal.prototype.removeEventListener;
const _setDelete: (set: Set<unknown>, value: unknown) => boolean = function _setDelete(
	set: Set<unknown>,
	value: unknown,
): boolean {
	return _Reflect_apply(Set.prototype.delete, set, [value]);
};
const _mapDelete: (map: Map<unknown, unknown>, key: unknown) => boolean = function _mapDelete(
	map: Map<unknown, unknown>,
	key: unknown,
): boolean {
	return _Reflect_apply(Map.prototype.delete, map, [key]);
};
const _weakMapDelete: (wm: WeakMap<object, unknown>, key: object) => boolean = function _weakMapDelete(
	wm: WeakMap<object, unknown>,
	key: object,
): boolean {
	return _Reflect_apply(WeakMap.prototype.delete, wm, [key]);
};

// ---------- abort sentinel (closure-private, never exposed) ----------

const _ABORT_OUTCOME: unique symbol = Symbol("abort");

// ---------- internal state type for per-session calls ----------

interface _CallState {
	readonly _method: string;
	_cancelled: boolean;
	_dispatched: boolean;
	_ac: AbortController | null;
	_replyBytes: null | Uint8Array;
	_replyReady: boolean;
	_poisoned: boolean;
	_adapterSettled: boolean;
}

// ---------- task record for managed async tasks ----------

interface _TaskRecord {
	readonly promise: Promise<void>;
	readonly callClaim: object;
	readonly method: string;
}

// ---------- session record (owned by authority manager) ----------

interface _SessionRecord {
	readonly _name: string;
	readonly _identity: V16WireIdentity;
	readonly _adapterInvoke: (method: string, body: V16RequestBody, signal: AbortSignal) => unknown;
	_poisoned: boolean;
	_closeSettlement: Promise<void> | null;
	_closeOperation: (() => Promise<CloseResult>) | null;
	_callLocalMap: WeakMap<object, _CallState>;
	_pendingDispatch: Array<{
		callClaim: object;
		method: string;
		body: V16TypedRequest;
		ac: AbortController;
	}>;
	_issuedCaps: Set<object>;
	_callRecords: Set<_CallState>;
	_activeAbortControllers: Set<AbortController>;
	_activeTasks: Set<_TaskRecord>;
}

// ---------- validation helpers ----------

function isRecord(value: unknown): value is object {
	if (typeof value !== "object") return false;
	if (value === null) return false;
	return true;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function safeIsProxy(value: object): boolean {
	try {
		return util.types.isProxy(value);
	} catch (_e: unknown) {
		return true;
	}
}

function safeGetPrototypeOf(value: object): object | null {
	try {
		return _getPrototypeOf(value);
	} catch (_e: unknown) {
		return null;
	}
}

function safeGetOwnPropertySymbols(value: object): ReadonlyArray<symbol> | undefined {
	try {
		return _getOwnPropertySymbols(value);
	} catch (_e: unknown) {
		return undefined;
	}
}

interface DescriptorTable {
	readonly names: ReadonlyArray<string>;
	readonly table: Record<string, PropertyDescriptor>;
}

function captureDescriptors(value: object): DescriptorTable | undefined {
	if (safeIsProxy(value)) return undefined;
	const proto: object | null = safeGetPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return undefined;
	if (proto === null) {
		if (Object.isFrozen(value)) {
			const ownNames: string[] = _getOwnPropertyNames(value);
			if (ownNames.length === 0) return _freeze({ names: _freeze([]), table: {} });
		}
	}
	let names: string[];
	try {
		names = _getOwnPropertyNames(value);
	} catch (_e: unknown) {
		return undefined;
	}
	const syms: ReadonlyArray<symbol> | undefined = safeGetOwnPropertySymbols(value);
	if (syms === undefined || syms.length !== 0) return undefined;
	const table: Record<string, PropertyDescriptor> = {};
	for (let i: number = 0; i < names.length; i++) {
		const k: string = names[i];
		let d: PropertyDescriptor | undefined;
		try {
			d = _getOwnPropertyDescriptor(value, k);
		} catch (_e: unknown) {
			return undefined;
		}
		if (d === undefined || d.get !== undefined || d.set !== undefined) return undefined;
		table[k] = d;
	}
	return { names: _freeze(names), table: table };
}

function captureExactKeysOrdered(
	value: object,
	expected: ReadonlyArray<string>,
): Record<string, PropertyDescriptor> | undefined {
	const ct: DescriptorTable | undefined = captureDescriptors(value);
	if (ct === undefined) return undefined;
	if (ct.names.length !== expected.length) return undefined;
	for (let i: number = 0; i < expected.length; i++) {
		if (ct.names[i] !== expected[i]) return undefined;
	}
	return ct.table;
}

function isV16Method(value: string): boolean {
	if (value === "list_agents") return true;
	if (value === "roster") return true;
	if (value === "await_pending") return true;
	if (value === "assert_name") return true;
	if (value === "set_name") return true;
	if (value === "send_message") return true;
	if (value === "observe_list") return true;
	if (value === "observe_get") return true;
	if (value === "observe_recent") return true;
	return false;
}

function isBoundedIdentifier(value: unknown): boolean {
	if (typeof value !== "string") return false;
	if (value.length < 1 || value.length > 128) return false;
	return true;
}

function validateDepth(value: unknown): value is number {
	if (typeof value !== "number") return false;
	if (!_isSafeInteger(value)) return false;
	if (value < 0 || value > 255) return false;
	return true;
}

function validateIdentity(raw: unknown): V16WireIdentity | undefined {
	if (!isRecord(raw)) return undefined;
	const expected: ReadonlyArray<string> = _freeze([
		"activeSessionId",
		"sessionId",
		"rlmChildId",
		"depth",
		"sessionName",
	]);
	const ds: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(raw, expected);
	if (ds === undefined) return undefined;
	const asiRaw: unknown = ds.activeSessionId.value;
	const siRaw: unknown = ds.sessionId.value;
	const rlmRaw: unknown = ds.rlmChildId.value;
	const dRaw: unknown = ds.depth.value;
	const snRaw: unknown = ds.sessionName.value;
	if (!isString(asiRaw)) return undefined;
	if (!isString(siRaw)) return undefined;
	if (!isString(rlmRaw)) return undefined;
	if (!isString(snRaw)) return undefined;
	if (!isBoundedIdentifier(asiRaw)) return undefined;
	if (!isBoundedIdentifier(siRaw)) return undefined;
	if (!isBoundedIdentifier(rlmRaw)) return undefined;
	if (!validateDepth(dRaw)) return undefined;
	return _freeze({
		activeSessionId: asiRaw,
		sessionId: siRaw,
		rlmChildId: rlmRaw,
		depth: dRaw,
		sessionName: snRaw,
	});
}

// ---------- Narrow helpers ----------

function unwrapEncodeSuccess(result: V16EncodeResult): V16EncodeSuccess | undefined {
	if (!result.ok) return undefined;
	return result;
}

interface V16DecodeCorrelatedOk {
	readonly ok: true;
	readonly request: V16TypedRequest;
}

function unwrapDecodeCorrelated(result: V16DecodeCorrelated): V16DecodeCorrelatedOk | undefined {
	if (!result.ok) return undefined;
	return result;
}

// ---------- encodeReply-based commit (no error sniffing) ----------

function _encodeReplyCommit(
	record: _SessionRecord,
	cs: _CallState,
	entryAc: AbortController,
	method: string,
	rawOutput: unknown,
	poisonSession: (record: _SessionRecord) => void,
): void {
	if (cs._poisoned) return;
	if (cs._cancelled) return;
	if (cs._replyReady) return;

	// Every result goes through encodeReply. No ad-hoc error property sniffing.
	// Accepted codec never throws — no catch needed.
	const encResult: V16ReplyEncodeResult = encodeReply(method, rawOutput, record._identity);
	if (encResult.ok) {
		cs._replyBytes = encResult.bytes;
		cs._replyReady = true;
		_setDelete(record._activeAbortControllers, entryAc);
		return;
	}

	// encodeReply rejected — fallback with CONTROLLER_FAILURE.
	// This handles invalid METHOD_UNAVAILABLE on required methods: the codec rejects it,
	// and we deterministically fall back through a second encodeReply with CONTROLLER_FAILURE.
	const fallbackResult: V16ReplyEncodeResult = encodeReply(
		method,
		_freeze({ error: "CONTROLLER_FAILURE" }),
		record._identity,
	);
	if (fallbackResult.ok) {
		cs._replyBytes = fallbackResult.bytes;
		cs._replyReady = true;
		_setDelete(record._activeAbortControllers, entryAc);
		return;
	}

	// Both encodeReply attempts failed — route through full poison callback
	// so the session is fully aborted, zeroed, and revoked, not left in a
	// partial state with only _poisoned=true set.
	poisonSession(record);
}

// =======================================================================
// _createInnerInvocationManager — private per-session factory
// =======================================================================

function _createInnerInvocationManager(
	record: _SessionRecord,
	poisonSession: (record: _SessionRecord) => void,
): ControllerInvocationManager {
	// Private-class claim issuer via static-block-initialised mint.
	// TypeScript `private constructor()` is true private — callable only within
	// the class body.  The static block captures the issue function in a closure
	// box.  No sentinel token, no public constructor, no ordinary block wrapper,
	// no default fallback.  Prototype constructor nulled before class/proto/instance
	// freeze.  createClaim returns `object | undefined` and never issues a
	// placeholder object — missing issuer poisons the session with no cap issued.
	let _claimIssue: (() => object) | undefined;
	{
		class _Claim {
			private constructor() {
				// True private — only accessible inside class body, not via sentinel.
			}
			static {
				_claimIssue = function _issue(): object {
					return new _Claim();
				};
			}
		}
		_defineProperty(_Claim.prototype, "constructor", {
			value: null,
			writable: false,
			configurable: false,
			enumerable: false,
		});
		_freeze(_Claim);
		_freeze(_Claim.prototype);
	}

	function createClaim(): object | undefined {
		// Fail-closed: if the static block did not set _claimIssue (should never
		// happen), poison the session and return undefined — no cap issued.
		if (typeof _claimIssue !== "function") {
			poisonSession(record);
			return undefined;
		}
		const claim: object = _claimIssue();
		_freeze(claim);
		record._issuedCaps.add(claim);
		return claim;
	}

	function lookupCallState(claim: unknown): _CallState | undefined {
		if (typeof claim !== "object" || claim === null) return undefined;
		return record._callLocalMap.get(claim);
	}

	const invoke = (method: string, body: unknown): InvokeResult => {
		if (record._poisoned) return _freeze({ ok: false, code: "POISONED" });

		if (!isString(method)) return _freeze({ ok: false, code: "INPUT_INVALID" });
		if (!isV16Method(method)) return _freeze({ ok: false, code: "UNKNOWN_METHOD" });

		const enc: V16EncodeResult = encodeRequest({ method: method, body: body });
		const encOk: V16EncodeSuccess | undefined = unwrapEncodeSuccess(enc);
		if (encOk === undefined) {
			return _freeze({ ok: false, code: "INPUT_INVALID" });
		}

		const dec: V16DecodeCorrelated = decodeRequest(encOk.bytes);
		const decOk: V16DecodeCorrelatedOk | undefined = unwrapDecodeCorrelated(dec);
		if (decOk === undefined) {
			return _freeze({ ok: false, code: "INPUT_INVALID" });
		}

		const ac: AbortController = new AbortController();
		const claim: object | undefined = createClaim();
		if (claim === undefined) {
			// createClaim detected missing mint, poisoned session.
			// No cap issued — return POISONED.
			return _freeze({ ok: false, code: "POISONED" });
		}

		const state: _CallState = {
			_method: decOk.request.method,
			_cancelled: false,
			_dispatched: false,
			_ac: ac,
			_replyBytes: null,
			_replyReady: false,
			_poisoned: false,
			_adapterSettled: false,
		};

		record._callLocalMap.set(claim, state);
		record._callRecords.add(state);

		record._pendingDispatch.push({
			callClaim: claim,
			method: decOk.request.method,
			body: decOk.request,
			ac: ac,
		});

		return _freeze({ ok: true, callClaim: claim });
	};

	const pollDispatch = (): DispatchResult => {
		if (record._poisoned) return _freeze({ ok: false, code: "POISONED" });
		if (record._pendingDispatch.length === 0) return _freeze({ ok: false, code: "EMPTY" });

		const entry = record._pendingDispatch.shift();
		if (entry === undefined) return _freeze({ ok: false, code: "EMPTY" });

		const cs: _CallState | undefined = record._callLocalMap.get(entry.callClaim);
		if (cs === undefined) return _freeze({ ok: false, code: "FABRICATED" });

		if (cs._cancelled) {
			return _freeze({ ok: false, code: "CANCELLED" });
		}

		cs._dispatched = true;
		record._activeAbortControllers.add(entry.ac);

		// The adapter receives only the inner V16RequestBody (decOk.request.body),
		// plus V16Method and AbortSignal. Never the full V16TypedRequest.
		const signal: AbortSignal = entry.ac.signal;
		const method: string = entry.method;
		const innerBody: V16RequestBody = entry.body.body;

		// Synchronous try: catch synchronous throws immediately
		let providerPromise: Promise<unknown>;
		try {
			const rawResult: unknown = _Reflect_apply(record._adapterInvoke, null, [method, innerBody, signal]);
			providerPromise = Promise.resolve(rawResult);
		} catch (_e: unknown) {
			// Synchronous throw from adapter — commit CONTROLLER_FAILURE immediately.
			// No race task needed; the failure is already committed.
			if (!record._poisoned && !cs._poisoned && !cs._cancelled && !cs._adapterSettled) {
				cs._adapterSettled = true;
				_encodeReplyCommit(record, cs, entry.ac, method, _freeze({ error: "CONTROLLER_FAILURE" }), poisonSession);
			}
			const dispatchBundle: DispatchBundle = _freeze({
				method: entry.method,
				body: entry.body.body,
				signal: entry.ac.signal,
			});
			return _freeze({ ok: true, dispatch: dispatchBundle });
		}

		// Build abort promise for race — resolves with ABORT_OUTCOME sentinel, never rejects
		let _cleanupAbort: (() => void) | null = null;
		const abortPromise: Promise<typeof _ABORT_OUTCOME> = new Promise(
			(resolve: (value: typeof _ABORT_OUTCOME) => void): void => {
				if (signal.aborted) {
					resolve(_ABORT_OUTCOME);
					return;
				}
				const handler: () => void = (): void => {
					resolve(_ABORT_OUTCOME);
				};
				_Reflect_apply(_addEventListener, signal, ["abort", handler, { once: true }]);
				_cleanupAbort = (): void => {
					_Reflect_apply(_removeEventListener, signal, ["abort", handler]);
				};
			},
		);

		// Create tracked race task: Promise.race between provider and abort.
		// Abort resolves with sentinel — no instanceof/DOMException boundary.
		// Task wrapper is resolve-only: both handlers return void, no catches,
		// and cannot call a throwing dynamic boundary. Every internal call
		// (encodeReply, captured-intrinsic abort listener, Set operations)
		// is structurally no-throw by accepted codec contract.
		const taskPromise: Promise<void> = Promise.race([providerPromise, abortPromise]).then(
			function onProviderResolve(value: unknown): void {
				if (_cleanupAbort !== null) _cleanupAbort();
				_setDelete(record._activeTasks, taskRecord);
				if (value === _ABORT_OUTCOME) return; // abort won — do not commit
				if (record._poisoned) return;
				if (cs._poisoned) return;
				if (cs._cancelled) return;
				if (cs._adapterSettled) return;
				cs._adapterSettled = true;
				_encodeReplyCommit(record, cs, entry.ac, method, value, poisonSession);
			},
			function onTaskReject(_reason: unknown): void {
				if (_cleanupAbort !== null) _cleanupAbort();
				_setDelete(record._activeTasks, taskRecord);
				// Provider rejected — commit CONTROLLER_FAILURE
				if (record._poisoned) return;
				if (cs._poisoned) return;
				if (cs._cancelled) return;
				if (cs._adapterSettled) return;
				cs._adapterSettled = true;
				_encodeReplyCommit(record, cs, entry.ac, method, _freeze({ error: "CONTROLLER_FAILURE" }), poisonSession);
			},
		);

		const taskRecord: _TaskRecord = {
			promise: taskPromise,
			callClaim: entry.callClaim,
			method: entry.method,
		};
		record._activeTasks.add(taskRecord);

		const dispatchBundle: DispatchBundle = _freeze({
			method: entry.method,
			body: entry.body.body,
			signal: entry.ac.signal,
		});

		return _freeze({ ok: true, dispatch: dispatchBundle });
	};

	const pollReply = (callClaim: unknown): PollReplyResult => {
		const cs: _CallState | undefined = lookupCallState(callClaim);
		if (cs === undefined) return _freeze({ ok: false, code: "FABRICATED" });

		if (cs._poisoned) return _freeze({ ok: false, code: "POISONED" });
		if (!cs._replyReady) {
			if (cs._cancelled) return _freeze({ ok: false, code: "CANCELLED" });
			return _freeze({ ok: false, code: "PENDING" });
		}

		if (cs._replyBytes === null) {
			return _freeze({ ok: false, code: "PENDING" });
		}

		// All replies (success and error) go through decodeReply from stored codec bytes.
		// No ad-hoc error property sniffing.
		const dec: V16ReplyDecodeResult = decodeReply(cs._replyBytes, cs._method, record._identity);
		if (!dec.ok) {
			return _freeze({ ok: false, code: "FRAME_ERROR" });
		}
		return _freeze({ ok: true, reply: dec.reply.body });
	};

	const cancel = (callClaim: unknown): CancelResult => {
		const cs: _CallState | undefined = lookupCallState(callClaim);
		if (cs === undefined) return _freeze({ ok: false, code: "FABRICATED" });

		if (cs._poisoned) return _freeze({ ok: false, code: "POISONED" });
		if (cs._cancelled) return _freeze({ ok: true, code: "ALREADY_CANCELLED" });
		if (cs._replyReady) return _freeze({ ok: false, code: "REPLY_READY" });

		cs._cancelled = true;

		if (cs._dispatched && cs._ac !== null) {
			_setDelete(record._activeAbortControllers, cs._ac);
			_Reflect_apply(_abortPrototypeAbort, cs._ac, []);
		} else {
			for (let i: number = 0; i < record._pendingDispatch.length; i++) {
				if (record._pendingDispatch[i].callClaim === callClaim) {
					record._pendingDispatch.splice(i, 1);
					break;
				}
			}
		}

		return _freeze({ ok: true, code: "CANCELLED" });
	};

	const close = async (): Promise<CloseResult> => {
		// Shared settlement promise — every caller awaits the same cleanup operation.
		// First caller stores the settlement promise before any side effect, so a
		// reentrant close call through an abort listener sees the assigned promise
		// and shares one cleanup instead of starting a second.
		//
		// Guarantee: because the async IIFE yields at `await undefined` before any
		// abort/cleanup, the assignment completes before any reentrant or concurrent
		// caller can check _closeSettlement.  Reentrant calls from abort listeners
		// inside performClose always see the assigned promise.
		if (record._closeSettlement !== null) {
			await record._closeSettlement;
			return _freeze({ ok: true, code: "CLOSED" });
		}

		// Store settlement before any abort/side effect. The async body begins with
		// an unconditional await of undefined so the function yields immediately,
		// the assignment completes, and reentrant callers see a non-null settlement.
		record._closeSettlement = (async function performClose(): Promise<void> {
			// Unconditional microtask yield — assignment completes before cleanup.
			await undefined;

			// Abort all pending dispatch controllers
			for (let i: number = 0; i < record._pendingDispatch.length; i++) {
				const entry = record._pendingDispatch[i];
				_Reflect_apply(_abortPrototypeAbort, entry.ac, []);
			}
			record._pendingDispatch.length = 0;

			// Abort all active (dispatched) controllers — triggers abort promise in race tasks
			for (const ac of record._activeAbortControllers) {
				_Reflect_apply(_abortPrototypeAbort, ac, []);
			}

			// Await all local race tasks to settle (they settle quickly because abort won the race).
			// Tasks are resolve-only promises; direct await without try/catch.
			const tasks: Array<_TaskRecord> = [];
			for (const t of record._activeTasks) {
				tasks.push(t);
			}
			for (let i: number = 0; i < tasks.length; i++) {
				await tasks[i].promise;
			}
			record._activeTasks.clear();

			// Zero/revoke — always runs even if already fully poisoned.
			// Sets are cleared; zero idempotent. Caps already revoked, re-clear no-op.
			record._poisoned = true;

			for (const cs of record._callRecords) {
				cs._poisoned = true;
				if (cs._replyBytes !== null) {
					for (let bi: number = 0; bi < cs._replyBytes.length; bi++) {
						cs._replyBytes[bi] = 0;
					}
				}
				cs._replyBytes = null;
				cs._cancelled = true;
			}

			record._callRecords.clear();
			record._activeAbortControllers.clear();
		})();

		await record._closeSettlement;
		return _freeze({ ok: true, code: "CLOSED" });
	};

	const manager: ControllerInvocationManager = _freeze({
		invoke: invoke,
		pollDispatch: pollDispatch,
		pollReply: pollReply,
		cancel: cancel,
		close: close,
	});

	return manager;
}

// =======================================================================
// createControllerInvocationAuthorityManager — single public export
// =======================================================================

function createControllerInvocationAuthorityManager(): AuthorityManager {
	const capToOwner: WeakMap<object, _SessionRecord> = new WeakMap();
	const _sessionRegistry: Map<string, _SessionRecord> = new Map();

	function _registerCap(cap: object, record: _SessionRecord): void {
		capToOwner.set(cap, record);
	}

	function _poisonSession(record: _SessionRecord): void {
		if (record._poisoned) return;
		record._poisoned = true;
		// Abort all pending dispatch AbortControllers via captured intrinsic
		for (let i: number = 0; i < record._pendingDispatch.length; i++) {
			const entry = record._pendingDispatch[i];
			_Reflect_apply(_abortPrototypeAbort, entry.ac, []);
		}
		record._pendingDispatch.length = 0;

		// Abort all active (dispatched) AbortControllers via captured intrinsic
		for (const ac of record._activeAbortControllers) {
			_Reflect_apply(_abortPrototypeAbort, ac, []);
		}
		record._activeAbortControllers.clear();

		// Zero fill reply bytes then set null
		for (const cs of record._callRecords) {
			cs._poisoned = true;
			if (cs._replyBytes !== null) {
				for (let bi: number = 0; bi < cs._replyBytes.length; bi++) {
					cs._replyBytes[bi] = 0;
				}
			}
			cs._replyBytes = null;
			cs._cancelled = true;
		}

		// Revoke all cap->owner WeakMap entries
		for (const cap of record._issuedCaps) {
			_weakMapDelete(capToOwner, cap);
		}
		record._issuedCaps.clear();
		record._callRecords.clear();
	}

	const createSession = (adapterRaw: unknown, identityRaw: unknown): CreateSessionResult => {
		const identity: V16WireIdentity | undefined = validateIdentity(identityRaw);
		if (identity === undefined) {
			return _freeze({ ok: false, code: "INVALID_INPUT" });
		}

		if (!isRecord(adapterRaw)) {
			return _freeze({ ok: false, code: "INVALID_INPUT" });
		}
		const adDs: Record<string, PropertyDescriptor> | undefined = captureExactKeysOrdered(
			adapterRaw,
			_freeze(["invoke"]),
		);
		if (adDs === undefined) {
			return _freeze({ ok: false, code: "INVALID_INPUT" });
		}
		const invokeRaw: unknown = adDs.invoke.value;
		// typeof check instead of a Function type predicate — TypeScript's
		// built-in narrowing assigns the callable type without writing `Function`.
		if (typeof invokeRaw !== "function") {
			return _freeze({ ok: false, code: "INVALID_INPUT" });
		}
		const adapterInvoke = ($method: string, $body: V16RequestBody, $signal: AbortSignal): unknown =>
			_Reflect_apply(invokeRaw, null, [$method, $body, $signal]);

		const sessionName: string = identity.sessionName;

		// EXACT CHECK: reject duplicate sessionName to prevent orphaning old tasks.
		// No overwrite, no mutation of existing record.
		if (_sessionRegistry.has(sessionName)) {
			return _freeze({ ok: false, code: "INVALID_INPUT" });
		}

		const record: _SessionRecord = {
			_name: sessionName,
			_identity: identity,
			_adapterInvoke: adapterInvoke,
			_poisoned: false,
			_closeSettlement: null,
			_closeOperation: null,
			_callLocalMap: new WeakMap(),
			_pendingDispatch: [],
			_issuedCaps: new Set(),
			_callRecords: new Set(),
			_activeAbortControllers: new Set(),
			_activeTasks: new Set(),
		};

		const inner: ControllerInvocationManager = _createInnerInvocationManager(record, _poisonSession);

		_sessionRegistry.set(sessionName, record);

		const wrappedInvoke = (method: string, body: unknown): InvokeResult => {
			if (record._poisoned) return _freeze({ ok: false, code: "POISONED" });

			const result: InvokeResult = inner.invoke(method, body);
			if (result.ok) {
				_registerCap(result.callClaim, record);
			}
			return result;
		};

		const wrappedCancel = (callClaim: unknown): CancelResult => {
			if (record._poisoned) return _freeze({ ok: false, code: "POISONED" });

			if (typeof callClaim !== "object" || callClaim === null) {
				return _freeze({ ok: false, code: "FABRICATED" });
			}

			const owner: _SessionRecord | undefined = capToOwner.get(callClaim);
			if (owner === undefined) {
				return _freeze({ ok: false, code: "FABRICATED" });
			}
			if (owner !== record) {
				_poisonSession(owner);
				return _freeze({ ok: false, code: "WRONG_OWNER" });
			}

			return inner.cancel(callClaim);
		};

		const wrappedPollReply = (callClaim: unknown): PollReplyResult => {
			if (record._poisoned) return _freeze({ ok: false, code: "POISONED" });

			if (typeof callClaim !== "object" || callClaim === null) {
				return _freeze({ ok: false, code: "FABRICATED" });
			}

			const owner: _SessionRecord | undefined = capToOwner.get(callClaim);
			if (owner === undefined) {
				return _freeze({ ok: false, code: "FABRICATED" });
			}
			if (owner !== record) {
				_poisonSession(owner);
				return _freeze({ ok: false, code: "WRONG_OWNER" });
			}

			return inner.pollReply(callClaim);
		};

		const wrappedPollDispatch = (): DispatchResult => {
			if (record._poisoned) return _freeze({ ok: false, code: "POISONED" });

			const result: DispatchResult = inner.pollDispatch();
			if (result.ok) {
				_registerCap(result.dispatch, record);
			}
			return result;
		};

		const wrappedClose = async (): Promise<CloseResult> => {
			// Capture caps before close clears the set, so we can revoke
			// from capToOwner after cleanup.
			const capsToRevoke: Array<object> = [];
			for (const cap of record._issuedCaps) {
				capsToRevoke.push(cap);
			}

			const result: CloseResult = await inner.close();

			// Revoke all cap->owner WeakMap entries (capToOwner is in outer closure)
			for (let i: number = 0; i < capsToRevoke.length; i++) {
				_weakMapDelete(capToOwner, capsToRevoke[i]);
			}
			record._issuedCaps.clear();

			// Delete from registry only if identity still maps this exact record.
			if (_sessionRegistry.get(record._name) === record) {
				_mapDelete(_sessionRegistry, record._name);
			}

			return result;
		};

		// Store the close operation on the record for cleanup to invoke
		// without creating a new inner manager.
		record._closeOperation = wrappedClose;

		const session: ControllerInvocationManager = _freeze({
			invoke: wrappedInvoke,
			pollDispatch: wrappedPollDispatch,
			pollReply: wrappedPollReply,
			cancel: wrappedCancel,
			close: wrappedClose,
		});

		return _freeze({ ok: true, session: session });
	};

	const cleanup = async (): Promise<void> => {
		const names: string[] = [];
		for (const n of _sessionRegistry.keys()) {
			names.push(n);
		}
		// Use each record's stored close operation rather than creating a
		// new inner manager — avoids a second claim class/mint instantiation.
		for (let i: number = 0; i < names.length; i++) {
			const rec: _SessionRecord | undefined = _sessionRegistry.get(names[i]);
			if (rec !== undefined && rec._closeOperation !== null) {
				await rec._closeOperation();
			} else if (rec !== undefined) {
				// No close operation (should never happen); fall back to direct poison.
				_poisonSession(rec);
			}
		}
		_sessionRegistry.clear();
	};

	const manager: AuthorityManager = _freeze({
		createSession: createSession,
		cleanup: cleanup,
	});

	return manager;
}

// =======================================================================
// Public types
// =======================================================================

interface ControllerInvocationManager {
	readonly invoke: (method: string, body: unknown) => InvokeResult;
	readonly pollDispatch: () => DispatchResult;
	readonly pollReply: (callClaim: unknown) => PollReplyResult;
	readonly cancel: (callClaim: unknown) => CancelResult;
	readonly close: () => Promise<CloseResult>;
}

interface CloseResult {
	readonly ok: true;
	readonly code: "CLOSED";
}

interface AuthorityManager {
	readonly createSession: (adapterRaw: unknown, identityRaw: unknown) => CreateSessionResult;
	readonly cleanup: () => Promise<void>;
}

interface InvokeOk {
	readonly ok: true;
	readonly callClaim: object;
}

interface InvokeFail {
	readonly ok: false;
	readonly code: "INPUT_INVALID" | "UNKNOWN_METHOD" | "CLOSED" | "POISONED";
}

type InvokeResult = InvokeOk | InvokeFail;

interface DispatchBundle {
	readonly method: string;
	readonly body: V16RequestBody;
	readonly signal: AbortSignal;
}

interface DispatchOk {
	readonly ok: true;
	readonly dispatch: DispatchBundle;
}

interface DispatchFail {
	readonly ok: false;
	readonly code: "CLOSED" | "EMPTY" | "CANCELLED" | "FABRICATED" | "POISONED";
}

type DispatchResult = DispatchOk | DispatchFail;

interface PollReplyOk {
	readonly ok: true;
	readonly reply: unknown;
}

interface PollReplyFail {
	readonly ok: false;
	readonly code: "INPUT_INVALID" | "FABRICATED" | "CANCELLED" | "PENDING" | "FRAME_ERROR" | "WRONG_OWNER" | "POISONED";
}

type PollReplyResult = PollReplyOk | PollReplyFail;

interface CancelOk {
	readonly ok: true;
	readonly code: "CANCELLED" | "ALREADY_CANCELLED";
}

interface CancelFail {
	readonly ok: false;
	readonly code: "FABRICATED" | "REPLY_READY" | "WRONG_OWNER" | "POISONED";
}

type CancelResult = CancelOk | CancelFail;

interface CreateSessionOk {
	readonly ok: true;
	readonly session: ControllerInvocationManager;
}

interface CreateSessionFail {
	readonly ok: false;
	readonly code: "INVALID_INPUT";
}

type CreateSessionResult = CreateSessionOk | CreateSessionFail;

// =======================================================================
// Exports
// =======================================================================

export type {
	AuthorityManager,
	CancelFail,
	CancelOk,
	CancelResult,
	CloseResult,
	ControllerInvocationManager,
	CreateSessionFail,
	CreateSessionOk,
	CreateSessionResult,
	DispatchBundle,
	DispatchFail,
	DispatchOk,
	DispatchResult,
	InvokeFail,
	InvokeOk,
	InvokeResult,
	PollReplyFail,
	PollReplyOk,
	PollReplyResult,
	V16Method,
	V16RequestBody,
	V16TypedRequest,
};
export { createControllerInvocationAuthorityManager };
