import {
	type WorkflowCompletionCanonicalValidationInput,
	type WorkflowCompletionCapacityReceiptBindingInput,
	type WorkflowCompletionDigestSources,
	type WorkflowCompletionReadinessResolverInput,
	workflowCompletionAdjudicationReceiptBindingDigest,
	workflowCompletionCapacityReceiptBindingDigest,
	workflowCompletionDecisionAdjudicationBindingDigest,
	workflowCompletionReadinessReceiptBindingDigest,
	workflowCompletionUsageReceiptBindingDigest,
} from "./completion-gate.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowCanonicalJsonValue,
	type WorkflowCanonicalPoolLedger,
	type WorkflowCompletionCapacityReconciliation,
	type WorkflowCompletionReadinessReceipt,
	type WorkflowCompletionUsageReconciliation,
	type WorkflowControlCapacityVector,
	type WorkflowDecisionRecord,
	type WorkflowDecisionRef,
	type WorkflowMetricEvaluation,
	type WorkflowResourceGrantLedger,
	type WorkflowResourceVector,
	type WorkflowRuntimeStore,
} from "./contracts.js";
import type {
	PersistedWorkflowCompletionReadinessAuthority,
	PersistedWorkflowCompletionReceiptIssuer,
} from "./session-host-factory.js";
import type { WorkflowTask } from "./task-graph.js";

const BUILTIN_COMPLETION_STAGES = ["recon", "lens", "lens", "verification", "synthesis", "red_team"] as const;
const BUILTIN_COMPLETION_LENS_ROLES = [null, "primary", "secondary", null, null, null] as const;

export interface DefaultPrimeCompletionStageEvidence {
	readonly stageId: string;
	readonly sourceEventRef: WorkflowArtifactRef;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly taskGraphSourceDigest: string;
	readonly requirementIds: readonly string[];
	readonly completionCriteria: readonly string[];
	readonly inputRefs: readonly string[];
	readonly boundaryIds: readonly string[];
	readonly outputRefs: readonly string[];
	readonly evidencePolicy: NonNullable<WorkflowTask["evidencePolicy"]>;
	readonly evidenceKind: string;
	readonly budget: NonNullable<WorkflowTask["budget"]>;
	readonly recoveryPolicy: NonNullable<WorkflowTask["recoveryPolicy"]>;
	readonly authority: WorkflowTask["authority"];
}

export interface DefaultPrimeGoalMetricEvaluationEvidence {
	readonly metricId: string;
	readonly requirementId: string;
	readonly metricContractDigest: string;
	readonly evaluation: WorkflowMetricEvaluation;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly evaluationDigest: string;
}

export interface DefaultPrimeCompletionAuditContext {
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly objective: string;
	readonly goalContract: unknown;
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly requiredStageIds: readonly string[];
	readonly completedStageIds: readonly string[];
	readonly readyStageIds: readonly string[];
	readonly pipelineStateDigest: string;
	readonly stageEvidence: readonly DefaultPrimeCompletionStageEvidence[];
	readonly goalMetricEvaluations: readonly DefaultPrimeGoalMetricEvaluationEvidence[];
	readonly executionEvidenceStateDigest: string;
	readonly executionEvidenceRefs: readonly WorkflowArtifactRef[];
	readonly schedulerStateDigest: string;
	readonly schedulerActiveAttemptIds: readonly string[];
	readonly schedulerTerminalTaskIds: readonly string[];
	readonly workerLaunchEvidenceRefs: readonly WorkflowArtifactRef[];
	readonly adaptiveStateDigest: string;
	readonly adaptiveReviewCount: number;
	readonly learningStateDigest: string;
	readonly knowledgeStateDigest: string;
	readonly recipeCapability: "builtin_adaptive_prime" | "dynamic_task_graph";
}

export interface DefaultPrimeCompletionAuthorityInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
	readonly now: () => string;
	readonly readAuditContext: () => Promise<DefaultPrimeCompletionAuditContext>;
}

interface DefaultPrimeCompletionEvaluation {
	readonly readiness: WorkflowCompletionReadinessReceipt;
	readonly digestSources: WorkflowCompletionDigestSources;
	readonly decisions: ReadonlyMap<string, WorkflowDecisionRecord>;
	readonly auditDigest: string;
}

function zeroControlCapacity(): WorkflowControlCapacityVector {
	return {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	};
}

function accountedResources(state: WorkflowCompletionReadinessResolverInput["currentState"]): WorkflowResourceVector {
	return {
		cpuMilliCores: 0,
		memoryBytes: 0,
		diskBytes: 0,
		ioWeight: 0,
		accelerators: [],
		providers:
			state.goalTokensUsed === 0 && state.goalContinuationsUsed === 0
				? []
				: [
						{
							poolId: "workflow-accounting",
							concurrentRequests: state.goalContinuationsUsed > 0 ? 1 : 0,
							requestsPerMinute: state.goalContinuationsUsed,
							totalRequests: state.goalContinuationsUsed,
							inputTokens: state.goalTokensUsed,
							outputTokens: 0,
							idempotency: "host_reconciled",
						},
					],
		networkEgressBytes: 0,
		wallMilliseconds: state.goalTimeUsedSeconds * 1_000,
		monetaryMicrounits: 0,
	};
}

