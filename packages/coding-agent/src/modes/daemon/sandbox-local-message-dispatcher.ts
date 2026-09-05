import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import {
	AGENT_MESSAGE_SOURCE,
	type AgentSessionMessagePayload,
	createAgentSessionMessage,
} from "../../core/agent-messages.js";
import { isAgentSessionInstance } from "../../core/agent-session.js";
import type { DispatcherCapability, EnsureResult } from "./durable-target-inbox.js";
import type { RemoteHostAgentMessageFrame, RemoteHostFrameEnvelope } from "./remote-agent-host-protocol.js";
import {
	canonicalDigest,
	decodeAgentMessageFrame,
	decodeEnvelope,
	digestsEqual,
	isValidDigest,
} from "./remote-host-frame-codec.js";
import { searchSessionTranscript, type TranscriptEvidence } from "./session-transcript-file-scanner.js";

// ===========================================================================
// Constants
// ===========================================================================

const FACTORY_KEYS = new Set(["activeSessionId", "session", "sessionDir"]);
const ENSURE_INPUT_KEYS = new Set(["envelope", "semanticDigest"]);
const OPERATION_TIMEOUT_MS = 30_000;

// ===========================================================================
// Result types
// ===========================================================================

export type SandboxDispatcherCloseResult = Readonly<{ status: "closed" }> | Readonly<{ status: "error" }>;

export type CreateDispatcherErrorCode = "INVALID_ARGUMENT";

export type CreateDispatcherResult =
	| Readonly<{ ok: true; dispatcher: DispatcherCapability }>
	| Readonly<{ ok: false; error: Readonly<{ code: CreateDispatcherErrorCode }> }>;

// ===========================================================================
// Internal types
// ===========================================================================

type Descriptors = Readonly<Record<string, PropertyDescriptor>>;
type BoundMethod = (...args: readonly unknown[]) => unknown;
type MessagesGetter = () => readonly unknown[];

interface NativePromiseObservation {
	readonly status: "fulfilled" | "rejected" | "timeout" | "invalid";
	readonly value?: unknown;
}

// ===========================================================================
// Sentinel: thrown on poison/mismatch
// ===========================================================================
const POISON_SENTINEL = Object.freeze({ poison: true });

// ===========================================================================
// Captured intrinsics (one capture, no live access)
// ===========================================================================

const promiseThen = Promise.prototype.then;
const promisePrototype = Promise.prototype;
const arrayPrototype = Array.prototype;
const MAX_DENSE_LENGTH = 20_000;

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
// Dense array validation — uses exact property descriptors to reject:
// Proxy, custom prototype, symbols, holes, accessor indices,
// non-enumerable indices, extra own keys, invalid length descriptor.
// Reject Proxy first, then use Array.isArray (safe after Proxy rejection).
// ===========================================================================

function denseArray(raw: unknown): readonly unknown[] | null {
	if (typeof raw !== "object" || raw === null) return null;
	try {
		if (types.isProxy(raw)) return null;
	} catch {
		return null;
	}
	// Array.isArray is safe after Proxy rejection
	if (!Array.isArray(raw)) return null;
	const arr = raw;
	if (Object.getPrototypeOf(arr) !== arrayPrototype) return null;
	try {
		if (Object.getOwnPropertySymbols(arr).length !== 0) return null;
	} catch {
		return null;
	}
	const descs = Object.getOwnPropertyDescriptors(arr);
	const names = Object.getOwnPropertyNames(descs);
	// Must have "length"
	if (!names.includes("length")) return null;
	const lenDesc = Object.getOwnPropertyDescriptor(arr, "length");
	if (lenDesc === undefined || lenDesc.enumerable) return null;
	if (!("value" in lenDesc)) return null;
	const lenVal = lenDesc.value;
	if (typeof lenVal !== "number" || !Number.isInteger(lenVal) || lenVal < 0 || lenVal > MAX_DENSE_LENGTH) return null;
	// Count own data descriptors that are enumerable and numeric with canonical spelling
	let ownIndexCount = 0;
	for (const name of names) {
		if (name === "length") continue;
		const parsed = Number(name);
		if (!Number.isInteger(parsed) || parsed < 0 || parsed >= lenVal) return null;
		// Canonical index spelling: String(parsed) must equal name so "01" cannot mask a hole
		if (String(parsed) !== name) return null;
		const desc = descs[name];
		if (desc === undefined || !("value" in desc) || !desc.enumerable) return null;
		ownIndexCount++;
	}
	// No holes
	if (ownIndexCount !== lenVal) return null;
	return arr;
}

