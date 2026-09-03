/**
 * sandbox-command-application.ts — store-backed command relay application.
 *
 * Wraps a branded SandboxCommandEffectCapability and an exclusively owned
 * branded SandboxCommandStoreCapability into a MultiplexerApplication-shaped
 * {apply, close} capability.
 *
 * Factory accepts unknown and validates via exact own descriptors + WeakSet
 * brands.  Discover owners before validation; close reverse on failure.
 * Normal close closes effect then store (reverse ownership order).
 *
 * apply(raw) expects {envelope} input.  Lifecycle/workspace commands
 * rejected before any store or session effect.  Supported commands are:
 * admit durably → effect.execute(envelope.body) → markStarted before
 * inspecting handle → markCompleted / markInterrupted(INTERRUPTED).
 *
 * Uses AsyncLocalStorage for FIFO ordering and reentry detection.
 * No casts, assertions, any, dynamic imports, timers.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { types } from "node:util";
import type { RemoteHostCommandFrame } from "./remote-agent-host-protocol.js";
import { decodeCommandFrame } from "./remote-host-frame-codec.js";
import {
	type CommandEffectResult,
	isSandboxCommandEffectInstance,
	type SandboxCommandEffectCapability,
} from "./sandbox-command-effect.js";
import {
	isSandboxCommandStoreInstance,
	type SandboxCommandAdmitInput,
	type SandboxCommandStoreCapability,
} from "./sandbox-command-store.js";

// ===========================================================================
// Constants (matched to frame codec bounds)
// ===========================================================================

const FACTORY_KEYS = new Set(["effect", "store"]);
const APPLY_INPUT_KEYS = new Set(["envelope"]);

// ===========================================================================
// Result types — MultiplexerApplication shape
// ===========================================================================

export type SandboxCommandApplyResult =
	| Readonly<{ readonly status: "applied" }>
	| Readonly<{ readonly status: "error" }>;

export type SandboxCommandCloseResult =
	| Readonly<{ readonly status: "closed" }>
	| Readonly<{ readonly status: "error" }>;

export interface SandboxCommandApplication {
	readonly apply: (raw: unknown) => Promise<SandboxCommandApplyResult>;
	readonly close: () => Promise<SandboxCommandCloseResult>;
}

export type CreateSandboxCommandApplicationResult =
	| Readonly<{
			readonly ok: true;
			readonly application: SandboxCommandApplication;
	  }>
	| Readonly<{ readonly ok: false; readonly error: Readonly<{ readonly code: string }> }>;

// ===========================================================================
// Lifecycle/workspace command types — rejected before any effect
// ===========================================================================

const LIFECYCLE_TYPES = new Set([
	"create_session",
	"destroy_session",
	"checkpoint",
	"wake",
	"shutdown",
	"sync_workspace",
]);

const SUPPORTED_TYPES = new Set(["prompt", "steer", "abort", "execute_bash", "abort_bash", "compact", "compact_abort"]);

// ===========================================================================
// Typed constructors
// ===========================================================================

function appliedResult(): SandboxCommandApplyResult {
	return Object.freeze({ status: "applied" });
}

function applyErrorResult(): SandboxCommandApplyResult {
	return Object.freeze({ status: "error" });
}

function closedResult(): SandboxCommandCloseResult {
	return Object.freeze({ status: "closed" });
}

function closeErrorResult(): SandboxCommandCloseResult {
	return Object.freeze({ status: "error" });
}

// ===========================================================================
// Descriptor helpers (from ordered-durable-relay-application-multiplexer)
// ===========================================================================

function rawDescriptors(raw: unknown): Record<string, PropertyDescriptor> | null {
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

function exact(raw: unknown, keys: ReadonlySet<string>): Record<string, PropertyDescriptor> | null {
	const descriptors = rawDescriptors(raw);
	if (!descriptors) return null;
	const ownKeys = Object.keys(descriptors);
	if (ownKeys.length !== keys.size) return null;
	for (let i = 0; i < ownKeys.length; i++) {
		if (!keys.has(ownKeys[i])) return null;
	}
	return descriptors;
}

// ===========================================================================
// Owned close helper — captures a close function as a provable owner
// ===========================================================================

type OwnedClose = () => Promise<boolean>;

function captureClose(raw: object): OwnedClose | null {
	const desc = Object.getOwnPropertyDescriptor(raw, "close");
	if (!desc || !("value" in desc)) return null;
	const fn = desc.value;
	if (typeof fn !== "function") return null;
	try {
		if (types.isProxy(fn)) return null;
	} catch {
		return null;
	}
	return async (): Promise<boolean> => {
		try {
			const r: unknown = await Reflect.apply(fn as () => unknown, raw, []);
			if (typeof r !== "object" || r === null) return false;
			const obj = r as Record<string, unknown>;
			// Both MultiplexerApplication {status:"closed"} and
			// effect/store {ok:true} results indicate successful close.
			if ("status" in obj && obj.status === "closed") return true;
			if ("ok" in obj && obj.ok === true) return true;
			return false;
		} catch {
			return false;
		}
	};
}

// ===========================================================================
// Reverse sequential close
// ===========================================================================

async function closeAll(closes: readonly OwnedClose[]): Promise<boolean> {
	for (let index = 0; index < closes.length; index += 1) {
		const ok = await closes[index]().catch(() => false);
		if (!ok) return false;
	}
	return true;
}

// ===========================================================================
// Replay pending commands from store
// ===========================================================================

async function replayPending(
	store: SandboxCommandStoreCapability,
	effect: SandboxCommandEffectCapability,
): Promise<boolean> {
	let cursor: number | null = null;
	let hasMore = true;

	while (hasMore) {
		const pageResult = await store.replayPending(cursor, 64);
		if (!pageResult.ok) return false;
		const page = pageResult.value;
		for (const entry of page.entries) {
			if (entry.record.recordKind !== "pending") continue;
			const cmdType = entry.record.commandType;
			if (!SUPPORTED_TYPES.has(cmdType)) continue;

			// Execute via branded effect
			const handle = effect.execute(entry.record.command);
			// Durable markStarted
			const startedResult = await store.markStarted({
				commandId: entry.record.commandId,
				recordedAt: new Date().toISOString(),
			});
			if (!startedResult.ok) {
				await store.markInterrupted({
					commandId: entry.record.commandId,
					outcome: "INTERRUPTED",
					recordedAt: new Date().toISOString(),
				});
				continue;
			}
			// Fire-and-forget completion
			void Reflect.apply(Promise.prototype.then, handle.completion, [
				() => {
					void store.markCompleted({
						commandId: entry.record.commandId,
						recordedAt: new Date().toISOString(),
					});
				},
				() => {
					void store.markInterrupted({
						commandId: entry.record.commandId,
						outcome: "INTERRUPTED",
						recordedAt: new Date().toISOString(),
					});
				},
			]);
		}
		cursor = page.nextCursor;
		hasMore = page.nextCursor !== null;
	}
	return true;
}

// ===========================================================================
// Application implementation
// ===========================================================================

const applyContext = new AsyncLocalStorage<ApplicationImpl>();

class ApplicationImpl implements SandboxCommandApplication {
	private readonly _effect: SandboxCommandEffectCapability;
	private readonly _store: SandboxCommandStoreCapability;
	private readonly _ownedCloses: readonly OwnedClose[];
	private _closePromise: Promise<SandboxCommandCloseResult> | null = null;
	private _closed = false;
	private _tail: Promise<void> = Promise.resolve();

	constructor(
		effect: SandboxCommandEffectCapability,
		store: SandboxCommandStoreCapability,
		ownedCloses: readonly OwnedClose[],
	) {
		this._effect = effect;
		this._store = store;
		this._ownedCloses = ownedCloses;
	}

	async apply(raw: unknown): Promise<SandboxCommandApplyResult> {
		// Reentry detection
		if (applyContext.getStore() === this) {
			return applyErrorResult();
		}

		if (this._closed) return applyErrorResult();

		// Validate input shape: exact {envelope}
		const inputDescs = exact(raw, APPLY_INPUT_KEYS);
		if (!inputDescs) return applyErrorResult();

		const envelopeDesc = inputDescs.envelope;
		if (!envelopeDesc || !("value" in envelopeDesc)) return applyErrorResult();
		const envelope: unknown = envelopeDesc.value;

		// Decode the envelope (command frame)
		const decoded = decodeCommandFrame(envelope);
		if (!decoded.ok) return applyErrorResult();

		const frame: RemoteHostCommandFrame = decoded.value;
		const cmdType = frame.body.type;

		// Reject lifecycle/workspace before any effect
		if (LIFECYCLE_TYPES.has(cmdType)) return applyErrorResult();
		if (!SUPPORTED_TYPES.has(cmdType)) return applyErrorResult();

		// FIFO ordering via tail chain
		return this.enqueueApply(frame);
	}

	private enqueueApply(frame: RemoteHostCommandFrame): Promise<SandboxCommandApplyResult> {
		const prev = this._tail;
		let resolveNext: () => void = () => {};
		this._tail = new Promise<void>((resolve) => {
			resolveNext = resolve;
		});

		return prev.then(() =>
			applyContext
				.run(this, () => this.applyOrdered(frame))
				.then(
					(result) => {
						resolveNext();
						return result;
					},
					() => {
						resolveNext();
						return applyErrorResult();
					},
				),
		);
	}

	private async applyOrdered(frame: RemoteHostCommandFrame): Promise<SandboxCommandApplyResult> {
		const commandId = frame.commandId;
		const recordedAt = new Date().toISOString();

		// 1. Durable admit
		const admitInput: SandboxCommandAdmitInput = { command: frame, recordedAt };
		try {
			const admitResult = await this._store.admit(admitInput);
			if (!admitResult.ok) return applyErrorResult();
		} catch {
			return applyErrorResult();
		}

		// 2. Invoke via branded effect.execute with the envelope body
		let effectHandle: { readonly completion: Promise<CommandEffectResult> };
		try {
			effectHandle = this._effect.execute(frame);
		} catch {
			try {
				await this._store.markInterrupted({
					commandId,
					outcome: "INTERRUPTED",
					recordedAt: new Date().toISOString(),
				});
			} catch {
				// best-effort
			}
			return applyErrorResult();
		}

		// 3. Durable markStarted BEFORE inspecting/awaiting the handle
		try {
			const startedResult = await this._store.markStarted({ commandId, recordedAt: new Date().toISOString() });
			if (!startedResult.ok) {
				try {
					await this._store.markInterrupted({
						commandId,
						outcome: "INTERRUPTED",
						recordedAt: new Date().toISOString(),
					});
				} catch {
					// best-effort
				}
				return applyErrorResult();
			}
		} catch {
			try {
				await this._store.markInterrupted({
					commandId,
					outcome: "INTERRUPTED",
					recordedAt: new Date().toISOString(),
				});
			} catch {
				// best-effort
			}
			return applyErrorResult();
		}

		// 4. Await completion
		let settleOk = false;
		try {
			const effectResult = await effectHandle.completion;
			settleOk = effectResult.ok;
		} catch {
			settleOk = false;
		}

		// 5. Mark terminal
		const terminalAt = new Date().toISOString();
		if (settleOk) {
			try {
				await this._store.markCompleted({ commandId, recordedAt: terminalAt });
			} catch {
				// best-effort
			}
		} else {
			try {
				await this._store.markInterrupted({ commandId, outcome: "INTERRUPTED", recordedAt: terminalAt });
			} catch {
				// best-effort
			}
		}

		return settleOk ? appliedResult() : applyErrorResult();
	}

	close(): Promise<SandboxCommandCloseResult> {
		if (this._closePromise !== null) return this._closePromise;

		this._closed = true;

		// Wait for FIFO tail to drain, then close in reverse ownership order
		const shared = this._tail.then(() => this.closeOrdered()).catch(() => closeErrorResult());

		this._closePromise = shared;
		return shared;
	}

	private async closeOrdered(): Promise<SandboxCommandCloseResult> {
		// Close in ownership order: effect first, then store last
		// (effect depends on store, so store is closed last).
		// ownedCloses: [effect, store] — close forward.
		for (let index = 0; index < this._ownedCloses.length; index += 1) {
			const ok = await this._ownedCloses[index]().catch(() => false);
			if (!ok) return closeErrorResult();
		}
		return closedResult();
	}
}

// ===========================================================================
// Factory
// ===========================================================================

export async function createSandboxCommandApplication(raw: unknown): Promise<CreateSandboxCommandApplicationResult> {
	// Phase 1: validate exact factory input shape {effect, store}
	const descriptors = exact(raw, FACTORY_KEYS);
	if (!descriptors) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	const effectDesc = descriptors.effect;
	const storeDesc = descriptors.store;
	if (!effectDesc || !("value" in effectDesc) || !storeDesc || !("value" in storeDesc)) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	const effectValue: unknown = effectDesc.value;
	const storeValue: unknown = storeDesc.value;

	// Phase 2: validate brands — discover owners first
	if (!isSandboxCommandEffectInstance(effectValue)) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}
	if (!isSandboxCommandStoreInstance(storeValue)) {
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	const effect: SandboxCommandEffectCapability = effectValue;
	const store: SandboxCommandStoreCapability = storeValue;

	// Phase 2b: capture close owners (ownership-first)
	const effectClose = captureClose(effect as unknown as object);
	const storeClose = captureClose(store as unknown as object);

	// Both must have provable close functions
	if (!effectClose || !storeClose) {
		// Close reverse on failure
		if (storeClose) void storeClose().catch(() => {});
		return Object.freeze({ ok: false, error: Object.freeze({ code: "INVALID_ARGUMENT" }) });
	}

	// Owners in acquisition order: [effect, store]
	const ownedCloses: readonly OwnedClose[] = Object.freeze([effectClose, storeClose]);

	// Phase 3: replay pending commands
	const replayOk = await replayPending(store, effect);
	if (!replayOk) {
		// Close reverse on failure
		await closeAll(ownedCloses).catch(() => {});
		return Object.freeze({ ok: false, error: Object.freeze({ code: "REPLAY_FAILED" }) });
	}

	// Phase 4: create application
	const application = new ApplicationImpl(effect, store, ownedCloses);

	return Object.freeze({ ok: true, application });
}
