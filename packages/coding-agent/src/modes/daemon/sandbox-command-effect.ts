/**
 * sandbox-command-effect.ts — session-backed command effect port.
 *
 * Uses existing decodeCommandFrame for exact proxy-safe protocol
 * validation.  Seven AgentSession methods are captured from own or
 * prototype data descriptors at factory creation and bound via
 * Reflect.apply; no live session property reads occur after the
 * factory returns.  Post-factory method replacement is ignored.
 *
 * Non-owning frozen capability {execute, close}.  No per-handle
 * abort method: protocol control commands (abort, abort_bash,
 * compact_abort) serve that role.
 *
 * Factory returns {ok:true,capability} for a branded AgentSession
 * or {ok:false,error:{code:"INVALID_SESSION"}} otherwise.
 *
 * Zero casts, assertions, any, dynamic imports, sync fs, timers.
 */

import { types } from "node:util";
import { type AgentSession, isAgentSessionInstance } from "../../core/agent-session.js";
import type { RemoteHostCommandFrameBody } from "./remote-agent-host-protocol.js";
import { decodeCommandFrame } from "./remote-host-frame-codec.js";

// ===========================================================================
// WeakSet brand — the capability is branded module-privately so
// downstream consumers (e.g. the relay application) can verify it.
// ===========================================================================

/** Module-private brand: only newCapability adds instances. */
const sandboxCommandEffectBrand = new WeakSet<object>();

/**
 * Branded predicate: rejects any object not created by newCapability
 * (which is called only from createSandboxCommandEffect).
 *
 * Safe against Object.create(SandboxCommandEffectCapability.prototype)
 * and manual WeakSet.add — brand membership is module-private.
 */
export function isSandboxCommandEffectInstance(value: unknown): value is SandboxCommandEffectCapability {
	return typeof value === "object" && value !== null && sandboxCommandEffectBrand.has(value);
}

// ===========================================================================
// Fresh-result constructors — every call returns a NEW frozen object so
// callers can never share identity with a prior caller's result.
// ===========================================================================

function freshOk(): CommandEffectResult {
	return Object.freeze({ ok: true });
}

function freshError(code: string): CommandEffectResult {
	return Object.freeze({
		ok: false,
		error: Object.freeze({ code }),
	});
}

// ===========================================================================
// Public result types
// ===========================================================================

export type CommandEffectResult =
	| { readonly ok: true }
	| { readonly ok: false; readonly error: { readonly code: string } };

/** Handle returned by execute(). No abort() method — use protocol commands. */
export interface SandboxCommandEffectHandle {
	readonly commandId: string;
	readonly completion: Promise<CommandEffectResult>;
}

/** Non-owning capability bound to a branded AgentSession. */
export interface SandboxCommandEffectCapability {
	execute(frame: unknown): SandboxCommandEffectHandle;
	close(): Promise<CommandEffectResult>;
}

export interface SandboxCommandEffectFactoryResultOk {
	readonly ok: true;
	readonly capability: SandboxCommandEffectCapability;
}

export interface SandboxCommandEffectFactoryResultError {
	readonly ok: false;
	readonly error: { readonly code: "INVALID_SESSION" };
}

export type SandboxCommandEffectFactoryResult =
	| SandboxCommandEffectFactoryResultOk
	| SandboxCommandEffectFactoryResultError;

// ===========================================================================
// Kinds for close routing
// ===========================================================================

const KIND_PROMPT_STEER = 0;
const KIND_ABORT = 1;
const KIND_BASH = 2;
const KIND_COMPACT = 3;

// ===========================================================================
// Method capture — bind an AgentSession method from own or prototype
// data descriptor at factory creation.  Rejects Proxy / accessor /
// non-function / missing.  Returns a bound function or undefined.
// ===========================================================================

type BoundMethod = (...args: readonly unknown[]) => unknown;

