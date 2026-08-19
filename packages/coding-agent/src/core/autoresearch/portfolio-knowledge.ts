import type { KnowledgeCommitRequest, KnowledgeStore } from "../knowledge/knowledge-store.js";
import type { KnowledgeMempalaceBoundary } from "../knowledge/mempalace-boundary.js";
import type {
	KnowledgeApplicability,
	KnowledgeConfidence,
	KnowledgeKind,
	KnowledgeProposal,
	KnowledgeRecord,
	KnowledgeRetention,
} from "../knowledge/records.js";
import {
	digestObject,
	resolveAndVerifyWorkflowHostReceipt,
	type WorkflowEpochRef,
	type WorkflowEvidenceEnvelopeRef,
	type WorkflowHostPrincipalCapabilityAuthorization,
	type WorkflowHostPrincipalCapabilityAuthorizationInput,
	type WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import type {
	WorkflowLearningCandidate,
	WorkflowLearningExperience,
	WorkflowLearningExperienceInput,
	WorkflowLearningHostWitness,
	WorkflowLearningReviewResult,
	WorkflowLearningTrigger,
} from "../workflow/learning-controller.js";
import type { WorkflowLearningRuntimeAdapter } from "../workflow/learning-runtime-adapter.js";
import {
	type AutoResearchPortfolioContract,
	autoResearchPortfolioCandidateDigest,
	autoResearchPortfolioContractDigest,
	autoResearchPortfolioMeasurementDigest,
} from "./portfolio-contracts.js";
import {
	admitPortfolioLearningScope,
	type PortfolioLearningHostEvidence,
	type PortfolioLearningScope,
	type PortfolioLearningScopeAdmissionInput,
	type PortfolioLearningScopeDecision,
} from "./portfolio-learning-scope.js";
import {
	evaluatePortfolioTerminal,
	type PortfolioHostMeasurementEvidence,
	type PortfolioTerminalEvaluation,
	type PortfolioTerminalInput,
} from "./portfolio-terminal.js";

/** Host-authored declarative knowledge admitted from a completed portfolio. */
export interface PortfolioKnowledgeLesson {
	readonly kind: "how" | "why";
	readonly title: string;
	readonly statement: string;
}

/** Stable host identity from which the approved portfolio scope is narrowed. */
export interface PortfolioKnowledgeApplicabilityContext {
	readonly namespace: string;
	readonly workspaceId?: string;
	readonly userId?: string;
	readonly pathPrefix?: string;
}

/** Existing learning controller/runtime route used for workflow policy refinement. */
export interface PortfolioKnowledgeRefinementInput {
	readonly experience: WorkflowLearningExperienceInput;
	readonly trigger: WorkflowLearningTrigger;
}

/** Host-issued one-use capability used to authorize this exact promotion. */
export interface PortfolioKnowledgePromotionAuthority {
	readonly receipt: WorkflowVerifiedHostReceipt;
	readonly executionIdentity: string;
	readonly sessionId: string;
}

/**
 * Inputs for the host-owned portfolio knowledge bridge.
 *
 * The store, MemPalace boundary, and learning runtime are the concrete public
 * authorities. The bridge does not accept a structural replacement for any of
 * them and does not retain any authority between calls.
 */
export interface PortfolioKnowledgeCompositionInput {
	readonly terminal: PortfolioTerminalInput;
	readonly learning: PortfolioLearningScopeAdmissionInput;
	readonly lesson: PortfolioKnowledgeLesson;
	readonly applicability: PortfolioKnowledgeApplicabilityContext;
	readonly knowledgeStore: KnowledgeStore;
	readonly knowledgeCommitRequest: KnowledgeCommitRequest;
	readonly authority: PortfolioKnowledgePromotionAuthority;
	readonly mempalace?: KnowledgeMempalaceBoundary;
	readonly learningRuntime: WorkflowLearningRuntimeAdapter;
	readonly refinement: PortfolioKnowledgeRefinementInput;
}

export interface PortfolioKnowledgeLearningResult {
	readonly status: "not_attempted" | "rejected" | "promoted";
	readonly experience?: WorkflowLearningExperience;
	readonly candidate?: WorkflowLearningCandidate;
	readonly review?: WorkflowLearningReviewResult;
}

export interface PortfolioKnowledgeResult {
	readonly accepted: boolean;
	readonly mutated: boolean;
	readonly terminal: PortfolioTerminalEvaluation | null;
	readonly scope: PortfolioLearningScopeDecision;
	readonly applicability: KnowledgeApplicability | null;
	readonly knowledgeRecord: KnowledgeRecord | null;
	readonly learning: PortfolioKnowledgeLearningResult;
	readonly projectedToMemPalace: boolean;
	readonly rejectionReasons: readonly string[];
}

export interface PortfolioKnowledgeBridge {
	compose(input: PortfolioKnowledgeCompositionInput): Promise<PortfolioKnowledgeResult>;
}

const HOST_PRODUCER_ID = "autoresearch-portfolio";
const KNOWLEDGE_CONFIDENCE: KnowledgeConfidence = "audited";
const DEFAULT_RETENTION: KnowledgeRetention = { class: "until-superseded" };
const KNOWLEDGE_KINDS: ReadonlySet<KnowledgeKind> = new Set(["how", "why"]);
const EMPTY_REJECTION_REASONS: readonly string[] = Object.freeze([]);
const COMPOSITION_KEYS = [
	"applicability",
	"authority",
	"knowledgeCommitRequest",
	"knowledgeStore",
	"learning",
	"learningRuntime",
	"lesson",
	"mempalace",
	"refinement",
	"terminal",
] as const;

const LESSON_KEYS = ["kind", "statement", "title"] as const;
const APPLICABILITY_KEYS = ["namespace", "pathPrefix", "userId", "workspaceId"] as const;
const REFINEMENT_KEYS = ["experience", "trigger"] as const;
const EXPERIENCE_KEYS = [
	"committedAt",
	"evidence",
	"experienceId",
	"hostReceipt",
	"outcome",
	"progressEvidenceRefs",
	"progressKind",
	"source",
	"sourceEventRef",
	"workflowId",
] as const;
const TRIGGER_KEYS = [
	"candidateId",
	"coordinatorEpoch",
	"evidenceDigest",
	"evidenceRefs",
	"evidenceWitnesses",
	"hostReceipt",
	"kind",
	"sourceEventRef",
	"stateHeadDigest",
	"storeEpoch",
	"workflowId",
] as const;
const HOST_EVIDENCE_KEYS = [
	"acquisition",
	"artifactRef",
	"bindingDigest",
	"closureRootDigest",
	"coverage",
	"evaluationEpoch",
	"executionIdentity",
	"receipt",
	"sessionId",
	"witness",
	"workerAttestationDigest",
	"workerId",
	"workerRole",
	"workspaceDigest",
] as const;
const RECEIPT_KEYS = [
	"artifactBytesDigest",
	"artifactRef",
	"bindingDigest",
	"issuerId",
	"issuedAt",
	"keyId",
	"oneUse",
	"payloadDigest",
	"receiptId",
	"receiptKind",
	"revision",
	"signature",
	"signatureAlgorithm",
	"stateDigest",
	"verificationDigest",
	"validUntil",
	"workflowId",
] as const;
const WITNESS_KEYS = [
	"bytesDigest",
	"bytesSize",
	"candidateId",
	"coordinatorEpoch",
	"evidenceRef",
	"oneUse",
	"payloadDigest",
	"revision",
	"stage",
	"stateHeadDigest",
	"storeEpoch",
	"trustedNow",
	"witnessId",
	"witnessKind",
	"workflowId",
] as const;

const PROMOTION_AUTHORITY_KEYS = ["executionIdentity", "receipt", "sessionId"] as const;
const CAPABILITY_BINDING_KEYS = [
	"capability",
	"executionIdentity",
	"operationDigest",
	"resourceDigest",
	"sessionId",
] as const;
const PROMOTION_RECEIPT_KEYS = Object.freeze([...RECEIPT_KEYS, "capabilityBinding"] as const);
const RECEIPT_KEYS_WITH_CAPABILITY = Object.freeze([...RECEIPT_KEYS, "capabilityBinding"] as const);

const RAW_HOLDOUT_KEYS = new Set([
	"heldoutinput",
	"heldoutbytes",
	"heldoutinputbytes",
	"heldoutvalue",
	"hiddeninput",
	"hiddeninputbytes",
	"hiddeninputvalue",
	"holdoutinput",
	"holdoutbytes",
	"holdoutinputbytes",
	"holdoutvalue",
	"hiddenholdoutinput",
	"hiddenholdoutbytes",
	"hiddenholdoutvalue",
	"rawholdout",
	"rawholdoutinput",
	"rawholdoutbytes",
	"holdoutraw",
	"holdoutsecret",
	"hiddensecret",
	"holdoutrows",
	"holdoutpercasefeedback",
]);

function nonEmpty(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} is required.`);
}

function boundedText(value: unknown, label: string, maximumBytes: number): asserts value is string {
	nonEmpty(value, label);
	if (new TextEncoder().encode(value).byteLength > maximumBytes) throw new Error(`${label} is too large.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function assertClosedKeys(value: unknown, keys: readonly string[], label: string): void {
	if (!isPlainObject(value)) throw new Error(`${label} must be a plain object.`);
	const allowed = new Set(keys);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key) || !allowed.has(key))
			throw new Error(`${label} has an unknown or non-enumerable field: ${String(key)}.`);
	}
}

