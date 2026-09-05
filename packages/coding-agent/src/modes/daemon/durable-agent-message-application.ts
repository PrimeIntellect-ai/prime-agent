import { types } from "node:util";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { decodeEnvelope } from "./remote-host-frame-codec.js";

const INPUT_KEYS = new Set(["router"]);
const ROUTER_KEYS = new Set(["authorize", "close", "deliverIdempotently"]);
const APPLY_KEYS = new Set(["envelope"]);
const AUTH_RESULT_KEYS = new Set(["status"]);
const DELIVERY_RESULT_KEYS = new Set(["messageId", "status", "targetActiveSessionId"]);
const CLOSE_RESULT_KEYS = new Set(["status"]);
const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type DurableAgentMessageErrorCode =
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "INVALID_ARGUMENT"
	| "ROUTER_UNCERTAIN"
	| "UNAUTHORIZED";

export type DurableAgentMessageApplyResult = Readonly<{ status: "applied" | "error" }>;

export interface DurableAgentMessageApplicationCapability {
	readonly apply: (raw: unknown) => Promise<DurableAgentMessageApplyResult>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export type CreateDurableAgentMessageApplicationResult =
	| Readonly<{ ok: true; application: DurableAgentMessageApplicationCapability }>
	| Readonly<{
			ok: false;
			error: Readonly<{ code: DurableAgentMessageErrorCode }>;
	  }>;

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type Observed =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

interface RouterCapability {
	readonly authorize: BoundMethod;
	readonly deliverIdempotently: BoundMethod;
	readonly close: BoundMethod;
}

function createFailure(code: DurableAgentMessageErrorCode): CreateDurableAgentMessageApplicationResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		const names = Object.getOwnPropertyNames(raw);
		if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
		const descriptors = Object.getOwnPropertyDescriptors(raw);
		for (const name of names) {
			const descriptor = descriptors[name];
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
		}
		return descriptors;
	} catch {
		return null;
	}
}

function bind(raw: object, descriptor: PropertyDescriptor): BoundMethod | null {
	if (!("value" in descriptor) || typeof descriptor.value !== "function") return null;
	try {
		if (types.isProxy(descriptor.value)) return null;
		const callable = descriptor.value as CallableFunction;
		return (...args: readonly unknown[]): unknown => Reflect.apply(callable, raw, args);
	} catch {
		return null;
	}
}

function discoverRouter(raw: unknown): Readonly<{ close: BoundMethod | null; router: RouterCapability | null }> {
	if (typeof raw !== "object" || raw === null) return Object.freeze({ close: null, router: null });
	try {
		if (types.isProxy(raw)) return Object.freeze({ close: null, router: null });
		const closeDescriptor = Object.getOwnPropertyDescriptor(raw, "close");
		const close = closeDescriptor ? bind(raw, closeDescriptor) : null;
		if (!close) return Object.freeze({ close: null, router: null });
		const descriptors = exact(raw, ROUTER_KEYS);
		if (!descriptors) return Object.freeze({ close, router: null });
		const authorize = bind(raw, descriptors.authorize);
		const deliverIdempotently = bind(raw, descriptors.deliverIdempotently);
		if (!authorize || !deliverIdempotently) return Object.freeze({ close, router: null });
		return Object.freeze({
			close,
			router: Object.freeze({ authorize, deliverIdempotently, close }),
		});
	} catch {
		return Object.freeze({ close: null, router: null });
	}
}

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		return (
			!types.isProxy(raw) &&
			Object.getPrototypeOf(raw) === Promise.prototype &&
			Object.getOwnPropertyNames(raw).length === 0 &&
			Object.getOwnPropertySymbols(raw).length === 0
		);
	} catch {
		return false;
	}
}

function observe(raw: unknown, timeoutMs: number): Promise<Observed> {
	if (!isNativePromise(raw)) return Promise.resolve(Object.freeze({ status: "invalid" as const }));
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: "timeout" as const }));
		}, timeoutMs);
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(value: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value }));
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

function invoke(call: () => unknown, timeoutMs: number): Promise<Observed> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
	return observe(raw, timeoutMs);
}

function fixedApply(status: "applied" | "error"): DurableAgentMessageApplyResult {
	return Object.freeze({ status });
}

class DurableAgentMessageApplication {
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	private closed = false;
	private poisoned = false;

	constructor(private readonly router: RouterCapability) {}

	capability(): DurableAgentMessageApplicationCapability {
		return Object.freeze({
			apply: (raw: unknown) => this.apply(raw),
			close: () => this.close(),
		});
	}

