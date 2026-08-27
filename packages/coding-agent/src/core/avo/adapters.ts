import type { AutoresearchState, AutoresearchStopGate } from "../autoresearch.js";
import { deriveAvoEvaluation, evaluateGenericAvoStopGate, isAuthoritativeAvoEvaluation } from "./evaluator.js";
import type {
	AvoCandidate,
	AvoDashboardProjection,
	AvoEnvironment,
	AvoEvaluationReceipt,
	AvoProgressSignals,
	AvoRunState,
	AvoStopGate,
} from "./types.js";

export interface AvoEnvironmentAdapter<TAdapterState = unknown> {
	id: AvoEnvironment;
	validateCandidate(candidate: AvoCandidate, state: AvoRunState): void;
	deriveEvaluationState(
		candidate: AvoCandidate,
		receipts: readonly AvoEvaluationReceipt[],
		state: AvoRunState,
		adapterState?: TAdapterState,
	): {
		status: "pass" | "fail" | "revise" | "inconclusive";
		canonical: boolean;
		reasons: string[];
	};
	deriveProgressSignals(state: AvoRunState, adapterState?: TAdapterState): AvoProgressSignals;
	buildSupervisorContext(state: AvoRunState, adapterState?: TAdapterState): Record<string, unknown>;
	evaluateStopCondition(state: AvoRunState, adapterState?: TAdapterState): AvoStopGate;
	dashboardProjection(state: AvoRunState, adapterState?: TAdapterState): AvoDashboardProjection;
}

export interface ResearchAdapterState {
	state: AutoresearchState;
	stopGate: AutoresearchStopGate;
}

export const CODING_AVO_CANDIDATE_KINDS = [
	"patch",
	"implementation",
	"configuration",
	"diagnosis",
	"artifact",
] as const;

const CODING_EVALUATION_CONTRACTS: Record<(typeof CODING_AVO_CANDIDATE_KINDS)[number], readonly string[]> = {
	patch: ["test", "build"],
	implementation: ["test", "build"],
	configuration: ["test", "build", "runtime"],
	diagnosis: ["test", "runtime"],
	artifact: ["test", "build", "lint", "benchmark", "runtime"],
};

function genericProgress(state: AvoRunState): AvoProgressSignals {
	const outcomes = state.cycles.map((cycle) => cycle.outcome);
	const cycled = new Set(state.cycles.map((cycle) => cycle.candidateId));
	return {
		acceptedCandidates: outcomes.filter((outcome) => outcome === "accepted").length,
		rejectedCandidates: outcomes.filter((outcome) => outcome === "rejected").length,
		revisedCandidates: outcomes.filter((outcome) => outcome === "revised").length,
		authoritativeEvaluations: state.evaluations.filter(isAuthoritativeAvoEvaluation).length,
		modelOpinionEvaluations: state.evaluations.filter((receipt) => !isAuthoritativeAvoEvaluation(receipt)).length,
		openCandidates: state.candidates.filter((candidate) => !cycled.has(candidate.candidateId)).length,
		latestFailure: [...state.cycles].reverse().find((cycle) => cycle.failureSignature)?.failureSignature,
	};
}

function requireTrajectoryVerification(
	state: AvoRunState,
	gate: AvoStopGate,
	canonicalCycle: AvoRunState["cycles"][number] | undefined,
): AvoStopGate {
	const latestCheckpoint = canonicalCycle
		? [...state.checkpoints].reverse().find((checkpoint) => checkpoint.cycleId === canonicalCycle.cycleId)
		: undefined;
	const required =
		state.routing.horizon === "long" ||
		(state.routing.horizon === "iterative" && latestCheckpoint?.interventionNeeded === true);
	if (!required) return gate;
	const review = canonicalCycle
		? state.supervision.find(
				(item) => item.cycleId === canonicalCycle.cycleId && item.source === "retained_supervisor",
			)
		: undefined;
	const passed = review?.status === "progressing";
	const check = {
		id: "trajectory_verifier",
		label: "Independent trajectory verifier",
		passed,
		reason: passed
			? undefined
			: review
				? `the retained verifier reported ${review.status}: ${review.reason}`
				: canonicalCycle
					? "the current canonical accepted cycle has not been cleared by the retained verifier"
					: "no canonical accepted cycle is available for retained verification",
	};
	const checks = [...gate.checks, check];
	const reasons = checks.flatMap((item) => (!item.passed && item.reason ? [item.reason] : []));
	return { passed: reasons.length === 0, checks, reasons };
}

