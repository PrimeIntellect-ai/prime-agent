import { dirname, join } from "node:path";
import type { AutoresearchState, AutoresearchStopGate } from "../autoresearch.js";
import { AvoAdapterRegistry, CODING_AVO_CANDIDATE_KINDS, type ResearchAdapterState } from "./adapters.js";
import { AvoStore } from "./store.js";
import { shouldActivateAvoSupervisor } from "./supervisor.js";
import type {
	AvoCandidateInput,
	AvoDashboardProjection,
	AvoEnvironmentSelection,
	AvoEvaluationInput,
	AvoHorizonSelection,
	AvoRunState,
} from "./types.js";

export class AvoSessionRuntime {
	readonly store: AvoStore;
	readonly adapters: AvoAdapterRegistry;

	constructor(artifactDir?: string, runId?: string, now?: () => string, cwd = process.cwd()) {
		this.store = new AvoStore(artifactDir, runId, now, cwd);
		this.adapters = new AvoAdapterRegistry();
	}

	getState(): AvoRunState {
		return this.store.getState();
	}

	observeRootPrompt(prompt: string): AvoRunState {
		const state = this.store.getState();
		if (!state.objective) return this.store.initialize(prompt, prompt);
		this.store.routePrompt(prompt);
		return this.store.getState();
	}

	configure(input: {
		environment?: AvoEnvironmentSelection;
		horizon?: AvoHorizonSelection;
		source: "model" | "user";
	}): AvoRunState {
		if (input.environment !== undefined) this.store.setEnvironment(input.environment, input.source);
		if (input.horizon !== undefined) this.store.setHorizon(input.horizon, input.source);
		return this.store.getState();
	}

	recordCandidate(input: AvoCandidateInput) {
		if (
			this.store.getState().routing.environment === "coding" &&
			!(CODING_AVO_CANDIDATE_KINDS as readonly string[]).includes(input.kind)
		) {
			throw new Error("coding candidates must be a patch, implementation, configuration, diagnosis, or artifact");
		}
		const candidate = this.store.recordCandidate(input);
		this.adapters.get(this.store.getState().routing.environment).validateCandidate(candidate, this.store.getState());
		return candidate;
	}

	recordEvaluation(input: AvoEvaluationInput) {
		return this.store.recordEvaluation(input);
	}

	completeCycle(input: Parameters<AvoStore["completeCycle"]>[0]) {
		const adapter = this.adapters.get(this.store.getState().routing.environment);
		const result = this.store.completeCycle(input, (candidate, receipts) =>
			adapter.deriveEvaluationState(candidate, receipts),
		);
		return {
			...result,
			activateSupervisor: shouldActivateAvoSupervisor(this.store.getState(), result.checkpoint),
		};
	}

	evaluateStopGate() {
		const state = this.store.getState();
		return this.adapters.get(state.routing.environment).evaluateStopCondition(state);
	}

	complete(): AvoRunState {
		const gate = this.evaluateStopGate();
		if (!gate.passed) throw new Error(`AVO completion is blocked: ${gate.reasons.join("; ")}`);
		return this.store.complete();
	}

