import { types } from "node:util";
import type { RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import { decodeEnvelope } from "./remote-host-frame-codec.js";

// ===========================================================================
// Constants
// ===========================================================================

const FACTORY_KEYS = new Set(["command", "event", "agentMessage", "providerProxy"]);
const CAPABILITY_KEYS = new Set(["apply", "close"]);
const APPLY_INPUT_KEYS = new Set(["envelope"]);
const APPLY_RESULT_KEYS = new Set(["status"]);
const CLOSE_RESULT_KEYS = new Set(["status"]);

const MAX_DEEP_FREEZE_NODES = 1024;
const MAX_DEEP_FREEZE_DEPTH = 32;

// ===========================================================================
// Result types
// ===========================================================================

export type MultiplexerApplyResult = Readonly<{ readonly status: "applied" }> | Readonly<{ readonly status: "error" }>;

export type MultiplexerCloseResult = Readonly<{ readonly status: "closed" }> | Readonly<{ readonly status: "error" }>;

export interface MultiplexerApplication {
	readonly apply: (raw: unknown) => Promise<MultiplexerApplyResult>;
	readonly close: () => Promise<MultiplexerCloseResult>;
}

export type CreateMultiplexerResult =
	| Readonly<{
			readonly ok: true;
			readonly application: MultiplexerApplication;
	  }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: "INVALID_ARGUMENT" }> }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: "CLOSE_UNCERTAIN" }> }>;

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

interface ValidatedSlot extends OwnedSlot {
	readonly apply: BoundMethod;
}

// ===========================================================================
// Typed constructors
// ===========================================================================

function appliedResult(): MultiplexerApplyResult {
	return Object.freeze({ status: "applied" });
}

function errorResult(): MultiplexerApplyResult {
	return Object.freeze({ status: "error" });
}

function closedResult(): MultiplexerCloseResult {
	return Object.freeze({ status: "closed" });
}

function closeErrorResult(): MultiplexerCloseResult {
	return Object.freeze({ status: "error" });
}

function closeUncertainError(): CreateMultiplexerResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code: "CLOSE_UNCERTAIN" }) });
}

function invalidArgumentError(): CreateMultiplexerResult {
	return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
}

