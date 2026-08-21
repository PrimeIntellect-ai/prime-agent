import { AsyncLocalStorage } from "node:async_hooks";
import {
	createHash,
	createHmac,
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	randomUUID,
	sign as signBytes,
	timingSafeEqual,
	verify as verifyBytes,
} from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { validateAutoResearchProjectionIntent } from "../autoresearch/runtime-adapter.js";
import type { GoalState } from "../goals.js";
import type { HostRequestContext } from "../kernel/index.js";
import { registerWorkflowKnowledgeRuntimeContextAlias } from "../knowledge/knowledge-runtime-authority.js";
import { issuePrimeAdaptiveRuntimeHostAuthority } from "./adaptive-runtime.js";
import {
	approvalBindingDigest,
	createDurableApprovalManager,
	type WorkflowApprovalBindingInput,
	type WorkflowApprovalDecisionContext,
	type WorkflowApprovalInvalidation,
	type WorkflowApprovalManagerWithOutcome,
	type WorkflowApprovalSecretIssuance,
	type WorkflowApprovalStore,
	type WorkflowTrustedClock,
} from "./approvals.js";
import {
	createWorkflowCompletionGateForStore,
	type WorkflowCompletionCommitInput,
	type WorkflowCompletionGate,
	type WorkflowCompletionGateDependencies,
} from "./completion-gate.js";
import type {
	DurableApprovalSecretProof,
	DurableDecisionRef,
	DurableStoreCrashBoundaryHook,
	WorkflowApprovalDecisionRoles,
	WorkflowApprovalReceipt,
	WorkflowApprovalRequest,
	WorkflowArtifactPublishInput,
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowDecisionRef,
	WorkflowDescriptorFs,
	WorkflowDescriptorHandle,
	WorkflowEpochRef,
	WorkflowEventPayload,
	WorkflowGenerationBinding,
	WorkflowGoalMutationDelta,
	WorkflowHostPrincipalCapabilityAuthorization,
	WorkflowHostPrincipalCapabilityAuthorizationInput,
	WorkflowHostPrincipalCapabilityAuthorizer,
	WorkflowHostReceiptCapability,
	WorkflowHostReceiptCapabilityBinding,
	WorkflowHostReceiptConsumerContext,
	WorkflowHostReceiptConsumptionWitness,
	WorkflowHostReceiptResolver,
	WorkflowJournalCommit,
	WorkflowJournalEvent,
	WorkflowJournalHead,
	WorkflowLeaseRef,
	WorkflowOutboxAppendInput,
	WorkflowProjectionAdapter,
	WorkflowProjectionCasInput,
	WorkflowProjectionCasResult,
	WorkflowReceiptVerificationKeyResolver,
	WorkflowRuntimeStore,
	WorkflowSnapshotPublishInput,
	WorkflowStoreCommitInput,
	WorkflowStoreCommitResult,
	WorkflowStoreReplayInput,
	WorkflowStoreReplayResult,
	WorkflowTrustedPrincipal,
	WorkflowVerifiedHostReceipt,
} from "./contracts.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	resolveAndVerifyWorkflowHostReceipt,
	sameWorkflowLeaseIdentity,
	sha256Hex,
} from "./contracts.js";
import {
	createDefaultPrimeWorkflowProvider,
	type DefaultPrimeTaskRuntimeAuthorityFactory,
	type DefaultPrimeWorkflowProvider,
	type DefaultPrimeWorkflowProviderInput,
} from "./default-prime.js";
import type { DefaultPrimeWorkerFailureNotice, DefaultPrimeWorkerLauncher } from "./default-task-runtime.js";
import {
	bindWorkflowExecutionEvidenceSourceToHost,
	createWorkflowExecutionEvidenceAuthority,
	revokeWorkflowExecutionEvidenceSource,
	type WorkflowExecutionEvidenceSource,
} from "./execution-evidence.js";
import type {
	WorkflowAppendLease,
	WorkflowGenerationContextOpener,
	WorkflowJournalImpl,
	WorkflowJournalKey,
	WorkflowJournalKeyProvider,
	WorkflowJournalOptions,
	WorkflowJournalRecoveryInspection,
	WorkflowSessionPublicationFactory,
} from "./journal.js";
import {
	createWorkflowDescriptorRootAdapters,
	createWorkflowGenerationContextOpener,
	createWorkflowOwnerValidators,
	createWorkflowSessionPublicationFactory,
	inspectWorkflowJournalRecovery,
} from "./journal.js";
import {
	createWorkflowLearningPromotionReceiptAuthority,
	digestWorkflowLearningPromotionTransfer,
	requireWorkflowLearningPromotionDurableContext,
	type WorkflowLearningPromotionAuthoritySource,
	type WorkflowLearningPromotionReceiptCapability,
} from "./learning-promotion-authority.js";
import {
	createLocalAppendLease,
	createLocalAppendLeaseProcessIdentity,
	type LocalAppendLease,
} from "./local-append-lease.js";
import { createLocalWorkflowJournalKeyProvider } from "./local-journal-keyring.js";
import { createNodeWorkflowDescriptorFs as createNodeDescriptorFs } from "./node-descriptor-fs.js";
import {
	createPersistedWorkerModelCapabilityAdmission,
	type WorkerModelCapabilityAvailabilityResolver,
} from "./persisted-worker-model-admission.js";
import {
	createProviderFreeWorkflowPhaseHost,
	type WorkflowAcceptanceState,
	type WorkflowGoalAccountingPort,
	type WorkflowPhaseHost,
	type WorkflowPhaseHostContext,
	type WorkflowStartRequest,
} from "./phase-host.js";
import {
	createPrimeWorkflowHostAuthority,
	createPrimeWorkflowNoActiveAttemptRecovery,
	createProductionPrimeWorkflow,
	type PrimeWorkflowAuthenticatedAdapterFactory,
	type PrimeWorkflowSnapshots,
	type ProductionPrimeWorkflow,
} from "./prime-loop.js";
import type {
	WorkflowGoalAccountingRequest,
	WorkflowGoalCoordinator,
	WorkflowGoalProjectionAdapter,
} from "./projections.js";
import { createWorkflowGoalCoordinator, digestWorkflowGoalState } from "./projections.js";
import type { WorkflowRecoveryRequest } from "./recovery.js";
import { type WorkflowDeferredEventOwnerValidators, type WorkflowState, WorkflowStore } from "./reducer.js";
import {
	WorkflowRuntimeRecoveryError,
	type WorkflowRuntimeRecoveryReadiness,
	type WorkflowRuntimeRecoveryStartResult,
} from "./runtime-recovery.js";
import {
	createWorkflowRuntimeRecoveryAdapter,
	type WorkflowRuntimeRecoveryAdapter,
	type WorkflowRuntimeRecoveryAdapterInput,
} from "./runtime-recovery-adapter.js";
import { assertWorkflowRuntimeVersion, MIN_WORKFLOW_RUNTIME_VERSION } from "./runtime-store-adapter.js";
import { WorkflowRuntimeStoreBridge } from "./runtime-store-bridge.js";
import {
	normalizeWorkflowAcceptanceRequest,
	parseWorkflowGoalContract,
	snapshotWorkflowCommand,
	type WorkflowGoalAccountingInput,
	type WorkflowGoalAuthoritySource,
} from "./shell.js";
import type { WorkflowResourceLoaderPort } from "./skill-snapshots.js";
import type { WorkflowPrimeStageEvidenceAdapter } from "./task-runtime-authority.js";
import type { WorkerModelCapabilityLaunchAuthorizer } from "./worker-model-capability-gate.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEASE_TTL_MILLISECONDS = 300_000;
const LEASE_HEARTBEAT_MILLISECONDS = 60_000;
const LEASE_HEARTBEAT_RETRY_MILLISECONDS = 1_000;
const ADAPTIVE_REVIEW_POLL_MILLISECONDS = 60_000;
const GOAL_ACCOUNTING_REBASE_LIMIT = 32;
const GOAL_ACCOUNTING_SAME_HEAD_REBASE_LIMIT = 4;
const GOAL_ACCOUNTING_REBASE_DELAY_MILLISECONDS = 10;
const GOAL_ACCOUNTING_BLOCKER_RETRY_LIMIT = 4;
const ACCEPTANCE_RECORD_VERSION = 1 as const;
const ACCEPTANCE_INTENT_RECORD_VERSION = 1 as const;
const PROJECTION_RECORD_VERSION = 1 as const;

function isStaleGoalAccountingCommit(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "Workflow receipt issue tuple is stale." ||
			error.message === "Workflow GoalState transition CAS is stale." ||
			error.message === "Workflow GoalState transition head or epoch is stale." ||
			error.message === "Workflow journal expected head is stale." ||
			error.message === "workflow_append_lease_guard_timeout" ||
			error.message ===
				"Workflow store compare-and-swap precondition is stale or is not bound to the active writer and lease.")
	);
}

/** Explicit AgentSession callbacks used by a persisted workflow host. */
export type WorkflowGoalProjectionCallbacks = WorkflowGoalProjectionAdapter;

export interface WorkflowGoalAuthoritySourceMaterial {
	readonly objectGeneration: string;
	readonly bytes: Uint8Array;
	readonly parsedObjective: string;
	readonly boundaryIds: readonly string[];
	readonly gateIds: readonly string[];
}

export interface WorkflowGoalAuthoritySourceResolver {
	resolve(source: WorkflowGoalAuthoritySource): Promise<WorkflowGoalAuthoritySourceMaterial>;
}

/** Inputs required to open one persisted provider-free workflow host. */
export interface PersistedSessionWorkflowHostInput {
	readonly artifactRoot: string;
	readonly rootSessionId: string;
	readonly workflowId: string;
	readonly genesisEpoch?: WorkflowEpochRef;
	readonly goalProjection?: WorkflowGoalProjectionCallbacks;
	readonly deferredOwnerValidators?: WorkflowDeferredEventOwnerValidators;
	readonly successorContextOpener?: WorkflowGenerationContextOpener;
	readonly runtimeVersion?: string;
	readonly writerIdentity?: string;
	readonly processIdentity?: string;
	readonly now?: () => string;
	/** Delivers the host-issued one-use approval proof to the authenticated UI boundary. */
	readonly approvalSecretDelivery?: (input: {
		readonly request: WorkflowApprovalRequest;
		readonly proof: DurableApprovalSecretProof;
		/** One-use proofs bound to each structured option in the request. */
		readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
	}) => Promise<void> | void;
	/** Host-owned managers bound to the opened runtime store; no second store is accepted. */
	readonly runtimeRecoveryDependenciesFactory?: PersistedSessionWorkflowRecoveryDependenciesFactory;
	/** Immutable, authenticated config/recipe/skill snapshots required before Prime kernel wiring. */
	readonly primeWorkflowSnapshots?: PrimeWorkflowSnapshots;
	/** Host-owned adapter factory; it must bind every adapter to the opened store and current lease. */
	readonly primeWorkflowAdaptersFactory?: PrimeWorkflowAuthenticatedAdapterFactory;
	/** Canonical host ResourceLoader used by the default Prime composition. */
	/** Roots a workflow task may own paths under; absent keeps the built-in default. */
	readonly primeWorkflowWorkspacePaths?: readonly string[];
	readonly primeWorkflowResourceLoader?: WorkflowResourceLoaderPort;
	/** Authenticated evaluator that supplies durable readiness, decisions, and canonical validators. */
	readonly completionReadinessAuthorityFactory?: PersistedWorkflowCompletionReadinessAuthorityFactory;
	/** Delivers the opaque host-issued execution source directly to the bound session. */
	readonly executionEvidenceSourceDelivery?: (source: WorkflowExecutionEvidenceSource) => void;
	readonly primeWorkflowWorkerLauncher?: DefaultPrimeWorkerLauncher;
	readonly primeWorkflowWorkerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
	readonly progressWakeDelivery?: DefaultPrimeWorkflowProviderInput["scheduleProgressWake"];
	readonly beforeTaskLaunch?: DefaultPrimeWorkflowProviderInput["beforeTaskLaunch"];
	readonly workerModelCapabilityAdmission?: WorkerModelCapabilityLaunchAuthorizer;
	/** Redacted source-runtime availability used to compose the persisted admission gate. */
	readonly workerModelCapabilityAvailability?: WorkerModelCapabilityAvailabilityResolver;
	/** Generic task-runtime authority factory bound to this opened store and epoch. */
	readonly taskRuntimeAuthorityFactory?: DefaultPrimeTaskRuntimeAuthorityFactory;
	/** Prime stage/evidence adapter bound to this opened store and authenticated coordinator status. */
	readonly taskRuntimePrimeAdapter?: WorkflowPrimeStageEvidenceAdapter;
	/** Rehydrates the exact immutable goal object before start, reopen, or resume planning. */
	readonly goalAuthoritySourceResolver?: WorkflowGoalAuthoritySourceResolver;
}

/** Context used to construct recovery managers after the one runtime store is open. */
export interface PersistedSessionWorkflowRecoveryConstructionInput {
	readonly artifactRoot: string;
	readonly workflowDir: string;
	readonly rootSessionId: string;
	readonly workflowId: string;
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly journal: WorkflowJournalImpl;
	readonly appendLease: WorkflowAppendLease;
	readonly rootDigest: string;
	readonly writerIdentity: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly epochRef: WorkflowEpochRef;
	readonly runtimeVersion: string;
	readonly processIdentity: string;
	readonly now: () => string;
}

/**
 * Production seam for managers that already know how to read the canonical journal.
 * The host supplies the exact runtime store and overwrites store/workflow identity when adapting it.
 */
export type PersistedSessionWorkflowRecoveryDependenciesFactory = (
	input: PersistedSessionWorkflowRecoveryConstructionInput,
) =>
	| Omit<WorkflowRuntimeRecoveryAdapterInput, "runtimeStore" | "workflowId">
	| Promise<Omit<WorkflowRuntimeRecoveryAdapterInput, "runtimeStore" | "workflowId">>;

/** Canonical readiness and adjudication validators supplied by the workflow evaluator. */
export type PersistedWorkflowCompletionReadinessAuthority = Pick<
	WorkflowCompletionGateDependencies,
	| "resolveReadiness"
	| "resolveDigestSources"
	| "resolveDecision"
	| "validateDecision"
	| "validateEvidence"
	| "validateScorecard"
	| "validateProgress"
	| "validateResources"
>;

/** Store-bound completion evaluator returned by the authenticated composition boundary. */
export interface PersistedWorkflowCompletionReadinessAuthorityBinding {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly authority: PersistedWorkflowCompletionReadinessAuthority;
}

/** Host receipt issuer bound to the persisted workflow runtime store. */
export type PersistedWorkflowCompletionReceiptIssuer = (input: {
	readonly receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
	readonly workflowId: string;
	readonly bindingDigest: string;
	readonly capability?: WorkflowHostReceiptCapability;
	readonly resourceDigest?: string;
	readonly operationDigest?: string;
	readonly executionIdentity?: string;
	readonly sessionId?: string;
	readonly receiptId?: string;
	readonly oneUse?: boolean;
	readonly issuedAt?: string;
	readonly stateDigest?: string;
	readonly revision?: number;
	readonly metering?: PersistedWorkflowMeteringFields;
	/** Non-envelope receipts bind their payload digest to the authenticated resource they issue. */
	readonly payloadKind?: "workflow-resource-loader" | "workflow-recipe" | "workflow-learning";
	readonly payloadDigest?: string;
	readonly artifactNamespace?: "skills";
}) => Promise<WorkflowVerifiedHostReceipt>;

interface PersistedWorkflowMeteringFields {
	readonly tokenDelta: number;
	readonly wallTimeDeltaSeconds: number;
	readonly continuationDelta: number;
	readonly proofDigest: string;
}

/** Factory for the canonical completion evaluator bound to the opened runtime store. */
export type PersistedWorkflowCompletionReadinessAuthorityFactory = (input: {
	readonly runtimeStore: WorkflowRuntimeStore;
	readonly store: WorkflowStore;
	readonly workflowId: string;
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly artifactResolver: WorkflowArtifactResolver;
	readonly issueReceipt: PersistedWorkflowCompletionReceiptIssuer;
	readonly now: () => string;
}) => PersistedWorkflowCompletionReadinessAuthorityBinding;

/** Authenticated authority needed to bootstrap a persisted workflow host. */
export interface PersistedSessionWorkflowHostAuthority {
	readonly genesisEpoch: WorkflowEpochRef;
	readonly writerIdentity: string;
}

/** Inputs used to resolve an already-persisted workflow authority. */
export interface PersistedSessionWorkflowHostAuthorityInput {
	readonly artifactRoot: string;
	readonly rootSessionId: string;
	readonly workflowId: string;
}

/** A persisted phase host plus its one authenticated runtime-store bridge. */
export interface PersistedSessionWorkflowHost extends WorkflowPhaseHost {
	readonly runtimeStore: WorkflowRuntimeStore;
	/** Capability-gated host receipt transfer for accepted learning promotions. */
	readonly learningPromotionReceipts: WorkflowLearningPromotionReceiptCapability;
	/** The authenticated approval authority bound to this host's persisted runtime store. */
	readonly approvals: WorkflowApprovalManagerWithOutcome;
	readonly recovery: WorkflowRuntimeRecoveryAdapter | null;
	readonly primeWorkflow?: ProductionPrimeWorkflow;
	/** Lazily composes default Prime after the workflow has a durable authenticated head. */
	ensurePrimeWorkflow(): Promise<ProductionPrimeWorkflow | undefined>;
	readonly hostRequestHandlers?: ProductionPrimeWorkflow["hostRequestHandlers"];
	readonly resolveHostRequestCapability?: ProductionPrimeWorkflow["resolveHostRequestCapability"];
	readonly admitWorkerModel?: WorkerModelCapabilityLaunchAuthorizer;
	recoveryReadiness(): WorkflowRuntimeRecoveryReadiness;
	recoverBeforeResume(request?: WorkflowRecoveryRequest): Promise<void>;
	recoverBeforeResumeResult(request?: WorkflowRecoveryRequest): Promise<WorkflowRuntimeRecoveryStartResult>;
}

/** A factory compatible with the AgentSession workflow-host injection seam. */
export type PersistedSessionWorkflowHostFactory = (
	input: PersistedSessionWorkflowHostInput,
) => Promise<PersistedSessionWorkflowHost>;

/**
 * Resolve the authenticated epoch and writer from persisted bootstrap authority.
 *
 * Args:
 * input: Existing private session-artifact root and workflow identities.
 * Return: Authenticated bootstrap authority, or null when the workflow has not been bootstrapped.
 */
export async function resolvePersistedSessionWorkflowAuthority(
	input: PersistedSessionWorkflowHostAuthorityInput,
): Promise<PersistedSessionWorkflowHostAuthority | null> {
	if (input.rootSessionId.length === 0) throw new Error("workflow_root_session_id_unavailable");
	if (input.workflowId.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.workflowId))
		throw new Error("workflow_id_unavailable");
	const artifactRoot = await assertArtifactRoot(input.artifactRoot);
	const descriptorFs = createNodeDescriptorFs();
	const root = await descriptorFs.openRoot(artifactRoot);
	let workflows: WorkflowDescriptorHandle | null = null;
	let workflow: WorkflowDescriptorHandle | null = null;
	try {
		workflows = await openExistingDirectory(descriptorFs, root, "workflows");
		if (workflows === null) return null;
		workflow = await openExistingDirectory(descriptorFs, workflows, input.workflowId);
		if (workflow === null) return null;
		const activeBytes = await readDescriptorFileAt(descriptorFs, workflow, [
			"side-records",
			"active-generation.json",
		]);
		if (activeBytes === null) {
			const entries = await readdir(join(artifactRoot, "workflows", input.workflowId));
			if (entries.length > 0) throw new Error("workflow_persisted_authority_corrupt");
			return null;
		}
		const parsed = parseCanonicalJsonBytes(activeBytes);
		if (!sameBytes(canonicalJsonBytes(parsed), activeBytes)) throw new Error("workflow_persisted_authority_corrupt");
		const authority = parsePersistedWorkflowAuthority(parsed, input.workflowId);
		const keyProvider = createLocalWorkflowJournalKeyProvider({
			sessionArtifactRoot: artifactRoot,
			rootSessionId: input.rootSessionId,
		});
		const key = await keyProvider.resolve(input.workflowId, authority.keyId, authority.epochRef);
		if (
			key.keyId !== authority.keyId ||
			key.generationId !== authority.generationId ||
			key.validStoreEpoch !== authority.epochRef.storeEpoch
		)
			throw new Error("workflow_persisted_authority_corrupt");
		const unsigned: Record<string, unknown> = { ...authority.record, sideRecordMac: "" };
		if (!verifyHmac(key.secret, unsigned, authority.sideRecordMac))
			throw new Error("workflow_persisted_authority_corrupt");
		const rootDigest = digestObject({
			descriptorIdentity: root.identityDigest,
			workflowIdentity: workflow.identityDigest,
			workflowId: input.workflowId,
		});
		if (authority.leaseRef.rootDigest !== rootDigest) throw new Error("workflow_persisted_authority_corrupt");
		const manifestBytes = await readDescriptorFileAt(descriptorFs, workflow, [
			"generations",
			authority.generationId,
			"ACTIVE",
		]);
		if (manifestBytes === null || !sameBytes(manifestBytes, activeBytes))
			throw new Error("workflow_persisted_authority_corrupt");
		return {
			genesisEpoch: { ...authority.epochRef },
			writerIdentity: authority.writerIdentity,
		};
	} catch (error) {
		if (error instanceof Error && error.message === "workflow_persisted_authority_corrupt") throw error;
		throw new Error("workflow_persisted_authority_corrupt");
	} finally {
		await workflow?.close().catch(() => undefined);
		await workflows?.close().catch(() => undefined);
		await root.close().catch(() => undefined);
	}
}

/**
 * Open one authenticated journal, reducer, runtime bridge, and provider-free host.
 *
 * Args:
 * input: Existing session-artifact root, workflow identities, goal projection, and successor opener.
 * Return: A provider-free phase host backed by the opened durable workflow.
 */
