import { types } from "node:util";
import {
	createHostedRlmRuntimePort,
	type HostedRlmAbortResult,
	type HostedRlmObservationSnapshot,
	type HostedRlmPortResult,
	type HostedRlmRuntimeEvent,
	type HostedRlmRuntimeIdentity,
	type HostedRlmRuntimePort,
	type HostedRlmTaskResult,
	type HostedRlmUnsubscribeResult,
} from "./hosted-rlm-runtime-port.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HostedRlmRunControllerInput {
	readonly port: HostedRlmRuntimePort;
	readonly expectedIdentity: HostedRlmRuntimeIdentity;
	readonly listener?: (event: HostedRlmRuntimeEvent) => void;
}

export type CreateHostedRlmRunControllerResult =
	| Readonly<{ ok: true; value: HostedRlmRunController }>
	| Readonly<{
			ok: false;
			code: "IDENTITY_MISMATCH" | "INVALID_INPUT" | "CLEANUP_UNCERTAIN";
	  }>;

export interface HostedRlmRunController {
	readonly identity: HostedRlmRuntimeIdentity;
	readonly start: (input: { prompt: string; spawnCode?: string }) => Promise<HostedRlmPortResult<HostedRlmTaskResult>>;
	readonly requestAbort: () => Promise<HostedRlmPortResult<HostedRlmAbortResult>>;
	readonly finish: () => Promise<HostedRlmPortResult<HostedRlmTaskResult>>;
	readonly observe: () => Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT_KEYS = new Set(["identity", "startInitialTask", "abort", "observe", "subscribe"]);
const IDENTITY_KEYS = new Set(["childId", "sessionId", "sessionName", "modelSelector"]);
const UNSUBSCRIBE_KEYS = new Set(["unsubscribe"]);

const OPERATION_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonProxyFunction(value: unknown): value is (...args: unknown[]) => unknown {
	if (typeof value !== "function") return false;
	try {
		return !types.isProxy(value);
	} catch {
		return false;
	}
}

function isNativePromise(value: unknown): value is Promise<unknown> {
	if (typeof value !== "object" || value === null) return false;
	try {
		if (types.isProxy(value)) return false;
	} catch {
		return false;
	}
	if (!types.isPromise(value)) return false;
	try {
		if (Object.getPrototypeOf(value) !== Promise.prototype) return false;
	} catch {
		return false;
	}
	if (Object.getOwnPropertyNames(value).length > 0) return false;
	if (Object.getOwnPropertySymbols(value).length > 0) return false;
	return true;
}

function exactRecord(raw: unknown, keys: ReadonlySet<string>): { readonly [key: string]: unknown } | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	try {
		if (Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size) return null;
		if (names.some((n) => !keys.has(n))) return null;
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const d = descs[name];
			if (!d || !("value" in d) || !d.enumerable) return null;
		}
		const result: { [key: string]: unknown } = {};
		for (const name of names) result[name] = descs[name].value;
		return result;
	} catch {
		return null;
	}
}

function isBoundedPrintableIdentifier(value: unknown): value is string {
	if (typeof value !== "string") return false;
	if (value.length === 0 || value.length > 128) return false;
	return /^[a-zA-Z0-9_./:-]{1,128}$/.test(value);
}

function extractIdentity(raw: unknown): HostedRlmRuntimeIdentity | null {
	const rec = exactRecord(raw, IDENTITY_KEYS);
	if (!rec) return null;
	const childId = rec.childId;
	const sessionId = rec.sessionId;
	const sessionName = rec.sessionName;
	const modelSelector = rec.modelSelector;
	if (
		!isBoundedPrintableIdentifier(childId) ||
		!isBoundedPrintableIdentifier(sessionId) ||
		!isBoundedPrintableIdentifier(sessionName) ||
		!isBoundedPrintableIdentifier(modelSelector)
	)
		return null;
	return Object.freeze({ childId, sessionId, sessionName, modelSelector });
}

function readOwnValue(obj: unknown, key: string): unknown {
	if (typeof obj !== "object" || obj === null) return undefined;
	try {
		if (types.isProxy(obj)) return undefined;
	} catch {
		return undefined;
	}
	try {
		const d = Object.getOwnPropertyDescriptor(obj, key);
		if (!d || !("value" in d) || !d.enumerable) return undefined;
		return d.value;
	} catch {
		return undefined;
	}
}

function readOwnFunction(obj: unknown, key: string): ((...args: unknown[]) => unknown) | undefined {
	const raw = readOwnValue(obj, key);
	if (typeof raw !== "function") return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
	} catch {
		return undefined;
	}
	return (...args: unknown[]): unknown => Reflect.apply(raw, obj, args);
}