function canonicalValue(value: unknown): WorkflowCanonicalJsonValue {
	return parseCanonicalJsonBytes(canonicalJsonBytes(value));
}

function uniqueArtifactRefs(refs: readonly WorkflowArtifactRef[]): WorkflowArtifactRef[] {
	return [...new Map(refs.map((ref) => [digestObject(ref), structuredClone(ref)])).values()];
}

function approvedGoalMetricBindings(goalContract: unknown): readonly {
	readonly metricId: string;
	readonly requirementId: string;
	readonly metricContractDigest: string;
}[] {
	if (typeof goalContract !== "object" || goalContract === null || Array.isArray(goalContract))
		throw new Error("default_prime_completion_goal_contract_invalid");
	const successMetrics = Reflect.get(goalContract, "successMetrics");
	if (!Array.isArray(successMetrics) || successMetrics.length === 0)
		throw new Error("default_prime_completion_goal_metrics_missing");
	const bindings = successMetrics.map((metric) => {
		if (typeof metric !== "object" || metric === null || Array.isArray(metric))
			throw new Error("default_prime_completion_goal_metric_invalid");
		const metricId = Reflect.get(metric, "metricId");
		const requirementId = Reflect.get(metric, "requirementId");
		if (
			typeof metricId !== "string" ||
			metricId.length === 0 ||
			typeof requirementId !== "string" ||
			requirementId.length === 0
		)
			throw new Error("default_prime_completion_goal_metric_invalid");
		return { metricId, requirementId, metricContractDigest: digestObject(metric) };
	});
	if (new Set(bindings.map((binding) => binding.metricId)).size !== bindings.length)
		throw new Error("default_prime_completion_goal_metric_invalid");
	return bindings;
}

function assertGoalMetricEvaluations(audit: DefaultPrimeCompletionAuditContext): void {
	const approved = approvedGoalMetricBindings(audit.goalContract);
	const measuredRequirementIds = new Set(approved.map((binding) => binding.requirementId));
	if (audit.acceptanceCheckIds.some((requirementId) => !measuredRequirementIds.has(requirementId)))
		throw new Error("default_prime_completion_goal_requirement_unmeasured");
	const evaluations = new Map(audit.goalMetricEvaluations.map((entry) => [entry.metricId, entry]));
	if (evaluations.size !== audit.goalMetricEvaluations.length || evaluations.size !== approved.length)
		throw new Error("default_prime_completion_goal_metric_unmeasured");
	for (const binding of approved) {
		const entry = evaluations.get(binding.metricId);
		if (
			entry === undefined ||
			entry.requirementId !== binding.requirementId ||
			entry.metricContractDigest !== binding.metricContractDigest ||
			entry.evaluation.metricId !== binding.metricId ||
			entry.evaluation.accepted !== true ||
			entry.evaluation.runCount < 1 ||
			entry.evidenceRefs.length === 0 ||
			entry.evaluationDigest !== digestObject({ ...entry, evaluationDigest: "" })
		)
			throw new Error("default_prime_completion_goal_metric_not_proven");
	}
}

