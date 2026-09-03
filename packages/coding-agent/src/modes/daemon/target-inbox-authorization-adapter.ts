import { types } from "node:util";
import {
	type AgentFamilyCatalogEntry,
	type AgentFamilyRelationship,
	assertAgentFamilyReach,
} from "../../core/agent-messages.js";
import type { TargetInboxErrorCode } from "./durable-target-inbox.js";
import { canonicalDigest, decodeAgentMessageFrame, decodeEnvelope, isValidDigest } from "./remote-host-frame-codec.js";

// ===========================================================================
// Error codes
// ===========================================================================

export type AuthorizerErrorCode =
	| "CLOSED"
	| "CLOSE_UNCERTAIN"
	| "COLLISION"
	| "INVALID_ARGUMENT"
	| "MISMATCH"
	| "NOT_FOUND"
	| "POISONED"
	| "RECOVERY_FAILED"
	| "UNCERTAIN"
	| "STALE"
	| "UNAUTHORIZED";

export type AuthorizerFailure = Readonly<{
	readonly ok: false;
	readonly error: Readonly<{ code: AuthorizerErrorCode }>;
}>;

export type AuthorizerResult<T> = Readonly<{ ok: true; value: T }> | AuthorizerFailure;

// ===========================================================================
// Capability interfaces
// ===========================================================================

export interface InboxCapability {
	readonly admit: (raw: unknown) => Promise<
		| Readonly<{
				ok: true;
				value: Readonly<{
					status: "queued";
					receipt: Readonly<{ sequence: number; size: number; sha256: string }>;
					frameId: string;
					semanticId: string;
					semanticDigest: string;
				}>;
		  }>
		| Readonly<{ ok: false; error: Readonly<{ code: TargetInboxErrorCode }> }>
	>;
	readonly dispatchPending: () => Promise<
		| Readonly<{ ok: true; value: undefined }>
		| Readonly<{ ok: false; error: Readonly<{ code: TargetInboxErrorCode }> }>
	>;
	readonly close: () => Promise<
		| Readonly<{ ok: true; value: undefined }>
		| Readonly<{ ok: false; error: Readonly<{ code: TargetInboxErrorCode }> }>
	>;
}

export interface CatalogCapability {
	readonly resolveSession: (activeSessionId: string) => Promise<Record<string, unknown> | undefined>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export interface RelationshipEvidence {
	readonly fromRelationship: AgentFamilyRelationship;
}

// Full decoded admit receipt for router ACK/replay
export interface DecodedAdmitReceipt {
	readonly status: "queued";
	readonly receipt: Readonly<{ sequence: number; size: number; sha256: string }>;
	readonly frameId: string;
	readonly semanticId: string;
	readonly semanticDigest: string;
}

export interface AuthorizeAndAdmitOutput {
	readonly allowed: true;
	readonly relationship: RelationshipEvidence;
	readonly receipt: DecodedAdmitReceipt;
}

export interface PreAuthorizedInbox {
	readonly authorizeAdmit: (raw: unknown) => Promise<AuthorizerResult<AuthorizeAndAdmitOutput>>;
	readonly dispatchPending: () => Promise<
		Readonly<{ ok: true; value: undefined }> | Readonly<{ ok: false; error: Readonly<{ code: AuthorizerErrorCode }> }>
	>;
	readonly close: () => Promise<AuthorizerResult<void>>;
}

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type OwnedClose = () => Promise<boolean>;

const FACTORY_KEYS = new Set(["catalog", "inbox"]);
const ADMIT_INPUT_KEYS = new Set(["envelope"]);
const OPERATION_TIMEOUT_MS = 30_000;

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

function validId(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return false;
	for (let index = 0; index < raw.length; index += 1) {
		const code = raw.charCodeAt(index);
		if (code <= 0x20 || code >= 0x7f) return false;
	}
	return true;
}

// ===========================================================================
// Native-promise-only guard
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

// ===========================================================================
// Native-promise observation
// ===========================================================================

interface NativeObservation {
	readonly status: "fulfilled" | "rejected" | "timeout";
	readonly value?: unknown;
}

function nativeObserve(bound: () => unknown, timeoutMs: number): Promise<NativeObservation> {
	let raw: unknown;
	try {
		raw = bound();
	} catch {
		return Promise.resolve(Object.freeze({ status: "rejected" as const }));
	}
	if (!isNativePromise(raw)) {
		return Promise.resolve(Object.freeze({ status: "rejected" as const }));
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
			resolve(Object.freeze({ status: "rejected" as const }));
		}
	});
}