function captureMethod(session: AgentSession, name: string): BoundMethod | undefined {
	let fn: unknown;

	// Try own data descriptor first
	try {
		const ownDesc = Object.getOwnPropertyDescriptor(session, name);
		if (ownDesc !== undefined && "value" in ownDesc && typeof ownDesc.value === "function") {
			if (!types.isProxy(ownDesc.value)) {
				fn = ownDesc.value;
			}
		}
	} catch {
		return undefined;
	}

	// Fall back to prototype data descriptor
	if (fn === undefined) {
		try {
			const proto = Object.getPrototypeOf(session);
			if (proto !== null) {
				const protoDesc = Object.getOwnPropertyDescriptor(proto, name);
				if (protoDesc !== undefined && "value" in protoDesc && typeof protoDesc.value === "function") {
					if (!types.isProxy(protoDesc.value)) {
						fn = protoDesc.value;
					}
				}
			}
		} catch {
			return undefined;
		}
	}

	if (fn === undefined) return undefined;

	// Always bind against the session instance — own or prototype methods
	// need the session as `this`.
	return (...args: readonly unknown[]): unknown => {
		try {
			return Reflect.apply(fn as (...args: readonly unknown[]) => unknown, session, args);
		} catch {
			throw new Error("CAPTURED_METHOD_ERROR");
		}
	};
}

// ===========================================================================
// Bound method collection — all seven AgentSession methods captured once.
// ===========================================================================

interface BoundMethods {
	readonly promptUntilAccepted: BoundMethod;
	readonly prompt: BoundMethod;
	readonly abort: BoundMethod;
	readonly runUserBash: BoundMethod;
	readonly abortBash: BoundMethod;
	readonly compact: BoundMethod;
	readonly abortCompaction: BoundMethod;
}

function captureAllMethods(session: AgentSession): BoundMethods | null {
	const promptUntilAccepted = captureMethod(session, "promptUntilAccepted");
	const prompt = captureMethod(session, "prompt");
	const abort = captureMethod(session, "abort");
	const runUserBash = captureMethod(session, "runUserBash");
	const abortBash = captureMethod(session, "abortBash");
	const compact = captureMethod(session, "compact");
	const abortCompaction = captureMethod(session, "abortCompaction");

	if (
		promptUntilAccepted === undefined ||
		prompt === undefined ||
		abort === undefined ||
		runUserBash === undefined ||
		abortBash === undefined ||
		compact === undefined ||
		abortCompaction === undefined
	) {
		return null;
	}

	return Object.freeze({
		promptUntilAccepted,
		prompt,
		abort,
		runUserBash,
		abortBash,
		compact,
		abortCompaction,
	});
}

// ===========================================================================
// Helpers
// ===========================================================================

/** Check that value is an exact native Promise — no proxy, no own keys,
 *  no own symbols, correct prototype, and node:util types.isPromise. */
function isExactPromise(raw: unknown): raw is Promise<unknown> {
	if (typeof raw !== "object" || raw === null) return false;
	try {
		if (types.isProxy(raw)) return false;
	} catch {
		return false;
	}
	if (Object.getPrototypeOf(raw) !== Promise.prototype) return false;
	if (Object.getOwnPropertyNames(raw).length > 0) return false;
	if (Object.getOwnPropertySymbols(raw).length > 0) return false;
	if (!types.isPromise(raw)) return false;
	return true;
}

/** Create a completion promise that maps session promise fulfillment
 *  to a fresh fixed result, using Reflect.apply so attacker .then
 *  traps never fire. */
function mapCompletion(p: Promise<unknown>): Promise<CommandEffectResult> {
	return new Promise((resolve) => {
		const ok = () => resolve(freshOk());
		const fail = () => resolve(freshError("INTERNAL_ERROR"));
		Reflect.apply(Promise.prototype.then, p, [ok, fail]);
	});
}

/** Command types that perform zero effects on the session. */
const UNSUPPORTED_TYPES = new Set([
	"create_session",
	"destroy_session",
	"checkpoint",
	"wake",
	"shutdown",
	"sync_workspace",
]);

/** Known supported command types (all real AgentSession methods). */
const SUPPORTED_TYPES = new Set(["prompt", "steer", "abort", "execute_bash", "abort_bash", "compact", "compact_abort"]);

