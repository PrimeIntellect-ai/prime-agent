import {
	canonicalJsonBytes,
	type DurableStoreCrashBoundaryHook,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowEventPayload,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowImprovementOwner,
	type WorkflowImprovementProducer,
	type WorkflowJournalCommit,
	type WorkflowJournalHead,
	type WorkflowLeaseRef,
	type WorkflowPhaseId,
	type WorkflowRuntimeStore,
	type WorkflowRuntimeStoreDurableContext,
	type WorkflowStoreCommitInput,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import {
	createWorkflowLearningController,
	createWorkflowLearningControllerFromDurableState,
	type WorkflowLearningCanaryResult,
	type WorkflowLearningCandidate,
	type WorkflowLearningExperience,
	type WorkflowLearningExperienceInput,
	type WorkflowLearningHost,
	type WorkflowLearningHostProjection,
	type WorkflowLearningHostSnapshot,
	type WorkflowLearningPorts,
	type WorkflowLearningRedTeamResult,
	type WorkflowLearningReviewResult,
	type WorkflowLearningShadowResult,
	type WorkflowLearningState,
	type WorkflowLearningTrigger,
	type WorkflowLearningTriggerResult,
} from "./learning-controller.js";
import type { PersistedSessionWorkflowHost } from "./session-host-factory.js";

const LEARNING_RUNTIME_SCHEMA_VERSION = 1 as const;
const LEARNING_RUNTIME_MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const LEARNING_RUNTIME_MAX_REPLAY_EVENTS = 256;
const LEARNING_RUNTIME_MAX_ARTIFACT_REFS = 2048;
const LEARNING_RUNTIME_MAX_RECEIPTS = 1024;
const LEARNING_RUNTIME_MAX_STRING = 4096;
const LEARNING_RUNTIME_MAX_SAMPLES = 100_000;
const LEARNING_RUNTIME_MAX_METRIC = 1_000_000_000_000;
const LEARNING_RUNTIME_MAX_NODES = 100_000;
const LEARNING_RUNTIME_HEAD_REBASE_LIMIT = 32;

/** The host-authenticated scorer tuple used for every learning mutation. */
export interface WorkflowLearningApprovedAuthority {
	readonly scorecardRef: WorkflowArtifactRef;
	readonly evaluatorRef: WorkflowArtifactRef;
	readonly metricRef: WorkflowArtifactRef;
	readonly decisionRef: WorkflowDecisionRef;
	readonly owner: WorkflowImprovementOwner;
	readonly producer: WorkflowImprovementProducer;
	readonly kind: "workflow" | "methodology" | "policy" | "evaluator" | "knowledge";
	readonly sampleSize: number;
	readonly effectThreshold: number;
	readonly tolerance: number;
	readonly maxCostMicrounits: number;
	readonly maxLatencyMilliseconds: number;
	readonly evaluatorDigest: string;
	readonly metricDigest: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

type WorkflowLearningScorerAuthority = Omit<WorkflowLearningApprovedAuthority, "receipt">;

/** Live writer and semantic tuple supplied by the canonical workflow host. */
export interface WorkflowLearningRuntimeBinding {
	readonly workflowId: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
	readonly writerIdentity: string;
	readonly executionKey: string;
	readonly ownerId: string;
	readonly phase: WorkflowPhaseId;
	readonly semanticStateDigest: string;
	readonly expectedGenerations: Readonly<Record<string, number>>;
	readonly approvedAuthority: WorkflowLearningApprovedAuthority;
}

/** Existing durable workflow runtime plus host-controlled artifact and binding ports. */
export interface WorkflowLearningRuntimeAuthority {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly readBinding: (operationId?: string) => Promise<WorkflowLearningRuntimeBinding>;
	readonly crashHook?: DurableStoreCrashBoundaryHook;
}

export interface WorkflowLearningRuntimeAdapterOptions {
	readonly ports: WorkflowLearningPorts;
	readonly authority: WorkflowLearningRuntimeAuthority;
}

/** Inputs for the production seam that binds learning to one persisted session host. */
export interface WorkflowLearningSessionHostAdapterOptions {
	readonly host: WorkflowLearningSessionHostIdentity;
	readonly ports: WorkflowLearningPorts;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly readBinding: (operationId?: string) => Promise<WorkflowLearningRuntimeBinding>;
	readonly crashHook?: DurableStoreCrashBoundaryHook;
}

const WORKFLOW_LEARNING_SESSION_HOST_IDENTITY: unique symbol = Symbol("workflow-learning-session-host-identity");

/** Opaque capability issued for one authenticated persisted session host. */
export interface WorkflowLearningSessionHostIdentity {
	readonly [WORKFLOW_LEARNING_SESSION_HOST_IDENTITY]: "authenticated_persisted_session_host";
}

interface WorkflowLearningSessionHostBinding {
	readonly host: PersistedSessionWorkflowHost;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly durableContext: WorkflowRuntimeStoreDurableContext;
}

const sessionHostBindings = new WeakMap<object, WorkflowLearningSessionHostBinding>();
const sessionHostIdentities = new WeakMap<object, WorkflowLearningSessionHostIdentity>();

function assertPersistedSessionHost(host: PersistedSessionWorkflowHost): void {
	if (host === null || typeof host !== "object") fail("Learning session host identity requires a persisted host.");
	if (
		host.runtimeStore === undefined ||
		host.runtimeStore.identity.storeKind !== "workflow" ||
		host.runtimeStore.durableContext === undefined
	)
		fail("Learning session host identity requires the authenticated workflow runtime store.");
	if (
		typeof host.execute !== "function" ||
		typeof host.status !== "function" ||
		typeof host.runOutcome !== "function" ||
		typeof host.ensurePrimeWorkflow !== "function" ||
		typeof host.recoveryReadiness !== "function" ||
		typeof host.recoverBeforeResume !== "function"
	)
		fail("Learning session host identity requires the complete persisted host capability.");
}

/**
 * Issue an opaque identity for the exact persisted session host and store.
 *
 * Args:
 * host: Authenticated persisted session host returned by the session host factory.
 * Return: Opaque host identity accepted by the learning adapter factories.
 */
export function issueWorkflowLearningSessionHostIdentity(
	host: PersistedSessionWorkflowHost,
): WorkflowLearningSessionHostIdentity {
	assertPersistedSessionHost(host);
	const existing = sessionHostIdentities.get(host);
	if (existing !== undefined) return existing;
	const runtimeStore = host.runtimeStore;
	const durableContext = runtimeStore.durableContext;
	if (durableContext === undefined) fail("Learning session host durable context is unavailable.");
	const identity = Object.freeze({
		[WORKFLOW_LEARNING_SESSION_HOST_IDENTITY]: "authenticated_persisted_session_host" as const,
	}) as WorkflowLearningSessionHostIdentity;
	sessionHostBindings.set(identity, { host, runtimeStore, durableContext });
	sessionHostIdentities.set(host, identity);
	return identity;
}

function resolveWorkflowLearningSessionHostIdentity(
	identity: WorkflowLearningSessionHostIdentity,
): WorkflowLearningSessionHostBinding {
	if (identity === null || typeof identity !== "object")
		fail("Learning adapter requires an opaque persisted session host identity.");
	const binding = sessionHostBindings.get(identity);
	if (binding === undefined)
		fail("Learning adapter requires an opaque persisted session host identity; identity is not host-issued.");
	if (
		binding.host.runtimeStore !== binding.runtimeStore ||
		binding.runtimeStore.durableContext !== binding.durableContext
	)
		fail("Learning session host identity no longer matches its exact runtime store.");
	return binding;
}

/**
 * Durable effect authority supplied by the persisted session host.
 *
 * The authority owns registry CAS, promotion reconciliation, and rollback
 * readback. Learning only binds these operations to the exact runtime store;
 * it does not create a second mutation authority.
 */
export interface WorkflowLearningDurableEffectAuthority {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly durableContext: WorkflowRuntimeStoreDurableContext;
	readonly reconcilePromotion: WorkflowLearningHost["reconcilePromotion"];
	readonly promote: WorkflowLearningHost["promote"];
	readonly proposeRollback: WorkflowLearningHost["proposeRollback"];
	readonly applyRollback: WorkflowLearningHost["applyRollback"];
}

export interface WorkflowLearningRuntimeAdapterWithDurableEffectsOptions
	extends WorkflowLearningSessionHostAdapterOptions {
	readonly effectAuthority: WorkflowLearningDurableEffectAuthority;
}

/**
 * Compute the signed binding required for the current approved scorer authority.
 *
 * Args:
 * input: Workflow identity, current runtime epoch/head, and host-approved scorer tuple.
 * Return: Canonical receipt binding digest for the authority tuple.
 */
export function workflowLearningAuthorityBindingDigest(input: {
	readonly workflowId: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly stateHeadDigest: string;
	readonly authority: Omit<WorkflowLearningApprovedAuthority, "receipt">;
	readonly operationId?: string;
}): string {
	return digestObject({
		bindingKind: "workflow_learning_approved_authority",
		workflowId: input.workflowId,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		stateHeadDigest: input.stateHeadDigest,
		operationId: input.operationId ?? null,
		scorecardRef: input.authority.scorecardRef,
		evaluatorRef: input.authority.evaluatorRef,
		metricRef: input.authority.metricRef,
		decisionRef: input.authority.decisionRef,
		owner: input.authority.owner,
		producer: input.authority.producer,
		kind: input.authority.kind,
		sampleSize: input.authority.sampleSize,
		effectThreshold: input.authority.effectThreshold,
		tolerance: input.authority.tolerance,
		maxCostMicrounits: input.authority.maxCostMicrounits,
		maxLatencyMilliseconds: input.authority.maxLatencyMilliseconds,
		evaluatorDigest: input.authority.evaluatorDigest,
		metricDigest: input.authority.metricDigest,
	});
}

export interface WorkflowLearningRuntimeAdapter {
	commitExperience(input: WorkflowLearningExperienceInput): Promise<WorkflowLearningExperience>;
	typeCandidate(input: { experienceId: string; trigger: WorkflowLearningTrigger }): Promise<WorkflowLearningCandidate>;
	reviewCandidate(candidateId: string): Promise<WorkflowLearningReviewResult>;
	handleTrigger(trigger: WorkflowLearningTrigger): Promise<WorkflowLearningTriggerResult>;
	replay(): Promise<WorkflowLearningState>;
	getState(): Promise<WorkflowLearningState>;
}

interface LearningStateArtifact {
	readonly schemaVersion: typeof LEARNING_RUNTIME_SCHEMA_VERSION;
	readonly kind: "workflow_learning_state";
	readonly workflowId: string;
	readonly operationId: string;
	readonly operationKind: LearningArtifactOperationKind;
	readonly resultIdentity: string;
	readonly priorStateDigest: string | null;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly writerIdentity: string;
	readonly executionKey: string;
	readonly semanticBindingDigest: string;
	readonly scorerAuthorityDigest: string;
	readonly scorerAuthority: WorkflowLearningScorerAuthority;
	readonly authorityIntentRef: WorkflowArtifactRef | null;
	readonly authorityReceipt: WorkflowVerifiedHostReceipt | null;
	readonly authorityReceiptBindingDigest: string | null;
	readonly state: WorkflowLearningState;
}

interface LearningAuthorityIntentArtifact {
	readonly schemaVersion: typeof LEARNING_RUNTIME_SCHEMA_VERSION;
	readonly kind: "workflow_learning_authority_intent";
	readonly workflowId: string;
	readonly operationId: string;
	readonly expectedHead: WorkflowJournalHead;
	readonly epochRef: WorkflowEpochRef;
	readonly authorityReceipt: WorkflowVerifiedHostReceipt;
}

type LearningOperationKind = "experience" | "candidate" | "review" | "trigger";
type LearningArtifactOperationKind = LearningOperationKind | "review_intent";
const LEARNING_OPERATION_KINDS: ReadonlySet<LearningArtifactOperationKind> = new Set([
	"experience",
	"candidate",
	"review",
	"trigger",
	"review_intent",
]);
type RefinementPayload = Extract<WorkflowEventPayload, { kind: "refinement_recorded" }>;
type RefinementCommit = WorkflowJournalCommit<RefinementPayload>;

interface PersistedLearningEvent {
	readonly event: RefinementCommit;
	readonly state: WorkflowLearningState;
	readonly artifact: LearningStateArtifact;
	readonly artifactRef: WorkflowArtifactRef;
}

interface RuntimeOperation<T> {
	readonly kind: LearningOperationKind;
	readonly operationId: string;
	readonly invoke: (controller: ReturnType<typeof createWorkflowLearningController>) => Promise<T>;
	readonly resultIdentity: (result: T) => string;
	readonly select: (state: WorkflowLearningState, resultIdentity?: string) => T | undefined;
	readonly validateExisting?: (controller: ReturnType<typeof createWorkflowLearningController>) => Promise<void>;
}

function fail(message: string): never {
	throw new Error(message);
}

function isStaleLearningRuntimeCommit(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message ===
			"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease." ||
			error.message === "Workflow journal expected head is stale.")
	);
}

