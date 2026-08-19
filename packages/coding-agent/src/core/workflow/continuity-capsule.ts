import {
	canonicalJsonBytes,
	type DurableDecisionRef,
	digestObject,
	type WorkflowArtifactRef,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowLeaseRef,
	type WorkflowLeaseStatus,
	type WorkflowPhaseId,
	type WorkflowProgressEntry,
	type WorkflowProgressLedger,
	type WorkflowResourceEnvelope,
	type WorkflowStatus,
} from "./contracts.js";
import type { WorkflowState } from "./reducer.js";
import { computeReadyTaskIds, type WorkflowTask, type WorkflowTaskGraph } from "./task-graph.js";

const MAX_BYTES = 16_384;
const MAX_INPUT_STRING_BYTES = 1_024;
const MAX_INPUT_ARRAY_LENGTH = 256;
const MAX_INPUT_OBJECT_KEYS = 64;
const MAX_INPUT_DEPTH = 12;
const HEX_DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const WORKFLOW_STATUSES: readonly WorkflowStatus[] = [
	"active",
	"awaiting_user",
	"paused",
	"budget_limited",
	"blocked",
	"failed",
	"cancelled",
	"complete",
];

const WORKFLOW_PHASES: readonly WorkflowPhaseId[] = [
	"discovering_capacity",
	"hardening_goal",
	"hardening_scorecard",
	"reconnaissance",
	"analyzing_lenses",
	"verifying_evidence",
	"synthesizing",
	"red_teaming",
	"adjudicating",
	"planning",
	"dispatching",
	"executing",
	"auditing_progress",
	"verifying",
	"auditing_completion",
	"refining",
	"recovering",
];

const WORKFLOW_LEASE_STATUSES: readonly WorkflowLeaseStatus[] = [
	"reserved",
	"active",
	"release_pending",
	"released",
	"quarantined",
	"expired",
];

const CAPSULE_KEYS = [
	"workflowId",
	"sourceJournalSequence",
	"sourceEpoch",
	"sourceJournalDigest",
	"sourceConfigDigest",
	"workspaceDigest",
	"goalContractRevision",
	"scorecardRevision",
	"executionProfile",
	"status",
	"phase",
	"waitState",
	"provenRequirementIds",
	"unprovenRequirementIds",
	"regressedRequirementIds",
	"acceptedEvidenceRefs",
	"progressLedger",
	"planRevision",
	"readyTaskIds",
	"ownershipLeaseRefs",
	"resourceLeaseRefs",
	"failedStrategies",
	"unresolvedDecisionRefs",
	"continuationEntryPoint",
	"maxBytes",
	"capsuleDigest",
] as const;

const ARTIFACT_REF_KEYS = ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"] as const;
const DECISION_REF_KEYS = [
	"decisionScope",
	"decisionId",
	"revision",
	"storeEpoch",
	"coordinatorEpoch",
	"decisionDigest",
] as const;
const DECISION_SCOPE_KEYS = ["kind", "workflowId", "rootSessionId"] as const;
const LEASE_REF_KEYS = [
	"storeEpoch",
	"coordinatorEpoch",
	"leaseId",
	"acquisitionEventSequence",
	"processIdentity",
	"rootDigest",
	"writerIdentity",
	"acquiredAt",
	"expiresAt",
] as const;
const EPOCH_KEYS = ["storeEpoch", "coordinatorEpoch"] as const;
const PROGRESS_ENTRY_KEYS = [
	"requirementId",
	"status",
	"evidenceRefs",
	"evidenceRevisions",
	"regressionReason",
	"workspaceDigest",
	"auditorDecisionRef",
	"observedAt",
	"invalidatedByDecisionId",
] as const;
const PROGRESS_LEDGER_KEYS = [
	"workflowId",
	"contractRevision",
	"scorecardRevision",
	"planRevision",
	"configRevision",
	"evidenceRevision",
	"revisions",
	"entries",
	"progressDigest",
] as const;

export type ContinuityCapsuleMode = "resume" | "status_only";

export type ContinuityWaitState = "ready" | "awaiting_user" | "paused" | "budget_limited" | "blocked" | "terminal";

export interface ContinuityCapsuleHostContext {
	currentAt: string;
	currentEpoch: WorkflowEpochRef;
	validatedArtifactRefs: readonly WorkflowArtifactRef[];
	validatedDecisionRefs: readonly WorkflowDecisionRef[];
	validatedLeaseRefs: readonly WorkflowLeaseRef[];
	leaseStatusById: Readonly<Record<string, WorkflowLeaseStatus>>;
	progressEvidenceDigest: string;
}

export interface ContinuityReadinessContext {
	running: readonly WorkflowTask[];
	envelope: WorkflowResourceEnvelope;
}

export interface ContinuityCapsuleOptions {
	mode?: ContinuityCapsuleMode;
	statusOnly?: boolean;
	validationContext?: ContinuityCapsuleHostContext;
	readinessContext?: ContinuityReadinessContext;
}

