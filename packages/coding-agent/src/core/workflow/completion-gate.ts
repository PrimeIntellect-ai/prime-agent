import { randomUUID } from "node:crypto";
import {
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactReadResult,
	type WorkflowArtifactRef,
	type WorkflowArtifactResolver,
	type WorkflowCanonicalJsonObject,
	type WorkflowCanonicalJsonValue,
	type WorkflowCompletionCapacityReconciliation,
	type WorkflowCompletionReadinessReceipt,
	type WorkflowCompletionUsageReconciliation,
	type WorkflowControlCapacityVector,
	type WorkflowDecisionRecord,
	type WorkflowDecisionRef,
	type WorkflowEpochRef,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowPhaseOutcomeRecord,
	type WorkflowResourceGrantLedger,
	type WorkflowResourceVector,
	type WorkflowStatus,
	type WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { type WorkflowState, WorkflowStore } from "./reducer.js";
import { assertFiniteWorkflowControlCapacity, assertFiniteWorkflowResourceVector } from "./resources.js";

export interface WorkflowCompletionDigestSources {
	objective: WorkflowCanonicalJsonValue;
	hardenedContract: WorkflowCanonicalJsonValue;
	completeRequirementUniverse: WorkflowCanonicalJsonValue;
	fixedBaseline: WorkflowCanonicalJsonValue;
	capacityLedger: WorkflowCanonicalJsonValue;
	hiddenFailure: WorkflowCanonicalJsonValue;
	requirementEvidence: WorkflowCanonicalJsonValue;
}

/** Canonical receipt-binding fields shared by readiness and adjudication issuers. */
export interface WorkflowCompletionReceiptBindingInput {
	workflowId: string;
	inputStateDigest: string;
	headSequence: number;
	epochRef: WorkflowEpochRef;
	outcomeDigest: string;
	outputDigest: string;
	evidenceDigest: string;
	requirementEvidenceDigest: string;
	objectiveDigest: string;
	hardenedContractDigest: string;
	completeRequirementUniverseDigest: string;
	fixedBaselineDigest: string;
	capacityLedgerDigest: string;
	hiddenFailureDigest: string;
	usageReconciliationRef: WorkflowArtifactRef;
	capacityReconciliationRef: WorkflowArtifactRef;
	freshVerifierDecisionRef: WorkflowDecisionRef;
	independentRedTeamDecisionRef: WorkflowDecisionRef;
}

/**
 * Computes the non-self-referential binding for the completion readiness receipt.
 *
 * Args:
 * input: Current workflow head and canonical readiness closure.
 * Return: Digest used as the host-readiness receipt binding.
 */
export function workflowCompletionReadinessReceiptBindingDigest(input: WorkflowCompletionReceiptBindingInput): string {
	return digestObject({ kind: "workflow_completion_readiness_receipt", version: 1, ...input });
}

/**
 * Computes the non-self-referential binding for the completion adjudication receipt.
 *
 * Receipt identity, payload digest, and artifact reference are intentionally excluded;
 * the issuer must be able to publish and independently verify the signed receipt.
 *
 * Args:
 * input: Current workflow head and canonical readiness closure.
 * Return: Digest used as the adjudication receipt binding.
 */
export function workflowCompletionAdjudicationReceiptBindingDigest(
	input: WorkflowCompletionReceiptBindingInput,
): string {
	return digestObject({ kind: "workflow_completion_adjudication_receipt", version: 1, ...input });
}

/** Canonical non-self-referential fields for a per-decision host adjudication receipt. */
export interface WorkflowCompletionDecisionAdjudicationBindingInput {
	workflowId: string;
	rootSessionId: string;
	role: "verifier" | "red_team";
	decisionId: string;
	decisionRevision: number;
	inputStateDigest: string;
	epochRef: WorkflowEpochRef;
	targetDigest: string;
	effectDigest: string;
	preconditionDigest: string;
	planDigest: string;
	attemptToken: string;
	nonce: string;
	executionKey: string;
	proposerSessionId: string;
	verifierSessionId: string;
	synthesizerSessionId: string;
	redTeamSessionId: string;
	hostSessionId: string;
	hostExecutionIdentity: string;
	operationDigest: string;
	disposition: "accepted";
}

/**
 * Computes the canonical per-decision adjudication binding independently of its receipt.
 *
 * Receipt identity, payload digest, artifact reference, and decision digest are excluded so
 * the host can issue and later verify the signed receipt without a circular preimage.
 *
 * Args:
 * input: Authenticated decision identity, attempt, state, and host-adjudication tuple.
 * Return: Digest required in the independently signed decision adjudication receipt.
 */
export function workflowCompletionDecisionAdjudicationBindingDigest(
	input: WorkflowCompletionDecisionAdjudicationBindingInput,
): string {
	return digestObject({ kind: "workflow_completion_decision_adjudication", version: 1, ...input });
}

/** Canonical non-self-referential fields for a usage reconciliation receipt. */
export interface WorkflowCompletionUsageReceiptBindingInput {
	workflowId: string;
	inputStateDigest: string;
	outputStateDigest: string;
	resourceUsage: WorkflowResourceVector;
	controlUsage: WorkflowControlCapacityVector;
	spendMicrounits: number;
	grantLedgerRef: WorkflowArtifactRef;
	grantLedgerDigest: string;
	approvedEnvelopeDigest: string;
	goalBudgetDigest: string;
}

/** Computes the usage reconciliation receipt binding without artifact self-reference. */
export function workflowCompletionUsageReceiptBindingDigest(input: WorkflowCompletionUsageReceiptBindingInput): string {
	return digestObject({ kind: "workflow_completion_usage_receipt", version: 1, ...input });
}

/** Canonical non-self-referential fields for a capacity reconciliation receipt. */
export interface WorkflowCompletionCapacityReceiptBindingInput {
	workflowId: string;
	inputStateDigest: string;
	outputStateDigest: string;
	capacityVector: WorkflowResourceVector;
	controlCapacity: WorkflowControlCapacityVector;
	canonicalLedgerRef: WorkflowArtifactRef;
	canonicalLedgerDigest: string;
	approvedEnvelopeDigest: string;
	capacityCasDigest: string;
}

/** Computes the capacity reconciliation receipt binding without artifact self-reference. */
export function workflowCompletionCapacityReceiptBindingDigest(
	input: WorkflowCompletionCapacityReceiptBindingInput,
): string {
	return digestObject({ kind: "workflow_completion_capacity_receipt", version: 1, ...input });
}

export interface WorkflowCompletionReadinessResolverInput {
	workflowId: string;
	inputStateDigest: string;
	epochRef: WorkflowEpochRef;
	outcome: WorkflowPhaseOutcomeRecord;
	currentState: WorkflowState;
}

export interface WorkflowCompletionDecisionResolverInput {
	workflowId: string;
	decisionRef: WorkflowDecisionRef;
	inputStateDigest: string;
	epochRef: WorkflowEpochRef;
	currentRevision: number;
}

export interface WorkflowCompletionDigestSourceResolverInput {
	workflowId: string;
	inputStateDigest: string;
	outputStateDigest: string;
	epochRef: WorkflowEpochRef;
	currentState: WorkflowState;
	outcome: WorkflowPhaseOutcomeRecord;
	readiness: WorkflowCompletionReadinessReceipt;
}

export interface WorkflowCompletionCanonicalValidationInput {
	workflowId: string;
	currentState: WorkflowState;
	currentEpoch: WorkflowEpochRef;
	outcome: WorkflowPhaseOutcomeRecord;
	readiness: WorkflowCompletionReadinessReceipt;
	digestSources: WorkflowCompletionDigestSources;
}

export interface WorkflowCompletionGateDependencies {
	resolveCurrentState(): Promise<WorkflowState | null>;
	resolveCurrentEpoch(): Promise<WorkflowEpochRef> | WorkflowEpochRef;
	resolveReadiness(input: WorkflowCompletionReadinessResolverInput): Promise<WorkflowCompletionReadinessReceipt>;
	resolveDigestSources(input: WorkflowCompletionDigestSourceResolverInput): Promise<WorkflowCompletionDigestSources>;
	resolveArtifact: WorkflowArtifactResolver;
	resolveDecision(input: WorkflowCompletionDecisionResolverInput): Promise<WorkflowDecisionRecord>;
	validateDecision(decision: WorkflowDecisionRecord): Promise<void>;
	validateEvidence(input: WorkflowCompletionCanonicalValidationInput): Promise<void>;
	validateScorecard(input: WorkflowCompletionCanonicalValidationInput): Promise<void>;
	validateProgress(input: WorkflowCompletionCanonicalValidationInput): Promise<void>;
	validateResources(input: WorkflowCompletionCanonicalValidationInput): Promise<void>;
	receiptContext: WorkflowHostReceiptConsumerContext;
	trustedNow(): Promise<string> | string;
	/**
	 * Atomically appends the host-authorized completion, consumes grant receipts, and projects the goal.
	 * The callback owns durable CAS/outbox recovery; the gate never accepts a caller-provided mutation result.
	 */
	commitCompletion(input: WorkflowCompletionCommitInput): Promise<WorkflowState>;
}

export interface WorkflowCompletionGateInput {
	workflowId: string;
	currentState: WorkflowState;
	currentEpoch: WorkflowEpochRef;
	outcome: WorkflowPhaseOutcomeRecord;
}

export interface WorkflowCompletionReadinessGrantData {
	kind: "workflow_completion_readiness_grant";
	version: 1;
	workflowId: string;
	headDigest: string;
	headSequence: number;
	inputStateDigest: string;
	outputStateDigest: string;
	epochRef: WorkflowEpochRef;
	phaseAttemptId: string;
	invocationToken: string;
	nonce: string;
	outcomeDigest: string;
	readinessReceipt: WorkflowCompletionReadinessReceipt;
	receipts: readonly WorkflowVerifiedHostReceipt[];
	grantDigest: string;
	oneUse: true;
}

export type WorkflowCompletionReadinessGrantUnsignedData = Omit<WorkflowCompletionReadinessGrantData, "grantDigest">;

/**
 * Computes the canonical digest for a host-issued completion grant.
 *
 * Args:
 * data: Grant fields excluding the digest itself.
 * Return: SHA-256 digest of the canonical grant body.
 */
export function workflowCompletionReadinessGrantDigest(data: WorkflowCompletionReadinessGrantUnsignedData): string {
	return digestObject({ ...data, grantDigest: "" });
}

export type WorkflowCompletionCommitInput = WorkflowCompletionGateInput & {
	readiness: WorkflowCompletionReadinessGrant;
};

const COMPLETION_GATE_TOKEN = Symbol("workflow-completion-gate-token");
const COMPLETION_GRANT_TOKEN = Symbol("workflow-completion-grant-token");
const AUTHENTIC_GATES = new WeakSet<WorkflowCompletionGate>();
const AUTHENTIC_GRANTS = new WeakSet<WorkflowCompletionReadinessGrant>();
const BOUND_GATE_STORES = new WeakMap<WorkflowCompletionGate, object>();

function deepFreeze<T extends object>(value: T): T {
	for (const key of Reflect.ownKeys(value)) {
		const child = Reflect.get(value, key);
		if (typeof child === "object" && child !== null) deepFreeze(child);
	}
	return Object.freeze(value);
}

/** The sealed, host-issued proof consumed by the durable completion CAS. */
export class WorkflowCompletionReadinessGrant {
	readonly workflowId: string;
	readonly headDigest: string;
	readonly headSequence: number;
	readonly inputStateDigest: string;
	readonly outputStateDigest: string;
	readonly epochRef: WorkflowEpochRef;
	readonly phaseAttemptId: string;
	readonly invocationToken: string;
	readonly nonce: string;
	readonly outcomeDigest: string;
	readonly readinessReceipt: WorkflowCompletionReadinessReceipt;
	readonly receipts: readonly WorkflowVerifiedHostReceipt[];
	readonly grantDigest: string;
	readonly oneUse: true;

	constructor(token: typeof COMPLETION_GRANT_TOKEN, data: WorkflowCompletionReadinessGrantData) {
		if (token !== COMPLETION_GRANT_TOKEN) throw new Error("Completion readiness grants are host-issued only.");
		this.workflowId = data.workflowId;
		this.headDigest = data.headDigest;
		this.headSequence = data.headSequence;
		this.inputStateDigest = data.inputStateDigest;
		this.outputStateDigest = data.outputStateDigest;
		this.epochRef = deepFreeze(structuredClone(data.epochRef));
		this.phaseAttemptId = data.phaseAttemptId;
		this.invocationToken = data.invocationToken;
		this.nonce = data.nonce;
		this.outcomeDigest = data.outcomeDigest;
		this.readinessReceipt = deepFreeze(structuredClone(data.readinessReceipt));
		this.receipts = deepFreeze(structuredClone(data.receipts));
		this.grantDigest = data.grantDigest;
		this.oneUse = true;
		Object.freeze(this);
		AUTHENTIC_GRANTS.add(this);
	}
}

/** The only completion authority accepted by the phase host. */
export class WorkflowCompletionGate {
	private readonly dependencies: WorkflowCompletionGateDependencies;
	private readonly committing = new WeakSet<WorkflowCompletionReadinessGrant>();
	private readonly committed = new WeakSet<WorkflowCompletionReadinessGrant>();

	constructor(
		token: typeof COMPLETION_GATE_TOKEN,
		dependencies: WorkflowCompletionGateDependencies,
		storeBinding?: object,
	) {
		if (token !== COMPLETION_GATE_TOKEN) throw new Error("Completion gates are host-constructed only.");
		this.dependencies = deepFreeze({ ...dependencies });
		AUTHENTIC_GATES.add(this);
		if (storeBinding !== undefined) BOUND_GATE_STORES.set(this, storeBinding);
		Object.freeze(this);
	}

	async verify(input: WorkflowCompletionGateInput): Promise<WorkflowCompletionReadinessGrant> {
		return verifyCompletion(this.dependencies, input);
	}

	async commit(input: WorkflowCompletionCommitInput): Promise<WorkflowState> {
		assertGrantInput(input);
		if (!AUTHENTIC_GRANTS.has(input.readiness))
			throw new Error("Completion readiness grant was not issued by the host gate.");
		if (this.committed.has(input.readiness)) throw new Error("Completion readiness grant was already committed.");
		if (this.committing.has(input.readiness)) throw new Error("Completion readiness grant is already committing.");
		this.committing.add(input.readiness);
		try {
			const current = await this.dependencies.resolveCurrentState();
			const currentEpoch = await this.dependencies.resolveCurrentEpoch();
			if (current === null) throw new Error("Completion commit requires a durable current workflow state.");
			assertEpoch(currentEpoch, "Completion commit epoch");
			assertCurrentState(input, current, currentEpoch);
			const committed = await this.dependencies.commitCompletion(input);
			if (
				committed.workflowId !== input.workflowId ||
				committed.status !== COMPLETION_STATUS ||
				committed.goalStatus !== "complete" ||
				committed.goalActive ||
				committed.sourceJournalSequence <= input.currentState.sourceJournalSequence ||
				!isDigest(committed.sourceJournalDigest) ||
				committed.storeEpoch !== input.currentEpoch.storeEpoch ||
				committed.coordinatorEpoch !== input.currentEpoch.coordinatorEpoch
			) {
				throw new Error("Completion host callback did not durably commit the exact complete state.");
			}
			this.committed.add(input.readiness);
			return committed;
		} finally {
			this.committing.delete(input.readiness);
		}
	}
}

Object.freeze(WorkflowCompletionReadinessGrant.prototype);
Object.freeze(WorkflowCompletionGate.prototype);

/**
 * Checks the unforgeable host gate identity used by the phase host.
 *
 * Args:
 * value: Candidate completion authority supplied by a host context.
 * Return: True only for an instance created by this module's sealed constructor.
 */
export function isWorkflowCompletionGate(value: unknown): value is WorkflowCompletionGate {
	return value instanceof WorkflowCompletionGate && AUTHENTIC_GATES.has(value);
}

/**
 * Checks that a gate was sealed by the persisted host for this exact reducer store.
 *
 * Args:
 * value: Candidate gate supplied to a phase host context.
 * store: Exact reducer store that owns the current workflow state.
 * Return: True only for a host-bound gate created for this store instance.
 */
export function isWorkflowCompletionGateForStore(value: unknown, store: object): value is WorkflowCompletionGate {
	return isWorkflowCompletionGate(value) && BOUND_GATE_STORES.get(value) === store;
}

const COMPLETION_DIGEST_FIELDS = [
	"objectiveDigest",
	"hardenedContractDigest",
	"completeRequirementUniverseDigest",
	"fixedBaselineDigest",
	"capacityLedgerDigest",
	"hiddenFailureDigest",
	"requirementEvidenceDigest",
] as const;

const RESOURCE_SCALAR_KEYS = [
	"cpuMilliCores",
	"memoryBytes",
	"diskBytes",
	"ioWeight",
	"networkEgressBytes",
	"wallMilliseconds",
	"monetaryMicrounits",
] as const satisfies readonly (keyof WorkflowResourceVector)[];

const CONTROL_CAPACITY_KEYS = [
	"processSlots",
	"childSessionSlots",
	"modelCallSlots",
	"modelInputTokens",
	"modelOutputTokens",
	"verificationSlots",
	"redTeamSlots",
	"recoverySlots",
] as const satisfies readonly (keyof WorkflowControlCapacityVector)[];

const COMPLETION_STATUS: WorkflowStatus = "complete";

function isRecord(value: unknown): value is WorkflowCanonicalJsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertDigest(value: unknown, label: string): asserts value is string {
	if (!isDigest(value)) throw new Error(`${label} must be a canonical SHA-256 digest.`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function assertEpoch(epoch: WorkflowEpochRef, label: string): void {
	if (
		!Number.isSafeInteger(epoch.storeEpoch) ||
		epoch.storeEpoch < 1 ||
		!Number.isSafeInteger(epoch.coordinatorEpoch) ||
		epoch.coordinatorEpoch < 1
	) {
		throw new Error(`${label} is not a positive workflow epoch tuple.`);
	}
}

function assertReceiptIdentity(receipt: WorkflowVerifiedHostReceipt, label: string): void {
	if (
		!isNonEmptyString(receipt.receiptId) ||
		!isNonEmptyString(receipt.issuerId) ||
		!isNonEmptyString(receipt.workflowId) ||
		!isNonEmptyString(receipt.bindingDigest) ||
		!isNonEmptyString(receipt.payloadDigest) ||
		!isNonEmptyString(receipt.keyId) ||
		!isNonEmptyString(receipt.signature) ||
		!isNonEmptyString(receipt.verificationDigest) ||
		receipt.signatureAlgorithm !== "ed25519" ||
		!isNonEmptyString(receipt.artifactBytesDigest)
	) {
		throw new Error(`${label} is incomplete or not host-authenticated.`);
	}
	assertDigest(receipt.artifactBytesDigest, `${label} artifact bytes digest`);
	if (!isNonEmptyString(receipt.stateDigest)) throw new Error(`${label} state digest is missing.`);
	assertDigest(receipt.verificationDigest, `${label} verification digest`);
	if (!Number.isSafeInteger(receipt.revision) || receipt.revision < 1)
		throw new Error(`${label} revision is invalid.`);
	if (!Number.isFinite(Date.parse(receipt.issuedAt)) || !Number.isFinite(Date.parse(receipt.validUntil)))
		throw new Error(`${label} validity interval is invalid.`);
}

function assertArtifactRef(ref: WorkflowArtifactRef, label: string): void {
	if (
		!isNonEmptyString(ref.artifactId) ||
		!isNonEmptyString(ref.relativePath) ||
		!isDigest(ref.digest) ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	) {
		throw new Error(`${label} is not a canonical immutable artifact reference.`);
	}
}

function sameArtifactRef(left: WorkflowArtifactRef, right: WorkflowArtifactRef): boolean {
	return digestObject(left) === digestObject(right);
}

async function resolveImmutableArtifact(
	resolver: WorkflowArtifactResolver,
	ref: WorkflowArtifactRef,
	label: string,
): Promise<WorkflowArtifactReadResult> {
	assertArtifactRef(ref, label);
	const artifact = await resolver.resolve(ref);
	if (
		!artifact.exists ||
		artifact.envelope.immutable !== true ||
		!sameArtifactRef(artifact.envelope.ref, ref) ||
		artifact.verifiedDigest !== ref.digest ||
		artifact.verifiedSizeBytes !== ref.sizeBytes ||
		artifact.bytes.byteLength !== ref.sizeBytes ||
		sha256Hex(artifact.bytes) !== ref.digest
	) {
		throw new Error(`${label} is missing, mutable, substituted, or not content-addressed.`);
	}
	return artifact;
}

function assertCurrentState(
	input: WorkflowCompletionGateInput,
	current: WorkflowState,
	currentEpoch: WorkflowEpochRef,
): void {
	if (
		current.workflowId !== input.workflowId ||
		digestObject(current) !== digestObject(input.currentState) ||
		current.sourceJournalDigest !== input.currentState.sourceJournalDigest ||
		current.storeEpoch !== input.currentEpoch.storeEpoch ||
		current.coordinatorEpoch !== input.currentEpoch.coordinatorEpoch ||
		!sameEpoch(currentEpoch, input.currentEpoch)
	) {
		throw new Error("Completion gate state or epoch is stale.");
	}
	if (current.status === COMPLETION_STATUS) throw new Error("Workflow completion was already durably committed.");
	if (current.status !== "active" || !current.goalActive || current.goalStatus !== "active")
		throw new Error("Completion gate requires an active workflow and goal state.");
}

function assertCompleteOutcome(
	input: WorkflowCompletionGateInput,
): Extract<WorkflowPhaseOutcomeRecord["outcome"], { status: "complete" }> {
	if (input.workflowId.trim().length === 0 || input.outcome.outcome.workflowId !== input.workflowId)
		throw new Error("Completion outcome is not bound to the current workflow.");
	if (input.outcome.outcome.status !== "complete")
		throw new Error("Completion gate requires a complete phase outcome.");
	if (input.outcome.attemptStatus !== "completed")
		throw new Error("Completion gate requires a durably completed phase attempt.");
	const outcome = input.outcome.outcome;
	if (
		!isNonEmptyString(outcome.phaseAttemptId) ||
		!isNonEmptyString(outcome.invocationToken) ||
		!isDigest(outcome.inputStateDigest) ||
		!isDigest(outcome.outputStateDigest)
	) {
		throw new Error("Completion outcome is incomplete or not digest-bound.");
	}
	assertEpoch(outcome.epochRef, "Completion outcome epoch");
	for (const ref of [...outcome.artifactRefs, ...outcome.evidenceRefs])
		assertArtifactRef(ref, "Completion outcome artifact");
	return outcome;
}

function assertGrantInput(input: WorkflowCompletionCommitInput): void {
	if (!(input.readiness instanceof WorkflowCompletionReadinessGrant) || input.readiness.oneUse !== true)
		throw new Error("Completion commit requires a sealed one-use readiness grant.");
	const outcome = assertCompleteOutcome(input);
	if (
		input.readiness.workflowId !== input.workflowId ||
		input.readiness.headDigest !== input.currentState.sourceJournalDigest ||
		input.readiness.headSequence !== input.currentState.sourceJournalSequence ||
		input.readiness.inputStateDigest !== input.currentState.sourceJournalDigest ||
		input.readiness.outputStateDigest !== outcome.outputStateDigest ||
		!sameEpoch(input.readiness.epochRef, input.currentEpoch) ||
		outcome.phaseAttemptId !== input.readiness.phaseAttemptId ||
		outcome.invocationToken !== input.readiness.invocationToken ||
		input.readiness.outcomeDigest !== digestObject(input.outcome.outcome) ||
		input.readiness.readinessReceipt.workflowId !== input.workflowId ||
		input.readiness.readinessReceipt.inputStateDigest !== input.currentState.sourceJournalDigest ||
		input.readiness.readinessReceipt.outputStateDigest !== outcome.outputStateDigest ||
		input.readiness.readinessReceipt.verdict !== "ready" ||
		input.readiness.readinessReceipt.hostReceipt.oneUse !== true ||
		input.readiness.readinessReceipt.adjudicationReceipt.oneUse !== true ||
		input.readiness.readinessReceipt.receiptDigest !==
			digestObject({ ...input.readiness.readinessReceipt, receiptDigest: "" })
	) {
		throw new Error("Completion readiness grant is stale or bound to a different attempt, head, or epoch.");
	}
	const receiptIds = new Set<string>();
	for (const receipt of input.readiness.receipts) {
		assertReceiptIdentity(receipt, "Completion grant receipt");
		if (!receipt.oneUse || receiptIds.has(receipt.receiptId))
			throw new Error("Completion readiness grant contains a duplicated or reusable receipt.");
		receiptIds.add(receipt.receiptId);
	}
	if (
		input.readiness.receipts.length < 6 ||
		!receiptIds.has(input.readiness.readinessReceipt.hostReceipt.receiptId) ||
		!receiptIds.has(input.readiness.readinessReceipt.adjudicationReceipt.receiptId)
	)
		throw new Error("Completion readiness grant has incomplete receipt bindings.");
	const unsigned: WorkflowCompletionReadinessGrantUnsignedData = {
		kind: "workflow_completion_readiness_grant",
		version: 1,
		workflowId: input.readiness.workflowId,
		headDigest: input.readiness.headDigest,
		headSequence: input.readiness.headSequence,
		inputStateDigest: input.readiness.inputStateDigest,
		outputStateDigest: input.readiness.outputStateDigest,
		epochRef: input.readiness.epochRef,
		phaseAttemptId: input.readiness.phaseAttemptId,
		invocationToken: input.readiness.invocationToken,
		nonce: input.readiness.nonce,
		outcomeDigest: input.readiness.outcomeDigest,
		readinessReceipt: input.readiness.readinessReceipt,
		receipts: input.readiness.receipts,
		oneUse: true,
	};
	if (
		!isNonEmptyString(input.readiness.nonce) ||
		input.readiness.grantDigest !== workflowCompletionReadinessGrantDigest(unsigned)
	)
		throw new Error("Completion readiness grant digest is forged or incomplete.");
}

function createReadinessGrant(
	input: WorkflowCompletionGateInput,
	current: WorkflowState,
	currentEpoch: WorkflowEpochRef,
	readiness: WorkflowCompletionReadinessReceipt,
	receipts: readonly WorkflowVerifiedHostReceipt[],
	completeOutcome: Extract<WorkflowPhaseOutcomeRecord["outcome"], { status: "complete" }>,
): WorkflowCompletionReadinessGrant {
	const unsigned: WorkflowCompletionReadinessGrantUnsignedData = {
		kind: "workflow_completion_readiness_grant",
		version: 1,
		workflowId: input.workflowId,
		headDigest: current.sourceJournalDigest,
		headSequence: current.sourceJournalSequence,
		inputStateDigest: completeOutcome.inputStateDigest,
		outputStateDigest: completeOutcome.outputStateDigest,
		epochRef: currentEpoch,
		phaseAttemptId: completeOutcome.phaseAttemptId,
		invocationToken: completeOutcome.invocationToken,
		nonce: randomUUID(),
		outcomeDigest: digestObject(input.outcome.outcome),
		readinessReceipt: readiness,
		receipts,
		oneUse: true as const,
	};
	return new WorkflowCompletionReadinessGrant(COMPLETION_GRANT_TOKEN, {
		...unsigned,
		grantDigest: workflowCompletionReadinessGrantDigest(unsigned),
	});
}

function assertReadinessShape(
	readiness: WorkflowCompletionReadinessReceipt,
	completeOutcome: Extract<WorkflowPhaseOutcomeRecord["outcome"], { status: "complete" }>,
	input: WorkflowCompletionGateInput,
): void {
	if (
		readiness.workflowId !== input.workflowId ||
		readiness.inputStateDigest !== input.currentState.sourceJournalDigest ||
		readiness.outcomeDigest !== digestObject(input.outcome.outcome) ||
		readiness.outputStateDigest !== completeOutcome.outputStateDigest ||
		readiness.outputDigest !== digestObject(completeOutcome.artifactRefs) ||
		readiness.evidenceDigest !== digestObject(completeOutcome.evidenceRefs) ||
		readiness.verdict !== "ready"
	) {
		throw new Error("Completion readiness is stale, forged, or does not cover the exact outcome.");
	}
	for (const field of COMPLETION_DIGEST_FIELDS) assertDigest(readiness[field], `Completion readiness ${field}`);
	assertArtifactRef(readiness.usageReconciliationRef, "Completion usage reconciliation reference");
	assertArtifactRef(readiness.capacityReconciliationRef, "Completion capacity reconciliation reference");
	assertReceiptIdentity(readiness.hostReceipt, "Completion readiness host receipt");
	assertReceiptIdentity(readiness.adjudicationReceipt, "Completion adjudication receipt");
	if (!readiness.hostReceipt.oneUse || !readiness.adjudicationReceipt.oneUse)
		throw new Error("Completion readiness requires one-use host and adjudication receipts.");
}

function assertReadinessReceiptDigest(readiness: WorkflowCompletionReadinessReceipt): void {
	const unsigned = { ...readiness, receiptDigest: "" };
	if (readiness.receiptDigest !== digestObject(unsigned))
		throw new Error("Completion readiness receipt digest does not cover its complete canonical body.");
}

function expectedDigestMap(
	sources: WorkflowCompletionDigestSources,
): Record<(typeof COMPLETION_DIGEST_FIELDS)[number], string> {
	return {
		objectiveDigest: digestObject(sources.objective),
		hardenedContractDigest: digestObject(sources.hardenedContract),
		completeRequirementUniverseDigest: digestObject(sources.completeRequirementUniverse),
		fixedBaselineDigest: digestObject(sources.fixedBaseline),
		capacityLedgerDigest: digestObject(sources.capacityLedger),
		hiddenFailureDigest: digestObject(sources.hiddenFailure),
		requirementEvidenceDigest: digestObject(sources.requirementEvidence),
	};
}

function assertDigestClosure(
	readiness: WorkflowCompletionReadinessReceipt,
	sources: WorkflowCompletionDigestSources,
): void {
	const expected = expectedDigestMap(sources);
	for (const field of COMPLETION_DIGEST_FIELDS) {
		if (readiness[field] !== expected[field])
			throw new Error(`Completion readiness ${field} is not recomputed from the current host closure.`);
	}
}

function assertDecisionRef(
	ref: WorkflowDecisionRef,
	workflowId: string,
	epochRef: WorkflowEpochRef,
	label: string,
): void {
	if (
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		!isNonEmptyString(ref.decisionScope.rootSessionId) ||
		!isNonEmptyString(ref.decisionId) ||
		!isDigest(ref.decisionDigest) ||
		!Number.isSafeInteger(ref.revision) ||
		ref.revision < 1 ||
		ref.storeEpoch !== epochRef.storeEpoch ||
		ref.coordinatorEpoch !== epochRef.coordinatorEpoch
	) {
		throw new Error(`${label} is foreign, stale, or malformed.`);
	}
}

function assertDecisionIndependence(
	decision: WorkflowDecisionRecord,
	ref: WorkflowDecisionRef,
	workflowId: string,
	state: WorkflowState,
	role: "verifier" | "red_team",
): void {
	if (
		decision.decisionScope.kind !== "workflow" ||
		decision.decisionScope.workflowId !== workflowId ||
		!isNonEmptyString(decision.decisionScope.rootSessionId) ||
		decision.decisionId !== ref.decisionId ||
		decision.revision !== ref.revision ||
		digestObject(decision) !== ref.decisionDigest ||
		decision.storeEpoch !== state.storeEpoch ||
		decision.coordinatorEpoch !== state.coordinatorEpoch ||
		decision.stateDigest !== state.sourceJournalDigest ||
		decision.kind !== "completion" ||
		(decision.disposition !== "authorized" && decision.disposition !== "applied") ||
		!decision.authority.includes("accept_completion") ||
		decision.hostAdjudication.disposition !== "accepted" ||
		decision.hostAdjudication.decisionId !== decision.decisionId ||
		decision.hostAdjudication.decisionRevision !== decision.revision ||
		decision.hostAdjudication.inputStateDigest !== state.sourceJournalDigest ||
		decision.hostAdjudication.stage !== "host_adjudication" ||
		!isNonEmptyString(decision.proposerSessionId) ||
		!isNonEmptyString(decision.verifierSessionId) ||
		!isNonEmptyString(decision.redTeamSessionId) ||
		decision.proposerSessionId === decision.verifierSessionId ||
		decision.proposerSessionId === decision.redTeamSessionId ||
		decision.verifierSessionId === decision.redTeamSessionId
	) {
		throw new Error(`${role} completion decision is self-authored, stale, or not host-authorized.`);
	}
	const recipeCapability = Reflect.get(decision.stagePlan, "recipeCapability");
	const dynamicStagePlan = recipeCapability === "dynamic_task_graph";
	if (recipeCapability !== "builtin_adaptive_prime" && !dynamicStagePlan)
		throw new Error(`${role} completion decision lacks an explicit recipe capability.`);
	if (dynamicStagePlan) {
		const stages = decision.stagePlan.stages as readonly string[];
		const lensRoles = decision.stagePlan.lensRoles as readonly unknown[];
		if (
			stages.length === 0 ||
			new Set(stages).size !== stages.length ||
			lensRoles.length !== stages.length ||
			lensRoles.some((lensRole) => lensRole !== null) ||
			decision.stageVerdicts.length !== stages.length
		)
			throw new Error(`${role} completion decision lacks a complete dynamic stage set.`);
	} else if (
		decision.stagePlan.stages.join("|") !== "recon|lens|lens|verification|synthesis|red_team" ||
		decision.stagePlan.lensRoles.join("|") !== "|primary|secondary|||" ||
		decision.stageVerdicts.length !== 6
	) {
		throw new Error(`${role} completion decision lacks a complete accepted independent stage set.`);
	}
	const sessions = new Set<string>();
	const executions = new Set<string>();
	const stageIds = new Set<string>();
	for (const [index, verdict] of decision.stageVerdicts.entries()) {
		const expectedStage = dynamicStagePlan
			? (decision.stagePlan.stages as readonly string[])[index]
			: ["recon", "lens", "lens", "verification", "synthesis", "red_team"][index];
		const expectedLensRole = dynamicStagePlan ? null : [null, "primary", "secondary", null, null, null][index];
		if (
			verdict.decisionId !== decision.decisionId ||
			verdict.decisionRevision !== decision.revision ||
			verdict.stage !== expectedStage ||
			verdict.lensRole !== expectedLensRole ||
			verdict.disposition !== "accepted" ||
			!isNonEmptyString(verdict.stageId) ||
			!isNonEmptyString(verdict.sessionId) ||
			!isNonEmptyString(verdict.executionIdentity) ||
			verdict.storeEpoch !== state.storeEpoch ||
			verdict.coordinatorEpoch !== state.coordinatorEpoch ||
			verdict.inputStateDigest !== state.sourceJournalDigest ||
			verdict.independence.inputStateDigest !== state.sourceJournalDigest ||
			verdict.independence.freshContext !== true ||
			verdict.independence.distinctSessionIdentity !== true ||
			verdict.independence.distinctExecutionIdentity !== true ||
			verdict.independence.sharedConversation !== false ||
			verdict.independence.sharedMutableOutput !== false ||
			verdict.artifactRefs.length === 0 ||
			sessions.has(verdict.sessionId) ||
			executions.has(verdict.executionIdentity) ||
			stageIds.has(verdict.stageId)
		) {
			throw new Error(`${role} completion decision lacks an independent host-bound verdict.`);
		}
		sessions.add(verdict.sessionId);
		executions.add(verdict.executionIdentity);
		stageIds.add(verdict.stageId);
	}
	const roleVerdict = dynamicStagePlan
		? undefined
		: decision.stageVerdicts.find((verdict) => verdict.stage === (role === "verifier" ? "verification" : "red_team"));
	if (
		(!dynamicStagePlan && roleVerdict === undefined) ||
		(!dynamicStagePlan &&
			(role === "verifier" ? decision.verifierSessionId : decision.redTeamSessionId) !== roleVerdict?.sessionId) ||
		(!dynamicStagePlan && roleVerdict?.sessionId === decision.proposerSessionId) ||
		(!dynamicStagePlan && roleVerdict?.executionIdentity === decision.proposerSessionId) ||
		(dynamicStagePlan &&
			(decision.verifierSessionId === decision.proposerSessionId ||
				decision.redTeamSessionId === decision.proposerSessionId ||
				decision.verifierSessionId === decision.redTeamSessionId))
	)
		throw new Error(`${role} completion decision is self-authored or not bound to its role verdict.`);
	if (
		!isNonEmptyString(decision.hostAdjudication.sessionId) ||
		!isNonEmptyString(decision.hostAdjudication.executionIdentity) ||
		sessions.has(decision.hostAdjudication.sessionId) ||
		executions.has(decision.hostAdjudication.executionIdentity) ||
		!sameArtifactRef(
			decision.hostAdjudication.hostReceipt.artifactRef,
			decision.hostAdjudication.verdictArtifactRef,
		) ||
		decision.hostAdjudication.hostReceipt.payloadDigest !== decision.hostAdjudication.verdictDigest
	) {
		throw new Error(`${role} completion decision lacks an independent host adjudication.`);
	}
}

function decisionAdjudicationBindingInput(
	decision: WorkflowDecisionRecord,
	state: WorkflowState,
	epochRef: WorkflowEpochRef,
	role: "verifier" | "red_team",
): WorkflowCompletionDecisionAdjudicationBindingInput {
	return {
		workflowId: state.workflowId,
		rootSessionId: decision.decisionScope.rootSessionId,
		role,
		decisionId: decision.decisionId,
		decisionRevision: decision.revision,
		inputStateDigest: state.sourceJournalDigest,
		epochRef,
		targetDigest: decision.targetDigest,
		effectDigest: decision.effectDigest,
		preconditionDigest: decision.preconditionDigest,
		planDigest: decision.planDigest,
		attemptToken: decision.attemptToken,
		nonce: decision.nonce,
		executionKey: decision.executionKey,
		proposerSessionId: decision.proposerSessionId,
		verifierSessionId: decision.verifierSessionId,
		synthesizerSessionId: decision.synthesizerSessionId,
		redTeamSessionId: decision.redTeamSessionId,
		hostSessionId: decision.hostAdjudication.sessionId,
		hostExecutionIdentity: decision.hostAdjudication.executionIdentity,
		operationDigest: decision.hostAdjudication.operationDigest,
		disposition: "accepted",
	};
}

function assertReceiptKind(
	receipt: WorkflowVerifiedHostReceipt,
	kinds: readonly WorkflowVerifiedHostReceipt["receiptKind"][],
	label: string,
): void {
	if (!kinds.includes(receipt.receiptKind)) throw new Error(`${label} has an invalid receipt kind.`);
}

function isFiniteResourceVector(value: unknown): value is WorkflowResourceVector {
	const vector = parseFiniteResourceVector(value);
	if (vector === null) return false;
	try {
		assertFiniteWorkflowResourceVector(vector);
		return true;
	} catch {
		return false;
	}
}

function isFiniteControlCapacity(value: unknown): value is WorkflowControlCapacityVector {
	const capacity = parseFiniteControlCapacity(value);
	if (capacity === null) return false;
	try {
		assertFiniteWorkflowControlCapacity(capacity);
		return true;
	} catch {
		return false;
	}
}

function parseFiniteResourceVector(value: unknown): WorkflowResourceVector | null {
	if (!isRecord(value) || !Array.isArray(value.accelerators) || !Array.isArray(value.providers)) return null;
	const cpuMilliCores = readSafeNonNegativeInteger(value.cpuMilliCores);
	const memoryBytes = readSafeNonNegativeInteger(value.memoryBytes);
	const diskBytes = readSafeNonNegativeInteger(value.diskBytes);
	const ioWeight = readSafeNonNegativeInteger(value.ioWeight);
	const networkEgressBytes = readSafeNonNegativeInteger(value.networkEgressBytes);
	const wallMilliseconds = readSafeNonNegativeInteger(value.wallMilliseconds);
	const monetaryMicrounits = readSafeNonNegativeInteger(value.monetaryMicrounits);
	if (
		cpuMilliCores === null ||
		memoryBytes === null ||
		diskBytes === null ||
		ioWeight === null ||
		networkEgressBytes === null ||
		wallMilliseconds === null ||
		monetaryMicrounits === null
	)
		return null;
	const accelerators: Array<WorkflowResourceVector["accelerators"][number]> = [];
	for (const item of value.accelerators) {
		if (!isRecord(item) || !isNonEmptyString(item.poolId) || !isNonEmptyString(item.deviceType)) return null;
		const count = readSafeNonNegativeInteger(item.count);
		const acceleratorMemoryBytes = readSafeNonNegativeInteger(item.memoryBytes);
		if (count === null || acceleratorMemoryBytes === null) return null;
		accelerators.push({
			poolId: item.poolId,
			deviceType: item.deviceType,
			count,
			memoryBytes: acceleratorMemoryBytes,
		});
	}
	const providers: Array<WorkflowResourceVector["providers"][number]> = [];
	for (const item of value.providers) {
		if (!isRecord(item) || !isNonEmptyString(item.poolId)) return null;
		const concurrentRequests = readSafeNonNegativeInteger(item.concurrentRequests);
		const requestsPerMinute = readSafeNonNegativeInteger(item.requestsPerMinute);
		const totalRequests = readSafeNonNegativeInteger(item.totalRequests);
		const inputTokens = readSafeNonNegativeInteger(item.inputTokens);
		const outputTokens = readSafeNonNegativeInteger(item.outputTokens);
		if (
			concurrentRequests === null ||
			requestsPerMinute === null ||
			totalRequests === null ||
			inputTokens === null ||
			outputTokens === null ||
			(item.idempotency !== "provider_native" &&
				item.idempotency !== "host_reconciled" &&
				item.idempotency !== "none")
		)
			return null;
		providers.push({
			poolId: item.poolId,
			concurrentRequests,
			requestsPerMinute,
			totalRequests,
			inputTokens,
			outputTokens,
			idempotency: item.idempotency,
		});
	}
	return {
		cpuMilliCores,
		memoryBytes,
		diskBytes,
		ioWeight,
		accelerators,
		providers,
		networkEgressBytes,
		wallMilliseconds,
		monetaryMicrounits,
	};
}

function parseFiniteControlCapacity(value: unknown): WorkflowControlCapacityVector | null {
	if (!isRecord(value)) return null;
	const processSlots = readSafeNonNegativeInteger(value.processSlots);
	const childSessionSlots = readSafeNonNegativeInteger(value.childSessionSlots);
	const modelCallSlots = readSafeNonNegativeInteger(value.modelCallSlots);
	const modelInputTokens = readSafeNonNegativeInteger(value.modelInputTokens);
	const modelOutputTokens = readSafeNonNegativeInteger(value.modelOutputTokens);
	const verificationSlots = readSafeNonNegativeInteger(value.verificationSlots);
	const redTeamSlots = readSafeNonNegativeInteger(value.redTeamSlots);
	const recoverySlots = readSafeNonNegativeInteger(value.recoverySlots);
	if (
		processSlots === null ||
		childSessionSlots === null ||
		modelCallSlots === null ||
		modelInputTokens === null ||
		modelOutputTokens === null ||
		verificationSlots === null ||
		redTeamSlots === null ||
		recoverySlots === null
	)
		return null;
	return {
		processSlots,
		childSessionSlots,
		modelCallSlots,
		modelInputTokens,
		modelOutputTokens,
		verificationSlots,
		redTeamSlots,
		recoverySlots,
	};
}

function readSafeNonNegativeInteger(value: unknown): number | null {
	return isSafeNonNegativeInteger(value) ? value : null;
}

function isArtifactRefValue(value: unknown): value is WorkflowArtifactRef {
	return (
		isRecord(value) &&
		isNonEmptyString(value.artifactId) &&
		isNonEmptyString(value.relativePath) &&
		isDigest(value.digest) &&
		isSafeNonNegativeInteger(value.sizeBytes) &&
		isSafeNonNegativeInteger(value.sourceEventSequence)
	);
}

function isUsageReconciliation(value: unknown): value is WorkflowCompletionUsageReconciliation {
	return (
		isRecord(value) &&
		isNonEmptyString(value.workflowId) &&
		isDigest(value.inputStateDigest) &&
		isDigest(value.outputStateDigest) &&
		isFiniteResourceVector(value.resourceUsage) &&
		isFiniteControlCapacity(value.controlUsage) &&
		isSafeNonNegativeInteger(value.spendMicrounits) &&
		isArtifactRefValue(value.grantLedgerRef) &&
		isDigest(value.grantLedgerDigest) &&
		isDigest(value.approvedEnvelopeDigest) &&
		isDigest(value.goalBudgetDigest) &&
		isRecord(value.hostReceipt) &&
		isDigest(value.reconciliationDigest)
	);
}

function isCapacityReconciliation(value: unknown): value is WorkflowCompletionCapacityReconciliation {
	return (
		isRecord(value) &&
		isNonEmptyString(value.workflowId) &&
		isDigest(value.inputStateDigest) &&
		isDigest(value.outputStateDigest) &&
		isFiniteResourceVector(value.capacityVector) &&
		isFiniteControlCapacity(value.controlCapacity) &&
		isArtifactRefValue(value.canonicalLedgerRef) &&
		isDigest(value.canonicalLedgerDigest) &&
		isDigest(value.approvedEnvelopeDigest) &&
		isDigest(value.capacityCasDigest) &&
		isRecord(value.hostReceipt) &&
		isDigest(value.reconciliationDigest)
	);
}

function isWorkflowResourceGrantLedger(value: unknown): value is WorkflowResourceGrantLedger {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.workflowId) ||
		!isSafeNonNegativeInteger(value.revision) ||
		value.revision < 1
	)
		return false;
	if (
		!Array.isArray(value.entries) ||
		!isFiniteResourceVector(value.resourceTotal) ||
		!isFiniteControlCapacity(value.workerTotal)
	)
		return false;
	if (
		!isFiniteControlCapacity(value.controlTotal) ||
		!isDigest(value.canonicalLedgerDigest) ||
		!isArtifactRefValue(value.canonicalLedgerRef)
	)
		return false;
	if (!isRecord(value.canonicalPoolLedger) || !isArtifactRefValue(value.canonicalPoolLedger.artifactRef)) return false;
	return value.canonicalLedgerDigest === value.canonicalLedgerRef.digest && isDigest(value.headDigest);
}

function assertResourceWithin(usage: WorkflowResourceVector, capacity: WorkflowResourceVector): void {
	for (const key of RESOURCE_SCALAR_KEYS) {
		if (usage[key] > capacity[key]) throw new Error(`Completion usage exceeds capacity in ${key}.`);
	}
	const capacityAccelerators = new Map(
		capacity.accelerators.map((item) => [`${item.poolId}\u0000${item.deviceType}`, item]),
	);
	for (const item of usage.accelerators) {
		const available = capacityAccelerators.get(`${item.poolId}\u0000${item.deviceType}`);
		if (available === undefined || item.count > available.count || item.memoryBytes > available.memoryBytes)
			throw new Error("Completion usage exceeds accelerator capacity.");
	}
	const capacityProviders = new Map(capacity.providers.map((item) => [item.poolId, item]));
	for (const item of usage.providers) {
		const available = capacityProviders.get(item.poolId);
		if (
			available === undefined ||
			item.concurrentRequests > available.concurrentRequests ||
			item.requestsPerMinute > available.requestsPerMinute ||
			item.totalRequests > available.totalRequests ||
			item.inputTokens > available.inputTokens ||
			item.outputTokens > available.outputTokens
		)
			throw new Error("Completion usage exceeds provider capacity.");
	}
}

function assertControlWithin(usage: WorkflowControlCapacityVector, capacity: WorkflowControlCapacityVector): void {
	for (const key of CONTROL_CAPACITY_KEYS) {
		if (usage[key] > capacity[key]) throw new Error(`Completion usage exceeds control capacity in ${key}.`);
	}
}

async function verifyReconciliations(
	dependencies: WorkflowCompletionGateDependencies,
	readiness: WorkflowCompletionReadinessReceipt,
	completeOutcome: Extract<WorkflowPhaseOutcomeRecord["outcome"], { status: "complete" }>,
	state: WorkflowState,
	epochRef: WorkflowEpochRef,
	trustedNow: string,
): Promise<readonly WorkflowVerifiedHostReceipt[]> {
	const usageArtifact = await resolveImmutableArtifact(
		dependencies.resolveArtifact,
		readiness.usageReconciliationRef,
		"Completion usage reconciliation artifact",
	);
	const capacityArtifact = await resolveImmutableArtifact(
		dependencies.resolveArtifact,
		readiness.capacityReconciliationRef,
		"Completion capacity reconciliation artifact",
	);
	const usageValue = parseCanonicalJsonBytes(usageArtifact.bytes);
	const capacityValue = parseCanonicalJsonBytes(capacityArtifact.bytes);
	if (!isUsageReconciliation(usageValue))
		throw new Error("Completion usage reconciliation is not a canonical host record.");
	if (!isCapacityReconciliation(capacityValue))
		throw new Error("Completion capacity reconciliation is not a canonical host record.");
	const usage = usageValue;
	const capacity = capacityValue;
	const usageDigestPreimage = {
		workflowId: usage.workflowId,
		inputStateDigest: usage.inputStateDigest,
		outputStateDigest: usage.outputStateDigest,
		resourceUsage: usage.resourceUsage,
		controlUsage: usage.controlUsage,
		spendMicrounits: usage.spendMicrounits,
		grantLedgerRef: usage.grantLedgerRef,
		grantLedgerDigest: usage.grantLedgerDigest,
		approvedEnvelopeDigest: usage.approvedEnvelopeDigest,
		goalBudgetDigest: usage.goalBudgetDigest,
		hostReceipt: usage.hostReceipt,
		reconciliationDigest: "",
	};
	const capacityDigestPreimage = {
		workflowId: capacity.workflowId,
		inputStateDigest: capacity.inputStateDigest,
		outputStateDigest: capacity.outputStateDigest,
		capacityVector: capacity.capacityVector,
		controlCapacity: capacity.controlCapacity,
		canonicalLedgerRef: capacity.canonicalLedgerRef,
		canonicalLedgerDigest: capacity.canonicalLedgerDigest,
		approvedEnvelopeDigest: capacity.approvedEnvelopeDigest,
		capacityCasDigest: capacity.capacityCasDigest,
		hostReceipt: capacity.hostReceipt,
		reconciliationDigest: "",
	};
	if (
		usage.workflowId !== state.workflowId ||
		usage.inputStateDigest !== state.sourceJournalDigest ||
		usage.outputStateDigest !== completeOutcome.outputStateDigest ||
		usage.reconciliationDigest !== digestObject(usageDigestPreimage) ||
		capacity.workflowId !== state.workflowId ||
		capacity.inputStateDigest !== state.sourceJournalDigest ||
		capacity.outputStateDigest !== completeOutcome.outputStateDigest ||
		capacity.reconciliationDigest !== digestObject(capacityDigestPreimage) ||
		usage.approvedEnvelopeDigest !== capacity.approvedEnvelopeDigest ||
		usage.grantLedgerDigest !== capacity.canonicalLedgerDigest ||
		usage.spendMicrounits > capacity.capacityVector.monetaryMicrounits ||
		capacity.canonicalLedgerDigest !== capacity.canonicalLedgerRef.digest
	) {
		throw new Error("Completion readiness lacks a current output-state-bound usage/capacity reconciliation.");
	}
	assertResourceWithin(usage.resourceUsage, capacity.capacityVector);
	assertControlWithin(usage.controlUsage, capacity.controlCapacity);
	const ledgerArtifact = await resolveImmutableArtifact(
		dependencies.resolveArtifact,
		usage.grantLedgerRef,
		"Completion grant ledger artifact",
	);
	const ledgerValue = parseCanonicalJsonBytes(ledgerArtifact.bytes);
	if (!isWorkflowResourceGrantLedger(ledgerValue))
		throw new Error("Completion usage reconciliation lacks a canonical grant ledger.");
	const canonicalLedgerArtifact = await resolveImmutableArtifact(
		dependencies.resolveArtifact,
		capacity.canonicalLedgerRef,
		"Completion canonical capacity ledger artifact",
	);
	parseCanonicalJsonBytes(canonicalLedgerArtifact.bytes);
	if (
		ledgerValue.workflowId !== state.workflowId ||
		ledgerValue.canonicalLedgerDigest !== usage.grantLedgerDigest ||
		!sameArtifactRef(ledgerValue.canonicalLedgerRef, capacity.canonicalLedgerRef)
	)
		throw new Error("Completion grant ledger is foreign or stale.");
	assertReceiptKind(usage.hostReceipt, ["usage"], "Completion usage receipt");
	assertReceiptKind(capacity.hostReceipt, ["artifact", "usage"], "Completion capacity receipt");
	const usageBinding = workflowCompletionUsageReceiptBindingDigest({
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest: completeOutcome.outputStateDigest,
		resourceUsage: usage.resourceUsage,
		controlUsage: usage.controlUsage,
		spendMicrounits: usage.spendMicrounits,
		grantLedgerRef: usage.grantLedgerRef,
		grantLedgerDigest: usage.grantLedgerDigest,
		approvedEnvelopeDigest: usage.approvedEnvelopeDigest,
		goalBudgetDigest: usage.goalBudgetDigest,
	});
	const capacityBinding = workflowCompletionCapacityReceiptBindingDigest({
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		outputStateDigest: completeOutcome.outputStateDigest,
		capacityVector: capacity.capacityVector,
		controlCapacity: capacity.controlCapacity,
		canonicalLedgerRef: capacity.canonicalLedgerRef,
		canonicalLedgerDigest: capacity.canonicalLedgerDigest,
		approvedEnvelopeDigest: capacity.approvedEnvelopeDigest,
		capacityCasDigest: capacity.capacityCasDigest,
	});
	const usageReceipt = await verifyReceipt({
		dependencies,
		receipt: usage.hostReceipt,
		bindingDigest: usageBinding,
		state,
		epochRef,
		trustedNow,
		label: "Completion usage receipt",
	});
	const capacityReceipt = await verifyReceipt({
		dependencies,
		receipt: capacity.hostReceipt,
		bindingDigest: capacityBinding,
		state,
		epochRef,
		trustedNow,
		label: "Completion capacity receipt",
	});
	return [usageReceipt, capacityReceipt];
}

async function verifyReceipt(input: {
	dependencies: WorkflowCompletionGateDependencies;
	receipt: WorkflowVerifiedHostReceipt;
	bindingDigest: string;
	state: WorkflowState;
	epochRef: WorkflowEpochRef;
	trustedNow: string;
	label: string;
}): Promise<WorkflowVerifiedHostReceipt> {
	assertReceiptIdentity(input.receipt, input.label);
	if (
		input.receipt.workflowId !== input.state.workflowId ||
		input.receipt.stateDigest !== input.state.sourceJournalDigest
	)
		throw new Error(`${input.label} is foreign or stale.`);
	await resolveImmutableArtifact(
		input.dependencies.resolveArtifact,
		input.receipt.artifactRef,
		`${input.label} artifact`,
	);
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.dependencies.receiptContext,
		workflowId: input.state.workflowId,
		expectedBindingDigest: input.bindingDigest,
		receipt: input.receipt,
		currentStateDigest: input.state.sourceJournalDigest,
		currentRevision: input.state.sourceJournalSequence,
		trustedNow: input.trustedNow,
	});
	return input.receipt;
}

