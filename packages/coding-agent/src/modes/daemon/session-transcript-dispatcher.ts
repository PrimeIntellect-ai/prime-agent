import { types } from "node:util";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyCatalogEntry,
	type AgentFamilyRelationship,
	type AgentSessionMessageEndpoint,
	type AgentSessionMessagePayload,
	type AgentSessionMessageSender,
	assertAgentFamilyReach,
} from "../../core/agent-messages.js";
import {
	canonicalDigest,
	decodeAgentMessageFrame,
	decodeEnvelope,
	digestsEqual,
	isValidDigest,
} from "./remote-host-frame-codec.js";

// ===========================================================================
// Contract
// ===========================================================================

export type TranscriptEvidence = "exact" | "mismatch" | "absent";

export interface EnsureResult {
	readonly status: "persisted" | "deferred";
}

export interface DispatcherCapability {
	readonly ensure: (raw: unknown) => Promise<EnsureResult>;
	readonly close: () => Promise<Readonly<{ status: "closed" | "error" }>>;
}

export interface DispatcherContext {
	resolveSession(activeSessionId: string): Promise<Record<string, unknown> | undefined>;
	getActiveSession(activeSessionId: string): Record<string, unknown> | undefined;
	acceptAgentMessage(
		targetActiveSessionId: string,
		payload: AgentSessionMessagePayload,
	): Promise<{ status: "delivered" | "queued" }>;
	searchTranscript(
		sessionDir: string,
		sessionId: string,
		messageId: string,
		digest: string,
	): Promise<TranscriptEvidence>;
}

// ===========================================================================
// Creation result
// ===========================================================================

export type TranscriptDispatcherResult =
	| Readonly<{ ok: true; value: DispatcherCapability }>
	| Readonly<{ ok: false; error: Readonly<{ code: "INVALID_ARGUMENT" | "CLOSE_UNCERTAIN" }> }>;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type OwnedClose = () => Promise<boolean>;

const ENSURE_INPUT_KEYS = new Set(["envelope", "semanticDigest"]);
const INJECTION_OK_KEYS = new Set(["status"]);
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

