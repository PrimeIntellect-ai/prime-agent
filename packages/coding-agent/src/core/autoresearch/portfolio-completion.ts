import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	sha256Hex,
	type WorkflowArtifactRef,
	type WorkflowEpochRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowHostReceiptConsumerContext,
	type WorkflowHostReceiptConsumptionWitness,
	type WorkflowMetricEvaluation,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import type { DefaultPrimeGoalMetricEvaluationEvidence } from "../workflow/default-completion.js";
import { assertWorkflowRuntimeVersion } from "../workflow/runtime-store-adapter.js";
import {
	type AutoResearchPortfolioCandidate,
	type AutoResearchPortfolioContract,
	type AutoResearchPortfolioMeasurement,
	type AutoResearchPortfolioSplitClosureRoots,
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
	validateAutoResearchPortfolioMeasurementBinding,
} from "./portfolio-contracts.js";
import {
	type AutoResearchPortfolioAdmissionIntent,
	type AutoResearchPortfolioImpactClosure,
	type AutoResearchPortfolioPreflightResult,
	deriveAutoResearchPortfolioImpactClosure,
	preflightAutoResearchPortfolioCandidate,
} from "./portfolio-frontier.js";
import {
	evaluatePortfolioTerminal,
	type PortfolioGoalDispositionResult,
	type PortfolioHostMeasurementEvidence,
	type PortfolioTerminalCapabilityRole,
	type PortfolioTerminalCommitIntent,
	type PortfolioTerminalInput,
	portfolioAcquisitionBindingDigest,
	portfolioBoundaryBindingDigest,
	portfolioCompletionBindingDigest,
	portfolioDefaultCompletionOperationDigest,
	portfolioDefaultCompletionResourceDigest,
	portfolioFrontierBindingDigest,
	portfolioGoalDecisionBindingDigest,
	portfolioInfeasibilityAdjudicationBindingDigest,
	portfolioInfeasibilityProofBindingDigest,
	portfolioMeasurementBindingDigest,
	portfolioStopBindingDigest,
	portfolioTradeoffBindingDigest,
} from "./portfolio-terminal.js";
import { type AutoResearchRunHostAuthority, resolveAutoResearchArtifactRefs } from "./runtime-adapter.js";

export interface PortfolioCompletionGoalMetricEvaluationEvidence extends DefaultPrimeGoalMetricEvaluationEvidence {
	readonly portfolioDigest: string;
	readonly vectorDigest: string;
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: Readonly<{
		readonly training: string;
		readonly validation: string;
		readonly holdout: string;
	}>;
	readonly evaluatorDigest: string;
	readonly parserDigest: string;
	readonly commandDigest: string;
	readonly measurementId: string;
	readonly measurementDigest: string;
	readonly inputDigest: string;
	readonly workspaceDigest: string;
	readonly evidenceDigests: readonly string[];
	readonly repeatIndex: number;
	readonly sampleCount: number;
	readonly confidenceInterval: Readonly<{
		readonly lower: number;
		readonly upper: number;
		readonly level: number;
	}>;
	readonly aggregation: "exact" | "mean" | "median";
	readonly measuredAt: string;
	readonly closureRootDigest: string;
	readonly manifestRevision: number;
	readonly evaluationEpoch: number;
	readonly candidateId: string;
	readonly domainId: string;
	readonly vector: readonly { readonly metricId: string; readonly value: number }[];
	readonly artifactRefs: readonly WorkflowArtifactRef[];
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly supportingReceipts: readonly PortfolioCompletionReceiptProjection[];
	readonly holdoutAggregateId: string;
	readonly holdoutAggregateDigest: string;
	readonly workflowId: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
}

export interface PortfolioCompletionReceiptProjection {
	readonly receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
	readonly oneUse: boolean;
	readonly receiptId: string;
	readonly issuerId: string;
	readonly bindingDigest: string;
	readonly payloadDigest: string;
	readonly verificationDigest: string;
}

export interface PortfolioCompletionBridgeResult {
	readonly terminalOutcome: "complete";
	readonly portfolioDigest: string;
	readonly vectorDigest: string;
	readonly commitStatus: "committed" | "already_committed";
	readonly completionTransaction: PortfolioCompletionAtomicTransaction;
	readonly goalMetricEvaluations: readonly PortfolioCompletionGoalMetricEvaluationEvidence[];
}

export interface PortfolioCompletionReceiptCommitment {
	readonly receiptId: string;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
	readonly verificationDigest: string;
	readonly witness: WorkflowHostReceiptConsumptionWitness;
}

export interface PortfolioCompletionResolvedDataClosure {
	readonly split: "training" | "validation" | "holdout";
	readonly manifestDigest: string;
	readonly closureRootDigest: string;
	readonly artifactRefs: readonly WorkflowArtifactRef[];
	readonly artifactDigests: readonly string[];
}

export interface PortfolioCompletionDataClosureResolutionInput {
	readonly split: "training" | "validation" | "holdout";
	readonly manifestDigest: string;
	readonly closureRootDigest: string;
}

export type PortfolioCompletionDataClosureResolver = (
	input: PortfolioCompletionDataClosureResolutionInput,
) => Promise<PortfolioCompletionResolvedDataClosure>;