	syncResearchState(
		autoresearchState: AutoresearchState,
		stopGate: AutoresearchStopGate,
		autoresearchStatePath?: string,
	): ResearchAdapterState {
		const current = this.store.getState();
		if (current.environmentSelection !== "research") this.store.setEnvironment("research", "model");
		if (this.store.getState().horizonSelection !== "long") this.store.setHorizon("long", "model");
		if (!this.store.getState().objective && autoresearchState.objective) {
			this.store.initialize(autoresearchState.objective, autoresearchState.objective);
		}
		for (const cycle of autoresearchState.cycles) {
			const state = this.store.getState();
			const cycleExists = state.cycles.some((item) => item.candidateId === cycle.candidate.candidateId);
			if (!state.candidates.some((item) => item.candidateId === cycle.candidate.candidateId)) {
				this.store.recordCandidate({
					candidateId: cycle.candidate.candidateId,
					kind: "research_problem",
					summary: cycle.candidate.statement,
					payload: cycle.candidate,
				});
			}
			const evaluationId = `research-cycle:${cycle.cycleId}`;
			if (!this.store.getState().evaluations.some((item) => item.evaluationId === evaluationId)) {
				this.store.recordEvaluation({
					evaluationId,
					candidateId: cycle.candidate.candidateId,
					evaluatorId: "research_adapter",
					status:
						cycle.outcome === "promoted"
							? "pass"
							: cycle.outcome === "revised" || cycle.outcome === "survived"
								? "revise"
								: "fail",
					authority: "host",
					evidenceRefs: [
						`autoresearch:cycle:${cycle.cycleId}`,
						...cycle.searchReceiptIds.map((receiptId) => `autoresearch:search:${receiptId}`),
					],
					metrics: {
						reviewer_count: cycle.reviewers.length,
						papers_added: cycle.papersAdded,
						field_map_changed: cycle.fieldMapChanged,
					},
				});
			}
			for (const reviewer of cycle.reviewers) {
				const reviewerEvaluationId = `research-review:${cycle.cycleId}:${reviewer.role}`;
				if (this.store.getState().evaluations.some((item) => item.evaluationId === reviewerEvaluationId)) continue;
				this.store.recordEvaluation({
					evaluationId: reviewerEvaluationId,
					candidateId: cycle.candidate.candidateId,
					evaluatorId: `reviewer_${reviewer.role}`,
					status: reviewer.verdict === "pass" ? "pass" : reviewer.verdict === "reject" ? "fail" : "revise",
					authority: "model_opinion",
					evidenceRefs: [
						`autoresearch:review:${cycle.cycleId}:${reviewer.role}`,
						...reviewer.evidenceBindings.map(
							(binding) => `publication:${binding.paperId}#${binding.exactPointer}`,
						),
					],
					metrics: {
						queries: reviewer.queries.length,
						inspected_papers: reviewer.inspectedPaperIds.length,
						evidence_bindings: reviewer.evidenceBindings.length,
						collisions: reviewer.collisionPaperIds.length,
					},
				});
			}
			for (const experimentId of cycle.preliminaryEvidenceExperimentIds) {
				const experiment = autoresearchState.experiments.find((item) => item.experimentId === experimentId);
				if (!experiment) continue;
				const experimentEvaluationId = `research-experiment:${experimentId}`;
				if (this.store.getState().evaluations.some((item) => item.evaluationId === experimentEvaluationId))
					continue;
				this.store.recordEvaluation({
					evaluationId: experimentEvaluationId,
					candidateId: cycle.candidate.candidateId,
					evaluatorId: "experiment",
					status:
						cycle.outcome === "promoted" && experiment.status === "completed"
							? "pass"
							: experiment.status === "failed"
								? "fail"
								: "inconclusive",
					authority: "host",
					evidenceRefs: [
						`autoresearch:experiment:${experimentId}`,
						...experiment.artifactReceipts.map((receipt) => `artifact:${receipt.sha256}:${receipt.path}`),
					],
					metrics: experiment.metrics,
				});
			}
			for (const claimId of cycle.canonicalPromotionIds) {
				this.store.recordAdapterProgress(`Research claim promoted: ${claimId}`, `autoresearch:claim:${claimId}`);
			}
			if (!cycleExists) {
				this.store.completeCycle({
					candidateId: cycle.candidate.candidateId,
					evaluationIds: [evaluationId],
					failureSignature: cycle.rejectionReason,
					trajectoryFingerprint: cycle.trajectoryFingerprint,
				});
			}
		}
		if (autoresearchStatePath) {
			this.store.setAdapterStateRef({
				adapterId: "research",
				statePath: autoresearchStatePath,
				schemaVersion: autoresearchState.schemaVersion,
				updatedAt: autoresearchState.updatedAt,
			});
		}
		return { state: structuredClone(autoresearchState), stopGate: structuredClone(stopGate) };
	}

	dashboardProjection(research?: ResearchAdapterState): AvoDashboardProjection {
		const state = this.store.getState();
		const adapter = this.adapters.get(state.routing.environment);
		return adapter.dashboardProjection(state, research);
	}

	researchStatePath(): string | undefined {
		const statePath = this.store.getStatePath();
		return statePath ? join(dirname(dirname(statePath)), "autoresearch", "state.json") : undefined;
	}
}

export function buildAvoRuntimePrompt(state: AvoRunState): string {
	return [
		"Prime uses one host-authoritative AVO substrate across general, coding, and research environments.",
		`Effective AVO route: environment=${state.routing.environment}; horizon=${state.routing.horizon}.`,
		state.routing.reasons.length > 0 ? `Route evidence: ${state.routing.reasons.join("; ")}.` : undefined,
		"Treat environment as the tool/evaluation adapter and horizon as the amount of machinery. Direct tasks use one evaluated action without a retained supervisor. Iterative tasks retain candidate lineage and revise after feedback. Long tasks activate persistent lineage, namespaced memory, recovery, and retained trajectory supervision.",
		"A model assertion that work succeeded is never canonical progress. Commit success only from evidence-backed host, environment, or external evaluation receipts. Use the avo skill for iterative or long candidate/evaluation cycles when it is available.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}