/** Safely observe a native Promise via Reflect.apply(Promise.prototype.then, ...)
 *  with bound timeout. Returns {ok:true, value} on fulfillment or
 *  {ok:false, error:{code:"CALL_UNCERTAIN"}} on rejection/timeout. */
function observePromise(rawPromise: unknown, timeoutMs: number): Promise<HostedRlmPortResult<unknown>> {
	return new Promise<HostedRlmPortResult<unknown>>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}, timeoutMs);

		const onFulfilled = (value: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ ok: true as const, value }));
		};

		const onRejected = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		};

		Reflect.apply(Promise.prototype.then, rawPromise, [onFulfilled, onRejected]);
	});
}

/** Descriptor-parse a public port result ({ok:true,value} or {ok:false,error}).
 *  Returns {ok:true, rawValue} for the success case, or null for any
 *  non-ok/malformed case. Does NOT accept the undocumented three-key arm. */
function tryPortOkValue(raw: unknown): { ok: true; rawValue: unknown } | null {
	const withValue = exactRecord(raw, new Set(["ok", "value"]));
	if (withValue) {
		if (withValue.ok === true) return { ok: true, rawValue: withValue.value };
		return null;
	}
	const withError = exactRecord(raw, new Set(["ok", "error"]));
	if (withError) {
		return null;
	}
	return null;
}

/** Validate that a public port's unsubscribe result is exact {ok:true} (1 key)
 *  or {ok:false,error} (2 keys). Returns true for {ok:true}. */