function valueFrom(descriptors: Descriptors, name: string): unknown {
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
// Exact native-Promise guard:
// non-Proxy, types.isPromise, exact Promise.prototype, zero own names/symbols
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
// Bind method from own enumerable descriptor (no casts, no prototype)
// ===========================================================================

function bindMethod(raw: object, name: string): ((...args: readonly unknown[]) => unknown) | null {
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
// Owned close — from descriptor-snapshot, exact {status:"closed"} only
// ===========================================================================

function acquireClose(raw: unknown): OwnedClose | null {
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
		const rd = exact(r, new Set(["status"]));
		return rd !== null && valueFrom(rd, "status") === "closed";
	};
}

// ===========================================================================
// Exact decoded session DTO
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

const RESOLVED_KEYS = new Set([
	"activeSessionId",
	"sessionId",
	"sessionDir",
	"rlmDepth",
	"runtimeKind",
	"sessionName",
	"parentSessionId",
	"parentSessionPath",
]);

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
	if (names.some((n) => !RESOLVED_KEYS.has(n))) return null;

	for (const name of names) {
		const descriptor = d[name];
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
	}

	const activeSessionId = valueFrom(d, "activeSessionId");
	const sessionId = valueFrom(d, "sessionId");
	const sessionDir = valueFrom(d, "sessionDir");
	const rlmDepthRaw = valueFrom(d, "rlmDepth");
	if (typeof activeSessionId !== "string" || !validId(activeSessionId)) return null;
	if (typeof sessionId !== "string" || !validId(sessionId)) return null;
	if (typeof sessionDir !== "string") return null;
	if (typeof rlmDepthRaw !== "number" || !Number.isSafeInteger(rlmDepthRaw) || rlmDepthRaw < 0) return null;

	let sessionName: string | undefined;
	let parentSessionId: string | undefined;
	let parentSessionPath: string | undefined;

	const snRaw = valueFrom(d, "sessionName");
	if ("sessionName" in d) {
		if (typeof snRaw !== "string") return null;
		sessionName = snRaw;
	}

	const piRaw = valueFrom(d, "parentSessionId");
	if ("parentSessionId" in d) {
		if (typeof piRaw !== "string" || !validId(piRaw)) return null;
		parentSessionId = piRaw;
	}

	const ppRaw = valueFrom(d, "parentSessionPath");
	if ("parentSessionPath" in d) {
		if (typeof ppRaw !== "string") return null;
		parentSessionPath = ppRaw;
	}

	const rkRaw = valueFrom(d, "runtimeKind");
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
// Transcript scanner — enumerable data properties only, malformed = throw
// ===========================================================================

function scanMessages(messages: readonly unknown[], messageId: string, digest: string): TranscriptEvidence {
	let foundExact = false;
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) throw new Error("MALFORMED_MESSAGE");
		const msgD = rawDescriptors(msg);
		if (!msgD) throw new Error("MALFORMED_MESSAGE");
		const names = Object.getOwnPropertyNames(msgD);
		if (!names.includes("role") || !names.includes("customType") || !names.includes("details")) continue;
		// Only accept enumerable data properties for role/customType/details
		const roleDesc = msgD.role;
		const ctDesc = msgD.customType;
		const detDesc = msgD.details;
		if (!roleDesc || !("value" in roleDesc) || !roleDesc.enumerable) throw new Error("NON_ENUMERABLE_ROLE");
		if (!ctDesc || !("value" in ctDesc) || !ctDesc.enumerable) throw new Error("NON_ENUMERABLE_CUSTOM_TYPE");
		if (!detDesc || !("value" in detDesc) || !detDesc.enumerable) throw new Error("NON_ENUMERABLE_DETAILS");
		if (valueFrom(msgD, "role") !== "custom" || valueFrom(msgD, "customType") !== AGENT_MESSAGE_CUSTOM_TYPE) continue;
		const detailsRaw = valueFrom(msgD, "details");
		const detailsD = rawDescriptors(detailsRaw);
		if (!detailsD) throw new Error("MALFORMED_DETAILS");
		const detNames = Object.getOwnPropertyNames(detailsD);
		const idDesc = detailsD.id;
		const sgDesc = detailsD.semanticDigest;
		if (!idDesc || !("value" in idDesc) || !idDesc.enumerable) throw new Error("NON_ENUMERABLE_ID");
		if (sgDesc && (!("value" in sgDesc) || !sgDesc.enumerable)) throw new Error("NON_ENUMERABLE_DIGEST");
		if (!detNames.includes("id")) continue;
		const msgId = valueFrom(detailsD, "id");
		if (msgId !== messageId) continue;
		// Found message with matching ID — check digest
		const stored = valueFrom(detailsD, "semanticDigest");
		if (typeof stored !== "string") return "mismatch";
		if (!digestsEqual(stored, digest)) return "mismatch";
		foundExact = true;
	}
	return foundExact ? "exact" : "absent";
}

function scanSnapshot(rawSnapshot: unknown, messageId: string, digest: string): TranscriptEvidence {
	if (rawSnapshot === undefined || rawSnapshot === null) return "absent";
	const snapD = rawDescriptors(rawSnapshot);
	if (!snapD) throw new Error("MALFORMED_SNAPSHOT");
	const names = Object.getOwnPropertyNames(snapD);
	if (!names.includes("messages")) throw new Error("MALFORMED_SNAPSHOT");
	const msgsDesc = snapD.messages;
	if (!msgsDesc || !("value" in msgsDesc) || !msgsDesc.enumerable) throw new Error("NON_ENUMERABLE_MESSAGES");
	const msgs = valueFrom(snapD, "messages");
	if (!Array.isArray(msgs)) throw new Error("MALFORMED_MESSAGES");
	return scanMessages(msgs, messageId, digest);
}

// ===========================================================================
// Exact result decoders (unknown in, exactly decoded out)
// ===========================================================================

function isTranscriptEvidence(raw: unknown): raw is TranscriptEvidence {
	return raw === "exact" || raw === "mismatch" || raw === "absent";
}

function decodeEvidence(raw: unknown): TranscriptEvidence {
	if (!isTranscriptEvidence(raw)) throw new Error("INVALID_EVIDENCE");
	return raw;
}

