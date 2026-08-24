import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.js";
import { readWorkflowTaskGraphSource } from "../../src/core/workflow/brainstorm.js";
import { readWorkflowCliApprovalDelivery } from "../../src/core/workflow/cli-approval.js";
import type { WorkflowCommand, WorkflowShellStatus } from "../../src/core/workflow/shell.js";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "./harness.js";

const COMPLETE_PROPOSAL = {
	objective: "Ship a restart-safe workflow command",
	acceptanceChecks: ["public-process-restart"],
	protectedInvariants: ["no-pre-authority-effects"],
	boundaryIds: ["no-pre-authority-effects"],
	gateIds: ["public-process-restart"],
	successMetrics: [
		{
			metricId: "process-restart-green",
			requirementId: "public-process-restart",
			direction: "exact",
			target: 1,
			tolerance: 0,
			measurement: "fresh_process",
			guardIds: ["no-pre-authority-effects"],
		},
	],
	nonGoalIds: ["generic-workflow-framework"],
	budgets: {
		tokenLimit: 100000,
		wallTimeLimitSeconds: 7200,
		spendLimitMicrounits: 0,
	},
	taskGraphSource: {
		schemaVersion: 1,
		graphRevision: 1,
		tasks: [
			{
				taskId: "release-contract",
				objective: "Capture the restart-safe release contract",
				requirementIds: ["public-process-restart"],
				completionCriteria: ["no-pre-authority-effects"],
				dependencyTaskIds: [],
				boundaryIds: ["no-pre-authority-effects"],
				inputRefs: [],
				outputRefs: ["release-contract-result"],
				evidencePolicy: { kind: "contract_observation", maxBytes: 4096, maxItems: 8, independent: true },
				budget: { tokenLimit: 100000, wallTimeLimitSeconds: 7200, spendLimitMicrounits: 0 },
				recovery: "replan",
				authority: ["read_workspace"],
			},
		],
	},
	requestedProfile: "inline",
	maxWorkers: 1,
} as const;

const PROMPT_GRAPH_PROPOSAL = {
	...COMPLETE_PROPOSAL,
	objective: "Ship the smallest release workflow for the payments gateway",
	taskGraphSource: {
		schemaVersion: 1,
		graphRevision: 1,
		tasks: [
			{
				taskId: "inspect-payment-boundary",
				objective: "Inspect the payments gateway boundary",
				requirementIds: ["public-process-restart"],
				completionCriteria: ["no-pre-authority-effects"],
				dependencyTaskIds: [],
				boundaryIds: ["no-pre-authority-effects"],
				inputRefs: [],
				outputRefs: ["payment-boundary-observation"],
				evidencePolicy: { kind: "boundary_observation", maxBytes: 4096, maxItems: 8, independent: true },
				budget: COMPLETE_PROPOSAL.budgets,
				recovery: "replan",
				authority: ["read_workspace"],
			},
			{
				taskId: "verify-payment-release",
				objective: "Verify the payments gateway release can restart safely",
				requirementIds: ["public-process-restart"],
				completionCriteria: ["no-pre-authority-effects"],
				dependencyTaskIds: ["inspect-payment-boundary"],
				boundaryIds: ["no-pre-authority-effects"],
				inputRefs: ["payment-boundary-observation"],
				outputRefs: ["payment-release-verification"],
				evidencePolicy: { kind: "release_verification", maxBytes: 4096, maxItems: 8, independent: true },
				budget: COMPLETE_PROPOSAL.budgets,
				recovery: "replan",
				authority: ["read_workspace"],
			},
		],
	},
} as const;

function idleStatus(): WorkflowShellStatus {
	return {
		workflowId: null,
		status: "idle",
		phase: null,
		goal: {
			active: false,
			status: "idle",
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
		},
		goalContract: null,
		approvalRequest: null,
		stateDigest: null,
		decisionRefs: [],
		resourceEnvelopeDigest: null,
		scorecardDigest: null,
		pendingWaitReasons: [],
		acceptanceCheckIds: [],
		protectedInvariantIds: [],
	};
}