function isPublicUnsubOk(raw: unknown): boolean {
	const okOnly = exactRecord(raw, new Set(["ok"]));
	if (okOnly && okOnly.ok === true) return true;
	return false;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHostedRlmRunController(input: unknown): CreateHostedRlmRunControllerResult {
	// Single descriptor pass for optional-listener validation
	const input3 = exactRecord(input, new Set(["port", "expectedIdentity", "listener"]));
	let inputRecord: { [key: string]: unknown };
	let hasListener: boolean;
	if (input3) {
		inputRecord = input3;
		hasListener = true;
	} else {
		const input2 = exactRecord(input, new Set(["port", "expectedIdentity"]));
		if (!input2) return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });
		inputRecord = input2;
		hasListener = false;
	}

	const rawPort = inputRecord.port;
	const rawExpected = inputRecord.expectedIdentity;

	// Validate port
	const portRecord = exactRecord(rawPort, PORT_KEYS);
	if (!portRecord) return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });

	const portIdentity = extractIdentity(portRecord.identity);
	if (!portIdentity) return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });

	const rawStart = portRecord.startInitialTask;
	const rawAbort = portRecord.abort;
	const rawObserve = portRecord.observe;
	const rawSubscribe = portRecord.subscribe;

	if (
		!isNonProxyFunction(rawStart) ||
		!isNonProxyFunction(rawAbort) ||
		!isNonProxyFunction(rawObserve) ||
		!isNonProxyFunction(rawSubscribe)
	)
		return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });

	// Validate expectedIdentity
	const expectedIdentity = extractIdentity(rawExpected);
	if (!expectedIdentity) return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });

	// Exact identity match
	if (
		portIdentity.childId !== expectedIdentity.childId ||
		portIdentity.sessionId !== expectedIdentity.sessionId ||
		portIdentity.sessionName !== expectedIdentity.sessionName ||
		portIdentity.modelSelector !== expectedIdentity.modelSelector
	)
		return Object.freeze({
			ok: false as const,
			code: "IDENTITY_MISMATCH" as const,
		});

	// Validate listener function once
	let capturedListener: ((rawEvent: unknown) => void) | undefined;
	if (hasListener) {
		const lr = inputRecord.listener;
		if (!isNonProxyFunction(lr)) return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });
		capturedListener = (rawEvent: unknown) => {
			try {
				Reflect.apply(lr, undefined, [rawEvent]);
			} catch {
				/* listener throw isolated */
			}
		};
	}

	// -----------------------------------------------------------------------
	// Adapter for createHostedRlmRuntimePort
	// -----------------------------------------------------------------------
	// Track subscribe backout outcome to distinguish INVALID_INPUT from
	// CLEANUP_UNCERTAIN at the factory level.
	let subscribeBackoutFailed = false;

	const adapterStart = (taskInput: unknown): unknown => {
		let rawResult: unknown;
		try {
			rawResult = Reflect.apply(rawStart, rawPort, [taskInput]);
		} catch {
			return safeUnwrapRejected();
		}
		return safeUnwrapPortPromise(rawResult, OPERATION_TIMEOUT_MS);
	};

	const adapterAbort = (): unknown => {
		let rawResult: unknown;
		try {
			rawResult = Reflect.apply(rawAbort, rawPort, []);
		} catch {
			return safeUnwrapRejected();
		}
		return safeUnwrapPortPromise(rawResult, OPERATION_TIMEOUT_MS);
	};

	const adapterObserve = (): unknown => {
		let rawResult: unknown;
		try {
			rawResult = Reflect.apply(rawObserve, rawPort, []);
		} catch {
			return safeUnwrapRejected();
		}
		return safeUnwrapPortPromise(rawResult, OPERATION_TIMEOUT_MS);
	};

	const adapterSubscribe = (callback: unknown): unknown => {
		let rawResult: unknown;
		try {
			rawResult = Reflect.apply(rawSubscribe, rawPort, [callback]);
		} catch {
			subscribeBackoutFailed = true;
			return null;
		}
		// Preliminarily acquire nested close before exact validation
		const rawOuterValue = readOwnValue(rawResult, "value");
		let prelimUnsub: (() => unknown) | undefined;
		if (rawOuterValue !== undefined) {
			const rawUnsubFn = readOwnFunction(rawOuterValue, "unsubscribe");
			if (rawUnsubFn !== undefined) {
				prelimUnsub = rawUnsubFn;
			}
		}

		// Validate outer exactness -- only {ok,value} or {ok,error} arms.
		const okValueRecord = exactRecord(rawResult, new Set(["ok", "value"]));
		const okErrorRecord = okValueRecord ? null : exactRecord(rawResult, new Set(["ok", "error"]));
		const outerRecord = okValueRecord ?? okErrorRecord;
		if (!outerRecord || outerRecord.ok !== true) {
			if (!okErrorRecord || okErrorRecord.ok !== false) backoutOrFlag(prelimUnsub);
			return null;
		}

		const rawValue = outerRecord.value;

		// Validate inner exact {unsubscribe}
		const innerRecord = exactRecord(rawValue, UNSUBSCRIBE_KEYS);
		if (!innerRecord) {
			backoutOrFlag(prelimUnsub);
			return null;
		}

		const publicUnsub = innerRecord.unsubscribe;
		if (!isNonProxyFunction(publicUnsub)) {
			backoutOrFlag(prelimUnsub);
			return null;
		}

		// Wrap the public unsubscribe to translate {ok:true} -> {status:"unsubscribed"}
		// so createHostedRlmRuntimePort's tryStatus validation succeeds.
		const wrappedUnsub = (): unknown => {
			let publicResult: unknown;
			try {
				publicResult = Reflect.apply(publicUnsub, rawValue, []);
			} catch {
				subscribeBackoutFailed = true;
				throw new Error();
			}
			if (isPublicUnsubOk(publicResult)) {
				return Object.freeze({ status: "unsubscribed" as const });
			}
			subscribeBackoutFailed = true;
			return Object.freeze({ status: "unknown" as const });
		};
		return Object.freeze({ unsubscribe: wrappedUnsub });

		// --- inner helper ---
		function backoutOrFlag(prelim: (() => unknown) | undefined): void {
			if (!prelim) {
				subscribeBackoutFailed = true;
				return;
			}
			let raw: unknown;
			try {
				raw = prelim();
			} catch {
				subscribeBackoutFailed = true;
				return;
			}
			if (!isPublicUnsubOk(raw)) subscribeBackoutFailed = true;
		}
	};

	const rawAdapter: { [key: string]: unknown } = {
		identity: portIdentity,
		startInitialTask: adapterStart,
		abort: adapterAbort,
		observe: adapterObserve,
		subscribe: adapterSubscribe,
	};

	const factoryResult = createHostedRlmRuntimePort(rawAdapter);
	if (!factoryResult.ok) {
		// Factory failed before subscribe was called on the adapter,
		// so subscribeBackoutFailed is still false here.
		return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });
	}

	const internalPort = factoryResult.value;

	// -----------------------------------------------------------------------
	// Controller lifecycle state
	// -----------------------------------------------------------------------

	let started = false;
	let startPromise: Promise<HostedRlmPortResult<HostedRlmTaskResult>> | null = null;
	let finishStarted = false;
	let finished = false;
	let abortAdmitted = false;
	let abortPromise: Promise<HostedRlmPortResult<HostedRlmAbortResult>> | null = null;
	let finishPromise: Promise<HostedRlmPortResult<HostedRlmTaskResult>> | null = null;
	let unsubscribed = false;

	let subUnsubscribe: (() => HostedRlmUnsubscribeResult) | null = null;

	// Always subscribe before start — internal no-op listener when user provides none
	const internalListener = (event: HostedRlmRuntimeEvent): void => {
		if (capturedListener) {
			capturedListener(event);
		}
	};

	// Subscribe now — this calls adapterSubscribe, which may set
	// subscribeBackoutFailed if inner validation fails and backout is uncertain.
	const subResult = internalPort.subscribe(internalListener);
	if (!subResult.ok || subscribeBackoutFailed) {
		if (subscribeBackoutFailed) {
			return Object.freeze({
				ok: false as const,
				code: "CLEANUP_UNCERTAIN" as const,
			});
		}
		return Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const });
	}

	subUnsubscribe = subResult.value.unsubscribe;

	function start(input: { prompt: string; spawnCode?: string }): Promise<HostedRlmPortResult<HostedRlmTaskResult>> {
		if (finishStarted) {
			return Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		if (started) {
			return Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		if (startPromise) return startPromise;
		started = true;
		try {
			startPromise = internalPort.startInitialTask(input);
		} catch {
			startPromise = Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		return startPromise;
	}

	function requestAbort(): Promise<HostedRlmPortResult<HostedRlmAbortResult>> {
		if (finished) {
			return Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		if (finishStarted) {
			return Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		if (!started) {
			// Not started yet: return fresh failure each time (no caching)
			return Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		if (abortPromise) return abortPromise;
		abortAdmitted = true;
		try {
			abortPromise = internalPort.abort();
		} catch {
			abortPromise = Promise.resolve(
				Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				}),
			);
		}
		return abortPromise;
	}

	function finish(): Promise<HostedRlmPortResult<HostedRlmTaskResult>> {
		if (finishPromise) return finishPromise;
		finishStarted = true;

		finishPromise = (async (): Promise<HostedRlmPortResult<HostedRlmTaskResult>> => {
			// Await start result if start was initiated
			let taskResult: HostedRlmPortResult<HostedRlmTaskResult> | null = null;
			if (startPromise) {
				taskResult = await startPromise;
			}

			// If abort was admitted, await it. Even if abort is uncertain,
			// we must still attempt unsubscribe (do not early-return).
			let abortCertain = true;
			if (abortAdmitted && abortPromise) {
				try {
					const aa = await abortPromise;
					if (!aa.ok) abortCertain = false;
				} catch {
					abortCertain = false;
				}
			}

			// Unsubscribe exactly once
			if (!unsubscribed) {
				unsubscribed = true;
				if (subUnsubscribe) {
					const unsubResult = subUnsubscribe();
					if (!unsubResult.ok) {
						finished = true;
						return Object.freeze({
							ok: false as const,
							error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
						});
					}
				}
			}

			finished = true;

			if (!abortCertain) {
				return Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				});
			}

			if (!taskResult) {
				// finish without start — no meaningful task result available.
				// Subscription was cleaned up above, terminal is set.
				return Object.freeze({
					ok: false as const,
					error: Object.freeze({ code: "CALL_UNCERTAIN" as const }),
				});
			}

			if (!taskResult.ok) return taskResult;
			return taskResult;
		})();

		return finishPromise;
	}

	function observe(): Promise<HostedRlmPortResult<HostedRlmObservationSnapshot>> {
		return internalPort.observe();
	}

	const controller: HostedRlmRunController = Object.freeze({
		identity: portIdentity,
		start,
		requestAbort,
		finish,
		observe,
	});

	return Object.freeze({ ok: true as const, value: controller });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Returns a rejected promise whose rejection is handled by observePromise
 *  inside createHostedRlmRuntimePort, producing CALL_UNCERTAIN. */
function safeUnwrapRejected(): Promise<never> {
	return new Promise<never>((_resolve, reject) => {
		reject(new Error());
	});
}

/** Safely unwrap a public port result promise into a raw inner value.
 *  Validates native Promise, observes via Reflect.apply, descriptor-parses
 *  public result, returns raw value. Never calls .then, never uses in,
 *  never casts. */
function safeUnwrapPortPromise(rawPromise: unknown, timeoutMs: number): Promise<unknown> {
	return new Promise<unknown>((resolve, reject) => {
		if (!isNativePromise(rawPromise)) {
			reject(new Error());
			return;
		}
		const observed = observePromise(rawPromise, timeoutMs);
		observed.then((portResult) => {
			if (!portResult.ok) {
				reject(new Error());
				return;
			}
			const parsed = tryPortOkValue(portResult.value);
			if (!parsed) {
				reject(new Error());
				return;
			}
			resolve(parsed.rawValue);
		});
	});
}
