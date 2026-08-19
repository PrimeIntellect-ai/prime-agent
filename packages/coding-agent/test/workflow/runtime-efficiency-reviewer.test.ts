import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import type {
	WorkflowArtifactRef,
	WorkflowArtifactResolver,
	WorkflowEfficiencyRedTeamInvocation,
	WorkflowEfficiencyRedTeamResult,
	WorkflowEfficiencyRedTeamSnapshot,
	WorkflowEfficiencyReviewSchedule,
	WorkflowEpochRef,
	WorkflowLeaseRef,
	WorkflowResourceAdmission,
	WorkflowResourceVector,
	WorkflowRevisionBoundaryContext,
	WorkflowZeroControlCapacityVector,
} from "../../src/core/workflow/contracts.js";
import { canonicalJsonBytes, digestObject, sha256Hex } from "../../src/core/workflow/contracts.js";
import {
	createWorkflowEfficiencyRedTeamReviewer,
	createWorkflowEfficiencyRedTeamRuntime,
	createWorkflowEfficiencyRedTeamRuntimeForStore,
	type WorkflowEfficiencyRedTeamRuntimeDependencies,
	type WorkflowReadOnlyEfficiencyRedTeamToken,
	workflowEfficiencyReviewScheduleDigest,
} from "../../src/core/workflow/efficiency-reviewer.js";

const EPOCH: WorkflowEpochRef = { storeEpoch: 1, coordinatorEpoch: 1 };

