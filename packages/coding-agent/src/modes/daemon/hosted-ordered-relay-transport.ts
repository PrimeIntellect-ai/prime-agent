import { types } from "node:util";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { decodeEnvelope, isValidSafeId } from "./remote-host-frame-codec.js";

const FACTORY_KEYS = new Set(["port"]);
const PORT_KEYS = new Set(["close", "identity", "observe", "send", "subscribe"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const SEND_INPUT_KEYS = new Set(["envelope"]);
const SEND_RESULT_KEYS = new Set(["ok", "value"]);
const SUBSCRIBE_RESULT_KEYS = new Set(["ok", "value"]);
const SUBSCRIPTION_KEYS = new Set(["unsubscribe"]);
const UNSUBSCRIBE_RESULT_KEYS = new Set(["code", "ok"]);
const CLOSE_RESULT_KEYS = new Set(["code", "ok"]);
const LISTENER_RESULT_KEYS = new Set(["status"]);
const MAX_SYNCHRONOUS_EVENTS = 16;
const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type HostedRelayTransportFactoryErrorCode = "CLOSE_UNCERTAIN" | "INVALID_ARGUMENT";
export type HostedRelaySubscribeErrorCode =
	| "CLOSED"
	| "INVALID_ARGUMENT"
	| "POISONED"
	| "SUBSCRIPTION_ACTIVE"
	| "SUBSCRIBE_UNCERTAIN";

export interface HostedRelayTransport {
	readonly send: (input: { readonly envelope: unknown }) => Promise<Readonly<{ status: "sent" | "error" }>>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export type HostedRelayUnsubscribeResult =
	| Readonly<{ ok: true }>
	| Readonly<{ ok: false; error: Readonly<{ code: "UNSUBSCRIBE_UNCERTAIN" }> }>;

export interface HostedRelayIncomingSubscription {
	readonly unsubscribe: () => Promise<HostedRelayUnsubscribeResult>;
}

export type HostedRelaySubscribeResult =
	| Readonly<{ ok: true; value: HostedRelayIncomingSubscription }>
	| Readonly<{ ok: false; error: Readonly<{ code: HostedRelaySubscribeErrorCode }> }>;

export interface HostedRelayIncomingController {
	readonly subscribe: (
		listener: (envelope: RemoteHostFrameEnvelope) => Promise<Readonly<{ status: "accepted" | "error" }>>,
	) => HostedRelaySubscribeResult;
}

export type CreateHostedOrderedRelayTransportResult =
	| Readonly<{ ok: true; transport: HostedRelayTransport; incoming: HostedRelayIncomingController }>
	| Readonly<{ ok: false; error: Readonly<{ code: HostedRelayTransportFactoryErrorCode }> }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

const SEND_OK = Object.freeze({ status: "sent" as const });
const SEND_ERROR = Object.freeze({ status: "error" as const });
const CLOSE_OK = Object.freeze({ status: "closed" as const });
const CLOSE_ERROR = Object.freeze({ status: "error" as const });
const UNSUBSCRIBE_OK = Object.freeze({ ok: true as const });
const UNSUBSCRIBE_ERROR = Object.freeze({
	ok: false as const,
	error: Object.freeze({ code: "UNSUBSCRIBE_UNCERTAIN" as const }),
});

function factoryFailure(code: HostedRelayTransportFactoryErrorCode): CreateHostedOrderedRelayTransportResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function subscribeFailure(code: HostedRelaySubscribeErrorCode): HostedRelaySubscribeResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const values = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const value = values[name];
			if (!value || !("value" in value) || !value.enumerable) return null;
		}
		return values;
	} catch {
		return null;
	}
}

