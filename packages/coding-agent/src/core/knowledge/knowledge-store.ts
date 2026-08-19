import type {
	WorkflowEpochRef,
	WorkflowEvidenceEnvelopeRef,
	WorkflowHostPrincipalCapabilityAuthorizationInput,
	WorkflowHostReceiptConsumerContext,
	WorkflowKnowledgeCommitRef,
	WorkflowTrustedPrincipal,
	WorkflowVerifiedHostReceipt,
} from "../workflow/contracts.js";
import { digestObject, resolveAndVerifyWorkflowHostReceipt, sha256Hex } from "../workflow/contracts.js";
import type { DurableStoreCommitResult, DurableStoreMutationRequest } from "../workflow/durable-store.js";
import type { KnowledgeAuthenticatedCommitEvidence, KnowledgeDurableStore } from "./knowledge-durable-adapter.js";
import { getKnowledgeDurableAuthority } from "./knowledge-runtime-authority.js";
import {
	freezeKnowledgeValue,
	KNOWLEDGE_KINDS,
	KNOWLEDGE_PRIVACY_CLASSES,
	type KnowledgeEvent,
	type KnowledgePrivacyClass,
	type KnowledgeProjection,
	type KnowledgeProposal,
	type KnowledgeRecord,
	type KnowledgeScope,
	type KnowledgeTombstoneReason,
	knowledgeContentDigest,
	knowledgeProposalFromRecord,
	knowledgeSourceDigest,
	redactKnowledgeRecordForHistory,
	redactKnowledgeRecordForReplay,
	reduceKnowledgeEvent,
	validateKnowledgeEvent,
	validateKnowledgeProjection,
	validateKnowledgeProposal,
	validateKnowledgeRecord,
} from "./records.js";

export interface KnowledgeHostValidationContext {
	workflowId: string;
	namespace: string;
	expectedHead: KnowledgeCommitRequest["expectedHead"];
	epochRef: WorkflowEpochRef;
	trustedNow: string;
	currentStateDigest: string;
	disposition: "accepted";
	bindingDigest: string;
}

export interface KnowledgeTombstoneFingerprintContext {
	workflowId: string;
	namespace: string;
	recordId: string;
	revision: number;
	reason: KnowledgeTombstoneReason;
	priorContentDigest: string | null;
	proposalDigest: string;
	epochRef: WorkflowEpochRef;
	trustedNow: string;
	bindingDigest: string;
	currentStateDigest: string;
	currentRevision: number;
}

export interface KnowledgeHostVerification {
	receipt: WorkflowVerifiedHostReceipt;
	context: WorkflowHostReceiptConsumerContext;
}

export interface KnowledgeHostOpaqueFingerprint extends KnowledgeHostVerification {
	fingerprint: string;
}

export interface KnowledgeHostValidation {
	validateDecision(
		reference: KnowledgeProposal["decisionRef"],
		proposal: KnowledgeProposal,
		context: KnowledgeHostValidationContext,
	): KnowledgeHostVerification | Promise<KnowledgeHostVerification>;
	validateEvidence(
		reference: WorkflowEvidenceEnvelopeRef,
		proposal: KnowledgeProposal,
		context: KnowledgeHostValidationContext,
	): KnowledgeHostVerification | Promise<KnowledgeHostVerification>;
	validateSecretScan(
		receipt: WorkflowVerifiedHostReceipt,
		proposal: KnowledgeProposal,
		context: KnowledgeHostValidationContext,
	): KnowledgeHostVerification | Promise<KnowledgeHostVerification>;
	deriveTombstoneFingerprint(
		context: KnowledgeTombstoneFingerprintContext,
	): KnowledgeHostOpaqueFingerprint | Promise<KnowledgeHostOpaqueFingerprint>;
}

export interface KnowledgeRecallInput {
	query: string;
	principal: WorkflowTrustedPrincipal;
	trustedClockReceipt: WorkflowVerifiedHostReceipt;
	kind?: KnowledgeProposal["kind"];
	scope?: KnowledgeScope;
	workspaceId?: string;
	sessionId?: string;
	userId?: string;
	pathPrefix?: string;
	privacyAtMost?: KnowledgePrivacyClass;
}

export type KnowledgeDurableMutation = Omit<DurableStoreMutationRequest<KnowledgeEvent>, "semantic"> & {
	knowledgeStoreEpoch: number;
};

export interface KnowledgeCommitRequest extends KnowledgeDurableMutation {
	proposal: KnowledgeProposal;
}

export interface KnowledgeCommitResult {
	status: "committed" | "replayed";
	record: KnowledgeRecord;
	commitRef: WorkflowKnowledgeCommitRef;
	state: KnowledgeProjection;
	authenticatedCommit: KnowledgeAuthenticatedCommitEvidence;
	durableResult?: DurableStoreCommitResult<KnowledgeProjection, KnowledgeEvent> & {
		projectionDigest: string;
		authenticatedCommit: KnowledgeAuthenticatedCommitEvidence;
	};
}

export interface KnowledgeAuthenticatedReadResult {
	state: KnowledgeProjection;
	eventDigest: string | null;
	projectionDigest: string | null;
	authenticatedCommit: KnowledgeAuthenticatedCommitEvidence | null;
	journalSequence: number;
	journalDigest: string | null;
}

export interface KnowledgeStore {
	commit(request: KnowledgeCommitRequest): Promise<KnowledgeCommitResult>;
	read(): Promise<KnowledgeProjection>;
	readAuthenticated(): Promise<KnowledgeAuthenticatedReadResult>;
	readAuthenticatedCommit(sequence: number): Promise<KnowledgeAuthenticatedCommitEvidence | null>;
	replay(): Promise<readonly KnowledgeEvent[]>;
	recover(): ReturnType<KnowledgeDurableStore["recover"]>;
	history(recordId: string): Promise<readonly KnowledgeRecord[]>;
	recall(input: KnowledgeRecallInput): Promise<readonly KnowledgeRecord[]>;
	/** Revalidate a canonical record before a derived projection may expose it. */
	revalidate?(record: KnowledgeRecord): Promise<boolean>;
}

export interface CanonicalKnowledgeMemoryPort {
	commit(request: KnowledgeCommitRequest): Promise<KnowledgeCommitResult>;
	recall(input: KnowledgeRecallInput): Promise<readonly KnowledgeRecord[]>;
}

/**
 * Expose the canonical knowledge authority to memory/refine integrations without a second durable writer.
 *
 * Args:
 * store: Authenticated canonical knowledge store.
 * Return: Commit/recall port that never accepts transient run state or history.
 */
export function createCanonicalKnowledgeMemoryPort(store: KnowledgeStore): CanonicalKnowledgeMemoryPort {
	return {
		commit: (request) => store.commit(request),
		recall: (input) => store.recall(input),
	};
}

export const createCanonicalKnowledgeMemoryAdapter = createCanonicalKnowledgeMemoryPort;

export interface KnowledgeStoreConstructionInput extends KnowledgeHostValidation {
	durableStore: KnowledgeDurableStore;
	namespace: string;
	receiptContext: WorkflowHostReceiptConsumerContext;
	trustedNow?: () => string;
	/** Host-owned maximum privacy class exposed to recall; callers may only narrow it. */
	privacyCeiling?: () => KnowledgePrivacyClass;
}

const MAX_KNOWLEDGE_REPLAY_EVENTS = 100_000;
const MAX_KNOWLEDGE_RECALL_RESULTS = 10_000;
const MAX_KNOWLEDGE_IDENTIFIER_BYTES = 256;
const MAX_KNOWLEDGE_QUERY_BYTES = 65_536;

