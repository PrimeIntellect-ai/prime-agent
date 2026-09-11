import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionRunner } from "../../core/extensions/index.js";
import type { ProviderRetryPolicy } from "../../core/provider-retry.js";
import type { SessionManager } from "../../core/session-manager.js";
import type { SettingsManager } from "../../core/settings-manager.js";
import type { CustomMessage, RefinementSource } from "../context/messages.js";
import { AutoRefinement, type AutoRefineReviewer, autoRefineInstructions } from "./automatic.js";
import { RefinementExecution, RefineSkippedError, type SessionRefinementEvent } from "./execution.js";
import type { HarnessState, RefinementPlan, RefinementResult } from "./types.js";

export type { AutoRefineReviewer, AutoRefineReviewRequest } from "./automatic.js";

export interface SessionRefinementHost {
	sessionManager: Pick<
		SessionManager,
		"getSessionArtifactDir" | "getEntries" | "appendCustomMessageEntryWithRollback" | "appendCustomEntry"
	>;
	settingsManager: Pick<SettingsManager, "getAutoRefineSettings">;
	getRetryPolicy(): ProviderRetryPolicy;
	isDisposed(): boolean;
	isDisposing(): boolean;
	isStreaming(): boolean;
	isCompacting(): boolean;
	getDepth(): number;
	getRlmSessionDir(): string | undefined;
	getModel(): Model<Api> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getMessages(): AgentMessage[];
	getRequiredRequestAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	getExtensionRunner(): Pick<ExtensionRunner, "hasHandlers" | "emit">;
	getEventQueue(): Promise<void>;
	getCompactionOperation(): Promise<void> | undefined;
	getBranchSummaryOperation(): Promise<void> | undefined;
	waitForAgentIdle(): Promise<void>;
	dispatchRefine(
		options: { instructions?: string; global?: boolean },
		internal: { source: "self" } | { trigger: "auto" },
	): Promise<RefinementResult>;
	disconnect(): void;
	reconnect(): void;
	emit(event: SessionRefinementEvent): void;
	retainUnpersistedOutcome(message: CustomMessage): void;
	notifyCheckpoints(): void;
	scheduleInputPump(): void;
	isContinuationScheduled(): boolean;
	cancelContinuation(): void;
}

/** Thrown when a session_before_refine extension skips the refinement round. */
export { RefineSkippedError } from "./execution.js";

/**
 * Discriminated result from a serialized-mode background planning pass.
 * - "plan": review approved and planning succeeded; carry the exact plan,
 *   options, and abort controller so the boundary can apply directly
 *   without a second planning request.
 * - "skip": reviewer declined; no refine needed.
 * - "failure": review or planning threw; boundary should not retry.
 */
export type SerializedBackgroundPlanResult =
	| {
			status: "plan";
			plan: RefinementPlan;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			abort: AbortController;
			branchVersion: number;
			source: Exclude<RefinementSource, "user">;
	  }
	| { status: "skip"; explicit?: boolean }
	| { status: "invalidated"; branchVersion: number }
	| {
			status: "failure";
			explicit: boolean;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			branchVersion: number;
	  };

/** Owns refinement admission, planning/apply barriers, and serialized plan claims. */
export class SessionRefinement {
	private readonly _auto: AutoRefinement;
	private readonly _execution: RefinementExecution;
	private _refineAbortController?: AbortController;
	private readonly _serializedRefine: boolean;
	private _refineInFlight?: Promise<void>;
	private _refinePlanInFlight?: Promise<void>;
	private _serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
	private _serializedPlanClaim?: Promise<void>;
	private _serializedExplicitRefineOptions?: {
		instructions?: string;
		global?: boolean;
	};
	private _pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;

	constructor(
		private readonly _host: SessionRefinementHost,
		config: { autoRefineReviewer?: AutoRefineReviewer; serializedRefine?: boolean },
	) {
		this._execution = new RefinementExecution(_host, (abort) => {
			if (this._refineAbortController === abort) this._refineAbortController = undefined;
		});
		this._auto = new AutoRefinement(
			{
				settingsManager: _host.settingsManager,
				isDisposed: () => _host.isDisposed(),
				isDisposing: () => _host.isDisposing(),
				isStreaming: () => _host.isStreaming(),
				isCompacting: () => _host.isCompacting(),
				isAllowed: () => this._autoRefineAllowedForSession(),
				getModel: () => _host.getModel(),
				isContinuationScheduled: () => _host.isContinuationScheduled(),
				cancelContinuation: () => _host.cancelContinuation(),
				refine: (options, internal) => _host.dispatchRefine(options, internal),
				runSerialized: (options, source) => this._runSerializedRefine(options, source),
				emitFailure: (error) => this._emitRefineFailed(error),
				review: (context, signal) => this._execution.review(context, signal),
			},
			config.serializedRefine ?? false,
			config.autoRefineReviewer,
		);
		this._serializedRefine = config.serializedRefine ?? false;
	}