export interface PortfolioCompletionInvariantEvidence {
	readonly invariantId: string;
	readonly checkDigest: string;
	readonly passed: true;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioCompletionFrontierAdmissionEvidence {
	readonly admissionDigest: string;
	readonly candidateId: string;
	readonly candidateReviewDigest: string;
	readonly preflightDigest: string;
	readonly frontierDigest: string;
	readonly impactClosure: AutoResearchPortfolioImpactClosure;
	readonly invariantEvidence: readonly PortfolioCompletionInvariantEvidence[];
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly admissionIntent: AutoResearchPortfolioAdmissionIntent;
}

export interface PortfolioCompletionAuditRecord {
	readonly kind: "portfolio.default_completion.replayable_audit.v1";
	readonly portfolioDigest: string;
	readonly vectorDigest: string;
	readonly baseline: readonly {
		readonly goalId: string;
		readonly metricId: string;
		readonly value: number;
		readonly evidenceDigest: string;
		readonly measurementId: string;
		readonly inputManifestDigest: string;
		readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
		readonly evaluationEpoch: number;
	}[];
	readonly candidateBinding: {
		readonly candidateId: string;
		readonly candidateDigest: string;
		readonly reviewDigest: string;
		readonly solutionFamilyDigest: string;
		readonly causalMechanismDigest: string;
		readonly ancestryDigest: string;
		readonly pathsDigest: string;
		readonly changeDigest: string;
	};
	readonly impactClosure: AutoResearchPortfolioImpactClosure;
	readonly frontierAdmissionDigest: string;
	readonly terminal: {
		readonly evaluationDigest: string;
		readonly outcome: "complete";
		readonly selectedFrontierEntryIds: readonly string[];
		readonly goalDispositions: readonly PortfolioGoalDispositionResult[];
	};
	readonly measurements: readonly {
		readonly measurementId: string;
		readonly goalId: string;
		readonly candidateId: string | null;
		readonly kind: AutoResearchPortfolioMeasurement["kind"];
		readonly vector: readonly { readonly metricId: string; readonly value: number }[];
		readonly measurementDigest: string;
		readonly receiptId: string;
		readonly receiptBindingDigest: string;
		readonly receiptPayloadDigest: string;
		readonly verificationDigest: string;
		readonly aggregateId: string | null;
		readonly aggregateDigest: string | null;
	}[];
	readonly receiptCommitments: readonly Omit<PortfolioCompletionReceiptCommitment, "witness">[];
	readonly splitProvenance: {
		readonly manifestDigest: string;
		readonly closureRootDigest: string;
		readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
		readonly resolved: readonly {
			readonly split: "training" | "validation" | "holdout";
			readonly artifactDigests: readonly string[];
		}[];
	};
	readonly holdoutAggregateKinds: readonly string[];
}

export interface PortfolioCompletionAtomicTransaction {
	readonly terminalCommitIntent: PortfolioTerminalCommitIntent;
	readonly receiptCommitments: readonly PortfolioCompletionReceiptCommitment[];
	readonly auditDigest: string;
	readonly audit: PortfolioCompletionAuditRecord;
	readonly journalRecordDigest: string;
	readonly transactionDigest: string;
}

export interface PortfolioCompletionAtomicCommitInput {
	readonly workflowId: string;
	readonly currentStateDigest: string;
	readonly currentRevision: number;
	readonly evaluationEpoch: number;
	readonly epochRef: WorkflowEpochRef;
	readonly terminalCommitIntent: PortfolioTerminalCommitIntent;
	readonly receipts: readonly WorkflowVerifiedHostReceipt[];
	readonly receiptCommitments: readonly Omit<PortfolioCompletionReceiptCommitment, "witness">[];
	readonly auditDigest: string;
	readonly audit: PortfolioCompletionAuditRecord;
	readonly transactionDigest: string;
}

export interface PortfolioCompletionAtomicCommitResult {
	readonly status: "committed" | "already_committed";
	readonly transactionDigest: string;
	readonly journalRecordDigest: string;
	readonly witnesses: readonly WorkflowHostReceiptConsumptionWitness[];
}

export type PortfolioCompletionAtomicCommitter = (
	input: PortfolioCompletionAtomicCommitInput,
) => Promise<PortfolioCompletionAtomicCommitResult>;

export interface PortfolioCompletionHoldoutAggregateEvidence {
	readonly aggregateId: string;
	readonly goalId: string;
	readonly candidateId: string | null;
	readonly aggregateDigest: string;
	readonly evidenceDigest: string;
	readonly envelope: PortfolioCompletionHoldoutAggregateEnvelope;
}

export interface PortfolioCompletionHoldoutAggregateEnvelope {
	readonly kind: "host_only_holdout_aggregate";
	readonly aggregateId: string;
	readonly goalId: string;
	readonly candidateId: string | null;
	readonly metricVector: readonly { readonly metricId: string; readonly value: number }[];
	readonly inputManifestDigest: string;
	readonly splitClosureRoots: AutoResearchPortfolioSplitClosureRoots;
	readonly rawRows: null;
	readonly perCase: null;
	readonly envelopeDigest: string;
}

export interface PortfolioCompletionMeasurementConsumption {
	readonly measurementId: string;
	readonly receipt: WorkflowVerifiedHostReceipt;
}

export interface PortfolioCompletionCurrentHead {
	readonly stateDigest: string;
	readonly revision: number;
	readonly evaluationEpoch: number;
}

export interface PortfolioCompletionHostAuthorityInput {
	readonly runtime: AutoResearchRunHostAuthority;
	readonly runtimeVersion: string;
	readonly sessionId: string;
	readonly candidate: AutoResearchPortfolioCandidate;
	readonly priorCandidates: readonly AutoResearchPortfolioCandidate[];
	readonly frontierCandidates: readonly AutoResearchPortfolioCandidate[];
	readonly holdoutAggregates: readonly PortfolioCompletionHoldoutAggregateEvidence[];
	readonly frontierAdmission: PortfolioCompletionFrontierAdmissionEvidence;
	readonly resolveDataClosure: PortfolioCompletionDataClosureResolver;
	readonly measurementConsumptionReceipts: readonly PortfolioCompletionMeasurementConsumption[];
	readonly commitCompletion: PortfolioCompletionAtomicCommitter;
	readonly readCurrentHead: () => Promise<PortfolioCompletionCurrentHead>;
}

const portfolioCompletionAuthorityBrand: unique symbol = Symbol("portfolio-completion-host-authority");

export interface PortfolioCompletionHostAuthority {
	readonly [portfolioCompletionAuthorityBrand]: true;
	readonly workflowId: string;
}

export interface PortfolioCompletionRequest {
	readonly terminal: PortfolioTerminalInput;
	readonly authority: PortfolioCompletionHostAuthority;
}

function assertPrincipalAuthorizationDecision(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	input: WorkflowHostPrincipalCapabilityAuthorizationInput,
): void {
	if (
		decision.authenticatedPrincipal.length === 0 ||
		decision.keyOwnerPrincipal.length === 0 ||
		decision.capability !== input.capability ||
		decision.workflowId !== input.workflowId ||
		decision.bindingDigest !== input.bindingDigest ||
		decision.stateDigest !== input.stateDigest ||
		decision.revision !== input.revision ||
		decision.validity.issuedAt !== input.receipt.issuedAt ||
		decision.validity.validUntil !== input.receipt.validUntil ||
		decision.executionIdentity !== input.executionIdentity ||
		decision.sessionId !== input.sessionId ||
		!/^[0-9a-f]{64}$/u.test(decision.authorizationDigest) ||
		decision.epochRef.storeEpoch !== input.epochRef.storeEpoch ||
		decision.epochRef.coordinatorEpoch !== input.epochRef.coordinatorEpoch ||
		digestObject(decision.receipt) !== digestObject(input.receipt)
	) {
		throw new Error("portfolio_completion_principal_authorization_invalid");
	}
}

interface ValidPortfolioMeasurement {
	readonly goal: AutoResearchPortfolioContract["goals"][number];
	readonly evidence: PortfolioHostMeasurementEvidence;
	readonly measurement: AutoResearchPortfolioMeasurement;
}

interface AuthorizedCompletionReceipt {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly bindingDigest: string;
	readonly resourceDigest: string;
	readonly operationDigest: string;
}

const PORTFOLIO_TERMINAL_INPUT_KEYS = [
	"contract",
	"workflowId",
	"currentStateDigest",
	"currentRevision",
	"trustedNow",
	"receiptContext",
	"measurements",
	"frontier",
	"boundaries",
	"acquisition",
	"completion",
	"tradeoff",
	"infeasibility",
	"goalDecisions",
	"stop",
] as const;

const PORTFOLIO_MEASUREMENT_EVIDENCE_KEYS = ["measurement", "receipt"] as const;

const PORTFOLIO_MEASUREMENT_KEYS = [
	"measurementId",
	"goalId",
	"candidateId",
	"scope",
	"kind",
	"vector",
	"repeatIndex",
	"sampleCount",
	"inputDigest",
	"inputManifestDigest",
	"evaluatorDigest",
	"parserDigest",
	"commandDigest",
	"workspaceDigest",
	"evidenceDigests",
	"measuredAt",
	"measurementDigest",
	"evaluationEpoch",
	"splitClosureRoots",
	"confidenceInterval",
	"variance",
	"runCount",
	"aggregation",
] as const;

const PORTFOLIO_TERMINAL_MEASUREMENT_KINDS = ["candidate", "holdout", "adversarial"] as const;

const PORTFOLIO_COMPLETION_REQUEST_KEYS = ["terminal", "authority"] as const;
const PORTFOLIO_COMPLETION_AGGREGATE_KEYS = [
	"aggregateId",
	"goalId",
	"candidateId",
	"aggregateDigest",
	"evidenceDigest",
	"envelope",
] as const;
const PORTFOLIO_COMPLETION_AGGREGATE_ENVELOPE_KEYS = [
	"kind",
	"aggregateId",
	"goalId",
	"candidateId",
	"metricVector",
	"inputManifestDigest",
	"splitClosureRoots",
	"rawRows",
	"perCase",
	"envelopeDigest",
] as const;
const PORTFOLIO_COMPLETION_INVARIANT_KEYS = ["invariantId", "checkDigest", "passed", "receipt"] as const;
const PORTFOLIO_COMPLETION_IMPACT_CLOSURE_KEYS = [
	"authority",
	"derivationVersion",
	"directGoalIds",
	"transitiveGoalIds",
	"affectedPartitionIds",
	"affectedInvariantIds",
	"sourceDigest",
	"closureDigest",
	"intendedGoalIds",
	"dependentGoalIds",
	"competingGoalIds",
	"conflictRelatedGoalIds",
	"structurallyAffectedGoalIds",
	"goalIds",
	"metricIds",
	"impactClosureDigest",
] as const;
const PORTFOLIO_COMPLETION_FRONTIER_ADMISSION_KEYS = [
	"admissionDigest",
	"candidateId",
	"candidateReviewDigest",
	"preflightDigest",
	"frontierDigest",
	"impactClosure",
	"invariantEvidence",
	"receipt",
	"admissionIntent",
] as const;
const PORTFOLIO_COMPLETION_CONSUMPTION_KEYS = ["measurementId", "receipt"] as const;
const PORTFOLIO_COMPLETION_AUTHORITY_KEYS = [
	"runtime",
	"runtimeVersion",
	"sessionId",
	"candidate",
	"priorCandidates",
	"frontierCandidates",
	"holdoutAggregates",
	"frontierAdmission",
	"resolveDataClosure",
	"measurementConsumptionReceipts",
	"commitCompletion",
	"readCurrentHead",
] as const;

interface PortfolioCompletionHostAuthorityBinding extends PortfolioCompletionHostAuthorityInput {}

const portfolioCompletionAuthorityBindings = new WeakMap<object, PortfolioCompletionHostAuthorityBinding>();

function exactKeys(value: unknown, expected: readonly string[], label: string): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`portfolio_completion_${label}_unknown_record`);
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new Error(`portfolio_completion_${label}_unknown_record`);
	}
	const ownKeys = Reflect.ownKeys(value);
	if (ownKeys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) {
		throw new Error(`portfolio_completion_${label}_unknown_record`);
	}
	const actual = ownKeys.filter((key): key is string => typeof key === "string").sort();
	const keys = [...expected].sort();
	if (JSON.stringify(actual) !== JSON.stringify(keys)) throw new Error(`portfolio_completion_${label}_unknown_record`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return (
		JSON.stringify([...left].sort((a, b) => a.localeCompare(b))) ===
		JSON.stringify([...right].sort((a, b) => a.localeCompare(b)))
	);
}

function sameSplitClosureRoots(
	left: AutoResearchPortfolioSplitClosureRoots,
	right: AutoResearchPortfolioSplitClosureRoots,
): boolean {
	return left.training === right.training && left.validation === right.validation && left.holdout === right.holdout;
}

function isDeepFrozen(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return true;
	return Object.isFrozen(value) && Object.values(value).every((child) => isDeepFrozen(child));
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	}
	return value;
}

async function authorizeReceiptPrincipal(
	context: WorkflowHostReceiptConsumerContext,
	runtime: AutoResearchRunHostAuthority,
	sessionId: string,
	workflowId: string,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
	stateDigest: string,
	revision: number,
	expectedResourceDigest: string,
	expectedOperationDigest: string,
): Promise<void> {
	const durable = runtime.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("portfolio_completion_host_authority_requires_persisted_runtime");
	const leaseRef = await runtime.resolveLeaseRef();
	if (
		leaseRef.storeEpoch !== durable.epochRef.storeEpoch ||
		leaseRef.coordinatorEpoch !== durable.epochRef.coordinatorEpoch ||
		leaseRef.writerIdentity !== runtime.writerIdentity ||
		leaseRef.processIdentity.length === 0
	) {
		throw new Error("portfolio_completion_execution_lease_stale");
	}
	const capabilityBinding = receipt.capabilityBinding;
	if (capabilityBinding !== undefined) {
		exactKeys(
			capabilityBinding,
			["capability", "resourceDigest", "operationDigest", "executionIdentity", "sessionId"],
			"receipt_capability_binding",
		);
	}
	if (
		capabilityBinding === undefined ||
		capabilityBinding.capability !== "portfolio_default_completion" ||
		!/^[0-9a-f]{64}$/u.test(capabilityBinding.resourceDigest) ||
		!/^[0-9a-f]{64}$/u.test(capabilityBinding.operationDigest) ||
		(typeof capabilityBinding.executionIdentity !== "string" && capabilityBinding.executionIdentity !== null) ||
		(typeof capabilityBinding.sessionId !== "string" && capabilityBinding.sessionId !== null) ||
		capabilityBinding.sessionId !== sessionId ||
		capabilityBinding.executionIdentity !== leaseRef.processIdentity ||
		capabilityBinding.resourceDigest !== expectedResourceDigest ||
		capabilityBinding.operationDigest !== expectedOperationDigest
	) {
		throw new Error("portfolio_completion_principal_capability_binding_invalid");
	}
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt,
		capability: capabilityBinding.capability,
		workflowId,
		bindingDigest,
		resourceDigest: capabilityBinding.resourceDigest,
		operationDigest: capabilityBinding.operationDigest,
		stateDigest,
		revision,
		epochRef: durable.epochRef,
		executionIdentity: leaseRef.processIdentity,
		sessionId,
	};
	const decision = await context.principalAuthorizer.authorize(authorizationInput);
	assertPrincipalAuthorizationDecision(decision, authorizationInput);
}

function assertHostRuntimeAuthority(input: PortfolioCompletionHostAuthorityInput): void {
	const runtime = input.runtime;
	if (runtime.runtimeStore.identity.workflowId !== input.runtime.workflowId)
		throw new Error("portfolio_completion_host_authority_workflow_mismatch");
	if (runtime.runtimeStore.durableContext === undefined) {
		throw new Error("portfolio_completion_host_authority_requires_persisted_runtime");
	}
	if (runtime.receiptContext.artifactResolver !== runtime.artifactResolver) {
		throw new Error("portfolio_completion_host_authority_artifact_resolver_mismatch");
	}
	if (runtime.receiptContext.signer === undefined) {
		throw new Error("portfolio_completion_host_authority_signer_missing");
	}
	if (typeof runtime.receiptContext.principalAuthorizer?.authorize !== "function") {
		throw new Error("CONTRACT_CHANGE: portfolio completion requires the generic host principalAuthorizer seam.");
	}
	if (typeof input.commitCompletion !== "function") {
		throw new Error("CONTRACT_CHANGE: portfolio completion requires the host atomic commit seam.");
	}
	if (typeof input.resolveDataClosure !== "function") {
		throw new Error("CONTRACT_CHANGE: portfolio completion requires the host data-closure evaluator seam.");
	}
	if (runtime.workflowId.length === 0 || runtime.executionKey.length === 0 || runtime.writerIdentity.length === 0) {
		throw new Error("portfolio_completion_host_authority_identity_invalid");
	}
	if (input.sessionId.length === 0 || input.sessionId.trim().length === 0) {
		throw new Error("portfolio_completion_host_authority_session_invalid");
	}
	if (typeof input.readCurrentHead !== "function") {
		throw new Error("portfolio_completion_host_authority_head_reader_missing");
	}
}

/**
 * Bind completion evidence to the persisted host runtime and authorized evidence identities.
 *
 * Args:
 * input: Host-owned runtime, candidate/frontier projection, aggregate evidence, and consumption receipts.
 * Return: Opaque authority accepted by the completion bridge.
 */
