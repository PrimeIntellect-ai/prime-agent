/**
 * sandbox-command-application.ts — store-backed command relay application.
 *
 * MultiplexerApplication-shaped {apply, close} child wrapping branded effect
 * and store capabilities.  Factory snapshots each method into bound functions
 * before creating the implementation (no raw capability references).
 *
 * apply({envelope}):
 *   1. decodeEnvelope -> require command frame
 *   2. Durable admit via bound method (idempotent/collision check)
 *   3. Query store — if same-body terminal return applied; pending executes;
 *      unexpected started => error, no reexec
 *   4. Execute branded effect.execute synchronously via callSyncEffect:
 *      a. call boundEffect.execute — capture handle/throw
 *      b. immediately markStarted (no microtask gap)
 *      c. validate exact {commandId,completion} handle, commandId matches
 *   5. Exact-observe completion -> markCompleted or markInterrupted
 *   6. Return applied only if terminal write succeeds
 *
 * Lifecycle/workspace commands go through branded effect.execute which
 * returns UNSUPPORTED_COMMAND handle.
 *
 * No best-effort/unsafe durability. No `.catch`. Zero casts/assertions/any.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { decodeEnvelope } from "./remote-host-frame-codec.js";
import {
	isSandboxCommandEffectInstance,
	type SandboxCommandEffectCapability,
	type SandboxCommandEffectHandle,
} from "./sandbox-command-effect.js";
import {
	isSandboxCommandStoreInstance,
	type SandboxCommandStoreCapability,
} from "./sandbox-command-store.js";

// ===========================================================================
// Constants
// ===========================================================================

const FACTORY_KEYS = new Set(["effect", "store"]);
const APPLY_INPUT_KEYS = new Set(["envelope"]);
const APPLY_RESULT_KEYS = new Set(["status"]);
const CLOSE_RESULT_KEYS = new Set(["status"]);
const STORE_OK_KEYS = new Set(["ok", "value"]);
const STORE_ERR_KEYS = new Set(["ok", "error"]);
const HANDLE_KEYS = new Set(["commandId", "completion"]);

const MAX_REPLAY_RANGE = 20_000;

// ===========================================================================
// Result types
// ===========================================================================

export type SandboxCommandApplyResult =
	| Readonly<{ readonly status: "applied" }>
	| Readonly<{ readonly status: "error" }>;

export type SandboxCommandCloseResult =
	| Readonly<{ readonly status: "closed" }>
	| Readonly<{ readonly status: "error" }>;

export interface SandboxCommandApplication {
	readonly apply: (raw: unknown) => Promise<SandboxCommandApplyResult>;
	readonly close: () => Promise<SandboxCommandCloseResult>;
}

export type CreateSandboxCommandApplicationResult =
	| Readonly<{
			readonly ok: true;
			readonly application: SandboxCommandApplication;
	  }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: "INVALID_ARGUMENT" }> }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: "CLOSE_UNCERTAIN" }> }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: "RECOVERY_FAILED" }> }>;

// ===========================================================================
// Lifecycle/workspace command types
// ===========================================================================

const LIFECYCLE_TYPES = new Set([
	"create_session",
	"destroy_session",
	"checkpoint",
	"wake",
	"shutdown",
	"sync_workspace",
]);

const SUPPORTED_TYPES = new Set(["prompt", "steer", "abort", "execute_bash", "abort_bash", "compact", "compact_abort"]);

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type OwnedClose = () => Promise<boolean>;

interface OwnedSlot {
	readonly object: object;
	readonly closeFn: object;
	readonly close: OwnedClose;
}

interface BoundStore {
	readonly admit: BoundMethod;
	readonly markStarted: BoundMethod;
	readonly markCompleted: BoundMethod;
	readonly markInterrupted: BoundMethod;
	readonly query: BoundMethod;
	readonly replayPending: BoundMethod;
}

interface BoundEffect {
	readonly execute: BoundMethod;
}

/** Synchronous execute result from callSyncEffect. */
type SyncExecuteResult =
	| { readonly kind: "ok"; readonly handle: SandboxCommandEffectHandle }
	| { readonly kind: "throw" }
	| { readonly kind: "invalid" };

// ===========================================================================
// Typed constructors
// ===========================================================================

function appliedResult(): SandboxCommandApplyResult {
	return Object.freeze({ status: "applied" });
}