// ===========================================================================
// Native promise helpers
// ===========================================================================

function isNativePromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
		if (!types.isPromise(raw)) return false;
		if (Object.getPrototypeOf(raw) !== promisePrototype) return false;
		if (Object.getOwnPropertyNames(raw).length !== 0) return false;
		if (Object.getOwnPropertySymbols(raw).length !== 0) return false;
		return true;
	} catch {
		return false;
	}
}

function obsValue(v: unknown): { status: "fulfilled"; value: unknown } {
	return { status: "fulfilled", value: v };
}

function rejectedObs(): { status: "rejected" } {
	return { status: "rejected" };
}

function invalidObs(): { status: "invalid" } {
	return { status: "invalid" };
}

function timeoutObs(): { status: "timeout" } {
	return { status: "timeout" };
}
function observePromise(raw: unknown, timeoutMs: number): Promise<NativePromiseObservation> {
	if (!isNativePromise(raw)) {
		return new Promise<NativePromiseObservation>((resolve) => {
			resolve(invalidObs());
		});
	}
	return new Promise((resolve) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			resolve(timeoutObs());
		}, timeoutMs);
		try {
			Reflect.apply(promiseThen, raw, [
				(v: unknown) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(obsValue(v));
				},
				() => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					resolve(rejectedObs());
				},
			]);
		} catch {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(invalidObs());
		}
	});
}

function invoke(call: () => unknown, timeoutMs: number): Promise<NativePromiseObservation> {
	let raw: unknown;
	try {
		raw = call();
	} catch {
		return new Promise<NativePromiseObservation>((resolve) => {
			resolve(rejectedObs());
		});
	}
	return observePromise(raw, timeoutMs);
}

// ===========================================================================
// Result builders
// ===========================================================================

function persisted(): EnsureResult {
	return Object.freeze({ status: "persisted" });
}

function deferred(): EnsureResult {
	return Object.freeze({ status: "deferred" });
}

function closedResult(): SandboxDispatcherCloseResult {
	return Object.freeze({ status: "closed" });
}

function closeErrorResult(): SandboxDispatcherCloseResult {
	return Object.freeze({ status: "error" });
}

// ===========================================================================
// Evidence scanning — in-memory messages
// ===========================================================================

function scanMessages(messages: readonly unknown[], messageId: string, digest: string): TranscriptEvidence {
	let foundExact = false;
	for (const msg of messages) {
		if (typeof msg !== "object" || msg === null) continue;
		const msgD = rawDescriptors(msg);
		if (msgD === null) return "mismatch";
		const names = Object.getOwnPropertyNames(msgD);
		if (!names.includes("role") || !names.includes("customType") || !names.includes("details")) continue;
		const roleDesc = msgD.role;
		const ctDesc = msgD.customType;
		const detDesc = msgD.details;
		if (!roleDesc || !("value" in roleDesc) || !roleDesc.enumerable) continue;
		if (!ctDesc || !("value" in ctDesc) || !ctDesc.enumerable) continue;
		if (!detDesc || !("value" in detDesc) || !detDesc.enumerable) continue;
		if (value(msgD, "role") !== "custom") continue;
		const customType = value(msgD, "customType");
		if (customType !== "agent_message") continue;
		const detailsRaw = value(msgD, "details");
		if (typeof detailsRaw !== "object" || detailsRaw === null) continue;
		const detailsD = rawDescriptors(detailsRaw);
		if (!detailsD) continue;
		const detNames = Object.getOwnPropertyNames(detailsD);
		if (!detNames.includes("id")) continue;
		const idDesc = detailsD.id;
		if (!idDesc || !("value" in idDesc) || !idDesc.enumerable) continue;
		const msgId = value(detailsD, "id");
		if (msgId !== messageId) continue;
		const sgDesc = detailsD.semanticDigest;
		if (!sgDesc || !("value" in sgDesc) || !sgDesc.enumerable) {
			return "mismatch";
		}
		const stored = value(detailsD, "semanticDigest");
		if (typeof stored !== "string" || !isValidDigest(stored)) return "mismatch";
		if (!digestsEqual(stored, digest)) return "mismatch";
		foundExact = true;
	}
	return foundExact ? "exact" : "absent";
}