export async function createPersistedSessionWorkflowHost(
	input: PersistedSessionWorkflowHostInput,
): Promise<PersistedSessionWorkflowHost> {
	assertWorkflowRuntimeVersion(input.runtimeVersion ?? MIN_WORKFLOW_RUNTIME_VERSION);
	const goalProjection = assertInput(input);
	const deferredOwnerValidators = input.deferredOwnerValidators ?? createDefaultDeferredOwnerValidators();
	const artifactRoot = await assertArtifactRoot(input.artifactRoot);
	const descriptorFs = createNodeDescriptorFs();
	const workflowDir = join(artifactRoot, "workflows", input.workflowId);
	await assertNoForeignWorkflow(artifactRoot, input.workflowId);
	const identities = await ensureDescriptorRoots(descriptorFs, artifactRoot, workflowDir, input.workflowId);
	const descriptorRoots = createWorkflowDescriptorRootAdapters({
		sessionArtifactRoot: artifactRoot,
		workflowDir,
		rootSessionId: input.rootSessionId,
		workflowId: input.workflowId,
		sessionIdentityDigest: identities.sessionIdentityDigest,
		workflowIdentityDigest: identities.workflowIdentityDigest,
	});
	const rootDigest = digestObject({
		descriptorIdentity: identities.sessionIdentityDigest,
		workflowIdentity: identities.workflowIdentityDigest,
		workflowId: input.workflowId,
	});
	const active = await readActiveGenerationRecord(workflowDir);
	const initialEpoch = active?.epochRef ?? input.genesisEpoch;
	if (initialEpoch === undefined) throw new Error("workflow_genesis_epoch_unavailable");
	let epoch = { ...initialEpoch };
	const writerIdentity = input.writerIdentity ?? `workflow-coordinator:${input.rootSessionId}:${input.workflowId}`;
	const processIdentity = input.processIdentity ?? createLocalAppendLeaseProcessIdentity();
	const now = input.now ?? (() => new Date().toISOString());
	const keyProvider = createLocalWorkflowJournalKeyProvider({
		sessionArtifactRoot: artifactRoot,
		rootSessionId: input.rootSessionId,
	});
	const key = await keyProvider.current(input.workflowId, epoch);
	let updateCanonicalLeaseRef: ((leaseRef: WorkflowLeaseRef) => void) | undefined;
	let leaseOperationActive = false;
	let pendingCanonicalLeaseRef: WorkflowLeaseRef | undefined;
	const localLease = createLocalAppendLease({
		sessionArtifactRoot: artifactRoot,
		rootDigest,
		storeEpoch: epoch.storeEpoch,
		secret: key.secret,
		ttlMilliseconds: LEASE_TTL_MILLISECONDS,
		clock: {
			now,
			addMilliseconds: (base, milliseconds) => new Date(Date.parse(base) + milliseconds).toISOString(),
		},
		writerIdentity,
		processIdentity,
		onLeaseRefUpdated: (workflowId, nextLeaseRef) => {
			if (workflowId !== input.workflowId) throw new Error("workflow_append_lease_workflow_mismatch");
			updateCanonicalLeaseRef?.(nextLeaseRef);
		},
	});
	const appendLease = adaptLeaseRootDigest(localLease, identities.workflowIdentityDigest, rootDigest);
	const createPublicationOptions = (
		openingEpoch: WorkflowEpochRef,
		openingWriterIdentity: string,
		openingLeaseRef: WorkflowLeaseRef,
	): WorkflowJournalOptions => ({
		artifactRoot,
		sessionArtifactRoot: artifactRoot,
		workflowDir,
		descriptorRoots,
		storeKind: "workflow",
		namespace: "session",
		storeId: `session-workflow:${input.workflowId}`,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		epoch: openingEpoch,
		writerIdentity: openingWriterIdentity,
		keyProvider,
		appendLease,
		leaseRef: openingLeaseRef,
		descriptorFs,
		ownerValidators: createWorkflowOwnerValidators(),
		now,
		successorContextOpener: input.successorContextOpener ?? {
			openSuccessor: async () => {
				throw new Error("workflow_successor_context_opener_unavailable");
			},
		},
	});
	const createPublication = async (
		openingEpoch: WorkflowEpochRef,
		openingWriterIdentity: string,
		openingLeaseRef: WorkflowLeaseRef,
	): Promise<WorkflowSessionPublicationFactory> => {
		const publication = await createWorkflowSessionPublicationFactory(
			createPublicationOptions(openingEpoch, openingWriterIdentity, openingLeaseRef),
		);
		if (input.successorContextOpener === undefined)
			publication.journal.options.successorContextOpener = createWorkflowGenerationContextOpener(
				publication.journal.options,
			);
		return publication;
	};

	let publication: WorkflowSessionPublicationFactory;
	let store: WorkflowStore;
	let leaseRef: WorkflowLeaseRef;
	const recoveryEvidence =
		active === null
			? null
			: await inspectWorkflowJournalRecovery(
					createPublicationOptions(epoch, active.leaseRef.writerIdentity, active.leaseRef),
				);
	if (recoveryEvidence !== null) {
		assertPendingRecoveryBinding(active, recoveryEvidence, rootDigest);
		const recovered = await recoverPendingRotation({
			createPublication,
			evidence: recoveryEvidence,
			localLease,
			processIdentity,
			writerIdentity,
			rootSessionId: input.rootSessionId,
			successorContextOpener: input.successorContextOpener,
			deferredOwnerValidators,
		});
		publication = recovered.publication;
		store = recovered.store;
		epoch = recovered.epoch;
		leaseRef = recovered.leaseRef;
	} else {
		const leaseResolution = await resolveLease({
			active,
			appendLease,
			workflowId: input.workflowId,
			writerIdentity,
			processIdentity,
			coordinatorEpoch: epoch.coordinatorEpoch,
		});
		leaseRef = leaseResolution.leaseRef;
		if (leaseResolution.deadOwner !== null) {
			const predecessorEpoch = {
				storeEpoch: leaseResolution.deadOwner.leaseRef.storeEpoch,
				coordinatorEpoch: leaseResolution.deadOwner.leaseRef.coordinatorEpoch,
			};
			const nextEpoch = {
				storeEpoch: predecessorEpoch.storeEpoch,
				coordinatorEpoch: predecessorEpoch.coordinatorEpoch + 1,
			};
			try {
				const recovered = await localLease.withDeadOwnerRecovery(
					{
						workflowId: input.workflowId,
						writerIdentity: leaseResolution.deadOwner.writerIdentity,
						leaseRef: leaseResolution.deadOwner.leaseRef,
						epochRef: predecessorEpoch,
						rootDigest,
						boundary: "coordinator-epoch-recovery",
					},
					async () => {
						const recoveredPublication = await createPublication(
							predecessorEpoch,
							leaseResolution.deadOwner!.writerIdentity,
							leaseResolution.deadOwner!.leaseRef,
						);
						const journalRecovery = await recoveredPublication.journal.recover();
						if (journalRecovery.quarantined)
							throw new Error(`workflow_epoch_recovery_quarantined:${journalRecovery.metadata.reason}`);
						const recoveredStore = await WorkflowStore.open(
							recoveredPublication.journal,
							input.rootSessionId,
							deferredOwnerValidators,
						);
						const recoveredState = recoveredStore.snapshot();
						// Relaxing this does not make an empty journal reopenable. A new owner needs a rebound
						// lease; the lease demands an epoch successor (assertEpochSuccessor); an epoch successor
						// needs a generation rotation; and a rotation appends coordinator_epoch_fenced, which the
						// reducer rejects as a first event because a journal must open with workflow_started. So a
						// workflow bootstrapped without a committed event cannot be reopened by any later process,
						// and the fix is to stop bootstrapping durable authority before workflow_started rather
						// than to accept a null snapshot here - which, for a non-genesis sourceHead, would be a
						// truncated journal opening silently as a fresh one.
						if (recoveredState === null) throw new Error("workflow_epoch_recovery_empty");
						const nextKey = await keyProvider.rotateGeneration({
							workflowId: input.workflowId,
							previousEpoch: predecessorEpoch,
							nextEpoch,
							rotationId: `coordinator:${input.workflowId}:${nextEpoch.coordinatorEpoch}`,
							priorHeadDigest: digestObject({
								workflowId: recoveredState.workflowId,
								sequence: recoveredState.sourceJournalSequence,
								eventDigest: recoveredState.sourceJournalDigest,
								epochRef: predecessorEpoch,
							}),
						});
						localLease.prepareSecretRotation(nextKey.secret);
						await recoveredStore.replaceCoordinatorEpoch(nextEpoch, {
							writerIdentity,
							processGenerationId: processIdentity,
							ownerIdentity: writerIdentity,
						});
						return { publication: recoveredPublication, store: recoveredStore };
					},
				);
				publication = recovered.publication;
				store = recovered.store;
				epoch = nextEpoch;
				leaseRef = publication.journal.options.leaseRef;
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? (error as { code?: unknown }).code
						: undefined;
				if (
					code === "workflow_append_lease_owned" ||
					code === "workflow_append_lease_expired" ||
					code === "workflow_append_lease_stale"
				)
					throw new Error("workflow_append_lease_foreign_owner");
				throw error;
			}
		} else {
			publication = await createPublication(epoch, writerIdentity, leaseRef);
			store = await WorkflowStore.open(publication.journal, input.rootSessionId, deferredOwnerValidators);
		}
	}
	updateCanonicalLeaseRef = (nextLeaseRef) => {
		if (leaseOperationActive) {
			pendingCanonicalLeaseRef = { ...nextLeaseRef };
			return;
		}
		publication.journal.options.leaseRef = { ...nextLeaseRef };
		leaseRef = { ...nextLeaseRef };
	};
	const acceptance = await createAcceptanceProjection({
		artifactRoot,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		workflowDir,
		descriptorFs,
		journal: publication.journal,
		keyProvider,
		appendLease,
		rootDigest,
		writerIdentity,
		state: store.snapshot(),
		goalAuthoritySourceResolver: input.goalAuthoritySourceResolver,
	});
	await acceptance.flush(store.snapshot());
	const projectionAdapter = createStatusProjectionAdapter({
		artifactRoot,
		workflowId: input.workflowId,
		workflowDir,
		descriptorFs,
		journal: publication.journal,
		appendLease,
		rootDigest,
		writerIdentity,
	});
	const runtimeStore = composeRuntimeStore(publication, store, projectionAdapter);
	const receiptAuthority = await createPersistedWorkflowReceiptAuthority({
		runtimeStore,
		store,
		artifactResolver: publication.artifacts,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		now,
	});
	const workerModelCapabilityAdmission =
		input.workerModelCapabilityAdmission ??
		(input.workerModelCapabilityAvailability === undefined
			? undefined
			: createPersistedWorkerModelCapabilityAdmission({
					runtimeStore,
					runtimeVersion: input.runtimeVersion ?? MIN_WORKFLOW_RUNTIME_VERSION,
					workflowId: input.workflowId,
					readState: () => store.reload(),
					receiptContext: receiptAuthority.receiptContext,
					issueReceipt: receiptAuthority.issue,
					availability: input.workerModelCapabilityAvailability,
					now,
				}));
	const publicRuntimeStore = createPublicWorkflowRuntimeStore(runtimeStore);
	const publicReceiptContext = freezeWorkflowHostReceiptContext(receiptAuthority.receiptContext);
	const approvals = await createPersistedWorkflowApprovalManager({
		runtimeStore,
		store,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		artifactRoot,
		descriptorFs,
		keyProvider,
		now,
		receiptAuthority,
		approvalSecretDelivery: input.approvalSecretDelivery,
	});
	const goalCoordinator = createWorkflowGoalCoordinator({
		adapter: goalProjection,
		append: async (request) => {
			const state = store.snapshot();
			const baselineDigest = digestObject(request.expectedHead);
			const generation = state?.storeEpoch ?? request.expectedEpoch.storeEpoch;
			const semanticBinding = {
				mutationId: request.idempotencyKey,
				baselineDigest,
				expectedGenerations: { workflow: generation },
				ownerId: "workflow-coordinator",
				phase: state?.phase ?? "hardening_goal",
				reducerDigest: digestObject(request.payload),
				semanticHead: {
					workflowId: request.workflowId,
					sequence: request.expectedHead.sequence,
					eventDigest: request.expectedHead.eventDigest,
					stateDigest: baselineDigest,
					epochRef: request.expectedEpoch,
					generation,
				},
				expectedHead: request.expectedHead,
				idempotencyKey: request.idempotencyKey,
				executionKey: request.executionKey,
				writerIdentity: request.writerIdentity,
				leaseRef: request.leaseRef,
				epochRef: request.expectedEpoch,
			};
			const committed = await runtimeStore.commit({
				workflowId: request.workflowId,
				payload: request.payload,
				expectedHead: request.expectedHead,
				semanticBinding,
				epochRef: request.expectedEpoch,
				leaseRef: request.leaseRef,
				idempotencyKey: request.idempotencyKey,
				writerIdentity: request.writerIdentity,
				executionKey: request.executionKey,
			});
			return {
				eventSequence: committed.commit.sequence,
				transitionDigest: committed.commit.eventDigest,
				payload: committed.payload,
			};
		},
		readCommitted: async (workflowId, idempotencyKey) => {
			const replay = await runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: publication.journal.options.epoch.storeEpoch,
			});
			const event = replay.events.find((candidate) => candidate.idempotencyKey === idempotencyKey);
			if (
				event === undefined ||
				(event.payload.kind !== "goal_binding_committed" &&
					event.payload.kind !== "workflow_status_changed" &&
					event.payload.kind !== "goal_projection_applied")
			)
				return null;
			return {
				eventSequence: event.sequence,
				transitionDigest: event.eventDigest,
				payload: event.payload,
			};
		},
		readHead: async (workflowId) => {
			const replay = await runtimeStore.replay({
				workflowId,
				fromSequence: 0,
				expectedStoreEpoch: publication.journal.options.epoch.storeEpoch,
			});
			return replay.head;
		},
		authorize: ({ eventSequence, eventDigest, expectedGoal, nextGoal }) =>
			publication.journal.authorizeGoalProjection({ eventSequence, eventDigest, expectedGoal, nextGoal }),
	});
	await recoverPersistedWorkflowCompletionIntent({
		runtimeStore,
		store,
		durable: runtimeStore.durableContext,
		workflowId: input.workflowId,
		now,
		receiptAuthority,
		goalProjection,
		goalCoordinator,
	});
	const runtimeRecovery = input.runtimeRecoveryDependenciesFactory
		? createWorkflowRuntimeRecoveryAdapter({
				...(await input.runtimeRecoveryDependenciesFactory({
					artifactRoot,
					workflowDir,
					rootSessionId: input.rootSessionId,
					workflowId: input.workflowId,
					runtimeStore: publicRuntimeStore,
					journal: publication.journal,
					appendLease,
					rootDigest,
					writerIdentity,
					leaseRef,
					epochRef: publication.journal.options.epoch,
					runtimeVersion: input.runtimeVersion ?? MIN_WORKFLOW_RUNTIME_VERSION,
					processIdentity,
					now,
				})),
				workflowId: input.workflowId,
				runtimeStore,
				writerIdentity,
				runtimeVersion: input.runtimeVersion ?? MIN_WORKFLOW_RUNTIME_VERSION,
				readActiveLeaseRef: async () => publication.journal.currentLeaseRef(),
			})
		: null;
	let defaultCompletionReadinessAuthority: PersistedWorkflowCompletionReadinessAuthority | undefined;
	const requireDefaultCompletionReadinessAuthority = (): PersistedWorkflowCompletionReadinessAuthority => {
		if (defaultCompletionReadinessAuthority === undefined)
			throw new Error("Workflow completion requires the default authenticated readiness authority.");
		return defaultCompletionReadinessAuthority;
	};
	const deferredCompletionReadinessAuthority: PersistedWorkflowCompletionReadinessAuthority = {
		resolveReadiness: (request) => requireDefaultCompletionReadinessAuthority().resolveReadiness(request),
		resolveDigestSources: (request) => requireDefaultCompletionReadinessAuthority().resolveDigestSources(request),
		resolveDecision: (request) => requireDefaultCompletionReadinessAuthority().resolveDecision(request),
		validateDecision: (decision) => requireDefaultCompletionReadinessAuthority().validateDecision(decision),
		validateEvidence: (request) => requireDefaultCompletionReadinessAuthority().validateEvidence(request),
		validateScorecard: (request) => requireDefaultCompletionReadinessAuthority().validateScorecard(request),
		validateProgress: (request) => requireDefaultCompletionReadinessAuthority().validateProgress(request),
		validateResources: (request) => requireDefaultCompletionReadinessAuthority().validateResources(request),
	};
	const completionReadinessAuthorityFactory: PersistedWorkflowCompletionReadinessAuthorityFactory =
		input.completionReadinessAuthorityFactory ??
		(({ runtimeStore: boundRuntimeStore }) => ({
			runtimeStore: boundRuntimeStore,
			authority: deferredCompletionReadinessAuthority,
		}));
	let phaseHost: WorkflowPhaseHost | undefined;
	let publicPrimeWorkflow: ProductionPrimeWorkflow | undefined;
	let ensurePrimeWorkflow: (() => Promise<ProductionPrimeWorkflow | undefined>) | undefined;
	const readLearningPromotionSource = async (): Promise<WorkflowLearningPromotionAuthoritySource | null> => {
		if (phaseHost === undefined) return null;
		const durable = runtimeStore.durableContext;
		if (durable === undefined) return null;
		const trustedNow = now();
		const lease = durable.currentLeaseRef();
		if (
			!Number.isFinite(Date.parse(trustedNow)) ||
			!Number.isFinite(Date.parse(lease.expiresAt)) ||
			Date.parse(lease.expiresAt) <= Date.parse(trustedNow)
		)
			return null;
		const status = phaseHost.status();
		if (
			status.workflowId !== input.workflowId ||
			status.status !== "active" ||
			status.stateDigest === null ||
			status.goalContract === null
		)
			return null;
		const workflow =
			publicPrimeWorkflow ?? (ensurePrimeWorkflow === undefined ? undefined : await ensurePrimeWorkflow());
		if (workflow === undefined || workflow.learning === undefined || workflow.taskGraph === undefined) return null;
		const learning = workflow.learning;
		const learningState = await learning.getState();
		const promotedReview = [...learningState.reviews]
			.reverse()
			.find(
				(review) =>
					review.status === "promoted" &&
					review.promotion !== null &&
					review.canary !== null &&
					review.redTeam !== null &&
					review.promotion.candidateId === review.candidateId,
			);
		if (promotedReview === undefined || promotedReview.promotion === null) return null;
		const candidateRecord = learningState.candidates.find(
			(record) => record.candidate.candidateId === promotedReview.candidateId,
		);
		const canary = promotedReview.canary;
		const redTeam = promotedReview.redTeam;
		if (
			candidateRecord === undefined ||
			candidateRecord.status !== "promoted" ||
			canary === null ||
			redTeam === null ||
			!canary.passed ||
			!redTeam.passed ||
			!redTeam.independent
		)
			return null;
		const replay = await runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		const state = await store.reload();
		if (
			replay.quarantined ||
			replay.head.eventDigest === null ||
			state === null ||
			state.workflowId !== input.workflowId ||
			state.status !== "active" ||
			state.sourceJournalSequence !== replay.head.sequence ||
			state.sourceJournalDigest !== replay.head.eventDigest ||
			state.storeEpoch !== durable.epochRef.storeEpoch ||
			state.coordinatorEpoch !== durable.epochRef.coordinatorEpoch ||
			status.stateDigest !== replay.head.eventDigest ||
			replay.head.epochRef.storeEpoch !== durable.epochRef.storeEpoch ||
			replay.head.epochRef.coordinatorEpoch !== durable.epochRef.coordinatorEpoch
		)
			return null;
		const promotion = promotedReview.promotion;
		const goalContract = status.goalContract;
		const goalRevisionEvent = replay.events.find(
			(event) =>
				event.payload.kind === "goal_contract_proposed" &&
				event.payload.contractDigest === goalContract.contractDigest,
		);
		if (goalRevisionEvent === undefined) return null;
		const candidate = candidateRecord.candidate;
		const proposalDigest = candidate.proposalRef.digest;
		const proposalArtifact = await publication.artifacts.resolve(candidate.proposalRef);
		if (
			!proposalArtifact.exists ||
			!proposalArtifact.envelope.immutable ||
			proposalArtifact.verifiedDigest !== candidate.proposalRef.digest ||
			proposalArtifact.verifiedSizeBytes !== candidate.proposalRef.sizeBytes ||
			proposalArtifact.bytes.byteLength !== candidate.proposalRef.sizeBytes ||
			sha256Hex(proposalArtifact.bytes) !== candidate.proposalRef.digest
		)
			return null;
		const proposal = parseCanonicalJsonBytes(proposalArtifact.bytes);
		const transferDigest = digestWorkflowLearningPromotionTransfer({
			workflowId: input.workflowId,
			candidateId: candidate.candidateId,
			proposalDigest,
			proposalRef: candidate.proposalRef,
			proposal,
		});
		const confirmationReceipt = redTeam.receipts[redTeam.receipts.length - 1];
		if (confirmationReceipt === undefined) return null;
		const provenanceRef = structuredClone(confirmationReceipt.artifactRef);
		const provenanceReceiptId = confirmationReceipt.receiptId;
		const confirmedAt = confirmationReceipt.issuedAt;
		const provenanceDigest = digestObject({
			kind: "workflow_learning_independent_confirmation_provenance",
			resultRef: redTeam.resultRef,
			evidenceRefs: redTeam.evidenceRefs,
			provenanceRef,
			provenanceReceiptId,
			confirmedAt,
		});
		return {
			schemaVersion: 1,
			workflowId: input.workflowId,
			status: "active",
			generationId: durable.generationId,
			epochRef: { ...durable.epochRef },
			trustedNow,
			stateDigest: replay.head.eventDigest,
			currentRevision: replay.head.sequence,
			goalRevision: { revision: goalRevisionEvent.sequence, digest: goalContract.contractDigest },
			inputDigest: canary.inputDigest,
			graphDigest: workflow.taskGraph.graphDigest,
			acceptedHead: structuredClone(replay.head),
			candidateId: candidate.candidateId,
			promotionId: promotion.promotionId,
			revisionId: promotion.revisionId,
			policyDigest: promotion.policyDigest,
			proposalDigest,
			proposalRef: structuredClone(candidate.proposalRef),
			transferDigest,
			acceptedStage: {
				stage: "canary",
				resultRef: structuredClone(canary.resultRef),
				resultDigest: canary.resultRef.digest,
				evidenceRefs: structuredClone(canary.evidenceRefs),
				evidenceDigest: digestObject(canary.evidenceRefs),
				accepted: true,
				hostAuthenticated: true,
				sessionId: canary.sessionId,
				executionIdentity: canary.executionIdentity,
			},
			independentConfirmation: {
				resultRef: structuredClone(redTeam.resultRef),
				resultDigest: redTeam.resultRef.digest,
				evidenceRefs: structuredClone(redTeam.evidenceRefs),
				evidenceDigest: digestObject(redTeam.evidenceRefs),
				independent: true,
				hostAuthenticated: true,
				sessionId: redTeam.sessionId,
				executionIdentity: redTeam.executionIdentity,
				provenanceRef,
				provenanceReceiptId,
				provenanceDigest,
				confirmedAt,
			},
		};
	};
	const learningPromotionReceipts = createWorkflowLearningPromotionReceiptAuthority({
		workflowId: input.workflowId,
		durableContext: requireWorkflowLearningPromotionDurableContext(runtimeStore.durableContext!),
		artifactResolver: publication.artifacts,
		receiptContext: publicReceiptContext,
		issueReceipt: (request) =>
			receiptAuthority.issue({
				...request,
				oneUse: true,
				payloadKind: "workflow-learning",
			}),
		now,
		readCurrent: readLearningPromotionSource,
	});
	const services: WorkflowPhaseHostContext["services"] & { runtimeStore: WorkflowRuntimeStore } = {
		runtimeStore,
		store,
		journal: publication.journal,
		learningPromotionReceipts,
		goal: goalCoordinator,
		goalAccounting: createPersistedWorkflowGoalAccounting({
			runtimeStore,
			store,
			workflowId: input.workflowId,
			now,
			receiptAuthority,
			goalCoordinator,
		}),
		approvals,
		completionGate: createPersistedWorkflowCompletionGate({
			runtimeStore,
			publicRuntimeStore,
			publicReceiptContext,
			store,
			workflowId: input.workflowId,
			now,
			receiptAuthority,
			goalProjection,
			goalCoordinator,
			readinessAuthorityFactory: completionReadinessAuthorityFactory,
		}),
		acceptance: acceptance.port,
		currentEpoch: () => ({ ...publication.journal.options.epoch }),
	};
	const context: WorkflowPhaseHostContext = {
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		store,
		goalProjection,
		services,
	};
	phaseHost = await createProviderFreeWorkflowPhaseHost({ persistSession: true, context });
	let leaseHeartbeatFailure: unknown;
	let leaseHeartbeatRenewal: Promise<void> | null = null;
	let leaseHeartbeat: ReturnType<typeof setInterval> | undefined;
	let leaseHeartbeatRetry: ReturnType<typeof setTimeout> | undefined;
	let leaseHeartbeatStopped = false;
	let adaptiveReviewInterval: ReturnType<typeof setInterval> | undefined;
	let adaptiveReviewFailure: unknown;
	const leaseOperationContext = new AsyncLocalStorage<{ active: boolean }>();
	let leaseOperationTail = Promise.resolve();
	const withLeaseOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
		if (leaseOperationContext.getStore()?.active === true) return operation();
		const previous = leaseOperationTail;
		let release: (() => void) | undefined;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		leaseOperationTail = previous.catch(() => undefined).then(() => current);
		await previous.catch(() => undefined);
		leaseOperationActive = true;
		const scope = { active: true };
		try {
			if (leaseHeartbeatFailure !== undefined)
				throw new Error("workflow_append_lease_heartbeat_failed", { cause: leaseHeartbeatFailure });
			return await leaseOperationContext.run(scope, operation);
		} finally {
			scope.active = false;
			leaseOperationActive = false;
			if (pendingCanonicalLeaseRef !== undefined) {
				const nextLeaseRef = pendingCanonicalLeaseRef;
				pendingCanonicalLeaseRef = undefined;
				updateCanonicalLeaseRef(nextLeaseRef);
			}
			release?.();
		}
	};
	const renewLease = (): Promise<void> => {
		if (leaseHeartbeatStopped) return Promise.resolve();
		if (leaseHeartbeatRenewal !== null) return leaseHeartbeatRenewal;
		leaseHeartbeatRenewal = appendLease
			.renew(
				input.workflowId,
				publication.journal.options.writerIdentity,
				publication.journal.options.epoch.coordinatorEpoch,
			)
			.catch((error: unknown) => {
				const leaseIsLive = Date.parse(publication.journal.currentLeaseRef().expiresAt) > Date.parse(now());
				// A renewal failure is only fatal when the lease is actually gone. While it is still
				// live, any failure is transient and retryable — the previous rule retried a guard
				// timeout but treated every other error as permanent, and because the failure is
				// never cleared, one transient fault poisoned every later lease operation for the
				// life of the workflow.
				if (leaseIsLive) {
					if (!leaseHeartbeatStopped && leaseHeartbeatRetry === undefined)
						leaseHeartbeatRetry = setTimeout(() => {
							leaseHeartbeatRetry = undefined;
							void renewLease();
						}, LEASE_HEARTBEAT_RETRY_MILLISECONDS);
					return;
				}
				leaseHeartbeatFailure = error;
				if (leaseHeartbeat !== undefined) clearInterval(leaseHeartbeat);
				if (leaseHeartbeatRetry !== undefined) clearTimeout(leaseHeartbeatRetry);
				leaseHeartbeatRetry = undefined;
			})
			.finally(() => {
				leaseHeartbeatRenewal = null;
			});
		return leaseHeartbeatRenewal;
	};
	const stopLeaseHeartbeat = (): void => {
		leaseHeartbeatStopped = true;
		if (leaseHeartbeat !== undefined) clearInterval(leaseHeartbeat);
		if (leaseHeartbeatRetry !== undefined) clearTimeout(leaseHeartbeatRetry);
		leaseHeartbeat = undefined;
		leaseHeartbeatRetry = undefined;
	};
	const stopAdaptiveReview = (): void => {
		if (adaptiveReviewInterval !== undefined) clearInterval(adaptiveReviewInterval);
		adaptiveReviewInterval = undefined;
	};
	const executionEvidenceAuthority = await createWorkflowExecutionEvidenceAuthority({
		runtimeStore: publicRuntimeStore,
		artifactResolver: publication.artifacts,
		receiptContext: publicReceiptContext,
		workflowId: input.workflowId,
		rootSessionId: input.rootSessionId,
		epochRef: publication.journal.options.epoch,
		now,
		withHostLeaseOperation: withLeaseOperation,
		readWorkflowState: () => {
			if (phaseHost === undefined) throw new Error("workflow_phase_host_not_initialized");
			return phaseHost.status();
		},
		issueReceipt: receiptAuthority.issue,
	});
	const resolvePrimeLeaseRef = async (): Promise<WorkflowLeaseRef> => publication.journal.currentLeaseRef();
	const issuePrimeReceipt = receiptAuthority.issue;
	const primeHostAuthority = createPrimeWorkflowHostAuthority({
		runtimeStore: publicRuntimeStore,
		workflowId: input.workflowId,
		artifactResolver: publication.artifacts,
		epochRef: publication.journal.options.epoch,
		writerIdentity: publication.journal.currentLeaseRef().writerIdentity,
		resolveLeaseRef: resolvePrimeLeaseRef,
		receiptContext: publicReceiptContext,
		issueReceipt: issuePrimeReceipt,
	});
	const noActiveAttemptRecovery = createPrimeWorkflowNoActiveAttemptRecovery({
		runtimeStore,
		workflowId: input.workflowId,
		epochRef: publication.journal.options.epoch,
	});
	if (input.primeWorkflowSnapshots !== undefined && input.primeWorkflowAdaptersFactory === undefined)
		throw new Error("prime_workflow_authenticated_adapter_factory_required");
	const defaultPrimeEnabled =
		input.primeWorkflowSnapshots === undefined && input.primeWorkflowAdaptersFactory === undefined;
	let defaultPrimeProvider: DefaultPrimeWorkflowProvider | undefined;
	const primeWorkflow =
		input.primeWorkflowSnapshots === undefined || input.primeWorkflowAdaptersFactory === undefined
			? undefined
			: await createProductionPrimeWorkflow({
					runtimeStore: publicRuntimeStore,
					workflowId: input.workflowId,
					rootSessionId: input.rootSessionId,
					artifactRoot,
					epochRef: publication.journal.options.epoch,
					readStatus: () => {
						if (phaseHost === undefined) throw new Error("workflow_phase_host_not_initialized");
						return phaseHost.status();
					},
					adapters: await input.primeWorkflowAdaptersFactory({
						runtimeStore: publicRuntimeStore,
						workflowId: input.workflowId,
						rootSessionId: input.rootSessionId,
						artifactResolver: publication.artifacts,
						epochRef: publication.journal.options.epoch,
						writerIdentity: publication.journal.currentLeaseRef().writerIdentity,
						resolveLeaseRef: resolvePrimeLeaseRef,
						receiptContext: publicReceiptContext,
						issueReceipt: issuePrimeReceipt,
						now,
						snapshots: input.primeWorkflowSnapshots,
						authority: primeHostAuthority,
					}),
				});
	const host = phaseHost;
	const wrapped = wrapAcceptancePersistence(
		host,
		acceptance,
		store,
		publication.journal,
		withLeaseOperation,
		now,
		async () => {
			stopLeaseHeartbeat();
			stopAdaptiveReview();
			revokeWorkflowExecutionEvidenceSource(executionEvidenceAuthority.source);
			await defaultPrimeProvider?.dispose();
		},
	);
	publicPrimeWorkflow = primeWorkflow === undefined ? undefined : protectPrimeWorkflow(primeWorkflow);
	function protectPrimeWorkflow(workflow: ProductionPrimeWorkflow): ProductionPrimeWorkflow {
		const learning = workflow.learning;
		const pipeline = workflow.pipeline;
		const executionEvidence = workflow.executionEvidence;
		const executeSkill: ProductionPrimeWorkflow["executeSkill"] = (request) =>
			withLeaseOperation(() => workflow.executeSkill(request));
		const executeSkillIteration: ProductionPrimeWorkflow["executeSkillIteration"] = (request) =>
			withLeaseOperation(() => workflow.executeSkillIteration(request));
		return Object.freeze({
			...workflow,
			runtimeStore: publicRuntimeStore,
			hostRequestHandlers: Object.freeze(
				Object.fromEntries(
					Object.entries(workflow.hostRequestHandlers).map(([requestType, handler]) => [
						requestType,
						(payload: Record<string, unknown>, requestContext?: HostRequestContext) =>
							withLeaseOperation(() => handler(payload, requestContext)),
					]),
				),
			),
			executeSkill,
			executeSkillIteration,
			...(workflow.recordSkillOutcome === undefined
				? {}
				: {
						recordSkillOutcome: (skillName: string, result: Record<string, unknown>) =>
							withLeaseOperation(() => workflow.recordSkillOutcome!(skillName, result)),
					}),
			...(learning === undefined
				? {}
				: {
						learning: Object.freeze({
							commitExperience: (request: Parameters<typeof learning.commitExperience>[0]) =>
								withLeaseOperation(() => learning.commitExperience(request)),
							typeCandidate: (request: Parameters<typeof learning.typeCandidate>[0]) =>
								withLeaseOperation(() => learning.typeCandidate(request)),
							reviewCandidate: (candidateId: string) =>
								withLeaseOperation(() => learning.reviewCandidate(candidateId)),
							handleTrigger: (trigger: Parameters<typeof learning.handleTrigger>[0]) =>
								withLeaseOperation(() => learning.handleTrigger(trigger)),
							replay: () => withLeaseOperation(() => learning.replay()),
							getState: () => withLeaseOperation(() => learning.getState()),
						}),
					}),
			...(pipeline === undefined
				? {}
				: {
						pipeline: Object.freeze({
							current: () => pipeline.current(),
							read: () => withLeaseOperation(() => pipeline.read()),
							record: (request: Parameters<typeof pipeline.record>[0]) =>
								withLeaseOperation(() => pipeline.record(request)),
						}),
					}),
			...(executionEvidence === undefined
				? {}
				: {
						executionEvidence: Object.freeze({
							read: () => withLeaseOperation(() => executionEvidence.read()),
							resolveObservation: (ref: WorkflowArtifactRef) =>
								withLeaseOperation(() => executionEvidence.resolveObservation(ref)),
							consumeObservation: (ref: WorkflowArtifactRef) =>
								withLeaseOperation(() => executionEvidence.consumeObservation(ref)),
						}),
					}),
		});
	}
	ensurePrimeWorkflow = async (): Promise<ProductionPrimeWorkflow | undefined> => {
		return withLeaseOperation(async () => {
			if (publicPrimeWorkflow !== undefined) return publicPrimeWorkflow;
			if (defaultPrimeProvider === undefined) return undefined;
			const composed = await defaultPrimeProvider.ensurePrimeWorkflow();
			publicPrimeWorkflow = protectPrimeWorkflow(composed);
			return publicPrimeWorkflow;
		});
	};
	const requireEnsurePrimeWorkflow = (): (() => Promise<ProductionPrimeWorkflow | undefined>) => {
		if (ensurePrimeWorkflow === undefined) throw new Error("prime_workflow_ensurer_not_initialized");
		return ensurePrimeWorkflow;
	};
	const lazyPrimeHandler =
		(requestType: string) => async (payload: Record<string, unknown>, context?: HostRequestContext) => {
			return withLeaseOperation(async () => {
				const workflow = await requireEnsurePrimeWorkflow()();
				if (workflow === undefined) throw new Error("prime_workflow_not_ready");
				return workflow.hostRequestHandlers[requestType](payload, context);
			});
		};
	const hostRequestHandlers = !defaultPrimeEnabled
		? publicPrimeWorkflow?.hostRequestHandlers
		: {
				"workflow.v1.autoresearch.run": lazyPrimeHandler("workflow.v1.autoresearch.run"),
				"workflow.v1.mempalace.recall": lazyPrimeHandler("workflow.v1.mempalace.recall"),
				"workflow.v1.mempalace.propose": lazyPrimeHandler("workflow.v1.mempalace.propose"),
				"workflow.v1.pipeline.record": lazyPrimeHandler("workflow.v1.pipeline.record"),
				"workflow.v1.execution_evidence.read": lazyPrimeHandler("workflow.v1.execution_evidence.read"),
				"workflow.v1.learning.review": lazyPrimeHandler("workflow.v1.learning.review"),
				"workflow.v1.learning.rollback": lazyPrimeHandler("workflow.v1.learning.rollback"),
				"workflow.v1.completion.request": lazyPrimeHandler("workflow.v1.completion.request"),
			};
	const resolveHostRequestCapability = (requestType: string) =>
		publicPrimeWorkflow?.resolveHostRequestCapability(requestType) ?? { capabilities: [] };
	const primeRecovery = () => publicPrimeWorkflow?.recovery;
	const recoveryReadiness = (): WorkflowRuntimeRecoveryReadiness => {
		const readiness =
			runtimeRecovery?.readiness() ?? primeRecovery()?.readiness() ?? noActiveAttemptRecovery.readiness();
		const primeReadiness = primeRecovery()?.readiness();
		if (primeReadiness === undefined) return readiness;
		const blockingReasons = [...new Set([...readiness.blockingReasons, ...primeReadiness.blockingReasons])];
		return { canRecover: readiness.canRecover && primeReadiness.canRecover, blockingReasons };
	};
	const recoverBeforeResumeResult = async (
		request?: WorkflowRecoveryRequest,
	): Promise<WorkflowRuntimeRecoveryStartResult> => {
		if (
			defaultPrimeProvider !== undefined &&
			publicPrimeWorkflow === undefined &&
			phaseHost.status().status === "active"
		)
			await requireEnsurePrimeWorkflow()();
		const fallbackRecovery = primeRecovery() ?? noActiveAttemptRecovery;
		const primary = runtimeRecovery
			? await runtimeRecovery.recoverBeforeResume(request)
			: request === undefined
				? await fallbackRecovery.recoverBeforeResume()
				: { status: "blocked" as const, binding: null, nonExecutionProof: null, journalHeadDigest: null };
		if (primary.status === "blocked") return primary;
		if (primeRecovery() === undefined || runtimeRecovery === undefined) return primary;
		const prime = await primeRecovery()!.recoverBeforeResume();
		if (prime.status === "blocked") return prime;
		return {
			status: "started",
			binding: primary.binding ?? prime.binding,
			nonExecutionProof: prime.nonExecutionProof ?? primary.nonExecutionProof,
			journalHeadDigest: prime.journalHeadDigest ?? primary.journalHeadDigest,
		};
	};
	const result = Object.assign(wrapped, {
		runtimeStore: publicRuntimeStore,
		approvals,
		admitWorkerModel: workerModelCapabilityAdmission,
		recovery: runtimeRecovery,
		ensurePrimeWorkflow,
		hostRequestHandlers,
		resolveHostRequestCapability,
		recoveryReadiness,
		recoverBeforeResumeResult,
		recoverBeforeResume: async (request?: WorkflowRecoveryRequest): Promise<void> => {
			const result = await recoverBeforeResumeResult(request);
			if (result.status === "blocked") throw new WorkflowRuntimeRecoveryError("workflow_recovery_blocked");
		},
	});
	Object.defineProperty(result, "primeWorkflow", {
		enumerable: true,
		configurable: false,
		get: () => publicPrimeWorkflow,
	});
	bindWorkflowExecutionEvidenceSourceToHost(executionEvidenceAuthority.source, result);
	input.executionEvidenceSourceDelivery?.(executionEvidenceAuthority.source);
	leaseHeartbeat = setInterval(() => void renewLease(), LEASE_HEARTBEAT_MILLISECONDS);
	leaseHeartbeat.unref();
	if (defaultPrimeEnabled) {
		const adaptiveAuthority = issuePrimeAdaptiveRuntimeHostAuthority(result as PersistedSessionWorkflowHost);
		defaultPrimeProvider = createDefaultPrimeWorkflowProvider({
			runtimeVersion: input.runtimeVersion ?? MIN_WORKFLOW_RUNTIME_VERSION,
			host: result as PersistedSessionWorkflowHost,
			runtimeStore: publicRuntimeStore,
			workflowId: input.workflowId,
			rootSessionId: input.rootSessionId,
			artifactRoot,
			epochRef: publication.journal.options.epoch,
			writerIdentity: publication.journal.currentLeaseRef().writerIdentity,
			artifactResolver: publication.artifacts,
			descriptorFs,
			receiptContext: publicReceiptContext,
			issueReceipt: issuePrimeReceipt,
			resolveLeaseRef: resolvePrimeLeaseRef,
			authority: primeHostAuthority,
			adaptiveAuthority,
			resourceLoader: input.primeWorkflowResourceLoader,
			...(input.primeWorkflowWorkspacePaths === undefined
				? {}
				: { workspacePaths: input.primeWorkflowWorkspacePaths }),
			readStatus: () => {
				if (phaseHost === undefined) throw new Error("workflow_phase_host_not_initialized");
				return phaseHost.status();
			},
			executionEvidence: executionEvidenceAuthority.runtime,
			workerLauncher: input.primeWorkflowWorkerLauncher,
			workerFailureDelivery: input.primeWorkflowWorkerFailureDelivery,
			scheduleProgressWake: input.progressWakeDelivery,
			withHostLeaseOperation: withLeaseOperation,
			beforeTaskLaunch: input.beforeTaskLaunch,
			taskRuntimeAuthorityFactory: input.taskRuntimeAuthorityFactory,
			taskRuntimePrimeAdapter: input.taskRuntimePrimeAdapter,
			installCompletionReadinessAuthority: (authority) => {
				if (input.completionReadinessAuthorityFactory !== undefined)
					throw new Error("default_prime_completion_authority_conflicts_with_injected_authority");
				if (defaultCompletionReadinessAuthority !== undefined && defaultCompletionReadinessAuthority !== authority)
					throw new Error("default_prime_completion_authority_already_installed");
				defaultCompletionReadinessAuthority = authority;
			},
			now,
		});
		adaptiveReviewInterval = setInterval(() => {
			const adaptiveRuntime = defaultPrimeProvider?.current()?.adaptiveRuntime;
			if (
				adaptiveRuntime === undefined ||
				adaptiveReviewFailure !== undefined ||
				phaseHost?.status().status !== "active"
			)
				return;
			void withLeaseOperation(() => adaptiveRuntime.reviewIfDue()).catch((error: unknown) => {
				if (error instanceof Error && error.message === "workflow_append_lease_guard_timeout") return;
				adaptiveReviewFailure = error;
				stopAdaptiveReview();
			});
		}, ADAPTIVE_REVIEW_POLL_MILLISECONDS);
		adaptiveReviewInterval.unref();
	}
	return result as PersistedSessionWorkflowHost;
}