	private apply(raw: unknown): Promise<DurableAgentMessageApplyResult> {
		if (this.closed || this.poisoned) return Promise.resolve(fixedApply("error"));
		const descriptors = exact(raw, APPLY_KEYS);
		const decoded = decodeEnvelope(descriptors?.envelope?.value);
		if (!descriptors || !decoded.ok || decoded.value.frame.type !== "agent_message") {
			return Promise.resolve(fixedApply("error"));
		}
		const result = this.tail.then(
			() => (this.poisoned ? fixedApply("error") : this.applyOrdered(decoded.value)),
			() => {
				this.poisoned = true;
				return fixedApply("error");
			},
		);
		const safe = result.then(
			(value) => value,
			() => {
				this.poisoned = true;
				return fixedApply("error");
			},
		);
		this.tail = safe.then(() => undefined);
		return safe;
	}

	private async applyOrdered(envelope: RemoteHostFrameEnvelope): Promise<DurableAgentMessageApplyResult> {
		if (envelope.frame.type !== "agent_message") return fixedApply("error");
		const frame = envelope.frame;
		const authorization = await invoke(
			() =>
				this.router.authorize(
					Object.freeze({
						messageId: frame.id,
						transportFrameId: envelope.frameId,
						fromActiveSessionId: frame.fromActiveSessionId,
						targetActiveSessionId: frame.targetActiveSessionId,
					}),
				),
			OPERATION_TIMEOUT_MS,
		);
		if (authorization.status !== "fulfilled") return this.poison();
		const authResult = exact(authorization.value, AUTH_RESULT_KEYS);
		if (!authResult || authResult.status.value !== "allowed") return this.poison();
		const delivered = await invoke(
			() =>
				this.router.deliverIdempotently(
					Object.freeze({
						messageId: frame.id,
						idempotencyKey: frame.id,
						transportFrameId: envelope.frameId,
						fromActiveSessionId: frame.fromActiveSessionId,
						targetActiveSessionId: frame.targetActiveSessionId,
						message: frame.message,
						deliveryMode: frame.deliveryMode ?? "queued",
					}),
				),
			OPERATION_TIMEOUT_MS,
		);
		if (delivered.status !== "fulfilled") return this.poison();
		const delivery = exact(delivered.value, DELIVERY_RESULT_KEYS);
		if (
			!delivery ||
			(delivery.status.value !== "delivered" && delivery.status.value !== "queued") ||
			delivery.messageId.value !== frame.id ||
			delivery.targetActiveSessionId.value !== frame.targetActiveSessionId
		) {
			return this.poison();
		}
		return fixedApply("applied");
	}

	private poison(): DurableAgentMessageApplyResult {
		this.poisoned = true;
		return fixedApply("error");
	}

	private close(): Promise<Readonly<{ status: "closed" | "error" }>> {
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;
		this.closePromise = this.tail.then(
			() => this.closeRouter(),
			() => this.closeRouter(),
		);
		this.tail = this.closePromise.then(() => undefined);
		return this.closePromise;
	}

	private async closeRouter(): Promise<Readonly<{ status: "closed" | "error" }>> {
		const observed = await invoke(() => this.router.close(), CLOSE_TIMEOUT_MS);
		if (observed.status !== "fulfilled") return Object.freeze({ status: "error" as const });
		const result = exact(observed.value, CLOSE_RESULT_KEYS);
		return Object.freeze({ status: result?.status?.value === "closed" ? "closed" : "error" });
	}
}

export async function createDurableAgentMessageApplication(
	raw: unknown,
): Promise<CreateDurableAgentMessageApplicationResult> {
	const preliminary =
		typeof raw === "object" && raw !== null && !types.isProxy(raw)
			? Object.getOwnPropertyDescriptor(raw, "router")
			: undefined;
	const routerRaw = preliminary && "value" in preliminary ? preliminary.value : undefined;
	const discovery = discoverRouter(routerRaw);
	let closeUsed = false;
	const closeDiscovered = async (): Promise<boolean> => {
		if (!discovery.close) return true;
		if (closeUsed) return false;
		closeUsed = true;
		const observed = await invoke(() => discovery.close?.(), CLOSE_TIMEOUT_MS);
		if (observed.status !== "fulfilled") return false;
		const result = exact(observed.value, CLOSE_RESULT_KEYS);
		return result?.status?.value === "closed";
	};
	const fail = async (code: DurableAgentMessageErrorCode): Promise<CreateDurableAgentMessageApplicationResult> =>
		(await closeDiscovered()) ? createFailure(code) : createFailure("CLOSE_UNCERTAIN");
	const input = exact(raw, INPUT_KEYS);
	if (!input || !discovery.close || !discovery.router) return await fail("INVALID_ARGUMENT");
	const router = discovery.router;
	const ownedRouter: RouterCapability = Object.freeze({
		...router,
		close: (): unknown => {
			if (closeUsed) return Promise.resolve(Object.freeze({ status: "error" as const }));
			closeUsed = true;
			return router.close();
		},
	});
	const implementation = new DurableAgentMessageApplication(ownedRouter);
	return Object.freeze({ ok: true as const, application: implementation.capability() });
}