export interface ContinuityCapsule {
	workflowId: string;
	sourceJournalSequence: number;
	sourceEpoch: WorkflowEpochRef;
	sourceJournalDigest: string;
	sourceConfigDigest: string;
	workspaceDigest: string;
	goalContractRevision: number;
	scorecardRevision: number;
	executionProfile: "unresolved" | "inline" | "parallel";
	status: WorkflowStatus;
	phase: WorkflowPhaseId;
	waitState: ContinuityWaitState;
	provenRequirementIds: readonly string[];
	unprovenRequirementIds: readonly string[];
	regressedRequirementIds: readonly string[];
	acceptedEvidenceRefs: readonly WorkflowArtifactRef[];
	progressLedger: WorkflowProgressLedger;
	planRevision: number;
	readyTaskIds: readonly string[];
	ownershipLeaseRefs: readonly WorkflowLeaseRef[];
	resourceLeaseRefs: readonly WorkflowLeaseRef[];
	failedStrategies: readonly string[];
	unresolvedDecisionRefs: readonly WorkflowDecisionRef[];
	continuationEntryPoint: string;
	maxBytes: number;
	capsuleDigest: string;
}

type ContinuityCapsuleOptionsInput = boolean | ContinuityCapsuleMode | ContinuityCapsuleOptions | undefined;

interface ValidatedContinuityProjection {
	acceptedEvidenceRefs: readonly WorkflowArtifactRef[];
	progressLedger: WorkflowProgressLedger;
	ownershipLeaseRefs: readonly WorkflowLeaseRef[];
	resourceLeaseRefs: readonly WorkflowLeaseRef[];
	unresolvedDecisionRefs: readonly WorkflowDecisionRef[];
	readyTaskIds: readonly string[];
	waitState: ContinuityWaitState;
}

/**
 * Return task IDs that satisfy host-validated worker-free readiness predicates in code-point order.
 *
 * Args:
 * graph: Validated task graph to inspect.
 * running: Active tasks whose ownership must not overlap a candidate.
 * envelope: Approved resource envelope used for fit checks.
 * Return: Sorted IDs of ready tasks.
 */
export function deriveContinuityReadyTaskIds(
	graph: WorkflowTaskGraph,
	running: readonly WorkflowTask[],
	envelope: WorkflowResourceEnvelope,
): readonly string[] {
	assertBoundedValue(graph.tasks, "graph.tasks");
	assertBoundedValue(running, "running");
	assertBoundedValue(envelope, "envelope");
	const readyTaskIds = computeReadyTaskIds(graph, running, envelope);
	return sortCodePointStrings(readyTaskIds);
}

/**
 * Derive a bounded immutable continuity projection from authoritative workflow inputs.
 *
 * Args:
 * state: Current reducer state that supplies the journal prefix and workflow projection.
 * ledger: Current host-audited progress ledger.
 * graph: Current validated task graph used to validate ready task IDs.
 * readyTaskIds: Host-computed ready task IDs.
 * options: Optional status mode and host validation context.
 * Return: Deep-frozen bounded continuity capsule.
 */
export function deriveContinuityCapsule(
	state: WorkflowState,
	ledger: WorkflowProgressLedger,
	graph: WorkflowTaskGraph,
	readyTaskIds: readonly string[],
	optionsInput?: ContinuityCapsuleOptionsInput,
): ContinuityCapsule {
	const options = normalizeOptions(optionsInput);
	const projection = validateContinuityInputs(state, ledger, graph, readyTaskIds, options);
	const capsuleWithoutDigest = {
		workflowId: state.workflowId,
		sourceJournalSequence: state.sourceJournalSequence,
		sourceEpoch: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
		sourceJournalDigest: state.sourceJournalDigest,
		sourceConfigDigest: state.configDigest ?? "",
		workspaceDigest: state.workspaceDigest,
		goalContractRevision: ledger.contractRevision,
		scorecardRevision: ledger.scorecardRevision,
		executionProfile: state.executionProfile,
		status: state.status,
		phase: state.phase,
		waitState: projection.waitState,
		provenRequirementIds: canonicalizeStringArray(state.provenRequirementIds, "provenRequirementIds"),
		unprovenRequirementIds: canonicalizeStringArray(state.unprovenRequirementIds, "unprovenRequirementIds"),
		regressedRequirementIds: canonicalizeStringArray(state.regressedRequirementIds, "regressedRequirementIds"),
		acceptedEvidenceRefs: sortArtifactRefs(projection.acceptedEvidenceRefs),
		progressLedger: projection.progressLedger,
		planRevision: state.planRevision,
		readyTaskIds: projection.readyTaskIds,
		ownershipLeaseRefs: sortLeaseRefs(projection.ownershipLeaseRefs),
		resourceLeaseRefs: sortLeaseRefs(projection.resourceLeaseRefs),
		failedStrategies: canonicalizeStringArray(state.failedStrategies, "failedStrategies"),
		unresolvedDecisionRefs: sortDecisionRefs(projection.unresolvedDecisionRefs),
		continuationEntryPoint: state.continuationEntryPoint,
		maxBytes: MAX_BYTES,
	};
	const capsule = {
		...capsuleWithoutDigest,
		capsuleDigest: digestObject({ ...capsuleWithoutDigest, capsuleDigest: "" }),
	};
	if (canonicalJsonBytes(capsule).byteLength > MAX_BYTES)
		throw new Error("Continuity capsule exceeds the canonical byte ceiling.");
	return deepFreeze(cloneValue(capsule));
}

/**
 * Reject a capsule that is stale, forged, out of scope, or not valid for resume.
 *
 * Args:
 * capsule: Capsule to validate.
 * state: Current reducer state.
 * ledger: Current host-audited progress ledger.
 * graph: Current validated task graph.
 * journalDigest: Current journal head digest.
 * epochRef: Current host epoch tuple.
 * configDigest: Current resolved configuration digest.
 * workspaceDigest: Current workspace digest.
 * goalContractRevision: Current goal contract revision.
 * scorecardRevision: Current scorecard revision.
 * planRevision: Current plan revision.
 * maxBytes: Required canonical byte ceiling.
 * readyTaskIds: Current host-computed ready task IDs.
 * optionsInput: Optional status mode and host validation context.
 * Return: Nothing; throws when the capsule is not fresh.
 */
