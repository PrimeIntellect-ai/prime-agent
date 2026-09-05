import { types } from "node:util";
import type {
	RemoteHostEventCursor,
	RemoteHostFrameEnvelope,
	RemoteHostProviderProxyFrame,
} from "./remote-agent-host-protocol.js";
import { decodeEnvelope, isValidSafeId } from "./remote-host-frame-codec.js";
import { decodeRemoteObservationSnapshotV1, type RemoteObservationSnapshotV1 } from "./remote-observation-snapshot.js";

export type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
export type { RemoteObservationSnapshotV1 } from "./remote-observation-snapshot.js";

export type HostedSubagentIdentity = Pick<RemoteHostEventCursor, "generation" | "hostId" | "sessionId">;
export type HostedProviderUsage = NonNullable<
	Extract<RemoteHostProviderProxyFrame, { proxyType: "model_call_complete" }>["usage"]
>;

export type HostedPortFailureCode =
	| "CLOSED"
	| "INVALID_FRAME"
	| "INVALID_INPUT"
	| "INVALID_SNAPSHOT"
	| "SUBSCRIPTION_ACTIVE"
	| "TRANSPORT";

export type HostedPortResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; code: HostedPortFailureCode }>;

export type HostedIncomingResult = HostedPortResult<RemoteHostFrameEnvelope>;
export type HostedPortCloseResult = Readonly<{ ok: true; code: "CLOSED" }> | Readonly<{ ok: false; code: "TRANSPORT" }>;
export type HostedPortUnsubscribeResult =
	| Readonly<{ ok: true; code: "UNSUBSCRIBED" }>
	| Readonly<{ ok: false; code: "TRANSPORT" }>;

export interface HostedPortSubscription {
	readonly unsubscribe: () => HostedPortUnsubscribeResult;
}

export interface HostedSubagentPort {
	readonly identity: HostedSubagentIdentity;
	readonly send: (rawEnvelope: unknown) => Promise<HostedPortResult<"ACCEPTED">>;
	readonly subscribe: (listener: unknown) => HostedPortResult<HostedPortSubscription>;
	readonly observe: () => Promise<HostedPortResult<RemoteObservationSnapshotV1>>;
	readonly close: () => Promise<HostedPortCloseResult>;
}

export type CreateHostedSubagentPortResult = HostedPortResult<HostedSubagentPort>;

const INPUT_KEYS = new Set(["capability", "identity"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const CAPABILITY_KEYS = new Set(["close", "observe", "send", "subscribe"]);
const STATUS_KEY = new Set(["status"]);
const SUBSCRIBED_KEYS = new Set(["status", "unsubscribe"]);
const MAX_SYNCHRONOUS_EVENTS = 16;

const FAILURES = Object.freeze({
	CLOSED: Object.freeze({ ok: false as const, code: "CLOSED" as const }),
	INVALID_FRAME: Object.freeze({ ok: false as const, code: "INVALID_FRAME" as const }),
	INVALID_INPUT: Object.freeze({ ok: false as const, code: "INVALID_INPUT" as const }),
	INVALID_SNAPSHOT: Object.freeze({ ok: false as const, code: "INVALID_SNAPSHOT" as const }),
	SUBSCRIPTION_ACTIVE: Object.freeze({ ok: false as const, code: "SUBSCRIPTION_ACTIVE" as const }),
	TRANSPORT: Object.freeze({ ok: false as const, code: "TRANSPORT" as const }),
});
const ACCEPTED = Object.freeze({ ok: true as const, value: "ACCEPTED" as const });
const CLOSED_OK = Object.freeze({ ok: true as const, code: "CLOSED" as const });
const UNSUBSCRIBED = Object.freeze({ ok: true as const, code: "UNSUBSCRIBED" as const });
const CLOSE_FAILED = Object.freeze({ ok: false as const, code: "TRANSPORT" as const });
const UNSUBSCRIBE_FAILED = Object.freeze({ ok: false as const, code: "TRANSPORT" as const });

interface BoundCapability {
	readonly close: () => unknown;
	readonly observe: () => unknown;
	readonly send: (envelope: RemoteHostFrameEnvelope) => unknown;
	readonly subscribe: (callback: (envelope: unknown) => void) => unknown;
}

function descriptors(raw: unknown, keys: ReadonlySet<string>): Readonly<Record<string, PropertyDescriptor>> | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const result = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const descriptor = result[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return result;
	} catch {
		return null;
	}
}

function snapshotIdentity(raw: unknown): HostedSubagentIdentity | null {
	const values = descriptors(raw, IDENTITY_KEYS);
	if (!values) return null;
	const hostId = values.hostId?.value;
	const generation = values.generation?.value;
	const sessionId = values.sessionId?.value;
	if (
		typeof hostId !== "string" ||
		typeof generation !== "string" ||
		typeof sessionId !== "string" ||
		!isValidSafeId(hostId) ||
		!isValidSafeId(generation) ||
		!isValidSafeId(sessionId)
	)
		return null;
	return Object.freeze({ hostId, generation, sessionId });
}

function bindCapability(raw: unknown): BoundCapability | null {
	const values = descriptors(raw, CAPABILITY_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	const send = values.send?.value;
	const subscribe = values.subscribe?.value;
	const observe = values.observe?.value;
	const close = values.close?.value;
	if (
		typeof send !== "function" ||
		typeof subscribe !== "function" ||
		typeof observe !== "function" ||
		typeof close !== "function"
	)
		return null;
	return Object.freeze({
		send: (envelope: RemoteHostFrameEnvelope): unknown => Reflect.apply(send as CallableFunction, raw, [envelope]),
		subscribe: (callback: (envelope: unknown) => void): unknown =>
			Reflect.apply(subscribe as CallableFunction, raw, [callback]),
		observe: (): unknown => Reflect.apply(observe as CallableFunction, raw, []),
		close: (): unknown => Reflect.apply(close as CallableFunction, raw, []),
	});
}

function status(raw: unknown, allowed: ReadonlySet<string>): string | null {
	const values = descriptors(raw, STATUS_KEY);
	const value = values?.status?.value;
	return typeof value === "string" && allowed.has(value) ? value : null;
}

function snapshotSubscription(
	raw: unknown,
): { status: "error" } | { status: "subscribed"; unsubscribe: () => unknown } | null {
	const errorStatus = status(raw, new Set(["error"]));
	if (errorStatus === "error") return Object.freeze({ status: "error" as const });
	const values = descriptors(raw, SUBSCRIBED_KEYS);
	if (!values || typeof raw !== "object" || raw === null) return null;
	if (values.status?.value !== "subscribed" || typeof values.unsubscribe?.value !== "function") return null;
	const unsubscribe = values.unsubscribe.value;
	return Object.freeze({
		status: "subscribed" as const,
		unsubscribe: (): unknown => Reflect.apply(unsubscribe as CallableFunction, raw, []),
	});
}

function discoverSubscriptionCleanup(raw: unknown): (() => unknown) | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const values = Object.getOwnPropertyDescriptors(raw);
		const statusDescriptor = values.status;
		const unsubscribeDescriptor = values.unsubscribe;
		if (
			!statusDescriptor ||
			!("value" in statusDescriptor) ||
			statusDescriptor.value !== "subscribed" ||
			!unsubscribeDescriptor ||
			!("value" in unsubscribeDescriptor) ||
			typeof unsubscribeDescriptor.value !== "function"
		)
			return null;
		const unsubscribe = unsubscribeDescriptor.value;
		return (): unknown => Reflect.apply(unsubscribe as CallableFunction, raw, []);
	} catch {
		return null;
	}
}

