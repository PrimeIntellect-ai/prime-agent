import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";

// ===========================================================================
// All-or-nothing module capture closure
// ===========================================================================

// Runtime-verify Promise.prototype is an ordinary frozen-like object (non-Proxy,
// Object.prototype [[Prototype]], data-only own properties on `then`).
const $PromiseProto: object = (() => {
	const pp = Promise.prototype;
	// 1. Not null/undefined (guaranteed by spec but check anyway)
	if (typeof pp !== "object" || pp === null) {
		throw new Error("RelayGate: Promise.prototype missing");
	}
	// 2. Not a Proxy
	try {
		if (types.isProxy(pp)) {
			throw new Error("RelayGate: Promise.prototype is a Proxy");
		}
	} catch {
		throw new Error("RelayGate: isProxy check threw");
	}
	// 3. [[Prototype]] is Object.prototype (ordinary)
	try {
		if (Object.getPrototypeOf(pp) !== Object.prototype) {
			throw new Error("RelayGate: Promise.prototype [[Prototype]] not Object.prototype");
		}
	} catch {
		throw new Error("RelayGate: getPrototypeOf threw");
	}
	return pp;
})();

// Capture Promise.prototype.then as a data-descriptor non-Proxy function.
const $PromiseThen = (() => {
	const desc: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor($PromiseProto, "then");
	if (!desc) {
		throw new Error("RelayGate: Promise.prototype.then descriptor missing");
	}
	if (!("value" in desc)) {
		throw new Error("RelayGate: Promise.prototype.then is not a data descriptor");
	}
	const fn: unknown = desc.value;
	if (typeof fn !== "function") {
		throw new Error("RelayGate: Promise.prototype.then is not a function");
	}
	try {
		if (types.isProxy(fn)) {
			throw new Error("RelayGate: Promise.prototype.then is a Proxy");
		}
	} catch {
		throw new Error("RelayGate: isProxy threw on then");
	}
	return fn;
})();

// ===========================================================================
// Result types
// ===========================================================================

export type GateApplyResult = Readonly<{ readonly status: "applied" }> | Readonly<{ readonly status: "error" }>;

export type GateCloseResult = Readonly<{ readonly status: "closed" }> | Readonly<{ readonly status: "error" }>;

export type CreateGateBindResult =
	| Readonly<{ readonly ok: true }>
	| Readonly<{
			readonly ok: false;
			readonly error: Readonly<{ readonly code: "INVALID_ARGUMENT" }>;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly error: Readonly<{ readonly code: "CLOSE_UNCERTAIN" }>;
	  }>;

export type CreateGateResult =
	| Readonly<{
			readonly ok: true;
			readonly application: Readonly<{
				readonly apply: (raw: unknown) => Promise<GateApplyResult>;
				readonly close: () => Promise<GateCloseResult>;
			}>;
			readonly bind: (rawApplication: unknown) => Promise<CreateGateBindResult>;
	  }>
	| Readonly<{
			readonly ok: false;
			readonly error: Readonly<{ readonly code: "INVALID_ARGUMENT" }>;
	  }>;

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

// ===========================================================================
// Fresh result builders (no shared module constants)
// ===========================================================================

function freshAppliedResult(): GateApplyResult {
	return Object.freeze({ status: "applied" });
}

function freshApplyErrorResult(): GateApplyResult {
	return Object.freeze({ status: "error" });
}

function freshClosedResult(): GateCloseResult {
	return Object.freeze({ status: "closed" });
}

function freshCloseErrorResult(): GateCloseResult {
	return Object.freeze({ status: "error" });
}

function freshBindOkResult(): CreateGateBindResult {
	return Object.freeze({ ok: true });
}

function freshBindInvalidArgumentResult(): CreateGateBindResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code: "INVALID_ARGUMENT" }),
	});
}

function freshBindCloseUncertainResult(): CreateGateBindResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code: "CLOSE_UNCERTAIN" }),
	});
}