export function assertFreshContinuityCapsule(
	capsule: ContinuityCapsule,
	state: WorkflowState,
	ledger: WorkflowProgressLedger,
	graph: WorkflowTaskGraph,
	journalDigest: string,
	epochRef: WorkflowEpochRef,
	configDigest: string,
	workspaceDigest: string,
	goalContractRevision: number,
	scorecardRevision: number,
	planRevision: number,
	maxBytes: number,
	readyTaskIds: readonly string[],
	optionsInput?: ContinuityCapsuleOptionsInput,
): void {
	const options = normalizeOptions(optionsInput);
	assertExactKeys(capsule, CAPSULE_KEYS, "capsule");
	assertBoundedValue(capsule, "capsule");
	const derived = deriveContinuityCapsule(state, ledger, graph, readyTaskIds, options);
	if (
		capsule.workflowId !== state.workflowId ||
		capsule.sourceJournalSequence !== state.sourceJournalSequence ||
		capsule.sourceEpoch.storeEpoch !== epochRef.storeEpoch ||
		capsule.sourceEpoch.coordinatorEpoch !== epochRef.coordinatorEpoch ||
		capsule.sourceJournalDigest !== journalDigest ||
		capsule.sourceConfigDigest !== configDigest ||
		capsule.workspaceDigest !== workspaceDigest ||
		capsule.goalContractRevision !== goalContractRevision ||
		capsule.scorecardRevision !== scorecardRevision ||
		capsule.planRevision !== planRevision ||
		capsule.status !== state.status ||
		capsule.phase !== state.phase ||
		capsule.progressLedger.progressDigest !== ledger.progressDigest ||
		capsule.maxBytes !== maxBytes ||
		capsule.maxBytes !== MAX_BYTES ||
		capsule.capsuleDigest !== digestObject({ ...capsule, capsuleDigest: "" }) ||
		digestObject(capsule) !== digestObject(derived) ||
		canonicalJsonBytes(capsule).byteLength > maxBytes
	) {
		throw new Error("Continuity capsule is stale.");
	}
}

function normalizeOptions(input: ContinuityCapsuleOptionsInput): ContinuityCapsuleOptions {
	if (typeof input === "boolean") return { mode: input ? "status_only" : "resume" };
	if (typeof input === "string") {
		if (input !== "resume" && input !== "status_only") throw new Error("Continuity capsule mode is invalid.");
		return { mode: input };
	}
	if (input?.mode !== undefined && input.mode !== "resume" && input.mode !== "status_only")
		throw new Error("Continuity capsule mode is invalid.");
	if (input?.statusOnly === true) return { ...input, mode: "status_only" };
	return input ?? {};
}

function validateContinuityInputs(
	state: WorkflowState,
	ledger: WorkflowProgressLedger,
	graph: WorkflowTaskGraph,
	readyTaskIds: readonly string[],
	options: ContinuityCapsuleOptions,
): ValidatedContinuityProjection {
	assertBoundedState(state);
	assertBoundedValue(ledger, "ledger");
	assertBoundedValue(graph.tasks, "graph.tasks");
	assertBoundedValue(
		{
			allowedAuthority: graph.allowedAuthority,
			ownershipPaths: graph.ownershipPaths,
			generatedOutputPaths: graph.generatedOutputPaths,
			lockPaths: graph.lockPaths,
			namedContracts: graph.namedContracts,
		},
		"graph.projections",
	);
	assertBoundedValue(readyTaskIds, "readyTaskIds");
	const mode = options.mode ?? "resume";
	assertWorkflowStateShape(state, mode);
	if (mode === "resume" && options.readinessContext === undefined)
		throw new Error("Continuity resumable capsules require a complete current readiness context.");
	assertExactKeys(ledger, PROGRESS_LEDGER_KEYS, "ledger");
	assertExactKeys(
		ledger.revisions,
		["contractRevision", "scorecardRevision", "planRevision", "configRevision", "evidenceRevision"],
		"ledger.revisions",
	);
	assertRevisionTuple(ledger);
	const context = options.validationContext;
	const stateReferences = [
		...state.acceptedEvidenceRefs,
		...state.ownershipLeaseRefs,
		...state.resourceLeaseRefs,
		...state.unresolvedDecisionRefs,
	];
	if ((stateReferences.length > 0 || ledger.entries.length > 0) && context === undefined)
		throw new Error("Continuity capsule requires host-validated reference context.");
	if (context !== undefined) assertHostContext(context, state);
	const acceptedEvidenceRefs = state.acceptedEvidenceRefs.map((ref) =>
		validateArtifactRef(ref, state.sourceJournalSequence, context?.validatedArtifactRefs),
	);
	const ownershipLeaseRefs = state.ownershipLeaseRefs.map((ref) => {
		if (context === undefined) throw new Error("Continuity lease reference requires host validation context.");
		return validateLeaseRef(ref, state, context, mode !== "status_only");
	});
	const resourceLeaseRefs = state.resourceLeaseRefs.map((ref) => {
		if (context === undefined) throw new Error("Continuity lease reference requires host validation context.");
		return validateLeaseRef(ref, state, context, mode !== "status_only");
	});
	const unresolvedDecisionRefs = state.unresolvedDecisionRefs.map((ref) =>
		validateDecisionRef(ref, state, context?.validatedDecisionRefs),
	);
	const progressLedger = validateProgressLedger(ledger, state, context);
	const canonicalReadyTaskIds = validateReadyTaskIds(graph, readyTaskIds, options.readinessContext);
	return {
		acceptedEvidenceRefs,
		progressLedger,
		ownershipLeaseRefs,
		resourceLeaseRefs,
		unresolvedDecisionRefs,
		readyTaskIds: canonicalReadyTaskIds,
		waitState: deriveWaitState(state.status),
	};
}

