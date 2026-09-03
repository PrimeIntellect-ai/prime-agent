import { AsyncLocalStorage } from "node:async_hooks";
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

// Codec-aligned bounds (matched to remote-host-frame-codec internals)
const MAX_DEEP_FREEZE_NODES = 10_000;
const MAX_DEEP_FREEZE_DEPTH = 64;

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
// Own descriptor uncertainty helpers
// ===========================================================================

function hasAccessorDescriptor(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of Object.getOwnPropertyNames(descs)) {
			const d = descs[name];
			if (d && !("value" in d)) return true;
		}
	} catch {
		return false;
	}
	return false;
}

// ===========================================================================
// Ownership-first close acquisition
//
// Examine the raw object's OWN descriptors (via Object.getOwnPropertyDescriptors
// which works on any object regardless of prototype). If there is an own
// `close` function (data descriptor, any enumerability), capture it as an
// owner. Do NOT validate the {apply,close} shape yet — that happens later
// as capability validation.
//
// Non-enumerable data close: provable ownership, capture it.
// Accessor close: ownership uncertainty, return null (never invoke getter).
// ===========================================================================

function hasCapabilityUncertainty(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return true;
	} catch {
		return true;
	}
	try {
		// Scan symbol-keyed descriptors — only accessor/Proxy symbols cause uncertainty.
		// Plain data-descriptor symbol values are provable data.
		const rawSymbolKeys = Object.getOwnPropertySymbols(raw);
		for (const sym of rawSymbolKeys) {
			const d = Object.getOwnPropertyDescriptor(raw, sym);
			if (!d || !("value" in d)) return true; // accessor → uncertain
			if (typeof d.value === "object" && d.value !== null && types.isProxy(d.value)) return true;
		}
	} catch {
		return true;
	}
	try {
		if (hasAccessorDescriptor(raw)) return true;
	} catch {
		return true;
	}
	return false;
}

function hasProxyCloseFunction(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		const desc = Object.getOwnPropertyDescriptor(raw, "close");
		if (!desc || !("value" in desc)) return false;
		return types.isProxy(desc.value);
	} catch {
		return false;
	}
}

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
	// Accessor descriptor — never invoke getter, ownership uncertain
	if (!closeDesc || !("value" in closeDesc)) return null;
	// Data-function close regardless of enumerability (non-enumerable is still provable)
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
		const observation = await invoke(() => Reflect.apply(closeFnValue, raw, []));
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
		ownDescriptors = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return uncertain;
	}

	const _ownKeys = Object.getOwnPropertyNames(ownDescriptors);

	const getDataValue = (
		name: string,
	): { readonly value: unknown; readonly present: boolean; readonly uncertain: boolean } => {
		const d = ownDescriptors[name];
		if (d === undefined) return { value: undefined, present: false, uncertain: false };
		// Accessor descriptor — never invoke getter, ownership uncertain
		if (!("value" in d)) return { value: undefined, present: false, uncertain: true };
		// Non-enumerable data descriptor is provable (fully observable via getOwnPropertyDescriptors)
		// Extra non-enumerable keys are provably invalid shape, not uncertainty
		if (!d.enumerable) return { value: d.value, present: true, uncertain: false };
		return { value: d.value, present: true, uncertain: false };
	};

	const cd = getDataValue("command");
	const ev = getDataValue("event");
	const am = getDataValue("agentMessage");
	const pp = getDataValue("providerProxy");

	// Scan symbol-keyed own descriptors — only accessor/Proxy/reflection symbols cause uncertainty.
	// A plain data-descriptor symbol value is provable data, not uncertainty.
	let symbolUncertain = false;
	const symbolKeys = Object.getOwnPropertySymbols(raw);
	for (const sym of symbolKeys) {
		const d = ownDescriptors[sym as unknown as string];
		if (!d || !("value" in d)) {
			// Accessor or missing descriptor — uncertainty
			symbolUncertain = true;
			break;
		}
		// Data descriptor — check if value itself is a Proxy (cannot inspect)
		if (typeof d.value === "object" && d.value !== null) {
			try {
				if (types.isProxy(d.value)) {
					symbolUncertain = true;
					break;
				}
			} catch {
				symbolUncertain = true;
				break;
			}
		}
	}
	// Extra own value-type keys do NOT cause uncertainty (they're provable data).
	const ownershipUncertain = cd.uncertain || ev.uncertain || am.uncertain || pp.uncertain || symbolUncertain;

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
// Bounded JSON-safe deep clone (codec-normalized, cast-free)
// Clones only JSON-safe values: null, boolean, number, string, Array, plain Object
// Uses the same node/depth bounds as remote-host-frame-codec.
// Returns an explicit Ok/Fail discriminated result.
// ===========================================================================