function assertBoundedString(
	value: unknown,
	label: string,
	max = LEARNING_RUNTIME_MAX_STRING,
): asserts value is string {
	if (typeof value !== "string" || value.length === 0 || value.length > max) fail(`${label} is invalid.`);
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) fail(`${label} is not a canonical digest.`);
}

function assertEpoch(value: WorkflowEpochRef, label: string): void {
	if (
		!Number.isSafeInteger(value.storeEpoch) ||
		value.storeEpoch < 1 ||
		!Number.isSafeInteger(value.coordinatorEpoch) ||
		value.coordinatorEpoch < 1
	)
		fail(`${label} is invalid.`);
}

function assertHead(value: WorkflowJournalHead, workflowId: string): void {
	if (value.workflowId !== workflowId || !Number.isSafeInteger(value.sequence) || value.sequence < 0)
		fail("Learning runtime head is not bound to the workflow.");
	if (value.eventDigest !== null) assertDigest(value.eventDigest, "Learning runtime head digest");
	assertEpoch(value.epochRef, "Learning runtime head epoch");
}

function assertLease(
	value: WorkflowLeaseRef,
	workflowId: string,
	writerIdentity: string,
	epoch: WorkflowEpochRef,
): void {
	assertEpoch(value, "Learning runtime lease epoch");
	assertBoundedString(value.leaseId, "Learning runtime lease id");
	assertBoundedString(value.processIdentity, "Learning runtime lease process identity");
	assertBoundedString(value.rootDigest, "Learning runtime lease root digest");
	assertBoundedString(value.writerIdentity, "Learning runtime lease writer identity");
	if (value.writerIdentity !== writerIdentity) fail("Learning runtime lease writer is not current.");
	assertDigest(value.rootDigest, "Learning runtime lease root digest");
	if (!Number.isFinite(Date.parse(value.acquiredAt)) || !Number.isFinite(Date.parse(value.expiresAt)))
		fail("Learning runtime lease timestamps are invalid.");
	if (value.expiresAt <= value.acquiredAt) fail("Learning runtime lease is expired.");
	if (value.storeEpoch !== epoch.storeEpoch || value.coordinatorEpoch !== epoch.coordinatorEpoch)
		fail("Learning runtime lease epoch is stale.");
	if (workflowId.length === 0) fail("Learning runtime workflow is empty.");
}

function assertArtifactRef(ref: WorkflowArtifactRef, label: string): void {
	assertBoundedString(ref.artifactId, `${label} artifact id`);
	assertBoundedString(ref.relativePath, `${label} relative path`);
	if (
		ref.relativePath.startsWith("/") ||
		ref.relativePath.includes("\\") ||
		ref.relativePath.includes("\0") ||
		ref.relativePath.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
	)
		fail(`${label} path is unsafe.`);
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(ref.artifactId)) fail(`${label} artifact id is not canonical.`);
	if (!/^artifacts\/[A-Za-z0-9][A-Za-z0-9._:-]*\/[0-9a-f]{64}$/.test(ref.relativePath))
		fail(`${label} path is not content-addressed.`);
	assertDigest(ref.digest, `${label} digest`);
	if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes < 0 || ref.sizeBytes > LEARNING_RUNTIME_MAX_ARTIFACT_BYTES)
		fail(`${label} size is invalid.`);
	if (!Number.isSafeInteger(ref.sourceEventSequence) || ref.sourceEventSequence < 0)
		fail(`${label} source sequence is invalid.`);
}

function sameRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
	return digestObject(left) === digestObject(right);
}

function sameHead(left: WorkflowJournalHead, right: WorkflowJournalHead): boolean {
	return digestObject(left) === digestObject(right);
}

function acceptsEventHead(
	expectedHead: WorkflowJournalHead,
	priorHead: WorkflowJournalHead,
	eventKind: WorkflowEventPayload["kind"],
	eventEpoch: WorkflowEpochRef,
	priorEventKind: WorkflowEventPayload["kind"] | null = null,
): boolean {
	if (sameHead(expectedHead, priorHead)) return true;
	const followsCoordinatorFence =
		priorEventKind === "coordinator_epoch_fenced" &&
		expectedHead.workflowId === priorHead.workflowId &&
		expectedHead.sequence === priorHead.sequence &&
		expectedHead.eventDigest === priorHead.eventDigest &&
		expectedHead.epochRef.storeEpoch === priorHead.epochRef.storeEpoch &&
		expectedHead.epochRef.coordinatorEpoch === priorHead.epochRef.coordinatorEpoch + 1 &&
		eventEpoch.storeEpoch === expectedHead.epochRef.storeEpoch &&
		eventEpoch.coordinatorEpoch === expectedHead.epochRef.coordinatorEpoch;
	if (followsCoordinatorFence) return true;
	return (
		(eventKind === "coordinator_epoch_fenced" || eventKind === "store_generation_fenced") &&
		expectedHead.workflowId === priorHead.workflowId &&
		expectedHead.sequence === priorHead.sequence &&
		expectedHead.eventDigest === priorHead.eventDigest &&
		((eventKind === "coordinator_epoch_fenced" &&
			expectedHead.epochRef.storeEpoch === priorHead.epochRef.storeEpoch &&
			expectedHead.epochRef.coordinatorEpoch === priorHead.epochRef.coordinatorEpoch + 1) ||
			(eventKind === "store_generation_fenced" &&
				expectedHead.epochRef.storeEpoch === priorHead.epochRef.storeEpoch + 1 &&
				expectedHead.epochRef.coordinatorEpoch === priorHead.epochRef.coordinatorEpoch)) &&
		eventEpoch.storeEpoch === expectedHead.epochRef.storeEpoch &&
		eventEpoch.coordinatorEpoch === expectedHead.epochRef.coordinatorEpoch
	);
}

function commitHead(event: {
	readonly workflowId: string;
	readonly sequence: number;
	readonly eventDigest: string;
	readonly epochRef: WorkflowEpochRef;
}): WorkflowJournalHead {
	return {
		workflowId: event.workflowId,
		sequence: event.sequence,
		eventDigest: event.eventDigest,
		epochRef: event.epochRef,
	};
}

function immutable<T>(value: T): T {
	if (value === null || typeof value !== "object") return value;
	const copy = structuredClone(value);
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object" || Object.isFrozen(item)) return;
		if (Array.isArray(item)) for (const child of item) freeze(child);
		else for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(copy);
	return copy;
}

function operationId(kind: LearningOperationKind, value: unknown): string {
	return `learning:${kind}:${digestObject(value)}`;
}

function triggerIdentity(trigger: WorkflowLearningTrigger): string {
	return digestObject({
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
}

function stateWithoutDigest(state: WorkflowLearningState): Omit<WorkflowLearningState, "stateDigest"> {
	const { stateDigest: _stateDigest, ...withoutDigest } = state;
	return withoutDigest;
}

function assertStateDigest(state: WorkflowLearningState): void {
	if (state.schemaVersion !== 1 || state.stateDigest !== digestObject(stateWithoutDigest(state)))
		fail("Learning runtime state digest does not match canonical bytes.");
}

function assertStateBounds(state: WorkflowLearningState): void {
	assertStateDigest(state);
	assertRuntimeValueBounds(state);
	for (const collection of [
		state.experiences,
		state.candidates,
		state.reviews,
		state.rollbackProposals,
		state.triggers,
		state.consumedReceiptIds,
		state.consumedWitnessIds ?? [],
	]) {
		if (!Array.isArray(collection) || collection.length > LEARNING_RUNTIME_MAX_REPLAY_EVENTS) {
			fail("Learning runtime state collection is unbounded.");
		}
	}
	const bytes = canonicalJsonBytes(state);
	if (bytes.byteLength > LEARNING_RUNTIME_MAX_ARTIFACT_BYTES) fail("Learning runtime state artifact is too large.");
}

function assertRuntimeValueBounds(value: unknown, depth = 0, nodes = { count: 0 }): void {
	if (depth > 32 || nodes.count >= LEARNING_RUNTIME_MAX_NODES) fail("Learning runtime state nesting is unbounded.");
	nodes.count += 1;
	if (typeof value === "string") {
		if (new TextEncoder().encode(value).byteLength > LEARNING_RUNTIME_MAX_STRING)
			fail("Learning runtime state string is unbounded.");
		return;
	}
	if (value === null || typeof value === "number" || typeof value === "boolean") {
		if (typeof value === "number" && !Number.isFinite(value)) fail("Learning runtime state number is invalid.");
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > LEARNING_RUNTIME_MAX_ARTIFACT_REFS) fail("Learning runtime state array is unbounded.");
		for (const item of value) assertRuntimeValueBounds(item, depth + 1, nodes);
		return;
	}
	if (typeof value !== "object") fail("Learning runtime state contains an unsupported value.");
	const keys = Object.keys(value);
	if (keys.length > LEARNING_RUNTIME_MAX_ARTIFACT_REFS) fail("Learning runtime state object is unbounded.");
	for (const item of Object.values(value)) assertRuntimeValueBounds(item, depth + 1, nodes);
}

function isArtifactRefValue(value: unknown): value is WorkflowArtifactRef {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		Object.keys(record).length === 5 &&
		typeof record.artifactId === "string" &&
		typeof record.relativePath === "string" &&
		typeof record.digest === "string" &&
		typeof record.sizeBytes === "number" &&
		typeof record.sourceEventSequence === "number"
	);
}

