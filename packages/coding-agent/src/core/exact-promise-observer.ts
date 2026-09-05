import { types } from "node:util";

const objectGetPrototypeOf: typeof Object.getPrototypeOf = Object.getPrototypeOf;
const objectGetOwnPropertyNames: typeof Object.getOwnPropertyNames = Object.getOwnPropertyNames;
const objectGetOwnPropertySymbols: typeof Object.getOwnPropertySymbols = Object.getOwnPropertySymbols;
const objectGetOwnPropertyDescriptor: typeof Object.getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectFreeze: typeof Object.freeze = Object.freeze;
const reflectApply: typeof Reflect.apply = Reflect.apply;
const isProxy: typeof types.isProxy = types.isProxy;
const isPromise: typeof types.isPromise = types.isPromise;
const numberIsSafeInteger: typeof Number.isSafeInteger = Number.isSafeInteger;

const promisePrototypeDescriptor = objectGetOwnPropertyDescriptor(Promise, "prototype");
if (
	promisePrototypeDescriptor === undefined ||
	!("value" in promisePrototypeDescriptor) ||
	typeof promisePrototypeDescriptor.value !== "object" ||
	promisePrototypeDescriptor.value === null ||
	promisePrototypeDescriptor.writable !== false ||
	promisePrototypeDescriptor.enumerable !== false ||
	promisePrototypeDescriptor.configurable !== false ||
	isProxy(promisePrototypeDescriptor.value)
) {
	throw new Error("exact-promise-observer: invalid Promise prototype");
}
const promisePrototype: object = promisePrototypeDescriptor.value;

const promiseConstructorDescriptor = objectGetOwnPropertyDescriptor(promisePrototype, "constructor");
if (
	promiseConstructorDescriptor === undefined ||
	!("value" in promiseConstructorDescriptor) ||
	typeof promiseConstructorDescriptor.value !== "function" ||
	promiseConstructorDescriptor.writable !== true ||
	promiseConstructorDescriptor.enumerable !== false ||
	promiseConstructorDescriptor.configurable !== true ||
	isProxy(promiseConstructorDescriptor.value)
) {
	throw new Error("exact-promise-observer: invalid Promise constructor");
}
const PromiseConstructor: PromiseConstructor = promiseConstructorDescriptor.value;

const promiseThenDescriptor = objectGetOwnPropertyDescriptor(promisePrototype, "then");
if (
	promiseThenDescriptor === undefined ||
	!("value" in promiseThenDescriptor) ||
	typeof promiseThenDescriptor.value !== "function" ||
	promiseThenDescriptor.writable !== true ||
	promiseThenDescriptor.enumerable !== false ||
	promiseThenDescriptor.configurable !== true ||
	isProxy(promiseThenDescriptor.value)
) {
	throw new Error("exact-promise-observer: invalid Promise then");
}
const promiseThen: (this: unknown, ...args: unknown[]) => unknown = promiseThenDescriptor.value;

for (const intrinsic of [
	objectGetPrototypeOf,
	objectGetOwnPropertyNames,
	objectGetOwnPropertySymbols,
	objectGetOwnPropertyDescriptor,
	objectFreeze,
	reflectApply,
	isProxy,
	isPromise,
	numberIsSafeInteger,
]) {
	if (typeof intrinsic !== "function" || isProxy(intrinsic)) {
		throw new Error("exact-promise-observer: invalid intrinsic");
	}
}

export interface ExactPromiseContextMarker {}

export type ExactPromiseObservation = Readonly<{ fulfilled: true; value: unknown }> | Readonly<{ fulfilled: false }>;

interface SymbolConstraint {
	readonly symbol: symbol;
	readonly writable: boolean;
	readonly enumerable: boolean;
	readonly configurable: boolean;
	readonly variableAsyncId: boolean;
	readonly baseline: unknown;
}

interface MarkerRecord {
	readonly constraints: readonly SymbolConstraint[];
}

const markerRecords = new WeakMap<object, MarkerRecord>();
const MAX_ENGINE_SYMBOLS = 64;

function invalidObservation(): ExactPromiseObservation {
	return objectFreeze({ fulfilled: false });
}

function validObservation(value: unknown): ExactPromiseObservation {
	return objectFreeze({ fulfilled: true, value });
}

function ownedObservation(value: ExactPromiseObservation): Promise<ExactPromiseObservation> {
	return new PromiseConstructor((resolve: (result: ExactPromiseObservation) => void): void => {
		resolve(value);
	});
}

function descriptorFlagsMatch(left: PropertyDescriptor, right: PropertyDescriptor): boolean {
	return (
		left.writable === right.writable &&
		left.enumerable === right.enumerable &&
		left.configurable === right.configurable
	);
}