export function createPortfolioCompletionHostAuthority(
	input: PortfolioCompletionHostAuthorityInput,
): PortfolioCompletionHostAuthority {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("portfolio_completion_host_authority_unknown_record");
	}
	const runtimeVersion = Reflect.get(input, "runtimeVersion");
	assertWorkflowRuntimeVersion(typeof runtimeVersion === "string" ? runtimeVersion : undefined);
	exactKeys(input, PORTFOLIO_COMPLETION_AUTHORITY_KEYS, "host_authority");
	assertHostRuntimeAuthority(input);
	const authority = Object.freeze({
		[portfolioCompletionAuthorityBrand]: true as const,
		workflowId: input.runtime.workflowId,
	});
	portfolioCompletionAuthorityBindings.set(authority, {
		runtime: input.runtime,
		runtimeVersion: input.runtimeVersion,
		sessionId: input.sessionId,
		candidate: deepFreeze(structuredClone(input.candidate)),
		priorCandidates: deepFreeze(structuredClone(input.priorCandidates)),
		frontierCandidates: deepFreeze(structuredClone(input.frontierCandidates)),
		holdoutAggregates: deepFreeze(structuredClone(input.holdoutAggregates)),
		frontierAdmission: deepFreeze(structuredClone(input.frontierAdmission)),
		resolveDataClosure: input.resolveDataClosure,
		measurementConsumptionReceipts: deepFreeze(structuredClone(input.measurementConsumptionReceipts)),
		commitCompletion: input.commitCompletion,
		readCurrentHead: input.readCurrentHead,
	});
	return authority;
}

function authorityBinding(
	authority: PortfolioCompletionHostAuthority,
	input: PortfolioTerminalInput,
): PortfolioCompletionHostAuthorityBinding {
	const binding =
		typeof authority === "object" && authority !== null
			? portfolioCompletionAuthorityBindings.get(authority)
			: undefined;
	if (
		binding === undefined ||
		(authority as unknown as Record<PropertyKey, unknown>)[portfolioCompletionAuthorityBrand] !== true ||
		authority.workflowId !== input.workflowId ||
		binding.runtime.workflowId !== input.workflowId ||
		binding.runtime.receiptContext !== input.receiptContext
	) {
		throw new Error("portfolio_completion_host_authority_mismatch");
	}
	return binding;
}

function parsedAndClosedContract(input: PortfolioTerminalInput): void {
	if (!isDeepFrozen(input.contract)) {
		throw new Error("portfolio_completion_contract_must_be_parsed_and_frozen");
	}
	let parsed: ReturnType<typeof parseAutoResearchPortfolioContract>;
	try {
		parsed = parseAutoResearchPortfolioContract(structuredClone(input.contract));
	} catch (error) {
		throw new Error(`portfolio_completion_contract_invalid: ${String(error)}`);
	}
	if (digestObject(parsed) !== digestObject(input.contract)) {
		throw new Error("portfolio_completion_contract_not_canonical");
	}
	const access = input.contract.inputManifest.modelAccess;
	if (
		access.holdoutRowsVisible !== false ||
		access.holdoutPerCaseFeedback !== false ||
		access.holdoutReturns !== "aggregate_signed_evidence_only" ||
		access.signedAggregateEvidence !== true
	) {
		throw new Error("portfolio_completion_holdout_evidence_exposed");
	}
}

function candidateReviewBindingDigest(candidate: AutoResearchPortfolioCandidate): string {
	return digestObject({
		candidateId: candidate.candidateId,
		goalIds: [...candidate.goalIds].sort((left, right) => left.localeCompare(right)),
		solutionFamily: candidate.solutionFamily,
		ancestry: candidate.ancestry,
		causalMechanism: candidate.causalMechanism,
		change: {
			kind: candidate.change.kind,
			changedPaths: [...candidate.change.changedPaths].sort((left, right) => left.localeCompare(right)),
			parameterChanges: [...candidate.change.parameterChanges].sort((left, right) => left.localeCompare(right)),
			changeDigest: candidate.change.changeDigest,
		},
		scope: candidate.scope,
	});
}

function parseCanonicalCandidate(value: AutoResearchPortfolioCandidate, label: string): AutoResearchPortfolioCandidate {
	let parsed: AutoResearchPortfolioCandidate;
	try {
		parsed = parseAutoResearchPortfolioCandidate(structuredClone(value));
	} catch (error) {
		throw new Error(`portfolio_completion_${label}_not_canonical:${String(error)}`);
	}
	if (digestObject(parsed) !== digestObject(value)) {
		throw new Error(`portfolio_completion_${label}_not_canonical`);
	}
	return parsed;
}

function validateCandidateAndFrontierBindings(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
): void {
	const candidate = parseCanonicalCandidate(authority.candidate, "candidate");
	const priorCandidates = authority.priorCandidates.map((entry) =>
		parseCanonicalCandidate(entry, "candidate_history"),
	);
	const frontierCandidates = authority.frontierCandidates.map((entry) =>
		parseCanonicalCandidate(entry, "frontier_candidate"),
	);
	if (
		new Set([candidate, ...priorCandidates].map((entry) => entry.candidateId)).size !== 1 + priorCandidates.length ||
		new Set(priorCandidates.map((entry) => entry.candidateId)).size !== priorCandidates.length ||
		new Set(frontierCandidates.map((entry) => entry.candidateId)).size !== frontierCandidates.length ||
		new Set(frontierCandidates.map((entry) => entry.solutionFamily.familyId)).size !== frontierCandidates.length ||
		new Set(frontierCandidates.map((entry) => digestObject(entry.causalMechanism))).size !==
			frontierCandidates.length ||
		frontierCandidates.some(
			(entry) =>
				entry.candidateId !== candidate.candidateId &&
				priorCandidates.some((prior) => prior.candidateId === entry.candidateId),
		)
	) {
		throw new Error("portfolio_completion_candidate_identifiers_duplicated");
	}
	let preflight: ReturnType<typeof preflightAutoResearchPortfolioCandidate>;
	try {
		preflight = preflightAutoResearchPortfolioCandidate({
			contract: input.contract,
			candidate,
			priorCandidates,
		});
	} catch (error) {
		throw new Error(`portfolio_completion_candidate_preflight_invalid:${String(error)}`);
	}
	if (!preflight.allowed) {
		throw new Error(`portfolio_completion_candidate_preflight_rejected:${preflight.reasons.join(",")}`);
	}
	for (const frontierCandidate of frontierCandidates) {
		const frontierPreflight = preflightAutoResearchPortfolioCandidate({
			contract: input.contract,
			candidate: frontierCandidate,
			priorCandidates,
		});
		if (!frontierPreflight.allowed) {
			throw new Error(
				`portfolio_completion_frontier_candidate_preflight_rejected:${frontierPreflight.reasons.join(",")}`,
			);
		}
	}
	const terminalGoalIds = input.contract.goals.filter((goal) => goal.scope === "terminal").map((goal) => goal.goalId);
	if (!sameStrings(candidate.goalIds, terminalGoalIds) || candidate.scope !== "terminal") {
		throw new Error("portfolio_completion_candidate_goal_binding_invalid");
	}
	const terminalFrontierCandidateIds = input.frontier.entries.map((entry) => entry.candidateId);
	const expectedFrontierCandidateIds = frontierCandidates.map((entry) => entry.candidateId);
	if (
		new Set(terminalFrontierCandidateIds).size !== terminalFrontierCandidateIds.length ||
		!sameStrings(terminalFrontierCandidateIds, expectedFrontierCandidateIds)
	) {
		throw new Error("portfolio_completion_frontier_candidate_coverage_incomplete");
	}
	for (const frontierEntry of input.frontier.entries) {
		const frontierCandidate = frontierCandidates.find((entry) => entry.candidateId === frontierEntry.candidateId);
		const frontierGoalDomains = frontierEntry.goalIds.map(
			(goalId) => input.contract.goals.find((goal) => goal.goalId === goalId)?.domainId,
		);
		if (
			frontierCandidate === undefined ||
			frontierGoalDomains.some((domainId) => domainId === undefined || domainId !== frontierEntry.domainId) ||
			!sameStrings(frontierEntry.goalIds, frontierCandidate.goalIds)
		) {
			throw new Error("portfolio_completion_frontier_candidate_binding_invalid");
		}
	}
	const selectedFrontierEntries = input.frontier.entries.filter((entry) =>
		input.frontier.selectedEntryIds.includes(entry.entryId),
	);
	if (
		selectedFrontierEntries.length === 0 ||
		selectedFrontierEntries.some((entry) => entry.candidateId !== candidate.candidateId)
	) {
		throw new Error("portfolio_completion_frontier_selection_unfavorable_subset");
	}
	const selectedCandidate = frontierCandidates.find((entry) => entry.candidateId === candidate.candidateId);
	if (
		selectedCandidate === undefined ||
		candidateReviewBindingDigest(selectedCandidate) !== candidateReviewBindingDigest(candidate)
	) {
		throw new Error("portfolio_completion_frontier_selected_candidate_binding_invalid");
	}
}

function candidateBindingRecord(
	candidate: AutoResearchPortfolioCandidate,
): PortfolioCompletionAuditRecord["candidateBinding"] {
	return {
		candidateId: candidate.candidateId,
		candidateDigest: digestObject(candidate),
		reviewDigest: candidateReviewBindingDigest(candidate),
		solutionFamilyDigest: digestObject(candidate.solutionFamily),
		causalMechanismDigest: digestObject(candidate.causalMechanism),
		ancestryDigest: digestObject(candidate.ancestry),
		pathsDigest: digestObject([...candidate.change.changedPaths].sort((left, right) => left.localeCompare(right))),
		changeDigest: candidate.change.changeDigest,
	};
}

function frontierAdmissionDigest(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
	impactClosure: AutoResearchPortfolioImpactClosure,
	preflight: AutoResearchPortfolioPreflightResult,
	invariantEvidence: readonly PortfolioCompletionInvariantEvidence[],
): string {
	return digestObject({
		kind: "portfolio.default_completion.frontier_admission.v1",
		portfolioDigest: digestObject(input.contract),
		candidate: candidateBindingRecord(authority.candidate),
		frontierDigest: digestObject({
			entries: authority.frontierCandidates
				.map((candidate) => ({ candidateId: candidate.candidateId, candidateDigest: digestObject(candidate) }))
				.sort((left, right) => left.candidateId.localeCompare(right.candidateId)),
			selectedEntryIds: [...input.frontier.selectedEntryIds].sort((left, right) => left.localeCompare(right)),
		}),
		impactClosure,
		preflightDigest: preflight.preflightDigest,
		invariantEvidence: invariantEvidence
			.map((entry) => ({
				invariantId: entry.invariantId,
				checkDigest: entry.checkDigest,
				passed: entry.passed,
				receiptDigest: digestObject(entry.receipt),
			}))
			.sort((left, right) => left.invariantId.localeCompare(right.invariantId)),
		receiptDigest: digestObject(input.frontier.receipt),
	});
}

function invariantBindingDigest(
	contract: AutoResearchPortfolioContract,
	invariantId: string,
	checkDigest: string,
	passed: boolean,
): string {
	return digestObject({
		kind: "portfolio.default_completion.invariant.v1",
		portfolioDigest: digestObject(contract),
		invariantId,
		checkDigest,
		passed,
	});
}