function collectArtifactRefs(value: unknown, refs: Map<string, WorkflowArtifactRef>, depth = 0): void {
	if (depth > 32) fail("Learning runtime state nesting is too deep.");
	if (isArtifactRefValue(value)) {
		const ref = value;
		assertArtifactRef(ref, "Learning state");
		refs.set(digestObject(ref), ref);
		return;
	}
	if (Array.isArray(value)) {
		if (value.length > LEARNING_RUNTIME_MAX_ARTIFACT_REFS) fail("Learning runtime array is unbounded.");
		for (const item of value) collectArtifactRefs(item, refs, depth + 1);
		return;
	}
	if (typeof value !== "object" || value === null) return;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length > LEARNING_RUNTIME_MAX_ARTIFACT_REFS) fail("Learning runtime object is unbounded.");
	for (const item of Object.values(record)) collectArtifactRefs(item, refs, depth + 1);
}

function collectReceipts(value: unknown, receipts: Map<string, WorkflowVerifiedHostReceipt>, depth = 0): void {
	if (depth > 32) fail("Learning runtime receipt nesting is too deep.");
	if (typeof value !== "object" || value === null) return;
	if (
		!Array.isArray(value) &&
		"receiptId" in value &&
		"signature" in value &&
		"verificationDigest" in value &&
		"artifactRef" in value
	) {
		const receipt = value as WorkflowVerifiedHostReceipt;
		assertBoundedString(receipt.receiptId, "Learning receipt id");
		if (receipts.has(receipt.receiptId)) fail("Learning receipt identity was duplicated in persisted state.");
		if (receipts.size >= LEARNING_RUNTIME_MAX_RECEIPTS) fail("Learning receipt history is unbounded.");
		receipts.set(receipt.receiptId, receipt);
	}
	if (Array.isArray(value)) {
		for (const item of value) collectReceipts(item, receipts, depth + 1);
		return;
	}
	for (const item of Object.values(value as Record<string, unknown>)) collectReceipts(item, receipts, depth + 1);
}

function assertDecisionRef(ref: WorkflowDecisionRef, binding: WorkflowLearningRuntimeBinding): void {
	if (
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== binding.workflowId ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision < 1 ||
		ref.storeEpoch !== binding.epochRef.storeEpoch ||
		ref.coordinatorEpoch !== binding.epochRef.coordinatorEpoch
	)
		fail("Learning scorer decision is not bound to the current workflow epoch.");
	assertBoundedString(ref.decisionId, "Learning scorer decision id");
	assertDigest(ref.decisionDigest, "Learning scorer decision digest");
}

function assertFiniteMetric(value: number, label: string, minimum = 0): void {
	if (!Number.isFinite(value) || value < minimum || Math.abs(value) > LEARNING_RUNTIME_MAX_METRIC)
		fail(`${label} is not a positive bounded finite value.`);
}

function assertSampleCount(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value < 1 || value > LEARNING_RUNTIME_MAX_SAMPLES)
		fail(`${label} is not a positive bounded sample count.`);
}

async function verifyArtifact(
	resolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
	label: string,
): Promise<void> {
	assertArtifactRef(ref, label);
	const artifact = await resolver.resolve(ref);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		!sameRef(artifact.envelope.ref, ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest
	)
		fail(`${label} is not resolver-verified.`);
}

function assertAuthorityIntentArtifact(
	value: unknown,
	workflowId: string,
	operationIdValue: string,
	expectedHead: WorkflowJournalHead,
	epochRef: WorkflowEpochRef,
): asserts value is LearningAuthorityIntentArtifact {
	if (
		typeof value !== "object" ||
		value === null ||
		Array.isArray(value) ||
		(value as Record<string, unknown>).schemaVersion !== LEARNING_RUNTIME_SCHEMA_VERSION ||
		(value as Record<string, unknown>).kind !== "workflow_learning_authority_intent" ||
		(value as Record<string, unknown>).workflowId !== workflowId ||
		(value as Record<string, unknown>).operationId !== operationIdValue
	)
		fail("Learning authority intent artifact is malformed.");
	const record = value as LearningAuthorityIntentArtifact;
	if (!sameHead(record.expectedHead, expectedHead) || digestObject(record.epochRef) !== digestObject(epochRef))
		fail("Learning authority intent artifact is stale for its operation head.");
	assertHead(record.expectedHead, workflowId);
	assertEpoch(record.epochRef, "Learning authority intent epoch");
	assertBoundedString(record.operationId, "Learning authority intent operation id");
}

async function verifyHistoricalReceipt(
	context: WorkflowHostReceiptConsumerContext,
	receipt: WorkflowVerifiedHostReceipt,
	workflowId: string,
	expectedBindingDigest = receipt.bindingDigest,
): Promise<void> {
	assertBoundedString(receipt.receiptId, "Learning receipt id");
	if (receipt.workflowId !== workflowId) fail("Learning receipt workflow binding is stale.");
	const issuedAt = Date.parse(receipt.issuedAt);
	const validUntil = Date.parse(receipt.validUntil);
	if (!Number.isFinite(issuedAt) || !Number.isFinite(validUntil) || validUntil <= issuedAt)
		fail("Learning receipt validity interval is invalid.");
	await resolveAndVerifyWorkflowHostReceipt({
		context,
		workflowId,
		expectedBindingDigest,
		receipt,
		currentStateDigest: receipt.stateDigest,
		currentRevision: receipt.revision,
		trustedNow: new Date(Math.min(validUntil - 1, issuedAt + 1)).toISOString(),
	});
	if (receipt.oneUse) {
		const witness = await context.receiptResolver.resolveConsumptionWitness({
			receiptId: receipt.receiptId,
			workflowId,
			expectedBindingDigest,
		});
		if (
			witness.receiptId !== receipt.receiptId ||
			witness.workflowId !== workflowId ||
			witness.bindingDigest !== expectedBindingDigest
		)
			fail("Persisted learning receipt has no matching durable consumption witness.");
	}
}

function stripReceiptPayload(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => stripReceiptPayload(item));
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => key !== "hostReceipt" && key !== "receipt" && key !== "receipts")
			.map(([key, item]) => [key, stripReceiptPayload(item)]),
	);
}

function receiptBindingDigest(kind: string, payload: unknown, receipt: WorkflowVerifiedHostReceipt): string {
	return digestObject({
		kind,
		payloadDigest: digestObject(stripReceiptPayload(payload)),
		receiptId: receipt.receiptId,
		receiptPayloadDigest: receipt.payloadDigest,
	});
}

function withoutWitnesses<T>(value: T): T {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return structuredClone(value);
	const copy = structuredClone(value) as Record<string, unknown>;
	delete copy.evidenceWitnesses;
	return copy as T;
}

async function assertApprovedAuthority(
	authority: WorkflowLearningApprovedAuthority,
	binding: WorkflowLearningRuntimeBinding,
	current: WorkflowLearningHostSnapshot,
	resolver: WorkflowArtifactResolver,
	operationId?: string,
): Promise<void> {
	for (const [label, ref] of [
		["approved scorecard", authority.scorecardRef],
		["approved evaluator", authority.evaluatorRef],
		["approved metric", authority.metricRef],
	] as const)
		await verifyArtifact(resolver, ref, label);
	assertDecisionRef(authority.decisionRef, binding);
	assertSampleCount(authority.sampleSize, "Approved scorer sample size");
	assertFiniteMetric(authority.effectThreshold, "Approved scorer effect threshold");
	assertFiniteMetric(authority.tolerance, "Approved scorer tolerance");
	assertFiniteMetric(authority.maxCostMicrounits, "Approved scorer cost ceiling");
	assertFiniteMetric(authority.maxLatencyMilliseconds, "Approved scorer latency ceiling");
	assertDigest(authority.evaluatorDigest, "Approved scorer evaluator digest");
	assertDigest(authority.metricDigest, "Approved scorer metric digest");
	if (
		authority.evaluatorDigest !== authority.evaluatorRef.digest ||
		authority.metricDigest !== authority.metricRef.digest
	)
		fail("Approved scorer outputs are not bound to their evaluator and metric artifacts.");
	if (
		!new Set<WorkflowImprovementOwner>(["policy", "native", "autoresearch", "knowledge"]).has(authority.owner) ||
		!new Set<WorkflowImprovementProducer>(["durable", "native", "autoresearch", "knowledge"]).has(
			authority.producer,
		) ||
		!new Set<WorkflowLearningApprovedAuthority["kind"]>([
			"workflow",
			"methodology",
			"policy",
			"evaluator",
			"knowledge",
		]).has(authority.kind)
	)
		fail("Approved scorer owner, producer, or kind is not host-controlled.");
	if (authority.receipt.oneUse !== true) fail("Approved scorer authority requires a one-use receipt.");
	if (
		authority.receipt.bindingDigest !==
		workflowLearningAuthorityBindingDigest({
			workflowId: binding.workflowId,
			expectedHead: binding.expectedHead,
			epochRef: binding.epochRef,
			stateHeadDigest: binding.semanticStateDigest,
			authority,
			operationId,
		})
	)
		fail("Approved scorer receipt is not bound to the exact scorer, decision, epoch, and state head.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: current.receiptContext,
		workflowId: binding.workflowId,
		expectedBindingDigest: authority.receipt.bindingDigest,
		receipt: authority.receipt,
		currentStateDigest: current.stateDigest,
		currentRevision: current.currentRevision,
		trustedNow: current.trustedNow,
	});
}

