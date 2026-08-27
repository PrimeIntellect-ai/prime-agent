import { dirname, join } from "node:path";
import { getBundledSkillsDir } from "../../config.js";
import type { AutoresearchState, AutoresearchStopGate } from "../autoresearch.js";
import { AvoAdapterRegistry, CODING_AVO_CANDIDATE_KINDS, type ResearchAdapterState } from "./adapters.js";
import { AvoNooaMemoryBridge, type AvoNooaRunner } from "./memory.js";
import { AvoStore } from "./store.js";
import { shouldActivateAvoSupervisor } from "./supervisor.js";
import type {
	AvoCandidateInput,
	AvoDashboardProjection,
	AvoEnvironmentSelection,
	AvoEvaluationInput,
	AvoHorizonSelection,
	AvoMemory,
	AvoMemoryReflection,
	AvoRunState,
} from "./types.js";

export class AvoSessionRuntime {
	readonly store: AvoStore;
	readonly adapters: AvoAdapterRegistry;
	readonly memoryBridge?: AvoNooaMemoryBridge;

	constructor(
		artifactDir?: string,
		runId?: string,
		now?: () => string,
		cwd = process.cwd(),
		agentDir?: string,
		memoryRunner?: AvoNooaRunner,
	) {
		this.store = new AvoStore(artifactDir, runId, now, cwd, agentDir ? join(agentDir, "memory") : undefined);
		this.adapters = new AvoAdapterRegistry();
		const backend = this.store.getMemoryBackendConfig();
		if (Object.values(backend.paths).some((path) => path !== undefined)) {
			this.memoryBridge = new AvoNooaMemoryBridge(
				backend,
				join(getBundledSkillsDir(), "avo", "src", "avo", "nooa_sidecar.py"),
				memoryRunner,
			);
		}
	}

	private memoryCue(prompt: string): string {
		const state = this.store.getState();
		const latestCandidate = state.candidates.at(-1);
		const latestFailure = [...state.cycles].reverse().find((cycle) => cycle.failureSignature)?.failureSignature;
		return [
			prompt,
			state.objective ? `Objective: ${state.objective}` : undefined,
			`Environment: ${state.routing.environment}`,
			latestCandidate ? `Latest candidate: ${latestCandidate.summary}` : undefined,
			latestFailure ? `Latest failure: ${latestFailure}` : undefined,
		]
			.filter((item): item is string => item !== undefined)
			.join("\n");
	}

	private memoryNamespaces(): AvoMemory["namespace"][] {
		const environment = this.store.getState().routing.environment;
		return environment === "general" ? ["shared", "general"] : ["shared", environment];
	}

	async recallMemory(
		query: string,
		options: { limit?: number; maxChars?: number; spontaneous?: boolean } = {},
	): Promise<{
		memories: AvoMemory[];
		context: string;
		backend: "nooa-memory" | "host-fallback";
		reason?: string;
	}> {
		const limit = options.limit ?? (options.spontaneous ? 5 : 8);
		const maxChars = options.maxChars ?? 2_000;
		const cue = options.spontaneous ? this.memoryCue(query) : query;
		const state = this.store.getState();
		const allowed = new Set(this.memoryNamespaces());
		const eligible = state.memories.filter(
			(memory) =>
				allowed.has(memory.namespace) &&
				!memory.invalidatedAt &&
				memory.verificationState !== "contested" &&
				(memory.owner === "" || memory.owner.startsWith("prime-root@")) &&
				(memory.owner !== "" || memory.verificationState === "verified") &&
				(memory.scope !== "task" || memory.taskRunId === state.runId),
		);
		const nooa = this.memoryBridge
			? await this.memoryBridge.spontaneousRecall(this.store.memoryRecordsForSync(), cue, limit, maxChars)
			: { ok: false as const, memoryIds: [], backend: "host-fallback" as const, reason: "NOOA bridge unavailable" };
		const byId = new Map(eligible.map((memory) => [memory.memoryId, memory]));
		const recalled: AvoMemory[] = [];
		for (const memoryId of nooa.memoryIds) {
			const memory = byId.get(memoryId);
			if (memory && !recalled.some((item) => item.memoryId === memoryId)) recalled.push(memory);
		}
		if (recalled.length < limit) {
			for (const memory of this.store.recall(cue, this.memoryNamespaces(), limit)) {
				if (!recalled.some((item) => item.memoryId === memory.memoryId)) recalled.push(memory);
				if (recalled.length >= limit) break;
			}
		}
		const context = this.store.formatMemoryContext(recalled, maxChars);
		this.store.recordMemoryRecall(
			cue,
			recalled.map((memory) => memory.memoryId),
			options.spontaneous ? "spontaneous" : "deliberate",
			context.length,
		);
		return {
			memories: recalled,
			context,
			backend: nooa.ok ? "nooa-memory" : "host-fallback",
			reason: nooa.reason,
		};
	}