function ok<T>(value: T): HostedPortResult<T> {
	return Object.freeze({ ok: true as const, value });
}

export function createHostedSubagentPort(raw: unknown): CreateHostedSubagentPortResult {
	const input = descriptors(raw, INPUT_KEYS);
	if (!input) return FAILURES.INVALID_INPUT;
	const identity = snapshotIdentity(input.identity?.value);
	const capability = bindCapability(input.capability?.value);
	if (!identity || !capability) return FAILURES.INVALID_INPUT;
	const acceptedIdentity = identity;
	const acceptedCapability = capability;

	let closing = false;
	let closePromise: Promise<HostedPortCloseResult> | null = null;
	type SubscriptionState = {
		consumed: boolean;
		unsubscribe: () => unknown;
		result: HostedPortUnsubscribeResult | null;
	};
	let activeSubscription: SubscriptionState | null = null;
	let subscriptionUncertain = false;

	async function send(rawEnvelope: unknown): Promise<HostedPortResult<"ACCEPTED">> {
		if (closing) return FAILURES.CLOSED;
		const decoded = decodeEnvelope(rawEnvelope);
		if (!decoded.ok) return FAILURES.INVALID_FRAME;
		let rawResult: unknown;
		try {
			rawResult = await acceptedCapability.send(decoded.value);
		} catch {
			return FAILURES.TRANSPORT;
		}
		return status(rawResult, new Set(["accepted"])) === "accepted" ? ACCEPTED : FAILURES.TRANSPORT;
	}

	function subscribe(listener: unknown): HostedPortResult<HostedPortSubscription> {
		if (closing) return FAILURES.CLOSED;
		if (activeSubscription) return FAILURES.SUBSCRIPTION_ACTIVE;
		if (typeof listener !== "function") return FAILURES.INVALID_INPUT;
		try {
			if (types.isProxy(listener)) return FAILURES.INVALID_INPUT;
		} catch {
			return FAILURES.INVALID_INPUT;
		}

		let registering = true;
		let registrationInvalid = false;
		let registrationAbandoned = false;
		let subscriptionState: SubscriptionState | null = null;
		const queued: HostedIncomingResult[] = [];
		const deliver = (result: HostedIncomingResult): void => {
			try {
				Reflect.apply(listener as CallableFunction, undefined, [result]);
			} catch {
				// Application listener failures never escape the transport boundary.
			}
		};
		const callback = (rawEnvelope: unknown): void => {
			if (closing || registrationAbandoned || subscriptionState?.consumed) return;
			const decoded = decodeEnvelope(rawEnvelope);
			const result: HostedIncomingResult = decoded.ok ? ok(decoded.value) : FAILURES.INVALID_FRAME;
			if (registering) {
				if (queued.length >= MAX_SYNCHRONOUS_EVENTS) registrationInvalid = true;
				else queued.push(result);
			} else {
				deliver(result);
			}
		};

		let rawResult: unknown;
		try {
			rawResult = acceptedCapability.subscribe(callback);
		} catch {
			registrationAbandoned = true;
			return FAILURES.TRANSPORT;
		} finally {
			registering = false;
		}
		const registered = snapshotSubscription(rawResult);
		if (!registered || registered.status !== "subscribed" || registrationInvalid) {
			registrationAbandoned = true;
			const cleanup =
				registered?.status === "subscribed" ? registered.unsubscribe : discoverSubscriptionCleanup(rawResult);
			if (cleanup) {
				const failedState: SubscriptionState = {
					consumed: true,
					unsubscribe: cleanup,
					result: null,
				};
				subscriptionState = failedState;
				try {
					failedState.result =
						status(cleanup(), new Set(["unsubscribed"])) === "unsubscribed" ? UNSUBSCRIBED : UNSUBSCRIBE_FAILED;
				} catch {
					failedState.result = UNSUBSCRIBE_FAILED;
				}
				if (!failedState.result.ok) {
					activeSubscription = failedState;
					subscriptionUncertain = true;
				}
			}
			return FAILURES.TRANSPORT;
		}

		const state: SubscriptionState = {
			consumed: false,
			unsubscribe: registered.unsubscribe,
			result: null as HostedPortUnsubscribeResult | null,
		};
		subscriptionState = state;
		activeSubscription = state;
		for (const result of queued) {
			if (closing || state.consumed) break;
			deliver(result);
		}
		queued.length = 0;

		const unsubscribe = (): HostedPortUnsubscribeResult => {
			if (state.consumed) return state.result ?? UNSUBSCRIBE_FAILED;
			state.consumed = true;
			let rawUnsubscribe: unknown;
			try {
				rawUnsubscribe = state.unsubscribe();
			} catch {
				state.result = UNSUBSCRIBE_FAILED;
				subscriptionUncertain = true;
				return state.result;
			}
			state.result =
				status(rawUnsubscribe, new Set(["unsubscribed"])) === "unsubscribed" ? UNSUBSCRIBED : UNSUBSCRIBE_FAILED;
			if (state.result.ok) {
				if (activeSubscription === state) activeSubscription = null;
			} else {
				subscriptionUncertain = true;
			}
			return state.result;
		};
		return ok(Object.freeze({ unsubscribe }));
	}

	async function observe(): Promise<HostedPortResult<RemoteObservationSnapshotV1>> {
		if (closing) return FAILURES.CLOSED;
		let rawSnapshot: unknown;
		try {
			rawSnapshot = await acceptedCapability.observe();
		} catch {
			return FAILURES.TRANSPORT;
		}
		const decoded = decodeRemoteObservationSnapshotV1(rawSnapshot, acceptedIdentity);
		return decoded.success ? ok(decoded.value) : FAILURES.INVALID_SNAPSHOT;
	}

	function close(): Promise<HostedPortCloseResult> {
		if (closePromise) return closePromise;
		closing = true;
		closePromise = (async (): Promise<HostedPortCloseResult> => {
			let subscriptionClean = !subscriptionUncertain;
			if (activeSubscription && !activeSubscription.consumed) {
				activeSubscription.consumed = true;
				try {
					const rawUnsubscribe = activeSubscription.unsubscribe();
					activeSubscription.result =
						status(rawUnsubscribe, new Set(["unsubscribed"])) === "unsubscribed"
							? UNSUBSCRIBED
							: UNSUBSCRIBE_FAILED;
				} catch {
					activeSubscription.result = UNSUBSCRIBE_FAILED;
				}
				subscriptionClean = activeSubscription.result.ok && !subscriptionUncertain;
			}
			let rawClose: unknown;
			try {
				rawClose = await acceptedCapability.close();
			} catch {
				return CLOSE_FAILED;
			}
			return subscriptionClean && status(rawClose, new Set(["closed"])) === "closed" ? CLOSED_OK : CLOSE_FAILED;
		})();
		return closePromise;
	}

	return ok(Object.freeze({ identity: acceptedIdentity, send, subscribe, observe, close }));
}

export function extractHostedProviderUsage(rawEnvelope: unknown): HostedProviderUsage | null {
	const decoded = decodeEnvelope(rawEnvelope);
	if (!decoded.ok) return null;
	const frame = decoded.value.frame;
	if (frame.type !== "provider_proxy" || frame.proxyType !== "model_call_complete" || !frame.usage) return null;
	return Object.freeze({ inputTokens: frame.usage.inputTokens, outputTokens: frame.usage.outputTokens });
}