async function assertAuditContext(
	input: DefaultPrimeCompletionAuthorityInput,
	request: WorkflowCompletionReadinessResolverInput,
	audit: DefaultPrimeCompletionAuditContext,
): Promise<void> {
	assertGoalMetricEvaluations(audit);
	if (
		audit.workflowId !== request.workflowId ||
		audit.rootSessionId !== request.currentState.rootSessionId ||
		audit.objective !== request.currentState.objective ||
		audit.goalContract === null ||
		audit.acceptanceCheckIds.length === 0 ||
		audit.protectedInvariantIds.length === 0 ||
		audit.readyStageIds.length !== 0 ||
		audit.adaptiveReviewCount < audit.requiredStageIds.length
	)
		throw new Error("default_prime_completion_audit_incomplete");
	const required = new Set(audit.requiredStageIds);
	const completed = new Set(audit.completedStageIds);
	const terminalTasks = new Set(audit.schedulerTerminalTaskIds);
	if (
		required.size !== audit.requiredStageIds.length ||
		completed.size !== audit.completedStageIds.length ||
		required.size !== completed.size ||
		[...required].some((stageId) => !completed.has(stageId)) ||
		audit.schedulerActiveAttemptIds.length !== 0 ||
		terminalTasks.size !== audit.schedulerTerminalTaskIds.length ||
		terminalTasks.size !== required.size ||
		[...required].some((stageId) => !terminalTasks.has(stageId)) ||
		audit.workerLaunchEvidenceRefs.length !== required.size
	)
		throw new Error("default_prime_completion_task_runtime_not_complete");
	const stageIds = new Set(audit.stageEvidence.map((stage) => stage.stageId));
	if (
		audit.stageEvidence.length !== required.size ||
		stageIds.size !== required.size ||
		[...required].some((stageId) => !stageIds.has(stageId))
	)
		throw new Error("default_prime_completion_stage_evidence_incomplete");
	const sourceDigests = new Set(audit.stageEvidence.map((stage) => stage.taskGraphSourceDigest));
	if (sourceDigests.size !== 1 || [...sourceDigests].some((digest) => !/^[0-9a-f]{64}$/u.test(digest)))
		throw new Error("default_prime_completion_task_graph_source_invalid");
	for (const stage of audit.stageEvidence) {
		if (
			stage.completionCriteria.length === 0 ||
			stage.evidenceKind !== stage.evidencePolicy.kind ||
			stage.boundaryIds.length === 0 ||
			stage.outputRefs.length === 0 ||
			stage.requirementIds.some((requirementId) => !audit.acceptanceCheckIds.includes(requirementId)) ||
			stage.budget.tokenLimit < 0 ||
			stage.budget.wallTimeLimitSeconds < 0 ||
			stage.budget.spendLimitMicrounits < 0 ||
			stage.authority.length === 0
		)
			throw new Error("default_prime_completion_task_contract_unbound");
	}
	if (
		audit.executionEvidenceRefs.length === 0 ||
		new Set(audit.executionEvidenceRefs.map((ref) => digestObject(ref))).size !== audit.executionEvidenceRefs.length
	)
		throw new Error("default_prime_completion_execution_evidence_invalid");
	const outcomeRefs =
		request.outcome.outcome.status === "complete"
			? uniqueArtifactRefs([...request.outcome.outcome.artifactRefs, ...request.outcome.outcome.evidenceRefs])
			: [];
	const outcomeRefDigests = new Set(outcomeRefs.map((ref) => digestObject(ref)));
	const requiredRefs = uniqueArtifactRefs([
		...audit.executionEvidenceRefs,
		...audit.workerLaunchEvidenceRefs,
		...audit.stageEvidence.flatMap((stage) => [stage.sourceEventRef, ...stage.evidenceRefs]),
		...audit.goalMetricEvaluations.flatMap((evaluation) => evaluation.evidenceRefs),
	]);
	if (requiredRefs.some((ref) => !outcomeRefDigests.has(digestObject(ref))))
		throw new Error("default_prime_completion_outcome_evidence_incomplete");
	for (const ref of requiredRefs) {
		const resolved = await input.artifactResolver.resolve(ref);
		if (
			!resolved.exists ||
			resolved.verifiedDigest !== ref.digest ||
			resolved.verifiedSizeBytes !== ref.sizeBytes ||
			digestObject(resolved.envelope.ref) !== digestObject(ref)
		)
			throw new Error("default_prime_completion_evidence_not_immutable");
	}
	if (
		request.currentState.goalTokenBudget !== null &&
		request.currentState.goalTokensUsed > request.currentState.goalTokenBudget
	)
		throw new Error("default_prime_completion_token_budget_exceeded");
}

async function publishArtifact(
	input: DefaultPrimeCompletionAuthorityInput,
	state: WorkflowCompletionReadinessResolverInput["currentState"],
	value: unknown,
	idempotencyKey: string,
): Promise<WorkflowArtifactRef> {
	return (
		await input.runtimeStore.publishArtifact({
			workflowId: state.workflowId,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes(value),
			codec: "canonical_json",
			sourceEventSequence: state.sourceJournalSequence,
			idempotencyKey,
		})
	).envelope.ref;
}

