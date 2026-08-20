/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
	Agent,
	type AgentContext,
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
	StreamLivenessDiagnostic,
	StreamLivenessHost,
	StreamLivenessState,
	StreamLivenessTerminalOutcome,
	TextContent,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	createStreamLivenessHost,
	getDefaultStreamLivenessHost,
	getSupportedThinkingLevels,
	isContextOverflow,
	modelsAreEqual,
	resetApiProviders,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import type { DaemonWorkflowStatusProjection } from "../modes/daemon/daemon-session-list.js";
import { theme } from "../modes/interactive/theme/theme.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import {
	AGENT_FAMILY_REACH_ERROR,
	AGENT_MESSAGE_CUSTOM_TYPE,
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	AGENT_MESSAGE_SKILL_NAME,
	AGENT_MESSAGE_SOURCE,
	type AgentFamilyCatalogEntry,
	type AgentFamilyRosterResult,
	type AgentSessionMessage,
	type AgentSessionMessageAgentSummary,
	AgentSessionMessageBlockedError,
	type AgentSessionMessageController,
	type AgentSessionMessageListResult,
	type AgentSessionMessagePayload,
	type AgentSessionMessageReceipt,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	createAgentMessageHostHandlers,
	createAgentSessionMessage,
	createAgentSessionMessageId,
	createAgentSessionMessageReceipt,
	formatAgentSessionNameUnavailable,
	isAgentSessionMessage,
	isAgentSessionMessageBlockedError,
	normalizeAgentSessionMessage,
	parseAgentSessionMessagePromptId,
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
	autonomousStatus,
	createAutonomousRuntimeState,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
} from "./autonomous.js";
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
	type GoalContextKind,
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
import {
	createHostRequestGateway,
	type HostRequestCapabilityContext,
	type HostRequestHandlers,
	installHostRequestCapabilityContext,
	installHostRequestCapabilityResolver,
	type KernelSentAgentMessage,
} from "./kernel/index.js";
import type { KernelContainerIsolationOptions } from "./kernel/isolation.js";
import { type RestoreResult, snapshotPathIn } from "./kernel/state-snapshot.js";
import type { McpManager } from "./mcp/mcp-manager.js";
import {
	type BashExecutionMessage,
	type CompactionOutcome,
	type CompactionOutcomeReason,
	type CustomMessage,
	createCompactionOutcomeMessage,
	createHeartbeatPromptMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	createWorkflowWorkerFailureMessage,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
} from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { throwIfPromptAdmissionCancelled } from "./prompt-admission.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import {
	type AutoRefineReason,
	type AutoRefineReview,
	appendGlobalRefinement,
	applyRefinementProposal,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	getRefinementHistory,
	type HarnessState,
	inferRefinementResultScope,
	loadGlobalRefinementHistory,
	loadHarnessState,
	mergeHarnessStates,
	mergeRefinementHistory,
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
import type {
	BranchSummaryEntry,
	CompactionEntry,
	ResourceExhaustedBlocker,
	ResourceExhaustedBlockerEntryData,
	SessionContext,
	SessionMessageEntry,
} from "./session-manager.js";
import {
	CURRENT_SESSION_VERSION,
	getLatestCompactionEntry,
	parseProviderStreamStallDiagnostic,
	projectResourceExhaustedBlocker,
	type SessionHeader,
	SessionManager,
} from "./session-manager.js";
import type { SessionMessageObligationBridge } from "./session-message-obligation-bridge.js";
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
import {
	parseToolExecutionLeaseRecord,
	parseToolExecutionStallDiagnostic,
	TOOL_EXECUTION_LEASE_CUSTOM_TYPE,
	TOOL_EXECUTION_STALL_CUSTOM_TYPE,
	type ToolExecutionLeaseRecord,
	type ToolExecutionLiveness,
	type ToolExecutionStallDiagnostic,
} from "./tool-execution-liveness.js";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { IpythonKernelProvisioner } from "./tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import { addAssistantUsage, emptyUsage } from "./usage.js";
import { SERPER_CREDENTIAL_ID, SERPER_ENV_VAR, WEBSEARCH_SKILL_NAME } from "./websearch-credential.js";
import type { PrimeAdaptiveRuntimeState } from "./workflow/adaptive-runtime.js";
import { changedPaths, computePathDiff, formatDiffPush, sharesDiffs } from "./workflow/agent-collaboration.js";
import {
	createWorkflowBrainstormState,
	createWorkflowProposalTool,
	restoreWorkflowBrainstormState,
	WORKFLOW_PROPOSE_TOOL_NAME,
	type WorkflowBrainstormProposal,
	type WorkflowBrainstormState,
	workflowBrainstormMessage,
	workflowBrainstormPrompt,
	workflowProposalDigest,
	workflowStartRequestFromProposal,
} from "./workflow/brainstorm.js";
import { readWorkflowCliApprovalDelivery, removeWorkflowCliApprovalDelivery } from "./workflow/cli-approval.js";
import { digestObject, sha256Hex } from "./workflow/contracts.js";
import type { DefaultPrimeWorkerFailureNotice } from "./workflow/default-task-runtime.js";
import type {
	WorkflowExecutionEvidenceSource,
	WorkflowExecutionEvidenceState,
	WorkflowExecutionToolCallFact,
	WorkflowExecutionToolResultFact,
	WorkflowExecutionTurnHandle,
} from "./workflow/execution-evidence.js";
import {
	isWorkflowExecutionEvidenceSourceForHost,
	revokeWorkflowExecutionEvidenceSource,
} from "./workflow/execution-evidence.js";
import {
	consumeWorkflowGoalProjectionAuthorization,
	validateWorkflowGoalProjectionAuthorization,
	type WorkflowGoalProjectionAuthorization,
} from "./workflow/journal.js";
import type {
	WorkflowLearningPromotionApplication,
	WorkflowLearningPromotionConsumeAndApplyInput,
} from "./workflow/learning-promotion-authority.js";
import type { WorkflowLearningRuntimeAdapter } from "./workflow/learning-runtime-adapter.js";
import { digestWorkflowGoalState, workflowGoalProjectionSnapshot } from "./workflow/projections.js";
import type { WorkflowSchedulerState } from "./workflow/scheduler.js";
import {
	normalizeWorkflowAcceptanceRequest,
	type WorkflowCommand,
	type WorkflowShell,
	type WorkflowShellStatus,
} from "./workflow/shell.js";
import type {
	WorkflowSkillExecutor,
	WorkflowSkillHostInvocationContext,
	WorkflowSkillSnapshot,
} from "./workflow/skill-snapshots.js";
import {
	parseWorkerModelCapabilityAdmission,
	WORKER_MODEL_ID,
	WORKER_MODEL_PROVIDER,
	WORKER_MODEL_REASONING,
	WORKER_MODEL_SELECTOR,
	type WorkerModelCapabilityBlocker,
	type WorkerModelCapabilityLaunchAdmission,
	type WorkerModelCapabilityLaunchAuthorizer,
	type WorkerModelCapabilityLaunchInput,
	type WorkerModelChildModelBinding,
} from "./workflow/worker-model-capability-gate.js";

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
	/** Stable daemon-visible session name for addressing/displaying the child. */
	sessionName?: string;
	/** Exact provider/model selector used by the child. */
	model?: string;
	label: string;
	status: RlmChildAgentStatus;
	durationMs?: number;
	answerPreview?: string;
	/** Number of tool executions the subagent has started so far. */
	toolUseCount?: number;
	/** Context size (tokens) of the subagent's latest turn. */
	tokenCount?: number;
	/** Latest recap of what the subagent is doing, from the summarizer. */
	recap?: string;
	sessionDir: string;
	activity?: RlmChildAgentActivity;
	/** Child sent at least one explicit agent message since task admission. */
	repliedSinceTask?: boolean;
	/** Failure reason when status is "error". */
	error?: string;
}

export type CompactionReason = "manual" | "threshold" | "overflow" | "requested";

/** Session-specific events that extend the core AgentEvent */
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
			/** "warning" for benign skips (nothing to compact), "error" for real failures */
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
			/** Set when execution failed before producing a result (e.g. spawn failure) */
			errorMessage?: string;
			/** Set for transient (side-conversation) runs so other attached clients suppress them. */
			transient?: boolean;
			/** Echo of the caller-supplied run id, so clients correlate runs by identity. */
			runId?: string;
	  }
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/** Payload of the bash_end event for a user-initiated bash command */
type UserBashEndDetails = {
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	errorMessage?: string;
};

/** Thrown when compaction is skipped for a benign reason (surfaced as a warning, not an error) */
export class CompactionSkippedError extends Error {}

const DEFAULT_COMPACTION_DEADLINE_MS = 120_000;
const DEFAULT_TOOL_EXECUTION_DEADLINE_MS = 600_000;
const DEFAULT_AGENT_MESSAGE_DELIVERY_DEADLINE_MS = 120_000;
const AGENT_MESSAGE_DELIVERY_COMMIT_GRACE_MS = 5_000;
const TOOL_EXECUTION_HARD_DEADLINE_MULTIPLIER = 4;

function isWorkflowGoalAccountingContention(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "workflow_append_lease_guard_timeout" ||
			error.message === "workflow_goal_accounting_rebase_exhausted")
	);
}

export type AgentSessionCompactionPhase =
	| "authenticating"
	| "preparing"
	| "before_extension"
	| "summarizing"
	| "committing"
	| "after_extension"
	| "kernel_notification"
	| "child_cleanup"
	| "recovering";

export interface AgentSessionCompactionLiveness {
	readonly phase: AgentSessionCompactionPhase;
	readonly startedAt: number;
	readonly deadlineAt: number;
	readonly elapsedMs: number;
}

export interface AgentSessionProviderStreamLiveness {
	readonly phase: StreamLivenessState["phase"];
	readonly startedAt: number;
	readonly deadlineAt: number;
	readonly elapsedMs: number;
	readonly lastProviderEventAt: number | undefined;
	readonly lastMeaningfulContentDeltaAt: number | undefined;
	readonly receivedBytes: number;
	readonly blocks: number;
	readonly abortability: StreamLivenessState["abortability"];
}

class CompactionDeadlineExceededError extends Error {
	constructor(
		readonly phase: AgentSessionCompactionPhase,
		readonly deadlineMs: number,
	) {
		super(`Compaction deadline exceeded after ${deadlineMs}ms during ${phase}`);
		this.name = "CompactionDeadlineExceededError";
	}
}

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	serviceTierPreference?: ServiceTier;
	cwd: string;
	/** Config dir backing credentials (auth.json); exported to the kernel for skills. */
	agentDir?: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for skills, prompts, themes, context files, system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Model registry for API key resolution and model discovery */
	modelRegistry: ModelRegistry;
	/** Initial active built-in tool names. Default: [ipython] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/**
	 * Whether the built-in long-running goals feature is available: the bundled
	 * goal skill in the IPython kernel, its goal.* host handlers, and /goal.
	 * Default: true.
	 */
	includeGoals?: boolean;
	/** Daemon-backed agent-to-agent messaging bridge. Omitted for local-only sessions. */
	agentMessageController?: AgentSessionMessageController;
	/** Daemon-backed read-only active-session observation bridge. Omitted for local-only sessions. */
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
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Current RLM recursion depth. Root sessions default to RLM_DEPTH or 0. */
	rlmDepth?: number;
	/** Maximum RLM recursion depth. Defaults to RLM_MAX_DEPTH or 1. */
	rlmMaxDepth?: number;
	/** Directory exposed to the kernel as RLM_SESSION_DIR. */
	rlmSessionDir?: string;
	/** Node id for this session when it is itself an RLM child. */
	rlmParentNodeId?: string;
	/** Parent agent name/id shown in child communication doctrine. */
	rlmParentAgent?: string;
	/** Host responsible for creating RLM subagent runtimes. */
	subagentRuntimeHost?: SubagentRuntimeHost;
	/** Host-side autonomous continuation policy. */
	autonomous?: AgentAutonomousConfig;
	/**
	 * Boot the IPython kernel in the background as soon as the session is created,
	 * so the first ipython tool call doesn't pay the kernel cold start.
	 *
	 * Only applies to main agents (rlmDepth 0); subagent kernels stay lazy. Default: false.
	 */
	prewarmIpythonKernel?: boolean;
	/** Test/extension hook for automatic refine review decisions. Defaults to the model-backed review gate. */
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
	/** Durable workflow shell supplied by the session service boundary. */
	workflowHost?: WorkflowShell;
	/** Host-owned construction gate; workflow kernels cannot prewarm before it resolves. */
	workflowSetupGate?: Promise<void>;
	/** Host-installed workflow/decision capabilities for mutating kernel requests. */
	hostRequestCapabilityContext?: HostRequestCapabilityContext;
	/** Host-owned total deadline for one compaction attempt. */
	compactionDeadlineMs?: number;
	/** Host-owned provider stream liveness policy and clock. */
	streamLiveness?: StreamLivenessHost;
	/** Host-owned absolute deadline for one tool invocation. */
	toolExecutionDeadlineMs?: number;
	/** Host-owned deadline for accepted agent messages to reach recipient context. */
	agentMessageDeliveryDeadlineMs?: number;
	/** Exact executable used to launch session kernels after separate host admission. */
	kernelPythonLauncher?: string;
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
	| { status: "skip" }
	| { status: "invalidated"; branchVersion: number }
	| {
			status: "failure";
			/** True when the background plan was for an explicit refine.run (skipReview). */
			explicit: boolean;
			/** Original options for the failed plan, to allow re-queue on explicit failure. */
			options: { instructions?: string; rollbackId?: string; global?: boolean };
			branchVersion: number;
	  };

export type AutoRefineReviewer = (request: AutoRefineReviewRequest, signal?: AbortSignal) => Promise<AutoRefineReview>;

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Coalesce follow-up queueing so only one pending follow-up exists for this key. */
	followUpQueueKey?: string;
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean, queued?: boolean) => void;
	/** Queue instead of starting immediately when the session is idle but already has queued work. */
	queueIfBusy?: boolean;
	/** Start queued work when no agent turn is currently running. */
	resumeIfIdle?: boolean;
	/** Host-generated prompt that must bypass extension/slash/template input interception. */
	internalPrompt?: boolean;
	/** Prevent host-driven prompts from causing autonomous continuation injection. */
	suppressAutonomousContinuation?: boolean;
	/** Skip extension input handlers for replaying already-accepted input. */
	skipInputHandlers?: boolean;
	/** Cancel this prompt while it is waiting for direct-turn admission. */
	signal?: AbortSignal;
	/** Internal host hook fired at the direct-turn ownership commit point. */
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
	captureRunMessages?: Set<AgentMessage>;
	cancelledDispatchEnded?: boolean;
}

interface PreparedCommandPayload extends SessionCommandPayload {
	images?: ImageContent[];
}

type QueuedSessionAction = SessionAction<PreparedTurnPayload | PreparedCommandPayload>;

interface PreparedPromptPreparation {
	result: Awaited<ReturnType<ExtensionRunner["emitBeforeAgentStart"]>>;
	/** Base system prompt captured at emitBeforeAgentStart, for stale-base refresh at handoff. */
	basePromptSnapshot: string;
}

class DeferredSessionInputError extends Error {}

/** Wrap a preflight callback so only the first report wins. */
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
const WORKFLOW_TASK_BINDING_CUSTOM_ENTRY = "workflow_task_binding";
const WORKFLOW_TASK_TERMINAL_CUSTOM_ENTRY = "workflow_task_terminal";
const AGENT_MESSAGE_BATCH_MAX_ACTIONS = 32;
const AGENT_MESSAGE_BATCH_MAX_CHARS = 32_768;

type WorkflowTaskTerminalStatus = "completed" | "error" | "cancelled" | "deadline";

interface WorkflowTaskBindingData {
	schemaVersion: 1;
	kind: "workflow_task_binding";
	workflowId: string;
	taskId: string;
	attemptId: string;
	executionKey: string;
	epochRef: { storeEpoch: number; coordinatorEpoch: number };
	deadlineAt: string;
	capsuleDigest: string;
}

interface WorkflowTaskBinding extends WorkflowTaskBindingData {
	readonly isActive?: () => boolean;
}

interface WorkflowTaskTerminalRecord {
	readonly schemaVersion: 1;
	readonly kind: "workflow_task_terminal";
	readonly binding: WorkflowTaskBindingData;
	readonly status: WorkflowTaskTerminalStatus;
	readonly reason?: string;
	readonly terminalAt: string;
	readonly recordDigest: string;
}

function parseWorkflowTaskBinding(value: unknown): WorkflowTaskBindingData | undefined {
	if (!isObjectRecord(value)) return undefined;
	const epochRef = value.epochRef;
	const workflowId = value.workflowId;
	const taskId = value.taskId;
	const attemptId = value.attemptId;
	const executionKey = value.executionKey;
	const deadlineAt = value.deadlineAt;
	const capsuleDigest = value.capsuleDigest;
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "workflow_task_binding" ||
		typeof workflowId !== "string" ||
		workflowId.length === 0 ||
		typeof taskId !== "string" ||
		taskId.length === 0 ||
		typeof attemptId !== "string" ||
		attemptId.length === 0 ||
		typeof executionKey !== "string" ||
		executionKey.length === 0 ||
		typeof deadlineAt !== "string" ||
		deadlineAt.length === 0 ||
		typeof capsuleDigest !== "string" ||
		capsuleDigest.length === 0 ||
		!isObjectRecord(epochRef) ||
		!isNonNegativeInteger(epochRef.storeEpoch) ||
		!isNonNegativeInteger(epochRef.coordinatorEpoch)
	)
		return undefined;
	if (!Number.isFinite(Date.parse(deadlineAt))) return undefined;
	return {
		schemaVersion: 1,
		kind: "workflow_task_binding",
		workflowId,
		taskId,
		attemptId,
		executionKey,
		epochRef: { storeEpoch: epochRef.storeEpoch, coordinatorEpoch: epochRef.coordinatorEpoch },
		deadlineAt,
		capsuleDigest,
	};
}