function scorerAuthorityDigest(
	authority: WorkflowLearningScorerAuthority,
	epochRef: WorkflowEpochRef = authority.decisionRef,
): string {
	// The signed authority receipt is a fresh host witness; replay verifies it at the current binding.
	return digestObject({
		scorecardRef: authority.scorecardRef,
		evaluatorRef: authority.evaluatorRef,
		metricRef: authority.metricRef,
		decisionRef: {
			...authority.decisionRef,
			storeEpoch: epochRef.storeEpoch,
			coordinatorEpoch: epochRef.coordinatorEpoch,
		},
		owner: authority.owner,
		producer: authority.producer,
		kind: authority.kind,
		sampleSize: authority.sampleSize,
		effectThreshold: authority.effectThreshold,
		tolerance: authority.tolerance,
		maxCostMicrounits: authority.maxCostMicrounits,
		maxLatencyMilliseconds: authority.maxLatencyMilliseconds,
		evaluatorDigest: authority.evaluatorDigest,
		metricDigest: authority.metricDigest,
	});
}

function withoutAuthorityReceipt(authority: WorkflowLearningApprovedAuthority): WorkflowLearningScorerAuthority {
	const { receipt: _receipt, ...scorer } = authority;
	return structuredClone(scorer);
}

function assertCandidateAuthority(
	candidate: WorkflowLearningCandidate,
	authority: WorkflowLearningScorerAuthority,
): void {
	if (
		candidate.candidateDigest !== candidate.candidateRef.digest ||
		candidate.owner !== authority.owner ||
		candidate.producer !== authority.producer ||
		candidate.kind !== authority.kind ||
		!sameRef(candidate.scorecardRef, authority.scorecardRef) ||
		!sameRef(candidate.evaluatorRef, authority.evaluatorRef) ||
		candidate.scorecardDigest !== authority.scorecardRef.digest ||
		candidate.evaluatorDigest !== authority.evaluatorRef.digest ||
		candidate.caseManifest.requiredSampleSize !== authority.sampleSize ||
		candidate.caseManifest.effectThreshold !== authority.effectThreshold ||
		candidate.caseManifest.tolerance !== authority.tolerance ||
		candidate.caseManifest.maxCostMicrounits !== authority.maxCostMicrounits ||
		candidate.caseManifest.maxLatencyMilliseconds !== authority.maxLatencyMilliseconds
	)
		fail("Learning candidate used proposer-controlled scorer authority.");
}

async function verifyHoldoutManifestArtifact(
	resolver: WorkflowArtifactResolver,
	candidate: WorkflowLearningCandidate,
): Promise<void> {
	await verifyArtifact(resolver, candidate.hiddenHoldoutManifestRef, "Learning candidate holdout manifest");
	const resolved = await resolver.resolve(candidate.hiddenHoldoutManifestRef);
	const parsed = parseCanonicalJsonBytes(new Uint8Array(resolved.bytes));
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		(parsed as Record<string, unknown>).schemaVersion !== 1 ||
		(parsed as Record<string, unknown>).kind !== "workflow_learning_holdout_manifest" ||
		(parsed as Record<string, unknown>).workflowId !== candidate.workflowId ||
		(parsed as Record<string, unknown>).candidateId !== candidate.candidateId ||
		(parsed as Record<string, unknown>).manifestDigest !== candidate.caseManifest.manifestDigest ||
		digestObject((parsed as Record<string, unknown>).manifest) !== digestObject(candidate.caseManifest) ||
		candidate.caseManifest.manifestDigest !== digestObject({ ...candidate.caseManifest, manifestDigest: "" })
	)
		fail("Learning candidate holdout manifest bytes are not bound to its schema and digest.");
}

function assertReviewAuthority(
	review: WorkflowLearningReviewResult,
	authority: WorkflowLearningScorerAuthority,
	allowHistoricalDecisionEpoch = false,
): void {
	for (const metrics of [review.shadow.metrics, review.canary?.metrics, review.redTeam?.metrics]) {
		if (metrics === undefined) continue;
		if (metrics.evaluatorDigest !== authority.evaluatorDigest || metrics.metricDigest !== authority.metricDigest)
			fail("Learning stage metrics are not bound to the approved evaluator and metric.");
		assertSampleCount(metrics.sampleCount, "Learning stage sample count");
		assertFiniteMetric(metrics.effectSize, "Learning stage effect size", 0);
		assertFiniteMetric(metrics.variance, "Learning stage variance", 0);
		assertFiniteMetric(metrics.costMicrounits, "Learning stage cost", 0);
		assertFiniteMetric(metrics.latencyMilliseconds, "Learning stage latency", 0);
	}
	if (review.decisionRef !== null) {
		const expectedDecisionRef = allowHistoricalDecisionEpoch
			? {
					...authority.decisionRef,
					storeEpoch: review.decisionRef.storeEpoch,
					coordinatorEpoch: review.decisionRef.coordinatorEpoch,
				}
			: authority.decisionRef;
		if (digestObject(review.decisionRef) !== digestObject(expectedDecisionRef))
			fail("Learning review decision is not bound to the approved scorer decision.");
	}
	if (review.status === "promoted") {
		if (review.decision === null || review.decisionRef === null)
			fail("Persisted promotion requires the current durable scorer decision reference.");
		if (
			review.decision.decisionRef === undefined ||
			digestObject(review.decision.decisionRef) !== digestObject(review.decisionRef)
		)
			fail("Persisted promotion decision reference changed between decision and review.");
	}
}

type LearningStageResult = WorkflowLearningShadowResult | WorkflowLearningCanaryResult | WorkflowLearningRedTeamResult;

function assertTypedStageArtifact(
	value: unknown,
	stage: "shadow" | "canary" | "red_team",
	result: LearningStageResult,
	workflowId: string,
	candidateId: string,
): void {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		fail(`${stage} result artifact is invalid.`);
	const record = value as Record<string, unknown>;
	if (
		record.schemaVersion !== 1 ||
		record.kind !== "workflow_learning_stage_result" ||
		record.workflowId !== workflowId ||
		record.candidateId !== candidateId ||
		record.stage !== stage ||
		digestObject(record.evidenceRefs) !== digestObject(result.evidenceRefs) ||
		digestObject(record.metrics ?? null) !== digestObject(result.metrics ?? null)
	)
		fail(`${stage} result artifact is not bound to the typed host result.`);
	if (stage === "shadow") {
		const shadow = result as WorkflowLearningShadowResult;
		if (
			record.sameCaseInputDigest !== shadow.sameCaseInputDigest ||
			record.heldOutInputDigest !== shadow.heldOutInputDigest ||
			record.heldOutSampleCount !== shadow.heldOutSampleCount ||
			record.heldOutPassed !== shadow.heldOutPassed ||
			record.overfittingDetected !== shadow.overfittingDetected ||
			record.nonRegressionPassed !== shadow.nonRegressionPassed ||
			record.safetyPassed !== shadow.safetyPassed
		)
			fail("Shadow booleans are not signed in the evaluator artifact.");
	} else {
		const expected = result as WorkflowLearningCanaryResult | WorkflowLearningRedTeamResult;
		if (record.passed !== expected.passed) fail(`${stage} boolean is not signed in the evaluator artifact.`);
	}
}

async function verifyTypedStageArtifact(
	resolver: WorkflowArtifactResolver,
	result: LearningStageResult,
	stage: "shadow" | "canary" | "red_team",
	workflowId: string,
	candidateId: string,
): Promise<void> {
	await verifyArtifact(resolver, result.resultRef, `${stage} result artifact`);
	const resolved = await resolver.resolve(result.resultRef);
	const parsed = parseCanonicalJsonBytes(new Uint8Array(resolved.bytes));
	assertTypedStageArtifact(parsed, stage, result, workflowId, candidateId);
}

function initialLearningState(): WorkflowLearningState {
	const state = {
		schemaVersion: 1 as const,
		experiences: [],
		candidates: [],
		reviews: [],
		rollbackProposals: [],
		triggers: [],
		consumedReceiptIds: [],
		consumedWitnessIds: [],
	};
	return { ...state, stateDigest: digestObject(state) };
}

function findEventByOperation(
	events: readonly PersistedLearningEvent[],
	operationIdValue: string,
): PersistedLearningEvent | undefined {
	return events.find((item) => item.event.payload.runId === operationIdValue);
}

function selectLatestState(events: readonly PersistedLearningEvent[]): WorkflowLearningState {
	return events.at(-1)?.state ?? initialLearningState();
}

function assertRefinementPayload(
	payload: Extract<WorkflowEventPayload, { kind: "refinement_recorded" }>,
	binding: WorkflowLearningRuntimeBinding,
): void {
	if (payload.workflowId !== binding.workflowId) fail("Learning refinement event is not bound to the workflow.");
	assertEpoch(payload.epochRef, "Learning refinement event epoch");
	assertBoundedString(payload.runId, "Learning refinement operation id");
	assertDigest(payload.refinementDigest, "Learning refinement digest");
	if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length !== 1)
		fail("Learning refinement event must name one state artifact.");
	assertArtifactRef(payload.evidenceRefs[0]!, "Learning refinement state artifact");
}

function assertRefinementEventBinding(event: RefinementCommit, binding: WorkflowLearningRuntimeBinding): void {
	if (
		event.workflowId !== binding.workflowId ||
		event.payload.workflowId !== event.workflowId ||
		event.payload.epochRef.storeEpoch !== event.epochRef.storeEpoch ||
		event.payload.epochRef.coordinatorEpoch !== event.epochRef.coordinatorEpoch ||
		event.payload.executionKey !== event.executionKey ||
		event.payload.runId !== event.idempotencyKey
	)
		fail("Learning refinement event binding is not internally consistent.");
}