function phaseStatus(index: number, active: number, passed: boolean): "complete" | "active" | "pending" {
	if (passed || index < active) return "complete";
	return index === active ? "active" : "pending";
}

type AvoDashboardItem = AvoDashboardProjection["sections"][number]["items"][number];

function formatDashboardNumber(value: number): string {
	if (!Number.isFinite(value)) return String(value);
	if (Number.isInteger(value)) return String(value);
	const digits = Math.abs(value) >= 1 ? 3 : 6;
	return value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function shortDashboardReference(value: string | undefined): string {
	if (!value) return "none";
	return value.length > 16 ? `${value.slice(0, 12)}…` : value;
}

function experimentDashboardItems(
	experiment: AvoRunState["experiments"][number] | undefined,
	trials: AvoRunState["trials"],
): AvoDashboardItem[] {
	if (!experiment) {
		return [{ label: "Latest experiment", value: "No experiment recorded", status: "neutral" }];
	}
	const plan = experiment.plan;
	const outcome = experiment.outcome;
	const items: AvoDashboardItem[] = [
		{
			label: "Latest experiment",
			value: `${experiment.title} · ${experiment.status}`,
			status: experiment.status === "completed" ? "ok" : "neutral",
		},
		{
			label: "Latest plan coverage",
			value: plan
				? `${trials.length}/${plan.expectedTrials} cells · ${plan.pairing}`
				: "No structured plan recorded",
			status: plan && trials.length === plan.expectedTrials ? "ok" : "watch",
		},
		{
			label: "Experiment plan",
			value: plan
				? `${plan.primaryMetric} · ${plan.metricDirection} · ${plan.pairing}${plan.baselineCandidateId ? ` · baseline ${plan.baselineCandidateId}` : ""}`
				: "No structured plan recorded",
			status: "neutral",
		},
	];
	for (const aggregate of outcome?.candidateAggregates ?? []) {
		const metric = aggregate.metric;
		items.push({
			label: `Candidate ${aggregate.candidateId}`,
			value: `n=${metric.count} · mean ${formatDashboardNumber(metric.mean)} · median ${formatDashboardNumber(metric.median)} · 95% CI [${formatDashboardNumber(metric.ci95Low)}, ${formatDashboardNumber(metric.ci95High)}] · min/max ${formatDashboardNumber(metric.minimum)}/${formatDashboardNumber(metric.maximum)}`,
			status: "neutral",
		});
	}
	for (const comparison of outcome?.pairedComparisons ?? []) {
		items.push({
			label: `Paired ${comparison.candidateId} vs ${comparison.baselineCandidateId}`,
			value: `Δ mean ${formatDashboardNumber(comparison.delta.mean)} · 95% CI [${formatDashboardNumber(comparison.delta.ci95Low)}, ${formatDashboardNumber(comparison.delta.ci95High)}] · W/L/T ${comparison.wins}/${comparison.losses}/${comparison.ties} · win rate ${formatDashboardNumber(comparison.winRate * 100)}%`,
			status: comparison.favorableCi95Low > 0 ? "ok" : "watch",
		});
	}
	items.push({
		label: "Host experiment outcome",
		value: outcome
			? `${outcome.decision}${outcome.championCandidateId ? ` · champion ${outcome.championCandidateId}` : ""} · ${outcome.reason}`
			: "No aggregate outcome yet",
		status:
			outcome?.decision === "promote" || outcome?.decision === "retain"
				? "ok"
				: experiment.status === "completed"
					? "watch"
					: "neutral",
	});
	for (const trial of trials.slice(-12)) {
		const primaryMetric = plan?.primaryMetric;
		const primaryValue = primaryMetric ? trial.metrics[primaryMetric] : undefined;
		items.push({
			label: `Trial ${trial.candidateId} · ${trial.conditionId ?? "unlabeled"} · seed ${trial.seed ?? "none"}`,
			value: `${primaryMetric ?? "metric"}=${typeof primaryValue === "number" ? formatDashboardNumber(primaryValue) : String(primaryValue ?? "missing")} · ${trial.status} · eval ${shortDashboardReference(trial.evaluationId)} · cell ${shortDashboardReference(trial.cellDigest)} · cmd ${shortDashboardReference(trial.commandDigest)}`,
			status: trial.status === "pass" ? "ok" : trial.status === "fail" ? "fail" : "watch",
		});
	}
	if (trials.length > 12) {
		items.push({
			label: "Earlier trials",
			value: `${trials.length - 12} additional host-bound cells are retained in the trace`,
			status: "neutral",
		});
	}
	if (outcome) {
		items.push({
			label: "Aggregate / manifest digests",
			value: `${outcome.aggregateDigest} / ${outcome.trialManifestDigest}`,
			status: "neutral",
		});
	}
	return items;
}

function genericProjection(
	state: AvoRunState,
	stopGate: AvoStopGate,
	phases: Array<{ id: string; title: string; short: string }>,
): AvoDashboardProjection {
	const latestExperiment = state.experiments.at(-1);
	const latestExperimentTrials = latestExperiment
		? state.trials.filter((trial) => trial.experimentId === latestExperiment.experimentId)
		: [];
	const active = stopGate.passed
		? phases.length - 1
		: state.cycles.length > 0
			? Math.min(phases.length - 2, 2 + Math.max(0, state.routing.horizon === "long" ? 1 : 0))
			: state.evaluations.length > 0
				? Math.min(phases.length - 2, 2)
				: state.candidates.length > 0
					? 1
					: 0;
	const progress = genericProgress(state);
	return {
		runId: state.runId,
		taskRunCount: state.taskRuns.length + 1,
		environment: state.routing.environment,
		horizon: state.routing.horizon,
		verificationPolicy: state.verificationPolicy,
		verificationClass: state.verificationClass,
		status: state.status,
		phase: {
			id: phases[active]!.id,
			title: phases[active]!.title,
			detail: stopGate.passed
				? "Every authoritative stop condition has passed."
				: `${state.cycles.length} cycles, ${progress.acceptedCandidates} accepted lineage nodes.`,
			progressPercent: Math.round((active / Math.max(1, phases.length - 1)) * 100),
		},
		phases: phases.map((phase, index) => ({ ...phase, status: phaseStatus(index, active, stopGate.passed) })),
		metrics: [
			{ label: "Iterations", value: state.cycles.length },
			{ label: "Accepted", value: progress.acceptedCandidates },
			{ label: "Rejected", value: progress.rejectedCandidates },
			{ label: "Revised", value: progress.revisedCandidates },
			{
				label: "Experiments",
				value: `${state.experiments.filter((experiment) => experiment.status === "completed").length}/${state.experiments.length}`,
			},
			{ label: "Trials", value: state.trials.length },
			{ label: "Authoritative evals", value: progress.authoritativeEvaluations },
			{
				label: "Verified memories",
				value: state.memories.filter((memory) => !memory.invalidatedAt && memory.verificationState === "verified")
					.length,
			},
			{
				label: "Spontaneous recalls",
				value: state.memoryRecalls.filter((recall) => recall.channel === "spontaneous").length,
			},
		],
		sections: [
			{
				id: "routing",
				title: "Routing",
				items: [
					{ label: "Automatic adapter", value: state.routing.environment, status: "neutral" },
					{ label: "Horizon", value: state.routing.horizon, status: "neutral" },
					{ label: "Verification", value: state.verificationPolicy, status: "neutral" },
					{ label: "Verification class", value: state.verificationClass, status: "neutral" },
					{ label: "Decision", value: state.routing.reasons.join("; "), status: "neutral" },
				],
			},
			{
				id: "trajectory",
				title: "Trajectory",
				items: [
					{ label: "Open candidates", value: String(progress.openCandidates), status: "neutral" },
					{
						label: "Latest checkpoint",
						value: state.checkpoints.at(-1)?.reason ?? "No completed cycle yet",
						status: state.checkpoints.at(-1)?.status === "intervene" ? "fail" : "neutral",
					},
					{
						label: "Supervisor",
						value: state.supervisor?.name ?? "Not activated",
						status: state.routing.horizon === "long" && !state.supervisor ? "watch" : "neutral",
					},
				],
			},
			{
				id: "experiments",
				title: "Experiments",
				items: experimentDashboardItems(latestExperiment, latestExperimentTrials),
			},
			{
				id: "memory",
				title: "NOOA memory",
				items: [
					{
						label: "Cognitive records",
						value: JSON.stringify(
							state.memories
								.filter((memory) => !memory.invalidatedAt)
								.reduce<Record<string, number>>((counts, memory) => {
									counts[memory.type] = (counts[memory.type] ?? 0) + 1;
									return counts;
								}, {}),
						),
						status: "neutral",
					},
					{
						label: "Accepted cycles after recall",
						value: String(
							state.memoryRecalls.filter(
								(recall) => recall.memoryIds.length > 0 && recall.cycleOutcome === "accepted",
							).length,
						),
						status: "neutral",
					},
					{
						label: "Contested or invalidated",
						value: String(
							state.memories.filter((memory) => memory.verificationState === "contested" || memory.invalidatedAt)
								.length,
						),
						status: state.memories.some((memory) => memory.verificationState === "contested")
							? "watch"
							: "neutral",
					},
				],
			},
		],
		stopGate,
	};
}

abstract class BaseAdapter implements AvoEnvironmentAdapter {
	abstract readonly id: AvoEnvironment;

	validateCandidate(candidate: AvoCandidate): void {
		if (!candidate.kind || !candidate.summary || !/^[a-f0-9]{64}$/.test(candidate.payloadDigest)) {
			throw new Error(`${this.id} candidate is incomplete`);
		}
	}

	deriveEvaluationState(_candidate: AvoCandidate, receipts: readonly AvoEvaluationReceipt[], _state: AvoRunState) {
		const derived = deriveAvoEvaluation(receipts);
		return { status: derived.status, canonical: derived.canonical, reasons: derived.reasons };
	}

	deriveProgressSignals(state: AvoRunState): AvoProgressSignals {
		return genericProgress(state);
	}

	buildSupervisorContext(state: AvoRunState): Record<string, unknown> {
		return {
			run_id: state.runId,
			objective: state.objective,
			environment: state.routing.environment,
			horizon: state.routing.horizon,
			recent_cycles: state.cycles.slice(-8),
			recent_evaluations: state.evaluations.slice(-16),
			latest_checkpoint: state.checkpoints.at(-1),
			experiments: state.experiments.slice(-8),
			trials: state.trials.slice(-16),
			memory_summary: state.memories
				.filter((memory) => !memory.invalidatedAt)
				.slice(-12)
				.map((memory) => ({
					namespace: memory.namespace,
					type: memory.type,
					scope: memory.scope,
					verification: memory.verificationState,
					owner: memory.owner,
					title: memory.title,
				})),
		};
	}

	private canonicalAcceptedCycle(state: AvoRunState): AvoRunState["cycles"][number] | undefined {
		const acceptedCandidateIds = new Set(
			state.cycles.filter((cycle) => cycle.outcome === "accepted").map((cycle) => cycle.candidateId),
		);
		const candidate = [...state.candidates].reverse().find(
			(item) =>
				acceptedCandidateIds.has(item.candidateId) &&
				this.deriveEvaluationState(
					item,
					state.evaluations.filter((receipt) => receipt.candidateId === item.candidateId),
					state,
				).canonical,
		);
		if (!candidate) return undefined;
		return [...state.cycles]
			.reverse()
			.find((cycle) => cycle.outcome === "accepted" && cycle.candidateId === candidate.candidateId);
	}

	protected finalizeStopCondition(state: AvoRunState, gate: AvoStopGate): AvoStopGate {
		const canonicalCycle = this.canonicalAcceptedCycle(state);
		const acceptedCycleCheck = {
			id: "accepted_cycle",
			label: "Accepted candidate cycle",
			passed: canonicalCycle !== undefined,
			reason: canonicalCycle ? undefined : "no accepted cycle currently satisfies the verification contract",
		};
		const checks = [...gate.checks.filter((check) => check.id !== acceptedCycleCheck.id), acceptedCycleCheck];
		const reasons = checks.flatMap((check) => (!check.passed && check.reason ? [check.reason] : []));
		return requireTrajectoryVerification(state, { passed: reasons.length === 0, checks, reasons }, canonicalCycle);
	}

	evaluateStopCondition(state: AvoRunState): AvoStopGate {
		return this.finalizeStopCondition(state, evaluateGenericAvoStopGate(state.candidates, state.evaluations));
	}

	abstract dashboardProjection(state: AvoRunState): AvoDashboardProjection;
}

export class GeneralAvoAdapter extends BaseAdapter {
	readonly id = "general" as const;

	deriveEvaluationState(candidate: AvoCandidate, receipts: readonly AvoEvaluationReceipt[], state: AvoRunState) {
		const authoritative = super.deriveEvaluationState(candidate, receipts, state);
		if (authoritative.status === "fail" || authoritative.status === "revise") return authoritative;
		const policy = state.verificationPolicy;
		const claims = candidate.claims ?? [];
		const hasExternalReceipt = receipts.some((receipt) => receipt.authority === "external");
		if (policy === "required" && state.verificationClass === "external_factual" && claims.length === 0) {
			return {
				status: "inconclusive" as const,
				canonical: false,
				reasons: ["required external factual verification needs explicit candidate claims"],
			};
		}
		if (claims.length > 0 || hasExternalReceipt) {
			if (claims.length === 0) {
				return {
					status: "inconclusive" as const,
					canonical: false,
					reasons: ["external verification requires explicit candidate claims"],
				};
			}
			const supportedClaimIds = new Set(
				receipts.flatMap((receipt) =>
					receipt.issuedBy === "host" &&
					receipt.authority === "external" &&
					receipt.evaluatorId === "external_claim" &&
					receipt.status === "pass" &&
					receipt.metrics.semantic_relation === "supports" &&
					receipt.metrics.independent_relation === "supports" &&
					receipt.metrics.semantic_verifier === "host_bound_exact_claim_independent_rlm_v2" &&
					receipt.metrics.candidate_payload_digest === candidate.payloadDigest &&
					typeof receipt.metrics.claim_id === "string"
						? [receipt.metrics.claim_id]
						: [],
				),
			);
			const unsupported = claims.filter((claim) => !supportedClaimIds.has(claim.claimId));
			if (unsupported.length > 0) {
				return {
					status: "inconclusive" as const,
					canonical: false,
					reasons: [
						`candidate claims lack host-verified semantic support: ${unsupported.map((claim) => claim.claimId).join(", ")}`,
					],
				};
			}
		}
		if (policy === "required" && state.verificationClass === "deterministic_local") {
			const deterministic = receipts.some(
				(receipt) =>
					receipt.issuedBy === "host" &&
					receipt.evaluatorId === "deterministic_result" &&
					receipt.status === "pass" &&
					receipt.metrics.meaningful === true &&
					receipt.metrics.candidate_result_matches_objective === true &&
					receipt.metrics.candidate_payload_digest === candidate.payloadDigest,
			);
			if (!deterministic) {
				return {
					status: "inconclusive" as const,
					canonical: false,
					reasons: ["deterministic verification requires a successful host-observed local calculation"],
				};
			}
		}
		if (policy === "required" && state.verificationClass === "artifact") {
			const artifactVerified = receipts.some(
				(receipt) =>
					receipt.issuedBy === "host" &&
					receipt.evaluatorId === "artifact_binding" &&
					receipt.status === "pass" &&
					receipt.metrics.meaningful === true &&
					receipt.metrics.artifact_candidate_binding === true &&
					receipt.metrics.artifact_target_digest === candidate.artifactTargetDigest &&
					receipt.metrics.candidate_payload_digest === candidate.payloadDigest,
			);
			if (!artifactVerified) {
				return {
					status: "inconclusive" as const,
					canonical: false,
					reasons: ["artifact verification requires a successful host-observed artifact check"],
				};
			}
		}
		if (authoritative.status !== "inconclusive" || authoritative.canonical) return authoritative;
		if (policy === "required") return authoritative;
		const opinions = receipts.filter((receipt) => receipt.authority === "model_opinion");
		if (opinions.some((receipt) => receipt.status === "fail" || receipt.status === "revise")) {
			return {
				status: "revise" as const,
				canonical: false,
				reasons: [`${policy} evaluation found unresolved subjective issues`],
			};
		}
		if (opinions.some((receipt) => receipt.status === "pass")) {
			return {
				status: "pass" as const,
				canonical: true,
				reasons: [`accepted under the declared ${policy} verification policy`],
			};
		}
		return authoritative;
	}

	evaluateStopCondition(state: AvoRunState): AvoStopGate {
		if (state.verificationPolicy === "required") return super.evaluateStopCondition(state);
		const accepted = [...state.candidates].reverse().find(
			(candidate) =>
				this.deriveEvaluationState(
					candidate,
					state.evaluations.filter((receipt) => receipt.candidateId === candidate.candidateId),
					state,
				).canonical,
		);
		const hasEvaluation = state.evaluations.some((receipt) => receipt.status !== "inconclusive");
		const checks = [
			{
				id: "verification_policy",
				label: "Declared verification policy",
				passed: true,
			},
			{
				id: "candidate",
				label: "Candidate recorded",
				passed: state.candidates.length > 0,
				reason: state.candidates.length > 0 ? undefined : "no candidate or action has been recorded",
			},
			{
				id: "policy_evaluation",
				label: state.verificationPolicy === "not_applicable" ? "Subjective quality review" : "Best-effort review",
				passed: hasEvaluation,
				reason: hasEvaluation ? undefined : "no transparent policy-appropriate evaluation has been recorded",
			},
			{
				id: "accepted_lineage",
				label: "Policy-accepted lineage",
				passed: accepted !== undefined,
				reason: accepted ? undefined : "no candidate passed the declared verification policy",
			},
		];
		const reasons = checks.flatMap((check) => (!check.passed && check.reason ? [check.reason] : []));
		return this.finalizeStopCondition(state, { passed: reasons.length === 0, checks, reasons });
	}

	buildSupervisorContext(state: AvoRunState): Record<string, unknown> {
		return {
			...super.buildSupervisorContext(state),
			general_feedback: {
				recent_actions: state.candidates.slice(-8),
				external_evidence: state.evaluations
					.filter((receipt) => receipt.authority === "external" || receipt.authority === "host")
					.slice(-12),
				open_blockers: state.cycles
					.filter((cycle) => cycle.outcome !== "accepted")
					.slice(-8)
					.map((cycle) => cycle.failureSignature ?? `${cycle.candidateId}: ${cycle.outcome}`),
			},
		};
	}

	dashboardProjection(state: AvoRunState): AvoDashboardProjection {
		const projection = genericProjection(state, this.evaluateStopCondition(state), [
			{ id: "observe", title: "Observe", short: "Objective and available evidence" },
			{ id: "candidate", title: "Candidate", short: "Answer, plan, action, or artifact" },
			{ id: "evaluate", title: "Evaluate", short: "Host, external, or evidence feedback" },
			{ id: "final_gate", title: "Final gate", short: "Authority-backed completion" },
		]);
		const latestExternal = [...state.evaluations]
			.reverse()
			.find((receipt) => receipt.authority === "external" || receipt.authority === "host");
		projection.sections.push({
			id: "general_evidence",
			title: "Actions and external evidence",
			items: [
				{
					label: "Verification policy",
					value: `${state.verificationClass} · ${state.verificationPolicy} · ${state.verificationReasons.join("; ")}`,
					status: state.verificationPolicy === "required" ? "neutral" : "watch",
				},
				{
					label: "Latest action",
					value: state.candidates.at(-1)?.summary ?? "No action candidate yet",
					status: "neutral",
				},
				{
					label: "Latest external check",
					value: latestExternal
						? `${latestExternal.evaluatorId}: ${latestExternal.status}`
						: "No external receipt yet",
					status: latestExternal?.status === "pass" ? "ok" : latestExternal?.status === "fail" ? "fail" : "watch",
				},
				{
					label: "Open blocker",
					value:
						[...state.cycles].reverse().find((cycle) => cycle.outcome !== "accepted")?.failureSignature ??
						"No recorded blocker",
					status: "neutral",
				},
			],
		});
		return projection;
	}
}

export class CodingAvoAdapter extends BaseAdapter {
	readonly id = "coding" as const;

	buildSupervisorContext(state: AvoRunState): Record<string, unknown> {
		return {
			...super.buildSupervisorContext(state),
			coding_feedback: {
				recent_candidates: state.candidates.slice(-8),
				executable_receipts: state.evaluations
					.filter((receipt) =>
						["test", "build", "lint", "benchmark", "runtime", "filesystem", "git"].includes(receipt.evaluatorId),
					)
					.slice(-16),
				latest_failure: [...state.cycles].reverse().find((cycle) => cycle.failureSignature)?.failureSignature,
			},
		};
	}

	validateCandidate(candidate: AvoCandidate): void {
		super.validateCandidate(candidate);
		if (!(CODING_AVO_CANDIDATE_KINDS as readonly string[]).includes(candidate.kind)) {
			throw new Error("coding candidates must be a patch, implementation, configuration, diagnosis, or artifact");
		}
	}

	deriveEvaluationState(candidate: AvoCandidate, receipts: readonly AvoEvaluationReceipt[], state: AvoRunState) {
		const derived = super.deriveEvaluationState(candidate, receipts, state);
		if (derived.status === "fail" || derived.status === "revise") return derived;
		const allowedEvaluators = CODING_EVALUATION_CONTRACTS[candidate.kind as keyof typeof CODING_EVALUATION_CONTRACTS];
		const executable = receipts.filter(
			(receipt) =>
				isAuthoritativeAvoEvaluation(receipt) &&
				allowedEvaluators?.includes(receipt.evaluatorId) === true &&
				receipt.metrics.meaningful === true &&
				receipt.metrics.workspace_matches_candidate === true &&
				receipt.metrics.candidate_payload_digest === candidate.payloadDigest,
		);
		if (executable.length === 0) {
			return {
				status: "inconclusive" as const,
				canonical: false,
				reasons: [
					`${candidate.kind} candidates require a meaningful ${allowedEvaluators?.join(" or ") ?? "kind-specific"} receipt bound to the exact candidate workspace`,
				],
			};
		}
		const mutationKind = ["patch", "implementation", "configuration", "artifact"].includes(candidate.kind);
		const preCandidateWorkspaceDigest =
			state.verificationBaseline?.executions.at(-1)?.postWorkspaceDigest ??
			state.verificationBaseline?.workspaceDigest;
		const workspaceChanged = candidate.workspaceDigest !== preCandidateWorkspaceDigest;
		if (mutationKind && !workspaceChanged) {
			return {
				status: "inconclusive" as const,
				canonical: false,
				reasons: [`${candidate.kind} candidates must contain a host-observed workspace change`],
			};
		}
		const baselineRequired =
			(mutationKind || workspaceChanged) &&
			((state.verificationBaseline?.testFiles.length ?? 0) > 0 ||
				(state.verificationBaseline?.userAcceptanceCommands.length ?? 0) > 0);
		if (
			baselineRequired &&
			!executable.some(
				(receipt) => receipt.evaluatorId === "test" && receipt.metrics.baseline_execution_matched === true,
			)
		) {
			return {
				status: "inconclusive" as const,
				canonical: false,
				reasons: [
					"coding progress requires the same proven pre-candidate baseline test contract to pass afterward",
				],
			};
		}
		return derived;
	}

	evaluateStopCondition(state: AvoRunState): AvoStopGate {
		const generic = super.evaluateStopCondition(state);
		const accepted = [...state.candidates].reverse().find((candidate) => {
			const receipts = state.evaluations.filter((receipt) => receipt.candidateId === candidate.candidateId);
			return this.deriveEvaluationState(candidate, receipts, state).canonical;
		});
		const executableCheck = {
			id: "executable_feedback",
			label: "Executable coding feedback",
			passed: accepted !== undefined,
			reason: accepted ? undefined : "no coding candidate has passed executable or host-verifiable evaluation",
		};
		const checks = [...generic.checks.filter((check) => check.id !== "accepted_lineage"), executableCheck];
		const reasons = checks.flatMap((check) => (!check.passed && check.reason ? [check.reason] : []));
		return { passed: reasons.length === 0, checks, reasons };
	}

	dashboardProjection(state: AvoRunState): AvoDashboardProjection {
		const projection = genericProjection(state, this.evaluateStopCondition(state), [
			{ id: "observe", title: "Inspect", short: "Repository and failure state" },
			{ id: "candidate", title: "Patch", short: "Candidate implementation" },
			{ id: "test", title: "Test", short: "Build, test, lint, runtime" },
			{ id: "benchmark", title: "Benchmark", short: "Regression and performance checks" },
			{ id: "supervision", title: "Supervisor", short: "Trajectory intervention when needed" },
			{ id: "final_gate", title: "Final gate", short: "Executable feedback passed" },
		]);
		const executable = state.evaluations.filter((receipt) =>
			["test", "build", "lint", "benchmark", "runtime", "filesystem", "git", "experiment_trial"].includes(
				receipt.evaluatorId,
			),
		);
		const item = (evaluatorIds: readonly string[]) =>
			[...executable].reverse().find((receipt) => evaluatorIds.includes(receipt.evaluatorId));
		const receiptItem = (label: string, ...evaluatorIds: string[]) => {
			const receipt = item(evaluatorIds);
			return {
				label,
				value: receipt ? `${receipt.status} · ${JSON.stringify(receipt.metrics)}` : "No receipt yet",
				status:
					receipt?.status === "pass"
						? ("ok" as const)
						: receipt?.status === "fail"
							? ("fail" as const)
							: ("watch" as const),
			};
		};
		projection.sections.push({
			id: "coding_feedback",
			title: "Executable feedback",
			items: [
				receiptItem("Latest tests", "test"),
				receiptItem("Latest build", "build"),
				receiptItem("Latest lint", "lint"),
				receiptItem("Latest benchmark", "benchmark", "experiment_trial"),
				{
					label: "Current failure",
					value:
						[...state.cycles].reverse().find((cycle) => cycle.failureSignature)?.failureSignature ??
						"No recorded failure",
					status: "neutral",
				},
			],
		});
		return projection;
	}
}

function researchStopGate(adapterState?: ResearchAdapterState): AvoStopGate | undefined {
	if (!adapterState) return undefined;
	const checks = Object.entries(adapterState.stopGate.checks).map(([id, passed]) => ({
		id,
		label: id.replaceAll(/([A-Z])/g, " $1").replace(/^./, (value) => value.toUpperCase()),
		passed,
		reason: passed ? undefined : adapterState.stopGate.reasons.find((reason) => reason.length > 0),
	}));
	return { passed: adapterState.stopGate.passed, checks, reasons: [...adapterState.stopGate.reasons] };
}

export class ResearchAvoAdapter extends BaseAdapter implements AvoEnvironmentAdapter<ResearchAdapterState> {
	readonly id = "research" as const;

	deriveProgressSignals(state: AvoRunState, adapterState?: ResearchAdapterState): AvoProgressSignals {
		const progress = genericProgress(state);
		if (!adapterState) return progress;
		return {
			...progress,
			acceptedCandidates: adapterState.state.cycles.filter((cycle) => cycle.outcome === "promoted").length,
			rejectedCandidates: adapterState.state.cycles.filter(
				(cycle) => cycle.outcome === "rejected" || cycle.outcome === "experiment_failed",
			).length,
			revisedCandidates: adapterState.state.cycles.filter((cycle) => cycle.outcome === "revised").length,
		};
	}

	buildSupervisorContext(state: AvoRunState, adapterState?: ResearchAdapterState): Record<string, unknown> {
		return {
			...super.buildSupervisorContext(state),
			research: adapterState
				? {
						publications: adapterState.state.publications.length,
						claims: adapterState.state.claims.length,
						experiments: adapterState.state.experiments.slice(-10),
						latest_cycles: adapterState.state.cycles.slice(-5),
						stop_gate: adapterState.stopGate,
					}
				: undefined,
		};
	}

	evaluateStopCondition(state: AvoRunState, adapterState?: ResearchAdapterState): AvoStopGate {
		const research = researchStopGate(adapterState);
		return research ? this.finalizeStopCondition(state, research) : super.evaluateStopCondition(state);
	}

	dashboardProjection(state: AvoRunState, adapterState?: ResearchAdapterState): AvoDashboardProjection {
		const stopGate = this.evaluateStopCondition(state, adapterState);
		const projection = genericProjection(state, stopGate, [
			{ id: "setup", title: "Initialize", short: "Objective and retained supervisor" },
			{ id: "literature", title: "Evidence map", short: "Publications, claims, field map" },
			{ id: "candidate", title: "Candidate", short: "Problem and prior-art attack" },
			{ id: "review", title: "Four reviewers", short: "Independent hostile review" },
			{ id: "experiment", title: "Experiment", short: "Falsifier and preliminary evidence" },
			{ id: "supervision", title: "Supervisor", short: "Trajectory checkpoint" },
			{ id: "final_gate", title: "Final gate", short: "Publication-grade stop condition" },
		]);
		if (!adapterState) return projection;
		projection.metrics = [
			{ label: "Publications", value: adapterState.state.publications.length },
			{
				label: "Verified",
				value: new Set(adapterState.state.publicationVerifications.map((item) => item.paperId)).size,
			},
			{ label: "Claims", value: adapterState.state.claims.length },
			{ label: "Cycles", value: adapterState.state.cycles.length },
			{ label: "Experiments", value: adapterState.state.experiments.length },
			{ label: "Memories", value: adapterState.state.memories.filter((item) => !item.invalidatedAt).length },
		];
		return projection;
	}
}

export class AvoAdapterRegistry {
	private readonly adapters = new Map<AvoEnvironment, AvoEnvironmentAdapter>();

	constructor(
		adapters: readonly AvoEnvironmentAdapter[] = [
			new GeneralAvoAdapter(),
			new CodingAvoAdapter(),
			new ResearchAvoAdapter(),
		],
	) {
		for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
	}

	get(environment: AvoEnvironment): AvoEnvironmentAdapter {
		const adapter = this.adapters.get(environment);
		if (!adapter) throw new Error(`AVO environment adapter ${environment} is not registered`);
		return adapter;
	}
}