function freshGateInvalidArgumentResult(): CreateGateResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code: "INVALID_ARGUMENT" }),
	});
}

// ===========================================================================
// Typed owned Promise wrappers (no Promise.resolve, no Reflect.apply casts)
// ===========================================================================

function ignoreRejection<T>(promise: Promise<T>): Promise<void> {
	return new Promise<void>((resolve: (v: undefined) => void, reject: (e: unknown) => void) => {
		try {
			Reflect.apply($PromiseThen, promise, [
				function (this: unknown): void {
					resolve(undefined);
				},
				function (this: unknown): void {
					resolve(undefined);
				},
			]);
		} catch (e: unknown) {
			reject(e);
		}
	});
}

// ===========================================================================
// Descriptor helpers
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
// Exact shape validation
// ===========================================================================

function rawDescriptors(raw: unknown): Descriptors | null {
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
	const names = Object.getOwnPropertyNames(descriptors);
	if (names.length !== keys.size || names.some((name: string): boolean => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return descriptors;
}

// ===========================================================================
// Result descriptor validation (no live reads)
// ===========================================================================

function validateSingleStatusDescriptor(raw: unknown, validStatuses: ReadonlySet<string>): string | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(descs);
		if (names.length !== 1) return null;
		if (names[0] !== "status") return null;
		const desc = descs.status;
		if (!desc || !("value" in desc) || !desc.enumerable) return null;
		if (typeof desc.value !== "string") return null;
		if (!validStatuses.has(desc.value)) return null;
		return desc.value;
	} catch {
		return null;
	}
}

// ===========================================================================
// Exact native Promise enforcement (compares captured prototype)
// ===========================================================================

function isExactNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
		if (!types.isPromise(raw)) return false;
		if (Object.getPrototypeOf(raw) !== $PromiseProto) return false;
		if (Object.getOwnPropertyNames(raw).length !== 0) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

// ===========================================================================
// Promise observation (typed owned wrapper, no Promise.resolve)
// ===========================================================================

type PromiseObservation = { readonly fulfilled: true; readonly value: unknown } | { readonly fulfilled: false };

function observePromise(raw: unknown): Promise<PromiseObservation> {
	if (!isExactNativePromise(raw)) {
		return new Promise<PromiseObservation>((resolve: (v: PromiseObservation) => void) => {
			resolve({ fulfilled: false });
		});
	}
	return new Promise<PromiseObservation>((resolve: (v: PromiseObservation) => void) => {
		try {
			Reflect.apply($PromiseThen, raw, [
				function (this: unknown, v: unknown): void {
					resolve({ fulfilled: true, value: v });
				},
				function (this: unknown): void {
					resolve({ fulfilled: false });
				},
			]);
		} catch {
			resolve({ fulfilled: false });
		}
	});
}

function invoke(call: () => unknown): Promise<PromiseObservation> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return new Promise<PromiseObservation>((resolve: (v: PromiseObservation) => void) => {
			resolve({ fulfilled: false });
		});
	}
	return observePromise(raw);
}

// ===========================================================================
// Ownership / uncertainty helpers
// ===========================================================================

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
		const observation = await invoke((): unknown => Reflect.apply(closeFnValue, raw, []));
		if (!observation.fulfilled) return false;
		const statusValue = validateSingleStatusDescriptor(observation.value, new Set(["closed"]));
		return statusValue === "closed";
	};

	return Object.freeze({ object: raw, closeFn, close });
}

// ===========================================================================
// ALS for both apply and close reentry detection
// ===========================================================================

const gateContext = new AsyncLocalStorage<GateInstance>();

// ===========================================================================
// Constants
// ===========================================================================

const APPLICATION_KEYS: ReadonlySet<string> = Object.freeze(new Set(["apply", "close"]));
const APPLIED_STATUSES: ReadonlySet<string> = Object.freeze(new Set(["applied", "error"]));