function assertNoRawHoldout(value: unknown, label: string, seen = new WeakSet<object>(), depth = 0): void {
	if (depth > 32) throw new Error(`${label} exceeds the bounded refinement depth.`);
	if (value === null || typeof value !== "object") {
		if (typeof value === "function") throw new Error(`${label} contains an unsupported raw value.`);
		return;
	}
	if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value))
		throw new Error(`${label} contains raw holdout bytes.`);
	if (seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		if (Array.isArray(value) && key === "length") continue;
		if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))
			throw new Error(`${label} contains a non-enumerable or symbol field.`);
		const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
		if (
			RAW_HOLDOUT_KEYS.has(normalized) ||
			(normalized.includes("holdout") &&
				(normalized.includes("input") ||
					normalized.includes("bytes") ||
					normalized.includes("value") ||
					normalized.includes("row") ||
					normalized.includes("raw") ||
					normalized.includes("secret") ||
					normalized.includes("feedback")))
		)
			throw new Error(`${label} contains raw holdout material.`);
		assertNoRawHoldout((value as Record<string, unknown>)[key], label, seen, depth + 1);
	}
}

function assertLesson(lesson: PortfolioKnowledgeLesson): void {
	assertClosedKeys(lesson, LESSON_KEYS, "portfolio knowledge lesson");
	if (!KNOWLEDGE_KINDS.has(lesson.kind))
		throw new Error("portfolio knowledge route accepts only durable how or why lessons.");
	boundedText(lesson.title, "portfolio knowledge lesson title", 256);
	boundedText(lesson.statement, "portfolio knowledge lesson statement", 4_096);
	assertNoRawHoldout(lesson, "portfolio knowledge lesson");
}

function assertApplicabilityContext(context: PortfolioKnowledgeApplicabilityContext): void {
	assertClosedKeys(context, APPLICABILITY_KEYS, "portfolio knowledge applicability");
	nonEmpty(context.namespace, "portfolio knowledge namespace");
	for (const [label, value] of [
		["workspace identity", context.workspaceId],
		["user identity", context.userId],
		["path prefix", context.pathPrefix],
	] as const) {
		if (value !== undefined) boundedText(value, `portfolio knowledge ${label}`, 256);
	}
	if (
		context.pathPrefix !== undefined &&
		(context.pathPrefix.startsWith("/") ||
			context.pathPrefix.includes("\\") ||
			context.pathPrefix.split("/").some((part) => part.length === 0 || part === "." || part === ".."))
	)
		throw new Error("portfolio knowledge path prefix is not normalized.");
}

function assertRefinementSchema(refinement: PortfolioKnowledgeRefinementInput): void {
	assertClosedKeys(refinement, REFINEMENT_KEYS, "portfolio knowledge refinement");
	assertClosedKeys(refinement.experience, EXPERIENCE_KEYS, "portfolio knowledge refinement experience");
	assertClosedKeys(refinement.trigger, TRIGGER_KEYS, "portfolio knowledge refinement trigger");
	assertNoRawHoldout(refinement.experience, "portfolio knowledge refinement experience");
	assertNoRawHoldout(refinement.trigger, "portfolio knowledge refinement trigger");
}

function assertKnowledgeAuthority(input: PortfolioKnowledgeCompositionInput): void {
	const store = input.knowledgeStore;
	if (
		store === null ||
		typeof store !== "object" ||
		["commit", "read", "readAuthenticated", "readAuthenticatedCommit", "replay", "recover", "history", "recall"].some(
			(method) => typeof store[method as keyof KnowledgeStore] !== "function",
		)
	)
		throw new Error("portfolio knowledge requires the complete canonical KnowledgeStore.");
	const request = input.knowledgeCommitRequest;
	if (request === null || typeof request !== "object" || !isPlainObject(request.proposal))
		throw new Error("portfolio knowledge requires a canonical KnowledgeCommitRequest.");
	if (request.expectedHead.workflowId !== input.terminal.workflowId)
		throw new Error("portfolio knowledge canonical request crossed the workflow boundary.");
	if (
		request.epochRef.storeEpoch !== input.learning.currentStoreEpoch ||
		request.epochRef.coordinatorEpoch !== input.learning.currentCoordinatorEpoch ||
		request.knowledgeStoreEpoch !== input.learning.currentStoreEpoch ||
		request.expectedHead.epochRef.storeEpoch !== input.learning.currentStoreEpoch ||
		request.expectedHead.epochRef.coordinatorEpoch !== input.learning.currentCoordinatorEpoch
	)
		throw new Error("portfolio knowledge canonical request is stale for the admitted epoch.");
	if (request.proposal.applicability.namespace !== input.applicability.namespace)
		throw new Error("portfolio knowledge canonical request crossed the namespace boundary.");
}

function assertLearningRuntime(input: PortfolioKnowledgeCompositionInput): void {
	const runtime = input.learningRuntime;
	if (
		runtime === null ||
		typeof runtime !== "object" ||
		["commitExperience", "typeCandidate", "reviewCandidate", "handleTrigger", "replay", "getState"].some(
			(method) => typeof runtime[method as keyof WorkflowLearningRuntimeAdapter] !== "function",
		)
	)
		throw new Error("portfolio knowledge requires the complete workflow learning runtime adapter.");
}