/**
 * Build a host factory with fixed local opener/runtime options.
 *
 * Args:
 * dependencies: Successor opener and optional runtime identity overrides.
 * Return: Function that opens one persisted workflow host per input root.
 */
export function createDefaultPersistedSessionWorkflowHostFactory(
	dependencies: Omit<
		PersistedSessionWorkflowHostInput,
		"artifactRoot" | "rootSessionId" | "workflowId" | "goalProjection"
	>,
): PersistedSessionWorkflowHostFactory {
	return (input) => createPersistedSessionWorkflowHost({ ...dependencies, ...input });
}

export const createPersistedSessionWorkflowHostFactory = createDefaultPersistedSessionWorkflowHostFactory;

interface DescriptorIdentities {
	readonly sessionIdentityDigest: string;
	readonly workflowIdentityDigest: string;
}

interface ExistingGenerationBinding {
	readonly epochRef: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
}

interface PersistedWorkflowAuthorityRecord {
	readonly record: Record<string, unknown>;
	readonly generationId: string;
	readonly epochRef: WorkflowEpochRef;
	readonly writerIdentity: string;
	readonly leaseRef: WorkflowLeaseRef;
	readonly keyId: string;
	readonly sideRecordMac: string;
}

interface LeaseResolution {
	readonly leaseRef: WorkflowLeaseRef;
	readonly deadOwner: { readonly writerIdentity: string; readonly leaseRef: WorkflowLeaseRef } | null;
}

interface AcceptanceProjection {
	readonly port: {
		read(workflowId: string): WorkflowAcceptanceState | null;
		write(workflowId: string, state: WorkflowAcceptanceState): void;
	};
	stageStart(request: WorkflowStartRequest): Promise<void>;
	flush(state: WorkflowState | null): Promise<void>;
}

interface DurableAcceptanceRecord {
	readonly acceptance: WorkflowAcceptanceState;
	readonly head: WorkflowJournalHead;
	readonly keyId: string;
	readonly generationId: string;
}

interface DurableAcceptanceIntentRecord {
	readonly acceptance: WorkflowAcceptanceState;
	readonly baseHead: WorkflowJournalHead;
	readonly keyId: string;
	readonly generationId: string;
}

async function assertArtifactRoot(path: string): Promise<string> {
	if (!isAbsolute(path) || resolve(path) !== path) throw new Error("workflow_session_artifact_root_unavailable");
	try {
		const stats = await lstat(path);
		if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0)
			throw new Error("workflow_session_artifact_root_unavailable");
		return path;
	} catch (error) {
		if (error instanceof Error && error.message === "workflow_session_artifact_root_unavailable") throw error;
		throw new Error("workflow_session_artifact_root_unavailable");
	}
}

function assertInput(input: PersistedSessionWorkflowHostInput): WorkflowGoalProjectionCallbacks {
	if (input.artifactRoot.length === 0) throw new Error("workflow_session_artifact_root_unavailable");
	if (input.rootSessionId.length === 0) throw new Error("workflow_root_session_id_unavailable");
	if (input.workflowId.length === 0) throw new Error("workflow_id_unavailable");
	const goalProjection = input.goalProjection;
	if (
		goalProjection === undefined ||
		typeof goalProjection.read !== "function" ||
		typeof goalProjection.compareAndSwap !== "function"
	)
		throw new Error("workflow_goal_projection_unavailable");
	if (input.successorContextOpener !== undefined && typeof input.successorContextOpener.openSuccessor !== "function")
		throw new Error("workflow_successor_context_opener_unavailable");
	if (input.genesisEpoch !== undefined && !isEpochRef(input.genesisEpoch))
		throw new Error("workflow_genesis_epoch_unavailable");
	if (input.deferredOwnerValidators !== undefined && !isDeferredEventOwnerValidators(input.deferredOwnerValidators))
		throw new Error("workflow_deferred_owner_validators_unavailable");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.workflowId)) throw new Error("workflow_id_unavailable");
	return goalProjection;
}

function validateDefaultDeferredOwnerEvent(payload: WorkflowEventPayload, commit: WorkflowJournalEvent): void {
	if (
		commit.expectedHead.workflowId !== commit.workflowId ||
		commit.expectedHead.sequence + 1 !== commit.sequence ||
		commit.expectedHead.eventDigest !== commit.priorEventDigest ||
		commit.payloadDigest !== digestObject(payload)
	)
		throw new Error("workflow_deferred_owner_commit_binding_invalid");
	if ("workflowId" in payload && payload.workflowId !== commit.workflowId)
		throw new Error("workflow_deferred_owner_workflow_binding_invalid");
	if (
		"epochRef" in payload &&
		(payload.epochRef.storeEpoch !== commit.epochRef.storeEpoch ||
			payload.epochRef.coordinatorEpoch !== commit.epochRef.coordinatorEpoch)
	)
		throw new Error("workflow_deferred_owner_epoch_binding_invalid");
	if ("executionKey" in payload && payload.executionKey !== commit.executionKey)
		throw new Error("workflow_deferred_owner_execution_binding_invalid");
}

function createDefaultDeferredOwnerValidators(): WorkflowDeferredEventOwnerValidators {
	return {
		autoresearch: validateAutoResearchProjectionIntent,
		runtime: validateDefaultDeferredOwnerEvent,
		effect: validateDefaultDeferredOwnerEvent,
		recovery: validateDefaultDeferredOwnerEvent,
	};
}