function errorResult(): SandboxCommandApplyResult {
	return Object.freeze({ status: "error" });
}

function closedResult(): SandboxCommandCloseResult {
	return Object.freeze({ status: "closed" });
}

function closeErrorResult(): SandboxCommandCloseResult {
	return Object.freeze({ status: "error" });
}

function invalidArgumentError(): CreateSandboxCommandApplicationResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
}

function closeUncertainError(): CreateSandboxCommandApplicationResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSE_UNCERTAIN" }) });
}

function recoveryFailedError(): CreateSandboxCommandApplicationResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code: "RECOVERY_FAILED" }) });
}

function successResult(
	application: SandboxCommandApplication,
): CreateSandboxCommandApplicationResult {
	return Object.freeze({ ok: true, application });
}

// ===========================================================================
// Descriptor helpers
// ===========================================================================

function rawDescriptors(raw: unknown): Record<string, PropertyDescriptor> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const descriptors = rawDescriptors(raw);
	if (!descriptors) return null;
	const ownKeys = Object.keys(descriptors);
	if (ownKeys.length !== keys.size) return null;
	for (let i = 0; i < ownKeys.length; i++) {
		if (!keys.has(ownKeys[i])) return null;
	}
	return descriptors;
}

function value(descriptors: Descriptors, name: string): unknown {
	const d = descriptors[name];
	return d && "value" in d ? d.value : undefined;
}

// ===========================================================================
// Bind method
// ===========================================================================

function bindMethod(raw: unknown, descriptor: PropertyDescriptor): BoundMethod | null {
	if (typeof raw !== "object" || raw === null) return null;
	const dValue = descriptor.value;
	if (typeof dValue !== "function") return null;
	try {
		if (types.isProxy(dValue)) return null;
		return (...args: readonly unknown[]): unknown => Reflect.apply(dValue, raw, args);
	} catch {
		return null;
	}
}

// ===========================================================================
// Exact native Promise observation
// ===========================================================================

type PromiseObservation =
	| { readonly fulfilled: true; readonly value: unknown }
	| { readonly fulfilled: false };

function isExactNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
		if (!types.isPromise(raw)) return false;
		if (Object.getPrototypeOf(raw) !== Promise.prototype) return false;
		if (Object.getOwnPropertyNames(raw).length !== 0) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

function observePromise(raw: unknown): Promise<PromiseObservation> {
	if (!isExactNativePromise(raw)) {
		return Promise.resolve(Object.freeze({ fulfilled: false }));
	}
	return new Promise((resolve) => {
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(v: unknown) => {
					resolve(Object.freeze({ fulfilled: true, value: v }));
				},
				() => {
					resolve(Object.freeze({ fulfilled: false }));
				},
			]);
		} catch {
			resolve(Object.freeze({ fulfilled: false }));
		}
	});
}

function invoke(call: () => unknown): Promise<PromiseObservation> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ fulfilled: false }));
	}
	return observePromise(raw);
}

// ===========================================================================
// Ownership-first close acquisition
// ===========================================================================

function hasCapabilityUncertainty(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return true;
	} catch {
		return true;
	}
	try {
		const rawSymbolKeys = Object.getOwnPropertySymbols(raw);
		for (const sym of rawSymbolKeys) {
			const d = Object.getOwnPropertyDescriptor(raw, sym);
			if (!d || !("value" in d)) return true;
			if ((typeof d.value === "object" && d.value !== null) || typeof d.value === "function") {
				if (types.isProxy(d.value)) return true;
			}
		}
	} catch {
		return true;
	}
	try {
		if (hasAccessorDescriptor(raw)) return true;
	} catch {
		return true;
	}
	return false;
}

function hasAccessorDescriptor(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of Object.getOwnPropertyNames(descs)) {
			const d = descs[name];
			if (d && !("value" in d)) return true;
		}
	} catch {
		return false;
	}
	return false;
}

function hasProxyCloseFunction(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		const desc = Object.getOwnPropertyDescriptor(raw, "close");
		if (!desc || !("value" in desc)) return false;
		return types.isProxy(desc.value);
	} catch {
		return false;
	}
}