function validateFrontierAdmission(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
): PortfolioCompletionFrontierAdmissionEvidence {
	const admission = authority.frontierAdmission;
	exactKeys(admission, PORTFOLIO_COMPLETION_FRONTIER_ADMISSION_KEYS, "frontier_admission");
	exactKeys(admission.impactClosure, PORTFOLIO_COMPLETION_IMPACT_CLOSURE_KEYS, "impact_closure");
	if (
		!/^[0-9a-f]{64}$/u.test(admission.admissionDigest) ||
		admission.candidateId !== authority.candidate.candidateId ||
		admission.candidateReviewDigest !== candidateReviewBindingDigest(authority.candidate) ||
		!/^[0-9a-f]{64}$/u.test(admission.preflightDigest) ||
		!/^[0-9a-f]{64}$/u.test(admission.frontierDigest) ||
		admission.receipt.receiptId !== input.frontier.receipt.receiptId ||
		digestObject(admission.receipt) !== digestObject(input.frontier.receipt) ||
		typeof admission.admissionIntent !== "object"
	) {
		throw new Error("portfolio_completion_frontier_admission_invalid");
	}
	const expectedClosure = deriveAutoResearchPortfolioImpactClosure(input.contract, authority.candidate);
	if (digestObject(admission.impactClosure) !== digestObject(expectedClosure)) {
		throw new Error("portfolio_completion_impact_closure_not_host_derived");
	}
	let preflight: AutoResearchPortfolioPreflightResult;
	try {
		preflight = preflightAutoResearchPortfolioCandidate({
			contract: input.contract,
			candidate: authority.candidate,
			priorCandidates: authority.priorCandidates,
		});
	} catch (error) {
		throw new Error(`portfolio_completion_frontier_admission_preflight_invalid:${String(error)}`);
	}
	if (!preflight.allowed || preflight.preflightDigest !== admission.preflightDigest) {
		throw new Error("portfolio_completion_frontier_admission_preflight_invalid");
	}
	if (
		admission.impactClosure.authority !== "host_derived" ||
		admission.impactClosure.impactClosureDigest !== expectedClosure.impactClosureDigest
	) {
		throw new Error("portfolio_completion_impact_closure_not_host_derived");
	}
	const invariants = input.contract.invariants.filter((invariant) => invariant.scope === "terminal");
	if (admission.invariantEvidence.length !== invariants.length) {
		throw new Error("portfolio_completion_invariant_coverage_incomplete");
	}
	const seen = new Set<string>();
	for (const evidence of admission.invariantEvidence) {
		exactKeys(evidence, PORTFOLIO_COMPLETION_INVARIANT_KEYS, "invariant_evidence");
		const invariant = invariants.find((entry) => entry.invariantId === evidence.invariantId);
		if (
			invariant === undefined ||
			seen.has(evidence.invariantId) ||
			evidence.checkDigest !== invariant.checkDigest ||
			evidence.passed !== true ||
			evidence.receipt.receiptKind !== "capability" ||
			evidence.receipt.oneUse !== true ||
			evidence.receipt.bindingDigest !==
				invariantBindingDigest(input.contract, evidence.invariantId, evidence.checkDigest, true)
		) {
			throw new Error("portfolio_completion_invariant_evidence_invalid");
		}
		seen.add(evidence.invariantId);
	}
	const expectedAdmissionDigest = frontierAdmissionDigest(
		input,
		authority,
		expectedClosure,
		preflight,
		admission.invariantEvidence,
	);
	if (admission.admissionDigest !== expectedAdmissionDigest) {
		throw new Error("portfolio_completion_frontier_admission_digest_invalid");
	}
	exactKeys(
		admission.admissionIntent,
		[
			"kind",
			"productionOrphaned",
			"candidateId",
			"frontierDigest",
			"receiptCommitments",
			"runReceiptCommitments",
			"consumptionWitnesses",
			"candidateReviewDigest",
			"preflightDigest",
			"currentStateDigest",
			"currentRevision",
			"currentEpochRef",
			"measurementEvidenceDigest",
			"admissionDigest",
		],
		"frontier_admission_intent",
	);
	if (
		admission.admissionIntent.kind !== "autoresearch_portfolio_frontier_admission" ||
		admission.admissionIntent.productionOrphaned !== true ||
		admission.admissionIntent.candidateId !== authority.candidate.candidateId ||
		admission.admissionIntent.frontierDigest !== admission.frontierDigest ||
		admission.admissionIntent.candidateReviewDigest !== admission.candidateReviewDigest ||
		admission.admissionIntent.preflightDigest !== admission.preflightDigest ||
		admission.admissionIntent.currentStateDigest !== input.currentStateDigest ||
		admission.admissionIntent.currentRevision !== input.currentRevision ||
		admission.admissionIntent.admissionDigest !== admission.admissionDigest ||
		admission.admissionIntent.currentEpochRef.storeEpoch !==
			authority.runtime.runtimeStore.durableContext!.epochRef.storeEpoch ||
		admission.admissionIntent.currentEpochRef.coordinatorEpoch !==
			authority.runtime.runtimeStore.durableContext!.epochRef.coordinatorEpoch ||
		admission.admissionIntent.measurementEvidenceDigest !==
			digestObject(
				input.measurements.map(({ measurement }) => ({
					measurementId: measurement.measurementId,
					measurementDigest: measurement.measurementDigest,
				})),
			)
	) {
		throw new Error("portfolio_completion_frontier_admission_intent_invalid");
	}
	for (const commitment of admission.admissionIntent.receiptCommitments) {
		exactKeys(
			commitment,
			["receiptId", "bindingDigest", "authorizationDigest", "userAuthorityDigest"],
			"frontier_admission_receipt_commitment",
		);
	}
	for (const witness of admission.admissionIntent.consumptionWitnesses) {
		exactKeys(
			witness,
			["receiptId", "bindingDigest", "receiptDigest", "consumptionSequence", "consumedAt"],
			"frontier_admission_consumption_witness",
		);
	}
	return admission;
}

async function resolveDataClosures(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
): Promise<readonly PortfolioCompletionResolvedDataClosure[]> {
	const manifestDigest = input.contract.inputManifest.manifestDigest;
	const expectedRoots = input.contract.inputManifest.splitClosureRoots;
	const resolved: PortfolioCompletionResolvedDataClosure[] = [];
	for (const split of ["training", "validation", "holdout"] as const) {
		const value = await authority.resolveDataClosure({
			split,
			manifestDigest,
			closureRootDigest: expectedRoots[split],
		});
		exactKeys(
			value,
			["split", "manifestDigest", "closureRootDigest", "artifactRefs", "artifactDigests"],
			"data_closure_resolution",
		);
		if (
			value.split !== split ||
			value.manifestDigest !== manifestDigest ||
			value.closureRootDigest !== expectedRoots[split] ||
			!Array.isArray(value.artifactRefs) ||
			!Array.isArray(value.artifactDigests) ||
			value.artifactRefs.length === 0 ||
			value.artifactDigests.length !== value.artifactRefs.length ||
			value.artifactDigests.some((digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest)) ||
			new Set(value.artifactRefs.map((ref) => ref.artifactId)).size !== value.artifactRefs.length
		) {
			throw new Error("portfolio_completion_data_closure_binding_invalid");
		}
		const artifactDigests: string[] = [];
		for (const ref of value.artifactRefs) {
			const payload = await authority.runtime.artifactResolver.resolve(ref);
			if (
				!payload.exists ||
				!payload.envelope.immutable ||
				payload.verifiedDigest !== ref.digest ||
				payload.verifiedSizeBytes !== ref.sizeBytes ||
				payload.bytes.byteLength !== ref.sizeBytes ||
				sha256Hex(payload.bytes) !== ref.digest
			) {
				throw new Error("portfolio_completion_data_closure_artifact_unresolved");
			}
			artifactDigests.push(sha256Hex(payload.bytes));
		}
		if (!sameStrings(artifactDigests, value.artifactDigests)) {
			throw new Error("portfolio_completion_data_closure_rehash_mismatch");
		}
		resolved.push({
			...structuredClone(value),
			artifactRefs: structuredClone(value.artifactRefs),
			artifactDigests: [...artifactDigests],
		});
	}
	return resolved;
}

function validateBaselineNonRegression(
	goal: AutoResearchPortfolioContract["goals"][number],
	measurement: AutoResearchPortfolioMeasurement,
): void {
	for (const metric of goal.metrics) {
		const coordinate = measurement.vector.find((entry) => entry.metricId === metric.metricId);
		const baseline = goal.baseline.metricValues.find((entry) => entry.metricId === metric.metricId);
		if (coordinate === undefined || baseline === undefined) {
			throw new Error("portfolio_completion_baseline_metric_coverage_incomplete");
		}
		const regressed =
			metric.direction === "higher" ? coordinate.value < baseline.value : coordinate.value > baseline.value;
		const intervalRegressed =
			metric.direction === "higher"
				? measurement.confidenceInterval.upper < baseline.value
				: measurement.confidenceInterval.lower > baseline.value;
		if (regressed || intervalRegressed) throw new Error("portfolio_completion_baseline_regression");
	}
}

function aggregateDigest(aggregate: PortfolioCompletionHoldoutAggregateEvidence): string {
	return digestObject({
		aggregateId: aggregate.aggregateId,
		goalId: aggregate.goalId,
		candidateId: aggregate.candidateId,
		evidenceDigest: aggregate.evidenceDigest,
	});
}

function holdoutEnvelopeDigest(envelope: PortfolioCompletionHoldoutAggregateEnvelope): string {
	return digestObject({ ...envelope, envelopeDigest: "" });
}

