import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, readFileSync } from "node:fs";
import { open as openFile, unlink as unlinkFile } from "node:fs/promises";
import { join } from "node:path";
import type { GoalState } from "../goals.js";
import type {
	DurableStoreCrashBoundaryHook,
	WorkflowArtifactEnvelope,
	WorkflowArtifactPublisher,
	WorkflowArtifactPublishInput,
	WorkflowArtifactPublishResult,
	WorkflowArtifactReadResult,
	WorkflowArtifactRef,
	WorkflowAuthenticatedMutationTuple,
	WorkflowCapacityGrant,
	WorkflowCommitReturnProof,
	WorkflowDescriptorFs,
	WorkflowDescriptorHandle,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowEventType,
	WorkflowGenerationBinding,
	WorkflowGenerationRotation,
	WorkflowGenerationRotationQuarantineReason,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOutboxAppender,
	WorkflowOutboxAppendInput,
	WorkflowOutboxAppendResult,
	WorkflowOutboxHead,
	WorkflowOutboxRecoveryMetadata,
	WorkflowOutboxRecoveryResult,
	WorkflowOutboxTailStatus,
	WorkflowSemanticHead,
	WorkflowSemanticMutationBinding,
	WorkflowSemanticTransitionPreview,
	WorkflowSnapshotHead,
	WorkflowSnapshotPublisher,
	WorkflowSnapshotPublishInput,
	WorkflowSnapshotPublishResult,
} from "./contracts.js";
import {
	canonicalJsonBytes,
	DurableStoreCrashBoundary,
	digestObject,
	parseCanonicalJsonBytes,
	previewWorkflowSemanticTransition,
	sameWorkflowLeaseIdentity,
	sha256Hex,
} from "./contracts.js";
import {
	applyWorkflowGoalTransition,
	digestWorkflowGoalState,
	type WorkflowGoalTransitionPayload,
} from "./projections.js";

export interface WorkflowJournalKey {
	keyId: string;
	secret: Uint8Array;
	validStoreEpoch: number;
	generationId: string;
}

export interface WorkflowJournalKeyRotationInput {
	workflowId: string;
	previousEpoch: WorkflowEpochRef;
	nextEpoch: WorkflowEpochRef;
	rotationId: string;
	priorHeadDigest: string;
}

export interface WorkflowDescriptorRootAdapters {
	sessionRoot: { rootSessionId: string; descriptorRoot: string; identityDigest: string };
	workflowRoot: { workflowId: string; descriptorRoot: string; identityDigest: string };
}

export interface WorkflowJournalKeyProvider {
	current(workflowId: string, epoch: WorkflowEpochRef): Promise<WorkflowJournalKey>;
	resolve(workflowId: string, keyId: string, epoch: WorkflowEpochRef): Promise<WorkflowJournalKey>;
	rotateGeneration?(input: WorkflowJournalKeyRotationInput): Promise<WorkflowJournalKey>;
}

export interface WorkflowJournalOwnerValidators {
	validateOpen(input: { workflowId: string; rootSessionId: string; epochRef: WorkflowEpochRef }): void;
	validateReplay(event: WorkflowJournalEvent): void;
	validateCommit(input: WorkflowJournalAppendInput): void;
	validateSemanticPreflight(input: {
		payload: WorkflowEventPayload;
		preview: WorkflowSemanticTransitionPreview;
	}): void;
}

export type WorkflowFrameKind = "prepared" | "committed" | "outbox" | "snapshot" | "side_record";

export interface WorkflowFrameGoldenVector {
	name:
		| "prepared_empty_head"
		| "committed_event"
		| "outbox_entry"
		| "rotated_key"
		| "bad_length"
		| "bad_mac"
		| "bad_checksum";
	headerBytesHex: string;
	payloadBytesHex: string;
	hmacHex: string;
	checksumHex: string;
}

export interface WorkflowAppendLease {
	acquire(
		workflowId: string,
		writerIdentity: string,
		coordinatorEpoch: number,
		processIdentity: string,
	): Promise<WorkflowLeaseRef>;
	renew(workflowId: string, writerIdentity: string, coordinatorEpoch: number): Promise<void>;
	assertOwned(input: {
		workflowId: string;
		writerIdentity: string;
		leaseRef: WorkflowLeaseRef;
		epochRef: WorkflowEpochRef;
		rootDigest: string;
		boundary: string;
	}): Promise<void>;
	withExclusiveGuard<T>(
		input: {
			workflowId: string;
			writerIdentity: string;
			leaseRef: WorkflowLeaseRef;
			epochRef: WorkflowEpochRef;
			rootDigest: string;
			boundary: string;
		},
		operation: () => Promise<T>,
	): Promise<T>;
	observe(workflowId: string): Promise<{ writerIdentity: string; leaseRef: WorkflowLeaseRef } | null>;
	rotate(input: {
		workflowId: string;
		expectedWriterIdentity: string;
		expectedLeaseRef: WorkflowLeaseRef;
		nextWriterIdentity: string;
		nextLeaseRef: WorkflowLeaseRef;
	}): Promise<void>;
	release(workflowId: string, writerIdentity: string, coordinatorEpoch: number): Promise<void>;
}

export interface WorkflowDescriptorContext {
	sessionRoot: WorkflowDescriptorRootAdapters["sessionRoot"];
	workflowRoot: WorkflowDescriptorRootAdapters["workflowRoot"];
}

export interface WorkflowDescriptorStorage {
	append(bytes: Uint8Array): Promise<void>;
	read(): Promise<Uint8Array>;
	sync(): Promise<void>;
}

export interface WorkflowJournalOptions {
	artifactRoot: string;
	sessionArtifactRoot: string;
	workflowDir: string;
	descriptorRoots: WorkflowDescriptorRootAdapters;
	storeKind: "workflow" | "knowledge";
	namespace: string;
	storeId: string;
	workflowId: string;
	rootSessionId: string;
	epoch: WorkflowEpochRef;
	writerIdentity: string;
	keyProvider: WorkflowJournalKeyProvider;
	appendLease: WorkflowAppendLease;
	leaseRef: WorkflowLeaseRef;
	descriptorFs: WorkflowDescriptorFs;
	ownerValidators: WorkflowJournalOwnerValidators;
	now(): string;
	successorContextOpener: WorkflowGenerationContextOpener;
}

const WORKFLOW_GOAL_PROJECTION_AUTHORIZATION_BRAND: unique symbol = Symbol("workflow-goal-projection-authorization");

/**
 * Opaque, single-use authority for one journal-authenticated GoalState CAS.
 *
 * The token carries no enumerable or serializable fields. Its authenticated
 * binding lives in a private WeakMap owned by this module and is discarded on
 * process restart.
 */
export interface WorkflowGoalProjectionAuthorization {
	readonly [WORKFLOW_GOAL_PROJECTION_AUTHORIZATION_BRAND]: true;
}

interface WorkflowGoalProjectionAuthorizationMetadata {
	workflowId: string;
	eventSequence: number;
	eventDigest: string;
	expectedHeadDigest: string;
	epochDigest: string;
	eventKind: WorkflowGoalTransitionPayload["kind"];
	goalDeltaDigest: string;
	expectedGoalDigest: string;
	expectedNextGoalDigest: string;
	headGeneration: { value: number };
	isCurrentHeadGeneration: () => boolean;
	isCurrentDurableHead: () => boolean;
	isCurrentDurableAuthority: () => boolean;
	issuedHeadGeneration: number;
}

const workflowGoalProjectionAuthorizationMetadata = new WeakMap<
	WorkflowGoalProjectionAuthorization,
	WorkflowGoalProjectionAuthorizationMetadata
>();
const consumedWorkflowGoalProjectionAuthorizations = new WeakSet<WorkflowGoalProjectionAuthorization>();
interface WorkflowGoalProjectionHeadGeneration {
	value: number;
}

const workflowGoalProjectionHeadGenerations = new WeakMap<WorkflowJournalImpl, WorkflowGoalProjectionHeadGeneration>();
interface WorkflowGoalProjectionDurableAuthority {
	generationId: string;
	epochDigest: string;
	currentHeadDigest: string | null;
}

const workflowGoalProjectionDurableAuthorities = new Map<string, WorkflowGoalProjectionDurableAuthority>();

function workflowGoalProjectionAuthorityKey(
	options: Pick<WorkflowJournalOptions, "artifactRoot" | "workflowId">,
): string {
	return `${options.artifactRoot}\u0000${options.workflowId}`;
}

function bindWorkflowGoalProjectionDurableAuthority(
	options: Pick<WorkflowJournalOptions, "artifactRoot" | "workflowId" | "epoch">,
	generationId: string,
): void {
	const key = workflowGoalProjectionAuthorityKey(options);
	const existing = workflowGoalProjectionDurableAuthorities.get(key);
	if (existing?.generationId === generationId && existing.epochDigest === digestObject(options.epoch)) return;
	workflowGoalProjectionDurableAuthorities.set(key, {
		generationId,
		epochDigest: digestObject(options.epoch),
		currentHeadDigest: null,
	});
}

function updateWorkflowGoalProjectionDurableHead(journal: WorkflowJournalImpl, eventDigest: string | null): void {
	const key = workflowGoalProjectionAuthorityKey(journal.options);
	const authority = workflowGoalProjectionDurableAuthorities.get(key);
	if (
		authority === undefined ||
		authority.generationId !== journal.descriptorContext.generationId ||
		authority.epochDigest !== digestObject(journal.options.epoch)
	)
		return;
	authority.currentHeadDigest = eventDigest;
}

function mintWorkflowGoalProjectionAuthorization(
	metadata: WorkflowGoalProjectionAuthorizationMetadata,
): WorkflowGoalProjectionAuthorization {
	const authorization = Object.freeze({}) as WorkflowGoalProjectionAuthorization;
	workflowGoalProjectionAuthorizationMetadata.set(authorization, Object.freeze({ ...metadata }));
	return authorization;
}

function workflowGoalProjectionHeadGeneration(journal: WorkflowJournalImpl): WorkflowGoalProjectionHeadGeneration {
	const generation = workflowGoalProjectionHeadGenerations.get(journal);
	if (generation === undefined) throw new Error("Workflow goal projection journal authority is not initialized.");
	return generation;
}

/**
 * Checks an opaque token against the exact event and GoalState snapshots it authorizes.
 *
 * Args:
 * authorization: Candidate in-memory authority; callers cannot forge its private WeakMap entry.
 * input: Session identity and the expected/next snapshots supplied to CAS.
 * Return: True only for an unconsumed journal-issued token with exact bindings.
 */
export function validateWorkflowGoalProjectionAuthorization(
	authorization: unknown,
	input: {
		workflowId: string;
		expectedGoal: GoalState;
		nextGoal: GoalState;
	},
): authorization is WorkflowGoalProjectionAuthorization {
	if (
		authorization === null ||
		typeof authorization !== "object" ||
		!workflowGoalProjectionAuthorizationMetadata.has(authorization as WorkflowGoalProjectionAuthorization)
	)
		return false;
	const token = authorization as WorkflowGoalProjectionAuthorization;
	if (consumedWorkflowGoalProjectionAuthorizations.has(token)) return false;
	const metadata = workflowGoalProjectionAuthorizationMetadata.get(token);
	if (metadata === undefined) return false;
	return (
		metadata.workflowId === input.workflowId &&
		metadata.headGeneration.value === metadata.issuedHeadGeneration &&
		metadata.isCurrentHeadGeneration() &&
		metadata.isCurrentDurableHead() &&
		metadata.isCurrentDurableAuthority() &&
		metadata.expectedGoalDigest === digestWorkflowGoalState(input.expectedGoal) &&
		metadata.expectedNextGoalDigest === digestWorkflowGoalState(input.nextGoal)
	);
}

/**
 * Consumes a validated authority exactly once after its GoalState CAS is durable.
 *
 * Args:
 * authorization: Journal-issued authority to consume.
 * input: Session identity and the exact expected/next snapshots that were persisted.
 * Return: True when the authority was valid and transitioned to consumed state.
 */
export function consumeWorkflowGoalProjectionAuthorization(
	authorization: unknown,
	input: {
		workflowId: string;
		expectedGoal: GoalState;
		nextGoal: GoalState;
	},
): authorization is WorkflowGoalProjectionAuthorization {
	if (!validateWorkflowGoalProjectionAuthorization(authorization, input)) return false;
	consumedWorkflowGoalProjectionAuthorizations.add(authorization);
	return true;
}

export interface WorkflowCommitReturnProofStore {
	markPending(input: {
		recordVersion: 1;
		generationId: string;
		mutationId: string;
		workflowId: string;
		expectedSequence: number;
		eventDigest: string;
		expectedHead: WorkflowJournalHead;
		epochRef: WorkflowEpochRef;
		leaseRef: WorkflowLeaseRef;
		writerIdentity: string;
		idempotencyKey: string;
		keyId: string;
		frameMac: string;
		frameChecksum: string;
		recordMac: string;
		recordChecksum: string;
		priorRecordDigest: string | null;
	}): Promise<void>;
	markCommitted(input: {
		recordVersion: 1;
		generationId: string;
		mutationId: string;
		workflowId: string;
		sequence: number;
		eventDigest: string;
		committedFrameDigest: string;
		expectedHead: WorkflowJournalHead;
		epochRef: WorkflowEpochRef;
		leaseRef: WorkflowLeaseRef;
		writerIdentity: string;
		idempotencyKey: string;
		keyId: string;
		frameMac: string;
		frameChecksum: string;
		recordMac: string;
		recordChecksum: string;
		priorRecordDigest: string | null;
	}): Promise<void>;
	markReturned(proof: WorkflowCommitReturnProof): Promise<void>;
	resolve(
		mutationId: string,
	): Promise<{ state: "pending" | "committed" | "returned"; proof: WorkflowCommitReturnProof | null }>;
}

export interface WorkflowGenerationRotationRequest {
	recordVersion: 1;
	generationId: string;
	rotationId: string;
	mutationId: string;
	idempotencyKey: string;
	expectedHeadDigest: string;
	previousEpoch: WorkflowEpochRef;
	nextEpoch: WorkflowEpochRef;
	previousKeyId: string;
	previousGenerationId: string;
	previousFrameMac: string;
	previousFrameChecksum: string;
	previousWriterIdentity: string;
	previousLeaseRef: WorkflowLeaseRef;
	nextLeaseRef: WorkflowLeaseRef;
	generationBinding: WorkflowGenerationBinding;
	activeGenerationManifestRef: WorkflowArtifactRef;
	keyId: string;
	frameMac: string;
	frameChecksum: string;
	recordMac: string;
	recordChecksum: string;
	priorRecordDigest: string | null;
}

export interface WorkflowGenerationRotationRecoveryRecord {
	request: WorkflowGenerationRotationRequest;
	expectedHead: WorkflowJournalHead;
	rotationArtifactRef: WorkflowArtifactRef;
	activeGenerationManifestRef: WorkflowArtifactRef;
	priorRecordDigest: string | null;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple | null;
	state: "prepared" | "lease_transferred" | "fence_committed" | "committed" | "retired" | "quarantined";
	fenceEventSequence: number | null;
	fenceEventDigest: string | null;
	commitReturnProof: WorkflowCommitReturnProof | null;
	rotation: WorkflowGenerationRotation | null;
	quarantineReason: WorkflowGenerationRotationQuarantineReason | null;
	lastCheckpoint: DurableStoreCrashBoundary | null;
	checkpointDigest: string | null;
	sideRecordMac: string;
}

export interface WorkflowActiveGenerationRecord {
	workflowId: string;
	generationId: string;
	manifestRef: WorkflowArtifactRef;
	manifestBytesDigest: string;
	sourceHead: WorkflowJournalHead;
	epochRef: WorkflowEpochRef;
	generationBinding: WorkflowGenerationBinding;
	leaseRef: WorkflowLeaseRef;
	keyId: string;
	frameMac: string;
	frameChecksum: string;
	priorRecordDigest: string | null;
	sideRecordMac: string;
}

export interface WorkflowGenerationRecoveryTuple {
	readonly workflowId: string;
	readonly generationId: string;
	readonly keyId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly writerIdentity: string;
	readonly rootDigest: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly head: WorkflowJournalHead | null;
}

export interface WorkflowJournalRecoveryInspection {
	readonly workflowId: string;
	readonly activeGeneration: WorkflowActiveGenerationRecord;
	readonly rotation: WorkflowGenerationRotationRecoveryRecord;
	readonly previous: WorkflowGenerationRecoveryTuple;
	readonly successor: WorkflowGenerationRecoveryTuple;
	readonly previousKey: WorkflowJournalKey;
	readonly successorKey: WorkflowJournalKey;
	readonly currentHead: WorkflowJournalHead;
	readonly fenceHead: WorkflowJournalHead | null;
}

export interface WorkflowGenerationRotationStore {
	prepare(
		input: WorkflowGenerationRotationRequest & { expectedHead: WorkflowJournalHead },
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowArtifactRef>;
	markLeaseTransferred(
		rotationId: string,
		input: {
			expectedPriorRecordDigest: string | null;
			nextLeaseRef: WorkflowLeaseRef;
			writerIdentity: string;
			epochRef: WorkflowEpochRef;
		},
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<void>;
	markFenceCommitted(
		rotationId: string,
		input: {
			recordVersion: 1;
			generationId: string;
			expectedPriorRecordDigest: string;
			fenceEventSequence: number;
			fenceEventDigest: string;
			commitReturnProof: WorkflowCommitReturnProof;
			keyId: string;
			frameMac: string;
			frameChecksum: string;
			recordMac: string;
			recordChecksum: string;
		},
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<void>;
	selectActiveGenerationManifest(
		rotation: WorkflowGenerationRotation,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<void>;
	commit(input: WorkflowGenerationRotation, hook?: DurableStoreCrashBoundaryHook): Promise<void>;
	retirePreviousGeneration(rotationId: string, hook?: DurableStoreCrashBoundaryHook): Promise<void>;
	quarantine(rotationId: string, reason: WorkflowGenerationRotationQuarantineReason): Promise<void>;
	resolve(rotationId: string): Promise<WorkflowGenerationRotationRecoveryRecord | null>;
	listUnfinished(workflowId: string): Promise<readonly WorkflowGenerationRotationRecoveryRecord[]>;
	readActiveGeneration(workflowId: string): Promise<WorkflowActiveGenerationRecord | null>;
	readRotationForGeneration(generationId: string): Promise<WorkflowGenerationRotationRecoveryRecord | null>;
}

export interface WorkflowJournalAppendInput {
	workflowId: string;
	payload: WorkflowEventPayload;
	expectedHead: WorkflowJournalHead;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	idempotencyKey: string;
	writerIdentity: string;
	executionKey: string | null;
	semanticBinding: WorkflowSemanticMutationBinding;
	returnProofId: string;
	crashHook?: DurableStoreCrashBoundaryHook;
}

export interface WorkflowGoalProjectionAuthorizationRequest {
	eventSequence: number;
	eventDigest: string;
	expectedGoal: GoalState;
	nextGoal?: GoalState;
}

export interface WorkflowJournal {
	append(input: WorkflowJournalAppendInput): Promise<WorkflowJournalEvent>;
	replay(): Promise<readonly WorkflowJournalEvent[]>;
	replayLogicalHistory(): Promise<readonly WorkflowJournalEvent[]>;
	authorizeGoalProjection(
		input: WorkflowGoalProjectionAuthorizationRequest,
	): Promise<WorkflowGoalProjectionAuthorization>;
	inspectRecovery(): Promise<WorkflowJournalRecoveryInspection | null>;
	recover(): Promise<WorkflowJournalRecoveryResult>;
	currentLeaseRef(): WorkflowLeaseRef;
	rotateGeneration(
		input: WorkflowGenerationRotationRequest,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowGenerationRotation>;
	rebindSuccessor(
		context: WorkflowGenerationContext,
		expected: { generationId: string; epochRef: WorkflowEpochRef; head: WorkflowJournalHead },
	): Promise<void>;
}

export interface WorkflowGenerationContext {
	descriptorContext: WorkflowDescriptorContext;
	storage: WorkflowDescriptorStorage;
	returnProofStore: WorkflowCommitReturnProofStore;
	rotationStore: WorkflowGenerationRotationStore;
	replayHead: WorkflowJournalHead;
	seededStateDigest: string;
	appendSuccessorFence(input: {
		workflowId: string;
		predecessorFenceSequence: number;
		predecessorFenceDigest: string;
		expectedHead: WorkflowJournalHead;
		epochRef: WorkflowEpochRef;
		leaseRef: WorkflowLeaseRef;
		writerIdentity: string;
		semanticBinding: WorkflowSemanticMutationBinding;
	}): Promise<{ event: WorkflowJournalEvent; replayHead: WorkflowJournalHead }>;
}

export interface WorkflowGenerationContextOpener {
	openSuccessor(input: {
		workflowId: string;
		rootSessionId: string;
		rotation: WorkflowGenerationRotation;
		predecessorHead: WorkflowJournalHead;
		predecessorRootDigest: string;
	}): Promise<WorkflowGenerationContext>;
}

interface WorkflowGenerationContextBinding {
	generationId: string;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
}

interface WorkflowGenerationContextImplementation extends WorkflowGenerationContext {
	workflowId: string;
	rootSessionId: string;
	rootDigest: string;
	successorKeyId: string;
	successorKeyProvider: WorkflowJournalKeyProvider;
	successorBinding: WorkflowGenerationContextBinding;
	bindSuccessor(input: WorkflowGenerationContextBinding): Promise<void> | void;
}

function isWorkflowGenerationContextImplementation(
	value: WorkflowGenerationContext,
): value is WorkflowGenerationContextImplementation {
	if (!isRecord(value) || !isRecord(value.successorBinding)) return false;
	const binding = value.successorBinding;
	return (
		typeof value.workflowId === "string" &&
		typeof value.rootSessionId === "string" &&
		typeof value.rootDigest === "string" &&
		typeof value.successorKeyId === "string" &&
		value.successorKeyProvider !== null &&
		typeof value.successorKeyProvider === "object" &&
		typeof value.bindSuccessor === "function" &&
		typeof binding.generationId === "string" &&
		isEpochRefValue(binding.epochRef) &&
		isLeaseRefValue(binding.leaseRef) &&
		typeof binding.writerIdentity === "string"
	);
}

async function closeDescriptorContextHandles(
	context: WorkflowDescriptorContext,
	preserve?: WorkflowDescriptorContext,
): Promise<void> {
	const handles: WorkflowDescriptorHandle[] = [];
	if (context.workflow !== preserve?.workflow) handles.push(context.workflow);
	if (context.root !== preserve?.root) handles.push(context.root);
	await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
}

export type WorkflowJournalTailStatus =
	| "complete"
	| "prepared_only"
	| "truncated_prepared"
	| "partial_frame"
	| "partial_committed"
	| "uncertain_committed";

export interface WorkflowJournalRecoveryMetadata {
	status: WorkflowJournalTailStatus;
	sourcePath: string;
	sourceDigest: string;
	sourceSizeBytes: number;
	sequence: number | null;
	epochRef: WorkflowEpochRef | null;
	reason:
		| "none"
		| "tail_truncated"
		| "prepared_without_commit"
		| "committed_without_prepared"
		| "duplicate_sequence"
		| "sequence_chain_break"
		| "commit_return_uncertain"
		| WorkflowGenerationRotationQuarantineReason
		| "invalid_mac"
		| "stale_epoch"
		| "interior_corruption";
}

export type WorkflowJournalRecoveryResult =
	| { quarantined: false; events: readonly WorkflowJournalEvent[]; metadata: WorkflowJournalRecoveryMetadata }
	| { quarantined: true; events: readonly []; metadata: WorkflowJournalRecoveryMetadata };

export const WORKFLOW_FRAME_VERSION = 1 as const;

const WORKFLOW_FIXED_HEADER_BYTES = 64;
const WORKFLOW_FRAME_MAC_BYTES = 32;
const WORKFLOW_FRAME_CHECKSUM_BYTES = 4;
const WORKFLOW_FRAME_KIND_CODE: Readonly<Record<WorkflowFrameKind, number>> = {
	prepared: 1,
	committed: 2,
	outbox: 3,
	snapshot: 4,
	side_record: 5,
};

export interface WorkflowFrameHeader {
	magic: "PWFK" | "PAOB";
	version: typeof WORKFLOW_FRAME_VERSION;
	frameKind: WorkflowFrameKind;
	headerLength: number;
	frameLength: number;
	payloadLength: number;
	keyId: string;
	workflowId: string;
	sequence: number;
	epochRef: WorkflowEpochRef;
	generationId: string;
	frameBindingDigest: string;
}

export interface WorkflowFrameGoldenVector {
	name:
		| "prepared_empty_head"
		| "committed_event"
		| "outbox_entry"
		| "rotated_key"
		| "bad_length"
		| "bad_mac"
		| "bad_checksum";
	headerBytesHex: string;
	payloadBytesHex: string;
	hmacHex: string;
	checksumHex: string;
}

export const WORKFLOW_FRAME_GOLDEN_VECTORS = [
	{
		name: "prepared_empty_head",
		headerBytesHex:
			"5057464b010100400000006600000002000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "de9037ec6a45e475d99afbf9581a7200412bdac60386cae37cf34b136417ec3b",
		checksumHex: "e170f182",
	},
	{
		name: "committed_event",
		headerBytesHex:
			"5057464b010200400000006600000002000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "14ec3a8cf3c698136ddf4346cf6f62556ee752f27986210c4cfe7bc37fa297d4",
		checksumHex: "237531a9",
	},
	{
		name: "outbox_entry",
		headerBytesHex:
			"50414f42010300400000006600000002000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "7d1f093638481d0e30272a5a77e3b7b7cfa9236246d4e9b213179955afb61da6",
		checksumHex: "73687190",
	},
	{
		name: "rotated_key",
		headerBytesHex:
			"5057464b010400400000006600000002000000020000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "4527a79f60ee00194eaf99507bc94483420c4f74898fcb147804a24afa1ee316",
		checksumHex: "524bd1f1",
	},
	{
		name: "bad_length",
		headerBytesHex:
			"5057464b010200400000004200000002000000ff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "b85d3761f36d3229feb2bd55d9efdde7eb5ec225f7206dca2f61e84cfded3638",
		checksumHex: "eba7693f",
	},
	{
		name: "bad_mac",
		headerBytesHex:
			"5057464b010200400000006600000002000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "0000000000000000000000000000000000000000000000000000000000000000",
		checksumHex: "237531a9",
	},
	{
		name: "bad_checksum",
		headerBytesHex:
			"5057464b010200400000006600000002000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
		payloadBytesHex: "7b7d",
		hmacHex: "14ec3a8cf3c698136ddf4346cf6f62556ee752f27986210c4cfe7bc37fa297d4",
		checksumHex: "deadbeef",
	},
] as const satisfies readonly WorkflowFrameGoldenVector[];

export const WORKFLOW_FIXED_GOLDEN_KEY = new TextEncoder().encode("workflow-k-fixed-key-v1");

const WORKFLOW_PRODUCTION_PAOB_GOLDEN_FRAME_HEX =
	"50414f420103004000000066000000020000000100000007000000030288a8cf322e48228bc7ddce0e415ba862518b7ee254c5420f98a457c20a72ccfd2ff0fb7b7dbd74cce57fc2a9912b68c127d15d0033ed0403532822d3f07737acd5993a12484e33d589";

export function computeWorkflowFrameGoldenVector(
	vector: Pick<WorkflowFrameGoldenVector, "name" | "headerBytesHex" | "payloadBytesHex">,
	key: Uint8Array = WORKFLOW_FIXED_GOLDEN_KEY,
): WorkflowFrameGoldenVector {
	const headerBytesHex =
		vector.headerBytesHex.length === WORKFLOW_FIXED_HEADER_BYTES * 2
			? vector.headerBytesHex
			: vector.headerBytesHex.length === WORKFLOW_FIXED_HEADER_BYTES * 2 - 1
				? `${vector.headerBytesHex}0`
				: (() => {
						throw new Error("Workflow golden vector header is not the fixed 64-byte layout.");
					})();
	const bytes = Buffer.concat([Buffer.from(headerBytesHex, "hex"), Buffer.from(vector.payloadBytesHex, "hex")]);
	const hmacHex = createHmac("sha256", key).update(bytes).digest("hex");
	return {
		...vector,
		headerBytesHex,
		hmacHex,
		checksumHex: createHash("sha256")
			.update(Buffer.concat([bytes, Buffer.from(hmacHex, "hex")]))
			.digest("hex")
			.slice(0, 8),
	};
}

export const WORKFLOW_COMPUTED_FRAME_GOLDEN_VECTORS = WORKFLOW_FRAME_GOLDEN_VECTORS.map((vector) =>
	computeWorkflowFrameGoldenVector(vector),
);

export function verifyWorkflowFrameGoldenVectors(): boolean {
	const validNames = new Set(["prepared_empty_head", "committed_event", "outbox_entry", "rotated_key", "bad_length"]);
	for (const vector of WORKFLOW_FRAME_GOLDEN_VECTORS) {
		const computed = computeWorkflowFrameGoldenVector(vector);
		if (
			validNames.has(vector.name) &&
			(computed.hmacHex !== vector.hmacHex ||
				computed.checksumHex !== vector.checksumHex ||
				computed.headerBytesHex.length !== WORKFLOW_FIXED_HEADER_BYTES * 2 ||
				(Number.parseInt(computed.headerBytesHex.slice(16, 24), 16) <
					WORKFLOW_FIXED_HEADER_BYTES +
						Buffer.from(computed.payloadBytesHex, "hex").byteLength +
						WORKFLOW_FRAME_MAC_BYTES +
						WORKFLOW_FRAME_CHECKSUM_BYTES &&
					vector.name !== "bad_length"))
		)
			throw new Error("Workflow fixed-key frame vector drifted.");
		if (vector.name !== "bad_length" && vector.name !== "bad_mac" && vector.name !== "bad_checksum") {
			const frame = Buffer.concat([
				Buffer.from(computed.headerBytesHex, "hex"),
				Buffer.from(computed.payloadBytesHex, "hex"),
				Buffer.from(computed.hmacHex, "hex"),
				Buffer.from(computed.checksumHex, "hex"),
			]);
			const decoded = decodeWorkflowFixedFrames(frame, WORKFLOW_FIXED_GOLDEN_KEY);
			if (
				decoded.length !== 1 ||
				!sameBytes(decoded[0].frameBytes, frame) ||
				!sameBytes(decoded[0].payload, Buffer.from(computed.payloadBytesHex, "hex"))
			)
				throw new Error("Workflow fixed-key frame vector does not round-trip through the executable decoder.");
		} else if (vector.name === "bad_length" || vector.name === "bad_mac" || vector.name === "bad_checksum") {
			const frame = Buffer.concat([
				Buffer.from(vector.headerBytesHex, "hex"),
				Buffer.from(vector.payloadBytesHex, "hex"),
				Buffer.from(vector.hmacHex, "hex"),
				Buffer.from(vector.checksumHex, "hex"),
			]);
			try {
				decodeWorkflowFixedFrames(frame, WORKFLOW_FIXED_GOLDEN_KEY);
			} catch {
				continue;
			}
			throw new Error("Workflow invalid fixed-key frame vector was accepted by the decoder.");
		}
	}
	const productionFrame = encodeWorkflowFixedFrame({
		magic: "PAOB",
		frameKind: "outbox",
		workflowId: "golden-workflow",
		sequence: 1,
		epochRef: { storeEpoch: 7, coordinatorEpoch: 3 },
		generationId: `generation-${"a".repeat(32)}`,
		keyId: "golden-key",
		priorEventDigest: null,
		payloadDigest: sha256Hex(new Uint8Array([0x7b, 0x7d])),
		writerIdentity: "golden-writer",
		payload: new Uint8Array([0x7b, 0x7d]),
		secret: WORKFLOW_FIXED_GOLDEN_KEY,
	});
	if (Buffer.from(productionFrame).toString("hex") !== WORKFLOW_PRODUCTION_PAOB_GOLDEN_FRAME_HEX)
		throw new Error("Workflow PAOB production encoder drifted from its immutable golden frame.");
	return true;
}

function encodeWorkflowFixedFrame(input: {
	magic: "PWFK" | "PAOB";
	frameKind: WorkflowFrameKind;
	workflowId: string;
	sequence: number;
	epochRef: WorkflowEpochRef;
	generationId: string;
	keyId: string;
	priorEventDigest: string | null;
	payloadDigest: string;
	writerIdentity: string;
	payload: Uint8Array;
	secret: Uint8Array;
}): Uint8Array {
	if (!Number.isSafeInteger(input.sequence) || input.sequence < 0 || input.payload.byteLength > 0xffffffff)
		throw new Error("Workflow frame sequence or payload length is not bounded.");
	const header = Buffer.alloc(WORKFLOW_FIXED_HEADER_BYTES);
	header.write(input.magic, 0, 4, "ascii");
	header.writeUInt8(WORKFLOW_FRAME_VERSION, 4);
	header.writeUInt8(WORKFLOW_FRAME_KIND_CODE[input.frameKind], 5);
	header.writeUInt16BE(WORKFLOW_FIXED_HEADER_BYTES, 6);
	header.writeUInt32BE(
		WORKFLOW_FIXED_HEADER_BYTES + input.payload.byteLength + WORKFLOW_FRAME_MAC_BYTES + WORKFLOW_FRAME_CHECKSUM_BYTES,
		8,
	);
	header.writeUInt32BE(input.payload.byteLength, 12);
	header.writeUInt32BE(input.sequence, 16);
	header.writeUInt32BE(input.epochRef.storeEpoch, 20);
	header.writeUInt32BE(input.epochRef.coordinatorEpoch, 24);
	Buffer.from(sha256Hex(input.workflowId), "hex").copy(header, 28, 0, 8);
	Buffer.from(sha256Hex(input.generationId), "hex").copy(header, 36, 0, 8);
	Buffer.from(sha256Hex(input.keyId), "hex").copy(header, 44, 0, 8);
	Buffer.from(
		workflowFrameBindingDigest({
			frameKind: input.frameKind,
			priorEventDigest: input.priorEventDigest,
			payloadDigest: input.payloadDigest,
			writerIdentity: input.writerIdentity,
		}),
		"hex",
	).copy(header, 52, 0, 12);
	const authenticated = Buffer.concat([header, Buffer.from(input.payload)]);
	const mac = createHmac("sha256", input.secret).update(authenticated).digest();
	const checksum = createHash("sha256")
		.update(Buffer.concat([authenticated, mac]))
		.digest()
		.subarray(0, WORKFLOW_FRAME_CHECKSUM_BYTES);
	return new Uint8Array(Buffer.concat([authenticated, mac, checksum]));
}

function decodeWorkflowFixedFrames(
	bytes: Uint8Array,
	secret?: Uint8Array,
): readonly {
	frameBytes: Uint8Array;
	payload: Uint8Array;
	magic: "PWFK" | "PAOB";
	kindCode: number;
	sequence: number;
	storeEpoch: number;
	coordinatorEpoch: number;
	workflowDigest: string;
	generationDigest: string;
	keyDigest: string;
	frameBindingDigest: string;
}[] {
	const frames: {
		frameBytes: Uint8Array;
		payload: Uint8Array;
		magic: "PWFK" | "PAOB";
		kindCode: number;
		sequence: number;
		storeEpoch: number;
		coordinatorEpoch: number;
		workflowDigest: string;
		generationDigest: string;
		keyDigest: string;
		frameBindingDigest: string;
	}[] = [];
	let offset = 0;
	while (offset < bytes.byteLength) {
		if (
			bytes.byteLength - offset <
			WORKFLOW_FIXED_HEADER_BYTES + WORKFLOW_FRAME_MAC_BYTES + WORKFLOW_FRAME_CHECKSUM_BYTES
		)
			throw new Error("workflow-frame-tail-truncated");
		const header = Buffer.from(bytes.subarray(offset, offset + WORKFLOW_FIXED_HEADER_BYTES));
		const magicValue = header.toString("ascii", 0, 4);
		if (
			(magicValue !== "PWFK" && magicValue !== "PAOB") ||
			header.readUInt8(4) !== WORKFLOW_FRAME_VERSION ||
			header.readUInt16BE(6) !== WORKFLOW_FIXED_HEADER_BYTES
		)
			throw new Error("workflow-frame-header");
		const magic: "PWFK" | "PAOB" = magicValue === "PWFK" ? "PWFK" : "PAOB";
		const frameLength = header.readUInt32BE(8);
		const payloadLength = header.readUInt32BE(12);
		if (
			frameLength !==
			WORKFLOW_FIXED_HEADER_BYTES + payloadLength + WORKFLOW_FRAME_MAC_BYTES + WORKFLOW_FRAME_CHECKSUM_BYTES
		)
			throw new Error("workflow-frame-length");
		if (offset + frameLength > bytes.byteLength) throw new Error("workflow-frame-tail-truncated");
		const frameBytes = bytes.slice(offset, offset + frameLength);
		const authenticatedEnd = WORKFLOW_FIXED_HEADER_BYTES + payloadLength;
		const payload = frameBytes.slice(WORKFLOW_FIXED_HEADER_BYTES, authenticatedEnd);
		const macStart = authenticatedEnd;
		const checksumStart = frameLength - WORKFLOW_FRAME_CHECKSUM_BYTES;
		const actualMac = Buffer.from(frameBytes.slice(macStart, checksumStart));
		const expectedMac =
			secret === undefined
				? null
				: createHmac("sha256", secret)
						.update(Buffer.from(frameBytes.slice(0, authenticatedEnd)))
						.digest();
		const actualChecksum = Buffer.from(frameBytes.slice(checksumStart));
		const expectedChecksum = createHash("sha256")
			.update(Buffer.from(frameBytes.slice(0, checksumStart)))
			.digest()
			.subarray(0, WORKFLOW_FRAME_CHECKSUM_BYTES);
		if (
			expectedMac !== null &&
			(!sameFixedBytes(actualMac, expectedMac, WORKFLOW_FRAME_MAC_BYTES) ||
				!sameFixedBytes(actualChecksum, expectedChecksum, WORKFLOW_FRAME_CHECKSUM_BYTES))
		)
			throw new Error("workflow-frame-authentication");
		const keyDigest = Buffer.from(header.subarray(44, 52)).toString("hex");
		frames.push({
			frameBytes,
			payload,
			magic,
			kindCode: header.readUInt8(5),
			sequence: header.readUInt32BE(16),
			storeEpoch: header.readUInt32BE(20),
			coordinatorEpoch: header.readUInt32BE(24),
			workflowDigest: Buffer.from(header.subarray(28, 36)).toString("hex"),
			generationDigest: Buffer.from(header.subarray(36, 44)).toString("hex"),
			keyDigest,
			frameBindingDigest: Buffer.from(header.subarray(52, 64)).toString("hex"),
		});
		offset += frameLength;
	}
	return frames;
}

function assertWorkflowFixedFrameHeaderMatches(
	frameInfo: {
		magic: "PWFK" | "PAOB";
		kindCode: number;
		sequence: number;
		storeEpoch: number;
		coordinatorEpoch: number;
		workflowDigest: string;
		generationDigest: string;
		keyDigest: string;
		frameBindingDigest: string;
	},
	record: {
		workflowId: string;
		generationId?: string;
		keyId?: string;
		sequence: number;
		epochRef: WorkflowEpochRef;
		expectedHead?: { eventDigest: string | null };
		payloadBytes?: readonly number[];
		bytes?: readonly number[];
		writerIdentity?: string;
		frameKind?: WorkflowFrameKind;
		authenticatedTuple?: { generationId: string; keyId: string };
	},
): void {
	const frameKind = record.frameKind ?? "outbox";
	const generationId = record.generationId ?? record.authenticatedTuple?.generationId;
	const keyId = record.keyId ?? record.authenticatedTuple?.keyId;
	const payloadBytes = record.payloadBytes ?? record.bytes;
	if (
		frameInfo.magic !== (frameKind === "outbox" ? "PAOB" : "PWFK") ||
		frameInfo.kindCode !== WORKFLOW_FRAME_KIND_CODE[frameKind] ||
		frameInfo.sequence !== record.sequence ||
		frameInfo.storeEpoch !== record.epochRef.storeEpoch ||
		frameInfo.coordinatorEpoch !== record.epochRef.coordinatorEpoch ||
		frameInfo.workflowDigest !== sha256Hex(record.workflowId).slice(0, 16) ||
		generationId === undefined ||
		keyId === undefined ||
		frameInfo.generationDigest !== sha256Hex(generationId).slice(0, 16) ||
		frameInfo.keyDigest !== sha256Hex(keyId).slice(0, 16) ||
		record.expectedHead === undefined ||
		payloadBytes === undefined ||
		record.writerIdentity === undefined ||
		frameInfo.frameBindingDigest !==
			workflowFrameBindingDigest({
				frameKind,
				priorEventDigest: record.expectedHead.eventDigest,
				payloadDigest: sha256Hex(Uint8Array.from(payloadBytes)),
				writerIdentity: record.writerIdentity,
			})
	)
		throw new Error("workflow-frame-header-binding");
}

function workflowFrameBindingDigest(input: {
	frameKind: WorkflowFrameKind;
	priorEventDigest: string | null;
	payloadDigest: string;
	writerIdentity: string;
}): string {
	return sha256Hex(canonicalJsonBytes(input)).slice(0, 24);
}

export function createWorkflowDescriptorRootAdapters(input: {
	sessionArtifactRoot: string;
	workflowDir: string;
	rootSessionId: string;
	workflowId: string;
	sessionIdentityDigest: string;
	workflowIdentityDigest: string;
}): WorkflowDescriptorRootAdapters {
	if (
		input.rootSessionId.length === 0 ||
		input.workflowId.length === 0 ||
		input.sessionIdentityDigest.length === 0 ||
		input.workflowIdentityDigest.length === 0 ||
		input.workflowDir !== `${input.sessionArtifactRoot}/workflows/${input.workflowId}`
	) {
		throw new Error("Descriptor adapters must be split, validated, and rooted at the opened session descriptor.");
	}
	return {
		sessionRoot: {
			rootSessionId: input.rootSessionId,
			descriptorRoot: input.sessionArtifactRoot,
			identityDigest: input.sessionIdentityDigest,
		},
		workflowRoot: {
			workflowId: input.workflowId,
			descriptorRoot: input.workflowDir,
			identityDigest: input.workflowIdentityDigest,
		},
	};
}

export function deriveWorkflowGenerationId(input: {
	workflowId: string;
	nextEpoch: WorkflowEpochRef;
	rotationId: string;
	priorHeadDigest: string;
}): string {
	return `generation-${digestObject(input).slice(0, 32)}`;
}

export function deriveWorkflowGenerationPath(generationId: string): string {
	if (!/^generation-[0-9a-f]{32}$/.test(generationId))
		throw new Error("Workflow generation ID is not a canonical host-derived identity.");
	return `generations/${generationId}`;
}

function workflowActiveGenerationManifestBytesDigest(
	record: Omit<WorkflowActiveGenerationRecord, "manifestBytesDigest" | "sideRecordMac"> & {
		manifestBytesDigest?: string;
		sideRecordMac?: string;
	},
): string {
	return sha256Hex(
		canonicalJsonBytes({
			...record,
			manifestRef: { ...record.manifestRef, digest: "", sizeBytes: 0 },
			manifestBytesDigest: "",
			sideRecordMac: "",
		}),
	);
}

function buildAuthenticatedActiveGenerationRecord(input: {
	record: Omit<WorkflowActiveGenerationRecord, "manifestRef" | "sideRecordMac"> & { manifestRef: WorkflowArtifactRef };
	secret: Uint8Array;
}): { record: WorkflowActiveGenerationRecord; bytes: Uint8Array } {
	let manifestRef: WorkflowArtifactRef = { ...input.record.manifestRef, sizeBytes: 0 };
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const withoutMac: WorkflowActiveGenerationRecord = { ...input.record, manifestRef, sideRecordMac: "" };
		const record: WorkflowActiveGenerationRecord = {
			...withoutMac,
			sideRecordMac: sideRecordMac(withoutMac, input.secret),
		};
		const bytes = canonicalJsonBytes(record);
		if (bytes.byteLength === manifestRef.sizeBytes) return { record, bytes };
		manifestRef = { ...manifestRef, sizeBytes: bytes.byteLength };
	}
	throw new Error("Active-generation manifest size did not converge to its canonical persisted bytes.");
}

function workflowActiveGenerationRecordUnsigned(record: WorkflowActiveGenerationRecord): Omit<
	WorkflowActiveGenerationRecord,
	"sideRecordMac"
> & {
	sideRecordMac: string;
} {
	return {
		workflowId: record.workflowId,
		generationId: record.generationId,
		manifestRef: record.manifestRef,
		manifestBytesDigest: record.manifestBytesDigest,
		sourceHead: record.sourceHead,
		epochRef: record.epochRef,
		generationBinding: record.generationBinding,
		leaseRef: record.leaseRef,
		keyId: record.keyId,
		frameMac: record.frameMac,
		frameChecksum: record.frameChecksum,
		priorRecordDigest: record.priorRecordDigest,
		sideRecordMac: "",
	};
}
type EventRecord = Record<string, unknown>;

function isRecord(value: unknown): value is EventRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: EventRecord, keys: readonly string[]): boolean {
	const expected = new Set(keys);
	return Object.keys(record).length === expected.size && Object.keys(record).every((key) => expected.has(key));
}

function exactRecord(
	value: unknown,
	keys: readonly string[],
	checks: Readonly<Record<string, (field: unknown) => boolean>>,
): boolean {
	if (!isRecord(value) || !exactKeys(value, keys)) return false;
	return Object.entries(checks).every(([key, check]) => check(value[key]));
}

const isStringValue = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isNullableStringValue = (value: unknown): boolean => value === null || isStringValue(value);
const isDigestValue = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isNullableDigestValue = (value: unknown): boolean => value === null || isDigestValue(value);
const isSafeIntegerValue = (value: unknown): value is number => Number.isSafeInteger(value);

function isArtifactRefValue(value: unknown): value is WorkflowArtifactRef {
	return exactRecord(value, ["artifactId", "relativePath", "digest", "sizeBytes", "sourceEventSequence"], {
		artifactId: isStringValue,
		relativePath: (field) =>
			typeof field === "string" &&
			field.length > 0 &&
			!field.startsWith("/") &&
			!field.includes("\\") &&
			!field.includes("\0") &&
			!/^[A-Za-z]:/.test(field) &&
			field.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
		digest: isDigestValue,
		sizeBytes: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
		sourceEventSequence: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
	});
}

function isWorkflowArtifactEnvelopeValue(value: unknown): value is WorkflowArtifactEnvelope {
	return exactRecord(value, ["ref", "payloadKind", "codec", "immutable"], {
		ref: isArtifactRefValue,
		payloadKind: (field) =>
			field === "handoff" ||
			field === "evidence" ||
			field === "process_identity" ||
			field === "effect_result" ||
			field === "recovery_finding" ||
			field === "barrier",
		codec: (field) => field === "canonical_json" || field === "utf8" || field === "binary",
		immutable: (field) => field === true,
	});
}

function isEpochRefValue(value: unknown): value is WorkflowEpochRef {
	if (!isRecord(value) || !exactKeys(value, ["storeEpoch", "coordinatorEpoch"])) return false;
	const storeEpoch = value.storeEpoch;
	const coordinatorEpoch = value.coordinatorEpoch;
	return (
		Number.isSafeInteger(storeEpoch) &&
		Number.isSafeInteger(coordinatorEpoch) &&
		(storeEpoch as number) > 0 &&
		(coordinatorEpoch as number) > 0
	);
}

function isLeaseRefValue(value: unknown): value is WorkflowLeaseRef {
	if (
		!isRecord(value) ||
		!exactKeys(value, [
			"storeEpoch",
			"coordinatorEpoch",
			"leaseId",
			"acquisitionEventSequence",
			"processIdentity",
			"rootDigest",
			"writerIdentity",
			"acquiredAt",
			"expiresAt",
		])
	)
		return false;
	const acquisitionEventSequence = value.acquisitionEventSequence;
	return (
		isEpochRefValue({ storeEpoch: value.storeEpoch, coordinatorEpoch: value.coordinatorEpoch }) &&
		typeof value.leaseId === "string" &&
		value.leaseId.length > 0 &&
		Number.isSafeInteger(acquisitionEventSequence) &&
		(acquisitionEventSequence as number) > 0 &&
		typeof value.processIdentity === "string" &&
		value.processIdentity.length > 0 &&
		typeof value.rootDigest === "string" &&
		value.rootDigest.length > 0 &&
		typeof value.writerIdentity === "string" &&
		value.writerIdentity.length > 0 &&
		typeof value.acquiredAt === "string" &&
		typeof value.expiresAt === "string" &&
		Number.isFinite(Date.parse(value.acquiredAt)) &&
		Number.isFinite(Date.parse(value.expiresAt)) &&
		Date.parse(value.expiresAt) > Date.parse(value.acquiredAt)
	);
}

function isWorkflowJournalHeadValue(value: unknown): value is WorkflowJournalHead {
	return exactRecord(value, ["workflowId", "sequence", "eventDigest", "epochRef"], {
		workflowId: isStringValue,
		sequence: (field) => isSafeIntegerValue(field) && field >= 0,
		eventDigest: isNullableDigestValue,
		epochRef: isEpochRefValue,
	});
}

const PROGRESS_REJECTED_RENEWAL_SIGNALS = [
	"worker_activity",
	"timestamps",
	"token_use",
	"transcript_growth",
	"heartbeats",
	"test_counts",
	"reports",
	"status_rewrites",
	"task_splitting",
	"nonauthoritative_artifacts",
	"no_op_events",
] as const;

function isProgressRejectedRenewalSignalsValue(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length === PROGRESS_REJECTED_RENEWAL_SIGNALS.length &&
		value.every((signal, index) => signal === PROGRESS_REJECTED_RENEWAL_SIGNALS[index])
	);
}

function isProgressPredicateValue(value: unknown): boolean {
	return exactRecord(
		value,
		["schemaVersion", "kind", "taskIds", "requiredOutcome", "rejectedRenewalSignals", "predicateDigest"],
		{
			schemaVersion: (field) => field === 1,
			kind: (field) => field === "task_terminal",
			taskIds: (field) => Array.isArray(field) && field.length > 0 && field.every(isStringValue),
			requiredOutcome: (field) => field === "accepted",
			rejectedRenewalSignals: isProgressRejectedRenewalSignalsValue,
			predicateDigest: isDigestValue,
		},
	);
}

function isAuthoritativeProgressCutValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"schemaVersion",
			"workflowId",
			"epochRef",
			"goalRevisionDigest",
			"boundaryRevisionDigest",
			"journalHead",
			"nextGate",
			"readyTaskIds",
			"terminalTaskIds",
			"readyTaskSetDigest",
			"unresolvedGatingObligationDigests",
			"unresolvedEffectDigests",
			"lastAuthenticatedOutcomeEvidenceRef",
			"lastAuthoritativeProgressAt",
			"semanticProgressDigest",
		],
		{
			schemaVersion: (field) => field === 1,
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			goalRevisionDigest: isDigestValue,
			boundaryRevisionDigest: isDigestValue,
			journalHead: isWorkflowJournalHeadValue,
			nextGate: isStringValue,
			readyTaskIds: (field) => Array.isArray(field) && field.length > 0 && field.every(isStringValue),
			terminalTaskIds: (field) => Array.isArray(field) && field.every(isStringValue),
			readyTaskSetDigest: isDigestValue,
			unresolvedGatingObligationDigests: (field) => Array.isArray(field) && field.every(isDigestValue),
			unresolvedEffectDigests: (field) => Array.isArray(field) && field.every(isDigestValue),
			lastAuthenticatedOutcomeEvidenceRef: (field) => field === null || isArtifactRefValue(field),
			lastAuthoritativeProgressAt: (field) => typeof field === "string" && Number.isFinite(Date.parse(field)),
			semanticProgressDigest: isDigestValue,
		},
	);
}

function isProgressLeaseValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"schemaVersion",
			"leaseId",
			"workflowId",
			"epochRef",
			"baseJournalHead",
			"progressCutDigest",
			"baseSemanticProgressDigest",
			"expectedTransitionPredicate",
			"expectedTransitionPredicateDigest",
			"adversarialReviewDigest",
			"owner",
			"acquiredAt",
			"deadline",
			"wakeObligationId",
			"recoveryAttempt",
			"leaseDigest",
		],
		{
			schemaVersion: (field) => field === 1,
			leaseId: isStringValue,
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			baseJournalHead: isWorkflowJournalHeadValue,
			progressCutDigest: isDigestValue,
			baseSemanticProgressDigest: isDigestValue,
			expectedTransitionPredicate: isProgressPredicateValue,
			expectedTransitionPredicateDigest: isDigestValue,
			adversarialReviewDigest: isDigestValue,
			owner: isStringValue,
			acquiredAt: (field) => typeof field === "string" && Number.isFinite(Date.parse(field)),
			deadline: (field) => typeof field === "string" && Number.isFinite(Date.parse(field)),
			wakeObligationId: isStringValue,
			recoveryAttempt: (field) => isSafeIntegerValue(field) && field >= 0,
			leaseDigest: isDigestValue,
		},
	);
}

function isProgressStallRecordValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"schemaVersion",
			"stallId",
			"workflowId",
			"epochRef",
			"leaseId",
			"wakeObligationId",
			"observedHead",
			"baseSemanticProgressDigest",
			"observedSemanticProgressDigest",
			"readyTaskSetDigest",
			"stalledAt",
			"reason",
			"recoveryAttempt",
			"stallDigest",
		],
		{
			schemaVersion: (field) => field === 1,
			stallId: isStringValue,
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			leaseId: isStringValue,
			wakeObligationId: isStringValue,
			observedHead: isWorkflowJournalHeadValue,
			baseSemanticProgressDigest: isDigestValue,
			observedSemanticProgressDigest: isDigestValue,
			readyTaskSetDigest: isDigestValue,
			stalledAt: (field) => typeof field === "string" && Number.isFinite(Date.parse(field)),
			reason: (field) => field === "progress_lease_deadline_unchanged",
			recoveryAttempt: (field) => isSafeIntegerValue(field) && field >= 1,
			stallDigest: isDigestValue,
		},
	);
}

function isProgressSourceOutcomeValue(value: unknown): boolean {
	return exactRecord(
		value,
		["eventSequence", "eventDigest", "attemptId", "taskId", "outcomeDigest", "evidenceDigests"],
		{
			eventSequence: (field) => isSafeIntegerValue(field) && field > 0,
			eventDigest: isDigestValue,
			attemptId: isStringValue,
			taskId: isStringValue,
			outcomeDigest: isDigestValue,
			evidenceDigests: (field) => Array.isArray(field) && field.length > 0 && field.every(isDigestValue),
		},
	);
}

function isExternalBlockerRecordValue(value: unknown): boolean {
	if (
		!exactRecord(
			value,
			[
				"schemaVersion",
				"blockerId",
				"workflowId",
				"epochRef",
				"goalRevisionDigest",
				"dependencyId",
				"conditionDigest",
				"requiredChange",
				"owner",
				"resumeEventKind",
				"resumePredicateDigest",
				"earliestRetryAt",
				"evidenceRefs",
				"recordedAt",
				"blockerDigest",
			],
			{
				schemaVersion: (field) => field === 1,
				blockerId: isDigestValue,
				workflowId: isStringValue,
				epochRef: isEpochRefValue,
				goalRevisionDigest: isDigestValue,
				dependencyId: isStringValue,
				conditionDigest: isDigestValue,
				requiredChange: isStringValue,
				owner: (field) =>
					field === "workflow_host" ||
					field === "resource_host" ||
					field === "capability_host" ||
					field === "external",
				resumeEventKind: isStringValue,
				resumePredicateDigest: isDigestValue,
				earliestRetryAt: (field) => field === null || isFiniteDateStringValue(field),
				evidenceRefs: isArtifactRefArray,
				recordedAt: isFiniteDateStringValue,
				blockerDigest: isDigestValue,
			},
		)
	)
		return false;
	const record = value as Record<string, unknown>;
	const { blockerDigest, ...withoutDigest } = record;
	return blockerDigest === digestObject(withoutDigest);
}

function isExternalBlockerResolutionValue(value: unknown): boolean {
	if (
		!exactRecord(
			value,
			[
				"schemaVersion",
				"workflowId",
				"blockerId",
				"blockerDigest",
				"epochRef",
				"resumePredicateDigest",
				"eventKind",
				"eventDigest",
				"observedAt",
				"resolutionDigest",
			],
			{
				schemaVersion: (field) => field === 1,
				workflowId: isStringValue,
				blockerId: isDigestValue,
				blockerDigest: isDigestValue,
				epochRef: isEpochRefValue,
				resumePredicateDigest: isDigestValue,
				eventKind: isStringValue,
				eventDigest: isDigestValue,
				observedAt: isFiniteDateStringValue,
				resolutionDigest: isDigestValue,
			},
		)
	)
		return false;
	const resolution = value as Record<string, unknown>;
	const { resolutionDigest, ...withoutDigest } = resolution;
	return resolutionDigest === digestObject(withoutDigest);
}

function isCheckpointBudgetRequiredStateValue(value: unknown): boolean {
	return exactRecord(value, ["valueId", "type", "classification"], {
		valueId: isStringValue,
		type: isStringValue,
		classification: (field) => field === "durable_fact" || field === "artifact_ref",
	});
}

function isCheckpointBudgetRequiredStateArrayValue(value: unknown): boolean {
	return Array.isArray(value) && value.length <= 256 && value.every(isCheckpointBudgetRequiredStateValue);
}

function isCheckpointBudgetRetainedValueValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"valueId",
			"type",
			"bytes",
			"classification",
			"representation",
			"digest",
			"artifactRef",
			"reasonCode",
			"required",
		],
		{
			valueId: isStringValue,
			type: isStringValue,
			bytes: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			classification: (field) =>
				[
					"durable_fact",
					"artifact_ref",
					"transient_tool_output",
					"transient_dataframe",
					"transient_log_tail",
					"reproducible_cache",
				].includes(String(field)),
			representation: (field) => ["durable", "transient", "unavailable"].includes(String(field)),
			digest: isNullableDigestValue,
			artifactRef: (field) => field === null || isArtifactRefValue(field),
			reasonCode: isNullableStringValue,
			required: (field) => field === true || field === false,
		},
	);
}

function isCheckpointBudgetRetainedValueArrayValue(value: unknown): boolean {
	return Array.isArray(value) && value.length <= 256 && value.every(isCheckpointBudgetRetainedValueValue);
}

function isWorkflowSnapshotHeadValue(value: unknown): value is WorkflowSnapshotHead {
	if (!isRecord(value)) return false;
	return exactRecord(value, ["workflowId", "sequence", "sourceEventDigest", "stateDigest", "epochRef"], {
		workflowId: isStringValue,
		sequence: (field) => isSafeIntegerValue(field) && field >= 0,
		sourceEventDigest: (field) =>
			isSafeIntegerValue(value.sequence) && (value.sequence === 0 ? field === null : isDigestValue(field)),
		stateDigest: isNullableDigestValue,
		epochRef: isEpochRefValue,
	});
}

function isWorkflowOutboxHeadValue(value: unknown): value is WorkflowOutboxHead {
	return exactRecord(value, ["workflowId", "sequence", "eventDigest", "entryDigest", "epochRef"], {
		workflowId: isStringValue,
		sequence: (field) => isSafeIntegerValue(field) && field >= 0,
		eventDigest: isNullableDigestValue,
		entryDigest: isNullableDigestValue,
		epochRef: isEpochRefValue,
	});
}

function isWorkflowGenerationBindingValue(value: unknown): value is WorkflowGenerationBinding {
	if (
		!exactRecord(value, ["writerIdentity", "processGenerationId", "ownerIdentity"], {
			writerIdentity: isStringValue,
			processGenerationId: isStringValue,
			ownerIdentity: isStringValue,
		})
	)
		return false;
	const binding = value as WorkflowGenerationBinding;
	return binding.ownerIdentity === binding.writerIdentity;
}

function isWorkflowActiveGenerationRecordValue(value: unknown): value is WorkflowActiveGenerationRecord {
	return exactRecord(
		value,
		[
			"workflowId",
			"generationId",
			"manifestRef",
			"manifestBytesDigest",
			"sourceHead",
			"epochRef",
			"generationBinding",
			"leaseRef",
			"keyId",
			"frameMac",
			"frameChecksum",
			"priorRecordDigest",
			"sideRecordMac",
		],
		{
			workflowId: isStringValue,
			generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			manifestRef: isArtifactRefValue,
			manifestBytesDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			sourceHead: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			generationBinding: isWorkflowGenerationBindingValue,
			leaseRef: isLeaseRefValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			priorRecordDigest: isNullableDigestValue,
			sideRecordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		},
	);
}

function isDurableStoreCrashBoundaryValue(value: unknown): boolean {
	return typeof value === "string" && Object.values(DurableStoreCrashBoundary).includes(value as never);
}

function isWorkflowGenerationRotationRequestValue(value: unknown): value is WorkflowGenerationRotationRequest {
	return exactRecord(
		value,
		[
			"recordVersion",
			"generationId",
			"rotationId",
			"mutationId",
			"idempotencyKey",
			"expectedHeadDigest",
			"previousEpoch",
			"nextEpoch",
			"previousKeyId",
			"previousGenerationId",
			"previousFrameMac",
			"previousFrameChecksum",
			"previousWriterIdentity",
			"previousLeaseRef",
			"nextLeaseRef",
			"generationBinding",
			"activeGenerationManifestRef",
			"keyId",
			"frameMac",
			"frameChecksum",
			"recordMac",
			"recordChecksum",
			"priorRecordDigest",
		],
		{
			recordVersion: (field) => field === 1,
			generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			rotationId: isStringValue,
			mutationId: isStringValue,
			idempotencyKey: isStringValue,
			expectedHeadDigest: isDigestValue,
			previousEpoch: isEpochRefValue,
			nextEpoch: isEpochRefValue,
			previousKeyId: isStringValue,
			previousGenerationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			previousFrameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			previousFrameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			previousWriterIdentity: isStringValue,
			previousLeaseRef: isLeaseRefValue,
			nextLeaseRef: isLeaseRefValue,
			generationBinding: isWorkflowGenerationBindingValue,
			activeGenerationManifestRef: isArtifactRefValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			priorRecordDigest: isNullableDigestValue,
		},
	);
}

function isWorkflowGenerationRotationValue(value: unknown): value is WorkflowGenerationRotation {
	return exactRecord(
		value,
		[
			"recordVersion",
			"generationId",
			"rotationId",
			"mutationId",
			"idempotencyKey",
			"expectedHead",
			"previousEpoch",
			"nextEpoch",
			"previousWriterIdentity",
			"previousLeaseRef",
			"nextLeaseRef",
			"generationBinding",
			"status",
			"fenceEventSequence",
			"fenceEventDigest",
			"activeGenerationManifestRef",
			"priorRecordDigest",
			"keyId",
			"frameMac",
			"frameChecksum",
			"recordMac",
			"recordChecksum",
			"rotationArtifactRef",
		],
		{
			recordVersion: (field) => field === 1,
			generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			rotationId: isStringValue,
			mutationId: isStringValue,
			idempotencyKey: isStringValue,
			expectedHead: isWorkflowJournalHeadValue,
			previousEpoch: isEpochRefValue,
			nextEpoch: isEpochRefValue,
			previousWriterIdentity: isStringValue,
			previousLeaseRef: isLeaseRefValue,
			nextLeaseRef: isLeaseRefValue,
			generationBinding: isWorkflowGenerationBindingValue,
			status: (field) => field === "committed" || field === "quarantined",
			fenceEventSequence: (field) => isSafeIntegerValue(field) && field > 0,
			fenceEventDigest: isDigestValue,
			activeGenerationManifestRef: isArtifactRefValue,
			priorRecordDigest: isNullableDigestValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			rotationArtifactRef: isArtifactRefValue,
		},
	);
}

function isWorkflowGenerationRotationRecoveryRecordValue(
	value: unknown,
): value is WorkflowGenerationRotationRecoveryRecord {
	return exactRecord(
		value,
		[
			"request",
			"expectedHead",
			"rotationArtifactRef",
			"activeGenerationManifestRef",
			"priorRecordDigest",
			"authenticatedTuple",
			"state",
			"fenceEventSequence",
			"fenceEventDigest",
			"commitReturnProof",
			"rotation",
			"quarantineReason",
			"lastCheckpoint",
			"checkpointDigest",
			"sideRecordMac",
		],
		{
			request: isWorkflowGenerationRotationRequestValue,
			expectedHead: isWorkflowJournalHeadValue,
			rotationArtifactRef: isArtifactRefValue,
			activeGenerationManifestRef: isArtifactRefValue,
			priorRecordDigest: isNullableDigestValue,
			authenticatedTuple: (field) => field === null || isWorkflowAuthenticatedMutationTupleValue(field),
			state: (field) =>
				field === "prepared" ||
				field === "lease_transferred" ||
				field === "fence_committed" ||
				field === "committed" ||
				field === "retired" ||
				field === "quarantined",
			fenceEventSequence: (field) => field === null || (isSafeIntegerValue(field) && field > 0),
			fenceEventDigest: isNullableDigestValue,
			commitReturnProof: (field) => field === null || isWorkflowCommitReturnProofValue(field),
			rotation: (field) => field === null || isWorkflowGenerationRotationValue(field),
			quarantineReason: (field) =>
				field === null ||
				field === "rotation_prepared_only" ||
				field === "rotation_lease_transfer_unmatched" ||
				field === "rotation_fence_duplicate" ||
				field === "rotation_fence_chain_break" ||
				field === "rotation_commit_uncertain",
			lastCheckpoint: (field) => field === null || isDurableStoreCrashBoundaryValue(field),
			checkpointDigest: isNullableDigestValue,
			sideRecordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		},
	);
}

function isWorkflowGenerationRotationFileValue(
	value: unknown,
): value is Record<string, WorkflowGenerationRotationRecoveryRecord> {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([rotationId, record]) =>
				isWorkflowGenerationRotationRecoveryRecordValue(record) && record.request.rotationId === rotationId,
		)
	);
}

function isWorkflowSemanticHeadValue(value: unknown): value is WorkflowSemanticHead {
	return exactRecord(value, ["workflowId", "sequence", "eventDigest", "stateDigest", "epochRef", "generation"], {
		workflowId: isStringValue,
		sequence: (field) => isSafeIntegerValue(field) && field >= 0,
		eventDigest: isNullableDigestValue,
		stateDigest: isDigestValue,
		epochRef: isEpochRefValue,
		generation: (field) => isSafeIntegerValue(field) && field > 0,
	});
}

function isWorkflowSemanticMutationBindingValue(value: unknown): value is WorkflowSemanticMutationBinding {
	return exactRecord(
		value,
		[
			"mutationId",
			"baselineDigest",
			"expectedGenerations",
			"ownerId",
			"phase",
			"reducerDigest",
			"semanticHead",
			"expectedHead",
			"idempotencyKey",
			"executionKey",
			"writerIdentity",
			"leaseRef",
			"epochRef",
		],
		{
			mutationId: isStringValue,
			baselineDigest: isDigestValue,
			expectedGenerations: (field) =>
				isRecord(field) &&
				Object.keys(field).length > 0 &&
				Object.values(field).every((entry) => isSafeIntegerValue(entry) && entry > 0),
			ownerId: isStringValue,
			phase: isStringValue,
			reducerDigest: isDigestValue,
			semanticHead: isWorkflowSemanticHeadValue,
			expectedHead: isWorkflowJournalHeadValue,
			idempotencyKey: isStringValue,
			executionKey: isNullableStringValue,
			writerIdentity: isStringValue,
			leaseRef: isLeaseRefValue,
			epochRef: isEpochRefValue,
		},
	);
}

function isWorkflowAuthenticatedMutationTupleValue(value: unknown): value is WorkflowAuthenticatedMutationTuple {
	return exactRecord(
		value,
		[
			"recordVersion",
			"generationId",
			"workflowId",
			"mutationId",
			"expectedHead",
			"sequence",
			"eventDigest",
			"epochRef",
			"leaseRef",
			"writerIdentity",
			"idempotencyKey",
			"keyId",
			"frameMac",
			"frameChecksum",
			"recordMac",
			"recordChecksum",
			"priorRecordDigest",
		],
		{
			recordVersion: (field) => field === 1,
			generationId: isStringValue,
			workflowId: isStringValue,
			mutationId: isStringValue,
			expectedHead: isWorkflowJournalHeadValue,
			sequence: (field) => isSafeIntegerValue(field) && field > 0,
			eventDigest: isDigestValue,
			epochRef: isEpochRefValue,
			leaseRef: isLeaseRefValue,
			writerIdentity: isStringValue,
			idempotencyKey: isStringValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			priorRecordDigest: isNullableDigestValue,
		},
	);
}

function isWorkflowCommitReturnProofValue(value: unknown): value is WorkflowCommitReturnProof {
	return exactRecord(
		value,
		[
			"recordVersion",
			"generationId",
			"mutationId",
			"workflowId",
			"sequence",
			"eventDigest",
			"committedFrameDigest",
			"expectedHead",
			"epochRef",
			"leaseRef",
			"writerIdentity",
			"idempotencyKey",
			"keyId",
			"frameMac",
			"frameChecksum",
			"recordMac",
			"recordChecksum",
			"priorRecordDigest",
			"returnedAt",
			"proofDigest",
		],
		{
			recordVersion: (field) => field === 1,
			generationId: isStringValue,
			mutationId: isStringValue,
			workflowId: isStringValue,
			sequence: (field) => isSafeIntegerValue(field) && field > 0,
			eventDigest: isDigestValue,
			committedFrameDigest: isDigestValue,
			expectedHead: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			leaseRef: isLeaseRefValue,
			writerIdentity: isStringValue,
			idempotencyKey: isStringValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			priorRecordDigest: isNullableDigestValue,
			returnedAt: (field) => field === "" || (typeof field === "string" && Number.isFinite(Date.parse(field))),
			proofDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		},
	);
}

interface WorkflowPersistedFrameBase {
	frameKind: "prepared" | "committed";
	version: 1;
	workflowId: string;
	sequence: number;
	eventDigest: string;
	payloadBytes: readonly number[];
	keyId: string;
	generationId: string;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	idempotencyKey: string;
	returnProofId: string;
	expectedHead: WorkflowJournalHead;
	semanticBinding: WorkflowSemanticMutationBinding;
	frameMac: string;
	frameChecksum: string;
}

interface WorkflowPersistedPreparedFrame extends WorkflowPersistedFrameBase {
	frameKind: "prepared";
}

interface WorkflowPersistedCommittedFrame extends WorkflowPersistedFrameBase {
	frameKind: "committed";
	executionKey: string | null;
	preparedFrameDigest: string;
	recordMac: string;
	recordChecksum: string;
}

type WorkflowPersistedFrame = WorkflowPersistedPreparedFrame | WorkflowPersistedCommittedFrame;

function isByteArrayValue(value: unknown): value is readonly number[] {
	return Array.isArray(value) && value.every((entry) => isSafeIntegerValue(entry) && entry >= 0 && entry <= 255);
}

function isWorkflowPersistedFrameValue(value: unknown): value is WorkflowPersistedFrame {
	if (!isRecord(value) || (value.frameKind !== "prepared" && value.frameKind !== "committed")) return false;
	const commonKeys = [
		"frameKind",
		"version",
		"workflowId",
		"sequence",
		"eventDigest",
		"payloadBytes",
		"keyId",
		"generationId",
		"epochRef",
		"leaseRef",
		"writerIdentity",
		"idempotencyKey",
		"returnProofId",
		"expectedHead",
		"semanticBinding",
		"frameMac",
		"frameChecksum",
	];
	const fields: Readonly<Record<string, (field: unknown) => boolean>> = {
		frameKind: (field) => field === value.frameKind,
		version: (field) => field === 1,
		workflowId: isStringValue,
		sequence: (field) => isSafeIntegerValue(field) && field > 0,
		eventDigest: isDigestValue,
		payloadBytes: isByteArrayValue,
		keyId: isStringValue,
		generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
		epochRef: isEpochRefValue,
		leaseRef: isLeaseRefValue,
		writerIdentity: isStringValue,
		idempotencyKey: isStringValue,
		returnProofId: isStringValue,
		expectedHead: isWorkflowJournalHeadValue,
		semanticBinding: isWorkflowSemanticMutationBindingValue,
		frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
	};
	if (value.frameKind === "prepared") return exactRecord(value, commonKeys, fields);
	return exactRecord(value, [...commonKeys, "executionKey", "preparedFrameDigest", "recordMac", "recordChecksum"], {
		...fields,
		executionKey: isNullableStringValue,
		preparedFrameDigest: isStringValue,
		recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
	});
}

function persistedFrameUnsignedBytes(frame: WorkflowPersistedFrame): Uint8Array {
	const common = {
		frameKind: frame.frameKind,
		version: frame.version,
		workflowId: frame.workflowId,
		sequence: frame.sequence,
		eventDigest: frame.eventDigest,
		payloadBytes: frame.payloadBytes,
		keyId: frame.keyId,
		generationId: frame.generationId,
		epochRef: frame.epochRef,
		leaseRef: frame.leaseRef,
		writerIdentity: frame.writerIdentity,
		idempotencyKey: frame.idempotencyKey,
		returnProofId: frame.returnProofId,
		expectedHead: frame.expectedHead,
		semanticBinding: frame.semanticBinding,
	};
	return frame.frameKind === "prepared"
		? canonicalJsonBytes(common)
		: canonicalJsonBytes({
				...common,
				executionKey: frame.executionKey,
				preparedFrameDigest: frame.preparedFrameDigest,
			});
}

function isDecisionRefValue(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, [
			"decisionScope",
			"decisionId",
			"revision",
			"storeEpoch",
			"coordinatorEpoch",
			"decisionDigest",
		]) &&
		isRecord(value.decisionScope) &&
		exactKeys(value.decisionScope, ["kind", "workflowId", "rootSessionId"]) &&
		value.decisionScope.kind === "workflow" &&
		typeof value.decisionScope.workflowId === "string" &&
		typeof value.decisionScope.rootSessionId === "string" &&
		typeof value.decisionId === "string" &&
		Number.isSafeInteger(value.revision) &&
		Number.isSafeInteger(value.storeEpoch) &&
		Number.isSafeInteger(value.coordinatorEpoch) &&
		typeof value.decisionDigest === "string"
	);
}

function isRevisionDecisionRefValue(value: unknown): boolean {
	if (isDecisionRefValue(value)) return true;
	return (
		isRecord(value) &&
		exactKeys(value, ["decisionScope", "decisionId", "revision", "storeEpoch", "decisionDigest"]) &&
		isRecord(value.decisionScope) &&
		((value.decisionScope.kind === "knowledge" &&
			exactKeys(value.decisionScope, ["kind", "namespace"]) &&
			isStringValue(value.decisionScope.namespace)) ||
			(value.decisionScope.kind === "session" &&
				exactKeys(value.decisionScope, ["kind", "rootSessionId"]) &&
				isStringValue(value.decisionScope.rootSessionId)) ||
			(value.decisionScope.kind === "workspace" &&
				exactKeys(value.decisionScope, ["kind", "workspaceId"]) &&
				isStringValue(value.decisionScope.workspaceId)) ||
			(value.decisionScope.kind === "user" &&
				exactKeys(value.decisionScope, ["kind", "userId"]) &&
				isStringValue(value.decisionScope.userId)) ||
			(value.decisionScope.kind === "global" &&
				exactKeys(value.decisionScope, ["kind", "authorityId"]) &&
				isStringValue(value.decisionScope.authorityId))) &&
		isStringValue(value.decisionId) &&
		isSafeIntegerValue(value.revision) &&
		value.revision > 0 &&
		isSafeIntegerValue(value.storeEpoch) &&
		value.storeEpoch > 0 &&
		isStringValue(value.decisionDigest)
	);
}

function isChildIdentityValue(value: unknown): boolean {
	return (
		isRecord(value) &&
		exactKeys(value, [
			"admissionId",
			"childSessionId",
			"processGroupId",
			"executionKey",
			"epochRef",
			"runtimeVersion",
			"hostCapabilityRevision",
			"agentRole",
			"modelId",
			"reasoningEffort",
			"launchConfigDigest",
			"identityDigest",
		]) &&
		isEpochRefValue(value.epochRef) &&
		Object.entries(value)
			.filter(([key]) => key !== "epochRef")
			.every(([, field]) => typeof field === "string" && field.length > 0)
	);
}

function isProcessBindingValue(value: unknown): boolean {
	return exactRecord(value, ["workflowId", "taskId", "attemptId", "childIdentity", "processGroup", "bindingDigest"], {
		workflowId: isStringValue,
		taskId: isStringValue,
		attemptId: isStringValue,
		childIdentity: isChildIdentityValue,
		processGroup: isProcessGroupValue,
		bindingDigest: isStringValue,
	});
}

function isProcessGroupValue(value: unknown): boolean {
	return exactRecord(value, ["pid", "processStartId", "processGroupId", "parentPid", "identityDigest"], {
		pid: (field) => isSafeIntegerValue(field) && (field as number) > 0,
		processStartId: isStringValue,
		processGroupId: isStringValue,
		parentPid: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
		identityDigest: isStringValue,
	});
}

function isGenerationBindingValue(value: unknown): boolean {
	if (
		!exactRecord(value, ["writerIdentity", "processGenerationId", "ownerIdentity"], {
			writerIdentity: isStringValue,
			processGenerationId: isStringValue,
			ownerIdentity: isStringValue,
		})
	)
		return false;
	const binding = value as WorkflowGenerationBinding;
	return binding.ownerIdentity === binding.writerIdentity;
}

function isGoalMutationDeltaValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"goalId",
			"objective",
			"active",
			"status",
			"tokenBudget",
			"tokensUsed",
			"timeUsedSeconds",
			"continuationsUsed",
			"createdAt",
			"updatedAt",
			"lastReason",
			"lastError",
		],
		{
			goalId: isNullableStringValue,
			objective: isNullableStringValue,
			active: (field) => typeof field === "boolean",
			status: (field) =>
				["idle", "active", "paused", "budget_limited", "failed", "blocked", "complete", "error"].includes(
					String(field),
				),
			tokenBudget: (field) => field === null || (isSafeIntegerValue(field) && (field as number) >= 0),
			tokensUsed: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			timeUsedSeconds: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			continuationsUsed: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			createdAt: (field) => field === null || (typeof field === "number" && Number.isFinite(field)),
			updatedAt: (field) => field === null || (typeof field === "number" && Number.isFinite(field)),
			lastReason: isNullableStringValue,
			lastError: isNullableStringValue,
		},
	);
}

function isResourceVectorValue(value: unknown): boolean {
	const isResource = (field: unknown): boolean =>
		exactRecord(field, ["poolId", "deviceType", "count", "memoryBytes"], {
			poolId: isStringValue,
			deviceType: isStringValue,
			count: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
			memoryBytes: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
		});
	const isProvider = (field: unknown): boolean =>
		exactRecord(
			field,
			[
				"poolId",
				"concurrentRequests",
				"requestsPerMinute",
				"totalRequests",
				"inputTokens",
				"outputTokens",
				"idempotency",
			],
			{
				poolId: isStringValue,
				concurrentRequests: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
				requestsPerMinute: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
				totalRequests: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
				inputTokens: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
				outputTokens: (entry) => isSafeIntegerValue(entry) && (entry as number) >= 0,
				idempotency: (entry) => ["provider_native", "host_reconciled", "none"].includes(String(entry)),
			},
		);
	return exactRecord(
		value,
		[
			"cpuMilliCores",
			"memoryBytes",
			"diskBytes",
			"ioWeight",
			"accelerators",
			"providers",
			"networkEgressBytes",
			"wallMilliseconds",
			"monetaryMicrounits",
		],
		{
			cpuMilliCores: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			memoryBytes: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			diskBytes: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			ioWeight: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			accelerators: (field) => Array.isArray(field) && field.every(isResource),
			providers: (field) => Array.isArray(field) && field.every(isProvider),
			networkEgressBytes: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			wallMilliseconds: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
			monetaryMicrounits: (field) => typeof field === "number" && Number.isFinite(field) && field >= 0,
		},
	);
}

function isControlCapacityValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"processSlots",
			"childSessionSlots",
			"modelCallSlots",
			"modelInputTokens",
			"modelOutputTokens",
			"verificationSlots",
			"redTeamSlots",
			"recoverySlots",
		],
		{
			processSlots: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			childSessionSlots: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			modelCallSlots: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			modelInputTokens: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			modelOutputTokens: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			verificationSlots: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			redTeamSlots: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			recoverySlots: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
		},
	);
}

function isTaskResourceGrantValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"resourceVector",
			"workerCapacity",
			"controlCapacity",
			"expectedEnvelopeDigest",
			"canonicalLedgerRef",
			"canonicalLedgerDigest",
			"grantDigest",
		],
		{
			resourceVector: isResourceVectorValue,
			workerCapacity: isControlCapacityValue,
			controlCapacity: isControlCapacityValue,
			expectedEnvelopeDigest: isStringValue,
			canonicalLedgerRef: isArtifactRefValue,
			canonicalLedgerDigest: isStringValue,
			grantDigest: isStringValue,
		},
	);
}

function isZeroControlCapacityValue(value: unknown): boolean {
	return (
		isControlCapacityValue(value) && Object.values(value as Record<string, unknown>).every((entry) => entry === 0)
	);
}

function isCapacityGrantValue(value: unknown): value is WorkflowCapacityGrant {
	if (!isRecord(value) || (value.kind !== "worker" && value.kind !== "control")) return false;
	return exactRecord(
		value,
		["kind", "grantId", "resourceVector", "controlCapacity", "canonicalPoolLedgerRef", "grantDigest"],
		{
			kind: (field) => field === value.kind,
			grantId: isStringValue,
			resourceVector: isResourceVectorValue,
			controlCapacity: value.kind === "worker" ? isZeroControlCapacityValue : isControlCapacityValue,
			canonicalPoolLedgerRef: isArtifactRefValue,
			grantDigest: isStringValue,
		},
	);
}

function isPrefixValue(value: unknown): boolean {
	return exactRecord(value, ["sequence", "digest"], {
		sequence: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
		digest: isStringValue,
	});
}

function isFrontierValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"frontierRef",
			"frontierWorktree",
			"commit",
			"metric",
			"admittedCandidate",
			"workspaceDigest",
			"resultRef",
			"refGeneration",
			"refDigest",
		],
		{
			frontierRef: isStringValue,
			frontierWorktree: isStringValue,
			commit: isStringValue,
			metric: (field) => typeof field === "number" && Number.isFinite(field),
			admittedCandidate: (field) => field === null || isSafeIntegerValue(field),
			workspaceDigest: isStringValue,
			resultRef: isStringValue,
			refGeneration: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			refDigest: isStringValue,
		},
	);
}

function isFrontierCasValue(value: unknown): boolean {
	return exactRecord(
		value,
		["expectedRef", "expectedCommit", "expectedGeneration", "expectedDigest", "executionKey", "epochRef"],
		{
			expectedRef: isStringValue,
			expectedCommit: isStringValue,
			expectedGeneration: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			expectedDigest: isStringValue,
			executionKey: isStringValue,
			epochRef: isEpochRefValue,
		},
	);
}

function isApprovalReceiptValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"approvalRequestId",
			"workflowId",
			"decisionRef",
			"decisionRefs",
			"decisionRoles",
			"headDigest",
			"stateDigest",
			"configDigest",
			"profileDigest",
			"artifactDigest",
			"storeEpoch",
			"coordinatorEpoch",
			"clientSessionId",
			"trustedPrincipal",
			"responseSequence",
			"optionId",
			"effectDigest",
			"mode",
			"responseDigest",
			"consumedAt",
			"consumptionEventSequence",
			"trustedClockReceipt",
		],
		{
			approvalRequestId: isStringValue,
			workflowId: isStringValue,
			decisionRef: isDecisionRefValue,
			decisionRefs: (field) => Array.isArray(field) && field.every(isDecisionRefValue),
			decisionRoles: isApprovalDecisionRolesValue,
			headDigest: isStringValue,
			stateDigest: isStringValue,
			configDigest: isStringValue,
			profileDigest: isStringValue,
			artifactDigest: isStringValue,
			storeEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			coordinatorEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			clientSessionId: isStringValue,
			trustedPrincipal: isTrustedPrincipalValue,
			responseSequence: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			optionId: isStringValue,
			effectDigest: isStringValue,
			mode: (field) => field === "interactive_secret" || field === "signed_headless",
			responseDigest: isStringValue,
			consumedAt: isStringValue,
			consumptionEventSequence: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			trustedClockReceipt: isVerifiedHostReceiptValue,
		},
	);
}

function isTrustedPrincipalValue(value: unknown): boolean {
	return exactRecord(value, ["kind", "principalId", "credentialDigest"], {
		kind: (field) => ["interactive_ui", "workflow_command", "headless_signer"].includes(String(field)),
		principalId: isStringValue,
		credentialDigest: isStringValue,
	});
}

function isLeaseRecordValue(value: unknown): boolean {
	const common = {
		leaseId: isStringValue,
		workflowId: isStringValue,
		taskId: (field: unknown) => field === null || isStringValue(field),
		attemptId: (field: unknown) => field === null || isStringValue(field),
		status: (field: unknown) =>
			["reserved", "active", "release_pending", "released", "quarantined", "expired"].includes(String(field)),
		storeEpoch: (field: unknown) => isSafeIntegerValue(field) && (field as number) > 0,
		coordinatorEpoch: (field: unknown) => isSafeIntegerValue(field) && (field as number) > 0,
		acquisitionEventSequence: (field: unknown) => isSafeIntegerValue(field) && (field as number) > 0,
	};
	const resourceKeys = [
		"leaseId",
		"workflowId",
		"taskId",
		"attemptId",
		"holderIdentity",
		"resourceAdmission",
		"controlCapacity",
		"workerCapacity",
		"status",
		"storeEpoch",
		"coordinatorEpoch",
		"acquisitionEventSequence",
		"idempotencyKey",
		"expiresAt",
		"releaseEventSequence",
	] as const;
	const resourceKeysWithAcquiredAt = [...resourceKeys.slice(0, 13), "acquiredAt", ...resourceKeys.slice(13)] as const;
	if (isRecord(value) && exactKeys(value, resourceKeysWithAcquiredAt)) {
		const valid = exactRecord(value, Object.keys(value), {
			...common,
			holderIdentity: isStringValue,
			resourceAdmission: (field) =>
				exactRecord(
					field,
					[
						"capacityGrant",
						"canonicalPoolLedgerRef",
						"controlCapacity",
						"controlCapacityProjectionDigest",
						"declaredVector",
						"hostDerivedConservativeVector",
						"reservedVector",
						"declaredControlCapacity",
						"hostDerivedControlCapacity",
						"reservedControlCapacity",
						"derivationPolicyDigest",
						"enforcementClass",
						"unknownPoolIds",
						"canonicalLedgerRef",
						"canonicalLedgerDigest",
						"admitted",
						"admissionDigest",
					],
					{
						capacityGrant: isCapacityGrantValue,
						canonicalPoolLedgerRef: isArtifactRefValue,
						controlCapacity: isControlCapacityValue,
						controlCapacityProjectionDigest: isStringValue,
						declaredVector: isResourceVectorValue,
						hostDerivedConservativeVector: isResourceVectorValue,
						reservedVector: isResourceVectorValue,
						declaredControlCapacity: isControlCapacityValue,
						hostDerivedControlCapacity: isControlCapacityValue,
						reservedControlCapacity: isControlCapacityValue,
						derivationPolicyDigest: isStringValue,
						enforcementClass: (entry) =>
							["isolated_metered", "host_bounded", "exclusive_unisolated"].includes(String(entry)),
						unknownPoolIds: (entry) => Array.isArray(entry) && entry.every(isStringValue),
						canonicalLedgerRef: isArtifactRefValue,
						canonicalLedgerDigest: isStringValue,
						admitted: (entry) => typeof entry === "boolean",
						admissionDigest: isStringValue,
					},
				),
			controlCapacity: isControlCapacityValue,
			workerCapacity: isControlCapacityValue,
			idempotencyKey: isStringValue,
			acquiredAt: isFiniteDateStringValue,
			expiresAt: isFiniteDateStringValue,
			releaseEventSequence: (field) => field === null || (isSafeIntegerValue(field) && (field as number) > 0),
		});
		return valid && Date.parse(String(value.expiresAt)) > Date.parse(String(value.acquiredAt));
	}
	return (
		isRecord(value) &&
		exactKeys(value, [
			"leaseId",
			"workflowId",
			"taskId",
			"attemptId",
			"ownedPaths",
			"ownedContracts",
			"status",
			"storeEpoch",
			"coordinatorEpoch",
			"acquisitionEventSequence",
			"releaseEventSequence",
		]) &&
		exactRecord(value, Object.keys(value), {
			...common,
			ownedPaths: (field) => Array.isArray(field) && field.every(isStringValue),
			ownedContracts: (field) => Array.isArray(field) && field.every(isStringValue),
			releaseEventSequence: (field) => field === null || (isSafeIntegerValue(field) && (field as number) > 0),
		})
	);
}

function isPhaseOutcomeValue(value: unknown): boolean {
	if (!isRecord(value) || !exactKeys(value, ["outcome", "attemptStatus"]) || !isStringValue(value.attemptStatus))
		return false;
	const outcome = value.outcome;
	if (!isRecord(outcome)) return false;
	const base = ["workflowId", "phaseAttemptId", "epochRef", "invocationToken", "inputStateDigest"];
	if (
		!base.every((key) => key in outcome) ||
		!isEpochRefValue(outcome.epochRef) ||
		!isStringValue(outcome.workflowId) ||
		!isStringValue(outcome.phaseAttemptId) ||
		!isStringValue(outcome.invocationToken) ||
		!isStringValue(outcome.inputStateDigest)
	)
		return false;
	if (outcome.status === "complete")
		return (
			exactKeys(outcome, [...base, "status", "outputStateDigest", "artifactRefs", "evidenceRefs"]) &&
			isStringValue(outcome.outputStateDigest) &&
			isArtifactRefArray(outcome.artifactRefs) &&
			isArtifactRefArray(outcome.evidenceRefs)
		);
	if (outcome.status === "pause")
		return (
			exactKeys(outcome, [...base, "status", "approvalRequestId", "artifactRefs", "evidenceRefs"]) &&
			isStringValue(outcome.approvalRequestId) &&
			isArtifactRefArray(outcome.artifactRefs) &&
			isArtifactRefArray(outcome.evidenceRefs)
		);
	if (outcome.status === "failed") {
		const legacyKeys = [...base, "status", "errorCode", "retryable", "artifactRefs", "evidenceRefs"];
		const terminalKeys = [...legacyKeys, "completedAt", "workerId", "resultEvidenceRef"];
		return (
			(exactKeys(outcome, legacyKeys) ||
				(exactKeys(outcome, terminalKeys) &&
					isStringValue(outcome.completedAt) &&
					Number.isFinite(Date.parse(outcome.completedAt)) &&
					isStringValue(outcome.workerId) &&
					outcome.workerId.length > 0 &&
					isArtifactRefValue(outcome.resultEvidenceRef))) &&
			isStringValue(outcome.errorCode) &&
			typeof outcome.retryable === "boolean" &&
			isArtifactRefArray(outcome.artifactRefs) &&
			isArtifactRefArray(outcome.evidenceRefs)
		);
	}
	const blockerClaim = outcome.blockerClaim;
	const alternativeResults = isRecord(blockerClaim) ? blockerClaim.alternativeResults : null;
	return (
		outcome.status === "blocked" &&
		exactKeys(outcome, [...base, "status", "blockerClaim"]) &&
		isRecord(blockerClaim) &&
		exactKeys(blockerClaim, [
			"dependencyId",
			"conditionDigest",
			"requiredChange",
			"registeredAlternativeSetDigest",
			"alternativeResults",
			"evidenceRefs",
		]) &&
		isStringValue(blockerClaim.dependencyId) &&
		isStringValue(blockerClaim.conditionDigest) &&
		isStringValue(blockerClaim.requiredChange) &&
		isStringValue(blockerClaim.registeredAlternativeSetDigest) &&
		Array.isArray(alternativeResults) &&
		alternativeResults.every(isBlockerAlternativeResultValue) &&
		isArtifactRefArray(blockerClaim.evidenceRefs)
	);
}

function isBlockerAlternativeResultValue(value: unknown): boolean {
	return exactRecord(
		value,
		["alternativeId", "strategyDigest", "disposition", "attemptedStateDigest", "evidenceRefs"],
		{
			alternativeId: isStringValue,
			strategyDigest: isStringValue,
			disposition: (field) =>
				["available", "failed_with_evidence", "unsafe", "outside_authority", "external_state_unavailable"].includes(
					String(field),
				),
			attemptedStateDigest: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	);
}

function isArtifactRefArray(value: unknown): boolean {
	return Array.isArray(value) && value.every(isArtifactRefValue);
}

function isCanonicalWorkflowRelativePath(value: unknown): boolean {
	return (
		isStringValue(value) &&
		value.length > 0 &&
		value[0] !== "/" &&
		!/^[A-Za-z]:/.test(value) &&
		!value.includes("\\") &&
		!value.split("/").some((segment) => segment.length === 0 || segment === "." || segment === "..")
	);
}

function isGoalProjectionBindingValue(value: unknown): boolean {
	return exactRecord(value, ["workflowId", "eventSequence", "transitionDigest", "storeEpoch", "coordinatorEpoch"], {
		workflowId: isStringValue,
		eventSequence: (field) => isSafeIntegerValue(field) && (field as number) > 0,
		transitionDigest: isStringValue,
		storeEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
		coordinatorEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
	});
}

function isAttemptHandoffValue(value: unknown): boolean {
	const keys = [
		"taskId",
		"attemptId",
		"outcome",
		"planRevision",
		"goalContractRevision",
		"ownedPaths",
		"ownedContracts",
		"upstreamDecisionRefs",
		"interfaceAndDependencyRefs",
		"recommendation",
		"rationale",
		"preservedInvariants",
		"pitfalls",
		"requirementEvidence",
		"verificationEvidenceRefs",
		"unresolvedIssues",
		"failedApproaches",
		"escalation",
		"preWorkspaceDigest",
		"postWorkspaceDigest",
	];
	if (!isRecord(value) || !exactKeys(value, keys)) return false;
	const requirementEvidence = (field: unknown): boolean =>
		Array.isArray(field) &&
		field.every((entry) =>
			exactRecord(
				entry,
				[
					"evidenceId",
					"requirementId",
					"claim",
					"result",
					"method",
					"artifactRefs",
					"confidence",
					"limitations",
					"workspaceDigest",
					"observedAt",
				],
				{
					evidenceId: isStringValue,
					requirementId: isStringValue,
					claim: isStringValue,
					result: isStringValue,
					method: isStringValue,
					artifactRefs: isArtifactRefArray,
					confidence: (item) => ["high", "medium", "low"].includes(String(item)),
					limitations: (item) => Array.isArray(item) && item.every(isStringValue),
					workspaceDigest: isStringValue,
					observedAt: isStringValue,
				},
			),
		);
	return exactRecord(value, keys, {
		taskId: isStringValue,
		attemptId: isStringValue,
		outcome: (field) => ["completed", "needs_fix", "blocked", "interrupted"].includes(String(field)),
		planRevision: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
		goalContractRevision: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
		ownedPaths: (field) => Array.isArray(field) && field.every(isStringValue),
		ownedContracts: (field) => Array.isArray(field) && field.every(isStringValue),
		upstreamDecisionRefs: isArtifactRefArray,
		interfaceAndDependencyRefs: isArtifactRefArray,
		recommendation: isStringValue,
		rationale: isStringValue,
		preservedInvariants: (field) => Array.isArray(field) && field.every(isStringValue),
		pitfalls: (field) => Array.isArray(field) && field.every(isStringValue),
		requirementEvidence,
		verificationEvidenceRefs: isArtifactRefArray,
		unresolvedIssues: (field) => Array.isArray(field) && field.every(isStringValue),
		failedApproaches: (field) => Array.isArray(field) && field.every(isStringValue),
		escalation: (field) =>
			field === null ||
			(isRecord(field) &&
				exactKeys(field, ["reason", "materialChangeKinds", "evidenceRefs", "requestedDecision"]) &&
				isStringValue(field.reason) &&
				Array.isArray(field.materialChangeKinds) &&
				field.materialChangeKinds.every(isStringValue) &&
				isArtifactRefArray(field.evidenceRefs) &&
				isStringValue(field.requestedDecision)),
		preWorkspaceDigest: isStringValue,
		postWorkspaceDigest: isStringValue,
	});
}

function isConcreteEffectValue(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	const base = { operationId: isStringValue };
	if (value.kind === "bash_exec")
		return exactRecord(value, ["kind", "operationId", "commandPreimageRef", "cwd", "timeoutMs", "writeClass"], {
			kind: (field) => field === "bash_exec",
			...base,
			commandPreimageRef: isArtifactRefValue,
			cwd: isCanonicalWorkflowRelativePath,
			timeoutMs: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			writeClass: (field) => ["read_only", "workspace_write", "external_write"].includes(String(field)),
		});
	if (value.kind === "file_read")
		return exactRecord(value, ["kind", "operationId", "path", "pathDigest"], {
			kind: (field) => field === "file_read",
			...base,
			path: isCanonicalWorkflowRelativePath,
			pathDigest: isStringValue,
		});
	if (value.kind === "file_write")
		return exactRecord(value, ["kind", "operationId", "path", "contentPreimageRef", "writeClass"], {
			kind: (field) => field === "file_write",
			...base,
			path: isCanonicalWorkflowRelativePath,
			contentPreimageRef: isArtifactRefValue,
			writeClass: (field) => ["workspace_write", "external_write"].includes(String(field)),
		});
	if (value.kind === "ipython_exec")
		return exactRecord(value, ["kind", "operationId", "codePreimageRef", "kernelId", "writeClass"], {
			kind: (field) => field === "ipython_exec",
			...base,
			codePreimageRef: isArtifactRefValue,
			kernelId: isStringValue,
			writeClass: (field) => ["read_only", "workspace_write", "external_write"].includes(String(field)),
		});
	if (value.kind === "package_manager")
		return exactRecord(value, ["kind", "operationId", "manager", "argumentsPreimageRef", "cwd", "writeClass"], {
			kind: (field) => field === "package_manager",
			...base,
			manager: (field) => ["npm", "pnpm", "yarn", "pip", "uv"].includes(String(field)),
			argumentsPreimageRef: isArtifactRefValue,
			cwd: isCanonicalWorkflowRelativePath,
			writeClass: (field) => ["workspace_write", "external_write"].includes(String(field)),
		});
	if (value.kind === "child_process_spawn")
		return exactRecord(
			value,
			["kind", "operationId", "executablePreimageRef", "argumentsPreimageRef", "cwd", "processGroupRequest"],
			{
				kind: (field) => field === "child_process_spawn",
				...base,
				executablePreimageRef: isArtifactRefValue,
				argumentsPreimageRef: isArtifactRefValue,
				cwd: isCanonicalWorkflowRelativePath,
				processGroupRequest: (field) =>
					exactRecord(field, ["executable", "arguments", "cwd", "detached", "requireProcessStartId"], {
						executable: isStringValue,
						arguments: (entry) => Array.isArray(entry) && entry.every(isStringValue),
						cwd: isCanonicalWorkflowRelativePath,
						detached: (entry) => typeof entry === "boolean",
						requireProcessStartId: (entry) => typeof entry === "boolean",
					}),
			},
		);
	if (value.kind === "artifact_publish")
		return exactRecord(value, ["kind", "operationId", "payloadKind", "payloadPreimageRef"], {
			kind: (field) => field === "artifact_publish",
			...base,
			payloadKind: isStringValue,
			payloadPreimageRef: isArtifactRefValue,
		});
	return (
		value.kind === "session_mutation" &&
		exactRecord(value, ["kind", "operationId", "target", "mutationPreimageRef"], {
			kind: (field) => field === "session_mutation",
			...base,
			target: (field) => ["goal", "settings", "session_projection"].includes(String(field)),
			mutationPreimageRef: isArtifactRefValue,
		})
	);
}

function isCoordinatorLeaseValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"workflowId",
			"leaseId",
			"ownerIdentity",
			"pid",
			"processStartId",
			"processGroupId",
			"epochRef",
			"acquiredAt",
			"renewedAt",
			"expiresAt",
			"status",
		],
		{
			workflowId: isStringValue,
			leaseId: isStringValue,
			ownerIdentity: isStringValue,
			pid: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			processStartId: isStringValue,
			processGroupId: isStringValue,
			epochRef: isEpochRefValue,
			acquiredAt: isStringValue,
			renewedAt: isStringValue,
			expiresAt: isStringValue,
			status: (field) => ["active", "fenced", "expired"].includes(String(field)),
		},
	);
}

function isReconciliationOutcomeValue(value: unknown): boolean {
	return exactRecord(
		value,
		[
			"workflowId",
			"reconciliationAttemptId",
			"taskId",
			"attemptId",
			"disposition",
			"persistedChildIdentity",
			"observedChildIdentity",
			"observedProcessGroupId",
			"observedTranscriptDigest",
			"observedWorkspaceDigest",
			"epochRef",
			"evidenceRefs",
			"stateDigest",
		],
		{
			workflowId: isStringValue,
			reconciliationAttemptId: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			disposition: isStringValue,
			persistedChildIdentity: (field) => field === null || isChildIdentityValue(field),
			observedChildIdentity: (field) => field === null || isChildIdentityValue(field),
			observedProcessGroupId: isNullableStringValue,
			observedTranscriptDigest: isNullableStringValue,
			observedWorkspaceDigest: isStringValue,
			epochRef: isEpochRefValue,
			evidenceRefs: isArtifactRefArray,
			stateDigest: isStringValue,
		},
	);
}

const WORKFLOW_AUTO_RESEARCH_EVENT_KINDS: ReadonlySet<string> = new Set([
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

function isWorkflowEventPayload(value: unknown): value is WorkflowEventPayload {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	const shape = WORKFLOW_EVENT_SHAPES[value.kind as WorkflowEventType];
	if (shape === undefined) return false;
	const keys = WORKFLOW_AUTO_RESEARCH_EVENT_KINDS.has(value.kind)
		? [...shape.keys, "workflowId", "epochRef", "executionKey"]
		: shape.keys;
	if (!exactKeys(value, keys)) return false;
	if (
		WORKFLOW_AUTO_RESEARCH_EVENT_KINDS.has(value.kind) &&
		(!isStringValue(value.workflowId) || !isEpochRefValue(value.epochRef) || !isStringValue(value.executionKey))
	)
		return false;
	if (!Object.entries(shape.fields).every(([key, validate]) => validate(value[key]))) return false;
	if (value.kind === "workflow_progress_lease_acquired") {
		const cut = value.cut as Record<string, unknown>;
		const lease = value.lease as Record<string, unknown>;
		const predicate = lease.expectedTransitionPredicate as Record<string, unknown>;
		const { predicateDigest, ...predicateWithoutDigest } = predicate;
		const { leaseDigest, ...leaseWithoutDigest } = lease;
		const readyTaskIds = cut.readyTaskIds as readonly string[];
		const terminalTaskIds = cut.terminalTaskIds as readonly string[];
		const unresolvedGatingObligationDigests = cut.unresolvedGatingObligationDigests as readonly string[];
		const unresolvedEffectDigests = cut.unresolvedEffectDigests as readonly string[];
		const lastEvidence = cut.lastAuthenticatedOutcomeEvidenceRef as WorkflowArtifactRef | null;
		const sourceOutcome = value.sourceOutcome as Record<string, unknown> | null;
		const semanticProgressDigest = digestObject({
			goalRevisionDigest: cut.goalRevisionDigest,
			boundaryRevisionDigest: cut.boundaryRevisionDigest,
			nextGate: cut.nextGate,
			readyTaskIds,
			terminalTaskIds,
			unresolvedGatingObligationDigests,
			unresolvedEffectDigests,
			lastAuthenticatedOutcomeEvidenceDigest: lastEvidence?.digest ?? null,
		});
		return (
			digestObject(predicateWithoutDigest) === predicateDigest &&
			lease.expectedTransitionPredicateDigest === predicateDigest &&
			lease.adversarialReviewDigest ===
				digestObject({
					schemaVersion: 1,
					predicateDigest,
					rejectedRenewalSignals: PROGRESS_REJECTED_RENEWAL_SIGNALS,
					verdict: "accepted",
				}) &&
			digestObject(leaseWithoutDigest) === leaseDigest &&
			value.leaseDigest === leaseDigest &&
			digestObject(cut) === value.cutDigest &&
			lease.progressCutDigest === value.cutDigest &&
			lease.baseSemanticProgressDigest === cut.semanticProgressDigest &&
			cut.semanticProgressDigest === semanticProgressDigest &&
			cut.readyTaskSetDigest === digestObject(readyTaskIds) &&
			cut.workflowId === value.workflowId &&
			lease.workflowId === value.workflowId &&
			digestObject(cut.epochRef) === digestObject(value.epochRef) &&
			digestObject(lease.epochRef) === digestObject(value.epochRef) &&
			digestObject(lease.baseJournalHead) === digestObject(cut.journalHead) &&
			Date.parse(String(lease.deadline)) > Date.parse(String(lease.acquiredAt)) &&
			readyTaskIds.length === new Set(readyTaskIds).size &&
			terminalTaskIds.length === new Set(terminalTaskIds).size &&
			(terminalTaskIds.length === 0
				? sourceOutcome === null && lastEvidence === null
				: sourceOutcome !== null &&
					terminalTaskIds.includes(String(sourceOutcome.taskId)) &&
					lastEvidence !== null &&
					(sourceOutcome.evidenceDigests as readonly string[]).includes(lastEvidence.digest))
		);
	}
	if (value.kind === "workflow_progress_stalled") {
		const record = value.record as Record<string, unknown>;
		const { stallDigest, ...recordWithoutDigest } = record;
		return (
			digestObject(recordWithoutDigest) === stallDigest &&
			value.recordDigest === stallDigest &&
			record.workflowId === value.workflowId &&
			digestObject(record.epochRef) === digestObject(value.epochRef) &&
			record.baseSemanticProgressDigest === record.observedSemanticProgressDigest
		);
	}
	if (value.kind === "workflow_progress_lease_closed") {
		const { kind: _kind, closureDigest, ...closureWithoutDigest } = value;
		return digestObject(closureWithoutDigest) === closureDigest;
	}
	if (value.kind === "workflow_progress_recovery_started") {
		const { kind: _kind, recoveryDigest, ...recoveryWithoutDigest } = value;
		return digestObject(recoveryWithoutDigest) === recoveryDigest;
	}
	if (value.kind === "workflow_task_lease_heartbeat") {
		const { kind: _kind, heartbeatDigest, ...heartbeatWithoutDigest } = value;
		return (
			digestObject(heartbeatWithoutDigest) === heartbeatDigest &&
			Date.parse(String(value.observedAt)) <= Date.parse(String(value.priorExpiresAt)) &&
			Date.parse(String(value.renewedExpiresAt)) > Date.parse(String(value.observedAt))
		);
	}
	if (value.kind === "workflow_external_blocker_recorded") {
		const blocker = value.blocker as Record<string, unknown>;
		return (
			value.workflowId === blocker.workflowId &&
			digestObject(value.epochRef) === digestObject(blocker.epochRef) &&
			value.blockerDigest === blocker.blockerDigest
		);
	}
	if (value.kind === "workflow_external_blocker_resolved") {
		const resolution = value.resolution as Record<string, unknown>;
		return (
			value.workflowId === resolution.workflowId &&
			digestObject(value.epochRef) === digestObject(resolution.epochRef) &&
			value.resolutionDigest === resolution.resolutionDigest
		);
	}
	if (value.kind === "workflow_observation_outcome_recorded") {
		return (
			value.workflowId === (value.record as Record<string, unknown>).workflowId &&
			digestObject(value.record) === value.recordDigest &&
			digestObject((value.record as Record<string, unknown>).epochRef) === digestObject(value.epochRef)
		);
	}
	if (value.kind === "workflow_completion_cut_sealed") {
		return (
			value.workflowId === (value.cut as Record<string, unknown>).workflowId &&
			digestObject(value.cut) === value.cutDigest &&
			digestObject((value.cut as Record<string, unknown>).epochRef) === digestObject(value.epochRef)
		);
	}
	if (value.kind === "workflow_late_observation_policy_recorded") {
		return (
			value.workflowId === (value.record as Record<string, unknown>).workflowId &&
			digestObject(value.record) === value.recordDigest &&
			digestObject((value.record as Record<string, unknown>).epochRef) === digestObject(value.epochRef)
		);
	}
	return true;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function sameFixedBytes(left: Uint8Array, right: Uint8Array, byteLength: number): boolean {
	if (left.byteLength !== byteLength || right.byteLength !== byteLength) return false;
	return timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function sameFixedHex(left: string, right: string, byteLength: number): boolean {
	if (left.length !== byteLength * 2 || right.length !== byteLength * 2) return false;
	const leftBytes = Buffer.from(left, "hex");
	const rightBytes = Buffer.from(right, "hex");
	if (leftBytes.byteLength !== byteLength || rightBytes.byteLength !== byteLength) return false;
	return timingSafeEqual(leftBytes, rightBytes);
}

function workflowCommitReturnProofDigest(proof: WorkflowCommitReturnProof): string {
	const { proofDigest: _proofDigest, ...unsigned } = proof;
	return digestObject(unsigned);
}

export function decodeWorkflowEventPayload(bytes: Uint8Array): WorkflowEventPayload {
	let value: unknown;
	try {
		value = parseCanonicalJsonBytes(bytes);
	} catch {
		throw new Error("Workflow event payload is not valid JSON.");
	}
	if (!isWorkflowEventPayload(value) || !sameBytes(bytes, canonicalJsonBytes(value))) {
		throw new Error("Workflow event payload is not a canonical closed event.");
	}
	return value;
}

/**
 * Platform-owned descriptor primitives.  Every method is descriptor-relative:
 * the implementation must use openat/mkdirat/renameat/unlinkat with no-follow
 * flags, lstat/fstat identity checks before and after opening, and fsync of the
 * leaf plus every ancestor.  No method accepts or constructs a child path.
 */
export interface WorkflowDescriptorNativeAdapter {
	openRoot(rootPath: string): Promise<WorkflowDescriptorHandle>;
	mkdirAt(parent: WorkflowDescriptorHandle, component: string, mode: number): Promise<WorkflowDescriptorHandle>;
	openAt(
		parent: WorkflowDescriptorHandle,
		component: string,
		flags: number,
		mode: number,
	): Promise<WorkflowDescriptorHandle>;
	renameAt(
		parent: WorkflowDescriptorHandle,
		fromComponent: string,
		toComponent: string,
		options?: { replace: boolean; noReplace: boolean },
	): Promise<void>;
	unlinkAt(parent: WorkflowDescriptorHandle, component: string): Promise<void>;
	syncDirectoryChain(leaf: WorkflowDescriptorHandle, root: WorkflowDescriptorHandle): Promise<void>;
}

/** Adapt one platform implementation; K owns no raw path or path-join authority. */
export function createNodeWorkflowDescriptorFs(native: WorkflowDescriptorNativeAdapter): WorkflowDescriptorFs {
	return {
		openRoot: (rootPath) => native.openRoot(rootPath),
		mkdirAt: (parent, component, mode) => native.mkdirAt(parent, component, mode),
		openAt: (parent, component, flags, mode) => native.openAt(parent, component, flags, mode),
		renameAt: (parent, fromComponent, toComponent, options) =>
			native.renameAt(parent, fromComponent, toComponent, options),
		unlinkAt: (parent, component) => native.unlinkAt(parent, component),
		syncDirectoryChain: (leaf, root) => native.syncDirectoryChain(leaf, root),
	};
}

/**
 * Create a host-backed append lease whose exclusive guard is an atomic lock-file create.
 * Args:
 * input: Absolute lock path and the lease tuple owned by this writer.
 * Return: A cross-process append lease for descriptor-rooted journal mutations.
 */
export function createFileWorkflowAppendLease(input: {
	lockPath: string;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
}): WorkflowAppendLease {
	assertCanonicalDescriptorRootPath(input.lockPath, "append lease lock path");
	if (input.writerIdentity.length === 0 || input.leaseRef.writerIdentity !== input.writerIdentity)
		throw new Error("File append lease writer identity is not bound to its lease tuple.");
	let currentLease = { ...input.leaseRef };
	let currentWriter = input.writerIdentity;
	const assertOwned = async (guard: Parameters<WorkflowAppendLease["assertOwned"]>[0]): Promise<void> => {
		if (
			guard.workflowId.length === 0 ||
			guard.writerIdentity !== currentWriter ||
			guard.leaseRef.writerIdentity !== currentWriter ||
			digestObject(guard.leaseRef) !== digestObject(currentLease) ||
			digestObject(guard.epochRef) !==
				digestObject({ storeEpoch: currentLease.storeEpoch, coordinatorEpoch: currentLease.coordinatorEpoch }) ||
			guard.rootDigest !== currentLease.rootDigest ||
			guard.boundary.length === 0
		)
			throw new Error("File append lease is not owned by this writer.");
	};
	const acquireLock = async (): Promise<Awaited<ReturnType<typeof openFile>>> => {
		for (let attempt = 0; attempt < 5000; attempt += 1) {
			try {
				const lock = await openFile(
					input.lockPath,
					fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				try {
					const stats = await lock.stat();
					if (!stats.isFile() || Number(stats.nlink) !== 1) throw new Error("Append lease lock identity changed.");
					return lock;
				} catch (error) {
					await lock.close().catch(() => undefined);
					await unlinkFile(input.lockPath).catch(() => undefined);
					throw error;
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				await new Promise<void>((resolve) => setTimeout(resolve, 2));
			}
		}
		throw new Error("File append lease could not acquire its cross-process lock.");
	};
	return {
		acquire: async () => ({ ...currentLease }),
		renew: async (workflowId, writerIdentity, coordinatorEpoch) => {
			await assertOwned({
				workflowId,
				writerIdentity,
				leaseRef: currentLease,
				epochRef: { storeEpoch: currentLease.storeEpoch, coordinatorEpoch },
				rootDigest: currentLease.rootDigest,
				boundary: "append-lease-renew",
			});
		},
		assertOwned,
		withExclusiveGuard: async <T>(
			guard: Parameters<WorkflowAppendLease["withExclusiveGuard"]>[0],
			operation: () => Promise<T>,
		): Promise<T> => {
			const lock = await acquireLock();
			try {
				await assertOwned(guard);
				return await operation();
			} finally {
				await lock.close().catch(() => undefined);
				await unlinkFile(input.lockPath).catch(() => undefined);
			}
		},
		observe: async () => ({ writerIdentity: currentWriter, leaseRef: { ...currentLease } }),
		rotate: async (rotation) => {
			if (
				rotation.expectedWriterIdentity !== currentWriter ||
				digestObject(rotation.expectedLeaseRef) !== digestObject(currentLease)
			)
				throw new Error("File append lease rotation tuple is stale.");
			currentWriter = rotation.nextWriterIdentity;
			currentLease = { ...rotation.nextLeaseRef };
		},
		release: async () => undefined,
	};
}

export interface WorkflowDescriptorContext {
	readonly descriptorFs: WorkflowDescriptorFs;
	readonly keyProvider: WorkflowJournalKeyProvider;
	readonly epochRef: WorkflowEpochRef;
	root: WorkflowDescriptorHandle;
	workflow: WorkflowDescriptorHandle;
	workflowId: string;
	readonly rootDigest: string;
	generationId: string;
}

async function openWorkflowDescriptorContext(
	descriptorFs: WorkflowDescriptorFs,
	descriptorRoots: WorkflowDescriptorRootAdapters,
	workflowId: string,
	keyProvider: WorkflowJournalKeyProvider,
	epochRef: WorkflowEpochRef,
	generationId?: string,
): Promise<WorkflowDescriptorContext> {
	assertSafeIdentifier(workflowId, "workflowId");
	if (generationId !== undefined && !/^generation-[0-9a-f]{32}$/.test(generationId))
		throw new Error("Workflow generation context requires a canonical generation identity.");
	const root = await descriptorFs.openRoot(descriptorRoots.sessionRoot.descriptorRoot);
	let workflow: WorkflowDescriptorHandle | undefined;
	try {
		workflow = await openDescriptorDirectoryChain(descriptorFs, root, ["workflows", workflowId], false);
		if (
			descriptorRoots.sessionRoot.rootSessionId.length === 0 ||
			descriptorRoots.sessionRoot.identityDigest !== root.identityDigest ||
			descriptorRoots.workflowRoot.workflowId !== workflowId ||
			descriptorRoots.workflowRoot.identityDigest !== workflow.identityDigest ||
			descriptorRoots.workflowRoot.descriptorRoot.length === 0
		)
			throw new Error("Opened descriptor identities do not match the validated session/workflow adapters.");
		const bytes = await readDescriptorBytesIfPresent(
			descriptorFs,
			workflow,
			generationId === undefined
				? ["side-records", "active-generation.json"]
				: ["generations", generationId, "ACTIVE"],
		);
		if (bytes === null)
			throw new Error("Persisted active-generation record is required before opening the workflow journal.");
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isWorkflowActiveGenerationRecordValue(parsed))
			throw new Error("Persisted active-generation record is not a closed durable map.");
		const record = parsed;
		if (
			record.workflowId !== workflowId ||
			(generationId !== undefined && record.generationId !== generationId) ||
			record.manifestRef.relativePath !== `${deriveWorkflowGenerationPath(record.generationId)}/ACTIVE` ||
			record.manifestRef.digest !== record.manifestBytesDigest ||
			digestObject(record.epochRef) !== digestObject(epochRef)
		)
			throw new Error(
				"Persisted active-generation record is missing its authenticated workflow, generation, manifest, epoch, or key tuple.",
			);
		const key = await keyProvider.resolve(record.workflowId, record.keyId, record.epochRef);
		const expectedSideRecordMac = sideRecordMac(
			{
				workflowId: record.workflowId,
				generationId: record.generationId,
				manifestRef: record.manifestRef,
				manifestBytesDigest: record.manifestBytesDigest,
				sourceHead: record.sourceHead,
				epochRef: record.epochRef,
				generationBinding: record.generationBinding,
				leaseRef: record.leaseRef,
				keyId: record.keyId,
				frameMac: record.frameMac,
				frameChecksum: record.frameChecksum,
				priorRecordDigest: record.priorRecordDigest,
				sideRecordMac: "",
			},
			key.secret,
		);
		if (
			key.keyId !== record.keyId ||
			key.validStoreEpoch !== record.epochRef.storeEpoch ||
			key.generationId !== record.generationId ||
			!sameFixedHex(record.sideRecordMac, expectedSideRecordMac, 32)
		)
			throw new Error(
				"Persisted active-generation record is not authenticated by the exact epoch and generation key.",
			);
		const manifestBytes = await readDescriptorBytesIfPresent(descriptorFs, workflow, [
			"generations",
			record.generationId,
			"ACTIVE",
		]);
		if (manifestBytes === null || manifestBytes.byteLength !== record.manifestRef.sizeBytes)
			throw new Error(
				"Persisted active-generation manifest is missing, differs from its authenticated record, or is not bound to canonical bytes.",
			);
		const manifest = parseCanonicalJsonBytes(manifestBytes);
		if (
			!isWorkflowActiveGenerationRecordValue(manifest) ||
			!sameBytes(canonicalJsonBytes(manifest), manifestBytes) ||
			digestObject(manifest) !== digestObject(record) ||
			workflowActiveGenerationManifestBytesDigest(manifest) !== record.manifestRef.digest ||
			workflowActiveGenerationManifestBytesDigest(manifest) !== record.manifestBytesDigest
		)
			throw new Error(
				"Persisted active-generation manifest is missing, differs from its authenticated record, or is not bound to canonical bytes.",
			);
		return {
			sessionRoot: descriptorRoots.sessionRoot,
			workflowRoot: descriptorRoots.workflowRoot,
			descriptorFs,
			keyProvider,
			epochRef,
			root,
			workflow,
			workflowId,
			rootDigest: digestObject({
				descriptorIdentity: root.identityDigest,
				workflowIdentity: workflow.identityDigest,
				workflowId,
			}),
			generationId: record.generationId,
		};
	} catch (error) {
		if (workflow !== undefined) await workflow.close().catch(() => undefined);
		await root.close().catch(() => undefined);
		throw error;
	}
}

async function readWorkflowSideStoreBytes(
	context: WorkflowDescriptorContext,
	components: readonly string[],
): Promise<Uint8Array | null> {
	await assertDescriptorContextIdentity(context);
	const bytes = await readDescriptorBytesIfPresent(context.descriptorFs, context.workflow, [
		"side-records",
		...components,
	]);
	await assertDescriptorContextIdentity(context);
	return bytes;
}

async function writeWorkflowSideStoreBytes(
	context: WorkflowDescriptorContext,
	components: readonly string[],
	bytes: Uint8Array,
	exclusive = false,
): Promise<void> {
	await assertDescriptorContextIdentity(context);
	await writeDescriptorBytes(
		context.descriptorFs,
		context.root,
		["workflows", context.workflowId, "side-records", ...components],
		bytes,
		exclusive,
	);
	await assertDescriptorContextIdentity(context);
}

async function assertDescriptorContextIdentity(context: WorkflowDescriptorContext): Promise<void> {
	const root = await context.root.stat();
	const workflow = await context.workflow.stat();
	if (
		root.identityDigest !== context.root.identityDigest ||
		workflow.identityDigest !== context.workflow.identityDigest ||
		root.kind !== "directory" ||
		workflow.kind !== "directory" ||
		root.linkCount < 1 ||
		workflow.linkCount < 1 ||
		root.device <= 0 ||
		workflow.device <= 0
	)
		throw new Error("Opened descriptor identity changed across a durable boundary.");
}

async function persistDurableFlushProof(
	context: WorkflowDescriptorContext,
	input: { mutationId: string; frameKind: WorkflowFrameKind; frameDigest: string },
	file: WorkflowDescriptorHandle,
	parent: WorkflowDescriptorHandle,
): Promise<WorkflowDurableFlushProof> {
	const fileStat = await file.stat();
	const parentStat = await parent.stat();
	if (
		fileStat.kind !== "file" ||
		fileStat.linkCount !== 1 ||
		fileStat.device <= 0 ||
		parentStat.kind !== "directory" ||
		parentStat.linkCount < 1 ||
		parentStat.device <= 0
	)
		throw new Error("Durable flush proof lacks stable file and parent descriptor identities.");
	const unsigned = {
		mutationId: input.mutationId,
		frameKind: input.frameKind,
		frameDigest: input.frameDigest,
		fileIdentityDigest: fileStat.identityDigest,
		parentDirectoryIdentityDigest: parentStat.identityDigest,
		fileSynced: true as const,
		parentDirectorySynced: true as const,
	};
	const currentKey = await context.keyProvider.current(context.workflowId, context.epochRef);
	const key = await resolveCurrentSideRecordSecret(context, {
		workflowId: context.workflowId,
		keyId: currentKey.keyId,
		epochRef: context.epochRef,
		generationId: context.generationId,
	});
	const proof = {
		...unsigned,
		proofDigest: digestObject(unsigned),
		sideRecordMac: sideRecordMac({ ...unsigned, proofDigest: digestObject(unsigned), sideRecordMac: "" }, key),
	};
	await writeWorkflowSideStoreBytes(
		context,
		flushProofComponents(input.mutationId, input.frameKind),
		canonicalJsonBytes(proof),
	);
	return proof;
}

async function verifyDurableFlushProof(
	context: WorkflowDescriptorContext,
	input: { mutationId: string; frameKind: WorkflowFrameKind; frameDigest: string },
): Promise<void> {
	const bytes = await readWorkflowSideStoreBytes(context, flushProofComponents(input.mutationId, input.frameKind));
	if (bytes === null) throw new Error("Durable frame is missing its persisted file-and-parent fsync proof.");
	const value = parseCanonicalJsonBytes(bytes);
	if (
		!isWorkflowDurableFlushProofValue(value) ||
		value.mutationId !== input.mutationId ||
		value.frameKind !== input.frameKind ||
		value.frameDigest !== input.frameDigest ||
		value.proofDigest !==
			digestObject({
				mutationId: value.mutationId,
				frameKind: value.frameKind,
				frameDigest: value.frameDigest,
				fileIdentityDigest: value.fileIdentityDigest,
				parentDirectoryIdentityDigest: value.parentDirectoryIdentityDigest,
				fileSynced: true,
				parentDirectorySynced: true,
			})
	)
		throw new Error("Persisted durable flush proof is incomplete or bound to different frame bytes.");
	const currentKey = await context.keyProvider.current(context.workflowId, context.epochRef);
	const key = await resolveCurrentSideRecordSecret(context, {
		workflowId: context.workflowId,
		keyId: currentKey.keyId,
		epochRef: context.epochRef,
		generationId: context.generationId,
	});
	const expectedSideRecordMac = sideRecordMac(
		{
			mutationId: value.mutationId,
			frameKind: value.frameKind,
			frameDigest: value.frameDigest,
			fileIdentityDigest: value.fileIdentityDigest,
			parentDirectoryIdentityDigest: value.parentDirectoryIdentityDigest,
			fileSynced: value.fileSynced,
			parentDirectorySynced: value.parentDirectorySynced,
			proofDigest: value.proofDigest,
			sideRecordMac: "",
		},
		key,
	);
	if (!sameFixedHex(value.sideRecordMac, expectedSideRecordMac, 32))
		throw new Error("Persisted durable flush proof is not host-key authenticated.");
	const fileComponents =
		input.frameKind === "outbox"
			? (["workflows", context.workflowId, "outbox", "events.log"] as const)
			: input.frameKind === "prepared" || input.frameKind === "committed"
				? (["workflows", context.workflowId, "generations", context.generationId, "events.log"] as const)
				: null;
	if (fileComponents !== null) {
		const opened = await openDescriptorLeaf(
			context.descriptorFs,
			context.root,
			fileComponents,
			fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
			0o600,
			false,
		);
		try {
			const fileStat = await opened.leaf.stat();
			const parentStat = await opened.parent.stat();
			if (
				fileStat.identityDigest !== value.fileIdentityDigest ||
				parentStat.identityDigest !== value.parentDirectoryIdentityDigest
			)
				throw new Error("Persisted durable flush proof does not match the currently opened file identities.");
		} finally {
			await opened.leaf.close().catch(() => undefined);
			if (opened.parent !== context.root) await opened.parent.close().catch(() => undefined);
		}
	}
}

function sideStoreRecordComponent(kind: string, id: string): readonly string[] {
	assertSafeIdentifier(kind, "side-record kind");
	assertSafeIdentifier(id, "side-record id");
	const pathId = kind === "return-proofs" && id.length > 180 ? sha256Hex(new TextEncoder().encode(id)) : id;
	return [kind, `${pathId}.json`];
}

async function resolveSideRecordSecret(
	context: WorkflowDescriptorContext,
	tuple: { workflowId: string; keyId: string; epochRef: WorkflowEpochRef; generationId: string },
): Promise<Uint8Array> {
	if (
		tuple.workflowId !== context.workflowId ||
		tuple.keyId.length === 0 ||
		!/^generation-[0-9a-f]{32}$/.test(tuple.generationId) ||
		tuple.epochRef.storeEpoch < 1 ||
		tuple.epochRef.coordinatorEpoch < 1
	)
		throw new Error("Side-record key tuple is outside the opened workflow context.");
	const key = await context.keyProvider.resolve(tuple.workflowId, tuple.keyId, tuple.epochRef);
	if (
		key.keyId !== tuple.keyId ||
		key.validStoreEpoch !== tuple.epochRef.storeEpoch ||
		key.generationId !== tuple.generationId
	)
		throw new Error("Side-record key provider returned a stale or foreign generation key.");
	return key.secret;
}

async function resolveCurrentSideRecordSecret(
	context: WorkflowDescriptorContext,
	tuple: { workflowId: string; keyId: string; epochRef: WorkflowEpochRef; generationId: string },
): Promise<Uint8Array> {
	if (tuple.generationId !== context.generationId || digestObject(tuple.epochRef) !== digestObject(context.epochRef))
		throw new Error("Side-record key tuple is not bound to the opened active generation.");
	return resolveSideRecordSecret(context, tuple);
}

function sideRecordMac(unsigned: unknown, secret: Uint8Array): string {
	return createHmac("sha256", secret).update(canonicalJsonBytes(unsigned)).digest("hex");
}

type WorkflowPendingProofInput = Parameters<WorkflowCommitReturnProofStore["markPending"]>[0];

interface WorkflowReturnProofSideRecord {
	recordVersion: 1;
	generationId: string;
	workflowId: string;
	mutationId: string;
	expectedHead: WorkflowJournalHead;
	epochRef: WorkflowEpochRef;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	idempotencyKey: string;
	keyId: string;
	frameMac: string;
	frameChecksum: string;
	recordMac: string;
	recordChecksum: string;
	priorRecordDigest: string | null;
	state: "pending" | "committed" | "returned";
	pending: WorkflowPendingProofInput;
	proof: WorkflowCommitReturnProof | null;
	sideRecordMac: string;
}

function isWorkflowPendingProofInputValue(value: unknown): value is WorkflowPendingProofInput {
	return exactRecord(
		value,
		[
			"recordVersion",
			"generationId",
			"mutationId",
			"workflowId",
			"expectedSequence",
			"eventDigest",
			"expectedHead",
			"epochRef",
			"leaseRef",
			"writerIdentity",
			"idempotencyKey",
			"keyId",
			"frameMac",
			"frameChecksum",
			"recordMac",
			"recordChecksum",
			"priorRecordDigest",
		],
		{
			recordVersion: (field) => field === 1,
			generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			mutationId: isStringValue,
			workflowId: isStringValue,
			expectedSequence: (field) => isSafeIntegerValue(field) && field > 0,
			eventDigest: isDigestValue,
			expectedHead: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			leaseRef: isLeaseRefValue,
			writerIdentity: isStringValue,
			idempotencyKey: isStringValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			priorRecordDigest: isNullableDigestValue,
		},
	);
}

function isWorkflowReturnProofSideRecordValue(value: unknown): value is WorkflowReturnProofSideRecord {
	return exactRecord(
		value,
		[
			"recordVersion",
			"generationId",
			"workflowId",
			"mutationId",
			"expectedHead",
			"epochRef",
			"leaseRef",
			"writerIdentity",
			"idempotencyKey",
			"keyId",
			"frameMac",
			"frameChecksum",
			"recordMac",
			"recordChecksum",
			"priorRecordDigest",
			"state",
			"pending",
			"proof",
			"sideRecordMac",
		],
		{
			recordVersion: (field) => field === 1,
			generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			workflowId: isStringValue,
			mutationId: isStringValue,
			expectedHead: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			leaseRef: isLeaseRefValue,
			writerIdentity: isStringValue,
			idempotencyKey: isStringValue,
			keyId: isStringValue,
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			recordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			recordChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
			priorRecordDigest: isNullableDigestValue,
			state: (field) => field === "pending" || field === "committed" || field === "returned",
			pending: isWorkflowPendingProofInputValue,
			proof: (field) => field === null || isWorkflowCommitReturnProofValue(field),
			sideRecordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		},
	);
}

function createDescriptorCommitReturnProofStore(context: WorkflowDescriptorContext): WorkflowCommitReturnProofStore {
	const queues = new Map<string, Promise<void>>();
	const authenticate = async (
		pending: WorkflowPendingProofInput,
		state: WorkflowReturnProofSideRecord["state"],
		proof: WorkflowCommitReturnProof | null,
	): Promise<WorkflowReturnProofSideRecord> => {
		const source = proof ?? pending;
		const withoutMac = {
			recordVersion: 1 as const,
			generationId: pending.generationId,
			workflowId: pending.workflowId,
			mutationId: pending.mutationId,
			expectedHead: pending.expectedHead,
			epochRef: pending.epochRef,
			leaseRef: pending.leaseRef,
			writerIdentity: pending.writerIdentity,
			idempotencyKey: pending.idempotencyKey,
			keyId: source.keyId,
			frameMac: source.frameMac,
			frameChecksum: source.frameChecksum,
			recordMac: source.recordMac,
			recordChecksum: source.recordChecksum,
			priorRecordDigest: pending.priorRecordDigest,
			state,
			pending,
			proof,
			sideRecordMac: "",
		};
		const secret = await resolveCurrentSideRecordSecret(context, {
			workflowId: withoutMac.workflowId,
			keyId: withoutMac.keyId,
			epochRef: withoutMac.epochRef,
			generationId: withoutMac.generationId,
		});
		return { ...withoutMac, sideRecordMac: sideRecordMac(withoutMac, secret) };
	};
	const read = async (mutationId: string): Promise<WorkflowReturnProofSideRecord | null> => {
		const bytes = await readWorkflowSideStoreBytes(context, sideStoreRecordComponent("return-proofs", mutationId));
		if (bytes === null) return null;
		const parsedValue = parseCanonicalJsonBytes(bytes);
		if (!isWorkflowReturnProofSideRecordValue(parsedValue))
			throw new Error("Return-proof side record is not a closed host-authenticated tuple.");
		const parsed = parsedValue;
		const secret = await resolveCurrentSideRecordSecret(context, {
			workflowId: parsed.workflowId,
			keyId: parsed.keyId,
			epochRef: parsed.epochRef,
			generationId: parsed.generationId,
		});
		const expectedSideRecordMac = sideRecordMac(
			{
				recordVersion: parsed.recordVersion,
				generationId: parsed.generationId,
				workflowId: parsed.workflowId,
				mutationId: parsed.mutationId,
				expectedHead: parsed.expectedHead,
				epochRef: parsed.epochRef,
				leaseRef: parsed.leaseRef,
				writerIdentity: parsed.writerIdentity,
				idempotencyKey: parsed.idempotencyKey,
				keyId: parsed.keyId,
				frameMac: parsed.frameMac,
				frameChecksum: parsed.frameChecksum,
				recordMac: parsed.recordMac,
				recordChecksum: parsed.recordChecksum,
				priorRecordDigest: parsed.priorRecordDigest,
				state: parsed.state,
				pending: parsed.pending,
				proof: parsed.proof,
				sideRecordMac: "",
			},
			secret,
		);
		if (
			parsed.recordVersion !== 1 ||
			parsed.mutationId !== mutationId ||
			(parsed.state !== "pending" && parsed.state !== "committed" && parsed.state !== "returned") ||
			(parsed.state === "pending" && parsed.proof !== null) ||
			(parsed.state !== "pending" && parsed.proof === null) ||
			!sameFixedHex(parsed.sideRecordMac, expectedSideRecordMac, 32) ||
			parsed.pending.mutationId !== mutationId ||
			parsed.pending.workflowId !== context.workflowId ||
			parsed.keyId.length === 0 ||
			parsed.frameMac.length === 0 ||
			parsed.frameChecksum.length === 0 ||
			parsed.recordMac.length === 0 ||
			parsed.recordChecksum.length === 0
		)
			throw new Error("Return-proof side record is not a closed host-authenticated tuple.");
		return parsed;
	};
	const write = async (mutationId: string, record: WorkflowReturnProofSideRecord): Promise<void> =>
		writeWorkflowSideStoreBytes(
			context,
			sideStoreRecordComponent("return-proofs", mutationId),
			canonicalJsonBytes(record),
		);
	const locked = <T>(mutationId: string, operation: () => Promise<T>): Promise<T> =>
		withKeyedLock(queues, mutationId, operation);
	const store: WorkflowCommitReturnProofStore = {
		markPending: (input) =>
			locked(input.mutationId, async () => {
				const current = await read(input.mutationId);
				if (current !== null && current.state !== "pending")
					throw new Error("Return-proof idempotency key already crossed a durable boundary.");
				if (current !== null && digestObject(current.pending) !== digestObject(input))
					throw new Error("Return-proof pending tuple conflicts with an existing authenticated mutation.");
				await write(input.mutationId, await authenticate(input, "pending", null));
			}),
		markCommitted: (input) =>
			locked(input.mutationId, async () => {
				const current = await read(input.mutationId);
				if (current?.state === "returned") return;
				if (
					current === null ||
					current.pending.workflowId !== input.workflowId ||
					current.pending.mutationId !== input.mutationId ||
					current.pending.expectedSequence !== input.sequence ||
					current.pending.eventDigest !== input.eventDigest ||
					current.pending.idempotencyKey !== input.idempotencyKey ||
					digestObject(current.pending.expectedHead) !== digestObject(input.expectedHead) ||
					digestObject(current.pending.leaseRef) !== digestObject(input.leaseRef) ||
					digestObject(current.pending.epochRef) !== digestObject(input.epochRef) ||
					current.pending.writerIdentity !== input.writerIdentity ||
					current.pending.generationId !== input.generationId ||
					current.pending.priorRecordDigest !== input.priorRecordDigest
				)
					throw new Error(
						"Return-proof commit tuple conflicts with the exact authenticated pending sequence, event, and lease tuple.",
					);
				const proofWithoutDigest = { ...input, returnedAt: "" };
				const proof = {
					...proofWithoutDigest,
					proofDigest: digestObject(proofWithoutDigest),
				} as WorkflowCommitReturnProof;
				await write(
					input.mutationId,
					await authenticate(
						{
							...current.pending,
							keyId: input.keyId,
							frameMac: input.frameMac,
							frameChecksum: input.frameChecksum,
							recordMac: input.recordMac,
							recordChecksum: input.recordChecksum,
						},
						"committed",
						proof,
					),
				);
			}),
		markReturned: (proof) =>
			locked(proof.mutationId, async () => {
				const current = await read(proof.mutationId);
				if (current === null || current.proof === null || current.state !== "committed")
					throw new Error("Return-proof public return is not preceded by an authenticated committed boundary.");
				if (
					digestObject({ ...current.proof, returnedAt: "", proofDigest: "" }) !==
						digestObject({ ...proof, returnedAt: "", proofDigest: "" }) ||
					current.pending.workflowId !== proof.workflowId ||
					current.pending.mutationId !== proof.mutationId ||
					current.pending.idempotencyKey !== proof.idempotencyKey ||
					digestObject(current.pending.expectedHead) !== digestObject(proof.expectedHead) ||
					digestObject(current.pending.leaseRef) !== digestObject(proof.leaseRef) ||
					digestObject(current.pending.epochRef) !== digestObject(proof.epochRef) ||
					current.pending.writerIdentity !== proof.writerIdentity
				)
					throw new Error("Returned proof is not the exact authenticated pending tuple.");
				await write(proof.mutationId, await authenticate(current.pending, "returned", proof));
			}),
		resolve: async (mutationId) => {
			const current = await read(mutationId);
			return current === null ? { state: "pending", proof: null } : { state: current.state, proof: current.proof };
		},
	};
	workflowReturnProofStoreOwners.set(store, context);
	return store;
}

function createDescriptorGenerationRotationStore(context: WorkflowDescriptorContext): WorkflowGenerationRotationStore {
	type RotationFile = Record<string, WorkflowGenerationRotationRecoveryRecord>;
	const queue = new Map<string, Promise<void>>();
	const readRecords = async (): Promise<RotationFile> => {
		const bytes = await readWorkflowSideStoreBytes(context, ["rotations", "records.json"]);
		if (bytes === null) return {};
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isWorkflowGenerationRotationFileValue(parsed) || !sameBytes(canonicalJsonBytes(parsed), bytes))
			throw new Error("Rotation side record index is not a closed durable map.");
		const records = parsed;
		for (const [rotationId, record] of Object.entries(records)) {
			if (
				record.request.rotationId !== rotationId ||
				record.request.previousGenerationId === record.request.generationId ||
				record.request.previousKeyId.length === 0 ||
				record.request.keyId.length === 0 ||
				record.request.previousFrameMac.length === 0 ||
				record.request.frameMac.length === 0
			)
				throw new Error(
					"Rotation side record is missing distinct authenticated predecessor and successor contexts.",
				);
			const artifactRef = record.rotationArtifactRef;
			const artifactBytes = await readWorkflowSideStoreBytes(context, ["rotations", `${rotationId}.json`]);
			if (
				artifactRef.artifactId !== `rotation:${rotationId}` ||
				artifactRef.relativePath !== `rotations/${rotationId}.json` ||
				artifactRef.sourceEventSequence !== record.expectedHead.sequence ||
				artifactBytes === null ||
				artifactRef.sizeBytes !== artifactBytes.byteLength ||
				artifactRef.digest !== sha256Hex(artifactBytes) ||
				!sameBytes(artifactBytes, canonicalJsonBytes(record.request))
			)
				throw new Error("Rotation artifact reference is missing or not bound to its authenticated request bytes.");
			const predecessor = {
				workflowId: record.expectedHead.workflowId,
				keyId: record.request.previousKeyId,
				epochRef: record.request.previousEpoch,
				generationId: record.request.previousGenerationId,
			};
			const successor = {
				workflowId: record.expectedHead.workflowId,
				keyId: record.request.keyId,
				epochRef: record.request.nextEpoch,
				generationId: record.request.generationId,
			};
			const keyContext =
				record.state === "prepared" ||
				(record.state === "quarantined" && record.quarantineReason === "rotation_prepared_only")
					? predecessor
					: successor;
			const secret = await resolveSideRecordSecret(context, keyContext);
			if (!sameFixedHex(record.sideRecordMac, sideRecordMac({ ...record, sideRecordMac: "" }, secret), 32))
				throw new Error(
					"Rotation side record is not a host-keyed authenticated tuple for its predecessor or successor context.",
				);
		}
		return records;
	};
	const writeRecords = async (records: RotationFile): Promise<void> =>
		writeWorkflowSideStoreBytes(context, ["rotations", "records.json"], canonicalJsonBytes(records));
	const readActive = async (): Promise<WorkflowActiveGenerationRecord | null> => {
		const bytes = await readWorkflowSideStoreBytes(context, ["active-generation.json"]);
		if (bytes === null) return null;
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isWorkflowActiveGenerationRecordValue(parsed) || !sameBytes(canonicalJsonBytes(parsed), bytes))
			throw new Error("Active-generation side record is not a canonical closed manifest tuple.");
		const record = parsed;
		const secret = await resolveCurrentSideRecordSecret(context, {
			workflowId: record.workflowId,
			keyId: record.keyId,
			epochRef: record.epochRef,
			generationId: record.generationId,
		});
		if (
			record.workflowId !== context.workflowId ||
			!/^generation-[0-9a-f]{32}$/.test(record.generationId) ||
			record.manifestRef.relativePath !== `${deriveWorkflowGenerationPath(record.generationId)}/ACTIVE` ||
			record.manifestRef.digest !== record.manifestBytesDigest ||
			workflowActiveGenerationManifestBytesDigest(record) !== record.manifestBytesDigest ||
			!sameFixedHex(record.sideRecordMac, sideRecordMac(workflowActiveGenerationRecordUnsigned(record), secret), 32)
		)
			throw new Error("Active-generation side record is not a host-keyed authenticated manifest tuple.");
		const manifestBytes = await readDescriptorBytesIfPresent(context.descriptorFs, context.workflow, [
			"generations",
			record.generationId,
			"ACTIVE",
		]);
		const manifest = manifestBytes === null ? null : parseCanonicalJsonBytes(manifestBytes);
		const canonicalManifestBytes = manifest === null ? null : canonicalJsonBytes(manifest);
		if (
			manifest === null ||
			!isWorkflowActiveGenerationRecordValue(manifest) ||
			canonicalManifestBytes === null ||
			manifestBytes === null ||
			!sameBytes(canonicalManifestBytes, manifestBytes) ||
			canonicalManifestBytes.byteLength !== record.manifestRef.sizeBytes ||
			digestObject(manifest) !== digestObject(record) ||
			workflowActiveGenerationManifestBytesDigest(manifest) !== record.manifestRef.digest ||
			workflowActiveGenerationManifestBytesDigest(manifest) !== record.manifestBytesDigest
		)
			throw new Error(
				"Active-generation manifest is missing, differs from the authenticated side record, or has a mismatched canonical digest.",
			);
		return record;
	};
	const writeRecord = async (
		rotationId: string,
		update: (
			record: WorkflowGenerationRotationRecoveryRecord | undefined,
		) => WorkflowGenerationRotationRecoveryRecord,
	): Promise<WorkflowGenerationRotationRecoveryRecord> => {
		const records = await readRecords();
		const previous = records[rotationId];
		const next = update(previous);
		const keyContext =
			next.state === "prepared" ||
			(next.state === "quarantined" && next.quarantineReason === "rotation_prepared_only")
				? {
						workflowId: next.expectedHead.workflowId,
						keyId: next.request.previousKeyId,
						epochRef: next.request.previousEpoch,
						generationId: next.request.previousGenerationId,
					}
				: {
						workflowId: next.expectedHead.workflowId,
						keyId: next.request.keyId,
						epochRef: next.request.nextEpoch,
						generationId: next.request.generationId,
					};
		const secret = await resolveSideRecordSecret(context, keyContext);
		records[rotationId] = { ...next, sideRecordMac: sideRecordMac({ ...next, sideRecordMac: "" }, secret) };
		await writeRecords(records);
		return records[rotationId];
	};
	const locked = <T>(rotationId: string, operation: () => Promise<T>): Promise<T> =>
		withKeyedLock(queue, rotationId, operation);
	const requireRecord = (
		record: WorkflowGenerationRotationRecoveryRecord | undefined,
		operation: string,
	): WorkflowGenerationRotationRecoveryRecord => {
		if (record === undefined) throw new Error(`Rotation ${operation} has no durable record.`);
		return record;
	};
	const store: WorkflowGenerationRotationStore = {
		async prepare(input) {
			assertSafeIdentifier(input.rotationId, "rotation id");
			return locked(input.rotationId, async () => {
				const records = await readRecords();
				const existing = records[input.rotationId];
				const { expectedHead, ...request } = input;
				if (existing !== undefined) {
					if (digestObject(existing.request) !== digestObject(request))
						throw new Error("Rotation idempotency key conflicts with an authenticated request.");
					return existing.rotationArtifactRef;
				}
				if (
					input.previousGenerationId === input.generationId ||
					!/^generation-[0-9a-f]{32}$/.test(input.previousGenerationId) ||
					!/^generation-[0-9a-f]{32}$/.test(input.generationId) ||
					input.previousKeyId.length === 0 ||
					input.keyId.length === 0 ||
					input.previousFrameMac.length === 0 ||
					input.previousFrameChecksum.length === 0 ||
					input.frameMac.length === 0 ||
					input.frameChecksum.length === 0
				)
					throw new Error(
						"Rotation request must carry distinct, canonical, authenticated predecessor and successor tuples.",
					);
				const artifactBytes = canonicalJsonBytes(request);
				const rotationArtifactRef: WorkflowArtifactRef = {
					artifactId: `rotation:${input.rotationId}`,
					relativePath: `rotations/${input.rotationId}.json`,
					digest: sha256Hex(artifactBytes),
					sizeBytes: artifactBytes.byteLength,
					sourceEventSequence: expectedHead.sequence,
				};
				if (!isArtifactRefValue(rotationArtifactRef))
					throw new Error("Rotation artifact reference is not a canonical authenticated descriptor identity.");
				await writeWorkflowSideStoreBytes(context, ["rotations", `${input.rotationId}.json`], artifactBytes, true);
				const persistedArtifactBytes = await readWorkflowSideStoreBytes(context, [
					"rotations",
					`${input.rotationId}.json`,
				]);
				if (
					persistedArtifactBytes === null ||
					!sameBytes(persistedArtifactBytes, artifactBytes) ||
					sha256Hex(persistedArtifactBytes) !== rotationArtifactRef.digest
				)
					throw new Error(
						"Rotation artifact publication did not durably preserve its authenticated request bytes.",
					);
				const record = {
					request,
					expectedHead,
					rotationArtifactRef,
					activeGenerationManifestRef: input.activeGenerationManifestRef,
					priorRecordDigest: input.priorRecordDigest,
					authenticatedTuple: null,
					state: "prepared" as const,
					fenceEventSequence: null,
					fenceEventDigest: null,
					commitReturnProof: null,
					rotation: null,
					quarantineReason: null,
					lastCheckpoint: "after_rotation_prepare_before_fence" as DurableStoreCrashBoundary,
					checkpointDigest: digestObject({
						rotationId: input.rotationId,
						checkpoint: "after_rotation_prepare_before_fence",
						request,
					}),
					sideRecordMac: "",
				};
				const secret = await resolveSideRecordSecret(context, {
					workflowId: expectedHead.workflowId,
					keyId: request.previousKeyId,
					epochRef: request.previousEpoch,
					generationId: request.previousGenerationId,
				});
				records[input.rotationId] = { ...record, sideRecordMac: sideRecordMac(record, secret) };
				await writeRecords(records);
				return rotationArtifactRef;
			});
		},
		async markLeaseTransferred(rotationId, input, hook) {
			await locked(rotationId, async () => {
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord)
					await hook.before({
						storeId: context.workflowId,
						mutationId: rotationId,
						checkpoint: "after_rotation_lease_transfer_before_record",
					});
				const persisted = await writeRecord(rotationId, (record) => {
					if (
						record === undefined ||
						record.priorRecordDigest !== input.expectedPriorRecordDigest ||
						record.request.nextLeaseRef.leaseId !== input.nextLeaseRef.leaseId ||
						record.request.generationBinding.writerIdentity !== input.writerIdentity ||
						digestObject(record.request.nextEpoch) !== digestObject(input.epochRef)
					)
						throw new Error("Rotation lease transfer does not match the prepared authenticated lease tuple.");
					return {
						...record,
						state: "lease_transferred",
						lastCheckpoint: "after_rotation_lease_transfer_before_record",
						checkpointDigest: digestObject({
							rotationId,
							input,
							checkpoint: "after_rotation_lease_transfer_before_record",
						}),
					};
				});
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord) {
					if (persisted.checkpointDigest === null)
						throw new Error("Rotation lease transfer checkpoint is missing.");
					await hook.after({
						storeId: context.workflowId,
						mutationId: rotationId,
						checkpoint: "after_rotation_lease_transfer_before_record",
						digest: persisted.checkpointDigest,
					});
				}
			});
		},
		async markFenceCommitted(rotationId, input, hook) {
			await locked(rotationId, async () => {
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRecordBeforeManifest)
					await hook.before({
						storeId: context.workflowId,
						mutationId: rotationId,
						checkpoint: "after_rotation_record_before_manifest",
					});
				const persisted = await writeRecord(rotationId, (record) => {
					if (
						record === undefined ||
						record.request.generationId !== input.generationId ||
						record.request.keyId !== input.keyId ||
						record.lastCheckpoint !== "after_rotation_lease_transfer_before_record"
					)
						throw new Error(
							"Rotation fence is not bound to the prepared generation and durable lease checkpoint.",
						);
					return {
						...record,
						state: "fence_committed",
						fenceEventSequence: input.fenceEventSequence,
						fenceEventDigest: input.fenceEventDigest,
						commitReturnProof: input.commitReturnProof,
						lastCheckpoint: "after_rotation_record_before_manifest",
						checkpointDigest: digestObject({
							rotationId,
							input,
							checkpoint: "after_rotation_record_before_manifest",
						}),
					};
				});
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRecordBeforeManifest) {
					if (persisted.checkpointDigest === null) throw new Error("Rotation fence checkpoint is missing.");
					await hook.after({
						storeId: context.workflowId,
						mutationId: rotationId,
						checkpoint: "after_rotation_record_before_manifest",
						digest: persisted.checkpointDigest,
					});
				}
			});
		},
		async selectActiveGenerationManifest(rotation, hook) {
			if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationManifestBeforeCommit)
				await hook.before({
					storeId: context.workflowId,
					mutationId: rotation.rotationId,
					checkpoint: "after_rotation_manifest_before_commit",
				});
			const expectedGenerationId = deriveWorkflowGenerationId({
				workflowId: rotation.expectedHead.workflowId,
				nextEpoch: rotation.nextEpoch,
				rotationId: rotation.rotationId,
				priorHeadDigest: digestObject(rotation.expectedHead),
			});
			if (
				rotation.generationId !== expectedGenerationId ||
				rotation.activeGenerationManifestRef.relativePath !==
					`${deriveWorkflowGenerationPath(expectedGenerationId)}/ACTIVE`
			)
				throw new Error("Active generation manifest is not a canonical authenticated replacement.");
			const manifestRefWithoutDigest = { ...rotation.activeGenerationManifestRef, digest: "", sizeBytes: 0 };
			const manifestDigest = workflowActiveGenerationManifestBytesDigest({
				workflowId: rotation.expectedHead.workflowId,
				generationId: rotation.generationId,
				manifestRef: manifestRefWithoutDigest,
				sourceHead: rotation.expectedHead,
				epochRef: rotation.nextEpoch,
				generationBinding: rotation.generationBinding,
				leaseRef: rotation.nextLeaseRef,
				keyId: rotation.keyId,
				frameMac: rotation.frameMac,
				frameChecksum: rotation.frameChecksum,
				priorRecordDigest: rotation.priorRecordDigest,
				manifestBytesDigest: "",
				sideRecordMac: "",
			});
			if (rotation.activeGenerationManifestRef.digest !== manifestDigest)
				throw new Error("Successor active-generation ref is not bound to its canonical manifest bytes.");
			const recordWithoutMac = {
				workflowId: rotation.expectedHead.workflowId,
				generationId: rotation.generationId,
				manifestRef: rotation.activeGenerationManifestRef,
				manifestBytesDigest: manifestDigest,
				sourceHead: rotation.expectedHead,
				epochRef: rotation.nextEpoch,
				generationBinding: rotation.generationBinding,
				leaseRef: rotation.nextLeaseRef,
				keyId: rotation.keyId,
				frameMac: rotation.frameMac,
				frameChecksum: rotation.frameChecksum,
				priorRecordDigest: rotation.priorRecordDigest,
			};
			const secret = await resolveSideRecordSecret(context, {
				workflowId: recordWithoutMac.workflowId,
				keyId: recordWithoutMac.keyId,
				epochRef: recordWithoutMac.epochRef,
				generationId: recordWithoutMac.generationId,
			});
			const activeManifest = buildAuthenticatedActiveGenerationRecord({ record: recordWithoutMac, secret });
			const activeRecord = activeManifest.record;
			await writeDescriptorBytes(
				context.descriptorFs,
				context.root,
				["workflows", context.workflowId, "generations", rotation.generationId, "ACTIVE"],
				activeManifest.bytes,
				true,
			);
			await assertDescriptorContextIdentity(context);
			await writeWorkflowSideStoreBytes(context, ["active-generation.json"], activeManifest.bytes);
			await locked(rotation.rotationId, async () => {
				await writeRecord(rotation.rotationId, (record) => {
					if (record === undefined || record.state !== "fence_committed")
						throw new Error("Active-generation publication is not preceded by the durable fence checkpoint.");
					return {
						...record,
						lastCheckpoint: "after_rotation_manifest_before_commit",
						checkpointDigest: digestObject({
							rotationId: rotation.rotationId,
							activeRecord,
							checkpoint: "after_rotation_manifest_before_commit",
						}),
					};
				});
			});
			if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationManifestBeforeCommit)
				await hook.after({
					storeId: context.workflowId,
					mutationId: rotation.rotationId,
					checkpoint: "after_rotation_manifest_before_commit",
					digest: activeRecord.sideRecordMac,
				});
		},
		async commit(rotation, hook) {
			await locked(rotation.rotationId, async () => {
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationCommitBeforeRetire)
					await hook.before({
						storeId: context.workflowId,
						mutationId: rotation.rotationId,
						checkpoint: "after_rotation_commit_before_retire",
					});
				const persisted = await writeRecord(rotation.rotationId, (record) => {
					if (record === undefined || record.lastCheckpoint !== "after_rotation_manifest_before_commit")
						throw new Error("Rotation commit has no durable manifest checkpoint.");
					return {
						...record,
						state: "committed",
						rotation,
						lastCheckpoint: "after_rotation_commit_before_retire",
						checkpointDigest: digestObject({
							rotationId: rotation.rotationId,
							rotation,
							checkpoint: "after_rotation_commit_before_retire",
						}),
					};
				});
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationCommitBeforeRetire) {
					if (persisted.checkpointDigest === null) throw new Error("Rotation commit checkpoint is missing.");
					await hook.after({
						storeId: context.workflowId,
						mutationId: rotation.rotationId,
						checkpoint: "after_rotation_commit_before_retire",
						digest: persisted.checkpointDigest,
					});
				}
			});
		},
		async retirePreviousGeneration(rotationId, hook) {
			await locked(rotationId, async () => {
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRetireBeforeRebind)
					await hook.before({
						storeId: context.workflowId,
						mutationId: rotationId,
						checkpoint: "after_rotation_retire_before_rebind",
					});
				const persisted = await writeRecord(rotationId, (record) => {
					const existing = requireRecord(record, "retire");
					if (existing.lastCheckpoint !== "after_rotation_commit_before_retire")
						throw new Error("Rotation retirement lacks a durable commit checkpoint.");
					return {
						...existing,
						state: existing.rotation === null ? existing.state : "retired",
						lastCheckpoint: "after_rotation_retire_before_rebind",
						checkpointDigest: digestObject({
							rotationId,
							checkpoint: "after_rotation_retire_before_rebind",
							prior: existing.checkpointDigest,
						}),
					};
				});
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRetireBeforeRebind) {
					if (persisted.checkpointDigest === null) throw new Error("Rotation retirement checkpoint is missing.");
					await hook.after({
						storeId: context.workflowId,
						mutationId: rotationId,
						checkpoint: "after_rotation_retire_before_rebind",
						digest: persisted.checkpointDigest,
					});
				}
			});
		},
		async quarantine(rotationId, reason) {
			await locked(rotationId, async () => {
				await writeRecord(rotationId, (record) => {
					const existing = requireRecord(record, "quarantine");
					return { ...existing, state: "quarantined", quarantineReason: reason };
				});
			});
		},
		async resolve(rotationId) {
			return (await readRecords())[rotationId] ?? null;
		},
		async listUnfinished(workflowId) {
			return Object.values(await readRecords()).filter(
				(record) =>
					record.expectedHead.workflowId === workflowId &&
					(record.state !== "committed" || record.request.previousGenerationId === context.generationId) &&
					record.state !== "retired" &&
					record.state !== "quarantined",
			);
		},
		async readActiveGeneration(workflowId) {
			const record = await readActive();
			return record?.workflowId === workflowId ? record : null;
		},
		async readRotationForGeneration(generationId) {
			const records = Object.values(await readRecords()).filter(
				(record) => record.request.generationId === generationId,
			);
			if (records.length > 1) throw new Error("Workflow generation has multiple authenticated rotation records.");
			return records[0] ?? null;
		},
	};
	workflowRotationStoreOwners.set(store, context);
	return store;
}

export function createWorkflowOwnerValidators(): WorkflowJournalOwnerValidators {
	return {
		validateOpen: (input) => {
			if (
				input.workflowId.length === 0 ||
				input.rootSessionId.length === 0 ||
				input.epochRef.storeEpoch < 1 ||
				input.epochRef.coordinatorEpoch < 1
			)
				throw new Error("Journal open owner validation failed.");
		},
		validateReplay: (event) => {
			if (
				event.workflowId.length === 0 ||
				event.payloadBytes.byteLength === 0 ||
				event.eventDigest.length === 0 ||
				event.commitReturnProof.proofDigest.length === 0
			)
				throw new Error("Journal replay owner validation failed.");
		},
		validateCommit: (input) => {
			if (
				input.workflowId.length === 0 ||
				input.writerIdentity.length === 0 ||
				input.idempotencyKey.length === 0 ||
				input.returnProofId !== `return-proof:${input.idempotencyKey}`
			)
				throw new Error("Journal commit owner validation failed.");
		},
		validateSemanticPreflight: (input) => {
			if (
				input.preview.workflowId.length === 0 ||
				input.preview.ownerId.length === 0 ||
				input.preview.phase.length === 0 ||
				input.preview.reducerDigest.length === 0 ||
				input.preview.payloadDigest.length === 0 ||
				input.payload.kind.length === 0
			)
				throw new Error("Journal semantic owner preflight failed.");
		},
	};
}

export class WorkflowArtifactStore implements WorkflowArtifactPublisher {
	private constructor(private readonly journal: WorkflowJournalImpl) {}

	static fromJournal(journal: WorkflowJournalImpl): WorkflowArtifactStore {
		return new WorkflowArtifactStore(journal);
	}

	publish(
		input: WorkflowArtifactPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowArtifactPublishResult> {
		return publishWorkflowArtifact(
			this.journal.descriptorContext,
			this.journal.options.appendLease,
			{
				writerIdentity: this.journal.options.writerIdentity,
				leaseRef: this.journal.options.leaseRef,
				epochRef: this.journal.options.epoch,
			},
			input,
			hook,
		);
	}

	resolve(ref: WorkflowArtifactRef): Promise<WorkflowArtifactReadResult> {
		return resolveWorkflowArtifact(this.journal.descriptorContext, ref);
	}
}

export class WorkflowSnapshotStore implements WorkflowSnapshotPublisher {
	private constructor(private readonly journal: WorkflowJournalImpl) {}

	static fromJournal(journal: WorkflowJournalImpl): WorkflowSnapshotStore {
		return new WorkflowSnapshotStore(journal);
	}

	publish(
		input: WorkflowSnapshotPublishInput,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowSnapshotPublishResult> {
		return publishWorkflowSnapshot(this.journal.descriptorContext, this.journal.options.appendLease, input, hook);
	}
}

export class WorkflowOutboxStore implements WorkflowOutboxAppender {
	private constructor(private readonly journal: WorkflowJournalImpl) {}

	static fromJournal(journal: WorkflowJournalImpl): WorkflowOutboxStore {
		return new WorkflowOutboxStore(journal);
	}

	append(input: WorkflowOutboxAppendInput, hook?: DurableStoreCrashBoundaryHook): Promise<WorkflowOutboxAppendResult> {
		return appendWorkflowOutbox(this.journal.descriptorContext, this.journal.options.appendLease, input, hook);
	}

	recover(expectedEpoch: WorkflowEpochRef): Promise<WorkflowOutboxRecoveryResult> {
		return recoverWorkflowOutbox(this.journal.descriptorContext, expectedEpoch);
	}
}

export class WorkflowJournalImpl implements WorkflowJournal {
	readonly options: WorkflowJournalOptions;

	constructor(
		options: WorkflowJournalOptions,
		public storage: WorkflowJournalDurableStorage,
		public descriptorContext: WorkflowDescriptorContext,
		public returnProofStore: WorkflowCommitReturnProofStore,
		public rotationStore: WorkflowGenerationRotationStore,
	) {
		let epoch = { ...options.epoch };
		let leaseRef = { ...options.leaseRef };
		let writerIdentity = options.writerIdentity;
		let keyProvider = options.keyProvider;
		let successorContextOpener = options.successorContextOpener;
		const journalOptions = { ...options };
		Object.defineProperties(journalOptions, {
			epoch: {
				configurable: false,
				enumerable: true,
				get: () => epoch,
				set: (next: WorkflowEpochRef) => {
					epoch = { ...next };
				},
			},
			leaseRef: {
				configurable: false,
				enumerable: true,
				get: () => leaseRef,
				set: (next: WorkflowLeaseRef) => {
					leaseRef = { ...next };
				},
			},
			writerIdentity: {
				configurable: false,
				enumerable: true,
				get: () => writerIdentity,
				set: (next: string) => {
					writerIdentity = next;
				},
			},
			keyProvider: {
				configurable: false,
				enumerable: true,
				get: () => keyProvider,
				set: (next: WorkflowJournalKeyProvider) => {
					keyProvider = next;
				},
			},
			successorContextOpener: {
				configurable: false,
				enumerable: true,
				get: () => successorContextOpener,
				set: (next: WorkflowGenerationContextOpener) => {
					successorContextOpener = next;
				},
			},
		});
		this.options = journalOptions;
		workflowGoalProjectionHeadGenerations.set(this, { value: 0 });
		bindWorkflowGoalProjectionDurableAuthority(this.options, descriptorContext.generationId);
	}

	get journalPath(): string {
		return this.storage.diagnosticPath;
	}

	static open(options: WorkflowJournalOptions): Promise<WorkflowJournalImpl> {
		return createWorkflowSessionPublicationFactory(options).then((publication) => publication.journal);
	}

	async append(input: WorkflowJournalAppendInput): Promise<WorkflowJournalEvent> {
		return appendWorkflowEvent(this, input);
	}

	replay(): Promise<readonly WorkflowJournalEvent[]> {
		return replayWorkflowEvents(this);
	}

	replayLogicalHistory(): Promise<readonly WorkflowJournalEvent[]> {
		return replayLogicalJournalHistory(this);
	}

	authorizeGoalProjection(
		input: WorkflowGoalProjectionAuthorizationRequest,
	): Promise<WorkflowGoalProjectionAuthorization> {
		return authorizeWorkflowGoalProjection(this, input);
	}

	inspectRecovery(): Promise<WorkflowJournalRecoveryInspection | null> {
		return inspectWorkflowJournalRecovery(this);
	}

	recover(): Promise<WorkflowJournalRecoveryResult> {
		return recoverWorkflowJournal(this);
	}

	currentLeaseRef(): WorkflowLeaseRef {
		return { ...this.options.leaseRef };
	}

	rotateGeneration(
		input: WorkflowGenerationRotationRequest,
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<WorkflowGenerationRotation> {
		return rotateJournalGeneration(this, input, hook);
	}

	async rebindSuccessor(
		context: WorkflowGenerationContext,
		expected: { generationId: string; epochRef: WorkflowEpochRef; head: WorkflowJournalHead },
	): Promise<void> {
		const reject = async (message: string): Promise<never> => {
			await closeDescriptorContextHandles(context.descriptorContext, this.descriptorContext);
			throw new Error(message);
		};
		if (!isWorkflowGenerationContextImplementation(context))
			return reject("Successor generation context lacks its concrete authenticated binding operation.");
		const descriptor = context.descriptorContext;
		const expectedSessionRoot = this.options.descriptorRoots.sessionRoot;
		const expectedWorkflowRoot = this.options.descriptorRoots.workflowRoot;
		const binding = context.successorBinding;
		if (
			context.workflowId !== this.options.workflowId ||
			context.rootSessionId !== this.options.rootSessionId ||
			context.rootDigest !== this.descriptorContext.rootDigest ||
			descriptor.workflowId !== this.options.workflowId ||
			descriptor.sessionRoot.rootSessionId !== expectedSessionRoot.rootSessionId ||
			descriptor.sessionRoot.descriptorRoot !== expectedSessionRoot.descriptorRoot ||
			descriptor.sessionRoot.identityDigest !== expectedSessionRoot.identityDigest ||
			descriptor.workflowRoot.workflowId !== expectedWorkflowRoot.workflowId ||
			descriptor.workflowRoot.descriptorRoot !== expectedWorkflowRoot.descriptorRoot ||
			descriptor.workflowRoot.identityDigest !== expectedWorkflowRoot.identityDigest ||
			descriptor.rootDigest !== this.descriptorContext.rootDigest ||
			descriptor.root === descriptor.workflow ||
			descriptor.root === this.descriptorContext.root ||
			descriptor.workflow === this.descriptorContext.workflow ||
			descriptor.generationId !== expected.generationId ||
			digestObject(descriptor.epochRef) !== digestObject(expected.epochRef) ||
			descriptor.keyProvider !== context.successorKeyProvider ||
			context.successorKeyId.length === 0 ||
			binding.generationId !== expected.generationId ||
			digestObject(binding.epochRef) !== digestObject(expected.epochRef) ||
			binding.leaseRef.rootDigest !== this.descriptorContext.rootDigest ||
			binding.writerIdentity.length === 0 ||
			context.replayHead.workflowId !== this.options.workflowId ||
			context.replayHead.sequence !== expected.head.sequence ||
			context.replayHead.workflowId !== expected.head.workflowId ||
			context.replayHead.eventDigest !== expected.head.eventDigest ||
			digestObject(context.replayHead.epochRef) !== digestObject(expected.head.epochRef) ||
			context.seededStateDigest.length === 0 ||
			!isWorkflowJournalDurableStoragePort(context.storage) ||
			!storageBelongsToContext(context.storage, descriptor) ||
			workflowReturnProofStoreOwners.get(context.returnProofStore) !== descriptor ||
			workflowRotationStoreOwners.get(context.rotationStore) !== descriptor
		)
			return reject(
				"Successor generation context is not a distinct authenticated workflow, descriptor, replay head, binding, and durable storage.",
			);
		const successorKey = await descriptor.keyProvider
			.current(this.options.workflowId, expected.epochRef)
			.catch(() => null);
		if (
			successorKey === null ||
			successorKey.keyId !== context.successorKeyId ||
			successorKey.validStoreEpoch !== expected.epochRef.storeEpoch ||
			successorKey.generationId !== expected.generationId
		)
			return reject("Successor generation context does not carry the authenticated successor key provider.");
		const predecessorRotation = await readRotationForGeneration(context.rotationStore, expected.generationId);
		if (
			predecessorRotation === null ||
			(predecessorRotation.state !== "committed" && predecessorRotation.state !== "retired") ||
			predecessorRotation.rotation === null ||
			predecessorRotation.request.previousGenerationId !== this.descriptorContext.generationId ||
			predecessorRotation.request.generationId !== expected.generationId
		)
			return reject("Successor context lacks its authenticated predecessor rotation record.");
		let predecessorJournal: WorkflowJournalImpl | undefined;
		try {
			predecessorJournal = await openGenerationJournalForReplay(
				{ ...this.options, keyProvider: context.successorKeyProvider },
				predecessorRotation.request,
			);
			assertSuccessorPredecessorFence(await replayLogicalJournalHistory(predecessorJournal), {
				workflowId: this.options.workflowId,
				generationId: expected.generationId,
				head: expected.head,
			});
		} catch {
			return reject("Successor predecessor journal or terminal fence is not authenticated.");
		} finally {
			if (predecessorJournal !== undefined) {
				await predecessorJournal.descriptorContext.workflow.close().catch(() => undefined);
				await predecessorJournal.descriptorContext.root.close().catch(() => undefined);
			}
		}
		try {
			await context.bindSuccessor({ ...binding });
		} catch (error) {
			await closeDescriptorContextHandles(context.descriptorContext, this.descriptorContext);
			throw error;
		}
		if (
			context.successorBinding.generationId !== expected.generationId ||
			digestObject(context.successorBinding.epochRef) !== digestObject(expected.epochRef) ||
			context.successorBinding.leaseRef.rootDigest !== this.descriptorContext.rootDigest ||
			context.successorBinding.writerIdentity.length === 0
		)
			return reject("Successor generation binding changed while it was being atomically installed.");
		await Promise.all([
			this.descriptorContext.root.close().catch(() => undefined),
			this.descriptorContext.workflow.close().catch(() => undefined),
		]);
		this.storage = context.storage;
		this.descriptorContext = context.descriptorContext;
		this.returnProofStore = context.returnProofStore;
		this.rotationStore = context.rotationStore;
		this.options.epoch = context.successorBinding.epochRef;
		this.options.leaseRef = context.successorBinding.leaseRef;
		this.options.writerIdentity = context.successorBinding.writerIdentity;
		this.options.keyProvider = descriptor.keyProvider;
		bindWorkflowGoalProjectionDurableAuthority(this.options, this.descriptorContext.generationId);
		workflowGoalProjectionHeadGeneration(this).value += 1;
	}
}

export const WorkflowJournal = WorkflowJournalImpl;

export interface WorkflowSessionPublicationFactory {
	readonly journal: WorkflowJournalImpl;
	readonly artifacts: WorkflowArtifactStore;
	readonly snapshots: WorkflowSnapshotStore;
	readonly outbox: WorkflowOutboxStore;
	readonly returnProofStore: WorkflowCommitReturnProofStore;
	readonly rotationStore: WorkflowGenerationRotationStore;
}

/**
 * Open the one descriptor-rooted publication context for a session workflow.
 * Args:
 * input: Fully validated session-artifact root and authenticated journal options.
 * Return: All durable publication ports bound to the same validated root and session.
 */
export async function createWorkflowSessionPublicationFactory(
	input: WorkflowJournalOptions,
): Promise<WorkflowSessionPublicationFactory> {
	assertSessionRootIdentity(input.sessionArtifactRoot, input.artifactRoot, input.rootSessionId, input.workflowId);
	const journal = await openWorkflowJournal(input);
	return {
		journal,
		artifacts: WorkflowArtifactStore.fromJournal(journal),
		snapshots: WorkflowSnapshotStore.fromJournal(journal),
		outbox: WorkflowOutboxStore.fromJournal(journal),
		returnProofStore: journal.returnProofStore,
		rotationStore: journal.rotationStore,
	};
}

/**
 * Create the descriptor-rooted opener used by generation rotation.
 * Args:
 * baseOptions: The currently opened generation's authenticated journal options.
 * Return: A successor opener that opens the next generation and exposes only its fenced context.
 */
export function createWorkflowGenerationContextOpener(
	baseOptions: WorkflowJournalOptions,
): WorkflowGenerationContextOpener {
	let opener: WorkflowGenerationContextOpener;
	opener = {
		openSuccessor: (input) => openWorkflowGenerationContextSuccessor(baseOptions, opener, input),
	};
	return opener;
}

type WorkflowGenerationContextOpenInput = Parameters<WorkflowGenerationContextOpener["openSuccessor"]>[0];

function assertWorkflowGenerationContextOpenInput(
	baseOptions: WorkflowJournalOptions,
	input: WorkflowGenerationContextOpenInput,
): void {
	const { rotation, predecessorHead } = input;
	if (input.workflowId !== baseOptions.workflowId || input.rootSessionId !== baseOptions.rootSessionId)
		throw new Error("Successor opener workflow or root-session binding is foreign to the predecessor context.");
	assertSessionRootIdentity(
		baseOptions.sessionArtifactRoot,
		baseOptions.artifactRoot,
		baseOptions.rootSessionId,
		baseOptions.workflowId,
	);
	assertWorkflowIdentity(baseOptions.artifactRoot, baseOptions.workflowDir, baseOptions.workflowId);
	assertSafeIdentifier(rotation.rotationId, "rotation id");
	const expectedRootDigest = digestObject({
		descriptorIdentity: baseOptions.descriptorRoots.sessionRoot.identityDigest,
		workflowIdentity: baseOptions.descriptorRoots.workflowRoot.identityDigest,
		workflowId: baseOptions.workflowId,
	});
	const expectedGenerationId = deriveWorkflowGenerationId({
		workflowId: baseOptions.workflowId,
		nextEpoch: rotation.nextEpoch,
		rotationId: rotation.rotationId,
		priorHeadDigest: digestObject(predecessorHead),
	});
	const validStoreAdvance =
		rotation.nextEpoch.storeEpoch === rotation.previousEpoch.storeEpoch + 1 &&
		rotation.nextEpoch.coordinatorEpoch === rotation.previousEpoch.coordinatorEpoch;
	const validCoordinatorAdvance =
		rotation.nextEpoch.storeEpoch === rotation.previousEpoch.storeEpoch &&
		rotation.nextEpoch.coordinatorEpoch === rotation.previousEpoch.coordinatorEpoch + 1;
	if (
		input.predecessorRootDigest !== expectedRootDigest ||
		rotation.status !== "committed" ||
		digestObject(rotation.expectedHead) !== digestObject(predecessorHead) ||
		rotation.expectedHead.workflowId !== baseOptions.workflowId ||
		digestObject(rotation.expectedHead.epochRef) !== digestObject(rotation.previousEpoch) ||
		rotation.previousWriterIdentity !== baseOptions.writerIdentity ||
		digestObject(rotation.previousLeaseRef) !== digestObject(baseOptions.leaseRef) ||
		digestObject(rotation.previousEpoch) !== digestObject(baseOptions.epoch) ||
		(!validStoreAdvance && !validCoordinatorAdvance) ||
		rotation.generationId !== expectedGenerationId ||
		rotation.activeGenerationManifestRef.relativePath !==
			`${deriveWorkflowGenerationPath(expectedGenerationId)}/ACTIVE` ||
		rotation.nextLeaseRef.rootDigest !== input.predecessorRootDigest ||
		rotation.nextLeaseRef.writerIdentity !== rotation.generationBinding.writerIdentity ||
		rotation.nextLeaseRef.storeEpoch !== rotation.nextEpoch.storeEpoch ||
		rotation.nextLeaseRef.coordinatorEpoch !== rotation.nextEpoch.coordinatorEpoch ||
		rotation.generationBinding.writerIdentity.length === 0 ||
		rotation.generationBinding.processGenerationId.length === 0 ||
		rotation.generationBinding.ownerIdentity !== rotation.generationBinding.writerIdentity ||
		!isDigestValue(rotation.fenceEventDigest) ||
		!Number.isSafeInteger(rotation.fenceEventSequence) ||
		rotation.fenceEventSequence < 1 ||
		rotation.rotationId.length === 0 ||
		rotation.keyId.length === 0
	)
		throw new Error("Successor opener input is not bound to the authenticated predecessor generation and head.");
}

async function openWorkflowGenerationContextSuccessor(
	baseOptions: WorkflowJournalOptions,
	opener: WorkflowGenerationContextOpener,
	input: WorkflowGenerationContextOpenInput,
): Promise<WorkflowGenerationContext> {
	assertWorkflowGenerationContextOpenInput(baseOptions, input);
	const rotation = input.rotation;
	const seedHead = derivePostFenceHead(rotation);
	const successorOptions: WorkflowJournalOptions = {
		...baseOptions,
		epoch: { ...rotation.nextEpoch },
		writerIdentity: rotation.generationBinding.writerIdentity,
		leaseRef: { ...rotation.nextLeaseRef },
		successorContextOpener: opener,
	};
	const successorJournal = await openWorkflowJournal(successorOptions, true);
	try {
		if (
			successorJournal.descriptorContext.generationId !== rotation.generationId ||
			successorJournal.descriptorContext.rootDigest !== input.predecessorRootDigest ||
			successorJournal.descriptorContext.workflowId !== input.workflowId ||
			successorJournal.descriptorContext.root === successorJournal.descriptorContext.workflow
		)
			throw new Error("Successor opener returned a foreign or non-distinct descriptor context.");
		const activeGeneration = await successorJournal.rotationStore.readActiveGeneration(input.workflowId);
		if (
			activeGeneration === null ||
			activeGeneration.generationId !== rotation.generationId ||
			activeGeneration.manifestRef.artifactId !== rotation.activeGenerationManifestRef.artifactId ||
			activeGeneration.manifestRef.relativePath !== rotation.activeGenerationManifestRef.relativePath ||
			activeGeneration.manifestRef.digest !== rotation.activeGenerationManifestRef.digest ||
			activeGeneration.manifestRef.sourceEventSequence !==
				rotation.activeGenerationManifestRef.sourceEventSequence ||
			digestObject(activeGeneration.sourceHead) !== digestObject(input.predecessorHead) ||
			digestObject(activeGeneration.epochRef) !== digestObject(rotation.nextEpoch) ||
			digestObject(activeGeneration.generationBinding) !== digestObject(rotation.generationBinding) ||
			digestObject(activeGeneration.leaseRef) !== digestObject(rotation.nextLeaseRef) ||
			activeGeneration.keyId !== rotation.keyId ||
			activeGeneration.priorRecordDigest !== rotation.priorRecordDigest
		)
			throw new Error(
				"Successor opener active-generation proof does not preserve the authenticated predecessor head.",
			);
		const rotationRecord = await readRotationForGeneration(successorJournal.rotationStore, rotation.generationId);
		if (
			rotationRecord === null ||
			(rotationRecord.state !== "committed" && rotationRecord.state !== "retired") ||
			rotationRecord.rotation === null ||
			digestObject(rotationRecord.expectedHead) !== digestObject(input.predecessorHead) ||
			digestObject(rotationRecord.rotation) !== digestObject(rotation)
		)
			throw new Error("Successor opener rotation record is not bound to its authenticated predecessor fence.");
		let predecessorJournal: WorkflowJournalImpl | undefined;
		try {
			predecessorJournal = await openGenerationJournalForReplay(successorJournal.options, rotationRecord.request);
			const predecessorEvents = await replayLogicalJournalHistory(predecessorJournal);
			const predecessorHead = journalHeadBeforeRotationFence(
				predecessorEvents,
				rotationRecord.request,
				rotationRecord.rotation,
				input.workflowId,
			);
			if (digestObject(predecessorHead) !== digestObject(input.predecessorHead))
				throw new Error("Successor opener predecessor journal does not end at its authenticated rotation head.");
			assertSuccessorPredecessorFence(predecessorEvents, {
				workflowId: input.workflowId,
				generationId: rotation.generationId,
				head: derivePostFenceHead(rotation),
			});
		} finally {
			if (predecessorJournal !== undefined) {
				await predecessorJournal.descriptorContext.workflow.close().catch(() => undefined);
				await predecessorJournal.descriptorContext.root.close().catch(() => undefined);
			}
		}
		const successorKey = await successorJournal.descriptorContext.keyProvider.current(
			input.workflowId,
			rotation.nextEpoch,
		);
		if (
			successorKey.keyId !== rotation.keyId ||
			successorKey.validStoreEpoch !== rotation.nextEpoch.storeEpoch ||
			successorKey.generationId !== rotation.generationId
		)
			throw new Error("Successor opener key provider did not bind the activated generation key.");
		await successorOptions.appendLease.assertOwned({
			workflowId: input.workflowId,
			writerIdentity: rotation.generationBinding.writerIdentity,
			leaseRef: rotation.nextLeaseRef,
			epochRef: rotation.nextEpoch,
			rootDigest: input.predecessorRootDigest,
			boundary: "successor-open-bind",
		});
		const events = await successorJournal.replay();
		if (events.length > 0)
			throw new Error("Successor generation contains events before its authenticated predecessor seed.");
		const expectedBinding: WorkflowGenerationContextBinding = {
			generationId: rotation.generationId,
			epochRef: { ...rotation.nextEpoch },
			leaseRef: { ...rotation.nextLeaseRef },
			writerIdentity: rotation.generationBinding.writerIdentity,
		};
		let successorContext: WorkflowGenerationContextImplementation;
		const successorStorage: WorkflowDescriptorStorage = {
			...successorJournal.storage,
			append: async () => {
				throw new Error(
					"Successor context storage does not accept raw frame copies before the authenticated seed.",
				);
			},
			read: () => successorJournal.storage.readJournalBytes(),
			sync: async () => {
				await assertDescriptorContextIdentity(successorJournal.descriptorContext);
			},
		};
		successorContext = {
			workflowId: input.workflowId,
			rootSessionId: input.rootSessionId,
			rootDigest: successorJournal.descriptorContext.rootDigest,
			successorKeyId: rotation.keyId,
			successorKeyProvider: successorJournal.descriptorContext.keyProvider,
			successorBinding: { ...expectedBinding },
			descriptorContext: successorJournal.descriptorContext,
			storage: successorStorage,
			returnProofStore: successorJournal.returnProofStore,
			rotationStore: successorJournal.rotationStore,
			replayHead: { ...seedHead, epochRef: { ...seedHead.epochRef } },
			seededStateDigest: digestObject({
				generationId: rotation.generationId,
				predecessorHead: input.predecessorHead,
				predecessorRootDigest: input.predecessorRootDigest,
				seedHead,
			}),
			appendSuccessorFence: async () => {
				throw new Error("The predecessor generation fence is the sole authenticated epoch transition event.");
			},
			bindSuccessor: (binding) => {
				if (
					binding.generationId !== expectedBinding.generationId ||
					digestObject(binding.epochRef) !== digestObject(expectedBinding.epochRef) ||
					digestObject(binding.leaseRef) !== digestObject(expectedBinding.leaseRef) ||
					binding.writerIdentity !== expectedBinding.writerIdentity
				)
					throw new Error("Successor binding changed outside the authenticated opener tuple.");
				successorContext.successorBinding = {
					generationId: binding.generationId,
					epochRef: { ...binding.epochRef },
					leaseRef: { ...binding.leaseRef },
					writerIdentity: binding.writerIdentity,
				};
			},
		};
		return successorContext;
	} catch (error) {
		await closeDescriptorContextHandles(successorJournal.descriptorContext);
		throw error;
	}
}
type WorkflowEventShapeRegistry = {
	readonly [K in WorkflowEventType]: {
		readonly keys: readonly string[];
		readonly fields: Readonly<Record<string, (value: unknown) => boolean>>;
	};
};

const isWorkflowStatusValue = (value: unknown): boolean =>
	["active", "awaiting_user", "paused", "budget_limited", "blocked", "failed", "cancelled", "complete"].includes(
		String(value),
	);
const isWorkflowPhaseValue = (value: unknown): boolean =>
	[
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
	].includes(String(value));
const isBooleanValue = (value: unknown): boolean => typeof value === "boolean";
const isFiniteNumberValue = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
const isStringArrayValue = (value: unknown): boolean => Array.isArray(value) && value.every(isStringValue);
const isIntegerArrayValue = (value: unknown): boolean =>
	Array.isArray(value) && value.every((entry) => isSafeIntegerValue(entry));
const isRecursiveRecordValue = (value: unknown): boolean =>
	isRecord(value) && Object.entries(value).every(([key, field]) => key.length > 0 && isRecursiveEventValue(field));
const isRecursiveArrayValue = (value: unknown): boolean =>
	Array.isArray(value) && value.every((entry) => isRecursiveEventValue(entry));
const isRecursiveEventValue = (value: unknown): boolean =>
	value === null ||
	isStringValue(value) ||
	isFiniteNumberValue(value) ||
	isBooleanValue(value) ||
	(Array.isArray(value) ? isRecursiveArrayValue(value) : isRecursiveRecordValue(value));
const isNullablePrefixValue = (value: unknown): boolean => value === null || isPrefixValue(value);
const isNullableLeaseRecordValue = (value: unknown): boolean => value === null || isLeaseRecordValue(value);
const isDecisionRefArrayValue = (value: unknown): boolean => Array.isArray(value) && value.every(isDecisionRefValue);
const isApprovalDecisionRolesValue = (value: unknown): boolean =>
	exactRecord(value, ["goal", "scorecard", "resource"], {
		goal: isDecisionRefValue,
		scorecard: isDecisionRefValue,
		resource: isDecisionRefValue,
	}) &&
	new Set([
		digestObject((value as { goal: unknown }).goal),
		digestObject((value as { scorecard: unknown }).scorecard),
		digestObject((value as { resource: unknown }).resource),
	]).size === 3;
const isChildAuthorityValue = (value: unknown): boolean =>
	exactRecord(value, ["capabilities", "writeClass", "parentAttemptId", "rootSpawned"], {
		capabilities: isStringArrayValue,
		writeClass: isStringValue,
		parentAttemptId: isNullableStringValue,
		rootSpawned: isBooleanValue,
	});
const isApprovalOptionArrayValue = (value: unknown): boolean =>
	Array.isArray(value) &&
	value.length > 0 &&
	value.every((option) =>
		exactRecord(option, ["optionId", "label", "effectDigest"], {
			optionId: isStringValue,
			label: isStringValue,
			effectDigest: isStringValue,
		}),
	);
const isApprovalRequestValue = (value: unknown): boolean => {
	if (
		!isRecord(value) ||
		!exactRecord(
			value,
			[
				"approvalRequestId",
				"decisionRef",
				"decisionRefs",
				"decisionRoles",
				"headDigest",
				"stateDigest",
				"configDigest",
				"profileDigest",
				"artifactDigest",
				"storeEpoch",
				"tokenHash",
				"tokenHashAlgorithm",
				"trustedPrincipal",
				"requestingClientSessionId",
				"expectedResponseSequence",
				"expiresAt",
				"question",
				"options",
				"workflowId",
				"coordinatorEpoch",
			],
			{
				approvalRequestId: isStringValue,
				decisionRef: isDecisionRefValue,
				decisionRefs: isDecisionRefArrayValue,
				decisionRoles: isApprovalDecisionRolesValue,
				headDigest: isStringValue,
				stateDigest: isStringValue,
				configDigest: isStringValue,
				profileDigest: isStringValue,
				artifactDigest: isStringValue,
				storeEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
				tokenHash: isStringValue,
				tokenHashAlgorithm: (field) => field === "sha256",
				trustedPrincipal: isTrustedPrincipalValue,
				requestingClientSessionId: isStringValue,
				expectedResponseSequence: (field) => isSafeIntegerValue(field) && (field as number) > 0,
				expiresAt: isFiniteDateStringValue,
				question: isStringValue,
				options: isApprovalOptionArrayValue,
				workflowId: isStringValue,
				coordinatorEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			},
		)
	)
		return false;
	const decisionRefs = value.decisionRefs;
	if (!Array.isArray(decisionRefs) || decisionRefs.length !== 3 || !decisionRefs.every(isDecisionRefValue))
		return false;
	const digests = decisionRefs.map((ref: unknown) => digestObject(ref));
	return new Set(digests).size === 3 && digests.includes(digestObject(value.decisionRef));
};
const isCloudAvailabilityResponseValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"requestDigest",
			"status",
			"provider",
			"accountRef",
			"region",
			"capacityArtifactRef",
			"pricingArtifactRef",
			"pricingDigest",
			"authorityDigest",
			"credentialArtifactRef",
			"quotaArtifactRef",
			"rateLimitArtifactRef",
			"billingArtifactRef",
			"egressArtifactRef",
			"terminationArtifactRef",
			"responseArtifactRef",
			"responseReceipt",
			"responseKeyId",
			"responseMac",
			"responseChecksum",
			"validUntil",
			"reasonCode",
		],
		{
			requestDigest: isStringValue,
			status: isStringValue,
			provider: isStringValue,
			accountRef: isStringValue,
			region: isStringValue,
			capacityArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			pricingArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			pricingDigest: isNullableStringValue,
			authorityDigest: isNullableStringValue,
			credentialArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			quotaArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			rateLimitArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			billingArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			egressArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			terminationArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			responseArtifactRef: (entry) => entry === null || isArtifactRefValue(entry),
			responseReceipt: (entry) => entry === null || isVerifiedHostReceiptValue(entry),
			responseKeyId: isNullableStringValue,
			responseMac: isNullableStringValue,
			responseChecksum: isNullableStringValue,
			validUntil: isNullableStringValue,
			reasonCode: isStringValue,
		},
	);
const isFiniteDateStringValue = (value: unknown): boolean => isStringValue(value) && Number.isFinite(Date.parse(value));
const isPositiveFiniteNumberValue = (value: unknown): boolean => isFiniteNumberValue(value) && (value as number) > 0;
const isFiniteNumberRecordValue = (value: unknown): boolean =>
	isRecord(value) && Object.entries(value).every(([key, field]) => key.length > 0 && isFiniteNumberValue(field));
const isLeaseRefArrayValue = (value: unknown): boolean => Array.isArray(value) && value.every(isLeaseRefValue);
const isWorkflowRevisionScopeRecordValue = (value: unknown): boolean =>
	isRecord(value) &&
	((value.kind === "knowledge" &&
		typeof value.namespace === "string" &&
		value.namespace.length > 0 &&
		exactKeys(value, ["kind", "namespace"])) ||
		(value.kind === "session" &&
			typeof value.rootSessionId === "string" &&
			value.rootSessionId.length > 0 &&
			exactKeys(value, ["kind", "rootSessionId"])) ||
		(value.kind === "workflow" &&
			typeof value.workflowId === "string" &&
			value.workflowId.length > 0 &&
			typeof value.rootSessionId === "string" &&
			value.rootSessionId.length > 0 &&
			exactKeys(value, ["kind", "workflowId", "rootSessionId"])) ||
		(value.kind === "workspace" &&
			typeof value.workspaceId === "string" &&
			value.workspaceId.length > 0 &&
			exactKeys(value, ["kind", "workspaceId"])) ||
		(value.kind === "user" &&
			typeof value.userId === "string" &&
			value.userId.length > 0 &&
			exactKeys(value, ["kind", "userId"])) ||
		(value.kind === "global" &&
			typeof value.authorityId === "string" &&
			value.authorityId.length > 0 &&
			exactKeys(value, ["kind", "authorityId"])));
const isExecutionCeilingsValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"maxWorkflowWallMilliseconds",
			"maxWorkflowTokens",
			"maxModelCalls",
			"maxTaskAttempts",
			"maxPlannerCycles",
			"maxDistinctStrategiesPerRequirement",
			"maxAnalysisAttemptsPerRequirement",
			"maxRecoveryAttemptsPerEffectClass",
			"renewalRequiresUserApproval",
		],
		{
			maxWorkflowWallMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxWorkflowTokens: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxModelCalls: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxTaskAttempts: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxPlannerCycles: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxDistinctStrategiesPerRequirement: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxAnalysisAttemptsPerRequirement: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxRecoveryAttemptsPerEffectClass: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			renewalRequiresUserApproval: (field) => field === true,
		},
	);
const isAdaptiveAllocationStateValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"allocationRevision",
			"acceptedObservation",
			"allocationEntries",
			"limitingPool",
			"fairness",
			"reviewQueueState",
			"hysteresisPolicy",
			"minimumWindowEvents",
			"minimumWindowMilliseconds",
			"benefitMetricDigest",
			"benefitThreshold",
			"minimumDwellMilliseconds",
			"maxTransitionsPerWindow",
			"transitionsInWindow",
			"lastDecisionRef",
			"safetyOverride",
			"cooldownUntil",
			"cooldownMonotonicMilliseconds",
			"rollbackAllocationRef",
			"allocationStatus",
			"allocationDigest",
			"workflowId",
			"revision",
			"currentEpoch",
			"stateDigest",
			"criticalPathTaskIds",
			"readyQueue",
			"runningQueue",
			"evidenceGaps",
			"blockers",
			"throughputPerMinute",
			"latencyMilliseconds",
			"marginalVerifiedProgressByResource",
			"uncertainty",
			"criticalPathCertificateRef",
			"criticalPathProofDigest",
			"controlPlaneReserve",
			"controlCapacity",
			"workerCapacity",
			"activeLocalLeases",
			"activeCloudLeases",
			"policyRevision",
			"policyDigest",
			"monotonicObservation",
			"observedAt",
			"observationWindowMilliseconds",
			"minimumObservationWindowMilliseconds",
			"executionCeilings",
			"rollbackState",
			"hysteresisThreshold",
			"hysteresisDwellMilliseconds",
			"maxHysteresisTransitions",
			"fairnessAgingMilliseconds",
			"fairnessDebtByTask",
			"explorationQuota",
			"hysteresisRevision",
			"lastAllocationDigest",
			"lastSafeAllocationDigest",
			"lastSafeAllocationTupleDigest",
			"lastSafeLedgerHeadDigest",
			"lastSafeLeaseTupleDigest",
			"acceptedObservationDigest",
			"acceptedAllocationEntries",
			"reviewQueue",
			"sourceJournalSequence",
			"sourceJournalDigest",
			"capacityBindingRefs",
			"pendingObservationDigest",
			"supersededObservationDigests",
			"staleObservationDigests",
			"cancellationDigest",
			"controllerRecoveryDigest",
		],
		{
			allocationRevision: isSafeIntegerValue,
			acceptedObservation: isArtifactRefValue,
			allocationEntries: isRecursiveArrayValue,
			limitingPool: isStringValue,
			fairness: isRecursiveRecordValue,
			reviewQueueState: isRecursiveRecordValue,
			hysteresisPolicy: isRecursiveRecordValue,
			minimumWindowEvents: isSafeIntegerValue,
			minimumWindowMilliseconds: isSafeIntegerValue,
			benefitMetricDigest: isStringValue,
			benefitThreshold: isPositiveFiniteNumberValue,
			minimumDwellMilliseconds: isSafeIntegerValue,
			maxTransitionsPerWindow: isSafeIntegerValue,
			transitionsInWindow: isSafeIntegerValue,
			lastDecisionRef: (field) => field === null || isDecisionRefValue(field),
			safetyOverride: (field) => field === "none" || field === "active",
			cooldownUntil: (field) => field === null || isFiniteDateStringValue(field),
			cooldownMonotonicMilliseconds: (field) =>
				field === null || (isSafeIntegerValue(field) && (field as number) >= 0),
			rollbackAllocationRef: (field) => field === null || isArtifactRefValue(field),
			allocationStatus: (field) => ["stable", "rebalancing", "awaiting_user", "quarantined"].includes(String(field)),
			allocationDigest: isStringValue,
			workflowId: isStringValue,
			revision: isSafeIntegerValue,
			currentEpoch: isEpochRefValue,
			stateDigest: isStringValue,
			criticalPathTaskIds: isStringArrayValue,
			readyQueue: isStringArrayValue,
			runningQueue: isStringArrayValue,
			evidenceGaps: isStringArrayValue,
			blockers: isStringArrayValue,
			throughputPerMinute: isFiniteNumberValue,
			latencyMilliseconds: isFiniteNumberValue,
			marginalVerifiedProgressByResource: isFiniteNumberRecordValue,
			uncertainty: isFiniteNumberRecordValue,
			criticalPathCertificateRef: isArtifactRefValue,
			criticalPathProofDigest: isStringValue,
			controlPlaneReserve: isResourceVectorValue,
			controlCapacity: isControlCapacityValue,
			workerCapacity: isControlCapacityValue,
			activeLocalLeases: isLeaseRefArrayValue,
			activeCloudLeases: isLeaseRefArrayValue,
			policyRevision: isSafeIntegerValue,
			policyDigest: isStringValue,
			monotonicObservation: isRecursiveRecordValue,
			observedAt: isFiniteDateStringValue,
			observationWindowMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			minimumObservationWindowMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			executionCeilings: isExecutionCeilingsValue,
			rollbackState: (field) => ["none", "pending", "applied", "quarantined"].includes(String(field)),
			hysteresisThreshold: isPositiveFiniteNumberValue,
			hysteresisDwellMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxHysteresisTransitions: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			fairnessAgingMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			fairnessDebtByTask: isFiniteNumberRecordValue,
			explorationQuota: isSafeIntegerValue,
			hysteresisRevision: isSafeIntegerValue,
			lastAllocationDigest: isNullableStringValue,
			lastSafeAllocationDigest: isNullableStringValue,
			lastSafeAllocationTupleDigest: isNullableStringValue,
			lastSafeLedgerHeadDigest: isNullableStringValue,
			lastSafeLeaseTupleDigest: isNullableStringValue,
			acceptedObservationDigest: isNullableStringValue,
			acceptedAllocationEntries: isRecursiveArrayValue,
			reviewQueue: isStringArrayValue,
			sourceJournalSequence: isSafeIntegerValue,
			sourceJournalDigest: isStringValue,
			capacityBindingRefs: isArtifactRefArray,
			pendingObservationDigest: isNullableStringValue,
			supersededObservationDigests: isStringArrayValue,
			staleObservationDigests: isStringArrayValue,
			cancellationDigest: isNullableStringValue,
			controllerRecoveryDigest: isNullableStringValue,
		},
	);
const isVerifiedHostReceiptValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"receiptKind",
			"oneUse",
			"receiptId",
			"issuerId",
			"workflowId",
			"bindingDigest",
			"payloadDigest",
			"artifactRef",
			"issuedAt",
			"validUntil",
			"keyId",
			"signatureAlgorithm",
			"signature",
			"artifactBytesDigest",
			"stateDigest",
			"revision",
			"verificationDigest",
		],
		{
			receiptKind: (field) =>
				["clock", "artifact", "capability", "decision", "lease", "usage", "adjudication"].includes(String(field)),
			oneUse: (field) => typeof field === "boolean",
			receiptId: isStringValue,
			issuerId: isStringValue,
			workflowId: isStringValue,
			bindingDigest: isStringValue,
			payloadDigest: isStringValue,
			artifactRef: isArtifactRefValue,
			issuedAt: isFiniteDateStringValue,
			validUntil: isFiniteDateStringValue,
			keyId: isStringValue,
			signatureAlgorithm: (field) => field === "ed25519",
			signature: isStringValue,
			artifactBytesDigest: isStringValue,
			stateDigest: isStringValue,
			revision: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			verificationDigest: isStringValue,
		},
	);

const isCanonicalUtcTimestampValue = (value: unknown): boolean =>
	typeof value === "string" &&
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
	new Date(value).toISOString() === value;

const isObservationDatasetMetadataValue = (value: unknown): boolean => {
	if (
		!exactRecord(
			value,
			[
				"split",
				"modality",
				"instrumentSet",
				"sourceTimeStart",
				"sourceTimeEnd",
				"schemaVersion",
				"objectUri",
				"generation",
				"sha256",
				"bytes",
				"validationResult",
				"coverage",
				"gapClassification",
				"gapEvidenceRefs",
				"sourceEmptyEvidenceRefs",
				"lifecycle",
				"lifecycleTargetObservationId",
				"restoreVerification",
				"provenance",
				"closureRootDigest",
				"accessAuthority",
				"hostReceipt",
				"holdoutAggregate",
			],
			{
				split: (field) => field === "training" || field === "validation" || field === "holdout",
				modality: (field) =>
					field === "time_series" ||
					field === "order_book" ||
					field === "position_book" ||
					field === "pricing_stream",
				instrumentSet: (field) =>
					Array.isArray(field) &&
					field.length > 0 &&
					field.every(isStringValue) &&
					new Set(field).size === field.length &&
					field.every((item, index) => index === 0 || item > field[index - 1]),
				sourceTimeStart: isCanonicalUtcTimestampValue,
				sourceTimeEnd: isCanonicalUtcTimestampValue,
				schemaVersion: isStringValue,
				objectUri: (field) => typeof field === "string" && /^[a-z][a-z0-9+.-]*:\/\/\S+$/u.test(field),
				generation: (field) => isSafeIntegerValue(field) && (field as number) > 0,
				sha256: isDigestValue,
				bytes: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
				validationResult: (field) => field === "passed" || field === "failed" || field === "unknown",
				coverage: (field) =>
					field === "complete" ||
					field === "provider_empty" ||
					field === "partial_coverage" ||
					field === "unknown" ||
					field === "missing",
				gapClassification: (field) =>
					field === "none" ||
					field === "provider_empty" ||
					field === "partial_coverage" ||
					field === "unknown" ||
					field === "missing",
				gapEvidenceRefs: isArtifactRefArray,
				sourceEmptyEvidenceRefs: isArtifactRefArray,
				lifecycle: (field) =>
					field === "in_progress" || field === "sealed" || field === "superseded" || field === "quarantined",
				lifecycleTargetObservationId: isNullableStringValue,
				restoreVerification: (field) =>
					exactRecord(
						field,
						["locked", "independentlyRestored", "independentlyRehashed", "verificationEvidenceDigest"],
						{
							locked: (item) => item === true,
							independentlyRestored: isBooleanValue,
							independentlyRehashed: isBooleanValue,
							verificationEvidenceDigest: isNullableDigestValue,
						},
					),
				provenance: (field) =>
					exactRecord(
						field,
						["sourceSystem", "sourceDataset", "ingestDigest", "lineageDigest", "provenanceReceiptDigest"],
						{
							sourceSystem: isStringValue,
							sourceDataset: isStringValue,
							ingestDigest: isDigestValue,
							lineageDigest: isDigestValue,
							provenanceReceiptDigest: isDigestValue,
						},
					),
				closureRootDigest: isDigestValue,
				accessAuthority: (field) =>
					field === "training_workers_training_only" ||
					field === "validation_evaluator_host_only" ||
					field === "holdout_host_aggregate_only",
				hostReceipt: isVerifiedHostReceiptValue,
				holdoutAggregate: (field) =>
					field === null ||
					(isRecord(field) &&
						exactRecord(field, ["aggregateDigest", "artifactRef", "receipt"], {
							aggregateDigest: isDigestValue,
							artifactRef: isArtifactRefValue,
							receipt: isVerifiedHostReceiptValue,
						})),
			},
		)
	)
		return false;
	const metadata = value as Record<string, unknown>;
	const start = Date.parse(metadata.sourceTimeStart as string);
	const end = Date.parse(metadata.sourceTimeEnd as string);
	const coverage = metadata.coverage;
	const gap = metadata.gapClassification;
	const expectedGap = coverage === "complete" ? "none" : coverage;
	const split = metadata.split;
	const accessAuthority = metadata.accessAuthority;
	const restore = metadata.restoreVerification as Record<string, unknown>;
	const provenance = metadata.provenance as Record<string, unknown>;
	const hostReceipt = metadata.hostReceipt as Record<string, unknown>;
	const aggregate = metadata.holdoutAggregate;
	const lifecycle = metadata.lifecycle;
	const lifecycleTargetObservationId = metadata.lifecycleTargetObservationId;
	return (
		end > start &&
		gap === expectedGap &&
		(coverage === "complete" ? metadata.validationResult === "passed" : true) &&
		(coverage === "provider_empty" || coverage === "partial_coverage"
			? metadata.validationResult === "passed"
			: true) &&
		(coverage === "unknown" || coverage === "missing" ? metadata.validationResult === "unknown" : true) &&
		(metadata.modality === "order_book" || metadata.modality === "position_book"
			? end - start === 20 * 60 * 1000 && start % (20 * 60 * 1000) === 0
			: true) &&
		(metadata.lifecycle === "sealed"
			? restore.independentlyRestored === true &&
				restore.independentlyRehashed === true &&
				restore.verificationEvidenceDigest !== null
			: true) &&
		(lifecycle === "superseded" || lifecycle === "quarantined"
			? lifecycleTargetObservationId !== null
			: lifecycleTargetObservationId === null) &&
		((split === "training" && accessAuthority === "training_workers_training_only") ||
			(split === "validation" && accessAuthority === "validation_evaluator_host_only") ||
			(split === "holdout" && accessAuthority === "holdout_host_aggregate_only")) &&
		(split === "holdout" ? aggregate !== null : aggregate === null) &&
		provenance.provenanceReceiptDigest === hostReceipt.payloadDigest &&
		(split === "holdout"
			? (aggregate as Record<string, unknown>).aggregateDigest ===
				((aggregate as Record<string, unknown>).receipt as Record<string, unknown>).payloadDigest
			: true)
	);
};

const isObservationOutcomeRecordValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"workflowId",
			"observationId",
			"observationDigest",
			"baseRevisionDigest",
			"processGeneration",
			"coordinatorTerm",
			"effectIdempotencyKey",
			"taskId",
			"attemptId",
			"kind",
			"evidenceRefs",
			"decisionRef",
			"expectedHead",
			"epochRef",
			"leaseRef",
			"outcome",
			"reason",
			"acceptedAt",
			"datasetMetadata",
		],
		{
			workflowId: isStringValue,
			observationId: isStringValue,
			observationDigest: isDigestValue,
			baseRevisionDigest: isDigestValue,
			processGeneration: isStringValue,
			coordinatorTerm: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			effectIdempotencyKey: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			kind: (field) =>
				field === "dataset" ||
				field === "task_result" ||
				field === "evidence" ||
				field === "progress" ||
				field === "supersession" ||
				field === "quarantine",
			evidenceRefs: isArtifactRefArray,
			decisionRef: (field) => field === null || isDecisionRefValue(field),
			expectedHead: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			leaseRef: isLeaseRefValue,
			outcome: (field) =>
				field === "applied" || field === "no_op" || field === "stale" || field === "rejected" || field === "failed",
			reason: isNullableStringValue,
			acceptedAt: (field) => field === null || isCanonicalUtcTimestampValue(field),
			datasetMetadata: (field) => field === null || isObservationDatasetMetadataValue(field),
		},
	) &&
	(value as Record<string, unknown>).expectedHead !== undefined &&
	(value as Record<string, unknown>).baseRevisionDigest ===
		((value as Record<string, unknown>).expectedHead as Record<string, unknown>).eventDigest &&
	((value as Record<string, unknown>).kind === "dataset"
		? (value as Record<string, unknown>).outcome === "applied"
			? (value as Record<string, unknown>).datasetMetadata !== null
			: (value as Record<string, unknown>).datasetMetadata === null
		: (value as Record<string, unknown>).datasetMetadata === null);

const isObservationCompletionCutValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"workflowId",
			"cutId",
			"expectedHead",
			"epochRef",
			"finalClosureObservationId",
			"finalClosureObservationDigest",
			"trainingClosureRootDigest",
			"validationClosureRootDigest",
			"holdoutClosureRootDigest",
			"supersededObservationIds",
			"quarantinedObservationIds",
			"sealedAt",
		],
		{
			workflowId: isStringValue,
			cutId: isStringValue,
			expectedHead: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			finalClosureObservationId: isStringValue,
			finalClosureObservationDigest: isDigestValue,
			trainingClosureRootDigest: isDigestValue,
			validationClosureRootDigest: isDigestValue,
			holdoutClosureRootDigest: isDigestValue,
			supersededObservationIds: isStringArrayValue,
			quarantinedObservationIds: isStringArrayValue,
			sealedAt: isCanonicalUtcTimestampValue,
		},
	) &&
	new Set([
		(value as Record<string, unknown>).trainingClosureRootDigest,
		(value as Record<string, unknown>).validationClosureRootDigest,
		(value as Record<string, unknown>).holdoutClosureRootDigest,
	]).size === 3;

const isObservationLatePolicyRecordValue = (value: unknown): boolean =>
	exactRecord(
		value,
		["workflowId", "cutId", "observationId", "observationDigest", "baseRevisionDigest", "policy", "epochRef"],
		{
			workflowId: isStringValue,
			cutId: isStringValue,
			observationId: isStringValue,
			observationDigest: isDigestValue,
			baseRevisionDigest: isDigestValue,
			policy: (field) => field === "no_op" || field === "reopen" || field === "compensate",
			epochRef: isEpochRefValue,
		},
	);
const isAdaptiveObservationValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"observationId",
			"sourceEventSequence",
			"sourceJournalDigest",
			"workflowId",
			"headDigest",
			"acceptedDagRef",
			"configDigest",
			"evaluatorDigest",
			"leaseStateDigest",
			"goalContractDigest",
			"scorecardDigest",
			"revisionRegistryDigest",
			"workspaceDigest",
			"criticalPathCertificateRef",
			"remainingWorkEstimates",
			"hostObservedNoveltyProofRefs",
			"taskValueCertificateRefs",
			"independentCertificateAdmissionRef",
			"criticalPathTaskIds",
			"readyQueueTaskIds",
			"evidenceGapRequirementIds",
			"blockerIds",
			"throughputEvidenceRefs",
			"latencyEvidenceRefs",
			"marginalVerifiedProgressEvidenceRefs",
			"uncertaintyEvidenceRefs",
			"liveResourceLeaseRefs",
			"liveOwnershipLeaseRefs",
			"controlPlaneReserve",
			"controlPlaneReserveCapacity",
			"observedCapacity",
			"observedControlCapacity",
			"authenticatedCapacitySnapshotRefs",
			"limitingPool",
			"monotonicObservation",
			"observedAt",
			"hostObservationReceipt",
			"observationDigest",
		],
		{
			observationId: isStringValue,
			sourceEventSequence: isSafeIntegerValue,
			sourceJournalDigest: isStringValue,
			workflowId: isStringValue,
			headDigest: isStringValue,
			acceptedDagRef: isArtifactRefValue,
			configDigest: isStringValue,
			evaluatorDigest: isStringValue,
			leaseStateDigest: isStringValue,
			goalContractDigest: isStringValue,
			scorecardDigest: isStringValue,
			revisionRegistryDigest: isStringValue,
			workspaceDigest: isStringValue,
			criticalPathCertificateRef: isArtifactRefValue,
			remainingWorkEstimates: isRecursiveArrayValue,
			hostObservedNoveltyProofRefs: isArtifactRefArray,
			taskValueCertificateRefs: isArtifactRefArray,
			independentCertificateAdmissionRef: isArtifactRefValue,
			criticalPathTaskIds: isStringArrayValue,
			readyQueueTaskIds: isStringArrayValue,
			evidenceGapRequirementIds: isStringArrayValue,
			blockerIds: isStringArrayValue,
			throughputEvidenceRefs: isArtifactRefArray,
			latencyEvidenceRefs: isArtifactRefArray,
			marginalVerifiedProgressEvidenceRefs: isArtifactRefArray,
			uncertaintyEvidenceRefs: isArtifactRefArray,
			liveResourceLeaseRefs: isLeaseRefArrayValue,
			liveOwnershipLeaseRefs: isLeaseRefArrayValue,
			controlPlaneReserve: isResourceVectorValue,
			controlPlaneReserveCapacity: isControlCapacityValue,
			observedCapacity: isResourceVectorValue,
			observedControlCapacity: isControlCapacityValue,
			authenticatedCapacitySnapshotRefs: isRecursiveRecordValue,
			limitingPool: isStringValue,
			monotonicObservation: isRecursiveRecordValue,
			observedAt: isFiniteDateStringValue,
			hostObservationReceipt: isVerifiedHostReceiptValue,
			observationDigest: isStringValue,
		},
	);
const isAdaptiveAllocationObservationValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"exactObservation",
			"workflowId",
			"observedState",
			"hostStateDigest",
			"currentHeadDigest",
			"currentEpoch",
			"hostObservedAt",
			"verifiedEvidenceRefs",
			"acceptedDagDigest",
			"evidenceGapRefs",
			"criticalPathCertificate",
			"taskValueCertificates",
			"policyRevision",
			"policyDigest",
			"resourceEnvelopeDigest",
			"canonicalLedgerDigest",
			"controlCapacity",
			"workerCapacity",
			"activeLocalLeases",
			"activeCloudLeases",
			"capacityBindingRefs",
			"sourceJournalSequence",
			"sourceJournalDigest",
			"supersededObservationDigest",
			"observationDigest",
		],
		{
			exactObservation: isAdaptiveObservationValue,
			workflowId: isStringValue,
			observedState: isAdaptiveAllocationStateValue,
			hostStateDigest: isStringValue,
			currentHeadDigest: isStringValue,
			currentEpoch: isEpochRefValue,
			hostObservedAt: isFiniteDateStringValue,
			verifiedEvidenceRefs: isArtifactRefArray,
			acceptedDagDigest: isStringValue,
			evidenceGapRefs: isArtifactRefArray,
			criticalPathCertificate: isRecursiveRecordValue,
			taskValueCertificates: isRecursiveArrayValue,
			policyRevision: isSafeIntegerValue,
			policyDigest: isStringValue,
			resourceEnvelopeDigest: isStringValue,
			canonicalLedgerDigest: isStringValue,
			controlCapacity: isControlCapacityValue,
			workerCapacity: isControlCapacityValue,
			activeLocalLeases: isLeaseRefArrayValue,
			activeCloudLeases: isLeaseRefArrayValue,
			capacityBindingRefs: isArtifactRefArray,
			sourceJournalSequence: isSafeIntegerValue,
			sourceJournalDigest: isStringValue,
			supersededObservationDigest: isNullableStringValue,
			observationDigest: isStringValue,
		},
	);
const isRevisionScopeBindingValue = (value: unknown): boolean => {
	if (
		!isRecord(value) ||
		!["session", "workflow", "knowledge", "workspace", "user", "global"].includes(String(value.scope))
	)
		return false;
	const scope = String(value.scope);
	if (scope === "session") return isStringValue(value.sessionId) && exactKeys(value, ["scope", "sessionId"]);
	if (scope === "workflow") return isStringValue(value.workflowId) && exactKeys(value, ["scope", "workflowId"]);
	if (scope === "knowledge")
		return (
			(value.knowledgeScope === "session" &&
				isStringValue(value.sessionId) &&
				exactKeys(value, ["scope", "knowledgeScope", "sessionId"])) ||
			(value.knowledgeScope === "workflow" &&
				isStringValue(value.workflowId) &&
				exactKeys(value, ["scope", "knowledgeScope", "workflowId"]))
		);
	return exactKeys(value, ["scope"]);
};
const isImprovementProposalValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"proposalId",
			"workflowId",
			"owner",
			"scope",
			"sourcePhaseOrIncident",
			"baselineRevision",
			"baselineDigest",
			"candidateDigest",
			"caseManifestDigest",
			"baselineArtifactRef",
			"candidateArtifactRef",
			"trialMode",
			"sampleSize",
			"minimumEffectSize",
			"tolerance",
			"hostAcceptedEvidenceRefs",
			"fixedEvaluatorDigest",
			"preregisteredManifestDigest",
			"hiddenHoldoutDigest",
			"safetyInvariantDigest",
			"costCeilingMicrounits",
			"antiGoodhartReceipt",
			"queuedAt",
			"proposalEpoch",
			"hiddenHoldoutManifestRef",
			"registryEpoch",
			"registryResolutionReceipt",
			"revisionResolution",
			"baselineBytesDigest",
			"candidateBytesDigest",
			"proposalDigest",
			"producer",
			"kind",
			"baselineRevisionId",
			"baselineRevisionDigest",
			"candidateRef",
			"scorecardRef",
			"scorecardDigest",
			"evaluatorRef",
			"parserRef",
			"baselineEvidenceRefs",
			"candidateEvidenceRefs",
			"queueState",
			"queueRevision",
			"attemptId",
			"reviewLeaseRef",
			"ownershipLeaseRef",
			"epochRef",
			"executionKey",
			"status",
			"caseManifest",
			"scorecard",
			"evaluatorContract",
			"reviewBudget",
		],
		{
			proposalId: isStringValue,
			workflowId: isStringValue,
			owner: (field) => ["policy", "native", "autoresearch", "knowledge"].includes(String(field)),
			scope: isWorkflowRevisionScopeRecordValue,
			sourcePhaseOrIncident: isStringValue,
			baselineRevision: isSafeIntegerValue,
			baselineDigest: isStringValue,
			candidateDigest: isStringValue,
			caseManifestDigest: isStringValue,
			baselineArtifactRef: isArtifactRefValue,
			candidateArtifactRef: isArtifactRefValue,
			trialMode: (field) => ["shadow", "canary", "replay"].includes(String(field)),
			sampleSize: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			minimumEffectSize: isFiniteNumberValue,
			tolerance: isFiniteNumberValue,
			hostAcceptedEvidenceRefs: isArtifactRefArray,
			fixedEvaluatorDigest: isStringValue,
			preregisteredManifestDigest: isStringValue,
			hiddenHoldoutDigest: isStringValue,
			safetyInvariantDigest: isStringValue,
			costCeilingMicrounits: (field) => isFiniteNumberValue(field) && (field as number) >= 0,
			antiGoodhartReceipt: isVerifiedHostReceiptValue,
			queuedAt: isFiniteDateStringValue,
			proposalEpoch: isEpochRefValue,
			hiddenHoldoutManifestRef: isArtifactRefValue,
			registryEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			registryResolutionReceipt: isVerifiedHostReceiptValue,
			revisionResolution: isRecursiveRecordValue,
			baselineBytesDigest: isStringValue,
			candidateBytesDigest: isStringValue,
			proposalDigest: isStringValue,
			producer: (field) => ["durable", "native", "autoresearch", "knowledge"].includes(String(field)),
			kind: (field) => ["workflow", "methodology", "policy", "evaluator", "knowledge"].includes(String(field)),
			baselineRevisionId: isStringValue,
			baselineRevisionDigest: isStringValue,
			candidateRef: isArtifactRefValue,
			scorecardRef: isArtifactRefValue,
			scorecardDigest: isStringValue,
			evaluatorRef: isArtifactRefValue,
			parserRef: isArtifactRefValue,
			baselineEvidenceRefs: isArtifactRefArray,
			candidateEvidenceRefs: isArtifactRefArray,
			queueState: (field) => ["pending", "active", "superseded", "cancelled"].includes(String(field)),
			queueRevision: isSafeIntegerValue,
			attemptId: isNullableStringValue,
			reviewLeaseRef: isNullableLeaseRecordValue,
			ownershipLeaseRef: isNullableLeaseRecordValue,
			epochRef: isEpochRefValue,
			executionKey: isStringValue,
			status: (field) =>
				["queued", "reviewing", "proposed", "rejected", "approved", "rolled_back", "superseded"].includes(
					String(field),
				),
			caseManifest: isRecursiveRecordValue,
			scorecard: isRecursiveRecordValue,
			evaluatorContract: isRecursiveRecordValue,
			reviewBudget: isRecursiveRecordValue,
		},
	);
const isPolicyRevisionValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"workflowId",
			"revision",
			"policyDigest",
			"approvedDecisionRef",
			"approvalReceipt",
			"sourceProposalId",
			"provenanceRefs",
			"compatibilityDigest",
			"scope",
			"status",
			"revocationEpoch",
			"revisionCasDigest",
			"activeWorkFenceDigest",
			"fencedLeaseIds",
			"fencedApprovalIds",
			"fencedCacheDigests",
			"priorApprovedRevision",
			"priorApprovedPolicyDigest",
			"priorApprovedPinnedArtifactRefs",
			"priorApprovedSourceProposalId",
			"priorApprovedProvenanceRefs",
			"priorApprovedCompatibilityDigest",
			"priorApprovedCompatibilityClosure",
			"priorApprovedApprovedDecisionRef",
			"priorApprovedApprovalReceipt",
			"priorApprovedReloadVerificationRef",
			"priorApprovedFutureLoadVerificationRef",
			"priorApprovedRegistryEntryId",
			"priorApprovedRevisionId",
			"priorApprovedScopeBinding",
			"restoredFromRevision",
			"restoredPolicyDigest",
			"reloadVerificationRef",
			"futureLoadVerificationRef",
			"registryEntryId",
			"revisionId",
			"pinnedArtifactRefs",
			"compatibilityClosure",
			"supersededByRevisionId",
			"rollbackOfRevisionId",
			"rollbackEventSequence",
			"rollbackCasExecutionKey",
			"registryEpoch",
			"registryEventSequence",
			"registryCasExecutionKey",
			"entryDigest",
			"scopeBinding",
		],
		{
			workflowId: isNullableStringValue,
			revision: isSafeIntegerValue,
			policyDigest: isStringValue,
			approvedDecisionRef: isRevisionDecisionRefValue,
			approvalReceipt: isVerifiedHostReceiptValue,
			sourceProposalId: isStringValue,
			provenanceRefs: isArtifactRefArray,
			compatibilityDigest: isStringValue,
			scope: isWorkflowRevisionScopeRecordValue,
			status: (field) => ["approved", "superseded", "revoked"].includes(String(field)),
			revocationEpoch: (field) => field === null || isEpochRefValue(field),
			revisionCasDigest: isStringValue,
			activeWorkFenceDigest: isStringValue,
			fencedLeaseIds: isStringArrayValue,
			fencedApprovalIds: isStringArrayValue,
			fencedCacheDigests: isStringArrayValue,
			priorApprovedRevision: (field) => field === null || isSafeIntegerValue(field),
			priorApprovedPolicyDigest: isNullableStringValue,
			priorApprovedPinnedArtifactRefs: (field) => field === null || isArtifactRefArray(field),
			priorApprovedSourceProposalId: isNullableStringValue,
			priorApprovedProvenanceRefs: (field) => field === null || isArtifactRefArray(field),
			priorApprovedCompatibilityDigest: isNullableStringValue,
			priorApprovedCompatibilityClosure: (field) => field === null || isRecursiveRecordValue(field),
			priorApprovedApprovedDecisionRef: (field) => field === null || isRevisionDecisionRefValue(field),
			priorApprovedApprovalReceipt: (field) => field === null || isVerifiedHostReceiptValue(field),
			priorApprovedReloadVerificationRef: (field) => field === null || isArtifactRefValue(field),
			priorApprovedFutureLoadVerificationRef: (field) => field === null || isArtifactRefValue(field),
			priorApprovedRegistryEntryId: isNullableStringValue,
			priorApprovedRevisionId: isNullableStringValue,
			priorApprovedScopeBinding: (field) => field === null || isRevisionScopeBindingValue(field),
			restoredFromRevision: (field) => field === null || isSafeIntegerValue(field),
			restoredPolicyDigest: isNullableStringValue,
			reloadVerificationRef: isArtifactRefValue,
			futureLoadVerificationRef: isArtifactRefValue,
			registryEntryId: isStringValue,
			revisionId: isStringValue,
			pinnedArtifactRefs: isArtifactRefArray,
			compatibilityClosure: isRecursiveRecordValue,
			supersededByRevisionId: isNullableStringValue,
			rollbackOfRevisionId: isNullableStringValue,
			rollbackEventSequence: (field) => field === null || isSafeIntegerValue(field),
			rollbackCasExecutionKey: isNullableStringValue,
			registryEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			registryEventSequence: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			registryCasExecutionKey: isStringValue,
			entryDigest: isStringValue,
			scopeBinding: isRevisionScopeBindingValue,
		},
	);
const isImprovementReviewResultValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"proposalId",
			"trialId",
			"owner",
			"baselineDigest",
			"candidateDigest",
			"caseManifestDigest",
			"baselineArtifactRef",
			"candidateArtifactRef",
			"trialMode",
			"sampleSize",
			"effectSize",
			"tolerance",
			"metricDirection",
			"aggregation",
			"repeatabilityRuns",
			"observedVariance",
			"latencyMilliseconds",
			"thresholdPassed",
			"safetyReceipt",
			"scorecardDigest",
			"hiddenHoldoutReceipt",
			"antiGoodhartReceipt",
			"nonRegressionReceipt",
			"costReceipt",
			"costMicrounits",
			"nonRegressionPassed",
			"goodhartPassed",
			"safetyPassed",
			"costWithinCeiling",
			"registryEpoch",
			"registryResolutionReceipt",
			"hiddenHoldoutManifestRef",
			"baselineBytesDigest",
			"candidateBytesDigest",
			"futureLoadDigest",
			"rollbackOf",
			"decision",
			"resultDigest",
			"resultId",
			"proposalRef",
			"reviewRef",
			"disposition",
			"registryStateRef",
			"expectedRegistryEpoch",
			"appliedRegistryEpoch",
			"rollbackOfRevisionId",
			"rollbackEventSequence",
			"casExecutionKey",
			"reloadVerificationRef",
			"futureLoadVerificationRef",
			"hostVerdictDigest",
			"hiddenHoldoutCaseRef",
			"baselineResolvedBytesRef",
			"candidateResolvedBytesRef",
			"heldOutSampleCount",
			"nonRegressionThreshold",
			"safetyPredicateDigest",
			"goodhartPredicateDigest",
			"costPredicateDigest",
		],
		{
			proposalId: isStringValue,
			trialId: isStringValue,
			owner: (field) => ["policy", "native", "autoresearch", "knowledge"].includes(String(field)),
			baselineDigest: isStringValue,
			candidateDigest: isStringValue,
			caseManifestDigest: isStringValue,
			baselineArtifactRef: isArtifactRefValue,
			candidateArtifactRef: isArtifactRefValue,
			trialMode: (field) => ["shadow", "canary", "replay"].includes(String(field)),
			sampleSize: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			effectSize: isFiniteNumberValue,
			tolerance: isFiniteNumberValue,
			metricDirection: (field) => ["maximize", "minimize", "target"].includes(String(field)),
			aggregation: (field) => ["exact", "mean", "median"].includes(String(field)),
			repeatabilityRuns: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			observedVariance: isFiniteNumberValue,
			latencyMilliseconds: (field) => isFiniteNumberValue(field) && (field as number) >= 0,
			thresholdPassed: isBooleanValue,
			safetyReceipt: isVerifiedHostReceiptValue,
			scorecardDigest: isStringValue,
			hiddenHoldoutReceipt: isVerifiedHostReceiptValue,
			antiGoodhartReceipt: isVerifiedHostReceiptValue,
			nonRegressionReceipt: isVerifiedHostReceiptValue,
			costReceipt: isVerifiedHostReceiptValue,
			costMicrounits: (field) => isFiniteNumberValue(field) && (field as number) >= 0,
			nonRegressionPassed: isBooleanValue,
			goodhartPassed: isBooleanValue,
			safetyPassed: isBooleanValue,
			costWithinCeiling: isBooleanValue,
			registryEpoch: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			registryResolutionReceipt: isVerifiedHostReceiptValue,
			hiddenHoldoutManifestRef: isArtifactRefValue,
			baselineBytesDigest: isStringValue,
			candidateBytesDigest: isStringValue,
			futureLoadDigest: isStringValue,
			rollbackOf: isNullableStringValue,
			decision: (field) => ["promote", "reject", "rollback"].includes(String(field)),
			resultDigest: isStringValue,
			resultId: isStringValue,
			proposalRef: isArtifactRefValue,
			reviewRef: isArtifactRefValue,
			disposition: (field) => ["promoted", "rejected", "rolled_back", "empty"].includes(String(field)),
			registryStateRef: isArtifactRefValue,
			expectedRegistryEpoch: isSafeIntegerValue,
			appliedRegistryEpoch: (field) => field === null || isSafeIntegerValue(field),
			rollbackOfRevisionId: isNullableStringValue,
			rollbackEventSequence: (field) => field === null || isSafeIntegerValue(field),
			casExecutionKey: isStringValue,
			reloadVerificationRef: isArtifactRefValue,
			futureLoadVerificationRef: isArtifactRefValue,
			hostVerdictDigest: isStringValue,
			hiddenHoldoutCaseRef: isArtifactRefValue,
			baselineResolvedBytesRef: isArtifactRefValue,
			candidateResolvedBytesRef: isArtifactRefValue,
			heldOutSampleCount: isSafeIntegerValue,
			nonRegressionThreshold: isFiniteNumberValue,
			safetyPredicateDigest: isStringValue,
			goodhartPredicateDigest: isStringValue,
			costPredicateDigest: isStringValue,
		},
	);
const isEfficiencyReviewScheduleValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"workflowId",
			"scheduleId",
			"revision",
			"epochRef",
			"nextDueAt",
			"lastRunAt",
			"minimumCadenceMilliseconds",
			"maximumCadenceMilliseconds",
			"overheadBudgetMicrounits",
			"idempotencyWindowMilliseconds",
			"dutyCycleCapMicrounits",
			"perWindowOverheadCapMicrounits",
			"perPhaseOverheadCapMicrounits",
			"perWorkflowOverheadCapMicrounits",
			"dedicatedControlReserve",
			"approvedResourceEnvelopeDigest",
			"trustedClockSourceRef",
			"triggerSet",
			"approvedDecisionRef",
			"approvalReceipt",
			"resourceEnvelopeRef",
			"capacityRegistryRef",
			"wallCeilingMilliseconds",
			"tokenCeiling",
			"costCeilingMicrounits",
			"status",
			"trustedClockSourceDigest",
			"clockObservationRef",
			"lastAdmittedWindowSequence",
			"lastAdmittedWindowId",
			"cadenceMilliseconds",
			"majorTransitionTriggers",
			"maxReviewsPerWindow",
			"maxReviewsPerPhase",
			"maxReviewsPerWorkflow",
			"dutyCycleCapPermille",
			"overlapPolicy",
			"catchUpAfterRestart",
			"reviewResourceAdmission",
			"maxReviewWallMilliseconds",
			"maxReviewTokens",
			"maxReviewCostMicrounits",
			"scheduleBoundsDigest",
			"scheduleDigest",
			"reservePartitions",
			"reserveLedgerRef",
			"reserveLedgerDigest",
		],
		{
			workflowId: isStringValue,
			scheduleId: isStringValue,
			revision: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			epochRef: isEpochRefValue,
			nextDueAt: isFiniteDateStringValue,
			lastRunAt: (field) => field === null || isFiniteDateStringValue(field),
			minimumCadenceMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maximumCadenceMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			overheadBudgetMicrounits: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			idempotencyWindowMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			dutyCycleCapMicrounits: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			perWindowOverheadCapMicrounits: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			perPhaseOverheadCapMicrounits: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			perWorkflowOverheadCapMicrounits: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			dedicatedControlReserve: isControlCapacityValue,
			approvedResourceEnvelopeDigest: isStringValue,
			trustedClockSourceRef: isArtifactRefValue,
			triggerSet: (field) =>
				Array.isArray(field) &&
				field.length > 0 &&
				field.every((entry) =>
					[
						"scheduled_window",
						"task_terminal",
						"phase_transition",
						"result_transition",
						"lease_release",
						"material_evidence_transition",
						"incident",
						"recovery_boundary",
						"completion_gate",
					].includes(String(entry)),
				),
			approvedDecisionRef: isDecisionRefValue,
			approvalReceipt: isVerifiedHostReceiptValue,
			resourceEnvelopeRef: isArtifactRefValue,
			capacityRegistryRef: isArtifactRefValue,
			status: (field) =>
				["scheduled", "started", "completed", "skipped", "recovered", "failed", "cancelled", "fenced"].includes(
					String(field),
				),
			trustedClockSourceDigest: isStringValue,
			clockObservationRef: isArtifactRefValue,
			lastAdmittedWindowSequence: isSafeIntegerValue,
			lastAdmittedWindowId: isNullableStringValue,
			cadenceMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			majorTransitionTriggers: (field) =>
				Array.isArray(field) &&
				field.every((entry) =>
					[
						"scheduled_window",
						"task_terminal",
						"phase_transition",
						"result_transition",
						"lease_release",
						"material_evidence_transition",
						"incident",
						"recovery_boundary",
						"completion_gate",
					].includes(String(entry)),
				),
			maxReviewsPerWindow: (field) => field === 1,
			maxReviewsPerPhase: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxReviewsPerWorkflow: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			dutyCycleCapPermille: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			overlapPolicy: (field) => field === "reject",
			catchUpAfterRestart: (field) => field === "one",
			reviewResourceAdmission: isRecursiveRecordValue,
			maxReviewWallMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxReviewTokens: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			maxReviewCostMicrounits: (field) => isSafeIntegerValue(field) && (field as number) > 0,
			scheduleBoundsDigest: isStringValue,
			scheduleDigest: isStringValue,
			reservePartitions: isRecursiveRecordValue,
			reserveLedgerRef: isArtifactRefValue,
			reserveLedgerDigest: isStringValue,
		},
	);
const isEfficiencyReviewStateValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"workflowId",
			"schedule",
			"stateDigest",
			"windowSequence",
			"clockSequence",
			"lastAdmittedDueWindowId",
			"lastDueWindowId",
			"inFlightRunId",
			"pendingRunId",
			"catchUpPending",
			"reportDigest",
			"lastSafeAllocationDigest",
			"cumulativeActualOverheadMicrounits",
			"cumulativeActualWallMilliseconds",
			"cumulativeActualTokens",
			"cumulativeActualCostMicrounits",
			"windowActualOverheadMicrounits",
			"windowActualWallMilliseconds",
			"windowActualTokens",
			"windowActualCostMicrounits",
			"phaseActualOverheadMicrounits",
			"phaseActualWallMilliseconds",
			"phaseActualTokens",
			"phaseActualCostMicrounits",
			"phaseCounterIdentityDigest",
			"lastRunUsageDigest",
			"lastSnapshotDigest",
			"lastHostExecutionIdentity",
			"monotonicClockObservation",
			"activeReviewIdentity",
			"activeReviewFenceDigest",
			"latestPendingReviewDigest",
			"catchUpWindowSequence",
			"cumulativeFailureUsageDigest",
			"cancellationDigest",
			"fenceDigest",
			"windowState",
			"pendingSupersessionDigest",
			"activeWindowState",
			"latestPendingWindowState",
			"activeFenceIntentDigest",
			"phaseReviewCount",
			"workflowReviewCount",
			"dutyCycleUsedPermille",
			"phaseIdentityDigest",
		],
		{
			workflowId: isStringValue,
			schedule: (field) => field === null || isEfficiencyReviewScheduleValue(field),
			stateDigest: isStringValue,
			windowSequence: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			clockSequence: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			lastAdmittedDueWindowId: isNullableStringValue,
			lastDueWindowId: isNullableStringValue,
			inFlightRunId: isNullableStringValue,
			pendingRunId: isNullableStringValue,
			catchUpPending: (field) => typeof field === "boolean",
			reportDigest: isNullableStringValue,
			lastSafeAllocationDigest: isNullableStringValue,
			cumulativeActualOverheadMicrounits: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			cumulativeActualWallMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			cumulativeActualTokens: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			cumulativeActualCostMicrounits: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			windowActualOverheadMicrounits: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			windowActualWallMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			windowActualTokens: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			windowActualCostMicrounits: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			phaseActualOverheadMicrounits: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			phaseActualWallMilliseconds: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			phaseActualTokens: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			phaseActualCostMicrounits: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			phaseCounterIdentityDigest: isStringValue,
			lastRunUsageDigest: isNullableStringValue,
			lastSnapshotDigest: isNullableStringValue,
			lastHostExecutionIdentity: isNullableStringValue,
			monotonicClockObservation: isRecursiveRecordValue,
			activeReviewIdentity: isNullableStringValue,
			activeReviewFenceDigest: isNullableStringValue,
			latestPendingReviewDigest: isNullableStringValue,
			catchUpWindowSequence: (field) => field === null || isSafeIntegerValue(field),
			cumulativeFailureUsageDigest: isNullableStringValue,
			cancellationDigest: isNullableStringValue,
			fenceDigest: isNullableStringValue,
			windowState: (field) => field === null || isRecursiveRecordValue(field),
			pendingSupersessionDigest: isNullableStringValue,
			activeWindowState: (field) => field === null || isRecursiveRecordValue(field),
			latestPendingWindowState: (field) => field === null || isRecursiveRecordValue(field),
			activeFenceIntentDigest: isNullableStringValue,
			phaseReviewCount: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			workflowReviewCount: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			dutyCycleUsedPermille: (field) => isSafeIntegerValue(field) && (field as number) >= 0,
			phaseIdentityDigest: isStringValue,
		},
	);
const isEfficiencyRedTeamSuggestionValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"suggestionId",
			"reviewId",
			"windowId",
			"disposition",
			"findingRefs",
			"evidenceRefs",
			"recommendedAllocationRef",
			"expectedVerifiedOutcomeRef",
			"writeAuthority",
			"leaseAuthority",
			"allocationAuthority",
			"approvalAuthority",
			"completionAuthority",
			"suggestionDigest",
		],
		{
			suggestionId: isStringValue,
			reviewId: isStringValue,
			windowId: isStringValue,
			disposition: (field) =>
				[
					"no_change",
					"suggest_reallocation",
					"suggest_schedule_change",
					"suggest_user_decision",
					"safety_finding",
				].includes(String(field)),
			findingRefs: isArtifactRefArray,
			evidenceRefs: isArtifactRefArray,
			recommendedAllocationRef: (field) => field === null || isArtifactRefValue(field),
			expectedVerifiedOutcomeRef: (field) => field === null || isArtifactRefValue(field),
			writeAuthority: (field) => field === false,
			leaseAuthority: (field) => field === false,
			allocationAuthority: (field) => field === false,
			approvalAuthority: (field) => field === false,
			completionAuthority: (field) => field === false,
			suggestionDigest: isStringValue,
		},
	);
const isEfficiencyReviewSuggestionArrayValue = (value: unknown): boolean =>
	Array.isArray(value) && value.every(isEfficiencyRedTeamSuggestionValue);
const isEfficiencyReviewReportValue = (value: unknown): boolean =>
	exactRecord(
		value,
		[
			"workflowId",
			"dueWindowId",
			"kind",
			"runId",
			"hostExecutionId",
			"reviewId",
			"invocationRef",
			"snapshotRef",
			"invocationDigest",
			"snapshotDigest",
			"resultDigest",
			"reportDigest",
			"suggestions",
			"suggestionDigests",
			"resolverReceipt",
			"exactSnapshot",
			"exactInvocation",
			"exactResult",
			"sourceJournalSequence",
			"sourceJournalDigest",
			"registryRef",
			"registryDigest",
			"capacitySnapshotRefs",
			"usageSnapshotRefs",
			"billingSnapshotRefs",
			"rateLimitSnapshotRefs",
			"monotonicClockObservation",
			"childIdentity",
			"epochRef",
			"executionKey",
			"casExecutionKey",
			"invocationTokenDigest",
			"resourceLeaseRef",
			"ownershipLeaseRef",
			"throughputEvidenceRefs",
			"evidenceGapRefs",
			"uncertaintyEvidenceRefs",
			"actualUsage",
			"disposition",
			"writeAuthority",
			"reallocationAuthority",
			"approvalAuthority",
		],
		{
			workflowId: isStringValue,
			dueWindowId: isStringValue,
			kind: (field) => field === "success",
			runId: isStringValue,
			hostExecutionId: isStringValue,
			reviewId: isStringValue,
			invocationRef: isArtifactRefValue,
			snapshotRef: isArtifactRefValue,
			invocationDigest: isStringValue,
			snapshotDigest: isStringValue,
			resultDigest: isStringValue,
			reportDigest: isStringValue,
			suggestions: isEfficiencyReviewSuggestionArrayValue,
			suggestionDigests: isStringArrayValue,
			resolverReceipt: isVerifiedHostReceiptValue,
			exactSnapshot: isRecursiveRecordValue,
			exactInvocation: isRecursiveRecordValue,
			exactResult: isRecursiveRecordValue,
			sourceJournalSequence: isSafeIntegerValue,
			sourceJournalDigest: isStringValue,
			registryRef: isArtifactRefValue,
			registryDigest: isStringValue,
			capacitySnapshotRefs: isRecursiveRecordValue,
			usageSnapshotRefs: isArtifactRefArray,
			billingSnapshotRefs: isArtifactRefArray,
			rateLimitSnapshotRefs: isArtifactRefArray,
			monotonicClockObservation: isRecursiveRecordValue,
			childIdentity: isRecursiveRecordValue,
			epochRef: isEpochRefValue,
			executionKey: isStringValue,
			casExecutionKey: isStringValue,
			invocationTokenDigest: isStringValue,
			resourceLeaseRef: isLeaseRefValue,
			ownershipLeaseRef: isLeaseRefValue,
			throughputEvidenceRefs: isArtifactRefArray,
			evidenceGapRefs: isArtifactRefArray,
			uncertaintyEvidenceRefs: isArtifactRefArray,
			actualUsage: isRecursiveRecordValue,
			disposition: (field) =>
				[
					"no_change",
					"suggest_reallocation",
					"suggest_schedule_change",
					"suggest_user_decision",
					"safety_finding",
				].includes(String(field)),
			writeAuthority: (field) => field === false,
			reallocationAuthority: (field) => field === false,
			approvalAuthority: (field) => field === false,
		},
	);
void isEfficiencyReviewStateValue;
const WORKFLOW_EVENT_SHAPES = {
	workflow_started: {
		keys: ["kind", "workflowId", "rootSessionId", "objective"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_started",
			workflowId: isStringValue,
			rootSessionId: isStringValue,
			objective: isStringValue,
		},
	},
	goal_binding_committed: {
		keys: ["kind", "workflowId", "goalId", "objective", "goalDelta"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "goal_binding_committed",
			workflowId: isStringValue,
			goalId: isStringValue,
			objective: isStringValue,
			goalDelta: isGoalMutationDeltaValue,
		},
	},
	capacity_observed: {
		keys: ["kind", "capacityDigest"] as const,
		fields: { kind: (value: unknown): boolean => value === "capacity_observed", capacityDigest: isStringValue },
	},
	cloud_availability_observed: {
		keys: ["kind", "response"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "cloud_availability_observed",
			response: isCloudAvailabilityResponseValue,
		},
	},
	profile_selected: {
		keys: ["kind", "requestedProfile", "resolvedProfile", "maxWorkers", "profileDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "profile_selected",
			requestedProfile: isNullableStringValue,
			resolvedProfile: isStringValue,
			maxWorkers: isSafeIntegerValue,
			profileDigest: isStringValue,
		},
	},
	configuration_snapshot_pinned: {
		keys: ["kind", "configDigest", "configRevision"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "configuration_snapshot_pinned",
			configDigest: isStringValue,
			configRevision: isSafeIntegerValue,
		},
	},
	skill_snapshot_pinned: {
		keys: ["kind", "snapshotDigest", "configDigest", "epochRef", "dependencyManifestDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "skill_snapshot_pinned",
			snapshotDigest: isStringValue,
			configDigest: isStringValue,
			epochRef: isEpochRefValue,
			dependencyManifestDigest: isStringValue,
		},
	},
	goal_contract_proposed: {
		keys: ["kind", "contractDigest", "decisionRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "goal_contract_proposed",
			contractDigest: isStringValue,
			decisionRef: isDecisionRefValue,
		},
	},
	scorecard_proposed: {
		keys: ["kind", "scorecardDigest", "decisionRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "scorecard_proposed",
			scorecardDigest: isStringValue,
			decisionRef: isDecisionRefValue,
		},
	},
	resource_envelope_proposed: {
		keys: ["kind", "envelopeDigest", "decisionRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "resource_envelope_proposed",
			envelopeDigest: isStringValue,
			decisionRef: isDecisionRefValue,
		},
	},
	approval_requested: {
		keys: ["kind", "approval", "awaitingUser"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "approval_requested",
			approval: isApprovalRequestValue,
			awaitingUser: (value: unknown): boolean =>
				exactRecord(value, ["status", "phase", "goalDelta", "expectedHeadDigest", "expectedEpoch"], {
					status: (field) => field === "awaiting_user",
					phase: (field) => field === "adjudicating",
					goalDelta: isGoalMutationDeltaValue,
					expectedHeadDigest: isStringValue,
					expectedEpoch: isEpochRefValue,
				}),
		},
	},
	approval_consumed: {
		keys: ["kind", "receipt", "resumeTransition"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "approval_consumed",
			receipt: isApprovalReceiptValue,
			resumeTransition: (value: unknown): boolean =>
				exactRecord(
					value,
					["status", "phase", "plannerEventDigest", "expectedHeadDigest", "expectedStateDigest", "expectedEpoch"],
					{
						status: (field) => field === "active",
						phase: (field) => field === "planning",
						plannerEventDigest: isStringValue,
						expectedHeadDigest: isStringValue,
						expectedStateDigest: isStringValue,
						expectedEpoch: isEpochRefValue,
					},
				),
		},
	},
	approval_epoch_reanchored: {
		keys: ["kind", "workflowId", "approvalRequestId", "stateDigest", "nextEpoch"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "approval_epoch_reanchored",
			workflowId: isStringValue,
			approvalRequestId: isStringValue,
			stateDigest: isStringValue,
			nextEpoch: isEpochRefValue,
		},
	},
	fresh_planner_started: {
		keys: ["kind", "workflowId", "approvalRequestId", "stateDigest", "epochRef", "plannerEventDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "fresh_planner_started",
			workflowId: isStringValue,
			approvalRequestId: isStringValue,
			stateDigest: isStringValue,
			epochRef: isEpochRefValue,
			plannerEventDigest: isStringValue,
		},
	},
	resource_approved: {
		keys: ["kind", "envelopeDigest", "receipt"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "resource_approved",
			envelopeDigest: isStringValue,
			receipt: isApprovalReceiptValue,
		},
	},
	workflow_status_changed: {
		keys: ["kind", "status", "phase", "reason", "goalDelta"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_status_changed",
			status: isWorkflowStatusValue,
			phase: isWorkflowPhaseValue,
			reason: isStringValue,
			goalDelta: isGoalMutationDeltaValue,
		},
	},
	goal_projection_applied: {
		keys: ["kind", "binding", "goalDigest", "goalDelta"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "goal_projection_applied",
			binding: isGoalProjectionBindingValue,
			goalDigest: isStringValue,
			goalDelta: isGoalMutationDeltaValue,
		},
	},
	continuity_capsule_published: {
		keys: ["kind", "capsuleDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "continuity_capsule_published",
			capsuleDigest: isStringValue,
		},
	},
	store_generation_fenced: {
		keys: [
			"kind",
			"workflowId",
			"storeEpoch",
			"priorEpoch",
			"nextEpoch",
			"priorLeaseRef",
			"nextLeaseRef",
			"generationId",
			"generationBinding",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "store_generation_fenced",
			workflowId: isStringValue,
			storeEpoch: isSafeIntegerValue,
			priorEpoch: isEpochRefValue,
			nextEpoch: isEpochRefValue,
			priorLeaseRef: isLeaseRefValue,
			nextLeaseRef: isLeaseRefValue,
			generationId: isStringValue,
			generationBinding: isGenerationBindingValue,
		},
	},
	coordinator_epoch_fenced: {
		keys: [
			"kind",
			"workflowId",
			"coordinatorEpoch",
			"priorEpoch",
			"nextEpoch",
			"priorLeaseRef",
			"nextLeaseRef",
			"generationId",
			"generationBinding",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "coordinator_epoch_fenced",
			workflowId: isStringValue,
			coordinatorEpoch: isSafeIntegerValue,
			priorEpoch: isEpochRefValue,
			nextEpoch: isEpochRefValue,
			priorLeaseRef: isLeaseRefValue,
			nextLeaseRef: isLeaseRefValue,
			generationId: isStringValue,
			generationBinding: isGenerationBindingValue,
		},
	},
	scorecard_red_teamed: {
		keys: ["kind", "scorecardProposalDigest", "findings", "disposition", "redTeamDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "scorecard_red_teamed",
			scorecardProposalDigest: isStringValue,
			findings: isArtifactRefArray,
			disposition: isStringValue,
			redTeamDigest: isStringValue,
		},
	},
	scorecard_approved: {
		keys: ["kind", "scorecardProposalDigest", "approval", "approvedRevision", "authorizedAt"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "scorecard_approved",
			scorecardProposalDigest: isStringValue,
			approval: isApprovalRequestValue,
			approvedRevision: isSafeIntegerValue,
			authorizedAt: isStringValue,
		},
	},
	initialization_intent: {
		keys: [
			"kind",
			"runId",
			"rootSessionId",
			"goalDigest",
			"scorecardDigest",
			"resourceDigest",
			"cleanBranch",
			"resourceLease",
			"ownershipLease",
			"expectedArtifacts",
			"expectedV2RunId",
			"expectedV2FirstSeq",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "initialization_intent",
			runId: isStringValue,
			rootSessionId: isStringValue,
			goalDigest: isStringValue,
			scorecardDigest: isStringValue,
			resourceDigest: isStringValue,
			cleanBranch: isStringValue,
			resourceLease: isLeaseRecordValue,
			ownershipLease: isNullableLeaseRecordValue,
			expectedArtifacts: isRecursiveArrayValue,
			expectedV2RunId: isStringValue,
			expectedV2FirstSeq: (value: unknown): boolean => value === 0,
		},
	},
	projection_intent: {
		keys: ["kind", "runId", "expectedPrefix", "projectionLockId", "effectDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "projection_intent",
			runId: isStringValue,
			expectedPrefix: isNullablePrefixValue,
			projectionLockId: isStringValue,
			effectDigest: isStringValue,
		},
	},
	frontier_init_intent: {
		keys: [
			"kind",
			"runId",
			"baseCommit",
			"frontierRef",
			"frontierWorktree",
			"expectedRefGeneration",
			"resourceLease",
			"ownershipLease",
			"grant",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "frontier_init_intent",
			runId: isStringValue,
			baseCommit: isStringValue,
			frontierRef: isStringValue,
			frontierWorktree: isStringValue,
			expectedRefGeneration: isSafeIntegerValue,
			resourceLease: isLeaseRecordValue,
			ownershipLease: isNullableLeaseRecordValue,
			grant: isTaskResourceGrantValue,
		},
	},
	frontier_initialized: {
		keys: ["kind", "runId", "frontier", "artifactRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "frontier_initialized",
			runId: isStringValue,
			frontier: isFrontierValue,
			artifactRefs: isArtifactRefArray,
		},
	},
	baseline_intent: {
		keys: [
			"kind",
			"runId",
			"attemptId",
			"commandDigest",
			"parserDigest",
			"guardDigest",
			"checkDigests",
			"expectedArtifacts",
			"knownGoodCommit",
			"preCommandWorkspaceDigest",
			"configDigest",
			"leaseRef",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "baseline_intent",
			runId: isStringValue,
			attemptId: isStringValue,
			commandDigest: isStringValue,
			parserDigest: isStringValue,
			guardDigest: isNullableStringValue,
			checkDigests: isStringArrayValue,
			expectedArtifacts: isRecursiveArrayValue,
			knownGoodCommit: isStringValue,
			preCommandWorkspaceDigest: isStringValue,
			configDigest: isStringValue,
			leaseRef: isLeaseRefValue,
		},
	},
	initialized: {
		keys: [
			"kind",
			"runId",
			"runConfigDigest",
			"prefix",
			"knownGoodCommit",
			"baselineMetric",
			"checkDigests",
			"bindingIds",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "initialized",
			runId: isStringValue,
			runConfigDigest: isStringValue,
			prefix: isNullablePrefixValue,
			knownGoodCommit: isStringValue,
			baselineMetric: isFiniteNumberValue,
			checkDigests: isStringArrayValue,
			bindingIds: isStringArrayValue,
		},
	},
	projection_committed: {
		keys: ["kind", "runId", "expectedPrefix", "resultPrefix", "projectionArtifactRef", "effectDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "projection_committed",
			runId: isStringValue,
			expectedPrefix: isNullablePrefixValue,
			resultPrefix: isNullablePrefixValue,
			projectionArtifactRef: isArtifactRefValue,
			effectDigest: isStringValue,
		},
	},
	lease_renewed: {
		keys: ["kind", "runId", "candidateId", "attemptId", "leaseRef", "expiresAt"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "lease_renewed",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			leaseRef: isLeaseRefValue,
			expiresAt: isStringValue,
		},
	},
	candidate_claim_intent: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"role",
			"baseCommit",
			"grant",
			"resourceLease",
			"ownershipLease",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_claim_intent",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			role: isStringValue,
			baseCommit: isStringValue,
			grant: isTaskResourceGrantValue,
			resourceLease: isLeaseRecordValue,
			ownershipLease: isNullableLeaseRecordValue,
		},
	},
	candidate_dispatched: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"packetDigest",
			"branch",
			"worktree",
			"resourceLease",
			"ownershipLease",
			"childIdentity",
			"processBinding",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_dispatched",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			packetDigest: isStringValue,
			branch: isStringValue,
			worktree: isStringValue,
			resourceLease: isLeaseRecordValue,
			ownershipLease: isNullableLeaseRecordValue,
			childIdentity: isChildIdentityValue,
			processBinding: isProcessBindingValue,
		},
	},
	candidate_handoff_published: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"packetDigest",
			"childIdentity",
			"processBinding",
			"handoff",
			"handoffDigest",
			"evidenceDigest",
			"workspaceDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_handoff_published",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			packetDigest: isStringValue,
			childIdentity: isChildIdentityValue,
			processBinding: isProcessBindingValue,
			handoff: isAttemptHandoffValue,
			handoffDigest: isStringValue,
			evidenceDigest: isStringValue,
			workspaceDigest: isStringValue,
		},
	},
	finish_intent: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"packetDigest",
			"childIdentity",
			"processBinding",
			"decisionRef",
			"decisionDigest",
			"evidenceDigest",
			"evaluatorDigest",
			"guardDigest",
			"effectDigest",
			"expectedFrontier",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "finish_intent",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			packetDigest: isStringValue,
			childIdentity: isChildIdentityValue,
			processBinding: isProcessBindingValue,
			decisionRef: isDecisionRefValue,
			decisionDigest: isStringValue,
			evidenceDigest: isStringValue,
			evaluatorDigest: isStringValue,
			guardDigest: isNullableStringValue,
			effectDigest: isStringValue,
			expectedFrontier: isFrontierValue,
		},
	},
	metric_recorded: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"trialCommit",
			"metric",
			"parserDigest",
			"verifyLogDigest",
			"evidenceRefs",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "metric_recorded",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			trialCommit: isNullableStringValue,
			metric: isFiniteNumberValue,
			parserDigest: isStringValue,
			verifyLogDigest: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	guard_recorded: {
		keys: ["kind", "runId", "candidateId", "attemptId", "disposition", "guardDigest", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "guard_recorded",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			disposition: isStringValue,
			guardDigest: isNullableStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	admission_lock_acquired: {
		keys: ["kind", "runId", "lockId", "frontier", "lockOwner"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "admission_lock_acquired",
			runId: isStringValue,
			lockId: isStringValue,
			frontier: isFrontierValue,
			lockOwner: isStringValue,
		},
	},
	stale_rebase_requested: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"oldFrontier",
			"newFrontier",
			"rebaseCommit",
			"reason",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "stale_rebase_requested",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			oldFrontier: isFrontierValue,
			newFrontier: isFrontierValue,
			rebaseCommit: isNullableStringValue,
			reason: isStringValue,
		},
	},
	remeasured: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"rebaseCommit",
			"metric",
			"metricDigest",
			"guardDigest",
			"evidenceRefs",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "remeasured",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			rebaseCommit: isNullableStringValue,
			metric: isFiniteNumberValue,
			metricDigest: isNullableStringValue,
			guardDigest: isNullableStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	candidate_red_teamed: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"diffDigest",
			"resultDigest",
			"findings",
			"redTeamDigest",
			"disposition",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_red_teamed",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			diffDigest: isStringValue,
			resultDigest: isStringValue,
			findings: isArtifactRefArray,
			redTeamDigest: isStringValue,
			disposition: isStringValue,
		},
	},
	frontier_update_intent: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"frontierCas",
			"candidateCommit",
			"packetDigest",
			"evidenceDigest",
			"lockId",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "frontier_update_intent",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			frontierCas: isFrontierCasValue,
			candidateCommit: isStringValue,
			packetDigest: isStringValue,
			evidenceDigest: isStringValue,
			lockId: isStringValue,
		},
	},
	candidate_admitted: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"resolvedFrontier",
			"candidateCommit",
			"finishIntentDigest",
			"decisionDigest",
			"evidenceDigest",
			"strictImprovement",
			"guardPassed",
			"acceptancePassed",
			"redTeamDigest",
			"resultRefs",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_admitted",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			resolvedFrontier: isFrontierValue,
			candidateCommit: isStringValue,
			finishIntentDigest: isStringValue,
			decisionDigest: isStringValue,
			evidenceDigest: isStringValue,
			strictImprovement: isBooleanValue,
			guardPassed: isBooleanValue,
			acceptancePassed: isBooleanValue,
			redTeamDigest: isStringValue,
			resultRefs: isArtifactRefArray,
		},
	},
	candidate_discarded: {
		keys: [
			"kind",
			"runId",
			"candidateId",
			"attemptId",
			"reason",
			"trialCommit",
			"revertCommit",
			"metricDigest",
			"guardDigest",
			"redTeamDigest",
			"finishIntentDigest",
			"evidenceDigest",
			"frontierUnchanged",
			"frontierDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_discarded",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			reason: isStringValue,
			trialCommit: isNullableStringValue,
			revertCommit: isNullableStringValue,
			metricDigest: isNullableStringValue,
			guardDigest: isNullableStringValue,
			redTeamDigest: isStringValue,
			finishIntentDigest: isStringValue,
			evidenceDigest: isStringValue,
			frontierUnchanged: (value: unknown): boolean => value === true,
			frontierDigest: isStringValue,
		},
	},
	admission_lock_released: {
		keys: ["kind", "runId", "lockId", "frontierDigest", "status"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "admission_lock_released",
			runId: isStringValue,
			lockId: isStringValue,
			frontierDigest: isStringValue,
			status: isStringValue,
		},
	},
	candidate_abandoned: {
		keys: ["kind", "runId", "candidateId", "attemptId", "reason", "leaseEvidenceRefs", "noAdmission"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_abandoned",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			reason: isStringValue,
			leaseEvidenceRefs: isArtifactRefArray,
			noAdmission: (value: unknown): boolean => value === true,
		},
	},
	candidate_reaped: {
		keys: ["kind", "runId", "candidateId", "attemptId", "reason", "livenessEvidenceRefs", "noAdmission"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_reaped",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			reason: isStringValue,
			livenessEvidenceRefs: isArtifactRefArray,
			noAdmission: (value: unknown): boolean => value === true,
		},
	},
	recovery_classified: {
		keys: ["kind", "runId", "candidateId", "attemptId", "disposition", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "recovery_classified",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			disposition: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	candidate_target_observed: {
		keys: ["kind", "runId", "candidateId", "attemptId", "metric", "target", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "candidate_target_observed",
			runId: isStringValue,
			candidateId: isSafeIntegerValue,
			attemptId: isStringValue,
			metric: isFiniteNumberValue,
			target: isFiniteNumberValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	target_reached: {
		keys: ["kind", "runId", "source", "metric", "target", "frontierDigest", "status"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "target_reached",
			runId: isStringValue,
			source: isStringValue,
			metric: isFiniteNumberValue,
			target: isFiniteNumberValue,
			frontierDigest: isStringValue,
			status: isStringValue,
		},
	},
	verification_gap_found: {
		keys: ["kind", "runId", "gapDigest", "evidenceRefs", "reason", "replacementRequested"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "verification_gap_found",
			runId: isStringValue,
			gapDigest: isStringValue,
			evidenceRefs: isArtifactRefArray,
			reason: isStringValue,
			replacementRequested: (value: unknown): boolean => value === true,
		},
	},
	run_archive_intent: {
		keys: ["kind", "runId", "terminalPrefix", "archiveDestination", "decisionRefs", "descendantSetDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "run_archive_intent",
			runId: isStringValue,
			terminalPrefix: isNullablePrefixValue,
			archiveDestination: isStringValue,
			decisionRefs: isDecisionRefArrayValue,
			descendantSetDigest: isStringValue,
		},
	},
	run_archived: {
		keys: [
			"kind",
			"runId",
			"terminalPrefix",
			"archiveArtifactRef",
			"archiveDestination",
			"archiveDigest",
			"archivedAt",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "run_archived",
			runId: isStringValue,
			terminalPrefix: isNullablePrefixValue,
			archiveArtifactRef: isArtifactRefValue,
			archiveDestination: isStringValue,
			archiveDigest: isStringValue,
			archivedAt: isStringValue,
		},
	},
	verified: {
		keys: ["kind", "runId", "verificationDigest", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "verified",
			runId: isStringValue,
			verificationDigest: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	completion_audited: {
		keys: ["kind", "runId", "completionDigest", "redTeamDigest", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "completion_audited",
			runId: isStringValue,
			completionDigest: isStringValue,
			redTeamDigest: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	refinement_recorded: {
		keys: ["kind", "runId", "refinementDigest", "scope", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "refinement_recorded",
			runId: isStringValue,
			refinementDigest: isStringValue,
			scope: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	completed: {
		keys: ["kind", "runId", "completionDecisionRef", "finalDigest", "resultRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "completed",
			runId: isStringValue,
			completionDecisionRef: isDecisionRefValue,
			finalDigest: isStringValue,
			resultRefs: isArtifactRefArray,
		},
	},
	stop_requested: {
		keys: ["kind", "runId", "reason", "authorityDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "stop_requested",
			runId: isStringValue,
			reason: isStringValue,
			authorityDigest: isStringValue,
		},
	},
	budget_limited: {
		keys: ["kind", "runId", "budgetDigest", "reason"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "budget_limited",
			runId: isStringValue,
			budgetDigest: isStringValue,
			reason: isStringValue,
		},
	},
	blocked: {
		keys: ["kind", "runId", "blockerDigest", "reason", "evidenceRefs"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "blocked",
			runId: isStringValue,
			blockerDigest: isStringValue,
			reason: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	workflow_coordinator_lease_acquired: {
		keys: ["kind", "workflowId", "lease", "epochRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_coordinator_lease_acquired",
			workflowId: isStringValue,
			lease: isCoordinatorLeaseValue,
			epochRef: isEpochRefValue,
		},
	},
	workflow_coordinator_lease_renewed: {
		keys: ["kind", "workflowId", "leaseId", "epochRef", "renewedAt", "expiresAt"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_coordinator_lease_renewed",
			workflowId: isStringValue,
			leaseId: isStringValue,
			epochRef: isEpochRefValue,
			renewedAt: isStringValue,
			expiresAt: isStringValue,
		},
	},
	workflow_coordinator_fenced: {
		keys: ["kind", "workflowId", "leaseId", "epochRef", "reason"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_coordinator_fenced",
			workflowId: isStringValue,
			leaseId: isStringValue,
			epochRef: isEpochRefValue,
			reason: isStringValue,
		},
	},
	workflow_dispatch_readiness_observed: {
		keys: ["kind", "workflowId", "epochRef", "readinessDigest", "canDispatch", "blockingReasons"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_dispatch_readiness_observed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			readinessDigest: isStringValue,
			canDispatch: isBooleanValue,
			blockingReasons: isStringArrayValue,
		},
	},
	workflow_resource_lease_acquired: {
		keys: ["kind", "workflowId", "lease", "epochRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_resource_lease_acquired",
			workflowId: isStringValue,
			lease: isLeaseRecordValue,
			epochRef: isEpochRefValue,
		},
	},
	workflow_task_lease_heartbeat: {
		keys: [
			"kind",
			"workflowId",
			"taskId",
			"attemptId",
			"executionKey",
			"epochRef",
			"resourceLeaseRef",
			"observedAt",
			"priorExpiresAt",
			"renewedExpiresAt",
			"progressDigest",
			"heartbeatDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_task_lease_heartbeat",
			workflowId: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			executionKey: isStringValue,
			epochRef: isEpochRefValue,
			resourceLeaseRef: isLeaseRefValue,
			observedAt: isFiniteDateStringValue,
			priorExpiresAt: isFiniteDateStringValue,
			renewedExpiresAt: isFiniteDateStringValue,
			progressDigest: isDigestValue,
			heartbeatDigest: isDigestValue,
		},
	},
	workflow_ownership_lease_acquired: {
		keys: ["kind", "workflowId", "lease", "epochRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_ownership_lease_acquired",
			workflowId: isStringValue,
			lease: isLeaseRecordValue,
			epochRef: isEpochRefValue,
		},
	},
	workflow_dispatch_intent: {
		keys: [
			"kind",
			"workflowId",
			"taskId",
			"attemptId",
			"executionKey",
			"admissionId",
			"epochRef",
			"decisionRef",
			"resourceLeaseRef",
			"ownershipLeaseRef",
			"childAuthority",
			"launchConfigDigest",
			"expectedEffectDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_dispatch_intent",
			workflowId: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			executionKey: isStringValue,
			admissionId: isStringValue,
			epochRef: isEpochRefValue,
			decisionRef: isDecisionRefValue,
			resourceLeaseRef: isLeaseRefValue,
			ownershipLeaseRef: (field) => field === null || isLeaseRefValue(field),
			childAuthority: isChildAuthorityValue,
			launchConfigDigest: isStringValue,
			expectedEffectDigest: isStringValue,
		},
	},
	workflow_child_identity_bound: {
		keys: ["kind", "workflowId", "attemptId", "admissionId", "identity", "processBinding", "epochRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_child_identity_bound",
			workflowId: isStringValue,
			attemptId: isStringValue,
			admissionId: isStringValue,
			identity: isChildIdentityValue,
			processBinding: isProcessBindingValue,
			epochRef: isEpochRefValue,
		},
	},
	workflow_child_outcome_committed: {
		keys: ["kind", "workflowId", "attemptId", "executionKey", "outcome", "outcomeDigest", "epochRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_child_outcome_committed",
			workflowId: isStringValue,
			attemptId: isStringValue,
			executionKey: isStringValue,
			outcome: isPhaseOutcomeValue,
			outcomeDigest: isStringValue,
			epochRef: isEpochRefValue,
		},
	},
	workflow_external_blocker_recorded: {
		keys: ["kind", "workflowId", "epochRef", "blocker", "blockerDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_external_blocker_recorded",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			blocker: isExternalBlockerRecordValue,
			blockerDigest: isDigestValue,
		},
	},
	workflow_external_blocker_resolved: {
		keys: ["kind", "workflowId", "epochRef", "resolution", "resolutionDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_external_blocker_resolved",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			resolution: isExternalBlockerResolutionValue,
			resolutionDigest: isDigestValue,
		},
	},
	workflow_effect_intent: {
		keys: [
			"kind",
			"workflowId",
			"attemptId",
			"executionKey",
			"effectDigest",
			"decisionRef",
			"epochRef",
			"idempotencyKey",
			"effect",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_effect_intent",
			workflowId: isStringValue,
			attemptId: isStringValue,
			executionKey: isStringValue,
			effectDigest: isStringValue,
			decisionRef: isDecisionRefValue,
			epochRef: isEpochRefValue,
			idempotencyKey: isStringValue,
			effect: isConcreteEffectValue,
		},
	},
	workflow_effect_completed: {
		keys: [
			"kind",
			"workflowId",
			"attemptId",
			"executionKey",
			"effectDigest",
			"resultDigest",
			"idempotencyKey",
			"epochRef",
			"disposition",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_effect_completed",
			workflowId: isStringValue,
			attemptId: isStringValue,
			executionKey: isStringValue,
			effectDigest: isStringValue,
			resultDigest: isStringValue,
			idempotencyKey: isStringValue,
			epochRef: isEpochRefValue,
			disposition: isStringValue,
		},
	},
	workflow_effect_ambiguous: {
		keys: [
			"kind",
			"workflowId",
			"attemptId",
			"executionKey",
			"effectDigest",
			"idempotencyKey",
			"epochRef",
			"reason",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_effect_ambiguous",
			workflowId: isStringValue,
			attemptId: isStringValue,
			executionKey: isStringValue,
			effectDigest: isStringValue,
			idempotencyKey: isStringValue,
			epochRef: isEpochRefValue,
			reason: isStringValue,
		},
	},
	workflow_process_group_owned: {
		keys: ["kind", "workflowId", "attemptId", "processGroup", "epochRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_process_group_owned",
			workflowId: isStringValue,
			attemptId: isStringValue,
			processGroup: isProcessGroupValue,
			epochRef: isEpochRefValue,
		},
	},
	workflow_process_group_fenced: {
		keys: ["kind", "workflowId", "attemptId", "processGroup", "epochRef", "reason"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_process_group_fenced",
			workflowId: isStringValue,
			attemptId: isStringValue,
			processGroup: isProcessGroupValue,
			epochRef: isEpochRefValue,
			reason: isStringValue,
		},
	},
	workflow_process_group_reaped: {
		keys: ["kind", "workflowId", "attemptId", "processGroupId", "epochRef", "remainingPids", "reapDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_process_group_reaped",
			workflowId: isStringValue,
			attemptId: isStringValue,
			processGroupId: isStringValue,
			epochRef: isEpochRefValue,
			remainingPids: isIntegerArrayValue,
			reapDigest: isStringValue,
		},
	},
	workflow_lease_release_recorded: {
		keys: ["kind", "workflowId", "releaseRef", "epochRef", "status"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_lease_release_recorded",
			workflowId: isStringValue,
			releaseRef: isRecursiveRecordValue,
			epochRef: isEpochRefValue,
			status: isStringValue,
		},
	},
	workflow_lease_quarantined: {
		keys: ["kind", "workflowId", "leaseRef", "epochRef", "reason"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_lease_quarantined",
			workflowId: isStringValue,
			leaseRef: isLeaseRefValue,
			epochRef: isEpochRefValue,
			reason: isStringValue,
		},
	},
	workflow_scheduler_observation: {
		keys: ["kind", "workflowId", "epochRef", "readyTaskIds", "queue", "inventoryDigest", "limiterDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_scheduler_observation",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			readyTaskIds: isStringArrayValue,
			queue: isRecursiveArrayValue,
			inventoryDigest: isStringValue,
			limiterDigest: isStringValue,
		},
	},
	workflow_progress_lease_acquired: {
		keys: ["kind", "workflowId", "epochRef", "cut", "cutDigest", "lease", "leaseDigest", "sourceOutcome"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_progress_lease_acquired",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			cut: isAuthoritativeProgressCutValue,
			cutDigest: isDigestValue,
			lease: isProgressLeaseValue,
			leaseDigest: isDigestValue,
			sourceOutcome: (value) => value === null || isProgressSourceOutcomeValue(value),
		},
	},
	workflow_progress_stalled: {
		keys: ["kind", "workflowId", "epochRef", "record", "recordDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_progress_stalled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			record: isProgressStallRecordValue,
			recordDigest: isDigestValue,
		},
	},
	workflow_progress_lease_closed: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"leaseId",
			"sourceOutcome",
			"closedAt",
			"disposition",
			"closureDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_progress_lease_closed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			leaseId: isStringValue,
			sourceOutcome: isProgressSourceOutcomeValue,
			closedAt: (field) => typeof field === "string" && Number.isFinite(Date.parse(field)),
			disposition: (field) => field === "advanced" || field === "terminal",
			closureDigest: isDigestValue,
		},
	},
	workflow_progress_recovery_started: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"leaseId",
			"wakeObligationId",
			"recoveryAttempt",
			"recoveryStartedAt",
			"recoveryDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_progress_recovery_started",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			leaseId: isStringValue,
			wakeObligationId: isStringValue,
			recoveryAttempt: (field) => isSafeIntegerValue(field) && field >= 1,
			recoveryStartedAt: (field) => typeof field === "string" && Number.isFinite(Date.parse(field)),
			recoveryDigest: isDigestValue,
		},
	},
	workflow_recovery_started: {
		keys: ["kind", "workflowId", "epochRef", "journalHeadDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_recovery_started",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			journalHeadDigest: isStringValue,
		},
	},
	workflow_reconciliation_recorded: {
		keys: ["kind", "workflowId", "attemptId", "epochRef", "outcome", "outcomeDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_reconciliation_recorded",
			workflowId: isStringValue,
			attemptId: isStringValue,
			epochRef: isEpochRefValue,
			outcome: isReconciliationOutcomeValue,
			outcomeDigest: isStringValue,
		},
	},
	workflow_observation_outcome_recorded: {
		keys: ["kind", "workflowId", "epochRef", "record", "recordDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_observation_outcome_recorded",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			record: isObservationOutcomeRecordValue,
			recordDigest: isDigestValue,
		},
	},
	workflow_completion_cut_sealed: {
		keys: ["kind", "workflowId", "epochRef", "cut", "cutDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_completion_cut_sealed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			cut: isObservationCompletionCutValue,
			cutDigest: isDigestValue,
		},
	},
	workflow_late_observation_policy_recorded: {
		keys: ["kind", "workflowId", "epochRef", "record", "recordDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_late_observation_policy_recorded",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			record: isObservationLatePolicyRecordValue,
			recordDigest: isDigestValue,
		},
	},
	workflow_cancellation_intent: {
		keys: ["kind", "workflowId", "epochRef", "reason", "descendantSetDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_cancellation_intent",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			reason: isStringValue,
			descendantSetDigest: isStringValue,
		},
	},
	workflow_cancellation_descendants_reconciled: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"descendantSetDigest",
			"reconciliationDigest",
			"leaseBarrierDigest",
			"attemptOutcomes",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_cancellation_descendants_reconciled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			descendantSetDigest: isStringValue,
			reconciliationDigest: isStringValue,
			leaseBarrierDigest: isStringValue,
			attemptOutcomes: isRecursiveArrayValue,
		},
	},
	workflow_cancelled: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"barrierEventSequence",
			"descendantSetDigest",
			"reconciliationDigest",
			"leaseBarrierDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "workflow_cancelled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			barrierEventSequence: isSafeIntegerValue,
			descendantSetDigest: isStringValue,
			reconciliationDigest: isStringValue,
			leaseBarrierDigest: isStringValue,
		},
	},
	checkpoint_budget_observed: {
		keys: [
			"schemaVersion",
			"eventId",
			"idempotencyKey",
			"kind",
			"workflowId",
			"taskId",
			"attemptId",
			"processGenerationId",
			"runtimeVersion",
			"head",
			"epochRef",
			"source",
			"authority",
			"classificationAuthority",
			"completionEvidence",
			"mockOnly",
			"publicBoundary",
			"bindingDigest",
			"resourceDigest",
			"operationDigest",
			"receiptDigest",
			"authorizationDigest",
			"fenceDigest",
			"requiredStateRegistryDigest",
			"requiredStateRegistry",
			"requiredStateIds",
			"missingRequiredStateIds",
			"checkpointTurn",
			"serializeStartedAtMonotonicMs",
			"serializeEndedAtMonotonicMs",
			"restoreStartedAtMonotonicMs",
			"restoreEndedAtMonotonicMs",
			"observedAtMonotonicMs",
			"bytesWritten",
			"durableBytes",
			"retainedValues",
			"previousObservationDigest",
			"previousCheckpointTurn",
			"previousDurableBytes",
			"durabilityOutcome",
			"failureReason",
			"observationDigest",
		] as const,
		fields: {
			schemaVersion: (value: unknown): boolean => value === 1,
			eventId: isStringValue,
			idempotencyKey: isStringValue,
			kind: (value: unknown): boolean => value === "checkpoint_budget_observed",
			workflowId: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			processGenerationId: isStringValue,
			runtimeVersion: isStringValue,
			head: isWorkflowJournalHeadValue,
			epochRef: isEpochRefValue,
			source: (value: unknown): boolean => value === "host",
			authority: (value: unknown): boolean => value === "host_committed",
			classificationAuthority: (value: unknown): boolean => value === "host",
			completionEvidence: (value: unknown): boolean => value === "none",
			mockOnly: (value: unknown): boolean => value === false,
			publicBoundary: isStringValue,
			bindingDigest: isDigestValue,
			resourceDigest: isDigestValue,
			operationDigest: isDigestValue,
			receiptDigest: isDigestValue,
			authorizationDigest: isDigestValue,
			fenceDigest: isDigestValue,
			requiredStateRegistryDigest: isDigestValue,
			requiredStateRegistry: isCheckpointBudgetRequiredStateArrayValue,
			requiredStateIds: isStringArrayValue,
			missingRequiredStateIds: isStringArrayValue,
			checkpointTurn: (value: unknown): boolean => isSafeIntegerValue(value) && (value as number) >= 0,
			serializeStartedAtMonotonicMs: (value: unknown): boolean =>
				isSafeIntegerValue(value) && (value as number) >= 0,
			serializeEndedAtMonotonicMs: (value: unknown): boolean => isSafeIntegerValue(value) && (value as number) >= 0,
			restoreStartedAtMonotonicMs: (value: unknown): boolean =>
				value === null || (isSafeIntegerValue(value) && (value as number) >= 0),
			restoreEndedAtMonotonicMs: (value: unknown): boolean =>
				value === null || (isSafeIntegerValue(value) && (value as number) >= 0),
			observedAtMonotonicMs: (value: unknown): boolean => isSafeIntegerValue(value) && (value as number) >= 0,
			bytesWritten: (value: unknown): boolean => isSafeIntegerValue(value) && (value as number) >= 0,
			durableBytes: (value: unknown): boolean => isSafeIntegerValue(value) && (value as number) >= 0,
			retainedValues: isCheckpointBudgetRetainedValueArrayValue,
			previousObservationDigest: isNullableDigestValue,
			previousCheckpointTurn: (value: unknown): boolean =>
				value === null || (isSafeIntegerValue(value) && (value as number) >= 0),
			previousDurableBytes: (value: unknown): boolean =>
				value === null || (isSafeIntegerValue(value) && (value as number) >= 0),
			durabilityOutcome: (value: unknown): boolean => value === "durable",
			failureReason: (value: unknown): boolean => value === null,
			observationDigest: isDigestValue,
		},
	},
	adaptive_observed: {
		keys: ["kind", "workflowId", "epochRef", "observation"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_observed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observation: isAdaptiveAllocationObservationValue,
		},
	},
	adaptive_observation_coalesced: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "supersededObservationDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_observation_coalesced",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			supersededObservationDigest: isStringValue,
		},
	},
	adaptive_observation_superseded: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "supersededObservationDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_observation_superseded",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			supersededObservationDigest: isStringValue,
		},
	},
	adaptive_observation_stale: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reasonDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_observation_stale",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reasonDigest: isStringValue,
		},
	},
	adaptive_observation_cancelled: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reasonDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_observation_cancelled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reasonDigest: isStringValue,
		},
	},
	adaptive_controller_recovered: {
		keys: ["kind", "workflowId", "epochRef", "recoveryDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_controller_recovered",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			recoveryDigest: isStringValue,
		},
	},
	adaptive_review_started: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reviewId"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_review_started",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reviewId: isStringValue,
		},
	},
	adaptive_review_completed: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"observationDigest",
			"reviewId",
			"resultDigest",
			"evidenceRefs",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_review_completed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reviewId: isStringValue,
			resultDigest: isStringValue,
			evidenceRefs: isArtifactRefArray,
		},
	},
	adaptive_review_cancelled: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reviewId", "reasonDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_review_cancelled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reviewId: isStringValue,
			reasonDigest: isStringValue,
		},
	},
	adaptive_review_fenced: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reviewId", "fenceDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_review_fenced",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reviewId: isStringValue,
			fenceDigest: isStringValue,
		},
	},
	adaptive_review_recovered: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reviewId", "recoveryDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_review_recovered",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reviewId: isStringValue,
			recoveryDigest: isStringValue,
		},
	},
	adaptive_review_stale_result: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "reviewId", "resultDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_review_stale_result",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			reviewId: isStringValue,
			resultDigest: isStringValue,
		},
	},
	adaptive_reconciled: {
		keys: ["kind", "workflowId", "epochRef", "observationDigest", "stateDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_reconciled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			observationDigest: isStringValue,
			stateDigest: isStringValue,
		},
	},
	adaptive_allocation_intent: {
		keys: [
			"kind",
			"workflowId",
			"allocationDigest",
			"taskId",
			"attemptId",
			"leaseRef",
			"epochRef",
			"idempotencyKey",
			"certificateDigest",
			"taskValueCertificateDigest",
			"allocationEntry",
			"decisionRef",
			"decisionReceipt",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_allocation_intent",
			workflowId: isStringValue,
			allocationDigest: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			leaseRef: isLeaseRefValue,
			epochRef: isEpochRefValue,
			idempotencyKey: isStringValue,
			certificateDigest: isStringValue,
			taskValueCertificateDigest: isStringValue,
			allocationEntry: isRecursiveRecordValue,
			decisionRef: isDecisionRefValue,
			decisionReceipt: isVerifiedHostReceiptValue,
		},
	},
	adaptive_allocation_applied: {
		keys: [
			"kind",
			"workflowId",
			"allocationDigest",
			"ledgerHeadDigest",
			"epochRef",
			"idempotencyKey",
			"lastSafeAllocationTupleRef",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_allocation_applied",
			workflowId: isStringValue,
			allocationDigest: isStringValue,
			ledgerHeadDigest: isStringValue,
			epochRef: isEpochRefValue,
			idempotencyKey: isStringValue,
			lastSafeAllocationTupleRef: isArtifactRefValue,
		},
	},
	adaptive_allocation_uncertain: {
		keys: ["kind", "workflowId", "allocationDigest", "epochRef", "reason"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_allocation_uncertain",
			workflowId: isStringValue,
			allocationDigest: isStringValue,
			epochRef: isEpochRefValue,
			reason: (value: unknown): boolean =>
				["crash_before_effect", "provider_unknown", "release_unknown"].includes(String(value)),
		},
	},
	adaptive_allocation_reconciled: {
		keys: ["kind", "workflowId", "allocationDigest", "ledgerHeadDigest", "epochRef", "nonExecutionReceipt"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_allocation_reconciled",
			workflowId: isStringValue,
			allocationDigest: isStringValue,
			ledgerHeadDigest: isStringValue,
			epochRef: isEpochRefValue,
			nonExecutionReceipt: isVerifiedHostReceiptValue,
		},
	},
	adaptive_allocation_reserved: {
		keys: ["kind", "workflowId", "epochRef", "allocationDigest", "taskId", "attemptId", "leaseRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_allocation_reserved",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			allocationDigest: isStringValue,
			taskId: isStringValue,
			attemptId: isStringValue,
			leaseRef: isLeaseRefValue,
		},
	},
	adaptive_allocation_reallocated: {
		keys: ["kind", "workflowId", "epochRef", "allocationDigest", "priorLeaseRef", "nextLeaseRef"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_allocation_reallocated",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			allocationDigest: isStringValue,
			priorLeaseRef: isLeaseRefValue,
			nextLeaseRef: isLeaseRefValue,
		},
	},
	adaptive_measured: {
		keys: ["kind", "workflowId", "epochRef", "state"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_measured",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			state: isAdaptiveAllocationStateValue,
		},
	},
	adaptive_rollback_applied: {
		keys: ["kind", "workflowId", "epochRef", "priorAllocationDigest", "restoredStateDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "adaptive_rollback_applied",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			priorAllocationDigest: isStringValue,
			restoredStateDigest: isStringValue,
		},
	},
	improvement_proposed: {
		keys: ["kind", "workflowId", "epochRef", "proposal"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "improvement_proposed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			proposal: isImprovementProposalValue,
		},
	},
	improvement_reviewed: {
		keys: ["kind", "workflowId", "epochRef", "result"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "improvement_reviewed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			result: isImprovementReviewResultValue,
		},
	},
	policy_revision_recorded: {
		keys: ["kind", "workflowId", "epochRef", "revision"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "policy_revision_recorded",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			revision: isPolicyRevisionValue,
		},
	},
	efficiency_red_team_scheduled: {
		keys: ["kind", "workflowId", "epochRef", "schedule"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_scheduled",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			schedule: isEfficiencyReviewScheduleValue,
		},
	},
	efficiency_red_team_snapshot_published: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"runId",
			"dueWindowId",
			"trigger",
			"clockSequence",
			"clockObservation",
			"snapshot",
			"supersededPendingRunId",
			"supersessionDigest",
			"fencedActiveRunId",
			"activeFenceDigest",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_snapshot_published",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			runId: isStringValue,
			dueWindowId: isStringValue,
			trigger: (value: unknown): boolean =>
				[
					"scheduled_window",
					"task_terminal",
					"phase_transition",
					"result_transition",
					"lease_release",
					"material_evidence_transition",
					"incident",
					"recovery_boundary",
					"completion_gate",
				].includes(String(value)),
			clockSequence: isSafeIntegerValue,
			clockObservation: isRecursiveRecordValue,
			snapshot: isRecursiveRecordValue,
			supersededPendingRunId: isNullableStringValue,
			supersessionDigest: isNullableStringValue,
			fencedActiveRunId: isNullableStringValue,
			activeFenceDigest: isNullableStringValue,
		},
	},
	efficiency_red_team_started: {
		keys: ["kind", "workflowId", "epochRef", "runId", "dueWindowId", "hostExecutionId"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_started",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			runId: isStringValue,
			dueWindowId: isStringValue,
			hostExecutionId: isStringValue,
		},
	},
	efficiency_red_team_completed: {
		keys: ["kind", "workflowId", "epochRef", "report"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_completed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			report: isEfficiencyReviewReportValue,
		},
	},
	efficiency_red_team_suggestion_recorded: {
		keys: ["kind", "workflowId", "epochRef", "report"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_suggestion_recorded",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			report: isEfficiencyReviewReportValue,
		},
	},
	efficiency_red_team_overlap_rejected: {
		keys: ["kind", "workflowId", "epochRef", "dueWindowId", "reason"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_overlap_rejected",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			dueWindowId: isStringValue,
			reason: isStringValue,
		},
	},
	efficiency_red_team_catch_up_consumed: {
		keys: ["kind", "workflowId", "epochRef", "dueWindowId", "reportDigest", "catchUp"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_catch_up_consumed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			dueWindowId: isStringValue,
			reportDigest: isNullableStringValue,
			catchUp: (value: unknown): boolean => value === true,
		},
	},
	efficiency_red_team_failed: {
		keys: [
			"kind",
			"workflowId",
			"epochRef",
			"dueWindowId",
			"runId",
			"failureDigest",
			"status",
			"recoveryBoundary",
		] as const,
		fields: {
			kind: (value: unknown): boolean => value === "efficiency_red_team_failed",
			workflowId: isStringValue,
			epochRef: isEpochRefValue,
			dueWindowId: isStringValue,
			runId: isStringValue,
			failureDigest: isStringValue,
			status: (value: unknown): boolean => ["failed", "cancelled", "fenced"].includes(String(value)),
			recoveryBoundary: (value: unknown): boolean => value === "none" || value === "recovered",
		},
	},
	knowledge_record_committed: {
		keys: ["kind", "idempotencyKey", "record", "previous", "previousDigest", "proposalDigest"] as const,
		fields: {
			kind: (value: unknown): boolean => value === "knowledge_record_committed",
			idempotencyKey: isStringValue,
			record: isRecursiveRecordValue,
			previous: (value: unknown): boolean => value === null || isRecursiveRecordValue(value),
			previousDigest: (value: unknown): boolean => value === null || isStringValue(value),
			proposalDigest: isStringValue,
		},
	},
} satisfies WorkflowEventShapeRegistry;

interface WorkflowJournalDurableStorage {
	readonly diagnosticPath: string;
	readJournalBytes(): Promise<Uint8Array>;
	appendJournalFrame(
		bytes: Uint8Array,
		input: {
			workflowId: string;
			mutationId: string;
			digest: string;
			frameKind: WorkflowFrameKind;
			beforeSync: DurableStoreCrashBoundary;
			afterSync: DurableStoreCrashBoundary;
		},
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<void>;
	readImmutable(components: readonly string[]): Promise<Uint8Array | null>;
	publishImmutable(
		components: readonly string[],
		bytes: Uint8Array,
		input: {
			workflowId: string;
			mutationId: string;
			digest: string;
			checkpoints: readonly DurableStoreCrashBoundary[];
		},
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<"created" | "already_exists">;
	publishHead(components: readonly string[], expectedBytes: Uint8Array | null, nextBytes: Uint8Array): Promise<void>;
	readOutboxBytes(): Promise<Uint8Array>;
	appendOutboxFrame(
		bytes: Uint8Array,
		input: { workflowId: string; mutationId: string; digest: string },
		hook?: DurableStoreCrashBoundaryHook,
	): Promise<void>;
}

const workflowDescriptorContextToken: unique symbol = Symbol("workflow-descriptor-context");
const workflowReturnProofStoreOwners = new WeakMap<object, WorkflowDescriptorContext>();
const workflowRotationStoreOwners = new WeakMap<object, WorkflowDescriptorContext>();

function storageBelongsToContext(storage: WorkflowDescriptorStorage, context: WorkflowDescriptorContext): boolean {
	return Reflect.get(storage, workflowDescriptorContextToken) === context;
}

function markStorageContext(storage: WorkflowJournalDurableStorage, context: WorkflowDescriptorContext): void {
	Object.defineProperty(storage, workflowDescriptorContextToken, {
		value: context,
		enumerable: true,
		configurable: false,
		writable: false,
	});
}

function isWorkflowJournalDurableStoragePort(
	value: WorkflowDescriptorStorage,
): value is WorkflowDescriptorStorage & WorkflowJournalDurableStorage {
	return (
		value !== null &&
		typeof value === "object" &&
		"diagnosticPath" in value &&
		typeof value.diagnosticPath === "string" &&
		"readJournalBytes" in value &&
		typeof value.readJournalBytes === "function" &&
		"appendJournalFrame" in value &&
		typeof value.appendJournalFrame === "function" &&
		"readImmutable" in value &&
		typeof value.readImmutable === "function" &&
		"publishImmutable" in value &&
		typeof value.publishImmutable === "function" &&
		"publishHead" in value &&
		typeof value.publishHead === "function" &&
		"readOutboxBytes" in value &&
		typeof value.readOutboxBytes === "function" &&
		"appendOutboxFrame" in value &&
		typeof value.appendOutboxFrame === "function"
	);
}

interface WorkflowDurableFlushProof {
	mutationId: string;
	frameKind: WorkflowFrameKind;
	frameDigest: string;
	fileIdentityDigest: string;
	parentDirectoryIdentityDigest: string;
	fileSynced: true;
	parentDirectorySynced: true;
	proofDigest: string;
	sideRecordMac: string;
}

function isWorkflowDurableFlushProofValue(value: unknown): value is WorkflowDurableFlushProof {
	return exactRecord(
		value,
		[
			"mutationId",
			"frameKind",
			"frameDigest",
			"fileIdentityDigest",
			"parentDirectoryIdentityDigest",
			"fileSynced",
			"parentDirectorySynced",
			"proofDigest",
			"sideRecordMac",
		],
		{
			mutationId: isStringValue,
			frameKind: (field) =>
				field === "prepared" ||
				field === "committed" ||
				field === "outbox" ||
				field === "snapshot" ||
				field === "side_record",
			frameDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			fileIdentityDigest: isStringValue,
			parentDirectoryIdentityDigest: isStringValue,
			fileSynced: (field) => field === true,
			parentDirectorySynced: (field) => field === true,
			proofDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			sideRecordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		},
	);
}

function flushProofComponents(mutationId: string, frameKind: WorkflowFrameKind): readonly string[] {
	assertSafeIdentifier(mutationId, "flush-proof mutation id");
	assertSafeIdentifier(frameKind, "flush-proof frame kind");
	return ["flush-proofs", `${sha256Hex(new TextEncoder().encode(`${mutationId}:${frameKind}`))}.json`];
}

function assertSafeIdentifier(value: string, label: string): void {
	if (
		value.length === 0 ||
		value === "." ||
		value === ".." ||
		value.includes("/") ||
		value.includes("\\") ||
		value.includes("\0")
	)
		throw new Error(`${label} is not a safe single path component.`);
}

function assertCanonicalDescriptorRootPath(value: string, label: string): void {
	const components = value.split("/");
	const relativeComponents = value.startsWith("/") ? components.slice(1) : components;
	if (
		value.length === 0 ||
		!value.startsWith("/") ||
		value.includes("\\") ||
		value.includes("\0") ||
		/^[A-Za-z]:/.test(value) ||
		relativeComponents.some((component) => component.length === 0 || component === "." || component === "..")
	)
		throw new Error(`${label} is not a canonical host-rooted descriptor path.`);
}

function assertWorkflowIdentity(artifactRoot: string, workflowDir: string, workflowId: string): void {
	assertSafeIdentifier(workflowId, "workflowId");
	assertCanonicalDescriptorRootPath(artifactRoot, "artifactRoot");
	assertCanonicalDescriptorRootPath(workflowDir, "workflowDir");
	const expectedWorkflowDir = `${artifactRoot}/workflows/${workflowId}`;
	if (workflowDir !== expectedWorkflowDir)
		throw new Error("Workflow directory is not rooted at the validated artifact root.");
}

function assertSessionRootIdentity(
	sessionArtifactRoot: string,
	artifactRoot: string,
	rootSessionId: string,
	workflowId: string,
): void {
	assertSafeIdentifier(rootSessionId, "rootSessionId");
	if (sessionArtifactRoot !== artifactRoot)
		throw new Error("Session artifact root does not match the validated artifact root.");
	assertWorkflowIdentity(artifactRoot, `${artifactRoot}/workflows/${workflowId}`, workflowId);
}

function assertLeaseAtBoundary(
	appendLease: WorkflowAppendLease,
	rootDigest: string,
	input: { workflowId: string; writerIdentity: string; leaseRef: WorkflowLeaseRef; epochRef: WorkflowEpochRef },
	boundary: string,
): Promise<void> {
	return appendLease.assertOwned({ ...input, rootDigest, boundary });
}

function assertArtifactPublishInput(workflowId: string, input: WorkflowArtifactPublishInput): void {
	if (
		input.workflowId !== workflowId ||
		input.bytes.byteLength < 0 ||
		input.idempotencyKey.length === 0 ||
		input.sourceEventSequence < 0
	)
		throw new Error("Artifact publication is not bound to the workflow root.");
}

function deriveContentAddressedArtifactRef(input: WorkflowArtifactPublishInput): WorkflowArtifactRef {
	const digest = sha256Hex(input.bytes);
	return {
		artifactId: `${input.payloadKind}:${digest}`,
		relativePath: `artifacts/${input.artifactNamespace ?? input.payloadKind}/${digest}`,
		digest,
		sizeBytes: input.bytes.byteLength,
		sourceEventSequence: input.sourceEventSequence,
	};
}

function artifactComponents(ref: WorkflowArtifactRef): readonly string[] {
	const components = ref.relativePath.split("/");
	if (
		components.length !== 3 ||
		components[0] !== "artifacts" ||
		components.some((component) => component.length === 0 || component === "." || component === "..")
	)
		throw new Error("Artifact publication requires separate canonical artifacts/kind/digest descriptor components.");
	assertSafeIdentifier(components[0], "artifact root component");
	assertSafeIdentifier(components[1], "artifact kind component");
	assertSafeIdentifier(components[2], "artifact digest component");
	return components;
}

function artifactMetadataComponents(ref: WorkflowArtifactRef): readonly string[] {
	const components = artifactComponents(ref);
	return [components[0], components[1], `${components[2]}.metadata.json`];
}

interface WorkflowArtifactIdempotencyRecord {
	workflowId: string;
	idempotencyKey: string;
	tupleDigest: string;
	keyId: string;
	generationId: string;
	epochRef: WorkflowEpochRef;
	sideRecordMac: string;
}

function isWorkflowArtifactIdempotencyRecordValue(value: unknown): value is WorkflowArtifactIdempotencyRecord {
	return exactRecord(
		value,
		["workflowId", "idempotencyKey", "tupleDigest", "keyId", "generationId", "epochRef", "sideRecordMac"],
		{
			workflowId: isStringValue,
			idempotencyKey: isStringValue,
			tupleDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			keyId: isStringValue,
			generationId: (field) => typeof field === "string" && /^generation-[0-9a-f]{32}$/.test(field),
			epochRef: isEpochRefValue,
			sideRecordMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		},
	);
}

function artifactIdempotencyComponents(idempotencyKey: string): readonly string[] {
	return ["artifact-idempotency", `${sha256Hex(new TextEncoder().encode(idempotencyKey))}.json`];
}

function decodeArtifactIdempotencyRecord(bytes: Uint8Array, hostSecret: Uint8Array): WorkflowArtifactIdempotencyRecord {
	const value = parseCanonicalJsonBytes(bytes);
	if (!isWorkflowArtifactIdempotencyRecordValue(value))
		throw new Error("Artifact idempotency record is not a canonical host-authenticated tuple.");
	const expectedSideRecordMac = sideRecordMac(
		{
			workflowId: value.workflowId,
			idempotencyKey: value.idempotencyKey,
			tupleDigest: value.tupleDigest,
			keyId: value.keyId,
			generationId: value.generationId,
			epochRef: value.epochRef,
			sideRecordMac: "",
		},
		hostSecret,
	);
	if (!sameFixedHex(value.sideRecordMac, expectedSideRecordMac, 32))
		throw new Error("Artifact idempotency record is not a canonical host-authenticated tuple.");
	return value;
}

async function assertPrivateRegularJournal(storage: WorkflowJournalDurableStorage): Promise<void> {
	const bytes = await storage.readJournalBytes();
	if (bytes.byteLength < 0) throw new Error("Journal descriptor read failed.");
}

async function openDescriptorDirectoryChain(
	descriptorFs: WorkflowDescriptorFs,
	root: WorkflowDescriptorHandle,
	components: readonly string[],
	create: boolean,
): Promise<WorkflowDescriptorHandle> {
	let current = root;
	const directoryFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);
	for (const component of components) {
		assertSafeIdentifier(component, "descriptor component");
		let next: WorkflowDescriptorHandle;
		try {
			next = await descriptorFs.openAt(current, component, directoryFlags, 0o700);
		} catch (error) {
			if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") {
				if (current !== root) await current.close().catch(() => undefined);
				throw error;
			}
			try {
				next = await descriptorFs.mkdirAt(current, component, 0o700);
			} catch (mkdirError) {
				if (current !== root) await current.close().catch(() => undefined);
				throw mkdirError;
			}
		}
		try {
			const stats = await next.stat();
			if (
				stats.kind !== "directory" ||
				stats.linkCount < 1 ||
				!Number.isSafeInteger(stats.device) ||
				stats.device <= 0 ||
				stats.identityDigest !== next.identityDigest
			)
				throw new Error(
					"Descriptor path component is not a private no-follow directory with a stable opened identity.",
				);
			if (current !== root) await current.close();
			current = next;
		} catch (error) {
			await next.close().catch(() => undefined);
			if (current !== root) await current.close().catch(() => undefined);
			throw error;
		}
	}
	return current;
}

async function openDescriptorLeaf(
	descriptorFs: WorkflowDescriptorFs,
	root: WorkflowDescriptorHandle,
	components: readonly string[],
	flags: number,
	mode: number,
	createDirectories: boolean,
): Promise<{ parent: WorkflowDescriptorHandle; leaf: WorkflowDescriptorHandle }> {
	if (components.length === 0) throw new Error("Descriptor leaf requires a non-empty component path.");
	const parent = await openDescriptorDirectoryChain(descriptorFs, root, components.slice(0, -1), createDirectories);
	let leaf: WorkflowDescriptorHandle | undefined;
	try {
		leaf = await descriptorFs.openAt(parent, components[components.length - 1], flags, mode);
		const stats = await leaf.stat();
		if (
			stats.kind !== "file" ||
			stats.linkCount !== 1 ||
			!Number.isSafeInteger(stats.device) ||
			stats.device <= 0 ||
			stats.identityDigest !== leaf.identityDigest
		)
			throw new Error("Descriptor leaf is not a private no-follow regular file with a stable opened identity.");
		return { parent, leaf };
	} catch (error) {
		if (leaf !== undefined) await leaf.close().catch(() => undefined);
		if (parent !== root) await parent.close().catch(() => undefined);
		throw error;
	}
}

async function readOpenedRegularLeaf(leaf: WorkflowDescriptorHandle): Promise<Uint8Array> {
	const stats = await leaf.stat();
	if (
		stats.kind !== "file" ||
		stats.linkCount !== 1 ||
		!Number.isSafeInteger(stats.device) ||
		stats.device <= 0 ||
		stats.identityDigest !== leaf.identityDigest
	)
		throw new Error(
			"Descriptor publication comparison requires a no-follow regular leaf with stable opened identity.",
		);
	return leaf.read();
}

async function readDescriptorBytesIfPresent(
	descriptorFs: WorkflowDescriptorFs,
	root: WorkflowDescriptorHandle,
	components: readonly string[],
): Promise<Uint8Array | null> {
	try {
		const opened = await openDescriptorLeaf(
			descriptorFs,
			root,
			components,
			fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
			0o600,
			false,
		);
		try {
			return await readOpenedRegularLeaf(opened.leaf);
		} finally {
			await opened.leaf.close().catch(() => undefined);
			if (opened.parent !== root) await opened.parent.close().catch(() => undefined);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function writeDescriptorBytes(
	descriptorFs: WorkflowDescriptorFs,
	root: WorkflowDescriptorHandle,
	components: readonly string[],
	bytes: Uint8Array,
	exclusive: boolean,
): Promise<"created" | "already_exists"> {
	if (components.length === 0) throw new Error("Atomic descriptor publication requires a leaf component.");
	const leafComponent = components[components.length - 1];
	const parent = await openDescriptorDirectoryChain(descriptorFs, root, components.slice(0, -1), true);
	const tempComponent = `.${leafComponent}.tmp-${randomUUID()}`;
	assertSafeIdentifier(tempComponent, "descriptor temporary component");
	let temp: WorkflowDescriptorHandle | undefined;
	try {
		temp = await descriptorFs.openAt(
			parent,
			tempComponent,
			fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0),
			0o600,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") {
			if (parent !== root) await parent.close().catch(() => undefined);
			throw new Error("Descriptor temporary name collision is not recoverable without overwriting another writer.");
		}
		if (parent !== root) await parent.close().catch(() => undefined);
		throw error;
	}
	try {
		await temp.write(bytes);
		await temp.sync();
		if (exclusive) {
			try {
				const existing = await descriptorFs.openAt(
					parent,
					leafComponent,
					fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
					0o600,
				);
				let existingBytes: Uint8Array;
				try {
					existingBytes = await readOpenedRegularLeaf(existing);
				} finally {
					await existing.close().catch(() => undefined);
				}
				await temp.close();
				await descriptorFs.unlinkAt(parent, tempComponent);
				await descriptorFs.syncDirectoryChain(parent, root);
				if (!sameBytes(existingBytes, bytes))
					throw new Error("Immutable descriptor publication found conflicting bytes at the concurrent target.");
				return "already_exists";
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		try {
			await descriptorFs.renameAt(parent, tempComponent, leafComponent, {
				replace: !exclusive,
				noReplace: exclusive,
			});
		} catch (error) {
			if (!exclusive || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const existing = await descriptorFs.openAt(
				parent,
				leafComponent,
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
			);
			let existingBytes: Uint8Array;
			try {
				existingBytes = await readOpenedRegularLeaf(existing);
			} finally {
				await existing.close().catch(() => undefined);
			}
			if (!sameBytes(existingBytes, bytes))
				throw new Error(
					"Immutable descriptor publication found conflicting bytes at the atomic no-replace target.",
				);
			await temp.close();
			await descriptorFs.unlinkAt(parent, tempComponent);
			await descriptorFs.syncDirectoryChain(parent, root);
			return "already_exists";
		}
		if (exclusive) {
			const published = await descriptorFs.openAt(
				parent,
				leafComponent,
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
			);
			try {
				const publishedBytes = await readOpenedRegularLeaf(published);
				if (!sameBytes(publishedBytes, bytes))
					throw new Error("Exclusive descriptor publication changed during the guarded no-replace commit.");
			} finally {
				await published.close().catch(() => undefined);
			}
		}
		await descriptorFs.syncDirectoryChain(parent, root);
		return "created";
	} finally {
		await temp.close().catch(() => undefined);
		if (parent !== root) await parent.close().catch(() => undefined);
	}
}

/** Bind every publication method to the one already-open descriptor context. */
async function openWorkflowJournalDurableStorage(
	context: WorkflowDescriptorContext,
): Promise<WorkflowJournalDurableStorage> {
	const { descriptorFs, root, workflow, workflowId } = context;
	if (!/^generation-[0-9a-f]{32}$/.test(context.generationId))
		throw new Error("Descriptor storage requires the opened authenticated generation identity.");
	const journalComponents = ["generations", context.generationId, "events.log"] as const;
	const diagnosticPath = ["workflows", workflowId, ...journalComponents].join("/");
	const storage: WorkflowJournalDurableStorage = {
		diagnosticPath,
		async readJournalBytes() {
			await assertDescriptorContextIdentity(context);
			return (await readDescriptorBytesIfPresent(descriptorFs, workflow, journalComponents)) ?? new Uint8Array();
		},
		async appendJournalFrame(bytes, input, hook) {
			await assertDescriptorContextIdentity(context);
			if (hook?.checkpoint === input.beforeSync)
				await hook.before({ storeId: input.workflowId, mutationId: input.mutationId, checkpoint: hook.checkpoint });
			const opened = await openDescriptorLeaf(
				descriptorFs,
				root,
				["workflows", workflowId, ...journalComponents],
				fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
				true,
			);
			try {
				await opened.leaf.write(bytes);
				await opened.leaf.sync();
				const preparedFlushBoundary =
					hook?.checkpoint === DurableStoreCrashBoundary.afterPreparedFileFlushBeforeCommittedMarkerAppend;
				if (preparedFlushBoundary) {
					await descriptorFs.syncDirectoryChain(opened.parent, root);
					await persistDurableFlushProof(
						context,
						{ mutationId: input.mutationId, frameKind: input.frameKind, frameDigest: input.digest },
						opened.leaf,
						opened.parent,
					);
				}
				if (hook?.checkpoint === input.afterSync) {
					await hook.before({
						storeId: input.workflowId,
						mutationId: input.mutationId,
						checkpoint: hook.checkpoint,
					});
					await hook.after({
						storeId: input.workflowId,
						mutationId: input.mutationId,
						checkpoint: hook.checkpoint,
						digest: input.digest,
					});
				}
				if (!preparedFlushBoundary) {
					await descriptorFs.syncDirectoryChain(opened.parent, root);
					await persistDurableFlushProof(
						context,
						{ mutationId: input.mutationId, frameKind: input.frameKind, frameDigest: input.digest },
						opened.leaf,
						opened.parent,
					);
				}
			} finally {
				await opened.leaf.close().catch(() => undefined);
				if (opened.parent !== root) await opened.parent.close().catch(() => undefined);
			}
			await assertDescriptorContextIdentity(context);
		},
		async readImmutable(components) {
			await assertDescriptorContextIdentity(context);
			return readDescriptorBytesIfPresent(descriptorFs, workflow, components);
		},
		async publishImmutable(components, bytes, input, hook) {
			await assertDescriptorContextIdentity(context);
			if (hook?.checkpoint !== undefined && input.checkpoints.includes(hook.checkpoint))
				await hook.before({ storeId: input.workflowId, mutationId: input.mutationId, checkpoint: hook.checkpoint });
			const existing = await readDescriptorBytesIfPresent(descriptorFs, workflow, components);
			if (existing !== null) {
				if (!sameBytes(existing, bytes))
					throw new Error("Immutable descriptor publication conflicts with existing bytes.");
				return "already_exists";
			}
			const result = await writeDescriptorBytes(
				descriptorFs,
				root,
				["workflows", workflowId, ...components],
				bytes,
				true,
			);
			const published = await openDescriptorLeaf(
				descriptorFs,
				root,
				["workflows", workflowId, ...components],
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
				false,
			);
			try {
				await persistDurableFlushProof(
					context,
					{
						mutationId: `${input.mutationId}:${sha256Hex(bytes)}`,
						frameKind: "side_record",
						frameDigest: sha256Hex(bytes),
					},
					published.leaf,
					published.parent,
				);
			} finally {
				await published.leaf.close().catch(() => undefined);
				if (published.parent !== root) await published.parent.close().catch(() => undefined);
			}
			if (hook?.checkpoint !== undefined && input.checkpoints.includes(hook.checkpoint))
				await hook.after({
					storeId: input.workflowId,
					mutationId: input.mutationId,
					checkpoint: hook.checkpoint,
					digest: input.digest,
				});
			await assertDescriptorContextIdentity(context);
			return result;
		},
		async publishHead(components, expectedBytes, nextBytes) {
			await assertDescriptorContextIdentity(context);
			const current = await readDescriptorBytesIfPresent(descriptorFs, workflow, components);
			if (expectedBytes === null ? current !== null : current === null || !sameBytes(current, expectedBytes))
				throw new Error("Descriptor head CAS failed.");
			await writeDescriptorBytes(descriptorFs, root, ["workflows", workflowId, ...components], nextBytes, false);
			const published = await openDescriptorLeaf(
				descriptorFs,
				root,
				["workflows", workflowId, ...components],
				fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
				false,
			);
			try {
				await persistDurableFlushProof(
					context,
					{
						mutationId: `head-${sha256Hex(canonicalJsonBytes(components))}-${sha256Hex(nextBytes)}`,
						frameKind: "side_record",
						frameDigest: sha256Hex(nextBytes),
					},
					published.leaf,
					published.parent,
				);
			} finally {
				await published.leaf.close().catch(() => undefined);
				if (published.parent !== root) await published.parent.close().catch(() => undefined);
			}
			await assertDescriptorContextIdentity(context);
		},
		async readOutboxBytes() {
			await assertDescriptorContextIdentity(context);
			return (
				(await readDescriptorBytesIfPresent(descriptorFs, workflow, ["outbox", "events.log"])) ?? new Uint8Array()
			);
		},
		async appendOutboxFrame(bytes, input, hook) {
			await assertDescriptorContextIdentity(context);
			if (hook?.checkpoint === DurableStoreCrashBoundary.afterProjectionCasBeforeOutbox)
				await hook.before({ storeId: input.workflowId, mutationId: input.mutationId, checkpoint: hook.checkpoint });
			const outboxLeaf = await openDescriptorLeaf(
				descriptorFs,
				root,
				["workflows", workflowId, "outbox", "events.log"],
				fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW ?? 0),
				0o600,
				true,
			);
			try {
				await outboxLeaf.leaf.write(bytes);
				await outboxLeaf.leaf.sync();
				await descriptorFs.syncDirectoryChain(outboxLeaf.parent, root);
				await persistDurableFlushProof(
					context,
					{ mutationId: input.mutationId, frameKind: "outbox", frameDigest: sha256Hex(bytes) },
					outboxLeaf.leaf,
					outboxLeaf.parent,
				);
			} finally {
				await outboxLeaf.leaf.close().catch(() => undefined);
				if (outboxLeaf.parent !== root) await outboxLeaf.parent.close().catch(() => undefined);
			}
			if (hook?.checkpoint !== undefined) {
				await hook.before({ storeId: input.workflowId, mutationId: input.mutationId, checkpoint: hook.checkpoint });
				await hook.after({
					storeId: input.workflowId,
					mutationId: input.mutationId,
					checkpoint: hook.checkpoint,
					digest: input.digest,
				});
			}
			await assertDescriptorContextIdentity(context);
		},
	};
	markStorageContext(storage, context);
	return storage;
}

function assertCanonicalBytes(bytes: Uint8Array): void {
	const value = parseCanonicalJsonBytes(bytes);
	if (!sameBytes(bytes, canonicalJsonBytes(value))) throw new Error("Bytes are not canonical JSON.");
}

function assertArtifactRef(ref: WorkflowArtifactRef): void {
	if (
		ref.artifactId.length === 0 ||
		ref.relativePath.length === 0 ||
		ref.relativePath[0] === "/" ||
		ref.relativePath.includes("\\") ||
		ref.relativePath.includes("\0") ||
		/^[A-Za-z]:/.test(ref.relativePath) ||
		ref.relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
		ref.digest.length !== 64 ||
		!Number.isSafeInteger(ref.sizeBytes) ||
		ref.sizeBytes < 0 ||
		!Number.isSafeInteger(ref.sourceEventSequence) ||
		ref.sourceEventSequence < 0
	)
		throw new Error("Artifact reference is not a safe content-addressed identity.");
}

function decodeArtifactEnvelope(bytes: Uint8Array): WorkflowArtifactEnvelope {
	const value = parseCanonicalJsonBytes(bytes);
	if (!isWorkflowArtifactEnvelopeValue(value) || !sameBytes(canonicalJsonBytes(value), bytes))
		throw new Error("Artifact envelope is not a closed record.");
	return value;
}

function assertArtifactEnvelopeMatches(
	envelope: WorkflowArtifactEnvelope,
	ref: WorkflowArtifactRef,
	bytes: Uint8Array,
): void {
	if (
		!envelope.immutable ||
		digestObject(envelope.ref) !== digestObject(ref) ||
		sha256Hex(bytes) !== ref.digest ||
		bytes.byteLength !== ref.sizeBytes
	)
		throw new Error("Artifact envelope does not authenticate immutable bytes.");
}

function assertSnapshotPublishInput(workflowId: string, input: WorkflowSnapshotPublishInput): void {
	if (
		input.workflowId !== workflowId ||
		!Number.isSafeInteger(input.sequence) ||
		input.sequence < 1 ||
		!isDigestValue(input.sourceEventDigest) ||
		input.idempotencyKey.length === 0 ||
		input.stateDigest !== sha256Hex(input.stateBytes) ||
		input.authenticatedTuple.recordVersion !== 1 ||
		input.authenticatedTuple.generationId.length === 0 ||
		input.authenticatedTuple.workflowId !== input.workflowId ||
		input.authenticatedTuple.sequence !== input.sequence ||
		input.authenticatedTuple.eventDigest !== input.sourceEventDigest ||
		input.authenticatedTuple.expectedHead.workflowId !== input.expectedHead.workflowId ||
		input.authenticatedTuple.expectedHead.sequence !== input.expectedHead.sequence ||
		input.authenticatedTuple.expectedHead.eventDigest !== input.expectedHead.sourceEventDigest ||
		digestObject(input.authenticatedTuple.expectedHead.epochRef) !== digestObject(input.expectedHead.epochRef) ||
		input.authenticatedTuple.idempotencyKey !== input.idempotencyKey ||
		digestObject(input.authenticatedTuple.epochRef) !== digestObject(input.epochRef) ||
		digestObject(input.authenticatedTuple.leaseRef) !== digestObject(input.leaseRef) ||
		input.authenticatedTuple.writerIdentity !== input.writerIdentity ||
		input.authenticatedTuple.keyId.length === 0 ||
		input.authenticatedTuple.frameMac.length === 0 ||
		input.authenticatedTuple.frameChecksum.length === 0 ||
		input.authenticatedTuple.recordMac.length === 0 ||
		input.authenticatedTuple.recordChecksum.length === 0
	)
		throw new Error("Snapshot input is not bound to the authenticated commit tuple.");
}

function snapshotComponents(idempotencyKey: string): readonly string[] {
	assertSafeIdentifier(idempotencyKey, "snapshot idempotency key");
	return ["snapshots", `${idempotencyKey}.bin`];
}

function snapshotHeadComponents(): readonly string[] {
	return ["snapshots", "HEAD"];
}

async function readWorkflowSnapshotHead(
	storage: WorkflowJournalDurableStorage,
	workflowId: string,
	epochRef: WorkflowEpochRef,
): Promise<{ head: WorkflowSnapshotHead; bytes: Uint8Array | null }> {
	const bytes = await storage.readImmutable(snapshotHeadComponents());
	if (bytes !== null) {
		const value = parseCanonicalJsonBytes(bytes);
		if (
			!isWorkflowSnapshotHeadValue(value) ||
			!sameBytes(canonicalJsonBytes(value), bytes) ||
			value.workflowId !== workflowId ||
			digestObject(value.epochRef) !== digestObject(epochRef)
		)
			throw new Error("Persisted snapshot head is not a canonical closed workflow head.");
		return { head: value, bytes };
	}
	return {
		head: { workflowId, sequence: 0, sourceEventDigest: null, stateDigest: null, epochRef },
		bytes,
	};
}

function encodeSnapshotEnvelope(input: WorkflowSnapshotPublishInput, hostSecret: Uint8Array): Uint8Array {
	const unsigned = {
		workflowId: input.workflowId,
		sequence: input.sequence,
		sourceEventDigest: input.sourceEventDigest,
		stateDigest: input.stateDigest,
		epochRef: input.epochRef,
		expectedHead: input.expectedHead,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		authenticatedTuple: input.authenticatedTuple,
		stateBytesDigest: sha256Hex(input.stateBytes),
	};
	const unsignedBytes = canonicalJsonBytes(unsigned);
	return canonicalJsonBytes({
		...unsigned,
		frameMac: createHmac("sha256", hostSecret).update(unsignedBytes).digest("hex"),
		frameChecksum: createHash("sha256").update(unsignedBytes).digest("hex").slice(0, 8),
	});
}

interface WorkflowPersistedSnapshotEnvelope {
	workflowId: string;
	sequence: number;
	sourceEventDigest: string | null;
	stateDigest: string;
	epochRef: WorkflowEpochRef;
	expectedHead: WorkflowSnapshotHead;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	idempotencyKey: string;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple;
	stateBytesDigest: string;
	frameMac: string;
	frameChecksum: string;
}

function isWorkflowPersistedSnapshotEnvelopeValue(value: unknown): value is WorkflowPersistedSnapshotEnvelope {
	if (!isRecord(value)) return false;
	return exactRecord(
		value,
		[
			"workflowId",
			"sequence",
			"sourceEventDigest",
			"stateDigest",
			"epochRef",
			"expectedHead",
			"leaseRef",
			"writerIdentity",
			"idempotencyKey",
			"authenticatedTuple",
			"stateBytesDigest",
			"frameMac",
			"frameChecksum",
		],
		{
			workflowId: isStringValue,
			sequence: (field) => isSafeIntegerValue(field) && field > 0,
			sourceEventDigest: (field) =>
				isSafeIntegerValue(value.sequence) && (value.sequence === 0 ? field === null : isDigestValue(field)),
			stateDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			epochRef: isEpochRefValue,
			expectedHead: isWorkflowSnapshotHeadValue,
			leaseRef: isLeaseRefValue,
			writerIdentity: isStringValue,
			idempotencyKey: isStringValue,
			authenticatedTuple: isWorkflowAuthenticatedMutationTupleValue,
			stateBytesDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
			frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
		},
	);
}

function snapshotEnvelopeUnsigned(value: WorkflowPersistedSnapshotEnvelope): Record<string, unknown> {
	return {
		workflowId: value.workflowId,
		sequence: value.sequence,
		sourceEventDigest: value.sourceEventDigest,
		stateDigest: value.stateDigest,
		epochRef: value.epochRef,
		expectedHead: value.expectedHead,
		leaseRef: value.leaseRef,
		writerIdentity: value.writerIdentity,
		idempotencyKey: value.idempotencyKey,
		authenticatedTuple: value.authenticatedTuple,
		stateBytesDigest: value.stateBytesDigest,
	};
}

function decodeSnapshotEnvelope(bytes: Uint8Array, hostSecret: Uint8Array): WorkflowPersistedSnapshotEnvelope {
	const parsed = parseCanonicalJsonBytes(bytes);
	if (!isWorkflowPersistedSnapshotEnvelopeValue(parsed) || !sameBytes(canonicalJsonBytes(parsed), bytes))
		throw new Error("Snapshot frame authentication fields are missing.");
	const unsigned = snapshotEnvelopeUnsigned(parsed);
	const unsignedBytes = canonicalJsonBytes(unsigned);
	const expectedMac = createHmac("sha256", hostSecret).update(unsignedBytes).digest("hex");
	const expectedChecksum = createHash("sha256").update(unsignedBytes).digest("hex").slice(0, 8);
	if (!sameFixedHex(parsed.frameMac, expectedMac, 32) || !sameFixedHex(parsed.frameChecksum, expectedChecksum, 4))
		throw new Error("Snapshot frame authentication failed.");
	return parsed;
}

function assertOutboxAppendInput(workflowId: string, input: WorkflowOutboxAppendInput): void {
	const hasSourceSequence = input.sourceEventSequence !== undefined;
	const hasSourceDigest = input.sourceEventDigest !== undefined;
	if (hasSourceSequence !== hasSourceDigest) throw new Error("Outbox source event binding is incomplete.");
	if (!hasSourceSequence && isKnowledgeOutboxPayload(input.bytes))
		throw new Error("Knowledge outbox entries require an authenticated source event binding.");
	const sourceEventSequence = input.sourceEventSequence ?? input.sequence;
	const sourceEventDigest = input.sourceEventDigest ?? input.eventDigest;
	if (
		input.workflowId !== workflowId ||
		input.entryDigest !== sha256Hex(input.bytes) ||
		!Number.isSafeInteger(input.sequence) ||
		input.sequence < 1 ||
		!Number.isSafeInteger(sourceEventSequence) ||
		sourceEventSequence < 1 ||
		!isDigestValue(sourceEventDigest) ||
		input.eventDigest !== sourceEventDigest ||
		input.idempotencyKey.length === 0 ||
		input.authenticatedTuple.recordVersion !== 1 ||
		input.authenticatedTuple.generationId.length === 0 ||
		input.authenticatedTuple.workflowId !== input.workflowId ||
		input.authenticatedTuple.sequence !== sourceEventSequence ||
		input.authenticatedTuple.eventDigest !== sourceEventDigest ||
		input.authenticatedTuple.expectedHead.workflowId !== input.expectedHead.workflowId ||
		input.authenticatedTuple.expectedHead.sequence + 1 !== sourceEventSequence ||
		digestObject(input.authenticatedTuple.expectedHead.epochRef) !== digestObject(input.expectedHead.epochRef) ||
		input.authenticatedTuple.idempotencyKey !== input.idempotencyKey ||
		digestObject(input.authenticatedTuple.epochRef) !== digestObject(input.epochRef) ||
		digestObject(input.authenticatedTuple.leaseRef) !== digestObject(input.leaseRef) ||
		input.authenticatedTuple.writerIdentity !== input.writerIdentity ||
		input.authenticatedTuple.keyId.length === 0 ||
		input.authenticatedTuple.frameMac.length === 0 ||
		input.authenticatedTuple.frameChecksum.length === 0 ||
		input.authenticatedTuple.recordMac.length === 0 ||
		input.authenticatedTuple.recordChecksum.length === 0
	)
		throw new Error("Outbox input is not bound to the authenticated commit tuple.");
}

function isKnowledgeOutboxPayload(bytes: Uint8Array): boolean {
	try {
		const value = parseCanonicalJsonBytes(bytes);
		return (
			isRecord(value) &&
			Object.hasOwn(value, "operation") &&
			Object.hasOwn(value, "recordId") &&
			Object.hasOwn(value, "canonicalDigest") &&
			Object.hasOwn(value, "fence")
		);
	} catch {
		return false;
	}
}

function digestOutboxInput(input: WorkflowOutboxAppendInput): string {
	const sourceEventSequence = input.sourceEventSequence ?? input.sequence;
	const sourceEventDigest = input.sourceEventDigest ?? input.eventDigest;
	return digestObject({
		workflowId: input.workflowId,
		sequence: input.sequence,
		eventDigest: input.eventDigest,
		sourceEventSequence,
		sourceEventDigest,
		epochRef: input.epochRef,
		expectedHead: input.expectedHead,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		authenticatedTuple: input.authenticatedTuple,
		bytesDigest: sha256Hex(input.bytes),
		entryDigest: input.entryDigest,
	});
}

function encodeOutboxRecord(input: WorkflowOutboxAppendInput, hostSecret: Uint8Array): Uint8Array {
	const unsigned = { ...input, bytes: Array.from(input.bytes) };
	const unsignedBytes = canonicalJsonBytes(unsigned);
	const payload = canonicalJsonBytes({
		...unsigned,
		frameMac: createHmac("sha256", hostSecret).update(unsignedBytes).digest("hex"),
		frameChecksum: createHash("sha256").update(unsignedBytes).digest("hex").slice(0, 8),
	});
	return encodeWorkflowFixedFrame({
		magic: "PAOB",
		frameKind: "outbox",
		workflowId: input.workflowId,
		sequence: input.sequence,
		epochRef: input.epochRef,
		generationId: input.authenticatedTuple.generationId,
		keyId: input.authenticatedTuple.keyId,
		priorEventDigest: input.expectedHead.eventDigest,
		payloadDigest: sha256Hex(input.bytes),
		writerIdentity: input.writerIdentity,
		payload,
		secret: hostSecret,
	});
}

interface WorkflowPersistedOutboxRecord {
	workflowId: string;
	sequence: number;
	eventDigest: string;
	sourceEventSequence?: number;
	sourceEventDigest?: string;
	epochRef: WorkflowEpochRef;
	expectedHead: WorkflowOutboxHead;
	leaseRef: WorkflowLeaseRef;
	writerIdentity: string;
	idempotencyKey: string;
	bytes: readonly number[];
	entryDigest: string;
	authenticatedTuple: WorkflowAuthenticatedMutationTuple;
	frameMac: string;
	frameChecksum: string;
}

function isWorkflowPersistedOutboxRecordValue(value: unknown): value is WorkflowPersistedOutboxRecord {
	if (!isRecord(value)) return false;
	const hasSourceSequence = Object.hasOwn(value, "sourceEventSequence");
	const hasSourceDigest = Object.hasOwn(value, "sourceEventDigest");
	if (hasSourceSequence !== hasSourceDigest) return false;
	const keys = [
		"workflowId",
		"sequence",
		"eventDigest",
		...(hasSourceSequence ? ["sourceEventSequence", "sourceEventDigest"] : []),
		"epochRef",
		"expectedHead",
		"leaseRef",
		"writerIdentity",
		"idempotencyKey",
		"bytes",
		"entryDigest",
		"authenticatedTuple",
		"frameMac",
		"frameChecksum",
	] as const;
	return exactRecord(value, keys, {
		workflowId: isStringValue,
		sequence: (field) => isSafeIntegerValue(field) && field > 0,
		eventDigest: isDigestValue,
		sourceEventSequence: (field) => !hasSourceSequence || (isSafeIntegerValue(field) && field > 0),
		sourceEventDigest: (field) => !hasSourceDigest || isDigestValue(field),
		epochRef: isEpochRefValue,
		expectedHead: isWorkflowOutboxHeadValue,
		leaseRef: isLeaseRefValue,
		writerIdentity: isStringValue,
		idempotencyKey: isStringValue,
		bytes: isByteArrayValue,
		entryDigest: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		authenticatedTuple: isWorkflowAuthenticatedMutationTupleValue,
		frameMac: (field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field),
		frameChecksum: (field) => typeof field === "string" && /^[0-9a-f]{8}$/.test(field),
	});
}

async function decodeOutboxRecordChain(
	bytes: Uint8Array,
	workflowId: string,
	expectedEpoch: WorkflowEpochRef,
	sourcePath: string,
	keyProvider: WorkflowJournalKeyProvider,
	proofContext: WorkflowDescriptorContext,
): Promise<WorkflowOutboxRecoveryResult> {
	const metadata = (
		status: WorkflowOutboxTailStatus,
		sequence: number | null,
		reason: WorkflowOutboxRecoveryMetadata["reason"],
	): WorkflowOutboxRecoveryMetadata => ({
		status,
		sourcePath,
		sourceDigest: sha256Hex(bytes),
		sourceSizeBytes: bytes.byteLength,
		sequence,
		reason,
	});
	const emptyHead: WorkflowOutboxHead = {
		workflowId,
		sequence: 0,
		eventDigest: null,
		entryDigest: null,
		epochRef: expectedEpoch,
	};
	if (bytes.byteLength === 0)
		return { quarantined: false, entries: [], head: emptyHead, metadata: metadata("complete", 0, "none") };
	try {
		const entries: WorkflowOutboxAppendInput[] = [];
		let head = emptyHead;
		for (const frameInfo of decodeWorkflowFixedFrames(bytes)) {
			const record = parseCanonicalJsonBytes(frameInfo.payload);
			if (!isWorkflowPersistedOutboxRecordValue(record) || !sameBytes(canonicalJsonBytes(record), frameInfo.payload))
				throw new Error("outbox-record-shape");
			assertWorkflowFixedFrameHeaderMatches(frameInfo, record);
			await verifyDurableFlushProof(proofContext, {
				mutationId: record.idempotencyKey,
				frameKind: "outbox",
				frameDigest: sha256Hex(frameInfo.frameBytes),
			});
			const unsigned = {
				workflowId: record.workflowId,
				sequence: record.sequence,
				eventDigest: record.eventDigest,
				...(record.sourceEventSequence === undefined
					? {}
					: { sourceEventSequence: record.sourceEventSequence, sourceEventDigest: record.sourceEventDigest }),
				epochRef: record.epochRef,
				expectedHead: record.expectedHead,
				leaseRef: record.leaseRef,
				writerIdentity: record.writerIdentity,
				idempotencyKey: record.idempotencyKey,
				bytes: record.bytes,
				entryDigest: record.entryDigest,
				authenticatedTuple: record.authenticatedTuple,
			};
			const unsignedBytes = canonicalJsonBytes(unsigned);
			const tuple = record.authenticatedTuple;
			const key = await keyProvider.resolve(workflowId, tuple.keyId, tuple.epochRef);
			if (
				key.keyId !== tuple.keyId ||
				key.validStoreEpoch !== tuple.epochRef.storeEpoch ||
				key.generationId !== tuple.generationId
			)
				throw new Error("outbox-key-generation");
			const expectedFrameMac = createHmac("sha256", key.secret).update(unsignedBytes).digest("hex");
			const expectedFrameChecksum = createHash("sha256").update(unsignedBytes).digest("hex").slice(0, 8);
			if (
				!sameFixedHex(record.frameMac, expectedFrameMac, 32) ||
				!sameFixedHex(record.frameChecksum, expectedFrameChecksum, 4)
			)
				throw new Error("outbox-frame-authentication");
			const outerAuthenticated = frameInfo.frameBytes.slice(
				0,
				frameInfo.frameBytes.byteLength - WORKFLOW_FRAME_MAC_BYTES - WORKFLOW_FRAME_CHECKSUM_BYTES,
			);
			const outerMac = frameInfo.frameBytes.slice(
				outerAuthenticated.byteLength,
				outerAuthenticated.byteLength + WORKFLOW_FRAME_MAC_BYTES,
			);
			const outerChecksum = frameInfo.frameBytes.slice(-WORKFLOW_FRAME_CHECKSUM_BYTES);
			const expectedOuterMac = createHmac("sha256", key.secret).update(outerAuthenticated).digest();
			const expectedOuterChecksum = createHash("sha256")
				.update(Buffer.concat([Buffer.from(outerAuthenticated), expectedOuterMac]))
				.digest()
				.subarray(0, WORKFLOW_FRAME_CHECKSUM_BYTES);
			if (
				!sameFixedBytes(outerMac, expectedOuterMac, WORKFLOW_FRAME_MAC_BYTES) ||
				!sameFixedBytes(outerChecksum, expectedOuterChecksum, WORKFLOW_FRAME_CHECKSUM_BYTES)
			)
				throw new Error("outbox-fixed-frame-authentication");
			const entry: WorkflowOutboxAppendInput = {
				workflowId: record.workflowId,
				sequence: record.sequence,
				eventDigest: record.eventDigest,
				...(record.sourceEventSequence === undefined
					? {}
					: { sourceEventSequence: record.sourceEventSequence, sourceEventDigest: record.sourceEventDigest }),
				epochRef: record.epochRef,
				expectedHead: record.expectedHead,
				leaseRef: record.leaseRef,
				writerIdentity: record.writerIdentity,
				idempotencyKey: record.idempotencyKey,
				bytes: Uint8Array.from(record.bytes),
				entryDigest: record.entryDigest,
				authenticatedTuple: record.authenticatedTuple,
			};
			assertOutboxAppendInput(workflowId, entry);
			if (
				entry.workflowId !== workflowId ||
				entry.sequence !== head.sequence + 1 ||
				digestObject(entry.expectedHead) !== digestObject(head) ||
				digestObject(entry.epochRef) !== digestObject(expectedEpoch) ||
				entry.entryDigest !== sha256Hex(entry.bytes)
			)
				throw new Error("outbox-record-chain");
			entries.push(entry);
			head = {
				workflowId,
				sequence: entry.sequence,
				eventDigest: entry.eventDigest,
				entryDigest: entry.entryDigest,
				epochRef: entry.epochRef,
			};
		}
		return { quarantined: false, entries, head, metadata: metadata("complete", head.sequence, "none") };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const truncated = /Unexpected end|unterminated|EOF|tail-truncated/i.test(message);
		return {
			quarantined: true,
			entries: [],
			head: null,
			metadata: metadata(
				truncated ? "partial_frame" : "invalid_record",
				null,
				truncated ? "tail_truncated" : "invalid_record",
			),
		};
	}
}

class WorkflowOutboxRecoveryError extends Error {
	constructor(readonly metadata: WorkflowOutboxRecoveryMetadata) {
		super(`Workflow outbox is quarantined: ${metadata.reason}`);
	}
}

function assertJournalAppendInput(journal: WorkflowJournalImpl, input: WorkflowJournalAppendInput): void {
	journal.options.ownerValidators.validateCommit(input);
	if (
		input.workflowId !== journal.options.workflowId ||
		input.expectedHead.workflowId !== journal.options.workflowId ||
		input.epochRef.storeEpoch !== journal.options.epoch.storeEpoch ||
		input.epochRef.coordinatorEpoch !== journal.options.epoch.coordinatorEpoch ||
		digestObject(input.leaseRef) !== digestObject(journal.options.leaseRef) ||
		input.leaseRef.writerIdentity !== input.writerIdentity ||
		input.leaseRef.rootDigest !== journal.descriptorContext.rootDigest ||
		input.writerIdentity !== journal.options.writerIdentity ||
		input.idempotencyKey.length === 0 ||
		input.returnProofId !== `return-proof:${input.idempotencyKey}`
	)
		throw new Error(
			"Journal append input is not bound to the authenticated workflow lease, epoch, or semantic preflight.",
		);
	const preview = previewWorkflowSemanticTransition({
		payload: input.payload,
		binding: input.semanticBinding,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		executionKey: input.executionKey,
		idempotencyKey: input.idempotencyKey,
		workflowId: input.workflowId,
	});
	journal.options.ownerValidators.validateSemanticPreflight({ payload: input.payload, preview });
}

function assertIdempotentJournalReplay(
	existing: WorkflowJournalEvent,
	input: WorkflowJournalAppendInput,
): WorkflowJournalEvent {
	const proof = existing.commitReturnProof;
	if (
		existing.payloadDigest !== digestObject(input.payload) ||
		digestObject(existing.expectedHead) !== digestObject(input.expectedHead) ||
		existing.workflowId !== input.workflowId ||
		existing.idempotencyKey !== input.idempotencyKey ||
		existing.returnProofId !== input.returnProofId ||
		existing.executionKey !== input.executionKey ||
		existing.writerIdentity !== input.writerIdentity ||
		digestObject(existing.leaseRef) !== digestObject(input.leaseRef) ||
		digestObject(existing.epochRef) !== digestObject(input.epochRef) ||
		digestObject(existing.semanticBinding) !== digestObject(input.semanticBinding) ||
		proof.recordVersion !== existing.recordVersion ||
		proof.generationId !== existing.generationId ||
		proof.workflowId !== existing.workflowId ||
		proof.mutationId !== existing.returnProofId ||
		proof.sequence !== existing.sequence ||
		proof.eventDigest !== existing.eventDigest ||
		proof.committedFrameDigest !== existing.committedFrameDigest ||
		digestObject(proof.expectedHead) !== digestObject(existing.expectedHead) ||
		digestObject(proof.epochRef) !== digestObject(existing.epochRef) ||
		digestObject(proof.leaseRef) !== digestObject(existing.leaseRef) ||
		proof.writerIdentity !== existing.writerIdentity ||
		proof.idempotencyKey !== existing.idempotencyKey ||
		proof.keyId !== existing.keyId ||
		!sameFixedHex(proof.frameMac, existing.committedFrameMac, 32) ||
		!sameFixedHex(proof.frameChecksum, existing.committedFrameChecksum, 4) ||
		!sameFixedHex(proof.recordMac, existing.recordMac, 32) ||
		!sameFixedHex(proof.recordChecksum, existing.recordChecksum, 4) ||
		proof.priorRecordDigest !== existing.priorEventDigest ||
		!sameFixedHex(proof.proofDigest, workflowCommitReturnProofDigest(proof), 32)
	)
		throw new Error(
			"Historical journal idempotency tuple conflicts with the complete authenticated event and return proof.",
		);
	return existing;
}

function canonicalWorkflowEventDigest(input: {
	workflowId: string;
	sequence: number;
	payloadBytes: Uint8Array;
	priorEventDigest: string | null;
	idempotencyKey: string;
	semanticBinding: WorkflowSemanticMutationBinding;
}): string {
	return sha256Hex(
		canonicalJsonBytes({
			workflowId: input.workflowId,
			sequence: input.sequence,
			payloadBytes: Array.from(input.payloadBytes),
			priorEventDigest: input.priorEventDigest,
			idempotencyKey: input.idempotencyKey,
			semanticBinding: input.semanticBinding,
		}),
	);
}

async function appendPreparedAndCommittedFrames(
	journal: WorkflowJournalImpl,
	input: WorkflowJournalAppendInput,
	sequence: number,
	priorEventDigest: string | null,
): Promise<WorkflowJournalEvent> {
	const key = await journal.options.keyProvider.current(input.workflowId, input.epochRef);
	const payloadBytes = canonicalJsonBytes(input.payload);
	const eventDigest = canonicalWorkflowEventDigest({
		workflowId: input.workflowId,
		sequence,
		payloadBytes,
		priorEventDigest,
		idempotencyKey: input.idempotencyKey,
		semanticBinding: input.semanticBinding,
	});
	const frameMac = (bytes: Uint8Array): string => createHmac("sha256", key.secret).update(bytes).digest("hex");
	const frameChecksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex").slice(0, 8);
	const preparedUnsigned = {
		frameKind: "prepared",
		version: WORKFLOW_FRAME_VERSION,
		workflowId: input.workflowId,
		sequence,
		eventDigest,
		payloadBytes: Array.from(payloadBytes),
		keyId: key.keyId,
		generationId: key.generationId,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		returnProofId: input.returnProofId,
		expectedHead: input.expectedHead,
		semanticBinding: input.semanticBinding,
	};
	const preparedUnsignedBytes = canonicalJsonBytes(preparedUnsigned);
	const preparedRecord = {
		...preparedUnsigned,
		frameMac: frameMac(preparedUnsignedBytes),
		frameChecksum: frameChecksum(preparedUnsignedBytes),
	};
	const preparedBytes = canonicalJsonBytes(preparedRecord);
	const committedUnsigned = {
		frameKind: "committed",
		version: WORKFLOW_FRAME_VERSION,
		workflowId: input.workflowId,
		sequence,
		eventDigest,
		payloadBytes: Array.from(payloadBytes),
		keyId: key.keyId,
		generationId: key.generationId,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		returnProofId: input.returnProofId,
		expectedHead: input.expectedHead,
		executionKey: input.executionKey,
		semanticBinding: input.semanticBinding,
		preparedFrameDigest: sha256Hex(preparedBytes),
	};
	const committedUnsignedBytes = canonicalJsonBytes(committedUnsigned);
	const committedRecord = {
		...committedUnsigned,
		frameMac: frameMac(committedUnsignedBytes),
		frameChecksum: frameChecksum(committedUnsignedBytes),
		recordMac: frameMac(committedUnsignedBytes),
		recordChecksum: frameChecksum(committedUnsignedBytes),
	};
	const committedBytes = canonicalJsonBytes(committedRecord);
	const preparedFrameBytes = encodeWorkflowFixedFrame({
		magic: "PWFK",
		frameKind: "prepared",
		workflowId: input.workflowId,
		sequence,
		epochRef: input.epochRef,
		generationId: key.generationId,
		keyId: key.keyId,
		priorEventDigest: input.expectedHead.eventDigest,
		payloadDigest: sha256Hex(payloadBytes),
		writerIdentity: input.writerIdentity,
		payload: preparedBytes,
		secret: key.secret,
	});
	const committedFrameBytes = encodeWorkflowFixedFrame({
		magic: "PWFK",
		frameKind: "committed",
		workflowId: input.workflowId,
		sequence,
		epochRef: input.epochRef,
		generationId: key.generationId,
		keyId: key.keyId,
		priorEventDigest: input.expectedHead.eventDigest,
		payloadDigest: sha256Hex(payloadBytes),
		writerIdentity: input.writerIdentity,
		payload: committedBytes,
		secret: key.secret,
	});
	await journal.storage.appendJournalFrame(
		preparedFrameBytes,
		{
			workflowId: input.workflowId,
			mutationId: input.returnProofId,
			digest: sha256Hex(preparedFrameBytes),
			frameKind: "prepared",
			beforeSync: DurableStoreCrashBoundary.afterPreparedAppendBeforePreparedFileFlush,
			afterSync: DurableStoreCrashBoundary.afterPreparedFileFlushBeforeCommittedMarkerAppend,
		},
		input.crashHook,
	);
	await journal.storage.appendJournalFrame(
		committedFrameBytes,
		{
			workflowId: input.workflowId,
			mutationId: input.returnProofId,
			digest: sha256Hex(committedFrameBytes),
			frameKind: "committed",
			beforeSync: DurableStoreCrashBoundary.afterCommittedMarkerAppendBeforeCommittedFileFlush,
			afterSync: DurableStoreCrashBoundary.afterCommittedFileFlushBeforeDirectoryFlush,
		},
		input.crashHook,
	);
	const committedFrameDigest = sha256Hex(committedFrameBytes);
	const proofWithoutDigest = {
		recordVersion: 1 as const,
		generationId: key.generationId,
		mutationId: input.returnProofId,
		workflowId: input.workflowId,
		sequence,
		eventDigest,
		committedFrameDigest,
		expectedHead: input.expectedHead,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		idempotencyKey: input.idempotencyKey,
		keyId: key.keyId,
		frameMac: frameMac(committedBytes),
		frameChecksum: frameChecksum(committedBytes),
		recordMac: frameMac(committedBytes),
		recordChecksum: frameChecksum(committedBytes),
		priorRecordDigest: priorEventDigest,
		returnedAt: journal.options.now(),
	};
	const commitReturnProof: WorkflowCommitReturnProof = {
		...proofWithoutDigest,
		proofDigest: digestObject(proofWithoutDigest),
	};
	return {
		workflowId: input.workflowId,
		sequence,
		kind: input.payload.kind,
		eventType: input.payload.kind,
		payload: input.payload,
		payloadBytes,
		payloadDigest: digestObject(input.payload),
		priorEventDigest,
		eventDigest,
		recordVersion: 1,
		generationId: key.generationId,
		recordMac: frameMac(committedBytes),
		recordChecksum: frameChecksum(committedBytes),
		idempotencyKey: input.idempotencyKey,
		returnProofId: input.returnProofId,
		expectedHead: input.expectedHead,
		executionKey: input.executionKey,
		epochRef: input.epochRef,
		leaseRef: input.leaseRef,
		writerIdentity: input.writerIdentity,
		preparedFrameDigest: sha256Hex(preparedBytes),
		committedFrameDigest,
		keyId: key.keyId,
		preparedFrameMac: frameMac(preparedBytes),
		committedFrameMac: frameMac(committedBytes),
		preparedFrameChecksum: frameChecksum(preparedBytes),
		committedFrameChecksum: frameChecksum(committedBytes),
		semanticBinding: input.semanticBinding,
		commitReturnProof,
	};
}

class WorkflowJournalRecoveryError extends Error {
	constructor(readonly metadata: WorkflowJournalRecoveryMetadata) {
		super(`Workflow journal is quarantined: ${metadata.reason}`);
	}
}

async function readRotationForGeneration(
	store: WorkflowGenerationRotationStore,
	generationId: string,
): Promise<WorkflowGenerationRotationRecoveryRecord | null> {
	return store.readRotationForGeneration(generationId);
}

function cloneWorkflowJournalKey(key: WorkflowJournalKey): WorkflowJournalKey {
	return Object.freeze({ ...key, secret: new Uint8Array(key.secret) });
}

function cloneWorkflowJournalHead(head: WorkflowJournalHead): WorkflowJournalHead {
	return Object.freeze({ ...head, epochRef: Object.freeze({ ...head.epochRef }) });
}

function freezeRecoveryEvidenceValue(value: unknown): unknown {
	if (value === null || typeof value !== "object" || value instanceof Uint8Array || Object.isFrozen(value))
		return value;
	if (Array.isArray(value)) {
		for (const item of value) freezeRecoveryEvidenceValue(item);
	} else {
		for (const item of Object.values(value)) freezeRecoveryEvidenceValue(item);
	}
	return Object.freeze(value);
}

function assertRecoveryCheckpoint(record: WorkflowGenerationRotationRecoveryRecord): void {
	const checkpointByState: Readonly<
		Partial<Record<WorkflowGenerationRotationRecoveryRecord["state"], DurableStoreCrashBoundary>>
	> = {
		prepared: DurableStoreCrashBoundary.afterRotationPrepareBeforeFence,
		lease_transferred: DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord,
		fence_committed: DurableStoreCrashBoundary.afterRotationRecordBeforeManifest,
		committed: DurableStoreCrashBoundary.afterRotationCommitBeforeRetire,
		retired: DurableStoreCrashBoundary.afterRotationRetireBeforeRebind,
	};
	const expectedCheckpoint = checkpointByState[record.state];
	if (
		expectedCheckpoint === undefined ||
		record.lastCheckpoint !== expectedCheckpoint ||
		record.checkpointDigest === null
	)
		throw new Error("Unfinished rotation checkpoint is missing or does not match its authenticated state.");
	if (!isDigestValue(record.checkpointDigest))
		throw new Error("Unfinished rotation checkpoint digest is not authenticated.");
	const request = record.request;
	const expectedDigest =
		record.state === "prepared"
			? digestObject({
					rotationId: request.rotationId,
					checkpoint: expectedCheckpoint,
					request,
				})
			: record.state === "lease_transferred"
				? digestObject({
						rotationId: request.rotationId,
						input: {
							expectedPriorRecordDigest: record.priorRecordDigest,
							nextLeaseRef: request.nextLeaseRef,
							writerIdentity: request.generationBinding.writerIdentity,
							epochRef: request.nextEpoch,
						},
						checkpoint: expectedCheckpoint,
					})
				: record.state === "fence_committed"
					? digestObject({
							rotationId: request.rotationId,
							input: {
								recordVersion: request.recordVersion,
								generationId: request.generationId,
								expectedPriorRecordDigest: record.priorRecordDigest,
								fenceEventSequence: record.fenceEventSequence,
								fenceEventDigest: record.fenceEventDigest,
								commitReturnProof: record.commitReturnProof,
								keyId: request.keyId,
								frameMac: request.frameMac,
								frameChecksum: request.frameChecksum,
								recordMac: request.recordMac,
								recordChecksum: request.recordChecksum,
							},
							checkpoint: expectedCheckpoint,
						})
					: null;
	if (expectedDigest === null || expectedDigest !== record.checkpointDigest)
		throw new Error("Unfinished rotation checkpoint digest does not match its authenticated transition tuple.");
}

function assertRecoveryFenceProof(
	rotation: WorkflowGenerationRotationRecoveryRecord,
	proof: WorkflowCommitReturnProof,
	currentHead: WorkflowJournalHead,
): WorkflowJournalHead {
	const request = rotation.request;
	const expectedHead = rotation.expectedHead;
	const expectedSequence = expectedHead.sequence + 1;
	if (
		proof.workflowId !== expectedHead.workflowId ||
		proof.generationId !== request.previousGenerationId ||
		proof.sequence !== expectedSequence ||
		proof.expectedHead.workflowId !== expectedHead.workflowId ||
		digestObject(proof.expectedHead) !== digestObject(expectedHead) ||
		digestObject(proof.epochRef) !== digestObject(request.previousEpoch) ||
		digestObject(proof.leaseRef) !== digestObject(request.previousLeaseRef) ||
		proof.writerIdentity !== request.previousWriterIdentity ||
		proof.keyId !== request.previousKeyId ||
		proof.priorRecordDigest !== expectedHead.eventDigest ||
		currentHead.sequence !== proof.sequence ||
		currentHead.eventDigest !== proof.eventDigest ||
		digestObject(currentHead.epochRef) !== digestObject(request.nextEpoch)
	)
		throw new Error("Unfinished rotation fence proof is not bound to both authenticated generation tuples.");
	return {
		workflowId: expectedHead.workflowId,
		sequence: proof.sequence,
		eventDigest: proof.eventDigest,
		epochRef: { ...request.nextEpoch },
	};
}

/**
 * Inspect one authenticated unfinished generation rotation without changing durable state.
 * Args:
 * journal: Open journal whose active generation and descriptor context are already authenticated.
 * Return: Immutable predecessor/successor key and lease evidence, or null when no rotation is unfinished.
 */
export function inspectWorkflowJournalRecovery(
	journal: WorkflowJournalImpl,
): Promise<WorkflowJournalRecoveryInspection | null>;
export function inspectWorkflowJournalRecovery(
	options: WorkflowJournalOptions,
): Promise<WorkflowJournalRecoveryInspection | null>;
export async function inspectWorkflowJournalRecovery(
	input: WorkflowJournalImpl | WorkflowJournalOptions,
): Promise<WorkflowJournalRecoveryInspection | null> {
	if (!(input instanceof WorkflowJournalImpl)) {
		const descriptorContext = await openWorkflowDescriptorContext(
			input.descriptorFs,
			input.descriptorRoots,
			input.workflowId,
			input.keyProvider,
			input.epoch,
		);
		try {
			const storage = await openWorkflowJournalDurableStorage(descriptorContext);
			await assertPrivateRegularJournal(storage);
			const journal = new WorkflowJournalImpl(
				input,
				storage,
				descriptorContext,
				createDescriptorCommitReturnProofStore(descriptorContext),
				createDescriptorGenerationRotationStore(descriptorContext),
			);
			return await inspectWorkflowJournalRecovery(journal);
		} finally {
			await descriptorContext.workflow.close().catch(() => undefined);
			await descriptorContext.root.close().catch(() => undefined);
		}
	}
	const journal = input;
	const active = await journal.rotationStore.readActiveGeneration(journal.options.workflowId);
	if (active === null) throw new Error("Authenticated active generation is required for recovery inspection.");
	const unfinished = await journal.rotationStore.listUnfinished(journal.options.workflowId);
	if (unfinished.length === 0) return null;
	if (unfinished.length !== 1) throw new Error("Recovery inspection requires exactly one unfinished rotation.");
	const rotation = unfinished[0];
	if (rotation.state !== "prepared" && rotation.state !== "lease_transferred" && rotation.state !== "fence_committed")
		throw new Error("Recovery inspection found a rotation that is not unfinished.");
	assertRecoveryCheckpoint(rotation);
	const request = rotation.request;
	const previousKey = await journal.options.keyProvider.resolve(
		journal.options.workflowId,
		request.previousKeyId,
		request.previousEpoch,
	);
	const successorKey = await journal.options.keyProvider.resolve(
		journal.options.workflowId,
		request.keyId,
		request.nextEpoch,
	);
	const rootDigest = journal.descriptorContext.rootDigest;
	const validEpochAdvance =
		(request.nextEpoch.storeEpoch === request.previousEpoch.storeEpoch + 1 &&
			request.nextEpoch.coordinatorEpoch === request.previousEpoch.coordinatorEpoch) ||
		(request.nextEpoch.storeEpoch === request.previousEpoch.storeEpoch &&
			request.nextEpoch.coordinatorEpoch === request.previousEpoch.coordinatorEpoch + 1);
	const expectedGenerationId = deriveWorkflowGenerationId({
		workflowId: journal.options.workflowId,
		nextEpoch: request.nextEpoch,
		rotationId: request.rotationId,
		priorHeadDigest: digestObject(rotation.expectedHead),
	});
	if (
		active.workflowId !== journal.options.workflowId ||
		active.generationId !== request.previousGenerationId ||
		active.epochRef.storeEpoch !== request.previousEpoch.storeEpoch ||
		active.epochRef.coordinatorEpoch !== request.previousEpoch.coordinatorEpoch ||
		active.keyId !== request.previousKeyId ||
		active.leaseRef.writerIdentity !== request.previousWriterIdentity ||
		!sameWorkflowLeaseIdentity(active.leaseRef, request.previousLeaseRef) ||
		active.leaseRef.rootDigest !== rootDigest ||
		rotation.expectedHead.workflowId !== journal.options.workflowId ||
		digestObject(rotation.expectedHead.epochRef) !== digestObject(request.previousEpoch) ||
		request.previousGenerationId === request.generationId ||
		!validEpochAdvance ||
		request.generationId !== expectedGenerationId ||
		request.activeGenerationManifestRef.relativePath !==
			`${deriveWorkflowGenerationPath(request.generationId)}/ACTIVE` ||
		request.generationBinding.writerIdentity !== request.nextLeaseRef.writerIdentity ||
		request.generationBinding.ownerIdentity !== request.generationBinding.writerIdentity ||
		request.generationBinding.writerIdentity.length === 0 ||
		request.generationBinding.processGenerationId.length === 0 ||
		request.nextLeaseRef.rootDigest !== rootDigest ||
		digestObject({
			storeEpoch: request.nextLeaseRef.storeEpoch,
			coordinatorEpoch: request.nextLeaseRef.coordinatorEpoch,
		}) !== digestObject(request.nextEpoch) ||
		previousKey.keyId !== request.previousKeyId ||
		previousKey.validStoreEpoch !== request.previousEpoch.storeEpoch ||
		previousKey.generationId !== request.previousGenerationId ||
		successorKey.keyId !== request.keyId ||
		successorKey.validStoreEpoch !== request.nextEpoch.storeEpoch ||
		successorKey.generationId !== request.generationId ||
		request.priorRecordDigest !== sha256Hex(canonicalJsonBytes(active))
	)
		throw new Error("Unfinished rotation is not bound to the authenticated active, predecessor, or successor tuple.");
	const authenticatedTuple = {
		workflowId: journal.options.workflowId,
		rotationId: request.rotationId,
		mutationId: request.mutationId,
		idempotencyKey: request.idempotencyKey,
		expectedHeadDigest: request.expectedHeadDigest,
		previousEpoch: request.previousEpoch,
		nextEpoch: request.nextEpoch,
		previousGenerationId: request.previousGenerationId,
		generationId: request.generationId,
		previousWriterIdentity: request.previousWriterIdentity,
		previousLeaseRef: request.previousLeaseRef,
		nextLeaseRef: request.nextLeaseRef,
		generationBinding: request.generationBinding,
	};
	if (request.expectedHeadDigest !== digestObject(rotation.expectedHead))
		throw new Error("Unfinished rotation expected-head digest is not bound to its authenticated head tuple.");
	const previousFrameBytes = canonicalJsonBytes({ role: "predecessor", authenticatedTuple });
	const successorFrameBytes = canonicalJsonBytes({ role: "successor", authenticatedTuple });
	const recordBytes = canonicalJsonBytes({
		authenticatedTuple,
		previousFrameMac: request.previousFrameMac,
		previousFrameChecksum: request.previousFrameChecksum,
		frameMac: request.frameMac,
		frameChecksum: request.frameChecksum,
		keyId: request.keyId,
	});
	if (
		active.generationBinding.writerIdentity !== request.previousWriterIdentity ||
		!sameFixedHex(
			active.sideRecordMac,
			sideRecordMac(workflowActiveGenerationRecordUnsigned(active), previousKey.secret),
			32,
		) ||
		!sameFixedHex(
			rotation.sideRecordMac,
			sideRecordMac(
				{ ...rotation, sideRecordMac: "" },
				rotation.state === "prepared" ? previousKey.secret : successorKey.secret,
			),
			32,
		) ||
		request.previousFrameMac !== createHmac("sha256", previousKey.secret).update(previousFrameBytes).digest("hex") ||
		request.previousFrameChecksum !== sha256Hex(previousFrameBytes).slice(0, 8) ||
		request.frameMac !== createHmac("sha256", successorKey.secret).update(successorFrameBytes).digest("hex") ||
		request.frameChecksum !== sha256Hex(successorFrameBytes).slice(0, 8) ||
		request.recordMac !== createHmac("sha256", successorKey.secret).update(recordBytes).digest("hex") ||
		request.recordChecksum !== sha256Hex(recordBytes).slice(0, 8)
	)
		throw new Error("Unfinished rotation is not authenticated by the exact predecessor and successor keys.");
	const replay = await decodeAuthenticatedJournal(journal);
	if (replay.quarantined) throw new WorkflowJournalRecoveryError(replay.metadata);
	const proofResult = await journal.returnProofStore.resolve(`return-proof:${request.idempotencyKey}`);
	const proof = rotation.commitReturnProof ?? proofResult.proof;
	let fenceHead: WorkflowJournalHead | null = null;
	if (proof !== null) fenceHead = assertRecoveryFenceProof(rotation, proof, replay.head);
	else if (rotation.state !== "prepared" || digestObject(replay.head) !== digestObject(rotation.expectedHead))
		throw new Error("Unfinished rotation is missing its authenticated fence checkpoint or return proof.");
	if (rotation.fenceEventSequence !== null || rotation.fenceEventDigest !== null) {
		if (
			proof === null ||
			rotation.fenceEventSequence !== proof.sequence ||
			rotation.fenceEventDigest !== proof.eventDigest
		)
			throw new Error("Unfinished rotation fence checkpoint disagrees with its authenticated return proof.");
	}
	const previous: WorkflowGenerationRecoveryTuple = {
		workflowId: journal.options.workflowId,
		generationId: request.previousGenerationId,
		keyId: request.previousKeyId,
		epochRef: Object.freeze({ ...request.previousEpoch }),
		writerIdentity: request.previousWriterIdentity,
		rootDigest,
		leaseRef: Object.freeze({ ...request.previousLeaseRef }),
		head: cloneWorkflowJournalHead(rotation.expectedHead),
	};
	const successor: WorkflowGenerationRecoveryTuple = {
		workflowId: journal.options.workflowId,
		generationId: request.generationId,
		keyId: request.keyId,
		epochRef: Object.freeze({ ...request.nextEpoch }),
		writerIdentity: request.generationBinding.writerIdentity,
		rootDigest: request.nextLeaseRef.rootDigest,
		leaseRef: Object.freeze({ ...request.nextLeaseRef }),
		head: fenceHead === null ? null : cloneWorkflowJournalHead(fenceHead),
	};
	const evidence = {
		workflowId: journal.options.workflowId,
		activeGeneration: freezeRecoveryEvidenceValue({ ...active }) as WorkflowActiveGenerationRecord,
		rotation: freezeRecoveryEvidenceValue({ ...rotation }) as WorkflowGenerationRotationRecoveryRecord,
		previous,
		successor,
		previousKey: cloneWorkflowJournalKey(previousKey),
		successorKey: cloneWorkflowJournalKey(successorKey),
		currentHead: cloneWorkflowJournalHead(replay.head),
		fenceHead: fenceHead === null ? null : cloneWorkflowJournalHead(fenceHead),
	};
	return Object.freeze(evidence);
}

async function readGenerationSeedHead(journal: WorkflowJournalImpl): Promise<WorkflowJournalHead> {
	const bytes = await readDescriptorBytesIfPresent(
		journal.descriptorContext.descriptorFs,
		journal.descriptorContext.workflow,
		["generations", journal.descriptorContext.generationId, "ACTIVE"],
	);
	if (bytes === null) throw new Error("Authenticated generation manifest is missing before journal replay.");
	const value = parseCanonicalJsonBytes(bytes);
	if (
		!isWorkflowActiveGenerationRecordValue(value) ||
		!sameBytes(canonicalJsonBytes(value), bytes) ||
		value.workflowId !== journal.options.workflowId ||
		value.generationId !== journal.descriptorContext.generationId
	)
		throw new Error("Authenticated generation manifest is not bound to the opened workflow journal.");
	const incomingRotation = await readRotationForGeneration(
		journal.rotationStore,
		journal.descriptorContext.generationId,
	);
	let authenticatedSeedHead: WorkflowJournalHead;
	if (incomingRotation === null) {
		if (
			value.priorRecordDigest !== null ||
			value.sourceHead.sequence !== 0 ||
			value.sourceHead.eventDigest !== null ||
			digestObject(value.sourceHead.epochRef) !== digestObject(value.epochRef)
		)
			throw new Error("Authenticated generation manifest is missing its incoming predecessor rotation record.");
		authenticatedSeedHead = value.sourceHead;
	} else {
		if (
			(incomingRotation.state !== "committed" && incomingRotation.state !== "retired") ||
			incomingRotation.rotation === null ||
			digestObject(value.sourceHead) !== digestObject(incomingRotation.expectedHead)
		)
			throw new Error("Authenticated generation manifest is missing its committed predecessor fence chain.");
		authenticatedSeedHead = derivePostFenceHead(incomingRotation.rotation);
	}
	return { ...authenticatedSeedHead, epochRef: { ...authenticatedSeedHead.epochRef } };
}

function derivePostFenceHead(rotation: WorkflowGenerationRotation): WorkflowJournalHead {
	if (
		rotation.fenceEventSequence !== rotation.expectedHead.sequence + 1 ||
		!isDigestValue(rotation.fenceEventDigest) ||
		digestObject(rotation.expectedHead.epochRef) !== digestObject(rotation.previousEpoch)
	)
		throw new Error("Authenticated generation rotation does not carry a contiguous predecessor fence head.");
	return {
		workflowId: rotation.expectedHead.workflowId,
		sequence: rotation.fenceEventSequence,
		eventDigest: rotation.fenceEventDigest,
		epochRef: { ...rotation.nextEpoch },
	};
}

async function decodeAuthenticatedJournal(
	journal: WorkflowJournalImpl,
): Promise<WorkflowJournalRecoveryResult & { head: WorkflowJournalHead }> {
	const bytes = await journal.storage.readJournalBytes();
	const metadata = (
		status: WorkflowJournalTailStatus,
		reason: WorkflowJournalRecoveryMetadata["reason"],
		sequence: number | null,
	): WorkflowJournalRecoveryMetadata => ({
		status,
		sourcePath: journal.storage.diagnosticPath,
		sourceDigest: sha256Hex(bytes),
		sourceSizeBytes: bytes.byteLength,
		sequence,
		epochRef: journal.options.epoch,
		reason,
	});
	const emptyHead: WorkflowJournalHead = {
		workflowId: journal.options.workflowId,
		sequence: 0,
		eventDigest: null,
		epochRef: journal.options.epoch,
	};
	const seedHead = await readGenerationSeedHead(journal);
	if (bytes.byteLength === 0)
		return {
			quarantined: false,
			events: [],
			metadata: metadata("complete", "none", seedHead.sequence),
			head: seedHead,
		};
	try {
		const prepared = new Map<
			number,
			{
				eventDigest: string;
				payloadBytes: Uint8Array;
				frameDigest: string;
				frameMac: string;
				frameChecksum: string;
				returnProofId: string;
			}
		>();
		const committedSequences = new Set<number>();
		const events: WorkflowJournalEvent[] = [];
		const frames = decodeWorkflowFixedFrames(bytes);
		const firstFrameRecord = parseCanonicalJsonBytes(frames[0].payload);
		if (!isWorkflowPersistedFrameValue(firstFrameRecord) || firstFrameRecord.frameKind !== "prepared")
			throw new Error("invalid-frame-header");
		let head = { ...seedHead };
		const validStoreEpoch = journal.options.epoch.storeEpoch;
		for (const frameInfo of frames) {
			const frameValue = parseCanonicalJsonBytes(frameInfo.payload);
			if (!isWorkflowPersistedFrameValue(frameValue)) throw new Error("invalid-frame-header");
			const frame = frameValue;
			assertWorkflowFixedFrameHeaderMatches(frameInfo, frame);
			if (
				frame.version !== WORKFLOW_FRAME_VERSION ||
				frame.workflowId !== journal.options.workflowId ||
				frameInfo.sequence !== frame.sequence ||
				frameInfo.storeEpoch !== frame.epochRef.storeEpoch ||
				frameInfo.coordinatorEpoch !== frame.epochRef.coordinatorEpoch ||
				frameInfo.kindCode !== WORKFLOW_FRAME_KIND_CODE[frame.frameKind]
			)
				throw new Error("invalid-frame-header");
			const payloadBytes = Uint8Array.from(frame.payloadBytes);
			const frameEpoch = frame.epochRef;
			const storeEpochDelta = frameEpoch.storeEpoch - head.epochRef.storeEpoch;
			const coordinatorEpochDelta = frameEpoch.coordinatorEpoch - head.epochRef.coordinatorEpoch;
			if (
				frameEpoch.storeEpoch < 1 ||
				frameEpoch.coordinatorEpoch < 1 ||
				storeEpochDelta < 0 ||
				coordinatorEpochDelta < 0 ||
				storeEpochDelta > 1 ||
				coordinatorEpochDelta > 1 ||
				frameEpoch.storeEpoch > validStoreEpoch ||
				frameEpoch.coordinatorEpoch > journal.options.epoch.coordinatorEpoch
			)
				throw new Error("stale_epoch");
			const payload = decodeWorkflowEventPayload(payloadBytes);
			const frameKey = await journal.options.keyProvider.resolve(
				journal.options.workflowId,
				String(frame.keyId),
				frameEpoch,
			);
			if (
				frameKey.keyId !== String(frame.keyId) ||
				frameKey.validStoreEpoch !== frameEpoch.storeEpoch ||
				frameKey.generationId !== String(frame.generationId)
			)
				throw new Error("stale_epoch");
			const epochChanged = digestObject(frameEpoch) !== digestObject(head.epochRef);
			if (epochChanged) {
				const predecessor = events[events.length - 1];
				const predecessorFenceEpoch =
					predecessor?.kind === "coordinator_epoch_fenced" || predecessor?.kind === "store_generation_fenced"
						? (
								predecessor.payload as Extract<
									WorkflowEventPayload,
									{ kind: "coordinator_epoch_fenced" | "store_generation_fenced" }
								>
							).nextEpoch
						: null;
				const seededFence =
					events.length === 0 &&
					seedHead.sequence > 0 &&
					(payload.kind === "coordinator_epoch_fenced" || payload.kind === "store_generation_fenced");
				const terminalFence =
					(payload.kind === "coordinator_epoch_fenced" || payload.kind === "store_generation_fenced") &&
					digestObject(payload.priorEpoch) === digestObject(head.epochRef) &&
					digestObject(payload.nextEpoch) === digestObject(frameEpoch) &&
					digestObject(frame.expectedHead) === digestObject(head) &&
					frame.sequence === head.sequence + 1;
				if (
					!seededFence &&
					!terminalFence &&
					(predecessorFenceEpoch === null || digestObject(predecessorFenceEpoch) !== digestObject(head.epochRef))
				)
					throw new Error("missing-predecessor-fence");
			}
			const outerAuthenticated = frameInfo.frameBytes.slice(
				0,
				frameInfo.frameBytes.byteLength - WORKFLOW_FRAME_MAC_BYTES - WORKFLOW_FRAME_CHECKSUM_BYTES,
			);
			const outerMac = frameInfo.frameBytes.slice(
				outerAuthenticated.byteLength,
				outerAuthenticated.byteLength + WORKFLOW_FRAME_MAC_BYTES,
			);
			const outerChecksum = frameInfo.frameBytes.slice(-WORKFLOW_FRAME_CHECKSUM_BYTES);
			const expectedOuterMac = createHmac("sha256", frameKey.secret).update(outerAuthenticated).digest();
			const expectedOuterChecksum = createHash("sha256")
				.update(Buffer.concat([Buffer.from(outerAuthenticated), expectedOuterMac]))
				.digest()
				.subarray(0, WORKFLOW_FRAME_CHECKSUM_BYTES);
			if (
				frameInfo.keyDigest !== sha256Hex(frame.keyId).slice(0, 16) ||
				!sameFixedBytes(outerMac, expectedOuterMac, WORKFLOW_FRAME_MAC_BYTES) ||
				!sameFixedBytes(outerChecksum, expectedOuterChecksum, WORKFLOW_FRAME_CHECKSUM_BYTES)
			)
				throw new Error("workflow-frame-authentication");
			const framePayloadMac = createHmac("sha256", frameKey.secret).update(frameInfo.payload).digest("hex");
			const framePayloadChecksum = createHash("sha256").update(frameInfo.payload).digest("hex").slice(0, 8);
			await verifyDurableFlushProof(journal.descriptorContext, {
				mutationId: frame.returnProofId,
				frameKind: frame.frameKind,
				frameDigest: sha256Hex(frameInfo.frameBytes),
			});
			const frameBytes = persistedFrameUnsignedBytes(frame);
			if (frame.frameKind === "prepared") {
				if (prepared.has(frame.sequence) || committedSequences.has(frame.sequence))
					throw new Error("duplicate-sequence");
				if (
					!sameFixedHex(
						frame.frameMac,
						createHmac("sha256", frameKey.secret).update(frameBytes).digest("hex"),
						32,
					) ||
					!sameFixedHex(frame.frameChecksum, createHash("sha256").update(frameBytes).digest("hex").slice(0, 8), 4)
				)
					throw new Error("prepared-frame-authentication");
				prepared.set(frame.sequence, {
					eventDigest: frame.eventDigest,
					payloadBytes,
					frameDigest: sha256Hex(frameInfo.payload),
					frameMac: framePayloadMac,
					frameChecksum: framePayloadChecksum,
					returnProofId: frame.returnProofId,
				});
				continue;
			}
			if (
				frame.frameKind !== "committed" ||
				committedSequences.has(frame.sequence) ||
				!prepared.has(frame.sequence) ||
				frame.sequence !== head.sequence + 1 ||
				digestObject(frame.expectedHead) !== digestObject(head) ||
				digestObject(frame.epochRef) !== digestObject(frameEpoch) ||
				frame.keyId !== frameKey.keyId ||
				frame.generationId !== frameKey.generationId ||
				!sameFixedHex(frame.frameMac, createHmac("sha256", frameKey.secret).update(frameBytes).digest("hex"), 32) ||
				!sameFixedHex(frame.recordMac, frame.frameMac, 32) ||
				!sameFixedHex(frame.frameChecksum, createHash("sha256").update(frameBytes).digest("hex").slice(0, 8), 4) ||
				!sameFixedHex(frame.recordChecksum, frame.frameChecksum, 4)
			)
				throw new Error("invalid-committed-chain");
			const preparedFrame = prepared.get(frame.sequence);
			if (preparedFrame === undefined) throw new Error("invalid-committed-chain");
			if (
				preparedFrame.eventDigest !== frame.eventDigest ||
				!sameBytes(preparedFrame.payloadBytes, payloadBytes) ||
				frame.preparedFrameDigest !== preparedFrame.frameDigest ||
				String(frame.eventDigest) !==
					canonicalWorkflowEventDigest({
						workflowId: journal.options.workflowId,
						sequence: frame.sequence,
						payloadBytes,
						priorEventDigest: head.eventDigest,
						idempotencyKey: String(frame.idempotencyKey),
						semanticBinding: frame.semanticBinding,
					})
			)
				throw new Error("prepared-committed-mismatch");
			if (frame.recordMac.length === 0 || frame.recordChecksum.length === 0)
				throw new Error("commit-return-uncertain");
			const eventWithoutProof = {
				workflowId: journal.options.workflowId,
				sequence: frame.sequence,
				kind: payload.kind,
				eventType: payload.kind,
				payload,
				payloadBytes,
				payloadDigest: digestObject(payload),
				priorEventDigest: head.eventDigest,
				eventDigest: frame.eventDigest,
				recordVersion: 1 as const,
				generationId: frame.generationId,
				recordMac: framePayloadMac,
				recordChecksum: framePayloadChecksum,
				idempotencyKey: frame.idempotencyKey,
				returnProofId: frame.returnProofId,
				expectedHead: frame.expectedHead,
				executionKey: frame.executionKey,
				epochRef: frame.epochRef,
				leaseRef: frame.leaseRef,
				writerIdentity: frame.writerIdentity,
				preparedFrameDigest: frame.preparedFrameDigest,
				committedFrameDigest: sha256Hex(frameInfo.frameBytes),
				keyId: frame.keyId,
				preparedFrameMac: preparedFrame.frameMac,
				committedFrameMac: framePayloadMac,
				preparedFrameChecksum: preparedFrame.frameChecksum,
				committedFrameChecksum: framePayloadChecksum,
				semanticBinding: frame.semanticBinding,
			};
			const persistedProof = await journal.returnProofStore.resolve(frame.returnProofId);
			if (
				persistedProof.state !== "returned" ||
				persistedProof.proof === null ||
				persistedProof.proof.recordVersion !== eventWithoutProof.recordVersion ||
				persistedProof.proof.generationId !== eventWithoutProof.generationId ||
				persistedProof.proof.workflowId !== eventWithoutProof.workflowId ||
				persistedProof.proof.mutationId !== eventWithoutProof.returnProofId ||
				persistedProof.proof.sequence !== eventWithoutProof.sequence ||
				persistedProof.proof.eventDigest !== eventWithoutProof.eventDigest ||
				persistedProof.proof.committedFrameDigest !== eventWithoutProof.committedFrameDigest ||
				digestObject(persistedProof.proof.expectedHead) !== digestObject(eventWithoutProof.expectedHead) ||
				digestObject(persistedProof.proof.epochRef) !== digestObject(eventWithoutProof.epochRef) ||
				digestObject(persistedProof.proof.leaseRef) !== digestObject(eventWithoutProof.leaseRef) ||
				persistedProof.proof.writerIdentity !== eventWithoutProof.writerIdentity ||
				persistedProof.proof.idempotencyKey !== eventWithoutProof.idempotencyKey ||
				persistedProof.proof.keyId !== eventWithoutProof.keyId ||
				!sameFixedHex(persistedProof.proof.frameMac, eventWithoutProof.committedFrameMac, 32) ||
				!sameFixedHex(persistedProof.proof.frameChecksum, eventWithoutProof.committedFrameChecksum, 4) ||
				!sameFixedHex(persistedProof.proof.recordMac, eventWithoutProof.recordMac, 32) ||
				!sameFixedHex(persistedProof.proof.recordChecksum, eventWithoutProof.recordChecksum, 4) ||
				persistedProof.proof.priorRecordDigest !== eventWithoutProof.priorEventDigest ||
				!sameFixedHex(persistedProof.proof.proofDigest, workflowCommitReturnProofDigest(persistedProof.proof), 32)
			)
				throw new Error("commit-return-uncertain");
			const event: WorkflowJournalEvent = { ...eventWithoutProof, commitReturnProof: persistedProof.proof };
			events.push(event);
			committedSequences.add(frame.sequence);
			journal.options.ownerValidators.validateReplay(event);
			head = {
				workflowId: journal.options.workflowId,
				sequence: event.sequence,
				eventDigest: event.eventDigest,
				epochRef:
					event.payload.kind === "store_generation_fenced" || event.payload.kind === "coordinator_epoch_fenced"
						? event.payload.nextEpoch
						: event.epochRef,
			};
		}
		if (prepared.size !== committedSequences.size || prepared.size !== events.length) {
			for (const [sequence, preparedFrame] of prepared) {
				if (committedSequences.has(sequence)) continue;
				const proof = await journal.returnProofStore.resolve(preparedFrame.returnProofId);
				if (proof.state === "committed" || proof.state === "returned") throw new Error("commit-return-uncertain");
			}
			throw new Error("prepared-tail-without-commit");
		}
		return { quarantined: false, events, metadata: metadata("complete", "none", head.sequence), head };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const classified: { status: WorkflowJournalTailStatus; reason: WorkflowJournalRecoveryMetadata["reason"] } =
			message.includes("workflow-frame-tail-truncated")
				? { status: "partial_frame", reason: "tail_truncated" }
				: message.includes("prepared-tail-without-commit")
					? { status: "prepared_only", reason: "prepared_without_commit" }
					: message.includes("duplicate-sequence")
						? { status: "partial_frame", reason: "duplicate_sequence" }
						: message.includes("commit-return-uncertain")
							? { status: "uncertain_committed", reason: "commit_return_uncertain" }
							: message.includes("invalid-committed-chain") ||
									message.includes("prepared-committed-mismatch") ||
									message.includes("missing-predecessor-fence")
								? { status: "partial_committed", reason: "sequence_chain_break" }
								: message.includes("authentication") || message.includes("invalid-mac")
									? { status: "partial_frame", reason: "invalid_mac" }
									: message.includes("stale_epoch")
										? { status: "partial_frame", reason: "stale_epoch" }
										: { status: "partial_frame", reason: "interior_corruption" };
		return {
			quarantined: true,
			events: [],
			metadata: metadata(classified.status, classified.reason, null),
			head: emptyHead,
		};
	}
}

async function quarantineDuplicateRotations(
	journal: WorkflowJournalImpl,
	records: readonly WorkflowGenerationRotationRecoveryRecord[],
): Promise<void> {
	for (const record of records)
		await journal.rotationStore.quarantine(record.request.rotationId, "rotation_fence_duplicate");
}

function classifyObservedRotationLease(
	record: WorkflowGenerationRotationRecoveryRecord,
	observed: { writerIdentity: string; leaseRef: WorkflowLeaseRef } | null,
): "next" | "previous" | "unknown" {
	if (observed === null) return "unknown";
	if (
		observed.writerIdentity === record.request.generationBinding.writerIdentity &&
		sameWorkflowLeaseIdentity(observed.leaseRef, record.request.nextLeaseRef)
	)
		return "next";
	if (
		observed.writerIdentity === record.request.previousWriterIdentity &&
		sameWorkflowLeaseIdentity(observed.leaseRef, record.request.previousLeaseRef)
	)
		return "previous";
	return "unknown";
}

async function quarantineUnprovenRotation(
	journal: WorkflowJournalImpl,
	record: WorkflowGenerationRotationRecoveryRecord,
	leaseState: "next" | "previous" | "unknown",
): Promise<void> {
	const reason: WorkflowGenerationRotationQuarantineReason =
		record.state === "prepared"
			? "rotation_prepared_only"
			: leaseState === "next"
				? "rotation_commit_uncertain"
				: "rotation_lease_transfer_unmatched";
	await journal.rotationStore.quarantine(record.request.rotationId, reason);
}

async function completeProvenGenerationRotation(
	journal: WorkflowJournalImpl,
	record: WorkflowGenerationRotationRecoveryRecord,
): Promise<WorkflowGenerationRotation> {
	if (record.state === "prepared") throw rotationRecoveryError(record);
	if (record.rotation !== null) return record.rotation;
	if (record.fenceEventSequence === null || record.fenceEventDigest === null || record.commitReturnProof === null) {
		const mutable = journal.options as {
			epoch: WorkflowEpochRef;
			leaseRef: WorkflowLeaseRef;
			writerIdentity: string;
		};
		const saved = { epoch: mutable.epoch, leaseRef: mutable.leaseRef, writerIdentity: mutable.writerIdentity };
		mutable.epoch = record.request.previousEpoch;
		mutable.leaseRef = record.request.previousLeaseRef;
		mutable.writerIdentity = record.request.previousWriterIdentity;
		let fence: { fenceEventSequence: number; fenceEventDigest: string; commitReturnProof: WorkflowCommitReturnProof };
		try {
			fence = await appendGenerationFence(
				journal,
				record.request,
				record.expectedHead,
				`return-proof:${record.request.idempotencyKey}`,
			);
		} finally {
			mutable.epoch = saved.epoch;
			mutable.leaseRef = saved.leaseRef;
			mutable.writerIdentity = saved.writerIdentity;
		}
		if (record.priorRecordDigest === null) throw rotationRecoveryError(record);
		await journal.rotationStore.markFenceCommitted(record.request.rotationId, {
			recordVersion: 1,
			generationId: record.request.generationId,
			expectedPriorRecordDigest: record.priorRecordDigest,
			fenceEventSequence: fence.fenceEventSequence,
			fenceEventDigest: fence.fenceEventDigest,
			commitReturnProof: fence.commitReturnProof,
			keyId: record.request.keyId,
			frameMac: record.request.frameMac,
			frameChecksum: record.request.frameChecksum,
			recordMac: record.request.recordMac,
			recordChecksum: record.request.recordChecksum,
		});
		record.fenceEventSequence = fence.fenceEventSequence;
		record.fenceEventDigest = fence.fenceEventDigest;
		record.commitReturnProof = fence.commitReturnProof;
	}
	if (record.fenceEventSequence === null || record.fenceEventDigest === null) throw rotationRecoveryError(record);
	return createWorkflowGenerationRotationResult(
		record.request,
		record.expectedHead,
		"committed",
		record.fenceEventSequence,
		record.fenceEventDigest,
		record.rotationArtifactRef,
		record.priorRecordDigest,
	);
}

function bindJournalGeneration(journal: WorkflowJournalImpl, rotation: WorkflowGenerationRotation): void {
	journal.options.epoch = rotation.nextEpoch;
	journal.options.leaseRef = rotation.nextLeaseRef;
	journal.options.writerIdentity = rotation.generationBinding.writerIdentity;
}

function assertIdempotentRotation(
	existing: WorkflowGenerationRotationRecoveryRecord,
	input: WorkflowGenerationRotationRequest,
): WorkflowGenerationRotation {
	if (
		existing.rotation === null ||
		existing.request.generationId !== input.generationId ||
		existing.request.mutationId !== input.mutationId ||
		existing.request.idempotencyKey !== input.idempotencyKey ||
		existing.request.expectedHeadDigest !== input.expectedHeadDigest ||
		digestObject(existing.request.previousEpoch) !== digestObject(input.previousEpoch) ||
		digestObject(existing.request.nextEpoch) !== digestObject(input.nextEpoch) ||
		digestObject(existing.request.previousLeaseRef) !== digestObject(input.previousLeaseRef) ||
		digestObject(existing.request.nextLeaseRef) !== digestObject(input.nextLeaseRef) ||
		digestObject(existing.request.generationBinding) !== digestObject(input.generationBinding) ||
		digestObject(existing.request.activeGenerationManifestRef) !== digestObject(input.activeGenerationManifestRef) ||
		existing.request.keyId !== input.keyId ||
		!sameFixedHex(existing.request.frameMac, input.frameMac, 32) ||
		!sameFixedHex(existing.request.frameChecksum, input.frameChecksum, 4) ||
		!sameFixedHex(existing.request.recordMac, input.recordMac, 32) ||
		!sameFixedHex(existing.request.recordChecksum, input.recordChecksum, 4)
	)
		throw new Error("Rotation retry conflicts with the complete authenticated request tuple.");
	return existing.rotation;
}

function rotationRecoveryError(_record: WorkflowGenerationRotationRecoveryRecord): Error {
	return new Error(`Workflow generation rotation is not durably proven: ${_record.quarantineReason ?? "unknown"}`);
}

function createWorkflowGenerationRotationResult(
	request: WorkflowGenerationRotationRequest,
	expectedHead: WorkflowJournalHead,
	status: "committed" | "quarantined",
	fenceEventSequence: number,
	fenceEventDigest: string,
	rotationArtifactRef: WorkflowArtifactRef,
	priorRecordDigest: string | null,
): WorkflowGenerationRotation {
	return {
		recordVersion: request.recordVersion,
		generationId: request.generationId,
		rotationId: request.rotationId,
		mutationId: request.mutationId,
		idempotencyKey: request.idempotencyKey,
		expectedHead,
		previousEpoch: request.previousEpoch,
		nextEpoch: request.nextEpoch,
		previousWriterIdentity: request.previousWriterIdentity,
		previousLeaseRef: request.previousLeaseRef,
		nextLeaseRef: request.nextLeaseRef,
		generationBinding: request.generationBinding,
		status,
		fenceEventSequence,
		fenceEventDigest,
		activeGenerationManifestRef: request.activeGenerationManifestRef,
		priorRecordDigest,
		keyId: request.keyId,
		frameMac: request.frameMac,
		frameChecksum: request.frameChecksum,
		recordMac: request.recordMac,
		recordChecksum: request.recordChecksum,
		rotationArtifactRef,
	};
}

async function assertRotationPreconditions(
	journal: WorkflowJournalImpl,
	input: WorkflowGenerationRotationRequest,
): Promise<{ head: WorkflowJournalHead; priorRecordDigest: string | null }> {
	const storeGenerationAdvance =
		input.nextEpoch.storeEpoch === input.previousEpoch.storeEpoch + 1 &&
		input.nextEpoch.coordinatorEpoch === input.previousEpoch.coordinatorEpoch;
	const coordinatorEpochAdvance =
		input.nextEpoch.storeEpoch === input.previousEpoch.storeEpoch &&
		input.nextEpoch.coordinatorEpoch === input.previousEpoch.coordinatorEpoch + 1;
	if (
		input.previousEpoch.storeEpoch !== journal.options.epoch.storeEpoch ||
		input.previousEpoch.coordinatorEpoch !== journal.options.epoch.coordinatorEpoch ||
		(!storeGenerationAdvance && !coordinatorEpochAdvance) ||
		input.previousWriterIdentity !== journal.options.writerIdentity ||
		input.generationBinding.ownerIdentity !== input.generationBinding.writerIdentity ||
		digestObject(input.previousLeaseRef) !== digestObject(journal.options.leaseRef) ||
		input.previousGenerationId !== journal.descriptorContext.generationId ||
		input.previousKeyId.length === 0 ||
		input.previousFrameMac.length === 0 ||
		input.previousFrameChecksum.length === 0 ||
		input.keyId.length === 0 ||
		input.frameMac.length === 0 ||
		input.frameChecksum.length === 0 ||
		input.previousGenerationId === input.generationId
	)
		throw new Error("Rotation preflight does not match the current durable predecessor or distinct successor tuple.");
	await resolveSideRecordSecret(journal.descriptorContext, {
		workflowId: journal.options.workflowId,
		keyId: input.previousKeyId,
		epochRef: input.previousEpoch,
		generationId: input.previousGenerationId,
	});
	await resolveSideRecordSecret(journal.descriptorContext, {
		workflowId: journal.options.workflowId,
		keyId: input.keyId,
		epochRef: input.nextEpoch,
		generationId: input.generationId,
	});
	const replay = await decodeAuthenticatedJournal(journal);
	if (replay.quarantined || digestObject(replay.head) !== input.expectedHeadDigest)
		throw new Error("Rotation preflight cannot prove the current authenticated head.");
	const expectedGenerationId = deriveWorkflowGenerationId({
		workflowId: journal.options.workflowId,
		nextEpoch: input.nextEpoch,
		rotationId: input.rotationId,
		priorHeadDigest: input.expectedHeadDigest,
	});
	if (
		input.generationId !== expectedGenerationId ||
		input.activeGenerationManifestRef.relativePath !== `${deriveWorkflowGenerationPath(expectedGenerationId)}/ACTIVE`
	)
		throw new Error("Rotation generation identity or manifest path is not host-derived.");
	const active = await journal.rotationStore.readActiveGeneration(journal.options.workflowId);
	const priorRecordDigest = active === null ? replay.head.eventDigest : sha256Hex(canonicalJsonBytes(active));
	if (input.priorRecordDigest !== priorRecordDigest)
		throw new Error("Rotation preflight does not match the authenticated prior generation record.");
	return { head: replay.head, priorRecordDigest };
}

async function appendGenerationFence(
	journal: WorkflowJournalImpl,
	input: WorkflowGenerationRotationRequest,
	expectedHead: WorkflowJournalHead,
	returnProofId: string,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<{ fenceEventSequence: number; fenceEventDigest: string; commitReturnProof: WorkflowCommitReturnProof }> {
	if (
		digestObject(journal.options.epoch) !== digestObject(input.previousEpoch) ||
		digestObject(journal.options.leaseRef) !== digestObject(input.previousLeaseRef) ||
		journal.options.writerIdentity !== input.previousWriterIdentity
	)
		throw new Error("Generation fence must be appended under the predecessor epoch, key, writer, and lease.");
	if (returnProofId !== `return-proof:${input.idempotencyKey}`)
		throw new Error("Generation fence return proof is not bound to the rotation idempotency key.");
	const payload =
		input.nextEpoch.storeEpoch > input.previousEpoch.storeEpoch
			? {
					kind: "store_generation_fenced" as const,
					workflowId: expectedHead.workflowId,
					storeEpoch: input.nextEpoch.storeEpoch,
					priorEpoch: input.previousEpoch,
					nextEpoch: input.nextEpoch,
					priorLeaseRef: input.previousLeaseRef,
					nextLeaseRef: input.nextLeaseRef,
					generationId: input.generationId,
					generationBinding: input.generationBinding,
				}
			: {
					kind: "coordinator_epoch_fenced" as const,
					workflowId: expectedHead.workflowId,
					coordinatorEpoch: input.nextEpoch.coordinatorEpoch,
					priorEpoch: input.previousEpoch,
					nextEpoch: input.nextEpoch,
					priorLeaseRef: input.previousLeaseRef,
					nextLeaseRef: input.nextLeaseRef,
					generationId: input.generationId,
					generationBinding: input.generationBinding,
				};
	const semanticBinding: WorkflowSemanticMutationBinding = {
		mutationId: input.mutationId,
		baselineDigest: input.expectedHeadDigest,
		expectedGenerations: { [input.previousGenerationId]: input.previousEpoch.storeEpoch },
		ownerId: "workflow-generation-rotation",
		phase: "recovering",
		reducerDigest: digestObject(payload),
		semanticHead: {
			workflowId: expectedHead.workflowId,
			sequence: expectedHead.sequence,
			eventDigest: expectedHead.eventDigest,
			stateDigest: input.expectedHeadDigest,
			epochRef: input.previousEpoch,
			generation: input.previousEpoch.storeEpoch,
		},
		expectedHead,
		idempotencyKey: input.idempotencyKey,
		executionKey: null,
		writerIdentity: input.previousWriterIdentity,
		leaseRef: input.previousLeaseRef,
		epochRef: input.previousEpoch,
	};
	const event = await appendWorkflowEvent(
		journal,
		{
			workflowId: expectedHead.workflowId,
			payload,
			expectedHead,
			epochRef: input.previousEpoch,
			leaseRef: input.previousLeaseRef,
			idempotencyKey: input.idempotencyKey,
			writerIdentity: input.previousWriterIdentity,
			executionKey: null,
			semanticBinding,
			returnProofId,
			crashHook: hook,
		},
		true,
		true,
	);
	return {
		fenceEventSequence: event.sequence,
		fenceEventDigest: event.eventDigest,
		commitReturnProof: event.commitReturnProof,
	};
}

const journalQueues = new WeakMap<WorkflowJournalImpl, Promise<void>>();
const journalCommitReturnBarriers = new Map<string, Promise<void>>();
const snapshotQueues = new Map<string, Promise<void>>();
const outboxQueues = new Map<string, Promise<void>>();

async function withJournalLock<T>(journal: WorkflowJournalImpl, operation: () => Promise<T>): Promise<T> {
	const previous = journalQueues.get(journal) ?? Promise.resolve();
	const current = previous.then(
		async () => {
			const result = await operation();
			return result;
		},
		async () => {
			const result = await operation();
			return result;
		},
	);
	journalQueues.set(
		journal,
		current.then(
			() => undefined,
			() => undefined,
		),
	);
	return current;
}

async function withKeyedLock<T>(
	queues: Map<string, Promise<void>>,
	key: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = queues.get(key) ?? Promise.resolve();
	const current = previous.then(operation, operation);
	queues.set(
		key,
		current.then(
			() => undefined,
			() => undefined,
		),
	);
	return current;
}

function withSnapshotLock<T>(workflowRoot: string, operation: () => Promise<T>): Promise<T> {
	return withKeyedLock(snapshotQueues, workflowRoot, operation);
}

function withOutboxLock<T>(workflowRoot: string, operation: () => Promise<T>): Promise<T> {
	return withKeyedLock(outboxQueues, workflowRoot, operation);
}

const workflowBootstrapQueues = new Map<string, Promise<void>>();

/** Atomically create authenticated generation metadata before the first journal open. */
async function bootstrapWorkflowGeneration(options: WorkflowJournalOptions): Promise<void> {
	await withKeyedLock(workflowBootstrapQueues, options.workflowId, async () => {
		await options.appendLease.withExclusiveGuard(
			{
				workflowId: options.workflowId,
				writerIdentity: options.writerIdentity,
				leaseRef: options.leaseRef,
				epochRef: options.epoch,
				rootDigest: options.leaseRef.rootDigest,
				boundary: "bootstrap-assert-guard-before-active-generation-authority",
			},
			async () => {
				const root = await options.descriptorFs.openRoot(options.sessionArtifactRoot);
				let workflow: WorkflowDescriptorHandle | undefined;
				try {
					if (root.identityDigest !== options.descriptorRoots.sessionRoot.identityDigest)
						throw new Error("Fresh workflow bootstrap opened a foreign session descriptor.");
					workflow = await openDescriptorDirectoryChain(
						options.descriptorFs,
						root,
						["workflows", options.workflowId],
						true,
					);
					const activePath = ["side-records", "active-generation.json"] as const;
					const existingActive = await readDescriptorBytesIfPresent(options.descriptorFs, workflow, activePath);
					if (existingActive !== null) return;
					const key = await options.keyProvider.current(options.workflowId, options.epoch);
					if (
						!/^generation-[0-9a-f]{32}$/.test(key.generationId) ||
						key.validStoreEpoch !== options.epoch.storeEpoch ||
						key.keyId.length === 0
					)
						throw new Error("Fresh workflow bootstrap key does not supply a canonical generation identity.");
					const occupiedPaths: readonly (readonly string[])[] = [
						["generations", key.generationId, "events.log"],
						["generations", key.generationId, "ACTIVE"],
						["generations", key.generationId, "side-records", "lease.json"],
						["generations", key.generationId, "side-records", "key.json"],
						["generations", key.generationId, "side-records", "rotations", "records.json"],
						["generations", key.generationId, "side-records", "return-proofs", "records.json"],
						["generations", key.generationId, "outbox", "events.log"],
						["generations", key.generationId, "snapshots", "head.json"],
						["generations", key.generationId, "projections", "head.json"],
						["generations", "events.log"],
						["side-records", "active-generation.json"],
						["side-records", "lease.json"],
						["side-records", "key.json"],
						["side-records", "rotations", "records.json"],
						["side-records", "return-proofs", "records.json"],
						["outbox", "events.log"],
						["snapshots", "head.json"],
						["projections", "head.json"],
						["artifacts", "index.json"],
					];
					if (workflow === undefined)
						throw new Error("Fresh workflow bootstrap did not open its workflow descriptor.");
					const openedWorkflow = workflow;
					const occupied = await Promise.all(
						occupiedPaths.map((path) => readDescriptorBytesIfPresent(options.descriptorFs, openedWorkflow, path)),
					);
					if (occupied.some((bytes) => bytes !== null && bytes.byteLength > 0))
						throw new Error(
							"Workflow root is non-empty but has no authenticated active generation; refusing bootstrap.",
						);
					const generationPath = deriveWorkflowGenerationPath(key.generationId);
					const emptyHead: WorkflowJournalHead = {
						workflowId: options.workflowId,
						sequence: 0,
						eventDigest: null,
						epochRef: options.epoch,
					};
					const manifestRefBase: WorkflowArtifactRef = {
						artifactId: `generation-manifest:${key.generationId}`,
						relativePath: `${generationPath}/ACTIVE`,
						digest: "",
						sizeBytes: 0,
						sourceEventSequence: 0,
					};
					const unsignedBase = {
						workflowId: options.workflowId,
						generationId: key.generationId,
						manifestRef: manifestRefBase,
						sourceHead: emptyHead,
						epochRef: options.epoch,
						generationBinding: {
							writerIdentity: options.writerIdentity,
							processGenerationId: options.leaseRef.leaseId,
							ownerIdentity: options.writerIdentity,
						},
						leaseRef: options.leaseRef,
						keyId: key.keyId,
						frameMac: sha256Hex(
							canonicalJsonBytes({ bootstrap: options.workflowId, generationId: key.generationId }),
						),
						frameChecksum: sha256Hex(canonicalJsonBytes({ epoch: options.epoch, lease: options.leaseRef })).slice(
							0,
							8,
						),
						priorRecordDigest: null,
						manifestBytesDigest: "",
						sideRecordMac: "",
					};
					const manifestDigest = workflowActiveGenerationManifestBytesDigest(unsignedBase);
					const manifestRef = { ...manifestRefBase, digest: manifestDigest };
					const record = buildAuthenticatedActiveGenerationRecord({
						record: { ...unsignedBase, manifestRef, manifestBytesDigest: manifestDigest },
						secret: key.secret,
					});
					const recordBytes = record.bytes;
					const manifestResult = await writeDescriptorBytes(
						options.descriptorFs,
						root,
						["workflows", options.workflowId, ...generationPath.split("/"), "ACTIVE"],
						recordBytes,
						true,
					);
					const activeResult = await writeDescriptorBytes(
						options.descriptorFs,
						root,
						["workflows", options.workflowId, ...activePath],
						recordBytes,
						true,
					);
					if (manifestResult === "already_exists" || activeResult === "already_exists") {
						const persisted = await readDescriptorBytesIfPresent(options.descriptorFs, workflow, activePath);
						if (persisted === null || !sameBytes(persisted, recordBytes))
							throw new Error("Concurrent fresh workflow bootstrap published conflicting generation metadata.");
					}
					await options.descriptorFs.syncDirectoryChain(workflow, root);
				} finally {
					if (workflow !== undefined) await workflow.close().catch(() => undefined);
					await root.close().catch(() => undefined);
				}
			},
		);
	});
}

async function openWorkflowJournal(
	options: WorkflowJournalOptions,
	skipBootstrap = false,
): Promise<WorkflowJournalImpl> {
	options.ownerValidators.validateOpen({
		workflowId: options.workflowId,
		rootSessionId: options.rootSessionId,
		epochRef: options.epoch,
	});
	if (
		options.storeId.length === 0 ||
		options.namespace.length === 0 ||
		options.namespace.includes("/") ||
		options.namespace.includes("\\") ||
		(options.storeKind === "knowledge" && options.workflowId.length === 0)
	)
		throw new Error("Journal store identity is not a closed kind, namespace, and store identifier.");
	assertSessionRootIdentity(
		options.sessionArtifactRoot,
		options.artifactRoot,
		options.rootSessionId,
		options.workflowId,
	);
	assertWorkflowIdentity(options.artifactRoot, options.workflowDir, options.workflowId);
	if (
		options.descriptorRoots.sessionRoot.rootSessionId !== options.rootSessionId ||
		options.descriptorRoots.sessionRoot.descriptorRoot !== options.sessionArtifactRoot ||
		options.descriptorRoots.workflowRoot.workflowId !== options.workflowId ||
		options.descriptorRoots.workflowRoot.descriptorRoot !== options.workflowDir
	)
		throw new Error("Journal options are not bound to one validated split descriptor-root adapter.");
	if (!skipBootstrap) await bootstrapWorkflowGeneration(options);
	const descriptorContext = await openWorkflowDescriptorContext(
		options.descriptorFs,
		options.descriptorRoots,
		options.workflowId,
		options.keyProvider,
		options.epoch,
	);
	try {
		const returnProofStore = createDescriptorCommitReturnProofStore(descriptorContext);
		const rotationStore = createDescriptorGenerationRotationStore(descriptorContext);
		const activeGeneration = await rotationStore.readActiveGeneration(options.workflowId);
		if (
			activeGeneration === null ||
			activeGeneration.generationId !== descriptorContext.generationId ||
			activeGeneration.workflowId !== options.workflowId ||
			activeGeneration.manifestRef.relativePath !==
				`${deriveWorkflowGenerationPath(activeGeneration.generationId)}/ACTIVE` ||
			digestObject(activeGeneration.epochRef) !== digestObject(options.epoch) ||
			activeGeneration.sideRecordMac.length === 0
		)
			throw new Error(
				"Persisted active generation is not bound to the validated workflow root, generation, or epoch.",
			);
		const storage = await openWorkflowJournalDurableStorage(descriptorContext);
		await assertPrivateRegularJournal(storage);
		const outboxRecovery = await recoverWorkflowOutbox(descriptorContext, options.epoch);
		if (outboxRecovery.quarantined) throw new WorkflowOutboxRecoveryError(outboxRecovery.metadata);
		return new WorkflowJournalImpl(options, storage, descriptorContext, returnProofStore, rotationStore);
	} catch (error) {
		await descriptorContext.workflow.close().catch(() => undefined);
		await descriptorContext.root.close().catch(() => undefined);
		throw error;
	}
}

async function publishWorkflowArtifact(
	context: WorkflowDescriptorContext,
	appendLease: WorkflowAppendLease,
	guard: { writerIdentity: string; leaseRef: WorkflowLeaseRef; epochRef: WorkflowEpochRef },
	input: WorkflowArtifactPublishInput,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<WorkflowArtifactPublishResult> {
	return appendLease.withExclusiveGuard(
		{
			workflowId: context.workflowId,
			writerIdentity: guard.writerIdentity,
			leaseRef: guard.leaseRef,
			epochRef: guard.epochRef,
			rootDigest: context.rootDigest,
			boundary: "artifact-idempotency-read-cas-write-fsync-rename-parent-fsync",
		},
		async () => {
			await assertLeaseAtBoundary(
				appendLease,
				context.rootDigest,
				{
					workflowId: context.workflowId,
					writerIdentity: guard.writerIdentity,
					leaseRef: guard.leaseRef,
					epochRef: guard.epochRef,
				},
				"artifact-before-idempotency-read",
			);
			assertArtifactPublishInput(context.workflowId, input);
			const artifactTupleDigest = digestObject({
				workflowId: input.workflowId,
				payloadKind: input.payloadKind,
				codec: input.codec,
				sourceEventSequence: input.sourceEventSequence,
				bytesDigest: sha256Hex(input.bytes),
			});
			const storage = await openWorkflowJournalDurableStorage(context);
			const idempotencyKey = await context.keyProvider.current(input.workflowId, context.epochRef);
			const idempotencyRecordWithoutMac = {
				workflowId: input.workflowId,
				idempotencyKey: input.idempotencyKey,
				tupleDigest: artifactTupleDigest,
				keyId: idempotencyKey.keyId,
				generationId: idempotencyKey.generationId,
				epochRef: context.epochRef,
				sideRecordMac: "",
			};
			const idempotencyRecord: WorkflowArtifactIdempotencyRecord = {
				...idempotencyRecordWithoutMac,
				sideRecordMac: sideRecordMac(idempotencyRecordWithoutMac, idempotencyKey.secret),
			};
			const idempotencyComponents = artifactIdempotencyComponents(input.idempotencyKey);
			const existingIdempotencyBytes = await storage.readImmutable(idempotencyComponents);
			if (
				existingIdempotencyBytes !== null &&
				digestObject(decodeArtifactIdempotencyRecord(existingIdempotencyBytes, idempotencyKey.secret)) !==
					digestObject(idempotencyRecord)
			)
				throw new Error("Artifact idempotency key conflicts with a different authenticated tuple.");
			if (existingIdempotencyBytes === null) {
				await assertLeaseAtBoundary(
					appendLease,
					context.rootDigest,
					{
						workflowId: context.workflowId,
						writerIdentity: guard.writerIdentity,
						leaseRef: guard.leaseRef,
						epochRef: guard.epochRef,
					},
					"artifact-before-idempotency-publish",
				);
				await storage.publishImmutable(
					idempotencyComponents,
					canonicalJsonBytes(idempotencyRecord),
					{
						workflowId: input.workflowId,
						mutationId: input.idempotencyKey,
						digest: idempotencyRecord.sideRecordMac,
						checkpoints: [],
					},
					hook,
				);
				await assertLeaseAtBoundary(
					appendLease,
					context.rootDigest,
					{
						workflowId: context.workflowId,
						writerIdentity: guard.writerIdentity,
						leaseRef: guard.leaseRef,
						epochRef: guard.epochRef,
					},
					"artifact-after-idempotency-parent-fsync",
				);
				const persistedIdempotencyBytes = await storage.readImmutable(idempotencyComponents);
				if (
					persistedIdempotencyBytes === null ||
					digestObject(decodeArtifactIdempotencyRecord(persistedIdempotencyBytes, idempotencyKey.secret)) !==
						digestObject(idempotencyRecord)
				)
					throw new Error("Artifact idempotency publication did not durably bind the authenticated tuple.");
			}
			const ref = deriveContentAddressedArtifactRef(input);
			const envelope: WorkflowArtifactEnvelope = {
				ref,
				payloadKind: input.payloadKind,
				codec: input.codec,
				immutable: true,
			};
			if (input.codec === "canonical_json") assertCanonicalBytes(input.bytes);
			await assertLeaseAtBoundary(
				appendLease,
				context.rootDigest,
				{
					workflowId: context.workflowId,
					writerIdentity: guard.writerIdentity,
					leaseRef: guard.leaseRef,
					epochRef: guard.epochRef,
				},
				"artifact-before-content-publish",
			);
			const artifactStatus = await storage.publishImmutable(
				artifactComponents(ref),
				input.bytes,
				{
					workflowId: input.workflowId,
					mutationId: input.idempotencyKey,
					digest: ref.digest,
					checkpoints: [DurableStoreCrashBoundary.afterDirectoryFlushBeforeArtifactPublish],
				},
				hook,
			);
			await assertLeaseAtBoundary(
				appendLease,
				context.rootDigest,
				{
					workflowId: context.workflowId,
					writerIdentity: guard.writerIdentity,
					leaseRef: guard.leaseRef,
					epochRef: guard.epochRef,
				},
				"artifact-after-content-parent-fsync",
			);
			await assertLeaseAtBoundary(
				appendLease,
				context.rootDigest,
				{
					workflowId: context.workflowId,
					writerIdentity: guard.writerIdentity,
					leaseRef: guard.leaseRef,
					epochRef: guard.epochRef,
				},
				"artifact-before-metadata-publish",
			);
			const metadataStatus = await storage.publishImmutable(
				artifactMetadataComponents(ref),
				canonicalJsonBytes(envelope),
				{
					workflowId: input.workflowId,
					mutationId: input.idempotencyKey,
					digest: digestObject(envelope),
					checkpoints: [DurableStoreCrashBoundary.afterDirectoryFlushBeforeArtifactPublish],
				},
				hook,
			);
			await assertLeaseAtBoundary(
				appendLease,
				context.rootDigest,
				{
					workflowId: context.workflowId,
					writerIdentity: guard.writerIdentity,
					leaseRef: guard.leaseRef,
					epochRef: guard.epochRef,
				},
				"artifact-after-metadata-parent-fsync",
			);
			return {
				status:
					artifactStatus === "already_exists" && metadataStatus === "already_exists"
						? "already_published"
						: "published",
				envelope,
			};
		},
	);
}

async function resolveWorkflowArtifact(
	context: WorkflowDescriptorContext,
	ref: WorkflowArtifactRef,
): Promise<WorkflowArtifactReadResult> {
	assertArtifactRef(ref);
	const storage = await openWorkflowJournalDurableStorage(context);
	const bytes = await storage.readImmutable(artifactComponents(ref));
	const metadataBytes = await storage.readImmutable(artifactMetadataComponents(ref));
	if (bytes === null || metadataBytes === null) throw new Error("Workflow artifact is missing.");
	const envelope = decodeArtifactEnvelope(metadataBytes);
	assertArtifactEnvelopeMatches(envelope, ref, bytes);
	return { envelope, exists: true, bytes, verifiedDigest: sha256Hex(bytes), verifiedSizeBytes: bytes.byteLength };
}

async function publishWorkflowSnapshot(
	context: WorkflowDescriptorContext,
	appendLease: WorkflowAppendLease,
	input: WorkflowSnapshotPublishInput,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<WorkflowSnapshotPublishResult> {
	assertSnapshotPublishInput(context.workflowId, input);
	return appendLease.withExclusiveGuard(
		{
			workflowId: input.workflowId,
			writerIdentity: input.writerIdentity,
			leaseRef: input.leaseRef,
			epochRef: input.epochRef,
			rootDigest: context.rootDigest,
			boundary: "snapshot-read-cas-write-fsync-rename-dir-fsync",
		},
		async () => {
			await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "snapshot-before-read");
			return withSnapshotLock(context.rootDigest, async () => {
				const storage = await openWorkflowJournalDurableStorage(context);
				const currentSnapshot = await readWorkflowSnapshotHead(storage, input.workflowId, input.epochRef);
				const currentHead = currentSnapshot.head;
				const targetHead: WorkflowSnapshotHead = {
					workflowId: input.workflowId,
					sequence: input.sequence,
					sourceEventDigest: input.sourceEventDigest,
					stateDigest: input.stateDigest,
					epochRef: input.epochRef,
				};
				const snapshotSecret = await resolveCurrentSideRecordSecret(context, {
					workflowId: input.workflowId,
					keyId: input.authenticatedTuple.keyId,
					epochRef: input.authenticatedTuple.epochRef,
					generationId: input.authenticatedTuple.generationId,
				});
				const envelope = encodeSnapshotEnvelope(input, snapshotSecret);
				const existing = await storage.readImmutable(snapshotComponents(input.idempotencyKey));
				if (existing !== null) decodeSnapshotEnvelope(existing, snapshotSecret);
				if (existing !== null && !sameBytes(existing, envelope))
					throw new Error("Workflow snapshot idempotency key conflicts with immutable bytes.");
				if (existing !== null && digestObject(currentHead) === digestObject(targetHead))
					return {
						status: "already_published",
						sequence: input.sequence,
						sourceEventDigest: input.sourceEventDigest,
						stateDigest: input.stateDigest,
					};
				if (digestObject(currentHead) !== digestObject(input.expectedHead))
					throw new Error("Workflow snapshot expected head is stale.");
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterArtifactPublishBeforeSnapshotPublish)
					await hook.before({
						storeId: input.workflowId,
						mutationId: input.idempotencyKey,
						checkpoint: hook.checkpoint,
					});
				if (existing === null) {
					await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "before-snapshot-write");
					await storage.publishImmutable(
						snapshotComponents(input.idempotencyKey),
						envelope,
						{
							workflowId: input.workflowId,
							mutationId: input.idempotencyKey,
							digest: sha256Hex(envelope),
							checkpoints: [
								DurableStoreCrashBoundary.afterSnapshotAppendBeforeSnapshotFileFlush,
								DurableStoreCrashBoundary.afterSnapshotFileFlushBeforeSnapshotRename,
								DurableStoreCrashBoundary.afterSnapshotRenameBeforeProjectionCas,
							],
						},
						hook,
					);
					await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "after-snapshot-rename");
				}
				await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "before-snapshot-head-publish");
				await storage.publishHead(snapshotHeadComponents(), currentSnapshot.bytes, canonicalJsonBytes(targetHead));
				await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "after-snapshot-head-dir-fsync");
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterArtifactPublishBeforeSnapshotPublish)
					await hook.after({
						storeId: input.workflowId,
						mutationId: input.idempotencyKey,
						checkpoint: hook.checkpoint,
						digest: sha256Hex(envelope),
					});
				await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "snapshot-after-dir-fsync");
				return {
					status: "published",
					sequence: input.sequence,
					sourceEventDigest: input.sourceEventDigest,
					stateDigest: input.stateDigest,
				};
			});
		},
	);
}

async function recoverWorkflowOutbox(
	context: WorkflowDescriptorContext,
	expectedEpoch: WorkflowEpochRef,
): Promise<WorkflowOutboxRecoveryResult> {
	const workflowId = context.workflowId;
	const storage = await openWorkflowJournalDurableStorage(context);
	return decodeOutboxRecordChain(
		await storage.readOutboxBytes(),
		workflowId,
		expectedEpoch,
		storage.diagnosticPath,
		context.keyProvider,
		context,
	);
}

async function appendWorkflowOutbox(
	context: WorkflowDescriptorContext,
	appendLease: WorkflowAppendLease,
	input: WorkflowOutboxAppendInput,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<WorkflowOutboxAppendResult> {
	assertOutboxAppendInput(context.workflowId, input);
	return appendLease.withExclusiveGuard(
		{
			workflowId: input.workflowId,
			writerIdentity: input.writerIdentity,
			leaseRef: input.leaseRef,
			epochRef: input.epochRef,
			rootDigest: context.rootDigest,
			boundary: "outbox-read-cas-write-fsync-dir-fsync",
		},
		async () => {
			await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "outbox-before-read");
			return withOutboxLock(context.rootDigest, async () => {
				const storage = await openWorkflowJournalDurableStorage(context);
				const recovery = await decodeOutboxRecordChain(
					await storage.readOutboxBytes(),
					input.workflowId,
					input.epochRef,
					storage.diagnosticPath,
					context.keyProvider,
					context,
				);
				if (recovery.quarantined) throw new WorkflowOutboxRecoveryError(recovery.metadata);
				const existing = recovery.entries.find((entry) => entry.idempotencyKey === input.idempotencyKey);
				if (existing !== undefined) {
					if (digestOutboxInput(existing) !== digestOutboxInput(input))
						throw new Error("Workflow outbox idempotency key conflicts with immutable bytes.");
					return { status: "already_appended", sequence: input.sequence, entryDigest: input.entryDigest };
				}
				if (
					digestObject(recovery.head) !== digestObject(input.expectedHead) ||
					input.sequence !== recovery.head.sequence + 1
				)
					throw new Error("Workflow outbox expected head is stale.");
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterProjectionCasBeforeOutbox)
					await hook.before({
						storeId: input.workflowId,
						mutationId: input.idempotencyKey,
						checkpoint: hook.checkpoint,
					});
				await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "before-outbox-frame-append");
				const outboxSecret = await resolveCurrentSideRecordSecret(context, {
					workflowId: input.workflowId,
					keyId: input.authenticatedTuple.keyId,
					epochRef: input.authenticatedTuple.epochRef,
					generationId: input.authenticatedTuple.generationId,
				});
				await storage.appendOutboxFrame(
					encodeOutboxRecord(input, outboxSecret),
					{ workflowId: input.workflowId, mutationId: input.idempotencyKey, digest: input.entryDigest },
					hook,
				);
				await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "after-outbox-dir-fsync");
				if (hook?.checkpoint === DurableStoreCrashBoundary.afterProjectionCasBeforeOutbox)
					await hook.after({
						storeId: input.workflowId,
						mutationId: input.idempotencyKey,
						checkpoint: hook.checkpoint,
						digest: input.entryDigest,
					});
				await assertLeaseAtBoundary(appendLease, context.rootDigest, input, "outbox-after-dir-fsync");
				return { status: "appended", sequence: input.sequence, entryDigest: input.entryDigest };
			});
		},
	);
}

async function appendWorkflowEvent(
	journal: WorkflowJournalImpl,
	input: WorkflowJournalAppendInput,
	leaseAlreadyHeld = false,
	journalLockAlreadyHeld = false,
): Promise<WorkflowJournalEvent> {
	const run = async (): Promise<WorkflowJournalEvent> => {
		assertJournalAppendInput(journal, input);
		const expectedReturnProofId = `return-proof:${input.idempotencyKey}`;
		if (input.returnProofId !== expectedReturnProofId)
			throw new Error("Return-proof ID is not the deterministic mutation binding.");
		const operation = async (): Promise<WorkflowJournalEvent> => {
			await assertLeaseAtBoundary(
				journal.options.appendLease,
				journal.descriptorContext.rootDigest,
				input,
				"before-journal-read",
			);
			const replay = await decodeAuthenticatedJournal(journal);
			const existing = replay.events.find((event) => event.idempotencyKey === input.idempotencyKey);
			if (existing !== undefined) return assertIdempotentJournalReplay(existing, input);
			if (digestObject(replay.head) !== digestObject(input.expectedHead))
				throw new Error("Workflow journal expected head is stale.");
			const key = await journal.options.keyProvider.current(input.workflowId, input.epochRef);
			await assertLeaseAtBoundary(
				journal.options.appendLease,
				journal.descriptorContext.rootDigest,
				input,
				"before-return-proof-pending",
			);
			const pendingEventDigest = canonicalWorkflowEventDigest({
				workflowId: input.workflowId,
				sequence: replay.head.sequence + 1,
				payloadBytes: canonicalJsonBytes(input.payload),
				priorEventDigest: replay.head.eventDigest,
				idempotencyKey: input.idempotencyKey,
				semanticBinding: input.semanticBinding,
			});
			const pendingTupleDigest = digestObject({
				workflowId: input.workflowId,
				mutationId: input.semanticBinding.mutationId,
				expectedHead: input.expectedHead,
				sequence: replay.head.sequence + 1,
				epochRef: input.epochRef,
				leaseRef: input.leaseRef,
				writerIdentity: input.writerIdentity,
				idempotencyKey: input.idempotencyKey,
				keyId: key.keyId,
				semanticBinding: input.semanticBinding,
			});
			await journal.returnProofStore.markPending({
				recordVersion: 1,
				generationId: key.generationId,
				mutationId: input.returnProofId,
				workflowId: input.workflowId,
				expectedSequence: replay.head.sequence + 1,
				eventDigest: pendingEventDigest,
				expectedHead: input.expectedHead,
				epochRef: input.epochRef,
				leaseRef: input.leaseRef,
				writerIdentity: input.writerIdentity,
				idempotencyKey: input.idempotencyKey,
				keyId: key.keyId,
				frameMac: pendingTupleDigest,
				frameChecksum: sha256Hex(new TextEncoder().encode(pendingTupleDigest)).slice(0, 8),
				recordMac: pendingTupleDigest,
				recordChecksum: sha256Hex(new TextEncoder().encode(pendingTupleDigest)).slice(0, 8),
				priorRecordDigest: replay.head.eventDigest,
			});
			await assertLeaseAtBoundary(
				journal.options.appendLease,
				journal.descriptorContext.rootDigest,
				input,
				"after-return-proof-pending",
			);
			let releaseCommitReturnBarrier = (): void => undefined;
			const commitReturnBarrier = new Promise<void>((resolve) => {
				releaseCommitReturnBarrier = resolve;
			});
			const journalPath = journal.storage.diagnosticPath;
			journalCommitReturnBarriers.set(journalPath, commitReturnBarrier);
			try {
				const committed = await appendPreparedAndCommittedFrames(
					journal,
					input,
					replay.head.sequence + 1,
					replay.head.eventDigest,
				);
				await assertLeaseAtBoundary(
					journal.options.appendLease,
					journal.descriptorContext.rootDigest,
					input,
					"after-committed-frame-fsync",
				);
				await assertLeaseAtBoundary(
					journal.options.appendLease,
					journal.descriptorContext.rootDigest,
					input,
					"before-return-proof-committed",
				);
				await journal.returnProofStore.markCommitted({
					recordVersion: 1,
					generationId: key.generationId,
					mutationId: input.returnProofId,
					workflowId: input.workflowId,
					sequence: committed.sequence,
					eventDigest: committed.eventDigest,
					committedFrameDigest: committed.committedFrameDigest,
					expectedHead: input.expectedHead,
					epochRef: input.epochRef,
					leaseRef: input.leaseRef,
					writerIdentity: input.writerIdentity,
					idempotencyKey: input.idempotencyKey,
					keyId: committed.keyId,
					frameMac: committed.committedFrameMac,
					frameChecksum: committed.committedFrameChecksum,
					recordMac: committed.committedFrameMac,
					recordChecksum: committed.committedFrameChecksum,
					priorRecordDigest: replay.head.eventDigest,
				});
				await assertLeaseAtBoundary(
					journal.options.appendLease,
					journal.descriptorContext.rootDigest,
					input,
					"after-return-proof-committed",
				);
				const proofWithoutDigest = {
					recordVersion: 1 as const,
					generationId: key.generationId,
					mutationId: input.returnProofId,
					workflowId: input.workflowId,
					sequence: committed.sequence,
					eventDigest: committed.eventDigest,
					committedFrameDigest: committed.committedFrameDigest,
					expectedHead: input.expectedHead,
					epochRef: input.epochRef,
					leaseRef: input.leaseRef,
					writerIdentity: input.writerIdentity,
					idempotencyKey: input.idempotencyKey,
					keyId: committed.keyId,
					frameMac: committed.committedFrameMac,
					frameChecksum: committed.committedFrameChecksum,
					recordMac: committed.committedFrameMac,
					recordChecksum: committed.committedFrameChecksum,
					priorRecordDigest: replay.head.eventDigest,
					returnedAt: journal.options.now(),
				};
				const commitReturnProof: WorkflowCommitReturnProof = {
					...proofWithoutDigest,
					proofDigest: digestObject(proofWithoutDigest),
				};
				await assertLeaseAtBoundary(
					journal.options.appendLease,
					journal.descriptorContext.rootDigest,
					input,
					"before-return-proof-returned",
				);
				await journal.returnProofStore.markReturned(commitReturnProof);
				await assertLeaseAtBoundary(
					journal.options.appendLease,
					journal.descriptorContext.rootDigest,
					input,
					"after-return-proof-returned",
				);
				return { ...committed, commitReturnProof };
			} finally {
				if (journalCommitReturnBarriers.get(journalPath) === commitReturnBarrier)
					journalCommitReturnBarriers.delete(journalPath);
				releaseCommitReturnBarrier();
			}
		};
		return leaseAlreadyHeld
			? operation()
			: journal.options.appendLease.withExclusiveGuard(
					{
						workflowId: input.workflowId,
						writerIdentity: input.writerIdentity,
						leaseRef: input.leaseRef,
						epochRef: input.epochRef,
						rootDigest: journal.descriptorContext.rootDigest,
						boundary: "journal-read-cas-write-fsync-return-proof",
					},
					operation,
				);
	};
	try {
		const committed = journalLockAlreadyHeld ? await run() : await withJournalLock(journal, run);
		updateWorkflowGoalProjectionDurableHead(journal, committed.eventDigest);
		return committed;
	} finally {
		// Any append attempt may cross a durable boundary before reporting an error;
		// invalidate previously issued projection authorities conservatively.
		workflowGoalProjectionHeadGeneration(journal).value += 1;
	}
}

async function replayWorkflowEvents(journal: WorkflowJournalImpl): Promise<readonly WorkflowJournalEvent[]> {
	let replay = await decodeAuthenticatedJournal(journal);
	if (replay.quarantined && replay.metadata.reason === "commit_return_uncertain") {
		await journalCommitReturnBarriers.get(journal.storage.diagnosticPath);
		replay = await decodeAuthenticatedJournal(journal);
	}
	if (replay.quarantined) throw new WorkflowJournalRecoveryError(replay.metadata);
	return replay.events;
}

function journalEventsHead(
	events: readonly WorkflowJournalEvent[],
	fallbackEpoch: WorkflowEpochRef,
	workflowId: string,
): WorkflowJournalHead {
	const last = events.at(-1);
	return last === undefined
		? { workflowId, sequence: 0, eventDigest: null, epochRef: { ...fallbackEpoch } }
		: {
				workflowId: last.workflowId,
				sequence: last.sequence,
				eventDigest: last.eventDigest,
				epochRef:
					last.payload.kind === "store_generation_fenced" || last.payload.kind === "coordinator_epoch_fenced"
						? { ...last.payload.nextEpoch }
						: { ...last.epochRef },
			};
}

function journalHeadBeforeRotationFence(
	events: readonly WorkflowJournalEvent[],
	request: WorkflowGenerationRotationRequest,
	rotation: WorkflowGenerationRotation,
	workflowId: string,
): WorkflowJournalHead {
	const fence = events.at(-1);
	if (
		fence === undefined ||
		fence.eventDigest !== rotation.fenceEventDigest ||
		fence.sequence !== rotation.fenceEventSequence ||
		(fence.kind !== "store_generation_fenced" && fence.kind !== "coordinator_epoch_fenced")
	)
		throw new Error("Workflow generation predecessor fence is not bound to its authenticated rotation record.");
	const fencePayload = fence.payload;
	if (
		(fencePayload.kind !== "store_generation_fenced" && fencePayload.kind !== "coordinator_epoch_fenced") ||
		fencePayload.generationId !== request.generationId
	)
		throw new Error(
			"Workflow generation predecessor fence payload is not bound to its authenticated rotation record.",
		);
	const predecessorHead = journalEventsHead(events.slice(0, -1), request.previousEpoch, workflowId);
	if (digestObject(fence.expectedHead) !== digestObject(predecessorHead))
		throw new Error("Workflow generation predecessor fence does not continue its authenticated journal head.");
	return predecessorHead;
}

function assertSuccessorPredecessorFence(
	events: readonly WorkflowJournalEvent[],
	expected: { workflowId: string; generationId: string; head: WorkflowJournalHead },
): void {
	const fence = events.at(-1);
	if (
		fence === undefined ||
		(fence.kind !== "store_generation_fenced" && fence.kind !== "coordinator_epoch_fenced") ||
		(fence.payload.kind !== "store_generation_fenced" && fence.payload.kind !== "coordinator_epoch_fenced")
	)
		throw new Error("Successor predecessor journal is missing its authenticated terminal fence.");
	const payload = fence.payload;
	if (
		fence.workflowId !== expected.workflowId ||
		payload.workflowId !== expected.workflowId ||
		payload.generationId !== expected.generationId ||
		fence.sequence !== expected.head.sequence ||
		fence.eventDigest !== expected.head.eventDigest ||
		digestObject(payload.priorEpoch) !== digestObject(fence.epochRef) ||
		digestObject(payload.nextEpoch) !== digestObject(expected.head.epochRef)
	)
		throw new Error("Successor predecessor journal fence is not bound to the successor generation and epoch.");
	const predecessorHead = journalEventsHead(events.slice(0, -1), payload.priorEpoch, expected.workflowId);
	if (digestObject(fence.expectedHead) !== digestObject(predecessorHead))
		throw new Error("Successor predecessor journal fence does not continue its authenticated journal head.");
}

async function openGenerationJournalForReplay(
	baseOptions: WorkflowJournalOptions,
	request: WorkflowGenerationRotationRequest,
): Promise<WorkflowJournalImpl> {
	const predecessorKey = await baseOptions.keyProvider.resolve(
		baseOptions.workflowId,
		request.previousKeyId,
		request.previousEpoch,
	);
	const sourceKeyProvider = baseOptions.keyProvider;
	const replayKeyProvider: WorkflowJournalKeyProvider = {
		current: async (workflowId, epoch) => {
			if (workflowId !== baseOptions.workflowId || digestObject(epoch) !== digestObject(request.previousEpoch))
				throw new Error("Historical generation key request is outside the authenticated predecessor tuple.");
			return { ...predecessorKey };
		},
		resolve: sourceKeyProvider.resolve.bind(sourceKeyProvider),
	};
	if (sourceKeyProvider.rotateGeneration !== undefined)
		replayKeyProvider.rotateGeneration = sourceKeyProvider.rotateGeneration.bind(sourceKeyProvider);
	const descriptorContext = await openWorkflowDescriptorContext(
		baseOptions.descriptorFs,
		baseOptions.descriptorRoots,
		baseOptions.workflowId,
		replayKeyProvider,
		request.previousEpoch,
		request.previousGenerationId,
	);
	try {
		const storage = await openWorkflowJournalDurableStorage(descriptorContext);
		await assertPrivateRegularJournal(storage);
		return new WorkflowJournalImpl(
			{
				...baseOptions,
				keyProvider: replayKeyProvider,
				epoch: { ...request.nextEpoch },
				writerIdentity: request.generationBinding.writerIdentity,
				leaseRef: { ...request.nextLeaseRef },
			},
			storage,
			descriptorContext,
			createDescriptorCommitReturnProofStore(descriptorContext),
			createDescriptorGenerationRotationStore(descriptorContext),
		);
	} catch (error) {
		await descriptorContext.workflow.close().catch(() => undefined);
		await descriptorContext.root.close().catch(() => undefined);
		throw error;
	}
}

async function replayGenerationChain(
	baseJournal: WorkflowJournalImpl,
	request: WorkflowGenerationRotationRequest,
	visited: Set<string>,
): Promise<readonly WorkflowJournalEvent[]> {
	if (visited.has(request.previousGenerationId))
		throw new Error("Workflow generation rotation chain contains a cycle.");
	visited.add(request.previousGenerationId);
	const incomingRotation = await readRotationForGeneration(baseJournal.rotationStore, request.previousGenerationId);
	if (
		incomingRotation !== null &&
		((incomingRotation.state !== "committed" && incomingRotation.state !== "retired") ||
			incomingRotation.rotation === null)
	)
		throw new Error("Workflow generation predecessor rotation is not durably committed.");
	const predecessor = await openGenerationJournalForReplay(baseJournal.options, request);
	try {
		const events = await replayWorkflowEvents(predecessor);
		if (incomingRotation === null) {
			const seedHead = await readGenerationSeedHead(predecessor);
			if (seedHead.sequence !== 0 || seedHead.eventDigest !== null)
				throw new Error(
					"Workflow generation predecessor history is missing its authenticated predecessor binding.",
				);
			return events;
		}
		if (incomingRotation.rotation === null)
			throw new Error("Workflow generation predecessor rotation is not durably committed.");
		const predecessorRotation = incomingRotation.rotation;
		const priorEvents = await replayGenerationChain(baseJournal, incomingRotation.request, visited);
		const priorHead = journalHeadBeforeRotationFence(
			priorEvents,
			incomingRotation.request,
			predecessorRotation,
			baseJournal.options.workflowId,
		);
		if (digestObject(priorHead) !== digestObject(incomingRotation.expectedHead))
			throw new Error("Workflow generation predecessor history does not end at its authenticated rotation head.");
		return [...priorEvents, ...events];
	} finally {
		await predecessor.descriptorContext.workflow.close().catch(() => undefined);
		await predecessor.descriptorContext.root.close().catch(() => undefined);
	}
}

async function replayLogicalJournalHistory(journal: WorkflowJournalImpl): Promise<readonly WorkflowJournalEvent[]> {
	const currentEvents = await replayWorkflowEvents(journal);
	const rotation = await readRotationForGeneration(journal.rotationStore, journal.descriptorContext.generationId);
	if (rotation === null) {
		const seedHead = await readGenerationSeedHead(journal);
		if (seedHead.sequence !== 0 || seedHead.eventDigest !== null)
			throw new Error("Workflow generation history is missing its authenticated predecessor binding.");
		bindWorkflowGoalProjectionDurableAuthority(journal.options, journal.descriptorContext.generationId);
		updateWorkflowGoalProjectionDurableHead(
			journal,
			journalEventsHead(currentEvents, journal.options.epoch, journal.options.workflowId).eventDigest,
		);
		return currentEvents;
	}
	if ((rotation.state !== "committed" && rotation.state !== "retired") || rotation.rotation === null)
		throw new Error("Workflow generation history is not durably bound to a committed rotation.");
	const predecessorEvents = await replayGenerationChain(
		journal,
		rotation.request,
		new Set([journal.descriptorContext.generationId]),
	);
	const predecessorHead = journalHeadBeforeRotationFence(
		predecessorEvents,
		rotation.request,
		rotation.rotation,
		journal.options.workflowId,
	);
	if (digestObject(predecessorHead) !== digestObject(rotation.expectedHead))
		throw new Error("Workflow generation history does not preserve the authenticated predecessor head.");
	const events = [...predecessorEvents, ...currentEvents];
	bindWorkflowGoalProjectionDurableAuthority(journal.options, journal.descriptorContext.generationId);
	updateWorkflowGoalProjectionDurableHead(
		journal,
		journalEventsHead(events, journal.options.epoch, journal.options.workflowId).eventDigest,
	);
	return events;
}

function readAuthenticatedCurrentWorkflowHead(
	journal: WorkflowJournalImpl,
	key: WorkflowJournalKey,
	fallbackHeadDigest: string | null,
): string | null {
	const journalPath = join(
		journal.options.workflowDir,
		"generations",
		journal.descriptorContext.generationId,
		"events.log",
	);
	let bytes: Uint8Array;
	try {
		bytes = new Uint8Array(readFileSync(journalPath));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallbackHeadDigest;
		return null;
	}
	if (bytes.byteLength === 0) return fallbackHeadDigest;
	try {
		const prepared = new Map<number, { framePayload: Uint8Array; payloadBytes: Uint8Array }>();
		let committedSequence: number | null = null;
		let committedDigest: string | null = null;
		for (const frameInfo of decodeWorkflowFixedFrames(bytes, key.secret)) {
			if (frameInfo.magic !== "PWFK") throw new Error("workflow-current-head-frame-kind");
			const value = parseCanonicalJsonBytes(frameInfo.payload);
			if (!isWorkflowPersistedFrameValue(value)) throw new Error("workflow-current-head-frame-shape");
			if (
				value.workflowId !== journal.options.workflowId ||
				value.generationId !== journal.descriptorContext.generationId ||
				value.keyId !== key.keyId ||
				value.epochRef.storeEpoch !== journal.options.epoch.storeEpoch ||
				value.epochRef.coordinatorEpoch !== journal.options.epoch.coordinatorEpoch
			)
				throw new Error("workflow-current-head-frame-binding");
			assertWorkflowFixedFrameHeaderMatches(frameInfo, value);
			const payloadBytes = Uint8Array.from(value.payloadBytes);
			decodeWorkflowEventPayload(payloadBytes);
			if (
				value.eventDigest !==
				canonicalWorkflowEventDigest({
					workflowId: value.workflowId,
					sequence: value.sequence,
					payloadBytes,
					priorEventDigest: value.expectedHead.eventDigest,
					idempotencyKey: value.idempotencyKey,
					semanticBinding: value.semanticBinding,
				})
			)
				throw new Error("workflow-current-head-event-digest");
			const unsignedBytes = persistedFrameUnsignedBytes(value);
			if (
				!sameFixedHex(value.frameMac, createHmac("sha256", key.secret).update(unsignedBytes).digest("hex"), 32) ||
				!sameFixedHex(value.frameChecksum, sha256Hex(unsignedBytes).slice(0, 8), 4)
			)
				throw new Error("workflow-current-head-frame-authentication");
			if (value.frameKind === "prepared") {
				if (prepared.has(value.sequence)) throw new Error("workflow-current-head-duplicate-prepared");
				prepared.set(value.sequence, { framePayload: frameInfo.payload, payloadBytes });
				continue;
			}
			const preparedFrame = prepared.get(value.sequence);
			if (
				preparedFrame === undefined ||
				!sameBytes(preparedFrame.payloadBytes, payloadBytes) ||
				value.preparedFrameDigest !== sha256Hex(preparedFrame.framePayload) ||
				!sameFixedHex(value.recordMac, value.frameMac, 32) ||
				!sameFixedHex(value.recordChecksum, value.frameChecksum, 4) ||
				(committedSequence !== null &&
					(value.sequence !== committedSequence + 1 ||
						value.expectedHead.sequence !== committedSequence ||
						value.expectedHead.eventDigest !== committedDigest))
			)
				throw new Error("workflow-current-head-committed-chain");
			prepared.delete(value.sequence);
			committedSequence = value.sequence;
			committedDigest = value.eventDigest;
		}
		if (prepared.size !== 0) return null;
		return committedDigest;
	} catch {
		return null;
	}
}

async function authorizeWorkflowGoalProjection(
	journal: WorkflowJournalImpl,
	input: WorkflowGoalProjectionAuthorizationRequest,
): Promise<WorkflowGoalProjectionAuthorization> {
	if (!Number.isSafeInteger(input.eventSequence) || input.eventSequence < 1 || input.eventDigest.length === 0)
		throw new Error("Workflow goal projection authorization identity is incomplete.");
	const headGeneration = workflowGoalProjectionHeadGeneration(journal);
	const authorizationStartGeneration = headGeneration.value;
	const events = await replayLogicalJournalHistory(journal);
	if (headGeneration.value !== authorizationStartGeneration)
		throw new Error("Workflow goal projection authorization replay crossed a journal head change.");
	const head = journalEventsHead(events, journal.options.epoch, journal.options.workflowId);
	if (
		head.workflowId !== journal.options.workflowId ||
		digestObject(head.epochRef) !== digestObject(journal.options.epoch)
	)
		throw new Error("Workflow goal projection authorization requires the authenticated current journal head.");
	updateWorkflowGoalProjectionDurableHead(journal, head.eventDigest);
	const event = events.find(
		(candidate) => candidate.sequence === input.eventSequence && candidate.eventDigest === input.eventDigest,
	);
	// Recovery may replay a goal transition from a predecessor generation; the
	// durable-authority predicate below still binds the issued token to this
	// generation's active epoch and current head.
	if (event === undefined || event.workflowId !== journal.options.workflowId)
		throw new Error("Workflow goal projection authorization event is foreign or stale.");
	if (
		events.some(
			(candidate) =>
				candidate.sequence > event.sequence &&
				(candidate.payload.kind === "goal_binding_committed" ||
					candidate.payload.kind === "workflow_status_changed" ||
					candidate.payload.kind === "goal_projection_applied"),
		)
	)
		throw new Error("Workflow goal projection authorization is stale behind a later goal transition.");
	if (
		event.payload.kind !== "goal_binding_committed" &&
		event.payload.kind !== "workflow_status_changed" &&
		event.payload.kind !== "goal_projection_applied"
	)
		throw new Error("Workflow goal projection authorization requires an authenticated goal transition event.");
	if (event.payload.kind === "goal_binding_committed" && event.payload.workflowId !== event.workflowId)
		throw new Error("Workflow goal binding event is foreign to its authenticated journal workflow.");
	if (
		event.payload.kind === "goal_projection_applied" &&
		(event.payload.binding.workflowId !== event.workflowId ||
			event.payload.binding.eventSequence !== event.sequence ||
			event.payload.binding.storeEpoch !== event.epochRef.storeEpoch ||
			event.payload.binding.coordinatorEpoch !== event.epochRef.coordinatorEpoch)
	)
		throw new Error("Workflow goal projection event binding is not attached to its authenticated journal event.");
	if (
		event.payload.kind === "goal_projection_applied" &&
		event.payload.goalDigest !== digestObject(event.payload.goalDelta)
	)
		throw new Error("Workflow goal projection event digest does not cover its complete GoalState delta.");
	const nextGoal = applyWorkflowGoalTransition(input.expectedGoal, event.payload);
	if (input.nextGoal !== undefined && digestWorkflowGoalState(input.nextGoal) !== digestWorkflowGoalState(nextGoal))
		throw new Error("Workflow goal projection next state is not the canonical event-derived snapshot.");
	const exactNextGoal = input.nextGoal === undefined ? nextGoal : input.nextGoal;
	const issuedHeadGeneration = workflowGoalProjectionHeadGeneration(journal).value;
	const durableAuthorityKey = workflowGoalProjectionAuthorityKey(journal.options);
	const durableAuthorityGenerationId = journal.descriptorContext.generationId;
	const durableAuthorityEpochDigest = digestObject(journal.options.epoch);
	const activeGeneration = await journal.rotationStore.readActiveGeneration(journal.options.workflowId);
	const currentKey = await journal.options.keyProvider.current(journal.options.workflowId, journal.options.epoch);
	if (
		activeGeneration === null ||
		activeGeneration.generationId !== durableAuthorityGenerationId ||
		digestObject(activeGeneration.epochRef) !== durableAuthorityEpochDigest ||
		activeGeneration.keyId !== currentKey.keyId ||
		currentKey.generationId !== durableAuthorityGenerationId ||
		currentKey.validStoreEpoch !== journal.options.epoch.storeEpoch
	)
		throw new Error("Workflow goal projection authorization requires the durable active generation and epoch.");
	const durableAuthorityPath = join(journal.options.workflowDir, "side-records", "active-generation.json");
	const durableAuthorityDigest = digestObject(activeGeneration);
	return mintWorkflowGoalProjectionAuthorization({
		workflowId: event.workflowId,
		eventSequence: event.sequence,
		eventDigest: event.eventDigest,
		expectedHeadDigest: digestObject(head),
		epochDigest: digestObject(event.epochRef),
		eventKind: event.payload.kind,
		goalDeltaDigest: digestObject(event.payload.goalDelta),
		expectedGoalDigest: digestWorkflowGoalState(input.expectedGoal),
		expectedNextGoalDigest: digestWorkflowGoalState(exactNextGoal),
		headGeneration: workflowGoalProjectionHeadGeneration(journal),
		isCurrentHeadGeneration: () =>
			workflowGoalProjectionHeadGeneration(journal).value === issuedHeadGeneration &&
			journal.options.workflowId === event.workflowId,
		isCurrentDurableHead: () => {
			const current = workflowGoalProjectionDurableAuthorities.get(durableAuthorityKey);
			const durableHead = readAuthenticatedCurrentWorkflowHead(journal, currentKey, head.eventDigest);
			return current?.currentHeadDigest === head.eventDigest && durableHead === head.eventDigest;
		},
		isCurrentDurableAuthority: () => {
			const active = workflowGoalProjectionDurableAuthorities.get(durableAuthorityKey);
			if (
				active === undefined ||
				active.generationId !== durableAuthorityGenerationId ||
				active.epochDigest !== durableAuthorityEpochDigest
			)
				return false;
			try {
				const persisted = parseCanonicalJsonBytes(new Uint8Array(readFileSync(durableAuthorityPath)));
				return (
					isWorkflowActiveGenerationRecordValue(persisted) &&
					digestObject(persisted) === durableAuthorityDigest &&
					persisted.generationId === durableAuthorityGenerationId &&
					digestObject(persisted.epochRef) === durableAuthorityEpochDigest
				);
			} catch {
				return false;
			}
		},
		issuedHeadGeneration,
	});
}

async function recoverWorkflowJournal(journal: WorkflowJournalImpl): Promise<WorkflowJournalRecoveryResult> {
	return journal.options.appendLease.withExclusiveGuard(
		{
			workflowId: journal.options.workflowId,
			writerIdentity: journal.options.writerIdentity,
			leaseRef: journal.options.leaseRef,
			epochRef: journal.options.epoch,
			rootDigest: journal.descriptorContext.rootDigest,
			boundary: "recovery-read-reconcile-rotation-lease-transfer-fsync-dir-fsync",
		},
		async () => {
			try {
				await recoverWorkflowGenerationRotations(journal);
				const replay = await decodeAuthenticatedJournal(journal);
				return replay.quarantined
					? { events: [], metadata: replay.metadata, quarantined: true }
					: { events: replay.events, metadata: replay.metadata, quarantined: false };
			} catch (error) {
				if (error instanceof WorkflowJournalRecoveryError)
					return { events: [], metadata: error.metadata, quarantined: true };
				throw error;
			}
		},
	);
}

async function recoverWorkflowGenerationRotations(journal: WorkflowJournalImpl): Promise<void> {
	let unfinished: readonly WorkflowGenerationRotationRecoveryRecord[];
	try {
		unfinished = await journal.rotationStore.listUnfinished(journal.options.workflowId);
	} catch {
		let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
		try {
			bytes = await journal.storage.readJournalBytes();
		} catch {
			// The journal path remains the stable quarantine diagnostic when its bytes are unavailable.
		}
		throw new WorkflowJournalRecoveryError({
			status: "partial_frame",
			sourcePath: journal.storage.diagnosticPath,
			sourceDigest: sha256Hex(bytes),
			sourceSizeBytes: bytes.byteLength,
			sequence: null,
			epochRef: journal.options.epoch,
			reason: "rotation_fence_chain_break",
		});
	}
	if (unfinished.length === 0) return;
	if (unfinished.length > 1) {
		await quarantineDuplicateRotations(journal, unfinished);
		return;
	}
	let record = unfinished[0];
	let observed = await journal.options.appendLease.observe(journal.options.workflowId);
	let leaseState = classifyObservedRotationLease(record, observed);
	const fenceProof = await journal.returnProofStore.resolve(`return-proof:${record.request.idempotencyKey}`);
	if (record.state === "prepared") {
		if (record.priorRecordDigest === null || fenceProof.state !== "returned" || fenceProof.proof === null) {
			await quarantineUnprovenRotation(journal, record, leaseState);
			return;
		}
		if (leaseState === "previous") {
			await journal.options.appendLease.rotate({
				workflowId: journal.options.workflowId,
				expectedWriterIdentity: record.request.previousWriterIdentity,
				expectedLeaseRef: record.request.previousLeaseRef,
				nextWriterIdentity: record.request.generationBinding.writerIdentity,
				nextLeaseRef: record.request.nextLeaseRef,
			});
			observed = await journal.options.appendLease.observe(journal.options.workflowId);
			leaseState = classifyObservedRotationLease(record, observed);
		}
		if (leaseState !== "next") {
			await quarantineUnprovenRotation(journal, record, leaseState);
			return;
		}
		await journal.rotationStore.markLeaseTransferred(record.request.rotationId, {
			expectedPriorRecordDigest: record.priorRecordDigest,
			nextLeaseRef: record.request.nextLeaseRef,
			writerIdentity: record.request.generationBinding.writerIdentity,
			epochRef: record.request.nextEpoch,
		});
		record = (await journal.rotationStore.resolve(record.request.rotationId)) ?? record;
	}
	if (record.state === "lease_transferred") {
		if (
			record.priorRecordDigest === null ||
			fenceProof.state !== "returned" ||
			fenceProof.proof === null ||
			leaseState !== "next"
		) {
			await quarantineUnprovenRotation(journal, record, leaseState);
			return;
		}
		await journal.rotationStore.markFenceCommitted(record.request.rotationId, {
			recordVersion: 1,
			generationId: record.request.generationId,
			expectedPriorRecordDigest: record.priorRecordDigest,
			fenceEventSequence: fenceProof.proof.sequence,
			fenceEventDigest: fenceProof.proof.eventDigest,
			commitReturnProof: fenceProof.proof,
			keyId: record.request.keyId,
			frameMac: record.request.frameMac,
			frameChecksum: record.request.frameChecksum,
			recordMac: record.request.recordMac,
			recordChecksum: record.request.recordChecksum,
		});
		record = (await journal.rotationStore.resolve(record.request.rotationId)) ?? record;
	}
	observed = await journal.options.appendLease.observe(journal.options.workflowId);
	leaseState = classifyObservedRotationLease(record, observed);
	if ((record.state === "fence_committed" || record.state === "committed") && leaseState !== "next") {
		await quarantineUnprovenRotation(journal, record, leaseState);
		return;
	}
	const rotation = await completeProvenGenerationRotation(journal, record);
	if (record.state !== "committed") {
		await journal.rotationStore.selectActiveGenerationManifest(rotation);
		await journal.rotationStore.commit(rotation);
	}
	await openAndRebindSuccessorGeneration(journal, rotation);
	await quarantinePreviousGeneration(journal, rotation);
	bindJournalGeneration(journal, rotation);
}

function classifyRotationFailureFromDurableProof(
	record: WorkflowGenerationRotationRecoveryRecord | null,
	proof: { state: "pending" | "committed" | "returned"; proof: WorkflowCommitReturnProof | null },
	observedLease: { writerIdentity: string; leaseRef: WorkflowLeaseRef } | null,
): WorkflowGenerationRotationQuarantineReason {
	if (record === null || record.state === "prepared") return "rotation_prepared_only";
	if (
		record.state === "lease_transferred" &&
		(observedLease === null ||
			observedLease.writerIdentity !== record.request.generationBinding.writerIdentity ||
			!sameWorkflowLeaseIdentity(observedLease.leaseRef, record.request.nextLeaseRef))
	)
		return "rotation_lease_transfer_unmatched";
	if (record.state === "fence_committed" && proof.state !== "returned") return "rotation_commit_uncertain";
	if (record.state === "fence_committed" && record.fenceEventSequence === null) return "rotation_fence_chain_break";
	return "rotation_commit_uncertain";
}

async function publishAndSelectActiveGenerationManifest(
	journal: WorkflowJournalImpl,
	rotation: WorkflowGenerationRotation,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<void> {
	await journal.rotationStore.selectActiveGenerationManifest(rotation, hook);
	bindWorkflowGoalProjectionDurableAuthority(journal.options, rotation.generationId);
}

async function quarantinePreviousGeneration(
	journal: WorkflowJournalImpl,
	rotation: WorkflowGenerationRotation,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<void> {
	if (rotation.previousEpoch.storeEpoch > rotation.nextEpoch.storeEpoch)
		throw new Error("Replacement generation cannot move the store epoch backwards.");
	if (rotation.previousEpoch.storeEpoch === rotation.nextEpoch.storeEpoch) return;
	await journal.rotationStore.retirePreviousGeneration(rotation.rotationId, hook);
}

async function openAndRebindSuccessorGeneration(
	journal: WorkflowJournalImpl,
	rotation: WorkflowGenerationRotation,
): Promise<void> {
	let successor: WorkflowGenerationContext | undefined;
	try {
		successor = await journal.options.successorContextOpener.openSuccessor({
			workflowId: journal.options.workflowId,
			rootSessionId: journal.options.rootSessionId,
			rotation,
			predecessorHead: rotation.expectedHead,
			predecessorRootDigest: journal.descriptorContext.rootDigest,
		});
		const expectedHead = derivePostFenceHead(rotation);
		if (digestObject(successor.replayHead) !== digestObject(expectedHead))
			throw new Error("Successor activation did not preserve the authenticated post-fence head.");
		await journal.rebindSuccessor(successor, {
			generationId: rotation.generationId,
			epochRef: rotation.nextEpoch,
			head: expectedHead,
		});
	} catch (error) {
		if (successor !== undefined)
			await closeDescriptorContextHandles(successor.descriptorContext, journal.descriptorContext);
		throw error;
	}
}

async function rotateJournalGeneration(
	journal: WorkflowJournalImpl,
	input: WorkflowGenerationRotationRequest,
	hook?: DurableStoreCrashBoundaryHook,
): Promise<WorkflowGenerationRotation> {
	assertSafeIdentifier(input.rotationId, "rotation id");
	return withJournalLock(journal, async () => {
		return journal.options.appendLease.withExclusiveGuard(
			{
				workflowId: journal.options.workflowId,
				writerIdentity: journal.options.writerIdentity,
				leaseRef: journal.options.leaseRef,
				epochRef: journal.options.epoch,
				rootDigest: journal.descriptorContext.rootDigest,
				boundary: "rotation-recovery-lease-transfer-read-cas-write-fsync-rename-dir-fsync",
			},
			async () => {
				const assertRotationBoundary = (
					boundary: string,
					leaseRef = journal.options.leaseRef,
					epochRef = journal.options.epoch,
					writerIdentity = journal.options.writerIdentity,
				): Promise<void> =>
					journal.options.appendLease.assertOwned({
						workflowId: journal.options.workflowId,
						writerIdentity,
						leaseRef,
						epochRef,
						rootDigest: journal.descriptorContext.rootDigest,
						boundary,
					});
				await assertRotationBoundary("rotation-before-read");
				const existing = await journal.rotationStore.resolve(input.rotationId);
				if (existing?.state === "committed" && existing.rotation !== null)
					return assertIdempotentRotation(existing, input);
				if (existing !== null) throw rotationRecoveryError(existing);
				const current = await assertRotationPreconditions(journal, input);
				await assertRotationBoundary("rotation-after-head-read");
				const rotationArtifactRef = await journal.rotationStore.prepare(
					{ ...input, expectedHead: current.head },
					hook,
				);
				const returnProofId = `return-proof:${input.idempotencyKey}`;
				try {
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationPrepareBeforeFence)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await assertRotationBoundary("rotation-after-prepare");
					const fence = await appendGenerationFence(journal, input, current.head, returnProofId, hook);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationPrepareBeforeFence)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: fence.fenceEventDigest,
						});
					await assertRotationBoundary("rotation-before-lease-transfer");
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationFenceBeforeLeaseTransfer)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await journal.options.appendLease.rotate({
						workflowId: journal.options.workflowId,
						expectedWriterIdentity: input.previousWriterIdentity,
						expectedLeaseRef: input.previousLeaseRef,
						nextWriterIdentity: input.generationBinding.writerIdentity,
						nextLeaseRef: input.nextLeaseRef,
					});
					await assertRotationBoundary(
						"rotation-after-lease-transfer",
						input.nextLeaseRef,
						input.nextEpoch,
						input.generationBinding.writerIdentity,
					);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationFenceBeforeLeaseTransfer)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: fence.fenceEventDigest,
						});
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await journal.rotationStore.markLeaseTransferred(
						input.rotationId,
						{
							expectedPriorRecordDigest: current.priorRecordDigest,
							nextLeaseRef: input.nextLeaseRef,
							writerIdentity: input.generationBinding.writerIdentity,
							epochRef: input.nextEpoch,
						},
						hook,
					);
					await assertRotationBoundary(
						"rotation-after-lease-record",
						input.nextLeaseRef,
						input.nextEpoch,
						input.generationBinding.writerIdentity,
					);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationLeaseTransferBeforeRecord)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: rotationArtifactRef.digest,
						});
					if (current.priorRecordDigest === null) throw new Error("Rotation prior record digest is missing.");
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRecordBeforeManifest)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await journal.rotationStore.markFenceCommitted(
						input.rotationId,
						{
							recordVersion: input.recordVersion,
							generationId: input.generationId,
							expectedPriorRecordDigest: current.priorRecordDigest,
							...fence,
							keyId: input.keyId,
							frameMac: input.frameMac,
							frameChecksum: input.frameChecksum,
							recordMac: input.recordMac,
							recordChecksum: input.recordChecksum,
						},
						hook,
					);
					await assertRotationBoundary(
						"rotation-after-record",
						input.nextLeaseRef,
						input.nextEpoch,
						input.generationBinding.writerIdentity,
					);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRecordBeforeManifest)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: rotationArtifactRef.digest,
						});
					const rotation = createWorkflowGenerationRotationResult(
						input,
						current.head,
						"committed",
						fence.fenceEventSequence,
						fence.fenceEventDigest,
						rotationArtifactRef,
						current.priorRecordDigest,
					);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationManifestBeforeCommit)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await publishAndSelectActiveGenerationManifest(journal, rotation, hook);
					await assertRotationBoundary(
						"rotation-after-active-generation-publish",
						input.nextLeaseRef,
						input.nextEpoch,
						input.generationBinding.writerIdentity,
					);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationManifestBeforeCommit)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: rotation.activeGenerationManifestRef.digest,
						});
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationCommitBeforeRetire)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await journal.rotationStore.commit(rotation, hook);
					await assertRotationBoundary(
						"rotation-after-commit",
						input.nextLeaseRef,
						input.nextEpoch,
						input.generationBinding.writerIdentity,
					);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationCommitBeforeRetire)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: rotation.rotationArtifactRef.digest,
						});
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRetireBeforeRebind)
						await hook.before({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
						});
					await openAndRebindSuccessorGeneration(journal, rotation);
					await quarantinePreviousGeneration(journal, rotation, hook);
					bindJournalGeneration(journal, rotation);
					if (hook?.checkpoint === DurableStoreCrashBoundary.afterRotationRetireBeforeRebind)
						await hook.after({
							storeId: journal.options.workflowId,
							mutationId: input.rotationId,
							checkpoint: hook.checkpoint,
							digest: rotation.rotationArtifactRef.digest,
						});
					return rotation;
				} catch {
					const persisted = await journal.rotationStore.resolve(input.rotationId);
					const proof = await journal.returnProofStore.resolve(returnProofId);
					const observed = await journal.options.appendLease.observe(journal.options.workflowId);
					const reason = classifyRotationFailureFromDurableProof(persisted, proof, observed);
					await journal.rotationStore.quarantine(input.rotationId, reason);
					throw rotationRecoveryError({
						request: input,
						expectedHead: current.head,
						rotationArtifactRef,
						activeGenerationManifestRef: input.activeGenerationManifestRef,
						state: "quarantined",
						priorRecordDigest: current.priorRecordDigest,
						authenticatedTuple: null,
						fenceEventSequence: null,
						fenceEventDigest: null,
						commitReturnProof: null,
						rotation: null,
						quarantineReason: reason,
						lastCheckpoint: null,
						checkpointDigest: null,
						sideRecordMac: "",
					});
				}
			},
		);
	});
}
