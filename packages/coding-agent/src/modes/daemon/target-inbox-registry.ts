import { types } from "node:util";

const FACTORY_KEYS = new Set(["catalog", "factory"]);
const CATALOG_KEYS = new Set(["close", "isCurrent"]);
const ENTRY_FACTORY_KEYS = new Set(["close", "create"]);
const ENTRY_KEYS = new Set(["close", "dispatchPending", "receive", "send"]);
const IDENTITY_KEYS = new Set(["generation", "hostId", "sessionId"]);
const STATUS_KEYS = new Set(["status"]);
const SUCCESS_KEYS = new Set(["ok", "value"]);
const FAILURE_KEYS = new Set(["error", "ok"]);
const ERROR_KEYS = new Set(["code"]);
const CLOSE_TIMEOUT_MS = 5_000;
const OPERATION_TIMEOUT_MS = 30_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type TargetInboxRegistryErrorCode =
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "INVALID_ARGUMENT"
	| "REENTRY"
	| "STALE"
	| "UNCERTAIN";

export type TargetInboxRegistryResult<T> =
	| Readonly<{ ok: true; value: T }>
	| Readonly<{ ok: false; error: Readonly<{ code: TargetInboxRegistryErrorCode }> }>;

export interface TargetInboxRegistryEntryView {
	readonly receive: (raw: unknown) => Promise<TargetInboxRegistryResult<void>>;
	readonly send: (raw: unknown) => Promise<TargetInboxRegistryResult<void>>;
	readonly dispatchPending: () => Promise<TargetInboxRegistryResult<void>>;
}

export interface TargetInboxRegistry {
	readonly get: (identity: unknown) => Promise<TargetInboxRegistryResult<TargetInboxRegistryEntryView>>;
	readonly closeIdentity: (identity: unknown) => Promise<TargetInboxRegistryResult<void>>;
	readonly close: () => Promise<TargetInboxRegistryResult<void>>;
}

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type CloseOwner = () => Promise<boolean>;

type Observation =
	| Readonly<{ status: "fulfilled"; value: unknown }>
	| Readonly<{ status: "invalid" | "rejected" | "threw" | "timeout" }>;

interface Identity {
	readonly generation: string;
	readonly hostId: string;
	readonly sessionId: string;
}

interface BoundEntry {
	readonly close: CloseOwner;
	readonly dispatchPending: BoundMethod;
	readonly receive: BoundMethod;
	readonly send: BoundMethod;
}

interface EntryState extends BoundEntry {
	readonly identity: Identity;
	closing: boolean;
	tail: Promise<void>;
}

