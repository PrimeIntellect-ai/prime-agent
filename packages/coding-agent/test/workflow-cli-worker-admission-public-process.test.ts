import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const tsxPath = resolve(__dirname, "../../../node_modules/tsx/dist/cli.mjs");
const childProcesses = new Set<ChildProcess>();
const temporaryRoots: string[] = [];

afterEach(() => {
	for (const child of childProcesses) {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	childProcesses.clear();
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function childSource(): string {
	const agentServicesModule = pathToFileURL(resolve(__dirname, "../src/core/agent-session-services.ts")).href;
	const authModule = pathToFileURL(resolve(__dirname, "../src/core/auth-storage.ts")).href;
	const goalsModule = pathToFileURL(resolve(__dirname, "../src/core/goals.ts")).href;
	const sessionManagerModule = pathToFileURL(resolve(__dirname, "../src/core/session-manager.ts")).href;
	const settingsModule = pathToFileURL(resolve(__dirname, "../src/core/settings-manager.ts")).href;
	const contractsModule = pathToFileURL(resolve(__dirname, "../src/core/workflow/contracts.ts")).href;
	const hostModule = pathToFileURL(resolve(__dirname, "../src/core/workflow/session-host-factory.ts")).href;
	const gateModule = pathToFileURL(resolve(__dirname, "../src/core/workflow/worker-model-capability-gate.ts")).href;
	const runtimeModule = pathToFileURL(resolve(__dirname, "../src/core/workflow/runtime-store-adapter.ts")).href;

	return `
import { createServer } from "node:http";
import { registerFauxProvider } from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createDefaultPrimeWorkflowWorkerLauncher,
} from ${JSON.stringify(agentServicesModule)};
import { AuthStorage } from ${JSON.stringify(authModule)};
import { emptyGoalState } from ${JSON.stringify(goalsModule)};
import { SessionManager } from ${JSON.stringify(sessionManagerModule)};
import { SettingsManager } from ${JSON.stringify(settingsModule)};
import { digestObject } from ${JSON.stringify(contractsModule)};
import { createPersistedSessionWorkflowHost } from ${JSON.stringify(hostModule)};
import {
  WORKER_MODEL_ID,
  WORKER_MODEL_PROVIDER,
  WORKER_MODEL_REASONING,
  WORKER_MODEL_SELECTOR,
} from ${JSON.stringify(gateModule)};
import { MIN_WORKFLOW_RUNTIME_VERSION } from ${JSON.stringify(runtimeModule)};

const root = process.env.WORKFLOW_ADMISSION_ROOT;
if (typeof root !== "string" || root.length === 0) throw new Error("worker_admission_root_missing");
const discoveryServer = createServer((request, response) => {
  if (request.url?.startsWith("/codex/models")) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ models: [{ slug: WORKER_MODEL_ID }, { slug: "gpt-5.6-sol" }] }));
    return;
  }
  response.statusCode = 404;
  response.end();
});
await new Promise((resolve, reject) => {
  discoveryServer.once("error", reject);
  discoveryServer.listen(0, "127.0.0.1", resolve);
});
const address = discoveryServer.address();
if (address === null || typeof address === "string") throw new Error("worker_discovery_server_address_missing");
const faux = registerFauxProvider({
  provider: WORKER_MODEL_PROVIDER,
  // Both admitted tiers, because admission enforces worker_model_not_in_catalog: a selector absent
  // from the catalog is refused before anything else, so a one-model fixture cannot reach the deep
  // tier at all.
  models: [
    { id: WORKER_MODEL_ID, name: "Faux Luna", reasoning: true },
    { id: "gpt-5.6-sol", name: "Faux Sol", reasoning: true },
  ],
});
const authStorage = AuthStorage.inMemory();
const workerCredential = "header." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "faux-account" } })).toString("base64url") + ".signature";
authStorage.setRuntimeApiKey(WORKER_MODEL_PROVIDER, workerCredential);
const sessionManager = SessionManager.create(root, root + "/sessions");
sessionManager.newSession();
let goalState = emptyGoalState();
let approvalDelivery;
let workflowHost;
const services = await createAgentSessionServices({
  cwd: root,
  agentDir: root,
  authStorage,
  settingsManager: SettingsManager.inMemory(),
  runtimeVersion: MIN_WORKFLOW_RUNTIME_VERSION,
  primeWorkflowWorkerModel: WORKER_MODEL_SELECTOR,
  approvalSecretDelivery: (delivery) => { approvalDelivery = delivery; },
  resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
  workflowHostFactory: async (input) => {
    workflowHost = await createPersistedSessionWorkflowHost({
      artifactRoot: input.artifactRoot,
      workflowId: input.workflowId,
      rootSessionId: input.rootSessionId,
      genesisEpoch: { storeEpoch: 1, coordinatorEpoch: 1 },
      workerModelCapabilityAvailability: input.workerModelCapabilityAvailability,
      approvalSecretDelivery: input.approvalSecretDelivery,
      goalProjection: {
        read: () => structuredClone(goalState),
        compareAndSwap: (expected, next) => {
          if (digestObject(expected) !== digestObject(goalState)) return false;
          goalState = structuredClone(next);
          return true;
        },
      },
    });
    workflowHost.recoverBeforeResume = async () => undefined;
    return workflowHost;
  },
});
services.modelRegistry.registerProvider(WORKER_MODEL_PROVIDER, {
  baseUrl: "http://127.0.0.1:" + address.port + "/codex/responses",
  apiKey: workerCredential,
  api: faux.api,
  models: faux.models.map((model) => ({ ...model, baseUrl: undefined })),
});
const created = await createAgentSessionFromServices({
  services,
  sessionManager,
  model: faux.getModel(),
  prewarmIpythonKernel: false,
});
if (workflowHost === undefined) throw new Error("worker_admission_host_missing");
const host = workflowHost;
const started = await host.execute({
  kind: "start",
  request: {
    workflowId: sessionManager.getSessionId(),
    objective: "admit one exact worker",
    acceptanceChecks: ["worker-admitted"],
    protectedInvariants: ["no-fallback"],
  },
});
if (started.approvalRequest === null || approvalDelivery === undefined)
  throw new Error("worker_admission_approval_missing");
const approve = started.approvalRequest.options.find((option) => option.optionId === "approve");
if (approve === undefined) throw new Error("worker_admission_approve_option_missing");
const active = await host.execute({
  kind: "respond",
  approvalRequestId: started.approvalRequest.approvalRequestId,
  optionId: approve.optionId,
  proof: approvalDelivery.proof,
});
if (active.status !== "active" || host.admitWorkerModel === undefined)
  throw new Error("worker_admission_host_not_active");
const epochRef = { storeEpoch: 1, coordinatorEpoch: 1 };
const admission = await host.admitWorkerModel({
  workflowId: sessionManager.getSessionId(),
  taskId: "task-recon",
  attemptId: "attempt-recon",
  executionKey: "execution-recon",
  epochRef,
  prompt: "perform bounded recon",
  sessionName: "recon-worker",
  selector: WORKER_MODEL_SELECTOR,
  provider: WORKER_MODEL_PROVIDER,
  model: WORKER_MODEL_ID,
  reasoning: WORKER_MODEL_REASONING,
  allowFallback: false,
});
const handshake = await admission.handshake(admission.intent.childModel);
const durable = host.runtimeStore.durableContext;
if (durable === undefined) throw new Error("worker_admission_durable_context_missing");
const persisted = await durable.auxiliaryStore.read("worker-model-capability-gate.json");
let sessionLaunchBinding;
const sessionInternals = created.session as unknown as {
  _startRlmChildRun: (...args: unknown[]) => Promise<{ rlm_child_id: string; name: string; session_dir: string; model: string }>;
};
const originalStart = sessionInternals._startRlmChildRun;
const launchArgs = [];
sessionInternals._startRlmChildRun = async (...args) => {
  // Keep the first launch's binding: a later launch must not overwrite what this asserts.
  sessionLaunchBinding = sessionLaunchBinding ?? args[7];
  launchArgs.push({ selector: args[1]?.model, thinkingLevel: args[4], ownedPaths: args[9] });
  // Echo the requested selector: runWorkflowRlmChild rejects a handle whose model differs.
  return { rlm_child_id: "session-launch-child", name: "session-launch-worker", session_dir: root, model: args[1]?.model };
};
await created.session.runWorkflowRlmChild("session launch", "session-launch-worker", WORKER_MODEL_SELECTOR, {
  workflowId: sessionManager.getSessionId(),
  taskId: "task-session-launch",
  attemptId: "attempt-session-launch",
  executionKey: "execution-session-launch",
  epochRef,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  capsuleDigest: "session-capsule-digest",
});
// The deep tier is the launch my changes actually alter: a non-default selector has to pass the
// admission binding comparison and spawn at its own reasoning level, and nothing exercised that end
// to end before.
await created.session.runWorkflowRlmChild("deep launch", "deep-worker", WORKER_MODEL_PROVIDER + "/gpt-5.6-sol", {
  workflowId: sessionManager.getSessionId(),
  taskId: "task-deep-launch",
  attemptId: "attempt-deep-launch",
  executionKey: "execution-deep-launch",
  epochRef,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  capsuleDigest: "deep-capsule-digest",
}, undefined, undefined, ["src/model"]);
sessionInternals._startRlmChildRun = originalStart;
await host.execute({ kind: "pause", reason: "force stale handshake" });
const staleHandshake = await admission.handshake(admission.intent.childModel);
let rawDenied = "";
try {
  await created.session.runWorkflowRlmChild("raw worker", "raw-worker", WORKER_MODEL_SELECTOR);
} catch (error) {
  rawDenied = error instanceof Error ? error.message : String(error);
}
const launcherCalls = [];
const fakeSession = {
  runWorkflowRlmChild: async (...args) => {
    launcherCalls.push(args);
    return { rlm_child_id: "launcher-child", name: "recon-worker", session_dir: root, model: WORKER_MODEL_SELECTOR };
  },
  awaitRlmChildCompletion: async () => ({ status: "completed", output: "done", error: null, retryable: false }),
  cancelRlmChildRun: () => true,
};
const launcher = createDefaultPrimeWorkflowWorkerLauncher({ session: fakeSession, workerModel: WORKER_MODEL_SELECTOR });
await launcher({
  workflowId: sessionManager.getSessionId(), taskId: "task-recon", attemptId: "attempt-recon", executionKey: "execution-recon",
  epochRef, deadlineAt: new Date(Date.now() + 60_000).toISOString(), prompt: "perform bounded recon",
  taskCapsule: { capsuleDigest: "scheduler-capsule-digest" }, sessionName: "recon-worker", reportHeartbeat: async () => undefined,
});
let missingCapsule = "";
try {
  await launcher({
    workflowId: sessionManager.getSessionId(), taskId: "task-recon", attemptId: "attempt-recon", executionKey: "execution-recon",
    epochRef, deadlineAt: new Date(Date.now() + 60_000).toISOString(), prompt: "missing capsule", sessionName: "recon-worker", reportHeartbeat: async () => undefined,
  });
} catch (error) {
  missingCapsule = error instanceof Error ? error.message : String(error);
}
await created.session.disposeAsync();
faux.unregister();
await new Promise((resolve, reject) => discoveryServer.close((error) => (error ? reject(error) : resolve())));
console.log(JSON.stringify({
  activeStatus: active.status,
  handshake,
  admissionBinding: {
    attemptId: admission.intent.attemptId,
    executionKey: admission.intent.executionKey,
    epochRef: admission.intent.epochRef,
  },
  persistedBeforeSpawn: persisted !== null,
  sessionLaunchBinding,
  staleHandshakeStatus: staleHandshake.status,
  rawDenied,
  launcherContext: launcherCalls[0]?.[3],
  missingCapsule,
  launchArgs,
}));
`;
}

function runChild(root: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolveChild, rejectChild) => {
		const child = spawn(process.execPath, [tsxPath, "-"], {
			env: {
				...process.env,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				WORKFLOW_ADMISSION_ROOT: root,
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		childProcesses.add(child);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
			rejectChild(new Error(`Timed out waiting for worker admission child: ${stderr}`));
		}, 60_000);
		child.once("error", (error) => {
			clearTimeout(timeout);
			rejectChild(error);
		});
		child.once("exit", (code) => {
			clearTimeout(timeout);
			resolveChild({ code, stdout, stderr });
		});
		child.stdin.end(childSource());
	});
}

it("composes persisted allowlisted admission through the CLI service process boundary", async () => {
	const root = mkdtempSync(join(tmpdir(), "workflow-cli-worker-admission-"));
	temporaryRoots.push(root);
	const result = await runChild(root);
	if (result.code !== 0) throw new Error(`worker admission child failed: ${result.stderr}\n${result.stdout}`);
	const output = result.stdout.trim().split("\n").at(-1);
	if (output === undefined) throw new Error("worker admission child produced no result");
	const evidence = JSON.parse(output) as {
		activeStatus: string;
		handshake: { status: string; admissionDigest?: string };
		admissionBinding: {
			attemptId?: string;
			executionKey?: string;
			epochRef: { storeEpoch: number; coordinatorEpoch: number };
		};
		persistedBeforeSpawn: boolean;
		sessionLaunchBinding: {
			workflowId: string;
			taskId: string;
			attemptId: string;
			executionKey: string;
			epochRef: { storeEpoch: number; coordinatorEpoch: number };
			capsuleDigest: string;
		};
		staleHandshakeStatus: string;
		rawDenied: string;
		launcherContext: { capsuleDigest?: string };
		missingCapsule: string;
		launchArgs: Array<{ selector?: string; thinkingLevel?: string; ownedPaths?: readonly string[] }>;
	};
	// Two launches went through the real admission path: the default selector and the deep tier. The
	// deep one is what these changes altered - the binding comparison now checks the requested
	// selector rather than the default constant, and the spawn takes that model's own reasoning level
	// instead of a hardcoded "max". Nothing exercised a non-default selector end to end before.
	expect(evidence.launchArgs).toEqual([
		{ selector: "openai-codex/gpt-5.6-luna", thinkingLevel: "max", ownedPaths: undefined },
		{ selector: "openai-codex/gpt-5.6-sol", thinkingLevel: "high", ownedPaths: ["src/model"] },
	]);
	expect(evidence).toMatchObject({
		activeStatus: "active",
		handshake: { status: "accepted" },
		admissionBinding: {
			attemptId: "attempt-recon",
			executionKey: "execution-recon",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
		},
		persistedBeforeSpawn: true,
		sessionLaunchBinding: {
			workflowId: expect.any(String),
			taskId: "task-session-launch",
			attemptId: "attempt-session-launch",
			executionKey: "execution-session-launch",
			epochRef: { storeEpoch: 1, coordinatorEpoch: 1 },
			capsuleDigest: "session-capsule-digest",
		},
		staleHandshakeStatus: "terminate_quarantine",
		rawDenied: "CONTRACT_CHANGE: workflow worker launch context is required for model admission",
		launcherContext: { capsuleDigest: "scheduler-capsule-digest" },
		missingCapsule: "workflow_worker_task_capsule_required",
	});
}, 60_000);
