import { types } from "node:util";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	decodeAgentMessageFrame,
	decodeEnvelope,
	digestsEqual,
	isValidDigest,
} from "./remote-host-frame-codec.js";

const FACTORY_KEYS = new Set(["close", "getOutboundRelay"]);
const ENSURE_KEYS = new Set(["envelope", "semanticDigest"]);
const AVAILABLE_KEYS = new Set(["relay", "status"]);
const UNAVAILABLE_KEYS = new Set(["status"]);
const RELAY_KEYS = new Set(["send"]);
const SEND_SUCCESS_KEYS = new Set(["ok", "value"]);
const SEND_FAILURE_KEYS = new Set(["error", "ok"]);
const SEND_VALUE_KEYS = new Set(["frameId", "replay"]);
const ERROR_KEYS = new Set(["code"]);
const SEND_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

const TRANSIENT_RELAY_ERRORS = new Set(["CLOSED", "PERSISTENCE_FAILED", "POISONED", "TRANSPORT_UNCERTAIN"]);
const FATAL_RELAY_ERRORS = new Set(["APPLICATION_FAILED", "CLOSE_UNCERTAIN", "INVALID_ARGUMENT", "REENTRANT_CALL"]);

export type RemoteRelayEnsureResult = Readonly<{ status: "persisted" | "deferred" | "error" }>;
export type RemoteRelayCloseResult = Readonly<{ status: "closed" | "error" }>;

export interface RemoteRelayDispatcher {
	readonly ensure: (raw: unknown) => Promise<RemoteRelayEnsureResult>;
	readonly close: () => Promise<RemoteRelayCloseResult>;
}

export type CreateRemoteRelayDispatcherResult =
	| Readonly<{ ok: true; dispatcher: RemoteRelayDispatcher }>
	| Readonly<{
			ok: false;
			error: Readonly<{ code: "CLOSE_UNCERTAIN" | "INVALID_ARGUMENT" }>;
	  }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type CloseOwner = () => Promise<boolean>;
type Observation =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const found = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(found);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		for (const name of names) {
			const descriptor = found[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return found;
	} catch {
		return null;
	}
}

function value(found: Descriptors, name: string): unknown {
	const descriptor = found[name];
	return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function bind(owner: object, found: Descriptors, name: string): BoundMethod | null {
	const candidate = value(found, name);
	if (typeof candidate !== "function") return null;
	try {
		if (types.isProxy(candidate)) return null;
		return (...args: readonly unknown[]): unknown => Reflect.apply(candidate, owner, args);
	} catch {
		return null;
	}
}

function plainDataTree(raw: unknown, depth = 0): boolean {
	if (raw === null || typeof raw === "string" || typeof raw === "boolean") return true;
	if (typeof raw === "number") return Number.isFinite(raw);
	if (typeof raw !== "object" || depth > 8) return false;
	try {
		if (types.isProxy(raw) || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		const found = Object.getOwnPropertyDescriptors(raw);
		const names = Object.getOwnPropertyNames(found);
		if (names.length > 32) return false;
		for (const name of names) {
			const descriptor = found[name];
			if (
				!descriptor ||
				!("value" in descriptor) ||
				!descriptor.enumerable ||
				descriptor.value === undefined ||
				!plainDataTree(descriptor.value, depth + 1)
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}

function persisted(): RemoteRelayEnsureResult {
	return Object.freeze({ status: "persisted" as const });
}

function deferred(): RemoteRelayEnsureResult {
	return Object.freeze({ status: "deferred" as const });
}

function failed(): RemoteRelayEnsureResult {
	return Object.freeze({ status: "error" as const });
}

function closed(): RemoteRelayCloseResult {
	return Object.freeze({ status: "closed" as const });
}

function closeFailed(): RemoteRelayCloseResult {
	return Object.freeze({ status: "error" as const });
}

function factoryFailed(code: "CLOSE_UNCERTAIN" | "INVALID_ARGUMENT"): CreateRemoteRelayDispatcherResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function observe(raw: unknown, timeoutMs = SEND_TIMEOUT_MS): Promise<Observation> {
	if (typeof raw !== "object" || raw === null) {
		return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	}
	try {
		if (
			types.isProxy(raw) ||
			!types.isPromise(raw) ||
			Object.getPrototypeOf(raw) !== Promise.prototype ||
			Object.getOwnPropertyNames(raw).length !== 0 ||
			Object.getOwnPropertySymbols(raw).length !== 0
		)
			return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	} catch {
		return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	}
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(result: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value: result }));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "rejected" as const }));
				},
			]);
		} catch {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(Object.freeze({ status: "invalid" as const }));
		}
	});
}

