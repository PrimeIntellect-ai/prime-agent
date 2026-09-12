import type {
	Agent,
	AgentContext,
	AgentMessage,
	AgentState,
	AgentTool,
	ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model, ServiceTier } from "@earendil-works/pi-ai";
import { clampThinkingLevel, cleanupSessionResources, supportsFastMode } from "@earendil-works/pi-ai";
import { handleAgentMessageHostRequest } from "../coordination/messaging/host-requests.js";
import { handleAgentObserveHostRequest } from "../coordination/observation/host-requests.js";
import { handleRlmHeartbeatHostRequest } from "../coordination/scheduling/host-requests.js";
import {
	AGENT_MESSAGE_SKILL_NAME,
	type AgentSessionMessageController,
	type AgentSessionMessageReceipt,
} from "../core/agent-messages.js";
import {
	AGENT_OBSERVE_SKILL_NAME,
	type AgentObserveAgentSnapshot,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	ORCHESTRATION_HEARTBEAT_SKILL_NAME,
} from "../core/agent-observe.js";
import type { BashResult } from "../core/bash-executor.js";
import type { AgentCronJob, AgentRlmHeartbeatController } from "../core/cron-jobs.js";
import type {
	ExtensionRunner,
	ReplacedSessionContext,
	SessionStartEvent,
	ToolDefinition,
	ToolInfo,
} from "../core/extensions/index.js";
import type { AcpMcpServerConfig } from "../core/mcp/acp-mcp-types.js";
import type { McpManager } from "../core/mcp/mcp-manager.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { PromptTemplate } from "../core/prompt-templates.js";
import { providerRetryPolicy } from "../core/provider-retry.js";
import type { ResourceLoader } from "../core/resource-loader.js";
import { SemanticEdgeRecorder, semanticEdgeLedgerPath, wrapStreamFnWithSemanticEdges } from "../core/semantic-edges.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
import { getPythonSkillRuntimeInfo, type Skill } from "../core/skills.js";
import type { HostRequestHandlers } from "../kernel/contracts.js";
import type { IpythonKernelProvisioner } from "../kernel/provisioner.js";
import type { AgentAutonomousConfig } from "./autonomy/autonomous.js";
import { SessionAutonomousContinuation } from "./autonomy/continuation.js";
import { createChildSessionDir, createInlineChildRuntime } from "./children/child-runtime.js";
import { SessionChildState } from "./children/child-state.js";
import {
	compactRlmText,
	type RlmChildAgentSnapshot,
	type RlmChildAgentStatus,
	rlmChildLabel,
} from "./children/child-types.js";
import { SessionChildUsage } from "./children/child-usage.js";
import { SessionChildren } from "./children/children.js";
import type {
	CreateRlmSubagentRuntimeOptions,
	RlmCreateSessionResult,
	RlmDeleteSubagentResult,
	RlmListSubagentsResult,
	RlmSpawnHandle,
	RlmSubagentRuntime,
	SubagentRuntimeHost,
} from "./children/runtime-contracts.js";
import { SessionCompaction } from "./compaction/controller.js";
import {
	type CompactionExecutionHost,
	type CompactionExecutionOptions,
	performSessionCompaction,
} from "./compaction/execution.js";
import { COMPACT_SKILL_NAME, type CompactionResult } from "./compaction/types.js";
import { type ContextViewChild, SessionContextView } from "./context/context-view.js";
import { SessionExport } from "./context/export.js";
import { SessionHarnessContext } from "./context/harness-context.js";
import { SessionHistoryNavigation } from "./context/history-navigation.js";
import { type CustomMessage, createHeartbeatPromptMessage, type RefinementSource } from "./context/messages.js";
import { SessionPendingContext } from "./context/pending-context.js";
import type { BuildSystemPromptOptions } from "./context/system-prompt.js";
import { calculateContextTokens } from "./context/token-estimate.js";
import { type ExtensionBindings, installExtensionToolHooks, SessionExtensions } from "./extensions/extensions.js";
import { SessionGoalContinuation } from "./goals/continuation.js";
import {
	createGoalContextMessage,
	GOAL_CONTEXT_CUSTOM_TYPE,
	GOAL_SKILL_NAME,
	type GoalState,
} from "./goals/contracts.js";
import { GoalController } from "./goals/controller.js";
import { createGoalPersistence } from "./goals/persistence.js";
import { SessionActionQueue } from "./input/action-queue.js";
import { SessionActionRecovery } from "./input/action-recovery.js";
import { ActionStore, type RuntimeActivity } from "./input/action-store.js";
import { SessionCommitFence, type SessionCommitLease } from "./input/commit-fence.js";
import { SessionInputAdmission } from "./input/input-admission.js";
import { SessionInputCheckpoints } from "./input/input-checkpoints.js";
import { SessionInputDispatcher } from "./input/input-dispatcher.js";
import { SessionInputScheduler } from "./input/input-scheduler.js";
import { SessionMessageDelivery } from "./input/message-delivery.js";
import { type QueuedSessionAction, visibleSessionActionProjection } from "./input/prepared-actions.js";
import { type PromptOptions, SessionPromptSubmission } from "./input/prompt-submission.js";
import { SubmissionNormalizer } from "./input/submission-normalization.js";
import { SessionModelSelection } from "./models/model-selection.js";
import { type AutoRefineReviewer, SessionRefinement } from "./refinement/controller.js";
import { REFINE_SKILL_NAME, type RefinementResult } from "./refinement/types.js";
import { createSessionKernelHostHandlers } from "./runtime/host-bridge.js";
import { KernelEnvironment } from "./runtime/kernel-environment.js";
import { SessionKernel } from "./runtime/kernel-lifecycle.js";
import { type ExecuteBashOptions, type RunUserBashOptions, SessionBash } from "./tools/bash.js";
import { SessionTools } from "./tools/tools.js";
import { SessionCommandExecution } from "./turns/command-execution.js";
import { SessionContinuation } from "./turns/continuation.js";
import { SessionEvents } from "./turns/events.js";
import { SessionRetry } from "./turns/retry.js";
import { SessionTurnExecution } from "./turns/turn-execution.js";
import { SessionTurnPolicy } from "./turns/turn-policy.js";
import { TurnPreparer } from "./turns/turn-preparation.js";

export { type ParsedSkillBlock, parseSkillBlock } from "../core/skill-blocks.js";
export type {
	RlmChildAgentActivity,
	RlmChildAgentSnapshot,
	RlmChildAgentStatus,
} from "./children/child-types.js";
export { compactRlmText, rlmChildLabel } from "./children/child-types.js";
export type { CompactionReason } from "./compaction/controller.js";
export { CompactionSkippedError } from "./compaction/execution.js";
export type { SessionStats } from "./context/session-stats.js";
export type { GoalState, GoalStatus } from "./goals/contracts.js";
export {
	SESSION_ACTION_RECOVERY_FORMAT_VERSION,
	type SessionActionRecoveryAction,
	type SessionActionRecoveryPayload,
	type SessionActionRecoveryRecord,
	type SessionActionRecoverySnapshot,
} from "./input/prepared-actions.js";
export { RefineSkippedError } from "./refinement/controller.js";
export type { AgentSessionEvent, AgentSessionEventListener } from "./turns/events.js";
export type { TurnExecutionPolicy } from "./turns/turn-preparation.js";

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

export type { ExtensionBindings } from "./extensions/extensions.js";
export type { PromptOptions } from "./input/prompt-submission.js";
export type { ModelCycleResult } from "./models/model-selection.js";
export type { AutoRefineReviewer, AutoRefineReviewRequest } from "./refinement/controller.js";

