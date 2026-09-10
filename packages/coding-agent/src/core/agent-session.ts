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
	TextContent,
	Usage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	modelsAreEqual,
	resetApiProviders,
	supportsFastMode,
} from "@earendil-works/pi-ai";
import { parseGoalSlashCommand } from "../goals/commands.js";
import { GoalController } from "../goals/controller.js";
import { createGoalPersistence } from "../goals/persistence.js";
import { theme } from "../modes/interactive/theme/theme.js";
import {
	type ExecuteBashOptions,
	type RunUserBashOptions,
	SessionBash,
	type SessionBashEvent,
} from "../session/bash.js";
import { SessionCommitFence, type SessionCommitLease } from "../session/commit-fence.js";
import { SessionCompaction, type SessionCompactionEvent } from "../session/compaction.js";
import {
	type CompactionExecutionHost,
	type CompactionExecutionOptions,
	CompactionSkippedError,
	performSessionCompaction,
} from "../session/compaction-execution.js";
import { type ContinuationToken, SessionContinuation } from "../session/continuation.js";
import { SessionInputDispatcher } from "../session/input-dispatcher.js";
import { SessionInputScheduler } from "../session/input-scheduler.js";
import {
	buildPromptContent,
	cloneCustomMessage,
	cloneQueuedAgentMessage,
	createDeliveryRecord,
	createPreparedTurnAction,
	createSessionCommandAction,
	DeferredSessionInputError,
	normalizeMessageContent,
	type PreparedCommandPayload,
	type PreparedPromptPreparation,
	type PreparedTurnPayload,
	primaryDeliveryRecord,
	type QueuedAgentMessage,
	type QueuedSessionAction,
	queuedAgentMessagePreview,
	type RestoredPromptInput,
	SESSION_ACTION_RECOVERY_FORMAT_VERSION,
	type SessionActionRecoverySnapshot,
	SessionInputAdmissionPausedError,
	type SessionInputSchedule,
	visibleSessionActionProjection,
} from "../session/prepared-actions.js";
import { type AutoRefineReviewer, SessionRefinement } from "../session/refinement.js";
import { SessionRetry, type SessionRetryEvent } from "../session/retry.js";
import { createTurnExecutionPolicy, type TurnExecutionPolicy, TurnPreparer } from "../session/turn-preparation.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { waitForPromiseOrAbort } from "../utils/wait-for-abort.js";
import {
	AGENT_MESSAGE_CUSTOM_TYPE,
	AGENT_MESSAGE_SKILL_NAME,
	type AgentFamilyCatalogEntry,
	type AgentSessionMessage,
	type AgentSessionMessageAgentSummary,
	type AgentSessionMessageController,
	type AgentSessionMessageListResult,
	type AgentSessionMessageReceipt,
	agentFamilyMemberName,
	assertAgentMessageQueueCapacity,
	assertAgentSessionNameAvailable,
	assertDirectAgentMessageTarget,
	createAgentMessageHostHandlers,
	DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
	formatAgentSessionNameUnavailable,
	isAgentSessionMessage,
	isAgentSessionMessagePrompt,
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
import {
	addLoginGuidanceToAuthError,
	formatAuthenticationFailedMessage,
	formatNoApiKeyFoundMessage,
	formatNoModelSelectedMessage,
	isLikelyAuthenticationError,
} from "./auth-guidance.js";
import {
	type AgentAutonomousConfig,
	type AgentAutonomousStatus,
	type AutonomousRuntimeState,
	addAutonomousContinuation,
	addAutonomousUsage,
	autonomousStatus,
	createAutonomousRuntimeState,
	isUnlimitedAutonomousLimit,
	nextAutonomousContinuation,
	refreshAutonomousQualityGates,
	setAutonomousEnabled,
	setAutonomousLimits,
	UNLIMITED_AUTONOMOUS_LIMIT,
} from "./autonomous.js";
import type { BashResult } from "./bash-executor.js";
import {
	COMPACT_SKILL_NAME,
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
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
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_CONTEXT_PREVIEW_LABEL,
	GOAL_SKILL_NAME,
	type GoalHostResponse,
	type GoalState,
	goalHostResponse,
	validateGoalBudget,
	validateGoalObjective,
} from "./goals.js";
import type { HostRequestHandlers, KernelSentAgentMessage } from "./kernel/index.js";
import { type RestoreResult, snapshotPathIn } from "./kernel/state-snapshot.js";
import type { AcpMcpServerConfig } from "./mcp/acp-mcp-types.js";
import type { McpManager } from "./mcp/mcp-manager.js";
import {
	ASYNC_BASH_COMPLETION_CUSTOM_TYPE,
	ASYNC_BASH_COMPLETION_PREVIEW_LABEL,
	type AsyncBashCompletionDetails,
	type CustomMessage,
	createAsyncBashCompletionMessage,
	createHarnessDigestMessage,
	createHeartbeatPromptMessage,
	createRlmChildFailureMessage,
	createRlmChildTerminalNoticeMessage,
	createSessionSlashCommandMessage,
	createSessionSlashCommandResultMessage,
	HARNESS_DIGEST_CUSTOM_TYPE,
	type HarnessDigestDetails,
	HEARTBEAT_PROMPT_CUSTOM_TYPE,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	IPYTHON_STATE_RESTORED_CUSTOM_TYPE,
	isSessionSlashCommandMessage,
	type RefinementSource,
	RLM_CHILD_FAILURE_CUSTOM_TYPE,
	RLM_CHILD_TERMINAL_NOTICE_CUSTOM_TYPE,
} from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { throwIfPromptAdmissionCancelled } from "./prompt-admission.js";
import { expandPromptTemplate, type PromptTemplate, parseCommandArgs } from "./prompt-templates.js";
import { providerRetryPolicy } from "./provider-retry.js";
import {
	formatHarnessStateForPrompt,
	getGlobalHarnessStateDir,
	getLocalHarnessStateDir,
	REFINE_SKILL_NAME,
	type RefinementResult,
} from "./refinement/index.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import {
	type CreateRlmSubagentRuntimeOptions,
	createAsyncBashCompletionHostHandler,
	createAsyncBashConsumedHostHandler,
	createDefaultRlmSubagentSessionName,
	createRlmCreateSessionHostHandler,
	createRlmDeleteSubagentHostHandler,
	createRlmFindModelsHostHandler,
	createRlmListSubagentsHostHandler,
	createRlmRunHostHandler,
	findRlmModelMatches,
	normalizeRequestedRlmSubagentModel,
	normalizeRequestedRlmSubagentSessionName,
	normalizeRequestedRlmSubagentThinkingLevel,
	type RlmCreateSessionResult,
	type RlmDeleteSubagentResult,
	type RlmFindModelsResult,
	type RlmListSubagentsResult,
	type RlmSpawnHandle,
	type RlmSubagentRegistryEntry,
	type RlmSubagentRuntime,
	type SubagentRuntimeHost,
} from "./rlm-runtime.js";
import { SemanticEdgeRecorder, semanticEdgeLedgerPath, wrapStreamFnWithSemanticEdges } from "./semantic-edges.js";
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
	transitionSessionAction,
} from "./session-action-store.js";
import type {
	BranchSummaryEntry,
	ChildUsageAttributionEntry,
	SessionContext,
	SessionEntry,
	SessionMessageEntry,
} from "./session-manager.js";
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
import { acpMcpToolNames, createAcpMcpToolDefinitions } from "./tools/acp-mcp.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { IpythonKernelProvisioner } from "./tools/ipython.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";
import {
	addAssistantUsage,
	cloneUsage,
	emptyUsage,
	type SessionUsageSummary,
	sessionUsageSummaryFrom,
	subtractAssistantUsage,
} from "./usage.js";
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

export type { CompactionReason } from "../session/compaction.js";

export type AgentSessionEvent =
	| AgentEvent
	| {
			type: "ipython_sent_agent_message";
			toolCallId: string;
			message: KernelSentAgentMessage;
	  }
	| { type: "session_action_update"; actions: SessionActionSnapshot }
	| SessionCompactionEvent
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "service_tier_changed"; serviceTier: ServiceTier }
	| SessionRetryEvent
	| { type: "rlm_child_update"; child: RlmChildAgentSnapshot }
	| { type: "recap_update"; recap: string | undefined }
	| { type: "goal_update"; goal: GoalState }
	| SessionBashEvent
	| { type: "refine_complete"; result: RefinementResult }
	| { type: "refine_failed"; error: string };

export {
	SESSION_ACTION_RECOVERY_FORMAT_VERSION,
	type SessionActionRecoveryAction,
	type SessionActionRecoveryPayload,
	type SessionActionRecoveryRecord,
	type SessionActionRecoverySnapshot,
} from "../session/prepared-actions.js";

export type { TurnExecutionPolicy } from "../session/turn-preparation.js";

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export { CompactionSkippedError } from "../session/compaction-execution.js";

export { RefineSkippedError } from "../session/refinement.js";

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
	 * goal skill in the Python kernel, its goal.* host handlers, and /goal.
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
	semanticParentSessionId?: string;
	semanticSpawnedByRequestId?: string;
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
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	commandContextActions?: ExtensionCommandContextActions;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

export type {
	AutoRefineReviewer,
	AutoRefineReviewRequest,
	SerializedBackgroundPlanResult,
} from "../session/refinement.js";
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
		case ASYNC_BASH_COMPLETION_CUSTOM_TYPE:
			return ASYNC_BASH_COMPLETION_PREVIEW_LABEL;
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

type AutonomousSlashCommand = { kind: "status" } | { kind: "on"; config?: AgentAutonomousConfig } | { kind: "off" };

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
	durationMs?: number;
	answerPreview?: string;
	toolUseCount: number;
	activity?: RlmChildAgentActivity;
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
	deletionFailureNotice?: Promise<void>;
	deletionNeedsCompletionNotice?: boolean;
	completeDeletion?: () => Promise<void>;
	reportDeletionCleanupFailure?: (error: unknown) => Promise<void>;
	emitUpdate?: () => void;
	lastEmittedUpdate?: string;
	unsubscribe?: () => void;
}

interface RetainedRlmChild {
	session: AgentSession;
	run?: RlmChildRun;
}

interface RlmSubagentModelSelection {
	model: Model<Api>;
}

const KERNEL_STATE_LISTING_TIMEOUT_MS = 5000;
const RLM_MAX_DEPTH_STATE_CUSTOM_TYPE = "rlm_max_depth_state";

function noopRlmChildAbort(): void {}
function noopRlmChildEventUnsubscribe(): void {}

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

const AUTONOMOUS_STATUS_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

const AUTONOMOUS_BUDGET_USAGE =
	"Usage: /autonomous [status|off] or /autonomous on [--max-continuations <n|unlimited>] [--max-turns <n|unlimited>] [--max-tokens <n|unlimited>] [--timeout-ms <n|unlimited>] [--gate <command>] [--gate-retries <n>] [--gate-timeout-ms <n>]";

// `/autonomous` budget flags mirror the `--autonomous-*` CLI options. The CLI
// spelling (`--autonomous-max-continuations`) is accepted as an alias so the
// exact CLI budget flags also work from the slash command.
const AUTONOMOUS_BUDGET_FLAGS: ReadonlySet<string> = new Set([
	"max-continuations",
	"max-turns",
	"max-tokens",
	"timeout-ms",
	"gate",
	"gate-retries",
	"gate-timeout-ms",
]);

function parseAutonomousBudgetInt(flag: string, value: string, allowUnlimited = false): number {
	if (allowUnlimited && value.toLowerCase() === "unlimited") {
		return UNLIMITED_AUTONOMOUS_LIMIT;
	}
	// Commas and underscores are accepted as digit separators (100,000,000).
	const digits = value.replace(/[,_]/g, "");
	if (!/^[1-9]\d*$/.test(digits)) {
		throw new Error(
			`--${flag} must be a positive integer${allowUnlimited ? ' or "unlimited"' : ""}. ${AUTONOMOUS_BUDGET_USAGE}`,
		);
	}
	return Number(digits);
}