// ===========================================================================
// Preliminary ownership snapshot — guarded own-descriptor extraction
// for close acquisition before any validation. Accepts any raw object
// including custom prototypes and symbols. Never rejects.
// ===========================================================================

function preliminaryOwn(raw: unknown): { catalog: unknown; inbox: unknown } {
	if (typeof raw !== "object" || raw === null) return Object.freeze({ catalog: undefined, inbox: undefined });
	let catalog: unknown;
	let inbox: unknown;
	try {
		if (types.isProxy(raw)) return Object.freeze({ catalog: undefined, inbox: undefined });
	} catch {
		return Object.freeze({ catalog: undefined, inbox: undefined });
	}
	try {
		const cd = Object.getOwnPropertyDescriptor(raw, "catalog");
		catalog = cd && "value" in cd ? cd.value : undefined;
	} catch {
		catalog = undefined;
	}
	try {
		const id = Object.getOwnPropertyDescriptor(raw, "inbox");
		inbox = id && "value" in id ? id.value : undefined;
	} catch {
		inbox = undefined;
	}
	return Object.freeze({ catalog, inbox });
}

// ===========================================================================
// Bind method from own enumerable descriptor
// ===========================================================================

function bindMethod(raw: unknown, name: string): ((...args: readonly unknown[]) => unknown) | null {
	if (typeof raw !== "object" || raw === null) return null;
	const d = Object.getOwnPropertyDescriptor(raw, name);
	if (!d || !("value" in d) || !d.enumerable) return null;
	const fn = d.value;
	if (typeof fn !== "function") return null;
	try {
		if (types.isProxy(fn)) return null;
	} catch {
		return null;
	}
	return (...args: readonly unknown[]): unknown => Reflect.apply(fn, raw, args);
}

// ===========================================================================
// Owned close acquisition
// ===========================================================================

function acquireClose(raw: unknown, protocol: "catalog" | "inbox"): OwnedClose | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	let d: PropertyDescriptor | undefined;
	try {
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
		const observation = await nativeObserve(() => bound(), 5_000);
		if (observation.status !== "fulfilled") return false;
		const r = observation.value;
		if (typeof r !== "object" || r === null) return false;
		if (protocol === "catalog") {
			const rd = exact(r, new Set(["status"]));
			return rd !== null && value(rd, "status") === "closed";
		}
		const rd = exact(r, new Set(["ok", "value"]));
		return rd !== null && value(rd, "ok") === true && value(rd, "value") === undefined;
	};
}

// ===========================================================================
// Decode exact AdmitReceipt — returns full decoded value or null
// ===========================================================================

const ADMIT_RECEIPT_REQUIRED = new Set(["frameId", "receipt", "semanticDigest", "semanticId", "status"]);
const DURABLE_RECEIPT_REQUIRED = new Set(["sequence", "sha256", "size"]);

function decodeAdmitReceipt(
	raw: unknown,
	expectedFrameId: string,
	expectedSemanticId: string,
	expectedDigest: string,
): DecodedAdmitReceipt | null {
	if (typeof raw !== "object" || raw === null) return null;
	const d = exact(raw, ADMIT_RECEIPT_REQUIRED);
	if (!d) return null;
	if (value(d, "status") !== "queued") return null;
	const frameId = value(d, "frameId");
	const semanticId = value(d, "semanticId");
	const semanticDigest = value(d, "semanticDigest");
	if (typeof frameId !== "string" || frameId !== expectedFrameId) return null;
	if (typeof semanticId !== "string" || semanticId !== expectedSemanticId) return null;
	if (typeof semanticDigest !== "string" || !isValidDigest(semanticDigest) || semanticDigest !== expectedDigest)
		return null;
	const recv = value(d, "receipt");
	const receiptD = exact(recv, DURABLE_RECEIPT_REQUIRED);
	if (!receiptD) return null;
	const seq = value(receiptD, "sequence");
	const sz = value(receiptD, "size");
	const s256 = value(receiptD, "sha256");
	if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) return null;
	if (typeof sz !== "number" || !Number.isSafeInteger(sz) || sz <= 0) return null;
	if (typeof s256 !== "string" || !isValidDigest(s256)) return null;
	return Object.freeze({
		status: "queued" as const,
		receipt: Object.freeze({ sequence: seq, size: sz, sha256: s256 }),
		frameId: frameId,
		semanticId: semanticId,
		semanticDigest: semanticDigest,
	});
}