function assertBoundedKnowledgeIdentifier(value: string, label: string): void {
	if (new TextEncoder().encode(value).byteLength > MAX_KNOWLEDGE_IDENTIFIER_BYTES)
		throw new Error(`${label} exceeds the bounded identifier size.`);
}

function sameEpoch(left: WorkflowEpochRef, right: WorkflowEpochRef): boolean {
	return left.storeEpoch === right.storeEpoch && left.coordinatorEpoch === right.coordinatorEpoch;
}

function isSafeEpoch(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function assertStoreIdentity(input: KnowledgeStoreConstructionInput): void {
	if (
		input.namespace.length === 0 ||
		input.namespace.includes("/") ||
		input.namespace.includes("\\") ||
		input.durableStore.namespace !== input.namespace ||
		input.durableStore.storeId.length === 0 ||
		typeof input.validateDecision !== "function" ||
		typeof input.validateEvidence !== "function" ||
		typeof input.validateSecretScan !== "function" ||
		typeof input.deriveTombstoneFingerprint !== "function" ||
		input.receiptContext === null ||
		typeof input.receiptContext !== "object" ||
		typeof input.receiptContext.principalAuthorizer?.authorize !== "function" ||
		typeof input.durableStore.commit !== "function" ||
		typeof input.durableStore.read !== "function" ||
		typeof input.durableStore.replay !== "function" ||
		typeof input.durableStore.recover !== "function"
	) {
		throw new Error("Knowledge store is not bound to the injected knowledge durable-store instance.");
	}
	assertBoundedKnowledgeIdentifier(input.namespace, "Knowledge namespace");
}

function sealEventForAuthority(durableStore: KnowledgeDurableStore, event: KnowledgeEvent): KnowledgeEvent {
	return getKnowledgeDurableAuthority(durableStore).sealEvent(event);
}

function replayCanonicalFromAuthority(durableStore: KnowledgeDurableStore): Promise<readonly KnowledgeEvent[]> {
	return getKnowledgeDurableAuthority(durableStore).replayCanonical();
}

function assertRequestIdentity(request: KnowledgeCommitRequest): void {
	if (
		request.mutationId.length === 0 ||
		request.idempotencyKey.length === 0 ||
		request.writerIdentity.length === 0 ||
		request.expectedHead.workflowId.length === 0 ||
		request.leaseRef.writerIdentity !== request.writerIdentity ||
		!sameEpoch(request.leaseRef, request.epochRef) ||
		!sameEpoch(request.expectedHead.epochRef, request.epochRef) ||
		!isSafeEpoch(request.epochRef.storeEpoch) ||
		!isSafeEpoch(request.epochRef.coordinatorEpoch) ||
		!isSafeEpoch(request.knowledgeStoreEpoch)
	) {
		throw new Error("Knowledge mutation identity is invalid.");
	}
	for (const [label, value] of [
		["mutationId", request.mutationId],
		["idempotencyKey", request.idempotencyKey],
		["writerIdentity", request.writerIdentity],
		["workflowId", request.expectedHead.workflowId],
	] as const)
		assertBoundedKnowledgeIdentifier(value, `Knowledge ${label}`);
	if (request.executionKey !== null) assertBoundedKnowledgeIdentifier(request.executionKey, "Knowledge executionKey");
}

function assertKnowledgeIdempotencyKeyDoesNotExposeProposalText(
	idempotencyKey: string,
	proposal: KnowledgeProposal,
): void {
	const sensitiveText = [proposal.title, proposal.statement];
	if (proposal.procedure !== undefined) {
		sensitiveText.push(
			...Object.values(proposal.procedure.inputs),
			...proposal.procedure.steps,
			...proposal.procedure.successChecks,
			...proposal.procedure.failureChecks,
		);
	}
	if (sensitiveText.some((value) => value.length > 0 && idempotencyKey.includes(value)))
		throw new Error("Knowledge idempotency key cannot expose proposal text.");
}

function snapshotCommitRequest(request: KnowledgeCommitRequest): KnowledgeCommitRequest {
	// Host validation deliberately awaits, so retain a detached request snapshot
	// rather than allowing a caller to move the expected head or lease mid-commit.
	return Object.freeze({
		...request,
		proposal: freezeKnowledgeValue(request.proposal),
		expectedHead: freezeKnowledgeValue(request.expectedHead),
		expectedGenerations: freezeKnowledgeValue(request.expectedGenerations),
		leaseRef: freezeKnowledgeValue(request.leaseRef),
		epochRef: freezeKnowledgeValue(request.epochRef),
	});
}

function privacyRank(value: KnowledgePrivacyClass): number {
	return KNOWLEDGE_PRIVACY_CLASSES.indexOf(value);
}

function isRecordVisible(
	record: KnowledgeRecord,
	input: KnowledgeRecallInput,
	namespace: string,
	now: string,
): boolean {
	if (record.status !== "active" || record.applicability.namespace !== namespace) return false;
	if (record.retention.expiresAt !== undefined && Date.parse(record.retention.expiresAt) <= Date.parse(now))
		return false;
	if (record.privacy.class === "restricted" && record.applicability.scope !== "session") return false;
	if (input.kind !== undefined && record.kind !== input.kind) return false;
	if (input.privacyAtMost !== undefined && privacyRank(record.privacy.class) > privacyRank(input.privacyAtMost))
		return false;
	if (input.scope !== undefined) {
		const scopeRank: Record<KnowledgeScope, number> = { session: 0, workspace: 1, user: 2 };
		if (scopeRank[record.applicability.scope] > scopeRank[input.scope]) return false;
	}
	if (record.applicability.scope === "session" && input.sessionId !== record.applicability.sessionId) return false;
	if (record.applicability.scope === "workspace" && input.workspaceId !== record.applicability.workspaceId)
		return false;
	if (record.applicability.scope === "user" && input.userId !== record.applicability.userId) return false;
	if (input.pathPrefix !== undefined && record.applicability.pathPrefix !== undefined) {
		const requested = input.pathPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
		const recordPrefix = record.applicability.pathPrefix.replace(/\\/g, "/").replace(/\/+$/, "");
		if (requested !== recordPrefix && !recordPrefix.startsWith(`${requested}/`)) return false;
	}
	for (const evidenceRef of record.evidenceRefs) {
		const issuedAt = Date.parse(evidenceRef.validationReceipt.issuedAt);
		const validUntil = Date.parse(evidenceRef.validationReceipt.validUntil);
		const current = Date.parse(now);
		if (!Number.isFinite(issuedAt) || !Number.isFinite(validUntil) || current < issuedAt || current > validUntil)
			return false;
	}
	const secretScanIssuedAt = Date.parse(record.privacy.secretScan.issuedAt);
	const secretScanValidUntil = Date.parse(record.privacy.secretScan.validUntil);
	const current = Date.parse(now);
	if (
		!Number.isFinite(secretScanIssuedAt) ||
		!Number.isFinite(secretScanValidUntil) ||
		current < secretScanIssuedAt ||
		current > secretScanValidUntil
	)
		return false;
	return true;
}

async function verifyHostValidation(
	result: KnowledgeHostVerification | null | undefined,
	label: string,
	workflowId: string,
	expectedBindingDigest: string,
	currentStateDigest: string,
	currentRevision: number,
	trustedNow: string,
	epochRef: WorkflowEpochRef,
	consumerContext: WorkflowHostReceiptConsumerContext,
): Promise<WorkflowVerifiedHostReceipt> {
	if (
		result === null ||
		result === undefined ||
		typeof result !== "object" ||
		typeof result.receipt !== "object" ||
		result.receipt === null ||
		typeof result.context !== "object" ||
		result.context === null ||
		result.context !== consumerContext
	)
		throw new Error(`Knowledge ${label} requires a resolver-backed host receipt.`);
	const receipt = await resolveAndVerifyWorkflowHostReceipt({
		context: consumerContext,
		workflowId,
		expectedBindingDigest,
		receipt: result.receipt,
		currentStateDigest,
		currentRevision,
		trustedNow,
	});
	if (
		digestObject(receipt) !== digestObject(result.receipt) ||
		receipt.workflowId !== workflowId ||
		receipt.bindingDigest !== expectedBindingDigest
	)
		throw new Error(`Knowledge ${label} receipt is not bound to the exact admission tuple.`);
	if (receipt.artifactRef.sourceEventSequence !== currentRevision)
		throw new Error(`Knowledge ${label} receipt artifact is not bound to the authenticated source sequence.`);
	await authorizeCapabilityReceipt({
		receipt,
		workflowId,
		bindingDigest: expectedBindingDigest,
		stateDigest: currentStateDigest,
		revision: currentRevision,
		epochRef,
		consumerContext,
	});
	await consumeOneUseReceipt({
		receipt,
		workflowId,
		expectedBindingDigest,
		currentRevision,
		consumerContext,
	});
	return receipt;
}

async function authorizeCapabilityReceipt(input: {
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	bindingDigest: string;
	stateDigest: string;
	revision: number;
	epochRef: WorkflowEpochRef;
	consumerContext: WorkflowHostReceiptConsumerContext;
}): Promise<void> {
	const capabilityBinding = input.receipt.capabilityBinding;
	if (capabilityBinding === undefined) return;
	if (input.receipt.receiptKind !== "capability")
		throw new Error("Knowledge capability authorization requires a capability receipt.");
	if (capabilityBinding.capability !== "workflow_learning_knowledge_promotion")
		throw new Error("Knowledge capability authorization is not for canonical knowledge promotion.");
	const authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput = {
		receipt: input.receipt,
		workflowId: input.workflowId,
		bindingDigest: input.bindingDigest,
		resourceDigest: capabilityBinding.resourceDigest,
		operationDigest: capabilityBinding.operationDigest,
		stateDigest: input.stateDigest,
		revision: input.revision,
		epochRef: input.epochRef,
		capability: capabilityBinding.capability,
		...(capabilityBinding.executionIdentity === null
			? {}
			: { executionIdentity: capabilityBinding.executionIdentity }),
		...(capabilityBinding.sessionId === null ? {} : { sessionId: capabilityBinding.sessionId }),
	};
	const authorization = await input.consumerContext.principalAuthorizer.authorize(authorizationInput);
	if (
		authorization.authenticatedPrincipal.trim().length === 0 ||
		authorization.authenticatedPrincipal !== authorization.keyOwnerPrincipal ||
		authorization.capability !== authorizationInput.capability ||
		authorization.workflowId !== authorizationInput.workflowId ||
		authorization.bindingDigest !== authorizationInput.bindingDigest ||
		authorization.stateDigest !== authorizationInput.stateDigest ||
		authorization.revision !== authorizationInput.revision ||
		digestObject(authorization.epochRef) !== digestObject(authorizationInput.epochRef) ||
		digestObject(authorization.receipt) !== digestObject(authorizationInput.receipt) ||
		authorization.validity.issuedAt !== input.receipt.issuedAt ||
		authorization.validity.validUntil !== input.receipt.validUntil ||
		authorization.executionIdentity !== authorizationInput.executionIdentity ||
		authorization.sessionId !== authorizationInput.sessionId ||
		!/^[0-9a-f]{64}$/.test(authorization.authorizationDigest)
	)
		throw new Error("Knowledge capability authorization is not bound to the authenticated tuple.");
}

async function assertOneUseReceiptWitness(input: {
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	expectedBindingDigest: string;
	consumerContext: WorkflowHostReceiptConsumerContext;
}): Promise<void> {
	if (!input.receipt.oneUse) return;
	const witness = await input.consumerContext.receiptResolver.resolveConsumptionWitness({
		receiptId: input.receipt.receiptId,
		workflowId: input.workflowId,
		expectedBindingDigest: input.expectedBindingDigest,
	});
	if (
		witness.receiptId !== input.receipt.receiptId ||
		witness.workflowId !== input.workflowId ||
		witness.bindingDigest !== input.expectedBindingDigest ||
		!Number.isSafeInteger(witness.consumptionSequence) ||
		witness.consumptionSequence < 1 ||
		!Number.isFinite(Date.parse(witness.consumedAt))
	)
		throw new Error("Knowledge host receipt consumption witness is not bound to the receipt.");
}

async function consumeOneUseReceipt(input: {
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	expectedBindingDigest: string;
	currentRevision: number;
	consumerContext: WorkflowHostReceiptConsumerContext;
}): Promise<void> {
	if (!input.receipt.oneUse) return;
	try {
		await assertOneUseReceiptWitness(input);
		return;
	} catch {
		await input.consumerContext.receiptResolver.consumeIfOneUse({
			receipt: input.receipt,
			workflowId: input.workflowId,
			expectedBindingDigest: input.expectedBindingDigest,
			currentRevision: input.currentRevision,
		});
	}
	await assertOneUseReceiptWitness(input);
}

async function consumeOneUseClockReceipt(input: {
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	expectedBindingDigest: string;
	currentRevision: number;
	consumerContext: WorkflowHostReceiptConsumerContext;
}): Promise<void> {
	if (!input.receipt.oneUse) return;
	try {
		await assertOneUseReceiptWitness(input);
	} catch {
		await input.consumerContext.receiptResolver.consumeIfOneUse({
			receipt: input.receipt,
			workflowId: input.workflowId,
			expectedBindingDigest: input.expectedBindingDigest,
			currentRevision: input.currentRevision,
		});
		await assertOneUseReceiptWitness(input);
		return;
	}
	throw new Error("Knowledge trusted clock receipt was already consumed.");
}

async function verifyPersistedReceipt(input: {
	receipt: WorkflowVerifiedHostReceipt;
	workflowId: string;
	trustedNow: string;
	epochRef: WorkflowEpochRef;
	consumerContext: WorkflowHostReceiptConsumerContext;
}): Promise<void> {
	const receipt = await resolveAndVerifyWorkflowHostReceipt({
		context: input.consumerContext,
		workflowId: input.workflowId,
		expectedBindingDigest: input.receipt.bindingDigest,
		receipt: input.receipt,
		currentStateDigest: input.receipt.stateDigest,
		currentRevision: input.receipt.revision,
		trustedNow: input.trustedNow,
	});
	if (
		digestObject(receipt) !== digestObject(input.receipt) ||
		receipt.workflowId !== input.workflowId ||
		receipt.bindingDigest !== input.receipt.bindingDigest
	)
		throw new Error("Knowledge persisted receipt is not bound to its canonical record.");
	if (receipt.artifactRef.sourceEventSequence !== receipt.revision)
		throw new Error("Knowledge persisted receipt artifact is not bound to its authenticated source sequence.");
	await authorizeCapabilityReceipt({
		receipt,
		workflowId: input.workflowId,
		bindingDigest: input.receipt.bindingDigest,
		stateDigest: input.receipt.stateDigest,
		revision: input.receipt.revision,
		epochRef: input.epochRef,
		consumerContext: input.consumerContext,
	});
	await assertOneUseReceiptWitness({
		receipt,
		workflowId: input.workflowId,
		expectedBindingDigest: input.receipt.bindingDigest,
		consumerContext: input.consumerContext,
	});
}

async function verifySourceArtifact(
	consumerContext: WorkflowHostReceiptConsumerContext,
	artifactRef: WorkflowVerifiedHostReceipt["artifactRef"],
	expectedSourceEventSequence: number,
): Promise<void> {
	if (
		!Number.isSafeInteger(artifactRef.sourceEventSequence) ||
		artifactRef.sourceEventSequence < 1 ||
		artifactRef.sourceEventSequence > expectedSourceEventSequence
	)
		throw new Error("Knowledge source artifact is not bound to the authenticated source event range.");
	const artifact = await consumerContext.artifactResolver.resolve(artifactRef);
	if (
		!artifact.exists ||
		!artifact.envelope.immutable ||
		digestObject(artifact.envelope.ref) !== digestObject(artifactRef) ||
		artifact.verifiedSizeBytes !== artifactRef.sizeBytes ||
		artifact.bytes.byteLength !== artifactRef.sizeBytes ||
		artifact.verifiedDigest !== sha256Hex(artifact.bytes) ||
		(/^[0-9a-f]{64}$/.test(artifactRef.digest) && artifact.verifiedDigest !== artifactRef.digest)
	)
		throw new Error("Knowledge source artifact is not resolver-verified and content-addressed.");
}

async function arePersistedKnowledgeReceiptsVisible(
	record: KnowledgeRecord,
	workflowId: string,
	trustedNow: string,
	epochRef: WorkflowEpochRef,
	consumerContext: WorkflowHostReceiptConsumerContext,
): Promise<boolean> {
	try {
		for (const evidenceRef of record.evidenceRefs)
			for (const artifactRef of evidenceRef.artifactRefs)
				await verifySourceArtifact(consumerContext, artifactRef, evidenceRef.evidenceRevision);
		for (const evidenceRef of record.evidenceRefs)
			await verifyPersistedReceipt({
				receipt: evidenceRef.validationReceipt,
				workflowId,
				trustedNow,
				epochRef,
				consumerContext,
			});
		await verifyPersistedReceipt({
			receipt: record.privacy.secretScan,
			workflowId,
			trustedNow,
			epochRef,
			consumerContext,
		});
		return true;
	} catch {
		return false;
	}
}

function hostBindingDigest(
	label: "decision" | "evidence" | "secret_scan" | "recall_clock",
	input: Pick<KnowledgeCommitRequest, "expectedHead" | "epochRef">,
	proposal: KnowledgeProposal,
	namespace: string,
	trustedNow: string,
	principal?: WorkflowTrustedPrincipal,
	detail?: unknown,
): string {
	return digestObject({
		kind: `knowledge-${label}-admission`,
		proposalDigest: digestObject(proposal),
		workflowId: input.expectedHead.workflowId,
		namespace,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		disposition: "accepted",
		trustedNow,
		principal: principal ?? null,
		detail: detail ?? null,
	});
}

function proposalFromRecord(record: KnowledgeRecord): KnowledgeProposal {
	return {
		proposalId: record.proposalId,
		recordId: record.recordId,
		kind: record.kind,
		title: record.title,
		statement: record.statement,
		...(record.procedure === undefined ? {} : { procedure: record.procedure }),
		provenance: record.provenance,
		applicability: {
			namespace: record.applicability.namespace,
			scope: record.applicability.scope,
			...(record.applicability.sessionId === undefined ? {} : { sessionId: record.applicability.sessionId }),
			...(record.applicability.workspaceId === undefined ? {} : { workspaceId: record.applicability.workspaceId }),
			...(record.applicability.userId === undefined ? {} : { userId: record.applicability.userId }),
			...(record.applicability.pathPrefix === undefined ? {} : { pathPrefix: record.applicability.pathPrefix }),
		},
		privacy: record.privacy,
		retention: record.retention,
		confidence: record.confidence,
		decisionRef: record.decisionRef,
		evidenceRefs: record.evidenceRefs,
		epochRef: record.epochRef,
		action: record.action,
		expectedRevision: record.expectedRevision,
		rollbackRevision: record.rollbackRevision,
		...(record.tombstoneReason === undefined ? {} : { tombstoneReason: record.tombstoneReason }),
	};
}

function buildCommitRef(
	storeId: string,
	proposal: KnowledgeProposal,
	request: KnowledgeCommitRequest,
	sequence: number,
): WorkflowKnowledgeCommitRef {
	const transactionDigest = digestObject({
		baselineDigest: request.baselineDigest,
		decisionRef: proposal.decisionRef,
		evidenceRefs: proposal.evidenceRefs,
		executionKey: request.executionKey,
		expectedGenerations: request.expectedGenerations,
		expectedHead: request.expectedHead,
		idempotencyKey: request.idempotencyKey,
		knowledgeStoreEpoch: request.knowledgeStoreEpoch,
		leaseRef: request.leaseRef,
		mutationId: request.mutationId,
		proposal,
		writerIdentity: request.writerIdentity,
	});
	return {
		knowledgeStoreId: storeId,
		workflowEpochRef: request.epochRef,
		knowledgeStoreEpoch: request.knowledgeStoreEpoch,
		proposalId: proposal.proposalId,
		decisionRef: proposal.decisionRef,
		knowledgeJournalSequence: sequence,
		knowledgeJournalDigest: digestObject({ sequence, storeId, transactionDigest }),
		transactionDigest,
	};
}

function buildRecord(
	proposal: KnowledgeProposal,
	previous: KnowledgeRecord | null,
	commitRef: WorkflowKnowledgeCommitRef,
	now: string,
	rollbackTarget: KnowledgeRecord | null,
	tombstoneFingerprint: string | null,
): KnowledgeRecord {
	const source = rollbackTarget ?? proposal;
	const isRetraction = proposal.action === "retract";
	const record: KnowledgeRecord = {
		...proposal,
		title: isRetraction ? "[retracted]" : source.title,
		statement: isRetraction ? "[retracted]" : source.statement,
		kind: source.kind,
		applicability: structuredClone(source.applicability),
		privacy: structuredClone(source.privacy),
		retention: structuredClone(source.retention),
		revision: (previous?.revision ?? 0) + 1,
		status: isRetraction ? "retracted" : "active",
		contentDigest: "",
		sourceDigest: "",
		commitRef,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
	};
	if (!isRetraction && source.procedure !== undefined) record.procedure = structuredClone(source.procedure);
	if (isRetraction) {
		delete record.procedure;
		const reason = proposal.tombstoneReason ?? "user-forgotten";
		if (tombstoneFingerprint === null) throw new Error("Knowledge tombstones require a host-keyed fingerprint.");
		record.tombstone = {
			reason,
			deletionFingerprint: tombstoneFingerprint,
			proposalDigest: digestObject(proposal),
		};
	}
	const normalizedProposal = proposalFromRecord(record);
	if (isRetraction) {
		record.contentDigest = digestObject({
			kind: record.kind,
			recordId: record.recordId,
			tombstone: record.tombstone,
		});
		record.sourceDigest = record.tombstone!.deletionFingerprint;
	} else {
		record.contentDigest = knowledgeContentDigest(normalizedProposal);
		record.sourceDigest = knowledgeSourceDigest(normalizedProposal.evidenceRefs);
	}
	return freezeKnowledgeValue(record);
}

function assertActionAgainstCurrent(
	proposal: KnowledgeProposal,
	current: KnowledgeRecord | undefined,
	history: readonly KnowledgeRecord[],
): KnowledgeRecord | null {
	if (proposal.action === "create") {
		if (current !== undefined) throw new Error("Knowledge record already exists; use supersession or rollback.");
		return null;
	}
	if (current === undefined) throw new Error("Knowledge revision target does not exist.");
	if (current.status === "retracted") throw new Error("Retracted knowledge is tombstoned and cannot be resurrected.");
	if (proposal.kind !== current.kind) throw new Error("Knowledge revisions cannot change kind.");
	if (proposal.applicability.scope !== current.applicability.scope)
		throw new Error("Knowledge revisions cannot change scope.");
	if (proposal.applicability.workspaceId !== current.applicability.workspaceId)
		throw new Error("Knowledge revisions cannot change workspace binding.");
	if (proposal.applicability.sessionId !== current.applicability.sessionId)
		throw new Error("Knowledge revisions cannot change session binding.");
	if (proposal.applicability.userId !== current.applicability.userId)
		throw new Error("Knowledge revisions cannot change user binding.");
	if (proposal.applicability.pathPrefix !== current.applicability.pathPrefix)
		throw new Error("Knowledge revisions cannot change path binding.");
	if (
		proposal.privacy.class !== current.privacy.class &&
		privacyRank(proposal.privacy.class) < privacyRank(current.privacy.class)
	)
		throw new Error("Knowledge revisions cannot widen privacy.");
	if (proposal.expectedRevision !== current.revision) throw new Error("Knowledge revision CAS is stale.");
	if (
		proposal.action === "supersede" &&
		knowledgeContentDigest(proposal) === current.contentDigest &&
		knowledgeSourceDigest(proposal.evidenceRefs) === current.sourceDigest
	)
		throw new Error("Knowledge supersession is a duplicate no-op.");
	if (proposal.action !== "rollback") return null;
	if (proposal.rollbackRevision === null) throw new Error("Knowledge rollback target is missing.");
	const target = history.find(
		(record) => record.recordId === proposal.recordId && record.revision === proposal.rollbackRevision,
	);
	if (target === undefined) throw new Error("Knowledge rollback target is not in canonical history.");
	if (target.revision === current.revision) throw new Error("Knowledge rollback target is already current.");
	return target;
}

/**
 * Construct a semantic knowledge adapter over an existing authenticated K store.
 *
 * Args:
 * input: Existing authenticated workflow-runtime projection and host validators.
 * Return: Canonical knowledge store; no journal, reducer, or writer is created here.
 */
export function createKnowledgeStore(input: KnowledgeStoreConstructionInput): KnowledgeStore {
	assertStoreIdentity(input);
	const trustedNow = input.trustedNow ?? (() => new Date().toISOString());
	getKnowledgeDurableAuthority(input.durableStore);
	const boundWorkflowId = input.durableStore.workflowId;
	const emptyProjection = (): KnowledgeProjection => ({
		namespace: input.namespace,
		records: {},
		history: [],
		sequence: 0,
		digest: null,
	});

	const replayCanonical = async (): Promise<{ events: readonly KnowledgeEvent[]; state: KnowledgeProjection }> => {
		const rawEvents = await replayCanonicalFromAuthority(input.durableStore);
		if (rawEvents.length > MAX_KNOWLEDGE_REPLAY_EVENTS)
			throw new Error("Knowledge replay exceeds the bounded event history.");
		let state = emptyProjection();
		const events: KnowledgeEvent[] = [];
		for (const rawEvent of rawEvents) {
			const event = validateKnowledgeEvent(rawEvent);
			const authenticatedCommit = await input.durableStore.readAuthenticatedCommit(
				event.record.commitRef.knowledgeJournalSequence,
			);
			if (
				authenticatedCommit === null ||
				authenticatedCommit.sequence !== event.record.commitRef.knowledgeJournalSequence
			)
				throw new Error("Knowledge event is not backed by its authenticated workflow journal sequence.");
			state = reduceKnowledgeEvent(state, event);
			events.push(event);
		}
		return { events: freezeKnowledgeValue(events), state: validateKnowledgeProjection(state) };
	};

	const redactReplay = (events: readonly KnowledgeEvent[], state: KnowledgeProjection): readonly KnowledgeEvent[] => {
		const retractedRecords = new Map(
			Object.values(state.records)
				.filter((record) => record.status === "retracted")
				.map((record) => [record.recordId, record] as const),
		);
		const replayView = events.map((event) => {
			const tombstoneRecord = retractedRecords.get(event.record.recordId);
			if (tombstoneRecord === undefined) return event;
			const redactedRecord = redactKnowledgeRecordForReplay(event.record, tombstoneRecord);
			const redactedPrevious =
				event.previous === null ? null : redactKnowledgeRecordForHistory(event.previous, tombstoneRecord);
			return freezeKnowledgeValue({
				...event,
				record: redactedRecord,
				previous: redactedPrevious,
				previousDigest: redactedPrevious === null ? null : digestObject(redactedPrevious),
				proposalDigest:
					redactedRecord.tombstone === undefined
						? digestObject(knowledgeProposalFromRecord(redactedRecord))
						: redactedRecord.tombstone.proposalDigest,
			});
		});
		return freezeKnowledgeValue(replayView);
	};

	const read = async (): Promise<KnowledgeProjection> => {
		const result = await input.durableStore.read();
		const stored = validateKnowledgeProjection(result.state);
		const rebuilt = await replayCanonical();
		const journalSequence = result.journalSequence ?? result.sequence;
		if (!Number.isSafeInteger(journalSequence) || journalSequence < result.sequence)
			throw new Error("Knowledge projection journal head is not bounded or monotonic.");
		if (
			stored.namespace !== input.namespace ||
			stored.sequence !== result.sequence ||
			stored.digest !== result.projectionDigest ||
			stored.sequence !== rebuilt.state.sequence ||
			stored.digest !== rebuilt.state.digest ||
			digestObject(stored) !== digestObject(rebuilt.state)
		)
			throw new Error("Knowledge projection is not the authenticated canonical chain.");
		return rebuilt.state;
	};

	const readAuthenticated = async (): Promise<KnowledgeAuthenticatedReadResult> => {
		const result = await input.durableStore.read();
		const state = validateKnowledgeProjection(result.state);
		const journalSequence = result.journalSequence ?? result.sequence;
		const journalDigest = result.journalDigest ?? result.digest;
		const latestRecord = Object.values(state.records).reduce<KnowledgeRecord | null>(
			(current, candidate) =>
				current === null ||
				candidate.commitRef.knowledgeJournalSequence > current.commitRef.knowledgeJournalSequence
					? candidate
					: current,
			null,
		);
		const authenticatedCommit =
			latestRecord === null
				? null
				: await input.durableStore.readAuthenticatedCommit(latestRecord.commitRef.knowledgeJournalSequence);
		if (result.projectionDigest !== state.digest)
			throw new Error("Knowledge projection digest is not bound to its canonical state.");
		if (
			authenticatedCommit !== null &&
			(latestRecord === null || authenticatedCommit.sequence !== latestRecord.commitRef.knowledgeJournalSequence)
		)
			throw new Error("Knowledge read evidence sequence is not bound to the canonical knowledge head.");
		return {
			state,
			eventDigest: journalDigest,
			projectionDigest: result.projectionDigest,
			authenticatedCommit,
			journalSequence,
			journalDigest,
		};
	};
	const readAuthenticatedCommit = (sequence: number): Promise<KnowledgeAuthenticatedCommitEvidence | null> =>
		input.durableStore.readAuthenticatedCommit(sequence);
	const revalidate = async (candidate: KnowledgeRecord): Promise<boolean> => {
		try {
			const state = await read();
			const canonical = state.records[candidate.recordId];
			if (canonical === undefined || digestObject(canonical) !== digestObject(candidate)) return false;
			if (canonical.status !== "active") return true;
			const now = trustedNow();
			const current = Date.parse(now);
			if (!Number.isFinite(current)) return false;
			if (canonical.retention.expiresAt !== undefined && Date.parse(canonical.retention.expiresAt) <= current)
				return false;
			return arePersistedKnowledgeReceiptsVisible(
				canonical,
				boundWorkflowId ?? canonical.evidenceRefs[0]?.workflowId ?? canonical.privacy.secretScan.workflowId,
				now,
				input.durableStore.epochRef,
				input.receiptContext,
			);
		} catch {
			return false;
		}
	};

	const replay = async (): Promise<readonly KnowledgeEvent[]> => {
		const rebuilt = await replayCanonical();
		return redactReplay(rebuilt.events, rebuilt.state);
	};

	const commit = async (request: KnowledgeCommitRequest): Promise<KnowledgeCommitResult> => {
		request = snapshotCommitRequest(request);
		assertRequestIdentity(request);
		if (boundWorkflowId !== null && request.expectedHead.workflowId !== boundWorkflowId)
			throw new Error("Knowledge mutation crossed its authenticated workflow boundary.");
		if (
			digestObject(input.durableStore.epochRef) !== digestObject(request.epochRef) ||
			digestObject(input.durableStore.currentLeaseRef()) !== digestObject(request.leaseRef)
		)
			throw new Error("Knowledge mutation lease or epoch is stale.");
		const admissionNow = trustedNow();
		let proposal = validateKnowledgeProposal(request.proposal, { now: admissionNow });
		assertKnowledgeIdempotencyKeyDoesNotExposeProposalText(request.idempotencyKey, proposal);
		if (!sameEpoch(proposal.epochRef, request.epochRef)) throw new Error("Knowledge proposal epoch is stale.");
		if (proposal.applicability.namespace !== input.namespace)
			throw new Error("Knowledge proposal namespace is wrong.");
		if (
			proposal.decisionRef.decisionScope.kind !== "knowledge" ||
			proposal.decisionRef.decisionScope.namespace !== input.namespace
		)
			throw new Error("Knowledge decision reference namespace is wrong.");
		if (proposal.decisionRef.storeEpoch !== request.epochRef.storeEpoch)
			throw new Error("Knowledge decision reference epoch is stale.");
		for (const evidenceRef of proposal.evidenceRefs) {
			if (evidenceRef.workflowId !== request.expectedHead.workflowId)
				throw new Error("Knowledge evidence workflow is wrong.");
			if (evidenceRef.validationReceipt.workflowId !== request.expectedHead.workflowId)
				throw new Error("Knowledge evidence receipt workflow is wrong.");
			for (const artifactRef of evidenceRef.artifactRefs)
				await verifySourceArtifact(input.receiptContext, artifactRef, evidenceRef.evidenceRevision);
		}
		const decisionBindingDigest = hostBindingDigest(
			"decision",
			request,
			proposal,
			input.namespace,
			admissionNow,
			undefined,
			proposal.decisionRef,
		);
		await verifyHostValidation(
			await input.validateDecision(proposal.decisionRef, proposal, {
				workflowId: request.expectedHead.workflowId,
				namespace: input.namespace,
				expectedHead: request.expectedHead,
				epochRef: request.epochRef,
				trustedNow: admissionNow,
				currentStateDigest: request.baselineDigest,
				disposition: "accepted",
				bindingDigest: decisionBindingDigest,
			}),
			"decision",
			request.expectedHead.workflowId,
			decisionBindingDigest,
			request.baselineDigest,
			proposal.decisionRef.revision,
			admissionNow,
			request.epochRef,
			input.receiptContext,
		);
		const secretScanBindingDigest = hostBindingDigest(
			"secret_scan",
			request,
			proposal,
			input.namespace,
			admissionNow,
			undefined,
			proposal.privacy.secretScan,
		);
		const verifiedSecretScan = await verifyHostValidation(
			await input.validateSecretScan(proposal.privacy.secretScan, proposal, {
				workflowId: request.expectedHead.workflowId,
				namespace: input.namespace,
				expectedHead: request.expectedHead,
				epochRef: request.epochRef,
				trustedNow: admissionNow,
				currentStateDigest: request.baselineDigest,
				disposition: "accepted",
				bindingDigest: secretScanBindingDigest,
			}),
			"secret scan",
			request.expectedHead.workflowId,
			secretScanBindingDigest,
			request.baselineDigest,
			Math.max(request.expectedHead.sequence, 1),
			admissionNow,
			request.epochRef,
			input.receiptContext,
		);
		proposal = freezeKnowledgeValue({
			...proposal,
			privacy: { ...proposal.privacy, secretScan: verifiedSecretScan },
		});
		const verifiedEvidenceRefs: KnowledgeProposal["evidenceRefs"] = [];
		for (const evidenceRef of proposal.evidenceRefs) {
			const evidenceBindingDigest = hostBindingDigest(
				"evidence",
				request,
				proposal,
				input.namespace,
				admissionNow,
				undefined,
				evidenceRef,
			);
			const verifiedEvidence = await verifyHostValidation(
				await input.validateEvidence(evidenceRef, proposal, {
					workflowId: request.expectedHead.workflowId,
					namespace: input.namespace,
					expectedHead: request.expectedHead,
					epochRef: request.epochRef,
					trustedNow: admissionNow,
					currentStateDigest: request.baselineDigest,
					disposition: "accepted",
					bindingDigest: evidenceBindingDigest,
				}),
				"evidence",
				request.expectedHead.workflowId,
				evidenceBindingDigest,
				request.baselineDigest,
				evidenceRef.evidenceRevision,
				admissionNow,
				request.epochRef,
				input.receiptContext,
			);
			verifiedEvidenceRefs.push({ ...evidenceRef, validationReceipt: verifiedEvidence });
		}
		proposal = freezeKnowledgeValue({ ...proposal, evidenceRefs: verifiedEvidenceRefs });
		const commitNow = trustedNow();
		validateKnowledgeProposal(proposal, { now: commitNow });
		if (
			Date.parse(proposal.privacy.secretScan.issuedAt) > Date.parse(commitNow) ||
			Date.parse(proposal.privacy.secretScan.validUntil) <= Date.parse(commitNow)
		)
			throw new Error("Knowledge secret-scan receipt is stale before durable commit.");

		const before = await read();
		const durableBefore = await input.durableStore.read();
		const journalSequence = durableBefore.journalSequence ?? durableBefore.sequence;
		const historical = (await replayCanonical()).events.find(
			(event) => event.idempotencyKey === request.idempotencyKey,
		);
		const proposalDigest = digestObject(proposal);
		if (historical !== undefined) {
			if (historical.proposalDigest !== proposalDigest)
				throw new Error("Knowledge idempotency key conflicts with a different proposal.");
			const expectedCommitRef = buildCommitRef(
				input.durableStore.storeId,
				proposal,
				request,
				historical.record.commitRef.knowledgeJournalSequence,
			);
			if (digestObject(expectedCommitRef) !== digestObject(historical.record.commitRef))
				throw new Error("Knowledge idempotency tuple is stale or forged.");
			const authenticatedCommit = await input.durableStore.readAuthenticatedCommit(
				historical.record.commitRef.knowledgeJournalSequence,
			);
			if (authenticatedCommit === null)
				throw new Error("Knowledge replay is missing authenticated commit evidence.");
			return {
				status: "replayed",
				record: freezeKnowledgeValue(historical.record),
				commitRef: freezeKnowledgeValue(historical.record.commitRef),
				state: before,
				authenticatedCommit: freezeKnowledgeValue(authenticatedCommit),
			};
		}
		if (request.expectedHead.sequence !== journalSequence)
			throw new Error("Knowledge mutation head sequence is stale.");
		const current = before.records[proposal.recordId];
		const rollbackTarget = assertActionAgainstCurrent(proposal, current, before.history);
		const sequence = request.expectedHead.sequence + 1;
		const nextRevision = (current?.revision ?? 0) + 1;
		const commitRef = buildCommitRef(input.durableStore.storeId, proposal, request, sequence);
		let tombstoneFingerprint: string | null = null;
		if (proposal.action === "retract") {
			const reason = proposal.tombstoneReason ?? "user-forgotten";
			const tombstoneBindingDigest = digestObject({
				kind: "knowledge-tombstone-fingerprint",
				workflowId: request.expectedHead.workflowId,
				namespace: input.namespace,
				recordId: proposal.recordId,
				revision: nextRevision,
				reason,
				priorContentDigest: current?.contentDigest ?? null,
				proposalDigest,
				expectedHead: request.expectedHead,
				epochRef: request.epochRef,
				trustedNow: admissionNow,
			});
			const opaqueFingerprint = await input.deriveTombstoneFingerprint({
				workflowId: request.expectedHead.workflowId,
				namespace: input.namespace,
				recordId: proposal.recordId,
				revision: nextRevision,
				reason,
				priorContentDigest: current?.contentDigest ?? null,
				proposalDigest,
				epochRef: request.epochRef,
				trustedNow: admissionNow,
				bindingDigest: tombstoneBindingDigest,
				currentStateDigest: before.digest ?? digestObject(before),
				currentRevision: current?.revision ?? 1,
			});
			const verifiedFingerprint = await verifyHostValidation(
				opaqueFingerprint,
				"tombstone fingerprint",
				request.expectedHead.workflowId,
				tombstoneBindingDigest,
				before.digest ?? digestObject(before),
				current?.revision ?? 1,
				admissionNow,
				request.epochRef,
				input.receiptContext,
			);
			if (typeof opaqueFingerprint.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(opaqueFingerprint.fingerprint))
				throw new Error("Knowledge tombstone fingerprint is not an opaque host-keyed digest.");
			if (verifiedFingerprint.bindingDigest !== tombstoneBindingDigest)
				throw new Error("Knowledge tombstone fingerprint receipt is not bound to its exact deletion tuple.");
			if (
				verifiedFingerprint.payloadDigest !==
				digestObject({
					kind: "knowledge-tombstone-fingerprint",
					bindingDigest: tombstoneBindingDigest,
					fingerprint: opaqueFingerprint.fingerprint,
				})
			)
				throw new Error("Knowledge tombstone fingerprint receipt does not bind the opaque fingerprint.");
			tombstoneFingerprint = opaqueFingerprint.fingerprint;
		}
		const record = buildRecord(
			proposal,
			current ?? null,
			commitRef,
			admissionNow,
			rollbackTarget,
			tombstoneFingerprint,
		);
		validateKnowledgeRecord(record);
		const eventProposalDigest =
			record.status === "retracted" ? record.tombstone!.proposalDigest : digestObject(proposalFromRecord(record));
		let event: KnowledgeEvent = freezeKnowledgeValue({
			kind: "knowledge_record_committed",
			idempotencyKey: request.idempotencyKey,
			record,
			previous:
				current === null || current === undefined
					? null
					: proposal.action === "retract"
						? redactKnowledgeRecordForHistory(current, record)
						: current,
			previousDigest: current === null || current === undefined ? null : digestObject(current),
			proposalDigest: eventProposalDigest,
		});
		event = sealEventForAuthority(input.durableStore, event);
		const durableResult = await input.durableStore.commit({
			...request,
			semantic: event,
		});
		if (durableResult.idempotencyConflict)
			throw new Error("Knowledge durable store reported an idempotency conflict.");
		if (
			durableResult.sequence !== sequence ||
			durableResult.head.workflowId !== request.expectedHead.workflowId ||
			durableResult.head.sequence !== durableResult.sequence ||
			durableResult.head.eventDigest !== durableResult.digest ||
			digestObject(durableResult.head.epochRef) !== digestObject(request.epochRef) ||
			durableResult.authenticatedEventDigest !== durableResult.digest
		)
			throw new Error("Knowledge durable store returned an unauthenticated commit binding.");
		const committedEvent = validateKnowledgeEvent(durableResult.event);
		if (
			committedEvent.idempotencyKey !== request.idempotencyKey ||
			committedEvent.proposalDigest !== eventProposalDigest
		)
			throw new Error("Knowledge durable store returned a mismatched commit receipt.");
		if (digestObject(committedEvent.record) !== digestObject(record))
			throw new Error("Knowledge durable store returned a mismatched canonical record.");
		if (committedEvent.record.commitRef.knowledgeJournalSequence !== durableResult.sequence)
			throw new Error("Knowledge durable store returned a mismatched journal sequence.");
		const expectedCommitRef = buildCommitRef(input.durableStore.storeId, proposal, request, durableResult.sequence);
		if (digestObject(committedEvent.record.commitRef) !== digestObject(expectedCommitRef))
			throw new Error("Knowledge durable store returned an unauthenticated transaction binding.");
		const expectedState = reduceKnowledgeEvent(before, committedEvent);
		const returnedState = validateKnowledgeProjection(durableResult.state);
		if (
			durableResult.projectionDigest !== expectedState.digest ||
			digestObject(returnedState) !== digestObject(expectedState) ||
			durableResult.authenticatedCommit.eventDigest !== durableResult.digest ||
			durableResult.authenticatedCommit.sequence !== durableResult.sequence ||
			digestObject(durableResult.authenticatedCommit.epochRef) !== digestObject(request.epochRef)
		)
			throw new Error("Knowledge durable store returned an unauthenticated canonical projection.");
		const finalDurableRead = await input.durableStore.read();
		const finalJournalSequence = finalDurableRead.journalSequence ?? finalDurableRead.sequence;
		const finalJournalDigest = finalDurableRead.journalDigest ?? finalDurableRead.digest;
		const currentLease = input.durableStore.currentLeaseRef();
		if (
			finalJournalSequence !== durableResult.sequence ||
			finalJournalDigest !== durableResult.digest ||
			finalDurableRead.projectionDigest !== durableResult.projectionDigest ||
			digestObject(finalDurableRead.state) !== digestObject(durableResult.state) ||
			digestObject(currentLease) !== digestObject(request.leaseRef)
		)
			throw new Error("Knowledge commit lost its canonical head, epoch, or lease before completion.");
		return {
			status: durableResult.replayed ? "replayed" : "committed",
			record: freezeKnowledgeValue(committedEvent.record),
			commitRef: freezeKnowledgeValue(committedEvent.record.commitRef),
			state: freezeKnowledgeValue(durableResult.state),
			authenticatedCommit: freezeKnowledgeValue(durableResult.authenticatedCommit),
			durableResult,
		};
	};

	return {
		commit,
		read,
		readAuthenticated,
		readAuthenticatedCommit,
		revalidate,
		replay,
		recover: () => input.durableStore.recover(),
		history: async (recordId) => {
			assertBoundedKnowledgeIdentifier(recordId, "Knowledge history record ID");
			const state = await read();
			const tombstone = state.records[recordId]?.status === "retracted" ? state.records[recordId] : undefined;
			return freezeKnowledgeValue(
				state.history
					.filter((record) => record.recordId === recordId)
					.map((record) => (tombstone === undefined ? record : redactKnowledgeRecordForReplay(record, tombstone))),
			);
		},
		recall: async (recallInput) => {
			if (recallInput === null || typeof recallInput !== "object")
				throw new Error("Knowledge recall query is required.");
			const { query, kind } = recallInput;
			if (typeof query !== "string" || query.trim().length === 0)
				throw new Error("Knowledge recall query is required.");
			if (new TextEncoder().encode(query).byteLength > MAX_KNOWLEDGE_QUERY_BYTES)
				throw new Error("Knowledge recall query exceeds the bounded size.");
			if (kind !== undefined && !KNOWLEDGE_KINDS.includes(kind))
				throw new Error("Knowledge recall kind is invalid.");
			if (recallInput.scope !== undefined && !["session", "workspace", "user"].includes(recallInput.scope))
				throw new Error("Knowledge recall scope is invalid.");
			if (recallInput.privacyAtMost !== undefined && !KNOWLEDGE_PRIVACY_CLASSES.includes(recallInput.privacyAtMost))
				throw new Error("Knowledge recall privacy ceiling is invalid.");
			const hostPrivacyCeiling = input.privacyCeiling?.() ?? "public";
			if (!KNOWLEDGE_PRIVACY_CLASSES.includes(hostPrivacyCeiling))
				throw new Error("Host knowledge privacy ceiling is invalid.");
			const effectivePrivacyCeiling = recallInput.privacyAtMost ?? hostPrivacyCeiling;
			if (privacyRank(effectivePrivacyCeiling) > privacyRank(hostPrivacyCeiling))
				throw new Error("Knowledge recall privacy ceiling exceeds the host-derived ceiling.");
			for (const [label, value] of [
				["workspaceId", recallInput.workspaceId],
				["sessionId", recallInput.sessionId],
				["userId", recallInput.userId],
			] as const) {
				if (value !== undefined && (typeof value !== "string" || value.trim().length === 0))
					throw new Error(`Knowledge recall ${label} is invalid.`);
				if (value !== undefined) assertBoundedKnowledgeIdentifier(value, `Knowledge recall ${label}`);
			}
			if (recallInput.scope === "session" && typeof recallInput.sessionId !== "string")
				throw new Error("Session recall requires a session identity.");
			if (recallInput.scope === "workspace" && typeof recallInput.workspaceId !== "string")
				throw new Error("Workspace recall requires a workspace identity.");
			if (recallInput.scope === "user" && typeof recallInput.userId !== "string")
				throw new Error("User recall requires a user identity.");
			if (
				recallInput.principal === null ||
				typeof recallInput.principal !== "object" ||
				!(["interactive_ui", "workflow_command", "headless_signer"] as const).includes(
					recallInput.principal.kind,
				) ||
				typeof recallInput.principal.principalId !== "string" ||
				recallInput.principal.principalId.trim().length === 0 ||
				typeof recallInput.principal.credentialDigest !== "string" ||
				recallInput.principal.credentialDigest.trim().length === 0
			)
				throw new Error("Knowledge recall principal is invalid.");
			assertBoundedKnowledgeIdentifier(recallInput.principal.principalId, "Knowledge recall principal ID");
			assertBoundedKnowledgeIdentifier(
				recallInput.principal.credentialDigest,
				"Knowledge recall principal credential digest",
			);
			if (
				recallInput.trustedClockReceipt === null ||
				typeof recallInput.trustedClockReceipt !== "object" ||
				recallInput.trustedClockReceipt.receiptKind !== "clock"
			)
				throw new Error("Knowledge recall requires an authenticated trusted clock receipt.");
			const workflowId = boundWorkflowId ?? recallInput.trustedClockReceipt.workflowId;
			if (recallInput.trustedClockReceipt.workflowId !== workflowId)
				throw new Error("Knowledge recall clock receipt belongs to a different workflow.");
			if (
				recallInput.pathPrefix !== undefined &&
				(typeof recallInput.pathPrefix !== "string" ||
					recallInput.pathPrefix.trim().length === 0 ||
					new TextEncoder().encode(recallInput.pathPrefix).byteLength > MAX_KNOWLEDGE_IDENTIFIER_BYTES ||
					recallInput.pathPrefix.startsWith("/") ||
					recallInput.pathPrefix.includes("\\") ||
					recallInput.pathPrefix
						.split("/")
						.some((segment) => segment === "" || segment === "." || segment === ".."))
			)
				throw new Error("Knowledge recall path prefix is invalid.");
			const normalizedQuery = query.trim().toLocaleLowerCase();
			const state = await read();
			const trustedNowValue = trustedNow();
			const clockBindingDigest = digestObject({
				kind: "knowledge-recall-clock-admission",
				workflowId,
				namespace: input.namespace,
				query: normalizedQuery,
				kindFilter: kind ?? null,
				scope: recallInput.scope ?? null,
				workspaceId: recallInput.workspaceId ?? null,
				sessionId: recallInput.sessionId ?? null,
				userId: recallInput.userId ?? null,
				pathPrefix: recallInput.pathPrefix ?? null,
				privacyAtMost: effectivePrivacyCeiling,
				principal: recallInput.principal,
			});
			const verifiedClockReceipt = await resolveAndVerifyWorkflowHostReceipt({
				context: input.receiptContext,
				workflowId,
				expectedBindingDigest: clockBindingDigest,
				receipt: recallInput.trustedClockReceipt,
				currentStateDigest: digestObject(state),
				currentRevision: Math.max(state.sequence, 1),
				trustedNow: trustedNowValue,
			});
			if (digestObject(verifiedClockReceipt) !== digestObject(recallInput.trustedClockReceipt))
				throw new Error("Knowledge trusted clock resolver returned a different receipt.");
			await authorizeCapabilityReceipt({
				receipt: verifiedClockReceipt,
				workflowId,
				bindingDigest: clockBindingDigest,
				stateDigest: digestObject(state),
				revision: Math.max(state.sequence, 1),
				epochRef: input.durableStore.epochRef,
				consumerContext: input.receiptContext,
			});
			await consumeOneUseClockReceipt({
				receipt: verifiedClockReceipt,
				workflowId,
				expectedBindingDigest: clockBindingDigest,
				currentRevision: Math.max(state.sequence, 1),
				consumerContext: input.receiptContext,
			});
			const visible: KnowledgeRecord[] = [];
			for (const record of Object.values(state.records)) {
				if (
					!isRecordVisible(
						record,
						{ ...recallInput, query, kind, privacyAtMost: effectivePrivacyCeiling },
						input.namespace,
						trustedNowValue,
					) ||
					!`${record.title} ${record.statement}`.toLocaleLowerCase().includes(normalizedQuery) ||
					!(await arePersistedKnowledgeReceiptsVisible(
						record,
						workflowId,
						trustedNowValue,
						input.durableStore.epochRef,
						input.receiptContext,
					))
				)
					continue;
				visible.push(record);
			}
			if (visible.length > MAX_KNOWLEDGE_RECALL_RESULTS)
				throw new Error("Knowledge recall exceeds the bounded result count.");
			return freezeKnowledgeValue(visible);
		},
	};
}

export const createKnowledge = createKnowledgeStore;