async function verifyDecision(
	dependencies: WorkflowCompletionGateDependencies,
	ref: WorkflowDecisionRef,
	state: WorkflowState,
	epochRef: WorkflowEpochRef,
	role: "verifier" | "red_team",
	trustedNow: string,
): Promise<{ decision: WorkflowDecisionRecord; receipt: WorkflowVerifiedHostReceipt }> {
	assertDecisionRef(ref, state.workflowId, epochRef, `${role} decision reference`);
	const decision = await dependencies.resolveDecision({
		workflowId: state.workflowId,
		decisionRef: ref,
		inputStateDigest: state.sourceJournalDigest,
		epochRef,
		currentRevision: state.sourceJournalSequence,
	});
	await dependencies.validateDecision(decision);
	assertDecisionIndependence(decision, ref, state.workflowId, state, role);
	for (const verdict of decision.stageVerdicts) {
		for (const artifactRef of verdict.artifactRefs)
			await resolveImmutableArtifact(dependencies.resolveArtifact, artifactRef, `${role} decision verdict artifact`);
	}
	assertReceiptKind(
		decision.hostAdjudication.hostReceipt,
		["decision", "adjudication"],
		`${role} decision adjudication receipt`,
	);
	const adjudicationBinding = workflowCompletionDecisionAdjudicationBindingDigest(
		decisionAdjudicationBindingInput(decision, state, epochRef, role),
	);
	if (decision.hostAdjudication.hostReceipt.bindingDigest !== adjudicationBinding)
		throw new Error(`${role} decision adjudication receipt is not bound to the canonical adjudication tuple.`);
	const receipt = await verifyReceipt({
		dependencies,
		receipt: decision.hostAdjudication.hostReceipt,
		bindingDigest: adjudicationBinding,
		state,
		epochRef,
		trustedNow,
		label: `${role} decision adjudication receipt`,
	});
	return { decision, receipt };
}