function combineEvidence(ev1: TranscriptEvidence, ev2: TranscriptEvidence): TranscriptEvidence {
	if (ev1 === "mismatch" || ev2 === "mismatch") return "mismatch";
	if (ev1 === "exact" || ev2 === "exact") return "exact";
	return "absent";
}

// ===========================================================================
// Queued action snapshot scanner
// ===========================================================================

function scanQueuedSnapshot(snapshot: unknown, messageId: string, digest: string): TranscriptEvidence {
	// Top-level: only truly null/undefined is absent. Proxy/malformed is mismatch.
	if (typeof snapshot !== "object" || snapshot === null) return "absent";
	const snapD = rawDescriptors(snapshot);
	if (snapD === null) return "mismatch";
	const snapNames = Object.getOwnPropertyNames(snapD);
	if (!snapNames.includes("actions") || !snapNames.includes("formatVersion")) return "absent";
	const actionsDesc = snapD.actions;
	if (actionsDesc === undefined || !("value" in actionsDesc) || !actionsDesc.enumerable) return "mismatch";
	const actions = denseArray(actionsDesc.value);
	if (actions === null) return "mismatch";
	for (const action of actions) {
		if (typeof action !== "object" || action === null) return "mismatch";
		const actionD = rawDescriptors(action);
		if (actionD === null) return "mismatch";
		const actionNames = Object.getOwnPropertyNames(actionD);
		if (!actionNames.includes("agentMessageId") || !actionNames.includes("payload")) continue;
		const amiDesc = actionD.agentMessageId;
		if (amiDesc === undefined || !("value" in amiDesc) || !amiDesc.enumerable) continue;
		if (amiDesc.value !== messageId) continue;

		// Found matching agentMessageId — validate entire nested chain
		const payloadDesc = actionD.payload;
		if (payloadDesc === undefined || !("value" in payloadDesc) || !payloadDesc.enumerable) return "mismatch";
		const payload = payloadDesc.value;
		if (typeof payload !== "object" || payload === null) return "mismatch";
		const payloadD = rawDescriptors(payload);
		if (payloadD === null) return "mismatch";
		const payloadNames = Object.getOwnPropertyNames(payloadD);
		if (!payloadNames.includes("customMessage")) return "mismatch";
		const cmDesc = payloadD.customMessage;
		if (cmDesc === undefined || !("value" in cmDesc) || !cmDesc.enumerable) return "mismatch";
		const cm = cmDesc.value;
		if (typeof cm !== "object" || cm === null) return "mismatch";
		const cmD = rawDescriptors(cm);
		if (cmD === null) return "mismatch";
		const cmNames = Object.getOwnPropertyNames(cmD);
		if (!cmNames.includes("details")) return "mismatch";
		const detailDesc = cmD.details;
		if (detailDesc === undefined || !("value" in detailDesc) || !detailDesc.enumerable) return "mismatch";
		const details = detailDesc.value;
		if (typeof details !== "object" || details === null) return "mismatch";
		const detailsD = rawDescriptors(details);
		if (detailsD === null) return "mismatch";
		const detailNames = Object.getOwnPropertyNames(detailsD);
		if (!detailNames.includes("id")) return "mismatch";
		const idDesc = detailsD.id;
		if (idDesc === undefined || !("value" in idDesc) || !idDesc.enumerable) return "mismatch";
		const storedId = idDesc.value;
		if (storedId !== messageId) return "mismatch";
		// Validate digest
		const sgDesc = detailsD.semanticDigest;
		if (sgDesc === undefined || !("value" in sgDesc) || !sgDesc.enumerable) return "mismatch";
		const stored = sgDesc.value;
		if (typeof stored !== "string") return "mismatch";
		if (!isValidDigest(stored)) return "mismatch";
		if (!digestsEqual(stored, digest)) return "mismatch";
		// All fields match exactly
		return "exact";
	}
	// Valid snapshot structure with no matching agentMessageId = absent
	return "absent";
}