function acquireClose(raw: unknown): CloseOwner | null {
	if (typeof raw !== "object" || raw === null) return null;
	let bound: BoundMethod;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
		if (types.isProxy(descriptor.value)) return null;
		const candidate = descriptor.value;
		bound = (): unknown => Reflect.apply(candidate, raw, []);
	} catch {
		return null;
	}
	let shared: Promise<boolean> | null = null;
	return (): Promise<boolean> => {
		if (shared) return shared;
		shared = (async (): Promise<boolean> => {
			let rawResult: unknown;
			try {
				rawResult = bound();
			} catch {
				return false;
			}
			const observed = await observe(rawResult, CLOSE_TIMEOUT_MS);
			if (observed.status !== "fulfilled") return false;
			const result = exact(observed.value, UNAVAILABLE_KEYS);
			return result !== null && value(result, "status") === "closed";
		})();
		return shared;
	};
}

function normalizeEnvelope(raw: unknown): Readonly<{
	envelope: RemoteHostFrameEnvelope;
	semanticDigest: string;
}> | null {
	const found = exact(raw, ENSURE_KEYS);
	if (!found) return null;
	const rawEnvelope = value(found, "envelope");
	if (!plainDataTree(rawEnvelope)) return null;
	const decoded = decodeEnvelope(rawEnvelope);
	if (!decoded.ok || decoded.value.frame.type !== "agent_message") return null;
	const agentMessage = decodeAgentMessageFrame(decoded.value.frame);
	if (!agentMessage.ok) return null;
	const semanticDigest = value(found, "semanticDigest");
	if (typeof semanticDigest !== "string" || !isValidDigest(semanticDigest)) return null;
	const computed = canonicalDigest(agentMessage.value);
	if (!computed.ok || !digestsEqual(computed.value, semanticDigest)) return null;
	return Object.freeze({ envelope: decoded.value, semanticDigest });
}

function relayFromLookup(raw: unknown): "unavailable" | BoundMethod | null {
	const unavailable = exact(raw, UNAVAILABLE_KEYS);
	if (unavailable && value(unavailable, "status") === "unavailable") return "unavailable";
	const available = exact(raw, AVAILABLE_KEYS);
	if (!available || value(available, "status") !== "available") return null;
	const rawRelay = value(available, "relay");
	const relay = exact(rawRelay, RELAY_KEYS);
	if (!relay || typeof rawRelay !== "object" || rawRelay === null) return null;
	return bind(rawRelay, relay, "send");
}

function sendOutcome(raw: unknown, frameId: string): "persisted" | "deferred" | "fatal" {
	const success = exact(raw, SEND_SUCCESS_KEYS);
	if (success && value(success, "ok") === true) {
		const payload = exact(value(success, "value"), SEND_VALUE_KEYS);
		if (!payload) return "fatal";
		return value(payload, "frameId") === frameId && typeof value(payload, "replay") === "boolean"
			? "persisted"
			: "fatal";
	}
	const failure = exact(raw, SEND_FAILURE_KEYS);
	if (!failure || value(failure, "ok") !== false) return "fatal";
	const error = exact(value(failure, "error"), ERROR_KEYS);
	if (!error) return "fatal";
	const code = value(error, "code");
	if (typeof code !== "string") return "fatal";
	if (TRANSIENT_RELAY_ERRORS.has(code)) return "deferred";
	if (FATAL_RELAY_ERRORS.has(code)) return "fatal";
	return "fatal";
}