async function assertNoForeignWorkflow(artifactRoot: string, workflowId: string): Promise<void> {
	try {
		const entries = await readdir(join(artifactRoot, "workflows"), { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) throw new Error("workflow_foreign_root_unavailable");
			if (entry.name !== workflowId) throw new Error("workflow_unfinished_foreign_workflow");
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
}

async function ensureDescriptorRoots(
	descriptorFs: WorkflowDescriptorFs,
	artifactRoot: string,
	workflowDir: string,
	workflowId: string,
): Promise<DescriptorIdentities> {
	const root = await descriptorFs.openRoot(artifactRoot);
	let workflows: WorkflowDescriptorHandle | undefined;
	let workflow: WorkflowDescriptorHandle | undefined;
	try {
		workflows = await openOrCreateDirectory(descriptorFs, root, "workflows");
		workflow = await openOrCreateDirectory(descriptorFs, workflows, workflowId);
		if (workflowDir !== join(artifactRoot, "workflows", workflowId))
			throw new Error("workflow_descriptor_root_binding_invalid");
		return { sessionIdentityDigest: root.identityDigest, workflowIdentityDigest: workflow.identityDigest };
	} finally {
		await workflow?.close().catch(() => undefined);
		await workflows?.close().catch(() => undefined);
		await root.close().catch(() => undefined);
	}
}

async function openOrCreateDirectory(
	descriptorFs: WorkflowDescriptorFs,
	parent: WorkflowDescriptorHandle,
	component: string,
): Promise<WorkflowDescriptorHandle> {
	try {
		return await descriptorFs.openAt(
			parent,
			component,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
			PRIVATE_DIRECTORY_MODE,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return descriptorFs.mkdirAt(parent, component, PRIVATE_DIRECTORY_MODE);
	}
}

async function openExistingDirectory(
	descriptorFs: WorkflowDescriptorFs,
	parent: WorkflowDescriptorHandle,
	component: string,
): Promise<WorkflowDescriptorHandle | null> {
	try {
		return await descriptorFs.openAt(
			parent,
			component,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
			PRIVATE_DIRECTORY_MODE,
		);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function readDescriptorFileAt(
	descriptorFs: WorkflowDescriptorFs,
	parent: WorkflowDescriptorHandle,
	components: readonly string[],
): Promise<Uint8Array | null> {
	const opened: WorkflowDescriptorHandle[] = [];
	let current = parent;
	try {
		for (const [index, component] of components.entries()) {
			const handle = await descriptorFs.openAt(
				current,
				component,
				index === components.length - 1 ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
				index === components.length - 1 ? PRIVATE_FILE_MODE : PRIVATE_DIRECTORY_MODE,
			);
			opened.push(handle);
			current = handle;
		}
		return await current.read();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	} finally {
		for (const handle of opened.reverse()) await handle.close().catch(() => undefined);
	}
}

function parsePersistedWorkflowAuthority(value: unknown, workflowId: string): PersistedWorkflowAuthorityRecord {
	if (!isRecord(value)) throw new Error("workflow_persisted_authority_corrupt");
	const generationId = value.generationId;
	const epochRef = value.epochRef;
	const generationBinding = value.generationBinding;
	const leaseRef = value.leaseRef;
	const keyId = value.keyId;
	const sideRecordMac = value.sideRecordMac;
	if (
		value.workflowId !== workflowId ||
		typeof generationId !== "string" ||
		!/^(?:generation-[0-9a-f]{32})$/.test(generationId) ||
		!isEpochRef(epochRef) ||
		!isRecord(generationBinding) ||
		typeof generationBinding.writerIdentity !== "string" ||
		generationBinding.writerIdentity.length === 0 ||
		typeof generationBinding.processGenerationId !== "string" ||
		generationBinding.processGenerationId.length === 0 ||
		typeof generationBinding.ownerIdentity !== "string" ||
		generationBinding.ownerIdentity !== generationBinding.writerIdentity ||
		!isLeaseRef(leaseRef) ||
		leaseRef.writerIdentity !== generationBinding.writerIdentity ||
		leaseRef.storeEpoch !== epochRef.storeEpoch ||
		leaseRef.coordinatorEpoch !== epochRef.coordinatorEpoch ||
		typeof keyId !== "string" ||
		typeof sideRecordMac !== "string"
	)
		throw new Error("workflow_persisted_authority_corrupt");
	return {
		record: value,
		generationId,
		epochRef,
		writerIdentity: generationBinding.writerIdentity,
		leaseRef,
		keyId,
		sideRecordMac,
	};
}

async function readActiveGenerationRecord(workflowDir: string): Promise<ExistingGenerationBinding | null> {
	try {
		const bytes = new Uint8Array(await readFile(join(workflowDir, "side-records", "active-generation.json")));
		const value = parseCanonicalJsonBytes(bytes);
		if (!sameBytes(canonicalJsonBytes(value), bytes)) throw new Error("workflow_active_generation_corrupt");
		const record = parseExistingGeneration(value);
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof Error && error.message === "workflow_active_generation_corrupt") throw error;
		throw new Error("workflow_active_generation_corrupt");
	}
}

function parseExistingGeneration(value: unknown): ExistingGenerationBinding {
	if (!isRecord(value) || !isEpochRef(value.epochRef) || !isLeaseRef(value.leaseRef))
		throw new Error("workflow_active_generation_corrupt");
	return { epochRef: value.epochRef, leaseRef: value.leaseRef };
}

async function resolveLease(input: {
	readonly active: ExistingGenerationBinding | null;
	readonly appendLease: WorkflowAppendLease;
	readonly workflowId: string;
	readonly writerIdentity: string;
	readonly processIdentity: string;
	readonly coordinatorEpoch: number;
}): Promise<LeaseResolution> {
	const observed = await input.appendLease.observe(input.workflowId);
	if (input.active === null) {
		if (observed !== null) throw new Error("workflow_unfinished_foreign_workflow");
		return {
			leaseRef: await input.appendLease.acquire(
				input.workflowId,
				input.writerIdentity,
				input.coordinatorEpoch,
				input.processIdentity,
			),
			deadOwner: null,
		};
	}
	if (observed === null) throw new Error("workflow_append_lease_missing");
	if (
		observed.writerIdentity === input.writerIdentity &&
		observed.leaseRef.processIdentity === input.processIdentity
	) {
		if (
			observed.writerIdentity !== input.active.leaseRef.writerIdentity ||
			!sameWorkflowLeaseIdentity(observed.leaseRef, input.active.leaseRef)
		)
			throw new Error("workflow_append_lease_foreign_owner");
		return { leaseRef: observed.leaseRef, deadOwner: null };
	}
	if (
		observed.writerIdentity !== input.writerIdentity ||
		observed.leaseRef.processIdentity !== input.processIdentity
	) {
		if (
			observed.writerIdentity !== input.active.leaseRef.writerIdentity ||
			!sameWorkflowLeaseIdentity(observed.leaseRef, input.active.leaseRef)
		)
			throw new Error("workflow_append_lease_foreign_owner");
		return {
			leaseRef: observed.leaseRef,
			deadOwner: { writerIdentity: observed.writerIdentity, leaseRef: observed.leaseRef },
		};
	}
	return { leaseRef: observed.leaseRef, deadOwner: null };
}

function adaptLeaseRootDigest(
	lease: LocalAppendLease,
	workflowRootDigest: string,
	fullRootDigest: string,
): WorkflowAppendLease {
	const normalize = <T extends { rootDigest: string }>(input: T): T => ({
		...input,
		rootDigest: input.rootDigest === workflowRootDigest ? fullRootDigest : input.rootDigest,
	});
	return {
		acquire: (workflowId, writerIdentity, coordinatorEpoch, processIdentity) =>
			lease.acquire(workflowId, writerIdentity, coordinatorEpoch, processIdentity),
		renew: (workflowId, writerIdentity, coordinatorEpoch) =>
			lease.renew(workflowId, writerIdentity, coordinatorEpoch),
		assertOwned: (input) => lease.assertOwned(normalize(input)),
		withExclusiveGuard: (input, operation) => lease.withExclusiveGuard(normalize(input), operation),
		observe: (workflowId) => lease.observe(workflowId),
		rotate: (input) => lease.rotate(input),
		release: (workflowId, writerIdentity, coordinatorEpoch) =>
			lease.release(workflowId, writerIdentity, coordinatorEpoch),
	};
}

function assertPendingRecoveryBinding(
	active: ExistingGenerationBinding | null,
	evidence: WorkflowJournalRecoveryInspection,
	rootDigest: string,
): void {
	if (
		active === null ||
		evidence.activeGeneration.workflowId !== evidence.workflowId ||
		evidence.activeGeneration.epochRef.storeEpoch !== active.epochRef.storeEpoch ||
		evidence.activeGeneration.epochRef.coordinatorEpoch !== active.epochRef.coordinatorEpoch ||
		digestObject(evidence.activeGeneration.leaseRef) !== digestObject(active.leaseRef) ||
		digestObject(evidence.previous.epochRef) !== digestObject(active.epochRef) ||
		digestObject(evidence.previous.leaseRef) !== digestObject(active.leaseRef) ||
		evidence.previous.rootDigest !== rootDigest ||
		evidence.successor.rootDigest !== rootDigest
	)
		throw new Error("workflow_pending_rotation_active_binding_stale");
}

async function recoverPendingRotation(input: {
	readonly createPublication: (
		openingEpoch: WorkflowEpochRef,
		openingWriterIdentity: string,
		openingLeaseRef: WorkflowLeaseRef,
	) => Promise<WorkflowSessionPublicationFactory>;
	readonly evidence: WorkflowJournalRecoveryInspection;
	readonly localLease: LocalAppendLease;
	readonly processIdentity: string;
	readonly writerIdentity: string;
	readonly rootSessionId: string;
	readonly successorContextOpener?: WorkflowGenerationContextOpener;
	readonly deferredOwnerValidators?: WorkflowDeferredEventOwnerValidators;
}): Promise<{
	readonly publication: WorkflowSessionPublicationFactory;
	readonly store: WorkflowStore;
	readonly epoch: WorkflowEpochRef;
	readonly leaseRef: WorkflowLeaseRef;
}> {
	const successorMatchesCurrent =
		input.evidence.successor.leaseRef.processIdentity === input.processIdentity &&
		input.evidence.successor.writerIdentity === input.writerIdentity;
	if (
		input.evidence.successor.leaseRef.processIdentity === input.processIdentity &&
		input.evidence.successor.writerIdentity !== input.writerIdentity &&
		input.localLease.isProcessIdentityLive(input.processIdentity)
	)
		throw new Error("workflow_append_lease_foreign_owner");
	const recoveryResult = await input.localLease.withRecoveryGuard(
		{
			workflowId: input.evidence.workflowId,
			previousLeaseRef: input.evidence.previous.leaseRef,
			nextLeaseRef: input.evidence.successor.leaseRef,
			previousSecret: input.evidence.previousKey.secret,
			nextSecret: input.evidence.successorKey.secret,
			rootDigest: input.evidence.previous.rootDigest,
			boundary: "pending-rotation-recovery",
			requireOwnerLiveness: true,
			persistAuthenticatedSecret: true,
		},
		async (observed) => {
			const successorIsCurrent =
				observed.classification === "next" &&
				successorMatchesCurrent &&
				input.localLease.isProcessIdentityLive(input.processIdentity);
			const openingWriterIdentity =
				observed.classification === "next"
					? input.evidence.successor.writerIdentity
					: input.evidence.previous.writerIdentity;
			const openingLeaseRef =
				observed.classification === "next" ? input.evidence.successor.leaseRef : input.evidence.previous.leaseRef;
			const publication = await input.createPublication(
				input.evidence.previous.epochRef,
				openingWriterIdentity,
				openingLeaseRef,
			);
			const journal = publication.journal;
			if (observed.classification === "previous") {
				input.localLease.prepareSecretRotation(input.evidence.successorKey.secret);
			} else {
				journal.options.epoch = { ...input.evidence.successor.epochRef };
				journal.options.leaseRef = { ...input.evidence.successor.leaseRef };
				journal.options.writerIdentity = input.evidence.successor.writerIdentity;
				journal.options.successorContextOpener = createWorkflowGenerationContextOpener({
					...journal.options,
					epoch: { ...input.evidence.previous.epochRef },
					leaseRef: { ...input.evidence.previous.leaseRef },
					writerIdentity: input.evidence.previous.writerIdentity,
				});
			}
			const recovered = await journal.recover();
			if (recovered.quarantined)
				throw new Error(`workflow_pending_rotation_quarantined:${recovered.metadata.reason}`);
			journal.options.successorContextOpener =
				input.successorContextOpener ?? createWorkflowGenerationContextOpener(journal.options);
			let store = await WorkflowStore.open(journal, input.rootSessionId, input.deferredOwnerValidators);
			if (!successorIsCurrent) {
				store = await rotateDeadSuccessorToCurrent({
					journal,
					store,
					localLease: input.localLease,
					writerIdentity: input.writerIdentity,
					processIdentity: input.processIdentity,
					rootSessionId: input.rootSessionId,
				});
			}
			return { publication, store, epoch: { ...journal.options.epoch }, leaseRef: { ...journal.options.leaseRef } };
		},
	);
	return {
		publication: recoveryResult.publication,
		store: recoveryResult.store,
		epoch: recoveryResult.epoch,
		leaseRef: recoveryResult.leaseRef,
	};
}

async function rotateDeadSuccessorToCurrent(input: {
	readonly journal: WorkflowJournalImpl;
	readonly store: WorkflowStore;
	readonly localLease: LocalAppendLease;
	readonly writerIdentity: string;
	readonly processIdentity: string;
	readonly rootSessionId: string;
}): Promise<WorkflowStore> {
	const state = input.store.snapshot();
	if (state === null) throw new Error("workflow_pending_rotation_empty_state");
	const previousEpoch = { ...input.journal.options.epoch };
	const previousRotation = await input.journal.rotationStore.readRotationForGeneration(
		input.journal.descriptorContext.generationId,
	);
	if (previousRotation === null || previousRotation.rotation === null)
		throw new Error("workflow_pending_rotation_successor_binding_missing");
	const nextEpoch = { storeEpoch: previousEpoch.storeEpoch, coordinatorEpoch: previousEpoch.coordinatorEpoch + 1 };
	const rotationId = `coordinator:${state.workflowId}:${nextEpoch.coordinatorEpoch}`;
	const rotateGeneration = input.journal.options.keyProvider.rotateGeneration;
	if (rotateGeneration === undefined) throw new Error("workflow_pending_rotation_successor_key_unavailable");
	const priorHeadDigest = digestObject({
		workflowId: state.workflowId,
		sequence: state.sourceJournalSequence,
		eventDigest: state.sourceJournalDigest,
		epochRef: previousEpoch,
	});
	const nextKey = await rotateGeneration.call(input.journal.options.keyProvider, {
		workflowId: state.workflowId,
		previousEpoch,
		nextEpoch,
		rotationId,
		priorHeadDigest,
	});
	input.localLease.prepareSecretRotation(nextKey.secret);
	const binding = {
		writerIdentity: input.writerIdentity,
		processGenerationId: input.processIdentity,
		ownerIdentity: input.writerIdentity,
	};
	await input.store.replaceCoordinatorEpoch(nextEpoch, binding);
	return input.store;
}

async function createAcceptanceProjection(input: {
	readonly artifactRoot: string;
	readonly workflowId: string;
	readonly rootSessionId: string;
	readonly workflowDir: string;
	readonly descriptorFs: WorkflowDescriptorFs;
	readonly journal: WorkflowJournalImpl;
	readonly keyProvider: WorkflowJournalKeyProvider;
	readonly appendLease: WorkflowAppendLease;
	readonly rootDigest: string;
	readonly writerIdentity: string;
	readonly state: WorkflowState | null;
	readonly goalAuthoritySourceResolver?: WorkflowGoalAuthoritySourceResolver;
}): Promise<AcceptanceProjection> {
	const journalEvents = await input.journal.replayLogicalHistory();
	const expectedHead = workflowHead(input.journal, journalEvents);
	if (input.state !== null && digestObject(expectedHead) !== digestObject(workflowHeadFromState(input.state)))
		throw new Error("workflow_acceptance_projection_corrupt");
	const durableRecord = await readAcceptanceRecord(
		input.workflowDir,
		input.workflowId,
		input.rootSessionId,
		input.keyProvider,
		input.journal.options.epoch,
	);
	const intent = await readAcceptanceIntent(
		input.workflowDir,
		input.workflowId,
		input.rootSessionId,
		input.keyProvider,
		input.journal.options.epoch,
	);
	let durable = durableRecord?.acceptance ?? null;
	if (input.state !== null && durable === null) {
		if (
			intent === null ||
			!isAcceptanceIntentApplied(intent, journalEvents, expectedHead, input.workflowId, input.rootSessionId)
		)
			throw new Error("workflow_acceptance_projection_missing");
		durable = cloneAcceptance(intent.acceptance);
	}
	if (input.state === null && durableRecord !== null) throw new Error("workflow_acceptance_projection_corrupt");
	await assertGoalAuthoritySourceRehydrated(durable, input.goalAuthoritySourceResolver);
	const durableHeadIsCurrent =
		durableRecord === null || digestObject(durableRecord.head) === digestObject(expectedHead);
	if (
		!durableHeadIsCurrent &&
		(durableRecord === null || !isHistoricalAcceptanceHead(durableRecord.head, journalEvents, expectedHead))
	)
		throw new Error("workflow_acceptance_projection_corrupt");
	let pending: WorkflowAcceptanceState | null =
		durableRecord === null && durable !== null
			? cloneAcceptance(durable)
			: durableRecord !== null && !durableHeadIsCurrent
				? cloneAcceptance(durableRecord.acceptance)
				: null;
	const port = {
		read: (workflowId: string): WorkflowAcceptanceState | null => {
			if (workflowId !== input.workflowId) throw new Error("workflow_acceptance_workflow_mismatch");
			return cloneAcceptance(pending ?? durable);
		},
		write: (workflowId: string, state: WorkflowAcceptanceState): void => {
			if (workflowId !== input.workflowId) throw new Error("workflow_acceptance_workflow_mismatch");
			pending = cloneAcceptance(state);
		},
	};
	return {
		port,
		stageStart: async (request) => {
			const acceptance = normalizeAcceptanceRequest(request);
			await assertGoalAuthoritySourceRehydrated(acceptance, input.goalAuthoritySourceResolver);
			const baseEvents = await input.journal.replayLogicalHistory();
			const baseHead = workflowHead(input.journal, baseEvents);
			await input.appendLease.withExclusiveGuard(
				{
					workflowId: input.workflowId,
					writerIdentity: input.writerIdentity,
					leaseRef: input.journal.currentLeaseRef(),
					epochRef: input.journal.options.epoch,
					rootDigest: input.rootDigest,
					boundary: "acceptance-projection-intent",
				},
				async () => {
					const current = await readAcceptanceIntent(
						input.workflowDir,
						input.workflowId,
						input.rootSessionId,
						input.keyProvider,
						input.journal.options.epoch,
					);
					const replacingUncommittedGenesis =
						baseHead.sequence === 0 &&
						baseHead.eventDigest === null &&
						current !== null &&
						current.baseHead.sequence === 0 &&
						current.baseHead.eventDigest === null;
					if (
						current !== null &&
						digestObject(current.acceptance) !== digestObject(acceptance) &&
						!replacingUncommittedGenesis
					)
						throw new Error("workflow_acceptance_projection_conflict");
					if (current !== null && digestObject(current.baseHead) === digestObject(baseHead)) return;
					const key = await input.keyProvider.current(input.workflowId, input.journal.options.epoch);
					const unsigned = {
						version: ACCEPTANCE_INTENT_RECORD_VERSION,
						workflowId: input.workflowId,
						rootSessionId: input.rootSessionId,
						baseHead,
						acceptance,
						keyId: key.keyId,
						generationId: key.generationId,
					};
					await writeSideRecord(
						input.descriptorFs,
						input.artifactRoot,
						input.workflowId,
						"acceptance-intent.json",
						{
							...unsigned,
							mac: hmac(key.secret, unsigned),
						},
					);
				},
			);
		},
		flush: async (state) => {
			if (state === null) {
				if (pending === null) return;
				throw new Error("workflow_acceptance_state_missing");
			}
			const nextHead = workflowHeadFromState(state);
			await input.appendLease.withExclusiveGuard(
				{
					workflowId: input.workflowId,
					writerIdentity: input.writerIdentity,
					leaseRef: input.journal.currentLeaseRef(),
					epochRef: input.journal.options.epoch,
					rootDigest: input.rootDigest,
					boundary: "acceptance-projection-cas",
				},
				async () => {
					const current = await readAcceptanceRecord(
						input.workflowDir,
						input.workflowId,
						input.rootSessionId,
						input.keyProvider,
						input.journal.options.epoch,
					);
					const next = pending ?? current?.acceptance;
					if (next === undefined) throw new Error("workflow_acceptance_projection_missing");
					if (current !== null && pending !== null && digestObject(current.acceptance) !== digestObject(next))
						throw new Error("workflow_acceptance_projection_conflict");
					if (current === null || digestObject(current.head) !== digestObject(nextHead)) {
						const key = await input.keyProvider.current(input.workflowId, input.journal.options.epoch);
						const unsigned = {
							version: ACCEPTANCE_RECORD_VERSION,
							workflowId: input.workflowId,
							rootSessionId: input.rootSessionId,
							head: nextHead,
							acceptance: next,
							keyId: key.keyId,
							generationId: key.generationId,
						};
						await writeSideRecord(input.descriptorFs, input.artifactRoot, input.workflowId, "acceptance.json", {
							...unsigned,
							mac: hmac(key.secret, unsigned),
						});
					}
					durable = next;
					pending = null;
				},
			);
		},
	};
}

async function assertGoalAuthoritySourceRehydrated(
	acceptance: WorkflowAcceptanceState | null,
	resolver: WorkflowGoalAuthoritySourceResolver | undefined,
): Promise<void> {
	const source = acceptance?.goalContract?.authoritativeSource;
	if (source === undefined) return;
	if (resolver === undefined) throw new Error("workflow_goal_source_rehydration_unavailable");
	let material: WorkflowGoalAuthoritySourceMaterial;
	try {
		material = await resolver.resolve(source);
	} catch (error) {
		throw new Error("workflow_goal_source_rehydration_unavailable", { cause: error });
	}
	if (!(material.bytes instanceof Uint8Array)) throw new Error("workflow_goal_source_rehydration_mismatch");
	if (
		material.objectGeneration !== source.objectGeneration ||
		material.bytes.byteLength !== source.objectSizeBytes ||
		sha256Hex(material.bytes) !== source.objectDigest ||
		material.parsedObjective !== source.parsedObjective ||
		digestObject(material.boundaryIds) !== digestObject(source.boundaryIds) ||
		digestObject(material.gateIds) !== digestObject(source.gateIds)
	)
		throw new Error("workflow_goal_source_rehydration_mismatch");
}

function isHistoricalAcceptanceHead(
	head: WorkflowJournalHead,
	events: readonly WorkflowJournalEvent[],
	currentHead: WorkflowJournalHead,
	allowGenesis = false,
): boolean {
	if (head.sequence < 0 || head.sequence >= currentHead.sequence) return false;
	if (head.sequence === 0) {
		if (!allowGenesis || head.eventDigest !== null || !events.every((event) => event.sequence > 0)) return false;
		if (digestObject(head.epochRef) === digestObject(currentHead.epochRef)) return true;
		const firstEvent = events[0];
		if (
			firstEvent === undefined ||
			firstEvent.expectedHead.sequence !== 0 ||
			firstEvent.expectedHead.eventDigest !== null ||
			digestObject(firstEvent.expectedHead.epochRef) !== digestObject(head.epochRef)
		)
			return false;
		return events.some(
			(event) =>
				(event.payload.kind === "coordinator_epoch_fenced" || event.payload.kind === "store_generation_fenced") &&
				digestObject(event.payload.nextEpoch) === digestObject(currentHead.epochRef),
		);
	}
	const historicalEvents = events.filter((event) => event.sequence <= head.sequence);
	return digestObject(workflowHeadFromEvents(head.workflowId, head.epochRef, historicalEvents)) === digestObject(head);
}

function isAcceptanceIntentApplied(
	intent: DurableAcceptanceIntentRecord,
	events: readonly WorkflowJournalEvent[],
	currentHead: WorkflowJournalHead,
	workflowId: string,
	rootSessionId: string,
): boolean {
	if (!isHistoricalAcceptanceHead(intent.baseHead, events, currentHead, true)) return false;
	const firstAppended = events.find((event) => event.sequence > intent.baseHead.sequence);
	return (
		firstAppended?.payload.kind === "workflow_started" &&
		firstAppended.payload.workflowId === workflowId &&
		firstAppended.payload.rootSessionId === rootSessionId
	);
}

function normalizeAcceptanceRequest(request: WorkflowStartRequest): WorkflowAcceptanceState {
	return normalizeWorkflowAcceptanceRequest(request);
}

async function readAcceptanceRecord(
	workflowDir: string,
	workflowId: string,
	rootSessionId: string,
	keyProvider: WorkflowJournalKeyProvider,
	_epoch: WorkflowEpochRef,
	expectedHead?: WorkflowJournalHead,
): Promise<DurableAcceptanceRecord | null> {
	try {
		const bytes = new Uint8Array(await readFile(join(workflowDir, "side-records", "acceptance.json")));
		const value = parseCanonicalJsonBytes(bytes);
		if (!sameBytes(canonicalJsonBytes(value), bytes) || !isRecord(value))
			throw new Error("workflow_acceptance_projection_corrupt");
		const acceptance = value.acceptance;
		const head = value.head;
		if (
			value.version !== ACCEPTANCE_RECORD_VERSION ||
			value.workflowId !== workflowId ||
			value.rootSessionId !== rootSessionId ||
			!isRecord(acceptance) ||
			!isRecord(head) ||
			!isJournalHead(head) ||
			typeof value.keyId !== "string" ||
			typeof value.generationId !== "string" ||
			typeof value.mac !== "string" ||
			!isStringArray(acceptance.acceptanceCheckIds) ||
			!isStringArray(acceptance.protectedInvariantIds) ||
			Object.keys(acceptance).some(
				(key) => key !== "acceptanceCheckIds" && key !== "protectedInvariantIds" && key !== "goalContract",
			)
		)
			throw new Error("workflow_acceptance_projection_corrupt");
		const goalContract =
			acceptance.goalContract === undefined || acceptance.goalContract === null
				? null
				: parseWorkflowGoalContract(acceptance.goalContract);
		if (expectedHead !== undefined && digestObject(head) !== digestObject(expectedHead))
			throw new Error("workflow_acceptance_projection_corrupt");
		const key = await keyProvider.resolve(workflowId, value.keyId, head.epochRef);
		assertAcceptanceKeyBinding({ keyId: value.keyId, generationId: value.generationId }, key, head.epochRef);
		const unsigned: Record<string, unknown> = { ...value };
		delete unsigned.mac;
		if (!verifyHmac(key.secret, unsigned, value.mac)) throw new Error("workflow_acceptance_projection_corrupt");
		return {
			acceptance: {
				acceptanceCheckIds: [...acceptance.acceptanceCheckIds],
				protectedInvariantIds: [...acceptance.protectedInvariantIds],
				goalContract,
			},
			head: { ...head, epochRef: { ...head.epochRef } },
			keyId: value.keyId,
			generationId: value.generationId,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof Error && error.message === "workflow_acceptance_projection_corrupt") throw error;
		throw new Error("workflow_acceptance_projection_corrupt");
	}
}

async function readAcceptanceIntent(
	workflowDir: string,
	workflowId: string,
	rootSessionId: string,
	keyProvider: WorkflowJournalKeyProvider,
	_epoch: WorkflowEpochRef,
): Promise<DurableAcceptanceIntentRecord | null> {
	try {
		const bytes = new Uint8Array(await readFile(join(workflowDir, "side-records", "acceptance-intent.json")));
		const value = parseCanonicalJsonBytes(bytes);
		if (!sameBytes(canonicalJsonBytes(value), bytes) || !isRecord(value))
			throw new Error("workflow_acceptance_projection_corrupt");
		const acceptance = value.acceptance;
		const baseHead = value.baseHead;
		if (
			value.version !== ACCEPTANCE_INTENT_RECORD_VERSION ||
			value.workflowId !== workflowId ||
			value.rootSessionId !== rootSessionId ||
			!isRecord(acceptance) ||
			!isJournalHead(baseHead) ||
			typeof value.keyId !== "string" ||
			typeof value.generationId !== "string" ||
			typeof value.mac !== "string" ||
			!isStringArray(acceptance.acceptanceCheckIds) ||
			!isStringArray(acceptance.protectedInvariantIds) ||
			Object.keys(acceptance).some(
				(key) => key !== "acceptanceCheckIds" && key !== "protectedInvariantIds" && key !== "goalContract",
			)
		)
			throw new Error("workflow_acceptance_projection_corrupt");
		const goalContract =
			acceptance.goalContract === undefined || acceptance.goalContract === null
				? null
				: parseWorkflowGoalContract(acceptance.goalContract);
		const key = await keyProvider.resolve(workflowId, value.keyId, baseHead.epochRef);
		assertAcceptanceKeyBinding({ keyId: value.keyId, generationId: value.generationId }, key, baseHead.epochRef);
		const unsigned: Record<string, unknown> = { ...value };
		delete unsigned.mac;
		if (!verifyHmac(key.secret, unsigned, value.mac)) throw new Error("workflow_acceptance_projection_corrupt");
		return {
			acceptance: {
				acceptanceCheckIds: [...acceptance.acceptanceCheckIds],
				protectedInvariantIds: [...acceptance.protectedInvariantIds],
				goalContract,
			},
			baseHead: {
				workflowId: baseHead.workflowId,
				sequence: baseHead.sequence,
				eventDigest: baseHead.eventDigest,
				epochRef: { ...baseHead.epochRef },
			},
			keyId: value.keyId,
			generationId: value.generationId,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		if (error instanceof Error && error.message === "workflow_acceptance_projection_corrupt") throw error;
		throw new Error("workflow_acceptance_projection_corrupt");
	}
}

function assertAcceptanceKeyBinding(
	value: { readonly keyId: string; readonly generationId: string },
	key: WorkflowJournalKey,
	epoch: WorkflowEpochRef,
): void {
	if (value.keyId !== key.keyId || value.generationId !== key.generationId || key.validStoreEpoch !== epoch.storeEpoch)
		throw new Error("workflow_acceptance_projection_corrupt");
}

function createStatusProjectionAdapter(input: {
	readonly artifactRoot: string;
	readonly workflowId: string;
	readonly workflowDir: string;
	readonly descriptorFs: WorkflowDescriptorFs;
	readonly journal: WorkflowJournalImpl;
	readonly appendLease: WorkflowAppendLease;
	readonly rootDigest: string;
	readonly writerIdentity: string;
}): WorkflowProjectionAdapter<"status"> {
	return {
		projectionKey: "status",
		compareAndSwap: async (casInput): Promise<WorkflowProjectionCasResult> => {
			if (casInput.projectionKey !== "status" || casInput.workflowId !== input.workflowId)
				throw new Error("workflow_status_projection_binding_invalid");
			const value = {
				version: PROJECTION_RECORD_VERSION,
				workflowId: casInput.workflowId,
				projectionKey: casInput.projectionKey,
				expectedHead: casInput.expectedHead,
				projectionDigest: casInput.projectionDigest,
				epochRef: casInput.epochRef,
				idempotencyKey: casInput.idempotencyKey,
				authenticatedTupleDigest: digestObject(casInput.authenticatedTuple),
			};
			return input.appendLease.withExclusiveGuard(
				{
					workflowId: input.workflowId,
					writerIdentity: input.writerIdentity,
					leaseRef: input.journal.currentLeaseRef(),
					epochRef: input.journal.options.epoch,
					rootDigest: input.rootDigest,
					boundary: "status-projection-cas",
				},
				async () => {
					const current = await readProjectionRecord(input.workflowDir);
					if (current !== null)
						return digestObject(current) === digestObject(value) ? "already_applied" : "conflict";
					await writeSideRecord(
						input.descriptorFs,
						input.artifactRoot,
						input.workflowId,
						"status-projection.json",
						value,
					);
					return "applied";
				},
			);
		},
	};
}

async function readProjectionRecord(workflowDir: string): Promise<Record<string, unknown> | null> {
	try {
		const bytes = new Uint8Array(await readFile(join(workflowDir, "side-records", "status-projection.json")));
		const value = parseCanonicalJsonBytes(bytes);
		if (
			!isRecord(value) ||
			!sameBytes(canonicalJsonBytes(value), bytes) ||
			value.version !== PROJECTION_RECORD_VERSION
		)
			throw new Error("workflow_status_projection_corrupt");
		return value;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function composeRuntimeStore(
	publication: WorkflowSessionPublicationFactory,
	store: WorkflowStore,
	projectionAdapter: WorkflowProjectionAdapter<"status">,
): WorkflowRuntimeStore {
	return WorkflowRuntimeStoreBridge.compose({
		store,
		journal: publication.journal,
		artifactPublisher: publication.artifacts,
		snapshotPublisher: publication.snapshots,
		outboxAppender: publication.outbox,
		projectionAdapter,
		readHead: async (): Promise<WorkflowJournalHead> => {
			const events = await publication.journal.replayLogicalHistory();
			return workflowHead(publication.journal, events);
		},
	});
}

function isRawWorkflowCompletionPayload(payload: WorkflowEventPayload): boolean {
	return (
		(payload.kind === "workflow_status_changed" && payload.status === "complete") ||
		(payload.kind === "goal_projection_applied" && payload.goalDelta.status === "complete") ||
		payload.kind === "completed"
	);
}

function createPublicWorkflowRuntimeStore(runtimeStore: WorkflowRuntimeStore): WorkflowRuntimeStore {
	const durable = runtimeStore.durableContext;
	const publicDurableContext =
		durable === undefined
			? undefined
			: Object.freeze({
					generationId: durable.generationId,
					epochRef: Object.freeze({ ...durable.epochRef }),
					currentLeaseRef: durable.currentLeaseRef.bind(durable),
					outbox: durable.outbox,
					auxiliaryStore: Object.freeze({
						read: async (name: string): Promise<Uint8Array | null> => {
							if (isReservedWorkflowHostAuxiliaryRecord(name))
								throw new Error("Workflow host auxiliary record is reserved.");
							return durable.auxiliaryStore.read(name);
						},
						write: async (name: string, bytes: Readonly<Uint8Array>): Promise<void> => {
							if (isReservedWorkflowHostAuxiliaryRecord(name))
								throw new Error("Workflow host auxiliary record is reserved.");
							await durable.auxiliaryStore.write(name, bytes);
						},
					}),
					withExclusiveLease: durable.withExclusiveLease.bind(durable),
					recoverJournal: durable.recoverJournal.bind(durable),
				});
	if (durable !== undefined && publicDurableContext !== undefined)
		registerWorkflowKnowledgeRuntimeContextAlias(runtimeStore, publicDurableContext);
	return Object.freeze({
		identity: runtimeStore.identity,
		durableContext: publicDurableContext,
		commit: async <TPayload extends WorkflowEventPayload>(
			input: WorkflowStoreCommitInput<TPayload>,
		): Promise<WorkflowStoreCommitResult<TPayload>> => {
			if (isRawWorkflowCompletionPayload(input.payload))
				throw new Error("Raw runtime-store completion requires the opaque host completion capability.");
			return runtimeStore.commit(input);
		},
		replay: (input: WorkflowStoreReplayInput): Promise<WorkflowStoreReplayResult> => runtimeStore.replay(input),
		publishArtifact: (input: WorkflowArtifactPublishInput, hook?: DurableStoreCrashBoundaryHook) =>
			runtimeStore.publishArtifact(input, hook),
		publishSnapshot: (input: WorkflowSnapshotPublishInput, hook?: DurableStoreCrashBoundaryHook) =>
			runtimeStore.publishSnapshot(input, hook),
		compareAndSwapProjection: (input: WorkflowProjectionCasInput, hook?: DurableStoreCrashBoundaryHook) =>
			runtimeStore.compareAndSwapProjection(input, hook),
		appendOutbox: (input: WorkflowOutboxAppendInput, hook?: DurableStoreCrashBoundaryHook) =>
			runtimeStore.appendOutbox(input, hook),
		replaceCoordinatorEpoch: (nextEpoch: WorkflowEpochRef, generationBinding: WorkflowGenerationBinding) =>
			runtimeStore.replaceCoordinatorEpoch(nextEpoch, generationBinding),
		replaceStoreEpoch: (nextEpoch: WorkflowEpochRef, generationBinding: WorkflowGenerationBinding) =>
			runtimeStore.replaceStoreEpoch(nextEpoch, generationBinding),
	});
}

function freezeWorkflowHostReceiptContext(
	context: WorkflowHostReceiptConsumerContext,
): WorkflowHostReceiptConsumerContext {
	return Object.freeze({
		...context,
		receiptResolver: Object.freeze(context.receiptResolver),
		keyResolver: Object.freeze(context.keyResolver),
		artifactResolver: Object.freeze(context.artifactResolver),
		principalAuthorizer: Object.freeze(context.principalAuthorizer),
		signer: context.signer === undefined ? undefined : Object.freeze(context.signer),
	});
}

function isReservedWorkflowHostAuxiliaryRecord(name: string): boolean {
	return [
		WORKFLOW_RECEIPT_KEY_RECORD,
		WORKFLOW_RECEIPT_CONSUMPTION_RECORD,
		WORKFLOW_RECEIPT_ISSUANCE_RECORD,
		WORKFLOW_RECEIPT_REVOCATION_RECORD,
		WORKFLOW_APPROVAL_AUTHORITY_RECORD,
		WORKFLOW_COMPLETION_INTENT_RECORD,
	].some((base) => name === base || name.startsWith(`${base}.`));
}

const WORKFLOW_RECEIPT_KEY_RECORD = "workflow-host-receipt-key.json";
const WORKFLOW_RECEIPT_CONSUMPTION_RECORD = "workflow-host-receipt-consumptions.json";
const WORKFLOW_RECEIPT_ISSUANCE_RECORD = "workflow-host-receipt-issuances.json";
const WORKFLOW_RECEIPT_REVOCATION_RECORD = "workflow-host-receipt-revocations.json";
const WORKFLOW_APPROVAL_AUTHORITY_RECORD = "workflow-approval-authority.json";
const WORKFLOW_COMPLETION_INTENT_RECORD = "workflow-completion-intent.json";
const WORKFLOW_HOST_RECEIPT_TTL_MILLISECONDS = 300_000;
const WORKFLOW_APPROVAL_AUTHORITY_BOUNDARY = "workflow-approval-authority";

function generationScopedAuxiliaryRecord(name: string, generationId: string): string {
	if (!/^generation-[0-9a-f]{32}$/.test(generationId)) throw new Error("Workflow auxiliary generation is invalid.");
	return `${name}.${generationId}`;
}

interface PersistedWorkflowReceiptKeyRecord {
	version: 1;
	keyId: string;
	privateKey: string;
	publicKey: string;
}

interface PersistedWorkflowReceiptConsumptionRecord {
	version: 1;
	witnesses: Record<string, WorkflowHostReceiptConsumptionWitness>;
}

interface PersistedWorkflowReceiptIssuanceIdentity {
	receiptId: string;
	workflowId: string;
	bindingDigest: string;
	capability: WorkflowHostReceiptCapability | null;
	resourceDigest: string | null;
	operationDigest: string | null;
	receiptDigest: string;
}

interface PersistedWorkflowReceiptIssuanceRecord {
	version: 1;
	receipts: Record<string, PersistedWorkflowReceiptIssuanceIdentity>;
}

interface PersistedWorkflowReceiptRevocationRecord {
	version: 1;
	receiptIds: readonly string[];
}

interface PersistedWorkflowCompletionIntentRecord {
	version: 1;
	status: "pending" | "committed";
	generationId: string;
	workflowId: string;
	grantDigest: string;
	inputStateDigest: string;
	inputSequence: number;
	epochRef: WorkflowEpochRef;
	expectedGoalDigest: string;
	goalDelta: WorkflowGoalMutationDelta;
	reason: string;
	idempotencyKey: string;
	receipts: readonly WorkflowVerifiedHostReceipt[];
	createdAt: string;
	committedAt: string | null;
	committedStateDigest: string | null;
	committedSequence: number | null;
}

interface PersistedWorkflowApprovalAuxiliaryRecord {
	version: 1;
	delivered: Record<string, string>;
	invalidations: Record<string, WorkflowApprovalInvalidation>;
}

interface PersistedWorkflowApprovalAuthorityRecord {
	version: 1;
	kind: "workflow_approval_authority";
	workflowId: string;
	generationId: string;
	epochRef: WorkflowEpochRef;
	keyId: string;
	stateDigest: string;
	state: PersistedWorkflowApprovalAuxiliaryRecord;
	sideRecordMac: string;
}

interface PersistedWorkflowReceiptAuthority {
	readonly receiptContext: WorkflowHostReceiptConsumerContext;
	readonly trustedClock: WorkflowTrustedClock;
	consume(input: {
		receipt: WorkflowVerifiedHostReceipt;
		bindingDigest: string;
		currentRevision: number;
	}): Promise<void>;
	issue(input: {
		receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
		workflowId: string;
		bindingDigest: string;
		capability?: WorkflowHostReceiptCapability;
		resourceDigest?: string;
		operationDigest?: string;
		executionIdentity?: string;
		sessionId?: string;
		oneUse?: boolean;
		issuedAt?: string;
		stateDigest?: string;
		revision?: number;
		metering?: PersistedWorkflowMeteringFields;
		payloadKind?: "workflow-resource-loader" | "workflow-recipe" | "workflow-learning";
		payloadDigest?: string;
		artifactNamespace?: "skills";
	}): Promise<WorkflowVerifiedHostReceipt>;
}

async function createPersistedWorkflowReceiptAuthority(input: {
	runtimeStore: WorkflowRuntimeStore;
	store: WorkflowStore;
	artifactResolver: WorkflowArtifactResolver;
	workflowId: string;
	rootSessionId: string;
	now: () => string;
}): Promise<PersistedWorkflowReceiptAuthority> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_receipt_authority_requires_persisted_runtime");
	const receiptKeyRecord = generationScopedAuxiliaryRecord(WORKFLOW_RECEIPT_KEY_RECORD, durable.generationId);
	const receiptConsumptionRecord = generationScopedAuxiliaryRecord(
		WORKFLOW_RECEIPT_CONSUMPTION_RECORD,
		durable.generationId,
	);
	const receiptIssuanceRecord = generationScopedAuxiliaryRecord(
		WORKFLOW_RECEIPT_ISSUANCE_RECORD,
		durable.generationId,
	);
	const receiptRevocationRecord = generationScopedAuxiliaryRecord(
		WORKFLOW_RECEIPT_REVOCATION_RECORD,
		durable.generationId,
	);
	const keyMaterial = await durable.withExclusiveLease("workflow-receipt-key-bootstrap", async () => {
		const existing = await durable.auxiliaryStore.read(receiptKeyRecord);
		if (existing !== null) return decodeWorkflowReceiptKeyRecord(existing);
		const generated = generateKeyPairSync("ed25519");
		const record: PersistedWorkflowReceiptKeyRecord = {
			version: 1,
			keyId: "workflow-host-ed25519",
			privateKey: generated.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
			publicKey: generated.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
		};
		await durable.auxiliaryStore.write(receiptKeyRecord, canonicalJsonBytes(record));
		return {
			keyId: record.keyId,
			privateKey: generated.privateKey,
			publicKey: generated.publicKey,
		};
	});
	const keyOwnerPrincipal = "workflow-host";
	const allowedCapabilities = new Set<WorkflowHostReceiptCapability>([
		"workflow_observation_process",
		"workflow_observation_dataset_receipt",
		"workflow_coordinator_status_projection",
		"workflow_checkpoint_budget_observation",
		"workflow_dispatch_capacity_attestation",
		"workflow_dispatch_path_attestation",
		"workflow_worker_model_dispatch",
		"workflow_recursive_delegation_plan",
		"workflow_decision_packet_delivery",
		"autoresearch_portfolio_frontier_admission",
		"autoresearch_portfolio_projection_commit",
		"portfolio_default_completion",
		"workflow_learning_knowledge_promotion",
		"autoresearch.legacy_scalar_provenance_import",
		"workflow_intent_red_mutation",
		"child_output_delivery_ack",
		"workflow_coordinator_obligation_scheduler",
	]);
	const currentKeyFencingDigest = (): string =>
		digestObject({ generationId: durable.generationId, epochRef: durable.epochRef });
	const revokedReceiptIds = new Set<string>();

	const keyResolver: WorkflowReceiptVerificationKeyResolver = {
		resolve: async (keyId) => {
			if (keyId !== keyMaterial.keyId) throw new Error("Workflow receipt key is not issued by this host.");
			return {
				algorithm: "ed25519",
				ownerPrincipal: keyOwnerPrincipal,
				allowedCapabilities: new Set(allowedCapabilities),
				generationId: durable.generationId,
				epochRef: { ...durable.epochRef },
				fencingDigest: currentKeyFencingDigest(),
				revoked: false,
				verify: ({ bytes, signature }) =>
					verifyBytes(null, Buffer.from(bytes), keyMaterial.publicKey, Buffer.from(signature, "base64")),
			};
		},
	};

	const readConsumptions = async (): Promise<PersistedWorkflowReceiptConsumptionRecord> => {
		const bytes = await durable.auxiliaryStore.read(receiptConsumptionRecord);
		if (bytes === null) return { version: 1, witnesses: {} };
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isPersistedWorkflowReceiptConsumptionRecord(parsed))
			throw new Error("workflow_receipt_consumption_record_corrupt");
		return parsed;
	};
	const readIssuances = async (): Promise<PersistedWorkflowReceiptIssuanceRecord> => {
		const bytes = await durable.auxiliaryStore.read(receiptIssuanceRecord);
		if (bytes === null) return { version: 1, receipts: {} };
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isPersistedWorkflowReceiptIssuanceRecord(parsed))
			throw new Error("workflow_receipt_issuance_record_corrupt");
		return parsed;
	};
	const readRevocations = async (): Promise<PersistedWorkflowReceiptRevocationRecord> => {
		const bytes = await durable.auxiliaryStore.read(receiptRevocationRecord);
		if (bytes === null) return { version: 1, receiptIds: [] };
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!isPersistedWorkflowReceiptRevocationRecord(parsed))
			throw new Error("workflow_receipt_revocation_record_corrupt");
		return parsed;
	};
	const initialRevocations = await durable.withExclusiveLease("workflow-receipt-revocation-bootstrap", async () =>
		readRevocations(),
	);
	for (const receiptId of initialRevocations.receiptIds) revokedReceiptIds.add(receiptId);
	const addRevocation = revokedReceiptIds.add.bind(revokedReceiptIds);
	const persistRevocation = async (receiptId: string): Promise<void> => {
		await durable.withExclusiveLease("workflow-receipt-revocation", async () => {
			const record = await readRevocations();
			if (!record.receiptIds.includes(receiptId)) {
				await durable.auxiliaryStore.write(
					receiptRevocationRecord,
					canonicalJsonBytes({ version: 1, receiptIds: [...record.receiptIds, receiptId].sort() }),
				);
			}
		});
	};
	revokedReceiptIds.add = (receiptId: string): Set<string> => {
		addRevocation(receiptId);
		void persistRevocation(receiptId);
		return revokedReceiptIds;
	};
	const revokeReceipt = async (receiptId: string): Promise<void> => {
		if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(receiptId))
			throw new Error("Workflow receipt revocation identity is invalid.");
		await persistRevocation(receiptId);
		addRevocation(receiptId);
	};
	const receiptResolver: WorkflowHostReceiptResolver = {
		resolve: async (resolveInput) => {
			const receipt = resolveInput.receipt;
			const key = await keyResolver.resolve(receipt.keyId);
			const issuedAt = Date.parse(receipt.issuedAt);
			const validUntil = Date.parse(receipt.validUntil);
			const trustedNow = Date.parse(resolveInput.trustedNow);
			const invalidFields = [
				...(receipt.workflowId !== resolveInput.workflowId ? ["workflow"] : []),
				...(receipt.bindingDigest !== resolveInput.expectedBindingDigest ? ["binding"] : []),
				...(!isDigestString(receipt.bindingDigest) ? ["binding_digest"] : []),
				...(receipt.stateDigest !== resolveInput.currentStateDigest ? ["state"] : []),
				...(receipt.revision !== resolveInput.currentRevision ? ["revision"] : []),
				...(receipt.issuerId !== key.ownerPrincipal ? ["issuer"] : []),
				...(!Number.isFinite(issuedAt) || !Number.isFinite(validUntil) || validUntil <= issuedAt
					? ["validity"]
					: []),
				...(!Number.isFinite(trustedNow) || trustedNow < issuedAt || trustedNow >= validUntil ? ["freshness"] : []),
				...(revokedReceiptIds.has(receipt.receiptId) ? ["revocation"] : []),
				...(receipt.signatureAlgorithm !== "ed25519" ? ["signature_algorithm"] : []),
				...(typeof receipt.oneUse !== "boolean" ? ["one_use"] : []),
				...(key.revoked ? ["key_revocation"] : []),
				...(key.generationId !== durable.generationId ? ["key_generation"] : []),
				...(key.epochRef.storeEpoch !== durable.epochRef.storeEpoch ||
				key.epochRef.coordinatorEpoch !== durable.epochRef.coordinatorEpoch
					? ["key_epoch"]
					: []),
				...(key.fencingDigest !== currentKeyFencingDigest() ? ["key_fence"] : []),
			];
			if (invalidFields.length > 0)
				throw new Error(`Workflow host receipt failed authenticated fields: ${invalidFields.join(", ")}.`);
			const parsed = parseCanonicalJsonBytes(resolveInput.artifactBytes);
			if (
				!isRecord(parsed) ||
				parsed.kind !== "workflow-host-receipt" ||
				parsed.workflowId !== receipt.workflowId ||
				parsed.receiptKind !== receipt.receiptKind ||
				parsed.bindingDigest !== receipt.bindingDigest ||
				parsed.stateDigest !== receipt.stateDigest ||
				parsed.revision !== receipt.revision ||
				parsed.issuedAt !== receipt.issuedAt ||
				parsed.validUntil !== receipt.validUntil ||
				parsed.payloadDigest !== receipt.payloadDigest ||
				(receipt.capabilityBinding !== undefined &&
					(!isWorkflowReceiptCapabilityBinding(parsed.capabilityBinding) ||
						digestObject(parsed.capabilityBinding) !== digestObject(receipt.capabilityBinding))) ||
				receipt.artifactBytesDigest !== sha256Hex(resolveInput.artifactBytes) ||
				receipt.artifactRef.digest !== receipt.artifactBytesDigest ||
				receipt.artifactRef.sizeBytes !== resolveInput.artifactBytes.byteLength ||
				receipt.artifactRef.sourceEventSequence !== receipt.revision ||
				receipt.verificationDigest !== digestObject({ ...receipt, verificationDigest: "" })
			)
				throw new Error("Workflow host receipt artifact is not bound to its signed receipt.");
			const expectedPayloadDigest =
				parsed.payloadKind === "workflow-resource-loader"
					? parsed.loaderResultDigest
					: parsed.payloadKind === "workflow-recipe"
						? parsed.recipePayloadDigest
						: parsed.payloadKind === "workflow-learning"
							? parsed.learningPayloadDigest
							: digestObject({
									kind: parsed.kind,
									workflowId: parsed.workflowId,
									receiptKind: parsed.receiptKind,
									bindingDigest: parsed.bindingDigest,
									stateDigest: parsed.stateDigest,
									revision: parsed.revision,
									issuedAt: parsed.issuedAt,
									validUntil: parsed.validUntil,
									...(parsed.capabilityBinding === undefined
										? {}
										: { capabilityBinding: parsed.capabilityBinding }),
								});
			if (
				parsed.payloadKind === "workflow-resource-loader" &&
				(typeof parsed.loaderResultDigest !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.loaderResultDigest))
			)
				throw new Error("Workflow ResourceLoader receipt payload digest is invalid.");
			if (
				parsed.payloadKind === "workflow-recipe" &&
				(typeof parsed.recipePayloadDigest !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.recipePayloadDigest))
			)
				throw new Error("Workflow recipe receipt payload digest is invalid.");
			if (
				parsed.payloadKind === "workflow-learning" &&
				(typeof parsed.learningPayloadDigest !== "string" || !/^[0-9a-f]{64}$/u.test(parsed.learningPayloadDigest))
			)
				throw new Error("Workflow learning receipt payload digest is invalid.");
			if (parsed.payloadDigest !== expectedPayloadDigest)
				throw new Error("Workflow host receipt artifact payload digest is invalid.");
			const signedFields = { ...receipt };
			delete (signedFields as { signature?: string }).signature;
			delete (signedFields as { verificationDigest?: string }).verificationDigest;
			if (!key.verify({ bytes: canonicalJsonBytes(signedFields), signature: receipt.signature }))
				throw new Error("Workflow host receipt signature is invalid.");
			return structuredClone(receipt);
		},
		consumeIfOneUse: async (consumeInput) => {
			if (
				consumeInput.receipt.workflowId !== consumeInput.workflowId ||
				consumeInput.receipt.bindingDigest !== consumeInput.expectedBindingDigest
			)
				throw new Error("Workflow host receipt is not bound to the current consumption tuple.");
			if (!consumeInput.receipt.oneUse) return;
			await durable.withExclusiveLease("workflow-receipt-consume", async () => {
				const currentState = await input.store.reload();
				const currentDurable = input.runtimeStore.durableContext;
				if (currentState === null || currentDurable === undefined)
					throw new Error("Workflow host receipt consumption requires current durable workflow state.");
				const replay = await input.runtimeStore.replay({
					workflowId: input.workflowId,
					fromSequence: 0,
					expectedStoreEpoch: currentDurable.epochRef.storeEpoch,
				});
				const lease = currentDurable.currentLeaseRef();
				const verified = await resolveAndVerifyWorkflowHostReceipt({
					context: receiptContext,
					workflowId: input.workflowId,
					expectedBindingDigest: consumeInput.expectedBindingDigest,
					receipt: consumeInput.receipt,
					currentStateDigest: consumeInput.receipt.stateDigest,
					currentRevision: consumeInput.receipt.revision,
					trustedNow: input.now(),
				});
				const artifact = await input.artifactResolver.resolve(verified.artifactRef);
				const artifactPayload = parseCanonicalJsonBytes(artifact.bytes);
				const payloadBoundReceipt =
					isRecord(artifactPayload) &&
					(artifactPayload.payloadKind === "workflow-resource-loader" ||
						artifactPayload.payloadKind === "workflow-recipe" ||
						artifactPayload.payloadKind === "workflow-learning");
				if (
					replay.quarantined ||
					replay.head.eventDigest === null ||
					currentState.sourceJournalDigest !== replay.head.eventDigest ||
					currentState.sourceJournalSequence !== replay.head.sequence ||
					currentState.storeEpoch !== currentDurable.epochRef.storeEpoch ||
					currentState.coordinatorEpoch !== currentDurable.epochRef.coordinatorEpoch ||
					consumeInput.currentRevision !== verified.revision ||
					(!payloadBoundReceipt &&
						(verified.stateDigest !== currentState.sourceJournalDigest ||
							verified.revision !== currentState.sourceJournalSequence)) ||
					Date.parse(lease.expiresAt) <= Date.parse(input.now())
				)
					throw new Error("Workflow host receipt consumption tuple is stale or unauthenticated.");
				const record = await readConsumptions();
				const existing = record.witnesses[verified.receiptId];
				const binding = verified.capabilityBinding;
				const receiptDigest = digestObject(verified);
				const identity = {
					workflowId: input.workflowId,
					bindingDigest: consumeInput.expectedBindingDigest,
					capability: binding?.capability ?? null,
					resourceDigest: binding?.resourceDigest ?? null,
					operationDigest: binding?.operationDigest ?? null,
					receiptDigest,
				};
				if (existing !== undefined) {
					if (
						existing.workflowId !== identity.workflowId ||
						existing.bindingDigest !== identity.bindingDigest ||
						existing.capability !== identity.capability ||
						existing.resourceDigest !== identity.resourceDigest ||
						existing.operationDigest !== identity.operationDigest ||
						existing.receiptDigest !== identity.receiptDigest
					)
						throw new Error("Workflow host receipt consumption conflicts with an existing witness.");
					return;
				}
				const witness: WorkflowHostReceiptConsumptionWitness = {
					receiptId: verified.receiptId,
					...identity,
					consumedAt: input.now(),
					consumptionSequence: Object.keys(record.witnesses).length + 1,
				};
				await durable.auxiliaryStore.write(
					receiptConsumptionRecord,
					canonicalJsonBytes({ version: 1, witnesses: { ...record.witnesses, [witness.receiptId]: witness } }),
				);
			});
		},
		resolveConsumptionWitness: async (witnessInput) => {
			const record = await readConsumptions();
			const witness = record.witnesses[witnessInput.receiptId];
			if (
				witness === undefined ||
				witness.workflowId !== witnessInput.workflowId ||
				witness.bindingDigest !== witnessInput.expectedBindingDigest
			)
				throw new Error("Workflow host receipt has no matching durable consumption witness.");
			return structuredClone(witness);
		},
	};
	let receiptContext: WorkflowHostReceiptConsumerContext;
	const principalAuthorizer: WorkflowHostPrincipalCapabilityAuthorizer = {
		authorize: async (
			authorizationInput: WorkflowHostPrincipalCapabilityAuthorizationInput,
		): Promise<WorkflowHostPrincipalCapabilityAuthorization> => {
			if (authorizationInput.workflowId !== input.workflowId)
				throw new Error("Workflow principal authorization workflow binding is invalid.");
			if (
				authorizationInput.receipt.receiptKind !== "capability" ||
				authorizationInput.receipt.capabilityBinding === undefined ||
				!isDigestString(authorizationInput.receipt.bindingDigest) ||
				!isDigestString(authorizationInput.bindingDigest) ||
				!isDigestString(authorizationInput.resourceDigest) ||
				!isDigestString(authorizationInput.operationDigest) ||
				authorizationInput.receipt.capabilityBinding.capability !== authorizationInput.capability ||
				authorizationInput.receipt.capabilityBinding.resourceDigest !== authorizationInput.resourceDigest ||
				authorizationInput.receipt.capabilityBinding.operationDigest !== authorizationInput.operationDigest ||
				authorizationInput.receipt.capabilityBinding.executionIdentity !==
					(authorizationInput.executionIdentity ?? null) ||
				authorizationInput.receipt.capabilityBinding.sessionId !== (authorizationInput.sessionId ?? null)
			)
				throw new Error("Workflow principal authorization capability binding is invalid.");
			const state = await input.store.reload();
			if (state === null) throw new Error("Workflow principal authorization requires durable workflow state.");
			const currentDurable = input.runtimeStore.durableContext;
			if (currentDurable === undefined)
				throw new Error("Workflow principal authorization requires durable runtime.");
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: currentDurable.epochRef.storeEpoch,
			});
			if (
				replay.quarantined ||
				replay.head.eventDigest === null ||
				state.sourceJournalDigest !== replay.head.eventDigest ||
				state.sourceJournalSequence !== replay.head.sequence
			)
				throw new Error("Workflow principal authorization current head is stale or unauthenticated.");
			const currentLease = currentDurable.currentLeaseRef();
			if (
				!Number.isFinite(Date.parse(input.now())) ||
				!Number.isFinite(Date.parse(currentLease.expiresAt)) ||
				Date.parse(currentLease.expiresAt) <= Date.parse(input.now()) ||
				authorizationInput.epochRef.storeEpoch !== currentDurable.epochRef.storeEpoch ||
				authorizationInput.epochRef.coordinatorEpoch !== currentDurable.epochRef.coordinatorEpoch ||
				authorizationInput.stateDigest !== state.sourceJournalDigest ||
				authorizationInput.revision !== state.sourceJournalSequence ||
				(authorizationInput.executionIdentity !== undefined &&
					authorizationInput.executionIdentity !== currentLease.processIdentity) ||
				(authorizationInput.sessionId !== undefined && authorizationInput.sessionId !== input.rootSessionId)
			)
				throw new Error("Workflow principal authorization current tuple is stale or foreign.");
			const key = await receiptContext.keyResolver.resolve(authorizationInput.receipt.keyId);
			if (
				key.revoked ||
				key.ownerPrincipal !== keyOwnerPrincipal ||
				authorizationInput.receipt.issuerId !== key.ownerPrincipal ||
				key.generationId !== currentDurable.generationId ||
				key.epochRef.storeEpoch !== currentDurable.epochRef.storeEpoch ||
				key.epochRef.coordinatorEpoch !== currentDurable.epochRef.coordinatorEpoch ||
				key.fencingDigest !== currentKeyFencingDigest() ||
				!key.allowedCapabilities.has(authorizationInput.capability)
			)
				throw new Error("Workflow principal authorization key authority is invalid.");
			const verified = await resolveAndVerifyWorkflowHostReceipt({
				context: receiptContext,
				workflowId: authorizationInput.workflowId,
				expectedBindingDigest: authorizationInput.bindingDigest,
				receipt: authorizationInput.receipt,
				currentStateDigest: state.sourceJournalDigest,
				currentRevision: state.sourceJournalSequence,
				trustedNow: input.now(),
			});
			return {
				authenticatedPrincipal: key.ownerPrincipal,
				keyOwnerPrincipal: key.ownerPrincipal,
				capability: authorizationInput.capability,
				workflowId: authorizationInput.workflowId,
				bindingDigest: authorizationInput.bindingDigest,
				receipt: verified,
				stateDigest: state.sourceJournalDigest,
				revision: state.sourceJournalSequence,
				epochRef: { ...currentDurable.epochRef },
				validity: { issuedAt: verified.issuedAt, validUntil: verified.validUntil },
				...(authorizationInput.executionIdentity === undefined
					? {}
					: { executionIdentity: authorizationInput.executionIdentity }),
				...(authorizationInput.sessionId === undefined ? {} : { sessionId: authorizationInput.sessionId }),
				authorizationDigest: digestObject({
					principal: key.ownerPrincipal,
					capability: authorizationInput.capability,
					workflowId: authorizationInput.workflowId,
					bindingDigest: authorizationInput.bindingDigest,
					receiptId: verified.receiptId,
					receiptDigest: digestObject(verified),
					keyId: verified.keyId,
					stateDigest: state.sourceJournalDigest,
					revision: state.sourceJournalSequence,
					epochRef: currentDurable.epochRef,
					generationId: currentDurable.generationId,
					fencingDigest: currentKeyFencingDigest(),
					resourceDigest: authorizationInput.resourceDigest,
					operationDigest: authorizationInput.operationDigest,
					executionIdentity: authorizationInput.executionIdentity ?? null,
					sessionId: authorizationInput.sessionId ?? null,
				}),
			};
		},
	};
	receiptContext = {
		receiptResolver,
		keyResolver,
		revokedReceiptIds,
		revokeReceipt,
		artifactResolver: input.artifactResolver,
		principalAuthorizer,
		signer: {
			keyId: keyMaterial.keyId,
			signatureAlgorithm: "ed25519",
			sign: async (bytes) => signBytes(null, Buffer.from(bytes), keyMaterial.privateKey).toString("base64"),
		},
	};
	const issue = async (issueInput: {
		receiptKind: WorkflowVerifiedHostReceipt["receiptKind"];
		workflowId: string;
		bindingDigest: string;
		capability?: WorkflowHostReceiptCapability;
		resourceDigest?: string;
		operationDigest?: string;
		executionIdentity?: string;
		sessionId?: string;
		receiptId?: string;
		oneUse?: boolean;
		issuedAt?: string;
		stateDigest?: string;
		revision?: number;
		metering?: PersistedWorkflowMeteringFields;
		payloadKind?: "workflow-resource-loader" | "workflow-recipe" | "workflow-learning";
		payloadDigest?: string;
		artifactNamespace?: "skills";
	}): Promise<WorkflowVerifiedHostReceipt> => {
		if (Object.hasOwn(issueInput, "issuerId"))
			throw new Error("Workflow receipt issuer is host-derived and cannot be supplied by a caller.");
		if (issueInput.workflowId !== input.workflowId) throw new Error("Workflow receipt workflow identity mismatch.");
		if (!isDigestString(issueInput.bindingDigest)) throw new Error("Workflow receipt binding digest is invalid.");
		const state = await input.store.reload();
		if (state === null) throw new Error("Workflow receipt requires a durable workflow state.");
		const issuedAt = issueInput.issuedAt ?? input.now();
		const issuedAtMs = Date.parse(issuedAt);
		if (!Number.isFinite(issuedAtMs)) throw new Error("Workflow receipt host clock is invalid.");
		const validUntil = new Date(issuedAtMs + WORKFLOW_HOST_RECEIPT_TTL_MILLISECONDS).toISOString();
		const stateDigest = issueInput.stateDigest ?? state.sourceJournalDigest;
		const revision = issueInput.revision ?? state.sourceJournalSequence;
		const currentTuple = stateDigest === state.sourceJournalDigest && revision === state.sourceJournalSequence;
		const payloadBoundReceipt = issueInput.payloadKind !== undefined;
		if (!currentTuple && !payloadBoundReceipt) {
			const replay = await input.runtimeStore.replay({
				workflowId: input.workflowId,
				fromSequence: 0,
				expectedStoreEpoch: state.storeEpoch,
			});
			const preparedApproval = replay.quarantined
				? false
				: replay.events.some((event) => {
						if (event.payload.kind === "approval_epoch_reanchored") {
							return (
								event.payload.stateDigest === stateDigest &&
								event.payload.nextEpoch.storeEpoch === state.storeEpoch &&
								event.payload.nextEpoch.coordinatorEpoch === state.coordinatorEpoch &&
								event.sequence === revision + 1
							);
						}
						if (event.payload.kind !== "approval_requested") return false;
						const approval = event.payload.approval;
						return (
							approval.stateDigest === stateDigest &&
							approval.storeEpoch === state.storeEpoch &&
							approval.coordinatorEpoch === state.coordinatorEpoch &&
							event.sequence === revision + 1 &&
							event.payload.awaitingUser.expectedHeadDigest === approval.headDigest &&
							event.payload.awaitingUser.expectedEpoch.storeEpoch === state.storeEpoch &&
							event.payload.awaitingUser.expectedEpoch.coordinatorEpoch === state.coordinatorEpoch
						);
					});
			if (!preparedApproval) throw new Error("Workflow receipt issue tuple is stale.");
		}
		if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Workflow receipt issue tuple is stale.");
		if (
			(issueInput.capability === undefined &&
				(issueInput.resourceDigest !== undefined ||
					issueInput.operationDigest !== undefined ||
					issueInput.executionIdentity !== undefined ||
					issueInput.sessionId !== undefined)) ||
			(issueInput.capability !== undefined &&
				(issueInput.resourceDigest === undefined || issueInput.operationDigest === undefined))
		)
			throw new Error("Workflow receipt capability binding is incomplete.");
		if (
			issueInput.capability !== undefined &&
			(!isDigestString(issueInput.resourceDigest) || !isDigestString(issueInput.operationDigest))
		)
			throw new Error("Workflow receipt capability binding digests are invalid.");
		const capabilityBinding: WorkflowHostReceiptCapabilityBinding | undefined =
			issueInput.capability === undefined
				? undefined
				: {
						capability: issueInput.capability,
						resourceDigest: issueInput.resourceDigest!,
						operationDigest: issueInput.operationDigest!,
						executionIdentity: issueInput.executionIdentity ?? null,
						sessionId: issueInput.sessionId ?? null,
					};
		if (issueInput.receiptId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(issueInput.receiptId))
			throw new Error("Workflow receipt identity is invalid.");
		const payload = {
			kind: "workflow-host-receipt" as const,
			workflowId: input.workflowId,
			receiptKind: issueInput.receiptKind,
			bindingDigest: issueInput.bindingDigest,
			stateDigest,
			revision,
			issuedAt,
			validUntil,
			...(capabilityBinding === undefined ? {} : { capabilityBinding }),
		};
		const payloadDigest = issueInput.payloadDigest ?? digestObject(payload);
		const artifactBytes = canonicalJsonBytes({
			...payload,
			...(issueInput.payloadKind === undefined
				? {}
				: issueInput.payloadKind === "workflow-resource-loader"
					? { payloadKind: issueInput.payloadKind, loaderResultDigest: payloadDigest }
					: issueInput.payloadKind === "workflow-recipe"
						? { payloadKind: issueInput.payloadKind, recipePayloadDigest: payloadDigest }
						: { payloadKind: issueInput.payloadKind, learningPayloadDigest: payloadDigest }),
			...(issueInput.metering ?? {}),
			payloadDigest,
		});
		const artifact = await input.runtimeStore.publishArtifact({
			workflowId: input.workflowId,
			payloadKind: "evidence",
			...(issueInput.artifactNamespace === undefined ? {} : { artifactNamespace: issueInput.artifactNamespace }),
			bytes: artifactBytes,
			codec: "canonical_json",
			sourceEventSequence: revision,
			idempotencyKey: `workflow-host-receipt-${issueInput.receiptKind}-${issueInput.bindingDigest}-${issuedAt}`,
		});
		const unsigned = {
			receiptKind: issueInput.receiptKind,
			oneUse: issueInput.oneUse ?? false,
			receiptId: issueInput.receiptId ?? randomUUID(),
			issuerId: keyOwnerPrincipal,
			workflowId: input.workflowId,
			bindingDigest: issueInput.bindingDigest,
			payloadDigest,
			artifactRef: artifact.envelope.ref,
			issuedAt,
			validUntil,
			keyId: keyMaterial.keyId,
			signatureAlgorithm: "ed25519" as const,
			artifactBytesDigest: artifact.envelope.ref.digest,
			stateDigest,
			revision,
			...(capabilityBinding === undefined ? {} : { capabilityBinding }),
		};
		const signature = signBytes(null, Buffer.from(canonicalJsonBytes(unsigned)), keyMaterial.privateKey).toString(
			"base64",
		);
		const withSignature = { ...unsigned, signature, verificationDigest: "" };
		const result = { ...withSignature, verificationDigest: digestObject(withSignature) };
		const identity: PersistedWorkflowReceiptIssuanceIdentity = {
			receiptId: result.receiptId,
			workflowId: result.workflowId,
			bindingDigest: result.bindingDigest,
			capability: result.capabilityBinding?.capability ?? null,
			resourceDigest: result.capabilityBinding?.resourceDigest ?? null,
			operationDigest: result.capabilityBinding?.operationDigest ?? null,
			receiptDigest: digestObject(result),
		};
		await durable.withExclusiveLease("workflow-receipt-issue", async () => {
			const record = await readIssuances();
			const existing = record.receipts[result.receiptId];
			if (existing !== undefined && digestObject(existing) !== digestObject(identity))
				throw new Error("Workflow host receipt ID conflicts with an existing authenticated operation.");
			if (existing !== undefined) return;
			await durable.auxiliaryStore.write(
				receiptIssuanceRecord,
				canonicalJsonBytes({ version: 1, receipts: { ...record.receipts, [identity.receiptId]: identity } }),
			);
		});
		return result;
	};
	return {
		receiptContext,
		consume: ({ receipt, bindingDigest, currentRevision }) =>
			receiptResolver.consumeIfOneUse({
				receipt,
				workflowId: input.workflowId,
				expectedBindingDigest: bindingDigest,
				currentRevision,
			}),
		trustedClock: {
			receipt: ({ workflowId, bindingDigest }) => issue({ receiptKind: "clock", workflowId, bindingDigest }),
		},
		issue,
	};
}