type CloneResult = Readonly<{ readonly ok: true; readonly value: unknown }> | Readonly<{ readonly ok: false }>;

interface CloneBudget {
	nodes: number;
}

function cloneOk(value: unknown): CloneResult {
	return Object.freeze({ ok: true, value });
}

function cloneFail(): CloneResult {
	return Object.freeze({ ok: false });
}

function isJsonPrimitiveOrNull(raw: unknown): raw is null | boolean | number | string {
	if (raw === null) return true;
	if (typeof raw === "boolean") return true;
	if (typeof raw === "number") return Number.isFinite(raw);
	if (typeof raw === "string") return true;
	return false;
}

function deepCloneSafe(raw: unknown, depth: number, budget: CloneBudget): CloneResult {
	if (budget.nodes <= 0 || depth > MAX_DEEP_FREEZE_DEPTH) return cloneFail();
	budget.nodes -= 1;
	if (isJsonPrimitiveOrNull(raw)) return cloneOk(raw);
	if (typeof raw !== "object" || raw === null) return cloneFail();

	try {
		if (types.isProxy(raw) || Object.getOwnPropertySymbols(raw).length !== 0) return cloneFail();
		if (Array.isArray(raw)) {
			const names = Object.getOwnPropertyNames(raw);
			if (names.length !== raw.length + 1 || names[names.length - 1] !== "length") return cloneFail();
			const cloned: unknown[] = [];
			for (let index = 0; index < raw.length; index += 1) {
				if (names[index] !== String(index)) return cloneFail();
				const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
				if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return cloneFail();
				const item = deepCloneSafe(descriptor.value, depth + 1, budget);
				if (!item.ok) return cloneFail();
				cloned.push(item.value);
			}
			return cloneOk(cloned);
		}
		const prototype = Object.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null) return cloneFail();
		const names = Object.getOwnPropertyNames(raw);
		const cloned: Record<string, unknown> = {};
		for (const name of names) {
			const descriptor = Object.getOwnPropertyDescriptor(raw, name);
			if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return cloneFail();
			const item = deepCloneSafe(descriptor.value, depth + 1, budget);
			if (!item.ok) return cloneFail();
			cloned[name] = item.value;
		}
		return cloneOk(cloned);
	} catch {
		return cloneFail();
	}
}

function deepFreezeAllOrFail(raw: unknown, depth: number, budget: CloneBudget): boolean {
	if (budget.nodes <= 0 || depth > MAX_DEEP_FREEZE_DEPTH) return false;
	budget.nodes -= 1;
	if (isJsonPrimitiveOrNull(raw)) return true;
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw) || Object.getOwnPropertySymbols(raw).length !== 0) return false;
		if (Array.isArray(raw)) {
			for (let index = 0; index < raw.length; index += 1) {
				if (!deepFreezeAllOrFail(raw[index], depth + 1, budget)) return false;
			}
			Object.freeze(raw);
			return true;
		}
		const prototype = Object.getPrototypeOf(raw);
		if (prototype !== Object.prototype && prototype !== null) return false;
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(raw))) {
			if (!("value" in descriptor) || !descriptor.enumerable) return false;
			if (!deepFreezeAllOrFail(descriptor.value, depth + 1, budget)) return false;
		}
		Object.freeze(raw);
		return true;
	} catch {
		return false;
	}
}