function captureOwnedClose(raw: unknown): OwnedSlot | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}

	let ownDescs: Record<string, PropertyDescriptor>;
	try {
		ownDescs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}

	const closeDesc = ownDescs.close;
	if (!closeDesc || !("value" in closeDesc)) return null;
	const closeFnValue = closeDesc.value;
	if (typeof closeFnValue !== "function") return null;

	try {
		if (types.isProxy(closeFnValue)) return null;
	} catch {
		return null;
	}

	const closeFn: object = closeFnValue;

	let used = false;
	const close: OwnedClose = async (): Promise<boolean> => {
		if (used) return false;
		used = true;
		const observation = await invoke(() => Reflect.apply(closeFnValue, raw, []));
		if (!observation.fulfilled) return false;
		const r = exact(observation.value, CLOSE_RESULT_KEYS);
		if (r !== null && value(r, "status") === "closed") return true;
		// Check {ok:true} generically — works for effect {ok:true} and store {ok:true, value:...}
		if (typeof observation.value === "object" && observation.value !== null) {
			try {
				const od = Object.getOwnPropertyDescriptor(observation.value, "ok");
				if (od && "value" in od && od.value === true) return true;
			} catch {
				return false;
			}
		}
		return false;
	};

	return Object.freeze({ object: raw, closeFn, close });
}

// ===========================================================================
// Preliminary extraction
// ===========================================================================

interface PrelimResult {
	readonly effect: unknown;
	readonly store: unknown;
	readonly ownershipUncertain: boolean;
}

function extractPreliminary(raw: unknown): PrelimResult {
	const uncertain: PrelimResult = Object.freeze({
		effect: undefined,
		store: undefined,
		ownershipUncertain: true,
	});
	if (typeof raw !== "object" || raw === null) return uncertain;
	try {
		if (types.isProxy(raw)) return uncertain;
	} catch {
		return uncertain;
	}

	let ownDescriptors: Record<string, PropertyDescriptor>;
	try {
		ownDescriptors = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return uncertain;
	}

	const getDataValue = (
		name: string,
	): { readonly value: unknown; readonly present: boolean; readonly uncertain: boolean } => {
		const d = ownDescriptors[name];
		if (d === undefined) return { value: undefined, present: false, uncertain: false };
		if (!("value" in d)) return { value: undefined, present: false, uncertain: true };
		if (!d.enumerable) return { value: d.value, present: true, uncertain: false };
		return { value: d.value, present: true, uncertain: false };
	};

	const ed = getDataValue("effect");
	const sd = getDataValue("store");

	let symbolUncertain = false;
	try {
		const symbolKeys = Object.getOwnPropertySymbols(raw);
		for (const sym of symbolKeys) {
			const d = Object.getOwnPropertyDescriptor(raw, sym);
			if (!d || !("value" in d)) {
				symbolUncertain = true;
				continue;
			}
			if ((typeof d.value === "object" && d.value !== null) || typeof d.value === "function") {
				if (types.isProxy(d.value)) symbolUncertain = true;
			}
		}
	} catch {
		symbolUncertain = true;
	}

	const ownershipUncertain = symbolUncertain || ed.uncertain || sd.uncertain;
	return Object.freeze({
		effect: ed.present ? ed.value : undefined,
		store: sd.present ? sd.value : undefined,
		ownershipUncertain,
	});
}

// ===========================================================================
// Capture all known owners
// ===========================================================================

interface AllOwnersResult {
	readonly owners: readonly OwnedSlot[];
	readonly anyAlias: boolean;
	readonly anyAccessorUncertain: boolean;
}

function captureAllOwners(raw: unknown): AllOwnersResult {
	const owners: OwnedSlot[] = [];
	const objectSet = new Set<object>();
	let anyAlias = false;
	let anyAccessorUncertain = false;

	if (typeof raw !== "object" || raw === null) {
		return Object.freeze({ owners: [], anyAlias: false, anyAccessorUncertain: false });
	}
	try {
		if (types.isProxy(raw)) {
			return Object.freeze({ owners: [], anyAlias: false, anyAccessorUncertain: true });
		}
	} catch {
		return Object.freeze({ owners: [], anyAlias: false, anyAccessorUncertain: true });
	}

	let ownDescs: Record<string, PropertyDescriptor>;
	try {
		ownDescs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return Object.freeze({ owners: [], anyAlias: false, anyAccessorUncertain: true });
	}

	const maybeAddOwner = (val: unknown): void => {
		if (typeof val !== "object" || val === null) return;
		if (Array.isArray(val)) return;

		const slot = captureOwnedClose(val);
		if (!slot) {
			if (hasCapabilityUncertainty(val)) anyAccessorUncertain = true;
			if (hasProxyCloseFunction(val)) anyAccessorUncertain = true;
			return;
		}

		if (objectSet.has(slot.object)) {
			anyAlias = true;
			return;
		}
		objectSet.add(slot.object);
		owners.push(slot);
	};

	for (const name of Object.getOwnPropertyNames(ownDescs)) {
		const d = ownDescs[name];
		if (!d) continue;
		if (!("value" in d)) {
			anyAccessorUncertain = true;
			continue;
		}
		maybeAddOwner(d.value);
	}

	return Object.freeze({ owners, anyAlias, anyAccessorUncertain });
}