function assertStateArtifact(
	artifact: LearningStateArtifact,
	event: RefinementCommit,
	artifactRef: WorkflowArtifactRef,
	priorStateDigest: string | null,
): void {
	if (
		artifact.schemaVersion !== LEARNING_RUNTIME_SCHEMA_VERSION ||
		artifact.kind !== "workflow_learning_state" ||
		artifact.workflowId !== event.workflowId ||
		artifact.operationId !== event.payload.runId ||
		!LEARNING_OPERATION_KINDS.has(artifact.operationKind) ||
		typeof artifact.resultIdentity !== "string" ||
		artifact.resultIdentity.length === 0 ||
		artifact.priorStateDigest !== priorStateDigest ||
		!sameHead(artifact.expectedHead, event.expectedHead) ||
		digestObject(artifact.epochRef) !== digestObject(event.epochRef) ||
		artifact.writerIdentity !== event.writerIdentity ||
		artifact.executionKey !== event.executionKey ||
		artifact.scorerAuthorityDigest !== scorerAuthorityDigest(artifact.scorerAuthority, artifact.epochRef) ||
		artifact.state.stateDigest.length === 0 ||
		artifactRef.sourceEventSequence !== event.sequence ||
		artifactRef.digest !== event.payload.refinementDigest ||
		artifact.semanticBindingDigest !== semanticBindingAnchor(event.semanticBinding) ||
		(artifact.operationKind === "review") !== (artifact.authorityReceipt !== null) ||
		(artifact.authorityReceipt === null) !== (artifact.authorityIntentRef === null) ||
		(artifact.authorityReceipt === null) !== (artifact.authorityReceiptBindingDigest === null) ||
		(artifact.authorityReceipt !== null &&
			artifact.authorityReceiptBindingDigest !== artifact.authorityReceipt.bindingDigest)
	) {
		fail("Learning state artifact is not bound to its authenticated refinement event.");
	}
	assertBoundedString(artifact.resultIdentity, "Learning operation result identity");
	if (artifact.authorityIntentRef !== null)
		assertArtifactRef(artifact.authorityIntentRef, "Learning authority intent artifact");
	if (artifact.authorityReceiptBindingDigest !== null) {
		assertDigest(artifact.authorityReceiptBindingDigest, "Learning authority receipt binding digest");
	}
	if (
		(artifact.operationKind === "experience" &&
			!artifact.state.experiences.some((experience) => experience.experienceId === artifact.resultIdentity)) ||
		(artifact.operationKind === "candidate" &&
			!artifact.state.candidates.some((record) => record.candidate.candidateId === artifact.resultIdentity)) ||
		(artifact.operationKind === "review" &&
			!artifact.state.reviews.some((review) => review.reviewId === artifact.resultIdentity)) ||
		(artifact.operationKind === "trigger" &&
			!artifact.state.triggers.some((trigger) => triggerIdentity(trigger) === artifact.resultIdentity)) ||
		(artifact.operationKind === "review_intent" && artifact.resultIdentity.length === 0)
	)
		fail("Learning operation result identity is not present in the authenticated state.");
	assertStateBounds(artifact.state);
}

function assertPersistedStateIdentity(state: WorkflowLearningState): void {
	for (const experience of state.experiences) {
		if (experience.workflowId.length === 0 || experience.source !== "host")
			fail("Persisted learning experience is not host-authenticated.");
	}
	for (const record of state.candidates) {
		if (
			record.candidate.scorecardDigest !== record.candidate.scorecardRef.digest ||
			record.candidate.evaluatorDigest !== record.candidate.evaluatorRef.digest
		)
			fail("Persisted candidate scorer artifacts are not content-bound.");
	}
	for (const review of state.reviews) {
		if (review.status === "promoted") {
			if (review.promotion === null) fail("Persisted promoted review has no promotion identity.");
			if (review.promotion.candidateId !== review.candidateId)
				fail("Persisted promotion candidate identity changed.");
		}
	}
	for (const proposal of state.rollbackProposals) {
		if (proposal.proposalDigest !== proposal.proposalRef.digest)
			fail("Persisted rollback proposal is not bound to exact artifact bytes.");
	}
}

function learningProjection(current: WorkflowLearningHostSnapshot): WorkflowLearningHostProjection {
	const projection: WorkflowLearningHostProjection = {
		workflowId: current.workflowId,
		stateDigest: current.stateDigest,
		workspaceDigest: current.workspaceDigest,
		configDigest: current.configDigest,
		parserDigest: current.parserDigest,
		evaluatorDigest: current.evaluatorDigest,
		guardDigest: current.guardDigest,
		revisions: structuredClone(current.revisions),
		currentRevision: current.currentRevision,
		trustedNow: current.trustedNow,
		requiredFreshnessMilliseconds: current.requiredFreshnessMilliseconds,
		baselineRevision: current.baselineRevision,
		baselineDigest: current.baselineDigest,
		evaluatorBaselineDigest: current.evaluatorBaselineDigest,
		metricBaselineDigest: current.metricBaselineDigest,
		revisionRegistryDigest: current.revisionRegistryDigest,
		storeEpoch: current.storeEpoch ?? 1,
		coordinatorEpoch: current.coordinatorEpoch ?? 1,
		stateHeadDigest: current.stateHeadDigest ?? "",
	};
	return immutable(projection);
}

function assertReplayedClassification(
	candidate: WorkflowLearningCandidate,
	classification: {
		readonly mutationClass: WorkflowLearningCandidate["mutationClass"];
		readonly payloadDigest: string;
		readonly classifierDigest: string;
		readonly protectedPaths: readonly string[];
	},
): void {
	if (
		classification.mutationClass !== candidate.mutationClass ||
		classification.payloadDigest !== candidate.candidateDigest
	)
		fail("Replayed candidate mutation classification changed.");
	assertBoundedString(classification.classifierDigest, "Replayed classifier digest");
	if (
		!Array.isArray(classification.protectedPaths) ||
		classification.protectedPaths.length > LEARNING_RUNTIME_MAX_REPLAY_EVENTS
	)
		fail("Replayed candidate protected paths are unbounded.");
	for (const path of classification.protectedPaths) {
		assertBoundedString(path, "Replayed candidate protected path");
		const parts = path.toLowerCase().replaceAll("\\", "/").split("/");
		if (["skill", "skills", "subagent", "subagents", "harness"].some((segment) => parts.includes(segment)))
			fail("Replayed protected mutation was misclassified.");
	}
}

async function assertPersistedScorerAndStageArtifacts(
	state: WorkflowLearningState,
	authority: WorkflowLearningScorerAuthority,
	resolver: WorkflowArtifactResolver,
	ports: WorkflowLearningPorts,
	current: WorkflowLearningHostSnapshot,
	allowHistoricalDecisionEpoch: boolean,
): Promise<void> {
	for (const experience of state.experiences) {
		const expectedBindingDigest = receiptBindingDigest(
			"committed_experience",
			{
				experienceId: experience.experienceId,
				workflowId: experience.workflowId,
				outcome: experience.outcome,
				progressKind: experience.progressKind,
				progressEvidenceRefs: experience.progressEvidenceRefs,
				evidenceDigest: experience.evidenceDigest,
				sourceEventRef: experience.sourceEventRef,
			},
			experience.hostReceipt,
		);
		await verifyHistoricalReceipt(
			current.receiptContext,
			experience.hostReceipt,
			experience.workflowId,
			expectedBindingDigest,
		);
	}
	for (const trigger of state.triggers) {
		const triggerReceipt = trigger.hostReceipt;
		if (triggerReceipt === undefined) fail("Persisted trigger is missing its host receipt.");
		const expectedBindingDigest = receiptBindingDigest("trigger", withoutWitnesses(trigger), triggerReceipt);
		await verifyHistoricalReceipt(current.receiptContext, triggerReceipt, trigger.workflowId!, expectedBindingDigest);
	}
	const candidates = new Map(state.candidates.map((record) => [record.candidate.candidateId, record.candidate]));
	for (const record of state.candidates) {
		assertCandidateAuthority(record.candidate, authority);
		await verifyHoldoutManifestArtifact(resolver, record.candidate);
		const candidateTriggers = state.triggers.filter(
			(trigger) => trigger.candidateId === record.candidate.candidateId || trigger.candidateId === null,
		);
		if (
			!candidateTriggers.some(
				(trigger) =>
					receiptBindingDigest(
						"typed_candidate",
						{ candidate: record.candidate, trigger },
						record.candidate.hostReceipt,
					) === record.candidate.hostReceipt.bindingDigest,
			)
		)
			fail("Persisted candidate receipt is not bound to its candidate and trigger.");
		await verifyHistoricalReceipt(
			current.receiptContext,
			record.candidate.hostReceipt,
			record.candidate.workflowId,
			record.candidate.hostReceipt.bindingDigest,
		);
		if (ports.host.classifyCandidate === undefined) fail("Replayed candidates require the host classifier.");
		const classification = await ports.host.classifyCandidate({
			candidate: immutable(record.candidate),
			current: learningProjection(current),
		});
		assertReplayedClassification(record.candidate, classification);
	}
	for (const review of state.reviews) {
		const candidate = candidates.get(review.candidateId);
		if (candidate === undefined) fail("Persisted review references an unknown candidate.");
		assertReviewAuthority(review, authority, allowHistoricalDecisionEpoch);
		await verifyTypedStageArtifact(resolver, review.shadow, "shadow", candidate.workflowId, candidate.candidateId);
		for (const receipt of review.shadow.receipts) {
			const expectedBindingDigest = receiptBindingDigest(
				"shadow_review",
				{ candidate, shadow: withoutWitnesses(review.shadow) },
				receipt,
			);
			await verifyHistoricalReceipt(current.receiptContext, receipt, candidate.workflowId, expectedBindingDigest);
		}
		if (review.canary !== null)
			await verifyTypedStageArtifact(resolver, review.canary, "canary", candidate.workflowId, candidate.candidateId);
		if (review.canary !== null) {
			for (const receipt of review.canary.receipts) {
				const expectedBindingDigest = receiptBindingDigest(
					"canary_review",
					{
						candidate,
						shadow: review.shadow,
						canary: withoutWitnesses(review.canary),
					},
					receipt,
				);
				await verifyHistoricalReceipt(current.receiptContext, receipt, candidate.workflowId, expectedBindingDigest);
			}
		}
		if (review.redTeam !== null)
			await verifyTypedStageArtifact(
				resolver,
				review.redTeam,
				"red_team",
				candidate.workflowId,
				candidate.candidateId,
			);
		if (review.redTeam !== null) {
			for (const receipt of review.redTeam.receipts) {
				const expectedBindingDigest = receiptBindingDigest(
					"independent_red_team",
					{
						candidate,
						shadow: review.shadow,
						canary: review.canary,
						redTeam: withoutWitnesses(review.redTeam),
					},
					receipt,
				);
				await verifyHistoricalReceipt(current.receiptContext, receipt, candidate.workflowId, expectedBindingDigest);
			}
		}
		if (review.promotion !== null) {
			if (review.decision === null || review.canary === null || review.redTeam === null)
				fail("Persisted promotion is missing its complete signed decision tuple.");
			const expectedBindingDigest = receiptBindingDigest(
				"host_fenced_promotion",
				{
					candidate,
					shadow: review.shadow,
					canary: review.canary,
					redTeam: review.redTeam,
					decision: review.decision,
					promotion: review.promotion,
				},
				review.promotion.receipt,
			);
			await verifyHistoricalReceipt(
				current.receiptContext,
				review.promotion.receipt,
				candidate.workflowId,
				expectedBindingDigest,
			);
		}
	}
	for (const proposal of state.rollbackProposals) {
		const candidate = candidates.get(proposal.candidateId);
		if (candidate === undefined) fail("Persisted rollback references an unknown candidate.");
		const promotedReview = [...state.reviews]
			.reverse()
			.find(
				(review) =>
					review.candidateId === proposal.candidateId && review.promotion?.revisionId === proposal.rollbackOf,
			);
		if (promotedReview?.decisionRef === null || promotedReview === undefined)
			fail("Persisted rollback is missing its promotion decision reference.");
		const triggers = state.triggers.filter((trigger) => trigger.candidateId === proposal.candidateId);
		const { application: _application, ...proposalIdentity } = proposal;
		if (
			!triggers.some(
				(trigger) =>
					receiptBindingDigest(
						"rollback_proposal",
						{ candidate, trigger, proposal: proposalIdentity, decisionRef: promotedReview.decisionRef },
						proposal.receipt,
					) === proposal.receipt.bindingDigest,
			)
		) {
			fail("Persisted rollback receipt is not bound to its candidate and trigger.");
		}
		await verifyHistoricalReceipt(
			current.receiptContext,
			proposal.receipt,
			candidate.workflowId,
			proposal.receipt.bindingDigest,
		);
	}
}