function createPersistedWorkflowGoalAccounting(input: {
	runtimeStore: WorkflowRuntimeStore;
	store: WorkflowStore;
	workflowId: string;
	now: () => string;
	receiptAuthority: PersistedWorkflowReceiptAuthority;
	goalCoordinator: WorkflowGoalCoordinator;
}): WorkflowGoalAccountingPort {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_goal_accounting_requires_persisted_runtime");
	const account = async (
		metering: WorkflowGoalAccountingInput,
		kind: "usage" | "continuation",
	): Promise<GoalState> => {
		if (
			!Number.isSafeInteger(metering.tokenDelta) ||
			metering.tokenDelta < 0 ||
			!Number.isFinite(metering.wallTimeDeltaSeconds) ||
			metering.wallTimeDeltaSeconds < 0 ||
			!Number.isSafeInteger(metering.continuationDelta) ||
			metering.continuationDelta < 0
		)
			throw new Error("Workflow goal accounting deltas must be finite and nonnegative.");
		const meteringFields = {
			tokenDelta: metering.tokenDelta,
			wallTimeDeltaSeconds: metering.wallTimeDeltaSeconds,
			continuationDelta: metering.continuationDelta,
			proofDigest: digestObject({
				tokenDelta: metering.tokenDelta,
				wallTimeDeltaSeconds: metering.wallTimeDeltaSeconds,
				continuationDelta: metering.continuationDelta,
				proofDigest: "",
			}),
		} satisfies PersistedWorkflowMeteringFields;
		let lastConflictHeadDigest: string | undefined;
		let sameHeadConflictCount = 0;
		const conflictIsExhausted = (head: WorkflowJournalHead, attempt: number): boolean => {
			const headDigest = digestObject(head);
			if (headDigest === lastConflictHeadDigest) sameHeadConflictCount += 1;
			else {
				lastConflictHeadDigest = headDigest;
				sameHeadConflictCount = 1;
			}
			return (
				attempt + 1 >= GOAL_ACCOUNTING_REBASE_LIMIT ||
				sameHeadConflictCount >= GOAL_ACCOUNTING_SAME_HEAD_REBASE_LIMIT
			);
		};
		for (let attempt = 0; attempt < GOAL_ACCOUNTING_REBASE_LIMIT; attempt += 1) {
			const state = await input.store.reload();
			if (state === null || state.workflowId !== input.workflowId || state.status !== "active")
				throw new Error("Workflow goal accounting requires an active durable workflow.");
			const currentGoal = input.goalCoordinator.read(input.workflowId);
			const expectedHead = workflowHeadFromState(state);
			const expectedEpoch = { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch };
			const bindingDigest = digestObject({
				workflowId: input.workflowId,
				expectedHead,
				expectedEpoch,
				kind,
				meteringDigest: meteringFields.proofDigest,
			});
			let receipt: WorkflowVerifiedHostReceipt;
			try {
				receipt = await input.receiptAuthority.issue({
					receiptKind: "usage",
					workflowId: input.workflowId,
					bindingDigest,
					oneUse: false,
					stateDigest: expectedHead.eventDigest ?? digestWorkflowGoalState(currentGoal),
					revision: state.sourceJournalSequence,
					metering: meteringFields,
				});
			} catch (error) {
				if (!isStaleGoalAccountingCommit(error)) throw error;
				if (conflictIsExhausted(expectedHead, attempt))
					throw new Error("workflow_goal_accounting_rebase_exhausted", { cause: error });
				await new Promise<void>((resolveDelay) =>
					setTimeout(resolveDelay, GOAL_ACCOUNTING_REBASE_DELAY_MILLISECONDS),
				);
				continue;
			}
			const goalDelta: WorkflowGoalMutationDelta = {
				goalId: currentGoal.goalId ?? null,
				objective: currentGoal.objective ?? null,
				active: currentGoal.active,
				status: currentGoal.status,
				tokenBudget: currentGoal.tokenBudget ?? null,
				tokensUsed: currentGoal.tokensUsed + metering.tokenDelta,
				timeUsedSeconds: currentGoal.timeUsedSeconds + metering.wallTimeDeltaSeconds,
				continuationsUsed: currentGoal.continuationsUsed + metering.continuationDelta,
				createdAt: currentGoal.createdAt ?? null,
				updatedAt: currentGoal.updatedAt ?? null,
				lastReason: currentGoal.lastReason ?? null,
				lastError: currentGoal.lastError ?? null,
			};
			const leaseRef = durable.currentLeaseRef();
			const idempotencyKey = digestObject({
				workflowId: input.workflowId,
				kind,
				expectedHead,
				goal: digestWorkflowGoalState(currentGoal),
				meteringDigest: meteringFields.proofDigest,
			});
			const request: WorkflowGoalAccountingRequest = {
				workflowId: input.workflowId,
				source: kind === "usage" ? "workflow_usage" : "workflow_continuation",
				expectedGoalDigest: digestWorkflowGoalState(currentGoal),
				expectedHead,
				expectedEpoch,
				leaseRef,
				idempotencyKey,
				writerIdentity: leaseRef.writerIdentity,
				executionKey: null,
				payload: {
					kind: "goal_projection_applied",
					binding: {
						workflowId: input.workflowId,
						eventSequence: expectedHead.sequence + 1,
						transitionDigest: idempotencyKey,
						storeEpoch: expectedEpoch.storeEpoch,
						coordinatorEpoch: expectedEpoch.coordinatorEpoch,
					},
					goalDigest: digestObject(goalDelta),
					goalDelta,
				},
				meteringProof: {
					receipt,
					artifactRef: receipt.artifactRef,
					proofDigest: meteringFields.proofDigest,
				},
				receiptContext: input.receiptAuthority.receiptContext,
				currentRevision: state.sourceJournalSequence,
				trustedNow: input.now(),
			};
			try {
				return kind === "usage"
					? await input.goalCoordinator.accountAssistantUsage(request)
					: await input.goalCoordinator.accountContinuation(request);
			} catch (error) {
				if (!isStaleGoalAccountingCommit(error)) throw error;
				if (conflictIsExhausted(expectedHead, attempt))
					throw new Error("workflow_goal_accounting_rebase_exhausted", { cause: error });
				await new Promise<void>((resolveDelay) =>
					setTimeout(resolveDelay, GOAL_ACCOUNTING_REBASE_DELAY_MILLISECONDS),
				);
			}
		}
		throw new Error("workflow_goal_accounting_rebase_exhausted");
	};
	return {
		accountAssistantUsage: (metering) => account(metering, "usage"),
		accountContinuation: (metering) => account(metering, "continuation"),
	};
}