	requestAbort(): void {
		this._pendingRequestedRefine = undefined;
		this._auto.invalidatePlans();
		this._auto.abortReview();
		this._refineAbortController?.abort();
	}
	observeAssistantEnd(): void {
		this._auto.observeAssistantEnd();
		this._maybeStartSerializedBackgroundPlan();
	}
	get isApplying(): boolean {
		return this._refineInFlight !== undefined;
	}
	get serialized(): boolean {
		return this._serializedRefine;
	}
	/** Split settlement preserves the caller's existing await boundary. */
	beginAbortedTurnCleanup(): { promise: Promise<unknown>; finish(): void } | undefined {
		this._pendingRequestedRefine = undefined;
		const plan = this._serializedPlanInFlight;
		if (!plan) return undefined;
		this._auto.invalidatePlans();
		this._refineAbortController?.abort();
		return {
			promise: plan,
			finish: () => {
				if (this._serializedPlanInFlight === plan) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			},
		};
	}
	dispose(): void {
		this._auto.abortReview();
		this._refineAbortController?.abort();
		this._auto.cancelScheduled();
		this._serializedPlanInFlight = undefined;
		this._serializedExplicitRefineOptions = undefined;
		this._pendingRequestedRefine = undefined;
		this._auto._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._auto.invalidatePlans();
	}

	async _runSerializedRefineCheckpoint(): Promise<void> {
		if (this._host.isDisposed() || this._host.isDisposing()) {
			return;
		}

		// 1. Await any background plan that was started at message_end
		//    (either for a pending refine.run or for interval-triggered
		//    auto-refine). This must be checked BEFORE the pending and
		//    interval checks because background planning may have consumed
		//    the pending request at message_end.
		const branchVersion = this._auto.branchVersion;
		const bgConsumption = await this._consumeSerializedBackgroundPlan(async (bgResult) => {
			if (this._host.isDisposed() || this._host.isDisposing()) {
				return true;
			}

			if (bgResult?.status === "plan") {
				if (bgResult.branchVersion !== this._auto.branchVersion) {
					if (!this._pendingRequestedRefine) {
						this._auto.stampCooldown();
						this._auto.resetTurns();
						return true;
					}
				} else {
					// Apply the EXACT background plan directly via _applyRefine
					// (no second _planRefine call).
					try {
						await this._applySerializedPlan(bgResult);
					} catch (error) {
						this._emitRefineFailed(error);
					}
					this._auto.stampCooldown();
					this._auto.resetTurns();
					if (!this._pendingRequestedRefine) {
						return true;
					}
				}
			}

			if (bgResult?.status === "skip") {
				// Reviewer declined or an extension skipped during background planning.
				// Reset exactly once. Never retry the interval review; only fall through for a separate pending refine.run.
				if (bgResult.explicit) {
					this._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
				}
				this._auto.stampCooldown();
				this._auto.resetTurns();
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "failure") {
				// Background review or planning failure stamps cooldown without a synchronous retry.
				// A separately queued refine.run may still be serviced below.
				if (branchVersion === this._auto.branchVersion) {
					this._auto.stampCooldown();
				}
				// Re-queue an explicit refine.run whose background plan failed,
				// but only when branchVersion is still current and no newer
				// pending request has arrived since the background plan consumed
				// the original one. A newer request retains priority; interval
				// failures keep existing no-retry cooldown semantics.
				if (
					bgResult.explicit &&
					bgResult.branchVersion === this._auto.branchVersion &&
					!this._pendingRequestedRefine
				) {
					this._pendingRequestedRefine = bgResult.options;
				}
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "invalidated" && !this._pendingRequestedRefine) {
				this._auto.stampCooldown();
				this._auto.resetTurns();
				return true;
			}

			await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
			return true;
		});
		if (this._host.isDisposed() || this._host.isDisposing() || bgConsumption !== "none") {
			return;
		}
		await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
	}