function assertMemPalaceBoundary(mempalace: KnowledgeMempalaceBoundary | undefined): void {
	if (
		mempalace !== undefined &&
		(mempalace === null ||
			["accept", "project", "recall", "health", "drain"].some(
				(method) => typeof mempalace[method as keyof KnowledgeMempalaceBoundary] !== "function",
			))
	)
		throw new Error("portfolio knowledge requires the complete KnowledgeMempalaceBoundary.");
}

function assertPromotionAuthorityShape(input: PortfolioKnowledgeCompositionInput): void {
	const authority = input.authority;
	assertClosedKeys(authority, PROMOTION_AUTHORITY_KEYS, "portfolio knowledge promotion authority");
	assertNoRawHoldout(authority, "portfolio knowledge promotion authority");
	boundedText(authority.executionIdentity, "portfolio knowledge authority execution identity", 256);
	boundedText(authority.sessionId, "portfolio knowledge authority session identity", 256);
	assertClosedKeys(authority.receipt, PROMOTION_RECEIPT_KEYS, "portfolio knowledge promotion receipt");
	if (
		authority.receipt.receiptKind !== "capability" ||
		authority.receipt.oneUse !== true ||
		authority.receipt.workflowId !== input.learning.workflowId ||
		authority.receipt.stateDigest !== input.learning.currentStateDigest ||
		authority.receipt.revision !== input.learning.currentRevision
	)
		throw new Error("portfolio knowledge promotion authority receipt is stale or not one-use.");
	const capabilityBinding = authority.receipt.capabilityBinding;
	if (capabilityBinding === undefined) throw new Error("portfolio knowledge promotion capability binding is missing.");
	assertClosedKeys(capabilityBinding, CAPABILITY_BINDING_KEYS, "portfolio knowledge promotion capability binding");
	if (
		capabilityBinding.capability !== "workflow_learning_knowledge_promotion" ||
		capabilityBinding.executionIdentity !== authority.executionIdentity ||
		capabilityBinding.sessionId !== authority.sessionId
	)
		throw new Error("portfolio knowledge promotion capability binding is not host-owned.");
}

function assertPromotionAuthorizerSeam(input: PortfolioKnowledgeCompositionInput): void {
	if (
		input.learning.receiptContext === null ||
		typeof input.learning.receiptContext !== "object" ||
		input.learning.receiptContext.principalAuthorizer === undefined ||
		typeof input.learning.receiptContext.principalAuthorizer.authorize !== "function"
	)
		throw new Error("CONTRACT_CHANGE: portfolio knowledge requires the generic host principalAuthorizer seam.");
}

function sameDigest(left: unknown, right: unknown): boolean {
	return digestObject(left) === digestObject(right);
}

function assertScopeContracts(input: PortfolioKnowledgeCompositionInput): void {
	if (!sameDigest(input.learning.contract, input.terminal.contract))
		throw new Error("portfolio knowledge terminal and learning contracts differ.");
	if (
		input.terminal.workflowId !== input.learning.workflowId ||
		input.terminal.currentRevision !== input.learning.currentRevision ||
		input.terminal.currentStateDigest !== input.learning.currentStateDigest ||
		input.terminal.trustedNow !== input.learning.trustedNow
	)
		throw new Error("portfolio knowledge terminal and learning workflow fences differ.");
	if (input.terminal.receiptContext !== input.learning.receiptContext)
		throw new Error("portfolio knowledge terminal and learning receipt contexts differ.");
}

/**
 * Derive the three host capability digests for one portfolio knowledge promotion.
 *
 * Args:
 * input: Terminal, admitted-learning, and canonical commit inputs.
 * scope: Host decision that admitted the learning scope.
 * terminalMeasurement: Signed terminal vector evidence selected for promotion.
 * authority: Execution and session identities from the host capability.
 * Return: Resource, operation, and complete binding digests for the capability receipt.
 */
export function portfolioKnowledgePromotionAuthorityDigests(
	input: PortfolioKnowledgeCompositionInput,
	scope: PortfolioLearningScopeDecision,
	terminalMeasurement: PortfolioHostMeasurementEvidence,
	authority: Pick<PortfolioKnowledgePromotionAuthority, "executionIdentity" | "sessionId">,
): Readonly<{ resourceDigest: string; operationDigest: string; bindingDigest: string }> {
	const learning = input.learning;
	const contract = learning.contract;
	const candidateDigest = autoResearchPortfolioCandidateDigest(learning.candidate);
	const contractDigest = autoResearchPortfolioContractDigest(contract);
	const terminalEvidenceDigest = digestObject({
		measurement: terminalMeasurement.measurement,
		receipt: terminalMeasurement.receipt,
		artifactRef: terminalMeasurement.receipt.artifactRef,
	});
	const transferEvidenceDigest = digestObject({
		requestedScope: learning.requestedScope,
		frontierDisposition: learning.frontierDisposition,
		scopeJustification: learning.scopeJustification,
		goalClosure: learning.goalClosure,
		approvedGoalFamilyManifest: learning.approvedGoalFamilyManifest,
		originatingVectorEvidence: learning.originatingVectorEvidence,
		domainTransferEvidence: learning.domainTransferEvidence,
		crossDomainTransfer: learning.crossDomainTransfer,
		boundaryEvidence: learning.boundaryEvidence,
		invariantEvidence: learning.invariantEvidence,
		redTeamEvidence: learning.redTeamEvidence,
		independentApproval: learning.independentApproval,
		restoreRehashProofs: learning.restoreRehashProofs,
	});
	const manifest = contract.inputManifest;
	const approvedGoal = contract.goals.find((goal) => goal.goalId === learning.measurement.goalId);
	if (approvedGoal === undefined) throw new Error("portfolio knowledge promotion goal is not approved.");
	const holdout = approvedGoal.opaqueHoldout;
	const holdoutSafeAggregateDigest = digestObject({
		kind: "portfolio-knowledge-holdout-safe-aggregate",
		manifestDigest: manifest.manifestDigest,
		manifestRevision: manifest.manifestRevision,
		evaluationEpoch: manifest.evaluationEpoch,
		closureRootDigest: manifest.closureRootDigest,
		splitClosureRoots: manifest.splitClosureRoots,
		modelAccess: manifest.modelAccess,
		opaqueHoldout:
			holdout === undefined
				? null
				: {
						locked: holdout.locked,
						policy: holdout.policy,
						candidateVisible: holdout.candidateVisible,
						handleDigest: holdout.handleDigest,
						inputDigest: holdout.inputDigest,
						resolverDigest: holdout.resolverDigest,
						evaluationEpoch: holdout.evaluationEpoch,
						closureRootDigest: holdout.closureRootDigest,
						splitClosureRoots: holdout.splitClosureRoots,
					},
		measurement: {
			measurementDigest: autoResearchPortfolioMeasurementDigest(learning.measurement),
			inputManifestDigest: learning.measurement.inputManifestDigest,
			splitClosureRoots: learning.measurement.splitClosureRoots,
		},
	});
	const epochRef: WorkflowEpochRef = {
		storeEpoch: learning.currentStoreEpoch,
		coordinatorEpoch: learning.currentCoordinatorEpoch,
	};
	const applicability = deriveApplicability(input.applicability, scope, learning);
	const resourceDigest = digestObject({
		kind: "workflow-learning-knowledge-promotion-resource",
		workflowId: learning.workflowId,
		candidateDigest,
		contractDigest,
		scope: scope.effectiveScope,
		scopeDecision: scope,
		lesson: input.lesson,
		applicability,
		terminalEvidenceDigest,
		transferEvidenceDigest,
		holdoutSafeAggregateDigest,
	});
	const operationDigest = digestObject({
		kind: "workflow-learning-knowledge-promotion-operation",
		workflowId: learning.workflowId,
		resourceDigest,
		currentStateDigest: learning.currentStateDigest,
		currentRevision: learning.currentRevision,
		epochRef,
		executionIdentity: authority.executionIdentity,
		sessionId: authority.sessionId,
		lesson: input.lesson,
		applicability,
	});
	const bindingDigest = digestObject({
		kind: "workflow-learning-knowledge-promotion-binding",
		workflowId: learning.workflowId,
		candidateDigest,
		contractDigest,
		scope: scope.effectiveScope,
		scopeDecision: scope,
		terminalEvidenceDigest,
		transferEvidenceDigest,
		holdoutSafeAggregateDigest,
		currentStateDigest: learning.currentStateDigest,
		currentRevision: learning.currentRevision,
		epochRef,
		executionIdentity: authority.executionIdentity,
		sessionId: authority.sessionId,
		resourceDigest,
		operationDigest,
	});
	return Object.freeze({ resourceDigest, operationDigest, bindingDigest });
}

