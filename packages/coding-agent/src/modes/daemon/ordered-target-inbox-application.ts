import { types } from "node:util";
import type { RemoteHostAgentMessageFrame, RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	decodeAgentMessageFrame,
	decodeEnvelope,
	digestsEqual,
	isValidDigest,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const FACTORY_KEYS = new Set(["preAuthorizedInbox"]);
const PREAUTH_KEYS = new Set(["authorizeAdmit", "close", "dispatchPending"]);
const APPLY_INPUT_KEYS = new Set(["envelope"]);
const RELATIONSHIP_VALUES = new Set(["child", "parent", "sibling"]);

const AUTHORIZER_ERROR_CODES = new Set([
	"CLOSED",
	"CLOSE_UNCERTAIN",
	"COLLISION",
	"INVALID_ARGUMENT",
	"MISMATCH",
	"NOT_FOUND",
	"POISONED",
	"RECOVERY_FAILED",
	"UNCERTAIN",
	"UNAUTHORIZED",
	"STALE",
]);
const OPERATION_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 5_000;

// ===========================================================================
// Result types
// ===========================================================================

export type OrderedTargetApplyResult = Readonly<{ status: "applied" }> | Readonly<{ status: "error" }>;
export type OrderedTargetCloseResult = Readonly<{ status: "closed" }> | Readonly<{ status: "error" }>;

export type OrderedTargetRetryResult =
	| Readonly<{ ok: true; value: undefined }>
	| Readonly<{ ok: false; error: Readonly<{ code: "CLOSED" | "POISONED" }> }>;

export interface OrderedTargetApplication {
	readonly apply: (raw: unknown) => Promise<OrderedTargetApplyResult>;
	readonly close: () => Promise<OrderedTargetCloseResult>;
}

export interface OrderedTargetRetry {
	readonly dispatchPending: () => Promise<OrderedTargetRetryResult>;
}

export type CreateOrderedTargetErrorCode = "CLOSE_UNCERTAIN" | "INVALID_ARGUMENT";

export type CreateOrderedTargetResult =
	| Readonly<{
			ok: true;
			application: OrderedTargetApplication;
			retry: OrderedTargetRetry;
	  }>
	| Readonly<{ ok: false; error: Readonly<{ code: CreateOrderedTargetErrorCode }> }>;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type OwnedClose = () => Promise<boolean>;

interface NativePromiseObservation {
	readonly status: "fulfilled" | "rejected" | "timeout" | "invalid";
	readonly value?: unknown;
}

// ===========================================================================
// Descriptor helpers
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
	if (names.length !== keys.size || names.some((name) => !keys.has(name))) return null;
	for (const name of names) {
		const descriptor = descriptors[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}
	return descriptors;
}

function value(descriptors: Descriptors, name: string): unknown {
	const d = descriptors[name];
	return d && "value" in d ? d.value : undefined;
}

function bind(raw: object, descriptor: PropertyDescriptor): BoundMethod | null {
	const dValue = descriptor.value;
	if (typeof dValue !== "function") return null;
	try {
		if (types.isProxy(dValue)) return null;
		return (...args: readonly unknown[]): unknown => Reflect.apply(dValue, raw, args);
	} catch {
		return null;
	}
}

function method(raw: unknown, name: string): BoundMethod | null {
	if (typeof raw !== "object" || raw === null) return null;
	const d = Object.getOwnPropertyDescriptor(raw, name);
	if (!d || !("value" in d) || !d.enumerable) return null;
	return bind(raw, d);
}

// ===========================================================================
// Native promise helpers
// ===========================================================================

function isNativePromise(raw: unknown): raw is Promise<unknown> {
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

function observePromise(raw: unknown, timeoutMs: number): Promise<NativePromiseObservation> {
	if (!isNativePromise(raw)) {
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
				(v: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(Object.freeze({ status: "fulfilled" as const, value: v }));
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

function invoke(call: () => unknown, timeoutMs: number): Promise<NativePromiseObservation> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return Promise.resolve(Object.freeze({ status: "rejected" as const }));
	}
	return observePromise(raw, timeoutMs);
}

// ===========================================================================
// Result builders
// ===========================================================================

function applied(): OrderedTargetApplyResult {
	return Object.freeze({ status: "applied" as const });
}

function errorResult(): OrderedTargetApplyResult {
	return Object.freeze({ status: "error" as const });
}

function closedResult(): OrderedTargetCloseResult {
	return Object.freeze({ status: "closed" as const });
}

function closeErrorResult(): OrderedTargetCloseResult {
	return Object.freeze({ status: "error" as const });
}

// ===========================================================================
// Owned close — PreAuthorizedInbox.close() returns AuthorizerResult<void>
// i.e. {ok:true, value:undefined} or {ok:false, error:{code:...}}
// ===========================================================================

function acquireClose(raw: unknown): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	let d: PropertyDescriptor | undefined;
	try {
		if (types.isProxy(raw)) return null;
		d = Object.getOwnPropertyDescriptor(raw, "close");
	} catch {
		return null;
	}
	if (!d || !("value" in d) || !d.enumerable) return null;
	const fn = d.value;
	if (typeof fn !== "function") return null;
	try {
		if (types.isProxy(fn)) return null;
	} catch {
		return null;
	}
	const bound = (...args: readonly unknown[]): unknown => Reflect.apply(fn, raw, args);
	let used = false;
	return async (): Promise<boolean> => {
		if (used) return false;
		used = true;
		const observation = await invoke(() => bound(), CLOSE_TIMEOUT_MS);
		if (observation.status !== "fulfilled") return false;
		// AuthorizerResult<void>: {ok:true, value:undefined}
		const r = exact(observation.value, new Set(["ok", "value"]));
		if (!r) return false;
		return value(r, "ok") === true && value(r, "value") === undefined;
	};
}

// ===========================================================================
// Decode exact PreAuthorizedInbox authorizeAdmit success result
// ===========================================================================

const ADMIT_OUTPUT_REQUIRED = new Set(["allowed", "relationship", "receipt"]);
const RELATIONSHIP_KEYS = new Set(["fromRelationship"]);
const RECEIPT_REQUIRED = new Set(["frameId", "receipt", "semanticDigest", "semanticId", "status"]);
const RECEIPT_INNER_REQUIRED = new Set(["sequence", "sha256", "size"]);

function decodeAuthorizeAdmitSuccess(raw: unknown): {
	allowed: true;
	relationship: string;
	receipt: {
		status: "queued";
		receipt: { sequence: number; size: number; sha256: string };
		frameId: string;
		semanticId: string;
		semanticDigest: string;
	};
} | null {
	if (typeof raw !== "object" || raw === null) return null;
	const d = exact(raw, ADMIT_OUTPUT_REQUIRED);
	if (!d) return null;
	if (value(d, "allowed") !== true) return null;
	const relRaw = value(d, "relationship");
	const relD = exact(relRaw, RELATIONSHIP_KEYS);
	if (!relD) return null;
	const fromRel = value(relD, "fromRelationship");
	if (typeof fromRel !== "string" || !RELATIONSHIP_VALUES.has(fromRel)) return null;
	const recvRaw = value(d, "receipt");
	const recvD = exact(recvRaw, RECEIPT_REQUIRED);
	if (!recvD) return null;
	if (value(recvD, "status") !== "queued") return null;
	const frameId = value(recvD, "frameId");
	const semId = value(recvD, "semanticId");
	const semDigest = value(recvD, "semanticDigest");
	if (typeof frameId !== "string") return null;
	if (typeof semId !== "string") return null;
	if (typeof semDigest !== "string" || !isValidDigest(semDigest)) return null;
	const innerRaw = value(recvD, "receipt");
	const innerD = exact(innerRaw, RECEIPT_INNER_REQUIRED);
	if (!innerD) return null;
	const seq = value(innerD, "sequence");
	const sz = value(innerD, "size");
	const s256 = value(innerD, "sha256");
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return null;
	if (typeof sz !== "number" || !Number.isSafeInteger(sz) || sz <= 0) return null;
	if (typeof s256 !== "string" || !isValidDigest(s256)) return null;
	return Object.freeze({
		allowed: true as const,
		relationship: fromRel,
		receipt: Object.freeze({
			status: "queued" as const,
			receipt: Object.freeze({ sequence: seq, size: sz, sha256: s256 }),
			frameId,
			semanticId: semId,
			semanticDigest: semDigest,
		}),
	});
}

// ===========================================================================
// AuthorizerResult<{code:string}> failure codes that represent fatal
// relay-level failures causing poison.
// ===========================================================================

// ===========================================================================
// Factory — ownership-first
// ===========================================================================

export async function createOrderedTargetInboxApplication(raw: unknown): Promise<CreateOrderedTargetResult> {
	// Phase 1: preliminary extraction — catch any isProxy throw
	let preAuthRaw: unknown;
	let ownershipUncertain = false;
	if (typeof raw === "object" && raw !== null) {
		try {
			if (types.isProxy(raw)) {
				ownershipUncertain = true;
			} else {
				const descriptor = Object.getOwnPropertyDescriptor(raw, "preAuthorizedInbox");
				if (descriptor && "value" in descriptor) preAuthRaw = descriptor.value;
				else if (descriptor) ownershipUncertain = true;
			}
		} catch {
			ownershipUncertain = true;
		}
	}

	// Phase 2: acquire close before validation
	const preAuthClose = acquireClose(preAuthRaw);
	if (typeof preAuthRaw === "object" && preAuthRaw !== null && preAuthClose === null) {
		ownershipUncertain = true;
	}
	const ownedCloses: OwnedClose[] = [];
	if (preAuthClose) ownedCloses.push(preAuthClose);

	const failFactory = async (code: CreateOrderedTargetErrorCode): Promise<CreateOrderedTargetResult> => {
		const ok = await closeAll(ownedCloses);
		return Object.freeze({
			ok: false as const,
			error: Object.freeze({ code: ok && !ownershipUncertain ? code : "CLOSE_UNCERTAIN" }),
		});
	};

	// Phase 3: validate factory input
	const descriptors = exact(raw, FACTORY_KEYS);
	if (!descriptors) return await failFactory("INVALID_ARGUMENT");

	// Phase 4: validate preAuthorizedInbox object
	const preAuth = value(descriptors, "preAuthorizedInbox");
	const preAuthDesc = rawDescriptors(preAuth);
	if (!preAuthDesc) return await failFactory("INVALID_ARGUMENT");
	const preAuthNames = Object.getOwnPropertyNames(preAuthDesc);
	if (preAuthNames.length !== PREAUTH_KEYS.size || preAuthNames.some((n) => !PREAUTH_KEYS.has(n))) {
		return await failFactory("INVALID_ARGUMENT");
	}
	if (!preAuthClose) return await failFactory("INVALID_ARGUMENT");

	const authorizeAdmit = method(preAuth, "authorizeAdmit");
	const dispatchPending = method(preAuth, "dispatchPending");
	if (!authorizeAdmit || !dispatchPending) return await failFactory("INVALID_ARGUMENT");

	const impl = new OrderedTargetInboxImpl(authorizeAdmit, dispatchPending, preAuthClose);

	return Object.freeze({
		ok: true as const,
		application: Object.freeze({
			apply: (r: unknown): Promise<OrderedTargetApplyResult> => impl.apply(r),
			close: (): Promise<OrderedTargetCloseResult> => impl.close(),
		}),
		retry: Object.freeze({
			dispatchPending: (): Promise<OrderedTargetRetryResult> => impl.dispatch(),
		}),
	});
}

async function closeAll(closes: readonly OwnedClose[]): Promise<boolean> {
	let allOk = true;
	for (const c of closes) {
		const ok = await c().catch(() => false);
		if (!ok) allOk = false;
	}
	return allOk;
}

// ===========================================================================
// Implementation
// ===========================================================================

class OrderedTargetInboxImpl {
	private operationTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<OrderedTargetCloseResult> | null = null;
	private closed = false;
	private poisoned = false;
	private insideCapabilityCall = false;

	constructor(
		private readonly authorizeAdmitBound: BoundMethod,
		private readonly dispatchBound: BoundMethod,
		private readonly closeOwned: OwnedClose,
	) {}

	// -----------------------------------------------------------------------
	// Apply
	// -----------------------------------------------------------------------

	async apply(raw: unknown): Promise<OrderedTargetApplyResult> {
		if (this.insideCapabilityCall) {
			this.poisoned = true;
			return errorResult();
		}
		if (this.closed) return errorResult();
		if (this.poisoned) {
			return errorResult();
		}

		const d = exact(raw, APPLY_INPUT_KEYS);
		if (!d) return this.poison();
		const envelopeValue = value(d, "envelope");

		const decoded = decodeEnvelope(envelopeValue);
		if (!decoded.ok) return this.poison();
		const envelope = decoded.value;
		if (envelope.frame.type !== "agent_message") return this.poison();

		const agentDecoded = decodeAgentMessageFrame(envelope.frame);
		if (!agentDecoded.ok) return this.poison();
		const agentFrame = agentDecoded.value;

		const digestResult = canonicalDigest(agentFrame);
		if (!digestResult.ok) return this.poison();

		const computedDigest = digestResult.value;

		return this.enqueueApply(() => this.applyOrdered(envelope, agentFrame, computedDigest));
	}

	private async applyOrdered(
		envelope: RemoteHostFrameEnvelope,
		agentFrame: RemoteHostAgentMessageFrame,
		computedDigest: string,
	): Promise<OrderedTargetApplyResult> {
		// Guard only the SYNCHRONOUS invocation, not the async observation wait.
		// insideCapabilityCall prevents reentrant calls from INSIDE the bound
		// function's synchronous execution, not from the event loop after it returns.
		let observation: NativePromiseObservation;
		this.insideCapabilityCall = true;
		try {
			const pending = invoke(() => this.authorizeAdmitBound(Object.freeze({ envelope })), OPERATION_TIMEOUT_MS);
			this.insideCapabilityCall = false;
			observation = await pending;
		} finally {
			this.insideCapabilityCall = false;
		}

		if (observation.status !== "fulfilled") return this.poison();

		// After the bound call, check for reentrant corruption
		if (this.poisoned) {
			return errorResult();
		}

		const authOverall = observation.value;
		if (typeof authOverall !== "object" || authOverall === null) return this.poison();

		// AuthorizerResult<AuthorizeAndAdmitOutput>: {ok:true, value:...} | {ok:false, error:{code:...}}
		const authOkD = exact(authOverall, new Set(["ok", "value"]));
		const authErrD = exact(authOverall, new Set(["ok", "error"]));

		if (authErrD) {
			// Must have ok === false and fixed error code
			const okVal = value(authErrD, "ok");
			const errRaw = value(authErrD, "error");
			const errD = errRaw ? exact(errRaw, new Set(["code"])) : null;
			if (okVal !== false || !errD) return this.poison();
			const c = value(errD, "code");
			if (typeof c !== "string" || !AUTHORIZER_ERROR_CODES.has(c)) return this.poison();
			// Structured failure — all authorize failures poison the relay
			this.poisoned = true;
			return errorResult();
		}

		if (!authOkD) return this.poison();
		if (value(authOkD, "ok") !== true) return this.poison();

		const outputValue = value(authOkD, "value");
		const decodedAdmit = decodeAuthorizeAdmitSuccess(outputValue);
		if (!decodedAdmit) return this.poison();

		// Validate field consistency
		if (decodedAdmit.receipt.frameId !== envelope.frameId) return this.poison();
		if (decodedAdmit.receipt.semanticId !== agentFrame.id) return this.poison();
		if (!digestsEqual(decodedAdmit.receipt.semanticDigest, computedDigest)) return this.poison();

		return applied();
	}

	// -----------------------------------------------------------------------
	// DispatchPending
	// -----------------------------------------------------------------------

	async dispatch(): Promise<OrderedTargetRetryResult> {
		if (this.insideCapabilityCall) {
			this.poisoned = true;
			return this.failRetry("POISONED");
		}
		if (this.closed) {
			return Object.freeze({ ok: false as const, error: Object.freeze({ code: "CLOSED" as const }) });
		}
		if (this.poisoned) {
			return Object.freeze({ ok: false as const, error: Object.freeze({ code: "POISONED" as const }) });
		}
		return this.enqueueDispatch(() => this.dispatchOrdered());
	}

	private async dispatchOrdered(): Promise<OrderedTargetRetryResult> {
		// Guard only the synchronous invocation, not the async wait
		let observation: NativePromiseObservation;
		this.insideCapabilityCall = true;
		try {
			const pending = invoke(() => this.dispatchBound(), OPERATION_TIMEOUT_MS);
			this.insideCapabilityCall = false;
			observation = await pending;
		} finally {
			this.insideCapabilityCall = false;
		}

		if (observation.status !== "fulfilled") return this.failRetry("POISONED");

		// After observation, check reentrant corruption
		if (this.poisoned)
			return Object.freeze({ ok: false as const, error: Object.freeze({ code: "POISONED" as const }) });

		const raw = observation.value;
		if (typeof raw !== "object" || raw === null) return this.failRetry("POISONED");

		// Check success: {ok:true, value:undefined}
		const okD = exact(raw, new Set(["ok", "value"]));
		if (okD && value(okD, "ok") === true && value(okD, "value") === undefined) {
			return Object.freeze({ ok: true as const, value: undefined });
		}

		// Check error: {ok:false, error:{code: AuthorizerErrorCode}}
		const errD = exact(raw, new Set(["ok", "error"]));
		if (errD && value(errD, "ok") === false) {
			const errRaw = value(errD, "error");
			const codeD = exact(errRaw, new Set(["code"]));
			if (codeD) {
				const c = value(codeD, "code");
				if (typeof c !== "string" || !AUTHORIZER_ERROR_CODES.has(c)) return this.failRetry("POISONED");
				// Any PreAuthorizedInbox dispatch failure is fatal for this adapter
				this.poisoned = true;
				return Object.freeze({ ok: false as const, error: Object.freeze({ code: "POISONED" as const }) });
			}
		}

		return this.failRetry("POISONED");
	}

	private failRetry(_code: string): OrderedTargetRetryResult {
		this.poisoned = true;
		return Object.freeze({ ok: false as const, error: Object.freeze({ code: "POISONED" as const }) });
	}

	// -----------------------------------------------------------------------
	// Close
	// -----------------------------------------------------------------------

	close(): Promise<OrderedTargetCloseResult> {
		if (this.insideCapabilityCall) {
			// Schedule close on current tail, store shared promise, return immediate error
			this.closed = true;
			this.poisoned = true;
			if (this.closePromise === null) {
				const shared: Promise<OrderedTargetCloseResult> = this.operationTail.then(
					() => this.closeOrdered(),
					() => this.closeOrdered(),
				);
				this.closePromise = shared;
				this.operationTail = shared.then(
					() => undefined,
					() => undefined,
				);
			}
			return Promise.resolve(closeErrorResult());
		}
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;

		const shared: Promise<OrderedTargetCloseResult> = this.operationTail.then(
			() => this.closeOrdered(),
			() => this.closeOrdered(),
		);
		this.closePromise = shared;
		this.operationTail = shared.then(
			() => undefined,
			() => undefined,
		);
		return shared;
	}

	private async closeOrdered(): Promise<OrderedTargetCloseResult> {
		const ok = await this.closeOwned().catch(() => false);
		return ok ? closedResult() : closeErrorResult();
	}

	// =======================================================================
	// Serialization
	// =======================================================================

	private enqueueApply(operation: () => Promise<OrderedTargetApplyResult>): Promise<OrderedTargetApplyResult> {
		const attempted = this.operationTail.then(
			() => {
				if (this.poisoned) {
					return errorResult();
				}
				return operation();
			},
			() => {
				this.poisoned = true;
				return errorResult();
			},
		);
		const result = attempted.then(
			(v) => v,
			() => {
				this.poisoned = true;
				return errorResult();
			},
		);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private enqueueDispatch(operation: () => Promise<OrderedTargetRetryResult>): Promise<OrderedTargetRetryResult> {
		const attempted = this.operationTail.then(
			() => (this.poisoned ? Promise.resolve(this.failRetry("POISONED")) : operation()),
			() => {
				this.poisoned = true;
				return Promise.resolve(this.failRetry("POISONED"));
			},
		);
		const result = attempted.then(
			(v) => v,
			() => {
				this.poisoned = true;
				return Promise.resolve(this.failRetry("POISONED"));
			},
		);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private poison(): OrderedTargetApplyResult {
		this.poisoned = true;
		return errorResult();
	}
}