describe("automatic workflow brainstorming", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses the current task for bare /workflow and exposes no execution tool before a contract exists", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const execute = vi.fn(async (_command: WorkflowCommand) => idleStatus());
		harness.session.setWorkflowHost({ execute, status: idleStatus });
		harness.setResponses([fauxAssistantMessage("Task context captured.")]);
		await harness.session.promptAndWait("Create the smallest safe release workflow for this repository.");
		harness.setResponses([
			fauxAssistantMessage("What measurable outcome must this workflow achieve before it is complete?"),
		]);

		await harness.session.promptAndWait("/workflow");
		await harness.session.waitForIdle();

		expect(getAssistantTexts(harness).at(-1)).toContain("measurable outcome");
		expect(harness.session.getActiveToolNames()).toEqual(["workflow_propose"]);
		expect(execute).not.toHaveBeenCalled();
		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("rlm");
	});

	it("persists a draft question without executing when bare /workflow has no task context", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const execute = vi.fn(async (_command: WorkflowCommand) => idleStatus());
		harness.session.setWorkflowHost({ execute, status: idleStatus });

		await harness.session.promptAndWait("/workflow");
		await harness.session.waitForIdle();

		expect(getMessageText(harness.session.messages.at(-1))).toContain("what we are working on");
		expect(execute).not.toHaveBeenCalled();
		expect(harness.getPendingResponseCount()).toBe(0);
		const draft = harness.session.messages.find(
			(message) => message.role === "custom" && message.customType === "prime-agent.workflow-brainstorm",
		);
		expect(draft).toMatchObject({
			details: { status: "draft", prompt: expect.stringContaining("what we are working on") },
		});
	});

	it("bounds the automatic brainstorming turn while retaining the detailed immutable task source", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const awaitingStatus: WorkflowShellStatus = {
			...idleStatus(),
			workflowId: harness.sessionManager.getSessionId(),
			status: "awaiting_user",
			phase: "adjudicating",
		};
		const execute = vi.fn(async (_command: WorkflowCommand) => awaitingStatus);
		harness.session.setWorkflowHost({ execute, status: idleStatus });
		const detailedTask = [
			"Ship the smallest restart-safe workflow command.",
			...Array.from(
				{ length: 5_000 },
				(_, index) => `Detailed contract requirement ${index}: preserve this immutable source wording exactly.`,
			),
		].join(" ");
		const providerPrompts: string[] = [];
		let providerContextLength = 0;
		harness.setResponses([
			(context) => {
				const prompt = getMessageText(context.messages.at(-1));
				providerPrompts.push(prompt);
				if (prompt.startsWith("Start the workflow completeness preflight"))
					providerContextLength = JSON.stringify(context).length;
				return fauxAssistantMessage(fauxToolCall("workflow_propose", COMPLETE_PROPOSAL), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("The compact proposal is ready for trusted approval."),
		]);

		await harness.session.promptAndWait(`/workflow ${detailedTask}`);
		await harness.session.waitForIdle();

		const providerPrompt = providerPrompts.find((prompt) =>
			prompt.startsWith("Start the workflow completeness preflight"),
		);
		expect(providerPrompt).toBeDefined();
		expect(providerPrompt!.length).toBeLessThanOrEqual(12_000);
		expect(providerContextLength).toBeLessThanOrEqual(20_000);
		expect(providerPrompt).toContain("full task retained in immutable source");
		const command = execute.mock.calls[0]?.[0];
		if (command?.kind !== "start") throw new Error("workflow proposal did not submit a start request");
		const sourceUri = command.request.goalContract?.authoritativeSource.uri;
		if (sourceUri === undefined) throw new Error("workflow proposal did not bind an immutable source");
		const sourceFile = sourceUri.split("/").at(-1);
		if (sourceFile === undefined) throw new Error("workflow source URI has no object filename");
		const sourcePath = join(harness.sessionManager.getSessionArtifactDir()!, "workflow-goal-sources", sourceFile);
		const source = JSON.parse(await readFile(sourcePath, "utf8")) as { prompt: string };
		expect(source.prompt).toBe(detailedTask);
	});

	it("fences a prewarmed kernel before workflow brainstorming can begin", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const kill = vi.fn(async () => undefined);
		const sessionInternals = harness.session as unknown as {
			_ipythonKernelProvisioner: { kill(): Promise<void> };
		};
		sessionInternals._ipythonKernelProvisioner = { kill };
		harness.setResponses([fauxAssistantMessage("Which outcome proves completion?")]);

		await harness.session.promptAndWait("/workflow build a bounded release workflow");
		await harness.session.waitForIdle();

		expect(kill).toHaveBeenCalledOnce();
		expect(harness.session.getActiveToolNames()).toEqual(["workflow_propose"]);
	});

	it("seals a complete proposal and submits one validated workflow start request", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const awaitingStatus: WorkflowShellStatus = {
			...idleStatus(),
			workflowId: harness.sessionManager.getSessionId(),
			status: "awaiting_user",
			phase: "adjudicating",
		};
		const execute = vi.fn(async (_command: WorkflowCommand) => awaitingStatus);
		harness.session.setWorkflowHost({ execute, status: idleStatus });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow_propose", COMPLETE_PROPOSAL), { stopReason: "toolUse" }),
			fauxAssistantMessage("The exact proposal is ready for your approval."),
		]);

		await harness.session.promptAndWait("/workflow build the safest workflow command");
		await harness.session.waitForIdle();

		expect(execute).toHaveBeenCalledTimes(1);
		const command = execute.mock.calls[0]?.[0];
		expect(command).toMatchObject({
			kind: "start",
			request: {
				objective: "Ship a restart-safe workflow command",
				acceptanceChecks: ["public-process-restart"],
				protectedInvariants: ["no-pre-authority-effects"],
				requestedProfile: "inline",
				maxWorkers: 1,
				goalContract: {
					successMetrics: [{ metricId: "process-restart-green" }],
					nonGoalIds: ["generic-workflow-framework"],
				},
			},
		});
		expect(command?.kind === "start" ? command.request.goalContract?.authoritativeSource.uri : undefined).toMatch(
			/^session-artifact:\/\/workflow-goal-sources\/sha256=[a-f0-9]{64}\.json$/,
		);
		expect(harness.session.getActiveToolNames()).toEqual([]);
	});

	it("rejects a complete proposal when its immutable task graph source is absent", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const execute = vi.fn(async (_command: WorkflowCommand) => idleStatus());
		harness.session.setWorkflowHost({ execute, status: idleStatus });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow_propose", { ...COMPLETE_PROPOSAL, taskGraphSource: undefined }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The proposal is missing its task graph source."),
		]);

		await harness.session.promptAndWait("/workflow build the safest workflow command");
		await harness.session.waitForIdle();

		expect(execute).not.toHaveBeenCalled();
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.map((message) => getMessageText(message))
				.join("\n"),
		).toContain("workflow_task_graph_source_missing");
	});

	it("seals a prompt-specific immutable task graph with the proposal", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const awaitingStatus: WorkflowShellStatus = {
			...idleStatus(),
			workflowId: harness.sessionManager.getSessionId(),
			status: "awaiting_user",
			phase: "adjudicating",
		};
		const execute = vi.fn(async (_command: WorkflowCommand) => awaitingStatus);
		harness.session.setWorkflowHost({ execute, status: idleStatus });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow_propose", PROMPT_GRAPH_PROPOSAL), { stopReason: "toolUse" }),
			fauxAssistantMessage("The release graph is ready for trusted approval."),
		]);

		await harness.session.promptAndWait("/workflow release the payments gateway safely");
		await harness.session.waitForIdle();

		const command = execute.mock.calls[0]?.[0];
		if (command?.kind !== "start") throw new Error("workflow proposal did not submit a start request");
		const sourceUri = command.request.goalContract?.authoritativeSource.uri;
		if (sourceUri === undefined) throw new Error("workflow proposal did not bind an immutable source");
		const sourceFile = sourceUri.split("/").at(-1);
		if (sourceFile === undefined) throw new Error("workflow source URI has no object filename");
		const sourcePath = join(harness.sessionManager.getSessionArtifactDir()!, "workflow-goal-sources", sourceFile);
		const source = JSON.parse(await readFile(sourcePath, "utf8")) as {
			taskGraphSource?: {
				tasks: readonly {
					taskId: string;
					objective: string;
					boundaryIds?: readonly string[];
					inputRefs?: readonly string[];
					outputRefs?: readonly string[];
					evidencePolicy?: { readonly kind: string };
					budget?: { readonly tokenLimit: number };
					recovery?: string;
					authority?: readonly string[];
				}[];
				graphDigest?: string;
			};
			taskGraphDigest?: string;
			taskGraphBindingDigest?: string;
		};
		expect(source.taskGraphSource?.tasks.map((task) => task.taskId)).toEqual([
			"inspect-payment-boundary",
			"verify-payment-release",
		]);
		expect(source.taskGraphSource?.tasks[1]?.objective).toContain("payments gateway");
		expect(source.taskGraphSource?.tasks[0]?.boundaryIds).toEqual(["no-pre-authority-effects"]);
		expect(source.taskGraphSource?.tasks[1]?.inputRefs).toEqual(["payment-boundary-observation"]);
		expect(source.taskGraphSource?.tasks[0]?.outputRefs).toEqual(["payment-boundary-observation"]);
		expect(source.taskGraphSource?.tasks[0]?.evidencePolicy?.kind).toBe("boundary_observation");
		expect(source.taskGraphSource?.tasks[0]?.budget?.tokenLimit).toBe(COMPLETE_PROPOSAL.budgets.tokenLimit);
		expect(source.taskGraphSource?.tasks[0]?.recovery).toBe("replan");
		expect(source.taskGraphSource?.tasks[0]?.authority).toEqual(["read_workspace"]);
		expect(source.taskGraphSource?.graphDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(source.taskGraphDigest).toBe(source.taskGraphSource?.graphDigest);
		expect(source.taskGraphBindingDigest).toMatch(/^[a-f0-9]{64}$/);
	});

	it("fails closed when the sealed graph source is mutated or removed", async () => {
		const harness = await createHarness({ persistSession: true });
		harnesses.push(harness);
		const awaitingStatus: WorkflowShellStatus = {
			...idleStatus(),
			workflowId: harness.sessionManager.getSessionId(),
			status: "awaiting_user",
			phase: "adjudicating",
		};
		const execute = vi.fn(async (_command: WorkflowCommand) => awaitingStatus);
		harness.session.setWorkflowHost({ execute, status: idleStatus });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("workflow_propose", PROMPT_GRAPH_PROPOSAL), { stopReason: "toolUse" }),
			fauxAssistantMessage("The release graph is ready for trusted approval."),
		]);

		await harness.session.promptAndWait("/workflow release the payments gateway safely");
		await harness.session.waitForIdle();
		const command = execute.mock.calls[0]?.[0];
		if (command?.kind !== "start") throw new Error("workflow proposal did not submit a start request");
		const source = command.request.goalContract?.authoritativeSource;
		if (source === undefined) throw new Error("workflow proposal did not bind an immutable source");
		const sourcePath = join(
			harness.sessionManager.getSessionArtifactDir()!,
			"workflow-goal-sources",
			source.uri.split("/").at(-1)!,
		);
		const original = await readFile(sourcePath);
		await writeFile(sourcePath, Buffer.concat([original, Buffer.from("\n", "utf8")]));
		await expect(
			readWorkflowTaskGraphSource({ artifactRoot: harness.sessionManager.getSessionArtifactDir()!, source }),
		).rejects.toThrow("workflow_task_graph_source_digest_invalid");
		await writeFile(sourcePath, original);
		const restored = await readWorkflowTaskGraphSource({
			artifactRoot: harness.sessionManager.getSessionArtifactDir()!,
			source,
		});
		expect(restored?.graphDigest).toMatch(/^[a-f0-9]{64}$/);
		await rm(sourcePath);
		await expect(
			readWorkflowTaskGraphSource({ artifactRoot: harness.sessionManager.getSessionArtifactDir()!, source }),
		).rejects.toThrow("workflow_task_graph_source_missing");
	});

	it("retains the one-use native approval across session recreation", async () => {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.disposeAsync();
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const first = await createAgentSessionFromServices({
			services,
			sessionManager: harness.sessionManager,
			model: harness.getModel(),
		});
		let second: Awaited<ReturnType<typeof createAgentSessionFromServices>> | undefined;
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("workflow_propose", COMPLETE_PROPOSAL), { stopReason: "toolUse" }),
				fauxAssistantMessage("Proposal sealed."),
			]);
			await first.session.promptAndWait("/workflow build the safest workflow command");
			await first.session.waitForIdle();
			await first.session.promptAndWait("/workflow status");
			expect(getMessageText(first.session.messages.at(-1))).toContain("awaiting_user");
			await first.session.disposeAsync();

			second = await createAgentSessionFromServices({
				services,
				sessionManager: harness.sessionManager,
				model: harness.getModel(),
			});
			expect(second.session.getActiveToolNames()).toEqual([]);
			const delivery = await readWorkflowCliApprovalDelivery(harness.sessionManager.getSessionArtifactDir()!);
			expect(delivery).toMatchObject({
				version: 1,
				request: {
					workflowId: harness.sessionManager.getSessionId(),
					approvalRequestId: expect.any(String),
				},
				proofs: {
					approve: { oneUseSecret: expect.any(String), bindingDigest: expect.any(String) },
				},
			});
		} finally {
			await second?.session.disposeAsync();
			await first.session.disposeAsync();
		}
	});

	it("rejects an external source that cannot carry the immutable task graph", async () => {
		const harness = await createHarness({ persistSession: true, settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.disposeAsync();
		const sourceBytes = Buffer.from("immutable external workflow source\n", "utf8");
		const sourcePath = join(harness.tempDir, "workflow-source.md");
		const sourceDigest = createHash("sha256").update(sourceBytes).digest("hex");
		await writeFile(sourcePath, sourceBytes);
		const services = await createAgentSessionServices({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage: harness.authStorage,
			settingsManager: harness.settingsManager,
			resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
		});
		const first = await createAgentSessionFromServices({
			services,
			sessionManager: harness.sessionManager,
			model: harness.getModel(),
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("workflow_propose", {
						...COMPLETE_PROPOSAL,
						authoritativeSource: {
							uri: "gs://authority/immutable-workflow-source.md",
							objectGeneration: "1786938985509738",
							objectDigest: sourceDigest,
							objectSizeBytes: sourceBytes.byteLength,
							localPath: sourcePath,
						},
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("Proposal sealed."),
			]);

			await first.session.promptAndWait("/workflow build from the supplied immutable source");
			await first.session.waitForIdle();
			expect(
				first.session.messages
					.filter((message) => message.role === "toolResult")
					.map((message) => getMessageText(message))
					.join("\n"),
			).toContain("workflow_task_graph_source_requires_session_source");
		} finally {
			await first.session.disposeAsync();
		}
	});
});