// ===========================================================================
// Factory
// ===========================================================================

export function createSandboxCommandEffect(session: unknown): SandboxCommandEffectFactoryResult {
	if (!isAgentSessionInstance(session)) {
		return Object.freeze({
			ok: false,
			error: Object.freeze({ code: "INVALID_SESSION" }),
		});
	}

	return Object.freeze({ ok: true, capability: newCapability(session) });
}

// ===========================================================================
// Capability constructor (called after brand check)
// ===========================================================================

function newCapability(session: AgentSession): SandboxCommandEffectCapability {
	// Capture all seven methods from own/prototype data descriptors NOW.
	// No live property reads from `session` after this point.
	const methods = captureAllMethods(session);
	if (methods === null) {
		// This should never happen for a legitimate branded AgentSession,
		// but guard defensively: return a capability that rejects everything.
		return Object.freeze({
			execute: () => frozenHandle("", Promise.resolve(freshError("INTERNAL_ERROR"))),
			close: () => Promise.resolve(freshError("INTERNAL_ERROR")),
		});
	}
	// Discard session reference so executors never read live properties.
	void session;

	// -- mutable state -------------------------------------------------------
	const activeTasks: Array<{
		commandId: string;
		kind: number;
		completion: Promise<CommandEffectResult>;
	}> = [];

	let closeResolve: (r: CommandEffectResult) => void = () => {};
	const closePromise: Promise<CommandEffectResult> = new Promise((r) => {
		closeResolve = r;
	});
	let closed = false;

	// Shared tracked-task adder — removes itself from activeTasks on settlement only.
	// close() snapshots/disconnects before resolving, so this never resolves closePromise.
	function trackTask(commandId: string, kind: number, completion: Promise<CommandEffectResult>): void {
		const entry = { commandId, kind, completion };
		activeTasks.push(entry);
		const onSettle = (): void => {
			const idx = activeTasks.indexOf(entry);
			if (idx !== -1) activeTasks.splice(idx, 1);
		};
		void Reflect.apply(Promise.prototype.then, completion, [onSettle, onSettle]);
	}

	// -- execute ------------------------------------------------------------
	const execute = (frame: unknown): SandboxCommandEffectHandle => {
		if (closed) {
			return frozenHandle("", Promise.resolve(freshError("CLOSED")));
		}

		const decoded = decodeCommandFrame(frame);
		if (!decoded.ok) {
			if (decoded.error.code === "UNSUPPORTED_COMMAND") {
				return frozenHandle("", Promise.resolve(freshError("UNSUPPORTED_COMMAND")));
			}
			return frozenHandle("", Promise.resolve(freshError("INVALID_INPUT")));
		}

		const { commandId, body } = decoded.value;
		const cmdType = body.type;

		if (UNSUPPORTED_TYPES.has(cmdType)) {
			return frozenHandle(commandId, Promise.resolve(freshError("UNSUPPORTED_COMMAND")));
		}

		if (!SUPPORTED_TYPES.has(cmdType)) {
			return frozenHandle(commandId, Promise.resolve(freshError("UNSUPPORTED_COMMAND")));
		}

		return dispatchCommand(commandId, body, methods, trackTask);
	};

	// -- close --------------------------------------------------------------
	const close = (): Promise<CommandEffectResult> => {
		if (closed) return closePromise;
		closed = true;

		// Snapshot tasks synchronously and disconnect from activeTasks so
		// trackTask settlement hooks never touch closePromise.
		const snapshot = activeTasks.slice();
		for (let i = 0; i < snapshot.length; i++) {
			const idx = activeTasks.indexOf(snapshot[i]);
			if (idx !== -1) activeTasks.splice(idx, 1);
		}

		// Empty snapshot — nothing to wait for
		if (snapshot.length === 0) {
			closeResolve(freshOk());
			return closePromise;
		}

		// Collect active kinds
		const hasKind = [false, false, false, false];
		for (let i = 0; i < snapshot.length; i++) {
			hasKind[snapshot[i].kind] = true;
		}

		// Build observations: each is Promise<boolean> where true=ok, false=error
		const observations: Array<Promise<boolean>> = [];

		// Observe each snapshot completion — resolve true if r.ok, false otherwise
		for (let i = 0; i < snapshot.length; i++) {
			observations.push(
				new Promise((resolve) => {
					const onOk = (r: CommandEffectResult): void => {
						resolve(r.ok);
					};
					const onFail = (): void => {
						resolve(false);
					};
					Reflect.apply(Promise.prototype.then, snapshot[i].completion, [onOk, onFail]);
				}),
			);
		}

		// Use bound abort() if KIND_PROMPT_STEER is active
		if (hasKind[KIND_PROMPT_STEER]) {
			try {
				const p = methods.abort();
				if (isExactPromise(p)) {
					observations.push(
						new Promise((resolve) => {
							const onFulfill = (): void => {
								resolve(true);
							};
							const onReject = (): void => {
								resolve(false);
							};
							Reflect.apply(Promise.prototype.then, p, [onFulfill, onReject]);
						}),
					);
				} else {
					observations.push(Promise.resolve(false));
				}
			} catch {
				observations.push(Promise.resolve(false));
			}
		}

		// Initiate sync abort methods via bound methods
		if (hasKind[KIND_BASH]) {
			try {
				methods.abortBash();
			} catch {
				observations.push(Promise.resolve(false));
			}
		}
		if (hasKind[KIND_COMPACT]) {
			try {
				methods.abortCompaction();
			} catch {
				observations.push(Promise.resolve(false));
			}
		}

		// Join them all.  Every entry is Promise<boolean> with built-in
		// both-fulfill-and-reject, so Promise.all never rejects.
		const joined: Promise<boolean[]> = Promise.all(observations);
		void Reflect.apply(Promise.prototype.then, joined, [
			(results: boolean[]): void => {
				let anyError = false;
				for (let i = 0; i < results.length; i++) {
					if (!results[i]) {
						anyError = true;
						break;
					}
				}
				closeResolve(anyError ? freshError("CLOSE_ABORT_FAILED") : freshOk());
			},
			(): void => {
				closeResolve(freshError("CLOSE_ABORT_FAILED"));
			},
		]);

		return closePromise;
	};

	const cap = Object.freeze({ execute, close });
	sandboxCommandEffectBrand.add(cap);
	return cap;
}