function assertWorkflowStateShape(state: WorkflowState, mode: ContinuityCapsuleMode): void {
	if (!WORKFLOW_STATUSES.includes(state.status)) throw new Error("Continuity capsule status is invalid.");
	if (!WORKFLOW_PHASES.includes(state.phase)) throw new Error("Continuity capsule phase is invalid.");
	if (!(["unresolved", "inline", "parallel"] as const).includes(state.executionProfile))
		throw new Error("Continuity capsule execution profile is invalid.");
	if (state.status === "awaiting_user" && state.phase !== "adjudicating")
		throw new Error("Continuity capsule awaiting_user state must be in the adjudicating phase.");
	if (isTerminalStatus(state.status) && mode !== "status_only")
		throw new Error("Continuity capsule cannot resume a terminal workflow without status_only mode.");
	assertNonEmptyString(state.workflowId, "state.workflowId");
	assertNonEmptyString(state.rootSessionId, "state.rootSessionId");
	assertNonEmptyString(state.sourceJournalDigest, "state.sourceJournalDigest");
	assertNonEmptyString(state.workspaceDigest, "state.workspaceDigest");
	assertNonEmptyString(state.continuationEntryPoint, "state.continuationEntryPoint");
	assertNonNegativeSafeInteger(state.sourceJournalSequence, "state.sourceJournalSequence");
	assertPositiveSafeInteger(state.storeEpoch, "state.storeEpoch");
	assertPositiveSafeInteger(state.coordinatorEpoch, "state.coordinatorEpoch");
	assertNonNegativeSafeInteger(state.planRevision, "state.planRevision");
}

function deriveWaitState(status: WorkflowStatus): ContinuityWaitState {
	if (status === "active") return "ready";
	if (status === "failed" || status === "cancelled" || status === "complete") return "terminal";
	return status;
}

function isTerminalStatus(status: WorkflowStatus): boolean {
	return status === "failed" || status === "cancelled" || status === "complete";
}

function validateReadyTaskIds(
	graph: WorkflowTaskGraph,
	readyTaskIds: readonly string[],
	readinessContext: ContinuityReadinessContext | undefined,
): readonly string[] {
	if (graph.byId.size !== graph.tasks.length) throw new Error("Continuity task graph identity is not current.");
	const taskIds = new Set<string>();
	for (const task of graph.tasks) {
		assertNonEmptyString(task.taskId, "graph task ID");
		if (taskIds.has(task.taskId) || graph.byId.get(task.taskId) !== task)
			throw new Error("Continuity task graph contains a foreign or duplicate task identity.");
		taskIds.add(task.taskId);
	}
	const canonicalReadyTaskIds = canonicalizeStringArray(readyTaskIds, "readyTaskIds");
	for (const taskId of canonicalReadyTaskIds) {
		const task = graph.byId.get(taskId);
		if (task === undefined) throw new Error(`Continuity ready task ${taskId} is foreign to the current graph.`);
		if (
			task.status !== "ready" ||
			task.dependencyTaskIds.some((dependencyId) => graph.byId.get(dependencyId)?.status !== "accepted") ||
			task.authority.some((capability) => !graph.allowedAuthority.includes(capability))
		)
			throw new Error(`Continuity ready task ${taskId} is not currently ready.`);
	}
	if (readinessContext !== undefined) {
		assertExactKeys(readinessContext, ["running", "envelope"], "readinessContext");
		assertBoundedValue(readinessContext, "readinessContext");
		const computedReadyTaskIds = deriveContinuityReadyTaskIds(
			graph,
			readinessContext.running,
			readinessContext.envelope,
		);
		if (!sameStringArray(canonicalReadyTaskIds, computedReadyTaskIds))
			throw new Error("Continuity ready task IDs are stale against the current resource readiness projection.");
	}
	return canonicalReadyTaskIds;
}

function assertHostContext(context: ContinuityCapsuleHostContext, state: WorkflowState): void {
	assertBoundedValue(context, "validationContext");
	assertExactKeys(
		context,
		[
			"currentAt",
			"currentEpoch",
			"validatedArtifactRefs",
			"validatedDecisionRefs",
			"validatedLeaseRefs",
			"leaseStatusById",
			"progressEvidenceDigest",
		],
		"validationContext",
	);
	assertFiniteIsoDate(context.currentAt, "validationContext.currentAt");
	assertEpoch(context.currentEpoch, "validationContext.currentEpoch");
	assertDigest(context.progressEvidenceDigest, "validationContext.progressEvidenceDigest");
	if (
		context.currentEpoch.storeEpoch !== state.storeEpoch ||
		context.currentEpoch.coordinatorEpoch !== state.coordinatorEpoch
	)
		throw new Error("Continuity host context epoch is stale.");
	if (
		context.validatedArtifactRefs.length > MAX_INPUT_ARRAY_LENGTH ||
		context.validatedDecisionRefs.length > MAX_INPUT_ARRAY_LENGTH ||
		context.validatedLeaseRefs.length > MAX_INPUT_ARRAY_LENGTH
	)
		throw new Error("Continuity host validation reference set exceeds its bound.");
	for (const ref of context.validatedArtifactRefs) validateArtifactRef(ref, state.sourceJournalSequence, undefined);
	for (const ref of context.validatedDecisionRefs) validateDecisionRef(ref, state, undefined);
	for (const ref of context.validatedLeaseRefs) validateLeaseRef(ref, state, context, false);
	for (const [leaseId, status] of Object.entries(context.leaseStatusById)) {
		assertNonEmptyString(leaseId, "validationContext.leaseStatusById key");
		if (!WORKFLOW_LEASE_STATUSES.includes(status)) throw new Error("Continuity host lease status is invalid.");
	}
}

