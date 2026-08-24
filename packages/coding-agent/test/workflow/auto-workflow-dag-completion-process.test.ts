import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, expect, it } from "vitest";

const children = new Set<ChildProcess>();
const temporaryRoots: string[] = [];
const childErrors = new WeakMap<ChildProcess, { value: string }>();

afterEach(() => {
	for (const child of children) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	children.clear();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function childSource(): string {
	const contractsModule = pathToFileURL(`${process.cwd()}/src/core/workflow/contracts.ts`).href;
	const goalsModule = pathToFileURL(`${process.cwd()}/src/core/goals.ts`).href;
	const hostModule = pathToFileURL(`${process.cwd()}/src/core/workflow/session-host-factory.ts`).href;
	const runtimeModule = pathToFileURL(`${process.cwd()}/src/core/workflow/default-task-runtime-authority.ts`).href;
	const taskRuntimeModule = pathToFileURL(`${process.cwd()}/src/core/workflow/default-task-runtime.ts`).href;

	return `
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyGoalState } from ${JSON.stringify(goalsModule)};
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from ${JSON.stringify(contractsModule)};
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(hostModule)};
import { createDefaultTaskRuntimeAuthority } from ${JSON.stringify(runtimeModule)};
import {
  defaultPrimeWorkerOutputContract,
  defaultPrimeWorkerTaskCapsuleDigest,
  defaultPrimeWorkerTaskCapsuleReceiptBindingDigest,
} from ${JSON.stringify(taskRuntimeModule)};

const mode = process.argv[1];
const artifactRoot = process.argv[2];
if ((mode !== "setup" && mode !== "recover" && mode !== "retry-setup" && mode !== "retry-recover") || artifactRoot === undefined)
  throw new Error("Usage: auto-workflow-dag-completion-process <setup|recover|retry-setup|retry-recover> <artifact-root>");

const workflowId = "auto-workflow-dag-completion-workflow";
const rootSessionId = "auto-workflow-dag-completion-session";
const writerIdentity = "auto-workflow-dag-completion-writer";
const runtimeVersion = "0.147.0-alpha.10";
const genesisEpoch = { storeEpoch: 1, coordinatorEpoch: 1 };
const taskId = "collect-payment-proof";
const retryMode = mode === "retry-setup" || mode === "retry-recover";
const sourceDigest = digestObject({
  kind: "immutable-task-graph-source",
  objective: "publish a payment boundary proof",
  taskId,
});
const goalPath = join(artifactRoot, "goal.json");
const fencePath = join(artifactRoot, "fence.json");
const resultPath = join(artifactRoot, "result.json");
const goalRevisionDigest = digestObject({ workflowId, objective: "publish a payment boundary proof" });

function readGoal() {
  if (!existsSync(goalPath)) {
    const goal = emptyGoalState();
    writeFileSync(goalPath, canonicalJsonBytes(goal));
    return goal;
  }
  return parseCanonicalJsonBytes(new Uint8Array(readFileSync(goalPath)));
}

const goalProjection = {
  read: () => structuredClone(readGoal()),
  compareAndSwap: (expected, next) => {
    if (digestObject(readGoal()) !== digestObject(expected)) return false;
    writeFileSync(goalPath, canonicalJsonBytes(next));
    return true;
  },
};

function taskGraph() {
  const task = {
    taskId,
    planRevision: 1,
    objective: "Publish a payment boundary proof",
    requirementIds: ["payment-release"],
    completionCriteria: ["payment boundary evidence is immutable"],
    dependencyTaskIds: [],
    inputRefs: ["payment-boundary"],
    boundaryIds: ["no-pre-authority-effects"],
    outputRefs: ["payment-proof"],
    evidencePolicy: { kind: "boundary_observation", maxBytes: 4096, maxItems: 8, independent: true },
    evidenceKind: "boundary_observation",
    budget: { tokenLimit: 1000, wallTimeLimitSeconds: 60, spendLimitMicrounits: 7 },
    recoveryPolicy: retryMode ? "retry" : "block",
    taskGraphSourceDigest: sourceDigest,
    ownedPaths: [],
    ownedContracts: [],
    requiredSkillSnapshotDigests: [],
    verificationCommandDigests: [],
    authority: ["read_workspace"],
    declaredResourceVector: {
      cpuMilliCores: 1,
      memoryBytes: 1,
      diskBytes: 1,
      ioWeight: 1,
      accelerators: [],
      providers: [],
      networkEgressBytes: 0,
      wallMilliseconds: 60_000,
      monetaryMicrounits: 7,
    },
    declaredControlCapacity: {
      processSlots: 0,
      childSessionSlots: 0,
      modelCallSlots: 0,
      modelInputTokens: 0,
      modelOutputTokens: 0,
      verificationSlots: 0,
      redTeamSlots: 0,
      recoverySlots: 0,
    },
    status: "ready",
    attemptIds: [],
  };
  return {
    graphRevision: 1,
    tasks: [task],
    byId: new Map([[taskId, task]]),
    allowedAuthority: ["read_workspace"],
    ownershipPaths: [],
    generatedOutputPaths: ["artifacts/out"],
    lockPaths: [],
    namedContracts: [],
    graphDigest: digestObject([task]),
  };
}

function createTaskCapsule(request, graph) {
  const core = {
    schemaVersion: 1,
    kind: "default_prime_worker_task_capsule",
    workflowId,
    taskId,
    attemptId: request.attemptId,
    executionKey: request.executionKey,
    epochRef: request.epochRef,
    journalHead: request.journalHead,
    goalRevisionDigest,
    goalBindingDigest: digestObject({ goalRevisionDigest }),
    graphDigest: graph.graphDigest,
    taskGraphSourceDigest: sourceDigest,
    recipeCapability: "dynamic_task_graph",
    recipeDigest: "a".repeat(64),
    admissionDigest: "b".repeat(64),
    objective: request.task.objective,
    requirementIds: request.task.requirementIds,
    completionCriteria: request.task.completionCriteria,
    dependencyTaskIds: request.task.dependencyTaskIds,
    inputRefs: request.task.inputRefs,
    boundaryIds: request.task.boundaryIds,
    outputRefs: request.task.outputRefs,
    evidencePolicy: request.task.evidencePolicy,
    evidenceKind: request.task.evidenceKind,
    budget: request.task.budget,
    recoveryPolicy: request.task.recoveryPolicy,
    authority: request.task.authority,
    deadlineAt: request.deadlineAt,
    outputContract: defaultPrimeWorkerOutputContract({
      taskId,
      logicalPath: "artifacts/out/collect-payment-proof.json",
      evidencePolicyId: "evidence-collect-payment-proof",
      evidenceKind: "boundary_observation",
      maxBytes: 4096,
      maxItems: 8,
      independent: true,
    }),
    forbiddenOutcomes: ["prose_only_result", "unbound_or_extra_output", "protected_or_holdout_data"],
    terminalReturnProtocol: "canonical_json_only",
  };
  const capsuleDigest = defaultPrimeWorkerTaskCapsuleDigest(core);
  const artifactRef = {
    artifactId: "task-capsule-receipt",
    relativePath: "artifacts/evidence/" + "c".repeat(64),
    digest: "c".repeat(64),
    sizeBytes: 1,
    sourceEventSequence: request.journalHead.sequence,
  };
  return {
    ...core,
    capsuleDigest,
    receipt: {
      receiptKind: "artifact",
      oneUse: false,
      receiptId: "task-capsule-receipt",
      issuerId: "workflow-host",
      workflowId,
      bindingDigest: defaultPrimeWorkerTaskCapsuleReceiptBindingDigest(capsuleDigest),
      payloadDigest: capsuleDigest,
      artifactRef,
      issuedAt: "2026-08-18T20:00:00.000Z",
      validUntil: "2030-08-18T20:00:00.000Z",
      keyId: "workflow-host-key",
      signatureAlgorithm: "ed25519",
      artifactBytesDigest: artifactRef.digest,
      stateDigest: request.journalHead.eventDigest,
      revision: 1,
      signature: "signed",
      verificationDigest: "verified",
    },
  };
}

async function openHost() {
  let deliveredProofs = {};
  const host = await createPersistedSessionWorkflowHost({
    artifactRoot,
    rootSessionId,
    workflowId,
    writerIdentity,
    runtimeVersion,
    genesisEpoch,
    goalProjection,
    approvalSecretDelivery: ({ proofs }) => {
      deliveredProofs = proofs;
    },
  });
  if (mode !== "setup" && mode !== "retry-setup") return host;
  const pending = await host.execute({
    kind: "start",
    request: {
      workflowId,
      objective: "publish a payment boundary proof",
      requestedProfile: "parallel",
      maxWorkers: 1,
      acceptanceChecks: ["payment-release"],
      protectedInvariants: ["no-pre-authority-effects"],
    },
  });
  if (pending.status !== "awaiting_user" || pending.approvalRequest === null)
    throw new Error("auto_workflow_dag_approval_missing");
  const option = pending.approvalRequest.options.find((candidate) => deliveredProofs[candidate.optionId] !== undefined);
  if (option === undefined) throw new Error("auto_workflow_dag_approval_proof_missing");
  const active = await host.execute({
    kind: "respond",
    approvalRequestId: pending.approvalRequest.approvalRequestId,
    optionId: option.optionId,
    proof: deliveredProofs[option.optionId],
  });
  if (active.status !== "active") throw new Error("auto_workflow_dag_workflow_not_active");
  return host;
}

const host = await openHost();
const durable = host.runtimeStore.durableContext;
if (durable === undefined) throw new Error("auto_workflow_dag_durable_context_missing");
const epochRef = { ...durable.epochRef };
const graph = taskGraph();
const status = host.status();
let launches = 0;
const authority = createDefaultTaskRuntimeAuthority({
  runtimeStore: (mode === "setup" || mode === "retry-setup") ? (() => {
    let terminalPublicationSeen = false;
    let releaseFence;
    const fence = new Promise((resolve) => { releaseFence = resolve; });
    const runtimeStore = Object.create(host.runtimeStore);
    Object.defineProperty(runtimeStore, "publishArtifact", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: async (input) => {
        const publication = await host.runtimeStore.publishArtifact(input);
        if (input.idempotencyKey.startsWith("default-prime-worker-terminal:") && !terminalPublicationSeen) {
          const packet = parseCanonicalJsonBytes(input.bytes);
          if (retryMode && packet.kind !== "default_prime_generated_task_output") return publication;
          terminalPublicationSeen = true;
          writeFileSync(fencePath, canonicalJsonBytes({ terminalResultPublished: true, kind: packet.kind }));
          await fence;
        }
        return publication;
      },
    });
    return runtimeStore;
  })() : host.runtimeStore,
  workflowId,
  rootSessionId,
  epochRef,
  decisionRef: (() => {
    const decision = status.decisionRefs.at(-1);
    if (decision === undefined) throw new Error("auto_workflow_dag_decision_missing");
    return { ...decision, storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch };
  })(),
  goalRevisionDigest,
  graph,
  maxWorkers: 1,
  now: () => new Date().toISOString(),
  scheduleProgressWake: async () => "scheduled",
  createTaskCapsule: (request) => createTaskCapsule(request, graph),
  workerLauncher: async (input) => {
    launches += 1;
    if (mode === "recover" || mode === "retry-recover") throw new Error("auto_workflow_dag_unexpected_relaunch");
    const retryAttempt = input.attemptId.includes(":retry:");
    if (retryMode && !retryAttempt) {
      return {
        workerId: "worker:" + input.taskId,
        executionIdentity: "execution:" + input.executionKey,
        processStartId: "start:" + process.pid,
        processGroupId: "group:" + process.pid,
        launchedAt: new Date().toISOString(),
        completion: Promise.resolve({
          kind: "worker",
          binding: {
            workflowId: input.workflowId,
            taskId: input.taskId,
            attemptId: input.attemptId,
            executionKey: input.executionKey,
          },
          status: "error",
          output: "",
          error: "worker_result_missing",
          retryable: true,
        }),
      };
    }
    return {
      workerId: "worker:" + input.taskId,
      executionIdentity: "execution:" + input.executionKey,
      processStartId: "start:" + process.pid,
      processGroupId: "group:" + process.pid,
      launchedAt: new Date().toISOString(),
      completion: Promise.resolve({
        kind: "worker",
        binding: {
          workflowId: input.workflowId,
          taskId: input.taskId,
          attemptId: input.attemptId,
          executionKey: input.executionKey,
        },
        status: "completed",
        output: new TextDecoder().decode(canonicalJsonBytes({
          findings: ["payment boundary evidence is immutable"],
          kind: "default_prime_task_output_v1",
          schemaVersion: 1,
          summary: "Payment boundary proof published",
          taskId,
        })),
        error: null,
        retryable: false,
      }),
    };
  },
  prime: {
    recordEvidence: async () => ({
      boundary: "public_boundary",
      verification: "host_verified",
      evidenceKind: "process_restart",
      authorizesTerminalization: true,
    }),
    readCoordinatorStatus: async () => { throw new Error("auto_workflow_dag_status_not_used"); },
    recordTelemetry: async () => undefined,
    assertStageAcceptable: async () => undefined,
    acceptStage: async () => undefined,
    readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
  },
});

await authority.start();
if (mode === "recover" || mode === "retry-recover") {
  const audit = await authority.readAudit();
  const replay = await host.runtimeStore.replay({
    workflowId,
    fromSequence: 0,
    expectedStoreEpoch: epochRef.storeEpoch,
  });
  const closure = [...replay.events].reverse().find((event) => event.payload.kind === "workflow_progress_lease_closed");
  const completionWatermark =
    closure?.payload.kind !== "workflow_progress_lease_closed"
      ? null
      : {
          taskId: closure.payload.sourceOutcome.taskId,
          disposition: closure.payload.disposition,
          outcomeEventSequence: closure.payload.sourceOutcome.eventSequence,
          outcomeDigest: closure.payload.sourceOutcome.outcomeDigest,
        };
  const outcomeHistory = replay.events.flatMap((event) =>
    event.payload.kind === "workflow_child_outcome_committed"
      ? [{ attemptId: event.payload.attemptId, status: event.payload.outcome.outcome.status, attemptStatus: event.payload.outcome.attemptStatus }]
      : [],
  );
  const resultRef = audit.workerResults[0]?.resultEvidenceRef;
  const evidenceRoots = [
    join(host.runtimeStore.identity.rootDir, "artifacts", "evidence"),
    join(host.runtimeStore.identity.rootDir, "workflows", workflowId, "artifacts", "evidence"),
  ];
  const evidenceArtifacts = evidenceRoots.flatMap((evidenceRoot) => existsSync(evidenceRoot)
    ? readdirSync(evidenceRoot).filter((entry) => !entry.endsWith(".metadata.json")).map((entry) => {
        try {
          return { root: evidenceRoot, payload: parseCanonicalJsonBytes(new Uint8Array(readFileSync(join(evidenceRoot, entry)))) };
        } catch {
          return { root: evidenceRoot, entry };
      }
    })
    : []);
  const resultArtifact = evidenceArtifacts.find(
    (entry) => "payload" in entry && entry.payload?.kind === "default_prime_generated_task_output",
  )?.payload ?? (resultRef === undefined
    ? null
    : parseCanonicalJsonBytes(new Uint8Array(readFileSync(join(host.runtimeStore.identity.rootDir, resultRef.relativePath)))));
  writeFileSync(resultPath, canonicalJsonBytes({ mode, launches, audit, resultArtifact, completionWatermark, outcomeHistory }));
  await host.dispose();
  process.exit(0);
}
setInterval(() => undefined, 1_000);
`;
}

type ProcessMode = "setup" | "recover" | "retry-setup" | "retry-recover";

function spawnPhase(mode: ProcessMode, artifactRoot: string): ChildProcess {
	const child = spawn(
		process.execPath,
		["--import", "tsx/esm", "--input-type=module", "-e", childSource(), mode, artifactRoot],
		{ cwd: process.cwd(), env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
	);
	const error = { value: "" };
	child.stderr?.on("data", (chunk: Buffer) => (error.value += chunk.toString()));
	childErrors.set(child, error);
	children.add(child);
	return child;
}

async function waitForPath(child: ChildProcess, path: string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error(`auto workflow DAG child exited before ${path}: ${childErrors.get(child)?.value ?? ""}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(
	child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null)
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`auto workflow DAG child did not exit: ${childErrors.get(child)?.value ?? ""}`));
		}, 30_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0 && signal === null) {
				reject(new Error(`auto workflow DAG child exited ${code}: ${childErrors.get(child)?.value ?? ""}`));
				return;
			}
			resolve({ code, signal });
		});
	});
}

it("restarts an arbitrary dynamic task and preserves its approved evidence kind", async () => {
	if (process.platform === "win32") return;
	const artifactRoot = mkdtempSync(join(tmpdir(), "auto-workflow-dag-completion-process-"));
	temporaryRoots.push(artifactRoot);
	const setup = spawnPhase("setup", artifactRoot);
	await waitForPath(setup, join(artifactRoot, "fence.json"));
	expect(JSON.parse(readFileSync(join(artifactRoot, "fence.json"), "utf8"))).toMatchObject({
		terminalResultPublished: true,
	});
	setup.kill("SIGKILL");
	expect(await waitForExit(setup)).toEqual({ code: null, signal: "SIGKILL" });

	const recover = spawnPhase("recover", artifactRoot);
	expect(await waitForExit(recover)).toEqual({ code: 0, signal: null });
	const result = JSON.parse(readFileSync(join(artifactRoot, "result.json"), "utf8")) as {
		launches: number;
		audit: {
			readonly terminalTaskIds: readonly string[];
			readonly workerResults: readonly { readonly resultEvidenceRef: { readonly digest: string } }[];
		};
		readonly outcomeHistory: readonly {
			readonly attemptId: string;
			readonly status: string;
			readonly attemptStatus: string;
		}[];
		resultArtifact: {
			readonly kind: string;
			readonly taskId: string;
			readonly recipeCapability: string;
			readonly taskGraphSourceDigest: string;
			readonly evidenceKind: string;
			readonly evidencePolicy: {
				readonly kind: string;
				readonly maxBytes: number;
				readonly maxItems: number;
				readonly independent: boolean;
			};
			readonly inputRefs: readonly string[];
			readonly boundaryIds: readonly string[];
			readonly outputRefs: readonly string[];
			readonly budget: {
				readonly tokenLimit: number;
				readonly wallTimeLimitSeconds: number;
				readonly spendLimitMicrounits: number;
			};
			readonly recoveryPolicy: string;
			readonly authority: readonly string[];
		};
	};
	expect(result.launches).toBe(0);
	expect(result.audit.terminalTaskIds).toEqual(["collect-payment-proof"]);
	expect(result.resultArtifact).toMatchObject({
		kind: "default_prime_generated_task_output",
		taskId: "collect-payment-proof",
		recipeCapability: "dynamic_task_graph",
		taskGraphSourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
		evidenceKind: "boundary_observation",
		evidencePolicy: { kind: "boundary_observation", maxBytes: 4096, maxItems: 8, independent: true },
		inputRefs: ["payment-boundary"],
		boundaryIds: ["no-pre-authority-effects"],
		outputRefs: ["payment-proof"],
		budget: { tokenLimit: 1000, wallTimeLimitSeconds: 60, spendLimitMicrounits: 7 },
		recoveryPolicy: "block",
		authority: ["read_workspace"],
	});
}, 90_000);

it("retries an arbitrary dynamic task and preserves its completion watermark across restart", async () => {
	if (process.platform === "win32") return;
	const artifactRoot = mkdtempSync(join(tmpdir(), "auto-workflow-dag-retry-process-"));
	temporaryRoots.push(artifactRoot);
	const setup = spawnPhase("retry-setup", artifactRoot);
	await waitForPath(setup, join(artifactRoot, "fence.json"));
	expect(JSON.parse(readFileSync(join(artifactRoot, "fence.json"), "utf8"))).toMatchObject({
		terminalResultPublished: true,
		kind: "default_prime_generated_task_output",
	});
	setup.kill("SIGKILL");
	expect(await waitForExit(setup)).toEqual({ code: null, signal: "SIGKILL" });

	const recover = spawnPhase("retry-recover", artifactRoot);
	expect(await waitForExit(recover)).toEqual({ code: 0, signal: null });
	const result = JSON.parse(readFileSync(join(artifactRoot, "result.json"), "utf8")) as {
		launches: number;
		audit: {
			readonly terminalTaskIds: readonly string[];
			readonly workerResults: readonly { readonly resultEvidenceRef: { readonly digest: string } }[];
		};
		readonly outcomeHistory: readonly {
			readonly attemptId: string;
			readonly status: string;
			readonly attemptStatus: string;
		}[];
		readonly completionWatermark: {
			readonly taskId: string;
			readonly disposition: string;
			readonly outcomeEventSequence: number;
			readonly outcomeDigest: string;
		} | null;
	};
	expect(result.launches).toBe(0);
	expect(result.audit.terminalTaskIds).toEqual(["collect-payment-proof"]);
	expect(result.audit.workerResults).toHaveLength(1);
	expect(result.outcomeHistory.map((outcome) => outcome.status)).toEqual(["failed", "complete"]);
	expect(result.outcomeHistory.map((outcome) => outcome.attemptStatus)).toEqual(["failed", "completed"]);
	expect(result.completionWatermark).toMatchObject({
		taskId: "collect-payment-proof",
		disposition: "terminal",
		outcomeEventSequence: expect.any(Number),
		outcomeDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
	});
}, 90_000);