// Decode a cloned tree again so the returned envelope has a proven protocol type
// without assertions. The second codec pass also prevents clone/type drift.
function deepFreshEnvelope(envelope: RemoteHostFrameEnvelope): FreshEnvelopeResult {
	const cloneResult = deepCloneSafe(envelope, 0, { nodes: MAX_DEEP_FREEZE_NODES });
	if (!cloneResult.ok) return Object.freeze({ ok: false });
	const decoded = decodeEnvelope(cloneResult.value);
	if (!decoded.ok) return Object.freeze({ ok: false });
	if (!deepFreezeAllOrFail(decoded.value, 0, { nodes: MAX_DEEP_FREEZE_NODES })) {
		return Object.freeze({ ok: false });
	}
	return Object.freeze({ ok: true, envelope: decoded.value });
}

interface FreshEnvelopeOk {
	readonly ok: true;
	readonly envelope: RemoteHostFrameEnvelope;
}

type FreshEnvelopeResult = FreshEnvelopeOk | Readonly<{ readonly ok: false }>;

// ===========================================================================
// OwnDescriptor monitor: detects accessor/hidden descriptors on any value.
// Returns uncertainty when an accessible own descriptor could conceal an owner.
// ===========================================================================

interface OwnDescMonitorResult {
	anyAccessor: boolean;
}

function scanOwnDescUncertainty(raw: unknown): OwnDescMonitorResult {
	const result: OwnDescMonitorResult = { anyAccessor: false };
	if (typeof raw !== "object" || raw === null) return result;
	try {
		if (types.isProxy(raw)) {
			result.anyAccessor = true;
			return result;
		}
	} catch {
		result.anyAccessor = true;
		return result;
	}
	try {
		const descs = Object.getOwnPropertyDescriptors(raw);
		for (const name of Object.getOwnPropertyNames(descs)) {
			const d = descs[name];
			if (d && !("value" in d)) {
				// Accessor descriptor — could conceal an owner, never invoke
				result.anyAccessor = true;
			}
		}
	} catch {
		result.anyAccessor = true;
	}
	return result;
}

// ===========================================================================
// Capture all known capability-like owners from a raw factory object.
// Scans every OWN value-descriptor property (including non-enumerable)
// for capability-like sub-objects and captures their close owners.
// Also reports accessor uncertainty for merge into totalUncertain.
// This prevents close leaks when hidden/accessor descriptors exist.
// ===========================================================================

interface AllOwnersResult {
	readonly owners: readonly OwnedSlot[];
	readonly anyAlias: boolean;
	readonly anyAccessorUncertain: boolean;
}

