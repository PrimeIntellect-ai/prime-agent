import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-services.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { readWorkflowCliApprovalDelivery } from "../../src/core/workflow/cli-approval.js";
import { getMessageText } from "../suite/harness.js";

const mode = process.argv[2];
const rootDir = process.argv[3];
if ((mode !== "draft" && mode !== "propose") || rootDir === undefined)
	throw new Error("Usage: workflow-brainstorm-process.ts <draft|propose> <root>");

mkdirSync(rootDir, { recursive: true });
const metadataPath = join(rootDir, "metadata.json");
const resultPath = join(rootDir, "result.json");

const COMPLETE_PROPOSAL = {
	objective: "Ship an automatic restart-safe workflow preflight",
	acceptanceChecks: ["fresh-process-preflight"],
	protectedInvariants: ["zero-pre-authority-effects"],
	boundaryIds: ["zero-pre-authority-effects"],
	gateIds: ["fresh-process-preflight"],
	successMetrics: [
		{
			metricId: "fresh-process-preflight",
			requirementId: "fresh-process-preflight",
			direction: "exact",
			target: 1,
			tolerance: 0,
			measurement: "fresh_process",
			guardIds: ["zero-pre-authority-effects"],
		},
	],
	nonGoalIds: ["raw-worker-launch"],
	budgets: { tokenLimit: 100000, wallTimeLimitSeconds: 7200, spendLimitMicrounits: 0 },
	// Roles are declared because a planner-authored graph is rejected without one "verification" task
	// and one terminal "red-team" task (WORKFLOW_REQUIRED_TASK_ROLES, enforced in
	// normalizeTaskGraphSource). Neither task declares ownedPaths, so no checker owns what it checks.
	taskGraphSource: {
		schemaVersion: 1,
		graphRevision: 1,
		tasks: [
			{
				taskId: "verify-fresh-process",
				objective: "Verify the workflow contract in a fresh process",
				requirementIds: ["fresh-process-preflight"],
				completionCriteria: ["zero-pre-authority-effects"],
				dependencyTaskIds: [],
				boundaryIds: ["zero-pre-authority-effects"],
				inputRefs: [],
				outputRefs: ["fresh-process-result"],
				evidencePolicy: { kind: "process_restart", maxBytes: 4096, maxItems: 8, independent: true },
				budget: { tokenLimit: 100000, wallTimeLimitSeconds: 7200, spendLimitMicrounits: 0 },
				recovery: "replan",
				authority: ["read_workspace"],
				role: "verification",
			},
			{
				taskId: "attack-fresh-process",
				objective: "Red-team the verified fresh-process contract",
				requirementIds: ["fresh-process-preflight"],
				completionCriteria: ["zero-pre-authority-effects"],
				dependencyTaskIds: ["verify-fresh-process"],
				boundaryIds: ["zero-pre-authority-effects"],
				inputRefs: [],
				outputRefs: ["fresh-process-red-team"],
				evidencePolicy: { kind: "process_restart", maxBytes: 4096, maxItems: 8, independent: true },
				budget: { tokenLimit: 100000, wallTimeLimitSeconds: 7200, spendLimitMicrounits: 0 },
				recovery: "replan",
				authority: ["read_workspace"],
				role: "red-team",
			},
		],
	},
	requestedProfile: "inline",
	maxWorkers: 1,
} as const;

function writeResult(value: Record<string, unknown>): void {
	writeFileSync(resultPath, `${JSON.stringify(value)}\n`, "utf8");
}

async function createProcessSession(sessionManager: SessionManager) {
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const services = await createAgentSessionServices({
		cwd: rootDir,
		agentDir: rootDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoaderOptions: { noPromptTemplates: true, noThemes: true },
	});
	const created = await createAgentSessionFromServices({
		services,
		sessionManager,
		model,
		telemetryDisabled: true,
	});
	return { faux, session: created.session };
}

async function draft(): Promise<void> {
	const sessionManager = SessionManager.create(rootDir!, join(rootDir!, "sessions"));
	const { faux, session } = await createProcessSession(sessionManager);
	faux.setResponses([fauxAssistantMessage("Which public process outcome defines completion?")]);
	await session.promptAndWait("/workflow build the automatic workflow command");
	await session.waitForIdle();
	const sessionFile = sessionManager.getSessionFile();
	if (sessionFile === undefined) throw new Error("workflow brainstorm did not create a session file");
	writeFileSync(
		metadataPath,
		`${JSON.stringify({ sessionFile, sessionDir: sessionManager.getSessionDir() })}\n`,
		"utf8",
	);
	writeResult({
		mode,
		activeTools: session.getActiveToolNames(),
		assistant: getMessageText(session.messages.at(-1)),
		workflowStatus: "idle",
		approvalCredentialPresent: existsSync(
			join(sessionManager.getSessionArtifactDir()!, "workflow-cli-approval.json"),
		),
	});
	await session.disposeAsync();
	faux.unregister();
	process.exit(0);
}

async function propose(): Promise<void> {
	const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as { sessionFile: string; sessionDir: string };
	const sessionManager = SessionManager.open(metadata.sessionFile, metadata.sessionDir);
	const { faux, session } = await createProcessSession(sessionManager);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("workflow_propose", COMPLETE_PROPOSAL), { stopReason: "toolUse" }),
		fauxAssistantMessage("The sealed proposal is ready for trusted approval."),
	]);
	await session.promptAndWait("Completion means the fresh process contract passes with no pre-authority effects.");
	await session.waitForIdle();
	await session.promptAndWait("/workflow status");
	const delivery = await readWorkflowCliApprovalDelivery(sessionManager.getSessionArtifactDir()!);
	// Fail here rather than exiting 0 with a null approvalRequestId: every consumer of this fixture
	// asserts on the post-propose approval state, so a rejected proposal has to surface as this
	// process failing, not as a downstream error 100 lines away.
	if (delivery === undefined)
		throw new Error(`workflow propose did not reach approval: ${getMessageText(session.messages.at(-1))}`);
	const sourceDirectory = join(sessionManager.getSessionArtifactDir()!, "workflow-goal-sources");
	writeResult({
		mode,
		activeTools: session.getActiveToolNames(),
		status: getMessageText(session.messages.at(-1)),
		approvalRequestId: delivery?.request.approvalRequestId ?? null,
		approvalOptions: delivery === undefined ? [] : Object.keys(delivery.proofs).sort(),
		goalSourceCount: existsSync(sourceDirectory)
			? readdirSync(sourceDirectory).filter((fileName) => /^sha256=[0-9a-f]{64}\.json$/.test(fileName)).length
			: 0,
		workflowArtifacts: sessionManager.getSessionArtifactDir(),
	});
	await session.disposeAsync();
	faux.unregister();
	process.exit(0);
}

await (mode === "draft" ? draft() : propose());