function parseAutonomousBudgetOptions(tokens: string[]): AgentAutonomousConfig {
	const config: AgentAutonomousConfig = {};
	const gateCommands: string[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i]!;
		if (!token.startsWith("--")) {
			throw new Error(`Unexpected autonomous argument: ${token}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		const equalsIndex = token.indexOf("=");
		const rawFlag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
		const inlineValue = equalsIndex === -1 ? undefined : token.slice(equalsIndex + 1);
		const flag = rawFlag.startsWith("--autonomous-") ? rawFlag.slice("--autonomous-".length) : rawFlag.slice(2);
		if (!AUTONOMOUS_BUDGET_FLAGS.has(flag)) {
			throw new Error(`Unknown autonomous budget flag: ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		let value = inlineValue;
		if (value === undefined) {
			const next = tokens[i + 1];
			if (next === undefined || next.startsWith("--")) {
				throw new Error(`Missing value for ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			value = next;
			i++;
		}
		if (value === "") {
			throw new Error(`Missing value for ${rawFlag}. ${AUTONOMOUS_BUDGET_USAGE}`);
		}
		switch (flag) {
			case "gate":
				gateCommands.push(value);
				break;
			case "gate-retries":
				config.gates = config.gates ?? {};
				config.gates.maxRetries = parseAutonomousBudgetInt(flag, value);
				break;
			case "gate-timeout-ms":
				config.gates = config.gates ?? {};
				config.gates.timeoutMs = parseAutonomousBudgetInt(flag, value);
				break;
			case "max-continuations":
				config.maxContinuations = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "max-turns":
				config.maxTurns = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "max-tokens":
				config.maxTokens = parseAutonomousBudgetInt(flag, value, true);
				break;
			case "timeout-ms":
				config.timeoutMs = parseAutonomousBudgetInt(flag, value, true);
				break;
		}
	}
	if (gateCommands.length > 0) {
		config.gates = { ...config.gates, commands: gateCommands };
	}
	// Named budget flags define the whole budget: any limit the user did not
	// name stops cutting the run short. With no budget flags at all, the
	// configured or default limits still apply.
	if (
		config.maxContinuations !== undefined ||
		config.maxTurns !== undefined ||
		config.maxTokens !== undefined ||
		config.timeoutMs !== undefined
	) {
		config.maxContinuations ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.maxTurns ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.maxTokens ??= UNLIMITED_AUTONOMOUS_LIMIT;
		config.timeoutMs ??= UNLIMITED_AUTONOMOUS_LIMIT;
	}
	return config;
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

// Bounds how much accumulated child usage a parent process crash can lose.
const RLM_CHILD_USAGE_FLUSH_MAX_PENDING_MS = 60_000;

/** Label a child completion's usage by the nearest preceding prompt that triggered it. */
function rlmChildUsageOrigin(
	messages: readonly AgentMessage[],
	assistant: AssistantMessage,
): ChildUsageAttributionEntry["origin"] {
	for (let index = messages.lastIndexOf(assistant) - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "user" && message.role !== "custom") continue;
		return message.role === "custom" && isAgentSessionMessage(message)
			? message.details.id.startsWith("spawn:")
				? "spawn_task"
				: "agent_message"
			: "direct_user";
	}
	return "direct_user";
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
	private readonly _refinement: SessionRefinement;
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
	private readonly _inputScheduler = new SessionInputScheduler({
		canSchedule: () => !this._disposed && !this._disposing && this._hasSelectableSessionInput(),
		run: (epoch) => this._inputDispatcher.run(epoch),
	});
	private readonly _inputDispatcher = new SessionInputDispatcher(this._actionStore, {
		isDisposed: () => this._disposed || this._disposing,
		getEpoch: () => this._inputScheduler.epoch,
		getActivity: () => this._runtimeActivity(),
		isBusy: () => this._isBusyForSessionInput("pump"),
		isHandoffDeferred: (epoch) => this._isSessionInputHandoffDeferred(epoch),
		getDeliveryMode: (delivery) => (delivery === "next_turn_boundary" ? this.steeringMode : this.followUpMode),
		waitForAgentIdle: () => this.agent.waitForIdle(),
		hasCancelledDispatchCapture: () => this._hasCancelledDispatchCapture(),
		getEventQueue: () => this._agentEventQueue,
		waitForRefinement: () => this._refinement._waitForRefineIdle(),
		getTranscript: () => this.agent.state.messages,
		startTurns: (actions, epoch) => this._startPreparedTurnActions(actions, epoch),
		executeCommand: (action, epoch) => this._executeSelectedSessionCommand(action, epoch),
		settleAgentMessage: (id, leg, error) => this._settleAgentMessage(id, leg, error),
		releaseTurn: (id) => {
			this._durableRlmTerminalNoticeActionIds.delete(id);
		},
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		surfaceError: (error) => this._surfaceSessionInputError(error),
		schedule: () => this._scheduleSessionInputPump(),
	});
	private _sessionInputArrivalEpoch = 0;
	private readonly _durableRlmTerminalNoticeActionIds = new Set<string>();
	private readonly _commitFence = new SessionCommitFence();
	private readonly _turnPreparer = new TurnPreparer({
		hasRefinement: () => this._refinement.isApplying,
		waitForRefinement: () => this._refinement._waitForRefineIdle(),
		flushPendingBash: () => this._flushPendingBashMessages(),
		validate: () => this._validateCanStartAgentRun(),
		compact: () => this._runPreTurnCompaction(),
		pendingModelSelection: () => this._pendingModelSelectEmit(),
	});
	// Checkpoint, handoff, and activity waiters share lifecycle-edge notifications to avoid polling.
	private readonly _sessionInputCheckpointWaiters = new Set<() => void>();
	private _pendingNextTurnMessages: CustomMessage[] = [];

	private readonly _goals: GoalController;
	private _goalContinuationAwaitsRlmWork = false;
	private _goalAbortInProgress = false;
	private _autonomousState: AutonomousRuntimeState;
	private _autonomousContinuationSuppressionDepth = 0;
	private _autonomousContinuationSuppressedMessages = new WeakSet<AgentMessage>();

	private readonly _compaction = new SessionCompaction({
		getModel: () => this.model,
		isStreaming: () => this.isStreaming,
		getSettings: () => this.settingsManager.getCompactionSettings(),
		runAutomatic: (reason, willRetry) => this._runAutoCompaction(reason, willRetry),
		queueGoalContinuation: (message) => this._queueGoalContinuationForThresholdCompaction(message),
		queueAutonomousContinuation: (message) => this._queueAutonomousContinuationForThresholdCompaction(message),
		beginRefinementAbort: () => this._refinement.beginAbortedTurnCleanup(),
		getRequiredAuth: (model) => this._getRequiredRequestAuth(model),
		getAuth: (model) => this._modelRegistry.getApiKeyAndHeaders(model),
		perform: (options) => this._performCompaction(options),
		disconnect: () => this._disconnectFromAgent(),
		reconnect: () => this._reconnectToAgent(),
		abortSession: () => this.abort(),
		getContinuationState: () => ({
			scheduled: this._continuation.isScheduled,
			continueAfterSessionInput: this._continuation.current?.continueAfterSessionInput ?? false,
		}),
		afterManualCompaction: (signal, scheduled, continueAfterInput) =>
			this._afterManualCompaction(signal, scheduled, continueAfterInput),
		getMessages: () => this.agent.state.messages,
		replaceMessages: (messages) => {
			this.agent.state.messages = messages;
		},
		hasAgentQueuedMessages: () => this.agent.hasQueuedMessages(),
		hasPendingSessionWork: () => this.hasPendingSessionWork,
		scheduleContinuation: (continueAfterInput) => this._schedulePostCompactionContinue(continueAfterInput),
		scheduleRefinement: (willContinue) => this._refinement._scheduleAutoRefineAfterCompaction(willContinue),
		takeThresholdAutonomousMessages: () => this._pendingThresholdCompactionAutonomousMessages.splice(0),
		getThresholdGoalContinuation: () => this._queuedGoalThresholdContinuation,
		clearAutonomousContinuations: (shouldContinue, messages) =>
			this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(shouldContinue, messages),
		clearGoalContinuation: (message) => this._clearQueuedGoalContinuationAfterCancelledThresholdCompaction(message),
		getSessionStore: () => this.sessionManager,
		retainUnpersistedOutcome: (message) => {
			this._unpersistedOutcomes.push(message);
		},
		emit: (event) => this._emit(event),
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		scheduleInput: () => this._scheduleSessionInputPump(),
	});
	private readonly _compactionExecution: CompactionExecutionHost = {
		getSessionStore: () => this.sessionManager,
		getSettings: () => this.settingsManager.getCompactionSettings(),
		getSemanticEdges: () => this._semanticEdges,
		getExtensions: () => this._extensionRunner,
		getThinkingLevel: () => this.thinkingLevel,
		getRetryPolicy: () => providerRetryPolicy(this.settingsManager),
		getHarnessDigest: () => this._harnessDigest(),
		rebuildContext: () => {
			this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
			this._mergeUnpersistedOutcomes(this.agent.state.messages);
			this._restoreLateIpythonSentAgentMessages();
		},
		syncKernelState: () => this._syncKernelStateAfterCompaction(),
		reapDeletedChildren: () => this._reapDeletedRlmSubagentRuntimesAfterCompaction(),
	};

	private _branchSummaryAbortController: AbortController | undefined = undefined;
	private _branchSummaryOperation: Promise<void> | undefined = undefined;

	private readonly _retry = new SessionRetry({
		getRetrySettings: () => this.settingsManager.getRetrySettings(),
		getMaxRetryDelayMs: () => this.settingsManager.getProviderRetrySettings().maxRetryDelayMs,
		getContextWindow: () => this.model?.contextWindow ?? 0,
		getAuthSource: (provider) => this._modelRegistry.getCurrentProviderAuthSourceToken(provider),
		markAuthSourceStale: (token) => this._modelRegistry.markProviderAuthSourceStale(token),
		markAuthStale: (provider) => this._modelRegistry.markProviderAuthStale(provider),
		hasPayloadHooks: () => this._extensionRunner.hasHandlers("before_provider_request"),
		prepareTurnRetry: () => this._semanticEdges.prepareTurnRetry(),
		clearTurnRetry: () => this._semanticEdges.clearTurnRetry(),
		removeLastAssistant: () => {
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
		},
		continue: () => this.agent.continue(),
		waitForIdle: () => this.agent.waitForIdle(),
		cancelCompaction: () => {
			this._compaction.abortAutomatic();
			this._cancelPostCompactionContinue();
		},
		emit: (event) => this._emit(event),
		onResolved: () => {
			this._notifySessionInputCheckpointChange();
			this._scheduleSessionInputPump();
		},
	});
	private _agentMessageClearEpoch = 0;
	private _agentMessageOutcomes = new Map<string, AgentMessageOutcome>();
	private _lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	/** Outcome disclosures whose session-file append failed; retained for context rebuilds. */
	private readonly _unpersistedOutcomes: CustomMessage[] = [];
	/** Fresh/empty contexts defer digest injection to the first committed turn so untouched sessions stay empty. */
	private _harnessDigestPending = false;

	private readonly _bash = new SessionBash({
		getCwd: () => this.sessionManager.getCwd(),
		getShellCommandPrefix: () => this.settingsManager.getShellCommandPrefix(),
		getShellPath: () => this.settingsManager.getShellPath(),
		isStreaming: () => this.isStreaming,
		intercept: (event) => this._extensionRunner.emitUserBash(event),
		emit: (event) => this._emit(event),
		appendMessage: (message) => {
			this.agent.state.messages.push(message);
			this.sessionManager.appendMessage(message);
		},
		onStateChange: () => this._notifySessionInputCheckpointChange(),
		onUserBashEnd: () => this._drainQueuedMessagesAfterBash(),
		executeBash: (command, onChunk, options) => this.executeBash(command, onChunk, options),
		recordBashResult: (command, result, options) => this.recordBashResult(command, result, options),
	});

	private _extensionRunner!: ExtensionRunner;
	private _execEnvProvider?: () => Record<string, string | undefined> | undefined;
	private _turnIndex = 0;
	private _modelSelectEmitQueue: Promise<void> = Promise.resolve();
	private _modelSelectEmitQueueIdle = true;
	private _modelSelectEmitContext = new AsyncLocalStorage<boolean>();

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _acpMcpTools: ToolDefinition[] = [];
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
	private readonly _semanticEdges: SemanticEdgeRecorder;
	private _rlmParentNodeId?: string;
	private _rlmParentAgent?: string;
	private _repliedToParentSinceTask: boolean | undefined;
	private _parentReplyCount = 0;
	private _subagentRuntimeHost?: SubagentRuntimeHost;
	// Shared by children charged to the same assistant; excludes usage not yet attributed on disk.
	private _rlmDurableParentUsage = new WeakMap<AssistantMessage, Usage>();
	// Child usage not yet represented by an indexed attribution, including a delayed parent entry.
	private _rlmUnindexedChildUsage = new WeakMap<AssistantMessage, Usage>();
	private _activeRlmChildRuns = new Map<string, RlmChildRun>();
	private _unsettledRlmChildRuns = new Set<RlmChildRun>();
	private _abandonedRlmQuiescenceChildIds = new Set<string>();
	private _rlmQuiescenceWaitAborts = new Set<AbortController>();
	private _pendingRlmSubagentSessionNames = new Set<string>();
	// Inline mode keeps finished child sessions so the inspector can still read them;
	// the daemon does the same by leaving the child session resident in its registry.
	private _rlmChildSessions = new Map<string, RetainedRlmChild>();
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
	private readonly _continuation = new SessionContinuation({
		waitForAgentIdle: () => this.agent.waitForIdle(),
		waitForRetry: () => this.waitForRetry(),
		waitForRefinement: () => this._refinement._waitForRefineIdle(),
		queuedWorkPauseCount: () => this._inputScheduler.queuedWorkPauseCount,
		addCheckpointWaiter: (waiter) => {
			this._sessionInputCheckpointWaiters.add(waiter);
		},
		removeCheckpointWaiter: (waiter) => {
			this._sessionInputCheckpointWaiters.delete(waiter);
		},
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		compactionOperation: () => this._compaction.operation,
		isRefinementApplying: () => this._refinement.isApplying,
		acquireCommitFence: () => this._acquireSessionActionCommitFence(),
		scheduleRefinement: () => this._refinement._scheduleAutoRefineAfterAgentEnd(),
		unfinishedActionCount: () => this.unfinishedActionCount,
		isInputRequested: () => this._inputScheduler.requested,
		scheduleInput: () => this._scheduleSessionInputPump(),
		continue: () => this.agent.continue(),
		waitForIdleOrSettlement: (token) => this._waitForIdleOrSettlement(token),
		removeQueuedMessages: (predicate) => this.agent.removeQueuedMessages(predicate),
		followUp: (message) => this.agent.followUp(message),
		onMessageConsumed: (message) => {
			this._queuedAutonomousContinuationSnapshots.delete(message);
		},
	});
	private _queuedAutonomousThresholdContinuations = new WeakMap<AssistantMessage, AgentMessage>();
	private _queuedAutonomousContinuationSnapshots = new WeakMap<AgentMessage, AutonomousRuntimeSnapshot>();
	private _pendingThresholdCompactionAutonomousMessages: AgentMessage[] = [];
	private _queuedGoalThresholdContinuation: AgentMessage | undefined;

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._refinement = new SessionRefinement(
			{
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				getRetryPolicy: () => providerRetryPolicy(this.settingsManager),
				isDisposed: () => this._disposed,
				isDisposing: () => this._disposing,
				isStreaming: () => this.isStreaming,
				isCompacting: () => this.isCompacting,
				getDepth: () => this._rlmDepth,
				getRlmSessionDir: () => this._rlmSessionDir,
				getModel: () => this.model,
				getThinkingLevel: () => this.thinkingLevel,
				getMessages: () => this.agent.state.messages,
				getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
				getExtensionRunner: () => this._extensionRunner,
				getEventQueue: () => this._agentEventQueue,
				getCompactionOperation: () => this._compaction.operation,
				getBranchSummaryOperation: () => this._branchSummaryOperation,
				waitForAgentIdle: () => this.agent.waitForIdle(),
				disconnect: () => this._disconnectFromAgent(),
				reconnect: () => this._reconnectToAgent(),
				emit: (event) => this._emit(event),
				retainUnpersistedOutcome: (message) => this._unpersistedOutcomes.push(message),
				notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
				scheduleInputPump: () => this._scheduleSessionInputPump(),
				isContinuationScheduled: () => this._continuation.isScheduled,
				cancelContinuation: () => this._cancelPostCompactionContinue(),
			},
			config,
		);
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
		this._prewarmIpythonKernel = (config.prewarmIpythonKernel ?? false) && this._rlmDepth === 0;

		this._rlmSessionDir = config.rlmSessionDir;
		this._rlmParentNodeId = config.rlmParentNodeId;
		this._rlmParentAgent = config.rlmParentAgent;
		this._semanticEdges = new SemanticEdgeRecorder({
			ledgerPath: semanticEdgeLedgerPath({
				rlmSessionDir: this._rlmSessionDir,
				sessionArtifactDir: this.sessionManager.getSessionArtifactDir(),
			}),
			sessionId: this.sessionManager.getSessionId(),
			parentSessionId: config.semanticParentSessionId,
			spawnedByRequestId: config.semanticSpawnedByRequestId,
		});
		this.agent.streamFn = wrapStreamFnWithSemanticEdges(this.agent.streamFn, this._semanticEdges);
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
		const goalPersistence = createGoalPersistence(this.sessionManager);
		this._goals = new GoalController(goalPersistence, (goal) => this._emit({ type: "goal_update", goal }));
		// Seed initial goal from CLI --goal flag, but only for top-level sessions
		// and only when the branch contains only bootstrap entry types (model_change,
		// thinking_level_change, service_tier_change) and no persisted
		// thread_goal_state. This prevents reseeding after clear/complete/error
		// or restart/rehydration of a session that already has messages or a goal.
		if (this._rlmDepth === 0 && config.initialGoal && goalPersistence.canSeed()) {
			this._startGoal(config.initialGoal.objective, config.initialGoal.tokenBudget);
			// Goal context is the model's only source of goal visibility; action
			// admission is unavailable mid-construction, so ride the next turn.
			this._pendingNextTurnMessages.push(createGoalContextMessage(this._goals.state, "continuation"));
		}
		this._restoreLateIpythonSentAgentMessages();
		this._goals.restartAccounting();

		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installAgentTurnHook();
		this._installAgentContinuationHook();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
		this._ensureHarnessDigestContext();
	}

	/** Refreshes MCP provider registrations without rebuilding the session runtime. */
	refreshMcpProviders(): void {
		this._mcpManager?.refresh();
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
		if (servers.length > 0 && !this._ipythonKernelProvisioner) {
			throw new Error("ACP MCP servers require the built-in cpython tool");
		}
		this._assertAcpMcpToolNamesAvailable(acpMcpToolNames(servers));
		if (!this._mcpManager.replaceAcpServers(servers, ownerId)) return;
		this._rebuildRuntimeForAcpMcpServers();
	}

	async releaseAcpMcpServers(ownerId: string, serverNames: readonly string[]): Promise<void> {
		if (!this._mcpManager?.canReleaseAcpServers(ownerId)) return;
		if (this._mcpManager.replaceAcpServers([], ownerId)) {
			const removedToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
			const activeToolNames = this.getActiveToolNames().filter((name) => !removedToolNames.has(name));
			for (const name of removedToolNames) this._allowedToolNames?.delete(name);
			this._acpMcpTools = [];
			this._refreshToolRegistry({ activeToolNames, includeAllExtensionTools: true });
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

	private _assertAcpMcpToolNamesAvailable(names: readonly string[]): void {
		const occupiedNames = new Set([
			...this._baseToolDefinitions.keys(),
			...this._customTools.map((tool) => tool.name),
			...this._extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name),
		]);
		for (const name of names) {
			if (occupiedNames.has(name)) {
				throw new Error(`ACP MCP tool name conflicts with an existing tool: ${name}`);
			}
		}
	}

	private _rebuildRuntimeForAcpMcpServers(): void {
		const previousToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
		const nextToolNames = acpMcpToolNames(this._mcpManager?.getAcpServers() ?? []);
		this._assertAcpMcpToolNamesAvailable(nextToolNames);
		const activeToolNames = this.getActiveToolNames().filter((name) => !previousToolNames.has(name));
		activeToolNames.push(...nextToolNames);
		this._buildRuntime({
			activeToolNames,
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
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			await this._agentEventQueue;

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
							record.message.customType !== HARNESS_DIGEST_CUSTOM_TYPE &&
							!record.durable,
					)
					.map((record) => cloneCustomMessage(record.message));
				restorableMessages.push(...restorable);
				// Lazy injection owns digest delivery: a cancelled turn re-arms it
				// instead of restoring a possibly stale digest message.
				if (
					payload.records.some(
						(record) =>
							record.message.role === "custom" && record.message.customType === HARNESS_DIGEST_CUSTOM_TYPE,
					)
				) {
					this._harnessDigestPending = true;
				}
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
		this._goalContinuationAwaitsRlmWork = false;
		return this._goals.start(objective, budget);
	}

	private _clearGoal(): void {
		this._clearQueuedGoalContexts();
		this._goals.clear();
	}

	private _pauseGoal(): void {
		this._clearQueuedGoalContexts();
		this._goals.pause();
	}

	private async _resumeGoal(): Promise<void> {
		if (this._goals.resume()) {
			await this._runOrQueueGoalContext("continuation");
		}
	}

	private _finishGoalForTerminalAssistantMessage(message: AssistantMessage): void {
		if (this._goals.state.status !== "active") {
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
			this._goals.fail(message.errorMessage || "Assistant response failed");
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

	private _parseAutonomousSlashCommand(text: string): AutonomousSlashCommand | undefined {
		const command = parseSessionSlashCommand(text);
		if (command?.name !== "autonomous") return undefined;
		const tokens = parseCommandArgs(command.args);
		if (tokens.length === 0 || tokens[0]!.toLowerCase() === "status") {
			if (tokens.length > 1) {
				throw new Error(`Unexpected autonomous argument: ${tokens[1]}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			return { kind: "status" };
		}
		const subcommand = tokens[0]!.toLowerCase();
		if (subcommand === "on" || subcommand === "enable" || subcommand === "enabled") {
			return { kind: "on", config: parseAutonomousBudgetOptions(tokens.slice(1)) };
		}
		if (subcommand === "off" || subcommand === "disable" || subcommand === "disabled") {
			if (tokens.length > 1) {
				throw new Error(`Unexpected autonomous argument: ${tokens[1]}. ${AUTONOMOUS_BUDGET_USAGE}`);
			}
			return { kind: "off" };
		}
		throw new Error(AUTONOMOUS_BUDGET_USAGE);
	}

	private _formatAutonomousStatus(): string {
		const status = this.getAutonomousStatus();
		const state = status.enabled ? "on" : "off";
		const elapsedSeconds = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
		const gateSummary =
			status.gates.commands.length > 0 ? status.gates.commands.map((command) => `"${command}"`).join(", ") : "none";
		const formatCount = (value: number): string =>
			isUnlimitedAutonomousLimit(value) ? "unlimited" : AUTONOMOUS_STATUS_NUMBER_FORMAT.format(value);
		const timeBudget = isUnlimitedAutonomousLimit(status.limits.timeoutMs)
			? "unlimited"
			: `${AUTONOMOUS_STATUS_NUMBER_FORMAT.format(Math.round(status.limits.timeoutMs / 1000))}s`;
		return `[autonomous-status: ${state}]\n\nContinuations: ${formatCount(status.continuationsUsed)}/${formatCount(status.limits.maxContinuations)}. Turns: ${formatCount(status.turnsUsed)}/${formatCount(status.limits.maxTurns)}. Tokens: ${formatCount(status.tokensUsed)}/${formatCount(status.limits.maxTokens)}. Time: ${elapsedSeconds}s/${timeBudget}. Gates: ${gateSummary}.`;
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
			setAutonomousLimits(this._autonomousState, command.config);
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
	 * Goals are pursued through the kernel goal skill, so the only tool the
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
		if (this._goals.state.status !== "active" || !this._goals.state.objective) {
			this._goalContinuationAwaitsRlmWork = false;
			return;
		}
		// Keep the deferral while admission is paused or the pump is suspended
		// (post-abort); the pause release and resumeQueuedWork retry.
		if (this._inputScheduler.admissionPaused || this._inputScheduler.suspended) return;
		const goalBeforeResume = this._goals.checkpoint();
		try {
			this._ensureGoalRuntimeActive();
			this._goals.recordContinuation();
			const message = createGoalContextMessage(this._goals.state, "continuation");
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
			this._goals.restore(goalBeforeResume, { restoreClock: false });
		}
	}

	private _runOrQueueGoalContext(kind: "continuation" | "objective_updated", images?: ImageContent[]): void {
		if (!this._goals.state.objective) return;
		this._ensureGoalRuntimeActive();
		const message = createGoalContextMessage(this._goals.state, kind, images);
		const normalized = normalizeMessageContent(message.content);
		const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
			message,
			resumeIfIdle: true,
		});
		this._admitSessionInput(action, { front: true, wake: false });
	}

	private async _handleGoalSlashCommand(text: string, images: ImageContent[] | undefined): Promise<boolean> {
		const command = parseGoalSlashCommand(text);
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

		const previousWasActive = this._goals.state.status === "active";
		if (!this.isStreaming) {
			await this._validateCanStartAgentRun();
		}
		this._ensureGoalRuntimeActive();
		this._clearQueuedGoalContexts();
		this._startGoal(command.objective, command.tokenBudget);
		await this._runOrQueueGoalContext(previousWasActive ? "objective_updated" : "continuation", images);
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

	private _shouldStopBeforeTurn(): boolean {
		return this._steeringStopPending;
	}

	private async _shouldStopAfterTurn(context: ShouldStopAfterTurnContext): Promise<boolean> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return true;
		}
		try {
			if (this._goals.accountAssistantMessage(context.message)) {
				const message = createGoalContextMessage(this._goals.state, "budget_limit");
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
		if (this._refinement.serialized) {
			// Ensure the preceding message_end processing (counter increment,
			// background plan kickoff) has completed before the checkpoint.
			await this._agentEventQueue;
			await this._refinement._runSerializedRefineCheckpoint();
		}
		if (await this._shouldStopForThresholdCompaction(context)) {
			return true;
		}
		// Steering stops continuation only after mandatory serialized checkpoints.
		// Returning true here still prevents the agent loop from starting another turn.
		return this._steeringStopPending;
	}

	private async _shouldStopForThresholdCompaction(context: ShouldStopAfterTurnContext): Promise<boolean> {
		this._compaction.resetContinuation();
		if (!this._compaction.hasPendingRequest && !(await this._thresholdCompactionNeeded(context))) {
			return false;
		}

		const lastMessage = this.agent.state.messages[this.agent.state.messages.length - 1];
		// A queued continuation disproves the assistant-last "task finished" heuristic, so preserve a true set above.
		if (lastMessage !== undefined && lastMessage.role !== "assistant") this._compaction.requestContinuation();
		return true;
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

		const contextTokens = this._compaction.getThresholdContextTokens(context.message, compactionTimestamp);
		if (contextTokens === undefined || !shouldCompact(contextTokens, contextWindow, settings)) {
			return false;
		}

		// Goal continuation takes exclusive priority over autonomous continuation, matching _getContinuationMessages.
		if (this._queueGoalContinuationForThresholdCompaction(context.message)) {
			this._compaction.requestContinuation();
		} else if (await this._queueAutonomousContinuationForThresholdCompaction(context.message)) {
			this._compaction.requestContinuation();
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
		if (queuedMessage && this._continuation.messages.includes(queuedMessage)) {
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
		this._continuation.track(autonomousMessage);
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
		if (this._goals.state.status !== "active" || !this._goals.state.objective) {
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
			this._goals.recordContinuation();
			const goalMessage = createGoalContextMessage(this._goals.state, "continuation");
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
		this._goals.cancelContinuation();
		this._emitQueueUpdate();
	}

	private _clearQueuedAutonomousContinuations(
		options: { restoreAutonomousState?: boolean; messages?: AgentMessage[] } = {},
	): void {
		const requestedMessages = options.messages ?? [...this._continuation.messages];
		const requestedMessageSet = new Set(requestedMessages);
		const queuedMessages = this._continuation.messages.filter((message) => requestedMessageSet.has(message));
		if (queuedMessages.length === 0) {
			return;
		}
		const queuedMessageSet = new Set(queuedMessages);
		this._continuation.remove(queuedMessageSet);
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
			this._compaction.resetContinuation();
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
	 * Handle a goal.* request from the Python kernel host bridge (the bundled
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
					scheduled: this._compaction.hasPendingRequest,
				};
			}
			case "compact.run": {
				const instructions = payload.instructions;
				if (instructions !== undefined && typeof instructions !== "string") {
					throw new Error("compact.run instructions must be a string when provided");
				}
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
				this._compaction.request(instructions);
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
		return this._refinement.handleRefineHostRequest(type, payload);
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
	): Promise<AgentSessionMessageReceipt> {
		if (!this._agentMessageController) {
			throw new Error("agent messaging is not available in this session");
		}
		switch (type) {
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
		switch (this._goals.state.status) {
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
		// Accounting precedes the completing ipython cell, so its budget-limit
		// context may already be queued and must be withdrawn before completion.
		return this._goals.complete(() => this._clearQueuedGoalContexts());
	}

	private async _getGoalContinuationMessages(
		context: GetContinuationMessagesContext,
		signal?: AbortSignal,
	): Promise<AgentMessage[]> {
		if (this._stopGoalContinuationForTerminalMessage(context.message)) {
			return [];
		}
		if (signal?.aborted || this._goals.state.status !== "active" || !this._goals.state.objective) {
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
			this._goals.recordContinuation();
			return [createGoalContextMessage(this._goals.state, "continuation")];
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			try {
				this._goals.fail(message);
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
			return [];
		}
		const arrivalEpoch = this._sessionInputArrivalEpoch;
		const goalSnapshot = this._goals.checkpoint();
		const goalMessages = await this._getGoalContinuationMessages(context, signal);
		if (goalMessages.length > 0 || signal?.aborted) {
			if (goalMessages.length > 0 && this._sessionInputArrivalEpoch !== arrivalEpoch) {
				this._goals.restore(goalSnapshot);
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
		this._retry.observeAgentEnd(event);
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
				this._retry.resolve();
			}
		}

		if (event.type === "message_start" && startsAgentRun(event.message)) {
			this._compaction.resetOverflowRecovery();
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
				if (assistantMsg.stopReason !== "error") {
					addAutonomousUsage(this._autonomousState, assistantMsg.usage);
				}
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "aborted") {
					this._refinement.observeAssistantEnd();
					// In serialized mode, kick off background refinement planning
					// immediately after the primary stream finishes, while tools
					// are still executing. The plan is awaited at shouldStopAfterTurn
					// before applying, so planning overlaps tools only — never another
					// model request.
				}
				if (assistantMsg.stopReason !== "error") {
					this._compaction.resetOverflowRecovery();
				}
				this._retry.observeAssistantEnd(assistantMsg);
				if (this._goals.accountAssistantMessage(assistantMsg)) {
					const message = createGoalContextMessage(this._goals.state, "budget_limit");
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
				(this._retry.isRetrying ? this._findLastAssistantInMessages(event.messages) : undefined);
			this._lastAssistantMessage = undefined;
			if (!msg) {
				this._retry.resolve();
				return;
			}

			const retry = this._retry.retryError(msg);
			if (retry && (await retry)) return;

			const compactionWillRetry = await this._checkCompaction(msg);
			if (compactionWillRetry && this._retry.attempt > 0) {
				return;
			}
			this._retry.finishActiveRetryWithFailure(msg);
			this._retry.resolve();
			if (!compactionWillRetry) {
				this._finishGoalForTerminalAssistantMessage(msg);
				// In serialized mode, agent-callable refine.run is serviced
				// at the shouldStopAfterTurn boundary, not here at agent_end.
				if (!this._refinement.serialized) {
					const consumedRequestedRefine = this._refinement._consumePendingRequestedRefine();
					if (!consumedRequestedRefine) {
						this._refinement._scheduleAutoRefineAfterAgentEnd();
					}
				}
			}
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
	 * Async teardown for graceful quit/switch: await the Python kernel's dispose
	 * (which flushes a final namespace snapshot) before the synchronous dispose, so
	 * the latest state reaches disk instead of racing process exit.
	 */
	async disposeAsync(options?: { kernelSnapshot?: boolean }): Promise<void> {
		if (this._disposed) {
			return this._disposeCallbacksPromise;
		}
		// Concurrent callers await the same in-flight teardown so none resolves before
		// the kernel snapshot flush finishes.
		if (this._disposeAsyncPromise) {
			return this._disposeAsyncPromise;
		}
		const kernelSnapshot = options?.kernelSnapshot ?? true;
		this._disposeAsyncPromise = (async () => {
			// Drain before marking _disposing so a refine triggered at the final
			// agent_end completes instead of being aborted by dispose().
			await this._refinement._drainPendingRefinementForDisposal();
			if (this._disposed) {
				return this._disposeCallbacksPromise;
			}
			this._disposing = true;
			this._commitFence.dispose();
			await this._disposeAsyncOnce(kernelSnapshot);
		})();
		return this._disposeAsyncPromise;
	}

	private async _disposeAsyncOnce(kernelSnapshot: boolean): Promise<void> {
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
		for (const { session } of this._rlmChildSessions.values()) {
			await session.disposeAsync().catch(() => undefined);
		}
		this._rlmChildSessions.clear();
		this._rlmChildCleanupFailures.clear();
		this._deletedRlmChildIds.clear();
		try {
			await this._ipythonKernelProvisioner?.dispose({ snapshot: kernelSnapshot });
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
		this._commitFence.dispose();
		try {
			// Invalidate scheduled timers and abort any in-flight review so a late
			// resolution cannot write harness state or re-subscribe handlers.
			this._refinement.dispose();
			this._cancelActiveRlmChildRuns("Parent session disposed");
			for (const unsubscribe of this._rlmChildUnsubscribes.values()) {
				unsubscribe();
			}
			this._rlmChildUnsubscribes.clear();
			for (const { session } of this._rlmChildSessions.values()) {
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
		return this._retry.attempt;
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
		return this._compaction.isRunning || this._branchSummaryAbortController !== undefined;
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

	get semanticEdges(): SemanticEdgeRecorder {
		return this._semanticEdges;
	}

	get rlmMaxDepth(): number {
		return this._rlmMaxDepth;
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get goalState(): GoalState {
		return this._goals.current;
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
			genericMcpServers: this._mcpManager?.getEnabledPersistentGenericServers(),
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
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false, false);
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
			!this._inputScheduler.suspended &&
			this._inputScheduler.queuedWorkPauseCount === 0 &&
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
		const clearEpoch = this._agentMessageClearEpoch;
		const admissionCommitted = () => {
			options?.admissionCommitted?.();
			if (clearEpoch !== this._agentMessageClearEpoch) {
				throw new Error("Agent message was cleared before admission");
			}
		};
		if (
			this._inputScheduler.suspended &&
			this._isBusyForSessionInput("preflight") &&
			options?.queueIfBusy === true &&
			options.streamingBehavior
		) {
			admissionCommitted();
			const queued = await this.queueAgentMessagePrompt(text, options.streamingBehavior, customMessage);
			options.preflightResult?.(queued, queued);
			return;
		}
		await this._prompt(text, {
			...options,
			resumeIfIdle: false,
			expandPromptTemplates: false,
			skipInputHandlers: true,
			skipPrePromptWork: true,
			returnAfterAccepted: true,
			agentMessageId: options?.agentMessageId ?? customMessage?.details.id ?? parseAgentSessionMessagePromptId(text),
			customMessage,
			admissionCommitted,
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
		await this._promptInjectedMessage(message.content, message, {
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
			executionPolicy: createTurnExecutionPolicy("injected"),
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
			this._inputScheduler.admissionPaused ||
			this._inputScheduler.suspended ||
			this._inputScheduler.queuedWorkPauseCount > 0 ||
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
		const disposeSignal = this._commitFence.disposeSignal;
		while (!this._disposed && !this._disposing && !disposeSignal.aborted) {
			if (this._inputScheduler.queuedWorkPauseCount > 0) {
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
			if (this._inputScheduler.queuedWorkPauseCount === 0 && !this._disposed && !this._disposing) return fence;
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

	/**
	 * The kernel read the command's result before the notice reached the model, so
	 * the notice has nothing left to report: drop it while it is still queued.
	 * Delivered notices are no longer clearable, which makes this a no-op.
	 */
	private _withdrawAsyncBashCompletionNotice(details: { pid: number; command: string }): void {
		// One read withdraws one notice: pid reuse can queue an identical key twice,
		// and the read belongs to the older handle, which is the earlier notice.
		const notice = this._actionStore
			.clearableActions()
			.find((action) => this._isAsyncBashCompletionActionFor(action, details));
		if (!notice) return;
		this._cancelSessionActions(
			(action) => action === notice,
			new Error("Background command completion notice withdrawn: the kernel read the result first."),
		);
		this._emitQueueUpdate();
	}

	private _isAsyncBashCompletionActionFor(
		action: QueuedSessionAction,
		details: { pid: number; command: string },
	): boolean {
		if (action.payload.kind !== "turn") return false;
		const message = primaryDeliveryRecord(action).message;
		if (message.role !== "custom" || message.customType !== ASYNC_BASH_COMPLETION_CUSTOM_TYPE) return false;
		// pids are reused across handles, so the command has to match too.
		const completion = message.details as AsyncBashCompletionDetails | undefined;
		return completion?.pid === details.pid && completion.command === details.command;
	}

	private async _promptInjectedMessage(
		text: string,
		message: CustomMessage,
		options?: InternalPromptOptions & { executionPolicy?: TurnExecutionPolicy },
	): Promise<void> {
		if (!this.isStreaming && options?.resumeIfIdle) this._resumeSessionInputAdmission();
		const admissionEpoch = this._inputScheduler.epoch;
		const admissionFence = await this._acquireDirectTurnAdmissionFence(options?.signal).catch((error: unknown) => {
			throwIfPromptAdmissionCancelled(options?.signal);
			throw error;
		});
		const reportPreflight = oncePreflight(options?.preflightResult);
		try {
			throwIfPromptAdmissionCancelled(options?.signal);
			if (admissionEpoch !== this._inputScheduler.epoch) {
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
					(visibleQueued ? createTurnExecutionPolicy("queued") : createTurnExecutionPolicy("injected")),
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
		const admissionEpoch = this._inputScheduler.epoch;
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
				if (!resumeSuspendedInput && admissionEpoch !== this._inputScheduler.epoch) {
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
				// Async input handlers ran between the admission check above and
				// admission itself; re-check so content invalidated during that
				// await (e.g. a cron job cancelled or updated) is not admitted.
				if (normalizationResult instanceof Promise) options?.admissionCommitted?.();
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
					const action = createSessionCommandAction(
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
					: buildPromptContent(normalized.text, normalized.images);
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
						? createTurnExecutionPolicy("queued")
						: createTurnExecutionPolicy("directPrompt", {
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
		return commitFence ? this._commitFence.run(commitFence, run) : run();
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
			createSessionCommandAction(text, customMessage.details.command, images, schedule, {
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

	private _takePendingNextTurnMessages(): CustomMessage[] {
		const messages = this._pendingNextTurnMessages;
		this._pendingNextTurnMessages = [];
		return messages;
	}

	private _createPreparedTurnAction(...args: Parameters<typeof createPreparedTurnAction>): QueuedSessionAction {
		return createPreparedTurnAction(...args);
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
		if (this._inputScheduler.admissionPaused) {
			throw new SessionInputAdmissionPausedError(
				"Cannot admit a session action while session input admission is paused.",
			);
		}
		if (this._inputScheduler.suspended) {
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
		if (this._inputScheduler.admissionPaused) {
			throw new SessionInputAdmissionPausedError(
				"Cannot admit a session action while session input admission is paused.",
			);
		}
		if (
			options.restore !== true &&
			action.payload.kind === "turn" &&
			isAgentSessionMessage(primaryDeliveryRecord(action).message)
		) {
			assertAgentMessageQueueCapacity(
				this._actionStore.unfinishedActions().length,
				DEFAULT_AGENT_MESSAGE_MAX_PENDING_PER_SESSION,
			);
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
		} = {},
	): Promise<boolean> {
		const action = this._createPreparedTurnAction(schedule, text, images, options);
		if (action.suppressAutonomousContinuation) {
			this._markAutonomousContinuationSuppressed(primaryDeliveryRecord(action).message);
		}
		return this._admitSessionInput(action).accepted;
	}

	private _runtimeActivity(): RuntimeActivity {
		return {
			lowerAgentRun: this.isStreaming,
			compaction: this.isCompacting,
			retry: this.isRetrying,
			bash: this.isBashRunning,
			refinementApply: this._refinement.isApplying,
			branchMutation: this._branchSummaryOperation !== undefined,
			schedulerPauseCount: this._inputScheduler.queuedWorkPauseCount + (this._inputScheduler.suspended ? 1 : 0),
			disposing: this._disposed || this._disposing,
		};
	}

	private _hasSelectableSessionInput(): boolean {
		return this._inputDispatcher.hasSelectableInput();
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
		return this._commitFence.hasPendingWork || this._sessionInputCheckpointWaiters.size > 0;
	}

	private _scheduleSessionInputPump(): void {
		this._inputScheduler.schedule();
	}

	private async _executeSelectedSessionCommand(action: QueuedSessionAction, epoch: number): Promise<void> {
		if (action.payload.kind !== "session_command") throw new Error("Expected a selected session command");
		const input = action.payload;
		const commitFence = await this._acquireSessionActionCommitFence();
		try {
			await this._commitFence.run(commitFence, async () => {
				const isCancelled = () => action.lifecycle.state === "cancelled";
				if (isCancelled()) return;
				await this._refinement._waitForRefineIdle();
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
				this._inputScheduler.suspended ||
				this._inputScheduler.queuedWorkPauseCount > 0 ||
				this._branchSummaryOperation !== undefined
			);
		}
		return externalBusy || this._actionStore.unfinishedActions().length > 0;
	}

	private _isSessionInputHandoffDeferred(epoch: number): boolean {
		return epoch !== this._inputScheduler.epoch || this._isBusyForSessionInput("pump");
	}

	private _asError(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
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
		// The digest is never parked as pending context; lazy injection re-arms instead.
		const parkNextTurnMessages = (messages: CustomMessage[]) => {
			const parked = messages.filter((message) => message.customType !== HARNESS_DIGEST_CUSTOM_TYPE);
			if (parked.length !== messages.length) this._harnessDigestPending = true;
			this._pendingNextTurnMessages.unshift(...parked);
		};
		const restoreNextTurnContext = () => {
			parkNextTurnMessages(nextTurnMessages);
			nextTurnMessages = [];
		};
		try {
			const preparedTurn = await this._turnPreparer.prepare(executionPolicy.preparation, {
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
				promptPromise = this._commitFence.run(commitFence, () => {
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
					if (this._harnessDigestPending) {
						// The first-turn digest rides the turn's delivery records so a
						// cancelled first turn strips it with the rest of the turn.
						this._harnessDigestPending = false;
						const digest = this._harnessDigest();
						if (this._latestContextHarnessDigest() !== digest) {
							nextTurnMessages = [createHarnessDigestMessage(digest), ...nextTurnMessages];
						}
					}
					const contextRecords = nextTurnMessages.map((message) =>
						createDeliveryRecord(turns[0].id, "next_turn", message),
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
			parkNextTurnMessages(nextTurnMessages.filter((message) => !delivered.has(message)));
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
						this._refinement._emitRefineFailed(this._asError(error));
						throw error;
					}
					const applied = result.appliedEdits.filter((edit) => edit.applied).length;
					resultText = `Refined continual harness state: ${applied} edit${applied === 1 ? "" : "s"} applied.`;
					displayResult = false;
					break;
				}
				case "goal":
					await this._handleGoalSlashCommand(input.text, input.images);
					resultText = this._goals.state.objective
						? `Goal ${this._goals.state.status}: ${this._goals.state.objective}`
						: "No active goal.";
					break;
				case "autonomous":
					await this._handleAutonomousSlashCommand(input.text);
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
			if (!this._inputScheduler.suspendedForUpdateRestart) this._resumeSessionInputAdmission();
			const admissionFence = await this._acquireDirectTurnAdmissionFence();
			try {
				const normalized = normalizeMessageContent(message.content);
				const immediatelyEligible = this._canStartSessionActionImmediately();
				const action = this._createPreparedTurnAction("followUp", normalized.text, normalized.images, {
					message: appMessage,
					resumeIfIdle: true,
					executionPolicy: createTurnExecutionPolicy("customTrigger"),
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
			this._inputScheduler.invalidatePreparation();
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
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	private _invalidateQueuedPromptPreparation(): void {
		for (const action of this._actionStore.clearableActions()) {
			if (action.payload.kind === "turn") action.payload.prepared = undefined;
		}
	}

	clearQueuedAgentMessages(): { steering: string[]; followUp: string[] } {
		this._agentMessageClearEpoch++;
		// customType identifies agent messages; the text parser covers persisted pre-grammar prompts.
		return this._clearQueuedTurnActionsMatching(
			(action) =>
				isAgentSessionMessage(primaryDeliveryRecord(action).message) ||
				isAgentSessionMessagePrompt(action.payload.text),
		);
	}

	clearQueuedUserMessagesMatching(predicate: (text: string) => boolean): { steering: string[]; followUp: string[] } {
		return this._clearQueuedTurnActionsMatching((action) => predicate(action.payload.text));
	}

	private _clearQueuedTurnActionsMatching(matches: (action: QueuedSessionAction) => boolean): {
		steering: string[];
		followUp: string[];
	} {
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
				matches(action) &&
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
		return this._inputScheduler.suspended;
	}

	get isSessionActive(): boolean {
		return (
			this._ipythonKernelProvisioner?.manager?.hasBackgroundWork === true ||
			this.isStreaming ||
			this.isCompacting ||
			this.isRetrying ||
			this.isBashRunning ||
			this._refinement.isApplying ||
			this._branchSummaryOperation !== undefined ||
			this._continuation.current !== undefined ||
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

	private _waitForSessionActivityChange(signal: AbortSignal): Promise<void> {
		return new Promise<void>((resolve) => {
			const finish = () => {
				this._sessionInputCheckpointWaiters.delete(finish);
				signal.removeEventListener("abort", finish);
				resolve();
			};
			this._sessionInputCheckpointWaiters.add(finish);
			signal.addEventListener("abort", finish, { once: true });
			if (signal.aborted) finish();
		});
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
		return this._inputScheduler.acquireAdmissionPause(() => {
			this._notifySessionInputCheckpointChange();
			this._flushDeferredRlmTerminalNotices();
			this._maybeResumeGoalContinuationAfterRlmWork();
			this._scheduleSessionInputPump();
		});
	}

	acquireQueuedWorkPause(): { release(): void } {
		return this._inputScheduler.acquireQueuedWorkPause(() => {
			this._notifySessionInputCheckpointChange();
			this._flushDeferredRlmTerminalNotices();
			this._scheduleSessionInputPump();
		});
	}

	private async _acquireDirectTurnAdmissionFence(signal?: AbortSignal): Promise<{ owner: symbol; release(): void }> {
		if (this._commitFence.isHeldByCurrentContext) {
			this._assertSessionActionAdmissionAvailable();
			return this._acquireSessionActionCommitFence(signal);
		}
		const disposeSignal = this._commitFence.disposeSignal;
		const waitSignal = signal ? AbortSignal.any([signal, disposeSignal]) : disposeSignal;
		while (true) {
			this._assertSessionActionAdmissionAvailable();
			if (this._inputScheduler.queuedWorkPauseCount > 0) {
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
				if (this._inputScheduler.queuedWorkPauseCount === 0) {
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

	private _acquireSessionActionCommitFence(signal?: AbortSignal): Promise<SessionCommitLease> {
		return this._commitFence.acquire(signal);
	}

	private _resumeSessionInputAdmission(): void {
		if (!this._inputScheduler.resume()) return;
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

	waitForSessionInputIdle(): Promise<void> {
		return this._inputScheduler.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		await this._waitForIdleOrSettlement();
	}

	/**
	 * {@link waitForIdle} loop; with a settlement, returns once that settlement is
	 * superseded so a cancelled post-compaction runner cannot keep a checkpoint
	 * waiter registered (a leaked waiter holds hasPendingAdmissionWaiters true and
	 * blocks daemon passivation).
	 */
	private async _waitForIdleOrSettlement(settlement?: ContinuationToken): Promise<void> {
		while (settlement === undefined || this._continuation.current === settlement) {
			if (this._actionStore.queuedActions().length > 0) {
				if (this._inputScheduler.suspended || this._inputScheduler.queuedWorkPauseCount > 0) {
					let wake = () => {};
					const changed = new Promise<void>((resolve) => {
						wake = resolve;
						this._sessionInputCheckpointWaiters.add(resolve);
					});
					try {
						await (settlement ? Promise.race([changed, settlement.promise]) : changed);
					} finally {
						this._sessionInputCheckpointWaiters.delete(wake);
					}
					continue;
				}
				this._scheduleSessionInputPump();
			}
			const pump = this._inputScheduler.pendingPump;
			await pump;
			await this.agent.waitForIdle();
			const agentEventQueue = this._agentEventQueue;
			await agentEventQueue;
			if (
				pump === this._inputScheduler.pendingPump &&
				agentEventQueue === this._agentEventQueue &&
				!this._inputScheduler.requested &&
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
			const postCompactionContinuation = this._continuation.current?.promise;
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
		this._inputScheduler.suspend("abort");
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
		this._refinement.requestAbort();
		this.agent.abort();
	}

	async abort(): Promise<void> {
		const compactionOperation = this._compaction.operation;
		const branchSummaryOperation = this._branchSummaryOperation;
		this.requestAbort();
		this._cancelActiveRlmChildRuns("Parent session aborted");
		this._goalAbortInProgress = this._goals.state.status === "active";
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
		this._inputScheduler.suspend("update-restart");
		this._cancelPostCompactionContinue();
		this.abortRetry();
		for (const controller of this._rlmQuiescenceWaitAborts) controller.abort();
		this._cancelActiveRlmChildRuns("Parent session aborted for update restart");
		this._goalAbortInProgress = this._goals.state.status === "active";
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
		// Explicit selection recovers from a stale-auth lockout, but only a fully
		// validated switch commits the clear (single owner): failed selections never unlock.
		const staleOnly =
			!this._modelRegistry.hasConfiguredAuth(model) &&
			this._modelRegistry.getProviderAuthStatus(model.provider).source === "stale";
		if (!staleOnly && !this._modelRegistry.hasConfiguredAuth(model)) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}
		if (!(await this._modelRegistry.canUseModel(model, { assumeAuthConfigured: staleOnly }))) {
			throw new Error(`Model "${model.provider}/${model.id}" is not available for the current Prime team.`);
		}
		if (staleOnly) {
			this._modelRegistry.clearProviderAuthStale(model.provider);
			if (!this._modelRegistry.hasConfiguredAuth(model)) {
				throw new Error(`No API key for ${model.provider}/${model.id}`);
			}
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
			"[python-state]",
			"",
			`Your Python kernel persisted through compaction; its remaining variables, imports, and helpers are still available.${prunedDetail}${detail}`,
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
		const lines = ["[python-state-restored]", ""];
		if (result.restored.length > 0) {
			lines.push(
				`Your Python kernel state was revived from your previous session. These names are available again: ${result.restored.join(", ")}.`,
			);
		} else {
			lines.push(
				"Your previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.",
			);
		}
		if (result.failed.length > 0) {
			lines.push(
				`These could not be restored and must be recreated if needed: ${result.failed.map((f) => f.name).join(", ")}.`,
			);
		}
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

	compact(customInstructions?: string, options: { skipAbort?: boolean } = {}): Promise<CompactionResult> {
		return this._compaction.compact(customInstructions, options);
	}

	private _afterManualCompaction(
		signal: AbortSignal,
		hadPostCompactionContinue: boolean,
		continueAfterSessionInput: boolean,
	): void {
		this._refinement._discardPendingAutoRefine({ cancelPostCompactionContinue: true });
		if (this._goals.state.status === "active" && !signal.aborted) {
			this._goalContinuationAwaitsRlmWork ||= !this.agent.hasQueuedMessages();
			this.resumeQueuedWork();
			if (this.agent.hasQueuedMessages()) this._schedulePostCompactionContinue();
		}
		if (hadPostCompactionContinue) {
			this._schedulePostCompactionContinue(continueAfterSessionInput);
		}
		// Queued agent or session-owned inputs resume the loop; defer refine
		// behind them instead of interleaving it before their turns.
		this._refinement._scheduleAutoRefineAfterCompaction(
			this._goalContinuationAwaitsRlmWork ||
				hadPostCompactionContinue ||
				this.agent.hasQueuedMessages() ||
				this.unfinishedActionCount > 0,
		);
	}

	/**
	 * Shared compaction core behind /compact, auto-compaction, and the compact
	 * skill. Throws CompactionSkippedError when there is nothing to compact and
	 * Error("Compaction cancelled") on abort or extension cancel.
	 */
	private _performCompaction(options: CompactionExecutionOptions): Promise<CompactionResult> {
		return performSessionCompaction(this._compactionExecution, options);
	}

	private async _reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void> {
		const childIds = [...this._rlmChildCleanupFailures.keys()].filter(
			(childId) => !this._activeRlmChildRuns.get(childId)?.detachedDeletion,
		);
		await Promise.allSettled(childIds.map((childId) => this.deleteRlmSubagent(childId)));
	}

	abortCompaction(): void {
		this._compaction.abort();
	}

	private _cancelPostCompactionContinue(): void {
		this._continuation.cancel();
	}

	private _schedulePostCompactionContinue(continueAfterSessionInput = false): void {
		this._continuation.schedule(continueAfterSessionInput);
	}

	private _forgetConsumedPostCompactionContinuations(messages: AgentMessage[]): void {
		this._continuation.forgetConsumed(messages);
	}

	/** The compact harness digest delivered at cold context boundaries (session start, resume, compaction head). */
	private _harnessDigest(): string {
		const tools = this.getActiveToolNames();
		const hasIpython = tools.includes("ipython");
		const visibleSkills = this._modelVisibleSkills().filter((skill) => !skill.disableModelInvocation);
		const hasRefineSkill = visibleSkills.some((skill) => skill.name === REFINE_SKILL_NAME);
		return formatHarnessStateForPrompt(this._refinement._loadMergedHarnessState(), {
			includeIpythonExamples: hasIpython,
			includeShellExamples: tools.includes("bash"),
			includeRefineExamples: hasIpython && hasRefineSkill,
		});
	}

	/** Cold-boundary digest delivery: empty contexts defer to the first committed turn (untouched sessions must stay empty); non-empty contexts append only when the newest in-context digest mismatches disk. */
	private _ensureHarnessDigestContext(): void {
		if (this.agent.state.messages.length === 0) {
			this._harnessDigestPending = true;
			return;
		}
		this._harnessDigestPending = false;
		this._appendHarnessDigestIfStale();
	}

	private _appendHarnessDigestIfStale(): void {
		const digest = this._harnessDigest();
		if (this._latestContextHarnessDigest() === digest) return;
		const message = createHarnessDigestMessage(digest);
		try {
			this.sessionManager.appendCustomMessageEntryWithRollback(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		} catch {
			// Unpersisted session: context-only injection.
		}
		this.agent.state.messages.push(message);
	}

	private _latestContextHarnessDigest(): string | undefined {
		// Retained pre-compaction messages follow the compaction head, so recency is by timestamp, not position.
		let latest: { timestamp: number; digest: string } | undefined;
		for (const message of this.agent.state.messages) {
			let digest: string | undefined;
			if (message.role === "custom" && message.customType === HARNESS_DIGEST_CUSTOM_TYPE) {
				digest = (message.details as HarnessDigestDetails | undefined)?.digest;
			} else if (message.role === "compactionSummary") {
				digest = message.harnessDigest;
			} else {
				continue;
			}
			if (digest !== undefined && (!latest || message.timestamp >= latest.timestamp)) {
				latest = { timestamp: message.timestamp, digest };
			}
		}
		return latest?.digest;
	}

	/**
	 * Refine editable continual harness state: prompt notes, memory, skills, and subagent specs.
	 * The base system prompt is intentionally not editable through this path.
	 *
	 * Planning runs in the background and does NOT block turn entry points
	 * (`_waitForRefineIdle` only waits for `_refineInFlight`). Only the fast
	 * application phase (disk I/O + in-memory mutation) blocks turn entry points.
	 */
	refine(
		options: { instructions?: string; rollbackId?: string; global?: boolean } = {},
		internal: { skipAbort?: boolean; trigger?: "manual" | "auto"; source?: RefinementSource } = {},
	): Promise<RefinementResult> {
		return this._refinement.refine(options, internal);
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
	private _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		queueAutonomousContinuation = true,
	): Promise<boolean> {
		return this._compaction.check(assistantMessage, skipAbortedCheck, queueAutonomousContinuation);
	}

	/**
	 * Internal: Run automatic (threshold/overflow) or model-requested compaction
	 * with events.
	 */

	private _runAutoCompaction(reason: "overflow" | "threshold" | "requested", willRetry: boolean): Promise<boolean> {
		return this._compaction.runAutomatic(reason, willRetry);
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
		const sdkToolEntry = (definition: ToolDefinition) => ({
			definition,
			sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, {
				source: "sdk" as const,
			}),
		});
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map(sdkToolEntry),
			...this._acpMcpTools.map(sdkToolEntry),
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
				commandPrefix: this.settingsManager.getShellCommandPrefix(),
				shellPath: this.settingsManager.getShellPath(),
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

		const previousAcpMcpToolNames = new Set(this._acpMcpTools.map((tool) => tool.name));
		const acpServers = this._mcpManager?.getAcpServers() ?? [];
		if (acpServers.length > 0 && !this._ipythonKernelProvisioner) {
			throw new Error("ACP MCP servers require the built-in cpython tool");
		}
		const acpMcpTools = this._ipythonKernelProvisioner
			? createAcpMcpToolDefinitions(acpServers, this._ipythonKernelProvisioner)
			: [];
		this._assertAcpMcpToolNamesAvailable(acpMcpTools.map((tool) => tool.name));
		for (const name of previousAcpMcpToolNames) this._allowedToolNames?.delete(name);
		for (const tool of acpMcpTools) this._allowedToolNames?.add(tool.name);
		this._acpMcpTools = acpMcpTools;

		const defaultActiveToolNames = this._baseToolsOverride ? Object.keys(this._baseToolsOverride) : ["ipython"];
		const baseActiveToolNames = [...(options.activeToolNames ?? defaultActiveToolNames)];
		if (this._goals.state.status === "active" && this._includeGoals) {
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
		if (!this._refinement._autoRefineAllowedForSession()) {
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

	private _createKernelHostHandlers(): HostRequestHandlers {
		const handlers: HostRequestHandlers = {
			"rlm.run": createRlmRunHostHandler(async ({ prompt, kwargs, cellSourceCode }) => ({
				...(await this.runRlmChild(prompt, kwargs, cellSourceCode)),
			})),
			"rlm.create_session": createRlmCreateSessionHostHandler(async ({ prompt, kwargs }) => ({
				...(await this.createRlmSession(prompt, kwargs)),
			})),
			"bash.completed": createAsyncBashCompletionHostHandler(async (details) => {
				const message = createAsyncBashCompletionMessage(details);
				const disposeSignal = this._commitFence.disposeSignal;
				while (true) {
					let admissionCommitted = false;
					try {
						await this._promptInjectedMessage(message.content, message, {
							streamingBehavior: "steer",
							queueIfBusy: true,
							resumeIfIdle: true,
							returnAfterAccepted: true,
							suppressAutonomousContinuation: true,
							admissionCommitted: () => {
								admissionCommitted = true;
							},
						});
						return;
					} catch (error) {
						if (admissionCommitted || !(error instanceof SessionInputAdmissionPausedError)) throw error;
						while (this._inputScheduler.admissionPaused && !disposeSignal.aborted) {
							await this._waitForSessionActivityChange(disposeSignal);
						}
					}
				}
			}),
			"bash.consumed": createAsyncBashConsumedHostHandler((details) => {
				this._withdrawAsyncBashCompletionNotice(details);
			}),
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
		if (this._refinement._autoRefineAllowedForSession()) {
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
		const messageController = this._agentMessageController;
		if (messageController && visibleKernelSkillNames.has(AGENT_MESSAGE_SKILL_NAME)) {
			Object.assign(
				handlers,
				createAgentMessageHostHandlers({
					family: async () => {
						if (!messageController.family)
							throw new Error("agent family roster is not available in this session");
						return messageController.family();
					},
					awaitPendingChildPublication: (selector) => this._awaitPendingRlmChildPublication(selector),
					sendAgentMessage: async (input) => {
						const receipt = (await this.handleAgentMessageHostRequest("agent_message.send", {
							target: input.target,
							message: input.message,
						})) as AgentSessionMessageReceipt;
						if (this._rlmDepth > 0) {
							let addressedParent = input.receiverRole === "parent";
							if (input.receiverRole === undefined && messageController.family) {
								try {
									addressedParent = (await messageController.family()).some(
										(member) =>
											member.relationship === "parent" &&
											(member.entry.id === input.target ||
												agentFamilyMemberName(member.entry) === input.target),
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
			env.RLM_HARNESS_STATE_DIR =
				this._refinement._localHarnessStateDir() ?? getLocalHarnessStateDir(rlmSessionDir)!;
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
		spawnedByRequestId?: string;
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
			allowedToolNames: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
			customTools: [...this._customTools],
			includeGoals: this._includeGoals,
			includeCompactSkill: this._includeCompactSkill,
			rlmDepth: this._rlmDepth + 1,
			rlmMaxDepth: this._rlmMaxDepth,
			rlmParentNodeId: options.id,
			spawnedByRequestId: options.spawnedByRequestId,
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
			semanticParentSessionId: options.parentSession.sessionId,
			semanticSpawnedByRequestId: options.spawnedByRequestId,
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
		if (this._inputScheduler.suspended) this._abandonRlmRunForQuiescence(run);
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
		for (const [childId, { session: childSession }] of this._rlmChildSessions) {
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

	async deleteInactiveRlmSubagent(
		childId: string,
		isExternallyRunning: () => boolean = () => false,
	): Promise<"deleted" | "not_found" | "running"> {
		for (const owner of this._rlmSubtreeSessions()) {
			const isRunning = (): boolean => {
				const status = owner._activeRlmChildRuns.get(childId)?.status;
				return status === "queued" || status === "running" || isExternallyRunning();
			};
			if (isRunning()) {
				return "running";
			}
			const subagent = [
				...(await owner.listRlmSubagents()).subagents,
				...owner._rlmChildCleanupFailures.values(),
			].find((entry) => entry.rlm_child_id === childId);
			if (!subagent) continue;
			if (isRunning()) {
				return "running";
			}
			const result = await owner._trackRlmSubagentDeletion(subagent, () => {
				if (isRunning()) {
					return Promise.resolve({ subagent, outcome: "skipped_running" });
				}
				return owner._deleteResolvedRlmSubagent(subagent);
			});
			return result.outcome === "skipped_running" ? "running" : "deleted";
		}
		return "not_found";
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
				run.deletionFailureNotice = undefined;
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
		const retained = this._rlmChildSessions.get(childId)?.session;
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
		this._rlmChildSessions.set(childId, { session, run: this._activeRlmChildRuns.get(childId) });
		if (unsubscribe) {
			this._rlmChildUnsubscribes.set(childId, unsubscribe);
		}
		return true;
	}

	releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false {
		const run = this._activeRlmChildRuns.get(childId);
		if (run?.session === session && run.status === "done") {
			const unsubscribe = run.unsubscribe ?? noopRlmChildEventUnsubscribe;
			return () => {
				run.unsubscribe = undefined;
				this._activeRlmChildRuns.delete(childId);
				unsubscribe();
			};
		}
		if (this._rlmChildSessions.get(childId)?.session !== session) return false;
		const unsubscribe = this._rlmChildUnsubscribes.get(childId) ?? noopRlmChildEventUnsubscribe;
		return () => {
			this._rlmChildUnsubscribes.delete(childId);
			this._rlmChildSessions.delete(childId);
			unsubscribe();
		};
	}

	private _rlmChildSnapshotForRun(
		run: RlmChildRun,
		child = run.session ?? this._rlmChildSessions.get(run.id)?.session,
	): RlmChildAgentSnapshot {
		const model = child?.model ?? run.model;
		return {
			id: run.id,
			parentId: this._rlmParentNodeId,
			sessionName: child?.sessionName ?? run.sessionName,
			model: `${model.provider}/${model.id}`,
			label: rlmChildLabel(run.prompt),
			status: run.status,
			durationMs: run.durationMs,
			answerPreview: run.answerPreview,
			toolUseCount: run.toolUseCount > 0 ? run.toolUseCount : undefined,
			tokenCount: child?._contextTokensForCurrentMessages(),
			recap: child?.getCurrentRecap(),
			sessionDir: run.sessionDir,
			activity: run.activity,
			repliedSinceTask: child?._repliedToParentSinceTask,
			error: run.error,
		};
	}

	private _rlmChildSnapshotForSession(childId: string, child: AgentSession): RlmChildAgentSnapshot {
		let answerPreview: string | undefined;
		let toolUseCount = 0;
		const messages =
			child.state.streamingMessage?.role === "assistant"
				? [...child.messages, child.state.streamingMessage]
				: child.messages;
		for (const message of messages) {
			if (message.role !== "assistant") continue;
			const text = compactRlmText(readAssistantText(message));
			if (text) answerPreview = text;
			toolUseCount += message.content.filter((block) => block.type === "toolCall").length;
		}
		return {
			id: childId,
			parentId: this._rlmParentNodeId,
			sessionName: child.sessionName,
			model: child.model ? `${child.model.provider}/${child.model.id}` : undefined,
			label: child.sessionName ?? "child agent",
			status: "done",
			answerPreview,
			toolUseCount: toolUseCount > 0 ? toolUseCount : undefined,
			tokenCount: child._contextTokensForCurrentMessages(),
			recap: child.getCurrentRecap(),
			sessionDir: child._rlmSessionDir ?? child.sessionManager.getSessionDir(),
			// No run exists (e.g. a child rehydrated after daemon recovery), so live
			// session state is the only source for in-flight follow-up work. Mirror
			// the run projection's convention: status stays "done" (the recorded task
			// finished) and current work surfaces through activity.
			activity: child.isSessionActive ? { kind: child.isStreaming ? "writing" : "waiting" } : undefined,
			repliedSinceTask: child._repliedToParentSinceTask,
		};
	}

	private _isUnboundTerminalRlmChildRun(run: RlmChildRun): boolean {
		if (run.session !== undefined || this._rlmChildSessions.has(run.id)) return false;
		return run.status === "done" || run.status === "error" || run.status === "cancelled";
	}

	/** Live recursive child roster from lifecycle state, including nested work under retained parents. */
	getRlmChildSnapshots(): RlmChildAgentSnapshot[] {
		const snapshots: RlmChildAgentSnapshot[] = [];
		const recorded = new Set<string>();
		const traversed = new Set<string>();
		for (const run of this._activeRlmChildRuns.values()) {
			const hidden =
				run.detachedDeletion ||
				this._deletingRlmChildren.has(run.id) ||
				this._deletedRlmChildIds.has(run.id) ||
				this._isUnboundTerminalRlmChildRun(run);
			const child = run.session;
			if (!hidden) {
				snapshots.push(this._rlmChildSnapshotForRun(run));
				recorded.add(run.id);
			}
			if (child) {
				traversed.add(run.id);
				snapshots.push(...child.getRlmChildSnapshots());
			}
		}
		for (const [childId, { session: child, run }] of this._rlmChildSessions) {
			if (recorded.has(childId) || traversed.has(childId)) continue;
			const hidden = this._deletingRlmChildren.has(childId) || this._deletedRlmChildIds.has(childId);
			if (!hidden) {
				const snapshot = run
					? this._rlmChildSnapshotForRun(run, child)
					: this._rlmChildSnapshotForSession(childId, child);
				snapshots.push({
					...snapshot,
					status: this._rlmChildCleanupFailures.has(childId) ? "cancelled" : snapshot.status,
				});
			}
			snapshots.push(...child.getRlmChildSnapshots());
		}
		return snapshots;
	}

	/** True when any direct or nested subagent is still running or queued. */
	hasRunningRlmChildren(): boolean {
		for (const session of this._rlmSubtreeSessions()) {
			for (const run of session._activeRlmChildRuns.values()) {
				if (run.status === "running" || run.status === "queued") {
					return true;
				}
			}
		}
		return false;
	}

	private _rlmChildSessionSnapshot(): AgentSession[] {
		const sessions = new Set<AgentSession>();
		for (const [childId, { session }] of this._rlmChildSessions) {
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
				// Strong RLM quiescence also owns work that interactive waitForIdle ignores.
				if (this.isSessionActive || this._hasDeferredRlmTerminalNotices()) {
					await wait(this._waitForSessionActivityChange(cancellation.signal));
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
		for (const session of this._rlmSubtreeSessions()) {
			const direct =
				session._activeRlmChildRuns.get(childId)?.session ?? session._rlmChildSessions.get(childId)?.session;
			if (direct) {
				return direct;
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
		for (const session of this._rlmSubtreeSessions()) {
			const run = session._activeRlmChildRuns.get(childId);
			if (run) {
				if (run.status !== "running" && run.status !== "queued" && !run.settled) {
					if (session._inputScheduler.suspended) session._abandonRlmRunForQuiescence(run);
					else run.suppressTerminalNotice = true;
					return true;
				}
				// The abort cascade never reaches running work retained under a settled descendant.
				const cancelled = session._cancelRlmChildRun(run, reason);
				const descendantsCancelled = run.session?.cancelRunningRlmDescendants(reason) ?? false;
				if (cancelled || descendantsCancelled) {
					return true;
				}
			}
			// A fruitless match keeps walking: child ids are only mkdir-unique among
			// siblings, so a colliding live run elsewhere must stay reachable.
			if (session._rlmChildSessions.get(childId)?.session.cancelRunningRlmDescendants(reason)) {
				return true;
			}
		}
		return false;
	}

	// A done child sits in BOTH maps until passivation; the visited set keeps that dual membership from doubling the walk.
	private *_rlmSubtreeSessions(): Generator<AgentSession> {
		const visited = new Set<AgentSession>([this]);
		const stack: AgentSession[] = [this];
		while (stack.length > 0) {
			const session = stack.pop()!;
			yield session;
			for (const run of session._activeRlmChildRuns.values()) {
				if (run.session && !visited.has(run.session)) {
					visited.add(run.session);
					stack.push(run.session);
				}
			}
			for (const { session: retained } of session._rlmChildSessions.values()) {
				if (!visited.has(retained)) {
					visited.add(retained);
					stack.push(retained);
				}
			}
		}
	}

	/** Cancel every running or queued run in this session's subtree. */
	cancelRunningRlmDescendants(reason = "Cancelled by user"): boolean {
		let cancelled = false;
		for (const session of this._rlmSubtreeSessions()) {
			for (const run of session._activeRlmChildRuns.values()) {
				if (session._cancelRlmChildRun(run, reason)) cancelled = true;
			}
		}
		return cancelled;
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
			[...this._rlmChildSessions.values()].some(({ session }) => session.sessionName === name) ||
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

	private async _resolveRlmSubagentModel(
		reference: string | undefined,
		target = "subagent",
	): Promise<RlmSubagentModelSelection> {
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
			throw new Error(`Requested ${target} model "${reference}" is unavailable, unauthenticated, or expired`);
		}

		const auth = await this._modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			throw new Error(`Requested ${target} model "${reference}" failed authentication preflight`);
		}
		return { model };
	}

	private async _startRlmChildRun(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
	): Promise<RlmSpawnHandle> {
		// Snapshot before any await: the spawning request is the turn whose tool call is
		// executing now. A spawn arriving outside an active run (a detached kernel task
		// firing while the parent is idle) has no such turn; an absent edge beats a wrong one.
		const spawnedByRequestId = this.isStreaming ? this._semanticEdges.lastTurnRequestId : undefined;
		const { name: rawName, model: rawModel, thinking: rawThinking, ...unsupported } = kwargs;
		const unsupportedKwargs = Object.keys(unsupported);
		if (unsupportedKwargs.length > 0) {
			throw new Error(`Unsupported rlm.spawn kwargs: ${unsupportedKwargs.sort().join(", ")}`);
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
		const startedAt = Date.now();
		const parentAssistantForUsage = this._findLastAssistantMessage();
		if (parentAssistantForUsage && !this._rlmDurableParentUsage.has(parentAssistantForUsage)) {
			this._rlmDurableParentUsage.set(parentAssistantForUsage, cloneUsage(parentAssistantForUsage.usage));
		}
		// Child completions accumulate per origin and flush one durable entry per
		// settle boundary (agent_end, settlement); the staleness checkpoints and
		// timer bound crash loss to one window of accumulated usage.
		const pendingChildUsage = new Map<ChildUsageAttributionEntry["origin"], Usage>();
		let pendingChildUsageSince = 0;
		let pendingChildUsageTimer: ReturnType<typeof setTimeout> | undefined;
		let parentEntryDrainScheduled = false;
		const flushPendingChildUsageAttribution = (afterParentDrain = false) => {
			if (pendingChildUsageTimer !== undefined) {
				clearTimeout(pendingChildUsageTimer);
				pendingChildUsageTimer = undefined;
			}
			if (pendingChildUsage.size === 0 || !parentAssistantForUsage) return;
			const parentEntry = this._findAssistantEntryForMessage(parentAssistantForUsage);
			if (!parentEntry) {
				if (!afterParentDrain && !parentEntryDrainScheduled) {
					parentEntryDrainScheduled = true;
					const flushAfterParentDrain = () => {
						parentEntryDrainScheduled = false;
						flushPendingChildUsageAttribution(true);
					};
					// A message_end extension may still be holding the parent assistant before its append.
					// The parent drain owns this retry; child settlement never waits for that queue.
					this._agentEventQueue = this._agentEventQueue.then(flushAfterParentDrain, flushAfterParentDrain);
					this._agentEventQueue.catch(() => {});
				}
				return;
			}
			const batches = [...pendingChildUsage.entries()];
			pendingChildUsage.clear();
			for (const [origin, childUsage] of batches) {
				const aggregateUsage = cloneUsage(this._rlmDurableParentUsage.get(parentAssistantForUsage)!);
				attributeChildUsage(aggregateUsage, childUsage);
				const liveUsage = parentAssistantForUsage.usage;
				const entryCount = this.sessionManager.getEntries().length;
				try {
					this.sessionManager.appendChildUsageAttribution(parentEntry.id, childUsage, aggregateUsage, origin);
					this._rlmDurableParentUsage.set(parentAssistantForUsage, aggregateUsage);
				} catch {
					// Attribution is recoverable bookkeeping; a failed append must not break run settlement.
				} finally {
					// The manager updates this same message; retain siblings' still-pending live usage.
					parentAssistantForUsage.usage = liveUsage;
					const indexed = this.sessionManager.getEntries()[entryCount];
					const unindexedUsage = this._rlmUnindexedChildUsage.get(parentAssistantForUsage);
					// _persist can throw after indexing. That row already participates in live own-usage subtraction.
					if (
						indexed?.type === "child_usage_attributed" &&
						indexed.targetId === parentEntry.id &&
						unindexedUsage
					) {
						subtractAssistantUsage(unindexedUsage, childUsage);
					}
					this._ownUsageMemo = undefined;
				}
			}
		};
		const flushPendingChildUsageIfStale = () => {
			if (
				pendingChildUsage.size > 0 &&
				Date.now() - pendingChildUsageSince >= RLM_CHILD_USAGE_FLUSH_MAX_PENDING_MS
			) {
				flushPendingChildUsageAttribution();
			}
		};
		let runningToolCount = 0;
		let childSession: AgentSession | undefined;
		const run: RlmChildRun = {
			id: childNodeId,
			prompt,
			sessionName,
			sessionDir: childSessionDir,
			model: modelSelection.model,
			status: "queued",
			toolUseCount: 0,
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
			const child = this._rlmChildSnapshotForRun(run);
			const serialized = JSON.stringify(child);
			if (serialized === run.lastEmittedUpdate) return;
			run.lastEmittedUpdate = serialized;
			this._emit({ type: "rlm_child_update", child });
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
				spawnedByRequestId,
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
			if (run.deletionFailureNotice) return run.deletionFailureNotice;
			const cleanupError = error instanceof Error ? error.message : String(error);
			const notice = deliverTerminalMessageToParent(
				createRlmChildFailureMessage({
					childId: run.id,
					sessionName,
					error: `Deletion cleanup failed; retry rlm.delete_subagent("${run.id}") before completion: ${cleanupError}`,
				}),
			);
			run.deletionFailureNotice = notice;
			return notice;
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
				const unsubscribeChildEvents = child.subscribe((event) => {
					if (event.type === "rlm_child_update") {
						this._emit(event);
						return;
					}
					if (event.type === "agent_start") {
						run.activity = { kind: "waiting" };
						emitChildUpdate();
					} else if (event.type === "agent_end") {
						flushPendingChildUsageAttribution();
						run.activity = undefined;
						emitChildUpdate();
					} else if (event.type === "message_end" && event.message.role === "assistant") {
						const assistant = event.message as AssistantMessage;
						if (assistant.stopReason !== "error" && assistant.stopReason !== "aborted") {
							// Flush before the fold: a persisted aggregate may only include
							// completions whose childUsage is durable with or before it.
							flushPendingChildUsageIfStale();
							attributeChildUsage(parentAssistantForUsage?.usage ?? emptyUsage(), assistant.usage);
							if (parentAssistantForUsage) {
								const unindexedUsage =
									this._rlmUnindexedChildUsage.get(parentAssistantForUsage) ?? emptyUsage();
								addAssistantUsage(unindexedUsage, assistant.usage);
								this._rlmUnindexedChildUsage.set(parentAssistantForUsage, unindexedUsage);
								this._ownUsageMemo = undefined;
								const origin = rlmChildUsageOrigin(child.messages, assistant);
								if (pendingChildUsage.size === 0) {
									pendingChildUsageSince = Date.now();
									// Wall-clock backstop for long tool runs without checkpoints.
									pendingChildUsageTimer = setTimeout(
										flushPendingChildUsageAttribution,
										RLM_CHILD_USAGE_FLUSH_MAX_PENDING_MS,
									);
									pendingChildUsageTimer.unref?.();
								}
								const bucket = pendingChildUsage.get(origin) ?? emptyUsage();
								addAssistantUsage(bucket, assistant.usage);
								pendingChildUsage.set(origin, bucket);
							}
						}
						const text = compactRlmText(readAssistantText(assistant));
						if (text) run.answerPreview = text;
						emitChildUpdate();
					} else if (event.type === "message_start" || event.type === "message_update") {
						if (event.message.role === "assistant") {
							const text = compactRlmText(readAssistantText(event.message as AssistantMessage));
							if (text) run.answerPreview = text;
							run.activity = { kind: "writing" };
							emitChildUpdate();
						}
					} else if (event.type === "tool_execution_start") {
						flushPendingChildUsageIfStale();
						run.toolUseCount += 1;
						runningToolCount += 1;
						run.activity = { kind: "executing", toolName: event.toolName };
						emitChildUpdate();
					} else if (event.type === "tool_execution_end") {
						runningToolCount = Math.max(0, runningToolCount - 1);
						if (runningToolCount === 0) run.activity = { kind: "waiting" };
						emitChildUpdate();
					} else if (event.type === "session_info_changed" || event.type === "recap_update") {
						emitChildUpdate();
					}
				});
				run.unsubscribe = unsubscribeChildEvents;
				const content = `[task from parent]\n\n${prompt}`;
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
							activeSessionId: await this._currentActiveSessionId(),
						},
						fromRelationship: "parent",
					},
					timestamp: Date.now(),
				};
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
				// Only successful completions return; the edge lands on the parent's next commit.
				const childLastCommitted = child.semanticEdges.lastCommittedRequestId;
				if (childLastCommitted !== undefined) {
					this._semanticEdges.recordChildReturned(child.sessionId, childLastCommitted);
				}
				run.durationMs = Date.now() - startedAt;
				run.activity = undefined;
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
				// A failed child still returns an error outcome the parent consumes;
				// cancelled runs and zero-commit children return nothing.
				const failedChild = childSession ?? childRuntime?.session;
				const failedLastCommitted = failedChild?.semanticEdges.lastCommittedRequestId;
				if (run.status === "error" && failedChild && failedLastCommitted !== undefined) {
					this._semanticEdges.recordChildReturned(failedChild.sessionId, failedLastCommitted);
				}
				run.durationMs = Date.now() - startedAt;
				run.activity = undefined;
				if (run.status === "error" && childSession === undefined) {
					// A pre-bind failure leaves no row: "cancelled" is the wire's removal signal.
					this._emit({
						type: "rlm_child_update",
						child: { ...this._rlmChildSnapshotForRun(run), status: "cancelled" },
					});
				} else {
					emitChildUpdate();
				}
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
				flushPendingChildUsageAttribution();
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

	async createRlmSession(prompt: string, kwargs: Record<string, unknown> = {}): Promise<RlmCreateSessionResult> {
		const { name: rawName, model: rawModel, thinking: rawThinking, cwd: rawCwd, ...unsupported } = kwargs;
		const unsupportedKeys = Object.keys(unsupported);
		if (unsupportedKeys.length > 0) {
			throw new Error(`Unsupported rlm.create_session kwargs: ${unsupportedKeys.sort().join(", ")}`);
		}
		if (!prompt.trim()) {
			throw new Error("rlm.create_session prompt must not be empty");
		}
		if (this._rlmDepth !== 0) {
			throw new Error("rlm.create_session is available only from a depth-0 session");
		}
		if (this._disposed || this._disposing) {
			throw new Error("Cannot create a top-level session after the current session was disposed");
		}
		const host = this._subagentRuntimeHost;
		if (!host?.createRlmRootSession) {
			throw new Error("rlm.create_session requires a daemon-backed depth-0 session");
		}

		const operation = "rlm.create_session";
		const sessionName = normalizeRequestedRlmSubagentSessionName(rawName, operation);
		const requestedModel = normalizeRequestedRlmSubagentModel(rawModel, operation);
		const requestedThinkingLevel = normalizeRequestedRlmSubagentThinkingLevel(rawThinking, operation);
		if (sessionName) {
			assertDirectAgentMessageTarget(sessionName);
			const controller = this._agentMessageController;
			if (controller?.assertSessionNameAvailable) {
				await controller.assertSessionNameAvailable({ name: sessionName, depth: 0 });
			}
		}
		if (rawCwd !== undefined && (typeof rawCwd !== "string" || !rawCwd.trim())) {
			throw new Error("rlm.create_session cwd must be a non-empty string");
		}
		const cwd = rawCwd === undefined ? this._cwd : resolve(this._cwd, rawCwd.trim());
		const modelSelection = await this._resolveRlmSubagentModel(requestedModel, "top-level session");
		if (requestedThinkingLevel !== undefined) {
			const supported = getSupportedThinkingLevels(modelSelection.model) as ThinkingLevel[];
			if (!supported.includes(requestedThinkingLevel)) {
				throw new Error(
					`Requested thinking level "${requestedThinkingLevel}" is not supported by model "${modelSelection.model.provider}/${modelSelection.model.id}"; supported levels: ${supported.join(", ")}`,
				);
			}
		}
		const thinkingLevel =
			requestedThinkingLevel ?? (clampThinkingLevel(modelSelection.model, this.thinkingLevel) as ThinkingLevel);
		if (this._disposed || this._disposing) {
			throw new Error("Cannot create a top-level session after the current session was disposed");
		}
		return host.createRlmRootSession({
			prompt,
			sessionName,
			cwd,
			model: modelSelection.model,
			thinkingLevel,
		});
	}

	async runRlmChild(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
	): Promise<RlmSpawnHandle> {
		return this._startRlmChildRun(prompt, kwargs, spawnCode);
	}

	abortRetry(): void {
		this._retry.abortRetry();
	}

	private waitForRetry(): Promise<void> {
		return this._retry.waitForRetry();
	}

	get isRetrying(): boolean {
		return this._retry.isRetrying;
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

	/** Execute a shell command and record its result unless transient. */
	executeBash(command: string, onChunk?: (chunk: string) => void, options?: ExecuteBashOptions): Promise<BashResult> {
		return this._bash.executeBash(command, onChunk, options);
	}

	/** Run ! / !! input with extension interception and bash lifecycle events. */
	runUserBash(command: string, options?: RunUserBashOptions): Promise<void> {
		return this._bash.runUserBash(command, options);
	}

	private async _drainQueuedMessagesAfterBash(): Promise<void> {
		await this.agent.waitForIdle();
		this._scheduleSessionInputPump();
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		this._bash.recordBashResult(command, result, options);
	}

	/** Cancel every in-flight shell command, including pending extension dispatch. */
	abortBash(): void {
		this._bash.abortBash();
	}

	get isBashRunning(): boolean {
		return this._bash.isBashRunning;
	}

	get hasPendingBashMessages(): boolean {
		return this._bash.hasPendingBashMessages;
	}

	private _flushPendingBashMessages(): void {
		this._bash.flushPendingMessages();
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
			return await this._commitFence.run(commitFence, async () => {
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
		await this._refinement._invalidatePendingAutoRefineForBranchChange();

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
			let summaryUsage: Usage | undefined;
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
					retry: providerRetryPolicy(this.settingsManager),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
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
					summaryUsage,
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
			// Context rebuild = cold boundary: refresh the digest like resume.
			this._ensureHarnessDigestContext();
			this._goals.reload();
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
			this._notifySessionInputCheckpointChange();
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

	private _subtractUnindexedChildUsage(ownUsage: Usage, entries: SessionEntry[]): void {
		for (const entry of entries) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const unindexedUsage = this._rlmUnindexedChildUsage.get(entry.message);
			if (unindexedUsage) subtractAssistantUsage(ownUsage, unindexedUsage);
		}
	}

	private _ownUsageMemo?: { count: number; tailId: string | undefined; usage: SessionUsageSummary | undefined };

	// Whole-file own spend, identical to the catalog scan so rows never shift at passivation.
	getOwnUsageSummary(): SessionUsageSummary | undefined {
		const entries = this.sessionManager.getEntries();
		const tailId = entries.at(-1)?.id;
		const memo = this._ownUsageMemo;
		if (memo && memo.count === entries.length && memo.tailId === tailId) {
			return memo.usage;
		}
		const { ownUsage } = computeOwnAndTotalUsage(entries, entries);
		this._subtractUnindexedChildUsage(ownUsage, entries);
		const usage = sessionUsageSummaryFrom(ownUsage);
		this._ownUsageMemo = { count: entries.length, tailId, usage };
		return usage;
	}

	/**
	 * Build the agent context overview for /context: this session as the root
	 * plus one node per RLM sub-agent, recursively. Running children are read
	 * from their live sessions; completed children from their persisted session
	 * dirs, so the tree survives child disposal and session resume.
	 */
	getContextTree(): ContextTreeNode {
		const resolveContextWindow = this._contextWindowResolver();
		const branch = this.sessionManager.getBranch();
		const { ownUsage, totalUsage } = computeOwnAndTotalUsage(branch, this.sessionManager.getEntries());
		this._subtractUnindexedChildUsage(ownUsage, branch);

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

	// ==================================================================	// Extension System
	// ==================================================================
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
