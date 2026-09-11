import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { formatNoModelSelectedMessage } from "../../core/auth-guidance.js";
import type { ExtensionRunner, SessionBeforeRefineResult } from "../../core/extensions/index.js";
import type { ProviderRetryPolicy } from "../../core/provider-retry.js";
import type { SessionManager } from "../../core/session-manager.js";
import { serializeConversation } from "../context/conversation-text.js";
import {
	type CustomMessage,
	convertToLlm,
	createRefinementNoticeMessage,
	createRefinementOutcomeMessage,
	type RefinementSource,
} from "../context/messages.js";
import type { AutoRefineReviewRequest } from "./automatic.js";
import {
	appendGlobalRefinement,
	applyRefinementProposal,
	generateRefinementId,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	getRefinementHistory,
	inferRefinementResultScope,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	normalizeRefinementProposal,
	saveHarnessState,
} from "./harness-state.js";
import { planRefinement, reviewAutoRefine } from "./planning.js";
import type { AutoRefineReview, HarnessState, RefinementPlan, RefinementResult } from "./types.js";
export type SessionRefinementEvent =
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string }
	| { type: "message_start" | "message_end"; message: CustomMessage };
export interface RefinementExecutionHost {
	sessionManager: Pick<
		SessionManager,
		"getSessionArtifactDir" | "getEntries" | "appendCustomMessageEntryWithRollback" | "appendCustomEntry"
	>;
	isDisposed(): boolean;
	getRlmSessionDir(): string | undefined;
	getModel(): Model<Api> | undefined;
	getThinkingLevel(): ThinkingLevel;
	getMessages(): AgentMessage[];
	getRequiredRequestAuth(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>;
	getRetryPolicy(): ProviderRetryPolicy;
	getExtensionRunner(): Pick<ExtensionRunner, "hasHandlers" | "emit">;
	disconnect(): void;
	reconnect(): void;
	emit(event: SessionRefinementEvent): void;
	retainUnpersistedOutcome(message: CustomMessage): void;
}

/** Thrown when a session_before_refine extension skips the refinement round. */
export class RefineSkippedError extends Error {}

/** Plans against current session dependencies and persists results during the apply barrier. */
export class RefinementExecution {
	constructor(
		private readonly _host: RefinementExecutionHost,
		private readonly _releaseAbort: (abort: AbortController) => void,
	) {}
	_localHarnessStateDir(): string | undefined {
		return (
			getLocalHarnessStateDir(this._host.sessionManager.getSessionArtifactDir()) ??
			(this._host.getRlmSessionDir() ? getLocalHarnessStateDir(this._host.getRlmSessionDir()) : undefined)
		);
	}

	_loadMergedHarnessState(): HarnessState {
		const localHarnessStateDir = this._localHarnessStateDir();
		return mergeHarnessStates(
			loadHarnessState(getGlobalHarnessStateDir(), "global"),
			localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined,
		);
	}

	private _loadRefinementHistory(): RefinementResult[] {
		return mergeRefinementHistory(
			loadGlobalRefinementHistory(getGlobalHarnessStateDir()),
			getRefinementHistory(this._host.sessionManager.getEntries().filter((entry) => entry.type === "custom")),
		);
	}