function semanticBindingAnchor(binding: WorkflowStoreCommitInput<RefinementPayload>["semanticBinding"]): string {
	return digestObject({
		mutationId: binding.mutationId,
		expectedHead: binding.expectedHead,
		epochRef: binding.epochRef,
		leaseRef: binding.leaseRef,
		writerIdentity: binding.writerIdentity,
		executionKey: binding.executionKey,
		idempotencyKey: binding.idempotencyKey,
	});
}

function buildSemanticBinding(
	binding: WorkflowLearningRuntimeBinding,
	operationIdValue: string,
	payload: RefinementPayload,
): WorkflowStoreCommitInput<RefinementPayload>["semanticBinding"] {
	const baselineDigest = digestObject(binding.expectedHead);
	return {
		mutationId: operationIdValue,
		baselineDigest,
		expectedGenerations: structuredClone(binding.expectedGenerations),
		ownerId: binding.ownerId,
		phase: binding.phase,
		reducerDigest: digestObject({
			kind: payload.kind,
			refinementDigest: payload.refinementDigest,
			evidenceRefs: payload.evidenceRefs,
		}),
		semanticHead: {
			workflowId: binding.workflowId,
			sequence: binding.expectedHead.sequence,
			eventDigest: binding.expectedHead.eventDigest,
			stateDigest: binding.semanticStateDigest,
			epochRef: binding.epochRef,
			generation: binding.epochRef.storeEpoch,
		},
		expectedHead: binding.expectedHead,
		idempotencyKey: operationIdValue,
		executionKey: binding.executionKey,
		writerIdentity: binding.writerIdentity,
		leaseRef: binding.leaseRef,
		epochRef: binding.epochRef,
	};
}

/**
 * Open a durable learning adapter over one authenticated workflow runtime store.
 *
 * Args:
 * options: Existing controller ports plus host-owned runtime binding and artifact resolver.
 * Return: Public learning operations backed by replayed content-addressed state artifacts.
 */