function candidateMeasurements(input: PortfolioTerminalInput): readonly PortfolioHostMeasurementEvidence[] {
	return input.measurements.filter(
		(evidence) =>
			evidence.measurement.scope === "terminal" &&
			evidence.measurement.kind === "candidate" &&
			evidence.measurement.candidateId !== null,
	);
}

function assertTerminalVectorEvidence(
	input: PortfolioKnowledgeCompositionInput,
): readonly PortfolioHostMeasurementEvidence[] {
	const terminal = input.terminal;
	if (
		terminal.contract.schemaVersion !== 3 ||
		terminal.contract.terminalScope !== "terminal" ||
		terminal.contract.learningScope !== "learning" ||
		!Object.isFrozen(terminal.contract) ||
		!Object.isFrozen(terminal.contract.inputManifest)
	)
		throw new Error("portfolio knowledge requires a parsed frozen schema-v3 terminal/learning contract.");
	const measurements = candidateMeasurements(terminal);
	if (measurements.length === 0) throw new Error("portfolio knowledge requires signed terminal vector evidence.");
	const expectedMeasurementDigest = autoResearchPortfolioMeasurementDigest(input.learning.measurement);
	let fullVectorMatch = false;
	for (const evidence of measurements) {
		if (evidence.measurement.candidateId !== input.learning.candidate.candidateId)
			throw new Error("portfolio knowledge terminal vector candidate binding is invalid.");
		if (!Array.isArray(evidence.measurement.vector) || evidence.measurement.vector.length === 0)
			throw new Error("portfolio knowledge terminal vector evidence is empty.");
		if (
			evidence.receipt.receiptKind !== "artifact" ||
			evidence.receipt.workflowId !== terminal.workflowId ||
			evidence.receipt.stateDigest !== terminal.currentStateDigest ||
			evidence.receipt.revision !== terminal.currentRevision ||
			!evidence.measurement.evidenceDigests.includes(evidence.receipt.payloadDigest)
		)
			throw new Error("portfolio knowledge terminal vector receipt is stale or not bound to its measurement.");
		if (autoResearchPortfolioMeasurementDigest(evidence.measurement) === expectedMeasurementDigest)
			fullVectorMatch = true;
	}
	if (!fullVectorMatch)
		throw new Error("portfolio knowledge terminal evidence does not carry the admitted full vector.");
	return measurements;
}

function artifactRefDigest(receipt: WorkflowVerifiedHostReceipt): string {
	return digestObject(receipt.artifactRef);
}

function sameArtifactRef(left: unknown, right: unknown): boolean {
	return isPlainObject(left) && isPlainObject(right) && sameDigest(left, right);
}

function expectedWorkerAttestationDigest(
	input: PortfolioLearningScopeAdmissionInput,
	evidence: PortfolioLearningHostEvidence,
): string {
	return digestObject({
		kind: "portfolio-learning-host-worker-attestation",
		workflowId: input.workflowId,
		candidateId: input.candidate.candidateId,
		candidateDigest: autoResearchPortfolioCandidateDigest(input.candidate),
		contractDigest: autoResearchPortfolioContractDigest(input.contract),
		measurementDigest: autoResearchPortfolioMeasurementDigest(input.measurement),
		workerId: evidence.workerId,
		workerRole: evidence.workerRole,
		artifactRef: evidence.artifactRef,
	});
}

function expectedAdversarialBindingDigest(
	input: PortfolioLearningScopeAdmissionInput,
	evidence: PortfolioLearningHostEvidence,
): string {
	return digestObject({
		kind: "portfolio-learning-host-evidence-binding",
		workflowId: input.workflowId,
		candidateId: input.candidate.candidateId,
		candidateDigest: autoResearchPortfolioCandidateDigest(input.candidate),
		contractDigest: autoResearchPortfolioContractDigest(input.contract),
		measurementDigest: autoResearchPortfolioMeasurementDigest(input.measurement),
		workspaceDigest: input.measurement.workspaceDigest,
		workerId: evidence.workerId,
		workerRole: evidence.workerRole,
		workerAttestationDigest: evidence.workerAttestationDigest,
		executionIdentity: evidence.executionIdentity,
		sessionId: evidence.sessionId,
		witnessKind: "receipt",
		stage: evidence.witness.stage,
		semantic: { kind: "red_team", independence: "independent", disposition: "pass" },
		artifactRef: evidence.artifactRef,
		closureRootDigest: evidence.closureRootDigest,
		evaluationEpoch: evidence.evaluationEpoch,
		acquisition: evidence.acquisition,
		coverage: evidence.coverage,
	});
}

function expectedAdversarialPayloadDigest(bindingDigest: string, evidence: PortfolioLearningHostEvidence): string {
	return digestObject({
		kind: "portfolio-learning-host-evidence-payload",
		bindingDigest,
		receiptKind: "artifact",
		semantic: { kind: "red_team", independence: "independent", disposition: "pass" },
		workerId: evidence.workerId,
		workerRole: evidence.workerRole,
		artifactRef: evidence.artifactRef,
	});
}

