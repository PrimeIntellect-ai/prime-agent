import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";

import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import {
	canonicalJsonBytes,
	sha256Hex,
	type DurableApprovalSecretProof,
} from "../../src/core/workflow/contracts.js";
import {
	normalizeWorkflowTaskGraphSource,
	workflowTaskGraphSourceBindingDigest,
} from "../../src/core/workflow/brainstorm.js";
import { createDefaultPrimeWorkflowProvider } from "../../src/core/workflow/default-prime.js";
import type { WorkflowGoalContractRequest } from "../../src/core/workflow/shell.js";

const cleanup: string[] = [];
const unregister: Array<() => void> = [];

const DEFAULT_PRIME_OBJECTIVE = "exercise default Prime composition";
const DEFAULT_PRIME_ACCEPTANCE_CHECKS = ["default-prime-composes"] as const;
const DEFAULT_PRIME_PROTECTED_INVARIANTS = ["preserve-host-authority"] as const;
const DEFAULT_PRIME_SUCCESS_METRICS = [
	{
		metricId: "default-prime-integration",
		requirementId: "default-prime-composes",
		direction: "at_least" as const,
		target: 1,
		tolerance: 0,
		measurement: "public_integration" as const,
		guardIds: ["preserve-host-authority"],
	},
] as const;
const DEFAULT_PRIME_NON_GOALS = ["test-count-is-not-completion"] as const;
const DEFAULT_PRIME_BUDGETS = {
	tokenLimit: 100_000,
	wallTimeLimitSeconds: 3_600,
	spendLimitMicrounits: 0,
} as const;
const DEFAULT_PRIME_TASK_BUDGETS = {
	tokenLimit: 0,
	wallTimeLimitSeconds: 3_600,
	spendLimitMicrounits: 0,
} as const;

async function installBuiltInTaskGraphSource(artifactRoot: string): Promise<WorkflowGoalContractRequest> {
	const taskIds = [
		"recon",
		"lens",
		"verify",
		"synthesize",
		"red-team",
		"attack",
		"architect",
		"judge",
		"unify",
		"edge-test",
	] as const;
	const binding = {
		prompt: DEFAULT_PRIME_OBJECTIVE,
		objective: DEFAULT_PRIME_OBJECTIVE,
		boundaryIds: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
		gateIds: [...DEFAULT_PRIME_ACCEPTANCE_CHECKS],
		acceptanceChecks: [...DEFAULT_PRIME_ACCEPTANCE_CHECKS],
		protectedInvariants: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
		successMetrics: DEFAULT_PRIME_SUCCESS_METRICS,
		nonGoalIds: [...DEFAULT_PRIME_NON_GOALS],
		budgets: DEFAULT_PRIME_BUDGETS,
	} as const;
	const taskGraphSource = normalizeWorkflowTaskGraphSource(
		{
			schemaVersion: 1,
			graphRevision: 1,
			recipeCapability: "builtin_adaptive_prime",
			tasks: taskIds.map((taskId, index) => ({
				taskId,
				objective: `Run the built-in ${taskId} stage for the approved Prime objective`,
				requirementIds: [...DEFAULT_PRIME_ACCEPTANCE_CHECKS],
				completionCriteria: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
				dependencyTaskIds: index === 0 ? [] : [taskIds[index - 1]],
				boundaryIds: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
				inputRefs: index === 0 ? [] : [`${taskIds[index - 1]}-result`],
				outputRefs: [`${taskId}-result`],
				evidencePolicy: {
					kind: `${taskId}-evidence`,
					maxBytes: 8_192,
					maxItems: 16,
					independent: true,
				},
				budget: { ...DEFAULT_PRIME_TASK_BUDGETS },
				recovery: "replan",
				authority: ["read_workspace"],
			})),
		},
		binding,
	);
	const document = {
		schemaVersion: 1,
		draftId: "default-prime-built-in",
		prompt: DEFAULT_PRIME_OBJECTIVE,
		objective: DEFAULT_PRIME_OBJECTIVE,
		boundaryIds: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
		gateIds: [...DEFAULT_PRIME_ACCEPTANCE_CHECKS],
		acceptanceChecks: [...DEFAULT_PRIME_ACCEPTANCE_CHECKS],
		protectedInvariants: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
		successMetrics: DEFAULT_PRIME_SUCCESS_METRICS.map((metric) => ({ ...metric })),
		nonGoalIds: [...DEFAULT_PRIME_NON_GOALS],
		budgets: { ...DEFAULT_PRIME_BUDGETS },
		taskGraphSource,
		taskGraphDigest: taskGraphSource.graphDigest,
		taskGraphBindingDigest: workflowTaskGraphSourceBindingDigest(binding),
	};
	const bytes = canonicalJsonBytes(document);
	const objectDigest = sha256Hex(bytes);
	const sourceDirectory = `${artifactRoot}/workflow-goal-sources`;
	await mkdir(sourceDirectory, { recursive: true });
	await writeFile(`${sourceDirectory}/sha256=${objectDigest}.json`, bytes);
	return {
		authoritativeSource: {
			kind: "immutable_object",
			uri: `session-artifact://workflow-goal-sources/sha256=${objectDigest}.json`,
			objectGeneration: "1",
			objectDigest,
			objectSizeBytes: bytes.byteLength,
			parsedObjective: DEFAULT_PRIME_OBJECTIVE,
			boundaryIds: [...DEFAULT_PRIME_PROTECTED_INVARIANTS],
			gateIds: [...DEFAULT_PRIME_ACCEPTANCE_CHECKS],
		},
		successMetrics: DEFAULT_PRIME_SUCCESS_METRICS.map((metric) => ({ ...metric, guardIds: [...metric.guardIds] })),
		nonGoalIds: [...DEFAULT_PRIME_NON_GOALS],
		budgets: { ...DEFAULT_PRIME_BUDGETS },
	};
}