function successResult(app: MultiplexerApplication): CreateMultiplexerResult {
	return Object.freeze({ ok: true, application: app });
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

function bindMethod(raw: object, descriptor: PropertyDescriptor): BoundMethod | null {
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
// Exact native Promise
// ===========================================================================

type PromiseObservation = { readonly fulfilled: true; readonly value: unknown } | { readonly fulfilled: false };

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
		return Promise.resolve({ fulfilled: false });
	}
	return new Promise((resolve) => {
		try {
			Reflect.apply(Promise.prototype.then, raw, [
				(v: unknown) => {
					resolve({ fulfilled: true, value: v });
				},
				() => {
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
		return Promise.resolve({ fulfilled: false });
	}
	return observePromise(raw);
}

// ===========================================================================
// Ownership-first close acquisition
//
// Examine the raw object's OWN descriptors (via Object.getOwnPropertyDescriptors
// which works on any object regardless of prototype). If there is an own
// enumerable `close` function, capture it as an owner. Do NOT validate the
// {apply,close} shape yet — that happens later as capability validation.
//
// This ensures that even if the apply descriptor is malformed, missing, or
// the object has symbols/hidden keys, the close owner is still captured.
// ===========================================================================

function hasCapabilityUncertainty(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return true;
	} catch {
		return true;
	}
	try {
		if (Object.getOwnPropertySymbols(raw).length !== 0) return true;
	} catch {
		return true;
	}
	return false;
}

function captureOwnedClose(raw: unknown): OwnedSlot | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}

	// Use Object.getOwnPropertyDescriptors — works on any prototypal shape.
	let ownDescs: Record<string, PropertyDescriptor>;
	try {
		ownDescs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return null;
	}

	const closeDesc = ownDescs.close;
	if (!closeDesc || !("value" in closeDesc) || !closeDesc.enumerable) return null;
	const closeFn = closeDesc.value;
	if (typeof closeFn !== "function") return null;

	// Symbol-check on the raw object is handled by hasCapabilityUncertainty;
	// still capture the close function here so cleanup can call it.

	try {
		if (types.isProxy(closeFn)) return null;
	} catch {
		return null;
	}

	let used = false;
	const close: OwnedClose = async (): Promise<boolean> => {
		if (used) return false;
		used = true;
		const observation = await invoke(() => Reflect.apply(closeFn, raw, []));
		if (!observation.fulfilled) return false;
		const r = exact(observation.value, CLOSE_RESULT_KEYS);
		return r !== null && value(r, "status") === "closed";
	};

	return Object.freeze({ object: raw, closeFn, close });
}

// ===========================================================================
// Capability validation — from an OwnedSlot, validate that the raw object
// has the exact {apply, close} shape and bind apply.
// ===========================================================================

function validateCapability(raw: unknown, slot: OwnedSlot): ValidatedSlot | null {
	// raw must be an Object.prototype object with exactly {apply, close} value descriptors
	const descriptors = exact(raw, CAPABILITY_KEYS);
	if (!descriptors) return null;

	const apply = bindMethod(raw, descriptors.apply);
	if (!apply) return null;

	return Object.freeze({ object: slot.object, closeFn: slot.closeFn, close: slot.close, apply });
}

// ===========================================================================
// Reverse sequential close
// ===========================================================================

async function closeAllReverse(closes: readonly OwnedClose[]): Promise<boolean> {
	let allOk = true;
	for (let index = closes.length - 1; index >= 0; index -= 1) {
		const ok = await closes[index]().catch(() => false);
		if (!ok) allOk = false;
	}
	return allOk;
}

// ===========================================================================
// Preliminary extraction — captures provable data-value owners.
// Uses Object.getOwnPropertyDescriptors so null/custom prototypes work.
// Returns the slot values even when symbols/hidden keys exist, and marks
// uncertainty so the factory can decide how to fail.
// ===========================================================================

interface PrelimResult {
	readonly command: unknown;
	readonly event: unknown;
	readonly agentMessage: unknown;
	readonly providerProxy: unknown;
	readonly ownershipUncertain: boolean;
}

function extractPreliminary(raw: unknown): PrelimResult {
	const uncertain: PrelimResult = Object.freeze({
		command: undefined,
		event: undefined,
		agentMessage: undefined,
		providerProxy: undefined,
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
		// Always check for symbols AFTER capturing descriptors
		ownDescriptors = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return uncertain;
	}

	const hasSymbols = Object.getOwnPropertySymbols(raw).length !== 0;
	const _ownKeys = Object.getOwnPropertyNames(ownDescriptors);

	const getDataValue = (
		name: string,
	): { readonly value: unknown; readonly present: boolean; readonly uncertain: boolean } => {
		const d = ownDescriptors[name];
		if (d === undefined) return { value: undefined, present: false, uncertain: false };
		if (!("value" in d) || !d.enumerable) return { value: undefined, present: false, uncertain: true };
		return { value: d.value, present: true, uncertain: false };
	};

	const cd = getDataValue("command");
	const ev = getDataValue("event");
	const am = getDataValue("agentMessage");
	const pp = getDataValue("providerProxy");

	// Uncertainty: any hidden/accessor descriptor, OR presence of symbols.
	// Extra own value-type keys do NOT cause uncertainty (they're provable data).
	const ownershipUncertain = cd.uncertain || ev.uncertain || am.uncertain || pp.uncertain || hasSymbols;

	return Object.freeze({
		command: cd.value,
		event: ev.value,
		agentMessage: am.value,
		providerProxy: pp.value,
		ownershipUncertain,
	});
}

// ===========================================================================
// Frame type routing
// ===========================================================================

type SlotName = "command" | "event" | "agentMessage" | "providerProxy";

function slotForFrameType(frameType: string): SlotName | null {
	if (frameType === "command") return "command";
	if (frameType === "event") return "event";
	if (frameType === "agent_message") return "agentMessage";
	if (frameType === "provider_proxy") return "providerProxy";
	return null;
}

// ===========================================================================
// Deep freeze — recursively freezes JSON-safe objects/arrays with bounds
// ===========================================================================

function deepFreeze(raw: unknown, depth: number, budget: { nodes: number }): unknown {
	if (budget.nodes <= 0 || depth > MAX_DEEP_FREEZE_DEPTH) return raw;
	if (typeof raw !== "object" || raw === null) return raw;
	if (Object.isFrozen(raw)) return raw;

	budget.nodes -= 1;

	if (Array.isArray(raw)) {
		for (let i = 0; i < raw.length; i += 1) {
			raw[i] = deepFreeze(raw[i], depth + 1, budget);
		}
		Object.freeze(raw);
		return raw;
	}

	if (Object.getPrototypeOf(raw) !== Object.prototype) return raw;

	const keys = Object.getOwnPropertyNames(raw);
	for (const key of keys) {
		const d = Object.getOwnPropertyDescriptor(raw, key);
		if (d && "value" in d) {
			raw[key] = deepFreeze(d.value, depth + 1, budget);
		}
	}
	Object.freeze(raw);
	return raw;
}

// ===========================================================================
// Deep fresh envelope with deep freeze — constructs a fully isolated snapshot
// ===========================================================================

function deepFreshEnvelope(envelope: RemoteHostFrameEnvelope): RemoteHostFrameEnvelope {
	const freshProtocol = Object.freeze({
		name: envelope.protocol.name,
		version: envelope.protocol.version,
	});

	// Deep freeze the frame recursively — it's a JSON-safe value tree
	const frameClone = JSON.parse(JSON.stringify(envelope.frame));
	const frozenFrame = deepFreeze(frameClone, 0, { nodes: MAX_DEEP_FREEZE_NODES }) as typeof envelope.frame;

	if (envelope.lastReceivedEventSequence === undefined) {
		return Object.freeze({
			type: "frame",
			frameId: envelope.frameId,
			protocol: freshProtocol,
			sentAt: envelope.sentAt,
			frame: frozenFrame,
		});
	}
	return Object.freeze({
		type: "frame",
		frameId: envelope.frameId,
		protocol: freshProtocol,
		sentAt: envelope.sentAt,
		frame: frozenFrame,
		lastReceivedEventSequence: envelope.lastReceivedEventSequence,
	});
}

// ===========================================================================
// Factory
// ===========================================================================

export async function createRelayApplicationMultiplexer(raw: unknown): Promise<CreateMultiplexerResult> {
	const prelim = extractPreliminary(raw);

	// Per-slot uncertainty (symbols, proxies on individual capabilities)
	const slotUncertain =
		hasCapabilityUncertainty(prelim.command) ||
		hasCapabilityUncertainty(prelim.event) ||
		hasCapabilityUncertainty(prelim.agentMessage) ||
		hasCapabilityUncertainty(prelim.providerProxy);

	const totalUncertain = prelim.ownershipUncertain || slotUncertain;

	// Phase 2: capture close owners FIRST (ownership-first), BEFORE any validation
	const commandOwned = captureOwnedClose(prelim.command);
	const eventOwned = captureOwnedClose(prelim.event);
	const agentMessageOwned = captureOwnedClose(prelim.agentMessage);
	const providerProxyOwned = captureOwnedClose(prelim.providerProxy);

	// Build deduped close list from all captured owners
	const objectSet = new Set<object>();
	const closeFnSet = new Set<object>();
	const closeSet = new Set<OwnedClose>();
	const closeList: OwnedClose[] = [];

	const addOwner = (slot: OwnedSlot | null): boolean => {
		if (slot === null) return false;
		const objectAlias = objectSet.has(slot.object);
		const fnAlias = closeFnSet.has(slot.closeFn);
		objectSet.add(slot.object);
		closeFnSet.add(slot.closeFn);
		if (!closeSet.has(slot.close)) {
			closeSet.add(slot.close);
			closeList.push(slot.close);
		}
		return objectAlias || fnAlias;
	};

	const a0 = addOwner(commandOwned);
	const a1 = addOwner(eventOwned);
	const a2 = addOwner(agentMessageOwned);
	const a3 = addOwner(providerProxyOwned);

	const allOwned =
		commandOwned !== null && eventOwned !== null && agentMessageOwned !== null && providerProxyOwned !== null;
	const hasAlias = a0 || a1 || a2 || a3;

	if (!allOwned || hasAlias) {
		const allClosed = await closeAllReverse(closeList);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	// Phase 3: validate factory input shape
	const inputDescriptors = exact(raw, FACTORY_KEYS);
	if (!inputDescriptors) {
		const allClosed = await closeAllReverse(closeList);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	// Phase 4: validate capabilities (apply binding)
	const validate = validateCapability(prelim.command, commandOwned);
	const validate1 = validateCapability(prelim.event, eventOwned);
	const validate2 = validateCapability(prelim.agentMessage, agentMessageOwned);
	const validate3 = validateCapability(prelim.providerProxy, providerProxyOwned);

	if (!validate || !validate1 || !validate2 || !validate3) {
		const allClosed = await closeAllReverse(closeList);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	const app = new RelayApplicationMultiplexerImpl(
		validate.apply,
		validate1.apply,
		validate2.apply,
		validate3.apply,
		closeList,
	);

	return successResult(
		Object.freeze({
			apply: (r: unknown): Promise<MultiplexerApplyResult> => app.apply(r),
			close: (): Promise<MultiplexerCloseResult> => app.close(),
		}),
	);
}

// ===========================================================================
// Implementation
// ===========================================================================

class RelayApplicationMultiplexerImpl {
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<MultiplexerCloseResult> | null = null;
	private closed = false;
	private poisoned = false;
	private insideApply = false;

	constructor(
		private readonly commandApply: BoundMethod,
		private readonly eventApply: BoundMethod,
		private readonly agentMessageApply: BoundMethod,
		private readonly providerProxyApply: BoundMethod,
		private readonly ownedCloses: readonly OwnedClose[],
	) {}

	// -----------------------------------------------------------------------
	// Apply
	// -----------------------------------------------------------------------

	async apply(raw: unknown): Promise<MultiplexerApplyResult> {
		if (this.insideApply) return errorResult();
		if (this.closed) return errorResult();
		if (this.poisoned) return errorResult();

		const d = exact(raw, APPLY_INPUT_KEYS);
		if (!d) return errorResult();
		const envelopeValue = value(d, "envelope");

		const decoded = decodeEnvelope(envelopeValue);
		if (!decoded.ok) return this.poison();
		const envelope = decoded.value;

		const slot = slotForFrameType(envelope.frame.type);
		if (slot === null) return errorResult();

		return this.enqueue(() => this.applyOrdered(envelope, slot));
	}

	private async applyOrdered(envelope: RemoteHostFrameEnvelope, slot: SlotName): Promise<MultiplexerApplyResult> {
		if (this.poisoned) return errorResult();

		const freshEnvelope = deepFreshEnvelope(envelope);
		const applyFn = this.selectApply(slot);

		this.insideApply = true;
		let rawResult: unknown;
		try {
			rawResult = applyFn(Object.freeze({ envelope: freshEnvelope }));
			this.insideApply = false;
		} finally {
			this.insideApply = false;
		}

		const observation = await observePromise(rawResult);
		if (!observation.fulfilled) return this.poison();

		if (this.poisoned) return errorResult();

		const resultDesc = exact(observation.value, APPLY_RESULT_KEYS);
		if (!resultDesc) return this.poison();
		if (value(resultDesc, "status") !== "applied") return this.poison();
		return appliedResult();
	}

	private selectApply(slot: SlotName): BoundMethod {
		if (slot === "command") return this.commandApply;
		if (slot === "event") return this.eventApply;
		if (slot === "agentMessage") return this.agentMessageApply;
		return this.providerProxyApply;
	}

	// -----------------------------------------------------------------------
	// Serialization (global FIFO)
	// -----------------------------------------------------------------------

	private enqueue(operation: () => Promise<MultiplexerApplyResult>): Promise<MultiplexerApplyResult> {
		const attempted = this.tail.then(
			() => {
				if (this.poisoned) return errorResult();
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
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	// -----------------------------------------------------------------------
	// Close
	// -----------------------------------------------------------------------

	close(): Promise<MultiplexerCloseResult> {
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;

		const shared: Promise<MultiplexerCloseResult> = this.tail.then(
			() => this.closeOrdered(),
			() => this.closeOrdered(),
		);
		this.closePromise = shared;
		this.tail = shared.then(
			() => undefined,
			() => undefined,
		);
		return shared;
	}

	private async closeOrdered(): Promise<MultiplexerCloseResult> {
		const ok = await closeAllReverse(this.ownedCloses).catch(() => false);
		return ok ? closedResult() : closeErrorResult();
	}

	// -----------------------------------------------------------------------
	// Poison
	// -----------------------------------------------------------------------

	private poison(): MultiplexerApplyResult {
		this.poisoned = true;
		return errorResult();
	}
}
