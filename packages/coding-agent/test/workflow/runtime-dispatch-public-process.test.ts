import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import { expect, it } from "vitest";
import { emptyGoalState, type GoalState } from "../../src/core/goals.js";
import {
	canonicalJsonBytes,
	digestObject,
	parseCanonicalJsonBytes,
	sha256Hex,
} from "../../src/core/workflow/contracts.js";
import { deriveWorkflowExecutionKey } from "../../src/core/workflow/dispatch.js";
import { createPersistedSessionWorkflowHost } from "../../src/core/workflow/session-host-factory.js";

const EPOCH = { storeEpoch: 1, coordinatorEpoch: 1 } as const;
const TEST_BOOTSTRAP_PROCESS_IDENTITY = `process:${process.pid}:runtime:00000000-0000-4000-8000-000000000000`;
const DISPATCH_CHILD_TIMEOUT_MILLISECONDS = 30_000;

interface LeaseAdmissionEvidence {
	readonly leaseId: string;
	readonly taskId: string | null;
	readonly attemptId: string | null;
	readonly executionKey: string | null;
	readonly grantKind: string | null;
	readonly leaseStatus: string;
	readonly reservedVectorDigest: string | null;
}

interface DispatchBindingEvidence {
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly admissionId: string;
}

interface QueueEntryEvidence {
	readonly taskId: string;
	readonly attemptId: string;
	readonly executionKey: string;
	readonly blockedBy: readonly string[];
}

interface ChildResult {
	readonly mode: string;
	readonly intents: number;
	readonly resourceLeases: number;
	readonly ownershipLeases: number;
	readonly resourceAdmissions: readonly LeaseAdmissionEvidence[];
	readonly ownershipAdmissions: readonly LeaseAdmissionEvidence[];
	readonly dispatchBindings: readonly DispatchBindingEvidence[];
	readonly launchAuthorizationDigest: string | null;
	readonly refillStatuses: readonly string[];
	readonly queuedEntries: number;
	readonly activeAttemptIds: readonly string[];
	readonly queueBindings: readonly QueueEntryEvidence[];
	readonly blockedBy: readonly string[];
	readonly queuedRecipeDigest: string | null;
	readonly fixtureRecipeDigest: string;
	readonly fixtureHeadDigest: string;
	readonly recoveryMarkerStatusBeforeRefill: string | null;
	readonly recoveryMarkerStatusAfterRecovery: string | null;
	readonly recoveryMarkerStatusAfterRefill: string | null;
	readonly recoveryOwnerProcessIdentityBeforeRefill: string | null;
	readonly recoveryOwnerProcessIdentityAfterRecovery: string | null;
	readonly recoveryOwnerFenceObserved: boolean;
	readonly recoveryPreviousStateDigest: string | null;
	readonly recoveryNextStateDigest: string | null;
	readonly recoveryQueueDigestBeforeRefill: string | null;
	readonly recoveryQueueDigestAfterRollback: string | null;
	readonly recoveryQueueReconstructed: boolean;
	readonly recoveryMarkerConsumed: boolean;
	readonly recoveryRollbackObserved: boolean;
	readonly recoveryRollbackPersisted: boolean;
	readonly recoveryHydrationObserved: boolean;
	readonly recoveryHydratedLeaseStatus: string | null;
	readonly recoveryHydratedExecutionKey: string | null;
	readonly recoveryHydratedActiveVectorDigest: string | null;
	readonly recoveryReleasedResourceLeases: number;
	readonly recoveryReleasedOwnershipLeases: number;
	readonly releasedLeaseIds: readonly string[];
}

interface ChildOptions {
	readonly artifactRoot: string;
	readonly rootSessionId: string;
	readonly workflowId: string;
	readonly writerIdentity: string;
	readonly processIdentity: string;
	readonly mode: "setup" | "refill" | "crash-prepared";
	readonly holdRecovery?: boolean;
	readonly waitForRecoveryOwner?: boolean;
}

let lastCrashChildPid: number | undefined;

function expectedDispatchBinding(
	workflowId: string,
	rootSessionId: string,
	attemptId = "dispatch-public-attempt",
): {
	readonly executionKey: string;
	readonly admissionId: string;
} {
	const decisionRef = {
		decisionScope: { kind: "workflow" as const, workflowId, rootSessionId },
		decisionId: "dispatch-public-decision",
		revision: 1,
		storeEpoch: EPOCH.storeEpoch,
		coordinatorEpoch: EPOCH.coordinatorEpoch,
		decisionDigest: sha256Hex("dispatch-public-decision"),
	};
	const executionKey = deriveWorkflowExecutionKey({
		workflowId,
		taskId: "recon",
		attemptId,
		decisionRef,
		launchConfigDigest: sha256Hex("dispatch-public-launch-config"),
	});
	return { executionKey, admissionId: `admission:${executionKey}` };
}

function goalProjection() {
	let current: GoalState = emptyGoalState();
	return {
		read: () => structuredClone(current),
		compareAndSwap: (expected: typeof current, next: typeof current): boolean => {
			if (digestObject(current) !== digestObject(expected)) return false;
			current = structuredClone(next);
			return true;
		},
	};
}