async function readWorkflowPipelineState(session: object): Promise<{
	readonly completedStageIds: readonly string[];
	readonly readyStageIds: readonly string[];
	readonly stateDigest: string;
}> {
	const readState = Reflect.get(session, "getWorkflowPipelineState");
	expect(typeof readState).toBe("function");
	return Reflect.apply(readState as (...args: never[]) => Promise<unknown>, session, []) as Promise<{
		readonly completedStageIds: readonly string[];
		readonly readyStageIds: readonly string[];
		readonly stateDigest: string;
	}>;
}

async function readWorkflowAdaptiveState(session: object): Promise<{
	readonly graphDigest: string;
	readonly completedStageIds: readonly string[];
	readonly criticalPathStageIds: readonly string[];
	readonly reviewCount: number;
	readonly periodicReviewCount: number;
	readonly recommendedRecipeId: string;
	readonly recommendedParallelism: number;
	readonly canAuthorize: false;
	readonly stateDigest: string;
}> {
	const readState = Reflect.get(session, "getWorkflowAdaptiveState");
	expect(typeof readState).toBe("function");
	return Reflect.apply(readState as (...args: never[]) => Promise<unknown>, session, []) as Promise<{
		readonly graphDigest: string;
		readonly completedStageIds: readonly string[];
		readonly criticalPathStageIds: readonly string[];
		readonly reviewCount: number;
		readonly periodicReviewCount: number;
		readonly recommendedRecipeId: string;
		readonly recommendedParallelism: number;
		readonly canAuthorize: false;
		readonly stateDigest: string;
	}>;
}

async function readWorkflowExecutionEvidenceState(session: object): Promise<{
	readonly observationCount: number;
	readonly latestObservationDigest: string | null;
	readonly observationRefs: readonly {
		readonly artifactId: string;
		readonly relativePath: string;
		readonly digest: string;
		readonly sizeBytes: number;
		readonly sourceEventSequence: number;
	}[];
	readonly stateDigest: string;
}> {
	const readState = Reflect.get(session, "getWorkflowExecutionEvidenceState");
	expect(typeof readState).toBe("function");
	return Reflect.apply(readState as (...args: never[]) => Promise<unknown>, session, []) as Promise<{
		readonly observationCount: number;
		readonly latestObservationDigest: string | null;
		readonly observationRefs: readonly {
			readonly artifactId: string;
			readonly relativePath: string;
			readonly digest: string;
			readonly sizeBytes: number;
			readonly sourceEventSequence: number;
		}[];
		readonly stateDigest: string;
	}>;
}