export async function createWorkflowLearningRuntimeAdapter(
	options: WorkflowLearningRuntimeAdapterOptions,
): Promise<WorkflowLearningRuntimeAdapter> {
	const { authority, ports } = options;
	const runtime = authority.runtimeStore;
	if (runtime.identity.storeKind !== "workflow") fail("Learning runtime requires a workflow store.");
	if (runtime.durableContext === undefined) fail("Learning runtime requires a durable workflow store.");
	const controllerPorts: WorkflowLearningPorts = { ...ports, eventSink: undefined };
	let controller = createWorkflowLearningController({ ports: controllerPorts });
	let activeAuthorityOperationId: string | undefined;

	const readBinding = async (
		operationId = activeAuthorityOperationId,
	): Promise<{
		binding: WorkflowLearningRuntimeBinding;
		current: WorkflowLearningHostSnapshot;
	}> => {
		const binding = await authority.readBinding(operationId);
		const current = await ports.host.current();
		if (binding.workflowId !== runtime.identity.workflowId || current.workflowId !== binding.workflowId)
			fail("Learning runtime workflow binding is invalid.");
		assertHead(binding.expectedHead, binding.workflowId);
		assertEpoch(binding.epochRef, "Learning runtime epoch");
		assertDigest(binding.semanticStateDigest, "Learning runtime semantic state digest");
		assertLease(binding.leaseRef, binding.workflowId, binding.writerIdentity, binding.epochRef);
		if (
			binding.expectedHead.epochRef.storeEpoch !== binding.epochRef.storeEpoch ||
			binding.expectedHead.epochRef.coordinatorEpoch !== binding.epochRef.coordinatorEpoch ||
			(binding.expectedHead.eventDigest !== null && binding.expectedHead.sequence === 0)
		)
			fail("Learning runtime head is not monotonic.");
		if (current.storeEpoch !== binding.epochRef.storeEpoch)
			fail("Learning host snapshot store epoch is stale or missing.");
		if (current.coordinatorEpoch !== binding.epochRef.coordinatorEpoch)
			fail("Learning host snapshot coordinator epoch is stale or missing.");
		if (current.stateHeadDigest !== binding.semanticStateDigest)
			fail("Learning host snapshot semantic head is stale or missing.");
		await resolveAndVerifyWorkflowHostReceipt({
			context: current.receiptContext,
			workflowId: binding.workflowId,
			expectedBindingDigest: current.trustedClockReceipt.bindingDigest,
			receipt: current.trustedClockReceipt,
			currentStateDigest: current.stateDigest,
			currentRevision: current.currentRevision,
			trustedNow: current.trustedNow,
		});
		await assertApprovedAuthority(
			binding.approvedAuthority,
			binding,
			current,
			authority.artifactResolver,
			operationId,
		);
		return { binding, current };
	};

	const readBoundReplay = async () => {
		for (let attempt = 1; attempt <= LEARNING_RUNTIME_HEAD_REBASE_LIMIT; attempt += 1) {
			const { binding, current } = await readBinding();
			const replayed = await runtime.replay({
				workflowId: binding.workflowId,
				fromSequence: 1,
				expectedStoreEpoch: binding.epochRef.storeEpoch,
			});
			if (replayed.quarantined) fail("Learning runtime replay is quarantined.");
			if (sameHead(replayed.head, binding.expectedHead)) return { binding, current, replayed };
		}
		return fail("Learning runtime replay head rebase was exhausted.");
	};

	const consumeAuthorityForOperation = async (
		operationIdValue: string,
	): Promise<{
		binding: WorkflowLearningRuntimeBinding;
		current: WorkflowLearningHostSnapshot;
		receipt: WorkflowVerifiedHostReceipt;
		intentRef: WorkflowArtifactRef;
	}> => {
		const { binding, current } = await readBinding(operationIdValue);
		const authorityReceipt = binding.approvedAuthority.receipt;
		const intent: LearningAuthorityIntentArtifact = {
			schemaVersion: LEARNING_RUNTIME_SCHEMA_VERSION,
			kind: "workflow_learning_authority_intent",
			workflowId: binding.workflowId,
			operationId: operationIdValue,
			expectedHead: binding.expectedHead,
			epochRef: binding.epochRef,
			authorityReceipt: authorityReceipt,
		};
		const intentBytes = canonicalJsonBytes(intent);
		const published = await runtime.publishArtifact(
			{
				workflowId: binding.workflowId,
				payloadKind: "evidence",
				bytes: intentBytes,
				codec: "canonical_json",
				sourceEventSequence: 0,
				idempotencyKey: `learning:authority-intent:${operationIdValue}`,
			},
			authority.crashHook,
		);
		const intentRef = published.envelope.ref;
		if (intentRef.digest !== sha256Hex(intentBytes) || intentRef.sizeBytes !== intentBytes.byteLength)
			fail("Learning authority intent publication changed its canonical digest.");
		let consumed = false;
		try {
			const witness = await current.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: authorityReceipt.receiptId,
				workflowId: binding.workflowId,
				expectedBindingDigest: authorityReceipt.bindingDigest,
			});
			if (
				witness.receiptId !== authorityReceipt.receiptId ||
				witness.workflowId !== binding.workflowId ||
				witness.bindingDigest !== authorityReceipt.bindingDigest
			)
				fail("Learning authority receipt consumption witness is not bound to its operation.");
			consumed = true;
		} catch (_error: unknown) {
			consumed = false;
		}
		if (!consumed) {
			await current.receiptContext.receiptResolver.consumeIfOneUse({
				receipt: authorityReceipt,
				workflowId: binding.workflowId,
				expectedBindingDigest: authorityReceipt.bindingDigest,
				currentRevision: current.currentRevision,
			});
			const witness = await current.receiptContext.receiptResolver.resolveConsumptionWitness({
				receiptId: authorityReceipt.receiptId,
				workflowId: binding.workflowId,
				expectedBindingDigest: authorityReceipt.bindingDigest,
			});
			if (
				witness.receiptId !== authorityReceipt.receiptId ||
				witness.workflowId !== binding.workflowId ||
				witness.bindingDigest !== authorityReceipt.bindingDigest
			)
				fail("Learning authority receipt consumption witness is not bound to its operation.");
		}
		return { binding, current, receipt: structuredClone(authorityReceipt), intentRef };
	};

	const replay = async (): Promise<WorkflowLearningState> => {
		const { binding, current, replayed } = await readBoundReplay();
		const parsed: PersistedLearningEvent[] = [];
		let priorStateDigest: string | null = initialLearningState().stateDigest;
		let priorHead: WorkflowJournalHead | null = null;
		let priorEventKind: WorkflowEventPayload["kind"] | null = null;
		let refinementCount = 0;
		const operationIds = new Set<string>();
		for (const event of replayed.events) {
			if (
				priorHead !== null &&
				!acceptsEventHead(event.expectedHead, priorHead, event.payload.kind, event.epochRef, priorEventKind)
			) {
				fail("Learning workflow event chain has a stale head.");
			}
			priorHead = commitHead(event);
			priorEventKind = event.payload.kind;
			if (event.payload.kind !== "refinement_recorded") continue;
			refinementCount += 1;
			if (refinementCount > LEARNING_RUNTIME_MAX_REPLAY_EVENTS) fail("Learning runtime event history is unbounded.");
			const refinementEvent = event as RefinementCommit;
			assertRefinementPayload(refinementEvent.payload, binding);
			assertRefinementEventBinding(refinementEvent, binding);
			if (operationIds.has(refinementEvent.payload.runId))
				fail("Learning runtime operation identity was duplicated.");
			operationIds.add(refinementEvent.payload.runId);
			const ref = refinementEvent.payload.evidenceRefs[0]!;
			const resolved = await authority.artifactResolver.resolve(ref);
			if (
				!resolved.exists ||
				!resolved.envelope.immutable ||
				!sameRef(resolved.envelope.ref, ref) ||
				resolved.verifiedDigest !== ref.digest ||
				resolved.verifiedSizeBytes !== ref.sizeBytes ||
				sha256Hex(resolved.bytes) !== ref.digest
			)
				fail("Learning refinement state artifact failed resolver verification.");
			const parsedArtifact = parseCanonicalJsonBytes(
				new Uint8Array(resolved.bytes),
			) as unknown as LearningStateArtifact;
			assertStateArtifact(parsedArtifact, refinementEvent, ref, priorStateDigest);
			assertPersistedStateIdentity(parsedArtifact.state);
			await assertPersistedScorerAndStageArtifacts(
				parsedArtifact.state,
				parsedArtifact.scorerAuthority,
				authority.artifactResolver,
				ports,
				current,
				true,
			);
			const artifactRefs = new Map<string, WorkflowArtifactRef>();
			collectArtifactRefs(parsedArtifact.state, artifactRefs);
			for (const candidateRef of artifactRefs.values())
				await verifyArtifact(authority.artifactResolver, candidateRef, "Learning replay artifact");
			const receipts = new Map<string, WorkflowVerifiedHostReceipt>();
			collectReceipts(parsedArtifact.state, receipts);
			for (const receipt of receipts.values()) {
				if (!parsedArtifact.state.consumedReceiptIds.includes(receipt.receiptId))
					fail("Persisted learning receipt was not durably consumed.");
				await verifyHistoricalReceipt(current.receiptContext, receipt, binding.workflowId);
			}
			if (parsedArtifact.authorityReceipt !== null) {
				if (parsedArtifact.authorityIntentRef === null) fail("Learning authority intent artifact is missing.");
				await verifyArtifact(
					authority.artifactResolver,
					parsedArtifact.authorityIntentRef,
					"Learning authority intent artifact",
				);
				const intentResolved = await authority.artifactResolver.resolve(parsedArtifact.authorityIntentRef);
				const intent = parseCanonicalJsonBytes(new Uint8Array(intentResolved.bytes));
				assertAuthorityIntentArtifact(
					intent,
					binding.workflowId,
					parsedArtifact.operationId,
					parsedArtifact.expectedHead,
					parsedArtifact.epochRef,
				);
				if (digestObject(intent.authorityReceipt) !== digestObject(parsedArtifact.authorityReceipt))
					fail("Learning authority receipt changed between intent and effect artifacts.");
				await verifyHistoricalReceipt(
					current.receiptContext,
					parsedArtifact.authorityReceipt,
					binding.workflowId,
					parsedArtifact.authorityReceiptBindingDigest ?? parsedArtifact.authorityReceipt.bindingDigest,
				);
			}
			createWorkflowLearningControllerFromDurableState({ ports: controllerPorts, state: parsedArtifact.state });
			parsed.push({
				event: refinementEvent,
				state: parsedArtifact.state,
				artifact: parsedArtifact,
				artifactRef: ref,
			});
			priorStateDigest = parsedArtifact.state.stateDigest;
		}
		const state = selectLatestState(parsed);
		assertStateBounds(state);
		return immutable(state);
	};

	const refreshController = async (): Promise<WorkflowLearningState> => {
		const state = await replay();
		if (controller.getState().stateDigest !== state.stateDigest)
			controller = createWorkflowLearningControllerFromDurableState({ ports: controllerPorts, state });
		return state;
	};

	const persist = async (
		kind: LearningOperationKind,
		operationIdValue: string,
		resultIdentity: string,
		state: WorkflowLearningState,
		authorityReceipt: WorkflowVerifiedHostReceipt | null,
		authorityIntentRef: WorkflowArtifactRef | null,
		scorerAuthority: WorkflowLearningScorerAuthority,
	): Promise<void> => {
		assertStateBounds(state);
		for (let attempt = 1; attempt <= LEARNING_RUNTIME_HEAD_REBASE_LIMIT; attempt += 1) {
			const { binding } = await readBinding();
			const previous = await replay();
			if (previous.stateDigest === state.stateDigest) return;
			const payloadBase = {
				kind: "refinement_recorded" as const,
				workflowId: binding.workflowId,
				epochRef: binding.epochRef,
				executionKey: binding.executionKey,
				runId: operationIdValue,
				refinementDigest: "",
				scope: "session" as const,
				evidenceRefs: [] as readonly WorkflowArtifactRef[],
			};
			const semanticBindingDigest = semanticBindingAnchor({
				mutationId: operationIdValue,
				baselineDigest: digestObject(binding.expectedHead),
				expectedGenerations: binding.expectedGenerations,
				ownerId: binding.ownerId,
				phase: binding.phase,
				reducerDigest: "",
				semanticHead: {
					workflowId: binding.workflowId,
					sequence: binding.expectedHead.sequence,
					eventDigest: binding.expectedHead.eventDigest,
					stateDigest: binding.semanticStateDigest,
					epochRef: binding.epochRef,
					generation: binding.epochRef.storeEpoch,
				},
				expectedHead: binding.expectedHead,
				idempotencyKey: operationIdValue,
				executionKey: binding.executionKey,
				writerIdentity: binding.writerIdentity,
				leaseRef: binding.leaseRef,
				epochRef: binding.epochRef,
			});
			const provisionalArtifact: LearningStateArtifact = {
				schemaVersion: LEARNING_RUNTIME_SCHEMA_VERSION,
				kind: "workflow_learning_state",
				workflowId: binding.workflowId,
				operationId: operationIdValue,
				operationKind: kind,
				resultIdentity,
				priorStateDigest: previous.stateDigest,
				expectedHead: binding.expectedHead,
				epochRef: binding.epochRef,
				writerIdentity: binding.writerIdentity,
				executionKey: binding.executionKey,
				semanticBindingDigest,
				scorerAuthorityDigest: scorerAuthorityDigest(scorerAuthority),
				scorerAuthority: structuredClone(scorerAuthority),
				authorityIntentRef,
				authorityReceipt,
				authorityReceiptBindingDigest: authorityReceipt?.bindingDigest ?? null,
				state,
			};
			const stateBytes = canonicalJsonBytes(provisionalArtifact);
			if (stateBytes.byteLength > LEARNING_RUNTIME_MAX_ARTIFACT_BYTES) fail("Learning state artifact is too large.");
			const stateDigest = sha256Hex(stateBytes);
			const sourceSequence = binding.expectedHead.sequence + 1;
			const published = await runtime.publishArtifact(
				{
					workflowId: binding.workflowId,
					payloadKind: "evidence",
					bytes: stateBytes,
					codec: "canonical_json",
					sourceEventSequence: sourceSequence,
					idempotencyKey: `${operationIdValue}:${digestObject(binding.expectedHead)}`,
				},
				authority.crashHook,
			);
			const artifactRef = published.envelope.ref;
			if (artifactRef.digest !== stateDigest || artifactRef.sizeBytes !== stateBytes.byteLength)
				fail("Learning state artifact publication changed its canonical digest or size.");
			const payload = { ...payloadBase, refinementDigest: stateDigest, evidenceRefs: [artifactRef] };
			const semanticBinding = buildSemanticBinding(binding, operationIdValue, payload);
			try {
				const committed = await runtime.commit({
					workflowId: binding.workflowId,
					payload,
					expectedHead: binding.expectedHead,
					semanticBinding,
					epochRef: binding.epochRef,
					leaseRef: binding.leaseRef,
					idempotencyKey: operationIdValue,
					writerIdentity: binding.writerIdentity,
					executionKey: binding.executionKey,
					crashHook: authority.crashHook,
				});
				if (committed.payload.refinementDigest !== stateDigest || committed.commit.sequence !== sourceSequence)
					fail("Learning refinement commit did not return the authenticated state artifact.");
				if (semanticBindingDigest !== semanticBindingAnchor(committed.commit.semanticBinding))
					fail("Learning refinement semantic binding changed during commit.");
				const after = await replay();
				if (after.stateDigest !== state.stateDigest) fail("Learning refinement readback did not preserve state.");
				return;
			} catch (error) {
				if (!isStaleLearningRuntimeCommit(error)) throw error;
				if (attempt === LEARNING_RUNTIME_HEAD_REBASE_LIMIT)
					fail("Learning runtime commit head rebase was exhausted.");
			}
		}
		fail("Learning runtime commit head rebase was exhausted.");
	};

	const run = async <T>(operation: RuntimeOperation<T>): Promise<T> => {
		const execute = async (): Promise<T> => {
			activeAuthorityOperationId = operation.kind === "review" ? operation.operationId : undefined;
			try {
				const operationEvents = await readPersistedEvents();
				const existing = findEventByOperation(operationEvents, operation.operationId);
				if (existing !== undefined) {
					await refreshController();
					if (operation.validateExisting !== undefined) await operation.validateExisting(controller);
					const selected = operation.select(existing.state, existing.artifact.resultIdentity);
					if (selected === undefined) fail("Learning runtime idempotency record has no result.");
					return immutable(selected);
				}
				const authority =
					operation.kind === "review" ? await consumeAuthorityForOperation(operation.operationId) : null;
				const authorityReceipt = authority?.receipt ?? null;
				await refreshController();
				const result = await operation.invoke(controller);
				const state = controller.getState();
				const scorerAuthority =
					authority?.binding.approvedAuthority === undefined
						? withoutAuthorityReceipt((await readBinding()).binding.approvedAuthority)
						: withoutAuthorityReceipt(authority.binding.approvedAuthority);
				await persist(
					operation.kind,
					operation.operationId,
					operation.resultIdentity(result),
					state,
					authorityReceipt,
					authority?.intentRef ?? null,
					scorerAuthority,
				);
				const selected = operation.select(state, operation.resultIdentity(result));
				if (selected === undefined) return immutable(result);
				return immutable(selected);
			} finally {
				activeAuthorityOperationId = undefined;
			}
		};
		const durable = runtime.durableContext;
		if (durable === undefined) fail("Learning runtime requires a durable workflow store.");
		return durable.withExclusiveLease(`learning-runtime:${operation.kind}`, execute);
	};

	const readPersistedEvents = async (): Promise<readonly PersistedLearningEvent[]> => {
		const { binding, current, replayed } = await readBoundReplay();
		const result: PersistedLearningEvent[] = [];
		let priorStateDigest: string | null = initialLearningState().stateDigest;
		let priorHead: WorkflowJournalHead | null = null;
		let priorEventKind: WorkflowEventPayload["kind"] | null = null;
		const operationIds = new Set<string>();
		for (const event of replayed.events) {
			if (
				priorHead !== null &&
				!acceptsEventHead(event.expectedHead, priorHead, event.payload.kind, event.epochRef, priorEventKind)
			)
				fail("Learning workflow event chain has a stale head.");
			priorHead = commitHead(event);
			priorEventKind = event.payload.kind;
			if (event.payload.kind !== "refinement_recorded") continue;
			const refinementEvent = event as RefinementCommit;
			assertRefinementPayload(refinementEvent.payload, binding);
			assertRefinementEventBinding(refinementEvent, binding);
			if (operationIds.has(refinementEvent.payload.runId))
				fail("Learning runtime operation identity was duplicated.");
			operationIds.add(refinementEvent.payload.runId);
			const ref = refinementEvent.payload.evidenceRefs[0];
			if (ref === undefined) fail("Learning refinement event is missing state artifact.");
			await verifyArtifact(authority.artifactResolver, ref, "Learning refinement state artifact");
			const resolved = await authority.artifactResolver.resolve(ref);
			const parsed = parseCanonicalJsonBytes(new Uint8Array(resolved.bytes));
			const artifact = parsed as unknown as LearningStateArtifact;
			if (
				canonicalJsonBytes(parsed).byteLength !== resolved.bytes.byteLength ||
				canonicalJsonBytes(parsed).some((byte, index) => byte !== resolved.bytes[index])
			)
				fail("Learning state artifact is not canonical JSON.");
			assertStateArtifact(artifact, refinementEvent, ref, priorStateDigest);
			assertPersistedStateIdentity(artifact.state);
			await assertPersistedScorerAndStageArtifacts(
				artifact.state,
				artifact.scorerAuthority,
				authority.artifactResolver,
				ports,
				current,
				true,
			);
			const artifactRefs = new Map<string, WorkflowArtifactRef>();
			collectArtifactRefs(artifact.state, artifactRefs);
			for (const candidateRef of artifactRefs.values())
				await verifyArtifact(authority.artifactResolver, candidateRef, "Learning replay artifact");
			const receipts = new Map<string, WorkflowVerifiedHostReceipt>();
			collectReceipts(artifact.state, receipts);
			for (const receipt of receipts.values()) {
				if (!artifact.state.consumedReceiptIds.includes(receipt.receiptId))
					fail("Persisted learning receipt was not durably consumed.");
				await verifyHistoricalReceipt(current.receiptContext, receipt, binding.workflowId);
			}
			if (artifact.authorityReceipt !== null) {
				if (artifact.authorityIntentRef === null) fail("Learning authority intent artifact is missing.");
				await verifyArtifact(
					authority.artifactResolver,
					artifact.authorityIntentRef,
					"Learning authority intent artifact",
				);
				const intentResolved = await authority.artifactResolver.resolve(artifact.authorityIntentRef);
				const intent = parseCanonicalJsonBytes(new Uint8Array(intentResolved.bytes));
				assertAuthorityIntentArtifact(
					intent,
					binding.workflowId,
					artifact.operationId,
					artifact.expectedHead,
					artifact.epochRef,
				);
				if (digestObject(intent.authorityReceipt) !== digestObject(artifact.authorityReceipt))
					fail("Learning authority receipt changed between intent and effect artifacts.");
				await verifyHistoricalReceipt(
					current.receiptContext,
					artifact.authorityReceipt,
					binding.workflowId,
					artifact.authorityReceiptBindingDigest ?? artifact.authorityReceipt.bindingDigest,
				);
			}
			createWorkflowLearningControllerFromDurableState({ ports: controllerPorts, state: artifact.state });
			result.push({ event: refinementEvent, state: artifact.state, artifact, artifactRef: ref });
			priorStateDigest = artifact.state.stateDigest;
		}
		return result;
	};

	return {
		commitExperience: (input) => {
			const frozenInput = immutable(input);
			return run({
				kind: "experience",
				operationId: operationId("experience", {
					experienceId: frozenInput.experienceId,
					workflowId: frozenInput.workflowId,
					progressEvidenceRefs: frozenInput.progressEvidenceRefs,
					sourceEventRef: frozenInput.sourceEventRef,
				}),
				invoke: (active) => active.commitExperience(frozenInput),
				resultIdentity: (result) => result.experienceId,
				select: (state, resultIdentity) =>
					state.experiences.find((experience) => experience.experienceId === resultIdentity),
			});
		},
		typeCandidate: (input) => {
			const frozenInput = immutable(input);
			return run({
				kind: "candidate",
				operationId: operationId("candidate", frozenInput),
				invoke: async (active) => {
					const candidate = await active.typeCandidate(frozenInput);
					const { binding } = await readBinding();
					assertCandidateAuthority(candidate, binding.approvedAuthority);
					return candidate;
				},
				resultIdentity: (result) => result.candidateId,
				select: (state, resultIdentity) =>
					state.candidates.find((record) => record.candidate.candidateId === resultIdentity)?.candidate,
			});
		},
		reviewCandidate: (candidateId) => {
			const frozenCandidateId = immutable(candidateId);
			return run({
				kind: "review",
				operationId: operationId("review", { candidateId: frozenCandidateId }),
				invoke: async (active) => {
					const review = await active.reviewCandidate(
						frozenCandidateId,
						operationId("review", { candidateId: frozenCandidateId }),
					);
					const { binding } = await readBinding();
					assertReviewAuthority(review, binding.approvedAuthority);
					await verifyTypedStageArtifact(
						authority.artifactResolver,
						review.shadow,
						"shadow",
						binding.workflowId,
						frozenCandidateId,
					);
					if (review.canary !== null) {
						await verifyTypedStageArtifact(
							authority.artifactResolver,
							review.canary,
							"canary",
							binding.workflowId,
							frozenCandidateId,
						);
					}
					if (review.redTeam !== null) {
						await verifyTypedStageArtifact(
							authority.artifactResolver,
							review.redTeam,
							"red_team",
							binding.workflowId,
							frozenCandidateId,
						);
					}
					return review;
				},
				resultIdentity: (result) => result.reviewId,
				select: (state, resultIdentity) => state.reviews.find((review) => review.reviewId === resultIdentity),
			});
		},
		handleTrigger: (trigger) => {
			const frozenTrigger = immutable(trigger);
			return run({
				kind: "trigger",
				operationId: operationId("trigger", frozenTrigger),
				invoke: (active) => active.handleTrigger(frozenTrigger),
				resultIdentity: (result) => triggerIdentity(result.trigger),
				validateExisting: async (active) => {
					await active.handleTrigger(frozenTrigger);
				},
				select: (state, resultIdentity) => {
					const identity = resultIdentity ?? triggerIdentity(frozenTrigger);
					const recorded = [...state.triggers].reverse().find((item) => triggerIdentity(item) === identity);
					if (recorded === undefined) return undefined;
					if (recorded.kind === "regression" && recorded.candidateId !== null) {
						const proposal = [...state.rollbackProposals]
							.reverse()
							.find((item) => item.candidateId === recorded.candidateId);
						if (proposal !== undefined)
							return { status: "rollback_proposed" as const, trigger: recorded, proposal };
					}
					return { status: "queued" as const, trigger: recorded };
				},
			});
		},
		replay,
		getState: replay,
	};
}

