import { types } from "node:util";

const INPUT_KEYS = new Set(["inboundRetry", "outboundInbox", "relay"]);
const RELAY_KEYS = new Set(["close", "receive"]);
const OUTBOUND_KEYS = new Set(["authorizeAdmit", "close", "dispatchPending"]);
const RETRY_KEYS = new Set(["dispatchPending"]);
const SUCCESS_KEYS = new Set(["ok", "value"]);
const FAILURE_KEYS = new Set(["error", "ok"]);
const ERROR_KEYS = new Set(["code"]);
const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

export type BidirectionalTargetEntryErrorCode = "CLOSED" | "REENTRY" | "UNCERTAIN";
export type BidirectionalTargetEntryResult =
	| Readonly<{ ok: true; value: undefined }>
	| Readonly<{ ok: false; error: Readonly<{ code: BidirectionalTargetEntryErrorCode }> }>;

export interface BidirectionalTargetInboxEntry {
	readonly receive: (raw: unknown) => Promise<BidirectionalTargetEntryResult>;
	readonly send: (raw: unknown) => Promise<BidirectionalTargetEntryResult>;
	readonly dispatchPending: () => Promise<BidirectionalTargetEntryResult>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export type CreateBidirectionalTargetInboxEntryResult =
	| Readonly<{ ok: true; value: BidirectionalTargetInboxEntry }>
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

function rawDescriptors(raw: unknown): Descriptors | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw) || Object.getPrototypeOf(raw) !== Object.prototype) return null;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return null;
		return Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}
}

