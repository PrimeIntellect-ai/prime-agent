import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier, StreamLivenessHost } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.js";
import type { AgentSessionMessageController } from "./agent-messages.js";
import type { AgentObserveController } from "./agent-observe.js";
import type { AgentExecutionMode } from "./agent-session-config.js";
import { installAgentTraceUpload } from "./agent-traces.js";
import { AuthStorage } from "./auth-storage.js";
import type { AgentAutonomousConfig } from "./autonomous.js";
import type { AgentRlmHeartbeatController } from "./cron-jobs.js";
import { createHerdrAgentStateExtension } from "./extensions/builtin/herdr-agent-state.js";
import type { SessionStartEvent, ToolDefinition } from "./extensions/index.js";
import type { HostRequestCapabilityContext } from "./kernel/index.js";
import { McpManager } from "./mcp/mcp-manager.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader, type DefaultResourceLoaderOptions, type ResourceLoader } from "./resource-loader.js";
import type { SubagentRuntimeHost } from "./rlm-runtime.js";
import { type CreateAgentSessionResult, createAgentSession } from "./sdk.js";
import type { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";
import { installAgentTelemetry, isTelemetryEnabled } from "./telemetry.js";
import { persistWorkflowCliApprovalDelivery } from "./workflow/cli-approval.js";
import { type DurableApprovalSecretProof, digestObject, type WorkflowApprovalRequest } from "./workflow/contracts.js";
import type { DefaultPrimeTaskRuntimeAuthorityFactory } from "./workflow/default-prime.js";
import type {
	DefaultPrimeWorkerFailureNotice,
	DefaultPrimeWorkerLauncher,
	WorkflowComputeClass,
} from "./workflow/default-task-runtime.js";
import type { DefaultTaskRuntimeProgressWakeObligation } from "./workflow/default-task-runtime-authority.js";
import type { WorkflowExecutionEvidenceSource } from "./workflow/execution-evidence.js";
import {
	createGcloudWorkflowGoalAuthoritySourceResolver,
	createSessionWorkflowGoalAuthoritySourceResolver,
} from "./workflow/goal-authority-source.js";
import type { WorkerModelCapabilityAvailabilityResolver } from "./workflow/persisted-worker-model-admission.js";
import type { WorkflowPhaseHost } from "./workflow/phase-host.js";
import type { PrimeWorkflowAuthenticatedAdapterFactory, PrimeWorkflowSnapshots } from "./workflow/prime-loop.js";
import {
	createPersistedSessionWorkflowHost,
	resolvePersistedSessionWorkflowAuthority,
	type WorkflowGoalAuthoritySourceResolver,
} from "./workflow/session-host-factory.js";
import type { WorkflowResourceLoaderPort } from "./workflow/skill-snapshots.js";
import type { WorkflowPrimeStageEvidenceAdapter } from "./workflow/task-runtime-authority.js";
import {
	WORKER_MODEL_SELECTOR,
	type WorkerModelCapabilityLaunchAuthorizer,
} from "./workflow/worker-model-capability-gate.js";

export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	authStorage?: AuthStorage;
	settingsManager?: SettingsManager;
	modelRegistry?: ModelRegistry;
	/** Optional durable workflow host factory. It must reject incomplete durable adapter tuples. */
	workflowHostFactory?: AgentSessionWorkflowHostFactory;
	/** Runtime contract version forwarded to the authenticated workflow host. */
	runtimeVersion?: string;
	/** Authenticated immutable snapshots for the production Prime composition. */
	primeWorkflowSnapshots?: PrimeWorkflowSnapshots;
	/** Host-owned adapters bound to the opened workflow store and lease. */
	primeWorkflowAdaptersFactory?: PrimeWorkflowAuthenticatedAdapterFactory;
	/** Generic task-runtime authority factory bound to the opened store and epoch. */
	taskRuntimeAuthorityFactory?: DefaultPrimeTaskRuntimeAuthorityFactory;
	goalAuthoritySourceResolver?: WorkflowGoalAuthoritySourceResolver;
	/** Prime stage/evidence adapter bound to the opened store and authenticated status. */
	taskRuntimePrimeAdapter?: WorkflowPrimeStageEvidenceAdapter;
	primeWorkflowWorkerLauncher?: DefaultPrimeWorkerLauncher;
	primeWorkflowWorkerModel?: string;
	/** Selector per compute-class tier; absent tiers fall back to primeWorkflowWorkerModel. */
	primeWorkflowWorkerModelsByComputeClass?: Partial<Record<WorkflowComputeClass, string>>;
	/** Host-sealed worker admission; absent means workflow child launch fails closed. */
	workerModelCapabilityAdmission?: WorkerModelCapabilityLaunchAuthorizer;
	/** Optional redacted model availability override used by the persisted admission gate. */
	workerModelCapabilityAvailability?: WorkerModelCapabilityAvailabilityResolver;
	primeWorkflowWorkerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
	approvalSecretDelivery?: (input: {
		readonly request: WorkflowApprovalRequest;
		readonly proof: DurableApprovalSecretProof;
		readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
	}) => Promise<void> | void;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	/**
	 * Skip the built-in Herdr reporter for these services. Set for RLM subagent
	 * runtimes: they inherit the parent's HERDR_* pane identity, so their own
	 * reporter would race the parent's on the same pane and a subagent quit
	 * would release the pane while the parent is still running.
	 */
	noBuiltinHerdrReporter?: boolean;
	telemetryDisabled?: true;
}