// ===========================================================================
// Implementation
// ===========================================================================

class SandboxLocalDispatcherImpl {
	private operationTail: Promise<void> = Promise.resolve();
	private closePromise: Promise<SandboxDispatcherCloseResult> | null = null;
	private closed = false;
	private poisoned = false;
	private readonly asyncContext = new AsyncLocalStorage<boolean>();

	constructor(
		private readonly acceptAgentMessagePrompt: BoundMethod,
		private readonly getSessionActionRecoverySnapshot: BoundMethod,
		private readonly getMessages: MessagesGetter,
		private readonly sessionId: string,
		private readonly activeSessionId: string,
		private readonly sessionDir: string,
	) {}

	private poison(): never {
		this.poisoned = true;
		throw POISON_SENTINEL;
	}

	// -----------------------------------------------------------------------
	// Ensure
	// -----------------------------------------------------------------------

	async ensure(raw: unknown): Promise<EnsureResult> {
		if (this.asyncContext.getStore() === true) {
			return this.poison();
		}
		if (this.closed) return this.poison();
		if (this.poisoned) return this.poison();

		const d = exact(raw, ENSURE_INPUT_KEYS);
		if (!d) return this.poison();
		const envelopeValue = value(d, "envelope");
		const semanticDigest = value(d, "semanticDigest");

		if (typeof semanticDigest !== "string" || !isValidDigest(semanticDigest)) return this.poison();

		const decoded = decodeEnvelope(envelopeValue);
		if (!decoded.ok) return this.poison();
		const envelope = decoded.value;
		if (envelope.frame.type !== "agent_message") return this.poison();

		const agentDecoded = decodeAgentMessageFrame(envelope.frame);
		if (!agentDecoded.ok) return this.poison();
		const agentFrame = agentDecoded.value;

		// Verify fixed activeSessionId binding
		if (agentFrame.targetActiveSessionId !== this.activeSessionId) return this.poison();

		const digestResult = canonicalDigest(agentFrame);
		if (!digestResult.ok) return this.poison();
		const computedDigest = digestResult.value;
		if (!digestsEqual(computedDigest, semanticDigest)) return this.poison();

		const messageId = agentFrame.id;
		if (!validId(messageId)) return this.poison();

		return this.enqueue(() => this.ensureOrdered(envelope, agentFrame, messageId, computedDigest));
	}