async function readGenerationJournal(root: string): Promise<string> {
	const entries = await readdir(root, { withFileTypes: true });
	const contents: string[] = [];
	for (const entry of entries) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			contents.push(await readGenerationJournal(path));
			continue;
		}
		if (entry.name === "events.log") contents.push(await readFile(path, "utf8"));
	}
	return contents.join("\n");
}

function generationJournalContainsPayloadKind(journal: string, kind: string): boolean {
	return journal.includes([...Buffer.from(`"kind":"${kind}"`, "utf8")].join(","));
}

afterEach(async () => {
	while (unregister.length > 0) unregister.pop()?.();
	while (cleanup.length > 0) {
		const path = cleanup.pop();
		if (path !== undefined) await rm(path, { recursive: true, force: true });
	}
});

it("refuses to start the default workflow without an explicit causal goal contract", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "default-prime-goal-contract-"));
	cleanup.push(cwd);
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	const services = await createAgentSessionServices({
		cwd,
		agentDir: cwd,
		settingsManager: SettingsManager.inMemory(),
		goalAuthoritySourceResolver: {
			resolve: async () => ({
				objectGeneration: "1",
				bytes: new TextEncoder().encode("default prime goal"),
				parsedObjective: "exercise default Prime composition",
				boundaryIds: ["preserve-host-authority"],
				gateIds: ["default-prime-composes"],
			}),
		},
		resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
	});
	const created = await createAgentSessionFromServices({ services, sessionManager });
	try {
		const before = await created.session.executeWorkflowCommand({ kind: "status" });
		await expect(
			created.session.executeWorkflowCommand({
				kind: "start",
				request: {
					workflowId: sessionManager.getSessionId(),
					objective: "start without a causal contract",
					acceptanceChecks: ["default-prime-composes"],
					protectedInvariants: ["preserve-host-authority"],
				},
			}),
		).rejects.toThrow(/goal contract.*required/i);
		await expect(created.session.executeWorkflowCommand({ kind: "status" })).resolves.toEqual(before);
	} finally {
		await created.session.disposeAsync();
	}
});

