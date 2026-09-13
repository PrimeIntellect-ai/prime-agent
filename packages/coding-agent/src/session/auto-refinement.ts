import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutoRefineReason, AutoRefineReview, RefinementResult } from "../core/refinement/index.js";
import type { SettingsManager } from "../core/settings-manager.js";
import { RefineSkippedError } from "./refinement-execution.js";
export interface AutoRefineReviewRequest {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}
export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;

export function autoRefineInstructions(reason: AutoRefineReason, review: AutoRefineReview): string {
	const detail = review.instructions
		? `
Reviewer instructions: ${review.instructions}`
		: "";
	return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${detail}`;
}

export interface AutoRefinementHost {
	settingsManager: Pick<SettingsManager, "getAutoRefineSettings">;
	isDisposed(): boolean;
	isDisposing(): boolean;
	isStreaming(): boolean;
	isCompacting(): boolean;
	isAllowed(): boolean;
	getModel(): Model<Api> | undefined;
	isContinuationScheduled(): boolean;
	cancelContinuation(): void;
	refine(options: { instructions?: string }, internal: { trigger: "auto" }): Promise<RefinementResult>;
	runSerialized(options: { instructions?: string }, source: "auto"): Promise<void>;
	emitFailure(error: unknown): void;
	review(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview>;
}

/** Owns automatic review triggers, cooldowns, cancellation, and scheduled work. */
export class AutoRefinement {
	private _assistantTurnsSinceAutoRefine = 0;
	private _lastAutoRefineReviewAt = 0;
	private _autoRefineInProgress = false;
	private readonly _autoRefineOperations = new Set<Promise<void>>();
	private readonly _scheduledAutoRefineTimers = new Set<ReturnType<typeof setTimeout>>();
	private _compactAutoRefinePending = false;
	private _turnIntervalAutoRefinePending = false;
	private _pendingAutoRefineReview: { reason: AutoRefineReason; review: AutoRefineReview } | undefined;
	private _autoRefineBranchVersion = 0;
	private _autoRefineReviewAbort?: AbortController;
	private readonly _autoRefineReviewer?: AutoRefineReviewer;

	constructor(
		private readonly _host: AutoRefinementHost,
		private readonly _serialized: boolean,
		reviewer?: AutoRefineReviewer,
	) {
		this._autoRefineReviewer = reviewer;
	}

	get branchVersion(): number {
		return this._autoRefineBranchVersion;
	}
	get turnsSinceReview(): number {
		return this._assistantTurnsSinceAutoRefine;
	}
	get lastReviewAt(): number {
		return this._lastAutoRefineReviewAt;
	}
	get hasPendingCompact(): boolean {
		return this._compactAutoRefinePending;
	}
	observeAssistantEnd(): void {
		this._assistantTurnsSinceAutoRefine++;
	}
	resetTurns(): void {
		this._assistantTurnsSinceAutoRefine = 0;
	}
	stampCooldown(): void {
		this._lastAutoRefineReviewAt = Date.now();
	}
	invalidatePlans(): void {
		this._autoRefineBranchVersion++;
	}
	abortReview(): void {
		this._autoRefineReviewAbort?.abort();
	}
	discardCompact(): void {
		this._compactAutoRefinePending = false;
	}
	cancelScheduled(): void {
		for (const timer of this._scheduledAutoRefineTimers) clearTimeout(timer);
		this._scheduledAutoRefineTimers.clear();
	}
	pendingOperations(): Promise<void>[] {
		return [...this._autoRefineOperations];
	}

	async _runSerializedAutoRefineReview(reason: "compact" | "turn_interval", branchVersion: number): Promise<void> {
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		this._autoRefineInProgress = true;
		try {
			const review = await this._reviewAutoRefine(
				{ reason, turnsSinceLastReview: this._assistantTurnsSinceAutoRefine },
				reviewAbort.signal,
			);
			if (this._host.isDisposed() || this._host.isDisposing() || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return;
			}
			await this._host.runSerialized({ instructions: autoRefineInstructions(reason, review) }, "auto");
			if (this._host.isDisposed() || this._host.isDisposing() || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		} catch (error) {
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
				// An extension skip is an intentional non-round, not a failure.
				if (error instanceof RefineSkippedError) {
					this._assistantTurnsSinceAutoRefine = 0;
				} else {
					this._host.emitFailure(error);
				}
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
		}
	}

	_discardPendingAutoRefine(options: { cancelPostCompactionContinue?: boolean } = {}): void {
		this._compactAutoRefinePending = false;
		this._turnIntervalAutoRefinePending = false;
		this._pendingAutoRefineReview = undefined;
		if (options.cancelPostCompactionContinue) {
			this._host.cancelContinuation();
		}
	}

	_scheduleAutoRefineAfterAgentEnd(): void {
		if (!this._host.isAllowed()) {
			return;
		}
		if (this._pendingAutoRefineReview) {
			this._scheduleAutoRefine(this._pendingAutoRefineReview.reason);
			return;
		}
		if (this._compactAutoRefinePending) {
			if (this._host.isContinuationScheduled()) {
				return;
			}
			this._scheduleAutoRefine("compact");
			return;
		}

		this._scheduleAutoRefine("turn_interval");
	}

	_scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void {
		if (!this._host.isAllowed()) {
			return;
		}
		if (this._serialized) {
			// Serialized sessions must service compaction-triggered refinement at
			// shouldStopAfterTurn (or disposal), never through the interactive path.
			this._compactAutoRefinePending = true;
			return;
		}
		if (willContinueAfterCompaction) {
			this._compactAutoRefinePending = true;
			return;
		}

		this._scheduleAutoRefine("compact");
	}

	private _shouldSkipAutoRefineForActiveAgent(): boolean {
		return this._host.isStreaming() || this._host.isCompacting();
	}

	private _scheduleDeferredAutoRefineIfIdle(): void {
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent() || this._pendingAutoRefineReview) {
			return;
		}
		if (this._turnIntervalAutoRefinePending) {
			this._turnIntervalAutoRefinePending = false;
			this._scheduleAutoRefine("turn_interval");
		}
	}

	_scheduleAutoRefine(reason: AutoRefineReason, branchVersion = this._autoRefineBranchVersion): void {
		const timer = setTimeout(() => {
			this._scheduledAutoRefineTimers.delete(timer);
			if (branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			const operation = this._maybeAutoRefine(reason);
			this._autoRefineOperations.add(operation);
			void operation.finally(() => this._autoRefineOperations.delete(operation)).catch(() => undefined);
		}, 0);
		this._scheduledAutoRefineTimers.add(timer);
	}

	async _maybeAutoRefine(reason: AutoRefineReason): Promise<void> {
		if (this._host.isDisposed() || this._host.isDisposing()) {
			this._discardPendingAutoRefine();
			return;
		}
		if (!this._host.isAllowed()) {
			this._discardPendingAutoRefine();
			return;
		}

		const settings = this._host.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._discardPendingAutoRefine();
			return;
		}
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent()) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}

		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;

		const pendingReview = this._pendingAutoRefineReview;
		if (pendingReview) {
			// A failed refine stamps the cooldown; keep the pending review for later.
			if (underCooldown) {
				return;
			}
			await this._runApprovedRefine(pendingReview.reason, pendingReview.review);
			return;
		}

		if (reason === "compact" && !settings.compact) {
			this._compactAutoRefinePending = false;
			reason = "turn_interval";
		}
		if (reason === "turn_interval" && this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		if (underCooldown) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}
		if (reason === "turn_interval") {
			this._turnIntervalAutoRefinePending = false;
		}
		if (!this._host.getModel()) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			}
			return;
		}
		this._autoRefineInProgress = true;
		const turnsSinceLastReview = this._assistantTurnsSinceAutoRefine;
		const branchVersion = this._autoRefineBranchVersion;
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		let approvedReview: AutoRefineReview | undefined;
		try {
			const review = await this._reviewAutoRefine({ reason, turnsSinceLastReview }, reviewAbort.signal);
			if (this._host.isDisposed() || this._host.isDisposing() || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				const preserveTurnIntervalReview =
					reason === "compact" && this._assistantTurnsSinceAutoRefine >= settings.turnInterval;
				if (preserveTurnIntervalReview) {
					this._turnIntervalAutoRefinePending = true;
				} else {
					this._lastAutoRefineReviewAt = nowMs;
					this._assistantTurnsSinceAutoRefine = 0;
				}
				if (reason === "compact") {
					this._compactAutoRefinePending = false;
				}
				return;
			}
			if (this._shouldSkipAutoRefineForActiveAgent()) {
				this._pendingAutoRefineReview = { reason, review };
				return;
			}
			approvedReview = review;
		} catch {
			// Failed review: stamp the cooldown so a persistent failure (bad auth,
			// unparseable output) doesn't retry a full review on every agent end.
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
			// When a refine follows, _runApprovedRefine schedules the deferred pass.
			if (!approvedReview) {
				this._scheduleDeferredAutoRefineIfIdle();
			}
		}
		if (approvedReview) {
			await this._runApprovedRefine(reason, approvedReview);
		}
	}

	private async _runApprovedRefine(reason: AutoRefineReason, review: AutoRefineReview): Promise<void> {
		this._autoRefineInProgress = true;
		try {
			await this._host.refine({ instructions: autoRefineInstructions(reason, review) }, { trigger: "auto" });
			this._pendingAutoRefineReview = undefined;
			this._turnIntervalAutoRefinePending = false;
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			if (reason === "compact") {
				this._compactAutoRefinePending = false;
			}
		} catch (error) {
			// Auto-refine is opportunistic; manual /refine remains available.
			// Stamp the cooldown so a persistently failing refine doesn't retry
			// (via a retained pending review) on every agent end.
			this._lastAutoRefineReviewAt = Date.now();
			if (error instanceof RefineSkippedError) {
				// A skipped round is consumed like a reviewer decline, not retained for retry.
				this._pendingAutoRefineReview = undefined;
				this._turnIntervalAutoRefinePending = false;
				this._assistantTurnsSinceAutoRefine = 0;
				if (reason === "compact") this._compactAutoRefinePending = false;
			}
		} finally {
			this._autoRefineInProgress = false;
			this._scheduleDeferredAutoRefineIfIdle();
		}
	}

	_reviewAutoRefine(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview> {
		if (this._autoRefineReviewer) {
			return this._reviewWithCustomReviewer(this._autoRefineReviewer, context, signal);
		}
		return this._host.review(context, signal);
	}

	private async _reviewWithCustomReviewer(
		reviewer: AutoRefineReviewer,
		context: AutoRefineReviewRequest,
		signal?: AbortSignal,
	): Promise<AutoRefineReview> {
		return reviewer.call(this, context, signal);
	}
}