// ===========================================================================
// Gate instance — one per factory call
// ===========================================================================

class GateInstance {
	private bindAttempted = false;
	private bound = false;
	private closed = false;
	private poisoned = false;
	private tail: Promise<void>;
	private closePromise: Promise<GateCloseResult> | null = null;
	private capturedClose: OwnedClose | null = null;
	private appApply: BoundMethod | null = null;

	constructor() {
		this.tail = new Promise<void>((resolve: (v: undefined) => void) => {
			resolve(undefined);
		});
	}

	// -----------------------------------------------------------------------
	// Bind (one-shot, async, terminal)
	// -----------------------------------------------------------------------

	async bind(rawApplication: unknown): Promise<CreateGateBindResult> {
		if (this.bindAttempted) return freshBindInvalidArgumentResult();
		this.bindAttempted = true;

		if (this.closed) return freshBindInvalidArgumentResult();

		const slot = captureOwnedClose(rawApplication);

		const descriptors = exact(rawApplication, APPLICATION_KEYS);
		if (!descriptors) {
			return this.failWithOwnerCleanup(slot);
		}

		if (!slot) {
			return freshBindInvalidArgumentResult();
		}

		const applyBound = bindMethod(rawApplication, descriptors.apply);
		if (!applyBound) {
			return this.failWithOwnerCleanup(slot);
		}

		this.bound = true;
		this.appApply = applyBound;
		this.capturedClose = slot.close;

		return freshBindOkResult();
	}

	// -----------------------------------------------------------------------
	// Bind failure cleanup — close provable owner and observe exact result
	// -----------------------------------------------------------------------

	private async failWithOwnerCleanup(slot: OwnedSlot | null): Promise<CreateGateBindResult> {
		if (!slot) return freshBindInvalidArgumentResult();
		let ok: boolean;
		try {
			ok = await slot.close();
		} catch {
			return freshBindCloseUncertainResult();
		}
		if (!ok) return freshBindCloseUncertainResult();
		return freshBindInvalidArgumentResult();
	}

	// -----------------------------------------------------------------------
	// Apply
	// -----------------------------------------------------------------------

	async apply(raw: unknown): Promise<GateApplyResult> {
		if (gateContext.getStore() === this) {
			return freshApplyErrorResult();
		}
		if (!this.bound) return freshApplyErrorResult();
		if (this.closed) return freshApplyErrorResult();
		if (this.poisoned) return freshApplyErrorResult();

		return this.enqueue((): Promise<GateApplyResult> => this.applyOrdered(raw));
	}

	private async applyOrdered(raw: unknown): Promise<GateApplyResult> {
		if (this.poisoned) return freshApplyErrorResult();
		const bound = this.appApply;
		if (!bound) return freshApplyErrorResult();

		let rawResult: unknown;
		try {
			rawResult = gateContext.run(this, (): unknown => bound(raw));
		} catch {
			return this.poison();
		}

		const observation = await observePromise(rawResult);
		if (!observation.fulfilled) return this.poison();

		if (this.poisoned) return freshApplyErrorResult();

		const statusValue = validateSingleStatusDescriptor(observation.value, APPLIED_STATUSES);
		if (!statusValue) return this.poison();

		if (statusValue === "error") {
			return this.poison();
		}

		return freshAppliedResult();
	}

	// -----------------------------------------------------------------------
	// Serialization (global FIFO via owned chain)
	// -----------------------------------------------------------------------