async function assertIndependentAdversarialEvidence(
	input: PortfolioKnowledgeCompositionInput,
	terminalMeasurements: readonly PortfolioHostMeasurementEvidence[],
): Promise<PortfolioLearningHostEvidence> {
	const adversarial = input.learning.redTeamEvidence;
	if (adversarial === null || adversarial === undefined)
		throw new Error("portfolio knowledge requires independent adversarial evidence.");
	assertClosedKeys(adversarial, ["disposition", "evidence", "independence"], "portfolio red-team evidence");
	if (adversarial.independence !== "independent" || adversarial.disposition !== "pass")
		throw new Error("portfolio knowledge adversarial evidence is not independently passing.");
	const evidence = adversarial.evidence;
	assertClosedKeys(evidence, HOST_EVIDENCE_KEYS, "portfolio red-team host evidence");
	assertClosedKeys(
		evidence.artifactRef,
		["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"],
		"portfolio red-team artifact",
	);
	assertClosedKeys(evidence.receipt, RECEIPT_KEYS_WITH_CAPABILITY, "portfolio red-team receipt");
	if (evidence.receipt.capabilityBinding !== undefined)
		assertClosedKeys(
			evidence.receipt.capabilityBinding,
			CAPABILITY_BINDING_KEYS,
			"portfolio red-team capability binding",
		);
	if (
		evidence.receipt.capabilityBinding !== undefined &&
		(evidence.receipt.capabilityBinding.capability !== "workflow_learning_knowledge_promotion" ||
			evidence.receipt.capabilityBinding.executionIdentity !== evidence.executionIdentity ||
			evidence.receipt.capabilityBinding.sessionId !== evidence.sessionId)
	)
		throw new Error("portfolio knowledge adversarial capability binding is not host-owned.");
	assertClosedKeys(evidence.witness, WITNESS_KEYS, "portfolio red-team witness");
	const inputLearning = input.learning;
	const expectedBindingDigest = expectedAdversarialBindingDigest(inputLearning, evidence);
	if (
		evidence.workerRole !== "red_team" ||
		evidence.workerAttestationDigest !== expectedWorkerAttestationDigest(inputLearning, evidence) ||
		evidence.bindingDigest !== expectedBindingDigest ||
		evidence.receipt.receiptKind !== "artifact" ||
		evidence.receipt.oneUse !== true ||
		evidence.witness.oneUse !== true ||
		evidence.receipt.bindingDigest !== expectedBindingDigest ||
		evidence.receipt.payloadDigest !== expectedAdversarialPayloadDigest(expectedBindingDigest, evidence) ||
		!sameArtifactRef(evidence.artifactRef, evidence.receipt.artifactRef) ||
		!sameArtifactRef(evidence.artifactRef, evidence.witness.evidenceRef) ||
		evidence.witness.witnessKind !== "receipt" ||
		typeof evidence.witness.witnessId !== "string" ||
		evidence.witness.witnessId.trim().length === 0 ||
		!/red[-_]team/iu.test(evidence.witness.stage) ||
		evidence.witness.workflowId !== inputLearning.workflowId ||
		evidence.witness.candidateId !== inputLearning.candidate.candidateId ||
		evidence.witness.payloadDigest !== expectedBindingDigest ||
		evidence.witness.bytesDigest !== evidence.artifactRef.digest ||
		evidence.witness.bytesSize !== evidence.artifactRef.sizeBytes ||
		evidence.witness.revision !== inputLearning.currentRevision ||
		evidence.witness.storeEpoch !== inputLearning.currentStoreEpoch ||
		evidence.witness.coordinatorEpoch !== inputLearning.currentCoordinatorEpoch ||
		evidence.witness.stateHeadDigest !== inputLearning.currentStateHeadDigest ||
		evidence.witness.trustedNow !== inputLearning.trustedNow ||
		evidence.executionIdentity.trim().length === 0 ||
		evidence.sessionId.trim().length === 0 ||
		evidence.receipt.workflowId !== inputLearning.workflowId ||
		evidence.receipt.stateDigest !== inputLearning.currentStateDigest ||
		evidence.receipt.revision !== inputLearning.currentRevision ||
		evidence.workspaceDigest !== inputLearning.measurement.workspaceDigest ||
		evidence.closureRootDigest !== inputLearning.contract.inputManifest.closureRootDigest ||
		evidence.evaluationEpoch !== inputLearning.contract.inputManifest.evaluationEpoch ||
		evidence.acquisition !== "complete" ||
		evidence.coverage !== "complete"
	)
		throw new Error("portfolio knowledge adversarial receipt is not bound to the full current portfolio tuple.");
	const terminalArtifactDigests = new Set(terminalMeasurements.map((entry) => artifactRefDigest(entry.receipt)));
	if (
		terminalMeasurements.some(
			(entry) =>
				entry.receipt.receiptId === evidence.receipt.receiptId ||
				terminalArtifactDigests.has(artifactRefDigest(evidence.receipt)),
		)
	)
		throw new Error("portfolio knowledge adversarial evidence is not independent of the terminal vector.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: inputLearning.receiptContext,
		workflowId: inputLearning.workflowId,
		expectedBindingDigest,
		receipt: evidence.receipt,
		currentStateDigest: inputLearning.currentStateDigest,
		currentRevision: inputLearning.currentRevision,
		trustedNow: inputLearning.trustedNow,
	});
	const consumption = await inputLearning.receiptContext.receiptResolver.resolveConsumptionWitness({
		receiptId: evidence.receipt.receiptId,
		workflowId: inputLearning.workflowId,
		expectedBindingDigest,
	});
	if (
		consumption.receiptId !== evidence.receipt.receiptId ||
		consumption.workflowId !== inputLearning.workflowId ||
		consumption.bindingDigest !== expectedBindingDigest ||
		!Number.isSafeInteger(consumption.consumptionSequence) ||
		consumption.consumptionSequence <= 0 ||
		!Number.isFinite(Date.parse(consumption.consumedAt)) ||
		Date.parse(consumption.consumedAt) > Date.parse(inputLearning.trustedNow)
	)
		throw new Error("portfolio knowledge adversarial evidence is not consumed by the host receipt authority.");
	return evidence;
}

function joinScopePrefix(base: string | undefined, component: string, value: string): string {
	return [base, component, value].filter((part): part is string => part !== undefined && part.length > 0).join("/");
}

function pathComponent(value: string, label: string): string {
	boundedText(value, label, 256);
	if (value.includes("/") || value.includes("\\") || value === "." || value === "..")
		throw new Error(`${label} is not a normalized path component.`);
	return value;
}

function deriveApplicability(
	context: PortfolioKnowledgeApplicabilityContext,
	decision: PortfolioLearningScopeDecision,
	learning: PortfolioLearningScopeAdmissionInput,
): KnowledgeApplicability {
	const scope = decision.effectiveScope;
	if (scope === "goal" || scope === "domain") {
		if (context.workspaceId === undefined)
			throw new Error(`${scope} portfolio knowledge requires a workspace identity.`);
		const component = scope === "goal" ? "goal" : "domain";
		const value =
			scope === "goal" ? learning.originatingVectorEvidence.goalId : learning.originatingVectorEvidence.domainId;
		const pathPrefix = joinScopePrefix(
			context.pathPrefix,
			component,
			pathComponent(value, `portfolio knowledge ${component} identity`),
		);
		return {
			namespace: context.namespace,
			scope: "workspace",
			workspaceId: context.workspaceId,
			...(pathPrefix.length === 0 ? {} : { pathPrefix }),
		};
	}
	if (scope !== "global") throw new Error("portfolio knowledge cannot derive applicability for an unapproved scope.");
	if (context.userId === undefined) throw new Error("global portfolio knowledge requires a user identity.");
	return { namespace: context.namespace, scope: "user", userId: context.userId };
}

interface CollectedEvidence {
	readonly receipts: ReadonlyMap<string, WorkflowVerifiedHostReceipt>;
	readonly witnessDigests: ReadonlyMap<string, readonly string[]>;
}