import type { RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./children/max-depth.js";

export type { RlmMaxDepthSource, RlmMaxDepthStatus, SetRlmMaxDepthResult } from "./children/max-depth.js";

export class AgentSession {
	private readonly _tools: SessionTools;
	private readonly _extensions: SessionExtensions;
	private readonly _kernel: SessionKernel;
	private readonly _kernelEnvironment: KernelEnvironment;
	private get _extensionRunner(): ExtensionRunner {
		return this._extensions.runner;
	}
	private get _ipythonKernelProvisioner(): IpythonKernelProvisioner | undefined {
		return this._kernel.provisioner;
	}
	private get _rlmSessionDir(): string | undefined {
		return this._kernelEnvironment.sessionDir;
	}
	private get _allowedToolNames(): ReadonlySet<string> | undefined {
		return this._tools.allowedToolNames;
	}
	private get _customTools(): ToolDefinition[] {
		return this._tools.customTools;
	}
	private get _toolRegistry(): ReadonlyMap<string, AgentTool> {
		return this._tools.registry;
	}
	private get _baseSystemPrompt(): string {
		return this._tools.baseSystemPrompt;
	}
	private set _baseSystemPrompt(prompt: string) {
		this._tools.baseSystemPrompt = prompt;
	}
	private get _baseSystemPromptOptions(): BuildSystemPromptOptions {
		return this._tools.baseSystemPromptOptions;
	}
	private readonly _childState: SessionChildState;

	private readonly _childUsage = new SessionChildUsage({
		sessionManager: {
			getEntries: () => this.sessionManager.getEntries(),
			appendChildUsageAttribution: (...args) => this.sessionManager.appendChildUsageAttribution(...args),
		},
		invalidateOwnUsage: () => this._invalidateOwnUsage(),
		afterParentDrain: (flush) => {
			this._events.enqueue(flush);
		},
	});
	private readonly _children = new SessionChildren({
		isDisposed: () => this._disposed || this._disposing,
		isInputSuspended: () => this._inputScheduler.suspended,
		isStreaming: () => this.isStreaming,
		isSessionActive: () => this.isSessionActive,
		getMessageController: () => this._agentMessageController,
		getDepth: () => this._childState.depth,
		getMaxDepth: () => this._childState.maxDepth,
		getParentNodeId: () => this._rlmParentNodeId,
		getCwd: () => this._cwd,
		getSessionId: () => this.sessionId,
		getSessionName: () => this.sessionName,
		getSessionFile: () => this.sessionFile,
		getThinkingLevel: () => this.thinkingLevel,
		getSemanticEdges: () => this._semanticEdges,
		getChildOwner: (child) => child._children,
		getParentReplyCount: (child) => child._childState.replyCount,
		getChildSessionDir: (child) => child._rlmSessionDir,
		listRlmSubagents: () => this.listRlmSubagents(),
		deleteRlmSubagent: (target) => this.deleteRlmSubagent(target),
		registerRlmChildSession: (id, child) => this.registerRlmChildSession(id, child),
		resolveModel: (reference, target) => this._resolveRlmSubagentModel(reference, target),
		createSessionDir: () => this._createChildRlmSessionDir(),
		createRuntimeOptions: (request) => this._createRlmSubagentRuntimeOptions(request),
		createRuntime: (options) => this._createRlmSubagentRuntime(options),
		createUsageTracker: () => this._childUsage.createTracker(this._findLastAssistantMessage()),
		hasDeferredTerminalNotices: () => this._hasDeferredRlmTerminalNotices(),
		waitForHeadlessIdle: () => this.waitForHeadlessIdle(),
		waitForActivityChange: (signal) => this._waitForSessionActivityChange(signal),
		deliverTerminalNotice: (message) => this._deferRlmTerminalNotice(message),
		emit: (event) => this._emit(event),
		onSettled: () => this._maybeResumeGoalContinuationAfterRlmWork(),
	});

	private readonly _turnPolicy = new SessionTurnPolicy({
		steeringStopPending: () => this._steeringStopPending,
		stopGoalForTerminalMessage: (message) => this._stopGoalContinuationForTerminalMessage(message),
		getGoals: () => this._goals,
		accountAssistantBudget: (message) => this._goalContinuation.accountAssistantBudget(message),
		getRefinement: () => this._refinement,
		getEventQueue: () => this._events.queue,
		getCompaction: () => this._compaction,
		getMessages: () => this.agent.state.messages,
		getSettings: () => this.settingsManager,
		getModel: () => this.model,
		getStore: () => this.sessionManager,
		queueThresholdGoal: (message) => this._queueGoalContinuationForThresholdCompaction(message),
		queueThresholdAutonomous: (message) => this._queueAutonomousContinuationForThresholdCompaction(message),
		getQueuedCount: () => this.queuedActionCount,
		getArrivalEpoch: () => this._inputAdmission.arrivalEpoch,
		getGoalMessages: (context, signal) => this._getGoalContinuationMessages(context, signal),
		getAutonomous: () => this._autonomousContinuation,
		snapshotAutonomous: () => this._snapshotAutonomousRuntimeState(),
		restoreAutonomous: (snapshot) => this._restoreAutonomousRuntimeSnapshot(snapshot),
	});
	private readonly _turnExecution = new SessionTurnExecution({
		getPreparer: () => this._turnPreparer,
		getFence: () => this._commitFence,
		acquireFence: () => this._acquireSessionActionCommitFence(),
		isDeferred: (epoch) => this._isSessionInputHandoffDeferred(epoch),
		isStreaming: () => this.isStreaming,
		getBasePrompt: () => this._baseSystemPrompt,
		getBasePromptOptions: () => this._baseSystemPromptOptions,
		refreshExtensionSystemPrompt: (prompt, snapshot) => this._refreshExtensionSystemPrompt(prompt, snapshot),
		getExtensions: () => this._extensionRunner,
		getAgent: () => this.agent,
		takeNextTurnMessages: () => this._takePendingNextTurnMessages(),
		restoreNextTurnMessages: (messages) => this._pendingContext.prependMessages(messages),
		consumePendingDigest: () => this._harnessContext.consumePendingDigest(),
		rearmDigest: () => this._harnessContext.rearmDigest(),
		getDigest: () => this._harnessDigest(),
		getLatestDigest: () => this._latestContextHarnessDigest(),
		suppressForMessage: (message) => this._markAutonomousContinuationSuppressed(message),
		runSuppressed: (run) => this._runWithAutonomousContinuationSuppressed(run),
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		hasCancelledCapture: () => this._hasCancelledDispatchCapture(),
		getEventQueue: () => this._events.queue,
		waitForRetry: () => this.waitForRetry(),
		forgetContinuations: (messages) => this._forgetConsumedPostCompactionContinuations(messages),
	});
	/** Session-owned actions. Items are never fed into Agent.steer/followUp. */
	private readonly _actionStore = new ActionStore<QueuedSessionAction>();
	private readonly _inputCheckpoints = new SessionInputCheckpoints(this._actionStore, {
		getFence: () => this._commitFence,
		getScheduler: () => this._inputScheduler,
		isBusyForInputPump: () => this._isBusyForSessionInput("pump"),
		getEventQueue: () => this._events.queue,
		acquireFence: (signal) => this._acquireSessionActionCommitFence(signal),
		getStore: () => this.sessionManager,
		assertAdmissionAvailable: () => this._assertSessionActionAdmissionAvailable(),
		getContinuation: () => this._continuation,
		scheduleInput: () => this._scheduleSessionInputPump(),
		getAgent: () => this.agent,
		getUnfinishedCount: () => this.unfinishedActionCount,
		waitForIdle: () => this.waitForIdle(),
	});
	private readonly _promptSubmission = new SessionPromptSubmission(this._actionStore, {
		promptInjectedMessage: (text, message, options) => this._promptInjectedMessage(text, message, options),
		waitForActivityChange: (signal) => this._waitForSessionActivityChange(signal),
		queueAgentMessagePrompt: (text, streamingBehavior, customMessage) =>
			this.queueAgentMessagePrompt(text, streamingBehavior, customMessage),
		getScheduler: () => this._inputScheduler,
		getFence: () => this._commitFence,
		isStreaming: () => this.isStreaming,
		isCompacting: () => this.isCompacting,
		isRetrying: () => this.isRetrying,
		isBashRunning: () => this.isBashRunning,
		resumeAdmission: () => this._resumeSessionInputAdmission(),
		assertAdmissionAvailable: () => this._assertSessionActionAdmissionAvailable(),
		acquireAdmissionFence: (signal) => this._acquireDirectTurnAdmissionFence(signal),
		normalize: (text, images, policy) => this._normalizeSubmission(text, images, policy),
		settleAgentMessage: (id, leg, error) => this._settleAgentMessage(id, leg, error),
		canStartImmediately: () => this._canStartSessionActionImmediately(),
		admit: (action, options) => this._admitSessionInput(action, options),
		waitForInputIdle: () => this.waitForSessionInputIdle(),
		isBusy: (point) => this._isBusyForSessionInput(point),
		takeNextTurnMessages: () => this._takePendingNextTurnMessages(),
		restoreNextTurnMessages: (messages) => this._pendingContext.prependMessages(messages),
		appendNextTurnMessage: (message) => this._pendingContext.appendMessages(message),
		getActivity: () => this._runtimeActivity(),
		suppressForMessage: (message) => this._markAutonomousContinuationSuppressed(message),
		observeDeferral: (action) => this._observeSessionActionDeferral(action),
		rejectAgentMessage: (id, error) => this._rejectAgentMessage(id, error),
		cancelActions: (predicate, error) => this._cancelSessionActions(predicate, error),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		getClearEpoch: () => this._actionQueue.clearEpoch,
		queuePrompt: (schedule, text, images, options) => this._queuePreparedPrompt(schedule, text, images, options),
		resetParentReply: () => {
			this._childState.resetReply();
		},
		getAgent: () => this.agent,
		getStore: () => this.sessionManager,
		emit: (event) => this._emit(event),
	});
	private readonly _inputAdmission = new SessionInputAdmission(this._actionStore, {
		getScheduler: () => this._inputScheduler,
		isDisposed: () => this._disposed,
		isDisposing: () => this._disposing,
		isStreaming: () => this.isStreaming,
		rejectAgentMessage: (id, error) => this._rejectAgentMessage(id, error),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		resumeAdmission: () => this._resumeSessionInputAdmission(),
		scheduleInput: () => this._scheduleSessionInputPump(),
		suppressForMessage: (message) => this._markAutonomousContinuationSuppressed(message),
	});
	private readonly _pendingContext = new SessionPendingContext(this._actionStore, {
		getScheduler: () => this._inputScheduler,
		getFence: () => this._commitFence,
		isDisposed: () => this._disposed,
		isDisposing: () => this._disposing,
		admit: (action, options) => this._admitSessionInput(action, options),
		scheduleInput: () => this._scheduleSessionInputPump(),
		addCheckpointWaiter: (waiter) => this._inputCheckpoints.add(waiter),
		removeCheckpointWaiter: (waiter) => this._inputCheckpoints.remove(waiter),
		acquireFence: (signal) => this._acquireSessionActionCommitFence(signal),
		cancelActions: (predicate, error, candidates) => this._cancelSessionActions(predicate, error, candidates),
	});
	private readonly _actionQueue = new SessionActionQueue(this._actionStore, {
		formatLabel: (text) => compactRlmText(text),
		getScheduler: () => this._inputScheduler,
		getAgent: () => this.agent,
		rearmDigest: () => this._harnessContext.rearmDigest(),
		restoreNextTurnMessages: (messages) => this._pendingContext.prependMessages(messages),
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		settleAgentMessage: (id, leg, error) => this._settleAgentMessage(id, leg, error),
		rejectAgentMessage: (id, error) => this._rejectAgentMessage(id, error),
		admit: (action, options) => this._admitSessionInput(action, options),
		queuePrompt: (schedule, text, images, options) => this._queuePreparedPrompt(schedule, text, images, options),
		resumeQueuedWork: () => this.resumeQueuedWork(),
	});
	private readonly _actionRecovery = new SessionActionRecovery(this._actionStore, {
		isTerminalNoticeAction: (action) => this._isRlmTerminalNoticeAction(action),
		retainTerminalNotice: (id) => this._pendingContext.retainTerminalNotice(id),
		releaseTerminalNotice: (id) => this._pendingContext.releaseTerminalNotice(id),
		admit: (action, options) => this._admitSessionInput(action, options),
	});
	private readonly _commandExecution = new SessionCommandExecution(this._actionStore, {
		getFence: () => this._commitFence,
		acquireFence: () => this._acquireSessionActionCommitFence(),
		getRefinement: () => this._refinement,
		isDeferred: (epoch) => this._isSessionInputHandoffDeferred(epoch),
		getActivity: () => this._runtimeActivity(),
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		settleAgentMessage: (id, leg, error) => this._settleAgentMessage(id, leg, error),
		rejectAgentMessage: (id, error) => this._rejectAgentMessage(id, error),
		compact: (instructions, options) => this.compact(instructions, options),
		refine: (options, internal) => this.refine(options, internal),
		handleGoalCommand: (text, images) => this._handleGoalSlashCommand(text, images),
		handleAutonomousCommand: (text) => this._handleAutonomousSlashCommand(text),
		getGoalState: () => this._goals.state,
		getStore: () => this.sessionManager,
		getAgent: () => this.agent,
		emit: (event) => this._emit(event),
	});
	private readonly _events = new SessionEvents(this._actionStore, {
		getAgent: () => this.agent,
		getStore: () => this.sessionManager,
		getExtensions: () => this._extensionRunner,
		getRetry: () => this._retry,
		getCompaction: () => this._compaction,
		getRefinement: () => this._refinement,
		addAutonomousUsage: (usage) => this._autonomousContinuation.recordUsage(usage),
		applyLateMessages: (message) => this._applyLateIpythonSentAgentMessages(message),
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		settleAgentMessage: (id, leg, error) => this._settleAgentMessage(id, leg, error),
		getSnapshot: () => this.getSessionActionSnapshot(),
		accountAssistantBudget: (message) => this._goalContinuation.accountAssistantBudget(message),
		finishGoal: (message) => this._finishGoalForTerminalAssistantMessage(message),
		checkCompaction: (message) => this._checkCompaction(message),
	});
	private readonly _messageDelivery = new SessionMessageDelivery(this._actionStore, {
		isDisposed: () => this._disposed,
		getMessages: () => this.agent.state.messages,
		getStore: () => this.sessionManager,
		enqueue: (work) => this._events.enqueue(work),
		emit: (event) => this._emit(event),
		promptUntilAccepted: (text, options) => this.promptUntilAccepted(text, options),
		cancelActions: (predicate, error) => this._cancelSessionActions(predicate, error),
	});
	private readonly _submissionNormalizer = new SubmissionNormalizer({
		getExtensions: () => this._extensionRunner,
		getPrompts: () => this.promptTemplates,
		getSkills: () => this.resourceLoader.getSkills().skills,
	});
	private readonly _refinement: SessionRefinement;
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	private readonly _export: SessionExport;
	private readonly _contextView: SessionContextView;
	private readonly _modelSelection: SessionModelSelection;
	private get _scopedModels() {
		return this._modelSelection.scopedModels;
	}

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
		getEventQueue: () => this._events.queue,
		waitForRefinement: () => this._refinement._waitForRefineIdle(),
		getTranscript: () => this.agent.state.messages,
		startTurns: (actions, epoch) => this._startPreparedTurnActions(actions, epoch),
		executeCommand: (action, epoch) => this._executeSelectedSessionCommand(action, epoch),
		settleAgentMessage: (id, leg, error) => this._settleAgentMessage(id, leg, error),
		releaseTurn: (id) => {
			this._pendingContext.releaseTerminalNotice(id);
		},
		notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		emitQueueUpdate: () => this._emitQueueUpdate(),
		surfaceError: (error) => this._surfaceSessionInputError(error),
		schedule: () => this._scheduleSessionInputPump(),
	});
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

	private readonly _autonomousContinuation: SessionAutonomousContinuation;
	private readonly _goalContinuation: SessionGoalContinuation;
	private get _goals(): GoalController {
		return this._goalContinuation.controller;
	}

	private readonly _compaction = new SessionCompaction({
		includesCompactSkill: () => this._includeCompactSkill,
		getContextUsage: () => this.getContextUsage(),
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
		takeThresholdAutonomousMessages: () => this._autonomousContinuation.takePendingThresholdMessages(),
		getThresholdGoalContinuation: () => this._goalContinuation.thresholdContinuation,
		clearAutonomousContinuations: (shouldContinue, messages) =>
			this._clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(shouldContinue, messages),
		clearGoalContinuation: (message) => this._clearQueuedGoalContinuationAfterCancelledThresholdCompaction(message),
		getSessionStore: () => this.sessionManager,
		retainUnpersistedOutcome: (message) => {
			this._harnessContext.retainOutcome(message);
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

	private get _branchSummaryOperation(): Promise<void> | undefined {
		return this._history.operation;
	}
	private readonly _history: SessionHistoryNavigation;

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
	/** Fresh/empty contexts defer digest injection to the first committed turn so untouched sessions stay empty. */
	private readonly _harnessContext: SessionHarnessContext;

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

	private readonly _resourceLoader: ResourceLoader;
	private readonly _cwd: string;
	private readonly _agentDir?: string;
	private readonly _initialActiveToolNames?: string[];
	private readonly _includeGoals: boolean;
	private readonly _includeCompactSkill: boolean;
	private _rlmHeartbeatController?: AgentRlmHeartbeatController;
	private readonly _agentMessageController?: AgentSessionMessageController;
	private readonly _agentObserveController?: AgentObserveController;
	private readonly _mcpManager?: McpManager;
	private _disposed = false;
	private readonly _disposeCallbacks = new Set<() => void | Promise<void>>();
	private _disposeCallbacksPromise?: Promise<void>;
	// Set at the start of async teardown so a child finishing mid-disposeAsync doesn't
	// re-populate the retained map after it's been cleared.
	private _disposing = false;
	private _disposeAsyncPromise?: Promise<void>;
	private readonly _semanticEdges: SemanticEdgeRecorder;
	private readonly _rlmParentNodeId?: string;
	private readonly _rlmParentAgent?: string;

	private readonly _modelRegistry: ModelRegistry;

	private readonly _continuation = new SessionContinuation({
		waitForAgentIdle: () => this.agent.waitForIdle(),
		waitForRetry: () => this.waitForRetry(),
		waitForRefinement: () => this._refinement._waitForRefineIdle(),
		queuedWorkPauseCount: () => this._inputScheduler.queuedWorkPauseCount,
		addCheckpointWaiter: (waiter) => {
			this._inputCheckpoints.add(waiter);
		},
		removeCheckpointWaiter: (waiter) => {
			this._inputCheckpoints.remove(waiter);
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
			this._autonomousContinuation.forgetSnapshot(message);
		},
	});

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._harnessContext = new SessionHarnessContext({
			sessionManager: this.sessionManager,
			getMessages: () => this.messages,
			getActiveToolNames: () => this.getActiveToolNames(),
			getVisibleSkills: () => this._modelVisibleSkills(),
			loadHarnessState: () => this._refinement._loadMergedHarnessState(),
			applyLateSentMessages: (message) => this._applyLateIpythonSentAgentMessages(message),
		});
		this._export = new SessionExport({
			sessionManager: this.sessionManager,
			getState: () => this.state,
			getTheme: () => this.settingsManager.getTheme(),
			getToolDefinition: (name) => this.getToolDefinition(name),
		});
		this._contextView = new SessionContextView({
			getContextUsage: () => this.getContextUsage(),
			sessionManager: this.sessionManager,
			getMessages: () => this.messages,
			getModel: () => this.model,
			findModel: (provider, modelId) => this._modelRegistry.find(provider, modelId),
			subtractUnindexedChildUsage: (ownUsage, entries) => this._childUsage.subtractUnindexed(ownUsage, entries),
			getRlmSessionDir: () => this._rlmSessionDirForReading(),
			getLiveChildren: () => this._contextViewChildren(),
		});

		this._history = new SessionHistoryNavigation({
			getRetryPolicy: () => providerRetryPolicy(this.settingsManager),
			sessionManager: this.sessionManager,
			settingsManager: this.settingsManager,
			getModel: () => this.model,
			getExtensions: () => this._extensionRunner,
			getRequiredAuth: (model) => this._getRequiredRequestAuth(model),
			acquireQueuedWorkPause: () => this.acquireQueuedWorkPause(),
			acquireCommitFence: () => this._acquireSessionActionCommitFence(),
			runWithCommitFence: (lease, run) => this._commitFence.run(lease, run),
			waitForAgentIdle: () => this.agent.waitForIdle(),
			getEventQueue: () => this._events.queue,
			invalidateRefinement: () => this._refinement._invalidatePendingAutoRefineForBranchChange(),
			rebuildBranchContext: () => {
				this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
				this._mergeUnpersistedOutcomes(this.agent.state.messages);
				this._restoreLateIpythonSentAgentMessages();
				this._ensureHarnessDigestContext();
				this._goals.reload();
				this._reloadRlmMaxDepthFromBranch();
				this._invalidateQueuedPromptPreparation();
			},
			notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
		});

		this._refinement = new SessionRefinement(
			{
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				getRetryPolicy: () => providerRetryPolicy(this.settingsManager),
				isDisposed: () => this._disposed,
				isDisposing: () => this._disposing,
				isStreaming: () => this.isStreaming,
				isCompacting: () => this.isCompacting,
				getDepth: () => this._childState.depth,
				getRlmSessionDir: () => this._rlmSessionDir,
				getModel: () => this.model,
				getThinkingLevel: () => this.thinkingLevel,
				getMessages: () => this.agent.state.messages,
				getRequiredRequestAuth: (model) => this._getRequiredRequestAuth(model),
				getExtensionRunner: () => this._extensionRunner,
				getEventQueue: () => this._events.queue,
				getCompactionOperation: () => this._compaction.operation,
				getBranchSummaryOperation: () => this._branchSummaryOperation,
				waitForAgentIdle: () => this.agent.waitForIdle(),
				dispatchRefine: (options, internal) => this.refine(options, internal),
				disconnect: () => this._disconnectFromAgent(),
				reconnect: () => this._reconnectToAgent(),
				emit: (event) => this._emit(event),
				retainUnpersistedOutcome: (message) => this._harnessContext.retainOutcome(message),
				notifyCheckpoints: () => this._notifySessionInputCheckpointChange(),
				scheduleInputPump: () => this._scheduleSessionInputPump(),
				isContinuationScheduled: () => this._continuation.isScheduled,
				cancelContinuation: () => this._cancelPostCompactionContinue(),
			},
			{
				serializedRefine: config.serializedRefine,
				autoRefineReviewer: config.autoRefineReviewer?.bind(this),
			},
		);
		this._modelSelection = new SessionModelSelection(
			{
				getModel: () => this.model,
				getState: () => this.agent.state,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				getAvailableThinkingLevels: () => this.getAvailableThinkingLevels(),
				supportsThinking: () => this.supportsThinking(),
				getRegistry: () => this._modelRegistry,
				getExtensions: () => this._extensionRunner,
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				emit: (event) => this._emit(event),
			},
			config.serviceTierPreference ?? config.agent.state.serviceTier,
			config.scopedModels ?? [],
		);
		this._resourceLoader = config.resourceLoader;
		this._cwd = config.cwd;
		this._agentDir = config.agentDir;
		this._modelRegistry = config.modelRegistry;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._includeGoals = config.includeGoals ?? true;
		this._includeCompactSkill = config.includeCompactSkill ?? this.settingsManager.getCompactionAgentCallable();
		this._rlmHeartbeatController = config.rlmHeartbeatController;
		this._agentMessageController = config.agentMessageController;
		this._agentObserveController = config.agentObserveController;
		this._mcpManager = config.mcpManager;
		this._childState = new SessionChildState(
			{
				sessionManager: this.sessionManager,
				settingsManager: this.settingsManager,
				getRlmMaxDepthStatus: () => this.getRlmMaxDepthStatus(),
				refreshPrompt: (preserveExtensionPrompt) => {
					const oldBase = this._baseSystemPrompt;
					this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
					this.agent.state.systemPrompt = preserveExtensionPrompt
						? this._refreshExtensionSystemPrompt(this.agent.state.systemPrompt, oldBase)
						: this._baseSystemPrompt;
				},
				emitRecap: (recap) => this._emit({ type: "recap_update", recap }),
			},
			config,
		);

		this._rlmParentNodeId = config.rlmParentNodeId;
		this._rlmParentAgent = config.rlmParentAgent;
		this._kernelEnvironment = new KernelEnvironment(
			{
				agentDir: this._agentDir,
				authStorage: this._modelRegistry.authStorage,
				resourceLoader: this._resourceLoader,
				getDepth: () => this._childState.depth,
				getMaxDepth: () => this._childState.maxDepth,
				getArtifactDir: () => this.sessionManager.getSessionArtifactDir(),
				getLocalHarnessStateDir: () => this._refinement._localHarnessStateDir(),
			},
			config.rlmSessionDir,
		);
		this._kernel = new SessionKernel(
			{
				cwd: this._cwd,
				getArtifactDir: () => this.sessionManager.getSessionArtifactDir(),
				getSessionId: () => this.sessionId,
				getEnv: () => this._rlmKernelEnv(),
				getShellCommandPrefix: () => this.settingsManager.getShellCommandPrefix(),
				getShellPath: () => this.settingsManager.getShellPath(),
				createHostHandlers: () => this._createKernelHostHandlers(),
				getMessages: () => this.agent.state.messages,
				appendCustomMessageEntry: (...args) => this.sessionManager.appendCustomMessageEntry(...args),
				emit: (event) => this._emit(event),
				sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
			},
			(config.prewarmIpythonKernel ?? false) && this._childState.depth === 0,
		);
		this._tools = new SessionTools(
			{
				cwd: this._cwd,
				resourceLoader: this._resourceLoader,
				getExtensionRunner: () => this._extensionRunner,
				getSessionFile: () => this.sessionManager.getSessionFile(),
				getModelVisibleSkills: () => this._modelVisibleSkills(),
				getDepth: () => this._childState.depth,
				getMaxDepth: () => this._childState.maxDepth,
				getParentAgent: () => this._rlmParentAgent,
				getMcpManager: () => this._mcpManager,
				getProvisioner: () => this._kernel.provisioner,
				getActiveToolNames: () => this.getActiveToolNames(),
				setActiveToolsByName: (names) => this.setActiveToolsByName(names),
				getActiveTools: () => this.agent.state.tools,
				setActiveTools: (tools) => {
					this.agent.state.tools = tools;
				},
				setSystemPrompt: (prompt) => {
					this.agent.state.systemPrompt = prompt;
				},
				isStreaming: () => this.isStreaming,
				rebuildRuntime: (options) => this._buildRuntime(options),
				acquireInputPause: () => this.acquireSessionInputPause(),
				waitForAgentIdle: () => this.agent.waitForIdle(),
				getEventQueue: () => this._events.queue,
			},
			{
				customTools: config.customTools,
				allowedToolNames: config.allowedToolNames,
				baseToolsOverride: config.baseToolsOverride,
			},
		);
		this._extensions = new SessionExtensions(
			{
				cwd: this._cwd,
				sessionManager: this.sessionManager,
				resourceLoader: this._resourceLoader,
				modelRegistry: this._modelRegistry,
				getModelRegistry: () => this.modelRegistry,
				getPromptTemplates: () => this.promptTemplates,
				bindShutdownHandler: (handler) => handler?.bind(this),
				getAgentMessageController: () => this._agentMessageController,
				refreshCurrentModel: () => this._refreshCurrentModelFromRegistry(),
				sendCustomMessage: (message, options) => this.sendCustomMessage(message, options),
				sendUserMessage: (content, options) => this.sendUserMessage(content, options),
				setSessionName: (name) => this.setSessionName(name),
				getActiveToolNames: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveToolsByName: (names) => this.setActiveToolsByName(names),
				refreshTools: () => this._refreshToolRegistry(),
				setModel: (model) => this.setModel(model),
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				getModel: () => this.model,
				isStreaming: () => this.isStreaming,
				getSignal: () => this.agent.signal,
				abort: () => this.abort(),
				getQueuedActionCount: () => this.queuedActionCount,
				getContextUsage: () => this.getContextUsage(),
				compact: (instructions) => this.compact(instructions),
				getSystemPrompt: () => this.systemPrompt,
				rebuildSystemPrompt: () => {
					this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
					this.agent.state.systemPrompt = this._baseSystemPrompt;
				},
				reloadSettings: () => this.settingsManager.reload(),
				getMcpManager: () => this._mcpManager,
				rebuildRuntime: (options) => this._buildRuntime(options),
			},
			config.sessionStartEvent ?? { type: "session_start", reason: "startup" },
			config.extensionRunnerRef,
		);

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
		this._childState.initializeParentReply();
		this._children.setRuntimeHost(config.subagentRuntimeHost);
		this._autonomousContinuation = new SessionAutonomousContinuation(config.autonomous, {
			getStatus: () => this.getAutonomousStatus(),
			getCwd: () => this._cwd,
			getAgent: () => this.agent,
			getStore: () => this.sessionManager,
			emit: (event) => this._emit(event),
			getContinuation: () => this._continuation,
			getArrivalEpoch: () => this._inputAdmission.arrivalEpoch,
			admit: (action, options) => this._admitSessionInput(action, options),
			cancelActions: (predicate, error) => this._cancelSessionActions(predicate, error),
			emitQueueUpdate: () => this._emitQueueUpdate(),
			getCompaction: () => this._compaction,
			getUnfinishedActionCount: () => this.unfinishedActionCount,
			cancelContinuation: () => this._cancelPostCompactionContinue(),
		});
		const goalPersistence = createGoalPersistence(this.sessionManager);
		this._goalContinuation = new SessionGoalContinuation(
			new GoalController(goalPersistence, (goal) => this._emit({ type: "goal_update", goal })),
			this._actionStore,
			{
				getGoalState: () => this.goalState,
				queuePrompt: (schedule, text, images, options) =>
					this._queuePreparedPrompt(schedule, text, images, options),
				getScheduler: () => this._inputScheduler,
				isDisposed: () => this._disposed,
				isDisposing: () => this._disposing,
				hasUnsettledChildWork: () => this._hasUnsettledRlmQuiescenceWork(),
				ensureRuntimeActive: (context) => this._ensureGoalRuntimeActive(context),
				admit: (action, options) => this._admitSessionInput(action, options),
				cancelActions: (predicate, error) => this._cancelSessionActions(predicate, error),
				clearPendingGoalContexts: () => {
					this._pendingContext.removeMessagesMatching(
						(message) => message.customType === GOAL_CONTEXT_CUSTOM_TYPE,
					);
				},
				emitQueueUpdate: () => this._emitQueueUpdate(),
				emitGoalUpdate: () => this._emitGoalUpdate(),
				validate: () => this._validateCanStartAgentRun(),
				isStreaming: () => this.isStreaming,
				includesGoals: () => this._includeGoals,
				getAgent: () => this.agent,
			},
		);
		// Seed initial goal from CLI --goal flag, but only for top-level sessions
		// and only when the branch contains only bootstrap entry types (model_change,
		// thinking_level_change, service_tier_change) and no persisted
		// thread_goal_state. This prevents reseeding after clear/complete/error
		// or restart/rehydration of a session that already has messages or a goal.
		if (this._childState.depth === 0 && config.initialGoal && goalPersistence.canSeed()) {
			this._startGoal(config.initialGoal.objective, config.initialGoal.tokenBudget);
			// Goal context is the model's only source of goal visibility; action
			// admission is unavailable mid-construction, so ride the next turn.
			this._pendingContext.appendMessages(createGoalContextMessage(this._goals.state, "continuation"));
		}
		this._restoreLateIpythonSentAgentMessages();
		this._goals.restartAccounting();

		this._events.reconnectToAgent();
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
		this._tools.replaceAcpMcpServers(servers, ownerId);
	}

	releaseAcpMcpServers(ownerId: string, serverNames: readonly string[]): Promise<void> {
		return this._tools.releaseAcpMcpServers(ownerId, serverNames);
	}

	get modelRegistry(): ModelRegistry {
		return this._modelRegistry;
	}

	setSubagentRuntimeHost(host?: SubagentRuntimeHost): void {
		this._children.setRuntimeHost(host);
	}

	private _getRequiredRequestAuth(
		...args: Parameters<SessionModelSelection["getRequiredRequestAuth"]>
	): ReturnType<SessionModelSelection["getRequiredRequestAuth"]> {
		return this._modelSelection.getRequiredRequestAuth(...args);
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
		installExtensionToolHooks(
			this.agent,
			() => this._extensionRunner,
			() => this._events.queue,
		);
	}

	private _installAgentContinuationHook(): void {
		this.agent.getContinuationMessages = (context, signal) => this._getContinuationMessages(context, signal);
	}

	private _installAgentTurnHook(): void {
		this.agent.shouldStopBeforeTurn = () => this._shouldStopBeforeTurn();
		this.agent.shouldStopAfterTurn = (context) => this._shouldStopAfterTurn(context);
	}

	private _emit(...args: Parameters<SessionEvents["emit"]>): ReturnType<SessionEvents["emit"]> {
		return this._events.emit(...args);
	}

	private _emitQueueUpdate(
		...args: Parameters<SessionEvents["emitQueueUpdate"]>
	): ReturnType<SessionEvents["emitQueueUpdate"]> {
		return this._events.emitQueueUpdate(...args);
	}

	private _restoreLateIpythonSentAgentMessages(
		...args: Parameters<SessionMessageDelivery["restoreLateIpythonSentAgentMessages"]>
	): ReturnType<SessionMessageDelivery["restoreLateIpythonSentAgentMessages"]> {
		return this._messageDelivery.restoreLateIpythonSentAgentMessages(...args);
	}

	private _applyLateIpythonSentAgentMessages(
		...args: Parameters<SessionMessageDelivery["applyLateIpythonSentAgentMessages"]>
	): ReturnType<SessionMessageDelivery["applyLateIpythonSentAgentMessages"]> {
		return this._messageDelivery.applyLateIpythonSentAgentMessages(...args);
	}

	private _recordLateIpythonSentAgentMessage(
		...args: Parameters<SessionMessageDelivery["recordLateIpythonSentAgentMessage"]>
	): ReturnType<SessionMessageDelivery["recordLateIpythonSentAgentMessage"]> {
		return this._messageDelivery.recordLateIpythonSentAgentMessage(...args);
	}

	private _emitGoalUpdate(): void {
		this._emit({ type: "goal_update", goal: this.goalState });
	}

	private _reloadRlmMaxDepthFromBranch(): void {
		this._childState.reloadFromBranch();
	}

	private _cancelSessionActions(
		...args: Parameters<SessionActionQueue["cancelSessionActions"]>
	): ReturnType<SessionActionQueue["cancelSessionActions"]> {
		return this._actionQueue.cancelSessionActions(...args);
	}

	private _startGoal(
		...args: Parameters<SessionGoalContinuation["startGoal"]>
	): ReturnType<SessionGoalContinuation["startGoal"]> {
		return this._goalContinuation.startGoal(...args);
	}

	private _finishGoalForTerminalAssistantMessage(
		...args: Parameters<SessionGoalContinuation["finishGoalForTerminalAssistantMessage"]>
	): ReturnType<SessionGoalContinuation["finishGoalForTerminalAssistantMessage"]> {
		return this._goalContinuation.finishGoalForTerminalAssistantMessage(...args);
	}

	private _stopGoalContinuationForTerminalMessage(
		...args: Parameters<SessionGoalContinuation["stopGoalContinuationForTerminalMessage"]>
	): ReturnType<SessionGoalContinuation["stopGoalContinuationForTerminalMessage"]> {
		return this._goalContinuation.stopGoalContinuationForTerminalMessage(...args);
	}

	private _handleAutonomousSlashCommand(
		...args: Parameters<SessionAutonomousContinuation["handleAutonomousSlashCommand"]>
	): ReturnType<SessionAutonomousContinuation["handleAutonomousSlashCommand"]> {
		return this._autonomousContinuation.handleAutonomousSlashCommand(...args);
	}

	private _validateCanStartAgentRun(
		...args: Parameters<SessionModelSelection["validateCanStartAgentRun"]>
	): ReturnType<SessionModelSelection["validateCanStartAgentRun"]> {
		return this._modelSelection.validateCanStartAgentRun(...args);
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

	private _maybeResumeGoalContinuationAfterRlmWork(
		...args: Parameters<SessionGoalContinuation["maybeResumeGoalContinuationAfterRlmWork"]>
	): ReturnType<SessionGoalContinuation["maybeResumeGoalContinuationAfterRlmWork"]> {
		return this._goalContinuation.maybeResumeGoalContinuationAfterRlmWork(...args);
	}

	private _handleGoalSlashCommand(
		...args: Parameters<SessionGoalContinuation["handleGoalSlashCommand"]>
	): ReturnType<SessionGoalContinuation["handleGoalSlashCommand"]> {
		return this._goalContinuation.handleGoalSlashCommand(...args);
	}

	private get _steeringStopPending(): boolean {
		return this._actionQueue.steeringStopPending;
	}

	private _shouldStopBeforeTurn(
		...args: Parameters<SessionTurnPolicy["shouldStopBeforeTurn"]>
	): ReturnType<SessionTurnPolicy["shouldStopBeforeTurn"]> {
		return this._turnPolicy.shouldStopBeforeTurn(...args);
	}

	private _shouldStopAfterTurn(
		...args: Parameters<SessionTurnPolicy["shouldStopAfterTurn"]>
	): ReturnType<SessionTurnPolicy["shouldStopAfterTurn"]> {
		return this._turnPolicy.shouldStopAfterTurn(...args);
	}

	private _snapshotAutonomousRuntimeState(
		...args: Parameters<SessionAutonomousContinuation["snapshotAutonomousRuntimeState"]>
	): ReturnType<SessionAutonomousContinuation["snapshotAutonomousRuntimeState"]> {
		return this._autonomousContinuation.snapshotAutonomousRuntimeState(...args);
	}

	private _restoreAutonomousRuntimeSnapshot(
		...args: Parameters<SessionAutonomousContinuation["restoreAutonomousRuntimeSnapshot"]>
	): ReturnType<SessionAutonomousContinuation["restoreAutonomousRuntimeSnapshot"]> {
		return this._autonomousContinuation.restoreAutonomousRuntimeSnapshot(...args);
	}

	private _queueAutonomousContinuationForThresholdCompaction(
		...args: Parameters<SessionAutonomousContinuation["queueAutonomousContinuationForThresholdCompaction"]>
	): ReturnType<SessionAutonomousContinuation["queueAutonomousContinuationForThresholdCompaction"]> {
		return this._autonomousContinuation.queueAutonomousContinuationForThresholdCompaction(...args);
	}

	// The role heuristic reads an assistant-last threshold stop as "task finished" and
	// agent.continue() cannot resume from it, so the goal continuation is queued as a session input.
	private _queueGoalContinuationForThresholdCompaction(
		...args: Parameters<SessionGoalContinuation["queueGoalContinuationForThresholdCompaction"]>
	): ReturnType<SessionGoalContinuation["queueGoalContinuationForThresholdCompaction"]> {
		return this._goalContinuation.queueGoalContinuationForThresholdCompaction(...args);
	}

	// Withdraws a goal continuation queued for a threshold compaction the user cancelled,
	// rolling back the continuationsUsed increment so the next natural stop re-queues it.
	private _clearQueuedGoalContinuationAfterCancelledThresholdCompaction(
		...args: Parameters<SessionGoalContinuation["clearQueuedGoalContinuationAfterCancelledThresholdCompaction"]>
	): ReturnType<SessionGoalContinuation["clearQueuedGoalContinuationAfterCancelledThresholdCompaction"]> {
		return this._goalContinuation.clearQueuedGoalContinuationAfterCancelledThresholdCompaction(...args);
	}

	private _clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(
		...args: Parameters<
			SessionAutonomousContinuation["clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction"]
		>
	): ReturnType<SessionAutonomousContinuation["clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction"]> {
		return this._autonomousContinuation.clearQueuedAutonomousContinuationsAfterSkippedThresholdCompaction(...args);
	}

	/**
	 * Handle a goal.* request from the Python kernel host bridge (the bundled
	 * goal skill). All goal state stays host-side; the kernel only sees the
	 * serialized snake_case response.
	 */
	handleGoalHostRequest(
		...args: Parameters<SessionGoalContinuation["handleGoalHostRequest"]>
	): ReturnType<SessionGoalContinuation["handleGoalHostRequest"]> {
		return this._goalContinuation.handleGoalHostRequest(...args);
	}

	/**
	 * Handle a compact.* request from the kernel host bridge. Compaction would
	 * abort the run executing the requesting cell, so compact.run only schedules
	 * it; _checkCompaction consumes the request at the turn boundary.
	 */
	handleCompactHostRequest(
		...args: Parameters<SessionCompaction["handleCompactHostRequest"]>
	): ReturnType<SessionCompaction["handleCompactHostRequest"]> {
		return this._compaction.handleCompactHostRequest(...args);
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
		return handleRlmHeartbeatHostRequest(this._rlmHeartbeatController, type, payload);
	}

	handleAgentMessageHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	): Promise<AgentSessionMessageReceipt> {
		return handleAgentMessageHostRequest(() => this._agentMessageController, type, payload);
	}

	handleAgentObserveHostRequest(
		type: string,
		payload: Record<string, unknown> = {},
	):
		| AgentObserveListResult
		| AgentObserveAgentSnapshot
		| AgentObserveRecentMessagesResult
		| Promise<AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult> {
		return handleAgentObserveHostRequest(this._agentObserveController, type, payload);
	}

	private _getGoalContinuationMessages(
		...args: Parameters<SessionGoalContinuation["getGoalContinuationMessages"]>
	): ReturnType<SessionGoalContinuation["getGoalContinuationMessages"]> {
		return this._goalContinuation.getGoalContinuationMessages(...args);
	}

	private _getContinuationMessages(
		...args: Parameters<SessionTurnPolicy["getContinuationMessages"]>
	): ReturnType<SessionTurnPolicy["getContinuationMessages"]> {
		return this._turnPolicy.getContinuationMessages(...args);
	}

	/**
	 * Register a delivery waiter before submitting the prompt. Delivery outcomes are not retained
	 * for late lookup, so callers that register after admission may wait for a future use of the id.
	 */
	waitForAgentMessagePromptDelivery(
		...args: Parameters<SessionMessageDelivery["waitForAgentMessagePromptDelivery"]>
	): ReturnType<SessionMessageDelivery["waitForAgentMessagePromptDelivery"]> {
		return this._messageDelivery.waitForAgentMessagePromptDelivery(...args);
	}

	private _settleAgentMessage(
		...args: Parameters<SessionMessageDelivery["settleAgentMessage"]>
	): ReturnType<SessionMessageDelivery["settleAgentMessage"]> {
		return this._messageDelivery.settleAgentMessage(...args);
	}

	private _rejectAgentMessage(
		...args: Parameters<SessionMessageDelivery["rejectAgentMessage"]>
	): ReturnType<SessionMessageDelivery["rejectAgentMessage"]> {
		return this._messageDelivery.rejectAgentMessage(...args);
	}

	private _hasCancelledDispatchCapture(
		...args: Parameters<SessionEvents["hasCancelledDispatchCapture"]>
	): ReturnType<SessionEvents["hasCancelledDispatchCapture"]> {
		return this._events.hasCancelledDispatchCapture(...args);
	}

	private _findLastAssistantMessage(): AssistantMessage | undefined {
		return this._events.findLastAssistantInMessages(this.agent.state.messages);
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(...args: Parameters<SessionEvents["subscribe"]>): ReturnType<SessionEvents["subscribe"]> {
		return this._events.subscribe(...args);
	}

	/**
	 * Temporarily disconnect from agent events.
	 * User listeners are preserved and will receive events again after resubscribe().
	 * Used internally during operations that need to pause event processing.
	 */
	private _disconnectFromAgent(
		...args: Parameters<SessionEvents["disconnectFromAgent"]>
	): ReturnType<SessionEvents["disconnectFromAgent"]> {
		return this._events.disconnectFromAgent(...args);
	}

	/**
	 * Reconnect to agent events after _disconnectFromAgent().
	 * Preserves all existing listeners.
	 */
	private _reconnectToAgent(
		...args: Parameters<SessionEvents["reconnectToAgent"]>
	): ReturnType<SessionEvents["reconnectToAgent"]> {
		return this._events.reconnectToAgent(...args);
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

	private _disposeAsyncOnce(kernelSnapshot: boolean): Promise<void> {
		// Flush kernels/traces for both still-running and retained children; the sync
		// dispose() below only tears them down synchronously.
		return this._children.disposeAsync(() =>
			this._kernel.dispose(kernelSnapshot, () => {
				this.dispose();
				return this._disposeCallbacksPromise;
			}),
		);
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
		this._children.beginDisposal();
		this._commitFence.dispose();
		try {
			// Invalidate scheduled timers and abort any in-flight review so a late
			// resolution cannot write harness state or re-subscribe handlers.
			this._refinement.dispose();
			this._children.dispose();
			this._pendingContext.dispose();
			const deliveryError = new Error("Session disposed before prompt delivery.");
			const completionError = new Error("Session disposed before prompt completion.");
			this._messageDelivery.dispose(deliveryError, completionError);
			this._cancelSessionActions(() => true, deliveryError);
			this.agent.clearAllQueues();
			this._extensionRunner.invalidate(
				"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
			);
			this._disconnectFromAgent();
			this._events.dispose();
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
		return this._tools.getActiveToolNames();
	}

	getAllTools(): ToolInfo[] {
		return this._tools.getAllTools();
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._tools.getToolDefinition(name);
	}

	setActiveToolsByName(toolNames: string[]): void {
		this._tools.setActiveToolsByName(toolNames);
	}

	get isCompacting(): boolean {
		return this._compaction.isRunning || this._history.isSummarizing;
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	buildSessionContext(
		...args: Parameters<SessionHarnessContext["buildSessionContext"]>
	): ReturnType<SessionHarnessContext["buildSessionContext"]> {
		return this._harnessContext.buildSessionContext(...args);
	}

	private _mergeUnpersistedOutcomes(
		...args: Parameters<SessionHarnessContext["mergeUnpersistedOutcomes"]>
	): ReturnType<SessionHarnessContext["mergeUnpersistedOutcomes"]> {
		return this._harnessContext.mergeUnpersistedOutcomes(...args);
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
		return this._childState.depth;
	}

	get semanticEdges(): SemanticEdgeRecorder {
		return this._semanticEdges;
	}

	get rlmMaxDepth(): number {
		return this._childState.maxDepth;
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get goalState(): GoalState {
		return this._goals.current;
	}

	getAutonomousStatus(
		...args: Parameters<SessionAutonomousContinuation["getAutonomousStatus"]>
	): ReturnType<SessionAutonomousContinuation["getAutonomousStatus"]> {
		return this._autonomousContinuation.getAutonomousStatus(...args);
	}

	recordHostAutonomousContinuation(
		...args: Parameters<SessionAutonomousContinuation["recordHostAutonomousContinuation"]>
	): ReturnType<SessionAutonomousContinuation["recordHostAutonomousContinuation"]> {
		return this._autonomousContinuation.recordHostAutonomousContinuation(...args);
	}

	refreshAutonomousGates(
		...args: Parameters<SessionAutonomousContinuation["refreshAutonomousGates"]>
	): ReturnType<SessionAutonomousContinuation["refreshAutonomousGates"]> {
		return this._autonomousContinuation.refreshAutonomousGates(...args);
	}

	private _runWithAutonomousContinuationSuppressed<T>(fn: () => Promise<T>): Promise<T> {
		return this._autonomousContinuation.runWithAutonomousContinuationSuppressed(fn);
	}

	private _markAutonomousContinuationSuppressed(
		...args: Parameters<SessionAutonomousContinuation["markAutonomousContinuationSuppressed"]>
	): ReturnType<SessionAutonomousContinuation["markAutonomousContinuationSuppressed"]> {
		return this._autonomousContinuation.markAutonomousContinuationSuppressed(...args);
	}

	get scopedModels(): ReadonlyArray<{
		model: Model<any>;
		thinkingLevel?: ThinkingLevel;
	}> {
		return this._scopedModels;
	}

	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._modelSelection.setScopedModels(scopedModels);
	}

	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		return this._tools.rebuildSystemPrompt(toolNames);
	}

	private _refreshExtensionSystemPrompt(
		...args: Parameters<SessionTools["refreshExtensionSystemPrompt"]>
	): ReturnType<SessionTools["refreshExtensionSystemPrompt"]> {
		return this._tools.refreshExtensionSystemPrompt(...args);
	}

	private _normalizeSubmission(
		...args: Parameters<SubmissionNormalizer["normalizeSubmission"]>
	): ReturnType<SubmissionNormalizer["normalizeSubmission"]> {
		return this._submissionNormalizer.normalizeSubmission(...args);
	}

	private async _runPreTurnCompaction(): Promise<void> {
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false, false);
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

	promptAndWait(
		...args: Parameters<SessionMessageDelivery["promptAndWait"]>
	): ReturnType<SessionMessageDelivery["promptAndWait"]> {
		return this._messageDelivery.promptAndWait(...args);
	}

	acceptAgentMessagePrompt(
		...args: Parameters<SessionPromptSubmission["acceptAgentMessagePrompt"]>
	): ReturnType<SessionPromptSubmission["acceptAgentMessagePrompt"]> {
		return this._promptSubmission.acceptAgentMessagePrompt(...args);
	}

	queueAgentMessagePrompt(
		...args: Parameters<SessionPromptSubmission["queueAgentMessagePrompt"]>
	): ReturnType<SessionPromptSubmission["queueAgentMessagePrompt"]> {
		return this._promptSubmission.queueAgentMessagePrompt(...args);
	}

	async promptHeartbeat(job: AgentCronJob, options?: PromptOptions): Promise<void> {
		const message = createHeartbeatPromptMessage(job);
		await this._promptInjectedMessage(message.content, message, {
			...options,
			followUpQueueKey: options?.followUpQueueKey ?? `heartbeat:${job.id}`,
			resumeIfIdle: true,
		});
	}

	private _isRlmTerminalNoticeAction(
		...args: Parameters<SessionPendingContext["isRlmTerminalNoticeAction"]>
	): ReturnType<SessionPendingContext["isRlmTerminalNoticeAction"]> {
		return this._pendingContext.isRlmTerminalNoticeAction(...args);
	}

	private _hasDeferredRlmTerminalNotices(
		...args: Parameters<SessionPendingContext["hasDeferredRlmTerminalNotices"]>
	): ReturnType<SessionPendingContext["hasDeferredRlmTerminalNotices"]> {
		return this._pendingContext.hasDeferredRlmTerminalNotices(...args);
	}

	private _flushDeferredRlmTerminalNotices(
		...args: Parameters<SessionPendingContext["flushDeferredRlmTerminalNotices"]>
	): ReturnType<SessionPendingContext["flushDeferredRlmTerminalNotices"]> {
		return this._pendingContext.flushDeferredRlmTerminalNotices(...args);
	}

	private _deferRlmTerminalNotice(
		...args: Parameters<SessionPendingContext["deferRlmTerminalNotice"]>
	): ReturnType<SessionPendingContext["deferRlmTerminalNotice"]> {
		return this._pendingContext.deferRlmTerminalNotice(...args);
	}

	private _demoteRlmTerminalNoticeActions(
		...args: Parameters<SessionPendingContext["demoteRlmTerminalNoticeActions"]>
	): ReturnType<SessionPendingContext["demoteRlmTerminalNoticeActions"]> {
		return this._pendingContext.demoteRlmTerminalNoticeActions(...args);
	}

	private _promptInjectedMessage(
		...args: Parameters<SessionPromptSubmission["promptInjectedMessage"]>
	): ReturnType<SessionPromptSubmission["promptInjectedMessage"]> {
		return this._promptSubmission.promptInjectedMessage(...args);
	}

	private _prompt(
		...args: Parameters<SessionPromptSubmission["prompt"]>
	): ReturnType<SessionPromptSubmission["prompt"]> {
		return this._promptSubmission.prompt(...args);
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	steer(...args: Parameters<SessionPromptSubmission["steer"]>): ReturnType<SessionPromptSubmission["steer"]> {
		return this._promptSubmission.steer(...args);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	followUp(...args: Parameters<SessionPromptSubmission["followUp"]>): ReturnType<SessionPromptSubmission["followUp"]> {
		return this._promptSubmission.followUp(...args);
	}

	restoreSessionActions(
		...args: Parameters<SessionActionRecovery["restoreSessionActions"]>
	): ReturnType<SessionActionRecovery["restoreSessionActions"]> {
		return this._actionRecovery.restoreSessionActions(...args);
	}

	restoreSteeringMessage(
		...args: Parameters<SessionActionQueue["restoreSteeringMessage"]>
	): ReturnType<SessionActionQueue["restoreSteeringMessage"]> {
		return this._actionQueue.restoreSteeringMessage(...args);
	}

	restoreFollowUpMessage(
		...args: Parameters<SessionActionQueue["restoreFollowUpMessage"]>
	): ReturnType<SessionActionQueue["restoreFollowUpMessage"]> {
		return this._actionQueue.restoreFollowUpMessage(...args);
	}

	private _takePendingNextTurnMessages(
		...args: Parameters<SessionPendingContext["takePendingNextTurnMessages"]>
	): ReturnType<SessionPendingContext["takePendingNextTurnMessages"]> {
		return this._pendingContext.takePendingNextTurnMessages(...args);
	}

	private _assertSessionActionAdmissionAvailable(
		...args: Parameters<SessionInputAdmission["assertSessionActionAdmissionAvailable"]>
	): ReturnType<SessionInputAdmission["assertSessionActionAdmissionAvailable"]> {
		return this._inputAdmission.assertSessionActionAdmissionAvailable(...args);
	}

	private _admitSessionInput(
		...args: Parameters<SessionInputAdmission["admitSessionInput"]>
	): ReturnType<SessionInputAdmission["admitSessionInput"]> {
		return this._inputAdmission.admitSessionInput(...args);
	}

	private _queuePreparedPrompt(
		...args: Parameters<SessionInputAdmission["queuePreparedPrompt"]>
	): ReturnType<SessionInputAdmission["queuePreparedPrompt"]> {
		return this._inputAdmission.queuePreparedPrompt(...args);
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
		return this._actionQueue.hasPendingSessionWork;
	}

	get hasPendingAdmissionWaiters(): boolean {
		return this._commitFence.hasPendingWork || this._inputCheckpoints.hasWaiters;
	}

	private _scheduleSessionInputPump(): void {
		this._inputScheduler.schedule();
	}

	private _executeSelectedSessionCommand(
		...args: Parameters<SessionCommandExecution["executeSelectedSessionCommand"]>
	): ReturnType<SessionCommandExecution["executeSelectedSessionCommand"]> {
		return this._commandExecution.executeSelectedSessionCommand(...args);
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

	private _startPreparedTurnActions(
		...args: Parameters<SessionTurnExecution["startPreparedTurnActions"]>
	): ReturnType<SessionTurnExecution["startPreparedTurnActions"]> {
		return this._turnExecution.startPreparedTurnActions(...args);
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
	sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: {
			triggerTurn?: boolean;
			deliverAs?: "steer" | "followUp" | "nextTurn";
		},
	): Promise<void> {
		return this._promptSubmission.sendCustomMessage<T>(message, options);
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	sendUserMessage(
		...args: Parameters<SessionPromptSubmission["sendUserMessage"]>
	): ReturnType<SessionPromptSubmission["sendUserMessage"]> {
		return this._promptSubmission.sendUserMessage(...args);
	}

	clearQueue(...args: Parameters<SessionActionQueue["clearQueue"]>): ReturnType<SessionActionQueue["clearQueue"]> {
		return this._actionQueue.clearQueue(...args);
	}

	private _invalidateQueuedPromptPreparation(
		...args: Parameters<SessionActionQueue["invalidateQueuedPromptPreparation"]>
	): ReturnType<SessionActionQueue["invalidateQueuedPromptPreparation"]> {
		return this._actionQueue.invalidateQueuedPromptPreparation(...args);
	}

	clearQueuedAgentMessages(
		...args: Parameters<SessionActionQueue["clearQueuedAgentMessages"]>
	): ReturnType<SessionActionQueue["clearQueuedAgentMessages"]> {
		return this._actionQueue.clearQueuedAgentMessages(...args);
	}

	clearQueuedUserMessagesMatching(
		...args: Parameters<SessionActionQueue["clearQueuedUserMessagesMatching"]>
	): ReturnType<SessionActionQueue["clearQueuedUserMessagesMatching"]> {
		return this._actionQueue.clearQueuedUserMessagesMatching(...args);
	}

	/**
	 * Mutate a single visible queued message, addressed by its position in the same
	 * projection the session-action snapshot publishes. expectedText must match the
	 * item's current preview so clients never edit a shifted queue by accident.
	 */
	mutateQueuedMessage(
		...args: Parameters<SessionActionQueue["mutateQueuedMessage"]>
	): ReturnType<SessionActionQueue["mutateQueuedMessage"]> {
		return this._actionQueue.mutateQueuedMessage(...args);
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

	getSessionActionSnapshot(
		...args: Parameters<SessionActionQueue["getSessionActionSnapshot"]>
	): ReturnType<SessionActionQueue["getSessionActionSnapshot"]> {
		return this._actionQueue.getSessionActionSnapshot(...args);
	}

	getSteeringMessages(
		...args: Parameters<SessionActionQueue["getSteeringMessages"]>
	): ReturnType<SessionActionQueue["getSteeringMessages"]> {
		return this._actionQueue.getSteeringMessages(...args);
	}

	getSteeringMessagePreviews(
		...args: Parameters<SessionActionQueue["getSteeringMessagePreviews"]>
	): ReturnType<SessionActionQueue["getSteeringMessagePreviews"]> {
		return this._actionQueue.getSteeringMessagePreviews(...args);
	}

	getFollowUpMessages(
		...args: Parameters<SessionActionQueue["getFollowUpMessages"]>
	): ReturnType<SessionActionQueue["getFollowUpMessages"]> {
		return this._actionQueue.getFollowUpMessages(...args);
	}

	getFollowUpMessagePreviews(
		...args: Parameters<SessionActionQueue["getFollowUpMessagePreviews"]>
	): ReturnType<SessionActionQueue["getFollowUpMessagePreviews"]> {
		return this._actionQueue.getFollowUpMessagePreviews(...args);
	}

	getSessionActionRecoverySnapshot(
		...args: Parameters<SessionActionRecovery["getSessionActionRecoverySnapshot"]>
	): ReturnType<SessionActionRecovery["getSessionActionRecoverySnapshot"]> {
		return this._actionRecovery.getSessionActionRecoverySnapshot(...args);
	}

	private _notifySessionInputCheckpointChange(
		...args: Parameters<SessionInputCheckpoints["notifySessionInputCheckpointChange"]>
	): ReturnType<SessionInputCheckpoints["notifySessionInputCheckpointChange"]> {
		return this._inputCheckpoints.notifySessionInputCheckpointChange(...args);
	}

	private _waitForSessionActivityChange(
		...args: Parameters<SessionInputCheckpoints["waitForSessionActivityChange"]>
	): ReturnType<SessionInputCheckpoints["waitForSessionActivityChange"]> {
		return this._inputCheckpoints.waitForSessionActivityChange(...args);
	}

	private _observeSessionActionDeferral(
		...args: Parameters<SessionInputCheckpoints["observeSessionActionDeferral"]>
	): ReturnType<SessionInputCheckpoints["observeSessionActionDeferral"]> {
		return this._inputCheckpoints.observeSessionActionDeferral(...args);
	}

	waitForSessionInputCheckpoint(
		...args: Parameters<SessionInputCheckpoints["waitForSessionInputCheckpoint"]>
	): ReturnType<SessionInputCheckpoints["waitForSessionInputCheckpoint"]> {
		return this._inputCheckpoints.waitForSessionInputCheckpoint(...args);
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

	private _acquireDirectTurnAdmissionFence(
		...args: Parameters<SessionInputCheckpoints["acquireDirectTurnAdmissionFence"]>
	): ReturnType<SessionInputCheckpoints["acquireDirectTurnAdmissionFence"]> {
		return this._inputCheckpoints.acquireDirectTurnAdmissionFence(...args);
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
	private _waitForIdleOrSettlement(
		...args: Parameters<SessionInputCheckpoints["waitForIdleOrSettlement"]>
	): ReturnType<SessionInputCheckpoints["waitForIdleOrSettlement"]> {
		return this._inputCheckpoints.waitForIdleOrSettlement(...args);
	}

	/** Waits out any owned post-compaction continuation and rejects when one cannot start; {@link waitForIdle} never rejects. */
	waitForHeadlessIdle(): Promise<void> {
		return this._inputCheckpoints.waitForHeadlessIdle();
	}

	getPendingNextTurnMessageSnapshots(
		...args: Parameters<SessionPendingContext["getPendingNextTurnMessageSnapshots"]>
	): ReturnType<SessionPendingContext["getPendingNextTurnMessageSnapshots"]> {
		return this._pendingContext.getPendingNextTurnMessageSnapshots(...args);
	}

	restorePendingNextTurnMessages(
		...args: Parameters<SessionPendingContext["restorePendingNextTurnMessages"]>
	): ReturnType<SessionPendingContext["restorePendingNextTurnMessages"]> {
		return this._pendingContext.restorePendingNextTurnMessages(...args);
	}

	removeQueuedFollowUp(
		...args: Parameters<SessionActionQueue["removeQueuedFollowUp"]>
	): ReturnType<SessionActionQueue["removeQueuedFollowUp"]> {
		return this._actionQueue.removeQueuedFollowUp(...args);
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	requestAbort(): void {
		this._children.requestAbort();
		this._inputScheduler.suspend("abort");
		this._demoteRlmTerminalNoticeActions();
		this._cancelSessionActions(
			(action) =>
				action.payload.kind === "turn" &&
				!action.payload.queueVisible &&
				!this._pendingContext.isRetainedTerminalNotice(action.id),
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
		this._goalContinuation.beginAbort();
		try {
			await Promise.allSettled([
				this.agent.waitForIdle(),
				this._events.queue,
				...(compactionOperation ? [compactionOperation] : []),
				...(branchSummaryOperation ? [branchSummaryOperation] : []),
			]);
		} finally {
			this._goalContinuation.finishAbort();
		}
	}

	abortForUpdateRestart(): void {
		// Cancel scheduled pumps and suspend new ones: queued inputs must survive
		// into the restart manifest instead of starting a turn during teardown.
		this._inputScheduler.suspend("update-restart");
		this._cancelPostCompactionContinue();
		this.abortRetry();
		this._children.cancelQuiescenceWaits();
		this._cancelActiveRlmChildRuns("Parent session aborted for update restart");
		this._goalContinuation.beginAbort();
		this.agent.abort();
		if (this._goalContinuation.abortInProgress) {
			void this.agent
				.waitForIdle()
				.then(() => this._events.queue)
				.catch(() => undefined)
				.finally(() => {
					this._goalContinuation.finishAbort();
				});
		}
	}

	setModel(...args: Parameters<SessionModelSelection["setModel"]>): ReturnType<SessionModelSelection["setModel"]> {
		return this._modelSelection.setModel(...args);
	}

	private _pendingModelSelectEmit(
		...args: Parameters<SessionModelSelection["pendingModelSelectEmit"]>
	): ReturnType<SessionModelSelection["pendingModelSelectEmit"]> {
		return this._modelSelection.pendingModelSelectEmit(...args);
	}

	cycleModel(
		...args: Parameters<SessionModelSelection["cycleModel"]>
	): ReturnType<SessionModelSelection["cycleModel"]> {
		return this._modelSelection.cycleModel(...args);
	}

	setThinkingLevel(
		...args: Parameters<SessionModelSelection["setThinkingLevel"]>
	): ReturnType<SessionModelSelection["setThinkingLevel"]> {
		return this._modelSelection.setThinkingLevel(...args);
	}

	setServiceTier(
		...args: Parameters<SessionModelSelection["setServiceTier"]>
	): ReturnType<SessionModelSelection["setServiceTier"]> {
		return this._modelSelection.setServiceTier(...args);
	}

	cycleThinkingLevel(
		...args: Parameters<SessionModelSelection["cycleThinkingLevel"]>
	): ReturnType<SessionModelSelection["cycleThinkingLevel"]> {
		return this._modelSelection.cycleThinkingLevel(...args);
	}

	getAvailableThinkingLevels(
		...args: Parameters<SessionModelSelection["getAvailableThinkingLevels"]>
	): ReturnType<SessionModelSelection["getAvailableThinkingLevels"]> {
		return this._modelSelection.getAvailableThinkingLevels(...args);
	}

	supportsThinking(
		...args: Parameters<SessionModelSelection["supportsThinking"]>
	): ReturnType<SessionModelSelection["supportsThinking"]> {
		return this._modelSelection.supportsThinking(...args);
	}

	private _syncKernelStateAfterCompaction(): Promise<void> {
		return this._kernel.syncAfterCompaction();
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
			if (!this._goalContinuation.awaitsChildWork && !this.agent.hasQueuedMessages()) {
				this._goalContinuation.deferUntilChildSettlement();
			}
			this.resumeQueuedWork();
			if (this.agent.hasQueuedMessages()) this._schedulePostCompactionContinue();
		}
		if (hadPostCompactionContinue) {
			this._schedulePostCompactionContinue(continueAfterSessionInput);
		}
		// Queued agent or session-owned inputs resume the loop; defer refine
		// behind them instead of interleaving it before their turns.
		this._refinement._scheduleAutoRefineAfterCompaction(
			this._goalContinuation.awaitsChildWork ||
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

	private _reapDeletedRlmSubagentRuntimesAfterCompaction(): Promise<void> {
		return this._children.reapAfterCompaction();
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
	private _harnessDigest(
		...args: Parameters<SessionHarnessContext["harnessDigest"]>
	): ReturnType<SessionHarnessContext["harnessDigest"]> {
		return this._harnessContext.harnessDigest(...args);
	}

	/** Cold-boundary digest delivery: empty contexts defer to the first committed turn (untouched sessions must stay empty); non-empty contexts append only when the newest in-context digest mismatches disk. */
	private _ensureHarnessDigestContext(
		...args: Parameters<SessionHarnessContext["ensureHarnessDigestContext"]>
	): ReturnType<SessionHarnessContext["ensureHarnessDigestContext"]> {
		return this._harnessContext.ensureHarnessDigestContext(...args);
	}

	private _latestContextHarnessDigest(
		...args: Parameters<SessionHarnessContext["latestContextHarnessDigest"]>
	): ReturnType<SessionHarnessContext["latestContextHarnessDigest"]> {
		return this._harnessContext.latestContextHarnessDigest(...args);
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

	abortBranchSummary(
		...args: Parameters<SessionHistoryNavigation["abortBranchSummary"]>
	): ReturnType<SessionHistoryNavigation["abortBranchSummary"]> {
		return this._history.abortBranchSummary(...args);
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
		this._extensions.setExecEnvProvider(provider);
	}

	bindExtensions(bindings: ExtensionBindings): Promise<void> {
		return this._extensions.bindExtensions(bindings);
	}

	private _refreshCurrentModelFromRegistry(
		...args: Parameters<SessionModelSelection["refreshCurrentModelFromRegistry"]>
	): ReturnType<SessionModelSelection["refreshCurrentModelFromRegistry"]> {
		return this._modelSelection.refreshCurrentModelFromRegistry(...args);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		this._tools.refreshToolRegistry(options);
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const pythonSkills = getPythonSkillRuntimeInfo(this._modelVisibleSkills());
		this._tools.setBaseDefinitions(
			this._tools.buildBaseOverrides() ??
				this._tools.buildBuiltinDefinitions({
					ipython: {
						provisioner: this._kernel.prepare(pythonSkills),
						commandPrefix: this.settingsManager.getShellCommandPrefix(),
						shellPath: this.settingsManager.getShellPath(),
						onLateSentAgentMessage: (toolCallId, message) =>
							this._recordLateIpythonSentAgentMessage(toolCallId, message),
					},
				}),
		);
		this._extensions.build(options.flagValues);
		this._tools.updateAcpDefinitions();
		const baseActiveToolNames = [...(options.activeToolNames ?? this._tools.defaultActiveToolNames)];
		if (this._goals.state.status === "active" && this._includeGoals) baseActiveToolNames.push("ipython");
		this._refreshToolRegistry({
			activeToolNames: [...new Set(baseActiveToolNames)],
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
		this._kernel.finishBuild(this.getActiveToolNames());
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
		return createSessionKernelHostHandlers({
			runChild: (prompt, kwargs, code) => this.runRlmChild(prompt, kwargs, code),
			createSession: (prompt, kwargs) => this.createRlmSession(prompt, kwargs),
			findModels: (query, limit) => this.findRlmModels(query, limit),
			listSubagents: () => this.listRlmSubagents(),
			deleteSubagent: (target) => this.deleteRlmSubagent(target),
			handleBashCompletion: (details) => this._handleKernelBashCompletion(details),
			withdrawBashCompletion: (details) => this._actionQueue.withdrawAsyncBashCompletionNotice(details),
			getModel: () => this.model,
			includeGoals: this._includeGoals,
			includeCompactSkill: this._includeCompactSkill,
			isRefineAllowed: () => this._refinement._autoRefineAllowedForSession(),
			hasHeartbeatController: () => !!this._rlmHeartbeatController,
			getModelVisibleSkills: () => this._modelVisibleSkills(),
			getAgentMessageController: () => this._agentMessageController,
			hasObserveController: () => !!this._agentObserveController,
			getMcpManager: () => this._mcpManager,
			getDepth: () => this._childState.depth,
			awaitChildPublication: (selector) => this._awaitPendingRlmChildPublication(selector),
			recordParentReply: () => this._childState.recordReply(),
			handleGoal: (type, payload) => this.handleGoalHostRequest(type, payload),
			handleCompact: (type, payload) => this.handleCompactHostRequest(type, payload),
			handleRefine: (type, payload) => this.handleRefineHostRequest(type, payload),
			handleHeartbeat: (type, payload) => this.handleRlmHeartbeatHostRequest(type, payload),
			handleMessage: (type, payload) => this.handleAgentMessageHostRequest(type, payload),
			handleObserve: (type, payload) => this.handleAgentObserveHostRequest(type, payload),
		});
	}

	private _handleKernelBashCompletion(
		...args: Parameters<SessionPromptSubmission["handleKernelBashCompletion"]>
	): ReturnType<SessionPromptSubmission["handleKernelBashCompletion"]> {
		return this._promptSubmission.handleKernelBashCompletion(...args);
	}

	reload(): Promise<void> {
		return this._extensions.reload();
	}

	// Undefined when there's no persistent artifact dir (e.g. the viewer client):
	// don't mkdtemp here, since this runs on every kernel build but a viewer never
	// does RLM work. The temp dir is created lazily in _createChildRlmSessionDir.

	private _createChildRlmSessionDir(): string {
		return createChildSessionDir(() => this._ensureRlmSessionDir() ?? this._createEphemeralRlmSessionDir());
	}

	private _rlmKernelEnv(): Record<string, string> {
		return this._kernelEnvironment.buildEnv();
	}
	private _ensureRlmSessionDir(): string | undefined {
		return this._kernelEnvironment.ensureSessionDir();
	}
	private _createEphemeralRlmSessionDir(): string {
		return this._kernelEnvironment.createEphemeralSessionDir();
	}

	_contextTokensForCurrentMessages(): number | undefined {
		const last = this._findLastAssistantMessage();
		return last ? calculateContextTokens(last.usage) : undefined;
	}

	setCurrentRecap(recap: string | undefined): void {
		this._childState.setCurrentRecap(recap);
	}

	get repliedToParentSinceTask(): boolean | undefined {
		return this._childState.repliedSinceTask;
	}

	getCurrentRecap(): string | undefined {
		return this._childState.getCurrentRecap();
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
			rlmDepth: this._childState.depth + 1,
			rlmMaxDepth: this._childState.maxDepth,
			rlmParentNodeId: options.id,
			spawnedByRequestId: options.spawnedByRequestId,
		};
	}

	private async _createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime> {
		const host = this._children.getRuntimeHost();
		if (host) {
			return await host.createRlmSubagentRuntime(options);
		}

		return this._createInlineRlmSubagentRuntime(options);
	}

	private _createInlineRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): RlmSubagentRuntime {
		return createInlineChildRuntime(
			{
				cwd: this._cwd,
				agentDir: this._agentDir,
				agent: this.agent,
				settingsManager: this.settingsManager,
				resourceLoader: this._resourceLoader,
				modelRegistry: this._modelRegistry,
			},
			options,
		);
	}

	private _cancelActiveRlmChildRuns(reason: string): void {
		this._children.cancelActiveRuns(reason);
	}

	getRlmChildRunStatus(childId: string): RlmChildAgentStatus | undefined {
		return this._children.getRlmChildRunStatus(childId);
	}

	private _awaitPendingRlmChildPublication(selector: string): Promise<string | undefined> {
		return this._children.awaitPublication(selector);
	}

	listRlmSubagents(): Promise<RlmListSubagentsResult> {
		return this._children.listRlmSubagents();
	}

	deleteInactiveRlmSubagent(
		childId: string,
		isExternallyRunning: () => boolean = () => false,
	): Promise<"deleted" | "not_found" | "running"> {
		return this._children.deleteInactiveRlmSubagent(childId, isExternallyRunning);
	}

	deleteRlmSubagent(target: string): Promise<RlmDeleteSubagentResult> {
		return this._children.deleteRlmSubagent(target);
	}

	/**
	 * Retain a finished child session for the parent lifetime so inspectors and
	 * daemon-hosted agent messaging can keep addressing it. Returns false (and disposes
	 * the child) when the parent is already tearing down, so the caller can drop the
	 * matching event forwarder too.
	 */
	registerRlmChildSession(childId: string, session: AgentSession, unsubscribe?: () => void): boolean {
		return this._children.registerRlmChildSession(childId, session, unsubscribe);
	}

	releaseRlmChildSession(childId: string, session: AgentSession): (() => void) | false {
		return this._children.releaseRlmChildSession(childId, session);
	}

	/** Live recursive child roster from lifecycle state, including nested work under retained parents. */
	getRlmChildSnapshots(): RlmChildAgentSnapshot[] {
		return this._children.getRlmChildSnapshots();
	}

	/** True when any direct or nested subagent is still running or queued. */
	hasRunningRlmChildren(): boolean {
		return this._children.hasRunningRlmChildren();
	}

	private _hasUnsettledRlmQuiescenceWork(): boolean {
		return this._children.hasUnsettledWork();
	}

	/**
	 * Wait for every admitted descendant run to publish its terminal parent
	 * message and for the resulting parent turns to drain. Re-snapshotting after
	 * each drain includes descendants spawned while earlier results were consumed.
	 */
	waitForRlmQuiescence(externalSignal?: AbortSignal): Promise<void> {
		return this._children.waitForRlmQuiescence(externalSignal);
	}

	// Inline (non-daemon) mode only; daemon clients attach to the child session directly.
	getRlmChildSession(childId: string): AgentSession | undefined {
		return this._children.getRlmChildSession(childId);
	}

	/**
	 * Cancel a single RLM child run by id, searching nested child sessions.
	 *
	 * @returns true when a live run was cancelled or its unsettled terminal notice
	 * was suppressed; false when the id is unknown or the run already settled.
	 */
	cancelRlmChildRun(childId: string, reason = "Cancelled by user"): boolean {
		return this._children.cancelRlmChildRun(childId, reason);
	}

	/** Cancel every running or queued run in this session's subtree. */
	cancelRunningRlmDescendants(reason = "Cancelled by user"): boolean {
		return this._children.cancelRunningRlmDescendants(reason);
	}

	findRlmModels(
		...args: Parameters<SessionModelSelection["findRlmModels"]>
	): ReturnType<SessionModelSelection["findRlmModels"]> {
		return this._modelSelection.findRlmModels(...args);
	}

	private _resolveRlmSubagentModel(
		...args: Parameters<SessionModelSelection["resolveRlmSubagentModel"]>
	): ReturnType<SessionModelSelection["resolveRlmSubagentModel"]> {
		return this._modelSelection.resolveRlmSubagentModel(...args);
	}

	createRlmSession(prompt: string, kwargs: Record<string, unknown> = {}): Promise<RlmCreateSessionResult> {
		return this._children.createRlmSession(prompt, kwargs);
	}

	async runRlmChild(
		prompt: string,
		kwargs: Record<string, unknown> = {},
		spawnCode?: string,
	): Promise<RlmSpawnHandle> {
		return this._children.run(prompt, kwargs, spawnCode);
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
		return this._actionQueue.hasAcceptedPromptInFlight;
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
		return this._childState.getRlmMaxDepthStatus();
	}

	setRlmMaxDepth(maxDepth: number, options: { global?: boolean } = {}): Promise<SetRlmMaxDepthResult> {
		return this._childState.setRlmMaxDepth(maxDepth, options);
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

	navigateTree(
		...args: Parameters<SessionHistoryNavigation["navigateTree"]>
	): ReturnType<SessionHistoryNavigation["navigateTree"]> {
		return this._history.navigateTree(...args);
	}

	getUserMessagesForForking(
		...args: Parameters<SessionHistoryNavigation["getUserMessagesForForking"]>
	): ReturnType<SessionHistoryNavigation["getUserMessagesForForking"]> {
		return this._history.getUserMessagesForForking(...args);
	}

	getSessionStats(
		...args: Parameters<SessionContextView["getSessionStats"]>
	): ReturnType<SessionContextView["getSessionStats"]> {
		return this._contextView.getSessionStats(...args);
	}

	getContextUsage(
		...args: Parameters<SessionContextView["getContextUsage"]>
	): ReturnType<SessionContextView["getContextUsage"]> {
		return this._contextView.getContextUsage(...args);
	}

	private _rlmSessionDirForReading(): string | undefined {
		return this._rlmSessionDir ?? this.sessionManager.getSessionArtifactDir();
	}

	private *_contextViewChildren(): Generator<ContextViewChild> {
		for (const run of this._children.getActiveRuns()) {
			yield {
				id: run.id,
				get label() {
					return rlmChildLabel(run.prompt);
				},
				get status() {
					return run.status;
				},
				sessionDir: run.sessionDir,
				getContextTree: run.session ? () => run.session!.getContextTree() : undefined,
			};
		}
	}

	private _invalidateOwnUsage(): void {
		this._contextView.invalidateOwnUsage();
	}

	// Whole-file own spend, identical to the catalog scan so rows never shift at passivation.
	getOwnUsageSummary(
		...args: Parameters<SessionContextView["getOwnUsageSummary"]>
	): ReturnType<SessionContextView["getOwnUsageSummary"]> {
		return this._contextView.getOwnUsageSummary(...args);
	}

	/**
	 * Build the agent context overview for /context: this session as the root
	 * plus one node per RLM sub-agent, recursively. Running children are read
	 * from their live sessions; completed children from their persisted session
	 * dirs, so the tree survives child disposal and session resume.
	 */
	getContextTree(
		...args: Parameters<SessionContextView["getContextTree"]>
	): ReturnType<SessionContextView["getContextTree"]> {
		return this._contextView.getContextTree(...args);
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	exportToHtml(...args: Parameters<SessionExport["exportToHtml"]>): ReturnType<SessionExport["exportToHtml"]> {
		return this._export.exportToHtml(...args);
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(...args: Parameters<SessionExport["exportToJsonl"]>): ReturnType<SessionExport["exportToJsonl"]> {
		return this._export.exportToJsonl(...args);
	}

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(
		...args: Parameters<SessionContextView["getLastAssistantText"]>
	): ReturnType<SessionContextView["getLastAssistantText"]> {
		return this._contextView.getLastAssistantText(...args);
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
