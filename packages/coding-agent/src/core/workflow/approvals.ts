import { createHash, randomUUID } from "node:crypto";
import type {
	DurableSignedApprovalArtifact,
	WorkflowApprovalAwaitingUserTransition,
	WorkflowApprovalConsumptionResult,
	WorkflowApprovalDecisionRoles,
	WorkflowApprovalReceipt,
	WorkflowApprovalRequest,
	WorkflowApprovalResponse,
	WorkflowApprovalResumeTransition,
	WorkflowDecisionRef,
	WorkflowEpochRef,
	WorkflowHostReceiptConsumerContext,
	WorkflowTrustedPrincipal,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import { digestObject, resolveAndVerifyWorkflowHostReceipt } from "./contracts.js";
import { WorkflowStore } from "./reducer.js";

export type WorkflowApprovalAction = "approve" | "decline" | "cancel" | "revise" | "restart";

export type WorkflowApprovalHostOutcome =
	| (WorkflowApprovalHostOutcomeBase & {
			action: "approve";
			disposition: "approved";
			transition: "resume_planning";
	  })
	| (WorkflowApprovalHostOutcomeBase & {
			action: "decline";
			disposition: "declined";
			transition: "remain_awaiting_user";
	  })
	| (WorkflowApprovalHostOutcomeBase & {
			action: "cancel";
			disposition: "cancelled";
			transition: "cancelled";
	  })
	| (WorkflowApprovalHostOutcomeBase & {
			action: "revise";
			disposition: "revised";
			transition: "remain_awaiting_user";
	  })
	| (WorkflowApprovalHostOutcomeBase & {
			action: "restart";
			disposition: "restarted";
			transition: "remain_awaiting_user";
	  });

interface WorkflowApprovalHostOutcomeBase {
	approvalRequestId: string;
	optionId: string;
	effectDigest: string;
	responseDigest: string;
	outcomeDigest: string;
}

export interface WorkflowApprovalConsumptionWithOutcome extends WorkflowApprovalConsumptionResult {
	outcome: WorkflowApprovalHostOutcome;
}

export interface WorkflowApprovalInvalidation {
	approvalRequestId: string;
	workflowId: string;
	headDigest: string;
	stateDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	responseSequence: number;
	reason: string;
	eventDigest: string;
}

export type WorkflowApprovalInvalidationResult =
	| { status: "invalidated"; invalidation: WorkflowApprovalInvalidation }
	| { status: "already_invalidated"; invalidation: WorkflowApprovalInvalidation }
	| { status: "already_consumed"; receipt: WorkflowApprovalReceipt };

export interface WorkflowApprovalManagerWithOutcome extends WorkflowApprovalManager {
	consumeInteractive(response: WorkflowApprovalResponse): Promise<WorkflowApprovalConsumptionWithOutcome>;
	consumeSignedHeadless(response: WorkflowApprovalResponse): Promise<WorkflowApprovalConsumptionWithOutcome>;
	invalidate(approvalRequestId: string, reason?: string): Promise<WorkflowApprovalInvalidationResult>;
	cancel(approvalRequestId: string, reason?: string): Promise<WorkflowApprovalInvalidationResult>;
	reopen(store: WorkflowApprovalStore): Promise<WorkflowApprovalManagerWithOutcome>;
}

export interface WorkflowApprovalRequestInput {
	workflowId: string;
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	decisionRoles: WorkflowApprovalDecisionRoles;
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	expectedResponseSequence: number;
	expiresAt?: string;
	ttlMilliseconds?: number;
	question: string;
	options: readonly { optionId: string; label: string; effectDigest: string }[];
	awaitingUserTransition: WorkflowApprovalAwaitingUserTransition;
}

export interface WorkflowApprovalBindingInput {
	approvalRequestId: string;
	workflowId: string;
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	decisionRoles: WorkflowApprovalDecisionRoles;
	headDigest: string;
	stateDigest: string;
	configDigest: string;
	profileDigest: string;
	artifactDigest: string;
	storeEpoch: number;
	coordinatorEpoch: number;
	principal: WorkflowTrustedPrincipal;
	clientSessionId: string;
	responseSequence: number;
	optionId: string;
	tokenHash: string;
	expiresAt: string;
}

export interface ApprovalSignatureVerifier {
	verify(artifact: DurableSignedApprovalArtifact, signedDigest: string): boolean;
}

export interface WorkflowApprovalKeyResolver {
	resolve(input: {
		keyId: string;
		algorithm: "ed25519";
		principal: WorkflowTrustedPrincipal;
	}): Promise<ApprovalSignatureVerifier>;
}

export interface WorkflowTrustedClock {
	receipt(input: { workflowId: string; bindingDigest: string }): Promise<WorkflowVerifiedHostReceipt>;
}

export interface WorkflowApprovalSecretProvider {
	prepare(input: {
		workflowId: string;
		clientSessionId: string;
		trustedPrincipal: WorkflowTrustedPrincipal;
		requestDigest: string;
	}): Promise<WorkflowApprovalSecretIssuance>;
	deliver(input: { issuance: WorkflowApprovalSecretIssuance; request: WorkflowApprovalRequest }): Promise<void>;
}

export interface WorkflowApprovalSecretIssuance {
	issuanceId: string;
	workflowId: string;
	clientSessionId: string;
	trustedPrincipal: WorkflowTrustedPrincipal;
	tokenHash: string;
	tokenHashAlgorithm: "sha256";
	deliveryProof: string;
}

export interface WorkflowApprovalDecisionContext {
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	decisionRoles: WorkflowApprovalDecisionRoles;
	hostReceipt: WorkflowVerifiedHostReceipt;
}

export interface WorkflowApprovalDecisionAuthority {
	resolveCurrent(input: {
		workflowId: string;
		stateDigest: string;
		epochRef: WorkflowEpochRef;
		currentRevision: number;
	}): Promise<WorkflowApprovalDecisionContext>;
}

export interface WorkflowApprovalManagerDependencies {
	store: WorkflowApprovalStore;
	/** Exact reducer store owned by the host composition; absent for unbound utility managers. */
	hostStore?: object;
	keyResolver: WorkflowApprovalKeyResolver;
	secretProvider: WorkflowApprovalSecretProvider;
	decisionAuthority: WorkflowApprovalDecisionAuthority;
	trustedPrincipal: WorkflowTrustedPrincipal;
	clientSessionId: string;
	trustedClock: WorkflowTrustedClock;
	maxTtlMilliseconds: number;
	receiptContext: WorkflowHostReceiptConsumerContext;
	currentRevision: number;
	/** Resolves the current durable journal revision for long-lived host managers. */
	currentRevisionResolver?: () => number;
}

export interface WorkflowApprovalManager {
	createRequest(input: WorkflowApprovalRequestInput): Promise<WorkflowApprovalRequest>;
	pending(workflowId: string): Promise<WorkflowApprovalRequest | null>;
	consumeInteractive(response: WorkflowApprovalResponse): Promise<WorkflowApprovalConsumptionResult>;
	consumeSignedHeadless(response: WorkflowApprovalResponse): Promise<WorkflowApprovalConsumptionResult>;
	reopen(store: WorkflowApprovalStore): Promise<WorkflowApprovalManager>;
}

const AUTHENTIC_APPROVAL_MANAGERS = new WeakSet<object>();

/**
 * Checks that an approval manager was constructed by the host approval authority.
 *
 * Args:
 * value: Candidate manager supplied to a phase host context.
 * Return: True only for a manager branded by the durable approval implementation.
 */
export function isWorkflowApprovalManager(value: unknown): value is WorkflowApprovalManager {
	return typeof value === "object" && value !== null && AUTHENTIC_APPROVAL_MANAGERS.has(value);
}

/**
 * Brands a host-owned manager wrapper while preserving its public manager type.
 *
 * Args:
 * manager: Durable manager or host wrapper around one.
 * Return: The same branded manager instance.
 */
function brandWorkflowApprovalManager<T extends WorkflowApprovalManager>(manager: T): T {
	AUTHENTIC_APPROVAL_MANAGERS.add(manager);
	return manager;
}

export interface WorkflowApprovalStore {
	prepareRequest(input: {
		request: WorkflowApprovalRequest;
		requestEventDigest: string;
		issuance: WorkflowApprovalSecretIssuance;
		awaitingUserTransition: WorkflowApprovalAwaitingUserTransition;
		expectedHeadDigest: string;
		expectedStateDigest: string;
		expectedEpoch: WorkflowEpochRef;
	}): Promise<void>;
	markSecretDelivered(input: {
		approvalRequestId: string;
		deliveryProof: string;
		expectedStateDigest: string;
		expectedEpoch: WorkflowEpochRef;
	}): Promise<void>;
	read(approvalRequestId: string): Promise<WorkflowApprovalRequest | null>;
	readPending(workflowId: string): Promise<WorkflowApprovalRequest | null>;
	readCurrentHead(workflowId: string): Promise<{
		stateDigest: string;
		epochRef: WorkflowEpochRef;
		headDigest: string;
		revision: number;
	}>;
	/**
	 * Returns the durable head immediately after the authenticated approval request event.
	 * Stores that append the request into the workflow journal implement this seam so
	 * response freshness is checked against the post-request head while the approval
	 * binding remains tied to the proposal head.
	 */
	readPreparedHead?(approvalRequestId: string): Promise<{
		stateDigest: string;
		epochRef: WorkflowEpochRef;
		headDigest: string;
		revision: number;
	}>;
	consume(input: {
		approvalRequestId: string;
		expectedResponseSequence: number;
		optionId: string;
		expectedStateDigest: string;
		expectedEpoch: WorkflowEpochRef;
		expectedHeadDigest: string;
		responseDigest: string;
		effectDigest: string;
		trustedClockReceipt: WorkflowVerifiedHostReceipt;
		approvalConsumedEventDigest: string;
		resumeTransition: WorkflowApprovalResumeTransition | null;
		outcomeDigest: string;
	}): Promise<WorkflowApprovalConsumptionResult>;
	invalidate(input: {
		approvalRequestId: string;
		expectedResponseSequence: number;
		expectedStateDigest: string;
		expectedEpoch: WorkflowEpochRef;
		expectedHeadDigest: string;
		invalidation: WorkflowApprovalInvalidation;
	}): Promise<WorkflowApprovalInvalidationResult>;
	readInvalidation(approvalRequestId: string): Promise<WorkflowApprovalInvalidation | null>;
	reconcile(): Promise<void>;
}

export function approvalBindingDigest(input: WorkflowApprovalBindingInput): string {
	return digestObject({
		approvalRequestId: input.approvalRequestId,
		workflowId: input.workflowId,
		decisionRef: input.decisionRef,
		decisionRefs: input.decisionRefs,
		decisionRoles: input.decisionRoles,
		headDigest: input.headDigest,
		stateDigest: input.stateDigest,
		configDigest: input.configDigest,
		profileDigest: input.profileDigest,
		artifactDigest: input.artifactDigest,
		storeEpoch: input.storeEpoch,
		coordinatorEpoch: input.coordinatorEpoch,
		principal: input.principal,
		clientSessionId: input.clientSessionId,
		responseSequence: input.responseSequence,
		optionId: input.optionId,
		tokenHash: input.tokenHash,
		expiresAt: input.expiresAt,
	});
}

function decisionContextBindingDigest(input: {
	workflowId: string;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	decisionRoles: WorkflowApprovalDecisionRoles;
}): string {
	return digestObject({
		kind: "approval_decision_context",
		workflowId: input.workflowId,
		stateDigest: input.stateDigest,
		epochRef: input.epochRef,
		decisionRef: input.decisionRef,
		decisionRefs: input.decisionRefs,
		decisionRoles: input.decisionRoles,
	});
}

function sha256Secret(secret: string): string {
	return createHash("sha256").update(secret, "utf8").digest("hex");
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSha256Hex(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function resolveApprovalAction(optionId: string): WorkflowApprovalAction {
	if (
		optionId !== "approve" &&
		optionId !== "approve_cloud" &&
		optionId !== "decline" &&
		optionId !== "cancel" &&
		optionId !== "revise" &&
		optionId !== "restart"
	) {
		throw new Error("Workflow approval option is not a supported typed host action.");
	}
	return optionId === "approve_cloud" ? "approve" : optionId;
}

function createApprovalHostOutcome(input: {
	request: WorkflowApprovalRequest;
	option: { optionId: string; effectDigest: string };
	responseDigest: string;
}): WorkflowApprovalHostOutcome {
	const action = resolveApprovalAction(input.option.optionId);
	const base = {
		approvalRequestId: input.request.approvalRequestId,
		optionId: input.option.optionId,
		effectDigest: input.option.effectDigest,
		responseDigest: input.responseDigest,
		outcomeDigest: digestObject({
			kind: "approval_host_outcome",
			approvalRequestId: input.request.approvalRequestId,
			action,
			optionId: input.option.optionId,
			effectDigest: input.option.effectDigest,
			responseDigest: input.responseDigest,
		}),
	};
	if (action === "approve") return { ...base, action, disposition: "approved", transition: "resume_planning" };
	if (action === "decline") return { ...base, action, disposition: "declined", transition: "remain_awaiting_user" };
	if (action === "cancel") return { ...base, action, disposition: "cancelled", transition: "cancelled" };
	if (action === "revise") return { ...base, action, disposition: "revised", transition: "remain_awaiting_user" };
	return { ...base, action: "restart", disposition: "restarted", transition: "remain_awaiting_user" };
}

function samePrincipal(left: WorkflowTrustedPrincipal, right: WorkflowTrustedPrincipal): boolean {
	return (
		left.kind === right.kind &&
		left.principalId === right.principalId &&
		left.credentialDigest === right.credentialDigest
	);
}

function assertTrustedPrincipal(principal: WorkflowTrustedPrincipal, label: string): void {
	if (
		(principal.kind !== "interactive_ui" &&
			principal.kind !== "workflow_command" &&
			principal.kind !== "headless_signer") ||
		!isNonEmptyString(principal.principalId) ||
		!isNonEmptyString(principal.credentialDigest)
	) {
		throw new Error(`${label} is not a valid trusted principal.`);
	}
}

function assertEpoch(epoch: WorkflowEpochRef, label: string): void {
	if (!isPositiveSafeInteger(epoch.storeEpoch) || !isPositiveSafeInteger(epoch.coordinatorEpoch)) {
		throw new Error(`${label} is not a valid workflow epoch.`);
	}
}

function assertDecisionRef(ref: WorkflowDecisionRef, workflowId: string, expectedEpoch: WorkflowEpochRef): void {
	if (
		ref.decisionScope.kind !== "workflow" ||
		ref.decisionScope.workflowId !== workflowId ||
		!isNonEmptyString(ref.decisionScope.rootSessionId) ||
		!isNonEmptyString(ref.decisionId) ||
		!isPositiveSafeInteger(ref.revision) ||
		ref.storeEpoch !== expectedEpoch.storeEpoch ||
		ref.coordinatorEpoch !== expectedEpoch.coordinatorEpoch ||
		!isNonEmptyString(ref.decisionDigest)
	) {
		throw new Error("Approval decision reference is not bound to the current workflow revision and epoch.");
	}
}

function assertApprovalDecisionRoles(input: {
	workflowId: string;
	decisionRef: WorkflowDecisionRef;
	decisionRefs: readonly WorkflowDecisionRef[];
	decisionRoles: WorkflowApprovalDecisionRoles;
	expectedEpoch?: WorkflowEpochRef;
}): void {
	const expectedEpoch = input.expectedEpoch ?? {
		storeEpoch: input.decisionRoles.goal.storeEpoch,
		coordinatorEpoch: input.decisionRoles.goal.coordinatorEpoch,
	};
	const ordered = [input.decisionRoles.goal, input.decisionRoles.scorecard, input.decisionRoles.resource];
	if (
		input.decisionRefs.length !== 3 ||
		ordered.some((ref, index) => digestObject(ref) !== digestObject(input.decisionRefs[index])) ||
		new Set(ordered.map((ref) => digestObject(ref))).size !== 3 ||
		digestObject(input.decisionRef) !== digestObject(input.decisionRoles.resource)
	) {
		throw new Error("Approval decision roles must be the exact current goal, scorecard, and resource refs.");
	}
	for (const ref of ordered) assertDecisionRef(ref, input.workflowId, expectedEpoch);
}

function assertDigest(value: string, label: string): void {
	if (!isNonEmptyString(value)) throw new Error(`${label} is missing.`);
}

function assertRequestInput(input: WorkflowApprovalRequestInput): void {
	if (!isNonEmptyString(input.workflowId))
		throw new Error("Workflow approval request is missing its workflow identity.");
	assertEpoch({ storeEpoch: input.storeEpoch, coordinatorEpoch: input.coordinatorEpoch }, "Approval request epoch");
	for (const [value, label] of [
		[input.headDigest, "Approval request head digest"],
		[input.stateDigest, "Approval request state digest"],
		[input.configDigest, "Approval request config digest"],
		[input.profileDigest, "Approval request profile digest"],
		[input.artifactDigest, "Approval request artifact digest"],
	] as const) {
		assertDigest(value, label);
	}
	if (!isPositiveSafeInteger(input.expectedResponseSequence)) {
		throw new Error("Approval request response sequence must be a positive safe integer.");
	}
	if (!isNonEmptyString(input.question) || input.options.length === 0) {
		throw new Error("Workflow approval request must contain a question and at least one option.");
	}
	const optionIds = new Set<string>();
	for (const option of input.options) {
		if (
			!isNonEmptyString(option.optionId) ||
			!isNonEmptyString(option.label) ||
			!isNonEmptyString(option.effectDigest) ||
			optionIds.has(option.optionId)
		) {
			throw new Error("Workflow approval options must have unique non-empty identifiers and effect digests.");
		}
		resolveApprovalAction(option.optionId);
		optionIds.add(option.optionId);
	}
	assertApprovalDecisionRoles({
		workflowId: input.workflowId,
		decisionRef: input.decisionRef,
		decisionRefs: input.decisionRefs,
		decisionRoles: input.decisionRoles,
		expectedEpoch: { storeEpoch: input.storeEpoch, coordinatorEpoch: input.coordinatorEpoch },
	});
	if (
		input.awaitingUserTransition.status !== "awaiting_user" ||
		input.awaitingUserTransition.phase !== "adjudicating" ||
		input.awaitingUserTransition.expectedHeadDigest !== input.headDigest ||
		digestObject(input.awaitingUserTransition.expectedEpoch) !==
			digestObject({ storeEpoch: input.storeEpoch, coordinatorEpoch: input.coordinatorEpoch })
	) {
		throw new Error(
			"Approval request awaiting_user transition is stale or missing its authenticated head and epoch tuple.",
		);
	}
}

function assertApprovalRequest(request: WorkflowApprovalRequest): void {
	if (
		!isNonEmptyString(request.approvalRequestId) ||
		!isNonEmptyString(request.workflowId) ||
		!isNonEmptyString(request.requestingClientSessionId) ||
		!isSha256Hex(request.tokenHash) ||
		request.tokenHashAlgorithm !== "sha256" ||
		!isPositiveSafeInteger(request.expectedResponseSequence) ||
		!isNonEmptyString(request.expiresAt) ||
		!isNonEmptyString(request.question) ||
		request.options.length === 0
	) {
		throw new Error("Persisted workflow approval request is malformed.");
	}
	assertEpoch(
		{ storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
		"Persisted approval request epoch",
	);
	assertTrustedPrincipal(request.trustedPrincipal, "Persisted approval request principal");
	assertApprovalDecisionRoles({
		workflowId: request.workflowId,
		decisionRef: request.decisionRef,
		decisionRefs: workflowDecisionRefs(request),
		decisionRoles: request.decisionRoles,
		expectedEpoch: { storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
	});
}

function assertApprovalResponse(
	request: WorkflowApprovalRequest,
	response: WorkflowApprovalResponse,
	principal: WorkflowTrustedPrincipal,
	clientSessionId: string,
	trustedNow: string,
): void {
	assertApprovalDecisionRoles({
		workflowId: request.workflowId,
		decisionRef: request.decisionRef,
		decisionRefs: workflowDecisionRefs(request),
		decisionRoles: request.decisionRoles,
		expectedEpoch: { storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
	});
	if (
		response.approvalRequestId !== request.approvalRequestId ||
		response.workflowId !== request.workflowId ||
		response.headDigest !== request.headDigest ||
		response.stateDigest !== request.stateDigest ||
		response.configDigest !== request.configDigest ||
		response.profileDigest !== request.profileDigest ||
		response.artifactDigest !== request.artifactDigest ||
		response.responseSequence !== request.expectedResponseSequence ||
		response.storeEpoch !== request.storeEpoch ||
		response.coordinatorEpoch !== request.coordinatorEpoch ||
		response.clientSessionId !== clientSessionId ||
		!samePrincipal(response.trustedPrincipal, principal) ||
		!samePrincipal(response.trustedPrincipal, request.trustedPrincipal) ||
		digestObject(response.decisionRef) !== digestObject(request.decisionRef) ||
		digestObject(response.decisionRefs) !== digestObject(request.decisionRefs) ||
		digestObject(response.decisionRoles) !== digestObject(request.decisionRoles) ||
		!Number.isFinite(Date.parse(trustedNow)) ||
		!Number.isFinite(Date.parse(request.expiresAt)) ||
		Date.parse(trustedNow) >= Date.parse(request.expiresAt)
	) {
		throw new Error("Workflow approval response is not bound to the pending request.");
	}
	const option = request.options.find((candidate) => candidate.optionId === response.optionId);
	if (option === undefined) throw new Error("Workflow approval option is not present in the pending request.");
}

function workflowDecisionRefs(request: WorkflowApprovalRequest): readonly WorkflowDecisionRef[] {
	return request.decisionRefs as readonly WorkflowDecisionRef[];
}

function assertCurrentDecisionContext(input: {
	context: WorkflowApprovalDecisionContext;
	workflowId: string;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	expectedDecisionRef?: WorkflowDecisionRef;
	expectedDecisionRefs?: readonly WorkflowDecisionRef[];
	expectedDecisionRoles?: WorkflowApprovalDecisionRoles;
}): void {
	assertApprovalDecisionRoles({
		workflowId: input.workflowId,
		decisionRef: input.context.decisionRef,
		decisionRefs: input.context.decisionRefs,
		decisionRoles: input.context.decisionRoles,
		expectedEpoch: input.epochRef,
	});
	if (
		input.expectedDecisionRef !== undefined &&
		digestObject(input.context.decisionRef) !== digestObject(input.expectedDecisionRef)
	) {
		throw new Error("Current host decision reference does not match the requested approval revision.");
	}
	if (
		input.expectedDecisionRefs !== undefined &&
		digestObject(input.context.decisionRefs) !== digestObject(input.expectedDecisionRefs)
	) {
		throw new Error("Current host decision references do not match the requested approval revisions.");
	}
	if (
		input.expectedDecisionRoles !== undefined &&
		digestObject(input.context.decisionRoles) !== digestObject(input.expectedDecisionRoles)
	) {
		throw new Error("Current host decision roles do not match the requested approval revisions.");
	}
}

async function verifyCurrentDecisionContext(input: {
	context: WorkflowApprovalDecisionContext;
	workflowId: string;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	currentRevision: number;
	trustedNow: string;
	receiptContext: WorkflowHostReceiptConsumerContext;
	expectedDecisionRef?: WorkflowDecisionRef;
	expectedDecisionRefs?: readonly WorkflowDecisionRef[];
	expectedDecisionRoles?: WorkflowApprovalDecisionRoles;
}): Promise<void> {
	assertCurrentDecisionContext(input);
	if (input.context.hostReceipt.receiptKind !== "decision" && input.context.hostReceipt.receiptKind !== "adjudication")
		throw new Error("Current approval decision context lacks a decision host receipt.");
	await resolveAndVerifyWorkflowHostReceipt({
		context: input.receiptContext,
		workflowId: input.workflowId,
		expectedBindingDigest: decisionContextBindingDigest({
			workflowId: input.workflowId,
			stateDigest: input.stateDigest,
			epochRef: input.epochRef,
			decisionRef: input.context.decisionRef,
			decisionRefs: input.context.decisionRefs,
			decisionRoles: input.context.decisionRoles,
		}),
		receipt: input.context.hostReceipt,
		currentStateDigest: input.stateDigest,
		currentRevision: input.currentRevision,
		trustedNow: input.trustedNow,
	});
}

function createResponseDigest(
	request: WorkflowApprovalRequest,
	response: WorkflowApprovalResponse,
	optionEffectDigest: string,
	optionAction: WorkflowApprovalAction,
	proofDigest: string,
): string {
	return digestObject({
		approvalRequestId: request.approvalRequestId,
		decisionRef: request.decisionRef,
		decisionRefs: request.decisionRefs,
		decisionRoles: request.decisionRoles,
		workflowId: request.workflowId,
		headDigest: request.headDigest,
		stateDigest: request.stateDigest,
		configDigest: request.configDigest,
		profileDigest: request.profileDigest,
		artifactDigest: request.artifactDigest,
		storeEpoch: request.storeEpoch,
		coordinatorEpoch: request.coordinatorEpoch,
		clientSessionId: request.requestingClientSessionId,
		responseSequence: request.expectedResponseSequence,
		optionId: response.optionId,
		effectDigest: optionEffectDigest,
		action: optionAction,
		mode: response.mode,
		proofDigest,
	});
}

function assertConsumedReceipt(
	result: WorkflowApprovalConsumptionResult,
	request: WorkflowApprovalRequest,
	response: WorkflowApprovalResponse,
	optionEffectDigest: string,
	responseDigest: string,
	trustedClockReceipt: WorkflowVerifiedHostReceipt,
): void {
	if (result.status !== "consumed") throw new Error("Workflow approval response was already consumed.");
	const receipt = result.receipt;
	if (
		receipt.approvalRequestId !== request.approvalRequestId ||
		receipt.workflowId !== request.workflowId ||
		digestObject(receipt.decisionRef) !== digestObject(request.decisionRef) ||
		digestObject(receipt.decisionRefs) !== digestObject(request.decisionRefs) ||
		digestObject(receipt.decisionRoles) !== digestObject(request.decisionRoles) ||
		receipt.headDigest !== request.headDigest ||
		receipt.stateDigest !== request.stateDigest ||
		receipt.configDigest !== request.configDigest ||
		receipt.profileDigest !== request.profileDigest ||
		receipt.artifactDigest !== request.artifactDigest ||
		receipt.storeEpoch !== request.storeEpoch ||
		receipt.coordinatorEpoch !== request.coordinatorEpoch ||
		receipt.clientSessionId !== request.requestingClientSessionId ||
		!samePrincipal(receipt.trustedPrincipal, request.trustedPrincipal) ||
		receipt.responseSequence !== request.expectedResponseSequence ||
		receipt.optionId !== response.optionId ||
		receipt.effectDigest !== optionEffectDigest ||
		receipt.responseDigest !== responseDigest ||
		digestObject(receipt.trustedClockReceipt) !== digestObject(trustedClockReceipt) ||
		!isPositiveSafeInteger(receipt.consumptionEventSequence) ||
		!isNonEmptyString(receipt.consumedAt) ||
		!Number.isFinite(Date.parse(receipt.consumedAt)) ||
		(receipt.mode !== "interactive_secret" && receipt.mode !== "signed_headless")
	) {
		throw new Error("Workflow approval store returned a receipt outside the authenticated response binding.");
	}
}

export function createDurableApprovalManager(
	input: WorkflowApprovalManagerDependencies,
): WorkflowApprovalManagerWithOutcome {
	assertTrustedPrincipal(input.trustedPrincipal, "Approval manager principal");
	if (!isNonEmptyString(input.clientSessionId)) throw new Error("Approval manager client session is missing.");
	if (!isPositiveSafeInteger(input.maxTtlMilliseconds) || !isPositiveSafeInteger(input.currentRevision)) {
		throw new Error("Approval manager bounds are not finite positive values.");
	}
	const resolveCurrentRevision = (): number => {
		const revision = input.currentRevisionResolver?.() ?? input.currentRevision;
		if (!isPositiveSafeInteger(revision)) throw new Error("Approval manager current revision is not positive.");
		return revision;
	};
	const store = input.store;

	const createRequest = async (requestInput: WorkflowApprovalRequestInput): Promise<WorkflowApprovalRequest> => {
		assertRequestInput(requestInput);
		const requestEpoch = { storeEpoch: requestInput.storeEpoch, coordinatorEpoch: requestInput.coordinatorEpoch };
		const currentHead = await store.readCurrentHead(requestInput.workflowId);
		if (
			currentHead.stateDigest !== requestInput.stateDigest ||
			currentHead.headDigest !== requestInput.headDigest ||
			digestObject(currentHead.epochRef) !== digestObject(requestEpoch) ||
			currentHead.headDigest !== requestInput.awaitingUserTransition.expectedHeadDigest
		) {
			throw new Error(
				"Approval request is stale against the current durable head and cannot create awaiting_user state.",
			);
		}

		const requestClockBinding = digestObject({
			kind: "approval_request_clock",
			workflowId: requestInput.workflowId,
			stateDigest: requestInput.stateDigest,
			expiresAt: requestInput.expiresAt ?? null,
			ttlMilliseconds: requestInput.ttlMilliseconds ?? null,
		});
		const trustedClockReceipt = await input.trustedClock.receipt({
			workflowId: requestInput.workflowId,
			bindingDigest: requestClockBinding,
		});
		await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: requestInput.workflowId,
			expectedBindingDigest: requestClockBinding,
			receipt: trustedClockReceipt,
			currentStateDigest: requestInput.stateDigest,
			currentRevision: resolveCurrentRevision(),
			trustedNow: trustedClockReceipt.issuedAt,
		});
		if (trustedClockReceipt.receiptKind !== "clock")
			throw new Error("Approval request requires a host clock receipt.");
		const currentDecision = await input.decisionAuthority.resolveCurrent({
			workflowId: requestInput.workflowId,
			stateDigest: requestInput.stateDigest,
			epochRef: requestEpoch,
			currentRevision: resolveCurrentRevision(),
		});
		await verifyCurrentDecisionContext({
			context: currentDecision,
			workflowId: requestInput.workflowId,
			stateDigest: requestInput.stateDigest,
			epochRef: requestEpoch,
			currentRevision: resolveCurrentRevision(),
			trustedNow: trustedClockReceipt.issuedAt,
			receiptContext: input.receiptContext,
			expectedDecisionRef: requestInput.decisionRef,
			expectedDecisionRefs: requestInput.decisionRefs,
			expectedDecisionRoles: requestInput.decisionRoles,
		});
		const trustedNow = Date.parse(trustedClockReceipt.issuedAt);
		const ttlMilliseconds =
			requestInput.ttlMilliseconds ??
			(requestInput.expiresAt === undefined ? Number.NaN : Date.parse(requestInput.expiresAt) - trustedNow);
		const expiresAtText =
			requestInput.expiresAt ??
			(Number.isSafeInteger(ttlMilliseconds) ? new Date(trustedNow + ttlMilliseconds).toISOString() : "");
		const expiresAt = Date.parse(expiresAtText);
		if (
			!Number.isFinite(trustedNow) ||
			!Number.isSafeInteger(ttlMilliseconds) ||
			ttlMilliseconds <= 0 ||
			!Number.isFinite(expiresAt) ||
			expiresAt <= trustedNow ||
			expiresAt - trustedNow !== ttlMilliseconds ||
			expiresAt - trustedNow > input.maxTtlMilliseconds
		) {
			throw new Error("Workflow approval request is incomplete or outside the trusted bounded TTL.");
		}

		const requestDigest = digestObject({
			workflowId: requestInput.workflowId,
			decisionRef: requestInput.decisionRef,
			decisionRefs: requestInput.decisionRefs,
			decisionRoles: requestInput.decisionRoles,
			headDigest: requestInput.headDigest,
			stateDigest: requestInput.stateDigest,
			configDigest: requestInput.configDigest,
			profileDigest: requestInput.profileDigest,
			artifactDigest: requestInput.artifactDigest,
			storeEpoch: requestInput.storeEpoch,
			coordinatorEpoch: requestInput.coordinatorEpoch,
			expectedResponseSequence: requestInput.expectedResponseSequence,
			expiresAt: expiresAtText,
			options: requestInput.options,
		});
		const issuance = await input.secretProvider.prepare({
			workflowId: requestInput.workflowId,
			clientSessionId: input.clientSessionId,
			trustedPrincipal: input.trustedPrincipal,
			requestDigest,
		});
		if (
			!isNonEmptyString(issuance.issuanceId) ||
			issuance.workflowId !== requestInput.workflowId ||
			issuance.clientSessionId !== input.clientSessionId ||
			!samePrincipal(issuance.trustedPrincipal, input.trustedPrincipal) ||
			!isSha256Hex(issuance.tokenHash) ||
			issuance.tokenHashAlgorithm !== "sha256" ||
			!isNonEmptyString(issuance.deliveryProof)
		) {
			throw new Error("Approval secret preparation is not trusted.");
		}
		const request: WorkflowApprovalRequest = {
			approvalRequestId: randomUUID(),
			workflowId: requestInput.workflowId,
			decisionRef: requestInput.decisionRef,
			decisionRefs: [...requestInput.decisionRefs],
			decisionRoles: {
				goal: requestInput.decisionRoles.goal,
				scorecard: requestInput.decisionRoles.scorecard,
				resource: requestInput.decisionRoles.resource,
			},
			headDigest: requestInput.headDigest,
			stateDigest: requestInput.stateDigest,
			configDigest: requestInput.configDigest,
			profileDigest: requestInput.profileDigest,
			artifactDigest: requestInput.artifactDigest,
			storeEpoch: requestInput.storeEpoch,
			coordinatorEpoch: requestInput.coordinatorEpoch,
			tokenHash: issuance.tokenHash,
			tokenHashAlgorithm: issuance.tokenHashAlgorithm,
			trustedPrincipal: input.trustedPrincipal,
			requestingClientSessionId: input.clientSessionId,
			expectedResponseSequence: requestInput.expectedResponseSequence,
			expiresAt: expiresAtText,
			question: requestInput.question,
			options: requestInput.options.map((option) => ({ ...option })),
		};
		await store.prepareRequest({
			request,
			requestEventDigest: digestObject({
				kind: "approval_requested",
				approval: request,
				awaitingUser: requestInput.awaitingUserTransition,
			}),
			issuance,
			awaitingUserTransition: requestInput.awaitingUserTransition,
			expectedHeadDigest: requestInput.awaitingUserTransition.expectedHeadDigest,
			expectedStateDigest: requestInput.stateDigest,
			expectedEpoch: requestInput.awaitingUserTransition.expectedEpoch,
		});
		try {
			await input.secretProvider.deliver({ issuance, request });
			await store.markSecretDelivered({
				approvalRequestId: request.approvalRequestId,
				deliveryProof: issuance.deliveryProof,
				expectedStateDigest: request.stateDigest,
				expectedEpoch: { storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
			});
		} catch (error) {
			try {
				await store.reconcile();
			} catch (reconciliationError) {
				throw new Error("Approval delivery failed and durable reconciliation failed.", {
					cause: reconciliationError,
				});
			}
			throw error;
		}
		return request;
	};

	const pending = async (workflowId: string): Promise<WorkflowApprovalRequest | null> => {
		const request = await store.readPending(workflowId);
		if (request === null || (await store.readInvalidation(request.approvalRequestId)) !== null) return null;
		return request;
	};

	const invalidate = async (
		approvalRequestId: string,
		reason = "approval invalidated",
	): Promise<WorkflowApprovalInvalidationResult> => {
		if (!isNonEmptyString(approvalRequestId)) throw new Error("Approval invalidation request ID is missing.");
		if (!isNonEmptyString(reason)) throw new Error("Approval invalidation reason is missing.");
		const existingInvalidation = await store.readInvalidation(approvalRequestId);
		if (existingInvalidation !== null) return { status: "already_invalidated", invalidation: existingInvalidation };
		const request = await store.read(approvalRequestId);
		if (request === null) throw new Error("Workflow approval request is missing.");
		assertApprovalRequest(request);
		const expectedEpoch = { storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch };
		const invalidation: WorkflowApprovalInvalidation = {
			approvalRequestId: request.approvalRequestId,
			workflowId: request.workflowId,
			headDigest: request.headDigest,
			stateDigest: request.stateDigest,
			storeEpoch: request.storeEpoch,
			coordinatorEpoch: request.coordinatorEpoch,
			responseSequence: request.expectedResponseSequence,
			reason,
			eventDigest: digestObject({
				kind: "approval_invalidated",
				approvalRequestId: request.approvalRequestId,
				workflowId: request.workflowId,
				headDigest: request.headDigest,
				stateDigest: request.stateDigest,
				epochRef: expectedEpoch,
				responseSequence: request.expectedResponseSequence,
				reason,
			}),
		};
		const result = await store.invalidate({
			approvalRequestId: request.approvalRequestId,
			expectedResponseSequence: request.expectedResponseSequence,
			expectedStateDigest: request.stateDigest,
			expectedEpoch,
			expectedHeadDigest: request.headDigest,
			invalidation,
		});
		if (result.status === "already_consumed")
			throw new Error("Workflow approval response was already consumed; it cannot be cancelled.");
		return result;
	};

	const consume = async (
		response: WorkflowApprovalResponse,
		expectedMode: WorkflowApprovalResponse["mode"],
	): Promise<WorkflowApprovalConsumptionWithOutcome> => {
		if (response.mode !== expectedMode)
			throw new Error("Workflow approval response mode is not accepted by this consumer.");
		const request = await store.read(response.approvalRequestId);
		if (request === null) throw new Error("Workflow approval request is missing.");
		assertApprovalRequest(request);
		if ((await store.readInvalidation(request.approvalRequestId)) !== null)
			throw new Error("Workflow approval request was invalidated and cannot be consumed.");
		const currentHead = await store.readCurrentHead(request.workflowId);
		const requestEpoch = { storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch };
		const preparedHead = (await store.readPreparedHead?.(request.approvalRequestId)) ?? {
			stateDigest: request.stateDigest,
			headDigest: request.headDigest,
			epochRef: requestEpoch,
			revision: resolveCurrentRevision(),
		};
		if (
			currentHead.stateDigest !== preparedHead.stateDigest ||
			currentHead.headDigest !== preparedHead.headDigest ||
			digestObject(currentHead.epochRef) !== digestObject(preparedHead.epochRef) ||
			currentHead.revision !== preparedHead.revision
		) {
			throw new Error("Approval request is stale against the current durable head.");
		}
		const consumeClockBinding = digestObject({
			kind: "approval_consume_clock",
			approvalRequestId: request.approvalRequestId,
			responseSequence: request.expectedResponseSequence,
			expiresAt: request.expiresAt,
		});
		const trustedClockReceipt = await input.trustedClock.receipt({
			workflowId: request.workflowId,
			bindingDigest: consumeClockBinding,
		});
		await resolveAndVerifyWorkflowHostReceipt({
			context: input.receiptContext,
			workflowId: request.workflowId,
			expectedBindingDigest: consumeClockBinding,
			receipt: trustedClockReceipt,
			currentStateDigest: request.stateDigest,
			currentRevision: resolveCurrentRevision(),
			trustedNow: trustedClockReceipt.issuedAt,
		});
		if (trustedClockReceipt.receiptKind !== "clock")
			throw new Error("Approval consumption requires a host clock receipt.");
		const currentDecision = await input.decisionAuthority.resolveCurrent({
			workflowId: request.workflowId,
			stateDigest: request.stateDigest,
			epochRef: requestEpoch,
			currentRevision: resolveCurrentRevision(),
		});
		await verifyCurrentDecisionContext({
			context: currentDecision,
			workflowId: request.workflowId,
			stateDigest: request.stateDigest,
			epochRef: requestEpoch,
			currentRevision: resolveCurrentRevision(),
			trustedNow: trustedClockReceipt.issuedAt,
			receiptContext: input.receiptContext,
			expectedDecisionRef: request.decisionRef,
			expectedDecisionRefs: workflowDecisionRefs(request),
			expectedDecisionRoles: request.decisionRoles,
		});
		assertApprovalResponse(
			request,
			response,
			input.trustedPrincipal,
			input.clientSessionId,
			trustedClockReceipt.issuedAt,
		);

		const bindingInput: WorkflowApprovalBindingInput = {
			approvalRequestId: request.approvalRequestId,
			workflowId: request.workflowId,
			decisionRef: request.decisionRef,
			decisionRefs: workflowDecisionRefs(request),
			decisionRoles: request.decisionRoles,
			headDigest: request.headDigest,
			stateDigest: request.stateDigest,
			configDigest: request.configDigest,
			profileDigest: request.profileDigest,
			artifactDigest: request.artifactDigest,
			storeEpoch: request.storeEpoch,
			coordinatorEpoch: request.coordinatorEpoch,
			principal: request.trustedPrincipal,
			clientSessionId: request.requestingClientSessionId,
			responseSequence: request.expectedResponseSequence,
			optionId: response.optionId,
			tokenHash: request.tokenHash,
			expiresAt: request.expiresAt,
		};
		const bindingDigest = approvalBindingDigest(bindingInput);
		if (response.mode === "interactive_secret") {
			if (
				!isNonEmptyString(response.secretProof.oneUseSecret) ||
				response.secretProof.bindingDigestAlgorithm !== "sha256" ||
				response.secretProof.bindingDigest !== bindingDigest ||
				sha256Secret(response.secretProof.oneUseSecret) !== request.tokenHash
			) {
				throw new Error("Interactive approval secret proof is invalid.");
			}
		} else {
			const signed = response.signedHeadlessArtifact;
			if (
				signed.kind !== "signed_headless" ||
				signed.approvalRequestId !== request.approvalRequestId ||
				signed.workflowId !== request.workflowId ||
				digestObject(signed.decisionRef) !== digestObject(request.decisionRef) ||
				digestObject(signed.decisionRefs) !== digestObject(request.decisionRefs) ||
				digestObject(signed.decisionRoles) !== digestObject(request.decisionRoles) ||
				signed.headDigest !== request.headDigest ||
				signed.stateDigest !== request.stateDigest ||
				signed.configDigest !== request.configDigest ||
				signed.profileDigest !== request.profileDigest ||
				signed.artifactDigest !== request.artifactDigest ||
				signed.storeEpoch !== request.storeEpoch ||
				signed.coordinatorEpoch !== request.coordinatorEpoch ||
				!samePrincipal(signed.principal, request.trustedPrincipal) ||
				signed.clientSessionId !== request.requestingClientSessionId ||
				signed.responseSequence !== request.expectedResponseSequence ||
				signed.optionId !== response.optionId ||
				signed.expiresAt !== request.expiresAt ||
				!isNonEmptyString(signed.keyId) ||
				!isNonEmptyString(signed.signature) ||
				signed.signatureAlgorithm !== "ed25519" ||
				!Number.isFinite(Date.parse(signed.expiresAt)) ||
				Date.parse(trustedClockReceipt.issuedAt) >= Date.parse(signed.expiresAt) ||
				signed.signedRequestDigest !== bindingDigest
			) {
				throw new Error("Headless approval signature is invalid or not bound to the pending request.");
			}
			const verifier = await input.keyResolver.resolve({
				keyId: signed.keyId,
				algorithm: signed.signatureAlgorithm,
				principal: signed.principal,
			});
			if (!verifier.verify(signed, bindingDigest)) throw new Error("Headless approval signature is invalid.");
		}

		const option = request.options.find((candidate) => candidate.optionId === response.optionId);
		if (option === undefined) throw new Error("Workflow approval option is missing from the pending request.");
		const optionAction = resolveApprovalAction(option.optionId);
		const commitHead = await store.readCurrentHead(request.workflowId);
		if (
			commitHead.headDigest !== currentHead.headDigest ||
			commitHead.stateDigest !== currentHead.stateDigest ||
			digestObject(commitHead.epochRef) !== digestObject(currentHead.epochRef) ||
			commitHead.revision !== currentHead.revision
		) {
			throw new Error("Approval consumption observed a changed durable head; retry from the current journal head.");
		}
		const resumeTransition: WorkflowApprovalResumeTransition = {
			status: "active",
			phase: "planning",
			plannerEventDigest: digestObject({
				kind: "fresh_planner_started",
				approvalRequestId: request.approvalRequestId,
				priorHeadDigest: commitHead.headDigest,
				stateDigest: request.stateDigest,
				epochRef: commitHead.epochRef,
				revision: commitHead.revision,
			}),
			expectedHeadDigest: commitHead.headDigest,
			expectedStateDigest: request.stateDigest,
			expectedEpoch: commitHead.epochRef,
		};
		const proofDigest =
			response.mode === "interactive_secret" ? bindingDigest : response.signedHeadlessArtifact.signedRequestDigest;
		const responseDigest = createResponseDigest(request, response, option.effectDigest, optionAction, proofDigest);
		const outcome = createApprovalHostOutcome({ request, option, responseDigest });
		const approvalConsumedEventDigest = digestObject({
			kind: "approval_consumed",
			approvalRequestId: request.approvalRequestId,
			responseDigest,
			outcomeDigest: outcome.outcomeDigest,
			priorHeadDigest: commitHead.headDigest,
			currentRevision: commitHead.revision,
			resumeTransition: outcome.transition === "resume_planning" ? resumeTransition : null,
		});
		const consumed = await store.consume({
			approvalRequestId: request.approvalRequestId,
			expectedResponseSequence: request.expectedResponseSequence,
			optionId: option.optionId,
			expectedStateDigest: commitHead.stateDigest,
			expectedEpoch: commitHead.epochRef,
			expectedHeadDigest: commitHead.headDigest,
			effectDigest: option.effectDigest,
			responseDigest,
			trustedClockReceipt,
			approvalConsumedEventDigest,
			resumeTransition: outcome.transition === "resume_planning" ? resumeTransition : null,
			outcomeDigest: outcome.outcomeDigest,
		});
		assertConsumedReceipt(consumed, request, response, option.effectDigest, responseDigest, trustedClockReceipt);
		return { ...consumed, outcome };
	};

	const manager = Object.freeze({
		createRequest,
		pending,
		consumeInteractive: (response: WorkflowApprovalResponse) => consume(response, "interactive_secret"),
		consumeSignedHeadless: (response: WorkflowApprovalResponse) => consume(response, "signed_headless"),
		invalidate,
		cancel: (approvalRequestId: string, reason = "approval cancelled") => invalidate(approvalRequestId, reason),
		reopen: async (nextStore: WorkflowApprovalStore) => {
			await nextStore.reconcile();
			return createDurableApprovalManager({ ...input, store: nextStore });
		},
	});
	return input.hostStore instanceof WorkflowStore ? brandWorkflowApprovalManager(manager) : manager;
}