function captureAllOwners(raw: unknown): AllOwnersResult {
	const owners: OwnedSlot[] = [];
	const objectSet = new Set<object>();
	let anyAlias = false;
	let anyAccessorUncertain = false;

	if (typeof raw !== "object" || raw === null) {
		return { owners, anyAlias, anyAccessorUncertain };
	}

	let ownDescs: Record<string, PropertyDescriptor>;
	try {
		ownDescs = Object.getOwnPropertyDescriptors(raw);
	} catch {
		return { owners, anyAlias: false, anyAccessorUncertain: true };
	}

	// Helper: try to capture a close owner from a value and add to owners list.
	// Returns true if a new owner was added.
	const maybeAddOwner = (val: unknown): boolean => {
		if (typeof val !== "object" || val === null) return false;
		if (Array.isArray(val)) return false;

		const slot = captureOwnedClose(val);
		if (!slot) {
			// Object exists but no close captured — may still have hidden close
			if (hasCapabilityUncertainty(val)) {
				anyAccessorUncertain = true;
			}
			if (hasProxyCloseFunction(val)) {
				anyAccessorUncertain = true;
			}
			return false;
		}

		// Dedup by raw object only — the same close function on two distinct
		// objects does NOT prove one physical owner; each must be invoked with
		// its own `this` in reverse discovery order.
		if (objectSet.has(slot.object)) {
			anyAlias = true;
			return false;
		}
		objectSet.add(slot.object);
		owners.push(slot);
		return true;
	};

	// Helper: scan one bounded level into a parent object's own data-descriptor
	// properties for nested close owners (extra data owner fields on capabilities).
	const scanSubOwners = (parent: object): void => {
		let parentDescs: Record<string, PropertyDescriptor>;
		try {
			parentDescs = Object.getOwnPropertyDescriptors(parent);
		} catch {
			return;
		}
		// Scan string-keyed own properties (one bounded level)
		for (const subName of Object.getOwnPropertyNames(parentDescs)) {
			const sd = parentDescs[subName];
			if (!sd || !("value" in sd)) continue; // accessor — skip
			if (sd.enumerable === false && subName === "close") continue; // skip the capability's own close
			if (sd.enumerable === false && subName === "apply") continue; // skip the capability's own apply
			maybeAddOwner(sd.value);
		}
		// Also scan symbol-keyed own data descriptors on sub-objects
		try {
			const subSymbols = Object.getOwnPropertySymbols(parent);
			for (const sym of subSymbols) {
				const sd = Object.getOwnPropertyDescriptor(parent, sym);
				if (!sd || !("value" in sd)) continue; // accessor — skip
				maybeAddOwner(sd.value);
			}
		} catch {
			// reflection failure — skip
		}
	};

	for (const name of Object.getOwnPropertyNames(ownDescs)) {
		const d = ownDescs[name];
		if (!d) continue;

		// Accessor descriptor — never invoke getter, flag uncertainty
		if (!("value" in d)) {
			anyAccessorUncertain = true;
			continue;
		}

		const val = d.value;
		if (typeof val !== "object" || val === null) continue;
		if (Array.isArray(val)) continue;

		// Try to capture close owner from this value
		maybeAddOwner(val);

		// Also scan one bounded level into the value for extra data owner fields
		if (typeof val === "object" && val !== null && !Array.isArray(val)) {
			scanSubOwners(val);
		}
	}

	// Also scan symbol-keyed own data descriptors for capability owners.
	// We still capture provable data-value owners so their close runs in the
	// correct order on factory failure. Uncertainty classification is handled
	// separately by extractPreliminary.
	const symbolKeys = Object.getOwnPropertySymbols(raw);
	for (const sym of symbolKeys) {
		const d = Object.getOwnPropertyDescriptor(raw, sym);
		if (!d || !("value" in d)) {
			continue;
		}
		maybeAddOwner(d.value);
		if (typeof d.value === "object" && d.value !== null && !Array.isArray(d.value)) {
			scanSubOwners(d.value);
		}
	}

	return { owners, anyAlias, anyAccessorUncertain };
}

// ===========================================================================
// Factory
// ===========================================================================

