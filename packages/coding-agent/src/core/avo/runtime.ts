import { dirname, join, resolve } from "node:path";
import { getBundledSkillsDir } from "../../config.js";
import type { AutoresearchState, AutoresearchStopGate } from "../autoresearch.js";
import { activeAvoAblations, isAvoFeatureAblated } from "./ablation.js";
import { AvoAdapterRegistry, CODING_AVO_CANDIDATE_KINDS, type ResearchAdapterState } from "./adapters.js";
import { digestAvoExperimentCandidateIdentity, digestAvoExperimentValue } from "./experiment.js";
import { assessAvoCandidateIntegrity } from "./integrity.js";
import { AvoNooaMemoryBridge, type AvoNooaRunner } from "./memory.js";
import { requiredAvoPremortemAssumptionCount } from "./obligations.js";
import { applyAvoSpecContractStopGate } from "./spec-contract.js";
import { AvoStore } from "./store.js";
import { shouldActivateAvoSupervisor } from "./supervisor.js";
import type {
	AvoAssumptionResolutionInput,
	AvoCandidateInput,
	AvoCriticalAssumptionInput,
	AvoDashboardProjection,
	AvoDeliveryState,
	AvoEnvironmentSelection,
	AvoEvaluationInput,
	AvoExperimentInput,
	AvoHorizonSelection,
	AvoMemory,
	AvoMemoryReflection,
	AvoObligationCoverageInput,
	AvoObligationInput,
	AvoRunState,
	AvoStopGate,
	AvoTrialInput,
} from "./types.js";

export class AvoSessionRuntime {
	readonly store: AvoStore;
	readonly adapters: AvoAdapterRegistry;
	readonly memoryBridge?: AvoNooaMemoryBridge;
	private readonly workspaceCwd: string;
	private readonly workspaceExcludedRoots: string[];