async function verifyReadinessReceipts(
	dependencies: WorkflowCompletionGateDependencies,
	readiness: WorkflowCompletionReadinessReceipt,
	state: WorkflowState,
	epochRef: WorkflowEpochRef,
	outputDigest: string,
	evidenceDigest: string,
	trustedNow: string,
): Promise<readonly WorkflowVerifiedHostReceipt[]> {
	const bindingInput: WorkflowCompletionReceiptBindingInput = {
		workflowId: state.workflowId,
		inputStateDigest: state.sourceJournalDigest,
		headSequence: state.sourceJournalSequence,
		epochRef,
		outcomeDigest: readiness.outcomeDigest,
		outputDigest,
		evidenceDigest,
		requirementEvidenceDigest: readiness.requirementEvidenceDigest,
		objectiveDigest: readiness.objectiveDigest,
		hardenedContractDigest: readiness.hardenedContractDigest,
		completeRequirementUniverseDigest: readiness.completeRequirementUniverseDigest,
		fixedBaselineDigest: readiness.fixedBaselineDigest,
		capacityLedgerDigest: readiness.capacityLedgerDigest,
		hiddenFailureDigest: readiness.hiddenFailureDigest,
		usageReconciliationRef: readiness.usageReconciliationRef,
		capacityReconciliationRef: readiness.capacityReconciliationRef,
		freshVerifierDecisionRef: readiness.freshVerifierDecisionRef,
		independentRedTeamDecisionRef: readiness.independentRedTeamDecisionRef,
	};
	const readinessBinding = workflowCompletionReadinessReceiptBindingDigest(bindingInput);
	assertReceiptKind(readiness.hostReceipt, ["decision", "adjudication"], "Completion readiness host receipt");
	const hostReceipt = await verifyReceipt({
		dependencies,
		receipt: readiness.hostReceipt,
		bindingDigest: readinessBinding,
		state,
		epochRef,
		trustedNow,
		label: "Completion readiness host receipt",
	});
	const adjudicationBinding = workflowCompletionAdjudicationReceiptBindingDigest(bindingInput);
	assertReceiptKind(readiness.adjudicationReceipt, ["adjudication"], "Completion adjudication receipt");
	const adjudicationReceipt = await verifyReceipt({
		dependencies,
		receipt: readiness.adjudicationReceipt,
		bindingDigest: adjudicationBinding,
		state,
		epochRef,
		trustedNow,
		label: "Completion adjudication receipt",
	});
	return [hostReceipt, adjudicationReceipt];
}

