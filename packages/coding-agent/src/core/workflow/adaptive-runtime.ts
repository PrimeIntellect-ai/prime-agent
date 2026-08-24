import type {
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowEpochRef,
	WorkflowRuntimeStore,
} from "./contracts.js";
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from "./contracts.js";
import type { PrimeWorkflowPipelineState } from "./prime-loop.js";
import type { WorkflowRecipeAdmissionArtifact } from "./recipes.js";
import type { PersistedSessionWorkflowHost } from "./session-host-factory.js";
import type { WorkflowTaskGraph } from "./task-graph.js";

const ADAPTIVE_RUNTIME_SCHEMA_VERSION = 1 as const;
const ADAPTIVE_RUNTIME_RECORD = "prime-adaptive-runtime-state-v1";
const ALTERNATE_RECIPE_ID = "builtin:attack-architect-judge-unify-edge-test";
const PERIODIC_REVIEW_CADENCE_MILLISECONDS = 300_000;
const issuedAdaptiveAuthorities = new WeakSet<PrimeAdaptiveRuntimeHostAuthority>();

/** Opaque authority binding the adaptive runtime to one persisted host and store. */
export class PrimeAdaptiveRuntimeHostAuthority {
	private constructor(
		private readonly boundHost: PersistedSessionWorkflowHost,
		private readonly boundStore: WorkflowRuntimeStore,
	) {}

	public static issue(host: PersistedSessionWorkflowHost): PrimeAdaptiveRuntimeHostAuthority {
		if (
			typeof host !== "object" ||
			host === null ||
			host.runtimeStore.durableContext === undefined ||
			typeof host.ensurePrimeWorkflow !== "function" ||
			typeof host.recoverBeforeResume !== "function"
		)
			throw new Error("prime_adaptive_host_authority_required");
		return new PrimeAdaptiveRuntimeHostAuthority(host, host.runtimeStore);
	}

	public assertBound(host: PersistedSessionWorkflowHost, store: WorkflowRuntimeStore): void {
		if (!issuedAdaptiveAuthorities.has(this) || this.boundHost !== host || this.boundStore !== store)
			throw new Error("prime_adaptive_host_authority_mismatch");
	}
}

/**
 * Issue the adaptive authority for the exact persisted session host.
 *
 * Args:
 * host: Opened host that owns the durable workflow store.
 * Return: Opaque authority accepted only with the same host and store identities.
 */
export function issuePrimeAdaptiveRuntimeHostAuthority(
	host: PersistedSessionWorkflowHost,
): PrimeAdaptiveRuntimeHostAuthority {
	const authority = PrimeAdaptiveRuntimeHostAuthority.issue(host);
	issuedAdaptiveAuthorities.add(authority);
	return authority;
}

export interface PrimeAdaptiveRuntimeState {
	readonly schemaVersion: 1;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly graphDigest: string;
	readonly recipeId: string;
	readonly pipelineStateDigest: string;
	readonly completedStageIds: readonly string[];
	readonly criticalPathStageIds: readonly string[];
	readonly reviewCount: number;
	readonly periodicReviewCount: number;
	readonly lastPeriodicReviewAt: string | null;
	readonly nextPeriodicReviewAt: string;
	readonly recommendedRecipeId: string;
	readonly recommendedParallelism: number;
	readonly recommendationReason: string;
	readonly latestReviewRef: WorkflowArtifactRef | null;
	readonly sourceJournalSequence: number;
	readonly sourceJournalDigest: string;
	readonly canAuthorize: false;
	readonly stateDigest: string;
}

export interface PrimeAdaptiveRuntime {
	readonly current: () => PrimeAdaptiveRuntimeState;
	readonly read: () => Promise<PrimeAdaptiveRuntimeState>;
	readonly recover: (pipeline: PrimeWorkflowPipelineState) => Promise<PrimeAdaptiveRuntimeState>;
	readonly onPipelineCommitted: (pipeline: PrimeWorkflowPipelineState) => Promise<PrimeAdaptiveRuntimeState>;
	readonly reviewIfDue: () => Promise<PrimeAdaptiveRuntimeState>;
	readonly plannerDirective: () => string;
}

export interface PrimeAdaptiveRuntimeInput {
	readonly host: PersistedSessionWorkflowHost;
	readonly hostAuthority: PrimeAdaptiveRuntimeHostAuthority;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly graph: WorkflowTaskGraph;
	readonly admission: WorkflowRecipeAdmissionArtifact;
	readonly approvedParallelism: number;
	readonly now: () => string;
}

