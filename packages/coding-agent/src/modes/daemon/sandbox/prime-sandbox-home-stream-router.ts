// HOME V31 Outer Stream Router
//
// Accepts the committed V24 controller-dispatcher as a sub-router, adds
// stream-0 model dispatch via ModelStreamProviderManager, stream-1 lifecycle
// dispatch with a dynamic child registry, and a fail-closed disabled boundary
// for stream 4.
//
// Registry is an entry array sized by active Home-owned child ports
// (no admission cap). 32 router cells bound concurrent reply retention to
// the mux inbound flow cap (MAX_LIVE_PER_ORIGIN = 32), NOT child admission.
//
// Each registered child may carry an optional per-child controller dispatcher.
// Stream 2/3 frames are decoded from a controller-route envelope, the child
// is looked up by exact four-field identity, and the inner V16 bytes are
// forwarded to that child's dispatcher. No fixed shared controller.

import { types } from "node:util";
import type {
	HostedRlmRuntimeEvent,
	HostedRlmRuntimeIdentity,
	HostedRlmTaskResult,
} from "../../../core/hosted-rlm-runtime-port.js";
import {
	type ControllerRouteDecodeResult,
	decodeControllerRouteEnvelope,
} from "./prime-sandbox-controller-route-envelope.js";
import {
	createPrimeSandboxHostedControllerDispatcher,
	type HostedControllerDispatcher,
	type RouteResult,
} from "./prime-sandbox-hosted-controller-adapter.js";
import {
	decodeLifecycleRecord,
	encodeLifecycleReply,
	type LifecycleDecodeRecordResult,
	type LifecycleEncodeResult,
} from "./prime-sandbox-runtime-control-codec.js";
import { copySandboxStrictBytes, type SandboxStrictByteCopyResult } from "./prime-sandbox-strict-bytes.js";
import type { ApplicationBundle, ComposedReplyResult } from "./prime-sandbox-v31-multiplexer.js";

// ---------- module-init captured intrinsics ----------

const _freeze: typeof Object.freeze = Object.freeze;
const _ReflectApply: typeof Reflect.apply = Reflect.apply;
const _is: typeof Object.is = Object.is;
const _promiseThen: typeof Promise.prototype.then = Promise.prototype.then;
const _queueMicrotask: (fn: () => void) => void = queueMicrotask;
const _typesIsProxy: (value: unknown) => boolean = types.isProxy;
const _RegExpPrototypeTest: typeof RegExp.prototype.test = RegExp.prototype.test;
const _RegExpTest: (re: RegExp, val: string) => boolean = (re: RegExp, val: string): boolean =>
	_ReflectApply(_RegExpPrototypeTest, re, [val]);

// ---------- public types ----------

export interface HostedRlmLifecycleSettle {
	readonly listener?: (event: HostedRlmRuntimeEvent) => void;
	readonly terminalSettle?: (result: HostedRlmTaskResult) => void;
}

export interface LifecycleUnregister {
	readonly unregister: () => void;
}

export interface HomeStreamRouterInput {
	readonly modelProvider: { readonly dispatchApplication: (bundle: ApplicationBundle) => void };
}

export interface HomeStreamRouter {
	readonly dispatchApplication: (bundle: ApplicationBundle) => void;
	readonly close: () => void;
	readonly registerLifecycleChild: (
		identity: HostedRlmRuntimeIdentity,
		settle?: HostedRlmLifecycleSettle,
		controllerDispatcherRaw?: unknown,
	) => LifecycleUnregister | Readonly<{ ok: false; code: "ALREADY_REGISTERED" | "CLOSED" | "INPUT_INVALID" }>;
}

// ---------- internal types ----------

interface RouterReplyCell {
	replyPromise: Promise<ComposedReplyResult> | null;
	replyThenPromise: Promise<void> | null;
	ownedBytes: Uint8Array | null;
}