async function buildResourceReconciliations(
	input: DefaultPrimeCompletionAuthorityInput,
	request: WorkflowCompletionReadinessResolverInput,
): Promise<{
	readonly usageReconciliationRef: WorkflowArtifactRef;
	readonly capacityReconciliationRef: WorkflowArtifactRef;
	readonly capacityLedgerSource: unknown;
}> {
	const state = request.currentState;
	const outputStateDigest =
		request.outcome.outcome.status === "complete" ? request.outcome.outcome.outputStateDigest : "";
	const resourceTotal = accountedResources(state);
	const controlTotal = zeroControlCapacity();
	const approvedEnvelopeDigest =
		state.resourceEnvelopeDigest ?? digestObject({ kind: "default-prime-local-envelope" });
	const capacityCasDigest = digestObject({
		kind: "default-prime-completion-capacity-cas",
		workflowId: state.workflowId,
		stateDigest: state.sourceJournalDigest,
		approvedEnvelopeDigest,
	});
	const canonicalLedgerRef = await publishArtifact(
		input,
		state,
		{
			kind: "default_prime_completion_capacity_ledger",
			workflowId: state.workflowId,
			stateDigest: state.sourceJournalDigest,
			resourceTotal,
			controlTotal,
			approvedEnvelopeDigest,
			capacityCasDigest,
		},
		`default-prime-completion-capacity-ledger:${state.sourceJournalDigest}`,
	);
	const componentPoolAssignment = {
		workflowId: state.workflowId,
		epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
		approvedEnvelopeDigest,
		capacityCasDigest,
		resourceComponentPools: {
			cpuMilliCores: "workflow-accounting",
			memoryBytes: "workflow-accounting",
			diskBytes: "workflow-accounting",
			ioWeight: "workflow-accounting",
			accelerators: "workflow-accounting",
			providers: "workflow-accounting",
			acceleratorCount: "workflow-accounting",
			acceleratorMemoryBytes: "workflow-accounting",
			providerConcurrentRequests: "workflow-accounting",
			providerRequestsPerMinute: "workflow-accounting",
			providerTotalRequests: "workflow-accounting",
			providerInputTokens: "workflow-accounting",
			providerOutputTokens: "workflow-accounting",
			networkEgressBytes: "workflow-accounting",
			wallMilliseconds: "workflow-accounting",
			monetaryMicrounits: "workflow-accounting",
		},
		controlComponentPools: {
			processSlots: "workflow-accounting",
			childSessionSlots: "workflow-accounting",
			modelCallSlots: "workflow-accounting",
			modelInputTokens: "workflow-accounting",
			modelOutputTokens: "workflow-accounting",
			verificationSlots: "workflow-accounting",
			redTeamSlots: "workflow-accounting",
			recoverySlots: "workflow-accounting",
		},
		spendPoolId: "workflow-accounting",
		assignmentDigest: digestObject({ workflowId: state.workflowId, approvedEnvelopeDigest, capacityCasDigest }),
	};
	const canonicalPoolLedger: WorkflowCanonicalPoolLedger = {
		ledgerId: `default-prime-completion:${state.workflowId}`,
		ledgerEpoch: state.coordinatorEpoch,
		instantaneousPools: [],
		cumulativeSpendPools: [],
		instantaneousComponentLedgers: [],
		cumulativeComponentLedgers: [],
		accountedResourceComponents: [
			"cpuMilliCores",
			"memoryBytes",
			"diskBytes",
			"ioWeight",
			"accelerators",
			"providers",
			"networkEgressBytes",
			"wallMilliseconds",
			"monetaryMicrounits",
		],
		accountedControlComponents: [
			"processSlots",
			"childSessionSlots",
			"modelCallSlots",
			"modelInputTokens",
			"modelOutputTokens",
			"verificationSlots",
			"redTeamSlots",
			"recoverySlots",
		],
		exhaustiveComponentAccounting: true,
		reserveRepresentation: "canonical_ledger_only",
		componentPoolAssignment,
		ledgerDigest: digestObject({ kind: "default-prime-completion-ledger", stateDigest: state.sourceJournalDigest }),
		workflowId: state.workflowId,
		revision: state.sourceJournalSequence,
		epoch: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
		approvedPools: {},
		activePools: {},
		remainingPools: {},
		instantaneousByPool: {},
		cumulativeByPool: {},
		reservedByPool: {},
		releasedByPool: {},
		instantaneousSpend: { totalMicrounits: 0, byPool: {} },
		cumulativeSpend: { totalMicrounits: 0, byPool: {} },
		instantaneousSpendByPool: {},
		cumulativeSpendByPool: {},
		exhaustiveResourceComponents: resourceTotal,
		exhaustiveControlDimensions: controlTotal,
		approvedEnvelopeDigest,
		envelopeCapacityCasDigest: capacityCasDigest,
		providerPoolIds: resourceTotal.providers.map((provider) => provider.poolId),
		acceleratorPoolIds: [],
		artifactRef: canonicalLedgerRef,
		digest: digestObject({ kind: "default-prime-completion-pool-ledger", stateDigest: state.sourceJournalDigest }),
	};
	const grantLedger: WorkflowResourceGrantLedger = {
		workflowId: state.workflowId,
		revision: state.sourceJournalSequence,
		entries: [],
		resourceTotal,
		spendTotalMicrounits: resourceTotal.monetaryMicrounits,
		headDigest: state.sourceJournalDigest,
		canonicalLedgerRef,
		canonicalLedgerDigest: canonicalLedgerRef.digest,
		workerTotal: controlTotal,
		controlTotal,
		instantaneousByPool: {},
		cumulativeByPool: {},
		instantaneousSpendByPool: {},
		cumulativeSpendByPool: {},
		instantaneousWorkerCapacity: controlTotal,
		instantaneousControlCapacity: controlTotal,
		cumulativeWorkerCapacity: controlTotal,
		cumulativeControlCapacity: controlTotal,
		canonicalPoolLedger,
		approvedEnvelopeDigest,
		envelopeCapacityCasDigest: capacityCasDigest,
	};
	const grantLedgerRef = await publishArtifact(
		input,
		state,
		grantLedger,
		`default-prime-completion-grant-ledger:${state.sourceJournalDigest}`,
	);
	const goalBudgetDigest = digestObject({
		workflowId: state.workflowId,
		tokenBudget: state.goalTokenBudget,
		tokensUsed: state.goalTokensUsed,
		timeUsedSeconds: state.goalTimeUsedSeconds,
		continuationsUsed: state.goalContinuationsUsed,
	});
	const usageBinding = workflowCompletionUsageReceiptBindingDigest({
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		resourceUsage: resourceTotal,
		controlUsage: controlTotal,
		spendMicrounits: resourceTotal.monetaryMicrounits,
		grantLedgerRef,
		grantLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		goalBudgetDigest,
	});
	const capacityBindingInput: WorkflowCompletionCapacityReceiptBindingInput = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		capacityVector: resourceTotal,
		controlCapacity: controlTotal,
		canonicalLedgerRef,
		canonicalLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		capacityCasDigest,
	};
	const usageReceipt = await input.issueReceipt({
		receiptKind: "usage",
		workflowId: state.workflowId,
		bindingDigest: usageBinding,
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const capacityReceipt = await input.issueReceipt({
		receiptKind: "artifact",
		workflowId: state.workflowId,
		bindingDigest: workflowCompletionCapacityReceiptBindingDigest(capacityBindingInput),
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const usage: WorkflowCompletionUsageReconciliation = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		resourceUsage: resourceTotal,
		controlUsage: controlTotal,
		spendMicrounits: resourceTotal.monetaryMicrounits,
		grantLedgerRef,
		grantLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		goalBudgetDigest,
		hostReceipt: usageReceipt,
		reconciliationDigest: "",
	};
	usage.reconciliationDigest = digestObject(usage);
	const capacity: WorkflowCompletionCapacityReconciliation = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest,
		capacityVector: resourceTotal,
		controlCapacity: controlTotal,
		canonicalLedgerRef,
		canonicalLedgerDigest: canonicalLedgerRef.digest,
		approvedEnvelopeDigest,
		capacityCasDigest,
		hostReceipt: capacityReceipt,
		reconciliationDigest: "",
	};
	capacity.reconciliationDigest = digestObject(capacity);
	const [usageReconciliationRef, capacityReconciliationRef] = await Promise.all([
		publishArtifact(
			input,
			state,
			usage,
			`default-prime-completion-usage-reconciliation:${state.sourceJournalDigest}`,
		),
		publishArtifact(
			input,
			state,
			capacity,
			`default-prime-completion-capacity-reconciliation:${state.sourceJournalDigest}`,
		),
	]);
	return {
		usageReconciliationRef,
		capacityReconciliationRef,
		capacityLedgerSource: { canonicalLedgerRef, canonicalLedgerDigest: canonicalLedgerRef.digest },
	};
}

async function makeCompletionDecision(input: {
	readonly authority: DefaultPrimeCompletionAuthorityInput;
	readonly request: WorkflowCompletionReadinessResolverInput;
	readonly audit: DefaultPrimeCompletionAuditContext;
	readonly role: "verifier" | "red_team";
}): Promise<{ readonly decision: WorkflowDecisionRecord; readonly ref: WorkflowDecisionRef }> {
	const state = input.request.currentState;
	const decisionId = `default-prime-completion-${input.role}-${state.sourceJournalDigest.slice(0, 16)}`;
	const builtinRecipe = input.audit.recipeCapability === "builtin_adaptive_prime";
	const plannedSources = builtinRecipe
		? input.audit.stageEvidence.slice(0, BUILTIN_COMPLETION_STAGES.length)
		: input.audit.stageEvidence;
	if (plannedSources.length === 0 || (builtinRecipe && plannedSources.length !== BUILTIN_COMPLETION_STAGES.length))
		throw new Error("default_prime_completion_decision_stage_missing");
	const plannedStages = builtinRecipe
		? [...BUILTIN_COMPLETION_STAGES]
		: plannedSources.map((source) => source.stageId);
	const plannedLensRoles = builtinRecipe ? [...BUILTIN_COMPLETION_LENS_ROLES] : plannedStages.map(() => null);
	const stagePlan = {
		recipeCapability: input.audit.recipeCapability,
		stages: plannedStages,
		lensRoles: plannedLensRoles,
		charterDigests: plannedSources.map((source, index) =>
			digestObject({
				decisionId,
				stage: plannedStages[index],
				lensRole: plannedLensRoles[index],
				taskGraphSourceDigest: source.taskGraphSourceDigest,
				contract: {
					requirementIds: source.requirementIds,
					completionCriteria: source.completionCriteria,
					inputRefs: source.inputRefs,
					boundaryIds: source.boundaryIds,
					outputRefs: source.outputRefs,
					evidencePolicy: source.evidencePolicy,
					evidenceKind: source.evidenceKind,
					budget: source.budget,
					recoveryPolicy: source.recoveryPolicy,
					authority: source.authority,
				},
			}),
		),
		planDigest: digestObject({
			kind: "default-prime-completion-stage-plan",
			decisionId,
			recipeCapability: input.audit.recipeCapability,
			stages: plannedStages,
			charterDigests: plannedSources.map((source) => source.taskGraphSourceDigest),
			auditDigest: digestObject(input.audit),
		}),
	} as unknown as WorkflowDecisionRecord["stagePlan"] & {
		recipeCapability: DefaultPrimeCompletionAuditContext["recipeCapability"];
	};
	const stageVerdicts: Array<WorkflowDecisionRecord["stageVerdicts"][number]> = [];
	for (const [index, source] of plannedSources.entries()) {
		const stage = plannedStages[index];
		const lensRole = plannedLensRoles[index];
		if (stage === undefined || lensRole === undefined)
			throw new Error("default_prime_completion_decision_stage_missing");
		const sessionId = `${decisionId}:session:${index}`;
		const executionIdentity = `${decisionId}:execution:${index}`;
		const verdictRef = await publishArtifact(
			input.authority,
			state,
			{
				kind: "default_prime_completion_stage_verdict",
				workflowId: state.workflowId,
				decisionId,
				role: input.role,
				stage,
				lensRole,
				inputStateDigest: state.sourceJournalDigest,
				sessionId,
				executionIdentity,
				sourceEventRef: source.sourceEventRef,
				evidenceRefs: source.evidenceRefs,
				taskGraphSourceDigest: source.taskGraphSourceDigest,
				requirementIds: source.requirementIds,
				completionCriteria: source.completionCriteria,
				inputRefs: source.inputRefs,
				boundaryIds: source.boundaryIds,
				outputRefs: source.outputRefs,
				evidencePolicy: source.evidencePolicy,
				evidenceKind: source.evidenceKind,
				budget: source.budget,
				recoveryPolicy: source.recoveryPolicy,
				authority: source.authority,
				auditDigest: digestObject(input.audit),
			},
			`default-prime-completion-stage:${decisionId}:${index}:${state.sourceJournalDigest}`,
		);
		stageVerdicts.push({
			decisionId,
			decisionRevision: 1,
			stage: stage as WorkflowDecisionRecord["stageVerdicts"][number]["stage"],
			lensRole,
			stageId: `${decisionId}:stage:${source.stageId}`,
			disposition: "accepted",
			sessionId,
			executionIdentity,
			storeEpoch: state.storeEpoch,
			coordinatorEpoch: state.coordinatorEpoch,
			inputStateDigest: state.sourceJournalDigest,
			evidenceDigest: digestObject({ source, verdictRef, auditDigest: digestObject(input.audit) }),
			artifactRefs: [verdictRef],
			independence: {
				freshContext: true,
				distinctSessionIdentity: true,
				distinctExecutionIdentity: true,
				sharedConversation: false,
				sharedMutableOutput: false,
				inputStateDigest: state.sourceJournalDigest,
				charterDigest: stagePlan.charterDigests[index]!,
				limitationRefs: [],
			},
		});
	}
	const targetDigest = digestObject({ workflowId: state.workflowId, role: input.role, audit: input.audit });
	const effectDigest = digestObject({ kind: "default-prime-completion", role: input.role });
	const preconditionDigest = digestObject({ stateDigest: state.sourceJournalDigest });
	const attemptToken = `${decisionId}:attempt`;
	const nonce = `${decisionId}:nonce`;
	const executionKey = `${decisionId}:execution-key`;
	const proposerSessionId = `${decisionId}:proposer`;
	const lensSessionIds = builtinRecipe ? [stageVerdicts[1]!.sessionId, stageVerdicts[2]!.sessionId] : [];
	const verifierSessionId = builtinRecipe ? stageVerdicts[3]!.sessionId : `${decisionId}:verifier`;
	const synthesizerSessionId = builtinRecipe ? stageVerdicts[4]!.sessionId : `${decisionId}:synthesizer`;
	const redTeamSessionId = builtinRecipe ? stageVerdicts[5]!.sessionId : `${decisionId}:red-team`;
	const hostSessionId = `${decisionId}:host-session`;
	const hostExecutionIdentity = `${decisionId}:host-execution`;
	const operationDigest = digestObject({ kind: "default-prime-completion-adjudication", decisionId });
	const adjudicationReceipt = await input.authority.issueReceipt({
		receiptKind: "adjudication",
		workflowId: state.workflowId,
		bindingDigest: workflowCompletionDecisionAdjudicationBindingDigest({
			workflowId: state.workflowId,
			rootSessionId: state.rootSessionId,
			role: input.role,
			decisionId,
			decisionRevision: 1,
			inputStateDigest: state.sourceJournalDigest,
			epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
			targetDigest,
			effectDigest,
			preconditionDigest,
			planDigest: stagePlan.planDigest,
			attemptToken,
			nonce,
			executionKey,
			proposerSessionId,
			verifierSessionId,
			synthesizerSessionId,
			redTeamSessionId,
			hostSessionId,
			hostExecutionIdentity,
			operationDigest,
			disposition: "accepted",
		}),
		oneUse: true,
		stateDigest: state.sourceJournalDigest,
		revision: state.sourceJournalSequence,
	});
	const decision: WorkflowDecisionRecord = {
		decisionScope: { kind: "workflow", workflowId: state.workflowId, rootSessionId: state.rootSessionId },
		decisionId,
		revision: 1,
		parentDecisionIds: state.decisionRefs.map((ref) => ref.decisionId),
		kind: "completion",
		hostClassification: {
			classifier: "host",
			rulesetDigest: digestObject({ kind: "default-prime-completion-rules" }),
			effectClasses: ["test_or_evaluator"],
			normalizedReadSet: [state.workflowId],
			normalizedWriteSet: [state.workflowId],
			derivedMateriality: "routine",
			requiresUserApproval: false,
			reasonCodes: ["pipeline-complete", "evidence-verified", "red-team-accepted"],
			classifiedTargetDigest: targetDigest,
			classifiedEffectDigest: effectDigest,
		},
		storeEpoch: state.storeEpoch,
		coordinatorEpoch: state.coordinatorEpoch,
		targetDigest,
		effectDigest,
		preconditionDigest,
		authority: ["observe_workflow", "accept_completion"],
		expiresAt: new Date(Date.parse(input.authority.now()) + 300_000).toISOString(),
		objectiveDigest: digestObject(input.audit.objective),
		contractDigest: state.goalContractDigest ?? digestObject(input.audit.goalContract),
		scorecardDigest: state.scorecardDigest ?? digestObject(input.audit.acceptanceCheckIds),
		planDigest: stagePlan.planDigest,
		stateDigest: state.sourceJournalDigest,
		workspaceDigest: state.workspaceDigest,
		evidenceDigest: digestObject(stageVerdicts.map((verdict) => verdict.evidenceDigest)),
		parserDigest: digestObject({ kind: "default-prime-completion-parser" }),
		evaluatorDigest: digestObject({ kind: "default-prime-completion-evaluator", role: input.role }),
		guardDigest: digestObject(input.audit.protectedInvariantIds),
		regressionDigest: digestObject({ learningStateDigest: input.audit.learningStateDigest }),
		blockerDigest: null,
		redTeamDigest: digestObject({ adaptiveStateDigest: input.audit.adaptiveStateDigest, role: input.role }),
		readSet: [state.workflowId],
		writeSet: [state.workflowId],
		attemptToken,
		nonce,
		executionKey,
		proposerSessionId,
		lensSessionIds,
		verifierSessionId,
		synthesizerSessionId,
		redTeamSessionId,
		stagePlan,
		stageVerdicts,
		hostAdjudication: {
			stage: "host_adjudication",
			decisionId,
			decisionRevision: 1,
			executionIdentity: hostExecutionIdentity,
			sessionId: hostSessionId,
			inputStateDigest: state.sourceJournalDigest,
			operationDigest,
			verdictArtifactRef: adjudicationReceipt.artifactRef,
			verdictDigest: adjudicationReceipt.payloadDigest,
			hostReceipt: adjudicationReceipt,
			disposition: "accepted",
		},
		artifactRefs: stageVerdicts.flatMap((verdict) => verdict.artifactRefs),
		disposition: "authorized",
	};
	return {
		decision,
		ref: {
			decisionScope: decision.decisionScope,
			decisionId,
			revision: decision.revision,
			storeEpoch: state.storeEpoch,
			coordinatorEpoch: state.coordinatorEpoch,
			decisionDigest: digestObject(decision),
		},
	};
}

async function buildEvaluation(
	input: DefaultPrimeCompletionAuthorityInput,
	request: WorkflowCompletionReadinessResolverInput,
): Promise<DefaultPrimeCompletionEvaluation> {
	if (request.outcome.outcome.status !== "complete") throw new Error("default_prime_completion_outcome_invalid");
	const audit = await input.readAuditContext();
	await assertAuditContext(input, request, audit);
	const outputStateDigest = request.outcome.outcome.outputStateDigest;
	const resources = await buildResourceReconciliations(input, request);
	const [verifier, redTeam] = await Promise.all([
		makeCompletionDecision({ authority: input, request, audit, role: "verifier" }),
		makeCompletionDecision({ authority: input, request, audit, role: "red_team" }),
	]);
	const digestSources: WorkflowCompletionDigestSources = {
		objective: audit.objective,
		hardenedContract: canonicalValue({
			goalContract: audit.goalContract,
			acceptanceCheckIds: audit.acceptanceCheckIds,
			protectedInvariantIds: audit.protectedInvariantIds,
		}),
		completeRequirementUniverse: canonicalValue({
			provenRequirementIds: [...new Set(audit.goalMetricEvaluations.map((evaluation) => evaluation.requirementId))],
			unprovenRequirementIds: [],
			regressedRequirementIds: [],
		}),
		fixedBaseline: canonicalValue({
			stateDigest: request.currentState.sourceJournalDigest,
			sequence: request.currentState.sourceJournalSequence,
			pipelineStateDigest: audit.pipelineStateDigest,
			executionEvidenceStateDigest: audit.executionEvidenceStateDigest,
			adaptiveStateDigest: audit.adaptiveStateDigest,
			learningStateDigest: audit.learningStateDigest,
			knowledgeStateDigest: audit.knowledgeStateDigest,
		}),
		capacityLedger: canonicalValue(resources.capacityLedgerSource),
		hiddenFailure: canonicalValue({
			failedStrategies: request.currentState.failedStrategies,
			unresolvedDecisionRefs: request.currentState.unresolvedDecisionRefs,
		}),
		requirementEvidence: canonicalValue({
			acceptedEvidenceRefs: request.outcome.outcome.evidenceRefs,
			stageEvidence: audit.stageEvidence,
		}),
	};
	const readinessBase: Omit<
		WorkflowCompletionReadinessReceipt,
		"adjudicationReceipt" | "hostReceipt" | "receiptDigest"
	> = {
		workflowId: request.workflowId,
		inputStateDigest: request.currentState.sourceJournalDigest,
		outcomeDigest: digestObject(request.outcome.outcome),
		outputStateDigest,
		outputDigest: digestObject(request.outcome.outcome.artifactRefs),
		evidenceDigest: digestObject(request.outcome.outcome.evidenceRefs),
		requirementEvidenceDigest: digestObject(digestSources.requirementEvidence),
		objectiveDigest: digestObject(digestSources.objective),
		hardenedContractDigest: digestObject(digestSources.hardenedContract),
		completeRequirementUniverseDigest: digestObject(digestSources.completeRequirementUniverse),
		fixedBaselineDigest: digestObject(digestSources.fixedBaseline),
		capacityLedgerDigest: digestObject(digestSources.capacityLedger),
		hiddenFailureDigest: digestObject(digestSources.hiddenFailure),
		freshVerifierDecisionRef: verifier.ref,
		independentRedTeamDecisionRef: redTeam.ref,
		usageReconciliationRef: resources.usageReconciliationRef,
		capacityReconciliationRef: resources.capacityReconciliationRef,
		verdict: "ready",
	};
	const bindingInput = {
		workflowId: request.workflowId,
		inputStateDigest: request.currentState.sourceJournalDigest,
		headSequence: request.currentState.sourceJournalSequence,
		epochRef: request.epochRef,
		outcomeDigest: readinessBase.outcomeDigest,
		outputDigest: readinessBase.outputDigest,
		evidenceDigest: readinessBase.evidenceDigest,
		requirementEvidenceDigest: readinessBase.requirementEvidenceDigest,
		objectiveDigest: readinessBase.objectiveDigest,
		hardenedContractDigest: readinessBase.hardenedContractDigest,
		completeRequirementUniverseDigest: readinessBase.completeRequirementUniverseDigest,
		fixedBaselineDigest: readinessBase.fixedBaselineDigest,
		capacityLedgerDigest: readinessBase.capacityLedgerDigest,
		hiddenFailureDigest: readinessBase.hiddenFailureDigest,
		usageReconciliationRef: resources.usageReconciliationRef,
		capacityReconciliationRef: resources.capacityReconciliationRef,
		freshVerifierDecisionRef: verifier.ref,
		independentRedTeamDecisionRef: redTeam.ref,
	};
	const [hostReceipt, adjudicationReceipt] = await Promise.all([
		input.issueReceipt({
			receiptKind: "decision",
			workflowId: request.workflowId,
			bindingDigest: workflowCompletionReadinessReceiptBindingDigest(bindingInput),
			oneUse: true,
			stateDigest: request.currentState.sourceJournalDigest,
			revision: request.currentState.sourceJournalSequence,
		}),
		input.issueReceipt({
			receiptKind: "adjudication",
			workflowId: request.workflowId,
			bindingDigest: workflowCompletionAdjudicationReceiptBindingDigest(bindingInput),
			oneUse: true,
			stateDigest: request.currentState.sourceJournalDigest,
			revision: request.currentState.sourceJournalSequence,
		}),
	]);
	const readiness: WorkflowCompletionReadinessReceipt = {
		...readinessBase,
		hostReceipt,
		adjudicationReceipt,
		receiptDigest: "",
	};
	readiness.receiptDigest = digestObject({ ...readiness, receiptDigest: "" });
	return {
		readiness,
		digestSources,
		decisions: new Map([
			[verifier.ref.decisionId, verifier.decision],
			[redTeam.ref.decisionId, redTeam.decision],
		]),
		auditDigest: digestObject(audit),
	};
}

/** Build the default completion evaluator over already-authenticated workflow evidence. */
export function createDefaultPrimeCompletionReadinessAuthority(
	input: DefaultPrimeCompletionAuthorityInput,
): PersistedWorkflowCompletionReadinessAuthority {
	const evaluations = new Map<string, Promise<DefaultPrimeCompletionEvaluation>>();
	const ensureEvaluation = (
		request: WorkflowCompletionReadinessResolverInput,
	): Promise<DefaultPrimeCompletionEvaluation> => {
		const key = digestObject({
			workflowId: request.workflowId,
			inputStateDigest: request.inputStateDigest,
			epochRef: request.epochRef,
			outcome: request.outcome,
		});
		const existing = evaluations.get(key);
		if (existing !== undefined) return existing;
		const created = buildEvaluation(input, request);
		evaluations.set(key, created);
		return created;
	};
	const validationRequest = (
		request: WorkflowCompletionCanonicalValidationInput,
	): WorkflowCompletionReadinessResolverInput => ({
		workflowId: request.workflowId,
		inputStateDigest: request.currentState.sourceJournalDigest,
		epochRef: request.currentEpoch,
		outcome: request.outcome,
		currentState: request.currentState,
	});
	const validateCanonical = async (request: WorkflowCompletionCanonicalValidationInput): Promise<void> => {
		const evaluation = await ensureEvaluation(validationRequest(request));
		if (
			request.readiness.receiptDigest !== evaluation.readiness.receiptDigest ||
			digestObject(request.digestSources) !== digestObject(evaluation.digestSources) ||
			evaluation.auditDigest !== digestObject(await input.readAuditContext())
		)
			throw new Error("default_prime_completion_canonical_evaluation_changed");
	};
	return Object.freeze({
		resolveReadiness: async (request) => (await ensureEvaluation(request)).readiness,
		resolveDigestSources: async (request) =>
			(
				await ensureEvaluation({
					workflowId: request.workflowId,
					inputStateDigest: request.inputStateDigest,
					epochRef: request.epochRef,
					outcome: request.outcome,
					currentState: request.currentState,
				})
			).digestSources,
		resolveDecision: async (request) => {
			for (const evaluation of evaluations.values()) {
				const decision = (await evaluation).decisions.get(request.decisionRef.decisionId);
				if (decision !== undefined && digestObject(decision) === request.decisionRef.decisionDigest)
					return decision;
			}
			throw new Error("default_prime_completion_decision_not_found");
		},
		validateDecision: async (decision) => {
			for (const evaluation of evaluations.values()) {
				const expected = (await evaluation).decisions.get(decision.decisionId);
				if (expected !== undefined && digestObject(expected) === digestObject(decision)) return;
			}
			throw new Error("default_prime_completion_decision_not_authorized");
		},
		validateEvidence: validateCanonical,
		validateScorecard: validateCanonical,
		validateProgress: validateCanonical,
		validateResources: validateCanonical,
	});
}