export interface AgentSessionCreationOptions {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: ServiceTier;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	noTools?: "all" | "builtin";
	customTools?: ToolDefinition[];
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	includeGoals?: boolean;
	includeCompactSkill?: boolean;
	agentMessageController?: AgentSessionMessageController;
	agentObserveController?: AgentObserveController;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmSessionDir?: string;
	rlmParentNodeId?: string;
	rlmParentAgent?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	prewarmIpythonKernel?: boolean;
	autonomous?: AgentAutonomousConfig;
	serializedRefine?: boolean;
	executionMode?: AgentExecutionMode;
	telemetryDisabled?: true;
	initialGoal?: { objective: string; tokenBudget?: number };
	/** Host-minted capability context installed before any kernel can start. */
	hostRequestCapabilityContext?: HostRequestCapabilityContext;
	/** Host-owned construction gate resolved only after workflow setup is installed. */
	workflowSetupGate?: Promise<void>;
	/** Host-owned total deadline for one compaction attempt. */
	compactionDeadlineMs?: number;
	/** Host-owned provider stream liveness policy and clock. */
	streamLiveness?: StreamLivenessHost;
	/** Host-owned absolute deadline for one tool invocation. */
	toolExecutionDeadlineMs?: number;
	/** Host-owned deadline for accepted agent messages to reach recipient context. */
	agentMessageDeliveryDeadlineMs?: number;
	/** Exact executable used to launch admitted session kernels. */
	kernelPythonLauncher?: string;
}

export interface CreateAgentSessionFromServicesOptions extends AgentSessionCreationOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
}

export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	authStorage: AuthStorage;
	settingsManager: SettingsManager;
	modelRegistry: ModelRegistry;
	resourceLoader: ResourceLoader;
	mcpManager: McpManager;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	/** Durable workflow construction is injected so the service layer never invents a store. */
	workflowHostFactory?: AgentSessionWorkflowHostFactory;
	runtimeVersion?: string;
	/** Authenticated immutable snapshots for the production Prime composition. */
	primeWorkflowSnapshots?: PrimeWorkflowSnapshots;
	/** Host-owned adapters bound to the opened workflow store and lease. */
	primeWorkflowAdaptersFactory?: PrimeWorkflowAuthenticatedAdapterFactory;
	taskRuntimeAuthorityFactory?: DefaultPrimeTaskRuntimeAuthorityFactory;
	goalAuthoritySourceResolver?: WorkflowGoalAuthoritySourceResolver;
	taskRuntimePrimeAdapter?: WorkflowPrimeStageEvidenceAdapter;
	primeWorkflowWorkerLauncher?: DefaultPrimeWorkerLauncher;
	primeWorkflowWorkerModel?: string;
	primeWorkflowWorkerModelsByComputeClass?: Partial<Record<WorkflowComputeClass, string>>;
	workerModelCapabilityAdmission?: WorkerModelCapabilityLaunchAuthorizer;
	workerModelCapabilityAvailability?: WorkerModelCapabilityAvailabilityResolver;
	primeWorkflowWorkerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
	approvalSecretDelivery?: (input: {
		readonly request: WorkflowApprovalRequest;
		readonly proof: DurableApprovalSecretProof;
		readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
	}) => Promise<void> | void;
}