function validateHoldoutAggregates(
	authority: PortfolioCompletionHostAuthorityBinding,
	measurements: readonly ValidPortfolioMeasurement[],
): Map<string, PortfolioCompletionHoldoutAggregateEvidence> {
	const aggregates = new Map<string, PortfolioCompletionHoldoutAggregateEvidence>();
	for (const aggregate of authority.holdoutAggregates) {
		exactKeys(aggregate, PORTFOLIO_COMPLETION_AGGREGATE_KEYS, "holdout_aggregate");
		exactKeys(aggregate.envelope, PORTFOLIO_COMPLETION_AGGREGATE_ENVELOPE_KEYS, "holdout_aggregate_envelope");
		if (
			typeof aggregate.aggregateId !== "string" ||
			typeof aggregate.goalId !== "string" ||
			(aggregate.candidateId !== null && typeof aggregate.candidateId !== "string") ||
			!/^[0-9a-f]{64}$/u.test(aggregate.aggregateDigest) ||
			!/^[0-9a-f]{64}$/u.test(aggregate.evidenceDigest) ||
			aggregates.has(aggregate.aggregateId) ||
			aggregateDigest(aggregate) !== aggregate.aggregateDigest ||
			aggregate.envelope.kind !== "host_only_holdout_aggregate" ||
			aggregate.envelope.aggregateId !== aggregate.aggregateId ||
			aggregate.envelope.goalId !== aggregate.goalId ||
			aggregate.envelope.candidateId !== aggregate.candidateId ||
			!/^[0-9a-f]{64}$/u.test(aggregate.envelope.inputManifestDigest) ||
			!Object.values(aggregate.envelope.splitClosureRoots).every((digest) => /^[0-9a-f]{64}$/u.test(digest)) ||
			!Array.isArray(aggregate.envelope.metricVector) ||
			aggregate.envelope.rawRows !== null ||
			aggregate.envelope.perCase !== null ||
			aggregate.envelope.envelopeDigest !== holdoutEnvelopeDigest(aggregate.envelope)
		) {
			throw new Error("portfolio_completion_holdout_aggregate_invalid");
		}
		if (
			aggregate.envelope.metricVector.some((coordinate) => {
				try {
					exactKeys(coordinate, ["metricId", "value"], "holdout_aggregate_coordinate");
				} catch {
					return true;
				}
				return typeof coordinate.metricId !== "string" || !Number.isFinite(coordinate.value);
			})
		) {
			throw new Error("portfolio_completion_holdout_aggregate_invalid");
		}
		aggregates.set(aggregate.aggregateId, aggregate);
	}
	const holdoutMeasurements = measurements.filter(({ measurement }) => measurement.kind === "holdout");
	if (aggregates.size !== holdoutMeasurements.length) {
		throw new Error("portfolio_completion_holdout_aggregate_coverage_incomplete");
	}
	for (const { goal, measurement } of holdoutMeasurements) {
		const aggregate = [...aggregates.values()].find(
			(entry) =>
				entry.goalId === goal.goalId &&
				entry.candidateId === measurement.candidateId &&
				measurement.evidenceDigests.includes(entry.evidenceDigest) &&
				entry.envelope.inputManifestDigest === measurement.inputManifestDigest &&
				sameSplitClosureRoots(entry.envelope.splitClosureRoots, measurement.splitClosureRoots) &&
				JSON.stringify(entry.envelope.metricVector) === JSON.stringify(measurement.vector),
		);
		if (aggregate === undefined) throw new Error("portfolio_completion_holdout_aggregate_binding_invalid");
	}
	return aggregates;
}

function measurementConsumptionBindingDigest(
	contract: AutoResearchPortfolioContract,
	measurement: AutoResearchPortfolioMeasurement,
	evidenceReceipt: WorkflowVerifiedHostReceipt,
): string {
	return digestObject({
		kind: "portfolio.default_completion.measurement_consumption.v1",
		portfolioDigest: digestObject(contract),
		measurementId: measurement.measurementId,
		measurementDigest: measurement.measurementDigest,
		evidenceReceiptId: evidenceReceipt.receiptId,
		evidenceBindingDigest: evidenceReceipt.bindingDigest,
		evidencePayloadDigest: evidenceReceipt.payloadDigest,
		evidenceArtifactRef: evidenceReceipt.artifactRef,
		evidenceVerificationDigest: evidenceReceipt.verificationDigest,
	});
}

async function authorizeMeasurementConsumptionReceipt(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
	measurement: AutoResearchPortfolioMeasurement,
	evidenceReceipt: WorkflowVerifiedHostReceipt,
): Promise<AuthorizedCompletionReceipt> {
	const consumption = authority.measurementConsumptionReceipts.find(
		(entry) => entry.measurementId === measurement.measurementId,
	);
	if (consumption === undefined) throw new Error("portfolio_completion_measurement_consumption_missing");
	exactKeys(consumption, PORTFOLIO_COMPLETION_CONSUMPTION_KEYS, "measurement_consumption");
	const expectedBindingDigest = measurementConsumptionBindingDigest(input.contract, measurement, evidenceReceipt);
	const terminalMeasurements = input.measurements.map(({ measurement: entry }) => entry);
	const resourceDigest = portfolioDefaultCompletionResourceDigest(input.contract, input, terminalMeasurements);
	const operationDigest = portfolioDefaultCompletionOperationDigest(
		input.contract,
		input,
		terminalMeasurements,
		"measurement",
		expectedBindingDigest,
	);
	const receipt = consumption.receipt;
	if (
		receipt.receiptKind !== "capability" ||
		receipt.oneUse !== true ||
		receipt.bindingDigest !== expectedBindingDigest
	) {
		throw new Error("portfolio_completion_measurement_consumption_invalid");
	}
	const verified = await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest,
		receipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	await authorizeReceiptPrincipal(
		input.receiptContext,
		authority.runtime,
		authority.sessionId,
		input.workflowId,
		verified,
		expectedBindingDigest,
		input.currentStateDigest,
		input.currentRevision,
		resourceDigest,
		operationDigest,
	);
	return { receipt: verified, bindingDigest: expectedBindingDigest, resourceDigest, operationDigest };
}

function validateVector(
	input: PortfolioTerminalInput,
	measurementEvidence: PortfolioHostMeasurementEvidence,
): ValidPortfolioMeasurement {
	exactKeys(input, PORTFOLIO_TERMINAL_INPUT_KEYS, "input");
	exactKeys(measurementEvidence, PORTFOLIO_MEASUREMENT_EVIDENCE_KEYS, "measurement_evidence");
	exactKeys(measurementEvidence.measurement, PORTFOLIO_MEASUREMENT_KEYS, "measurement");
	const rawMeasurement = measurementEvidence.measurement;
	const goal = input.contract.goals.find((entry) => entry.goalId === rawMeasurement.goalId);
	if (goal === undefined) throw new Error("portfolio_completion_measurement_goal_unknown");
	let measurement: AutoResearchPortfolioMeasurement;
	try {
		measurement = parseAutoResearchPortfolioMeasurement(structuredClone(rawMeasurement), {
			confidenceLevel: goal.uncertainty.confidence,
			evaluationEpoch: input.contract.inputManifest.evaluationEpoch,
			inputManifestDigest: input.contract.inputManifest.manifestDigest,
			splitClosureRoots: input.contract.inputManifest.splitClosureRoots,
		});
	} catch (error) {
		throw new Error(`portfolio_completion_measurement_not_canonical:${String(error)}`);
	}
	if (digestObject(measurement) !== digestObject(rawMeasurement)) {
		throw new Error("portfolio_completion_measurement_not_canonical");
	}
	if (
		measurement.scope !== "terminal" ||
		!PORTFOLIO_TERMINAL_MEASUREMENT_KINDS.some((kind) => kind === measurement.kind) ||
		measurement.candidateId === null
	) {
		throw new Error("portfolio_completion_measurement_not_terminal_vector");
	}
	exactKeys(measurement.splitClosureRoots, ["training", "validation", "holdout"], "split_closure_roots");
	exactKeys(measurement.confidenceInterval, ["lower", "upper", "level"], "confidence_interval");
	if (
		!Array.isArray(measurement.vector) ||
		Object.keys(measurement.vector).length !== measurement.vector.length ||
		measurement.vector.length === 0
	) {
		throw new Error("portfolio_completion_vector_empty");
	}
	if (
		!Array.isArray(measurement.evidenceDigests) ||
		Object.keys(measurement.evidenceDigests).length !== measurement.evidenceDigests.length ||
		measurement.evidenceDigests.length === 0 ||
		measurement.evidenceDigests.some((digest) => typeof digest !== "string")
	) {
		throw new Error("portfolio_completion_measurement_evidence_invalid");
	}
	for (const coordinate of measurement.vector) {
		exactKeys(coordinate, ["metricId", "value"], "vector_coordinate");
		if (
			typeof coordinate.metricId !== "string" ||
			coordinate.metricId.length === 0 ||
			!Number.isFinite(coordinate.value)
		) {
			throw new Error("portfolio_completion_vector_coordinate_invalid");
		}
	}
	const expectedMetricIds = goal.metrics.map((metric) => metric.metricId);
	const actualMetricIds = measurement.vector.map((coordinate) => coordinate.metricId);
	if (
		new Set(actualMetricIds).size !== actualMetricIds.length ||
		!sameStrings(actualMetricIds, expectedMetricIds) ||
		actualMetricIds.length !== expectedMetricIds.length
	) {
		throw new Error("portfolio_completion_vector_coordinates_incomplete");
	}
	if (!sameSplitClosureRoots(measurement.splitClosureRoots, input.contract.inputManifest.splitClosureRoots)) {
		throw new Error("portfolio_completion_split_closure_mismatch");
	}
	if (measurement.inputDigest !== measurement.inputManifestDigest) {
		throw new Error("portfolio_completion_input_manifest_mismatch");
	}
	if (
		measurement.evaluatorDigest !== goal.evaluator.evaluatorDigest ||
		measurement.parserDigest !== goal.parser.parserDigest ||
		measurement.commandDigest !== goal.command.commandDigest
	) {
		throw new Error("portfolio_completion_evaluator_parser_command_binding_invalid");
	}
	if (measurement.sampleCount < measurement.runCount) {
		throw new Error("portfolio_completion_measurement_sample_count_invalid");
	}
	if (measurement.confidenceInterval.upper - measurement.confidenceInterval.lower > goal.uncertainty.maxWidth) {
		throw new Error("portfolio_completion_measurement_uncertainty_width_invalid");
	}
	if (
		measurement.vector.some(
			(coordinate) =>
				coordinate.value < measurement.confidenceInterval.lower ||
				coordinate.value > measurement.confidenceInterval.upper,
		)
	) {
		throw new Error("portfolio_completion_measurement_uncertainty_invalid");
	}
	try {
		validateAutoResearchPortfolioMeasurementBinding(measurement, {
			confidenceLevel: goal.uncertainty.confidence,
			evaluationEpoch: input.contract.inputManifest.evaluationEpoch,
			inputManifestDigest: input.contract.inputManifest.manifestDigest,
			splitClosureRoots: input.contract.inputManifest.splitClosureRoots,
		});
	} catch (error) {
		throw new Error(`portfolio_completion_measurement_binding_invalid:${String(error)}`);
	}
	return { goal, evidence: { measurement, receipt: measurementEvidence.receipt }, measurement };
}

function completionVectorDigest(
	contract: AutoResearchPortfolioContract,
	measurements: readonly ValidPortfolioMeasurement[],
): string {
	return digestObject({
		kind: "portfolio.default_completion.vector.v1",
		portfolioDigest: digestObject(contract),
		measurements: measurements
			.map(({ measurement }) => ({
				measurementId: measurement.measurementId,
				measurementBindingDigest: portfolioMeasurementBindingDigest(contract, measurement),
				vector: [...measurement.vector].sort((left, right) => left.metricId.localeCompare(right.metricId)),
			}))
			.sort((left, right) => left.measurementId.localeCompare(right.measurementId)),
	});
}