function childSource(): string {
	const sourceModule = pathToFileURL(`${process.cwd()}/src/core/workflow/contracts.ts`).href;
	const hostModule = pathToFileURL(`${process.cwd()}/src/core/workflow/session-host-factory.ts`).href;
	const fixtureModule = pathToFileURL(`${process.cwd()}/test/workflow/prime-loop-fixtures.ts`).href;
	const graphModule = pathToFileURL(`${process.cwd()}/src/core/workflow/task-graph.ts`).href;
	const admissionModule = pathToFileURL(`${process.cwd()}/src/core/workflow/admission.ts`).href;
	const leasesModule = pathToFileURL(`${process.cwd()}/src/core/workflow/leases.ts`).href;
	const schedulerModule = pathToFileURL(`${process.cwd()}/src/core/workflow/scheduler.ts`).href;
	const dispatchModule = pathToFileURL(`${process.cwd()}/src/core/workflow/dispatch.ts`).href;

	return `
import { readFileSync, writeFileSync } from "node:fs";
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(hostModule)};
import { digestObject, canonicalJsonBytes, parseCanonicalJsonBytes, sha256Hex } from ${JSON.stringify(sourceModule)};
import { createPrimeWorkflowFixture, createPrimeWorkflowTasks } from ${JSON.stringify(fixtureModule)};
import { validateWorkflowTaskGraph } from ${JSON.stringify(graphModule)};
import { createWorkflowAdmissionRegistry, deriveAdmissionIdempotencyKey, toAdmissionContext } from ${JSON.stringify(admissionModule)};
import { createWorkflowLeaseManager } from ${JSON.stringify(leasesModule)};
import { createWorkflowScheduler, createWorkflowSchedulerDurableAdmissionTransaction } from ${JSON.stringify(schedulerModule)};
import { deriveWorkflowExecutionKey, leaseRefOf } from ${JSON.stringify(dispatchModule)};
import { verifyWorkflowRecipeAdmissionForTask } from ${JSON.stringify(pathToFileURL(`${process.cwd()}/src/core/workflow/recipes.ts`).href)};

const artifactRoot = process.argv[1];
const rootSessionId = process.argv[2];
const workflowId = process.argv[3];
const writerIdentity = process.argv[4];
const processIdentity = process.argv[5] === "auto" ? undefined : process.argv[5];
const mode = process.argv[6];
const holdRecovery = process.argv[7] === "1";
const waitForRecoveryOwner = process.argv[8] === "1";
const genesisEpoch = { storeEpoch: 1, coordinatorEpoch: 1 };
const goalPath = artifactRoot + "/dispatch-public-goal.json";
const crashReadyPath = artifactRoot + "/dispatch-public-crash-ready";
const recoveryOwnerPath = artifactRoot + "/dispatch-public-recovery-owner";
const recoveryReleasePath = artifactRoot + "/dispatch-public-recovery-release";
const refillReadyPath = artifactRoot + "/dispatch-public-refill-ready-" + (holdRecovery ? "owner" : "wait");
const refillGoPath = artifactRoot + "/dispatch-public-refill-go";
const readGoal = () => parseCanonicalJsonBytes(new Uint8Array(readFileSync(goalPath)));
const validateOwner = (payload, event) => {
  if ("workflowId" in payload && payload.workflowId !== event.workflowId) throw new Error("dispatch_owner_workflow_mismatch");
  if (typeof event.eventDigest !== "string" || event.eventDigest.length === 0) throw new Error("dispatch_owner_event_digest_missing");
};
console.error("dispatch-phase", process.pid, mode, "host-start");
const host = await createPersistedSessionWorkflowHost({
  artifactRoot,
  rootSessionId,
  workflowId,
  writerIdentity,
  processIdentity,
  genesisEpoch,
  deferredOwnerValidators: { autoresearch: validateOwner, runtime: validateOwner, effect: validateOwner, recovery: validateOwner },
  goalProjection: {
    read: readGoal,
    compareAndSwap: (expected, next) => {
      if (digestObject(readGoal()) !== digestObject(expected)) return false;
      writeFileSync(goalPath, canonicalJsonBytes(next));
      return true;
    },
  },
});
console.error("dispatch-phase", process.pid, mode, "host-ready");
const runtimeStore = host.runtimeStore;
const durable = runtimeStore.durableContext;
if (durable === undefined) throw new Error("durable_dispatch_context_missing");
const epochRef = { ...durable.epochRef };
const reportMarker = async (label) => {
  const bytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
  if (bytes !== null) console.error("dispatch-marker", label, parseCanonicalJsonBytes(bytes).status);
};
await reportMarker("host");
const replayBeforeFixture = await runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
await reportMarker("replay");
const persistedRecipeBytes = await durable.auxiliaryStore.read("dispatch-public-recipe.json");
const persistedRecipe = persistedRecipeBytes === null ? null : parseCanonicalJsonBytes(persistedRecipeBytes);
const fixture = await createPrimeWorkflowFixture(artifactRoot, workflowId, epochRef, persistedRecipe?.hostHeadDigest ?? digestObject(replayBeforeFixture.head));
const freezeRecipe = (value) => {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecipe(child);
    Object.freeze(value);
  }
  return value;
};
let recipeAdmission = freezeRecipe(persistedRecipe ?? fixture.snapshots.recipe);
let recipeHost = fixture.recipeHost;
if (persistedRecipe !== null && persistedRecipe.registrationReceipt !== undefined && persistedRecipe.registrationReceiptProof !== undefined) {
  recipeHost = {
    ...recipeHost,
    registeredManifestReceipt: persistedRecipe.registrationReceipt,
    context: {
      ...recipeHost.context,
      epochRef: persistedRecipe.hostEpochRef,
      currentDecisionDigest: persistedRecipe.hostDecisionDigest,
      headDigest: persistedRecipe.hostHeadDigest,
		contextDigest: persistedRecipe.hostContextDigest,
		issuedAt: persistedRecipe.registrationReceipt.receipt.issuedAt,
		validUntil: persistedRecipe.registrationReceipt.receipt.validUntil,
		authenticatedReceiptResolver: {
			...recipeHost.context.authenticatedReceiptResolver,
			verifyConsumedReceipt: () => persistedRecipe.registrationReceiptProof,
		},
    },
  };
}
const graph = validateWorkflowTaskGraph(createPrimeWorkflowTasks(), {
  knownSkillSnapshotDigests: [],
  allowedAuthority: ["read_workspace"],
  workspacePaths: ["src"],
  generatedOutputPaths: ["artifacts/out"],
  namedContracts: [],
});
const task = graph.byId.get("recon");
if (task === undefined) throw new Error("dispatch_task_missing");
let recipeError = null;
try {
  verifyWorkflowRecipeAdmissionForTask({ admission: recipeAdmission, task, graph, epochRef, workflowId, currentHostHeadDigest: digestObject(replayBeforeFixture.head) });
} catch (error) {
  recipeError = String(error);
}
const rootLeaseRef = durable.currentLeaseRef();
const revisionRegistryRef = {
  artifactId: "dispatch-public-revision",
  relativePath: "artifacts/workflow/revision",
  digest: sha256Hex("dispatch-public-revision"),
  sizeBytes: 1,
  sourceEventSequence: 1,
};
const ledgerRef = {
  artifactId: "dispatch-public-ledger",
  relativePath: "artifacts/workflow/ledger",
  digest: sha256Hex("dispatch-public-ledger"),
  sizeBytes: 1,
  sourceEventSequence: 1,
};
const decisionRef = {
  decisionScope: { kind: "workflow", workflowId, rootSessionId },
  decisionId: "dispatch-public-decision",
  revision: 1,
  storeEpoch: epochRef.storeEpoch,
  coordinatorEpoch: epochRef.coordinatorEpoch,
  decisionDigest: sha256Hex("dispatch-public-decision"),
};
const launchConfigDigest = sha256Hex("dispatch-public-launch-config");
const attemptId = "dispatch-public-attempt";
const executionKey = deriveWorkflowExecutionKey({ workflowId, taskId: task.taskId, attemptId, decisionRef, launchConfigDigest });
const revisionTuple = { contractRevision: 1, scorecardRevision: 1, planRevision: 1, evidenceRevision: 1, configRevision: 1 };
const childAuthority = { capabilities: ["read_only"], writeClass: "read_only", parentAttemptId: null, rootSpawned: true };
const promptArtifactRef = { artifactId: "dispatch-public-prompt", relativePath: "artifacts/workflow/prompt", digest: sha256Hex("prompt"), sizeBytes: 1, sourceEventSequence: 1 };
const grant = {
  kind: "worker",
  grantId: "grant:" + attemptId,
  resourceVector: task.declaredResourceVector,
  controlCapacity: task.declaredControlCapacity,
  canonicalPoolLedgerRef: ledgerRef,
  grantDigest: digestObject({ kind: "worker", attemptId, ledgerRef }),
};
const placeholderLease = {
  leaseId: "resource:" + attemptId, workflowId, taskId: task.taskId, attemptId,
  holderIdentity: writerIdentity,
  resourceAdmission: {
    declaredVector: task.declaredResourceVector, reservedVector: task.declaredResourceVector,
    declaredControlCapacity: task.declaredControlCapacity, reservedControlCapacity: task.declaredControlCapacity,
    hostDerivedConservativeVector: task.declaredResourceVector, hostDerivedControlCapacity: task.declaredControlCapacity,
    capacityGrant: grant, canonicalPoolLedgerRef: ledgerRef, controlCapacity: task.declaredControlCapacity,
    controlCapacityProjectionDigest: digestObject(task.declaredControlCapacity), derivationPolicyDigest: sha256Hex("policy"),
    enforcementClass: "host_bounded", unknownPoolIds: [], canonicalLedgerRef: ledgerRef,
    canonicalLedgerDigest: ledgerRef.digest, admitted: true, admissionDigest: digestObject({ grant, attemptId }),
  },
  controlCapacity: task.declaredControlCapacity, workerCapacity: task.declaredControlCapacity,
  status: "active", storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch,
  acquisitionEventSequence: 1, idempotencyKey: "resource:" + attemptId, acquiredAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60000).toISOString(), releaseEventSequence: null,
};
const dispatchInput = {
  workflowId, rootSessionId, taskId: task.taskId, attemptId, executionKey, decisionRef, epochRef,
  rootLeaseRef, resourceLease: placeholderLease, ownershipLease: null, childAuthority,
  launchConfigDigest, configSnapshotDigest: fixture.snapshots.config.resolvedConfigDigest,
  canonicalAdmissionBundleRef: { artifactId: "dispatch-public-bundle", relativePath: "artifacts/workflow/bundle", digest: sha256Hex("bundle"), sizeBytes: 1, sourceEventSequence: 1 },
  canonicalAdmissionBundleDigest: sha256Hex("bundle"),
  canonicalAdmissionBundle: { grant, envelope: {}, refs: { ledger: ledgerRef }, resourceLease: placeholderLease, snapshot: { resolvedConfigDigest: fixture.snapshots.config.resolvedConfigDigest, configRevision: 1 } },
  revisionTuple, revisionRegistryRef, revisionRegistryDigest: revisionRegistryRef.digest, writerIdentity,
  expectedEffectDigest: sha256Hex("dispatch-public-effect"), promptArtifactRef, prompt: "dispatch public process",
  sessionName: "dispatch-public", sessionDir: artifactRoot, cwd: artifactRoot, modelProvider: "none", modelId: "none",
  reasoningLevel: "medium", serviceTier: "default", runtimeVersion: "0.147.0-alpha.10",
  hostCapabilityRevision: "dispatch-public-host", agentRole: "worker",
  processGroupRequest: { executable: process.execPath, arguments: [], cwd: artifactRoot, detached: true, requireProcessStartId: true },
};
const queueRecordName = "dispatch-public-queue.json";
const launchRecordName = "dispatch-public-launch.json";
let recoveryObservationEnabled = false;
let recoveryMarkerResourceLease = null;
let recoveryMarkerStatusAfterRecovery = null;
let recoveryOwnerProcessIdentityBeforeRefill = null;
let recoveryOwnerProcessIdentityAfterRecovery = null;
let recoveryOwnerFenceObserved = false;
let recoveryPreviousStateDigest = null;
let recoveryNextStateDigest = null;
let recoveryQueueDigestAfterRollback = null;
let recoveryQueueReconstructed = false;
let recoveryRollbackObserved = false;
let recoveryRollbackPersisted = false;
let recoveryHydrationObserved = false;
let recoveryHydratedLeaseStatus = null;
let recoveryHydratedExecutionKey = null;
let recoveryHydratedActiveVectorDigest = null;
const readQueue = async () => {
  const bytes = await durable.auxiliaryStore.read(queueRecordName);
  return bytes === null ? null : parseCanonicalJsonBytes(bytes);
};
const writeQueue = async (state) => await durable.auxiliaryStore.write(queueRecordName, canonicalJsonBytes(state));
const queueState = {
  read: async () => {
    const state = await readQueue();
    return state === null ? null : state;
  },
  write: async (state) => await durable.withExclusiveLease("dispatch-public-queue", async () => writeQueue(state)),
  compareAndSwap: async ({ expectedStateDigest, nextState, idempotencyKey }) =>
    durable.withExclusiveLease("dispatch-public-queue", async () => {
      const current = await readQueue();
      const currentDigest = current === null ? null : digestObject(current);
      if (currentDigest === digestObject(nextState)) return "already_applied";
      if (currentDigest !== expectedStateDigest) return "conflict";
      await durable.auxiliaryStore.write(queueRecordName, canonicalJsonBytes(nextState));
      await durable.auxiliaryStore.write("dispatch-public-last-cas.json", canonicalJsonBytes({ idempotencyKey, digest: digestObject(nextState) }));
      return "applied";
    }),
};
const observedQueueState = mode === "refill"
  ? {
      ...queueState,
      compareAndSwap: async (input) => {
        const status = await queueState.compareAndSwap(input);
        if (
          recoveryObservationEnabled &&
          status !== "conflict" &&
          recoveryPreviousStateDigest !== null &&
          recoveryNextStateDigest !== null &&
          input.expectedStateDigest === recoveryNextStateDigest &&
          digestObject(input.nextState) === recoveryPreviousStateDigest
        ) {
          recoveryRollbackObserved = true;
          const persisted = await readQueue();
          recoveryQueueDigestAfterRollback = persisted === null ? null : digestObject(persisted);
          recoveryRollbackPersisted = recoveryQueueDigestAfterRollback === recoveryPreviousStateDigest;
          recoveryQueueReconstructed = recoveryRollbackPersisted;
        }
        return status;
      },
    }
  : queueState;
const currentEpoch = async () => durable.epochRef;
const activeContext = () => ({
  workflowId, epochRef, leaseRef: rootLeaseRef, writerIdentity,
  generationId: durable.generationId,
  revisionBoundary: revisionBoundary(null),
});
let boundaryResourceLeaseRef = null;
let currentRecipeHostHeadDigest = digestObject(replayBeforeFixture.head);
const revisionBoundary = (executionKey, leaseRef = rootLeaseRef) => {
  const value = {
    workflowId, epochRef, leaseRef, executionKey, revisionTuple,
    revisionRegistryRef, revisionRegistryDigest: revisionRegistryRef.digest,
    configSnapshotDigest: fixture.snapshots.config.resolvedConfigDigest,
  };
  return { ...value, tupleDigest: digestObject(value) };
};
const readRevisionBoundaryContext = async (_workflowId, _epoch, executionKey) => {
  return revisionBoundary(executionKey, boundaryResourceLeaseRef ?? rootLeaseRef);
};
const assertCurrent = async (_workflowId, requestedEpoch) => {
  if (digestObject(requestedEpoch) !== digestObject(durable.epochRef)) throw new Error("workflow_epoch_stale");
};
const bindingConsumption = {
  consume: async () => "consumed",
  assertConsumed: async () => undefined,
};
const admission = createWorkflowAdmissionRegistry({
  store: runtimeStore,
  epochs: { assertCurrent },
  readActiveLeaseContext: async () => activeContext(),
  bindingConsumption,
  revisionRegistry: { assertActive: async (context) => {
    if (digestObject(context) !== digestObject(revisionBoundary(context.executionKey, context.leaseRef))) throw new Error("revision_stale");
  } },
  readRevisionBoundaryContext,
  readCurrentEpoch: async () => durable.epochRef,
  processContainmentVerifier: {
    readCurrentHostIdentity: async () => { throw new Error("process_identity_not_needed"); },
    verify: async () => { throw new Error("process_identity_not_needed"); },
  },
  launchReservationReader: { readLaunchReservation: async () => null },
  workflowRoot: artifactRoot + "/workflows/" + workflowId,
  writerIdentity,
  replayContextReader: { readAdmissionContext: async (_commit, payload) => {
    const lease = payload.resourceLeaseRef;
    const owner = payload.ownershipLeaseRef;
    return {
      workflowId, rootSessionId, taskId: payload.taskId, attemptId: payload.attemptId,
      executionKey: payload.executionKey, idempotencyKey: deriveAdmissionIdempotencyKey({ executionKey: payload.executionKey, epochRef }),
      decisionRef: payload.decisionRef, resourceLeaseRef: lease, controlCapacity: task.declaredControlCapacity,
      ownershipLeaseRef: owner, childAuthority: payload.childAuthority, launchConfigDigest: payload.launchConfigDigest,
      runtimeVersion: "0.147.0-alpha.10", hostCapabilityRevision: "dispatch-public-host", agentRole: "worker",
      modelId: "none", reasoningEffort: "medium", expectedEffectDigest: payload.expectedEffectDigest,
      epochRef, configSnapshotDigest: fixture.snapshots.config.resolvedConfigDigest, revisionTuple,
      revisionRegistryRef, revisionRegistryDigest: revisionRegistryRef.digest, writerIdentity,
    };
  } },
});
await admission.hydrateFromReplay();
await reportMarker("admission");
const ttlValues = new Map();
const leaseTtlStore = {
  read: async (leaseId) => {
    const bytes = await durable.auxiliaryStore.read("dispatch-public-ttl-" + sha256Hex(leaseId).slice(0, 48) + ".json");
    if (bytes === null) return ttlValues.get(leaseId) ?? null;
    return parseCanonicalJsonBytes(bytes);
  },
  write: async (leaseId, value) => {
    ttlValues.set(leaseId, value);
    await durable.auxiliaryStore.write("dispatch-public-ttl-" + sha256Hex(leaseId).slice(0, 48) + ".json", canonicalJsonBytes(value));
  },
};
const leases = createWorkflowLeaseManager({
  store: runtimeStore, callbackFenceStore: {}, epochs: { assertCurrent }, admission,
  workflowRoot: artifactRoot + "/workflows/" + workflowId,
  controlPlaneReserve: { ...task.declaredResourceVector, cpuMilliCores: 0, memoryBytes: 0, diskBytes: 0, ioWeight: 0, networkEgressBytes: 0, wallMilliseconds: 0, monetaryMicrounits: 0 },
  controlPartition: { capacity: task.declaredControlCapacity, resourceVector: { ...task.declaredResourceVector, cpuMilliCores: 1000, memoryBytes: 100000, diskBytes: 100000, ioWeight: 100000, wallMilliseconds: 100000, monetaryMicrounits: 100000 }, canonicalPoolLedgerRef: ledgerRef, partitionDigest: sha256Hex("control") },
  workerPartition: { controlCapacity: task.declaredControlCapacity, resourceVector: { ...task.declaredResourceVector, cpuMilliCores: 1000, memoryBytes: 100000, diskBytes: 100000, ioWeight: 100000, wallMilliseconds: 100000, monetaryMicrounits: 100000 }, enforcementClass: "host_bounded", canonicalPoolLedgerRef: ledgerRef, partitionDigest: sha256Hex("worker") },
  observedControlCapacity: task.declaredControlCapacity, poolMap: { accelerators: new Map(), providers: new Map(), digest: sha256Hex("pools") },
  resourceCeiling: { ...task.declaredResourceVector, cpuMilliCores: 1000, memoryBytes: 100000, diskBytes: 100000, ioWeight: 100000, wallMilliseconds: 100000, monetaryMicrounits: 100000 },
  writerIdentity, rootLeaseRef, canonicalPoolLedgerRef: ledgerRef,
  trustedNow: () => new Date().toISOString(), trustedMonotonicNow: () => Number(process.hrtime.bigint() / 1000000n),
  leaseTtlStore, resourceLeaseTtlMilliseconds: 60000, readActiveLeaseContext: activeContext,
  readRevisionBoundaryContext, revisionRegistry: { assertActive: async () => undefined }, taskGraph: graph,
  readTask: async (_workflowId, taskId) => graph.byId.get(taskId) ?? null,
  readAdmissionBinding: async (_workflowId, taskId, requestedAttemptId, requestedExecutionKey) => {
    const state = await readQueue();
    const entry = state?.entries?.find((candidate) => candidate.input.attemptId === requestedAttemptId);
    if (entry === undefined || entry.input.taskId !== taskId || entry.input.executionKey !== requestedExecutionKey) return null;
    return { workflowId, taskId, attemptId: requestedAttemptId, executionKey: requestedExecutionKey, epochRef, controlCapacity: task.declaredControlCapacity };
  },
  readGrant: async (request) => ({ workflowId: request.workflowId, taskId: request.taskId, attemptId: request.attemptId, executionKey: request.executionKey, epochRef, vector: request.vector, controlCapacity: request.controlCapacity, grantDigest: grant.grantDigest, canonicalLedgerDigest: ledgerRef.digest }),
});
await leases.hydrateFromReplay();
await reportMarker("leases");
const observeLeaseHydration = async () => {
  if (!recoveryObservationEnabled) return;
  recoveryHydrationObserved = true;
  recoveryHydratedActiveVectorDigest = digestObject(await leases.activeVector(workflowId));
  if (recoveryMarkerResourceLease !== null) {
    const hydrated = await leases.lookupByLease(workflowId, leaseRefOf(recoveryMarkerResourceLease));
    recoveryHydratedLeaseStatus = hydrated?.leaseStatus ?? null;
    recoveryHydratedExecutionKey = hydrated?.executionKey ?? null;
  }
};
const observedLeases = mode === "refill"
  ? {
      ...leases,
      hydrateFromReplay: async () => {
        await leases.hydrateFromReplay();
        await observeLeaseHydration();
        if (holdRecovery && recoveryObservationEnabled) {
          writeFileSync(recoveryOwnerPath, String(process.pid));
          while (true) {
            try {
              readFileSync(recoveryReleasePath);
              break;
            } catch {
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
          }
        }
      },
      releasePreDispatch: async (input) => {
        await leases.releasePreDispatch?.(input);
        await observeLeaseHydration();
      },
    }
  : leases;
const waitAtRecoveryMarker = async (expectedStatus) => {
  if (mode !== "crash-prepared") return;
  const recoveryBytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
  if (recoveryBytes === null) throw new Error("dispatch_crash_marker_missing");
  const marker = parseCanonicalJsonBytes(recoveryBytes);
  if (typeof marker !== "object" || marker === null || Array.isArray(marker) || marker.status !== expectedStatus) {
    throw new Error("dispatch_crash_marker_unexpected_status");
  }
  writeFileSync(crashReadyPath, canonicalJsonBytes({ status: marker.status }));
  console.error("crash-ready", marker.status);
  await new Promise(() => setInterval(() => {}, 1000));
};
const reserveDispatch = leases.reserveDispatch;
if (reserveDispatch === undefined) throw new Error("dispatch_reservation_missing");
const admissionLeases = mode === "crash-prepared"
  ? {
      ...leases,
      reserveDispatch: async (input) => {
        return reserveDispatch({
          ...input,
          onQueueCommitted: async () => {
            await input.onQueueCommitted?.();
            await waitAtRecoveryMarker("queue_committed");
          },
        });
      },
    }
  : observedLeases;
const createAdmissionContext = (resourceLease, ownershipLease, input) => {
  boundaryResourceLeaseRef = leaseRefOf(resourceLease);
  const ownershipLeaseRef = ownershipLease === null ? null : {
    ...rootLeaseRef, leaseId: ownershipLease.leaseId, acquisitionEventSequence: ownershipLease.acquisitionEventSequence,
  };
  return toAdmissionContext({
    ...dispatchInput, ...input, rootLeaseRef, resourceLease, ownershipLease,
    executionKey: input.executionKey, taskId: input.taskId, attemptId: input.attemptId, writerIdentity,
    ownershipLeaseRef, resourceLeaseRef: leaseRefOf(resourceLease), controlCapacity: task.declaredControlCapacity,
  });
};
const transaction = createWorkflowSchedulerDurableAdmissionTransaction({
  store: runtimeStore, leases: admissionLeases, queueState: observedQueueState,
  createAdmissionContext: (resourceLease, ownershipLease, input) => createAdmissionContext(resourceLease, ownershipLease, input),
  readTaskGraph: () => graph,
  readCurrentEpoch: async () => durable.epochRef,
  resolveRecipeAdmissionHost: async () => recipeHost,
});
await reportMarker("transaction");
if (mode === "refill" && (holdRecovery || waitForRecoveryOwner)) {
  writeFileSync(refillReadyPath, String(process.pid));
  while (true) {
    try {
      readFileSync(refillGoPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
if (mode === "refill" && waitForRecoveryOwner) {
  while (true) {
    try {
      readFileSync(recoveryOwnerPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
const launchAuthorization = async (input) => durable.withExclusiveLease("dispatch-public-launch", async () => {
  const prior = await durable.auxiliaryStore.read(launchRecordName);
  const record = { workflowId, epochRef, taskId: input.taskId, attemptId: input.attemptId, executionKey: input.executionKey, intent: "launch_authorized" };
  if (prior !== null && digestObject(parseCanonicalJsonBytes(prior)) !== digestObject(record)) throw new Error("launch_authorization_conflict");
  if (prior === null) await durable.auxiliaryStore.write(launchRecordName, canonicalJsonBytes(record));
  return record;
});
const readiness = async (input) => {
  const current = await runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
  return { workflowId, epochRef, rootLeaseRef: input.rootLeaseRef, leaseRef: leaseRefOf(input.resourceLease), executionKey: input.executionKey, revisionTuple, revisionRegistryRef, revisionRegistryDigest: revisionRegistryRef.digest, readinessDigest: digestObject(input), canDispatch: true, childSpawnPath: "separate_process", processStartIdentity: "verified", processGroup: "enforceable", artifactRoot, canonicalArtifactRoot: artifactRoot, artifactRootRelativePath: ".", artifactRootPathDigest: sha256Hex(artifactRoot), activeGenerationDigest: durable.generationId, configSnapshotDigest: input.configSnapshotDigest, currentHeadDigest: digestObject(current.head), currentHead: current.head, checks: { artifactRootVerified: true, rootLeaseVerified: true, currentEpochVerified: true, approvedConfigVerified: true, canonicalAdmissionBundleVerified: true, approvedEnvelopeVerified: true, kernelAdapterAvailable: true, authorityClosureVerified: true, workerCapabilityVerified: true }, blockingReasons: [], observedAt: new Date().toISOString() };
};
const dispatcher = {
  observe: async (input) => {
    const observed = await readiness(input);
    console.error("dispatch-observe", observed.canDispatch, observed.blockingReasons);
    return observed;
  },
  dispatch: async (input) => {
    await launchAuthorization(input);
    return { status: "disabled", phase: "readiness", admission: null, readiness: await readiness(input) };
  },
};
const scheduler = createWorkflowScheduler({
  graph, queueState: observedQueueState, dispatcher, leases: admissionLeases, store: runtimeStore, writerIdentity,
  readCurrentEpoch: async () => durable.epochRef, readRootLeaseRef: async () => durable.currentLeaseRef(), clock: { now: () => new Date().toISOString() },
  readRevisionBoundaryContext, revisionRegistry: { assertActive: async () => undefined },
  maxConcurrentAttempts: 1, workerPartition: { controlCapacity: task.declaredControlCapacity, resourceVector: { ...task.declaredResourceVector, cpuMilliCores: 1000, memoryBytes: 100000, diskBytes: 100000, ioWeight: 100000, wallMilliseconds: 100000, monetaryMicrounits: 100000 } },
  resolveAuthenticatedAdaptiveState: async () => ({ workflowId, currentEpoch: epochRef, revision: 1, policyRevision: 1, sourceJournalSequence: 1, sourceJournalDigest: sha256Hex("adaptive-source"), stateDigest: sha256Hex("adaptive-state"), allocationDigest: sha256Hex("adaptive-allocation"), policyDigest: sha256Hex("adaptive-policy"), criticalPathProofDigest: sha256Hex("adaptive-proof"), acceptedObservation: { artifactId: "adaptive-observation", relativePath: "artifacts/adaptive/observation", digest: sha256Hex("adaptive-observation"), sizeBytes: 1, sourceEventSequence: 1 }, criticalPathCertificateRef: { artifactId: "adaptive-certificate", relativePath: "artifacts/adaptive/certificate", digest: sha256Hex("adaptive-certificate"), sizeBytes: 1, sourceEventSequence: 1 }, allocationEntries: [], criticalPathTaskIds: [], readyQueue: [], runningQueue: [], marginalVerifiedProgressByResource: {}, uncertainty: {}, limitingPool: "cpu", safetyOverride: "none", allocationStatus: "stable" }),
  resolveRecipeAdmissionArtifact: async () => recipeAdmission,
  resolveRecipeSkillBindings: async () => [], readCurrentRecipeHostHeadDigest: async () => currentRecipeHostHeadDigest,
  consumeRecipeAdmission: async (admission) => durable.withExclusiveLease("dispatch-public-recipe", async () => {
    const recordName = "dispatch-public-recipe-" + admission.admissionDigest.slice(0, 48);
    const current = await durable.auxiliaryStore.read(recordName);
    if (current === null) await durable.auxiliaryStore.write(recordName, canonicalJsonBytes(admission));
  }),
  durableAdmissionTransaction: transaction,
});
const refreshRecipeAdmission = async (headDigest) => {
  const refreshed = await createPrimeWorkflowFixture(artifactRoot, workflowId, epochRef, headDigest);
  recipeAdmission = freezeRecipe(refreshed.snapshots.recipe);
  recipeHost = refreshed.recipeHost;
  currentRecipeHostHeadDigest = headDigest;
  const currentQueue = await readQueue();
  if (currentQueue !== null) {
    const nextQueue = {
      ...currentQueue,
      epochRef,
      entries: currentQueue.entries.map((entry) => ({
        ...entry,
        input: { ...entry.input, epochRef },
        recipeAdmissionDigest: recipeAdmission.admissionDigest,
      })),
    };
    await queueState.compareAndSwap({
      workflowId,
      epochRef,
      expectedStateDigest: digestObject(currentQueue),
      nextState: nextQueue,
      idempotencyKey: "dispatch-public-recipe-refresh:" + headDigest,
    });
    await durable.auxiliaryStore.write("dispatch-public-recipe.json", canonicalJsonBytes(recipeAdmission));
  }
};
const recoverBeforeRefill = async (marker, currentReplay) => {
  const queued = marker.previousState.entries.find((entry) => entry.input.attemptId === attemptId);
  if (queued === undefined) throw new Error("dispatch_recovery_queue_entry_missing");
  const resource = {
    workflowId,
    taskId: task.taskId,
    attemptId,
    executionKey,
    epochRef,
    vector: task.declaredResourceVector,
    controlCapacity: task.declaredControlCapacity,
    enforcementClass: "host_bounded",
    processSlots: task.declaredControlCapacity.processSlots,
    conflictKey: workflowId + ":" + task.taskId,
    queuePriority: queued.priority,
    queuedAt: queued.queuedAt,
    controlPlane: false,
  };
  const ownership = task.ownedPaths.length > 0 || task.ownedContracts.length > 0
    ? { ...resource, ownedPaths: task.ownedPaths, ownedContracts: task.ownedContracts }
    : null;
  recoveryObservationEnabled = true;
  recoveryOwnerProcessIdentityBeforeRefill = marker.ownerProcessIdentity ?? null;
  const waitForRecoveryOwner = async () => {
    const deadline = Date.now() + 30000;
    while (true) {
      const bytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
      if (bytes === null) throw new Error("dispatch_recovery_marker_missing_while_waiting");
      const observed = parseCanonicalJsonBytes(bytes);
      if (typeof observed !== "object" || observed === null || Array.isArray(observed))
        throw new Error("dispatch_recovery_marker_invalid_while_waiting");
      if (observed.status === "committed" || observed.status === "rolled_back") return observed;
      if (typeof observed.ownerProcessIdentity !== "string" || observed.ownerProcessIdentity.length === 0)
        throw new Error("dispatch_recovery_owner_missing_while_waiting");
      if (Date.now() >= deadline) throw new Error("dispatch_recovery_owner_wait_timeout");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  let preflightSucceeded = false;
  try {
    await transaction.commit({
      workflowId,
      epochRef,
      taskId: task.taskId,
      attemptId,
      executionKey,
      expectedStateDigest: digestObject(marker.previousState),
      expectedHeadDigest: digestObject(currentReplay.head),
      previousState: marker.previousState,
      nextState: marker.nextState,
      resource,
      ownership,
      recipeAdmission,
      admissionDigest: recipeAdmission.admissionDigest,
      recipeId: recipeAdmission.recipeId,
      recipeRevision: recipeAdmission.revision,
      requiredSkillSnapshotDigests: task.requiredSkillSnapshotDigests,
      skillBindings: [],
      consumeRecipeAdmission: async () => undefined,
    });
    preflightSucceeded = true;
  } catch (error) {
    const recoveryAfterBytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
    if (recoveryAfterBytes !== null) recoveryMarkerStatusAfterRecovery = parseCanonicalJsonBytes(recoveryAfterBytes).status;
    if (error?.code === "workflow_scheduler_dispatch_in_progress") {
      recoveryOwnerFenceObserved = true;
      const terminal = await waitForRecoveryOwner();
      recoveryMarkerStatusAfterRecovery = terminal.status;
    }
    if (recoveryMarkerStatusAfterRecovery !== "rolled_back" && recoveryMarkerStatusAfterRecovery !== "committed") throw error;
    const terminalBytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
    if (terminalBytes !== null) recoveryOwnerProcessIdentityAfterRecovery = parseCanonicalJsonBytes(terminalBytes).ownerProcessIdentity ?? null;
  }
  if (preflightSucceeded) throw new Error("dispatch_recovery_preflight_unexpected_success");
};
if (mode === "crash-prepared") {
  console.error("crash-head", digestObject(replayBeforeFixture.head));
  await scheduler.refill(workflowId, epochRef);
  throw new Error("dispatch_crash_injection_not_reached");
}
let refillResults = [];
let recoveryMarkerStatusBeforeRefill = null;
let recoveryMarkerStatusAfterRefill = null;
let recoveryQueueDigestBeforeRefill = null;
let recoveryMarkerConsumed = false;
if (mode === "setup") {
  await durable.auxiliaryStore.write("dispatch-public-recipe.json", canonicalJsonBytes(recipeAdmission));
  await scheduler.enqueue(dispatchInput, new Date().toISOString());
} else if (mode === "refill") {
  const currentReplay = await runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
  const currentHeadDigest = digestObject(currentReplay.head);
  const recoveryBytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
  if (recoveryBytes !== null) {
    const marker = parseCanonicalJsonBytes(recoveryBytes);
    const currentQueue = await readQueue();
    recoveryMarkerStatusBeforeRefill = marker.status;
    recoveryPreviousStateDigest = digestObject(marker.previousState);
    recoveryNextStateDigest = digestObject(marker.nextState);
    recoveryMarkerResourceLease = marker.resourceLease;
    recoveryQueueDigestBeforeRefill = currentQueue === null ? null : digestObject(currentQueue);
    console.error("dispatch-recovery-queue", marker.status, digestObject(marker.previousState), currentQueue === null ? null : digestObject(currentQueue));
    if (marker.status !== "committed" && marker.status !== "rolled_back") {
      await recoverBeforeRefill(marker, currentReplay);
    }
  }
  const postRecoveryReplay = await runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
  const postRecoveryHeadDigest = digestObject(postRecoveryReplay.head);
  if (recipeAdmission.hostHeadDigest !== postRecoveryHeadDigest || digestObject(recipeAdmission.hostEpochRef) !== digestObject(epochRef)) {
    await refreshRecipeAdmission(postRecoveryHeadDigest);
  }
  recoveryObservationEnabled = true;
  refillResults = await scheduler.refill(workflowId, epochRef);
  const recoveryAfterBytes = await durable.auxiliaryStore.read("workflow-dispatch-recovery");
  if (recoveryAfterBytes !== null) recoveryMarkerStatusAfterRefill = parseCanonicalJsonBytes(recoveryAfterBytes).status;
  recoveryMarkerConsumed =
    recoveryMarkerStatusBeforeRefill === "queue_committed" &&
    recoveryMarkerStatusAfterRecovery === "rolled_back" &&
    recoveryMarkerStatusAfterRefill === "committed" &&
    recoveryRollbackObserved &&
    recoveryRollbackPersisted &&
    recoveryHydrationObserved &&
    recoveryQueueReconstructed;
}
const replay = await runtimeStore.replay({ workflowId, fromSequence: 0, expectedStoreEpoch: epochRef.storeEpoch });
const intents = replay.events.filter((event) => event.payload.kind === "workflow_dispatch_intent");
const resources = replay.events.filter((event) => event.payload.kind === "workflow_resource_lease_acquired");
const ownership = replay.events.filter((event) => event.payload.kind === "workflow_ownership_lease_acquired");
const releaseRefs = replay.events
  .filter((event) => event.payload.kind === "workflow_lease_release_recorded")
  .map((event) => event.payload.releaseRef.leaseRef.leaseId);
const releasedLeaseIds = new Set(releaseRefs);
const resourceLeaseIds = new Set(resources.map((event) => event.payload.lease.leaseId));
const ownershipLeaseIds = new Set(ownership.map((event) => event.payload.lease.leaseId));
const resourceAdmissions = resources.filter((event) => !releasedLeaseIds.has(event.payload.lease.leaseId)).map((event) => ({
  leaseId: event.payload.lease.leaseId,
  taskId: event.payload.lease.taskId,
  attemptId: event.payload.lease.attemptId,
  executionKey: event.executionKey,
  grantKind: event.payload.lease.resourceAdmission.capacityGrant.kind,
  leaseStatus: event.payload.lease.status,
  reservedVectorDigest: digestObject(event.payload.lease.resourceAdmission.reservedVector),
}));
const ownershipAdmissions = ownership.filter((event) => !releasedLeaseIds.has(event.payload.lease.leaseId)).map((event) => ({
  leaseId: event.payload.lease.leaseId,
  taskId: event.payload.lease.taskId,
  attemptId: event.payload.lease.attemptId,
  executionKey: event.executionKey,
  grantKind: null,
  leaseStatus: event.payload.lease.status,
  reservedVectorDigest: null,
}));
const recoveryReleasedResourceLeases = releaseRefs.filter((leaseId) => resourceLeaseIds.has(leaseId)).length;
const recoveryReleasedOwnershipLeases = releaseRefs.filter((leaseId) => ownershipLeaseIds.has(leaseId)).length;
const dispatchBindings = intents.map((event) => ({
  taskId: event.payload.taskId,
  attemptId: event.payload.attemptId,
  executionKey: event.payload.executionKey,
  admissionId: event.payload.admissionId,
}));
const launch = await durable.auxiliaryStore.read(launchRecordName);
const queueAfterRun = await readQueue();
const queueBindings = queueAfterRun?.entries?.map((entry) => ({
  taskId: entry.input.taskId,
  attemptId: entry.input.attemptId,
  executionKey: entry.input.executionKey,
  blockedBy: entry.blockedBy ?? [],
})) ?? [];
console.log(JSON.stringify({ mode, intents: intents.length, resourceLeases: resources.length, ownershipLeases: ownership.length, resourceAdmissions, ownershipAdmissions, dispatchBindings, eventKinds: replay.events.map((event) => event.payload.kind), launchAuthorizationDigest: launch === null ? null : digestObject(parseCanonicalJsonBytes(launch)), refillStatuses: refillResults.map((result) => result.status), queuedEntries: queueAfterRun?.entries?.length ?? 0, activeAttemptIds: queueAfterRun?.activeAttemptIds ?? [], queueBindings, blockedBy: queueAfterRun?.entries?.flatMap((entry) => entry.blockedBy ?? []) ?? [], queuedRecipeDigest: queueAfterRun?.entries?.[0]?.recipeAdmissionDigest ?? null, fixtureRecipeDigest: recipeAdmission.admissionDigest, fixtureHeadDigest: recipeAdmission.hostHeadDigest, replayHeadDigest: digestObject(replayBeforeFixture.head), recoveryMarkerStatusBeforeRefill, recoveryMarkerStatusAfterRecovery, recoveryMarkerStatusAfterRefill, recoveryOwnerProcessIdentityBeforeRefill, recoveryOwnerProcessIdentityAfterRecovery, recoveryOwnerFenceObserved, recoveryPreviousStateDigest, recoveryNextStateDigest, recoveryQueueDigestBeforeRefill, recoveryQueueDigestAfterRollback, recoveryQueueReconstructed, recoveryMarkerConsumed, recoveryRollbackObserved, recoveryRollbackPersisted, recoveryHydrationObserved, recoveryHydratedLeaseStatus, recoveryHydratedExecutionKey, recoveryHydratedActiveVectorDigest, recoveryReleasedResourceLeases, recoveryReleasedOwnershipLeases, releasedLeaseIds: [...releasedLeaseIds], recipeError }));
await host.dispose?.();
`;
}