function isDeliverableStatus(raw: unknown): raw is "delivered" | "queued" {
	return raw === "delivered" || raw === "queued";
}

function decodeInjectionResult(raw: unknown): "delivered" | "queued" {
	if (typeof raw !== "object" || raw === null) throw new Error("INVALID_INJECTION");
	const d = exact(raw, INJECTION_OK_KEYS);
	if (!d) throw new Error("INVALID_INJECTION");
	const s = valueFrom(d, "status");
	if (!isDeliverableStatus(s)) throw new Error("INVALID_INJECTION");
	return s;
}

function combineEvidence(ev1: TranscriptEvidence, ev2: TranscriptEvidence): TranscriptEvidence {
	if (ev1 === "mismatch" || ev2 === "mismatch") return "mismatch";
	if (ev1 === "exact" || ev2 === "exact") return "exact";
	return "absent";
}

// ===========================================================================
// Factory — ownership-first: acquire close from preliminary descriptors
// before validation. Every failure awaits acquireClose.
// ===========================================================================

const CONTEXT_KEYS = new Set(["acceptAgentMessage", "close", "getActiveSession", "resolveSession", "searchTranscript"]);

export async function createSessionTranscriptDispatcher(raw: unknown): Promise<TranscriptDispatcherResult> {
	// Phase 1: safely extract preliminary context value for close acquisition
	if (typeof raw !== "object" || raw === null || types.isProxy(raw)) {
		return Object.freeze({ ok: false as const, error: Object.freeze({ code: "INVALID_ARGUMENT" as const }) });
	}
	const contextClose = acquireClose(raw);
	if (!contextClose) {
		return Object.freeze({ ok: false as const, error: Object.freeze({ code: "INVALID_ARGUMENT" as const }) });
	}

	const failClosed = async (code: "INVALID_ARGUMENT" | "CLOSE_UNCERTAIN"): Promise<TranscriptDispatcherResult> => {
		const ok = await contextClose();
		return Object.freeze({
			ok: false as const,
			error: Object.freeze({ code: ok ? code : ("CLOSE_UNCERTAIN" as const) }),
		});
	};

	// Phase 2: validate context shape
	const rd = rawDescriptors(raw);
	if (!rd) return await failClosed("INVALID_ARGUMENT");
	const names = Object.getOwnPropertyNames(rd);
	if (names.length !== CONTEXT_KEYS.size || names.some((n) => !CONTEXT_KEYS.has(n))) {
		return await failClosed("INVALID_ARGUMENT");
	}

	const resolveSession = bindMethod(raw, "resolveSession");
	const getActiveSession = bindMethod(raw, "getActiveSession");
	const acceptAgentMessage = bindMethod(raw, "acceptAgentMessage");
	const searchTranscript = bindMethod(raw, "searchTranscript");

	if (!resolveSession || !getActiveSession || !acceptAgentMessage || !searchTranscript) {
		return await failClosed("INVALID_ARGUMENT");
	}

	const impl = new TranscriptDispatcherImpl(
		resolveSession,
		getActiveSession,
		acceptAgentMessage,
		searchTranscript,
		contextClose,
	);
	return Object.freeze({ ok: true as const, value: impl.asCapability() });
}

// ===========================================================================
// Implementation
// ===========================================================================

class TranscriptDispatcherImpl {
	private operationTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<Readonly<{ status: "closed" | "error" }>> | null = null;
	private closed = false;
	private poisoned = false;

	constructor(
		private readonly resolveSession: (...args: readonly unknown[]) => unknown,
		private readonly getActiveSession: (...args: readonly unknown[]) => unknown,
		private readonly acceptAgentMessage: (...args: readonly unknown[]) => unknown,
		private readonly searchTranscript: (...args: readonly unknown[]) => unknown,
		private readonly contextClose: () => Promise<boolean>,
	) {}

	asCapability(): DispatcherCapability {
		return Object.freeze({
			ensure: (raw: unknown): Promise<EnsureResult> => this.ensure(raw),
			close: (): Promise<Readonly<{ status: "closed" | "error" }>> => this.close(),
		});
	}

	private async ensure(raw: unknown): Promise<EnsureResult> {
		if (this.closed) throw new Error("CLOSED");
		if (this.poisoned) throw new Error("POISONED");
		return this.ensureOrdered(raw);
	}