function isReceipt(value: unknown): value is WorkflowVerifiedHostReceipt {
	return (
		isPlainObject(value) &&
		typeof value.receiptId === "string" &&
		typeof value.workflowId === "string" &&
		isPlainObject(value.artifactRef)
	);
}

function isWitness(value: unknown): value is WorkflowLearningHostWitness {
	return isPlainObject(value) && typeof value.witnessId === "string" && isPlainObject(value.evidenceRef);
}

function collectEvidencePayloads(payloads: readonly unknown[]): CollectedEvidence {
	const receipts = new Map<string, WorkflowVerifiedHostReceipt>();
	const witnessDigests = new Map<string, Set<string>>();
	const seen = new WeakSet<object>();
	let nodes = 0;
	const visit = (value: unknown, depth: number): void => {
		if (depth > 40) throw new Error("portfolio knowledge evidence exceeds the bounded depth.");
		if (value === null || typeof value !== "object") return;
		if (++nodes > 200_000) throw new Error("portfolio knowledge evidence exceeds the bounded size.");
		if (isReceipt(value)) {
			if (value.receiptKind === "artifact") {
				const prior = receipts.get(value.receiptId);
				if (prior !== undefined && !sameDigest(prior, value))
					throw new Error("portfolio knowledge evidence reused a receipt ID with different bytes.");
				receipts.set(value.receiptId, structuredClone(value));
			}
			return;
		}
		if (isWitness(value)) {
			const artifactDigest = digestObject(value.evidenceRef);
			const existing = witnessDigests.get(artifactDigest) ?? new Set<string>();
			existing.add(digestObject(value));
			witnessDigests.set(artifactDigest, existing);
		}
		if (seen.has(value)) return;
		seen.add(value);
		for (const key of Reflect.ownKeys(value)) {
			if (typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key)) continue;
			visit((value as Record<string, unknown>)[key], depth + 1);
		}
	};
	for (const payload of payloads) visit(payload, 0);
	return {
		receipts,
		witnessDigests: new Map(
			[...witnessDigests.entries()].map(([key, values]) => [key, Object.freeze([...values].sort())]),
		),
	};
}

function evidenceEnvelopeRef(
	receipt: WorkflowVerifiedHostReceipt,
	contract: AutoResearchPortfolioContract,
	scope: PortfolioLearningScope,
	witnessDigests: readonly string[],
): WorkflowEvidenceEnvelopeRef {
	if (receipt.receiptKind !== "artifact")
		throw new Error("portfolio knowledge source evidence must be an artifact receipt.");
	return {
		workflowId: receipt.workflowId,
		envelopeId: `portfolio-knowledge:${receipt.receiptId}`,
		envelopeDigest: digestObject({
			kind: "portfolio-knowledge-source",
			contractDigest: autoResearchPortfolioContractDigest(contract),
			scope,
			receiptId: receipt.receiptId,
			artifactRef: receipt.artifactRef,
			witnessDigests,
		}),
		evidenceRevision: receipt.revision,
		artifactRefs: [structuredClone(receipt.artifactRef)],
		validationReceipt: structuredClone(receipt),
	};
}

function sourceEvidenceRefs(
	contract: AutoResearchPortfolioContract,
	scope: PortfolioLearningScope,
	collected: CollectedEvidence,
): readonly WorkflowEvidenceEnvelopeRef[] {
	const refs = [...collected.receipts.values()]
		.sort((left, right) => left.receiptId.localeCompare(right.receiptId))
		.map((receipt) =>
			evidenceEnvelopeRef(
				receipt,
				contract,
				scope,
				collected.witnessDigests.get(digestObject(receipt.artifactRef)) ?? EMPTY_REJECTION_REASONS,
			),
		);
	if (refs.length === 0) throw new Error("portfolio knowledge requires durable signed source evidence.");
	return refs;
}

function assertRefinementInput(
	input: PortfolioKnowledgeCompositionInput,
	evidenceRefs: readonly WorkflowEvidenceEnvelopeRef[],
): void {
	const refinement = input.refinement;
	if (
		refinement.experience.source !== "host" ||
		refinement.experience.workflowId !== input.terminal.workflowId ||
		refinement.trigger.workflowId !== input.terminal.workflowId ||
		refinement.trigger.candidateId !== input.learning.candidate.candidateId ||
		refinement.experience.outcome !== "positive" ||
		refinement.experience.progressKind !== "verified"
	)
		throw new Error("portfolio knowledge refinement crossed its host, workflow, or candidate boundary.");
	const required = new Set(evidenceRefs.map((ref) => digestObject(ref.artifactRefs[0])));
	const suppliedExperience = new Set(refinement.experience.progressEvidenceRefs.map((ref) => digestObject(ref)));
	const suppliedTrigger = new Set(refinement.trigger.evidenceRefs.map((ref) => digestObject(ref)));
	for (const artifactDigest of required) {
		if (!suppliedExperience.has(artifactDigest) || !suppliedTrigger.has(artifactDigest))
			throw new Error("portfolio knowledge refinement is missing signed portfolio evidence.");
	}
}

function buildProposal(
	input: PortfolioKnowledgeCompositionInput,
	decision: PortfolioLearningScopeDecision,
	applicability: KnowledgeApplicability,
	evidenceRefs: readonly WorkflowEvidenceEnvelopeRef[],
): KnowledgeProposal {
	const template = input.knowledgeCommitRequest.proposal;
	const proposalId = digestObject({
		kind: "portfolio-knowledge",
		contractDigest: autoResearchPortfolioContractDigest(input.learning.contract),
		candidateId: input.learning.candidate.candidateId,
		templateProposalId: template.proposalId,
		scope: decision.effectiveScope,
		lesson: input.lesson,
		applicability,
		evidenceRefs,
	});
	const epochRef: WorkflowEpochRef = {
		storeEpoch: input.learning.currentStoreEpoch,
		coordinatorEpoch: input.learning.currentCoordinatorEpoch,
	};
	return {
		proposalId,
		recordId: `portfolio:${proposalId}`,
		kind: input.lesson.kind,
		title: input.lesson.title,
		statement: input.lesson.statement,
		provenance: { source: "host", producerId: HOST_PRODUCER_ID },
		applicability,
		privacy: structuredClone(template.privacy),
		retention: structuredClone(template.retention ?? DEFAULT_RETENTION),
		confidence: KNOWLEDGE_CONFIDENCE,
		decisionRef: structuredClone(template.decisionRef),
		evidenceRefs: [...evidenceRefs],
		epochRef,
		action: "create",
		expectedRevision: null,
		rollbackRevision: null,
	};
}

function buildCommitRequest(
	input: PortfolioKnowledgeCompositionInput,
	proposal: KnowledgeProposal,
): KnowledgeCommitRequest {
	const template = input.knowledgeCommitRequest;
	return {
		...structuredClone(template),
		proposal: structuredClone(proposal),
		mutationId: `portfolio-knowledge:${proposal.proposalId}`,
		idempotencyKey: `portfolio-knowledge:${proposal.proposalId}`,
		epochRef: {
			storeEpoch: input.learning.currentStoreEpoch,
			coordinatorEpoch: input.learning.currentCoordinatorEpoch,
		},
		knowledgeStoreEpoch: input.learning.currentStoreEpoch,
	};
}