async function runChildOnce(input: ChildOptions): Promise<ChildResult> {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx/esm",
			"--input-type=module",
			"-e",
			childSource(),
			input.artifactRoot,
			input.rootSessionId,
			input.workflowId,
			input.writerIdentity,
			input.processIdentity,
			input.mode,
			input.holdRecovery === true ? "1" : "0",
			input.waitForRecoveryOwner === true ? "1" : "0",
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	let stdout = "";
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => child.kill("SIGKILL"), DISPATCH_CHILD_TIMEOUT_MILLISECONDS);
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.once("error", reject);
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				reject(new Error(`dispatch public child exited ${code}: ${stderr}`));
				return;
			}
			if (stderr.length > 0) console.log("dispatch-public-crash", stderr.trim());
			resolve();
		});
	});
	const line = stdout.trim().split("\n").at(-1);
	if (line === undefined) throw new Error(`dispatch public child produced no result: ${stderr}`);
	return JSON.parse(line) as ChildResult;
}

async function runChild(input: ChildOptions): Promise<ChildResult> {
	return runChildOnce(input);
}

async function runCrashChild(input: ChildOptions): Promise<void> {
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx/esm",
			"--input-type=module",
			"-e",
			childSource(),
			input.artifactRoot,
			input.rootSessionId,
			input.workflowId,
			input.writerIdentity,
			input.processIdentity,
			input.mode,
			input.holdRecovery === true ? "1" : "0",
			input.waitForRecoveryOwner === true ? "1" : "0",
		],
		{ cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] },
	);
	lastCrashChildPid = child.pid;
	console.log("dispatch-crash-pid", child.pid);
	let stderr = "";
	await new Promise<void>((resolve, reject) => {
		let settled = false;
		let crashObserved = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			reject(new Error(`dispatch crash child did not publish its queue-committed marker: ${stderr}`));
		}, 8_000);
		const rejectChild = (error: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			reject(error);
		};
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
			console.log("dispatch-crash-stderr", chunk.toString().trim());
		});
		child.once("error", rejectChild);
		child.once("exit", (code, signal) => {
			if (settled) return;
			if (!crashObserved) {
				rejectChild(
					new Error(
						`dispatch crash child exited before its queue-committed marker (${code ?? signal}): ${stderr}`,
					),
				);
				return;
			}
			if (signal !== "SIGKILL") {
				rejectChild(
					new Error(
						`dispatch crash child exited with ${code ?? signal} after its queue-committed marker: ${stderr}`,
					),
				);
				return;
			}
			clearTimeout(timeout);
			settled = true;
			resolve();
		});
		const waitForCrashMarker = async (): Promise<void> => {
			while (!settled) {
				let readyBytes: Uint8Array | undefined;
				try {
					readyBytes = new Uint8Array(await readFile(`${input.artifactRoot}/dispatch-public-crash-ready`));
				} catch (error) {
					if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
						rejectChild(error);
						return;
					}
				}
				if (readyBytes !== undefined) {
					let ready: unknown;
					try {
						ready = parseCanonicalJsonBytes(readyBytes);
					} catch (error) {
						rejectChild(error);
						return;
					}
					if (
						typeof ready !== "object" ||
						ready === null ||
						Array.isArray(ready) ||
						!("status" in ready) ||
						ready.status !== "queue_committed"
					) {
						rejectChild(new Error("dispatch crash child published an unexpected queue-committed marker"));
						return;
					}
					crashObserved = true;
					if (child.exitCode !== null || child.signalCode !== null) {
						rejectChild(new Error(`dispatch crash child exited before SIGKILL: ${stderr}`));
						return;
					}
					child.kill("SIGKILL");
					return;
				}
				await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
			}
		};
		void waitForCrashMarker().catch(rejectChild);
	});
	await rm(`${input.artifactRoot}/workflows/${input.workflowId}/append-lease.guard`, { force: true });
}