async function createPersistedWorkflowApprovalManager(input: {
	runtimeStore: WorkflowRuntimeStore;
	store: WorkflowStore;
	workflowId: string;
	rootSessionId: string;
	artifactRoot: string;
	descriptorFs: WorkflowDescriptorFs;
	keyProvider: WorkflowJournalKeyProvider;
	now: () => string;
	receiptAuthority: PersistedWorkflowReceiptAuthority;
	approvalSecretDelivery?: (input: {
		readonly request: WorkflowApprovalRequest;
		readonly proof: DurableApprovalSecretProof;
		/** One-use proofs bound to each structured option in the request. */
		readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
	}) => Promise<void> | void;
}): Promise<WorkflowApprovalManagerWithOutcome> {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_approval_manager_requires_persisted_runtime");
	const trustedPrincipal: WorkflowTrustedPrincipal = {
		kind: "interactive_ui",
		principalId: input.rootSessionId,
		credentialDigest: digestObject({ kind: "workflow-ui-principal", workflowId: input.workflowId }),
	};
	const clientSessionId = input.rootSessionId;
	const secrets = new Map<string, string>();
	let lastTrustedClockIssuedAt: string | undefined;
	let currentRevisionHint = Math.max(1, input.store.snapshot()?.sourceJournalSequence ?? 1);

	const replay = async (): Promise<readonly WorkflowJournalCommit<WorkflowEventPayload>[]> => {
		const currentEpoch = durable.epochRef.storeEpoch;
		const result = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: currentEpoch,
		});
		if (result.quarantined) throw new Error("workflow_approval_journal_quarantined");
		return result.events;
	};
	const findConsumed = async (approvalRequestId: string): Promise<WorkflowApprovalReceipt | null> => {
		const events = await replay();
		for (const event of [...events].reverse()) {
			if (
				event.payload.kind === "approval_consumed" &&
				event.payload.receipt.approvalRequestId === approvalRequestId
			)
				return structuredClone(event.payload.receipt);
		}
		return null;
	};
	const findRequested = async (approvalRequestId: string): Promise<WorkflowApprovalRequest | null> => {
		const events = await replay();
		for (const event of [...events].reverse()) {
			if (
				event.payload.kind === "approval_requested" &&
				event.payload.approval.approvalRequestId === approvalRequestId
			)
				return structuredClone(event.payload.approval);
		}
		return null;
	};
	const findRequestedEvent = async (approvalRequestId: string) => {
		const events = await replay();
		for (const event of [...events].reverse()) {
			if (
				(event.payload.kind === "approval_requested" &&
					event.payload.approval.approvalRequestId === approvalRequestId) ||
				(event.payload.kind === "approval_epoch_reanchored" &&
					event.payload.approvalRequestId === approvalRequestId)
			)
				return event;
		}
		return null;
	};
	const readAuxiliary = async (): Promise<PersistedWorkflowApprovalAuxiliaryRecord> => {
		const bytes = await readWorkflowSideRecord(
			input.descriptorFs,
			input.artifactRoot,
			input.workflowId,
			WORKFLOW_APPROVAL_AUTHORITY_RECORD,
		);
		if (bytes === null) return { version: 1, delivered: {}, invalidations: {} };
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!sameBytes(canonicalJsonBytes(parsed), bytes) || !isPersistedWorkflowApprovalAuthorityRecord(parsed))
			throw new Error("workflow_approval_record_corrupt");
		if (parsed.workflowId !== input.workflowId || parsed.stateDigest !== digestObject(parsed.state))
			throw new Error("workflow_approval_record_corrupt");
		const unsigned = {
			version: parsed.version,
			kind: parsed.kind,
			workflowId: parsed.workflowId,
			generationId: parsed.generationId,
			epochRef: parsed.epochRef,
			keyId: parsed.keyId,
			stateDigest: parsed.stateDigest,
			state: parsed.state,
			sideRecordMac: "",
		};
		let key: WorkflowJournalKey;
		try {
			key = await input.keyProvider.resolve(input.workflowId, parsed.keyId, parsed.epochRef);
		} catch (error) {
			throw new Error("workflow_approval_record_corrupt", { cause: error });
		}
		if (
			key.keyId !== parsed.keyId ||
			key.generationId !== parsed.generationId ||
			key.validStoreEpoch !== parsed.epochRef.storeEpoch ||
			!verifyHmac(key.secret, unsigned, parsed.sideRecordMac)
		)
			throw new Error("workflow_approval_record_corrupt");
		return parsed.state;
	};
	const writeAuxiliary = async (state: PersistedWorkflowApprovalAuxiliaryRecord): Promise<void> => {
		const key = await input.keyProvider.current(input.workflowId, durable.epochRef);
		if (key.generationId !== durable.generationId || key.validStoreEpoch !== durable.epochRef.storeEpoch)
			throw new Error("workflow_approval_record_epoch_stale");
		const unsigned: Omit<PersistedWorkflowApprovalAuthorityRecord, "sideRecordMac"> & {
			sideRecordMac: string;
		} = {
			version: 1,
			kind: "workflow_approval_authority",
			workflowId: input.workflowId,
			generationId: key.generationId,
			epochRef: { ...durable.epochRef },
			keyId: key.keyId,
			stateDigest: digestObject(state),
			state,
			sideRecordMac: "",
		};
		await writeSideRecord(
			input.descriptorFs,
			input.artifactRoot,
			input.workflowId,
			WORKFLOW_APPROVAL_AUTHORITY_RECORD,
			{ ...unsigned, sideRecordMac: hmac(key.secret, unsigned) },
		);
	};
	const updateAuxiliary = async (
		update: (record: PersistedWorkflowApprovalAuxiliaryRecord) => PersistedWorkflowApprovalAuxiliaryRecord,
	): Promise<void> => {
		await durable.withExclusiveLease("workflow-approval-side-record", async () => {
			const next = update(await readAuxiliary());
			await writeAuxiliary(next);
		});
	};
	const currentHead = async (): Promise<{
		stateDigest: string;
		epochRef: WorkflowEpochRef;
		headDigest: string;
		revision: number;
	}> => {
		const state = await input.store.reload();
		if (state === null || state.workflowId !== input.workflowId)
			throw new Error("Workflow approval current head is unavailable.");
		return {
			stateDigest: state.sourceJournalDigest,
			epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
			headDigest: state.sourceJournalDigest,
			revision: state.sourceJournalSequence,
		};
	};
	const commitPayload = async (payload: WorkflowEventPayload): Promise<void> => {
		const state = await input.store.reload();
		if (state === null || state.workflowId !== input.workflowId)
			throw new Error("Workflow approval mutation requires a durable workflow state.");
		const expectedHead = workflowHeadFromState(state);
		const epochRef = expectedHead.epochRef;
		const leaseRef = durable.currentLeaseRef();
		if (
			leaseRef.storeEpoch !== epochRef.storeEpoch ||
			leaseRef.coordinatorEpoch !== epochRef.coordinatorEpoch ||
			leaseRef.writerIdentity.length === 0
		)
			throw new Error("Workflow approval mutation lease is stale.");
		const mutationId = digestObject({ workflowId: input.workflowId, payload, expectedHead });
		const baselineDigest = digestObject(expectedHead);
		await input.runtimeStore.commit({
			workflowId: input.workflowId,
			payload,
			expectedHead,
			semanticBinding: {
				mutationId,
				baselineDigest,
				expectedGenerations: { workflow: state.storeEpoch },
				ownerId: "workflow-coordinator",
				phase: state.phase,
				reducerDigest: digestObject(payload),
				semanticHead: {
					workflowId: input.workflowId,
					sequence: expectedHead.sequence,
					eventDigest: expectedHead.eventDigest,
					stateDigest: baselineDigest,
					epochRef,
					generation: state.storeEpoch,
				},
				expectedHead,
				idempotencyKey: mutationId,
				executionKey: null,
				writerIdentity: leaseRef.writerIdentity,
				leaseRef,
				epochRef,
			},
			epochRef,
			leaseRef,
			idempotencyKey: mutationId,
			writerIdentity: leaseRef.writerIdentity,
			executionKey: null,
		});
	};

	const approvalStore: WorkflowApprovalStore = {
		prepareRequest: async (prepareInput) => {
			if (
				prepareInput.requestEventDigest !==
					digestObject({
						kind: "approval_requested",
						approval: prepareInput.request,
						awaitingUser: prepareInput.awaitingUserTransition,
					}) ||
				prepareInput.expectedHeadDigest !== prepareInput.awaitingUserTransition.expectedHeadDigest ||
				prepareInput.expectedStateDigest !== prepareInput.request.stateDigest ||
				digestObject(prepareInput.expectedEpoch) !== digestObject(prepareInput.awaitingUserTransition.expectedEpoch)
			)
				throw new Error("Workflow approval request is not bound to the authenticated awaiting transition.");
			const state = await input.store.reload();
			if (state === null) throw new Error("Workflow approval request requires a durable workflow state.");
			if (state.approvalRequest?.approvalRequestId === prepareInput.request.approvalRequestId) return;
			if (
				state.sourceJournalDigest !== prepareInput.expectedStateDigest ||
				state.storeEpoch !== prepareInput.expectedEpoch.storeEpoch ||
				state.coordinatorEpoch !== prepareInput.expectedEpoch.coordinatorEpoch
			)
				throw new Error("Workflow approval request is stale against the durable proposal head.");
			await commitPayload({
				kind: "approval_requested",
				approval: prepareInput.request,
				awaitingUser: prepareInput.awaitingUserTransition,
			});
		},
		markSecretDelivered: async (deliveryInput) => {
			const request = await findRequested(deliveryInput.approvalRequestId);
			if (
				request === null ||
				request.stateDigest !== deliveryInput.expectedStateDigest ||
				request.storeEpoch !== deliveryInput.expectedEpoch.storeEpoch ||
				request.coordinatorEpoch !== deliveryInput.expectedEpoch.coordinatorEpoch ||
				deliveryInput.deliveryProof.length === 0
			)
				throw new Error("Workflow approval delivery is not bound to the durable request.");
			await updateAuxiliary((record) => ({
				...record,
				delivered: { ...record.delivered, [deliveryInput.approvalRequestId]: deliveryInput.deliveryProof },
			}));
		},
		read: async (approvalRequestId) => {
			const state = await input.store.reload();
			if (state?.approvalRequest?.approvalRequestId === approvalRequestId)
				return structuredClone(state.approvalRequest);
			return findRequested(approvalRequestId);
		},
		readPending: async (workflowId) => {
			if (workflowId !== input.workflowId) return null;
			const state = await input.store.reload();
			if (state?.workflowId !== workflowId || state.approvalRequest === null || state.status !== "awaiting_user")
				return null;
			const aux = await readAuxiliary();
			if (aux.invalidations[state.approvalRequest.approvalRequestId] !== undefined) return null;
			return structuredClone(state.approvalRequest);
		},
		readCurrentHead: currentHead,
		readPreparedHead: async (approvalRequestId) => {
			const event = await findRequestedEvent(approvalRequestId);
			if (event === null) throw new Error("Workflow approval request is missing from the durable journal.");
			return {
				stateDigest: event.eventDigest,
				headDigest: event.eventDigest,
				epochRef: event.epochRef,
				revision: event.sequence,
			};
		},
		consume: async (consumeInput) =>
			durable.withExclusiveLease(WORKFLOW_APPROVAL_AUTHORITY_BOUNDARY, async () => {
				const existing = await findConsumed(consumeInput.approvalRequestId);
				if (existing !== null) return { status: "already_consumed", receipt: existing };
				const current = await readAuxiliary();
				if (current.invalidations[consumeInput.approvalRequestId] !== undefined)
					throw new Error("Workflow approval request was invalidated and cannot be consumed.");
				if (consumeInput.resumeTransition === null)
					throw new Error("Workflow approval consumption requires the structured resume transition contract.");
				const state = await input.store.reload();
				if (
					state === null ||
					state.approvalRequest === null ||
					state.approvalRequest.approvalRequestId !== consumeInput.approvalRequestId
				)
					throw new Error("Workflow approval request is missing or already consumed.");
				const request = state.approvalRequest;
				if (
					state.sourceJournalDigest !== consumeInput.expectedStateDigest ||
					state.sourceJournalDigest !== consumeInput.expectedHeadDigest ||
					state.storeEpoch !== consumeInput.expectedEpoch.storeEpoch ||
					state.coordinatorEpoch !== consumeInput.expectedEpoch.coordinatorEpoch
				)
					throw new Error("Workflow approval consumption is stale against the durable awaiting head.");
				const consumptionEventSequence = state.sourceJournalSequence + 1;
				const requestDecisionRefs = normalizeWorkflowDecisionRefs(
					request.decisionRefs,
					request.workflowId,
					input.rootSessionId,
					{ storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
				);
				const requestDecisionRef = normalizeWorkflowDecisionRefs(
					[request.decisionRef],
					request.workflowId,
					input.rootSessionId,
					{ storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
				)[0]!;
				const requestDecisionRoles: WorkflowApprovalDecisionRoles = {
					goal: normalizeWorkflowDecisionRefs(
						[request.decisionRoles.goal],
						request.workflowId,
						input.rootSessionId,
						{ storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
					)[0]!,
					scorecard: normalizeWorkflowDecisionRefs(
						[request.decisionRoles.scorecard],
						request.workflowId,
						input.rootSessionId,
						{ storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
					)[0]!,
					resource: normalizeWorkflowDecisionRefs(
						[request.decisionRoles.resource],
						request.workflowId,
						input.rootSessionId,
						{ storeEpoch: request.storeEpoch, coordinatorEpoch: request.coordinatorEpoch },
					)[0]!,
				};
				const receipt: WorkflowApprovalReceipt = {
					approvalRequestId: request.approvalRequestId,
					workflowId: request.workflowId,
					decisionRef: requestDecisionRef,
					decisionRefs: requestDecisionRefs,
					headDigest: request.headDigest,
					stateDigest: request.stateDigest,
					configDigest: request.configDigest,
					profileDigest: request.profileDigest,
					artifactDigest: request.artifactDigest,
					storeEpoch: request.storeEpoch,
					coordinatorEpoch: request.coordinatorEpoch,
					clientSessionId: request.requestingClientSessionId,
					trustedPrincipal: request.trustedPrincipal,
					responseSequence: request.expectedResponseSequence,
					optionId: consumeInput.optionId,
					decisionRoles: requestDecisionRoles,
					effectDigest: consumeInput.effectDigest,
					mode: "interactive_secret",
					responseDigest: consumeInput.responseDigest,
					consumedAt: input.now(),
					consumptionEventSequence,
					trustedClockReceipt: consumeInput.trustedClockReceipt,
				};
				await commitPayload({
					kind: "approval_consumed",
					receipt,
					resumeTransition: consumeInput.resumeTransition,
				});
				return { status: "consumed", receipt };
			}),
		invalidate: async (invalidateInput) =>
			durable.withExclusiveLease(WORKFLOW_APPROVAL_AUTHORITY_BOUNDARY, async () => {
				const existingReceipt = await findConsumed(invalidateInput.approvalRequestId);
				if (existingReceipt !== null) return { status: "already_consumed", receipt: existingReceipt };
				const current = await readAuxiliary();
				const existing = current.invalidations[invalidateInput.approvalRequestId];
				if (existing !== undefined)
					return { status: "already_invalidated", invalidation: structuredClone(existing) };
				const request = await findRequested(invalidateInput.approvalRequestId);
				if (
					request === null ||
					request.expectedResponseSequence !== invalidateInput.expectedResponseSequence ||
					request.stateDigest !== invalidateInput.expectedStateDigest ||
					request.storeEpoch !== invalidateInput.expectedEpoch.storeEpoch ||
					request.coordinatorEpoch !== invalidateInput.expectedEpoch.coordinatorEpoch ||
					request.headDigest !== invalidateInput.expectedHeadDigest
				)
					throw new Error("Workflow approval invalidation is stale against the durable request.");
				await writeAuxiliary({
					...current,
					invalidations: {
						...current.invalidations,
						[invalidateInput.approvalRequestId]: invalidateInput.invalidation,
					},
				});
				return { status: "invalidated", invalidation: structuredClone(invalidateInput.invalidation) };
			}),
		readInvalidation: async (approvalRequestId) => {
			const record = await readAuxiliary();
			const invalidation = record.invalidations[approvalRequestId];
			return invalidation === undefined ? null : structuredClone(invalidation);
		},
		reconcile: async () => {
			await readAuxiliary();
		},
	};

	const decisionAuthority = {
		resolveCurrent: async (decisionInput: {
			workflowId: string;
			stateDigest: string;
			epochRef: WorkflowEpochRef;
			currentRevision: number;
		}): Promise<WorkflowApprovalDecisionContext> => {
			const state = await input.store.reload();
			if (state === null || state.workflowId !== decisionInput.workflowId)
				throw new Error("Workflow approval decision context is unavailable.");
			const refs = normalizeWorkflowDecisionRefs(
				state.decisionRefs.slice(-3),
				decisionInput.workflowId,
				input.rootSessionId,
				decisionInput.epochRef,
			);
			if (refs.length !== 3) throw new Error("Workflow approval decision context is incomplete.");
			const decisionRoles: WorkflowApprovalDecisionRoles = {
				goal: refs[0]!,
				scorecard: refs[1]!,
				resource: refs[2]!,
			};
			const decisionRef = refs[2]!;
			const hostReceipt = await input.receiptAuthority.issue({
				receiptKind: "decision",
				workflowId: decisionInput.workflowId,
				bindingDigest: digestObject({
					kind: "approval_decision_context",
					workflowId: decisionInput.workflowId,
					stateDigest: decisionInput.stateDigest,
					epochRef: decisionInput.epochRef,
					decisionRef,
					decisionRefs: refs,
					decisionRoles,
				}),
				issuedAt: lastTrustedClockIssuedAt,
				stateDigest: decisionInput.stateDigest,
				revision: decisionInput.currentRevision,
			});
			return { decisionRef, decisionRefs: refs, decisionRoles, hostReceipt };
		},
	};
	const secretProvider = {
		prepare: async (secretInput: {
			workflowId: string;
			clientSessionId: string;
			trustedPrincipal: WorkflowTrustedPrincipal;
			requestDigest: string;
		}): Promise<WorkflowApprovalSecretIssuance> => {
			const secret = randomUUID();
			const issuanceId = randomUUID();
			secrets.set(issuanceId, secret);
			return {
				issuanceId,
				workflowId: secretInput.workflowId,
				clientSessionId: secretInput.clientSessionId,
				trustedPrincipal: secretInput.trustedPrincipal,
				tokenHash: createHash("sha256").update(secret, "utf8").digest("hex"),
				tokenHashAlgorithm: "sha256",
				deliveryProof: digestObject({
					kind: "approval-secret-delivery",
					issuanceId,
					requestDigest: secretInput.requestDigest,
				}),
			};
		},
		deliver: async (deliveryInput: {
			issuance: WorkflowApprovalSecretIssuance;
			request: WorkflowApprovalRequest;
		}) => {
			const secret = secrets.get(deliveryInput.issuance.issuanceId);
			if (secret === undefined) throw new Error("Workflow approval secret is unavailable at delivery.");
			const bindingEpoch = {
				storeEpoch: deliveryInput.request.storeEpoch,
				coordinatorEpoch: deliveryInput.request.coordinatorEpoch,
			};
			const bindingDecisionRefs = normalizeWorkflowDecisionRefs(
				deliveryInput.request.decisionRefs,
				deliveryInput.request.workflowId,
				input.rootSessionId,
				bindingEpoch,
			);
			const bindingDecisionRef = normalizeWorkflowDecisionRefs(
				[deliveryInput.request.decisionRef],
				deliveryInput.request.workflowId,
				input.rootSessionId,
				bindingEpoch,
			)[0]!;
			const bindingDecisionRoles: WorkflowApprovalDecisionRoles = {
				goal: normalizeWorkflowDecisionRefs(
					[deliveryInput.request.decisionRoles.goal],
					deliveryInput.request.workflowId,
					input.rootSessionId,
					bindingEpoch,
				)[0]!,
				scorecard: normalizeWorkflowDecisionRefs(
					[deliveryInput.request.decisionRoles.scorecard],
					deliveryInput.request.workflowId,
					input.rootSessionId,
					bindingEpoch,
				)[0]!,
				resource: normalizeWorkflowDecisionRefs(
					[deliveryInput.request.decisionRoles.resource],
					deliveryInput.request.workflowId,
					input.rootSessionId,
					bindingEpoch,
				)[0]!,
			};
			const proofs = Object.freeze(
				Object.fromEntries(
					deliveryInput.request.options.map((option) => {
						const bindingInput: WorkflowApprovalBindingInput = {
							approvalRequestId: deliveryInput.request.approvalRequestId,
							workflowId: deliveryInput.request.workflowId,
							decisionRef: bindingDecisionRef,
							decisionRefs: bindingDecisionRefs,
							decisionRoles: bindingDecisionRoles,
							headDigest: deliveryInput.request.headDigest,
							stateDigest: deliveryInput.request.stateDigest,
							configDigest: deliveryInput.request.configDigest,
							profileDigest: deliveryInput.request.profileDigest,
							artifactDigest: deliveryInput.request.artifactDigest,
							storeEpoch: deliveryInput.request.storeEpoch,
							coordinatorEpoch: deliveryInput.request.coordinatorEpoch,
							principal: deliveryInput.request.trustedPrincipal,
							clientSessionId: deliveryInput.request.requestingClientSessionId,
							responseSequence: deliveryInput.request.expectedResponseSequence,
							optionId: option.optionId,
							tokenHash: deliveryInput.request.tokenHash,
							expiresAt: deliveryInput.request.expiresAt,
						};
						return [
							option.optionId,
							{
								oneUseSecret: secret,
								bindingDigest: approvalBindingDigest(bindingInput),
								bindingDigestAlgorithm: "sha256" as const,
							},
						] as const;
					}),
				),
			) as Readonly<Record<string, DurableApprovalSecretProof>>;
			const proof = proofs.approve ?? proofs[deliveryInput.request.options[0]?.optionId ?? ""];
			if (proof === undefined) throw new Error("Workflow approval request has no deliverable option.");
			await input.approvalSecretDelivery?.({
				request: deliveryInput.request,
				proof,
				proofs,
			});
		},
	};
	const trustedClock: WorkflowTrustedClock = {
		receipt: async ({ workflowId, bindingDigest }) => {
			const pending = await approvalStore.readPending(workflowId);
			const requestEvent = pending === null ? null : await findRequestedEvent(pending.approvalRequestId);
			currentRevisionHint = Math.max(1, requestEvent?.expectedHead.sequence ?? (await currentHead()).revision);
			const receipt = await input.receiptAuthority.issue({
				receiptKind: "clock",
				workflowId,
				bindingDigest,
				stateDigest: pending?.stateDigest,
				revision: requestEvent?.expectedHead.sequence,
			});
			lastTrustedClockIssuedAt = receipt.issuedAt;
			return receipt;
		},
	};
	// A coordinator-epoch rotation on resume (dead-owner recovery) fences the workflow onto a new
	// epoch without touching the durable approval request, which still carries the epoch it was
	// originally requested under (its decision refs, headless signature, and one-use secret are all
	// bound to that epoch and must not be rewritten). Instead, re-baseline the durable head that
	// consumption freshness is checked against, here, once, as an explicit journalled transition —
	// so a pending approval survives a session restart instead of being stuck behind a stale head.
	const resumedState = await input.store.reload();
	if (resumedState !== null && resumedState.status === "awaiting_user" && resumedState.approvalRequest !== null) {
		const liveEpoch = { storeEpoch: resumedState.storeEpoch, coordinatorEpoch: resumedState.coordinatorEpoch };
		const anchorEvent = await findRequestedEvent(resumedState.approvalRequest.approvalRequestId);
		if (anchorEvent !== null && digestObject(anchorEvent.epochRef) !== digestObject(liveEpoch)) {
			await commitPayload({
				kind: "approval_epoch_reanchored",
				workflowId: input.workflowId,
				approvalRequestId: resumedState.approvalRequest.approvalRequestId,
				stateDigest: resumedState.approvalRequest.stateDigest,
				nextEpoch: liveEpoch,
			});
		}
	}
	return createDurableApprovalManager({
		store: approvalStore,
		hostStore: input.store,
		keyResolver: {
			resolve: async () => {
				throw new Error("Signed headless approval requires an externally provisioned signer.");
			},
		},
		secretProvider,
		decisionAuthority,
		trustedPrincipal,
		clientSessionId,
		trustedClock,
		maxTtlMilliseconds: WORKFLOW_HOST_RECEIPT_TTL_MILLISECONDS,
		receiptContext: input.receiptAuthority.receiptContext,
		currentRevision: currentRevisionHint,
		currentRevisionResolver: () => currentRevisionHint,
	});
}

function completionGoalDelta(currentGoal: GoalState, reason: string): WorkflowGoalMutationDelta {
	if (currentGoal.goalId === undefined || currentGoal.objective === undefined)
		throw new Error("Workflow completion requires a durably bound GoalState projection.");
	return {
		goalId: currentGoal.goalId,
		objective: currentGoal.objective,
		active: false,
		status: "complete",
		tokenBudget: currentGoal.tokenBudget ?? null,
		tokensUsed: currentGoal.tokensUsed,
		timeUsedSeconds: currentGoal.timeUsedSeconds,
		continuationsUsed: currentGoal.continuationsUsed,
		createdAt: currentGoal.createdAt ?? null,
		updatedAt: currentGoal.updatedAt ?? null,
		lastReason: reason,
		lastError: currentGoal.lastError ?? null,
	};
}

async function recoverPersistedWorkflowCompletionIntent(input: {
	runtimeStore: WorkflowRuntimeStore;
	store: WorkflowStore;
	durable: WorkflowRuntimeStore["durableContext"];
	workflowId: string;
	now: () => string;
	receiptAuthority: PersistedWorkflowReceiptAuthority;
	goalProjection: WorkflowGoalProjectionAdapter;
	goalCoordinator: WorkflowGoalCoordinator;
}): Promise<void> {
	const durable = input.durable;
	if (durable === undefined) throw new Error("workflow_completion_recovery_requires_persisted_runtime");
	const recordName = generationScopedAuxiliaryRecord(WORKFLOW_COMPLETION_INTENT_RECORD, durable.generationId);
	const readIntent = async (): Promise<PersistedWorkflowCompletionIntentRecord | null> => {
		const bytes = await durable.auxiliaryStore.read(recordName);
		if (bytes === null) return null;
		const parsed = parseCanonicalJsonBytes(bytes);
		if (!sameBytes(canonicalJsonBytes(parsed), bytes) || !isPersistedWorkflowCompletionIntentRecord(parsed))
			throw new Error("workflow_completion_intent_corrupt");
		return parsed;
	};
	const initial = await readIntent();
	if (initial === null) return;
	if (initial.workflowId !== input.workflowId || initial.generationId !== durable.generationId)
		throw new Error("workflow_completion_intent_foreign");
	if (initial.status === "committed") return;
	await durable.withExclusiveLease("workflow-completion-authority", async () => {
		const intent = await readIntent();
		if (intent === null) throw new Error("workflow_completion_intent_missing");
		if (intent.workflowId !== input.workflowId || intent.generationId !== durable.generationId)
			throw new Error("workflow_completion_intent_foreign");
		if (intent.status === "committed") return;
		const current = await input.store.reload();
		if (current === null || current.workflowId !== input.workflowId)
			throw new Error("workflow_completion_recovery_state_missing");
		const replay = await input.runtimeStore.replay({
			workflowId: input.workflowId,
			fromSequence: 0,
			expectedStoreEpoch: durable.epochRef.storeEpoch,
		});
		const committedEvent = replay.events.find((event) => event.idempotencyKey === intent.idempotencyKey);
		if (committedEvent !== undefined) {
			if (
				committedEvent.payload.kind !== "workflow_status_changed" ||
				committedEvent.payload.status !== "complete" ||
				committedEvent.payload.phase !== "auditing_completion" ||
				digestObject(committedEvent.payload.goalDelta) !== digestObject(intent.goalDelta) ||
				current.status !== "complete" ||
				current.goalStatus !== "complete" ||
				current.goalActive ||
				current.sourceJournalSequence <= intent.inputSequence
			)
				throw new Error("workflow_completion_intent_commit_conflict");
			if (input.goalCoordinator.reconcile === undefined)
				throw new Error("workflow_completion_intent_projection_recovery_unavailable");
			const replayEvents = replay.events.map((event) => ({
				...event,
				kind: event.payload.kind,
				eventType: event.payload.kind,
			}));
			await input.goalCoordinator.reconcile(input.workflowId, replayEvents);
			const recoveredGoal = input.goalProjection.read();
			if (recoveredGoal.active || recoveredGoal.status !== "complete")
				throw new Error("workflow_completion_intent_goal_projection_recovery_failed");
			await durable.auxiliaryStore.write(
				recordName,
				canonicalJsonBytes({
					...intent,
					status: "committed",
					committedAt: input.now(),
					committedStateDigest: current.sourceJournalDigest,
					committedSequence: current.sourceJournalSequence,
				}),
			);
			return;
		}
		if (
			current.sourceJournalDigest !== intent.inputStateDigest ||
			current.sourceJournalSequence !== intent.inputSequence ||
			current.storeEpoch !== intent.epochRef.storeEpoch ||
			current.coordinatorEpoch !== intent.epochRef.coordinatorEpoch ||
			current.status !== "active" ||
			!current.goalActive ||
			current.goalStatus !== "active"
		)
			throw new Error("workflow_completion_intent_state_conflict");
		const currentGoal = input.goalProjection.read();
		if (digestObject(currentGoal) !== intent.expectedGoalDigest)
			throw new Error("workflow_completion_intent_goal_conflict");
		for (const receipt of intent.receipts) {
			if (!receipt.oneUse || receipt.issuerId !== "workflow-host")
				throw new Error("workflow_completion_intent_receipt_not_one_use");
			await resolveAndVerifyWorkflowHostReceipt({
				context: input.receiptAuthority.receiptContext,
				workflowId: input.workflowId,
				expectedBindingDigest: receipt.bindingDigest,
				receipt,
				currentStateDigest: intent.inputStateDigest,
				currentRevision: intent.inputSequence,
				trustedNow: input.now(),
			});
			await input.receiptAuthority.consume({
				receipt,
				bindingDigest: receipt.bindingDigest,
				currentRevision: intent.inputSequence,
			});
		}
		const leaseRef = durable.currentLeaseRef();
		await input.goalCoordinator.transition({
			workflowId: input.workflowId,
			source: "workflow_completion",
			expectedGoalDigest: intent.expectedGoalDigest,
			payload: {
				kind: "workflow_status_changed",
				status: "complete",
				phase: "auditing_completion",
				reason: intent.reason,
				goalDelta: intent.goalDelta,
			},
			expectedHead: workflowHeadFromState(current),
			expectedEpoch: intent.epochRef,
			leaseRef,
			idempotencyKey: intent.idempotencyKey,
			writerIdentity: leaseRef.writerIdentity,
			executionKey: null,
		});
		const completed = await input.store.reload();
		if (
			completed === null ||
			completed.status !== "complete" ||
			completed.goalStatus !== "complete" ||
			completed.goalActive ||
			completed.sourceJournalSequence <= intent.inputSequence
		)
			throw new Error("workflow_completion_recovery_did_not_commit");
		await durable.auxiliaryStore.write(
			recordName,
			canonicalJsonBytes({
				...intent,
				status: "committed",
				committedAt: input.now(),
				committedStateDigest: completed.sourceJournalDigest,
				committedSequence: completed.sourceJournalSequence,
			}),
		);
	});
}

function createPersistedWorkflowCompletionGate(input: {
	runtimeStore: WorkflowRuntimeStore;
	publicRuntimeStore: WorkflowRuntimeStore;
	publicReceiptContext: WorkflowHostReceiptConsumerContext;
	store: WorkflowStore;
	workflowId: string;
	now: () => string;
	receiptAuthority: PersistedWorkflowReceiptAuthority;
	goalProjection: WorkflowGoalProjectionAdapter;
	goalCoordinator: WorkflowGoalCoordinator;
	readinessAuthorityFactory?: PersistedWorkflowCompletionReadinessAuthorityFactory;
}): WorkflowCompletionGate {
	const durable = input.runtimeStore.durableContext;
	if (durable === undefined) throw new Error("workflow_completion_gate_requires_persisted_runtime");
	const failClosed = (): never => {
		throw new Error("Workflow completion requires the authenticated persisted readiness authority.");
	};
	const readinessAuthority = input.readinessAuthorityFactory
		? input.readinessAuthorityFactory({
				runtimeStore: input.publicRuntimeStore,
				store: input.store,
				workflowId: input.workflowId,
				receiptContext: input.publicReceiptContext,
				artifactResolver: input.publicReceiptContext.artifactResolver,
				issueReceipt: input.receiptAuthority.issue,
				now: input.now,
			})
		: null;
	if (readinessAuthority !== null) {
		if (readinessAuthority.runtimeStore !== input.publicRuntimeStore)
			throw new Error("Workflow completion readiness authority is bound to a different runtime store.");
		for (const method of [
			"resolveReadiness",
			"resolveDigestSources",
			"resolveDecision",
			"validateDecision",
			"validateEvidence",
			"validateScorecard",
			"validateProgress",
			"validateResources",
		] as const) {
			if (typeof readinessAuthority.authority[method] !== "function")
				throw new Error(`Workflow completion readiness authority is missing ${method}.`);
		}
	}
	const resolveReadiness = readinessAuthority?.authority.resolveReadiness ?? (async () => failClosed());
	const resolveDigestSources = readinessAuthority?.authority.resolveDigestSources ?? (async () => failClosed());
	const resolveDecision = readinessAuthority?.authority.resolveDecision ?? (async () => failClosed());
	const validateDecision = readinessAuthority?.authority.validateDecision ?? (async () => failClosed());
	const validateEvidence = readinessAuthority?.authority.validateEvidence ?? (async () => failClosed());
	const validateScorecard = readinessAuthority?.authority.validateScorecard ?? (async () => failClosed());
	const validateProgress = readinessAuthority?.authority.validateProgress ?? (async () => failClosed());
	const validateResources = readinessAuthority?.authority.validateResources ?? (async () => failClosed());
	const dependencies: WorkflowCompletionGateDependencies = {
		resolveCurrentState: () => input.store.reload(),
		resolveCurrentEpoch: async () => {
			const state = await input.store.reload();
			if (state === null) throw new Error("Workflow completion epoch requires a durable workflow state.");
			return { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch };
		},
		resolveReadiness,
		resolveDigestSources,
		resolveArtifact: input.receiptAuthority.receiptContext.artifactResolver,
		resolveDecision,
		validateDecision,
		validateEvidence,
		validateScorecard,
		validateProgress,
		validateResources,
		receiptContext: input.receiptAuthority.receiptContext,
		trustedNow: input.now,
		commitCompletion: async (commit: WorkflowCompletionCommitInput): Promise<WorkflowState> =>
			durable.withExclusiveLease("workflow-completion-authority", async () => {
				const current = await input.store.reload();
				if (
					current === null ||
					current.workflowId !== input.workflowId ||
					current.sourceJournalDigest !== commit.currentState.sourceJournalDigest ||
					current.sourceJournalSequence !== commit.currentState.sourceJournalSequence ||
					current.storeEpoch !== commit.currentEpoch.storeEpoch ||
					current.coordinatorEpoch !== commit.currentEpoch.coordinatorEpoch
				)
					throw new Error("Workflow completion commit lost its authenticated state CAS.");
				const currentGoal = input.goalProjection.read();
				const reason = `completion-gate:${commit.readiness.grantDigest}`;
				const goalDelta = completionGoalDelta(currentGoal, reason);
				const expectedHead = workflowHeadFromState(current);
				const idempotencyKey = digestObject({
					kind: "workflow_completion",
					workflowId: input.workflowId,
					grantDigest: commit.readiness.grantDigest,
				});
				const intentRecordName = generationScopedAuxiliaryRecord(
					WORKFLOW_COMPLETION_INTENT_RECORD,
					durable.generationId,
				);
				const intent: PersistedWorkflowCompletionIntentRecord = {
					version: 1,
					status: "pending",
					generationId: durable.generationId,
					workflowId: input.workflowId,
					grantDigest: commit.readiness.grantDigest,
					inputStateDigest: current.sourceJournalDigest,
					inputSequence: current.sourceJournalSequence,
					epochRef: { ...commit.currentEpoch },
					expectedGoalDigest: digestObject(currentGoal),
					goalDelta,
					reason,
					idempotencyKey,
					receipts: structuredClone(commit.readiness.receipts),
					createdAt: input.now(),
					committedAt: null,
					committedStateDigest: null,
					committedSequence: null,
				};
				await durable.auxiliaryStore.write(intentRecordName, canonicalJsonBytes(intent));
				for (const receipt of commit.readiness.receipts) {
					await input.receiptAuthority.consume({
						receipt,
						bindingDigest: receipt.bindingDigest,
						currentRevision: current.sourceJournalSequence,
					});
				}
				await input.goalCoordinator.transition({
					workflowId: input.workflowId,
					source: "workflow_completion",
					expectedGoalDigest: digestObject(currentGoal),
					payload: {
						kind: "workflow_status_changed",
						status: "complete",
						phase: "auditing_completion",
						reason,
						goalDelta,
					},
					expectedHead,
					expectedEpoch: commit.currentEpoch,
					leaseRef: durable.currentLeaseRef(),
					idempotencyKey,
					writerIdentity: durable.currentLeaseRef().writerIdentity,
					executionKey: null,
				});
				const completed = await input.store.reload();
				if (
					completed === null ||
					completed.status !== "complete" ||
					completed.goalStatus !== "complete" ||
					completed.goalActive ||
					completed.sourceJournalSequence <= current.sourceJournalSequence
				)
					throw new Error("Workflow completion commit did not produce the exact durable complete state.");
				await durable.auxiliaryStore.write(
					intentRecordName,
					canonicalJsonBytes({
						...intent,
						status: "committed",
						committedAt: input.now(),
						committedStateDigest: completed.sourceJournalDigest,
						committedSequence: completed.sourceJournalSequence,
					}),
				);
				return completed;
			}),
	};
	return createWorkflowCompletionGateForStore(input.store, dependencies);
}

function workflowHead(journal: WorkflowJournalImpl, events: readonly WorkflowJournalEvent[]): WorkflowJournalHead {
	const tail = events.at(-1);
	return tail === undefined
		? { workflowId: journal.options.workflowId, sequence: 0, eventDigest: null, epochRef: journal.options.epoch }
		: {
				workflowId: tail.workflowId,
				sequence: tail.sequence,
				eventDigest: tail.eventDigest,
				epochRef:
					tail.payload.kind === "store_generation_fenced" || tail.payload.kind === "coordinator_epoch_fenced"
						? tail.payload.nextEpoch
						: tail.epochRef,
			};
}

function workflowHeadFromState(state: WorkflowState): WorkflowJournalHead {
	return {
		workflowId: state.workflowId,
		sequence: state.sourceJournalSequence,
		eventDigest: state.sourceJournalDigest,
		epochRef: { storeEpoch: state.storeEpoch, coordinatorEpoch: state.coordinatorEpoch },
	};
}

function workflowHeadFromEvents(
	workflowId: string,
	genesisEpoch: WorkflowEpochRef,
	events: readonly WorkflowJournalEvent[],
): WorkflowJournalHead {
	const tail = events.at(-1);
	return tail === undefined
		? { workflowId, sequence: 0, eventDigest: null, epochRef: genesisEpoch }
		: {
				workflowId: tail.workflowId,
				sequence: tail.sequence,
				eventDigest: tail.eventDigest,
				epochRef:
					tail.payload.kind === "store_generation_fenced" || tail.payload.kind === "coordinator_epoch_fenced"
						? tail.payload.nextEpoch
						: tail.epochRef,
			};
}

function wrapAcceptancePersistence(
	host: WorkflowPhaseHost,
	projection: AcceptanceProjection,
	store: WorkflowStore,
	journal: WorkflowJournalImpl,
	withLeaseOperation: <T>(operation: () => Promise<T>) => Promise<T>,
	now: () => string,
	onDispose: () => void | Promise<void>,
): WorkflowPhaseHost {
	let disposed = false;
	const blockGoalAccountingContention = async (): Promise<void> => {
		const blocker = {
			dependencyId: "workflow-goal-accounting",
			conditionDigest: digestObject({
				workflowId: journal.options.workflowId,
				kind: "workflow_append_contention",
			}),
			requiredChange: "workflow_append_contention_reconciled",
			owner: "workflow_host" as const,
			resumeEventKind: "workflow_append_contention_reconciled",
			earliestRetryAt: null,
			evidenceRefs: [],
			recordedAt: now(),
		};
		for (let attempt = 0; attempt < GOAL_ACCOUNTING_BLOCKER_RETRY_LIMIT; attempt += 1) {
			try {
				await host.blockOnExternal(blocker);
				return;
			} catch (error) {
				if (!isStaleGoalAccountingCommit(error)) throw error;
				if (attempt + 1 >= GOAL_ACCOUNTING_BLOCKER_RETRY_LIMIT)
					throw new Error("workflow_goal_accounting_rebase_exhausted", { cause: error });
				await new Promise<void>((resolveDelay) =>
					setTimeout(resolveDelay, GOAL_ACCOUNTING_REBASE_DELAY_MILLISECONDS),
				);
			}
		}
	};
	const accountGoalUsage = async (operation: () => Promise<GoalState>): Promise<GoalState> => {
		try {
			return await operation();
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "workflow_goal_accounting_rebase_exhausted") throw error;
			await blockGoalAccountingContention();
			throw error;
		}
	};
	return {
		execute: (command) => {
			const snapshot = snapshotWorkflowCommand(command);
			return withLeaseOperation(async () => {
				if (snapshot.kind === "start") await projection.stageStart(snapshot.request);
				const result = await host.execute(snapshot);
				await projection.flush(store.snapshot());
				return result;
			});
		},
		status: () => host.status(),
		...(host.accountAssistantUsage === undefined
			? {}
			: {
					accountAssistantUsage: (metering: WorkflowGoalAccountingInput) =>
						withLeaseOperation(() => accountGoalUsage(() => host.accountAssistantUsage!(metering))),
				}),
		...(host.accountContinuation === undefined
			? {}
			: {
					accountContinuation: (metering: WorkflowGoalAccountingInput) =>
						withLeaseOperation(() => accountGoalUsage(() => host.accountContinuation!(metering))),
				}),
		...(host.learningPromotionReceipts === undefined
			? {}
			: {
					learningPromotionReceipts: Object.freeze({
						issue: (request: Parameters<WorkflowLearningPromotionReceiptCapability["issue"]>[0]) =>
							withLeaseOperation(() => host.learningPromotionReceipts!.issue(request)),
						consume: (request: Parameters<WorkflowLearningPromotionReceiptCapability["consume"]>[0]) =>
							withLeaseOperation(() => host.learningPromotionReceipts!.consume(request)),
						consumeAndApply: (
							request: Parameters<WorkflowLearningPromotionReceiptCapability["consumeAndApply"]>[0],
						) => withLeaseOperation(() => host.learningPromotionReceipts!.consumeAndApply(request)),
						rollback: (request: Parameters<WorkflowLearningPromotionReceiptCapability["rollback"]>[0]) =>
							withLeaseOperation(() => host.learningPromotionReceipts!.rollback(request)),
					}),
				}),
		blockOnExternal: (blocker) => withLeaseOperation(() => host.blockOnExternal(blocker)),
		resumeBlocked: (event) => withLeaseOperation(() => host.resumeBlocked(event)),
		runOutcome: (outcome) => withLeaseOperation(() => host.runOutcome(outcome)),
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await onDispose();
			await host.dispose?.();
			await journal.descriptorContext.workflow.close().catch(() => undefined);
			await journal.descriptorContext.root.close().catch(() => undefined);
		},
	};
}

async function writeSideRecord(
	descriptorFs: WorkflowDescriptorFs,
	artifactRoot: string,
	workflowId: string,
	fileName: string,
	value: unknown,
): Promise<void> {
	const root = await descriptorFs.openRoot(artifactRoot);
	let workflows: WorkflowDescriptorHandle | undefined;
	let workflow: WorkflowDescriptorHandle | undefined;
	let side: WorkflowDescriptorHandle | undefined;
	let temporary: WorkflowDescriptorHandle | undefined;
	try {
		workflows = await descriptorFs.openAt(
			root,
			"workflows",
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
			PRIVATE_DIRECTORY_MODE,
		);
		workflow = await descriptorFs.openAt(
			workflows,
			workflowId,
			fsConstants.O_RDONLY | fsConstants.O_DIRECTORY,
			PRIVATE_DIRECTORY_MODE,
		);
		side = await openOrCreateDirectory(descriptorFs, workflow, "side-records");
		const temporaryName = `.${fileName}.${randomUUID()}.tmp`;
		temporary = await descriptorFs.openAt(
			side,
			temporaryName,
			fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
			PRIVATE_FILE_MODE,
		);
		await temporary.write(canonicalJsonBytes(value));
		await temporary.sync();
		await temporary.close();
		temporary = undefined;
		await descriptorFs.renameAt(side, temporaryName, fileName, { replace: true, noReplace: false });
		await descriptorFs.syncDirectoryChain(side, root);
	} finally {
		await temporary?.close().catch(() => undefined);
		await side?.close().catch(() => undefined);
		await workflow?.close().catch(() => undefined);
		await workflows?.close().catch(() => undefined);
		await root.close().catch(() => undefined);
	}
}

async function readWorkflowSideRecord(
	descriptorFs: WorkflowDescriptorFs,
	artifactRoot: string,
	workflowId: string,
	fileName: string,
): Promise<Uint8Array | null> {
	const root = await descriptorFs.openRoot(artifactRoot);
	try {
		return await readDescriptorFileAt(descriptorFs, root, ["workflows", workflowId, "side-records", fileName]);
	} finally {
		await root.close().catch(() => undefined);
	}
}

function hmac(secret: Uint8Array, value: unknown): string {
	return createHmac("sha256", secret).update(canonicalJsonBytes(value)).digest("hex");
}

function verifyHmac(secret: Uint8Array, value: unknown, actual: string): boolean {
	if (!/^[0-9a-f]{64}$/.test(actual)) return false;
	const expected = Buffer.from(hmac(secret, value), "hex");
	const received = Buffer.from(actual, "hex");
	return timingSafeEqual(expected, received);
}

function cloneAcceptance(value: WorkflowAcceptanceState | null): WorkflowAcceptanceState | null {
	return value === null
		? null
		: {
				acceptanceCheckIds: [...value.acceptanceCheckIds],
				protectedInvariantIds: [...value.protectedInvariantIds],
				goalContract:
					value.goalContract === undefined || value.goalContract === null
						? null
						: structuredClone(value.goalContract),
			};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeWorkflowDecisionRefs(
	refs: readonly DurableDecisionRef[],
	workflowId: string,
	rootSessionId: string,
	epochRef: WorkflowEpochRef,
): readonly WorkflowDecisionRef[] {
	return refs.map((ref) => {
		if (ref.decisionScope.kind !== "workflow" || ref.decisionScope.workflowId !== workflowId)
			throw new Error("Workflow approval decision reference is outside the authenticated workflow scope.");
		return {
			...ref,
			decisionScope: { kind: "workflow" as const, workflowId, rootSessionId },
			coordinatorEpoch: epochRef.coordinatorEpoch,
		};
	});
}

function decodeWorkflowReceiptKeyRecord(value: Uint8Array): {
	keyId: string;
	privateKey: KeyObject;
	publicKey: KeyObject;
} {
	const parsed = parseCanonicalJsonBytes(value);
	if (
		!isRecord(parsed) ||
		parsed.version !== 1 ||
		typeof parsed.keyId !== "string" ||
		parsed.keyId.length === 0 ||
		typeof parsed.privateKey !== "string" ||
		typeof parsed.publicKey !== "string"
	)
		throw new Error("workflow_receipt_key_record_corrupt");
	try {
		return {
			keyId: parsed.keyId,
			privateKey: createPrivateKey({ key: Buffer.from(parsed.privateKey, "base64"), format: "der", type: "pkcs8" }),
			publicKey: createPublicKey({ key: Buffer.from(parsed.publicKey, "base64"), format: "der", type: "spki" }),
		};
	} catch (error) {
		throw new Error("workflow_receipt_key_record_corrupt", { cause: error });
	}
}

function isPersistedWorkflowReceiptConsumptionRecord(
	value: unknown,
): value is PersistedWorkflowReceiptConsumptionRecord {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.witnesses)) return false;
	return Object.values(value.witnesses).every(
		(witness) =>
			isRecord(witness) &&
			typeof witness.receiptId === "string" &&
			typeof witness.workflowId === "string" &&
			typeof witness.bindingDigest === "string" &&
			(witness.capability === null
				? witness.resourceDigest === null && witness.operationDigest === null
				: isWorkflowReceiptCapability(witness.capability) &&
					isDigestString(witness.resourceDigest) &&
					isDigestString(witness.operationDigest)) &&
			isDigestString(witness.receiptDigest) &&
			typeof witness.consumedAt === "string" &&
			typeof witness.consumptionSequence === "number" &&
			Number.isSafeInteger(witness.consumptionSequence) &&
			witness.consumptionSequence > 0,
	);
}