interface PrimeAdaptiveReviewArtifact {
	readonly schemaVersion: 1;
	readonly kind: "prime_adaptive_efficiency_review";
	readonly workflowId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly graphDigest: string;
	readonly recipeId: string;
	readonly sourcePipelineStateDigest: string;
	readonly triggerKind: "pipeline_transition" | "scheduled_window";
	readonly priorStateDigest: string;
	readonly completedStageIds: readonly string[];
	readonly criticalPathStageIds: readonly string[];
	readonly recommendedRecipeId: string;
	readonly recommendedParallelism: number;
	readonly findingCodes: readonly string[];
	readonly reviewedAt: string;
	readonly writeAuthority: false;
	readonly allocationAuthority: false;
	readonly approvalAuthority: false;
	readonly completionAuthority: false;
	readonly reviewDigest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function stateWithoutDigest(
	state: Omit<PrimeAdaptiveRuntimeState, "stateDigest">,
): Omit<PrimeAdaptiveRuntimeState, "stateDigest"> {
	return state;
}

function withStateDigest(state: Omit<PrimeAdaptiveRuntimeState, "stateDigest">): PrimeAdaptiveRuntimeState {
	return Object.freeze({ ...state, stateDigest: digestObject(stateWithoutDigest(state)) });
}

function stageOrder(graph: WorkflowTaskGraph): readonly string[] {
	const remaining = new Map(graph.tasks.map((task) => [task.taskId, task]));
	const ordered: string[] = [];
	while (remaining.size > 0) {
		const ready = [...remaining.values()]
			.filter((task) => task.dependencyTaskIds.every((dependency) => ordered.includes(dependency)))
			.sort((left, right) => left.taskId.localeCompare(right.taskId));
		if (ready.length === 0) throw new Error("prime_adaptive_task_graph_cycle");
		for (const task of ready) {
			ordered.push(task.taskId);
			remaining.delete(task.taskId);
		}
	}
	return Object.freeze(ordered);
}

function assertPipelineBinding(
	pipeline: PrimeWorkflowPipelineState,
	input: PrimeAdaptiveRuntimeInput,
	orderedStages: readonly string[],
): void {
	if (pipeline.workflowId !== input.workflowId || pipeline.recipeDigest !== input.admission.recipeDigest)
		throw new Error("prime_adaptive_pipeline_binding_invalid");
	if (
		pipeline.completedStageIds.some((stageId, index) => orderedStages[index] !== stageId) ||
		pipeline.completedStageIds.length > orderedStages.length
	)
		throw new Error("prime_adaptive_pipeline_order_invalid");
	const expectedReady = orderedStages.slice(pipeline.completedStageIds.length, pipeline.completedStageIds.length + 1);
	if (digestObject(pipeline.readyStageIds) !== digestObject(expectedReady))
		throw new Error("prime_adaptive_pipeline_ready_set_invalid");
}

function assertStateShape(value: unknown, input: PrimeAdaptiveRuntimeInput): PrimeAdaptiveRuntimeState {
	if (!isRecord(value)) throw new Error("prime_adaptive_state_invalid");
	const state = value as unknown as PrimeAdaptiveRuntimeState;
	const { stateDigest, ...withoutDigest } = state;
	if (
		state.schemaVersion !== ADAPTIVE_RUNTIME_SCHEMA_VERSION ||
		state.workflowId !== input.workflowId ||
		!sameEpoch(state.epochRef, input.epochRef) ||
		state.graphDigest !== input.graph.graphDigest ||
		state.recipeId !== input.admission.recipeId ||
		typeof state.pipelineStateDigest !== "string" ||
		!Array.isArray(state.completedStageIds) ||
		!Array.isArray(state.criticalPathStageIds) ||
		!Number.isSafeInteger(state.reviewCount) ||
		state.reviewCount < 0 ||
		!Number.isSafeInteger(state.periodicReviewCount) ||
		state.periodicReviewCount < 0 ||
		(state.lastPeriodicReviewAt !== null && !Number.isFinite(Date.parse(state.lastPeriodicReviewAt))) ||
		!Number.isFinite(Date.parse(state.nextPeriodicReviewAt)) ||
		typeof state.recommendedRecipeId !== "string" ||
		!Number.isSafeInteger(state.recommendedParallelism) ||
		state.recommendedParallelism < 1 ||
		typeof state.recommendationReason !== "string" ||
		!Number.isSafeInteger(state.sourceJournalSequence) ||
		state.sourceJournalSequence < 0 ||
		typeof state.sourceJournalDigest !== "string" ||
		state.canAuthorize !== false ||
		typeof stateDigest !== "string" ||
		stateDigest !== digestObject(withoutDigest)
	)
		throw new Error("prime_adaptive_state_invalid");
	return Object.freeze(structuredClone(state));
}

function recommendedParallelism(
	graph: WorkflowTaskGraph,
	completedStageIds: readonly string[],
	approvedParallelism: number,
): number {
	const completed = new Set(completedStageIds);
	const readyCount = graph.tasks.filter(
		(task) => !completed.has(task.taskId) && task.dependencyTaskIds.every((dependency) => completed.has(dependency)),
	).length;
	return Math.max(1, Math.min(approvedParallelism, Math.max(1, readyCount)));
}

function recommendationReason(completedStageIds: readonly string[], orderedStages: readonly string[]): string {
	return completedStageIds.length === orderedStages.length
		? "The admitted pipeline is exhausted; propose the independent attack workflow for the next refinement revision."
		: "Keep the remaining authenticated critical path moving; parallelize only dependency-independent ready stages.";
}

function initialState(
	input: PrimeAdaptiveRuntimeInput,
	pipeline: PrimeWorkflowPipelineState,
	orderedStages: readonly string[],
): PrimeAdaptiveRuntimeState {
	const initializedAt = input.now();
	if (!Number.isFinite(Date.parse(initializedAt))) throw new Error("prime_adaptive_clock_invalid");
	return withStateDigest({
		schemaVersion: ADAPTIVE_RUNTIME_SCHEMA_VERSION,
		workflowId: input.workflowId,
		epochRef: { ...input.epochRef },
		graphDigest: input.graph.graphDigest,
		recipeId: input.admission.recipeId,
		pipelineStateDigest: pipeline.stateDigest,
		completedStageIds: [...pipeline.completedStageIds],
		criticalPathStageIds: orderedStages.slice(pipeline.completedStageIds.length),
		reviewCount: pipeline.completedStageIds.length,
		periodicReviewCount: 0,
		lastPeriodicReviewAt: null,
		nextPeriodicReviewAt: new Date(Date.parse(initializedAt) + PERIODIC_REVIEW_CADENCE_MILLISECONDS).toISOString(),
		recommendedRecipeId:
			pipeline.completedStageIds.length === orderedStages.length ? ALTERNATE_RECIPE_ID : input.admission.recipeId,
		recommendedParallelism: recommendedParallelism(
			input.graph,
			pipeline.completedStageIds,
			input.approvedParallelism,
		),
		recommendationReason: recommendationReason(pipeline.completedStageIds, orderedStages),
		latestReviewRef: null,
		sourceJournalSequence: 0,
		sourceJournalDigest: "",
		canAuthorize: false,
	});
}

/**
 * Create the host-owned adaptive planner and efficiency-review projection.
 *
 * Args:
 * input: Authenticated store, admitted graph, approval ceiling, and artifact authority.
 * Return: Durable non-authoritative recommendations bound to verified pipeline transitions.
 */
export function createPrimeAdaptiveRuntime(input: PrimeAdaptiveRuntimeInput): PrimeAdaptiveRuntime {
	input.hostAuthority.assertBound(input.host, input.runtimeStore);
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("prime_adaptive_durable_runtime_required");
	if (input.graph.graphDigest !== input.admission.baseTaskGraphDigest)
		throw new Error("prime_adaptive_graph_admission_mismatch");
	if (!Number.isSafeInteger(input.approvedParallelism) || input.approvedParallelism < 1)
		throw new Error("prime_adaptive_parallelism_invalid");
	const orderedStages = stageOrder(input.graph);
	let currentState: PrimeAdaptiveRuntimeState | undefined;

	const readPersisted = async (): Promise<PrimeAdaptiveRuntimeState | null> => {
		const bytes = await durable.auxiliaryStore.read(ADAPTIVE_RUNTIME_RECORD);
		if (bytes === null) return null;
		const state = assertStateShape(parseCanonicalJsonBytes(bytes), input);
		if (state.latestReviewRef !== null) {
			const resolved = await input.artifactResolver.resolve(state.latestReviewRef);
			if (
				!resolved.exists ||
				resolved.verifiedDigest !== state.latestReviewRef.digest ||
				resolved.verifiedSizeBytes !== state.latestReviewRef.sizeBytes
			)
				throw new Error("prime_adaptive_review_artifact_invalid");
		}
		return state;
	};

	const persist = async (state: PrimeAdaptiveRuntimeState): Promise<void> => {
		await durable.auxiliaryStore.write(ADAPTIVE_RUNTIME_RECORD, canonicalJsonBytes(state));
		currentState = state;
	};

	const reconcile = async (pipeline: PrimeWorkflowPipelineState): Promise<PrimeAdaptiveRuntimeState> =>
		durable.withExclusiveLease(`prime-adaptive-runtime:${input.workflowId}`, async () => {
			assertPipelineBinding(pipeline, input, orderedStages);
			const persisted = await readPersisted();
			if (persisted === null) {
				if (pipeline.completedStageIds.length > 0)
					throw new Error("prime_adaptive_state_missing_after_pipeline_progress");
				const state = initialState(input, pipeline, orderedStages);
				await persist(state);
				return state;
			}
			if (persisted.pipelineStateDigest === pipeline.stateDigest) {
				currentState = persisted;
				return persisted;
			}
			if (
				pipeline.completedStageIds.length <= persisted.completedStageIds.length ||
				persisted.completedStageIds.some((stageId, index) => pipeline.completedStageIds[index] !== stageId)
			)
				throw new Error("prime_adaptive_pipeline_regression_or_fork");
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			if (replay.quarantined || replay.head.eventDigest === null)
				throw new Error("prime_adaptive_authenticated_head_unavailable");
			const criticalPathStageIds = orderedStages.slice(pipeline.completedStageIds.length);
			const nextRecipeId = criticalPathStageIds.length === 0 ? ALTERNATE_RECIPE_ID : input.admission.recipeId;
			const nextParallelism = recommendedParallelism(
				input.graph,
				pipeline.completedStageIds,
				input.approvedParallelism,
			);
			const reviewIncrement = pipeline.completedStageIds.length - persisted.completedStageIds.length;
			let latestReviewRef = persisted.latestReviewRef;
			if (reviewIncrement > 0) {
				const reviewWithoutDigest = {
					schemaVersion: ADAPTIVE_RUNTIME_SCHEMA_VERSION,
					kind: "prime_adaptive_efficiency_review" as const,
					workflowId: input.workflowId,
					epochRef: { ...input.epochRef },
					graphDigest: input.graph.graphDigest,
					recipeId: input.admission.recipeId,
					sourcePipelineStateDigest: pipeline.stateDigest,
					triggerKind: "pipeline_transition" as const,
					priorStateDigest: persisted.stateDigest,
					completedStageIds: [...pipeline.completedStageIds],
					criticalPathStageIds,
					recommendedRecipeId: nextRecipeId,
					recommendedParallelism: nextParallelism,
					findingCodes:
						nextParallelism < input.approvedParallelism
							? ["unused_capacity_has_no_dependency_independent_work"]
							: [],
					reviewedAt: input.now(),
					writeAuthority: false as const,
					allocationAuthority: false as const,
					approvalAuthority: false as const,
					completionAuthority: false as const,
				};
				const review: PrimeAdaptiveReviewArtifact = {
					...reviewWithoutDigest,
					reviewDigest: digestObject(reviewWithoutDigest),
				};
				latestReviewRef = (
					await input.runtimeStore.publishArtifact({
						workflowId: input.workflowId,
						payloadKind: "evidence",
						bytes: canonicalJsonBytes(review),
						codec: "canonical_json",
						sourceEventSequence: replay.head.sequence,
						idempotencyKey: `prime-adaptive-review:${pipeline.stateDigest}`,
					})
				).envelope.ref;
			}
			const state = withStateDigest({
				schemaVersion: ADAPTIVE_RUNTIME_SCHEMA_VERSION,
				workflowId: input.workflowId,
				epochRef: { ...input.epochRef },
				graphDigest: input.graph.graphDigest,
				recipeId: input.admission.recipeId,
				pipelineStateDigest: pipeline.stateDigest,
				completedStageIds: [...pipeline.completedStageIds],
				criticalPathStageIds,
				reviewCount: persisted.reviewCount + reviewIncrement,
				periodicReviewCount: persisted.periodicReviewCount,
				lastPeriodicReviewAt: persisted.lastPeriodicReviewAt,
				nextPeriodicReviewAt: persisted.nextPeriodicReviewAt,
				recommendedRecipeId: nextRecipeId,
				recommendedParallelism: nextParallelism,
				recommendationReason: recommendationReason(pipeline.completedStageIds, orderedStages),
				latestReviewRef,
				sourceJournalSequence: replay.head.sequence,
				sourceJournalDigest: replay.head.eventDigest,
				canAuthorize: false,
			});
			await persist(state);
			return state;
		});

	const reviewIfDue = async (): Promise<PrimeAdaptiveRuntimeState> =>
		durable.withExclusiveLease(`prime-adaptive-runtime:${input.workflowId}`, async () => {
			const persisted = await readPersisted();
			if (persisted === null) throw new Error("prime_adaptive_state_unavailable");
			if (persisted.criticalPathStageIds.length === 0) {
				currentState = persisted;
				return persisted;
			}
			const reviewedAt = input.now();
			const reviewedAtMilliseconds = Date.parse(reviewedAt);
			if (!Number.isFinite(reviewedAtMilliseconds)) throw new Error("prime_adaptive_clock_invalid");
			if (reviewedAtMilliseconds < Date.parse(persisted.nextPeriodicReviewAt)) {
				currentState = persisted;
				return persisted;
			}
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: input.epochRef.storeEpoch,
			});
			if (replay.quarantined || replay.head.eventDigest === null)
				throw new Error("prime_adaptive_authenticated_head_unavailable");
			const reviewWithoutDigest = {
				schemaVersion: ADAPTIVE_RUNTIME_SCHEMA_VERSION,
				kind: "prime_adaptive_efficiency_review" as const,
				workflowId: input.workflowId,
				epochRef: { ...input.epochRef },
				graphDigest: input.graph.graphDigest,
				recipeId: input.admission.recipeId,
				sourcePipelineStateDigest: persisted.pipelineStateDigest,
				triggerKind: "scheduled_window" as const,
				priorStateDigest: persisted.stateDigest,
				completedStageIds: [...persisted.completedStageIds],
				criticalPathStageIds: [...persisted.criticalPathStageIds],
				recommendedRecipeId: persisted.recommendedRecipeId,
				recommendedParallelism: persisted.recommendedParallelism,
				findingCodes:
					persisted.recommendedParallelism < input.approvedParallelism
						? ["unused_capacity_has_no_dependency_independent_work"]
						: [],
				reviewedAt,
				writeAuthority: false as const,
				allocationAuthority: false as const,
				approvalAuthority: false as const,
				completionAuthority: false as const,
			};
			const review: PrimeAdaptiveReviewArtifact = {
				...reviewWithoutDigest,
				reviewDigest: digestObject(reviewWithoutDigest),
			};
			const latestReviewRef = (
				await input.runtimeStore.publishArtifact({
					workflowId: input.workflowId,
					payloadKind: "evidence",
					bytes: canonicalJsonBytes(review),
					codec: "canonical_json",
					sourceEventSequence: replay.head.sequence,
					idempotencyKey: `prime-adaptive-periodic-review:${persisted.nextPeriodicReviewAt}`,
				})
			).envelope.ref;
			const { stateDigest: _stateDigest, ...persistedWithoutDigest } = persisted;
			const state = withStateDigest({
				...persistedWithoutDigest,
				periodicReviewCount: persisted.periodicReviewCount + 1,
				lastPeriodicReviewAt: reviewedAt,
				nextPeriodicReviewAt: new Date(reviewedAtMilliseconds + PERIODIC_REVIEW_CADENCE_MILLISECONDS).toISOString(),
				latestReviewRef,
				sourceJournalSequence: replay.head.sequence,
				sourceJournalDigest: replay.head.eventDigest,
			});
			await persist(state);
			return state;
		});

	return Object.freeze({
		current: () => {
			if (currentState === undefined) throw new Error("prime_adaptive_state_unavailable");
			return currentState;
		},
		read: async () => {
			const state = await readPersisted();
			if (state === null) throw new Error("prime_adaptive_state_unavailable");
			currentState = state;
			return state;
		},
		recover: (pipeline: PrimeWorkflowPipelineState) => reconcile(pipeline),
		onPipelineCommitted: (pipeline: PrimeWorkflowPipelineState) => reconcile(pipeline),
		reviewIfDue,
		plannerDirective: () => {
			if (currentState === undefined) throw new Error("prime_adaptive_state_unavailable");
			return [
				`adaptive critical path: ${currentState.criticalPathStageIds.join(", ") || "none"}`,
				`adaptive parallelism: ${currentState.recommendedParallelism}`,
				`adaptive next recipe: ${currentState.recommendedRecipeId}`,
				`periodic efficiency reviews: ${currentState.periodicReviewCount}`,
				`adaptive recommendation: ${currentState.recommendationReason}`,
				"The efficiency red-team recommendation is non-authoritative; apply it only through the normal approval and learning gates.",
			].join("\n");
		},
	});
}