/**
 * Construct learning with mandatory durable promotion and rollback effects.
 *
 * Args:
 * options: Persisted session host, canonical learning ports, runtime binding,
 *   and effect authority backed by that host's exact runtime store.
 * Return: Durable learning adapter whose mutation effects use the supplied
 *   host authority.
 */
export async function createWorkflowLearningRuntimeAdapterWithDurableEffects(
	options: WorkflowLearningRuntimeAdapterWithDurableEffectsOptions,
): Promise<WorkflowLearningRuntimeAdapter> {
	const hostBinding = resolveWorkflowLearningSessionHostIdentity(options.host);
	const effectAuthority = options.effectAuthority;
	if (effectAuthority === undefined || effectAuthority === null)
		fail("Learning durable effect authority is required; unavailable effects are not permitted.");
	if (effectAuthority.runtimeStore !== hostBinding.runtimeStore)
		fail("Learning durable effect authority must use the session host runtime store.");
	if (effectAuthority.durableContext !== hostBinding.durableContext)
		fail("Learning durable effect authority must use the session host durable context.");
	if (effectAuthority.runtimeStore.durableContext !== effectAuthority.durableContext)
		fail("Learning durable effect authority context is not owned by its runtime store.");
	for (const method of ["reconcilePromotion", "promote", "proposeRollback", "applyRollback"] as const) {
		if (typeof effectAuthority[method] !== "function")
			fail(`Learning durable effect authority method ${method} is required.`);
	}
	const durableHost: WorkflowLearningHost = {
		...options.ports.host,
		reconcilePromotion: (input) => effectAuthority.reconcilePromotion(input),
		promote: (input) => effectAuthority.promote(input),
		proposeRollback: (input) => effectAuthority.proposeRollback(input),
		applyRollback: (input) => effectAuthority.applyRollback(input),
	};
	return createWorkflowLearningRuntimeAdapterForSessionHost({
		host: options.host,
		ports: { ...options.ports, host: durableHost },
		artifactResolver: options.artifactResolver,
		readBinding: options.readBinding,
		crashHook: options.crashHook,
	});
}

/**
 * Construct learning only over the exact runtime store opened by a persisted session host.
 *
 * Args:
 * options: Persisted session host, canonical artifact resolver, binding reader, and host ports.
 * Return: Durable learning adapter bound to the host's runtime store.
 */
export async function createWorkflowLearningRuntimeAdapterForSessionHost(
	options: WorkflowLearningSessionHostAdapterOptions,
): Promise<WorkflowLearningRuntimeAdapter> {
	const hostBinding = resolveWorkflowLearningSessionHostIdentity(options.host);
	return createWorkflowLearningRuntimeAdapter({
		ports: options.ports,
		authority: {
			runtimeStore: hostBinding.runtimeStore,
			artifactResolver: options.artifactResolver,
			readBinding: options.readBinding,
			crashHook: options.crashHook,
		},
	});
}