// ===========================================================================
// Own-descriptor uncertainty monitor
// ===========================================================================

interface OwnDescMonitorResult {
	readonly anyAccessor: boolean;
}

function scanOwnDescUncertainty(raw: unknown): OwnDescMonitorResult {
	const result: OwnDescMonitorResult = Object.freeze({ anyAccessor: false });
	if (typeof raw !== "object" || raw === null) return result;
	try {
		if (types.isProxy(raw)) return Object.freeze({ anyAccessor: true });
	} catch {
		return Object.freeze({ anyAccessor: true });
	}
	try {
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of Object.getOwnPropertyNames(descs)) {
			const d = descs[name];
			if (d && !("value" in d)) {
				return Object.freeze({ anyAccessor: true });
			}
		}
	} catch {
		return Object.freeze({ anyAccessor: true });
	}
	return result;
}

// ===========================================================================
// Reverse sequential close
// ===========================================================================

async function closeAllReverse(closes: readonly OwnedClose[]): Promise<boolean> {
	for (let index = closes.length - 1; index >= 0; index -= 1) {
		let ok = false;
		try {
			ok = await closes[index]();
		} catch {
			ok = false;
		}
		if (!ok) return false;
	}
	return true;
}

// ===========================================================================
// Store-result helpers
// ===========================================================================

function isStoreOkResult(observation: PromiseObservation): boolean {
	if (!observation.fulfilled) return false;
	const d = exact(observation.value, STORE_OK_KEYS);
	return d !== null && value(d, "ok") === true;
}

// ===========================================================================
// Replay-result unwrap — pageObs.value is {ok:true, value: page}.
// Extract the inner page object from a confirmed-ok observation.
// ===========================================================================

function extractStoreValue(obs: PromiseObservation): unknown {
	if (!obs.fulfilled) return undefined;
	const d = exact(obs.value, STORE_OK_KEYS);
	if (d === null || value(d, "ok") !== true) return undefined;
	return value(d, "value");
}

// ===========================================================================
// Bind store methods into a snapshot (BoundStore)
// ===========================================================================

function bindStore(raw: object): BoundStore | null {
	let ownDescs: Record<string, PropertyDescriptor>;
	try {
		ownDescs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}

	const admit = bindMethod(raw, ownDescs.admit);
	const markStarted = bindMethod(raw, ownDescs.markStarted);
	const markCompleted = bindMethod(raw, ownDescs.markCompleted);
	const markInterrupted = bindMethod(raw, ownDescs.markInterrupted);
	const query = bindMethod(raw, ownDescs.query);
	const replayPending = bindMethod(raw, ownDescs.replayPending);

	if (!admit || !markStarted || !markCompleted || !markInterrupted || !query || !replayPending) {
		return null;
	}

	return Object.freeze({ admit, markStarted, markCompleted, markInterrupted, query, replayPending });
}

// ===========================================================================
// Bind effect execute into a snapshot
// ===========================================================================

function bindEffect(raw: object): BoundEffect | null {
	let ownDescs: Record<string, PropertyDescriptor>;
	try {
		ownDescs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}

	const execute = bindMethod(raw, ownDescs.execute);
	if (!execute) return null;

	return Object.freeze({ execute });
}

// ===========================================================================
// callSyncEffect — synchronously execute the branded effect, capture handle
// WITHOUT wrapping in Promise.resolve (no thenable assimilation).
// Immediately markStarted, then validate the handle object.
// ===========================================================================