// ===========================================================================
// Decode TargetInboxResult<void> success
// ===========================================================================

function decodeInboxOkVoid(raw: unknown): boolean {
	if (typeof raw !== "object" || raw === null) return false;
	const d = exact(raw, new Set(["ok", "value"]));
	return d !== null && value(d, "ok") === true && value(d, "value") === undefined;
}

// ===========================================================================
// Decode TargetInboxResult<T> error
// ===========================================================================

const ERROR_CODE_MAP: Record<string, AuthorizerErrorCode> = {
	CLOSED: "CLOSED",
	CLOSE_UNCERTAIN: "CLOSE_UNCERTAIN",
	COLLISION: "COLLISION",
	INVALID_ARGUMENT: "INVALID_ARGUMENT",
	MISMATCH: "MISMATCH",
	NOT_FOUND: "NOT_FOUND",
	POISONED: "POISONED",
	RECOVERY_FAILED: "RECOVERY_FAILED",
	UNCERTAIN: "UNCERTAIN",
};

const VALID_ERROR_CODES: ReadonlySet<string> = new Set([
	"CLOSED",
	"CLOSE_UNCERTAIN",
	"COLLISION",
	"INVALID_ARGUMENT",
	"MISMATCH",
	"NOT_FOUND",
	"POISONED",
	"RECOVERY_FAILED",
	"UNCERTAIN",
]);

function decodeInboxError(raw: unknown): AuthorizerErrorCode | null {
	if (typeof raw !== "object" || raw === null) return null;
	const d = exact(raw, new Set(["error", "ok"]));
	if (!d || value(d, "ok") !== false) return null;
	const errRaw = value(d, "error");
	const errD = exact(errRaw, new Set(["code"]));
	if (!errD) return null;
	const code = value(errD, "code");
	if (typeof code !== "string" || !VALID_ERROR_CODES.has(code)) return null;
	return ERROR_CODE_MAP[code];
}

// ===========================================================================
// Decode exact resolved session — every field validated as own enumerable
// ===========================================================================

interface InternalResolvedSession {
	readonly activeSessionId: string;
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly sessionName?: string;
	readonly parentSessionId?: string;
	readonly parentSessionPath?: string;
	readonly rlmDepth: number;
}

const RESOLVED_ALLOWED = new Set([
	"activeSessionId",
	"sessionId",
	"sessionDir",
	"rlmDepth",
	"runtimeKind",
	"sessionName",
	"parentSessionId",
	"parentSessionPath",
]);

// Accepted runtimeKind values
const VALID_RUNTIME_KINDS = new Set(["top-level", "subagent"]);

function decodeResolved(raw: unknown): InternalResolvedSession | null {
	if (typeof raw !== "object" || raw === null) return null;
	const d = rawDescriptors(raw);
	if (!d) return null;
	const names = Object.getOwnPropertyNames(d);
	if (
		!names.includes("activeSessionId") ||
		!names.includes("sessionId") ||
		!names.includes("sessionDir") ||
		!names.includes("rlmDepth")
	) {
		return null;
	}
	if (names.some((n) => !RESOLVED_ALLOWED.has(n))) return null;

	for (const name of names) {
		const descriptor = d[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}

	const activeSessionId = value(d, "activeSessionId");
	const sessionId = value(d, "sessionId");
	const sessionDir = value(d, "sessionDir");
	const rlmDepthRaw = value(d, "rlmDepth");
	if (typeof activeSessionId !== "string" || !validId(activeSessionId)) return null;
	if (typeof sessionId !== "string" || !validId(sessionId)) return null;
	if (typeof sessionDir !== "string") return null;
	if (typeof rlmDepthRaw !== "number" || !Number.isSafeInteger(rlmDepthRaw) || rlmDepthRaw < 0) return null;

	let sessionName: string | undefined;
	let parentSessionId: string | undefined;
	let parentSessionPath: string | undefined;

	const snRaw = value(d, "sessionName");
	if ("sessionName" in d) {
		if (typeof snRaw !== "string") return null;
		sessionName = snRaw;
	}

	const piRaw = value(d, "parentSessionId");
	if ("parentSessionId" in d) {
		if (typeof piRaw !== "string" || !validId(piRaw)) return null;
		parentSessionId = piRaw;
	}

	const ppRaw = value(d, "parentSessionPath");
	if ("parentSessionPath" in d) {
		if (typeof ppRaw !== "string") return null;
		parentSessionPath = ppRaw;
	}

	const rkRaw = value(d, "runtimeKind");
	if ("runtimeKind" in d) {
		if (typeof rkRaw !== "string" || !VALID_RUNTIME_KINDS.has(rkRaw)) return null;
	}

	const result: {
		activeSessionId: string;
		sessionId: string;
		sessionDir: string;
		rlmDepth: number;
		sessionName?: string;
		parentSessionId?: string;
		parentSessionPath?: string;
	} = {
		activeSessionId,
		sessionId,
		sessionDir,
		rlmDepth: rlmDepthRaw,
	};
	if (sessionName !== undefined) result.sessionName = sessionName;
	if (parentSessionId !== undefined) result.parentSessionId = parentSessionId;
	if (parentSessionPath !== undefined) result.parentSessionPath = parentSessionPath;
	return Object.freeze(result);
}
function toCatalogEntry(s: InternalResolvedSession): AgentFamilyCatalogEntry {
	return Object.freeze({
		id: s.activeSessionId,
		name: s.sessionName,
		depth: s.rlmDepth,
		status: "running" as const,
		...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}),
		...(s.parentSessionPath ? { parentSessionPath: s.parentSessionPath } : {}),
		sessionPath: s.sessionDir,
	});
}