async function verifyCompletion(
	dependencies: WorkflowCompletionGateDependencies,
	input: WorkflowCompletionGateInput,
): Promise<WorkflowCompletionReadinessGrant> {
	const completeOutcome = assertCompleteOutcome(input);
	assertEpoch(input.currentEpoch, "Phase host current epoch");
	const current = await dependencies.resolveCurrentState();
	if (current === null) throw new Error("Completion gate requires a durable current workflow state.");
	const currentEpoch = await dependencies.resolveCurrentEpoch();
	assertEpoch(currentEpoch, "Completion resolver epoch");
	assertCurrentState(input, current, currentEpoch);
	if (
		completeOutcome.inputStateDigest !== current.sourceJournalDigest ||
		!sameEpoch(completeOutcome.epochRef, currentEpoch)
	) {
		throw new Error("Completion outcome is stale or not bound to the current state and epoch.");
	}
	const readiness = await dependencies.resolveReadiness({
		workflowId: input.workflowId,
		inputStateDigest: current.sourceJournalDigest,
		epochRef: currentEpoch,
		outcome: input.outcome,
		currentState: current,
	});
	assertReadinessShape(readiness, completeOutcome, input);
	assertReadinessReceiptDigest(readiness);
	const digestSources = await dependencies.resolveDigestSources({
		workflowId: input.workflowId,
		inputStateDigest: current.sourceJournalDigest,
		outputStateDigest: completeOutcome.outputStateDigest,
		epochRef: currentEpoch,
		currentState: current,
		outcome: input.outcome,
		readiness,
	});
	assertDigestClosure(readiness, digestSources);
	const canonicalValidationInput: WorkflowCompletionCanonicalValidationInput = {
		workflowId: input.workflowId,
		currentState: current,
		currentEpoch,
		outcome: input.outcome,
		readiness,
		digestSources,
	};
	await dependencies.validateEvidence(canonicalValidationInput);
	await dependencies.validateScorecard(canonicalValidationInput);
	await dependencies.validateProgress(canonicalValidationInput);
	await dependencies.validateResources(canonicalValidationInput);
	const outputRefs = [...completeOutcome.artifactRefs, ...completeOutcome.evidenceRefs];
	const refDigests = outputRefs.map((ref) => ref.digest);
	if (new Set(refDigests).size !== refDigests.length)
		throw new Error("Completion outcome repeats an output or evidence artifact reference.");
	for (const ref of outputRefs)
		await resolveImmutableArtifact(dependencies.resolveArtifact, ref, "Completion outcome artifact");
	const trustedNow = await dependencies.trustedNow();
	if (!isNonEmptyString(trustedNow) || !Number.isFinite(Date.parse(trustedNow)))
		throw new Error("Completion gate requires a trusted host clock observation.");
	const verifier = await verifyDecision(
		dependencies,
		readiness.freshVerifierDecisionRef,
		current,
		currentEpoch,
		"verifier",
		trustedNow,
	);
	const redTeam = await verifyDecision(
		dependencies,
		readiness.independentRedTeamDecisionRef,
		current,
		currentEpoch,
		"red_team",
		trustedNow,
	);
	if (
		verifier.decision.decisionId === redTeam.decision.decisionId ||
		(verifier.decision.revision === redTeam.decision.revision &&
			verifier.decision.decisionId === redTeam.decision.decisionId)
	)
		throw new Error("Completion verifier and red-team decisions must be distinct fresh decisions.");
	const reconciliationReceipts = await verifyReconciliations(
		dependencies,
		readiness,
		completeOutcome,
		current,
		currentEpoch,
		trustedNow,
	);
	const readinessReceipts = await verifyReadinessReceipts(
		dependencies,
		readiness,
		current,
		currentEpoch,
		digestObject(completeOutcome.artifactRefs),
		digestObject(completeOutcome.evidenceRefs),
		trustedNow,
	);
	const receipts = [verifier.receipt, redTeam.receipt, ...reconciliationReceipts, ...readinessReceipts];
	return createReadinessGrant(input, current, currentEpoch, readiness, receipts, completeOutcome);
}

/**
 * Creates the host-owned completion gate used by the workflow phase host.
 *
 * Args:
 * dependencies: Canonical state, epoch, readiness, digest, artifact, decision, and receipt resolvers.
 * Return: A fail-closed completion gate that performs no workflow mutation.
 */
export function createWorkflowCompletionGate(dependencies: WorkflowCompletionGateDependencies): WorkflowCompletionGate {
	return new WorkflowCompletionGate(COMPLETION_GATE_TOKEN, dependencies);
}

/**
 * Creates the persisted-host completion gate bound to one reducer store.
 *
 * Args:
 * store: Exact reducer store that the gate may authorize.
 * dependencies: Canonical host resolvers and atomic commit authority.
 * Return: Frozen completion gate sealed to the supplied store.
 */
export function createWorkflowCompletionGateForStore(
	store: object,
	dependencies: WorkflowCompletionGateDependencies,
): WorkflowCompletionGate {
	if (!(store instanceof WorkflowStore))
		throw new Error("Persisted completion gates can only bind the host-owned WorkflowStore instance.");
	return new WorkflowCompletionGate(COMPLETION_GATE_TOKEN, dependencies, store);
}