function isPersistedWorkflowReceiptIssuanceRecord(value: unknown): value is PersistedWorkflowReceiptIssuanceRecord {
	return (
		isRecord(value) &&
		value.version === 1 &&
		isRecord(value.receipts) &&
		Object.values(value.receipts).every(
			(receipt) =>
				isRecord(receipt) &&
				typeof receipt.receiptId === "string" &&
				typeof receipt.workflowId === "string" &&
				isDigestString(receipt.bindingDigest) &&
				(receipt.capability === null
					? receipt.resourceDigest === null && receipt.operationDigest === null
					: isWorkflowReceiptCapability(receipt.capability) &&
						isDigestString(receipt.resourceDigest) &&
						isDigestString(receipt.operationDigest)) &&
				isDigestString(receipt.receiptDigest),
		)
	);
}

function isPersistedWorkflowReceiptRevocationRecord(value: unknown): value is PersistedWorkflowReceiptRevocationRecord {
	return (
		isRecord(value) &&
		value.version === 1 &&
		Array.isArray(value.receiptIds) &&
		value.receiptIds.every(
			(receiptId) => typeof receiptId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(receiptId),
		)
	);
}

function isPersistedWorkflowCompletionIntentRecord(value: unknown): value is PersistedWorkflowCompletionIntentRecord {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		(value.status !== "pending" && value.status !== "committed") ||
		typeof value.generationId !== "string" ||
		typeof value.workflowId !== "string" ||
		!isDigestString(value.grantDigest) ||
		!isDigestString(value.inputStateDigest) ||
		!isSafePositiveInteger(value.inputSequence) ||
		!isEpochRef(value.epochRef) ||
		!isDigestString(value.expectedGoalDigest) ||
		!isWorkflowGoalMutationDelta(value.goalDelta) ||
		typeof value.reason !== "string" ||
		typeof value.idempotencyKey !== "string" ||
		!Array.isArray(value.receipts) ||
		!value.receipts.every(isWorkflowVerifiedReceiptRecord) ||
		typeof value.createdAt !== "string" ||
		!Number.isFinite(Date.parse(value.createdAt)) ||
		(value.committedAt !== null &&
			(typeof value.committedAt !== "string" || !Number.isFinite(Date.parse(value.committedAt)))) ||
		(value.committedStateDigest !== null && !isDigestString(value.committedStateDigest)) ||
		(value.committedSequence !== null && !isSafePositiveInteger(value.committedSequence))
	)
		return false;
	return (
		(value.status === "pending" &&
			value.committedAt === null &&
			value.committedStateDigest === null &&
			value.committedSequence === null) ||
		(value.status === "committed" &&
			value.committedAt !== null &&
			value.committedStateDigest !== null &&
			value.committedSequence !== null)
	);
}