export interface AgentSessionWorkflowHostFactoryInput {
	sessionManager: SessionManager;
	artifactRoot: string;
	workflowId: string;
	rootSessionId: string;
	runtimeVersion?: string;
	primeWorkflowSnapshots?: PrimeWorkflowSnapshots;
	primeWorkflowAdaptersFactory?: PrimeWorkflowAuthenticatedAdapterFactory;
	taskRuntimeAuthorityFactory?: DefaultPrimeTaskRuntimeAuthorityFactory;
	goalAuthoritySourceResolver?: WorkflowGoalAuthoritySourceResolver;
	taskRuntimePrimeAdapter?: WorkflowPrimeStageEvidenceAdapter;
	primeWorkflowWorkerLauncher?: DefaultPrimeWorkerLauncher;
	primeWorkflowWorkerFailureDelivery?: (notice: DefaultPrimeWorkerFailureNotice) => Promise<void> | void;
	progressWakeDelivery?: (
		obligation: DefaultTaskRuntimeProgressWakeObligation,
	) => Promise<"scheduled" | "already_scheduled">;
	workerModelCapabilityAdmission?: WorkerModelCapabilityLaunchAuthorizer;
	workerModelCapabilityAvailability?: WorkerModelCapabilityAvailabilityResolver;
	primeWorkflowResourceLoader?: WorkflowResourceLoaderPort;
	/** Roots a workflow task may own paths under; absent keeps the built-in default. */
	primeWorkflowWorkspacePaths?: readonly string[];
	approvalSecretDelivery?: (input: {
		readonly request: WorkflowApprovalRequest;
		readonly proof: DurableApprovalSecretProof;
		readonly proofs: Readonly<Record<string, DurableApprovalSecretProof>>;
	}) => Promise<void> | void;
	executionEvidenceSourceDelivery?: (source: WorkflowExecutionEvidenceSource) => void;
	beforeTaskLaunch?: (taskId: string) => Promise<void>;
}

interface WorkflowSetupGate {
	readonly promise: Promise<void>;
	resolve(): void;
	reject(error: unknown): void;
}

function createWorkflowSetupGate(): WorkflowSetupGate {
	let resolvePromise: () => void = () => {};
	let rejectPromise: (error: unknown) => void = () => {};
	const promise = new Promise<void>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve: resolvePromise,
		reject: rejectPromise,
	};
}

export interface AgentSessionRecoverableWorkflowHost extends WorkflowPhaseHost {
	recoverBeforeResume(): Promise<void>;
}

export type AgentSessionWorkflowHostFactory = (
	input: AgentSessionWorkflowHostFactoryInput,
) => Promise<AgentSessionRecoverableWorkflowHost>;

type PrimeWorkflowWorkerSession = Pick<
	CreateAgentSessionResult["session"],
	"runWorkflowRlmChild" | "awaitRlmChildCompletion" | "cancelRlmChildRun"
>;

/** Create the host-owned workflow child launcher with bounded heartbeat admission. */
/**
 * Resolve the model selector for a task's declared compute class.
 *
 * Args:
 * computeClass: Tier the planner declared, or undefined for the session default.
 * models: Configured selector per tier; a missing tier falls back to the default selector.
 * fallback: Selector used when the resolved tier has no configured model.
 * Return: Model selector to launch the worker with.
 */