function assertPrincipalAuthorizationDecision(
	decision: WorkflowHostPrincipalCapabilityAuthorization,
	authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput,
): void {
	assertClosedKeys(
		decision,
		[
			"authenticatedPrincipal",
			"authorizationDigest",
			"bindingDigest",
			"capability",
			"epochRef",
			"executionIdentity",
			"keyOwnerPrincipal",
			"receipt",
			"revision",
			"sessionId",
			"stateDigest",
			"validity",
			"workflowId",
		],
		"portfolio knowledge promotion principal authorization",
	);
	assertClosedKeys(
		decision.validity,
		["issuedAt", "validUntil"],
		"portfolio knowledge promotion principal authorization validity",
	);
	assertClosedKeys(
		decision.epochRef,
		["coordinatorEpoch", "storeEpoch"],
		"portfolio knowledge promotion principal authorization epoch",
	);
	if (
		decision.authenticatedPrincipal.trim().length === 0 ||
		decision.keyOwnerPrincipal.trim().length === 0 ||
		decision.authenticatedPrincipal !== decision.keyOwnerPrincipal ||
		decision.capability !== authorizationInput.capability ||
		decision.workflowId !== authorizationInput.workflowId ||
		decision.bindingDigest !== authorizationInput.bindingDigest ||
		decision.stateDigest !== authorizationInput.stateDigest ||
		decision.revision !== authorizationInput.revision ||
		decision.epochRef.storeEpoch !== authorizationInput.epochRef.storeEpoch ||
		decision.epochRef.coordinatorEpoch !== authorizationInput.epochRef.coordinatorEpoch ||
		decision.validity.issuedAt !== authorizationInput.receipt.issuedAt ||
		decision.validity.validUntil !== authorizationInput.receipt.validUntil ||
		decision.executionIdentity !== authorizationInput.executionIdentity ||
		decision.sessionId !== authorizationInput.sessionId ||
		!/^[0-9a-f]{64}$/u.test(decision.authorizationDigest) ||
		digestObject(decision.receipt) !== digestObject(authorizationInput.receipt)
	)
		throw new Error("portfolio knowledge promotion principal authorization is not bound to the current tuple.");
}

async function authorizePromotionAuthority(
	input: PortfolioKnowledgeCompositionInput,
	scope: PortfolioLearningScopeDecision,
	terminalMeasurement: PortfolioHostMeasurementEvidence,
	request: KnowledgeCommitRequest,
): Promise<WorkflowVerifiedHostReceipt> {
	assertPromotionAuthorityShape(input);
	if (
		input.authority.executionIdentity !== request.leaseRef.processIdentity ||
		typeof request.executionKey !== "string" ||
		request.executionKey.trim().length === 0 ||
		input.authority.sessionId !== request.executionKey
	)
		throw new Error("portfolio knowledge promotion authority is not bound to the current execution session.");
	const digests = portfolioKnowledgePromotionAuthorityDigests(input, scope, terminalMeasurement, input.authority);
	const receipt = input.authority.receipt;
	const capabilityBinding = receipt.capabilityBinding;
	if (
		capabilityBinding === undefined ||
		capabilityBinding.resourceDigest !== digests.resourceDigest ||
		capabilityBinding.operationDigest !== digests.operationDigest ||
		receipt.bindingDigest !== digests.bindingDigest
	)
		throw new Error("portfolio knowledge promotion authority is not bound to the full evidence tuple.");
	const verified = await resolveAndVerifyWorkflowHostReceipt({
		context: input.learning.receiptContext,
		workflowId: input.learning.workflowId,
		expectedBindingDigest: digests.bindingDigest,
		receipt,
		currentStateDigest: input.learning.currentStateDigest,
		currentRevision: input.learning.currentRevision,
		trustedNow: input.learning.trustedNow,
	});
	if (digestObject(verified) !== digestObject(receipt))
		throw new Error("portfolio knowledge promotion resolver returned a different authority receipt.");
	const principalAuthorizer = input.learning.receiptContext.principalAuthorizer;
	if (principalAuthorizer === undefined || typeof principalAuthorizer.authorize !== "function")
		throw new Error("CONTRACT_CHANGE: portfolio knowledge requires the generic host principalAuthorizer seam.");
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt: verified,
		workflowId: input.learning.workflowId,
		bindingDigest: digests.bindingDigest,
		resourceDigest: digests.resourceDigest,
		operationDigest: digests.operationDigest,
		stateDigest: input.learning.currentStateDigest,
		revision: input.learning.currentRevision,
		epochRef: request.epochRef,
		capability: "workflow_learning_knowledge_promotion",
		executionIdentity: input.authority.executionIdentity,
		sessionId: input.authority.sessionId,
	};
	const decision = await principalAuthorizer.authorize(authorizationInput);
	assertPrincipalAuthorizationDecision(decision, authorizationInput);
	return verified;
}

async function consumePromotionAuthority(
	input: PortfolioKnowledgeCompositionInput,
	receipt: WorkflowVerifiedHostReceipt,
	bindingDigest: string,
): Promise<void> {
	const resolver = input.learning.receiptContext.receiptResolver;
	let consumed = false;
	try {
		const existing = await resolver.resolveConsumptionWitness({
			receiptId: receipt.receiptId,
			workflowId: input.learning.workflowId,
			expectedBindingDigest: bindingDigest,
		});
		consumed =
			existing.receiptId === receipt.receiptId &&
			existing.workflowId === input.learning.workflowId &&
			existing.bindingDigest === bindingDigest;
	} catch {
		consumed = false;
	}
	if (!consumed) {
		await resolver.consumeIfOneUse({
			receipt,
			workflowId: input.learning.workflowId,
			expectedBindingDigest: bindingDigest,
			currentRevision: input.learning.currentRevision,
		});
	}
	const witness = await resolver.resolveConsumptionWitness({
		receiptId: receipt.receiptId,
		workflowId: input.learning.workflowId,
		expectedBindingDigest: bindingDigest,
	});
	if (
		witness.receiptId !== receipt.receiptId ||
		witness.workflowId !== input.learning.workflowId ||
		witness.bindingDigest !== bindingDigest ||
		!Number.isSafeInteger(witness.consumptionSequence) ||
		witness.consumptionSequence < 1 ||
		!Number.isFinite(Date.parse(witness.consumedAt)) ||
		Date.parse(witness.consumedAt) > Date.parse(input.learning.trustedNow)
	)
		throw new Error("portfolio knowledge promotion authority consumption witness is invalid.");
}

function skippedResult(scope: PortfolioLearningScopeDecision, reasons: readonly string[]): PortfolioKnowledgeResult {
	return Object.freeze({
		accepted: false,
		mutated: false,
		terminal: null,
		scope,
		applicability: null,
		knowledgeRecord: null,
		learning: { status: "not_attempted" as const },
		projectedToMemPalace: false,
		rejectionReasons: Object.freeze([...reasons]),
	});
}

/**
 * Compose signed schema-v3 portfolio evidence into canonical knowledge, then
 * route workflow policy refinement through the existing learning runtime.
 *
 * Args:
 * input: Host-owned terminal, admitted scope, canonical knowledge request/store, MemPalace boundary, and learning runtime.
 * Return: Mutation and evidence status; scope rejection never calls a downstream writer.
 */