function validateArtifactRef(
	ref: WorkflowArtifactRef,
	currentSequence: number,
	validatedRefs: readonly WorkflowArtifactRef[] | undefined,
): WorkflowArtifactRef {
	assertExactKeys(ref, ARTIFACT_REF_KEYS, "artifact reference");
	assertNonEmptyString(ref.artifactId, "artifact reference ID");
	assertNonEmptyString(ref.relativePath, "artifact reference path");
	if (
		ref.relativePath.startsWith("/") ||
		ref.relativePath.startsWith("\\") ||
		/^[A-Za-z]:/.test(ref.relativePath) ||
		ref.relativePath.includes("\\") ||
		ref.relativePath.includes("\0") ||
		ref.relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
	)
		throw new Error("Continuity artifact reference path is unsafe.");
	assertDigest(ref.digest, "artifact reference digest");
	assertNonNegativeSafeInteger(ref.sizeBytes, "artifact reference size");
	assertNonNegativeSafeInteger(ref.sourceEventSequence, "artifact reference source sequence");
	if (ref.sourceEventSequence > currentSequence)
		throw new Error("Continuity artifact reference is from a future event.");
	if (validatedRefs !== undefined && !containsCanonicalRef(validatedRefs, ref))
		throw new Error("Continuity artifact reference was not host-validated.");
	return {
		artifactId: ref.artifactId,
		relativePath: ref.relativePath,
		digest: ref.digest,
		sizeBytes: ref.sizeBytes,
		sourceEventSequence: ref.sourceEventSequence,
	};
}

function validateDecisionRef(
	ref: DurableDecisionRef,
	state: WorkflowState,
	validatedRefs: readonly WorkflowDecisionRef[] | undefined,
): WorkflowDecisionRef {
	if (!isRecord(ref) || !Object.hasOwn(ref, "coordinatorEpoch"))
		throw new Error("Continuity decision reference is not a workflow-scoped validated reference.");
	assertExactKeys(ref, DECISION_REF_KEYS, "decision reference");
	if (!isRecord(ref.decisionScope)) throw new Error("Continuity decision scope is invalid.");
	assertExactKeys(ref.decisionScope, DECISION_SCOPE_KEYS, "decision scope");
	if (
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== state.workflowId ||
		ref.decisionScope.rootSessionId !== state.rootSessionId
	)
		throw new Error("Continuity decision reference is outside the workflow scope.");
	assertNonEmptyString(ref.decisionId, "decision reference ID");
	assertPositiveSafeInteger(ref.revision, "decision reference revision");
	assertPositiveSafeInteger(ref.storeEpoch, "decision reference store epoch");
	const coordinatorEpoch: unknown = ref.coordinatorEpoch;
	if (typeof coordinatorEpoch !== "number")
		throw new Error("Continuity decision reference coordinator epoch is invalid.");
	assertPositiveSafeInteger(coordinatorEpoch, "decision reference coordinator epoch");
	if (ref.storeEpoch !== state.storeEpoch || coordinatorEpoch !== state.coordinatorEpoch)
		throw new Error("Continuity decision reference epoch is stale.");
	assertDigest(ref.decisionDigest, "decision reference digest");
	const validatedRef: WorkflowDecisionRef = {
		decisionScope: {
			kind: "workflow",
			workflowId: ref.decisionScope.workflowId,
			rootSessionId: ref.decisionScope.rootSessionId,
		},
		decisionId: ref.decisionId,
		revision: ref.revision,
		storeEpoch: ref.storeEpoch,
		coordinatorEpoch,
		decisionDigest: ref.decisionDigest,
	};
	if (validatedRefs !== undefined && !containsCanonicalRef(validatedRefs, validatedRef))
		throw new Error("Continuity decision reference was not host-validated.");
	return validatedRef;
}