async function callSyncEffect(
	boundExecute: BoundMethod,
	frame: unknown,
	commandId: string,
	boundMarkStarted: BoundMethod,
): Promise<
	| { readonly kind: "ok"; readonly completion: unknown }
	| { readonly kind: "throw" }
	| { readonly kind: "error" }
	| { readonly kind: "invalid_after_start" }
> {
	// Call execute synchronously — capture raw return value or thrown exception
	let executeResult: unknown;
	let threw = false;
	try {
		executeResult = boundExecute(frame);
	} catch {
		threw = true;
	}

	// IMMEDIATELY call markStarted — no microtask gap between execute and start
	const startObs = await invoke(() =>
		boundMarkStarted(Object.freeze({ commandId, recordedAt: new Date().toISOString() })),
	);
	if (!isStoreOkResult(startObs)) {
		return { kind: "error" };
	}

	if (threw) {
		return { kind: "throw" };
	}

	// Validate handle synchronously — no Promise wrapping of executeResult
	if (typeof executeResult !== "object" || executeResult === null) {
		return { kind: "invalid_after_start" };
	}

	// Validate exact {commandId, completion} via descriptors
	const handleDesc = exact(executeResult, HANDLE_KEYS);
	if (handleDesc === null) {
		return { kind: "invalid_after_start" };
	}

	// Require handle.commandId === input commandId
	const handleCommandId = value(handleDesc, "commandId");
	if (handleCommandId !== commandId) {
		return { kind: "invalid_after_start" };
	}

	const completionValue = value(handleDesc, "completion");

	return { kind: "ok", completion: completionValue };
}

// ===========================================================================
// Query terminal after admit — checks if the command is already terminal.
// Returns {terminal: true} if same-body completed/interrupted.
// Returns {terminal: false} if pending (should execute).
// Returns {terminal: false} if started (unexpected — error, no reexec).
// Returns undefined if query fails.
// ===========================================================================

async function queryTerminalAfterAdmit(
	boundQuery: BoundMethod,
	commandId: string,
): Promise<{ readonly kind: "terminal" | "pending" | "started" } | undefined> {
	const queryObs = await invoke(() => boundQuery(commandId));
	const queryValue = extractStoreValue(queryObs);
	if (queryValue === undefined) return undefined;
	if (typeof queryValue !== "object" || queryValue === null) return undefined;

	let stateDesc: PropertyDescriptor | undefined;
	try {
		stateDesc = Object.getOwnPropertyDescriptor(queryValue, "state");
	} catch {
		return undefined;
	}
	if (!stateDesc || !("value" in stateDesc)) return undefined;
	const state = stateDesc.value;

	if (state === "completed" || state === "interrupted") {
		return { kind: "terminal" };
	}
	if (state === "started") {
		// Unexpected started — reject
		return { kind: "started" };
	}
	// pending
	return { kind: "pending" };
}

// ===========================================================================
// Apply context
// ===========================================================================

const applyContext = new AsyncLocalStorage<SandboxCommandApplicationImpl>();

// ===========================================================================
// Application implementation
// ===========================================================================

class SandboxCommandApplicationImpl {
	private readonly _boundEffect: BoundEffect;
	private readonly _boundStore: BoundStore;
	private readonly _ownedCloses: readonly OwnedClose[];
	private _tail: Promise<void> = Promise.resolve();
	private _closePromise: Promise<SandboxCommandCloseResult> | null = null;
	private _closed = false;
	private _poisoned = false;

	constructor(
		boundEffect: BoundEffect,
		boundStore: BoundStore,
		ownedCloses: readonly OwnedClose[],
	) {
		this._boundEffect = boundEffect;
		this._boundStore = boundStore;
		this._ownedCloses = ownedCloses;
	}

	async apply(raw: unknown): Promise<SandboxCommandApplyResult> {
		if (applyContext.getStore() === this) {
			return errorResult();
		}
		if (this._closed) return errorResult();
		if (this._poisoned) return errorResult();

		const d = exact(raw, APPLY_INPUT_KEYS);
		if (!d) return errorResult();
		const envelopeValue = value(d, "envelope");

		const decoded = decodeEnvelope(envelopeValue);
		if (!decoded.ok) return this._poison();

		const envelope = decoded.value;
		if (envelope.frame.type !== "command") return errorResult();

		return this._enqueue(() => this._applyOrdered(envelope));
	}