export async function composePortfolioKnowledge(
	input: PortfolioKnowledgeCompositionInput,
): Promise<PortfolioKnowledgeResult> {
	if (input === null || typeof input !== "object" || Array.isArray(input))
		throw new Error("portfolio knowledge composition input is required.");
	assertClosedKeys(input, COMPOSITION_KEYS, "portfolio knowledge composition");
	const scope = await admitPortfolioLearningScope(input.learning);
	if (!scope.canPromote)
		return skippedResult(
			scope,
			scope.rejectionReasons.map((reason) => `scope:${reason}`),
		);
	assertLesson(input.lesson);
	assertApplicabilityContext(input.applicability);
	assertRefinementSchema(input.refinement);
	assertKnowledgeAuthority(input);
	assertLearningRuntime(input);
	assertMemPalaceBoundary(input.mempalace);
	assertScopeContracts(input);
	const terminalMeasurements = assertTerminalVectorEvidence(input);
	const terminal = await evaluatePortfolioTerminal(input.terminal);
	if (
		!terminal.accepted ||
		terminal.outcome === "failed" ||
		terminal.outcome === "boundary_violation" ||
		terminal.authority !== "host" ||
		terminal.workerCanAuthorize ||
		terminal.candidateCanAuthorize ||
		terminal.mutated
	)
		return {
			...skippedResult(scope, ["terminal:evidence_not_successful", ...terminal.reasons]),
			terminal,
		};
	const matchingTerminalMeasurement = terminalMeasurements.find(
		(entry) =>
			autoResearchPortfolioMeasurementDigest(entry.measurement) ===
			autoResearchPortfolioMeasurementDigest(input.learning.measurement),
	);
	if (matchingTerminalMeasurement === undefined)
		return { ...skippedResult(scope, ["terminal:full_vector_mismatch"]), terminal };
	await assertIndependentAdversarialEvidence(input, terminalMeasurements);
	const originatingVectorEvidence = input.learning.originatingVectorEvidence;
	if (originatingVectorEvidence === null || originatingVectorEvidence === undefined)
		return { ...skippedResult(scope, ["learning:originating_vector_evidence_missing"]), terminal };
	if (
		!originatingVectorEvidence.evidence.some((entry) =>
			sameArtifactRef(entry.receipt.artifactRef, matchingTerminalMeasurement.receipt.artifactRef),
		)
	)
		return { ...skippedResult(scope, ["learning:originating_vector_not_bound"]), terminal };
	const collected = collectEvidencePayloads([
		{
			contract: input.terminal.contract,
			workflowId: input.terminal.workflowId,
			currentStateDigest: input.terminal.currentStateDigest,
			currentRevision: input.terminal.currentRevision,
			trustedNow: input.terminal.trustedNow,
			measurements: input.terminal.measurements,
			frontier: input.terminal.frontier,
			boundaries: input.terminal.boundaries,
			acquisition: input.terminal.acquisition,
			completion: input.terminal.completion,
			tradeoff: input.terminal.tradeoff,
			infeasibility: input.terminal.infeasibility,
			goalDecisions: input.terminal.goalDecisions,
			stop: input.terminal.stop,
		},
		{
			contract: input.learning.contract,
			candidate: input.learning.candidate,
			measurement: input.learning.measurement,
			frontierDisposition: input.learning.frontierDisposition,
			originatingVectorEvidence: input.learning.originatingVectorEvidence,
			scopeJustification: input.learning.scopeJustification,
			goalClosure: input.learning.goalClosure,
			approvedGoalFamilyManifest: input.learning.approvedGoalFamilyManifest,
			domainTransferEvidence: input.learning.domainTransferEvidence,
			crossDomainTransfer: input.learning.crossDomainTransfer,
			boundaryEvidence: input.learning.boundaryEvidence,
			invariantEvidence: input.learning.invariantEvidence,
			redTeamEvidence: input.learning.redTeamEvidence,
			independentApproval: input.learning.independentApproval,
			restoreRehashProofs: input.learning.restoreRehashProofs,
		},
		input.refinement,
	]);
	const evidenceRefs = sourceEvidenceRefs(input.learning.contract, scope.effectiveScope, collected);
	assertRefinementInput(input, evidenceRefs);
	const applicability = deriveApplicability(input.applicability, scope, input.learning);
	const proposal = buildProposal(input, scope, applicability, evidenceRefs);
	const request = buildCommitRequest(input, proposal);
	assertPromotionAuthorizerSeam(input);
	const promotionAuthorityReceipt = await authorizePromotionAuthority(
		input,
		scope,
		matchingTerminalMeasurement,
		request,
	);
	const committed = await input.knowledgeStore.commit(request);
	// The canonical CAS is the first durable mutation; a retry repairs only the
	// idempotent authority witness before any learning or index side effect.
	await consumePromotionAuthority(input, promotionAuthorityReceipt, promotionAuthorityReceipt.bindingDigest);
	if (committed.status === "replayed")
		return Object.freeze({
			accepted: true,
			mutated: false,
			terminal,
			scope,
			applicability,
			knowledgeRecord: committed.record,
			learning: { status: "not_attempted" as const },
			projectedToMemPalace: false,
			rejectionReasons: EMPTY_REJECTION_REASONS,
		});

	const experience = await input.learningRuntime.commitExperience(structuredClone(input.refinement.experience));
	const candidate = await input.learningRuntime.typeCandidate({
		experienceId: experience.experienceId,
		trigger: structuredClone(input.refinement.trigger),
	});
	if (
		candidate.candidateId !== input.learning.candidate.candidateId ||
		candidate.experienceId !== experience.experienceId ||
		candidate.kind !== "policy" ||
		candidate.mutationClass !== "policy"
	)
		return Object.freeze({
			accepted: false,
			mutated: true,
			terminal,
			scope,
			applicability,
			knowledgeRecord: committed.record,
			learning: { status: "rejected" as const, experience, candidate },
			projectedToMemPalace: false,
			rejectionReasons: Object.freeze(["learning:policy_candidate_not_admitted"]),
		});
	const review = await input.learningRuntime.reviewCandidate(candidate.candidateId);
	if (
		review.status !== "promoted" ||
		review.promotion === null ||
		review.promotion.candidateId !== candidate.candidateId
	)
		return Object.freeze({
			accepted: false,
			mutated: true,
			terminal,
			scope,
			applicability,
			knowledgeRecord: committed.record,
			learning: { status: "rejected" as const, experience, candidate, review },
			projectedToMemPalace: false,
			rejectionReasons: Object.freeze(["learning:policy_refinement_not_promoted"]),
		});
	let projectedToMemPalace = false;
	if (input.mempalace !== undefined) {
		await input.mempalace.project(committed.record);
		projectedToMemPalace = true;
	}
	return Object.freeze({
		accepted: true,
		mutated: true,
		terminal,
		scope,
		applicability,
		knowledgeRecord: committed.record,
		learning: { status: "promoted" as const, experience, candidate, review },
		projectedToMemPalace,
		rejectionReasons: EMPTY_REJECTION_REASONS,
	});
}

/** Compose using the explicit bridge name used by host workflow integrations. */
export const bridgePortfolioToKnowledge = composePortfolioKnowledge;
export const composePortfolioKnowledgeBridge = composePortfolioKnowledge;

/**
 * Create a stateless bridge facade over the same composition function.
 *
 * Args:
 * Return: Stateless composition facade.
 */
export function createPortfolioKnowledgeBridge(): PortfolioKnowledgeBridge {
	return Object.freeze({ compose: composePortfolioKnowledge });
}
