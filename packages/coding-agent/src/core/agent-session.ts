import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import type { LookupFunction } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	Agent,
	type AgentContext,
	AgentContinueError,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type GetContinuationMessagesContext,
	type ShouldStopAfterTurnContext,
	type ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Model,
	ServiceTier,
	TextContent,
	ToolCall,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import {
	Agent as UndiciAgent,
	type RequestInit as UndiciRequestInit,
	type Response as UndiciResponse,
	fetch as undiciFetch,
} from "undici";
import { getAgentDir } from "../config.js";
import { theme } from "../modes/interactive/theme/theme.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	AGENT_MESSAGE_SKILL_NAME,
	type AgentFamilyCatalogEntry,
	type AgentFamilyRosterResult,
	type AgentSessionMessage,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageController,
	type AgentSessionMessageListResult,
	type AgentSessionMessageReceipt,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	createAgentMessageHostHandlers,
	formatAgentSessionNameUnavailable,
	isAgentSessionMessage,
	normalizeAgentSessionMessage,
	parseAgentSessionMessagePromptId,
	startsAgentRun,
} from "./agent-messages.js";
import {
	AGENT_OBSERVE_SKILL_NAME,
	type AgentObserveAgentSnapshot,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	createAgentObserveHostHandlers,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
	ORCHESTRATION_HEARTBEAT_SKILL_NAME,
} from "./agent-observe.js";
import { flushAgentTraceUpload } from "./agent-traces.js";
import {
	addLoginGuidanceToAuthError,
	formatAuthenticationFailedMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	isLikelyAuthenticationError,
} from "./auth-guidance.js";
import type { AuthSourceToken } from "./auth-storage.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousLimitReason,
	autonomousStatus,
	createAutonomousRuntimeState,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
} from "./autonomous.js";
import {
	AUTORESEARCH_SKILL_NAME,
	type AutoresearchPeerReviewVerification,
	type AutoresearchPublication,
	type AutoresearchPublicationVerification,
	type AutoresearchReviewerRole,
	AutoresearchStore,
	buildAutoresearchReviewerPrompts,
	buildAutoresearchSupervisorBootstrapPrompt,
	buildAutoresearchSupervisorPrompt,
	hasApplicablePeerReviewEvidence,
	isPublicAutoresearchAddress,
	parseAutoresearchCandidateInput,
	parseAutoresearchClaimInput,
	parseAutoresearchClaimUpdateInput,
	parseAutoresearchCycleInput,
	parseAutoresearchExperimentInput,
	parseAutoresearchMemoryInput,
	parseAutoresearchMemoryReuseInput,
	parseAutoresearchPeerReviewEvidenceInput,
	parseAutoresearchPublicationInput,
	parseAutoresearchSearchReceiptInput,
	parseAutoresearchSupervisionInput,
	visibleAutoresearchEvidenceText,
} from "./autoresearch.js";
import {
	AVO_HORIZONS,
	AVO_HOST_REQUEST_TYPES,
	AVO_PYTHON_PROBE_MAX_CASES,
	AVO_SKILL_NAME,
	AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY_ENV,
	type AvoCanonicalDeliveryBinding,
	type AvoEvaluationReceipt,
	type AvoHorizonSelection,
	type AvoIndependentClaimVerdict,
	AvoProgressWatchdog,
	type AvoProgressWatchdogAssessment,
	type AvoPythonProbeBindings,
	type AvoPythonProbeBundle,
	type AvoPythonProbeExecutorAvailability,
	type AvoPythonProbePlan,
	type AvoPythonProbeReport,
	type AvoRunState,
	AvoSessionRuntime,
	type AvoStopGate,
	type AvoVariationContract,
	type AvoVerificationBrokerReceipt,
	applyAvoSpecContractStopGate,
	assertAvoClaimSourceContextSafe,
	assertAvoClaimVerifierQuoteSafe,
	assertAvoSpecReceiptTrustConfiguration,
	assessAvoCandidateIntegrity,
	assessAvoClaimEvidence,
	assessAvoHostCommand,
	assessAvoPythonProbeAdequacy,
	assessAvoTestTrust,
	avoClaimVerifierMarker,
	avoVerificationBrokerGrantsPythonSemanticAuthority,
	avoVerificationBrokerReceiptMatchesWorkspace,
	buildAvoClaimVerifierPrompt,
	buildAvoMemoryReasonerPrompt,
	buildAvoMemoryReconcilerPrompt,
	buildAvoMemoryReconciliationVerifierPrompt,
	buildAvoMemoryVerifierPrompt,
	buildAvoRuntimePrompt,
	buildAvoSupervisorBootstrapPrompt,
	buildAvoSupervisorMessage,
	buildAvoSupervisorPacket,
	captureAvoArtifactPathBaseline,
	captureAvoCodingVerificationBaseline,
	captureAvoPythonProbeBundle,
	captureAvoSpecContractBaseline,
	captureAvoVerificationHarnessManifest,
	captureAvoWorkspaceSnapshot,
	classifyAvoHostEvaluationCommand,
	combineAvoClaimEvidenceAssessments,
	createAvoVerificationBrokerBashOperations,
	deriveAvoDeterministicArithmeticContract,
	deriveAvoObservedTestIdentities,
	deriveAvoProgressWatchdogSnapshot,
	deriveAvoSpecSemanticCoverage,
	deriveAvoWorkspaceImpactPaths,
	digestAvoDeliveryText,
	digestAvoPayload,
	digestAvoPythonProbeApplicability,
	executeAvoPythonProbeSandbox,
	findAvoSupervisorResponseText,
	getAvoPythonProbeExecutorAvailability,
	inspectAvoPythonPublicCallables,
	isAvoFeatureAblated,
	isAvoImmutableSemanticTestReceipt,
	parseAvoAssumptionResolutionInput,
	parseAvoCandidateInput,
	parseAvoClaimVerifierMessage,
	parseAvoCriticalAssumptionInput,
	parseAvoCycleInput,
	parseAvoEvaluationInput,
	parseAvoExperimentInput,
	parseAvoMemoryInput,
	parseAvoMemoryReasonerMessage,
	parseAvoMemoryReconcilerMessage,
	parseAvoMemoryReconciliationVerifierMessage,
	parseAvoMemoryVerifierMessage,
	parseAvoObligationCoverageInput,
	parseAvoObligationInput,
	parseAvoPythonProbePlan,
	parseAvoSupervisorMessage,
	parseAvoTrialInput,
	parseAvoTrialMetricsOutput,
	parseAvoTrialRunInput,
	requiredAvoPremortemAssumptionCount,
	requiresAvoAdversarialReview,
} from "./avo/index.js";
import { type BashResult, executeBashWithOperations } from "./bash-executor.js";
import {
	COMPACT_SKILL_NAME,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	generateBranchSummary,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./compaction/index.js";
import {
	type ContextTreeNode,
	type ContextWindowResolver,
	computeOwnAndTotalUsage,
	loadContextTreeChildFromDisk,
	loadContextTreeChildrenFromDisk,
} from "./context-tree.js";
import type { AgentCronJob, AgentRlmHeartbeatController, AgentRlmHeartbeatStatusUpdate } from "./cron-jobs.js";
import { normalizeHeartbeatDeliveryMode } from "./cron-jobs.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.js";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.js";
import {
	type ContextUsage,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeRefineResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import {
	createGoalContextMessage,
	emptyGoalState,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTEXT_PREVIEW_LABEL,
	GOAL_SKILL_NAME,
	GOAL_STATE_CUSTOM_TYPE,
	type GoalHostResponse,
	type GoalState,
	type GoalStatus,
	goalHostResponse,
	goalTokenDeltaForUsage,
	isPersistedGoalState,
	normalizeGoalState,
	validateGoalBudget,
	validateGoalObjective,
} from "./goals.js";
import type { HostRequestHandlers, KernelSentAgentMessage } from "./kernel/index.js";
import { type RestoreResult, snapshotPathIn } from "./kernel/state-snapshot.js";
import type { AcpMcpServerConfig } from "./mcp/acp-mcp-types.js";
import type { McpManager } from "./mcp/mcp-manager.js";
import {
	type BashExecutionMessage,
	type CompactionOutcome,
	type CompactionOutcomeReason,
	type CustomMessage,
	convertToLlm,
	createCompactionOutcomeMessage,
	createHeartbeatPromptMessage,
	createRefinementOutcomeMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { throwIfPromptAdmissionCancelled } from "./prompt-admission.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	appendGlobalRefinement,
	applyRefinementProposal,
	generateRefinementId,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	getRefinementHistory,
	type HarnessState,
	inferRefinementResultScope,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
	normalizeRefinementProposal,
	planRefinement,
	REFINE_SKILL_NAME,
	type RefinementPlan,
	type RefinementResult,
	reviewAutoRefine,
	saveHarnessState,
} from "./refinement/index.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createDefaultRlmSubagentSessionName,
	createRlmDeleteSubagentHostHandler,
	createRlmFindModelsHostHandler,
	createRlmListSubagentsHostHandler,
	createRlmRunHostHandler,
	findRlmModelMatches,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	normalizeRequestedRlmSubagentThinkingLevel,
	type RlmDeleteSubagentResult,
	type RlmFindModelsResult,
	type RlmListSubagentsResult,
	type RlmSpawnHandle,
	type RlmSubagentRegistryEntry,
	type RlmSubagentRuntime,
	type SubagentRuntimeHost,
} from "./rlm-runtime.js";
import {
	ActionStore,
	type ActionTicket,
	canSelectSessionAction,
	type DeliveryPolicy,
	type DeliveryRecord,
	type QueuedMessageLane,
	type QueuedMessageMutation,
	type QueuedMessageMutationStatus,
	queuedMessageLaneDeliveryPolicy,
	type RuntimeActivity,
	type SessionAction,
	type SessionActionSnapshot,
	type SessionCommandPayload,
	type SessionTurnPayload,
	transitionSessionAction,
	type WakePolicy,
} from "./session-action-store.js";
import type { BranchSummaryEntry, CompactionEntry, SessionContext, SessionMessageEntry } from "./session-manager.js";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	type SessionHeader,
	SessionManager,
} from "./session-manager.js";
import type { SessionStats } from "./session-stats.js";
import type { SettingsManager } from "./settings-manager.js";
import { getPythonSkillRuntimeInfo, type Skill } from "./skills.js";
import {
	parseRefineCommandOptions,
	parseSessionSlashCommand,
	parseSlashCommand,
	type SessionSlashCommand,
	type SlashCommandInfo,
} from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.js";
import { THINKING_LEVELS } from "./thinking-levels.js";
import {
	type BashOperations,
	createLocalBashOperations,
	createReadOnlyVerificationBashOperations,
} from "./tools/bash.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { IpythonKernelProvisioner } from "./tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR, WEBSEARCH_SKILL_NAME } from "./websearch-credential.js";

export type { GoalState, GoalStatus } from "./goals.js";
export type { SessionStats } from "./session-stats.js";
export { type ParsedSkillBlock, parseSkillBlock } from "./skill-blocks.js";

export type RlmChildAgentStatus = "queued" | "running" | "done" | "error" | "cancelled";

export interface RlmChildAgentActivity {
	kind: "waiting" | "writing" | "executing";
	toolName?: string;
}

export interface RlmChildAgentSnapshot {
	id: string;
	parentId?: string;
	activeSessionId?: string;
	sessionName?: string;
	model?: string;
	label: string;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	toolUseCount?: number;
	tokenCount?: number;
	recap?: string;
	sessionDir: string;
	activity?: RlmChildAgentActivity;
	repliedSinceTask?: boolean;
	error?: string;
}

export type CompactionReason = "manual" | "threshold" | "overflow" | "requested";

export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "ipython_sent_agent_message";
			toolCallId: string;
			message: KernelSentAgentMessage;
	  }
	| { type: "session_action_update"; actions: SessionActionSnapshot }
	| {
			type: "compaction_start";
			reason: CompactionReason;
			customInstructions?: string;
	  }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; serviceTier: ServiceTier }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
	  }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| {
			type: "auth_stale";
			provider: string;
			sourceTokens?: readonly AuthSourceToken[];
	  }
	| { type: "rlm_child_update"; child: RlmChildAgentSnapshot }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| {
			type: "bash_start";
			command: string;
			excludeFromContext: boolean;
			transient?: boolean;
			runId?: string;
	  }
	| { type: "bash_output"; chunk: string }
	| {
			type: "bash_end";
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			fullOutputPath?: string;
			errorMessage?: string;
			transient?: boolean;
			runId?: string;
	  }
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

type UserBashEndDetails = {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	errorMessage?: string;
};

export class CompactionSkippedError extends Error {}

/** Thrown when a session_before_refine extension skips the refinement round. */
export class RefineSkippedError extends Error {}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	serviceTierPreference?: ServiceTier;
	cwd: string;
	agentDir?: string;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	resourceLoader: ResourceLoader;
	customTools?: ToolDefinition[];
	modelRegistry: ModelRegistry;
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	/**
	 * Whether the built-in long-running goals feature is available: the bundled
	 * goal skill in the IPython kernel, its goal.* host handlers, and /goal.
	 * Default: true.
	 */
	includeGoals?: boolean;
	agentMessageController?: AgentSessionMessageController;
	agentObserveController?: AgentObserveController;
	/**
	 * Whether the bundled compact skill and its compact.* host handlers are
	 * available to the model. Default: the compaction.agentCallable setting.
	 */
	includeCompactSkill?: boolean;
	/**
	 * Optional host-side controller for the bundled rlm-heartbeat Python skill.
	 * When omitted, rlm_heartbeat.* host requests are unavailable.
	 */
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	/**
	 * Optional MCP integration manager. When present, its mcp.* host requests
	 * (refresh, begin_login) are exposed to the kernel.
	 */
	mcpManager?: McpManager;
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	extensionRunnerRef?: { current?: ExtensionRunner };
	sessionStartEvent?: SessionStartEvent;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	rlmSessionDir?: string;
	rlmParentNodeId?: string;
	rlmParentAgent?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
	autonomous?: AgentAutonomousConfig;
	prewarmIpythonKernel?: boolean;
	autoRefineReviewer?: AutoRefineReviewer;
	/**
	 * When true, auto-refine runs synchronously between turns at the
	 * shouldStopAfterTurn boundary instead of in the background after
	 * agent_end. Used for print/headless autonomous runs so refinement
	 * never overlaps the primary model request. Default: false.
	 */
	serializedRefine?: boolean;
	/**
	 * Initial goal to seed at session creation. Only applied when rlmDepth
	 * is 0 and no persisted thread_goal_state entry exists in the branch.
	 */
	initialGoal?: { objective: string; tokenBudget?: number };
	/**
	 * Whether AVO variation operator and lifecycle is enabled.
	 * When false, normal root tasks run without being redefined as AVO variation episodes.
	 */
	enableAvo?: boolean;
	/** Enforce the default AVO gate and canonical delivery at root turn completion. Default: true. */
	enforceAvoCompletion?: boolean;
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export interface AutoRefineReviewRequest {
	reason: AutoRefineReason;
	turnsSinceLastReview: number;
}

/**
 * Discriminated result from a serialized-mode background planning pass.
 * - "plan": review approved and planning succeeded; carry the exact plan,
 *   options, and abort controller so the boundary can apply directly
 *   without a second planning request.
 * - "skip": reviewer declined; no refine needed.
 * - "failure": review or planning threw; boundary should not retry.
 */
export type SerializedBackgroundPlanResult =
	| {
			status: "plan";
			plan: RefinementPlan;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			abort: AbortController;
			branchVersion: number;
	  }
	| { status: "skip"; explicit?: boolean }
	| { status: "invalidated"; branchVersion: number }
	| {
			status: "failure";
			explicit: boolean;
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			branchVersion: number;
	  };

export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;

export interface PromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	followUpQueueKey?: string;
	source?: InputSource;
	preflightResult?: (success: boolean, queued?: boolean) => void;
	queueIfBusy?: boolean;
	resumeIfIdle?: boolean;
	internalPrompt?: boolean;
	suppressAutonomousContinuation?: boolean;
	skipInputHandlers?: boolean;
	signal?: AbortSignal;
	admissionCommitted?: () => void;
	agentMessageId?: string;
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
}

interface InternalPromptOptions extends PromptOptions {
	skipPrePromptWork?: boolean;
	returnAfterAccepted?: boolean;
	agentMessageId?: string;
}

type SubmissionExtensionCommandPolicy = "execute" | "reject" | "ignore";

interface SubmissionNormalizationPolicy {
	parseSessionCommands: boolean;
	extensionCommands: SubmissionExtensionCommandPolicy;
	inputSource?: InputSource;
	expandSkills: boolean;
	expandPromptTemplates: boolean;
}

type NormalizedSubmission =
	| { kind: "prompt"; text: string; images?: ImageContent[] }
	| {
			kind: "sessionCommand";
			text: string;
			images?: ImageContent[];
			command: SessionSlashCommand;
	  }
	| { kind: "extensionCommand"; completion: Promise<void> }
	| { kind: "handled" };

type PreTurnCompactionTiming = "beforeModelSelection" | "afterModelSelection" | "skip";
type RefineBarrierPolicy = "always" | "ifInFlight" | "skip";

interface CommitPreparationPolicy {
	initialRefineBarrier: RefineBarrierPolicy;
	flushPendingBashBeforeValidation: boolean;
	validateModelAndAuth: boolean;
	awaitPendingModelSelection: boolean;
	preTurnCompaction: PreTurnCompactionTiming;
	finalRefineBarrier: RefineBarrierPolicy;
}

interface CommitPreparationSteps<TPrepared, TCommitted> {
	afterValidation?: () => void;
	prepare: () => Promise<TPrepared>;
	shouldCommit?: (prepared: TPrepared) => boolean;
	beforeFinalRefineBarrier?: (prepared: TPrepared) => void;
	commit: (prepared: TPrepared, passedFinalRefineBarrier: boolean) => TCommitted;
}

type QueuedAgentMessage = UserMessage | CustomMessage;
type SessionInputSchedule = "steer" | "followUp";

export interface TurnExecutionPolicy {
	preparation: CommitPreparationPolicy;
	runBeforeAgentStart: boolean;
	nextTurnContextTiming: "preparation" | "commit" | "skip";
	preserveEmptyExtensionPrompt: boolean;
	completionIncludesRetryChain: boolean;
}

function turnExecutionPoliciesEqual(left: TurnExecutionPolicy, right: TurnExecutionPolicy): boolean {
	return (
		left.preparation.initialRefineBarrier === right.preparation.initialRefineBarrier &&
		left.preparation.flushPendingBashBeforeValidation === right.preparation.flushPendingBashBeforeValidation &&
		left.preparation.validateModelAndAuth === right.preparation.validateModelAndAuth &&
		left.preparation.awaitPendingModelSelection === right.preparation.awaitPendingModelSelection &&
		left.preparation.preTurnCompaction === right.preparation.preTurnCompaction &&
		left.preparation.finalRefineBarrier === right.preparation.finalRefineBarrier &&
		left.runBeforeAgentStart === right.runBeforeAgentStart &&
		left.nextTurnContextTiming === right.nextTurnContextTiming &&
		left.preserveEmptyExtensionPrompt === right.preserveEmptyExtensionPrompt &&
		left.completionIncludesRetryChain === right.completionIncludesRetryChain
	);
}

interface PreparedTurnPayload extends SessionTurnPayload {
	images?: ImageContent[];
	content?: (TextContent | ImageContent)[];
	customMessage?: CustomMessage;
	prepared?: PreparedPromptPreparation;
	executionPolicy: TurnExecutionPolicy;
	queueVisible: boolean;
	acceptedAgentMessage: boolean;
	acceptedBeforeCompletion: boolean;
	avoObservedRunId?: string;
	captureRunMessages?: Set<AgentMessage>;
	cancelledDispatchEnded?: boolean;
}

interface PreparedCommandPayload extends SessionCommandPayload {
	images?: ImageContent[];
}

type QueuedSessionAction = SessionAction<PreparedTurnPayload | PreparedCommandPayload>;

interface PreparedPromptPreparation {
	result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
	basePromptSnapshot: string;
}

class DeferredSessionInputError extends Error {}

function oncePreflight(
	preflightResult: ((success: boolean, queued?: boolean) => void) | undefined,
): (success: boolean, queued?: boolean) => void {
	let settled = false;
	return (success, queued = false) => {
		if (!settled) {
			settled = true;
			preflightResult?.(success, queued);
		}
	};
}

interface RestoredPromptInput {
	text: string;
	content?: (TextContent | ImageContent)[];
	images?: ImageContent[];
	queueKey?: string;
	agentMessageId?: string;
	customMessage?: CustomMessage;
	prefixMessages?: CustomMessage[];
}

export const SESSION_ACTION_RECOVERY_FORMAT_VERSION = 1;

export interface SessionActionRecoveryRecord {
	id: string;
	role: DeliveryRecord["role"];
	message: QueuedAgentMessage;
	ownerActionId: string;
}

export type SessionActionRecoveryPayload =
	| {
			kind: "turn";
			text: string;
			preview?: string;
			records: SessionActionRecoveryRecord[];
			images?: ImageContent[];
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			executionPolicy: TurnExecutionPolicy;
			queueVisible: boolean;
			acceptedAgentMessage: boolean;
			acceptedBeforeCompletion: boolean;
			avoObservedRunId?: string;
	  }
	| {
			kind: "session_command";
			text: string;
			command: SessionSlashCommand;
			images?: ImageContent[];
	  };

export interface SessionActionRecoveryAction {
	id: string;
	source: InputSource | "internal";
	delivery: DeliveryPolicy;
	wake: WakePolicy;
	payload: SessionActionRecoveryPayload;
	queueKey?: string;
	agentMessageId?: string;
	suppressAutonomousContinuation?: boolean;
}

export interface SessionActionRecoverySnapshot {
	formatVersion: typeof SESSION_ACTION_RECOVERY_FORMAT_VERSION;
	actions: SessionActionRecoveryAction[];
}

function cloneCustomMessage(message: CustomMessage): CustomMessage {
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

function cloneQueuedAgentMessage(message: QueuedAgentMessage): QueuedAgentMessage {
	if (message.role === "custom") return cloneCustomMessage(message);
	return {
		...message,
		content: Array.isArray(message.content) ? message.content.map((block) => ({ ...block })) : message.content,
	};
}

function primaryDeliveryRecord(action: QueuedSessionAction): DeliveryRecord {
	if (action.payload.kind !== "turn") throw new Error(`Session action ${action.id} is not a turn`);
	const record = action.payload.records.find((candidate) => candidate.role === "primary");
	if (!record) throw new Error(`Turn action ${action.id} has no primary delivery record`);
	return record;
}

function normalizeMessageContent(content: string | (TextContent | ImageContent)[]): {
	text: string;
	images?: ImageContent[];
} {
	if (typeof content === "string") return { text: content };
	const text = content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is ImageContent => part.type === "image");
	return { text, ...(images.length > 0 ? { images } : {}) };
}

function queuedAgentMessagePreview(action: QueuedSessionAction): string {
	const payload = action.payload;
	if (payload.kind === "session_command") return payload.text;
	if (payload.customMessage && isAgentSessionMessage(payload.customMessage)) {
		return `${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: ${payload.customMessage.details.message}`;
	}
	return payload.preview ?? payload.text;
}

function visibleSessionActionProjection(actions: readonly QueuedSessionAction[]): readonly QueuedSessionAction[] {
	return actions.filter(
		(action) =>
			action.payload.kind === "session_command" ||
			action.payload.queueVisible ||
			action.payload.acceptedAgentMessage,
	);
}

const IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY = "ipython_sent_agent_message";

interface PersistedIpythonSentAgentMessage {
	toolCallId: string;
	message: KernelSentAgentMessage;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePersistedIpythonSentAgentMessage(value: unknown): PersistedIpythonSentAgentMessage | undefined {
	if (!isObjectRecord(value) || typeof value.toolCallId !== "string" || !isObjectRecord(value.message)) {
		return undefined;
	}
	const { id, message, deliveryStatus, target } = value.message;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued") ||
		!isObjectRecord(target) ||
		typeof target.activeSessionId !== "string" ||
		typeof target.sessionId !== "string"
	) {
		return undefined;
	}
	return {
		toolCallId: value.toolCallId,
		message: {
			id,
			message,
			deliveryStatus,
			target: {
				activeSessionId: target.activeSessionId,
				sessionId: target.sessionId,
				...(typeof target.sessionName === "string" ? { sessionName: target.sessionName } : {}),
			},
		},
	};
}

function appendSentAgentMessageToToolResult(
	message: AgentMessage,
	toolCallId: string,
	sentMessage: KernelSentAgentMessage,
): boolean {
	if (message.role !== "toolResult" || message.toolName !== "ipython" || message.toolCallId !== toolCallId) {
		return false;
	}
	const details = isObjectRecord(message.details) ? message.details : {};
	const current = Array.isArray(details.sentAgentMessages) ? details.sentAgentMessages : [];
	if (current.some((entry) => isObjectRecord(entry) && entry.id === sentMessage.id)) {
		return true;
	}
	message.details = {
		...details,
		sentAgentMessages: [...current, sentMessage],
	};
	return true;
}

function injectedMessagePreviewLabel(message: CustomMessage): string | undefined {
	switch (message.customType) {
		case HEARTBEAT_PROMPT_CUSTOM_TYPE:
			return HEARTBEAT_PROMPT_PREVIEW_LABEL;
		case GOAL_CONTEXT_CUSTOM_TYPE:
			return GOAL_CONTEXT_PREVIEW_LABEL;
		default:
			return undefined;
	}
}

interface AgentMessageDeferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (error: Error) => void;
}

interface AgentMessageOutcome {
	delivery?: AgentMessageDeferred;
	completion?: AgentMessageDeferred;
}

function createAgentMessageDeferred(): AgentMessageDeferred {
	const deferred = {} as AgentMessageDeferred;
	deferred.promise = new Promise<void>((resolve, reject) => {
		deferred.resolve = resolve;
		deferred.reject = reject;
	});
	deferred.promise.catch(() => undefined);
	return deferred;
}

/** One-shot settlement for a scheduled post-compaction continuation; a settled failure is never re-exposed to later waiters. */
interface PostCompactionContinuationSettlement extends AgentMessageDeferred {
	settled: boolean;
}

function createPostCompactionContinuationSettlement(): PostCompactionContinuationSettlement {
	return { ...createAgentMessageDeferred(), settled: false };
}

export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	isScoped: boolean;
}

interface ModelSelectOptions {
	waitForExtensions?: boolean;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

type GoalSlashCommand =
	| { kind: "status" }
	| { kind: "clear" }
	| { kind: "pause" }
	| { kind: "resume" }
	| { kind: "start"; objective: string; tokenBudget?: number };

type AutonomousSlashCommand = { kind: "status" } | { kind: "on" } | { kind: "off" };

import type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./rlm-max-depth.js";

export type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./rlm-max-depth.js";

interface PersistedRlmMaxDepthState {
	maxDepth: number;
}

type AutonomousRuntimeSnapshot = Pick<
	AutonomousRuntimeState,
	"continuationsUsed" | "gateAttempts" | "lastGateFailure" | "lastGateFailureSnapshot"
>;

interface RlmChildRun {
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<Api>;
	status: RlmChildAgentStatus;
	error?: string;
	abort: () => void;
	publication: AgentMessageDeferred;
	/** Resolves after terminal result publication and detached-run cleanup finish. */
	settlement: AgentMessageDeferred;
	/** Child session, once its runtime exists. Used to cancel nested child runs. */
	session?: AgentSession;
	settled: boolean;
	/** Do not inject a late terminal notice after the parent session is aborted. */
	suppressTerminalNotice?: boolean;
	/** Excluded from future strong barriers after an authoritative cancellation cut. */
	abandonedForQuiescence?: boolean;
	/** Selector snapshot for an admitted explicit delete. */
	detachedDeletion?: RlmSubagentRegistryEntry;
	/** Shared physical runtime cleanup owned by the explicit-delete path. */
	deletionCleanup?: Promise<void>;
	deletionCleanupObserver?: Promise<boolean>;
	/** Resolves when a deletion may release its selector reservation. */
	deletionReservation: AgentMessageDeferred;
	deletionCleanupFailed?: boolean;
	deletionRunFinished?: boolean;
	deletionNotice?: Promise<void>;
	deletionNeedsCompletionNotice?: boolean;
	completeDeletion?: () => Promise<void>;
	reportDeletionCleanupFailure?: (error: unknown) => Promise<void>;
	emitUpdate?: () => void;
	unsubscribe?: () => void;
}

interface RlmSubagentModelSelection {
	model: Model<Api>;
}

const KERNEL_STATE_LISTING_TIMEOUT_MS = 5000;
const RLM_MAX_DEPTH_STATE_CUSTOM_TYPE = "rlm_max_depth_state";

function noopRlmChildAbort(): void {}
function noopRlmChildEventUnsubscribe(): void {}

function autoRefineInstructions(reason: AutoRefineReason, review: AutoRefineReview): string {
	const detail = review.instructions
		? `
Reviewer instructions: ${review.instructions}`
		: "";
	return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${detail}`;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseDepth(value: string | undefined, fallback: number, name: string): number {
	if (value === undefined || value === "") {
		return fallback;
	}
	if (!/^\d+$/.test(value)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	const parsed = Number(value);
	if (!isNonNegativeInteger(parsed)) {
		throw new Error(`${name} must be a non-negative integer`);
	}
	return parsed;
}

function isPersistedRlmMaxDepthState(value: unknown): value is PersistedRlmMaxDepthState {
	return (
		typeof value === "object" && value !== null && isNonNegativeInteger((value as PersistedRlmMaxDepthState).maxDepth)
	);
}

function parseGoalBudgetValue(value: string): number {
	if (!/^[1-9]\d*$/.test(value)) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	const budget = validateGoalBudget(Number(value));
	if (budget === undefined) {
		throw new Error("Goal token budget must be a positive integer.");
	}
	return budget;
}

export function compactRlmText(text: string, maxLength = 160): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= maxLength) {
		return compact;
	}
	return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

// Child-agent label: collapse to one line but keep the full prompt — the TUI
// truncates to the visible width and elides shared prefixes, so capping here
// would only hide the divergence between near-identical sibling prompts.
export function rlmChildLabel(prompt: string): string {
	return prompt.replace(/\s+/g, " ").trim() || "child agent";
}

function readAssistantText(message: AssistantMessage): string {
	return message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function readAvoAssistantDeliveryText(message: AssistantMessage): string {
	return message.content
		.filter((block) => {
			if (block.type !== "text") return false;
			if (!isObjectRecord(block.providerMetadata)) return true;
			return !isObjectRecord(block.providerMetadata.googleSearchGrounding);
		})
		.map((block) => (block.type === "text" ? block.text : ""))
		.join("");
}

function parseAvoCanonicalDeliveryBinding(value: unknown): AvoCanonicalDeliveryBinding | undefined {
	if (!isObjectRecord(value)) return undefined;
	const { runId, candidateId, cycleId, deliveryDigest, stateVersion } = value;
	if (
		typeof runId !== "string" ||
		!runId ||
		typeof candidateId !== "string" ||
		!candidateId ||
		typeof cycleId !== "string" ||
		!cycleId ||
		typeof deliveryDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(deliveryDigest) ||
		typeof stateVersion !== "number" ||
		!Number.isSafeInteger(stateVersion) ||
		stateVersion < 0
	) {
		return undefined;
	}
	return { runId, candidateId, cycleId, deliveryDigest, stateVersion };
}

function matchesAvoCanonicalDeliveryBinding(
	value: unknown,
	expected: AvoCanonicalDeliveryBinding,
): value is AvoCanonicalDeliveryBinding {
	const actual = parseAvoCanonicalDeliveryBinding(value);
	return (
		actual !== undefined &&
		actual.runId === expected.runId &&
		actual.candidateId === expected.candidateId &&
		actual.cycleId === expected.cycleId &&
		actual.deliveryDigest === expected.deliveryDigest &&
		actual.stateVersion === expected.stateVersion
	);
}

function captureAvoCanonicalDeliveryGeneration(state: AvoRunState): AvoCanonicalDeliveryBinding | undefined {
	if (state.status !== "active" || (state.delivery.phase !== "accepted" && state.delivery.phase !== "pending")) {
		return undefined;
	}
	return parseAvoCanonicalDeliveryBinding({
		...state.delivery,
		stateVersion: state.delivery.phase === "pending" ? state.delivery.stateVersion : state.stateVersion,
	});
}

function matchesAvoCanonicalDeliveryGeneration(
	state: AvoRunState,
	expected: AvoCanonicalDeliveryBinding,
	expectedPhase: "accepted" | "pending",
): boolean {
	return (
		state.status === "active" &&
		state.delivery.phase === expectedPhase &&
		matchesAvoCanonicalDeliveryBinding(captureAvoCanonicalDeliveryGeneration(state), expected)
	);
}

export function extractMarkedPersistedAgentMessage(details: unknown, marker: string): string | undefined {
	if (!isObjectRecord(details) || details.status !== "ok" || !Array.isArray(details.sentAgentMessages)) {
		return undefined;
	}
	for (const value of [...details.sentAgentMessages].reverse()) {
		if (!isObjectRecord(value) || !isObjectRecord(value.target)) continue;
		if (
			typeof value.id !== "string" ||
			!value.id.startsWith("agentmsg_") ||
			typeof value.message !== "string" ||
			!value.message.includes(marker) ||
			(value.deliveryStatus !== "queued" && value.deliveryStatus !== "delivered") ||
			value.receiverRole !== "parent" ||
			typeof value.target.activeSessionId !== "string" ||
			typeof value.target.sessionId !== "string"
		) {
			continue;
		}
		return value.message;
	}
	return undefined;
}

function waitForPromiseOrAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal | undefined,
	abortMessage: string,
): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(new Error(abortMessage));
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			cleanup();
			reject(new Error(abortMessage));
		};
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		signal.addEventListener("abort", onAbort, { once: true });
		// Close the listener-registration race before observing the awaited work.
		if (signal.aborted) return onAbort();
		promise.then(
			(value) => {
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

/** Maximum time graceful disposal waits for an in-flight refinement before aborting it. */
export const REFINEMENT_DISPOSAL_GRACE_MS = 5_000;
/** Hard upper bound for disposeAsync(); expiry forces synchronous teardown and rejects. */
export const SESSION_DISPOSAL_TIMEOUT_MS = 30_000;

const DEFAULT_AUTORESEARCH_SUPERVISOR_TIMEOUT_MS = 60_000;
const MAX_AUTORESEARCH_SUPERVISOR_TIMEOUT_MS = 300_000;

function parseAutoresearchSupervisorTimeoutMs(value: unknown): number {
	if (value === undefined) return DEFAULT_AUTORESEARCH_SUPERVISOR_TIMEOUT_MS;
	if (
		!Number.isInteger(value) ||
		(value as number) < 1 ||
		(value as number) > MAX_AUTORESEARCH_SUPERVISOR_TIMEOUT_MS
	) {
		throw new Error(
			`autoresearch supervisor_timeout_ms must be an integer from 1 to ${MAX_AUTORESEARCH_SUPERVISOR_TIMEOUT_MS}`,
		);
	}
	return value as number;
}

function attributeChildUsage(parentUsage: Usage, childUsage: Usage): void {
	const parentContextTokens =
		parentUsage.totalTokens ||
		parentUsage.input + parentUsage.output + parentUsage.cacheRead + parentUsage.cacheWrite;
	// Recursive children are launched from an assistant tool call, so the parent assistant
	// message carries their billable usage for session-level cost totals.
	addAssistantUsage(parentUsage, childUsage);
	// Child work affects session-level billable totals, not the parent's model-facing context size.
	parentUsage.totalTokens = parentContextTokens;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private _serviceTierPreference: ServiceTier;

	private _scopedModels: Array<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}>;

	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _lastSessionActionSnapshot: SessionActionSnapshot = {
		queuedCount: 0,
		steering: [],
		followUps: [],
	};
	private _agentEventQueue: Promise<void> = Promise.resolve();

	/** Session-owned actions. Items are never fed into Agent.steer/followUp. */
	private readonly _actionStore = new ActionStore<QueuedSessionAction>();
	private _sessionInputPump: Promise<void> = Promise.resolve();
	private _sessionInputPumpRequested = false;
	// Invalidates preparation when a branch pause starts and finishes before its next await resumes.
	private _sessionInputPumpEpoch = 0;
	private _sessionInputArrivalEpoch = 0;
	// Persists abort/restart suspension after the initiating call returns.
	private _sessionInputPumpSuspended = false;
	private _sessionInputSuspendedForUpdateRestart = false;
	// Branch mutation pause leases can overlap and must all release before dispatch resumes.
	private readonly _queuedWorkPauses = new Set<symbol>();
	private readonly _sessionInputAdmissionPauses = new Set<symbol>();
	private readonly _durableRlmTerminalNoticeActionIds = new Set<string>();
	private _sessionActionCommitTail: Promise<void> = Promise.resolve();
	private _sessionActionCommitOwner: symbol | undefined;
	private _pendingSessionActionFenceWaiters = 0;
	private readonly _sessionActionCommitContext = new AsyncLocalStorage<symbol>();
	private readonly _sessionActionCommitDisposeAbortController = new AbortController();
	// Checkpoint and handoff waiters share lifecycle-edge notifications to avoid polling.
	private readonly _sessionInputCheckpointWaiters = new Set<() => void>();
	private _pendingNextTurnMessages: CustomMessage[] = [];

	private _goalState: GoalState = emptyGoalState();
	private _goalAccountingStartedAt: number | undefined = undefined;
	private _goalContinuationAwaitsRlmWork = false;
	private _goalAccountedAssistantMessages = new WeakSet<AssistantMessage>();
	private _goalAbortInProgress = false;
	private _autonomousState: AutonomousRuntimeState;
	private _autonomousContinuationSuppressionDepth = 0;
	private _autonomousContinuationSuppressedMessages = new WeakSet<AgentMessage>();

	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _compactionOperation: Promise<void> | undefined = undefined;
	/** One recovery attempt per overflow; "reported" dedups the failure notice. */
	private _overflowRecovery: "idle" | "attempted" | "reported" = "idle";
	private _continueAfterThresholdCompaction = false;
	private _pendingRequestedCompaction: { customInstructions?: string } | undefined;
	private _pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;

	private _branchSummaryAbortController: AbortController | undefined = undefined;
	private _branchSummaryOperation: Promise<void> | undefined = undefined;

	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _retryAuthFailureSources: AuthSourceToken[] = [];
	private _agentMessageOutcomes = new Map<string, AgentMessageOutcome>();
	private _lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	/** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
	private readonly _unpersistedOutcomes: CustomMessage[] = [];

	private _bashAbortController: AbortController | undefined = undefined;
	private _userBashRunning = false;
	private _userBashAbortRequested = false;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	private _extensionRunner!: ExtensionRunner;
	private _execEnvProvider?: () => Record<string, string | undefined> | undefined;
	private _turnIndex = 0;
	private _modelSelectEmitQueue: Promise<void> = Promise.resolve();
	private _modelSelectEmitQueueIdle = true;
	private _modelSelectEmitContext = new AsyncLocalStorage<boolean>();

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir?: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _includeGoals: boolean;
	private _includeCompactSkill: boolean;
	private _rlmHeartbeatController?: AgentRlmHeartbeatController;
	private _agentMessageController?: AgentSessionMessageController;
	private _agentObserveController?: AgentObserveController;
	private _avoRuntime?: AvoSessionRuntime;
	private _avoMemoryContext = "";
	private readonly _enforceAvoCompletion: boolean;
	private readonly _avoProgressWatchdog = new AvoProgressWatchdog();
	private readonly _avoProgressWatchdogAssessments = new WeakMap<object, AvoProgressWatchdogAssessment>();
	private _avoToolProgressRunId?: string;
	private _avoToolProgressToken?: string;
	private _avoToolNoProgressBatches = 0;
	private _avoToolInterventionQueued = false;
	private _avoToolInterventionCount = 0;
	private _avoToolLastInterventionBatch = 0;
	private _avoCanonicalDeliverySerializer: Promise<void> = Promise.resolve();
	private _avoCanonicalDeliveryQueuedRunId?: string;
	private _avoCanonicalDeliveryQueuedBinding?: AvoCanonicalDeliveryBinding;
	private _avoCanonicalDeliveryDirectBinding?: AvoCanonicalDeliveryBinding;
	private _avoCanonicalDeliveryAttemptBinding?: AvoCanonicalDeliveryBinding;
	private readonly _avoCanonicalDeliveryClosedRunIds = new Set<string>();
	/**
	 * A delivery failure is terminal for one AVO run. Keep this session-local
	 * latch in addition to the persisted store phase so a malformed canonical
	 * response or invariant failure cannot re-enter the completion repair loop
	 * while its durable failure record is being surfaced.
	 */
	private readonly _avoCanonicalDeliveryFailedRunIds = new Set<string>();
	private _avoSupervisorBoundToRuntime = false;
	private _autoresearchStore?: AutoresearchStore;
	private _autoresearchSupervisorBoundToRuntime = false;
	private _mcpManager?: McpManager;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _disposed = false;
	private readonly _disposeCallbacks = new Set<() => void | Promise<void>>();
	private _disposeCallbacksPromise?: Promise<void>;
	// Set at the start of async teardown so a child finishing mid-disposeAsync doesn't
	// re-populate the retained map after it's been cleared.
	private _disposing = false;
	private _disposeAsyncPromise?: Promise<void>;
	private _ipythonKernelProvisioner?: IpythonKernelProvisioner;
	/** Artifact dir backing the current provisioner's kernel snapshot, if any. */
	private _ipythonKernelSnapshotDir?: string;
	/** True once the runtime has been built once; later builds are in-process rebuilds (/reload). */
	private _ipythonRuntimeBuilt = false;
	private readonly _prewarmIpythonKernel: boolean;
	private _rlmDepth: number;
	private readonly _configuredRlmMaxDepth: number | undefined;
	private _rlmMaxDepth: number;
	private _rlmMaxDepthSource: RlmMaxDepthSource;
	private _rlmSessionDir?: string;
	private _rlmParentNodeId?: string;
	private _rlmParentAgent?: string;
	private _repliedToParentSinceTask: boolean | undefined;
	private _parentReplyCount = 0;
	private _subagentRuntimeHost?: SubagentRuntimeHost;
	private _activeRlmChildRuns = new Map<string, RlmChildRun>();
	private _unsettledRlmChildRuns = new Set<RlmChildRun>();
	private _abandonedRlmQuiescenceChildIds = new Set<string>();
	private _rlmQuiescenceWaitAborts = new Set<AbortController>();
	private _pendingRlmSubagentSessionNames = new Set<string>();
	// Inline mode keeps finished child sessions so the inspector can still read them;
	// the daemon does the same by leaving the child session resident in its registry.
	private _rlmChildSessions = new Map<string, AgentSession>();
	private _deletedRlmChildIds = new Set<string>();
	// Failed explicit deletes stay hidden from listings but retain their original
	// selector so a later delete can retry cleanup without orphaning the runtime.
	private _rlmChildCleanupFailures = new Map<string, RlmSubagentRegistryEntry>();
	private _deletingRlmChildren = new Map<
		string,
		{
			subagent: RlmSubagentRegistryEntry;
			promise: Promise<RlmDeleteSubagentResult>;
		}
	>();
	// Kept alive for retained children so nested updates (e.g. a grandchild cancel)
	// still forward to root; torn down when the retained child is disposed.
	private _rlmChildUnsubscribes = new Map<string, () => void>();
	/** Latest recap for this session, written by the daemon summarizer; read by a parent to label its child snapshots. */
	private _currentRecap?: string;

	private _modelRegistry: ModelRegistry;

	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _assistantTurnsSinceAutoRefine = 0;
	private _lastAutoRefineReviewAt = 0;
	private _autoRefineInProgress = false;
	private readonly _autoRefineOperations = new Set<Promise<void>>();
	private readonly _scheduledAutoRefineTimers = new Set<ReturnType<typeof setTimeout>>();
	private _compactAutoRefinePending = false;
	private _turnIntervalAutoRefinePending = false;
	private _postCompactionContinuationScheduled = false;
	private _postCompactionContinuationTimer: ReturnType<typeof setTimeout> | undefined;
	private _postCompactionContinuationSettlement: PostCompactionContinuationSettlement | undefined;
	private _postCompactionContinuationMessages: AgentMessage[] = [];
	private _scheduledPostCompactionContinuationMessages: AgentMessage[] = [];
	private _queuedAutonomousThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedAutonomousContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionAutonomousMessages: AgentMessage[] = [];
	private _queuedGoalThresholdContinuation: AgentMessage | undefined;
	private _pendingAutoRefineReview: { reason: AutoRefineReason; review: AutoRefineReview } | undefined;
	private _autoRefineBranchVersion = 0;
	private _autoRefineReviewAbort?: AbortController;
	private _refineAbortController?: AbortController;
	private readonly _autoRefineReviewer?: AutoRefineReviewer;
	private readonly _serializedRefine: boolean;
	private _refineInFlight?: Promise<void>;
	private _refinePlanInFlight?: Promise<void>;
	private _serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
	private _serializedPlanClaim?: Promise<void>;
	private _serializedExplicitRefineOptions?: {
		instructions?: string;
		global?: boolean;
	};

	constructor(config: AgentSessionConfig) {
		assertAvoSpecReceiptTrustConfiguration(process.env);
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._serviceTierPreference = config.serviceTierPreference ?? config.agent.state.serviceTier;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir;
		this._modelRegistry = config.modelRegistry;
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._includeGoals = config.includeGoals ?? true;
		this._includeCompactSkill = config.includeCompactSkill ?? this.settingsManager.getCompactionAgentCallable();
		this._rlmHeartbeatController = config.rlmHeartbeatController;
		this._agentMessageController = config.agentMessageController;
		this._agentObserveController = config.agentObserveController;
		this._mcpManager = config.mcpManager;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		const headerRlmDepth = this.sessionManager.getHeader()?.rlmDepth;
		this._rlmDepth =
			config.rlmDepth ??
			(isNonNegativeInteger(headerRlmDepth) ? headerRlmDepth : parseDepth(process.env.RLM_DEPTH, 0, "RLM_DEPTH"));
		this._configuredRlmMaxDepth = config.rlmMaxDepth;
		if (this._configuredRlmMaxDepth !== undefined && !isNonNegativeInteger(this._configuredRlmMaxDepth)) {
			throw new Error("rlmMaxDepth must be a non-negative integer");
		}
		const resolvedRlmMaxDepth = this._resolveRlmMaxDepth();
		this._rlmMaxDepth = resolvedRlmMaxDepth.maxDepth;
		this._rlmMaxDepthSource = resolvedRlmMaxDepth.source;
		const avoActive =
			this._rlmDepth === 0 &&
			config.enableAvo !== false &&
			(config.enableAvo === true ||
				config.enforceAvoCompletion === true ||
				process.env.PRIME_ENABLE_AVO === "true" ||
				process.env.PRIME_ENABLE_AVO === "1");

		this._avoRuntime = avoActive
			? new AvoSessionRuntime(
					this.sessionManager.getSessionArtifactDir(),
					this.sessionManager.getSessionId(),
					undefined,
					this._cwd,
					this._agentDir ?? getAgentDir(),
					undefined,
					this._avoWorkspaceExcludedRoots(),
				)
			: undefined;
		this._enforceAvoCompletion = avoActive && (config.enforceAvoCompletion ?? config.enableAvo === true);
		this._autoresearchStore =
			this._rlmDepth === 0
				? new AutoresearchStore(this.sessionManager.getSessionArtifactDir(), undefined, this._cwd)
				: undefined;
		this._prewarmIpythonKernel = (config.prewarmIpythonKernel ?? false) && this._rlmDepth === 0;
		this._autoRefineReviewer = config.autoRefineReviewer;
		this._serializedRefine = config.serializedRefine ?? false;
		this._rlmSessionDir = config.rlmSessionDir;
		this._rlmParentNodeId = config.rlmParentNodeId;
		this._rlmParentAgent = config.rlmParentAgent;
		// A resumed child may have replied before this process started; false would
		// claim knowledge that is not present in the session transcript.
		this._repliedToParentSinceTask =
			this._rlmDepth > 0 && this.sessionManager.getBranch().some((entry) => entry.type === "message")
				? undefined
				: false;
		this._subagentRuntimeHost = config.subagentRuntimeHost;
		this._autonomousState = createAutonomousRuntimeState(config.autonomous, {
			cwd: this._cwd,
		});
		this._goalState = this._loadPersistedGoalState();
		// Seed initial goal from CLI --goal flag, but only for top-level sessions
		// and only when the branch contains only bootstrap entry types (model_change,
		// thinking_level_change, service_tier_change) and no persisted
		// thread_goal_state. This prevents reseeding after clear/complete/error
		// or restart/rehydration of a session that already has messages or a goal.
		if (this._rlmDepth === 0 && config.initialGoal && this._isBranchSeedable()) {
			this._goalState = this._startGoal(config.initialGoal.objective, config.initialGoal.tokenBudget);
			// Goal context is the model's only source of goal visibility; action
			// admission is unavailable mid-construction, so ride the next turn.
			this._pendingNextTurnMessages.push(createGoalContextMessage(this._goalState, "continuation"));
		}
		this._restoreLateIpythonSentAgentMessages();
		if (this._goalState.status === "active") {
			this._goalAccountingStartedAt = Date.now();
		}

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnHook();
		this._installAgentContinuationHook();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		if (this._pendingAvoCanonicalDelivery()) {
			// Close the crash window between persisting DELIVERY_PENDING and
			// enqueueing its sole admissible provider request. Recovery must not
			// depend on a new user prompt arriving after process restart.
			if (!this._completePersistedAvoCanonicalDeliveryIfPresent()) {
				const providerFailure = this._persistedAvoCanonicalDeliveryProviderFailure();
				if (
					!providerFailure ||
					!this._completeAvoCanonicalDeliveryFromHostFallback(providerFailure.message, providerFailure.binding)
				) {
					this._ensurePersistedAvoCanonicalDeliveryActionLocked();
					setTimeout(() => {
						if (!this._disposed && !this._disposing && this._pendingAvoCanonicalDelivery()) {
							this._scheduleSessionInputPump();
						}
					}, 0);
				}
			}
		} else if (this._isAvoCanonicalDeliveryTerminalFailure()) {
			// A persisted terminal failure owns the old run just as strictly as
			// DELIVERY_PENDING. Drop any restored internal continuation before the
			// input pump can re-enter the provider or a tool on process restart.
			this._closeAvoCanonicalDeliveryBackgroundWork();
			this._clearQueuedAutonomousContinuations();
			this._clearQueuedGoalContexts();
			this._fenceAvoCanonicalDeliveryInputs();
		}
	}

	/** Refreshes MCP provider registrations without rebuilding the session runtime. */
	refreshMcpProviders(): void {
		this._mcpManager?.refresh();
	}

	/** Whether AVO variation operator and lifecycle is enabled in this session. */
	get isAvoEnabled(): boolean {
		return this._avoRuntime !== undefined;
	}

	/**
	 * Set the RLM heartbeat controller after construction. Used by
	 * print/headless mode to attach an in-process heartbeat scheduler
	 * when the session is created outside the daemon.
	 */
	setRlmHeartbeatController(controller: AgentRlmHeartbeatController): void {
		if (this._rlmHeartbeatController === controller) {
			return;
		}
		this._rlmHeartbeatController = controller;
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			includeAllExtensionTools: true,
		});
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	replaceAcpMcpServers(servers: readonly AcpMcpServerConfig[], ownerId: string): void {
		if (this.isStreaming) throw new Error("Cannot replace ACP MCP servers while the agent is running");
		if (!this._mcpManager) {
			if (servers.length > 0) throw new Error("MCP is unavailable in this session");
			return;
		}
		if (!this._mcpManager.replaceAcpServers(servers, ownerId)) return;
		this._rebuildRuntimeForAcpMcpServers();
	}

	async releaseAcpMcpServers(ownerId: string, serverNames: readonly string[]): Promise<void> {
		if (!this._mcpManager?.canReleaseAcpServers(ownerId)) return;
		if (this._mcpManager.replaceAcpServers([], ownerId)) {
			// Host MCP handlers read this manager dynamically, so credentials disappear
			// before the kernel-side transport is closed.
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
		const names = [...new Set(serverNames)];
		if (names.length === 0) return;

		const inputPause = this.acquireSessionInputPause();
		try {
			// Do not rebuild or kill the notebook. Wait for the current turn, then ask
			// the kernel-owned MCP registry to close only these cached transports.
			await this.agent.waitForIdle();
			await this._agentEventQueue;
			const manager = this._ipythonKernelProvisioner?.manager;
			if (!manager?.isRunning) return;
			const code = [
				"import importlib as _prime_importlib",
				'_prime_mcp = _prime_importlib.import_module("rlm.mcp")',
				`_prime_mcp_names = ${JSON.stringify(names)}`,
				"_prime_mcp_errors = []",
				"for _prime_mcp_name in _prime_mcp_names:",
				"    try:",
				"        await _prime_mcp.reload(_prime_mcp_name)",
				"    except BaseException as _prime_mcp_error:",
				"        _prime_mcp_errors.append(_prime_mcp_error)",
				"if _prime_mcp_errors:",
				"    raise _prime_mcp_errors[0]",
				"del _prime_mcp, _prime_importlib, _prime_mcp_names, _prime_mcp_errors, _prime_mcp_name",
			].join("\n");
			const result = await manager.execute(code);
			if (result.status !== "ok") {
				throw new Error(`Failed to close ACP MCP kernel transports: ${result.stderr || "kernel error"}`);
			}
		} finally {
			inputPause.release();
		}
	}

	private _rebuildRuntimeForAcpMcpServers(): void {
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			includeAllExtensionTools: true,
		});
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this._subagentRuntimeHost = host;
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		apiKey: string;
		headers?: Record<string, string>;
	}> {
		const result = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!result.ok) {
			if (result.error.startsWith("No API key found")) {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw new Error(result.error);
		}
		if (result.apiKey) {
			return { apiKey: result.apiKey, headers: result.headers };
		}

		const isOAuth = this._modelRegistry.isUsingOAuth(model);
		if (isOAuth) {
			throw new Error(formatAuthenticationFailedMessage(model.provider));
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			await this._agentEventQueue;
			const pendingDelivery = this._pendingAvoCanonicalDelivery();
			if (pendingDelivery) {
				return {
					block: true,
					reason: `AVO_CANONICAL_DELIVERY_PENDING run_id=${pendingDelivery.runId} candidate_id=${pendingDelivery.candidateId ?? "unknown"}: tool execution is closed; return only the exact canonical delivery.`,
				};
			}
			if (this._isAvoCanonicalDeliveryTerminalFailure()) {
				const failedState = this._avoRuntime?.getState();
				return {
					block: true,
					reason: `AVO_CANONICAL_DELIVERY_FAILED run_id=${failedState?.runId ?? "unknown"}: tool execution is closed for the terminal run; submit a new user task to start fresh.`,
				};
			}
			const contractViolationReason = this._avoPythonContractViolationReason(toolCall.name, args);
			if (contractViolationReason) return { block: true, reason: contractViolationReason };
			const probationReason = this._avoToolProbationReason(toolCall.name, args);
			if (probationReason) return { block: true, reason: probationReason };

			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_result")) {
				return undefined;
			}

			const hookResult = await runner.emitToolResult({
				type: "tool_result",
				toolName: toolCall.name,
				toolCallId: toolCall.id,
				input: args as Record<string, unknown>,
				content: result.content,
				details: result.details,
				isError,
			});

			if (!hookResult) {
				return undefined;
			}

			return {
				content: hookResult.content,
				details: hookResult.details,
				isError: hookResult.isError ?? isError,
			};
		};
	}

	private _installAgentContinuationHook(): void {
		this.agent.getContinuationMessages = (context, signal) => this._getContinuationMessages(context, signal);
	}

	private _installAgentTurnHook(): void {
		this.agent.shouldStopBeforeTurn = () => this._shouldStopBeforeTurn();
		this.agent.shouldStopAfterTurn = (context) => this._shouldStopAfterTurn(context);
	}

	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			try {
				l(event);
			} catch {
				// A failing observer must not prevent other subscribers from
				// receiving lifecycle and persistence events.
			}
		}
	}

	private _emitQueueUpdate(): void {
		const actions = this.getSessionActionSnapshot();
		if (JSON.stringify(actions) === JSON.stringify(this._lastSessionActionSnapshot)) return;
		this._lastSessionActionSnapshot = actions;
		this._emit({ type: "session_action_update", actions });
	}

	private _restoreLateIpythonSentAgentMessages(): void {
		this._lateIpythonSentAgentMessages.clear();
		for (const entry of this.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY) {
				continue;
			}
			const persisted = parsePersistedIpythonSentAgentMessage(entry.data);
			if (persisted) {
				this._rememberLateIpythonSentAgentMessage(persisted.toolCallId, persisted.message);
			}
		}
	}

	private _rememberLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): boolean {
		const messages = this._lateIpythonSentAgentMessages.get(toolCallId) ?? [];
		const isNew = !messages.some((entry) => entry.id === message.id);
		if (isNew) {
			messages.push(message);
			this._lateIpythonSentAgentMessages.set(toolCallId, messages);
		}
		for (let index = this.agent.state.messages.length - 1; index >= 0; index -= 1) {
			if (appendSentAgentMessageToToolResult(this.agent.state.messages[index], toolCallId, message)) {
				break;
			}
		}
		return isNew;
	}

	private _applyLateIpythonSentAgentMessages(message: AgentMessage): void {
		if (message.role !== "toolResult" || message.toolName !== "ipython") {
			return;
		}
		for (const sentMessage of this._lateIpythonSentAgentMessages.get(message.toolCallId) ?? []) {
			appendSentAgentMessageToToolResult(message, message.toolCallId, sentMessage);
		}
	}

	private _recordLateIpythonSentAgentMessage(toolCallId: string, message: KernelSentAgentMessage): void {
		const record = () => {
			if (this._disposed || !this._rememberLateIpythonSentAgentMessage(toolCallId, message)) {
				return;
			}
			this.sessionManager.appendCustomEntry(IPYTHON_SENT_AGENT_MESSAGE_CUSTOM_ENTRY, { toolCallId, message });
			this._emit({ type: "ipython_sent_agent_message", toolCallId, message });
		};
		this._agentEventQueue = this._agentEventQueue.then(record, record);
		this._agentEventQueue.catch(() => {});
	}

	private _emitGoalUpdate(): void {
		this._emit({ type: "goal_update", goal: this.goalState });
	}

	private _loadPersistedRlmMaxDepthState(): PersistedRlmMaxDepthState | undefined {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === RLM_MAX_DEPTH_STATE_CUSTOM_TYPE &&
				isPersistedRlmMaxDepthState(entry.data)
			) {
				return entry.data;
			}
		}
		return undefined;
	}

	private _resolveRlmMaxDepth(): {
		maxDepth: number;
		source: RlmMaxDepthSource;
	} {
		const persisted = this._loadPersistedRlmMaxDepthState();
		if (persisted) {
			return { maxDepth: persisted.maxDepth, source: "chat" };
		}
		if (this._configuredRlmMaxDepth !== undefined) {
			return { maxDepth: this._configuredRlmMaxDepth, source: "inherited" };
		}
		const global = this.settingsManager.getRlmMaxDepth();
		if (global !== undefined && isNonNegativeInteger(global)) {
			return { maxDepth: global, source: "global" };
		}
		const env = process.env.RLM_MAX_DEPTH;
		if (env !== undefined && env !== "") {
			return { maxDepth: parseDepth(env, 1, "RLM_MAX_DEPTH"), source: "env" };
		}
		return { maxDepth: 2, source: "default" };
	}

	private _loadPersistedGoalState(): GoalState {
		const branch = this.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (
				entry.type === "custom" &&
				entry.customType === GOAL_STATE_CUSTOM_TYPE &&
				isPersistedGoalState(entry.data)
			) {
				return normalizeGoalState(entry.data);
			}
		}
		return emptyGoalState();
	}

	/**
	 * Whether the session branch is seedable for an initial goal. Returns true
	 * only when the branch contains exclusively bootstrap entry types
	 * (model_change, thinking_level_change, service_tier_change) and no
	 * thread_goal_state custom entry. Any message, custom entry, or persisted
	 * goal (including cleared/complete/error) means the session has been used
	 * and should not be reseeded.
	 */
	private _isBranchSeedable(): boolean {
		const branch = this.sessionManager.getBranch();
		for (const entry of branch) {
			switch (entry.type) {
				case "model_change":
				case "thinking_level_change":
				case "service_tier_change":
					continue;
				case "custom":
					if (entry.customType === GOAL_STATE_CUSTOM_TYPE) {
						return false;
					}
					return false;
				default:
					return false;
			}
		}
		return true;
	}

	private _reloadGoalStateFromBranch(): void {
		this._goalState = this._loadPersistedGoalState();
		this._goalAccountingStartedAt = this._goalState.status === "active" ? Date.now() : undefined;
		this._emitGoalUpdate();
	}

	private _reloadRlmMaxDepthFromBranch(): void {
		const previousMaxDepth = this._rlmMaxDepth;
		const resolved = this._resolveRlmMaxDepth();
		this._rlmMaxDepth = resolved.maxDepth;
		this._rlmMaxDepthSource = resolved.source;
		if (resolved.maxDepth !== previousMaxDepth) {
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
		}
	}

	private _persistGoalState(goal: GoalState): void {
		this.sessionManager.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
		// Force flush so the goal state is durable on disk immediately,
		// even before the first assistant response. This ensures idempotent
		// restart/rehydration can detect the persisted goal.
		this.sessionManager.flushNow();
	}

	private _setGoalState(next: GoalState, options: { persist?: boolean } = {}): void {
		const normalized = normalizeGoalState({
			...next,
			updatedAt: Date.now(),
		});
		this._goalState = normalized;
		if (normalized.status === "active") {
			this._goalAccountingStartedAt ??= Date.now();
		} else {
			this._goalAccountingStartedAt = undefined;
		}
		if (options.persist !== false) {
			this._persistGoalState(normalized);
		}
		this._emitGoalUpdate();
	}

	private _goalWithCurrentWallClock(now = Date.now()): GoalState {
		if (this._goalState.status !== "active" || !this._goalAccountingStartedAt) {
			return this._goalState;
		}
		const elapsedSeconds = Math.floor((now - this._goalAccountingStartedAt) / 1000);
		if (elapsedSeconds <= 0) {
			return this._goalState;
		}
		return {
			...this._goalState,
			timeUsedSeconds: this._goalState.timeUsedSeconds + elapsedSeconds,
		};
	}

	private _goalWithAccountedWallClock(): GoalState {
		const now = Date.now();
		const goal = this._goalWithCurrentWallClock(now);
		if (goal !== this._goalState) {
			this._goalAccountingStartedAt = now;
		}
		return goal;
	}

	private _cancelSessionActions(
		predicate: (action: QueuedSessionAction) => boolean,
		error: Error,
		candidates = this._actionStore.clearableActions(),
	): QueuedSessionAction[] {
		const matching = candidates.filter(predicate);
		const previousStates = new Map(matching.map((action) => [action.id, action.lifecycle.state]));
		const preparing = this._actionStore
			.activeActions()
			.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" && action.lifecycle.state === "preparing",
			);
		const previousAnchor = preparing.at(-1);
		const actions = this._actionStore.remove(predicate, candidates);
		const restorableMessages: CustomMessage[] = [];
		const removed = new Set(actions);
		if (previousAnchor && removed.has(previousAnchor)) {
			for (const action of preparing) {
				if (!removed.has(action)) action.payload.prepared = undefined;
			}
		}
		for (const action of actions) {
			const ticket = this._actionStore.ticketFor(action);
			if (
				action.payload.kind === "turn" &&
				(action.payload.acceptedAgentMessage ||
					!action.payload.queueVisible ||
					previousStates.get(action.id) !== "queued")
			) {
				ticket.rejectDelivered(error);
			} else {
				ticket.settleDelivered({ status: "not_applicable" });
			}
			ticket.settleCompleted(error);
			const dispatched = previousStates.get(action.id) === "committing" && action.payload.kind === "turn";
			if (action.payload.kind === "turn") {
				const payload = action.payload;
				const restorable = payload.records
					.filter(
						(record): record is DeliveryRecord & { message: CustomMessage } =>
							(record.role === "next_turn" || (payload.acceptedAgentMessage && record.role === "prefix")) &&
							record.message.role === "custom" &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message));
				restorableMessages.push(...restorable);
				if (dispatched) {
					payload.captureRunMessages = new Set(payload.records.map((record) => record.message));
					this.agent.state.messages = this.agent.state.messages.filter(
						(message) => !payload.captureRunMessages?.has(message),
					);
				}
			}
			if (!dispatched) {
				this._actionStore.releaseTerminal(action);
			}
		}
		this._pendingNextTurnMessages.unshift(...restorableMessages);
		if (actions.length > 0) this._notifySessionInputCheckpointChange();
		return actions;
	}

	private _clearQueuedGoalContexts(): void {
		this._goalContinuationAwaitsRlmWork = false;
		this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter(
			(message) => message.customType !== GOAL_CONTEXT_CUSTOM_TYPE,
		);
		this.agent.removeQueuedMessages(
			(message) => message.role === "custom" && message.customType === GOAL_CONTEXT_CUSTOM_TYPE,
		);
		this._cancelSessionActions(
			(action) =>
				action.payload.kind === "turn" && action.payload.customMessage?.customType === GOAL_CONTEXT_CUSTOM_TYPE,
			new Error("Queued goal context was cleared before delivery."),
		);
		this._emitQueueUpdate();
	}

	private _startGoal(objectiveText: string, tokenBudget: number | undefined): GoalState {
		const objective = validateGoalObjective(objectiveText);
		const budget = validateGoalBudget(tokenBudget);
		const now = Date.now();
		const goal: GoalState = {
			active: true,
			status: "active",
			goalId: randomUUID(),
			objective,
			tokenBudget: budget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: now,
			updatedAt: now,
		};
		this._goalAccountingStartedAt = now;
		this._goalContinuationAwaitsRlmWork = false;
		this._setGoalState(goal);
		return this._goalState;
	}

	private _clearGoal(): void {
		this._clearQueuedGoalContexts();
		this._setGoalState(emptyGoalState());
	}

	private _pauseGoal(reason = "Paused by user"): void {
		this._clearQueuedGoalContexts();
		if (this._goalState.status !== "active") {
			this._emitGoalUpdate();
			return;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "paused",
			lastReason: reason,
			lastError: undefined,
		});
	}

	private async _resumeGoal(): Promise<void> {
		if (!this._goalState.objective) {
			this._emitGoalUpdate();
			return;
		}
		if (this._goalState.status !== "paused" && this._goalState.status !== "budget_limited") {
			this._emitGoalUpdate();
			return;
		}
		const exhausted =
			this._goalState.tokenBudget !== undefined && this._goalState.tokensUsed >= this._goalState.tokenBudget;
		const nextStatus: GoalStatus = exhausted ? "budget_limited" : "active";
		this._setGoalState({
			...this._goalState,
			active: nextStatus === "active",
			status: nextStatus,
			lastReason: exhausted ? "Goal token budget already reached" : undefined,
			lastError: undefined,
		});
		if (nextStatus === "active") {
			await this._runOrQueueGoalContext("continuation");
		}
	}

	private _finishGoalWithError(errorMessage: string): void {
		if (!this._goalState.objective || this._goalState.status !== "active") {
			return;
		}
		const goal = this._goalWithAccountedWallClock();
		this._setGoalState({
			...goal,
			active: false,
			status: "error",
			lastReason: errorMessage,
			lastError: errorMessage,
		});
	}

	private _finishGoalForTerminalAssistantMessage(message: AssistantMessage): void {
		if (this._goalState.status !== "active") {
			return;
		}

		if (message.stopReason === "aborted") {
			this._goalAbortInProgress = false;
			return;
		}

		if (message.stopReason === "error") {
			if (this._goalAbortInProgress) {
				this._goalAbortInProgress = false;
				return;
			}
			this._finishGoalWithError(message.errorMessage || "Assistant response failed");
		}
	}

	private _stopGoalContinuationForTerminalMessage(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" && message.stopReason !== "aborted") {
			return false;
		}
		try {
			this._finishGoalForTerminalAssistantMessage(message);
		} catch {
			// Goal hooks must not reject; listener failures should not crash the agent loop.
		}
		return true;
	}

	private _parseGoalSlashCommand(text: string): GoalSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "goal") return undefined;

		const rest = command.args;
		const normalized = rest.toLowerCase();
		if (!rest || normalized === "status") {
			return { kind: "status" };
		}
		if (normalized === "clear" || normalized === "stop") {
			return { kind: "clear" };
		}
		if (normalized === "pause") {
			return { kind: "pause" };
		}
		if (normalized === "resume") {
			return { kind: "resume" };
		}

		let tokenBudget: number | undefined;
		let objective = rest;
		const firstToken = rest.split(/\s+/, 1)[0] ?? "";
		if (
			firstToken === "--budget" ||
			firstToken === "--token-budget" ||
			firstToken.startsWith("--budget=") ||
			firstToken.startsWith("--token-budget=")
		) {
			let valueText: string;
			if (firstToken === "--budget" || firstToken === "--token-budget") {
				const withoutFlag = rest.slice(firstToken.length).trimStart();
				const nextSpace = withoutFlag.search(/\s/);
				if (nextSpace < 0) {
					throw new Error("Usage: /goal [--budget <tokens>] <objective>");
				}
				valueText = withoutFlag.slice(0, nextSpace);
				objective = withoutFlag.slice(nextSpace + 1).trim();
			} else {
				const separator = firstToken.indexOf("=");
				valueText = firstToken.slice(separator + 1);
				objective = rest.slice(firstToken.length).trim();
			}
			tokenBudget = parseGoalBudgetValue(valueText);
		}

		return {
			kind: "start",
			objective: validateGoalObjective(objective),
			tokenBudget,
		};
	}

	private _parseAutonomousSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const rest = command.args.toLowerCase();
		if (!rest || rest === "status") {
			return { kind: "status" };
		}
		if (rest === "on" || rest === "enable" || rest === "enabled") {
			return { kind: "on" };
		}
		if (rest === "off" || rest === "disable" || rest === "disabled") {
			return { kind: "off" };
		}
		throw new Error("Usage: /autonomous [on|off|status]");
	}

	private _formatAutonomousStatus(): string {
		const status = this.getAutonomousStatus();
		const state = status.enabled ? "on" : "off";
		return `Autonomous mode: ${state}. Continuations: ${status.continuationsUsed}/${status.limits.maxContinuations}. Turns: ${status.turnsUsed}/${status.limits.maxTurns}. Tokens: ${status.tokensUsed}/${status.limits.maxTokens}.`;
	}

	private _emitAutonomousStatus(): void {
		const message = {
			role: "custom" as const,
			customType: "autonomous_status",
			content: this._formatAutonomousStatus(),
			display: true,
			details: this.getAutonomousStatus(),
			timestamp: Date.now(),
		} satisfies CustomMessage<AgentAutonomousStatus>;
		this.agent.state.messages.push(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private async _handleAutonomousSlashCommand(text: string): Promise<boolean> {
		const command = this._parseAutonomousSlashCommand(text);
		if (!command) {
			return false;
		}
		if (command.kind === "on") {
			setAutonomousEnabled(this._autonomousState, true, { cwd: this._cwd });
		} else if (command.kind === "off") {
			setAutonomousEnabled(this._autonomousState, false);
			this._clearQueuedAutonomousContinuations();
		}
		this._emitAutonomousStatus();
		return true;
	}

	private _appendBeforeAgentStartMessages(
		messages: AgentMessage[],
		result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>,
	): void {
		if (!result?.messages) return;
		for (const message of result.messages) {
			messages.push({
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: message.display,
				details: message.details,
				timestamp: Date.now(),
			});
		}
	}

	private async _validateCanStartAgentRun(): Promise<void> {
		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}
		if (!this._modelRegistry.hasConfiguredAuth(this.model)) {
			const isOAuth = this._modelRegistry.isUsingOAuth(this.model);
			if (isOAuth) {
				throw new Error(formatAuthenticationFailedMessage(this.model.provider));
			}
			throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
		}
	}

	/**
	 * Goals are pursued through the IPython goal skill, so the only tool the
	 * model needs is ipython. Force-activate it (including into a live
	 * continuation context) so the model can always reach `goal.complete()`.
	 */
	private _ensureGoalRuntimeActive(context?: AgentContext): void {
		if (!this._includeGoals) {
			throw new Error("Goals are disabled. Enable goals before using /goal.");
		}
		const ipythonTool = this._toolRegistry.get("ipython");
		if (!ipythonTool) {
			throw new Error("Goals require the ipython tool, which is not available in this session.");
		}
		const activeToolNames = new Set(this.getActiveToolNames());
		if (!activeToolNames.has("ipython")) {
			activeToolNames.add("ipython");
			this.setActiveToolsByName([...activeToolNames]);
		}
		if (context) {
			const contextTools = [...(context.tools ?? [])];
			if (!contextTools.some((tool) => tool.name === "ipython")) {
				contextTools.push(ipythonTool);
				context.tools = contextTools;
			}
		}
	}

	private _maybeResumeGoalContinuationAfterRlmWork(): void {
		if (!this._goalContinuationAwaitsRlmWork) return;
		if (this._disposed || this._disposing || this._hasUnsettledRlmQuiescenceWork()) return;
		if (this._goalState.status !== "active" || !this._goalState.objective) {
			this._goalContinuationAwaitsRlmWork = false;
			return;
		}
		// Keep the deferral while admission is paused or the pump is suspended
		// (post-abort); the pause release and resumeQueuedWork retry.
		if (this._sessionInputAdmissionPauses.size > 0 || this._sessionInputPumpSuspended) return;
		const goalBeforeResume = this._goalState;
		try {
			this._ensureGoalRuntimeActive();
			this._setGoalState({
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			});
			const message = createGoalContextMessage(this._goalState, "continuation");
			const normalized = normalizeMessageContent(message.content);
			// No front: a settling child's terminal notice must be read first.
			this._admitSessionInput(
				this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				}),
			);
			this._goalContinuationAwaitsRlmWork = false;
		} catch {
			// Admission can race a new pause; roll back so the retry re-counts.
			this._setGoalState(goalBeforeResume);
		}
	}

	private _runOrQueueGoalContext(kind: "continuation" | "objective_updated", images?: ImageContent[]): void {
		if (!this._goalState.objective) return;
		this._ensureGoalRuntimeActive();
		const message = createGoalContextMessage(this._goalState, kind, images);
		const normalized = normalizeMessageContent(message.content);
		const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
		});
		this._admitSessionInput(action, { front: true, wake: false });
	}

	private async _handleGoalSlashCommand(text: string, images: ImageContent[] | undefined): Promise<boolean> {
		const command = this._parseGoalSlashCommand(text);
		if (!command) {
			return false;
		}

		if (command.kind === "status") {
			this._emitGoalUpdate();
			return true;
		}

		if (command.kind === "clear") {
			this._clearGoal();
			return true;
		}

		if (command.kind === "pause") {
			this._pauseGoal();
			return true;
		}

		if (command.kind === "resume") {
			await this._resumeGoal();
			return true;
		}

		const previousWasActive = this._goalState.status === "active";
		if (!this.isStreaming) {
			await this._validateCanStartAgentRun();
		}
		this._ensureGoalRuntimeActive();
		this._clearQueuedGoalContexts();
		this._startGoal(command.objective, command.tokenBudget);
		await this._runOrQueueGoalContext(previousWasActive ? "objective_updated" : "continuation", images);
		return true;
	}

	private _accountGoalUsageForAssistantMessage(message: AssistantMessage): boolean {
		if (!this._goalState.objective) {
			return false;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this._goalAccountedAssistantMessages.has(message)) {
			return false;
		}
		// Usage is attributed at the assistant message's message_end, which fires
		// before that turn's ipython cell runs. goal.complete() only arrives later
		// over the kernel host bridge, so the completing turn is always accounted
		// while the goal is still active. Only count turns spent pursuing the goal;
		// post-completion turns (e.g. a closing summary) must not be attributed.
		if (this._goalState.status !== "active") {
			return false;
		}
		this._goalAccountedAssistantMessages.add(message);
		const tokenDelta = goalTokenDeltaForUsage(message.usage);
		const goal = this._goalWithAccountedWallClock();
		const nextGoal: GoalState = {
			...goal,
			tokensUsed: goal.tokensUsed + tokenDelta,
		};
		const budgetReached = nextGoal.tokenBudget !== undefined && nextGoal.tokensUsed >= nextGoal.tokenBudget;
		if (!budgetReached) {
			this._setGoalState(nextGoal);
			return false;
		}
		this._setGoalState({
			...nextGoal,
			active: false,
			status: "budget_limited",
			lastReason: `Reached ${nextGoal.tokenBudget} token goal budget`,
			lastError: undefined,
		});
		return true;
	}

	private get _steeringStopPending(): boolean {
		return (
			this._actionStore.queuedActions("next_turn_boundary").length > 0 ||
			this._actionStore
				.activeActions("next_turn_boundary")
				.some(
					(action) =>
						action.payload.kind === "turn" &&
						(action.lifecycle.state === "selected" || action.lifecycle.state === "preparing"),
				)
		);
	}

	private _hasReachedAutonomousLimit(): boolean {
		return this._autonomousState.enabled && autonomousLimitReason(this._autonomousState) !== undefined;
	}

	private _shouldStopBeforeTurn(): boolean {
		return this._steeringStopPending;
	}

	private async _shouldStopAfterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
		// message_end accounting is intentionally serialized off the agent event
		// callback. Wait for it here so a tool-use response cannot start another
		// provider turn before its autonomous usage has been charged. The current
		// tool batch has already finished at this boundary, so host evidence is
		// never interrupted or discarded.
		await this._agentEventQueue;
		const avoBoundaryState = this._avoRuntime?.getState();
		if (
			this._enforceAvoCompletion &&
			avoBoundaryState?.status === "active" &&
			(avoBoundaryState.delivery.phase === "accepted" || avoBoundaryState.delivery.phase === "pending")
		) {
			const completed = await this._completeAvoCanonicalDeliveryIfMatching(context);
			if (completed) return true;
			const pendingDelivery = this._pendingAvoCanonicalDelivery();
			if (pendingDelivery) {
				const pendingBinding = parseAvoCanonicalDeliveryBinding(pendingDelivery);
				if (
					pendingBinding &&
					matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, pendingBinding) &&
					context.message.stopReason === "toolUse"
				) {
					this._recordAvoCanonicalDeliveryFailure(
						new Error("the assistant attempted tool use instead of returning the exact canonical delivery"),
						pendingBinding,
					);
					return true;
				}
				await this._ensurePersistedAvoCanonicalDeliveryAction();
				return true;
			}
			if (this._isAvoCanonicalDeliveryTerminalFailure()) return true;
		}
		if (this._hasReachedAutonomousLimit()) {
			// Configured gates are host evidence too. Preserve the existing
			// gate-before-limit rule so changes made by the final tool batch can
			// still be observed even though no further model turn is admissible.
			await refreshAutonomousQualityGates(this._autonomousState, {
				cwd: this._cwd,
				signal: this.agent.signal,
			});
			// A final assistant response can itself be the exact canonical AVO
			// delivery, including when its just-finished tool batch produced the
			// evidence that closed the gate. Credit that terminal evidence before
			// enforcing the hard provider-turn boundary.
			return true;
		}
		if (
			this._stopGoalContinuationForTerminalMessage(context.message) &&
			(!this._enforceAvoCompletion || this._avoRuntime?.getState().status !== "active")
		) {
			return true;
		}
		try {
			if (this._accountGoalUsageForAssistantMessage(context.message)) {
				const message = createGoalContextMessage(this._goalState, "budget_limit");
				const normalized = normalizeMessageContent(message.content);
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
			}
		} catch {
			// Goal accounting must not interrupt the core agent loop.
		}
		// Serialized refine checkpoint: in print/headless mode, run refinement
		// planning+apply synchronously here — the quiescent boundary between
		// turns — so it never overlaps the primary model request.
		// This MUST run BEFORE threshold compaction to prevent the
		// compaction model call from overlapping an in-flight refine
		// plan/apply that was started at message_end.
		if (this._serializedRefine) {
			// Ensure the preceding message_end processing (counter increment,
			// background plan kickoff) has completed before the checkpoint.
			await this._agentEventQueue;
			await this._runSerializedRefineCheckpoint();
		}
		if (this._steeringStopPending) await this._completeAvoCanonicalDeliveryIfMatching(context);
		if (await this._shouldStopForThresholdCompaction(context)) {
			return true;
		}
		// Steering stops continuation only after mandatory serialized checkpoints.
		// Returning true here still prevents the agent loop from starting another turn.
		return this._steeringStopPending;
	}

	private async _shouldStopForThresholdCompaction(context: ShouldStopAfterTurnContext): Promise<boolean> {
		this._continueAfterThresholdCompaction = false;
		const thresholdNeeded =
			this._pendingRequestedCompaction === undefined && (await this._thresholdCompactionNeeded(context));
		if (this._pendingRequestedCompaction === undefined && !thresholdNeeded) {
			return false;
		}
		if (thresholdNeeded) {
			const avoDisposition = await this._queueAvoContinuationForThresholdCompaction(context);
			if (avoDisposition === "queued") {
				this._continueAfterThresholdCompaction = true;
			} else if (
				avoDisposition === "none" &&
				(this._queueGoalContinuationForThresholdCompaction(context.message) ||
					(await this._queueAutonomousContinuationForThresholdCompaction(context.message)))
			) {
				this._continueAfterThresholdCompaction = true;
			}
		}

		const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
		// A queued continuation disproves the assistant-last "task finished" heuristic, so preserve a true set above.
		this._continueAfterThresholdCompaction ||= lastMessage !== undefined && lastMessage.role !== "assistant";
		return true;
	}

	private async _queueAvoContinuationForThresholdCompaction(
		context: ShouldStopAfterTurnContext,
	): Promise<"queued" | "completed" | "none"> {
		const continuation = await this._getAvoCompletionContinuation(context, this.agent.signal);
		if (!continuation) {
			return this._enforceAvoCompletion && this._avoRuntime?.getState().status === "completed"
				? "completed"
				: "none";
		}
		const normalized = normalizeMessageContent(continuation.content);
		this._admitSessionInput(
			this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
				message: continuation,
			}),
		);
		return "queued";
	}

	/**
	 * Serialized-mode auto-refine checkpoint called from _shouldStopAfterTurn.
	 * Runs the review, planning, and application phases inline between turns
	 * at the quiescent shouldStopAfterTurn boundary. This path NEVER calls
	 * _maybeAutoRefine, _runApprovedRefine, public refine(), agent.abort(),
	 * or agent.waitForIdle — all of which would deadlock or defer because
	 * the agent loop still owns activeRun at this point. Instead it calls
	 * _reviewAutoRefine, _planRefine, and _applyRefine directly with proper
	 * in-flight guards and counter resets.
	 */
	private async _runSerializedRefineCheckpoint(): Promise<void> {
		if (this._disposed || this._disposing || this._pendingAvoCanonicalDelivery()) {
			return;
		}

		// 1. Await any background plan that was started at message_end
		//    (either for a pending refine.run or for interval-triggered
		//    auto-refine). This must be checked BEFORE the pending and
		//    interval checks because background planning may have consumed
		//    the pending request at message_end.
		const branchVersion = this._autoRefineBranchVersion;
		const bgConsumption = await this._consumeSerializedBackgroundPlan(async (bgResult) => {
			if (this._disposed || this._disposing || this._pendingAvoCanonicalDelivery()) {
				return true;
			}

			if (bgResult?.status === "plan") {
				if (bgResult.branchVersion !== this._autoRefineBranchVersion) {
					if (!this._pendingRequestedRefine) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
						return true;
					}
				} else if (!this._pendingAvoCanonicalDelivery()) {
					// Apply the EXACT background plan directly via _applyRefine
					// (no second _planRefine call).
					try {
						await this._applySerializedPlan(bgResult);
					} catch (error) {
						this._emitRefineFailed(error);
					}
					this._lastAutoRefineReviewAt = Date.now();
					this._assistantTurnsSinceAutoRefine = 0;
					if (!this._pendingRequestedRefine) {
						return true;
					}
				}
			}

			if (bgResult?.status === "skip") {
				// Reviewer declined or an extension skipped during background planning.
				// Reset exactly once. Never retry the interval review; only fall through for a separate pending refine.run.
				if (bgResult.explicit) {
					this._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
				}
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "failure") {
				// Background review or planning failure stamps cooldown without a synchronous retry.
				// A separately queued refine.run may still be serviced below.
				if (branchVersion === this._autoRefineBranchVersion) {
					this._lastAutoRefineReviewAt = Date.now();
				}
				// Re-queue an explicit refine.run whose background plan failed,
				// but only when branchVersion is still current and no newer
				// pending request has arrived since the background plan consumed
				// the original one. A newer request retains priority; interval
				// failures keep existing no-retry cooldown semantics.
				if (
					bgResult.explicit &&
					bgResult.branchVersion === this._autoRefineBranchVersion &&
					!this._pendingRequestedRefine
				) {
					this._pendingRequestedRefine = bgResult.options;
				}
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "invalidated" && !this._pendingRequestedRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return true;
			}

			await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
			return true;
		});
		if (this._disposed || this._disposing || this._pendingAvoCanonicalDelivery() || bgConsumption !== "none") {
			return;
		}
		await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
	}

	private async _runSerializedRefineCheckpointAfterBackground(branchVersion: number): Promise<void> {
		if (this._pendingAvoCanonicalDelivery()) return;
		// No background result, or a refine.run arrived while the background result was
		// in flight. Fall through so an explicit pending request is serviced at this boundary.

		// 2. Agent-callable refine.run requests that were NOT consumed by
		//    background planning (e.g. interval not reached at message_end,
		//    or cooldown was active). Service them synchronously.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending);
			} catch (error) {
				this._emitRefineFailed(error);
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			return;
		}

		// 3. Post-compaction auto-refine. Serialized sessions defer the
		// compaction trigger to this boundary instead of entering the interactive
		// path, which waits for agent idle and can never run inside a tool loop.
		if (!this._autoRefineAllowedForSession()) {
			this._compactAutoRefinePending = false;
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._compactAutoRefinePending = false;
			return;
		}
		if (this._compactAutoRefinePending) {
			if (!settings.compact) {
				this._compactAutoRefinePending = false;
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
				if (underCooldown) {
					// Preserve the compact trigger for a later boundary, matching the
					// interactive path's pending behavior while the cooldown is active.
					return;
				}
				this._compactAutoRefinePending = false;
				await this._runSerializedAutoRefineReview("compact", branchVersion);
				return;
			}
		}

		// 4. Interval-triggered auto-refine (no background plan was started).
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		await this._runSerializedAutoRefineReview("turn_interval", branchVersion);
	}

	private async _runSerializedAutoRefineReview(
		reason: "compact" | "turn_interval",
		branchVersion: number,
	): Promise<void> {
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		this._autoRefineInProgress = true;
		try {
			const review = await this._reviewAutoRefine(
				{ reason, turnsSinceLastReview: this._assistantTurnsSinceAutoRefine },
				reviewAbort.signal,
			);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				return;
			}
			await this._runSerializedRefine({ instructions: autoRefineInstructions(reason, review) }, "auto");
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		} catch (error) {
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
				// An extension skip is an intentional non-round, not a failure.
				if (error instanceof RefineSkippedError) {
					this._assistantTurnsSinceAutoRefine = 0;
				} else {
					this._emitRefineFailed(error);
				}
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
		}
	}

	/**
	 * Claim and process the serialized background plan if one is in flight.
	 * A concurrent caller waits for the claim holder's full processing callback
	 * instead of resuming as soon as planning settles.
	 */
	private async _consumeSerializedBackgroundPlan(
		consume: (result: SerializedBackgroundPlanResult | undefined) => Promise<boolean>,
	): Promise<"none" | "waited" | "continue" | "stop"> {
		if (this._serializedPlanClaim) {
			await this._serializedPlanClaim.catch(() => undefined);
			return "waited";
		}
		const planInFlight = this._serializedPlanInFlight;
		if (!planInFlight) {
			return "none";
		}

		let releaseClaim: () => void = () => {};
		const claim = new Promise<void>((resolve) => {
			releaseClaim = resolve;
		});
		this._serializedPlanClaim = claim;
		try {
			const result = await planInFlight.catch(() => undefined);
			if (this._serializedPlanInFlight === planInFlight) {
				this._serializedPlanInFlight = undefined;
				this._serializedExplicitRefineOptions = undefined;
			}
			return (await consume(result)) ? "stop" : "continue";
		} finally {
			releaseClaim();
			if (this._serializedPlanClaim === claim) {
				this._serializedPlanClaim = undefined;
			}
		}
	}

	/**
	 * Apply an exact background plan directly via _applyRefine without
	 * calling _planRefine again. Sets _refineInFlight for safety.
	 */
	private async _applySerializedPlan(
		bgResult: Extract<SerializedBackgroundPlanResult, { status: "plan" }>,
	): Promise<void> {
		if (this._pendingAvoCanonicalDelivery()) return;
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._applyRefine(bgResult.plan, bgResult.options, bgResult.abort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Start background refinement planning at assistant message_end, while
	 * tools are still executing. The plan (if any) is awaited at the
	 * shouldStopAfterTurn boundary before applying. Planning overlaps tool
	 * execution only — never another model request.
	 */
	private _maybeStartSerializedBackgroundPlan(): void {
		if (
			!this._serializedRefine ||
			this._disposed ||
			this._disposing ||
			this._hasReachedAutonomousLimit() ||
			this._pendingAvoCanonicalDelivery()
		) {
			return;
		}
		// Don't start if a plan is already in flight.
		if (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			return;
		}

		// Start background planning for a pending agent-callable
		// refine.run request, so its plan is ready at the shouldStopAfterTurn
		// boundary. The pending request is consumed (cleared) here so the
		// boundary doesn't re-plan it. Explicit refine.run skips the review gate.
		const pending = this._pendingRequestedRefine;
		if (pending) {
			this._pendingRequestedRefine = undefined;
			this._serializedExplicitRefineOptions = pending;
			const refineAbort = new AbortController();
			this._refineAbortController = refineAbort;
			const branchVersion = this._autoRefineBranchVersion;
			this._serializedPlanInFlight = this._runBackgroundPlan(pending, refineAbort, branchVersion, true);
			return;
		}

		// Interval-triggered auto-refine background planning.
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;
		const branchVersion = this._autoRefineBranchVersion;
		// Pass empty options — _runBackgroundPlan derives instructions from
		// the review result for interval-triggered auto-refine.
		this._serializedPlanInFlight = this._runBackgroundPlan({}, refineAbort, branchVersion);
	}

	/**
	 * Shared background planning coroutine. Runs review + planRefine and
	 * returns a discriminated result so the boundary can distinguish
	 * reviewer-declined ("skip") from failure ("failure") from a ready
	 * plan ("plan") and apply that exact plan without re-planning.
	 */
	private async _runBackgroundPlan(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
		branchVersion: number,
		skipReview = false,
	): Promise<SerializedBackgroundPlanResult | undefined> {
		try {
			let planOptions = options;
			if (!skipReview) {
				// Interval-triggered: run the review gate first, then derive
				// instructions from the review result (not prepopulated).
				const review = await this._reviewAutoRefine(
					{
						reason: "turn_interval",
						turnsSinceLastReview: this._assistantTurnsSinceAutoRefine,
					},
					refineAbort.signal,
				);
				if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
					return { status: "invalidated", branchVersion };
				}
				if (!review.shouldRefine) {
					return { status: "skip" };
				}
				planOptions = {
					instructions: autoRefineInstructions("turn_interval", review),
				};
			}
			// For explicit refine.run (skipReview=true), plan directly with
			// the user-provided options — no auto-review gate.
			const plan = await this._planRefine(planOptions, refineAbort.signal, skipReview ? "manual" : "auto");
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			return {
				status: "plan",
				plan,
				options: planOptions,
				abort: refineAbort,
				branchVersion,
			};
		} catch (error) {
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
			}
			if (error instanceof RefineSkippedError) {
				return { status: "skip", explicit: skipReview };
			}
			return {
				status: "failure",
				explicit: skipReview,
				options,
				branchVersion,
			};
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
		}
	}

	/**
	 * Direct serialized plan+apply. Calls _planRefine and _applyRefine with
	 * proper in-flight guards but NEVER agent.waitForIdle or agent.abort.
	 * The caller (shouldStopAfterTurn) is already at the quiescent boundary,
	 * so the agent is between turns and _applyRefine's disconnect/reconnect
	 * is safe.
	 */
	private async _runSerializedRefine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		},
		trigger: "manual" | "auto" = "manual",
	): Promise<void> {
		if (this._disposed || this._disposing) {
			return;
		}
		// Guard: serialize against concurrent _runSerializedRefine calls.
		// _serializedPlanInFlight covers background planning; _refineInFlight
		// covers the apply phase. Both must be settled before starting a new
		// plan+apply cycle.
		while (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			if (this._serializedPlanInFlight) {
				await this._consumeSerializedBackgroundPlan(async () => false);
			} else if (this._refineInFlight) {
				await this._refineInFlight;
			} else {
				await this._refinePlanInFlight;
			}
		}
		if (this._disposed || this._disposing) {
			return;
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._planRefine(options, refineAbort.signal, trigger);
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (error) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			throw error;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		if (this._disposed || refineAbort.signal.aborted) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			return;
		}

		// Do NOT call agent.waitForIdle() — we are at the quiescent boundary
		// already (shouldStopAfterTurn). _applyRefine handles disconnect/reconnect internally.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			await this._applyRefine(plan, options, refineAbort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._scheduleSessionInputPump();
		}
	}

	private async _thresholdCompactionNeeded(context: ShouldStopAfterTurnContext): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		if (compactionTimestamp !== undefined && context.message.timestamp <= compactionTimestamp) {
			return false;
		}

		const contextTokens = this._getThresholdContextTokens(context.message, compactionTimestamp);
		if (contextTokens === undefined || !shouldCompact(contextTokens, contextWindow, settings)) {
			return false;
		}
		return true;
	}

	private _snapshotAutonomousRuntimeState(): AutonomousRuntimeSnapshot {
		return {
			continuationsUsed: this._autonomousState.continuationsUsed,
			gateAttempts: { ...this._autonomousState.gateAttempts },
			lastGateFailure: this._autonomousState.lastGateFailure
				? { ...this._autonomousState.lastGateFailure }
				: undefined,
			lastGateFailureSnapshot: this._autonomousState.lastGateFailureSnapshot
				? { ...this._autonomousState.lastGateFailureSnapshot }
				: undefined,
		};
	}

	private _restoreAutonomousRuntimeSnapshot(snapshot: AutonomousRuntimeSnapshot): void {
		this._autonomousState.continuationsUsed = snapshot.continuationsUsed;
		this._autonomousState.gateAttempts = { ...snapshot.gateAttempts };
		this._autonomousState.lastGateFailure = snapshot.lastGateFailure ? { ...snapshot.lastGateFailure } : undefined;
		this._autonomousState.lastGateFailureSnapshot = snapshot.lastGateFailureSnapshot
			? { ...snapshot.lastGateFailureSnapshot }
			: undefined;
	}

	private async _queueAutonomousContinuationForThresholdCompaction(
		message: AssistantMessage,
	): Promise<AgentMessage | undefined> {
		const queuedMessage = this._queuedAutonomousThresholdContinuations.get(message);
		if (queuedMessage && this._postCompactionContinuationMessages.includes(queuedMessage)) {
			return queuedMessage;
		}
		const snapshot = this._snapshotAutonomousRuntimeState();
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, message, {
			cwd: this._cwd,
			signal: this.agent.signal,
		});
		if (!autonomousMessage) {
			return undefined;
		}
		if (this._sessionInputArrivalEpoch !== arrivalEpoch) {
			this._restoreAutonomousRuntimeSnapshot(snapshot);
			return undefined;
		}
		this._queuedAutonomousThresholdContinuations.set(message, autonomousMessage);
		this._queuedAutonomousContinuationSnapshots.set(autonomousMessage, snapshot);
		this._postCompactionContinuationMessages.push(autonomousMessage);
		this._pendingThresholdCompactionAutonomousMessages.push(autonomousMessage);
		const text =
			typeof autonomousMessage.content === "string"
				? autonomousMessage.content
				: autonomousMessage.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
		this._admitSessionInput(
			this._createPreparedTurnAction("followUp", text, undefined, {
				message: autonomousMessage,
			}),
		);
		return autonomousMessage;
	}

	// The role heuristic reads an assistant-last threshold stop as "task finished" and
	// agent.continue() cannot resume from it, so the goal continuation is queued as a session input.
	private _queueGoalContinuationForThresholdCompaction(message: AssistantMessage): boolean {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			return false;
		}
		if (this._goalState.status !== "active" || !this._goalState.objective) {
			return false;
		}
		const alreadyQueued = this._queuedGoalThresholdContinuation;
		if (
			alreadyQueued !== undefined &&
			this._actionStore.unfinishedActions().some((action) => {
				if (action.payload.kind !== "turn" || primaryDeliveryRecord(action).message !== alreadyQueued) return false;
				// A running continuation may already need a successor; only undelivered actions deduplicate.
				return (
					action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					action.lifecycle.state === "committing"
				);
			})
		) {
			return true;
		}
		try {
			this._ensureGoalRuntimeActive();
			this._setGoalState({
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			});
			const goalMessage = createGoalContextMessage(this._goalState, "continuation");
			const normalized = normalizeMessageContent(goalMessage.content);
			this._admitSessionInput(
				this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: goalMessage,
				}),
			);
			this._queuedGoalThresholdContinuation = goalMessage;
			return true;
		} catch {
			return false;
		}
	}

	// Withdraws a goal continuation queued for a threshold compaction the user cancelled,
	// rolling back the continuationsUsed increment so the next natural stop re-queues it.
	private _clearQueuedGoalContinuationAfterCancelledThresholdCompaction(
		queuedGoalContinuation: AgentMessage | undefined,
	): void {
		if (queuedGoalContinuation === undefined) return;
		const cancelled = this._cancelSessionActions(
			(action) => action.payload.kind === "turn" && primaryDeliveryRecord(action).message === queuedGoalContinuation,
			new Error("Queued goal continuation was cleared before delivery."),
		);
		this._queuedGoalThresholdContinuation = undefined;
		// A stale marker (continuation already consumed) matches no action; only an
		// actual cancellation may roll back its queue-time continuationsUsed increment.
		if (cancelled.length === 0) return;
		this._setGoalState({ ...this._goalState, continuationsUsed: this._goalState.continuationsUsed - 1 });
		this._emitQueueUpdate();
	}

	private _clearQueuedAutonomousContinuations(
		options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {},
	): void {
		const requestedMessages = options.messages ?? [...this._postCompactionContinuationMessages];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this._postCompactionContinuationMessages.filter((message) =>
			requestedMessageSet.has(message),
		);
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this._postCompactionContinuationMessages = this._postCompactionContinuationMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		this.agent.removeQueuedMessages((message) => queuedMessageSet.has(message));
		this._cancelSessionActions(
			(action) => action.payload.kind === "turn" && queuedMessageSet.has(primaryDeliveryRecord(action).message),
			new Error("Queued autonomous continuation was cleared before delivery."),
		);
		this._emitQueueUpdate();
		if (options.restoreAutonomousState) {
			for (const queuedMessage of queuedMessages) {
				const snapshot = this._queuedAutonomousContinuationSnapshots.get(queuedMessage);
				if (snapshot) {
					this._restoreAutonomousRuntimeSnapshot(snapshot);
					break;
				}
			}
		}
		for (const queuedMessage of queuedMessages) {
			this._queuedAutonomousContinuationSnapshots.delete(queuedMessage);
		}
		this._pendingThresholdCompactionAutonomousMessages = this._pendingThresholdCompactionAutonomousMessages.filter(
			(message) => !queuedMessageSet.has(message),
		);
		if (options.messages === undefined) {
			this._continueAfterThresholdCompaction = false;
		}
		if (!this.agent.hasQueuedMessages() && this.unfinishedActionCount === 0) {
			this._cancelPostCompactionContinue();
		}
	}

	private _clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
		shouldContinueAfterThreshold: boolean,
		queuedMessages: AgentMessage[],
	): void {
		if (shouldContinueAfterThreshold) {
			this._clearQueuedAutonomousContinuations({
				restoreAutonomousState: true,
				messages: queuedMessages,
			});
		}
	}

	/**
	 * Handle a goal.* request from the IPython kernel host bridge (the bundled
	 * goal skill). All goal state stays host-side; the kernel only sees the
	 * serialized snake_case response.
	 */
	handleGoalHostRequest(type: string, payload: Record<string, unknown> = {}): GoalHostResponse {
		if (!this._includeGoals) {
			throw new Error("goals are disabled in this session");
		}
		switch (type) {
			case "goal.get":
				return goalHostResponse(this.goalState, false);
			case "goal.create": {
				if (typeof payload.objective !== "string") {
					throw new Error("goal.create objective must be a string");
				}
				if (payload.token_budget !== undefined && typeof payload.token_budget !== "number") {
					throw new Error("goal.create token_budget must be an integer when provided");
				}
				return goalHostResponse(this._createGoalFromHost(payload.objective, payload.token_budget), false);
			}
			case "goal.complete":
				return goalHostResponse(this._completeGoalFromHost(), true);
			default:
				throw new Error(`unknown goal request type "${type}"`);
		}
	}

	/**
	 * Handle a compact.* request from the kernel host bridge. Compaction would
	 * abort the run executing the requesting cell, so compact.run only schedules
	 * it; _checkCompaction consumes the request at the turn boundary.
	 */
	handleCompactHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		if (!this._includeCompactSkill) {
			throw new Error("the compact skill is disabled in this session");
		}
		switch (type) {
			case "compact.status": {
				const usage = this.getContextUsage();
				return {
					tokens: usage?.tokens ?? null,
					context_window: usage?.contextWindow ?? null,
					percent: usage?.percent ?? null,
					scheduled: this._pendingRequestedCompaction !== undefined,
				};
			}
			case "compact.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("compact.run instructions must be a string when provided");
				}
				// "status" is reserved by the host-request reply protocol; don't use it as a key.
				if (!this.isStreaming) {
					return {
						scheduled: false,
						reason: "no active turn; compaction can only be requested while a turn is running",
					};
				}
				const preparation = prepareCompaction(
					this.sessionManager.getBranch(),
					this.settingsManager.getCompactionSettings(),
				);
				if (!preparation) {
					const lastEntry = this.sessionManager.getBranch().at(-1);
					return {
						scheduled: false,
						reason: lastEntry?.type === "compaction" ? "already compacted" : "session is too short to compact",
					};
				}
				this._pendingRequestedCompaction = { customInstructions: instructions };
				return {
					scheduled: true,
					note: "Compaction runs when the current turn ends; you resume automatically afterwards. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown compact request type "${type}"`);
		}
	}

	/**
	 * Handle a refine.* request from the kernel host bridge. Like compact,
	 * refinement waits for the current turn to become idle before applying
	 * changes, so refine.run only schedules it; _consumePendingRequestedRefine
	 * fires it at the turn boundary. This prevents a deadlock that would occur
	 * if refine() awaited agent idle from within the active tool call.
	 */
	handleRefineHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		switch (type) {
			case "refine.status": {
				return {
					pending: this._pendingRequestedRefine !== undefined,
					in_flight:
						this._refineInFlight !== undefined ||
						this._refinePlanInFlight !== undefined ||
						this._serializedPlanInFlight !== undefined,
				};
			}
			case "refine.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("refine.run instructions must be a string when provided");
				}
				const globalFlag = payload.global;
				if (globalFlag !== undefined && typeof globalFlag !== "boolean") {
					throw new Error("refine.run global must be a boolean when provided");
				}
				if (!this.isStreaming) {
					return {
						scheduled: false,
						reason: "no active turn; refine can only be requested while a turn is running",
					};
				}
				const previous = this._pendingRequestedRefine ?? this._serializedExplicitRefineOptions;
				this._pendingRequestedRefine = {
					instructions: instructions ?? previous?.instructions,
					global: globalFlag ?? previous?.global,
				};
				// In serialized mode, kick off background planning immediately
				// (the primary response ended at message_end, tools are active).
				// This lets planning overlap tool execution rather than waiting
				// for the shouldStopAfterTurn boundary.
				if (this._serializedRefine) {
					if (this._serializedPlanInFlight) {
						this._autoRefineBranchVersion++;
						if (this._refineAbortController) {
							this._refineAbortController.abort();
						} else {
							this._serializedPlanInFlight = Promise.resolve({
								status: "invalidated",
								branchVersion: this._autoRefineBranchVersion,
							});
						}
					} else {
						this._maybeStartSerializedBackgroundPlan();
					}
				}
				return {
					scheduled: true,
					note: "Refinement runs when the current turn ends; the harness rebuilds the system prompt and resumes you automatically. Continue working normally.",
				};
			}
			default:
				throw new Error(`unknown refine request type "${type}"`);
		}
	}

	/**
	 * Handle an rlm_heartbeat.* request from the bundled rlm-heartbeat skill.
	 * These heartbeats are internal to this active session and never read or
	 * mutate the user-level /heartbeat.
	 */
	handleRlmHeartbeatHostRequest(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
		const controller = this._rlmHeartbeatController;
		if (!controller) {
			throw new Error("RLM heartbeat skill is not available in this session");
		}
		switch (type) {
			case "rlm_heartbeat.list": {
				const includeInactive = payload.include_inactive === true || payload.includeInactive === true;
				return {
					heartbeats: controller
						.listRlmHeartbeats({ includeInactive })
						.map((heartbeat) => rlmHeartbeatHostResponse(heartbeat)),
				};
			}
			case "rlm_heartbeat.create": {
				if (typeof payload.instruction !== "string") {
					throw new Error("rlm_heartbeat.create instruction must be a string");
				}
				if (payload.interval !== undefined && typeof payload.interval !== "string") {
					throw new Error("rlm_heartbeat.create interval must be a string when provided");
				}
				if (payload.label !== undefined && typeof payload.label !== "string") {
					throw new Error("rlm_heartbeat.create label must be a string when provided");
				}
				const deliveryMode = normalizeHeartbeatDeliveryMode(payload.delivery_mode ?? payload.deliveryMode);
				return {
					heartbeat: rlmHeartbeatHostResponse(
						controller.createRlmHeartbeat({
							instruction: payload.instruction,
							interval: payload.interval,
							label: payload.label,
							deliveryMode,
						}),
					),
				};
			}
			case "rlm_heartbeat.update": {
				if (typeof payload.id !== "string") {
					throw new Error("rlm_heartbeat.update id must be a string");
				}
				if (payload.instruction !== undefined && typeof payload.instruction !== "string") {
					throw new Error("rlm_heartbeat.update instruction must be a string when provided");
				}
				if (payload.interval !== undefined && typeof payload.interval !== "string") {
					throw new Error("rlm_heartbeat.update interval must be a string when provided");
				}
				if (payload.label !== undefined && typeof payload.label !== "string") {
					throw new Error("rlm_heartbeat.update label must be a string when provided");
				}
				if (payload.status !== undefined && !isRlmHeartbeatStatusUpdate(payload.status)) {
					throw new Error('rlm_heartbeat.update status must be "pause" or "resume" when provided');
				}
				const rawDeliveryMode = payload.delivery_mode ?? payload.deliveryMode;
				const deliveryMode = normalizeHeartbeatDeliveryMode(rawDeliveryMode);
				if (
					payload.instruction === undefined &&
					payload.interval === undefined &&
					payload.label === undefined &&
					payload.status === undefined &&
					rawDeliveryMode === undefined
				) {
					throw new Error("rlm_heartbeat.update requires at least one field to update");
				}
				const heartbeat = controller.updateRlmHeartbeat({
					id: payload.id,
					instruction: payload.instruction,
					interval: payload.interval,
					label: payload.label,
					status: payload.status,
					deliveryMode,
				});
				return {
					heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null,
				};
			}
			case "rlm_heartbeat.delete": {
				if (typeof payload.id !== "string") {
					throw new Error("rlm_heartbeat.delete id must be a string");
				}
				const heartbeat = controller.deleteRlmHeartbeat(payload.id);
				return {
					heartbeat: heartbeat ? rlmHeartbeatHostResponse(heartbeat) : null,
				};
			}
			default:
				throw new Error(`unknown RLM heartbeat request type "${type}"`);
		}
	}

	private _requireAvoRuntime(): AvoSessionRuntime {
		if (!this._avoRuntime || this._rlmDepth !== 0) {
			throw new Error("AVO state is only available in a root agent session");
		}
		return this._avoRuntime;
	}

	private _resolveAvoExternalToolResult(toolCallId: string): {
		call: ToolCall;
		callTimestamp: number;
		result: ToolResultMessage;
	} {
		let call: ToolCall | undefined;
		let callTimestamp = 0;
		let result: ToolResultMessage | undefined;
		for (const message of this.messages) {
			if (message.role === "assistant") {
				const matched = message.content.find(
					(item): item is ToolCall => item.type === "toolCall" && item.id === toolCallId,
				);
				if (matched) {
					call = matched;
					callTimestamp = message.timestamp;
				}
			} else if (message.role === "toolResult" && message.toolCallId === toolCallId) {
				result = message;
			}
		}
		if (!call || !result) throw new Error(`AVO could not resolve completed tool call ${toolCallId}`);
		if (result.toolName !== call.name) throw new Error("AVO tool call and result names do not match");
		if (result.isError) throw new Error("AVO cannot bind an errored tool result as external evidence");
		const trustedNames = new Set([
			"web_search",
			"google_search",
			"google_search_retrieval",
			"browser_search",
			"weather",
			"finance",
			"sports",
		]);
		const definitionEntry = this._toolDefinitions.get(call.name);
		const isProviderNative = definitionEntry === undefined && trustedNames.has(call.name);
		const isPrimeBuiltin =
			this._baseToolsOverride === undefined &&
			trustedNames.has(call.name) &&
			definitionEntry?.sourceInfo.source === "builtin" &&
			definitionEntry.sourceInfo.path === `<builtin:${call.name}>`;
		if (!isProviderNative && !isPrimeBuiltin) {
			throw new Error(`tool ${call.name} is not a host-trusted external evidence provider`);
		}
		if (result.timestamp < callTimestamp) {
			throw new Error("AVO external tool result predates its tool call");
		}
		return { call, callTimestamp, result };
	}

	private _readRlmLastAssistantText(subagent: RlmSubagentRegistryEntry): string | undefined {
		const liveSession =
			this._activeRlmChildRuns.get(subagent.rlm_child_id)?.session ??
			this._rlmChildSessions.get(subagent.rlm_child_id);
		const liveText = liveSession?.getLastAssistantText();
		if (liveText) return liveText;
		try {
			const descriptorPath = join(subagent.session_dir, "rlm-subagent.json");
			const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as unknown;
			if (!isObjectRecord(descriptor)) return undefined;
			if (descriptor.childId !== subagent.rlm_child_id || descriptor.sessionName !== subagent.session_name) {
				return undefined;
			}
			if (typeof descriptor.sessionFile !== "string") return undefined;
			const sessionDir = resolve(subagent.session_dir);
			const sessionFile = resolve(descriptor.sessionFile);
			if (dirname(sessionFile) !== sessionDir || !existsSync(sessionFile)) return undefined;
			const branch = [...SessionManager.open(sessionFile).getBranch()].reverse();
			for (const entry of branch) {
				if (entry.type !== "message" || entry.message.role !== "assistant") continue;
				const text = entry.message.content
					.filter((item): item is TextContent => item.type === "text")
					.map((item) => item.text)
					.join("\n");
				if (text) return text;
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private async _verifyAvoClaimEvidenceIndependently(
		candidateId: string,
		claimId: string,
		claimText: string,
		exactQuote: string,
		objective: string,
		candidateClaims: readonly string[],
		candidatePayloadDigest: string,
	): Promise<{
		verdict: AvoIndependentClaimVerdict;
		verifierChildId?: string;
		verifierModel?: string;
		responseDigest?: string;
		error?: string;
	}> {
		const marker = avoClaimVerifierMarker(candidateId, claimId);
		try {
			const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
			const handle = await this._startRlmChildRun(
				buildAvoClaimVerifierPrompt(
					marker,
					claimText,
					exactQuote,
					objective,
					candidateClaims,
					candidatePayloadDigest,
				),
				{ name: `avo-claim-verifier-${suffix}` },
				undefined,
				{ allowedToolNames: [] },
			);
			await this._awaitPendingRlmChildSettlement(handle.name);
			const children = (await this.listRlmSubagents()).subagents;
			const child =
				children.find((item) => item.rlm_child_id === handle.rlm_child_id || item.session_name === handle.name) ??
				this._persistedAutoresearchSubagent(handle.rlm_child_id, handle.name);
			if (!child) throw new Error("claim verifier child was not retained for host inspection");
			const response = this._readRlmLastAssistantText(child);
			if (!response) throw new Error("claim verifier child produced no final text");
			return {
				verdict: parseAvoClaimVerifierMessage(response, marker),
				verifierChildId: handle.rlm_child_id,
				verifierModel: handle.model,
				responseDigest: createHash("sha256").update(response).digest("hex"),
			};
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			return {
				verdict: {
					relation: "insufficient",
					reason: `independent verifier unavailable: ${reason}`,
					objectiveRelation: "insufficient",
					objectiveReason: `independent verifier unavailable: ${reason}`,
				},
				error: reason,
			};
		}
	}

	private async _runIsolatedAvoMemoryModel(
		prompt: string,
		namePrefix: string,
	): Promise<{ text: string; childId: string; model: string; responseDigest: string }> {
		const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
		const handle = await this._startRlmChildRun(prompt, { name: `${namePrefix}-${suffix}` }, undefined, {
			allowedToolNames: [],
		});
		await this._awaitPendingRlmChildSettlement(handle.name);
		const children = (await this.listRlmSubagents()).subagents;
		const child =
			children.find((item) => item.rlm_child_id === handle.rlm_child_id || item.session_name === handle.name) ??
			this._persistedAutoresearchSubagent(handle.rlm_child_id, handle.name);
		if (!child) throw new Error("isolated memory model was not retained for host inspection");
		const text = this._readRlmLastAssistantText(child);
		if (!text) throw new Error("isolated memory model produced no final text");
		return {
			text,
			childId: handle.rlm_child_id,
			model: handle.model,
			responseDigest: createHash("sha256").update(text).digest("hex"),
		};
	}

	private async _runAvoGenerativeMemoryReflection(
		cycleId: string,
		trigger: "five_cycles" | "candidate_acceptance" | "supervisor_intervention",
	): Promise<Record<string, unknown>> {
		if (isAvoFeatureAblated("nooa")) return { ok: false, reason: "NOOA disabled by benchmark ablation" };
		const runtime = this._requireAvoRuntime();
		const deliveryClosed = () => {
			const latest = runtime.getState();
			return (
				latest.status !== "active" ||
				latest.delivery.phase === "pending" ||
				latest.delivery.phase === "delivered" ||
				latest.delivery.phase === "failed"
			);
		};
		const state = runtime.getState();
		if (deliveryClosed()) {
			return { ok: false, skipped: "canonical delivery is pending" };
		}
		if (
			state.memoryReflections.some(
				(reflection) => reflection.cycleId === cycleId && (reflection.proposedMemoryIds?.length ?? 0) > 0,
			)
		) {
			return { ok: true, skipped: "cycle already has generative memory proposals" };
		}
		const episodes = runtime.store.verifiedEpisodesForReflection(12);
		if (episodes.length < 2) return { ok: false, reason: "at least two verified episodes are required" };
		const reasonerMarker = `AVO_MEMORY_REASONER_JSON:${cycleId}:${randomUUID().replaceAll("-", "")}`;
		let reasoner: Awaited<ReturnType<AgentSession["_runIsolatedAvoMemoryModel"]>>;
		try {
			reasoner = await this._runIsolatedAvoMemoryModel(
				buildAvoMemoryReasonerPrompt(reasonerMarker, episodes),
				"avo-memory-reasoner",
			);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		let proposals: ReturnType<typeof parseAvoMemoryReasonerMessage>;
		try {
			proposals = parseAvoMemoryReasonerMessage(
				reasoner.text,
				reasonerMarker,
				new Set(episodes.map((episode) => episode.memoryId)),
			);
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
				reasoner_child_id: reasoner.childId,
			};
		}
		const proposedMemories = proposals.map((proposal) =>
			runtime.store.rememberProposedForRole(
				{
					namespace: state.routing.environment,
					type: "reflection",
					scope: "project",
					title: proposal.title,
					content: proposal.content,
					tags: proposal.tags,
					importance: 6,
					sourceIds: proposal.sourceEpisodeIds,
					references: proposal.sourceEpisodeIds.map((memoryId) => ({ kind: "memory", key: memoryId })),
				},
				"avo-supervisor",
			),
		);
		if (proposedMemories.length === 0) {
			const reflection = runtime.store.recordMemoryReflection({
				trigger,
				cycleId,
				report: {
					reasoner_proposals: 0,
					reasoner_child_id: reasoner.childId,
					reasoner_model: reasoner.model,
				},
				archivedMemoryIds: [],
				proposedMemoryIds: [],
				verifiedMemoryIds: [],
			});
			return { ok: true, reflection };
		}
		const verifierMarker = `AVO_MEMORY_VERIFIER_JSON:${cycleId}:${randomUUID().replaceAll("-", "")}`;
		let verifier: Awaited<ReturnType<AgentSession["_runIsolatedAvoMemoryModel"]>>;
		try {
			verifier = await this._runIsolatedAvoMemoryModel(
				buildAvoMemoryVerifierPrompt(verifierMarker, episodes, proposedMemories),
				"avo-memory-verifier",
			);
		} catch (error) {
			if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
			const reflection = runtime.store.recordMemoryReflection({
				trigger,
				cycleId,
				report: {
					reasoner_proposals: proposedMemories.length,
					verifier_error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
				},
				archivedMemoryIds: [],
				proposedMemoryIds: proposedMemories.map((memory) => memory.memoryId),
				verifiedMemoryIds: [],
			});
			return { ok: false, reflection, reason: "independent memory verifier was unavailable" };
		}
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		let decisions: ReturnType<typeof parseAvoMemoryVerifierMessage>;
		try {
			decisions = parseAvoMemoryVerifierMessage(
				verifier.text,
				verifierMarker,
				new Set(proposedMemories.map((memory) => memory.memoryId)),
			);
		} catch (error) {
			if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
			const reflection = runtime.store.recordMemoryReflection({
				trigger,
				cycleId,
				report: {
					reasoner_proposals: proposedMemories.length,
					verifier_error: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
				},
				archivedMemoryIds: [],
				proposedMemoryIds: proposedMemories.map((memory) => memory.memoryId),
				verifiedMemoryIds: [],
			});
			return { ok: false, reflection, reason: "independent memory verifier reply failed closed" };
		}
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		const verifiedMemoryIds: string[] = [];
		for (const decision of decisions) {
			const evidenceRef = `memory-verifier:${verifier.childId}:${verifier.responseDigest}`;
			if (decision.verdict === "supports") {
				runtime.store.verifyProposedMemory(decision.memoryId, evidenceRef);
				verifiedMemoryIds.push(decision.memoryId);
			} else {
				runtime.store.contestMemory(decision.memoryId, `${evidenceRef}:${decision.reason}`);
			}
		}
		const reflection = runtime.store.recordMemoryReflection({
			trigger,
			cycleId,
			report: {
				reasoner_proposals: proposedMemories.length,
				verifier_supported: verifiedMemoryIds.length,
				verifier_rejected: proposedMemories.length - verifiedMemoryIds.length,
				reasoner_child_id: reasoner.childId,
				verifier_child_id: verifier.childId,
				verifier_model: verifier.model,
			},
			archivedMemoryIds: [],
			proposedMemoryIds: proposedMemories.map((memory) => memory.memoryId),
			verifiedMemoryIds,
		});
		const consolidation = await runtime.reflectMemory("post_task", cycleId);
		return { ok: true, reflection, consolidation };
	}

	private async _runAvoGenerativeMemoryReconciliation(cycleId: string): Promise<Record<string, unknown>> {
		if (isAvoFeatureAblated("nooa")) return { ok: false, reason: "NOOA disabled by benchmark ablation" };
		const runtime = this._requireAvoRuntime();
		const deliveryClosed = () => {
			const latest = runtime.getState();
			return (
				latest.status !== "active" ||
				latest.delivery.phase === "pending" ||
				latest.delivery.phase === "delivered" ||
				latest.delivery.phase === "failed"
			);
		};
		if (deliveryClosed()) {
			return { ok: false, skipped: "canonical delivery is pending" };
		}
		const proposedClusters = await runtime.reconciliationCandidates();
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		const memories = runtime.getState().memories;
		const byId = new Map(memories.map((memory) => [memory.memoryId, memory]));
		const clusters = proposedClusters
			.flatMap((cluster) => {
				const groups = new Map<string, string[]>();
				for (const memoryId of cluster.memoryIds) {
					const memory = byId.get(memoryId);
					if (
						!memory ||
						memory.invalidatedAt ||
						memory.verificationState === "contested" ||
						!(["info", "skill", "reflection"] as const).includes(memory.type as "info" | "skill" | "reflection")
					)
						continue;
					const key = `${memory.type}:${memory.namespace}:${memory.scope}`;
					groups.set(key, [...(groups.get(key) ?? []), memoryId]);
				}
				return [...groups.values()].filter(
					(memoryIds) =>
						memoryIds.length >= 2 &&
						memoryIds.some((memoryId) => byId.get(memoryId)?.verificationState === "verified"),
				);
			})
			.slice(0, 8)
			.map((memoryIds, index) => ({ clusterId: `recon-${index + 1}`, memoryIds }));
		if (clusters.length === 0) return { ok: true, skipped: "NOOA found no reconsolidation clusters" };

		const reconcilerMarker = `AVO_MEMORY_RECONCILER_JSON:${cycleId}:${randomUUID().replaceAll("-", "")}`;
		let reconciler: Awaited<ReturnType<AgentSession["_runIsolatedAvoMemoryModel"]>>;
		try {
			reconciler = await this._runIsolatedAvoMemoryModel(
				buildAvoMemoryReconcilerPrompt(reconcilerMarker, clusters, memories),
				"avo-memory-reconciler",
			);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		let decisions: ReturnType<typeof parseAvoMemoryReconcilerMessage>;
		try {
			decisions = parseAvoMemoryReconcilerMessage(reconciler.text, reconcilerMarker, clusters).filter(
				(decision) => decision.currentMemoryId && decision.supersedeMemoryIds.length > 0,
			);
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
				reconciler_child_id: reconciler.childId,
			};
		}
		if (decisions.length === 0) return { ok: true, reconciled: 0, reconciler_child_id: reconciler.childId };

		const verifierMarker = `AVO_MEMORY_RECONCILIATION_VERIFIER_JSON:${cycleId}:${randomUUID().replaceAll("-", "")}`;
		let verifier: Awaited<ReturnType<AgentSession["_runIsolatedAvoMemoryModel"]>>;
		try {
			verifier = await this._runIsolatedAvoMemoryModel(
				buildAvoMemoryReconciliationVerifierPrompt(verifierMarker, clusters, memories, decisions),
				"avo-memory-reconciliation-verifier",
			);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		let verification: ReturnType<typeof parseAvoMemoryReconciliationVerifierMessage>;
		try {
			verification = parseAvoMemoryReconciliationVerifierMessage(
				verifier.text,
				verifierMarker,
				new Set(decisions.map((decision) => decision.clusterId)),
			);
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error) };
		}
		if (deliveryClosed()) return { ok: false, skipped: "canonical delivery became terminal" };
		const supported = new Set(
			verification.filter((decision) => decision.verdict === "supports").map((decision) => decision.clusterId),
		);
		const archivedMemoryIds: string[] = [];
		const errors: string[] = [];
		for (const decision of decisions) {
			if (!supported.has(decision.clusterId) || !decision.currentMemoryId) continue;
			try {
				const archived = runtime.store.reconcileMemories(
					decision.currentMemoryId,
					decision.supersedeMemoryIds,
					`memory-reconciliation:${reconciler.childId}:${reconciler.responseDigest}:${verifier.childId}:${verifier.responseDigest}`,
				);
				archivedMemoryIds.push(...archived.map((memory) => memory.memoryId));
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		const reflection = runtime.store.recordMemoryReflection({
			trigger: "post_task",
			cycleId,
			report: {
				nooa_candidate_clusters: clusters.length,
				reconciler_actionable: decisions.length,
				verifier_supported: supported.size,
				host_superseded: archivedMemoryIds.length,
				reconciliation_errors: errors.length,
				reconciler_child_id: reconciler.childId,
				verifier_child_id: verifier.childId,
			},
			archivedMemoryIds,
			proposedMemoryIds: [],
			verifiedMemoryIds: [],
		});
		return { ok: errors.length === 0, reflection, errors };
	}

	private _formatAvoStatus(): string {
		const state = this._requireAvoRuntime().getState();
		const gate = this._evaluateAvoHostBoundStopGate();
		return [
			"AVO is active by default for this root task.",
			`Task run: ${state.runId} (${state.taskRuns.length} archived in this session)`,
			`Automatic evaluation adapter: ${state.routing.environment}`,
			`AVO horizon: ${state.routing.horizon} (selection: ${state.horizonSelection})`,
			`Verification class: ${state.verificationClass}`,
			`Verification policy: ${state.verificationPolicy}`,
			`Status: ${state.status}; cycles: ${state.cycles.length}; candidates: ${state.candidates.length}`,
			`Obligations: ${state.obligationCoverage.length} bound coverage receipts across ${state.obligations.length} requirements; critical assumptions: ${state.criticalAssumptions.filter((item) => item.status === "supported").length}/${state.criticalAssumptions.filter((item) => item.critical).length} supported`,
			`Final gate: ${gate.passed ? "passed" : `blocked — ${gate.reasons.join("; ")}`}`,
		].join("\n");
	}

	private _avoWorkspaceExcludedRoots(): string[] {
		const artifactDir = this.sessionManager.getSessionArtifactDir();
		return [this.sessionManager.getSessionDir(), ...(artifactDir ? [artifactDir] : [])];
	}

	private _ensureAvoCodingVerificationBaseline(): void {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		if (state.routing.environment !== "coding" || state.verificationBaseline || !state.objective) return;
		const cwd = this.sessionManager.getCwd();
		const baseline = captureAvoCodingVerificationBaseline(cwd, state.objective, {
			excludedRoots: this._avoWorkspaceExcludedRoots(),
		});
		baseline.specContract = captureAvoSpecContractBaseline(baseline.workspaceRoot ?? cwd, baseline.capturedAt, {
			receiptPublicKey: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY,
		});
		runtime.store.setVerificationBaseline(baseline);
	}

	private _ensureAvoArtifactVerificationBaseline(): void {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		if (
			state.routing.environment !== "general" ||
			state.verificationClass !== "artifact" ||
			state.artifactBaselinePaths
		) {
			return;
		}
		runtime.store.setArtifactBaselinePaths(
			captureAvoArtifactPathBaseline(this.sessionManager.getCwd(), {
				excludedRoots: this._avoWorkspaceExcludedRoots(),
			}),
		);
	}

	private _captureAvoProgressWatchdogSnapshot(state: AvoRunState) {
		let workspaceDigest: string | undefined;
		if (state.routing.environment === "coding") {
			try {
				workspaceDigest = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				}).digest;
			} catch {
				// An unavailable workspace cannot be counted as progress; the completion gate remains fail closed.
			}
		}
		return deriveAvoProgressWatchdogSnapshot(state, workspaceDigest);
	}

	private _primeAvoProgressWatchdog(): void {
		if (!this._avoRuntime) return;
		const snapshot = this._captureAvoProgressWatchdogSnapshot(this._avoRuntime.getState());
		this._avoProgressWatchdog.prime(snapshot);
		if (this._avoToolProgressRunId !== snapshot.runId) {
			this._avoToolProgressRunId = snapshot.runId;
			this._avoToolProgressToken = snapshot.token;
			this._avoToolNoProgressBatches = 0;
			this._avoToolInterventionQueued = false;
			this._avoToolInterventionCount = 0;
			this._avoToolLastInterventionBatch = 0;
		}
	}

	private _avoToolProbationReason(toolName: string, args: unknown): string | undefined {
		if (
			isAvoFeatureAblated("qualified_watchdog") ||
			!this._enforceAvoCompletion ||
			!this._avoRuntime ||
			this._rlmDepth !== 0 ||
			!this._avoToolInterventionQueued ||
			this._avoToolInterventionCount < 1 ||
			toolName !== "ipython"
		) {
			return undefined;
		}
		const state = this._avoRuntime.getState();
		if (!state.objective || state.status !== "active") {
			return undefined;
		}
		const code = isObjectRecord(args) && typeof args.code === "string" ? args.code : "";
		const recovery = this._avoToolRecoveryContract(state);
		if (
			recovery.allowedCalls.some((call) => new RegExp(`\\bawait\\s+(?:avo\\s*\\.\\s*)?${call}\\s*\\(`).test(code))
		) {
			return undefined;
		}
		return [
			`AVO host tool probation blocked a non-milestone IPython call after ${this._avoToolNoProgressBatches} stalled tool batches and ${this._avoToolInterventionCount} intervention(s).`,
			`The active candidate-admission contract remains horizon=${state.routing.horizon}, required_premortem_assumptions=${requiredAvoPremortemAssumptionCount(state)}; watchdog steering cannot add new candidate prerequisites after work begins.`,
			recovery.guidance,
			"Probation clears automatically when the host observes a meaningful verification milestone.",
		].join(" ");
	}

	private _avoPythonContractViolationReason(toolName: string, args: unknown): string | undefined {
		if (!this._enforceAvoCompletion || !this._avoRuntime || this._rlmDepth !== 0 || toolName !== "ipython") {
			return undefined;
		}
		const state = this._avoRuntime.getState();
		if (!state.objective || state.status !== "active") return undefined;
		const code = isObjectRecord(args) && typeof args.code === "string" ? args.code : "";
		const introspectsAvo = [
			/\bdir\s*\(\s*avo\s*\)/,
			/\bhelp\s*\(\s*avo(?:\.|\s*\))/,
			/\bhasattr\s*\(\s*avo\s*,/,
			/\binspect\s*\.\s*(?:signature|getsource|getmembers)\s*\(\s*avo(?:\.|\s*\))/,
			/\bavo\s*\.\s*__dict__\b/,
		].some((pattern) => pattern.test(code));
		if (!introspectsAvo) return undefined;
		return [
			"AVO public API introspection is blocked: the injected AVO contract is complete, so do not call dir(), help(), hasattr(), inspect.signature(), inspect.getsource(), inspect.getmembers(), or __dict__ on avo.",
			this._avoToolRecoveryContract(state).guidance,
		].join(" ");
	}

	private _avoToolRecoveryContract(state: AvoRunState): { allowedCalls: string[]; guidance: string } {
		const meaningfulBaselineCount =
			state.verificationBaseline?.executions.filter((execution) => execution.meaningful).length ?? 0;
		if (state.routing.environment === "coding" && meaningfulBaselineCount === 0) {
			if (state.candidates.length > 0 || state.evaluations.length > 0 || state.cycles.length > 0) {
				return {
					allowedCalls: [],
					guidance:
						"No recovery action is admissible: candidate work exists without the required immutable baseline, and a baseline cannot be backfilled after candidate work. Start a fresh task run; do not retry the candidate or verifier.",
				};
			}
			return {
				allowedCalls: ["run_coding_baseline"],
				guidance:
					"Next action: run the required immutable baseline with await avo.run_coding_baseline(<exact direct test command>).",
			};
		}
		if (state.candidates.length === 0) {
			const requiredAssumptions = requiredAvoPremortemAssumptionCount(state);
			const registeredAssumptions = state.criticalAssumptions.filter((assumption) => assumption.critical).length;
			if (registeredAssumptions < requiredAssumptions) {
				let workspaceChanged = false;
				try {
					workspaceChanged = this._captureAvoProgressWatchdogSnapshot(state).workspaceChanged;
				} catch {
					workspaceChanged = true;
				}
				if (workspaceChanged) {
					return {
						allowedCalls: [],
						guidance:
							"No candidate action is currently admissible: the required pre-mortem was not registered before the workspace changed. Restore the task-start workspace or start a fresh task run; do not inspect APIs or retry add_candidate.",
					};
				}
				return {
					allowedCalls: ["register_critical_assumptions"],
					guidance: `Next action: register ${requiredAssumptions - registeredAssumptions} more distinct critical assumption(s) with concrete falsification plans using await avo.register_critical_assumptions(...).`,
				};
			}
			if (state.routing.environment !== "coding" && state.verificationPolicy !== "required") {
				return {
					allowedCalls: ["add_candidate"],
					guidance:
						'Next action: in one bounded cell create the final candidate with candidate = await avo.add_candidate(...), take candidate_id = candidate["candidate"]["candidateId"], immediately record evaluation = await avo.record_evaluation({"candidate_id":candidate_id,"evaluator_id":"model_opinion","status":"pass","authority":"model_opinion","evidence_refs":[],"metrics":{"reviewed":true}}), cover candidate["candidate"]["obligationIds"] with that evaluation ID, complete the cycle, and call await avo.stop_gate(). Do not invent another API name or split this lifecycle across exploratory cells.',
				};
			}
			return {
				allowedCalls: ["add_candidate"],
				guidance:
					"Next action: in one bounded cell, finish the task-file change if needed and call await avo.add_candidate(...) bound to that exact workspace. Do not perform another read-only probe.",
			};
		}
		const candidate = state.candidates.at(-1)!;
		const candidateCycle = [...state.cycles].reverse().find((cycle) => cycle.candidateId === candidate.candidateId);
		if (candidateCycle && candidateCycle.outcome !== "accepted") {
			return {
				allowedCalls: ["add_candidate"],
				guidance: `Next action: make a material correction and call await avo.add_candidate(...) with parent_candidate_id=${candidate.candidateId}; do not rerun evidence against the superseded candidate.`,
			};
		}
		const evaluations = state.evaluations.filter((evaluation) => evaluation.candidateId === candidate.candidateId);
		if (evaluations.length === 0) {
			if (state.verificationPolicy !== "required") {
				return {
					allowedCalls: ["record_evaluation"],
					guidance: `Next action: record the transparent best-effort review exactly with evaluation = await avo.record_evaluation({"candidate_id":"${candidate.candidateId}","evaluator_id":"model_opinion","status":"pass","authority":"model_opinion","evidence_refs":[],"metrics":{"reviewed":true}}). This is explicitly model opinion, not host or external proof.`,
				};
			}
			return {
				allowedCalls: ["run_evaluation", "verify_deterministic_result", "verify_artifacts"],
				guidance: `Next action: run one direct candidate-bound verifier for candidate_id=${candidate.candidateId} with await avo.run_evaluation(...), or the host verifier required by the active verification class.`,
			};
		}
		if (!evaluations.some((evaluation) => evaluation.status === "pass")) {
			return {
				allowedCalls: ["complete_cycle"],
				guidance: `Next action: call await avo.complete_cycle({"candidate_id":"${candidate.candidateId}"}) once so the host records the failed or inconclusive outcome; then make a material successor rather than retesting unchanged work.`,
			};
		}
		const uncovered = state.obligations.filter(
			(obligation) =>
				obligation.critical &&
				!state.obligationCoverage.some(
					(coverage) =>
						coverage.candidateId === candidate.candidateId && coverage.obligationId === obligation.obligationId,
				),
		);
		if (uncovered.length > 0) {
			return {
				allowedCalls: ["cover_obligation", "cover_obligations", "run_evaluation"],
				guidance: `Next action: bind passing candidate evidence to the ${uncovered.length} uncovered critical obligation(s) with await avo.cover_obligations(...); run a distinct direct verifier first if the existing receipt is not sufficient.`,
			};
		}
		const openAssumptions = state.criticalAssumptions.filter(
			(assumption) => assumption.critical && assumption.status === "open",
		);
		if (openAssumptions.length > 0) {
			return {
				allowedCalls: ["resolve_critical_assumption", "run_evaluation"],
				guidance: `Next action: run the preregistered distinct falsification check, then call await avo.resolve_critical_assumption(...) for ${openAssumptions[0]!.assumptionId}.`,
			};
		}
		if (!state.cycles.some((cycle) => cycle.candidateId === candidate.candidateId)) {
			return {
				allowedCalls: ["complete_cycle"],
				guidance: `Next action: call await avo.complete_cycle({"candidate_id":"${candidate.candidateId}"}) and inspect the host outcome.`,
			};
		}
		return {
			allowedCalls: ["stop_gate", "complete"],
			guidance: "Next action: call await avo.stop_gate() and follow its exact blocker or canonical-delivery result.",
		};
	}

	private async _queueAvoToolStagnationIntervention(
		state: AvoRunState,
		input: {
			reason: string;
			escalationLevel: number;
			trigger: string;
			instruction?: string;
			forceIntervene?: boolean;
		},
	): Promise<void> {
		// A watchdog prompt is useful only when another provider turn is
		// admissible. Do not let an internal anti-laziness action bypass the
		// same autonomous limit that stops ordinary continuations.
		if (this._hasReachedAutonomousLimit() || this._pendingAvoCanonicalDelivery()) return;
		this._avoRuntime?.store.recordProgressWatchdogCheckpoint({
			consecutiveNoProgressTurns: this._avoToolNoProgressBatches,
			resumed: false,
			reason: input.reason,
			// Tool-loop steering must not mutate the candidate-admission contract.
			// The horizon is selected before work; intervention only constrains the
			// next action to the next already-admissible host milestone.
			escalateHorizon: false,
			forceIntervene: input.forceIntervene,
			unit: "tool_batch",
		});
		const message: CustomMessage = {
			role: "custom",
			customType: "avo_progress_intervention",
			content: [
				"<avo_progress_intervention>",
				input.reason,
				input.instruction ??
					(input.escalationLevel === 1
						? "Stop broad exploration and do not inspect Prime/AVO internals. The next tool action must invoke the next admissible AVO milestone."
						: "The previous intervention was ignored. The next tool action must invoke the next admissible AVO milestone; no extra diagnostic call is permitted."),
				this._avoToolRecoveryContract(state).guidance,
				`The active candidate-admission contract remains horizon=${state.routing.horizon}, required_premortem_assumptions=${requiredAvoPremortemAssumptionCount(state)}. This intervention does not add prerequisites.`,
				"Do not repeat a failed or unrelated command merely to keep the tool loop active.",
				"</avo_progress_intervention>",
			].join("\n"),
			display: true,
			details: {
				runId: state.runId,
				toolBatchesWithoutProgress: this._avoToolNoProgressBatches,
				escalationLevel: input.escalationLevel,
				trigger: input.trigger,
			},
			timestamp: Date.now(),
		};
		const normalized = normalizeMessageContent(message.content);
		await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
		});
	}

	private _pendingAvoCanonicalDelivery(): AvoRunState["delivery"] | undefined {
		if (!this._avoRuntime || this._rlmDepth !== 0) return undefined;
		const state = this._avoRuntime.getState();
		return state.status === "active" &&
			state.delivery.phase === "pending" &&
			!this._avoCanonicalDeliveryFailedRunIds.has(state.runId)
			? state.delivery
			: undefined;
	}

	private _isAvoCanonicalDeliveryTerminalFailure(): boolean {
		const state = this._avoRuntime?.getState();
		return (
			state !== undefined &&
			(state.delivery.phase === "failed" ||
				state.status === "failed" ||
				this._avoCanonicalDeliveryFailedRunIds.has(state.runId))
		);
	}

	private _isRepairableAvoCanonicalMemoryFailure(error: unknown): boolean {
		const reason = error instanceof Error ? error.message : String(error);
		return /canonical accepted-cycle memory (?:is missing|is missing or invalidated|does not match its cycle)/i.test(
			reason,
		);
	}

	private async _withAvoCanonicalDeliverySerialization<T>(operation: () => Promise<T>): Promise<T> {
		const next = this._avoCanonicalDeliverySerializer.then(operation, operation);
		this._avoCanonicalDeliverySerializer = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private async _beginAvoCanonicalDeliveryLocked(gate: AvoStopGate): Promise<AvoCanonicalDeliveryBinding | undefined> {
		if (!this._avoRuntime) throw new Error("AVO runtime is unavailable");
		let state = this._avoRuntime.getState();
		if (state.status !== "active") return undefined;
		if (state.delivery.phase === "pending") {
			return captureAvoCanonicalDeliveryGeneration(state);
		}
		if (state.delivery.phase !== "accepted") return undefined;
		let expectedGeneration = captureAvoCanonicalDeliveryGeneration(state);
		if (!expectedGeneration) return undefined;
		let effectiveGate = gate;
		// Give the durable NOOA sidecar a chance to activate the protected cycle
		// episode before sealing delivery. The canonical store remains the fail-
		// closed authority if the sidecar is unavailable.
		await this._avoRuntime.syncMemory().catch(() => undefined);
		if (this._disposed || this._disposing || !this._avoRuntime) return undefined;
		state = this._avoRuntime.getState();
		if (state.status !== "active") return undefined;
		if (state.delivery.phase === "pending") {
			return captureAvoCanonicalDeliveryGeneration(state);
		}
		if (state.delivery.phase !== "accepted") return undefined;
		if (!matchesAvoCanonicalDeliveryGeneration(state, expectedGeneration, "accepted")) {
			// Memory refreshes and concurrent host mutations can advance the accepted
			// generation while the sidecar is awaited. Only a freshly projected full
			// gate may seal that new owner.
			effectiveGate = this._evaluateAvoStopGateWithCanonicalRepair();
			state = this._avoRuntime.getState();
			expectedGeneration = captureAvoCanonicalDeliveryGeneration(state);
			if (!effectiveGate.passed || !expectedGeneration || state.delivery.phase !== "accepted") return undefined;
		}
		try {
			this._avoRuntime.store.beginCanonicalDelivery(effectiveGate);
		} catch (error) {
			if (!this._isRepairableAvoCanonicalMemoryFailure(error)) throw error;
			this._avoRuntime.store.repairCanonicalDeliveryMemory();
			state = this._avoRuntime.getState();
			expectedGeneration = captureAvoCanonicalDeliveryGeneration(state);
			if (!expectedGeneration || state.delivery.phase !== "accepted") return undefined;
			await this._avoRuntime.syncMemory().catch(() => undefined);
			if (this._disposed || this._disposing || !this._avoRuntime) return undefined;
			state = this._avoRuntime.getState();
			if (state.status !== "active") return undefined;
			if (state.delivery.phase === "pending") {
				return captureAvoCanonicalDeliveryGeneration(state);
			}
			if (state.delivery.phase !== "accepted") return undefined;
			// Repair and its sidecar sync both mutate durable evidence. Re-project the
			// complete host gate even when the accepted identity appears unchanged.
			effectiveGate = this._evaluateAvoStopGateWithCanonicalRepair();
			state = this._avoRuntime.getState();
			expectedGeneration = captureAvoCanonicalDeliveryGeneration(state);
			if (!effectiveGate.passed || !expectedGeneration || state.delivery.phase !== "accepted") return undefined;
			this._avoRuntime.store.beginCanonicalDelivery(effectiveGate);
		}
		state = this._avoRuntime.getState();
		const pendingGeneration = captureAvoCanonicalDeliveryGeneration(state);
		if (!pendingGeneration || state.delivery.phase !== "pending") return undefined;
		this._closeAvoCanonicalDeliveryBackgroundWork();
		this._clearQueuedAutonomousContinuations();
		this._clearQueuedGoalContexts();
		this._fenceAvoCanonicalDeliveryInputs();
		return pendingGeneration;
	}

	private _closeAvoCanonicalDeliveryBackgroundWork(): void {
		const pending = this._pendingAvoCanonicalDelivery();
		const state = this._avoRuntime?.getState();
		const terminalRunId =
			state !== undefined &&
			(state.delivery.phase === "failed" ||
				state.status === "failed" ||
				this._avoCanonicalDeliveryFailedRunIds.has(state.runId))
				? state.runId
				: undefined;
		const closingRunId = pending?.runId ?? terminalRunId;
		if (!closingRunId || this._avoCanonicalDeliveryClosedRunIds.has(closingRunId)) return;
		this._avoCanonicalDeliveryClosedRunIds.add(closingRunId);
		this._autoRefineReviewAbort?.abort();
		this._refineAbortController?.abort();
		this._autoCompactionAbortController?.abort();
		this._autoRefineBranchVersion++;
		this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._pendingRequestedRefine = undefined;
		this._assistantTurnsSinceAutoRefine = 0;
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.status !== "queued" && run.status !== "running") continue;
			// Canonical delivery is an exclusive terminal phase. A child whose
			// runtime is still being constructed must neither reach its provider nor
			// enqueue a late terminal notice after the gate has sealed. Abandoning
			// quiescence here also prevents canonical delivery from waiting on a
			// startup/provider call which has already been aborted.
			run.suppressTerminalNotice = true;
			if (this._cancelRlmChildRun(run, "AVO canonical delivery is pending")) {
				if (!run.abandonedForQuiescence) this._abandonRlmRunForQuiescence(run);
			}
		}
		if (this._serializedPlanInFlight) {
			void this._consumeSerializedBackgroundPlan(async () => false).catch(() => undefined);
		}
	}

	private _completeAvoCanonicalDelivery(observedCanonicalText: string): void {
		if (!this._avoRuntime) throw new Error("AVO runtime is unavailable");
		// Pending owns an immutable persisted gate receipt. Final delivery must be
		// only a digest comparison plus local store finalization; never re-run the
		// mutable stop gate or create another evaluation here.
		this._avoRuntime.store.completeCanonicalDelivery(observedCanonicalText);
	}

	private _completePersistedAvoCanonicalDeliveryIfPresent(): boolean {
		const pending = this._pendingAvoCanonicalDelivery();
		const expectedBinding = parseAvoCanonicalDeliveryBinding(pending);
		if (!expectedBinding) return false;
		const messages = this.agent.state.messages;
		for (let assistantIndex = messages.length - 1; assistantIndex >= 0; assistantIndex--) {
			const message = messages[assistantIndex];
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason === "error" || assistant.stopReason === "aborted") return false;

			let matchedPrompt = false;
			for (let promptIndex = assistantIndex - 1; promptIndex >= 0; promptIndex--) {
				const prompt = messages[promptIndex];
				if (prompt.role === "assistant" || prompt.role === "user") break;
				if (prompt.role !== "custom" || prompt.customType !== "avo_canonical_delivery_required") continue;
				if (matchesAvoCanonicalDeliveryBinding(prompt.details, expectedBinding)) {
					matchedPrompt = true;
					break;
				}
			}
			if (!matchedPrompt) return false;

			const observedText = readAvoAssistantDeliveryText(assistant);
			if (digestAvoDeliveryText(observedText) !== expectedBinding.deliveryDigest) return false;
			try {
				this._completeAvoCanonicalDelivery(observedText);
				this._avoCanonicalDeliveryQueuedRunId = undefined;
				this._avoCanonicalDeliveryQueuedBinding = undefined;
				this._avoCanonicalDeliveryDirectBinding = undefined;
				this._avoCanonicalDeliveryAttemptBinding = undefined;
				return true;
			} catch (error) {
				this._recordAvoCanonicalDeliveryFailure(error, expectedBinding);
				return false;
			}
		}
		return false;
	}

	private _persistedAvoCanonicalDeliveryProviderFailure():
		| { message: AssistantMessage; binding: AvoCanonicalDeliveryBinding }
		| undefined {
		const pending = this._pendingAvoCanonicalDelivery();
		const expectedBinding = parseAvoCanonicalDeliveryBinding(pending);
		if (!expectedBinding) return undefined;
		const messages = this.agent.state.messages;
		for (let assistantIndex = messages.length - 1; assistantIndex >= 0; assistantIndex--) {
			const message = messages[assistantIndex];
			if (message.role !== "assistant") continue;
			const assistant = message as AssistantMessage;
			if (assistant.stopReason !== "error") return undefined;
			for (let promptIndex = assistantIndex - 1; promptIndex >= 0; promptIndex--) {
				const prompt = messages[promptIndex];
				if (prompt.role === "assistant" || prompt.role === "user") return undefined;
				if (prompt.role !== "custom") continue;
				if (prompt.customType !== "avo_canonical_delivery_required") continue;
				return matchesAvoCanonicalDeliveryBinding(prompt.details, expectedBinding)
					? { message: assistant, binding: expectedBinding }
					: undefined;
			}
			return undefined;
		}
		return undefined;
	}

	private _completeAvoCanonicalDeliveryFromHostFallback(
		providerFailure: AssistantMessage,
		expectedBinding: AvoCanonicalDeliveryBinding,
	): boolean {
		if (!this._avoRuntime) return false;
		const state = this._avoRuntime.getState();
		const canonicalText = this._avoRuntime.canonicalDeliveryText();
		if (
			!matchesAvoCanonicalDeliveryGeneration(state, expectedBinding, "pending") ||
			!canonicalText ||
			digestAvoDeliveryText(canonicalText) !== expectedBinding.deliveryDigest
		) {
			return false;
		}
		const audit = {
			role: "custom" as const,
			customType: "avo_canonical_delivery_host_fallback",
			content: `The canonical-delivery provider request failed after the immutable host gate. Prime emitted the already sealed delivery locally; no provider, evaluator, supervisor, or RLM retry was started. Provider error: ${providerFailure.errorMessage ?? "unknown provider error"}`,
			display: false,
			details: {
				...expectedBinding,
			},
			timestamp: Date.now(),
		} satisfies CustomMessage;
		const synthetic = {
			...providerFailure,
			content: [{ type: "text" as const, text: canonicalText }],
			stopReason: "stop" as const,
			errorMessage: undefined,
			diagnostics: undefined,
			timestamp: Date.now(),
		} satisfies AssistantMessage;
		try {
			// Persist the exact observed assistant output before sealing delivery.
			// A crash in the following narrow window is recovered on construction
			// by hashing this persisted assistant message locally.
			this.agent.state.messages.push(audit, synthetic);
			this.sessionManager.appendCustomMessageEntry(audit.customType, audit.content, audit.display, audit.details);
			this.sessionManager.appendMessage(synthetic);
			this._emit({ type: "message_start", message: audit });
			this._emit({ type: "message_end", message: audit });
			this._emit({ type: "message_start", message: synthetic });
			this._emit({ type: "message_end", message: synthetic });
			this._completeAvoCanonicalDelivery(readAvoAssistantDeliveryText(synthetic));
		} catch (error) {
			this._recordAvoCanonicalDeliveryFailure(error, expectedBinding);
			return false;
		}
		this._discardObsoleteAvoCompletionInputs(state, { includeCanonicalDelivery: false });
		this._avoCanonicalDeliveryQueuedRunId = undefined;
		this._avoCanonicalDeliveryQueuedBinding = undefined;
		this._avoCanonicalDeliveryDirectBinding = undefined;
		this._avoCanonicalDeliveryAttemptBinding = undefined;
		return true;
	}

	private _createAvoCanonicalDeliveryMessage(state: AvoRunState): CustomMessage | undefined {
		const delivery = state.delivery;
		const binding = parseAvoCanonicalDeliveryBinding(delivery);
		if (
			delivery.phase !== "pending" ||
			!binding ||
			binding.runId !== state.runId ||
			this._avoCanonicalDeliveryFailedRunIds.has(state.runId)
		) {
			return undefined;
		}
		const acceptedCandidate = state.candidates.find((candidate) => candidate.candidateId === binding.candidateId);
		if (!acceptedCandidate || acceptedCandidate.deliveryDigest !== binding.deliveryDigest) return undefined;
		const canonicalText = this._avoRuntime?.canonicalDeliveryText();
		if (!canonicalText || digestAvoDeliveryText(canonicalText) !== binding.deliveryDigest) return undefined;
		return {
			role: "custom",
			customType: "avo_canonical_delivery_required",
			content: [
				"<avo_canonical_delivery_required>",
				`The host stop gate passed for candidate ${acceptedCandidate.candidateId}.`,
				"End tool use now. Do not clean up verifier helpers, inspect state, call the stop gate again, or perform additional work.",
				`The exact host-sealed delivery is the decoded value of ${JSON.stringify(canonicalText)}. Output that value without JSON quotes and with no preface, suffix, explanation, or decoration.`,
				"</avo_canonical_delivery_required>",
			].join("\n"),
			display: true,
			details: {
				...binding,
				gatePassed: true,
				trigger: "post_ready_canonical_delivery",
			},
			timestamp: Date.now(),
		};
	}

	private _isAvoCanonicalDeliveryAction(
		action: QueuedSessionAction,
		expectedBinding?: AvoCanonicalDeliveryBinding,
	): boolean {
		if (
			action.payload.kind !== "turn" ||
			action.payload.customMessage?.customType !== "avo_canonical_delivery_required"
		) {
			return false;
		}
		const currentBinding = expectedBinding ?? parseAvoCanonicalDeliveryBinding(this._pendingAvoCanonicalDelivery());
		return (
			currentBinding !== undefined &&
			matchesAvoCanonicalDeliveryBinding(action.payload.customMessage.details, currentBinding)
		);
	}

	private _fenceAvoCanonicalDeliveryInputs(): void {
		const pending = this._pendingAvoCanonicalDelivery();
		const pendingBinding = parseAvoCanonicalDeliveryBinding(pending);
		const terminalFailure = this._isAvoCanonicalDeliveryTerminalFailure();
		if (!pending && !terminalFailure) return;
		this._pendingNextTurnMessages = pendingBinding
			? this._pendingNextTurnMessages.filter((message) => {
					if (message.customType !== "avo_canonical_delivery_required") return false;
					return matchesAvoCanonicalDeliveryBinding(message.details, pendingBinding);
				})
			: [];
		this._cancelSessionActions(
			(action) =>
				action.source === "internal" &&
				(terminalFailure || !pendingBinding || !this._isAvoCanonicalDeliveryAction(action, pendingBinding)),
			new Error("Queued internal work was closed by canonical delivery."),
		);
		this.agent.removeQueuedMessages(
			(message) =>
				message.role === "custom" && (terminalFailure || message.customType !== "avo_canonical_delivery_required"),
		);
		if (pendingBinding) {
			const canonicalActions = this._actionStore
				.unfinishedActions()
				.filter((action) => this._isAvoCanonicalDeliveryAction(action, pendingBinding));
			if (canonicalActions.length > 1) {
				const [, ...duplicates] = canonicalActions;
				const duplicateIds = new Set(duplicates.map((action) => action.id));
				this._cancelSessionActions(
					(action) => duplicateIds.has(action.id),
					new Error("Duplicate canonical delivery action was canceled."),
				);
			}
		}
		this._emitQueueUpdate();
	}

	private async _ensurePersistedAvoCanonicalDeliveryAction(): Promise<void> {
		return this._withAvoCanonicalDeliverySerialization(async () => {
			this._ensurePersistedAvoCanonicalDeliveryActionLocked();
		});
	}

	private _ensurePersistedAvoCanonicalDeliveryActionLocked(): void {
		const pending = this._pendingAvoCanonicalDelivery();
		if (!pending) return;
		const pendingBinding = parseAvoCanonicalDeliveryBinding(pending);
		if (!pendingBinding) {
			this._recordMalformedPendingAvoCanonicalDeliveryFailure(
				new Error("AVO completion is blocked: persisted canonical delivery binding is incomplete"),
			);
			return;
		}
		if (
			matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryDirectBinding, pendingBinding) ||
			matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, pendingBinding)
		) {
			return;
		}
		this._closeAvoCanonicalDeliveryBackgroundWork();
		this._fenceAvoCanonicalDeliveryInputs();
		const existingAction = this._actionStore
			.unfinishedActions()
			.find((action) => this._isAvoCanonicalDeliveryAction(action, pendingBinding));
		if (existingAction) {
			if (existingAction.lifecycle.state === "queued") {
				this._actionStore.moveQueued(existingAction, "next_turn_boundary", 0);
			}
			this._avoCanonicalDeliveryQueuedRunId = pendingBinding.runId;
			this._avoCanonicalDeliveryQueuedBinding = pendingBinding;
			this._emitQueueUpdate();
			return;
		}
		const state = this._requireAvoRuntime().getState();
		const message = this._createAvoCanonicalDeliveryMessage(state);
		if (!message) {
			this._recordAvoCanonicalDeliveryFailure(
				new Error("AVO completion is blocked: persisted canonical delivery record is inconsistent"),
				pendingBinding,
			);
			return;
		}
		const normalized = normalizeMessageContent(message.content);
		const action = this._createPreparedTurnAction("steer", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
			executionPolicy: this._turnExecutionPolicy("queued"),
			source: "internal",
			queueVisible: false,
		});
		this._admitSessionInput(action, { front: true, wake: false });
		this._avoCanonicalDeliveryQueuedRunId = state.runId;
		this._avoCanonicalDeliveryQueuedBinding = pendingBinding;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private _recordAvoCanonicalDeliveryFailure(
		error: unknown,
		expectedBinding: AvoCanonicalDeliveryBinding,
		expectedPhase: "accepted" | "pending" = "pending",
	): boolean {
		if (!this._avoRuntime) return false;
		const state = this._avoRuntime.getState();
		if (!matchesAvoCanonicalDeliveryGeneration(state, expectedBinding, expectedPhase)) return false;
		return this._sealAvoCanonicalDeliveryFailure(error, state);
	}

	private _recordCurrentAvoCanonicalDeliveryFailure(error: unknown): boolean {
		if (!this._avoRuntime) return false;
		const state = this._avoRuntime.getState();
		const binding = captureAvoCanonicalDeliveryGeneration(state);
		if (!binding || (state.delivery.phase !== "accepted" && state.delivery.phase !== "pending")) return false;
		return this._recordAvoCanonicalDeliveryFailure(error, binding, state.delivery.phase);
	}

	private _recordObservedAvoCanonicalDeliveryFailure(error: unknown, observedState: AvoRunState): boolean {
		const binding = captureAvoCanonicalDeliveryGeneration(observedState);
		if (!binding || (observedState.delivery.phase !== "accepted" && observedState.delivery.phase !== "pending")) {
			return false;
		}
		return this._recordAvoCanonicalDeliveryFailure(error, binding, observedState.delivery.phase);
	}

	private _recordMalformedPendingAvoCanonicalDeliveryFailure(error: unknown): boolean {
		if (!this._avoRuntime) return false;
		const state = this._avoRuntime.getState();
		if (
			state.status !== "active" ||
			state.delivery.phase !== "pending" ||
			parseAvoCanonicalDeliveryBinding(state.delivery) !== undefined
		) {
			return false;
		}
		return this._sealAvoCanonicalDeliveryFailure(error, state);
	}

	private _sealAvoCanonicalDeliveryFailure(error: unknown, state: AvoRunState): boolean {
		if (!this._avoRuntime || this._avoCanonicalDeliveryFailedRunIds.has(state.runId)) return false;
		this._avoCanonicalDeliveryFailedRunIds.add(state.runId);
		this._closeAvoCanonicalDeliveryBackgroundWork();
		const reason = error instanceof Error ? error.message : String(error);
		const code = /canonical accepted-cycle memory/i.test(reason)
			? "CANONICAL_ACCEPTED_CYCLE_MEMORY_MISSING"
			: "CANONICAL_DELIVERY_INVARIANT_FAILURE";
		const store = this._avoRuntime.store as unknown as {
			failCanonicalDelivery?: (failureCode: string, failureReason: string) => unknown;
		};
		try {
			store.failCanonicalDelivery?.(code, reason);
		} catch {
			// The durable custom failure below remains authoritative even if the
			// state-store failure transition itself cannot be persisted.
		}
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
		this._discardObsoleteAvoCompletionInputs(state);
		this._clearQueuedAutonomousContinuations();
		this._clearQueuedGoalContexts();
		this._cancelSessionActions(
			(action) => action.source === "internal",
			new Error("Queued internal work was closed by terminal canonical-delivery failure."),
		);
		this.agent.removeQueuedMessages((message) => message.role === "custom");
		this._avoCanonicalDeliveryQueuedRunId = undefined;
		this._avoCanonicalDeliveryQueuedBinding = undefined;
		this._avoCanonicalDeliveryDirectBinding = undefined;
		this._avoCanonicalDeliveryAttemptBinding = undefined;
		const message = {
			role: "custom" as const,
			customType: "avo_invariant_failure",
			content: `AVO_INVARIANT_FAILURE code=${code} run_id=${state.runId} candidate_id=${state.delivery.candidateId ?? "unknown"} cycle_id=${state.delivery.cycleId ?? "unknown"}: ${reason}`,
			display: true,
			details: {
				code,
				runId: state.runId,
				candidateId: state.delivery.candidateId,
				cycleId: state.delivery.cycleId,
				reason,
			},
			timestamp: Date.now(),
		} satisfies CustomMessage;
		this.agent.state.messages.push(message);
		this.sessionManager.appendCustomMessageEntry(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
		return true;
	}

	private async _queueAvoCanonicalDeliveryAfterPassingGateLocked(gate: AvoStopGate): Promise<void> {
		if (
			!gate.passed ||
			!this._enforceAvoCompletion ||
			!this._avoRuntime ||
			this._rlmDepth !== 0 ||
			!this.isStreaming
		) {
			return;
		}
		let state = this._avoRuntime.getState();
		if (!state.objective || state.status !== "active") {
			return;
		}
		let deliveryBinding = parseAvoCanonicalDeliveryBinding(state.delivery);
		if (
			deliveryBinding &&
			(matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryDirectBinding, deliveryBinding) ||
				matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, deliveryBinding))
		) {
			return;
		}

		// If already queued for this run and an active action is in the store, skip duplicate
		if (
			deliveryBinding !== undefined &&
			this._avoCanonicalDeliveryQueuedRunId === state.runId &&
			matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryQueuedBinding, deliveryBinding) &&
			this._actionStore
				.unfinishedActions()
				.some((action) => this._isAvoCanonicalDeliveryAction(action, deliveryBinding))
		) {
			return;
		}

		if (state.delivery.phase !== "pending") {
			try {
				deliveryBinding = await this._beginAvoCanonicalDeliveryLocked(gate);
				if (this._disposed || this._disposing || !this._avoRuntime) return;
				state = this._avoRuntime.getState();
				if (!deliveryBinding || !matchesAvoCanonicalDeliveryGeneration(state, deliveryBinding, "pending")) {
					return;
				}
			} catch (error) {
				this._recordCurrentAvoCanonicalDeliveryFailure(error);
				return;
			}
		}
		if (!deliveryBinding || !matchesAvoCanonicalDeliveryGeneration(state, deliveryBinding, "pending")) return;
		const message = this._createAvoCanonicalDeliveryMessage(state);
		if (!message) return;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
		this._discardObsoleteAvoCompletionInputs(state);
		this._clearQueuedAutonomousContinuations();
		this._clearQueuedGoalContexts();
		this._avoCanonicalDeliveryQueuedRunId = state.runId;
		this._avoCanonicalDeliveryQueuedBinding = deliveryBinding;
		const normalized = normalizeMessageContent(message.content);
		try {
			await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
				message,
				resumeIfIdle: true,
				front: true,
				queueVisible: false,
			});
			if (this._disposed || this._disposing || !this._avoRuntime) return;
			const postState = this._avoRuntime.getState();
			if (!matchesAvoCanonicalDeliveryGeneration(postState, deliveryBinding, "pending")) {
				this._cancelSessionActions(
					(action) => this._isAvoCanonicalDeliveryAction(action, deliveryBinding),
					new Error("Stale canonical delivery action was discarded after queue admission."),
				);
				if (matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryQueuedBinding, deliveryBinding)) {
					this._avoCanonicalDeliveryQueuedRunId = undefined;
					this._avoCanonicalDeliveryQueuedBinding = undefined;
				}
				this._fenceAvoCanonicalDeliveryInputs();
			}
		} catch (error) {
			if (matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryQueuedBinding, deliveryBinding)) {
				this._avoCanonicalDeliveryQueuedRunId = undefined;
				this._avoCanonicalDeliveryQueuedBinding = undefined;
			}
			const postState = this._avoRuntime?.getState();
			if (postState && matchesAvoCanonicalDeliveryGeneration(postState, deliveryBinding, "pending")) {
				this._recordAvoCanonicalDeliveryFailure(error, deliveryBinding);
			}
		}
	}

	private _isObsoleteAvoCompletionMessage(
		message: CustomMessage,
		state: AvoRunState,
		includeCanonicalDelivery: boolean,
	): boolean {
		if (includeCanonicalDelivery && message.customType === "avo_canonical_delivery_required") return true;
		if (!isAgentSessionMessage(message) || message.details.fromRelationship !== "child") return false;
		const senderName = message.details.from?.sessionName;
		return (
			typeof senderName === "string" &&
			(senderName === state.supervisor?.name ||
				(senderName.startsWith("avo-supervisor-") &&
					(message.details.message.includes("AVO_SUPERVISOR_READY") ||
						message.details.message.includes("AVO_SUPERVISION_JSON:"))))
		);
	}

	private _discardObsoleteAvoCompletionInputs(
		state: AvoRunState,
		options: { includeCanonicalDelivery?: boolean } = {},
	): void {
		const includeCanonicalDelivery = options.includeCanonicalDelivery ?? true;
		const isObsolete = (message: CustomMessage) =>
			this._isObsoleteAvoCompletionMessage(message, state, includeCanonicalDelivery);
		this._pendingNextTurnMessages = this._pendingNextTurnMessages.filter((message) => !isObsolete(message));
		this._cancelSessionActions(
			(action) =>
				action.payload.kind === "turn" &&
				(action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing") &&
				action.payload.customMessage !== undefined &&
				isObsolete(action.payload.customMessage),
			new Error("Queued AVO supervisor work was superseded by canonical delivery."),
		);
	}

	private async _maybeInterveneAvoToolStagnation(toolResults: readonly ToolResultMessage[]): Promise<void> {
		const timedOutTool = toolResults.find((result) => {
			const details = result.details;
			return (
				typeof details === "object" && details !== null && (details as { timedOut?: unknown }).timedOut === true
			);
		});
		if (
			isAvoFeatureAblated("qualified_watchdog") ||
			toolResults.length === 0 ||
			!this._enforceAvoCompletion ||
			!this._avoRuntime ||
			this._rlmDepth !== 0 ||
			this._pendingAvoCanonicalDelivery() !== undefined
		) {
			return;
		}
		const state = this._avoRuntime.getState();
		if (!state.objective || state.status !== "active") return;
		const snapshot = this._captureAvoProgressWatchdogSnapshot(state);
		if (this._avoToolProgressRunId !== snapshot.runId || this._avoToolProgressToken === undefined) {
			this._avoToolProgressRunId = snapshot.runId;
			this._avoToolProgressToken = snapshot.token;
			this._avoToolNoProgressBatches = 0;
			this._avoToolInterventionQueued = false;
			this._avoToolInterventionCount = 0;
			this._avoToolLastInterventionBatch = 0;
			if (!timedOutTool) return;
		}
		if (snapshot.token !== this._avoToolProgressToken) {
			const recoveredBatches = this._avoToolNoProgressBatches;
			const recoveredFromIntervention = this._avoToolInterventionQueued;
			this._avoToolProgressToken = snapshot.token;
			this._avoToolNoProgressBatches = 0;
			this._avoToolInterventionQueued = false;
			this._avoToolInterventionCount = 0;
			this._avoToolLastInterventionBatch = 0;
			if (recoveredFromIntervention) {
				this._avoRuntime.store.recordProgressWatchdogCheckpoint({
					consecutiveNoProgressTurns: 0,
					resumed: true,
					reason: `Host-observable progress resumed after ${recoveredBatches} stalled tool batches.`,
					escalateHorizon: false,
					unit: "tool_batch",
				});
			}
			if (!timedOutTool) return;
		}
		if (timedOutTool) {
			this._avoToolNoProgressBatches += 1;
			this._avoToolInterventionQueued = true;
			this._avoToolInterventionCount += 1;
			this._avoToolLastInterventionBatch = this._avoToolNoProgressBatches;
			const escalationLevel = this._avoToolInterventionCount;
			const reason = `Anti-laziness timeout escalation ${escalationLevel}: the host terminated a ${timedOutTool.toolName} call after its execution ceiling without host-observable verification progress.`;
			await this._queueAvoToolStagnationIntervention(state, {
				reason,
				escalationLevel,
				trigger: "anti_laziness_tool_timeout",
				forceIntervene: true,
				instruction:
					"Do not retry the same long-running cell or algorithm. Use a small bounded reproducer to remove the nontermination, split the work, then run the direct verifier again.",
			});
			return;
		}
		this._avoToolNoProgressBatches += 1;
		const threshold = this._avoToolInterventionCount === 0 ? 4 : this._avoToolLastInterventionBatch + 3;
		if (this._avoToolNoProgressBatches < threshold) return;
		this._avoToolInterventionQueued = true;
		this._avoToolInterventionCount += 1;
		this._avoToolLastInterventionBatch = this._avoToolNoProgressBatches;
		const escalationLevel = this._avoToolInterventionCount;
		const reason = `${escalationLevel === 1 ? "Anti-laziness tool intervention" : `Anti-laziness escalation ${escalationLevel}`}: ${this._avoToolNoProgressBatches} consecutive tool batches produced no meaningful host pass, obligation coverage, tested critical assumption, completed cycle, or experiment cell.`;
		await this._queueAvoToolStagnationIntervention(state, {
			reason,
			escalationLevel,
			trigger: escalationLevel === 1 ? "anti_laziness_tool_intervention" : "anti_laziness_tool_escalation",
			...(escalationLevel >= 1
				? {
						forceIntervene: true,
						instruction:
							"Host tool probation is active now. The next IPython cell must invoke the state-aware AVO action named below; read-only probing is denied until the host observes a verification milestone.",
					}
				: {}),
		});
	}

	private async _refreshAvoMemoryContext(prompt: string): Promise<void> {
		if (!this._avoRuntime || this._rlmDepth !== 0) {
			this._avoMemoryContext = "";
			return;
		}
		try {
			const recalled = await this._avoRuntime.recallMemory(prompt, { spontaneous: true, limit: 5, maxChars: 2_000 });
			const backendNotice =
				recalled.backend === "host-fallback"
					? `AVO_MEMORY_RECALL_STATUS=fallback. NOOA did not provide this recall; the host fallback was used${recalled.reason ? ` because ${recalled.reason.replace(/\s+/g, " ").trim().slice(0, 500)}` : ""}. Do not claim that NOOA memory influenced this turn.`
					: undefined;
			this._avoMemoryContext = [backendNotice, recalled.context]
				.filter((value): value is string => Boolean(value))
				.join("\n\n");
		} catch (error) {
			const reason = (error instanceof Error ? error.message : String(error))
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 500);
			try {
				this._avoRuntime.store.recordMemoryRecall(prompt, [], "spontaneous", 0, {
					backend: "host-fallback",
					status: "failed",
					reason,
					satisfies: ["ORDER-001", "FALLBACK-001"],
				});
			} catch {
				// The prompt still exposes the failure if the state store itself is unavailable.
			}
			this._avoMemoryContext = `AVO_MEMORY_RECALL_STATUS=failed. Automatic memory recall failed before this turn: ${reason || "unknown host error"}. No recalled memory was injected; do not claim that NOOA or remembered experience influenced this turn.`;
		}
	}

	private _recordAvoCandidateIntegrityFailure(candidateId: string): void {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		const candidate = state.candidates.find((item) => item.candidateId === candidateId);
		if (!candidate) return;
		let assessment: ReturnType<typeof assessAvoCandidateIntegrity>;
		try {
			assessment = assessAvoCandidateIntegrity(
				state,
				candidate,
				this.sessionManager.getCwd(),
				this._avoWorkspaceExcludedRoots(),
			);
		} catch (error) {
			assessment = {
				passed: false,
				reason: `candidate integrity observation failed: ${(error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 500)}`,
			};
		}
		if (assessment.passed) return;
		const reason = assessment.reason ?? "candidate integrity changed";
		const observedDigest = assessment.observedDigest;
		const duplicate = state.evaluations.some(
			(item) =>
				item.candidateId === candidateId &&
				item.evaluatorId === "candidate_integrity" &&
				item.status === "revise" &&
				item.metrics.observed_integrity_digest === (observedDigest ?? "unavailable"),
		);
		if (duplicate) return;
		runtime.recordHostEvaluation({
			candidateId,
			evaluatorId: "candidate_integrity",
			status: "revise",
			authority: "host",
			evidenceRefs: [`host:integrity:${observedDigest ?? "unavailable"}`],
			metrics: {
				meaningful: false,
				candidate_payload_digest: candidate.payloadDigest,
				observed_integrity_digest: observedDigest ?? "unavailable",
				validation_reason: reason,
			},
		});
	}

	private _observeAvoOnlineEvidence():
		| { provider: string; sourceCount: number; queryCount: number; evidenceRefs: string[] }
		| undefined {
		const state = this._requireAvoRuntime().getState();
		const taskStartedAt = Date.parse(state.createdAt);
		const externalClaim = [...state.evaluations]
			.reverse()
			.find(
				(receipt) =>
					receipt.issuedBy === "host" &&
					receipt.authority === "external" &&
					receipt.evaluatorId === "external_claim" &&
					receipt.status === "pass",
			);
		if (externalClaim) {
			return {
				provider: "host_bound_external_claim",
				sourceCount: 1,
				queryCount: 0,
				evidenceRefs: [...externalClaim.evidenceRefs],
			};
		}

		for (const message of [...this.messages].reverse()) {
			if (message.role !== "assistant" || message.timestamp < taskStartedAt) continue;
			for (const item of message.content) {
				if (item.type !== "text" || !isObjectRecord(item.providerMetadata)) continue;
				const grounding = item.providerMetadata.googleSearchGrounding;
				if (!isObjectRecord(grounding) || !Array.isArray(grounding.sources)) continue;
				const sources = grounding.sources.filter(
					(source) => isObjectRecord(source) && typeof source.url === "string" && /^https?:\/\//i.test(source.url),
				);
				if (sources.length === 0) continue;
				const queries = Array.isArray(grounding.queries)
					? grounding.queries.filter(
							(query): query is string => typeof query === "string" && query.trim().length > 0,
						)
					: [];
				return {
					provider: "google_vertex_native_search",
					sourceCount: sources.length,
					queryCount: queries.length,
					evidenceRefs: sources.map((source) => `source:${String(source.url)}`),
				};
			}
		}

		const trustedNames = new Set([
			"web_search",
			"google_search",
			"google_search_retrieval",
			"browser_search",
			"weather",
			"finance",
			"sports",
		]);
		for (const message of [...this.messages].reverse()) {
			if (message.role !== "toolResult" || message.timestamp < taskStartedAt || message.isError) continue;
			if (!trustedNames.has(message.toolName)) continue;
			return {
				provider: message.toolName,
				sourceCount: 1,
				queryCount: 1,
				evidenceRefs: [`host:tool-result:${message.toolCallId}`],
			};
		}
		return undefined;
	}

	private _recordAvoOnlineEvidence(): void {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		if (!state.routing.reasons.some((reason) => reason.startsWith("online evidence required:"))) return;
		const observation = this._observeAvoOnlineEvidence();
		if (!observation) return;
		for (const candidateId of new Set(
			state.cycles.filter((cycle) => cycle.outcome === "accepted").map((cycle) => cycle.candidateId),
		)) {
			const candidate = state.candidates.find((item) => item.candidateId === candidateId);
			if (!candidate) continue;
			if (
				state.evaluations.some(
					(receipt) =>
						receipt.candidateId === candidateId &&
						receipt.issuedBy === "host" &&
						receipt.evaluatorId === "online_evidence" &&
						receipt.status === "pass" &&
						receipt.metrics.candidate_payload_digest === candidate.payloadDigest,
				)
			)
				continue;
			runtime.recordHostEvaluation({
				candidateId,
				evaluatorId: "online_evidence",
				status: "pass",
				authority: "external",
				evidenceRefs: observation.evidenceRefs,
				metrics: {
					meaningful: true,
					provider: observation.provider,
					source_count: observation.sourceCount,
					query_count: observation.queryCount,
					candidate_payload_digest: candidate.payloadDigest,
				},
			});
		}
	}

	private _recordAvoPythonProbeApplicability(): void {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		if (state.routing.environment !== "coding") return;
		for (const candidateId of new Set(
			state.cycles.filter((cycle) => cycle.outcome === "accepted").map((cycle) => cycle.candidateId),
		)) {
			const candidate = state.candidates.find((item) => item.candidateId === candidateId);
			if (!candidate?.workspaceChangedPaths?.some((path) => path.endsWith(".py"))) continue;
			const contractDigest = digestAvoPythonProbeApplicability(state, candidate);
			if (
				state.evaluations.some(
					(receipt) =>
						receipt.candidateId === candidateId &&
						receipt.evaluatorId === "adversarial_probe_contract" &&
						receipt.issuedBy === "host" &&
						receipt.metrics.probe_contract_digest === contractDigest &&
						receipt.metrics.candidate_payload_digest === candidate.payloadDigest &&
						receipt.metrics.candidate_workspace_digest === candidate.workspaceDigest &&
						receipt.metrics.candidate_python_bundle_digest === candidate.pythonProbeBundleDigest &&
						receipt.metrics.workspace_matches_candidate === true &&
						receipt.metrics.python_bundle_matches_candidate === true,
				)
			) {
				continue;
			}
			let workspaceMatchesCandidate = false;
			let bundleMatchesCandidate = false;
			let integrityError: string | undefined;
			let capturedBundle: AvoPythonProbeBundle | undefined;
			try {
				const snapshot = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				});
				capturedBundle = captureAvoPythonProbeBundle(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				});
				workspaceMatchesCandidate = snapshot.digest === candidate.workspaceDigest;
				bundleMatchesCandidate = capturedBundle.digest === candidate.pythonProbeBundleDigest;
			} catch (error) {
				integrityError = error instanceof Error ? error.message : String(error);
			}
			const candidateIntegrityCurrent = workspaceMatchesCandidate && bundleMatchesCandidate;
			const bindings = candidateIntegrityCurrent
				? this._avoPythonProbeBindings(state, candidate, candidate.workspaceChangedPaths, capturedBundle)
				: undefined;
			const probeRequired = candidateIntegrityCurrent ? bindings !== undefined : true;
			const receiptDigest = digestAvoPayload({
				runId: state.runId,
				candidateId,
				contractDigest,
				bindings,
				probeRequired,
				workspaceMatchesCandidate,
				bundleMatchesCandidate,
			});
			const evaluationId = `evaluation-adversarial-probe-contract-${receiptDigest}`;
			if (runtime.getState().evaluations.some((receipt) => receipt.evaluationId === evaluationId)) continue;
			runtime.recordHostEvaluation({
				evaluationId,
				candidateId,
				evaluatorId: "adversarial_probe_contract",
				status: "inconclusive",
				authority: "environment",
				evidenceRefs: [`host:adversarial-probe-contract:${receiptDigest}`],
				metrics: {
					meaningful: false,
					probe_required: probeRequired,
					probe_surface_supported: candidateIntegrityCurrent && bindings?.surfaceError === undefined,
					probe_contract_digest: contractDigest,
					probe_module_paths: JSON.stringify(bindings?.modulePaths ?? []),
					probe_required_callables: JSON.stringify(bindings?.requiredCallables ?? []),
					probe_callable_input_dimensions: JSON.stringify(bindings?.callableInputDimensions ?? {}),
					candidate_payload_digest: candidate.payloadDigest,
					candidate_workspace_digest: candidate.workspaceDigest ?? "missing",
					candidate_python_bundle_digest: candidate.pythonProbeBundleDigest ?? "missing",
					workspace_matches_candidate: workspaceMatchesCandidate,
					python_bundle_matches_candidate: bundleMatchesCandidate,
					validation_reason: !candidateIntegrityCurrent
						? `cannot derive probe applicability from non-candidate source state${integrityError ? `: ${integrityError}` : ""}`
						: bindings
							? (bindings.surfaceError ?? "host-derived Python adversarial probe is required")
							: "no specification-named public Python callable requires a function probe",
				},
			});
		}
	}

	private _recordAvoSpecSemanticEvidence(candidateId: string): AvoEvaluationReceipt | undefined {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		const candidate = state.candidates.find((item) => item.candidateId === candidateId);
		const spec = state.verificationBaseline?.specContract;
		const pythonPaths = [...new Set(candidate?.workspaceChangedPaths?.filter((path) => path.endsWith(".py")) ?? [])]
			.map((path) => path.replaceAll("\\", "/"))
			.sort();
		if (!candidate || pythonPaths.length === 0) return undefined;
		if (!spec) {
			const reason = "no immutable baseline test or exact independently verified spec proof is available";
			const receiptDigest = digestAvoPayload({
				runId: state.runId,
				candidateId: candidate.candidateId,
				candidatePayloadDigest: candidate.payloadDigest,
				candidateWorkspaceDigest: candidate.workspaceDigest,
				pythonPaths,
				reason,
			});
			const evaluationId = `evaluation-spec-contract-${receiptDigest}`;
			const existing = state.evaluations.find((receipt) => receipt.evaluationId === evaluationId);
			if (existing) return existing;
			return runtime.recordHostEvaluation({
				evaluationId,
				candidateId: candidate.candidateId,
				evaluatorId: "spec_contract",
				status: "revise",
				authority: "host",
				evidenceRefs: [`host:spec-contract:${receiptDigest}`],
				metrics: {
					meaningful: false,
					spec_semantic_evidence: false,
					workspace_matches_candidate: false,
					candidate_payload_digest: candidate.payloadDigest,
					candidate_workspace_digest: candidate.workspaceDigest ?? "missing",
					spec_contract_digest: "missing",
					spec_impact_digest: digestAvoPayload({ pythonPaths, reason }),
					validation_reason: reason,
				},
			});
		}

		let workspaceMatchesCandidate = false;
		let contractValue: unknown;
		let coverage = {
			affectedRequirementIds: [] as string[],
			coveredPaths: [] as string[],
			uncoveredPaths: [...pythonPaths],
			impactDigest: digestAvoPayload({ pythonPaths, error: "contract-unavailable" }),
			errors: [] as string[],
		};
		let specGate: AvoStopGate = { passed: false, checks: [], reasons: ["spec evidence was not evaluated"] };
		const failures: string[] = [];
		try {
			const workspace = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
				excludedRoots: this._avoWorkspaceExcludedRoots(),
			});
			workspaceMatchesCandidate = workspace.digest === candidate.workspaceDigest;
			if (!workspaceMatchesCandidate) failures.push("current workspace does not match the candidate");
			contractValue = JSON.parse(spec.contractContent) as unknown;
			coverage = deriveAvoSpecSemanticCoverage(contractValue, pythonPaths);
			specGate = applyAvoSpecContractStopGate(
				state,
				{ passed: true, checks: [], reasons: [] },
				{
					cwd: this.sessionManager.getCwd(),
					excludedRoots: this._avoWorkspaceExcludedRoots(),
					receiptDirectory: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_DIR,
					receiptPublicKey: process.env.PRIME_AGENT_AVO_SPEC_RECEIPT_PUBLIC_KEY,
				},
			);
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
		if (coverage.errors.length > 0) failures.push(...coverage.errors);
		if (coverage.uncoveredPaths.length > 0) {
			failures.push(`uncovered Python paths: ${coverage.uncoveredPaths.join(", ")}`);
		}
		if (coverage.affectedRequirementIds.length === 0) failures.push("no affected behavioral requirements");
		if (!specGate.passed) failures.push(...specGate.reasons);
		const passed =
			workspaceMatchesCandidate &&
			coverage.coveredPaths.length === pythonPaths.length &&
			coverage.uncoveredPaths.length === 0 &&
			coverage.affectedRequirementIds.length > 0 &&
			coverage.errors.length === 0 &&
			specGate.passed;
		const gateDigest = digestAvoPayload({ checks: specGate.checks, reasons: specGate.reasons });
		const receiptDigest = digestAvoPayload({
			runId: state.runId,
			candidateId: candidate.candidateId,
			candidatePayloadDigest: candidate.payloadDigest,
			candidateWorkspaceDigest: candidate.workspaceDigest,
			contractDigest: spec.contractDigest,
			pythonPaths,
			coverage,
			gateDigest,
			passed,
		});
		const evaluationId = `evaluation-spec-contract-${receiptDigest}`;
		const existing = runtime.getState().evaluations.find((receipt) => receipt.evaluationId === evaluationId);
		if (existing) return existing;
		return runtime.recordHostEvaluation({
			evaluationId,
			candidateId: candidate.candidateId,
			evaluatorId: "spec_contract",
			status: passed ? "pass" : "revise",
			authority: "host",
			evidenceRefs: [
				`host:spec-contract:${receiptDigest}`,
				...coverage.affectedRequirementIds.map((requirementId) => `spec-requirement:${requirementId}`),
			],
			metrics: {
				meaningful: passed,
				spec_semantic_evidence: passed,
				workspace_matches_candidate: workspaceMatchesCandidate,
				candidate_payload_digest: candidate.payloadDigest,
				candidate_workspace_digest: candidate.workspaceDigest ?? "missing",
				spec_contract_digest: spec.contractDigest,
				spec_impact_digest: coverage.impactDigest,
				spec_gate_digest: gateDigest,
				spec_covered_python_paths: JSON.stringify(coverage.coveredPaths),
				spec_uncovered_python_paths: JSON.stringify(coverage.uncoveredPaths),
				spec_affected_requirements: JSON.stringify(coverage.affectedRequirementIds),
				validation_reason: passed
					? "every changed Python path is exactly mapped to current independently verified behavioral requirements"
					: [...new Set(failures)].join("; ").slice(0, 4_000),
			},
		});
	}

	private _evaluateAvoHostBoundStopGate(): AvoStopGate {
		const runtime = this._requireAvoRuntime();
		for (const candidateId of new Set(
			runtime
				.getState()
				.cycles.filter((cycle) => cycle.outcome === "accepted")
				.map((cycle) => cycle.candidateId),
		)) {
			this._recordAvoCandidateIntegrityFailure(candidateId);
		}
		this._recordAvoPythonProbeApplicability();
		this._recordAvoOnlineEvidence();
		return runtime.evaluateStopGate();
	}

	private _evaluateAvoStopGateWithCanonicalRepair(): AvoStopGate {
		let gate = this._evaluateAvoHostBoundStopGate();
		const state = this._requireAvoRuntime().getState();
		const readiness = gate.checks.find((check) => check.id === "canonical_delivery_state");
		const allOtherChecksPass = gate.checks
			.filter((check) => check.id !== "canonical_delivery_state")
			.every((check) => check.passed);
		if (
			state.status !== "active" ||
			state.delivery.phase !== "accepted" ||
			readiness?.passed !== false ||
			!allOtherChecksPass ||
			!this._isRepairableAvoCanonicalMemoryFailure(readiness.reason ?? gate.reasons.join("; "))
		) {
			return gate;
		}
		try {
			this._requireAvoRuntime().store.repairCanonicalDeliveryMemory();
			gate = this._evaluateAvoHostBoundStopGate();
			if (!gate.passed) {
				throw new Error(`canonical delivery memory repair did not restore readiness: ${gate.reasons.join("; ")}`);
			}
		} catch (error) {
			this._recordCurrentAvoCanonicalDeliveryFailure(error);
		}
		return gate;
	}

	private _handleAvoSlashCommand(command: SessionSlashCommand): string {
		const runtime = this._requireAvoRuntime();
		let target: "horizon" | "status" = "status";
		let value = command.args.trim();
		if (command.name === "horizon") target = "horizon";
		else if (value) {
			const match = /^(status|horizon)(?:\s+(.+))?$/.exec(value);
			if (!match) throw new Error("Usage: /avo [status|horizon <value>]");
			target = match[1] as "horizon" | "status";
			value = (match[2] ?? "").trim();
		}
		if (target === "status" || !value) return this._formatAvoStatus();
		if (value !== "auto" && !AVO_HORIZONS.includes(value as (typeof AVO_HORIZONS)[number])) {
			throw new Error("AVO horizon must be auto, direct, iterative, or long");
		}
		runtime.configure({ horizon: value as AvoHorizonSelection, source: "user" });
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
		return this._formatAvoStatus();
	}

	private _syncAvoResearchState(): void {
		if (!this._avoRuntime || !this._autoresearchStore) return;
		if (this._avoRuntime.getState().routing.environment !== "research") {
			throw new Error("autoresearch is only available when the host routed the active task to research");
		}
		const state = this._autoresearchStore.getState();
		this._avoRuntime.syncResearchState(
			state,
			this._autoresearchStore.evaluateStopGate(),
			this._avoRuntime.researchStatePath(),
		);
	}

	private async _ensureAvoSupervisor(): Promise<{ rlmChildId: string; name: string }> {
		const runtime = this._requireAvoRuntime();
		if (!this._agentMessageController) throw new Error("AVO supervision requires retained-child messaging");
		const state = runtime.getState();
		if (!state.objective) throw new Error("initialize AVO before starting its supervisor");
		const children = (await this.listRlmSubagents()).subagents;
		if (state.supervisor && this._avoSupervisorBoundToRuntime) {
			const retained = children.find(
				(child) =>
					child.rlm_child_id === state.supervisor?.rlmChildId || child.session_name === state.supervisor?.name,
			);
			if (retained && retained.status !== "error") {
				this._avoSupervisorBoundToRuntime = true;
				return { rlmChildId: retained.rlm_child_id, name: retained.session_name };
			}
		}
		const suffix = this.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || randomUUID().slice(0, 8);
		const preferredName = `avo-supervisor-${suffix}`;
		const name = children.some((child) => child.session_name === preferredName)
			? `${preferredName}-${randomUUID().slice(0, 8)}`
			: preferredName;
		const handle = await this._startRlmChildRun(buildAvoSupervisorBootstrapPrompt(), { name }, undefined, {
			allowedToolNames: [],
		});
		runtime.store.setSupervisor({ rlmChildId: handle.rlm_child_id, name: handle.name });
		this._avoSupervisorBoundToRuntime = true;
		return { rlmChildId: handle.rlm_child_id, name: handle.name };
	}

	private _avoAdversarialReviewPaths(
		state: AvoRunState,
		candidate: AvoRunState["candidates"][number] | undefined,
	): string[] {
		const baselinePaths =
			state.verificationBaseline?.kind === "coding"
				? state.verificationBaseline.testFiles.map((item) => item.path)
				: [];
		const safePaths = (paths: readonly string[]): string[] =>
			[...new Set(paths)].flatMap((path) => {
				const absolute = resolve(this._cwd, path);
				const relativePath = relative(this._cwd, absolute);
				if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return [];
				if (!existsSync(absolute)) return [];
				const stats = lstatSync(absolute);
				if (!stats.isFile() || stats.size > 1_000_000) return [];
				if (readFileSync(absolute).includes(0)) return [];
				return [relativePath];
			});
		const changedPaths = safePaths(candidate?.workspaceChangedPaths ?? []);
		const changed = new Set(changedPaths);
		return [
			...changedPaths,
			...safePaths(baselinePaths)
				.filter((path) => !changed.has(path))
				.slice(0, 4),
		];
	}

	private _avoPythonProbeBindings(
		state: AvoRunState,
		candidate: AvoRunState["candidates"][number] | undefined,
		probePaths = candidate?.workspaceChangedPaths ?? [],
		probeBundle?: AvoPythonProbeBundle,
	): AvoPythonProbeBindings | undefined {
		const requirementIds = state.obligations
			.filter((item) => item.critical && item.kind !== "outcome")
			.map((item) => item.obligationId);
		if (requirementIds.length === 0) return undefined;
		if (!candidate?.workspaceChangedPaths?.some((path) => path.endsWith(".py"))) return undefined;
		let boundBundle = probeBundle;
		let bundleError: string | undefined;
		if (!boundBundle) {
			try {
				boundBundle = captureAvoPythonProbeBundle(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				});
			} catch (error) {
				bundleError = error instanceof Error ? error.message : String(error);
			}
		}
		if (boundBundle && boundBundle.digest !== candidate.pythonProbeBundleDigest) {
			bundleError = "current Python source bundle does not match the host-captured candidate bundle";
		}
		const bundleSources = boundBundle
			? new Map(boundBundle.files.map((file) => [file.path, Buffer.from(file.contentBase64, "base64")]))
			: undefined;
		const signatureAuthorityText = [state.objective, state.verificationBaseline?.specContract?.contractContent]
			.filter((item): item is string => typeof item === "string")
			.join("\n");
		const specificationText = [signatureAuthorityText, ...state.obligations.map((item) => item.description)]
			.filter((item): item is string => typeof item === "string")
			.join("\n");
		// The root objective and task-start spec contract are host captured.
		// Obligation descriptions may be proposed by the model, so they can identify
		// relevant APIs but cannot manufacture a trusted signature for a new API.
		const specificationReferences = (name: string): boolean => {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}(?:$|[^A-Za-z0-9_])`).test(specificationText);
		};
		const specificationReferencesCallableSyntax = (name: string): boolean => {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*\\(`).test(specificationText);
		};
		const specificationDeclaredSignature = (
			name: string,
		):
			| {
					inputDimensions: string[];
					signatureDigest: string;
					signatureAuthority: "full" | "parameters" | "structural";
			  }
			| undefined => {
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const definitionMatch = new RegExp(
				`(?:^|\\r?\\n)[ \\t]*def[ \\t]+${escaped}[ \\t]*\\(([^()\\r\\n]{0,500})\\)[ \\t]*(?:->[ \\t]*([^:\\r\\n]{1,500}?))?[ \\t]*:`,
			).exec(signatureAuthorityText);
			const callMatch = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped}\\s*\\(([^()\\r\\n]{0,500})\\)`).exec(
				signatureAuthorityText,
			);
			const match = definitionMatch ?? callMatch;
			if (!match) return undefined;
			const parameters = match[1]!.trim()
				? match[1]!
						.split(",")
						.map((item) => item.trim())
						.filter(Boolean)
				: [];
			if (!parameters.every((item) => /^\*{0,2}[A-Za-z_][A-Za-z0-9_]*(?:\s*[:=].*)?$/.test(item))) {
				return undefined;
			}
			const returnAnnotation = definitionMatch?.[2]?.trim();
			const inspection = inspectAvoPythonPublicCallables(
				`def ${name}(${match[1]!})${returnAnnotation ? ` -> ${returnAnnotation}` : ""}:\n    pass\n`,
			);
			const callable = inspection.callables.find((item) => item.name === name);
			const declaresAnnotationOrDefault = parameters.some((parameter) => /[:=]/.test(parameter));
			return callable
				? {
						inputDimensions: callable.inputDimensions,
						signatureDigest: returnAnnotation
							? callable.signatureDigest
							: declaresAnnotationOrDefault
								? callable.parameterSignatureDigest
								: callable.structuralDigest,
						signatureAuthority: returnAnnotation
							? "full"
							: declaresAnnotationOrDefault
								? "parameters"
								: "structural",
					}
				: undefined;
		};
		const changedPaths = new Set(
			(candidate?.workspaceChangedPaths ?? []).flatMap((path) => {
				const absolute = resolve(this._cwd, path);
				const relativePath = relative(this._cwd, absolute);
				return relativePath && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath)
					? [relativePath]
					: [];
			}),
		);
		const baselineTestPaths = new Set(
			(state.verificationBaseline?.testFiles ?? []).map((item) => item.path.replaceAll("\\", "/")),
		);
		const taskSourcePaths = new Set(state.verificationBaseline?.taskSourcePaths ?? []);
		const eligibleBaselineEntrypoint = (path: string): boolean =>
			!baselineTestPaths.has(path) &&
			(!state.verificationBaseline?.strictTaskSourcePaths || taskSourcePaths.has(path));
		const baselineEntrypointPaths = [
			...new Set([
				...Object.entries(state.verificationBaseline?.pythonCallableDimensions ?? {})
					.filter(
						([path, callables]) =>
							eligibleBaselineEntrypoint(path) && Object.keys(callables).some(specificationReferences),
					)
					.map(([path]) => path),
				...Object.entries(state.verificationBaseline?.pythonUninspectableCallables ?? {})
					.filter(
						([path, names]) =>
							eligibleBaselineEntrypoint(path) &&
							names.some((name) => name === "*" || specificationReferencesCallableSyntax(name)),
					)
					.map(([path]) => path),
			]),
		];
		const baselineEntrypointPathSet = new Set(baselineEntrypointPaths);
		const requestedPythonPaths = [
			...new Set([...probePaths.filter((path) => path.endsWith(".py")), ...baselineEntrypointPaths]),
		];
		if (requestedPythonPaths.length === 0) return undefined;
		const readableModules: Array<{ modulePath: string; source: string }> = [];
		const inspectedModulePaths: string[] = [];
		const surfaceErrors: string[] = (state.verificationBaseline?.pythonUnsafePaths ?? []).map(
			(path) => `task-start Python source was unsafe or unreadable: ${path}`,
		);
		let candidateSurfaceInvalid = false;
		const invalidateCandidateSurface = (reason: string): void => {
			candidateSurfaceInvalid = true;
			surfaceErrors.push(reason);
		};
		if (bundleError) surfaceErrors.push(bundleError);
		for (const path of requestedPythonPaths) {
			const absolute = resolve(this._cwd, path);
			const relativePath = relative(this._cwd, absolute);
			if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
				invalidateCandidateSurface(`required Python path is outside the workspace: ${path.slice(0, 300)}`);
				continue;
			}
			if (!changedPaths.has(relativePath) && !baselineEntrypointPathSet.has(relativePath)) continue;
			inspectedModulePaths.push(relativePath);
			try {
				const bundledContents = bundleSources?.get(relativePath.replaceAll(sep, "/"));
				if (bundleSources) {
					if (!bundledContents) {
						invalidateCandidateSurface(
							`required Python module is missing from the candidate bundle: ${relativePath}`,
						);
						continue;
					}
					if (bundledContents.byteLength > 1_000_000) {
						invalidateCandidateSurface(
							`required Python module exceeds the 1000000-byte probe inspection limit: ${relativePath}`,
						);
						continue;
					}
					const source = bundledContents.toString("utf8");
					if (bundledContents.includes(0) || source.includes("\uFFFD")) {
						invalidateCandidateSurface(`required Python module is not inspectable UTF-8 source: ${relativePath}`);
						continue;
					}
					readableModules.push({ modulePath: relativePath, source });
					continue;
				}
				if (!existsSync(absolute)) {
					invalidateCandidateSurface(`required Python module is missing or deleted: ${relativePath}`);
					continue;
				}
				const stats = lstatSync(absolute);
				if (!stats.isFile()) {
					invalidateCandidateSurface(`required Python module is not a regular file: ${relativePath}`);
					continue;
				}
				if (stats.size > 1_000_000) {
					invalidateCandidateSurface(
						`required Python module exceeds the 1000000-byte probe inspection limit: ${relativePath}`,
					);
					continue;
				}
				const contents = readFileSync(absolute);
				const source = contents.toString("utf8");
				if (contents.includes(0) || source.includes("\uFFFD")) {
					invalidateCandidateSurface(`required Python module is not inspectable UTF-8 source: ${relativePath}`);
					continue;
				}
				readableModules.push({ modulePath: relativePath, source });
			} catch (error) {
				invalidateCandidateSurface(
					`required Python module could not be inspected: ${relativePath}: ${String(error)}`,
				);
			}
		}
		if (inspectedModulePaths.length === 0 && surfaceErrors.length === 0) return undefined;
		const modules = readableModules.map(({ modulePath, source }) => {
			const inspection = inspectAvoPythonPublicCallables(source);
			const baselineCallables = state.verificationBaseline?.pythonCallableDimensions?.[modulePath];
			const callableInputDimensions = Object.fromEntries(
				inspection.callables
					.filter((callable) => specificationReferences(callable.name))
					.map((callable) => {
						const baselineDimensions = baselineCallables?.[callable.name];
						const declaredSignature = specificationDeclaredSignature(callable.name);
						if (!baselineDimensions && declaredSignature === undefined) {
							surfaceErrors.push(
								`${modulePath}: new callable ${callable.name} has no task-start or explicit specification signature`,
							);
						}
						const baselineSignature =
							state.verificationBaseline?.pythonCallableSignatureDigests?.[modulePath]?.[callable.name];
						if (baselineDimensions && baselineSignature !== callable.signatureDigest) {
							invalidateCandidateSurface(
								`${modulePath}: baseline callable ${callable.name} changed its public parameter contract`,
							);
						}
						if (
							declaredSignature &&
							declaredSignature.signatureDigest !==
								(declaredSignature.signatureAuthority === "full"
									? callable.signatureDigest
									: declaredSignature.signatureAuthority === "parameters"
										? callable.parameterSignatureDigest
										: callable.structuralDigest)
						) {
							invalidateCandidateSurface(
								`${modulePath}: callable ${callable.name} does not match its host-declared public parameter contract`,
							);
						}
						return [
							callable.name,
							[
								...new Set([
									...(baselineDimensions ?? []),
									...(declaredSignature?.inputDimensions ?? []),
									...callable.inputDimensions,
								]),
							],
						];
					}),
			);
			for (const error of inspection.errors.filter(
				(item) => item.name === "*" || specificationReferencesCallableSyntax(item.name),
			)) {
				invalidateCandidateSurface(`${modulePath}: ${error.reason}`);
			}
			if (baselineCallables) {
				for (const name of Object.keys(baselineCallables).filter(specificationReferences)) {
					if (!Object.hasOwn(callableInputDimensions, name)) {
						invalidateCandidateSurface(
							`specification-named baseline callable ${name} is missing from ${modulePath}`,
						);
					}
				}
			}
			for (const name of (state.verificationBaseline?.pythonUninspectableCallables?.[modulePath] ?? []).filter(
				(item) => item === "*" || specificationReferencesCallableSyntax(item),
			)) {
				surfaceErrors.push(
					`specification-named baseline callable ${name} was not safely inspectable in ${modulePath}`,
				);
			}
			return { modulePath, callableInputDimensions, requiredCallables: Object.keys(callableInputDimensions) };
		});
		modules.sort(
			(left, right) =>
				right.requiredCallables.length - left.requiredCallables.length ||
				left.modulePath.localeCompare(right.modulePath),
		);
		const relevantModules = modules.filter((item) => item.requiredCallables.length > 0);
		if (state.verificationBaseline?.pythonCallableDimensions === undefined) {
			surfaceErrors.push(
				"task-start Python callable manifest is unavailable, so signature weakening or removal of a specification-named API cannot be excluded",
			);
		}
		if (!candidate.pythonProbeBundleDigest) {
			surfaceErrors.push("candidate has no host-captured Python source-bundle digest");
		}
		if (relevantModules.length === 0 && surfaceErrors.length === 0) return undefined;
		const requiredCallables = [...new Set(relevantModules.flatMap((item) => item.requiredCallables))];
		const callableInputDimensions = Object.fromEntries(
			relevantModules.flatMap((item) => Object.entries(item.callableInputDimensions)),
		);
		const requiredCaseCount = requiredCallables.reduce(
			(total, callable) => total + Math.max(1, (callableInputDimensions[callable]?.length ?? 0) + 1),
			0,
		);
		const maximumInputDimensionCount = Math.max(
			0,
			...Object.values(callableInputDimensions).map((dimensions) => dimensions.length),
		);
		if (maximumInputDimensionCount > 16) {
			surfaceErrors.push(
				`a required public API exposes ${maximumInputDimensionCount} inputs, above the host probe limit of 16`,
			);
		}
		for (const [callable, dimensions] of Object.entries(callableInputDimensions)) {
			const positionalCount = dimensions.filter((dimension) => dimension.startsWith("arg:")).length;
			const keywordCount = dimensions.filter((dimension) => dimension.startsWith("kwarg:")).length;
			if (positionalCount > 8 || keywordCount > 8) {
				surfaceErrors.push(
					`required public API ${callable} exposes ${positionalCount} positional and ${keywordCount} keyword-only inputs, above the host per-kind limit of 8`,
				);
			}
		}
		if (
			requiredCallables.length > 0 &&
			requiredCallables.every((callable) => (callableInputDimensions[callable]?.length ?? 0) === 0) &&
			requiredCallables.length < 6
		) {
			surfaceErrors.push(
				`${requiredCallables.length} zero-input public APIs cannot supply the six distinct host probe inputs required by policy`,
			);
		}
		if (relevantModules.length > 1) {
			surfaceErrors.push(
				`required public APIs span ${relevantModules.length} Python entrypoint modules; one host probe plan cannot bind all modules atomically`,
			);
		}
		if (requiredCaseCount > AVO_PYTHON_PROBE_MAX_CASES) {
			surfaceErrors.push(
				`${requiredCallables.length} required public APIs need at least ${requiredCaseCount} contrast cases, above the host limit of ${AVO_PYTHON_PROBE_MAX_CASES}`,
			);
		}
		return {
			modulePaths: [
				...new Set(
					relevantModules.length > 0 ? relevantModules.map((item) => item.modulePath) : inspectedModulePaths,
				),
			],
			requiredCallables,
			callableInputDimensions,
			surfaceError: surfaceErrors.length > 0 ? surfaceErrors.join("; ") : undefined,
			surfaceErrorDisposition:
				surfaceErrors.length > 0
					? candidateSurfaceInvalid
						? "candidate_invalid"
						: "environment_unsupported"
					: undefined,
			requirementIds,
			minimumCases: 6,
			maximumCases: Math.max(8, Math.min(AVO_PYTHON_PROBE_MAX_CASES, requiredCaseCount)),
			minimumCrossRequirementCases: requirementIds.length >= 2 ? 3 : 0,
			minimumDistinctRequirements: Math.min(4, requirementIds.length),
			minimumContrastedInputDimensions: maximumInputDimensionCount,
		};
	}

	private async _runAvoPythonProbe(
		candidate: AvoRunState["candidates"][number],
		plan: AvoPythonProbePlan,
	): Promise<{
		report?: AvoPythonProbeReport;
		exitCode: number | null;
		timedOut: boolean;
		truncated: boolean;
		stdout: string;
		stderr: string;
		durationMs: number;
		workspaceDigest: string;
		postWorkspaceDigest: string;
		error?: string;
	}> {
		const cwd = this.sessionManager.getCwd();
		const before = captureAvoWorkspaceSnapshot(cwd, { excludedRoots: this._avoWorkspaceExcludedRoots() });
		if (!candidate.workspaceDigest || before.digest !== candidate.workspaceDigest) {
			return {
				exitCode: null,
				timedOut: false,
				truncated: false,
				stdout: "",
				stderr: "",
				durationMs: 0,
				workspaceDigest: before.digest,
				postWorkspaceDigest: before.digest,
				error: "workspace changed after candidate creation",
			};
		}
		const bundle = captureAvoPythonProbeBundle(cwd, { excludedRoots: this._avoWorkspaceExcludedRoots() });
		if (!candidate.pythonProbeBundleDigest || bundle.digest !== candidate.pythonProbeBundleDigest) {
			return {
				exitCode: null,
				timedOut: false,
				truncated: false,
				stdout: "",
				stderr: "",
				durationMs: 0,
				workspaceDigest: before.digest,
				postWorkspaceDigest: before.digest,
				error: "Python source bundle does not match the host-captured candidate bundle",
			};
		}
		const execution = await executeAvoPythonProbeSandbox(cwd, plan, bundle);
		const post = captureAvoWorkspaceSnapshot(cwd, { excludedRoots: this._avoWorkspaceExcludedRoots() });
		const postBundle = captureAvoPythonProbeBundle(cwd, { excludedRoots: this._avoWorkspaceExcludedRoots() });
		const executionError =
			post.digest !== candidate.workspaceDigest || postBundle.digest !== candidate.pythonProbeBundleDigest
				? "probe execution changed the candidate workspace"
				: execution.error;
		return {
			...execution,
			workspaceDigest: before.digest,
			postWorkspaceDigest: post.digest,
			error: executionError,
		};
	}

	private async _dispatchAvoCheckpoint(
		supervisor: { rlmChildId: string; name: string },
		cycleId: string,
		probeValidationFeedback?: string,
	): Promise<{ receipt?: AgentSessionMessageReceipt; error?: string }> {
		try {
			// Publication is sufficient: daemon messaging queues a follow-up behind a
			// still-running bootstrap turn. Waiting for full model settlement here can
			// exceed the IPython cell deadline during provider backoff, even though the
			// accepted cycle is already durable.
			await this._awaitPendingRlmChildPublication(supervisor.name);
			const runtime = this._requireAvoRuntime();
			this._recordAvoPythonProbeApplicability();
			const state = runtime.getState();
			const adversarialReview = requiresAvoAdversarialReview(state, cycleId);
			const supervisorMemory = await runtime.recallSupervisorMemory(
				[
					`Review trajectory for cycle ${cycleId}.`,
					state.objective ? `Objective: ${state.objective}` : undefined,
					state.cycles.at(-1)?.failureSignature
						? `Latest failure: ${state.cycles.at(-1)!.failureSignature}`
						: undefined,
				]
					.filter((item): item is string => item !== undefined)
					.join("\n"),
			);
			const adapter = runtime.adapters.get(state.routing.environment);
			let rawContext = adapter.buildSupervisorContext(state);
			let compactAdversarialContext: Record<string, unknown> | undefined;
			if (adversarialReview) {
				const cycle = state.cycles.find((item) => item.cycleId === cycleId);
				const candidate = cycle
					? state.candidates.find((item) => item.candidateId === cycle.candidateId)
					: undefined;
				const reviewPaths = this._avoAdversarialReviewPaths(state, candidate);
				const requiredPythonPaths = [
					...new Set(candidate?.workspaceChangedPaths?.filter((path) => path.endsWith(".py")) ?? []),
				]
					.map((path) => relative(this._cwd, resolve(this._cwd, path)))
					.filter((path) => path && !path.startsWith(`..${sep}`) && !isAbsolute(path));
				const missingRequiredReviewPaths = requiredPythonPaths.filter((path) => !reviewPaths.includes(path));
				if (missingRequiredReviewPaths.length > 0) {
					throw new Error(
						`retained review cannot safely bind required Python paths: ${missingRequiredReviewPaths.join(", ")}`,
					);
				}
				if (requiredPythonPaths.length > 24) {
					throw new Error("retained review supports at most 24 changed Python paths per accepted candidate");
				}
				const pythonProbeBindings = this._avoPythonProbeBindings(state, candidate);
				const reviewFileBudget = 5_000;
				const perFileBudget = Math.max(128, Math.min(2_400, Math.floor(reviewFileBudget / reviewPaths.length)));
				const reviewFiles: Array<{ path: string; excerpt: string; truncated: boolean }> = [];
				for (const path of reviewPaths) {
					const absolute = resolve(this._cwd, path);
					const text = readFileSync(absolute, "utf8");
					const budget = perFileBudget;
					const truncated = text.length > budget;
					const headChars = Math.ceil(budget * 0.7);
					const excerpt = truncated
						? `${text.slice(0, headChars)}\n\n[... host truncated ${text.length - budget} characters ...]\n\n${text.slice(-(budget - headChars))}`
						: text;
					reviewFiles.push({ path, excerpt, truncated });
				}
				const reviewObligations = state.obligations.filter((item) => item.critical && item.kind !== "outcome");
				const requirementExcerpts: Array<{ requirement_id: string; description: string }> = [];
				const requirementDescriptionBudget = 2_400;
				const perRequirementBudget = Math.max(
					48,
					Math.floor(requirementDescriptionBudget / Math.max(1, reviewObligations.length)),
				);
				for (const obligation of reviewObligations) {
					const description = obligation.description.slice(0, perRequirementBudget);
					requirementExcerpts.push({ requirement_id: obligation.obligationId, description });
				}
				const acceptedCandidate = candidate
					? {
							candidate_id: candidate.candidateId,
							kind: candidate.kind,
							summary: candidate.summary.slice(0, 500),
							changed_paths: candidate.workspaceChangedPaths ?? [],
							impact_surfaces: (candidate.impactSurfaces ?? []).slice(0, 4),
						}
					: undefined;
				const authoritativeReceipts = state.evaluations
					.filter((item) => item.candidateId === candidate?.candidateId)
					.slice(-4)
					.map((item) => ({
						evaluation_id: item.evaluationId,
						evaluator: item.evaluatorId,
						status: item.status,
						validation_reason:
							typeof item.metrics.validation_reason === "string"
								? item.metrics.validation_reason.slice(0, 300)
								: item.metrics.validation_reason,
					}));
				const criticalAssumptions = state.criticalAssumptions.slice(-3).map((item) => ({
					assumption_id: item.assumptionId,
					statement: item.statement.slice(0, 240),
					falsification_plan: item.falsificationPlan.slice(0, 240),
					status: item.status,
				}));
				const obligationCoverageReceiptCount = new Set(
					state.obligationCoverage
						.filter((item) => item.candidateId === candidate?.candidateId)
						.flatMap((item) => item.evaluationIds),
				).size;
				rawContext = {
					run_id: state.runId,
					accepted_candidate: acceptedCandidate,
					authoritative_receipts: authoritativeReceipts,
					critical_requirement_count: state.obligations.filter((item) => item.critical).length,
					critical_requirement_excerpts: requirementExcerpts,
					obligation_coverage_receipt_count: obligationCoverageReceiptCount,
					critical_assumptions: criticalAssumptions,
					review_files: reviewFiles,
					python_probe_contract: pythonProbeBindings
						? {
								probe_version: 1,
								runtime: "python_call_v1",
								module_path:
									pythonProbeBindings.modulePaths.length === 1
										? pythonProbeBindings.modulePaths[0]
										: undefined,
								required_callables: pythonProbeBindings.requiredCallables,
								callable_input_dimensions: pythonProbeBindings.callableInputDimensions,
								surface_error: pythonProbeBindings.surfaceError,
								minimum_cases: pythonProbeBindings.minimumCases,
								maximum_cases: pythonProbeBindings.maximumCases,
								minimum_cross_requirement_cases: pythonProbeBindings.minimumCrossRequirementCases,
								minimum_distinct_requirements: pythonProbeBindings.minimumDistinctRequirements,
								minimum_contrasted_input_dimensions: pythonProbeBindings.minimumContrastedInputDimensions,
								require_cross_requirement_case_per_required_callable:
									pythonProbeBindings.minimumCrossRequirementCases > 0,
							}
						: undefined,
				};
				const sampledRequirements =
					requirementExcerpts.length <= 24
						? requirementExcerpts
						: Array.from(
								{ length: 24 },
								(_, index) => requirementExcerpts[Math.floor((index * (requirementExcerpts.length - 1)) / 23)],
							);
				compactAdversarialContext = {
					truncated: true,
					run_id: state.runId,
					accepted_candidate: acceptedCandidate
						? { ...acceptedCandidate, summary: acceptedCandidate.summary.slice(0, 240) }
						: undefined,
					authoritative_receipts: authoritativeReceipts.slice(-2),
					critical_requirement_count: state.obligations.filter((item) => item.critical).length,
					critical_requirement_excerpts: sampledRequirements.map((item) => ({
						...item,
						description: item.description.slice(0, 64),
					})),
					obligation_coverage_receipt_count: obligationCoverageReceiptCount,
					critical_assumptions: criticalAssumptions.slice(-1),
					python_probe_contract: pythonProbeBindings
						? {
								probe_version: 1,
								runtime: "python_call_v1",
								module_path:
									pythonProbeBindings.modulePaths.length === 1
										? pythonProbeBindings.modulePaths[0]
										: undefined,
								required_callables: pythonProbeBindings.requiredCallables,
								callable_input_dimensions: pythonProbeBindings.callableInputDimensions,
								surface_error: pythonProbeBindings.surfaceError,
								minimum_cases: pythonProbeBindings.minimumCases,
								maximum_cases: pythonProbeBindings.maximumCases,
								minimum_cross_requirement_cases: pythonProbeBindings.minimumCrossRequirementCases,
								minimum_distinct_requirements: pythonProbeBindings.minimumDistinctRequirements,
								minimum_contrasted_input_dimensions: pythonProbeBindings.minimumContrastedInputDimensions,
								require_cross_requirement_case_per_required_callable:
									pythonProbeBindings.minimumCrossRequirementCases > 0,
							}
						: undefined,
					review_files: reviewFiles.map((item) => ({
						...item,
						excerpt: item.excerpt.slice(0, 128),
						truncated: true,
					})),
				};
			}
			const rawContextJson = JSON.stringify(rawContext);
			const context =
				rawContextJson.length <= (adversarialReview ? 8_000 : 3_500)
					? rawContext
					: adversarialReview && compactAdversarialContext
						? {
								...compactAdversarialContext,
								sha256: createHash("sha256").update(rawContextJson).digest("hex"),
							}
						: {
								truncated: true,
								sha256: createHash("sha256").update(rawContextJson).digest("hex"),
								contextPrefix: rawContextJson.slice(0, 3_000),
							};
			const packet = buildAvoSupervisorPacket(state, context, adversarialReview ? "" : supervisorMemory.context);
			const serialized = JSON.stringify(packet);
			const boundedPacket: Record<string, unknown> =
				serialized.length <= (adversarialReview ? 12_000 : 7_000)
					? packet
					: {
							packet_version: 1,
							truncated: true,
							sha256: createHash("sha256").update(serialized).digest("hex"),
							run_id: state.runId,
							objective: state.objective?.slice(0, 1_500),
							environment: state.routing.environment,
							horizon: state.routing.horizon,
							latest_checkpoint: state.checkpoints.at(-1),
							adapter_context: context,
						};
			let prompt = buildAvoSupervisorMessage(
				state,
				cycleId,
				context,
				adversarialReview ? "" : supervisorMemory.context,
				adversarialReview ? undefined : boundedPacket,
			);
			if (probeValidationFeedback) {
				prompt = `${prompt}\n\n[HOST PROBE VALIDATION]\nYour previous probe_plan was rejected: ${probeValidationFeedback.slice(0, 1_000)}\nReturn one corrected complete AVO_SUPERVISION_JSON response for this same cycle. This is the only automatic schema-repair turn.`;
			}
			if (prompt.length > 16_384) throw new Error("AVO supervisor prompt exceeds the retained-message limit");
			const receipt = await this._agentMessageController!.sendAgentMessage({
				target: assertDirectAgentMessageTarget(supervisor.name),
				message: normalizeAgentSessionMessage(prompt),
			});
			return { receipt };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async _bindAvoPythonProbeReview(
		runtime: AvoSessionRuntime,
		cycle: AvoRunState["cycles"][number],
		candidate: AvoRunState["candidates"][number],
		message: string,
		bindings: AvoPythonProbeBindings,
		parsed: ReturnType<typeof parseAvoSupervisorMessage>,
		executorAvailability: AvoPythonProbeExecutorAvailability = getAvoPythonProbeExecutorAvailability(),
	): Promise<ReturnType<typeof parseAvoSupervisorMessage>> {
		if (parsed.status !== "progressing") return parsed;
		const currentState = runtime.getState();
		const probeContractDigest = digestAvoPythonProbeApplicability(currentState, candidate);
		const prospectiveContract = [...currentState.evaluations]
			.reverse()
			.find(
				(item) =>
					item.candidateId === candidate.candidateId &&
					item.evaluatorId === "adversarial_probe_contract" &&
					item.issuedBy === "host" &&
					item.metrics.probe_contract_digest === probeContractDigest &&
					item.metrics.probe_required === true &&
					item.metrics.workspace_matches_candidate === true &&
					item.metrics.python_bundle_matches_candidate === true &&
					item.metrics.candidate_payload_digest === candidate.payloadDigest &&
					item.metrics.candidate_workspace_digest === candidate.workspaceDigest &&
					item.metrics.candidate_python_bundle_digest === candidate.pythonProbeBundleDigest,
			);
		const supervisorMessageDigest = createHash("sha256").update(message).digest("hex");
		const existingAttempts = currentState.evaluations.filter(
			(item) =>
				item.candidateId === candidate.candidateId &&
				item.evaluatorId === "adversarial_probe" &&
				item.metrics.supervisor_cycle_id === cycle.cycleId &&
				item.metrics.probe_contract_digest === probeContractDigest,
		);
		const existing = existingAttempts.at(-1);
		if (existing) {
			const reason =
				typeof existing.metrics.validation_reason === "string"
					? existing.metrics.validation_reason
					: "the existing immutable adversarial probe receipt has no validation reason";
			const exactRegisteredContract =
				prospectiveContract !== undefined &&
				existing.metrics.probe_contract_registered === true &&
				existing.metrics.probe_contract_evaluation_id === prospectiveContract.evaluationId;
			if (existing.status === "pass" && exactRegisteredContract) {
				return {
					...parsed,
					reason: `${parsed.reason.trim()} Host-executed supervisor challenges: ${reason}.`,
					detectedPatterns: [...parsed.detectedPatterns, "host_executed_model_oracle_matched"],
				};
			}
			if (existing.status === "revise" || existing.status === "fail") {
				return {
					...parsed,
					status: "intervene",
					reason,
					detectedPatterns: [...parsed.detectedPatterns, "adversarial_probe_failure"],
					recommendedActions: [
						"Revise the candidate or provide a valid requirement-linked probe plan.",
						...parsed.recommendedActions,
					].slice(0, 3),
				};
			}
			const sameMessage = existing.metrics.probe_supervisor_message_digest === supervisorMessageDigest;
			const contractWasRepaired = !exactRegisteredContract && prospectiveContract !== undefined;
			const environmentMayHaveRecovered =
				existing.metrics.probe_environment_unsupported === true &&
				prospectiveContract !== undefined &&
				!bindings.surfaceError &&
				executorAvailability.available &&
				(existing.metrics.probe_executor_available !== true ||
					existing.metrics.probe_surface_unsupported === true ||
					!sameMessage);
			const correctedPlan =
				existing.metrics.probe_environment_unsupported !== true &&
				!bindings.surfaceError &&
				executorAvailability.available &&
				!sameMessage;
			if (!contractWasRepaired && !environmentMayHaveRecovered && !correctedPlan) {
				return {
					...parsed,
					status: "watch",
					reason:
						existing.metrics.probe_environment_unsupported === true
							? `${parsed.reason.trim()} Host probes were unavailable: ${reason}.`
							: reason,
					detectedPatterns: [
						...parsed.detectedPatterns,
						existing.metrics.probe_environment_unsupported === true
							? "adversarial_probe_environment_unsupported"
							: "invalid_adversarial_probe_plan",
					],
				};
			}
		}
		const attemptIndex = existingAttempts.length;
		let plan: AvoPythonProbePlan | undefined;
		let adequacy: ReturnType<typeof assessAvoPythonProbeAdequacy> | undefined;
		let execution: Awaited<ReturnType<AgentSession["_runAvoPythonProbe"]>> | undefined;
		let validationError: string | undefined;
		if (!prospectiveContract) {
			validationError = "the host did not preregister this Python probe contract before supervisor review";
		} else if (bindings.surfaceError) {
			validationError = bindings.surfaceError;
		} else if (!executorAvailability.available) {
			validationError = executorAvailability.reason ?? "the host has no isolated Python probe executor";
		} else {
			try {
				plan = parseAvoPythonProbePlan(message, cycle.cycleId, bindings);
				adequacy = assessAvoPythonProbeAdequacy(plan, bindings);
				execution = await this._runAvoPythonProbe(candidate, plan);
				validationError = execution.error;
			} catch (error) {
				validationError = error instanceof Error ? error.message : String(error);
			}
		}
		const passed =
			plan !== undefined &&
			execution?.report?.passed === true &&
			execution.exitCode === 0 &&
			!execution.timedOut &&
			!execution.truncated &&
			!validationError;
		const failedResults = execution?.report?.results.filter((item) => item.status === "fail") ?? [];
		const brokerUnavailable = /^host probe broker (?:connection failed|timed out|closed without a result)/.test(
			validationError ?? "",
		);
		const candidateSurfaceInvalid =
			Boolean(bindings.surfaceError) && bindings.surfaceErrorDisposition === "candidate_invalid";
		const probeEnvironmentUnsupported =
			!prospectiveContract ||
			(Boolean(bindings.surfaceError) && !candidateSurfaceInvalid) ||
			!executorAvailability.available ||
			brokerUnavailable ||
			(failedResults.length > 0 &&
				failedResults.length === execution?.report?.results.length &&
				failedResults.every((item) =>
					/^module import failed: (?:ModuleNotFoundError|ImportError):/.test(item.error ?? ""),
				));
		const planDigest = digestAvoPayload(
			plan ?? {
				cycleId: cycle.cycleId,
				invalidProbeMessageDigest: createHash("sha256").update(message).digest("hex"),
			},
		);
		const reportDigest = digestAvoPayload(
			execution?.report ?? { error: validationError ?? "probe produced no report" },
		);
		const receiptDigest = digestAvoPayload({
			attemptIndex,
			cycleId: cycle.cycleId,
			candidateId: candidate.candidateId,
			candidatePayloadDigest: candidate.payloadDigest,
			candidateWorkspaceDigest: candidate.workspaceDigest,
			candidatePythonBundleDigest: candidate.pythonProbeBundleDigest,
			probeContractDigest,
			probeContractEvaluationId: prospectiveContract?.evaluationId ?? "missing",
			planDigest,
			reportDigest,
			exitCode: execution?.exitCode ?? null,
			timedOut: execution?.timedOut ?? false,
			truncated: execution?.truncated ?? false,
			validationError,
		});
		const executionDiagnostic = execution?.stderr.trim() || execution?.stdout.trim() || "";
		const validationReason = passed
			? `${execution!.report!.results.length} distinct fresh-process host-sandboxed supervisor challenges matched the retained model oracle; ${adequacy?.contrastedInputDimensions ?? 0}/${adequacy?.requiredInputDimensions ?? 0} host-required input contrasts executed; this is diagnostic and not semantic proof`
			: probeEnvironmentUnsupported
				? (bindings.surfaceError ??
					executorAvailability.reason ??
					validationError ??
					"the isolated system Python could not import a candidate dependency; executable adversarial proof remains unavailable")
				: validationError
					? `adversarial probe was not executable: ${validationError}${executionDiagnostic ? `; runner=${executionDiagnostic.slice(0, 500)}` : ""}`
					: `${failedResults.length} of ${execution?.report?.results.length ?? 0} adversarial probe cases failed`;
		runtime.recordHostEvaluation({
			evaluationId: `evaluation-adversarial-probe-${createHash("sha256")
				.update(
					`${runtime.getState().runId}\0${cycle.cycleId}\0${candidate.candidateId}\0${probeContractDigest}\0${prospectiveContract?.evaluationId ?? "missing"}\0${attemptIndex}\0${supervisorMessageDigest}`,
				)
				.digest("hex")}`,
			candidateId: candidate.candidateId,
			evaluatorId: "adversarial_probe",
			status: passed
				? "pass"
				: candidateSurfaceInvalid
					? "revise"
					: probeEnvironmentUnsupported
						? "inconclusive"
						: execution?.report
							? "revise"
							: "inconclusive",
			authority: "model_opinion",
			evidenceRefs: [`host:adversarial-probe:${receiptDigest}`],
			metrics: {
				meaningful: false,
				probe_execution_observed: execution?.report !== undefined,
				probe_oracle_source: "retained_supervisor",
				probe_semantic_authority: false,
				probe_attempt_index: attemptIndex,
				probe_supervisor_message_digest: supervisorMessageDigest,
				candidate_payload_digest: candidate.payloadDigest,
				candidate_workspace_digest: candidate.workspaceDigest ?? "missing",
				candidate_python_bundle_digest: candidate.pythonProbeBundleDigest ?? "missing",
				workspace_matches_candidate:
					execution !== undefined && execution.postWorkspaceDigest === candidate.workspaceDigest,
				supervisor_cycle_id: cycle.cycleId,
				probe_contract_digest: probeContractDigest,
				probe_contract_evaluation_id: prospectiveContract?.evaluationId ?? "missing",
				probe_contract_registered: prospectiveContract !== undefined,
				probe_runtime: plan?.runtime ?? "invalid",
				probe_plan_digest: planDigest,
				probe_report_digest: reportDigest,
				probe_plan: JSON.stringify(plan ?? { error: validationError ?? "missing plan" }).slice(0, 32_000),
				probe_callables: [...new Set(plan?.cases.map((item) => item.callable) ?? [])].sort().join(","),
				probe_required_callables: [...bindings.requiredCallables].sort().join(","),
				probe_adequacy_policy: "host_signature_contrast_model_oracle_v4",
				probe_required_contrast_dimension_count: adequacy?.requiredInputDimensions ?? 0,
				probe_contrasted_input_dimension_count: adequacy?.contrastedInputDimensions ?? 0,
				probe_case_count: plan?.cases.length ?? 0,
				probe_unique_input_count: plan?.cases.length ?? 0,
				probe_passed_case_count: execution?.report?.results.filter((item) => item.status === "pass").length ?? 0,
				probe_failed_case_count: failedResults.length,
				probe_environment_unsupported: probeEnvironmentUnsupported,
				probe_surface_unsupported: Boolean(bindings.surfaceError),
				probe_surface_disposition: bindings.surfaceErrorDisposition ?? "supported",
				probe_executor_available: executorAvailability.available,
				probe_executor_mode: executorAvailability.mode,
				exit_code: execution?.exitCode ?? -1,
				timed_out: execution?.timedOut ?? false,
				truncated: execution?.truncated ?? false,
				duration_ms: execution?.durationMs ?? 0,
				probe_report: JSON.stringify(execution?.report ?? { error: validationError ?? "missing report" }).slice(
					0,
					8_000,
				),
				probe_stdout: execution?.stdout.slice(0, 2_000) ?? "",
				probe_stderr: execution?.stderr.slice(0, 2_000) ?? "",
				validation_reason: validationReason,
			},
		});
		if (passed) {
			return {
				...parsed,
				reason: `${parsed.reason.trim()} Host-executed supervisor challenges: ${validationReason}.`,
				detectedPatterns: [...parsed.detectedPatterns, "host_executed_model_oracle_matched"],
			};
		}
		if (probeEnvironmentUnsupported) {
			return {
				...parsed,
				status: "watch",
				reason: `${parsed.reason.trim()} Host probes were unavailable: ${validationReason}.`,
				detectedPatterns: [...parsed.detectedPatterns, "adversarial_probe_environment_unsupported"],
			};
		}
		const failureActions = failedResults
			.slice(0, 3)
			.map(
				(item) =>
					`probe_case=${item.caseId}; actual=${JSON.stringify(item.actual ?? item.error ?? null).slice(0, 300)}; expected=${JSON.stringify(item.expected ?? null).slice(0, 300)}`,
			);
		return {
			...parsed,
			status: candidateSurfaceInvalid || execution?.report ? "intervene" : "watch",
			reason: validationReason,
			detectedPatterns: [
				...parsed.detectedPatterns,
				candidateSurfaceInvalid
					? "adversarial_probe_surface_invalid"
					: execution?.report
						? "adversarial_probe_failure"
						: "invalid_adversarial_probe_plan",
			],
			recommendedActions: [
				...(candidateSurfaceInvalid
					? [`Revise the candidate to restore the required Python surface: ${validationReason}`]
					: []),
				...failureActions,
				...parsed.recommendedActions,
			].slice(0, 3),
		};
	}

	private async _collectAvoSupervisorResults(): Promise<{
		ingested: number;
		supervision: ReturnType<AvoSessionRuntime["getState"]>["supervision"];
		errors: string[];
	}> {
		const runtime = this._requireAvoRuntime();
		const state = runtime.getState();
		if (
			state.delivery.phase === "pending" ||
			state.delivery.phase === "failed" ||
			state.status === "failed" ||
			this._avoCanonicalDeliveryFailedRunIds.has(state.runId)
		) {
			return { ingested: 0, supervision: state.supervision, errors: [] };
		}
		const supervisor = state.supervisor;
		if (!supervisor) return { ingested: 0, supervision: state.supervision, errors: [] };
		let ingested = 0;
		const errors: string[] = [];
		const messages = [...this.messages];
		for (const action of this._actionStore.unfinishedActions()) {
			if (action.payload.kind === "turn" && action.payload.customMessage)
				messages.push(action.payload.customMessage);
		}
		const pendingCycles = state.cycles.filter((cycle) => {
			const latest = [...state.supervision]
				.reverse()
				.find((review) => review.cycleId === cycle.cycleId && review.source === "retained_supervisor");
			return !latest || latest.status === "watch";
		});
		for (const cycle of pendingCycles) {
			const marker = `AVO_SUPERVISION_JSON:${cycle.cycleId}`;
			const message = [...messages]
				.reverse()
				.find(
					(item) =>
						isAgentSessionMessage(item) &&
						item.details.message.includes(marker) &&
						item.details.from?.sessionName === supervisor.name,
				);
			let text = message && isAgentSessionMessage(message) ? message.details.message : undefined;
			if (!text) {
				const retainedSession = this.getRlmChildSession(supervisor.rlmChildId);
				if (retainedSession) {
					text = findAvoSupervisorResponseText(
						retainedSession.messages.flatMap((item) =>
							item.role === "assistant" ? [readAssistantText(item)] : [],
						),
						cycle.cycleId,
					);
				}
			}
			if (!text) {
				const children = (await this.listRlmSubagents()).subagents;
				const child =
					children.find(
						(item) => item.rlm_child_id === supervisor.rlmChildId || item.session_name === supervisor.name,
					) ?? this._persistedAutoresearchSubagent(supervisor.rlmChildId, supervisor.name);
				if (child?.status === "completed" || child?.status === "error") {
					text = this._readAutoresearchTerminal(child, marker);
				}
			}
			if (!text) continue;
			try {
				const currentState = runtime.getState();
				const priorReview = [...currentState.supervision]
					.reverse()
					.find((review) => review.cycleId === cycle.cycleId && review.source === "retained_supervisor");
				const inputDigest = createHash("sha256").update(text).digest("hex");
				const priorProbeAttemptCount = currentState.evaluations.filter(
					(item) => item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === cycle.cycleId,
				).length;
				const candidate = currentState.candidates.find((item) => item.candidateId === cycle.candidateId);
				const trajectoryVerificationRequired = requiresAvoAdversarialReview(currentState, cycle.cycleId);
				const adversarialBindings = trajectoryVerificationRequired
					? {
							sourcePaths: this._avoAdversarialReviewPaths(currentState, candidate),
							requirementIds: currentState.obligations
								.filter((item) => item.critical && item.kind !== "outcome")
								.map((item) => item.obligationId),
							minimumAnalyses:
								currentState.obligations.filter((item) => item.critical && item.kind !== "outcome").length >= 16
									? 3
									: 1,
							requireCrossRequirement:
								currentState.obligations.filter((item) => item.critical && item.kind !== "outcome").length >=
								16,
						}
					: undefined;
				let parsed = parseAvoSupervisorMessage(text, cycle.cycleId, adversarialBindings);
				const pythonProbeBindings = trajectoryVerificationRequired
					? this._avoPythonProbeBindings(currentState, candidate)
					: undefined;
				if (candidate && pythonProbeBindings) {
					parsed = await this._bindAvoPythonProbeReview(
						runtime,
						cycle,
						candidate,
						text,
						pythonProbeBindings,
						parsed,
					);
				}
				const probeAttemptCount = runtime
					.getState()
					.evaluations.filter(
						(item) =>
							item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === cycle.cycleId,
					).length;
				if (
					priorReview &&
					priorReview.inputDigest === inputDigest &&
					probeAttemptCount === priorProbeAttemptCount
				) {
					continue;
				}
				const attemptIndex = priorReview ? (priorReview.attemptIndex ?? 0) + 1 : 0;
				runtime.store.recordSupervision({
					...parsed,
					source: "retained_supervisor",
					attemptIndex,
					inputDigest,
					supersedesReviewId: priorReview?.reviewId,
				});
				if (
					parsed.status === "progressing" &&
					cycle.outcome === "accepted" &&
					runtime.getState().routing.horizon === "long" &&
					!this._pendingAvoCanonicalDelivery()
				) {
					const clearedState = runtime.getState();
					const trigger = clearedState.cycles.length % 5 === 0 ? "five_cycles" : "candidate_acceptance";
					await this._runAvoGenerativeMemoryReflection(cycle.cycleId, trigger);
					await this._runAvoGenerativeMemoryReconciliation(cycle.cycleId);
				}
				if (
					attemptIndex === 0 &&
					parsed.status === "watch" &&
					parsed.detectedPatterns.includes("invalid_adversarial_probe_plan")
				) {
					const validationReason = runtime
						.getState()
						.evaluations.filter(
							(item) =>
								item.evaluatorId === "adversarial_probe" && item.metrics.supervisor_cycle_id === cycle.cycleId,
						)
						.at(-1)?.metrics.validation_reason;
					const correction = await this._dispatchAvoCheckpoint(
						supervisor,
						cycle.cycleId,
						typeof validationReason === "string" ? validationReason : parsed.reason,
					);
					if (correction.error) errors.push(correction.error);
				}
				ingested += 1;
			} catch (error) {
				errors.push(error instanceof Error ? error.message : String(error));
			}
		}
		return { ingested, supervision: runtime.getState().supervision, errors };
	}

	private _bindAvoExperimentTrial(
		runtime: AvoSessionRuntime,
		input: ReturnType<typeof parseAvoTrialInput>,
		sourceEvaluation: AvoEvaluationReceipt,
		output = "",
	): Record<string, unknown> {
		const contract = runtime.store.prepareTrialExecution(
			input.experimentId,
			input.candidateId,
			input.conditionId,
			input.seed,
		);
		const state = runtime.getState();
		const experiment = state.experiments.find((item) => item.experimentId === input.experimentId);
		const candidate = state.candidates.find((item) => item.candidateId === input.candidateId);
		if (!experiment?.plan || !candidate) throw new Error("experiment trial references missing host state");
		if (
			sourceEvaluation.candidateId !== candidate.candidateId ||
			sourceEvaluation.issuedBy !== "host" ||
			sourceEvaluation.authority === "model_opinion" ||
			["experiment_trial", "experiment_aggregate"].includes(sourceEvaluation.evaluatorId) ||
			sourceEvaluation.status !== "pass" ||
			sourceEvaluation.metrics.meaningful !== true
		) {
			throw new Error("experiment trial source must be a meaningful passing host evaluation for the candidate");
		}
		if (sourceEvaluation.metrics.command_digest !== contract.commandDigest) {
			throw new Error("experiment trial source command does not match the host-rendered preregistered cell");
		}
		if (sourceEvaluation.metrics.candidate_payload_digest !== candidate.payloadDigest) {
			throw new Error("experiment trial source is not bound to the current candidate payload");
		}
		runtime.store.assertTrialSourceOrder(experiment.experimentId, sourceEvaluation.evaluationId);
		const outputMetrics = parseAvoTrialMetricsOutput(output, experiment.plan.primaryMetric);
		const primaryValue =
			outputMetrics[experiment.plan.primaryMetric] ?? sourceEvaluation.metrics[experiment.plan.primaryMetric];
		if (typeof primaryValue !== "number" || !Number.isFinite(primaryValue)) {
			throw new Error(
				`trial command must emit AVO_TRIAL_METRICS_JSON:{"${experiment.plan.primaryMetric}":<finite number>}`,
			);
		}
		const evaluation = runtime.recordHostEvaluation({
			candidateId: candidate.candidateId,
			evaluatorId: "experiment_trial",
			status: "pass",
			authority: "host",
			evidenceRefs: [
				...sourceEvaluation.evidenceRefs,
				`host:experiment-cell:${contract.cellDigest}`,
				`evaluation:${sourceEvaluation.evaluationId}`,
			],
			metrics: {
				...sourceEvaluation.metrics,
				meaningful: true,
				[experiment.plan.primaryMetric]: primaryValue,
				experiment_id: experiment.experimentId,
				condition_id: contract.conditionId,
				seed: contract.seed,
				command_digest: contract.commandDigest,
				cell_digest: contract.cellDigest,
				source_evaluation_id: sourceEvaluation.evaluationId,
				source_evaluation_created_at: sourceEvaluation.createdAt,
				candidate_payload_digest: candidate.payloadDigest,
			},
		});
		const trial = runtime.recordTrial({ ...input, evaluationId: evaluation.evaluationId });
		return { trial, evaluation, sourceEvaluation, contract };
	}

	async handleAvoHostRequest(type: string, payload: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const runtime = this._requireAvoRuntime();
		const pendingDelivery = this._pendingAvoCanonicalDelivery();
		if (type !== "avo.get" && (pendingDelivery || this._isAvoCanonicalDeliveryTerminalFailure())) {
			const state = runtime.getState();
			throw new Error(
				this._isAvoCanonicalDeliveryTerminalFailure()
					? `AVO_CANONICAL_DELIVERY_FAILED run_id=${state.runId}: the terminal invariant failure is already recorded; no recovery loop is permitted`
					: `AVO_CANONICAL_DELIVERY_PENDING run_id=${state.runId} candidate_id=${pendingDelivery?.candidateId ?? "unknown"}: only the exact canonical assistant response is permitted`,
			);
		}
		switch (type) {
			case "avo.initialize": {
				if (typeof payload.objective !== "string") throw new Error("avo.initialize objective must be a string");
				const current = runtime.getState();
				const state = current.objective ? current : runtime.store.initialize(payload.objective, payload.objective);
				return { state };
			}
			case "avo.get":
				return { state: runtime.getState() };
			case "avo.obligations.register": {
				if (isAvoFeatureAblated("obligations")) return { obligations: [], disabled: true };
				if (!Array.isArray(payload.obligations)) throw new Error("avo.obligations.register requires an array");
				return {
					obligations: runtime.registerObligations(payload.obligations.map(parseAvoObligationInput)),
				};
			}
			case "avo.obligations.cover":
				if (isAvoFeatureAblated("obligations")) return { coverage: null, disabled: true };
				return { coverage: runtime.recordObligationCoverage(parseAvoObligationCoverageInput(payload.coverage)) };
			case "avo.assumptions.register": {
				if (isAvoFeatureAblated("critical_assumptions")) return { assumptions: [], disabled: true };
				if (!Array.isArray(payload.assumptions)) throw new Error("avo.assumptions.register requires an array");
				const state = runtime.getState();
				if (state.routing.environment === "coding" && state.verificationBaseline) {
					const workspace = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
						excludedRoots: this._avoWorkspaceExcludedRoots(),
					});
					const preregistrationDigest =
						state.verificationBaseline.executions.at(-1)?.postWorkspaceDigest ??
						state.verificationBaseline.workspaceDigest;
					if (workspace.digest !== preregistrationDigest) {
						throw new Error(
							"critical assumptions must be preregistered before task workspace changes; restore or start a fresh task run",
						);
					}
				}
				return {
					assumptions: runtime.registerCriticalAssumptions(
						payload.assumptions.map(parseAvoCriticalAssumptionInput),
					),
				};
			}
			case "avo.assumptions.resolve":
				if (isAvoFeatureAblated("critical_assumptions")) return { assumption: null, disabled: true };
				return {
					assumption: runtime.resolveCriticalAssumption(parseAvoAssumptionResolutionInput(payload.resolution)),
				};
			case "avo.configure": {
				const environment = payload.environment;
				const horizon = payload.horizon;
				if (environment !== undefined)
					throw new Error("AVO environment is host-routed and cannot be model-configured");
				if (horizon !== "iterative" && horizon !== "long") {
					throw new Error("model-facing AVO configure may only escalate horizon to iterative or long");
				}
				const current = runtime.getState().routing.horizon;
				const rank = { direct: 0, iterative: 1, long: 2 } as const;
				if (rank[horizon] < rank[current]) throw new Error("model-facing AVO configure cannot lower the horizon");
				return {
					state: runtime.configure({
						horizon: horizon as AvoHorizonSelection | undefined,
						source: "model",
					}),
				};
			}
			case "avo.candidate.add": {
				const candidate = parseAvoCandidateInput(payload.candidate);
				if (runtime.getState().routing.environment === "coding") {
					const state = runtime.getState();
					const workspace = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
						excludedRoots: this._avoWorkspaceExcludedRoots(),
					});
					candidate.workspaceDigest = workspace.digest;
					candidate.workspaceHead = workspace.head;
					candidate.workspaceMode = workspace.mode;
					candidate.workspaceChangedPaths = deriveAvoWorkspaceImpactPaths(state.verificationBaseline, workspace);
					if (candidate.workspaceChangedPaths.some((path) => path.endsWith(".py"))) {
						candidate.pythonProbeBundleDigest = captureAvoPythonProbeBundle(this.sessionManager.getCwd(), {
							excludedRoots: this._avoWorkspaceExcludedRoots(),
						}).digest;
					}
				}
				return { candidate: runtime.recordCandidate(candidate) };
			}
			case "avo.evaluation.record": {
				const evaluation = parseAvoEvaluationInput(payload.evaluation);
				if (evaluation.authority !== "model_opinion") {
					throw new Error(
						"model-submitted evaluations must use authority=model_opinion; use avo.evaluation.run for host-observed executable evidence",
					);
				}
				return { evaluation: runtime.recordEvaluation(evaluation) };
			}
			case "avo.external.fetch": {
				if (typeof payload.url !== "string" || payload.url.length > 4_096) {
					throw new Error("avo.external.fetch url must contain 1 to 4096 characters");
				}
				const state = runtime.getState();
				if (state.routing.environment !== "general" || state.verificationClass !== "external_factual") {
					throw new Error("AVO external source fetching is available only for general external-factual tasks");
				}
				const source = await this._fetchAvoExternalSource(payload.url);
				return {
					source: {
						url: source.url,
						text: source.text,
						body_digest: source.bodyDigest,
						content_type: source.contentType,
						truncated: source.truncated,
						fetched_at: new Date().toISOString(),
					},
				};
			}
			case "avo.verification.baseline.run": {
				if (typeof payload.command !== "string") {
					throw new Error("avo.verification.baseline.run command must be a string");
				}
				if (classifyAvoHostEvaluationCommand(payload.command) !== "test") {
					throw new Error("the coding verification baseline must be a recognized direct test command");
				}
				const state = runtime.getState();
				if (state.routing.environment !== "coding" || !state.verificationBaseline) {
					throw new Error("coding baseline execution is available only for a host-routed coding task");
				}
				if (state.candidates.length > 0) {
					throw new Error("coding baseline execution must run before the first candidate is recorded");
				}
				const workspace = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				});
				if (workspace.digest !== state.verificationBaseline.workspaceDigest) {
					throw new Error("the workspace changed before its immutable coding baseline was executed");
				}
				const verificationHarnessBefore = captureAvoVerificationHarnessManifest(
					this.sessionManager.getCwd(),
					payload.command,
					state.verificationBaseline,
				);
				const result = await this._executeAvoVerificationBash(payload.command);
				const assessment = assessAvoHostCommand("test", {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					output: result.output,
				});
				const trust = assessAvoTestTrust(
					this.sessionManager.getCwd(),
					payload.command,
					state.verificationBaseline,
					result.output,
				);
				const observedWorkUnits =
					typeof assessment.metrics.observed_work_units === "number" ? assessment.metrics.observed_work_units : 0;
				const observedPassedWorkUnits =
					typeof assessment.metrics.observed_passed_work_units === "number"
						? assessment.metrics.observed_passed_work_units
						: 0;
				const observedTestIdentities = deriveAvoObservedTestIdentities(result.output);
				const commandDigest = createHash("sha256").update(payload.command).digest("hex");
				const outputDigest = createHash("sha256").update(result.output).digest("hex");
				const postWorkspace = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				});
				const verificationHarnessAfter = trust.verificationHarness;
				const harnessStable =
					verificationHarnessBefore.supported &&
					verificationHarnessAfter?.supported === true &&
					verificationHarnessBefore.digest === verificationHarnessAfter.digest;
				const verificationBrokerTimedOut =
					result.verificationMode === "host_broker" && result.verificationBrokerReceipt?.timedOut === true;
				const verificationBrokerWorkspaceMatched = avoVerificationBrokerReceiptMatchesWorkspace(
					payload.command,
					result.verificationMode,
					result.verificationBrokerReceipt,
					workspace.digest,
				);
				const meaningful =
					!verificationBrokerTimedOut &&
					verificationBrokerWorkspaceMatched &&
					assessment.metrics.meaningful === true &&
					trust.trusted &&
					trust.executionProven &&
					harnessStable &&
					postWorkspace.digest === workspace.digest &&
					observedWorkUnits > 0 &&
					observedTestIdentities.length > 0;
				const execution = runtime.store.recordVerificationBaselineExecution({
					command: payload.command,
					commandDigest,
					outputDigest,
					workspaceDigest: workspace.digest,
					postWorkspaceDigest: postWorkspace.digest,
					status: assessment.status,
					meaningful,
					observedWorkUnits,
					observedPassedWorkUnits,
					observedTestIdentities,
					observedBaselineTestFiles: trust.observedBaselineTestFiles,
					testTrustBasis: trust.basis,
					verificationHarness: verificationHarnessBefore,
				});
				return {
					execution,
					assessment: {
						status: assessment.status,
						meaningful,
						observed_work_units: observedWorkUnits,
						observed_passed_work_units: observedPassedWorkUnits,
						observed_test_identities: observedTestIdentities,
						observed_baseline_test_files: trust.observedBaselineTestFiles,
						test_trust_basis: trust.basis,
						execution_proven: trust.executionProven,
						verification_harness_supported: verificationHarnessBefore.supported,
						verification_harness_stable: harnessStable,
						verification_harness_digest: verificationHarnessBefore.digest,
						verification_execution_mode: result.verificationMode,
						verification_broker_timed_out: verificationBrokerTimedOut,
						verification_broker_workspace_matches_baseline: verificationBrokerWorkspaceMatched,
						verification_broker_workspace_digest: result.verificationBrokerReceipt?.workspaceDigest ?? "missing",
						verification_broker_post_workspace_digest:
							result.verificationBrokerReceipt?.postWorkspaceDigest ?? "missing",
						verification_broker_receipt_digest: result.verificationBrokerReceipt?.receiptDigest ?? "missing",
					},
					output: result.output,
					exit_code: result.exitCode ?? null,
				};
			}
			case "avo.evaluation.deterministic": {
				if (typeof payload.candidate_id !== "string") {
					throw new Error("avo.evaluation.deterministic candidate_id must be a string");
				}
				const state = runtime.getState();
				if (state.routing.environment !== "general" || state.verificationClass !== "deterministic_local") {
					throw new Error("AVO deterministic evaluation is available only for deterministic-local tasks");
				}
				const candidate = state.candidates.find((item) => item.candidateId === payload.candidate_id);
				if (!candidate) throw new Error(`evaluation references unknown candidate ${payload.candidate_id}`);
				if (!state.objective) throw new Error("AVO deterministic evaluation requires an active objective");
				const contract = deriveAvoDeterministicArithmeticContract(state.objective);
				const matches = candidate.deterministicResult === contract.result;
				const receiptDigest = digestAvoPayload({
					candidateId: candidate.candidateId,
					candidatePayloadDigest: candidate.payloadDigest,
					objective: state.objective,
					expression: contract.expression,
					result: contract.result,
					matches,
				});
				const evaluation = runtime.recordHostEvaluation({
					candidateId: candidate.candidateId,
					evaluatorId: "deterministic_result",
					status: matches ? "pass" : "revise",
					authority: "environment",
					evidenceRefs: [`host:deterministic:${receiptDigest}`],
					metrics: {
						meaningful: matches,
						candidate_result_matches_objective: matches,
						candidate_payload_digest: candidate.payloadDigest,
						objective_digest: createHash("sha256").update(state.objective).digest("hex"),
						expression_digest: createHash("sha256").update(contract.expression).digest("hex"),
						expected_result_digest: createHash("sha256").update(contract.result).digest("hex"),
						validation_reason: matches
							? "the candidate result equals the host-evaluated arithmetic objective"
							: "the candidate result does not equal the host-evaluated arithmetic objective",
					},
				});
				return { evaluation, contract: { expression: contract.expression, result: contract.result } };
			}
			case "avo.evaluation.artifacts": {
				if (typeof payload.candidate_id !== "string") {
					throw new Error("avo.evaluation.artifacts candidate_id must be a string");
				}
				const state = runtime.getState();
				if (state.routing.environment !== "general" || state.verificationClass !== "artifact") {
					throw new Error("AVO artifact evaluation is available only for artifact tasks");
				}
				const candidate = state.candidates.find((item) => item.candidateId === payload.candidate_id);
				if (!candidate) throw new Error(`evaluation references unknown candidate ${payload.candidate_id}`);
				if (!candidate.artifactPaths?.length || !candidate.artifactTargetDigest) {
					throw new Error("artifact candidate has no host-recorded artifact_paths contract");
				}
				const allowedRoots = [resolve(this.sessionManager.getCwd())];
				const forbiddenRoots = this._avoWorkspaceExcludedRoots().map((root) => resolve(root));
				const taskStartedAt = Date.parse(state.createdAt);
				const baselinePaths = new Set(state.artifactBaselinePaths ?? []);
				const verified: Array<{ declaredPath: string; path: string; sha256: string; size: number }> = [];
				const failures: string[] = [];
				const resolvedArtifacts = new Set<string>();
				for (const requestedPath of candidate.artifactPaths) {
					try {
						const absolute = isAbsolute(requestedPath)
							? resolve(requestedPath)
							: resolve(this.sessionManager.getCwd(), requestedPath);
						if (lstatSync(absolute).isSymbolicLink()) throw new Error("symbolic-link artifacts are not accepted");
						const resolvedPath = realpathSync(absolute);
						if (resolvedArtifacts.has(resolvedPath)) {
							throw new Error("artifact path aliases another declared artifact");
						}
						resolvedArtifacts.add(resolvedPath);
						const insideAllowedRoot = allowedRoots.some((root) => {
							const fromRoot = relative(root, resolvedPath);
							return (
								fromRoot === "" ||
								(fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
							);
						});
						if (!insideAllowedRoot) throw new Error("path is outside the active workspace");
						if (
							forbiddenRoots.some((root) => resolvedPath === root || resolvedPath.startsWith(`${root}${sep}`))
						) {
							throw new Error("path is inside host-owned session metadata");
						}
						if (baselinePaths.has(resolvedPath)) throw new Error("path already existed at task start");
						const stats = statSync(resolvedPath);
						if (!stats.isFile()) throw new Error("path is not a regular file");
						if (stats.size === 0) throw new Error("file is empty");
						if (stats.size > 128 * 1024 * 1024) throw new Error("file exceeds the 128 MiB verification limit");
						if (
							!Number.isFinite(stats.birthtimeMs) ||
							stats.birthtimeMs <= 0 ||
							(Number.isFinite(taskStartedAt) && stats.birthtimeMs < taskStartedAt)
						) {
							throw new Error("file was not created during the active task");
						}
						verified.push({
							declaredPath: absolute,
							path: resolvedPath,
							sha256: createHash("sha256").update(readFileSync(resolvedPath)).digest("hex"),
							size: stats.size,
						});
					} catch (error) {
						failures.push(`${requestedPath}: ${error instanceof Error ? error.message : String(error)}`);
					}
				}
				const passed = failures.length === 0 && verified.length === candidate.artifactPaths.length;
				const receiptDigest = digestAvoPayload({
					candidateId: candidate.candidateId,
					candidatePayloadDigest: candidate.payloadDigest,
					artifactTargetDigest: candidate.artifactTargetDigest,
					verified,
					failures,
				});
				const evaluation = runtime.recordHostEvaluation({
					candidateId: candidate.candidateId,
					evaluatorId: "artifact_binding",
					status: passed ? "pass" : "revise",
					authority: "environment",
					evidenceRefs: [
						`host:artifact:${receiptDigest}`,
						...verified.map((artifact) => `artifact:${artifact.sha256}:${artifact.path}`),
					],
					metrics: {
						meaningful: passed,
						artifact_candidate_binding: passed,
						artifact_target_digest: candidate.artifactTargetDigest,
						candidate_payload_digest: candidate.payloadDigest,
						artifact_target_count: candidate.artifactPaths.length,
						artifact_verified_count: verified.length,
						artifact_total_bytes: verified.reduce((total, artifact) => total + artifact.size, 0),
						artifact_manifest: JSON.stringify(verified),
						validation_reason: passed ? "every candidate-declared artifact was host-hashed" : failures.join("; "),
					},
				});
				return { evaluation, artifacts: verified, failures };
			}
			case "avo.evaluation.run": {
				if (typeof payload.candidate_id !== "string") {
					throw new Error("avo.evaluation.run candidate_id must be a string");
				}
				if (typeof payload.command !== "string") throw new Error("avo.evaluation.run command must be a string");
				const evaluatorId = classifyAvoHostEvaluationCommand(payload.command);
				const state = runtime.getState();
				if (
					state.routing.environment === "general" &&
					state.verificationPolicy === "required" &&
					(state.verificationClass === "deterministic_local" || state.verificationClass === "artifact")
				) {
					throw new Error(
						state.verificationClass === "deterministic_local"
							? "required deterministic tasks must use avo.evaluation.deterministic"
							: "required artifact tasks must use avo.evaluation.artifacts",
					);
				}
				const candidate = state.candidates.find((item) => item.candidateId === payload.candidate_id);
				if (!candidate) throw new Error(`evaluation references unknown candidate ${payload.candidate_id}`);
				const workspace = captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
					excludedRoots: this._avoWorkspaceExcludedRoots(),
				});
				const requiresWorkspaceBinding = state.routing.environment === "coding";
				if (
					requiresWorkspaceBinding &&
					(!candidate.workspaceDigest || workspace.digest !== candidate.workspaceDigest)
				) {
					const evaluation = runtime.recordHostEvaluation({
						candidateId: candidate.candidateId,
						evaluatorId: "workspace_binding",
						status: "revise",
						authority: "host",
						evidenceRefs: [`host:workspace:${workspace.digest}`],
						metrics: {
							meaningful: false,
							workspace_matches_candidate: false,
							candidate_workspace_digest: candidate.workspaceDigest ?? "missing",
							observed_workspace_digest: workspace.digest,
							candidate_payload_digest: candidate.payloadDigest,
							validation_reason: "workspace changed after candidate creation; record a new candidate",
						},
					});
					return {
						evaluation,
						execution: {
							command: payload.command,
							skipped: true,
							reason: "workspace changed after candidate creation",
							workspace_digest: workspace.digest,
						},
					};
				}
				const commandDigest = createHash("sha256").update(payload.command).digest("hex");
				const baselineExecution = state.verificationBaseline?.executions.find(
					(item) => item.commandDigest === commandDigest && item.meaningful,
				);
				const verificationHarnessBefore =
					requiresWorkspaceBinding && evaluatorId === "test" && state.verificationBaseline
						? captureAvoVerificationHarnessManifest(
								this.sessionManager.getCwd(),
								payload.command,
								state.verificationBaseline,
							)
						: undefined;
				const startedAt = Date.now();
				const result =
					requiresWorkspaceBinding && evaluatorId === "test"
						? await this._executeAvoVerificationBash(payload.command)
						: await this.executeBash(payload.command);
				const verificationBrokerReceipt =
					"verificationBrokerReceipt" in result
						? (result.verificationBrokerReceipt as AvoVerificationBrokerReceipt | undefined)
						: undefined;
				const verificationExecutionMode =
					"verificationMode" in result && typeof result.verificationMode === "string"
						? result.verificationMode
						: "ordinary";
				const durationMs = Date.now() - startedAt;
				let assessment = assessAvoHostCommand(evaluatorId, {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					output: result.output,
				});
				const postWorkspace = requiresWorkspaceBinding
					? captureAvoWorkspaceSnapshot(this.sessionManager.getCwd(), {
							excludedRoots: this._avoWorkspaceExcludedRoots(),
						})
					: workspace;
				const verificationBrokerWorkspaceMatched = avoVerificationBrokerReceiptMatchesWorkspace(
					payload.command,
					verificationExecutionMode,
					verificationBrokerReceipt,
					candidate.workspaceDigest ?? "",
				);
				if (requiresWorkspaceBinding && evaluatorId === "test") {
					const commandPassed = assessment.status === "pass";
					const trust = assessAvoTestTrust(
						this.sessionManager.getCwd(),
						payload.command,
						state.verificationBaseline,
						result.output,
					);
					const postWorkUnits =
						typeof assessment.metrics.observed_work_units === "number"
							? assessment.metrics.observed_work_units
							: 0;
					const postPassedWorkUnits =
						typeof assessment.metrics.observed_passed_work_units === "number"
							? assessment.metrics.observed_passed_work_units
							: 0;
					const postTestIdentities = deriveAvoObservedTestIdentities(result.output);
					const identityMatched =
						baselineExecution !== undefined &&
						JSON.stringify(postTestIdentities) === JSON.stringify(baselineExecution.observedTestIdentities) &&
						(baselineExecution.testTrustBasis === "user_acceptance" ||
							(baselineExecution.observedBaselineTestFiles.length > 0 &&
								baselineExecution.observedBaselineTestFiles.every((path) =>
									trust.observedBaselineTestFiles.includes(path),
								)));
					const verificationHarnessMatched =
						baselineExecution?.verificationHarness?.supported === true &&
						verificationHarnessBefore?.supported === true &&
						trust.verificationHarness?.supported === true &&
						baselineExecution.verificationHarness.commandDigest === commandDigest &&
						baselineExecution.verificationHarness.digest === verificationHarnessBefore.digest &&
						verificationHarnessBefore.digest === trust.verificationHarness.digest;
					const brokerPythonSemanticAuthority =
						verificationBrokerWorkspaceMatched &&
						avoVerificationBrokerGrantsPythonSemanticAuthority(
							payload.command,
							verificationExecutionMode,
							verificationBrokerReceipt,
						);
					const pythonInProcessVerifier =
						verificationHarnessBefore?.runnerFamily === "pytest" &&
						candidate.workspaceChangedPaths?.some((path) => path.endsWith(".py")) === true &&
						!brokerPythonSemanticAuthority;
					const pythonInProcessSelfCertification = commandPassed && pythonInProcessVerifier;
					const baselineExecutionObservedMatched =
						trust.trusted &&
						trust.executionProven &&
						verificationHarnessMatched &&
						identityMatched &&
						postWorkUnits >= (baselineExecution?.observedWorkUnits ?? Number.POSITIVE_INFINITY) &&
						postPassedWorkUnits >= (baselineExecution?.observedPassedWorkUnits ?? Number.POSITIVE_INFINITY) &&
						postWorkUnits - postPassedWorkUnits <=
							(baselineExecution
								? baselineExecution.observedWorkUnits - baselineExecution.observedPassedWorkUnits
								: Number.NEGATIVE_INFINITY);
					const baselineExecutionMatched = baselineExecutionObservedMatched && !pythonInProcessSelfCertification;
					const meaningful = commandPassed
						? trust.taskSpecific && baselineExecutionMatched
						: assessment.metrics.meaningful === true;
					assessment = {
						status: commandPassed ? (meaningful ? "pass" : "inconclusive") : assessment.status,
						metrics: {
							...assessment.metrics,
							meaningful,
							trusted_test: trust.trusted,
							task_specific_test: trust.taskSpecific,
							test_trust_basis: trust.basis,
							test_execution_proven: trust.executionProven,
							observed_baseline_test_files: trust.observedBaselineTestFiles.join(","),
							baseline_execution_matched: baselineExecutionMatched,
							baseline_execution_observed_matched: baselineExecutionObservedMatched,
							baseline_execution_id: baselineExecution?.executionId ?? "missing",
							baseline_pre_status: baselineExecution?.status ?? "missing",
							baseline_observed_work_units: baselineExecution?.observedWorkUnits ?? 0,
							baseline_observed_passed_work_units: baselineExecution?.observedPassedWorkUnits ?? 0,
							baseline_observed_test_identities: JSON.stringify(baselineExecution?.observedTestIdentities ?? []),
							observed_test_identities: JSON.stringify(postTestIdentities),
							test_identity_matched: identityMatched,
							baseline_contract_digest: state.verificationBaseline?.contractDigest ?? "missing",
							baseline_verification_harness_digest: baselineExecution?.verificationHarness?.digest ?? "missing",
							observed_verification_harness_digest: trust.verificationHarness?.digest ?? "missing",
							verification_harness_supported: trust.verificationHarnessSupported,
							verification_harness_matched: verificationHarnessMatched,
							baseline_test_count: trust.baselineTestCount,
							unchanged_baseline_test_count: trust.unchangedBaselineTestCount,
							explicit_baseline_targets: trust.explicitBaselineTargets,
							narrowed_test_selection: trust.narrowedSelection,
							python_in_process_self_certification: pythonInProcessSelfCertification,
							python_test_semantic_authority: !pythonInProcessVerifier,
							verification_execution_mode: verificationExecutionMode,
							verification_broker_python_authority_enabled:
								process.env[AVO_VERIFICATION_BROKER_PYTHON_AUTHORITY_ENV] === "1",
							verification_broker_semantic_authority: brokerPythonSemanticAuthority,
							verification_broker_receipt_digest: verificationBrokerReceipt?.receiptDigest ?? "missing",
							validation_reason:
								commandPassed && meaningful
									? "the same immutable pre-candidate baseline test contract executed and passed afterward"
									: pythonInProcessSelfCertification
										? "in-process pytest output cannot certify changed Python code; use an out-of-process verifier or independently verified specification proof"
										: commandPassed
											? "coding tests require a proven matching pre-candidate baseline execution"
											: typeof assessment.metrics.validation_reason === "string"
												? assessment.metrics.validation_reason
												: "the coding test command did not produce a passing authoritative result",
						},
					};
				}
				if (requiresWorkspaceBinding && !verificationBrokerWorkspaceMatched) {
					assessment = {
						status: "revise",
						metrics: {
							...assessment.metrics,
							meaningful: false,
							verification_broker_workspace_matches_candidate: false,
							verification_broker_workspace_digest: verificationBrokerReceipt?.workspaceDigest ?? "missing",
							verification_broker_post_workspace_digest:
								verificationBrokerReceipt?.postWorkspaceDigest ?? "missing",
							validation_reason:
								"the host verification broker receipt is not bound to the evaluated candidate workspace",
						},
					};
				}
				const verificationBrokerTimedOut =
					verificationExecutionMode === "host_broker" && verificationBrokerReceipt?.timedOut === true;
				if (verificationBrokerTimedOut) {
					assessment = {
						status: "revise",
						metrics: {
							...assessment.metrics,
							meaningful: false,
							verification_broker_timed_out: true,
							validation_reason:
								"the host verification broker timed out before completing authoritative verification",
						},
					};
				}
				if (requiresWorkspaceBinding && postWorkspace.digest !== candidate.workspaceDigest) {
					assessment = {
						status: "revise",
						metrics: {
							...assessment.metrics,
							meaningful: false,
							post_workspace_matches_candidate: false,
							post_workspace_digest: postWorkspace.digest,
							validation_reason: "the authoritative command changed the candidate workspace",
						},
					};
				}
				const receiptDigest = createHash("sha256")
					.update(
						JSON.stringify({
							command: payload.command,
							cwd: this.sessionManager.getCwd(),
							exitCode: result.exitCode ?? null,
							cancelled: result.cancelled,
							output: result.output,
							truncated: result.truncated,
							workspaceDigest: workspace.digest,
							postWorkspaceDigest: postWorkspace.digest,
							candidatePayloadDigest: candidate.payloadDigest,
							verificationBrokerReceiptDigest: verificationBrokerReceipt?.receiptDigest ?? null,
						}),
					)
					.digest("hex");
				const evaluation = runtime.recordHostEvaluation({
					candidateId: payload.candidate_id,
					evaluatorId,
					status: assessment.status,
					authority: "environment",
					evidenceRefs: [
						`host:command:${receiptDigest}`,
						`host:workspace:${workspace.digest}`,
						`host:workspace-post:${postWorkspace.digest}`,
						...(verificationBrokerReceipt
							? [`host:verification-broker:${verificationBrokerReceipt.receiptDigest}`]
							: []),
					],
					metrics: {
						...assessment.metrics,
						command_digest: createHash("sha256").update(payload.command).digest("hex"),
						output_digest: createHash("sha256").update(result.output).digest("hex"),
						duration_ms: durationMs,
						...(requiresWorkspaceBinding
							? { workspace_matches_candidate: verificationBrokerWorkspaceMatched }
							: { workspace_binding: "not_required" }),
						workspace_digest: workspace.digest,
						post_workspace_digest: postWorkspace.digest,
						post_workspace_matches_candidate: postWorkspace.digest === candidate.workspaceDigest,
						workspace_head: workspace.head,
						workspace_mode: workspace.mode,
						workspace_changed_files: workspace.changedFileCount,
						workspace_snapshot_bytes: workspace.totalBytes,
						candidate_payload_digest: candidate.payloadDigest,
						verification_execution_mode: verificationExecutionMode,
						verification_broker_timed_out: verificationBrokerTimedOut,
						verification_broker_workspace_matches_candidate: verificationBrokerWorkspaceMatched,
						verification_broker_workspace_digest: verificationBrokerReceipt?.workspaceDigest ?? "missing",
						verification_broker_post_workspace_digest:
							verificationBrokerReceipt?.postWorkspaceDigest ?? "missing",
						verification_broker_receipt_digest: verificationBrokerReceipt?.receiptDigest ?? "missing",
					},
				});
				return {
					evaluation,
					execution: {
						command: payload.command,
						output: result.output,
						exit_code: result.exitCode ?? null,
						cancelled: result.cancelled,
						truncated: result.truncated,
						receipt_digest: receiptDigest,
						workspace_digest: workspace.digest,
					},
				};
			}
			case "avo.evaluation.url": {
				if (typeof payload.candidate_id !== "string") {
					throw new Error("avo.evaluation.url candidate_id must be a string");
				}
				if (typeof payload.claim_id !== "string") {
					throw new Error("avo.evaluation.url claim_id must be a string");
				}
				if (typeof payload.url !== "string" || payload.url.length > 4_096) {
					throw new Error("avo.evaluation.url url must contain 1 to 4096 characters");
				}
				if (typeof payload.exact_quote !== "string" || payload.exact_quote.trim().length < 8) {
					throw new Error("avo.evaluation.url exact_quote must contain at least 8 characters");
				}
				if (payload.exact_quote.length > 4_000) {
					throw new Error("avo.evaluation.url exact_quote must not exceed 4000 characters");
				}
				const state = runtime.getState();
				if (state.routing.environment !== "general" || state.verificationClass !== "external_factual") {
					throw new Error("URL evidence is available only for general external-factual tasks");
				}
				const candidate = state.candidates.find((item) => item.candidateId === payload.candidate_id);
				if (!candidate) throw new Error(`evaluation references unknown candidate ${payload.candidate_id}`);
				const claim = candidate.claims?.find((item) => item.claimId === payload.claim_id);
				if (!claim) throw new Error(`candidate ${candidate.candidateId} has no claim ${payload.claim_id}`);
				const fetched = await this._fetchAvoExternalSource(payload.url);
				const normalizeEvidence = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
				const normalizedQuote = normalizeEvidence(payload.exact_quote);
				const matchingRecords = fetched.text
					.split("\n")
					.map(normalizeEvidence)
					.filter((record) => record.includes(normalizedQuote));
				if (matchingRecords.length === 0) {
					throw new Error("AVO exact_quote was not found in the host-fetched visible source text");
				}
				if (matchingRecords.length !== 1) {
					throw new Error("AVO exact_quote matched multiple visible source records and is ambiguous");
				}
				const matchedRecord = matchingRecords[0]!;
				const firstOccurrence = matchedRecord.indexOf(normalizedQuote);
				if (matchedRecord.indexOf(normalizedQuote, firstOccurrence + normalizedQuote.length) >= 0) {
					throw new Error("AVO exact_quote occurs multiple times in one visible source record and is ambiguous");
				}
				assertAvoClaimVerifierQuoteSafe(claim.claimText, payload.exact_quote);
				assertAvoClaimSourceContextSafe(claim.claimText, payload.exact_quote, matchedRecord);
				const lexicalAssessment = assessAvoClaimEvidence(claim.claimText, payload.exact_quote);
				const independentAssessment = await this._verifyAvoClaimEvidenceIndependently(
					candidate.candidateId,
					claim.claimId,
					claim.claimText,
					payload.exact_quote,
					state.objective ?? "",
					(candidate.claims ?? []).map((item) => item.claimText),
					candidate.payloadDigest,
				);
				const semanticAssessment = combineAvoClaimEvidenceAssessments(
					lexicalAssessment,
					independentAssessment.verdict,
				);
				const objectiveDigest = createHash("sha256")
					.update(state.objective ?? "")
					.digest("hex");
				const objectiveAddressed = independentAssessment.verdict.objectiveRelation === "addresses";
				const receiptDigest = createHash("sha256")
					.update(
						JSON.stringify({
							url: fetched.url,
							bodyDigest: fetched.bodyDigest,
							candidateId: candidate.candidateId,
							candidatePayloadDigest: candidate.payloadDigest,
							claimId: claim.claimId,
							claimText: claim.claimText,
							exactQuote: payload.exact_quote,
							lexicalRelation: lexicalAssessment.relation,
							independentRelation: independentAssessment.verdict.relation,
							semanticRelation: semanticAssessment.relation,
							objectiveDigest,
							objectiveRelation: independentAssessment.verdict.objectiveRelation,
						}),
					)
					.digest("hex");
				const evaluation = runtime.recordHostEvaluation({
					candidateId: candidate.candidateId,
					evaluatorId: "external_claim",
					status:
						semanticAssessment.relation === "supports" && objectiveAddressed
							? "pass"
							: semanticAssessment.relation === "contradicts" ||
									independentAssessment.verdict.objectiveRelation === "unrelated"
								? "revise"
								: "inconclusive",
					authority: "external",
					evidenceRefs: [`host:url:${receiptDigest}`, `source:${fetched.url}`],
					metrics: {
						meaningful: semanticAssessment.relation === "supports" && objectiveAddressed,
						tool_name: "host_https_fetch",
						claim_id: claim.claimId,
						claim_text_digest: createHash("sha256").update(claim.claimText).digest("hex"),
						semantic_relation: semanticAssessment.relation,
						semantic_reason: semanticAssessment.reason,
						semantic_verifier: "host_bound_exact_claim_independent_rlm_v3",
						lexical_relation: lexicalAssessment.relation,
						lexical_reason: lexicalAssessment.reason,
						independent_relation: independentAssessment.verdict.relation,
						independent_reason: independentAssessment.verdict.reason,
						objective_relation: independentAssessment.verdict.objectiveRelation,
						objective_reason: independentAssessment.verdict.objectiveReason,
						objective_verifier: "host_bound_claim_objective_independent_rlm_v3",
						objective_digest: objectiveDigest,
						independent_verifier_child_id: independentAssessment.verifierChildId ?? "unavailable",
						independent_verifier_model: independentAssessment.verifierModel ?? "unavailable",
						independent_response_digest: independentAssessment.responseDigest ?? "unavailable",
						independent_verifier_error: independentAssessment.error ?? "none",
						claim_token_coverage: semanticAssessment.claimTokenCoverage,
						exact_quote_digest: createHash("sha256").update(payload.exact_quote).digest("hex"),
						candidate_payload_digest: candidate.payloadDigest,
						source_count: 1,
						source_url: fetched.url,
						body_digest: fetched.bodyDigest,
						content_type: fetched.contentType,
						response_truncated: fetched.truncated,
						fetched_at: new Date().toISOString(),
					},
				});
				return {
					evaluation,
					source_receipt: {
						receipt_digest: receiptDigest,
						url: fetched.url,
						body_digest: fetched.bodyDigest,
						claim_id: claim.claimId,
						semantic_relation: semanticAssessment.relation,
						independent_relation: independentAssessment.verdict.relation,
						objective_relation: independentAssessment.verdict.objectiveRelation,
						verifier_child_id: independentAssessment.verifierChildId ?? null,
					},
				};
			}
			case "avo.evaluation.tool_result": {
				if (typeof payload.candidate_id !== "string") {
					throw new Error("avo.evaluation.tool_result candidate_id must be a string");
				}
				if (typeof payload.claim_id !== "string") {
					throw new Error("avo.evaluation.tool_result claim_id must be a string");
				}
				if (typeof payload.tool_call_id !== "string") {
					throw new Error("avo.evaluation.tool_result tool_call_id must be a string");
				}
				if (typeof payload.exact_quote !== "string" || payload.exact_quote.trim().length < 8) {
					throw new Error("avo.evaluation.tool_result exact_quote must contain at least 8 characters");
				}
				if (payload.exact_quote.length > 4_000) {
					throw new Error("avo.evaluation.tool_result exact_quote must not exceed 4000 characters");
				}
				const state = runtime.getState();
				const candidate = state.candidates.find((item) => item.candidateId === payload.candidate_id);
				if (!candidate) throw new Error(`evaluation references unknown candidate ${payload.candidate_id}`);
				const claim = candidate.claims?.find((item) => item.claimId === payload.claim_id);
				if (!claim) throw new Error(`candidate ${candidate.candidateId} has no claim ${payload.claim_id}`);
				const { call, callTimestamp, result } = this._resolveAvoExternalToolResult(payload.tool_call_id);
				if (callTimestamp < Date.parse(state.createdAt)) {
					throw new Error("AVO external evidence must come from the active task run");
				}
				const normalizeEvidence = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
				const normalizedQuote = normalizeEvidence(payload.exact_quote);
				const matchingRecords = result.content.filter(
					(item): item is TextContent =>
						item.type === "text" && normalizeEvidence(item.text).includes(normalizedQuote),
				);
				if (matchingRecords.length === 0) {
					throw new Error("AVO exact_quote was not found in the host-observed tool result");
				}
				if (matchingRecords.length !== 1) {
					throw new Error("AVO exact_quote matched multiple external source records and is ambiguous");
				}
				const evidenceRecord = matchingRecords[0].text;
				const sourceIdentifiers = [
					...new Set(
						(evidenceRecord.match(/https?:\/\/[^\s<>"']+/g) ?? []).map((source) =>
							source.replace(/[),.;!?]+$/g, ""),
						),
					),
				];
				if (sourceIdentifiers.length > 1) {
					throw new Error("AVO external source record contains multiple source URLs and is ambiguous");
				}
				assertAvoClaimVerifierQuoteSafe(claim.claimText, payload.exact_quote);
				assertAvoClaimSourceContextSafe(claim.claimText, payload.exact_quote, evidenceRecord);
				const lexicalAssessment = assessAvoClaimEvidence(claim.claimText, payload.exact_quote);
				const independentAssessment = await this._verifyAvoClaimEvidenceIndependently(
					candidate.candidateId,
					claim.claimId,
					claim.claimText,
					payload.exact_quote,
					state.objective ?? "",
					(candidate.claims ?? []).map((item) => item.claimText),
					candidate.payloadDigest,
				);
				const semanticAssessment = combineAvoClaimEvidenceAssessments(
					lexicalAssessment,
					independentAssessment.verdict,
				);
				const objectiveDigest = createHash("sha256")
					.update(state.objective ?? "")
					.digest("hex");
				const objectiveAddressed = independentAssessment.verdict.objectiveRelation === "addresses";
				const argumentDigest = createHash("sha256").update(JSON.stringify(call.arguments)).digest("hex");
				const resultDigest = createHash("sha256")
					.update(JSON.stringify({ content: result.content, details: result.details, isError: result.isError }))
					.digest("hex");
				const receiptDigest = createHash("sha256")
					.update(
						JSON.stringify({
							toolCallId: call.id,
							toolName: call.name,
							argumentDigest,
							resultDigest,
							candidateId: candidate.candidateId,
							candidatePayloadDigest: candidate.payloadDigest,
							claimId: claim.claimId,
							claimText: claim.claimText,
							lexicalRelation: lexicalAssessment.relation,
							independentRelation: independentAssessment.verdict.relation,
							semanticRelation: semanticAssessment.relation,
							objectiveDigest,
							objectiveRelation: independentAssessment.verdict.objectiveRelation,
						}),
					)
					.digest("hex");
				const evaluation = runtime.recordHostEvaluation({
					candidateId: candidate.candidateId,
					evaluatorId: "external_claim",
					status:
						semanticAssessment.relation === "supports" && objectiveAddressed
							? "pass"
							: semanticAssessment.relation === "contradicts" ||
									independentAssessment.verdict.objectiveRelation === "unrelated"
								? "revise"
								: "inconclusive",
					authority: "external",
					evidenceRefs: [`host:tool:${receiptDigest}`, ...sourceIdentifiers.map((source) => `source:${source}`)],
					metrics: {
						meaningful: semanticAssessment.relation === "supports" && objectiveAddressed,
						tool_name: call.name,
						tool_call_id: call.id,
						claim_id: claim.claimId,
						claim_text_digest: createHash("sha256").update(claim.claimText).digest("hex"),
						semantic_relation: semanticAssessment.relation,
						semantic_reason: semanticAssessment.reason,
						semantic_verifier: "host_bound_exact_claim_independent_rlm_v3",
						lexical_relation: lexicalAssessment.relation,
						lexical_reason: lexicalAssessment.reason,
						independent_relation: independentAssessment.verdict.relation,
						independent_reason: independentAssessment.verdict.reason,
						objective_relation: independentAssessment.verdict.objectiveRelation,
						objective_reason: independentAssessment.verdict.objectiveReason,
						objective_verifier: "host_bound_claim_objective_independent_rlm_v3",
						objective_digest: objectiveDigest,
						independent_verifier_child_id: independentAssessment.verifierChildId ?? "unavailable",
						independent_verifier_model: independentAssessment.verifierModel ?? "unavailable",
						independent_response_digest: independentAssessment.responseDigest ?? "unavailable",
						independent_verifier_error: independentAssessment.error ?? "none",
						claim_token_coverage: semanticAssessment.claimTokenCoverage,
						argument_digest: argumentDigest,
						result_digest: resultDigest,
						exact_quote_digest: createHash("sha256").update(payload.exact_quote).digest("hex"),
						candidate_payload_digest: candidate.payloadDigest,
						source_count: sourceIdentifiers.length,
						tool_call_timestamp: callTimestamp,
						tool_result_timestamp: result.timestamp,
					},
				});
				return {
					evaluation,
					tool_receipt: {
						tool_call_id: call.id,
						tool_name: call.name,
						argument_digest: argumentDigest,
						result_digest: resultDigest,
						source_identifiers: sourceIdentifiers,
						receipt_digest: receiptDigest,
						claim_id: claim.claimId,
						semantic_relation: semanticAssessment.relation,
						semantic_reason: semanticAssessment.reason,
						lexical_relation: lexicalAssessment.relation,
						independent_relation: independentAssessment.verdict.relation,
						objective_relation: independentAssessment.verdict.objectiveRelation,
						verifier_child_id: independentAssessment.verifierChildId ?? null,
					},
				};
			}
			case "avo.cycle.complete": {
				const cycleInput = parseAvoCycleInput(payload.cycle);
				// Integrity is part of the same closed evidence set as cycle derivation.
				// Record drift before semantic preflight so stale work can never look
				// provisionally acceptable while the host is deciding whether to close it.
				this._recordAvoCandidateIntegrityFailure(cycleInput.candidateId);
				const preflightState = runtime.getState();
				const preflightCandidate = preflightState.candidates.find(
					(item) => item.candidateId === cycleInput.candidateId,
				);
				const requiresIndependentPythonSemantics =
					preflightState.verificationPolicy === "required" &&
					preflightCandidate !== undefined &&
					["patch", "implementation", "configuration", "artifact"].includes(preflightCandidate.kind) &&
					preflightCandidate.workspaceChangedPaths?.some((path) => path.endsWith(".py")) === true;
				const hasImmutableSemanticTest =
					preflightCandidate !== undefined &&
					preflightState.evaluations.some((receipt) =>
						isAvoImmutableSemanticTestReceipt(receipt, preflightCandidate, preflightState),
					);
				if (requiresIndependentPythonSemantics && !hasImmutableSemanticTest) {
					// A candidate may earn acceptance if the independent exact-spec verifier
					// succeeds. If it cannot, the adapter remains non-canonical and the cycle
					// must still close so a material successor is reachable.
					this._recordAvoSpecSemanticEvidence(cycleInput.candidateId);
				}
				this._recordAvoCandidateIntegrityFailure(cycleInput.candidateId);
				const result = runtime.completeCycle(cycleInput);
				const stateAfterCycle = runtime.getState();
				let memoryReflection: Record<string, unknown> | undefined;
				if (
					stateAfterCycle.routing.horizon === "long" &&
					result.cycle.outcome !== "accepted" &&
					stateAfterCycle.cycles.length % 5 === 0
				) {
					memoryReflection = await runtime.reflectMemory("five_cycles", result.cycle.cycleId);
				}
				if (!result.activateSupervisor) return { ...result, memoryReflection };
				let supervisor: { rlmChildId: string; name: string };
				try {
					supervisor = await this._ensureAvoSupervisor();
				} catch (error) {
					return {
						...result,
						memoryReflection,
						supervisor: null,
						delivery: { error: error instanceof Error ? error.message : String(error) },
					};
				}
				const delivery = await this._dispatchAvoCheckpoint(supervisor, result.cycle.cycleId);
				return { ...result, memoryReflection, supervisor, delivery };
			}
			case "avo.experiment.record":
				return { experiment: runtime.recordExperiment(parseAvoExperimentInput(payload.experiment)) };
			case "avo.trial.record": {
				const input = parseAvoTrialInput(payload.trial);
				const sourceEvaluation = runtime
					.getState()
					.evaluations.find((evaluation) => evaluation.evaluationId === input.evaluationId);
				if (!sourceEvaluation) throw new Error(`trial source evaluation ${input.evaluationId} does not exist`);
				return this._bindAvoExperimentTrial(runtime, input, sourceEvaluation);
			}
			case "avo.trial.run": {
				const input = parseAvoTrialRunInput(payload.trial);
				const contract = runtime.store.prepareTrialExecution(
					input.experimentId,
					input.candidateId,
					input.conditionId,
					input.seed,
				);
				const run = await this.handleAvoHostRequest("avo.evaluation.run", {
					candidate_id: input.candidateId,
					command: contract.command,
				});
				const evaluationId =
					typeof run.evaluation === "object" &&
					run.evaluation !== null &&
					"evaluationId" in run.evaluation &&
					typeof run.evaluation.evaluationId === "string"
						? run.evaluation.evaluationId
						: undefined;
				const output =
					typeof run.execution === "object" &&
					run.execution !== null &&
					"output" in run.execution &&
					typeof run.execution.output === "string"
						? run.execution.output
						: "";
				const sourceEvaluation = runtime
					.getState()
					.evaluations.find((evaluation) => evaluation.evaluationId === evaluationId);
				if (!sourceEvaluation) throw new Error("trial execution did not produce a host evaluation");
				return {
					...this._bindAvoExperimentTrial(
						runtime,
						{ ...input, evaluationId: sourceEvaluation.evaluationId },
						sourceEvaluation,
						output,
					),
					execution: run.execution,
				};
			}
			case "avo.experiment.complete": {
				if (typeof payload.experiment_id !== "string") {
					throw new Error("avo.experiment.complete experiment_id must be a string");
				}
				const result = runtime.completeExperiment(payload.experiment_id);
				return { ...result, nooa: await runtime.syncMemory() };
			}
			case "avo.results.collect":
				return await this._collectAvoSupervisorResults();
			case "avo.memory.remember": {
				const memory = runtime.store.remember(parseAvoMemoryInput(payload.memory));
				return { memory, nooa: await runtime.syncMemory() };
			}
			case "avo.memory.sync":
				return await runtime.syncMemory();
			case "avo.memory.recall": {
				if (typeof payload.query !== "string") throw new Error("avo.memory.recall query must be a string");
				if (payload.limit !== undefined && typeof payload.limit !== "number")
					throw new Error("avo.memory.recall limit must be a number");
				return await runtime.recallMemory(payload.query, { limit: payload.limit ?? 8 });
			}
			case "avo.memory.spontaneous": {
				if (typeof payload.query !== "string") throw new Error("avo.memory.spontaneous query must be a string");
				if (payload.limit !== undefined && typeof payload.limit !== "number") {
					throw new Error("avo.memory.spontaneous limit must be a number");
				}
				if (payload.max_chars !== undefined && typeof payload.max_chars !== "number") {
					throw new Error("avo.memory.spontaneous max_chars must be a number");
				}
				return await runtime.recallMemory(payload.query, {
					limit: payload.limit ?? 5,
					maxChars: payload.max_chars ?? 2_000,
					spontaneous: true,
				});
			}
			case "avo.memory.reflect": {
				const trigger = payload.trigger;
				if (
					trigger !== "five_cycles" &&
					trigger !== "supervisor_intervention" &&
					trigger !== "candidate_acceptance" &&
					trigger !== "post_task" &&
					trigger !== "manual"
				) {
					throw new Error("invalid AVO memory reflection trigger");
				}
				return await runtime.reflectMemory(
					trigger,
					typeof payload.cycle_id === "string" ? payload.cycle_id : undefined,
				);
			}
			case "avo.memory.reflection.record": {
				const trigger = payload.trigger;
				if (
					trigger !== "five_cycles" &&
					trigger !== "supervisor_intervention" &&
					trigger !== "candidate_acceptance" &&
					trigger !== "post_task" &&
					trigger !== "manual"
				) {
					throw new Error("invalid AVO memory reflection trigger");
				}
				if (!isObjectRecord(payload.report)) throw new Error("AVO memory reflection report must be an object");
				const report: Record<string, number | string | boolean> = {};
				for (const [key, value] of Object.entries(payload.report)) {
					if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
						throw new Error(`AVO memory reflection report.${key} must be scalar`);
					}
					report[key] = value;
				}
				if (
					!Array.isArray(payload.archived_memory_ids) ||
					!payload.archived_memory_ids.every((item) => typeof item === "string")
				) {
					throw new Error("AVO archived_memory_ids must be an array of strings");
				}
				return {
					reflection: runtime.store.recordMemoryReflection({
						trigger,
						cycleId: typeof payload.cycle_id === "string" ? payload.cycle_id : undefined,
						report,
						archivedMemoryIds: payload.archived_memory_ids,
					}),
				};
			}
			case "avo.checkpoint":
				return { checkpoint: runtime.getState().checkpoints.at(-1) ?? null };
			case "avo.stop_gate":
				return await this._withAvoCanonicalDeliverySerialization(async () => {
					await this._collectAvoSupervisorResults();
					if (this._disposed || this._disposing || !this._avoRuntime) {
						throw new Error("AVO session was disposed");
					}
					const stopGate = this._evaluateAvoStopGateWithCanonicalRepair();
					await this._queueAvoCanonicalDeliveryAfterPassingGateLocked(stopGate);
					return { stop_gate: stopGate };
				});
			case "avo.complete": {
				return await this._withAvoCanonicalDeliverySerialization(async () => {
					await this._collectAvoSupervisorResults();
					if (this._disposed || this._disposing || !this._avoRuntime) {
						throw new Error("AVO session was disposed");
					}
					const stopGate = this._evaluateAvoStopGateWithCanonicalRepair();
					await this._queueAvoCanonicalDeliveryAfterPassingGateLocked(stopGate);
					return {
						state: runtime.getState(),
						stop_gate: stopGate,
						completion_deferred_to_host_delivery: true,
					};
				});
			}
			case "avo.variation.run": {
				if (!payload.contract || typeof payload.contract !== "object") {
					throw new Error("avo.variation.run requires a contract object");
				}
				const contract = payload.contract as unknown as AvoVariationContract;
				const result = await runtime.runVariationEpisode(contract, async (agent) => {
					if (Array.isArray(payload.actions)) {
						for (const action of payload.actions as Array<{ type: string; [k: string]: unknown }>) {
							if (action.type === "sample_knowledge" && typeof action.knowledgeId === "string") {
								agent.sampleKnowledge(action.knowledgeId, action.reason as string | undefined);
							} else if (action.type === "sample_lineage" && typeof action.solutionId === "string") {
								agent.sampleLineage(action.solutionId, action.reason as string | undefined);
							} else if (action.type === "edit" && typeof action.candidateRef === "string") {
								agent.recordEdit(action.candidateRef, (action.content as string) ?? "");
							} else if (action.type === "evaluate" && typeof action.candidateRef === "string") {
								await agent.evaluateCandidate(action.candidateRef, (action.content as string) ?? "");
							} else if (action.type === "diagnose" && typeof action.diagnostics === "string") {
								agent.recordDiagnosis(action.diagnostics);
							} else if (action.type === "repair" && typeof action.candidateRef === "string") {
								agent.recordRepair(action.candidateRef, (action.content as string) ?? "");
							}
						}
					}
				});
				return { result: result as unknown as Record<string, unknown> };
			}
			case "avo.lineage.list": {
				return { entries: runtime.listLineage() };
			}
			case "avo.lineage.sample": {
				if (typeof payload.solutionId !== "string") {
					throw new Error("avo.lineage.sample requires solutionId string");
				}
				const reason = typeof payload.reason === "string" ? payload.reason : undefined;
				const solution = runtime.sampleLineage(payload.solutionId, reason);
				return { solution, trace: { sourceType: "lineage", sourceId: payload.solutionId, reason } };
			}
			case "avo.knowledge.list": {
				return { entries: runtime.listKnowledge() };
			}
			case "avo.knowledge.sample": {
				if (typeof payload.knowledgeId !== "string") {
					throw new Error("avo.knowledge.sample requires knowledgeId string");
				}
				const reason = typeof payload.reason === "string" ? payload.reason : undefined;
				const knowledge = runtime.sampleKnowledge(payload.knowledgeId, reason);
				return { knowledge, trace: { sourceType: "knowledge", sourceId: payload.knowledgeId, reason } };
			}
			default:
				throw new Error(`unknown AVO request type "${type}"`);
		}
	}

	private _requireAutoresearchStore(): AutoresearchStore {
		if (!this._autoresearchStore || this._rlmDepth !== 0) {
			throw new Error("autoresearch is only available in a root agent session");
		}
		if (!this._agentMessageController) {
			throw new Error("autoresearch requires retained-child messaging");
		}
		return this._autoresearchStore;
	}

	private async _ensureAutoresearchSupervisor(
		options: { forceRebind?: boolean } = {},
	): Promise<{ rlmChildId: string; name: string }> {
		const store = this._requireAutoresearchStore();
		const state = store.getState();
		if (!state.objective) throw new Error("initialize autoresearch before starting its supervisor");
		const children = (await this.listRlmSubagents()).subagents;
		const configured = state.supervisor;
		if (configured && this._autoresearchSupervisorBoundToRuntime && !options.forceRebind) {
			const retained = children.find(
				(child) => child.rlm_child_id === configured.rlmChildId || child.session_name === configured.name,
			);
			if (retained && retained.status !== "error") {
				if (retained.rlm_child_id !== configured.rlmChildId || retained.session_name !== configured.name) {
					store.setSupervisor({ rlmChildId: retained.rlm_child_id, name: retained.session_name });
				}
				this._autoresearchSupervisorBoundToRuntime = true;
				return { rlmChildId: retained.rlm_child_id, name: retained.session_name };
			}
		}

		const stableSuffix = this.sessionId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || randomUUID().slice(0, 8);
		const preferredName = `autoresearch-supervisor-${stableSuffix}`;
		const name = children.some((child) => child.session_name === preferredName)
			? `${preferredName}-${randomUUID().slice(0, 8)}`
			: preferredName;
		const handle = await this.runRlmChild(buildAutoresearchSupervisorBootstrapPrompt(), { name });
		store.setSupervisor({ rlmChildId: handle.rlm_child_id, name: handle.name });
		this._autoresearchSupervisorBoundToRuntime = true;
		return { rlmChildId: handle.rlm_child_id, name: handle.name };
	}

	private async _dispatchAutoresearchCheckpoint(
		supervisor: { rlmChildId: string; name: string },
		cycleId: string,
		packet: Record<string, unknown>,
		timeoutMs: number,
	): Promise<{ receipt?: AgentSessionMessageReceipt; error?: string }> {
		const deadline = Date.now() + timeoutMs;
		const waitWithinDeadline = <T>(promise: Promise<T>, operation: string): Promise<T> => {
			const remainingMs = Math.max(1, deadline - Date.now());
			return waitForPromiseOrAbort(
				promise,
				AbortSignal.timeout(remainingMs),
				`autoresearch supervisor timed out ${operation} for ${cycleId}`,
			);
		};
		try {
			await waitWithinDeadline(
				this._awaitPendingRlmChildSettlement(supervisor.name),
				"waiting for bootstrap settlement",
			);
			const state = this._requireAutoresearchStore().getState();
			if (!state.objective) throw new Error("autoresearch supervisor objective is missing");
			const instructions = buildAutoresearchSupervisorPrompt(state.objective, state.topic);
			const envelope = `[autoresearch supervisor instructions]\n\n${instructions}\n\n[autoresearch checkpoint ${cycleId}]\n\n`;
			const maxSerializedLength = 15_000 - envelope.length;
			if (maxSerializedLength < 1_000) {
				throw new Error("autoresearch supervisor instructions leave insufficient room for a checkpoint");
			}
			const original = JSON.stringify(packet);
			const compactValue = (value: unknown, maxString: number, maxArray: number, depth = 0): unknown => {
				if (typeof value === "string") {
					return value.length <= maxString ? value : `${value.slice(0, maxString - 1)}…`;
				}
				if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
				if (depth >= 8) return "[depth truncated]";
				if (Array.isArray(value)) {
					return value.slice(0, maxArray).map((item) => compactValue(item, maxString, maxArray, depth + 1));
				}
				if (isObjectRecord(value)) {
					return Object.fromEntries(
						Object.entries(value).map(([key, item]) => [key, compactValue(item, maxString, maxArray, depth + 1)]),
					);
				}
				return String(value);
			};
			let deliveredPacket: Record<string, unknown> = packet;
			if (original.length > maxSerializedLength) {
				deliveredPacket = {
					...(compactValue(packet, 600, 12) as Record<string, unknown>),
					packet_truncated: true,
					packet_original_chars: original.length,
				};
			}
			let serialized = JSON.stringify(deliveredPacket);
			if (serialized.length > maxSerializedLength) {
				deliveredPacket = {
					...(compactValue(packet, 300, 6) as Record<string, unknown>),
					packet_truncated: true,
					packet_original_chars: original.length,
				};
				serialized = JSON.stringify(deliveredPacket);
			}
			if (serialized.length > maxSerializedLength) {
				throw new Error(
					`autoresearch supervisor packet could not be bounded below ${maxSerializedLength} characters`,
				);
			}
			const receipt = await waitWithinDeadline(
				this._agentMessageController!.sendAgentMessage({
					target: assertDirectAgentMessageTarget(supervisor.name),
					message: normalizeAgentSessionMessage(`${envelope}${serialized}`),
				}),
				"delivering checkpoint",
			);
			return { receipt };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async _verifyAutoresearchPublication(
		publication: AutoresearchPublication,
	): Promise<AutoresearchPublicationVerification> {
		const verifiedAt = new Date().toISOString();
		if (publication.doi) {
			const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(publication.doi)}`, {
				headers: { Accept: "application/json", "User-Agent": "Prime-Agent-Autoresearch/0.2" },
				signal: AbortSignal.timeout(30_000),
			});
			if (!response.ok) throw new Error(`Crossref verification failed with HTTP ${response.status}`);
			const body = await response.text();
			const payload = JSON.parse(body) as unknown;
			if (!isObjectRecord(payload) || !isObjectRecord(payload.message)) {
				throw new Error("Crossref verification response omitted message metadata");
			}
			const message = payload.message;
			const doi = typeof message.DOI === "string" ? message.DOI : publication.doi;
			if (doi.toLowerCase() !== publication.doi.toLowerCase()) {
				throw new Error("Crossref verification returned a different DOI");
			}
			const rawTitles = message.title;
			const title = Array.isArray(rawTitles) && typeof rawTitles[0] === "string" ? rawTitles[0] : publication.title;
			const authors = Array.isArray(message.author)
				? message.author
						.filter(isObjectRecord)
						.map((author) =>
							[author.given, author.family]
								.filter((part): part is string => typeof part === "string" && part.trim().length > 0)
								.join(" "),
						)
						.filter((author) => author.length > 0)
				: [];
			const containers = message["container-title"];
			const venue =
				Array.isArray(containers) && typeof containers[0] === "string" ? containers[0] : publication.venue;
			let year = publication.year;
			for (const key of ["published-print", "published-online", "published", "issued"] as const) {
				const date = message[key];
				if (!isObjectRecord(date) || !Array.isArray(date["date-parts"])) continue;
				const parts = date["date-parts"][0];
				if (Array.isArray(parts) && typeof parts[0] === "number") {
					year = parts[0];
					break;
				}
			}
			const registeredType = typeof message.type === "string" ? message.type : "";
			const publishedTypes = new Set(["journal-article", "proceedings-article"]);
			const publicationStatus =
				publishedTypes.has(registeredType) && venue ? "published" : "published_status_unclear";
			const resolvedMetadata: AutoresearchPublicationVerification["resolvedMetadata"] = {
				title,
				authors: authors.length > 0 ? authors : publication.authors,
				doi,
				fullTextUrl: publication.fullTextUrl ?? `https://doi.org/${encodeURIComponent(doi)}`,
			};
			if (year !== undefined) resolvedMetadata.year = year;
			if (venue) resolvedMetadata.venue = venue;
			return {
				verificationId: `publication-verification-${randomUUID()}`,
				paperId: publication.paperId,
				source: "crossref",
				publicationStatus,
				verifiedAt,
				metadataDigest: createHash("sha256").update(body).digest("hex"),
				resolvedMetadata,
			};
		}
		if (publication.preprintId) {
			const response = await fetch(
				`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(publication.preprintId)}`,
				{
					headers: { Accept: "application/atom+xml", "User-Agent": "Prime-Agent-Autoresearch/0.2" },
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!response.ok) throw new Error(`arXiv verification failed with HTTP ${response.status}`);
			const body = await response.text();
			if (!/<entry[>\s]/i.test(body)) throw new Error("arXiv verification returned no matching entry");
			const title = body
				.match(/<title>([\s\S]*?)<\/title>/gi)
				?.at(-1)
				?.replace(/<\/?title>/gi, "")
				.trim();
			const authors = [...body.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
				.map((match) => match[1]?.replace(/\s+/g, " ").trim())
				.filter((author): author is string => !!author);
			const published = body.match(/<published>(\d{4})-/i)?.[1];
			const resolvedMetadata: AutoresearchPublicationVerification["resolvedMetadata"] = {
				title: title?.replace(/\s+/g, " ") || publication.title,
				authors: authors.length > 0 ? authors : publication.authors,
				preprintId: publication.preprintId,
				fullTextUrl: publication.fullTextUrl ?? `https://arxiv.org/pdf/${publication.preprintId}`,
			};
			if (published) resolvedMetadata.year = Number.parseInt(published, 10);
			return {
				verificationId: `publication-verification-${randomUUID()}`,
				paperId: publication.paperId,
				source: "arxiv",
				publicationStatus: "preprint",
				verifiedAt,
				metadataDigest: createHash("sha256").update(body).digest("hex"),
				resolvedMetadata,
			};
		}
		throw new Error("host publication verification requires a DOI or arXiv preprint_id");
	}

	private async _readBoundedAutoresearchEvidence(
		response: UndiciResponse,
		maxBytes = 2 * 1024 * 1024,
	): Promise<string> {
		const reader = response.body?.getReader();
		if (!reader) return "";
		const chunks: Uint8Array[] = [];
		let size = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error(`peer-review evidence exceeds ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
		return Buffer.concat(chunks).toString("utf8");
	}

	private async _resolvePublicAutoresearchUrl(url: URL, label: string): Promise<{ address: string; family: number }> {
		if (url.protocol !== "https:" || url.username || url.password) {
			throw new Error(`${label} must be credential-free HTTPS`);
		}
		const addresses = await lookup(url.hostname, { all: true, verbatim: true });
		if (addresses.length === 0 || addresses.some((item) => !isPublicAutoresearchAddress(item.address))) {
			throw new Error(`${label} must resolve only to public Internet addresses`);
		}
		return addresses[0]!;
	}

	private async _fetchPublicAutoresearchUrl(
		initialUrl: string,
		init: UndiciRequestInit,
		label: string,
	): Promise<{ response: UndiciResponse; url: URL; dispatcher: UndiciAgent }> {
		let url = new URL(initialUrl);
		for (let redirects = 0; redirects <= 5; redirects++) {
			const pinnedAddress = await this._resolvePublicAutoresearchUrl(url, label);
			const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
				if (options.all) {
					callback(null, [pinnedAddress]);
					return;
				}
				callback(null, pinnedAddress.address, pinnedAddress.family);
			};
			const dispatcher = new UndiciAgent({ connect: { lookup: pinnedLookup } });
			let response: UndiciResponse;
			try {
				response = await undiciFetch(url, { ...init, redirect: "manual", dispatcher });
			} catch (error) {
				await dispatcher.close();
				throw error;
			}
			if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url, dispatcher };
			const location = response.headers.get("location");
			try {
				await response.body?.cancel();
			} finally {
				await dispatcher.close();
			}
			if (!location) throw new Error(`${label} redirect omitted its location`);
			url = new URL(location, url);
		}
		throw new Error(`${label} exceeded five redirects`);
	}

	private async _fetchAvoExternalSource(initialUrl: string): Promise<{
		url: string;
		text: string;
		bodyDigest: string;
		contentType: string;
		truncated: boolean;
	}> {
		let parsed: URL;
		try {
			parsed = new URL(initialUrl);
		} catch {
			throw new Error("AVO external source URL is invalid");
		}
		const fetched = await this._fetchPublicAutoresearchUrl(
			parsed.toString(),
			{
				headers: {
					Accept: "text/html, text/plain, application/json;q=0.9",
					"User-Agent": "Prime-Agent-AVO/0.3",
				},
				signal: AbortSignal.timeout(30_000),
			},
			"AVO external source",
		);
		try {
			if (!fetched.response.ok) {
				throw new Error(`AVO external source fetch failed with HTTP ${fetched.response.status}`);
			}
			const contentType = fetched.response.headers.get("content-type")?.toLowerCase() ?? "";
			if (
				contentType &&
				!contentType.includes("text/html") &&
				!contentType.includes("text/plain") &&
				!contentType.includes("application/json") &&
				!contentType.includes("application/xhtml+xml")
			) {
				throw new Error(`AVO external source content type is not textual: ${contentType}`);
			}
			const body = await this._readBoundedAutoresearchEvidence(fetched.response);
			const extracted =
				contentType.includes("html") || /^\s*</.test(body)
					? visibleAutoresearchEvidenceText(body, false)
					: body.replace(/\r\n?/g, "\n").trim();
			if (!extracted) throw new Error("AVO external source contained no visible textual evidence");
			const maxCharacters = 120_000;
			return {
				url: fetched.url.toString(),
				text: extracted.slice(0, maxCharacters),
				bodyDigest: createHash("sha256").update(body).digest("hex"),
				contentType,
				truncated: extracted.length > maxCharacters,
			};
		} finally {
			await fetched.response.body?.cancel().catch(() => undefined);
			await fetched.dispatcher.close();
		}
	}

	private _sameAutoresearchDocument(left: URL, right: URL): boolean {
		const path = (url: URL): string => url.pathname.replace(/\/+$/, "") || "/";
		return left.origin.toLowerCase() === right.origin.toLowerCase() && path(left) === path(right);
	}

	private async _verifyAutoresearchPeerReview(
		publication: AutoresearchPublication,
		input: ReturnType<typeof parseAutoresearchPeerReviewEvidenceInput>,
	): Promise<AutoresearchPeerReviewVerification> {
		if (!publication.doi) throw new Error("peer-review verification requires a DOI");
		if (publication.publicationStatus !== "published") {
			throw new Error("peer-review verification requires Crossref-verified published metadata");
		}
		const doiResult = await this._fetchPublicAutoresearchUrl(
			`https://doi.org/${encodeURIComponent(publication.doi)}`,
			{
				headers: { Accept: "text/html", "User-Agent": "Prime-Agent-Autoresearch/0.2" },
				signal: AbortSignal.timeout(30_000),
			},
			"DOI publisher resolution",
		);
		const doiResponse = doiResult.response;
		const publisherUrl = doiResult.url;
		const publisherHost = publisherUrl.hostname.toLowerCase();
		try {
			if (!doiResponse.ok) throw new Error(`DOI publisher resolution failed with HTTP ${doiResponse.status}`);
		} finally {
			await doiResponse.body?.cancel().catch(() => undefined);
			await doiResult.dispatcher.close();
		}
		const requestedHost = new URL(input.evidenceUrl).hostname.toLowerCase();
		if (requestedHost !== publisherHost) {
			throw new Error(`peer-review evidence must use the DOI publisher host ${publisherHost}`);
		}
		const evidenceResult = await this._fetchPublicAutoresearchUrl(
			input.evidenceUrl,
			{
				headers: { Accept: "text/html,text/plain", "User-Agent": "Prime-Agent-Autoresearch/0.2" },
				signal: AbortSignal.timeout(30_000),
			},
			"publisher peer-review evidence",
		);
		const { response } = evidenceResult;
		let body: string;
		try {
			if (!response.ok) throw new Error(`publisher peer-review evidence failed with HTTP ${response.status}`);
			if (evidenceResult.url.hostname.toLowerCase() !== publisherHost) {
				throw new Error("peer-review evidence redirected away from the DOI publisher host");
			}
			if (!this._sameAutoresearchDocument(evidenceResult.url, publisherUrl)) {
				throw new Error("peer-review evidence must appear on the DOI item's own publisher page");
			}
			body = await this._readBoundedAutoresearchEvidence(response);
		} finally {
			await response.body?.cancel().catch(() => undefined);
			await evidenceResult.dispatcher.close();
		}
		if (!hasApplicablePeerReviewEvidence(body, input.exactQuote)) {
			throw new Error("publisher page does not contain applicable visible peer-review evidence for this item");
		}
		return {
			verificationId: `peer-review-verification-${randomUUID()}`,
			paperId: publication.paperId,
			source: "publisher",
			evidenceUrl: evidenceResult.url.toString(),
			exactQuote: input.exactQuote,
			verifiedAt: new Date().toISOString(),
			evidenceDigest: createHash("sha256").update(body).digest("hex"),
		};
	}

	private async _spawnAutoresearchReviewers(
		candidate: ReturnType<typeof parseAutoresearchCandidateInput>,
	): Promise<ReturnType<AutoresearchStore["getReviewerAssignments"]>> {
		const store = this._requireAutoresearchStore();
		const existing = new Map(store.getReviewerAssignments(candidate.candidateId).map((item) => [item.role, item]));
		const children = (await this.listRlmSubagents()).subagents;
		const reviewedRoles = new Set(store.getCollectedReviews(candidate.candidateId).map((review) => review.role));
		const prompts = buildAutoresearchReviewerPrompts(candidate, store.getState());
		const roles = Object.keys(prompts) as AutoresearchReviewerRole[];
		const slug = candidate.candidateId.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 20) || "candidate";
		for (const role of roles) {
			const assignment = existing.get(role);
			const assignedChild = assignment
				? children.find(
						(child) => child.rlm_child_id === assignment.rlmChildId || child.session_name === assignment.name,
					)
				: undefined;
			if (reviewedRoles.has(role) || assignedChild?.status === "running") continue;
			const kwargs: Record<string, unknown> = {
				name: `research-${role.replaceAll("_", "-")}-${slug}-${randomUUID().slice(0, 8)}`,
			};
			const handle = await this.runRlmChild(prompts[role], kwargs);
			const replacement = store.registerReviewerAssignment(candidate, role, {
				rlmChildId: handle.rlm_child_id,
				name: handle.name,
			});
			existing.set(role, replacement);
		}
		return store.getReviewerAssignments(candidate.candidateId);
	}

	private _readAutoresearchTerminal(subagent: RlmSubagentRegistryEntry, marker: string): string | undefined {
		const liveSession =
			this._activeRlmChildRuns.get(subagent.rlm_child_id)?.session ??
			this._rlmChildSessions.get(subagent.rlm_child_id);
		if (liveSession) {
			for (const message of [...liveSession.messages].reverse()) {
				if (message.role === "toolResult" && message.toolName === "ipython" && !message.isError) {
					const persisted = extractMarkedPersistedAgentMessage(message.details, marker);
					if (persisted) return persisted;
				}
			}
		}

		try {
			const descriptorPath = join(subagent.session_dir, "rlm-subagent.json");
			const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8")) as unknown;
			if (!isObjectRecord(descriptor)) return undefined;
			if (descriptor.childId !== subagent.rlm_child_id || descriptor.sessionName !== subagent.session_name) {
				return undefined;
			}
			if (typeof descriptor.sessionFile !== "string") return undefined;
			const sessionDir = resolve(subagent.session_dir);
			const sessionFile = resolve(descriptor.sessionFile);
			if (dirname(sessionFile) !== sessionDir || !existsSync(sessionFile)) return undefined;
			const sessionManager = SessionManager.open(sessionFile);
			const branch = [...sessionManager.getBranch()].reverse();
			for (const entry of branch) {
				if (entry.type !== "message") continue;
				if (entry.message.role === "toolResult" && entry.message.toolName === "ipython" && !entry.message.isError) {
					const persisted = extractMarkedPersistedAgentMessage(entry.message.details, marker);
					if (persisted) return persisted;
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private _persistedAutoresearchSubagent(
		rlmChildId: string,
		sessionName: string,
	): RlmSubagentRegistryEntry | undefined {
		const artifactDir = this.sessionManager.getSessionArtifactDir();
		if (!artifactDir) return undefined;
		const resolvedArtifactDir = resolve(artifactDir);
		const sessionDir = resolve(resolvedArtifactDir, rlmChildId);
		if (dirname(sessionDir) !== resolvedArtifactDir || !existsSync(join(sessionDir, "rlm-subagent.json"))) {
			return undefined;
		}
		return {
			rlm_child_id: rlmChildId,
			active_session_id: null,
			session_id: null,
			session_name: sessionName,
			session_dir: sessionDir,
			status: "completed",
		};
	}

	private async _collectAutoresearchAgentResults(): Promise<{
		ingested: number;
		reviews: ReturnType<AutoresearchStore["getState"]>["collectedReviews"];
		supervision: ReturnType<AutoresearchStore["getState"]>["supervision"];
		errors: Array<{ messageId: string; error: string }>;
	}> {
		const store = this._requireAutoresearchStore();
		let ingested = 0;
		const errors: Array<{ messageId: string; error: string }> = [];
		const messages = [...this.messages];
		for (const action of this._actionStore.unfinishedActions()) {
			if (action.payload.kind === "turn" && action.payload.customMessage) {
				messages.push(action.payload.customMessage);
			}
		}
		for (const message of messages) {
			if (!isAgentSessionMessage(message) || !message.details.message.includes("AUTORESEARCH_")) continue;
			try {
				if (store.ingestAgentMessage(message.details.id, message.details.message, message.details.from)) ingested++;
			} catch (error) {
				errors.push({
					messageId: message.details.id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const stateBeforeTerminalCollection = store.getState();
		const reviewedRoles = new Set(
			stateBeforeTerminalCollection.collectedReviews.map((item) => `${item.candidateId}:${item.reviewer.role}`),
		);
		const subagents = (await this.listRlmSubagents()).subagents;
		for (const assignment of stateBeforeTerminalCollection.reviewerAssignments) {
			if (reviewedRoles.has(`${assignment.candidateId}:${assignment.role}`)) continue;
			const child =
				subagents.find(
					(item) => item.rlm_child_id === assignment.rlmChildId || item.session_name === assignment.name,
				) ?? this._persistedAutoresearchSubagent(assignment.rlmChildId, assignment.name);
			if (child?.status !== "completed" && child?.status !== "error") continue;
			const text = this._readAutoresearchTerminal(child, "AUTORESEARCH_REVIEW_JSON:");
			if (!text) continue;
			const messageId = `autoresearch-terminal:${assignment.assignmentId}`;
			try {
				if (store.ingestAgentMessage(messageId, text, { sessionName: assignment.name })) ingested++;
			} catch (error) {
				errors.push({
					messageId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const stateBeforeSupervisorTerminalCollection = store.getState();
		const configuredSupervisor = stateBeforeSupervisorTerminalCollection.supervisor;
		if (configuredSupervisor) {
			const child =
				subagents.find(
					(item) =>
						item.rlm_child_id === configuredSupervisor.rlmChildId ||
						item.session_name === configuredSupervisor.name,
				) ?? this._persistedAutoresearchSubagent(configuredSupervisor.rlmChildId, configuredSupervisor.name);
			if (child?.status === "completed" || child?.status === "error") {
				const text = this._readAutoresearchTerminal(child, "AUTORESEARCH_SUPERVISION_JSON:");
				if (text) {
					const digest = createHash("sha256").update(text).digest("hex");
					const messageId = `autoresearch-supervisor-terminal:${child.rlm_child_id}:${digest}`;
					try {
						if (store.ingestAgentMessage(messageId, text, { sessionName: configuredSupervisor.name })) ingested++;
					} catch (error) {
						errors.push({
							messageId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
		}
		const state = store.getState();
		return {
			ingested,
			reviews: state.collectedReviews,
			supervision: state.supervision,
			errors,
		};
	}

	async handleAutoresearchHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		if (this._requireAvoRuntime().getState().routing.environment !== "research") {
			throw new Error("autoresearch is only available when the host routed the active task to research");
		}
		const store = this._requireAutoresearchStore();
		switch (type) {
			case "autoresearch.initialize": {
				if (typeof payload.objective !== "string") {
					throw new Error("autoresearch.initialize objective must be a string");
				}
				if (payload.topic !== undefined && typeof payload.topic !== "string") {
					throw new Error("autoresearch.initialize topic must be a string when provided");
				}
				store.initialize(payload.objective, payload.topic);
				const supervisor = await this._ensureAutoresearchSupervisor();
				this._syncAvoResearchState();
				return { state: store.getState(), supervisor };
			}
			case "autoresearch.get":
				return { state: store.getState() };
			case "autoresearch.publication.add": {
				const publication = store.addPublication(parseAutoresearchPublicationInput(payload.publication));
				return { publication };
			}
			case "autoresearch.publication.verify": {
				if (typeof payload.paper_id !== "string") {
					throw new Error("autoresearch.publication.verify paper_id must be a string");
				}
				const publication = store.getState().publications.find((item) => item.paperId === payload.paper_id);
				if (!publication) throw new Error(`publication ${payload.paper_id} was not found`);
				const verification = store.recordPublicationVerification(
					await this._verifyAutoresearchPublication(publication),
				);
				return {
					publication: store.getState().publications.find((item) => item.paperId === publication.paperId),
					verification,
				};
			}
			case "autoresearch.publication.peer_review.verify": {
				const input = parseAutoresearchPeerReviewEvidenceInput(payload.evidence);
				const publication = store.getState().publications.find((item) => item.paperId === input.paperId);
				if (!publication) throw new Error(`publication ${input.paperId} was not found`);
				const verification = store.recordPeerReviewVerification(
					await this._verifyAutoresearchPeerReview(publication, input),
				);
				return {
					publication: store.getState().publications.find((item) => item.paperId === publication.paperId),
					verification,
				};
			}
			case "autoresearch.search.record": {
				const candidate = parseAutoresearchCandidateInput(payload.candidate);
				const receipt = store.recordSearchReceipt(parseAutoresearchSearchReceiptInput(candidate, payload.receipt));
				return { receipt };
			}
			case "autoresearch.experiment.record": {
				const experiment = store.recordExperiment(parseAutoresearchExperimentInput(payload.experiment));
				return { experiment };
			}
			case "autoresearch.memory.remember": {
				const memory = store.remember(parseAutoresearchMemoryInput(payload.memory));
				return { memory };
			}
			case "autoresearch.memory.recall": {
				if (typeof payload.query !== "string") {
					throw new Error("autoresearch.memory.recall query must be a string");
				}
				if (payload.limit !== undefined && typeof payload.limit !== "number") {
					throw new Error("autoresearch.memory.recall limit must be a number when provided");
				}
				return { memories: store.recallMemories(payload.query, payload.limit ?? 8) };
			}
			case "autoresearch.memory.reuse.prepare": {
				const reuse = store.createMemoryReusePlan(parseAutoresearchMemoryReuseInput(payload.reuse));
				return { reuse };
			}
			case "autoresearch.memory.reuse.verify": {
				if (typeof payload.reuse_id !== "string") {
					throw new Error("autoresearch.memory.reuse.verify reuse_id must be a string");
				}
				if (typeof payload.accepted !== "boolean") {
					throw new Error("autoresearch.memory.reuse.verify accepted must be a boolean");
				}
				if (!Array.isArray(payload.evidence) || !payload.evidence.every((item) => typeof item === "string")) {
					throw new Error("autoresearch.memory.reuse.verify evidence must be an array of strings");
				}
				return {
					reuse: store.verifyMemoryReuse(payload.reuse_id, payload.accepted, payload.evidence),
				};
			}
			case "autoresearch.memory.reflection.record": {
				if (typeof payload.trigger !== "string") {
					throw new Error("autoresearch.memory.reflection.record trigger must be a string");
				}
				if (!isObjectRecord(payload.report)) {
					throw new Error("autoresearch.memory.reflection.record report must be an object");
				}
				const report: Record<string, number | string | boolean> = {};
				for (const [key, value] of Object.entries(payload.report)) {
					if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
						throw new Error(`autoresearch.memory.reflection.record report.${key} must be scalar`);
					}
					report[key] = value;
				}
				if (
					!Array.isArray(payload.archived_memory_ids) ||
					!payload.archived_memory_ids.every((item) => typeof item === "string")
				) {
					throw new Error("autoresearch.memory.reflection.record archived_memory_ids must be strings");
				}
				const trigger = payload.trigger;
				if (
					!(["five_cycles", "supervisor_intervention", "candidate_promotion", "manual"] as const).includes(
						trigger as "five_cycles" | "supervisor_intervention" | "candidate_promotion" | "manual",
					)
				) {
					throw new Error("autoresearch.memory.reflection.record trigger is invalid");
				}
				return {
					reflection: store.recordMemoryReflection({
						trigger: trigger as "five_cycles" | "supervisor_intervention" | "candidate_promotion" | "manual",
						cycleId: typeof payload.cycle_id === "string" ? payload.cycle_id : undefined,
						report,
						archivedMemoryIds: payload.archived_memory_ids,
					}),
				};
			}
			case "autoresearch.claim.add": {
				const claim = store.addClaim(parseAutoresearchClaimInput(payload.claim));
				return { claim };
			}
			case "autoresearch.claim.update": {
				if (typeof payload.claim_id !== "string") {
					throw new Error("autoresearch.claim.update claim_id must be a string");
				}
				return {
					claim: store.updateClaim(payload.claim_id, parseAutoresearchClaimUpdateInput(payload.update)),
				};
			}
			case "autoresearch.claim.promote": {
				if (typeof payload.claim_id !== "string") {
					throw new Error("autoresearch.claim.promote claim_id must be a string");
				}
				return { claim: store.promoteClaim(payload.claim_id) };
			}
			case "autoresearch.claim.invalidate": {
				if (typeof payload.claim_id !== "string") {
					throw new Error("autoresearch.claim.invalidate claim_id must be a string");
				}
				if (typeof payload.reason !== "string") {
					throw new Error("autoresearch.claim.invalidate reason must be a string");
				}
				return { claim: store.invalidateClaim(payload.claim_id, payload.reason) };
			}
			case "autoresearch.reviewer_prompts": {
				const candidate = parseAutoresearchCandidateInput(payload.candidate);
				return { candidate, prompts: buildAutoresearchReviewerPrompts(candidate, store.getState()) };
			}
			case "autoresearch.reviewers.spawn": {
				if (payload.model !== undefined || payload.thinking !== undefined) {
					throw new Error("autoresearch reviewers inherit the current Prime model/provider configuration");
				}
				const candidate = parseAutoresearchCandidateInput(payload.candidate);
				const assignments = await this._spawnAutoresearchReviewers(candidate);
				return { candidate, assignments };
			}
			case "autoresearch.results.collect":
				return await this._collectAutoresearchAgentResults();
			case "autoresearch.cycle.complete": {
				const timeoutMs = parseAutoresearchSupervisorTimeoutMs(payload.supervisor_timeout_ms);
				const collection = await this._collectAutoresearchAgentResults();
				const result = store.recordCycle(parseAutoresearchCycleInput(payload.cycle));
				this._syncAvoResearchState();
				let supervisor: { rlmChildId: string; name: string };
				try {
					supervisor = await this._ensureAutoresearchSupervisor();
				} catch (error) {
					return {
						...result,
						supervisor: null,
						delivery: { error: error instanceof Error ? error.message : String(error) },
					};
				}
				const delivery = await this._dispatchAutoresearchCheckpoint(
					supervisor,
					result.cycle.cycleId,
					result.packet,
					timeoutMs,
				);
				return { ...result, supervisor, delivery, collection };
			}
			case "autoresearch.supervision.record": {
				return { supervision: store.recordSupervision(parseAutoresearchSupervisionInput(payload.supervision)) };
			}
			case "autoresearch.supervision.retry": {
				if (typeof payload.cycle_id !== "string") {
					throw new Error("autoresearch.supervision.retry cycle_id must be a string");
				}
				const result = store.getSupervisorCheckpoint(payload.cycle_id);
				const timeoutMs = parseAutoresearchSupervisorTimeoutMs(payload.supervisor_timeout_ms);
				const supervisor = await this._ensureAutoresearchSupervisor({ forceRebind: true });
				const delivery = await this._dispatchAutoresearchCheckpoint(
					supervisor,
					result.cycle.cycleId,
					result.packet,
					timeoutMs,
				);
				return { ...result, supervisor, delivery };
			}
			case "autoresearch.stop_gate":
				await this._collectAutoresearchAgentResults();
				this._syncAvoResearchState();
				return { stop_gate: store.evaluateStopGate() };
			case "autoresearch.export": {
				if (payload.final !== undefined && typeof payload.final !== "boolean") {
					throw new Error("autoresearch.export final must be a boolean when provided");
				}
				await this._collectAutoresearchAgentResults();
				this._syncAvoResearchState();
				return { deliverable: store.exportDeliverable(payload.final === true) };
			}
			default:
				throw new Error(`unknown autoresearch request type "${type}"`);
		}
	}

	handleAgentMessageHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	):
		| Promise<AgentSessionMessageListResult | AgentSessionMessageReceipt | AgentFamilyRosterResult>
		| AgentSessionMessageListResult
		| AgentFamilyRosterResult {
		if (!this._agentMessageController) {
			throw new Error("agent messaging is not available in this session");
		}
		switch (type) {
			case "agent_message.list_agents":
				if (!this._agentMessageController.roster)
					throw new Error("agent family roster is not available in this session");
				return this._agentMessageController.roster();
			case "agent_message.send": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_message.send target must be a string");
				}
				if (typeof payload.message !== "string") {
					throw new Error("agent_message.send message must be a string");
				}
				return this._agentMessageController.sendAgentMessage({
					target: assertDirectAgentMessageTarget(payload.target),
					message: normalizeAgentSessionMessage(payload.message),
				});
			}
			default:
				throw new Error(`unknown agent message request type "${type}"`);
		}
	}

	handleAgentObserveHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	):
		| AgentObserveListResult
		| AgentObserveAgentSnapshot
		| AgentObserveRecentMessagesResult
		| Promise<AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult> {
		const controller = this._agentObserveController;
		if (!controller) {
			throw new Error("agent observation is not available in this session");
		}
		switch (type) {
			case "agent_observe.list":
				return controller.listAgents();
			case "agent_observe.get": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_observe.get target must be a string");
				}
				return controller.getAgent(payload.target);
			}
			case "agent_observe.recent": {
				if (typeof payload.target !== "string") {
					throw new Error("agent_observe.recent target must be a string");
				}
				return controller.recentMessages({
					target: payload.target,
					limit: normalizeObserveLimit(payload.limit as number | undefined),
					maxChars: normalizeObserveMaxChars((payload.max_chars ?? payload.maxChars) as number | undefined),
				});
			}
			default:
				throw new Error(`unknown agent observe request type "${type}"`);
		}
	}

	private _createGoalFromHost(objective: string, tokenBudget: number | undefined): GoalState {
		switch (this._goalState.status) {
			case "active":
				throw new Error(
					"cannot create a new goal because this thread already has an active goal; run `await goal.complete()` when it is achieved, or ask the user to clear it with /goal clear",
				);
			case "paused":
				throw new Error(
					"cannot create a new goal because a paused goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			case "budget_limited":
				throw new Error(
					"cannot create a new goal because a budget-limited goal exists; ask the user to resume it with /goal resume or clear it with /goal clear",
				);
			default:
				// idle, or a terminal record (complete / error): nothing pending, start fresh.
				return this._startGoal(objective, tokenBudget);
		}
	}

	private _completeGoalFromHost(): GoalState {
		if (!this._goalState.objective || this._goalState.status === "idle") {
			throw new Error("cannot complete goal because this thread has no goal");
		}
		const goal = this._goalWithAccountedWallClock();
		// A turn can cross the budget and complete the goal at once: accounting
		// runs at message_end, before the completing ipython cell executes, so a
		// budget-limit context may already be steered. It is stale now — drop it.
		this._clearQueuedGoalContexts();
		this._setGoalState({
			...goal,
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
			lastError: undefined,
		});
		return this._goalState;
	}

	private async _getGoalContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return [];
		}
		if (signal?.aborted || this._goalState.status !== "active" || !this._goalState.objective) {
			return [];
		}
		// Delegating and ending the turn is correct behavior; hold the continuation
		// until descendants settle instead of re-prompting a waiting parent.
		if (this._hasUnsettledRlmQuiescenceWork()) {
			this._goalContinuationAwaitsRlmWork = true;
			return [];
		}
		this._goalContinuationAwaitsRlmWork = false;
		try {
			this._ensureGoalRuntimeActive(context.context);
			const nextGoal = {
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			};
			this._setGoalState(nextGoal);
			return [createGoalContextMessage(this._goalState, "continuation")];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this._finishGoalWithError(message);
			} catch {
				// The continuation hook must not reject; listener failures should not crash the agent loop.
			}
			return [];
		}
	}

	private async _getContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this.queuedActionCount > 0) {
			await this._completeAvoCanonicalDeliveryIfMatching(context, signal);
			return [];
		}
		const avoContinuation = await this._getAvoCompletionContinuation(context, signal);
		if (avoContinuation) return [avoContinuation];
		// Canonical AVO delivery is terminal evidence. _getAvoCompletionContinuation()
		// may have completed the run while handling this exact assistant message, so
		// do not fall through and enqueue a generic autonomous continuation.
		if (this._enforceAvoCompletion && this._avoRuntime?.getState().status === "completed") {
			return [];
		}
		if (this._pendingAvoCanonicalDelivery() || this._isAvoCanonicalDeliveryTerminalFailure()) return [];
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const goalSnapshot = this._goalState;
		const goalAccountingStartedAt = this._goalAccountingStartedAt;
		const goalMessages = await this._getGoalContinuationMessages(context, signal);
		if (goalMessages.length > 0 || signal?.aborted) {
			if (goalMessages.length > 0 && this._sessionInputArrivalEpoch !== arrivalEpoch) {
				this._setGoalState(goalSnapshot);
				this._goalAccountingStartedAt = goalAccountingStartedAt;
				return [];
			}
			return goalMessages;
		}
		if (
			this._autonomousContinuationSuppressionDepth > 0 ||
			context.newMessages.some((message) => this._autonomousContinuationSuppressedMessages.has(message))
		) {
			return [];
		}
		const autonomousSnapshot = this._snapshotAutonomousRuntimeState();
		const autonomousMessage = await nextAutonomousContinuation(this._autonomousState, context.message, {
			cwd: this._cwd,
			signal,
		});
		if (autonomousMessage && this._sessionInputArrivalEpoch !== arrivalEpoch) {
			this._restoreAutonomousRuntimeSnapshot(autonomousSnapshot);
			return [];
		}
		return autonomousMessage ? [autonomousMessage] : [];
	}

	private async _assessAvoCanonicalDeliveryLocked(
		context: Pick<GetContinuationMessagesContext, "message" | "newMessages">,
		signal?: AbortSignal,
	) {
		if (
			!this._enforceAvoCompletion ||
			!this._avoRuntime ||
			this._rlmDepth !== 0 ||
			signal?.aborted ||
			context.message.stopReason === "aborted"
		) {
			return undefined;
		}
		const initial = this._avoRuntime.getState();
		if (!initial.objective || initial.status !== "active") return undefined;
		let gate: AvoStopGate;
		let expectedGeneration = captureAvoCanonicalDeliveryGeneration(initial);
		if (initial.delivery.phase === "pending") {
			if (!expectedGeneration) return undefined;
			// `pending` is a persisted receipt that the full mutable stop gate
			// already passed. Never re-run integrity/evaluator projection here:
			// canonical delivery is a digest comparison plus store finalization.
			gate = {
				passed: true,
				checks: [{ id: "canonical_delivery_pending", label: "Persisted canonical delivery", passed: true }],
				reasons: [],
			};
		} else {
			await this._collectAvoSupervisorResults();
			if (this._disposed || this._disposing || !this._avoRuntime) return undefined;
			const postSupervisorState = this._avoRuntime.getState();
			if (postSupervisorState.status !== "active") return undefined;
			if (postSupervisorState.delivery.phase === "pending") {
				expectedGeneration = captureAvoCanonicalDeliveryGeneration(postSupervisorState);
				if (!expectedGeneration) return undefined;
				gate = {
					passed: true,
					checks: [{ id: "canonical_delivery_pending", label: "Persisted canonical delivery", passed: true }],
					reasons: [],
				};
			} else {
				// Whether or not the generation changed during supervisor collection,
				// project the full gate from the post-await owner only.
				expectedGeneration = captureAvoCanonicalDeliveryGeneration(postSupervisorState);
				if (postSupervisorState.delivery.phase === "accepted" && !expectedGeneration) return undefined;
				gate = this._evaluateAvoStopGateWithCanonicalRepair();
			}
		}
		let state = this._avoRuntime.getState();
		if (state.status !== "active") return undefined;
		let completionError: Error | undefined;
		if (gate.passed && state.delivery.phase !== "pending") {
			try {
				expectedGeneration = await this._beginAvoCanonicalDeliveryLocked(gate);
				if (this._disposed || this._disposing || !this._avoRuntime) return undefined;
				state = this._avoRuntime.getState();
				if (!expectedGeneration || !matchesAvoCanonicalDeliveryGeneration(state, expectedGeneration, "pending")) {
					return undefined;
				}
			} catch (error) {
				completionError = error instanceof Error ? error : new Error(String(error));
			}
			if (!completionError) {
				this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			}
		}
		const acceptedCandidate = state.delivery.candidateId
			? state.candidates.find((candidate) => candidate.candidateId === state.delivery.candidateId)
			: undefined;
		// Provider-authored search provenance is visible evidence, not model-authored
		// candidate text. Keep it out of the exact canonical-delivery digest while
		// retaining the structured block for the independent online-evidence gate.
		const assistantText = readAvoAssistantDeliveryText(context.message);
		const assistantDigest = digestAvoDeliveryText(assistantText);
		const deliveryMatches =
			gate.passed &&
			state.delivery.phase === "pending" &&
			acceptedCandidate?.deliveryDigest !== undefined &&
			acceptedCandidate.deliveryDigest === state.delivery.deliveryDigest &&
			assistantDigest === acceptedCandidate.deliveryDigest;
		return { state, gate, acceptedCandidate, assistantText, assistantDigest, deliveryMatches, completionError };
	}

	private _assessAvoProgressWatchdog(
		message: object,
		state: AvoRunState,
		deliveryReady: boolean,
	): AvoProgressWatchdogAssessment {
		const cached = this._avoProgressWatchdogAssessments.get(message);
		if (cached) return cached;
		if (isAvoFeatureAblated("qualified_watchdog")) {
			const disabled: AvoProgressWatchdogAssessment = {
				action: "disabled",
				madeProgress: false,
				consecutiveNoProgressTurns: 0,
				consecutiveDeliveryMismatchTurns: 0,
				recoveredFromNoProgressTurns: 0,
				progressIndicators: [],
			};
			this._avoProgressWatchdogAssessments.set(message, disabled);
			return disabled;
		}
		const assessment = this._avoProgressWatchdog.observe(this._captureAvoProgressWatchdogSnapshot(state), {
			deliveryReady,
		});
		if (
			assessment.action === "watch" ||
			assessment.action === "intervene" ||
			assessment.action === "delivery_intervene"
		) {
			const reason =
				assessment.action === "watch"
					? "Anti-laziness watch: this root turn produced no meaningful host pass, obligation coverage, tested critical assumption, completed cycle, or experiment cell."
					: assessment.action === "delivery_intervene"
						? `Anti-laziness delivery intervention: ${assessment.consecutiveDeliveryMismatchTurns} consecutive root turns changed or decorated the verified candidate's exact canonical delivery.`
						: `Anti-laziness intervention: ${assessment.consecutiveNoProgressTurns} consecutive root turns produced no new host-observable progress; the next turn must change approach.`;
			this._requireAvoRuntime().store.recordProgressWatchdogCheckpoint({
				consecutiveNoProgressTurns:
					assessment.action === "delivery_intervene"
						? assessment.consecutiveDeliveryMismatchTurns
						: assessment.consecutiveNoProgressTurns,
				resumed: false,
				reason,
				escalateHorizon: assessment.action !== "delivery_intervene",
				unit: assessment.action === "delivery_intervene" ? "delivery" : "root_turn",
			});
		} else if (assessment.recoveredFromNoProgressTurns > 0) {
			this._requireAvoRuntime().store.recordProgressWatchdogCheckpoint({
				consecutiveNoProgressTurns: 0,
				resumed: true,
				reason: `Host-observable progress resumed after ${assessment.recoveredFromNoProgressTurns} stalled turn(s): ${assessment.progressIndicators.join("; ")}.`,
			});
		}
		this._avoProgressWatchdogAssessments.set(message, assessment);
		return assessment;
	}

	private async _completeAvoCanonicalDeliveryIfMatching(
		context: Pick<GetContinuationMessagesContext, "message" | "newMessages">,
		signal?: AbortSignal,
	): Promise<boolean> {
		return this._withAvoCanonicalDeliverySerialization(() =>
			this._completeAvoCanonicalDeliveryIfMatchingLocked(context, signal),
		);
	}

	private async _completeAvoCanonicalDeliveryIfMatchingLocked(
		context: Pick<GetContinuationMessagesContext, "message" | "newMessages">,
		signal?: AbortSignal,
	): Promise<boolean> {
		const delivery = await this._assessAvoCanonicalDeliveryLocked(context, signal);
		if (!delivery || !this._avoRuntime) return false;
		if (delivery.completionError) {
			this._recordObservedAvoCanonicalDeliveryFailure(delivery.completionError, delivery.state);
			return false;
		}
		if (!delivery.deliveryMatches) return false;
		try {
			this._completeAvoCanonicalDelivery(delivery.assistantText);
		} catch (error) {
			this._recordObservedAvoCanonicalDeliveryFailure(error, delivery.state);
			return false;
		}
		this._discardObsoleteAvoCompletionInputs(delivery.state, { includeCanonicalDelivery: false });
		this._avoCanonicalDeliveryQueuedRunId = undefined;
		this._avoCanonicalDeliveryQueuedBinding = undefined;
		this._avoCanonicalDeliveryDirectBinding = undefined;
		this._avoCanonicalDeliveryAttemptBinding = undefined;
		return true;
	}

	private async _getAvoCompletionContinuation(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		return this._withAvoCanonicalDeliverySerialization(() =>
			this._getAvoCompletionContinuationLocked(context, signal),
		);
	}

	private async _getAvoCompletionContinuationLocked(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<CustomMessage | undefined> {
		const delivery = await this._assessAvoCanonicalDeliveryLocked(context, signal);
		if (!delivery || !this._avoRuntime) return undefined;
		const { state, gate, acceptedCandidate, assistantText, assistantDigest, deliveryMatches, completionError } =
			delivery;
		if (completionError) {
			this._recordObservedAvoCanonicalDeliveryFailure(completionError, state);
			return undefined;
		}
		if (deliveryMatches) {
			try {
				this._completeAvoCanonicalDelivery(assistantText);
			} catch (error) {
				this._recordObservedAvoCanonicalDeliveryFailure(error, state);
				return undefined;
			}
			this._discardObsoleteAvoCompletionInputs(state, { includeCanonicalDelivery: false });
			this._avoCanonicalDeliveryQueuedRunId = undefined;
			this._avoCanonicalDeliveryQueuedBinding = undefined;
			this._avoCanonicalDeliveryDirectBinding = undefined;
			this._avoCanonicalDeliveryAttemptBinding = undefined;
			return undefined;
		}
		if (this._isAvoCanonicalDeliveryTerminalFailure()) return undefined;
		if (state.delivery.phase === "pending") {
			const pendingBinding = parseAvoCanonicalDeliveryBinding(state.delivery);
			if (!pendingBinding) {
				this._recordMalformedPendingAvoCanonicalDeliveryFailure(
					new Error("AVO completion is blocked: canonical delivery record is inconsistent"),
				);
				return undefined;
			}
			if (
				!matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryQueuedBinding, pendingBinding) &&
				!matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryDirectBinding, pendingBinding) &&
				!matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, pendingBinding)
			) {
				const canonicalMessage = this._createAvoCanonicalDeliveryMessage(state);
				if (!canonicalMessage) {
					this._recordAvoCanonicalDeliveryFailure(
						new Error("AVO completion is blocked: canonical delivery record is inconsistent"),
						pendingBinding,
					);
					return undefined;
				}
				this._discardObsoleteAvoCompletionInputs(state);
				this._clearQueuedAutonomousContinuations();
				this._clearQueuedGoalContexts();
				this._fenceAvoCanonicalDeliveryInputs();
				this._avoCanonicalDeliveryDirectBinding = pendingBinding;
				return canonicalMessage;
			}
			// `agent_end` owns deterministic host fallback for a provider failure
			// of this exact request. It must not become an AVO repair continuation.
			if (context.message.stopReason === "error") return undefined;
			this._recordAvoCanonicalDeliveryFailure(
				new Error("the assistant did not return the accepted candidate's exact canonical delivery"),
				pendingBinding,
			);
			return undefined;
		}
		// AVO completion repair is an autonomous continuation path too. It runs
		// before the generic autonomous continuation policy, so enforce the shared
		// hard budget here after first giving this in-flight assistant message a
		// chance to provide canonical terminal evidence.
		if (this._autonomousState.enabled && autonomousLimitReason(this._autonomousState)) {
			return undefined;
		}
		const watchdog = this._assessAvoProgressWatchdog(
			context.message,
			state,
			gate.passed && acceptedCandidate !== undefined,
		);
		const continuationState = this._avoRuntime.getState();
		const reasons = [
			...gate.reasons,
			...(acceptedCandidate ? [] : ["no accepted candidate currently satisfies the verification contract"]),
			...(gate.passed && acceptedCandidate?.deliveryDigest === undefined
				? ["the accepted candidate predates canonical-delivery binding; record and verify a fresh candidate"]
				: []),
			...(gate.passed && acceptedCandidate?.deliveryDigest && assistantDigest !== acceptedCandidate.deliveryDigest
				? ["the assistant text does not exactly match the accepted candidate's canonical delivery"]
				: []),
		];
		await this._refreshAvoMemoryContext(
			`${continuationState.objective ?? "Active AVO task"}\nCurrent blocking conditions: ${reasons.join("; ")}`,
		);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
		const content = [
			"<avo_completion_required>",
			"The host blocked task completion. Continue working now; do not ask the user to re-prompt you.",
			`Task run: ${continuationState.runId}`,
			`Blocking conditions: ${reasons.join("; ") || "canonical delivery is incomplete"}`,
			watchdog.action === "watch"
				? "Anti-laziness watch: no new host-observable progress occurred in this turn. Stop narrating, stop probing Prime/AVO internals, and perform the next concrete task action now."
				: watchdog.action === "intervene"
					? `Anti-laziness intervention: ${watchdog.consecutiveNoProgressTurns} consecutive turns made no measurable progress. Do not repeat the same approach. Work on the target directly, produce a fresh candidate, and obtain a task-specific host check.`
					: watchdog.action === "delivery_intervene"
						? `Anti-laziness delivery intervention: ${watchdog.consecutiveDeliveryMismatchTurns} consecutive turns failed exact delivery. Return only the accepted candidate's canonical text now; do not paraphrase, explain, decorate, or append anything.`
						: watchdog.action === "progress"
							? `Progress watchdog observed: ${watchdog.progressIndicators.join("; ") || "host-observable task state changed"}. Continue from that progress and close the remaining verification gap.`
							: watchdog.action === "disabled"
								? "Continue working on the blocking conditions and produce the required host evidence."
								: "The verified candidate is ready. Return its exact canonical delivery without extra text.",
			"Use the avo skill automatically to record a candidate, obtain the required host-issued evidence, complete its cycle, and inspect the stop gate.",
			"Once the gate passes, return only the exact canonical delivery for the accepted candidate: general tasks use the candidate payload text, deterministic arithmetic uses the numeric result, and coding/research use the candidate summary. Do not add a preface, suffix, or unverified claim.",
			"</avo_completion_required>",
		].join("\n");
		return {
			role: "custom",
			customType: "avo_completion_required",
			content,
			display: true,
			details: {
				runId: continuationState.runId,
				gatePassed: gate.passed,
				checks: gate.checks,
				reasons,
				watchdog: {
					action: watchdog.action,
					consecutiveNoProgressTurns: watchdog.consecutiveNoProgressTurns,
					consecutiveDeliveryMismatchTurns: watchdog.consecutiveDeliveryMismatchTurns,
					progressIndicators: watchdog.progressIndicators,
				},
			},
			timestamp: Date.now(),
		};
	}

	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	private _agentMessageOutcome(agentMessageId: string): AgentMessageOutcome {
		let outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) {
			outcome = {};
			this._agentMessageOutcomes.set(agentMessageId, outcome);
		}
		return outcome;
	}

	/**
	 * Register a delivery waiter before submitting the prompt. Delivery outcomes are not retained
	 * for late lookup, so callers that register after admission may wait for a future use of the id.
	 */
	waitForAgentMessagePromptDelivery(agentMessageId: string): Promise<void> {
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.delivery ??= createAgentMessageDeferred();
		return outcome.delivery.promise;
	}

	private _settleAgentMessage(
		agentMessageId: string | undefined,
		leg: "delivery" | "completion",
		error?: Error,
	): void {
		if (agentMessageId === undefined) return;
		const outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) return;
		const deferred = outcome[leg];
		if (!deferred) return;
		outcome[leg] = undefined;
		if (!outcome.delivery && !outcome.completion) {
			this._agentMessageOutcomes.delete(agentMessageId);
		}
		if (error) deferred.reject(error);
		else deferred.resolve();
	}

	private _rejectAgentMessage(agentMessageId: string | undefined, error: Error): void {
		if (agentMessageId === undefined) return;
		this._settleAgentMessage(agentMessageId, "delivery", error);
		this._settleAgentMessage(agentMessageId, "completion", error);
	}

	private _rejectQueuedAgentMessageDeliveries(deliveryError: Error, completionError = deliveryError): void {
		for (const action of this._actionStore.unfinishedActions()) {
			this._settleAgentMessage(action.agentMessageId, "delivery", deliveryError);
			this._settleAgentMessage(action.agentMessageId, "completion", completionError);
		}
	}

	private _capturingCancelledAction(message: AgentMessage): QueuedSessionAction | undefined {
		return this._actionStore
			.ownedActions()
			.find(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages?.has(message) === true,
			);
	}

	private _hasCancelledDispatchCapture(): boolean {
		return this._actionStore
			.ownedActions()
			.some(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages !== undefined,
			);
	}

	private _handleAgentEvent = (event: AgentEvent): void => {
		this._createRetryPromiseForAgentEnd(event);
		if (event.type === "message_start" || event.type === "message_end") {
			for (const action of this._actionStore.ownedActions()) {
				if (
					action.payload.kind !== "turn" ||
					!action.payload.captureRunMessages ||
					action.payload.cancelledDispatchEnded
				) {
					continue;
				}
				const primary = primaryDeliveryRecord(action);
				if (event.message === primary.message || primary.started) {
					action.payload.captureRunMessages.add(event.message);
				}
			}
		} else if (event.type === "agent_end") {
			const captured = new Set<AgentMessage>();
			for (const action of this._actionStore.ownedActions()) {
				if (action.payload.kind === "turn" && action.payload.captureRunMessages) {
					for (const message of action.payload.captureRunMessages) captured.add(message);
					action.payload.cancelledDispatchEnded = true;
				}
			}
			if (captured.size > 0) {
				this.agent.state.messages = this.agent.state.messages.filter((message) => !captured.has(message));
			}
		}
		if (event.type === "message_start" && (event.message.role === "user" || event.message.role === "custom")) {
			for (const action of this._actionStore.actionsForMessage(event.message)) {
				const record =
					action.payload.kind === "turn"
						? action.payload.records.find((candidate) => candidate.message === event.message)
						: undefined;
				if (record) record.started = true;
				if (record?.role === "primary") {
					this._actionStore.ticketFor(action).settleDelivered({ status: "delivered" });
					this._settleAgentMessage(action.agentMessageId, "delivery");
				}
			}
		} else if (event.type === "message_end" && (event.message.role === "user" || event.message.role === "custom")) {
			for (const action of this._actionStore.actionsForMessage(event.message)) {
				const record =
					action.payload.kind === "turn"
						? action.payload.records.find((candidate) => candidate.message === event.message)
						: undefined;
				if (record) record.durable = true;
				if (record?.role === "primary" && action.lifecycle.state === "committing") {
					transitionSessionAction(action, {
						state: "running",
						execution: "agent_turn",
					});
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
				}
			}
		}
		this._agentEventQueue = this._agentEventQueue.then(
			() => this._processAgentEvent(event),
			() => this._processAgentEvent(event),
		);
		this._agentEventQueue.catch(() => {});
	};

	private _createRetryPromiseForAgentEnd(event: AgentEvent): void {
		if (event.type !== "agent_end" || this._retryPromise) {
			return;
		}
		const pendingDelivery = this._pendingAvoCanonicalDelivery();
		const pendingBinding = parseAvoCanonicalDeliveryBinding(pendingDelivery);
		if (
			pendingBinding &&
			matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, pendingBinding)
		) {
			return;
		}

		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return;
		}

		const lastAssistant = this._findLastAssistantInMessages(event.messages);
		const concreteAuthFailure = lastAssistant ? this._isConcreteProviderAuthFailure(lastAssistant) : false;
		if (!lastAssistant || (!this._isRetryableError(lastAssistant) && !concreteAuthFailure)) {
			return;
		}
		if (concreteAuthFailure) {
			this._captureRetryAuthFailureSource(lastAssistant);
		}

		this._retryPromise = new Promise((resolve) => {
			this._retryResolve = resolve;
		});
	}

	private _findLastAssistantInMessages(messages: AgentMessage[]): AssistantMessage | undefined {
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role === "assistant") {
				return message as AssistantMessage;
			}
		}
		return undefined;
	}

	private _addLoginGuidanceToAuthError(event: AgentEvent): void {
		const message =
			event.type === "message_end" && event.message.role === "assistant"
				? (event.message as AssistantMessage)
				: event.type === "agent_end"
					? this._findLastAssistantInMessages(event.messages)
					: undefined;
		if (!message || message.stopReason !== "error" || !message.errorMessage) {
			return;
		}
		if (!isLikelyAuthenticationError(message.errorMessage)) {
			return;
		}
		message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
	}

	private async _processAgentEvent(event: AgentEvent): Promise<void> {
		let clearedDispatchEnded = false;
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "toolResult") {
			this._applyLateIpythonSentAgentMessages(event.message);
		}
		if (event.type === "message_start" || event.type === "message_end") {
			const cleared = this._capturingCancelledAction(event.message);
			if (cleared?.payload.kind === "turn" && cleared.payload.captureRunMessages) {
				const captured = cleared.payload.captureRunMessages;
				this.agent.state.messages = this.agent.state.messages.filter((message) => !captured.has(message));
				return;
			}
		}
		if (event.type === "agent_end") {
			const cleared = this._actionStore
				.ownedActions()
				.filter(
					(action) =>
						action.lifecycle.state === "cancelled" &&
						action.payload.kind === "turn" &&
						action.payload.captureRunMessages !== undefined,
				);
			if (cleared.length > 0) {
				clearedDispatchEnded = true;
				const removed = new Set(
					cleared.flatMap((action) =>
						action.payload.kind === "turn" ? [...(action.payload.captureRunMessages ?? [])] : [],
					),
				);
				this.agent.state.messages = this.agent.state.messages.filter((message) => !removed.has(message));
				(this.agent.state as { errorMessage?: string }).errorMessage = undefined;
				this._lastAssistantMessage = undefined;
				for (const action of cleared) this._actionStore.releaseTerminal(action);
				this._notifySessionInputCheckpointChange();
				this._resolveRetry();
			}
		}

		if (event.type === "message_start" && startsAgentRun(event.message)) {
			this._overflowRecovery = "idle";
		}
		if (
			event.type === "message_start" &&
			event.message.role === "custom" &&
			event.message.customType === "avo_canonical_delivery_required"
		) {
			const binding = parseAvoCanonicalDeliveryBinding(event.message.details);
			if (binding && matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryDirectBinding, binding)) {
				this._avoCanonicalDeliveryDirectBinding = undefined;
			}
			this._avoCanonicalDeliveryAttemptBinding = binding;
		}

		await this._emitExtensionEvent(event);
		if (event.type === "message_start" || event.type === "message_end") {
			const cleared = this._capturingCancelledAction(event.message);
			if (cleared?.payload.kind === "turn" && cleared.payload.captureRunMessages) {
				const captured = cleared.payload.captureRunMessages;
				this.agent.state.messages = this.agent.state.messages.filter((message) => !captured.has(message));
				return;
			}
		}

		this._addLoginGuidanceToAuthError(event);

		this._emit(event);

		if (event.type === "turn_end") {
			await this._maybeInterveneAvoToolStagnation(event.toolResults);
		}

		if (event.type === "message_end") {
			if (event.message.role === "custom") {
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				this.sessionManager.appendMessage(event.message);
			}

			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				const pendingDelivery = this._pendingAvoCanonicalDelivery();
				const pendingBinding = parseAvoCanonicalDeliveryBinding(pendingDelivery);
				const canonicalDeliveryAttempt =
					pendingBinding !== undefined &&
					matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, pendingBinding);
				if (assistantMsg.stopReason !== "error") {
					addAutonomousUsage(this._autonomousState, assistantMsg.usage);
				}
				if (
					!canonicalDeliveryAttempt &&
					assistantMsg.stopReason !== "error" &&
					assistantMsg.stopReason !== "aborted"
				) {
					this._assistantTurnsSinceAutoRefine++;
					// In serialized mode, kick off background refinement planning
					// immediately after the primary stream finishes, while tools
					// are still executing. The plan is awaited at shouldStopAfterTurn
					// before applying, so planning overlaps tools only — never another
					// model request.
					this._maybeStartSerializedBackgroundPlan();
				}
				if (assistantMsg.stopReason !== "error") {
					this._overflowRecovery = "idle";
				}
				if (this._isConcreteProviderAuthFailure(assistantMsg)) {
					this._captureRetryAuthFailureSource(assistantMsg);
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
					this._retryAuthFailureSources = [];
				}
				if (!canonicalDeliveryAttempt && this._accountGoalUsageForAssistantMessage(assistantMsg)) {
					const message = createGoalContextMessage(this._goalState, "budget_limit");
					const normalized = normalizeMessageContent(message.content);
					await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
						message,
						resumeIfIdle: true,
					});
				}
			}
		}

		if (clearedDispatchEnded) {
			return;
		}

		if (event.type === "agent_end") {
			const msg =
				this._lastAssistantMessage ??
				(this._retryPromise ? this._findLastAssistantInMessages(event.messages) : undefined);
			this._lastAssistantMessage = undefined;
			if (!msg) {
				this._resolveRetry();
				return;
			}
			const avoTerminalState = this._enforceAvoCompletion ? this._avoRuntime?.getState() : undefined;
			if (avoTerminalState && this._avoCanonicalDeliveryFailedRunIds.has(avoTerminalState.runId)) {
				this._finishActiveRetryWithFailure(msg);
				this._resolveRetry();
				return;
			}
			if (avoTerminalState?.status === "completed" || avoTerminalState?.delivery.phase === "delivered") {
				// Canonical delivery was finalized at the turn boundary. Nothing after
				// that boundary may start compaction, refinement, a provider retry, or
				// another autonomous/goal continuation.
				this._resolveRetry();
				return;
			}
			if (avoTerminalState?.status === "failed" || avoTerminalState?.delivery.phase === "failed") {
				this._finishActiveRetryWithFailure(msg);
				this._resolveRetry();
				return;
			}
			const pendingDelivery = this._pendingAvoCanonicalDelivery();
			const pendingBinding = parseAvoCanonicalDeliveryBinding(pendingDelivery);
			if (
				pendingBinding &&
				matchesAvoCanonicalDeliveryBinding(this._avoCanonicalDeliveryAttemptBinding, pendingBinding)
			) {
				const completed = await this._completeAvoCanonicalDeliveryIfMatching({
					message: msg,
					newMessages: [msg],
				});
				const hostFallbackCompleted =
					!completed && msg.stopReason === "error"
						? this._completeAvoCanonicalDeliveryFromHostFallback(msg, pendingBinding)
						: false;
				if (hostFallbackCompleted) {
					this._resolveRetry();
					return;
				}
				if (!completed && !this._isAvoCanonicalDeliveryTerminalFailure()) {
					this._recordAvoCanonicalDeliveryFailure(
						new Error(
							msg.stopReason === "error"
								? `canonical delivery provider failed: ${msg.errorMessage ?? "unknown provider error"}`
								: "the assistant did not return the accepted candidate's exact canonical delivery",
						),
						pendingBinding,
					);
				}
				this._finishActiveRetryWithFailure(msg);
				this._resolveRetry();
				return;
			}

			const concreteAuthFailure = this._isConcreteProviderAuthFailure(msg);
			const retryConcreteAuthFailure =
				concreteAuthFailure && !this._isStructuredPermanentProviderRetryExhausted(msg);
			if (this._isRetryableError(msg) || retryConcreteAuthFailure) {
				if (retryConcreteAuthFailure) {
					this._captureRetryAuthFailureSource(msg);
				}
				const didRetry = await this._handleRetryableError(msg, {
					markAuthStaleOnFailure: retryConcreteAuthFailure,
					authSourceTokens: retryConcreteAuthFailure ? this._retryAuthFailureSources : undefined,
				});
				if (didRetry) return; // Retry was initiated, don't proceed to compaction
			}

			const compactionWillRetry = await this._checkCompaction(msg);
			if (compactionWillRetry && this._retryAttempt > 0) {
				return;
			}
			this._finishActiveRetryWithFailure(msg);
			this._resolveRetry();
			if (!compactionWillRetry) {
				this._finishGoalForTerminalAssistantMessage(msg);
				// In serialized mode, agent-callable refine.run is serviced
				// at the shouldStopAfterTurn boundary, not here at agent_end.
				if (!this._serializedRefine) {
					const consumedRequestedRefine = this._consumePendingRequestedRefine();
					if (!consumedRequestedRefine) {
						this._scheduleAutoRefineAfterAgentEnd();
					}
				}
			}
		}
	}

	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
			this._scheduleSessionInputPump();
		}
	}

	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _processAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			this.sessionManager.recordGitStateIfChanged();
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			// Also capture at end of turn so commits made during the run (e.g. via a bash tool) land.
			this.sessionManager.recordGitStateIfChanged();
			await this._extensionRunner.emit({
				type: "agent_end",
				messages: event.messages,
			});
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				this._replaceMessageInPlace(event.message, replacement);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(): void {
		if (this._unsubscribeAgent) return; // Already connected
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	/**
	 * Async teardown for graceful quit/switch: await the IPython kernel's dispose
	 * (which flushes a final namespace snapshot) before the synchronous dispose, so
	 * the latest state reaches disk instead of racing process exit.
	 */
	async disposeAsync(): Promise<void> {
		// Concurrent callers await the same in-flight teardown so none resolves before
		// the kernel snapshot flush finishes.
		if (this._disposeAsyncPromise) {
			return this._disposeAsyncPromise;
		}
		this._disposeAsyncPromise = this._disposeWithinDeadline();
		return this._disposeAsyncPromise;
	}

	private async _disposeWithinDeadline(): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				try {
					this._disposing = true;
					this._abortPendingRefinementForDisposal();
					this._sessionActionCommitDisposeAbortController.abort();
					this.dispose();
				} catch {
					// The deadline still rejects even if best-effort synchronous teardown fails.
				}
				reject(new Error(`Session disposal exceeded ${SESSION_DISPOSAL_TIMEOUT_MS}ms`));
			}, SESSION_DISPOSAL_TIMEOUT_MS);
		});

		try {
			await Promise.race([this._disposeGracefully(), deadline]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private async _disposeGracefully(): Promise<void> {
		if (this._disposed) {
			return this._disposeCallbacksPromise;
		}
		// Drain before marking _disposing so a refine triggered at the final
		// agent_end can complete during the bounded grace period.
		await this._drainPendingRefinementForDisposalWithinGrace();
		if (this._disposed) {
			return this._disposeCallbacksPromise;
		}
		this._disposing = true;
		this._sessionActionCommitDisposeAbortController.abort();
		await this._disposeAsyncOnce();
	}

	private async _drainPendingRefinementForDisposalWithinGrace(): Promise<void> {
		const drain = this._drainPendingRefinementForDisposal();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const graceExpired = new Promise<"expired">((resolve) => {
			timeout = setTimeout(() => resolve("expired"), REFINEMENT_DISPOSAL_GRACE_MS);
		});
		try {
			const outcome = await Promise.race([drain.then(() => "drained" as const), graceExpired]);
			if (outcome === "drained") return;

			// Stop late plans from applying even when a provider or extension ignores
			// the abort signal. The abandoned drain remains observed to avoid an
			// unhandled rejection if it eventually settles.
			this._disposing = true;
			this._abortPendingRefinementForDisposal();
			void drain.catch(() => undefined);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}

	private _abortPendingRefinementForDisposal(): void {
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		this._pendingRequestedRefine = undefined;
		this._serializedExplicitRefineOptions = undefined;
		this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._autoRefineBranchVersion++;
		this._autoRefineReviewAbort?.abort();
		this._refineAbortController?.abort();
	}

	/**
	 * Await any in-flight refinement (planning or application) and run a
	 * pending auto-refine that was scheduled but not yet started. Called
	 * from disposeAsync before _disposing is set so refinement completes
	 * before disposal.
	 */
	private async _drainPendingRefinementForDisposal(): Promise<void> {
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		await Promise.allSettled([...this._autoRefineOperations]);
		for (const timer of this._scheduledAutoRefineTimers) {
			clearTimeout(timer);
		}
		this._scheduledAutoRefineTimers.clear();
		// Wait for in-flight refinement (including serialized background plan) to settle.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else if (this._serializedPlanInFlight) {
				// Await the background plan and apply a ready "plan" result before teardown.
				await this._consumeSerializedBackgroundPlan(async (bgResult) => {
					if (bgResult?.status === "plan" && bgResult.branchVersion === this._autoRefineBranchVersion) {
						try {
							await this._applySerializedPlan(bgResult);
						} catch (error) {
							this._emitRefineFailed(error);
						}
						// Stamp cooldown and reset counter so the interval
						// check below does not trigger a duplicate refine.
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
					}
					// Preserve a consumed explicit request when its background plan failed,
					// matching the turn-boundary recovery path. The pending drain below
					// retries it once before disposal.
					if (
						bgResult?.status === "failure" &&
						bgResult.explicit &&
						bgResult.branchVersion === this._autoRefineBranchVersion &&
						!this._pendingRequestedRefine
					) {
						this._pendingRequestedRefine = bgResult.options;
					}
					if (bgResult?.status === "skip" && bgResult.explicit) {
						this._emitRefineFailed(new RefineSkippedError("Refinement skipped by extension"));
					}
					// For "skip" or "failure", stamp cooldown and reset counter
					// so the interval check below does not trigger a duplicate
					// terminal retry.
					if (
						bgResult?.status === "skip" ||
						bgResult?.status === "failure" ||
						bgResult?.status === "invalidated"
					) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
					}
					return false;
				});
			} else {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		// Drain an agent-callable refine.run request that was scheduled but
		// not yet consumed. Use the direct serialized path (no waitForIdle)
		// since the agent may still own activeRun at the final agent_end.
		if (this._pendingRequestedRefine) {
			const pending = this._pendingRequestedRefine;
			this._pendingRequestedRefine = undefined;
			try {
				await this._runSerializedRefine(pending);
			} catch {
				// Best-effort drain; refinement errors must not block disposal.
			}
			// Stamp cooldown and reset counter so the interval check below
			// does not trigger a duplicate refine after the explicit drain.
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		}
		// A serialized compaction can finish without another model turn. Drain its
		// pending review here so disposal does not silently lose the trigger.
		if (this._serializedRefine && this._compactAutoRefinePending && this._autoRefineAllowedForSession()) {
			const compactSettings = this.settingsManager.getAutoRefineSettings();
			if (!compactSettings.enabled || !compactSettings.compact) {
				this._compactAutoRefinePending = false;
			} else {
				const nowMs = Date.now();
				const underCooldown =
					this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < compactSettings.cooldownMs;
				this._compactAutoRefinePending = false;
				if (!underCooldown) {
					try {
						await this._runSerializedAutoRefineReview("compact", this._autoRefineBranchVersion);
					} catch {
						// Best-effort drain; refinement errors must not block disposal.
					}
					return;
				}
			}
		}

		// If auto-refine is due but has not started yet, run it now so the
		// refinement is persisted before disposal. Use the direct serialized
		// path in serialized mode, or _maybeAutoRefine in interactive mode
		// (where the agent is idle at this point).
		if (this._disposed || !this._autoRefineAllowedForSession()) {
			return;
		}
		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			return;
		}
		if (this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;
		if (underCooldown) {
			return;
		}
		if (this._serializedRefine) {
			await this._runSerializedRefineCheckpoint();
		} else {
			await this._maybeAutoRefine("turn_interval");
		}
	}

	private async _disposeAsyncOnce(): Promise<void> {
		// Flush kernels/traces for both still-running and retained children; the sync
		// dispose() below only tears them down synchronously.
		for (const run of [...this._activeRlmChildRuns.values()]) {
			const childSession = run.session;
			if (!childSession) continue;
			if (run.detachedDeletion) {
				run.suppressTerminalNotice = true;
				if (run.deletionCleanupObserver) {
					await run.deletionCleanupObserver.catch(() => false);
				} else if (run.deletionCleanup) {
					await run.deletionCleanup.catch(() => childSession.disposeAsync().catch(() => undefined));
				} else {
					// Cleanup already failed and was exposed for retry before disposal.
					await childSession.disposeAsync().catch(() => undefined);
				}
				if (!run.settled) await this._finishRlmRunDeletion(run);
			} else {
				await childSession.disposeAsync().catch(() => undefined);
			}
		}
		for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
			unsubscribe();
		}
		this._rlmChildUnsubscribes.clear();
		for (const session of this._rlmChildSessions.values()) {
			await session.disposeAsync().catch(() => undefined);
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
		try {
			await this._ipythonKernelProvisioner?.dispose();
		} catch {
			// a failed kernel startup already cleaned up after itself
		}
		this.dispose();
		await this._disposeCallbacksPromise;
	}

	private _startDisposeCallbacks(): Promise<void> {
		if (this._disposeCallbacksPromise) {
			return this._disposeCallbacksPromise;
		}
		const pending: Promise<void>[] = [];
		for (const callback of this._disposeCallbacks) {
			try {
				const result = callback();
				if (result) {
					pending.push(result.catch(() => undefined));
				}
			} catch {
				// Disposal remains best-effort; one owner must not block the rest.
			}
		}
		this._disposeCallbacks.clear();
		this._disposeCallbacksPromise = Promise.all(pending).then(() => undefined);
		return this._disposeCallbacksPromise;
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const run of this._unsettledRlmChildRuns) run.suppressTerminalNotice = true;
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._sessionActionCommitDisposeAbortController.abort();
		try {
			// Invalidate scheduled timers and abort any in-flight review so a late
			// resolution cannot write harness state or re-subscribe handlers.
			this._autoRefineReviewAbort?.abort();
			this._refineAbortController?.abort();
			for (const timer of this._scheduledAutoRefineTimers) {
				clearTimeout(timer);
			}
			this._scheduledAutoRefineTimers.clear();
			this._serializedPlanInFlight = undefined;
			this._serializedExplicitRefineOptions = undefined;
			this._pendingRequestedRefine = undefined;
			this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
			this._autoRefineBranchVersion++;
			this._cancelActiveRlmChildRuns("Parent session disposed");
			for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
				unsubscribe();
			}
			this._rlmChildUnsubscribes.clear();
			for (const session of this._rlmChildSessions.values()) {
				session.dispose();
			}
			this._rlmChildSessions.clear();
			this._rlmChildCleanupFailures.clear();
			this._deletedRlmChildIds.clear();
			this._pendingNextTurnMessages = [];
			const deliveryError = new Error("Session disposed before prompt delivery.");
			const completionError = new Error("Session disposed before prompt completion.");
			this._rejectQueuedAgentMessageDeliveries(deliveryError, completionError);
			for (const [agentMessageId, outcome] of this._agentMessageOutcomes) {
				if (outcome.delivery) this._settleAgentMessage(agentMessageId, "delivery", deliveryError);
				if (outcome.completion) this._settleAgentMessage(agentMessageId, "completion", completionError);
			}
			this._cancelSessionActions(() => true, deliveryError);
			this.agent.clearAllQueues();
			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			);
			this._disconnectFromAgent();
			this._eventListeners = [];
			this._avoRuntime?.dispose();
			cleanupSessionResources(this.sessionId);
		} finally {
			void this._startDisposeCallbacks();
		}
	}

	registerDisposeCallback(callback: () => void | Promise<void>): void {
		if (this._disposed) {
			try {
				const result = callback();
				if (result) void result.catch(() => undefined);
			} catch {
				// Late registration follows the same best-effort disposal contract.
			}
			return;
		}
		this._disposeCallbacks.add(callback);
	}

	get state(): AgentState {
		return this.agent.state;
	}

	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get serviceTier(): ServiceTier {
		return this.agent.state.serviceTier;
	}

	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	get retryAttempt(): number {
		return this._retryAttempt;
	}

	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		const seenToolNames = new Set<string>();
		for (const name of toolNames) {
			if (seenToolNames.has(name)) {
				continue;
			}
			const tool = this._toolRegistry.get(name);
			if (tool) {
				seenToolNames.add(name);
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildSessionContext(): SessionContext {
		const context = this.sessionManager.buildSessionContext();
		for (const message of context.messages) {
			this._applyLateIpythonSentAgentMessages(message);
		}
		this._mergeUnpersistedOutcomes(context.messages);
		return context;
	}

	private _mergeUnpersistedOutcomes(messages: AgentMessage[]): void {
		for (const outcome of this._unpersistedOutcomes) {
			let insertAt = messages.length;
			while (insertAt > 0 && messages[insertAt - 1]!.timestamp > outcome.timestamp) {
				insertAt -= 1;
			}
			messages.splice(insertAt, 0, outcome);
		}
	}

	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	get rlmDepth(): number {
		return this._rlmDepth;
	}

	get rlmMaxDepth(): number {
		return this._rlmMaxDepth;
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get goalState(): GoalState {
		return { ...this._goalWithCurrentWallClock() };
	}

	getAutonomousStatus(): AgentAutonomousStatus {
		const status = autonomousStatus(this._autonomousState);
		const avoState = this._avoRuntime?.getState();
		if (avoState?.status !== "completed") return status;
		return {
			...status,
			terminalEvidence: {
				kind: "avo_completion",
				runId: avoState.runId,
			},
		};
	}

	recordHostAutonomousContinuation(): void {
		addAutonomousContinuation(this._autonomousState);
	}

	async refreshAutonomousGates(): Promise<void> {
		await refreshAutonomousQualityGates(this._autonomousState, {
			cwd: this._cwd,
		});
	}

	private async _runWithAutonomousContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		this._autonomousContinuationSuppressionDepth++;
		try {
			return await fn();
		} finally {
			this._autonomousContinuationSuppressionDepth--;
		}
	}

	private _markAutonomousContinuationSuppressed(message: AgentMessage): void {
		this._autonomousContinuationSuppressedMessages.add(message);
	}

	get scopedModels(): ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}> {
		return this._scopedModels;
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const avoState = this._avoRuntime?.getState();
		const avoPrompt = avoState ? buildAvoRuntimePrompt(avoState, this._avoMemoryContext) : undefined;
		const avoDeliveryPrompt =
			avoState?.delivery.phase === "pending"
				? [
						`AVO_CANONICAL_DELIVERY_PENDING run_id=${avoState.runId} candidate_id=${avoState.delivery.candidateId ?? "unknown"}.`,
						"This persisted terminal phase survived process restart. Do not use tools, create candidates, start supervisors or RLM children, evaluate, reflect, reconcile, retry task work, or answer a newer queued task.",
						"Return only the exact canonical delivery already bound by the host. No preface, suffix, explanation, or decoration is permitted.",
					].join("\n")
				: avoState?.delivery.phase === "failed" || avoState?.status === "failed"
					? `AVO_CANONICAL_DELIVERY_FAILED run_id=${avoState.runId}. The persisted invariant failure is terminal; do not re-enter AVO or invoke any provider, tool, supervisor, or RLM recovery loop.`
					: undefined;
		const appendSystemPromptParts = [...loaderAppendSystemPrompt, ...(avoPrompt ? [avoPrompt] : [])];
		if (avoDeliveryPrompt) appendSystemPromptParts.push(avoDeliveryPrompt);
		const appendSystemPrompt = appendSystemPromptParts.length > 0 ? appendSystemPromptParts.join("\n\n") : undefined;
		const loadedSkills = this._modelVisibleSkills();
		const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;

		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			skills: loadedSkills,
			contextFiles: loadedContextFiles,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			messagesPath: this.sessionManager.getSessionFile(),
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
			allowRecursion: this._rlmDepth < this._rlmMaxDepth,
			rlmDepth: this._rlmDepth,
			rlmParentAgent: this._rlmParentAgent,
			harnessState: this._loadMergedHarnessState(),
			genericMcpServers: this._mcpManager?.getEnabledGenericServers(),
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	private _refreshExtensionSystemPrompt(extensionPrompt: string, baseSnapshot: string): string {
		if (this._baseSystemPrompt === baseSnapshot) {
			return extensionPrompt;
		}
		if (!extensionPrompt.includes(baseSnapshot)) {
			return extensionPrompt;
		}
		return extensionPrompt.replace(baseSnapshot, () => this._baseSystemPrompt);
	}

	private _finishSubmissionNormalization(
		text: string,
		images: ImageContent[] | undefined,
		policy: SubmissionNormalizationPolicy,
	): NormalizedSubmission {
		let expandedText = text;
		if (policy.expandSkills) expandedText = this._expandSkillCommand(expandedText);
		if (policy.expandPromptTemplates) {
			expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
		}
		return { kind: "prompt", text: expandedText, images };
	}

	private _normalizeSubmission(
		text: string,
		images: ImageContent[] | undefined,
		policy: SubmissionNormalizationPolicy,
	): NormalizedSubmission | Promise<NormalizedSubmission> {
		if (policy.parseSessionCommands) {
			const command = parseSessionSlashCommand(text);
			if (command) return { kind: "sessionCommand", text, images, command };
		}

		if (text.startsWith("/")) {
			if (policy.extensionCommands === "execute") {
				const completion = this._executeExtensionCommand(text);
				if (completion) return { kind: "extensionCommand", completion };
			} else if (policy.extensionCommands === "reject") {
				this._throwIfExtensionCommand(text);
			}
		}

		if (policy.inputSource !== undefined && this._extensionRunner.hasHandlers("input")) {
			return this._extensionRunner.emitInput(text, images, policy.inputSource).then((result) => {
				if (result.action === "handled") return { kind: "handled" };
				if (result.action === "transform") {
					return this._finishSubmissionNormalization(result.text, result.images ?? images, policy);
				}
				return this._finishSubmissionNormalization(text, images, policy);
			});
		}

		return this._finishSubmissionNormalization(text, images, policy);
	}

	private async _runPreTurnCompaction(): Promise<void> {
		if (this._pendingAvoCanonicalDelivery()) return;
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false, false);
	}

	private async _prepareForCommit<TPrepared, TCommitted>(
		policy: CommitPreparationPolicy,
		steps: CommitPreparationSteps<TPrepared, TCommitted>,
	): Promise<TCommitted | undefined> {
		if (
			!this._pendingAvoCanonicalDelivery() &&
			(policy.initialRefineBarrier === "always" ||
				(policy.initialRefineBarrier === "ifInFlight" && this._refineInFlight))
		) {
			await this._waitForRefineIdle();
		}
		if (policy.flushPendingBashBeforeValidation) this._flushPendingBashMessages();
		if (policy.validateModelAndAuth) await this._validateCanStartAgentRun();
		steps.afterValidation?.();
		if (!policy.flushPendingBashBeforeValidation) this._flushPendingBashMessages();

		if (policy.preTurnCompaction === "beforeModelSelection") await this._runPreTurnCompaction();
		if (policy.awaitPendingModelSelection) {
			const pendingModelSelectEmit = this._pendingModelSelectEmit();
			if (pendingModelSelectEmit) await pendingModelSelectEmit;
		}
		if (policy.preTurnCompaction === "afterModelSelection") await this._runPreTurnCompaction();

		const prepared = await steps.prepare();
		if (steps.shouldCommit && !steps.shouldCommit(prepared)) return undefined;
		steps.beforeFinalRefineBarrier?.(prepared);
		let passedFinalRefineBarrier = false;
		if (
			!this._pendingAvoCanonicalDelivery() &&
			(policy.finalRefineBarrier === "always" ||
				(policy.finalRefineBarrier === "ifInFlight" && this._refineInFlight))
		) {
			await this._waitForRefineIdle();
			passedFinalRefineBarrier = true;
		}
		return steps.commit(prepared, passedFinalRefineBarrier);
	}

	private _applyPreparedSystemPrompt(
		preparation: PreparedPromptPreparation | undefined,
		preserveEmptyExtensionPrompt: boolean,
	): void {
		const extensionPrompt = preparation?.result?.systemPrompt;
		const hasExtensionPrompt = preserveEmptyExtensionPrompt
			? extensionPrompt !== undefined
			: Boolean(extensionPrompt);
		this.agent.state.systemPrompt =
			hasExtensionPrompt && extensionPrompt !== undefined && preparation !== undefined
				? this._refreshExtensionSystemPrompt(extensionPrompt, preparation.basePromptSnapshot)
				: this._baseSystemPrompt;
	}

	private _canStartSessionActionImmediately(): boolean {
		return (
			!this.isStreaming &&
			!this.isCompacting &&
			!this.isRetrying &&
			!this.isBashRunning &&
			!this._sessionInputPumpSuspended &&
			this._queuedWorkPauses.size === 0 &&
			!this._disposed &&
			!this._disposing
		);
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt(text, options);
	}

	async promptUntilAccepted(text: string, options?: PromptOptions): Promise<void> {
		return this._prompt(text, { ...options, returnAfterAccepted: true });
	}

	async promptAndWait(text: string, options?: PromptOptions): Promise<void> {
		const agentMessageId = options?.agentMessageId ?? `prompt-wait:${randomUUID()}`;
		if (this._agentMessageOutcomes.get(agentMessageId)?.completion) {
			throw new Error(`Prompt completion id is already in use: ${agentMessageId}`);
		}
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.completion = createAgentMessageDeferred();
		const completion = outcome.completion.promise;
		const signal = options?.signal;
		let cancelQueuedPrompt: (() => void) | undefined;
		try {
			await this.promptUntilAccepted(text, { ...options, agentMessageId });
			if (signal) {
				cancelQueuedPrompt = () => {
					const error = new Error("Prompt was cancelled before it started.");
					const cancelled = this._cancelSessionActions(
						(action) => action.agentMessageId === agentMessageId && action.payload.kind === "turn",
						error,
					);
					if (cancelled.length > 0) {
						this._settleAgentMessage(agentMessageId, "completion", error);
					}
				};
				signal.addEventListener("abort", cancelQueuedPrompt, { once: true });
				if (signal.aborted) cancelQueuedPrompt();
			}
			await completion;
		} catch (error) {
			this._settleAgentMessage(agentMessageId, "completion", this._asError(error));
			throw error;
		} finally {
			if (signal && cancelQueuedPrompt) {
				signal.removeEventListener("abort", cancelQueuedPrompt);
			}
		}
	}

	async acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void> {
		const customMessage =
			options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined;
		await this._prompt(text, {
			...options,
			resumeIfIdle: false,
			expandPromptTemplates: false,
			skipInputHandlers: true,
			skipPrePromptWork: true,
			returnAfterAccepted: true,
			agentMessageId: options?.agentMessageId ?? customMessage?.details.id ?? parseAgentSessionMessagePromptId(text),
			customMessage,
		});
		if (customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
	}

	async queueAgentMessagePrompt(
		text: string,
		streamingBehavior: "steer" | "followUp",
		customMessage?: AgentSessionMessage,
	): Promise<boolean> {
		const agentMessageId = customMessage?.details.id ?? parseAgentSessionMessagePromptId(text);
		if (streamingBehavior === "steer") {
			await this._queuePreparedPrompt("steer", text, undefined, {
				agentMessageId,
				message: customMessage,
			});
			if (customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
			return true;
		}
		const queued = await this._queuePreparedPrompt("followUp", text, undefined, {
			agentMessageId,
			message: customMessage,
		});
		if (queued && customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
		return queued;
	}

	async promptHeartbeat(job: AgentCronJob, options?: PromptOptions): Promise<void> {
		const message = createHeartbeatPromptMessage(job);
		await this._promptInjectedMessage(job.prompt, message, {
			...options,
			followUpQueueKey: options?.followUpQueueKey ?? `heartbeat:${job.id}`,
			resumeIfIdle: true,
		});
	}

	private _isRlmTerminalNotice(message: CustomMessage): boolean {
		return (
			message.customType === RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE ||
			message.customType === RLM_CHILD_FAILURE_CUSTOM_TYPE
		);
	}

	private _assertRlmTerminalNotice(message: CustomMessage): void {
		if (!this._isRlmTerminalNotice(message)) {
			throw new Error("Deferred terminal admission only accepts RLM child terminal notices.");
		}
	}

	private _isRlmTerminalNoticeAction(action: QueuedSessionAction): boolean {
		if (action.payload.kind !== "turn") return false;
		const message = primaryDeliveryRecord(action).message;
		return message.role === "custom" && this._isRlmTerminalNotice(message);
	}

	private _hasDeferredRlmTerminalNotices(): boolean {
		return this._pendingNextTurnMessages.some((message) => this._isRlmTerminalNotice(message));
	}

	private _enqueueRlmTerminalNoticeAction(message: CustomMessage): void {
		this._assertRlmTerminalNotice(message);
		const action = this._createPreparedTurnAction("followUp", message.content as string, undefined, {
			message,
			suppressAutonomousContinuation: true,
			resumeIfIdle: false,
			source: "internal",
			executionPolicy: this._turnExecutionPolicy("injected"),
			queueVisible: false,
		});
		this._durableRlmTerminalNoticeActionIds.add(action.id);
		try {
			const result = this._admitSessionInput(action, { wake: false });
			if (!result.accepted) throw new Error("RLM child terminal notice was not admitted.");
		} catch (error) {
			this._durableRlmTerminalNoticeActionIds.delete(action.id);
			throw error;
		}
	}

	private _flushDeferredRlmTerminalNotices(): void {
		if (
			this._sessionInputAdmissionPauses.size > 0 ||
			this._sessionInputPumpSuspended ||
			this._queuedWorkPauses.size > 0 ||
			this._disposed ||
			this._disposing
		) {
			return;
		}
		while (true) {
			const index = this._pendingNextTurnMessages.findIndex((message) => this._isRlmTerminalNotice(message));
			if (index < 0) break;
			const message = this._pendingNextTurnMessages[index];
			try {
				this._enqueueRlmTerminalNoticeAction(message);
			} catch {
				return;
			}
			this._pendingNextTurnMessages.splice(index, 1);
		}
		this._scheduleSessionInputPump();
	}

	private async _acquireRlmTerminalNoticeRetentionFence(): Promise<{ owner: symbol; release(): void } | undefined> {
		const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
		while (!this._disposed && !this._disposing && !disposeSignal.aborted) {
			if (this._queuedWorkPauses.size > 0) {
				let wake = () => {};
				const pauseReleased = new Promise<void>((resolve) => {
					wake = resolve;
					this._sessionInputCheckpointWaiters.add(resolve);
				});
				try {
					await waitForPromiseOrAbort(pauseReleased, disposeSignal, "Terminal notice retention cancelled");
				} catch {
					return undefined;
				} finally {
					this._sessionInputCheckpointWaiters.delete(wake);
				}
				continue;
			}
			let fence: { owner: symbol; release(): void };
			try {
				fence = await this._acquireSessionActionCommitFence(disposeSignal);
			} catch {
				return undefined;
			}
			if (this._queuedWorkPauses.size === 0 && !this._disposed && !this._disposing) return fence;
			fence.release();
		}
		return undefined;
	}

	private async _deferRlmTerminalNotice(message: CustomMessage): Promise<void> {
		this._assertRlmTerminalNotice(message);
		const fence = await this._acquireRlmTerminalNoticeRetentionFence();
		if (!fence) return;
		try {
			if (this._disposed || this._disposing) return;
			this._pendingNextTurnMessages.push(cloneCustomMessage(message));
			this._flushDeferredRlmTerminalNotices();
		} finally {
			fence.release();
		}
	}

	private _demoteRlmTerminalNoticeActions(): void {
		const actions = this._actionStore
			.clearableActions()
			.filter((action) => this._durableRlmTerminalNoticeActionIds.has(action.id));
		if (actions.length === 0) return;
		for (const action of actions) {
			if (!this._isRlmTerminalNoticeAction(action)) continue;
			const message = primaryDeliveryRecord(action).message;
			if (message.role === "custom") this._pendingNextTurnMessages.push(cloneCustomMessage(message));
		}
		const ids = new Set(actions.map((action) => action.id));
		this._cancelSessionActions(
			(action) => ids.has(action.id),
			new Error("RLM child terminal notice deferred across session input suspension."),
			actions,
		);
		for (const id of ids) this._durableRlmTerminalNoticeActionIds.delete(id);
	}

	private async _promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options?: InternalPromptOptions & { executionPolicy?: TurnExecutionPolicy },
	): Promise<void> {
		if (!this.isStreaming && options?.resumeIfIdle) this._resumeSessionInputAdmission();
		const admissionEpoch = this._sessionInputPumpEpoch;
		const admissionFence = await this._acquireDirectTurnAdmissionFence(options?.signal).catch((error: unknown) => {
			throwIfPromptAdmissionCancelled(options?.signal);
			throw error;
		});
		const reportPreflight = oncePreflight(options?.preflightResult);
		try {
			throwIfPromptAdmissionCancelled(options?.signal);
			if (admissionEpoch !== this._sessionInputPumpEpoch) {
				throw new Error("Injected session input was invalidated before admission");
			}
			options?.admissionCommitted?.();
			const queueForStreaming = this.isStreaming;
			const queueForBusy = options?.queueIfBusy === true && this._isBusyForSessionInput("preflight");
			const visibleQueued = queueForStreaming || queueForBusy;
			if (visibleQueued && !options?.streamingBehavior) {
				const stateDescription = queueForStreaming ? "Agent is already processing" : "Agent has queued work";
				throw new Error(
					`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
				);
			}
			const schedule = options?.streamingBehavior ?? "followUp";
			const prefixMessages = visibleQueued ? this._takePendingNextTurnMessages() : undefined;
			const action = this._createPreparedTurnAction(schedule, text, undefined, {
				message,
				prefixMessages,
				queueKey: options?.followUpQueueKey,
				previewLabel: injectedMessagePreviewLabel(message),
				suppressAutonomousContinuation: options?.suppressAutonomousContinuation,
				resumeIfIdle:
					!visibleQueued ||
					options?.resumeIfIdle ||
					(options?.queueIfBusy === true && canSelectSessionAction(this._runtimeActivity())),
				source: options?.source ?? "internal",
				executionPolicy:
					options?.executionPolicy ??
					(visibleQueued ? this._turnExecutionPolicy("queued") : this._turnExecutionPolicy("injected")),
				queueVisible: visibleQueued,
			});
			const result = this._admitSessionInput(action, {
				immediatelyEligible: !visibleQueued,
			});
			admissionFence.release();
			if (!result.accepted || !result.ticket) {
				if (prefixMessages) this._pendingNextTurnMessages.unshift(...prefixMessages);
				reportPreflight(false, false);
				return;
			}
			if (result.disposition === "queued") {
				reportPreflight(true, true);
			} else {
				void result.ticket.delivered.then(
					() => reportPreflight(true),
					() => reportPreflight(false),
				);
			}
			if (options?.returnAfterAccepted) {
				if (result.disposition === "starts_when_admitted") await result.ticket.delivered;
				return;
			}
			if (visibleQueued) return;
			await result.ticket.completed;
		} catch (error) {
			reportPreflight(false);
			throw error;
		} finally {
			admissionFence.release();
		}
	}

	private async _prompt(text: string, options?: InternalPromptOptions): Promise<void> {
		const resumeSuspendedInput = options?.resumeIfIdle !== false;
		if (!this.isStreaming) {
			if (resumeSuspendedInput) this._resumeSessionInputAdmission();
			this._assertSessionActionAdmissionAvailable();
		}
		const admissionEpoch = this._sessionInputPumpEpoch;
		const commitFence = this.isStreaming
			? undefined
			: await this._acquireDirectTurnAdmissionFence(options?.signal).catch((error: unknown) => {
					throwIfPromptAdmissionCancelled(options?.signal);
					throw error;
				});
		const reportPreflight = oncePreflight(options?.preflightResult);
		const run = async () => {
			try {
				throwIfPromptAdmissionCancelled(options?.signal);
				if (!resumeSuspendedInput && admissionEpoch !== this._sessionInputPumpEpoch) {
					throw new Error("Session input was invalidated before admission");
				}
				options?.admissionCommitted?.();
				const isInternalPrompt = options?.internalPrompt === true;
				const expandPromptTemplates = isInternalPrompt ? false : (options?.expandPromptTemplates ?? true);
				const normalizationResult = this._normalizeSubmission(text, options?.images, {
					parseSessionCommands: !isInternalPrompt && !options?.skipPrePromptWork,
					extensionCommands: expandPromptTemplates ? "execute" : "ignore",
					inputSource:
						!isInternalPrompt && !options?.skipInputHandlers ? (options?.source ?? "interactive") : undefined,
					expandSkills: expandPromptTemplates,
					expandPromptTemplates,
				});
				const normalized = normalizationResult instanceof Promise ? await normalizationResult : normalizationResult;
				if (normalized.kind === "extensionCommand") {
					commitFence?.release();
					reportPreflight(true);
					void normalized.completion.then(
						() => this._settleAgentMessage(options?.agentMessageId, "completion"),
						(error) => this._settleAgentMessage(options?.agentMessageId, "completion", error),
					);
					void normalized.completion.catch(() => undefined);
					if (!options?.returnAfterAccepted) await normalized.completion.catch(() => undefined);
					return;
				}
				if (normalized.kind === "handled") {
					commitFence?.release();
					reportPreflight(true);
					this._settleAgentMessage(options?.agentMessageId, "completion");
					return;
				}

				const pendingOwnedWork = this._actionStore.unfinishedActions().length > 0;
				const wasRuntimeBusy = this.isStreaming || this.isCompacting || this.isRetrying || this.isBashRunning;
				const wasBusy = wasRuntimeBusy || pendingOwnedWork;
				if (normalized.kind === "sessionCommand") {
					const schedule = options?.streamingBehavior ?? (this.isStreaming ? "steer" : "followUp");
					const action = this._createSessionCommandAction(
						normalized.text,
						normalized.command,
						normalized.images,
						schedule,
						{
							agentMessageId: options?.agentMessageId,
							source: isInternalPrompt ? "internal" : (options?.source ?? "interactive"),
						},
					);
					const result = this._admitSessionInput(action, {
						immediatelyEligible: !wasBusy && this._canStartSessionActionImmediately(),
					});
					commitFence?.release();
					reportPreflight(result.accepted, result.disposition === "queued");
					if (!result.accepted || !result.ticket) return;
					if (options?.returnAfterAccepted) {
						if (result.disposition === "starts_when_admitted") await result.ticket.delivered;
						return;
					}
					if (result.disposition === "queued") return;
					await this.waitForSessionInputIdle();
					return;
				}

				const canonicalDeliveryPending = this._pendingAvoCanonicalDelivery() !== undefined;
				if (canonicalDeliveryPending) {
					await this._ensurePersistedAvoCanonicalDeliveryAction();
					this._scheduleSessionInputPump();
				}
				const queueForStreaming = this.isStreaming;
				const queueForBusy = options?.queueIfBusy === true && this._isBusyForSessionInput("preflight");
				// A persisted pending delivery owns the next provider turn even after a
				// process restart. Genuine user work is retained behind it and starts a
				// fresh AVO run only after canonical delivery terminates.
				const visibleQueued = queueForStreaming || queueForBusy || canonicalDeliveryPending;
				if (visibleQueued && !canonicalDeliveryPending && !options?.streamingBehavior) {
					const stateDescription = queueForStreaming ? "Agent is already processing" : "Agent has queued work";
					throw new Error(
						`${stateDescription}. Specify streamingBehavior ('steer' or 'followUp') to queue the message.`,
					);
				}
				const schedule = options?.streamingBehavior ?? "followUp";
				const prefixMessages = visibleQueued ? this._takePendingNextTurnMessages() : undefined;
				let avoObservedRunId: string | undefined;
				if (!visibleQueued && !isInternalPrompt && options?.skipPrePromptWork !== true && this._avoRuntime) {
					this._avoRuntime.observeRootPrompt(normalized.text);
					avoObservedRunId = this._avoRuntime.getState().runId;
					this._ensureAvoCodingVerificationBaseline();
					this._ensureAvoArtifactVerificationBaseline();
					this._primeAvoProgressWatchdog();
					await this._refreshAvoMemoryContext(normalized.text);
					this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
					this.agent.state.systemPrompt = this._baseSystemPrompt;
				}
				const content = options?.content
					? options.content.map((block) => ({ ...block }))
					: this._buildPromptContent(normalized.text, normalized.images);
				const suppliedMessage = options?.customMessage;
				const primaryMessage = suppliedMessage
					? visibleQueued
						? suppliedMessage
						: cloneCustomMessage(suppliedMessage)
					: ({
							role: "user",
							content: content.map((block) => ({ ...block })),
							timestamp: Date.now(),
						} satisfies UserMessage);
				const acceptedAgentMessage = options?.skipPrePromptWork === true && options.returnAfterAccepted === true;
				const action = this._createPreparedTurnAction(schedule, normalized.text, normalized.images, {
					agentMessageId: options?.agentMessageId,
					queueKey: options?.followUpQueueKey,
					content,
					message: primaryMessage,
					prefixMessages,
					suppressAutonomousContinuation: options?.suppressAutonomousContinuation,
					resumeIfIdle:
						!visibleQueued ||
						options?.resumeIfIdle ||
						(options?.queueIfBusy === true && canSelectSessionAction(this._runtimeActivity())),
					source: isInternalPrompt ? "internal" : (options?.source ?? "interactive"),
					executionPolicy: visibleQueued
						? this._turnExecutionPolicy("queued")
						: this._turnExecutionPolicy("directPrompt", {
								returnAfterAccepted: options?.returnAfterAccepted,
								skipPrePromptWork: options?.skipPrePromptWork,
							}),
					queueVisible: visibleQueued,
					acceptedAgentMessage,
					acceptedBeforeCompletion: options?.returnAfterAccepted === true,
					avoObservedRunId,
				});
				if (action.suppressAutonomousContinuation) {
					this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
				}
				const result = this._admitSessionInput(action, {
					immediatelyEligible: !visibleQueued && this._canStartSessionActionImmediately(),
				});
				commitFence?.release();
				if (!result.accepted || !result.ticket) {
					if (prefixMessages) this._pendingNextTurnMessages.unshift(...prefixMessages);
					reportPreflight(false, false);
					return;
				}
				if (result.disposition === "queued") {
					reportPreflight(true, true);
				} else {
					void result.ticket.delivered.then(
						() => reportPreflight(true),
						() => reportPreflight(false),
					);
				}
				const deferralObserver =
					acceptedAgentMessage &&
					options?.queueIfBusy === true &&
					!options.streamingBehavior &&
					result.disposition === "starts_when_admitted"
						? this._observeSessionActionDeferral(action)
						: undefined;
				if (acceptedAgentMessage && !queueForStreaming && !queueForBusy && !options?.streamingBehavior) {
					try {
						const outcome = deferralObserver
							? await Promise.race([
									result.ticket.delivered.then(() => "delivered" as const),
									deferralObserver.deferred.then(() => "deferred" as const),
								])
							: await result.ticket.delivered.then(() => "delivered" as const);
						if (outcome === "deferred" && !options?.streamingBehavior) {
							const error = new Error(
								"Agent became busy before prompt delivery. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
							);
							this._rejectAgentMessage(action.agentMessageId, error);
							this._cancelSessionActions((candidate) => candidate === action, error);
							this._emitQueueUpdate();
							throw error;
						}
						return;
					} finally {
						deferralObserver?.stop();
					}
				}
				if (options?.returnAfterAccepted) {
					if (result.disposition === "starts_when_admitted" || (acceptedAgentMessage && !visibleQueued)) {
						await result.ticket.delivered;
					}
					return;
				}
				if (visibleQueued) return;
				await result.ticket.completed;
				await this.waitForSessionInputIdle();
			} catch (error) {
				reportPreflight(false);
				throw error;
			} finally {
				commitFence?.release();
			}
		};
		return commitFence ? this._sessionActionCommitContext.run(commitFence.owner, run) : run();
	}

	private _executeExtensionCommand(text: string): Promise<void> | undefined {
		const parsed = parseSlashCommand(text);
		if (!parsed) return undefined;
		const commandName = parsed.name;
		const args = parsed.args;

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return undefined;
		const context = this._extensionRunner.createCommandContext();
		return Promise.resolve()
			.then(() => command.handler(args, context))

			.catch((error: unknown) => {
				const commandError = error instanceof Error ? error : new Error(String(error));
				this._extensionRunner.emitError({
					extensionPath: `command:${commandName}`,
					event: "command",
					error: commandError.message,
				});
				throw commandError;
			});
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const parsed = parseSlashCommand(text);
		if (!parsed?.name.startsWith("skill:")) return text;
		const skillName = parsed.name.slice("skill:".length);
		const args = parsed.args;

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<void> {
		const normalized = this._normalizeSubmission(text, images, {
			parseSessionCommands: false,
			extensionCommands: "reject",
			expandSkills: true,
			expandPromptTemplates: true,
		});
		if (normalized instanceof Promise || normalized.kind !== "prompt") {
			throw new Error("Queued prompt normalization did not produce a prompt");
		}

		await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			resumeIfIdle?: boolean;
		} = {},
	): Promise<boolean> {
		const normalized = this._normalizeSubmission(text, images, {
			parseSessionCommands: false,
			extensionCommands: "reject",
			expandSkills: true,
			expandPromptTemplates: true,
		});
		if (normalized instanceof Promise || normalized.kind !== "prompt") {
			throw new Error("Queued prompt normalization did not produce a prompt");
		}

		return this._queuePreparedPrompt("followUp", normalized.text, normalized.images, {
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			resumeIfIdle: options.resumeIfIdle,
		});
	}

	async restoreSessionActions(snapshot: SessionActionRecoverySnapshot): Promise<number> {
		if (snapshot.formatVersion !== SESSION_ACTION_RECOVERY_FORMAT_VERSION) {
			throw new Error(`Unsupported session action recovery format version: ${snapshot.formatVersion}`);
		}
		const actionIds = new Set(this._actionStore.ownedActions().map((action) => action.id));
		const avoState = this._rlmDepth === 0 ? this._avoRuntime?.getState() : undefined;
		const closeRecoveredInternalWork =
			avoState !== undefined &&
			(avoState.delivery.phase === "pending" ||
				avoState.delivery.phase === "delivered" ||
				avoState.delivery.phase === "failed" ||
				avoState.status === "completed" ||
				avoState.status === "failed");
		const recoverableActions = closeRecoveredInternalWork
			? snapshot.actions.filter((action) => action.source !== "internal")
			: snapshot.actions;
		const actions = recoverableActions.map((recovered): QueuedSessionAction => {
			if (actionIds.has(recovered.id)) throw new Error(`Duplicate session action id: ${recovered.id}`);
			actionIds.add(recovered.id);
			if (
				recovered.payload.kind === "turn" &&
				recovered.payload.records.some((record) => record.ownerActionId !== recovered.id)
			) {
				throw new Error(`Session action ${recovered.id} has invalid delivery correlation`);
			}
			const payload: PreparedTurnPayload | PreparedCommandPayload =
				recovered.payload.kind === "turn"
					? {
							kind: "turn",
							text: recovered.payload.text,
							...(recovered.payload.preview ? { preview: recovered.payload.preview } : {}),
							records: recovered.payload.records.map((record) => ({
								id: record.id,
								role: record.role,
								message: cloneQueuedAgentMessage(record.message),
								started: false,
								durable: false,
								ownerActionId: record.ownerActionId,
							})),
							...(recovered.payload.images
								? {
										images: recovered.payload.images.map((image) => ({
											...image,
										})),
									}
								: {}),
							...(recovered.payload.content
								? {
										content: recovered.payload.content.map((block) => ({
											...block,
										})),
									}
								: {}),
							...(recovered.payload.customMessage
								? {
										customMessage: cloneCustomMessage(recovered.payload.customMessage),
									}
								: {}),
							executionPolicy: {
								...recovered.payload.executionPolicy,
								preparation: {
									...recovered.payload.executionPolicy.preparation,
								},
							},
							queueVisible: recovered.payload.queueVisible,
							acceptedAgentMessage: recovered.payload.acceptedAgentMessage,
							acceptedBeforeCompletion: recovered.payload.acceptedBeforeCompletion,
							...(recovered.payload.avoObservedRunId
								? { avoObservedRunId: recovered.payload.avoObservedRunId }
								: {}),
						}
					: {
							kind: "session_command",
							text: recovered.payload.text,
							command: { ...recovered.payload.command },
							...(recovered.payload.images
								? {
										images: recovered.payload.images.map((image) => ({
											...image,
										})),
									}
								: {}),
						};
			return {
				id: recovered.id,
				source: recovered.source,
				delivery: recovered.delivery,
				wake: recovered.wake,
				payload,
				lifecycle: { state: "queued" },
				...(recovered.queueKey ? { queueKey: recovered.queueKey } : {}),
				...(recovered.agentMessageId ? { agentMessageId: recovered.agentMessageId } : {}),
				...(recovered.suppressAutonomousContinuation ? { suppressAutonomousContinuation: true } : {}),
			};
		});
		for (const action of actions) {
			const durableTerminalNotice = this._isRlmTerminalNoticeAction(action);
			if (durableTerminalNotice) this._durableRlmTerminalNoticeActionIds.add(action.id);
			try {
				this._admitSessionInput(action, { restore: true });
			} catch (error) {
				if (durableTerminalNotice) this._durableRlmTerminalNoticeActionIds.delete(action.id);
				throw error;
			}
		}
		return actions.length;
	}

	private _restoreSessionCommand(
		text: string,
		customMessage: CustomMessage | undefined,
		images: ImageContent[] | undefined,
		schedule: SessionInputSchedule,
		agentMessageId: string | undefined,
	): boolean | undefined {
		if (!isSessionSlashCommandMessage(customMessage) || text !== customMessage.details.command.text) {
			return undefined;
		}
		return this._admitSessionInput(
			this._createSessionCommandAction(text, customMessage.details.command, images, schedule, {
				agentMessageId,
				source: "internal",
			}),
			{ restore: true },
		).accepted;
	}

	private _restorePromptInput(schedule: SessionInputSchedule, snapshot: RestoredPromptInput): Promise<boolean> {
		return this._queuePreparedPrompt(schedule, snapshot.text, snapshot.images, {
			queueKey: snapshot.queueKey,
			agentMessageId: snapshot.agentMessageId,
			content: snapshot.content,
			message: snapshot.customMessage,
			prefixMessages: snapshot.prefixMessages,
			source: "internal",
		});
	}

	async restoreSteeringMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<void> {
		if (
			this._restoreSessionCommand(text, options.customMessage, images, "steer", options.agentMessageId) !== undefined
		)
			return;

		await this._restorePromptInput("steer", {
			text,
			images,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			customMessage: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	async restoreFollowUpMessage(
		text: string,
		images?: ImageContent[],
		options: {
			queueKey?: string;
			agentMessageId?: string;
			content?: (TextContent | ImageContent)[];
			customMessage?: CustomMessage;
			prefixMessages?: CustomMessage[];
		} = {},
	): Promise<boolean> {
		const restoredCommand = this._restoreSessionCommand(
			text,
			options.customMessage,
			images,
			"followUp",
			options.agentMessageId,
		);
		if (restoredCommand !== undefined) return restoredCommand;

		return this._restorePromptInput("followUp", {
			text,
			images,
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			content: options.content,
			customMessage: options.customMessage,
			prefixMessages: options.prefixMessages,
		});
	}

	private _buildPromptContent(text: string, images?: ImageContent[]): (TextContent | ImageContent)[] {
		const content: (TextContent | ImageContent)[] = [];
		content.push({ type: "text", text });
		if (images) content.push(...images);
		return content;
	}

	private _takePendingNextTurnMessages(): CustomMessage[] {
		const messages = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		return messages;
	}

	private _deliveryPolicy(schedule: SessionInputSchedule): DeliveryPolicy {
		return schedule === "steer" ? "next_turn_boundary" : "when_run_idle";
	}

	private _createDeliveryRecord(
		actionId: string,
		role: DeliveryRecord["role"],
		message: QueuedAgentMessage,
	): DeliveryRecord {
		return {
			id: randomUUID(),
			role,
			message,
			started: false,
			durable: false,
			ownerActionId: actionId,
		};
	}

	private _turnExecutionPolicy(
		kind: "queued" | "directPrompt" | "injected" | "customTrigger",
		options: {
			returnAfterAccepted?: boolean;
			skipPrePromptWork?: boolean;
		} = {},
	): TurnExecutionPolicy {
		if (kind === "queued") {
			return {
				preparation: {
					initialRefineBarrier: "skip",
					flushPendingBashBeforeValidation: false,
					validateModelAndAuth: true,
					awaitPendingModelSelection: true,
					preTurnCompaction: "beforeModelSelection",
					finalRefineBarrier: "always",
				},
				runBeforeAgentStart: true,
				nextTurnContextTiming: "commit",
				preserveEmptyExtensionPrompt: true,
				completionIncludesRetryChain: true,
			};
		}
		if (kind === "directPrompt") {
			return {
				preparation: {
					initialRefineBarrier: options.returnAfterAccepted ? "skip" : "always",
					flushPendingBashBeforeValidation: true,
					validateModelAndAuth: true,
					awaitPendingModelSelection: true,
					preTurnCompaction: options.skipPrePromptWork ? "skip" : "afterModelSelection",
					finalRefineBarrier: "ifInFlight",
				},
				runBeforeAgentStart: !options.skipPrePromptWork,
				nextTurnContextTiming: "preparation",
				preserveEmptyExtensionPrompt: false,
				completionIncludesRetryChain: true,
			};
		}
		if (kind === "injected") {
			return {
				preparation: {
					initialRefineBarrier: "always",
					flushPendingBashBeforeValidation: true,
					validateModelAndAuth: true,
					awaitPendingModelSelection: true,
					preTurnCompaction: "beforeModelSelection",
					finalRefineBarrier: "ifInFlight",
				},
				runBeforeAgentStart: true,
				nextTurnContextTiming: "preparation",
				preserveEmptyExtensionPrompt: true,
				completionIncludesRetryChain: true,
			};
		}
		return {
			preparation: {
				initialRefineBarrier: "always",
				flushPendingBashBeforeValidation: false,
				validateModelAndAuth: false,
				awaitPendingModelSelection: false,
				preTurnCompaction: "skip",
				finalRefineBarrier: "skip",
			},
			runBeforeAgentStart: false,
			nextTurnContextTiming: "skip",
			preserveEmptyExtensionPrompt: false,
			completionIncludesRetryChain: false,
		};
	}

	private _createPreparedTurnAction(
		schedule: SessionInputSchedule,
		text: string,
		images: ImageContent[] | undefined,
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
			source?: InputSource | "internal";
			executionPolicy?: TurnExecutionPolicy;
			queueVisible?: boolean;
			acceptedAgentMessage?: boolean;
			acceptedBeforeCompletion?: boolean;
			avoObservedRunId?: string;
		},
	): QueuedSessionAction {
		const id = randomUUID();
		const content = options.content ?? this._buildPromptContent(text, images);
		const message =
			options.message ??
			({
				role: "user",
				content: content.map((block) => ({ ...block })),
				timestamp: Date.now(),
			} satisfies UserMessage);
		const prefixMessages = options.prefixMessages?.map((prefix) => cloneCustomMessage(prefix)) ?? [];
		const preview = options.previewLabel ? `${options.previewLabel}: ${text}` : undefined;
		const payload: PreparedTurnPayload = {
			kind: "turn",
			text,
			records: [
				...prefixMessages.map((prefix) => this._createDeliveryRecord(id, "prefix", prefix)),
				this._createDeliveryRecord(id, "primary", message),
			],
			preview,
			images: images?.map((image) => ({ ...image })),
			content: content.map((block) => ({ ...block })),
			customMessage: options.message?.role === "custom" ? cloneCustomMessage(options.message) : undefined,
			executionPolicy: options.executionPolicy ?? this._turnExecutionPolicy("queued"),
			queueVisible: options.queueVisible ?? true,
			acceptedAgentMessage: options.acceptedAgentMessage ?? false,
			acceptedBeforeCompletion: options.acceptedBeforeCompletion ?? false,
			...(options.avoObservedRunId ? { avoObservedRunId: options.avoObservedRunId } : {}),
		};
		return {
			id,
			source: options.source ?? "internal",
			delivery: this._deliveryPolicy(schedule),
			wake:
				options.resumeIfIdle === true
					? "immediate"
					: schedule === "steer"
						? "on_lower_boundary"
						: "external_resume",
			payload,
			lifecycle: { state: "queued" },
			queueKey: options.queueKey,
			agentMessageId: options.agentMessageId,
			suppressAutonomousContinuation: options.suppressAutonomousContinuation,
		};
	}

	private _createSessionCommandAction(
		text: string,
		command: SessionSlashCommand,
		images: ImageContent[] | undefined,
		schedule: SessionInputSchedule,
		options: {
			agentMessageId?: string;
			source?: InputSource | "internal";
		} = {},
	): QueuedSessionAction {
		return {
			id: randomUUID(),
			source: options.source ?? "internal",
			delivery: this._deliveryPolicy(schedule),
			wake: "immediate",
			payload: { kind: "session_command", text, command, images },
			lifecycle: { state: "queued" },
			agentMessageId: options.agentMessageId,
		};
	}

	private _coalescedFollowUpOwner(action: QueuedSessionAction): QueuedSessionAction | undefined {
		if (action.delivery !== "when_run_idle" || action.payload.kind !== "turn" || !action.queueKey) return undefined;
		return this._actionStore
			.unfinishedActions()
			.find(
				(candidate) =>
					candidate.queueKey === action.queueKey &&
					(candidate.lifecycle.state === "queued" ||
						candidate.lifecycle.state === "selected" ||
						candidate.lifecycle.state === "preparing"),
			);
	}

	private _assertSessionActionAdmissionAvailable(): void {
		if (this._disposed || this._disposing) {
			throw new Error("Cannot admit a session action because the session is disposing or disposed.");
		}
		if (this._sessionInputAdmissionPauses.size > 0) {
			throw new Error("Cannot admit a session action while session input admission is paused.");
		}
		if (this._sessionInputPumpSuspended) {
			throw new Error("Cannot admit a session action while queued session input is suspended.");
		}
	}

	private _admitSessionInput(
		action: QueuedSessionAction,
		options: {
			restore?: boolean;
			front?: boolean;
			wake?: boolean;
			immediatelyEligible?: boolean;
		} = {},
	): {
		accepted: boolean;
		disposition: "starts_when_admitted" | "queued";
		ticket?: ActionTicket;
	} {
		if (this._disposed || this._disposing) {
			throw new Error("Cannot admit a session action because the session is disposing or disposed.");
		}
		if (this._sessionInputAdmissionPauses.size > 0) {
			throw new Error("Cannot admit a session action while session input admission is paused.");
		}
		if (action.source === "internal" && this._rlmDepth === 0 && this._avoRuntime) {
			const state = this._avoRuntime.getState();
			const pending = state.status === "active" && state.delivery.phase === "pending";
			const terminal =
				state.delivery.phase === "delivered" ||
				state.delivery.phase === "failed" ||
				state.status === "completed" ||
				state.status === "failed";
			if ((pending && !this._isAvoCanonicalDeliveryAction(action)) || terminal) {
				throw new Error(
					`Cannot admit internal session work while AVO canonical delivery phase=${state.delivery.phase}.`,
				);
			}
		}
		const coalescedOwner = options.restore ? undefined : this._coalescedFollowUpOwner(action);
		if (coalescedOwner) {
			if (action.agentMessageId !== coalescedOwner.agentMessageId) {
				this._rejectAgentMessage(
					action.agentMessageId,
					new Error("Prompt was not queued because an equivalent follow-up is already pending."),
				);
			}
			return { accepted: false, disposition: "queued" };
		}
		const canStartImmediately =
			options.immediatelyEligible === true &&
			(this._actionStore.unfinishedActions().length === 0 || options.front === true);
		if (options.front) this._actionStore.enqueueFront(action);
		else this._actionStore.enqueue(action);
		let disposition: "starts_when_admitted" | "queued" = "queued";
		if (canStartImmediately && this._actionStore.selectFirst() === action) disposition = "starts_when_admitted";
		const controller = this._actionStore.ticketFor(action);
		controller.settleAccepted({
			status: "accepted",
			actionId: action.id,
			disposition,
		});
		this._sessionInputArrivalEpoch++;
		this._emitQueueUpdate();
		if (
			!options.restore &&
			options.wake !== false &&
			(disposition === "starts_when_admitted" ||
				(action.delivery === "next_turn_boundary" && this.isStreaming) ||
				action.payload.kind === "session_command" ||
				action.wake === "immediate")
		) {
			if (action.payload.kind === "turn" && action.wake === "immediate") {
				this._resumeSessionInputAdmission();
			}
			this._scheduleSessionInputPump();
		}
		return { accepted: true, disposition, ticket: controller.ticket };
	}

	private async _queuePreparedPrompt(
		schedule: SessionInputSchedule,
		text: string,
		images?: ImageContent[],
		options: {
			agentMessageId?: string;
			queueKey?: string;
			content?: (TextContent | ImageContent)[];
			message?: QueuedAgentMessage;
			prefixMessages?: CustomMessage[];
			previewLabel?: string;
			suppressAutonomousContinuation?: boolean;
			resumeIfIdle?: boolean;
			source?: InputSource | "internal";
			front?: boolean;
			queueVisible?: boolean;
		} = {},
	): Promise<boolean> {
		const action = this._createPreparedTurnAction(schedule, text, images, options);
		if (action.suppressAutonomousContinuation) {
			this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
		}
		return this._admitSessionInput(action, { front: options.front }).accepted;
	}

	private _runtimeActivity(): RuntimeActivity {
		return {
			lowerAgentRun: this.isStreaming,
			compaction: this.isCompacting,
			retry: this.isRetrying,
			bash: this.isBashRunning,
			refinementApply: this._refineInFlight !== undefined,
			branchMutation: this._branchSummaryOperation !== undefined,
			schedulerPauseCount: this._queuedWorkPauses.size + (this._sessionInputPumpSuspended ? 1 : 0),
			disposing: this._disposed || this._disposing,
		};
	}

	private _hasSelectableSessionInput(): boolean {
		return (
			this._actionStore.queuedActions().length > 0 ||
			this._actionStore.activeActions().some((action) => action.lifecycle.state === "selected")
		);
	}

	get hasPendingSessionWork(): boolean {
		return this._actionStore.unfinishedActions().some((action) => {
			const state = action.lifecycle.state;
			return (
				state === "queued" ||
				state === "selected" ||
				state === "preparing" ||
				(state === "committing" && action.payload.kind === "turn" && !primaryDeliveryRecord(action).durable)
			);
		});
	}

	get hasPendingAdmissionWaiters(): boolean {
		return (
			this._sessionActionCommitOwner !== undefined ||
			this._pendingSessionActionFenceWaiters > 0 ||
			this._sessionInputCheckpointWaiters.size > 0
		);
	}

	private _scheduleSessionInputPump(): void {
		if (this._sessionInputPumpSuspended || this._queuedWorkPauses.size > 0) return;
		if (this._disposed || this._disposing || this._sessionInputPumpRequested || !this._hasSelectableSessionInput()) {
			return;
		}
		this._sessionInputPumpRequested = true;
		const epoch = this._sessionInputPumpEpoch;
		const pump = async () => {
			this._sessionInputPumpRequested = false;
			await this._pumpSessionInputs(epoch);
		};
		this._sessionInputPump = this._sessionInputPump.then(pump, pump);
		this._sessionInputPump.catch(() => {});
	}

	private async _pumpSessionInputs(epoch: number): Promise<void> {
		let blocked = false;
		try {
			while (!this._disposed && !this._disposing && this._hasSelectableSessionInput()) {
				await this.agent.waitForIdle();
				let preselected = this._actionStore.activeActions().find((action) => action.lifecycle.state === "selected");
				if (this._pendingAvoCanonicalDelivery()) {
					if (preselected && !this._isAvoCanonicalDeliveryAction(preselected)) {
						this._actionStore.rollback(preselected);
						preselected = undefined;
						this._notifySessionInputCheckpointChange();
						this._emitQueueUpdate();
					}
					await this._ensurePersistedAvoCanonicalDeliveryAction();
					preselected = this._actionStore.activeActions().find((action) => action.lifecycle.state === "selected");
				}
				if (epoch !== this._sessionInputPumpEpoch) {
					if (preselected) {
						this._actionStore.rollback(preselected);
						this._notifySessionInputCheckpointChange();
						this._emitQueueUpdate();
					}
					return;
				}
				if (!this._hasCancelledDispatchCapture()) await this._agentEventQueue;
				if (!preselected || preselected.payload.kind === "session_command") await this._waitForRefineIdle();
				const activity = this._runtimeActivity();
				const canSelectPreselectedTurn =
					preselected?.payload.kind === "turn" && canSelectSessionAction({ ...activity, refinementApply: false });
				if (
					this._isSessionInputHandoffDeferred(epoch) ||
					(!canSelectPreselectedTurn && !canSelectSessionAction(activity))
				) {
					blocked = true;
					this._notifySessionInputCheckpointChange();
					return;
				}
				const first = preselected ?? this._actionStore.selectFirst();
				if (!first) return;
				if (first.payload.kind === "session_command") {
					await this._executeSelectedSessionCommand(first, epoch);
					return;
				}

				const mode = first.delivery === "next_turn_boundary" ? this.steeringMode : this.followUpMode;
				const actions: QueuedSessionAction[] = [first];
				while (!preselected && mode === "all" && !this._pendingAvoCanonicalDelivery()) {
					const next = this._actionStore.queuedActions(first.delivery)[0];
					if (
						!next ||
						next.payload.kind !== "turn" ||
						!turnExecutionPoliciesEqual(first.payload.executionPolicy, next.payload.executionPolicy)
					) {
						break;
					}
					this._actionStore.selectFirst();
					actions.push(next);
				}
				if (epoch !== this._sessionInputPumpEpoch) {
					for (const action of actions) this._actionStore.rollback(action);
					return;
				}
				for (const action of actions) transitionSessionAction(action, { state: "preparing" });
				this._notifySessionInputCheckpointChange();
				this._emitQueueUpdate();
				try {
					await this._startPreparedTurnActions(actions, epoch);
					for (const action of actions) {
						if (action.lifecycle.state === "committing") {
							const primary = primaryDeliveryRecord(action);
							if (this.agent.state.messages.includes(primary.message)) {
								primary.durable = true;
								transitionSessionAction(action, {
									state: "running",
									execution: "agent_turn",
								});
							}
						}
						if (action.lifecycle.state === "running") {
							transitionSessionAction(action, { state: "completed" });
							this._actionStore.ticketFor(action).settleCompleted();
							this._settleAgentMessage(action.agentMessageId, "completion");
						}
					}
				} catch (error) {
					const transcript = this.agent.state.messages;
					const delivered = new Set(transcript);
					const undelivered: QueuedSessionAction[] = [];
					for (const action of actions) {
						if (action.payload.kind !== "turn" || action.lifecycle.state === "cancelled") continue;
						for (const record of action.payload.records) record.durable ||= delivered.has(record.message);
						action.payload.records = action.payload.records.filter((record) => {
							if (record.role === "prefix") return !record.durable;
							if (record.role === "next_turn") return record.durable;
							return true;
						});
						if (!primaryDeliveryRecord(action).durable) undelivered.push(action);
					}
					if (this._isDeferredSessionInputError(error, epoch)) {
						for (const action of undelivered) {
							if (action.lifecycle.state === "committing") {
								this._actionStore.rollback(action, {
									dispatchSettled: true,
									transcript,
								});
							} else if (action.lifecycle.state === "preparing" || action.lifecycle.state === "selected") {
								this._actionStore.rollback(action);
							}
						}
						if (undelivered.length > 0) this._emitQueueUpdate();
						blocked = epoch !== this._sessionInputPumpEpoch || this._isBusyForSessionInput("pump");
						if (blocked) return;
						continue;
					}
					const terminalError = this._asError(error);
					for (const action of actions) {
						if (action.lifecycle.state === "cancelled") continue;
						if (action.lifecycle.state !== "completed" && action.lifecycle.state !== "failed") {
							transitionSessionAction(action, {
								state: "failed",
								error: terminalError,
							});
						}
						const ticket = this._actionStore.ticketFor(action);
						if (undelivered.includes(action)) {
							ticket.rejectDelivered(terminalError);
							this._settleAgentMessage(action.agentMessageId, "delivery", terminalError);
						}
						this._settleAgentMessage(action.agentMessageId, "completion", terminalError);
						ticket.settleCompleted(terminalError);
					}
					if (actions.some((action) => action.payload.kind !== "turn" || action.payload.queueVisible)) {
						this._surfaceSessionInputError(error);
					}
				} finally {
					for (const action of actions) {
						const retainedCancelledDispatch =
							action.lifecycle.state === "cancelled" &&
							action.payload.kind === "turn" &&
							action.payload.captureRunMessages !== undefined;
						if (
							!retainedCancelledDispatch &&
							(action.lifecycle.state === "completed" ||
								action.lifecycle.state === "failed" ||
								action.lifecycle.state === "cancelled")
						) {
							this._durableRlmTerminalNoticeActionIds.delete(action.id);
							this._actionStore.releaseTerminal(action);
						}
					}
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
				}
				if (epoch !== this._sessionInputPumpEpoch || blocked) return;
			}
		} finally {
			if (!blocked && epoch === this._sessionInputPumpEpoch && this._hasSelectableSessionInput()) {
				this._scheduleSessionInputPump();
			}
		}
	}

	private async _executeSelectedSessionCommand(action: QueuedSessionAction, epoch: number): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a selected session command");
		const input = action.payload;
		const commitFence = await this._acquireSessionActionCommitFence();
		try {
			await this._sessionActionCommitContext.run(commitFence.owner, async () => {
				const isCancelled = () => action.lifecycle.state === "cancelled";
				if (isCancelled()) return;
				await this._waitForRefineIdle();
				if (isCancelled()) return;
				if (this._isSessionInputHandoffDeferred(epoch) || !canSelectSessionAction(this._runtimeActivity())) {
					this._actionStore.rollback(action);
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
					return;
				}
				transitionSessionAction(action, {
					state: "running",
					execution: "session_command",
				});
				this._notifySessionInputCheckpointChange();
				this._emitQueueUpdate();
				try {
					this._appendDurableSessionCommandMessage(input.text, input.command, false);
					this._actionStore.ticketFor(action).settleDelivered({ status: "not_applicable" });
					this._settleAgentMessage(action.agentMessageId, "delivery");
					await this._executeQueuedSessionCommand(action);
					transitionSessionAction(action, { state: "completed" });
					this._actionStore.ticketFor(action).settleCompleted();
					this._settleAgentMessage(action.agentMessageId, "completion");
				} catch (error) {
					const commandError = this._asError(error);
					transitionSessionAction(action, {
						state: "failed",
						error: commandError,
					});
					const ticket = this._actionStore.ticketFor(action);
					ticket.rejectDelivered(commandError);
					ticket.settleCompleted(commandError);
					this._rejectAgentMessage(action.agentMessageId, commandError);
				} finally {
					this._actionStore.releaseTerminal(action);
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
				}
			});
		} finally {
			commitFence.release();
		}
	}

	private _isBusyForSessionInput(point: "preflight" | "pump"): boolean {
		const externalBusy = this.isCompacting || this.isRetrying || this.isBashRunning;
		if (point === "pump") {
			return (
				externalBusy ||
				this._disposed ||
				this._disposing ||
				this._sessionInputPumpSuspended ||
				this._queuedWorkPauses.size > 0 ||
				this._branchSummaryOperation !== undefined
			);
		}
		return externalBusy || this._actionStore.unfinishedActions().length > 0;
	}

	private _isSessionInputHandoffDeferred(epoch: number): boolean {
		return epoch !== this._sessionInputPumpEpoch || this._isBusyForSessionInput("pump");
	}

	private _asError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private _isDeferredSessionInputError(error: unknown, epoch: number): boolean {
		if (error instanceof DeferredSessionInputError) return true;
		if (epoch !== this._sessionInputPumpEpoch) return true;
		if (this._isBusyForSessionInput("pump")) {
			this._surfaceSessionInputError(error);
			return true;
		}
		return false;
	}

	private async _prepareAvoQueuedRootTurns(actions: SessionAction<PreparedTurnPayload>[]): Promise<void> {
		if (!this._avoRuntime || this._rlmDepth !== 0) return;
		const rootTurns = actions.filter(
			(action) => !action.payload.acceptedAgentMessage && primaryDeliveryRecord(action).message.role === "user",
		);
		let observed = false;
		for (const action of rootTurns) {
			const state = this._avoRuntime.getState();
			if (state.status === "active" && action.payload.avoObservedRunId === state.runId) continue;
			this._avoRuntime.observeRootPrompt(action.payload.text);
			action.payload.avoObservedRunId = this._avoRuntime.getState().runId;
			observed = true;
		}
		if (!observed) return;
		this._ensureAvoCodingVerificationBaseline();
		this._ensureAvoArtifactVerificationBaseline();
		this._primeAvoProgressWatchdog();
		await this._refreshAvoMemoryContext(rootTurns.map((action) => action.payload.text).join("\n"));
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private _surfaceSessionInputError(error: unknown): void {
		const normalized = this._asError(error);
		try {
			this._extensionRunner.emitError({
				extensionPath: "<session-input>",
				event: "session_input",
				error: normalized.message,
				stack: normalized.stack,
			});
		} catch {
			// Best-effort: a throwing error listener must not break the pump's requeue path.
		}
	}

	private async _startPreparedTurnActions(actions: QueuedSessionAction[], epoch: number): Promise<void> {
		let nextTurnMessages: CustomMessage[] = [];
		const activeTurns = () =>
			actions.filter(
				(action): action is SessionAction<PreparedTurnPayload> =>
					action.payload.kind === "turn" && action.lifecycle.state === "preparing",
			);
		const firstTurn = activeTurns()[0];
		if (!firstTurn) return;
		await this._prepareAvoQueuedRootTurns(activeTurns());
		const executionPolicy = firstTurn.payload.executionPolicy;
		const restoreNextTurnContext = () => {
			this._pendingNextTurnMessages.unshift(...nextTurnMessages);
			nextTurnMessages = [];
		};
		try {
			const preparedTurn = await this._prepareForCommit(executionPolicy.preparation, {
				afterValidation: () => {
					if (this._isSessionInputHandoffDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before preflight");
					}
				},
				prepare: async () => {
					if (executionPolicy.nextTurnContextTiming === "preparation") {
						nextTurnMessages = this._takePendingNextTurnMessages();
					}
					if (!executionPolicy.runBeforeAgentStart) return undefined;
					while (activeTurns().some((action) => action.payload.prepared === undefined)) {
						if (this._isSessionInputHandoffDeferred(epoch)) {
							throw new DeferredSessionInputError("Session input paused before preparation");
						}
						const preparationAction = activeTurns().at(-1);
						if (!preparationAction) return undefined;
						const basePromptSnapshot = this._baseSystemPrompt;
						const result = await this._extensionRunner.emitBeforeAgentStart(
							preparationAction.payload.text,
							preparationAction.payload.images,
							basePromptSnapshot,
							this._baseSystemPromptOptions,
						);
						if (activeTurns().at(-1) !== preparationAction) continue;
						const prepared = { result, basePromptSnapshot };
						for (const action of activeTurns()) action.payload.prepared = prepared;
					}
					if (this._isSessionInputHandoffDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before handoff");
					}
					return activeTurns()[0]?.payload.prepared;
				},
				shouldCommit: () => activeTurns().length > 0,
				commit: (prepared) => {
					if (this._isSessionInputHandoffDeferred(epoch)) {
						throw new DeferredSessionInputError("Session input paused before handoff");
					}
					const turns = activeTurns();
					if (turns.length === 0) return undefined;
					return { prepared, turns };
				},
			});
			if (!preparedTurn) {
				restoreNextTurnContext();
				return;
			}
			const { prepared, turns } = preparedTurn;
			const commitFence = await this._acquireSessionActionCommitFence();
			let promptPromise: Promise<void>;
			try {
				promptPromise = this._sessionActionCommitContext.run(commitFence.owner, () => {
					if (
						this._isSessionInputHandoffDeferred(epoch) ||
						this.isStreaming ||
						turns.some((action) => action.lifecycle.state !== "preparing")
					) {
						throw new DeferredSessionInputError("Agent became active before session input handoff");
					}
					if (executionPolicy.nextTurnContextTiming === "commit") {
						nextTurnMessages = this._takePendingNextTurnMessages();
					}
					const contextRecords = nextTurnMessages.map((message) =>
						this._createDeliveryRecord(turns[0].id, "next_turn", message),
					);
					const firstPrimaryIndex = turns[0].payload.records.indexOf(primaryDeliveryRecord(turns[0]));
					turns[0].payload.records.splice(firstPrimaryIndex, 0, ...contextRecords);
					const preparedMessages: AgentMessage[] = turns.flatMap((action) =>
						action.payload.records.map((record) => record.message),
					);
					for (const action of turns) {
						if (action.suppressAutonomousContinuation) {
							this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
						}
					}
					if (executionPolicy.runBeforeAgentStart) {
						this._appendBeforeAgentStartMessages(preparedMessages, prepared?.result);
						this._applyPreparedSystemPrompt(prepared, executionPolicy.preserveEmptyExtensionPrompt);
					} else if (executionPolicy.nextTurnContextTiming !== "skip") {
						this.agent.state.systemPrompt = this._baseSystemPrompt;
					}
					for (const action of turns) transitionSessionAction(action, { state: "committing" });
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
					return turns.some((action) => action.suppressAutonomousContinuation)
						? this._runWithAutonomousContinuationSuppressed(() => this.agent.prompt(preparedMessages))
						: this.agent.prompt(preparedMessages);
				});
			} finally {
				commitFence.release();
			}
			await promptPromise;
			if (executionPolicy.completionIncludesRetryChain) await this.waitForRetry();
			if (!this._hasCancelledDispatchCapture()) await this._agentEventQueue;
			if (
				turns.some(
					(action) =>
						action.lifecycle.state !== "cancelled" &&
						!primaryDeliveryRecord(action).durable &&
						!this.agent.state.messages.includes(primaryDeliveryRecord(action).message),
				)
			) {
				throw new Error("Session input dispatch settled without durable delivery");
			}
			this._forgetConsumedPostCompactionContinuations(turns.map((action) => primaryDeliveryRecord(action).message));
		} catch (error) {
			const delivered = new Set(this.agent.state.messages);
			this._pendingNextTurnMessages.unshift(...nextTurnMessages.filter((message) => !delivered.has(message)));
			for (const action of actions) {
				if (action.payload.kind === "turn") {
					action.payload.records = action.payload.records.filter((record) => record.role !== "next_turn");
				}
			}
			throw error;
		}
	}

	private async _executeQueuedSessionCommand(action: QueuedSessionAction): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a session command action");
		const input = action.payload;
		try {
			let resultText: string | undefined;
			let displayResult = true;
			switch (input.command.name) {
				case "compact":
					await this.compact(input.command.args || undefined, {
						skipAbort: true,
					});
					break;
				case "refine": {
					let result: RefinementResult;
					try {
						const options = parseRefineCommandOptions(input.command.args);
						result = await this.refine(options, { skipAbort: true });
					} catch (error) {
						// Only a failure of the refinement itself is a refine failure; a later
						// result-row persist error must not report a completed refinement as failed.
						this._emitRefineFailed(this._asError(error));
						throw error;
					}
					const applied = result.appliedEdits.filter((edit) => edit.applied).length;
					resultText = `Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied.`;
					displayResult = false;
					break;
				}
				case "goal":
					await this._handleGoalSlashCommand(input.text, input.images);
					resultText = this._goalState.objective
						? `Goal ${this._goalState.status}: ${this._goalState.objective}`
						: "No active goal.";
					break;
				case "autonomous":
					await this._handleAutonomousSlashCommand(input.text);
					break;
				case "avo":
				case "horizon":
					resultText = this._handleAvoSlashCommand(input.command);
					break;
			}
			if (resultText) {
				this._appendDurableSessionCommandMessage(resultText, input.command, true, false, displayResult);
			}
		} catch (error) {
			if (error instanceof CompactionSkippedError) return;
			const commandError = error instanceof Error ? error : new Error(String(error));
			try {
				this._appendDurableSessionCommandMessage(
					`Command failed: ${commandError.message}`,
					input.command,
					true,
					true,
				);
			} catch {
				// The result row is also the command-correlated UI settle edge.
				const message = createSessionSlashCommandResultMessage(`Command failed: ${commandError.message}`, {
					command: input.command,
					success: false,
					severity: "error",
					error: commandError.message,
				});
				this._emit({ type: "message_start", message });
				this._emit({ type: "message_end", message });
			}
			throw commandError;
		}
	}

	private _appendDurableSessionCommandMessage(
		content: string,
		command: SessionSlashCommand,
		isResult: boolean,
		isError = false,
		display = true,
	): void {
		const message: CustomMessage = isResult
			? createSessionSlashCommandResultMessage(
					content,
					{
						command,
						success: !isError,
						severity: isError ? "error" : "info",
						...(isError ? { error: content.replace(/^Command failed:\s*/, "") } : {}),
					},
					display,
				)
			: createSessionSlashCommandMessage(command);
		// Persist before touching live state so a failed write cannot leave an
		// unsaved leaf that the next entry would silently parent onto.
		this.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _throwIfExtensionCommand(text: string): void {
		const commandName = parseSlashCommand(text)?.name ?? "";
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			content: message.content,
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			const normalized = normalizeMessageContent(message.content);
			if (options?.deliverAs === "followUp") {
				await this._queuePreparedPrompt("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			} else {
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
				});
			}
		} else if (options?.triggerTurn) {
			if (!this._sessionInputSuspendedForUpdateRestart) this._resumeSessionInputAdmission();
			const admissionFence = await this._acquireDirectTurnAdmissionFence();
			try {
				const normalized = normalizeMessageContent(message.content);
				const immediatelyEligible = this._canStartSessionActionImmediately();
				const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
					executionPolicy: this._turnExecutionPolicy("customTrigger"),
					queueVisible: false,
				});
				const result = this._admitSessionInput(action, { immediatelyEligible });
				admissionFence.release();
				if (!result.ticket) return;
				await result.ticket.completed;
			} finally {
				admissionFence.release();
			}
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		await this._prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
			resumeIfIdle: true,
		});
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const clearable = this._actionStore
			.clearableActions()
			.filter((action) => action.payload.kind === "session_command" || action.payload.queueVisible);
		if (clearable.some((action) => action.payload.kind === "turn" && action.lifecycle.state === "preparing")) {
			this._sessionInputPumpEpoch++;
		}
		const steering = clearable
			.filter((action) => action.delivery === "next_turn_boundary")
			.map((action) => action.payload.text);
		const followUp = clearable
			.filter((action) => action.delivery === "when_run_idle")
			.map((action) => action.payload.text);
		const promptError = new Error("Queued prompt was cleared before delivery.");
		const agentMessageError = new Error("Queued agent message was cleared before delivery.");
		for (const action of clearable) {
			const error =
				action.payload.kind === "turn" && action.lifecycle.state === "preparing" ? promptError : agentMessageError;
			this._settleAgentMessage(action.agentMessageId, "delivery", error);
			this._settleAgentMessage(action.agentMessageId, "completion", error);
		}
		const clearableIds = new Set(clearable.map((action) => action.id));
		this._cancelSessionActions((action) => clearableIds.has(action.id), agentMessageError);
		const pendingBinding = parseAvoCanonicalDeliveryBinding(this._pendingAvoCanonicalDelivery());
		if (pendingBinding) {
			this.agent.removeQueuedMessages(
				(message) =>
					message.role !== "custom" ||
					message.customType !== "avo_canonical_delivery_required" ||
					!matchesAvoCanonicalDeliveryBinding(message.details, pendingBinding),
			);
			this._fenceAvoCanonicalDeliveryInputs();
		} else {
			this.agent.clearAllQueues();
		}
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	private _invalidateQueuedPromptPreparation(): void {
		for (const action of this._actionStore.clearableActions()) {
			if (action.payload.kind === "turn") action.payload.prepared = undefined;
		}
	}

	clearQueuedUserMessagesMatching(predicate: (text: string) => boolean): { steering: string[]; followUp: string[] } {
		const ownedActions = this._actionStore.ownedActions();
		const dispatchedTurnCount = ownedActions.filter(
			(action) =>
				action.payload.kind === "turn" &&
				(action.lifecycle.state === "committing" || action.lifecycle.state === "running"),
		).length;
		const matching = ownedActions.filter(
			(action) =>
				action.payload.kind === "turn" &&
				action.agentMessageId !== undefined &&
				predicate(action.payload.text) &&
				(action.lifecycle.state === "queued" ||
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					(action.lifecycle.state === "committing" &&
						dispatchedTurnCount === 1 &&
						!primaryDeliveryRecord(action).started)),
		);
		if (matching.length === 0) return { steering: [], followUp: [] };
		const removedTexts = (delivery: DeliveryPolicy) =>
			[
				...matching.filter((action) => action.delivery === delivery && action.lifecycle.state === "queued"),
				...matching.filter((action) => action.delivery === delivery && action.lifecycle.state !== "queued"),
			].map((action) => action.payload.text);
		const removedSteering = removedTexts("next_turn_boundary");
		const removedFollowUp = removedTexts("when_run_idle");
		const acceptedError = new Error("Accepted agent message was cleared before delivery.");
		const queuedError = new Error("Queued agent message was cleared before delivery.");
		for (const action of matching) {
			const error =
				action.payload.kind === "turn" && action.payload.acceptedAgentMessage ? acceptedError : queuedError;
			this._rejectAgentMessage(action.agentMessageId, error);
		}
		for (const [accepted, error] of [
			[true, acceptedError],
			[false, queuedError],
		] as const) {
			const ids = new Set(
				matching
					.filter((action) => action.payload.kind === "turn" && action.payload.acceptedAgentMessage === accepted)
					.map((action) => action.id),
			);
			if (ids.size > 0) this._cancelSessionActions((action) => ids.has(action.id), error, matching);
		}
		if (
			matching.some(
				(action) =>
					action.lifecycle.state === "cancelled" &&
					action.payload.kind === "turn" &&
					action.payload.captureRunMessages,
			)
		) {
			this.agent.abort();
		}
		this._emitQueueUpdate();
		return { steering: removedSteering, followUp: removedFollowUp };
	}

	/**
	 * Mutate a single visible queued message, addressed by its position in the same
	 * projection the session-action snapshot publishes. expectedText must match the
	 * item's current preview so clients never edit a shifted queue by accident.
	 */
	mutateQueuedMessage(
		lane: QueuedMessageLane,
		index: number,
		expectedText: string,
		mutation: QueuedMessageMutation,
	): QueuedMessageMutationStatus {
		const policy = queuedMessageLaneDeliveryPolicy(lane);
		const projection = visibleSessionActionProjection(this._actionStore.queuedActions(policy));
		const item = projection[index];
		if (!item || queuedAgentMessagePreview(item) !== expectedText) return "rejected";
		if (mutation.type === "delete") {
			const error = new Error("Queued prompt was deleted before delivery.");
			this._rejectAgentMessage(item.agentMessageId, error);
			this._cancelSessionActions((candidate) => candidate === item, error);
			this._emitQueueUpdate();
			this.resumeQueuedWork();
			return "applied";
		}
		if (mutation.type === "move") {
			const neighbor = projection[index + mutation.direction];
			if (!neighbor) return "rejected";
			this._actionStore.swapQueued(item, neighbor);
			this._emitQueueUpdate();
			return "applied";
		}
		if (
			item.payload.kind === "turn" &&
			(item.payload.acceptedAgentMessage ||
				item.payload.records.some((record) => record.role === "primary" && record.message.role !== "user"))
		) {
			return "rejected";
		}
		const images = mutation.images?.map((image) => ({ ...image }));
		if (item.payload.kind === "session_command") {
			const command = parseSessionSlashCommand(mutation.text);
			if (!command) return "invalid";
			item.payload.text = mutation.text;
			item.payload.command = command;
			if (mutation.images !== undefined) item.payload.images = images?.length ? images : undefined;
		} else {
			item.payload.text = mutation.text;
			const text = { type: "text" as const, text: mutation.text };
			if (mutation.images !== undefined) {
				item.payload.images = images?.length ? images : undefined;
				item.payload.content = [text, ...(images?.map((image) => ({ ...image })) ?? [])];
			} else if (item.payload.content) {
				item.payload.content = [text, ...item.payload.content.filter((block) => block.type !== "text")];
			}
			item.payload.preview = undefined;
			item.payload.prepared = undefined;
			for (const record of item.payload.records) {
				if (record.role === "primary" && record.message.role === "user") {
					record.message.content = item.payload.content?.map((block) => ({ ...block })) ?? mutation.text;
				}
			}
		}
		const targetPolicy = queuedMessageLaneDeliveryPolicy(mutation.lane);
		if (targetPolicy !== policy) {
			item.queueKey = undefined;
			item.wake = mutation.lane === "steering" ? "on_lower_boundary" : "external_resume";
			this._actionStore.moveQueued(item, targetPolicy, this._actionStore.queuedActions(targetPolicy).length);
		}
		this.resumeQueuedWork();
		this._emitQueueUpdate();
		return "applied";
	}

	get queuedActionCount(): number {
		return visibleSessionActionProjection(this._actionStore.queuedActions()).length;
	}

	get unfinishedActionCount(): number {
		return this._actionStore.unfinishedActions().length;
	}

	get isQueuedWorkSuspended(): boolean {
		return this._sessionInputPumpSuspended;
	}

	get isSessionActive(): boolean {
		return (
			this.isStreaming ||
			this.isCompacting ||
			this.isRetrying ||
			this.isBashRunning ||
			this._refineInFlight !== undefined ||
			this._branchSummaryOperation !== undefined ||
			this._postCompactionContinuationSettlement !== undefined ||
			this.unfinishedActionCount > 0
		);
	}

	getSessionActionSnapshot(): SessionActionSnapshot {
		const steering = visibleSessionActionProjection(this._actionStore.queuedActions("next_turn_boundary")).map(
			queuedAgentMessagePreview,
		);
		const followUps = visibleSessionActionProjection(this._actionStore.queuedActions("when_run_idle")).map(
			queuedAgentMessagePreview,
		);
		const active = visibleSessionActionProjection(this._actionStore.activeActions())[0];
		const activeState = active?.lifecycle.state;
		const phase =
			activeState === "selected"
				? "preparing"
				: activeState === "preparing" || activeState === "committing" || activeState === "running"
					? activeState
					: undefined;
		return {
			queuedCount: steering.length + followUps.length,
			steering,
			followUps,
			...(active && phase
				? {
						active: {
							kind: active.payload.kind,
							phase,
							label: compactRlmText(active.payload.text),
						},
					}
				: {}),
		};
	}

	getSteeringMessages(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("next_turn_boundary")).map(
			(action) => action.payload.text,
		);
	}

	getSteeringMessagePreviews(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("next_turn_boundary")).map(
			queuedAgentMessagePreview,
		);
	}

	getFollowUpMessages(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("when_run_idle")).map(
			(action) => action.payload.text,
		);
	}

	getFollowUpMessagePreviews(): readonly string[] {
		return visibleSessionActionProjection(this._actionStore.queuedActions("when_run_idle")).map(
			queuedAgentMessagePreview,
		);
	}

	getSessionActionRecoverySnapshot(): SessionActionRecoverySnapshot {
		return {
			formatVersion: SESSION_ACTION_RECOVERY_FORMAT_VERSION,
			actions: this._actionStore.snapshotActions().map((action) => ({
				id: action.id,
				source: action.source,
				delivery: action.delivery,
				wake: action.wake,
				...(action.queueKey ? { queueKey: action.queueKey } : {}),
				...(action.agentMessageId ? { agentMessageId: action.agentMessageId } : {}),
				...(action.suppressAutonomousContinuation ? { suppressAutonomousContinuation: true } : {}),
				payload:
					action.payload.kind === "turn"
						? {
								kind: "turn",
								text: action.payload.text,
								...(action.payload.preview ? { preview: action.payload.preview } : {}),
								records: action.payload.records.map((record) => ({
									id: record.id,
									role: record.role,
									message: cloneQueuedAgentMessage(record.message),
									ownerActionId: record.ownerActionId,
								})),
								...(action.payload.images
									? {
											images: action.payload.images.map((image) => ({
												...image,
											})),
										}
									: {}),
								...(action.payload.content
									? {
											content: action.payload.content.map((block) => ({
												...block,
											})),
										}
									: {}),
								...(action.payload.customMessage
									? {
											customMessage: cloneCustomMessage(action.payload.customMessage),
										}
									: {}),
								executionPolicy: {
									...action.payload.executionPolicy,
									preparation: {
										...action.payload.executionPolicy.preparation,
									},
								},
								queueVisible: action.payload.queueVisible,
								acceptedAgentMessage: action.payload.acceptedAgentMessage,
								acceptedBeforeCompletion: action.payload.acceptedBeforeCompletion,
								...(action.payload.avoObservedRunId
									? { avoObservedRunId: action.payload.avoObservedRunId }
									: {}),
							}
						: {
								kind: "session_command",
								text: action.payload.text,
								command: { ...action.payload.command },
								...(action.payload.images
									? {
											images: action.payload.images.map((image) => ({
												...image,
											})),
										}
									: {}),
							},
			})),
		};
	}

	private _notifySessionInputCheckpointChange(): void {
		const waiters = [...this._sessionInputCheckpointWaiters];
		this._sessionInputCheckpointWaiters.clear();
		for (const resolve of waiters) resolve();
	}

	private _observeSessionActionDeferral(action: QueuedSessionAction): {
		deferred: Promise<void>;
		stop(): void;
	} {
		let resolveDeferral = () => {};
		const deferred = new Promise<void>((resolve) => {
			resolveDeferral = resolve;
		});
		const check = () => {
			if (action.lifecycle.state === "queued") resolveDeferral();
			else this._sessionInputCheckpointWaiters.add(check);
		};
		this._sessionInputCheckpointWaiters.add(check);
		return {
			deferred,
			stop: () => this._sessionInputCheckpointWaiters.delete(check),
		};
	}

	async waitForSessionInputCheckpoint(signal?: AbortSignal): Promise<void> {
		const blocksCheckpoint = () =>
			this._actionStore.activeActions().some((action) => {
				if (action.payload.kind === "session_command") {
					return action.lifecycle.state === "selected" || action.lifecycle.state === "running";
				}
				return (
					action.lifecycle.state === "selected" ||
					action.lifecycle.state === "preparing" ||
					(action.lifecycle.state === "committing" && !primaryDeliveryRecord(action).durable)
				);
			});
		while (true) {
			while (blocksCheckpoint()) {
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				await new Promise<void>((resolve, reject) => {
					const onChange = () => {
						cleanup();
						resolve();
					};
					const onAbort = () => {
						cleanup();
						reject(new Error("Update restart preparation cancelled"));
					};
					const cleanup = () => {
						this._sessionInputCheckpointWaiters.delete(onChange);
						signal?.removeEventListener("abort", onAbort);
					};
					this._sessionInputCheckpointWaiters.add(onChange);
					signal?.addEventListener("abort", onAbort, { once: true });
					if (signal?.aborted) onAbort();
				});
			}
			const commitFence = await this._acquireSessionActionCommitFence(signal);
			try {
				if (blocksCheckpoint()) continue;
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				await waitForPromiseOrAbort(this._agentEventQueue, signal, "Update restart preparation cancelled");
				if (signal?.aborted) throw new Error("Update restart preparation cancelled");
				this.sessionManager.flushNow();
				return;
			} finally {
				commitFence.release();
			}
		}
	}

	acquireSessionInputPause(): { release(): void } {
		const token = Symbol("session-input-admission-pause");
		this._sessionInputAdmissionPauses.add(token);
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._sessionInputAdmissionPauses.delete(token);
				this._sessionInputPumpEpoch++;
				this._notifySessionInputCheckpointChange();
				this._flushDeferredRlmTerminalNotices();
				this._maybeResumeGoalContinuationAfterRlmWork();
				this._scheduleSessionInputPump();
			},
		};
	}

	acquireQueuedWorkPause(): { release(): void } {
		const token = Symbol("queued-work-pause");
		this._queuedWorkPauses.add(token);
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				this._queuedWorkPauses.delete(token);
				this._notifySessionInputCheckpointChange();
				this._flushDeferredRlmTerminalNotices();
				this._scheduleSessionInputPump();
			},
		};
	}

	private async _acquireDirectTurnAdmissionFence(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		const inheritedOwner = this._sessionActionCommitContext.getStore();
		if (inheritedOwner !== undefined && inheritedOwner === this._sessionActionCommitOwner) {
			this._assertSessionActionAdmissionAvailable();
			return this._acquireSessionActionCommitFence(signal);
		}
		const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		while (true) {
			this._assertSessionActionAdmissionAvailable();
			if (this._queuedWorkPauses.size > 0) {
				let wake = () => {};
				const pauseReleased = new Promise<void>((resolve) => {
					wake = resolve;
					this._sessionInputCheckpointWaiters.add(resolve);
				});
				try {
					await waitForPromiseOrAbort(pauseReleased, waitSignal, "Update restart preparation cancelled");
				} catch (error) {
					if (disposeSignal.aborted) {
						throw new Error("Cannot admit a session action because the session is disposing or disposed.");
					}
					throw error;
				} finally {
					this._sessionInputCheckpointWaiters.delete(wake);
				}
				continue;
			}
			const fence = await this._acquireSessionActionCommitFence(signal);
			try {
				if (this._queuedWorkPauses.size === 0) {
					this._assertSessionActionAdmissionAvailable();
					return fence;
				}
			} catch (error) {
				fence.release();
				throw error;
			}
			fence.release();
		}
	}

	private async _acquireSessionActionCommitFence(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		const inheritedOwner = this._sessionActionCommitContext.getStore();
		if (inheritedOwner !== undefined && inheritedOwner === this._sessionActionCommitOwner) {
			return { owner: inheritedOwner, release: () => {} };
		}
		const previous = this._sessionActionCommitTail;
		let resolve = () => {};
		this._sessionActionCommitTail = new Promise<void>((release) => {
			resolve = release;
		});
		const disposeSignal = this._sessionActionCommitDisposeAbortController.signal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		this._pendingSessionActionFenceWaiters++;
		try {
			await waitForPromiseOrAbort(previous, waitSignal, "Update restart preparation cancelled");
		} catch (error) {
			this._pendingSessionActionFenceWaiters--;
			// A cancelled waiter remains in the FIFO chain until its predecessor releases.
			void previous.then(resolve, resolve);
			if (disposeSignal.aborted) {
				throw new Error("Cannot admit a session action because the session is disposing or disposed.");
			}
			throw error;
		}
		const owner = Symbol("session-action-commit");
		this._sessionActionCommitOwner = owner;
		this._pendingSessionActionFenceWaiters--;
		let released = false;
		return {
			owner,
			release: () => {
				if (released) return;
				released = true;
				if (this._sessionActionCommitOwner === owner) this._sessionActionCommitOwner = undefined;
				resolve();
			},
		};
	}

	private _resumeSessionInputAdmission(): void {
		if (!this._sessionInputPumpSuspended) return;
		this._sessionInputPumpSuspended = false;
		this._sessionInputSuspendedForUpdateRestart = false;
		this._sessionInputPumpEpoch++;
		this._notifySessionInputCheckpointChange();
		this._flushDeferredRlmTerminalNotices();
	}

	/** Resume the scheduler after requestAbort/abortForUpdateRestart suspended it; owned pause leases are unaffected. */
	resumeQueuedWork(): boolean {
		this._resumeSessionInputAdmission();
		this._maybeResumeGoalContinuationAfterRlmWork();
		this._scheduleSessionInputPump();
		return this._hasSelectableSessionInput();
	}

	async waitForSessionInputIdle(): Promise<void> {
		while (true) {
			const pump = this._sessionInputPump;
			await pump;
			if (pump === this._sessionInputPump && !this._sessionInputPumpRequested) return;
		}
	}

	async waitForIdle(): Promise<void> {
		while (true) {
			if (this._actionStore.queuedActions().length > 0) {
				if (this._sessionInputPumpSuspended || this._queuedWorkPauses.size > 0) {
					await new Promise<void>((resolve) => this._sessionInputCheckpointWaiters.add(resolve));
					continue;
				}
				this._scheduleSessionInputPump();
			}
			const pump = this._sessionInputPump;
			await pump;
			await this.agent.waitForIdle();
			const agentEventQueue = this._agentEventQueue;
			await agentEventQueue;
			if (
				pump === this._sessionInputPump &&
				agentEventQueue === this._agentEventQueue &&
				!this._sessionInputPumpRequested &&
				!this.agent.state.isStreaming &&
				this.unfinishedActionCount === 0
			) {
				return;
			}
		}
	}

	/** Waits out any owned post-compaction continuation and rejects when one cannot start; {@link waitForIdle} never rejects. */
	async waitForHeadlessIdle(): Promise<void> {
		while (true) {
			await this.waitForIdle();
			const postCompactionContinuation = this._postCompactionContinuationSettlement?.promise;
			if (!postCompactionContinuation) return;
			await postCompactionContinuation;
		}
	}

	getPendingNextTurnMessageSnapshots(): readonly CustomMessage[] {
		const messages = this._pendingNextTurnMessages.map((message) => cloneCustomMessage(message));
		for (const action of this._actionStore.unfinishedActions()) {
			if (
				action.payload.kind !== "turn" ||
				!action.payload.acceptedAgentMessage ||
				!primaryDeliveryRecord(action).started
			) {
				continue;
			}
			messages.push(
				...action.payload.records
					.filter(
						(record): record is DeliveryRecord & { message: CustomMessage } =>
							(record.role === "next_turn" || record.role === "prefix") &&
							record.message.role === "custom" &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message)),
			);
		}
		return messages;
	}

	restorePendingNextTurnMessages(messages: readonly CustomMessage[]): void {
		this._pendingNextTurnMessages.push(...messages.map((message) => cloneCustomMessage(message)));
		this._flushDeferredRlmTerminalNotices();
	}

	removeQueuedFollowUp(queueKey: string): boolean {
		const matching = this._actionStore
			.clearableActions()
			.filter((action) => action.payload.kind === "turn" && action.queueKey === queueKey);
		if (matching.length === 0) return false;
		const error = new Error("Queued agent message was cleared before delivery.");
		for (const action of matching) this._rejectAgentMessage(action.agentMessageId, error);
		const ids = new Set(matching.map((action) => action.id));
		this._cancelSessionActions((action) => ids.has(action.id), error);
		this._emitQueueUpdate();
		return true;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	requestAbort(): void {
		for (const run of [...this._unsettledRlmChildRuns]) {
			if (run.status === "cancelled") this._abandonRlmRunForQuiescence(run);
		}
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._sessionInputSuspendedForUpdateRestart = false;
		this._demoteRlmTerminalNoticeActions();
		this._cancelSessionActions(
			(action) =>
				action.payload.kind === "turn" &&
				!action.payload.queueVisible &&
				!this._durableRlmTerminalNoticeActionIds.has(action.id),
			new Error("Prompt aborted before delivery."),
		);
		this._cancelPostCompactionContinue();
		this.abortRetry();
		this.abortCompaction();
		this.abortBranchSummary();
		this.abortBash();
		this._pendingRequestedRefine = undefined;
		this._autoRefineBranchVersion++;
		this._autoRefineReviewAbort?.abort();
		this._refineAbortController?.abort();
		this.agent.abort();
	}

	async abort(): Promise<void> {
		const compactionOperation = this._compactionOperation;
		const branchSummaryOperation = this._branchSummaryOperation;
		this.requestAbort();
		this._cancelActiveRlmChildRuns("Parent session aborted");
		this._goalAbortInProgress = this._goalState.status === "active";
		try {
			await Promise.allSettled([
				this.agent.waitForIdle(),
				this._agentEventQueue,
				...(compactionOperation ? [compactionOperation] : []),
				...(branchSummaryOperation ? [branchSummaryOperation] : []),
			]);
		} finally {
			this._goalAbortInProgress = false;
		}
	}

	abortForUpdateRestart(): void {
		// Cancel scheduled pumps and suspend new ones: queued inputs must survive
		// into the restart manifest instead of starting a turn during teardown.
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._sessionInputSuspendedForUpdateRestart = true;
		this._cancelPostCompactionContinue();
		this.abortRetry();
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._cancelActiveRlmChildRuns("Parent session aborted for update restart");
		this._goalAbortInProgress = this._goalState.status === "active";
		this.agent.abort();
		if (this._goalAbortInProgress) {
			void this.agent
				.waitForIdle()
				.then(() => this._agentEventQueue)
				.catch(() => undefined)
				.finally(() => {
					this._goalAbortInProgress = false;
				});
		}
	}

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	private _queueModelSelectEmit(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		const emit = () =>
			this._modelSelectEmitContext.run(true, () => this._emitModelSelect(nextModel, previousModel, source));
		this._modelSelectEmitQueueIdle = false;
		const promise = this._modelSelectEmitQueue.then(emit, emit);
		const queued = promise.catch(() => {});
		this._modelSelectEmitQueue = queued;
		void queued.finally(() => {
			if (this._modelSelectEmitQueue === queued) {
				this._modelSelectEmitQueueIdle = true;
			}
		});
		return promise;
	}

	async setModel(model: Model<any>, options: ModelSelectOptions = {}): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		if (!(await this._modelRegistry.canUseModel(model))) {
			throw new Error(`Model "${model.provider}/${model.id}" is not available for the current Prime team.`);
		}

		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(model, previousModel, "set");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}
	}

	private _trackModelSelectEmitError(emitPromise: Promise<void>): void {
		void emitPromise.catch((error) => {
			this._extensionRunner.emitError({
				extensionPath: "<internal>",
				event: "model_select",
				error: error instanceof Error ? error.message : String(error),
				stack: error instanceof Error ? error.stack : undefined,
			});
		});
	}

	private _shouldWaitForModelSelectEmit(options: ModelSelectOptions): boolean {
		return options.waitForExtensions !== false && !this._modelSelectEmitContext.getStore();
	}

	private _pendingModelSelectEmit(): Promise<void> | undefined {
		if (!this._modelSelectEmitContext.getStore() && !this._modelSelectEmitQueueIdle) {
			return this._modelSelectEmitQueue;
		}
		return undefined;
	}

	async cycleModel(
		direction: "forward" | "backward" = "forward",
		options: ModelSelectOptions = {},
	): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction, options);
		}
		return this._cycleAvailableModel(direction, options);
	}

	private async _cycleScopedModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.refreshAvailableModels();
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableModels.some((model) => modelsAreEqual(model, scoped.model)),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);
		const serviceTier = this._getServiceTierForModelSwitch();

		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(next.model, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return {
			model: next.model,
			thinkingLevel: this.thinkingLevel,
			serviceTier: this.serviceTier,
			isScoped: true,
		};
	}

	private async _cycleAvailableModel(
		direction: "forward" | "backward",
		options: ModelSelectOptions,
	): Promise<ModelCycleResult | undefined> {
		const availableModels = await this._modelRegistry.refreshAvailableModels();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		this.setThinkingLevel(thinkingLevel);
		this._clampServiceTierForModel(serviceTier);

		const emitPromise = this._queueModelSelectEmit(nextModel, currentModel, "cycle");
		if (this._shouldWaitForModelSelectEmit(options)) {
			await emitPromise;
		} else {
			this._trackModelSelectEmitError(emitPromise);
		}

		return {
			model: nextModel,
			thinkingLevel: this.thinkingLevel,
			serviceTier: this.serviceTier,
			isScoped: false,
		};
	}

	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	setServiceTier(serviceTier: ServiceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		const preferenceChanged = effectiveServiceTier !== this._serviceTierPreference;
		const effectiveTierChanged = effectiveServiceTier !== this.agent.state.serviceTier;
		if (!preferenceChanged && !effectiveTierChanged) {
			return;
		}
		this._serviceTierPreference = effectiveServiceTier;
		if (preferenceChanged) {
			this.sessionManager.appendServiceTierChange(effectiveServiceTier);
			if (this.model && supportsFastMode(this.model)) {
				this.settingsManager.setDefaultServiceTier(effectiveServiceTier);
			}
		}
		if (effectiveTierChanged) {
			this.agent.state.serviceTier = effectiveServiceTier;
			this._emit({
				type: "service_tier_changed",
				serviceTier: effectiveServiceTier,
			});
		}
	}

	private _getEffectiveServiceTier(serviceTier: ServiceTier): ServiceTier {
		return serviceTier === "priority" && (!this.model || !supportsFastMode(this.model)) ? "default" : serviceTier;
	}

	private _getServiceTierForModelSwitch(): ServiceTier {
		return this._serviceTierPreference;
	}

	private _clampServiceTierForModel(serviceTier: ServiceTier = this.serviceTier): void {
		const effectiveServiceTier = this._getEffectiveServiceTier(serviceTier);
		if (effectiveServiceTier === this.agent.state.serviceTier) {
			return;
		}
		this.agent.state.serviceTier = effectiveServiceTier;
		this._emit({
			type: "service_tier_changed",
			serviceTier: effectiveServiceTier,
		});
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	private async _syncKernelStateAfterCompaction(): Promise<void> {
		const provisioner = this._ipythonKernelProvisioner;
		if (!provisioner?.hasRunningKernel) return;
		const pruned = await provisioner.pruneOversizedVariables().catch(() => null);
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), KERNEL_STATE_LISTING_TIMEOUT_MS);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		let names: string[] | null;
		try {
			names = await provisioner.listNamespaceNames(abort.signal).catch(() => null);
		} finally {
			clearTimeout(timer);
		}
		if (names === null && !provisioner.hasRunningKernel) return;
		const detail =
			names === null
				? ""
				: names.length > 0
					? ` These names are still defined: ${names.join(", ")}.`
					: " You have not defined any names yet.";
		const prunedDetail =
			pruned && pruned.length > 0
				? ` Variables above the per-variable snapshot limit were removed: ${pruned.join(", ")}.`
				: "";
		const content = [
			"<ipython_state>",
			`Your IPython kernel persisted through compaction; its remaining variables, imports, and helpers are still available.${prunedDetail}${detail}`,
			"</ipython_state>",
		].join("\n");
		const message = {
			role: "custom" as const,
			customType: "ipython_state",
			content,
			display: false,
			timestamp: Date.now(),
		} satisfies CustomMessage;
		const messages = this.agent.state.messages;
		const last = messages[messages.length - 1];
		const insertBeforeError = last?.role === "assistant" && (last as AssistantMessage).stopReason === "error";
		if (insertBeforeError) {
			messages.splice(messages.length - 1, 0, message);
		} else {
			messages.push(message);
		}
		this.sessionManager.appendCustomMessageEntry(message.customType, message.content, message.display, undefined);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _onIpythonStateRestored(result: RestoreResult): void {
		const lines = ["<ipython_state_restored>"];
		if (result.restored.length > 0) {
			lines.push(
				`Your IPython kernel state was revived from your previous session. These names are available again: ${result.restored.join(", ")}.`,
			);
		} else {
			lines.push(
				"Your previous IPython kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.",
			);
		}
		if (result.failed.length > 0) {
			lines.push(
				`These could not be restored and must be recreated if needed: ${result.failed.map((f) => f.name).join(", ")}.`,
			);
		}
		lines.push("</ipython_state_restored>");
		void this.sendCustomMessage(
			{
				customType: IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
				content: lines.join("\n"),
				display: true,
				details: { restored: result.restored.length > 0 },
			},
			{ deliverAs: "nextTurn" },
		).catch(() => {});
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	async compact(customInstructions?: string, options: { skipAbort?: boolean } = {}): Promise<CompactionResult> {
		if (this._pendingAvoCanonicalDelivery() || this._isAvoCanonicalDeliveryTerminalFailure()) {
			throw new Error("AVO canonical delivery is terminal: compaction is closed");
		}
		if (options.skipAbort && this.isStreaming) {
			throw new Error("Cannot compact without aborting while the agent is running.");
		}
		const hadPostCompactionContinue = this._postCompactionContinuationScheduled;
		this._disconnectFromAgent();
		if (!options.skipAbort) await this.abort();
		let didCompact = false;
		this._compactionAbortController = new AbortController();
		let resolveCompactionOperation: () => void = () => {};
		const compactionOperation = new Promise<void>((resolve) => {
			resolveCompactionOperation = resolve;
		});
		this._compactionOperation = compactionOperation;
		this._emit({
			type: "compaction_start",
			reason: "manual",
			customInstructions,
		});

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { apiKey, headers } = await this._getRequiredRequestAuth(this.model);
			const result = await this._performCompaction({
				model: this.model,
				apiKey,
				headers,
				customInstructions,
				signal: this._compactionAbortController.signal,
			});

			this._emit({
				type: "compaction_end",
				reason: "manual",
				result,
				aborted: false,
				willRetry: false,
				customInstructions,
			});
			didCompact = true;
			// A manual compaction satisfies any pending model request; on failure the
			// request stays scheduled for the next turn boundary.
			this._pendingRequestedCompaction = undefined;
			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			const skipped = error instanceof CompactionSkippedError;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : skipped ? message : `Compaction failed: ${message}`,
				errorSeverity: skipped ? "warning" : "error",
				customInstructions,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
			this._reconnectToAgent();
			if (this._compactionOperation === compactionOperation) {
				this._compactionOperation = undefined;
			}
			resolveCompactionOperation();
			this._scheduleSessionInputPump();
			if (didCompact) {
				this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
				if (hadPostCompactionContinue) {
					this._schedulePostCompactionContinue();
				}
				// Queued agent or session-owned inputs resume the loop; defer refine
				// behind them instead of interleaving it before their turns.
				this._scheduleAutoRefineAfterCompaction(
					hadPostCompactionContinue || this.agent.hasQueuedMessages() || this.unfinishedActionCount > 0,
				);
			}
		}
	}

	/**
	 * Shared compaction core behind /compact, auto-compaction, and the compact
	 * skill. Throws CompactionSkippedError when there is nothing to compact and
	 * Error("Compaction cancelled") on abort or extension cancel.
	 */
	private async _performCompaction(options: {
		model: Model<any>;
		apiKey: string;
		headers?: Record<string, string>;
		customInstructions?: string;
		signal: AbortSignal;
	}): Promise<CompactionResult> {
		const { model, apiKey, headers, customInstructions, signal } = options;
		const pathEntries = this.sessionManager.getBranch();
		const settings = this.settingsManager.getCompactionSettings();

		const preparation = prepareCompaction(pathEntries, settings);
		if (!preparation) {
			const lastEntry = pathEntries[pathEntries.length - 1];
			if (lastEntry?.type === "compaction") {
				throw new CompactionSkippedError("Already compacted");
			}
			throw new CompactionSkippedError("Session is too short to compact — try again once it grows");
		}

		let extensionCompaction: CompactionResult | undefined;
		let fromExtension = false;

		if (this._extensionRunner.hasHandlers("session_before_compact")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_compact",
				preparation,
				branchEntries: pathEntries,
				customInstructions,
				signal,
			})) as SessionBeforeCompactResult | undefined;

			if (result?.cancel) {
				throw new Error("Compaction cancelled");
			}

			if (result?.compaction) {
				extensionCompaction = result.compaction;
				fromExtension = true;
			}
		}

		const { summary, firstKeptEntryId, tokensBefore, details } =
			extensionCompaction ??
			(await compact(preparation, model, apiKey, headers, customInstructions, signal, this.thinkingLevel));

		if (signal.aborted) {
			throw new Error("Compaction cancelled");
		}

		this.sessionManager.appendCompaction(
			summary,
			firstKeptEntryId,
			tokensBefore,
			details,
			fromExtension,
			customInstructions,
		);
		const newEntries = this.sessionManager.getEntries();
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		this._mergeUnpersistedOutcomes(this.agent.state.messages);
		this._restoreLateIpythonSentAgentMessages();

		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;
		if (savedCompactionEntry) {
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
		}
		await this._syncKernelStateAfterCompaction();
		await this._reapDeletedRlmSubagentRuntimesAfterCompaction();

		return { summary, firstKeptEntryId, tokensBefore, details };
	}

	private async _reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void> {
		const childIds = [...this._rlmChildCleanupFailures.keys()].filter(
			(childId) => !this._activeRlmChildRuns.get(childId)?.detachedDeletion,
		);
		await Promise.allSettled(childIds.map((childId) => this.deleteRlmSubagent(childId)));
	}

	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	private _localHarnessStateDir(): string | undefined {
		return (
			getLocalHarnessStateDir(this.sessionManager.getSessionArtifactDir()) ??
			(this._rlmSessionDir ? getLocalHarnessStateDir(this._rlmSessionDir) : undefined)
		);
	}

	private _autoRefineAllowedForSession(): boolean {
		return this._rlmDepth === 0 && this._localHarnessStateDir() !== undefined;
	}

	private _settlePostCompactionContinue(error?: Error): void {
		if (!error && (this._postCompactionContinuationScheduled || this._postCompactionContinuationTimer)) return;
		const settlement = this._postCompactionContinuationSettlement;
		if (!settlement || settlement.settled) return;
		settlement.settled = true;
		this._postCompactionContinuationSettlement = undefined;
		if (error) settlement.reject(error);
		else settlement.resolve();
	}

	private _cancelPostCompactionContinue(): void {
		if (this._postCompactionContinuationTimer) {
			clearTimeout(this._postCompactionContinuationTimer);
			this._postCompactionContinuationTimer = undefined;
		}
		this._postCompactionContinuationScheduled = false;
		this._scheduledPostCompactionContinuationMessages = [];
		this._settlePostCompactionContinue();
	}

	private _discardPendingAutoRefine(options: { cancelPostCompactionContinue?: boolean } = {}): void {
		this._compactAutoRefinePending = false;
		this._turnIntervalAutoRefinePending = false;
		this._pendingAutoRefineReview = undefined;
		if (options.cancelPostCompactionContinue) {
			this._cancelPostCompactionContinue();
		}
	}

	private async _invalidatePendingAutoRefineForBranchChange(): Promise<void> {
		this._autoRefineReviewAbort?.abort();
		this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		this._assistantTurnsSinceAutoRefine = 0;
		// Increment branch version BEFORE aborting/awaiting the serialized plan.
		// This invalidates the plan's branchVersion check at the boundary
		// so even if the plan completes, the boundary will reject it
		// (bgResult.branchVersion !== this._autoRefineBranchVersion).
		this._autoRefineBranchVersion++;
		// Abort the in-flight refine/bplan controller so any pending
		// _planRefine or _reviewAutoRefine call settles via signal abort
		// rather than hanging forever.
		this._refineAbortController?.abort();
		if (this._serializedPlanInFlight) {
			await this._consumeSerializedBackgroundPlan(async () => false);
		}
		while (this._refinePlanInFlight) {
			await this._refinePlanInFlight;
		}
		await this._waitForRefineIdle();
	}

	/**
	 * Consume a refine request that was scheduled by the agent-callable refine
	 * skill (refine.run). Fire-and-forget: the refine() method handles its own
	 * background planning, idle wait, application, and error recovery. Called
	 * at the turn boundary after compaction checks and before auto-refine
	 * scheduling so the manual request takes priority.
	 */
	private _emitRefineFailed(error: unknown): void {
		this._emit({
			type: "refine_failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	private _consumePendingRequestedRefine(): boolean {
		const pending = this._pendingRequestedRefine;
		if (!pending) return false;
		this._pendingRequestedRefine = undefined;
		void this.refine(pending).catch((error) => this._emitRefineFailed(error));
		return true;
	}

	private _scheduleAutoRefineAfterAgentEnd(): void {
		if (
			!this._autoRefineAllowedForSession() ||
			this._pendingAvoCanonicalDelivery() ||
			this._avoRuntime?.getState().status === "completed"
		) {
			return;
		}
		if (this._pendingAutoRefineReview) {
			this._scheduleAutoRefine(this._pendingAutoRefineReview.reason);
			return;
		}
		if (this._compactAutoRefinePending) {
			if (this._postCompactionContinuationScheduled) {
				return;
			}
			this._scheduleAutoRefine("compact");
			return;
		}

		this._scheduleAutoRefine("turn_interval");
	}

	private _scheduleAutoRefineAfterCompaction(willContinueAfterCompaction: boolean): void {
		if (!this._autoRefineAllowedForSession()) {
			return;
		}
		if (this._serializedRefine) {
			// Serialized sessions must service compaction-triggered refinement at
			// shouldStopAfterTurn (or disposal), never through the interactive path.
			this._compactAutoRefinePending = true;
			return;
		}
		if (willContinueAfterCompaction) {
			this._compactAutoRefinePending = true;
			return;
		}

		this._scheduleAutoRefine("compact");
	}

	private _schedulePostCompactionContinue(): void {
		if (this._postCompactionContinuationScheduled) {
			return;
		}
		if (!this._postCompactionContinuationSettlement || this._postCompactionContinuationSettlement.settled) {
			this._postCompactionContinuationSettlement = createPostCompactionContinuationSettlement();
		}
		this._postCompactionContinuationScheduled = true;
		this._scheduledPostCompactionContinuationMessages = [...this._postCompactionContinuationMessages];
		this._postCompactionContinuationTimer = setTimeout(() => {
			this._postCompactionContinuationTimer = undefined;
			void this._runScheduledPostCompactionContinue()
				.catch(() => undefined)
				.finally(() => this._settlePostCompactionContinue());
		}, 100);
	}

	private _sessionOwnsScheduledContinuations(continuationMessages: AgentMessage[]): boolean {
		return continuationMessages.some((message) => this._postCompactionContinuationMessages.includes(message));
	}

	private async _runScheduledPostCompactionContinue(): Promise<void> {
		if (this._pendingAvoCanonicalDelivery() || this._isAvoCanonicalDeliveryTerminalFailure()) {
			this._cancelPostCompactionContinue();
			return;
		}
		await this._waitForRefineIdle();
		if (!this._postCompactionContinuationScheduled) {
			return;
		}
		if (this.isStreaming || this.isCompacting || this.isRetrying || this._queuedWorkPauses.size > 0) {
			this._postCompactionContinuationScheduled = false;
			this._schedulePostCompactionContinue();
			return;
		}

		const continuationMessages = [...this._scheduledPostCompactionContinuationMessages];
		if (continuationMessages.length > 0 && !this._sessionOwnsScheduledContinuations(continuationMessages)) {
			this._cancelPostCompactionContinue();
			this._scheduleAutoRefineAfterAgentEnd();
			return;
		}
		// An empty queue is not idle while the scheduler still owns active work.
		if (this.unfinishedActionCount > 0 || this._sessionInputPumpRequested) {
			this._scheduleSessionInputPump();
			await this._sessionInputPump;
			if (this._postCompactionContinuationScheduled) {
				this._postCompactionContinuationScheduled = false;
				const shouldReschedule =
					continuationMessages.length === 0
						? this.unfinishedActionCount > 0
						: this._sessionOwnsScheduledContinuations(continuationMessages);
				if (shouldReschedule) {
					this._schedulePostCompactionContinue();
				} else {
					this._scheduledPostCompactionContinuationMessages = [];
					this._scheduleAutoRefineAfterAgentEnd();
				}
			}
			return;
		}

		this._postCompactionContinuationScheduled = false;
		try {
			await this.agent.continue();
			this._forgetConsumedPostCompactionContinuations(continuationMessages);
		} catch (error) {
			const code = error instanceof AgentContinueError ? error.code : undefined;
			if (code === "busy") {
				this._schedulePostCompactionContinue();
			} else if (code !== "nothing-to-continue") {
				// "nothing-to-continue" means the turn already completed; anything else must reject headless idle waiters.
				this._settlePostCompactionContinue(this._asError(error));
			}
		}
	}

	private _forgetConsumedPostCompactionContinuations(continuationMessages: AgentMessage[]): void {
		if (continuationMessages.length === 0) {
			return;
		}
		const continuationMessageSet = new Set(continuationMessages);
		const stillQueued = new Set(this.agent.removeQueuedMessages((message) => continuationMessageSet.has(message)));
		for (const message of stillQueued) {
			this.agent.followUp(message);
		}
		for (const message of continuationMessages) {
			if (!stillQueued.has(message)) {
				this._queuedAutonomousContinuationSnapshots.delete(message);
			}
		}
		this._postCompactionContinuationMessages = this._postCompactionContinuationMessages.filter(
			(message) => !continuationMessageSet.has(message) || stillQueued.has(message),
		);
	}

	private _shouldSkipAutoRefineForActiveAgent(): boolean {
		return this.isStreaming || this.isCompacting;
	}

	private _scheduleDeferredAutoRefineIfIdle(): void {
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent() || this._pendingAutoRefineReview) {
			return;
		}
		if (this._turnIntervalAutoRefinePending) {
			this._turnIntervalAutoRefinePending = false;
			this._scheduleAutoRefine("turn_interval");
		}
	}

	private _scheduleAutoRefine(reason: AutoRefineReason, branchVersion = this._autoRefineBranchVersion): void {
		const timer = setTimeout(() => {
			this._scheduledAutoRefineTimers.delete(timer);
			if (branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			const operation = this._maybeAutoRefine(reason);
			this._autoRefineOperations.add(operation);
			void operation.finally(() => this._autoRefineOperations.delete(operation)).catch(() => undefined);
		}, 0);
		this._scheduledAutoRefineTimers.add(timer);
	}

	private async _maybeAutoRefine(reason: AutoRefineReason): Promise<void> {
		if (this._disposed || this._disposing) {
			this._discardPendingAutoRefine();
			return;
		}
		if (!this._autoRefineAllowedForSession()) {
			this._discardPendingAutoRefine();
			return;
		}
		if (this._pendingAvoCanonicalDelivery() || this._avoRuntime?.getState().status === "completed") {
			this._discardPendingAutoRefine();
			return;
		}

		const settings = this.settingsManager.getAutoRefineSettings();
		if (!settings.enabled) {
			this._discardPendingAutoRefine();
			return;
		}
		if (this._autoRefineInProgress || this._shouldSkipAutoRefineForActiveAgent()) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}

		const nowMs = Date.now();
		const underCooldown =
			this._lastAutoRefineReviewAt > 0 && nowMs - this._lastAutoRefineReviewAt < settings.cooldownMs;

		const pendingReview = this._pendingAutoRefineReview;
		if (pendingReview) {
			// A failed refine stamps the cooldown; keep the pending review for later.
			if (underCooldown) {
				return;
			}
			await this._runApprovedRefine(pendingReview.reason, pendingReview.review);
			return;
		}

		if (reason === "compact" && !settings.compact) {
			this._compactAutoRefinePending = false;
			reason = "turn_interval";
		}
		if (reason === "turn_interval" && this._assistantTurnsSinceAutoRefine < settings.turnInterval) {
			return;
		}
		if (underCooldown) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			} else {
				this._turnIntervalAutoRefinePending = true;
			}
			return;
		}
		if (reason === "turn_interval") {
			this._turnIntervalAutoRefinePending = false;
		}
		if (!this.model) {
			if (reason === "compact") {
				this._compactAutoRefinePending = true;
			}
			return;
		}
		this._autoRefineInProgress = true;
		const turnsSinceLastReview = this._assistantTurnsSinceAutoRefine;
		const branchVersion = this._autoRefineBranchVersion;
		const reviewAbort = new AbortController();
		this._autoRefineReviewAbort = reviewAbort;
		let approvedReview: AutoRefineReview | undefined;
		try {
			const review = await this._reviewAutoRefine({ reason, turnsSinceLastReview }, reviewAbort.signal);
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			if (!review.shouldRefine) {
				const preserveTurnIntervalReview =
					reason === "compact" && this._assistantTurnsSinceAutoRefine >= settings.turnInterval;
				if (preserveTurnIntervalReview) {
					this._turnIntervalAutoRefinePending = true;
				} else {
					this._lastAutoRefineReviewAt = nowMs;
					this._assistantTurnsSinceAutoRefine = 0;
				}
				if (reason === "compact") {
					this._compactAutoRefinePending = false;
				}
				return;
			}
			if (this._shouldSkipAutoRefineForActiveAgent()) {
				this._pendingAutoRefineReview = { reason, review };
				return;
			}
			approvedReview = review;
		} catch {
			// Failed review: stamp the cooldown so a persistent failure (bad auth,
			// unparseable output) doesn't retry a full review on every agent end.
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
			}
		} finally {
			if (this._autoRefineReviewAbort === reviewAbort) {
				this._autoRefineReviewAbort = undefined;
			}
			this._autoRefineInProgress = false;
			// When a refine follows, _runApprovedRefine schedules the deferred pass.
			if (!approvedReview) {
				this._scheduleDeferredAutoRefineIfIdle();
			}
		}
		if (approvedReview) {
			await this._runApprovedRefine(reason, approvedReview);
		}
	}

	private async _runApprovedRefine(reason: AutoRefineReason, review: AutoRefineReview): Promise<void> {
		this._autoRefineInProgress = true;
		try {
			await this.refine({ instructions: autoRefineInstructions(reason, review) }, { trigger: "auto" });
			this._pendingAutoRefineReview = undefined;
			this._turnIntervalAutoRefinePending = false;
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			if (reason === "compact") {
				this._compactAutoRefinePending = false;
			}
		} catch (error) {
			// Auto-refine is opportunistic; manual /refine remains available.
			// Stamp the cooldown so a persistently failing refine doesn't retry
			// (via a retained pending review) on every agent end.
			this._lastAutoRefineReviewAt = Date.now();
			if (error instanceof RefineSkippedError) {
				// A skipped round is consumed like a reviewer decline, not retained for retry.
				this._pendingAutoRefineReview = undefined;
				this._turnIntervalAutoRefinePending = false;
				this._assistantTurnsSinceAutoRefine = 0;
				if (reason === "compact") this._compactAutoRefinePending = false;
			}
		} finally {
			this._autoRefineInProgress = false;
			this._scheduleDeferredAutoRefineIfIdle();
		}
	}

	private async _reviewAutoRefine(context: AutoRefineReviewRequest, signal?: AbortSignal): Promise<AutoRefineReview> {
		if (this._autoRefineReviewer) {
			return this._autoRefineReviewer(context, signal);
		}
		const model = this.model;
		if (!model) {
			return { shouldRefine: false, rationale: "No model selected." };
		}
		const { apiKey, headers } = await this._getRequiredRequestAuth(model);
		return reviewAutoRefine(
			this.agent.state.messages,
			this._loadMergedHarnessState(),
			this._loadRefinementHistory(),
			model,
			apiKey,
			context,
			headers,
			signal,
			this.thinkingLevel,
		);
	}

	/** Global harness state overlaid with this session's local state, when persisted. */
	private _loadMergedHarnessState(): HarnessState {
		const localHarnessStateDir = this._localHarnessStateDir();
		return mergeHarnessStates(
			loadHarnessState(getGlobalHarnessStateDir(), "global"),
			localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined,
		);
	}

	private _loadRefinementHistory(): RefinementResult[] {
		return mergeRefinementHistory(
			loadGlobalRefinementHistory(getGlobalHarnessStateDir()),
			getRefinementHistory(this.sessionManager.getEntries().filter((entry) => entry.type === "custom")),
		);
	}

	/**
	 * Refine editable continual harness state: prompt notes, memory, skills, and subagent specs.
	 * The base system prompt is intentionally not editable through this path.
	 *
	 * Planning runs in the background and does NOT block turn entry points
	 * (`_waitForRefineIdle` only waits for `_refineInFlight`). Only the fast
	 * application phase (disk I/O + in-memory mutation) blocks turn entry points.
	 */
	async refine(
		options: {
			instructions?: string;
			rollbackId?: string;
			global?: boolean;
		} = {},
		internal: { skipAbort?: boolean; trigger?: "manual" | "auto" } = {},
	): Promise<RefinementResult> {
		// Queued /refine executes from the session-input pump between turns;
		// refine never aborts the agent (planning is backgrounded and the apply
		// phase waits for quiescence), so skipAbort only asserts the pump's
		// idle invariant instead of changing abort behavior.
		if (internal.skipAbort && this.isStreaming) {
			throw new Error("Cannot refine without aborting while the agent is running.");
		}
		// Wait for any existing refine (both planning and application) before
		// starting a new run. This serializes concurrent /refine calls so two
		// planning phases cannot race into concurrent _applyRefine calls that
		// overwrite harness state.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else {
				// A serialized background plan is in flight (started during an
				// active turn at message_end). Wait for planning and for the active
				// turn to settle so its normal checkpoint can consume the plan.
				const serializedPlanInFlight = this._serializedPlanInFlight;
				await serializedPlanInFlight;
				if (this._refineInFlight || this._refinePlanInFlight) {
					continue;
				}
				await this.agent.waitForIdle();
				// Aborted turns skip shouldStopAfterTurn. Drop their settled plan
				// after idle so a later public refine cannot spin on it forever.
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
		}

		const refineAbort = new AbortController();
		this._refineAbortController = refineAbort;

		const planRun = this._planRefine(options, refineAbort.signal, internal.trigger ?? "manual");
		const planSettled = planRun.then(
			() => undefined,
			() => undefined,
		);
		this._refinePlanInFlight = planSettled;
		let plan: RefinementPlan;
		try {
			plan = await planRun;
		} catch (e) {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			this._scheduleSessionInputPump();
			throw e;
		} finally {
			if (this._refinePlanInFlight === planSettled) {
				this._refinePlanInFlight = undefined;
			}
		}

		// Block new turns before waiting for the current turn to finish. One shared
		// settled promise covers the full transition and apply critical section.
		let resolveApplySettled: () => void = () => {};
		const applySettled = new Promise<void>((resolve) => {
			resolveApplySettled = resolve;
		});
		this._refineInFlight = applySettled;
		try {
			// Wait for the session to become quiescent before applying. Planning is
			// allowed to overlap active user work, but application must not disconnect
			// event handling until that work and its queued events have completed.
			await this.agent.waitForIdle();
			while (true) {
				const eventQueue = this._agentEventQueue;
				const compactionOp = this._compactionOperation;
				const branchSummaryOp = this._branchSummaryOperation;
				await Promise.allSettled([
					eventQueue,
					...(compactionOp ? [compactionOp] : []),
					...(branchSummaryOp ? [branchSummaryOp] : []),
				]);
				if (
					eventQueue === this._agentEventQueue &&
					compactionOp === this._compactionOperation &&
					branchSummaryOp === this._branchSummaryOperation
				) {
					break;
				}
			}
			if (this._disposed || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			return await this._applyRefine(plan, options, refineAbort);
		} finally {
			resolveApplySettled();
			if (this._refineInFlight === applySettled) {
				this._refineInFlight = undefined;
			}
			this._scheduleSessionInputPump();
		}
	}

	/**
	 * Block a new agent turn until any in-flight refine application phase has
	 * reattached event handling; otherwise the turn's messages are never
	 * persisted or rendered.
	 *
	 * The idle-wait and application phase (`_refineInFlight`) block here. The
	 * background planning phase (`_refinePlanInFlight`) does NOT block turns.
	 * Refine failures surface to the refine caller, not here.
	 */
	private async _waitForRefineIdle(): Promise<void> {
		while (this._refineInFlight) {
			await this._refineInFlight;
		}
	}

	/**
	 * Background planning phase: runs the LLM planning call via `planRefinement`.
	 * Does not disconnect from or abort the agent. Returns the plan without
	 * applying anything.
	 */
	private async _planRefine(
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		signal: AbortSignal,
		trigger: "manual" | "auto" = "manual",
	): Promise<RefinementPlan> {
		if (this._disposed) {
			throw new Error("Cannot refine a disposed session.");
		}

		if (!this.model) {
			throw new Error(formatNoModelSelectedMessage());
		}

		const model = this.model;
		const { apiKey, headers } = await this._getRequiredRequestAuth(model);
		const globalHarnessStateDir = getGlobalHarnessStateDir();
		const localHarnessStateDir = this._localHarnessStateDir();
		const requestedScope = options.global ? "global" : "local";
		if (!options.rollbackId && requestedScope === "local" && !localHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const globalPlanningState = loadHarnessState(globalHarnessStateDir, "global");
		const localPlanningState = localHarnessStateDir ? loadHarnessState(localHarnessStateDir, "local") : undefined;
		const planningState =
			requestedScope === "global"
				? globalPlanningState
				: mergeHarnessStates(globalPlanningState, localPlanningState);
		const history = this._loadRefinementHistory();
		const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
		let baselineScope = rollbackTarget
			? (inferRefinementResultScope(rollbackTarget) ?? requestedScope)
			: requestedScope;
		let baselineHarnessStateDir = baselineScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
		if (rollbackTarget?.harnessStatePath) {
			baselineHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
			baselineScope = resolve(baselineHarnessStateDir) === resolve(globalHarnessStateDir) ? "global" : "local";
		}
		if (!baselineHarnessStateDir) {
			throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
		}
		const baselineState = rollbackTarget
			? loadHarnessState(baselineHarnessStateDir, baselineScope)
			: baselineScope === "global"
				? globalPlanningState
				: localPlanningState!;
		if (!options.rollbackId && this._extensionRunner.hasHandlers("session_before_refine")) {
			const result = (await this._extensionRunner.emit({
				type: "session_before_refine",
				preparation: {
					trigger,
					instructions: options.instructions,
					scope: requestedScope,
					planningState,
					history,
					conversationText: serializeConversation(convertToLlm(this.agent.state.messages)).slice(-80_000),
				},
				signal,
			})) as SessionBeforeRefineResult | undefined;
			if (this._disposed || signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			if (result?.skip) {
				throw new RefineSkippedError("Refinement skipped by extension");
			}
			if (result?.proposal !== undefined) {
				return {
					proposal: normalizeRefinementProposal(result.proposal),
					id: generateRefinementId(),
					baselineState,
				};
			}
		}
		const plan = await planRefinement(
			this.agent.state.messages,
			planningState,
			history,
			model,
			apiKey,
			options,
			headers,
			signal,
			this.thinkingLevel,
		);
		if (this._disposed || signal.aborted) {
			throw new Error("Refinement cancelled because the session was disposed.");
		}
		return { ...plan, baselineState };
	}

	private _recordRefinementOutcome(result: RefinementResult): void {
		const message = createRefinementOutcomeMessage(result);
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch {
			// Not in the session file, so context rebuilds would drop the outcome.
			this._unpersistedOutcomes.push(message);
		}
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	/**
	 * Synchronous application phase: disconnects from the agent, aborts any
	 * in-flight agent run, applies the refinement plan to disk and memory, then
	 * reconnects. This is the only phase that blocks turn entry points.
	 */
	private async _applyRefine(
		plan: RefinementPlan,
		options: { instructions?: string; rollbackId?: string; global?: boolean },
		refineAbort: AbortController,
	): Promise<RefinementResult> {
		if (this._disposed) {
			throw new Error("Cannot refine a disposed session.");
		}
		// The caller has already set _refineInFlight and waited for agent idle.
		// Disconnect only for the brief apply + save + reconnect critical section.
		this._disconnectFromAgent();

		try {
			const globalHarnessStateDir = getGlobalHarnessStateDir();
			const localHarnessStateDir = this._localHarnessStateDir();
			const requestedScope = options.global ? "global" : "local";
			const history = this._loadRefinementHistory();
			const rollbackTarget = options.rollbackId ? history.find((item) => item.id === options.rollbackId) : undefined;
			let targetScope = plan.rollbackScope ?? requestedScope;
			let targetHarnessStateDir = targetScope === "global" ? globalHarnessStateDir : localHarnessStateDir;
			if (targetScope === "local" && rollbackTarget?.harnessStatePath) {
				if (!existsSync(rollbackTarget.harnessStatePath)) {
					throw new Error(
						`Local refinement ${rollbackTarget.id} state file not found: ${rollbackTarget.harnessStatePath}`,
					);
				}
				targetHarnessStateDir = dirname(rollbackTarget.harnessStatePath);
				// Legacy records predate scope fields and default to "local" but may point
				// at the global store; honor the recorded path so its entries stay global.
				if (resolve(targetHarnessStateDir) === resolve(globalHarnessStateDir)) {
					targetScope = "global";
				}
			}
			if (!targetHarnessStateDir) {
				throw new Error("Local harness refinement requires a persisted session; use global refinement instead.");
			}
			// Re-read the target state immediately before applying so concurrent kernel
			// (`rlm.harness`) writes during the LLM pass are not clobbered.
			const state = loadHarnessState(targetHarnessStateDir, targetScope);
			const proposal = {
				...plan.proposal,
				edits: plan.proposal.edits.map((edit) => {
					const localPrefix = "local:";
					const globalPrefix = "global:";
					return {
						...edit,
						id: edit.id?.startsWith(localPrefix)
							? edit.id.slice(localPrefix.length)
							: edit.id?.startsWith(globalPrefix)
								? edit.id.slice(globalPrefix.length)
								: edit.id,
					};
				}),
			};
			if (this._disposed || refineAbort.signal.aborted) {
				throw new Error("Refinement cancelled because the session was disposed.");
			}
			const result = applyRefinementProposal(state, proposal, {
				id: plan.id,
				rollbackOf: plan.rollbackOf,
				scope: targetScope,
				baselineState: plan.baselineState,
			});
			result.harnessStatePath = saveHarnessState(targetHarnessStateDir, state);
			if (targetScope === "global") {
				appendGlobalRefinement(globalHarnessStateDir, result);
			}
			let refinementAuditAppendError: { error: unknown } | undefined;
			try {
				this.sessionManager.appendCustomEntry("prime-agent.refinement", result);
			} catch (error) {
				refinementAuditAppendError = { error };
			}
			try {
				this._recordRefinementOutcome(result);
			} catch (error) {
				if (!refinementAuditAppendError) throw error;
			}
			if (refinementAuditAppendError) throw refinementAuditAppendError.error;
			this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
			this.agent.state.systemPrompt = this._baseSystemPrompt;
			try {
				this._emit({ type: "refine_complete", result });
			} catch {
				// Listener failures must not flip a successful refinement into
				// a reported failure — the refinement is already persisted.
			}
			try {
				await this._extensionRunner.emit({
					type: "refine_complete",
					id: result.id,
					summary: result.summary,
					appliedEdits: result.appliedEdits.filter((edit) => edit.applied).length,
					scope: result.scope ?? "local",
				});
			} catch {
				// Extension emit failures must not flip a successful refinement
				// into a reported failure — the refinement is already persisted.
			}
			return result;
		} finally {
			if (this._refineAbortController === refineAbort) {
				this._refineAbortController = undefined;
			}
			if (!this._disposed) {
				this._reconnectToAgent();
			}
		}
	}

	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
	 * 2. Threshold: Context over threshold, compact, and continue only for stopped in-progress loops or queued messages
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private _getThresholdContextTokens(
		assistantMessage: AssistantMessage,
		compactionTimestamp: number | undefined,
	): number | undefined {
		const messages = this.agent.state.messages;
		const estimate = estimateContextTokens(messages);
		if (estimate.lastUsageIndex !== null) {
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionTimestamp !== undefined &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= compactionTimestamp
			) {
				return undefined;
			}
			return estimate.tokens;
		}
		if (assistantMessage.stopReason === "error") return undefined;
		return calculateContextTokens(assistantMessage.usage);
	}

	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		queueAutonomousContinuation = true,
	): Promise<boolean> {
		const avoDelivery = this._avoRuntime?.getState().delivery;
		if (
			avoDelivery &&
			(avoDelivery.phase === "pending" || avoDelivery.phase === "delivered" || avoDelivery.phase === "failed")
		) {
			this._pendingRequestedCompaction = undefined;
			return false;
		}
		// An abort drops any compaction the model requested this turn, even on the
		// pre-prompt path (skipAbortedCheck=false) which continues to threshold checks.
		if (assistantMessage.stopReason === "aborted") {
			this._pendingRequestedCompaction = undefined;
			// An abort also drops any pending explicit refine.run request: the
			// turn that would service it (non-serialized: _consumePendingRequestedRefine
			// at agent_end; serialized: the shouldStopAfterTurn checkpoint) never
			// runs for an aborted turn, so a stale request would leak into the
			// next turn or checkpoint.
			this._pendingRequestedRefine = undefined;
			if (this._serializedPlanInFlight) {
				const serializedPlanInFlight = this._serializedPlanInFlight;
				this._autoRefineBranchVersion++;
				this._refineAbortController?.abort();
				await serializedPlanInFlight.catch(() => undefined);
				if (this._serializedPlanInFlight === serializedPlanInFlight) {
					this._serializedPlanInFlight = undefined;
					this._serializedExplicitRefineOptions = undefined;
				}
			}
			if (skipAbortedCheck) return false;
		}

		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip overflow/threshold checks if this assistant message is older than the
		// latest compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const compactionTimestamp = compactionEntry ? new Date(compactionEntry.timestamp).getTime() : undefined;
		const assistantIsFromBeforeCompaction =
			compactionTimestamp !== undefined && assistantMessage.timestamp <= compactionTimestamp;

		// Case 1: Overflow - takes priority over a pending model request so the error
		// strip + retry still happen; the compaction it runs consumes the request.
		if (
			!assistantIsFromBeforeCompaction &&
			(settings.enabled || this._pendingRequestedCompaction !== undefined) &&
			sameModel &&
			isContextOverflow(assistantMessage, contextWindow)
		) {
			if (this._overflowRecovery !== "idle") {
				if (this._overflowRecovery === "attempted") {
					this._overflowRecovery = "reported";
					this._endCompactionUnsuccessfully(
						"overflow",
						"failed",
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
					);
				}
				return false;
			}

			this._overflowRecovery = "attempted";
			// Remove the error message from agent state (it IS saved to session for history,
			// but we don't want it in context for the retry)
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", true);
		}

		if (this._pendingRequestedCompaction !== undefined) {
			return await this._runAutoCompaction("requested", false);
		}

		if (!settings.enabled || assistantIsFromBeforeCompaction) return false;

		// Case 3: Threshold - context is getting large.
		// Use the full-session estimate so messages appended after the last successful
		// assistant usage are included, matching the /usage context display.
		const contextTokens = this._getThresholdContextTokens(assistantMessage, compactionTimestamp);
		if (contextTokens === undefined) return false;
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			const canonicalAvoDeliveryCompleted =
				this._enforceAvoCompletion && this._avoRuntime?.getState().status === "completed";
			if (
				queueAutonomousContinuation &&
				!this._continueAfterThresholdCompaction &&
				!canonicalAvoDeliveryCompleted &&
				this._queueGoalContinuationForThresholdCompaction(assistantMessage)
			) {
				this._continueAfterThresholdCompaction = true;
			} else if (
				queueAutonomousContinuation &&
				!this._continueAfterThresholdCompaction &&
				!canonicalAvoDeliveryCompleted &&
				(await this._queueAutonomousContinuationForThresholdCompaction(assistantMessage))
			) {
				this._continueAfterThresholdCompaction = true;
			}
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run automatic (threshold/overflow) or model-requested compaction
	 * with events.
	 */
	private _endCompactionUnsuccessfully(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
		options: {
			aborted?: boolean;
			errorSeverity?: "warning" | "error";
			customInstructions?: string;
		} = {},
	): void {
		this._persistCompactionOutcome(reason, outcome, message);
		this._emit({
			type: "compaction_end",
			reason,
			result: undefined,
			aborted: options.aborted ?? false,
			willRetry: false,
			// Aborts are user-initiated; they carry no error message on the event.
			errorMessage: options.aborted ? undefined : message,
			errorSeverity: options.errorSeverity,
			customInstructions: options.customInstructions,
		});
	}

	private _persistCompactionOutcome(
		reason: CompactionOutcomeReason,
		outcome: CompactionOutcome,
		message: string,
	): void {
		let outcomeMessage = createCompactionOutcomeMessage(message, {
			reason,
			outcome,
		});
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				outcomeMessage.customType,
				outcomeMessage.content,
				outcomeMessage.display,
				outcomeMessage.details,
			);
		} catch (error) {
			const persistenceError = error instanceof Error ? error.message : String(error);
			outcomeMessage = createCompactionOutcomeMessage(
				`${message}\n\nThis compaction outcome could not be saved to session history: ${persistenceError}`,
				{ reason, outcome },
			);
			// Not in the session file, so context rebuilds would drop the disclosure.
			this._unpersistedOutcomes.push(outcomeMessage);
		}
		this.agent.state.messages.push(outcomeMessage);
		this._emit({ type: "message_start", message: outcomeMessage });
		this._emit({ type: "message_end", message: outcomeMessage });
	}

	private async _runAutoCompaction(
		reason: "overflow" | "threshold" | "requested",
		willRetry: boolean,
	): Promise<boolean> {
		// Any compaction consumes a pending model request and honors its instructions
		// (overflow recovery can fire first and take the request with it).
		const pending = this._pendingRequestedCompaction;
		this._pendingRequestedCompaction = undefined;
		const customInstructions = pending?.customInstructions;
		const shouldContinueAfterCompaction =
			(reason === "threshold" || reason === "requested") && this._continueAfterThresholdCompaction;
		const queuedAutonomousContinuationsForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction
				? this._pendingThresholdCompactionAutonomousMessages.splice(0)
				: [];
		const queuedGoalContinuationForThisCompaction =
			reason === "threshold" && shouldContinueAfterCompaction ? this._queuedGoalThresholdContinuation : undefined;
		this._continueAfterThresholdCompaction = false;

		// Requested/threshold stop the loop on purpose, so a failed or skipped compaction must not stall it.
		// Overflow stays excluded: a failed overflow recovery must not re-issue the overflowing request.
		const resumeAfterFailure = () => {
			if (
				(reason === "requested" || reason === "threshold") &&
				(shouldContinueAfterCompaction || this.agent.hasQueuedMessages() || this.hasPendingSessionWork)
			) {
				this._schedulePostCompactionContinue();
			}
		};

		this._emit({ type: "compaction_start", reason, customInstructions });
		this._autoCompactionAbortController = new AbortController();

		try {
			const authResult = this.model ? await this._modelRegistry.getApiKeyAndHeaders(this.model) : undefined;
			if (!this.model || !authResult || !authResult.ok || !authResult.apiKey) {
				const detail =
					!this.model || !authResult
						? "no model is selected"
						: authResult.ok
							? "no API key is available"
							: authResult.error;
				this._endCompactionUnsuccessfully(reason, "failed", `Compaction failed: ${detail}`);
				this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
					reason === "threshold" && shouldContinueAfterCompaction,
					queuedAutonomousContinuationsForThisCompaction,
				);
				resumeAfterFailure();
				return false;
			}

			const result = await this._performCompaction({
				model: this.model,
				apiKey: authResult.apiKey,
				headers: authResult.headers,
				customInstructions,
				signal: this._autoCompactionAbortController.signal,
			});

			this._emit({
				type: "compaction_end",
				reason,
				result,
				aborted: false,
				willRetry,
				customInstructions,
			});
			// Queued work lives in both the agent queues and the session-owned queues.
			const hasQueuedMessages = this.agent.hasQueuedMessages() || this.hasPendingSessionWork;
			const willContinueAfterCompaction = willRetry || shouldContinueAfterCompaction || hasQueuedMessages;

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				if (lastMsg?.role === "assistant" && (lastMsg as AssistantMessage).stopReason === "error") {
					this.agent.state.messages = messages.slice(0, -1);
				}

				this._schedulePostCompactionContinue();
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
				return true;
			} else if (shouldContinueAfterCompaction || hasQueuedMessages) {
				// Compaction can intentionally stop a tool loop between turns.
				// Queued follow-up/steering/custom messages can also be waiting.
				this._schedulePostCompactionContinue();
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
			} else {
				this._scheduleAutoRefineAfterCompaction(willContinueAfterCompaction);
			}
			return false;
		} catch (error) {
			this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
				reason === "threshold" && shouldContinueAfterCompaction,
				queuedAutonomousContinuationsForThisCompaction,
			);
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			const aborted =
				errorMessage === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			if (aborted) {
				this._clearQueuedGoalContinuationAfterCancelledThresholdCompaction(queuedGoalContinuationForThisCompaction);
				this._endCompactionUnsuccessfully(
					reason,
					"cancelled",
					`${reason === "requested" ? "Requested c" : "C"}ompaction cancelled`,
					{ aborted: true, customInstructions },
				);
				return false;
			}
			if (error instanceof CompactionSkippedError) {
				this._endCompactionUnsuccessfully(
					reason,
					"skipped",
					reason === "requested"
						? `Requested compaction skipped: ${errorMessage}`
						: `Auto-compaction skipped: ${errorMessage}`,
					{ errorSeverity: "warning", customInstructions },
				);
				resumeAfterFailure();
				return false;
			}
			this._endCompactionUnsuccessfully(
				reason,
				"failed",
				reason === "overflow"
					? `Context overflow recovery failed: ${errorMessage}`
					: reason === "requested"
						? `Requested compaction failed: ${errorMessage}`
						: `Auto-compaction failed: ${errorMessage}`,
				{ customInstructions },
			);
			resumeAfterFailure();
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
			this._scheduleSessionInputPump();
		}
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	/**
	 * Set the provider for extra env vars merged over process.env in extension
	 * pi.exec() subprocesses. The function is read at exec time, so a host (e.g.
	 * the daemon) can update the underlying value per attach without rebinding.
	 */
	setExecEnvProvider(provider: (() => Record<string, string | undefined> | undefined) | undefined): void {
		this._execEnvProvider = provider;
		const extensions = this._resourceLoader.getExtensions();
		extensions.runtime.getExecEnv = provider;
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: {
			source: string;
			scope: "temporary";
			origin: "top-level";
			baseDir?: string;
		};
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRegistry.find(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					this.sessionManager.appendCustomEntry(customType, data);
				},
				setSessionName: async (name) => {
					if (this._agentMessageController?.setSessionName) {
						await this._agentMessageController.setSessionName(name);
						return;
					}
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				setModel: async (model) => {
					if (!this.modelRegistry.hasConfiguredAuth(model)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				isIdle: () => !this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => this.abort(),
				hasPendingMessages: () => this.queuedActionCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
			},
			{
				registerProvider: (name, config) => {
					this._modelRegistry.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRegistry.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();
		const allowedToolNames = this._allowedToolNames;
		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
					source: "sdk",
				}),
			})),
		];
		const isAllowedTool = (name: string): boolean => !allowedToolNames || allowedToolNames.has(name);
		const allowedCustomTools = allCustomTools.filter((tool) => isAllowedTool(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => isAllowedTool(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, {
							source: "builtin",
						}),
					},
				]),
		);
		for (const tool of allowedCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allowedCustomTools, runner);
		// Resolve the runner at call time so a rebuild/reload rebinds built-in tools to the
		// live runner instead of wedging them on the invalidated one's stale-ctx guard.
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => isAllowedTool(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			() => this._extensionRunner,
		);

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => isAllowedTool(name));

		if (allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const pythonSkills = getPythonSkillRuntimeInfo(this._modelVisibleSkills());
		let configuredBaseToolDefinitions: Record<string, ToolDefinition>;
		if (this._baseToolsOverride) {
			configuredBaseToolDefinitions = Object.fromEntries(
				Object.entries(this._baseToolsOverride).map(([name, tool]) => [
					name,
					createToolDefinitionFromAgentTool(tool),
				]),
			);
		} else {
			// Rebuilding (e.g. /reload) replaces the provisioner; drop the previous
			// kernel so the session never holds two live kernels. Gate the new kernel's
			// startup on the old one's dispose (which flushes a final snapshot), so a
			// reload can't restore from a snapshot the old kernel is still writing.
			const previousDispose = this._ipythonKernelProvisioner?.dispose();
			this._ipythonKernelSnapshotDir = this.sessionManager.getSessionArtifactDir();
			// Only surface the "revived from your previous session" notice on the first
			// build (a genuine resume). A later rebuild (/reload) restores state silently
			// for continuity — the conversation is unchanged, so there's nothing to flag.
			const notifyRestore = !this._ipythonRuntimeBuilt;
			this._ipythonKernelProvisioner = new IpythonKernelProvisioner(this._cwd, {
				env: this._rlmKernelEnv(),
				sessionId: this.sessionId,
				hostHandlers: this._createKernelHostHandlers(),
				pythonSkills,
				snapshotDir: this._ipythonKernelSnapshotDir,
				readyGate: previousDispose,
				onRestore: notifyRestore ? (result) => this._onIpythonStateRestored(result) : undefined,
			});
			configuredBaseToolDefinitions = createAllToolDefinitions(this._cwd, {
				ipython: {
					provisioner: this._ipythonKernelProvisioner,
					commandPrefix: this.settingsManager.getShellCommandPrefix(),
					shellPath: this.settingsManager.getShellPath(),
					onLateSentAgentMessage: (toolCallId, message) =>
						this._recordLateIpythonSentAgentMessage(toolCallId, message),
				},
			});
		}

		this._baseToolDefinitions = new Map(
			Object.entries(configuredBaseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}
		// Re-apply on (re)build so the provider survives /reload. Guarded: the
		// runtime object can be shared across sessions from one ResourceLoader
		// (RLM children), so a provider-less session must not wipe the owner's.
		if (this._execEnvProvider) {
			extensionsResult.runtime.getExecEnv = this._execEnvProvider;
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			this._modelRegistry,
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		const defaultActiveToolNames = this._baseToolsOverride ? Object.keys(this._baseToolsOverride) : ["ipython"];
		const baseActiveToolNames = [...(options.activeToolNames ?? defaultActiveToolNames)];
		if (this._goalState.status === "active" && this._includeGoals) {
			// An active goal needs ipython so the model can reach the goal skill.
			baseActiveToolNames.push("ipython");
		}
		this._refreshToolRegistry({
			activeToolNames: [...new Set(baseActiveToolNames)],
			includeAllExtensionTools: options.includeAllExtensionTools,
		});

		// Prewarm when configured, or whenever we're resuming a session that already
		// has a kernel snapshot — so its state is revived and the model is told what
		// came back before the first turn, rather than a turn later when the kernel
		// would otherwise lazily start on first use.
		const hasSnapshot =
			!!this._ipythonKernelSnapshotDir && existsSync(snapshotPathIn(this._ipythonKernelSnapshotDir));
		if ((this._prewarmIpythonKernel || hasSnapshot) && this.getActiveToolNames().includes("ipython")) {
			this._ipythonKernelProvisioner?.prewarm();
		}

		// Subsequent builds are in-process rebuilds (/reload), not a fresh resume.
		this._ipythonRuntimeBuilt = true;
	}

	/**
	 * Skills exposed to the model (system prompt + kernel). The bundled goal
	 * and compact skills are withheld when disabled for this session.
	 */
	private _modelVisibleSkills(): Skill[] {
		let skills = this._resourceLoader.getSkills().skills;
		if (!this._includeGoals) {
			skills = skills.filter((skill) => skill.name !== GOAL_SKILL_NAME);
		}
		if (!this._includeCompactSkill) {
			skills = skills.filter((skill) => skill.name !== COMPACT_SKILL_NAME);
		}
		if (!this._autoRefineAllowedForSession()) {
			skills = skills.filter((skill) => skill.name !== REFINE_SKILL_NAME);
		}
		if (!this._agentMessageController) {
			skills = skills.filter((skill) => skill.name !== AGENT_MESSAGE_SKILL_NAME);
		}
		if (!this._agentObserveController) {
			skills = skills.filter((skill) => skill.name !== AGENT_OBSERVE_SKILL_NAME);
		}
		if (!this._agentObserveController || !this._rlmHeartbeatController) {
			skills = skills.filter((skill) => skill.name !== ORCHESTRATION_HEARTBEAT_SKILL_NAME);
		}
		const canRunAutoresearch =
			this._rlmDepth === 0 &&
			this._rlmDepth < this._rlmMaxDepth &&
			this._agentMessageController !== undefined &&
			skills.some((skill) => skill.name === AGENT_MESSAGE_SKILL_NAME && !skill.disableModelInvocation);
		if (!canRunAutoresearch) {
			skills = skills.filter((skill) => skill.name !== AUTORESEARCH_SKILL_NAME);
		}
		if (this._rlmDepth !== 0) {
			skills = skills.filter((skill) => skill.name !== AVO_SKILL_NAME);
		}
		return skills;
	}

	private _createKernelHostHandlers(): HostRequestHandlers {
		const handlers: HostRequestHandlers = {
			"rlm.run": createRlmRunHostHandler(async ({ prompt, kwargs, cellSourceCode }) => ({
				...(await this.runRlmChild(prompt, kwargs, cellSourceCode)),
			})),
			"rlm.find_models": createRlmFindModelsHostHandler((query, limit) => this.findRlmModels(query, limit)),
			"rlm.list_subagents": createRlmListSubagentsHostHandler(() => this.listRlmSubagents()),
			"rlm.delete_subagent": createRlmDeleteSubagentHostHandler((target) => this.deleteRlmSubagent(target)),
			"model.info": async () => ({
				id: this.model?.id ?? null,
				provider: this.model?.provider ?? null,
				input: this.model?.input ?? [],
			}),
		};
		if (this._includeGoals) {
			for (const type of ["goal.get", "goal.create", "goal.complete"]) {
				handlers[type] = async (payload) => this.handleGoalHostRequest(type, payload);
			}
		}
		if (this._includeCompactSkill) {
			for (const type of ["compact.run", "compact.status"]) {
				handlers[type] = async (payload) => this.handleCompactHostRequest(type, payload);
			}
		}
		if (this._autoRefineAllowedForSession()) {
			for (const type of ["refine.run", "refine.status"]) {
				handlers[type] = async (payload) => this.handleRefineHostRequest(type, payload);
			}
		}
		if (this._rlmHeartbeatController) {
			for (const type of [
				"rlm_heartbeat.list",
				"rlm_heartbeat.create",
				"rlm_heartbeat.update",
				"rlm_heartbeat.delete",
			]) {
				handlers[type] = async (payload) => this.handleRlmHeartbeatHostRequest(type, payload);
			}
		}
		const visibleKernelSkillNames = new Set(
			this._modelVisibleSkills()
				.filter((skill) => !skill.disableModelInvocation)
				.map((skill) => skill.name),
		);
		if (this._agentMessageController && visibleKernelSkillNames.has(AGENT_MESSAGE_SKILL_NAME)) {
			Object.assign(
				handlers,
				createAgentMessageHostHandlers({
					roster: async () =>
						(await this.handleAgentMessageHostRequest("agent_message.list_agents")) as AgentFamilyRosterResult,
					awaitPendingChildPublication: (selector) => this._awaitPendingRlmChildPublication(selector),
					sendAgentMessage: async (input) => {
						const receipt = (await this.handleAgentMessageHostRequest("agent_message.send", {
							target: input.target,
							message: input.message,
						})) as AgentSessionMessageReceipt;
						if (this._rlmDepth > 0) {
							let addressedParent = input.receiverRole === "parent";
							if (input.receiverRole === undefined && this._agentMessageController?.roster) {
								try {
									const roster = await this._agentMessageController.roster();
									addressedParent = roster.entries.some(
										(entry) =>
											entry.relationship === "parent" &&
											(entry.id === input.target || entry.name === input.target),
									);
								} catch {
									addressedParent = false;
								}
							}
							if (addressedParent) {
								this._repliedToParentSinceTask = true;
								this._parentReplyCount += 1;
							}
						}
						return receipt;
					},
				}),
			);
		}
		if (this._agentObserveController) {
			Object.assign(
				handlers,
				createAgentObserveHostHandlers({
					listAgents: () => this.handleAgentObserveHostRequest("agent_observe.list") as AgentObserveListResult,
					getAgent: (target) =>
						this.handleAgentObserveHostRequest("agent_observe.get", {
							target,
						}) as AgentObserveAgentSnapshot,
					recentMessages: (input) =>
						this.handleAgentObserveHostRequest("agent_observe.recent", {
							target: input.target,
							limit: input.limit,
							max_chars: input.maxChars,
						}) as AgentObserveRecentMessagesResult,
				}),
			);
		}
		if (visibleKernelSkillNames.has(AUTORESEARCH_SKILL_NAME)) {
			for (const type of [
				"autoresearch.initialize",
				"autoresearch.get",
				"autoresearch.publication.add",
				"autoresearch.publication.verify",
				"autoresearch.publication.peer_review.verify",
				"autoresearch.search.record",
				"autoresearch.experiment.record",
				"autoresearch.memory.remember",
				"autoresearch.memory.recall",
				"autoresearch.memory.reuse.prepare",
				"autoresearch.memory.reuse.verify",
				"autoresearch.memory.reflection.record",
				"autoresearch.claim.add",
				"autoresearch.claim.update",
				"autoresearch.claim.promote",
				"autoresearch.claim.invalidate",
				"autoresearch.reviewer_prompts",
				"autoresearch.reviewers.spawn",
				"autoresearch.results.collect",
				"autoresearch.cycle.complete",
				"autoresearch.supervision.record",
				"autoresearch.supervision.retry",
				"autoresearch.stop_gate",
				"autoresearch.export",
			]) {
				handlers[type] = async (payload) => this.handleAutoresearchHostRequest(type, payload);
			}
		}
		if (visibleKernelSkillNames.has(AVO_SKILL_NAME)) {
			for (const type of AVO_HOST_REQUEST_TYPES) {
				handlers[type] = async (payload) => this.handleAvoHostRequest(type, payload);
			}
		}
		if (this._mcpManager) {
			Object.assign(handlers, this._mcpManager.hostHandlers());
		}
		return handlers;
	}

	async reload(): Promise<void> {
		const previousFlagValues = this._extensionRunner.getFlagValues();
		await emitSessionShutdownEvent(this._extensionRunner, {
			type: "session_shutdown",
			reason: "reload",
		});
		await this.settingsManager.reload();
		// Re-read auth.json: a login saved by the client process (daemon mode) must be
		// visible here so MCP skill gating sees the new credentials.
		this._modelRegistry.authStorage.reload();
		resetApiProviders();
		this._mcpManager?.refresh();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await this._extensionRunner.emit({
				type: "session_start",
				reason: "reload",
			});
			await this.extendResourcesFromExtensions("reload");
		}
	}

	private _rlmKernelEnv(): Record<string, string> {
		// Kernel env is provisioning-time only: RLM_MAX_DEPTH may be stale in an already-running kernel;
		// the TypeScript-side spawn check remains authoritative.
		const env: Record<string, string> = {
			RLM_DEPTH: String(this._rlmDepth),
			RLM_MAX_DEPTH: String(this._rlmMaxDepth),
			RLM_GLOBAL_HARNESS_STATE_DIR: getGlobalHarnessStateDir(),
		};
		const rlmSessionDir = this._ensureRlmSessionDir();
		if (rlmSessionDir) {
			env.RLM_SESSION_DIR = rlmSessionDir;
			// Keep kernel writes and host reads (system prompt, review, /refine) on
			// the same local harness path. Subagents prefer their own artifact dir;
			// ephemeral sessions fall back to the RLM session dir once it exists.
			env.RLM_HARNESS_STATE_DIR = this._localHarnessStateDir() ?? getLocalHarnessStateDir(rlmSessionDir)!;
		}
		const memoryBackend = this._avoRuntime?.store.getMemoryBackendConfig();
		if (memoryBackend) {
			env.PRIME_AGENT_AVO_MEMORY_OWNER = memoryBackend.owner;
			env.PRIME_AGENT_AVO_MEMORY_OWNER_ROLE = memoryBackend.ownerRole;
			if (memoryBackend.paths.task) env.PRIME_AGENT_AVO_MEMORY_TASK_PATH = memoryBackend.paths.task;
			if (memoryBackend.paths.project) env.PRIME_AGENT_AVO_MEMORY_PROJECT_PATH = memoryBackend.paths.project;
			if (memoryBackend.paths.global) env.PRIME_AGENT_AVO_MEMORY_GLOBAL_PATH = memoryBackend.paths.global;
		}
		this._addWebsearchKeyEnv(env);
		return env;
	}

	private _addWebsearchKeyEnv(env: Record<string, string>): void {
		if (this._agentDir) {
			env.PRIME_AGENT_CODING_AGENT_DIR = this._agentDir;
		}

		if (process.env[SERPER_ENV_VAR]?.trim()) {
			return;
		}
		// Inject only when a websearch skill (bundled or custom) is actually loaded,
		// so the key isn't exposed to kernels that can't use it.
		if (!this._resourceLoader.getSkills().skills.some((skill) => skill.name === WEBSEARCH_SKILL_NAME)) {
			return;
		}
		const cred = this._modelRegistry.authStorage.get(SERPER_CREDENTIAL_ID);
		if (cred?.type !== "api_key") {
			return;
		}
		const resolved = resolveConfigValue(cred.key)?.trim();
		if (resolved) {
			env[SERPER_ENV_VAR] = resolved;
		}
	}

	// Undefined when there's no persistent artifact dir (e.g. the viewer client):
	// don't mkdtemp here, since this runs on every kernel build but a viewer never
	// does RLM work. The temp dir is created lazily in _createChildRlmSessionDir.
	private _ensureRlmSessionDir(): string | undefined {
		if (this._rlmSessionDir) {
			mkdirSync(this._rlmSessionDir, { recursive: true });
			return this._rlmSessionDir;
		}

		const sessionArtifactDir = this.sessionManager.getSessionArtifactDir();
		if (sessionArtifactDir) {
			mkdirSync(sessionArtifactDir, { recursive: true });
			this._rlmSessionDir = sessionArtifactDir;
			return sessionArtifactDir;
		}

		return undefined;
	}

	private _createChildRlmSessionDir(): string {
		const parentDir = this._ensureRlmSessionDir() ?? this._createEphemeralRlmSessionDir();
		for (let i = 0; i < 100; i++) {
			const childDir = join(parentDir, `sub-${randomUUID().slice(0, 8)}`);
			try {
				mkdirSync(childDir);
				return childDir;
			} catch (error) {
				if (error instanceof Error && "code" in error && error.code === "EEXIST") {
					continue;
				}
				throw error;
			}
		}
		throw new Error("Unable to create unique RLM child session directory");
	}

	private _createEphemeralRlmSessionDir(): string {
		this._rlmSessionDir = mkdtempSync(join(tmpdir(), "prime-agent-rlm-"));
		return this._rlmSessionDir;
	}

	_contextTokensForCurrentMessages(): number | undefined {
		const last = this._findLastAssistantMessage();
		return last ? calculateContextTokens(last.usage) : undefined;
	}

	setCurrentRecap(recap: string | undefined): void {
		if (this._currentRecap === recap) return;
		this._currentRecap = recap;
		this._emit({ type: "recap_update", recap });
	}

	get repliedToParentSinceTask(): boolean | undefined {
		return this._repliedToParentSinceTask;
	}

	getCurrentRecap(): string | undefined {
		return this._currentRecap;
	}

	private _findAssistantEntryForMessage(message: AssistantMessage): SessionMessageEntry | undefined {
		return this.sessionManager
			.getEntries()
			.find((entry): entry is SessionMessageEntry => entry.type === "message" && entry.message === message);
	}

	private _createRlmSubagentRuntimeOptions(options: {
		id: string;
		prompt: string;
		sessionName: string;
		spawnCode?: string;
		sessionDir: string;
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
		allowedToolNames?: string[];
	}): CreateRlmSubagentRuntimeOptions {
		return {
			parentSession: this,
			id: options.id,
			prompt: options.prompt,
			sessionName: options.sessionName,
			spawnCode: options.spawnCode,
			sessionDir: options.sessionDir,
			model: options.model,
			thinkingLevel:
				options.thinkingLevel ?? (clampThinkingLevel(options.model, this.thinkingLevel) as ThinkingLevel),
			serviceTier:
				this.serviceTier === "priority" && !supportsFastMode(options.model) ? "default" : this.serviceTier,
			scopedModels: [...this._scopedModels],
			activeToolNames: this.getActiveToolNames(),
			allowedToolNames:
				options.allowedToolNames ?? (this._allowedToolNames ? [...this._allowedToolNames] : undefined),
			customTools: [...this._customTools],
			includeGoals: this._includeGoals,
			includeCompactSkill: this._includeCompactSkill,
			rlmDepth: this._rlmDepth + 1,
			rlmMaxDepth: this._rlmMaxDepth,
			rlmParentNodeId: options.id,
		};
	}

	private async _createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		if (this._subagentRuntimeHost) {
			return await this._subagentRuntimeHost.createRlmSubagentRuntime(options);
		}

		return this._createInlineRlmSubagentRuntime(options);
	}

	private _createInlineRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): RlmSubagentRuntime {
		const childSessionManager = SessionManager.create(this._cwd, options.sessionDir);
		if (options.parentSession.sessionFile) {
			childSessionManager.newSession({
				parentSession: options.parentSession.sessionFile,
				rlmDepth: options.rlmDepth,
			});
		}
		childSessionManager.appendModelChange(options.model.provider, options.model.id);
		childSessionManager.appendThinkingLevelChange(options.thinkingLevel);
		childSessionManager.appendServiceTierChange(options.serviceTier);

		const childAgent = new Agent({
			initialState: {
				systemPrompt: "",
				model: options.model,
				thinkingLevel: options.thinkingLevel,
				serviceTier: options.serviceTier,
				tools: [],
			},
			convertToLlm: this.agent.convertToLlm,
			transformContext: this.agent.transformContext,
			streamFn: this.agent.streamFn,
			getApiKey: this.agent.getApiKey,
			onPayload: this.agent.onPayload,
			onResponse: this.agent.onResponse,
			steeringMode: this.settingsManager.getSteeringMode(),
			followUpMode: this.settingsManager.getFollowUpMode(),
			sessionId: childSessionManager.getSessionId(),
			thinkingBudgets: this.settingsManager.getThinkingBudgets(),
			transport: this.settingsManager.getTransport(),
			maxRetryDelayMs: this.settingsManager.getProviderRetrySettings().maxRetryDelayMs,
			toolExecution: this.agent.toolExecution,
		});

		const child = new AgentSession({
			agent: childAgent,
			sessionManager: childSessionManager,
			settingsManager: this.settingsManager,
			cwd: this._cwd,
			agentDir: this._agentDir,
			scopedModels: options.scopedModels,
			resourceLoader: this._resourceLoader,
			customTools: options.customTools,
			modelRegistry: this._modelRegistry,
			initialActiveToolNames: options.activeToolNames,
			allowedToolNames: options.allowedToolNames,
			includeGoals: options.includeGoals,
			includeCompactSkill: options.includeCompactSkill,
			rlmDepth: options.rlmDepth,
			rlmMaxDepth: options.rlmMaxDepth,
			rlmSessionDir: options.sessionDir,
			rlmParentNodeId: options.rlmParentNodeId,
			rlmParentAgent: options.parentSession.sessionName ?? options.parentSession.sessionId,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		if (child.sessionName !== options.sessionName) {
			try {
				child.setSessionName(options.sessionName);
			} catch (error) {
				child.dispose();
				throw error;
			}
		}
		options.onSessionPublished?.(child);

		return { session: child };
	}

	private _abandonRlmRunForQuiescence(run: RlmChildRun): void {
		run.suppressTerminalNotice = true;
		run.abandonedForQuiescence = true;
		this._abandonedRlmQuiescenceChildIds.add(run.id);
		this._unsettledRlmChildRuns.delete(run);
		run.settlement.resolve();
		this._maybeResumeGoalContinuationAfterRlmWork();
	}

	private _cancelActiveRlmChildRuns(reason: string): void {
		for (const run of this._activeRlmChildRuns.values()) {
			this._cancelRlmChildRun(run, reason);
		}
	}

	private _cancelRlmChildRun(run: RlmChildRun, reason: string): boolean {
		if (run.status !== "running" && run.status !== "queued") {
			return false;
		}
		run.status = "cancelled";
		if (this._sessionInputPumpSuspended) this._abandonRlmRunForQuiescence(run);
		run.error = reason;
		run.publication.reject(new Error(reason));
		run.abort();
		// Surface the cancellation immediately; the run's own terminal update is
		// delayed indefinitely when the child is stuck mid-stream, which is
		// exactly when users reach for the kill.
		run.emitUpdate?.();
		return true;
	}

	getRlmChildRunStatus(childId: string): RlmChildAgentStatus | undefined {
		return this._activeRlmChildRuns.get(childId)?.status;
	}

	private async _currentActiveSessionId(): Promise<string | undefined> {
		try {
			return (await this._agentMessageController?.listAgents())?.current?.activeSessionId;
		} catch {
			return undefined;
		}
	}

	private async _awaitPendingRlmChildPublication(selector: string): Promise<string | undefined> {
		const run = [...this._activeRlmChildRuns.values()].find(
			(candidate) =>
				(candidate.status === "queued" || candidate.status === "running" || candidate.status === "done") &&
				!candidate.detachedDeletion &&
				(candidate.id === selector || candidate.sessionName === selector),
		);
		if (!run) return undefined;
		await run.publication.promise;
		return run.session?.sessionId;
	}

	private async _awaitPendingRlmChildSettlement(selector: string): Promise<string | undefined> {
		const run = [...this._activeRlmChildRuns.values()].find(
			(candidate) =>
				!candidate.detachedDeletion && (candidate.id === selector || candidate.sessionName === selector),
		);
		if (!run) return undefined;
		await run.publication.promise;
		await run.settlement.promise;
		if (run.status === "error" || run.status === "cancelled") {
			throw new Error(run.error ?? `RLM child ${selector} failed before becoming idle`);
		}
		return run.session?.sessionId;
	}

	async listRlmSubagents(): Promise<RlmListSubagentsResult> {
		return this._buildRlmSubagentList(await this._agentMessageController?.listAgents());
	}

	private _buildRlmSubagentList(listedAgents?: AgentSessionMessageListResult): RlmListSubagentsResult {
		const daemonChildren = new Map<string, AgentSessionMessageAgentSummary>();
		const daemonStatus = (child: AgentSessionMessageAgentSummary): RlmSubagentRegistryEntry["status"] => {
			if (child.isStreaming || child.unfinishedActionCount > 0 || child.status === "running") {
				return "running";
			}
			// A nonresident daemon ledger entry left in `running` did not reach its
			// durable completion boundary. Only live daemon activity above can turn
			// that stale registry state back into a running child.
			return child.rlmChildRegistryStatus === "running" || child.rlmChildRegistryStatus === "deleted"
				? "error"
				: "completed";
		};
		const parentActiveSessionId = listedAgents?.current?.activeSessionId;
		if (parentActiveSessionId) {
			for (const agent of listedAgents.agents) {
				if (
					agent.runtimeKind === "subagent" &&
					agent.parentActiveSessionId === parentActiveSessionId &&
					agent.rlmChildId
				) {
					daemonChildren.set(agent.rlmChildId, agent);
				}
			}
		}

		const subagents: RlmListSubagentsResult["subagents"] = [];
		const recorded = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			if (this._deletingRlmChildren.has(run.id) || run.detachedDeletion || run.status === "cancelled") {
				continue;
			}
			const daemonChild = daemonChildren.get(run.id);
			subagents.push({
				rlm_child_id: run.id,
				active_session_id: daemonChild?.activeSessionId ?? null,
				session_id: daemonChild?.sessionId ?? run.session?.sessionId ?? null,
				session_name: daemonChild?.sessionName ?? run.session?.sessionName ?? run.sessionName,
				session_dir: run.sessionDir,
				status: run.status === "done" ? "completed" : run.status === "error" ? "error" : "running",
			});
			recorded.add(run.id);
		}
		for (const [childId, childSession] of this._rlmChildSessions) {
			if (
				this._deletingRlmChildren.has(childId) ||
				recorded.has(childId) ||
				this._rlmChildCleanupFailures.has(childId)
			) {
				continue;
			}
			const daemonChild = daemonChildren.get(childId);
			const sessionDir = childSession._rlmSessionDir;
			if (!sessionDir) {
				continue;
			}
			subagents.push({
				rlm_child_id: childId,
				active_session_id: daemonChild?.activeSessionId ?? null,
				session_id: daemonChild?.sessionId ?? childSession.sessionId,
				session_name:
					daemonChild?.sessionName ?? childSession.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
				session_dir: sessionDir,
				status: daemonChild ? daemonStatus(daemonChild) : "completed",
			});
			recorded.add(childId);
		}
		for (const [childId, daemonChild] of daemonChildren) {
			if (
				recorded.has(childId) ||
				this._deletingRlmChildren.has(childId) ||
				this._deletedRlmChildIds.has(childId) ||
				this._rlmChildCleanupFailures.has(childId) ||
				!daemonChild.sessionDir
			) {
				continue;
			}
			subagents.push({
				rlm_child_id: childId,
				active_session_id: daemonChild.activeSessionId,
				session_id: daemonChild.sessionId,
				session_name: daemonChild.sessionName ?? createDefaultRlmSubagentSessionName("", childId),
				session_dir: daemonChild.sessionDir,
				status: daemonStatus(daemonChild),
			});
		}
		return { subagents };
	}

	private _rlmSubagentMatchesTarget(entry: RlmSubagentRegistryEntry, target: string): boolean {
		return (
			entry.rlm_child_id === target ||
			entry.active_session_id === target ||
			entry.session_id === target ||
			entry.session_name === target
		);
	}

	private async _resolveDirectRlmSubagent(target: string): Promise<RlmSubagentRegistryEntry> {
		const candidates = [...(await this.listRlmSubagents()).subagents, ...this._rlmChildCleanupFailures.values()];
		const matches = candidates.filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		if (matches.length === 0) {
			throw new Error(`No direct RLM subagent matches "${target}" in the current parent session`);
		}
		if (matches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		return matches[0]!;
	}

	async deleteInactiveRlmSubagent(
		childId: string,
		isExternallyRunning: () => boolean = () => false,
	): Promise<"deleted" | "not_found" | "running"> {
		const isRunning = (): boolean => {
			const status = this._activeRlmChildRuns.get(childId)?.status;
			return status === "queued" || status === "running" || isExternallyRunning();
		};
		if (isRunning()) {
			return "running";
		}
		const subagent = [...(await this.listRlmSubagents()).subagents, ...this._rlmChildCleanupFailures.values()].find(
			(entry) => entry.rlm_child_id === childId,
		);
		if (!subagent) {
			for (const run of this._activeRlmChildRuns.values()) {
				const result = await run.session?.deleteInactiveRlmSubagent(childId, isExternallyRunning);
				if (result && result !== "not_found") {
					return result;
				}
			}
			for (const retained of this._rlmChildSessions.values()) {
				const result = await retained.deleteInactiveRlmSubagent(childId, isExternallyRunning);
				if (result !== "not_found") {
					return result;
				}
			}
			return "not_found";
		}
		if (isRunning()) {
			return "running";
		}
		const result = await this._trackRlmSubagentDeletion(subagent, () => {
			if (isRunning()) {
				return Promise.resolve({ subagent, outcome: "skipped_running" });
			}
			return this._deleteResolvedRlmSubagent(subagent);
		});
		return result.outcome === "skipped_running" ? "running" : "deleted";
	}

	async deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult> {
		const inFlight = [...this._deletingRlmChildren.values()].filter(({ subagent }) =>
			this._rlmSubagentMatchesTarget(subagent, target),
		);
		if (inFlight.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}

		// Running and retained children can be reserved synchronously. This keeps
		// them hidden immediately while the async daemon listing checks for a
		// conflicting passive selector.
		const localMatches = [
			...this._buildRlmSubagentList().subagents,
			...this._rlmChildCleanupFailures.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const matchingChildIds = new Set([
			...inFlight.map(({ subagent }) => subagent.rlm_child_id),
			...localMatches.map((subagent) => subagent.rlm_child_id),
		]);
		if (matchingChildIds.size > 1 || localMatches.length > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		if (inFlight[0]) {
			return inFlight[0].promise;
		}
		if (localMatches[0]) {
			const subagent = localMatches[0];
			return this._trackRlmSubagentDeletion(subagent, async () => {
				const listedAgents = await this._agentMessageController?.listAgents();
				const listedSubagents = this._buildRlmSubagentList(listedAgents).subagents;
				const passiveMatches = listedSubagents.filter(
					(entry) => entry.rlm_child_id !== subagent.rlm_child_id && this._rlmSubagentMatchesTarget(entry, target),
				);
				if (passiveMatches.length > 0) {
					throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
				}
				const parentActiveSessionId = listedAgents?.current?.activeSessionId;
				const daemonChild = listedAgents?.agents.find(
					(agent) =>
						agent.rlmChildId === subagent.rlm_child_id && agent.parentActiveSessionId === parentActiveSessionId,
				);
				const resolvedSubagent = daemonChild
					? {
							...subagent,
							active_session_id: daemonChild.activeSessionId,
							session_id: daemonChild.sessionId,
							session_name: daemonChild.sessionName ?? subagent.session_name,
						}
					: subagent;
				return this._deleteResolvedRlmSubagent(resolvedSubagent);
			});
		}

		const directMatches = [
			...(await this.listRlmSubagents()).subagents,
			...this._rlmChildCleanupFailures.values(),
		].filter((entry) => this._rlmSubagentMatchesTarget(entry, target));
		const directChildIds = new Set(directMatches.map((subagent) => subagent.rlm_child_id));
		if (directChildIds.size > 1) {
			throw new Error(`RLM subagent selector "${target}" is ambiguous in the current parent session`);
		}
		const subagent = directMatches[0] ?? (await this._resolveDirectRlmSubagent(target));
		return this._trackRlmSubagentDeletion(subagent, () => this._deleteResolvedRlmSubagent(subagent));
	}

	private async _trackRlmSubagentDeletion(
		subagent: RlmSubagentRegistryEntry,
		startDeletion: () => Promise<RlmDeleteSubagentResult>,
	): Promise<RlmDeleteSubagentResult> {
		const existing = this._deletingRlmChildren.get(subagent.rlm_child_id);
		if (existing) return existing.promise;
		const deletion = Promise.resolve().then(startDeletion);
		this._deletingRlmChildren.set(subagent.rlm_child_id, {
			subagent,
			promise: deletion,
		});
		try {
			return await deletion;
		} finally {
			const clearReservation = () => {
				if (this._deletingRlmChildren.get(subagent.rlm_child_id)?.promise === deletion) {
					this._deletingRlmChildren.delete(subagent.rlm_child_id);
				}
			};
			const run = this._activeRlmChildRuns.get(subagent.rlm_child_id);
			if (run?.detachedDeletion) {
				// Keep every selector reserved until the run settles, or until a failed
				// cleanup is exposed for an explicit retry. Repeated deletes before that
				// boundary return the same accepted result.
				void run.deletionReservation.promise.then(clearReservation, clearReservation);
			} else {
				clearReservation();
			}
		}
	}

	private _deleteRlmSubagentSession(childId: string, session?: AgentSession): Promise<void> {
		if (this._subagentRuntimeHost) {
			return this._subagentRuntimeHost.deleteRlmSubagentRuntime(childId, session);
		}
		return session?.disposeAsync() ?? Promise.resolve();
	}

	private _ensureRlmRunDeletionCleanup(run: RlmChildRun, session: AgentSession): Promise<void> {
		if (run.deletionCleanup) return run.deletionCleanup;
		const cleanup = Promise.resolve().then(() => this._deleteRlmSubagentSession(run.id, session));
		run.deletionCleanup = cleanup;
		// Deletion admission is intentionally nonblocking. The detached run owner
		// joins this exact promise before settlement and records any failure.
		void cleanup.catch(() => undefined);
		return cleanup;
	}

	private async _recordRlmRunDeletionCleanupFailure(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		error: unknown,
	): Promise<void> {
		if (this._disposed || this._disposing) {
			run.suppressTerminalNotice = true;
			await session.disposeAsync().catch(() => undefined);
			if (!run.settled) await this._finishRlmRunDeletion(run);
			return;
		}
		run.deletionCleanup = undefined;
		run.deletionCleanupObserver = undefined;
		run.deletionCleanupFailed = true;
		run.session = session;
		this._rlmChildCleanupFailures.set(run.id, subagent);
		// Make retry admission available before waking the parent model with the
		// retry-required notice.
		run.deletionReservation.resolve();
		await Promise.resolve();
		await run.reportDeletionCleanupFailure?.(error);
	}

	private async _finishRlmRunDeletion(run: RlmChildRun): Promise<void> {
		await run.completeDeletion?.();
		if (this._activeRlmChildRuns.get(run.id) === run) {
			this._removeRlmSubagentTracking(run.id, run);
		}
		run.settled = true;
		run.settlement.resolve();
		run.deletionReservation.resolve();
		this._unsettledRlmChildRuns.delete(run);
		this._maybeResumeGoalContinuationAfterRlmWork();
	}

	private _observeRlmRunDeletionCleanup(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
		cleanup: Promise<void>,
	): Promise<boolean> {
		if (run.deletionCleanupObserver) return run.deletionCleanupObserver;
		const observer = cleanup.then(
			() => true,
			async (error) => {
				await this._recordRlmRunDeletionCleanupFailure(run, subagent, session, error);
				return false;
			},
		);
		run.deletionCleanupObserver = observer;
		void observer.catch(() => undefined);
		return observer;
	}

	private _continueFinishedRlmRunDeletion(
		run: RlmChildRun,
		subagent: RlmSubagentRegistryEntry,
		session: AgentSession,
	): void {
		const cleanup = this._ensureRlmRunDeletionCleanup(run, session);
		const observer = this._observeRlmRunDeletionCleanup(run, subagent, session, cleanup);
		if (!run.deletionRunFinished) return;
		void observer
			.then(async (cleanupSucceeded) => {
				if (cleanupSucceeded) await this._finishRlmRunDeletion(run);
			})
			.catch(() => undefined);
	}

	private _removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void {
		run?.unsubscribe?.();
		this._rlmChildUnsubscribes.get(childId)?.();
		this._rlmChildUnsubscribes.delete(childId);
		this._rlmChildSessions.delete(childId);
		this._rlmChildCleanupFailures.delete(childId);
		this._abandonedRlmQuiescenceChildIds.delete(childId);
		if (!run || this._activeRlmChildRuns.get(childId) === run) {
			this._activeRlmChildRuns.delete(childId);
		}
		if (run) {
			run.abort = noopRlmChildAbort;
			run.unsubscribe = undefined;
			run.session = undefined;
		}
	}

	private _emitRlmSubagentRemoval(subagent: RlmSubagentRegistryEntry): void {
		this._emit({
			type: "rlm_child_update",
			child: {
				id: subagent.rlm_child_id,
				parentId: this._rlmParentNodeId,
				activeSessionId: subagent.active_session_id ?? undefined,
				sessionName: subagent.session_name,
				label: subagent.session_name,
				status: "cancelled",
				sessionDir: subagent.session_dir,
				error: "Deleted by parent orchestrator",
			},
		});
	}

	private async _deleteResolvedRlmSubagent(subagent: RlmSubagentRegistryEntry): Promise<RlmDeleteSubagentResult> {
		const childId = subagent.rlm_child_id;
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			if (run.deletionCleanupFailed) {
				// Reset retry coordination only after selector preflight reaches the
				// resolved child. A failed preflight must leave the prior retry boundary
				// intact so a later call can acquire it.
				run.deletionCleanupFailed = false;
				run.deletionReservation = createAgentMessageDeferred();
			}
			// The detached task remains the sole lifecycle owner. Mark deletion before
			// cancellation so its catch/finally path cannot race a normal release or
			// terminal notice against the physical delete.
			run.detachedDeletion = subagent;
			if (this._cancelRlmChildRun(run, "Deleted by parent orchestrator")) {
				run.deletionNeedsCompletionNotice = true;
			} else {
				this._emitRlmSubagentRemoval(subagent);
			}
			const liveSession = run.session;
			if (run.status === "error" && !liveSession && run.settled) {
				this._deletedRlmChildIds.add(childId);
				this._removeRlmSubagentTracking(childId, run);
				return { subagent };
			}
			if (liveSession && run.settled) {
				run.deletionRunFinished = true;
				run.settlement = createAgentMessageDeferred();
				run.settled = false;
				this._unsettledRlmChildRuns.add(run);
			}
			if (liveSession) this._continueFinishedRlmRunDeletion(run, subagent, liveSession);

			// Return once deletion is accepted. The run stays hidden but unsettled until
			// abort-insensitive model/tool work unwinds and the shared cleanup finishes.
			this._deletedRlmChildIds.add(childId);
			return { subagent };
		}

		this._emitRlmSubagentRemoval(subagent);
		const retained = this._rlmChildSessions.get(childId);
		try {
			await this._deleteRlmSubagentSession(childId, retained);
		} catch (error) {
			if (this._disposed || this._disposing) {
				this._removeRlmSubagentTracking(childId);
				void retained?.disposeAsync().catch(() => undefined);
			} else {
				this._rlmChildCleanupFailures.set(childId, subagent);
			}
			throw error;
		}
		this._deletedRlmChildIds.add(childId);
		this._removeRlmSubagentTracking(childId);
		return { subagent };
	}

	/**
	 * Retain a finished child session for the parent lifetime so inspectors and
	 * daemon-hosted agent messaging can keep addressing it. Returns false (and disposes
	 * the child) when the parent is already tearing down, so the caller can drop the
	 * matching event forwarder too.
	 */
	registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean {
		// A child can finish concurrently while the parent is (or has) torn down; don't
		// resurrect the map (it would never be disposed), just drop the child now.
		if (this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId)) {
			return false;
		}
		if (this._subagentRuntimeHost?.completeRlmSubagentRuntime?.(childId, session) === false) {
			return false;
		}
		if (this._disposed || this._disposing) {
			void session.disposeAsync().catch(() => undefined);
			return false;
		}
		this._rlmChildSessions.set(childId, session);
		if (unsubscribe) {
			this._rlmChildUnsubscribes.set(childId, unsubscribe);
		}
		return true;
	}

	releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false {
		const run = this._activeRlmChildRuns.get(childId);
		if (run?.session === session && run.status === "done") {
			const unsubscribe = run.unsubscribe ?? noopRlmChildEventUnsubscribe;
			run.unsubscribe = undefined;
			this._activeRlmChildRuns.delete(childId);
			return unsubscribe;
		}
		if (this._rlmChildSessions.get(childId) !== session) return false;
		const unsubscribe = this._rlmChildUnsubscribes.get(childId) ?? noopRlmChildEventUnsubscribe;
		this._rlmChildUnsubscribes.delete(childId);
		this._rlmChildSessions.delete(childId);
		return unsubscribe;
	}

	/** Live recursive child roster from lifecycle state, including nested work under retained parents. */
	getRlmChildSnapshots(): RlmChildAgentSnapshot[] {
		const snapshots: RlmChildAgentSnapshot[] = [];
		const recorded = new Set<string>();
		const traversed = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			const hidden =
				run.detachedDeletion || this._deletingRlmChildren.has(run.id) || this._deletedRlmChildIds.has(run.id);
			const child = run.session;
			if (!hidden) {
				const model = child?.model ?? run.model;
				snapshots.push({
					id: run.id,
					parentId: this._rlmParentNodeId,
					sessionName: child?.sessionName ?? run.sessionName,
					model: `${model.provider}/${model.id}`,
					label: rlmChildLabel(run.prompt),
					status: run.status,
					sessionDir: run.sessionDir,
				});
				recorded.add(run.id);
			}
			if (child) {
				traversed.add(run.id);
				snapshots.push(...child.getRlmChildSnapshots());
			}
		}
		for (const [childId, child] of this._rlmChildSessions) {
			if (recorded.has(childId) || traversed.has(childId)) continue;
			const hidden = this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId);
			if (!hidden) {
				snapshots.push({
					id: childId,
					parentId: this._rlmParentNodeId,
					sessionName: child.sessionName,
					model: child.model ? `${child.model.provider}/${child.model.id}` : undefined,
					label: child.sessionName ?? "child agent",
					// A failed delete retains the session solely for cleanup retry. Preserve
					// its cancellation truth in snapshots rather than reviving it as done.
					status: this._rlmChildCleanupFailures.has(childId) ? "cancelled" : "done",
					sessionDir: child._rlmSessionDir ?? child.sessionManager.getSessionDir(),
				});
			}
			snapshots.push(...child.getRlmChildSnapshots());
		}
		return snapshots;
	}

	/** True when any direct or nested subagent is still running or queued. */
	hasRunningRlmChildren(): boolean {
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.status === "running" || run.status === "queued") {
				return true;
			}
			if (run.session?.hasRunningRlmChildren()) {
				return true;
			}
		}
		// A finished direct child can still have a running nested subagent.
		for (const session of this._rlmChildSessions.values()) {
			if (session.hasRunningRlmChildren()) {
				return true;
			}
		}
		return false;
	}

	private _rlmChildSessionSnapshot(): AgentSession[] {
		const sessions = new Set<AgentSession>();
		for (const [childId, session] of this._rlmChildSessions) {
			if (!this._abandonedRlmQuiescenceChildIds.has(childId)) sessions.add(session);
		}
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.session && !run.abandonedForQuiescence) sessions.add(run.session);
		}
		return [...sessions];
	}

	private _hasUnsettledRlmQuiescenceWork(): boolean {
		if (this._hasDeferredRlmTerminalNotices()) return true;
		if ([...this._unsettledRlmChildRuns].some((run) => !run.settled)) return true;
		return this._rlmChildSessionSnapshot().some(
			(child) => child.isSessionActive || child._hasUnsettledRlmQuiescenceWork(),
		);
	}

	/**
	 * Wait for every admitted descendant run to publish its terminal parent
	 * message and for the resulting parent turns to drain. Re-snapshotting after
	 * each drain includes descendants spawned while earlier results were consumed.
	 */
	async waitForRlmQuiescence(externalSignal?: AbortSignal): Promise<void> {
		const cancellation = new AbortController();
		const cancelFromParent = () => cancellation.abort();
		if (externalSignal?.aborted) cancellation.abort();
		else externalSignal?.addEventListener("abort", cancelFromParent, { once: true });
		this._rlmQuiescenceWaitAborts.add(cancellation);
		let rejectCancelled = (_error: Error) => {};
		const cancelled = new Promise<never>((_resolve, reject) => {
			rejectCancelled = reject;
		});
		const onCancelled = () => rejectCancelled(new Error("RLM quiescence wait cancelled"));
		cancellation.signal.addEventListener("abort", onCancelled, { once: true });
		if (cancellation.signal.aborted) onCancelled();
		const wait = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, cancelled]);
		try {
			while (true) {
				await wait(this.waitForHeadlessIdle());
				// Strong RLM quiescence also owns session-level work (bash, refine,
				// branch mutation, and manual compaction) that interactive waitForIdle
				// intentionally ignores. Yield a macrotask while such work is active so
				// recursive parent/child barriers cannot form a microtask busy-loop.
				if (this.isSessionActive || this._hasDeferredRlmTerminalNotices()) {
					await wait(new Promise<void>((resolve) => setTimeout(resolve, 0)));
					continue;
				}
				const unsettledRuns = [...this._unsettledRlmChildRuns].filter((run) => !run.settled);
				const childSessions = this._rlmChildSessionSnapshot();
				if (unsettledRuns.length === 0 && !this._hasUnsettledRlmQuiescenceWork()) return;
				await wait(
					Promise.all([
						...unsettledRuns.map((run) => run.settlement.promise),
						...childSessions.map((child) => child.waitForRlmQuiescence(cancellation.signal)),
					]),
				);
				// Always loop through the self-active/deferred checks again. Work may
				// start at the child-settlement boundary.
			}
		} finally {
			// A local descendant error must cancel sibling recursive waits owned by
			// this barrier before their propagation listeners are removed.
			cancellation.abort();
			externalSignal?.removeEventListener("abort", cancelFromParent);
			cancellation.signal.removeEventListener("abort", onCancelled);
			this._rlmQuiescenceWaitAborts.delete(cancellation);
		}
	}

	// Inline (non-daemon) mode only; daemon clients attach to the child session directly.
	getRlmChildSession(childId: string): AgentSession | undefined {
		const direct = this._activeRlmChildRuns.get(childId)?.session ?? this._rlmChildSessions.get(childId);
		if (direct) {
			return direct;
		}
		for (const candidate of this._activeRlmChildRuns.values()) {
			const nested = candidate.session?.getRlmChildSession(childId);
			if (nested) {
				return nested;
			}
		}
		for (const retained of this._rlmChildSessions.values()) {
			const nested = retained.getRlmChildSession(childId);
			if (nested) {
				return nested;
			}
		}
		return undefined;
	}

	/**
	 * Cancel a single RLM child run by id, searching nested child sessions.
	 *
	 * @returns true when a live run was cancelled or its unsettled terminal notice
	 * was suppressed; false when the id is unknown or the run already settled.
	 */
	cancelRlmChildRun(childId: string, reason = "Cancelled by user"): boolean {
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			if (run.status !== "running" && run.status !== "queued" && !run.settled) {
				if (this._sessionInputPumpSuspended) this._abandonRlmRunForQuiescence(run);
				else run.suppressTerminalNotice = true;
				return true;
			}
			return this._cancelRlmChildRun(run, reason);
		}
		for (const candidate of this._activeRlmChildRuns.values()) {
			if (candidate.session?.cancelRlmChildRun(childId, reason)) {
				return true;
			}
		}
		for (const retained of this._rlmChildSessions.values()) {
			if (retained.cancelRlmChildRun(childId, reason)) {
				return true;
			}
		}
		return false;
	}

	private async _assertRlmSubagentSessionNameAvailable(name: string, ignorePendingReservation = false): Promise<void> {
		const depth = this._rlmDepth + 1;
		if (!ignorePendingReservation && this._pendingRlmSubagentSessionNames.has(name)) {
			throw new Error(formatAgentSessionNameUnavailable(name, depth));
		}
		const localConflict =
			[...this._activeRlmChildRuns.values()].some(
				(run) => run.session?.sessionName === name || (!run.session && run.sessionName === name),
			) ||
			[...this._rlmChildSessions.values()].some((session) => session.sessionName === name) ||
			[...this._rlmChildCleanupFailures.values()].some((entry) => entry.session_name === name);
		if (localConflict) {
			throw new Error(formatAgentSessionNameUnavailable(name, depth));
		}
		const controller = this._agentMessageController;
		if (!controller) return;
		const input = {
			name,
			depth,
			parentSessionId: this.sessionId,
			parentSessionPath: this.sessionFile,
		};
		if (controller.assertSessionNameAvailable) {
			await controller.assertSessionNameAvailable(input);
			return;
		}
		const listed = await controller.listAgents();
		const catalog = listed.agents.map(
			(agent): AgentFamilyCatalogEntry => ({
				id: agent.sessionId,
				...(agent.sessionName ? { name: agent.sessionName } : {}),
				depth: agent.rlmDepth ?? 0,
				status: agent.status ?? "idle",
				...(agent.parentSessionId ? { parentSessionId: agent.parentSessionId } : {}),
				...(agent.parentSessionPath ? { parentSessionPath: agent.parentSessionPath } : {}),
				...(agent.sessionPath ? { sessionPath: agent.sessionPath } : {}),
			}),
		);
		assertAgentSessionNameAvailable(catalog, input);
	}

	private async _authenticatedRlmModels(): Promise<Model<Api>[]> {
		return (await this._modelRegistry.getExecutableModels()).filter((model) => {
			const status = this._modelRegistry.getProviderAuthStatus(model.provider);
			return status.source !== "stale" && status.label !== "expired";
		});
	}

	async findRlmModels(query: string, limit: number): Promise<RlmFindModelsResult> {
		return {
			models: findRlmModelMatches(query, await this._authenticatedRlmModels(), limit),
		};
	}

	private async _resolveRlmSubagentModel(reference: string | undefined): Promise<RlmSubagentModelSelection> {
		const parentModel = this.model;
		if (!parentModel) {
			throw new Error(formatNoModelSelectedMessage());
		}
		if (!reference) {
			return { model: parentModel };
		}

		const normalizedReference = reference.toLowerCase();
		if (`${parentModel.provider}/${parentModel.id}`.toLowerCase() === normalizedReference) {
			return { model: parentModel };
		}
		const model = (await this._authenticatedRlmModels()).find(
			(candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === normalizedReference,
		);
		if (!model) {
			throw new Error(`Requested subagent model "${reference}" is unavailable, unauthenticated, or expired`);
		}

		const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(`Requested subagent model "${reference}" failed authentication preflight`);
		}
		return { model };
	}

	private async _startRlmChildRun(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
		internalOptions: { allowedToolNames?: string[] } = {},
	): Promise<RlmSpawnHandle> {
		const assertDeliveryOpen = () => {
			const pendingDelivery = this._pendingAvoCanonicalDelivery();
			if (!pendingDelivery && !this._isAvoCanonicalDeliveryTerminalFailure()) return;
			throw new Error(
				pendingDelivery
					? `AVO_CANONICAL_DELIVERY_PENDING run_id=${pendingDelivery.runId}: RLM child creation is closed until canonical delivery terminates`
					: "AVO_CANONICAL_DELIVERY_FAILED: RLM child creation is closed for this terminal run",
			);
		};
		assertDeliveryOpen();
		const { name: rawName, model: rawModel, thinking: rawThinking, ...unsupported } = kwargs;
		const unsupportedKwargs = Object.keys(unsupported);
		if (unsupportedKwargs.length > 0) {
			throw new Error(`Unsupported rlm.run kwargs: ${unsupportedKwargs.sort().join(", ")}`);
		}
		const requestedSessionName = normalizeRequestedRlmSubagentSessionName(rawName);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel);
		const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking);
		if (requestedSessionName) assertDirectAgentMessageTarget(requestedSessionName);
		if (this._rlmDepth >= this._rlmMaxDepth) {
			throw new Error(
				`RLM recursion depth limit reached (RLM_DEPTH=${this._rlmDepth}, RLM_MAX_DEPTH=${this._rlmMaxDepth})`,
			);
		}
		if (requestedSessionName) {
			if (this._pendingRlmSubagentSessionNames.has(requestedSessionName)) {
				throw new Error(formatAgentSessionNameUnavailable(requestedSessionName, this._rlmDepth + 1));
			}
			this._pendingRlmSubagentSessionNames.add(requestedSessionName);
		}
		let modelSelection: RlmSubagentModelSelection;
		try {
			if (requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(requestedSessionName, true);
			modelSelection = await this._resolveRlmSubagentModel(requestedModel);
		} finally {
			if (requestedSessionName) this._pendingRlmSubagentSessionNames.delete(requestedSessionName);
		}
		// Model discovery/authentication is asynchronous. Recheck the persisted
		// delivery phase before allocating or launching any child runtime.
		assertDeliveryOpen();
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		if (this._disposed || this._disposing) throw new Error("Cannot spawn a subagent after its parent was disposed");

		const childSessionDir = this._createChildRlmSessionDir();
		const childNodeId = basename(childSessionDir);
		const sessionName = requestedSessionName ?? createDefaultRlmSubagentSessionName(prompt, childNodeId);
		if (!requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(sessionName);
		assertDeliveryOpen();
		const startedAt = Date.now();
		const parentAssistantForUsage = this._findLastAssistantMessage();
		const label = rlmChildLabel(prompt);
		let answerPreview: string | undefined;
		let durationMs: number | undefined;
		let toolUseCount = 0;
		let runningToolCount = 0;
		let activity: RlmChildAgentActivity | undefined;
		let childSession: AgentSession | undefined;
		const run: RlmChildRun = {
			id: childNodeId,
			prompt,
			sessionName,
			sessionDir: childSessionDir,
			model: modelSelection.model,
			status: "queued",
			settled: false,
			abort: noopRlmChildAbort,
			publication: createAgentMessageDeferred(),
			settlement: createAgentMessageDeferred(),
			deletionReservation: createAgentMessageDeferred(),
		};
		const throwIfCancelled = () => {
			if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
		};
		this._activeRlmChildRuns.set(run.id, run);
		this._unsettledRlmChildRuns.add(run);
		const emitChildUpdate = () => {
			const childModel = childSession?.model ?? modelSelection.model;
			this._emit({
				type: "rlm_child_update",
				child: {
					id: childNodeId,
					parentId: this._rlmParentNodeId,
					sessionName: childSession?.sessionName ?? sessionName,
					model: `${childModel.provider}/${childModel.id}`,
					label,
					status: run.status,
					durationMs,
					answerPreview,
					toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
					tokenCount: childSession?._contextTokensForCurrentMessages(),
					recap: childSession?.getCurrentRecap(),
					sessionDir: childSessionDir,
					activity,
					repliedSinceTask: childSession?._repliedToParentSinceTask,
					error: run.error,
				},
			});
		};
		run.emitUpdate = emitChildUpdate;
		emitChildUpdate();

		const publishChildSession = (child: AgentSession) => {
			childSession = child;
			if (this._activeRlmChildRuns.get(run.id) !== run) return;
			run.session = child;
			run.abort = () => void child.abort();
			run.publication.resolve();
			// Cancellation may have been admitted while runtime construction was
			// blocked and run.abort was still a no-op.
			if (run.status === "cancelled") run.abort();
		};
		const subagentOptions: CreateRlmSubagentRuntimeOptions = {
			...this._createRlmSubagentRuntimeOptions({
				id: childNodeId,
				prompt,
				sessionName,
				spawnCode,
				sessionDir: childSessionDir,
				model: modelSelection.model,
				thinkingLevel: requestedThinkingLevel,
				allowedToolNames: internalOptions.allowedToolNames,
			}),
			onSessionPublished: publishChildSession,
		};

		const deliverTerminalMessageToParent = async (message: CustomMessage): Promise<void> => {
			// Synthesized lifecycle notices always use the parent's private durable
			// path. Explicit child replies continue through agent_message separately.
			await this._deferRlmTerminalNotice(message);
		};

		run.completeDeletion = () => {
			if (!run.deletionNeedsCompletionNotice || run.suppressTerminalNotice || this._disposed || this._disposing) {
				return Promise.resolve();
			}
			if (run.deletionNotice) return run.deletionNotice;
			const notice = deliverTerminalMessageToParent(
				createRlmChildTerminalNoticeMessage({
					kind: "cancelled",
					childId: run.id,
					sessionName,
					reason: run.error ?? "Deleted by parent orchestrator",
				}),
			);
			run.deletionNotice = notice;
			return notice;
		};

		run.reportDeletionCleanupFailure = (error) => {
			if (run.suppressTerminalNotice || this._disposed || this._disposing) return Promise.resolve();
			const cleanupError = error instanceof Error ? error.message : String(error);
			return deliverTerminalMessageToParent(
				createRlmChildFailureMessage({
					childId: run.id,
					sessionName,
					error: `Deletion cleanup failed; retry rlm.delete_subagent("${run.id}") before completion: ${cleanupError}`,
				}),
			);
		};

		// Runtime startup and the task run are deliberately detached. The public
		// spawn resolves at admission, while this task owns live tracking, usage,
		// retention, cancellation, and late-startup cleanup.
		void (async () => {
			let childRuntime: RlmSubagentRuntime | undefined;
			try {
				childRuntime = await this._createRlmSubagentRuntime(subagentOptions);
				// Runtime construction is host-controlled and asynchronous. Delivery
				// may have become pending while it was in flight, so close this TOCTOU
				// window before publishing or prompting the child.
				assertDeliveryOpen();
				throwIfCancelled();
				const child = childRuntime.session;
				if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
				if (child.sessionName !== sessionName) child.setSessionName(sessionName);
				publishChildSession(child);
				throwIfCancelled();
				run.status = "running";
				emitChildUpdate();
				const unsubscribeChildEvents = child.subscribe((event) => {
					if (event.type === "rlm_child_update") {
						this._emit(event);
						return;
					}
					if (event.type === "agent_start") {
						activity = { kind: "waiting" };
						emitChildUpdate();
					} else if (event.type === "agent_end") {
						activity = undefined;
						emitChildUpdate();
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						const assistant = event.message as AssistantMessage;
						if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
							attributeChildUsage(parentAssistantForUsage?.usage ?? emptyUsage(), assistant.usage);
							if (parentAssistantForUsage) {
								const parentEntry = this._findAssistantEntryForMessage(parentAssistantForUsage);
								if (parentEntry) {
									const messages = child.messages;
									const assistantIndex = messages.lastIndexOf(assistant);
									const precedingPrompt = messages
										.slice(0, assistantIndex)
										.reverse()
										.find((message) => message.role === "user" || message.role === "custom");
									const origin =
										precedingPrompt?.role === "custom" && isAgentSessionMessage(precedingPrompt)
											? precedingPrompt.details.id.startsWith("spawn:")
												? "spawn_task"
												: "agent_message"
											: "direct_user";
									this.sessionManager.appendChildUsageAttribution(
										parentEntry.id,
										assistant.usage,
										parentAssistantForUsage.usage,
										origin,
									);
								}
							}
						}
						const text = compactRlmText(readAssistantText(assistant));
						if (text) answerPreview = text;
						void flushAgentTraceUpload(child.sessionManager).catch(() => undefined);
						emitChildUpdate();
					} else if (event.type === "message_start" || event.type === "message_update") {
						if (event.message.role === "assistant") {
							const text = compactRlmText(readAssistantText(event.message as AssistantMessage));
							if (text) answerPreview = text;
							activity = { kind: "writing" };
							emitChildUpdate();
						}
					} else if (event.type === "tool_execution_start") {
						toolUseCount += 1;
						runningToolCount += 1;
						activity = { kind: "executing", toolName: event.toolName };
						emitChildUpdate();
					} else if (event.type === "tool_execution_end") {
						runningToolCount = Math.max(0, runningToolCount - 1);
						if (runningToolCount === 0) activity = { kind: "waiting" };
						emitChildUpdate();
					} else if (event.type === "session_info_changed" || event.type === "recap_update") {
						emitChildUpdate();
					}
				});
				run.unsubscribe = unsubscribeChildEvents;
				const content = `[task from parent]\n\n${prompt}`;
				const parentActiveSessionId = await this._currentActiveSessionId();
				// Agent discovery is another asynchronous host boundary. Recheck both
				// the persisted delivery phase and local cancellation immediately before
				// the first child provider call.
				assertDeliveryOpen();
				throwIfCancelled();
				const spawnMessage: AgentSessionMessage = {
					role: "custom",
					customType: AGENT_MESSAGE_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						id: `spawn:${run.id}`,
						message: prompt,
						from: {
							sessionId: this.sessionId,
							sessionName: this.sessionName,
							activeSessionId: parentActiveSessionId,
						},
						fromRelationship: "parent",
					},
					timestamp: Date.now(),
				};
				assertDeliveryOpen();
				throwIfCancelled();
				const parentReplyCountBeforeRun = child._parentReplyCount;
				await child.promptAndWait(content, {
					expandPromptTemplates: false,
					source: "extension",
					customMessage: spawnMessage,
				});
				await child.waitForRlmQuiescence();
				if (run.error) throw new Error(run.error);
				run.status = "done";
				durationMs = Date.now() - startedAt;
				activity = undefined;
				emitChildUpdate();
				if (
					!run.detachedDeletion &&
					!run.suppressTerminalNotice &&
					child._parentReplyCount === parentReplyCountBeforeRun
				) {
					const lastAssistantText = child.getLastAssistantText();
					await deliverTerminalMessageToParent(
						createRlmChildTerminalNoticeMessage({
							kind: "completed_without_reply",
							childId: run.id,
							sessionName,
							lastAssistantTextPreview: lastAssistantText ? compactRlmText(lastAssistantText) : undefined,
						}),
					);
				}
				if (!this.registerRlmChildSession(run.id, child) && !run.detachedDeletion) {
					if (childRuntime && this._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
						await this._subagentRuntimeHost
							.releaseRlmSubagentRuntime(childRuntime, subagentOptions, "error")
							.catch(() => void child.disposeAsync().catch(() => undefined));
					} else {
						await child.disposeAsync().catch(() => undefined);
					}
				}
			} catch (error) {
				const runError = error instanceof Error ? error : new Error(String(error));
				run.publication.reject(runError);
				if (run.status !== "cancelled") {
					run.status = "error";
					run.error = runError.message;
				}
				durationMs = Date.now() - startedAt;
				activity = undefined;
				emitChildUpdate();
				if (!run.detachedDeletion && !run.suppressTerminalNotice) {
					if (run.status === "error") {
						await deliverTerminalMessageToParent(
							createRlmChildFailureMessage({
								childId: run.id,
								sessionName,
								error: run.error ?? "unknown error",
							}),
						);
					} else if (run.status === "cancelled") {
						await deliverTerminalMessageToParent(
							createRlmChildTerminalNoticeMessage({
								kind: "cancelled",
								childId: run.id,
								sessionName,
								reason: run.error,
							}),
						);
					}
				}
				if (!run.detachedDeletion && childSession && this._subagentRuntimeHost?.releaseRlmSubagentRuntime) {
					try {
						await this._subagentRuntimeHost.releaseRlmSubagentRuntime(
							childRuntime ?? { session: childSession },
							subagentOptions,
							run.status === "cancelled" ? "cancelled" : "error",
						);
						if (run.status === "cancelled" && !this._disposed && !this._disposing) {
							this._deletedRlmChildIds.add(run.id);
							this._removeRlmSubagentTracking(run.id);
						}
					} catch {
						await childSession?.disposeAsync().catch(() => undefined);
					}
				} else if (!run.detachedDeletion) {
					try {
						if (childRuntime && this._subagentRuntimeHost) {
							await this._subagentRuntimeHost.deleteRlmSubagentRuntime(run.id, childRuntime.session);
						} else if (childSession) {
							await childSession.disposeAsync();
						}
						if (run.status === "cancelled" && !this._disposed && !this._disposing) {
							this._deletedRlmChildIds.add(run.id);
							this._removeRlmSubagentTracking(run.id);
						}
					} catch {
						// A failed best-effort retry remains available through the retained cleanup maps.
					}
				}
			} finally {
				if (run.detachedDeletion) {
					run.deletionRunFinished = true;
					if (!run.settled) {
						let cleanupSucceeded = !run.deletionCleanupFailed;
						if (childRuntime && cleanupSucceeded) {
							const cleanup =
								run.deletionCleanup ?? this._ensureRlmRunDeletionCleanup(run, childRuntime.session);
							cleanupSucceeded = await this._observeRlmRunDeletionCleanup(
								run,
								run.detachedDeletion,
								childRuntime.session,
								cleanup,
							);
						}
						if (cleanupSucceeded) await this._finishRlmRunDeletion(run);
					}
				} else {
					if (this._activeRlmChildRuns.get(run.id) === run) {
						if (this._rlmChildSessions.has(run.id)) {
							this._activeRlmChildRuns.delete(run.id);
							if (run.unsubscribe) this._rlmChildUnsubscribes.set(run.id, run.unsubscribe);
							run.abort = noopRlmChildAbort;
							run.unsubscribe = undefined;
							run.session = undefined;
						} else if (run.status !== "error") {
							this._removeRlmSubagentTracking(run.id, run);
						} else {
							run.unsubscribe?.();
							run.abort = noopRlmChildAbort;
							run.unsubscribe = undefined;
						}
					}
					run.settled = true;
					run.settlement.resolve();
					this._unsettledRlmChildRuns.delete(run);
					this._maybeResumeGoalContinuationAfterRlmWork();
				}
			}
		})().catch(() => undefined);

		return {
			rlm_child_id: childNodeId,
			name: sessionName,
			session_dir: childSessionDir,
			model: `${modelSelection.model.provider}/${modelSelection.model.id}`,
		};
	}

	async runRlmChild(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
	): Promise<RlmSpawnHandle> {
		return this._startRlmChildRun(prompt, kwargs, spawnCode);
	}

	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		if (this._isFauxProviderQueueExhausted(message)) {
			return false;
		}

		if (this._isAgentLifecycleFailure(message)) {
			return false;
		}

		if (this._isStructuredPermanentProviderRetryExhausted(message)) {
			return false;
		}

		return true;
	}

	private _isFauxProviderQueueExhausted(message: AssistantMessage): boolean {
		return message.provider === "faux" && message.errorMessage === "No more faux responses queued";
	}

	private _isAgentLifecycleFailure(message: AssistantMessage): boolean {
		return message.diagnostics?.some((diagnostic) => diagnostic.type === "agent_lifecycle_failure") ?? false;
	}

	private _getProviderStreamFailureDetails(message: AssistantMessage): Record<string, unknown> | undefined {
		const failure = message.diagnostics?.find((diagnostic) => diagnostic.type === "provider_stream_failure");
		const details = failure?.details;
		if (!details || typeof details !== "object") {
			return undefined;
		}
		return details;
	}

	private _getProviderStreamFailureKind(message: AssistantMessage): string | undefined {
		const kind = this._getProviderStreamFailureDetails(message)?.kind;
		return typeof kind === "string" ? kind : undefined;
	}

	private _isStructuredPermanentProviderFailure(message: AssistantMessage): boolean {
		const kind = this._getProviderStreamFailureKind(message);
		return kind === "auth" || kind === "invalid_request" || kind === "refusal";
	}

	private _isStructuredPermanentProviderRetryExhausted(message: AssistantMessage): boolean {
		return this._retryAttempt > 0 && this._isStructuredPermanentProviderFailure(message);
	}

	private _getProviderStreamFailureAuthStatus(message: AssistantMessage): number | undefined {
		const details = this._getProviderStreamFailureDetails(message);
		if (!details) {
			return undefined;
		}

		const kind = details.kind;
		if (kind !== "auth") {
			return undefined;
		}

		const status = details.status;
		if (typeof status === "number") {
			return status;
		}
		if (typeof status === "string") {
			const parsed = Number(status);
			return Number.isInteger(parsed) ? parsed : undefined;
		}
		return undefined;
	}

	private _isConcreteProviderAuthFailure(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		const structuredStatus = this._getProviderStreamFailureAuthStatus(message);
		if (structuredStatus === 401 || structuredStatus === 403) {
			return true;
		}

		if (/\b(?:401|403)\b/.test(message.errorMessage) && /\bstatus code\b/i.test(message.errorMessage)) {
			return true;
		}

		return (
			/\b(?:401|403)\b/.test(message.errorMessage) &&
			/auth|unauthori[sz]ed|forbidden|api.?key|token|credential/i.test(message.errorMessage)
		);
	}

	private _captureRetryAuthFailureSource(message: AssistantMessage): AuthSourceToken | undefined {
		const token = this._modelRegistry.getCurrentProviderAuthSourceToken(message.provider);
		if (!token) {
			return undefined;
		}
		if (
			!this._retryAuthFailureSources.some(
				(existing) =>
					existing.provider === token.provider &&
					existing.source === token.source &&
					existing.identityFingerprint === token.identityFingerprint &&
					existing.valueFingerprint === token.valueFingerprint,
			)
		) {
			this._retryAuthFailureSources.push(token);
		}
		return token;
	}

	private _markProviderAuthStale(message: AssistantMessage, authSourceTokens?: readonly AuthSourceToken[]): boolean {
		if (authSourceTokens && authSourceTokens.length > 0) {
			let marked = false;
			for (const token of authSourceTokens) {
				marked = this._modelRegistry.markProviderAuthSourceStale(token) || marked;
			}
			if (marked) {
				this._emit({
					type: "auth_stale",
					provider: message.provider,
					sourceTokens: authSourceTokens,
				});
			}
			return marked;
		}
		const marked = this._modelRegistry.markProviderAuthStale(message.provider);
		if (marked) {
			this._emit({ type: "auth_stale", provider: message.provider });
		}
		return marked;
	}

	private _markProviderAuthStaleForRetryFailure(
		message: AssistantMessage,
		options?: {
			markAuthStaleOnFailure?: boolean;
			authSourceTokens?: readonly AuthSourceToken[];
		},
	): boolean {
		const authSourceTokens =
			this._retryAuthFailureSources.length > 0 ? this._retryAuthFailureSources : options?.authSourceTokens;
		if ((authSourceTokens?.length ?? 0) > 0 || options?.markAuthStaleOnFailure) {
			const marked = this._markProviderAuthStale(message, authSourceTokens);
			if (marked && message.errorMessage) {
				message.errorMessage = addLoginGuidanceToAuthError(message.errorMessage);
			}
			return marked;
		}
		return false;
	}

	private _finishActiveRetryWithFailure(message: AssistantMessage): void {
		if (this._retryAttempt === 0) {
			return;
		}
		this._markProviderAuthStaleForRetryFailure(message);
		this._emit({
			type: "auto_retry_end",
			success: false,
			attempt: this._retryAttempt,
			finalError: message.errorMessage,
		});
		this._retryAttempt = 0;
		this._retryAuthFailureSources = [];
	}

	private async _handleRetryableError(
		message: AssistantMessage,
		options?: {
			markAuthStaleOnFailure?: boolean;
			authSourceTokens?: readonly AuthSourceToken[];
		},
	): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAuthFailureSources = [];
			this._resolveRetry();
			return false;
		}

		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt - 1,
				finalError: message.errorMessage,
			});
			this._retryAttempt = 0;
			this._retryAuthFailureSources = [];
			this._resolveRetry(); // Resolve so waitForRetry() completes
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			const attempt = this._retryAttempt;
			this._markProviderAuthStaleForRetryFailure(message, options);
			this._retryAttempt = 0;
			this._retryAbortController = undefined;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			this._resolveRetry();
			this._retryAuthFailureSources = [];
			return false;
		}
		this._retryAbortController = undefined;

		setTimeout(() => {
			this.agent.continue().catch(() => {});
		}, 0);

		return true;
	}

	abortRetry(): void {
		if (this._retryAbortController) {
			this._retryAbortController.abort();
			return;
		}
		if (this._retryAttempt > 0) {
			this._autoCompactionAbortController?.abort();
			this._cancelPostCompactionContinue();
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: "Retry cancelled",
			});
			this._retryAttempt = 0;
		}
		this._retryAuthFailureSources = [];
		this._resolveRetry();
	}

	private async waitForRetry(): Promise<void> {
		if (!this._retryPromise) {
			return;
		}

		await this._retryPromise;
		await this.agent.waitForIdle();
	}

	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	get hasAcceptedPromptInFlight(): boolean {
		return this._actionStore
			.unfinishedActions()
			.some(
				(action) =>
					action.payload.kind === "turn" &&
					!action.payload.queueVisible &&
					action.payload.acceptedBeforeCompletion,
			);
	}

	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.operations Custom BashOperations for remote execution
	 */
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			operations?: BashOperations;
			transient?: boolean;
			ignoreConfiguredPrefix?: boolean;
		},
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix && !options?.ignoreConfiguredPrefix ? `${prefix}\n${command}` : command;

		try {
			const result = await executeBashWithOperations(
				resolvedCommand,
				this.sessionManager.getCwd(),
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk,
					signal: this._bashAbortController.signal,
				},
			);

			if (!options?.transient) {
				this.recordBashResult(command, result, options);
			}
			return result;
		} finally {
			this._bashAbortController = undefined;
		}
	}

	private async _executeAvoVerificationBash(command: string): Promise<
		BashResult & {
			verificationMode: "host_broker" | "local_sandbox" | "unavailable";
			verificationBrokerReceipt?: AvoVerificationBrokerReceipt;
		}
	> {
		const brokerOperations = createAvoVerificationBrokerBashOperations();
		const operations = brokerOperations ?? createReadOnlyVerificationBashOperations();
		if (!operations) {
			return {
				output: "AVO read-only verification sandbox unavailable; command was not executed.\n",
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				verificationMode: "unavailable",
			};
		}
		const result = await this.executeBash(command, undefined, {
			operations,
			ignoreConfiguredPrefix: true,
		});
		const verificationBrokerReceipt = brokerOperations?.lastReceipt();
		return {
			...result,
			verificationMode: brokerOperations ? "host_broker" : "local_sandbox",
			...(verificationBrokerReceipt ? { verificationBrokerReceipt } : {}),
		};
	}

	/**
	 * Run a user-initiated bash command (! / !! prefix), emitting bash_start,
	 * bash_output, and bash_end session events so any attached client can render
	 * streaming output. Extensions can intercept execution via the user_bash event.
	 * Execution failures are reported through bash_end rather than a rejected promise;
	 * only the already-running guard and extension dispatch errors reject.
	 * @param command The bash command to execute
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 */
	async runUserBash(
		command: string,
		options?: {
			excludeFromContext?: boolean;
			transient?: boolean;
			runId?: string;
		},
	): Promise<void> {
		if (this.isBashRunning) {
			throw new Error("A bash command is already running");
		}
		// Claim the bash slot synchronously: isBashRunning is otherwise false until
		// executeBash installs its abort controller, which would let a second command
		// slip through during the user_bash extension dispatch below.
		this._userBashRunning = true;
		this._userBashAbortRequested = false;
		// Echoed on bash_start/bash_end so the requesting client can tell its own
		// run apart from other clients' runs broadcast on the same session.
		const identity = {
			...(options?.transient ? { transient: true } : {}),
			...(options?.runId !== undefined ? { runId: options.runId } : {}),
		};
		let end: UserBashEndDetails;
		try {
			end = await this.runUserBashLocked(
				command,
				options?.excludeFromContext ?? false,
				options?.transient ?? false,
				identity,
			);
		} finally {
			this._userBashRunning = false;
		}
		// Emitted after the slot is released so clients never observe a bash_end
		// while the session still rejects new commands as already running.
		this._emit({ type: "bash_end", ...end, ...identity });
		void this._drainQueuedMessagesAfterBash().catch(() => undefined);
	}

	private async _drainQueuedMessagesAfterBash(): Promise<void> {
		await this.agent.waitForIdle();
		this._scheduleSessionInputPump();
	}

	private async runUserBashLocked(
		command: string,
		excludeFromContext: boolean,
		transient: boolean,
		identity: { transient?: boolean; runId?: string },
	): Promise<UserBashEndDetails> {
		const eventResult = await this._extensionRunner.emitUserBash({
			type: "user_bash",
			command,
			excludeFromContext,
			cwd: this.sessionManager.getCwd(),
		});

		// Transient runs (side-conversation bash) live only in their pane: they
		// are never recorded, so reloads and rebuilds cannot resurface them.
		const record = transient
			? () => {}
			: (result: BashResult) => this.recordBashResult(command, result, { excludeFromContext });

		this._emit({
			type: "bash_start",
			command,
			excludeFromContext,
			...identity,
		});
		try {
			// If an extension returned a full result, surface it without executing
			if (eventResult?.result) {
				const result = eventResult.result;
				if (result.output) {
					this._emit({ type: "bash_output", chunk: result.output });
				}
				record(result);
				return {
					exitCode: result.exitCode,
					cancelled: result.cancelled,
					truncated: result.truncated,
					fullOutputPath: result.fullOutputPath,
				};
			}

			// An abort that arrived before the process spawned (during extension
			// dispatch) has no abort controller to act on; honor it here instead.
			if (this._userBashAbortRequested) {
				record({
					output: "",
					exitCode: undefined,
					cancelled: true,
					truncated: false,
				});
				return { exitCode: undefined, cancelled: true, truncated: false };
			}

			const result = await this.executeBash(command, (chunk) => this._emit({ type: "bash_output", chunk }), {
				excludeFromContext,
				operations: eventResult?.operations,
				transient,
			});
			return {
				exitCode: result.exitCode,
				cancelled: result.cancelled,
				truncated: result.truncated,
				fullOutputPath: result.fullOutputPath,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			// Persist the failure like every other outcome so replayed transcripts
			// and the LLM context reflect that the command did not run.
			record({
				output: `bash failed: ${errorMessage}`,
				exitCode: undefined,
				cancelled: false,
				truncated: false,
			});
			return {
				exitCode: undefined,
				cancelled: false,
				truncated: false,
				errorMessage,
			};
		}
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			this._pendingBashMessages.push(bashMessage);
		} else {
			this.agent.state.messages.push(bashMessage);

			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		// A user bash command may not have spawned yet (extension dispatch in
		// progress); flag the request so runUserBash cancels before executing.
		if (this._userBashRunning && this._bashAbortController === undefined) {
			this._userBashAbortRequested = true;
		}
		this._bashAbortController?.abort();
	}

	get isBashRunning(): boolean {
		return this._bashAbortController !== undefined || this._userBashRunning;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			this.agent.state.messages.push(bashMessage);

			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	getRlmMaxDepthStatus(): RlmMaxDepthStatus {
		return { maxDepth: this._rlmMaxDepth, source: this._rlmMaxDepthSource };
	}

	async setRlmMaxDepth(maxDepth: number, options: { global?: boolean } = {}): Promise<SetRlmMaxDepthResult> {
		if (!isNonNegativeInteger(maxDepth)) {
			throw new Error("RLM max depth must be a non-negative integer.");
		}

		this.sessionManager.appendCustomEntryWithRollback(RLM_MAX_DEPTH_STATE_CUSTOM_TYPE, { maxDepth });
		this._rlmMaxDepth = maxDepth;
		this._rlmMaxDepthSource = "chat";
		const oldBase = this._baseSystemPrompt;
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._refreshExtensionSystemPrompt(this.agent.state.systemPrompt, oldBase);

		let globalError: string | undefined;
		if (options.global) {
			await this.settingsManager.flush();
			const staleErrors = this.settingsManager.drainErrors("global");
			for (const { error } of staleErrors) {
				console.warn(`Warning: Earlier global settings write failed: ${error.message}`);
			}
			this.settingsManager.setRlmMaxDepth(maxDepth);
			await this.settingsManager.flush();
			const errors = this.settingsManager.drainErrors("global");
			globalError = errors.map(({ error }) => error.message).join("; ") || undefined;
		}

		return {
			...this.getRlmMaxDepthStatus(),
			globalSaved: options.global === true && globalError === undefined,
			...(globalError ? { globalError } : {}),
		};
	}

	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
		});
	}

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	private _branchNavigationQueue: Promise<void> = Promise.resolve();

	async navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const previous = this._branchNavigationQueue;
		let release = () => {};
		this._branchNavigationQueue = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await this._navigateTree(targetId, options);
		} finally {
			release();
		}
	}

	private async _navigateTree(
		targetId: string,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		} = {},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		const queuedWorkPause = this.acquireQueuedWorkPause();
		let commitFence: { owner: symbol; release(): void } | undefined;
		try {
			// Branch navigation and turn dispatch mutate the same transcript leaf.
			commitFence = await this._acquireSessionActionCommitFence();
			return await this._sessionActionCommitContext.run(commitFence.owner, async () => {
				await this.agent.waitForIdle();
				await this._agentEventQueue;
				return this._navigateTreeUnderPause(targetId, targetEntry, options);
			});
		} finally {
			queuedWorkPause.release();
			commitFence?.release();
		}
	}

	private async _navigateTreeUnderPause(
		targetId: string,
		targetEntry: NonNullable<ReturnType<SessionManager["getEntry"]>>,
		options: {
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
		},
	): Promise<{
		editorText?: string;
		cancelled: boolean;
		aborted?: boolean;
		summaryEntry?: BranchSummaryEntry;
	}> {
		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target after admitted work has settled.
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}

		// Do not switch branches while /refine has detached event handling and is
		// about to persist harness/session entries for the current branch.
		await this._invalidatePendingAutoRefineForBranchChange();

		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		this._branchSummaryAbortController = new AbortController();
		let resolveBranchSummaryOperation: () => void = () => {};
		const branchSummaryOperation = new Promise<void>((resolve) => {
			resolveBranchSummaryOperation = resolve;
		});
		this._branchSummaryOperation = branchSummaryOperation;

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			let summaryText: string | undefined;
			let summaryDetails: unknown;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { apiKey, headers } = await this._getRequiredRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
				const result = await generateBranchSummary(entriesToSummarize, {
					model,
					apiKey,
					headers,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
			}

			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				newLeafId = targetId;
			}

			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				this.sessionManager.resetLeaf();
			} else {
				this.sessionManager.branch(newLeafId);
			}

			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			this._mergeUnpersistedOutcomes(this.agent.state.messages);
			this._restoreLateIpythonSentAgentMessages();
			this._reloadGoalStateFromBranch();
			this._reloadRlmMaxDepthFromBranch();
			this._invalidateQueuedPromptPreparation();

			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			if (this._branchSummaryOperation === branchSummaryOperation) {
				this._branchSummaryOperation = undefined;
			}
			resolveBranchSummaryOperation();
		}
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = this._extractUserMessageText(entry.message.content);
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	private _extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
		}
		return "";
	}

	getSessionStats(): SessionStats {
		const state = this.state;
		const userMessages = state.messages.filter((m) => m.role === "user").length;
		const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
		const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

		let toolCalls = 0;
		let totalInput = 0;
		let totalOutput = 0;
		let totalCacheRead = 0;
		let totalCacheWrite = 0;
		let totalCost = 0;

		for (const message of state.messages) {
			if (message.role === "assistant") {
				const assistantMsg = message as AssistantMessage;
				toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				totalInput += assistantMsg.usage.input;
				totalOutput += assistantMsg.usage.output;
				totalCacheRead += assistantMsg.usage.cacheRead;
				totalCacheWrite += assistantMsg.usage.cacheWrite;
				totalCost += assistantMsg.usage.cost.total;
			}
		}

		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages: state.messages.length,
			tokens: {
				input: totalInput,
				output: totalOutput,
				cacheRead: totalCacheRead,
				cacheWrite: totalCacheWrite,
				total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
			},
			cost: totalCost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
						}
						break;
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	private _rlmSessionDirForReading(): string | undefined {
		return this._rlmSessionDir ?? this.sessionManager.getSessionArtifactDir();
	}

	private _contextWindowResolver(): ContextWindowResolver {
		return (provider, modelId) => this._modelRegistry.find(provider, modelId)?.contextWindow;
	}

	/**
	 * Build the agent context overview for /context: this session as the root
	 * plus one node per RLM sub-agent, recursively. Running children are read
	 * from their live sessions; completed children from their persisted session
	 * dirs, so the tree survives child disposal and session resume.
	 */
	getContextTree(): ContextTreeNode {
		const resolveContextWindow = this._contextWindowResolver();
		const { ownUsage, totalUsage } = computeOwnAndTotalUsage(
			this.sessionManager.getBranch(),
			this.sessionManager.getEntries(),
		);

		const children: ContextTreeNode[] = [];
		const liveIds = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			liveIds.add(run.id);
			const node =
				run.session?.getContextTree() ?? loadContextTreeChildFromDisk(run.sessionDir, resolveContextWindow);
			children.push({
				...(node ?? {
					ownUsage: emptyUsage(),
					totalUsage: emptyUsage(),
					children: [],
				}),
				id: run.id,
				label: rlmChildLabel(run.prompt),
				status: run.status,
			});
		}
		children.push(...loadContextTreeChildrenFromDisk(this._rlmSessionDirForReading(), resolveContextWindow, liveIds));

		const model = this.model;
		return {
			id: "root",
			label: this.sessionName ?? "main agent",
			status: "active",
			model: model ? { provider: model.provider, id: model.id } : undefined,
			ownUsage,
			totalUsage,
			contextUsage: this.getContextUsage(),
			children,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const themeName = this.settingsManager.getTheme();

		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolve(outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}

function isRlmHeartbeatStatusUpdate(value: unknown): value is AgentRlmHeartbeatStatusUpdate {
	return value === "pause" || value === "resume";
}

function rlmHeartbeatHostResponse(job: AgentCronJob): Record<string, unknown> {
	return {
		id: job.id,
		status: job.status,
		label: job.label ?? null,
		delivery_mode: job.deliveryMode ?? "steer",
		instruction: job.prompt,
		schedule: job.schedule,
		created_at: job.createdAt,
		updated_at: job.updatedAt,
		next_run_at: job.nextRunAt ?? null,
		last_run_at: job.lastRunAt ?? null,
		last_error: job.lastError ?? null,
		run_count: job.runCount,
	};
}