async function verifyMeasurementReceipt(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
	measurementEvidence: PortfolioHostMeasurementEvidence,
	aggregate: PortfolioCompletionHoldoutAggregateEvidence | undefined,
): Promise<WorkflowVerifiedHostReceipt> {
	const bindingDigest = portfolioMeasurementBindingDigest(input.contract, measurementEvidence.measurement);
	const terminalMeasurements = input.measurements.map(({ measurement: entry }) => entry);
	const resourceDigest = portfolioDefaultCompletionResourceDigest(input.contract, input, terminalMeasurements);
	const operationDigest = portfolioDefaultCompletionOperationDigest(
		input.contract,
		input,
		terminalMeasurements,
		"measurement",
		bindingDigest,
	);
	if (measurementEvidence.receipt.receiptKind !== "artifact" || measurementEvidence.receipt.oneUse) {
		throw new Error("portfolio_completion_measurement_receipt_authority_invalid");
	}
	const receipt = await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: bindingDigest,
		receipt: measurementEvidence.receipt,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
	await authorizeReceiptPrincipal(
		input.receiptContext,
		authority.runtime,
		authority.sessionId,
		input.workflowId,
		receipt,
		bindingDigest,
		input.currentStateDigest,
		input.currentRevision,
		resourceDigest,
		operationDigest,
	);
	if (receipt.receiptKind !== "artifact") {
		throw new Error("portfolio_completion_measurement_receipt_kind_invalid");
	}
	if (!measurementEvidence.measurement.evidenceDigests.includes(receipt.payloadDigest)) {
		throw new Error("portfolio_completion_receipt_evidence_mismatch");
	}
	if (measurementEvidence.measurement.kind === "holdout") {
		if (aggregate === undefined || aggregate.evidenceDigest !== receipt.payloadDigest) {
			throw new Error("portfolio_completion_holdout_aggregate_payload_invalid");
		}
		const payload = await input.receiptContext.artifactResolver.resolve(receipt.artifactRef);
		if (
			!payload.exists ||
			!payload.envelope.immutable ||
			payload.verifiedDigest !== receipt.artifactRef.digest ||
			payload.verifiedSizeBytes !== receipt.artifactRef.sizeBytes ||
			payload.bytes.byteLength !== receipt.artifactRef.sizeBytes ||
			sha256Hex(payload.bytes) !== receipt.artifactRef.digest
		) {
			throw new Error("portfolio_completion_holdout_aggregate_payload_unresolved");
		}
	}
	return receipt;
}

function validateCurrentHead(input: PortfolioTerminalInput, head: PortfolioCompletionCurrentHead): void {
	exactKeys(head, ["stateDigest", "revision", "evaluationEpoch"], "current_head");
	if (
		typeof head.stateDigest !== "string" ||
		!Number.isSafeInteger(head.revision) ||
		head.revision < 1 ||
		!Number.isSafeInteger(head.evaluationEpoch) ||
		head.evaluationEpoch < 1 ||
		head.stateDigest !== input.currentStateDigest ||
		head.revision !== input.currentRevision ||
		head.evaluationEpoch !== input.contract.inputManifest.evaluationEpoch
	) {
		throw new Error("portfolio_completion_current_head_stale_or_epoch_invalid");
	}
}

function validateSupportingMeasurements(
	measurements: readonly ValidPortfolioMeasurement[],
	goalIds: readonly string[],
): void {
	for (const goalId of goalIds) {
		const goalMeasurements = measurements.filter(({ measurement }) => measurement.goalId === goalId);
		const candidate = goalMeasurements.find(({ measurement }) => measurement.kind === "candidate");
		if (candidate === undefined) throw new Error("portfolio_completion_candidate_measurement_coverage_incomplete");
		for (const { measurement } of goalMeasurements) {
			if (
				measurement.candidateId !== candidate.measurement.candidateId ||
				measurement.inputDigest !== candidate.measurement.inputDigest ||
				measurement.inputManifestDigest !== candidate.measurement.inputManifestDigest ||
				measurement.evaluatorDigest !== candidate.measurement.evaluatorDigest ||
				measurement.parserDigest !== candidate.measurement.parserDigest ||
				measurement.commandDigest !== candidate.measurement.commandDigest ||
				measurement.workspaceDigest !== candidate.measurement.workspaceDigest ||
				measurement.repeatIndex !== candidate.measurement.repeatIndex ||
				measurement.sampleCount !== candidate.measurement.sampleCount ||
				measurement.evaluationEpoch !== candidate.measurement.evaluationEpoch ||
				!sameSplitClosureRoots(measurement.splitClosureRoots, candidate.measurement.splitClosureRoots) ||
				!sameStrings(
					measurement.vector.map((coordinate) => coordinate.metricId),
					candidate.measurement.vector.map((coordinate) => coordinate.metricId),
				)
			) {
				throw new Error("portfolio_completion_measurement_evidence_binding_inconsistent");
			}
		}
	}
}

function validateMeasurementCandidateBinding(
	measurements: readonly ValidPortfolioMeasurement[],
	candidateId: string,
): void {
	if (measurements.some(({ measurement }) => measurement.candidateId !== candidateId)) {
		throw new Error("portfolio_completion_measurement_candidate_binding_invalid");
	}
}

function terminalMeasurementKindIndex(kind: AutoResearchPortfolioMeasurement["kind"]): number {
	const index = (PORTFOLIO_TERMINAL_MEASUREMENT_KINDS as readonly string[]).indexOf(kind);
	if (index < 0) throw new Error("portfolio_completion_measurement_kind_invalid");
	return index;
}

async function authorizeTerminalReceipts(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
): Promise<readonly AuthorizedCompletionReceipt[]> {
	const receipts: {
		readonly receipt: WorkflowVerifiedHostReceipt;
		readonly bindingDigest: string;
		readonly role: PortfolioTerminalCapabilityRole;
	}[] = [
		{
			receipt: input.frontier.receipt,
			bindingDigest: portfolioFrontierBindingDigest(
				input.contract,
				input.frontier.entries,
				input.frontier.selectedEntryIds,
			),
			role: "frontier",
		},
		{
			receipt: input.completion.receipt,
			bindingDigest: portfolioCompletionBindingDigest(input.contract, input.completion),
			role: "completion",
		},
	];
	receipts.push(
		...input.boundaries.map((entry) => ({
			receipt: entry.receipt,
			bindingDigest: portfolioBoundaryBindingDigest(input.contract, entry.boundaryId, entry.passed),
			role: "boundary" as const,
		})),
	);
	receipts.push(
		...input.acquisition.splits.map((entry) => ({
			receipt: entry.receipt,
			bindingDigest: portfolioAcquisitionBindingDigest(input.contract, entry.split, entry.artifacts),
			role: "acquisition" as const,
		})),
	);
	receipts.push(
		...authority.frontierAdmission.invariantEvidence.map((entry) => ({
			receipt: entry.receipt,
			bindingDigest: invariantBindingDigest(input.contract, entry.invariantId, entry.checkDigest, entry.passed),
			role: "boundary" as const,
		})),
	);
	if (input.tradeoff !== null) {
		receipts.push({
			receipt: input.tradeoff.receipt,
			bindingDigest: portfolioTradeoffBindingDigest(input.contract, input.tradeoff),
			role: "tradeoff",
		});
	}
	for (const entry of input.infeasibility) {
		receipts.push(
			{
				receipt: entry.evaluatorProofReceipt,
				bindingDigest: portfolioInfeasibilityProofBindingDigest(
					input.contract,
					entry.goalId,
					entry.evaluatorProofDigest,
				),
				role: "infeasibility_evaluator",
			},
			{
				receipt: entry.adjudicationReceipt,
				bindingDigest: portfolioInfeasibilityAdjudicationBindingDigest(
					input.contract,
					entry.goalId,
					entry.evaluatorProofDigest,
					entry.adjudicationDigest,
				),
				role: "infeasibility_adjudicator",
			},
		);
	}
	receipts.push(
		...input.goalDecisions.map((entry) => ({
			receipt: entry.receipt,
			bindingDigest: portfolioGoalDecisionBindingDigest(input.contract, entry.goalId, entry.disposition),
			role: "goal_decision" as const,
		})),
	);
	if (input.stop !== null) {
		receipts.push({
			receipt: input.stop.receipt,
			bindingDigest: portfolioStopBindingDigest(input.contract, input.stop.reason),
			role: "stop",
		});
	}
	const terminalMeasurements = input.measurements.map(({ measurement: entry }) => entry);
	const resourceDigest = portfolioDefaultCompletionResourceDigest(input.contract, input, terminalMeasurements);
	const verifiedReceipts: AuthorizedCompletionReceipt[] = [];
	for (const { receipt, bindingDigest, role } of receipts) {
		const verified = await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: input.workflowId,
			expectedBindingDigest: bindingDigest,
			receipt,
			currentStateDigest: input.currentStateDigest,
			currentRevision: input.currentRevision,
			trustedNow: input.trustedNow,
		});
		await authorizeReceiptPrincipal(
			input.receiptContext,
			authority.runtime,
			authority.sessionId,
			input.workflowId,
			verified,
			bindingDigest,
			input.currentStateDigest,
			input.currentRevision,
			resourceDigest,
			portfolioDefaultCompletionOperationDigest(input.contract, input, terminalMeasurements, role, bindingDigest),
		);
		verifiedReceipts.push({
			receipt: verified,
			bindingDigest,
			resourceDigest,
			operationDigest: portfolioDefaultCompletionOperationDigest(
				input.contract,
				input,
				terminalMeasurements,
				role,
				bindingDigest,
			),
		});
	}
	return verifiedReceipts;
}

function validateMeasurementConsumptionCoverage(
	authority: PortfolioCompletionHostAuthorityBinding,
	measurementIds: readonly string[],
): void {
	const provided = authority.measurementConsumptionReceipts.map((entry) => entry.measurementId);
	if (
		new Set(provided).size !== provided.length ||
		provided.length !== measurementIds.length ||
		!sameStrings(provided, measurementIds)
	) {
		throw new Error("portfolio_completion_measurement_consumption_coverage_incomplete");
	}
}

function assertTerminalCommitIntent(
	input: PortfolioTerminalInput,
	terminal: Awaited<ReturnType<typeof evaluatePortfolioTerminal>>,
	terminalReceipts: readonly AuthorizedCompletionReceipt[],
	additionalReceipts: readonly AuthorizedCompletionReceipt[] = [],
): PortfolioTerminalCommitIntent {
	const intent = terminal.commitIntent;
	if (intent === undefined || intent === null) {
		throw new Error("portfolio_completion_terminal_commit_intent_missing");
	}
	const oneUse = [...terminalReceipts, ...additionalReceipts]
		.filter(({ receipt }) => receipt.oneUse)
		.sort((left, right) => left.receipt.receiptId.localeCompare(right.receipt.receiptId));
	if (oneUse.length === 0) throw new Error("portfolio_completion_terminal_commit_intent_missing");
	const terminalOneUse = terminalReceipts
		.filter(({ receipt }) => receipt.oneUse)
		.sort((left, right) => left.receipt.receiptId.localeCompare(right.receipt.receiptId));
	if (
		intent.capability !== "portfolio_default_completion" ||
		intent.outcome !== terminal.outcome ||
		intent.workflowId !== input.workflowId ||
		intent.currentStateDigest !== input.currentStateDigest ||
		intent.currentRevision !== input.currentRevision ||
		intent.evaluationEpoch !== input.contract.inputManifest.evaluationEpoch ||
		intent.witnessRequired !== true ||
		intent.receiptIds.length !== terminalOneUse.length ||
		JSON.stringify(intent.receiptIds) !== JSON.stringify(terminalOneUse.map(({ receipt }) => receipt.receiptId)) ||
		intent.bindingDigests.length !== terminalOneUse.length ||
		intent.resourceDigests.length !== terminalOneUse.length ||
		intent.operationDigests.length !== terminalOneUse.length
	) {
		throw new Error("portfolio_completion_terminal_commit_intent_binding_invalid");
	}
	for (const [index, entry] of terminalOneUse.entries()) {
		if (
			intent.bindingDigests[index] !== entry.bindingDigest ||
			intent.resourceDigests[index] !== entry.resourceDigest ||
			intent.operationDigests[index] !== entry.operationDigest
		) {
			throw new Error("portfolio_completion_terminal_commit_intent_binding_invalid");
		}
	}
	return {
		...intent,
		receiptIds: oneUse.map(({ receipt }) => receipt.receiptId),
		bindingDigests: oneUse.map(({ bindingDigest }) => bindingDigest),
		resourceDigests: oneUse.map(({ resourceDigest }) => resourceDigest),
		operationDigests: oneUse.map(({ operationDigest }) => operationDigest),
		workflowId: input.workflowId,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		evaluationEpoch: input.contract.inputManifest.evaluationEpoch,
		witnessRequired: true,
	};
}