	private enqueue(operation: () => Promise<GateApplyResult>): Promise<GateApplyResult> {
		const attempted: Promise<GateApplyResult> = new Promise<GateApplyResult>(
			(resolve: (v: GateApplyResult | Promise<GateApplyResult>) => void, reject: (e: unknown) => void): void => {
				try {
					Reflect.apply($PromiseThen, this.tail, [
						(): void => {
							try {
								if (this.poisoned) {
									resolve(freshApplyErrorResult());
									return;
								}
								resolve(operation());
							} catch (e: unknown) {
								reject(e);
							}
						},
						(): void => {
							this.poisoned = true;
							resolve(freshApplyErrorResult());
						},
					]);
				} catch (e: unknown) {
					reject(e);
				}
			},
		);

		const result: Promise<GateApplyResult> = new Promise<GateApplyResult>(
			(resolve: (v: GateApplyResult) => void, reject: (e: unknown) => void): void => {
				try {
					Reflect.apply($PromiseThen, attempted, [
						(v: GateApplyResult): void => {
							resolve(v);
						},
						(): void => {
							this.poisoned = true;
							resolve(freshApplyErrorResult());
						},
					]);
				} catch (e: unknown) {
					reject(e);
				}
			},
		);

		this.tail = ignoreRejection(result);

		return result;
	}

	// -----------------------------------------------------------------------
	// Close (fenced, FIFO-draining, cached, nonrejecting)
	// -----------------------------------------------------------------------

	close(): Promise<GateCloseResult> {
		if (gateContext.getStore() === this) {
			return new Promise<GateCloseResult>((resolve: (v: GateCloseResult) => void) => {
				resolve(freshCloseErrorResult());
			});
		}
		if (this.closePromise !== null) return this.closePromise;

		this.closed = true;

		const shared: Promise<GateCloseResult> = new Promise<GateCloseResult>(
			(resolve: (v: GateCloseResult) => void, reject: (e: unknown) => void): void => {
				try {
					Reflect.apply($PromiseThen, this.tail, [
						(): void => {
							const p: Promise<GateCloseResult> = gateContext.run(
								this,
								(): Promise<GateCloseResult> => this.closeOrdered(),
							);
							Reflect.apply($PromiseThen, p, [resolve, reject]);
						},
						(): void => {
							const p: Promise<GateCloseResult> = gateContext.run(
								this,
								(): Promise<GateCloseResult> => this.closeOrdered(),
							);
							Reflect.apply($PromiseThen, p, [resolve, reject]);
						},
					]);
				} catch (e: unknown) {
					reject(e);
				}
			},
		);

		this.closePromise = shared;
		this.tail = ignoreRejection(shared);

		return shared;
	}

	private async closeOrdered(): Promise<GateCloseResult> {
		if (this.capturedClose === null) {
			return freshClosedResult();
		}
		const ok = await this.capturedClose();
		return ok ? freshClosedResult() : freshCloseErrorResult();
	}

	// -----------------------------------------------------------------------
	// Poison
	// -----------------------------------------------------------------------

	private poison(): GateApplyResult {
		this.poisoned = true;
		return freshApplyErrorResult();
	}
}

// ===========================================================================
// Factory — validates exact empty {} and returns {application, bind}
// ===========================================================================

function isEmptyOrdinaryObject(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
		if (Object.getPrototypeOf(raw) !== Object.prototype) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

export async function createRelayApplicationGate(raw: unknown): Promise<CreateGateResult> {
	if (!isEmptyOrdinaryObject(raw)) {
		return freshGateInvalidArgumentResult();
	}

	const instance = new GateInstance();

	const application: Readonly<{
		readonly apply: (raw: unknown) => Promise<GateApplyResult>;
		readonly close: () => Promise<GateCloseResult>;
	}> = Object.freeze({
		apply: (r: unknown): Promise<GateApplyResult> => instance.apply(r),
		close: (): Promise<GateCloseResult> => instance.close(),
	});

	const bind: (rawApplication: unknown) => Promise<CreateGateBindResult> = Object.freeze(
		(rawApplication: unknown): Promise<CreateGateBindResult> => instance.bind(rawApplication),
	);

	const result: CreateGateResult = Object.freeze({
		ok: true,
		application,
		bind,
	});

	return result;
}