	private async ensureOrdered(raw: unknown): Promise<EnsureResult> {
		return this.enqueueOperation(() => this.ensureSerial(raw));
	}

	private async ensureSerial(raw: unknown): Promise<EnsureResult> {
		// ---- Phase 1: validate and snapshot input ----
		const d = exact(raw, ENSURE_INPUT_KEYS);
		if (!d) {
			this.poisoned = true;
			throw new Error("INVALID_INPUT");
		}
		const envelope = valueFrom(d, "envelope");
		const semanticDigest = valueFrom(d, "semanticDigest");
		if (!envelope || typeof semanticDigest !== "string" || !isValidDigest(semanticDigest)) {
			this.poisoned = true;
			throw new Error("INVALID_INPUT");
		}

		// ---- Phase 2: re-decode and re-compute ----
		const decoded = decodeEnvelope(envelope);
		if (!decoded.ok) {
			this.poisoned = true;
			throw new Error("INVALID_ENVELOPE");
		}
		const env = decoded.value;
		if (env.frame.type !== "agent_message") {
			this.poisoned = true;
			throw new Error("INVALID_FRAME");
		}
		const frameDecoded = decodeAgentMessageFrame(env.frame);
		if (!frameDecoded.ok) {
			this.poisoned = true;
			throw new Error("INVALID_FRAME");
		}
		const agentFrame = frameDecoded.value;
		const digestResult = canonicalDigest(agentFrame);
		if (!digestResult.ok) {
			this.poisoned = true;
			throw new Error("INVALID_DIGEST");
		}
		if (!digestsEqual(digestResult.value, semanticDigest)) {
			this.poisoned = true;
			throw new Error("MISMATCH");
		}
		const computedDigest = digestResult.value;
		const messageId = agentFrame.id;
		const targetId = agentFrame.targetActiveSessionId;
		const fromId = agentFrame.fromActiveSessionId;
		const message = agentFrame.message;
		if (!validId(messageId) || !validId(targetId) || !validId(fromId)) {
			this.poisoned = true;
			throw new Error("INVALID_IDS");
		}

		// ---- Phase 3: resolve target and validate ----
		const resolveObs = await nativeObserve(() => this.resolveSession(targetId), OPERATION_TIMEOUT_MS);
		if (resolveObs.status !== "fulfilled") {
			this.poisoned = true;
			throw new Error("UNCERTAIN");
		}
		const resolved = decodeResolved(resolveObs.value);
		if (!resolved) {
			this.poisoned = true;
			throw new Error("UNKNOWN_TARGET");
		}
		if (resolved.activeSessionId !== targetId) {
			this.poisoned = true;
			throw new Error("STALE_TARGET");
		}

		// ---- Phase 4: resolve sender and validate ----
		const senderObs = await nativeObserve(() => this.resolveSession(fromId), OPERATION_TIMEOUT_MS);
		if (senderObs.status !== "fulfilled") {
			this.poisoned = true;
			throw new Error("UNCERTAIN");
		}
		const sender = decodeResolved(senderObs.value);
		if (!sender) {
			this.poisoned = true;
			throw new Error("UNKNOWN_SENDER");
		}
		if (sender.activeSessionId !== fromId) {
			this.poisoned = true;
			throw new Error("STALE_SENDER");
		}

		// ---- Phase 5: family reach ----
		let fromRelationship: AgentFamilyRelationship;
		try {
			const senderToTarget = assertAgentFamilyReach(toCatalogEntry(sender), toCatalogEntry(resolved));
			fromRelationship =
				senderToTarget === "child" ? "parent" : senderToTarget === "parent" ? "child" : senderToTarget;
		} catch {
			this.poisoned = true;
			throw new Error("UNAUTHORIZED");
		}

		// ---- Phase 6: search BOTH evidence sources ----
		// A failure/throw in either source poisons — mismatch dominates.
		let evidence: TranscriptEvidence = "absent";
		try {
			// In-memory source
			const memRaw = this.getActiveSession(targetId);
			const memEv = scanSnapshot(memRaw, messageId, computedDigest);
			// On-disk source
			const diskObs = await nativeObserve(
				() => this.searchTranscript(resolved.sessionDir, resolved.sessionId, messageId, computedDigest),
				OPERATION_TIMEOUT_MS,
			);
			if (diskObs.status !== "fulfilled") {
				this.poisoned = true;
				throw new Error("UNCERTAIN");
			}
			const diskEv = decodeEvidence(diskObs.value);
			evidence = combineEvidence(memEv, diskEv);
		} catch (e) {
			this.poisoned = true;
			throw e;
		}

		if (evidence === "mismatch") {
			this.poisoned = true;
			throw new Error("MISMATCH");
		}
		if (evidence === "exact") return Object.freeze({ status: "persisted" as const });

		// ---- Phase 7: not found — inject ----
		const fromEndpoint: AgentSessionMessageSender = Object.freeze({ activeSessionId: fromId });
		const targetEndpoint: AgentSessionMessageEndpoint = Object.freeze({
			activeSessionId: targetId,
			sessionId: resolved.sessionId,
			...(resolved.sessionName !== undefined ? { sessionName: resolved.sessionName } : {}),
		});
		const payload: AgentSessionMessagePayload = Object.freeze({
			id: messageId,
			source: AGENT_MESSAGE_SOURCE,
			message,
			from: fromEndpoint,
			fromRelationship,
			target: targetEndpoint,
			semanticDigest: computedDigest,
		});

		const injectObs = await nativeObserve(() => this.acceptAgentMessage(targetId, payload), OPERATION_TIMEOUT_MS);
		if (injectObs.status !== "fulfilled") {
			this.poisoned = true;
			throw new Error("INJECTION_FAILED");
		}
		const injectResult = decodeInjectionResult(injectObs.value);
		if (injectResult === "queued") return Object.freeze({ status: "deferred" as const });

		// ---- Phase 8: re-check BOTH evidence sources after delivery ----
		// Always query both; a reject/timeout poisons even if memory shows exact.
		try {
			const reMemRaw = this.getActiveSession(targetId);
			let reMemEv: TranscriptEvidence;
			try {
				reMemEv = scanSnapshot(reMemRaw, messageId, computedDigest);
			} catch (e) {
				this.poisoned = true;
				throw e;
			}
			const reDiskObs = await nativeObserve(
				() => this.searchTranscript(resolved.sessionDir, resolved.sessionId, messageId, computedDigest),
				OPERATION_TIMEOUT_MS,
			);
			if (reDiskObs.status !== "fulfilled") {
				this.poisoned = true;
				throw new Error("UNCERTAIN");
			}
			const reDiskEv = decodeEvidence(reDiskObs.value);
			const postEvidence = combineEvidence(reMemEv, reDiskEv);

			if (postEvidence === "exact") return Object.freeze({ status: "persisted" as const });
			if (postEvidence === "mismatch") {
				this.poisoned = true;
				throw new Error("MISMATCH");
			}
		} catch (e) {
			this.poisoned = true;
			throw e;
		}

		this.poisoned = true;
		throw new Error("INJECTION_UNCERTAIN");
	}

	// ===================================================================
	// Close — non-async, shared Promise
	// ===================================================================

	close(): Promise<Readonly<{ status: "closed" | "error" }>> {
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;

		const shared: Promise<Readonly<{ status: "closed" | "error" }>> = this.operationTail.then(async () => {
			const ok = await this.contextClose().catch(() => false);
			return Object.freeze({ status: ok ? ("closed" as const) : ("error" as const) });
		});

		this.closePromise = shared;
		this.operationTail = shared.then(() => undefined);
		return shared;
	}

	// ===================================================================
	// Operation serialization
	// ===================================================================

	private enqueueOperation(op: () => Promise<EnsureResult>): Promise<EnsureResult> {
		const attempted: Promise<EnsureResult> = this.operationTail.then(() => {
			if (this.poisoned) return Promise.reject<EnsureResult>(new Error("POISONED"));
			return op();
		});
		const result: Promise<EnsureResult> = attempted.then(
			(v) => v,
			(e: unknown) => {
				this.poisoned = true;
				return Promise.reject<EnsureResult>(e);
			},
		);
		this.operationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
}