function completionTransactionDigest(
	terminalCommitIntent: PortfolioTerminalCommitIntent,
	receiptCommitments: readonly Omit<PortfolioCompletionReceiptCommitment, "witness">[],
	auditDigest: string,
	audit: PortfolioCompletionAuditRecord,
): string {
	return digestObject({
		kind: "portfolio.default_completion.atomic_transaction.v1",
		terminalCommitIntent,
		receiptCommitments,
		auditDigest,
		audit,
	});
}

function receiptCommitmentPreview(
	receipts: readonly AuthorizedCompletionReceipt[],
): readonly Omit<PortfolioCompletionReceiptCommitment, "witness">[] {
	return [...receipts]
		.sort((left, right) => left.receipt.receiptId.localeCompare(right.receipt.receiptId))
		.map(({ receipt, bindingDigest, resourceDigest, operationDigest }) => ({
			receiptId: receipt.receiptId,
			bindingDigest,
			resourceDigest,
			operationDigest,
			verificationDigest: receipt.verificationDigest,
		}));
}

async function commitAtomicCompletion(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
	terminalCommitIntent: PortfolioTerminalCommitIntent,
	receipts: readonly AuthorizedCompletionReceipt[],
	audit: PortfolioCompletionAuditRecord,
): Promise<PortfolioCompletionAtomicTransaction & { readonly status: "committed" | "already_committed" }> {
	const uniqueReceipts = new Set<string>();
	const sorted = [...receipts].sort((left, right) => left.receipt.receiptId.localeCompare(right.receipt.receiptId));
	if (sorted.some(({ receipt }) => !receipt.oneUse || uniqueReceipts.has(receipt.receiptId))) {
		throw new Error("portfolio_completion_atomic_receipt_set_invalid");
	}
	for (const { receipt } of sorted) uniqueReceipts.add(receipt.receiptId);
	const receiptCommitments = receiptCommitmentPreview(sorted);
	const auditDigest = digestObject(audit);
	const transactionDigest = completionTransactionDigest(terminalCommitIntent, receiptCommitments, auditDigest, audit);
	const leaseRef = await authority.runtime.resolveLeaseRef();
	const committed = await authority.commitCompletion({
		workflowId: input.workflowId,
		currentStateDigest: input.currentStateDigest,
		currentRevision: input.currentRevision,
		evaluationEpoch: input.contract.inputManifest.evaluationEpoch,
		epochRef: { storeEpoch: leaseRef.storeEpoch, coordinatorEpoch: leaseRef.coordinatorEpoch },
		terminalCommitIntent,
		receipts: sorted.map(({ receipt }) => structuredClone(receipt)),
		receiptCommitments: structuredClone(receiptCommitments),
		auditDigest,
		audit: structuredClone(audit),
		transactionDigest,
	});
	exactKeys(committed, ["status", "transactionDigest", "journalRecordDigest", "witnesses"], "atomic_commit_result");
	if (
		(committed.status !== "committed" && committed.status !== "already_committed") ||
		committed.transactionDigest !== transactionDigest ||
		!/^[0-9a-f]{64}$/u.test(committed.journalRecordDigest) ||
		!Array.isArray(committed.witnesses) ||
		committed.witnesses.length !== sorted.length
	) {
		throw new Error("portfolio_completion_atomic_commit_result_invalid");
	}
	const witnesses = [...committed.witnesses].sort((left, right) => left.receiptId.localeCompare(right.receiptId));
	for (const witness of witnesses) {
		exactKeys(
			witness,
			[
				"receiptId",
				"workflowId",
				"bindingDigest",
				"capability",
				"resourceDigest",
				"operationDigest",
				"receiptDigest",
				"consumedAt",
				"consumptionSequence",
			],
			"atomic_commit_witness",
		);
	}
	if (new Set(witnesses.map((witness) => witness.receiptId)).size !== witnesses.length) {
		throw new Error("portfolio_completion_atomic_commit_witnesses_invalid");
	}
	const witnessByReceiptId = new Map(witnesses.map((witness) => [witness.receiptId, witness]));
	const receiptCommitmentsWithWitness = sorted.map((entry) => {
		const witness = witnessByReceiptId.get(entry.receipt.receiptId);
		if (
			witness === undefined ||
			witness.receiptId !== entry.receipt.receiptId ||
			witness.workflowId !== input.workflowId ||
			witness.bindingDigest !== entry.bindingDigest ||
			witness.receiptDigest !== digestObject(entry.receipt) ||
			witness.capability !== (entry.receipt.capabilityBinding?.capability ?? null) ||
			witness.resourceDigest !== (entry.receipt.capabilityBinding?.resourceDigest ?? null) ||
			witness.operationDigest !== (entry.receipt.capabilityBinding?.operationDigest ?? null) ||
			!Number.isSafeInteger(witness.consumptionSequence) ||
			witness.consumptionSequence < 1 ||
			!Number.isFinite(Date.parse(witness.consumedAt))
		) {
			throw new Error("portfolio_completion_atomic_commit_witness_invalid");
		}
		return {
			receiptId: entry.receipt.receiptId,
			bindingDigest: entry.bindingDigest,
			resourceDigest: entry.resourceDigest,
			operationDigest: entry.operationDigest,
			verificationDigest: entry.receipt.verificationDigest,
			witness,
		};
	});
	return {
		status: committed.status,
		terminalCommitIntent,
		receiptCommitments: receiptCommitmentsWithWitness,
		auditDigest,
		audit,
		journalRecordDigest: committed.journalRecordDigest,
		transactionDigest,
	};
}

function completionAuthorityEvidenceRefs(
	input: PortfolioTerminalInput,
	authority: PortfolioCompletionHostAuthorityBinding,
): readonly WorkflowArtifactRef[] {
	const refs: WorkflowArtifactRef[] = [input.frontier.receipt.artifactRef, input.completion.receipt.artifactRef];
	refs.push(...input.measurements.map(({ receipt }) => receipt.artifactRef));
	refs.push(...input.boundaries.map((entry) => entry.receipt.artifactRef));
	refs.push(...input.acquisition.splits.map((entry) => entry.receipt.artifactRef));
	refs.push(...authority.measurementConsumptionReceipts.map((entry) => entry.receipt.artifactRef));
	if (input.tradeoff !== null) refs.push(input.tradeoff.receipt.artifactRef);
	for (const entry of input.infeasibility) {
		refs.push(entry.evaluatorProofReceipt.artifactRef, entry.adjudicationReceipt.artifactRef);
	}
	refs.push(...input.goalDecisions.map((entry) => entry.receipt.artifactRef));
	if (input.stop !== null) refs.push(input.stop.receipt.artifactRef);
	if (new Set(refs.map((ref) => ref.artifactId)).size !== refs.length) {
		throw new Error("portfolio_completion_authority_evidence_duplicate");
	}
	return refs;
}

function metricEvaluation(
	measurement: AutoResearchPortfolioMeasurement,
	metric: {
		readonly metricId: string;
		readonly direction: "lower" | "higher";
		readonly target: number;
		readonly runs: number;
		readonly maxVariance: number;
	},
): WorkflowMetricEvaluation {
	const coordinate = measurement.vector.find((entry) => entry.metricId === metric.metricId);
	if (coordinate === undefined) throw new Error("portfolio_completion_vector_coordinate_missing");
	const targetSatisfied =
		metric.direction === "higher" ? coordinate.value >= metric.target : coordinate.value <= metric.target;
	const repeatabilitySatisfied = measurement.runCount >= metric.runs && measurement.variance <= metric.maxVariance;
	if (!targetSatisfied || !repeatabilitySatisfied) {
		throw new Error("portfolio_completion_metric_not_accepted");
	}
	return {
		evaluationId: measurement.measurementId,
		metricId: metric.metricId,
		runCount: measurement.runCount,
		aggregate: measurement.aggregation === "exact" ? "single" : measurement.aggregation,
		aggregateValue: coordinate.value,
		variance: measurement.variance,
		heldOutInputDigest: null,
		repeatabilitySatisfied: true,
		targetSatisfied: true,
		accepted: true,
		rejectionReasons: [],
	};
}

function safeReceiptProjection(receipt: WorkflowVerifiedHostReceipt): PortfolioCompletionReceiptProjection {
	return {
		receiptKind: receipt.receiptKind,
		oneUse: receipt.oneUse,
		receiptId: receipt.receiptId,
		issuerId: receipt.issuerId,
		bindingDigest: receipt.bindingDigest,
		payloadDigest: receipt.payloadDigest,
		verificationDigest: receipt.verificationDigest,
	};
}

function terminalReceiptContext(context: WorkflowHostReceiptConsumerContext): WorkflowHostReceiptConsumerContext {
	const { revokeReceipt: _revokeReceipt, ...closedContext } = context;
	return closedContext;
}

/**
 * Project one complete host-authorized portfolio into default completion evidence.
 *
 * Args:
 * request: Parsed portfolio terminal evidence and an opaque host authority bound to the current workflow head.
 * Return: One signed, provenance-rich default evaluation for every portfolio metric.
 */