function validateLeaseRef(
	ref: WorkflowLeaseRef,
	state: WorkflowState,
	context: ContinuityCapsuleHostContext,
	requireCurrentStatus = true,
): WorkflowLeaseRef {
	assertExactKeys(ref, LEASE_REF_KEYS, "lease reference");
	assertNonEmptyString(ref.leaseId, "lease reference ID");
	assertPositiveSafeInteger(ref.storeEpoch, "lease reference store epoch");
	assertPositiveSafeInteger(ref.coordinatorEpoch, "lease reference coordinator epoch");
	if (ref.storeEpoch !== state.storeEpoch || ref.coordinatorEpoch !== state.coordinatorEpoch)
		throw new Error("Continuity lease reference epoch is stale.");
	assertPositiveSafeInteger(ref.acquisitionEventSequence, "lease acquisition sequence");
	if (ref.acquisitionEventSequence > state.sourceJournalSequence)
		throw new Error("Continuity lease reference is from a future event.");
	assertNonEmptyString(ref.processIdentity, "lease process identity");
	assertNonEmptyString(ref.rootDigest, "lease root digest");
	assertNonEmptyString(ref.writerIdentity, "lease writer identity");
	assertFiniteIsoDate(ref.acquiredAt, "lease acquiredAt");
	assertFiniteIsoDate(ref.expiresAt, "lease expiresAt");
	if (Date.parse(ref.expiresAt) <= Date.parse(ref.acquiredAt)) throw new Error("Continuity lease expiry is invalid.");
	if (context !== undefined && Date.parse(ref.acquiredAt) > Date.parse(context.currentAt))
		throw new Error("Continuity lease acquisition is from the future.");
	if (context !== undefined && !containsCanonicalRef(context.validatedLeaseRefs, ref))
		throw new Error("Continuity lease reference was not host-validated.");
	if (requireCurrentStatus) {
		const status = context.leaseStatusById[ref.leaseId];
		if (status === undefined || (status !== "reserved" && status !== "active"))
			throw new Error("Continuity lease reference is not currently resumable.");
		if (Date.parse(ref.expiresAt) <= Date.parse(context.currentAt))
			throw new Error("Continuity lease reference is expired.");
	}
	return {
		storeEpoch: ref.storeEpoch,
		coordinatorEpoch: ref.coordinatorEpoch,
		leaseId: ref.leaseId,
		acquisitionEventSequence: ref.acquisitionEventSequence,
		processIdentity: ref.processIdentity,
		rootDigest: ref.rootDigest,
		writerIdentity: ref.writerIdentity,
		acquiredAt: ref.acquiredAt,
		expiresAt: ref.expiresAt,
	};
}

function validateProgressLedger(
	ledger: WorkflowProgressLedger,
	state: WorkflowState,
	context: ContinuityCapsuleHostContext | undefined,
): WorkflowProgressLedger {
	if (ledger.workflowId !== state.workflowId)
		throw new Error("Continuity progress ledger is outside the workflow scope.");
	if (context === undefined && ledger.entries.length > 0)
		throw new Error("Continuity progress validation requires host context.");
	if (ledger.entries.length > MAX_INPUT_ARRAY_LENGTH) throw new Error("Continuity progress ledger exceeds its bound.");
	const expectedStatuses = new Map<string, WorkflowProgressEntry["status"]>();
	for (const [status, requirementIds] of [
		["proven", state.provenRequirementIds],
		["unproven", state.unprovenRequirementIds],
		["regressed", state.regressedRequirementIds],
	] as const) {
		for (const requirementId of requirementIds) {
			if (expectedStatuses.has(requirementId))
				throw new Error("Continuity workflow requirement status sets overlap.");
			expectedStatuses.set(requirementId, status);
		}
	}
	const entryIds = new Set<string>();
	const entries = ledger.entries.map((entry) => {
		assertExactKeys(entry, PROGRESS_ENTRY_KEYS, "progress entry");
		assertNonEmptyString(entry.requirementId, "progress requirement ID");
		if (entryIds.has(entry.requirementId))
			throw new Error("Continuity progress ledger contains duplicate requirements.");
		entryIds.add(entry.requirementId);
		if (!expectedStatuses.has(entry.requirementId))
			throw new Error("Continuity progress ledger contains a foreign requirement.");
		if (expectedStatuses.get(entry.requirementId) !== entry.status)
			throw new Error("Continuity progress ledger status is not bound to workflow state.");
		if (!["unproven", "proven", "regressed"].includes(entry.status))
			throw new Error("Continuity progress entry status is invalid.");
		if (entry.evidenceRefs.length !== entry.evidenceRevisions.length)
			throw new Error("Continuity evidence refs and revisions are not paired.");
		const evidencePairs = entry.evidenceRefs.map((ref, index) => {
			const revision = entry.evidenceRevisions[index];
			assertPositiveSafeInteger(revision, "progress evidence revision");
			if (revision > ledger.evidenceRevision) throw new Error("Continuity evidence revision is from the future.");
			return {
				ref: validateArtifactRef(ref, state.sourceJournalSequence, context?.validatedArtifactRefs),
				revision,
			};
		});
		if (entry.status === "proven" && evidencePairs.length === 0)
			throw new Error("Continuity proven progress requires non-empty evidence.");
		if (
			entry.status === "proven" &&
			evidencePairs.some((pair) => !containsCanonicalRef(state.acceptedEvidenceRefs, pair.ref))
		)
			throw new Error("Continuity proven progress evidence is not bound to accepted workflow evidence.");
		const auditorDecisionRef = validateDecisionRef(entry.auditorDecisionRef, state, context?.validatedDecisionRefs);
		assertNonEmptyString(entry.workspaceDigest, "progress workspace digest");
		assertFiniteIsoDate(entry.observedAt, "progress observedAt");
		if (context !== undefined && Date.parse(entry.observedAt) > Date.parse(context.currentAt))
			throw new Error("Continuity progress observation is from the future.");
		if (entry.regressionReason !== null) assertNonEmptyString(entry.regressionReason, "progress regression reason");
		if (entry.invalidatedByDecisionId !== null)
			assertNonEmptyString(entry.invalidatedByDecisionId, "progress invalidation decision ID");
		if (entry.status === "regressed" && entry.invalidatedByDecisionId === null)
			throw new Error("Continuity regressed progress entry lacks an invalidation decision.");
		const sortedPairs = evidencePairs.sort((left, right) => compareCanonicalValues(left, right));
		return {
			requirementId: entry.requirementId,
			status: entry.status,
			evidenceRefs: sortedPairs.map((pair) => pair.ref),
			evidenceRevisions: sortedPairs.map((pair) => pair.revision),
			regressionReason: entry.regressionReason,
			workspaceDigest: entry.workspaceDigest,
			auditorDecisionRef,
			observedAt: entry.observedAt,
			invalidatedByDecisionId: entry.invalidatedByDecisionId,
		};
	});
	if (entryIds.size !== expectedStatuses.size) throw new Error("Continuity progress ledger is incomplete.");
	const revisions = {
		contractRevision: ledger.revisions.contractRevision,
		scorecardRevision: ledger.revisions.scorecardRevision,
		planRevision: ledger.revisions.planRevision,
		configRevision: ledger.revisions.configRevision,
		evidenceRevision: ledger.revisions.evidenceRevision,
	};
	const sortedEntries = [...entries].sort(compareProgressEntries);
	if (!entries.every((entry, index) => compareProgressEntries(entry, sortedEntries[index]!) === 0))
		throw new Error("Continuity progress ledger entries are not in canonical order.");
	const expectedProgressDigest = digestObject({
		workflowId: ledger.workflowId,
		revisions,
		entries: sortedEntries,
		evidenceDigest: context?.progressEvidenceDigest ?? digestObject([]),
	});
	if (ledger.progressDigest !== expectedProgressDigest)
		throw new Error("Continuity progress digest is stale or forged.");
	return {
		workflowId: ledger.workflowId,
		contractRevision: ledger.contractRevision,
		scorecardRevision: ledger.scorecardRevision,
		planRevision: ledger.planRevision,
		configRevision: ledger.configRevision,
		evidenceRevision: ledger.evidenceRevision,
		revisions,
		entries: sortedEntries,
		progressDigest: ledger.progressDigest,
	};
}