export async function createRelayApplicationMultiplexer(raw: unknown): Promise<CreateMultiplexerResult> {
	// Phase -1: null/primitive factory inputs have no possible owner and must
	// return INVALID_ARGUMENT, not CLOSE_UNCERTAIN.
	if (typeof raw !== "object" || raw === null) {
		return invalidArgumentError();
	}

	// Phase 0: capture ALL known owners from the raw factory object before any extraction
	// This ensures hidden/accessor data slots have their closes captured even when
	// extractPreliminary cannot confirm the value.
	const allOwners = captureAllOwners(raw);

	const prelim = extractPreliminary(raw);

	// Also scan factory-level accessor descriptors that could conceal owners
	const factoryDescMonitor = scanOwnDescUncertainty(raw);

	// Per-slot uncertainty (symbols, proxies, accessors, non-enumerable on individual capabilities)
	// Proxy close functions make the slot uncertain even when the
	// capability object itself is inspectable — we cannot safely capture
	// the close from a Proxy-wrapped function.
	const slotUncertain =
		hasCapabilityUncertainty(prelim.command) ||
		hasCapabilityUncertainty(prelim.event) ||
		hasCapabilityUncertainty(prelim.agentMessage) ||
		hasCapabilityUncertainty(prelim.providerProxy) ||
		hasProxyCloseFunction(prelim.command) ||
		hasProxyCloseFunction(prelim.event) ||
		hasProxyCloseFunction(prelim.agentMessage) ||
		hasProxyCloseFunction(prelim.providerProxy);

	const totalUncertain =
		prelim.ownershipUncertain || slotUncertain || allOwners.anyAccessorUncertain || factoryDescMonitor.anyAccessor;

	// Build closeList from all captured owners in original discovery order
	const closeList = [...allOwners.owners.map((s) => s.close)];

	// Phase 1: validate factory input shape
	const inputDescriptors = exact(raw, FACTORY_KEYS);
	if (!inputDescriptors) {
		const allClosed = await closeAllReverse(closeList);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	// Phase 2: capture close owners for the 4 named slots (ownership-first)
	const commandOwned = captureOwnedClose(prelim.command);
	const eventOwned = captureOwnedClose(prelim.event);
	const agentMessageOwned = captureOwnedClose(prelim.agentMessage);
	const providerProxyOwned = captureOwnedClose(prelim.providerProxy);

	// Merge named-slot owners into a deduplicated close list in discovery order.
	// Dedup by raw object only — the same close function on two distinct objects
	// does NOT prove one physical owner; each must be invoked with its own `this`
	// in true reverse discovery order.
	const rawObjectSet = new Set<object>();
	const mergedCloses: OwnedClose[] = [];

	for (const s of allOwners.owners) {
		if (rawObjectSet.has(s.object)) continue;
		rawObjectSet.add(s.object);
		mergedCloses.push(s.close);
	}

	// Add named-slot owners that are genuinely new
	for (const slot of [commandOwned, eventOwned, agentMessageOwned, providerProxyOwned]) {
		if (slot === null) continue;
		if (rawObjectSet.has(slot.object)) continue;
		rawObjectSet.add(slot.object);
		mergedCloses.push(slot.close);
	}

	const allOwned =
		commandOwned !== null && eventOwned !== null && agentMessageOwned !== null && providerProxyOwned !== null;

	// Detect alias across named slots: same raw object proves alias.
	// Same close function on two distinct objects does NOT prove one owner.
	const namedObjectSet = new Set<object>();
	let hasAlias = false;
	for (const slot of [commandOwned, eventOwned, agentMessageOwned, providerProxyOwned]) {
		if (slot === null) continue;
		if (namedObjectSet.has(slot.object)) {
			hasAlias = true;
		}
		namedObjectSet.add(slot.object);
	}

	// Also propagate any alias from the all-owners scan
	if (allOwners.anyAlias) hasAlias = true;

	if (!allOwned || hasAlias) {
		const allClosed = await closeAllReverse(mergedCloses);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	// Phase 3: validate capabilities (apply binding)
	const validate = validateCapability(prelim.command, commandOwned);
	const validate1 = validateCapability(prelim.event, eventOwned);
	const validate2 = validateCapability(prelim.agentMessage, agentMessageOwned);
	const validate3 = validateCapability(prelim.providerProxy, providerProxyOwned);

	if (!validate || !validate1 || !validate2 || !validate3) {
		const allClosed = await closeAllReverse(mergedCloses);
		if (!allClosed || totalUncertain) return closeUncertainError();
		return invalidArgumentError();
	}

	const app = new RelayApplicationMultiplexerImpl(
		validate.apply,
		validate1.apply,
		validate2.apply,
		validate3.apply,
		mergedCloses,
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
	// See applyContext below class definition — it references this class.
	private tail: Promise<void> = Promise.resolve();
	private closePromise: Promise<MultiplexerCloseResult> | null = null;
	private closed = false;
	private poisoned = false;

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
		if (applyContext.getStore() === this) {
			return errorResult();
		}
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

		const freshResult = deepFreshEnvelope(envelope);
		if (!freshResult.ok) return this.poison();
		const applyFn = this.selectApply(slot);

		// Use AsyncLocalStorage to reject async reentry without blocking external callers.
		// Capture the raw return value (a Promise from applyFn) WITHOUT await so that
		// observePromise can validate it as a native Promise.
		let rawResult: unknown;
		try {
			rawResult = applyContext.run(this, () => applyFn(Object.freeze({ envelope: freshResult.envelope })));
		} catch {
			return this.poison();
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

const applyContext = new AsyncLocalStorage<RelayApplicationMultiplexerImpl>();