// ===========================================================================
// Result builders
// ===========================================================================

function failure(code: AuthorizerErrorCode): AuthorizerFailure {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}

function success<T>(value: T): AuthorizerResult<T> {
	return Object.freeze({ ok: true as const, value });
}

// ===========================================================================
// Extract inner value from TargetInboxResult<T>
// ===========================================================================

function extractTargetValue(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return undefined;
	const d = exact(raw, new Set(["ok", "value"]));
	if (!d || value(d, "ok") !== true) return undefined;
	return value(d, "value");
}

// ===========================================================================
// Factory — ownership-first
// ===========================================================================

export async function createPreAuthorizedInbox(raw: unknown): Promise<AuthorizerResult<PreAuthorizedInbox>> {
	const preliminary = preliminaryOwn(raw);
	const catalogRaw = preliminary.catalog;
	const inboxRaw = preliminary.inbox;

	const catalogClose = acquireClose(catalogRaw, "catalog");
	const inboxClose = acquireClose(inboxRaw, "inbox");

	const aliased = catalogRaw !== undefined && inboxRaw !== undefined && catalogRaw === inboxRaw;
	const ownedCloses: (() => Promise<boolean>)[] = [];
	if (aliased) {
		if (catalogClose) {
			let used = false;
			ownedCloses.push(async () => {
				if (used) return false;
				used = true;
				return catalogClose();
			});
		}
	} else {
		if (catalogClose) ownedCloses.push(catalogClose);
		if (inboxClose) ownedCloses.push(inboxClose);
	}

	const failClosed = async (code: AuthorizerErrorCode): Promise<AuthorizerFailure> => {
		const ok = await closeAll(ownedCloses);
		return ok ? failure(code) : failure("CLOSE_UNCERTAIN");
	};

	const descriptors = exact(raw, FACTORY_KEYS);
	if (!descriptors) return await failClosed("INVALID_ARGUMENT");
	if (aliased) return await failClosed("INVALID_ARGUMENT");

	const catalog = value(descriptors, "catalog");
	const catalogDesc = rawDescriptors(catalog);
	if (!catalogDesc) return await failClosed("INVALID_ARGUMENT");
	const catalogNames = Object.getOwnPropertyNames(catalogDesc);
	const CATALOG_REQUIRED = new Set(["close", "resolveSession"]);
	if (catalogNames.length !== CATALOG_REQUIRED.size || catalogNames.some((n) => !CATALOG_REQUIRED.has(n))) {
		return await failClosed("INVALID_ARGUMENT");
	}
	if (!catalogClose) return await failClosed("INVALID_ARGUMENT");
	const resolveSession = bindMethod(catalog, "resolveSession");
	if (!resolveSession) return await failClosed("INVALID_ARGUMENT");

	const inbox = value(descriptors, "inbox");
	const inboxDesc = rawDescriptors(inbox);
	if (!inboxDesc) return await failClosed("INVALID_ARGUMENT");
	const inboxNames = Object.getOwnPropertyNames(inboxDesc);
	const INBOX_REQUIRED = new Set(["admit", "close", "dispatchPending"]);
	if (inboxNames.length !== INBOX_REQUIRED.size || inboxNames.some((n) => !INBOX_REQUIRED.has(n))) {
		return await failClosed("INVALID_ARGUMENT");
	}
	if (!inboxClose) return await failClosed("INVALID_ARGUMENT");
	const inboxAdmit = bindMethod(inbox, "admit");
	const inboxDispatch = bindMethod(inbox, "dispatchPending");
	if (!inboxAdmit || !inboxDispatch) return await failClosed("INVALID_ARGUMENT");

	const adapter = new PreAuthorizedInboxImpl(resolveSession, catalogClose, inboxAdmit, inboxDispatch, inboxClose);
	return success(adapter.asCapability());
}