function assertRevisionTuple(ledger: WorkflowProgressLedger): void {
	for (const [name, value] of Object.entries({
		contractRevision: ledger.contractRevision,
		scorecardRevision: ledger.scorecardRevision,
		planRevision: ledger.planRevision,
		configRevision: ledger.configRevision,
		evidenceRevision: ledger.evidenceRevision,
	}))
		assertPositiveSafeInteger(value, `ledger.${name}`);
	if (
		ledger.revisions.contractRevision !== ledger.contractRevision ||
		ledger.revisions.scorecardRevision !== ledger.scorecardRevision ||
		ledger.revisions.planRevision !== ledger.planRevision ||
		ledger.revisions.configRevision !== ledger.configRevision ||
		ledger.revisions.evidenceRevision !== ledger.evidenceRevision
	)
		throw new Error("Continuity progress ledger revisions are not self-consistent.");
	assertNonEmptyString(ledger.progressDigest, "ledger.progressDigest");
}

function assertBoundedState(state: WorkflowState): void {
	assertBoundedValue(state, "state");
}

function assertBoundedValue(value: unknown, path: string, depth = 0, ancestors = new Set<object>()): void {
	if (depth > MAX_INPUT_DEPTH) throw new Error(`Continuity input ${path} exceeds its nesting bound.`);
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > MAX_INPUT_STRING_BYTES)
			throw new Error(`Continuity input ${path} exceeds its string bound.`);
		return;
	}
	if (value === null || typeof value !== "object") return;
	if (ancestors.has(value)) throw new Error(`Continuity input ${path} contains a cycle.`);
	ancestors.add(value);
	if (Array.isArray(value)) {
		if (value.length > MAX_INPUT_ARRAY_LENGTH) throw new Error(`Continuity input ${path} exceeds its array bound.`);
		value.forEach((item, index) => {
			assertBoundedValue(item, `${path}[${index}]`, depth + 1, ancestors);
		});
	} else {
		const keys = Object.keys(value);
		if (keys.length > MAX_INPUT_OBJECT_KEYS) throw new Error(`Continuity input ${path} exceeds its object bound.`);
		for (const key of keys) {
			assertBoundedValue(key, `${path}.<key>`, depth + 1, ancestors);
			assertBoundedValue((value as Record<string, unknown>)[key], `${path}.${key}`, depth + 1, ancestors);
		}
	}
	ancestors.delete(value);
}

function assertExactKeys(value: object, expected: readonly string[], path: string): void {
	const actual = Object.keys(value);
	if (actual.length !== expected.length || actual.some((key) => !expected.includes(key)))
		throw new Error(`Continuity ${path} has an unexpected field set.`);
}

function assertEpoch(epoch: WorkflowEpochRef, path: string): void {
	assertExactKeys(epoch, EPOCH_KEYS, path);
	assertPositiveSafeInteger(epoch.storeEpoch, `${path}.storeEpoch`);
	assertPositiveSafeInteger(epoch.coordinatorEpoch, `${path}.coordinatorEpoch`);
}

function assertDigest(value: string, path: string): void {
	if (!HEX_DIGEST_PATTERN.test(value)) throw new Error(`Continuity ${path} is not a lowercase SHA-256 digest.`);
}

function assertNonEmptyString(value: string, path: string): void {
	if (typeof value !== "string" || value.length === 0)
		throw new Error(`Continuity ${path} must be a non-empty string.`);
}