it("uses one durable scheduler intent across competing filesystem processes", async () => {
	const artifactRoot = await mkdtemp(`${tmpdir()}/workflow-dispatch-public-process-`);
	const rootSessionId = "dispatch-public-session";
	const workflowId = "dispatch-public-workflow";
	const writerIdentity = "dispatch-public-writer";
	const expectedBinding = expectedDispatchBinding(workflowId, rootSessionId);
	const expectedRetryBinding = expectedDispatchBinding(workflowId, rootSessionId, "dispatch-public-attempt:retry:1");
	const releasedResourceLeaseId = `resource:${workflowId}:dispatch-public-attempt`;
	const releasedOwnershipLeaseId = `ownership:${workflowId}:dispatch-public-attempt`;
	const recoveredResourceLeaseId = `resource:${workflowId}:dispatch-public-attempt:retry:1`;
	const recoveredOwnershipLeaseId = `ownership:${workflowId}:dispatch-public-attempt:retry:1`;
	console.log("dispatch-public-root", artifactRoot);
	let bootstrap: Awaited<ReturnType<typeof createPersistedSessionWorkflowHost>> | undefined;
	let primaryFailure: unknown;
	try {
		bootstrap = await createPersistedSessionWorkflowHost({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			genesisEpoch: EPOCH,
			processIdentity: TEST_BOOTSTRAP_PROCESS_IDENTITY,
			goalProjection: goalProjection(),
		});
		const durable = bootstrap.runtimeStore.durableContext;
		if (durable === undefined) throw new Error("bootstrap_durable_context_missing");
		await bootstrap.execute({
			kind: "start",
			request: {
				workflowId,
				objective: "public durable dispatch process test",
				acceptanceChecks: ["exactly one dispatch intent reserves capacity"],
				protectedInvariants: ["resource and ownership leases remain atomic"],
			},
		});
		const startedGoal = bootstrap.status().goal;
		if (startedGoal === null) throw new Error("dispatch_public_goal_missing");
		await writeFile(`${artifactRoot}/dispatch-public-goal.json`, canonicalJsonBytes(startedGoal), { mode: 0o600 });
		await bootstrap.dispose?.();
		bootstrap = undefined;

		const setup = await runChild({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			processIdentity: TEST_BOOTSTRAP_PROCESS_IDENTITY,
			mode: "setup",
		});
		console.log("dispatch-public-setup", setup);
		expect(setup.intents).toBe(0);
		console.log(
			"dispatch-pre-crash-marker-exists",
			await readFile(`${artifactRoot}/workflows/${workflowId}/workflow-dispatch-recovery`)
				.then(() => true)
				.catch(() => false),
		);
		await runCrashChild({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			processIdentity: TEST_BOOTSTRAP_PROCESS_IDENTITY,
			mode: "crash-prepared",
		});
		console.log("dispatch-crash-returned");
		console.log(
			"dispatch-crash-pid-alive",
			(() => {
				if (lastCrashChildPid === undefined) return false;
				try {
					process.kill(lastCrashChildPid, 0);
					return true;
				} catch {
					return false;
				}
			})(),
		);
		const crashMarkerEnvelope = JSON.parse(
			await readFile(`${artifactRoot}/workflows/${workflowId}/workflow-dispatch-recovery`, "utf8"),
		) as { payload: number[] };
		const crashMarker = parseCanonicalJsonBytes(new Uint8Array(crashMarkerEnvelope.payload)) as {
			status: string;
			ownerProcessIdentity?: string;
		};
		console.log("dispatch-post-crash-marker", crashMarker.status);
		expect(crashMarker.status).toBe("queue_committed");
		expect(crashMarker.ownerProcessIdentity).toMatch(/^process:\d+:/u);
		await new Promise((resolve) => setTimeout(resolve, 2_000));
		const delayedCrashMarkerEnvelope = JSON.parse(
			await readFile(`${artifactRoot}/workflows/${workflowId}/workflow-dispatch-recovery`, "utf8"),
		) as { payload: number[] };
		const delayedCrashMarker = parseCanonicalJsonBytes(new Uint8Array(delayedCrashMarkerEnvelope.payload)) as {
			status: string;
		};
		console.log("dispatch-delayed-crash-marker", delayedCrashMarker.status);
		expect(delayedCrashMarker.status).toBe("queue_committed");
		console.log("dispatch-refill-one-start");
		const firstRefill = runChild({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			processIdentity: TEST_BOOTSTRAP_PROCESS_IDENTITY,
			mode: "refill",
			holdRecovery: true,
		});
		const secondRefill = runChild({
			artifactRoot,
			rootSessionId,
			workflowId,
			writerIdentity,
			processIdentity: TEST_BOOTSTRAP_PROCESS_IDENTITY,
			mode: "refill",
			waitForRecoveryOwner: true,
		});
		const refillReadyDeadline = Date.now() + 10_000;
		while (true) {
			try {
				await readFile(`${artifactRoot}/dispatch-public-refill-ready-owner`);
				await readFile(`${artifactRoot}/dispatch-public-refill-ready-wait`);
				break;
			} catch (error) {
				if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (Date.now() >= refillReadyDeadline) throw new Error("dispatch refill barrier not reached");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await writeFile(`${artifactRoot}/dispatch-public-refill-go`, "go", { mode: 0o600 });
		const recoveryOwnerDeadline = Date.now() + 10_000;
		while (true) {
			try {
				await readFile(`${artifactRoot}/dispatch-public-recovery-owner`);
				break;
			} catch (error) {
				if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (Date.now() >= recoveryOwnerDeadline) throw new Error("dispatch recovery owner claim not observed");
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		await writeFile(`${artifactRoot}/dispatch-public-recovery-release`, "release", { mode: 0o600 });
		const results = await Promise.all([firstRefill, secondRefill]);
		console.log("dispatch-public-results", results);
		expect(results.map((result) => result.intents)).toEqual([1, 1]);
		expect(results.map((result) => result.resourceLeases)).toEqual([2, 2]);
		expect(results.map((result) => result.ownershipLeases)).toEqual([2, 2]);
		expect(new Set(results.map((result) => result.launchAuthorizationDigest)).size).toBe(1);
		for (const result of results) {
			expect(result.resourceAdmissions).toHaveLength(1);
			expect(result.resourceAdmissions[0]).toMatchObject({
				leaseId: recoveredResourceLeaseId,
				taskId: "recon",
				attemptId: "dispatch-public-attempt:retry:1",
				executionKey: expectedRetryBinding.executionKey,
				grantKind: "worker",
				leaseStatus: "active",
			});
			expect(result.ownershipAdmissions).toEqual([
				{
					leaseId: recoveredOwnershipLeaseId,
					taskId: "recon",
					attemptId: "dispatch-public-attempt:retry:1",
					executionKey: expectedRetryBinding.executionKey,
					grantKind: null,
					leaseStatus: "active",
					reservedVectorDigest: null,
				},
			]);
			expect(result.dispatchBindings).toEqual([
				{
					taskId: "recon",
					attemptId: "dispatch-public-attempt:retry:1",
					executionKey: expectedRetryBinding.executionKey,
					admissionId: expectedRetryBinding.admissionId,
				},
			]);
			expect(result.activeAttemptIds).toEqual(["dispatch-public-attempt:retry:1"]);
			expect(result.queueBindings).toEqual([
				{
					taskId: "recon",
					attemptId: "dispatch-public-attempt:retry:1",
					executionKey: expectedRetryBinding.executionKey,
					blockedBy: [],
				},
			]);
		}
		expect(results.every((result) => result.recoveryMarkerStatusAfterRefill === "committed")).toBe(true);
		expect(results.every((result) => result.recoveryReleasedResourceLeases === 1)).toBe(true);
		expect(results.every((result) => result.recoveryReleasedOwnershipLeases === 1)).toBe(true);
		const recoveredResult = results.find((result) => result.recoveryMarkerConsumed);
		expect(recoveredResult).toBeDefined();
		expect(recoveredResult?.recoveryMarkerStatusBeforeRefill).toBe("queue_committed");
		expect(recoveredResult?.recoveryOwnerProcessIdentityBeforeRefill).toMatch(/^process:\d+:/u);
		expect(recoveredResult?.recoveryOwnerProcessIdentityAfterRecovery).toMatch(/^process:\d+:/u);
		expect(results.some((result) => result.recoveryOwnerFenceObserved)).toBe(true);
		expect(recoveredResult?.recoveryMarkerStatusAfterRefill).toBe("committed");
		expect(recoveredResult?.recoveryQueueReconstructed).toBe(true);
		expect(recoveredResult?.recoveryQueueDigestBeforeRefill).toBe(recoveredResult?.recoveryNextStateDigest);
		expect(recoveredResult?.recoveryQueueDigestAfterRollback).toBe(recoveredResult?.recoveryPreviousStateDigest);
		expect(recoveredResult?.recoveryRollbackObserved).toBe(true);
		expect(recoveredResult?.recoveryRollbackPersisted).toBe(true);
		expect(recoveredResult?.recoveryHydrationObserved).toBe(true);
		expect(recoveredResult?.recoveryHydratedLeaseStatus).toBe("released");
		expect(recoveredResult?.recoveryHydratedExecutionKey).toBe(expectedBinding.executionKey);
		expect(recoveredResult?.recoveryHydratedActiveVectorDigest).toBe(
			digestObject({
				cpuMilliCores: 0,
				memoryBytes: 0,
				diskBytes: 0,
				ioWeight: 0,
				accelerators: [],
				providers: [],
				networkEgressBytes: 0,
				wallMilliseconds: 0,
				monetaryMicrounits: 0,
			}),
		);
		expect(recoveredResult?.releasedLeaseIds).toEqual(
			expect.arrayContaining([releasedResourceLeaseId, releasedOwnershipLeaseId]),
		);
		expect(recoveredResult?.resourceAdmissions[0]?.leaseId).not.toBe(releasedResourceLeaseId);
		expect(recoveredResult?.ownershipAdmissions[0]?.leaseId).not.toBe(releasedOwnershipLeaseId);
	} catch (error) {
		primaryFailure = error;
	}
	await bootstrap?.dispose?.().catch(() => undefined);
	let cleanupFailure: unknown;
	if (process.env.KEEP_DISPATCH_ARTIFACTS !== "1") {
		try {
			await rm(artifactRoot, { recursive: true, force: true });
		} catch (error) {
			cleanupFailure = error;
			if (primaryFailure !== undefined) console.error("dispatch-cleanup-failed", error);
		}
	}
	if (primaryFailure !== undefined) throw primaryFailure;
	if (cleanupFailure !== undefined) throw cleanupFailure;
}, 180_000);