export function resolveWorkerModelForComputeClass(
	computeClass: WorkflowComputeClass | undefined,
	models: Partial<Record<WorkflowComputeClass, string>> | undefined,
	fallback: string,
): string {
	// An undeclared tier means "standard", the same answer builtinStages() already gives a stage with
	// no entry in BUILTIN_STAGE_COMPUTE. Returning the fallback selector instead let an omitted
	// computeClass skip the operator's tier map entirely, which made the map advisory: a planner that
	// omitted the field - which the plan guidance invites when it is unsure - silently got whichever
	// model the default constant named, whatever the operator had configured.
	return models?.[computeClass ?? "standard"] ?? fallback;
}

export function createDefaultPrimeWorkflowWorkerLauncher(input: {
	readonly session: PrimeWorkflowWorkerSession;
	readonly workerModel?: string;
	/** Selector per compute class. Absent tiers fall back to workerModel. */
	readonly workerModelsByComputeClass?: Partial<Record<WorkflowComputeClass, string>>;
}): DefaultPrimeWorkerLauncher {
	return async (request) => {
		let heartbeatInFlight: Promise<void> | null = null;
		let pendingHeartbeat: { readonly observedAt: string; readonly progressDigest: string } | null = null;
		let heartbeatFailure: Error | undefined;
		const flushHeartbeat = (): void => {
			if (heartbeatInFlight !== null || pendingHeartbeat === null) return;
			const heartbeat = pendingHeartbeat;
			pendingHeartbeat = null;
			heartbeatInFlight = request
				.reportHeartbeat(heartbeat)
				.catch((error: unknown) => {
					heartbeatFailure = error instanceof Error ? error : new Error(String(error));
				})
				.finally(() => {
					heartbeatInFlight = null;
					flushHeartbeat();
				});
		};
		const reportMeaningfulProgress = (progressDigest: string): void => {
			pendingHeartbeat = { observedAt: new Date().toISOString(), progressDigest };
			flushHeartbeat();
		};
		const capsuleDigest = request.taskCapsule?.capsuleDigest;
		if (capsuleDigest === undefined || capsuleDigest.length === 0)
			throw new Error("workflow_worker_task_capsule_required");
		const workerModel = resolveWorkerModelForComputeClass(
			request.computeClass,
			input.workerModelsByComputeClass,
			input.workerModel ?? WORKER_MODEL_SELECTOR,
		);
		const handle = await input.session.runWorkflowRlmChild(
			request.prompt,
			request.sessionName,
			workerModel,
			{
				workflowId: request.workflowId,
				taskId: request.taskId,
				attemptId: request.attemptId,
				executionKey: request.executionKey,
				epochRef: request.epochRef,
				deadlineAt: request.deadlineAt,
				capsuleDigest,
			},
			reportMeaningfulProgress,
			request.allowedToolNames,
			request.ownedPaths,
		);
		return {
			workerId: handle.rlm_child_id,
			executionIdentity: `rlm:${handle.rlm_child_id}:${request.executionKey}`,
			processStartId: `host:${process.pid}:${Math.floor(Date.now() - process.uptime() * 1_000)}`,
			processGroupId: `same-process-rlm:${process.pid}`,
			launchedAt: new Date().toISOString(),
			terminate: async (reason: string): Promise<boolean> => {
				const cancelled = input.session.cancelRlmChildRun(handle.rlm_child_id, reason);
				await input.session.awaitRlmChildCompletion(handle.rlm_child_id);
				return cancelled;
			},
			completion: (async () => {
				const completion = await input.session.awaitRlmChildCompletion(handle.rlm_child_id);
				const result =
					heartbeatFailure === undefined
						? completion
						: {
								status: "error" as const,
								output: completion.output,
								error: heartbeatFailure.message,
								retryable: true,
							};
				return {
					...result,
					kind: "worker" as const,
					binding: {
						workflowId: request.workflowId,
						taskId: request.taskId,
						attemptId: request.attemptId,
						executionKey: request.executionKey,
					},
				};
			})(),
		};
	};
}