async function closeAll(closes: readonly (() => Promise<boolean>)[]): Promise<boolean> {
	// Close in reverse acquisition order serially
	let allOk = true;
	for (let i = closes.length - 1; i >= 0; i--) {
		const ok = await closes[i]().catch(() => false);
		if (!ok) allOk = false;
	}
	return allOk;
}

// ===========================================================================
// Implementation
// ===========================================================================

class PreAuthorizedInboxImpl {
	private operationTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<AuthorizerResult<void>> | null = null;
	private closed = false;
	private poisoned = false;

	constructor(
		private readonly resolveSession: (...args: readonly unknown[]) => unknown,
		private readonly catalogClose: () => Promise<boolean>,
		private readonly inboxAdmit: (...args: readonly unknown[]) => unknown,
		private readonly inboxDispatch: (...args: readonly unknown[]) => unknown,
		private readonly inboxClose: () => Promise<boolean>,
	) {}

	asCapability(): PreAuthorizedInbox {
		return Object.freeze({
			authorizeAdmit: (raw: unknown): Promise<AuthorizerResult<AuthorizeAndAdmitOutput>> => this.authorizeAdmit(raw),
			dispatchPending: (): Promise<
				| Readonly<{ ok: true; value: undefined }>
				| Readonly<{ ok: false; error: Readonly<{ code: AuthorizerErrorCode }> }>
			> => this.dispatchPending(),
			close: (): Promise<AuthorizerResult<void>> => this.close(),
		});
	}

	async authorizeAdmit(raw: unknown): Promise<AuthorizerResult<AuthorizeAndAdmitOutput>> {
		if (this.closed) return failure("CLOSED");
		if (this.poisoned) return failure("POISONED");
		return this.enqueueAuthResult(() => this.authorizeAdmitOrdered(raw));
	}

	private async authorizeAdmitOrdered(raw: unknown): Promise<AuthorizerResult<AuthorizeAndAdmitOutput>> {
		const d = exact(raw, ADMIT_INPUT_KEYS);
		if (!d) return failure("INVALID_ARGUMENT");
		const envelopeValue = value(d, "envelope");

		const decoded = decodeEnvelope(envelopeValue);
		if (!decoded.ok) return failure("INVALID_ARGUMENT");
		const env = decoded.value;
		if (env.frame.type !== "agent_message") return failure("INVALID_ARGUMENT");
		const agentDecoded = decodeAgentMessageFrame(env.frame);
		if (!agentDecoded.ok) return failure("INVALID_ARGUMENT");
		const agentFrame = agentDecoded.value;
		const fromId = agentFrame.fromActiveSessionId;
		const targetId = agentFrame.targetActiveSessionId;
		const messageId = agentFrame.id;
		if (!validId(fromId) || !validId(targetId) || !validId(messageId)) return failure("INVALID_ARGUMENT");

		const senderObs = await nativeObserve(() => this.resolveSession(fromId), OPERATION_TIMEOUT_MS);
		if (senderObs.status !== "fulfilled") {
			this.poisoned = true;
			return failure("UNCERTAIN");
		}
		const sender = decodeResolved(senderObs.value);
		if (!sender) return failure("NOT_FOUND");
		if (sender.activeSessionId !== fromId) return failure("STALE");

		const targetObs = await nativeObserve(() => this.resolveSession(targetId), OPERATION_TIMEOUT_MS);
		if (targetObs.status !== "fulfilled") {
			this.poisoned = true;
			return failure("UNCERTAIN");
		}
		const target = decodeResolved(targetObs.value);
		if (!target) return failure("NOT_FOUND");
		if (target.activeSessionId !== targetId) return failure("STALE");

		let senderToTarget: AgentFamilyRelationship;
		try {
			senderToTarget = assertAgentFamilyReach(toCatalogEntry(sender), toCatalogEntry(target));
		} catch {
			return failure("UNAUTHORIZED");
		}
		const fromRelationship: AgentFamilyRelationship =
			senderToTarget === "child" ? "parent" : senderToTarget === "parent" ? "child" : senderToTarget;

		const digestResult = canonicalDigest(agentFrame);
		if (!digestResult.ok) return failure("INVALID_ARGUMENT");
		const computedDigest = digestResult.value;

		const admitObs = await nativeObserve(
			() => this.inboxAdmit(Object.freeze({ envelope: env })),
			OPERATION_TIMEOUT_MS,
		);
		if (admitObs.status !== "fulfilled") {
			this.poisoned = true;
			return failure("POISONED");
		}

		const admitRaw = admitObs.value;
		const innerValue = extractTargetValue(admitRaw);
		const decodedReceipt = innerValue ? decodeAdmitReceipt(innerValue, env.frameId, messageId, computedDigest) : null;
		if (!decodedReceipt) {
			const errCode = decodeInboxError(admitRaw);
			if (errCode) {
				if (errCode === "POISONED" || errCode === "CLOSE_UNCERTAIN" || errCode === "MISMATCH") {
					this.poisoned = true;
				}
				return failure(errCode);
			}
			this.poisoned = true;
			return failure("POISONED");
		}

		return success(
			Object.freeze({
				allowed: true as const,
				relationship: Object.freeze({ fromRelationship }),
				receipt: decodedReceipt,
			}),
		);
	}