interface LifecycleChildEntry {
	readonly identity: HostedRlmRuntimeIdentity;
	listener: ((event: HostedRlmRuntimeEvent) => void) | null;
	terminalSettle: ((result: HostedRlmTaskResult) => void) | null;
	terminalSeen: boolean;
	readonly unregisterToken: object;
	controllerRouteFn: ((bundle: ApplicationBundle) => RouteResult) | null;
	controllerCloseFn: (() => void) | null;
	controllerReceiver: object | null;
	controllerClosed: boolean;
}

// ---------- private constants ----------

const _MAX_LIFECYCLE_PAYLOAD: number = 262128;
const _CELL_COUNT: number = 32;

// ---------- local identity validation (mirrors hosted-rlm-runtime-port.ts) ----------

const _IDENTITY_KEYS: ReadonlyArray<string> = ["childId", "sessionId", "sessionName", "modelSelector"];
const _MAX_IDENTIFIER_LENGTH: number = 128;
const _reBoundedIdentifier: RegExp = /^[a-zA-Z0-9_./:-]{1,128}$/;
const _ObjectPrototype: object = Object.prototype;
const _ObjectGetPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const _ObjectGetOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const _ObjectGetOwnPropertyDescriptors: typeof Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptors;
const _ObjectGetOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const _ArrayIncludes: (arr: readonly string[], val: string) => boolean = (arr, val) => {
	for (let i = 0; i < arr.length; i++) {
		if (arr[i] === val) return true;
	}
	return false;
};

function _boundedIdentifier(raw: unknown): raw is string {
	return (
		typeof raw === "string" &&
		raw.length > 0 &&
		raw.length <= _MAX_IDENTIFIER_LENGTH &&
		_RegExpTest(_reBoundedIdentifier, raw)
	);
}

function _validateIdentity(raw: unknown): HostedRlmRuntimeIdentity | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (_typesIsProxy(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (_ObjectGetPrototypeOf(raw) !== _ObjectPrototype) return null;
	} catch {
		return null;
	}
	try {
		if (_ObjectGetOwnPropertySymbols(raw).length !== 0) return null;
	} catch {
		return null;
	}
	let descriptors: { [key: string]: PropertyDescriptor };
	let names: string[];
	try {
		descriptors = _ObjectGetOwnPropertyDescriptors(raw);
		names = _ObjectGetOwnPropertyNames(descriptors);
	} catch {
		return null;
	}
	if (names.length !== _IDENTITY_KEYS.length) return null;
	const childId: unknown =
		descriptors.childId !== undefined && "value" in descriptors.childId ? descriptors.childId.value : undefined;
	const sessionId: unknown =
		descriptors.sessionId !== undefined && "value" in descriptors.sessionId ? descriptors.sessionId.value : undefined;
	const sessionName: unknown =
		descriptors.sessionName !== undefined && "value" in descriptors.sessionName
			? descriptors.sessionName.value
			: undefined;
	const modelSelector: unknown =
		descriptors.modelSelector !== undefined && "value" in descriptors.modelSelector
			? descriptors.modelSelector.value
			: undefined;
	for (let vi = 0; vi < names.length; vi++) {
		const name: string = names[vi];
		if (!_ArrayIncludes(_IDENTITY_KEYS, name)) return null;
		const desc: PropertyDescriptor | undefined = descriptors[name];
		if (desc === undefined || !("value" in desc) || !desc.enumerable) return null;
	}
	if (
		childId === undefined ||
		!_boundedIdentifier(childId) ||
		sessionId === undefined ||
		!_boundedIdentifier(sessionId) ||
		sessionName === undefined ||
		!_boundedIdentifier(sessionName) ||
		modelSelector === undefined ||
		!_boundedIdentifier(modelSelector)
	)
		return null;
	return { childId: childId, sessionId: sessionId, sessionName: sessionName, modelSelector: modelSelector };
}

// ---------- byte-zero helpers (non-throwing per design invariants) ----------

function _zeroBytes(bytes: Uint8Array): void {
	for (let i = 0; i < bytes.length; i++) bytes[i] = 0;
}

function _zeroBundlePayload(bundle: ApplicationBundle): void {
	_zeroBytes(bundle.payload);
}

// ---------- identity helper ----------