function failed(code: TargetInboxRegistryErrorCode): TargetInboxRegistryResult<never> {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function succeeded<T>(value: T): TargetInboxRegistryResult<T> {
	return Object.freeze({ ok: true as const, value });
}

function descriptors(raw: unknown): Descriptors | null {
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
	const found = descriptors(raw);
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

function identity(raw: unknown): Identity | null {
	const found = exact(raw, IDENTITY_KEYS);
	if (!found) return null;
	const generation = value(found, "generation");
	const hostId = value(found, "hostId");
	const sessionId = value(found, "sessionId");
	if (
		typeof generation !== "string" ||
		typeof hostId !== "string" ||
		typeof sessionId !== "string" ||
		!SAFE_ID_RE.test(generation) ||
		!SAFE_ID_RE.test(hostId) ||
		!SAFE_ID_RE.test(sessionId)
	)
		return null;
	return Object.freeze({ generation, hostId, sessionId });
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

function invoke(method: BoundMethod, args: readonly unknown[], timeoutMs: number): Promise<Observation> {
	let raw: unknown;
	try {
		raw = method(...args);
	} catch {
		return Promise.resolve(Object.freeze({ status: "threw" as const }));
	}
	return observe(raw, timeoutMs);
}

function directCloseOwner(raw: unknown): CloseOwner | null {
	if (typeof raw !== "object" || raw === null) return null;
	let close: BoundMethod | null = null;
	try {
		if (types.isProxy(raw)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "close");
		if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function") return null;
		if (types.isProxy(descriptor.value)) return null;
		const candidate = descriptor.value;
		close = (): unknown => Reflect.apply(candidate, raw, []);
	} catch {
		return null;
	}
	let shared: Promise<boolean> | null = null;
	return (): Promise<boolean> => {
		if (shared) return shared;
		shared = (async (): Promise<boolean> => {
			const observed = await invoke(close, [], CLOSE_TIMEOUT_MS);
			if (observed.status !== "fulfilled") return false;
			const result = exact(observed.value, STATUS_KEYS);
			return result !== null && value(result, "status") === "closed";
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

function operationResult(raw: unknown): TargetInboxRegistryResult<void> {
	const success = exact(raw, SUCCESS_KEYS);
	if (success && value(success, "ok") === true) return succeeded(undefined);
	const failure = exact(raw, FAILURE_KEYS);
	if (!failure || value(failure, "ok") !== false) return failed("UNCERTAIN");
	const error = exact(value(failure, "error"), ERROR_KEYS);
	if (!error) return failed("UNCERTAIN");
	const code = value(error, "code");
	return code === "CLOSED" ? failed("CLOSED") : failed("UNCERTAIN");
}

function currentResult(raw: unknown): "current" | "stale" | null {
	const result = exact(raw, STATUS_KEYS);
	if (!result) return null;
	const status = value(result, "status");
	return status === "current" || status === "stale" ? status : null;
}

function insertNested(root: Map<string, Map<string, Map<string, EntryState>>>, entry: EntryState): void {
	let generations = root.get(entry.identity.hostId);
	if (!generations) {
		generations = new Map();
		root.set(entry.identity.hostId, generations);
	}
	let sessions = generations.get(entry.identity.generation);
	if (!sessions) {
		sessions = new Map();
		generations.set(entry.identity.generation, sessions);
	}
	sessions.set(entry.identity.sessionId, entry);
}

function findNested(root: Map<string, Map<string, Map<string, EntryState>>>, id: Identity): EntryState | undefined {
	return root.get(id.hostId)?.get(id.generation)?.get(id.sessionId);
}

function deleteNested(root: Map<string, Map<string, Map<string, EntryState>>>, id: Identity): void {
	const generations = root.get(id.hostId);
	const sessions = generations?.get(id.generation);
	if (!generations || !sessions) return;
	sessions.delete(id.sessionId);
	if (sessions.size === 0) generations.delete(id.generation);
	if (generations.size === 0) root.delete(id.hostId);
}

function hasTombstone(root: Map<string, Map<string, Set<string>>>, id: Identity): boolean {
	return root.get(id.hostId)?.get(id.generation)?.has(id.sessionId) === true;
}

function addTombstone(root: Map<string, Map<string, Set<string>>>, id: Identity): void {
	let generations = root.get(id.hostId);
	if (!generations) {
		generations = new Map();
		root.set(id.hostId, generations);
	}
	let sessions = generations.get(id.generation);
	if (!sessions) {
		sessions = new Set();
		generations.set(id.generation, sessions);
	}
	sessions.add(id.sessionId);
}

function preliminaryValue(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	try {
		if (types.isProxy(raw)) return undefined;
		const descriptor = Object.getOwnPropertyDescriptor(raw, "value");
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch {
		return undefined;
	}
}

export async function createTargetInboxRegistry(raw: unknown): Promise<TargetInboxRegistryResult<TargetInboxRegistry>> {
	const outer = descriptors(raw);
	const rawCatalog = outer ? value(outer, "catalog") : undefined;
	const rawFactory = outer ? value(outer, "factory") : undefined;
	const catalogClose = directCloseOwner(rawCatalog);
	const aliased = rawCatalog !== undefined && rawCatalog === rawFactory;
	const factoryClose = aliased ? catalogClose : directCloseOwner(rawFactory);
	const acquired = catalogClose ? [catalogClose] : [];
	if (factoryClose && !aliased) acquired.push(factoryClose);

	const input = exact(raw, FACTORY_KEYS);
	const catalogDescriptors = exact(rawCatalog, CATALOG_KEYS);
	const factoryDescriptors = exact(rawFactory, ENTRY_FACTORY_KEYS);
	if (
		!input ||
		!catalogDescriptors ||
		!factoryDescriptors ||
		!catalogClose ||
		!factoryClose ||
		aliased ||
		typeof rawCatalog !== "object" ||
		rawCatalog === null ||
		typeof rawFactory !== "object" ||
		rawFactory === null
	) {
		return (await closeReverse(acquired)) ? failed("INVALID_ARGUMENT") : failed("CLOSE_UNCERTAIN");
	}
	const isCurrent = bind(rawCatalog, catalogDescriptors, "isCurrent");
	const create = bind(rawFactory, factoryDescriptors, "create");
	if (!isCurrent || !create) {
		return (await closeReverse(acquired)) ? failed("INVALID_ARGUMENT") : failed("CLOSE_UNCERTAIN");
	}
	const boundIsCurrent = isCurrent;
	const boundCreate = create;
	const ownedCatalogClose = catalogClose;
	const ownedFactoryClose = factoryClose;

	const entries = new Map<string, Map<string, Map<string, EntryState>>>();
	const closingIdentities = new Map<string, Map<string, Set<string>>>();
	const tombstones = new Map<string, Map<string, Set<string>>>();
	const creationOrder: EntryState[] = [];
	let globalTail: Promise<void> = Promise.resolve();
	let closeRequested = false;
	let closePromise: Promise<TargetInboxRegistryResult<void>> | null = null;
	let insideInjectedCall = false;

	function enqueueGlobal<T>(operation: () => Promise<T>): Promise<T> {
		const previous = globalTail;
		const result = (async (): Promise<T> => {
			await previous;
			return await operation();
		})();
		globalTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	function invokeInjected(method: BoundMethod, args: readonly unknown[]): Promise<Observation> {
		insideInjectedCall = true;
		try {
			return invoke(method, args, OPERATION_TIMEOUT_MS);
		} finally {
			insideInjectedCall = false;
		}
	}

	async function callInjected(
		method: BoundMethod,
		args: readonly unknown[],
	): Promise<TargetInboxRegistryResult<void>> {
		const observed = await invokeInjected(method, args);
		return observed.status === "fulfilled" ? operationResult(observed.value) : failed("UNCERTAIN");
	}

	function invokeOwnedClose(owner: CloseOwner): Promise<boolean> {
		insideInjectedCall = true;
		try {
			return owner();
		} finally {
			insideInjectedCall = false;
		}
	}

	function buildView(entry: EntryState): TargetInboxRegistryEntryView {
		function enqueue(method: BoundMethod, args: readonly unknown[]): Promise<TargetInboxRegistryResult<void>> {
			if (insideInjectedCall) return Promise.resolve(failed("REENTRY"));
			if (closeRequested || entry.closing || hasTombstone(closingIdentities, entry.identity)) {
				return Promise.resolve(failed("CLOSED"));
			}
			const previous = entry.tail;
			const result = (async (): Promise<TargetInboxRegistryResult<void>> => {
				await previous;
				return await callInjected(method, args);
			})();
			entry.tail = result.then(
				() => undefined,
				() => undefined,
			);
			return result;
		}
		return Object.freeze({
			dispatchPending: (): Promise<TargetInboxRegistryResult<void>> => enqueue(entry.dispatchPending, []),
			receive: (input: unknown): Promise<TargetInboxRegistryResult<void>> => enqueue(entry.receive, [input]),
			send: (input: unknown): Promise<TargetInboxRegistryResult<void>> => enqueue(entry.send, [input]),
		});
	}

	async function get(rawIdentity: unknown): Promise<TargetInboxRegistryResult<TargetInboxRegistryEntryView>> {
		if (insideInjectedCall) return failed("REENTRY");
		if (closeRequested) return failed("CLOSED");
		const id = identity(rawIdentity);
		if (!id) return failed("INVALID_ARGUMENT");
		return await enqueueGlobal(async () => {
			if (hasTombstone(tombstones, id)) return failed("STALE");
			const existing = findNested(entries, id);
			if (existing) return succeeded(buildView(existing));
			const current = await invokeInjected(boundIsCurrent, [id]);
			if (current.status !== "fulfilled") return failed("UNCERTAIN");
			const status = currentResult(current.value);
			if (status === "stale") return failed("STALE");
			if (status !== "current") return failed("UNCERTAIN");

			const created = await invokeInjected(boundCreate, [id]);
			if (created.status !== "fulfilled") return failed("UNCERTAIN");
			const candidate = preliminaryValue(created.value);
			const entryClose = directCloseOwner(candidate);
			const success = exact(created.value, SUCCESS_KEYS);
			const entryDescriptors = exact(candidate, ENTRY_KEYS);
			if (
				!entryClose ||
				!success ||
				value(success, "ok") !== true ||
				!entryDescriptors ||
				typeof candidate !== "object" ||
				candidate === null
			) {
				if (!entryClose) return failed("UNCERTAIN");
				return (await invokeOwnedClose(entryClose)) ? failed("UNCERTAIN") : failed("CLOSE_UNCERTAIN");
			}
			const receive = bind(candidate, entryDescriptors, "receive");
			const send = bind(candidate, entryDescriptors, "send");
			const dispatchPending = bind(candidate, entryDescriptors, "dispatchPending");
			if (!receive || !send || !dispatchPending) {
				return (await invokeOwnedClose(entryClose)) ? failed("UNCERTAIN") : failed("CLOSE_UNCERTAIN");
			}
			const entry: EntryState = {
				close: entryClose,
				closing: false,
				dispatchPending,
				identity: id,
				receive,
				send,
				tail: Promise.resolve(),
			};
			const view = buildView(entry);
			insertNested(entries, entry);
			creationOrder.push(entry);
			return succeeded(view);
		});
	}

	async function closeIdentity(rawIdentity: unknown): Promise<TargetInboxRegistryResult<void>> {
		if (insideInjectedCall) return failed("REENTRY");
		if (closeRequested) return failed("CLOSED");
		const id = identity(rawIdentity);
		if (!id) return failed("INVALID_ARGUMENT");
		addTombstone(closingIdentities, id);
		const current = findNested(entries, id);
		if (current) current.closing = true;
		return await enqueueGlobal(async () => {
			if (hasTombstone(tombstones, id)) return succeeded(undefined);
			const entry = findNested(entries, id);
			addTombstone(tombstones, id);
			if (!entry) return succeeded(undefined);
			entry.closing = true;
			await entry.tail;
			const closed = await invokeOwnedClose(entry.close);
			deleteNested(entries, id);
			return closed ? succeeded(undefined) : failed("CLOSE_UNCERTAIN");
		});
	}

	function close(): Promise<TargetInboxRegistryResult<void>> {
		if (insideInjectedCall) return Promise.resolve(failed("REENTRY"));
		if (closePromise) return closePromise;
		closeRequested = true;
		for (const entry of creationOrder) entry.closing = true;
		const admitted = globalTail;
		closePromise = (async (): Promise<TargetInboxRegistryResult<void>> => {
			await admitted;
			let confirmed = true;
			for (let index = creationOrder.length - 1; index >= 0; index -= 1) {
				const entry = creationOrder[index];
				await entry.tail;
				if (!(await invokeOwnedClose(entry.close))) confirmed = false;
			}
			if (!(await invokeOwnedClose(ownedFactoryClose))) confirmed = false;
			if (!(await invokeOwnedClose(ownedCatalogClose))) confirmed = false;
			return confirmed ? succeeded(undefined) : failed("CLOSE_UNCERTAIN");
		})();
		return closePromise;
	}

	const registry: TargetInboxRegistry = Object.freeze({ close, closeIdentity, get });
	return succeeded(registry);
}