it("binds the default production Prime provider through AgentSession workflow start", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "default-prime-agent-session-"));
	cleanup.push(cwd);
	const faux = registerFauxProvider();
	unregister.push(() => faux.unregister());
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	const sessionArtifactDir = sessionManager.getSessionArtifactDir();
	if (sessionArtifactDir === undefined) throw new Error("default_prime_session_artifact_dir_missing");
	const goalContract = await installBuiltInTaskGraphSource(sessionArtifactDir);
	let approvalProofs: Readonly<Record<string, DurableApprovalSecretProof>> | undefined;
	const completeWorker = new Map<string, () => void>();
	const launchWorker = vi.fn(
		async (input: {
			readonly workflowId: string;
			readonly taskId: string;
			readonly attemptId: string;
			readonly executionKey: string;
		}) => {
			const journalBeforeLaunch = await readGenerationJournal(
				join(sessionArtifactDir, "workflows", sessionManager.getSessionId(), "generations"),
			);
			expect(generationJournalContainsPayloadKind(journalBeforeLaunch, "workflow_dispatch_intent")).toBe(true);
			const completion = new Promise<{
				readonly kind: "worker";
				readonly binding: {
					readonly workflowId: string;
					readonly taskId: string;
					readonly attemptId: string;
					readonly executionKey: string;
				};
				readonly status: "completed";
				readonly output: string;
				readonly error: null;
				readonly retryable: false;
			}>((resolve) => {
				completeWorker.set(input.taskId, () =>
					resolve({
						kind: "worker",
						binding: {
							workflowId: input.workflowId,
							taskId: input.taskId,
							attemptId: input.attemptId,
							executionKey: input.executionKey,
						},
						status: "completed",
						output: JSON.stringify({
							findings: [`completed ${input.taskId}`],
							kind: "default_prime_task_output_v1",
							schemaVersion: 1,
							summary: `completed ${input.taskId}`,
							taskId: input.taskId,
						}),
						error: null,
						retryable: false,
					}),
				);
			});
			return {
				workerId: `worker:${input.taskId}`,
				executionIdentity: `rlm:worker:${input.taskId}:${input.executionKey}`,
				processStartId: `process-start:${input.executionKey}`,
				processGroupId: `process-group:${input.executionKey}`,
				launchedAt: new Date().toISOString(),
				completion,
			};
		},
	);
	const services = await createAgentSessionServices({
		cwd,
		agentDir: cwd,
		authStorage,
		settingsManager: SettingsManager.inMemory(),
		goalAuthoritySourceResolver: {
			resolve: async () => ({
				objectGeneration: "1",
				bytes: new TextEncoder().encode("default prime goal"),
				parsedObjective: "exercise default Prime composition",
				boundaryIds: ["preserve-host-authority"],
				gateIds: ["default-prime-composes"],
			}),
		},
		resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		// The test exercises the same host-issued proof boundary used by the public UI.
		approvalSecretDelivery: ({ proofs }) => {
			approvalProofs = proofs;
		},
		primeWorkflowWorkerLauncher: launchWorker,
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: faux.getModel(),
	});
	try {
		expect(typeof createDefaultPrimeWorkflowProvider).toBe("function");
		const status = await created.session.executeWorkflowCommand({
			kind: "start",
			request: {
				workflowId: sessionManager.getSessionId(),
				objective: "exercise default Prime composition",
				requestedProfile: "parallel",
				maxWorkers: 1,
				acceptanceChecks: ["default-prime-composes"],
				protectedInvariants: ["preserve-host-authority"],
				goalContract,
			},
		});
		expect(status.status).toBe("awaiting_user");
		expect(status.approvalRequest?.question).toContain("cloud compute");
		if (status.approvalRequest === null || approvalProofs?.approve_cloud === undefined)
			throw new Error("default_prime_approval_proof_missing");
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ipython", { code: "1 + 1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Observed the local execution result."),
			fauxAssistantMessage("", { stopReason: "aborted" }),
		]);
		const active = await created.session.executeWorkflowCommand({
			kind: "respond",
			approvalRequestId: status.approvalRequest.approvalRequestId,
			optionId: "approve_cloud",
			proof: approvalProofs.approve_cloud,
		});
		expect(active.status).toBe("active");
		expect(launchWorker).toHaveBeenCalledTimes(1);
		const recipeDigest = await created.session.getWorkflowPrimeRecipeDigest();
		expect(recipeDigest).toMatch(/^[0-9a-f]{64}$/u);
		const taskGraphDigest = await created.session.getWorkflowPrimeTaskGraphDigest();
		expect(taskGraphDigest).toMatch(/^[0-9a-f]{64}$/u);
		await expect(readWorkflowAdaptiveState(created.session)).resolves.toMatchObject({
			graphDigest: taskGraphDigest,
			completedStageIds: [],
			criticalPathStageIds: [
				"recon",
				"lens",
				"verify",
				"synthesize",
				"red-team",
				"attack",
				"architect",
				"judge",
				"unify",
				"edge-test",
			],
			reviewCount: 0,
			periodicReviewCount: 0,
			recommendedRecipeId: "builtin:recon-lens-verify-synthesize-red-team-attack-architect-judge-unify-edge-test",
			recommendedParallelism: 1,
			canAuthorize: false,
		});
		await created.session.promptAndWait("Capture the initial public execution observation.");
		await created.session.abort();
		await created.session.waitForIdle();
		const postPlannerStatus = await created.session.executeWorkflowCommand({ kind: "status" });
		expect(postPlannerStatus.status, postPlannerStatus.goal.lastReason ?? undefined).toBe("active");
		const executionEvidenceBeforePipeline = await readWorkflowExecutionEvidenceState(created.session);
		expect(executionEvidenceBeforePipeline.observationCount).toBeGreaterThanOrEqual(2);
		expect(executionEvidenceBeforePipeline.latestObservationDigest).toMatch(/^[0-9a-f]{64}$/u);
		expect(executionEvidenceBeforePipeline.observationRefs.every((ref) => /^[0-9a-f]{64}$/u.test(ref.digest))).toBe(
			true,
		);
		const publicExecutionEvidence = await created.session.executeWorkflowHostRequest(
			"workflow.v1.execution_evidence.read",
			{},
		);
		expect(publicExecutionEvidence).toMatchObject({
			can_authorize: false,
		});
		expect(publicExecutionEvidence.observation_count).toBeGreaterThanOrEqual(
			executionEvidenceBeforePipeline.observationCount,
		);
		expect(publicExecutionEvidence.state_digest).toMatch(/^[0-9a-f]{64}$/u);
		await expect(
			created.session.executeWorkflowHostRequest("workflow.v1.execution_evidence.read", {}),
		).resolves.toMatchObject({ state_digest: expect.stringMatching(/^[0-9a-f]{64}$/u), can_authorize: false });

		const autoresearchResult = await created.session.executeWorkflowSkill({ skillName: "workflow-autoresearch" });
		expect(autoresearchResult.skill_id).toBe("autoresearch");
		expect(Array.isArray(autoresearchResult.evidence_refs)).toBe(true);
		const sourceEvidenceRefs = autoresearchResult.evidence_refs;
		if (!Array.isArray(sourceEvidenceRefs) || sourceEvidenceRefs.length === 0)
			throw new Error("default_prime_autoresearch_evidence_missing");
		await expect(created.session.executeWorkflowHostRequest("workflow.v1.completion.request", {})).rejects.toThrow(
			/pipeline.*complete|completion.*not.ready/i,
		);
		expect((await created.session.executeWorkflowCommand({ kind: "status" })).status).toBe("active");
		await expect(
			created.session.executeWorkflowHostRequest("workflow.v1.pipeline.record", {
				stage_id: "verify",
				evidence_refs: sourceEvidenceRefs,
			}),
		).rejects.toThrow(/not_ready|stage_attempt_missing/);
		completeWorker.get("recon")?.();
		await vi.waitFor(() => expect(launchWorker).toHaveBeenCalledWith(expect.objectContaining({ taskId: "lens" })), {
			timeout: 120_000,
		});
		const recordedRecon = await created.session.executeWorkflowHostRequest("workflow.v1.pipeline.record", {
			stage_id: "recon",
			evidence_refs: sourceEvidenceRefs,
		});
		expect(recordedRecon).toMatchObject({
			completed_stage_ids: ["recon"],
			ready_stage_ids: ["lens"],
			can_authorize: false,
		});
		const journalAfterRecon = await readGenerationJournal(
			join(sessionArtifactDir, "workflows", sessionManager.getSessionId(), "generations"),
		);
		expect(generationJournalContainsPayloadKind(journalAfterRecon, "workflow_child_outcome_committed")).toBe(true);
		expect(generationJournalContainsPayloadKind(journalAfterRecon, "workflow_lease_release_recorded")).toBe(true);
		await expect(
			created.session.executeWorkflowHostRequest("workflow.v1.pipeline.record", {
				stage_id: "recon",
				evidence_refs: sourceEvidenceRefs,
			}),
		).rejects.toThrow(/not_ready|stage_attempt_missing/);
		const pipelineState = await readWorkflowPipelineState(created.session);
		const adaptiveState = await readWorkflowAdaptiveState(created.session);
		expect(pipelineState).toMatchObject({
			completedStageIds: ["recon"],
			readyStageIds: ["lens"],
		});
		expect(adaptiveState).toMatchObject({
			graphDigest: taskGraphDigest,
			completedStageIds: ["recon"],
			criticalPathStageIds: [
				"lens",
				"verify",
				"synthesize",
				"red-team",
				"attack",
				"architect",
				"judge",
				"unify",
				"edge-test",
			],
			reviewCount: 1,
			recommendedRecipeId: "builtin:recon-lens-verify-synthesize-red-team-attack-architect-judge-unify-edge-test",
			recommendedParallelism: 1,
			canAuthorize: false,
		});
		await expect(
			created.session.executeWorkflowHostRequest("skill" as `workflow.v1.${string}`, {}),
		).rejects.toThrow();

		await expect(created.session.executeWorkflowSkill({ skillName: "raw-skill" })).rejects.toThrow(/not admitted/i);
		await expect(created.session.executeWorkflowHostRequest("workflow.v1.completion.request", {})).rejects.toThrow(
			/pipeline_not_complete|goal metric.*(unmeasured|not.*proven)|completion.*metric/i,
		);
		await expect(created.session.executeWorkflowCommand({ kind: "status" })).resolves.toMatchObject({
			status: "active",
			goal: { status: "active", active: true },
		});

		expect(launchWorker).toHaveBeenCalledTimes(2);
		expect(launchWorker).toHaveBeenLastCalledWith(expect.objectContaining({ taskId: "lens" }));
	} finally {
		await created.session.disposeAsync();
	}
}, 420_000);