/** Capture the exact Node-owned Promise symbol shape in the current async context. */
export function captureExactPromiseContext(): ExactPromiseContextMarker | null {
	let first: Promise<undefined>;
	let second: Promise<undefined>;
	try {
		first = new PromiseConstructor((resolve: (value: undefined) => void): void => resolve(undefined));
		second = new PromiseConstructor((resolve: (value: undefined) => void): void => resolve(undefined));
	} catch {
		return null;
	}

	let firstSymbols: symbol[];
	let secondSymbols: symbol[];
	try {
		firstSymbols = objectGetOwnPropertySymbols(first);
		secondSymbols = objectGetOwnPropertySymbols(second);
	} catch {
		return null;
	}
	if (firstSymbols.length !== secondSymbols.length || firstSymbols.length > MAX_ENGINE_SYMBOLS) {
		return null;
	}

	const constraints: SymbolConstraint[] = [];
	let variableCount = 0;
	for (let index = 0; index < firstSymbols.length; index++) {
		const symbol = firstSymbols[index];
		if (symbol !== secondSymbols[index]) return null;
		let firstDescriptor: PropertyDescriptor | undefined;
		let secondDescriptor: PropertyDescriptor | undefined;
		try {
			firstDescriptor = objectGetOwnPropertyDescriptor(first, symbol);
			secondDescriptor = objectGetOwnPropertyDescriptor(second, symbol);
		} catch {
			return null;
		}
		if (
			firstDescriptor === undefined ||
			secondDescriptor === undefined ||
			!("value" in firstDescriptor) ||
			!("value" in secondDescriptor) ||
			!descriptorFlagsMatch(firstDescriptor, secondDescriptor)
		) {
			return null;
		}
		const firstValue: unknown = firstDescriptor.value;
		const secondValue: unknown = secondDescriptor.value;
		const variableAsyncId =
			typeof firstValue === "number" &&
			numberIsSafeInteger(firstValue) &&
			firstValue >= 0 &&
			typeof secondValue === "number" &&
			numberIsSafeInteger(secondValue) &&
			secondValue >= 0 &&
			firstValue !== secondValue;
		if (variableAsyncId) variableCount++;
		constraints.push(
			objectFreeze({
				symbol,
				writable: firstDescriptor.writable === true,
				enumerable: firstDescriptor.enumerable === true,
				configurable: firstDescriptor.configurable === true,
				variableAsyncId,
				baseline: variableAsyncId ? undefined : secondValue,
			}),
		);
	}
	if (constraints.length > 0 && variableCount !== 1) return null;

	const marker: ExactPromiseContextMarker = objectFreeze({});
	markerRecords.set(marker, objectFreeze({ constraints: objectFreeze(constraints) }));
	return marker;
}

/** Validate a genuine native Promise against zero symbols or an exact private context marker. */
export function isExactPromiseForContext(
	raw: unknown,
	marker: ExactPromiseContextMarker | null,
): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (isProxy(raw) || !isPromise(raw)) return false;
		if (objectGetPrototypeOf(raw) !== promisePrototype) return false;
		if (objectGetOwnPropertyNames(raw).length !== 0) return false;
		const symbols = objectGetOwnPropertySymbols(raw);
		if (symbols.length === 0) return true;
		if (marker === null) return false;
		const record = markerRecords.get(marker);
		if (record === undefined || symbols.length !== record.constraints.length) return false;
		for (let index = 0; index < symbols.length; index++) {
			const constraint = record.constraints[index];
			const symbol = symbols[index];
			if (symbol !== constraint.symbol) return false;
			const descriptor = objectGetOwnPropertyDescriptor(raw, symbol);
			if (descriptor === undefined || !("value" in descriptor)) return false;
			if (
				(descriptor.writable === true) !== constraint.writable ||
				(descriptor.enumerable === true) !== constraint.enumerable ||
				(descriptor.configurable === true) !== constraint.configurable
			) {
				return false;
			}
			const value: unknown = descriptor.value;
			if (constraint.variableAsyncId) {
				if (typeof value !== "number" || !numberIsSafeInteger(value) || value < 0) return false;
			} else if (value !== constraint.baseline) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

/** Observe an already-returned Promise with an explicit same-context marker. */
export function observeExactPromise(
	raw: unknown,
	marker: ExactPromiseContextMarker | null,
): Promise<ExactPromiseObservation> {
	if (!isExactPromiseForContext(raw, marker)) return ownedObservation(invalidObservation());
	return new PromiseConstructor((resolve: (result: ExactPromiseObservation) => void): void => {
		const fulfilled = (value: unknown): void => resolve(validObservation(value));
		const rejected = (): void => resolve(invalidObservation());
		try {
			reflectApply(promiseThen, raw, [fulfilled, rejected]);
		} catch {
			resolve(invalidObservation());
		}
	});
}

/** Capture context, invoke once, and synchronously attach observation before returning. */
export function observeExactPromiseCall(call: () => unknown): Promise<ExactPromiseObservation> {
	const marker = captureExactPromiseContext();
	if (marker === null) return ownedObservation(invalidObservation());
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return ownedObservation(invalidObservation());
	}
	return observeExactPromise(raw, marker);
}