function exact(raw: unknown, keys: ReadonlySet<string>): Descriptors | null {
	const found = rawDescriptors(raw);
	if (!found) return null;
	const names = Object.getOwnPropertyNames(found);
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = found[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return found;
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

function childValue(raw: unknown, name: string): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

function success(): BidirectionalTargetEntryResult {
	return Object.freeze({ ok: true as const, value: undefined });
}

function failure(code: BidirectionalTargetEntryErrorCode): BidirectionalTargetEntryResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function factoryFailure(code: "CLOSE_UNCERTAIN" | "INVALID_ARGUMENT"): CreateBidirectionalTargetInboxEntryResult {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function observe(raw: unknown, timeoutMs: number): Promise<Observation> {
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

function operationResult(raw: unknown, requireVoid: boolean): "failure" | "malformed" | "success" {
	const succeeded = exact(raw, SUCCESS_KEYS);
	if (succeeded && value(succeeded, "ok") === true && (!requireVoid || value(succeeded, "value") === undefined))
		return "success";
	const failed = exact(raw, FAILURE_KEYS);
	if (!failed || value(failed, "ok") !== false) return "malformed";
	const error = exact(value(failed, "error"), ERROR_KEYS);
	if (!error) return "malformed";
	const code = value(error, "code");
	return typeof code === "string" && code.length > 0 && code.length <= 64 ? "failure" : "malformed";
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
			let rawPromise: unknown;
			try {
				rawPromise = bound();
			} catch {
				return false;
			}
			const observed = await observe(rawPromise, CLOSE_TIMEOUT_MS);
			return observed.status === "fulfilled" && operationResult(observed.value, true) === "success";
		})();
		return shared;
	};
}

async function closeReverse(owners: readonly CloseOwner[]): Promise<boolean> {
	let confirmed = true;
	for (let index = owners.length - 1; index >= 0; index -= 1) {
		try {
			if (!(await owners[index]())) confirmed = false;
		} catch {
			confirmed = false;
		}
	}
	return confirmed;
}

class BidirectionalTargetInboxEntryImpl {
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	private closeRequested = false;
	private poisoned = false;
	private insideInjectedCall = false;

	constructor(
		private readonly inboundDispatch: BoundMethod,
		private readonly outboundDispatch: BoundMethod,
		private readonly relayClose: CloseOwner,
		private readonly outboundClose: CloseOwner,
	) {}

	call(method: BoundMethod, args: readonly unknown[]): Promise<BidirectionalTargetEntryResult> {
		if (this.insideInjectedCall) return Promise.resolve(failure("REENTRY"));
		if (this.closeRequested) return Promise.resolve(failure("CLOSED"));
		if (this.poisoned) return Promise.resolve(failure("UNCERTAIN"));
		const admitted = this.tail;
		const result = (async (): Promise<BidirectionalTargetEntryResult> => {
			await admitted;
			if (this.poisoned) return failure("UNCERTAIN");
			return await this.callOrdered(method, args, false);
		})();
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	dispatchPending(): Promise<BidirectionalTargetEntryResult> {
		if (this.insideInjectedCall) return Promise.resolve(failure("REENTRY"));
		if (this.closeRequested) return Promise.resolve(failure("CLOSED"));
		if (this.poisoned) return Promise.resolve(failure("UNCERTAIN"));
		const admitted = this.tail;
		const result = (async (): Promise<BidirectionalTargetEntryResult> => {
			await admitted;
			const inbound = await this.callOrdered(this.inboundDispatch, [], true);
			if (!inbound.ok) return inbound;
			return await this.callOrdered(this.outboundDispatch, [], true);
		})();
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	close(): Promise<Readonly<{ status: "closed" | "error" }>> {
		if (this.insideInjectedCall) return Promise.resolve(Object.freeze({ status: "error" as const }));
		if (this.closePromise) return this.closePromise;
		this.closeRequested = true;
		const admitted = this.tail;
		this.closePromise = (async (): Promise<Readonly<{ status: "closed" | "error" }>> => {
			await admitted;
			let confirmed = true;
			if (!(await this.invokeClose(this.outboundClose))) confirmed = false;
			if (!(await this.invokeClose(this.relayClose))) confirmed = false;
			return Object.freeze({ status: confirmed ? ("closed" as const) : ("error" as const) });
		})();
		return this.closePromise;
	}

	private async callOrdered(
		method: BoundMethod,
		args: readonly unknown[],
		requireVoid: boolean,
	): Promise<BidirectionalTargetEntryResult> {
		this.insideInjectedCall = true;
		let rawPromise: unknown;
		try {
			rawPromise = method(...args);
		} catch {
			this.insideInjectedCall = false;
			this.poisoned = true;
			return failure("UNCERTAIN");
		}
		this.insideInjectedCall = false;
		const observed = await observe(rawPromise, OPERATION_TIMEOUT_MS);
		if (observed.status !== "fulfilled") {
			this.poisoned = true;
			return failure("UNCERTAIN");
		}
		const outcome = operationResult(observed.value, requireVoid);
		if (outcome === "success") return success();
		if (outcome === "malformed") this.poisoned = true;
		return failure("UNCERTAIN");
	}

	private invokeClose(owner: CloseOwner): Promise<boolean> {
		this.insideInjectedCall = true;
		try {
			return owner();
		} finally {
			this.insideInjectedCall = false;
		}
	}
}

export async function createBidirectionalTargetInboxEntry(
	raw: unknown,
): Promise<CreateBidirectionalTargetInboxEntryResult> {
	const relayRaw = childValue(raw, "relay");
	const outboundRaw = childValue(raw, "outboundInbox");
	const inboundRaw = childValue(raw, "inboundRetry");
	const relayClose = acquireClose(relayRaw);
	const ownersAliased = relayRaw !== undefined && relayRaw === outboundRaw;
	const outboundClose = ownersAliased ? relayClose : acquireClose(outboundRaw);
	const acquired = relayClose ? [relayClose] : [];
	if (outboundClose && !ownersAliased) acquired.push(outboundClose);
	const fail = async (): Promise<CreateBidirectionalTargetInboxEntryResult> =>
		(await closeReverse(acquired)) ? factoryFailure("INVALID_ARGUMENT") : factoryFailure("CLOSE_UNCERTAIN");

	const input = exact(raw, INPUT_KEYS);
	const relay = exact(relayRaw, RELAY_KEYS);
	const outbound = exact(outboundRaw, OUTBOUND_KEYS);
	const inbound = exact(inboundRaw, RETRY_KEYS);
	if (
		!input ||
		!relay ||
		!outbound ||
		!inbound ||
		!relayClose ||
		!outboundClose ||
		ownersAliased ||
		inboundRaw === relayRaw ||
		inboundRaw === outboundRaw ||
		typeof relayRaw !== "object" ||
		relayRaw === null ||
		typeof outboundRaw !== "object" ||
		outboundRaw === null ||
		typeof inboundRaw !== "object" ||
		inboundRaw === null
	)
		return await fail();

	const receive = bind(relayRaw, relay, "receive");
	const authorizeAdmit = bind(outboundRaw, outbound, "authorizeAdmit");
	const outboundDispatch = bind(outboundRaw, outbound, "dispatchPending");
	const inboundDispatch = bind(inboundRaw, inbound, "dispatchPending");
	if (!receive || !authorizeAdmit || !outboundDispatch || !inboundDispatch) return await fail();

	const impl = new BidirectionalTargetInboxEntryImpl(inboundDispatch, outboundDispatch, relayClose, outboundClose);
	const entry: BidirectionalTargetInboxEntry = Object.freeze({
		close: (): Promise<Readonly<{ status: "closed" | "error" }>> => impl.close(),
		dispatchPending: (): Promise<BidirectionalTargetEntryResult> => impl.dispatchPending(),
		receive: (input: unknown): Promise<BidirectionalTargetEntryResult> => impl.call(receive, [input]),
		send: (input: unknown): Promise<BidirectionalTargetEntryResult> => impl.call(authorizeAdmit, [input]),
	});
	return Object.freeze({ ok: true as const, value: entry });
}