	async dispatchPending(): Promise<DispatchResult> {
		if (this.closed) return failDispatch("CLOSED");
		if (this.poisoned) return failDispatch("POISONED");
		return this.enqueueDispatch(() => this.dispatchPendingOrdered());
	}

	private async dispatchPendingOrdered(): Promise<DispatchResult> {
		const obs = await nativeObserve(() => this.inboxDispatch(), OPERATION_TIMEOUT_MS);
		if (obs.status !== "fulfilled") {
			this.poisoned = true;
			return failDispatch("POISONED");
		}
		if (decodeInboxOkVoid(obs.value)) return okVoid();
		const errCode = decodeInboxError(obs.value);
		if (errCode) {
			if (errCode === "POISONED" || errCode === "CLOSE_UNCERTAIN") this.poisoned = true;
			return failDispatch(errCode);
		}
		this.poisoned = true;
		return failDispatch("POISONED");
	}

	// ===================================================================
	// Close — directly stored shared Promise chain, serial reverse order
	// ===================================================================

	close(): Promise<AuthorizerResult<void>> {
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;

		const shared: Promise<AuthorizerResult<void>> = this.operationTail.then(async () => {
			// Close in reverse acquisition order: inbox first, then catalog
			const inboxOk = await this.inboxClose().catch(() => false);
			const catalogOk = await this.catalogClose().catch(() => false);
			if (inboxOk && catalogOk) return success(undefined);
			return failure("CLOSE_UNCERTAIN");
		});

		this.closePromise = shared;
		this.operationTail = shared.then(() => undefined);
		return shared;
	}

	// ===================================================================
	// Operation serialization
	// ===================================================================

	private enqueueAuthResult(
		op: () => Promise<AuthorizerResult<AuthorizeAndAdmitOutput>>,
	): Promise<AuthorizerResult<AuthorizeAndAdmitOutput>> {
		const tail = this.operationTail;
		const attempted = tail.then(() => {
			if (this.poisoned) return Promise.resolve(failure("POISONED"));
			return op();
		});
		const result = attempted.then(
			(v) => v,
			() => {
				this.poisoned = true;
				return Promise.resolve(failure("POISONED"));
			},
		);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private enqueueDispatch(op: () => Promise<DispatchResult>): Promise<DispatchResult> {
		const tail = this.operationTail;
		const attempted = tail.then(() => {
			if (this.poisoned) return Promise.resolve(failDispatch("POISONED"));
			return op();
		});
		const result = attempted.then(
			(v) => v,
			() => {
				this.poisoned = true;
				return Promise.resolve(failDispatch("POISONED"));
			},
		);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}

type DispatchResult =
	| Readonly<{ ok: true; value: undefined }>
	| Readonly<{ ok: false; error: Readonly<{ code: AuthorizerErrorCode }> }>;

function okVoid(): Readonly<{ ok: true; value: undefined }> {
	return Object.freeze({ ok: true as const, value: undefined });
}

function failDispatch(
	code: AuthorizerErrorCode,
): Readonly<{ ok: false; error: Readonly<{ code: AuthorizerErrorCode }> }> {
	return Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
}