function createDefaultWorkerModelCapabilityAvailability(
	modelRegistry: ModelRegistry,
): WorkerModelCapabilityAvailabilityResolver {
	return async (input) => {
		// Probe the model this launch actually wants. Probing the default instead reported luna's
		// readiness for a sol worker, so a tier could be declared ready on another model's evidence.
		const provider = input.policy.provider;
		const modelId = input.policy.model;
		const catalogModel = modelRegistry.find(provider, modelId);
		let executableModel: ReturnType<ModelRegistry["find"]>;
		try {
			executableModel = (await modelRegistry.getExecutableModels()).find(
				(model) => model.provider === provider && model.id === modelId,
			);
		} catch {
			return {
				authenticated: false,
				authRevision: "auth-unavailable",
				capabilityRevision:
					catalogModel === undefined
						? "model-unavailable"
						: digestObject({
								provider: catalogModel.provider,
								id: catalogModel.id,
								api: catalogModel.api,
								contextWindow: catalogModel.contextWindow,
								maxTokens: catalogModel.maxTokens,
							}),
				safeReason: "worker_model_readiness_probe_failed",
				desiredWorkers: 1,
				activeWorkers: 0,
				idleCapacity: 0,
				idleReason: "worker_model_capability_unavailable",
				retryAt: null,
			};
		}

		const auth =
			executableModel === undefined
				? undefined
				: await modelRegistry.getApiKeyAndHeaders(executableModel).catch(() => undefined);
		const authToken = modelRegistry.getCurrentProviderAuthSourceToken(provider);
		const authStatus = modelRegistry.getProviderAuthStatus(provider);
		const authenticated =
			executableModel !== undefined &&
			auth?.ok === true &&
			authToken !== undefined &&
			authStatus.source === authToken.source &&
			authStatus.label !== "expired";
		return {
			authenticated,
			authRevision:
				authToken === undefined
					? "auth-unavailable"
					: digestObject({
							provider: authToken.provider,
							source: authToken.source,
							identityFingerprint: authToken.identityFingerprint,
							valueFingerprint: authToken.valueFingerprint,
						}),
			capabilityRevision:
				executableModel === undefined
					? catalogModel === undefined
						? "model-unavailable"
						: digestObject({
								provider: catalogModel.provider,
								id: catalogModel.id,
								api: catalogModel.api,
								contextWindow: catalogModel.contextWindow,
								maxTokens: catalogModel.maxTokens,
							})
					: digestObject({
							provider: executableModel.provider,
							id: executableModel.id,
							api: executableModel.api,
							contextWindow: executableModel.contextWindow,
							maxTokens: executableModel.maxTokens,
						}),
			safeReason:
				catalogModel === undefined
					? "worker_model_not_in_catalog"
					: executableModel === undefined
						? "worker_model_not_executable"
						: authenticated
							? "available"
							: "worker_model_authentication_unavailable",
			desiredWorkers: 1,
			activeWorkers: 0,
			idleCapacity: authenticated ? 1 : 0,
			idleReason: authenticated ? null : "worker_model_capability_unavailable",
			retryAt: null,
		};
	};
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = options.cwd;
	const agentDir = options.agentDir ?? getAgentDir();
	const authStorage = options.authStorage ?? AuthStorage.create(join(agentDir, "auth.json"));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage, join(agentDir, "models.json"));
	const workerModelCapabilityAvailability =
		options.workerModelCapabilityAvailability ?? createDefaultWorkerModelCapabilityAvailability(modelRegistry);

	// MCP integrations: registers OAuth providers and gates the built-in
	// integration skills by whether the user is logged in (enable-by-login).
	const mcpManager = new McpManager({
		authStorage,
		getUserServers: () => settingsManager.getGlobalMcpServers(),
	});
	// refresh() resets the OAuth registry to built-ins; re-add user MCP providers too.
	modelRegistry.setOnOAuthProvidersReset(() => mcpManager.registerUserProviders());

	const userExtensionFactories = options.resourceLoaderOptions?.extensionFactories ?? [];
	// The built-in Herdr reporter defers to Herdr's own file-based integration
	// when the loader actually loaded it; two reporters would race on the same
	// pane. Deferral is late-bound to the loader's loaded paths (inline
	// factories run after file extensions load), so a file that exists but is
	// disabled or never discovered does not silence the built-in.
	// noExtensions is a full opt-out: it disables the built-in reporter too,
	// not just discovered extension files.
	const skipHerdrReporter = options.noBuiltinHerdrReporter || options.resourceLoaderOptions?.noExtensions;
	const builtinExtensionFactories = skipHerdrReporter
		? []
		: [createHerdrAgentStateExtension(() => resourceLoader.getLoadedExtensionPaths())];
	const resourceLoader: DefaultResourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		extensionFactories: [...builtinExtensionFactories, ...userExtensionFactories],
		cwd,
		agentDir,
		settingsManager,
		extraBuiltinSkillOverrides: () => mcpManager.getDisabledBuiltinSkillOverrides(),
	});
	await resourceLoader.reload();

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	if (
		!options.telemetryDisabled &&
		isTelemetryEnabled(settingsManager) &&
		!settingsManager.getTelemetryNoticeShown()
	) {
		diagnostics.push({
			type: "info",
			message:
				"Prime Agent sends pseudonymous usage and performance metrics without prompts, responses, tool content, file paths, or repository data. Disable this with telemetry.enabled=false, PRIME_AGENT_TELEMETRY=0, DO_NOT_TRACK=1, or offline mode.",
		});
		settingsManager.setTelemetryNoticeShown(true);
	}
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRegistry.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	return {
		cwd,
		agentDir,
		authStorage,
		settingsManager,
		modelRegistry,
		resourceLoader,
		mcpManager,
		diagnostics,
		workflowHostFactory: options.workflowHostFactory,
		runtimeVersion: options.runtimeVersion,
		primeWorkflowSnapshots: options.primeWorkflowSnapshots,
		primeWorkflowAdaptersFactory: options.primeWorkflowAdaptersFactory,
		taskRuntimeAuthorityFactory: options.taskRuntimeAuthorityFactory,
		goalAuthoritySourceResolver:
			options.goalAuthoritySourceResolver ?? createGcloudWorkflowGoalAuthoritySourceResolver(),
		taskRuntimePrimeAdapter: options.taskRuntimePrimeAdapter,
		primeWorkflowWorkerLauncher: options.primeWorkflowWorkerLauncher,
		primeWorkflowWorkerModel: options.primeWorkflowWorkerModel ?? WORKER_MODEL_SELECTOR,
		primeWorkflowWorkerModelsByComputeClass:
			options.primeWorkflowWorkerModelsByComputeClass ?? settingsManager.getWorkflowWorkerModelsByComputeClass(),
		workerModelCapabilityAdmission: options.workerModelCapabilityAdmission,
		workerModelCapabilityAvailability,
		primeWorkflowWorkerFailureDelivery: options.primeWorkflowWorkerFailureDelivery,
		approvalSecretDelivery: options.approvalSecretDelivery,
	};
}