	private async _runSerializedRefineCheckpointAfterBackground(branchVersion: number): Promise<void> {
		// No background result, or a refine.run arrived while the background result was
		// in flight. Fall through so an explicit pending request is serviced at this boundary.

		// 2. Agent-callable refine.run requests that were NOT consumed by
		//    background planning (e.g. interval not reached at message_end,
		//    or cooldown was active). Service them synchronously.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending, "self");
			} catch (error) {
				this._emitRefineFailed(error);
			}
			this._auto.stampCooldown();
			this._auto.resetTurns();
			return;
		}

		// 3. Post-compaction auto-refine. Serialized sessions defer the
		// compaction trigger to this boundary instead of entering the interactive
		// path, which waits for agent idle and can never run inside a tool loop.
		if (!this._autoRefineAllowedForSession()) {
			this._auto.discardCompact();
			return;
		}
		const settings = this._host.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._auto.discardCompact();
			return;
		}
		if (this._auto.hasPendingCompact) {
			if (!settings.compact) {
				this._auto.discardCompact();
			} else {
				const nowMs = Date.now();
				const underCooldown = this._auto.lastReviewAt > 0 && nowMs - this._auto.lastReviewAt < settings.cooldownMs;
				if (underCooldown) {
					// Preserve the compact trigger for a later boundary, matching the
					// interactive path's pending behavior while the cooldown is active.
					return;
				}
				this._auto.discardCompact();
				await this._auto._runSerializedAutoRefineReview("compact", branchVersion);
				return;
			}
		}

		// 4. Interval-triggered auto-refine (no background plan was started).
		if (this._auto.turnsSinceReview < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown = this._auto.lastReviewAt > 0 && nowMs - this._auto.lastReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		await this._auto._runSerializedAutoRefineReview("turn_interval", branchVersion);
	}

	private async _consumeSerializedBackgroundPlan(
		consume: (result: SerializedBackgroundPlanResult | undefined) => Promise<boolean>,
	): Promise<"none" | "waited" | "continue" | "stop"> {
		if (this._serializedPlanClaim) {
			await this._serializedPlanClaim.catch(() => undefined);
			return "waited";
		}
		const planInFlight = this._serializedPlanInFlight;
		if (!planInFlight) {
			return "none";
		}

		let releaseClaim: () => void = () => {};
		const claim = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		this._serializedPlanClaim = claim;
		try {
			const result = await planInFlight.catch(() => undefined);
			if (this._serializedPlanInFlight === planInFlight) {
				this._serializedPlanInFlight = undefined;
				this._serializedExplicitRefineOptions = undefined;
			}
			return (await consume(result)) ? "stop" : "continue";
		} finally {
			releaseClaim();
			if (this._serializedPlanClaim === claim) {
				this._serializedPlanClaim = undefined;
			}
		}
	}

	private async _applySerializedPlan(
		bgResult: Extract<SerializedBackgroundPlanResult, { status: "plan" }>,
	): Promise<void> {
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._execution._applyRefine(bgResult.plan, bgResult.options, bgResult.abort, bgResult.source);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._host.notifyCheckpoints();
			this._host.scheduleInputPump();
		}
	}

	private _maybeStartSerializedBackgroundPlan(): void {
		if (!this._serializedRefine || this._host.isDisposed() || this._host.isDisposing()) {
			return;
		}
		// Don't start if a plan is already in flight.
		if (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			return;
		}

		// Start background planning for a pending agent-callable
		// refine.run request, so its plan is ready at the shouldStopAfterTurn
		// boundary. The pending request is consumed (cleared) here so the
		// boundary doesn't re-plan it. Explicit refine.run skips the review gate.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			this._serializedExplicitRefineOptions = pending;
			const refineAbort = new AbortController();
			this._refineAbortController = refineAbort;
			const branchVersion = this._auto.branchVersion;
			this._serializedPlanInFlight = this._runBackgroundPlan(pending, refineAbort, branchVersion, true);
			return;
		}

		// Interval-triggered auto-refine background planning.
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this._host.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._auto.turnsSinceReview < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown = this._auto.lastReviewAt > 0 && nowMs - this._auto.lastReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;
		const branchVersion = this._auto.branchVersion;
		// Pass empty options — _runBackgroundPlan derives instructions from
		// the review result for interval-triggered auto-refine.
		this._serializedPlanInFlight = this._runBackgroundPlan({}, refineAbort, branchVersion);
	}

	private async _runBackgroundPlan(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		branchVersion: number,
		skipReview = false,
	): Promise<SerializedBackgroundPlanResult | undefined> {
		try {
			let planOptions = options;
			if (!skipReview) {
				// Interval-triggered: run the review gate first, then derive
				// instructions from the review result (not prepopulated).
				const review = await this._auto._reviewAutoRefine(
					{
						reason: "turn_interval",
						turnsSinceLastReview: this._auto.turnsSinceReview,
					},
					refineAbort.signal,
				);
				if (this._host.isDisposed() || this._host.isDisposing() || branchVersion !== this._auto.branchVersion) {
					return { status: "invalidated", branchVersion };
				}
				if (!review.shouldRefine) {
					return { status: "skip" };
				}
				planOptions = {
					instructions: autoRefineInstructions("turn_interval", review),
				};
			}
			// For explicit refine.run (skipReview=true), plan directly with
			// the user-provided options — no auto-review gate.
			const plan = await this._execution._planRefine(
				planOptions,
				refineAbort.signal,
				skipReview ? "manual" : "auto",
			);
			if (this._host.isDisposed() || this._host.isDisposing() || branchVersion !== this._auto.branchVersion) {
				return { status: "invalidated", branchVersion };
			}
			return {
				status: "plan",
				plan,
				options: planOptions,
				abort: refineAbort,
				branchVersion,
				source: skipReview ? "self" : "auto",
			};
		} catch (error) {
			if (this._host.isDisposed() || this._host.isDisposing() || branchVersion !== this._auto.branchVersion) {
				return { status: "invalidated", branchVersion };
			}
			if (error instanceof RefineSkippedError) {
				return { status: "skip", explicit: skipReview };
			}
			return {
				status: "failure",
				explicit: skipReview,
				options,
				branchVersion,
			};
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
		}
	}

	private async _runSerializedRefine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		},
		source: Exclude<RefinementSource, "user">,
	): Promise<void> {
		if (this._host.isDisposed() || this._host.isDisposing()) {
			return;
		}
		// Guard: serialize against concurrent _runSerializedRefine calls.
		// _serializedPlanInFlight covers background planning; _refineInFlight
		// covers the apply phase. Both must be settled before starting a new
		// plan+apply cycle.
		while (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			if (this._serializedPlanInFlight) {
				await this._consumeSerializedBackgroundPlan(async () => false);
			} else if (this._refineInFlight) {
				await this._refineInFlight;
			} else {
				await this._refinePlanInFlight;
			}
		}
		if (this._host.isDisposed() || this._host.isDisposing()) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._execution._planRefine(options, refineAbort.signal, source === "auto" ? "auto" : "manual");
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (error) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._host.scheduleInputPump();
			throw error;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		if (this._host.isDisposed() || refineAbort.signal.aborted) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._host.scheduleInputPump();
			return;
		}

		// Do NOT call agent.waitForIdle() — we are at the quiescent boundary
		// already (shouldStopAfterTurn). _applyRefine handles disconnect/reconnect internally.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._execution._applyRefine(plan, options, refineAbort, source);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._host.notifyCheckpoints();
			this._host.scheduleInputPump();
		}
	}

	handleRefineHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		switch (type) {
			case "refine.status": {
				return {
					pending: this._pendingRequestedRefine !== undefined,
					in_flight:
						this._refineInFlight !== undefined ||
						this._refinePlanInFlight !== undefined ||
						this._serializedPlanInFlight !== undefined,
				};
			}
			case "refine.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("refine.run instructions must be a string when provided");
				}
				const globalFlag = payload.global;
				if (globalFlag !== undefined && typeof globalFlag !== "boolean") {
					throw new Error("refine.run global must be a boolean when provided");
				}
				if (!this._host.isStreaming()) {
					return {
						scheduled: false,
						reason: "no active turn; refine can only be requested while a turn is running",
					};
				}
				const previous = this._pendingRequestedRefine ?? this._serializedExplicitRefineOptions;
				this._pendingRequestedRefine = {
					instructions: instructions ?? previous?.instructions,
					global: globalFlag ?? previous?.global,
				};
				// In serialized mode, kick off background planning immediately
				// (the primary response ended at message_end, tools are active).
				// This lets planning overlap tool execution rather than waiting
				// for the shouldStopAfterTurn boundary.
				if (this._serializedRefine) {
					if (this._serializedPlanInFlight) {
						this._auto.invalidatePlans();
						if (this._refineAbortController) {
							this._refineAbortController.abort();
						} else {
							this._serializedPlanInFlight = Promise.resolve({
								status: "invalidated",
								branchVersion: this._auto.branchVersion,
							});
						}
					} else {
						this._maybeStartSerializedBackgroundPlan();
					}
				}
				return {
					scheduled: true,
					note: "Refinement runs when the current turn ends; applied edits are appended to your context as a refinement notice and you resume automatically. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown refine request type "${type}"`);
		}
	}

	async _drainPendingRefinementForDisposal(): Promise<void> {
		this._auto.cancelScheduled();
		await Promise.allSettled(this._auto.pendingOperations());
		this._auto.cancelScheduled();
		// Wait for in-flight refinement (including serialized background plan) to settle.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else if (this._serializedPlanInFlight) {
				// Await the background plan and apply a ready "plan" result before teardown.
				await this._consumeSerializedBackgroundPlan(async (bgResult) => {
					if (bgResult?.status === "plan" && bgResult.branchVersion === this._auto.branchVersion) {
						try {
							await this._applySerializedPlan(bgResult);
						} catch (error) {
							this._emitRefineFailed(error);
						}
						// Stamp cooldown and reset counter so the interval
						// check below does not trigger a duplicate refine.
						this._auto.stampCooldown();
						this._auto.resetTurns();
					}
					// Preserve a consumed explicit request when its background plan failed,
					// matching the turn-boundary recovery path. The pending drain below
					// retries it once before disposal.
					if (
						bgResult?.status === "failure" &&
						bgResult.explicit &&
						bgResult.branchVersion === this._auto.branchVersion &&
						!this._pendingRequestedRefine
					) {
						this._pendingRequestedRefine = bgResult.options;
					}
					if (bgResult?.status === "skip" && bgResult.explicit) {
						this._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
					}
					// For "skip" or "failure", stamp cooldown and reset counter
					// so the interval check below does not trigger a duplicate
					// terminal retry.
					if (
						bgResult?.status === "skip" ||
						bgResult?.status === "failure" ||
						bgResult?.status === "invalidated"
					) {
						this._auto.stampCooldown();
						this._auto.resetTurns();
					}
					return false;
				});
			} else {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		// Drain an agent-callable refine.run request that was scheduled but
		// not yet consumed. Use the direct serialized path (no waitForIdle)
		// since the agent may still own activeRun at the final agent_end.
		if (this._pendingRequestedRefine) {
			const pending = this._pendingRequestedRefine;
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending, "self");
			} catch {
				// Best-effort drain; refinement errors must not block disposal.
			}
			// Stamp cooldown and reset counter so the interval check below
			// does not trigger a duplicate refine after the explicit drain.
			this._auto.stampCooldown();
			this._auto.resetTurns();
		}
		// A serialized compaction can finish without another model turn. Drain its
		// pending review here so disposal does not silently lose the trigger.
		if (this._serializedRefine && this._auto.hasPendingCompact && this._autoRefineAllowedForSession()) {
			const compactSettings = this._host.settingsManager.getAutoRefineSettings();
			if (!compactSettings.enabled || !compactSettings.compact) {
				this._auto.discardCompact();
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._auto.lastReviewAt > 0 && nowMs - this._auto.lastReviewAt < compactSettings.cooldownMs;
				this._auto.discardCompact();
				if (!underCooldown) {
					try {
						await this._auto._runSerializedAutoRefineReview("compact", this._auto.branchVersion);
					} catch {
						// Best-effort drain; refinement errors must not block disposal.
					}
					return;
				}
			}
		}

		// If auto-refine is due but has not started yet, run it now so the
		// refinement is persisted before disposal. Use the direct serialized
		// path in serialized mode, or _maybeAutoRefine in interactive mode
		// (where the agent is idle at this point).
		if (this._host.isDisposed() || !this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this._host.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._auto.turnsSinceReview < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown = this._auto.lastReviewAt > 0 && nowMs - this._auto.lastReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		if (this._serializedRefine) {
			await this._runSerializedRefineCheckpoint();
		} else {
			await this._auto._maybeAutoRefine("turn_interval");
		}
	}

	_autoRefineAllowedForSession(): boolean {
		return this._host.getDepth() === 0 && this._execution._localHarnessStateDir() !== undefined;
	}

	async _invalidatePendingAutoRefineForBranchChange(): Promise<void> {
		this._auto.abortReview();
		this._auto._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._auto.resetTurns();
		// Increment branch version BEFORE aborting/awaiting the serialized plan.
		// This invalidates the plan's branchVersion check at the boundary
		// so even if the plan completes, the boundary will reject it
		// (bgResult.branchVersion !== this._auto.branchVersion).
		this._auto.invalidatePlans();
		// Abort the in-flight refine/bplan controller so any pending
		// _planRefine or _reviewAutoRefine call settles via signal abort
		// rather than hanging forever.
		this._refineAbortController?.abort();
		if (this._serializedPlanInFlight) {
			await this._consumeSerializedBackgroundPlan(async () => false);
		}
		while (this._refinePlanInFlight) {
			await this._refinePlanInFlight;
		}
		await this._waitForRefineIdle();
	}

	_emitRefineFailed(error: unknown): void {
		this._host.emit({
			type: "refine_failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	_consumePendingRequestedRefine(): boolean {
		const pending = this._pendingRequestedRefine;
		if (!pending) return false;
		this._pendingRequestedRefine = undefined;
		void this._host.dispatchRefine(pending, { source: "self" }).catch((error) => this._emitRefineFailed(error));
		return true;
	}

	async refine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {},
		internal: { skipAbort?: boolean; trigger?: "manual" | "auto"; source?: RefinementSource } = {},
	): Promise<RefinementResult> {
		// Queued /refine executes from the session-input pump between turns;
		// refine never aborts the agent (planning is backgrounded and the apply
		// phase waits for quiescence), so skipAbort only asserts the pump's
		// idle invariant instead of changing abort behavior.
		if (internal.skipAbort && this._host.isStreaming()) {
			throw new Error("Cannot refine without aborting while the agent is running.");
		}
		// Wait for any existing refine (both planning and application) before
		// starting a new run. This serializes concurrent /refine calls so two
		// planning phases cannot race into concurrent _applyRefine calls that
		// overwrite harness state.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else {
				// A serialized background plan is in flight (started during an
				// active turn at message_end). Wait for planning and for the active
				// turn to settle so its normal checkpoint can consume the plan.
				const serializedPlanInFlight = this._serializedPlanInFlight;
				await serializedPlanInFlight;
				if (this._refineInFlight || this._refinePlanInFlight) {
					continue;
				}
				await this._host.waitForAgentIdle();
				// Aborted turns skip shouldStopAfterTurn. Drop their settled plan
				// after idle so a later public refine cannot spin on it forever.
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._execution._planRefine(options, refineAbort.signal, internal.trigger ?? "manual");
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (e) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._host.scheduleInputPump();
			throw e;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		// Block new turns before waiting for the current turn to finish. One shared
		// settled promise covers the full transition and apply critical section.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			// Wait for the session to become quiescent before applying. Planning is
			// allowed to overlap active user work, but application must not disconnect
			// event handling until that work and its queued events have completed.
			await this._host.waitForAgentIdle();
			while (true) {
				const eventQueue = this._host.getEventQueue();
				const compactionOp = this._host.getCompactionOperation();
				const branchSummaryOp = this._host.getBranchSummaryOperation();
				await Promise.allSettled([
					eventQueue,
					...(compactionOp ? [compactionOp] : []),
					...(branchSummaryOp ? [branchSummaryOp] : []),
				]);
				if (
					eventQueue === this._host.getEventQueue() &&
					compactionOp === this._host.getCompactionOperation() &&
					branchSummaryOp === this._host.getBranchSummaryOperation()
				) {
					break;
				}
			}
			if (this._host.isDisposed() || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			return await this._execution._applyRefine(
				plan,
				options,
				refineAbort,
				internal.source ?? (internal.trigger === "auto" ? "auto" : "user"),
			);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._host.notifyCheckpoints();
			this._host.scheduleInputPump();
		}
	}

	async _waitForRefineIdle(): Promise<void> {
		while (this._refineInFlight) {
			await this._refineInFlight;
		}
	}

	_discardPendingAutoRefine(options: { cancelPostCompactionContinue?: boolean } = {}): void {
		this._auto._discardPendingAutoRefine(options);
	}

	_scheduleAutoRefineAfterAgentEnd(): void {
		this._auto._scheduleAutoRefineAfterAgentEnd();
	}

	_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void {
		this._auto._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
	}

	_localHarnessStateDir(): string | undefined {
		return this._execution._localHarnessStateDir();
	}

	_loadMergedHarnessState(): HarnessState {
		return this._execution._loadMergedHarnessState();
	}
}