function assertPositiveSafeInteger(value: number, path: string): void {
	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`Continuity ${path} must be a positive safe integer.`);
}

function assertNonNegativeSafeInteger(value: number, path: string): void {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new Error(`Continuity ${path} must be a non-negative safe integer.`);
}

function assertFiniteIsoDate(value: string, path: string): void {
	if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
		throw new Error(`Continuity ${path} must be a canonical ISO timestamp.`);
}

function canonicalizeStringArray(values: readonly string[], path: string): readonly string[] {
	if (values.length > MAX_INPUT_ARRAY_LENGTH) throw new Error(`Continuity ${path} exceeds its array bound.`);
	const seen = new Set<string>();
	for (const value of values) {
		assertNonEmptyString(value, `${path} value`);
		if (seen.has(value)) throw new Error(`Continuity ${path} contains a duplicate value.`);
		seen.add(value);
	}
	return sortCodePointStrings(values);
}

function sortCodePointStrings(values: readonly string[]): readonly string[] {
	return [...values].sort(compareCodePointStrings);
}

function sortArtifactRefs(values: readonly WorkflowArtifactRef[]): readonly WorkflowArtifactRef[] {
	return [...values].sort(compareArtifactRefs);
}

function sortDecisionRefs(values: readonly WorkflowDecisionRef[]): readonly WorkflowDecisionRef[] {
	return [...values].sort(compareDecisionRefs);
}

function sortLeaseRefs(values: readonly WorkflowLeaseRef[]): readonly WorkflowLeaseRef[] {
	return [...values].sort(compareLeaseRefs);
}

function compareArtifactRefs(left: WorkflowArtifactRef, right: WorkflowArtifactRef): number {
	return (
		compareCodePointStrings(left.artifactId, right.artifactId) ||
		compareCodePointStrings(left.digest, right.digest) ||
		compareCodePointStrings(left.relativePath, right.relativePath) ||
		compareNumbers(left.sizeBytes, right.sizeBytes) ||
		compareNumbers(left.sourceEventSequence, right.sourceEventSequence)
	);
}

function compareDecisionRefs(left: WorkflowDecisionRef, right: WorkflowDecisionRef): number {
	return (
		compareCodePointStrings(left.decisionScope.kind, right.decisionScope.kind) ||
		compareCodePointStrings(left.decisionScope.workflowId, right.decisionScope.workflowId) ||
		compareCodePointStrings(left.decisionScope.rootSessionId, right.decisionScope.rootSessionId) ||
		compareCodePointStrings(left.decisionId, right.decisionId) ||
		compareNumbers(left.revision, right.revision) ||
		compareNumbers(left.storeEpoch, right.storeEpoch) ||
		compareNumbers(left.coordinatorEpoch, right.coordinatorEpoch) ||
		compareCodePointStrings(left.decisionDigest, right.decisionDigest)
	);
}

function compareLeaseRefs(left: WorkflowLeaseRef, right: WorkflowLeaseRef): number {
	return (
		compareCodePointStrings(left.leaseId, right.leaseId) ||
		compareNumbers(left.storeEpoch, right.storeEpoch) ||
		compareNumbers(left.coordinatorEpoch, right.coordinatorEpoch) ||
		compareNumbers(left.acquisitionEventSequence, right.acquisitionEventSequence) ||
		compareCodePointStrings(left.processIdentity, right.processIdentity) ||
		compareCodePointStrings(left.rootDigest, right.rootDigest) ||
		compareCodePointStrings(left.writerIdentity, right.writerIdentity) ||
		compareCodePointStrings(left.acquiredAt, right.acquiredAt) ||
		compareCodePointStrings(left.expiresAt, right.expiresAt)
	);
}

function compareProgressEntries(left: WorkflowProgressEntry, right: WorkflowProgressEntry): number {
	return compareCodePointStrings(left.requirementId, right.requirementId) || compareCanonicalValues(left, right);
}

function compareCanonicalValues(left: unknown, right: unknown): number {
	return compareCodePointStrings(
		new TextDecoder().decode(canonicalJsonBytes(left)),
		new TextDecoder().decode(canonicalJsonBytes(right)),
	);
}

function compareCodePointStrings(left: string, right: string): number {
	let leftIndex = 0;
	let rightIndex = 0;
	while (leftIndex < left.length && rightIndex < right.length) {
		const leftCodePoint = left.codePointAt(leftIndex);
		const rightCodePoint = right.codePointAt(rightIndex);
		if (leftCodePoint === undefined || rightCodePoint === undefined) break;
		if (leftCodePoint !== rightCodePoint) return leftCodePoint - rightCodePoint;
		leftIndex += leftCodePoint > 0xffff ? 2 : 1;
		rightIndex += rightCodePoint > 0xffff ? 2 : 1;
	}
	if (leftIndex === left.length && rightIndex === right.length) return 0;
	return leftIndex === left.length ? -1 : 1;
}

function compareNumbers(left: number, right: number): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function containsCanonicalRef<T>(refs: readonly T[], target: T): boolean {
	const targetDigest = digestObject(target);
	return refs.some((ref) => digestObject(ref) === targetDigest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
	if (isRecord(value)) {
		const clone: Record<string, unknown> = {};
		for (const key of Object.keys(value)) clone[key] = cloneValue(value[key]);
		return clone as T;
	}
	return value;
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	if (Array.isArray(value)) {
		for (const item of value) deepFreeze(item);
	} else {
		for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
	}
	return Object.freeze(value);
}
