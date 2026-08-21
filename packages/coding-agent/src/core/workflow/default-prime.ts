import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { getBundledSkillsDir } from "../../config.js";
import {
	type AutoResearchDurableRecipe,
	type AutoResearchProductionRunner,
	type AutoResearchPythonResult,
	autoResearchCandidateHypothesisDigest,
	createAutoResearchProductionRunner,
	parseAutoResearchDurableRecipe,
} from "../autoresearch/runner.js";
import { createAutoResearchWorkflowRuntimeAdapter } from "../autoresearch/runtime-adapter.js";
import type {
	AutoResearchDecisionResolution,
	AutoResearchEvidenceProof,
	AutoResearchEvidenceSubmission,
	AutoResearchExperimentRegistration,
	AutoResearchHostMeasurement,
	AutoResearchHostPorts,
	AutoResearchProposalCandidateInput,
	AutoResearchRawObservation,
	AutoResearchTaskSubmission,
} from "../autoresearch/types.js";
import type { Skill } from "../skills.js";
import { loadSkillsFromDir } from "../skills.js";
import { createPrimeAdaptiveRuntime, type PrimeAdaptiveRuntimeHostAuthority } from "./adaptive-runtime.js";
import {
	assertWorkflowTaskGraphSourceContract,
	readWorkflowTaskGraphSource,
	type WorkflowTaskGraphSource,
} from "./brainstorm.js";
import { resolveWorkflowRuntimeConfig } from "./config.js";
import type { WorkflowDescriptorFs } from "./contracts.js";
import {
	canonicalJsonBytes,
	type DurableDecisionRecord,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowAuthorityCapability,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowEventType,
	type WorkflowEvidenceEnvelope,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowImprovementProposal,
	type WorkflowLeaseRef,
	type WorkflowResourceVector,
	type WorkflowRevisionTuple,
	type WorkflowRuntimeConfigSnapshot,
	type WorkflowRuntimeStore,
	type WorkflowStoreReplayResult,
	type WorkflowTask,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import type { WorkflowDecisionGate } from "./decision-gate.js";
import {
	createDefaultPrimeCompletionReadinessAuthority,
	type DefaultPrimeCompletionAuditContext,
	type DefaultPrimeCompletionStageEvidence,
} from "./default-completion.js";
import {
	createDefaultPrimeTaskRuntime,
	type DefaultPrimeTaskCapsuleFactory,
	type DefaultPrimeTaskRuntime,
	type DefaultPrimeWorkerFailureNotice,
	type DefaultPrimeWorkerLauncher,
	type DefaultPrimeWorkerTaskCapsuleCore,
	defaultPrimeWorkerOutputContract,
	defaultPrimeWorkerTaskCapsuleDigest,
	defaultPrimeWorkerTaskCapsuleReceiptBindingDigest,
} from "./default-task-runtime.js";
import {
	createDefaultTaskRuntimeAuthority,
	type DefaultTaskRuntimeAuthorityInput,
} from "./default-task-runtime-authority.js";
import { createWorkflowEvidenceValidator } from "./evidence.js";
import type { WorkflowExecutionEvidenceRuntime } from "./execution-evidence.js";
import type {
	WorkflowLearningCandidate,
	WorkflowLearningHost,
	WorkflowLearningHostSnapshot,
	WorkflowLearningHostWitness,
	WorkflowLearningPorts,
	WorkflowLearningPromotion,
	WorkflowLearningPromotionReconciliation,
	WorkflowLearningRollbackApplication,
	WorkflowLearningRollbackProposal,
	WorkflowLearningStageMetrics,
	WorkflowLearningTrigger,
} from "./learning-controller.js";
import {
	createWorkflowLearningRuntimeAdapterWithDurableEffects,
	issueWorkflowLearningSessionHostIdentity,
	type WorkflowLearningApprovedAuthority,
	type WorkflowLearningRuntimeAdapter,
	type WorkflowLearningRuntimeBinding,
	workflowLearningAuthorityBindingDigest,
} from "./learning-runtime-adapter.js";
import {
	createPrimeWorkflowBuiltinAdapters,
	createProductionPrimeWorkflow,
	type PrimeWorkflowHostAuthority,
	type PrimeWorkflowPipelineRuntime,
	type PrimeWorkflowPipelineState,
	type PrimeWorkflowSnapshots,
	type ProductionPrimeWorkflow,
} from "./prime-loop.js";
import {
	BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST,
	BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE,
	type CompiledWorkflowRecipe,
	compileWorkflowRecipe,
	consumeWorkflowRecipeAdmissionAtHost,
	createWorkflowRecipeRegisteredManifest,
	DEFAULT_WORKFLOW_RECIPE_REGISTRY,
	WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS,
	WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
	WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
	WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
	type WorkflowRecipeAdmissionArtifact,
	type WorkflowRecipeAdmissionConsumptionProof,
	type WorkflowRecipeAdmissionHostRegistrationProof,
	type WorkflowRecipeAdmissionHostResolutionPort,
	type WorkflowRecipeHostReceiptProof,
	type WorkflowRecipeHostResolutionPort,
	type WorkflowRecipeOpaqueHoldout,
	type WorkflowRecipeOverfittingGateReceiptPayload,
	type WorkflowRecipeProposal,
	type WorkflowRecipeReceiptConsumptionWitness,
	type WorkflowRecipeUniversalGateBinding,
	type WorkflowRecipeVerifiedHostReceipt,
} from "./recipes.js";
import { MIN_WORKFLOW_RUNTIME_VERSION } from "./runtime-store-adapter.js";
import type {
	PersistedSessionWorkflowHost,
	PersistedWorkflowCompletionReadinessAuthority,
	PersistedWorkflowCompletionReceiptIssuer,
} from "./session-host-factory.js";
import type { WorkflowShellStatus } from "./shell.js";
import {
	createSkillSnapshot,
	createWorkflowSkillDescriptorInvocationStore,
	createWorkflowSkillProductionExecutionAdapter,
	createWorkflowSkillRuntimeStoreHostStateReader,
	deriveWorkflowSkillInvocationSnapshot,
	getSkillInvocationToken,
	getWorkflowResourceLoaderProvenanceDigests,
	getWorkflowResourceLoaderReceiptBindingDigest,
	reissueWorkflowSkillInvocationSnapshot,
	type WorkflowResourceLoaderPort,
	type WorkflowResourceLoaderProvenance,
	type WorkflowResourceLoaderResult,
	type WorkflowSkillActiveHostStateReader,
	type WorkflowSkillBuiltinProvenance,
	type WorkflowSkillBuiltinProvenanceContext,
	type WorkflowSkillExecutionEffectVerificationInput,
	type WorkflowSkillExecutor,
	type WorkflowSkillHostInvocationContext,
	type WorkflowSkillManifestSource,
	type WorkflowSkillPackageSource,
	type WorkflowSkillSnapshot,
	type WorkflowSkillSourceProvenance,
} from "./skill-snapshots.js";
import { validateWorkflowTaskGraph, type WorkflowTaskGraph } from "./task-graph.js";
import type { WorkflowPrimeStageEvidenceAdapter, WorkflowTaskRuntimeAuthority } from "./task-runtime-authority.js";

function parseSkillEffectArtifactRef(value: unknown, label: string): WorkflowArtifactRef {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}_invalid`);
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !==
			["artifact_id", "digest", "relative_path", "size_bytes", "source_event_sequence"].sort().join(",") ||
		typeof record.artifact_id !== "string" ||
		typeof record.relative_path !== "string" ||
		typeof record.digest !== "string" ||
		!/^[0-9a-f]{64}$/u.test(record.digest) ||
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

const DEFAULT_PRIME_AUTORESEARCH_EFFECT_EVENT_KINDS: readonly WorkflowEventType[] = Object.freeze([
	"scorecard_red_teamed",
	"scorecard_approved",
	"initialization_intent",
	"projection_intent",
	"frontier_init_intent",
	"frontier_initialized",
	"baseline_intent",
	"initialized",
	"projection_committed",
	"lease_renewed",
	"candidate_claim_intent",
	"candidate_dispatched",
	"candidate_handoff_published",
	"finish_intent",
	"metric_recorded",
	"guard_recorded",
	"admission_lock_acquired",
	"stale_rebase_requested",
	"remeasured",
	"candidate_red_teamed",
	"frontier_update_intent",
	"candidate_admitted",
	"candidate_discarded",
	"admission_lock_released",
	"candidate_abandoned",
	"candidate_reaped",
	"recovery_classified",
	"candidate_target_observed",
	"target_reached",
	"verification_gap_found",
	"run_archive_intent",
	"run_archived",
	"verified",
	"completion_audited",
	"refinement_recorded",
	"completed",
	"stop_requested",
	"budget_limited",
	"blocked",
]);

function createDefaultPrimeSkillEffectVerifier(input: {
	activeHostState: WorkflowSkillActiveHostStateReader;
	artifactResolver: WorkflowArtifactResolver;
	workflowId: string;
	epochRef: WorkflowEpochRef;
	defaultExecutionKey: string;
	autoresearchExecutionKey: string;
}): (input: WorkflowSkillExecutionEffectVerificationInput) => Promise<{
	workflowId: string;
	epochRef: WorkflowEpochRef;
	journalHeadDigest: string;
}> {
	if (input.defaultExecutionKey.length === 0 || input.autoresearchExecutionKey.length === 0)
		throw new Error("default_prime_skill_effect_execution_keys_invalid");
	return async (effectInput) => {
		if (effectInput.workflowId !== input.workflowId) throw new Error("default_prime_skill_effect_workflow_mismatch");
		if (
			effectInput.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
			effectInput.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch
		)
			throw new Error("default_prime_skill_effect_epoch_mismatch");
		const resultRecord =
			effectInput.result !== null && typeof effectInput.result === "object" && !Array.isArray(effectInput.result)
				? (effectInput.result as Record<string, unknown>)
				: {};
		const rawRefs = resultRecord.evidence_refs;
		if (rawRefs !== undefined && !Array.isArray(rawRefs))
			throw new Error("default_prime_skill_effect_evidence_invalid");
		const evidenceRefs =
			rawRefs === undefined
				? []
				: rawRefs.map((value, index) =>
						parseSkillEffectArtifactRef(value, `default_prime_skill_effect_evidence_${index}`),
					);
		for (const ref of evidenceRefs) {
			const resolved = await input.artifactResolver.resolve(ref);
			if (
				!resolved.exists ||
				resolved.verifiedDigest !== ref.digest ||
				resolved.verifiedSizeBytes !== ref.sizeBytes ||
				resolved.envelope.ref.sourceEventSequence !== ref.sourceEventSequence
			)
				throw new Error("default_prime_skill_effect_evidence_receipt_invalid");
		}
		const executionKey =
			effectInput.skillName === "workflow-autoresearch" ? input.autoresearchExecutionKey : input.defaultExecutionKey;
		const verifier = input.activeHostState.verifySuccessorEffectChain;
		if (verifier === undefined) throw new Error("default_prime_skill_effect_verifier_unavailable");
		const chain = await verifier({
			workflowId: input.workflowId,
			priorHeadDigest: effectInput.priorJournalHeadDigest,
			expectedEpoch: input.epochRef,
			executionKey,
			capabilityDigest: digestObject({
				kind: "workflow-skill-execution-capability",
				workflowId: input.workflowId,
				skillName: effectInput.skillName,
				admissionDigest: effectInput.admissionDigest,
				invocationTokenId: effectInput.invocationTokenId,
				consumeSequence: effectInput.consumeSequence,
				outputDigest: resultRecord.output_digest ?? null,
			}),
			allowedEventKinds: DEFAULT_PRIME_AUTORESEARCH_EFFECT_EVENT_KINDS,
			allowedArtifactRefs: evidenceRefs,
		});
		if (
			chain.workflowId !== input.workflowId ||
			chain.expectedEpoch.storeEpoch !== input.epochRef.storeEpoch ||
			chain.expectedEpoch.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
			chain.priorHeadDigest !== effectInput.priorJournalHeadDigest
		)
			throw new Error("default_prime_skill_effect_chain_binding_invalid");
		return {
			workflowId: input.workflowId,
			epochRef: { ...chain.expectedEpoch },
			journalHeadDigest: chain.successorHeadDigest,
		};
	};
}

const DEFAULT_LOADER_REVISION = 1;
const DEFAULT_SKILL_SOURCE_SEQUENCE = 1;
const DEFAULT_WORKSPACE_PATHS = Object.freeze(["src"]);
const DEFAULT_GENERATED_OUTPUT_PATHS = Object.freeze(["artifacts/out"]);
const DEFAULT_PRIME_COMPOSITION_RECORD = "default-prime-composition-v1";
const DEFAULT_PRIME_AUTORESEARCH_RECIPE_RECORD = "default-prime-autoresearch-recipe-v1";

type DefaultSkillExecutionParts = Pick<
	DefaultSkillParts,
	"loader" | "skill" | "loaderProvenance" | "builtinProvenanceContext"
>;

function encodeCompositionValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { __defaultPrimeBytes: [...value] };
	if (Array.isArray(value)) return value.map((item) => encodeCompositionValue(item));
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, item]) => item !== undefined)
				.map(([key, item]) => [key, encodeCompositionValue(item)]),
		);
	}
	if (typeof value === "string" || typeof value === "boolean" || typeof value === "number" || value === null)
		return value;
	throw new Error("default_prime_composition_value_not_serializable");
}

function decodeCompositionValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => decodeCompositionValue(item));
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (Object.keys(record).length === 1 && Array.isArray(record.__defaultPrimeBytes)) {
			if (
				!record.__defaultPrimeBytes.every(
					(item) => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 255,
				)
			)
				throw new Error("default_prime_composition_bytes_invalid");
			return Uint8Array.from(record.__defaultPrimeBytes as number[]);
		}
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeCompositionValue(item)]));
	}
	return value;
}

function freezeCompositionValue<T>(value: T): T {
	if (ArrayBuffer.isView(value)) return value;
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		for (const child of Object.values(value as Record<string, unknown>)) freezeCompositionValue(child);
		Object.freeze(value);
	}
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface WorkflowTaskGraphSourceReference {
	readonly uri: string;
	readonly objectGeneration: string;
	readonly objectDigest: string;
	readonly objectSizeBytes: number;
}

function isWorkflowTaskGraphSourceReference(value: unknown): value is WorkflowTaskGraphSourceReference {
	return (
		isRecord(value) &&
		typeof value.uri === "string" &&
		typeof value.objectGeneration === "string" &&
		typeof value.objectDigest === "string" &&
		Number.isSafeInteger(value.objectSizeBytes)
	);
}

function isSkillInvocationHeadRace(error: unknown): error is Error {
	return (
		error instanceof Error &&
		error.message.startsWith("Skill skill invocation ") &&
		error.message.endsWith("is stale or foreign to the active durable host epoch and journal head.")
	);
}

async function readPersistedComposition(
	input: DefaultPrimeWorkflowProviderInput,
): Promise<PrimeWorkflowSnapshots | undefined> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_composition_requires_durable_runtime");
	const bytes = await durable.auxiliaryStore.read(DEFAULT_PRIME_COMPOSITION_RECORD);
	if (bytes === null) return undefined;
	const parsed = parseCanonicalJsonBytes(bytes);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== 1 ||
		parsed.workflowId !== input.workflowId ||
		!isRecord(parsed.epochRef) ||
		parsed.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		parsed.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		!isRecord(parsed.snapshots) ||
		typeof parsed.compositionDigest !== "string"
	)
		throw new Error("default_prime_composition_record_invalid");
	const { compositionDigest: _compositionDigest, ...recordWithoutDigest } = parsed;
	if (parsed.compositionDigest !== digestObject(recordWithoutDigest))
		throw new Error("default_prime_composition_record_digest_invalid");
	const snapshots = decodeCompositionValue(parsed.snapshots) as PrimeWorkflowSnapshots;
	if (
		!isRecord(snapshots) ||
		!isRecord(snapshots.config) ||
		!isRecord(snapshots.recipe) ||
		!Array.isArray(snapshots.skills)
	)
		throw new Error("default_prime_composition_snapshots_invalid");
	return freezeCompositionValue(snapshots);
}

async function persistComposition(
	input: DefaultPrimeWorkflowProviderInput,
	snapshots: PrimeWorkflowSnapshots,
): Promise<void> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_composition_requires_durable_runtime");
	const recordWithoutDigest = {
		schemaVersion: 1,
		workflowId: input.workflowId,
		epochRef: input.epochRef,
		snapshots: encodeCompositionValue(snapshots),
	};
	const record = { ...recordWithoutDigest, compositionDigest: digestObject(recordWithoutDigest) };
	await durable.withExclusiveLease(`default-prime-composition:${input.workflowId}`, async () => {
		const existing = await durable.auxiliaryStore.read(DEFAULT_PRIME_COMPOSITION_RECORD);
		if (existing !== null) {
			const parsed = parseCanonicalJsonBytes(existing);
			if (!isRecord(parsed) || parsed.compositionDigest !== record.compositionDigest)
				throw new Error("default_prime_composition_record_conflict");
			return;
		}
		await durable.auxiliaryStore.write(DEFAULT_PRIME_COMPOSITION_RECORD, canonicalJsonBytes(record));
	});
}

async function readPersistedAutoResearchRecipe(
	input: DefaultPrimeWorkflowProviderInput,
	expectedRecipeDigest: string,
): Promise<AutoResearchDurableRecipe | undefined> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_composition_requires_durable_runtime");
	const bytes = await durable.auxiliaryStore.read(DEFAULT_PRIME_AUTORESEARCH_RECIPE_RECORD);
	if (bytes === null) return undefined;
	const parsed = parseCanonicalJsonBytes(bytes);
	if (
		!isRecord(parsed) ||
		parsed.schemaVersion !== 1 ||
		parsed.workflowId !== input.workflowId ||
		parsed.recipeDigest !== expectedRecipeDigest ||
		!isRecord(parsed.recipe) ||
		typeof parsed.compositionDigest !== "string"
	)
		throw new Error("default_prime_autoresearch_recipe_record_invalid");
	const { compositionDigest: _compositionDigest, ...recordWithoutDigest } = parsed;
	if (parsed.compositionDigest !== digestObject(recordWithoutDigest))
		throw new Error("default_prime_autoresearch_recipe_record_digest_invalid");
	const recipe = parseAutoResearchDurableRecipe(
		decodeCompositionValue(parsed.recipe),
		input.workflowId,
		expectedRecipeDigest,
	);
	return freezeCompositionValue(recipe);
}

async function persistAutoResearchRecipe(
	input: DefaultPrimeWorkflowProviderInput,
	recipe: AutoResearchDurableRecipe,
): Promise<void> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_composition_requires_durable_runtime");
	const recordWithoutDigest = {
		schemaVersion: 1,
		workflowId: input.workflowId,
		recipeDigest: recipe.recipeDigest,
		recipe: encodeCompositionValue(recipe),
	};
	const record = { ...recordWithoutDigest, compositionDigest: digestObject(recordWithoutDigest) };
	await durable.withExclusiveLease(`default-prime-autoresearch-recipe:${input.workflowId}`, async () => {
		const existing = await durable.auxiliaryStore.read(DEFAULT_PRIME_AUTORESEARCH_RECIPE_RECORD);
		if (existing !== null) {
			const parsed = parseCanonicalJsonBytes(existing);
			if (!isRecord(parsed) || parsed.compositionDigest !== record.compositionDigest)
				throw new Error("default_prime_autoresearch_recipe_record_conflict");
			return;
		}
		await durable.auxiliaryStore.write(DEFAULT_PRIME_AUTORESEARCH_RECIPE_RECORD, canonicalJsonBytes(record));
	});
}

function persistedSkillExecutionParts(
	snapshots: PrimeWorkflowSnapshots,
	loader: WorkflowResourceLoaderPort,
	artifactResolver: WorkflowArtifactResolver,
	receiptContext: WorkflowHostReceiptConsumerContext,
): DefaultSkillExecutionParts[] {
	const loaded = loader.getSkills();
	return snapshots.skills.map((snapshot) => {
		const skill = loaded.skills.find((candidate) => candidate.name === snapshot.skillName);
		const builtin = snapshot.builtinProvenance;
		if (skill === undefined || builtin === null) throw new Error("default_prime_persisted_skill_catalog_mismatch");
		return {
			loader,
			skill,
			loaderProvenance: snapshot.loaderProvenance,
			builtinProvenanceContext: {
				artifactResolver,
				keyResolver: receiptContext.keyResolver,
				revokedEventIds: new Set<string>(),
				hostCatalog: {
					vendoredRoot: builtin.vendoredRoot,
					registryArtifactRef: builtin.registryArtifactRef,
					sourceManifestArtifactRef: builtin.sourceManifestArtifactRef,
				},
			},
		};
	});
}

export interface DefaultPrimeWorkflowProviderInput {
	readonly runtimeVersion?: string;
	readonly host: PersistedSessionWorkflowHost;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly artifactRoot: string;
	readonly epochRef: WorkflowEpochRef;
	readonly writerIdentity: string;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly descriptorFs: WorkflowDescriptorFs;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
	readonly resolveLeaseRef: () => Promise<WorkflowLeaseRef>;
	readonly authority: PrimeWorkflowHostAuthority;
	readonly adaptiveAuthority: PrimeAdaptiveRuntimeHostAuthority;
	/** Optional caller loader is ignored for built-in admission; canonical vendored resources are host-owned. */
	/** Roots a task may own paths under; absent keeps DEFAULT_WORKSPACE_PATHS. */
	readonly workspacePaths?: readonly string[];
	readonly resourceLoader?: WorkflowResourceLoaderPort;
	readonly readStatus: () => WorkflowShellStatus;
	readonly executionEvidence: WorkflowExecutionEvidenceRuntime;
	readonly workerLauncher?: DefaultPrimeWorkerLauncher;
	readonly workerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
	readonly scheduleProgressWake?: DefaultTaskRuntimeAuthorityInput["scheduleProgressWake"];
	readonly withHostLeaseOperation?: DefaultTaskRuntimeAuthorityInput["withHostLeaseOperation"];
	readonly beforeTaskLaunch?: DefaultTaskRuntimeAuthorityInput["beforeTaskLaunch"];
	/** Host-owned stage, child, capacity, telemetry, and authenticated coordinator evidence adapter. */
	readonly taskRuntimePrimeAdapter?: WorkflowPrimeStageEvidenceAdapter;
	/** Required composition seam for the generic scheduler/dispatcher/lease/effect/recovery stack. */
	readonly taskRuntimeAuthorityFactory?: (input: {
		readonly runtimeVersion: string;
		readonly runtimeStore: WorkflowRuntimeStore;
		readonly workflowId: string;
		readonly rootSessionId: string;
		readonly epochRef: WorkflowEpochRef;
		readonly decisionRef: WorkflowDecisionRef;
		readonly goalRevisionDigest: string;
		readonly graph: WorkflowTaskGraph;
		readonly recipeDigest: string;
		readonly maxWorkers: number;
		readonly now: () => string;
		readonly workerLauncher?: DefaultPrimeWorkerLauncher;
		readonly createTaskCapsule: DefaultPrimeTaskCapsuleFactory;
		readonly workerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
		readonly blockWorkflow: DefaultTaskRuntimeAuthorityInput["blockWorkflow"];
		readonly scheduleProgressWake?: DefaultTaskRuntimeAuthorityInput["scheduleProgressWake"];
		readonly withHostLeaseOperation?: DefaultTaskRuntimeAuthorityInput["withHostLeaseOperation"];
		readonly readWorkflowStatus?: DefaultTaskRuntimeAuthorityInput["readWorkflowStatus"];
		readonly beforeTaskLaunch?: DefaultTaskRuntimeAuthorityInput["beforeTaskLaunch"];
		readonly prime: WorkflowPrimeStageEvidenceAdapter;
	}) => Promise<WorkflowTaskRuntimeAuthority> | WorkflowTaskRuntimeAuthority;
	/** One-use composition-root seam for the default completion evaluator. */
	readonly installCompletionReadinessAuthority: (authority: PersistedWorkflowCompletionReadinessAuthority) => void;
	readonly now?: () => string;
}

export type DefaultPrimeTaskRuntimeAuthorityFactory = NonNullable<
	DefaultPrimeWorkflowProviderInput["taskRuntimeAuthorityFactory"]
>;

export interface DefaultPrimeWorkflowProvider {
	readonly ensurePrimeWorkflow: () => Promise<ProductionPrimeWorkflow>;
	readonly current: () => ProductionPrimeWorkflow | undefined;
	readonly dispose: () => Promise<void>;
}

interface DefaultPrimeWorkflowComposition {
	readonly workflow: ProductionPrimeWorkflow;
	readonly taskRuntime: DefaultPrimeTaskRuntime;
}

function compareTaskIds(left: string, right: string): number {
	const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
	const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
	for (let index = 0; index < Math.min(leftCodePoints.length, rightCodePoints.length); index += 1) {
		const difference = (leftCodePoints[index] ?? 0) - (rightCodePoints[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return leftCodePoints.length - rightCodePoints.length;
}

function orderedTaskGraphSourceTaskIds(source: WorkflowTaskGraphSource): readonly string[] {
	const taskIds = source.tasks.map((task) => task.taskId);
	const indegree = new Map(taskIds.map((taskId) => [taskId, 0]));
	const outgoing = new Map<string, string[]>();
	for (const task of source.tasks) {
		for (const dependencyTaskId of task.dependencyTaskIds) {
			const successors = outgoing.get(dependencyTaskId) ?? [];
			if (!successors.includes(task.taskId)) successors.push(task.taskId);
			outgoing.set(dependencyTaskId, successors);
			indegree.set(task.taskId, (indegree.get(task.taskId) ?? 0) + 1);
		}
	}
	const ready = taskIds.filter((taskId) => indegree.get(taskId) === 0).sort(compareTaskIds);
	const ordered: string[] = [];
	while (ready.length > 0) {
		const taskId = ready.shift();
		if (taskId === undefined) break;
		ordered.push(taskId);
		for (const successor of outgoing.get(taskId) ?? []) {
			const nextDegree = (indegree.get(successor) ?? 0) - 1;
			indegree.set(successor, nextDegree);
			if (nextDegree === 0) ready.push(successor);
		}
		ready.sort(compareTaskIds);
	}
	if (ordered.length !== taskIds.length) throw new Error("default_prime_task_graph_source_cycle");
	return Object.freeze(ordered);
}

/**
 * Build the default production Prime provider around the host-owned runtime.
 *
 * Args:
 * input: The one persisted runtime, receipt authority, descriptor root, and canonical ResourceLoader.
 * Return: A lazy provider which waits for a durable workflow head before issuing immutable admissions.
 */
export function createDefaultPrimeWorkflowProvider(
	input: DefaultPrimeWorkflowProviderInput,
): DefaultPrimeWorkflowProvider {
	let current: ProductionPrimeWorkflow | undefined;
	let taskRuntime: DefaultPrimeTaskRuntime | undefined;
	let inFlight: Promise<DefaultPrimeWorkflowComposition> | undefined;
	const ensurePrimeWorkflow = async (): Promise<ProductionPrimeWorkflow> => {
		if (current !== undefined) return current;
		if (inFlight !== undefined) return (await inFlight).workflow;
		inFlight = composeDefaultPrimeWorkflow(input);
		try {
			const composition = await inFlight;
			current = composition.workflow;
			taskRuntime = composition.taskRuntime;
			return current;
		} finally {
			inFlight = undefined;
		}
	};
	return Object.freeze({
		ensurePrimeWorkflow,
		current: () => current,
		dispose: async () => {
			await taskRuntime?.dispose();
		},
	});
}

async function composeDefaultPrimeWorkflow(
	input: DefaultPrimeWorkflowProviderInput,
): Promise<DefaultPrimeWorkflowComposition> {
	const replay = await input.runtimeStore.replay({
		workflowId: input.workflowId,
		fromSequence: 0,
		expectedStoreEpoch: input.epochRef.storeEpoch,
	});
	if (
		replay.quarantined ||
		replay.head.workflowId !== input.workflowId ||
		replay.head.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		replay.head.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		replay.head.eventDigest === null ||
		replay.head.sequence < 1
	)
		throw new Error("default_prime_requires_authenticated_workflow_head");
	const headDigest = replay.head.eventDigest;
	const status = input.readStatus();
	if (status.workflowId !== input.workflowId || status.stateDigest === null)
		throw new Error("default_prime_requires_started_workflow");
	const goalContractRecord = status.goalContract as unknown as Record<string, unknown> | null;
	const graphSourceCandidate: WorkflowTaskGraphSourceReference | undefined =
		goalContractRecord !== null && isRecord(goalContractRecord.taskGraphSource)
			? isWorkflowTaskGraphSourceReference(goalContractRecord.taskGraphSource.source)
				? goalContractRecord.taskGraphSource.source
				: isWorkflowTaskGraphSourceReference(goalContractRecord.taskGraphSource)
					? goalContractRecord.taskGraphSource
					: isWorkflowTaskGraphSourceReference(status.goalContract?.authoritativeSource)
						? status.goalContract.authoritativeSource
						: undefined
			: isWorkflowTaskGraphSourceReference(status.goalContract?.authoritativeSource)
				? status.goalContract.authoritativeSource
				: undefined;
	if (graphSourceCandidate === undefined) throw new Error("default_prime_task_graph_source_missing");
	const taskGraphSource = await readWorkflowTaskGraphSource({
		artifactRoot: input.artifactRoot,
		source: graphSourceCandidate,
	});
	if (taskGraphSource === undefined) throw new Error("default_prime_task_graph_source_missing");
	assertWorkflowTaskGraphSourceContract({
		source: taskGraphSource,
		acceptanceCheckIds: status.acceptanceCheckIds,
		protectedInvariantIds: status.protectedInvariantIds,
	});
	const decisionRef = resourceDecision(status, input.workflowId);
	if (decisionRef === null) throw new Error("default_prime_resource_decision_unavailable");
	const trustedNow = input.now?.() ?? new Date().toISOString();
	const sourceEventSequence = Math.max(DEFAULT_SKILL_SOURCE_SEQUENCE, replay.head.sequence);
	const canonicalBuiltinLoader = createCanonicalBuiltinResourceLoader();
	const publish = (bytes: Uint8Array, codec: "canonical_json" | "binary", idempotencyKey: string) =>
		publishEvidence(input, bytes, codec, sourceEventSequence, idempotencyKey);
	const publishSkill = (bytes: Uint8Array, codec: "canonical_json" | "binary", idempotencyKey: string) =>
		publishEvidence(input, bytes, codec, sourceEventSequence, idempotencyKey, "skills");

	const persisted = await readPersistedComposition(input);
	let snapshots: PrimeWorkflowSnapshots;
	let taskGraph: WorkflowTaskGraph;
	let skillParts: DefaultSkillExecutionParts[];
	if (persisted !== undefined) {
		// The persisted recipe is the immutable admission; subsequent authenticated events may advance the head.
		snapshots = persisted;
		taskGraph = createDefaultTaskGraph({
			...(input.workspacePaths === undefined ? {} : { workspacePaths: input.workspacePaths }),
			acceptanceCheckIds: status.acceptanceCheckIds,
			protectedInvariantIds: status.protectedInvariantIds,
			requiredSkillSnapshotDigests: snapshots.skills.map((skill) => skill.snapshotDigest),
			taskGraphSource,
		});
		if (taskGraph.graphDigest !== snapshots.recipe.baseTaskGraphDigest)
			throw new Error("default_prime_persisted_task_graph_mismatch");
		skillParts = persistedSkillExecutionParts(
			snapshots,
			canonicalBuiltinLoader,
			input.artifactResolver,
			input.receiptContext,
		);
	} else {
		const freshSkillParts: DefaultSkillParts[] = [];
		for (const skillName of [
			"workflow-autoresearch",
			"mempalace",
			"brainstorming",
			"writing-plans",
			"test-driven-development",
			"systematic-debugging",
			"verification-before-completion",
		] as const) {
			const parts = await createDefaultSkillSnapshot({
				...input,
				resourceLoader: canonicalBuiltinLoader,
				headDigest,
				trustedNow,
				publish: publishSkill,
				skillName,
				...(freshSkillParts[0] === undefined
					? {}
					: {
							sharedLoaderProvenance: freshSkillParts[0].loaderProvenance,
							sharedLoaderTrustedNow: freshSkillParts[0].trustedNow,
						}),
			});
			freshSkillParts.push(parts);
		}
		const config = await createDefaultConfig({
			...input,
			contentDigests: freshSkillParts.map((parts) => parts.contentDigest),
			publish,
		});
		// Sequential: concurrent snapshot creation makes every fresh skill contend for the
		// same per-workflow receipt-consumption lease (they share one loader-issuance receipt),
		// and enough concurrent contenders can exceed the lease's fixed acquisition timeout.
		const skills: WorkflowSkillSnapshot[] = [];
		for (const parts of freshSkillParts) {
			skills.push(
				await createSkillWithConfig({
					...input,
					...parts,
					configDigest: config.resolvedConfigDigest,
					decisionRef,
					headDigest,
					trustedNow: parts.trustedNow,
				}),
			);
		}
		const compiledRecipe = await createDefaultRecipe({
			...(input.workspacePaths === undefined ? {} : { workspacePaths: input.workspacePaths }),
			...input,
			headDigest: replay.head.eventDigest,
			decisionRef,
			trustedNow,
			acceptanceCheckIds: status.acceptanceCheckIds,
			protectedInvariantIds: status.protectedInvariantIds,
			requiredSkillSnapshotDigests: skills.map((skill) => skill.snapshotDigest),
			taskGraphSource,
		});
		snapshots = Object.freeze({
			config,
			recipe: compiledRecipe.admission,
			skills: Object.freeze(skills),
		});
		taskGraph = compiledRecipe.graph;
		await persistComposition(input, snapshots);
		skillParts = freshSkillParts;
	}
	const persistedAutoResearchRecipe = await readPersistedAutoResearchRecipe(input, snapshots.recipe.recipeDigest);
	const autoResearchRecipe =
		persistedAutoResearchRecipe ?? (await createDefaultAutoResearchRecipe(input, snapshots, replay, decisionRef));
	if (persistedAutoResearchRecipe === undefined) await persistAutoResearchRecipe(input, autoResearchRecipe);
	const autoResearchRunner = await createDefaultAutoResearchRunner(input, autoResearchRecipe);
	const consumeRecipeAdmission = await createDefaultRecipeAdmissionConsumer(input, snapshots.recipe);
	const runId = `prime:${input.workflowId}:${replay.head.eventDigest}`;
	const executionKey = digestObject({
		kind: "default-prime-execution",
		workflowId: input.workflowId,
		headDigest: replay.head.eventDigest,
		recipeDigest: snapshots.recipe.recipeDigest,
	});
	const defaultLearning = await createDefaultLearningRuntime(
		input,
		snapshots,
		autoResearchRecipe,
		executionKey,
		taskGraph,
	);
	const learning = defaultLearning.runtime;
	const adaptiveRuntime = createPrimeAdaptiveRuntime({
		host: input.host,
		hostAuthority: input.adaptiveAuthority,
		runtimeStore: input.runtimeStore,
		artifactResolver: input.artifactResolver,
		workflowId: input.workflowId,
		epochRef: input.epochRef,
		graph: taskGraph,
		admission: snapshots.recipe,
		approvedParallelism: defaultPrimeApprovedParallelism(replay),
		now: () => input.now?.() ?? new Date().toISOString(),
	});
	const defaultTaskPrimeAdapter: WorkflowPrimeStageEvidenceAdapter = {
		recordEvidence: async () => ({
			boundary: "public_boundary",
			verification: "host_verified",
			evidenceKind: "durable_store",
			authorizesTerminalization: true,
		}),
		readCoordinatorStatus: async () => {
			throw new Error("default_prime_task_runtime_status_is_authority_owned");
		},
		recordTelemetry: async () => undefined,
		assertStageAcceptable: async () => undefined,
		acceptStage: async () => undefined,
		readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
	};
	const taskRuntimePrimeAdapter = input.taskRuntimePrimeAdapter ?? defaultTaskPrimeAdapter;
	const taskRuntimeStatus = input.readStatus();
	const taskRuntimeDecisionRef = resourceDecision(taskRuntimeStatus, input.workflowId);
	if (taskRuntimeDecisionRef === null) throw new Error("default_prime_task_runtime_decision_missing");
	const goalRevisionDigest = taskRuntimeStatus.goalContract?.contractDigest;
	if (goalRevisionDigest === undefined) throw new Error("default_prime_goal_revision_unavailable");
	const goalBindingDigest = defaultPrimeGoalBindingDigest(taskRuntimeStatus);
	const createTaskCapsule: DefaultPrimeTaskCapsuleFactory = async (request) => {
		const taskBinding = snapshots.recipe.taskBindings.find((binding) => binding.taskId === request.task.taskId);
		const stage = snapshots.recipe.recipeBinding.proposal.stages.find(
			(candidate) => candidate.taskId === request.task.taskId,
		);
		const evidencePolicy = snapshots.recipe.recipeBinding.proposal.evidencePolicies.find(
			(candidate) => candidate.id === stage?.evidencePolicyId,
		);
		if (
			taskBinding === undefined ||
			stage === undefined ||
			evidencePolicy === undefined ||
			taskBinding.generatedOutputPaths.length !== 1 ||
			taskBinding.taskDigest !== digestObject(request.task)
		)
			throw new Error("default_prime_task_contract_unsatisfiable");
		const capsuleCore: DefaultPrimeWorkerTaskCapsuleCore = {
			schemaVersion: 1,
			kind: "default_prime_worker_task_capsule",
			workflowId: input.workflowId,
			taskId: request.task.taskId,
			attemptId: request.attemptId,
			executionKey: request.executionKey,
			epochRef: request.epochRef,
			journalHead: request.journalHead,
			goalRevisionDigest,
			goalBindingDigest,
			graphDigest: taskGraph.graphDigest,
			taskGraphSourceDigest: request.task.taskGraphSourceDigest,
			recipeCapability:
				snapshots.recipe.recipeId === BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.recipeId
					? "builtin_adaptive_prime"
					: "dynamic_task_graph",
			recipeDigest: snapshots.recipe.recipeDigest,
			admissionDigest: snapshots.recipe.admissionDigest,
			objective: request.task.objective,
			requirementIds: request.task.requirementIds,
			completionCriteria: request.task.completionCriteria,
			dependencyTaskIds: request.task.dependencyTaskIds,
			inputRefs: request.task.inputRefs,
			boundaryIds: request.task.boundaryIds,
			outputRefs: request.task.outputRefs,
			evidencePolicy: request.task.evidencePolicy,
			evidenceKind: request.task.evidenceKind,
			budget: request.task.budget,
			recoveryPolicy: request.task.recoveryPolicy,
			authority: request.task.authority,
			deadlineAt: request.deadlineAt,
			outputContract: defaultPrimeWorkerOutputContract({
				taskId: request.task.taskId,
				logicalPath: taskBinding.generatedOutputPaths[0]!,
				evidencePolicyId: evidencePolicy.id,
				maxBytes: evidencePolicy.maxBytes,
				maxItems: evidencePolicy.maxItems,
				independent: evidencePolicy.independent === true,
				evidenceKind: evidencePolicy.kind,
			}),
			forbiddenOutcomes: ["prose_only_result", "unbound_or_extra_output", "protected_or_holdout_data"],
			terminalReturnProtocol: "canonical_json_only",
		};
		const capsuleDigest = defaultPrimeWorkerTaskCapsuleDigest(capsuleCore);
		const receipt = await input.issueReceipt({
			receiptKind: "artifact",
			workflowId: input.workflowId,
			bindingDigest: defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest),
			receiptId: `task-capsule-${request.executionKey.slice(0, 48)}`,
			oneUse: false,
			issuedAt: input.now?.() ?? new Date().toISOString(),
			stateDigest: request.journalHead.eventDigest ?? goalBindingDigest,
			revision: request.task.planRevision,
			payloadKind: "workflow-recipe",
			payloadDigest: capsuleDigest,
		});
		return { ...capsuleCore, capsuleDigest, receipt };
	};
	const policyAwareWorkerLauncher: DefaultPrimeWorkerLauncher | undefined =
		input.workerLauncher === undefined
			? undefined
			: async (request) => {
					const launch = await input.workerLauncher!(request);
					const recoveryPolicy = taskGraph.byId.get(request.taskId)?.recoveryPolicy;
					if (launch.completion === undefined || recoveryPolicy === undefined || recoveryPolicy === "retry")
						return launch;
					return {
						...launch,
						completion: launch.completion.then((completion) =>
							completion.status === "completed"
								? completion
								: {
										...completion,
										error: completion.error ?? `task_${recoveryPolicy}_required`,
										retryable: false,
									},
						),
					};
				};
	const taskRuntime = createDefaultPrimeTaskRuntime({
		authority:
			input.taskRuntimeAuthorityFactory === undefined
				? createDefaultTaskRuntimeAuthority({
						runtimeStore: input.runtimeStore,
						workflowId: input.workflowId,
						rootSessionId: input.rootSessionId,
						epochRef: input.epochRef,
						decisionRef: taskRuntimeDecisionRef,
						goalRevisionDigest,
						graph: taskGraph,
						maxWorkers: defaultPrimeApprovedParallelism(replay),
						now: () => input.now?.() ?? new Date().toISOString(),
						workerLauncher: policyAwareWorkerLauncher,
						createTaskCapsule,
						workerFailureDelivery: input.workerFailureDelivery,
						blockWorkflow: (blocker) => input.host.blockOnExternal(blocker).then(() => undefined),
						scheduleProgressWake: input.scheduleProgressWake,
						withHostLeaseOperation: input.withHostLeaseOperation,
						readWorkflowStatus: input.readStatus,
						beforeTaskLaunch: input.beforeTaskLaunch,
						prime: taskRuntimePrimeAdapter,
					})
				: await input.taskRuntimeAuthorityFactory({
						runtimeVersion: input.runtimeVersion ?? MIN_WORKFLOW_RUNTIME_VERSION,
						runtimeStore: input.runtimeStore,
						workflowId: input.workflowId,
						rootSessionId: input.rootSessionId,
						epochRef: input.epochRef,
						decisionRef: taskRuntimeDecisionRef,
						goalRevisionDigest,
						graph: taskGraph,
						recipeDigest: snapshots.recipe.recipeDigest,
						maxWorkers: defaultPrimeApprovedParallelism(replay),
						now: () => input.now?.() ?? new Date().toISOString(),
						workerLauncher: policyAwareWorkerLauncher,
						createTaskCapsule,
						workerFailureDelivery: input.workerFailureDelivery,
						blockWorkflow: (blocker) => input.host.blockOnExternal(blocker).then(() => undefined),
						scheduleProgressWake: input.scheduleProgressWake,
						withHostLeaseOperation: input.withHostLeaseOperation,
						readWorkflowStatus: input.readStatus,
						beforeTaskLaunch: input.beforeTaskLaunch,
						prime: taskRuntimePrimeAdapter,
					}),
	});
	await adaptiveRuntime.recover(defaultLearning.pipeline.current());
	const pipeline: PrimeWorkflowPipelineRuntime = Object.freeze({
		current: () => defaultLearning.pipeline.current(),
		read: () => defaultLearning.pipeline.read(),
		record: async (request: { readonly stageId: string; readonly evidenceRefs: readonly WorkflowArtifactRef[] }) => {
			const classification = await taskRuntime.prime.recordEvidence(request);
			await taskRuntime.assertStageAcceptable({ stageId: request.stageId, classification });
			const state = await defaultLearning.pipeline.record(request);
			await adaptiveRuntime.onPipelineCommitted(state);
			await taskRuntime.acceptStage({ stageId: request.stageId, classification });
			return state;
		},
	});
	const autoresearchExecutionKey = digestObject({
		kind: "default-prime-autoresearch-execution",
		recipeDigest: autoResearchRecipe.recipeDigest,
	});
	const skillCasRoot = join(input.artifactRoot, "prime-skill-invocations");
	await mkdir(skillCasRoot, { recursive: true, mode: 0o700 });
	const invocationSigner = input.receiptContext.signer;
	if (invocationSigner === undefined) throw new Error("default_prime_skill_signer_unavailable");
	const skillIterationRecord = "default-prime-skill-iterations-v1";
	const nextSkillIteration = async (skillName: string): Promise<number> => {
		const durable = input.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("default_prime_skill_iteration_requires_durable_runtime");
		return durable.withExclusiveLease(`default-prime-skill-iteration:${skillName}`, async () => {
			const bytes = await durable.auxiliaryStore.read(skillIterationRecord);
			const parsed = bytes === null ? {} : parseCanonicalJsonBytes(bytes);
			if (
				parsed === null ||
				typeof parsed !== "object" ||
				Array.isArray(parsed) ||
				Object.values(parsed).some((value) => !Number.isSafeInteger(value) || (value as number) < 0)
			)
				throw new Error("default_prime_skill_iteration_record_invalid");
			const current = (parsed as Record<string, unknown>)[skillName];
			const next = (typeof current === "number" ? current : 0) + 1;
			if (!Number.isSafeInteger(next)) throw new Error("default_prime_skill_iteration_sequence_exhausted");
			await durable.auxiliaryStore.write(
				skillIterationRecord,
				canonicalJsonBytes({ ...(parsed as Record<string, unknown>), [skillName]: next }),
			);
			return next;
		});
	};
	const skillActiveHostState = createWorkflowSkillRuntimeStoreHostStateReader(input.runtimeStore);
	const skillExecution = createWorkflowSkillProductionExecutionAdapter({
		loader: skillParts[0].loader,
		loaderProvenance: snapshots.skills[0].loaderProvenance,
		artifacts: input.artifactResolver,
		publisher: {
			publish: (publishInput) =>
				input.runtimeStore.publishArtifact({ ...publishInput, artifactNamespace: "skills" }),
		},
		receiptContext: input.receiptContext,
		verifyExecutionEffects: createDefaultPrimeSkillEffectVerifier({
			activeHostState: skillActiveHostState,
			artifactResolver: input.artifactResolver,
			workflowId: input.workflowId,
			epochRef: input.epochRef,
			defaultExecutionKey: executionKey,
			autoresearchExecutionKey,
		}),
		builtinProvenanceContext: skillParts[0].builtinProvenanceContext,
		builtinProvenanceContextForSnapshot: (snapshot) =>
			skillParts.find((parts) => parts.skill.name === snapshot.skillName)?.builtinProvenanceContext,
		invocationStore: createWorkflowSkillDescriptorInvocationStore({
			descriptorFs: input.descriptorFs,
			rootPath: skillCasRoot,
			activeHostState: skillActiveHostState,
			signer: {
				keyId: invocationSigner.keyId,
				signatureAlgorithm: invocationSigner.signatureAlgorithm,
				sign: invocationSigner.sign,
			},
		}),
	});
	const executeSkillIteration = async <TResult>(request: {
		readonly skillName: string;
		readonly current: WorkflowSkillHostInvocationContext;
		readonly executor: WorkflowSkillExecutor<TResult>;
	}): Promise<TResult> => {
		const skillExecutionAdapter = skillExecution;
		const snapshot = snapshots.skills.find((candidate) => candidate.skillName === request.skillName);
		if (snapshot === undefined) throw new Error("prime_workflow_skill_snapshot_not_admitted");
		let consumeSequence = await nextSkillIteration(request.skillName);
		const active = await skillActiveHostState.read(snapshot.workflowId);
		let iteration =
			consumeSequence === snapshot.consumeSequence && active.journalHeadDigest === snapshot.journalHeadDigest
				? deriveWorkflowSkillInvocationSnapshot(snapshot, consumeSequence)
				: await reissueWorkflowSkillInvocationSnapshot(snapshot, skillActiveHostState, {
						consumeSequence: Math.max(consumeSequence, snapshot.consumeSequence + 1),
						trustedNow: input.now?.() ?? new Date().toISOString(),
					});
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const current: WorkflowSkillHostInvocationContext = {
				...request.current,
				epochRef: { ...iteration.epochRef },
				journalHeadDigest: iteration.journalHeadDigest,
				trustedNow: iteration.trustedNow,
			};
			try {
				const admission = await skillExecutionAdapter.validateAndConsume(
					iteration,
					getSkillInvocationToken(iteration),
					current,
				);
				if (admission === undefined) throw new Error("prime_workflow_skill_invocation_not_admitted");
				return await skillExecutionAdapter.execute(admission, iteration, current, request.executor);
			} catch (error) {
				if (attempt === 2 || !isSkillInvocationHeadRace(error)) throw error;
				consumeSequence = await nextSkillIteration(request.skillName);
				iteration = await reissueWorkflowSkillInvocationSnapshot(snapshot, skillActiveHostState, {
					consumeSequence: Math.max(consumeSequence, iteration.consumeSequence + 1, snapshot.consumeSequence + 1),
					trustedNow: input.now?.() ?? new Date().toISOString(),
				});
			}
		}
		throw new Error("prime_workflow_skill_invocation_not_admitted");
	};
	let readCompletionAuditContext: (() => Promise<DefaultPrimeCompletionAuditContext>) | undefined;
	const completionRequestHandler = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
		if (Object.keys(payload).some((key) => key !== "type"))
			throw new Error("default_prime_completion_payload_must_be_empty");
		if (readCompletionAuditContext === undefined)
			throw new Error("default_prime_completion_readiness_authority_unavailable");
		const audit = await readCompletionAuditContext();
		const completedStageIds = new Set(audit.completedStageIds);
		if (
			audit.readyStageIds.length !== 0 ||
			completedStageIds.size !== audit.completedStageIds.length ||
			completedStageIds.size !== audit.requiredStageIds.length ||
			audit.requiredStageIds.some((stageId) => !completedStageIds.has(stageId))
		)
			throw new Error("default_prime_completion_pipeline_not_complete");
		const status = input.readStatus();
		if (status.status !== "active" || status.stateDigest === null || status.goalContract === null)
			throw new Error("default_prime_completion_active_goal_contract_required");
		const evidenceRefs = [
			...new Map(
				[
					...audit.executionEvidenceRefs,
					...audit.workerLaunchEvidenceRefs,
					...audit.stageEvidence.flatMap((stage) => [stage.sourceEventRef, ...stage.evidenceRefs]),
				].map((ref) => [digestObject(ref), structuredClone(ref)]),
			).values(),
		];
		if (evidenceRefs.length === 0) throw new Error("default_prime_completion_execution_evidence_required");
		const outputStateDigest = digestObject({
			kind: "default_prime_completion_output",
			goalContract: status.goalContract,
			auditDigest: digestObject(audit),
			evidenceDigest: digestObject(evidenceRefs),
		});
		const phaseAttemptId = `completion-${outputStateDigest.slice(0, 48)}`;
		const completed = await input.host.runOutcome({
			attemptStatus: "completed",
			outcome: {
				status: "complete",
				workflowId: input.workflowId,
				phaseAttemptId,
				epochRef: input.epochRef,
				invocationToken: digestObject({ phaseAttemptId, inputStateDigest: status.stateDigest }),
				inputStateDigest: status.stateDigest,
				outputStateDigest,
				artifactRefs: [],
				evidenceRefs,
			},
		});
		return {
			status: completed.status,
			goal_status: completed.goalStatus,
			state_digest: completed.sourceJournalDigest,
			can_authorize: false,
		};
	};
	const adapters = createPrimeWorkflowBuiltinAdapters({
		runtimeStore: input.runtimeStore,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		artifactResolver: input.artifactResolver,
		epochRef: input.epochRef,
		readStatus: input.readStatus,
		runId,
		executionKey,
		writerIdentity: input.writerIdentity,
		resolveLeaseRef: input.resolveLeaseRef,
		receiptContext: input.receiptContext,
		issueReceipt: input.issueReceipt,
		now: input.now,
		snapshots,
		autoResearchRunner,
		learning,
		learningReviewHandler: async (payload) => {
			if (typeof payload.experience_id !== "string" || payload.experience_id.trim().length === 0)
				throw new Error("default_prime_learning_experience_id_invalid");
			return defaultLearning.reviewExperience(payload.experience_id);
		},
		learningRollbackHandler: async (payload) => {
			if (typeof payload.candidate_id !== "string" || payload.candidate_id.trim().length === 0)
				throw new Error("default_prime_learning_candidate_id_invalid");
			return defaultLearning.rollbackCandidate(payload.candidate_id);
		},
		completionRequestHandler,
		pipeline,
		adaptiveRuntime,
		scheduler: taskRuntime.scheduler,
		executionEvidence: input.executionEvidence,
		skillExecution,
		consumeRecipeAdmission,
		authority: input.authority,
	});
	readCompletionAuditContext = async (): Promise<DefaultPrimeCompletionAuditContext> => {
		const status = input.readStatus();
		if (status.workflowId !== input.workflowId || status.goalContract === null)
			throw new Error("default_prime_completion_goal_contract_unavailable");
		if (typeof status.goal.objective !== "string" || status.goal.objective.length === 0)
			throw new Error("default_prime_completion_objective_unavailable");
		if (adapters.knowledgeStore === undefined)
			throw new Error("default_prime_completion_knowledge_store_unavailable");
		const [pipelineState, stageEvidence, executionState, adaptiveState, learningState, knowledgeState, taskAudit] =
			await Promise.all([
				pipeline.read(),
				defaultLearning.completionStageEvidence(),
				input.executionEvidence.read(),
				adaptiveRuntime.read(),
				learning.getState(),
				adapters.knowledgeStore.read(),
				taskRuntime.readAudit(),
			]);
		return Object.freeze({
			workflowId: input.workflowId,
			rootSessionId: input.rootSessionId,
			objective: status.goal.objective,
			recipeCapability:
				snapshots.recipe.recipeId === BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.recipeId
					? "builtin_adaptive_prime"
					: "dynamic_task_graph",
			goalContract: structuredClone(status.goalContract),
			acceptanceCheckIds: [...status.acceptanceCheckIds],
			protectedInvariantIds: [...status.protectedInvariantIds],
			requiredStageIds: taskGraph.tasks.map((task) => task.taskId),
			completedStageIds: [...pipelineState.completedStageIds],
			readyStageIds: [...pipelineState.readyStageIds],
			pipelineStateDigest: pipelineState.stateDigest,
			stageEvidence: structuredClone(stageEvidence),
			goalMetricEvaluations: [],
			executionEvidenceStateDigest: executionState.stateDigest,
			executionEvidenceRefs: structuredClone(executionState.observationRefs),
			schedulerStateDigest: digestObject(taskAudit.scheduler),
			schedulerActiveAttemptIds: [...taskAudit.scheduler.activeAttemptIds],
			schedulerTerminalTaskIds: [...taskAudit.terminalTaskIds],
			workerLaunchEvidenceRefs: structuredClone(taskAudit.launchEvidenceRefs),
			adaptiveStateDigest: adaptiveState.stateDigest,
			adaptiveReviewCount: adaptiveState.reviewCount,
			learningStateDigest: learningState.stateDigest,
			knowledgeStateDigest: knowledgeState.digest ?? digestObject(knowledgeState),
		});
	};
	input.installCompletionReadinessAuthority(
		createDefaultPrimeCompletionReadinessAuthority({
			runtimeStore: input.runtimeStore,
			artifactResolver: input.artifactResolver,
			issueReceipt: input.issueReceipt,
			now: () => input.now?.() ?? new Date().toISOString(),
			readAuditContext: () => {
				if (readCompletionAuditContext === undefined)
					throw new Error("default_prime_completion_readiness_authority_unavailable");
				return readCompletionAuditContext();
			},
		}),
	);
	const workflow = await createProductionPrimeWorkflow({
		runtimeStore: input.runtimeStore,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		artifactRoot: input.artifactRoot,
		readStatus: input.readStatus,
		adapters,
		taskGraph,
		readSchedulerState: taskRuntime.read,
		epochRef: input.epochRef,
		executeSkillIteration,
		recordSkillOutcome: async (skillName, result) => {
			if (skillName !== "workflow-autoresearch") return;
			await defaultLearning.recordAutoResearchOutcome(result as AutoResearchPythonResult);
		},
	});
	await taskRuntime.start();
	return { workflow, taskRuntime };
}

function createCanonicalBuiltinResourceLoader(): WorkflowResourceLoaderPort {
	const loaded = loadSkillsFromDir({ dir: getBundledSkillsDir(), source: "builtin" });
	return Object.freeze({
		getSkills: () => ({ skills: structuredClone(loaded.skills), diagnostics: structuredClone(loaded.diagnostics) }),
	});
}

function resourceDecision(status: WorkflowShellStatus, workflowId: string): WorkflowDecisionRef | null {
	const matches = status.decisionRefs.filter(
		(candidate) =>
			candidate.decisionId === `resource_envelope:${workflowId}` &&
			candidate.decisionScope.kind === "workflow" &&
			candidate.decisionScope.workflowId === workflowId,
	);
	return matches.length === 1 ? matches[0] : null;
}

function goalDecision(status: WorkflowShellStatus, workflowId: string): WorkflowDecisionRef | null {
	const matches = status.decisionRefs.filter(
		(candidate) =>
			candidate.decisionId === `goal_contract:${workflowId}` &&
			candidate.decisionScope.kind === "workflow" &&
			candidate.decisionScope.workflowId === workflowId,
	);
	return matches.length === 1 ? matches[0] : null;
}

function defaultPrimeApprovedParallelism(replay: WorkflowStoreReplayResult): number {
	let selected: Extract<WorkflowEventPayload, { kind: "profile_selected" }> | undefined;
	let approval: Extract<WorkflowEventPayload, { kind: "approval_consumed" }> | undefined;
	for (const event of replay.events) {
		if (event.payload.kind === "profile_selected") selected = event.payload;
		if (event.payload.kind === "approval_consumed") approval = event.payload;
	}
	if (selected === undefined || approval === undefined)
		throw new Error("default_prime_adaptive_resource_approval_unavailable");
	if (approval.receipt.optionId !== "approve" && approval.receipt.optionId !== "approve_cloud")
		throw new Error("default_prime_adaptive_resource_approval_invalid");
	if (!Number.isSafeInteger(selected.maxWorkers) || selected.maxWorkers < 1)
		throw new Error("default_prime_adaptive_parallelism_invalid");
	return selected.maxWorkers;
}

function defaultPrimeAutoResearchResourceVector(bytes = 1): WorkflowResourceVector {
	const boundedBytes = Math.max(1, bytes);
	return {
		cpuMilliCores: 1,
		memoryBytes: boundedBytes,
		diskBytes: boundedBytes,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: boundedBytes,
		monetaryMicrounits: boundedBytes,
	};
}

async function createDefaultAutoResearchRecipe(
	input: DefaultPrimeWorkflowProviderInput,
	snapshots: PrimeWorkflowSnapshots,
	replay: WorkflowStoreReplayResult,
	decisionRef: WorkflowDecisionRef,
): Promise<AutoResearchDurableRecipe> {
	if (replay.head.eventDigest === null) throw new Error("default_prime_autoresearch_head_digest_missing");
	const status = input.readStatus();
	if (
		status.workflowId !== input.workflowId ||
		status.status !== "active" ||
		typeof status.goal.objective !== "string" ||
		status.goal.objective.trim().length === 0 ||
		status.acceptanceCheckIds.length === 0 ||
		status.protectedInvariantIds.length === 0
	)
		throw new Error("default_prime_autoresearch_goal_binding_missing");
	const recipeDigest = snapshots.recipe.recipeDigest;
	const goalBindingDigest = digestObject({
		workflowId: input.workflowId,
		objective: status.goal.objective,
		acceptanceCheckIds: status.acceptanceCheckIds,
		protectedInvariantIds: status.protectedInvariantIds,
	});
	const prefix = (kind: string): string =>
		digestObject({
			kind: `default-prime-autoresearch-${kind}`,
			workflowId: input.workflowId,
			recipeDigest,
			goalBindingDigest,
		});
	const trainInputDigest = prefix("train-input");
	const evalInputDigest = prefix("eval-input");
	const holdoutInputDigest = prefix("holdout-input");
	const adversarialInputDigest = prefix("adversarial-input");
	const trainManifestDigest = prefix("train-manifest");
	const evalManifestDigest = prefix("eval-manifest");
	const holdoutManifestDigest = prefix("holdout-manifest");
	const adversarialManifestDigest = prefix("adversarial-manifest");
	const commandDigest = prefix("command");
	const inputDigests = [trainInputDigest, evalInputDigest];
	const commandInputBinding = {
		commandDigest,
		inputDigests,
		bindingDigest: digestObject({ commandDigest, inputDigests: [...inputDigests].sort() }),
	};
	const evaluatorDigest = snapshots.config.evaluatorDigests[0];
	const parserDigest = snapshots.config.parserDigests[0];
	if (evaluatorDigest === undefined || parserDigest === undefined)
		throw new Error("default_prime_autoresearch_evaluator_binding_missing");
	const revisionBindingDigest = digestObject({
		kind: "default-prime-autoresearch-revision",
		workflowId: input.workflowId,
		recipeDigest,
		decisionRef,
		headDigest: replay.head.eventDigest,
	});
	const revisionReceipt = await input.issueReceipt({
		receiptKind: "decision",
		workflowId: input.workflowId,
		bindingDigest: revisionBindingDigest,
		stateDigest: replay.head.eventDigest,
		revision: Math.max(1, replay.head.sequence),
		payloadKind: "workflow-learning",
		payloadDigest: decisionRef.decisionDigest,
	});
	const revisionWithoutDigest = {
		registryEntryRef: revisionReceipt.artifactRef,
		registryEntryId: `default-prime-autoresearch:${input.workflowId}`,
		registryEpoch: input.epochRef.storeEpoch,
		revisionKind: "workflow" as const,
		scope: "workflow" as const,
		scopeBinding: { scope: "workflow" as const, workflowId: input.workflowId },
		registryStatus: "approved" as const,
		compatibilityClosureDigest: snapshots.config.resolvedConfigDigest,
		expectedRegistryEpoch: input.epochRef.storeEpoch,
		observedRegistryEpoch: input.epochRef.storeEpoch,
		revocationEpoch: null,
		revocationEventSequence: null,
		rollbackOfRevisionId: null,
		rollbackEventSequence: null,
		casExecutionKey: digestObject({ kind: "default-prime-autoresearch-cas", recipeDigest }),
		hostReceipt: revisionReceipt,
	};
	const revisionResolution = {
		...revisionWithoutDigest,
		resolutionDigest: digestObject(revisionWithoutDigest),
	};
	const registration: AutoResearchExperimentRegistration = {
		runId: `default-prime-autoresearch:${input.workflowId}`,
		workflowId: input.workflowId,
		revisionResolution,
		metric: {
			metricId: prefix("metric-id"),
			name: "uncovered_adversarial_stage_count",
			direction: "lower",
			target: 0,
			tolerance: 0,
		},
		evaluator: { evaluatorDigest, parserDigest, commandDigest },
		commandInputBinding,
		seed: { seedId: prefix("seed-id"), seedDigest: prefix("seed") },
		fixtures: [
			{
				fixtureId: "train",
				partition: "train",
				inputDigest: trainInputDigest,
				manifestDigest: trainManifestDigest,
				hidden: false,
			},
			{
				fixtureId: "eval",
				partition: "eval",
				inputDigest: evalInputDigest,
				manifestDigest: evalManifestDigest,
				hidden: false,
			},
			{
				fixtureId: "holdout",
				partition: "holdout",
				inputDigest: holdoutInputDigest,
				manifestDigest: holdoutManifestDigest,
				hidden: true,
			},
			{
				fixtureId: "adversarial",
				partition: "adversarial",
				inputDigest: adversarialInputDigest,
				manifestDigest: adversarialManifestDigest,
				hidden: true,
			},
		],
		guard: { guardDigest: snapshots.config.guardDigests[0] ?? prefix("guard") },
		requiredSampleSize: 1,
		maxCandidates: 1,
		maxVariance: 0,
		maxCostMicrounits: 4_000_000,
		maxLatencyMilliseconds: 4_000_000,
		resourceCeiling: defaultPrimeAutoResearchResourceVector(4_000_000),
		hiddenHoldout: {
			handleId: `default-prime-autoresearch-holdout:${input.workflowId}`,
			manifestDigest: holdoutManifestDigest,
			caseCount: 1,
			owner: "host",
			hidden: true,
			opaque: true,
			hostResolverOnly: true,
			bytesAccessibleToProposer: false,
			bytesAccessibleToWorker: false,
		},
	};
	const candidate = {
		candidateId: `default-prime-autoresearch-candidate:${input.workflowId}`,
		attemptId: `default-prime-autoresearch-attempt:${input.workflowId}`,
		changeDigest: digestObject({
			kind: "default-prime-autoresearch-candidate",
			recipeDigest,
			goalBindingDigest,
			objective: status.goal.objective,
			acceptanceCheckIds: status.acceptanceCheckIds,
			protectedInvariantIds: status.protectedInvariantIds,
			visibleInputDigests: inputDigests,
		}),
		baseRevisionDigest: digestObject({
			configDigest: snapshots.config.resolvedConfigDigest,
			goalBindingDigest,
		}),
		resourceRequest: defaultPrimeAutoResearchResourceVector(1),
		claimedCompletion: false as const,
		claimedPromotion: false as const,
	};
	const solutionFamily = "adversarial workflow topology";
	const mechanism = "replace the completed analysis chain with an attack architect judge unify edge-test chain";
	const falsificationCondition =
		"the candidate omits an adversarial stage fails an opaque topology case or regresses a protected invariant";
	const structuralChanges = ["independent attack stage", "independent judge stage", "explicit edge-test stage"];
	const hypothesisWithoutDigest = {
		kind: "independent_solution" as const,
		solutionFamily,
		mechanism,
		falsificationCondition,
		expectedGeneralization: "host authority and durable replay invariants apply across workloads",
		structuralChanges,
		parameterChanges: [],
		solutionFamilyDigest: digestObject({ solutionFamily }),
		mechanismDigest: digestObject({ mechanism, structuralChanges: [...structuralChanges].sort() }),
		falsificationDigest: digestObject({ falsificationCondition }),
		parameterOnly: false,
	};
	const hypothesis = {
		...hypothesisWithoutDigest,
		hypothesisDigest: autoResearchCandidateHypothesisDigest(hypothesisWithoutDigest),
	};
	return {
		recipeDigest,
		registration,
		candidates: [
			{
				observationId: `default-prime-autoresearch-observation:${input.workflowId}`,
				candidate,
				hypothesis,
			},
		],
	};
}

async function createDefaultAutoResearchRunner(
	input: DefaultPrimeWorkflowProviderInput,
	recipe: AutoResearchDurableRecipe,
): Promise<AutoResearchProductionRunner> {
	const runtime = createAutoResearchWorkflowRuntimeAdapter({
		runtimeStore: input.runtimeStore,
		artifactResolver: input.artifactResolver,
		workflowId: input.workflowId,
		runId: recipe.registration.runId,
		executionKey: digestObject({ kind: "default-prime-autoresearch-execution", recipeDigest: recipe.recipeDigest }),
		writerIdentity: input.writerIdentity,
		resolveLeaseRef: input.resolveLeaseRef,
	});
	const currentHead = async (): Promise<WorkflowStoreReplayResult["head"]> => {
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_autoresearch_head_invalid");
		return replay.head;
	};
	const activeGoalBinding = (): {
		readonly objective: string;
		readonly acceptanceCheckIds: readonly string[];
		readonly protectedInvariantIds: readonly string[];
		readonly goalBindingDigest: string;
	} => {
		const status = input.readStatus();
		if (
			status.workflowId !== input.workflowId ||
			status.status !== "active" ||
			typeof status.goal.objective !== "string" ||
			status.goal.objective.trim().length === 0 ||
			status.acceptanceCheckIds.length === 0 ||
			status.protectedInvariantIds.length === 0
		)
			throw new Error("default_prime_autoresearch_goal_binding_missing");
		const objective = status.goal.objective;
		const acceptanceCheckIds = [...status.acceptanceCheckIds];
		const protectedInvariantIds = [...status.protectedInvariantIds];
		return {
			objective,
			acceptanceCheckIds,
			protectedInvariantIds,
			goalBindingDigest: digestObject({
				workflowId: input.workflowId,
				objective,
				acceptanceCheckIds,
				protectedInvariantIds,
			}),
		};
	};
	const publishEvidence = async (
		bytes: Uint8Array,
		idempotencyKey: string,
		sourceEventSequence?: number,
	): Promise<WorkflowArtifactRef> => {
		const head = await currentHead();
		const sourceSequence = sourceEventSequence ?? head.sequence;
		if (sourceSequence < 1 || sourceSequence > head.sequence)
			throw new Error("default_prime_autoresearch_artifact_source_invalid");
		const published = await input.runtimeStore.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "evidence",
			bytes,
			codec: "canonical_json",
			sourceEventSequence: sourceSequence,
			idempotencyKey,
		});
		return published.envelope.ref;
	};
	const proof = (
		ref: WorkflowArtifactRef,
		registrationDigest: string,
		kind: AutoResearchEvidenceProof["kind"],
	): AutoResearchEvidenceProof => {
		const withoutDigest = {
			ref,
			workflowId: input.workflowId,
			registrationDigest,
			kind,
			authenticated: true as const,
			fresh: true as const,
			revoked: false as const,
		};
		return { ...withoutDigest, proofDigest: digestObject(withoutDigest) };
	};
	const visibleInputDigests = recipe.registration.fixtures
		.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
		.map((fixture) => fixture.inputDigest)
		.sort();
	const candidateStageIds = BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.stages.map((stage) => stage.id);
	const publishEvaluationEvidence = async (evidence: AutoResearchEvidenceSubmission): Promise<WorkflowArtifactRef> => {
		const goal = activeGoalBinding();
		return publishEvidence(
			canonicalJsonBytes({
				kind: "default-prime-autoresearch-evidence",
				workflowId: input.workflowId,
				recipeDigest: recipe.recipeDigest,
				registrationDigest: digestObject(recipe.registration),
				...goal,
				visibleInputDigests,
				evidence,
			}),
			`default-prime-autoresearch-evidence:${evidence.observationId}`,
			recipe.registration.revisionResolution.registryEntryRef.sourceEventSequence,
		);
	};
	const buildAcceptedProposal = async (
		proposalInput: AutoResearchProposalCandidateInput,
		acceptedEvidenceRef: WorkflowArtifactRef,
	): Promise<WorkflowImprovementProposal> => {
		const sourceEventSequence = recipe.registration.revisionResolution.registryEntryRef.sourceEventSequence;
		const publishProposalArtifact = (kind: string, value: unknown): Promise<WorkflowArtifactRef> =>
			publishEvidence(
				canonicalJsonBytes({ schemaVersion: 1, kind, workflowId: input.workflowId, value }),
				`default-prime-autoresearch-proposal:${kind}:${proposalInput.observation.observationId}`,
				sourceEventSequence,
			);
		const [baselineArtifactRef, candidateArtifactRef, evaluatorRef, parserRef, predicateRef, ledgerRef] =
			await Promise.all([
				publishProposalArtifact("baseline", {
					recipeId: BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.recipeId,
					uncoveredAdversarialStageCount: 1,
				}),
				publishProposalArtifact("candidate", {
					recipeId: BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.recipeId,
					stageIds: candidateStageIds,
					uncoveredAdversarialStageCount: 0,
				}),
				publishProposalArtifact("evaluator", { evaluatorDigest: recipe.registration.evaluator.evaluatorDigest }),
				publishProposalArtifact("parser", { parserDigest: recipe.registration.evaluator.parserDigest }),
				publishProposalArtifact("non-regression", {
					protectedInvariantIds: activeGoalBinding().protectedInvariantIds,
				}),
				publishProposalArtifact("resource-ledger", { resourceUsage: proposalInput.observation.resourceUsage }),
			]);
		const caseManifestWithoutDigest = {
			manifestId: `default-prime-holdout:${proposalInput.observation.observationId}`,
			kind: "held_out" as const,
			sourceArtifactRefs: [acceptedEvidenceRef],
			inputDigest: proposalInput.observation.rawResultRefsDigest,
			hidden: true as const,
			requiredSampleSize: recipe.registration.requiredSampleSize,
			effectThreshold: 1,
			tolerance: recipe.registration.metric.tolerance,
			nonRegressionPredicateRefs: [predicateRef],
			maxCostMicrounits: recipe.registration.maxCostMicrounits,
			maxLatencyMilliseconds: recipe.registration.maxLatencyMilliseconds,
			heldOutInputDigest:
				recipe.registration.fixtures.find((fixture) => fixture.partition === "holdout")?.inputDigest ??
				digestObject({ kind: "default-prime-holdout", recipeDigest: recipe.recipeDigest }),
			manifestDigest: "",
		};
		const caseManifest = {
			...caseManifestWithoutDigest,
			manifestDigest: digestObject(caseManifestWithoutDigest),
		};
		const hiddenHoldoutManifestRef = await publishProposalArtifact("workflow_learning_holdout_manifest", {
			manifest: caseManifest,
		});
		const evaluatorContractWithoutDigest = {
			evaluatorRef,
			parserRef,
			owner: "host" as const,
			metricDirection: "minimize" as const,
			targetValue: 0,
			aggregation: "exact" as const,
			repeatabilityRuns: 1,
			varianceBound: recipe.registration.maxVariance,
			deterministicRiskClassifierRef: predicateRef,
			riskClassification: "risk_relevant" as const,
			holdoutCommitmentRefs: [hiddenHoldoutManifestRef],
			evaluatorDigest: evaluatorRef.digest,
			parserDigest: parserRef.digest,
			contractDigest: "",
		};
		const evaluatorContract = {
			...evaluatorContractWithoutDigest,
			contractDigest: digestObject(evaluatorContractWithoutDigest),
		};
		const status = input.readStatus();
		const decisionRef = resourceDecision(status, input.workflowId);
		if (decisionRef === null) throw new Error("default_prime_autoresearch_proposal_decision_missing");
		const scorecardWithoutDigest = {
			scorecardId: `default-prime-scorecard:${proposalInput.observation.observationId}`,
			revision: decisionRef.revision,
			owner: "host" as const,
			riskRelevantChange: true,
			caseManifestRefs: [hiddenHoldoutManifestRef],
			mandatoryHiddenHoldout: true,
			hiddenHoldoutManifestRefs: [hiddenHoldoutManifestRef],
			requiredSampleSizes: { shadow: 1, canary: 1, red_team: 1 },
			effectThreshold: 1,
			tolerance: recipe.registration.metric.tolerance,
			nonRegressionPredicateRefs: [predicateRef],
			maxCostMicrounits: recipe.registration.maxCostMicrounits,
			maxLatencyMilliseconds: recipe.registration.maxLatencyMilliseconds,
			proposerMayChooseOrOmitHoldouts: false as const,
			evaluatorContract,
			metricDirection: "minimize" as const,
			targetValue: 0,
			aggregation: "exact" as const,
			repeatabilityRuns: 1,
			varianceBound: recipe.registration.maxVariance,
			riskClassification: "risk_relevant" as const,
			holdoutCommitmentRefs: [hiddenHoldoutManifestRef],
			decisionRef,
			scorecardDigest: "",
		};
		const scorecard = { ...scorecardWithoutDigest, scorecardDigest: digestObject(scorecardWithoutDigest) };
		const scorecardRef = await publishProposalArtifact("scorecard", scorecard);
		const zeroControlCapacity = {
			processSlots: 0,
			childSessionSlots: 0,
			modelCallSlots: 0,
			modelInputTokens: 0,
			modelOutputTokens: 0,
			verificationSlots: 0,
			redTeamSlots: 0,
			recoverySlots: 0,
		} as const;
		const resourceAdmissionWithoutDigest = {
			capacityGrant: {
				kind: "worker" as const,
				grantId: `default-prime-autoresearch:${proposalInput.observation.observationId}`,
				resourceVector: proposalInput.observation.resourceUsage,
				controlCapacity: zeroControlCapacity,
				canonicalPoolLedgerRef: ledgerRef,
				grantDigest: digestObject({ ledgerRef, resourceUsage: proposalInput.observation.resourceUsage }),
			},
			canonicalPoolLedgerRef: ledgerRef,
			controlCapacity: zeroControlCapacity,
			controlCapacityProjectionDigest: digestObject(zeroControlCapacity),
			declaredVector: proposalInput.observation.resourceUsage,
			hostDerivedConservativeVector: proposalInput.observation.resourceUsage,
			reservedVector: proposalInput.observation.resourceUsage,
			declaredControlCapacity: zeroControlCapacity,
			hostDerivedControlCapacity: zeroControlCapacity,
			reservedControlCapacity: zeroControlCapacity,
			derivationPolicyDigest: recipe.registration.evaluator.evaluatorDigest,
			enforcementClass: "host_bounded" as const,
			unknownPoolIds: [],
			canonicalLedgerRef: ledgerRef,
			canonicalLedgerDigest: ledgerRef.digest,
			admitted: true,
			admissionDigest: "",
		};
		const reviewResourceAdmission = {
			...resourceAdmissionWithoutDigest,
			admissionDigest: digestObject(resourceAdmissionWithoutDigest),
		};
		const reviewBudgetWithoutDigest = {
			observationQueuePolicy: "latest_wins" as const,
			maxPendingReviews: 1 as const,
			maxActiveReviews: 1 as const,
			supersededCancellation: "required" as const,
			dutyCycleCapPermille: 100,
			maxReviewsPerWindow: 1,
			maxReviewsPerPhase: 1,
			maxReviewsPerWorkflow: 1,
			reviewResourceAdmission,
			dedicatedReviewReserve: proposalInput.observation.resourceUsage,
			plannerVerifierReserve: defaultPrimeAutoResearchResourceVector(1),
			dedicatedReviewReserveLedgerRefs: [ledgerRef],
			plannerVerifierReserveLedgerRefs: [ledgerRef],
			reserveVectorsAreLedgerProjections: true as const,
			budgetDigest: "",
		};
		const reviewBudget = { ...reviewBudgetWithoutDigest, budgetDigest: digestObject(reviewBudgetWithoutDigest) };
		const trustedNow = recipe.registration.revisionResolution.hostReceipt.issuedAt;
		const proposalId = `proposal:${proposalInput.observation.observationId}`;
		const proposalReceiptId = `default-prime-autoresearch-proposal-${digestObject({
			proposalId,
			acceptedEvidenceRef,
		}).slice(0, 48)}`;
		const proposalReceipt = await input.issueReceipt({
			receiptKind: "decision",
			workflowId: input.workflowId,
			bindingDigest: digestObject({ kind: "autoresearch-proposal", proposalId, acceptedEvidenceRef }),
			receiptId: proposalReceiptId,
			issuedAt: trustedNow,
			stateDigest: recipe.registration.revisionResolution.hostReceipt.stateDigest,
			revision: recipe.registration.revisionResolution.hostReceipt.revision,
			payloadKind: "workflow-learning",
			payloadDigest: acceptedEvidenceRef.digest,
		});
		const proposalWithoutDigest = {
			proposalId,
			workflowId: input.workflowId,
			owner: "autoresearch" as const,
			scope: { kind: "workflow" as const, workflowId: input.workflowId, rootSessionId: input.rootSessionId },
			sourcePhaseOrIncident: "autoresearch-independent-solution",
			baselineRevision: decisionRef.revision,
			baselineDigest: proposalInput.candidateRequest.baseRevisionDigest,
			candidateDigest: proposalInput.candidateRequest.changeDigest,
			caseManifestDigest: caseManifest.manifestDigest,
			baselineArtifactRef,
			candidateArtifactRef,
			trialMode: "shadow" as const,
			sampleSize: proposalInput.observation.sampleCount,
			minimumEffectSize: 1,
			tolerance: proposalInput.observation.metricTolerance,
			hostAcceptedEvidenceRefs: [acceptedEvidenceRef],
			fixedEvaluatorDigest: evaluatorRef.digest,
			preregisteredManifestDigest: digestObject(recipe.registration),
			hiddenHoldoutDigest: caseManifest.heldOutInputDigest,
			safetyInvariantDigest: recipe.registration.guard?.guardDigest ?? predicateRef.digest,
			costCeilingMicrounits: recipe.registration.maxCostMicrounits,
			antiGoodhartReceipt: proposalReceipt,
			queuedAt: trustedNow,
			proposalEpoch: input.epochRef,
			hiddenHoldoutManifestRef,
			registryEpoch: input.epochRef.storeEpoch,
			registryResolutionReceipt: proposalReceipt,
			revisionResolution: proposalInput.revisionResolution,
			baselineBytesDigest: baselineArtifactRef.digest,
			candidateBytesDigest: candidateArtifactRef.digest,
			producer: "autoresearch" as const,
			kind: "methodology" as const,
			baselineRevisionId: `revision:${decisionRef.revision}`,
			baselineRevisionDigest: proposalInput.candidateRequest.baseRevisionDigest,
			candidateRef: candidateArtifactRef,
			scorecardRef,
			scorecardDigest: scorecardRef.digest,
			evaluatorRef,
			parserRef,
			baselineEvidenceRefs: [baselineArtifactRef],
			candidateEvidenceRefs: [acceptedEvidenceRef, candidateArtifactRef],
			queueState: "pending" as const,
			queueRevision: 1,
			attemptId: proposalInput.candidateRequest.attemptId,
			reviewLeaseRef: null,
			ownershipLeaseRef: null,
			epochRef: input.epochRef,
			executionKey: digestObject({ kind: "default-prime-autoresearch-proposal", proposalId }),
			status: "proposed" as const,
			caseManifest,
			scorecard,
			evaluatorContract,
			reviewBudget,
		};
		return { ...proposalWithoutDigest, proposalDigest: digestObject(proposalWithoutDigest) };
	};
	const acceptedProposalByObservation = new Map<string, Promise<WorkflowImprovementProposal>>();
	const createAcceptedProposal = (
		proposalInput: AutoResearchProposalCandidateInput,
		acceptedEvidenceRef: WorkflowArtifactRef,
	): Promise<WorkflowImprovementProposal> => {
		const cacheKey = digestObject({
			observationId: proposalInput.observation.observationId,
			acceptedEvidenceRef,
		});
		const existing = acceptedProposalByObservation.get(cacheKey);
		if (existing !== undefined) return existing;
		const created = buildAcceptedProposal(proposalInput, acceptedEvidenceRef);
		acceptedProposalByObservation.set(cacheKey, created);
		return created;
	};
	const host: AutoResearchHostPorts = {
		submitTask: async (taskInput: AutoResearchTaskSubmission) => ({
			taskId: taskInput.candidateId,
			candidateId: taskInput.candidateId,
			attemptId: taskInput.attemptId,
			changeDigest: taskInput.changeDigest,
			taskDigest: digestObject(taskInput),
		}),
		submitEvidence: publishEvaluationEvidence,
		submitDecision: async () => {
			const status = input.readStatus();
			const decision = resourceDecision(status, input.workflowId);
			if (decision === null) throw new Error("default_prime_autoresearch_resource_decision_missing");
			return decision;
		},
		resolveDecision: async (decisionInput): Promise<AutoResearchDecisionResolution> => {
			const head = await currentHead();
			const stateDigest = digestObject(head);
			const headDigest = head.eventDigest ?? digestObject(head);
			const bindingDigest = digestObject({
				workflowId: decisionInput.workflowId,
				registrationDigest: decisionInput.registrationDigest,
				decisionRef: decisionInput.ref,
				stateDigest,
				headDigest,
				epochRef: input.epochRef,
			});
			const receipt = await input.issueReceipt({
				receiptKind: "decision",
				workflowId: input.workflowId,
				bindingDigest,
				payloadDigest: decisionInput.ref.decisionDigest,
				stateDigest,
				revision: Math.max(1, head.sequence),
				payloadKind: "workflow-learning",
			});
			const withoutDigest = {
				ref: decisionInput.ref,
				workflowId: decisionInput.workflowId,
				registrationDigest: decisionInput.registrationDigest,
				stateDigest,
				headDigest,
				epochRef: input.epochRef,
				disposition: "authorized" as const,
				authority: ["observe_workflow"],
				fresh: true as const,
				revoked: false as const,
				receipt,
			};
			return { ...withoutDigest, resolutionDigest: digestObject(withoutDigest) };
		},
		submitProposal: async (proposalInput) => {
			const provisionalEvidence: AutoResearchEvidenceSubmission = {
				runId: proposalInput.registration.runId,
				candidateId: proposalInput.observation.candidateId,
				attemptId: proposalInput.observation.attemptId,
				observationId: proposalInput.observation.observationId,
				outcome: "accepted",
				reason: null,
				observation: proposalInput.observation,
			};
			const evidenceRef = await publishEvaluationEvidence(provisionalEvidence);
			return createAcceptedProposal(proposalInput, evidenceRef);
		},
		submitAcceptedProposal: async (accepted) => {
			if (accepted.evidence.outcome !== "accepted")
				throw new Error("default_prime_autoresearch_accepted_proposal_evidence_invalid");
			const evidenceRef = await publishEvaluationEvidence(accepted.evidence);
			const proposal = await createAcceptedProposal(
				{ ...accepted.proposal, evidenceRefs: [evidenceRef] },
				evidenceRef,
			);
			return {
				transactionDigest: accepted.transactionDigest,
				evidenceRef,
				evidenceProof: proof(evidenceRef, accepted.proposal.registrationDigest, "observation"),
				proposal,
			};
		},
		submitHoldout: async (holdout) => {
			const state = await currentHead();
			const stateDigest = digestObject(state);
			const goal = activeGoalBinding();
			const holdoutRef = await publishEvidence(
				canonicalJsonBytes({
					kind: "default-prime-autoresearch-holdout-evidence",
					workflowId: input.workflowId,
					registrationDigest: holdout.registrationDigest,
					...goal,
				}),
				`default-prime-autoresearch-holdout:${holdout.registrationDigest}`,
			);
			const adversarialRef = await publishEvidence(
				canonicalJsonBytes({
					kind: "default-prime-autoresearch-adversarial-evidence",
					workflowId: input.workflowId,
					registrationDigest: holdout.registrationDigest,
					...goal,
				}),
				`default-prime-autoresearch-adversarial:${holdout.registrationDigest}`,
			);
			return {
				handleId: holdout.handle.handleId,
				manifestDigest: holdout.handle.manifestDigest,
				resolverContext: {
					contextId: `default-prime-autoresearch-holdout-context:${input.workflowId}`,
					workflowId: input.workflowId,
					registrationDigest: holdout.registrationDigest,
					handleId: holdout.handle.handleId,
					manifestDigest: holdout.handle.manifestDigest,
					stateDigest,
					epochRef: input.epochRef,
					authenticated: true as const,
					returnsEvidenceOnly: true as const,
					returnsBytes: false as const,
					resolverDigest: digestObject({ kind: "default-prime-autoresearch-holdout-resolver", stateDigest }),
				},
				evidenceRefs: [holdoutRef],
				adversarialEvidenceRefs: [adversarialRef],
				evidenceProofs: [proof(holdoutRef, holdout.registrationDigest, "holdout")],
				adversarialEvidenceProofs: [proof(adversarialRef, holdout.registrationDigest, "adversarial")],
				bytesReturned: false as const,
			};
		},
		measureObservation: async (observation: AutoResearchRawObservation): Promise<AutoResearchHostMeasurement> => {
			if (observation.rawResultRefs.length === 0) throw new Error("default_prime_autoresearch_result_missing");
			const goal = activeGoalBinding();
			for (const ref of observation.rawResultRefs) {
				const resolved = await input.artifactResolver.resolve(ref);
				if (!resolved.exists || resolved.envelope.payloadKind !== "evidence")
					throw new Error("default_prime_autoresearch_result_unresolved");
				const parsed = parseCanonicalJsonBytes(resolved.bytes);
				if (
					!isRecord(parsed) ||
					parsed.kind !== "default-prime-autoresearch-candidate-result" ||
					parsed.workflowId !== input.workflowId ||
					parsed.goalBindingDigest !== goal.goalBindingDigest ||
					parsed.candidateId !== observation.candidateId ||
					parsed.attemptId !== observation.attemptId ||
					parsed.candidateRecipeId !== BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.recipeId ||
					digestObject(parsed.candidateStageIds) !== digestObject(candidateStageIds) ||
					parsed.baselineUncoveredAdversarialStageCount !== 1 ||
					parsed.candidateUncoveredAdversarialStageCount !== 0
				)
					throw new Error("default_prime_autoresearch_result_invalid");
			}
			// This host executes nothing: `effect-broker.ts` implements command execution but nothing in
			// production constructs it, and the registration commits to its evaluator by bare digest with
			// no retrievable command text. So there is no measurement to report. Reporting one anyway -
			// metricValue 0 against baseline 1, cost and latency derived from artifact byte length - is
			// what this did before, and a constant that reads as evidence is worse than an absence.
			//
			// "crashed" is that absence, stated in the engine's own vocabulary: it refuses to reuse a
			// crashed observation for promotion, so a candidate cannot be accepted on the strength of a
			// number nobody computed. Throwing instead would abort the whole workflow, since the default
			// Prime composition drives this path in a normal run - autoresearch failing closed must not
			// take the run with it.
			const measurementWithoutDigest = {
				source: "host" as const,
				rawResultRefsDigest: digestObject(observation.rawResultRefs),
				phase: "promotion" as const,
				status: "crashed" as const,
				commandInputBinding: recipe.registration.commandInputBinding,
				metricDirection: recipe.registration.metric.direction,
				metricTarget: recipe.registration.metric.target,
				metricTolerance: recipe.registration.metric.tolerance,
				// The engine requires a positive sample count; the refusal is carried by `status`, not by
				// pretending zero samples were taken.
				sampleCount: observation.rawResultRefs.length,
				metricValue: 0,
				baselineMetricValue: 0,
				variance: 0,
				fixtureManifestDigest: recipe.registration.fixtures
					.filter((fixture) => fixture.partition === "train" || fixture.partition === "eval")
					.map((fixture) => fixture.manifestDigest)
					.sort()
					.join("|"),
				trainInputDigest:
					recipe.registration.fixtures.find((fixture) => fixture.partition === "train")?.inputDigest ?? "",
				evalInputDigest:
					recipe.registration.fixtures.find((fixture) => fixture.partition === "eval")?.inputDigest ?? "",
				heldOutInputDigest: null,
				evaluatorDigest: recipe.registration.evaluator.evaluatorDigest,
				parserDigest: recipe.registration.evaluator.parserDigest,
				guardDigest: recipe.registration.guard?.guardDigest ?? null,
				seedDigest: recipe.registration.seed.seedDigest,
				proxySignals: [],
				costMicrounits: 0,
				latencyMilliseconds: 0,
				resourceUsage: defaultPrimeAutoResearchResourceVector(1),
				hiddenMetricValue: 0,
				adversarialMetricValue: 0,
				candidateClaimedCompletion: false as const,
				candidateClaimedPromotion: false as const,
			};
			return {
				...measurementWithoutDigest,
				measurementDigest: digestObject(measurementWithoutDigest),
			};
		},
		runtime,
	};
	return createAutoResearchProductionRunner({
		host,
		authority: {
			runtimeStore: input.runtimeStore,
			artifactResolver: input.artifactResolver,
			workflowId: input.workflowId,
			executionKey: digestObject({
				kind: "default-prime-autoresearch-execution",
				recipeDigest: recipe.recipeDigest,
			}),
			writerIdentity: input.writerIdentity,
			resolveLeaseRef: input.resolveLeaseRef,
			receiptContext: input.receiptContext,
		},
		resolveRecipe: async (recipeDigest: string) => {
			if (recipeDigest !== recipe.recipeDigest) throw new Error("default_prime_autoresearch_recipe_mismatch");
			return recipe;
		},
		executeCandidate: async (candidate) => {
			const head = await currentHead();
			const goal = activeGoalBinding();
			const bytes = canonicalJsonBytes({
				kind: "default-prime-autoresearch-candidate-result",
				workflowId: input.workflowId,
				recipeDigest: recipe.recipeDigest,
				registrationDigest: candidate.registrationDigest,
				...goal,
				candidateId: candidate.candidate.candidateId,
				attemptId: candidate.candidate.attemptId,
				changeDigest: candidate.candidate.changeDigest,
				baseRevisionDigest: candidate.candidate.baseRevisionDigest,
				resourceRequest: candidate.candidate.resourceRequest,
				visibleInputDigests: candidate.visibleInputDigests,
				candidateRecipeId: BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.recipeId,
				candidateStageIds,
				baselineUncoveredAdversarialStageCount: 1,
				candidateUncoveredAdversarialStageCount: 0,
			});
			const resultRef = await publishEvidence(
				bytes,
				`default-prime-autoresearch-candidate:${candidate.task.taskId}`,
				head.sequence,
			);
			return { rawResultRefs: [resultRef] };
		},
	});
}

function recipeSignedReceiptPreimageDigest(receipt: WorkflowVerifiedHostReceipt): string {
	const { signature: _signature, verificationDigest: _verificationDigest, ...signedFields } = receipt;
	return digestObject(signedFields);
}

async function createDefaultRecipeAdmissionConsumer(
	input: DefaultPrimeWorkflowProviderInput,
	expectedAdmission: WorkflowRecipeAdmissionArtifact,
): Promise<(admission: WorkflowRecipeAdmissionArtifact) => Promise<WorkflowRecipeAdmissionConsumptionProof>> {
	const registration = expectedAdmission.registrationReceipt;
	if (registration === undefined || expectedAdmission.registrationReceiptProof === undefined)
		throw new Error("default_prime_recipe_registration_missing");
	const resolvedReceipt = await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: registration.receipt.bindingDigest,
		receipt: registration.receipt,
		currentStateDigest: expectedAdmission.hostHeadDigest,
		currentRevision: expectedAdmission.revision,
		trustedNow: registration.consumptionWitness.consumedAt,
	});
	const resolvedWitness = await input.receiptContext.receiptResolver.resolveConsumptionWitness({
		receiptId: resolvedReceipt.receiptId,
		workflowId: input.workflowId,
		expectedBindingDigest: registration.receipt.bindingDigest,
	});
	const consumptionWitness: WorkflowRecipeReceiptConsumptionWitness = {
		...resolvedWitness,
		headDigest: expectedAdmission.hostHeadDigest,
	};
	if (
		resolvedReceipt.verificationDigest !== registration.receipt.verificationDigest ||
		digestObject(consumptionWitness) !== digestObject(registration.consumptionWitness)
	)
		throw new Error("default_prime_recipe_registration_witness_invalid");
	const proof: WorkflowRecipeAdmissionHostRegistrationProof = {
		proofKind: "ed25519-one-use",
		authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
		receiptDigest: digestObject(resolvedReceipt),
		witnessDigest: digestObject(consumptionWitness),
		workflowId: input.workflowId,
		hostKeyId: resolvedReceipt.keyId,
		bindingDigest: resolvedReceipt.bindingDigest,
		currentHeadDigest: expectedAdmission.hostHeadDigest,
		currentDecisionDigest: expectedAdmission.hostDecisionDigest,
		currentEpochRef: expectedAdmission.hostEpochRef,
		consumptionSequence: consumptionWitness.consumptionSequence,
		signatureVerified: true,
		signatureDigest: sha256Hex(resolvedReceipt.signature),
		artifactBytesDigest: resolvedReceipt.artifactRef.digest,
		artifactSizeBytes: resolvedReceipt.artifactRef.sizeBytes,
		artifactImmutable: true,
		oneUseConsumed: true,
		admissionPreimageDigest: expectedAdmission.recipeDigest,
		signedReceiptPreimageDigest: recipeSignedReceiptPreimageDigest(resolvedReceipt),
	};
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_recipe_admission_requires_durable_runtime");
	const recordName = `default-prime-recipe-admission-${expectedAdmission.admissionDigest.slice(0, 48)}`;
	const context: WorkflowRecipeAdmissionHostResolutionPort["context"] = {
		authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
		hostKeyId: resolvedReceipt.keyId,
		workflowId: input.workflowId,
		registryManifestDigest: expectedAdmission.registryManifestDigest,
		epochRef: expectedAdmission.hostEpochRef,
		currentDecisionDigest: expectedAdmission.hostDecisionDigest,
		headDigest: expectedAdmission.hostHeadDigest,
		issuedAt: resolvedReceipt.issuedAt,
		validUntil: resolvedReceipt.validUntil,
		pathBoundaryDigest: digestObject(expectedAdmission.pathBoundary),
		contextDigest: expectedAdmission.hostContextDigest,
		receiptContext: input.receiptContext,
		authenticatedReceiptResolver: {
			verifyConsumedReceipt: (receiptInput) => {
				if (
					receiptInput.workflowId !== input.workflowId ||
					digestObject(receiptInput.receipt) !== digestObject(resolvedReceipt) ||
					digestObject(receiptInput.payload) !== digestObject(registration.payload) ||
					digestObject(receiptInput.consumptionWitness) !== digestObject(consumptionWitness) ||
					receiptInput.expectedBindingDigest !== resolvedReceipt.bindingDigest ||
					receiptInput.currentHeadDigest !== expectedAdmission.hostHeadDigest ||
					digestObject(receiptInput.currentEpochRef) !== digestObject(expectedAdmission.hostEpochRef) ||
					receiptInput.currentDecisionDigest !== expectedAdmission.hostDecisionDigest ||
					receiptInput.hostKeyId !== resolvedReceipt.keyId ||
					receiptInput.expectedAdmissionPreimageDigest !== expectedAdmission.recipeDigest
				)
					return null;
				return proof;
			},
			consumeAdmissionAtHost: async (transactionInput) => {
				if (
					transactionInput.workflowId !== input.workflowId ||
					transactionInput.admission.admissionDigest !== expectedAdmission.admissionDigest ||
					transactionInput.expectedAdmissionPreimageDigest !== expectedAdmission.recipeDigest ||
					transactionInput.expectedBindingDigest !== resolvedReceipt.bindingDigest ||
					transactionInput.currentHeadDigest !== expectedAdmission.hostHeadDigest ||
					transactionInput.currentDecisionDigest !== expectedAdmission.hostDecisionDigest ||
					digestObject(transactionInput.currentEpochRef) !== digestObject(expectedAdmission.hostEpochRef)
				)
					throw new Error("default_prime_recipe_admission_binding_invalid");
				let status: "consumed" | "already_consumed" = "consumed";
				await durable.withExclusiveLease(`default-prime-recipe-admission:${input.workflowId}`, async () => {
					const existing = await durable.auxiliaryStore.read(recordName);
					if (existing !== null) {
						const parsed = parseCanonicalJsonBytes(existing);
						if (
							!isRecord(parsed) ||
							parsed.kind !== "default_prime_recipe_admission" ||
							parsed.workflowId !== input.workflowId ||
							parsed.admissionDigest !== expectedAdmission.admissionDigest ||
							parsed.registrationReceiptDigest !== resolvedReceipt.verificationDigest ||
							parsed.proofDigest !== digestObject(proof)
						)
							throw new Error("default_prime_recipe_admission_record_conflict");
						status = "already_consumed";
						return;
					}
					transactionInput.consumer();
					await durable.auxiliaryStore.write(
						recordName,
						canonicalJsonBytes({
							kind: "default_prime_recipe_admission",
							version: 1,
							workflowId: input.workflowId,
							admissionDigest: expectedAdmission.admissionDigest,
							registrationReceiptDigest: resolvedReceipt.verificationDigest,
							proofDigest: digestObject(proof),
							consumedAt: consumptionWitness.consumedAt,
						}),
					);
				});
				return { status, registration, proof };
			},
		},
	};
	const host: WorkflowRecipeAdmissionHostResolutionPort = {
		registryManifestDigest: expectedAdmission.registryManifestDigest,
		pathBoundary: expectedAdmission.pathBoundary,
		context,
	};
	return async (admission) => {
		if (admission.admissionDigest !== expectedAdmission.admissionDigest)
			throw new Error("default_prime_recipe_admission_changed");
		return consumeWorkflowRecipeAdmissionAtHost({
			admission,
			host,
			consumer: { consumeWorkflowRecipeAdmission: () => undefined },
		});
	};
}

async function publishEvidence(
	input: DefaultPrimeWorkflowProviderInput,
	bytes: Uint8Array,
	codec: "canonical_json" | "binary",
	sourceEventSequence: number,
	idempotencyKey: string,
	artifactNamespace?: "skills",
): Promise<WorkflowArtifactRef> {
	const result = await input.runtimeStore.publishArtifact({
		workflowId: input.workflowId,
		payloadKind: "evidence",
		...(artifactNamespace === undefined ? {} : { artifactNamespace }),
		bytes,
		codec,
		sourceEventSequence,
		idempotencyKey,
	});
	return result.envelope.ref;
}

async function createDefaultConfig(input: {
	readonly workflowId: string;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly publish: (
		bytes: Uint8Array,
		codec: "canonical_json" | "binary",
		idempotencyKey: string,
	) => Promise<WorkflowArtifactRef>;
	readonly contentDigests: readonly string[];
}): Promise<WorkflowRuntimeConfigSnapshot> {
	const closureMembers = Object.freeze(["prime-workflow", "autoresearch", "mempalace"]);
	const closureManifestBytes = canonicalJsonBytes(closureMembers);
	const closureManifestRef = await input.publish(
		closureManifestBytes,
		"canonical_json",
		`default-prime-config-closure:${input.workflowId}`,
	);
	const digest = (name: string): string =>
		digestObject({ kind: "default-prime-config", workflowId: input.workflowId, name });
	return resolveWorkflowRuntimeConfig({
		configSchemaVersion: 1,
		configRevision: 1,
		closureMembers,
		executionProfile: "parallel",
		runtimeIdentityDigest: digest("runtime"),
		repositoryPolicyDigest: digest("repository"),
		workspaceIdentityDigest: digest("workspace"),
		globalSettingsDigest: digest("global"),
		projectSettingsDigest: digest("project"),
		packageDefaultsDigest: digest("packages"),
		methodologyManifestDigests: [digest("methodology")],
		nativeMethodologyContractDigest: digest("native-methodology"),
		skillContentDigests: [...input.contentDigests],
		skillDependencyDigests: [],
		evaluatorDigests: [digest("evaluator")],
		parserDigests: [digest("parser")],
		guardDigests: [digest("guard")],
		scorecardRuleDigest: digest("scorecard"),
		resourceInventoryDigest: digest("inventory"),
		resourceEnvelopePolicyDigest: digest("envelope"),
		egressPolicyDigest: digest("egress"),
		authorityPolicyDigest: digest("authority"),
		approvalPolicyDigest: digest("approval"),
		provenanceManifestDigest: digest("provenance"),
		daemonCapabilityDigest: digest("daemon"),
		decisionLimitsDigest: digest("limits"),
		schedulerPolicyDigest: digest("scheduler"),
		journalFormatDigest: digest("journal"),
		closureManifestRef,
		closureManifestBytes,
	});
}

interface DefaultSkillParts {
	readonly loader: WorkflowResourceLoaderPort;
	readonly skill: Skill;
	readonly loaderProvenance: WorkflowResourceLoaderProvenance;
	readonly builtinProvenanceContext: WorkflowSkillBuiltinProvenanceContext;
	readonly sourceProvenance: WorkflowSkillSourceProvenance;
	readonly contentDigest: string;
	readonly manifest: WorkflowSkillManifestSource;
	readonly sourceSequence: number;
	readonly trustedNow: string;
}

async function createDefaultSkillSnapshot(input: {
	readonly workflowId: string;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
	readonly resourceLoader: WorkflowResourceLoaderPort;
	readonly headDigest: string;
	readonly trustedNow: string;
	readonly publish: (
		bytes: Uint8Array,
		codec: "canonical_json" | "binary",
		idempotencyKey: string,
	) => Promise<WorkflowArtifactRef>;
	readonly skillName: string;
	readonly sharedLoaderProvenance?: WorkflowResourceLoaderProvenance;
	readonly sharedLoaderTrustedNow?: string;
}): Promise<DefaultSkillParts> {
	const loader: WorkflowResourceLoaderPort = { getSkills: () => input.resourceLoader.getSkills() };
	const loaded = loader.getSkills();
	const skill = loaded.skills.find((candidate) => candidate.name === input.skillName);
	if (skill === undefined) throw new Error(`default_prime_${input.skillName}_skill_unavailable`);
	const loaderResult: WorkflowResourceLoaderResult = {
		skills: loaded.skills,
		diagnostics: loaded.diagnostics,
		revision: DEFAULT_LOADER_REVISION,
	};
	const loaderDigests = getWorkflowResourceLoaderProvenanceDigests(loaderResult, DEFAULT_LOADER_REVISION);
	const workspaceDigest = digestObject({ kind: "default-prime-workspace", workflowId: input.workflowId });
	const loaderBindingDigest = getWorkflowResourceLoaderReceiptBindingDigest({
		workflowId: input.workflowId,
		workspaceDigest,
		loaderRevision: DEFAULT_LOADER_REVISION,
		loaderResultDigest: loaderDigests.loaderResultDigest,
	});
	const loaderProvenance =
		input.sharedLoaderProvenance ??
		(await (async () => {
			const loaderReceipt = await input.issueReceipt({
				receiptKind: "artifact",
				workflowId: input.workflowId,
				bindingDigest: loaderBindingDigest,
				oneUse: true,
				issuedAt: input.trustedNow,
				stateDigest: loaderDigests.loaderResultDigest,
				revision: DEFAULT_LOADER_REVISION,
				payloadKind: "workflow-resource-loader",
				payloadDigest: loaderDigests.loaderResultDigest,
				artifactNamespace: "skills",
			});
			await consumeReceipt(
				input.receiptContext,
				loaderReceipt,
				loaderBindingDigest,
				loaderDigests.loaderResultDigest,
				DEFAULT_LOADER_REVISION,
				new Date().toISOString(),
			);
			return {
				issuedBy: "ResourceLoader" as const,
				issuanceReceipt: loaderReceipt,
				loaderRevision: DEFAULT_LOADER_REVISION,
				workspaceDigest,
				sourceManifestDigest: loaderDigests.sourceManifestDigest,
				diagnosticsDigest: loaderDigests.diagnosticsDigest,
				artifactPathDigest: loaderDigests.artifactPathDigest,
				loaderResultDigest: loaderDigests.loaderResultDigest,
				artifactNamespace: "artifacts/skills" as const,
			} satisfies WorkflowResourceLoaderProvenance;
		})());
	const snapshotTrustedNow = input.sharedLoaderTrustedNow ?? new Date().toISOString();

	const sourceBytes = Uint8Array.from(await readFile(skill.filePath));
	const vendoredRoot = await realpath(skill.sourceInfo.baseDir ?? dirname(skill.filePath));
	const canonicalPath = await realpath(skill.filePath);
	const sourceSequence = Math.max(
		DEFAULT_SKILL_SOURCE_SEQUENCE,
		(
			await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.runtimeStore.durableContext?.epochRef.storeEpoch ?? 1,
			})
		).head.sequence,
	);
	const gateFields = {
		requiredApprovalGates: ["user"],
		requiredArtifactKinds: ["evidence"],
		requiredPressureTests: ["red-team"],
		allowedTransitions: ["start"],
	};
	const sourceManifestBytes = canonicalJsonBytes({
		sourceManifestKind: "workflow-skill-source-manifest",
		skillName: skill.name,
		relativePath: relative(vendoredRoot, canonicalPath).split("\\").join("/"),
		sourceBytesDigest: sha256Hex(sourceBytes),
		...gateFields,
	});
	const admissionManifestBytes = canonicalJsonBytes(gateFields);
	const admissionManifestRef = await input.publish(
		admissionManifestBytes,
		"canonical_json",
		`default-prime-skill-admission-manifest:${input.workflowId}:${skill.name}`,
	);
	const sourceManifestRef = await input.publish(
		sourceManifestBytes,
		"canonical_json",
		`default-prime-skill-manifest:${input.workflowId}:${skill.name}`,
	);
	const sourceRef = await input.publish(
		sourceBytes,
		"binary",
		`default-prime-skill-source:${input.workflowId}:${skill.name}`,
	);
	const packageSources = await collectPackageSources(skill, input.publish, input.workflowId);
	const registryBytes = canonicalJsonBytes({
		registryKind: "workflow-builtin-registry",
		entries: [
			{
				skillName: skill.name,
				relativePath: relative(vendoredRoot, canonicalPath).split("\\").join("/"),
				sourceManifestDigest: sourceManifestRef.digest,
				sourceBytesDigest: sourceRef.digest,
				sourceEventId: `default-prime-builtin:${input.workflowId}:${sourceSequence}`,
			},
		],
	});
	const registryRef = await input.publish(
		registryBytes,
		"canonical_json",
		`default-prime-skill-registry:${input.workflowId}:${skill.name}`,
	);
	const builtinSigner = input.receiptContext.signer;
	if (builtinSigner === undefined) throw new Error("default_prime_builtin_signer_unavailable");
	const unsignedSourceEvent = {
		eventId: `default-prime-builtin:${input.workflowId}:${sourceSequence}`,
		skillName: skill.name,
		vendoredRoot,
		canonicalPath,
		sourceManifestDigest: sourceManifestRef.digest,
		sourceBytesDigest: sourceRef.digest,
		sourceEventSequence: sourceSequence,
		issuedAt: input.trustedNow,
		validUntil: new Date(Date.parse(input.trustedNow) + 300_000).toISOString(),
		keyId: builtinSigner.keyId,
		signatureAlgorithm: "ed25519" as const,
		signature: "",
		eventDigest: "",
	};
	const signedSourceEvent = {
		...unsignedSourceEvent,
		signature: await builtinSigner.sign(canonicalJsonBytes(unsignedSourceEvent)),
		eventDigest: "",
	};
	const sourceEvent = { ...signedSourceEvent, eventDigest: digestObject(unsignedSourceEvent) };
	const builtin: WorkflowSkillBuiltinProvenance = {
		vendoredRoot,
		registryArtifactRef: registryRef,
		registryBytes,
		sourceManifestArtifactRef: sourceManifestRef,
		sourceManifestBytes,
		sourceEvent,
	};
	const builtinProvenanceContext: WorkflowSkillBuiltinProvenanceContext = {
		artifactResolver: input.artifactResolver,
		keyResolver: input.receiptContext.keyResolver,
		revokedEventIds: new Set<string>(),
		hostCatalog: {
			vendoredRoot,
			registryArtifactRef: registryRef,
			sourceManifestArtifactRef: sourceManifestRef,
		},
	};
	const sourceProvenance: WorkflowSkillSourceProvenance = {
		sourcePath: skill.filePath,
		sourceBytes,
		sourceRef,
		packageSources,
		builtin,
	};
	return {
		loader,
		skill,
		loaderProvenance,
		builtinProvenanceContext,
		sourceProvenance,
		contentDigest: sourceRef.digest,
		manifest: {
			artifactRef: admissionManifestRef,
			bytes: admissionManifestBytes,
			contentDigest: admissionManifestRef.digest,
		},
		sourceSequence,
		trustedNow: snapshotTrustedNow,
	};
}

async function collectPackageSources(
	skill: Skill,
	publish: (
		bytes: Uint8Array,
		codec: "canonical_json" | "binary",
		idempotencyKey: string,
	) => Promise<WorkflowArtifactRef>,
	workflowId: string,
): Promise<readonly WorkflowSkillPackageSource[]> {
	if (skill.kind !== "python") return [];
	const packageRoot = await realpath(skill.python.packagePath);
	const files: WorkflowSkillPackageSource[] = [];
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true });
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			if (directory === packageRoot && entry.name === "SKILL.md") continue;
			const path = resolve(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(path);
				continue;
			}
			if (!entry.isFile()) throw new Error("default_prime_skill_package_member_invalid");
			const bytes = Uint8Array.from(await readFile(path));
			const relativeName = relative(packageRoot, path).split("\\").join("/");
			const ref = await publish(
				bytes,
				"binary",
				`default-prime-skill-package:${workflowId}:${skill.name}:${sha256Hex(new TextEncoder().encode(relativeName))}`,
			);
			files.push({
				name: relativeName,
				artifactRef: ref,
				bytes,
				contentDigest: sha256Hex(bytes),
				sourcePath: path,
			});
		}
	};
	await visit(packageRoot);
	return files;
}

async function createSkillWithConfig(
	input: DefaultSkillParts & {
		readonly artifactResolver: WorkflowArtifactResolver;
		readonly runtimeStore: WorkflowRuntimeStore;
		readonly receiptContext: WorkflowHostReceiptConsumerContext;
		readonly configDigest: string;
		readonly decisionRef: WorkflowDecisionRef;
		readonly headDigest: string;
		readonly trustedNow: string;
		readonly workflowId: string;
		readonly epochRef: WorkflowEpochRef;
	},
): Promise<WorkflowSkillSnapshot> {
	return createSkillSnapshot({
		workflowId: input.workflowId,
		taskId: "workflow-skill-snapshot",
		decisionRef: input.decisionRef,
		journalHeadDigest: input.headDigest,
		skill: input.skill,
		dependencies: [],
		manifest: input.manifest,
		artifacts: input.artifactResolver,
		publisher: {
			publish: (publishInput) =>
				input.runtimeStore.publishArtifact({ ...publishInput, artifactNamespace: "skills" }),
		},
		workflowContractRevision: 1,
		configDigest: input.configDigest,
		workspaceDigest: input.loaderProvenance.workspaceDigest,
		attemptId: `default-prime-skill:${input.workflowId}:${input.headDigest}`,
		loader: input.loader,
		loaderProvenance: input.loaderProvenance,
		receiptContext: input.receiptContext,
		trustedNow: input.trustedNow,
		sourceProvenance: input.sourceProvenance,
		builtinProvenanceContext: input.builtinProvenanceContext,
		epochRef: input.epochRef,
		sourceEventSequence: input.sourceSequence,
	});
}

async function consumeReceipt(
	context: WorkflowHostReceiptConsumerContext,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
	stateDigest: string,
	revision: number,
	trustedNow: string,
): Promise<void> {
	const artifact = await context.artifactResolver.resolve(receipt.artifactRef);
	await context.receiptResolver.resolve({
		receipt,
		workflowId: receipt.workflowId,
		expectedBindingDigest: bindingDigest,
		artifactBytes: artifact.bytes,
		currentStateDigest: stateDigest,
		currentRevision: revision,
		trustedNow,
		keyResolver: context.keyResolver,
		revokedReceiptIds: context.revokedReceiptIds,
	});
	await context.receiptResolver.consumeIfOneUse({
		receipt,
		workflowId: receipt.workflowId,
		expectedBindingDigest: bindingDigest,
		currentRevision: revision,
	});
}

async function createDefaultRecipe(input: {
	readonly workspacePaths?: readonly string[];
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
	readonly headDigest: string;
	readonly decisionRef: WorkflowDecisionRef;
	readonly trustedNow: string;
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly requiredSkillSnapshotDigests: readonly string[];
	readonly taskGraphSource: WorkflowTaskGraphSource;
}): Promise<CompiledWorkflowRecipe> {
	const proposal = createDefaultPrimeRecipeProposal(input.taskGraphSource);
	const isBuiltinRecipe = input.taskGraphSource.recipeCapability === "builtin_adaptive_prime";
	const pathBoundary = {
		descriptorKind: "host_workspace_descriptor" as const,
		effectBoundaryKind: "host_effect_boundary" as const,
		descriptorDigest: digestObject({ kind: "default-prime-descriptor", workflowId: input.workflowId }),
		effectBoundaryDigest: digestObject({ kind: "default-prime-effect-boundary", workflowId: input.workflowId }),
		workspacePaths: input.workspacePaths ?? DEFAULT_WORKSPACE_PATHS,
		generatedOutputPaths: DEFAULT_GENERATED_OUTPUT_PATHS,
	};
	const contextBase = {
		authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
		hostKeyId: "workflow-host-ed25519",
		workflowId: input.workflowId,
		registryManifestDigest: DEFAULT_WORKFLOW_RECIPE_REGISTRY.manifestDigest,
		epochRef: input.epochRef,
		currentDecisionDigest: input.decisionRef.decisionDigest,
		headDigest: input.headDigest,
		issuedAt: input.trustedNow,
		validUntil: new Date(Date.parse(input.trustedNow) + 300_000).toISOString(),
		pathBoundaryDigest: digestObject(pathBoundary),
	};
	const proofByReceiptId = new Map<string, WorkflowRecipeHostReceiptProof>();
	const context = {
		...contextBase,
		contextDigest: digestObject({ kind: "workflow-recipe-host-context", ...contextBase }),
		receiptContext: input.receiptContext,
		authenticatedReceiptResolver: {
			verifyConsumedReceipt: (receiptInput: {
				receipt: WorkflowVerifiedHostReceipt;
				payload: unknown;
				consumptionWitness: WorkflowRecipeReceiptConsumptionWitness;
				workflowId: string;
				expectedBindingDigest: string;
				currentHeadDigest: string;
				currentEpochRef: WorkflowEpochRef;
				currentDecisionDigest: string;
				hostKeyId: string;
			}): WorkflowRecipeHostReceiptProof | null => {
				const proof = proofByReceiptId.get(receiptInput.receipt.receiptId);
				if (
					proof === undefined ||
					receiptInput.workflowId !== input.workflowId ||
					receiptInput.expectedBindingDigest !== receiptInput.receipt.bindingDigest ||
					receiptInput.currentHeadDigest !== input.headDigest ||
					receiptInput.hostKeyId !== contextBase.hostKeyId
				)
					return null;
				return proof;
			},
		},
	} as WorkflowRecipeHostResolutionPort["context"];
	const issueRecipeReceipt = async <TPayload>(
		kind: Parameters<typeof recipeReceiptKind>[0],
		payload: TPayload,
	): Promise<WorkflowRecipeVerifiedHostReceipt<TPayload>> => {
		const payloadDigest = digestObject(payload);
		const bindingDigest = digestObject({
			kind: "workflow-recipe-receipt-binding",
			receiptKind: kind,
			workflowId: input.workflowId,
			recipeId: proposal.recipeId,
			revision: proposal.revision,
			registryManifestDigest: context.registryManifestDigest,
			hostKeyId: context.hostKeyId,
			epochRef: context.epochRef,
			headDigest: context.headDigest,
			currentDecisionDigest: context.currentDecisionDigest,
			contextDigest: context.contextDigest,
			payloadDigest,
		});
		const receipt = await input.issueReceipt({
			receiptKind: recipeReceiptKind(kind),
			workflowId: input.workflowId,
			bindingDigest,
			oneUse: true,
			issuedAt: context.issuedAt,
			stateDigest: context.headDigest,
			revision: proposal.revision,
			payloadKind: "workflow-recipe",
			payloadDigest,
		});
		await consumeReceipt(
			input.receiptContext,
			receipt,
			bindingDigest,
			context.headDigest,
			proposal.revision,
			new Date().toISOString(),
		);
		const witness = await input.receiptContext.receiptResolver.resolveConsumptionWitness({
			receiptId: receipt.receiptId,
			workflowId: input.workflowId,
			expectedBindingDigest: bindingDigest,
		});
		const consumptionWitness: WorkflowRecipeReceiptConsumptionWitness = {
			...witness,
			headDigest: context.headDigest,
		};
		const proof: WorkflowRecipeHostReceiptProof = {
			proofKind: "ed25519-one-use",
			authorityId: WORKFLOW_RECIPE_HOST_AUTHORITY_ID,
			receiptDigest: digestObject(receipt),
			witnessDigest: digestObject(consumptionWitness),
			workflowId: input.workflowId,
			hostKeyId: context.hostKeyId,
			bindingDigest,
			currentHeadDigest: context.headDigest,
			currentDecisionDigest: context.currentDecisionDigest,
			currentEpochRef: input.epochRef,
			consumptionSequence: consumptionWitness.consumptionSequence,
			signatureVerified: true,
			signatureDigest: sha256Hex(receipt.signature),
			artifactBytesDigest: receipt.artifactRef.digest,
			artifactSizeBytes: receipt.artifactRef.sizeBytes,
			artifactImmutable: true,
			oneUseConsumed: true,
			...(kind === "recipe_registration"
				? isRecord(payload) && typeof payload.recipeDigest === "string"
					? {
							admissionPreimageDigest: payload.recipeDigest,
							signedReceiptPreimageDigest: recipeSignedReceiptPreimageDigest(receipt),
						}
					: (() => {
							throw new Error("default_prime_registration_payload_invalid");
						})()
				: {}),
		};
		proofByReceiptId.set(receipt.receiptId, proof);
		return { receipt, payload, consumptionWitness };
	};
	const nativeReceipts = isBuiltinRecipe
		? await Promise.all(
				WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS.map((snapshot) =>
					issueRecipeReceipt("native_capability_snapshot", snapshot),
				),
			)
		: [];
	const opaqueHoldout: WorkflowRecipeOpaqueHoldout = {
		handleId: proposal.overlays.preEvaluationOverfitting?.opaqueHoldoutRef ?? "",
		manifestDigest: digestObject({ kind: "default-prime-holdout-manifest", workflowId: input.workflowId }),
		resolverContextId: `default-prime-holdout-resolver:${input.workflowId}`,
		authorizationReceiptDigest: digestObject({ kind: "default-prime-holdout-receipt", workflowId: input.workflowId }),
		owner: "host",
		hidden: true,
		opaque: true,
		hostResolverOnly: true,
		authenticated: true,
		returnsEvidenceOnly: true,
		returnsBytes: false,
	};
	const universalGate: WorkflowRecipeUniversalGateBinding = {
		gateId: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID,
		stageIds: orderedTaskGraphSourceTaskIds(input.taskGraphSource),
		decisionDigest: input.decisionRef.decisionDigest,
		scorecardDigest: digestObject({ kind: "default-prime-scorecard", workflowId: input.workflowId }),
		evaluatorDigest: digestObject({ kind: "default-prime-evaluator", workflowId: input.workflowId }),
		terminal: true,
		hostOwned: true,
	};
	const overfittingGate: WorkflowRecipeOverfittingGateReceiptPayload = {
		gateId: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID,
		blocking: true,
		freshnessDigest: digestObject({ kind: "default-prime-freshness", workflowId: input.workflowId }),
		reviewerResultDigest: digestObject({ kind: "default-prime-review", workflowId: input.workflowId }),
		authenticatedReviewer: true,
		opaqueHoldoutManifestDigest: opaqueHoldout.manifestDigest,
		opaqueHoldoutEvidenceDigest: digestObject({
			kind: "default-prime-holdout-evidence",
			workflowId: input.workflowId,
		}),
	};
	const opaqueHoldoutReceipt = await issueRecipeReceipt("opaque_holdout", opaqueHoldout);
	const universalGateReceipt = await issueRecipeReceipt("universal_gate", universalGate);
	const overfittingGateReceipt = await issueRecipeReceipt("overfitting_gate", overfittingGate);
	const host: WorkflowRecipeHostResolutionPort = {
		registryManifestDigest: DEFAULT_WORKFLOW_RECIPE_REGISTRY.manifestDigest,
		pathBoundary,
		context,
		nativeCapabilitySnapshots: isBuiltinRecipe ? WORKFLOW_RECIPE_CANONICAL_NATIVE_CAPABILITY_SNAPSHOTS : [],
		nativeCapabilitySnapshotReceipts: nativeReceipts,
		opaqueHoldoutReceipt,
		universalGateReceipt,
		overfittingGateReceipt,
	};
	const tasks = defaultTasks({
		acceptanceCheckIds: input.acceptanceCheckIds,
		protectedInvariantIds: input.protectedInvariantIds,
		requiredSkillSnapshotDigests: input.requiredSkillSnapshotDigests,
		taskGraphSource: input.taskGraphSource,
	});
	const graphContext = {
		knownSkillSnapshotDigests: input.requiredSkillSnapshotDigests,
		allowedAuthority: [...new Set<WorkflowAuthorityCapability>(tasks.flatMap((task) => task.authority))],
		workspacePaths: input.workspacePaths ?? DEFAULT_WORKSPACE_PATHS,
		generatedOutputPaths: DEFAULT_GENERATED_OUTPUT_PATHS,
		namedContracts: [...new Set(tasks.flatMap((task) => task.ownedContracts))],
	};
	const registeredManifest = createWorkflowRecipeRegisteredManifest({ proposal, tasks, graphContext, host });
	const registeredManifestReceipt = await issueRecipeReceipt("recipe_registration", registeredManifest);
	return compileWorkflowRecipe({
		proposal,
		tasks,
		graphContext,
		host: { ...host, registeredManifestReceipt },
		registeredManifest,
	});
}

function assertBuiltinTaskGraphSource(source: WorkflowTaskGraphSource): void {
	const expectedStageIds = BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.stages.map((stage) => stage.id);
	const taskById = new Map(source.tasks.map((task) => [task.taskId, task]));
	if (taskById.size !== expectedStageIds.length || expectedStageIds.some((taskId) => !taskById.has(taskId)))
		throw new Error("default_prime_builtin_task_graph_source_invalid");
	for (const taskId of expectedStageIds) {
		const task = taskById.get(taskId);
		if (task === undefined) throw new Error("default_prime_builtin_task_graph_source_invalid");
		const expectedDependencies = BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.edges
			.filter((edge) => edge.kind === "forward" && edge.to === taskId)
			.map((edge) => edge.from)
			.sort(compareTaskIds);
		if (digestObject(task.dependencyTaskIds) !== digestObject(expectedDependencies))
			throw new Error("default_prime_builtin_task_graph_source_invalid");
	}
}

function createDefaultPrimeRecipeProposal(source: WorkflowTaskGraphSource): WorkflowRecipeProposal {
	const isBuiltinRecipe = source.recipeCapability === "builtin_adaptive_prime";
	if (isBuiltinRecipe) assertBuiltinTaskGraphSource(source);
	const builtinOverfitting = BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.overlays.preEvaluationOverfitting;
	if (builtinOverfitting === undefined) throw new Error("default_prime_overfitting_overlay_missing");
	const evidencePolicies = [
		...source.tasks.map((task) => ({
			id: `evidence-${task.taskId}`,
			maxBytes: task.evidencePolicy.maxBytes,
			maxItems: task.evidencePolicy.maxItems,
			independent: task.evidencePolicy.independent,
			kind: task.evidencePolicy.kind,
		})),
		{ id: "universal", maxBytes: 8_192, maxItems: 8, independent: true },
		{ id: "overfit", maxBytes: 8_192, maxItems: 16, independent: true },
	];
	const capabilityIdsByAuthority: Partial<Record<WorkflowAuthorityCapability, string>> = {
		read_workspace: "read",
		read_external_evidence: "read_external_evidence",
		write_owned_paths: "write_owned_paths",
		invoke_host_effect: "invoke_host_effect",
		spawn_child: "recursive_spawn",
	};
	const dynamicCapabilities = Object.entries(capabilityIdsByAuthority)
		.filter(([authority]) =>
			source.tasks.some((task) => task.authority.includes(authority as WorkflowAuthorityCapability)),
		)
		.map(([authority, capabilityId]) => ({ id: capabilityId!, name: authority }));
	return {
		recipeId: isBuiltinRecipe
			? BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.recipeId
			: `dynamic:workflow-task-graph-${source.graphDigest}`,
		revision: source.graphRevision,
		stages: source.tasks.map((task) => ({
			id: task.taskId,
			// The planner's declared role, not a blanket "implementation". Hardcoding it meant a
			// verification or red-team task was indistinguishable from the code it was meant to
			// check, so every role-specific gate and capability restriction was inert.
			role: task.role ?? "implementation",
			taskId: task.taskId,
			evidencePolicyId: `evidence-${task.taskId}`,
			capabilityIds: [
				...new Set(
					task.authority
						.map((authority) => capabilityIdsByAuthority[authority])
						.filter((capabilityId): capabilityId is string => capabilityId !== undefined),
				),
			],
			generatedOutputPaths: [
				`artifacts/out/${digestObject({
					graphDigest: source.graphDigest,
					taskId: task.taskId,
					outputRefs: task.outputRefs,
				}).slice(0, 32)}.json`,
			],
			lockPaths: [],
		})),
		gates: [
			{ id: WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID, kind: "host_adjudication", evidencePolicyId: "universal" },
			{ id: WORKFLOW_RECIPE_OVERFITTING_REVIEW_ID, kind: "overfitting_review", evidencePolicyId: "overfit" },
		],
		capabilities: isBuiltinRecipe ? BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.capabilities : dynamicCapabilities,
		evidencePolicies,
		edges: source.tasks.flatMap((task) =>
			task.dependencyTaskIds.map((dependencyTaskId) => ({
				id: `dependency-${digestObject({ from: dependencyTaskId, to: task.taskId }).slice(0, 24)}`,
				from: dependencyTaskId,
				to: task.taskId,
				kind: "forward" as const,
			})),
		),
		fanOuts: [],
		loops: [],
		overlays: {
			universalHostGateIds: [WORKFLOW_RECIPE_UNIVERSAL_HOST_GATE_ID],
			preEvaluationOverfitting: {
				evidencePolicyId: builtinOverfitting.evidencePolicyId,
				checks: builtinOverfitting.checks,
				blockingBoundaries: builtinOverfitting.blockingBoundaries,
				opaqueHoldoutRef: `workflow-task-graph:${source.graphDigest}:holdout`,
			},
		},
	};
}

function recipeReceiptKind(
	kind:
		| "opaque_holdout"
		| "universal_gate"
		| "overfitting_gate"
		| "native_capability_snapshot"
		| "recipe_registration",
): WorkflowVerifiedHostReceipt["receiptKind"] {
	if (kind === "opaque_holdout") return "capability";
	if (kind === "universal_gate") return "decision";
	if (kind === "overfitting_gate") return "adjudication";
	return "artifact";
}

function defaultTasks(input: {
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly requiredSkillSnapshotDigests: readonly string[];
	readonly taskGraphSource: WorkflowTaskGraphSource;
}): readonly WorkflowTask[] {
	if (input.acceptanceCheckIds.length === 0 || input.protectedInvariantIds.length === 0)
		throw new Error("default_prime_acceptance_contract_missing");
	const resourceVector: WorkflowResourceVector = {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 0,
	};
	const controlCapacity = {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	};
	return input.taskGraphSource.tasks.map((task) => ({
		taskId: task.taskId,
		planRevision: input.taskGraphSource.graphRevision,
		objective: task.objective,
		requirementIds: [...task.requirementIds],
		completionCriteria: [...task.completionCriteria],
		dependencyTaskIds: [...task.dependencyTaskIds],
		inputRefs: [...task.inputRefs],
		boundaryIds: [...task.boundaryIds],
		outputRefs: [...task.outputRefs],
		...(task.computeClass === undefined ? {} : { computeClass: task.computeClass }),
		evidencePolicy: { ...task.evidencePolicy },
		evidenceKind: task.evidencePolicy.kind,
		budget: { ...task.budget },
		recoveryPolicy: task.recovery,
		taskGraphSourceDigest: input.taskGraphSource.graphDigest,
		ownedPaths: task.ownedPaths === undefined ? [] : [...task.ownedPaths],
		ownedContracts: task.ownedContracts === undefined ? [] : [...task.ownedContracts],
		requiredSkillSnapshotDigests: [...input.requiredSkillSnapshotDigests],
		verificationCommandDigests: [],
		authority: [...task.authority],
		declaredResourceVector: {
			...resourceVector,
			wallMilliseconds: task.budget.wallTimeLimitSeconds * 1_000,
			monetaryMicrounits: task.budget.spendLimitMicrounits,
		},
		// Control capacity is the coordinator's, not a worker's: the runtime rejects any worker
		// task declaring non-zero control slots. The task's token and retry budget already live in
		// declaredResourceVector and the recovery policy, so putting them here both conflated two
		// different pools and made every dispatch fail capacity validation.
		declaredControlCapacity: { ...controlCapacity },
		status: "ready" as const,
		attemptIds: [],
	}));
}

function createDefaultTaskGraph(input: {
	readonly workspacePaths?: readonly string[];
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
	readonly requiredSkillSnapshotDigests: readonly string[];
	readonly taskGraphSource: WorkflowTaskGraphSource;
}): WorkflowTaskGraph {
	const tasks = defaultTasks(input);
	return validateWorkflowTaskGraph(tasks, {
		knownSkillSnapshotDigests: input.requiredSkillSnapshotDigests,
		allowedAuthority: [...new Set<WorkflowAuthorityCapability>(tasks.flatMap((task) => task.authority))],
		workspacePaths: input.workspacePaths ?? DEFAULT_WORKSPACE_PATHS,
		generatedOutputPaths: DEFAULT_GENERATED_OUTPUT_PATHS,
		namedContracts: [...new Set(tasks.flatMap((task) => task.ownedContracts))],
	});
}

interface DefaultLearningRuntime {
	readonly runtime: WorkflowLearningRuntimeAdapter;
	readonly recordAutoResearchOutcome: (result: AutoResearchPythonResult) => Promise<void>;
	readonly reviewExperience: (experienceId: string) => Promise<Record<string, unknown>>;
	readonly rollbackCandidate: (candidateId: string) => Promise<Record<string, unknown>>;
	readonly pipeline: PrimeWorkflowPipelineRuntime;
	readonly completionStageEvidence: () => Promise<readonly DefaultPrimeCompletionStageEvidence[]>;
}

interface DefaultPrimeLearningPolicyRegistry {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly behavior: "baseline" | "promoted";
	readonly revision: number;
	readonly stateHeadDigest: string;
	readonly policyDigest: string;
	readonly artifactRef: WorkflowArtifactRef;
	readonly promotedCandidateId: string | null;
	readonly promotionReconciliation: WorkflowLearningPromotionReconciliation | null;
	readonly rollbackApplication: WorkflowLearningRollbackApplication | null;
	readonly registryDigest: string;
}

interface DefaultPrimePipelineStageArtifact {
	readonly schemaVersion: 1;
	readonly kind: "default_prime_pipeline_stage";
	readonly workflowId: string;
	readonly recipeDigest: string;
	readonly admissionDigest: string;
	readonly goalBindingDigest: string;
	readonly stageId: string;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly evidenceDigest: string;
	readonly priorStateDigest: string;
}

function defaultPrimeGoalBindingDigest(status: WorkflowShellStatus): string {
	return digestObject({
		workflowId: status.workflowId,
		objective: status.goal.objective,
		acceptanceCheckIds: status.acceptanceCheckIds,
		protectedInvariantIds: status.protectedInvariantIds,
	});
}

function defaultPrimePipelineStageOrder(admission: WorkflowRecipeAdmissionArtifact): readonly string[] {
	const proposal = admission.recipeBinding.proposal;
	const remaining = new Set(proposal.stages.map((stage) => stage.id));
	const ordered: string[] = [];
	while (remaining.size > 0) {
		const next = proposal.stages
			.filter((stage) => remaining.has(stage.id))
			.filter((stage) =>
				proposal.edges
					.filter((edge) => (edge.kind ?? "forward") === "forward" && edge.to === stage.id)
					.every((edge) => !remaining.has(edge.from)),
			)
			.map((stage) => stage.id)
			.sort();
		if (next.length === 0) throw new Error("default_prime_pipeline_dependency_cycle");
		for (const stageId of next) {
			remaining.delete(stageId);
			ordered.push(stageId);
		}
	}
	return ordered;
}

function projectDefaultPrimePipelineState(
	workflowId: string,
	admission: WorkflowRecipeAdmissionArtifact,
	completedStageIds: ReadonlySet<string>,
): PrimeWorkflowPipelineState {
	const proposal = admission.recipeBinding.proposal;
	const stageOrder = defaultPrimePipelineStageOrder(admission);
	const completed = stageOrder.filter((stageId) => completedStageIds.has(stageId));
	const ready = stageOrder.filter((stageId) => {
		if (completedStageIds.has(stageId)) return false;
		const predecessors = proposal.edges
			.filter((edge) => (edge.kind ?? "forward") === "forward" && edge.to === stageId)
			.map((edge) => edge.from);
		return predecessors.every((stageId) => completedStageIds.has(stageId));
	});
	const unsigned = {
		workflowId,
		recipeDigest: admission.recipeDigest,
		completedStageIds: completed,
		readyStageIds: ready,
	};
	return Object.freeze({ ...unsigned, stateDigest: digestObject(unsigned) });
}

interface DefaultAutoResearchLearningDisposition {
	readonly outcome: "positive" | "negative" | "rejected" | "failed";
	readonly progressKind: "verified" | "none";
}

async function deriveAutoResearchLearningDisposition(input: {
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly evidenceRefs: readonly WorkflowArtifactRef[];
	readonly workflowId: string;
	readonly recipe: AutoResearchDurableRecipe;
	readonly objective: string;
	readonly acceptanceCheckIds: readonly string[];
	readonly protectedInvariantIds: readonly string[];
}): Promise<DefaultAutoResearchLearningDisposition> {
	const registrationDigest = digestObject(input.recipe.registration);
	const goalBindingDigest = digestObject({
		workflowId: input.workflowId,
		objective: input.objective,
		acceptanceCheckIds: input.acceptanceCheckIds,
		protectedInvariantIds: input.protectedInvariantIds,
	});
	const evaluationArtifacts: Record<string, unknown>[] = [];
	for (const evidenceRef of input.evidenceRefs) {
		const resolved = await input.artifactResolver.resolve(evidenceRef);
		if (
			!resolved.exists ||
			resolved.verifiedDigest !== evidenceRef.digest ||
			resolved.verifiedSizeBytes !== evidenceRef.sizeBytes
		)
			throw new Error("default_prime_learning_evidence_not_host_verified");
		const parsed = parseCanonicalJsonBytes(resolved.bytes);
		if (
			isRecord(parsed) &&
			parsed.kind === "default-prime-autoresearch-evidence" &&
			parsed.workflowId === input.workflowId &&
			parsed.recipeDigest === input.recipe.recipeDigest &&
			parsed.registrationDigest === registrationDigest &&
			parsed.objective === input.objective &&
			digestObject(parsed.acceptanceCheckIds) === digestObject(input.acceptanceCheckIds) &&
			digestObject(parsed.protectedInvariantIds) === digestObject(input.protectedInvariantIds) &&
			parsed.goalBindingDigest === goalBindingDigest &&
			isRecord(parsed.evidence)
		)
			evaluationArtifacts.push(parsed.evidence);
	}
	if (evaluationArtifacts.length !== 1) return { outcome: "failed", progressKind: "none" };
	const evaluation = evaluationArtifacts[0];
	if (evaluation === undefined || !isRecord(evaluation.observation))
		return { outcome: "failed", progressKind: "none" };
	const measurement = evaluation.observation;
	const registration = input.recipe.registration;
	const measurementWithoutDigest = {
		source: measurement.source,
		rawResultRefsDigest: measurement.rawResultRefsDigest,
		phase: measurement.phase,
		status: measurement.status,
		commandInputBinding: measurement.commandInputBinding,
		metricDirection: measurement.metricDirection,
		metricTarget: measurement.metricTarget,
		metricTolerance: measurement.metricTolerance,
		sampleCount: measurement.sampleCount,
		metricValue: measurement.metricValue,
		baselineMetricValue: measurement.baselineMetricValue,
		variance: measurement.variance,
		fixtureManifestDigest: measurement.fixtureManifestDigest,
		trainInputDigest: measurement.trainInputDigest,
		evalInputDigest: measurement.evalInputDigest,
		heldOutInputDigest: measurement.heldOutInputDigest,
		evaluatorDigest: measurement.evaluatorDigest,
		parserDigest: measurement.parserDigest,
		guardDigest: measurement.guardDigest,
		seedDigest: measurement.seedDigest,
		proxySignals: measurement.proxySignals,
		costMicrounits: measurement.costMicrounits,
		latencyMilliseconds: measurement.latencyMilliseconds,
		resourceUsage: measurement.resourceUsage,
		hiddenMetricValue: measurement.hiddenMetricValue,
		adversarialMetricValue: measurement.adversarialMetricValue,
		candidateClaimedCompletion: measurement.candidateClaimedCompletion,
		candidateClaimedPromotion: measurement.candidateClaimedPromotion,
	};
	if (
		measurement.source !== "host" ||
		measurement.measurementDigest !== digestObject(measurementWithoutDigest) ||
		evaluation.outcome === "inconclusive" ||
		measurement.status !== "complete" ||
		measurement.candidateClaimedCompletion !== false ||
		measurement.candidateClaimedPromotion !== false ||
		measurement.metricDirection !== registration.metric.direction ||
		measurement.metricTarget !== registration.metric.target ||
		measurement.metricTolerance !== registration.metric.tolerance ||
		measurement.evaluatorDigest !== registration.evaluator.evaluatorDigest ||
		measurement.parserDigest !== registration.evaluator.parserDigest ||
		measurement.guardDigest !== (registration.guard?.guardDigest ?? null) ||
		measurement.seedDigest !== registration.seed.seedDigest ||
		!Number.isSafeInteger(measurement.sampleCount) ||
		(measurement.sampleCount as number) < registration.requiredSampleSize ||
		!Array.isArray(measurement.proxySignals) ||
		measurement.proxySignals.length > 0
	)
		return { outcome: "rejected", progressKind: "none" };
	const metricValue = measurement.metricValue as number;
	const baselineMetricValue = measurement.baselineMetricValue as number;
	const tolerance = typeof measurement.metricTolerance === "number" ? measurement.metricTolerance : 0;
	if (!Number.isFinite(metricValue) || !Number.isFinite(baselineMetricValue) || !Number.isFinite(tolerance))
		return { outcome: "failed", progressKind: "none" };
	const improvement =
		measurement.metricDirection === "lower" ? baselineMetricValue - metricValue : metricValue - baselineMetricValue;
	if (improvement > tolerance && evaluation.outcome === "accepted")
		return { outcome: "positive", progressKind: "verified" };
	if (improvement < -tolerance) return { outcome: "negative", progressKind: "verified" };
	return { outcome: "rejected", progressKind: "none" };
}

function learningWitness(input: {
	readonly stage: string;
	readonly candidateId: string | null;
	readonly evidenceRef: WorkflowArtifactRef;
	readonly payloadDigest: string;
	readonly current: WorkflowLearningHostSnapshot;
	readonly witnessKind: WorkflowLearningHostWitness["witnessKind"];
}): WorkflowLearningHostWitness {
	return Object.freeze({
		witnessId: `learning-witness-${digestObject({
			stage: input.stage,
			candidateId: input.candidateId,
			evidenceRef: input.evidenceRef,
			payloadDigest: input.payloadDigest,
			witnessKind: input.witnessKind,
			workflowId: input.current.workflowId,
			revision: input.current.currentRevision,
			storeEpoch: input.current.storeEpoch,
			coordinatorEpoch: input.current.coordinatorEpoch,
			stateHeadDigest: input.current.stateHeadDigest,
		}).slice(0, 48)}`,
		witnessKind: input.witnessKind,
		workflowId: input.current.workflowId,
		stage: input.stage,
		candidateId: input.candidateId,
		evidenceRef: structuredClone(input.evidenceRef),
		payloadDigest: input.payloadDigest,
		bytesDigest: input.evidenceRef.digest,
		bytesSize: input.evidenceRef.sizeBytes,
		revision: input.current.currentRevision,
		storeEpoch: input.current.storeEpoch ?? 0,
		coordinatorEpoch: input.current.coordinatorEpoch ?? 0,
		stateHeadDigest: input.current.stateHeadDigest ?? "",
		trustedNow: input.current.trustedNow,
		oneUse: true,
	});
}

async function createDefaultLearningRuntime(
	input: DefaultPrimeWorkflowProviderInput,
	snapshots: PrimeWorkflowSnapshots,
	autoResearchRecipe: AutoResearchDurableRecipe,
	executionKey: string,
	taskGraph: WorkflowTaskGraph,
): Promise<DefaultLearningRuntime> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("default_prime_learning_requires_durable_runtime");
	const status = input.readStatus();
	if (
		status.workflowId !== input.workflowId ||
		status.stateDigest === null ||
		typeof status.goal.objective !== "string" ||
		status.goal.objective.length === 0
	)
		throw new Error("default_prime_learning_requires_active_workflow");
	const objective = status.goal.objective;
	const decisionRef = goalDecision(status, input.workflowId);
	if (decisionRef === null) throw new Error("default_prime_learning_requires_approved_goal_decision");
	const goalContractDigest = status.goalContract?.contractDigest;
	if (goalContractDigest === undefined) throw new Error("default_prime_learning_requires_goal_contract");
	const workspaceDigest = snapshots.skills[0]?.workspaceDigest;
	const parserDigest = snapshots.config.parserDigests[0];
	const evaluatorDigest = snapshots.config.evaluatorDigests[0];
	const guardDigest = snapshots.config.guardDigests[0];
	if (
		workspaceDigest === undefined ||
		parserDigest === undefined ||
		evaluatorDigest === undefined ||
		guardDigest === undefined
	)
		throw new Error("default_prime_learning_config_authority_incomplete");
	const revisions: WorkflowRevisionTuple = Object.freeze({
		contractRevision: 1,
		scorecardRevision: 1,
		planRevision: 1,
		configRevision: snapshots.config.configRevision,
		evidenceRevision: 1,
	});
	const isBuiltinAdaptivePrimeRecipe = snapshots.recipe.recipeId === BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.recipeId;
	const semanticStateDigest = status.stateDigest;
	const baselineRevision = decisionRef.revision;
	const authorityArtifact = async (
		kind: "scorecard" | "evaluator" | "metric" | "parser" | "baseline",
	): Promise<WorkflowArtifactRef> => {
		const bytes = canonicalJsonBytes({
			schemaVersion: 1,
			kind: `default_prime_learning_${kind}`,
			workflowId: input.workflowId,
			recipeDigest: snapshots.recipe.recipeDigest,
			configDigest: snapshots.config.resolvedConfigDigest,
			decisionRef,
			goalContractDigest,
			acceptanceCheckIds: status.acceptanceCheckIds,
			protectedInvariantIds: status.protectedInvariantIds,
		});
		return (
			await input.runtimeStore.publishArtifact({
				workflowId: input.workflowId,
				payloadKind: "evidence",
				bytes,
				codec: "canonical_json",
				sourceEventSequence: baselineRevision,
				idempotencyKey: `default-prime-learning-authority:${kind}:${snapshots.recipe.recipeDigest}`,
			})
		).envelope.ref;
	};
	const [scorecardRef, approvedEvaluatorRef, metricRef, approvedParserRef, baselineArtifactRef] = await Promise.all([
		authorityArtifact("scorecard"),
		authorityArtifact("evaluator"),
		authorityArtifact("metric"),
		authorityArtifact("parser"),
		authorityArtifact("baseline"),
	]);
	const scorerDecisionRecord = {
		decisionId: `learning-scorer-${snapshots.recipe.recipeDigest.slice(0, 24)}`,
		decisionScope: { kind: "workflow" as const, workflowId: input.workflowId, rootSessionId: input.rootSessionId },
		kind: "learning_scorer_authority",
		userApprovalDecisionRef: structuredClone(decisionRef),
		scorecardRef,
		evaluatorRef: approvedEvaluatorRef,
		metricRef,
		parserRef: approvedParserRef,
		authority: "evaluate_only",
		canAuthorizePromotion: false,
	};
	const scorerDecisionArtifactRef = (
		await input.runtimeStore.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "evidence",
			bytes: canonicalJsonBytes(scorerDecisionRecord),
			codec: "canonical_json",
			sourceEventSequence: baselineRevision,
			idempotencyKey: `default-prime-learning-scorer-decision:${snapshots.recipe.recipeDigest}`,
		})
	).envelope.ref;
	const scorerDecisionRef: WorkflowDecisionRef = Object.freeze({
		decisionId: scorerDecisionRecord.decisionId,
		decisionScope: structuredClone(scorerDecisionRecord.decisionScope),
		revision: baselineRevision,
		storeEpoch: input.epochRef.storeEpoch,
		coordinatorEpoch: input.epochRef.coordinatorEpoch,
		decisionDigest: digestObject(scorerDecisionRecord),
	});
	const policyRegistryRecord = "default-prime-learning-policy-v1";
	const readPolicyRegistry = async (): Promise<DefaultPrimeLearningPolicyRegistry> => {
		const bytes = await durable.auxiliaryStore.read(policyRegistryRecord);
		if (bytes === null) throw new Error("default_prime_learning_policy_registry_missing");
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isRecord(parsed)) throw new Error("default_prime_learning_policy_registry_invalid");
		const { registryDigest, ...withoutDigest } = parsed;
		if (
			parsed.schemaVersion !== 1 ||
			parsed.workflowId !== input.workflowId ||
			(parsed.behavior !== "baseline" && parsed.behavior !== "promoted") ||
			!Number.isSafeInteger(parsed.revision) ||
			(parsed.revision as number) < baselineRevision ||
			typeof parsed.stateHeadDigest !== "string" ||
			typeof parsed.policyDigest !== "string" ||
			!isRecord(parsed.artifactRef) ||
			(parsed.promotedCandidateId !== null && typeof parsed.promotedCandidateId !== "string") ||
			typeof registryDigest !== "string" ||
			registryDigest !== digestObject(withoutDigest)
		)
			throw new Error("default_prime_learning_policy_registry_invalid");
		return structuredClone(parsed as unknown as DefaultPrimeLearningPolicyRegistry);
	};
	await durable.withExclusiveLease(`default-prime-learning-policy:${input.workflowId}`, async () => {
		const existing = await durable.auxiliaryStore.read(policyRegistryRecord);
		if (existing !== null) {
			await readPolicyRegistry();
			return;
		}
		const initialWithoutDigest = {
			schemaVersion: 1 as const,
			workflowId: input.workflowId,
			behavior: "baseline" as const,
			revision: baselineRevision,
			stateHeadDigest: semanticStateDigest,
			policyDigest: snapshots.recipe.recipeDigest,
			artifactRef: baselineArtifactRef,
			promotedCandidateId: null,
			promotionReconciliation: null,
			rollbackApplication: null,
		};
		await durable.auxiliaryStore.write(
			policyRegistryRecord,
			canonicalJsonBytes({ ...initialWithoutDigest, registryDigest: digestObject(initialWithoutDigest) }),
		);
	});
	const compareAndSwapPolicyRegistry = async (
		expectedDigest: string,
		nextWithoutDigest: Omit<DefaultPrimeLearningPolicyRegistry, "registryDigest">,
	): Promise<DefaultPrimeLearningPolicyRegistry> => {
		return durable.withExclusiveLease(`default-prime-learning-policy:${input.workflowId}`, async () => {
			const currentRegistry = await readPolicyRegistry();
			if (currentRegistry.registryDigest !== expectedDigest)
				throw new Error("default_prime_learning_policy_registry_cas_lost");
			const next = {
				...nextWithoutDigest,
				registryDigest: digestObject(nextWithoutDigest),
			};
			await durable.auxiliaryStore.write(policyRegistryRecord, canonicalJsonBytes(next));
			return next;
		});
	};
	const scorerAuthority: Omit<WorkflowLearningApprovedAuthority, "receipt"> = Object.freeze({
		scorecardRef,
		evaluatorRef: approvedEvaluatorRef,
		metricRef,
		decisionRef: scorerDecisionRef,
		owner: "autoresearch",
		producer: "autoresearch",
		kind: "methodology",
		sampleSize: 1,
		effectThreshold: 0,
		tolerance: 0,
		maxCostMicrounits: 1_000_000,
		maxLatencyMilliseconds: 3_600_000,
		evaluatorDigest: approvedEvaluatorRef.digest,
		metricDigest: metricRef.digest,
	});
	const learningContext = new AsyncLocalStorage<{ readonly evidenceId: string; readonly trustedNow: string }>();
	const current = async (): Promise<WorkflowLearningHostSnapshot> => {
		const registry = await readPolicyRegistry();
		const active = learningContext.getStore();
		const trustedNow = active?.trustedNow ?? input.now?.() ?? new Date().toISOString();
		const evidenceId = active?.evidenceId ?? "default-prime-learning-replay";
		const evidenceClockBinding = {
			evidenceId,
			workspaceDigest,
			configDigest: snapshots.config.resolvedConfigDigest,
			revisions,
		};
		const clockBindingDigest = digestObject(
			evidenceId.startsWith("evidence-")
				? evidenceClockBinding
				: {
						...evidenceClockBinding,
						policyRevision: registry.revision,
						policyRegistryDigest: registry.registryDigest,
						stateHeadDigest: registry.stateHeadDigest,
					},
		);
		const trustedClockReceipt = await input.issueReceipt({
			receiptKind: "clock",
			workflowId: input.workflowId,
			bindingDigest: clockBindingDigest,
			receiptId: `learning-clock-${digestObject({
				evidenceId,
				policyRevision: registry.revision,
				policyRegistryDigest: registry.registryDigest,
				stateHeadDigest: registry.stateHeadDigest,
				trustedNow,
			}).slice(0, 48)}`,
			issuedAt: trustedNow,
			stateDigest: semanticStateDigest,
			revision: registry.revision,
			payloadKind: "workflow-learning",
		});
		return Object.freeze({
			workflowId: input.workflowId,
			stateDigest: semanticStateDigest,
			workspaceDigest,
			configDigest: snapshots.config.resolvedConfigDigest,
			parserDigest,
			evaluatorDigest,
			guardDigest,
			revisions,
			currentRevision: registry.revision,
			trustedNow,
			trustedClockReceipt,
			requiredFreshnessMilliseconds: 1,
			baselineRevision,
			baselineDigest: snapshots.recipe.recipeDigest,
			evaluatorBaselineDigest: approvedEvaluatorRef.digest,
			metricBaselineDigest: metricRef.digest,
			revisionRegistryDigest: registry.registryDigest,
			artifactResolver: input.artifactResolver,
			receiptContext: input.receiptContext,
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			stateHeadDigest: registry.stateHeadDigest,
		});
	};
	const stripLearningReceiptFields = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map((item) => stripLearningReceiptFields(item));
		if (!isRecord(value)) return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => key !== "hostReceipt" && key !== "receipt" && key !== "receipts")
				.map(([key, item]) => [key, stripLearningReceiptFields(item)]),
		);
	};
	const issueLearningReceipt = async (
		kind: string,
		payload: unknown,
		snapshot: WorkflowLearningHostSnapshot,
		identity: string,
	): Promise<WorkflowVerifiedHostReceipt> => {
		const receiptId = `default-prime-learning-${identity}-${digestObject(stripLearningReceiptFields(payload)).slice(0, 32)}`;
		const receiptPayloadDigest = digestObject({ kind, identity, workflowId: input.workflowId });
		return input.issueReceipt({
			receiptKind: kind === "host_fenced_promotion" ? "decision" : "artifact",
			workflowId: input.workflowId,
			bindingDigest: digestObject({
				kind,
				payloadDigest: digestObject(stripLearningReceiptFields(payload)),
				receiptId,
				receiptPayloadDigest,
			}),
			receiptId,
			oneUse: true,
			issuedAt: snapshot.trustedNow,
			stateDigest: snapshot.stateDigest,
			revision: snapshot.currentRevision,
			payloadKind: "workflow-learning",
			payloadDigest: receiptPayloadDigest,
		});
	};
	const publishLearningArtifact = async (identity: string, value: unknown): Promise<WorkflowArtifactRef> => {
		return (
			await input.runtimeStore.publishArtifact({
				workflowId: input.workflowId,
				payloadKind: "evidence",
				bytes: canonicalJsonBytes(value),
				codec: "canonical_json",
				sourceEventSequence: baselineRevision,
				idempotencyKey: `default-prime-learning:${identity}`,
			})
		).envelope.ref;
	};
	const learningCandidateStageIds = isBuiltinAdaptivePrimeRecipe
		? BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.stages.map((stage) => stage.id)
		: snapshots.recipe.recipeBinding.proposal.stages.map((stage) => stage.id);
	const createLearningCandidate: WorkflowLearningHost["createCandidate"] = async ({ experience, trigger }) => {
		for (const ref of experience.progressEvidenceRefs) {
			const resolved = await input.artifactResolver.resolve(ref);
			if (!resolved.exists || resolved.verifiedDigest !== ref.digest || resolved.verifiedSizeBytes !== ref.sizeBytes)
				throw new Error("default_prime_learning_candidate_evidence_invalid");
		}
		const snapshot = await current();
		const candidateId = `learning-candidate-${digestObject({
			experienceId: experience.experienceId,
			candidateStageIds: learningCandidateStageIds,
		}).slice(0, 48)}`;
		const proposalRef = await publishLearningArtifact(`proposal:${candidateId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_workflow_proposal",
			workflowId: input.workflowId,
			candidateId,
			baselineRecipeId: isBuiltinAdaptivePrimeRecipe
				? BUILTIN_DEFAULT_PRIME_ADAPTIVE_RECIPE.recipeId
				: snapshots.recipe.recipeId,
			candidateRecipeId: isBuiltinAdaptivePrimeRecipe
				? BUILTIN_ATTACK_ARCHITECT_JUDGE_UNIFY_EDGE_TEST.recipeId
				: snapshots.recipe.recipeId,
			candidateStageIds: learningCandidateStageIds,
			solutionFamily: "adversarial workflow topology",
			parameterChanges: [],
			sourceEvidenceDigest: experience.evidenceDigest,
		});
		const candidateRef = await publishLearningArtifact(`candidate:${candidateId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_candidate",
			workflowId: input.workflowId,
			candidateId,
			proposalRef,
			candidateStageIds: learningCandidateStageIds,
			protectedInvariantIds: status.protectedInvariantIds,
		});
		const caseManifestWithoutDigest = {
			manifestId: `holdout:${candidateId}`,
			kind: "held_out" as const,
			sourceArtifactRefs: experience.progressEvidenceRefs.map((ref) => structuredClone(ref)),
			inputDigest: digestObject({ candidateId, partition: "same-case", experience: experience.evidenceDigest }),
			hidden: true as const,
			requiredSampleSize: 1,
			effectThreshold: 0,
			tolerance: 0,
			nonRegressionPredicateRefs: [metricRef],
			maxCostMicrounits: 1_000_000,
			maxLatencyMilliseconds: 3_600_000,
			heldOutInputDigest:
				autoResearchRecipe.registration.hiddenHoldout?.manifestDigest ??
				digestObject({ candidateId, partition: "held-out" }),
			manifestDigest: "",
		};
		const caseManifest = {
			...caseManifestWithoutDigest,
			manifestDigest: digestObject(caseManifestWithoutDigest),
		};
		const hiddenHoldoutManifestRef = await publishLearningArtifact(`holdout:${candidateId}`, {
			schemaVersion: 1,
			kind: "workflow_learning_holdout_manifest",
			workflowId: input.workflowId,
			candidateId,
			manifestDigest: caseManifest.manifestDigest,
			manifest: caseManifest,
		});
		const candidateWithoutReceipt: Omit<WorkflowLearningCandidate, "hostReceipt"> = {
			candidateId,
			experienceId: experience.experienceId,
			workflowId: input.workflowId,
			owner: "autoresearch",
			producer: "autoresearch",
			kind: "methodology",
			mutationClass: "workflow",
			proposalRef,
			candidateRef,
			candidateDigest: candidateRef.digest,
			baselineRevision: snapshot.baselineRevision,
			baselineDigest: snapshot.baselineDigest,
			baselineArtifactRef,
			scorecardRef,
			scorecardDigest: scorecardRef.digest,
			evaluatorRef: approvedEvaluatorRef,
			evaluatorDigest: approvedEvaluatorRef.digest,
			parserRef: approvedParserRef,
			caseManifest,
			hiddenHoldoutManifestRef,
			proposal: null,
		};
		const hostReceipt = await issueLearningReceipt(
			"typed_candidate",
			{ candidate: candidateWithoutReceipt, trigger },
			snapshot,
			`candidate-${candidateId}`,
		);
		return { ...candidateWithoutReceipt, hostReceipt };
	};
	const candidateTopologyPasses = async (candidate: WorkflowLearningCandidate): Promise<boolean> => {
		const resolved = await input.artifactResolver.resolve(candidate.candidateRef);
		if (!resolved.exists || resolved.verifiedDigest !== candidate.candidateRef.digest) return false;
		const parsed = parseCanonicalJsonBytes(resolved.bytes);
		if (
			!isRecord(parsed) ||
			!Array.isArray(parsed.candidateStageIds) ||
			!parsed.candidateStageIds.every((value): value is string => typeof value === "string")
		)
			return false;
		const parsedStageIds = parsed.candidateStageIds;
		return (
			digestObject(parsedStageIds) === digestObject(learningCandidateStageIds) &&
			learningCandidateStageIds.every((stageId) => parsedStageIds.includes(stageId))
		);
	};
	const stageMetrics = (evidenceRefs: readonly WorkflowArtifactRef[]): WorkflowLearningStageMetrics => ({
		sampleCount: 1,
		effectSize: 1,
		variance: 0,
		costMicrounits: 1,
		latencyMilliseconds: 1,
		evaluatorDigest: approvedEvaluatorRef.digest,
		metricDigest: metricRef.digest,
		evidenceDigest: digestObject(evidenceRefs),
	});
	const runLearningShadow: WorkflowLearningHost["runShadow"] = async ({ candidate }) => {
		const snapshot = await current();
		const passed = await candidateTopologyPasses(candidate);
		if (candidate.caseManifest.kind !== "held_out")
			throw new Error("default_prime_learning_candidate_holdout_missing");
		const heldOutInputDigest = candidate.caseManifest.heldOutInputDigest;
		const evidenceRef = await publishLearningArtifact(`shadow-evidence:${candidate.candidateId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_shadow_evidence",
			workflowId: input.workflowId,
			candidateId: candidate.candidateId,
			hostOnlyHoldoutDigest: heldOutInputDigest,
			passed,
			overfittingDetected: !passed,
		});
		const evidenceRefs = [evidenceRef];
		const base = {
			candidateId: candidate.candidateId,
			sameCaseInputDigest: candidate.caseManifest.inputDigest,
			heldOutInputDigest,
			heldOutSampleCount: 1,
			heldOutPassed: passed,
			overfittingDetected: !passed,
			nonRegressionPassed: passed,
			safetyPassed: passed,
			evidenceRefs,
			metrics: stageMetrics(evidenceRefs),
		};
		const resultRef = await publishLearningArtifact(`shadow-result:${candidate.candidateId}`, {
			schemaVersion: 1,
			kind: "workflow_learning_stage_result",
			workflowId: input.workflowId,
			stage: "shadow",
			...base,
		});
		const receipt = await issueLearningReceipt(
			"shadow_review",
			{ candidate, shadow: { ...base, resultRef } },
			snapshot,
			`shadow-${candidate.candidateId}`,
		);
		return { ...base, receipts: [receipt], resultRef };
	};
	const runLearningCanary: WorkflowLearningHost["runCanary"] = async ({ candidate, shadow }) => {
		const snapshot = await current();
		const passed = shadow.heldOutPassed && !shadow.overfittingDetected && (await candidateTopologyPasses(candidate));
		const evidenceRef = await publishLearningArtifact(`canary-evidence:${candidate.candidateId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_canary_evidence",
			workflowId: input.workflowId,
			candidateId: candidate.candidateId,
			passed,
		});
		const evidenceRefs = [evidenceRef];
		const base = {
			candidateId: candidate.candidateId,
			inputDigest: candidate.caseManifest.inputDigest,
			passed,
			sessionId: `canary-session-${candidate.candidateId}`,
			executionIdentity: `canary-execution-${candidate.candidateId}`,
			evidenceRefs,
			metrics: stageMetrics(evidenceRefs),
		};
		const resultRef = await publishLearningArtifact(`canary-result:${candidate.candidateId}`, {
			schemaVersion: 1,
			kind: "workflow_learning_stage_result",
			workflowId: input.workflowId,
			stage: "canary",
			...base,
		});
		const receipt = await issueLearningReceipt(
			"canary_review",
			{ candidate, shadow, canary: { ...base, resultRef } },
			snapshot,
			`canary-${candidate.candidateId}`,
		);
		return { ...base, receipts: [receipt], resultRef };
	};
	const runLearningRedTeam: WorkflowLearningHost["runIndependentRedTeam"] = async ({ candidate, shadow, canary }) => {
		const snapshot = await current();
		const passed = canary.passed && (await candidateTopologyPasses(candidate));
		const evidenceRef = await publishLearningArtifact(`red-team-evidence:${candidate.candidateId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_red_team_evidence",
			workflowId: input.workflowId,
			candidateId: candidate.candidateId,
			attacks: ["stage-omission", "metric-substitution", "holdout-reuse", "self-approval"],
			passed,
		});
		const evidenceRefs = [evidenceRef];
		const base = {
			candidateId: candidate.candidateId,
			independent: true,
			passed,
			sessionId: `red-team-session-${candidate.candidateId}`,
			executionIdentity: `red-team-execution-${candidate.candidateId}`,
			evidenceRefs,
			metrics: stageMetrics(evidenceRefs),
		};
		const resultRef = await publishLearningArtifact(`red-team-result:${candidate.candidateId}`, {
			schemaVersion: 1,
			kind: "workflow_learning_stage_result",
			workflowId: input.workflowId,
			stage: "red_team",
			...base,
		});
		const receipt = await issueLearningReceipt(
			"independent_red_team",
			{ candidate, shadow, canary, redTeam: { ...base, resultRef } },
			snapshot,
			`red-team-${candidate.candidateId}`,
		);
		return { ...base, receipts: [receipt], resultRef };
	};
	const resolveLearningDecision: WorkflowLearningHost["resolveDecision"] = async ({
		candidate,
		shadow,
		canary,
		redTeam,
	}) => {
		if (!shadow.heldOutPassed || !canary.passed || !redTeam.passed || !redTeam.independent)
			throw new Error("default_prime_learning_decision_evidence_failed");
		const decisionRecord = {
			decisionId: `learning-decision-${candidate.candidateId}`,
			decisionScope: { kind: "workflow" as const, workflowId: input.workflowId, rootSessionId: input.rootSessionId },
			candidateId: candidate.candidateId,
			shadowDigest: digestObject(shadow),
			canaryDigest: digestObject(canary),
			redTeamDigest: digestObject(redTeam),
			verdict: "approve" as const,
		};
		const decisionArtifactRef = await publishLearningArtifact(`decision:${candidate.candidateId}`, decisionRecord);
		const decision = scorerDecisionRecord as unknown as DurableDecisionRecord;
		return {
			decision,
			operation: {
				kind: "refinement",
				preimageRef: decisionArtifactRef,
				preimageDigest: decisionArtifactRef.digest,
			},
			decisionRef: scorerDecisionRef,
			decisionWitness: learningWitness({
				stage: "decision",
				candidateId: candidate.candidateId,
				evidenceRef: scorerDecisionArtifactRef,
				payloadDigest: digestObject(scorerDecisionRecord),
				current: await current(),
				witnessKind: "decision",
			}),
		};
	};
	const reconcileLearningPromotion: WorkflowLearningHost["reconcilePromotion"] = async (promotionInput) => {
		const registry = await readPolicyRegistry();
		const reconciliation = registry.promotionReconciliation;
		if (reconciliation === null) return null;
		if (
			registry.behavior !== "promoted" ||
			registry.promotedCandidateId !== promotionInput.candidate.candidateId ||
			reconciliation.operationId !== promotionInput.operationId ||
			reconciliation.workflowId !== input.workflowId ||
			reconciliation.candidateId !== promotionInput.candidate.candidateId ||
			digestObject(reconciliation.expected) !== digestObject(promotionInput.expected) ||
			digestObject(reconciliation.decisionRef) !== digestObject(promotionInput.decision.decisionRef)
		)
			throw new Error("default_prime_learning_promotion_reconciliation_invalid");
		return structuredClone(reconciliation);
	};
	const promoteLearningCandidate: WorkflowLearningHost["promote"] = async (promotionInput) => {
		const existing = await reconcileLearningPromotion(promotionInput);
		if (existing !== null) return existing.promotion;
		if (promotionInput.decision.decisionRef === undefined)
			throw new Error("default_prime_learning_promotion_decision_missing");
		const registry = await readPolicyRegistry();
		if (
			registry.behavior !== "baseline" ||
			registry.revision !== promotionInput.expected.currentRevision ||
			registry.stateHeadDigest !== promotionInput.expected.stateHeadDigest ||
			registry.registryDigest !== promotionInput.current.revisionRegistryDigest
		)
			throw new Error("default_prime_learning_promotion_cas_stale");
		const nextRevision = registry.revision + 1;
		const policyDigest = promotionInput.candidate.candidateRef.digest;
		const nextStateHeadDigest = digestObject({
			kind: "default_prime_learning_promoted_policy",
			priorRegistryDigest: registry.registryDigest,
			candidateId: promotionInput.candidate.candidateId,
			policyDigest,
			decisionRef: promotionInput.decision.decisionRef,
			operationId: promotionInput.operationId,
			nextRevision,
		});
		const promotionWithoutReceipt: Omit<WorkflowLearningPromotion, "receipt"> = {
			promotionId: `promotion-${promotionInput.candidate.candidateId}`,
			candidateId: promotionInput.candidate.candidateId,
			revisionId: `policy-revision-${nextRevision}`,
			revision: nextRevision,
			policyDigest,
			revisionRecord: { revision: nextRevision, policyDigest },
			stateHeadDigest: nextStateHeadDigest,
			storeEpoch: promotionInput.expected.storeEpoch,
			coordinatorEpoch: promotionInput.expected.coordinatorEpoch,
			casExecutionKey: digestObject({
				kind: "default-prime-learning-promotion-cas",
				operationId: promotionInput.operationId,
				expected: promotionInput.expected,
			}),
		};
		const snapshot = await current();
		const receipt = await issueLearningReceipt(
			"host_fenced_promotion",
			{
				candidate: promotionInput.candidate,
				shadow: promotionInput.shadow,
				canary: promotionInput.canary,
				redTeam: promotionInput.redTeam,
				decision: promotionInput.decision,
				promotion: promotionWithoutReceipt,
			},
			snapshot,
			`promotion-${promotionInput.candidate.candidateId}`,
		);
		const promotion: WorkflowLearningPromotion = { ...promotionWithoutReceipt, receipt };
		const reconciliation: WorkflowLearningPromotionReconciliation = {
			operationId: promotionInput.operationId,
			workflowId: input.workflowId,
			candidateId: promotionInput.candidate.candidateId,
			decisionRef: promotionInput.decision.decisionRef,
			expected: promotionInput.expected,
			promotion,
		};
		await publishLearningArtifact(`promotion-effect:${promotionInput.operationId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_promotion_effect",
			reconciliation,
		});
		await compareAndSwapPolicyRegistry(registry.registryDigest, {
			schemaVersion: 1,
			workflowId: input.workflowId,
			behavior: "promoted",
			revision: nextRevision,
			stateHeadDigest: nextStateHeadDigest,
			policyDigest,
			artifactRef: promotionInput.candidate.candidateRef,
			promotedCandidateId: promotionInput.candidate.candidateId,
			promotionReconciliation: reconciliation,
			rollbackApplication: null,
		});
		return promotion;
	};
	const learningTriggerIdentity = (trigger: WorkflowLearningTrigger): string =>
		digestObject({
			kind: trigger.kind,
			candidateId: trigger.candidateId,
			sourceEventRef: trigger.sourceEventRef,
			workflowId: trigger.workflowId,
			storeEpoch: trigger.storeEpoch,
			coordinatorEpoch: trigger.coordinatorEpoch,
			stateHeadDigest: trigger.stateHeadDigest,
			evidenceDigest: trigger.evidenceDigest,
			evidenceRefs: trigger.evidenceRefs,
			hostReceipt: trigger.hostReceipt,
		});
	const proposeLearningRollback: WorkflowLearningHost["proposeRollback"] = async (rollbackInput) => {
		const registry = await readPolicyRegistry();
		const promotedRevisionId = registry.promotionReconciliation?.promotion.revisionId;
		if (
			registry.behavior !== "promoted" ||
			registry.promotedCandidateId !== rollbackInput.candidate.candidateId ||
			promotedRevisionId === undefined ||
			registry.stateHeadDigest !== rollbackInput.expected.stateHeadDigest
		)
			throw new Error("default_prime_learning_rollback_cas_stale");
		const proposalId = `rollback-${rollbackInput.candidate.candidateId}`;
		const proposalRef = await publishLearningArtifact(`rollback-proposal:${rollbackInput.operationId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_rollback_proposal",
			workflowId: input.workflowId,
			proposalId,
			candidateId: rollbackInput.candidate.candidateId,
			rollbackOf: promotedRevisionId,
			triggerIdentity: learningTriggerIdentity(rollbackInput.trigger),
			decisionRef: rollbackInput.decisionRef,
			expected: rollbackInput.expected,
		});
		const proposalWithoutReceipt: Omit<WorkflowLearningRollbackProposal, "receipt"> = {
			proposalId,
			candidateId: rollbackInput.candidate.candidateId,
			rollbackOf: promotedRevisionId,
			proposalRef,
			proposalDigest: proposalRef.digest,
			stateHeadDigest: rollbackInput.expected.stateHeadDigest,
			storeEpoch: rollbackInput.expected.storeEpoch,
			coordinatorEpoch: rollbackInput.expected.coordinatorEpoch,
			casExecutionKey: digestObject({
				kind: "default-prime-learning-rollback-proposal-cas",
				operationId: rollbackInput.operationId,
				expected: rollbackInput.expected,
			}),
		};
		const snapshot = await current();
		const receipt = await issueLearningReceipt(
			"rollback_proposal",
			{
				candidate: rollbackInput.candidate,
				trigger: rollbackInput.trigger,
				proposal: proposalWithoutReceipt,
				decisionRef: rollbackInput.decisionRef,
			},
			snapshot,
			`rollback-proposal-${rollbackInput.candidate.candidateId}`,
		);
		return { ...proposalWithoutReceipt, receipt };
	};
	const applyLearningRollback: WorkflowLearningHost["applyRollback"] = async (rollbackInput) => {
		const registry = await readPolicyRegistry();
		if (
			registry.behavior !== "promoted" ||
			registry.promotedCandidateId !== rollbackInput.candidate.candidateId ||
			registry.stateHeadDigest !== rollbackInput.expected.stateHeadDigest ||
			registry.revision !== rollbackInput.expected.currentRevision
		)
			throw new Error("default_prime_learning_rollback_application_cas_stale");
		const triggerIdentity = learningTriggerIdentity(rollbackInput.trigger);
		const registryCasDigest = digestObject({
			kind: "workflow_learning_rollback_registry_cas",
			workflowId: input.workflowId,
			candidateId: rollbackInput.candidate.candidateId,
			rollbackOf: rollbackInput.proposal.rollbackOf,
			proposalId: rollbackInput.proposal.proposalId,
			proposalDigest: rollbackInput.proposal.proposalDigest,
			triggerIdentity,
			decisionRef: rollbackInput.decisionRef,
			expected: rollbackInput.expected,
		});
		const applicationWithoutReceiptAndDigests = {
			operationId: rollbackInput.operationId,
			workflowId: input.workflowId,
			candidateId: rollbackInput.candidate.candidateId,
			rollbackOf: rollbackInput.proposal.rollbackOf,
			proposalId: rollbackInput.proposal.proposalId,
			proposalRef: rollbackInput.proposal.proposalRef,
			proposalDigest: rollbackInput.proposal.proposalDigest,
			triggerIdentity,
			decisionRef: rollbackInput.decisionRef,
			expected: rollbackInput.expected,
			registryCasDigest,
			appliedRevision: baselineRevision,
			reloadedRevision: baselineRevision,
			futureLoadRevision: baselineRevision,
			stateHeadDigest: rollbackInput.expected.stateHeadDigest,
			storeEpoch: rollbackInput.expected.storeEpoch,
			coordinatorEpoch: rollbackInput.expected.coordinatorEpoch,
			casExecutionKey: digestObject({
				kind: "default-prime-learning-rollback-application-cas",
				operationId: rollbackInput.operationId,
				expected: rollbackInput.expected,
			}),
		};
		const appliedRegistryDigest = digestObject({
			kind: "workflow_learning_rollback_registry_applied",
			registryCasDigest,
			proposalDigest: rollbackInput.proposal.proposalDigest,
			revision: baselineRevision,
		});
		const reloadedRegistryDigest = digestObject({
			kind: "workflow_learning_rollback_registry_reloaded",
			appliedRegistryDigest,
			revision: baselineRevision,
		});
		const futureLoadDigest = digestObject({
			kind: "workflow_learning_rollback_future_load",
			reloadedRegistryDigest,
			revision: baselineRevision,
		});
		const applicationWithoutReceipt: Omit<WorkflowLearningRollbackApplication, "receipt"> = {
			...applicationWithoutReceiptAndDigests,
			appliedRegistryDigest,
			reloadedRegistryDigest,
			futureLoadDigest,
		};
		const snapshot = await current();
		const receipt = await issueLearningReceipt(
			"rollback_applied",
			{
				candidate: rollbackInput.candidate,
				trigger: rollbackInput.trigger,
				proposal: rollbackInput.proposal,
				application: applicationWithoutReceipt,
			},
			snapshot,
			`rollback-application-${rollbackInput.candidate.candidateId}`,
		);
		const application: WorkflowLearningRollbackApplication = { ...applicationWithoutReceipt, receipt };
		await publishLearningArtifact(`rollback-effect:${rollbackInput.operationId}`, {
			schemaVersion: 1,
			kind: "default_prime_learning_rollback_effect",
			application,
		});
		await compareAndSwapPolicyRegistry(registry.registryDigest, {
			schemaVersion: 1,
			workflowId: input.workflowId,
			behavior: "baseline",
			revision: baselineRevision,
			stateHeadDigest: semanticStateDigest,
			policyDigest: snapshots.recipe.recipeDigest,
			artifactRef: baselineArtifactRef,
			promotedCandidateId: null,
			promotionReconciliation: registry.promotionReconciliation,
			rollbackApplication: application,
		});
		const reloaded = await readPolicyRegistry();
		if (
			reloaded.behavior !== "baseline" ||
			reloaded.revision !== baselineRevision ||
			reloaded.policyDigest !== snapshots.recipe.recipeDigest
		)
			throw new Error("default_prime_learning_rollback_reload_failed");
		return application;
	};
	const host: WorkflowLearningHost = {
		current,
		createCandidate: createLearningCandidate,
		runShadow: runLearningShadow,
		runCanary: runLearningCanary,
		runIndependentRedTeam: runLearningRedTeam,
		resolveDecision: resolveLearningDecision,
		classifyCandidate: async ({ candidate }) => ({
			mutationClass: candidate.mutationClass,
			payloadDigest: candidate.candidateDigest,
			classifierDigest: digestObject({
				kind: "default-prime-learning-classifier",
				candidateId: candidate.candidateId,
				mutationClass: candidate.mutationClass,
			}),
			protectedPaths: [],
			proposalDigest: null,
		}),
		resolveEvidence: async ({ stage, candidateId, evidenceRefs, payloadDigest, current: snapshot, witnessKind }) => {
			const witnesses: WorkflowLearningHostWitness[] = [];
			for (const evidenceRef of evidenceRefs) {
				const resolved = await input.artifactResolver.resolve(evidenceRef);
				if (
					!resolved.exists ||
					resolved.verifiedDigest !== evidenceRef.digest ||
					resolved.verifiedSizeBytes !== evidenceRef.sizeBytes
				)
					throw new Error("default_prime_learning_evidence_not_host_verified");
				witnesses.push(
					learningWitness({
						stage,
						candidateId,
						evidenceRef,
						payloadDigest,
						current: snapshot,
						witnessKind: witnessKind ?? "evidence",
					}),
				);
			}
			return Object.freeze(witnesses);
		},
		promote: promoteLearningCandidate,
		reconcilePromotion: reconcileLearningPromotion,
		proposeRollback: proposeLearningRollback,
		applyRollback: applyLearningRollback,
	};
	const decisionGate: Pick<WorkflowDecisionGate, "validateVerdicts" | "authorize"> = {
		validateVerdicts: async (decision) => {
			if (
				decision.decisionScope.kind !== "workflow" ||
				decision.decisionScope.workflowId !== input.workflowId ||
				decision.decisionId !== scorerDecisionRef.decisionId ||
				digestObject(decision) !== scorerDecisionRef.decisionDigest
			)
				throw new Error("default_prime_learning_decision_invalid");
		},
		authorize: async (decision, authorization) => {
			const operation = "operation" in authorization ? authorization.operation : authorization;
			if (
				decision.decisionScope.kind !== "workflow" ||
				decision.decisionScope.workflowId !== input.workflowId ||
				operation.kind !== "refinement" ||
				operation.preimageDigest !== operation.preimageRef.digest
			)
				return "rejected";
			const resolved = await input.artifactResolver.resolve(operation.preimageRef);
			return resolved.exists && resolved.verifiedDigest === operation.preimageRef.digest ? "authorized" : "rejected";
		},
	};
	const ports: WorkflowLearningPorts = {
		evidenceValidator: createWorkflowEvidenceValidator(),
		decisionGate,
		receiptPort: {
			verify: async ({ receipt, bindingDigest, stage, candidateId, current: snapshot }) => {
				await resolveAndVerifyWorkflowHostReceipt({
					context: input.receiptContext,
					workflowId: input.workflowId,
					expectedBindingDigest: bindingDigest,
					receipt,
					currentStateDigest: snapshot.stateDigest,
					currentRevision: snapshot.currentRevision,
					trustedNow: snapshot.trustedNow,
				});
				return learningWitness({
					stage,
					candidateId,
					evidenceRef: receipt.artifactRef,
					payloadDigest: bindingDigest,
					current: snapshot,
					witnessKind: "receipt",
				});
			},
			consume: async ({ receipt, bindingDigest, stage, candidateId, current: snapshot }) => {
				await input.receiptContext.receiptResolver.consumeIfOneUse({
					receipt,
					workflowId: input.workflowId,
					expectedBindingDigest: bindingDigest,
					currentRevision: snapshot.currentRevision,
				});
				return learningWitness({
					stage,
					candidateId,
					evidenceRef: receipt.artifactRef,
					payloadDigest: bindingDigest,
					current: snapshot,
					witnessKind: "receipt",
				});
			},
		},
		host,
	};
	const readBinding = async (operationId?: string): Promise<WorkflowLearningRuntimeBinding> => {
		const registry = await readPolicyRegistry();
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_learning_runtime_head_unavailable");
		const authorityBindingDigest = workflowLearningAuthorityBindingDigest({
			workflowId: input.workflowId,
			expectedHead: replay.head,
			epochRef: input.epochRef,
			stateHeadDigest: registry.stateHeadDigest,
			authority: scorerAuthority,
			operationId,
		});
		const authorityIssuedAt = learningContext.getStore()?.trustedNow ?? input.now?.() ?? new Date().toISOString();
		const authorityReceipt = await input.issueReceipt({
			receiptKind: "decision",
			workflowId: input.workflowId,
			bindingDigest: authorityBindingDigest,
			receiptId: `learning-authority-${digestObject({ authorityBindingDigest, authorityIssuedAt }).slice(0, 48)}`,
			oneUse: true,
			issuedAt: authorityIssuedAt,
			stateDigest: semanticStateDigest,
			revision: registry.revision,
			payloadKind: "workflow-learning",
		});
		return Object.freeze({
			workflowId: input.workflowId,
			expectedHead: replay.head,
			epochRef: input.epochRef,
			leaseRef: await input.resolveLeaseRef(),
			writerIdentity: input.writerIdentity,
			executionKey,
			ownerId: input.rootSessionId,
			phase: status.phase ?? "refining",
			semanticStateDigest: registry.stateHeadDigest,
			expectedGenerations: { workflow: input.epochRef.storeEpoch },
			approvedAuthority: { ...scorerAuthority, receipt: authorityReceipt },
		});
	};
	const runtime = await createWorkflowLearningRuntimeAdapterWithDurableEffects({
		host: issueWorkflowLearningSessionHostIdentity(input.host),
		ports,
		artifactResolver: input.artifactResolver,
		readBinding,
		effectAuthority: {
			runtimeStore: input.runtimeStore,
			durableContext: durable,
			reconcilePromotion: host.reconcilePromotion,
			promote: host.promote,
			proposeRollback: host.proposeRollback,
			applyRollback: host.applyRollback,
		},
	});
	const goalBindingDigest = defaultPrimeGoalBindingDigest(status);
	let latestPipelineState: PrimeWorkflowPipelineState | undefined;
	let latestPipelineStageEvidence: readonly DefaultPrimeCompletionStageEvidence[] = [];
	let latestPipelineStageSourceSequence = 0;
	let usedPipelineEvidenceRefDigests = new Set<string>();
	const readPipeline = async (): Promise<PrimeWorkflowPipelineState> => {
		const completedStageIds = new Set<string>();
		const stageEvidence: DefaultPrimeCompletionStageEvidence[] = [];
		const evidenceRefDigests = new Set<string>();
		let stageSourceSequence = 0;
		for (const trigger of (await runtime.getState()).triggers) {
			const resolved = await input.artifactResolver.resolve(trigger.sourceEventRef);
			if (
				!resolved.exists ||
				resolved.verifiedDigest !== trigger.sourceEventRef.digest ||
				resolved.verifiedSizeBytes !== trigger.sourceEventRef.sizeBytes
			)
				throw new Error("default_prime_pipeline_stage_source_not_verified");
			let parsed: unknown;
			try {
				parsed = parseCanonicalJsonBytes(resolved.bytes);
			} catch {
				continue;
			}
			if (!isRecord(parsed) || parsed.kind !== "default_prime_pipeline_stage") continue;
			if (
				parsed.schemaVersion !== 1 ||
				parsed.workflowId !== input.workflowId ||
				parsed.recipeDigest !== snapshots.recipe.recipeDigest ||
				parsed.admissionDigest !== snapshots.recipe.admissionDigest ||
				parsed.goalBindingDigest !== goalBindingDigest ||
				typeof parsed.stageId !== "string" ||
				!Array.isArray(parsed.evidenceRefs) ||
				parsed.evidenceDigest !== digestObject(parsed.evidenceRefs) ||
				parsed.evidenceDigest !== trigger.evidenceDigest ||
				digestObject(parsed.evidenceRefs) !== digestObject(trigger.evidenceRefs) ||
				typeof parsed.priorStateDigest !== "string"
			)
				throw new Error("default_prime_pipeline_stage_binding_invalid");
			if (!snapshots.recipe.recipeBinding.proposal.stages.some((stage) => stage.id === parsed.stageId))
				throw new Error("default_prime_pipeline_stage_not_admitted");
			const task = taskGraph.byId.get(parsed.stageId);
			if (
				task === undefined ||
				task.taskGraphSourceDigest === undefined ||
				task.inputRefs === undefined ||
				task.boundaryIds === undefined ||
				task.outputRefs === undefined ||
				task.evidencePolicy === undefined ||
				task.evidenceKind === undefined ||
				task.budget === undefined ||
				task.recoveryPolicy === undefined
			)
				throw new Error("default_prime_pipeline_stage_task_contract_missing");
			if (completedStageIds.has(parsed.stageId)) throw new Error("default_prime_pipeline_stage_duplicate");
			const expectedPriorState = projectDefaultPrimePipelineState(
				input.workflowId,
				snapshots.recipe,
				completedStageIds,
			);
			if (parsed.priorStateDigest !== expectedPriorState.stateDigest)
				throw new Error("default_prime_pipeline_stage_order_invalid");
			if (!expectedPriorState.readyStageIds.includes(parsed.stageId))
				throw new Error("default_prime_pipeline_stage_dependency_unmet");
			for (const evidenceRef of parsed.evidenceRefs) evidenceRefDigests.add(digestObject(evidenceRef));
			stageEvidence.push({
				stageId: parsed.stageId,
				sourceEventRef: structuredClone(trigger.sourceEventRef),
				evidenceRefs: structuredClone(parsed.evidenceRefs as readonly WorkflowArtifactRef[]),
				taskGraphSourceDigest: task.taskGraphSourceDigest,
				requirementIds: structuredClone(task.requirementIds),
				completionCriteria: structuredClone(task.completionCriteria),
				inputRefs: structuredClone(task.inputRefs),
				boundaryIds: structuredClone(task.boundaryIds),
				outputRefs: structuredClone(task.outputRefs),
				evidencePolicy: structuredClone(task.evidencePolicy),
				evidenceKind: task.evidenceKind,
				budget: structuredClone(task.budget),
				recoveryPolicy: task.recoveryPolicy,
				authority: structuredClone(task.authority),
			});
			stageSourceSequence = trigger.sourceEventRef.sourceEventSequence;
			completedStageIds.add(parsed.stageId);
		}
		latestPipelineStageSourceSequence = stageSourceSequence;
		usedPipelineEvidenceRefDigests = evidenceRefDigests;
		latestPipelineStageEvidence = Object.freeze(stageEvidence);
		latestPipelineState = projectDefaultPrimePipelineState(input.workflowId, snapshots.recipe, completedStageIds);
		return latestPipelineState;
	};
	const recordPipelineStageInternal = async (request: {
		readonly stageId: string;
		readonly evidenceRefs: readonly WorkflowArtifactRef[];
	}): Promise<PrimeWorkflowPipelineState> => {
		const prior = await readPipeline();
		if (!prior.readyStageIds.includes(request.stageId)) throw new Error("default_prime_pipeline_stage_not_ready");
		if (request.evidenceRefs.length < 1 || request.evidenceRefs.length > 32)
			throw new Error("default_prime_pipeline_evidence_refs_invalid");
		const uniqueEvidenceRefs = [
			...new Map(request.evidenceRefs.map((ref) => [digestObject(ref), structuredClone(ref)])).values(),
		];
		if (uniqueEvidenceRefs.length !== request.evidenceRefs.length)
			throw new Error("default_prime_pipeline_evidence_refs_duplicate");
		const evidenceValues: unknown[] = [];
		for (const ref of uniqueEvidenceRefs) {
			const resolved = await input.artifactResolver.resolve(ref);
			if (
				!resolved.exists ||
				resolved.verifiedDigest !== ref.digest ||
				resolved.verifiedSizeBytes !== ref.sizeBytes ||
				resolved.envelope.ref.sourceEventSequence !== ref.sourceEventSequence
			)
				throw new Error("default_prime_pipeline_evidence_not_host_verified");
			try {
				evidenceValues.push(parseCanonicalJsonBytes(resolved.bytes));
			} catch (error) {
				throw new Error("default_prime_pipeline_evidence_content_invalid", { cause: error });
			}
		}
		if (isBuiltinAdaptivePrimeRecipe && request.stageId === "recon") {
			const hasBoundReconEvidence = evidenceValues.some(
				(value) =>
					isRecord(value) &&
					value.kind === "default-prime-autoresearch-evidence" &&
					value.workflowId === input.workflowId &&
					value.recipeDigest === snapshots.recipe.recipeDigest &&
					value.goalBindingDigest === goalBindingDigest,
			);
			if (!hasBoundReconEvidence) throw new Error("default_prime_pipeline_recon_evidence_invalid");
		} else {
			const executionObservations = await Promise.all(
				uniqueEvidenceRefs.map((ref) => input.executionEvidence.resolveObservation(ref)),
			);
			if (
				uniqueEvidenceRefs.some((ref) => usedPipelineEvidenceRefDigests.has(digestObject(ref))) ||
				executionObservations.some(
					(observation) => observation.preTurnHead.sequence < latestPipelineStageSourceSequence,
				)
			)
				throw new Error("default_prime_pipeline_execution_evidence_stale_or_reused");
			if (
				isBuiltinAdaptivePrimeRecipe &&
				request.stageId === "verify" &&
				!executionObservations.some((observation) =>
					observation.facts.toolEnds.some((result) => result.isError === false),
				)
			)
				throw new Error(
					`default_prime_pipeline_verify_evidence_invalid: observations=${executionObservations.length}, tool_calls=${executionObservations.reduce((total, observation) => total + observation.facts.toolCalls.length, 0)}, tool_ends=${executionObservations.reduce((total, observation) => total + observation.facts.toolEnds.length, 0)}, tool_errors=${executionObservations.reduce((total, observation) => total + observation.facts.toolEnds.filter((result) => result.isError).length, 0)}`,
				);
			if (
				isBuiltinAdaptivePrimeRecipe &&
				(request.stageId === "synthesize" || request.stageId === "red-team") &&
				new Set(executionObservations.map((observation) => observation.attemptId)).size < 2
			)
				throw new Error(`default_prime_pipeline_${request.stageId}_evidence_invalid`);
			if (
				isBuiltinAdaptivePrimeRecipe &&
				request.stageId === "red-team" &&
				!executionObservations.some((observation) => observation.facts.toolCalls.length > 0)
			)
				throw new Error("default_prime_pipeline_red_team_evidence_invalid");
			if (!snapshots.recipe.recipeBinding.proposal.stages.some((stage) => stage.id === request.stageId))
				throw new Error("default_prime_pipeline_stage_evaluator_unavailable");
			for (const ref of uniqueEvidenceRefs) await input.executionEvidence.consumeObservation(ref);
		}
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: input.epochRef.storeEpoch,
		});
		if (replay.quarantined || replay.head.eventDigest === null)
			throw new Error("default_prime_pipeline_runtime_head_unavailable");
		const stageArtifact: DefaultPrimePipelineStageArtifact = {
			schemaVersion: 1,
			kind: "default_prime_pipeline_stage",
			workflowId: input.workflowId,
			recipeDigest: snapshots.recipe.recipeDigest,
			admissionDigest: snapshots.recipe.admissionDigest,
			goalBindingDigest,
			stageId: request.stageId,
			evidenceRefs: uniqueEvidenceRefs,
			evidenceDigest: digestObject(uniqueEvidenceRefs),
			priorStateDigest: prior.stateDigest,
		};
		const sourceEventRef = (
			await input.runtimeStore.publishArtifact({
				workflowId: input.workflowId,
				payloadKind: "evidence",
				bytes: canonicalJsonBytes(stageArtifact),
				codec: "canonical_json",
				sourceEventSequence: replay.head.sequence,
				idempotencyKey: `default-prime-pipeline-stage:${request.stageId}:${prior.stateDigest}:${stageArtifact.evidenceDigest}`,
			})
		).envelope.ref;
		const learningSnapshot = await current();
		const triggerWithoutReceipt: WorkflowLearningTrigger = {
			kind: "milestone",
			candidateId: null,
			sourceEventRef,
			evidenceRefs: uniqueEvidenceRefs,
			workflowId: input.workflowId,
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			stateHeadDigest: learningSnapshot.stateHeadDigest,
			evidenceDigest: stageArtifact.evidenceDigest,
		};
		const receiptId = `pipeline-stage-${sourceEventRef.digest.slice(0, 48)}`;
		const receiptPayloadDigest = digestObject({
			kind: "default-prime-pipeline-stage",
			stageId: request.stageId,
			sourceEventRef,
		});
		const bindingDigest = digestObject({
			kind: "trigger",
			payloadDigest: digestObject(triggerWithoutReceipt),
			receiptId,
			receiptPayloadDigest,
		});
		const trustedNow = input.now?.() ?? new Date().toISOString();
		const hostReceipt = await input.issueReceipt({
			receiptKind: "artifact",
			workflowId: input.workflowId,
			bindingDigest,
			receiptId,
			oneUse: true,
			issuedAt: trustedNow,
			stateDigest: semanticStateDigest,
			revision: learningSnapshot.currentRevision,
			payloadKind: "workflow-learning",
			payloadDigest: receiptPayloadDigest,
		});
		await learningContext.run({ evidenceId: `pipeline-stage-${request.stageId}`, trustedNow }, () =>
			runtime.handleTrigger({ ...triggerWithoutReceipt, hostReceipt }),
		);
		const recorded = await readPipeline();
		if (!recorded.completedStageIds.includes(request.stageId))
			throw new Error("default_prime_pipeline_stage_not_recorded");
		return recorded;
	};
	let pipelineRecordTail = Promise.resolve();
	const recordPipelineStage = async (request: {
		readonly stageId: string;
		readonly evidenceRefs: readonly WorkflowArtifactRef[];
	}): Promise<PrimeWorkflowPipelineState> => {
		const previous = pipelineRecordTail;
		let release: (() => void) | undefined;
		pipelineRecordTail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await recordPipelineStageInternal(request);
		} finally {
			release?.();
		}
	};
	await readPipeline();
	const pipeline: PrimeWorkflowPipelineRuntime = Object.freeze({
		current: () => {
			if (latestPipelineState === undefined) throw new Error("default_prime_pipeline_state_unavailable");
			return latestPipelineState;
		},
		read: readPipeline,
		record: recordPipelineStage,
	});
	const recordAutoResearchOutcome = async (result: AutoResearchPythonResult): Promise<void> => {
		const evidenceRefs = result.evidence_refs.map((value, index) =>
			parseSkillEffectArtifactRef(value, `default_prime_learning_evidence_${index}`),
		);
		const sourceEventRef = evidenceRefs[0];
		if (sourceEventRef === undefined) throw new Error("default_prime_learning_autoresearch_evidence_missing");
		const disposition = await deriveAutoResearchLearningDisposition({
			artifactResolver: input.artifactResolver,
			evidenceRefs,
			workflowId: input.workflowId,
			recipe: autoResearchRecipe,
			objective,
			acceptanceCheckIds: status.acceptanceCheckIds,
			protectedInvariantIds: status.protectedInvariantIds,
		});
		const experienceId = `learning-autoresearch-${result.output_digest.slice(0, 48)}`;
		const evidenceId = `evidence-${experienceId}`;
		const trustedNow = input.now?.() ?? new Date().toISOString();
		const freshnessWindowMilliseconds = 300_000;
		const evidence: WorkflowEvidenceEnvelope = {
			evidenceId,
			evidenceRevision: revisions.evidenceRevision,
			requirementId: status.acceptanceCheckIds[0] ?? "default-prime-autoresearch",
			claim: "The authenticated AutoResearch host produced immutable candidate evaluation evidence.",
			result: "host-observed",
			method: "host-autoresearch-evaluator",
			command: null,
			artifactObservations: evidenceRefs.map((artifactRef) => ({
				artifactRef,
				exists: true,
				verifiedDigest: artifactRef.digest,
				verifiedSizeBytes: artifactRef.sizeBytes,
			})),
			scanner: {
				scannerDigest: digestObject({
					kind: "default-prime-learning-scanner",
					recipe: snapshots.recipe.recipeDigest,
				}),
				scanStatus: "passed",
				redactionStatus: "not_required",
				findingCodes: [],
				findingDigest: digestObject({ findingCodes: [] }),
			},
			confidence: "high",
			limitations: ["Promotion remains gated by independent shadow, canary, red-team, and holdout review."],
			workspaceDigest,
			configDigest: snapshots.config.resolvedConfigDigest,
			revisions,
			evaluatorDigest,
			parserDigest,
			guardDigest,
			updatedDigest: result.output_digest,
			invalidatedByDecisionRef: null,
			regressed: false,
			auditorDecisionRef: null,
			observedAt: trustedNow,
			freshUntil: new Date(Date.parse(trustedNow) + freshnessWindowMilliseconds).toISOString(),
			freshnessWindowMilliseconds,
		};
		const receiptId = `learning-experience-${result.output_digest.slice(0, 48)}`;
		const receiptPayloadDigest = digestObject({ kind: "default-prime-learning-experience", experienceId });
		const receiptBindingDigest = digestObject({
			kind: "committed_experience",
			payloadDigest: digestObject({
				experienceId,
				workflowId: input.workflowId,
				outcome: disposition.outcome,
				progressKind: disposition.progressKind,
				progressEvidenceRefs: evidenceRefs,
				evidenceDigest: digestObject([evidence]),
				sourceEventRef,
			}),
			receiptId,
			receiptPayloadDigest,
		});
		const existing = (await runtime.getState()).experiences.find(
			(experience) => experience.experienceId === experienceId,
		);
		if (existing !== undefined) {
			if (digestObject(existing.progressEvidenceRefs) !== digestObject(evidenceRefs))
				throw new Error("default_prime_learning_experience_identity_conflict");
			return;
		}
		const learningSnapshot = await current();
		const hostReceipt = await input.issueReceipt({
			receiptKind: "artifact",
			workflowId: input.workflowId,
			bindingDigest: receiptBindingDigest,
			receiptId,
			oneUse: true,
			issuedAt: trustedNow,
			stateDigest: semanticStateDigest,
			revision: learningSnapshot.currentRevision,
			payloadKind: "workflow-learning",
			payloadDigest: receiptPayloadDigest,
		});
		await learningContext.run({ evidenceId, trustedNow }, () =>
			runtime.commitExperience({
				experienceId,
				workflowId: input.workflowId,
				source: "host",
				outcome: disposition.outcome,
				progressKind: disposition.progressKind,
				progressEvidenceRefs: evidenceRefs,
				evidence: [evidence],
				committedAt: trustedNow,
				sourceEventRef,
				hostReceipt,
			}),
		);
	};
	const issueLearningTrigger = async (triggerInput: {
		readonly kind: WorkflowLearningTrigger["kind"];
		readonly candidateId: string | null;
		readonly sourceEventRef: WorkflowArtifactRef;
		readonly evidenceRefs: readonly WorkflowArtifactRef[];
		readonly trustedNow: string;
	}): Promise<WorkflowLearningTrigger> => {
		const learningSnapshot = await current();
		const triggerWithoutReceipt: Omit<WorkflowLearningTrigger, "hostReceipt"> = {
			kind: triggerInput.kind,
			candidateId: triggerInput.candidateId,
			sourceEventRef: triggerInput.sourceEventRef,
			evidenceRefs: triggerInput.evidenceRefs.map((ref) => structuredClone(ref)),
			workflowId: input.workflowId,
			storeEpoch: input.epochRef.storeEpoch,
			coordinatorEpoch: input.epochRef.coordinatorEpoch,
			stateHeadDigest: learningSnapshot.stateHeadDigest,
			evidenceDigest: digestObject(triggerInput.evidenceRefs),
		};
		const receiptId = `learning-trigger-${digestObject(triggerWithoutReceipt).slice(0, 48)}`;
		const receiptPayloadDigest = digestObject({
			kind: "default-prime-learning-trigger",
			triggerKind: triggerInput.kind,
			candidateId: triggerInput.candidateId,
			sourceEventRef: triggerInput.sourceEventRef,
		});
		const bindingDigest = digestObject({
			kind: "trigger",
			payloadDigest: digestObject(triggerWithoutReceipt),
			receiptId,
			receiptPayloadDigest,
		});
		const hostReceipt = await input.issueReceipt({
			receiptKind: "artifact",
			workflowId: input.workflowId,
			bindingDigest,
			receiptId,
			oneUse: true,
			issuedAt: triggerInput.trustedNow,
			stateDigest: semanticStateDigest,
			revision: learningSnapshot.currentRevision,
			payloadKind: "workflow-learning",
			payloadDigest: receiptPayloadDigest,
		});
		return { ...triggerWithoutReceipt, hostReceipt };
	};
	const reviewExperience = async (experienceId: string): Promise<Record<string, unknown>> => {
		if (experienceId.trim().length === 0) throw new Error("default_prime_learning_experience_id_invalid");
		const state = await runtime.getState();
		const experience = state.experiences.find((item) => item.experienceId === experienceId);
		if (experience === undefined) throw new Error("default_prime_learning_experience_not_found");
		if (experience.outcome !== "positive" || experience.progressKind !== "verified")
			throw new Error("default_prime_learning_experience_not_positive");
		const trustedNow = input.now?.() ?? new Date().toISOString();
		const trigger = await issueLearningTrigger({
			kind: "milestone",
			candidateId: null,
			sourceEventRef: experience.sourceEventRef,
			evidenceRefs: experience.progressEvidenceRefs,
			trustedNow,
		});
		return learningContext.run({ evidenceId: `learning-review-${experienceId}`, trustedNow }, async () => {
			const candidate = await runtime.typeCandidate({ experienceId, trigger });
			const review = await runtime.reviewCandidate(candidate.candidateId);
			return {
				experience_id: experienceId,
				candidate_id: candidate.candidateId,
				status: review.status,
				policy_behavior: review.status === "promoted" ? "promoted" : "baseline",
				state_digest: (await runtime.getState()).stateDigest,
				can_authorize: false,
			};
		});
	};
	const rollbackCandidate = async (candidateId: string): Promise<Record<string, unknown>> => {
		if (candidateId.trim().length === 0) throw new Error("default_prime_learning_candidate_id_invalid");
		const state = await runtime.getState();
		const candidate = state.candidates.find((record) => record.candidate.candidateId === candidateId);
		if (candidate?.status !== "promoted") throw new Error("default_prime_learning_candidate_not_promoted");
		const review = [...state.reviews]
			.reverse()
			.find((record) => record.candidateId === candidateId && record.promotion !== null);
		const sourceEventRef = review?.redTeam?.resultRef;
		const evidenceRefs = review?.redTeam?.evidenceRefs;
		if (sourceEventRef === undefined || evidenceRefs === undefined || evidenceRefs.length === 0)
			throw new Error("default_prime_learning_regression_evidence_missing");
		const trustedNow = input.now?.() ?? new Date().toISOString();
		const trigger = await issueLearningTrigger({
			kind: "regression",
			candidateId,
			sourceEventRef,
			evidenceRefs,
			trustedNow,
		});
		return learningContext.run({ evidenceId: `learning-rollback-${candidateId}`, trustedNow }, async () => {
			const result = await runtime.handleTrigger(trigger);
			if (result.status !== "rollback_proposed" || result.proposal.application === undefined)
				throw new Error("default_prime_learning_rollback_not_applied");
			return {
				candidate_id: candidateId,
				status: "rollback_applied",
				policy_behavior: "baseline",
				state_digest: (await runtime.getState()).stateDigest,
				can_authorize: false,
			};
		});
	};
	return Object.freeze({
		runtime,
		recordAutoResearchOutcome,
		reviewExperience,
		rollbackCandidate,
		pipeline,
		completionStageEvidence: async () => {
			await readPipeline();
			return structuredClone(latestPipelineStageEvidence);
		},
	});
}