export async function bridgePortfolioToDefaultCompletion(
	request: PortfolioCompletionRequest,
): Promise<PortfolioCompletionBridgeResult> {
	exactKeys(request, PORTFOLIO_COMPLETION_REQUEST_KEYS, "request");
	const input = request.terminal;
	exactKeys(input, PORTFOLIO_TERMINAL_INPUT_KEYS, "input");
	const authority = authorityBinding(request.authority, input);
	assertWorkflowRuntimeVersion(authority.runtimeVersion);
	const currentHead = await authority.readCurrentHead();
	validateCurrentHead(input, currentHead);
	parsedAndClosedContract(input);
	if (!Array.isArray(input.measurements)) throw new Error("portfolio_completion_measurement_set_invalid");
	if (Object.keys(input.measurements).length !== input.measurements.length) {
		throw new Error("portfolio_completion_measurement_set_invalid");
	}
	const measurements = Array.from(input.measurements, (measurementEvidence) =>
		validateVector(input, measurementEvidence),
	);
	const goals = input.contract.goals.filter((goal) => goal.scope === "terminal");
	const goalIds = goals.map((goal) => goal.goalId);
	const expectedMeasurementKeys = goals.flatMap((goal) =>
		PORTFOLIO_TERMINAL_MEASUREMENT_KINDS.map((kind) => `${goal.goalId}\u0000${kind}`),
	);
	const actualMeasurementKeys = measurements.map(
		({ measurement }) => `${measurement.goalId}\u0000${measurement.kind}`,
	);
	if (
		new Set(actualMeasurementKeys).size !== actualMeasurementKeys.length ||
		!sameStrings(actualMeasurementKeys, expectedMeasurementKeys) ||
		actualMeasurementKeys.length !== expectedMeasurementKeys.length
	) {
		throw new Error("portfolio_completion_measurement_set_kind_coverage_incomplete");
	}
	for (const goal of goals) {
		const candidateIds = new Set(
			measurements
				.filter(({ measurement }) => measurement.goalId === goal.goalId)
				.map(({ measurement }) => measurement.candidateId),
		);
		if (candidateIds.size !== 1) {
			throw new Error("portfolio_completion_measurement_candidate_coverage_incomplete");
		}
	}
	const expectedRequirementIds = input.contract.acceptanceRequirements.map((requirement) => requirement.requirementId);
	const measuredRequirementIds = goals.flatMap((goal) => goal.metrics.map((metric) => metric.requirementId));
	if (!sameStrings(expectedRequirementIds, [...new Set(measuredRequirementIds)])) {
		throw new Error("portfolio_completion_requirement_coverage_incomplete");
	}
	validateCandidateAndFrontierBindings(input, authority);
	const frontierAdmission = validateFrontierAdmission(input, authority);
	validateMeasurementCandidateBinding(measurements, authority.candidate.candidateId);
	validateSupportingMeasurements(measurements, goalIds);
	const holdoutAggregates = validateHoldoutAggregates(authority, measurements);
	const resolvedDataClosures = await resolveDataClosures(input, authority);
	await resolveAutoResearchArtifactRefs(authority.runtime, completionAuthorityEvidenceRefs(input, authority));
	const measurementIds = measurements.map(({ measurement }) => measurement.measurementId);
	if (new Set(measurementIds).size !== measurementIds.length) {
		throw new Error("portfolio_completion_measurement_identifiers_duplicated");
	}
	const candidateMeasurements = measurements.filter(({ measurement }) => measurement.kind === "candidate");
	if (candidateMeasurements.length !== goals.length) {
		throw new Error("portfolio_completion_candidate_measurement_coverage_incomplete");
	}
	for (const { goal, measurement } of candidateMeasurements) validateBaselineNonRegression(goal, measurement);
	validateMeasurementConsumptionCoverage(authority, measurementIds);
	const portfolioDigest = digestObject(input.contract);
	const vectorDigest = completionVectorDigest(input.contract, measurements);
	const terminalInput = {
		...input,
		contract: structuredClone(input.contract),
		measurements: structuredClone(input.measurements),
		receiptContext: terminalReceiptContext(input.receiptContext),
	} as PortfolioTerminalInput;
	const terminal = await evaluatePortfolioTerminal(terminalInput);
	if (!terminal.accepted || terminal.outcome !== "complete") {
		throw new Error(`portfolio_completion_terminal_not_complete:${terminal.outcome}:${terminal.reasons.join(",")}`);
	}
	const terminalReceipts = await authorizeTerminalReceipts(input, authority);
	const metricEvaluations = candidateMeasurements.flatMap(({ goal, measurement }) =>
		goal.metrics.map((metric) => ({
			goalId: goal.goalId,
			metricId: metric.metricId,
			evaluation: metricEvaluation(measurement, {
				metricId: metric.metricId,
				direction: metric.direction,
				target: metric.target,
				runs: goal.repeatability.runs,
				maxVariance: Math.min(goal.repeatability.maxVariance, goal.uncertainty.maxVariance),
			}),
		})),
	);
	const receipts = new Map<string, WorkflowVerifiedHostReceipt>();
	const consumptionReceipts: AuthorizedCompletionReceipt[] = [];
	for (const { measurement, evidence } of measurements) {
		const aggregate =
			measurement.kind === "holdout"
				? [...holdoutAggregates.values()].find(
						(entry) =>
							entry.goalId === measurement.goalId &&
							entry.candidateId === measurement.candidateId &&
							measurement.evidenceDigests.includes(entry.evidenceDigest),
					)
				: undefined;
		const verified = await verifyMeasurementReceipt(input, authority, evidence, aggregate);
		receipts.set(measurement.measurementId, verified);
	}
	for (const { measurement, evidence } of measurements) {
		consumptionReceipts.push(
			await authorizeMeasurementConsumptionReceipt(input, authority, measurement, evidence.receipt),
		);
	}
	const terminalCommitIntent = assertTerminalCommitIntent(input, terminal, terminalReceipts, [...consumptionReceipts]);
	const goalMetricEvaluations = candidateMeasurements
		.flatMap(({ goal, measurement }) =>
			goal.metrics.map((metric) => {
				const evaluation = metricEvaluations.find(
					(entry) => entry.goalId === goal.goalId && entry.metricId === metric.metricId,
				)?.evaluation;
				if (evaluation === undefined) throw new Error("portfolio_completion_metric_projection_incomplete");
				const receipt = receipts.get(measurement.measurementId);
				if (receipt === undefined) throw new Error("portfolio_completion_receipt_projection_incomplete");
				const supportingMeasurements = measurements
					.filter(({ measurement: supportingMeasurement }) => supportingMeasurement.goalId === goal.goalId)
					.sort(
						(left, right) =>
							terminalMeasurementKindIndex(left.measurement.kind) -
							terminalMeasurementKindIndex(right.measurement.kind),
					);
				const supportingReceipts = supportingMeasurements.map(({ measurement: supportingMeasurement }) => {
					const supportingReceipt = receipts.get(supportingMeasurement.measurementId);
					if (supportingReceipt === undefined)
						throw new Error("portfolio_completion_supporting_receipt_projection_incomplete");
					return safeReceiptProjection(supportingReceipt);
				});
				const evidenceRefs = [structuredClone(receipt.artifactRef)];
				const holdoutAggregate = [...holdoutAggregates.values()].find(
					(entry) => entry.goalId === goal.goalId && entry.candidateId === measurement.candidateId,
				);
				if (holdoutAggregate === undefined)
					throw new Error("portfolio_completion_holdout_aggregate_projection_incomplete");
				const entryWithoutDigest = {
					metricId: metric.metricId,
					requirementId: metric.requirementId,
					evaluation,
					evidenceRefs,
					portfolioDigest,
					vectorDigest,
					inputManifestDigest: measurement.inputManifestDigest,
					splitClosureRoots: structuredClone(measurement.splitClosureRoots),
					evaluatorDigest: measurement.evaluatorDigest,
					parserDigest: measurement.parserDigest,
					commandDigest: measurement.commandDigest,
					measurementId: measurement.measurementId,
					measurementDigest: measurement.measurementDigest,
					inputDigest: measurement.inputDigest,
					workspaceDigest: measurement.workspaceDigest,
					evidenceDigests: structuredClone(measurement.evidenceDigests),
					repeatIndex: measurement.repeatIndex,
					sampleCount: measurement.sampleCount,
					confidenceInterval: structuredClone(measurement.confidenceInterval),
					aggregation: measurement.aggregation,
					measuredAt: measurement.measuredAt,
					closureRootDigest: input.contract.inputManifest.closureRootDigest,
					manifestRevision: input.contract.inputManifest.manifestRevision,
					evaluationEpoch: measurement.evaluationEpoch,
					candidateId: measurement.candidateId!,
					domainId: goal.domainId,
					vector: structuredClone(measurement.vector),
					artifactRefs: evidenceRefs,
					receipt: structuredClone(receipt),
					supportingReceipts,
					holdoutAggregateId: holdoutAggregate.aggregateId,
					holdoutAggregateDigest: holdoutAggregate.aggregateDigest,
					workflowId: input.workflowId,
					currentStateDigest: input.currentStateDigest,
					currentRevision: input.currentRevision,
				};
				const entry: PortfolioCompletionGoalMetricEvaluationEvidence = {
					...entryWithoutDigest,
					evaluationDigest: digestObject({ ...entryWithoutDigest, evaluationDigest: "" }),
				};
				return Object.freeze(entry);
			}),
		)
		.sort((left, right) => left.metricId.localeCompare(right.metricId));
	const expectedMetricCount = goals.reduce((count, goal) => count + goal.metrics.length, 0);
	if (goalMetricEvaluations.length !== expectedMetricCount) {
		throw new Error("portfolio_completion_metric_projection_incomplete");
	}
	const atomicReceipts = [...terminalReceipts.filter(({ receipt }) => receipt.oneUse), ...consumptionReceipts];
	const audit: PortfolioCompletionAuditRecord = {
		kind: "portfolio.default_completion.replayable_audit.v1",
		portfolioDigest,
		vectorDigest,
		baseline: goals.flatMap((goal) =>
			goal.metrics.map((metric) => ({
				goalId: goal.goalId,
				metricId: metric.metricId,
				value: goal.baseline.metricValues.find((entry) => entry.metricId === metric.metricId)!.value,
				evidenceDigest: goal.baseline.evidenceDigest,
				measurementId: goal.baseline.measurementId,
				inputManifestDigest: goal.baseline.inputManifestDigest,
				splitClosureRoots: structuredClone(goal.baseline.splitClosureRoots),
				evaluationEpoch: goal.baseline.evaluationEpoch,
			})),
		),
		candidateBinding: candidateBindingRecord(authority.candidate),
		impactClosure: structuredClone(frontierAdmission.impactClosure),
		frontierAdmissionDigest: frontierAdmission.admissionDigest,
		terminal: {
			evaluationDigest: terminal.evaluationDigest,
			outcome: "complete",
			selectedFrontierEntryIds: [...terminal.selectedFrontierEntryIds],
			goalDispositions: structuredClone(terminal.goalDispositions),
		},
		measurements: measurements.map(({ measurement }) => {
			const verified = receipts.get(measurement.measurementId);
			if (verified === undefined) throw new Error("portfolio_completion_audit_measurement_receipt_missing");
			const aggregate =
				measurement.kind === "holdout"
					? [...holdoutAggregates.values()].find((entry) => entry.goalId === measurement.goalId)
					: undefined;
			return {
				measurementId: measurement.measurementId,
				goalId: measurement.goalId,
				candidateId: measurement.candidateId,
				kind: measurement.kind,
				vector: structuredClone(measurement.vector),
				measurementDigest: measurement.measurementDigest,
				receiptId: verified.receiptId,
				receiptBindingDigest: verified.bindingDigest,
				receiptPayloadDigest: verified.payloadDigest,
				verificationDigest: verified.verificationDigest,
				aggregateId: aggregate?.aggregateId ?? null,
				aggregateDigest: aggregate?.aggregateDigest ?? null,
			};
		}),
		receiptCommitments: receiptCommitmentPreview(atomicReceipts),
		splitProvenance: {
			manifestDigest: input.contract.inputManifest.manifestDigest,
			closureRootDigest: input.contract.inputManifest.closureRootDigest,
			splitClosureRoots: structuredClone(input.contract.inputManifest.splitClosureRoots),
			resolved: resolvedDataClosures.map((closure) => ({
				split: closure.split,
				artifactDigests: [...closure.artifactDigests],
			})),
		},
		holdoutAggregateKinds: [
			"host_only_holdout_aggregate",
			...measurements
				.filter(({ measurement }) => measurement.kind === "adversarial")
				.map(() => "host_only_adversarial_aggregate"),
		],
	};
	const completionTransaction = await commitAtomicCompletion(
		input,
		authority,
		terminalCommitIntent,
		atomicReceipts,
		audit,
	);
	return deepFreeze({
		terminalOutcome: "complete" as const,
		portfolioDigest,
		vectorDigest,
		commitStatus: completionTransaction.status,
		completionTransaction,
		goalMetricEvaluations,
	});
}