	private async ensureOrdered(
		_envelope: RemoteHostFrameEnvelope,
		agentFrame: RemoteHostAgentMessageFrame,
		messageId: string,
		computedDigest: string,
	): Promise<EnsureResult> {
		// Phase 1: Check in-memory evidence
		let messages: readonly unknown[];
		try {
			messages = this.getMessages();
		} catch {
			return this.poison();
		}
		// Validate messages is a proper dense array before iterating
		if (denseArray(messages) === null) return this.poison();
		const memEv = scanMessages(messages, messageId, computedDigest);

		// Phase 2: Check on-disk evidence
		let diskEv: TranscriptEvidence;
		try {
			const searchResult = await searchSessionTranscript(
				Object.freeze({
					sessionDir: this.sessionDir,
					sessionId: this.sessionId,
					messageId,
					semanticDigest: computedDigest,
				}),
			);
			if (!searchResult.ok) return this.poison();
			diskEv = searchResult.value;
		} catch {
			return this.poison();
		}

		const evidence = combineEvidence(memEv, diskEv);
		if (evidence === "mismatch") return this.poison();
		if (evidence === "exact") return persisted();

		// Phase 3: Check queued action snapshot before injecting
		let queueEv: TranscriptEvidence;
		try {
			const snapshot = this.getSessionActionRecoverySnapshot();
			queueEv = scanQueuedSnapshot(snapshot, messageId, computedDigest);
		} catch {
			return this.poison();
		}

		if (queueEv === "mismatch") return this.poison();
		if (queueEv === "exact") return deferred();

		// Phase 4: Not found anywhere — inject
		const payload: AgentSessionMessagePayload = Object.freeze({
			id: messageId,
			source: AGENT_MESSAGE_SOURCE,
			message: agentFrame.message,
			from: Object.freeze({
				activeSessionId: agentFrame.fromActiveSessionId,
			}),
			target: Object.freeze({
				activeSessionId: this.activeSessionId,
				sessionId: this.sessionId,
			}),
			semanticDigest: computedDigest,
		});
		const customMessage = createAgentSessionMessage(payload);
		const deliveryMode = agentFrame.deliveryMode ?? "queued";
		const queueIfBusy = deliveryMode === "queued";

		// Capture preflight outcome
		let preflightQueued = false;
		let preflightFailed = false;

		const injectObs = await this.asyncContext.run(true, () =>
			invoke(
				() =>
					this.acceptAgentMessagePrompt(customMessage.content, {
						expandPromptTemplates: false,
						streamingBehavior: "steer",
						queueIfBusy,
						customMessage,
						preflightResult: (success: boolean, queued?: boolean) => {
							preflightFailed = !success;
							if (success && queued === true) preflightQueued = true;
						},
					}),
				OPERATION_TIMEOUT_MS,
			),
		);

		if (injectObs.status !== "fulfilled") return this.poison();
		if (this.poisoned) return this.poison();
		if (preflightFailed) return this.poison();

		if (preflightQueued) {
			// Message was queued (ActionStore). Verify queued snapshot.
			try {
				const snapshot = this.getSessionActionRecoverySnapshot();
				const afterEv = scanQueuedSnapshot(snapshot, messageId, computedDigest);
				if (afterEv === "mismatch") return this.poison();
				if (afterEv === "exact") return deferred();
			} catch {
				// Snapshot call failed — ingress may be okay but we can't confirm
				return this.poison();
			}
			return this.poison();
		}

		// Direct delivery: re-check evidence to confirm persistence
		let postMemEv: TranscriptEvidence;
		try {
			const postMessages = this.getMessages();
			postMemEv = scanMessages(postMessages, messageId, computedDigest);
		} catch {
			return this.poison();
		}

		let postDiskEv: TranscriptEvidence;
		try {
			const postSearch = await searchSessionTranscript(
				Object.freeze({
					sessionDir: this.sessionDir,
					sessionId: this.sessionId,
					messageId,
					semanticDigest: computedDigest,
				}),
			);
			if (!postSearch.ok) return this.poison();
			postDiskEv = postSearch.value;
		} catch {
			return this.poison();
		}

		const postEv = combineEvidence(postMemEv, postDiskEv);
		if (postEv === "mismatch") return this.poison();
		if (postEv === "exact") return persisted();

		// After direct delivery, evidence should be exact. If not, uncertain.
		return this.poison();
	}

	// -----------------------------------------------------------------------
	// Close
	// -----------------------------------------------------------------------

	close(): Promise<SandboxDispatcherCloseResult> {
		if (this.asyncContext.getStore() === true) {
			this.closed = true;
			return new Promise<SandboxDispatcherCloseResult>((resolve) => {
				resolve(closeErrorResult());
			});
		}
		if (this.closePromise !== null) return this.closePromise;
		this.closed = true;
		this.closePromise = this.operationTail.then(
			() => closedResult(),
			() => closedResult(),
		);
		return this.closePromise;
	}

	// =======================================================================
	// Serialization
	// =======================================================================

	private enqueue(operation: () => Promise<EnsureResult>): Promise<EnsureResult> {
		const guarded = this.operationTail
			.then(
				() => {
					if (this.poisoned) {
						throw POISON_SENTINEL;
					}
					return operation();
				},
				() => {
					throw POISON_SENTINEL;
				},
			)
			.then(
				(v) => v,
				() => {
					this.poisoned = true;
					throw POISON_SENTINEL;
				},
			);
		this.operationTail = guarded.then(
			() => undefined,
			() => undefined,
		);
		return guarded;
	}
}