function parseWorkflowTaskTerminalRecord(value: unknown): WorkflowTaskTerminalRecord | undefined {
	if (!isObjectRecord(value)) return undefined;
	const binding = parseWorkflowTaskBinding(value.binding);
	const status = value.status;
	const reason = value.reason;
	const terminalAt = value.terminalAt;
	const recordDigest = value.recordDigest;
	if (
		value.schemaVersion !== 1 ||
		value.kind !== WORKFLOW_TASK_TERMINAL_CUSTOM_ENTRY ||
		binding === undefined ||
		(status !== "completed" && status !== "error" && status !== "cancelled" && status !== "deadline") ||
		typeof terminalAt !== "string" ||
		!Number.isFinite(Date.parse(terminalAt)) ||
		(reason !== undefined && typeof reason !== "string") ||
		typeof recordDigest !== "string"
	)
		return undefined;
	const unsigned: Omit<WorkflowTaskTerminalRecord, "recordDigest"> = {
		schemaVersion: 1 as const,
		kind: WORKFLOW_TASK_TERMINAL_CUSTOM_ENTRY,
		binding,
		status,
		...(reason === undefined ? {} : { reason }),
		terminalAt,
	};
	if (digestObject(unsigned) !== recordDigest) return undefined;
	return {
		...unsigned,
		recordDigest,
	};
}

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
	const { id, message, deliveryStatus, blockedReason, auditOnly, target } = value.message;
	if (
		typeof id !== "string" ||
		typeof message !== "string" ||
		(deliveryStatus !== "delivered" && deliveryStatus !== "queued" && deliveryStatus !== "blocked") ||
		(blockedReason !== undefined && typeof blockedReason !== "string") ||
		(auditOnly !== undefined && auditOnly !== true) ||
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
			...(typeof blockedReason === "string" ? { blockedReason } : {}),
			...(auditOnly === true ? { auditOnly: true as const } : {}),
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

/**
 * Per-agent-message settlement record: `delivery` settles when the prompt reaches agent state,
 * `completion` when its turn (or command) finishes. Settled deferreds are removed immediately.
 */
interface AgentMessageOutcome {
	delivery?: AgentMessageDeferred;
	context?: AgentMessageDeferred;
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

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	/** Whether cycling through scoped models (--models flag) or all available */
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

interface WorkflowKernelHostBindings {
	readonly hostRequestHandlers?: HostRequestHandlers;
	readonly resolveHostRequestCapability?: (requestType: string) => HostRequestCapabilityContext;
	readonly admitWorkerModel?: WorkerModelCapabilityLaunchAuthorizer;
	readonly ensurePrimeWorkflow?: () => Promise<unknown>;
	readonly primeWorkflow?: {
		readonly plannerDirective?: string;
		readonly snapshots?: {
			readonly recipe: { readonly recipeDigest: string };
			readonly skills: readonly WorkflowSkillSnapshot[];
		};
		readonly taskGraph?: { readonly graphDigest: string };
		readonly readSchedulerState?: () => Promise<WorkflowSchedulerState>;
		readonly executeSkill?: <TResult>(input: {
			readonly snapshotDigest: string;
			readonly token: string | Readonly<Uint8Array>;
			readonly current: WorkflowSkillHostInvocationContext;
			readonly executor: WorkflowSkillExecutor<TResult>;
		}) => Promise<TResult>;
		readonly executeSkillIteration?: <TResult>(input: {
			readonly skillName: string;
			readonly current: WorkflowSkillHostInvocationContext;
			readonly executor: WorkflowSkillExecutor<TResult>;
		}) => Promise<TResult>;
		readonly learning?: WorkflowLearningRuntimeAdapter;
		readonly pipeline?: {
			read(): Promise<{
				readonly workflowId: string;
				readonly recipeDigest: string;
				readonly completedStageIds: readonly string[];
				readonly readyStageIds: readonly string[];
				readonly stateDigest: string;
			}>;
		};
		readonly executionEvidence?: { read(): Promise<WorkflowExecutionEvidenceState> };
		readonly adaptiveRuntime?: { read(): Promise<PrimeAdaptiveRuntimeState> };
		readonly recordSkillOutcome?: (skillName: string, result: Record<string, unknown>) => Promise<void>;
	};
}

interface WorkflowKernelOwnership {
	readonly workflowId: string | undefined;
	readonly workflowBound: boolean;
}

export type AgentSessionWorkflowWorkerLaunchContext = Omit<
	WorkerModelCapabilityLaunchInput,
	"prompt" | "sessionName" | "selector" | "provider" | "model" | "reasoning" | "allowFallback"
> & { readonly deadlineAt: string; readonly capsuleDigest?: string };

export interface WorkflowSkillExecutionInput {
	/** Admitted built-in skill name; raw paths and unregistered names are rejected. */
	readonly skillName: string;
}

const WORKFLOW_START_USAGE = "Usage: /workflow start [--profile inline|parallel] [--max-workers <n>] [objective]";
const WORKFLOW_RESPOND_USAGE =
	"Usage: /workflow respond <approval-request-id> <option-id> (requires a structured trusted approval proof from the host boundary)";
const WORKFLOW_BRAINSTORM_CONTEXT_QUESTION =
	"What are we working on? Provide /workflow <what we are working on> before workflow execution can begin.";

function readWorkflowToken(value: string): { token: string; remainder: string } {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/u.exec(value);
	if (match === null) throw new Error(WORKFLOW_START_USAGE);
	return { token: match[1], remainder: match[2]?.trim() ?? "" };
}

type WorkflowSessionCommand =
	| WorkflowCommand
	| {
			kind: "brainstorm";
			prompt?: string;
			requestedProfile?: "inline" | "parallel";
			maxWorkers?: number;
	  }
	| { kind: "approve"; cloud: boolean };

function parseWorkflowStartCommand(remainder: string): Extract<WorkflowSessionCommand, { kind: "brainstorm" }> {
	let remaining = remainder.trim();
	let requestedProfile: "inline" | "parallel" | undefined;
	let maxWorkers: number | undefined;
	while (remaining.startsWith("--")) {
		const option = readWorkflowToken(remaining);
		remaining = option.remainder;
		if (option.token === "--profile" || option.token.startsWith("--profile=")) {
			if (requestedProfile !== undefined) throw new Error(WORKFLOW_START_USAGE);
			const value =
				option.token === "--profile"
					? readWorkflowToken(remaining)
					: { token: option.token.slice(10), remainder: remaining };
			if (option.token === "--profile") remaining = value.remainder;
			if (value.token !== "inline" && value.token !== "parallel") throw new Error(WORKFLOW_START_USAGE);
			requestedProfile = value.token;
			continue;
		}
		if (option.token === "--max-workers" || option.token.startsWith("--max-workers=")) {
			if (maxWorkers !== undefined) throw new Error(WORKFLOW_START_USAGE);
			const value =
				option.token === "--max-workers"
					? readWorkflowToken(remaining)
					: { token: option.token.slice(14), remainder: remaining };
			if (option.token === "--max-workers") remaining = value.remainder;
			if (!/^\d+$/u.test(value.token)) throw new Error(WORKFLOW_START_USAGE);
			const parsed = Number(value.token);
			if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(WORKFLOW_START_USAGE);
			maxWorkers = parsed;
			continue;
		}
		throw new Error(WORKFLOW_START_USAGE);
	}
	return {
		kind: "brainstorm",
		...(remaining.length === 0 ? {} : { prompt: remaining }),
		...(requestedProfile === undefined ? {} : { requestedProfile }),
		...(maxWorkers === undefined ? {} : { maxWorkers }),
	};
}

function parseWorkflowSessionCommand(args: string): WorkflowSessionCommand {
	const trimmed = args.trim();
	if (trimmed.length === 0) return { kind: "brainstorm" };
	const separator = trimmed.search(/\s/u);
	const action = separator < 0 ? trimmed : trimmed.slice(0, separator);
	const remainder = separator < 0 ? "" : trimmed.slice(separator).trim();

	switch (action) {
		case "start":
			return parseWorkflowStartCommand(remainder);
		case "status":
			if (remainder.length > 0) throw new Error("Usage: /workflow status");
			return { kind: "status" };
		case "decisions":
			if (remainder.length > 0) throw new Error("Usage: /workflow decisions");
			return { kind: "decisions" };
		case "resources":
			if (remainder.length > 0) throw new Error("Usage: /workflow resources");
			return { kind: "resources" };
		case "respond":
			if (remainder.length === 0) throw new Error(WORKFLOW_RESPOND_USAGE);
			throw new Error(
				"Workflow approval responses require a structured trusted proof from the host boundary; textual option text is not an approval.",
			);
		case "approve":
			if (remainder !== "" && remainder !== "--cloud") throw new Error("Usage: /workflow approve [--cloud]");
			return { kind: "approve", cloud: remainder === "--cloud" };
		case "pause":
			if (remainder.length === 0) throw new Error("Usage: /workflow pause <reason>");
			return { kind: "pause", reason: remainder };
		case "resume":
			return { kind: "resume", note: remainder || undefined };
		case "cancel":
			return { kind: "cancel", reason: remainder || undefined };
		default:
			return { kind: "brainstorm", prompt: trimmed };
	}
}

function formatWorkflowSessionStatus(status: WorkflowShellStatus): string {
	const phase = status.phase === null ? "" : ` (${status.phase})`;
	const objective = status.goal.objective === undefined ? "" : ` objective=${JSON.stringify(status.goal.objective)}`;
	const acceptance = ` acceptance=${status.acceptanceCheckIds.join(",")}`;
	const invariants = ` invariants=${status.protectedInvariantIds.join(",")}`;
	const decisions = ` decisions=${status.decisionRefs
		.map((ref) => `${ref.decisionId}@${ref.revision}:${ref.decisionDigest}`)
		.join(",")}`;
	const scorecard = ` scorecard=${status.scorecardDigest ?? "none"}`;
	const resources = ` resources=${status.resourceEnvelopeDigest ?? "none"}`;
	const waits = ` waits=${status.pendingWaitReasons.map((reason) => reason.code).join(",")}`;
	const next =
		status.status === "awaiting_user" && status.approvalRequest === null
			? ' next="/workflow resume" to approve this exact proposal'
			: "";
	const blocked = status.blocked === undefined ? "" : ` [blocked:${status.blocked.kind}] ${status.blocked.reason}`;
	return `Workflow ${status.workflowId ?? "none"}: ${status.status}${phase}${objective}${acceptance}${invariants}${decisions}${scorecard}${resources}${waits}${next}${blocked}`;
}

function sameWorkflowGoalProjection(left: GoalState, right: GoalState): boolean {
	return (
		left.active === right.active &&
		left.status === right.status &&
		left.workflowId === right.workflowId &&
		left.goalId === right.goalId &&
		left.objective === right.objective &&
		left.tokenBudget === right.tokenBudget &&
		left.tokensUsed === right.tokensUsed &&
		left.timeUsedSeconds === right.timeUsedSeconds &&
		left.continuationsUsed === right.continuationsUsed &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.lastReason === right.lastReason &&
		left.lastError === right.lastError
	);
}

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
	status: RlmChildAgentStatus;
	error?: string;
	retryable?: boolean;
	abort: () => void;
	publication: AgentMessageDeferred;
	completion: RlmChildCompletionDeferred;
	/** Child session, once its runtime exists. Used to cancel nested child runs. */
	session?: AgentSession;
	/** True once the detached run task has finished its catch and cleanup paths. */
	settled: boolean;
	/** Selector snapshot for a delete admitted while runtime startup was still pending. */
	detachedDeletion?: RlmSubagentRegistryEntry;
	/** Re-emits the run's rlm_child_update snapshot with its current status. */
	emitUpdate?: () => void;
	/** Exact workflow-child kernel fence started at terminal cancellation. */
	terminalFence?: Promise<void>;
	/** True once the exact terminal fence has settled and its proof can be published. */
	terminalFenceSettled?: boolean;
	/** Exact cleanup failure that prevented terminal publication. */
	terminalFenceError?: Error;
	/** Idempotent child-event forwarder cleanup, once the child runtime exists. */
	unsubscribe?: () => void;
}

interface RlmChildCompletionResult {
	readonly status: "completed" | "error" | "cancelled";
	readonly output: string;
	readonly error: string | null;
	readonly retryable: boolean;
}

interface RlmChildCompletionDeferred {
	readonly promise: Promise<RlmChildCompletionResult>;
	resolve(result: RlmChildCompletionResult): void;
}

function createRlmChildCompletionDeferred(): RlmChildCompletionDeferred {
	let resolveCompletion: ((result: RlmChildCompletionResult) => void) | undefined;
	const promise = new Promise<RlmChildCompletionResult>((resolve) => {
		resolveCompletion = resolve;
	});
	return {
		promise,
		resolve: (result) => resolveCompletion?.(result),
	};
}

interface RlmSubagentModelSelection {
	model: Model<Api>;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Cap on the post-compaction kernel namespace probe so a wedged kernel can't stall recovery. */
const KERNEL_STATE_LISTING_TIMEOUT_MS = 5000;
const RLM_MAX_DEPTH_STATE_CUSTOM_TYPE = "rlm_max_depth_state";
const DEFAULT_PRIME_WORKER_MODEL = WORKER_MODEL_SELECTOR;
/** Upper bound on back-to-back mid-run messages accepted from one sender within a single run. */
const MAX_CONSECUTIVE_AGENT_MESSAGE_STEERS = 3;

/**
 * Tools brainstorming may use. Reconnaissance needs to read the workspace, so the
 * propose tool alone leaves the planner blind and it asks the user for file contents
 * it could have read. The read-only boundary is instructed in the brainstorm prompt
 * and enforced for real at the recon stage, which runs under the read_workspace
 * capability rather than session tools.
 */
const WORKFLOW_BRAINSTORM_TOOL_NAMES = [WORKFLOW_PROPOSE_TOOL_NAME, "ipython"] as const;

/** Split a `provider/model-id` worker selector; model ids may themselves contain slashes. */
function workerModelProvider(selector: string): string {
	const separator = selector.indexOf("/");
	return separator < 0 ? selector : selector.slice(0, separator);
}

function workerModelId(selector: string): string {
	const separator = selector.indexOf("/");
	return separator < 0 ? "" : selector.slice(separator + 1);
}

function noopRlmChildAbort(): void {}
function noopRlmChildEventUnsubscribe(): void {}

function autoRefineInstructions(reason: AutoRefineReason, review: AutoRefineReview): string {
	const detail = review.instructions
		? `
Reviewer instructions: ${review.instructions}`
		: "";
	return `Automatic refine review triggered by ${reason}. Only create/update/delete local harness entries if there is clear evidence that should help this session continue. Prefer an empty edits array over speculative or one-off memories. Do not promote anything global unless explicitly requested. Reviewer rationale: ${review.rationale}${detail}`;
}

export const NONAUTHORITATIVE_REFINEMENT_REJECTED = "nonauthoritative_refinement_rejected" as const;

const WORKFLOW_REFINEMENT_AUTHORITY_REQUIRED = `${NONAUTHORITATIVE_REFINEMENT_REJECTED}: workflow refinement requires an authenticated learning promotion receipt bound to an accepted stage result`;

export class AgentSessionRefinementError extends Error {
	readonly code = NONAUTHORITATIVE_REFINEMENT_REJECTED;

	constructor() {
		super(WORKFLOW_REFINEMENT_AUTHORITY_REQUIRED);
		this.name = "AgentSessionRefinementError";
	}
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

function workflowExecutionAssistantDigest(message: AssistantMessage): string {
	return digestObject({
		api: message.api,
		provider: message.provider,
		model: message.model,
		stopReason: message.stopReason,
		errorMessage: message.errorMessage ?? null,
		timestamp: message.timestamp,
		content: message.content.map((block) => {
			if (block.type === "text") return { type: block.type, text: block.text };
			if (block.type === "thinking") return { type: block.type, thinking: block.thinking };
			return {
				type: block.type,
				id: block.id,
				name: block.name,
				argumentsDigest: digestObject(block.arguments),
			};
		}),
		usage: {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			totalTokens: message.usage.totalTokens,
			costTotal: message.usage.cost.total,
		},
	});
}

function workflowExecutionToolResultDigest(result: unknown, isError: boolean): string {
	if (typeof result !== "object" || result === null || Array.isArray(result))
		throw new Error("Workflow tool result is not a canonical result object.");
	const content = (result as { readonly content?: unknown }).content;
	if (!Array.isArray(content)) throw new Error("Workflow tool result content is unavailable.");
	return digestObject({
		content: content.map((block) => {
			if (typeof block !== "object" || block === null || Array.isArray(block))
				throw new Error("Workflow tool result content is invalid.");
			const item = block as Record<string, unknown>;
			if (item.type === "text" && typeof item.text === "string") return { type: item.type, text: item.text };
			if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string")
				return { type: item.type, data: item.data, mimeType: item.mimeType };
			throw new Error("Workflow tool result content is invalid.");
		}),
		isError,
	});
}

function workflowExecutionToolResultFact(message: ToolResultMessage<unknown>): WorkflowExecutionToolResultFact {
	return {
		toolCallId: message.toolCallId,
		toolName: message.toolName,
		isError: message.isError,
		resultDigest: workflowExecutionToolResultDigest(message, message.isError),
	};
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

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private _serviceTierPreference: ServiceTier;

	private _scopedModels: Array<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _lastSessionActionSnapshot: SessionActionSnapshot = {
		queuedCount: 0,
		steering: [],
		followUps: [],
	};
	private _agentEventQueue: Promise<void> = Promise.resolve();
	private _workflowExecutionEventQueue: Promise<void> = Promise.resolve();
	private _workflowExecutionNextTurnIndex = 0;

	/** Session-owned actions. Items are never fed into Agent.steer/followUp. */
	private readonly _actionStore = new ActionStore<QueuedSessionAction>();
	private _agentMessageObligationBridge: SessionMessageObligationBridge | undefined;
	private _sessionInputPump: Promise<void> = Promise.resolve();
	// Coalesces wakes so overlapping submissions cannot start competing pumps.
	private _sessionInputPumpRequested = false;
	private _sessionInputPumpActive = false;
	// Invalidates preparation when a branch pause starts and finishes before its next await resumes.
	private _sessionInputPumpEpoch = 0;
	private _sessionInputArrivalEpoch = 0;
	// Persists abort/restart suspension after the initiating call returns.
	private _sessionInputPumpSuspended = false;
	/** Per-sender consecutive steer count, reset when the recipient finishes a run. */
	private readonly _consecutiveSteersBySender = new Map<string, number>();
	/** Content fingerprints already steered, so a repeated message cannot re-enter the loop. */
	private readonly _steeredAgentMessageFingerprints = new Set<string>();
	/** Sibling sessions that receive this worker's diffs, and how this worker identifies itself. */
	private _collaborationPeers?: { readonly author: string; readonly reviewers: readonly string[] };
	// Branch mutation pause leases can overlap and must all release before dispatch resumes.
	private readonly _queuedWorkPauses = new Set<symbol>();
	private _sessionActionCommitTail: Promise<void> = Promise.resolve();
	private _sessionActionCommitOwner: symbol | undefined;
	private _pendingSessionActionFenceWaiters = 0;
	private readonly _sessionActionCommitContext = new AsyncLocalStorage<symbol>();
	private readonly _sessionActionCommitDisposeAbortController = new AbortController();
	// Checkpoint and handoff waiters share lifecycle-edge notifications to avoid polling.
	private readonly _sessionInputCheckpointWaiters = new Set<() => void>();
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	private _goalState: GoalState = emptyGoalState();
	private _goalAccountingStartedAt: number | undefined = undefined;
	private _goalAccountedAssistantMessages = new WeakSet<AssistantMessage>();
	private _goalAccountingInFlight = new WeakMap<AssistantMessage, Promise<boolean>>();
	private _goalAbortInProgress = false;
	private _abortInProgress = false;
	private _autonomousState: AutonomousRuntimeState;
	private _autonomousContinuationSuppressionDepth = 0;
	private _autonomousContinuationSuppressedMessages = new WeakSet<AgentMessage>();

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _compactionOperation: Promise<void> | undefined = undefined;
	private readonly _compactionDeadlineMs: number;
	private _compactionAttempt = 0;
	private _compactionLiveness: Omit<AgentSessionCompactionLiveness, "elapsedMs"> | undefined;
	private _providerStreamLiveness: AgentSessionProviderStreamLiveness | undefined;
	private _providerStreamStartedAt: number | undefined;
	private _providerStreamIdentity: number | undefined;
	private _providerStreamStallDiagnostic: StreamLivenessDiagnostic | undefined;
	private readonly _toolExecutionDeadlineMs: number;
	private readonly _kernelPythonLauncher: string | undefined;
	private readonly _toolExecutionLiveness = new Map<string, ToolExecutionLiveness>();
	private readonly _toolExecutionDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _toolExecutionProgressDigests = new Map<string, string>();
	private _toolExecutionStallDiagnostic: ToolExecutionStallDiagnostic | undefined;
	/** One recovery attempt per overflow; "reported" dedups the failure notice. */
	private _overflowRecovery: "idle" | "attempted" | "reported" = "idle";
	private _continueAfterThresholdCompaction = false;
	private _pendingRequestedCompaction: { customInstructions?: string } | undefined;
	private _pendingRequestedRefine: { instructions?: string; global?: boolean } | undefined;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;
	private _branchSummaryOperation: Promise<void> | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	private _retryPromise: Promise<void> | undefined = undefined;
	private _retryResolve: (() => void) | undefined = undefined;
	private _retryAuthFailureSources: AuthSourceToken[] = [];
	private _resourceCapacityRevision = "epoch:0";
	private _resourceProbeWakeTimer: ReturnType<typeof setTimeout> | undefined;
	private _agentMessageOutcomes = new Map<string, AgentMessageOutcome>();
	private readonly _agentMessageDeliveryDeadlineMs: number;
	private readonly _agentMessageDeliveryDeadlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly _pendingAgentMessageContextDeliveries = new Set<string>();
	private _agentMessageDeadlineContextCommit: Promise<void> = Promise.resolve();
	private _lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	/** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
	private readonly _unpersistedCompactionOutcomes: CustomMessage[] = [];

	// Bash execution state
	private _bashAbortController: AbortController | undefined = undefined;
	private _userBashRunning = false;
	private _userBashAbortRequested = false;
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
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
	private _mcpManager?: McpManager;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;
	private _workflowHost?: WorkflowShell;
	private _workflowHostLoader?: () => Promise<void>;
	private _workflowHostLoading?: Promise<WorkflowShell>;
	private _workflowHostRequestHandlers?: HostRequestHandlers;
	private _workflowExecutionEvidenceSource?: WorkflowExecutionEvidenceSource;
	private _workflowBrainstorm?: WorkflowBrainstormState;
	private _workflowExecutionTurnHandle?: WorkflowExecutionTurnHandle;
	private _workflowExecutionToolStarts: WorkflowExecutionToolCallFact[] = [];
	private _workflowExecutionToolEnds: WorkflowExecutionToolResultFact[] = [];
	private _workflowTaskBinding?: WorkflowTaskBinding;
	private _workflowTaskTerminal?: WorkflowTaskTerminalRecord;
	private _workflowTaskDeadlineMonotonicAtMs?: number;
	private _workflowTaskDeadlineAbort?: () => void;
	private _queuedWorkflowPlannerStateDigest?: string;
	private _hostRequestCapabilityContext: HostRequestCapabilityContext;
	private readonly _hasExplicitHostRequestCapabilityContext: boolean;
	private _disposed = false;
	private readonly _disposeCallbacks = new Set<() => void | Promise<void>>();
	private _disposeCallbacksPromise?: Promise<void>;
	// Set at the start of async teardown so a child finishing mid-disposeAsync doesn't
	// re-populate the retained map after it's been cleared.
	private _disposing = false;
	private _disposeAsyncPromise?: Promise<void>;
	private _ipythonKernelProvisioner?: IpythonKernelProvisioner;
	/** Prewarm is held until workflow identity and task binding are available. */
	private _ipythonPrewarmPending = false;
	private readonly _workflowSetupGate: Promise<void>;
	private _workflowSetupReady = false;
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
	private _rlmChildCompletionPromises = new Map<string, Promise<RlmChildCompletionResult>>();
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

	// Model registry for API key resolution
	private _modelRegistry: ModelRegistry;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
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
	private _postCompactionContinuationMessages: AgentMessage[] = [];
	private _scheduledPostCompactionContinuationMessages: AgentMessage[] = [];
	private _queuedAutonomousThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedAutonomousContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionAutonomousMessages: AgentMessage[] = [];
	private _pendingAutoRefineReview: { reason: AutoRefineReason; review: AutoRefineReview } | undefined;
	private _autoRefineBranchVersion = 0;
	private _autoRefineReviewAbort?: AbortController;
	private _refineAbortController?: AbortController;
	private readonly _autoRefineReviewer?: AutoRefineReviewer;
	/** When true, auto-refine runs synchronously between turns (serialized mode). */
	private readonly _serializedRefine: boolean;
	/** Settles (never rejects) after a planned refine waits for idle and finishes applying. */
	private _refineInFlight?: Promise<void>;
	/** Settles when the background planning LLM pass completes. Planning does not block turn entry points. */
	private _refinePlanInFlight?: Promise<void>;
	/**
	 * Settles when a serialized-mode background planning pass completes.
	 * Planning starts at assistant message_end (overlapping tool execution)
	 * and is awaited at shouldStopAfterTurn before applying.
	 */
	private _serializedPlanInFlight?: Promise<SerializedBackgroundPlanResult | undefined>;
	private _serializedPlanClaim?: Promise<void>;
	private _serializedExplicitRefineOptions?: {
		instructions?: string;
		global?: boolean;
	};

	constructor(config: AgentSessionConfig) {
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
		this._compactionDeadlineMs = config.compactionDeadlineMs ?? DEFAULT_COMPACTION_DEADLINE_MS;
		if (!Number.isFinite(this._compactionDeadlineMs) || this._compactionDeadlineMs <= 0) {
			throw new Error("compactionDeadlineMs must be a positive finite number");
		}
		this._toolExecutionDeadlineMs = config.toolExecutionDeadlineMs ?? DEFAULT_TOOL_EXECUTION_DEADLINE_MS;
		if (!Number.isFinite(this._toolExecutionDeadlineMs) || this._toolExecutionDeadlineMs <= 0) {
			throw new Error("toolExecutionDeadlineMs must be a positive finite number");
		}
		this._agentMessageDeliveryDeadlineMs =
			config.agentMessageDeliveryDeadlineMs ?? DEFAULT_AGENT_MESSAGE_DELIVERY_DEADLINE_MS;
		if (!Number.isFinite(this._agentMessageDeliveryDeadlineMs) || this._agentMessageDeliveryDeadlineMs <= 0) {
			throw new Error("agentMessageDeliveryDeadlineMs must be a positive finite number");
		}
		this._kernelPythonLauncher = config.kernelPythonLauncher;
		const streamLiveness = config.streamLiveness ?? getDefaultStreamLivenessHost();
		this.agent.streamLiveness = createStreamLivenessHost({
			policyResolver: streamLiveness.policyResolver,
			clock: streamLiveness.clock,
			scheduler: streamLiveness.scheduler,
			abortability: streamLiveness.abortability,
			onState: (state) => {
				this._observeProviderStreamLiveness(state, streamLiveness);
				streamLiveness.onState?.(state);
			},
			onTerminal: (outcome) => {
				this._observeProviderStreamTerminal(outcome);
				streamLiveness.onTerminal?.(outcome);
			},
		});
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._allowedToolNames?.add(WORKFLOW_PROPOSE_TOOL_NAME);
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
		this._prewarmIpythonKernel = (config.prewarmIpythonKernel ?? false) && this._rlmDepth === 0;
		this._workflowSetupGate = config.workflowSetupGate ?? Promise.resolve();
		void this._workflowSetupGate.then(
			() => {
				this._workflowSetupReady = true;
				this._releaseDeferredIpythonPrewarm();
			},
			() => undefined,
		);
		this._autoRefineReviewer = config.autoRefineReviewer;
		this._serializedRefine = config.serializedRefine ?? false;
		this._rlmSessionDir = config.rlmSessionDir;
		this._rlmParentNodeId = config.rlmParentNodeId;
		this._rlmParentAgent = config.rlmParentAgent;
		this._workflowHost = config.workflowHost;
		this._hasExplicitHostRequestCapabilityContext = config.hostRequestCapabilityContext !== undefined;
		this._hostRequestCapabilityContext = config.hostRequestCapabilityContext ?? { capabilities: [] };
		if (this._workflowHost !== undefined) {
			const workflowHost = this._workflowHost;
			this.registerDisposeCallback(() => workflowHost.dispose?.());
		}
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
		const restoredWorkflowBrainstorm = restoreWorkflowBrainstormState(this.agent.state.messages);
		this._workflowBrainstorm =
			restoredWorkflowBrainstorm?.workflowId === this.sessionManager.getSessionId()
				? restoredWorkflowBrainstorm
				: undefined;
		this._providerStreamStallDiagnostic = this._loadPersistedProviderStreamStallDiagnostic();
		this._toolExecutionStallDiagnostic = this._loadPersistedToolExecutionStallDiagnostic();
		this._restorePersistedToolExecutionLeases();
		// Seed initial goal from CLI --goal flag, but only for top-level sessions
		// and only when the branch contains only bootstrap entry types (model_change,
		// thinking_level_change, service_tier_change) and no persisted
		// thread_goal_state. This prevents reseeding after clear/complete/error
		// or restart/rehydration of a session that already has messages or a goal.
		if (this._rlmDepth === 0 && config.initialGoal && this._isBranchSeedable()) {
			this._goalState = this._startGoal(config.initialGoal.objective, config.initialGoal.tokenBudget);
			// Goal context is the model's only source of goal visibility; action
			// admission is unavailable mid-construction, so ride the next turn.
			this._pendingNextTurnMessages.push(this._createGoalContextMessage("continuation"));
		}
		this._restoreLateIpythonSentAgentMessages();
		if (this._goalState.status === "active") {
			this._goalAccountingStartedAt = Date.now();
		}
		this._restoreWorkflowTaskAdmission();

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnHook();
		this._installAgentContinuationHook();

		this._buildRuntime({
			activeToolNames:
				this._workflowBrainstorm?.status === "draft"
					? [WORKFLOW_PROPOSE_TOOL_NAME]
					: this._workflowBrainstorm?.status === "proposed"
						? []
						: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		const persistedResourceBlocker = this.sessionManager.getLatestResourceExhaustedBlocker();
		if (persistedResourceBlocker) {
			this._resourceCapacityRevision = persistedResourceBlocker.capacityRevision;
			this._scheduleResourceExhaustionProbeWake(persistedResourceBlocker);
		}
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

	/** Model registry for API key resolution and model discovery */
	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this._subagentRuntimeHost = host;
	}

	/**
	 * Bind the persisted-session workflow shell once and register its lifecycle with this session.
	 *
	 * Args:
	 * host: Durable workflow shell created by the session service, or undefined before initial binding.
	 * Return: No value.
	 */
	setWorkflowHost(host?: WorkflowShell, executionEvidenceSource?: WorkflowExecutionEvidenceSource): void {
		if (
			executionEvidenceSource !== undefined &&
			(host === undefined || !isWorkflowExecutionEvidenceSourceForHost(executionEvidenceSource, host))
		)
			throw new Error("The workflow execution-evidence source is not host issued.");
		if (this._workflowHost === host) {
			if (this._workflowExecutionEvidenceSource !== executionEvidenceSource)
				throw new Error("The durable workflow host cannot be rebound with a different execution-evidence source.");
			return;
		}
		if (this._workflowHost !== undefined) {
			throw new Error("The durable workflow host cannot be detached or replaced once bound.");
		}
		this._workflowHost = host;
		this._workflowExecutionEvidenceSource = executionEvidenceSource;
		if (host !== undefined && host.status().status === "awaiting_user") {
			if (this._workflowBrainstorm?.status === "draft")
				this._persistWorkflowBrainstormState({ ...this._workflowBrainstorm, status: "proposed" });
			if (this._workflowBrainstorm?.status === "proposed") this.setActiveToolsByName([]);
		}
		const bindings = host as WorkflowKernelHostBindings | undefined;
		if (bindings?.hostRequestHandlers !== undefined) {
			if (this._workflowHostRequestHandlers === undefined)
				throw new Error("Workflow kernel host handlers were not installed before workflow binding.");
			Object.assign(this._workflowHostRequestHandlers, bindings.hostRequestHandlers);
		}
		// KernelManager snapshots both its gateway handler map and environment at
		// construction. Rebuild after durable binding so a prewarmed kernel cannot
		// retain pre-host refinement permissions or a writable harness.
		this._buildRuntime({ activeToolNames: this.getActiveToolNames(), includeAllExtensionTools: true });
		if (host !== undefined) this.registerDisposeCallback(() => host.dispose?.());
		this._releaseDeferredIpythonPrewarm();
	}

	/**
	 * Register the one-use loader that creates workflow authority only after a proposal is complete.
	 * Args:
	 * loader: Host-owned initializer that must bind the resulting workflow host to this session.
	 * Return: No value.
	 */
	setWorkflowHostLoader(loader: () => Promise<void>): void {
		if (this._workflowHost !== undefined || this._workflowHostLoader !== undefined)
			throw new Error("The durable workflow host loader is already configured.");
		this._workflowHostLoader = loader;
	}

	/**
	 * Read safe workflow status from the already-bound host without loading workflow runtime state.

	 * Return: Safe workflow status projection, or undefined before host binding.
	 */
	getWorkflowStatusProjection(): DaemonWorkflowStatusProjection | undefined {
		const status = this._workflowHost?.status();
		if (status === undefined) return undefined;
		const blocked = status.blocked;
		const approvalRequest = status.approvalRequest;
		return {
			workflowId: status.workflowId,
			status: status.status,
			phase: status.phase === "recovering" ? null : status.phase,
			nextGate: null,
			nextTask: null,
			blocker:
				blocked === undefined
					? null
					: {
							kind: blocked.kind,
							reason: blocked.reason,
							...(blocked.blockerId === undefined ? {} : { blockerId: blocked.blockerId }),
							...(blocked.blockerDigest === undefined ? {} : { blockerDigest: blocked.blockerDigest }),
							...(blocked.owner === undefined ? {} : { owner: blocked.owner }),
							...(blocked.resumeEventKind === undefined ? {} : { resumeEventKind: blocked.resumeEventKind }),
							...(blocked.resumePredicateDigest === undefined
								? {}
								: { resumePredicateDigest: blocked.resumePredicateDigest }),
							...(blocked.nextEligibleAt === undefined ? {} : { nextEligibleAt: blocked.nextEligibleAt }),
						},
			headDigest: status.stateDigest,
			approvalRequest:
				approvalRequest === null
					? null
					: {
							approvalRequestId: approvalRequest.approvalRequestId,
							question: approvalRequest.question,
							expiresAt: approvalRequest.expiresAt,
							expectedResponseSequence: approvalRequest.expectedResponseSequence,
							headDigest: approvalRequest.headDigest,
							stateDigest: approvalRequest.stateDigest,
							options: approvalRequest.options.map(({ optionId, label, effectDigest }) => ({
								optionId,
								label,
								effectDigest,
							})),
						},
		};
	}

	private async _ensureWorkflowHost(): Promise<WorkflowShell> {
		if (this._workflowHost !== undefined) return this._workflowHost;
		if (this._workflowHostLoading !== undefined) return this._workflowHostLoading;
		const loader = this._workflowHostLoader;
		if (loader === undefined) throw new Error("Workflow commands require a persisted session artifact root.");
		this._workflowHostLoading = (async () => {
			await loader();
			if (this._workflowHost === undefined)
				throw new Error("The durable workflow host loader did not bind workflow authority.");
			this._workflowHostLoader = undefined;
			return this._workflowHost;
		})();
		try {
			return await this._workflowHostLoading;
		} finally {
			this._workflowHostLoading = undefined;
		}
	}

	private _persistWorkflowBrainstormState(state: WorkflowBrainstormState): void {
		const message = workflowBrainstormMessage(state);
		this.sessionManager.appendCustomMessageEntryWithRollback(
			message.customType,
			message.content,
			message.display,
			message.details,
		);
		this._workflowBrainstorm = state;
		this.agent.state.messages.push(message);
		this._emit({ type: "message_start", message });
		this._emit({ type: "message_end", message });
	}

	private _currentWorkflowTaskContext(): string | undefined {
		for (let index = this.agent.state.messages.length - 1; index >= 0; index--) {
			const message = this.agent.state.messages[index];
			if (message?.role !== "user") continue;
			const text = normalizeMessageContent(message.content).text.trim();
			if (text.length > 0 && !text.startsWith("/workflow")) return text;
		}
		return undefined;
	}

	private async _beginWorkflowBrainstorm(input: {
		prompt?: string;
		requestedProfile?: "inline" | "parallel";
		maxWorkers?: number;
	}): Promise<string> {
		const hostStatus = this._workflowHost?.status();
		if (hostStatus !== undefined && hostStatus.status !== "idle")
			throw new Error(
				`Workflow brainstorming requires idle workflow authority; current status is ${hostStatus.status}.`,
			);
		if (this._workflowBrainstorm?.status === "proposed")
			throw new Error("The sealed workflow proposal is already awaiting trusted approval.");
		const prompt = input.prompt?.trim() || this._currentWorkflowTaskContext();
		if (prompt === undefined) {
			const state =
				this._workflowBrainstorm?.status === "draft"
					? this._workflowBrainstorm
					: createWorkflowBrainstormState({
							workflowId: this.sessionManager.getSessionId(),
							prompt: WORKFLOW_BRAINSTORM_CONTEXT_QUESTION,
							requestedProfile: input.requestedProfile,
							maxWorkers: input.maxWorkers,
							previousToolNames: this.getActiveToolNames().filter((name) => name !== WORKFLOW_PROPOSE_TOOL_NAME),
						});
			if (this._workflowBrainstorm !== state) this._persistWorkflowBrainstormState(state);
			this.setActiveToolsByName([...WORKFLOW_BRAINSTORM_TOOL_NAMES]);
			return WORKFLOW_BRAINSTORM_CONTEXT_QUESTION;
		}
		const state =
			this._workflowBrainstorm?.status === "draft" && input.prompt === undefined
				? this._workflowBrainstorm
				: createWorkflowBrainstormState({
						workflowId: this.sessionManager.getSessionId(),
						prompt,
						requestedProfile: input.requestedProfile,
						maxWorkers: input.maxWorkers,
						previousToolNames: this.getActiveToolNames().filter((name) => name !== WORKFLOW_PROPOSE_TOOL_NAME),
					});
		if (this._workflowBrainstorm !== state) this._persistWorkflowBrainstormState(state);
		this.setActiveToolsByName([...WORKFLOW_BRAINSTORM_TOOL_NAMES]);
		await this._queuePreparedPrompt("followUp", workflowBrainstormPrompt(state), undefined, {
			resumeIfIdle: true,
			source: "internal",
			queueKey: `workflow-brainstorm:${state.draftId}`,
			previewLabel: "Workflow brainstorming",
			suppressAutonomousContinuation: true,
		});
		return "Workflow brainstorming started. I will ask only for material missing decisions, then present one exact proposal for approval.";
	}

	private async _submitWorkflowBrainstormProposal(
		proposal: WorkflowBrainstormProposal,
	): Promise<{ readonly status: string }> {
		const state = this._workflowBrainstorm;
		if (state?.status !== "draft")
			throw new Error("Workflow proposal submission requires an active brainstorm draft.");
		const artifactRoot = this.sessionManager.getSessionArtifactDir();
		if (artifactRoot === undefined)
			throw new Error("Workflow proposal submission requires persisted session artifacts.");
		const request = await workflowStartRequestFromProposal({ artifactRoot, state, proposal });
		normalizeWorkflowAcceptanceRequest(request);
		await this._ensureWorkflowHost();
		const status = await this.executeWorkflowCommand({ kind: "start", request });
		if (status.status !== "awaiting_user")
			throw new Error("Workflow proposal did not reach the durable awaiting-user approval state.");
		this._persistWorkflowBrainstormState({
			...state,
			status: "proposed",
			proposalDigest: workflowProposalDigest(proposal),
		});
		this.setActiveToolsByName([]);
		return { status: status.status };
	}

	private async _approveWorkflowProposal(cloud: boolean): Promise<WorkflowShellStatus> {
		const workflowHost = await this._ensureWorkflowHost();
		const pending = workflowHost.status();
		if (pending.status !== "awaiting_user" || pending.approvalRequest === null)
			throw new Error("Workflow approval requires one pending durable proposal.");
		const artifactRoot = this.sessionManager.getSessionArtifactDir();
		if (artifactRoot === undefined) throw new Error("Workflow approval requires persisted session artifacts.");
		const delivery = await readWorkflowCliApprovalDelivery(artifactRoot);
		if (
			delivery === undefined ||
			delivery.request.workflowId !== pending.approvalRequest.workflowId ||
			delivery.request.approvalRequestId !== pending.approvalRequest.approvalRequestId ||
			delivery.request.stateDigest !== pending.approvalRequest.stateDigest
		)
			throw new Error("The trusted approval credential is unavailable or stale for this proposal.");
		const optionId = cloud ? "approve_cloud" : "approve";
		const proof = delivery.proofs[optionId];
		if (proof === undefined) throw new Error(`The trusted approval option ${optionId} is unavailable.`);
		const status = await this.executeWorkflowCommand({
			kind: "respond",
			approvalRequestId: pending.approvalRequest.approvalRequestId,
			optionId,
			proof,
		});
		if (status.status !== "active")
			throw new Error("Trusted workflow approval did not activate the durable workflow.");
		await removeWorkflowCliApprovalDelivery(artifactRoot);
		const state = this._workflowBrainstorm;
		if (state?.status === "proposed") {
			this._persistWorkflowBrainstormState({ ...state, status: "activated" });
			this.setActiveToolsByName([...state.previousToolNames]);
		}
		return status;
	}

	/**
	 * Execute one durable workflow command and start planner continuity when it activates the goal.
	 *
	 * Args:
	 * command: Structured command authorized by the session boundary.
	 * Return: Current durable workflow status after the command.
	 */
	async executeWorkflowCommand(command: WorkflowCommand): Promise<WorkflowShellStatus> {
		const workflowHost = await this._ensureWorkflowHost();
		if (command.kind === "start" && command.request.goalContract === undefined) {
			throw new Error(
				"A causal goal contract is required before starting the default workflow; provide explicit success metrics, protected guards, non-goals, and budgets for user approval.",
			);
		}
		const status = await workflowHost.execute(command);
		if (status.status === "active") await (workflowHost as WorkflowKernelHostBindings).ensurePrimeWorkflow?.();
		const activatesPlanner = command.kind === "start" || command.kind === "respond" || command.kind === "resume";
		if (activatesPlanner) this._queueWorkflowPlannerIfActive(status, false);
		return status;
	}

	/**
	 * Execute an admitted built-in skill through the authenticated Prime host.
	 *
	 * Args:
	 * input: Snapshot token, current invocation tuple, and the host-side executor.
	 * Return: Executor result after durable admission and nonce consumption.
	 */
	async executeWorkflowSkill(input: WorkflowSkillExecutionInput): Promise<Record<string, unknown>> {
		if (input.skillName.length === 0) throw new Error("Workflow skill name is required.");
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow skill execution requires a persisted session host.");
		const workflowStatus = workflowShell.status().status;
		if (workflowStatus === "complete" && input.skillName === "mempalace") {
			await (workflowShell as WorkflowKernelHostBindings).ensurePrimeWorkflow?.();
			return this.executeWorkflowHostRequest("workflow.v1.mempalace.recall", {
				query: `skill:${input.skillName}`,
				limit: 1,
			});
		}
		if (workflowStatus !== "active")
			throw new Error("Workflow skill execution requires an active authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const executeSkillIteration = workflowHost.primeWorkflow?.executeSkillIteration;
		if (executeSkillIteration === undefined) throw new Error("Workflow skill execution is unavailable on this host.");
		const snapshot = workflowHost.primeWorkflow?.snapshots?.skills.find(
			(candidate) => candidate.skillName === input.skillName,
		);
		if (snapshot === undefined) throw new Error("Workflow skill is not admitted by the active Prime recipe.");
		const current: WorkflowSkillHostInvocationContext = {
			workflowId: snapshot.workflowId,
			taskId: snapshot.taskId,
			decisionRef: snapshot.decisionRef,
			configDigest: snapshot.configDigest,
			workspaceDigest: snapshot.workspaceDigest,
			attemptId: snapshot.attemptId,
			epochRef: snapshot.epochRef,
			dependencyManifestDigest: snapshot.dependencyManifestDigest,
			workflowContractRevision: snapshot.workflowContractRevision,
			trustedNow: snapshot.trustedNow,
			journalHeadDigest: snapshot.journalHeadDigest,
		};
		const result = await executeSkillIteration({
			skillName: input.skillName,
			current,
			executor: {
				execute: async () => {
					if (input.skillName === "workflow-autoresearch") {
						return this.executeWorkflowHostRequest("workflow.v1.autoresearch.run", {
							recipe_digest: workflowHost.primeWorkflow?.snapshots?.recipe.recipeDigest,
							evidence_refs: [],
						});
					}
					if (input.skillName === "mempalace") {
						return this.executeWorkflowHostRequest("workflow.v1.mempalace.recall", {
							query: `skill:${input.skillName}`,
							limit: 1,
						});
					}
					throw new Error("Workflow skill has no host-owned execution route.");
				},
			},
		});
		await workflowHost.primeWorkflow?.recordSkillOutcome?.(input.skillName, result);
		return result;
	}

	/**
	 * Apply one host-authenticated learning promotion to the canonical workflow refinement store.
	 *
	 * Args:
	 * input: One-use promotion receipt and the host-validated refinement payload.
	 * Return: Canonical application result returned by the workflow authority.
	 */
	async applyWorkflowLearningPromotionRefinement(
		input: WorkflowLearningPromotionConsumeAndApplyInput,
	): Promise<WorkflowLearningPromotionApplication> {
		const workflowHost = this._workflowHost;
		if (workflowHost === undefined)
			throw new Error("Workflow learning promotion refinement requires a persisted session host.");
		const receipts = workflowHost.learningPromotionReceipts;
		if (receipts === undefined)
			throw new Error("Workflow learning promotion refinement is unavailable on this host.");
		return receipts.consumeAndApply(input);
	}

	/**
	 * Read the durable learning state composed by the active Prime workflow.
	 *
	 * Return: Authenticated learning experiences, reviews, triggers, and state digest replayed from the workflow journal.
	 */
	async getWorkflowLearningState(): ReturnType<WorkflowLearningRuntimeAdapter["getState"]> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow learning requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow learning requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const learning = workflowHost.primeWorkflow?.learning;
		if (learning === undefined) throw new Error("Workflow learning is unavailable on this host.");
		return learning.getState();
	}

	/**
	 * Read the receipt-backed cursor over the admitted Prime workflow stages.
	 *
	 * Return: Completed and dependency-ready stages replayed from the durable learning journal.
	 */
	async getWorkflowPipelineState(): Promise<{
		readonly workflowId: string;
		readonly recipeDigest: string;
		readonly completedStageIds: readonly string[];
		readonly readyStageIds: readonly string[];
		readonly stateDigest: string;
	}> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow pipeline requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow pipeline requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const pipeline = workflowHost.primeWorkflow?.pipeline;
		if (pipeline === undefined) throw new Error("Workflow pipeline is unavailable on this host.");
		return pipeline.read();
	}

	/**
	 * Read non-authorizing evidence of model and tool turns executed by this session.
	 *
	 * Return: Receipt-backed observations replayed from the durable learning journal.
	 */
	async getWorkflowExecutionEvidenceState(): Promise<WorkflowExecutionEvidenceState> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined)
			throw new Error("Workflow execution evidence requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow execution evidence requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const executionEvidence = workflowHost.primeWorkflow?.executionEvidence;
		if (executionEvidence === undefined) throw new Error("Workflow execution evidence is unavailable on this host.");
		return executionEvidence.read();
	}

	/**
	 * Read the immutable recipe digest admitted by the active Prime workflow.
	 *
	 * Return: The host-authenticated recipe digest used by canonical kernel requests.
	 */
	async getWorkflowPrimeRecipeDigest(): Promise<string> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow recipe requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow recipe requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const recipeDigest = workflowHost.primeWorkflow?.snapshots?.recipe.recipeDigest;
		if (recipeDigest === undefined) throw new Error("Workflow recipe is unavailable on this host.");
		return recipeDigest;
	}

	/**
	 * Read the exact task-graph digest bound to the active recipe admission.
	 *
	 * Return: The host-validated DAG digest retained across workflow reopen.
	 */
	async getWorkflowPrimeTaskGraphDigest(): Promise<string> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow task graph requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow task graph requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const graphDigest = workflowHost.primeWorkflow?.taskGraph?.graphDigest;
		if (graphDigest === undefined) throw new Error("Workflow task graph is unavailable on this host.");
		return graphDigest;
	}

	/**
	 * Read the durable default scheduler projection.
	 *
	 * Return: Queue, active-attempt, and terminal-attempt state retained across reopen.
	 */
	async getWorkflowSchedulerState(): Promise<WorkflowSchedulerState> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow scheduler requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow scheduler requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const readSchedulerState = workflowHost.primeWorkflow?.readSchedulerState;
		if (readSchedulerState === undefined) throw new Error("Workflow scheduler is unavailable on this host.");
		return readSchedulerState();
	}

	/**
	 * Persist and display a scheduler-bound worker failure for root-agent recovery.
	 *
	 * Args:
	 * notice: Durable task, attempt, recovery, and evidence binding produced by the scheduler.
	 * Return: Nothing.
	 */
	recordWorkflowWorkerFailure(notice: DefaultPrimeWorkerFailureNotice): void {
		if (
			this.agent.state.messages.some(
				(message) =>
					message.role === "custom" &&
					message.customType === "workflow_worker_failure" &&
					(message.details as DefaultPrimeWorkerFailureNotice | undefined)?.attemptId === notice.attemptId &&
					(message.details as DefaultPrimeWorkerFailureNotice | undefined)?.executionKey === notice.executionKey,
			)
		)
			return;
		const message = createWorkflowWorkerFailureMessage(notice);
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

	/**
	 * Read the durable adaptive planner and efficiency-review projection.
	 *
	 * Return: Non-authoritative recommendation bound to the authenticated pipeline state.
	 */
	async getWorkflowAdaptiveState(): Promise<PrimeAdaptiveRuntimeState> {
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow adaptive state requires a persisted session host.");
		if (!["active", "complete"].includes(workflowShell.status().status))
			throw new Error("Workflow adaptive state requires an active or completed authenticated workflow.");
		const workflowHost = workflowShell as WorkflowKernelHostBindings;
		await workflowHost.ensurePrimeWorkflow?.();
		const adaptiveRuntime = workflowHost.primeWorkflow?.adaptiveRuntime;
		if (adaptiveRuntime === undefined) throw new Error("Workflow adaptive state is unavailable on this host.");
		return adaptiveRuntime.read();
	}

	/**
	 * Dispatch one schema-validated workflow kernel request through the host gateway.
	 *
	 * Args:
	 * requestType: Canonical `workflow.v1.*` request name; raw skill names are rejected.
	 * payload: Closed request payload validated by the kernel gateway.
	 * Return: Host-produced result envelope payload.
	 */
	async executeWorkflowHostRequest(
		requestType: `workflow.v1.${string}`,
		payload: Record<string, unknown> = {},
	): Promise<Record<string, unknown>> {
		if (!requestType.startsWith("workflow.v1."))
			throw new Error("Workflow requests require the canonical v1 namespace.");
		const workflowShell = this._workflowHost;
		if (workflowShell === undefined) throw new Error("Workflow requests require a persisted session host.");
		const workflowStatus = workflowShell.status().status;
		const completedRead =
			workflowStatus === "complete" &&
			(requestType === "workflow.v1.mempalace.recall" || requestType === "workflow.v1.execution_evidence.read");
		if (workflowStatus !== "active" && !completedRead)
			throw new Error("Workflow requests require an active workflow or a completed-workflow read route.");
		await (workflowShell as WorkflowKernelHostBindings).ensurePrimeWorkflow?.();
		const handlers = this._workflowHostRequestHandlers;
		if (handlers === undefined) throw new Error("Workflow kernel host handlers are unavailable.");
		const bindings = workflowShell as WorkflowKernelHostBindings;
		const response = await createHostRequestGateway({
			handlers,
			capabilityResolver: (type) =>
				bindings.resolveHostRequestCapability?.(type) ?? this._resolveKernelHostCapability(type),
		}).dispatch({ ...payload, type: requestType });
		return response.result;
	}

	/**
	 * Resume planner continuity for an active workflow restored from durable storage.
	 *
	 * Return: True when a fresh planner turn was admitted.
	 */
	async resumeActiveWorkflow(): Promise<boolean> {
		const workflowHost = this._workflowHost;
		if (workflowHost === undefined) return false;
		const status = workflowHost.status();
		if (status.status === "active") await (workflowHost as WorkflowKernelHostBindings).ensurePrimeWorkflow?.();
		return this._queueWorkflowPlannerIfActive(status, false);
	}

	/** Wake planner continuity from a durable host-owned workflow obligation. */
	async wakeActiveWorkflow(): Promise<boolean> {
		const workflowHost = this._workflowHost;
		if (workflowHost === undefined) return false;
		const status = workflowHost.status();
		if (status.status === "active") await (workflowHost as WorkflowKernelHostBindings).ensurePrimeWorkflow?.();
		return this._queueWorkflowPlannerIfActive(status, true);
	}

	private _queueWorkflowPlannerIfActive(status: WorkflowShellStatus, wake: boolean): boolean {
		if (status.status !== "active") {
			this._queuedWorkflowPlannerStateDigest = undefined;
			return false;
		}
		const currentGoal = this.readGoalStateForWorkflowProjection();
		if (
			status.stateDigest === null ||
			status.stateDigest.length === 0 ||
			!status.goal.active ||
			status.goal.status !== "active" ||
			status.goal.objective === undefined ||
			!sameWorkflowGoalProjection(status.goal, currentGoal)
		)
			throw new Error("Active workflow status is not bound to the current durable goal projection.");
		if (this._queuedWorkflowPlannerStateDigest === status.stateDigest) return false;
		this._clearQueuedGoalContexts();
		this._queuedWorkflowPlannerStateDigest = status.stateDigest;
		this._runOrQueueGoalContext("continuation", undefined, wake);
		return true;
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

	private _restoreWorkflowTaskAdmission(): void {
		const branch = this.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry.type !== "custom") continue;
			if (entry.customType === WORKFLOW_TASK_TERMINAL_CUSTOM_ENTRY) {
				const terminal = parseWorkflowTaskTerminalRecord(entry.data);
				if (terminal === undefined) continue;
				this._workflowTaskBinding = terminal.binding;
				this._workflowTaskTerminal = terminal;
				return;
			}
			if (entry.customType !== WORKFLOW_TASK_BINDING_CUSTOM_ENTRY) continue;
			const binding = parseWorkflowTaskBinding(entry.data);
			if (binding !== undefined) {
				this._workflowTaskBinding = binding;
				return;
			}
		}
	}

	private _bindWorkflowTask(bindingData: WorkflowTaskBindingData, isActive: () => boolean): void {
		if (this._workflowTaskTerminal !== undefined) throw new Error("workflow_task_terminal");
		if (this._workflowTaskBinding !== undefined) {
			if (this._workflowTaskBinding.isActive === undefined) throw new Error("workflow_task_admission_required");
			const { isActive: _existingIsActive, ...existingBinding } = this._workflowTaskBinding;
			if (digestObject(existingBinding) !== digestObject(bindingData)) {
				throw new Error("workflow_task_binding_mismatch");
			}
		}
		this._workflowTaskBinding = { ...bindingData, isActive };
		const persisted = this.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom" || entry.customType !== WORKFLOW_TASK_BINDING_CUSTOM_ENTRY) return false;
			const parsed = parseWorkflowTaskBinding(entry.data);
			return parsed !== undefined && digestObject(parsed) === digestObject(bindingData);
		});
		if (!persisted) {
			this.sessionManager.appendCustomEntryWithRollback(WORKFLOW_TASK_BINDING_CUSTOM_ENTRY, bindingData);
			this.sessionManager.flushNow();
		}
		// A child may have built its provisioner before the scheduler issued the
		// task binding. Rebuild it now so isolation, host handlers, and the
		// read-only harness marker are captured before any deferred prewarm.
		this._buildRuntime({ activeToolNames: this.getActiveToolNames(), includeAllExtensionTools: true });
		this._releaseDeferredIpythonPrewarm();
	}

	private _workflowTaskAdmissionBlockReason(): string | undefined {
		if (this._workflowTaskTerminal !== undefined) {
			return this._workflowTaskTerminal.status === "deadline"
				? "workflow_task_deadline_expired"
				: "workflow_task_terminal";
		}
		if (
			this._workflowTaskDeadlineMonotonicAtMs !== undefined &&
			performance.now() >= this._workflowTaskDeadlineMonotonicAtMs
		) {
			return "workflow_task_deadline_expired";
		}
		const binding = this._workflowTaskBinding;
		if (binding === undefined) return undefined;
		if (Date.parse(binding.deadlineAt) <= Date.now()) return "workflow_task_deadline_expired";
		if (binding.isActive === undefined || !binding.isActive()) return "workflow_task_admission_required";
		return undefined;
	}

	private _recordWorkflowTaskTerminal(status: WorkflowTaskTerminalStatus, reason?: string): void {
		const binding = this._workflowTaskBinding;
		if (binding === undefined || this._workflowTaskTerminal !== undefined) return;
		const { isActive: _isActive, ...persistedBinding } = binding;
		const unsigned: Omit<WorkflowTaskTerminalRecord, "recordDigest"> = {
			schemaVersion: 1 as const,
			kind: WORKFLOW_TASK_TERMINAL_CUSTOM_ENTRY,
			binding: persistedBinding,
			status,
			...(reason === undefined ? {} : { reason }),
			terminalAt: new Date().toISOString(),
		};
		const record: WorkflowTaskTerminalRecord = {
			...unsigned,
			recordDigest: digestObject(unsigned),
		};
		this._workflowTaskTerminal = record;
		this.sessionManager.appendCustomEntryWithRollback(WORKFLOW_TASK_TERMINAL_CUSTOM_ENTRY, record);
		this.sessionManager.flushNow();
	}

	private _assertWorkflowTaskAdmissionAllowed(): void {
		const reason = this._workflowTaskAdmissionBlockReason();
		if (reason === undefined) return;
		if (reason === "workflow_task_deadline_expired") {
			this._recordWorkflowTaskTerminal("deadline", reason);
			this._workflowTaskDeadlineAbort?.();
		}
		throw new AgentSessionMessageBlockedError(reason);
	}

	private async _settleRejectedWorkflowAgentMessage(
		message: AgentSessionMessage | undefined,
		error: Error,
	): Promise<void> {
		if (message === undefined) return;
		this._rejectAgentMessage(message.details.id, error);
		const bridge = this._agentMessageObligationBridge;
		if (bridge !== undefined) {
			try {
				if (isAgentSessionMessageBlockedError(error)) {
					await bridge.beforeAgentMessageDispatch(message);
					await bridge.settleAgentMessage(message, "failed", `quarantine:${error.reason}`);
					error.obligationSettled = true;
				} else {
					await bridge.settleAgentMessage(message, "failed", error.message);
				}
			} catch {
				// Preserve the typed rejection so recovery can retry its durable settlement.
			}
		}
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
			this._assertWorkflowTaskAdmissionAllowed();
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			await this._agentEventQueue;
			this._assertWorkflowTaskAdmissionAllowed();

			try {
				const hookResult = await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
				this._assertWorkflowTaskAdmissionAllowed();
				return hookResult;
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

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
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
		return { maxDepth: 1, source: "default" };
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

	private _resolveWorkflowKernelOwnership(): WorkflowKernelOwnership {
		const binding = this._workflowTaskBinding;
		let workflowId = binding?.workflowId;
		let workflowBound = binding !== undefined;
		if (workflowId === undefined) {
			try {
				workflowId = this._workflowHost?.status().workflowId ?? undefined;
				workflowBound = workflowId !== undefined;
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes("durable acceptance projection") ||
						error.message.includes("Workflow start approval is incomplete"))
				) {
					workflowBound = true;
				} else {
					throw error;
				}
			}
		}
		workflowId ??= this._loadPersistedGoalState().workflowId;
		return { workflowId, workflowBound };
	}

	private _workflowOwnsGoalState(): boolean {
		const ownership = this._resolveWorkflowKernelOwnership();
		return ownership.workflowId !== undefined || ownership.workflowBound;
	}

	private _assertRefinementAuthority(): void {
		if (this._workflowOwnsGoalState()) throw new AgentSessionRefinementError();
	}

	private _setGoalState(
		next: GoalState,
		options: { persist?: boolean; rewriteUpdatedAt?: boolean; workflowProjection?: boolean } = {},
	): void {
		if (this._workflowOwnsGoalState() && options.workflowProjection !== true)
			throw new Error("Workflow-bound GoalState is owned by the durable workflow host.");
		const normalized = normalizeGoalState({
			...next,
			...(options.rewriteUpdatedAt === false ? {} : { updatedAt: Date.now() }),
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
			if (action.payload.kind === "turn" && this._agentMessageObligationBridge !== undefined) {
				const primary = primaryDeliveryRecord(action).message;
				if (isAgentSessionMessage(primary)) {
					void this._agentMessageObligationBridge
						.settleAgentMessage(primary, "cancelled", error.message)
						.catch(() => undefined);
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
		this._setGoalState(goal);
		return this._goalState;
	}

	private _clearGoal(): void {
		if (this._workflowOwnsGoalState())
			throw new Error("Workflow-bound GoalState must be cleared through the durable workflow host.");
		this._clearQueuedGoalContexts();
		this._setGoalState(emptyGoalState());
	}

	private _pauseGoal(reason = "Paused by user"): void {
		if (this._workflowOwnsGoalState())
			throw new Error("Workflow-bound GoalState must be paused through the durable workflow host.");
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
		if (this._workflowOwnsGoalState())
			throw new Error("Workflow-bound GoalState must be resumed through the durable workflow host.");
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
		if (this._workflowOwnsGoalState()) {
			this._queueWorkflowPauseAfterPlannerFailure(errorMessage);
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
		this._queueWorkflowPauseAfterPlannerFailure(errorMessage);
	}

	private _queueWorkflowPauseAfterPlannerFailure(errorMessage: string): void {
		const pause = () => this._pauseWorkflowAfterPlannerFailure(errorMessage);
		this._agentEventQueue = this._agentEventQueue.then(pause, pause).catch(() => undefined);
	}

	private async _pauseWorkflowAfterPlannerFailure(errorMessage: string): Promise<void> {
		const workflowHost = this._workflowHost;
		if (workflowHost === undefined || this._disposed || workflowHost.status().status !== "active") return;
		await workflowHost.execute({ kind: "pause", reason: `Planner failed: ${errorMessage}` });
		this._queuedWorkflowPlannerStateDigest = undefined;
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
		this.sessionManager.appendCustomMessageEntryWithRollback(
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

	/** Append custom messages returned by before_agent_start extension handlers. */
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
		if (this._workflowBrainstorm?.status === "draft" || this._workflowBrainstorm?.status === "proposed") return;
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

	private _runOrQueueGoalContext(
		kind: "continuation" | "objective_updated",
		images?: ImageContent[],
		wake = false,
	): void {
		if (!this._goalState.objective) return;
		this._ensureGoalRuntimeActive();
		const message = this._createGoalContextMessage(kind, images);
		const normalized = normalizeMessageContent(message.content);
		const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
		});
		this._admitSessionInput(action, { front: true, wake });
	}

	private _createGoalContextMessage(kind: GoalContextKind, images?: ImageContent[]) {
		const plannerDirective = (this._workflowHost as WorkflowKernelHostBindings | undefined)?.primeWorkflow
			?.plannerDirective;
		return createGoalContextMessage(this._goalState, kind, images, plannerDirective);
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

	private async _accountGoalUsageForAssistantMessage(message: AssistantMessage): Promise<boolean> {
		const inFlight = this._goalAccountingInFlight.get(message);
		if (inFlight !== undefined) return inFlight;
		const pending = this._accountGoalUsageForAssistantMessageUnserialized(message);
		this._goalAccountingInFlight.set(message, pending);
		try {
			return await pending;
		} finally {
			if (this._goalAccountingInFlight.get(message) === pending) this._goalAccountingInFlight.delete(message);
		}
	}

	private async _accountGoalUsageForAssistantMessageUnserialized(message: AssistantMessage): Promise<boolean> {
		const workflowOwned = this._workflowOwnsGoalState();
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
		const tokenDelta = goalTokenDeltaForUsage(message.usage);
		const goal = this._goalWithAccountedWallClock();
		if (workflowOwned) {
			const accountAssistantUsage = this._workflowHost?.accountAssistantUsage;
			if (accountAssistantUsage === undefined)
				throw new Error("Workflow-bound goal usage coordinator is unavailable.");
			await accountAssistantUsage({
				tokenDelta,
				wallTimeDeltaSeconds: Math.max(0, goal.timeUsedSeconds - this._goalState.timeUsedSeconds),
				continuationDelta: 0,
			});
			this._goalAccountedAssistantMessages.add(message);
			this._reloadGoalStateFromBranch();
			return this._loadPersistedGoalState().status === "budget_limited";
		}
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

	private _handleGoalAccountingFailure(error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		if (this._workflowOwnsGoalState()) {
			if (isWorkflowGoalAccountingContention(error)) return;
			this._queueWorkflowPauseAfterPlannerFailure(`Workflow goal accounting failed: ${message}`);
			return;
		}
		this._finishGoalWithError(message);
	}

	private async _accountGoalUsageAtMessageEnd(message: AssistantMessage): Promise<void> {
		try {
			if (!(await this._accountGoalUsageForAssistantMessage(message))) return;
			const goalContext = this._createGoalContextMessage("budget_limit");
			const normalized = normalizeMessageContent(goalContext.content);
			await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
				message: goalContext,
				resumeIfIdle: true,
			});
		} catch (error) {
			this._handleGoalAccountingFailure(error);
		}
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

	private _shouldStopBeforeTurn(): boolean {
		const reason = this._workflowTaskAdmissionBlockReason();
		if (reason !== undefined) {
			if (reason === "workflow_task_deadline_expired") {
				this._recordWorkflowTaskTerminal("deadline", reason);
				this._workflowTaskDeadlineAbort?.();
			}
			return true;
		}
		return this._steeringStopPending;
	}

	private async _shouldStopAfterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return true;
		}
		try {
			if (await this._accountGoalUsageForAssistantMessage(context.message)) {
				const message = this._createGoalContextMessage("budget_limit");
				const normalized = normalizeMessageContent(message.content);
				await this._queuePreparedPrompt("steer", normalized.text, normalized.images, {
					message,
					resumeIfIdle: true,
				});
			}
		} catch (error) {
			this._handleGoalAccountingFailure(error);
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
		if (await this._shouldStopForThresholdCompaction(context)) {
			return true;
		}
		// Steering stops continuation only after mandatory serialized checkpoints.
		// Returning true here still prevents the agent loop from starting another turn.
		return this._steeringStopPending;
	}

	private async _shouldStopForThresholdCompaction(context: ShouldStopAfterTurnContext): Promise<boolean> {
		this._continueAfterThresholdCompaction = false;
		if (this._pendingRequestedCompaction === undefined && !(await this._thresholdCompactionNeeded(context))) {
			return false;
		}

		const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
		this._continueAfterThresholdCompaction = lastMessage !== undefined && lastMessage.role !== "assistant";
		return true;
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
		// Automatic refinement is a background courtesy. When a workflow owns the goal the
		// refinement must go through its learning path instead, so skip quietly rather than
		// failing the turn — throwing here replaced the assistant's actual response.
		if (this._workflowOwnsGoalState()) return;
		if (this._disposed || this._disposing) {
			return;
		}

		// 1. Await any background plan that was started at message_end
		//    (either for a pending refine.run or for interval-triggered
		//    auto-refine). This must be checked BEFORE the pending and
		//    interval checks because background planning may have consumed
		//    the pending request at message_end.
		const branchVersion = this._autoRefineBranchVersion;
		const bgConsumption = await this._consumeSerializedBackgroundPlan(async (bgResult) => {
			if (this._disposed || this._disposing) {
				return true;
			}

			if (bgResult?.status === "plan") {
				// Fix 4: Validate branchVersion before applying the plan.
				if (bgResult.branchVersion !== this._autoRefineBranchVersion) {
					if (!this._pendingRequestedRefine) {
						this._lastAutoRefineReviewAt = Date.now();
						this._assistantTurnsSinceAutoRefine = 0;
						return true;
					}
				} else {
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
				// Reviewer declined during background planning.
				// Reset exactly once. Never retry the interval review; only fall through for a separate pending refine.run.
				this._lastAutoRefineReviewAt = Date.now();
				this._assistantTurnsSinceAutoRefine = 0;
				if (!this._pendingRequestedRefine) {
					return true;
				}
			}

			if (bgResult?.status === "failure") {
				// Fix 3: Background review or planning failed. Stamp cooldown
				// without a synchronous retry (the discriminated contract says no duplicate boundary
				// model call). A separately queued refine.run may still be serviced below.
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
		if (this._disposed || this._disposing || bgConsumption !== "none") {
			return;
		}
		await this._runSerializedRefineCheckpointAfterBackground(branchVersion);
	}

	private async _runSerializedRefineCheckpointAfterBackground(branchVersion: number): Promise<void> {
		this._assertRefinementAuthority();
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

	/** Run automatic review and, when approved, refinement at a serialized turn boundary. */
	private async _runSerializedAutoRefineReview(
		reason: "compact" | "turn_interval",
		branchVersion: number,
	): Promise<void> {
		this._assertRefinementAuthority();
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
			await this._runSerializedRefine({
				instructions: autoRefineInstructions(reason, review),
			});
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return;
			}
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
		} catch (error) {
			if (branchVersion === this._autoRefineBranchVersion) {
				this._lastAutoRefineReviewAt = Date.now();
				this._emitRefineFailed(error);
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
		this._assertRefinementAuthority();
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
		if (!this._serializedRefine || this._disposed || this._disposing) {
			return;
		}
		if (this._workflowOwnsGoalState()) return;
		// Don't start if a plan is already in flight.
		if (this._serializedPlanInFlight || this._refineInFlight || this._refinePlanInFlight) {
			return;
		}

		// Bug 4 fix: Also start background planning for a pending agent-callable
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
			this._assertRefinementAuthority();
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
			const plan = await this._planRefine(planOptions, refineAbort.signal);
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
		} catch {
			if (this._disposed || this._disposing || branchVersion !== this._autoRefineBranchVersion) {
				return { status: "invalidated", branchVersion };
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
	private async _runSerializedRefine(options: {
		instructions?: string;
		rollbackId?: string;
		global?: boolean;
	}): Promise<void> {
		this._assertRefinementAuthority();
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

		const planRun = this._planRefine(options, refineAbort.signal);
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

		if (await this._queueAutonomousContinuationForThresholdCompaction(context.message)) {
			this._continueAfterThresholdCompaction = true;
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
				if (this._workflowOwnsGoalState()) {
					const rejection = new AgentSessionRefinementError();
					return {
						scheduled: false,
						status: "rejected",
						code: rejection.code,
						reason: rejection.message,
					};
				}
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
		if (this._workflowHost !== undefined || this._workflowOwnsGoalState()) {
			throw new Error("cannot complete goal directly while the durable workflow completion gate owns completion");
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
		const workflowOwned = this._workflowOwnsGoalState();
		try {
			this._ensureGoalRuntimeActive(context.context);
			if (workflowOwned) {
				const accountContinuation = this._workflowHost?.accountContinuation;
				if (accountContinuation === undefined)
					throw new Error("Workflow-bound goal continuation coordinator is unavailable.");
				const goal = this._goalWithAccountedWallClock();
				await accountContinuation({
					tokenDelta: 0,
					wallTimeDeltaSeconds: Math.max(0, goal.timeUsedSeconds - this._goalState.timeUsedSeconds),
					continuationDelta: 1,
				});
				this._reloadGoalStateFromBranch();
				return [];
			}
			const nextGoal = {
				...this._goalState,
				continuationsUsed: this._goalState.continuationsUsed + 1,
				lastReason: undefined,
				lastError: undefined,
			};
			this._setGoalState(nextGoal);
			return [this._createGoalContextMessage("continuation")];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (workflowOwned) {
				if (!isWorkflowGoalAccountingContention(error)) this._queueWorkflowPauseAfterPlannerFailure(message);
			} else this._finishGoalWithError(message);
			return [];
		}
	}

	private async _getContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this.queuedActionCount > 0) {
			return [];
		}
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

	// Track last assistant message for auto-compaction check
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

	private waitForAgentMessagePromptContext(agentMessageId: string): Promise<void> {
		const outcome = this._agentMessageOutcome(agentMessageId);
		outcome.context ??= createAgentMessageDeferred();
		return outcome.context.promise;
	}

	/** Resolve (no error) or reject an existing leg of an agent message outcome. */
	private _settleAgentMessage(
		agentMessageId: string | undefined,
		leg: "delivery" | "context" | "completion",
		error?: Error,
	): void {
		if (agentMessageId === undefined) return;
		if (leg === "context") {
			this._pendingAgentMessageContextDeliveries.delete(agentMessageId);
			this._clearAgentMessageDeliveryDeadline(agentMessageId);
		}
		const outcome = this._agentMessageOutcomes.get(agentMessageId);
		if (!outcome) return;
		const deferred = outcome[leg];
		if (!deferred) return;
		outcome[leg] = undefined;
		if (!outcome.delivery && !outcome.context && !outcome.completion) {
			this._agentMessageOutcomes.delete(agentMessageId);
		}
		if (error) deferred.reject(error);
		else deferred.resolve();
	}

	private _clearAgentMessageDeliveryDeadline(agentMessageId: string): void {
		const timer = this._agentMessageDeliveryDeadlineTimers.get(agentMessageId);
		if (timer === undefined) return;
		clearTimeout(timer);
		this._agentMessageDeliveryDeadlineTimers.delete(agentMessageId);
	}

	private async _persistPendingAgentMessageContextBatch(): Promise<void> {
		const pendingIds = [...this._pendingAgentMessageContextDeliveries];
		const pending = pendingIds.flatMap((agentMessageId) => {
			const action = this._actionStore
				.ownedActions()
				.find((candidate) => candidate.agentMessageId === agentMessageId && candidate.payload.kind === "turn");
			if (action?.payload.kind !== "turn") return [];
			const record = primaryDeliveryRecord(action);
			if (!isAgentSessionMessage(record.message)) return [];
			return [{ agentMessageId, message: record.message, record }];
		});
		const claimed: typeof pending = [];
		for (const item of pending) {
			if (!this._pendingAgentMessageContextDeliveries.has(item.agentMessageId)) continue;
			const dispatch = await this._agentMessageObligationBridge?.beforeAgentMessageDispatch(item.message);
			if (dispatch === "quarantine") {
				if (this.hasPersistedAgentMessage(item.agentMessageId)) {
					item.record.durable = true;
					this._settleAgentMessage(item.agentMessageId, "context");
				}
				continue;
			}
			claimed.push(item);
		}
		let appended = false;
		for (const item of claimed) {
			if (!this.hasPersistedAgentMessage(item.agentMessageId)) {
				this.sessionManager.appendCustomMessageEntry(
					item.message.customType,
					item.message.content,
					item.message.display,
					item.message.details,
				);
				appended = true;
			}
			item.record.durable = true;
		}
		if (appended) this.sessionManager.flushNow();
		for (const item of claimed) {
			if (!this._pendingAgentMessageContextDeliveries.has(item.agentMessageId)) continue;
			try {
				await this._agentMessageObligationBridge?.afterAgentMessageTranscriptAppend(item.message);
				this._settleAgentMessage(item.agentMessageId, "context");
			} catch (error) {
				this._settleAgentMessage(item.agentMessageId, "context", this._asError(error));
				throw error;
			}
		}
	}

	private _scheduleAgentMessageDeliveryDeadline(agentMessageId: string): void {
		this._clearAgentMessageDeliveryDeadline(agentMessageId);
		this._pendingAgentMessageContextDeliveries.add(agentMessageId);
		const timer = setTimeout(
			() => {
				this._agentMessageDeliveryDeadlineTimers.delete(agentMessageId);
				const pending = this._pendingAgentMessageContextDeliveries.has(agentMessageId);
				if (!pending || this._disposed || this._disposing) return;
				this._agentMessageDeadlineContextCommit = this._agentMessageDeadlineContextCommit
					.catch(() => undefined)
					.then(() => this._persistPendingAgentMessageContextBatch());
				void this._agentMessageDeadlineContextCommit.then(
					() => {
						if (this._disposed || this._disposing) return;
						this._sessionInputPumpSuspended = false;
						this._scheduleSessionInputPump();
						if (this.isStreaming) this.agent.abort();
					},
					() => undefined,
				);
			},
			Math.max(
				1,
				this._agentMessageDeliveryDeadlineMs -
					Math.min(AGENT_MESSAGE_DELIVERY_COMMIT_GRACE_MS, Math.floor(this._agentMessageDeliveryDeadlineMs / 2)),
			),
		);
		timer.unref();
		this._agentMessageDeliveryDeadlineTimers.set(agentMessageId, timer);
	}

	/** Reject both currently registered legs of an agent message outcome. */
	private _rejectAgentMessage(agentMessageId: string | undefined, error: Error): void {
		if (agentMessageId === undefined) return;
		this._settleAgentMessage(agentMessageId, "delivery", error);
		this._settleAgentMessage(agentMessageId, "context", error);
		this._settleAgentMessage(agentMessageId, "completion", error);
	}

	private _rejectQueuedAgentMessageDeliveries(deliveryError: Error, completionError = deliveryError): void {
		for (const action of this._actionStore.unfinishedActions()) {
			this._settleAgentMessage(action.agentMessageId, "delivery", deliveryError);
			this._settleAgentMessage(action.agentMessageId, "context", deliveryError);
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

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = (event: AgentEvent): void => {
		this._createRetryPromiseForAgentEnd(event);
		this._observeToolExecutionLiveness(event);
		if (event.type === "message_end" && event.message.role === "assistant") {
			void this._accountGoalUsageAtMessageEnd(event.message as AssistantMessage);
		}
		let workflowTurnIndex: number | undefined;
		if (event.type === "agent_start") {
			this._workflowExecutionNextTurnIndex = 0;
		} else if (event.type === "turn_start") {
			workflowTurnIndex = this._workflowExecutionNextTurnIndex;
			this._workflowExecutionNextTurnIndex++;
		}
		const recordWorkflowEvent = async (): Promise<void> => {
			try {
				await this._recordWorkflowExecutionEvent(event, workflowTurnIndex);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await this._pauseWorkflowAfterPlannerFailure(`Execution evidence failed: ${message}`).catch(
					() => undefined,
				);
			}
		};
		this._workflowExecutionEventQueue = this._workflowExecutionEventQueue.then(
			recordWorkflowEvent,
			recordWorkflowEvent,
		);
		this._workflowExecutionEventQueue.catch(() => {});
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

	/**
	 * Project exact lifecycle events into the opaque persisted-host evidence source.
	 * Calling this out of event order would corrupt turn causality, so it remains private.
	 */
	private async _recordWorkflowExecutionEvent(event: AgentEvent, turnIndex: number | undefined): Promise<void> {
		const source = this._workflowExecutionEvidenceSource;
		if (source === undefined) return;
		if (event.type === "turn_start") {
			if (turnIndex === undefined) throw new Error("Workflow execution turn index was not captured.");
			if (this._workflowExecutionTurnHandle !== undefined)
				throw new Error("Workflow execution turn started before the prior turn completed.");
			this._workflowExecutionToolStarts = [];
			this._workflowExecutionToolEnds = [];
			this._workflowExecutionTurnHandle = (await source.beginTurn(turnIndex)) ?? undefined;
			return;
		}
		if (this._workflowExecutionTurnHandle === undefined) return;
		if (event.type === "tool_execution_start") {
			this._workflowExecutionToolStarts.push({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				argumentsDigest: digestObject(event.args),
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			this._workflowExecutionToolEnds.push({
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				isError: event.isError,
				resultDigest: workflowExecutionToolResultDigest(event.result, event.isError),
			});
			// A successful mutation is the trigger for sharing work in progress. The host computes
			// and delivers the diff, so neither the author nor the reviewer spends a model turn.
			if (!event.isError && this._collaborationPeers !== undefined) void this._pushChangedDiffs();
			return;
		}
		if (event.type !== "turn_end" || event.message.role !== "assistant") return;
		const handle = this._workflowExecutionTurnHandle;
		const message = event.message as AssistantMessage;
		try {
			await source.completeTurn(handle, {
				assistantMessageDigest: workflowExecutionAssistantDigest(message),
				assistantStopReason: message.stopReason,
				modelProvider: message.provider,
				modelId: message.model,
				usage: {
					inputTokens: message.usage.input,
					outputTokens: message.usage.output,
					cacheReadTokens: message.usage.cacheRead,
					cacheWriteTokens: message.usage.cacheWrite,
					totalTokens: message.usage.totalTokens,
					costMicrounits: Math.round(message.usage.cost.total * 1_000_000),
				},
				toolCalls: message.content
					.filter((block) => block.type === "toolCall")
					.map((block) => ({
						toolCallId: block.id,
						toolName: block.name,
						argumentsDigest: digestObject(block.arguments),
					})),
				toolStarts: this._workflowExecutionToolStarts,
				toolResults: event.toolResults.map(workflowExecutionToolResultFact),
				toolEnds: this._workflowExecutionToolEnds,
			});
		} finally {
			if (this._workflowExecutionTurnHandle === handle) this._workflowExecutionTurnHandle = undefined;
		}
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
			// A completed run ends the steer budget: the next task starts with a fresh allowance
			// and previously-seen content may legitimately be sent again.
			this._resetAgentMessageSteerBudget();
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

		if (event.type === "message_start" && this._isPromptTurnStartMessage(event.message)) {
			this._overflowRecovery = "idle";
		}

		// Emit to extensions first
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

		// Notify all listeners
		this._emit(event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				if (!isAgentSessionMessage(event.message) || !this.hasPersistedAgentMessage(event.message.details.id)) {
					this.sessionManager.appendCustomMessageEntry(
						event.message.customType,
						event.message.content,
						event.message.display,
						event.message.details,
					);
				}
				if (isAgentSessionMessage(event.message)) {
					try {
						await this._agentMessageObligationBridge?.afterAgentMessageTranscriptAppend(event.message);
						this._settleAgentMessage(event.message.details.id, "context");
					} catch (error) {
						this._settleAgentMessage(event.message.details.id, "context", this._asError(error));
						throw error;
					}
				}
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted")
					this._toolExecutionStallDiagnostic = undefined;
				if (this._isResourceExhaustedFailure(assistantMsg)) {
					this._recordResourceExhaustedBlocker(assistantMsg);
				} else {
					this._clearResourceExhaustedBlockerAfterProbe(assistantMsg);
				}
				if (assistantMsg.stopReason !== "error") {
					addAutonomousUsage(this._autonomousState, assistantMsg.usage);
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
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
			}
		}

		if (clearedDispatchEnded) {
			return;
		}

		// Check auto-retry and auto-compaction after agent completes
		if (event.type === "agent_end") {
			const msg =
				this._lastAssistantMessage ??
				(this._retryPromise ? this._findLastAssistantInMessages(event.messages) : undefined);
			this._lastAssistantMessage = undefined;
			if (!msg) {
				this._resolveRetry();
				return;
			}

			// Check for retryable errors first (overloaded, rate limit, server errors)
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

			const resourceExhausted = this._isResourceExhaustedFailure(msg);
			const compactionWillRetry = resourceExhausted ? false : await this._checkCompaction(msg);
			if (compactionWillRetry && this._retryAttempt > 0) {
				return;
			}
			this._finishActiveRetryWithFailure(msg);
			this._resolveRetry();
			if (!compactionWillRetry) {
				this._finishGoalForTerminalAssistantMessage(msg);
				// In serialized mode, agent-callable refine.run is serviced
				// at the shouldStopAfterTurn boundary, not here at agent_end.
				if (!resourceExhausted && !this._serializedRefine) {
					const consumedRequestedRefine = this._consumePendingRequestedRefine();
					if (!consumedRequestedRefine) {
						this._scheduleAutoRefineAfterAgentEnd();
					}
				}
			}
		}
	}

	private _isPromptTurnStartMessage(message: AgentMessage): boolean {
		return (
			message.role === "user" ||
			isAgentSessionMessage(message) ||
			(message.role === "custom" && message.customType === HEARTBEAT_PROMPT_CUSTOM_TYPE)
		);
	}

	/** Resolve the pending retry promise */
	private _resolveRetry(): void {
		if (this._retryResolve) {
			this._retryResolve();
			this._retryResolve = undefined;
			this._retryPromise = undefined;
			this._scheduleSessionInputPump();
		}
	}

	/** Find the last assistant message in agent state (including aborted ones) */
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

	/** Emit extension events based on agent events */
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

		// Return unsubscribe function for this specific listener
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
		if (this._disposed) {
			return this._disposeCallbacksPromise;
		}
		// Concurrent callers await the same in-flight teardown so none resolves before
		// the kernel snapshot flush finishes.
		if (this._disposeAsyncPromise) {
			return this._disposeAsyncPromise;
		}
		this._disposeAsyncPromise = (async () => {
			// Drain before marking _disposing so a refine triggered at the final
			// agent_end completes instead of being aborted by dispose().
			await this._drainPendingRefinementForDisposal();
			await this._agentEventQueue;
			if (this._disposed) {
				return this._disposeCallbacksPromise;
			}
			this._disposing = true;
			this._sessionActionCommitDisposeAbortController.abort();
			if (this._workflowExecutionEvidenceSource !== undefined)
				revokeWorkflowExecutionEvidenceSource(this._workflowExecutionEvidenceSource);
			await this._disposeAsyncOnce();
		})();
		return this._disposeAsyncPromise;
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
		if (this._workflowOwnsGoalState()) {
			this._autoRefineReviewAbort?.abort();
			this._refineAbortController?.abort();
			this._pendingRequestedRefine = undefined;
			this._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
			while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
				if (this._refineInFlight) {
					await this._refineInFlight;
				} else if (this._refinePlanInFlight) {
					await this._refinePlanInFlight;
				} else {
					await this._consumeSerializedBackgroundPlan(async () => true);
				}
			}
			return;
		}
		// Wait for in-flight refinement (including serialized background plan) to settle.
		while (this._refineInFlight || this._refinePlanInFlight || this._serializedPlanInFlight) {
			if (this._refineInFlight) {
				await this._refineInFlight;
			} else if (this._refinePlanInFlight) {
				await this._refinePlanInFlight;
			} else if (this._serializedPlanInFlight) {
				// Fix 5: Await the background plan and apply a ready "plan"
				// result before teardown so the refinement is persisted.
				// Do NOT discard a ready plan.
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
		let cleanupError: Error | undefined;
		const rememberCleanupError = (error: unknown): void => {
			if (cleanupError !== undefined) return;
			cleanupError = error instanceof Error ? error : new Error(String(error));
		};
		for (const run of this._activeRlmChildRuns.values()) {
			if (run.session) {
				try {
					await run.session.disposeAsync();
				} catch (error) {
					rememberCleanupError(error);
				}
			}
		}
		for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
			unsubscribe();
		}
		this._rlmChildUnsubscribes.clear();
		for (const session of this._rlmChildSessions.values()) {
			try {
				await session.disposeAsync();
			} catch (error) {
				rememberCleanupError(error);
			}
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
		try {
			await this._ipythonKernelProvisioner?.dispose();
		} catch (error) {
			rememberCleanupError(error);
		}
		this.dispose();
		await this._disposeCallbacksPromise;
		if (cleanupError !== undefined) throw cleanupError;
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
		if (this._resourceProbeWakeTimer !== undefined) {
			clearTimeout(this._resourceProbeWakeTimer);
			this._resourceProbeWakeTimer = undefined;
		}
		for (const timer of this._agentMessageDeliveryDeadlineTimers.values()) clearTimeout(timer);
		this._agentMessageDeliveryDeadlineTimers.clear();
		this._pendingAgentMessageContextDeliveries.clear();
		this._sessionActionCommitDisposeAbortController.abort();
		try {
			for (const toolCallId of [...this._toolExecutionLiveness.keys()]) this._clearToolExecutionLiveness(toolCallId);
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
			this._rlmChildCompletionPromises.clear();
			this._rlmChildCleanupFailures.clear();
			this._deletedRlmChildIds.clear();
			this._pendingNextTurnMessages = [];
			const deliveryError = new Error("Session disposed before prompt delivery.");
			const completionError = new Error("Session disposed before prompt completion.");
			this._rejectQueuedAgentMessageDeliveries(deliveryError, completionError);
			for (const [agentMessageId, outcome] of this._agentMessageOutcomes) {
				if (outcome.delivery) this._settleAgentMessage(agentMessageId, "delivery", deliveryError);
				if (outcome.context) this._settleAgentMessage(agentMessageId, "context", deliveryError);
				if (outcome.completion) this._settleAgentMessage(agentMessageId, "completion", completionError);
			}
			this._cancelSessionActions(() => true, deliveryError);
			this.agent.clearAllQueues();
			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			);
			this._disconnectFromAgent();
			this._eventListeners = [];
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

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get serviceTier(): ServiceTier {
		return this.agent.state.serviceTier;
	}

	/** Whether agent is currently streaming a response */
	get isStreaming(): boolean {
		return this.agent.state.isStreaming;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/** Current durable provider resource blocker, if the session is blocked. */
	getResourceExhaustedBlocker(): ResourceExhaustedBlocker | undefined {
		const blocker = this.sessionManager.getLatestResourceExhaustedBlocker();
		return blocker ? projectResourceExhaustedBlocker(blocker) : undefined;
	}

	/** Current durable worker-model capability blocker, if the workflow is queued. */
	getWorkerModelCapabilityBlocker(): WorkerModelCapabilityBlocker | undefined {
		return this.sessionManager.getLatestWorkerModelCapabilityBlocker();
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, and source metadata.
	 */
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

	/**
	 * Set active tools by name.
	 * Only tools in the registry can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next agent turn.
	 */
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

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** Host-observed phase and deadline for the active compaction attempt. */
	getCompactionLiveness(): AgentSessionCompactionLiveness | undefined {
		const liveness = this._compactionLiveness;
		if (!liveness) return undefined;
		return {
			...liveness,
			elapsedMs: Math.max(0, Date.now() - liveness.startedAt),
		};
	}

	private _observeProviderStreamLiveness(state: StreamLivenessState, host: StreamLivenessHost): void {
		const monotonicNow = host.clock?.now() ?? globalThis.performance.now();
		const wallNow = Date.now();
		if (this._providerStreamIdentity !== state.startedAt || this._providerStreamStartedAt === undefined) {
			this._providerStreamIdentity = state.startedAt;
			this._providerStreamStartedAt = wallNow - Math.max(0, monotonicNow - state.startedAt);
			this._providerStreamStallDiagnostic = undefined;
		}
		if (state.terminal && this._providerStreamStallDiagnostic === undefined) {
			this._providerStreamLiveness = undefined;
			return;
		}
		const startedAt = this._providerStreamStartedAt;
		const toWallTime = (timestamp: number | undefined): number | undefined =>
			timestamp === undefined ? undefined : startedAt + (timestamp - state.startedAt);
		this._providerStreamLiveness = {
			phase: state.phase,
			startedAt,
			deadlineAt: startedAt + (state.deadlineAt - state.startedAt),
			elapsedMs: Math.max(0, wallNow - startedAt),
			lastProviderEventAt: toWallTime(state.lastProviderEventAt),
			lastMeaningfulContentDeltaAt: toWallTime(state.lastMeaningfulContentDeltaAt),
			receivedBytes: state.receivedBytes,
			blocks: state.blocks,
			abortability: state.abortability,
		};
	}

	private _observeProviderStreamTerminal(outcome: StreamLivenessTerminalOutcome): void {
		if (outcome.type === "provider_stream_stalled") {
			this._providerStreamStallDiagnostic = outcome.diagnostic;
			return;
		}
		this._providerStreamLiveness = undefined;
	}

	private _loadPersistedProviderStreamStallDiagnostic(): StreamLivenessDiagnostic | undefined {
		const latestAssistant = [...this.sessionManager.getBranch()]
			.reverse()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (latestAssistant?.type !== "message" || latestAssistant.message.role !== "assistant") return undefined;
		const diagnostic = latestAssistant.message.diagnostics?.find(
			(candidate) => candidate.type === "provider_stream_stalled",
		);
		return parseProviderStreamStallDiagnostic(diagnostic?.details);
	}

	/** Host-observed liveness for the active or most recently stalled provider stream. */
	getProviderStreamLiveness(): AgentSessionProviderStreamLiveness | undefined {
		const liveness = this._providerStreamLiveness;
		if (!liveness) return undefined;
		return { ...liveness, elapsedMs: Math.max(liveness.elapsedMs, Date.now() - liveness.startedAt) };
	}

	/** Structured provider-stall diagnostic retained until the next provider attempt. */
	getProviderStreamStallDiagnostic(): StreamLivenessDiagnostic | undefined {
		return this._providerStreamStallDiagnostic;
	}

	private _loadPersistedToolExecutionStallDiagnostic(): ToolExecutionStallDiagnostic | undefined {
		for (const entry of [...this.sessionManager.getBranch()].reverse()) {
			if (entry.type === "message" && entry.message.role === "assistant") return undefined;
			if (entry.type === "custom_message" && entry.customType === TOOL_EXECUTION_STALL_CUSTOM_TYPE)
				return parseToolExecutionStallDiagnostic(entry.details);
		}
		return undefined;
	}

	private _persistToolExecutionLease(status: "active" | "released", liveness: ToolExecutionLiveness): void {
		const unsigned = {
			type: "tool_execution_lease" as const,
			schemaVersion: 1 as const,
			status,
			liveness,
			recordedAt: new Date().toISOString(),
		};
		const record: ToolExecutionLeaseRecord = { ...unsigned, recordDigest: digestObject(unsigned) };
		this.sessionManager.appendCustomEntryWithRollback(TOOL_EXECUTION_LEASE_CUSTOM_TYPE, record);
	}

	private _scheduleToolExecutionDeadline(toolCallId: string, deadlineAt: string): void {
		const existing = this._toolExecutionDeadlineTimers.get(toolCallId);
		if (existing !== undefined) clearTimeout(existing);
		const timer = setTimeout(
			() => this._expireToolExecution(toolCallId),
			Math.max(0, Date.parse(deadlineAt) - Date.now()),
		);
		timer.unref();
		this._toolExecutionDeadlineTimers.set(toolCallId, timer);
	}

	private _restorePersistedToolExecutionLeases(): void {
		const active = new Map<string, ToolExecutionLiveness>();
		for (const entry of this.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === TOOL_EXECUTION_LEASE_CUSTOM_TYPE) {
				const record = parseToolExecutionLeaseRecord(entry.data);
				if (record === undefined) continue;
				const { recordDigest, ...unsigned } = record;
				if (digestObject(unsigned) !== recordDigest) continue;
				if (record.status === "active") active.set(record.liveness.toolCallId, record.liveness);
				else active.delete(record.liveness.toolCallId);
				continue;
			}
			if (entry.type === "custom_message" && entry.customType === TOOL_EXECUTION_STALL_CUSTOM_TYPE) {
				const diagnostic = parseToolExecutionStallDiagnostic(entry.details);
				if (diagnostic !== undefined) active.delete(diagnostic.toolCallId);
			}
		}
		for (const liveness of active.values()) {
			this._toolExecutionLiveness.set(liveness.toolCallId, liveness);
			if (Date.parse(liveness.deadlineAt) <= Date.now()) this._expireToolExecution(liveness.toolCallId, false);
			else this._scheduleToolExecutionDeadline(liveness.toolCallId, liveness.deadlineAt);
		}
	}

	private _observeToolExecutionLiveness(event: AgentEvent): void {
		if (event.type === "tool_execution_start") {
			const startedAt = Date.now();
			const deadlineAt = startedAt + this._toolExecutionDeadlineMs;
			const hardDeadlineAt = startedAt + this._toolExecutionDeadlineMs * TOOL_EXECUTION_HARD_DEADLINE_MULTIPLIER;
			const liveness: ToolExecutionLiveness = {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				startedAt: new Date(startedAt).toISOString(),
				lastProgressAt: new Date(startedAt).toISOString(),
				deadlineAt: new Date(deadlineAt).toISOString(),
				hardDeadlineAt: new Date(hardDeadlineAt).toISOString(),
				leaseDurationMs: this._toolExecutionDeadlineMs,
				progressEventCount: 0,
				phase: "running",
			};
			this._toolExecutionStallDiagnostic = undefined;
			this._toolExecutionLiveness.set(event.toolCallId, liveness);
			this._persistToolExecutionLease("active", liveness);
			this._scheduleToolExecutionDeadline(event.toolCallId, liveness.deadlineAt);
			return;
		}
		if (event.type === "tool_execution_update") {
			const current = this._toolExecutionLiveness.get(event.toolCallId);
			if (current === undefined || current.phase !== "running") return;
			const progressDigest = digestObject({
				toolCallId: event.toolCallId,
				partialResult: event.partialResult,
			});
			if (this._toolExecutionProgressDigests.get(event.toolCallId) === progressDigest) return;
			this._toolExecutionProgressDigests.set(event.toolCallId, progressDigest);
			const progressedAt = Date.now();
			const progressed: ToolExecutionLiveness = {
				...current,
				lastProgressAt: new Date(progressedAt).toISOString(),
				deadlineAt: new Date(
					Math.min(Date.parse(current.hardDeadlineAt), progressedAt + current.leaseDurationMs),
				).toISOString(),
				progressEventCount: current.progressEventCount + 1,
			};
			this._toolExecutionLiveness.set(event.toolCallId, progressed);
			this._persistToolExecutionLease("active", progressed);
			this._scheduleToolExecutionDeadline(event.toolCallId, progressed.deadlineAt);
			return;
		}
		if (event.type === "tool_execution_end") {
			const current = this._toolExecutionLiveness.get(event.toolCallId);
			if (current !== undefined) this._persistToolExecutionLease("released", current);
			this._clearToolExecutionLiveness(event.toolCallId);
		}
	}

	private _clearToolExecutionLiveness(toolCallId: string): void {
		const timer = this._toolExecutionDeadlineTimers.get(toolCallId);
		if (timer !== undefined) clearTimeout(timer);
		this._toolExecutionDeadlineTimers.delete(toolCallId);
		this._toolExecutionProgressDigests.delete(toolCallId);
		this._toolExecutionLiveness.delete(toolCallId);
	}

	private _expireToolExecution(toolCallId: string, abortActive = true): void {
		const current = this._toolExecutionLiveness.get(toolCallId);
		if (current === undefined || current.phase !== "running") return;
		const detectedAt = new Date().toISOString();
		const diagnostic: ToolExecutionStallDiagnostic = {
			...current,
			type: "tool_execution_stalled",
			phase: "stalled",
			detectedAt,
			reason: "deadline_exceeded",
		};
		this._toolExecutionStallDiagnostic = diagnostic;
		this.sessionManager.appendCustomMessageEntry(
			TOOL_EXECUTION_STALL_CUSTOM_TYPE,
			`Tool ${current.toolName} exceeded its host deadline.`,
			false,
			diagnostic,
		);
		for (const activeToolCallId of [...this._toolExecutionLiveness.keys()])
			this._clearToolExecutionLiveness(activeToolCallId);
		if (current.toolName === "ipython" && this._ipythonKernelProvisioner !== undefined) {
			void this._fenceExpiredIpythonExecution(abortActive);
			return;
		}
		if (abortActive && this.isStreaming) void this.abort().catch(() => undefined);
		else this._scheduleSessionInputPump();
	}

	private async _fenceExpiredIpythonExecution(abortActive: boolean): Promise<void> {
		await this._ipythonKernelProvisioner?.kill();
		if (abortActive && this.isStreaming) await this.abort().catch(() => undefined);
		this._scheduleSessionInputPump();
	}

	private async _fenceTerminalTaskKernel(): Promise<void> {
		await this._ipythonKernelProvisioner?.kill();
	}

	/** Host-observed bounded invocation leases for tools that are currently executing. */
	getToolExecutionLiveness(): readonly ToolExecutionLiveness[] {
		return [...this._toolExecutionLiveness.values()]
			.map((value) => ({ ...value }))
			.sort((left, right) => left.toolCallId.localeCompare(right.toolCallId));
	}

	/** Latest durable tool-stall blocker, cleared by a subsequent tool attempt or assistant turn. */
	getToolExecutionStallDiagnostic(): ToolExecutionStallDiagnostic | undefined {
		return this._toolExecutionStallDiagnostic === undefined ? undefined : { ...this._toolExecutionStallDiagnostic };
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildSessionContext(): SessionContext {
		const context = this.sessionManager.buildSessionContext();
		for (const message of context.messages) {
			this._applyLateIpythonSentAgentMessages(message);
		}
		this._mergeUnpersistedCompactionOutcomes(context.messages);
		return context;
	}

	/**
	 * Merge disclosures whose session-file append failed into a rebuilt message
	 * list at their timestamp position, where they appeared live.
	 */
	private _mergeUnpersistedCompactionOutcomes(messages: AgentMessage[]): void {
		for (const outcome of this._unpersistedCompactionOutcomes) {
			let insertAt = messages.length;
			while (insertAt > 0 && messages[insertAt - 1]!.timestamp > outcome.timestamp) {
				insertAt -= 1;
			}
			messages.splice(insertAt, 0, outcome);
		}
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current RLM spawn depth for this session. */
	get rlmDepth(): number {
		return this._rlmDepth;
	}

	/** Current absolute RLM spawn-depth cap. */
	get rlmMaxDepth(): number {
		return this._rlmMaxDepth;
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get goalState(): GoalState {
		return { ...this._goalWithCurrentWallClock() };
	}

	/**
	 * Read the stable persisted GoalState used by durable workflow projection CAS.
	 *
	 * Return: Persisted GoalState without the UI-only live elapsed-time projection.
	 */
	readGoalStateForWorkflowProjection(): GoalState {
		return workflowGoalProjectionSnapshot(this._loadPersistedGoalState());
	}

	/**
	 * Compare the durable GoalState snapshot and apply one workflow-authorized projection update.
	 *
	 * Args:
	 * expected: Durable GoalState snapshot the workflow transition read.
	 * next: GoalState snapshot authorized by that transition.
	 * authorization: Opaque journal-issued authority for the projection update.
	 * Return: True when the exact durable snapshot was exchanged; otherwise false.
	 */
	compareAndSwapGoalState(
		expected: GoalState,
		next: GoalState,
		authorization: WorkflowGoalProjectionAuthorization,
	): boolean {
		const current = this._loadPersistedGoalState();
		if (
			digestWorkflowGoalState(current) !== digestWorkflowGoalState(expected) ||
			!validateWorkflowGoalProjectionAuthorization(authorization, {
				workflowId: this.sessionManager.getSessionId(),
				expectedGoal: expected,
				nextGoal: next,
			})
		)
			return false;
		this._setGoalState(next, { rewriteUpdatedAt: false, workflowProjection: true });
		if (
			!consumeWorkflowGoalProjectionAuthorization(authorization, {
				workflowId: this.sessionManager.getSessionId(),
				expectedGoal: expected,
				nextGoal: next,
			})
		)
			throw new Error("Workflow goal projection authorization was consumed before its durable CAS completed.");
		return true;
	}

	getAutonomousStatus(): AgentAutonomousStatus {
		return autonomousStatus(this._autonomousState);
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

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
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
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
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
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	// =========================================================================
	// Prompting
	// =========================================================================

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
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false, false);
	}

	private async _prepareForCommit<TPrepared, TCommitted>(
		policy: CommitPreparationPolicy,
		steps: CommitPreparationSteps<TPrepared, TCommitted>,
	): Promise<TCommitted | undefined> {
		if (
			policy.initialRefineBarrier === "always" ||
			(policy.initialRefineBarrier === "ifInFlight" && this._refineInFlight)
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
			policy.finalRefineBarrier === "always" ||
			(policy.finalRefineBarrier === "ifInFlight" && this._refineInFlight)
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

	/** Resolve once the session has accepted ownership, before queued or active execution completes. */
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
		try {
			await this.promptUntilAccepted(text, { ...options, agentMessageId });
			await completion;
		} catch (error) {
			this._settleAgentMessage(agentMessageId, "completion", this._asError(error));
			throw error;
		}
	}

	async acceptAgentMessagePrompt(text: string, options?: PromptOptions): Promise<void> {
		const customMessage =
			options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined;
		await this._prompt(text, {
			...options,
			expandPromptTemplates: false,
			skipInputHandlers: true,
			skipPrePromptWork: true,
			returnAfterAccepted: true,
			agentMessageId: options?.agentMessageId ?? customMessage?.details.id ?? parseAgentSessionMessagePromptId(text),
			customMessage,
		});
		if (customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
	}

	/** Attach the durable bridge used by daemon-originated agent messages. */
	setAgentMessageObligationBridge(bridge: SessionMessageObligationBridge | undefined): void {
		this._agentMessageObligationBridge = bridge;
	}

	/** Return whether an accepted agent message already has a scheduler-owned action. */
	hasAgentMessageAction(messageId: string): boolean {
		return this._actionStore.ownedActions().some((action) => {
			if (action.payload.kind !== "turn") return false;
			const primary = primaryDeliveryRecord(action).message;
			return isAgentSessionMessage(primary) && primary.details.id === messageId;
		});
	}

	/** Return whether a stable agent message id already exists in the persisted transcript. */
	hasPersistedAgentMessage(messageId: string): boolean {
		return this.sessionManager.getEntries().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== AGENT_MESSAGE_CUSTOM_TYPE) return false;
			const details = entry.details;
			return isObjectRecord(details) && details.id === messageId;
		});
	}

	/**
	 * Deliver an agent-to-agent message at the recipient's next turn boundary.
	 *
	 * The session-level queue waits for the whole run to finish, so a message to a busy agent
	 * cannot reach it mid-task. Steering injects at the next turn boundary instead. Steering
	 * also keeps the recipient's loop alive (agent-loop drains it and declines to stop), so two
	 * agents can hold each other running — the bounds below are what make this safe.
	 *
	 * Args:
	 * prompt: Rendered message text delivered to the recipient.
	 * message: Structured agent message, used for identity and de-duplication.
	 * Return: True when the message was steered; false when the caller should fall back to queueing.
	 */
	/**
	 * Register who this worker is and which siblings review its changes.
	 *
	 * Args:
	 * peers: Author identity and reviewer session ids, or undefined to stop sharing.
	 * Return: No value.
	 */
	setCollaborationPeers(peers: { readonly author: string; readonly reviewers: readonly string[] } | undefined): void {
		this._collaborationPeers = peers;
	}

	/**
	 * Deliver the diff for a just-edited path to this worker's reviewers.
	 *
	 * The diff is computed by the host, so the editing worker spends no model turn producing it
	 * and reviewers spend none polling for it. That is the entire cost argument for sharing work
	 * in progress rather than having each side fetch it.
	 *
	 * Args:
	 * path: File the worker just changed.
	 * Return: Number of reviewers the diff reached.
	 */
	async pushDiffToReviewers(path: string): Promise<number> {
		const peers = this._collaborationPeers;
		if (peers === undefined || peers.reviewers.length === 0) return 0;
		const collaboration = this.settingsManager.getAgentCollaboration();
		if (!sharesDiffs(collaboration)) return 0;
		const cwd = this.sessionManager.getCwd?.() ?? process.cwd();
		const diff = await computePathDiff(cwd, path, collaboration.maxDiffBytes).catch(() => undefined);
		if (diff === undefined) return 0;
		const body = formatDiffPush(diff, peers.author);
		let delivered = 0;
		for (const reviewer of peers.reviewers) {
			const sent = await this._deliverCollaborationMessage(reviewer, body).catch(() => false);
			if (sent) delivered += 1;
		}
		return delivered;
	}

	/** Push a diff for every path changed in the working tree; duplicates are dropped downstream. */
	private async _pushChangedDiffs(): Promise<void> {
		const cwd = this.sessionManager.getCwd?.() ?? process.cwd();
		const paths = await changedPaths(cwd).catch(() => []);
		for (const path of paths) await this.pushDiffToReviewers(path).catch(() => {});
	}

	/** Send one collaboration message to a sibling; returns whether it was accepted. */
	private async _deliverCollaborationMessage(target: string, body: string): Promise<boolean> {
		const controller = this._agentMessageController;
		if (controller === undefined) return false;
		const receipt = await controller.sendAgentMessage({ target, message: body });
		return receipt?.deliveryStatus === "delivered" || receipt?.deliveryStatus === "queued";
	}

	steerAgentMessage(prompt: string, message: AgentSessionMessage): boolean {
		if (!this.settingsManager.getAgentMessageMidRunDelivery()) return false;
		if (this._disposed || this._disposing) return false;
		// Only useful while a run is active; otherwise the ordinary queue delivers promptly.
		if (!this.isStreaming) return false;

		const senderEndpoint = message.details.from;
		const sender = senderEndpoint?.sessionId ?? "unknown";
		// Identical content from the same sender cannot carry new information. This mirrors the
		// existing autonomous-gate rule that refuses to re-run a gate when nothing changed.
		const fingerprint = `${sender}:${sha256Hex(prompt)}`;
		if (this._steeredAgentMessageFingerprints.has(fingerprint)) return false;

		const consecutive = (this._consecutiveSteersBySender.get(sender) ?? 0) + 1;
		if (consecutive > MAX_CONSECUTIVE_AGENT_MESSAGE_STEERS) return false;

		this._steeredAgentMessageFingerprints.add(fingerprint);
		this._consecutiveSteersBySender.set(sender, consecutive);
		this.agent.steer({ role: "user", content: prompt, timestamp: Date.now() } satisfies UserMessage);
		return true;
	}

	/** Clear steer budgets once the recipient completes a run, so the next task starts fresh. */
	private _resetAgentMessageSteerBudget(): void {
		this._consecutiveSteersBySender.clear();
		this._steeredAgentMessageFingerprints.clear();
	}

	async queueAgentMessagePrompt(
		text: string,
		streamingBehavior: "steer" | "followUp",
		customMessage?: AgentSessionMessage,
	): Promise<boolean> {
		const agentMessageId = customMessage?.details.id ?? parseAgentSessionMessagePromptId(text);
		try {
			this._assertWorkflowTaskAdmissionAllowed();
		} catch (error) {
			const normalized = this._asError(error);
			await this._settleRejectedWorkflowAgentMessage(customMessage, normalized);
			throw normalized;
		}
		if (streamingBehavior === "steer") {
			await this._queuePreparedPrompt("steer", text, undefined, {
				agentMessageId,
				message: customMessage,
				resumeIfIdle: true,
			});
			if (agentMessageId !== undefined && this.hasAgentMessageAction(agentMessageId))
				this._scheduleAgentMessageDeliveryDeadline(agentMessageId);
			if (customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
			return true;
		}
		const queued = await this._queuePreparedPrompt("followUp", text, undefined, {
			agentMessageId,
			message: customMessage,
			resumeIfIdle: true,
		});
		if (queued && agentMessageId !== undefined && this.hasAgentMessageAction(agentMessageId))
			this._scheduleAgentMessageDeliveryDeadline(agentMessageId);
		if (queued && customMessage?.details.fromRelationship === "parent") this._repliedToParentSinceTask = false;
		return queued;
	}

	/** Wait until every currently accepted agent message has reached recipient context. */
	async waitForPendingAgentMessageDelivery(): Promise<void> {
		const pendingIds = [...this._pendingAgentMessageContextDeliveries];
		if (pendingIds.length === 0) return;
		const deliveries = pendingIds.map((messageId) => this.waitForAgentMessagePromptContext(messageId));
		this._agentMessageDeadlineContextCommit = this._agentMessageDeadlineContextCommit
			.catch(() => undefined)
			.then(() => this._persistPendingAgentMessageContextBatch());
		await this._agentMessageDeadlineContextCommit;
		this._sessionInputPumpSuspended = false;
		this._scheduleSessionInputPump();
		await Promise.all(deliveries);
	}

	async promptHeartbeat(job: AgentCronJob, options?: PromptOptions): Promise<void> {
		const message = createHeartbeatPromptMessage(job);
		await this._promptInjectedMessage(job.prompt, message, {
			...options,
			followUpQueueKey: options?.followUpQueueKey ?? `heartbeat:${job.id}`,
			resumeIfIdle: true,
		});
	}

	private async _promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options?: InternalPromptOptions & { executionPolicy?: TurnExecutionPolicy },
	): Promise<void> {
		try {
			this._assertWorkflowTaskAdmissionAllowed();
		} catch (error) {
			const normalized = this._asError(error);
			await this._settleRejectedWorkflowAgentMessage(
				isAgentSessionMessage(message) ? message : undefined,
				normalized,
			);
			throw normalized;
		}
		if (!this.isStreaming && options?.resumeIfIdle) this._sessionInputPumpSuspended = false;
		const admissionFence = await this._acquireDirectTurnAdmissionFence(options?.signal).catch((error: unknown) => {
			throwIfPromptAdmissionCancelled(options?.signal);
			throw error;
		});
		const reportPreflight = oncePreflight(options?.preflightResult);
		try {
			throwIfPromptAdmissionCancelled(options?.signal);
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
		try {
			this._assertWorkflowTaskAdmissionAllowed();
		} catch (error) {
			const normalized = this._asError(error);
			await this._settleRejectedWorkflowAgentMessage(
				options?.customMessage && isAgentSessionMessage(options.customMessage) ? options.customMessage : undefined,
				normalized,
			);
			throw normalized;
		}
		if (!this.isStreaming) {
			this._sessionInputPumpSuspended = false;
			this._assertSessionActionAdmissionAvailable();
		}
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

	private _workflowSkillNamesBoundToHost(): ReadonlySet<string> {
		const bindings = this._workflowHost as WorkflowKernelHostBindings | undefined;
		const names = bindings?.primeWorkflow?.snapshots?.skills
			.map((skill) => skill.skillName)
			.filter((name) => name !== "workflow-autoresearch" && name !== "mempalace");
		return names === undefined ? new Set<string>() : new Set(names);
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
		if (this._workflowSkillNamesBoundToHost().has(skillName))
			throw new Error("workflow skill execution requires an authenticated immutable snapshot admission");

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
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
		const actions = snapshot.actions.map((recovered): QueuedSessionAction => {
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
		for (const action of actions) this._admitSessionInput(action, { restore: true });
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
		if (this.unfinishedActionCount > 0 && this._sessionInputPumpSuspended) {
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
		if (action.payload.kind === "turn") {
			const reason = this._workflowTaskAdmissionBlockReason();
			if (reason !== undefined) {
				const error = new AgentSessionMessageBlockedError(reason);
				const primary = primaryDeliveryRecord(action).message;
				if (isAgentSessionMessage(primary)) {
					this._rejectAgentMessage(action.agentMessageId, error);
					const bridge = this._agentMessageObligationBridge;
					if (bridge !== undefined) {
						void bridge
							.beforeAgentMessageDispatch(primary)
							.then(() => bridge.settleAgentMessage(primary, "failed", `quarantine:${error.reason}`))
							.catch(() => undefined);
					}
				}
				if (options.restore) return { accepted: false, disposition: "queued" };
				throw error;
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
			if (action.payload.kind === "turn" && action.wake === "immediate") this._sessionInputPumpSuspended = false;
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
		} = {},
	): Promise<boolean> {
		this._assertWorkflowTaskAdmissionAllowed();
		const action = this._createPreparedTurnAction(schedule, text, images, options);
		if (action.suppressAutonomousContinuation) {
			this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
		}
		return this._admitSessionInput(action).accepted;
	}

	private _runtimeActivity(): RuntimeActivity {
		return {
			lowerAgentRun: this.isStreaming || this._toolExecutionLiveness.size > 0,
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

	private _hasSelectableAgentMessageInput(): boolean {
		return [...this._actionStore.queuedActions(), ...this._actionStore.activeActions()].some((action) => {
			if (
				action.payload.kind !== "turn" ||
				(action.lifecycle.state !== "queued" && action.lifecycle.state !== "selected")
			) {
				return false;
			}
			return isAgentSessionMessage(primaryDeliveryRecord(action).message);
		});
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
			this._sessionInputPumpActive = true;
			try {
				await this._pumpSessionInputs(epoch);
			} finally {
				this._sessionInputPumpActive = false;
			}
		};
		this._sessionInputPump = this._sessionInputPump.then(pump, pump);
		this._sessionInputPump.catch(() => {});
	}

	private async _pumpSessionInputs(epoch: number): Promise<void> {
		let blocked = false;
		try {
			while (!this._disposed && !this._disposing && this._hasSelectableSessionInput()) {
				const resourceBlocker = this.sessionManager.getLatestResourceExhaustedBlockerEntry();
				if (resourceBlocker && resourceBlocker.state !== "cleared") {
					if (!this._admitResourceExhaustionProbeIfReady()) {
						blocked = true;
						this._notifySessionInputCheckpointChange();
						return;
					}
				}
				await this.agent.waitForIdle();
				const preselected = this._actionStore
					.activeActions()
					.find((action) => action.lifecycle.state === "selected");
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
				const probeLease = this.sessionManager.getLatestResourceExhaustedBlockerEntry();
				const isResourceProbe = probeLease?.state === "probe_leased" && probeLease.probeLeaseActionId === first.id;
				const firstMessage = first.payload.kind === "turn" ? primaryDeliveryRecord(first).message : undefined;
				const batchAgentMessages = firstMessage !== undefined && isAgentSessionMessage(firstMessage);
				let agentMessageBatchChars = batchAgentMessages ? firstMessage.content.length : 0;
				while (!preselected && (mode === "all" || batchAgentMessages) && !isResourceProbe) {
					const next = this._actionStore.queuedActions(first.delivery)[0];
					if (
						!next ||
						next.payload.kind !== "turn" ||
						!turnExecutionPoliciesEqual(first.payload.executionPolicy, next.payload.executionPolicy)
					) {
						break;
					}
					if (batchAgentMessages) {
						const nextMessage = primaryDeliveryRecord(next).message;
						if (
							!isAgentSessionMessage(nextMessage) ||
							actions.length >= AGENT_MESSAGE_BATCH_MAX_ACTIONS ||
							agentMessageBatchChars + nextMessage.content.length > AGENT_MESSAGE_BATCH_MAX_CHARS
						) {
							break;
						}
						agentMessageBatchChars += nextMessage.content.length;
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
							const primary = primaryDeliveryRecord(action).message;
							if (this._agentMessageObligationBridge !== undefined && isAgentSessionMessage(primary)) {
								await this._agentMessageObligationBridge.settleAgentMessage(primary, "processed");
							}
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
						if (action.payload.kind === "turn" && this._agentMessageObligationBridge !== undefined) {
							const primary = primaryDeliveryRecord(action).message;
							if (isAgentSessionMessage(primary)) {
								await this._agentMessageObligationBridge
									.settleAgentMessage(primary, "failed", terminalError.message)
									.catch(() => undefined);
							}
						}
						const ticket = this._actionStore.ticketFor(action);
						if (undelivered.includes(action)) {
							ticket.rejectDelivered(terminalError);
							this._settleAgentMessage(action.agentMessageId, "delivery", terminalError);
							this._settleAgentMessage(action.agentMessageId, "context", terminalError);
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
			let resolvePromptStarted!: () => void;
			const promptStarted = new Promise<void>((resolve) => {
				resolvePromptStarted = resolve;
			});
			try {
				promptPromise = this._sessionActionCommitContext.run(commitFence.owner, async () => {
					this._assertWorkflowTaskAdmissionAllowed();
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
					for (const action of turns) {
						const primaryRecord = primaryDeliveryRecord(action);
						const primary = primaryRecord.message;
						if (!isAgentSessionMessage(primary) || this._agentMessageObligationBridge === undefined) continue;
						const dispatch = await this._agentMessageObligationBridge.beforeAgentMessageDispatch(primary);
						if (
							dispatch === "quarantine" &&
							(!primaryRecord.durable || !this.hasPersistedAgentMessage(primary.details.id))
						) {
							throw new Error(
								`Agent message ${primary.details.id} was quarantined after durable transcript reconciliation`,
							);
						}
					}
					this._assertWorkflowTaskAdmissionAllowed();
					for (const action of turns) transitionSessionAction(action, { state: "committing" });
					this._notifySessionInputCheckpointChange();
					this._emitQueueUpdate();
					const modelPrompt = turns.some((action) => action.suppressAutonomousContinuation)
						? this._runWithAutonomousContinuationSuppressed(() => this.agent.prompt(preparedMessages))
						: this.agent.prompt(preparedMessages);
					resolvePromptStarted();
					return modelPrompt;
				});
				await Promise.race([promptStarted, promptPromise.then(() => undefined)]);
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
			switch (input.command.name) {
				case "compact":
					await this.compact(input.command.args || undefined, {
						skipAbort: true,
					});
					break;
				case "refine": {
					const options = parseRefineCommandOptions(input.command.args);
					const result = await this.refine(options, { skipAbort: true });
					const applied = result.appliedEdits.filter((appliedEdit) => appliedEdit.applied).length;
					resultText = `Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied.`;
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
				case "workflow": {
					const workflowCommand = parseWorkflowSessionCommand(input.command.args);
					if (workflowCommand.kind === "brainstorm") {
						resultText = await this._beginWorkflowBrainstorm(workflowCommand);
					} else if (workflowCommand.kind === "approve") {
						resultText = formatWorkflowSessionStatus(await this._approveWorkflowProposal(workflowCommand.cloud));
					} else if (workflowCommand.kind === "cancel" && this._workflowBrainstorm?.status === "draft") {
						const state = this._workflowBrainstorm;
						this._persistWorkflowBrainstormState({ ...state, status: "cancelled" });
						this.setActiveToolsByName([...state.previousToolNames]);
						resultText = "Workflow brainstorming cancelled before workflow authority was created.";
					} else {
						const status = await this.executeWorkflowCommand(workflowCommand);
						resultText = formatWorkflowSessionStatus(status);
					}
					break;
				}
			}
			if (resultText) {
				this._appendDurableSessionCommandMessage(resultText, input.command, true, false);
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
				// Surfacing the command failure matters more than persisting its row.
			}
			throw commandError;
		}
	}

	private _appendDurableSessionCommandMessage(
		content: string,
		command: SessionSlashCommand,
		isResult: boolean,
		isError = false,
	): void {
		const message: CustomMessage = isResult
			? createSessionSlashCommandResultMessage(content, {
					command,
					success: !isError,
					severity: isError ? "error" : "info",
					...(isError ? { error: content.replace(/^Command failed:\s*/, "") } : {}),
				})
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

	/**
	 * Throw an error if the text is an extension command.
	 */
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
		// Normalize content to text string + optional images
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

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this._prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
			resumeIfIdle: true,
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
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
			this._settleAgentMessage(action.agentMessageId, "context", error);
			this._settleAgentMessage(action.agentMessageId, "completion", error);
		}
		const clearableIds = new Set(clearable.map((action) => action.id));
		this._cancelSessionActions((action) => clearableIds.has(action.id), agentMessageError);
		this.agent.clearAllQueues();
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

	get sessionInputWakeInvariantViolation(): "queued_without_wake" | undefined {
		if (!this._hasSelectableAgentMessageInput()) return undefined;
		if (
			this._sessionInputPumpRequested ||
			this._sessionInputPumpActive ||
			this._abortInProgress ||
			this.isStreaming ||
			this.isCompacting ||
			this.isRetrying ||
			this.isBashRunning ||
			this._queuedWorkPauses.size > 0
		) {
			return undefined;
		}
		return "queued_without_wake";
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

	/** Resume the scheduler after requestAbort/abortForUpdateRestart suspended it; owned pause leases are unaffected. */
	resumeQueuedWork(): boolean {
		this._sessionInputPumpSuspended = false;
		this._notifySessionInputCheckpointChange();
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

	/**
	 * Clear the abort suspension and restart the pump when any input is still selectable.
	 *
	 * Return: No value.
	 */
	private _resumeSessionInputPumpAfterAbort(): void {
		if (this._disposed || this._disposing) return;
		if (!this._hasSelectableSessionInput()) return;
		this._sessionInputPumpSuspended = false;
		this._notifySessionInputCheckpointChange();
		this._scheduleSessionInputPump();
	}

	requestAbort(): void {
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._cancelSessionActions(
			(action) => action.payload.kind === "turn" && !action.payload.queueVisible,
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
		// abort() has its own recovery in a finally block; callers that use requestAbort()
		// directly (daemon-mode, in-process-agent-connection) would otherwise strand the queue.
		void this.agent
			.waitForIdle()
			.catch(() => {})
			.then(() => {
				if (!this._abortInProgress) this._resumeSessionInputPumpAfterAbort();
			});
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		const compactionOperation = this._compactionOperation;
		const branchSummaryOperation = this._branchSummaryOperation;
		this._abortInProgress = true;
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
			this._abortInProgress = false;
			// Must match the pump's own gate (_hasSelectableSessionInput). Recovering only for
			// agent-to-agent messages stranded every other queued input — follow-ups, heartbeats,
			// cron prompts — with the pump suspended and nothing left to restart it.
			this._resumeSessionInputPumpAfterAbort();
		}
	}

	abortForUpdateRestart(): void {
		// Cancel scheduled pumps and suspend new ones: queued inputs must survive
		// into the restart manifest instead of starting a turn during teardown.
		this._sessionInputPumpRequested = false;
		this._sessionInputPumpEpoch++;
		this._sessionInputPumpSuspended = true;
		this._cancelPostCompactionContinue();
		this.abortRetry();
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

	// =========================================================================
	// Model Management
	// =========================================================================

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

	/**
	 * Set model directly.
	 * Validates that the model is available, saves to session and settings.
	 * @throws Error if the model is not available
	 */
	async setModel(model: Model<any>, options: ModelSelectOptions = {}): Promise<void> {
		if (!this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		if (!(await this._modelRegistry.canUseModel(model))) {
			throw new Error(`Model "${model.provider}/${model.id}" is not available for the current Prime team.`);
		}

		const previousModel = this.model;
		if (!modelsAreEqual(previousModel, model)) this._advanceResourceCapacityRevision();
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		const serviceTier = this._getServiceTierForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
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

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
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

		// Apply model
		if (!modelsAreEqual(currentModel, next.model)) this._advanceResourceCapacityRevision();
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
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
		if (!modelsAreEqual(currentModel, nextModel)) this._advanceResourceCapacityRevision();
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
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

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
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

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
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

	// Added to history (not a nextTurn message) so it also reaches the continue()-driven
	// auto-compaction resume, which never injects nextTurn messages.
	private async _notifyKernelStateAfterCompaction(): Promise<void> {
		const provisioner = this._ipythonKernelProvisioner;
		// No kernel means no state to remind about; only stay silent in that case.
		if (!provisioner?.hasRunningKernel) return;
		// Bound the probe so a wedged kernel can't stall recovery, and abort it on timeout so
		// the kernel's serialized execution queue isn't left occupied by a never-resolving cell.
		const abort = new AbortController();
		const timer = setTimeout(() => abort.abort(), KERNEL_STATE_LISTING_TIMEOUT_MS);
		if (typeof timer === "object" && "unref" in timer) timer.unref();
		let names: string[] | null;
		try {
			names = await provisioner.listNamespaceNames(abort.signal).catch(() => null);
		} finally {
			clearTimeout(timer);
		}
		// null is a listing failure/timeout; only claim state survived if the kernel is still up
		// (it may have died in the window since the check above).
		if (names === null && !provisioner.hasRunningKernel) return;
		const detail =
			names === null
				? ""
				: names.length > 0
					? ` These names are still defined: ${names.join(", ")}.`
					: " You have not defined any names yet.";
		const content = [
			"<ipython_state>",
			`Your IPython kernel persisted through compaction; all variables, imports, and helpers you defined remain available.${detail}`,
			"</ipython_state>",
		].join("\n");
		const message = {
			role: "custom" as const,
			customType: "ipython_state",
			content,
			display: false,
			timestamp: Date.now(),
		} satisfies CustomMessage;
		// Insert before a trailing assistant error so overflow-retry cleanup can still strip it.
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

	/**
	 * Tell the model when a resumed session revived its IPython kernel state, so it
	 * knows which variables are actually available instead of assuming the kernel is
	 * the one it left. Delivered as context before the next turn.
	 */
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

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	private async _runCompactionWithDeadline<T>(
		controller: AbortController,
		operation: (signal: AbortSignal, setPhase: (phase: AgentSessionCompactionPhase) => void) => Promise<T>,
	): Promise<T> {
		const attempt = ++this._compactionAttempt;
		const startedAt = Date.now();
		const deadlineAt = startedAt + this._compactionDeadlineMs;
		const setPhase = (phase: AgentSessionCompactionPhase): void => {
			if (this._compactionAttempt !== attempt || this._compactionLiveness === undefined) return;
			this._compactionLiveness = { phase, startedAt, deadlineAt };
		};
		this._compactionLiveness = { phase: "authenticating", startedAt, deadlineAt };
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_resolve, reject) => {
			deadlineTimer = setTimeout(() => {
				const phase = this._compactionLiveness?.phase ?? "recovering";
				setPhase("recovering");
				controller.abort();
				reject(new CompactionDeadlineExceededError(phase, this._compactionDeadlineMs));
			}, this._compactionDeadlineMs);
		});

		try {
			return await Promise.race([operation(controller.signal, setPhase), deadline]);
		} catch (error) {
			if (error instanceof CompactionDeadlineExceededError) {
				this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
				this._mergeUnpersistedCompactionOutcomes(this.agent.state.messages);
				this._restoreLateIpythonSentAgentMessages();
			}
			throw error;
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			if (this._compactionAttempt === attempt) this._compactionLiveness = undefined;
		}
	}

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string, options: { skipAbort?: boolean } = {}): Promise<CompactionResult> {
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

			const result = await this._runCompactionWithDeadline(
				this._compactionAbortController,
				async (signal, setPhase) => {
					setPhase("authenticating");
					const { apiKey, headers } = await this._getRequiredRequestAuth(this.model!);
					if (signal.aborted) throw new Error("Compaction cancelled");
					return await this._performCompaction({
						model: this.model!,
						apiKey,
						headers,
						customInstructions,
						signal,
						setPhase,
					});
				},
			);

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
			if (error instanceof CompactionDeadlineExceededError) {
				this._persistCompactionOutcome("manual", "failed", message);
			}
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
		setPhase: (phase: AgentSessionCompactionPhase) => void;
	}): Promise<CompactionResult> {
		const { model, apiKey, headers, customInstructions, signal, setPhase } = options;
		setPhase("preparing");
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
			setPhase("before_extension");
			const result = (await this._extensionRunner.emit({
				type: "session_before_compact",
				preparation,
				branchEntries: pathEntries,
				customInstructions,
				signal,
			})) as SessionBeforeCompactResult | undefined;
			if (signal.aborted) throw new Error("Compaction cancelled");

			if (result?.cancel) {
				throw new Error("Compaction cancelled");
			}

			if (result?.compaction) {
				extensionCompaction = result.compaction;
				fromExtension = true;
			}
		}

		setPhase("summarizing");
		const { summary, firstKeptEntryId, tokensBefore, details } =
			extensionCompaction ??
			(await compact(preparation, model, apiKey, headers, customInstructions, signal, this.thinkingLevel));

		if (signal.aborted) {
			throw new Error("Compaction cancelled");
		}

		setPhase("committing");
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
		this._mergeUnpersistedCompactionOutcomes(this.agent.state.messages);
		this._restoreLateIpythonSentAgentMessages();

		// Get the saved compaction entry for the extension event
		const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
			| CompactionEntry
			| undefined;
		if (savedCompactionEntry) {
			setPhase("after_extension");
			await this._extensionRunner.emit({
				type: "session_compact",
				compactionEntry: savedCompactionEntry,
				fromExtension,
			});
			if (signal.aborted) throw new Error("Compaction cancelled");
		}
		setPhase("kernel_notification");
		await this._notifyKernelStateAfterCompaction();
		if (signal.aborted) throw new Error("Compaction cancelled");
		setPhase("child_cleanup");
		await this._reapDeletedRlmSubagentRuntimesAfterCompaction();
		if (signal.aborted) throw new Error("Compaction cancelled");

		return { summary, firstKeptEntryId, tokensBefore, details };
	}

	private async _reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void> {
		const childIds = [...this._rlmChildCleanupFailures.keys()].filter(
			(childId) => !this._activeRlmChildRuns.get(childId)?.detachedDeletion,
		);
		await Promise.allSettled(childIds.map((childId) => this.deleteRlmSubagent(childId)));
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
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
		return (
			this._rlmDepth === 0 &&
			this._localHarnessStateDir() !== undefined &&
			!this._workflowOwnsGoalState() &&
			this._workflowBrainstorm?.status !== "draft" &&
			this._workflowBrainstorm?.status !== "proposed"
		);
	}

	private _cancelPostCompactionContinue(): void {
		if (this._postCompactionContinuationTimer) {
			clearTimeout(this._postCompactionContinuationTimer);
			this._postCompactionContinuationTimer = undefined;
		}
		this._postCompactionContinuationScheduled = false;
		this._scheduledPostCompactionContinuationMessages = [];
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
		// Await and clear serialized background plan if in flight.
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
		if (this._workflowOwnsGoalState()) {
			this._pendingRequestedRefine = undefined;
			this._emitRefineFailed(new AgentSessionRefinementError());
			return false;
		}
		const pending = this._pendingRequestedRefine;
		if (!pending) return false;
		this._pendingRequestedRefine = undefined;
		void this.refine(pending).catch((error) => this._emitRefineFailed(error));
		return true;
	}

	private _scheduleAutoRefineAfterAgentEnd(): void {
		if (!this._autoRefineAllowedForSession()) {
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
		this._postCompactionContinuationScheduled = true;
		this._scheduledPostCompactionContinuationMessages = [...this._postCompactionContinuationMessages];
		this._postCompactionContinuationTimer = setTimeout(() => {
			this._postCompactionContinuationTimer = undefined;
			void this._runScheduledPostCompactionContinue();
		}, 100);
	}

	/** Whether any snapshot of scheduled continuation messages is still session-owned. */
	private _sessionOwnsScheduledContinuations(continuationMessages: AgentMessage[]): boolean {
		return continuationMessages.some((message) => this._postCompactionContinuationMessages.includes(message));
	}

	private async _runScheduledPostCompactionContinue(): Promise<void> {
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
		if (this._workflowTaskAdmissionBlockReason() !== undefined) return;
		try {
			await this.agent.continue();
			this._forgetConsumedPostCompactionContinuations(continuationMessages);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("already processing")) {
				this._schedulePostCompactionContinue();
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
		this._assertRefinementAuthority();
		if (this._disposed || this._disposing) {
			this._discardPendingAutoRefine();
			return;
		}
		if (!this._autoRefineAllowedForSession()) {
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
		this._assertRefinementAuthority();
		this._autoRefineInProgress = true;
		try {
			await this.refine({
				instructions: autoRefineInstructions(reason, review),
			});
			this._pendingAutoRefineReview = undefined;
			this._turnIntervalAutoRefinePending = false;
			this._lastAutoRefineReviewAt = Date.now();
			this._assistantTurnsSinceAutoRefine = 0;
			if (reason === "compact") {
				this._compactAutoRefinePending = false;
			}
		} catch {
			// Auto-refine is opportunistic; manual /refine remains available.
			// Stamp the cooldown so a persistently failing refine doesn't retry
			// (via a retained pending review) on every agent end.
			this._lastAutoRefineReviewAt = Date.now();
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
		internal: { skipAbort?: boolean } = {},
	): Promise<RefinementResult> {
		this._assertRefinementAuthority();
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

		// Background planning phase — does NOT block turn entry points
		const planRun = this._planRefine(options, refineAbort.signal);
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
	): Promise<RefinementPlan> {
		this._assertRefinementAuthority();
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
		this._assertRefinementAuthority();
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
			this.sessionManager.appendCustomEntry("prime-agent.refinement", result);
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

	/**
	 * Cancel in-progress branch summarization.
	 */
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

		// Case 2: Model-requested (compact skill); runs even with auto-compaction off.
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
			if (
				queueAutonomousContinuation &&
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
	/** Emit an unsuccessful compaction_end and durably record the outcome. */
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
			this._unpersistedCompactionOutcomes.push(outcomeMessage);
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
		this._continueAfterThresholdCompaction = false;

		// A requested compaction stopped the loop on purpose; don't stall if it fails.
		const resumeAfterFailure = () => {
			if (
				reason === "requested" &&
				(shouldContinueAfterCompaction || this.agent.hasQueuedMessages() || this.hasPendingSessionWork)
			) {
				this._schedulePostCompactionContinue();
			}
		};

		this._emit({ type: "compaction_start", reason, customInstructions });
		this._autoCompactionAbortController = new AbortController();

		try {
			const boundedResult = await this._runCompactionWithDeadline(
				this._autoCompactionAbortController,
				async (signal, setPhase) => {
					setPhase("authenticating");
					const authResult = this.model ? await this._modelRegistry.getApiKeyAndHeaders(this.model) : undefined;
					if (signal.aborted) throw new Error("Compaction cancelled");
					if (!this.model || !authResult || !authResult.ok || !authResult.apiKey) {
						return { authResult, result: undefined };
					}
					const result = await this._performCompaction({
						model: this.model,
						apiKey: authResult.apiKey,
						headers: authResult.headers,
						customInstructions,
						signal,
						setPhase,
					});
					return { authResult, result };
				},
			);
			const { authResult, result } = boundedResult;
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

			if (!result) throw new Error("Compaction failed without a result");

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

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
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

	private _resolveKernelIsolation(): KernelContainerIsolationOptions | undefined {
		const binding = this._workflowTaskBinding;
		const { workflowId, workflowBound } = this._resolveWorkflowKernelOwnership();
		if (workflowId === undefined) {
			// A registered loader only means this session *can* run a workflow. Isolation is
			// required once one is actually bound; demanding it earlier breaks IPython for
			// every ordinary session.
			if (workflowBound) throw new Error("workflow kernel isolation requires a bound workflow identity");
			return undefined;
		}
		if (!workflowBound && this._workflowHost !== undefined) {
			throw new Error("workflow kernel isolation requires a bound workflow identity");
		}

		const sessionPath = this.sessionManager.getSessionFile();
		const artifactRoot = this.sessionManager.getSessionArtifactDir();
		if (sessionPath === undefined || artifactRoot === undefined) {
			throw new Error("workflow kernel isolation requires persisted session and artifact paths");
		}
		mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
		const image = process.env.PRIME_AGENT_KERNEL_IMAGE;
		// Container isolation is a hardening measure, not a correctness requirement: the kernel
		// runs unisolated when no image is configured, exactly as an ordinary session does. Making
		// it mandatory meant a workflow could never dispatch a worker on a machine without a
		// configured image, which is most local machines.
		if (!image) return undefined;

		const taskId = binding?.taskId ?? "coordinator";
		const attemptId = binding?.attemptId ?? "coordinator";
		const executionKey = binding?.executionKey ?? `workflow:${workflowId}:coordinator`;
		const protectedPaths = [
			this.sessionManager.getSessionDir(),
			sessionPath,
			artifactRoot,
			...(this._agentDir ? [this._agentDir] : []),
		];
		return {
			type: "docker",
			image,
			ownerIdentity: ["kernel", this.sessionId, workflowId, taskId, attemptId, executionKey].join(":"),
			protectedPaths,
			sessionId: this.sessionId,
			sessionPath,
			workflowId,
			taskId,
			attemptId,
			executionKey,
		};
	}

	private _scheduleIpythonPrewarm(provisioner: IpythonKernelProvisioner): void {
		this._ipythonPrewarmPending = true;
		void this._workflowSetupGate.then(
			() => {
				if (this._ipythonKernelProvisioner !== provisioner) return;
				this._releaseDeferredIpythonPrewarm();
			},
			() => undefined,
		);
	}

	private _releaseDeferredIpythonPrewarm(): void {
		if (!this._ipythonPrewarmPending) return;
		if (!this._workflowSetupReady || this._disposed || this._disposing) return;
		if (this._workflowHost === undefined && this._workflowHostLoader !== undefined) return;
		if (this._workflowTaskAdmissionBlockReason() !== undefined) return;
		const provisioner = this._ipythonKernelProvisioner;
		if (provisioner === undefined || !this.getActiveToolNames().includes("ipython")) return;
		this._ipythonPrewarmPending = false;
		provisioner.prewarm();
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
			this._ipythonPrewarmPending = false;
			this._ipythonKernelSnapshotDir = this.sessionManager.getSessionArtifactDir();
			// Only surface the "revived from your previous session" notice on the first
			// build (a genuine resume). A later rebuild (/reload) restores state silently
			// for continuity — the conversation is unchanged, so there's nothing to flag.
			const notifyRestore = !this._ipythonRuntimeBuilt;
			this._ipythonKernelProvisioner = new IpythonKernelProvisioner(this._cwd, {
				python: this._kernelPythonLauncher,
				agentDir: this._agentDir,
				env: this._rlmKernelEnv(),
				sessionId: this.sessionId,
				hostHandlers: this._createKernelHostHandlers(),
				pythonSkills,
				isolation: () => this._resolveKernelIsolation(),
				requiredPythonSkillImports:
					this._goalState.status === "active" ||
					this._goalState.status === "paused" ||
					this._goalState.status === "budget_limited"
						? ["goal"]
						: [],
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
		this._baseToolDefinitions.set(
			WORKFLOW_PROPOSE_TOOL_NAME,
			createWorkflowProposalTool({ propose: (proposal) => this._submitWorkflowBrainstormProposal(proposal) }),
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
		if (
			this._goalState.status === "active" &&
			this._includeGoals &&
			this._workflowBrainstorm?.status !== "draft" &&
			this._workflowBrainstorm?.status !== "proposed"
		) {
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
			const provisioner = this._ipythonKernelProvisioner;
			if (provisioner !== undefined) this._scheduleIpythonPrewarm(provisioner);
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
		const workflowSkillNames = this._workflowSkillNamesBoundToHost();
		if (workflowSkillNames.size > 0) skills = skills.filter((skill) => !workflowSkillNames.has(skill.name));
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
		return skills;
	}

	private _resolveKernelHostCapability(requestType: string): HostRequestCapabilityContext {
		const workflowBindings = this._workflowHost as WorkflowKernelHostBindings | undefined;
		if (
			workflowBindings?.resolveHostRequestCapability !== undefined &&
			(requestType === "autoresearch.run" ||
				requestType === "workflow.v1.autoresearch.run" ||
				requestType === "mempalace.recall" ||
				requestType === "workflow.v1.mempalace.recall" ||
				requestType === "mempalace.propose" ||
				requestType === "workflow.v1.mempalace.propose" ||
				requestType === "pipeline.record" ||
				requestType === "workflow.v1.pipeline.record" ||
				requestType === "execution_evidence.read" ||
				requestType === "workflow.v1.execution_evidence.read" ||
				requestType === "learning.review" ||
				requestType === "workflow.v1.learning.review" ||
				requestType === "learning.rollback" ||
				requestType === "workflow.v1.learning.rollback" ||
				requestType === "completion.request" ||
				requestType === "workflow.v1.completion.request")
		) {
			return workflowBindings.resolveHostRequestCapability(requestType);
		}
		const workflowCapability =
			requestType === "autoresearch.run" || requestType === "workflow.v1.autoresearch.run"
				? "autoresearch.run"
				: requestType === "mempalace.propose" || requestType === "workflow.v1.mempalace.propose"
					? "mempalace.propose"
					: requestType === "pipeline.record" || requestType === "workflow.v1.pipeline.record"
						? "pipeline.record"
						: requestType === "learning.review" || requestType === "workflow.v1.learning.review"
							? "learning.review"
							: requestType === "learning.rollback" || requestType === "workflow.v1.learning.rollback"
								? "learning.rollback"
								: requestType === "completion.request" || requestType === "workflow.v1.completion.request"
									? "completion.request"
									: undefined;
		if (workflowCapability !== undefined) {
			return { capabilities: [] };
		}
		if (requestType === "goal.complete" && this._goalState.status !== "active") return { capabilities: [] };
		if (
			requestType === "goal.create" &&
			(this._goalState.status === "active" ||
				this._goalState.status === "paused" ||
				this._goalState.status === "budget_limited")
		)
			return { capabilities: [] };
		const revision = Math.max(1, this.sessionManager.getBranch().length + 1);
		return {
			workflowId: this.sessionManager.getSessionId(),
			decisionId: this._goalState.goalId ?? `session:${this.sessionManager.getSessionId()}`,
			decisionRevision: revision,
			capabilities: [requestType],
			expiresAt: Date.now() + 60_000,
			nonce: digestObject({ requestType, revision, nonce: randomUUID() }),
		};
	}

	/** Typed handlers for host requests arriving from the IPython kernel comm bridge. */
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
		if (this._autoRefineAllowedForSession() || this._workflowOwnsGoalState()) {
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
		if (this._mcpManager) {
			Object.assign(handlers, this._mcpManager.hostHandlers());
		}
		const workflowBindings = this._workflowHost as WorkflowKernelHostBindings | undefined;
		if (workflowBindings?.hostRequestHandlers !== undefined)
			Object.assign(handlers, workflowBindings.hostRequestHandlers);
		const installed = this._hasExplicitHostRequestCapabilityContext
			? installHostRequestCapabilityContext(handlers, this._hostRequestCapabilityContext)
			: installHostRequestCapabilityResolver(handlers, (requestType) =>
					this._resolveKernelHostCapability(requestType),
				);
		this._workflowHostRequestHandlers = installed;
		return installed;
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
		// Re-read mcpServers and re-register user MCP providers from the reloaded settings.
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
			PYTHONDONTWRITEBYTECODE: "1",
			RLM_DEPTH: String(this._rlmDepth),
			RLM_MAX_DEPTH: String(this._rlmMaxDepth),
			RLM_GLOBAL_HARNESS_STATE_DIR: getGlobalHarnessStateDir(),
		};
		const ownership = this._resolveWorkflowKernelOwnership();
		if (ownership.workflowId !== undefined || ownership.workflowBound) {
			env.RLM_HARNESS_READ_ONLY = "1";
		}
		const rlmSessionDir = this._ensureRlmSessionDir();
		if (rlmSessionDir) {
			env.RLM_SESSION_DIR = rlmSessionDir;
			// Keep kernel writes and host reads (system prompt, review, /refine) on
			// the same local harness path. Subagents prefer their own artifact dir;
			// ephemeral sessions fall back to the RLM session dir once it exists.
			env.RLM_HARNESS_STATE_DIR = this._localHarnessStateDir() ?? getLocalHarnessStateDir(rlmSessionDir)!;
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

	/** Context size (tokens) of this session's latest assistant turn, for live subagent display. */
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
	}): CreateRlmSubagentRuntimeOptions {
		return {
			parentSession: this,
			id: options.id,
			prompt: options.prompt,
			sessionName: options.sessionName,
			spawnCode: options.spawnCode,
			sessionDir: options.sessionDir,
			model: options.model,
			thinkingLevel: clampThinkingLevel(options.model, options.thinkingLevel ?? this.thinkingLevel) as ThinkingLevel,
			serviceTier:
				this.serviceTier === "priority" && !supportsFastMode(options.model) ? "default" : this.serviceTier,
			scopedModels: [...this._scopedModels],
			activeToolNames: this.getActiveToolNames(),
			allowedToolNames: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
			customTools: [...this._customTools],
			includeGoals: this._includeGoals,
			includeCompactSkill: this._includeCompactSkill,
			toolExecutionDeadlineMs: this._toolExecutionDeadlineMs,
			kernelPythonLauncher: this._kernelPythonLauncher,
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

		let childSession: AgentSession | undefined;
		const childMessageController: AgentSessionMessageController = {
			listAgents: () => {
				const child = childSession;
				if (child === undefined)
					throw new Error("Inline child messaging is unavailable before session publication.");
				return {
					current: {
						activeSessionId: child.sessionId,
						sessionId: child.sessionId,
						sessionName: options.sessionName,
					},
					agents: [
						{
							activeSessionId: this.sessionId,
							sessionId: this.sessionId,
							sessionName: this.sessionName,
							runtimeKind: this._rlmDepth === 0 ? "top-level" : "subagent",
							cwd: this._cwd,
							isStreaming: this.isStreaming,
							unfinishedActionCount: this.unfinishedActionCount,
							status: this.isStreaming ? "running" : "idle",
						},
					],
				};
			},
			roster: () => {
				const child = childSession;
				if (child === undefined)
					throw new Error("Inline child messaging is unavailable before session publication.");
				return {
					current: { name: options.sessionName, id: child.sessionId, depth: options.rlmDepth },
					entries: [
						{
							relationship: "parent",
							name: this.sessionName ?? this.sessionId,
							id: this.sessionId,
							depth: this._rlmDepth,
							status: this.isStreaming ? "running" : "idle",
						},
					],
				};
			},
			sendAgentMessage: async (input) => {
				const child = childSession;
				if (child === undefined)
					throw new Error("Inline child messaging is unavailable before session publication.");
				if (input.target !== this.sessionId) throw new Error(AGENT_FAMILY_REACH_ERROR);
				if (this._disposed || this._disposing) throw new Error("Inline parent session is no longer active.");
				const payload: AgentSessionMessagePayload = {
					id: createAgentSessionMessageId(),
					source: AGENT_MESSAGE_SOURCE,
					message: normalizeAgentSessionMessage(input.message),
					from: {
						activeSessionId: child.sessionId,
						sessionId: child.sessionId,
						sessionName: options.sessionName,
						runtimeKind: "subagent" as const,
					},
					fromRelationship: "child" as const,
					target: {
						activeSessionId: this.sessionId,
						sessionId: this.sessionId,
						sessionName: this.sessionName,
						runtimeKind: this._rlmDepth === 0 ? ("top-level" as const) : ("subagent" as const),
					},
				};
				const message = createAgentSessionMessage(payload);
				if (this._agentMessageObligationBridge !== undefined) {
					await this._agentMessageObligationBridge.accept({ payload, lane: "steering" });
				}
				let queued: boolean;
				try {
					queued = await this.queueAgentMessagePrompt(message.content as string, "steer", message);
				} catch (error) {
					if (isAgentSessionMessageBlockedError(error)) {
						return createAgentSessionMessageReceipt(payload, "blocked", error.reason);
					}
					throw error;
				}
				if (!queued) throw new Error("Inline parent message was not queued.");
				return createAgentSessionMessageReceipt(payload, "queued");
			},
		};
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
			toolExecutionDeadlineMs: options.toolExecutionDeadlineMs,
			kernelPythonLauncher: options.kernelPythonLauncher,
			agentMessageController: childMessageController,
			rlmDepth: options.rlmDepth,
			rlmMaxDepth: options.rlmMaxDepth,
			rlmSessionDir: options.sessionDir,
			rlmParentNodeId: options.rlmParentNodeId,
			rlmParentAgent: options.parentSession.sessionName ?? options.parentSession.sessionId,
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});
		childSession = child;
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

	private _cancelActiveRlmChildRuns(reason: string): void {
		for (const run of this._activeRlmChildRuns.values()) {
			this._cancelRlmChildRun(run, reason);
		}
	}

	private _markRlmChildTerminalFenceFailure(run: RlmChildRun, error: unknown): Error {
		const failure = error instanceof Error ? error : new Error(String(error));
		run.terminalFenceError = failure;
		run.status = "error";
		run.error = failure.message;
		return failure;
	}

	private _beginRlmChildTerminalFence(run: RlmChildRun): Promise<void> {
		if (run.terminalFence !== undefined) return run.terminalFence;
		const child = run.session;
		if (child === undefined || child._workflowTaskBinding === undefined) {
			run.terminalFence = Promise.resolve();
			run.terminalFenceSettled = true;
			return run.terminalFence;
		}
		let fence: Promise<void>;
		try {
			fence = child._fenceTerminalTaskKernel();
		} catch (error) {
			fence = Promise.reject(error);
		}
		run.terminalFence = fence;
		run.terminalFenceSettled = false;
		void fence.then(
			() => {
				run.terminalFenceSettled = true;
			},
			(error) => {
				this._markRlmChildTerminalFenceFailure(run, error);
			},
		);
		return fence;
	}

	private _cancelRlmChildRun(run: RlmChildRun, reason: string): boolean {
		if (run.status !== "running" && run.status !== "queued") {
			return false;
		}
		run.status = "cancelled";
		run.error = reason;
		if (run.session?._workflowTaskBinding !== undefined) {
			void this._beginRlmChildTerminalFence(run).then(
				() => {
					if (run.status === "cancelled") {
						run.session?._recordWorkflowTaskTerminal(
							reason === "task_deadline_expired" ? "deadline" : "cancelled",
							reason,
						);
						run.emitUpdate?.();
					}
				},
				(error) => {
					this._markRlmChildTerminalFenceFailure(run, error);
				},
			);
		} else {
			run.emitUpdate?.();
		}
		run.publication.reject(new Error(reason));
		run.abort();
		// Generic runs surface cancellation immediately; workflow runs publish only
		// after their exact child kernel has been fenced.
		return true;
	}

	/** Status of a direct RLM child run, while the run is still tracked. */
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

	/** Current direct-child registry for the model-facing rlm.list_subagents API. */
	async listRlmSubagents(): Promise<RlmListSubagentsResult> {
		return this._buildRlmSubagentList(await this._agentMessageController?.listAgents());
	}

	private _buildRlmSubagentList(listedAgents?: AgentSessionMessageListResult): RlmListSubagentsResult {
		const daemonChildren = new Map<string, AgentSessionMessageAgentSummary>();
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
				status: "completed",
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
				status: daemonChild.rlmChildRegistryStatus === "completed" ? "completed" : "error",
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

	/** Delete an inactive direct or nested child by its registry child id without affecting active runs. */
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

	/** Delete a running, retained, or passive direct child selected from this parent session's registry. */
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
			if (this._deletingRlmChildren.get(subagent.rlm_child_id)?.promise === deletion) {
				this._deletingRlmChildren.delete(subagent.rlm_child_id);
			}
		}
	}

	private _deleteRlmSubagentSession(childId: string, session?: AgentSession): Promise<void> {
		if (this._subagentRuntimeHost) {
			return this._subagentRuntimeHost.deleteRlmSubagentRuntime(childId, session);
		}
		return session?.disposeAsync() ?? Promise.resolve();
	}

	private _removeRlmSubagentTracking(childId: string, run?: RlmChildRun): void {
		run?.unsubscribe?.();
		this._rlmChildUnsubscribes.get(childId)?.();
		this._rlmChildUnsubscribes.delete(childId);
		this._rlmChildSessions.delete(childId);
		this._rlmChildCleanupFailures.delete(childId);
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
			if (!this._cancelRlmChildRun(run, "Deleted by parent orchestrator")) {
				this._emitRlmSubagentRemoval(subagent);
			}
			const liveSession = run.session;
			if (run.status === "error" && !liveSession && run.settled) {
				this._deletedRlmChildIds.add(childId);
				this._removeRlmSubagentTracking(childId, run);
				return { subagent };
			}
			if (liveSession) {
				try {
					await this._deleteRlmSubagentSession(childId, liveSession);
				} catch (error) {
					if (this._disposed || this._disposing) {
						this._removeRlmSubagentTracking(childId, run);
						void liveSession.disposeAsync().catch(() => undefined);
						throw error;
					}
					this._rlmChildSessions.set(childId, liveSession);
					this._rlmChildCleanupFailures.set(childId, subagent);
					if (run.unsubscribe) this._rlmChildUnsubscribes.set(childId, run.unsubscribe);
					this._activeRlmChildRuns.delete(childId);
					run.abort = noopRlmChildAbort;
					run.unsubscribe = undefined;
					run.session = undefined;
					throw error;
				}
				this._deletedRlmChildIds.add(childId);
				this._removeRlmSubagentTracking(childId, run);
				return { subagent };
			}

			// Startup can be blocked in a host before it has a session to close. Admit
			// deletion immediately, but retain the cancelled run as a hidden tombstone
			// until startup settles so selectors cannot be reused underneath it.
			run.detachedDeletion = subagent;
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

	/** Stop retaining an idle daemon child without deleting its durable registry row. */
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
	 * @returns true when a running or queued run was cancelled; false when the
	 * id is unknown or the run already finished.
	 */
	cancelRlmChildRun(childId: string, reason = "Cancelled by user"): boolean {
		const run = this._activeRlmChildRuns.get(childId);
		if (run) {
			return this._cancelRlmChildRun(run, reason);
		}
		for (const candidate of this._activeRlmChildRuns.values()) {
			if (candidate.session?.cancelRlmChildRun(childId, reason)) {
				return true;
			}
		}
		// A finished, retained child can still have a running nested subagent.
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
		deliverTerminalMessages = true,
		thinkingLevel?: ThinkingLevel,
		onMeaningfulProgress?: (progressDigest: string) => void,
		workflowTaskDeadlineAt?: string,
		workflowTaskBinding?: WorkflowTaskBindingData,
		allowedToolNames?: readonly string[],
	): Promise<RlmSpawnHandle> {
		const workflowTaskDeadlineAtMs =
			workflowTaskDeadlineAt === undefined ? undefined : Date.parse(workflowTaskDeadlineAt);
		if (workflowTaskDeadlineAtMs !== undefined && !Number.isFinite(workflowTaskDeadlineAtMs))
			throw new Error("workflow_task_deadline_invalid");
		if (workflowTaskDeadlineAtMs !== undefined && Date.now() >= workflowTaskDeadlineAtMs)
			throw new Error("workflow_task_deadline_expired");
		const workflowTaskDeadlineDelayMs =
			workflowTaskDeadlineAtMs === undefined ? undefined : workflowTaskDeadlineAtMs - Date.now();
		const { name: rawName, model: rawModel, ...unsupported } = kwargs;
		const unsupportedKwargs = Object.keys(unsupported);
		if (unsupportedKwargs.length > 0) {
			throw new Error(`Unsupported rlm.run kwargs: ${unsupportedKwargs.sort().join(", ")}`);
		}
		const requestedSessionName = normalizeRequestedRlmSubagentSessionName(rawName);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel);
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
		if (this._disposed || this._disposing) throw new Error("Cannot spawn a subagent after its parent was disposed");

		const childSessionDir = this._createChildRlmSessionDir();
		const childNodeId = basename(childSessionDir);
		const sessionName = requestedSessionName ?? createDefaultRlmSubagentSessionName(prompt, childNodeId);
		if (!requestedSessionName) await this._assertRlmSubagentSessionNameAvailable(sessionName);
		const startedAt = Date.now();
		const parentAssistantForUsage = this._findLastAssistantMessage();
		const label = rlmChildLabel(prompt);
		let answerPreview: string | undefined;
		let durationMs: number | undefined;
		let toolUseCount = 0;
		let runningToolCount = 0;
		let activity: RlmChildAgentActivity | undefined;
		let childSession: AgentSession | undefined;
		let workflowDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const run: RlmChildRun = {
			id: childNodeId,
			prompt,
			sessionName,
			sessionDir: childSessionDir,
			status: "queued",
			settled: false,
			abort: noopRlmChildAbort,
			publication: createAgentMessageDeferred(),
			completion: createRlmChildCompletionDeferred(),
		};
		const reportMeaningfulProgress = (kind: string, value: unknown): void => {
			onMeaningfulProgress?.(digestObject({ workflowWorkerId: childNodeId, kind, value }));
		};
		this._rlmChildCompletionPromises.set(run.id, run.completion.promise);
		const throwIfCancelled = () => {
			if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
		};
		this._activeRlmChildRuns.set(run.id, run);
		const terminalWorkflowFencePending = (): boolean =>
			workflowTaskBinding !== undefined &&
			run.terminalFence !== undefined &&
			run.terminalFenceSettled !== true &&
			(run.status === "done" || run.status === "error" || run.status === "cancelled");
		const emitChildUpdate = () => {
			if (terminalWorkflowFencePending()) {
				// Child end events can arrive after abort; wait for the durable exact-kernel
				// fence before exposing any terminal workflow snapshot.
				return;
			}
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
			if (workflowTaskBinding !== undefined) {
				child._bindWorkflowTask(workflowTaskBinding, () => {
					const activeRun = this._activeRlmChildRuns.get(run.id);
					return activeRun === run && (run.status === "queued" || run.status === "running");
				});
			}
			// A stage's declared capabilities become a real restriction here. Without this the
			// child inherits the parent's full tool set and any "read-only" or "diffs only"
			// role is advisory prose the worker may ignore.
			if (allowedToolNames !== undefined) child.setActiveToolsByName([...allowedToolNames]);
			child._releaseDeferredIpythonPrewarm();
			if (workflowTaskDeadlineDelayMs !== undefined && workflowDeadlineTimer === undefined) {
				child._workflowTaskDeadlineMonotonicAtMs = performance.now() + workflowTaskDeadlineDelayMs;
				child._workflowTaskDeadlineAbort = () => {
					this._cancelRlmChildRun(run, "task_deadline_expired");
				};
				workflowDeadlineTimer = setTimeout(
					child._workflowTaskDeadlineAbort,
					Math.max(0, workflowTaskDeadlineDelayMs),
				);
				workflowDeadlineTimer.unref();
			}
			run.publication.resolve();
		};
		const subagentOptions: CreateRlmSubagentRuntimeOptions = {
			...this._createRlmSubagentRuntimeOptions({
				id: childNodeId,
				prompt,
				sessionName,
				spawnCode,
				sessionDir: childSessionDir,
				model: modelSelection.model,
				thinkingLevel,
			}),
			onSessionPublished: publishChildSession,
		};

		const deliverTerminalMessageToParent = async (message: CustomMessage): Promise<void> => {
			const childController = childSession?._agentMessageController;
			if (childController && this._subagentRuntimeHost) {
				try {
					await childController.sendAgentMessage({
						target: this.sessionId,
						message: message.content as string,
					});
					return;
				} catch {
					// An unattributed notice beats silence, so fall through to the injected path.
				}
			}
			await this._promptInjectedMessage(message.content as string, message, {
				streamingBehavior: "followUp",
				queueIfBusy: true,
				returnAfterAccepted: true,
				suppressAutonomousContinuation: true,
			}).catch(() => undefined);
		};

		// Runtime startup and the task run are deliberately detached. The public
		// spawn resolves at admission, while this task owns live tracking, usage,
		// retention, cancellation, and late-startup cleanup.
		void (async () => {
			let childRuntime: RlmSubagentRuntime | undefined;
			try {
				childRuntime = await this._createRlmSubagentRuntime(subagentOptions);
				const child = childRuntime.session;
				if (run.status === "cancelled") throw new Error(run.error ?? "RLM child cancelled");
				if (child.sessionName !== sessionName) child.setSessionName(sessionName);
				publishChildSession(child);
				throwIfCancelled();
				run.status = "running";
				emitChildUpdate();
				reportMeaningfulProgress("child_running", { sessionName });
				const unsubscribeChildEvents = child.subscribe((event) => {
					if (event.type === "rlm_child_update") {
						if (
							terminalWorkflowFencePending() &&
							(event.child.status === "done" ||
								event.child.status === "error" ||
								event.child.status === "cancelled")
						) {
							return;
						}
						this._emit(event);
						return;
					}
					if (event.type === "agent_start") {
						activity = { kind: "waiting" };
						reportMeaningfulProgress("agent_start", { messageCount: child.messages.length });
						emitChildUpdate();
					} else if (event.type === "agent_end") {
						activity = undefined;
						emitChildUpdate();
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						const assistant = event.message as AssistantMessage;
						run.retryable = this._isRetryableError(assistant);
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
						reportMeaningfulProgress("assistant_end", {
							stopReason: assistant.stopReason,
							text,
							usage: assistant.usage,
						});
						void flushAgentTraceUpload(child.sessionManager).catch(() => undefined);
						emitChildUpdate();
					} else if (event.type === "message_start" || event.type === "message_update") {
						if (event.message.role === "assistant") {
							const text = compactRlmText(readAssistantText(event.message as AssistantMessage));
							if (text) {
								answerPreview = text;
								reportMeaningfulProgress("assistant_delta", { text });
							}
							activity = { kind: "writing" };
							emitChildUpdate();
						}
					} else if (event.type === "tool_execution_start") {
						toolUseCount += 1;
						runningToolCount += 1;
						activity = { kind: "executing", toolName: event.toolName };
						reportMeaningfulProgress("tool_start", {
							toolCallId: event.toolCallId,
							toolName: event.toolName,
						});
						emitChildUpdate();
					} else if (event.type === "tool_execution_update") {
						reportMeaningfulProgress("tool_update", {
							toolCallId: event.toolCallId,
							partialResult: event.partialResult,
						});
					} else if (event.type === "tool_execution_end") {
						runningToolCount = Math.max(0, runningToolCount - 1);
						if (runningToolCount === 0) activity = { kind: "waiting" };
						reportMeaningfulProgress("tool_end", {
							toolCallId: event.toolCallId,
							isError: event.isError,
						});
						emitChildUpdate();
					} else if (event.type === "session_info_changed" || event.type === "recap_update") {
						emitChildUpdate();
					}
				});
				run.unsubscribe = unsubscribeChildEvents;
				const content = `[task from parent]\n\n${prompt}`;
				const spawnPayload: AgentSessionMessagePayload = {
					id: `spawn:${run.id}`,
					source: AGENT_MESSAGE_SOURCE,
					message: prompt,
					from: {
						sessionId: this.sessionId,
						sessionName: this.sessionName,
						activeSessionId: await this._currentActiveSessionId(),
					},
					fromRelationship: "parent",
					target: {
						sessionId: child.sessionId,
						sessionName,
						activeSessionId: (await child._currentActiveSessionId()) ?? child.sessionId,
						runtimeKind: "subagent",
					},
				};
				const spawnMessage: AgentSessionMessage = {
					role: "custom",
					customType: AGENT_MESSAGE_CUSTOM_TYPE,
					content,
					display: true,
					details: {
						id: spawnPayload.id,
						message: spawnPayload.message,
						from: spawnPayload.from,
						fromRelationship: spawnPayload.fromRelationship,
						target: spawnPayload.target,
					},
					timestamp: Date.now(),
				};
				throwIfCancelled();
				await child._agentMessageObligationBridge?.accept({ payload: spawnPayload, lane: "steering" });
				const parentReplyCountBeforeRun = child._parentReplyCount;
				await child.promptAndWait(content, {
					expandPromptTemplates: false,
					source: "extension",
					customMessage: spawnMessage,
				});
				if (run.error) throw new Error(run.error);
				durationMs = Date.now() - startedAt;
				activity = undefined;
				if (workflowTaskBinding !== undefined) {
					run.status = "done";
					await this._beginRlmChildTerminalFence(run);
					child._recordWorkflowTaskTerminal("completed");
					emitChildUpdate();
				} else {
					await child._fenceTerminalTaskKernel();
				}
				if (
					deliverTerminalMessages &&
					!run.detachedDeletion &&
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
				if (workflowTaskBinding === undefined) {
					run.status = "done";
					emitChildUpdate();
				}
				if (!this.registerRlmChildSession(run.id, child)) {
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
				if (childSession?._workflowTaskBinding !== undefined) {
					try {
						await this._beginRlmChildTerminalFence(run);
					} catch (fenceError) {
						throw this._markRlmChildTerminalFenceFailure(run, fenceError);
					}
					childSession._recordWorkflowTaskTerminal(
						run.status === "cancelled" && run.error === "task_deadline_expired"
							? "deadline"
							: run.status === "cancelled"
								? "cancelled"
								: "error",
						run.error,
					);
				}
				durationMs = Date.now() - startedAt;
				activity = undefined;
				if (run.status !== "cancelled") emitChildUpdate();
				if (deliverTerminalMessages && !run.detachedDeletion) {
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
				if (workflowDeadlineTimer !== undefined) clearTimeout(workflowDeadlineTimer);
				if (childSession !== undefined) {
					if (
						childSession._workflowTaskBinding !== undefined &&
						childSession._workflowTaskTerminal === undefined &&
						run.terminalFenceSettled === true
					) {
						childSession._recordWorkflowTaskTerminal(
							run.status === "done"
								? "completed"
								: run.status === "cancelled" && run.error === "task_deadline_expired"
									? "deadline"
									: run.status === "cancelled"
										? "cancelled"
										: "error",
							run.error,
						);
					}
				}
				run.completion.resolve({
					status: run.status === "done" ? "completed" : run.status === "cancelled" ? "cancelled" : "error",
					output: childSession?.getLastAssistantText() ?? answerPreview ?? "",
					error: run.error ?? null,
					retryable: run.retryable ?? false,
				});
				if (run.detachedDeletion && childRuntime) {
					try {
						await this._deleteRlmSubagentSession(run.id, childRuntime.session);
					} catch {
						if (!this._disposed && !this._disposing) {
							this._rlmChildSessions.set(run.id, childRuntime.session);
							this._rlmChildCleanupFailures.set(run.id, run.detachedDeletion);
						}
					}
				}
				if (this._activeRlmChildRuns.get(run.id) === run) {
					if (this._rlmChildSessions.has(run.id)) {
						this._activeRlmChildRuns.delete(run.id);
						if (run.unsubscribe) this._rlmChildUnsubscribes.set(run.id, run.unsubscribe);
						run.abort = noopRlmChildAbort;
						run.unsubscribe = undefined;
						run.session = undefined;
					} else if (run.status !== "error" || run.detachedDeletion) {
						this._removeRlmSubagentTracking(run.id, run);
					} else {
						run.unsubscribe?.();
						run.abort = noopRlmChildAbort;
						run.unsubscribe = undefined;
					}
				}
				run.settled = true;
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
		if (this._workflowOwnsGoalState() || this._workflowTaskBinding !== undefined) {
			throw new Error(
				"workflow workers require a scheduler-issued task attempt; direct child launch is not authorized",
			);
		}
		return this._startRlmChildRun(prompt, kwargs, spawnCode);
	}

	/**
	 * Start a workflow-owned child whose terminal state is surfaced by the durable scheduler.
	 *
	 * Args:
	 * prompt: Stage task sent to the child.
	 * sessionName: Scheduler-bound child session name.
	 * model: Authenticated worker model reference; production defaults to Luna.
	 * Return: Admitted child handle used to bind the durable attempt.
	 */
	async runWorkflowRlmChild(
		prompt: string,
		sessionName: string,
		model: string = DEFAULT_PRIME_WORKER_MODEL,
		launchContext?: AgentSessionWorkflowWorkerLaunchContext,
		onMeaningfulProgress?: (progressDigest: string) => void,
		allowedToolNames?: readonly string[],
	): Promise<RlmSpawnHandle> {
		if (launchContext === undefined)
			throw new Error("CONTRACT_CHANGE: workflow worker launch context is required for model admission");
		const bindings = this._workflowHost as WorkflowKernelHostBindings | undefined;
		const admitWorkerModel: WorkerModelCapabilityLaunchAuthorizer | undefined = bindings?.admitWorkerModel;
		if (admitWorkerModel === undefined)
			throw new Error("CONTRACT_CHANGE: workflow_worker_model_dispatch admission binding is unavailable");
		if (typeof launchContext.capsuleDigest !== "string" || launchContext.capsuleDigest.length === 0)
			throw new Error("workflow_worker_task_capsule_required");
		const admission: WorkerModelCapabilityLaunchAdmission = await admitWorkerModel({
			...launchContext,
			prompt,
			sessionName,
			selector: model,
			provider: workerModelProvider(model),
			model: workerModelId(model),
			reasoning: WORKER_MODEL_REASONING,
			allowFallback: false,
		});
		const parsedIntent = parseWorkerModelCapabilityAdmission(admission.intent);
		if (parsedIntent === undefined)
			throw new Error("CONTRACT_CHANGE: worker admission failed sealed receipt and digest validation");
		const expectedBinding: WorkerModelChildModelBinding = parsedIntent.childModel;
		if (
			parsedIntent.workflowId !== launchContext.workflowId ||
			parsedIntent.taskId !== launchContext.taskId ||
			parsedIntent.attemptId !== launchContext.attemptId ||
			parsedIntent.executionKey !== launchContext.executionKey ||
			parsedIntent.epochRef.storeEpoch !== launchContext.epochRef.storeEpoch ||
			parsedIntent.epochRef.coordinatorEpoch !== launchContext.epochRef.coordinatorEpoch ||
			expectedBinding.provider !== WORKER_MODEL_PROVIDER ||
			expectedBinding.model !== WORKER_MODEL_ID ||
			expectedBinding.reasoning !== WORKER_MODEL_REASONING ||
			expectedBinding.allowFallback !== false
		)
			throw new Error("CONTRACT_CHANGE: worker admission is not bound to the scheduler task attempt");
		const handshake = await admission.handshake(expectedBinding);
		if (handshake.status !== "accepted") throw new Error(`blocked_model_capability: ${handshake.quarantine.reason}`);
		const workflowStatus = this._workflowHost?.status();
		if (
			workflowStatus?.workflowId !== launchContext.workflowId ||
			workflowStatus.stateDigest === null ||
			workflowStatus.stateDigest !== parsedIntent.stateDigest
		)
			throw new Error("CONTRACT_CHANGE: worker admission is not bound to the current workflow head");
		const workflowTaskBinding: WorkflowTaskBindingData = {
			schemaVersion: 1,
			kind: "workflow_task_binding",
			workflowId: launchContext.workflowId,
			taskId: launchContext.taskId,
			attemptId: launchContext.attemptId,
			executionKey: launchContext.executionKey,
			epochRef: launchContext.epochRef,
			deadlineAt: launchContext.deadlineAt,
			capsuleDigest: launchContext.capsuleDigest,
		};
		const handle = await this._startRlmChildRun(
			prompt,
			{ name: sessionName, model },
			undefined,
			false,
			"max",
			onMeaningfulProgress,
			launchContext.deadlineAt,
			workflowTaskBinding,
			allowedToolNames,
		);
		if (handle.model !== model) {
			this.cancelRlmChildRun(handle.rlm_child_id, "worker model handshake mismatch");
			throw new Error("blocked_model_capability: spawned worker model differs from the admitted selector");
		}
		return handle;
	}

	async awaitRlmChildCompletion(childId: string): Promise<RlmChildCompletionResult> {
		const completion = this._rlmChildCompletionPromises.get(childId);
		if (completion === undefined) throw new Error(`Unknown RLM child ${childId}`);
		return completion;
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	private _resourceExhaustionDetails(message: AssistantMessage): Record<string, unknown> | undefined {
		const details = this._getProviderStreamFailureDetails(message);
		return this._getProviderStreamFailureKind(message) === "resource_exhausted" ? details : undefined;
	}

	private _isResourceExhaustedFailure(message: AssistantMessage): boolean {
		return this._resourceExhaustionDetails(message) !== undefined;
	}

	private _resourceAuthorizationRevision(provider: string): string {
		const token = this._modelRegistry.getCurrentProviderAuthSourceToken(provider);
		return token?.identityFingerprint ?? `provider:${provider}:unresolved`;
	}

	private _advanceResourceCapacityRevision(): void {
		const current = Number(this._resourceCapacityRevision.slice("epoch:".length));
		this._resourceCapacityRevision = `epoch:${Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1}`;
		const blocker = this.sessionManager.getLatestResourceExhaustedBlocker();
		if (blocker) this._scheduleSessionInputPump();
	}

	private _resourceExhaustedBlockerFromAssistant(message: AssistantMessage): ResourceExhaustedBlocker | undefined {
		const details = this._resourceExhaustionDetails(message);
		if (!details) return undefined;
		const resetAt = typeof details.resetAt === "number" ? details.resetAt : undefined;
		const resetInSeconds = typeof details.resetInSeconds === "number" ? details.resetInSeconds : undefined;
		const observedResetAt =
			resetAt === undefined && resetInSeconds !== undefined
				? Math.floor(Date.now() / 1000) + Math.max(0, Math.round(resetInSeconds))
				: resetAt;
		const creditsUnavailable = details.creditsUnavailable;
		return {
			kind: "resource_exhausted",
			provider: message.provider,
			model: message.model,
			...(typeof details.limitClass === "string" ? { limitClass: details.limitClass } : {}),
			...(observedResetAt !== undefined ? { resetAt: observedResetAt } : {}),
			...(resetInSeconds !== undefined ? { resetInSeconds } : {}),
			creditsAvailability:
				creditsUnavailable === true ? "unavailable" : creditsUnavailable === false ? "available" : "unknown",
			authorizationRevision: this._resourceAuthorizationRevision(message.provider),
			capacityRevision: this._resourceCapacityRevision,
		};
	}

	private _resourceProbeReady(entry: ResourceExhaustedBlockerEntryData): boolean {
		if (entry.state === "probe_leased") {
			const blocker = this._resourceBlockerFromEntry(entry);
			const model = this.model;
			const currentHead = this.sessionManager.getLeafId();
			const leaseEntryId = this.sessionManager.getLatestResourceExhaustedBlockerEntryId();
			return (
				entry.blockerDigest === this._resourceBlockerDigest(blocker) &&
				entry.blockerDigest !== undefined &&
				entry.probeLeaseId !== undefined &&
				entry.probeLeasedAt !== undefined &&
				entry.probeLeaseWallTimeMs !== undefined &&
				entry.probeLeaseMonotonicTimeMs !== undefined &&
				entry.probeLeaseActionId !== undefined &&
				entry.probeLeaseHeadId !== undefined &&
				entry.probeLeaseExpiresAt !== undefined &&
				entry.probeLeaseExpiresAt >= entry.probeLeasedAt &&
				leaseEntryId === currentHead &&
				model !== undefined &&
				entry.probeLeaseProvider === model.provider &&
				entry.probeLeaseModel === model.id &&
				entry.probeLeaseAuthorizationRevision === this._resourceAuthorizationRevision(model.provider) &&
				entry.probeLeaseCapacityRevision === this._resourceCapacityRevision
			);
		}
		const model = this.model;
		if (!model) return false;
		const capacityChanged = entry.capacityRevision !== this._resourceCapacityRevision;
		// A restored/configured model mismatch is not an authorization to switch
		// capacity. An explicit model transition advances the durable epoch first.
		if (capacityChanged) return true;
		if (model.provider !== entry.provider || model.id !== entry.model) return false;
		if (this._resourceAuthorizationRevision(entry.provider) !== entry.authorizationRevision) return true;
		return entry.resetAt !== undefined && Math.floor(Date.now() / 1000) >= entry.resetAt;
	}

	private _resourceBlockerDigest(blocker: ResourceExhaustedBlocker): string {
		return digestObject({
			kind: blocker.kind,
			provider: blocker.provider,
			model: blocker.model,
			limitClass: blocker.limitClass,
			resetAt: blocker.resetAt,
			resetInSeconds: blocker.resetInSeconds,
			creditsAvailability: blocker.creditsAvailability,
			authorizationRevision: blocker.authorizationRevision,
			capacityRevision: blocker.capacityRevision,
		});
	}

	private _resourceBlockerFromEntry(entry: ResourceExhaustedBlockerEntryData): ResourceExhaustedBlocker {
		return {
			kind: "resource_exhausted",
			provider: entry.provider,
			model: entry.model,
			...(entry.limitClass ? { limitClass: entry.limitClass } : {}),
			...(entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {}),
			...(entry.resetInSeconds !== undefined ? { resetInSeconds: entry.resetInSeconds } : {}),
			creditsAvailability: entry.creditsAvailability,
			authorizationRevision: entry.authorizationRevision,
			capacityRevision: entry.capacityRevision,
		};
	}

	private _reconcileResourceExhaustionProbeLease(entry: ResourceExhaustedBlockerEntryData): boolean {
		if (entry.state !== "probe_leased" || entry.probeLeaseHeadId === undefined) return false;
		const branch = this.sessionManager.getBranch();
		const leaseIndex = branch.findIndex((candidate) => candidate.id === entry.probeLeaseHeadId);
		if (leaseIndex < 0) return false;
		for (const candidate of branch.slice(leaseIndex + 1)) {
			if (candidate.type !== "message" || candidate.message.role !== "assistant") continue;
			const assistant = candidate.message as AssistantMessage;
			if (this._isResourceExhaustedFailure(assistant)) {
				this._recordResourceExhaustedBlocker(assistant);
				return true;
			}
			if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
				this._clearResourceExhaustedBlockerAfterProbe(assistant);
				return true;
			}
		}
		return false;
	}

	private _admitResourceExhaustionProbeIfReady(): boolean {
		let entry = this.sessionManager.getLatestResourceExhaustedBlockerEntry();
		if (!entry || entry.state === "cleared") return false;
		if (entry.state === "probe_leased") {
			if (this._reconcileResourceExhaustionProbeLease(entry)) {
				entry = this.sessionManager.getLatestResourceExhaustedBlockerEntry();
				if (!entry || entry.state === "cleared") return false;
			}
			if (entry.state !== "probe_leased") return this._admitResourceExhaustionProbeIfReady();
			if (entry.probeLeaseExpiresAt !== undefined && Date.now() >= entry.probeLeaseExpiresAt) {
				this.sessionManager.appendResourceExhaustedBlocker({
					kind: "resource_exhausted",
					provider: entry.provider,
					model: entry.model,
					...(entry.limitClass ? { limitClass: entry.limitClass } : {}),
					...(entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {}),
					...(entry.resetInSeconds !== undefined ? { resetInSeconds: entry.resetInSeconds } : {}),
					creditsAvailability: entry.creditsAvailability,
					authorizationRevision: entry.authorizationRevision,
					capacityRevision: entry.capacityRevision,
				});
				return this._admitResourceExhaustionProbeIfReady();
			}
			const action = this._actionStore.queuedActions()[0] ?? this._actionStore.activeActions()[0];
			if (!action || action.id !== entry.probeLeaseActionId) return false;
			if (!this._resourceProbeReady(entry)) {
				this.sessionManager.appendResourceExhaustedBlocker({
					kind: "resource_exhausted",
					provider: entry.provider,
					model: entry.model,
					...(entry.limitClass ? { limitClass: entry.limitClass } : {}),
					...(entry.resetAt !== undefined ? { resetAt: entry.resetAt } : {}),
					...(entry.resetInSeconds !== undefined ? { resetInSeconds: entry.resetInSeconds } : {}),
					creditsAvailability: entry.creditsAvailability,
					authorizationRevision: entry.authorizationRevision,
					capacityRevision: entry.capacityRevision,
				});
				return this._admitResourceExhaustionProbeIfReady();
			}
			return true;
		}
		if (!this._resourceProbeReady(entry)) return false;
		const blocker = this._resourceBlockerFromEntry(entry);
		const action = this._actionStore.queuedActions()[0] ?? this._actionStore.activeActions()[0];
		if (!action) return false;
		const headId = this.sessionManager.getLeafId();
		if (!headId) return false;
		const wallTimeMs = Date.now();
		const model = this.model;
		if (!model) return false;
		const lease = {
			blockerDigest: this._resourceBlockerDigest(blocker),
			probeLeaseId: randomUUID(),
			probeLeasedAt: wallTimeMs,
			probeLeaseExpiresAt: wallTimeMs + 60_000,
			probeLeaseWallTimeMs: wallTimeMs,
			probeLeaseMonotonicTimeMs: performance.now(),
			probeLeaseProvider: model.provider,
			probeLeaseModel: model.id,
			probeLeaseAuthorizationRevision: this._resourceAuthorizationRevision(model.provider),
			probeLeaseCapacityRevision: this._resourceCapacityRevision,
			probeLeaseActionId: action.id,
			probeLeaseHeadId: headId,
		};
		this.sessionManager.appendResourceExhaustedProbeLease(blocker, lease);
		return true;
	}

	private _recordResourceExhaustedBlocker(message: AssistantMessage): void {
		const blocker = this._resourceExhaustedBlockerFromAssistant(message);
		if (!blocker) return;
		const current = this.sessionManager.getLatestResourceExhaustedBlockerEntry();
		if (
			current?.state === "blocked" &&
			current.provider === blocker.provider &&
			current.model === blocker.model &&
			current.limitClass === blocker.limitClass &&
			current.resetAt === blocker.resetAt &&
			current.resetInSeconds === blocker.resetInSeconds &&
			current.creditsAvailability === blocker.creditsAvailability &&
			current.authorizationRevision === blocker.authorizationRevision &&
			current.capacityRevision === blocker.capacityRevision
		) {
			return;
		}
		this.sessionManager.appendResourceExhaustedBlocker(blocker);
		this._scheduleResourceExhaustionProbeWake(blocker);
	}

	private _clearResourceExhaustedBlockerAfterProbe(message: AssistantMessage): void {
		if (message.stopReason === "error") return;
		const current = this.sessionManager.getLatestResourceExhaustedBlockerEntry();
		if (current?.state !== "probe_leased") return;
		this.sessionManager.appendResourceExhaustedBlockerCleared({
			kind: "resource_exhausted",
			provider: current.provider,
			model: current.model,
			...(current.limitClass ? { limitClass: current.limitClass } : {}),
			...(current.resetAt !== undefined ? { resetAt: current.resetAt } : {}),
			...(current.resetInSeconds !== undefined ? { resetInSeconds: current.resetInSeconds } : {}),
			creditsAvailability: current.creditsAvailability,
			authorizationRevision: current.authorizationRevision,
			capacityRevision: current.capacityRevision,
		});
		if (this._resourceProbeWakeTimer !== undefined) {
			clearTimeout(this._resourceProbeWakeTimer);
			this._resourceProbeWakeTimer = undefined;
		}
	}

	private _scheduleResourceExhaustionProbeWake(blocker: ResourceExhaustedBlocker): void {
		if (this._resourceProbeWakeTimer !== undefined) clearTimeout(this._resourceProbeWakeTimer);
		if (blocker.resetAt === undefined || this._disposed || this._disposing) return;
		const delay = Math.max(0, blocker.resetAt * 1000 - Date.now());
		this._resourceProbeWakeTimer = setTimeout(
			() => {
				this._resourceProbeWakeTimer = undefined;
				const current = this.sessionManager.getLatestResourceExhaustedBlocker();
				if (current && current.resetAt !== undefined && Math.floor(Date.now() / 1000) < current.resetAt) {
					this._scheduleResourceExhaustionProbeWake(current);
					return;
				}
				this._scheduleSessionInputPump();
			},
			Math.min(delay, 2_147_483_647),
		);
	}

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		if (message.stopReason !== "error" || !message.errorMessage) return false;

		// Context overflow is handled by compaction, not retry
		const contextWindow = this.model?.contextWindow ?? 0;
		if (isContextOverflow(message, contextWindow)) return false;

		if (this._isFauxProviderQueueExhausted(message)) {
			return false;
		}

		if (this._isAgentLifecycleFailure(message)) {
			return false;
		}

		if (this._isResourceExhaustedFailure(message)) {
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

	/**
	 * Handle retryable errors with exponential backoff.
	 * @returns true if retry was initiated, false if max retries exceeded or disabled
	 */
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

		// Retry promise is created synchronously in _handleAgentEvent for agent_end.
		// Keep a defensive fallback here in case a future refactor bypasses that path.
		if (!this._retryPromise) {
			this._retryPromise = new Promise((resolve) => {
				this._retryResolve = resolve;
			});
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			this._markProviderAuthStaleForRetryFailure(message, options);
			// Max retries exceeded, emit final failure and reset
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

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
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

		// Retry via continue() - use setTimeout to break out of event handler chain
		setTimeout(() => {
			if (this._workflowTaskAdmissionBlockReason() !== undefined) return;
			this.agent.continue().catch(() => {
				// Retry failed - will be caught by next agent_end
			});
		}, 0);

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
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

	/**
	 * Wait for any in-progress retry to complete.
	 * Returns immediately if no retry is in progress.
	 */
	private async waitForRetry(): Promise<void> {
		if (!this._retryPromise) {
			return;
		}

		await this._retryPromise;
		await this.agent.waitForIdle();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryPromise !== undefined;
	}

	/** Whether an accepted prompt is still running or waiting for retry completion. */
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

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

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
		},
	): Promise<BashResult> {
		this._bashAbortController = new AbortController();

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

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

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
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
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
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

	/** Whether a bash command is currently running */
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
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/** Current RLM max-depth value and the source that supplied it. */
	getRlmMaxDepthStatus(): RlmMaxDepthStatus {
		return { maxDepth: this._rlmMaxDepth, source: this._rlmMaxDepthSource };
	}

	/** Persist and immediately apply a per-chat RLM max-depth override. */
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

	/** Set a display name for the current session. */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		this._emit({
			type: "session_info_changed",
			name: this.sessionManager.getSessionName(),
		});
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

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
		// Model required for summarization
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

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
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

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();
		let resolveBranchSummaryOperation: () => void = () => {};
		const branchSummaryOperation = new Promise<void>((resolve) => {
			resolveBranchSummaryOperation = resolve;
		});
		this._branchSummaryOperation = branchSummaryOperation;

		try {
			let extensionSummary: { summary: string; details?: unknown } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
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

				// Allow extensions to override instructions and label
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

			// Run default summarizer if needed
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

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = this._extractUserMessageText(targetEntry.message.content);
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText =
					typeof targetEntry.content === "string"
						? targetEntry.content
						: targetEntry.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}

			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			this._mergeUnpersistedCompactionOutcomes(this.agent.state.messages);
			this._restoreLateIpythonSentAgentMessages();
			this._reloadGoalStateFromBranch();
			this._reloadRlmMaxDepthFromBranch();
			this._invalidateQueuedPromptPreparation();

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
			if (this._branchSummaryOperation === branchSummaryOperation) {
				this._branchSummaryOperation = undefined;
			}
			resolveBranchSummaryOperation();
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
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

	/**
	 * Get session statistics.
	 */
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

	/** RLM session dir holding sub-* child sessions, without creating directories. */
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

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
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

	// =========================================================================
	// Utilities
	// =========================================================================

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

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
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
