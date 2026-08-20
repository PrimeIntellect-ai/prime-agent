import { randomUUID } from "node:crypto";
import type { AutoResearchProductionRunner, AutoResearchPythonResult } from "../autoresearch/runner.js";
import {
	createAutoResearchRunHostHandler,
	createAutoResearchWorkflowRuntimeAdapter,
} from "../autoresearch/runtime-adapter.js";
import type { AutoResearchRuntimePort } from "../autoresearch/types.js";
import type {
	HostRequestCapabilityContext,
	HostRequestContext,
	HostRequestHandler,
	HostRequestHandlers,
} from "../kernel/index.js";
import { createKnowledgeDurableStore } from "../knowledge/knowledge-durable-adapter.js";
import {
	createKnowledgeStore,
	type KnowledgeHostVerification,
	type KnowledgeStore,
} from "../knowledge/knowledge-store.js";
import { createKnowledgeMempalaceBoundary, type KnowledgeMempalaceBoundary } from "../knowledge/mempalace-boundary.js";
import {
	KNOWLEDGE_KINDS,
	type KnowledgeKind,
	type KnowledgeProcedure,
	type KnowledgeProposal,
} from "../knowledge/records.js";
import type { PrimeAdaptiveRuntime } from "./adaptive-runtime.js";
import { resolveWorkflowRuntimeConfig } from "./config.js";
import type {
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowEpochRef,
	WorkflowEvidenceEnvelopeRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowLeaseRef,
	WorkflowRuntimeConfigSnapshot,
	WorkflowRuntimeStore,
	WorkflowStoreReplayResult,
	WorkflowTrustedPrincipal,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "./contracts.js";
import type { WorkflowExecutionEvidenceRuntime } from "./execution-evidence.js";
import type { WorkflowLearningRuntimeAdapter } from "./learning-runtime-adapter.js";
import {
	isWorkflowRecipeAdmissionConsumptionProof,
	validateWorkflowRecipeAdmission,
	type WorkflowRecipeAdmissionArtifact,
	type WorkflowRecipeAdmissionConsumptionProof,
} from "./recipes.js";
import type { WorkflowRuntimeRecoveryReadiness, WorkflowRuntimeRecoveryStartResult } from "./runtime-recovery.js";
import type { WorkflowScheduler, WorkflowSchedulerState } from "./scheduler.js";
import type { WorkflowShellStatus } from "./shell.js";
import {
	isWorkflowSkillProductionExecutionAdapter,
	validateSkillSnapshot,
	type WorkflowSkillExecutor,
	type WorkflowSkillHostInvocationContext,
	type WorkflowSkillInvocationValidationOptions,
	type WorkflowSkillProductionExecutionAdapter,
	type WorkflowSkillSnapshot,
} from "./skill-snapshots.js";
import type { WorkflowTaskGraph } from "./task-graph.js";

const PRIME_RUNTIME_VERSION = "0.147.0-alpha.10";
const CAPABILITY_TTL_MS = 60_000;
const AUTHENTICATED_ADAPTERS = new WeakSet<object>();
const AUTHENTICATED_ADAPTER_RUNTIME_STORES = new WeakMap<object, WorkflowRuntimeStore>();

/** Required production composition order; construction owners must provide each authenticated port. */
export const PRIME_WORKFLOW_INITIALIZATION_ORDER = Object.freeze([
	"authenticated_replay",
	"recovery",
	"snapshots",
	"decision_approval_goal",
	"completion",
	"scheduler_resources",
	"knowledge_mempalace",
	"learning",
	"autoresearch",
	"phase_host",
	"agent_session_binding",
	"planner_continuity",
] as const);

export type PrimeWorkflowInitializationStep = (typeof PRIME_WORKFLOW_INITIALIZATION_ORDER)[number];

export interface PrimeWorkflowSnapshots {
	readonly config: WorkflowRuntimeConfigSnapshot;
	readonly recipe: WorkflowRecipeAdmissionArtifact;
	readonly skills: readonly WorkflowSkillSnapshot[];
}

/** Receipt-backed cursor over the exact stages in one admitted workflow recipe. */
export interface PrimeWorkflowPipelineState {
	readonly workflowId: string;
	readonly recipeDigest: string;
	readonly completedStageIds: readonly string[];
	readonly readyStageIds: readonly string[];
	readonly stateDigest: string;
}

/** Host-owned stage ledger. Recording a stage never authorizes goal progress or completion. */
export interface PrimeWorkflowPipelineRuntime {
	current(): PrimeWorkflowPipelineState;
	read(): Promise<PrimeWorkflowPipelineState>;
	record(input: {
		readonly stageId: string;
		readonly evidenceRefs: readonly WorkflowArtifactRef[];
	}): Promise<PrimeWorkflowPipelineState>;
}

/**
 * Authenticated adapters supplied by the owners of AutoResearch, MemPalace, and snapshots.
 * Each handler must already be bound to the same runtime store; this module only adds the
 * current-decision capability gate and never substitutes a journal scan or proposal stub.
 */
export interface PrimeWorkflowAuthenticatedAdapters {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly snapshots: PrimeWorkflowSnapshots;
	/** Authenticated owner transaction for the exact immutable recipe admission. */
	readonly consumeRecipeAdmission: (
		admission: WorkflowRecipeAdmissionArtifact,
	) => Promise<WorkflowRecipeAdmissionConsumptionProof>;
	readonly autoResearchHandler: HostRequestHandler;
	readonly mempalaceRecallHandler: HostRequestHandler;
	readonly mempalaceProposeHandler: HostRequestHandler;
	readonly pipelineRecordHandler?: HostRequestHandler;
	readonly learningReviewHandler?: HostRequestHandler;
	readonly learningRollbackHandler?: HostRequestHandler;
	readonly completionRequestHandler?: HostRequestHandler;
	readonly autoResearchRuntime?: AutoResearchRuntimePort;
	/** Optional host-owned production runner for real candidate/evidence execution. */
	readonly autoResearchRunner?: AutoResearchProductionRunner;
	readonly knowledgeStore?: KnowledgeStore;
	readonly mempalace?: KnowledgeMempalaceBoundary;
	/** Optional only as an explicit fail-closed capability: no scheduler is constructed when absent. */
	readonly scheduler?: WorkflowScheduler;
	/** Optional only as an explicit fail-closed capability: no reviewer is constructed when absent. */
	/** Must be supplied with the learning owner's durable promotion/rollback ports before learning is used. */
	readonly learning?: WorkflowLearningRuntimeAdapter;
	readonly pipeline?: PrimeWorkflowPipelineRuntime;
	readonly executionEvidence?: WorkflowExecutionEvidenceRuntime;
	readonly adaptiveRuntime?: PrimeAdaptiveRuntime;
	/** Must be supplied by the authenticated skill host before any skill invocation is admitted. */
	readonly skillExecution?: WorkflowSkillProductionExecutionAdapter;
}

export interface PrimeWorkflowNoActiveAttemptRecovery {
	readiness(): WorkflowRuntimeRecoveryReadiness;
	recoverBeforeResume(): Promise<WorkflowRuntimeRecoveryStartResult>;
}

export interface ProductionPrimeWorkflowInput {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly artifactRoot: string;
	readonly readStatus: () => WorkflowShellStatus;
	readonly adapters: PrimeWorkflowAuthenticatedAdapters;
	readonly taskGraph?: WorkflowTaskGraph;
	readonly readSchedulerState?: () => Promise<WorkflowSchedulerState>;
	/** Host-owned fresh invocation seam; callers never provide token material. */
	readonly executeSkillIteration?: <TResult>(input: {
		readonly skillName: string;
		readonly current: WorkflowSkillHostInvocationContext;
		readonly executor: WorkflowSkillExecutor<TResult>;
	}) => Promise<TResult>;
	readonly recordSkillOutcome?: (skillName: string, result: Record<string, unknown>) => Promise<void>;
	readonly epochRef?: WorkflowEpochRef;
	readonly now?: () => number;
}

export interface ProductionPrimeWorkflow {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly artifactRoot: string;
	readonly runtimeVersion: string;
	readonly snapshots: PrimeWorkflowSnapshots;
	readonly taskGraph?: WorkflowTaskGraph;
	readonly readSchedulerState?: () => Promise<WorkflowSchedulerState>;
	/** Current host-authenticated recipe and evidence rules injected into every durable planner continuation. */
	readonly plannerDirective: string;
	readonly initializationOrder: readonly PrimeWorkflowInitializationStep[];
	readonly recovery: PrimeWorkflowNoActiveAttemptRecovery;
	readonly hostRequestHandlers: HostRequestHandlers;
	readonly resolveHostRequestCapability: (requestType: string) => HostRequestCapabilityContext;
	readonly autoResearchRuntime?: AutoResearchRuntimePort;
	readonly knowledgeStore?: KnowledgeStore;
	readonly mempalace?: KnowledgeMempalaceBoundary;
	readonly scheduler?: WorkflowScheduler;
	readonly learning?: WorkflowLearningRuntimeAdapter;
	readonly learningReviewHandler?: HostRequestHandler;
	readonly learningRollbackHandler?: HostRequestHandler;
	readonly completionRequestHandler?: HostRequestHandler;
	readonly pipeline?: PrimeWorkflowPipelineRuntime;
	readonly executionEvidence?: WorkflowExecutionEvidenceRuntime;
	readonly adaptiveRuntime?: PrimeAdaptiveRuntime;
	readonly skillExecution?: WorkflowSkillProductionExecutionAdapter;
	/** Execute only an admitted immutable snapshot through the authenticated skill adapter. */
	readonly executeSkill: <TResult>(input: {
		readonly snapshotDigest: string;
		readonly token: string | Readonly<Uint8Array>;
		readonly current: WorkflowSkillHostInvocationContext;
		readonly validationOptions?: WorkflowSkillInvocationValidationOptions;
		readonly executor: WorkflowSkillExecutor<TResult>;
	}) => Promise<TResult>;
	/** Execute one host-minted fresh invocation against an admitted built-in skill. */
	readonly executeSkillIteration: <TResult>(input: {
		readonly skillName: string;
		readonly current: WorkflowSkillHostInvocationContext;
		readonly executor: WorkflowSkillExecutor<TResult>;
	}) => Promise<TResult>;
	/** Record a verified skill result only after its authenticated execution effects pass. */
	readonly recordSkillOutcome?: (skillName: string, result: Record<string, unknown>) => Promise<void>;
	/** Subsystems omitted by the host are explicitly unavailable rather than silently replaced. */
	readonly unavailableSubsystems: readonly (
		| "scheduler_resources"
		| "learning"
		| "pipeline"
		| "execution_evidence"
		| "skill_execution"
	)[];
}

export interface PrimeWorkflowBuiltinHostDependencies {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly epochRef: WorkflowEpochRef;
	readonly runId: string;
	readonly executionKey: string;
	readonly writerIdentity: string;
	readonly resolveLeaseRef: () => Promise<WorkflowLeaseRef>;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly issueReceipt: (input: {
		readonly receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
		readonly workflowId: string;
		readonly bindingDigest: string;
		readonly issuedAt?: string;
		readonly stateDigest?: string;
		readonly revision?: number;
		readonly payloadKind?: "workflow-resource-loader" | "workflow-recipe" | "workflow-learning";
		readonly payloadDigest?: string;
	}) => Promise<WorkflowVerifiedHostReceipt>;
	readonly now?: () => string;
	readonly scheduler?: WorkflowScheduler;
	readonly learning?: WorkflowLearningRuntimeAdapter;
	readonly learningReviewHandler?: HostRequestHandler;
	readonly learningRollbackHandler?: HostRequestHandler;
	readonly completionRequestHandler?: HostRequestHandler;
	readonly pipeline?: PrimeWorkflowPipelineRuntime;
	readonly executionEvidence?: WorkflowExecutionEvidenceRuntime;
	readonly adaptiveRuntime?: PrimeAdaptiveRuntime;
	readonly skillExecution?: WorkflowSkillProductionExecutionAdapter;
	/** Opaque authority issued by the persisted session composition root. */
	readonly authority: PrimeWorkflowHostAuthority;
}

export interface PrimeWorkflowBuiltinAdapterInput extends PrimeWorkflowBuiltinHostDependencies {
	readonly snapshots: PrimeWorkflowSnapshots;
	/** Authenticated owner transaction for the exact immutable recipe admission. */
	readonly consumeRecipeAdmission: (
		admission: WorkflowRecipeAdmissionArtifact,
	) => Promise<WorkflowRecipeAdmissionConsumptionProof>;
	/** Host-owned active goal/status projection used to bind evidence and knowledge. */
	readonly readStatus?: () => WorkflowShellStatus;
	/** Host-owned production runner; when present it is the only AutoResearch execution path. */
	readonly autoResearchRunner?: AutoResearchProductionRunner;
}

/** Store-bound context handed to a production adapter factory. */
export type PrimeWorkflowAuthenticatedAdapterFactoryInput = Omit<
	PrimeWorkflowBuiltinAdapterInput,
	"runId" | "executionKey" | "consumeRecipeAdmission"
>;

const primeWorkflowHostAuthorityBrand: unique symbol = Symbol("prime-workflow-host-authority");
const primeWorkflowHostAuthorityBindings = new WeakMap<
	object,
	{
		readonly runtimeStore: WorkflowRuntimeStore;
		readonly workflowId: string;
		readonly artifactResolver: WorkflowArtifactResolver;
		readonly epochRef: WorkflowEpochRef;
		readonly writerIdentity: string;
		readonly resolveLeaseRef: () => Promise<WorkflowLeaseRef>;
		readonly receiptContext: WorkflowHostReceiptConsumerContext;
		readonly issueReceipt: PrimeWorkflowBuiltinHostDependencies["issueReceipt"];
	}
>();

type PrimeWorkflowHostAuthorityInput = Pick<
	PrimeWorkflowBuiltinHostDependencies,
	| "runtimeStore"
	| "workflowId"
	| "artifactResolver"
	| "epochRef"
	| "writerIdentity"
	| "resolveLeaseRef"
	| "receiptContext"
	| "issueReceipt"
>;

/** Opaque host-issued binding required before a Prime adapter can be authenticated. */
export interface PrimeWorkflowHostAuthority {
	readonly [primeWorkflowHostAuthorityBrand]: true;
	readonly workflowId: string;
}

/**
 * Issue the adapter binding for one opened persisted session.
 *
 * Args:
 * input: Exact store, resolver, receipt, epoch, and lease seams owned by the session host.
 * Return: Opaque authority that can authenticate only those exact seams.
 */
export function createPrimeWorkflowHostAuthority(input: PrimeWorkflowHostAuthorityInput): PrimeWorkflowHostAuthority {
	if (input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new Error("prime_workflow_host_authority_store_mismatch");
	if (input.runtimeStore.durableContext === undefined)
		throw new Error("prime_workflow_host_authority_requires_persisted_runtime");
	if (input.epochRef.storeEpoch < 1 || input.epochRef.coordinatorEpoch < 1)
		throw new Error("prime_workflow_host_authority_epoch_invalid");
	if (input.writerIdentity.length === 0) throw new Error("prime_workflow_host_authority_writer_invalid");
	const authority = Object.freeze({
		[primeWorkflowHostAuthorityBrand]: true as const,
		workflowId: input.workflowId,
	});
	primeWorkflowHostAuthorityBindings.set(authority, {
		runtimeStore: input.runtimeStore,
		workflowId: input.workflowId,
		artifactResolver: input.artifactResolver,
		epochRef: { ...input.epochRef },
		writerIdentity: input.writerIdentity,
		resolveLeaseRef: input.resolveLeaseRef,
		receiptContext: input.receiptContext,
		issueReceipt: input.issueReceipt,
	});
	return authority;
}

function assertPrimeWorkflowHostAuthority(
	authority: PrimeWorkflowHostAuthority,
	input: PrimeWorkflowBuiltinHostDependencies,
): void {
	const binding =
		typeof authority === "object" && authority !== null
			? primeWorkflowHostAuthorityBindings.get(authority)
			: undefined;
	if (
		binding === undefined ||
		(authority as unknown as Record<PropertyKey, unknown>)[primeWorkflowHostAuthorityBrand] !== true ||
		binding.runtimeStore !== input.runtimeStore ||
		binding.workflowId !== input.workflowId ||
		binding.artifactResolver !== input.artifactResolver ||
		binding.writerIdentity !== input.writerIdentity ||
		binding.resolveLeaseRef !== input.resolveLeaseRef ||
		binding.receiptContext !== input.receiptContext ||
		binding.issueReceipt !== input.issueReceipt ||
		binding.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		binding.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
	)
		throw new Error("prime_workflow_host_authority_mismatch");
}

/**
 * Host-owned adapter factory used when the persisted session binds Prime.
 *
 * The factory receives the exact store, receipt authority, lease, and artifact
 * resolver opened by the session host.  It is intentionally caller supplied so
 * a session cannot manufacture a run or execution identity while composing the
 * built-in handlers.
 */
export type PrimeWorkflowAuthenticatedAdapterFactory = (
	input: PrimeWorkflowAuthenticatedAdapterFactoryInput,
) => PrimeWorkflowAuthenticatedAdapters | Promise<PrimeWorkflowAuthenticatedAdapters>;

function recallBindingDigest(input: {
	workflowId: string;
	namespace: string;
	query: string;
	kind: KnowledgeKind | undefined;
	principal: WorkflowTrustedPrincipal;
}): string {
	return digestObject({
		kind: "knowledge-recall-clock-admission",
		workflowId: input.workflowId,
		namespace: input.namespace,
		query: input.query.trim().toLocaleLowerCase(),
		kindFilter: input.kind ?? null,
		scope: null,
		workspaceId: null,
		sessionId: null,
		userId: null,
		pathPrefix: null,
		privacyAtMost: "public",
		principal: input.principal,
	});
}

function toKernelArtifactRef(ref: WorkflowArtifactRef): Record<string, unknown> {
	return {
		artifact_id: ref.artifactId,
		relative_path: ref.relativePath,
		digest: ref.digest,
		size_bytes: ref.sizeBytes,
		source_event_sequence: ref.sourceEventSequence,
	};
}

function kernelSkillOutput(input: {
	skillId: "autoresearch" | "mempalace";
	outputKind: "evidence" | "knowledge_proposal";
	evidenceRefs: readonly WorkflowArtifactRef[];
	durableKnowledgeBoundaryDigest: string | null;
}): Record<string, unknown> {
	const unsigned = {
		skill_id: input.skillId,
		output_kind: input.outputKind,
		evidence_refs: input.evidenceRefs.slice(0, 32).map(toKernelArtifactRef),
		durable_knowledge_boundary_digest: input.durableKnowledgeBoundaryDigest,
		transient_state_refs: [],
		can_authorize: false,
	};
	return { ...unsigned, output_digest: digestObject(unsigned) };
}

function autoResearchPythonResultToKernelRecord(result: AutoResearchPythonResult): Record<string, unknown> {
	return {
		skill_id: result.skill_id,
		output_kind: result.output_kind,
		evidence_refs: result.evidence_refs,
		durable_knowledge_boundary_digest: result.durable_knowledge_boundary_digest,
		transient_state_refs: result.transient_state_refs,
		can_authorize: result.can_authorize,
		output_digest: result.output_digest,
	};
}

function parseKernelArtifactRef(value: unknown, label: string): WorkflowArtifactRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label}_invalid`);
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !==
			["artifact_id", "digest", "relative_path", "size_bytes", "source_event_sequence"].sort().join(",") ||
		typeof record.artifact_id !== "string" ||
		typeof record.relative_path !== "string" ||
		typeof record.digest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.digest) ||
		!/^artifacts\/[A-Za-z0-9][A-Za-z0-9._:-]*\/[0-9a-f]{64}$/u.test(record.relative_path) ||
		!Number.isSafeInteger(record.size_bytes) ||
		!Number.isSafeInteger(record.source_event_sequence) ||
		(record.size_bytes as number) < 0 ||
		(record.source_event_sequence as number) < 0
	)
		throw new Error(`${label}_invalid`);
	return {
		artifactId: record.artifact_id,
		relativePath: record.relative_path,
		digest: record.digest,
		sizeBytes: record.size_bytes as number,
		sourceEventSequence: record.source_event_sequence as number,
	};
}

function parseKnowledgeText(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars)
		throw new Error(`${label}_invalid`);
	return value;
}

function parseKnowledgeProcedure(value: unknown): KnowledgeProcedure {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		throw new Error("prime_workflow_mempalace_procedure_invalid");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== ["failureChecks", "inputs", "steps", "successChecks"].sort().join(",") ||
		record.inputs === null ||
		typeof record.inputs !== "object" ||
		Array.isArray(record.inputs) ||
		Object.keys(record.inputs as Record<string, unknown>).length > 256
	)
		throw new Error("prime_workflow_mempalace_procedure_invalid");
	const inputs: Record<string, string> = {};
	for (const [name, input] of Object.entries(record.inputs as Record<string, unknown>)) {
		if (name.length === 0 || name.length > 256) throw new Error("prime_workflow_mempalace_procedure_input_invalid");
		inputs[name] = parseKnowledgeText(input, "prime_workflow_mempalace_procedure_input", 4_000);
	}
	const parseList = (field: "steps" | "successChecks" | "failureChecks"): string[] => {
		const values = record[field];
		if (!Array.isArray(values) || values.length < 1 || values.length > 256)
			throw new Error(`prime_workflow_mempalace_procedure_${field}_invalid`);
		return values.map((item, index) =>
			parseKnowledgeText(item, `prime_workflow_mempalace_procedure_${field}_${index}`, 4_000),
		);
	};
	return {
		inputs,
		steps: parseList("steps"),
		successChecks: parseList("successChecks"),
		failureChecks: parseList("failureChecks"),
	};
}

interface KnowledgeEvidenceLearning {
	objective: string;
	acceptanceCheckIds: readonly string[];
	protectedInvariantIds: readonly string[];
	candidateId: string;
	attemptId: string;
	visibleInputDigests: readonly string[];
	metricValue: number | null;
	baselineMetricValue: number | null;
}

function deriveKnowledgeEvidenceLearning(
	values: readonly unknown[],
	status: WorkflowShellStatus,
	workflowId: string,
): KnowledgeEvidenceLearning {
	const objective = status.goal.objective;
	if (typeof objective !== "string" || objective.trim().length === 0)
		throw new Error("prime_workflow_mempalace_goal_objective_missing");
	const expectedGoalBindingDigest = digestObject({
		workflowId,
		objective,
		acceptanceCheckIds: status.acceptanceCheckIds,
		protectedInvariantIds: status.protectedInvariantIds,
	});
	let goalBindingSeen = false;
	let candidateId = "";
	let attemptId = "";
	let visibleInputDigests: readonly string[] = [];
	let metricValue: number | null = null;
	let baselineMetricValue: number | null = null;
	const visit = (value: unknown, depth: number): void => {
		if (depth > 8 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item, depth + 1);
			return;
		}
		const record = value as Record<string, unknown>;
		if (typeof record.workflowId === "string" && record.workflowId !== workflowId)
			throw new Error("prime_workflow_mempalace_evidence_workflow_mismatch");
		if (record.goalBindingDigest === expectedGoalBindingDigest) goalBindingSeen = true;
		if (typeof record.objective === "string" && record.objective !== objective)
			throw new Error("prime_workflow_mempalace_evidence_objective_mismatch");
		if (typeof record.candidateId === "string" && record.candidateId.length > 0) candidateId = record.candidateId;
		if (typeof record.attemptId === "string" && record.attemptId.length > 0) attemptId = record.attemptId;
		if (
			Array.isArray(record.visibleInputDigests) &&
			record.visibleInputDigests.every((item): item is string => typeof item === "string")
		)
			visibleInputDigests = [...record.visibleInputDigests];
		if (typeof record.metricValue === "number" && Number.isFinite(record.metricValue))
			metricValue = record.metricValue;
		if (typeof record.baselineMetricValue === "number" && Number.isFinite(record.baselineMetricValue))
			baselineMetricValue = record.baselineMetricValue;
		for (const child of Object.values(record)) visit(child, depth + 1);
	};
	for (const value of values) visit(value, 0);
	if (!goalBindingSeen) throw new Error("prime_workflow_mempalace_evidence_goal_binding_missing");
	if (candidateId.length === 0 || attemptId.length === 0 || visibleInputDigests.length === 0)
		throw new Error("prime_workflow_mempalace_evidence_candidate_binding_missing");
	return {
		objective,
		acceptanceCheckIds: [...status.acceptanceCheckIds],
		protectedInvariantIds: [...status.protectedInvariantIds],
		candidateId,
		attemptId,
		visibleInputDigests,
		metricValue,
		baselineMetricValue,
	};
}

/**
 * Build bounded built-in kernel adapters over the already-open workflow authority.
 *
 * Args:
 * input: One runtime store, authenticated artifact/receipt seams, and caller-authenticated snapshots.
 * Return: Native AutoResearch runtime, canonical KnowledgeStore/MemPalace recall, and non-authorizing proposals.
 */
export function createPrimeWorkflowBuiltinAdapters(
	input: PrimeWorkflowBuiltinAdapterInput,
): PrimeWorkflowAuthenticatedAdapters {
	assertPrimeWorkflowHostAuthority(input.authority, input);
	if (input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new Error("prime_workflow_runtime_store_binding_invalid");
	if (input.runtimeStore.durableContext === undefined) throw new Error("prime_workflow_durable_runtime_required");
	if (input.epochRef.storeEpoch < 1 || input.epochRef.coordinatorEpoch < 1)
		throw new Error("prime_workflow_epoch_invalid");
	if (input.runId.length === 0 || input.executionKey.length === 0 || input.writerIdentity.length === 0)
		throw new Error("prime_workflow_execution_identity_invalid");
	if (typeof input.consumeRecipeAdmission !== "function")
		throw new Error("prime_workflow_recipe_admission_consumer_required");
	const durableEpoch = input.runtimeStore.durableContext.epochRef;
	if (
		durableEpoch.storeEpoch !== input.epochRef.storeEpoch ||
		durableEpoch.coordinatorEpoch !== input.epochRef.coordinatorEpoch
	)
		throw new Error("prime_workflow_epoch_store_mismatch");
	const snapshots = cloneSnapshots(input.snapshots);
	if (
		input.skillExecution !== undefined &&
		!isWorkflowSkillProductionExecutionAdapter(input.skillExecution, input.runtimeStore)
	)
		throw new Error("prime_workflow_skill_execution_adapter_unbound");
	const autoResearchRuntime = createAutoResearchWorkflowRuntimeAdapter({
		runtimeStore: input.runtimeStore,
		artifactResolver: input.artifactResolver,
		workflowId: input.workflowId,
		runId: input.runId,
		executionKey: input.executionKey,
		writerIdentity: input.writerIdentity,
		resolveLeaseRef: input.resolveLeaseRef,
	});
	const autoResearchHandler = createAutoResearchRunHostHandler(
		async (request) => {
			if (request.cellSourceCode !== undefined) throw new Error("prime_workflow_autoresearch_execution_unavailable");
			if (request.recipeDigest !== snapshots.recipe.recipeDigest)
				throw new Error("prime_workflow_autoresearch_recipe_mismatch");
			if (input.autoResearchRunner !== undefined)
				return autoResearchPythonResultToKernelRecord(
					await input.autoResearchRunner.run({
						recipeDigest: request.recipeDigest,
						evidenceRefs: request.evidenceRefs,
					}),
				);
			const records = await autoResearchRuntime.replay();
			return kernelSkillOutput({
				skillId: "autoresearch",
				outputKind: "evidence",
				evidenceRefs: request.evidenceRefs,
				durableKnowledgeBoundaryDigest: digestObject({
					kind: "autoresearch_runtime_observation",
					recipeDigest: request.recipeDigest,
					runtimeRecordCount: records.length,
				}),
			});
		},
		{
			runtimeStore: input.runtimeStore,
			artifactResolver: input.artifactResolver,
			workflowId: input.workflowId,
			executionKey: input.executionKey,
			writerIdentity: input.writerIdentity,
			resolveLeaseRef: input.resolveLeaseRef,
			receiptContext: input.receiptContext,
		},
	);
	const namespace = "prime";
	const durableStore = createKnowledgeDurableStore({
		runtimeStore: input.runtimeStore,
		namespace,
		epochRef: input.epochRef,
	});
	const issueKnowledgeValidationReceipt = async (validationInput: {
		readonly receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
		readonly bindingDigest: string;
		readonly stateDigest: string;
		readonly revision: number;
		readonly issuedAt: string;
	}): Promise<KnowledgeHostVerification> => ({
		receipt: await input.issueReceipt({
			receiptKind: validationInput.receiptKind,
			workflowId: input.workflowId,
			bindingDigest: validationInput.bindingDigest,
			issuedAt: validationInput.issuedAt,
			stateDigest: validationInput.stateDigest,
			revision: Math.max(1, validationInput.revision),
			payloadKind: "workflow-learning",
			payloadDigest: validationInput.stateDigest,
		}),
		context: input.receiptContext,
	});
	const knowledgeStore = createKnowledgeStore({
		durableStore,
		namespace,
		receiptContext: input.receiptContext,
		trustedNow: input.now,
		validateDecision: (_reference, _proposal, context) =>
			issueKnowledgeValidationReceipt({
				receiptKind: "decision",
				bindingDigest: context.bindingDigest,
				stateDigest: context.currentStateDigest,
				revision: context.expectedHead.sequence,
				issuedAt: context.trustedNow,
			}),
		validateEvidence: (_reference, _proposal, context) =>
			issueKnowledgeValidationReceipt({
				receiptKind: "artifact",
				bindingDigest: context.bindingDigest,
				stateDigest: context.currentStateDigest,
				revision: context.expectedHead.sequence,
				issuedAt: context.trustedNow,
			}),
		validateSecretScan: (_receipt, _proposal, context) =>
			issueKnowledgeValidationReceipt({
				receiptKind: "artifact",
				bindingDigest: context.bindingDigest,
				stateDigest: context.currentStateDigest,
				revision: context.expectedHead.sequence,
				issuedAt: context.trustedNow,
			}),
		deriveTombstoneFingerprint: async (context) => ({
			fingerprint: digestObject({
				kind: "knowledge-tombstone-fingerprint",
				workflowId: context.workflowId,
				recordId: context.recordId,
				revision: context.revision,
				proposalDigest: context.proposalDigest,
			}),
			...(await issueKnowledgeValidationReceipt({
				receiptKind: "artifact",
				bindingDigest: context.bindingDigest,
				stateDigest: context.currentStateDigest,
				revision: context.currentRevision,
				issuedAt: context.trustedNow,
			})),
		}),
	});
	const mempalace = createKnowledgeMempalaceBoundary({ store: knowledgeStore, now: input.now });
	const principal: WorkflowTrustedPrincipal = {
		kind: "interactive_ui",
		principalId: input.rootSessionId,
		credentialDigest: digestObject({ kind: "workflow-ui-principal", workflowId: input.workflowId }),
	};
	const mempalaceRecallHandler: HostRequestHandler = async (payload) => {
		if (typeof payload.query !== "string" || payload.query.trim().length === 0)
			throw new Error("prime_workflow_mempalace_query_invalid");
		if (!Number.isSafeInteger(payload.limit) || (payload.limit as number) < 1 || (payload.limit as number) > 5)
			throw new Error("prime_workflow_mempalace_limit_invalid");
		const kind = payload.knowledge_kind === undefined ? undefined : (payload.knowledge_kind as KnowledgeKind);
		const state = await knowledgeStore.read();
		const receipt = await input.issueReceipt({
			receiptKind: "clock",
			workflowId: input.workflowId,
			bindingDigest: recallBindingDigest({
				workflowId: input.workflowId,
				namespace,
				query: payload.query,
				kind,
				principal,
			}),
			stateDigest: digestObject(state),
			revision: Math.max(state.sequence, 1),
			payloadKind: "workflow-learning",
			payloadDigest: digestObject(state),
		});
		const records = await mempalace.recall({
			query: payload.query,
			principal,
			trustedClockReceipt: receipt,
			...(kind === undefined ? {} : { kind }),
			route: "direct",
			privacyAtMost: "public",
		});
		const evidenceRefs = records
			.slice(0, payload.limit as number)
			.flatMap((record) => record.evidenceRefs.flatMap((evidence) => evidence.artifactRefs));
		const uniqueEvidenceRefs = [...new Map(evidenceRefs.map((ref) => [digestObject(ref), ref])).values()];
		return kernelSkillOutput({
			skillId: "mempalace",
			outputKind: "evidence",
			evidenceRefs: uniqueEvidenceRefs,
			durableKnowledgeBoundaryDigest: digestObject(state),
		});
	};
	const mempalaceProposeHandler: HostRequestHandler = async (payload) => {
		if (
			typeof payload.knowledge_kind !== "string" ||
			!KNOWLEDGE_KINDS.includes(payload.knowledge_kind as KnowledgeKind)
		)
			throw new Error("prime_workflow_mempalace_kind_invalid");
		if (!Array.isArray(payload.source_evidence_refs) || payload.source_evidence_refs.length < 1)
			throw new Error("prime_workflow_mempalace_evidence_refs_invalid");
		const sourceEvidenceRefs = payload.source_evidence_refs.map((value, index) =>
			parseKernelArtifactRef(value, `prime_workflow_mempalace_evidence_ref_${index}`),
		);
		const uniqueSourceEvidenceRefs = [...new Map(sourceEvidenceRefs.map((ref) => [digestObject(ref), ref])).values()];
		if (uniqueSourceEvidenceRefs.length !== sourceEvidenceRefs.length)
			throw new Error("prime_workflow_mempalace_evidence_refs_duplicate");
		const sourceEvidenceValues: unknown[] = [];
		for (const ref of uniqueSourceEvidenceRefs) {
			const resolved = await input.artifactResolver.resolve(ref);
			if (
				!resolved.exists ||
				resolved.verifiedDigest !== ref.digest ||
				resolved.verifiedSizeBytes !== ref.sizeBytes ||
				resolved.envelope.ref.sourceEventSequence !== ref.sourceEventSequence
			)
				throw new Error("prime_workflow_mempalace_evidence_ref_unresolved");
			try {
				sourceEvidenceValues.push(parseCanonicalJsonBytes(resolved.bytes));
			} catch (error) {
				throw new Error("prime_workflow_mempalace_evidence_content_invalid", { cause: error });
			}
		}
		if (input.readStatus === undefined) throw new Error("prime_workflow_mempalace_goal_status_unavailable");
		const learning = deriveKnowledgeEvidenceLearning(sourceEvidenceValues, input.readStatus(), input.workflowId);
		const suppliedTitle =
			payload.title === undefined
				? `Host-authenticated method for ${learning.objective}`
				: parseKnowledgeText(payload.title, "prime_workflow_mempalace_title", 256);
		const suppliedStatement =
			payload.statement === undefined
				? `For objective "${learning.objective}", candidate ${learning.candidateId} was executed against visible inputs ${learning.visibleInputDigests.join(", ")} and measured at ${learning.metricValue ?? "an authenticated host metric"} bytes against baseline ${learning.baselineMetricValue ?? "the authenticated baseline"}.`
				: parseKnowledgeText(payload.statement, "prime_workflow_mempalace_statement", 4_000);
		const suppliedProcedure =
			payload.procedure === undefined ? undefined : parseKnowledgeProcedure(payload.procedure);
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("prime_workflow_mempalace_head_unavailable");
		const currentState = await knowledgeStore.read();
		const baselineDigest = currentState.digest ?? digestObject(currentState);
		const revision = Math.max(1, replay.head.sequence);
		const decisionRef = {
			decisionScope: { kind: "knowledge" as const, namespace },
			decisionId: `mempalace:${input.workflowId}`,
			revision,
			storeEpoch: input.epochRef.storeEpoch,
			decisionDigest: digestObject({
				kind: "mempalace-knowledge-admission",
				workflowId: input.workflowId,
				head: replay.head,
				resourceDecision: payload.knowledge_kind,
			}),
		};
		const evidenceRefs: WorkflowEvidenceEnvelopeRef[] = [];
		for (const ref of uniqueSourceEvidenceRefs) {
			const envelopeDigest = digestObject({
				kind: "mempalace-source-evidence",
				workflowId: input.workflowId,
				head: replay.head,
				ref,
			});
			const validationReceipt = await input.issueReceipt({
				receiptKind: "artifact",
				workflowId: input.workflowId,
				bindingDigest: envelopeDigest,
				stateDigest: baselineDigest,
				revision,
			});
			evidenceRefs.push({
				workflowId: input.workflowId,
				envelopeId: `mempalace-envelope:${envelopeDigest}`,
				envelopeDigest,
				evidenceRevision: revision,
				artifactRefs: [ref],
				validationReceipt,
			});
		}
		const knowledgeKind = payload.knowledge_kind as KnowledgeKind;
		if (knowledgeKind !== "procedure" && suppliedProcedure !== undefined)
			throw new Error("prime_workflow_mempalace_procedure_kind_mismatch");
		const sourceDigest = digestObject(uniqueSourceEvidenceRefs);
		const proposalId = digestObject({
			kind: "mempalace-proposal",
			workflowId: input.workflowId,
			head: replay.head,
			knowledgeKind,
			sourceDigest,
		});
		const proposal: KnowledgeProposal = {
			proposalId,
			recordId: `mempalace:${proposalId}`,
			kind: knowledgeKind,
			title: suppliedTitle,
			statement: suppliedStatement,
			...(knowledgeKind === "procedure"
				? {
						procedure: suppliedProcedure ?? {
							inputs: {
								objective: learning.objective,
								candidateId: learning.candidateId,
								attemptId: learning.attemptId,
								visibleInputDigests: learning.visibleInputDigests.join(","),
							},
							steps: [
								`Bind candidate ${learning.candidateId} to objective "${learning.objective}" and the active acceptance checks.`,
								`Execute the host-approved candidate against visible inputs ${learning.visibleInputDigests.join(", ")}.`,
								`Measure the authenticated candidate evidence and evaluate it against the host baseline.`,
							],
							successChecks: [
								`The candidate evidence remains bound to workflow ${input.workflowId}.`,
								`The active acceptance checks remain ${learning.acceptanceCheckIds.join(", ")}.`,
							],
							failureChecks: [
								"Reject the result when its artifact receipt, objective binding, or host measurement is invalid.",
							],
						},
					}
				: {}),
			provenance: { source: "host", producerId: "mempalace" },
			applicability: { namespace, scope: "session", sessionId: input.rootSessionId },
			privacy: {
				class: "public",
				secretScan: await input.issueReceipt({
					receiptKind: "artifact",
					workflowId: input.workflowId,
					bindingDigest: digestObject({ kind: "mempalace-secret-scan", proposalId }),
					stateDigest: baselineDigest,
					revision,
				}),
			},
			retention: { class: "until-superseded" },
			confidence: "audited",
			decisionRef,
			evidenceRefs,
			epochRef: input.epochRef,
			action: "create",
			expectedRevision: null,
			rollbackRevision: null,
		};
		const leaseRef = await input.resolveLeaseRef();
		if (digestObject(leaseRef) !== digestObject(input.runtimeStore.durableContext?.currentLeaseRef()))
			throw new Error("prime_workflow_mempalace_lease_stale");
		const commitRequest = {
			mutationId: digestObject({ kind: "mempalace-commit", proposal, replayHead: replay.head }),
			idempotencyKey: `mempalace-commit:${proposalId}`,
			expectedHead: replay.head,
			baselineDigest,
			expectedGenerations: { workflow: input.epochRef.storeEpoch },
			writerIdentity: input.writerIdentity,
			leaseRef,
			epochRef: input.epochRef,
			executionKey: input.executionKey,
			knowledgeStoreEpoch: input.epochRef.storeEpoch,
			proposal,
		};
		const committed = await knowledgeStore.commit(commitRequest);
		return kernelSkillOutput({
			skillId: "mempalace",
			outputKind: "knowledge_proposal",
			evidenceRefs: uniqueSourceEvidenceRefs,
			durableKnowledgeBoundaryDigest: committed.authenticatedCommit.eventDigest,
		});
	};
	const pipeline = input.pipeline;
	const pipelineRecordHandler: HostRequestHandler | undefined =
		pipeline === undefined
			? undefined
			: async (payload) => {
					if (typeof payload.stage_id !== "string" || payload.stage_id.trim().length === 0)
						throw new Error("prime_workflow_pipeline_stage_invalid");
					if (!Array.isArray(payload.evidence_refs) || payload.evidence_refs.length < 1)
						throw new Error("prime_workflow_pipeline_evidence_refs_invalid");
					const evidenceRefs = payload.evidence_refs.map((value, index) =>
						parseKernelArtifactRef(value, `prime_workflow_pipeline_evidence_ref_${index}`),
					);
					const state = await pipeline.record({ stageId: payload.stage_id, evidenceRefs });
					return {
						workflow_id: state.workflowId,
						recipe_digest: state.recipeDigest,
						completed_stage_ids: [...state.completedStageIds],
						ready_stage_ids: [...state.readyStageIds],
						state_digest: state.stateDigest,
						can_authorize: false,
					};
				};
	const adapters: PrimeWorkflowAuthenticatedAdapters = Object.freeze({
		runtimeStore: input.runtimeStore,
		snapshots,
		consumeRecipeAdmission: input.consumeRecipeAdmission,
		autoResearchHandler,
		mempalaceRecallHandler,
		mempalaceProposeHandler,
		...(pipelineRecordHandler === undefined ? {} : { pipelineRecordHandler }),
		...(input.learningReviewHandler === undefined ? {} : { learningReviewHandler: input.learningReviewHandler }),
		...(input.learningRollbackHandler === undefined
			? {}
			: { learningRollbackHandler: input.learningRollbackHandler }),
		...(input.completionRequestHandler === undefined
			? {}
			: { completionRequestHandler: input.completionRequestHandler }),
		autoResearchRuntime,
		autoResearchRunner: input.autoResearchRunner,
		knowledgeStore,
		mempalace,
		scheduler: input.scheduler,
		learning: input.learning,
		pipeline: input.pipeline,
		executionEvidence: input.executionEvidence,
		adaptiveRuntime: input.adaptiveRuntime,
		skillExecution: input.skillExecution,
	});
	AUTHENTICATED_ADAPTERS.add(adapters);
	AUTHENTICATED_ADAPTER_RUNTIME_STORES.set(adapters, input.runtimeStore);
	return adapters;
}

function freezeDeep<T>(value: T): T {
	if (ArrayBuffer.isView(value)) return value;
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child);
		Object.freeze(value);
	}
	return value;
}

function cloneSnapshots(snapshots: PrimeWorkflowSnapshots): PrimeWorkflowSnapshots {
	const config = freezeDeep(structuredClone(snapshots.config));
	const closureMembers = parseCanonicalJsonBytes(config.closureManifestBytes);
	if (
		!Array.isArray(closureMembers) ||
		!closureMembers.every((member): member is string => typeof member === "string")
	)
		throw new Error("prime_workflow_config_closure_invalid");
	const resolvedConfig = resolveWorkflowRuntimeConfig({
		configSchemaVersion: config.configSchemaVersion,
		configRevision: config.configRevision,
		closureMembers,
		executionProfile: config.executionProfile,
		runtimeIdentityDigest: config.runtimeIdentityDigest,
		repositoryPolicyDigest: config.repositoryPolicyDigest,
		workspaceIdentityDigest: config.workspaceIdentityDigest,
		globalSettingsDigest: config.globalSettingsDigest,
		projectSettingsDigest: config.projectSettingsDigest,
		packageDefaultsDigest: config.packageDefaultsDigest,
		methodologyManifestDigests: config.methodologyManifestDigests,
		nativeMethodologyContractDigest: config.nativeMethodologyContractDigest,
		skillContentDigests: config.skillContentDigests,
		skillDependencyDigests: config.skillDependencyDigests,
		evaluatorDigests: config.evaluatorDigests,
		parserDigests: config.parserDigests,
		guardDigests: config.guardDigests,
		scorecardRuleDigest: config.scorecardRuleDigest,
		resourceInventoryDigest: config.resourceInventoryDigest,
		resourceEnvelopePolicyDigest: config.resourceEnvelopePolicyDigest,
		egressPolicyDigest: config.egressPolicyDigest,
		authorityPolicyDigest: config.authorityPolicyDigest,
		approvalPolicyDigest: config.approvalPolicyDigest,
		provenanceManifestDigest: config.provenanceManifestDigest,
		daemonCapabilityDigest: config.daemonCapabilityDigest,
		decisionLimitsDigest: config.decisionLimitsDigest,
		schedulerPolicyDigest: config.schedulerPolicyDigest,
		journalFormatDigest: config.journalFormatDigest,
		closureManifestRef: config.closureManifestRef,
		closureManifestBytes: config.closureManifestBytes,
	});
	if (resolvedConfig.resolvedConfigDigest !== config.resolvedConfigDigest)
		throw new Error("prime_workflow_config_snapshot_not_authenticated");
	if (snapshots.recipe.workflowId.length === 0 || snapshots.recipe.admissionDigest.length === 0)
		throw new Error("prime_workflow_recipe_admission_not_authenticated");
	validateWorkflowRecipeAdmission(snapshots.recipe);
	if (snapshots.skills.length === 0 && snapshots.config.skillContentDigests.length > 0)
		throw new Error("prime_workflow_skill_snapshots_missing");
	const skills = snapshots.skills.map((snapshot) => {
		validateSkillSnapshot(snapshot);
		if (!snapshots.config.skillContentDigests.includes(snapshot.contentDigest))
			throw new Error("prime_workflow_skill_snapshot_config_binding_invalid");
		if (
			snapshots.recipe.skillSnapshotDigests.length > 0 &&
			!snapshots.recipe.skillSnapshotDigests.includes(snapshot.snapshotDigest)
		)
			throw new Error("prime_workflow_skill_snapshot_admission_binding_invalid");
		return freezeDeep(structuredClone(snapshot));
	});
	const skillDigests = skills.map((skill) => skill.snapshotDigest);
	if (new Set(skillDigests).size !== skillDigests.length) throw new Error("prime_workflow_skill_snapshot_duplicate");
	const admittedSkillDigests = snapshots.recipe.skillSnapshotDigests;
	if (
		new Set(admittedSkillDigests).size !== admittedSkillDigests.length ||
		(admittedSkillDigests.length > 0 &&
			(admittedSkillDigests.length !== skillDigests.length ||
				admittedSkillDigests.some((digest) => !skillDigests.includes(digest))))
	)
		throw new Error("prime_workflow_skill_snapshot_membership_invalid");
	return Object.freeze({
		config,
		recipe: freezeDeep(structuredClone(snapshots.recipe)),
		skills: Object.freeze(skills),
	});
}

function primePlannerDirective(
	snapshots: PrimeWorkflowSnapshots,
	status: WorkflowShellStatus,
	pipelineState?: PrimeWorkflowPipelineState,
	executionEvidenceAvailable = false,
	adaptiveRuntime?: PrimeAdaptiveRuntime,
): string {
	const admission = snapshots.recipe;
	const proposal = admission.recipeBinding.proposal;
	const stages = proposal.stages.map(
		(stage, index) => `${index + 1}. ${stage.id} [role=${stage.role}; task=${stage.taskId}]`,
	);
	const edges = proposal.edges.map((edge) =>
		edge.kind === "back"
			? `${edge.from} -> ${edge.to} [back; gate=${edge.gateId ?? "missing"}]`
			: `${edge.from} -> ${edge.to}`,
	);
	const loops = (proposal.loops ?? []).map(
		(loop) =>
			`${loop.from} -> ${loop.to} [max=${loop.maxTraversals}; progress=${loop.progressEvidencePolicyId}; gate=${loop.gateId}]`,
	);
	return [
		"<prime_workflow>",
		`admission: ${admission.recipeId}@${admission.revision} digest=${admission.admissionDigest}`,
		"pipeline:",
		...stages,
		`topology: ${edges.length === 0 ? "none" : edges.join("; ")}`,
		`bounded loops: ${loops.length === 0 ? "none" : loops.join("; ")}`,
		`completed stages: ${pipelineState?.completedStageIds.join(", ") || "none"}`,
		`ready stages: ${pipelineState?.readyStageIds.join(", ") || proposal.stages[0]?.id || "none"}`,
		`acceptance checks: ${status.acceptanceCheckIds.join(", ")}`,
		`protected invariants: ${status.protectedInvariantIds.join(", ")}`,
		"execution rules:",
		"- Keep the admitted pipeline moving. Parallelize only dependency-independent work and put available capacity on the critical path.",
		"- Planning and design roles normally do not implement. Implementation roles change the owned files directly.",
		"- Before each consequential decision, run an independent adversarial review. Before evaluation, test for overfitting and repeated solution families.",
		"- Use built-in AutoResearch for falsifiable independent mechanisms, never parameter hunting. Keep generation separate from evaluation and hidden holdouts.",
		"- Read MemPalace for relevant durable how/why context. Write only authenticated, verified, reusable learning after the outcome is known.",
		"- Intent tests prove the user-visible outcome. Unit tests are debugging probes, and coverage is not the objective.",
		"- Progress requires host-authenticated causal evidence; activity, utilization, and tokens are not progress.",
		...(pipelineState === undefined
			? ["- The authenticated stage cursor is unavailable; do not claim or submit pipeline-stage transitions."]
			: [
					"- After a ready stage produces its required host evidence, record that exact stage and those evidence refs through workflow.v1.pipeline.record; never skip dependencies or self-assert a stage.",
				]),
		...(executionEvidenceAvailable
			? [
					"- Query workflow.v1.execution_evidence.read for host-issued turn and tool observation refs. These refs prove execution only; they are not goal progress unless the ready stage evaluator accepts them.",
				]
			: []),
		...(adaptiveRuntime === undefined ? [] : [adaptiveRuntime.plannerDirective()]),
		"- On failure, preserve evidence, re-plan or use an admitted back edge, and continue useful independent work. Do not silently stop.",
		"- Completion is allowed only when the completion gate verifies every acceptance check and invariant without mock-only or self-approved evidence.",
		"</prime_workflow>",
	].join("\n");
}

function canonicalRequestType(requestType: string): string {
	if (requestType === "autoresearch.run") return "workflow.v1.autoresearch.run";
	if (requestType === "mempalace.recall") return "workflow.v1.mempalace.recall";
	if (requestType === "mempalace.propose") return "workflow.v1.mempalace.propose";
	if (requestType === "pipeline.record") return "workflow.v1.pipeline.record";
	if (requestType === "execution_evidence.read") return "workflow.v1.execution_evidence.read";
	if (requestType === "learning.review") return "workflow.v1.learning.review";
	if (requestType === "learning.rollback") return "workflow.v1.learning.rollback";
	if (requestType === "completion.request") return "workflow.v1.completion.request";
	return requestType;
}

function isDurableWorkflowReadRequest(requestType: string): boolean {
	const canonical = canonicalRequestType(requestType);
	return canonical === "workflow.v1.mempalace.recall" || canonical === "workflow.v1.execution_evidence.read";
}

function capabilityName(
	requestType: string,
):
	| "autoresearch.run"
	| "execution_evidence.read"
	| "mempalace.recall"
	| "mempalace.propose"
	| "pipeline.record"
	| "learning.review"
	| "learning.rollback"
	| "completion.request"
	| null {
	switch (canonicalRequestType(requestType)) {
		case "workflow.v1.autoresearch.run":
			return "autoresearch.run";
		case "workflow.v1.mempalace.recall":
			return "mempalace.recall";
		case "workflow.v1.mempalace.propose":
			return "mempalace.propose";
		case "workflow.v1.pipeline.record":
			return "pipeline.record";
		case "workflow.v1.execution_evidence.read":
			return "execution_evidence.read";
		case "workflow.v1.learning.review":
			return "learning.review";
		case "workflow.v1.learning.rollback":
			return "learning.rollback";
		case "workflow.v1.completion.request":
			return "completion.request";
		default:
			return null;
	}
}

function exactResourceDecision(
	status: WorkflowShellStatus,
	workflowId: string,
): WorkflowShellStatus["decisionRefs"][number] | null {
	const candidates = status.decisionRefs.filter(
		(ref) =>
			ref.decisionId === `resource_envelope:${workflowId}` &&
			ref.decisionScope.kind === "workflow" &&
			ref.decisionScope.workflowId === workflowId,
	);
	return candidates.length === 1 ? candidates[0] : null;
}

function capabilityNonce(input: {
	workflowId: string;
	requestType: string;
	stateDigest: string;
	decisionId: string;
	decisionRevision: number;
	nonceSalt?: string;
}): string {
	return digestObject({
		kind: "prime_workflow_kernel_nonce",
		workflowId: input.workflowId,
		requestType: canonicalRequestType(input.requestType),
		stateDigest: input.stateDigest,
		decisionId: input.decisionId,
		decisionRevision: input.decisionRevision,
		nonceSalt: input.nonceSalt ?? null,
	});
}

function assertCurrentCapability(
	context: HostRequestContext | undefined,
	input: {
		requestType: string;
		workflowId: string;
		readStatus: () => WorkflowShellStatus;
		now: () => number;
		isIssuedNonce?: (requestType: string, nonce: string) => boolean;
	},
): HostRequestCapabilityContext {
	if (context === undefined || !context.isCurrent()) throw new Error("prime_workflow_capability_invalid");
	const name = capabilityName(input.requestType);
	const status = input.readStatus();
	const decision = exactResourceDecision(status, input.workflowId);
	if (
		name === null ||
		(status.status !== "active" &&
			!(status.status === "complete" && isDurableWorkflowReadRequest(input.requestType))) ||
		status.workflowId !== input.workflowId ||
		status.stateDigest === null ||
		decision === null ||
		!context.capability.capabilities.includes(name) ||
		context.capability.workflowId !== input.workflowId ||
		context.capability.decisionId !== decision.decisionId ||
		context.capability.decisionRevision !== decision.revision ||
		context.capability.nonce === undefined ||
		(input.isIssuedNonce === undefined
			? context.capability.nonce !==
				capabilityNonce({
					workflowId: input.workflowId,
					requestType: input.requestType,
					stateDigest: status.stateDigest,
					decisionId: decision.decisionId,
					decisionRevision: decision.revision,
				})
			: !input.isIssuedNonce(input.requestType, context.capability.nonce)) ||
		context.capability.expiresAt === undefined ||
		context.capability.expiresAt <= input.now()
	)
		throw new Error("prime_workflow_capability_invalid");
	return context.capability;
}

async function consumeCapabilityNonce(input: {
	runtimeStore: WorkflowRuntimeStore;
	context: HostRequestContext;
	capability: HostRequestCapabilityContext;
	requestType: string;
	workflowId: string;
	readStatus: () => WorkflowShellStatus;
	now: () => number;
	isIssuedNonce?: (requestType: string, nonce: string) => boolean;
}): Promise<void> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("prime_workflow_capability_persistence_unavailable");
	const decisionId = input.capability.decisionId;
	const decisionRevision = input.capability.decisionRevision;
	const nonce = input.capability.nonce;
	if (decisionId === undefined || decisionRevision === undefined || nonce === undefined)
		throw new Error("prime_workflow_capability_invalid");
	const requestType = canonicalRequestType(input.requestType);
	const key = { workflowId: input.workflowId, decisionId, decisionRevision, requestType, nonce };
	const name = `prime-capability-${digestObject(key).slice(0, 48)}`;
	await durable.withExclusiveLease(`prime-capability-${input.workflowId}`, async () => {
		const current = input.readStatus();
		const currentCapability = assertCurrentCapability(input.context, {
			requestType,
			workflowId: input.workflowId,
			readStatus: input.readStatus,
			now: input.now,
			isIssuedNonce: input.isIssuedNonce,
		});
		if (
			currentCapability !== input.capability ||
			(current.status !== "active" &&
				!(current.status === "complete" && isDurableWorkflowReadRequest(input.requestType)))
		)
			throw new Error("prime_workflow_capability_invalid");
		const existing = await durable.auxiliaryStore.read(name);
		if (existing !== null) throw new Error("prime_workflow_capability_replay");
		await durable.auxiliaryStore.write(
			name,
			canonicalJsonBytes({ kind: "prime_capability_nonce_consumed", ...key, consumedAt: input.now() }),
		);
	});
}

function guardedHandler(
	handler: HostRequestHandler,
	input: {
		runtimeStore: WorkflowRuntimeStore;
		requestType: string;
		workflowId: string;
		readStatus: () => WorkflowShellStatus;
		now: () => number;
		isIssuedNonce?: (requestType: string, nonce: string) => boolean;
	},
): HostRequestHandler {
	return (payload, context) => {
		const capability = assertCurrentCapability(context, input);
		return consumeCapabilityNonce({
			runtimeStore: input.runtimeStore,
			context: context!,
			capability,
			requestType: input.requestType,
			workflowId: input.workflowId,
			readStatus: input.readStatus,
			now: input.now,
			isIssuedNonce: input.isIssuedNonce,
		}).then(() => handler(payload, context));
	};
}

function readGuardedHandler(
	handler: HostRequestHandler,
	input: {
		requestType: string;
		workflowId: string;
		readStatus: () => WorkflowShellStatus;
		now: () => number;
		isIssuedNonce?: (requestType: string, nonce: string) => boolean;
	},
): HostRequestHandler {
	return (payload, context) => {
		assertCurrentCapability(context, input);
		return handler(payload, context);
	};
}

function activeAttemptKeys(replay: WorkflowStoreReplayResult): {
	dispatch: Set<string>;
	effects: Set<string>;
	leases: Set<string>;
	processGroups: Set<string>;
} {
	const dispatch = new Set<string>();
	const effects = new Set<string>();
	const leases = new Set<string>();
	const processGroups = new Set<string>();
	const processGroupAttempts = new Map<string, string>();
	const processGroupKey = (attemptId: string, processGroupId: string): string =>
		digestObject({ attemptId, processGroupId });
	const addProcessGroup = (attemptId: string, processGroupId: string): void => {
		const key = processGroupKey(attemptId, processGroupId);
		processGroups.add(key);
		processGroupAttempts.set(key, attemptId);
	};
	for (const event of replay.events) {
		switch (event.payload.kind) {
			case "workflow_dispatch_intent":
				dispatch.add(event.payload.attemptId);
				break;
			case "workflow_child_identity_bound":
				addProcessGroup(event.payload.attemptId, event.payload.processBinding.processGroup.processGroupId);
				break;
			case "workflow_child_outcome_committed":
				dispatch.delete(event.payload.attemptId);
				break;
			case "workflow_effect_intent":
				effects.add(event.payload.idempotencyKey);
				break;
			case "workflow_effect_completed":
				effects.delete(event.payload.idempotencyKey);
				break;
			case "workflow_effect_ambiguous":
				effects.add(event.payload.idempotencyKey);
				break;
			case "workflow_resource_lease_acquired":
				if (event.payload.lease.status === "active" || event.payload.lease.status === "reserved")
					leases.add(event.payload.lease.leaseId);
				break;
			case "workflow_ownership_lease_acquired":
				if (event.payload.lease.status === "active" || event.payload.lease.status === "reserved")
					leases.add(event.payload.lease.leaseId);
				break;
			case "workflow_lease_release_recorded":
				leases.delete(event.payload.releaseRef.leaseRef.leaseId);
				break;
			case "workflow_lease_quarantined":
				leases.add(event.payload.leaseRef.leaseId);
				break;
			case "workflow_process_group_owned":
				addProcessGroup(event.payload.attemptId, event.payload.processGroup.processGroupId);
				break;
			case "workflow_process_group_fenced":
				addProcessGroup(event.payload.attemptId, event.payload.processGroup.processGroupId);
				break;
			case "workflow_process_group_reaped": {
				const key = processGroupKey(event.payload.attemptId, event.payload.processGroupId);
				if (event.payload.remainingPids.length === 0) {
					processGroups.delete(key);
					processGroupAttempts.delete(key);
				} else {
					addProcessGroup(event.payload.attemptId, event.payload.processGroupId);
				}
				break;
			}
			default:
				break;
		}
	}
	return { dispatch, effects, leases, processGroups };
}

/**
 * Build the real replay-backed recovery path used when no active-attempt manager is injected.
 * It proves that no dispatch/effect/lease/process binding is outstanding and refuses to resume otherwise.
 *
 * Args:
 * input: The already-open runtime authority and authenticated workflow epoch.
 * Return: A recovery port that never mutates the workflow or silently bypasses active attempts.
 */
export function createPrimeWorkflowNoActiveAttemptRecovery(input: {
	runtimeStore: WorkflowRuntimeStore;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	/** The composed Prime kernel owns the no-active-attempt proof; provider-free hosts fail closed. */
	readonly allowNoActiveAttemptRecovery?: boolean;
}): PrimeWorkflowNoActiveAttemptRecovery {
	if (input.runtimeStore.identity.workflowId !== input.workflowId)
		throw new Error("prime_workflow_runtime_store_binding_invalid");
	const allowNoActiveAttemptRecovery = input.allowNoActiveAttemptRecovery === true;
	let readiness: WorkflowRuntimeRecoveryReadiness = {
		canRecover: false,
		blockingReasons: [
			allowNoActiveAttemptRecovery
				? "workflow_replay_not_authenticated"
				: "workflow_recovery_dependency_seam_unavailable",
		],
	};
	return {
		readiness: () => readiness,
		recoverBeforeResume: async (): Promise<WorkflowRuntimeRecoveryStartResult> => {
			if (!allowNoActiveAttemptRecovery)
				return {
					status: "blocked",
					binding: null,
					nonExecutionProof: null,
					journalHeadDigest: null,
				};
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 1,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			if (replay.workflowId !== input.workflowId || replay.head.workflowId !== input.workflowId)
				throw new Error("workflow_recovery_workflow_binding_invalid");
			if (
				replay.head.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
				replay.head.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
			)
				throw new Error("workflow_recovery_epoch_mismatch");
			if (replay.quarantined) {
				readiness = { canRecover: false, blockingReasons: ["workflow_replay_quarantined"] };
				throw new Error("workflow_recovery_quarantined");
			}
			const active = activeAttemptKeys(replay);
			const blockingReasons = [
				...(active.dispatch.size > 0 ? ["workflow_dispatch_intent_outstanding"] : []),
				...(active.effects.size > 0 ? ["workflow_effect_intent_outstanding"] : []),
				...(active.leases.size > 0 ? ["workflow_lease_outstanding"] : []),
				...(active.processGroups.size > 0 ? ["workflow_process_binding_outstanding"] : []),
			];
			if (blockingReasons.length > 0) {
				readiness = { canRecover: false, blockingReasons };
				return {
					status: "blocked",
					binding: null,
					nonExecutionProof: null,
					journalHeadDigest: replay.head.eventDigest,
				};
			}
			readiness = { canRecover: true, blockingReasons: [] };
			return {
				status: "started",
				binding: null,
				nonExecutionProof: digestObject({
					kind: "workflow_no_active_attempts",
					workflowId: input.workflowId,
					head: replay.head,
				}),
				journalHeadDigest: replay.head.eventDigest,
			};
		},
	};
}

/**
 * Compose the production Prime kernel seam around one authenticated runtime store.
 *
 * Args:
 * input: Store identity, current phase status, and authenticated adapters supplied by subsystem owners.
 * Return: Exact-decision capability resolution, bounded adapter handlers, and replay-backed recovery.
 */
export async function createProductionPrimeWorkflow(
	input: ProductionPrimeWorkflowInput,
): Promise<ProductionPrimeWorkflow> {
	if (input.workflowId.length === 0 || input.rootSessionId.length === 0)
		throw new Error("prime_workflow_identity_invalid");
	if (
		input.runtimeStore.identity.storeKind !== "workflow" ||
		input.runtimeStore.identity.workflowId !== input.workflowId
	)
		throw new Error("prime_workflow_runtime_store_binding_invalid");
	if (input.runtimeStore.durableContext === undefined) throw new Error("prime_workflow_durable_runtime_required");
	if (input.artifactRoot.length === 0) throw new Error("prime_workflow_artifact_root_invalid");
	if (!AUTHENTICATED_ADAPTERS.has(input.adapters)) throw new Error("prime_workflow_authenticated_adapters_unbound");
	if (input.adapters.runtimeStore !== input.runtimeStore) throw new Error("prime_workflow_adapter_store_mismatch");
	if (AUTHENTICATED_ADAPTER_RUNTIME_STORES.get(input.adapters) !== input.runtimeStore)
		throw new Error("prime_workflow_adapter_store_authority_invalid");
	if (typeof input.adapters.consumeRecipeAdmission !== "function")
		throw new Error("prime_workflow_recipe_admission_consumer_required");
	const now = input.now ?? (() => Date.now());
	const epochRef = input.epochRef ??
		input.runtimeStore.durableContext?.epochRef ?? { storeEpoch: 1, coordinatorEpoch: 1 };
	const durableEpoch = input.runtimeStore.durableContext.epochRef;
	if (durableEpoch.storeEpoch !== epochRef.storeEpoch || durableEpoch.coordinatorEpoch !== epochRef.coordinatorEpoch)
		throw new Error("prime_workflow_epoch_store_mismatch");
	const snapshots = cloneSnapshots(input.adapters.snapshots);
	if (
		input.adapters.autoResearchRuntime === undefined ||
		input.adapters.knowledgeStore === undefined ||
		input.adapters.mempalace === undefined
	)
		throw new Error("prime_workflow_builtin_adapters_incomplete");
	if (snapshots.skills.length > 0 && input.adapters.skillExecution === undefined)
		throw new Error("prime_workflow_skill_execution_adapter_required");
	if (
		input.adapters.skillExecution !== undefined &&
		!isWorkflowSkillProductionExecutionAdapter(input.adapters.skillExecution, input.runtimeStore)
	)
		throw new Error("prime_workflow_skill_execution_adapter_unbound");
	validateWorkflowRecipeAdmission(snapshots.recipe);
	if (input.taskGraph !== undefined && input.taskGraph.graphDigest !== snapshots.recipe.baseTaskGraphDigest)
		throw new Error("prime_workflow_task_graph_admission_mismatch");
	if (
		snapshots.recipe.workflowId !== input.workflowId ||
		digestObject(snapshots.recipe.hostEpochRef) !== digestObject(epochRef) ||
		snapshots.skills.some(
			(snapshot) =>
				snapshot.workflowId !== input.workflowId ||
				digestObject(snapshot.epochRef) !== digestObject(epochRef) ||
				snapshot.configDigest !== snapshots.config.resolvedConfigDigest ||
				(snapshots.recipe.skillSnapshotDigests.length > 0 &&
					!snapshots.recipe.skillSnapshotDigests.includes(snapshot.snapshotDigest)),
		)
	)
		throw new Error("prime_workflow_snapshot_binding_invalid");
	const admissionConsumptionProof = await input.adapters.consumeRecipeAdmission(snapshots.recipe);
	if (!isWorkflowRecipeAdmissionConsumptionProof(admissionConsumptionProof, snapshots.recipe))
		throw new Error("prime_workflow_recipe_admission_consumption_unbound");
	const issuedCapabilityNonces = new Set<string>();
	const resolveHostRequestCapability = (requestType: string): HostRequestCapabilityContext => {
		const capability = capabilityName(requestType);
		if (capability === null) return { capabilities: [] };
		const status = input.readStatus();
		const decision = exactResourceDecision(status, input.workflowId);
		if (
			(status.status !== "active" && !(status.status === "complete" && isDurableWorkflowReadRequest(requestType))) ||
			status.workflowId !== input.workflowId ||
			status.stateDigest === null ||
			decision === null
		)
			return { capabilities: [] };
		const nonce = capabilityNonce({
			workflowId: input.workflowId,
			requestType,
			stateDigest: status.stateDigest,
			decisionId: decision.decisionId,
			decisionRevision: decision.revision,
			nonceSalt: randomUUID(),
		});
		issuedCapabilityNonces.add(`${canonicalRequestType(requestType)}:${nonce}`);
		return Object.freeze({
			workflowId: input.workflowId,
			decisionId: decision.decisionId,
			decisionRevision: decision.revision,
			capabilities: Object.freeze([capability]),
			expiresAt: now() + CAPABILITY_TTL_MS,
			nonce,
		});
	};
	const isIssuedNonce = (requestType: string, nonce: string): boolean =>
		issuedCapabilityNonces.has(`${canonicalRequestType(requestType)}:${nonce}`);
	const executeSkill = <TResult>(request: {
		readonly snapshotDigest: string;
		readonly token: string | Readonly<Uint8Array>;
		readonly current: WorkflowSkillHostInvocationContext;
		readonly validationOptions?: WorkflowSkillInvocationValidationOptions;
		readonly executor: WorkflowSkillExecutor<TResult>;
	}): Promise<TResult> => {
		const skillExecution = input.adapters.skillExecution;
		if (skillExecution === undefined) throw new Error("prime_workflow_skill_execution_unavailable");
		const snapshot = snapshots.skills.find((candidate) => candidate.snapshotDigest === request.snapshotDigest);
		if (snapshot === undefined) throw new Error("prime_workflow_skill_snapshot_not_admitted");
		return skillExecution
			.validateAndConsume(snapshot, request.token, request.current, request.validationOptions)
			.then((admission) => {
				if (admission === undefined) throw new Error("prime_workflow_skill_invocation_not_admitted");
				return skillExecution.execute(admission, snapshot, request.current, request.executor);
			});
	};
	const executeSkillIteration = <TResult>(request: {
		readonly skillName: string;
		readonly current: WorkflowSkillHostInvocationContext;
		readonly executor: WorkflowSkillExecutor<TResult>;
	}): Promise<TResult> => {
		if (input.executeSkillIteration === undefined) throw new Error("prime_workflow_skill_iteration_unavailable");
		return input.executeSkillIteration(request);
	};
	const executionEvidenceReadHandler: HostRequestHandler | undefined = input.adapters.executionEvidence
		? async () => {
				const state = await input.adapters.executionEvidence!.read();
				return {
					observation_count: state.observationCount,
					latest_observation_digest: state.latestObservationDigest,
					observation_refs: state.observationRefs.slice(-32).map(toKernelArtifactRef),
					state_digest: state.stateDigest,
					can_authorize: false,
				};
			}
		: undefined;
	const hostRequestHandlers: HostRequestHandlers = Object.freeze({
		"workflow.v1.autoresearch.run": guardedHandler(input.adapters.autoResearchHandler, {
			runtimeStore: input.runtimeStore,
			requestType: "workflow.v1.autoresearch.run",
			workflowId: input.workflowId,
			readStatus: input.readStatus,
			now,
			isIssuedNonce,
		}),
		"workflow.v1.mempalace.recall": readGuardedHandler(input.adapters.mempalaceRecallHandler, {
			requestType: "workflow.v1.mempalace.recall",
			workflowId: input.workflowId,
			readStatus: input.readStatus,
			now,
			isIssuedNonce,
		}),
		"workflow.v1.mempalace.propose": guardedHandler(input.adapters.mempalaceProposeHandler, {
			runtimeStore: input.runtimeStore,
			requestType: "workflow.v1.mempalace.propose",
			workflowId: input.workflowId,
			readStatus: input.readStatus,
			now,
			isIssuedNonce,
		}),
		...(input.adapters.pipelineRecordHandler === undefined
			? {}
			: {
					"workflow.v1.pipeline.record": guardedHandler(input.adapters.pipelineRecordHandler, {
						runtimeStore: input.runtimeStore,
						requestType: "workflow.v1.pipeline.record",
						workflowId: input.workflowId,
						readStatus: input.readStatus,
						now,
						isIssuedNonce,
					}),
				}),
		...(executionEvidenceReadHandler === undefined
			? {}
			: {
					"workflow.v1.execution_evidence.read": readGuardedHandler(executionEvidenceReadHandler, {
						requestType: "workflow.v1.execution_evidence.read",
						workflowId: input.workflowId,
						readStatus: input.readStatus,
						now,
						isIssuedNonce,
					}),
				}),
		...(input.adapters.learningReviewHandler === undefined
			? {}
			: {
					"workflow.v1.learning.review": guardedHandler(input.adapters.learningReviewHandler, {
						runtimeStore: input.runtimeStore,
						requestType: "workflow.v1.learning.review",
						workflowId: input.workflowId,
						readStatus: input.readStatus,
						now,
						isIssuedNonce,
					}),
				}),
		...(input.adapters.learningRollbackHandler === undefined
			? {}
			: {
					"workflow.v1.learning.rollback": guardedHandler(input.adapters.learningRollbackHandler, {
						runtimeStore: input.runtimeStore,
						requestType: "workflow.v1.learning.rollback",
						workflowId: input.workflowId,
						readStatus: input.readStatus,
						now,
						isIssuedNonce,
					}),
				}),
		...(input.adapters.completionRequestHandler === undefined
			? {}
			: {
					"workflow.v1.completion.request": guardedHandler(input.adapters.completionRequestHandler, {
						runtimeStore: input.runtimeStore,
						requestType: "workflow.v1.completion.request",
						workflowId: input.workflowId,
						readStatus: input.readStatus,
						now,
						isIssuedNonce,
					}),
				}),
	});
	return Object.freeze({
		runtimeStore: input.runtimeStore,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		artifactRoot: input.artifactRoot,
		runtimeVersion: PRIME_RUNTIME_VERSION,
		snapshots,
		...(input.taskGraph === undefined ? {} : { taskGraph: input.taskGraph }),
		...(input.readSchedulerState === undefined ? {} : { readSchedulerState: input.readSchedulerState }),
		get plannerDirective(): string {
			return primePlannerDirective(
				snapshots,
				input.readStatus(),
				input.adapters.pipeline?.current(),
				input.adapters.executionEvidence !== undefined,
				input.adapters.adaptiveRuntime,
			);
		},
		initializationOrder: PRIME_WORKFLOW_INITIALIZATION_ORDER,
		recovery: createPrimeWorkflowNoActiveAttemptRecovery({
			runtimeStore: input.runtimeStore,
			workflowId: input.workflowId,
			epochRef,
			allowNoActiveAttemptRecovery: true,
		}),
		hostRequestHandlers,
		resolveHostRequestCapability,
		autoResearchRuntime: input.adapters.autoResearchRuntime,
		knowledgeStore: input.adapters.knowledgeStore,
		mempalace: input.adapters.mempalace,
		scheduler: input.adapters.scheduler,
		learning: input.adapters.learning,
		pipeline: input.adapters.pipeline,
		executionEvidence: input.adapters.executionEvidence,
		adaptiveRuntime: input.adapters.adaptiveRuntime,
		skillExecution: input.adapters.skillExecution,
		executeSkill,
		executeSkillIteration,
		recordSkillOutcome: input.recordSkillOutcome,
		unavailableSubsystems: [
			...(input.adapters.scheduler === undefined ? (["scheduler_resources"] as const) : []),
			...(input.adapters.learning === undefined ? (["learning"] as const) : []),
			...(input.adapters.pipeline === undefined ? (["pipeline"] as const) : []),
			...(input.adapters.executionEvidence === undefined ? (["execution_evidence"] as const) : []),
			...(input.adapters.skillExecution === undefined ? (["skill_execution"] as const) : []),
		],
	});
}

export const createPrimeWorkflowComposition = createProductionPrimeWorkflow;