function ref(label: string): WorkflowArtifactRef {
	const bytes = new TextEncoder().encode(label);
	return {
		artifactId: label,
		relativePath: `artifacts/${label}`,
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function leaseRef(label: string): WorkflowLeaseRef {
	return {
		...EPOCH,
		leaseId: label,
		acquisitionEventSequence: 1,
		processIdentity: `process-${label}`,
		rootDigest: "root-digest",
		writerIdentity: "writer",
		acquiredAt: "2030-01-01T00:00:00.000Z",
		expiresAt: "2030-01-01T01:00:00.000Z",
	};
}

function revisionContext(executionKey: string | null): WorkflowRevisionBoundaryContext {
	const context = {
		workflowId: "workflow-efficiency-test",
		epochRef: EPOCH,
		leaseRef: leaseRef("revision"),
		executionKey,
		revisionTuple: {
			contractRevision: 1,
			scorecardRevision: 1,
			planRevision: 1,
			configRevision: 1,
			evidenceRevision: 1,
		},
		revisionRegistryRef: ref("revision-registry"),
		revisionRegistryDigest: ref("revision-registry").digest,
		configSnapshotDigest: "config-digest",
	};
	return { ...context, tupleDigest: digestObject(context) };
}

function vector(overrides: Partial<WorkflowResourceVector> = {}): WorkflowResourceVector {
	return {
		cpuMilliCores: 1,
		memoryBytes: 1,
		diskBytes: 1,
		ioWeight: 1,
		accelerators: [],
		providers: [],
		networkEgressBytes: 0,
		wallMilliseconds: 1,
		monetaryMicrounits: 1,
		...overrides,
	};
}

function zeroControl(): WorkflowZeroControlCapacityVector {
	return {
		processSlots: 0,
		childSessionSlots: 0,
		modelCallSlots: 0,
		modelInputTokens: 0,
		modelOutputTokens: 0,
		verificationSlots: 0,
		redTeamSlots: 0,
		recoverySlots: 0,
	};
}

function resourceAdmission(): WorkflowResourceAdmission {
	const ledgerRef = ref("ledger");
	const control = zeroControl();
	return {
		capacityGrant: {
			kind: "worker",
			grantId: "review-grant",
			resourceVector: vector(),
			controlCapacity: control,
			canonicalPoolLedgerRef: ledgerRef,
			grantDigest: "grant-digest",
		},
		canonicalPoolLedgerRef: ledgerRef,
		controlCapacity: control,
		controlCapacityProjectionDigest: "control-projection-digest",
		declaredVector: vector(),
		hostDerivedConservativeVector: vector(),
		reservedVector: vector(),
		declaredControlCapacity: control,
		hostDerivedControlCapacity: control,
		reservedControlCapacity: control,
		derivationPolicyDigest: "derivation-policy-digest",
		enforcementClass: "host_bounded",
		unknownPoolIds: [],
		canonicalLedgerRef: ledgerRef,
		canonicalLedgerDigest: ledgerRef.digest,
		admitted: true,
		admissionDigest: "admission-digest",
	};
}

function scheduleManifestRef(value: WorkflowEfficiencyReviewSchedule): WorkflowArtifactRef {
	const {
		scheduleDigest: _scheduleDigest,
		lastRunAt: _lastRunAt,
		lastAdmittedWindowSequence: _lastAdmittedWindowSequence,
		lastAdmittedWindowId: _lastAdmittedWindowId,
		status: _status,
		...immutable
	} = value;
	const bytes = canonicalJsonBytes(immutable);
	return {
		artifactId: "schedule-manifest",
		relativePath: "artifacts/schedule-manifest",
		digest: sha256Hex(bytes),
		sizeBytes: bytes.byteLength,
		sourceEventSequence: 1,
	};
}

function snapshotArtifactResolver(): WorkflowArtifactResolver {
	return {
		resolve: async (artifactRef: WorkflowArtifactRef) => {
			const bytes = new TextEncoder().encode(artifactRef.artifactId);
			return {
				envelope: {
					ref: artifactRef,
					payloadKind: "evidence",
					codec: "utf8",
					immutable: true,
				},
				exists: true,
				bytes,
				verifiedDigest: artifactRef.digest,
				verifiedSizeBytes: artifactRef.sizeBytes,
			};
		},
	};
}

function schedule(overrides: Partial<WorkflowEfficiencyReviewSchedule> = {}): WorkflowEfficiencyReviewSchedule {
	const value: WorkflowEfficiencyReviewSchedule = {
		workflowId: "workflow-efficiency-test",
		scheduleId: "schedule-1",
		revision: 1,
		epochRef: EPOCH,
		nextDueAt: "2030-01-01T00:00:00.000Z",
		lastRunAt: null,
		minimumCadenceMilliseconds: 60_000,
		maximumCadenceMilliseconds: 3_600_000,
		overheadBudgetMicrounits: 10,
		idempotencyWindowMilliseconds: 60_000,
		dutyCycleCapMicrounits: 10,
		perWindowOverheadCapMicrounits: 10,
		perPhaseOverheadCapMicrounits: 10,
		perWorkflowOverheadCapMicrounits: 100,
		dedicatedControlReserve: {
			processSlots: 1,
			childSessionSlots: 1,
			modelCallSlots: 1,
			modelInputTokens: 1,
			modelOutputTokens: 1,
			verificationSlots: 1,
			redTeamSlots: 1,
			recoverySlots: 1,
		},
		approvedResourceEnvelopeDigest: ref("envelope").digest,
		trustedClockSourceRef: ref("clock"),
		triggerSet: ["task_terminal", "incident", "result_transition"],
		approvedDecisionRef: {
			decisionScope: {
				kind: "workflow",
				workflowId: "workflow-efficiency-test",
				rootSessionId: "root-session",
			},
			decisionId: "decision-1",
			revision: 1,
			storeEpoch: EPOCH.storeEpoch,
			coordinatorEpoch: EPOCH.coordinatorEpoch,
			decisionDigest: "decision-digest",
		},
		approvalReceipt: {
			receiptKind: "decision",
			oneUse: false,
			receiptId: "receipt-1",
			issuerId: "host",
			workflowId: "workflow-efficiency-test",
			bindingDigest: "binding-digest",
			payloadDigest: "payload-digest",
			artifactRef: ref("approval-receipt"),
			issuedAt: "2030-01-01T00:00:00.000Z",
			validUntil: "2030-01-01T01:00:00.000Z",
			keyId: "key-1",
			signatureAlgorithm: "ed25519",
			artifactBytesDigest: ref("approval-receipt").digest,
			stateDigest: "state-digest",
			revision: 1,
			signature: "signature",
			verificationDigest: "verification-digest",
		},
		resourceEnvelopeRef: ref("envelope"),
		capacityRegistryRef: ref("capacity"),
		wallCeilingMilliseconds: 1_000,
		tokenCeiling: 1_000,
		costCeilingMicrounits: 10,
		status: "scheduled",
		trustedClockSourceDigest: ref("clock").digest,
		clockObservationRef: ref("clock-observation"),
		lastAdmittedWindowSequence: 0,
		lastAdmittedWindowId: null,
		cadenceMilliseconds: 60_000,
		majorTransitionTriggers: ["task_terminal", "incident", "result_transition"],
		maxReviewsPerWindow: 1,
		maxReviewsPerPhase: 2,
		maxReviewsPerWorkflow: 10,
		dutyCycleCapPermille: 100,
		overlapPolicy: "reject",
		catchUpAfterRestart: "one",
		reviewResourceAdmission: resourceAdmission(),
		maxReviewWallMilliseconds: 1_000,
		maxReviewTokens: 1_000,
		maxReviewCostMicrounits: 10,
		scheduleBoundsDigest: "bounds-digest",
		scheduleDigest: "schedule-digest",
		reservePartitions: {
			planner: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
			verifier: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
			redTeam: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
			recovery: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
			control: {
				processSlots: 0,
				childSessionSlots: 0,
				modelCallSlots: 0,
				modelInputTokens: 0,
				modelOutputTokens: 0,
				verificationSlots: 0,
				redTeamSlots: 0,
				recoverySlots: 0,
			},
		},
		reserveLedgerRef: ref("ledger"),
		reserveLedgerDigest: ref("ledger").digest,
		...overrides,
	};
	return { ...value, scheduleDigest: workflowEfficiencyReviewScheduleDigest(value) };
}

function snapshot(reviewId: string): WorkflowEfficiencyRedTeamSnapshot {
	const value: WorkflowEfficiencyRedTeamSnapshot = {
		workflowId: "workflow-efficiency-test",
		reviewId,
		scheduleId: "schedule-1",
		windowId: "window-1",
		sourceJournalSequence: 1,
		sourceJournalDigest: "journal-digest",
		workflowStateDigest: "state-digest",
		originalObjectiveRef: ref("objective"),
		originalObjectiveDigest: ref("objective").digest,
		hardenedGoalContractRef: ref("contract"),
		hardenedGoalContractDigest: ref("contract").digest,
		scorecardRef: ref("scorecard"),
		scorecardDigest: ref("scorecard").digest,
		protectedInvariantRefs: [ref("invariant")],
		protectedInvariantDigest: ref("invariant").digest,
		planRef: ref("plan"),
		planDigest: ref("plan").digest,
		criticalPathCertificateRef: ref("critical-path"),
		criticalPathCertificateDigest: ref("critical-path").digest,
		configurationRef: ref("config"),
		configurationDigest: ref("config").digest,
		evaluatorRef: ref("evaluator"),
		evaluatorDigest: ref("evaluator").digest,
		guardRef: null,
		guardDigest: null,
		revisionRegistryRef: ref("registry"),
		revisionRegistryDigest: ref("registry").digest,
		snapshotRef: ref("snapshot"),
		publicationEnvelopeRef: ref("publication"),
		publicationEnvelopeDigest: ref("publication").digest,
		hostDereferenceProofRef: ref("dereference-proof"),
		staleRejectionPolicyDigest: "stale-policy-digest",
		criticalPathTaskIds: [],
		readyQueueTaskIds: [],
		liveResourceLeaseRefs: [],
		liveOwnershipLeaseRefs: [],
		costEvidenceRefs: [],
		throughputEvidenceRefs: [],
		latencyEvidenceRefs: [],
		acceptedProgressEvidenceRefs: [],
		evidenceGapRefs: [],
		uncertaintyEvidenceRefs: [],
		controlPlaneReserve: vector(),
		controlPlaneReserveCapacity: schedule().dedicatedControlReserve,
		canonicalPoolLedgerRef: ref("ledger"),
		canonicalPoolLedgerDigest: ref("ledger").digest,
		authenticatedCapacitySnapshotRefs: {} as WorkflowEfficiencyRedTeamSnapshot["authenticatedCapacitySnapshotRefs"],
		envelopeDigest: "envelope-digest",
		snapshotDigest: "",
	};
	const { snapshotDigest: _snapshotDigest, snapshotRef: _snapshotRef, ...snapshotContent } = value;
	return { ...value, snapshotDigest: digestObject(snapshotContent) };
}

function snapshotWith(
	reviewId: string,
	overrides: Partial<WorkflowEfficiencyRedTeamSnapshot>,
): WorkflowEfficiencyRedTeamSnapshot {
	const value = { ...snapshot(reviewId), ...overrides };
	const { snapshotDigest: _snapshotDigest, snapshotRef: _snapshotRef, ...snapshotContent } = value;
	return { ...value, snapshotDigest: digestObject(snapshotContent) };
}

function createRuntime(overrides: Partial<WorkflowEfficiencyRedTeamRuntimeDependencies> = {}): {
	runtime: ReturnType<typeof createWorkflowEfficiencyRedTeamRuntime>;
	review: ReturnType<typeof vi.fn>;
	recordedEvents: string[];
} {
	const approved = schedule();
	const configuredApproved = overrides.approvedSchedule ?? approved;
	const approvedManifestRef = scheduleManifestRef(configuredApproved);
	const recordedEvents: string[] = [];
	const review = vi.fn(
		async (invocation: { reviewId: string }) =>
			({
				kind: "success",
				reviewId: invocation.reviewId,
				invocationRef: ref(`invocation-${invocation.reviewId}`),
				suggestionRef: ref(`suggestion-${invocation.reviewId}`),
				actualUsage: vector(),
				completedAt: "2030-01-01T00:00:01.000Z",
				resultDigest: `result-${invocation.reviewId}`,
			}) as unknown as WorkflowEfficiencyRedTeamResult,
	);
	const replayEvents: unknown[] = [];
	const claimedWindows = new Set<string>();
	const consumedTokens = new Set<string>();
	const rootHostAppendBoundary = vi.fn(
		async (input: {
			eventKind: string;
			dueWindowId: string;
			schedule?: WorkflowEfficiencyReviewSchedule;
			result?: WorkflowEfficiencyRedTeamResult;
			hostMeasuredUsage?: WorkflowResourceVector;
			expectedHead?: unknown;
		}) => {
			recordedEvents.push(input.eventKind);
			const payload = {
				kind: input.eventKind,
				workflowId: approved.workflowId,
				epochRef: EPOCH,
				dueWindowId: input.dueWindowId,
				scheduleDigest: input.schedule?.scheduleDigest,
				expectedHead: input.expectedHead,
				expectedHeadDigest: digestObject(input.expectedHead),
				result: input.result,
				hostMeasuredUsage: input.hostMeasuredUsage,
			};
			replayEvents.push({ payload });
			return {
				payload,
				committed: { payload, expectedHead: { sequence: replayEvents.length - 1 } },
				reviewState: { scheduleId: approved.scheduleId, windowId: input.dueWindowId },
				disposition: "committed",
			} as unknown as WorkflowEfficiencyRedTeamInvocation;
		},
	);
	const invocationFactory = vi.fn(
		async () =>
			({
				reviewId: "review-1",
				snapshotRef: ref("snapshot"),
				epochRef: EPOCH,
				executionKey: "review-execution",
				actualUsage: vector(),
			}) as never,
	);
	const artifactResolver = {
		resolve: async (artifactRef: WorkflowArtifactRef) => {
			if (artifactRef.digest === configuredApproved.scheduleDigest) {
				const {
					scheduleDigest: _scheduleDigest,
					lastRunAt: _lastRunAt,
					lastAdmittedWindowSequence: _lastAdmittedWindowSequence,
					lastAdmittedWindowId: _lastAdmittedWindowId,
					status: _status,
					...immutable
				} = configuredApproved;
				const bytes = canonicalJsonBytes(immutable);
				return {
					envelope: {
						ref: artifactRef,
						payloadKind: "evidence",
						codec: "canonical_json",
						immutable: true,
					},
					exists: true,
					bytes,
					verifiedDigest: sha256Hex(bytes),
					verifiedSizeBytes: bytes.byteLength,
				};
			}
			const bytes = new TextEncoder().encode(artifactRef.artifactId);
			return {
				envelope: {
					ref: artifactRef,
					payloadKind: "evidence",
					codec: "utf8",
					immutable: true,
				},
				exists: true,
				bytes,
				verifiedDigest: artifactRef.digest,
				verifiedSizeBytes: artifactRef.sizeBytes,
			};
		},
	};
	const dependencies = {
		approvedSchedule: approved,
		reviewer: { review },
		trustedNow: () => "2030-01-01T00:00:00.000Z",
		trustedMonotonicNow: () => 0,
		readActiveLeaseContext: async () => ({ epochRef: EPOCH, workflowId: approved.workflowId }) as never,
		reviewStore: {
			replay: async () => ({ events: replayEvents, head: { sequence: replayEvents.length - 1 } }),
		} as never,
		durableWindowTransaction: {
			claimWindow: async (input: {
				workflowId: string;
				epochRef: WorkflowEpochRef;
				dueWindowId: string;
				scheduleDigest: string;
			}) => {
				const key = `${input.workflowId}:${input.epochRef.storeEpoch}:${input.epochRef.coordinatorEpoch}:${input.dueWindowId}:${input.scheduleDigest}`;
				if (claimedWindows.has(key)) return "already_claimed" as const;
				claimedWindows.add(key);
				return "claimed" as const;
			},
			consumeToken: async (input: {
				workflowId: string;
				epochRef: WorkflowEpochRef;
				tokenId: string;
				dueWindowId: string;
				scheduleDigest: string;
			}) => {
				const key = `${input.workflowId}:${input.epochRef.storeEpoch}:${input.epochRef.coordinatorEpoch}:${input.tokenId}:${input.dueWindowId}:${input.scheduleDigest}`;
				if (consumedTokens.has(key)) return "already_consumed" as const;
				consumedTokens.add(key);
				return "consumed" as const;
			},
		},
		rootHostAppendBoundary,
		snapshotResolver: async (invocation: { reviewId: string }) => snapshot(invocation.reviewId),
		scheduleManifestRef: approvedManifestRef,
		scheduleArtifactResolver: artifactResolver,
		reviewInvocationFactory: invocationFactory,
		readOnlyCapabilityProofResolver: async () => ref("read-only-proof"),
		snapshotArtifactResolver: artifactResolver,
		readUsage: async () => vector(),
		overheadReserve: vector(),
		readRevisionBoundaryContext: async (
			_workflowId: string,
			_epochRef: WorkflowEpochRef,
			executionKey: string | null,
		) => revisionContext(executionKey),
		revisionRegistry: {
			assertActive: vi.fn(async () => undefined),
		},
		...overrides,
	} as unknown as WorkflowEfficiencyRedTeamRuntimeDependencies;
	return { runtime: createWorkflowEfficiencyRedTeamRuntime(dependencies), review, recordedEvents };
}

interface EfficiencyChildRunInput {
	readonly role: "a" | "b";
	readonly artifactRoot: string;
	readonly rootSessionId: string;
	readonly workflowId: string;
	readonly writerIdentity: string;
	readonly schedule: WorkflowEfficiencyReviewSchedule;
	readonly scheduleManifestRef: WorkflowArtifactRef;
	readonly snapshot: WorkflowEfficiencyRedTeamSnapshot;
	readonly epochRef: WorkflowEpochRef;
}

interface EfficiencyChildRunResult {
	readonly role: "a" | "b";
	readonly result: WorkflowEfficiencyRedTeamResult;
	readonly eventKinds: readonly string[];
	readonly windowId: string;
	readonly tokenId: string;
	readonly report: {
		readonly dueWindowId: string;
		readonly invocationTokenDigest: string;
		readonly suggestion: WorkflowArtifactRef;
	};
	readonly durableWindowIds: readonly string[];
	readonly durableTokenIds: readonly string[];
	readonly mutationSurface: readonly string[];
	readonly forbiddenBoundaryAttempts: number;
	readonly reviewerCalls: number;
	readonly reallocationConsumerCalls: number;
	readonly forgedEventCodes: readonly string[];
	readonly consumedProposal: {
		readonly workflowId: string;
		readonly dueWindowId: string;
		readonly suggestionId: string;
		readonly recommendedAllocationRef: WorkflowArtifactRef;
		readonly sourceSequence: number;
		readonly sourceDigest: string | null;
	} | null;
}

async function runEfficiencyChild(input: EfficiencyChildRunInput): Promise<EfficiencyChildRunResult> {
	const efficiencyModule = pathToFileURL(`${process.cwd()}/src/core/workflow/efficiency-reviewer.ts`).href;
	const admissionModule = pathToFileURL(`${process.cwd()}/src/core/workflow/admission.ts`).href;
	const contractsModule = pathToFileURL(`${process.cwd()}/src/core/workflow/contracts.ts`).href;
	const goalsModule = pathToFileURL(`${process.cwd()}/src/core/goals.ts`).href;
	const hostModule = pathToFileURL(`${process.cwd()}/src/core/workflow/session-host-factory.ts`).href;
	const primeFixtureModule = pathToFileURL(`${process.cwd()}/test/workflow/prime-loop-fixtures.ts`).href;
	const childSource = `
import { emptyGoalState } from ${JSON.stringify(goalsModule)};
import { commitAuthenticated } from ${JSON.stringify(admissionModule)};
import { canonicalJsonBytes, digestObject, sha256Hex } from ${JSON.stringify(contractsModule)};
import { createPrimeWorkflowFixture } from ${JSON.stringify(primeFixtureModule)};
import {
  createWorkflowEfficiencyRedTeamReviewer,
  createWorkflowEfficiencyRedTeamRuntimeForStore,
  issueWorkflowEfficiencyRedTeamHostAuthority,
  workflowEfficiencyReviewScheduleDigest,
} from ${JSON.stringify(efficiencyModule)};
import {
  createPersistedSessionWorkflowHost,
  resolvePersistedSessionWorkflowAuthority,
} from ${JSON.stringify(hostModule)};

const role = process.argv[1];
const artifactRoot = process.argv[2];
const rootSessionId = process.argv[3];
const workflowId = process.argv[4];
const writerIdentity = process.argv[5];
let schedule = JSON.parse(process.argv[6]);
let scheduleManifestRef = JSON.parse(process.argv[7]);
const expectedSnapshot = JSON.parse(process.argv[8]);
let epochRef = JSON.parse(process.argv[9]);
const fixedNow = () => "2030-01-01T00:00:00.000Z";
const ref = (label) => {
  const bytes = new TextEncoder().encode(label);
  return {
    artifactId: label,
    relativePath: "artifacts/" + label,
    digest: sha256Hex(bytes),
    sizeBytes: bytes.byteLength,
    sourceEventSequence: 1,
  };
};
const vector = () => ({
  cpuMilliCores: 1,
  memoryBytes: 1,
  diskBytes: 1,
  ioWeight: 1,
  accelerators: [],
  providers: [],
  networkEgressBytes: 0,
  wallMilliseconds: 1,
  monetaryMicrounits: 1,
});
const identityLease = (lease) => lease;
const makeRevisionContext = (lease, executionKey) => {
  const context = {
    workflowId,
    epochRef,
    leaseRef: lease,
    executionKey,
    revisionTuple: {
      contractRevision: 1,
      scorecardRevision: 1,
      planRevision: 1,
      configRevision: 1,
      evidenceRevision: 1,
    },
    revisionRegistryRef: ref("revision-registry"),
    revisionRegistryDigest: ref("revision-registry").digest,
    configSnapshotDigest: "config-snapshot",
  };
  return { ...context, tupleDigest: digestObject(context) };
};
const makeChildIdentity = (executionKey) => ({
  admissionId: "efficiency-review-admission",
  childSessionId: "efficiency-review-child",
  processGroupId: "efficiency-review-process-" + role,
  executionKey,
  epochRef,
  runtimeVersion: "0.147.0-alpha.10",
  hostCapabilityRevision: "efficiency-host-capability",
  agentRole: "reviewer",
  modelId: "controlled-reviewer",
  reasoningEffort: "medium",
  launchConfigDigest: "efficiency-launch-config",
  identityDigest: "efficiency-child-identity",
});
let manifestBytes;
const artifactResolver = {
  resolve: async (artifactRef) => {
    const bytes = artifactRef.digest === scheduleManifestRef.digest
      ? manifestBytes
      : new TextEncoder().encode(artifactRef.artifactId);
    return {
      envelope: {
        ref: artifactRef,
        payloadKind: "evidence",
        codec: artifactRef.digest === scheduleManifestRef.digest ? "canonical_json" : "utf8",
        immutable: true,
      },
      exists: true,
      bytes,
      verifiedDigest: sha256Hex(bytes),
      verifiedSizeBytes: bytes.byteLength,
    };
  },
};
let goal = emptyGoalState();
let host;
let currentInvocation = null;
let currentSnapshot = expectedSnapshot;
let reviewerCalls = 0;
let forbiddenBoundaryAttempts = 0;
let reallocationConsumerCalls = 0;
let consumedProposal = null;
const forgedEventCodes = [];
try {
  const persistedAuthority = role === "b"
    ? await resolvePersistedSessionWorkflowAuthority({ artifactRoot, rootSessionId, workflowId })
    : null;
  const fixtureEpoch = role === "b" && persistedAuthority !== null
    ? {
        ...persistedAuthority.genesisEpoch,
        coordinatorEpoch: persistedAuthority.genesisEpoch.coordinatorEpoch + 1,
      }
    : epochRef;
  const primeFixture = await createPrimeWorkflowFixture(
    artifactRoot,
    workflowId,
    fixtureEpoch,
  );
  host = await createPersistedSessionWorkflowHost({
    artifactRoot,
    rootSessionId,
    workflowId,
    genesisEpoch: epochRef,
    writerIdentity,
    runtimeVersion: "0.147.0-alpha.10",
    now: () => new Date().toISOString(),
    primeWorkflowSnapshots: primeFixture.snapshots,
    primeWorkflowAdaptersFactory: primeFixture.adaptersFactory,
    goalProjection: {
      read: () => structuredClone(goal),
      compareAndSwap: (expected, next) => {
        if (digestObject(goal) !== digestObject(expected)) return false;
        goal = structuredClone(next);
        return true;
      },
    },
  });
  const durable = host.runtimeStore.durableContext;
  if (durable === undefined) throw new Error("child runtime store has no durable context");
  if (role === "b") {
    epochRef = durable.epochRef;
    const nextSchedule = {
      ...schedule,
      epochRef,
      approvedDecisionRef: {
        ...schedule.approvedDecisionRef,
        storeEpoch: epochRef.storeEpoch,
        coordinatorEpoch: epochRef.coordinatorEpoch,
      },
    };
    schedule = { ...nextSchedule, scheduleDigest: workflowEfficiencyReviewScheduleDigest(nextSchedule) };
    const nextManifest = (() => {
      const {
        scheduleDigest: _scheduleDigest,
        lastRunAt: _lastRunAt,
        lastAdmittedWindowSequence: _lastAdmittedWindowSequence,
        lastAdmittedWindowId: _lastAdmittedWindowId,
        status: _status,
        ...immutable
      } = schedule;
      return canonicalJsonBytes(immutable);
    })();
  scheduleManifestRef = {
      ...scheduleManifestRef,
      digest: sha256Hex(nextManifest),
      sizeBytes: nextManifest.byteLength,
    };
  }
  const immutableSchedule = (() => {
    const {
      scheduleDigest: _scheduleDigest,
      lastRunAt: _lastRunAt,
      lastAdmittedWindowSequence: _lastAdmittedWindowSequence,
      lastAdmittedWindowId: _lastAdmittedWindowId,
      status: _status,
      ...immutable
    } = schedule;
    return canonicalJsonBytes(immutable);
  })();
  manifestBytes = immutableSchedule;
  const lease = () => durable.currentLeaseRef();
  const readPort = {
    readSnapshot: async () => currentSnapshot,
    readJournalSlice: async (_token, fromSequence, limit) => {
      const replay = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
      return replay.events.slice(fromSequence, fromSequence + limit);
    },
    readEvidenceRefs: async () => [],
    readCapacityObservation: async () => ({ source: "persisted-workflow-host" }),
  };
	const baseReviewer = createWorkflowEfficiencyRedTeamReviewer({
		readPort,
		trustedNow: fixedNow,
		artifactResolver,
	});
	const reviewer = {
		review: async (invocation, token) => {
			reviewerCalls += 1;
			return baseReviewer.review(invocation, token);
		},
	};
  const reviewInvocationFactory = async ({ token }) => {
    const executionKey = "efficiency-review-execution";
    const invocation = {
      reviewId: "review-" + token.tokenId,
      snapshotRef: expectedSnapshot.snapshotRef,
      reviewerChildIdentity: makeChildIdentity(executionKey),
      readOnlyCapabilityProofRef: ref("read-only-proof"),
      admissionRef: ref("efficiency-review-admission"),
      resourceLeaseRef: identityLease(lease()),
      ownershipLeaseRef: identityLease(lease()),
      epochRef,
      windowSequence: 1,
      executionKey,
      casExecutionKey: "efficiency-review-cas",
      invocationTokenDigest: "efficiency-review-token-digest",
      startedAt: fixedNow(),
      actualUsage: vector(),
      status: "started",
      invocationDigest: "efficiency-review-invocation-digest",
    };
    currentInvocation = invocation;
    return invocation;
  };
  const makeReceipt = () => {
    const artifactRef = ref("efficiency-review-resolver-receipt");
    return {
      receiptKind: "artifact",
      oneUse: false,
      receiptId: "efficiency-review-receipt",
      issuerId: "persisted-workflow-host",
      workflowId,
      bindingDigest: "efficiency-review-binding",
      payloadDigest: artifactRef.digest,
      artifactRef,
      issuedAt: fixedNow(),
      validUntil: "2030-01-01T01:00:00.000Z",
      keyId: "efficiency-review-key",
      signatureAlgorithm: "ed25519",
      artifactBytesDigest: artifactRef.digest,
      stateDigest: "efficiency-review-state",
      revision: 1,
      signature: "efficiency-review-signature",
      verificationDigest: "efficiency-review-verification",
    };
  };
  const makeReport = (input, result, expectedHead) => {
    if (currentInvocation === null) throw new Error("review invocation was not prepared");
    const suggestionBase = {
      suggestionId: "efficiency-suggestion-1",
      reviewId: currentInvocation.reviewId,
      windowId: input.dueWindowId,
      disposition: "suggest_reallocation",
      findingRefs: [ref("efficiency-finding")],
      evidenceRefs: [ref("efficiency-evidence")],
      recommendedAllocationRef: ref("efficiency-recommended-allocation"),
      expectedVerifiedOutcomeRef: ref("efficiency-expected-outcome"),
      writeAuthority: false,
      leaseAuthority: false,
      allocationAuthority: false,
      approvalAuthority: false,
      completionAuthority: false,
      suggestionDigest: "",
    };
    const suggestion = {
      ...suggestionBase,
      suggestionDigest: digestObject(suggestionBase),
    };
    const sourceJournalSequence = Number.isSafeInteger(expectedHead.sequence) ? expectedHead.sequence : 0;
    const sourceJournalDigest = expectedHead.eventDigest || "journal-genesis";
    const capacitySnapshotRefs = {
      capacitySnapshotRef: ref("efficiency-capacity"),
      usageSnapshotRef: ref("efficiency-usage"),
      billingSnapshotRef: ref("efficiency-billing"),
      rateLimitSnapshotRef: ref("efficiency-rate-limit"),
      authenticationDigest: "efficiency-capacity-authentication",
      observedAt: fixedNow(),
      expiresAt: "2030-01-01T01:00:00.000Z",
      monotonicObservationSequence: 1,
      snapshotDigest: "efficiency-capacity-snapshot",
    };
    const report = {
      workflowId,
      dueWindowId: input.dueWindowId,
      kind: "success",
      runId: "efficiency-run-1",
      hostExecutionId: "efficiency-host-execution-" + role,
      reviewId: currentInvocation.reviewId,
      invocationRef: result.invocationRef,
      snapshotRef: currentSnapshot.snapshotRef,
      invocationDigest: currentInvocation.invocationDigest,
      snapshotDigest: currentSnapshot.snapshotDigest,
      resultDigest: result.resultDigest,
      reportDigest: "",
      suggestions: [suggestion],
      suggestionDigests: [suggestion.suggestionDigest],
      resolverReceipt: makeReceipt(),
      exactSnapshot: currentSnapshot,
      exactInvocation: currentInvocation,
      exactResult: result,
      sourceJournalSequence,
      sourceJournalDigest,
      registryRef: ref("efficiency-registry"),
      registryDigest: ref("efficiency-registry").digest,
      capacitySnapshotRefs,
      usageSnapshotRefs: [ref("efficiency-usage")],
      billingSnapshotRefs: [ref("efficiency-billing")],
      rateLimitSnapshotRefs: [ref("efficiency-rate-limit")],
      monotonicClockObservation: {
        clockSourceDigest: ref("clock").digest,
        observedAt: fixedNow(),
        monotonicMilliseconds: 1,
        observationSequence: 1,
        previousObservationSequence: null,
        previousMonotonicMilliseconds: null,
        observationDigest: "efficiency-clock-observation",
      },
      childIdentity: currentInvocation.reviewerChildIdentity,
      epochRef,
      executionKey: currentInvocation.executionKey,
      casExecutionKey: currentInvocation.casExecutionKey,
      invocationTokenDigest: currentInvocation.invocationTokenDigest,
      resourceLeaseRef: currentInvocation.resourceLeaseRef,
      ownershipLeaseRef: currentInvocation.ownershipLeaseRef,
      throughputEvidenceRefs: [ref("efficiency-throughput")],
      evidenceGapRefs: [],
      uncertaintyEvidenceRefs: [],
      actualUsage: result.actualUsage,
      disposition: "suggest_reallocation",
      writeAuthority: false,
      reallocationAuthority: false,
      approvalAuthority: false,
    };
    return { ...report, reportDigest: digestObject(report) };
  };
  const rootHostAppendBoundary = async (input) => {
    if (!input.eventKind.startsWith("efficiency_red_team_")) {
      forbiddenBoundaryAttempts += 1;
      throw new Error("efficiency reviewer boundary rejects workflow mutation");
    }
    let payload;
    if (input.eventKind === "efficiency_red_team_started") {
      payload = {
        kind: "efficiency_red_team_started",
        workflowId,
        epochRef,
        runId: "efficiency-run-1",
        dueWindowId: input.dueWindowId,
        hostExecutionId: "efficiency-host-execution-" + role,
      };
    } else if (input.eventKind === "efficiency_red_team_completed" && input.result !== undefined) {
      payload = {
        kind: "efficiency_red_team_completed",
        workflowId,
        epochRef,
        report: makeReport(input, input.result, input.expectedHead),
      };
    } else {
      throw new Error("unexpected efficiency event");
    }
    const replay = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
    const expectedHead = input.expectedHead || replay.head;
    const committed = await commitAuthenticated(host.runtimeStore, {
      workflowId,
      payload,
      expectedHead,
      epochRef,
      leaseRef: lease(),
      idempotencyKey: input.idempotencyKey,
      writerIdentity: lease().writerIdentity,
      executionKey: null,
    });
    return { payload, committed };
  };
  const runtime = createWorkflowEfficiencyRedTeamRuntimeForStore({
    hostAuthority: issueWorkflowEfficiencyRedTeamHostAuthority(host),
    approvedSchedule: schedule,
    readPort,
    reviewer,
    trustedNow: fixedNow,
    trustedMonotonicNow: () => 1,
    readActiveLeaseContext: async () => ({
      workflowId,
      epochRef,
      leaseRef: lease(),
      writerIdentity: lease().writerIdentity,
      generationId: durable.generationId,
      revisionBoundary: makeRevisionContext(lease(), null),
    }),
    rootHostAppendBoundary,
    snapshotResolver: async () => currentSnapshot,
    scheduleManifestRef,
    scheduleArtifactResolver: artifactResolver,
    snapshotArtifactResolver: artifactResolver,
    reviewInvocationFactory,
    readOnlyCapabilityProofResolver: async () => ref("read-only-proof"),
    readUsage: async () => vector(),
    overheadReserve: vector(),
    readRevisionBoundaryContext: async (_workflowId, _epochRef, executionKey) =>
      makeRevisionContext(lease(), executionKey),
    revisionRegistry: { assertActive: async () => undefined },
    reallocationConsumer: {
      consume: async (proposal) => {
        reallocationConsumerCalls += 1;
        consumedProposal = {
          workflowId: proposal.workflowId,
          dueWindowId: proposal.dueWindowId,
          suggestionId: proposal.suggestion.suggestionId,
          recommendedAllocationRef: proposal.suggestion.recommendedAllocationRef,
          sourceSequence: proposal.sourceHead.sequence,
          sourceDigest: proposal.sourceHead.eventDigest,
        };
        return { disposition: "accepted", operationId: "efficiency-reallocation-operation" };
      },
    },
  });
  const windowId = schedule.scheduleId + ":" + schedule.revision + ":" + schedule.nextDueAt;
  const tokenId = "efficiency-token-" + windowId;
  if (role === "a") {
    await host.execute({
      kind: "start",
      request: {
        workflowId,
        objective: "persist efficiency review",
        acceptanceChecks: ["the efficiency proposal replays after restart"],
        protectedInvariants: ["the efficiency runtime cannot mutate workflow state"],
      },
    });
    const triggerReplay = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
    if (triggerReplay.head.eventDigest === null) throw new Error("workflow start head has no event digest");
    try {
      await runtime.onCommittedEvent({
        kind: "task_terminal",
        workflowId,
        epochRef,
        eventSequence: triggerReplay.head.sequence - 1,
        eventDigest: "forged-event-digest",
      });
    } catch (error) {
      forgedEventCodes.push(error?.code ?? "unknown");
    }
    try {
      await runtime.onCommittedEvent({
        kind: "task_terminal",
        workflowId,
        eventSequence: triggerReplay.head.sequence,
        eventDigest: triggerReplay.head.eventDigest,
      });
    } catch (error) {
      forgedEventCodes.push(error?.code ?? "unknown");
    }
    const eventResult = await runtime.onCommittedEvent({
      kind: "task_terminal",
      workflowId,
      epochRef,
      eventSequence: triggerReplay.head.sequence,
      eventDigest: triggerReplay.head.eventDigest,
    });
    if (eventResult === null) throw new Error("event-driven efficiency review did not complete");
    const periodicResult = await runtime.wake(workflowId, epochRef, schedule);
    if (JSON.stringify(periodicResult) !== JSON.stringify(eventResult)) throw new Error("periodic review replay mismatch");
    if (currentInvocation === null) throw new Error("event-driven invocation was not captured");
    const tokenResult = await runtime.wakeInvocation({
      invocation: currentInvocation,
      token: {
        tokenId,
        workflowId,
        epochRef,
        revisionTupleDigest: schedule.scheduleDigest,
        snapshotDigest: expectedSnapshot.snapshotDigest,
        expiresAtMonotonicMs: 1_000,
        remainingTokens: schedule.maxReviewTokens,
        remainingWallMilliseconds: schedule.maxReviewWallMilliseconds,
      },
      schedule,
    });
    if (JSON.stringify(tokenResult) !== JSON.stringify(eventResult)) throw new Error("token replay mismatch");
  } else {
    const recovered = await runtime.recover(workflowId, epochRef, schedule);
    if (recovered === null) throw new Error("fresh process did not recover the efficiency review");
  }
  const replay = await host.runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
  const completed = replay.events.find((event) => event.payload.kind === "efficiency_red_team_completed");
  if (completed === undefined) throw new Error("persisted efficiency completion is missing");
  const report = completed.payload.report;
  const mutationSurface = Object.keys(runtime).filter((key) =>
    ["commit", "publishArtifact", "publishSnapshot", "compareAndSwapProjection", "appendOutbox"].includes(key),
  );
  const result = await runtime.recover(workflowId, epochRef, schedule);
  if (result === null) throw new Error("persisted result disappeared before child exit");
  const auxiliaryBytes = await durable.auxiliaryStore.read("workflow-efficiency-runtime-state.json");
  if (auxiliaryBytes === null) throw new Error("child did not persist efficiency runtime state");
  const auxiliaryState = JSON.parse(new TextDecoder().decode(auxiliaryBytes));
  if (Object.keys(auxiliaryState.windows).length !== 1 || Object.keys(auxiliaryState.consumedTokens).length !== 1)
    throw new Error("child persisted efficiency state is incomplete");
  console.log(JSON.stringify({
    role,
    result,
    eventKinds: replay.events.map((event) => event.payload.kind),
    windowId,
    tokenId,
    report: {
      dueWindowId: report.dueWindowId,
      invocationTokenDigest: report.invocationTokenDigest,
      suggestion: report.suggestions[0].recommendedAllocationRef,
    },
    durableWindowIds: Object.values(auxiliaryState.windows).map((window) => window.dueWindowId),
    durableTokenIds: [tokenId],
    mutationSurface,
    forbiddenBoundaryAttempts,
    reviewerCalls,
    reallocationConsumerCalls,
    consumedProposal,
    forgedEventCodes,
  }));
} finally {
  await host?.dispose?.();
}
`;
	const args = [
		input.role,
		input.artifactRoot,
		input.rootSessionId,
		input.workflowId,
		input.writerIdentity,
		JSON.stringify(input.schedule),
		JSON.stringify(input.scheduleManifestRef),
		JSON.stringify(input.snapshot),
		JSON.stringify(input.epochRef),
	];
	return await new Promise<EfficiencyChildRunResult>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			["--import", "tsx/esm", "--input-type=module", "-e", childSource, ...args],
			{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`efficiency child ${input.role} exited ${code}: ${stderr}`));
				return;
			}
			try {
				const output = stdout.trim().split("\\n").at(-1);
				if (output === undefined) throw new Error("efficiency child produced no output");
				resolve(JSON.parse(output) as EfficiencyChildRunResult);
			} catch (error) {
				reject(new Error(`efficiency child output invalid: ${stdout} ${stderr}`, { cause: error }));
			}
		});
	});
}