function isWorkflowGoalMutationDelta(value: unknown): value is WorkflowGoalMutationDelta {
	return (
		isRecord(value) &&
		(value.goalId === null || typeof value.goalId === "string") &&
		(value.objective === null || typeof value.objective === "string") &&
		typeof value.active === "boolean" &&
		typeof value.status === "string" &&
		new Set(["idle", "active", "paused", "budget_limited", "failed", "blocked", "complete", "error"]).has(
			value.status,
		) &&
		(value.tokenBudget === null || isSafeNonNegativeInteger(value.tokenBudget)) &&
		isSafeNonNegativeInteger(value.tokensUsed) &&
		typeof value.timeUsedSeconds === "number" &&
		Number.isFinite(value.timeUsedSeconds) &&
		isSafeNonNegativeInteger(value.continuationsUsed) &&
		(value.createdAt === null || typeof value.createdAt === "number") &&
		(value.updatedAt === null || typeof value.updatedAt === "number") &&
		(value.lastReason === null || typeof value.lastReason === "string") &&
		(value.lastError === null || typeof value.lastError === "string")
	);
}

function isWorkflowVerifiedReceiptRecord(value: unknown): value is WorkflowVerifiedHostReceipt {
	return (
		isRecord(value) &&
		typeof value.receiptKind === "string" &&
		typeof value.oneUse === "boolean" &&
		typeof value.receiptId === "string" &&
		typeof value.issuerId === "string" &&
		typeof value.workflowId === "string" &&
		isDigestString(value.bindingDigest) &&
		isDigestString(value.payloadDigest) &&
		isArtifactRefRecord(value.artifactRef) &&
		typeof value.issuedAt === "string" &&
		typeof value.validUntil === "string" &&
		typeof value.keyId === "string" &&
		value.signatureAlgorithm === "ed25519" &&
		typeof value.signature === "string" &&
		isDigestString(value.verificationDigest) &&
		isDigestString(value.artifactBytesDigest) &&
		isDigestString(value.stateDigest) &&
		isSafePositiveInteger(value.revision) &&
		(value.capabilityBinding === undefined || isWorkflowReceiptCapabilityBinding(value.capabilityBinding))
	);
}

function isArtifactRefRecord(value: unknown): value is WorkflowArtifactRef {
	return (
		isRecord(value) &&
		typeof value.artifactId === "string" &&
		typeof value.relativePath === "string" &&
		isDigestString(value.digest) &&
		isSafeNonNegativeInteger(value.sizeBytes) &&
		isSafeNonNegativeInteger(value.sourceEventSequence)
	);
}

function isDigestString(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isSafePositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPersistedWorkflowApprovalAuxiliaryRecord(value: unknown): value is PersistedWorkflowApprovalAuxiliaryRecord {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.delivered) || !isRecord(value.invalidations))
		return false;
	if (!Object.values(value.delivered).every((proof) => typeof proof === "string" && proof.length > 0)) return false;
	return Object.values(value.invalidations).every(
		(invalidation) =>
			isRecord(invalidation) &&
			typeof invalidation.approvalRequestId === "string" &&
			typeof invalidation.workflowId === "string" &&
			typeof invalidation.headDigest === "string" &&
			typeof invalidation.stateDigest === "string" &&
			Number.isSafeInteger(invalidation.storeEpoch) &&
			Number.isSafeInteger(invalidation.coordinatorEpoch) &&
			Number.isSafeInteger(invalidation.responseSequence) &&
			typeof invalidation.reason === "string" &&
			typeof invalidation.eventDigest === "string",
	);
}

function isPersistedWorkflowApprovalAuthorityRecord(value: unknown): value is PersistedWorkflowApprovalAuthorityRecord {
	return (
		isRecord(value) &&
		value.version === 1 &&
		value.kind === "workflow_approval_authority" &&
		typeof value.workflowId === "string" &&
		typeof value.generationId === "string" &&
		/^generation-[0-9a-f]{32}$/u.test(value.generationId) &&
		isEpochRef(value.epochRef) &&
		typeof value.keyId === "string" &&
		isDigestString(value.stateDigest) &&
		isPersistedWorkflowApprovalAuxiliaryRecord(value.state) &&
		isDigestString(value.sideRecordMac)
	);
}

function isDeferredEventOwnerValidators(value: WorkflowDeferredEventOwnerValidators): boolean {
	return (
		typeof value.autoresearch === "function" &&
		typeof value.runtime === "function" &&
		typeof value.effect === "function" &&
		typeof value.recovery === "function"
	);
}

function isEpochRef(value: unknown): value is WorkflowEpochRef {
	return (
		isRecord(value) &&
		typeof value.storeEpoch === "number" &&
		Number.isSafeInteger(value.storeEpoch) &&
		value.storeEpoch > 0 &&
		typeof value.coordinatorEpoch === "number" &&
		Number.isSafeInteger(value.coordinatorEpoch) &&
		value.coordinatorEpoch > 0
	);
}

function isWorkflowReceiptCapability(value: unknown): value is WorkflowHostReceiptCapability {
	return (
		typeof value === "string" &&
		new Set<WorkflowHostReceiptCapability>([
			"workflow_observation_process",
			"workflow_observation_dataset_receipt",
			"workflow_coordinator_status_projection",
			"workflow_checkpoint_budget_observation",
			"workflow_dispatch_capacity_attestation",
			"workflow_dispatch_path_attestation",
			"workflow_worker_model_dispatch",
			"workflow_recursive_delegation_plan",
			"workflow_decision_packet_delivery",
			"autoresearch_portfolio_frontier_admission",
			"autoresearch_portfolio_projection_commit",
			"portfolio_default_completion",
			"workflow_learning_knowledge_promotion",
			"autoresearch.legacy_scalar_provenance_import",
			"workflow_intent_red_mutation",
			"child_output_delivery_ack",
			"workflow_coordinator_obligation_scheduler",
		]).has(value as WorkflowHostReceiptCapability)
	);
}

function isWorkflowReceiptCapabilityBinding(value: unknown): value is WorkflowHostReceiptCapabilityBinding {
	return (
		isRecord(value) &&
		isWorkflowReceiptCapability(value.capability) &&
		isDigestString(value.resourceDigest) &&
		isDigestString(value.operationDigest) &&
		(value.executionIdentity === null || typeof value.executionIdentity === "string") &&
		(value.sessionId === null || typeof value.sessionId === "string")
	);
}

function isJournalHead(value: unknown): value is WorkflowJournalHead {
	return (
		isRecord(value) &&
		typeof value.workflowId === "string" &&
		typeof value.sequence === "number" &&
		Number.isSafeInteger(value.sequence) &&
		value.sequence >= 0 &&
		(value.eventDigest === null || typeof value.eventDigest === "string") &&
		isEpochRef(value.epochRef)
	);
}

function isLeaseRef(value: unknown): value is WorkflowLeaseRef {
	return (
		isRecord(value) &&
		isEpochRef(value) &&
		typeof value.leaseId === "string" &&
		typeof value.acquisitionEventSequence === "number" &&
		Number.isSafeInteger(value.acquisitionEventSequence) &&
		value.acquisitionEventSequence > 0 &&
		typeof value.processIdentity === "string" &&
		typeof value.rootDigest === "string" &&
		typeof value.writerIdentity === "string" &&
		typeof value.acquiredAt === "string" &&
		typeof value.expiresAt === "string"
	);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}