function bindOwnMethod(owner: unknown, name: string): BoundMethod | null {
	if (typeof owner !== "object" || owner === null) return null;
	try {
		if (types.isProxy(owner)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(owner, name);
		if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
		const method = descriptor.value;
		if (types.isProxy(method)) return null;
		return (...args: readonly unknown[]): unknown => Reflect.apply(method, owner, args);
	} catch {
		return null;
	}
}

function bindExactMethod(owner: object, values: Descriptors, name: string): BoundMethod | null {
	const descriptor = values[name];
	if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
	const method = descriptor.value;
	try {
		if (types.isProxy(method)) return null;
	} catch {
		return null;
	}
	return (...args: readonly unknown[]): unknown => Reflect.apply(method, owner, args);
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			types.isPromise(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observePromise(raw: unknown, timeoutMs: number): Promise<Observed> {
	if (!isNativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise<Observed>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		const finish = (result: Observed): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => finish(Object.freeze({ status: "fulfilled" as const, value })),
				() => finish(Object.freeze({ status: "rejected" as const })),
			]);
		} catch {
			finish(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function invoke(call: () => unknown, timeoutMs: number): Promise<Observed> {
	try {
		return observePromise(call(), timeoutMs);
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
}

function exactAcceptedSend(raw: unknown): boolean {
	const values = exact(raw, SEND_RESULT_KEYS);
	return values?.ok?.value === true && values.value?.value === "ACCEPTED";
}

function exactUnsubscribed(raw: unknown): boolean {
	const values = exact(raw, UNSUBSCRIBE_RESULT_KEYS);
	return values?.ok?.value === true && values.code?.value === "UNSUBSCRIBED";
}

function exactClosed(raw: unknown): boolean {
	const values = exact(raw, CLOSE_RESULT_KEYS);
	return values?.ok?.value === true && values.code?.value === "CLOSED";
}

function exactListenerAccepted(raw: unknown): boolean {
	const values = exact(raw, LISTENER_RESULT_KEYS);
	return values?.status?.value === "accepted";
}

function validIdentity(raw: unknown): boolean {
	const values = exact(raw, IDENTITY_KEYS);
	const hostId = values?.hostId?.value;
	const generation = values?.generation?.value;
	const sessionId = values?.sessionId?.value;
	return (
		typeof hostId === "string" &&
		typeof generation === "string" &&
		typeof sessionId === "string" &&
		isValidSafeId(hostId) &&
		isValidSafeId(generation) &&
		isValidSafeId(sessionId)
	);
}

interface BoundPort {
	readonly close: BoundMethod;
	readonly send: BoundMethod;
	readonly subscribe: BoundMethod;
}

function bindPort(raw: unknown): BoundPort | null {
	const values = exact(raw, PORT_KEYS);
	if (!values || typeof raw !== "object" || raw === null || !validIdentity(values.identity?.value)) return null;
	const close = bindExactMethod(raw, values, "close");
	const observe = bindExactMethod(raw, values, "observe");
	const send = bindExactMethod(raw, values, "send");
	const subscribe = bindExactMethod(raw, values, "subscribe");
	if (!close || !observe || !send || !subscribe) return null;
	return Object.freeze({ close, send, subscribe });
}

interface SubscriptionOwner {
	readonly unsubscribe: BoundMethod;
	accepting: boolean;
	consumed: boolean;
	result: HostedRelayUnsubscribeResult | null;
	promise: Promise<HostedRelayUnsubscribeResult> | null;
}

function discoverSubscriptionOwner(raw: unknown): SubscriptionOwner | null {
	if (typeof raw !== "object" || raw === null) return null;
	let token: unknown;
	try {
		if (types.isProxy(raw)) return null;
		const valueDescriptor = Object.getOwnPropertyDescriptor(raw, "value");
		if (!valueDescriptor || !("value" in valueDescriptor)) return null;
		token = valueDescriptor.value;
	} catch {
		return null;
	}
	const unsubscribe = bindOwnMethod(token, "unsubscribe");
	if (!unsubscribe) return null;
	return { unsubscribe, accepting: true, consumed: false, result: null, promise: null };
}

function validateSubscriptionResult(raw: unknown): boolean {
	const resultValues = exact(raw, SUBSCRIBE_RESULT_KEYS);
	if (resultValues?.ok?.value !== true) return false;
	const token = resultValues.value?.value;
	const tokenValues = exact(token, SUBSCRIPTION_KEYS);
	if (!tokenValues || typeof token !== "object" || token === null) return false;
	return bindExactMethod(token, tokenValues, "unsubscribe") !== null;
}

export async function createHostedOrderedRelayTransport(
	raw: unknown,
): Promise<CreateHostedOrderedRelayTransportResult> {
	let portRaw: unknown;
	if (typeof raw !== "object" || raw === null) return factoryFailure("INVALID_ARGUMENT");
	try {
		if (types.isProxy(raw)) return factoryFailure("CLOSE_UNCERTAIN");
		const portDescriptor = Object.getOwnPropertyDescriptor(raw, "port");
		if (!portDescriptor) return factoryFailure("INVALID_ARGUMENT");
		if (!("value" in portDescriptor)) return factoryFailure("CLOSE_UNCERTAIN");
		portRaw = portDescriptor.value;
	} catch {
		return factoryFailure("CLOSE_UNCERTAIN");
	}
	if (typeof portRaw !== "object" || portRaw === null) return factoryFailure("INVALID_ARGUMENT");
	const preliminaryClose = bindOwnMethod(portRaw, "close");
	if (!preliminaryClose) return factoryFailure("CLOSE_UNCERTAIN");
	let portClosePromise: Promise<boolean> | null = null;
	const closePort = (): Promise<boolean> => {
		if (portClosePromise) return portClosePromise;
		portClosePromise = (async () => {
			const observed = await invoke(() => preliminaryClose(), CLOSE_TIMEOUT_MS);
			return observed.status === "fulfilled" && exactClosed(observed.value);
		})();
		return portClosePromise;
	};
	const failAfterAcquisition = async (
		code: HostedRelayTransportFactoryErrorCode,
	): Promise<CreateHostedOrderedRelayTransportResult> =>
		(await closePort()) ? factoryFailure(code) : factoryFailure("CLOSE_UNCERTAIN");

	if (!exact(raw, FACTORY_KEYS)) return failAfterAcquisition("INVALID_ARGUMENT");
	const port = bindPort(portRaw);
	if (!port) return failAfterAcquisition("INVALID_ARGUMENT");

	let closed = false;
	let poisonPending = false;
	let poisoned = false;
	let activeSubscription: SubscriptionOwner | null = null;
	let tail: Promise<void> = Promise.resolve();
	let closePromise: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;

	const cleanupSubscription = (owner: SubscriptionOwner): HostedRelayUnsubscribeResult => {
		if (owner.consumed) return owner.result ?? UNSUBSCRIBE_ERROR;
		owner.consumed = true;
		let rawResult: unknown;
		try {
			rawResult = owner.unsubscribe();
		} catch {
			owner.result = UNSUBSCRIBE_ERROR;
			poisoned = true;
			return owner.result;
		}
		owner.result = exactUnsubscribed(rawResult) ? UNSUBSCRIBE_OK : UNSUBSCRIBE_ERROR;
		if (owner.result.ok) {
			if (activeSubscription === owner) activeSubscription = null;
		} else {
			poisoned = true;
		}
		return owner.result;
	};

	const poison = (): void => {
		poisonPending = true;
		poisoned = true;
		if (activeSubscription) {
			activeSubscription.accepting = false;
			cleanupSubscription(activeSubscription);
		}
	};

	const queueMalformedCallbackPoison = (owner: SubscriptionOwner | null): void => {
		poisonPending = true;
		if (owner) {
			owner.accepting = false;
			cleanupSubscription(owner);
		}
		const scheduled = tail.then(
			() => {
				poisoned = true;
			},
			() => {
				poisoned = true;
			},
		);
		tail = scheduled.then(
			() => undefined,
			() => {
				poisoned = true;
			},
		);
	};

	const schedule = <T>(operation: () => Promise<T>): Promise<T> => {
		const scheduled = tail.then(operation, operation);
		tail = scheduled.then(
			() => undefined,
			() => undefined,
		);
		return scheduled;
	};

	const send = (input: { readonly envelope: unknown }): Promise<Readonly<{ status: "sent" | "error" }>> => {
		if (closed || poisonPending || poisoned) return Promise.resolve(SEND_ERROR);
		const values = exact(input, SEND_INPUT_KEYS);
		const envelopeRaw = values?.envelope?.value;
		const decoded = decodeEnvelope(envelopeRaw);
		if (!values || !decoded.ok) {
			return schedule(async () => {
				poison();
				return SEND_ERROR;
			});
		}
		return schedule(async () => {
			if (poisoned) return SEND_ERROR;
			const observed = await invoke(() => port.send(decoded.value), OPERATION_TIMEOUT_MS);
			if (observed.status !== "fulfilled" || !exactAcceptedSend(observed.value)) {
				poison();
				return SEND_ERROR;
			}
			return SEND_OK;
		});
	};

	const subscribe = (listener: unknown): HostedRelaySubscribeResult => {
		if (closed) return subscribeFailure("CLOSED");
		if (poisonPending || poisoned) return subscribeFailure("POISONED");
		if (activeSubscription) return subscribeFailure("SUBSCRIPTION_ACTIVE");
		if (typeof listener !== "function") return subscribeFailure("INVALID_ARGUMENT");
		try {
			if (types.isProxy(listener)) return subscribeFailure("INVALID_ARGUMENT");
		} catch {
			return subscribeFailure("INVALID_ARGUMENT");
		}
		const validatedListener = listener;
		let registering = true;
		let overflowed = false;
		const buffered: unknown[] = [];
		let owner: SubscriptionOwner | null = null;

		const failCallback = (): void => {
			poison();
		};
		const deliver = (envelope: RemoteHostFrameEnvelope): void => {
			const scheduled = tail.then(
				async () => {
					if (poisoned) return;
					const observed = await invoke(
						() => Reflect.apply(validatedListener, undefined, [envelope]),
						OPERATION_TIMEOUT_MS,
					);
					if (observed.status !== "fulfilled" || !exactListenerAccepted(observed.value)) failCallback();
				},
				async () => {
					poison();
				},
			);
			tail = scheduled.then(
				() => undefined,
				() => {
					poison();
				},
			);
		};
		const callback = (envelopeRaw: unknown): void => {
			if (closed || poisonPending || poisoned || owner?.accepting === false || owner?.consumed) return;
			if (registering) {
				if (buffered.length >= MAX_SYNCHRONOUS_EVENTS) overflowed = true;
				else buffered.push(envelopeRaw);
				return;
			}
			const decoded = decodeEnvelope(envelopeRaw);
			if (!decoded.ok || !owner) {
				queueMalformedCallbackPoison(owner);
				return;
			}
			deliver(decoded.value);
		};

		let rawResult: unknown;
		try {
			rawResult = port.subscribe(callback);
		} catch {
			registering = false;
			poison();
			return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		registering = false;
		owner = discoverSubscriptionOwner(rawResult);
		if (!owner) {
			poison();
			return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		if (!validateSubscriptionResult(rawResult)) {
			owner.accepting = false;
			const cleanup = cleanupSubscription(owner);
			poisoned = true;
			return cleanup.ok ? subscribeFailure("INVALID_ARGUMENT") : subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		if (overflowed) {
			owner.accepting = false;
			cleanupSubscription(owner);
			poisoned = true;
			return subscribeFailure("SUBSCRIBE_UNCERTAIN");
		}
		const decodedBuffered: RemoteHostFrameEnvelope[] = [];
		for (const envelopeRaw of buffered) {
			const decoded = decodeEnvelope(envelopeRaw);
			if (!decoded.ok) {
				owner.accepting = false;
				cleanupSubscription(owner);
				poisoned = true;
				return subscribeFailure("SUBSCRIBE_UNCERTAIN");
			}
			decodedBuffered.push(decoded.value);
		}
		activeSubscription = owner;
		for (const envelope of decodedBuffered) deliver(envelope);

		const unsubscribe = (): Promise<HostedRelayUnsubscribeResult> => {
			if (owner.promise) return owner.promise;
			owner.accepting = false;
			owner.promise = schedule(async () => cleanupSubscription(owner));
			return owner.promise;
		};
		return Object.freeze({
			ok: true as const,
			value: Object.freeze({ unsubscribe }),
		});
	};

	const close = (): Promise<Readonly<{ status: "closed" | "error" }>> => {
		if (closePromise) return closePromise;
		closed = true;
		const poisonBeforeClose = poisonPending || poisoned;
		closePromise = schedule(async () => {
			const cleanup = activeSubscription ? cleanupSubscription(activeSubscription) : UNSUBSCRIBE_OK;
			const portClosed = await closePort();
			return !poisonBeforeClose && !poisoned && cleanup.ok && portClosed ? CLOSE_OK : CLOSE_ERROR;
		});
		return closePromise;
	};

	const transport: HostedRelayTransport = Object.freeze({ send, close });
	const incoming: HostedRelayIncomingController = Object.freeze({ subscribe });
	return Object.freeze({ ok: true as const, transport, incoming });
}
