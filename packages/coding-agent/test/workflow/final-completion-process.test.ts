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

	return `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { emptyGoalState } from ${JSON.stringify(goalsModule)};
import { canonicalJsonBytes, digestObject, parseCanonicalJsonBytes } from ${JSON.stringify(contractsModule)};
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(hostModule)};
import { createDefaultTaskRuntimeAuthority } from ${JSON.stringify(runtimeModule)};

const mode = process.argv[1];
const artifactRoot = process.argv[2];
if ((mode !== "setup" && mode !== "recover") || artifactRoot === undefined)
  throw new Error("Usage: final-completion-process <setup|recover> <artifact-root>");

const workflowId = "final-completion-process-workflow";
const rootSessionId = "final-completion-process-session";
const writerIdentity = "final-completion-process-writer";
const runtimeVersion = "0.147.0-alpha.10";
const genesisEpoch = { storeEpoch: 1, coordinatorEpoch: 1 };
const goalPath = join(artifactRoot, "goal.json");
const fencePath = join(artifactRoot, "fence.json");
const resultPath = join(artifactRoot, "result.json");
const goalRevisionDigest = digestObject({ workflowId, objective: "persist one final valid task result" });

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
    taskId: "recon",
    planRevision: 1,
    objective: "persist one final valid task result",
    requirementIds: [],
    completionCriteria: ["the host accepts the final result"],
    dependencyTaskIds: [],
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
      wallMilliseconds: 300_000,
      monetaryMicrounits: 0,
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
    byId: new Map([[task.taskId, task]]),
    allowedAuthority: ["read_workspace"],
    ownershipPaths: [],
    generatedOutputPaths: [],
    lockPaths: [],
    namedContracts: [],
    graphDigest: digestObject(task),
  };
}

function primeAdapter() {
  return {
    recordEvidence: async () => ({
      boundary: "public_boundary",
      verification: "host_verified",
      evidenceKind: "process_restart",
      authorizesTerminalization: true,
    }),
    readCoordinatorStatus: async () => {
      throw new Error("final_completion_process_status_not_used");
    },
    recordTelemetry: async () => undefined,
    assertStageAcceptable: async () => undefined,
    acceptStage: async () => undefined,
    readAudit: async () => ({ terminalTaskIds: [], launchEvidenceRefs: [], workerResults: [] }),
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
  if (mode !== "setup") return host;
  const pending = await host.execute({
    kind: "start",
    request: {
      workflowId,
      objective: "persist one final valid task result",
      requestedProfile: "parallel",
      maxWorkers: 1,
      acceptanceChecks: ["final-result"],
      protectedInvariants: ["no-stimulus-progress"],
    },
  });
  if (pending.status !== "awaiting_user" || pending.approvalRequest === null)
    throw new Error("final_completion_process_approval_missing");
  const option = pending.approvalRequest.options.find((candidate) => deliveredProofs[candidate.optionId] !== undefined);
  if (option === undefined) throw new Error("final_completion_process_approval_proof_missing");
  const active = await host.execute({
    kind: "respond",
    approvalRequestId: pending.approvalRequest.approvalRequestId,
    optionId: option.optionId,
    proof: deliveredProofs[option.optionId],
  });
  if (active.status !== "active") throw new Error("final_completion_process_workflow_not_active");
  return host;
}

function decisionRef(status, epochRef) {
  const decision = status.decisionRefs.at(-1);
  if (decision === undefined) throw new Error("final_completion_process_decision_missing");
  return { ...decision, storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch };
}

function completionFor(input) {
  return {
    kind: "worker",
    binding: {
      workflowId,
      taskId: input.taskId,
      attemptId: input.attemptId,
      executionKey: input.executionKey,
    },
    status: "completed",
    output: "final valid task result",
    error: null,
    retryable: false,
  };
}

async function writeRecoveryResult(host, authority, launches) {
  const durable = host.runtimeStore.durableContext;
  if (durable === undefined) throw new Error("final_completion_process_durable_context_missing");
  const replay = await host.runtimeStore.replay({
    workflowId,
    fromSequence: 0,
    expectedStoreEpoch: durable.epochRef.storeEpoch,
  });
  const audit = await authority.readAudit();
  const status = await authority.readStatus();
  const outcomeEvents = replay.events.filter((event) => event.payload.kind === "workflow_child_outcome_committed");
  const releaseEvents = replay.events.filter((event) => event.payload.kind === "workflow_lease_release_recorded");
  const progressAcquired = replay.events.filter((event) => event.payload.kind === "workflow_progress_lease_acquired");
  const progressClosed = replay.events.filter((event) => event.payload.kind === "workflow_progress_lease_closed");
  const outcome = outcomeEvents.at(-1);
  const closure = progressClosed.at(-1);
  writeFileSync(
    resultPath,
    canonicalJsonBytes({
      mode,
      launches,
      status: status.status,
      terminalTaskIds: audit.terminalTaskIds,
      activeAttemptIds: audit.scheduler.activeAttemptIds,
      childOutcomeCount: outcomeEvents.length,
      leaseReleaseCount: releaseEvents.length,
      progressAcquireCount: progressAcquired.length,
      progressCloseCount: progressClosed.length,
      stageCompletionWatermark:
        closure?.payload.kind !== "workflow_progress_lease_closed"
          ? null
          : {
              stageId: closure.payload.sourceOutcome.taskId,
              disposition: closure.payload.disposition,
              outcomeEventSequence: closure.payload.sourceOutcome.eventSequence,
              outcomeDigest: closure.payload.sourceOutcome.outcomeDigest,
            },
      finalOutcome:
        outcome?.payload.kind !== "workflow_child_outcome_committed"
          ? null
          : {
              status: outcome.payload.outcome.outcome.status,
              taskId: outcome.payload.outcome.outcome.workflowId === workflowId ? "recon" : null,
            },
      heartbeatCount: replay.events.filter((event) => event.payload.kind === "workflow_task_lease_heartbeat").length,
      modelStimulusCount: replay.events.filter((event) => /model/u.test(event.payload.kind)).length,
      transcriptStimulusCount: replay.events.filter((event) => /transcript/u.test(event.payload.kind)).length,
    }),
  );
}

const host = await openHost();
const durable = host.runtimeStore.durableContext;
if (durable === undefined) throw new Error("final_completion_process_durable_context_missing");
const epochRef = { ...durable.epochRef };
const graph = taskGraph();
const status = host.status();
let launches = 0;
const authority = createDefaultTaskRuntimeAuthority({
  runtimeStore: mode === "setup" ? (() => {
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
          terminalPublicationSeen = true;
          const packet = parseCanonicalJsonBytes(input.bytes);
          writeFileSync(
            fencePath,
            canonicalJsonBytes({
              mode,
              terminalResultPublished: true,
              terminalResultStatus: packet.status,
              terminalResultOutput: packet.output,
            }),
          );
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
  decisionRef: decisionRef(status, epochRef),
  goalRevisionDigest,
  graph,
  maxWorkers: 1,
  now: () => new Date().toISOString(),
  workerLauncher: async (input) => {
    launches += 1;
    if (mode === "recover") throw new Error("final_completion_process_unexpected_relaunch");
    return {
      workerId: "worker:" + input.attemptId,
      executionIdentity: "execution:" + input.executionKey,
      processStartId: "start:" + process.pid,
      processGroupId: "group:" + process.pid,
      launchedAt: new Date().toISOString(),
      completion: Promise.resolve(completionFor(input)),
    };
  },
  prime: primeAdapter(),
});

await authority.start();
if (mode === "recover") {
  await writeRecoveryResult(host, authority, launches);
  await host.dispose();
  process.exit(0);
}
setInterval(() => undefined, 1_000);
`;
}