function _identityMatches(a: HostedRlmRuntimeIdentity, b: HostedRlmRuntimeIdentity): boolean {
	return (
		_is(a.childId, b.childId) === true &&
		_is(a.sessionId, b.sessionId) === true &&
		_is(a.sessionName, b.sessionName) === true &&
		_is(a.modelSelector, b.modelSelector) === true
	);
}

// ---------- factory ----------

export function createHomeStreamRouter(input: HomeStreamRouterInput): HomeStreamRouter {
	// Capture model provider once — never reread mutable input.
	const modelProviderObj: { readonly dispatchApplication: (bundle: ApplicationBundle) => void } = input.modelProvider;
	const capturedModelDispatch: (bundle: ApplicationBundle) => void = input.modelProvider.dispatchApplication;

	// ---------- mutable state ----------

	const routerCells: Array<RouterReplyCell | null> = new Array(_CELL_COUNT);
	for (let i = 0; i < _CELL_COUNT; i++) routerCells[i] = null;
	let routerClosed: boolean = false;

	// Child registry: nullable entry array. Indexed scan, reuse null holes.
	const childEntries: Array<LifecycleChildEntry | null> = [];

	// ---------- cell lifecycle ----------

	function allocateCell(): number | null {
		for (let i = 0; i < _CELL_COUNT; i++) {
			if (routerCells[i] === null) {
				routerCells[i] = { replyPromise: null, replyThenPromise: null, ownedBytes: null };
				return i;
			}
		}
		return null;
	}

	function zeroAndFree(cellIndex: number, capturedCell: RouterReplyCell): void {
		const currentCell = routerCells[cellIndex];
		if (_is(currentCell, capturedCell) !== true) return;
		if (currentCell === null) return;
		const owned = currentCell.ownedBytes;
		if (owned !== null) {
			_zeroBytes(owned);
		}
		currentCell.ownedBytes = null;
		currentCell.replyPromise = null;
		_queueMicrotask(function freeCell(): void {
			const now = routerCells[cellIndex];
			if (_is(now, capturedCell) !== true) return;
			if (now === null) return;
			now.replyThenPromise = null;
			routerCells[cellIndex] = null;
		});
	}

	function routerReply(
		cellIndex: number,
		bundle: ApplicationBundle,
		replyPayload: Uint8Array,
		ownedBytes: Uint8Array | null,
	): void {
		const cell = routerCells[cellIndex];
		if (cell === null) return;
		_zeroBundlePayload(bundle);
		let replyPromise: Promise<ComposedReplyResult>;
		try {
			replyPromise = bundle.reply(replyPayload);
		} catch {
			if (ownedBytes !== null) _zeroBytes(ownedBytes);
			cell.ownedBytes = null;
			cell.replyPromise = null;
			_queueMicrotask(function freeCell(): void {
				if (_is(routerCells[cellIndex], cell) !== true) return;
				routerCells[cellIndex] = null;
			});
			return;
		}
		cell.replyPromise = replyPromise;
		cell.ownedBytes = ownedBytes;
		const capturedCell = cell;
		const settled = function settled(): void {
			zeroAndFree(cellIndex, capturedCell);
		};
		let replyThenPromise: Promise<void>;
		try {
			replyThenPromise = _ReflectApply(_promiseThen, replyPromise, [settled, settled]);
		} catch {
			if (ownedBytes !== null) _zeroBytes(ownedBytes);
			cell.ownedBytes = null;
			cell.replyPromise = null;
			_queueMicrotask(function freeCell(): void {
				if (_is(routerCells[cellIndex], cell) !== true) return;
				routerCells[cellIndex] = null;
			});
			return;
		}
		cell.replyThenPromise = replyThenPromise;
	}

	// ---------- child registry helpers ----------

	function findEntrySlot(): number {
		const len = childEntries.length;
		for (let i = 0; i < len; i++) {
			if (childEntries[i] === null) return i;
		}
		return len;
	}

	function unregisterChild(token: object): void {
		if (routerClosed) return;
		const len = childEntries.length;
		for (let i = 0; i < len; i++) {
			const entry = childEntries[i];
			if (entry === null) continue;
			if (_is(entry.unregisterToken, token) === true) {
				if (!entry.controllerClosed && entry.controllerCloseFn !== null) {
					entry.controllerClosed = true;
					try {
						_ReflectApply(entry.controllerCloseFn, entry.controllerReceiver, []);
					} catch {
						entry.controllerRouteFn = null;
						entry.controllerCloseFn = null;
						entry.controllerReceiver = null;
					}
				}
				entry.controllerRouteFn = null;
				entry.controllerCloseFn = null;
				entry.controllerReceiver = null;
				childEntries[i] = null;
				let ti = childEntries.length - 1;
				while (ti >= 0 && childEntries[ti] === null) {
					childEntries.length = ti;
					ti -= 1;
				}
				return;
			}
		}
	}

	function registerLifecycleChild(
		identity: HostedRlmRuntimeIdentity,
		settle?: HostedRlmLifecycleSettle,
		controllerDispatcherRaw?: unknown,
	): LifecycleUnregister | Readonly<{ ok: false; code: "ALREADY_REGISTERED" | "CLOSED" | "INPUT_INVALID" }> {
		if (routerClosed) return _freeze({ ok: false, code: "CLOSED" });
		const validated = _validateIdentity(identity);
		if (validated === null) {
			return _freeze({ ok: false, code: "INPUT_INVALID" });
		}
		const entryCount = childEntries.length;
		for (let i = 0; i < entryCount; i++) {
			const existing = childEntries[i];
			if (existing === null) continue;
			if (_is(existing.identity.childId, validated.childId) === true) {
				return _freeze({ ok: false, code: "ALREADY_REGISTERED" });
			}
			if (_identityMatches(existing.identity, validated)) {
				return _freeze({ ok: false, code: "ALREADY_REGISTERED" });
			}
		}
		let childRouteFn: ((bundle: ApplicationBundle) => RouteResult) | null = null;
		let childCloseFn: (() => void) | null = null;
		let childReceiver: object | null = null;
		if (controllerDispatcherRaw !== undefined && controllerDispatcherRaw !== null) {
			const createResult = createPrimeSandboxHostedControllerDispatcher(controllerDispatcherRaw);
			if (!createResult.ok) {
				return _freeze({ ok: false, code: "INPUT_INVALID" });
			}
			const dispatcher: HostedControllerDispatcher = createResult.value;
			childRouteFn = dispatcher.route;
			childCloseFn = dispatcher.close;
			childReceiver = dispatcher;
		}
		const token: object = _freeze({});
		const unregister = function unregisterBound(): void {
			unregisterChild(token);
		};
		const unregisterCapability: LifecycleUnregister = _freeze({
			unregister: unregister,
		});
		const rawListener: ((event: HostedRlmRuntimeEvent) => void) | null | undefined =
			settle !== undefined && settle !== null ? settle.listener : null;
		const entryListener: ((event: HostedRlmRuntimeEvent) => void) | null =
			typeof rawListener === "function" ? rawListener : null;
		const rawTerminalSettle: ((result: HostedRlmTaskResult) => void) | null | undefined =
			settle !== undefined && settle !== null ? settle.terminalSettle : null;
		const entryTerminalSettle: ((result: HostedRlmTaskResult) => void) | null =
			typeof rawTerminalSettle === "function" ? rawTerminalSettle : null;
		const slot = findEntrySlot();
		childEntries[slot] = {
			identity: _freeze({
				childId: validated.childId,
				sessionId: validated.sessionId,
				sessionName: validated.sessionName,
				modelSelector: validated.modelSelector,
			}),
			listener: entryListener !== undefined ? entryListener : null,
			terminalSettle: entryTerminalSettle !== undefined ? entryTerminalSettle : null,
			terminalSeen: false,
			unregisterToken: token,
			controllerRouteFn: childRouteFn,
			controllerCloseFn: childCloseFn,
			controllerReceiver: childReceiver,
			controllerClosed: false,
		};
		return unregisterCapability;
	}

	function lookupChild(childId: string): LifecycleChildEntry | undefined {
		const len = childEntries.length;
		for (let i = 0; i < len; i++) {
			const entry = childEntries[i];
			if (entry === null) continue;
			if (_is(entry.identity.childId, childId) === true) return entry;
		}
		return undefined;
	}

	function findChildByIdentity(decoded: {
		readonly childId: string;
		readonly sessionId: string;
		readonly sessionName: string;
		readonly modelSelector: string;
	}): LifecycleChildEntry | undefined {
		const len = childEntries.length;
		for (let i = 0; i < len; i++) {
			const entry = childEntries[i];
			if (entry === null) continue;
			if (_is(entry.identity.childId, decoded.childId) !== true) continue;
			if (_is(entry.identity.sessionId, decoded.sessionId) !== true) continue;
			if (_is(entry.identity.sessionName, decoded.sessionName) !== true) continue;
			if (_is(entry.identity.modelSelector, decoded.modelSelector) !== true) continue;
			return entry;
		}
		return undefined;
	}

	// ---------- stream 1 lifecycle handler ----------

	function lifecycleHandler(bundle: ApplicationBundle): void {
		const cellIndex = allocateCell();
		if (cellIndex === null) return;
		let localBytes: Uint8Array | null = null;
		try {
			const copyResult: SandboxStrictByteCopyResult = copySandboxStrictBytes(bundle.payload, _MAX_LIFECYCLE_PAYLOAD);
			if (!copyResult.ok) {
				_zeroBundlePayload(bundle);
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			localBytes = copyResult.value;
			_zeroBundlePayload(bundle);
			const decodeResult: LifecycleDecodeRecordResult = decodeLifecycleRecord(localBytes);
			_zeroBytes(localBytes);
			localBytes = null;
			if (!decodeResult.ok) {
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			const entry = lookupChild(decodeResult.identity.childId);
			if (entry === undefined) {
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			if (!_identityMatches(entry.identity, decodeResult.identity)) {
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			if (decodeResult.op === "EVENT") {
				if (entry.terminalSeen) {
					const encoded: LifecycleEncodeResult = encodeLifecycleReply("EVENT", { code: "ACK" });
					if (encoded.ok) routerReply(cellIndex, bundle, encoded.bytes, encoded.bytes);
					else routerReply(cellIndex, bundle, new Uint8Array(0), null);
					return;
				}
				if (entry.listener !== null) entry.listener(decodeResult.event);
				const encoded: LifecycleEncodeResult = encodeLifecycleReply("EVENT", { code: "ACK" });
				if (encoded.ok) routerReply(cellIndex, bundle, encoded.bytes, encoded.bytes);
				else routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			if (decodeResult.op === "TERMINAL") {
				if (entry.terminalSeen) {
					const encoded: LifecycleEncodeResult = encodeLifecycleReply("TERMINAL", { code: "ACK" });
					if (encoded.ok) routerReply(cellIndex, bundle, encoded.bytes, encoded.bytes);
					else routerReply(cellIndex, bundle, new Uint8Array(0), null);
					return;
				}
				// Capture entry before callback; terminalSettle may close the
				// router and clear the registry. The captured object remains live.
				const capturedEntry: LifecycleChildEntry = entry;
				if (capturedEntry.terminalSettle !== null) {
					capturedEntry.terminalSettle(decodeResult.result);
				}
				capturedEntry.terminalSeen = true;
				const encoded: LifecycleEncodeResult = encodeLifecycleReply("TERMINAL", { code: "ACK" });
				if (encoded.ok) routerReply(cellIndex, bundle, encoded.bytes, encoded.bytes);
				else routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			routerReply(cellIndex, bundle, new Uint8Array(0), null);
			return;
		} catch {
			if (localBytes !== null) _zeroBytes(localBytes);
			_zeroBundlePayload(bundle);
			routerReply(cellIndex, bundle, new Uint8Array(0), null);
			return;
		}
	}

	// ---------- stream 2/3 controller dispatch ----------

	function controllerRoute(bundle: ApplicationBundle): void {
		let innerBytes: Uint8Array | null = null;
		try {
			const decodeResult: ControllerRouteDecodeResult = decodeControllerRouteEnvelope(bundle.payload);
			if (!decodeResult.ok) {
				_zeroBundlePayload(bundle);
				const cellIndex = allocateCell();
				if (cellIndex === null) return;
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			innerBytes = decodeResult.inner;
			_zeroBundlePayload(bundle);
			const entry = findChildByIdentity(decodeResult.identity);
			if (entry === undefined) {
				if (innerBytes !== null) {
					_zeroBytes(innerBytes);
					innerBytes = null;
				}
				const cellIndex = allocateCell();
				if (cellIndex === null) return;
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			if (entry.controllerRouteFn === null) {
				if (innerBytes !== null) {
					_zeroBytes(innerBytes);
					innerBytes = null;
				}
				const cellIndex = allocateCell();
				if (cellIndex === null) return;
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			const innerBundle: ApplicationBundle = {
				origin: bundle.origin,
				stream: bundle.stream,
				payload: innerBytes,
				signal: bundle.signal,
				reply: bundle.reply,
			};
			innerBytes = null;
			let routeResult: RouteResult;
			try {
				routeResult = _ReflectApply(entry.controllerRouteFn, entry.controllerReceiver, [innerBundle]);
			} catch {
				_zeroBytes(innerBundle.payload);
				const cellIndex = allocateCell();
				if (cellIndex === null) return;
				routerReply(cellIndex, bundle, new Uint8Array(0), null);
				return;
			}
			// Unconditionally zero inner V16 bytes after synchronous route
			_zeroBytes(innerBundle.payload);
			if (routeResult === "HANDLED") return;
			if (routeResult === "INVALID") return;
			const cellIndex = allocateCell();
			if (cellIndex === null) return;
			routerReply(cellIndex, bundle, new Uint8Array(0), null);
			return;
		} catch {
			if (innerBytes !== null) {
				_zeroBytes(innerBytes);
			}
			_zeroBundlePayload(bundle);
			const cellIndex = allocateCell();
			if (cellIndex === null) return;
			routerReply(cellIndex, bundle, new Uint8Array(0), null);
			return;
		}
	}

	// ---------- dispatchApplication ----------

	function dispatchApplication(bundle: ApplicationBundle): void {
		if (routerClosed) {
			const cellIndex = allocateCell();
			if (cellIndex === null) return;
			routerReply(cellIndex, bundle, new Uint8Array(0), null);
			return;
		}
		if (bundle.origin !== "Runtime") {
			const cellIndex = allocateCell();
			if (cellIndex === null) return;
			routerReply(cellIndex, bundle, new Uint8Array(0), null);
			return;
		}
		if (bundle.stream === 0) {
			_ReflectApply(capturedModelDispatch, modelProviderObj, [bundle]);
			return;
		}
		if (bundle.stream === 1) {
			lifecycleHandler(bundle);
			return;
		}
		if (bundle.stream === 2 || bundle.stream === 3) {
			controllerRoute(bundle);
			return;
		}
		const cellIndex = allocateCell();
		if (cellIndex === null) return;
		routerReply(cellIndex, bundle, new Uint8Array(0), null);
	}

	// ---------- close ----------

	function close(): void {
		if (routerClosed) return;
		routerClosed = true;
		const len = childEntries.length;
		for (let i = 0; i < len; i++) {
			const entry = childEntries[i];
			if (entry !== null) {
				entry.listener = null;
				entry.terminalSettle = null;
				if (!entry.controllerClosed && entry.controllerCloseFn !== null) {
					entry.controllerClosed = true;
					try {
						_ReflectApply(entry.controllerCloseFn, entry.controllerReceiver, []);
					} catch {
						entry.controllerRouteFn = null;
						entry.controllerCloseFn = null;
						entry.controllerReceiver = null;
					}
				}
				entry.controllerRouteFn = null;
				entry.controllerCloseFn = null;
				entry.controllerReceiver = null;
			}
		}
		childEntries.length = 0;
	}

	const router: HomeStreamRouter = _freeze({
		dispatchApplication: dispatchApplication,
		close: close,
		registerLifecycleChild: registerLifecycleChild,
	});

	return router;
}