	constructor(
		artifactDir?: string,
		runId?: string,
		now?: () => string,
		cwd = process.cwd(),
		agentDir?: string,
		memoryRunner?: AvoNooaRunner,
		workspaceExcludedRoots?: readonly string[],
	) {
		this.workspaceCwd = resolve(cwd);
		this.workspaceExcludedRoots = (workspaceExcludedRoots ?? (artifactDir ? [artifactDir] : [])).map((path) =>
			resolve(path),
		);
		this.store = new AvoStore(artifactDir, runId, now, cwd, agentDir ? join(agentDir, "memory") : undefined);
		this.adapters = new AvoAdapterRegistry();
		const backend = this.store.getMemoryBackendConfig();
		if (!isAvoFeatureAblated("nooa") && Object.values(backend.paths).some((path) => path !== undefined)) {
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
		options: {
			limit?: number;
			maxChars?: number;
			spontaneous?: boolean;
			profile?: "root" | "supervisor";
		} = {},
	): Promise<{
		memories: AvoMemory[];
		context: string;
		backend: "nooa-memory" | "host-fallback";
		reason?: string;
	}> {
		if (isAvoFeatureAblated("nooa")) {
			return {
				memories: [],
				context: "",
				backend: "host-fallback",
				reason: "NOOA retrieval disabled by an internal benchmark ablation",
			};
		}
		this.store.refreshPersistentMemories();
		const limit = options.limit ?? (options.spontaneous ? 5 : 8);
		const maxChars = options.maxChars ?? 2_000;
		const cue = options.spontaneous ? this.memoryCue(query) : query;
		const state = this.store.getState();
		const allowed = new Set(this.memoryNamespaces());
		const channel = options.spontaneous ? "spontaneous" : "deliberate";
		const profile = options.profile ?? "root";
		const eligible = state.memories.filter(
			(memory) => allowed.has(memory.namespace) && this.store.isMemoryRecallEligible(memory, channel, profile),
		);
		const nooa = this.memoryBridge
			? await this.memoryBridge.spontaneousRecall(
					this.store.memoryRecordsForSync(),
					cue,
					limit,
					maxChars,
					this.store.protectedCanonicalDeliveryMemoryIds(),
				)
			: { ok: false as const, memoryIds: [], backend: "host-fallback" as const, reason: "NOOA bridge unavailable" };
		const byId = new Map(eligible.map((memory) => [memory.memoryId, memory]));
		const recalled: AvoMemory[] = [];
		for (const memoryId of nooa.memoryIds) {
			const memory = byId.get(memoryId);
			if (memory && !recalled.some((item) => item.memoryId === memoryId)) recalled.push(memory);
		}
		if (recalled.length < limit) {
			for (const memory of this.store.recall(cue, this.memoryNamespaces(), limit, { channel, profile })) {
				if (!recalled.some((item) => item.memoryId === memory.memoryId)) recalled.push(memory);
				if (recalled.length >= limit) break;
			}
		}
		const context =
			profile === "supervisor"
				? this.store.formatSupervisorMemoryContext(recalled, maxChars)
				: this.store.formatMemoryContext(recalled, maxChars);
		this.store.recordMemoryRecall(
			cue,
			recalled.map((memory) => memory.memoryId),
			channel,
			context.length,
			{
				backend: nooa.ok ? "nooa-memory" : "host-fallback",
				status: nooa.ok ? "ok" : "fallback",
				reason: nooa.reason,
				retrieval: nooa.retrieval,
				satisfies: nooa.ok ? ["ORDER-001"] : ["ORDER-001", "FALLBACK-001"],
			},
		);
		return {
			memories: recalled,
			context,
			backend: nooa.ok ? "nooa-memory" : "host-fallback",
			reason: nooa.reason,
		};
	}

	async recallSupervisorMemory(query: string): Promise<{
		memories: AvoMemory[];
		context: string;
		backend: "nooa-memory" | "host-fallback";
		reason?: string;
	}> {
		return this.recallMemory(query, {
			limit: 6,
			maxChars: 2_500,
			spontaneous: true,
			profile: "supervisor",
		});
	}

	async syncMemory(): Promise<Record<string, unknown>> {
		this.store.refreshPersistentMemories();
		if (!this.memoryBridge) return { ok: false, reason: "NOOA bridge unavailable" };
		return this.memoryBridge.sync(
			this.store.memoryRecordsForSync(),
			this.store.protectedCanonicalDeliveryMemoryIds(),
		);
	}

	async reflectMemory(trigger: AvoMemoryReflection["trigger"], cycleId?: string): Promise<Record<string, unknown>> {
		if (!this.memoryBridge) return { ok: false, reason: "NOOA bridge unavailable" };
		const result = await this.memoryBridge.reflect(
			this.store.memoryRecordsForSync(),
			trigger,
			this.store.protectedCanonicalDeliveryMemoryIds(),
		);
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
		return (
			(await this.memoryBridge?.reconciliationCandidates(
				this.store.memoryRecordsForSync(),
				this.store.protectedCanonicalDeliveryMemoryIds(),
			)) ?? []
		);
	}

	getState(): AvoRunState {
		return this.store.getState();
	}

	getStateVersion(): number {
		return this.store.getStateVersion();
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

	registerObligations(inputs: readonly AvoObligationInput[]) {
		return this.store.registerObligations(inputs);
	}

	recordObligationCoverage(input: AvoObligationCoverageInput) {
		return this.store.recordObligationCoverage(input);
	}

	registerCriticalAssumptions(inputs: readonly AvoCriticalAssumptionInput[]) {
		return this.store.registerCriticalAssumptions(inputs);
	}

	resolveCriticalAssumption(input: AvoAssumptionResolutionInput) {
		return this.store.resolveCriticalAssumption(input);
	}

	recordEvaluation(input: AvoEvaluationInput) {
		return this.store.recordEvaluation(input, "model");
	}

	recordHostEvaluation(input: AvoEvaluationInput) {
		return this.store.recordEvaluation(input, "host");
	}

	recordExperiment(input: AvoExperimentInput) {
		return this.store.recordExperiment(input);
	}

	recordTrial(input: AvoTrialInput) {
		return this.store.recordTrial(input);
	}

	completeExperiment(experimentId: string) {
		return this.store.completeExperiment(experimentId);
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

	private reconcileAcceptedCandidateIntegrity(): void {
		const state = this.store.getState();
		const acceptedCandidateIds = new Set(
			state.cycles.filter((cycle) => cycle.outcome === "accepted").map((cycle) => cycle.candidateId),
		);
		for (const candidate of state.candidates) {
			if (!acceptedCandidateIds.has(candidate.candidateId)) continue;
			const assessment = assessAvoCandidateIntegrity(
				state,
				candidate,
				this.workspaceCwd,
				this.workspaceExcludedRoots,
			);
			if (assessment.passed) continue;
			const observedDigest = assessment.observedDigest ?? "unavailable";
			if (
				state.evaluations.some(
					(item) =>
						item.candidateId === candidate.candidateId &&
						item.evaluatorId === "candidate_integrity" &&
						item.status === "revise" &&
						item.metrics.observed_integrity_digest === observedDigest,
				)
			) {
				continue;
			}
			this.recordHostEvaluation({
				candidateId: candidate.candidateId,
				evaluatorId: "candidate_integrity",
				status: "revise",
				authority: "host",
				evidenceRefs: [`host:integrity:${observedDigest}`],
				metrics: {
					meaningful: false,
					candidate_payload_digest: candidate.payloadDigest,
					observed_integrity_digest: observedDigest,
					validation_reason: assessment.reason ?? "candidate integrity changed",
				},
			});
		}
	}

	evaluateStopGate() {
		this.reconcileAcceptedCandidateIntegrity();
		const state = this.store.getState();
		const gate = this.adapters.get(state.routing.environment).evaluateStopCondition(state);
		const contracted = applyAvoSpecContractStopGate(state, gate, {
			cwd: this.workspaceCwd,
			excludedRoots: this.workspaceExcludedRoots,
			receiptDirectory: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_DIR,
			receiptPublicKey: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY,
		});
		return this.store.finalizeCanonicalDeliveryStopGate(contracted);
	}

	beginCanonicalDelivery(gate: AvoStopGate = this.evaluateStopGate()): AvoDeliveryState {
		return this.store.beginCanonicalDelivery(gate);
	}

	canonicalDeliveryText(): string | undefined {
		return this.store.canonicalDeliveryText();
	}

	repairCanonicalDeliveryMemory(): AvoMemory {
		return this.store.repairCanonicalDeliveryMemory();
	}

	failCanonicalDelivery(code: string, reason: string): AvoDeliveryState {
		return this.store.failCanonicalDelivery(code, reason);
	}

	complete(): AvoRunState {
		const state = this.store.getState();
		if (state.delivery.phase === "pending" || state.delivery.phase === "delivered") return state;
		const gate = this.evaluateStopGate();
		if (!gate.passed) throw new Error(`AVO completion is blocked: ${gate.reasons.join("; ")}`);
		return this.store.complete(gate);
	}

	completeCanonicalDelivery(observedCanonicalText: string): AvoRunState {
		return this.store.completeCanonicalDelivery(observedCanonicalText);
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
			const avoCandidate =
				state.candidates.find((item) => item.candidateId === cycle.candidate.candidateId) ??
				this.store.recordCandidate({
					candidateId: cycle.candidate.candidateId,
					kind: "research_problem",
					summary: cycle.candidate.statement,
					payload: cycle.candidate,
				});
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
				const experimentEvaluationExists = this.store
					.getState()
					.evaluations.some((item) => item.evaluationId === experimentEvaluationId && item.issuedBy === "host");
				if (!experimentEvaluationExists) {
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
				}
				const episode = {
					record_type: "avo_research_experiment_episode_v3",
					verification_semantics:
						"declared_hypothesis, planned_design, reported_results, and reported_interpretation record the research declaration; only observed_status, observed_metrics, and observed_artifacts are host-bound evidence",
					owning_candidate_id: cycle.candidate.candidateId,
					owning_candidate_identity_digest: digestAvoExperimentCandidateIdentity(avoCandidate),
					declared_hypothesis: experiment.hypothesis,
					planned_design: experiment.design,
					reported_results: experiment.results ?? null,
					reported_interpretation: experiment.interpretation ?? null,
					observed_status: experiment.status,
					observed_metrics: experiment.metrics,
					observed_artifacts: experiment.artifactReceipts.map((receipt) => ({
						path: receipt.path,
						sha256: receipt.sha256,
					})),
				};
				const episodeContent = JSON.stringify(episode, null, 2);
				const experimentMemoryId = `episode:experiment:${digestAvoExperimentValue(JSON.parse(episodeContent))}`;
				if (!this.store.getState().memories.some((memory) => memory.memoryId === experimentMemoryId)) {
					this.store.rememberVerified({
						memoryId: experimentMemoryId,
						namespace: "research",
						type: "episode",
						scope: "project",
						title: `Experiment ${experimentId}: ${experiment.status}`,
						content: episodeContent,
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
	const ablations = activeAvoAblations();
	const onlineEvidenceRequired = state.routing.reasons.some((reason) =>
		reason.startsWith("online evidence required:"),
	);
	const obligationCoverageRequired = !ablations.has("obligations") && state.obligations.length > 0;
	const requiredPremortemAssumptions = requiredAvoPremortemAssumptionCount(state);
	return [
		"AVO is Prime's default operating architecture for every root task. It is not a user-selected mode.",
		`Active AVO task run=${state.runId}. The host automatically selected evaluation adapter=${state.routing.environment}, horizon=${state.routing.horizon}, verification_class=${state.verificationClass}, and verification_policy=${state.verificationPolicy}.`,
		state.routing.reasons.length > 0 ? `Route evidence: ${state.routing.reasons.join("; ")}.` : undefined,
		state.verificationReasons.length > 0
			? `Verification policy evidence: ${state.verificationReasons.join("; ")}.`
			: undefined,
		onlineEvidenceRequired
			? "AVO_ONLINE_EVIDENCE=required. The host has independently determined that this task needs current or explicitly requested online evidence. For Vertex Gemini, native Google Search is enabled automatically. Use it and ground the work in at least one returned source; the final gate will reject a locally verified result that skipped this separate obligation."
			: "AVO_ONLINE_EVIDENCE=not_required. Native online search is not enabled automatically because the task is locally and temporally self-contained; use local evidence unless a later user instruction escalates the requirement.",
		"General, coding, and research are internal tool/evaluation adapters, not separate modes. Do not ask the user to choose one. Direct, iterative, and long only control how much AVO machinery is activated: direct uses one evaluated action without a retained supervisor; iterative retains candidate lineage and revises after feedback; long also activates namespaced memory, recovery, and retained trajectory supervision.",
		"Environment routing is host-authoritative. Model calls cannot select general, coding, or research and may only escalate the current horizon to iterative or long.",
		ablations.has("nooa")
			? undefined
			: "Prime automatically recalls NOOA memory before root turns. Proposed task memory may surface as a hypothesis; proposed project memory is deliberate-only and proposed global persistence is forbidden. Verified memories are host-cleared, and live references are re-resolved at recall time. Never treat recall alone as task evidence or authority.",
		ablations.has("nooa") ? undefined : memoryContext || undefined,
		requiredPremortemAssumptions > 0
			? `AVO_PREMORTEM=required. Before any task workspace change or first candidate, register at least ${requiredPremortemAssumptions} distinct critical assumptions with concrete, non-duplicated falsification plans and direct evidence kinds using avo.register_critical_assumptions. These are competing ways the intended solution could fail, not generic implementation steps. After recording the candidate and host checks, resolve each assumption with its own candidate-bound host receipt from a distinct check; one generic evaluation or repeated command cannot resolve multiple assumptions. Open or refuted assumptions block completion.`
			: "AVO_PREMORTEM=not_required for this task horizon; register critical assumptions only when a genuinely fragile premise needs explicit falsification.",
		'The contract below is complete: do not inspect Prime\'s AVO source, tests, skill files, or Python implementation, and do not call help(), dir(), hasattr(), or inspect.getsource() to rediscover it. Start with the user\'s task files. For ordinary coding work: inspect the relevant workspace; make the change; call `candidate = await avo.add_candidate({"kind": "implementation", "summary": "exact final response", "payload": {"change": "brief description"}})`; take `candidate["candidate"]["candidateId"]`; run a direct meaningful check with `await avo.run_evaluation(candidate_id, command)`; call `await avo.complete_cycle({"candidate_id": candidate_id})`; inspect `await avo.stop_gate()`; then return the exact candidate summary. Choose patch/implementation/configuration for source changes and artifact for a static deliverable; the candidate kind determines which test/build/lint/benchmark/runtime evidence can count. Use avo.run_coding_baseline before editing only when the host captured unchanged baseline tests or the user supplied an acceptance command. If the workspace has no suitable verifier, fail closed and report that missing contract instead of probing unrelated commands or claiming success.',
		obligationCoverageRequired
			? `AVO_OBLIGATIONS=required (${state.obligations.length} host-derived requirements). Do not call complete_cycle or stop_gate until the candidate's declared obligations have host coverage. After a passing evaluation, use exactly: \`candidate_id = candidate["candidate"]["candidateId"]\`; \`evaluation_id = evaluation["evaluation"]["evaluationId"]\`; \`await avo.cover_obligations(candidate_id, [evaluation_id], candidate["candidate"]["obligationIds"])\`. Use only receipts whose evidence kind directly satisfies those obligations. This helper is idempotent and closes already-declared obligations in one model turn; the host still validates every individual binding.`
			: "AVO_OBLIGATIONS=not_required for this ablation/task; no obligation-coverage call is needed.",
		ablations.has("impact_verification")
			? undefined
			: "For coding candidates, the host derives changed source, public-API/schema, configuration, and documentation impact surfaces. Source requires test evidence; public API/schema requires test and build; configuration requires test plus build or runtime; documentation requires a direct filesystem check. Uncovered impact surfaces block the cycle and final gate.",
		ablations.has("qualified_watchdog")
			? undefined
			: "The host also runs a default anti-laziness watchdog. A turn counts as progress only when it records a meaningful host pass, covers a preregistered obligation, tests a critical assumption, completes a cycle, completes a host-bound experiment cell, or completes an experiment. A workspace edit or fresh candidate alone does not count. Reading, narrating, repeating the same failed check, inspecting Prime internals, or merely saying done does not reset it. Four consecutive tool batches without one of those milestones inject immediate steering and activate state-aware IPython probation: the next cell must invoke the exact next AVO action permitted by current host state. At blocked root-turn boundaries, one empty turn triggers a corrective watch, two trigger an intervention, and three may automatically escalate the horizon to long only before the coding candidate-admission contract is locked. Once a coding baseline execution, candidate, evaluation, or experiment has begun, watchdog steering cannot add new horizon-derived candidate prerequisites. Repeatedly paraphrasing or decorating an already verified canonical delivery triggers a separate delivery intervention. Resume from the latest concrete milestone and follow the host's exact recovery action when intervened.",
		ablations.has("adversarial_supervision")
			? undefined
			: "For required coding work at long horizon, and requirement-dense iterative work, the retained verifier performs a bounded read-only adversarial acceptance audit after an accepted cycle. It inspects the implementation and existing tests, challenges up to three high-risk specification boundaries, and may veto but never upgrade host evidence. A broad test receipt is a review-prioritization signal rather than an automatic failure.",
		"When a coding candidate receives a host revise/fail receipt, do not relabel or resubmit the same workspace. Make a material correction and pass the failed candidate as parent_candidate_id on the immediate successor. The host rejects an unlinked successor or an unchanged workspace digest.",
		"Use the avo skill for the task's candidate/evaluation lifecycle. The host will automatically continue the root task instead of accepting an answer that skipped AVO, failed its gate, changed a verified workspace/artifact, or differs from the accepted candidate's canonical delivery. Callers may record only model_opinion. Required external_factual candidates must declare verbatim claims and bind each claim to a host-trusted external source record; after Serper IPython or Vertex Google Search, use avo.fetch_external_source on a result URL and avo.bind_url with a visible quote exactly equal to the claim. Provenance without a host-bound independent entailment verdict cannot pass. Required deterministic arithmetic uses a payload exactly shaped as {result: number} and avo.verify_deterministic_result; required artifact candidates declare artifact_paths and use avo.verify_artifacts. An unrelated successful command cannot certify either class. Before changing a coding workspace, use avo.run_coding_baseline with a direct command that explicitly names an unchanged baseline test file, then run the exact same command after the candidate with avo.run_evaluation. Mutable package-script wrappers, output-printed filenames, no-op mutation candidates, and candidate-created tests cannot certify progress. Passing in-process pytest output cannot certify changed Python code; use an immutable out-of-process verifier or independently verified exact spec proof. For repeatable comparisons in any adapter, preregister a structured candidate/condition/seed screening plan with avo.record_experiment, run each exact cell through avo.run_trial, and call avo.complete_experiment only after the full grid. Screening only ranks a provisional candidate. Promotion requires a separate prospective confirmation that compares exactly that challenger with the same baseline and conditions on unused seeds, declares at least five pairs, and preregisters a positive absolute or relative meaningful-effect threshold. The host renders and hashes cell commands, derives aggregate statistics and paired Student-t confidence bounds, issues confirmatory promote/retain outcomes, and stores declarations separately from empirical observations in NOOA. Never invent host, environment, or external authority. Required verification needs host-issued evidence; best_effort and not_applicable policies may use a transparent model-opinion review without pretending it is external. Complete the candidate cycle, then return only its canonical delivery: general payload text, deterministic numeric result, or coding/research summary, with no preface or suffix. A later root task starts a fresh task run after the current gate and delivery pass, while namespaced memory survives across runs.",
	]
		.filter((line): line is string => line !== undefined)
		.join("\n\n");
}