// ===========================================================================
// Factory
// ===========================================================================

export async function createSandboxLocalMessageDispatcher(raw: unknown): Promise<CreateDispatcherResult> {
	// Phase 1: validate factory input shape
	const descriptors = exact(raw, FACTORY_KEYS);
	if (descriptors === null) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	// Phase 2: safely extract session value — data descriptor only
	let sessionRaw: unknown;
	if (typeof raw === "object" && raw !== null) {
		try {
			if (types.isProxy(raw)) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			const descriptor = Object.getOwnPropertyDescriptor(raw, "session");
			if (descriptor === undefined || !("value" in descriptor)) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			sessionRaw = descriptor.value;
		} catch {
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
	} else {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	// Phase 3: validate session brand
	if (typeof sessionRaw !== "object" || sessionRaw === null || !isAgentSessionInstance(sessionRaw)) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}
	const sessionObj: object = sessionRaw;

	// Phase 4: validate activeSessionId + sessionDir
	const rawSid = value(descriptors, "activeSessionId");
	if (typeof rawSid !== "string" || !validId(rawSid)) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}
	const boundActiveSessionId: string = rawSid;

	const rawSd = value(descriptors, "sessionDir");
	if (typeof rawSd !== "string" || rawSd.length < 1 || rawSd.length > 4096 || rawSd.includes("\0")) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}
	const boundSessionDir: string = rawSd;

	// Phase 5: capture methods — own first, then prototype fallback
	// Own-descriptor check: reject hostile shadow (accessor, non-function, Proxy)
	// Prototype: accept getter/value descriptors

	const ownDesc = Object.getOwnPropertyDescriptors(sessionObj);
	const ownNames = Object.getOwnPropertyNames(ownDesc);

	let acceptMethod: BoundMethod | null = null;
	let snapshotMethod: BoundMethod | null = null;
	let messagesGetter: MessagesGetter | null = null;
	let sessionIdValue: string | null = null;

	// --- acceptAgentMessagePrompt ---
	if (ownNames.includes("acceptAgentMessagePrompt")) {
		const d = ownDesc.acceptAgentMessagePrompt;
		if (!("value" in d) || typeof d.value !== "function") {
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
		try {
			if (types.isProxy(d.value)) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
		} catch {
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
		acceptMethod = (...args: readonly unknown[]): unknown => Reflect.apply(d.value, sessionObj, args);
	}

	// --- getSessionActionRecoverySnapshot ---
	if (ownNames.includes("getSessionActionRecoverySnapshot")) {
		const d = ownDesc.getSessionActionRecoverySnapshot;
		if (!("value" in d) || typeof d.value !== "function") {
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
		try {
			if (types.isProxy(d.value)) {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
		} catch {
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
		snapshotMethod = (...args: readonly unknown[]): unknown => Reflect.apply(d.value, sessionObj, args);
	}

	// --- messages ---
	if (ownNames.includes("messages")) {
		const d = ownDesc.messages;
		if (d.get !== undefined) {
			if (typeof d.get !== "function") {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			try {
				if (types.isProxy(d.get)) {
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
				}
			} catch {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			const getter = d.get;
			messagesGetter = (): readonly unknown[] => {
				const raw = Reflect.apply(getter, sessionObj, []);
				if (denseArray(raw) !== null) return raw;
				throw POISON_SENTINEL;
			};
		} else if ("value" in d) {
			const fixedArr = denseArray(d.value);
			if (fixedArr !== null) {
				messagesGetter = (): readonly unknown[] => fixedArr;
			} else {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
		} else {
			// Setter-only accessor (get===undefined, no value): reject
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
	}

	// --- sessionId ---
	if (ownNames.includes("sessionId")) {
		const d = ownDesc.sessionId;
		if (d.get !== undefined) {
			if (typeof d.get !== "function") {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			try {
				if (types.isProxy(d.get)) {
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
				}
			} catch {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			const sid = Reflect.apply(d.get, sessionObj, []);
			if (typeof sid === "string" && validId(sid)) {
				sessionIdValue = sid;
			} else {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
		} else if ("value" in d) {
			const sid = d.value;
			if (typeof sid === "string" && validId(sid)) {
				sessionIdValue = sid;
			} else {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
		} else {
			return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
		}
	}

	// Phase 6: prototype fallback for missing captures
	// Own-first: if a property exists as an own descriptor it was already validated
	// above. Here we search prototypes with nearest-first rejection: if the nearest
	// prototype has the property but its descriptor is invalid (accessor, non-function,
	// Proxy, etc.), reject — do not search ancestors past it.
	if (acceptMethod === null || snapshotMethod === null || messagesGetter === null || sessionIdValue === null) {
		let proto: object | null = Object.getPrototypeOf(sessionObj);
		while (proto !== null) {
			try {
				if (types.isProxy(proto)) {
					return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
				}
				const protoDesc = Object.getOwnPropertyDescriptors(proto);
				const pNames = Object.getOwnPropertyNames(protoDesc);

				if (acceptMethod === null && pNames.includes("acceptAgentMessagePrompt")) {
					const d = protoDesc.acceptAgentMessagePrompt;
					if (d === undefined || !("value" in d) || typeof d.value !== "function") {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
					try {
						if (types.isProxy(d.value)) {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
					} catch {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
					acceptMethod = (...args: readonly unknown[]): unknown => Reflect.apply(d.value, sessionObj, args);
				}
				if (snapshotMethod === null && pNames.includes("getSessionActionRecoverySnapshot")) {
					const d = protoDesc.getSessionActionRecoverySnapshot;
					if (d === undefined || !("value" in d) || typeof d.value !== "function") {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
					try {
						if (types.isProxy(d.value)) {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
					} catch {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
					snapshotMethod = (...args: readonly unknown[]): unknown => Reflect.apply(d.value, sessionObj, args);
				}
				if (messagesGetter === null && pNames.includes("messages")) {
					const d = protoDesc.messages;
					if (d === undefined) {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
					if (d.get !== undefined && typeof d.get === "function") {
						try {
							if (types.isProxy(d.get)) {
								return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
							}
						} catch {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
						const getter = d.get;
						messagesGetter = (): readonly unknown[] => {
							const raw = Reflect.apply(getter, sessionObj, []);
							if (denseArray(raw) !== null) return raw;
							throw POISON_SENTINEL;
						};
					} else if ("value" in d) {
						const fixedArr = denseArray(d.value);
						if (fixedArr !== null) {
							messagesGetter = (): readonly unknown[] => fixedArr;
						} else {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
					} else {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
				}
				if (sessionIdValue === null && pNames.includes("sessionId")) {
					const d = protoDesc.sessionId;
					if (d === undefined) {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
					if (d.get !== undefined && typeof d.get === "function") {
						try {
							if (types.isProxy(d.get)) {
								return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
							}
						} catch {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
						const sid = Reflect.apply(d.get, sessionObj, []);
						if (typeof sid !== "string" || !validId(sid)) {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
						sessionIdValue = sid;
					} else if ("value" in d) {
						const sid = d.value;
						if (typeof sid !== "string" || !validId(sid)) {
							return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
						}
						sessionIdValue = sid;
					} else {
						return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
					}
				}
				proto = Object.getPrototypeOf(proto);
			} catch {
				return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
			}
			if (acceptMethod !== null && snapshotMethod !== null && messagesGetter !== null && sessionIdValue !== null)
				break;
		}
	}

	if (acceptMethod === null || snapshotMethod === null || messagesGetter === null || sessionIdValue === null) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	// Phase 7: construct dispatcher
	const impl = new SandboxLocalDispatcherImpl(
		acceptMethod,
		snapshotMethod,
		messagesGetter,
		sessionIdValue,
		boundActiveSessionId,
		boundSessionDir,
	);
	const dispatcher: DispatcherCapability = Object.freeze({
		ensure: (r: unknown): Promise<EnsureResult> => impl.ensure(r),
		close: (): Promise<SandboxDispatcherCloseResult> => impl.close(),
	});
	return Object.freeze({ ok: true, dispatcher });
}