	async _planRefine(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		signal: AbortSignal,
		trigger: "manual" | "auto" = "manual",
	): Promise<RefinementPlan> {
		if (this._host.isDisposed()) {
			throw new Error("Cannot refine a disposed session.");
		}

		if (!this._host.getModel()) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const model = this._host.getModel()!;
		const { apiKey, headers } = await this._host.getRequiredRequestAuth(model);
		const globalHarnessStateDir = getGlobalHarnessStateDir();
		const localHarnessStateDir = this._localHarnessStateDir();
		const requestedScope = options.global ? "global" : "local";
		if (!options.rollbackId && requestedScope === "local" && !localHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const globalPlanningState = loadHarnessState(globalHarnessStateDir, "global");
		const localPlanningState = localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined;
		const planningState =
			requestedScope === "global"
				? globalPlanningState
				: mergeHarnessStates(globalPlanningState, localPlanningState);
		const history = this._loadRefinementHistory();
		const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
		let baselineScope = rollbackTarget
			? (inferRefinementResultScope(rollbackTarget) ?? requestedScope)
			: requestedScope;
		let baselineHarnessStateDir = baselineScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
		if (rollbackTarget?.harnessStatePath) {
			baselineHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
			baselineScope = resolve(baselineHarnessStateDir) === resolve(globalHarnessStateDir) ? "global" : "local";
		}
		if (!baselineHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const baselineState = rollbackTarget
			? loadHarnessState(baselineHarnessStateDir, baselineScope)
			: baselineScope === "global"
				? globalPlanningState
				: localPlanningState!;
		if (!options.rollbackId && this._host.getExtensionRunner().hasHandlers("session_before_refine")) {
			const result = (await this._host.getExtensionRunner().emit({
				type: "session_before_refine",
				preparation: {
					trigger,
					instructions: options.instructions,
					scope: requestedScope,
					planningState,
					history,
					conversationText: serializeConversation(convertToLlm(this._host.getMessages())).slice(-80_000),
				},
				signal,
			})) as SessionBeforeRefineResult | undefined;
			if (this._host.isDisposed() || signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			if (result?.skip) {
				throw new RefineSkippedError("Refinement skipped by extension");
			}
			if (result?.proposal !== undefined) {
				return {
					proposal: normalizeRefinementProposal(result.proposal),
					id: generateRefinementId(),
					baselineState,
				};
			}
		}
		const plan = await planRefinement(
			this._host.getMessages(),
			planningState,
			history,
			model,
			apiKey,
			{ ...options, retry: this._host.getRetryPolicy() },
			headers,
			signal,
			this._host.getThinkingLevel(),
		);
		if (this._host.isDisposed() || signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		return { ...plan, baselineState };
	}

	async _applyRefine(
		plan: RefinementPlan,
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		source: RefinementSource,
	): Promise<RefinementResult> {
		if (this._host.isDisposed()) {
			throw new Error("Cannot refine a disposed session.");
		}
		// The caller has already set _refineInFlight and waited for agent idle.
		// Disconnect only for the brief apply + save + reconnect critical section.
		this._host.disconnect();

		try {
			const globalHarnessStateDir = getGlobalHarnessStateDir();
			const localHarnessStateDir = this._localHarnessStateDir();
			const requestedScope = options.global ? "global" : "local";
			const history = this._loadRefinementHistory();
			const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
			let targetScope = plan.rollbackScope ?? requestedScope;
			let targetHarnessStateDir = targetScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
			if (targetScope === "local" && rollbackTarget?.harnessStatePath) {
				if (!existsSync(rollbackTarget.harnessStatePath)) {
					throw new Error(
						`Local refinement ${rollbackTarget.id} state file not found: ${rollbackTarget.harnessStatePath}`,
					);
				}
				targetHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
				// Legacy records predate scope fields and default to "local" but may point
				// at the global store; honor the recorded path so its entries stay global.
				if (resolve(targetHarnessStateDir) === resolve(globalHarnessStateDir)) {
					targetScope = "global";
				}
			}
			if (!targetHarnessStateDir) {
				throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
			}
			// Re-read the target state immediately before applying so concurrent kernel
			// (`rlm.harness`) writes during the LLM pass are not clobbered.
			const state = loadHarnessState(targetHarnessStateDir, targetScope);
			const proposal = {
				...plan.proposal,
				edits: plan.proposal.edits.map((edit) => {
					const localPrefix = "local:";
					const globalPrefix = "global:";
					return {
						...edit,
						id: edit.id?.startsWith(localPrefix)
							? edit.id.slice(localPrefix.length)
							: edit.id?.startsWith(globalPrefix)
								? edit.id.slice(globalPrefix.length)
								: edit.id,
					};
				}),
			};
			if (this._host.isDisposed() || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			const result = applyRefinementProposal(state, proposal, {
				id: plan.id,
				rollbackOf: plan.rollbackOf,
				scope: targetScope,
				baselineState: plan.baselineState,
			});
			result.harnessStatePath = saveHarnessState(targetHarnessStateDir, state);
			if (targetScope === "global") {
				appendGlobalRefinement(globalHarnessStateDir, result);
			}
			let refinementAuditAppendError: { error: unknown } | undefined;
			try {
				this._host.sessionManager.appendCustomEntry("prime-agent.refinement", result);
			} catch (error) {
				refinementAuditAppendError = { error };
			}
			try {
				this._recordRefinementOutcome(result);
			} catch (error) {
				if (!refinementAuditAppendError) throw error;
			}
			if (refinementAuditAppendError) throw refinementAuditAppendError.error;
			// The prompt stays byte-identical so the provider prefix cache survives; the notice carries the change.
			this._recordRefinementNotice(result, source);
			try {
				this._host.emit({ type: "refine_complete", result });
			} catch {
				// Listener failures must not flip a successful refinement into
				// a reported failure — the refinement is already persisted.
			}
			try {
				await this._host.getExtensionRunner().emit({
					type: "refine_complete",
					id: result.id,
					summary: result.summary,
					appliedEdits: result.appliedEdits.filter((edit) => edit.applied).length,
					scope: result.scope ?? "local",
				});
			} catch {
				// Extension emit failures must not flip a successful refinement
				// into a reported failure — the refinement is already persisted.
			}
			return result;
		} finally {
			this._releaseAbort(refineAbort);
			if (!this._host.isDisposed()) {
				this._host.reconnect();
			}
		}
	}

	private _recordRefinementOutcome(result: RefinementResult): void {
		this._appendDurableRefineMessage(createRefinementOutcomeMessage(result));
	}

	private _recordRefinementNotice(result: RefinementResult, source: RefinementSource): void {
		if (!result.appliedEdits.some((edit) => edit.applied)) return;
		this._appendDurableRefineMessage(createRefinementNoticeMessage(result, source));
	}

	private _appendDurableRefineMessage(message: CustomMessage): void {
		try {
			this._host.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch {
			// Not in the session file, so context rebuilds would drop the outcome.
			this._host.retainUnpersistedOutcome(message);
		}
		this._host.getMessages().push(message);
		this._host.emit({ type: "message_start", message });
		this._host.emit({ type: "message_end", message });
	}

	async review(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview> {
		const model = this._host.getModel();
		if (!model) {
			return { shouldRefine: false, rationale: "No model selected." };
		}
		const { apiKey, headers } = await this._host.getRequiredRequestAuth(model);
		return reviewAutoRefine(
			this._host.getMessages(),
			this._loadMergedHarnessState(),
			this._loadRefinementHistory(),
			model,
			apiKey,
			context,
			headers,
			signal,
			this._host.getThinkingLevel(),
			this._host.getRetryPolicy(),
		);
	}
}