// ===========================================================================
// Dispatch a supported command using bound methods (no live session access)
// ===========================================================================

function dispatchCommand(
	commandId: string,
	body: RemoteHostCommandFrameBody,
	methods: BoundMethods,
	trackTask: (commandId: string, kind: number, completion: Promise<CommandEffectResult>) => void,
): SandboxCommandEffectHandle {
	switch (body.type) {
		case "prompt":
			return execPrompt(commandId, body, methods, trackTask);
		case "steer":
			return execSteer(commandId, body, methods, trackTask);
		case "abort":
			return execAbort(commandId, methods, trackTask);
		case "execute_bash":
			return execBash(commandId, body, methods, trackTask);
		case "abort_bash":
			return execAbortBash(commandId, methods);
		case "compact":
			return execCompact(commandId, body, methods, trackTask);
		case "compact_abort":
			return execCompactAbort(commandId, methods);
	}
	return frozenHandle(commandId, Promise.resolve(freshOk()));
}

// ===========================================================================
// Per-command executors — use bound methods only, no live session access
// ===========================================================================

function execPrompt(
	commandId: string,
	body: RemoteHostCommandFrameBody & { type: "prompt" },
	methods: BoundMethods,
	trackTask: (commandId: string, kind: number, completion: Promise<CommandEffectResult>) => void,
): SandboxCommandEffectHandle {
	let sessionPromise: Promise<unknown>;
	try {
		const opts: Record<string, unknown> = {};
		if (body.admissionId !== undefined) opts.agentMessageId = body.admissionId;
		opts.admissionCommitted = () => {};
		sessionPromise = methods.promptUntilAccepted(body.message, opts) as Promise<unknown>;
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	if (!isExactPromise(sessionPromise)) {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	const completion = mapCompletion(sessionPromise);
	trackTask(commandId, KIND_PROMPT_STEER, completion);
	return frozenHandle(commandId, completion);
}

function execSteer(
	commandId: string,
	body: RemoteHostCommandFrameBody & { type: "steer" },
	methods: BoundMethods,
	trackTask: (commandId: string, kind: number, completion: Promise<CommandEffectResult>) => void,
): SandboxCommandEffectHandle {
	let sessionPromise: Promise<unknown>;
	try {
		const opts: Record<string, unknown> = {
			streamingBehavior: "steer",
		};
		if (body.queueKey !== undefined && body.queueKey.length > 0) {
			opts.followUpQueueKey = body.queueKey;
		}
		opts.admissionCommitted = () => {};
		sessionPromise = methods.prompt(body.message, opts) as Promise<unknown>;
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	if (!isExactPromise(sessionPromise)) {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	const completion = mapCompletion(sessionPromise);
	trackTask(commandId, KIND_PROMPT_STEER, completion);
	return frozenHandle(commandId, completion);
}

function execAbort(
	commandId: string,
	methods: BoundMethods,
	trackTask: (commandId: string, kind: number, completion: Promise<CommandEffectResult>) => void,
): SandboxCommandEffectHandle {
	let sessionPromise: Promise<unknown>;
	try {
		sessionPromise = methods.abort() as Promise<unknown>;
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	if (!isExactPromise(sessionPromise)) {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	const completion = mapCompletion(sessionPromise);
	trackTask(commandId, KIND_ABORT, completion);
	return frozenHandle(commandId, completion);
}

function execBash(
	commandId: string,
	body: RemoteHostCommandFrameBody & { type: "execute_bash" },
	methods: BoundMethods,
	trackTask: (commandId: string, kind: number, completion: Promise<CommandEffectResult>) => void,
): SandboxCommandEffectHandle {
	let sessionPromise: Promise<unknown>;
	try {
		const opts: Record<string, unknown> = {
			transient: body.transient ?? false,
		};
		if (body.runId !== undefined) opts.runId = body.runId;
		sessionPromise = methods.runUserBash(body.command, opts) as Promise<unknown>;
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	if (!isExactPromise(sessionPromise)) {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	const completion = mapCompletion(sessionPromise);
	trackTask(commandId, KIND_BASH, completion);
	return frozenHandle(commandId, completion);
}

function execAbortBash(commandId: string, methods: BoundMethods): SandboxCommandEffectHandle {
	try {
		methods.abortBash();
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}
	return frozenHandle(commandId, Promise.resolve(freshOk()));
}

function execCompact(
	commandId: string,
	body: RemoteHostCommandFrameBody & { type: "compact" },
	methods: BoundMethods,
	trackTask: (commandId: string, kind: number, completion: Promise<CommandEffectResult>) => void,
): SandboxCommandEffectHandle {
	let sessionPromise: Promise<unknown>;
	try {
		sessionPromise = methods.compact(body.customInstructions) as Promise<unknown>;
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	if (!isExactPromise(sessionPromise)) {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}

	const completion = mapCompletion(sessionPromise);
	trackTask(commandId, KIND_COMPACT, completion);
	return frozenHandle(commandId, completion);
}

function execCompactAbort(commandId: string, methods: BoundMethods): SandboxCommandEffectHandle {
	try {
		methods.abortCompaction();
	} catch {
		return frozenHandle(commandId, Promise.resolve(freshError("INTERNAL_ERROR")));
	}
	return frozenHandle(commandId, Promise.resolve(freshOk()));
}

// ===========================================================================
// Frozen handle constructor
// ===========================================================================

function frozenHandle(commandId: string, completion: Promise<CommandEffectResult>): SandboxCommandEffectHandle {
	return Object.freeze({ commandId, completion });
}