	async reflectMemory(trigger: AvoMemoryReflection["trigger"], cycleId?: string): Promise<Record<string, unknown>> {
		if (!this.memoryBridge) return { ok: false, reason: "NOOA bridge unavailable" };
		const result = await this.memoryBridge.reflect(this.store.memoryRecordsForSync(), trigger);
		if (result.ok !== true) return result;
		const report =
			typeof result.report === "object" && result.report !== null && !Array.isArray(result.report)
				? Object.fromEntries(
						Object.entries(result.report).filter((entry): entry is [string, number | string | boolean] =>
							["number", "string", "boolean"].includes(typeof entry[1]),
						),
					)
				: {};
		const archivedMemoryIds = Array.isArray(result.archived_memory_ids)
			? result.archived_memory_ids.filter((memoryId): memoryId is string => typeof memoryId === "string")
			: [];
		const reflection = this.store.recordMemoryReflection({ trigger, cycleId, report, archivedMemoryIds });
		return { ...result, reflection };
	}

	async reconciliationCandidates() {
		return (await this.memoryBridge?.reconciliationCandidates(this.store.memoryRecordsForSync())) ?? [];
	}

	getState(): AvoRunState {
		return this.store.getState();
	}

	observeRootPrompt(prompt: string): AvoRunState {
		const state = this.store.getState();
		if (!state.objective) return this.store.initialize(prompt, prompt);
		if (state.status !== "active") return this.store.startTask(prompt, prompt);
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
		if (this.store.getState().routing.environment === "coding") {
			if (!(CODING_AVO_CANDIDATE_KINDS as readonly string[]).includes(input.kind)) {
				throw new Error("coding candidates must be a patch, implementation, configuration, diagnosis, or artifact");
			}
			if (!input.workspaceDigest || !input.workspaceMode) {
				throw new Error("coding candidates require a host-observed workspace digest");
			}
		}
		const candidate = this.store.recordCandidate(input);
		this.adapters.get(this.store.getState().routing.environment).validateCandidate(candidate, this.store.getState());
		return candidate;
	}

	recordEvaluation(input: AvoEvaluationInput) {
		return this.store.recordEvaluation(input, "model");
	}

	recordHostEvaluation(input: AvoEvaluationInput) {
		return this.store.recordEvaluation(input, "host");
	}