	private _enqueue(
		operation: () => Promise<SandboxCommandApplyResult>,
	): Promise<SandboxCommandApplyResult> {
		const attempted = this._tail.then(
			() => {
				if (this._poisoned) return errorResult();
				return applyContext.run(this, operation);
			},
			() => {
				this._poisoned = true;
				return errorResult();
			},
		);
		const result = attempted.then(
			(v) => v,
			() => {
				this._poisoned = true;
				return errorResult();
			},
		);
		this._tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async _applyOrdered(envelope: RemoteHostFrameEnvelope): Promise<SandboxCommandApplyResult> {
		if (this._poisoned) return errorResult();

		const frame = envelope.frame;
		if (frame.type !== "command") return errorResult();
		const commandId = frame.commandId;

		// 1. Durable admit first (idempotent/collision check)
		const recordedAt = new Date().toISOString();
		const admitInput: Record<string, unknown> = Object.freeze({
			command: Object.freeze({ type: "command", commandId, body: frame.body }),
			recordedAt,
		});
		const admitObs = await invoke(() => this._boundStore.admit(admitInput));
		if (!isStoreOkResult(admitObs)) return this._poison();

		// 2. Query after admit — same-body terminal returns applied;
		// pending executes; unexpected started => error (no reexec).
		const qResult = await queryTerminalAfterAdmit(this._boundStore.query, commandId);
		if (qResult === undefined) return this._poison();
		if (qResult.kind === "terminal") return appliedResult();
		if (qResult.kind === "started") return this._poison();

		// 3. callSyncEffect — sync execute, immediately markStarted
		const syncResult = await callSyncEffect(
			this._boundEffect.execute, frame, commandId, this._boundStore.markStarted,
		);
		if (syncResult.kind === "error") {
			return this._poison();
		}

		if (syncResult.kind === "throw") {
			// markStarted succeeded. Persist interruption.
			const intObs = await invoke(() =>
				this._boundStore.markInterrupted(
					Object.freeze({ commandId, outcome: "INTERRUPTED", recordedAt: new Date().toISOString() }),
				),
			);
			if (!isStoreOkResult(intObs)) return this._poison();
			return appliedResult();
		}

		if (syncResult.kind === "invalid_after_start") {
			// markStarted succeeded but handle is invalid. Durable interrupt.
			const intObs = await invoke(() =>
				this._boundStore.markInterrupted(
					Object.freeze({ commandId, outcome: "INTERRUPTED", recordedAt: new Date().toISOString() }),
				),
			);
			if (!isStoreOkResult(intObs)) return this._poison();
			return appliedResult();
		}

		// 4. Exact-observe completion from the validated handle
		const completionValue = syncResult.completion;
		const completionObs = await observePromise(completionValue);

		// 5. Persist terminal state — must succeed
		const terminalAt = new Date().toISOString();
		const effectOk = completionObs.fulfilled && (() => {
			const d = exact(completionObs.value, new Set(["ok"]));
			return d !== null && value(d, "ok") === true;
		})();

		if (effectOk) {
			const writeObs = await invoke(() =>
				this._boundStore.markCompleted(Object.freeze({ commandId, recordedAt: terminalAt })),
			);
			if (!isStoreOkResult(writeObs)) return this._poison();
		} else {
			const writeObs = await invoke(() =>
				this._boundStore.markInterrupted(
					Object.freeze({ commandId, outcome: "INTERRUPTED", recordedAt: terminalAt }),
				),
			);
			if (!isStoreOkResult(writeObs)) return this._poison();
		}

		return appliedResult();
	}

	// -----------------------------------------------------------------------
	// Close
	// -----------------------------------------------------------------------

	close(): Promise<SandboxCommandCloseResult> {
		if (applyContext.getStore() === this) {
			return Promise.resolve(closeErrorResult());
		}
		if (this._closePromise !== null) return this._closePromise;
		this._closed = true;

		const shared: Promise<SandboxCommandCloseResult> = this._tail.then(
			() => this._closeOrdered(),
			() => this._closeOrdered(),
		);
		this._closePromise = shared;
		this._tail = shared.then(
			() => undefined,
			() => undefined,
		);
		return shared;
	}

	private async _closeOrdered(): Promise<SandboxCommandCloseResult> {
		const ok = await closeAllReverse(this._ownedCloses);
		return ok ? closedResult() : closeErrorResult();
	}

	private _poison(): SandboxCommandApplyResult {
		this._poisoned = true;
		return errorResult();
	}
}

// ===========================================================================
// Replay pending commands — bound methods only, no fire-forget
// ===========================================================================

async function replayPending(
	boundStore: BoundStore,
	boundEffect: BoundEffect,
): Promise<boolean> {
	let cursor: number | null = null;
	let hasMore = true;
	let totalPages = 0;

	while (hasMore) {
		totalPages += 1;
		if (totalPages > MAX_REPLAY_RANGE) return false;

		// Validate cursor is number or null (strict)
		if (cursor !== null && (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)) {
			return false;
		}

		// Strict progress: cursor must advance
		const prevCursor = cursor;

		const pageObs = await invoke(() => boundStore.replayPending(cursor, 64));
		const pageValue = extractStoreValue(pageObs);
		if (pageValue === undefined) return false;
		if (typeof pageValue !== "object" || pageValue === null) return false;

		let entriesDesc: PropertyDescriptor | undefined;
		try {
			entriesDesc = Object.getOwnPropertyDescriptor(pageValue, "entries");
		} catch {
			return false;
		}
		if (!entriesDesc || !("value" in entriesDesc)) return false;
		const entries = entriesDesc.value;
		if (!Array.isArray(entries)) return false;

		// Reject empty page with non-null cursor (no progress)
		if (entries.length === 0 && cursor !== null) return false;

		for (const entry of entries) {
			if (typeof entry !== "object" || entry === null) return false;

			let recordDesc: PropertyDescriptor | undefined;
			try {
				recordDesc = Object.getOwnPropertyDescriptor(entry, "record");
			} catch {
				return false;
			}
			if (!recordDesc || !("value" in recordDesc)) return false;
			const record = recordDesc.value;
			if (typeof record !== "object" || record === null) return false;

			let recordKindDesc: PropertyDescriptor | undefined;
			try {
				recordKindDesc = Object.getOwnPropertyDescriptor(record, "recordKind");
			} catch {
				return false;
			}
			if (!recordKindDesc || !("value" in recordKindDesc)) return false;
			// Reject non-pending records atomically
			if (recordKindDesc.value !== "pending") return false;

			let commandIdDesc: PropertyDescriptor | undefined;
			try {
				commandIdDesc = Object.getOwnPropertyDescriptor(record, "commandId");
			} catch {
				return false;
			}
			if (!commandIdDesc || !("value" in commandIdDesc)) return false;
			const commandId = commandIdDesc.value;
			if (typeof commandId !== "string") return false;

			let commandDesc: PropertyDescriptor | undefined;
			try {
				commandDesc = Object.getOwnPropertyDescriptor(record, "command");
			} catch {
				return false;
			}
			if (!commandDesc || !("value" in commandDesc)) return false;
			const command = commandDesc.value;

			// All pending commands go through effect
			const syncResult = await callSyncEffect(
				boundEffect.execute, command, commandId, boundStore.markStarted,
			);
			if (syncResult.kind === "error") return false;

			if (syncResult.kind === "throw" || syncResult.kind === "invalid_after_start") {
				// markStarted succeeded. Durable interrupt.
				const intObs = await invoke(() =>
					boundStore.markInterrupted(
						Object.freeze({ commandId, outcome: "INTERRUPTED", recordedAt: new Date().toISOString() }),
					),
				);
				if (!isStoreOkResult(intObs)) return false;
				continue;
			}

			// Await completion — no fire-forget
			const terminalObs = await observePromise(syncResult.completion);
			const terminalAt = new Date().toISOString();

			const settledOk = terminalObs.fulfilled && (() => {
				const d = exact(terminalObs.value, new Set(["ok"]));
				return d !== null && value(d, "ok") === true;
			})();

			if (settledOk) {
				const writeObs = await invoke(() =>
					boundStore.markCompleted(Object.freeze({ commandId, recordedAt: terminalAt })),
				);
				if (!isStoreOkResult(writeObs)) return false;
			} else {
				const writeObs = await invoke(() =>
					boundStore.markInterrupted(
						Object.freeze({ commandId, outcome: "INTERRUPTED", recordedAt: terminalAt }),
					),
				);
				if (!isStoreOkResult(writeObs)) return false;
			}
		}

		let cursorDesc: PropertyDescriptor | undefined;
		try {
			cursorDesc = Object.getOwnPropertyDescriptor(pageValue, "nextCursor");
		} catch {
			return false;
		}
		if (!cursorDesc || !("value" in cursorDesc)) return false;
		const nc = cursorDesc.value;
		hasMore = nc !== null;

		// Strict progress: cursor must advance or remain null (end)
		if (hasMore) {
			if (typeof nc !== "number" || !Number.isInteger(nc) || nc < 0) return false;
			if (prevCursor !== null && nc <= prevCursor) return false; // cycle detection
			cursor = nc;
		} else {
			cursor = null;
		}
	}
	return true;
}

// ===========================================================================
// Factory
// ===========================================================================

export async function createSandboxCommandApplication(
	raw: unknown,
): Promise<CreateSandboxCommandApplicationResult> {
	if (typeof raw !== "object" || raw === null) {
		return invalidArgumentError();
	}

	const allOwners = captureAllOwners(raw);
	const prelim = extractPreliminary(raw);
	const factoryDescMonitor = scanOwnDescUncertainty(raw);

	const slotUncertain =
		hasCapabilityUncertainty(prelim.effect) ||
		hasCapabilityUncertainty(prelim.store) ||
		hasProxyCloseFunction(prelim.effect) ||
		hasProxyCloseFunction(prelim.store);

	const totalUncertain =
		prelim.ownershipUncertain || slotUncertain || allOwners.anyAccessorUncertain || factoryDescMonitor.anyAccessor;

	const closeList = [...allOwners.owners.map((s) => s.close)];

	const inputDescriptors = exact(raw, FACTORY_KEYS);
	if (!inputDescriptors) {
		const allClosed = await closeAllReverse(closeList);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	// Logical dependency order: store before effect (reverse close = effect first)
	const storeOwned = captureOwnedClose(prelim.store);
	const effectOwned = captureOwnedClose(prelim.effect);

	const rawObjectSet = new Set<object>();
	const mergedCloses: OwnedClose[] = [];

	for (const s of allOwners.owners) {
		if (rawObjectSet.has(s.object)) continue;
		rawObjectSet.add(s.object);
		mergedCloses.push(s.close);
	}

	for (const slot of [storeOwned, effectOwned]) {
		if (slot === null) continue;
		if (rawObjectSet.has(slot.object)) continue;
		rawObjectSet.add(slot.object);
		mergedCloses.push(slot.close);
	}

	const allOwned = storeOwned !== null && effectOwned !== null;

	const namedObjectSet = new Set<object>();
	let hasAlias = false;
	for (const slot of [storeOwned, effectOwned]) {
		if (slot === null) continue;
		if (namedObjectSet.has(slot.object)) hasAlias = true;
		namedObjectSet.add(slot.object);
	}
	if (allOwners.anyAlias) hasAlias = true;

	if (!allOwned || hasAlias) {
		const allClosed = await closeAllReverse(mergedCloses);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	const effectValue = value(inputDescriptors, "effect");
	const storeValue = value(inputDescriptors, "store");

	if (!isSandboxCommandEffectInstance(effectValue) || !isSandboxCommandStoreInstance(storeValue)) {
		const allClosed = await closeAllReverse(mergedCloses);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	const brandedEffect: SandboxCommandEffectCapability = effectValue;
	const brandedStore: SandboxCommandStoreCapability = storeValue;

	const boundEffect = bindEffect(brandedEffect);
	const boundStore = bindStore(brandedStore);
	if (!boundEffect || !boundStore) {
		const allClosed = await closeAllReverse(mergedCloses);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	// Normal close order: store first, effect second.
	// Reverse close (done by closeAllReverse) = effect first, store last.
	const normalCloses: readonly OwnedClose[] = Object.freeze([
		storeOwned.close,
		effectOwned.close,
	]);

	const replayOk = await replayPending(boundStore, boundEffect);
	if (!replayOk) {
		// Use normalCloses — correct dependency order (reverse = effect, store)
		const allClosed = await closeAllReverse(normalCloses);
		if (!allClosed) return closeUncertainError();
		if (totalUncertain) return closeUncertainError();
		return recoveryFailedError();
	}

	const impl = new SandboxCommandApplicationImpl(boundEffect, boundStore, normalCloses);

	return successResult(
		Object.freeze({
			apply: (r: unknown): Promise<SandboxCommandApplyResult> => impl.apply(r),
			close: (): Promise<SandboxCommandCloseResult> => impl.close(),
		}),
	);
}