export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	installAgentTraceUpload(options.sessionManager, {
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
	});
	const artifactRoot = options.sessionManager.getSessionArtifactDir();
	const workflowSetupGate = createWorkflowSetupGate();
	let persistedAuthority: Awaited<ReturnType<typeof resolvePersistedSessionWorkflowAuthority>> | null = null;
	if (artifactRoot === undefined) {
		workflowSetupGate.resolve();
	} else {
		await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
		await chmod(artifactRoot, 0o700);
		if (
			options.services.workflowHostFactory !== undefined &&
			(options.services.primeWorkflowSnapshots !== undefined ||
				options.services.primeWorkflowAdaptersFactory !== undefined)
		)
			throw new Error("prime_workflow_requires_persisted_session_host_factory");
		if (options.services.workflowHostFactory === undefined) {
			persistedAuthority = await resolvePersistedSessionWorkflowAuthority({
				artifactRoot,
				workflowId: options.sessionManager.getSessionId(),
				rootSessionId: options.sessionManager.getSessionId(),
			});
		}
	}
	const result = await createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		authStorage: options.services.authStorage,
		settingsManager: options.services.settingsManager,
		modelRegistry: options.services.modelRegistry,
		resourceLoader: options.services.resourceLoader,
		mcpManager: options.services.mcpManager,
		sessionManager: options.sessionManager,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		serviceTier: options.serviceTier,
		scopedModels: options.scopedModels,
		tools: options.tools,
		noTools: options.noTools,
		customTools: options.customTools,
		initialActiveToolNames: options.initialActiveToolNames,
		allowedToolNames: options.allowedToolNames,
		includeGoals: options.includeGoals,
		includeCompactSkill: options.includeCompactSkill,
		agentMessageController: options.agentMessageController,
		agentObserveController: options.agentObserveController,
		rlmDepth: options.rlmDepth,
		rlmMaxDepth: options.rlmMaxDepth,
		rlmSessionDir: options.rlmSessionDir,
		rlmParentNodeId: options.rlmParentNodeId,
		rlmParentAgent: options.rlmParentAgent,
		subagentRuntimeHost: options.subagentRuntimeHost,
		rlmHeartbeatController: options.rlmHeartbeatController,
		sessionStartEvent: options.sessionStartEvent,
		prewarmIpythonKernel: options.prewarmIpythonKernel,
		autonomous: options.autonomous,
		serializedRefine: options.serializedRefine,
		initialGoal: options.initialGoal,
		workflowSetupGate: workflowSetupGate.promise,
		hostRequestCapabilityContext: options.hostRequestCapabilityContext,
		compactionDeadlineMs: options.compactionDeadlineMs,
		streamLiveness: options.streamLiveness,
		toolExecutionDeadlineMs: options.toolExecutionDeadlineMs,
		agentMessageDeliveryDeadlineMs: options.agentMessageDeliveryDeadlineMs,
		kernelPythonLauncher: options.kernelPythonLauncher,
	});
	const primeWorkflowWorkerLauncher =
		options.services.primeWorkflowWorkerLauncher ??
		createDefaultPrimeWorkflowWorkerLauncher({
			session: result.session,
			workerModel: options.services.primeWorkflowWorkerModel,
			workerModelsByComputeClass: options.services.primeWorkflowWorkerModelsByComputeClass,
		});
	const primeWorkflowWorkerFailureDelivery =
		options.services.primeWorkflowWorkerFailureDelivery ??
		((notice: DefaultPrimeWorkerFailureNotice): void => result.session.recordWorkflowWorkerFailure(notice));
	if (artifactRoot !== undefined) {
		try {
			const goalAuthoritySourceResolver = createSessionWorkflowGoalAuthoritySourceResolver({
				artifactRoot,
				fallback: options.services.goalAuthoritySourceResolver ?? createGcloudWorkflowGoalAuthoritySourceResolver(),
			});
			const approvalSecretDelivery: NonNullable<
				AgentSessionWorkflowHostFactoryInput["approvalSecretDelivery"]
			> = async (delivery) => {
				await persistWorkflowCliApprovalDelivery({
					artifactRoot,
					request: delivery.request,
					proofs: delivery.proofs,
				});
				await options.services.approvalSecretDelivery?.(delivery);
			};
			let executionEvidenceSource: WorkflowExecutionEvidenceSource | undefined;
			const executionEvidenceSourceDelivery = (source: WorkflowExecutionEvidenceSource): void => {
				if (executionEvidenceSource !== undefined)
					throw new Error("workflow_execution_evidence_source_already_delivered");
				executionEvidenceSource = source;
			};
			const sessionId = options.sessionManager.getSessionId();
			const progressWakeDelivery = async (
				_obligation: DefaultTaskRuntimeProgressWakeObligation,
			): Promise<"scheduled" | "already_scheduled"> =>
				(await result.session.wakeActiveWorkflow()) ? "scheduled" : "already_scheduled";
			const beforeTaskLaunch = (_taskId: string): Promise<void> =>
				result.session.waitForPendingAgentMessageDelivery();
			const createWorkflowHost = async () => {
				let workflowHost: AgentSessionRecoverableWorkflowHost | undefined;
				try {
					workflowHost = options.services.workflowHostFactory
						? await options.services.workflowHostFactory({
								sessionManager: options.sessionManager,
								artifactRoot,
								workflowId: sessionId,
								rootSessionId: sessionId,
								runtimeVersion: options.services.runtimeVersion,
								primeWorkflowSnapshots: options.services.primeWorkflowSnapshots,
								primeWorkflowAdaptersFactory: options.services.primeWorkflowAdaptersFactory,
								taskRuntimeAuthorityFactory: options.services.taskRuntimeAuthorityFactory,
								goalAuthoritySourceResolver,
								taskRuntimePrimeAdapter: options.services.taskRuntimePrimeAdapter,
								primeWorkflowWorkerLauncher,
								primeWorkflowWorkerFailureDelivery,
								progressWakeDelivery,
								workerModelCapabilityAdmission: options.services.workerModelCapabilityAdmission,
								workerModelCapabilityAvailability: options.services.workerModelCapabilityAvailability,
								primeWorkflowResourceLoader: options.services.resourceLoader,
								primeWorkflowWorkspacePaths: options.services.settingsManager.getWorkflowWorkspacePaths(),
								approvalSecretDelivery,
								executionEvidenceSourceDelivery,
								beforeTaskLaunch,
							})
						: await createPersistedSessionWorkflowHost({
								artifactRoot,
								workflowId: sessionId,
								rootSessionId: sessionId,
								genesisEpoch: persistedAuthority?.genesisEpoch ?? { storeEpoch: 1, coordinatorEpoch: 1 },
								writerIdentity: persistedAuthority?.writerIdentity,
								runtimeVersion: options.services.runtimeVersion,
								primeWorkflowSnapshots: options.services.primeWorkflowSnapshots,
								primeWorkflowAdaptersFactory: options.services.primeWorkflowAdaptersFactory,
								taskRuntimeAuthorityFactory: options.services.taskRuntimeAuthorityFactory,
								goalAuthoritySourceResolver,
								taskRuntimePrimeAdapter: options.services.taskRuntimePrimeAdapter,
								primeWorkflowWorkerLauncher,
								primeWorkflowWorkerFailureDelivery,
								progressWakeDelivery,
								workerModelCapabilityAdmission: options.services.workerModelCapabilityAdmission,
								workerModelCapabilityAvailability: options.services.workerModelCapabilityAvailability,
								primeWorkflowResourceLoader: options.services.resourceLoader,
								primeWorkflowWorkspacePaths: options.services.settingsManager.getWorkflowWorkspacePaths(),
								approvalSecretDelivery,
								executionEvidenceSourceDelivery,
								beforeTaskLaunch,
								goalProjection: {
									read: () => result.session.readGoalStateForWorkflowProjection(),
									compareAndSwap: (expected, next, binding) =>
										result.session.compareAndSwapGoalState(expected, next, binding),
								},
							});
					if (options.services.workflowHostFactory !== undefined) await workflowHost.recoverBeforeResume();
					else if (workflowHost.status().status === "active") await workflowHost.recoverBeforeResume();
					result.session.setWorkflowHost(workflowHost, executionEvidenceSource);
				} catch (error) {
					executionEvidenceSource = undefined;
					await workflowHost?.dispose?.().catch(() => undefined);
					throw error;
				}
			};
			if (options.services.workflowHostFactory !== undefined || persistedAuthority !== null) {
				await createWorkflowHost();
				await result.session.resumeActiveWorkflow();
			} else {
				result.session.setWorkflowHostLoader(createWorkflowHost);
			}
			workflowSetupGate.resolve();
		} catch (error) {
			workflowSetupGate.reject(error);
			await result.session.disposeAsync();
			throw error;
		}
	}
	if (result.session.rlmDepth === 0 && !options.telemetryDisabled) {
		installAgentTelemetry(result.session, {
			agentDir: options.services.agentDir,
			settingsManager: options.services.settingsManager,
			executionMode: options.executionMode,
		});
	}
	return result;
}