	completeCycle(input: Parameters<AvoStore["completeCycle"]>[0]) {
		const adapter = this.adapters.get(this.store.getState().routing.environment);
		const result = this.store.completeCycle(input, (candidate, receipts) =>
			adapter.deriveEvaluationState(candidate, receipts, this.store.getState()),
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
		return this.store.complete(gate);
	}

	syncResearchState(
		autoresearchState: AutoresearchState,
		stopGate: AutoresearchStopGate,
		autoresearchStatePath?: string,
	): ResearchAdapterState {
		const current = this.store.getState();
		if (current.routing.environment !== "research") {
			throw new Error("autoresearch is only available when the host routed the active task to research");
		}
		if (this.store.getState().horizonSelection !== "long") this.store.setHorizon("long", "model");
		if (!this.store.getState().objective && autoresearchState.objective) {
			this.store.initialize(autoresearchState.objective, autoresearchState.objective);
		}
		if (autoresearchStatePath) {
			this.store.setAdapterStateRef({
				adapterId: "research",
				statePath: autoresearchStatePath,
				schemaVersion: autoresearchState.schemaVersion,
				updatedAt: autoresearchState.updatedAt,
			});
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
			if (
				!this.store
					.getState()
					.evaluations.some((item) => item.evaluationId === evaluationId && item.issuedBy === "host")
			) {
				this.store.recordEvaluation(
					{
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
					},
					"host",
				);
			}
			for (const reviewer of cycle.reviewers) {
				const reviewerEvaluationId = `research-review:${cycle.cycleId}:${reviewer.role}`;
				if (
					this.store
						.getState()
						.evaluations.some((item) => item.evaluationId === reviewerEvaluationId && item.issuedBy === "host")
				)
					continue;
				this.store.recordEvaluation(
					{
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
					},
					"host",
				);
				const reviewerMemoryId = `reflection:review:${cycle.cycleId}:${reviewer.role}`;
				if (!this.store.getState().memories.some((memory) => memory.memoryId === reviewerMemoryId)) {
					this.store.rememberProposedForRole(
						{
							memoryId: reviewerMemoryId,
							namespace: "research",
							type: "reflection",
							scope: "project",
							title: `${reviewer.role}: ${reviewer.verdict}`,
							content: [
								reviewer.summary,
								...reviewer.objections.map((objection) => `Objection: ${objection}`),
							].join("\n"),
							tags: ["reviewer", reviewer.role, reviewer.verdict],
							importance: reviewer.verdict === "pass" ? 4 : 7,
							sourceIds: [reviewerEvaluationId],
							references: [
								{ kind: "candidate", key: cycle.candidate.candidateId },
								{ kind: "evaluation", key: reviewerEvaluationId },
							],
						},
						reviewer.role.replaceAll("_", "-"),
					);
				}
			}
			for (const experimentId of cycle.preliminaryEvidenceExperimentIds) {
				const experiment = autoresearchState.experiments.find((item) => item.experimentId === experimentId);
				if (!experiment) continue;
				const experimentEvaluationId = `research-experiment:${experimentId}`;
				if (
					this.store
						.getState()
						.evaluations.some((item) => item.evaluationId === experimentEvaluationId && item.issuedBy === "host")
				)
					continue;
				this.store.recordEvaluation(
					{
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
					},
					"host",
				);
				const experimentMemoryId = `episode:experiment:${experimentId}`;
				if (!this.store.getState().memories.some((memory) => memory.memoryId === experimentMemoryId)) {
					this.store.rememberVerified({
						memoryId: experimentMemoryId,
						namespace: "research",
						type: "episode",
						scope: "project",
						title: `Experiment ${experimentId}: ${experiment.status}`,
						content: [
							`Hypothesis: ${experiment.hypothesis}`,
							`Design: ${experiment.design}`,
							`Status: ${experiment.status}`,
							`Results: ${experiment.results ?? "not reported"}`,
							`Interpretation: ${experiment.interpretation ?? "not reported"}`,
							`Metrics: ${JSON.stringify(experiment.metrics)}`,
						].join("\n"),
						tags: ["experiment", experiment.status],
						importance: experiment.status === "completed" ? 8 : 5,
						sourceIds: [experimentId, experimentEvaluationId],
						references: [
							{ kind: "experiment", key: experimentId },
							{ kind: "evaluation", key: experimentEvaluationId },
						],
					});
				}
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

	dispose(): void {
		this.memoryBridge?.close();
	}
}

export function buildAvoRuntimePrompt(state: AvoRunState, memoryContext = ""): string {
	return [
		"AVO is Prime's default operating architecture for every root task. It is not a user-selected mode.",
		`Active AVO task run=${state.runId}. The host automatically selected evaluation adapter=${state.routing.environment}, horizon=${state.routing.horizon}, verification_class=${state.verificationClass}, and verification_policy=${state.verificationPolicy}.`,
		state.routing.reasons.length > 0 ? `Route evidence: ${state.routing.reasons.join("; ")}.` : undefined,
		state.verificationReasons.length > 0
			? `Verification policy evidence: ${state.verificationReasons.join("; ")}.`
			: undefined,
		"General, coding, and research are internal tool/evaluation adapters, not separate modes. Do not ask the user to choose one. Direct, iterative, and long only control how much AVO machinery is activated: direct uses one evaluated action without a retained supervisor; iterative retains candidate lineage and revises after feedback; long also activates namespaced memory, recovery, and retained trajectory supervision.",
		"Environment routing is host-authoritative. Model calls cannot select general, coding, or research and may only escalate the current horizon to iterative or long.",
		"Prime automatically recalls NOOA memory before root turns. Recalled proposed memories are hypotheses, verified memories are host-cleared, and live references are re-resolved at recall time. Never treat recall alone as task evidence or authority.",
		memoryContext || undefined,
		"Use the avo skill for the task's candidate/evaluation lifecycle. The host will automatically continue the root task instead of accepting an answer that skipped AVO, failed its gate, changed a verified workspace/artifact, or differs from the accepted candidate's canonical delivery. Callers may record only model_opinion. Required external_factual candidates must declare verbatim claims and bind each claim to a host-trusted external source record; after Serper IPython or Vertex Google Search, use avo.fetch_external_source on a result URL and avo.bind_url with a visible quote exactly equal to the claim. Provenance without a host-bound independent entailment verdict cannot pass. Required deterministic arithmetic uses a payload exactly shaped as {result: number} and avo.verify_deterministic_result; required artifact candidates declare artifact_paths and use avo.verify_artifacts. An unrelated successful command cannot certify either class. Before changing a coding workspace, use avo.run_coding_baseline with a direct command that explicitly names an unchanged baseline test file, then run the exact same command after the candidate with avo.run_evaluation. Mutable package-script wrappers, output-printed filenames, no-op mutation candidates, and candidate-created tests cannot certify progress. Never invent host, environment, or external authority. Required verification needs host-issued evidence; best_effort and not_applicable policies may use a transparent model-opinion review without pretending it is external. Complete the candidate cycle, then return only its canonical delivery: general payload text, deterministic numeric result, or coding/research summary, with no preface or suffix. A later root task starts a fresh task run after the current gate and delivery pass, while namespaced memory survives across runs.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}
