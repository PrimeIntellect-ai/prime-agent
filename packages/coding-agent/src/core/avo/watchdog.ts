import { createHash } from "node:crypto";
import type { AvoRunState } from "./types.js";

export type AvoProgressWatchdogAction = "delivery" | "delivery_intervene" | "progress" | "watch" | "intervene";

export interface AvoProgressWatchdogSnapshot {
	runId: string;
	token: string;
	hasObservableProgress: boolean;
	workspaceChanged: boolean;
	workspaceDigest?: string;
	baselineExecutionCount: number;
	candidateCount: number;
	meaningfulHostPassCount: number;
	cycleCount: number;
	trialCount: number;
	completedExperimentCount: number;
	coveredObligationCount: number;
	resolvedCriticalAssumptionCount: number;
}

export interface AvoProgressWatchdogAssessment {
	action: AvoProgressWatchdogAction;
	madeProgress: boolean;
	consecutiveNoProgressTurns: number;
	consecutiveDeliveryMismatchTurns: number;
	recoveredFromNoProgressTurns: number;
	progressIndicators: string[];
}

function stableToken(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function deriveAvoProgressWatchdogSnapshot(
	state: AvoRunState,
	observedWorkspaceDigest?: string,
): AvoProgressWatchdogSnapshot {
	const meaningfulHostPasses = state.evaluations
		.filter(
			(evaluation) =>
				evaluation.issuedBy === "host" &&
				evaluation.authority !== "model_opinion" &&
				evaluation.status === "pass" &&
				evaluation.metrics.meaningful !== false,
		)
		.map((evaluation) => `${evaluation.candidateId}:${evaluation.evaluatorId}`)
		.sort();
	const workspaceChanged =
		state.routing.environment === "coding" &&
		observedWorkspaceDigest !== undefined &&
		state.verificationBaseline !== undefined &&
		observedWorkspaceDigest !== state.verificationBaseline.workspaceDigest;
	const baselineExecutionIds = (state.verificationBaseline?.executions ?? [])
		.filter((execution) => execution.meaningful)
		.map((execution) => execution.executionId)
		.sort();
	const candidateIdentities = state.candidates
		.map((candidate) => `${candidate.candidateId}:${candidate.payloadDigest}:${candidate.workspaceDigest ?? ""}`)
		.sort();
	const cycleIdentities = state.cycles.map((cycle) => `${cycle.cycleId}:${cycle.candidateId}:${cycle.outcome}`).sort();
	const trialIdentities = state.trials
		.map((trial) => `${trial.trialId}:${trial.candidateId}:${trial.status}:${trial.cellDigest ?? ""}`)
		.sort();
	const completedExperimentIds = state.experiments
		.filter((experiment) => experiment.status === "completed")
		.map((experiment) => `${experiment.experimentId}:${experiment.aggregateEvaluationId ?? ""}`)
		.sort();
	const coveredObligationIds = state.obligationCoverage
		.map((coverage) => `${coverage.candidateId}:${coverage.obligationId}:${coverage.candidatePayloadDigest}`)
		.sort();
	const resolvedCriticalAssumptionIds = state.criticalAssumptions
		.filter((assumption) => assumption.status !== "open")
		.map((assumption) => `${assumption.assumptionId}:${assumption.status}:${assumption.candidateId ?? ""}`)
		.sort();
	const hasObservableProgress =
		baselineExecutionIds.length > 0 ||
		meaningfulHostPasses.length > 0 ||
		cycleIdentities.length > 0 ||
		trialIdentities.length > 0 ||
		completedExperimentIds.length > 0 ||
		coveredObligationIds.length > 0 ||
		resolvedCriticalAssumptionIds.length > 0;
	return {
		runId: state.runId,
		token: stableToken({
			baselineExecutionIds,
			meaningfulHostPasses,
			cycleIdentities,
			trialIdentities,
			completedExperimentIds,
			coveredObligationIds,
			resolvedCriticalAssumptionIds,
		}),
		hasObservableProgress,
		workspaceChanged,
		workspaceDigest: observedWorkspaceDigest,
		baselineExecutionCount: baselineExecutionIds.length,
		candidateCount: candidateIdentities.length,
		meaningfulHostPassCount: meaningfulHostPasses.length,
		cycleCount: cycleIdentities.length,
		trialCount: trialIdentities.length,
		completedExperimentCount: completedExperimentIds.length,
		coveredObligationCount: coveredObligationIds.length,
		resolvedCriticalAssumptionCount: resolvedCriticalAssumptionIds.length,
	};
}

function progressIndicators(
	current: AvoProgressWatchdogSnapshot,
	previous: AvoProgressWatchdogSnapshot | undefined,
): string[] {
	const indicators: string[] = [];
	if (current.baselineExecutionCount > (previous?.baselineExecutionCount ?? 0)) {
		indicators.push("a meaningful immutable baseline check ran");
	}
	if (current.meaningfulHostPassCount > (previous?.meaningfulHostPassCount ?? 0)) {
		indicators.push("new meaningful host evidence passed");
	}
	if (current.cycleCount > (previous?.cycleCount ?? 0)) indicators.push("a candidate cycle completed");
	if (current.trialCount > (previous?.trialCount ?? 0)) indicators.push("a host-bound experiment cell completed");
	if (current.completedExperimentCount > (previous?.completedExperimentCount ?? 0)) {
		indicators.push("a preregistered experiment completed");
	}
	if (current.coveredObligationCount > (previous?.coveredObligationCount ?? 0)) {
		indicators.push("a preregistered obligation gained host-bound coverage");
	}
	if (current.resolvedCriticalAssumptionCount > (previous?.resolvedCriticalAssumptionCount ?? 0)) {
		indicators.push("a critical assumption was tested against host evidence");
	}
	if (indicators.length === 0 && previous && current.token !== previous.token) {
		indicators.push("host-observable task state changed");
	}
	return indicators;
}

export class AvoProgressWatchdog {
	private previous?: AvoProgressWatchdogSnapshot;
	private consecutiveNoProgressTurns = 0;
	private consecutiveDeliveryMismatchTurns = 0;

	prime(snapshot: AvoProgressWatchdogSnapshot): void {
		if (this.previous?.runId === snapshot.runId) return;
		this.previous = snapshot;
		this.consecutiveNoProgressTurns = 0;
		this.consecutiveDeliveryMismatchTurns = 0;
	}

	observe(
		snapshot: AvoProgressWatchdogSnapshot,
		options: { deliveryReady?: boolean } = {},
	): AvoProgressWatchdogAssessment {
		if (this.previous?.runId !== snapshot.runId) {
			this.previous = undefined;
			this.consecutiveNoProgressTurns = 0;
			this.consecutiveDeliveryMismatchTurns = 0;
		}
		if (options.deliveryReady) {
			this.previous = snapshot;
			this.consecutiveNoProgressTurns = 0;
			this.consecutiveDeliveryMismatchTurns += 1;
			return {
				action: this.consecutiveDeliveryMismatchTurns >= 2 ? "delivery_intervene" : "delivery",
				madeProgress: false,
				consecutiveNoProgressTurns: 0,
				consecutiveDeliveryMismatchTurns: this.consecutiveDeliveryMismatchTurns,
				recoveredFromNoProgressTurns: 0,
				progressIndicators: ["the verified candidate is ready but the assistant delivery does not match it"],
			};
		}
		this.consecutiveDeliveryMismatchTurns = 0;
		const madeProgress = this.previous ? snapshot.token !== this.previous.token : snapshot.hasObservableProgress;
		const indicators = madeProgress ? progressIndicators(snapshot, this.previous) : [];
		const recoveredFromNoProgressTurns = madeProgress ? this.consecutiveNoProgressTurns : 0;
		if (madeProgress) this.consecutiveNoProgressTurns = 0;
		else this.consecutiveNoProgressTurns += 1;
		this.previous = snapshot;
		return {
			action: madeProgress ? "progress" : this.consecutiveNoProgressTurns >= 2 ? "intervene" : "watch",
			madeProgress,
			consecutiveNoProgressTurns: this.consecutiveNoProgressTurns,
			consecutiveDeliveryMismatchTurns: 0,
			recoveredFromNoProgressTurns,
			progressIndicators: indicators,
		};
	}
}