function spawnPhase(mode: "setup" | "recover", artifactRoot: string): ChildProcess {
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
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (existsSync(path)) return;
		if (child.exitCode !== null || child.signalCode !== null)
			throw new Error(`final completion child exited before ${path}: ${childErrors.get(child)?.value ?? ""}`);
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
	}
	throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(
	child: ChildProcess,
): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }> {
	if (child.exitCode !== null || child.signalCode !== null)
		return { code: child.exitCode, signal: child.signalCode as NodeJS.Signals | null };
	return new Promise((resolveExit, rejectExit) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectExit(new Error(`final completion child did not exit: ${childErrors.get(child)?.value ?? ""}`));
		}, 30_000);
		child.once("exit", (code, signal) => {
			clearTimeout(timeout);
			if (code !== 0 && signal === null) {
				rejectExit(new Error(`final completion child exited ${code}: ${childErrors.get(child)?.value ?? ""}`));
				return;
			}
			resolveExit({ code, signal });
		});
	});
}

function readResult(root: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(root, "result.json"), "utf8")) as Record<string, unknown>;
}

it("converges a final valid result after the exact process fence and one restart", async () => {
	if (process.platform === "win32") return;
	const artifactRoot = mkdtempSync(join(tmpdir(), "final-completion-process-"));
	temporaryRoots.push(artifactRoot);
	const setup = spawnPhase("setup", artifactRoot);
	await waitForPath(setup, join(artifactRoot, "fence.json"));
	const fence = JSON.parse(readFileSync(join(artifactRoot, "fence.json"), "utf8")) as Record<string, unknown>;
	expect(fence).toMatchObject({
		mode: "setup",
		terminalResultPublished: true,
		terminalResultStatus: "completed",
		terminalResultOutput: "final valid task result",
	});
	setup.kill("SIGKILL");
	expect(await waitForExit(setup)).toEqual({ code: null, signal: "SIGKILL" });

	const recover = spawnPhase("recover", artifactRoot);
	expect(await waitForExit(recover)).toEqual({ code: 0, signal: null });
	const result = readResult(artifactRoot);
	expect(result).toMatchObject({
		mode: "recover",
		launches: 0,
		status: "idle",
		terminalTaskIds: ["recon"],
		activeAttemptIds: [],
		childOutcomeCount: 1,
		leaseReleaseCount: 1,
		progressAcquireCount: 1,
		progressCloseCount: 1,
		heartbeatCount: 0,
		modelStimulusCount: 0,
		transcriptStimulusCount: 0,
		finalOutcome: { status: "complete", taskId: "recon" },
		stageCompletionWatermark: {
			stageId: "recon",
			disposition: "terminal",
		},
	});
	const watermark = result.stageCompletionWatermark as Record<string, unknown>;
	const finalOutcome = result.finalOutcome as Record<string, unknown>;
	expect(watermark.outcomeDigest).toBeTypeOf("string");
	expect(watermark.outcomeEventSequence).toBeTypeOf("number");
	expect(finalOutcome.taskId).toBe("recon");
}, 90_000);