class RemoteRelayDispatcherImpl {
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<RemoteRelayCloseResult> | null = null;
	private closeRequested = false;
	private poisoned = false;
	private insideInjectedCall = false;

	constructor(
		private readonly getOutboundRelay: BoundMethod,
		private readonly contextClose: CloseOwner,
	) {}

	ensure(raw: unknown): Promise<RemoteRelayEnsureResult> {
		if (this.insideInjectedCall) return Promise.resolve(failed());
		if (this.closeRequested || this.poisoned) return Promise.resolve(failed());
		const normalized = normalizeEnvelope(raw);
		if (!normalized) return Promise.resolve(failed());
		const previous = this.tail;
		const result = (async (): Promise<RemoteRelayEnsureResult> => {
			await previous;
			if (this.poisoned) return failed();
			return await this.ensureOrdered(normalized.envelope);
		})();
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	close(): Promise<RemoteRelayCloseResult> {
		if (this.insideInjectedCall) return Promise.resolve(closeFailed());
		if (this.closePromise) return this.closePromise;
		this.closeRequested = true;
		const admitted = this.tail;
		this.closePromise = admitted.then(
			async () => ((await this.invokeContextClose()) ? closed() : closeFailed()),
			() => closeFailed(),
		);
		return this.closePromise;
	}

	private invokeContextClose(): Promise<boolean> {
		this.insideInjectedCall = true;
		try {
			return this.contextClose();
		} finally {
			this.insideInjectedCall = false;
		}
	}

	private async ensureOrdered(envelope: RemoteHostFrameEnvelope): Promise<RemoteRelayEnsureResult> {
		let lookup: unknown;
		this.insideInjectedCall = true;
		try {
			lookup = this.getOutboundRelay();
		} catch {
			this.insideInjectedCall = false;
			return deferred();
		}
		this.insideInjectedCall = false;
		const send = relayFromLookup(lookup);
		if (send === "unavailable") return deferred();
		if (!send) return this.poison();

		let rawPromise: unknown;
		this.insideInjectedCall = true;
		try {
			rawPromise = send(envelope);
		} catch {
			this.insideInjectedCall = false;
			return deferred();
		}
		this.insideInjectedCall = false;
		const observed = await observe(rawPromise);
		if (observed.status !== "fulfilled") return deferred();
		const outcome = sendOutcome(observed.value, envelope.frameId);
		if (outcome === "persisted") return persisted();
		if (outcome === "deferred") return deferred();
		return this.poison();
	}

	private poison(): RemoteRelayEnsureResult {
		this.poisoned = true;
		return failed();
	}
}

export async function createRemoteRelayDispatcher(raw: unknown): Promise<CreateRemoteRelayDispatcherResult> {
	const contextClose = acquireClose(raw);
	const fail = async (): Promise<CreateRemoteRelayDispatcherResult> => {
		if (!contextClose) return factoryFailed("INVALID_ARGUMENT");
		return (await contextClose()) ? factoryFailed("INVALID_ARGUMENT") : factoryFailed("CLOSE_UNCERTAIN");
	};
	const found = exact(raw, FACTORY_KEYS);
	if (!found || typeof raw !== "object" || raw === null || !contextClose) return await fail();
	const getOutboundRelay = bind(raw, found, "getOutboundRelay");
	const closeMethod = value(found, "close");
	const getterMethod = value(found, "getOutboundRelay");
	if (!getOutboundRelay || closeMethod === getterMethod) return await fail();
	const impl = new RemoteRelayDispatcherImpl(getOutboundRelay, contextClose);
	const dispatcher: RemoteRelayDispatcher = Object.freeze({
		close: (): Promise<RemoteRelayCloseResult> => impl.close(),
		ensure: (input: unknown): Promise<RemoteRelayEnsureResult> => impl.ensure(input),
	});
	return Object.freeze({ ok: true as const, dispatcher });
}