describe("workflow efficiency reviewer", () => {
	it("runs only for committed event activity and deduplicates a due window", async () => {
		const fixture = createRuntime();
		const scheduleValue = schedule();
		const [first, second] = await Promise.all([
			fixture.runtime.wake("workflow-efficiency-test", EPOCH, scheduleValue),
			fixture.runtime.wake("workflow-efficiency-test", EPOCH, scheduleValue),
		]);

		expect(first?.kind).toBe("success");
		expect(second?.kind).toBe("success");
		expect(fixture.review).toHaveBeenCalledTimes(1);
		expect(fixture.recordedEvents).toContain("efficiency_red_team_started");
		await expect(
			fixture.runtime.onCommittedEvent?.({
				kind: "timer_tick",
				workflowId: "workflow-efficiency-test",
				epochRef: EPOCH,
				eventSequence: 2,
				eventDigest: "ignored-untriggered-event",
			}),
		).resolves.toBeNull();
	});

	it("rejects invalid or unapproved schedules before invoking the reviewer", async () => {
		const fixture = createRuntime();
		await expect(
			fixture.runtime.wake("workflow-efficiency-test", EPOCH, schedule({ cadenceMilliseconds: 0 })),
		).rejects.toMatchObject({ code: "workflow_efficiency_schedule_invalid" });
		await expect(
			fixture.runtime.wake("workflow-efficiency-test", EPOCH, schedule({ scheduleId: "foreign" })),
		).rejects.toMatchObject({ code: "workflow_efficiency_schedule_approval_required" });
		await expect(
			fixture.runtime.wake(
				"workflow-efficiency-test",
				EPOCH,
				schedule({
					dedicatedControlReserve: { ...schedule().dedicatedControlReserve, redTeamSlots: 0 },
				}),
			),
		).rejects.toMatchObject({ code: "workflow_efficiency_schedule_invalid" });
		expect(fixture.review).not.toHaveBeenCalled();
	});

	it("rejects a schedule with missing committed decision and receipt fields", async () => {
		const fixture = createRuntime();

		await expect(
			fixture.runtime.wake("workflow-efficiency-test", EPOCH, {
				...schedule(),
				approvedDecisionRef: {} as WorkflowEfficiencyReviewSchedule["approvedDecisionRef"],
				approvalReceipt: {} as WorkflowEfficiencyReviewSchedule["approvalReceipt"],
			}),
		).rejects.toMatchObject({
			code: "workflow_efficiency_schedule_invalid",
		});
		expect(fixture.review).not.toHaveBeenCalled();
	});

	it("gives the reviewer a read-only port and never applies its suggestion", async () => {
		const snapshotValue = snapshot("review-1");
		const readSnapshot = vi.fn(async () => snapshotValue);
		const reviewer = createWorkflowEfficiencyRedTeamReviewer({
			readPort: {
				readSnapshot,
				readJournalSlice: async () => [],
				readEvidenceRefs: async () => [],
				readCapacityObservation: async () => ({}) as never,
			},
			trustedNow: () => "2030-01-01T00:00:01.000Z",
			artifactResolver: snapshotArtifactResolver(),
		});
		const invocation = {
			reviewId: "review-1",
			epochRef: EPOCH,
			executionKey: "review-execution",
			snapshotRef: ref("snapshot"),
			actualUsage: vector(),
		} as unknown as WorkflowEfficiencyRedTeamInvocation;
		const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
			tokenId: "token",
			workflowId: "workflow-efficiency-test",
			epochRef: EPOCH,
			revisionTupleDigest: "revision",
			snapshotDigest: snapshotValue.snapshotDigest,
			expiresAtMonotonicMs: 1_000,
			remainingTokens: 10,
			remainingWallMilliseconds: 10,
		};

		const result = await reviewer.review(invocation, token);
		expect(result.kind).toBe("success");
		expect(readSnapshot).toHaveBeenCalledOnce();
		expect((result as { suggestionRef: WorkflowArtifactRef }).suggestionRef).toBeDefined();
		await expect(
			reviewer.review(
				{ ...invocation, actualUsage: vector({ wallMilliseconds: 2 }) },
				{ ...token, remainingWallMilliseconds: 1 },
			),
		).rejects.toMatchObject({ code: "workflow_efficiency_read_only_token_exhausted" });
	});

	it("rejects throughput evidence when it is reused as progress evidence", async () => {
		const throughput = ref("throughput");
		const snapshotValue = snapshotWith("review-1", {
			throughputEvidenceRefs: [throughput],
			acceptedProgressEvidenceRefs: [throughput],
		});
		const reviewer = createWorkflowEfficiencyRedTeamReviewer({
			readPort: {
				readSnapshot: async () => snapshotValue,
				readJournalSlice: async () => [],
				readEvidenceRefs: async () => [],
				readCapacityObservation: async () => ({}) as never,
			},
			trustedNow: () => "2030-01-01T00:00:01.000Z",
			artifactResolver: snapshotArtifactResolver(),
		});
		const invocation = {
			reviewId: "review-1",
			epochRef: EPOCH,
			executionKey: "review-execution",
			snapshotRef: ref("snapshot"),
			actualUsage: vector(),
		} as unknown as WorkflowEfficiencyRedTeamInvocation;
		const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
			tokenId: "token",
			workflowId: "workflow-efficiency-test",
			epochRef: EPOCH,
			revisionTupleDigest: "revision",
			snapshotDigest: snapshotValue.snapshotDigest,
			expiresAtMonotonicMs: 1_000,
			remainingTokens: 10,
			remainingWallMilliseconds: 10,
		};

		await expect(reviewer.review(invocation, token)).rejects.toMatchObject({
			code: "workflow_efficiency_proxy_progress",
		});
	});

	it("re-hashes resolved snapshot artifacts before producing a suggestion", async () => {
		const snapshotValue = snapshot("review-1");
		const reviewer = createWorkflowEfficiencyRedTeamReviewer({
			readPort: {
				readSnapshot: async () => snapshotValue,
				readJournalSlice: async () => [],
				readEvidenceRefs: async () => [],
				readCapacityObservation: async () => ({}) as never,
			},
			trustedNow: () => "2030-01-01T00:00:01.000Z",
			artifactResolver: {
				resolve: async (artifactRef: WorkflowArtifactRef) => ({
					envelope: {
						ref: artifactRef,
						payloadKind: "evidence",
						codec: "utf8",
						immutable: true,
					},
					exists: true,
					bytes: new Uint8Array([0]),
					verifiedDigest: artifactRef.digest,
					verifiedSizeBytes: artifactRef.sizeBytes,
				}),
			},
		});
		const invocation = {
			reviewId: "review-1",
			epochRef: EPOCH,
			snapshotRef: ref("snapshot"),
			actualUsage: vector(),
		} as unknown as WorkflowEfficiencyRedTeamInvocation;
		const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
			tokenId: "token",
			workflowId: "workflow-efficiency-test",
			epochRef: EPOCH,
			revisionTupleDigest: "revision",
			snapshotDigest: snapshotValue.snapshotDigest,
			expiresAtMonotonicMs: 1_000,
			remainingTokens: 10,
			remainingWallMilliseconds: 10,
		};

		await expect(reviewer.review(invocation, token)).rejects.toMatchObject({
			code: "workflow_efficiency_snapshot_artifact_invalid",
		});
	});

	it("turns reviewer usage beyond its admitted reserve into a bounded failure", async () => {
		const approved = schedule({
			reviewResourceAdmission: {
				...schedule().reviewResourceAdmission,
				reservedVector: vector({ cpuMilliCores: 1 }),
			},
		});
		const readUsage = vi.fn(async () => vector({ cpuMilliCores: 2 }));
		const fixture = createRuntime({
			approvedSchedule: approved,
			readUsage,
		});

		const result = await fixture.runtime.wake("workflow-efficiency-test", EPOCH, approved);

		expect(readUsage).toHaveBeenCalledOnce();
		expect(result?.kind).toBe("failure");
		expect(fixture.review).toHaveBeenCalledOnce();
	});

	it("recomputes the approved schedule digest before admitting a wake", async () => {
		const fixture = createRuntime();

		await expect(
			fixture.runtime.wake("workflow-efficiency-test", EPOCH, schedule({ costCeilingMicrounits: 11 })),
		).rejects.toMatchObject({ code: "workflow_efficiency_schedule_approval_required" });
		expect(fixture.review).not.toHaveBeenCalled();
	});

	it("rejects reserve ledger and partition mutations even when the schedule id is unchanged", async () => {
		const fixture = createRuntime();
		const approved = schedule();

		await expect(
			fixture.runtime.wake(
				"workflow-efficiency-test",
				EPOCH,
				schedule({
					reserveLedgerDigest: "forged-ledger-digest",
					reservePartitions: {
						...approved.reservePartitions,
						verifier: { ...approved.reservePartitions.verifier, verificationSlots: 1 },
					},
				}),
			),
		).rejects.toMatchObject({ code: "workflow_efficiency_schedule_invalid" });
		expect(fixture.review).not.toHaveBeenCalled();
	});

	it("routes direct invocations through schedule validation and consumes a token once", async () => {
		const fixture = createRuntime();
		const snapshotValue = snapshot("review-1");
		const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
			tokenId: "token-once",
			workflowId: "workflow-efficiency-test",
			epochRef: EPOCH,
			revisionTupleDigest: schedule().scheduleDigest,
			snapshotDigest: snapshotValue.snapshotDigest,
			expiresAtMonotonicMs: 1_000,
			remainingTokens: 10,
			remainingWallMilliseconds: 10,
		};
		const invocation = {
			reviewId: "review-1",
			epochRef: EPOCH,
			executionKey: "review-execution",
			snapshotRef: ref("snapshot"),
			actualUsage: vector(),
		} as unknown as WorkflowEfficiencyRedTeamInvocation;

		await expect(
			fixture.runtime.wakeInvocation({
				invocation,
				token,
				schedule: schedule({ cadenceMilliseconds: 0 }),
			}),
		).rejects.toMatchObject({ code: "workflow_efficiency_schedule_invalid" });

		const validInput = { invocation, token, schedule: schedule() };
		await expect(fixture.runtime.wakeInvocation(validInput)).resolves.toMatchObject({ kind: "success" });
		await expect(fixture.runtime.wakeInvocation(validInput)).rejects.toMatchObject({
			code: "workflow_efficiency_token_replayed",
		});
	});

	it("serializes concurrent direct invocations of one token", async () => {
		const fixture = createRuntime();
		const snapshotValue = snapshot("review-1");
		const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
			tokenId: "token-race",
			workflowId: "workflow-efficiency-test",
			epochRef: EPOCH,
			revisionTupleDigest: schedule().scheduleDigest,
			snapshotDigest: snapshotValue.snapshotDigest,
			expiresAtMonotonicMs: 1_000,
			remainingTokens: 10,
			remainingWallMilliseconds: 10,
		};
		const invocation = {
			reviewId: "review-1",
			epochRef: EPOCH,
			executionKey: "review-execution",
			snapshotRef: ref("snapshot"),
			actualUsage: vector(),
		} as unknown as WorkflowEfficiencyRedTeamInvocation;

		const outcomes = await Promise.allSettled([
			fixture.runtime.wakeInvocation({ invocation, token, schedule: schedule() }),
			fixture.runtime.wakeInvocation({ invocation, token, schedule: schedule() }),
		]);

		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
		expect((outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult).reason).toMatchObject(
			{
				code: "workflow_efficiency_token_replayed",
			},
		);
		expect(fixture.review).toHaveBeenCalledOnce();
	});

	it("requires a trusted monotonic expiry and host usage reader for runtime admission", async () => {
		expect(() => createRuntime({ readUsage: undefined })).toThrow("workflow_efficiency_usage_reader_required");
		expect(() => createRuntime({ snapshotArtifactResolver: undefined })).toThrow(
			"workflow_efficiency_snapshot_artifact_resolver_required",
		);
		const fixture = createRuntime({ trustedMonotonicNow: () => 2 });
		const snapshotValue = snapshot("review-1");
		const token: WorkflowReadOnlyEfficiencyRedTeamToken = {
			tokenId: "expired-token",
			workflowId: "workflow-efficiency-test",
			epochRef: EPOCH,
			revisionTupleDigest: schedule().scheduleDigest,
			snapshotDigest: snapshotValue.snapshotDigest,
			expiresAtMonotonicMs: 1,
			remainingTokens: 10,
			remainingWallMilliseconds: 10,
		};
		const invocation = {
			reviewId: "review-1",
			epochRef: EPOCH,
			snapshotRef: ref("snapshot"),
			actualUsage: vector(),
		} as unknown as WorkflowEfficiencyRedTeamInvocation;

		await expect(fixture.runtime.wakeInvocation({ invocation, token, schedule: schedule() })).rejects.toMatchObject({
			code: "workflow_efficiency_token_expired",
		});
	});

	it("records durable catch-up consumption before a crash can relaunch a review", async () => {
		const events: Array<{ payload: unknown }> = [];
		const append = vi.fn(
			async (input: { eventKind: string; dueWindowId: string; schedule?: WorkflowEfficiencyReviewSchedule }) => {
				if (input.eventKind === "efficiency_red_team_completed") throw new Error("simulated crash");
				events.push({
					payload: {
						kind: input.eventKind,
						workflowId: "workflow-efficiency-test",
						epochRef: EPOCH,
						dueWindowId: input.dueWindowId,
						scheduleDigest: input.schedule?.scheduleDigest,
					},
				});
				return {};
			},
		);
		const fixture = createRuntime({
			rootHostAppendBoundary: append,
			reviewStore: {
				replay: async () => ({ events, head: { sequence: events.length - 1 } }),
			},
		});

		await expect(fixture.runtime.recover("workflow-efficiency-test", EPOCH, schedule())).rejects.toThrow(
			"simulated crash",
		);
		await expect(fixture.runtime.recover("workflow-efficiency-test", EPOCH, schedule())).resolves.toBeNull();
		expect(fixture.review).toHaveBeenCalledOnce();
		expect(append.mock.calls.map(([call]) => call.eventKind)).toContain("efficiency_red_team_catch_up_consumed");
	});

	it("rejects replay records bound to another workflow or schedule", async () => {
		const result = {
			kind: "success",
			reviewId: "review-1",
			resultDigest: "result-digest",
		} as unknown as WorkflowEfficiencyRedTeamResult;
		const fixture = createRuntime({
			reviewStore: {
				replay: async () => ({
					events: [
						{
							payload: {
								kind: "efficiency_red_team_completed",
								workflowId: "other-workflow",
								epochRef: EPOCH,
								dueWindowId: "schedule-1:1:2030-01-01T00:00:00.000Z",
								result,
							},
						},
					],
					head: { sequence: 0 },
				}),
			},
		});

		await expect(fixture.runtime.wake("workflow-efficiency-test", EPOCH, schedule())).rejects.toMatchObject({
			code: "workflow_efficiency_replay_invalid",
		});
		expect(fixture.review).not.toHaveBeenCalled();
	});

	it("replays only a result with the exact workflow, epoch, head, schedule, and host usage", async () => {
		const scheduleValue = schedule();
		const actualUsage = vector();
		const preimage = {
			kind: "success" as const,
			reviewId: "review-1",
			invocationRef: ref("invocation-review-1"),
			suggestionRef: ref("suggestion-review-1"),
			actualUsage,
			completedAt: "2030-01-01T00:00:01.000Z",
		};
		const result = { ...preimage, resultDigest: digestObject(preimage) } as WorkflowEfficiencyRedTeamResult;
		const expectedHead = { sequence: 0 };
		const fixture = createRuntime({
			reviewStore: {
				replay: async () => ({
					events: [
						{
							payload: {
								kind: "efficiency_red_team_completed",
								workflowId: scheduleValue.workflowId,
								epochRef: EPOCH,
								dueWindowId: "schedule-1:1:2030-01-01T00:00:00.000Z",
								scheduleDigest: scheduleValue.scheduleDigest,
								expectedHead,
								expectedHeadDigest: digestObject(expectedHead),
								result,
								hostMeasuredUsage: actualUsage,
							},
						},
					],
					head: { sequence: 1 },
				}),
			},
		});

		await expect(fixture.runtime.wake("workflow-efficiency-test", EPOCH, scheduleValue)).resolves.toEqual(result);
		expect(fixture.review).not.toHaveBeenCalled();
	});

	it("rejects a structural host authority before reading any runtime ports", () => {
		expect(() => {
			// @ts-expect-error A forged structural object is intentionally not a host-issued authority.
			createWorkflowEfficiencyRedTeamRuntimeForStore({ hostAuthority: Object.freeze({}) });
		}).toThrow("workflow_efficiency_host_authority_required");
	});

	it("authenticates committed triggers against the exact current head and identity", async () => {
		const currentHead = {
			workflowId: "workflow-efficiency-test",
			sequence: 7,
			eventDigest: "current-event-digest",
			epochRef: EPOCH,
		};
		const fixture = createRuntime({
			reviewStore: {
				replay: async () => ({ events: [], head: currentHead }),
			},
		});

		await expect(
			fixture.runtime.onCommittedEvent({
				kind: "task_terminal",
				workflowId: currentHead.workflowId,
				epochRef: EPOCH,
				eventSequence: currentHead.sequence - 1,
				eventDigest: "stale-event-digest",
			}),
		).rejects.toMatchObject({ code: "workflow_efficiency_committed_event_head_mismatch" });
		await expect(
			fixture.runtime.onCommittedEvent({
				kind: "task_terminal",
				workflowId: currentHead.workflowId,
				epochRef: EPOCH,
				eventSequence: currentHead.sequence,
				eventDigest: currentHead.eventDigest,
			}),
		).resolves.toMatchObject({ kind: "success" });
		await expect(
			fixture.runtime.onCommittedEvent({
				kind: "task_terminal",
				workflowId: currentHead.workflowId,
				epochRef: EPOCH,
				eventSequence: currentHead.sequence,
				eventDigest: currentHead.eventDigest,
			}),
		).rejects.toMatchObject({ code: "workflow_efficiency_committed_event_replayed" });
		await expect(
			// @ts-expect-error A committed trigger without workflow identity must fail closed.
			fixture.runtime.onCommittedEvent({
				kind: "task_terminal",
				epochRef: EPOCH,
				eventSequence: currentHead.sequence,
				eventDigest: currentHead.eventDigest,
			}),
		).rejects.toMatchObject({ code: "workflow_efficiency_committed_event_identity_required" });
		await expect(
			// @ts-expect-error A committed trigger without epoch identity must fail closed.
			fixture.runtime.onCommittedEvent({
				kind: "task_terminal",
				workflowId: currentHead.workflowId,
				eventSequence: currentHead.sequence,
				eventDigest: currentHead.eventDigest,
			}),
		).rejects.toMatchObject({ code: "workflow_efficiency_committed_event_identity_required" });
	});

	it("resolves the read-only capability proof before review admission", async () => {
		const resolveProof = vi.fn(async () => ref("read-only-proof"));
		const fixture = createRuntime({ readOnlyCapabilityProofResolver: resolveProof });

		await fixture.runtime.wake("workflow-efficiency-test", EPOCH, schedule());

		expect(resolveProof).toHaveBeenCalledOnce();
	});

	it("reopens the public factory in a real child process and replays the exact durable review", async () => {
		const artifactRoot = await mkdtemp(join(tmpdir(), "workflow-efficiency-child-process-"));
		const approved = schedule();
		const windowId = `${approved.scheduleId}:${approved.revision}:${approved.nextDueAt}`;
		const tokenId = `efficiency-token-${windowId}`;
		const reviewSnapshot = snapshot(`review-${tokenId}`);
		const childInput = {
			artifactRoot,
			rootSessionId: "workflow-efficiency-child-session",
			workflowId: approved.workflowId,
			writerIdentity: "workflow-efficiency-child-writer",
			schedule: approved,
			scheduleManifestRef: scheduleManifestRef(approved),
			snapshot: reviewSnapshot,
			epochRef: EPOCH,
		};
		try {
			const first = await runEfficiencyChild({ role: "a", ...childInput });
			const reopened = await runEfficiencyChild({ role: "b", ...childInput });

			expect(first.role).toBe("a");
			expect(reopened.role).toBe("b");
			expect(first.result).toEqual(reopened.result);
			expect(first.eventKinds.slice(-2)).toEqual(["efficiency_red_team_started", "efficiency_red_team_completed"]);
			expect(reopened.eventKinds.slice(0, first.eventKinds.length)).toEqual(first.eventKinds);
			expect(reopened.eventKinds.at(-1)).toBe("coordinator_epoch_fenced");
			expect(first.eventKinds).toEqual([
				"workflow_started",
				"goal_binding_committed",
				"goal_projection_applied",
				"goal_contract_proposed",
				"scorecard_proposed",
				"resource_envelope_proposed",
				"approval_requested",
				"efficiency_red_team_started",
				"efficiency_red_team_completed",
			]);
			expect(first.windowId).toBe(reopened.windowId);
			expect(first.tokenId).toBe(tokenId);
			expect(reopened.tokenId).toBe(tokenId);
			expect(first.report).toEqual(reopened.report);
			expect(first.report.dueWindowId).toBe(windowId);
			expect(first.report.invocationTokenDigest).toBe("efficiency-review-token-digest");
			expect(first.report.suggestion.artifactId).toBe("efficiency-recommended-allocation");
			expect(first.durableWindowIds).toEqual([windowId]);
			expect(reopened.durableWindowIds).toEqual(first.durableWindowIds);
			expect(first.durableTokenIds).toEqual([tokenId]);
			expect(reopened.durableTokenIds).toEqual(first.durableTokenIds);
			expect(first.mutationSurface).toEqual([]);
			expect(reopened.mutationSurface).toEqual([]);
			expect(first.forbiddenBoundaryAttempts).toBe(0);
			expect(reopened.forbiddenBoundaryAttempts).toBe(0);
			expect(first.reviewerCalls).toBe(1);
			expect(reopened.reviewerCalls).toBe(0);
			expect(first.reallocationConsumerCalls).toBe(1);
			expect(reopened.reallocationConsumerCalls).toBe(1);
			expect(first.forgedEventCodes).toEqual([
				"workflow_efficiency_committed_event_head_mismatch",
				"workflow_efficiency_committed_event_identity_required",
			]);
			expect(reopened.forgedEventCodes).toEqual([]);
			expect(reopened.consumedProposal).toEqual(first.consumedProposal);
			expect(first.consumedProposal).toMatchObject({
				workflowId: approved.workflowId,
				dueWindowId: windowId,
				suggestionId: "efficiency-suggestion-1",
				recommendedAllocationRef: ref("efficiency-recommended-allocation"),
			});
		} finally {
			await rm(artifactRoot, { recursive: true, force: true });
		}
	});
});
