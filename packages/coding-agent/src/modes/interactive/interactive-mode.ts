import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Message,
	type Model,
	type ServiceTier,
	supportsFastMode,
	type ToolCall,
} from "@earendil-works/pi-ai";
import { BUILTIN_MCP_CATALOG } from "@earendil-works/pi-ai/mcp";
import type {
	AutocompleteItem,
	AutocompleteProvider,
	EditorComponent,
	Keybinding,
	KeyId,
	MarkdownTheme,
	OverlayHandle,
	OverlayOptions,
	SlashCommand,
} from "@earendil-works/pi-tui";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	Loader,
	type LoaderIndicatorOptions,
	Markdown,
	matchesKey,
	ProcessTerminal,
	Spacer,
	setKeybindings,
	Text,
	TruncatedText,
	TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { spawn, spawnSync } from "child_process";
import {
	buildDaemonUpdateRestartReport,
	launchDaemonUpdateRestartCoordinator,
	resolveDaemonUpdateRestartSocketPath,
} from "../../cli/daemon-update-restart.js";
import {
	APP_NAME,
	APP_TITLE,
	getAgentDir,
	getAgentTracesLogPath,
	getDebugLogPath,
	getLogsDir,
	getShareViewerUrl,
	SELF_UPDATE_INTERACTIVE_CHILD_ENV,
	SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE,
	VERSION,
} from "../../config.js";
import {
	AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL,
	isAgentSessionMessage,
	startsAgentRun,
} from "../../core/agent-messages.js";
import {
	type AgentTracePreviewResult,
	type AgentTraceUploadAllResult,
	type AgentTraceUploadResult,
	getPrimeAgentTraceCredential,
	previewAgentTraceFile,
	uploadAgentTraceFile,
	uploadAllAgentTraces,
} from "../../core/agent-traces.js";
import { isNoModelsAvailableMessage } from "../../core/auth-guidance.js";
import {
	type AgentCronJob,
	type AgentHeartbeatManagementAction,
	DEFAULT_HEARTBEAT_DELIVERY_MODE,
	parseHeartbeatCommand,
} from "../../core/cron-jobs.js";
import type {
	AutocompleteProviderFactory,
	ContextUsage,
	EditorFactory,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
} from "../../core/extensions/index.js";
import { FooterDataProvider, type ReadonlyFooterDataProvider } from "../../core/footer-data-provider.js";
import { emptyGoalState, formatGoalUsage, GOAL_CONTEXT_PREVIEW_LABEL, type GoalState } from "../../core/goals.js";
import type { KernelSentAgentMessage } from "../../core/kernel/index.js";
import { type AppKeybinding, KeybindingsManager } from "../../core/keybindings.js";
import { runMcpManagementCommand } from "../../core/mcp/mcp-command.js";
import {
	bashOutputToText,
	COMPACTION_OUTCOME_CUSTOM_TYPE,
	type CustomMessage,
	createHeartbeatPromptMessage,
	HEARTBEAT_PROMPT_PREVIEW_LABEL,
	isCompactionOutcomeMessage,
	isRefinementOutcomeMessage,
	isSessionSlashCommandMessage,
	isSessionSlashCommandResultMessage,
	REFINEMENT_OUTCOME_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_CUSTOM_TYPE,
	SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE,
} from "../../core/messages.js";
import { findExactModelReferenceMatch, resolveModelScopeFromModels } from "../../core/model-resolver.js";
import { parseNewSessionCommand } from "../../core/new-session-command.js";
import { resolvePrimeAgentTracesBaseUrl } from "../../core/prime-inference-auth.js";
import { resolvePrimeInferencePostLoginModelAction } from "../../core/prime-inference-model-selection.js";
import { parseCommandArgs } from "../../core/prompt-templates.js";
import { formatMissingSessionCwdPrompt, MissingSessionCwdError } from "../../core/session-cwd.js";
import { SessionImportFileNotFoundError } from "../../core/session-import-errors.js";
import { resolveSessionPath, SessionSelectorError, SessionSelectorNotFoundError } from "../../core/session-resolver.js";
import { parseSkillBlock } from "../../core/skill-blocks.js";
import {
	BUILTIN_SLASH_COMMANDS,
	builtinSlashCommandTakesArgument,
	isBuiltinSlashCommandName,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
} from "../../core/slash-commands.js";
import {
	captureAgentCommandUsed,
	captureOnboardingCompleted,
	type TelemetryOnboardingOutcome,
} from "../../core/telemetry.js";
import { type TruncationResult, truncateTail } from "../../core/tools/truncate.js";
import { PRIME_BUTTERFLY_LOGO } from "../../themes/prime-logo.js";
import { getChangelogPath, parseChangelog } from "../../utils/changelog.js";
import { copyToClipboard } from "../../utils/clipboard.js";
import { readClipboardImage } from "../../utils/clipboard-image.js";
import { parseGitUrl } from "../../utils/git.js";
import { resizeImage } from "../../utils/image-resize.js";
import { getCwdRelativePath } from "../../utils/paths.js";
import { killTrackedDetachedChildren } from "../../utils/shell.js";
import { ensureTool, ensureToolWithStatus, formatMissingRipgrepMessage } from "../../utils/tools-manager.js";
import { checkForNewPiVersion } from "../../utils/version-check.js";
import type {
	AgentConnection,
	AgentConnectionExtensionUiRequest,
	AgentConnectionExtensionUiResponse,
	AgentConnectionHeartbeat,
	AgentConnectionModel,
	AgentConnectionModelCatalog,
	AgentConnectionQueuedMessageMutationStatus,
	AgentConnectionQueueState,
	AgentConnectionResourceDiagnostic,
	AgentConnectionResourceSnapshot,
	AgentConnectionRlmChildAgentSnapshot,
	AgentConnectionSessionContext,
	AgentConnectionSessionEvent,
	AgentConnectionSessionTreeNode,
	AgentConnectionSideQuestionEvent,
	AgentConnectionSlashCommand,
	AgentConnectionSnapshot,
	AgentConnectionSourceInfo,
	AgentConnectionState,
	AgentConnectionToolDefinition,
} from "../agent-connection/index.js";
import { AgentConnectionPromptAdmissionError } from "../agent-connection/index.js";
import { getModelArgumentCompletions } from "../model-autocomplete.js";
import {
	checkForPackageUpdates,
	checkTmuxKeyboardSetup,
	formatPackageUpdateNotice,
	formatUpdateAvailableNotice,
} from "../shared/startup-notices.js";
import { AGENT_ACTIVITY_LABELS, AgentActivityTracker, formatTokenCount } from "./agent-activity.js";
import { type AuthenticationResult, getAnthropicSubscriptionAuthWarning, ProviderAuthFlows } from "./auth-flows.js";
import { AgentMessageComponent } from "./components/agent-message.js";
import { ArminComponent } from "./components/armin.js";
import { AssistantMessageComponent } from "./components/assistant-message.js";
import { BashExecutionComponent } from "./components/bash-execution.js";
import { BorderedLoader } from "./components/bordered-loader.js";
import { BranchSummaryMessageComponent } from "./components/branch-summary-message.js";
import { type FullPaneOverlayOptions, showFullPaneOverlay } from "./components/centered-overlay.js";
import {
	CompactionOutcomeMessageComponent,
	MalformedCompactionOutcomeMessageComponent,
} from "./components/compaction-outcome-message.js";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.js";
import { ConfigurationMenuComponent, type ConfigurationMenuTab } from "./components/configuration-menu.js";
import { formatContextTree } from "./components/context-tree-format.js";
import { isCompactAgentMessageNeighbor } from "./components/conversation-components.js";
import { CountdownTimer } from "./components/countdown-timer.js";
import { CustomEditor } from "./components/custom-editor.js";
import { CustomMessageComponent } from "./components/custom-message.js";
import { DaxnutsComponent } from "./components/daxnuts.js";
import { DynamicBorder } from "./components/dynamic-border.js";
import { EarendilAnnouncementComponent } from "./components/earendil-announcement.js";
import { type FileChangeSummary, formatTotalChangeSummary, mergeTurnFileChanges } from "./components/edit-summary.js";
import { ExtensionEditorComponent } from "./components/extension-editor.js";
import { ExtensionInputComponent } from "./components/extension-input.js";
import { ExtensionSelectorComponent } from "./components/extension-selector.js";
import { FEATURE_HINT_ANIMATION_INTERVAL_MS, FeatureHintComponent } from "./components/feature-hint.js";
import { FooterComponent } from "./components/footer.js";
import { HeartbeatManagerComponent } from "./components/heartbeat-manager.js";
import { InjectedPromptMessageComponent, isInjectedPromptMessage } from "./components/injected-prompt-message.js";
import { formatKeyText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.js";
import { createMermaidMarkdownTransform } from "./components/mermaid.js";
import type { AuthSelectorProvider } from "./components/oauth-selector.js";
import { PrimeOnboardingSplashComponent } from "./components/prime-onboarding-splash.js";
import {
	MalformedRefinementOutcomeMessageComponent,
	RefinementOutcomeMessageComponent,
} from "./components/refinement-outcome-message.js";
import { ScopedModelsSelectorComponent } from "./components/scoped-models-selector.js";
import { SettingsSelectorComponent } from "./components/settings-selector.js";
import { SideQuestionComponent } from "./components/side-question.js";
import { SkillInvocationMessageComponent } from "./components/skill-invocation-message.js";
import {
	isLeadingSlashCommand,
	SlashCommandMessageComponent,
	styleSlashCommandText,
} from "./components/slash-command-message.js";
import { SlashCommandResultMessageComponent } from "./components/slash-command-result-message.js";
import { countDirectSubagentStatuses, SubagentSummaryLine } from "./components/subagent-summary-line.js";
import { ThinkingSelectorComponent } from "./components/thinking-selector.js";
import {
	selectLatestToolExpandHint,
	ToolExecutionComponent,
	type ToolExecutionDefinition,
} from "./components/tool-execution.js";
import { TreeSelectorComponent } from "./components/tree-selector.js";
import { UserMessageComponent } from "./components/user-message.js";
import { UserMessageSelectorComponent } from "./components/user-message-selector.js";
import { FeatureHintDeck } from "./feature-hints.js";
import { scopeHeartbeatsToSession } from "./heartbeat-scope.js";
import {
	collectMarkedImages,
	evictImagesToBudget,
	formatImageMarker,
	imageMarkerIds,
	remapImageMarkers,
} from "./image-markers.js";
import type {
	InteractiveModeLocalSessionHost,
	InteractiveModeLocalToolRendererDefinition,
	InteractiveModeUiServices,
} from "./interactive-mode-services.js";
import {
	isOnboardingModelReady,
	type OnboardingStartupState,
	shouldRunOnboarding,
	shouldRunPrimeCliOnboardingSplash,
} from "./onboarding.js";
import type { ClientPromptStashStore, PromptStash, PromptStashState } from "./prompt-stash-state.js";
import { QueueSelection, type QueueSelectionItem } from "./queue-selection.js";
import { formatResumeHint } from "./resume-hint.js";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	setTheme,
	setThemeInstance,
	stopThemeWatcher,
	Theme,
	type ThemeColor,
	theme,
} from "./theme/theme.js";
import { setWorkingPulseFrame, WORKING_ICON_INTERVAL_MS } from "./theme/working-icon.js";

interface Expandable {
	setExpanded(expanded: boolean): void;
}

interface PendingToolCallRenderInput {
	id: string;
	name: string;
	arguments: ToolCall["arguments"];
}

const HEARTBEAT_LEGACY_PROMPT_MIN_TOLERANCE_MS = 15_000;
const HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS = 120_000;
const MODEL_CATALOG_REFRESH_TTL_MS = 60_000;
const FEATURE_HINT_DELAY_MS = 5_000;

export const START_HINTS = [
	'Try "refactor @<filepath>"',
	'Try "fix bugs in @<filepath>"',
	'Try "add tests for @<filepath>"',
	'Try "explain how @<filepath> works"',
	'Try "improve performance in @<filepath>"',
] as const;

export function getRandomStartHint(random = Math.random): (typeof START_HINTS)[number] {
	return START_HINTS[Math.floor(random() * START_HINTS.length)] ?? START_HINTS[0];
}

function isLabeledQueuedPreview(message: string): boolean {
	return (
		message.startsWith(`${HEARTBEAT_PROMPT_PREVIEW_LABEL}: `) ||
		message.startsWith(`${GOAL_CONTEXT_PREVIEW_LABEL}: `) ||
		message.startsWith(`${AGENT_MESSAGE_RECEIVED_PREVIEW_LABEL}: `)
	);
}

export function formatQueuedMessagePreview(message: string, label: "Steering" | "Follow-up"): string {
	return isLabeledQueuedPreview(message) ? message : `${label}: ${message}`;
}

export function styleQueuedMessagePreview(
	message: string,
	label: "Steering" | "Follow-up",
	isRecognizedSlashCommand: (name: string) => boolean,
): string {
	const preview = formatQueuedMessagePreview(message, label);
	if (!isLeadingSlashCommand(message, isRecognizedSlashCommand)) return theme.fg("dim", preview);
	const prefix = preview.slice(0, preview.length - message.length);
	return `${theme.fg("dim", prefix)}${styleSlashCommandText(message, (rest) => theme.fg("dim", rest))}`;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

interface AgentMessagesExpandable {
	setAgentMessagesExpanded(expanded: boolean): void;
}

function hasAgentMessagesExpansion(obj: unknown): obj is AgentMessagesExpandable {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"setAgentMessagesExpanded" in obj &&
		typeof (obj as AgentMessagesExpandable).setAgentMessagesExpanded === "function"
	);
}

interface EditDiffsExpandable {
	setEditDiffsExpanded(expanded: boolean): void;
}

function hasEditDiffsExpansion(obj: unknown): obj is EditDiffsExpandable {
	return (
		typeof obj === "object" &&
		obj !== null &&
		"setEditDiffsExpanded" in obj &&
		typeof (obj as EditDiffsExpandable).setEditDiffsExpanded === "function"
	);
}

class ExpandableText extends Text implements Expandable {
	constructor(
		private readonly getCollapsedText: () => string,
		private readonly getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		super(expanded ? getExpandedText() : getCollapsedText(), paddingX, paddingY);
	}

	setExpanded(expanded: boolean): void {
		this.setText(expanded ? this.getExpandedText() : this.getCollapsedText());
	}
}

export function formatSplashCwd(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/");
	const home = os.homedir().replace(/\\/g, "/");
	if (home && normalized === home) {
		return "~";
	}
	if (home && normalized.startsWith(`${home}/`)) {
		return `~${normalized.slice(home.length)}`;
	}

	return normalized;
}

function mergeSubagentSnapshot(
	previous: AgentConnectionRlmChildAgentSnapshot,
	incoming: AgentConnectionRlmChildAgentSnapshot,
): AgentConnectionRlmChildAgentSnapshot {
	const active = incoming.status === "running" || incoming.status === "queued";
	return {
		...previous,
		...incoming,
		parentId: incoming.parentId ?? previous.parentId,
		// Active updates may omit a previously known daemon session id, but a
		// terminal update without one means the child is no longer resident.
		activeSessionId: active ? (incoming.activeSessionId ?? previous.activeSessionId) : incoming.activeSessionId,
		// A completed retained child can become active again when it receives a
		// follow-up. Its RLM run status stays terminal, so activity must remain an
		// independent projection of the live session state.
		activity: active ? (incoming.activity ?? previous.activity) : incoming.activity,
	};
}

export function truncatePathMiddle(value: string, width: number): string {
	if (visibleWidth(value) <= width) {
		return value;
	}
	if (width <= 1) {
		return truncateToWidth(value, width, "");
	}

	const ellipsis = "…";
	const normalized = value.replace(/\\/g, "/");
	const prefix = normalized.startsWith("~/") ? "~/" : normalized.startsWith("/") ? "/" : "";
	const body = prefix ? normalized.slice(prefix.length) : normalized;
	const parts = body.split("/").filter((part) => part.length > 0);
	const last = parts.pop() ?? "";
	const previous = parts.pop();
	const suffix = previous ? `${previous}/${last}` : last;
	const candidate = `${prefix}${ellipsis}/${suffix}`;
	if (visibleWidth(candidate) <= width) {
		return candidate;
	}

	return truncateToWidth(candidate, width);
}

export interface BrandSplashMetadataLine {
	label: string;
	value: string;
}

export interface BrandSplashHeaderOptions {
	logo?: string;
	topPadding?: boolean;
	getExtraMetadata?: () => readonly BrandSplashMetadataLine[];
	getHideStartHint?: () => boolean;
	getStartHint?: () => string;
}

export class BrandSplashHeader implements Component {
	private readonly logoRaw: string[];
	private readonly logoCanvasWidth: number;
	private readonly gutter = 4;
	private readonly labelWidth = 9;

	constructor(
		private readonly version: string,
		private readonly getModelId: () => string | undefined,
		private readonly getCwd: () => string,
		private readonly verboseInstructions?: string,
		private readonly options: BrandSplashHeaderOptions = {},
	) {
		this.logoRaw = (options.logo ?? PRIME_BUTTERFLY_LOGO).split("\n");
		this.logoCanvasWidth = this.logoRaw.reduce((max, line) => Math.max(max, visibleWidth(line)), 0);
	}

	invalidate(): void {
		// Render output is derived from current theme/session state.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const paddingX = safeWidth > 1 ? 1 : 0;
		const contentWidth = Math.max(1, safeWidth - paddingX * 2);
		const metaWidth = contentWidth - this.logoCanvasWidth - this.gutter;
		const showMeta = metaWidth >= this.labelWidth + 8;
		const valueWidth = Math.max(1, metaWidth - this.labelWidth);
		const labelled = (label: string, value: string) => {
			const displayValue =
				label === "cwd" ? truncatePathMiddle(value, valueWidth) : truncateToWidth(value, valueWidth);
			return theme.fg("dim", label.padEnd(this.labelWidth)) + theme.fg("muted", displayValue);
		};
		const extraMetadata = this.options.getExtraMetadata?.() ?? [];
		const hideStartHint = this.options.getHideStartHint?.() ?? false;
		const startHint = this.options.getStartHint?.() ?? "type to search sessions";
		const metaLines = showMeta
			? [
					labelled("version", `v${this.version}`),
					labelled("model", this.getModelId() ?? "—"),
					labelled("cwd", formatSplashCwd(this.getCwd())),
					...extraMetadata.map((line) => labelled(line.label, line.value)),
					...(hideStartHint ? [] : ["", theme.fg("dim", startHint)]),
				]
			: [];
		const metaStart = Math.max(0, Math.floor((this.logoRaw.length - metaLines.length) / 2));
		const lines = this.options.topPadding ? [""] : [];
		lines.push(
			...this.logoRaw.map((line, index) => {
				const colored = theme.fg("text", line);
				const meta = index >= metaStart && index < metaStart + metaLines.length ? metaLines[index - metaStart] : "";
				const padding = showMeta
					? " ".repeat(Math.max(0, this.logoCanvasWidth - visibleWidth(line) + this.gutter))
					: "";
				const content = truncateToWidth(colored + padding + meta, contentWidth, "");
				return (
					" ".repeat(paddingX) + content + " ".repeat(Math.max(0, safeWidth - paddingX - visibleWidth(content)))
				);
			}),
		);

		if (this.verboseInstructions) {
			lines.push(" ".repeat(safeWidth));
			for (const instruction of this.verboseInstructions.split("\n")) {
				const content = truncateToWidth(instruction, contentWidth);
				lines.push(
					" ".repeat(paddingX) + content + " ".repeat(Math.max(0, safeWidth - paddingX - visibleWidth(content))),
				);
			}
		}

		return lines;
	}
}

type StartupPromptBarrierOutcome = "admitted" | "retained" | "lifecycle-cancelled";

type GoalAnnouncementSnapshot = {
	goalId?: string;
	status: GoalState["status"];
	objective?: string;
	lastReason?: string;
	lastError?: string;
};

type ModelFallbackWarningAction = "show" | "suppress";

interface OnboardingSplashHandle {
	showProgress(message: string): void;
	dismiss(): void;
}

const THINKING_LEVEL_DESCRIPTIONS: Record<ThinkingLevel, string> = {
	off: "No reasoning",
	minimal: "Very brief reasoning",
	low: "Light reasoning",
	medium: "Moderate reasoning",
	high: "Deep reasoning",
	xhigh: "Very deep reasoning",
	max: "Maximum reasoning",
};

const HEARTBEAT_ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
	{
		value: "every ",
		label: "every <duration> <instruction>",
		description: "Set an interval, then add an instruction: /heartbeat every 10s Scan the logs",
	},
	{
		value: "--steer ",
		label: "--steer <instruction>",
		description: "Deliver by interrupting the current turn (default)",
	},
	{
		value: "--follow-up ",
		label: "--follow-up <instruction>",
		description: "Deliver as a follow-up after the current turn finishes",
	},
];

const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);

// Cap on retained pasted-image bytes (base64). Images are resized below the
// inline limit before storing, so this holds many recent pastes; the oldest are
// evicted past the cap to keep a long session bounded.
const MAX_PASTED_IMAGE_BYTES = 64 * 1024 * 1024;
const INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT = 400;

function initialRenderMessages(messages: AgentMessage[]): AgentMessage[] {
	if (messages.length <= INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT) {
		return messages;
	}
	const toolCallMessages = new Map<string, { index: number; message: Extract<AgentMessage, { role: "assistant" }> }>();
	for (const [index, message] of messages.entries()) {
		if (message.role !== "assistant") {
			continue;
		}
		for (const content of message.content) {
			if (content.type === "toolCall") {
				toolCallMessages.set(content.id, { index, message });
			}
		}
	}

	const initialStartIndex = messages.length - INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT;
	for (let startIndex = initialStartIndex; startIndex < messages.length; startIndex++) {
		const visibleMessages = messages.slice(startIndex);
		const visibleToolCallIds = new Set<string>();
		for (const message of visibleMessages) {
			if (message.role !== "assistant") {
				continue;
			}
			for (const content of message.content) {
				if (content.type === "toolCall") {
					visibleToolCallIds.add(content.id);
				}
			}
		}

		const requiredToolCallIdsByMessage = new Map<
			number,
			{ message: Extract<AgentMessage, { role: "assistant" }>; toolCallIds: Set<string> }
		>();
		for (const message of visibleMessages) {
			if (message.role !== "toolResult" || visibleToolCallIds.has(message.toolCallId)) {
				continue;
			}
			const toolCallMessage = toolCallMessages.get(message.toolCallId);
			if (!toolCallMessage || toolCallMessage.index >= startIndex) {
				continue;
			}
			const requiredMessage = requiredToolCallIdsByMessage.get(toolCallMessage.index) ?? {
				message: toolCallMessage.message,
				toolCallIds: new Set<string>(),
			};
			requiredMessage.toolCallIds.add(message.toolCallId);
			requiredToolCallIdsByMessage.set(toolCallMessage.index, requiredMessage);
		}

		if (visibleMessages.length + requiredToolCallIdsByMessage.size > INITIAL_TRANSCRIPT_RENDER_MESSAGE_LIMIT) {
			continue;
		}

		const requiredToolCallMessages = [...requiredToolCallIdsByMessage.entries()]
			.sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
			.map(([, { message, toolCallIds }]) => ({
				...message,
				content: message.content.filter((content) => content.type !== "toolCall" || toolCallIds.has(content.id)),
			}));
		return omitOrphanToolResults([...requiredToolCallMessages, ...visibleMessages]);
	}

	return [];
}

function omitOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
	const renderedToolCallIds = new Set<string>();
	const renderableMessages: AgentMessage[] = [];
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const content of message.content) {
				if (content.type === "toolCall") {
					renderedToolCallIds.add(content.id);
				}
			}
			renderableMessages.push(message);
		} else if (message.role === "toolResult") {
			if (renderedToolCallIds.has(message.toolCallId)) {
				renderableMessages.push(message);
			}
		} else {
			renderableMessages.push(message);
		}
	}
	return renderableMessages;
}

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function getPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" ? value : undefined;
}

function getPayloadNumber(payload: Record<string, unknown>, key: string): number | undefined {
	const value = payload[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getPayloadBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
	const value = payload[key];
	return typeof value === "boolean" ? value : undefined;
}

function getPayloadStringArray(payload: Record<string, unknown>, key: string): string[] | undefined {
	const value = payload[key];
	if (value === undefined) {
		return undefined;
	}
	return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined;
}

function getPayloadNotifyType(payload: Record<string, unknown>, key: string): "info" | "warning" | "error" | undefined {
	const value = payload[key];
	return value === "info" || value === "warning" || value === "error" ? value : undefined;
}

function getPayloadWidgetPlacement(
	payload: Record<string, unknown>,
	key: string,
): "aboveEditor" | "belowEditor" | undefined {
	const value = payload[key];
	return value === "aboveEditor" || value === "belowEditor" ? value : undefined;
}

function getPayloadWorkingIndicatorOptions(
	payload: Record<string, unknown>,
	key: string,
): LoaderIndicatorOptions | undefined {
	const value = payload[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return undefined;
	}
	const optionsPayload = value as Record<string, unknown>;
	const frames = getPayloadStringArray(optionsPayload, "frames");
	const intervalMs = getPayloadNumber(optionsPayload, "intervalMs");
	return {
		...(frames === undefined ? {} : { frames }),
		...(intervalMs === undefined ? {} : { intervalMs }),
	};
}

export function updateArgsIncludeSelf(args: readonly string[]): boolean {
	let selfFlag = false;
	let extensionsOnlyFlag = false;
	let positional: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--self") {
			selfFlag = true;
		} else if (arg === "--extensions") {
			extensionsOnlyFlag = true;
		} else if (arg === "--extension") {
			extensionsOnlyFlag = true;
			index++;
		} else if (arg === "--daemon-socket") {
			index++;
		} else if (arg && !arg.startsWith("-") && positional === undefined) {
			positional = arg;
		}
	}
	if (selfFlag) {
		return true;
	}
	if (extensionsOnlyFlag) {
		return false;
	}
	if (!positional) {
		return true;
	}
	const normalized = positional.toLowerCase();
	return normalized === "self" || normalized === "pi" || normalized === APP_NAME.toLowerCase();
}

function argsIncludeSessionSelection(args: readonly string[]): boolean {
	for (const arg of args) {
		if (arg === "--resume" || arg === "-r" || arg === "--continue" || arg === "-c" || arg === "--fork") {
			return true;
		}
	}
	return false;
}

export function buildUpdateRelaunchArgs(args: readonly string[], sessionFile: string | undefined): string[] {
	const relaunchArgs = [...args];
	if (sessionFile && !argsIncludeSessionSelection(relaunchArgs)) {
		relaunchArgs.push("--resume", sessionFile);
	}
	return relaunchArgs;
}

export function buildUpdateChildArgs(args: readonly string[], daemonSocketPath: string): string[] {
	return args.includes("--daemon-socket") ? [...args] : [...args, "--daemon-socket", daemonSocketPath];
}

export function resolveInteractiveUpdateDaemonSocketPath(
	args: readonly string[],
	activeDaemonSocketPath: string,
): string {
	const socketFlagIndex = args.indexOf("--daemon-socket");
	return socketFlagIndex === -1 ? activeDaemonSocketPath : (args[socketFlagIndex + 1] ?? activeDaemonSocketPath);
}

export interface InteractiveInitialPrompt {
	text: string;
	images?: ImageContent[];
}

export interface InteractiveModeOptions {
	/** Providers that were migrated to auth.json (shows warning) */
	migratedProviders?: string[];
	/** Warning message if session model couldn't be restored */
	modelFallbackMessage?: string;
	/** One-off warning shown on startup. */
	startupNotice?: string;
	/** Initial message to send on startup (can include @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
	/** Additional text-only messages to send after the initial message. */
	initialMessages?: string[];
	/** Additional image-bearing prompts to send after the initial messages. */
	initialPrompts?: InteractiveInitialPrompt[];
	/** Force verbose startup (overrides quietStartup setting) */
	verbose?: boolean;
	/** Agent execution boundary. InteractiveMode never talks directly to AgentSession for core execution. */
	agentConnection: AgentConnection;
	/** Exact daemon socket to preserve across an interactive self-update restart. */
	daemonSocketPath?: string;
	/**
	 * Local-only host for in-process extension binding and callback-bearing session operations.
	 * This must remain optional adapter glue, not a generic execution dependency.
	 */
	localSessionHost?: InteractiveModeLocalSessionHost;
	/** Bind extension handlers in the local session host. Disabled for daemon/gateway-backed clients. */
	bindLocalSessionExtensions?: boolean;
	/** UI-local services used for settings, auth, resources, and rendering. Defaults to services from localSessionHost. */
	uiServices?: InteractiveModeUiServices;
	/** Extra cleanup for externally-owned UI service hosts. Runs after the connection is disposed and before process exit. */
	onShutdown?: () => void | Promise<void>;
	/** Allow returning from a full session to the agents view without stopping the daemon-owned agent. */
	returnToAgentsView?: boolean;
	/** Enter fullscreen regardless of the persisted fullscreen preference. */
	forceFullscreen?: boolean;
	/**
	 * The agents view already surfaced global startup notices (app/extension updates, tmux setup),
	 * so this session must not repeat them in its chat stream. Distinct from `returnToAgentsView`,
	 * which also covers direct daemon attaches where the agents view was never shown.
	 */
	agentsViewOwnsStartupNotices?: boolean;
	/** Persisted RLM depth supplied by the daemon SessionSummary. */
	sessionDepth?: number;
	/** Whether the unified daemon/catalog projection had any direct children. */
	sessionHasChildren?: boolean;
	/** Client-owned stash store shared across chat views in this TUI process. */
	promptStashStore?: ClientPromptStashStore;
	/** Initial stable session id used to scope prompt stash state. */
	promptStashSessionId?: string;
}

export interface InteractiveModeRunResult {
	type: "agents_view" | "scoped_agents_view";
	source: Pick<AgentConnectionState, "activeSessionId" | "sessionFile" | "sessionId" | "sessionName" | "cwd">;
}

export function formatAgentDepthLabel(depth: number | undefined, hasChildren: boolean): string | undefined {
	if (depth === undefined || (depth === 0 && !hasChildren)) return undefined;
	return `depth ${depth}`;
}

export class InteractiveMode {
	private static readonly EXIT_HINT_DURATION_MS = 2000;
	private static readonly ESCAPE_REPEAT_WINDOW_MS = 500;

	private uiServices: InteractiveModeUiServices;
	private agentConnection: AgentConnection;
	private localSessionHost: InteractiveModeLocalSessionHost | undefined;
	private bindLocalSessionExtensions: boolean;
	private ui: TUI;
	private chatContainer: Container;
	private shortcutGuideContainer: Container;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private queuedMessagesContainer: Container;
	private sideQuestionContainer: Container;
	private featureHintContainer: Container;
	private defaultEditor: CustomEditor;
	private editor: EditorComponent;
	private readonly promptStashStore: ClientPromptStashStore | undefined;
	private promptStashSessionId: string | undefined;
	private promptStashState: PromptStashState;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private mainContainer: Container;
	private mainViewContainer: Container;
	// prompt bar (editor + footer slot) — the only thing pinned to the bottom in fullscreen
	private promptDock: Container;
	// wraps the active footer so custom-footer swaps reflect in both layouts
	private footerSlot: Container;
	private fullscreenEnabled = false;
	private editorContainer: Container;
	private footer: FooterComponent;
	private footerDataProvider: FooterDataProvider;
	// Stored so the same manager can be injected into custom editors, selectors, and extension UI.
	private keybindings: KeybindingsManager;
	private version: string;
	private readonly startHint = getRandomStartHint();
	private isInitialized = false;
	private onInputCallback?: (text: string | undefined) => void;
	private submittedInputBehavior: "steer" | "followUp" = "steer";
	private latestEditorPromptStash: PromptStash | undefined;
	private pendingSubmittedPromptStash: PromptStash | undefined;
	private inputSubmissionGeneration = 0;
	private inputSubmissionsPending = 0;
	private pendingPromptStashReleases: { sessionId: string; state: PromptStashState }[] = [];
	private readonly retainedSubmissionGenerations = new WeakMap<PromptStash, number>();
	private admitPendingStartupPrompts: (() => Promise<StartupPromptBarrierOutcome>) | undefined;
	private agentsViewRequest: InteractiveModeRunResult["type"] | undefined;
	private loadingAnimation: Loader | undefined = undefined;
	private workingMessage: string | undefined = undefined;
	private workingVisible = true;
	private workingIndicatorOptions: LoaderIndicatorOptions | undefined = undefined;
	private workingStartedAt: number | undefined = undefined;
	// Start of the in-flight run; survives loader teardown so the elapsed display doesn't reset on re-entry.
	private turnStartedAt: number | undefined = undefined;
	private workingTimer: NodeJS.Timeout | undefined = undefined;
	private readonly featureHintDeck = new FeatureHintDeck();
	private currentFeatureHint: string | undefined;
	private featureHintEligibleAt = 0;
	private featureHintTimer: NodeJS.Timeout | undefined;
	private featureHintAnimationTimer: NodeJS.Timeout | undefined;
	private featureHintComponent: FeatureHintComponent | undefined;
	private featureHintRunPending = false;
	private featureHintSuppressedByQueue = false;
	private pulseTimer: NodeJS.Timeout | undefined = undefined;
	private pulseFrame = 0;
	private readonly activityTracker = new AgentActivityTracker();
	// activityTracker token count already folded into the context snapshot; only output beyond
	// this counts as live in-flight (keeps auto-retries from re-adding a failed attempt).
	private contextUsageTokenBaseline = 0;
	// Refresh ordering: a stale failure must never clobber a newer success.
	private contextUsageRefresh = { generation: 0, lastSuccessGeneration: 0 };
	private readonly defaultHiddenThinkingLabel = "Thinking...";
	private hiddenThinkingLabel = this.defaultHiddenThinkingLabel;

	private ctrlCExitHintExpiresAt = 0;
	private ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private escapeRepeatAction: "tree" | "clear" | undefined;
	private escapeRepeatExpiresAt = 0;
	private escapeRepeatTimer: ReturnType<typeof setTimeout> | undefined = undefined;
	private anthropicSubscriptionWarningShown = false;

	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: Text | undefined = undefined;
	private lastGoalAnnouncement: GoalAnnouncementSnapshot | undefined = undefined;
	private goalTrayTimer: NodeJS.Timeout | undefined = undefined;

	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;
	private sideQuestionComponent: SideQuestionComponent | undefined;
	private sideQuestionEvent: AgentConnectionSideQuestionEvent | undefined;
	private sideQuestionTurns: AgentConnectionSideQuestionEvent[] = [];
	private activeSideQuestionId: string | undefined;
	// Set while a ! bash command runs inside the side conversation: its
	// BashExecutionComponent renders inside the pane instead of the main chat.
	// bash_* events broadcast to every attached client, so runs correlate by
	// runId — the runId we generate here is echoed on our run's events.
	private sideQuestionBash: { runId: string; input: string; seedTranscript: boolean } | undefined;
	// The pane-mounted component of our own side run; bash_end seeds the side
	// transcript only when it ends this exact component.
	private sideQuestionBashComponent: BashExecutionComponent | undefined;
	// Holds the runId of a side bash abandoned at pane close: that run's
	// remaining bash_* events are swallowed (until its bash_end) instead of
	// leaking into the main transcript.
	private sideQuestionBashDiscarded: string | undefined;

	// User bash execution tracking (! / !! prefix), driven by bash_* session events
	private activeBashComponent: BashExecutionComponent | undefined = undefined;
	private pendingBashComponents: BashExecutionComponent[] = [];

	// Serializes session event handling; see subscribeToAgent
	private sessionEventQueue: Promise<void> = Promise.resolve();
	private sessionEventGeneration = 0;
	private fastModeToggleQueue: Promise<void> = Promise.resolve();

	private pendingTools = new Map<string, ToolExecutionComponent>();
	private ipythonToolComponents = new Map<string, ToolExecutionComponent>();
	private lateIpythonSentAgentMessages = new Map<string, KernelSentAgentMessage[]>();
	private pendingToolCreations = new Set<string>();
	private startedToolCalls = new Set<string>();
	private pendingToolGeneration = 0;
	private toolDefinitionCache = new Map<string, ToolExecutionDefinition | undefined>();
	private agentRunFileChanges = new Map<string, FileChangeSummary>();

	// One summary line below the editor, backed by the existing child-status stream.
	private subagentSummaryLine: SubagentSummaryLine;
	private subagentSnapshots = new Map<string, AgentConnectionRlmChildAgentSnapshot>();
	private rlmNodeId: string | undefined;

	private toolOutputExpanded = false;
	private agentMessagesExpanded = false;
	private editDiffsExpanded = false;

	private hideThinkingBlock = false;
	private readonly mermaidMarkdownTransform = createMermaidMarkdownTransform({
		getMode: () => this.settingsManager.getMermaidRenderingMode(),
		theme,
	});

	private skillCommands = new Map<string, string>();
	private connectionCommands: AgentConnectionSlashCommand[] = [];
	private connectionModelCatalog: AgentConnectionModel[] = [];
	private connectionConfiguredProviders = new Set<string>();
	private connectionModelsFetchedAt = 0;
	private connectionModelsRefreshVersion = 0;
	private connectionModelsRefreshInFlight: { version: number; promise: Promise<AgentConnectionModel[]> } | undefined;
	private connectionState: AgentConnectionState | undefined;
	private connectionResourceSnapshot: AgentConnectionResourceSnapshot | undefined;
	private heartbeatCatalog: AgentConnectionHeartbeat[] = [];
	private heartbeatRefreshPromise: Promise<void> | undefined;
	private heartbeatRefreshRequested = false;
	private heartbeatManager: HeartbeatManagerComponent | undefined;
	private heartbeatManagerHandle: OverlayHandle | undefined;
	private heartbeatManagerRefreshTimer: ReturnType<typeof setTimeout> | undefined;
	private heartbeatManagerRefreshAt: number | undefined;

	// Registry of images pasted this session, keyed by the `[image #N]` marker
	// shown to the user. Insertion-ordered; the bytes persist (bounded by
	// MAX_PASTED_IMAGE_BYTES) so a marker resolves to its image whenever the text
	// reappears — on submit, undo, history recall, retry, or dequeue. A submission
	// attaches only the images whose markers are present in the sent text.
	private pastedImages = new Map<number, ImageContent>();
	private nextImageMarkerId = 1;

	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	private autoCompactionLoader: Loader | undefined = undefined;
	private refineLoader: Loader | undefined = undefined;

	private retryLoader: Loader | undefined = undefined;
	private retryCountdown: CountdownTimer | undefined = undefined;
	private traceUploadAllAbortController: AbortController | undefined = undefined;

	private readonly queueSelection = new QueueSelection();
	private isApplyingQueueSelectionText = false;
	private queueMutationChain: Promise<void> = Promise.resolve();
	private pendingQueueEdit: symbol | undefined;
	private pendingQueueMove = false;

	private shutdownRequested = false;

	private extensionSelector: ExtensionSelectorComponent | undefined = undefined;
	private extensionInput: ExtensionInputComponent | undefined = undefined;
	private extensionEditor: ExtensionEditorComponent | undefined = undefined;
	private extensionTerminalInputUnsubscribers = new Set<() => void>();
	private activeConnectionExtensionUiRequests = new Map<string, { cancelLocal: () => void }>();

	private extensionWidgetsAbove = new Map<string, Component & { dispose?(): void }>();
	private extensionWidgetsBelow = new Map<string, Component & { dispose?(): void }>();
	private widgetContainerAbove!: Container;
	private widgetContainerBelow!: Container;

	// One-line recap of the agent's recent work, rendered just above the editor.
	private recapContainer!: Container;
	private sessionRecap: string | undefined;

	private customFooter: (Component & { dispose?(): void }) | undefined = undefined;

	private headerContainer: Container;

	private builtInHeader: Component | undefined = undefined;

	private customHeader: (Component & { dispose?(): void }) | undefined = undefined;

	private getLocalSessionHost(): InteractiveModeLocalSessionHost {
		if (!this.localSessionHost) {
			throw new Error("Local session host is not available in connection-backed interactive mode");
		}
		return this.localSessionHost;
	}
	private get settingsManager() {
		return this.uiServices.settingsManager;
	}
	private get modelRegistry() {
		return this.uiServices.modelRegistry;
	}

	constructor(private options: InteractiveModeOptions) {
		const uiServices = options.uiServices ?? options.localSessionHost?.createUiServices();
		if (!uiServices) {
			throw new Error("InteractiveMode requires uiServices when no localSessionHost is supplied");
		}
		this.uiServices = uiServices;
		this.agentConnection = options.agentConnection;
		this.promptStashStore = options.promptStashStore;
		this.promptStashSessionId = options.promptStashSessionId;
		this.promptStashState =
			this.promptStashStore && this.promptStashSessionId
				? this.promptStashStore.forSession(this.promptStashSessionId)
				: {};
		this.hydratePromptStash();
		this.localSessionHost = options.localSessionHost;
		this.bindLocalSessionExtensions = options.bindLocalSessionExtensions ?? options.localSessionHost !== undefined;
		if (this.bindLocalSessionExtensions && !options.localSessionHost) {
			throw new Error("Local extension binding requires localSessionHost");
		}
		this.agentConnection.onBeforeSessionInvalidate(() => {
			this.resetExtensionUI();
			this.resetSideQuestion();
		});
		this.version = VERSION;
		this.ui = new TUI(new ProcessTerminal(), this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		this.ui.onCopy = (text) => {
			void this.copyFullscreenSelection(text);
		};
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.shortcutGuideContainer = new Container();
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.queuedMessagesContainer = new Container();
		this.sideQuestionContainer = new Container();
		this.featureHintContainer = new Container();
		this.widgetContainerAbove = new Container();
		this.widgetContainerBelow = new Container();
		this.recapContainer = new Container();
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: editorPaddingX,
			autocompleteMaxVisible,
			isArgumentCommand: builtinSlashCommandTakesArgument,
			placeholder: this.startHint,
			placeholderColor: (text) => theme.fg("dim", text),
		});
		this.editor = this.defaultEditor;
		this.mainContainer = new Container();
		this.mainViewContainer = new Container();
		this.promptDock = new Container();
		this.footerSlot = new Container();
		this.mainViewContainer.addChild(this.chatContainer);
		this.mainViewContainer.addChild(this.shortcutGuideContainer);
		this.mainViewContainer.addChild(this.pendingMessagesContainer);
		this.mainViewContainer.addChild(this.statusContainer);
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor as Component);
		this.subagentSummaryLine = new SubagentSummaryLine(
			() => this.getTrayLocationLabel(),
			() => this.getTrayContextLabel(),
			() => this.getTrayOverrideLabel(),
		);
		this.subagentSummaryLine.setOpenable(this.options.returnToAgentsView === true);
		this.subagentSummaryLine.onOpen = () => void this.openScopedAgentsView();
		this.subagentSummaryLine.onCancel = () => this.focusEditor();
		this.subagentSummaryLine.onChatAction = (data) => this.handleSubagentSummaryChatAction(data);
		this.footerDataProvider = new FooterDataProvider(this.uiServices.getInitialCwd());
		this.footer = new FooterComponent(this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.settingsManager.getCompactionEnabled());
		this.setGoalAnnouncementBaseline(emptyGoalState());

		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();

		setRegisteredThemes(this.uiServices.getThemes());
		initTheme(this.settingsManager.getTheme(), true);
	}

	private get promptStash(): PromptStash | undefined {
		return this.promptStashState.stash;
	}

	private set promptStash(stash: PromptStash | undefined) {
		this.promptStashState.stash = stash;
	}

	private hydratePromptStash(): void {
		for (const stash of [this.promptStash, ...(this.promptStashState?.queuedStashes ?? [])]) {
			if (!stash) continue;
			for (const [markerId, image] of stash.images ?? []) {
				this.pastedImages.set(markerId, image);
				this.nextImageMarkerId = Math.max(this.nextImageMarkerId, markerId + 1);
			}
			for (const markerId of imageMarkerIds(stash.text)) {
				this.nextImageMarkerId = Math.max(this.nextImageMarkerId, markerId + 1);
			}
		}
	}

	private bindPromptStashSession(sessionId: string): void {
		if (!this.promptStashStore || this.promptStashSessionId === sessionId) {
			return;
		}
		this.releasePromptStashSession();
		this.promptStashSessionId = sessionId;
		this.promptStashState = this.promptStashStore.forSession(sessionId);
		this.hydratePromptStash();
	}

	private releasePromptStashSession(): void {
		if (this.inputSubmissionsPending > 0) {
			// Capture the pair: a rebind may repoint the fields before the deferred
			// release fires, and repeated rebinds/teardowns each defer their own pair.
			if (
				this.promptStashSessionId &&
				!this.pendingPromptStashReleases.some((pending) => pending.sessionId === this.promptStashSessionId)
			) {
				this.pendingPromptStashReleases.push({
					sessionId: this.promptStashSessionId,
					state: this.promptStashState,
				});
			}
			return;
		}
		const pending = this.pendingPromptStashReleases;
		this.pendingPromptStashReleases = [];
		if (!this.promptStashStore) return;
		for (const release of pending) {
			this.promptStashStore.release(release.sessionId, release.state);
		}
		if (this.promptStashSessionId) {
			this.promptStashStore.release(this.promptStashSessionId, this.promptStashState);
		}
	}

	private completeDeferredPromptStashRelease(): void {
		const pending = this.pendingPromptStashReleases;
		if (pending.length === 0) return;
		this.pendingPromptStashReleases = [];
		if (!this.promptStashStore) return;
		for (const release of pending) {
			this.promptStashStore.release(release.sessionId, release.state);
		}
	}

	private getAutocompleteSourceTag(sourceInfo?: AgentConnectionSourceInfo): string | undefined {
		if (!sourceInfo) {
			return undefined;
		}

		const scopePrefix =
			sourceInfo.scope === "user" ? "user" : sourceInfo.scope === "project" ? "project" : "temporary";
		const source = sourceInfo.source.trim();

		if (source === "builtin") {
			return "builtin";
		}

		if (source === "auto" || source === "local" || source === "cli") {
			return scopePrefix;
		}

		if (source.startsWith("npm:")) {
			return `${scopePrefix}:${source}`;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}

		return scopePrefix;
	}

	private getAutocompleteSourceLabel(sourceInfo?: AgentConnectionSourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		return sourceTag ? `#${sourceTag}` : undefined;
	}

	private getBuiltInCommandConflictDiagnostics(
		commands: readonly AgentConnectionSlashCommand[],
	): AgentConnectionResourceDiagnostic[] {
		return commands
			.filter((command) => command.source === "extension")
			.filter((command) => isBuiltinSlashCommandName(command.registeredName ?? command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.name === (command.registeredName ?? command.name)
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.registeredName}' conflicts with built-in interactive command. Available as '/${command.name}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private isRecognizedSlashCommand(name: string): boolean {
		return isBuiltinSlashCommandName(name) || this.connectionCommands.some((command) => command.name === name);
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.filter(
			(command) => command.name !== "fast" || this.currentModelSupportsFastMode(),
		).map((command) => ({
			name: command.name,
			aliases: command.aliases,
			description: command.description,
			argumentHint: command.argumentHint,
			takesArgument: command.takesArgument,
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				getModelArgumentCompletions(prefix, this.getCachedModelCandidates());
		}

		const effortCommand = slashCommands.find((command) => command.name === "effort");
		if (effortCommand) {
			effortCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getThinkingLevelCompletions(prefix);
			const levels = this.getAvailableThinkingLevels();
			if (levels.length > 0) {
				effortCommand.argumentHint = `[${levels.join("/")}]`;
			}
		}

		const heartbeatCommand = slashCommands.find((command) => command.name === "heartbeat");
		if (heartbeatCommand) {
			heartbeatCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				this.getHeartbeatArgumentCompletions(prefix);
		}

		const connectionCommands = this.connectionCommands;
		const templateCommands: SlashCommand[] = connectionCommands
			.filter((cmd) => cmd.source === "prompt")
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				sourceTag: this.getAutocompleteSourceLabel(cmd.sourceInfo),
				...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
			}));

		const extensionCommands: SlashCommand[] = connectionCommands
			.filter((cmd) => cmd.source === "extension")
			.filter((cmd) => !isBuiltinSlashCommandName(cmd.name))
			.map((cmd) => ({
				name: cmd.name,
				description: cmd.description,
				sourceTag: this.getAutocompleteSourceLabel(cmd.sourceInfo),
				getArgumentCompletions: this.bindLocalSessionExtensions
					? this.getLocalSessionHost().getExtensionRunner().getCommand(cmd.name)?.getArgumentCompletions
					: undefined,
			}));

		this.skillCommands.clear();
		const skillCommandList: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of connectionCommands.filter((cmd) => cmd.source === "skill")) {
				const commandName = skill.name;
				skillCommandList.push({
					name: commandName,
					description: skill.description,
					sourceTag: this.getAutocompleteSourceLabel(skill.sourceInfo),
				});
			}
		}

		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommandList],
			this.getCurrentCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
		}

		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.editor !== this.defaultEditor) {
			this.editor.setAutocompleteProvider?.(provider);
		}
	}

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();

		// Ensure fd and rg are available (downloads if missing, adds to PATH via getBinDir)
		// fd powers autocomplete, and rg is available for shell commands.
		const [fdPath, rgResult] = await Promise.all([ensureTool("fd"), ensureToolWithStatus("rg")]);
		this.fdPath = fdPath;
		if (rgResult.status === "unavailable") {
			this.showWarning(formatMissingRipgrepMessage(rgResult));
		}

		this.ui.addChild(this.headerContainer);

		// Brand splash: side-panel layout with structured runtime metadata on the right.
		// The model/cwd are read through live getters, so they fill in once the
		// connection state loads (rebindCurrentSession below). Onboarding, when
		// required, renders as a full-screen overlay on top of this header.
		if (this.options.verbose || !this.settingsManager.getQuietStartup()) {
			// Verbose: include the full keybinding cheatsheet under the brand mark.
			const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
			const verboseInstructions = this.options.verbose
				? [
						hint("app.clear", "to interrupt"),
						rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
						hint("app.input.clear", "to clear input"),
						hint("app.exit", "to exit (empty)"),
						hint("app.suspend", "to suspend"),
						keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
						rawKeyHint("/effort", "to set thinking level"),
						hint("app.model.select", "to select model"),
						hint("app.tools.expand", "to expand tools"),
						hint("app.messages.expand", "to expand agent messages"),
						hint("app.edits.expand", "to expand edit diffs"),
						hint("app.thinking.toggle", "to expand thinking"),
						hint("app.subagents.focus", "to inspect subagents"),
						hint("app.editor.external", "for external editor"),
						hint("app.prompt.stash", "to stash prompt"),
						rawKeyHint("/", "for commands"),
						hint("app.message.followUp", "to queue follow-up"),
						hint("app.message.navigateOlder", "to browse queued messages"),
						hint("app.clipboard.pasteImage", "to paste image"),
						rawKeyHint("drop files", "to attach"),
					].join("\n")
				: undefined;
			this.builtInHeader = new BrandSplashHeader(
				this.version,
				() => this.getCurrentModelId(),
				() => this.getCurrentCwd(),
				verboseInstructions,
				{
					topPadding: true,
					getHideStartHint: () => !this.isNewChat(),
					getStartHint: () => this.startHint,
				},
			);
			this.headerContainer.addChild(this.builtInHeader);
			this.headerContainer.addChild(new Spacer(1));
		} else {
			// Quiet startup: skip the splash and surrounding padding entirely.
			this.builtInHeader = new Text("", 0, 0);
			this.headerContainer.addChild(this.builtInHeader);
		}

		this.mainContainer.addChild(this.mainViewContainer);
		this.renderWidgets(); // Initialize with default spacer
		this.mainContainer.addChild(this.widgetContainerAbove);
		this.renderRecap();
		for (const container of this.getPromptContextContainers()) {
			this.mainContainer.addChild(container);
		}
		this.mainContainer.addChild(this.editorContainer);
		this.mainContainer.addChild(this.subagentSummaryLine);
		this.mainContainer.addChild(this.widgetContainerBelow);
		this.footerSlot.addChild(this.footer);
		this.mainContainer.addChild(this.footerSlot);
		for (const component of this.getPromptDockComponents()) {
			this.promptDock.addChild(component);
		}
		this.ui.addChild(this.mainContainer);
		this.ui.setFocus(this.editor);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		this.ui.start();
		this.fullscreenEnabled =
			(this.options.forceFullscreen === true || this.settingsManager.getFullscreen()) &&
			process.stdout.isTTY === true;
		if (this.fullscreenEnabled) {
			this.applyFullscreen(true);
		}
		this.isInitialized = true;

		await this.rebindCurrentSession();

		await this.renderInitialMessages();

		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this.footerDataProvider.onBranchChange(() => {
			this.ui.requestRender();
		});

		await this.updateAvailableProviderCount();
	}

	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.getCurrentCwd());
		const sessionName = this.getCurrentSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_TITLE} - ${cwdBasename}`);
		}
	}

	async run(): Promise<InteractiveModeRunResult> {
		await this.init();
		this.restorePromptStashOnOpen();

		// Global, environment-scoped notices (app update, extension updates, tmux setup)
		// belong on the agents view, not in a conversation. When the agents view already
		// showed them, skip the checks here entirely. (This is narrower than
		// `returnToAgentsView`, which is also set for direct daemon attaches that never
		// rendered the agents view and still want the in-session fallback.)
		const ownsGlobalStartupNotices = !this.options.agentsViewOwnsStartupNotices;
		const newVersionPromise = ownsGlobalStartupNotices ? checkForNewPiVersion(this.version) : undefined;
		const packageUpdatesPromise = ownsGlobalStartupNotices
			? checkForPackageUpdates({
					cwd: this.getCurrentCwd(),
					agentDir: getAgentDir(),
					settingsManager: this.settingsManager,
				})
			: undefined;
		const tmuxKeyboardWarningPromise = ownsGlobalStartupNotices ? checkTmuxKeyboardSetup() : undefined;

		const {
			migratedProviders,
			modelFallbackMessage,
			initialMessage,
			initialImages,
			initialMessages,
			initialPrompts,
		} = this.options;

		if (migratedProviders && migratedProviders.length > 0) {
			this.showWarning(`Migrated credentials to auth.json: ${migratedProviders.join(", ")}`);
		}

		if (this.options.startupNotice) {
			this.showWarning(this.options.startupNotice);
		}

		const modelsJsonError = this.modelRegistry.getError();
		if (modelsJsonError) {
			this.showError(`models.json error: ${modelsJsonError}`);
		}

		const startupPrompts: InteractiveInitialPrompt[] = [
			...(initialMessage ? [{ text: initialMessage, images: initialImages }] : []),
			...(initialMessages ?? []).map((text) => ({ text })),
			...(initialPrompts ?? []),
		];
		// One drive loop owns startup-prompt delivery: it retries on a 250ms cadence
		// while a model is missing or admission fails transiently, shows every
		// admission error, and skips a prompt after three failed attempts.
		// `startupPromptsSettled` is the user-submission barrier (startup prompts
		// stay ahead of user prompts). Its outcome distinguishes completed admission
		// from lifecycle cancellation so a resumed submit does not mutate torn-down
		// editor state or consume the client-owned durable stash.
		let startupPromptsDone = false;
		const startupAdmissionAbort = new AbortController();
		let settleStartupPrompts = (_outcome: StartupPromptBarrierOutcome) => {};
		const startupPromptsSettled = new Promise<StartupPromptBarrierOutcome>((resolve) => {
			settleStartupPrompts = (outcome) => {
				startupPromptsDone = true;
				resolve(outcome);
			};
		});
		/** Resolves false when the run lifecycle ended before the 250ms retry delay elapsed. */
		const startupRetryDelay = () =>
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(true), 250);
				timer.unref?.();
				void startupPromptsSettled.then(() => {
					clearTimeout(timer);
					resolve(false);
				});
			});
		const deliverStartupPrompts = async () => {
			let failures = 0;
			for (let next = 0; next < startupPrompts.length; ) {
				// The run lifecycle can settle the barrier while a prompt is being
				// admitted; stop instead of prompting a session we already left.
				if (startupPromptsDone) return;
				if (!this.getCurrentModel()) {
					if (!(await startupRetryDelay())) return;
					continue;
				}
				const prompt = startupPrompts[next]!;
				try {
					await this.agentConnection.prompt(prompt.text, {
						images: prompt.images,
						streamingBehavior: next === 0 ? "steer" : "followUp",
						queueIfBusy: true,
						signal: startupAdmissionAbort.signal,
					});
					failures = 0;
					next++;
				} catch (error) {
					if (startupPromptsDone || startupAdmissionAbort.signal.aborted) return;
					// An uncertain daemon admission may already be session-owned. Retrying
					// would duplicate it; only an acknowledged pre-ownership cancellation is safe.
					if (error instanceof AgentConnectionPromptAdmissionError && error.status === "owned") {
						failures = 0;
						next++;
						continue;
					}
					if (error instanceof AgentConnectionPromptAdmissionError && !error.cancelled) {
						// This attempt may already be session-owned, so never retry it. Preserve
						// it and every not-yet-attempted startup prompt in original order.
						this.retainStartupPromptDrafts(startupPrompts.slice(next));
						this.showError(error.message);
						settleStartupPrompts("retained");
						return;
					}
					const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
					if (++failures < 3) {
						this.showError(errorMessage);
						if (!(await startupRetryDelay())) return;
						continue;
					}
					this.showError(`Skipping startup prompt after 3 failed attempts: ${errorMessage}`);
					failures = 0;
					next++;
				}
			}
		};
		this.admitPendingStartupPrompts = startupPrompts.length > 0 ? () => startupPromptsSettled : undefined;

		let deferredStartupNotificationsShown = false;
		const showDeferredStartupNotifications = () => {
			if (deferredStartupNotificationsShown) {
				return;
			}
			deferredStartupNotificationsShown = true;

			// The agents view owns these for daemon sessions. When there is no agents view,
			// show them once at the top of a fresh session, but never append them under a
			// restored conversation where they read as disconnected clutter.
			if (!ownsGlobalStartupNotices || !this.isNewChat()) {
				return;
			}

			void newVersionPromise
				?.then((newVersion) => {
					if (newVersion) {
						this.showNewVersionNotification(newVersion);
					}
				})
				.catch(() => {});

			void packageUpdatesPromise
				?.then((updates) => {
					if (updates.length > 0) {
						this.showPackageUpdateNotification(updates);
					}
				})
				.catch(() => {});

			void tmuxKeyboardWarningPromise
				?.then((warning) => {
					if (warning) {
						this.showWarning(warning);
					}
				})
				.catch(() => {});
		};

		let modelFallbackWarningShown = false;
		const showModelFallbackWarning = () => {
			if (modelFallbackWarningShown) {
				return;
			}
			const action = this.getModelFallbackWarningAction(modelFallbackMessage);
			modelFallbackWarningShown = true;
			if (action === "show" && modelFallbackMessage) {
				this.showWarning(modelFallbackMessage);
			}
		};

		await this.runStartupOnboarding();
		showDeferredStartupNotifications();
		showModelFallbackWarning();
		void this.maybeWarnAboutAnthropicSubscriptionAuth();
		void deliverStartupPrompts().then(
			() => settleStartupPrompts("admitted"),
			() => settleStartupPrompts("admitted"),
		);

		// Enter/Alt+Enter submit directly through AgentConnection. Wait for the
		// lifecycle signal exactly once; a returned editor value has already been
		// admitted and must never be submitted again here.
		try {
			await this.getUserInput();
		} finally {
			startupAdmissionAbort.abort();
			settleStartupPrompts("lifecycle-cancelled");
			this.admitPendingStartupPrompts = undefined;
		}

		const state = this.connectionState;
		return {
			type: this.agentsViewRequest ?? "agents_view",
			source: {
				activeSessionId: state?.activeSessionId,
				sessionFile: state?.sessionFile,
				sessionId: state?.sessionId ?? this.promptStashSessionId ?? "",
				sessionName: state?.sessionName,
				cwd: state?.cwd ?? this.getCurrentCwd(),
			},
		};
	}

	private getModelFallbackWarningAction(modelFallbackMessage: string | undefined): ModelFallbackWarningAction {
		if (!modelFallbackMessage) {
			return "suppress";
		}
		// The no-models warning is a snapshot from whichever process created the
		// session; trust the live connection over it (e.g. credentials only
		// visible to the daemon, or added after the snapshot was taken).
		if (isNoModelsAvailableMessage(modelFallbackMessage) && this.getCurrentModel()) {
			return "suppress";
		}
		return "show";
	}

	private getOnboardingState(): OnboardingStartupState {
		return {
			settingsManager: this.settingsManager,
			modelRegistry: this.modelRegistry,
			model: this.getCurrentModel(),
		};
	}

	private shouldRunOnboarding(): boolean {
		return shouldRunOnboarding(this.getOnboardingState());
	}

	private shouldRunPrimeCliOnboardingSplash(): boolean {
		return shouldRunPrimeCliOnboardingSplash(this.getOnboardingState());
	}

	private markOnboardingShown(): void {
		if (!this.settingsManager.getOnboardingShown()) {
			this.settingsManager.setOnboardingShown(true);
		}
	}

	private async runStartupOnboarding(): Promise<boolean> {
		if (!this.shouldRunOnboarding()) {
			return false;
		}

		const startedAt = Date.now();
		const showPrimeCliSplash = this.shouldRunPrimeCliOnboardingSplash();
		let outcome: TelemetryOnboardingOutcome = "aborted";
		try {
			this.markOnboardingShown();
			await this.settingsManager.flush();
			await this.runOnboardingFlow(showPrimeCliSplash);
			outcome = isOnboardingModelReady(this.getOnboardingState()) ? "success" : "aborted";
			return true;
		} catch (error) {
			outcome = "error";
			throw error;
		} finally {
			const model = this.getCurrentModel();
			const authStatus = model ? this.modelRegistry.getProviderAuthStatus(model.provider) : undefined;
			const storedCredential = model ? this.modelRegistry.authStorage.get(model.provider) : undefined;
			void captureOnboardingCompleted({
				agentDir: getAgentDir(),
				settingsManager: this.settingsManager,
				durationMs: Date.now() - startedAt,
				outcome,
				provider: model?.provider,
				authSource: authStatus?.source,
				storedCredentialType: storedCredential?.type,
			}).catch(() => {});
		}
	}

	private async showOnboardingModelSelection(splash: OnboardingSplashHandle): Promise<void> {
		try {
			await this.showConfigurationMenu("models");
		} finally {
			splash.dismiss();
		}
	}

	private async runOnboardingFlow(showPrimeCliSplash = this.shouldRunPrimeCliOnboardingSplash()): Promise<void> {
		this.modelRegistry.refresh();
		if (showPrimeCliSplash) {
			const splash = await this.showOnboardingSplash("choose a model");
			if (!splash) {
				return;
			}

			await this.showOnboardingModelSelection(splash);
			return;
		}

		const availableModels = await this.getModelCandidates();
		if (availableModels.length > 0) {
			await this.showConfigurationMenu("models");
			return;
		}

		const splash = await this.showOnboardingSplash();
		if (!splash) {
			return;
		}

		splash.showProgress("Signing in to Prime Intellect...");
		const authResult = await this.createAuthFlows().runPrimeInferenceLogin();
		if (authResult.status !== "success") {
			splash.dismiss();
			return;
		}

		splash.showProgress("Preparing models...");
		await this.prepareForModelSelectionAfterLogin(authResult);
		await this.showOnboardingModelSelection(splash);
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.settingsManager.getCodeBlockIndent(),
		};
	}

	private formatDisplayPath(p: string): string {
		const home = os.homedir();
		let result = p;

		// Replace home directory with ~
		if (result.startsWith(home)) {
			result = `~${result.slice(home.length)}`;
		}

		return result;
	}

	private formatExtensionDisplayPath(path: string): string {
		let result = this.formatDisplayPath(path);
		result = result.replace(/\/index\.ts$/, "").replace(/\/index\.js$/, "");
		return result;
	}

	private formatContextPath(p: string): string {
		const cwd = path.resolve(this.getCurrentCwd());
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		const relativePath = getCwdRelativePath(absolutePath, cwd);
		if (relativePath !== undefined) {
			return relativePath;
		}

		return this.formatDisplayPath(absolutePath);
	}

	private getStartupExpansionState(): boolean {
		return this.options.verbose || this.toolOutputExpanded;
	}

	private getShortPath(fullPath: string, sourceInfo?: AgentConnectionSourceInfo): string {
		const baseDir = sourceInfo?.baseDir;
		if (baseDir && this.isPackageSource(sourceInfo)) {
			const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
			if (
				relativePath &&
				relativePath !== "." &&
				!relativePath.startsWith("..") &&
				!relativePath.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relativePath)
			) {
				return relativePath.replace(/\\/g, "/");
			}
		}

		const source = sourceInfo?.source ?? "";
		const npmMatch = fullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
		if (npmMatch && source.startsWith("npm:")) {
			return npmMatch[2];
		}

		const gitMatch = fullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
		if (gitMatch && source.startsWith("git:")) {
			return gitMatch[1];
		}

		return this.formatDisplayPath(fullPath);
	}

	private getCompactPathLabel(resourcePath: string, sourceInfo?: AgentConnectionSourceInfo): string {
		const shortPath = this.getShortPath(resourcePath, sourceInfo);
		const normalizedPath = shortPath.replace(/\\/g, "/");
		const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
		if (segments.length > 0) {
			return segments[segments.length - 1]!;
		}
		return shortPath;
	}

	private getCompactPackageSourceLabel(sourceInfo?: AgentConnectionSourceInfo): string {
		const source = sourceInfo?.source ?? "";
		if (source.startsWith("npm:")) {
			return source.slice("npm:".length) || source;
		}

		const gitSource = parseGitUrl(source);
		if (gitSource) {
			return gitSource.path || source;
		}

		return source;
	}

	private getCompactExtensionLabel(resourcePath: string, sourceInfo?: AgentConnectionSourceInfo): string {
		if (!this.isPackageSource(sourceInfo)) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const sourceLabel = this.getCompactPackageSourceLabel(sourceInfo);
		if (!sourceLabel) {
			return this.getCompactPathLabel(resourcePath, sourceInfo);
		}

		const shortPath = this.getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
		const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
		const parsedPath = path.posix.parse(packagePath);

		if (parsedPath.name === "index") {
			return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
		}

		return `${sourceLabel}:${packagePath}`;
	}

	private getCompactDisplayPathSegments(resourcePath: string): string[] {
		return this.formatDisplayPath(resourcePath)
			.replace(/\\/g, "/")
			.split("/")
			.filter((segment) => segment.length > 0 && segment !== "~");
	}

	private getCompactNonPackageExtensionLabel(
		resourcePath: string,
		index: number,
		allPaths: Array<{ path: string; segments: string[] }>,
	): string {
		const segments = allPaths[index]?.segments;
		if (!segments || segments.length === 0) {
			return this.getCompactPathLabel(resourcePath);
		}

		for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
			const candidate = segments.slice(-segmentCount).join("/");
			const isUnique = allPaths.every((item, itemIndex) => {
				if (itemIndex === index) {
					return true;
				}
				return item.segments.slice(-segmentCount).join("/") !== candidate;
			});

			if (isUnique) {
				return candidate;
			}
		}

		return segments.join("/");
	}

	private getCompactExtensionLabels(
		extensions: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>,
	): string[] {
		const nonPackageExtensions = extensions
			.map((extension) => {
				const segments = this.getCompactDisplayPathSegments(extension.path);
				const lastSegment = segments[segments.length - 1];
				if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
					segments.pop();
				}
				return {
					path: extension.path,
					sourceInfo: extension.sourceInfo,
					segments,
				};
			})
			.filter((extension) => !this.isPackageSource(extension.sourceInfo));

		return extensions.map((extension) => {
			if (this.isPackageSource(extension.sourceInfo)) {
				return this.getCompactExtensionLabel(extension.path, extension.sourceInfo);
			}

			const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
			if (nonPackageIndex === -1) {
				return this.getCompactPathLabel(extension.path, extension.sourceInfo);
			}

			return this.getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
		});
	}

	private getDisplaySourceInfo(sourceInfo?: AgentConnectionSourceInfo): {
		label: string;
		scopeLabel?: string;
		color: "accent" | "muted";
	} {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "local") {
			if (scope === "user") {
				return { label: "user", color: "muted" };
			}
			if (scope === "project") {
				return { label: "project", color: "muted" };
			}
			if (scope === "temporary") {
				return { label: "path", scopeLabel: "temp", color: "muted" };
			}
			return { label: "path", color: "muted" };
		}

		if (source === "cli") {
			return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined, color: "muted" };
		}

		const scopeLabel =
			scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
		return { label: source, scopeLabel, color: "accent" };
	}

	private getScopeGroup(sourceInfo?: AgentConnectionSourceInfo): "user" | "project" | "path" {
		const source = sourceInfo?.source ?? "local";
		const scope = sourceInfo?.scope ?? "project";
		if (source === "cli" || scope === "temporary") return "path";
		if (scope === "user") return "user";
		if (scope === "project") return "project";
		return "path";
	}

	private isPackageSource(sourceInfo?: AgentConnectionSourceInfo): boolean {
		const source = sourceInfo?.source ?? "";
		return source.startsWith("npm:") || source.startsWith("git:");
	}

	private buildScopeGroups(items: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>): Array<{
		scope: "user" | "project" | "path";
		paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
		packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
	}> {
		const groups: Record<
			"user" | "project" | "path",
			{
				scope: "user" | "project" | "path";
				paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
				packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
			}
		> = {
			user: { scope: "user", paths: [], packages: new Map() },
			project: { scope: "project", paths: [], packages: new Map() },
			path: { scope: "path", paths: [], packages: new Map() },
		};

		for (const item of items) {
			const groupKey = this.getScopeGroup(item.sourceInfo);
			const group = groups[groupKey];
			const source = item.sourceInfo?.source ?? "local";

			if (this.isPackageSource(item.sourceInfo)) {
				const list = group.packages.get(source) ?? [];
				list.push(item);
				group.packages.set(source, list);
			} else {
				group.paths.push(item);
			}
		}

		return [groups.project, groups.user, groups.path].filter(
			(group) => group.paths.length > 0 || group.packages.size > 0,
		);
	}

	private formatScopeGroups(
		groups: Array<{
			scope: "user" | "project" | "path";
			paths: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
			packages: Map<string, Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>>;
		}>,
		options: {
			formatPath: (item: { path: string; sourceInfo?: AgentConnectionSourceInfo }) => string;
			formatPackagePath: (item: { path: string; sourceInfo?: AgentConnectionSourceInfo }, source: string) => string;
		},
	): string {
		const lines: string[] = [];

		for (const group of groups) {
			lines.push(`  ${theme.fg("accent", group.scope)}`);

			const sortedPaths = [...group.paths].sort((a, b) => a.path.localeCompare(b.path));
			for (const item of sortedPaths) {
				lines.push(theme.fg("dim", `    ${options.formatPath(item)}`));
			}

			const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
			for (const [source, items] of sortedPackages) {
				lines.push(`    ${theme.fg("mdLink", source)}`);
				const sortedPackagePaths = [...items].sort((a, b) => a.path.localeCompare(b.path));
				for (const item of sortedPackagePaths) {
					lines.push(theme.fg("dim", `      ${options.formatPackagePath(item, source)}`));
				}
			}
		}

		return lines.join("\n");
	}

	private findSourceInfoForPath(
		p: string,
		sourceInfos: Map<string, AgentConnectionSourceInfo>,
	): AgentConnectionSourceInfo | undefined {
		const exact = sourceInfos.get(p);
		if (exact) return exact;

		let current = p;
		while (current.includes("/")) {
			current = current.substring(0, current.lastIndexOf("/"));
			const parent = sourceInfos.get(current);
			if (parent) return parent;
		}

		return undefined;
	}

	private formatPathWithSource(p: string, sourceInfo?: AgentConnectionSourceInfo): string {
		if (sourceInfo) {
			const shortPath = this.getShortPath(p, sourceInfo);
			const { label, scopeLabel } = this.getDisplaySourceInfo(sourceInfo);
			const labelText = scopeLabel ? `${label} (${scopeLabel})` : label;
			return `${labelText} ${shortPath}`;
		}
		return this.formatDisplayPath(p);
	}

	private formatDiagnostics(
		diagnostics: readonly AgentConnectionResourceDiagnostic[],
		sourceInfos: Map<string, AgentConnectionSourceInfo>,
	): string {
		const lines: string[] = [];

		// Group collision diagnostics by name
		const collisions = new Map<string, AgentConnectionResourceDiagnostic[]>();
		const otherDiagnostics: AgentConnectionResourceDiagnostic[] = [];

		for (const d of diagnostics) {
			if (d.type === "collision" && d.collision) {
				const list = collisions.get(d.collision.name) ?? [];
				list.push(d);
				collisions.set(d.collision.name, list);
			} else {
				otherDiagnostics.push(d);
			}
		}

		// Format collision diagnostics grouped by name
		for (const [name, collisionList] of collisions) {
			const first = collisionList[0]?.collision;
			if (!first) continue;
			lines.push(theme.fg("warning", `  "${name}" collision:`));
			lines.push(
				theme.fg(
					"dim",
					`    ${theme.fg("success", "✓")} ${this.formatPathWithSource(first.winnerPath, this.findSourceInfoForPath(first.winnerPath, sourceInfos))}`,
				),
			);
			for (const d of collisionList) {
				if (d.collision) {
					lines.push(
						theme.fg(
							"dim",
							`    ${theme.fg("warning", "✗")} ${this.formatPathWithSource(d.collision.loserPath, this.findSourceInfoForPath(d.collision.loserPath, sourceInfos))} (skipped)`,
						),
					);
				}
			}
		}

		const formatMessageLines = (diagnostic: AgentConnectionResourceDiagnostic, indent: number): string[] => {
			const color = diagnostic.type === "error" ? "error" : "warning";
			const prefix = " ".repeat(indent);
			return diagnostic.message.split("\n").map((line) => theme.fg(color, `${prefix}${line}`));
		};

		for (const d of otherDiagnostics) {
			if (d.path) {
				const formattedPath = this.formatPathWithSource(d.path, this.findSourceInfoForPath(d.path, sourceInfos));
				lines.push(theme.fg(d.type === "error" ? "error" : "warning", `  ${formattedPath}`));
				lines.push(...formatMessageLines(d, 4));
			} else {
				lines.push(...formatMessageLines(d, 2));
			}
		}

		return lines.join("\n");
	}

	private showLoadedResources(options?: {
		extensions?: Array<{ path: string; sourceInfo?: AgentConnectionSourceInfo }>;
		force?: boolean;
		showDiagnosticsWhenQuiet?: boolean;
	}): void {
		const showListing = options?.force === true || this.options.verbose === true;
		const showDiagnostics = showListing || options?.showDiagnosticsWhenQuiet === true;
		if (!showListing && !showDiagnostics) {
			return;
		}

		const sectionHeader = (name: string, color: ThemeColor = "mdHeading") => theme.fg(color, `[${name}]`);
		const diagnosticsHeader = (name: string, diagnostics: readonly AgentConnectionResourceDiagnostic[]): string => {
			if (diagnostics.some((diagnostic) => diagnostic.type === "collision")) {
				return `${name} conflicts`;
			}

			const errorCount = diagnostics.filter((diagnostic) => diagnostic.type === "error").length;
			const warningCount = diagnostics.filter((diagnostic) => diagnostic.type === "warning").length;
			if (errorCount > 0 && warningCount > 0) {
				return `${name} diagnostics`;
			}
			if (errorCount > 0) {
				return `${name} error${errorCount === 1 ? "" : "s"}`;
			}
			if (warningCount > 0) {
				return `${name} warning${warningCount === 1 ? "" : "s"}`;
			}

			return `${name} diagnostics`;
		};
		const formatCompactList = (items: string[], options?: { sort?: boolean }): string => {
			const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
			if (options?.sort !== false) {
				labels.sort((a, b) => a.localeCompare(b));
			}
			return theme.fg("dim", `  ${labels.join(", ")}`);
		};
		const addLoadedSection = (
			name: string,
			collapsedBody: string,
			expandedBody = collapsedBody,
			color: ThemeColor = "mdHeading",
		): void => {
			const section = new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				this.getStartupExpansionState(),
				0,
				0,
			);
			this.chatContainer.addChild(section);
			this.chatContainer.addChild(new Spacer(1));
		};

		const resourceSnapshot = this.connectionResourceSnapshot;
		const skills = resourceSnapshot?.skills ?? [];
		const prompts = resourceSnapshot?.prompts ?? [];
		const loadedThemes = resourceSnapshot?.themes ?? [];
		const contextFiles = resourceSnapshot?.contextFiles ?? [];
		const extensions = options?.extensions ?? resourceSnapshot?.extensions ?? [];
		const sourceInfos = new Map<string, AgentConnectionSourceInfo>();
		for (const extension of extensions) {
			if (extension.sourceInfo) {
				sourceInfos.set(extension.path, extension.sourceInfo);
			}
		}
		for (const skill of skills) {
			if (skill.sourceInfo) {
				sourceInfos.set(skill.filePath, skill.sourceInfo);
			}
		}
		for (const prompt of prompts) {
			if (prompt.sourceInfo) {
				sourceInfos.set(prompt.filePath, prompt.sourceInfo);
			}
		}
		for (const loadedTheme of loadedThemes) {
			if (loadedTheme.sourcePath && loadedTheme.sourceInfo) {
				sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
			}
		}

		if (showListing) {
			if (contextFiles.length > 0) {
				this.chatContainer.addChild(new Spacer(1));
				const contextList = contextFiles
					.map((f) => theme.fg("dim", `  ${this.formatDisplayPath(f.path)}`))
					.join("\n");
				const contextCompactList = formatCompactList(
					contextFiles.map((contextFile) => this.formatContextPath(contextFile.path)),
					{ sort: false },
				);
				addLoadedSection("Context", contextCompactList, contextList);
			}

			if (skills.length > 0) {
				const groups = this.buildScopeGroups(
					skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
				);
				const skillList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const skillCompactList = formatCompactList(skills.map((skill) => skill.name));
				addLoadedSection("Skills", skillCompactList, skillList);
			}

			if (prompts.length > 0) {
				const groups = this.buildScopeGroups(
					prompts.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
				);
				const templateByPath = new Map(prompts.map((t) => [t.filePath, t]));
				const templateList = this.formatScopeGroups(groups, {
					formatPath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
					formatPackagePath: (item) => {
						const template = templateByPath.get(item.path);
						return template ? `/${template.name}` : this.formatDisplayPath(item.path);
					},
				});
				const promptCompactList = formatCompactList(prompts.map((template) => `/${template.name}`));
				addLoadedSection("Prompts", promptCompactList, templateList);
			}

			if (extensions.length > 0) {
				const groups = this.buildScopeGroups(extensions);
				const extList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatExtensionDisplayPath(item.path),
					formatPackagePath: (item) =>
						this.formatExtensionDisplayPath(this.getShortPath(item.path, item.sourceInfo)),
				});
				const extensionCompactList = formatCompactList(this.getCompactExtensionLabels(extensions));
				addLoadedSection("Extensions", extensionCompactList, extList, "mdHeading");
			}

			// Show loaded themes (excluding built-in)
			const customThemes = loadedThemes.filter((t) => t.sourcePath);
			if (customThemes.length > 0) {
				const groups = this.buildScopeGroups(
					customThemes.map((loadedTheme) => ({
						path: loadedTheme.sourcePath!,
						sourceInfo: loadedTheme.sourceInfo,
					})),
				);
				const themeList = this.formatScopeGroups(groups, {
					formatPath: (item) => this.formatDisplayPath(item.path),
					formatPackagePath: (item) => this.getShortPath(item.path, item.sourceInfo),
				});
				const themeCompactList = formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? this.getCompactPathLabel(loadedTheme.sourcePath!, loadedTheme.sourceInfo),
					),
				);
				addLoadedSection("Themes", themeCompactList, themeList);
			}
		}

		if (showDiagnostics) {
			const skillDiagnostics = resourceSnapshot?.diagnostics.skills ?? [];
			if (skillDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(skillDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Skill", skillDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const promptDiagnostics = resourceSnapshot?.diagnostics.prompts ?? [];
			if (promptDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(promptDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Prompt", promptDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const extensionDiagnostics: AgentConnectionResourceDiagnostic[] = [
				...(resourceSnapshot?.diagnostics.extensions ?? []),
			];

			if (this.bindLocalSessionExtensions) {
				const commandDiagnostics = this.getLocalSessionHost().getExtensionRunner().getCommandDiagnostics();
				extensionDiagnostics.push(...commandDiagnostics);
			}
			extensionDiagnostics.push(...this.getBuiltInCommandConflictDiagnostics(this.connectionCommands));

			if (this.bindLocalSessionExtensions) {
				const shortcutDiagnostics = this.getLocalSessionHost().getExtensionRunner().getShortcutDiagnostics();
				extensionDiagnostics.push(...shortcutDiagnostics);
			}

			if (extensionDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(extensionDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Extension", extensionDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}

			const themeDiagnostics = resourceSnapshot?.diagnostics.themes ?? [];
			if (themeDiagnostics.length > 0) {
				const warningLines = this.formatDiagnostics(themeDiagnostics, sourceInfos);
				this.chatContainer.addChild(
					new Text(
						`${sectionHeader(diagnosticsHeader("Theme", themeDiagnostics), "warning")}\n${warningLines}`,
						0,
						0,
					),
				);
				this.chatContainer.addChild(new Spacer(1));
			}
		}
	}

	/**
	 * Initialize the extension system with TUI-based UI context.
	 */
	private async bindCurrentSessionExtensions(): Promise<void> {
		const localSessionHost = this.getLocalSessionHost();
		const uiContext = this.createExtensionUIContext();
		await localSessionHost.bindExtensions({
			uiContext,
			commandContextActions: {
				waitForIdle: () => this.agentConnection.waitForIdle(),
				newSession: async (options) => {
					this.stopWorkingLoader();
					try {
						const result =
							options?.setup || options?.withSession
								? await localSessionHost.newSession(options)
								: await this.agentConnection.newSession(
										options?.parentSession ? { parentSession: options.parentSession } : undefined,
									);
						if (!result.cancelled) {
							await this.renderCurrentSessionState();
							this.ui.requestRender();
						}
						return result;
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, options) => {
					try {
						const result = options?.withSession
							? await localSessionHost.fork(entryId, options)
							: await this.agentConnection.fork(entryId, { position: options?.position });
						if (!result.cancelled) {
							await this.renderCurrentSessionState();
							this.editor.setText("selectedText" in result ? (result.selectedText ?? "") : "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error: unknown) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, options) => {
					const result = await this.agentConnection.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					if (result.cancelled) {
						return { cancelled: true };
					}

					await this.renderTreeNavigation(result);
					return { cancelled: false };
				},
				switchSession: async (sessionPath, options) => {
					return this.handleResumeSession(sessionPath, options);
				},
				reload: async () => {
					await this.handleReloadCommand();
				},
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (!this.isAgentStreaming()) {
					void this.shutdown();
				}
			},
			onError: (error) => {
				this.showExtensionError(error.extensionPath, error.error, error.stack);
			},
		});

		setRegisteredThemes(this.uiServices.getThemes());
		await this.refreshConnectionCatalog();
		this.setupAutocompleteProvider();

		const extensionRunner = localSessionHost.getExtensionRunner();
		this.setupExtensionShortcuts(extensionRunner);
		this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
	}

	private applyRuntimeSettings(): void {
		this.footer.setAutoCompactEnabled(
			this.connectionState?.autoCompactionEnabled ?? this.settingsManager.getCompactionEnabled(),
		);
		this.footerDataProvider.setCwd(this.getCurrentCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.editor !== this.defaultEditor) {
			this.editor.setPaddingX?.(editorPaddingX);
			this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
	}

	private getConnectionQueue(): AgentConnectionQueueState {
		return {
			steering: [...(this.connectionState?.sessionActions.steering ?? [])],
			followUp: [...(this.connectionState?.sessionActions.followUps ?? [])],
		};
	}

	private async refreshConnectionCatalog(): Promise<void> {
		this.invalidateConnectionModelRefresh();
		const [state, commands, modelCatalog, resources] = await Promise.all([
			this.agentConnection.getState(),
			this.agentConnection.getCommands().catch(() => []),
			this.agentConnection.getModelCatalog(),
			this.agentConnection.getResourceSnapshot(),
		]);
		this.applyConnectionStateSnapshot(state);
		this.connectionCommands = commands;
		this.applyConnectionModelCatalog(modelCatalog);
		this.connectionModelsFetchedAt = Date.now();
		this.connectionResourceSnapshot = resources;
	}

	private refreshHeartbeatCatalog(): Promise<void> {
		if (this.heartbeatRefreshPromise) {
			this.heartbeatRefreshRequested = true;
			return this.heartbeatRefreshPromise;
		}
		const connection = this.agentConnection;
		const refresh = (async () => {
			do {
				this.heartbeatRefreshRequested = false;
				const heartbeats = await connection.listHeartbeats();
				if (this.agentConnection !== connection) return;
				this.applyHeartbeatCatalog(heartbeats);
			} while (this.heartbeatRefreshRequested);
		})().finally(() => {
			if (this.heartbeatRefreshPromise === refresh) {
				this.heartbeatRefreshPromise = undefined;
			}
		});
		this.heartbeatRefreshPromise = refresh;
		return refresh;
	}

	private applyHeartbeatCatalog(heartbeats: AgentConnectionHeartbeat[]): void {
		this.heartbeatCatalog = heartbeats;
		this.scheduleHeartbeatManagerRefresh();
		this.updateSubagentSummaryLine();
		this.ui.requestRender();
	}

	private getScopedHeartbeats(): AgentConnectionHeartbeat[] {
		return scopeHeartbeatsToSession(this.heartbeatCatalog, this.connectionState, this.subagentSnapshots.values());
	}

	private applyConnectionStateSnapshot(state: AgentConnectionState): void {
		this.bindPromptStashSession(state.sessionId);
		this.connectionState = state;
		this.scheduleHeartbeatManagerRefresh();
		// Don't touch contextUsageTokenBaseline: a mid-stream snapshot reflects only completed
		// turns (the in-flight message isn't persisted yet), so the in-flight delta must keep
		// accumulating. The baseline is managed at turn end (refreshConnectionContextUsage) and
		// reset on a new user message.
		this.footer.setAutoCompactEnabled(state.autoCompactionEnabled);
		this.sessionRecap = state.recap;
		this.renderRecap();
		this.updateWorkingPulse();
	}

	private patchConnectionState(patch: Partial<AgentConnectionState>): void {
		if (!this.connectionState) {
			return;
		}
		this.connectionState = { ...this.connectionState, ...patch };
		this.updateWorkingPulse();
	}

	// Bake this attempt's output into the snapshot so the tray doesn't dip in the gap between
	// isStreaming clearing and the async refresh landing.
	private applyOptimisticContextUsage(): void {
		const snapshot = this.connectionState?.contextUsage;
		if (!snapshot || snapshot.tokens === null || snapshot.contextWindow <= 0) return;
		const completed = Math.max(0, this.activityTracker.getStatus().tokens - this.contextUsageTokenBaseline);
		if (completed <= 0) return;
		const tokens = snapshot.tokens + completed;
		this.patchConnectionState({
			contextUsage: {
				tokens,
				contextWindow: snapshot.contextWindow,
				percent: (tokens / snapshot.contextWindow) * 100,
			},
		});
	}

	/** Refresh the tray's context usage from the session after a turn or compaction completes. */
	private async refreshConnectionContextUsage(): Promise<void> {
		const generation = ++this.contextUsageRefresh.generation;
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		const stats = await connection?.getSessionStats?.().catch(() => undefined);
		if (!stats) return;
		// Drop results superseded by a newer successful refresh as well as results for a replaced session.
		if (
			generation < this.contextUsageRefresh.lastSuccessGeneration ||
			this.agentConnection !== connection ||
			this.connectionState?.sessionId !== sessionId
		) {
			return;
		}
		this.contextUsageRefresh.lastSuccessGeneration = generation;
		// Anything counted so far is now reflected in the snapshot; only later output is in-flight.
		this.contextUsageTokenBaseline = this.activityTracker.getStatus().tokens;
		this.patchConnectionState({ contextUsage: stats.contextUsage });
	}

	private refreshQueueSelectionFromState(): void {
		const selected = this.queueSelection.selected;
		if (selected && !this.pendingQueueEdit && !this.pendingQueueMove) {
			this.refreshQueueSelectionAt(this.getConnectionQueue(), selected, selected.index);
		}
	}

	private updateConnectionStateFromEvent(event: AgentConnectionSessionEvent): void {
		if (!this.connectionState) {
			return;
		}
		switch (event.type) {
			case "agent_start": {
				const wasNewChat = this.isNewChat();
				this.patchConnectionState({ isStreaming: true, activeToolNames: [] });
				if (wasNewChat) {
					this.builtInHeader?.invalidate();
					this.subagentSummaryLine.invalidate();
				}
				break;
			}
			case "message_end": {
				const wasNewChat = this.isNewChat();
				this.patchConnectionState({ messageCount: this.connectionState.messageCount + 1 });
				if (wasNewChat) {
					this.builtInHeader?.invalidate();
					this.subagentSummaryLine.invalidate();
				}
				break;
			}
			case "agent_end":
				this.patchConnectionState({ isStreaming: false, activeToolNames: [] });
				break;
			case "session_action_update":
				this.patchConnectionState({ sessionActions: event.actions });
				this.refreshQueueSelectionFromState();
				break;
			case "compaction_start":
				this.patchConnectionState({ isCompacting: true });
				break;
			case "compaction_end":
				this.patchConnectionState({ isCompacting: false });
				break;
			case "session_info_changed":
				this.patchConnectionState({ sessionName: event.name });
				break;
			case "thinking_level_changed":
				this.patchConnectionState({ thinkingLevel: event.level });
				break;
			case "service_tier_changed":
				this.patchConnectionState({ serviceTier: event.serviceTier });
				break;
			case "auto_retry_start":
				this.patchConnectionState({ retryAttempt: event.attempt });
				break;
			case "auto_retry_end":
				this.patchConnectionState({ retryAttempt: 0 });
				break;
			case "goal_update":
				this.patchConnectionState({ goal: event.goal });
				break;
			case "bash_start":
				this.patchConnectionState({ isBashRunning: true });
				break;
			case "bash_end":
				this.patchConnectionState({ isBashRunning: false });
				break;
		}
	}

	private getCurrentCwd(): string {
		return this.connectionState?.cwd ?? this.uiServices.getInitialCwd();
	}

	private getCurrentSessionName(): string | undefined {
		return this.connectionState?.sessionName ?? this.uiServices.getInitialSessionName();
	}

	private applyAuthStaleEvent(event: Extract<AgentConnectionSessionEvent, { type: "auth_stale" }>): void {
		let marked = false;
		for (const token of event.sourceTokens ?? []) {
			marked = this.modelRegistry.markProviderAuthSourceStale(token) || marked;
		}
		if (!marked) {
			this.modelRegistry.markProviderAuthStale(event.provider);
		}
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	private getCurrentModel(): AgentConnectionModel | undefined {
		return this.connectionState?.model;
	}

	private getCurrentModelId(): string | undefined {
		return this.getCurrentModel()?.id;
	}

	private isAgentStreaming(): boolean {
		return this.connectionState?.isStreaming ?? false;
	}

	private isAgentCompacting(): boolean {
		return this.connectionState?.isCompacting ?? false;
	}

	private isBashRunning(): boolean {
		return this.connectionState?.isBashRunning ?? false;
	}

	private hasInterruptibleWork(): boolean {
		return (
			this.isAgentStreaming() ||
			this.isAgentCompacting() ||
			this.isBashRunning() ||
			this.getRetryAttempt() > 0 ||
			this.connectionState?.sessionActions.active !== undefined ||
			this.traceUploadAllAbortController !== undefined ||
			this.sideQuestionEvent?.status === "running"
		);
	}

	private getRetryAttempt(): number {
		return this.connectionState?.retryAttempt ?? 0;
	}

	private getQueuedActionCount(): number {
		return this.connectionState?.sessionActions.queuedCount ?? 0;
	}

	private getGoalState(): GoalState {
		return this.connectionState?.goal ?? emptyGoalState();
	}

	private getConnectionContextUsage(): AgentConnectionState["contextUsage"] {
		const snapshot = this.connectionState?.contextUsage;
		if (!snapshot || snapshot.tokens === null || snapshot.contextWindow <= 0) {
			return snapshot;
		}
		// Add only the output produced since the snapshot was last refreshed. The activity
		// tracker accumulates across auto-retries within a turn, so subtract the baseline
		// captured at the last refresh to avoid re-adding a failed attempt's tokens.
		const inFlight = this.isAgentStreaming()
			? Math.max(0, this.activityTracker.getStatus().tokens - this.contextUsageTokenBaseline)
			: 0;
		if (inFlight <= 0) {
			return snapshot;
		}
		const tokens = snapshot.tokens + inFlight;
		return {
			tokens,
			contextWindow: snapshot.contextWindow,
			percent: (tokens / snapshot.contextWindow) * 100,
		} satisfies ContextUsage;
	}

	private getScopedModelState(): AgentConnectionState["scopedModels"] {
		return this.connectionState?.scopedModels ?? [];
	}

	private async rebindCurrentSession(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.localSessionHost) {
			this.uiServices = this.localSessionHost.createUiServices();
		}
		this.toolDefinitionCache.clear();
		this.applyRuntimeSettings();
		if (this.bindLocalSessionExtensions) {
			await this.bindCurrentSessionExtensions();
		} else {
			setRegisteredThemes(this.uiServices.getThemes());
			await this.refreshConnectionCatalog();
			this.setupAutocompleteProvider();
			this.showLoadedResources({ force: false, showDiagnosticsWhenQuiet: true });
		}
		this.subscribeToAgent();
		// A session_action_update in the unsubscribed gap above is lost; re-sync the queue post-subscription.
		this.patchConnectionState({ sessionActions: (await this.agentConnection.getState()).sessionActions });
		this.refreshQueueSelectionFromState();
		this.updatePendingMessagesDisplay();
		await this.refreshHeartbeatCatalog().catch(() => undefined);
		await this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		this.setGoalAnnouncementBaseline(this.getGoalState());
		this.syncGoalTray(this.getGoalState());
		this.syncWorkingLoader();
	}

	private async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.showError(`${prefix}: ${message}`);
		stopThemeWatcher();
		this.stop();
		process.exit(1);
	}

	private resetCurrentSessionRenderState(options?: { clearPromptStash?: boolean }): void {
		this.endFeatureHintRun();
		this.chatContainer.clear();
		this.shortcutGuideContainer.clear();
		this.pendingMessagesContainer.clear();
		this.queuedMessagesContainer.clear();
		this.pendingQueueEdit = undefined;
		this.pendingQueueMove = false;
		// The selection and its stashed draft belong to the previous session;
		// every editor draft is cleared below, so discard rather than restore.
		this.queueSelection.reset();
		this.featureHintSuppressedByQueue = false;
		if (options?.clearPromptStash) {
			this.promptStash = undefined;
			if (this.promptStashState) this.promptStashState.queuedStashes = undefined;
		}
		// Clear every editor's prompt history, draft text, and queues, then prune
		// any pasted images no longer referenced by the remaining stashed draft.
		this.defaultEditor.clearHistory?.();
		this.defaultEditor.setText("");
		if (this.editor !== this.defaultEditor) {
			this.editor.clearHistory?.();
			this.editor.setText("");
		}
		const keepImageIds = this.liveImageMarkerIds();
		for (const markerId of this.pastedImages.keys()) {
			if (!keepImageIds.has(markerId)) {
				this.pastedImages.delete(markerId);
			}
		}
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		// The discarded component's loader interval keeps firing otherwise; no
		// bash_end will reach it once the reference is dropped.
		this.activeBashComponent?.setComplete(undefined, true);
		this.activeBashComponent = undefined;
		// Likewise: the next session's view may never see this refine settle.
		this.discardRefineLoader();
		this.pendingBashComponents = [];
		this.activityTracker.reset();
		this.contextUsageTokenBaseline = 0;
		this.resetPendingToolState();
		this.agentRunFileChanges.clear();
		this.renderRecap();
		this.ipythonToolComponents.clear();
		this.lateIpythonSentAgentMessages.clear();
		this.resetSubagentSummary();
		this.setGoalAnnouncementBaseline(this.getGoalState());
		this.syncGoalTray(this.getGoalState());
	}

	private resetPendingToolState(): void {
		this.pendingToolGeneration++;
		this.pendingTools.clear();
		this.pendingToolCreations.clear();
		this.startedToolCalls.clear();
	}

	private async renderCurrentSessionState(): Promise<void> {
		// Replacement events own the session-scoped command catalog. The daemon
		// sends that event before its command response, but its handler may still
		// be refreshing commands when the response resolves.
		await this.sessionEventQueue;
		this.resetCurrentSessionRenderState();
		await this.renderInitialMessages();
		this.updatePendingMessagesDisplay();
		this.syncWorkingLoader();
	}

	private async refreshCommandCatalogForCurrentSession(): Promise<void> {
		try {
			this.connectionCommands = await this.agentConnection.getCommands();
		} catch {
			this.connectionCommands = [];
		}
		this.setupAutocompleteProvider();
	}

	private async renderResyncedSession(snapshot: AgentConnectionSnapshot): Promise<void> {
		const bashFinished = this.isBashRunning() && !snapshot.state.isBashRunning;
		this.applyConnectionStateSnapshot(snapshot.state);
		this.refreshQueueSelectionFromState();
		this.restoreTurnStartFromMessages(this.getSessionContextFromConnectionSnapshot(snapshot).messages);
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.rlmNodeId = snapshot.parent?.childId;
		this.replaceSubagentSummary(snapshot.children);
		await this.renderSessionContext(this.getSessionContextFromConnectionSnapshot(snapshot), {
			clearChat: true,
			updateFooter: true,
		});
		await this.restoreStreamingMessageFromSnapshot(snapshot.streamingMessage);
		this.updatePendingMessagesDisplay();
		if (bashFinished) {
			if (this.activeBashComponent) {
				this.activeBashComponent.setComplete(undefined, false);
				this.activeBashComponent = undefined;
				if (!snapshot.state.isStreaming) {
					this.flushPendingBashComponents();
				}
			}
			// A transient side bash is not persisted in the session snapshot, so a
			// reconnect cannot replay its missed bash_end event. Release the pane's
			// local running state when the authoritative snapshot says bash ended.
			if (this.sideQuestionBash) {
				this.sideQuestionComponent?.finishBash();
				this.sideQuestionBash = undefined;
				this.sideQuestionBashComponent = undefined;
			}
			this.sideQuestionBashDiscarded = undefined;
		}
		this.updateTerminalTitle();
		this.setGoalAnnouncementBaseline(this.getGoalState());
		this.syncGoalTray(this.getGoalState());
		this.syncWorkingLoader();
	}

	private getCachedToolDefinition(toolName: string): ToolExecutionDefinition | undefined {
		return this.toolDefinitionCache.get(toolName);
	}

	private async loadToolDefinition(toolName: string): Promise<ToolExecutionDefinition | undefined> {
		if (this.toolDefinitionCache.has(toolName)) {
			return this.toolDefinitionCache.get(toolName);
		}
		const definition = this.createToolExecutionDefinition(
			toolName,
			await this.agentConnection.getToolDefinition(toolName),
			this.localSessionHost?.getToolRendererDefinition(toolName),
		);
		this.toolDefinitionCache.set(toolName, definition);
		return definition;
	}

	private getLatestStreamingToolCall(toolCallId: string): ToolCall | undefined {
		return this.streamingMessage?.content.find(
			(content): content is ToolCall => content.type === "toolCall" && content.id === toolCallId,
		);
	}

	private registerIpythonToolComponent(toolName: string, toolCallId: string, component: ToolExecutionComponent): void {
		if (toolName !== "ipython") {
			return;
		}
		this.ipythonToolComponents.set(toolCallId, component);
		for (const lateMessage of this.lateIpythonSentAgentMessages.get(toolCallId) ?? []) {
			component.appendSentAgentMessage(lateMessage);
		}
	}

	private async getOrCreatePendingToolComponent(
		toolCall: PendingToolCallRenderInput,
	): Promise<ToolExecutionComponent | undefined> {
		const existingComponent = this.pendingTools.get(toolCall.id);
		if (existingComponent) {
			existingComponent.updateArgs(toolCall.arguments);
			return existingComponent;
		}
		if (this.pendingToolCreations.has(toolCall.id)) {
			return undefined;
		}

		this.pendingToolCreations.add(toolCall.id);
		const generation = this.pendingToolGeneration;
		try {
			const toolDefinition = await this.loadToolDefinition(toolCall.name);
			if (generation !== this.pendingToolGeneration) {
				// Pending tool state was reset (abort/error) while loading; drop the stale component.
				return undefined;
			}
			const latestToolCall = this.getLatestStreamingToolCall(toolCall.id) ?? toolCall;
			const componentAfterLoad = this.pendingTools.get(latestToolCall.id);
			if (componentAfterLoad) {
				componentAfterLoad.updateArgs(latestToolCall.arguments);
				return componentAfterLoad;
			}

			const component = new ToolExecutionComponent(
				latestToolCall.name,
				latestToolCall.id,
				latestToolCall.arguments,
				{
					showImages: this.settingsManager.getShowImages(),
				},
				toolDefinition,
				this.ui,
				this.getCurrentCwd(),
			);
			component.setExpanded(this.toolOutputExpanded);
			component.setAgentMessagesExpanded(this.agentMessagesExpanded);
			component.setEditDiffsExpanded(this.editDiffsExpanded);
			if (this.startedToolCalls.has(latestToolCall.id)) {
				component.markExecutionStarted();
			}
			selectLatestToolExpandHint(this.chatContainer.children, component);
			this.chatContainer.addChild(component);
			this.pendingTools.set(latestToolCall.id, component);
			this.registerIpythonToolComponent(latestToolCall.name, latestToolCall.id, component);
			return component;
		} finally {
			this.pendingToolCreations.delete(toolCall.id);
		}
	}

	private createToolExecutionDefinition(
		toolName: string,
		connectionDefinition: AgentConnectionToolDefinition | undefined,
		localRendererDefinition: InteractiveModeLocalToolRendererDefinition | undefined,
	): ToolExecutionDefinition | undefined {
		if (!connectionDefinition && !localRendererDefinition) {
			return undefined;
		}

		const definition: ToolExecutionDefinition = {
			...(connectionDefinition ?? {
				name: toolName,
				label: toolName,
				description: "",
				parameters: {},
			}),
		};
		if (localRendererDefinition?.renderShell !== undefined) {
			definition.renderShell = localRendererDefinition.renderShell;
		}
		if (localRendererDefinition?.renderCall !== undefined) {
			definition.renderCall = localRendererDefinition.renderCall;
		}
		if (localRendererDefinition?.renderResult !== undefined) {
			definition.renderResult = localRendererDefinition.renderResult;
		}
		return definition;
	}

	private async preloadToolDefinitions(toolNames: Iterable<string>): Promise<void> {
		const missingToolNames = Array.from(new Set(toolNames)).filter(
			(toolName) => !this.toolDefinitionCache.has(toolName),
		);
		if (missingToolNames.length === 0) {
			return;
		}
		await Promise.all(
			missingToolNames.map(async (toolName) => {
				const definition = this.createToolExecutionDefinition(
					toolName,
					await this.agentConnection.getToolDefinition(toolName),
					this.localSessionHost?.getToolRendererDefinition(toolName),
				);
				this.toolDefinitionCache.set(toolName, definition);
			}),
		);
	}

	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) return;

		const localSessionHost = this.getLocalSessionHost();
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			hasUI: true,
			cwd: this.getCurrentCwd(),
			sessionManager: localSessionHost.getSessionManager(),
			modelRegistry: this.modelRegistry,
			model: this.getCurrentModel(),
			isIdle: () => !this.isAgentStreaming(),
			signal: localSessionHost.getAbortSignal(),
			abort: () => this.agentConnection.abort(),
			hasPendingMessages: () => this.getQueuedActionCount() > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.getConnectionContextUsage(),
			compact: (options) => {
				void (async () => {
					try {
						const result = await this.agentConnection.compact(options?.customInstructions);
						options?.onComplete?.(result);
					} catch (error) {
						const err = error instanceof Error ? error : new Error(String(error));
						options?.onError?.(err);
					}
				})();
			},
			getSystemPrompt: () => localSessionHost.getSystemPrompt(),
		});

		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutStr, shortcut] of shortcuts) {
				if (matchesKey(data, shortcutStr as KeyId)) {
					Promise.resolve(shortcut.handler(createContext())).catch((err) => {
						this.showError(`Shortcut handler error: ${err instanceof Error ? err.message : String(err)}`);
					});
					return true;
				}
			}
			return false;
		};
	}

	private setExtensionStatus(key: string, text: string | undefined): void {
		this.footerDataProvider.setExtensionStatus(key, text);
		this.ui.requestRender();
	}

	private getWorkingLoaderMessage(): string {
		const elapsed =
			this.workingStartedAt === undefined
				? undefined
				: this.formatWorkingElapsed(Date.now() - this.workingStartedAt);
		const status = this.activityTracker.getStatus();
		// The subagent count/recaps live in the tree above the loader, so the loader
		// message itself no longer repeats "N subagents running".
		if (!this.isAgentStreaming()) {
			return "";
		}
		if (this.workingMessage !== undefined) {
			// Extensions and tool bootstrap own the message; keep the plain "<message> <elapsed>" form.
			return elapsed === undefined ? this.workingMessage : `${this.workingMessage} ${elapsed}`;
		}
		const parts: string[] = [AGENT_ACTIVITY_LABELS[status.activity]];
		if (elapsed !== undefined) {
			parts.push(elapsed);
		}
		if (status.tokens > 0) {
			parts.push(`${status.direction === "down" ? "↓" : "↑"} ${formatTokenCount(status.tokens)} tokens`);
		}
		return parts.join(" · ");
	}

	private createWorkingLoader(): Loader {
		return new Loader(
			this.ui,
			(spinner) => theme.fg("accent", spinner),
			(text) => theme.fg("muted", text),
			this.getWorkingLoaderMessage(),
			this.workingIndicatorOptions,
		);
	}

	private formatWorkingElapsed(elapsedMs: number): string {
		const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
		if (totalSeconds < 60) {
			return `${totalSeconds}s`;
		}
		const minutes = Math.floor(totalSeconds / 60);
		const seconds = totalSeconds % 60;
		if (minutes < 60) {
			return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
		}
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		if (hours < 24) {
			return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
		}
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return `${days}d ${remainingHours.toString().padStart(2, "0")}h ${remainingMinutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
	}

	private updateWorkingLoaderMessage(): void {
		this.loadingAnimation?.setMessage(this.getWorkingLoaderMessage());
	}

	private startWorkingTimer(): void {
		if (this.workingTimer) {
			clearInterval(this.workingTimer);
		}
		this.workingTimer = setInterval(() => this.updateWorkingLoaderMessage(), 1000);
		this.workingTimer.unref?.();
	}

	// Recover the in-flight run's start from a restored transcript so the elapsed timer survives re-attach.
	private restoreTurnStartFromMessages(messages: readonly AgentMessage[]): void {
		this.turnStartedAt = undefined;
		if (!this.isAgentStreaming()) return;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i]!;
			if (startsAgentRun(message)) {
				this.turnStartedAt = message.timestamp;
			} else if (message.role === "assistant" && message.stopReason !== "toolUse") {
				break;
			}
		}
		if (this.turnStartedAt !== undefined && this.workingStartedAt !== undefined) {
			this.workingStartedAt = this.turnStartedAt;
			this.updateWorkingLoaderMessage();
		}
	}

	private startWorkingLoader(): void {
		this.stopWorkingLoader();
		this.workingStartedAt = this.turnStartedAt ?? Date.now();
		this.loadingAnimation = this.createWorkingLoader();
		this.statusContainer.addChild(this.loadingAnimation);
		this.startWorkingTimer();
		this.startFeatureHintPresentation();
	}

	private stopWorkingLoader(): void {
		this.clearFeatureHintPresentation();
		if (this.workingTimer) {
			clearInterval(this.workingTimer);
			this.workingTimer = undefined;
		}
		this.workingStartedAt = undefined;
		if (this.loadingAnimation) {
			this.loadingAnimation.stop();
			this.loadingAnimation = undefined;
		}
		this.statusContainer.clear();
	}

	private startFeatureHintPresentation(): void {
		this.clearFeatureHintPresentation();
		if (this.shouldSuppressFeatureHint()) {
			return;
		}
		if (this.featureHintEligibleAt === 0) {
			this.featureHintEligibleAt = Date.now() + FEATURE_HINT_DELAY_MS;
		}
		const delay = Math.max(0, this.featureHintEligibleAt - Date.now());
		if (delay === 0) {
			this.showFeatureHint();
			return;
		}
		this.featureHintTimer = setTimeout(() => {
			this.featureHintTimer = undefined;
			this.showFeatureHint();
		}, delay);
		this.featureHintTimer.unref?.();
	}

	private showFeatureHint(): void {
		if (
			this.shouldSuppressFeatureHint() ||
			!this.loadingAnimation ||
			!this.shouldShowWorkingLoader() ||
			!this.statusContainer.children.includes(this.loadingAnimation)
		) {
			return;
		}
		if (!this.currentFeatureHint) {
			const hint = this.featureHintDeck.next({
				getKeybinding: (action) => {
					const key = keyText(action);
					return key ? this.capitalizeKey(key) : undefined;
				},
				isResidentSession: this.options.returnToAgentsView === true,
			});
			this.currentFeatureHint = hint?.text;
		}
		if (!this.currentFeatureHint) {
			return;
		}
		this.featureHintComponent = new FeatureHintComponent(this.currentFeatureHint);
		this.featureHintContainer.addChild(this.featureHintComponent);
		this.renderRecap();
		this.featureHintAnimationTimer = setInterval(() => {
			this.featureHintComponent?.advance();
			this.ui.requestRender();
		}, FEATURE_HINT_ANIMATION_INTERVAL_MS);
		this.featureHintAnimationTimer.unref?.();
		this.ui.requestRender();
	}

	private clearFeatureHintPresentation(): void {
		if (this.featureHintTimer) {
			clearTimeout(this.featureHintTimer);
			this.featureHintTimer = undefined;
		}
		if (this.featureHintAnimationTimer) {
			clearInterval(this.featureHintAnimationTimer);
			this.featureHintAnimationTimer = undefined;
		}
		if (this.featureHintComponent) {
			this.featureHintContainer.removeChild(this.featureHintComponent);
			this.featureHintComponent = undefined;
			this.renderRecap();
		}
	}

	private resumeFeatureHintPresentation(): void {
		if (
			!this.shouldSuppressFeatureHint() &&
			this.loadingAnimation &&
			this.shouldShowWorkingLoader() &&
			this.statusContainer.children.includes(this.loadingAnimation)
		) {
			this.startFeatureHintPresentation();
		}
	}

	private shouldSuppressFeatureHint(): boolean {
		const { steering, followUp } = this.getAllQueuedMessages();
		return steering.length > 0 || followUp.length > 0;
	}

	private endFeatureHintRun(): void {
		this.clearFeatureHintPresentation();
		this.currentFeatureHint = undefined;
		this.featureHintEligibleAt = 0;
		this.featureHintRunPending = false;
	}

	private prepareFeatureHintRun(message: AgentMessage): void {
		if (!this.featureHintRunPending) return;
		if (message.role === "assistant") {
			this.featureHintRunPending = false;
			return;
		}
		if (!startsAgentRun(message)) return;

		this.endFeatureHintRun();
		if (this.shouldShowWorkingLoader()) {
			this.startFeatureHintPresentation();
		}
	}

	private updateWorkingPulse(): void {
		const active = this.isAgentStreaming();
		if (!active) {
			this.stopWorkingPulse();
			return;
		}
		if (!this.pulseTimer) {
			this.pulseTimer = setInterval(() => this.tickWorkingPulse(), WORKING_ICON_INTERVAL_MS);
			this.pulseTimer.unref?.();
		}
	}

	private tickWorkingPulse(): void {
		this.pulseFrame += 1;
		setWorkingPulseFrame(this.pulseFrame);
		this.ui.requestRender();
	}

	private stopWorkingPulse(): void {
		if (this.pulseTimer) {
			clearInterval(this.pulseTimer);
			this.pulseTimer = undefined;
		}
	}

	private shouldShowWorkingLoader(): boolean {
		// Background subagents (agent turn done, asyncio tasks still running) would
		// otherwise show a textless spinner; the subagent tree above the loader carries
		// that state, so the loader only shows while the main agent is itself streaming.
		return this.workingVisible && this.isAgentStreaming();
	}

	// Reconcile the loader with current state for transitions that fire no live
	// agent_start edge (returning from agents view, resuming mid-stream).
	private startCompactionLoader(
		reason: "manual" | "requested" | "overflow" | "threshold",
		customInstructions?: string,
	): void {
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(true);
		}
		// Keep editor active; submissions are queued during compaction.
		// Fully stop the working loader (not just detach) so it isn't orphaned.
		this.stopWorkingLoader();
		this.statusContainer.clear();
		const cancelHint = `(${keyText("app.clear")} to cancel)`;
		const focus = customInstructions ? ` (focus: ${truncateToWidth(customInstructions, 60, "…")})` : "";
		const label =
			reason === "manual"
				? `Compacting context${focus}... ${cancelHint}`
				: reason === "requested"
					? `Agent requested compaction, compacting context${focus}... ${cancelHint}`
					: `${reason === "overflow" ? "Context overflow detected, " : ""}Auto-compacting... ${cancelHint}`;
		this.autoCompactionLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("muted", spinner),
			(text) => theme.fg("muted", text),
			label,
		);
		this.statusContainer.addChild(this.autoCompactionLoader);
		this.ui.requestRender();
	}

	/** Live status for a user-issued /refine, mirroring the compaction loader. */
	private startRefineLoader(): void {
		this.stopWorkingLoader();
		this.statusContainer.clear();
		this.refineLoader = new Loader(
			this.ui,
			(spinner) => theme.fg("muted", spinner),
			(text) => theme.fg("muted", text),
			"Refining continual harness state...",
		);
		this.statusContainer.addChild(this.refineLoader);
		this.ui.requestRender();
	}

	private stopRefineLoader(): void {
		if (!this.refineLoader) return;
		this.discardRefineLoader();
		this.statusContainer.clear();
		this.syncWorkingLoader();
	}

	/** Stops and removes the loader without remounting old-session state. */
	private discardRefineLoader(): void {
		if (!this.refineLoader) return;
		this.refineLoader.stop();
		this.statusContainer.removeChild(this.refineLoader);
		this.refineLoader = undefined;
	}

	private syncWorkingLoader(): void {
		// A compaction that started before this client attached (or while another
		// view was open) has no start-event edge; restore its loader from state.
		if (!this.autoCompactionLoader && this.isAgentCompacting()) {
			this.startCompactionLoader("manual");
			return;
		}
		// Compaction/retry own the status container while active; don't fight them.
		if (this.autoCompactionLoader || this.retryLoader) {
			return;
		}
		// Remount the refine loader if another owner (e.g. a compaction) cleared it.
		if (this.refineLoader) {
			if (!this.statusContainer.children.includes(this.refineLoader)) {
				this.statusContainer.clear();
				this.statusContainer.addChild(this.refineLoader);
			}
			return;
		}
		if (this.shouldShowWorkingLoader()) {
			// A bare `loadingAnimation != null` check isn't proof it's on screen:
			// other paths clear statusContainer without nulling it, orphaning the
			// loader. Re-attach unless it is actually mounted.
			if (!this.loadingAnimation || !this.statusContainer.children.includes(this.loadingAnimation)) {
				this.startWorkingLoader();
			}
		} else if (this.loadingAnimation) {
			this.stopWorkingLoader();
		}
		this.ui.requestRender();
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.stopWorkingLoader();
			this.ui.requestRender();
			return;
		}
		if (this.shouldShowWorkingLoader() && !this.loadingAnimation) {
			this.statusContainer.clear();
			this.startWorkingLoader();
		}
		this.ui.requestRender();
	}

	private setWorkingIndicator(options?: LoaderIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		this.loadingAnimation?.setIndicator(options);
		this.ui.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? this.defaultHiddenThinkingLabel;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		if (this.streamingComponent) {
			this.streamingComponent.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		}
		this.ui.requestRender();
	}

	private setExtensionWidget(
		key: string,
		content: string[] | ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined,
		options?: ExtensionWidgetOptions,
	): void {
		const placement = options?.placement ?? "aboveEditor";
		const removeExisting = (map: Map<string, Component & { dispose?(): void }>) => {
			const existing = map.get(key);
			if (existing?.dispose) existing.dispose();
			map.delete(key);
		};

		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);

		if (content === undefined) {
			this.renderWidgets();
			return;
		}

		let component: Component & { dispose?(): void };

		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, InteractiveMode.MAX_WIDGET_LINES)) {
				container.addChild(new Text(line, 1, 0));
			}
			if (content.length > InteractiveMode.MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			component = content(this.ui, theme);
		}

		const targetMap = placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		targetMap.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) {
			widget.dispose?.();
		}
		for (const widget of this.extensionWidgetsBelow.values()) {
			widget.dispose?.();
		}
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private resetExtensionUI(): void {
		this.cancelActiveConnectionExtensionUiRequests();
		this.closeHeartbeatManager();
		if (this.extensionSelector) {
			this.hideExtensionSelector();
		}
		if (this.extensionInput) {
			this.hideExtensionInput();
		}
		if (this.extensionEditor) {
			this.hideExtensionEditor();
		}
		this.ui.hideOverlay();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.loadingAnimation) {
			this.updateWorkingLoaderMessage();
		}
		this.setHiddenThinkingLabel();
	}

	private static readonly MAX_WIDGET_LINES = 10;

	private renderWidgets(): void {
		if (!this.widgetContainerAbove || !this.widgetContainerBelow) return;
		this.renderWidgetContainer(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		this.renderWidgetContainer(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.ui.requestRender();
	}

	private renderRecap(): void {
		if (!this.recapContainer) return;
		this.recapContainer.clear();
		const recap = this.sessionRecap?.trim();
		const showChanges = !this.isAgentStreaming() && this.agentRunFileChanges.size > 0;
		if (showChanges) {
			this.recapContainer.addChild(
				new TruncatedText(formatTotalChangeSummary([...this.agentRunFileChanges.values()]), 1, 0),
			);
		}
		if (recap) {
			this.recapContainer.addChild(new TruncatedText(theme.fg("dim", `Recap: ${recap}`), 1, 0));
		}
		if ((recap || showChanges) && !this.featureHintComponent) {
			this.recapContainer.addChild(new Spacer(1));
		}
		this.ui.requestRender();
	}

	private renderWidgetContainer(
		container: Container,
		widgets: Map<string, Component & { dispose?(): void }>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	): void {
		container.clear();

		if (widgets.size === 0) {
			if (spacerWhenEmpty) {
				container.addChild(new Spacer(1));
			}
			return;
		}

		if (leadingSpacer) {
			container.addChild(new Spacer(1));
		}
		for (const component of widgets.values()) {
			container.addChild(component);
		}
	}

	private setExtensionFooter(
		factory:
			| ((tui: TUI, thm: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void })
			| undefined,
	): void {
		if (this.customFooter?.dispose) {
			this.customFooter.dispose();
		}

		if (this.customFooter) {
			this.footerSlot.removeChild(this.customFooter);
		} else {
			this.footerSlot.removeChild(this.footer);
		}

		if (factory) {
			this.customFooter = factory(this.ui, theme, this.footerDataProvider);
			this.footerSlot.addChild(this.customFooter);
		} else {
			this.customFooter = undefined;
			this.footerSlot.addChild(this.footer);
		}

		this.ui.requestRender();
	}

	private setExtensionHeader(factory: ((tui: TUI, thm: Theme) => Component & { dispose?(): void }) | undefined): void {
		// Header may not be initialized yet if called during early initialization
		if (!this.builtInHeader) {
			return;
		}

		if (this.customHeader?.dispose) {
			this.customHeader.dispose();
		}

		// Find the index of the current header in the header container
		const currentHeader = this.customHeader || this.builtInHeader;
		const index = this.headerContainer.children.indexOf(currentHeader);

		if (factory) {
			this.customHeader = factory(this.ui, theme);
			if (isExpandable(this.customHeader)) {
				this.customHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.customHeader;
			} else {
				// If not found (e.g. builtInHeader was never added), add at the top
				this.headerContainer.children.unshift(this.customHeader);
			}
		} else {
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) {
				this.builtInHeader.setExpanded(this.toolOutputExpanded);
			}
			if (index !== -1) {
				this.headerContainer.children[index] = this.builtInHeader;
			}
		}

		this.ui.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.ui.addInputListener(handler);
		this.extensionTerminalInputUnsubscribers.add(unsubscribe);
		return () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(unsubscribe);
		};
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const unsubscribe of this.extensionTerminalInputUnsubscribers) {
			unsubscribe();
		}
		this.extensionTerminalInputUnsubscribers.clear();
	}

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) => this.showExtensionSelector(title, options, opts),
			confirm: (title, message, opts) => this.showExtensionConfirm(title, message, opts),
			input: (title, placeholder, opts) => this.showExtensionInput(title, placeholder, opts),
			notify: (message, type) => this.showExtensionNotify(message, type),
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.loadingAnimation) {
					this.updateWorkingLoaderMessage();
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key, content, options) => this.setExtensionWidget(key, content, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui.terminal.setTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.editor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.editor.setText(text),
			getEditorText: () => this.editor.getExpandedText?.() ?? this.editor.getText(),
			editor: (title, prefill) => this.showExtensionEditor(title, prefill),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) {
					setThemeInstance(themeOrName);
					this.ui.requestRender();
					return { success: true };
				}
				const result = setTheme(themeOrName, true);
				if (result.success) {
					if (this.settingsManager.getTheme() !== themeOrName) {
						this.settingsManager.setTheme(themeOrName);
					}
					this.ui.requestRender();
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	private showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionSelector();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionSelector = new ExtensionSelectorComponent(
				title,
				options,
				(option) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(option);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionSelector();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionSelector);
			this.ui.setFocus(this.extensionSelector);
			this.ui.requestRender();
		});
	}

	private hideExtensionSelector(): void {
		this.extensionSelector?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionSelector = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private async showExtensionConfirm(
		title: string,
		message: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<boolean> {
		const result = await this.showExtensionSelector(`${title}\n${message}`, ["Yes", "No"], opts);
		return result === "Yes";
	}

	private async promptForMissingSessionCwd(error: MissingSessionCwdError): Promise<string | undefined> {
		const confirmed = await this.showExtensionConfirm(
			"Session cwd not found",
			formatMissingSessionCwdPrompt(error.issue),
		);
		return confirmed ? error.issue.fallbackCwd : undefined;
	}

	private showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined> {
		return new Promise((resolve) => {
			if (opts?.signal?.aborted) {
				resolve(undefined);
				return;
			}

			const onAbort = () => {
				this.hideExtensionInput();
				resolve(undefined);
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });

			this.extensionInput = new ExtensionInputComponent(
				title,
				placeholder,
				(value) => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(value);
				},
				() => {
					opts?.signal?.removeEventListener("abort", onAbort);
					this.hideExtensionInput();
					resolve(undefined);
				},
				{ tui: this.ui, timeout: opts?.timeout },
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionInput);
			this.ui.setFocus(this.extensionInput);
			this.ui.requestRender();
		});
	}

	private hideExtensionInput(): void {
		this.extensionInput?.dispose();
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionInput = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private showExtensionEditor(title: string, prefill?: string): Promise<string | undefined> {
		return new Promise((resolve) => {
			this.extensionEditor = new ExtensionEditorComponent(
				this.ui,
				this.keybindings,
				title,
				prefill,
				(value) => {
					this.hideExtensionEditor();
					resolve(value);
				},
				() => {
					this.hideExtensionEditor();
					resolve(undefined);
				},
			);

			this.editorContainer.clear();
			this.editorContainer.addChild(this.extensionEditor);
			this.ui.setFocus(this.extensionEditor);
			this.ui.requestRender();
		});
	}

	private hideExtensionEditor(): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(this.editor);
		this.extensionEditor = undefined;
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;
		// Snapshot the current editor before replacing it. Paste markers are only
		// meaningful while their originating editor still owns the paste snapshot.
		const currentEditor = this.editor;
		const currentPromptStash = this.snapshotPromptStashFrom(currentEditor, currentEditor.getText());

		this.editorContainer.clear();

		if (factory) {
			// Create the custom editor with tui, theme, and keybindings
			const newEditor = factory(this.ui, getEditorTheme(), this.keybindings);

			// Restore before wiring the shared onChange callback: setText may emit a
			// change, and an empty custom editor cannot reconstruct the old snapshot.
			const canRestorePasteSnapshot =
				currentPromptStash.pasteSnapshot === undefined || newEditor.restorePasteSnapshot !== undefined;
			newEditor.setText(
				canRestorePasteSnapshot
					? currentPromptStash.text
					: (currentPromptStash.expandedText ?? currentPromptStash.text),
			);
			if (currentPromptStash.pasteSnapshot && newEditor.restorePasteSnapshot) {
				newEditor.restorePasteSnapshot(currentPromptStash.pasteSnapshot);
			}

			// Wire up callbacks from the default editor. onChange snapshots the
			// active editor while it still owns paste markers and attachments, so
			// submit remains exact even when an editor clears before calling onSubmit.
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;

			// Copy appearance settings if supported
			if (newEditor.borderColor !== undefined) {
				newEditor.borderColor = this.defaultEditor.borderColor;
			}
			if (newEditor.setPaddingX !== undefined) {
				newEditor.setPaddingX(this.defaultEditor.getPaddingX());
			}

			// Set autocomplete if supported
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}

			// If extending CustomEditor, copy app-level handlers
			// Use duck typing since instanceof fails across jiti module boundaries
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				if (!customEditor.onEscape) {
					customEditor.onEscape = () => this.defaultEditor.onEscape?.();
				}
				if (!customEditor.onCtrlD) {
					customEditor.onCtrlD = () => this.defaultEditor.onCtrlD?.();
				}
				if (!customEditor.onPasteImage) {
					customEditor.onPasteImage = () => this.defaultEditor.onPasteImage?.();
				}
				if (!customEditor.onMoveBelowPrompt) {
					customEditor.onMoveBelowPrompt = () => this.defaultEditor.onMoveBelowPrompt?.();
				}
				if (!customEditor.onAgentsBack) {
					customEditor.onAgentsBack = () => this.defaultEditor.onAgentsBack?.();
				}
				if (!customEditor.onExtensionShortcut) {
					customEditor.onExtensionShortcut = (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				}
				// Copy action handlers (clear, suspend, model switching, etc.)
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}

			this.editor = newEditor;
		} else {
			// Restore the default editor with the same rich snapshot (or expanded
			// fallback text if this editor implementation cannot restore it).
			const canRestorePasteSnapshot =
				currentPromptStash.pasteSnapshot === undefined || this.defaultEditor.restorePasteSnapshot !== undefined;
			this.defaultEditor.setText(
				canRestorePasteSnapshot
					? currentPromptStash.text
					: (currentPromptStash.expandedText ?? currentPromptStash.text),
			);
			if (currentPromptStash.pasteSnapshot && this.defaultEditor.restorePasteSnapshot) {
				this.defaultEditor.restorePasteSnapshot(currentPromptStash.pasteSnapshot);
			}
			this.editor = this.defaultEditor;
		}
		this.latestEditorPromptStash = currentPromptStash;

		this.editorContainer.addChild(this.editor as Component);
		this.ui.setFocus(this.editor as Component);
		this.ui.requestRender();
	}

	private showExtensionNotify(message: string, type?: "info" | "warning" | "error"): void {
		if (type === "error") {
			this.showError(message);
		} else if (type === "warning") {
			this.showWarning(message);
		} else {
			this.showStatus(message);
		}
	}

	/** Show a custom component with keyboard focus. Overlay mode renders on top of existing content. */
	private async showExtensionCustom<T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.editor.getText();
		const isOverlay = options?.overlay ?? false;

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.editor.setText(savedText);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		return new Promise((resolve, reject) => {
			let component: Component & { dispose?(): void };
			let closed = false;

			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) this.ui.hideOverlay();
				else restoreEditor();
				// Note: both branches above already call requestRender
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					/* ignore dispose errors */
				}
			};

			Promise.resolve(factory(this.ui, theme, this.keybindings, close))
				.then((c) => {
					if (closed) return;
					component = c;
					if (isOverlay) {
						// Resolve overlay options - can be static or dynamic function
						const resolveOptions = (): OverlayOptions | undefined => {
							if (options?.overlayOptions) {
								const opts =
									typeof options.overlayOptions === "function"
										? options.overlayOptions()
										: options.overlayOptions;
								return opts;
							}
							// Fallback: use component's width property if available
							const w = (component as { width?: number }).width;
							return w ? { width: w } : undefined;
						};
						const handle = this.ui.showOverlay(component, resolveOptions());
						// Expose handle to caller for visibility control
						options?.onHandle?.(handle);
					} else {
						this.editorContainer.clear();
						this.editorContainer.addChild(component);
						this.ui.setFocus(component);
						this.ui.requestRender();
					}
				})
				.catch((err) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(err);
				});
		});
	}

	/**
	 * Show an extension error in the UI.
	 */
	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const errorMsg = `Extension "${extensionPath}" error: ${error}`;
		const errorText = new Text(theme.fg("error", errorMsg), 1, 0);
		this.chatContainer.addChild(errorText);
		if (stack) {
			// Show stack trace in dim color, indented
			const stackLines = stack
				.split("\n")
				.slice(1) // Skip first line (duplicates error message)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) {
				this.chatContainer.addChild(new Text(stackLines, 1, 0));
			}
		}
		this.ui.requestRender();
	}

	private setupKeyHandlers(): void {
		this.defaultEditor.getHeaderLine = () => this.getQueueSelectionHeader();
		// Set up handlers on defaultEditor - they use this.editor for text access
		// so they work correctly regardless of which editor is active
		this.defaultEditor.onEscape = () => {
			this.handleEscape();
		};

		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onAction("app.interrupt", () => this.handleInterruptKey());
		this.defaultEditor.onAction("app.shortcuts", () => this.showShortcutGuide());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());

		// Global debug handler on TUI (works regardless of focus)
		this.ui.onDebug = () => {
			void this.handleDebugCommand();
		};
		this.defaultEditor.onAction("app.model.select", () => this.showModelSelector());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.messages.expand", () => this.toggleAgentMessageExpansion());
		this.defaultEditor.onAction("app.edits.expand", () => this.toggleEditDiffExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.subagents.focus", () => this.focusSubagentSummary());
		this.defaultEditor.onAction("app.heartbeats.open", () => {
			void this.showHeartbeatManager();
		});
		this.defaultEditor.onAction("app.editor.external", () => this.openExternalEditor());
		this.defaultEditor.onAction("app.prompt.stash", () => this.handlePromptStash());
		this.defaultEditor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.defaultEditor.onAction("app.message.navigateOlder", () => this.browseQueueSelection(-1));
		this.defaultEditor.onAction("app.message.navigateNewer", () => this.browseQueueSelection(1));
		this.defaultEditor.onAction("app.message.moveEarlier", () => this.moveQueueSelection(-1));
		this.defaultEditor.onAction("app.message.moveLater", () => this.moveQueueSelection(1));
		this.defaultEditor.onAction("app.session.new", () => this.handleClearCommand());
		this.defaultEditor.onAction("app.session.tree", () => {
			void this.showTreeSelector();
		});
		this.defaultEditor.onAction("app.session.fork", () => {
			void this.showUserMessageSelector();
		});
		this.defaultEditor.onAction("app.session.resume", () => {
			void this.requestAgentsView();
		});
		this.defaultEditor.onAgentsBack = () => this.handleAgentsBack();
		this.defaultEditor.onMoveBelowPrompt = () => this.focusSubagentSummary();

		this.defaultEditor.onChange = (text: string) => {
			if (text.length > 0 && !this.isApplyingQueueSelectionText) {
				this.latestEditorPromptStash = this.snapshotPromptStashFrom(this.editor, text);
			}
			if (this.escapeRepeatAction && !this.isApplyingQueueSelectionText) {
				this.clearEscapeRepeat();
			}
			if (text.length > 0) {
				this.clearCtrlCExitHint();
			}
		};

		this.defaultEditor.onPasteImage = () => {
			this.handleClipboardImagePaste();
		};
	}

	private snapshotPromptStashFrom(editor: EditorComponent, text: string): PromptStash {
		const pasteSnapshot = editor.getPasteSnapshot?.();
		const images = this.getPromptStashImages(text);
		return {
			text,
			expandedText: pasteSnapshot ? (editor.getExpandedText?.() ?? text) : undefined,
			pasteSnapshot,
			...(images.length > 0 ? { images } : {}),
		};
	}

	private snapshotPromptStash(text: string): PromptStash {
		return this.snapshotPromptStashFrom(this.editor, text);
	}

	private restorePromptStashOnOpen(): void {
		if (!this.promptStash?.restoreOnOpen) return;
		// Land the restore notice in its own status block: init may have just posted
		// a notice (e.g. compaction) that showStatus would otherwise replace.
		this.lastStatusText = undefined;
		this.lastStatusSpacer = undefined;
		this.restorePromptStashIfEditorEmpty();
	}

	private stashDraftForAgentsView(): void {
		const text = this.editor.getText();
		if (!text.trim()) return;
		// Head of the durable queue so it restores first on return; an existing
		// manual stash stays queued behind it and keeps its manual-stash semantics.
		const existing = [this.promptStashState.stash, ...(this.promptStashState.queuedStashes ?? [])].filter(
			(stash): stash is PromptStash => stash !== undefined,
		);
		this.promptStashState.stash = { ...this.snapshotPromptStash(text), restoreOnOpen: true };
		this.promptStashState.queuedStashes = existing.length > 0 ? existing : undefined;
	}

	private handlePromptStash(): void {
		const text = this.editor.getText();
		if (!text.trim()) {
			if (!this.restorePromptStashIfEditorEmpty()) {
				this.showStatus("No prompt to stash");
			}
			return;
		}
		if (this.promptStash !== undefined) {
			this.showStatus("Prompt stash already has a draft");
			return;
		}
		this.promptStash = this.snapshotPromptStash(text);
		this.editor.setText("");
		this.showStatus("Stashed prompt");
	}

	private restorePromptStashIfEditorEmpty(stash = this.promptStash): boolean {
		if (stash === undefined || this.editor.getText().trim()) {
			return false;
		}
		if (this.promptStash !== stash) {
			return false;
		}
		this.promptStash = this.promptStashState?.queuedStashes?.shift();
		if (this.promptStashState?.queuedStashes?.length === 0) this.promptStashState.queuedStashes = undefined;
		const canRestorePasteSnapshot =
			stash.pasteSnapshot === undefined || this.editor.restorePasteSnapshot !== undefined;
		this.editor.setText(canRestorePasteSnapshot ? stash.text : (stash.expandedText ?? stash.text));
		if (stash.pasteSnapshot && this.editor.restorePasteSnapshot) {
			this.editor.restorePasteSnapshot(stash.pasteSnapshot);
		}
		this.latestEditorPromptStash = this.snapshotPromptStash(this.editor.getText());
		this.showStatus("Restored stashed prompt");
		return true;
	}

	private retainSubmittedDraft(
		stash: PromptStash,
		submissionGeneration: number,
		state: PromptStashState = this.promptStashState,
	): void {
		this.retainedSubmissionGenerations.set(stash, submissionGeneration);
		const ordered = [state.stash, ...(state.queuedStashes ?? [])].filter(
			(candidate): candidate is PromptStash => candidate !== undefined,
		);
		const insertAt = ordered.findIndex((candidate) => {
			const generation = this.retainedSubmissionGenerations.get(candidate);
			return generation !== undefined && generation > submissionGeneration;
		});
		ordered.splice(insertAt === -1 ? ordered.length : insertAt, 0, stash);
		state.stash = ordered.shift();
		state.queuedStashes = ordered.length > 0 ? ordered : undefined;
	}

	private retainStartupPromptDrafts(prompts: readonly InteractiveInitialPrompt[]): void {
		// Reserve every marker visible anywhere in the retained batch before assigning
		// any image. This prevents an early prompt's attachment from making a literal
		// marker in a later prompt resolve to the wrong image.
		const reserved = new Set(this.pastedImages.keys());
		for (const stash of [this.promptStash, ...(this.promptStashState.queuedStashes ?? [])]) {
			if (stash) for (const markerId of imageMarkerIds(stash.text)) reserved.add(markerId);
		}
		for (const prompt of prompts) {
			for (const markerId of imageMarkerIds(prompt.text)) reserved.add(markerId);
		}
		for (const markerId of reserved) {
			this.nextImageMarkerId = Math.max(this.nextImageMarkerId, markerId + 1);
		}
		const allocateMarker = () => {
			while (reserved.has(this.nextImageMarkerId)) this.nextImageMarkerId++;
			const markerId = this.nextImageMarkerId++;
			reserved.add(markerId);
			return markerId;
		};

		const retained: PromptStash[] = [];
		for (const prompt of prompts) {
			let text = prompt.text;
			// A startup prompt owns only the images passed with it. Remap literal
			// markers that already name registry data so restoring this draft cannot
			// accidentally attach an old or another prompt's image.
			const literalRemaps = new Map<number, number>();
			for (const markerId of imageMarkerIds(text)) {
				if (this.pastedImages.has(markerId) && !literalRemaps.has(markerId)) {
					literalRemaps.set(markerId, allocateMarker());
				}
			}
			text = remapImageMarkers(text, literalRemaps);

			const images: Array<readonly [number, ImageContent]> = [];
			for (const image of prompt.images ?? []) {
				const markerId = allocateMarker();
				images.push([markerId, image]);
				text += `${text.length > 0 && !/\s$/.test(text) ? " " : ""}${formatImageMarker(markerId)}`;
			}
			retained.push({
				text,
				...(images.length > 0 ? { images } : {}),
			});
			for (const [markerId, image] of images) this.pastedImages.set(markerId, image);
		}

		// Startup drafts form the head of the durable queue. Preserve any older
		// client draft after them, and let submissions released by the barrier append.
		const existing = [this.promptStashState.stash, ...(this.promptStashState.queuedStashes ?? [])].filter(
			(stash): stash is PromptStash => stash !== undefined,
		);
		const ordered = [...retained, ...existing];
		this.promptStashState.stash = ordered.shift();
		this.promptStashState.queuedStashes = ordered.length > 0 ? ordered : undefined;
	}

	private getPromptStashImages(text: string): readonly (readonly [number, ImageContent])[] {
		const images: Array<readonly [number, ImageContent]> = [];
		for (const markerId of imageMarkerIds(text)) {
			const image = this.pastedImages.get(markerId);
			if (image) {
				images.push([markerId, image]);
			}
		}
		return images;
	}

	private async handleClipboardImagePaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (!image) {
				return;
			}

			// Resize down to the inline image size limit, mirroring the CLI @file
			// path, so large screenshots don't exceed provider limits. Fall back to
			// the raw bytes if resizing is unavailable.
			const raw: ImageContent = {
				type: "image",
				data: Buffer.from(image.bytes).toString("base64"),
				mimeType: image.mimeType,
			};
			const resized = await resizeImage(raw);
			const attachment: ImageContent = resized
				? { type: "image", data: resized.data, mimeType: resized.mimeType }
				: raw;

			// Register the image and insert a visible marker. The image is attached to
			// the prompt as multimodal content rather than written to disk, so a vision
			// model receives it directly.
			const markerId = this.nextImageMarkerId++;
			this.rememberPastedImage(markerId, attachment);
			this.editor.insertTextAtCursor?.(formatImageMarker(markerId));
			this.ui.requestRender();

			const model = this.getCurrentModel();
			if (model && !model.input.includes("image")) {
				this.showStatus("Current model does not support images; the attachment will be omitted.");
			}
		} catch {
			// Silently ignore clipboard errors (may not have permission, etc.)
		}
	}

	/**
	 * Record a pasted image, evicting the oldest entries once the retained bytes
	 * exceed {@link MAX_PASTED_IMAGE_BYTES} so a long session stays bounded. The
	 * just-added image and any whose marker is still referenced (editor or queues)
	 * are never evicted, so a live marker never loses its image.
	 */
	private rememberPastedImage(id: number, image: ImageContent): void {
		this.pastedImages.set(id, image);
		const keep = this.liveImageMarkerIds();
		keep.add(id);
		evictImagesToBudget(this.pastedImages, (img) => img.data.length, MAX_PASTED_IMAGE_BYTES, keep);
	}

	/**
	 * Marker ids still reachable — current editor text, prompt history (recallable
	 * with the up arrow), the compaction queue, and the connection queue. These are
	 * never evicted so a recall or resend never finds a marker with no image.
	 */
	private liveImageMarkerIds(): Set<number> {
		const ids = new Set<number>();
		const add = (text: string) => {
			for (const markerId of imageMarkerIds(text)) {
				ids.add(markerId);
			}
		};
		add(this.editor.getText());
		for (const stash of [this.promptStash, ...(this.promptStashState?.queuedStashes ?? [])]) {
			if (stash) add(stash.text);
		}
		for (const entry of this.editor.getHistory?.() ?? []) {
			add(entry);
		}
		const queue = this.getConnectionQueue();
		for (const msg of [...queue.steering, ...queue.followUp]) {
			add(msg);
		}
		return ids;
	}

	/**
	 * The images whose `[image #N]` markers are present in `text`, or undefined if
	 * none. Read-only: the registry is never cleared here, so deleting a marker
	 * simply drops its image while restoring the marker (undo, history, retry,
	 * dequeue) brings it back. Marker presence in the sent text is the single
	 * source of truth.
	 *
	 * Resolved against the current model: if it has no image input, attachments
	 * are dropped here (matching the paste-time hint) rather than sent and
	 * downgraded downstream.
	 */
	private collectImagesFor(text: string): ImageContent[] | undefined {
		const model = this.getCurrentModel();
		if (model && !model.input.includes("image")) {
			return undefined;
		}
		const images = collectMarkedImages(this.pastedImages, text);
		return images.length > 0 ? images : undefined;
	}

	private hasPastedImagesFor(text: string): boolean {
		return imageMarkerIds(text).some((id) => this.pastedImages.has(id));
	}

	private async handleSideQuestion(question: string): Promise<void> {
		if (!question) {
			this.showWarning("Usage: /btw <question>");
			return;
		}
		if (this.activeSideQuestionId) {
			this.showWarning("Wait for the current side question to finish or cancel it first.");
			return;
		}

		// Turns already answered in the open pane seed the follow-up's context.
		const previousTurns = this.sideQuestionTurns
			.filter((turn) => turn.answer)
			.map((turn) => ({ question: turn.question, answer: turn.answer }));
		const event: AgentConnectionSideQuestionEvent = {
			id: randomUUID(),
			question,
			answer: "",
			status: "running",
		};
		this.activeSideQuestionId = event.id;
		this.sideQuestionEvent = event;
		this.sideQuestionTurns.push(event);
		if (this.sideQuestionComponent) {
			this.sideQuestionComponent.addTurn(event);
		} else {
			this.sideQuestionComponent = new SideQuestionComponent(event, this.settingsManager.getEditorPaddingX());
			this.sideQuestionContainer.addChild(new Spacer(1));
			this.sideQuestionContainer.addChild(this.sideQuestionComponent);
		}
		this.ui.requestRender();

		try {
			await this.agentConnection.startSideQuestion(
				event.id,
				question,
				previousTurns.length > 0 ? previousTurns : undefined,
			);
		} catch (error) {
			this.handleSideQuestionEvent({
				...event,
				status: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private handleSideQuestionEvent(event: AgentConnectionSideQuestionEvent): void {
		if (event.id === this.activeSideQuestionId && event.status !== "running") {
			this.activeSideQuestionId = undefined;
		}
		if (event.id !== this.sideQuestionEvent?.id || !this.sideQuestionComponent) {
			return;
		}
		this.sideQuestionEvent = event;
		const turnIndex = this.sideQuestionTurns.findIndex((turn) => turn.id === event.id);
		if (turnIndex !== -1) {
			this.sideQuestionTurns[turnIndex] = event;
		}
		this.sideQuestionComponent.update(event);
		this.ui.requestRender();
	}

	private finishSideQuestionBash(
		event: Extract<AgentConnectionSessionEvent, { type: "bash_end" }>,
		rawOutput: string,
	): void {
		// Release the pane's running state before any early return so the cancel
		// hint cannot stay stuck if the pending state was already cleared.
		this.sideQuestionComponent?.finishBash();
		const bash = this.sideQuestionBash;
		if (!bash) {
			return;
		}
		this.sideQuestionBash = undefined;
		// The pane already rendered the run; this only seeds follow-up turns.
		if (!bash.seedTranscript || event.cancelled || event.errorMessage) {
			return;
		}
		const truncation = truncateTail(rawOutput);
		const output = truncation.content.replace(/\n+$/, "");
		this.sideQuestionTurns.push({
			id: `side-bash-${randomUUID()}`,
			question: bash.input,
			answer: bashOutputToText({
				output,
				exitCode: event.exitCode,
				cancelled: false,
				truncated: event.truncated || truncation.truncated,
				fullOutputPath: event.fullOutputPath,
			}),
			status: "complete",
		});
	}

	private clearSideQuestion(options: { abort?: boolean } = {}): void {
		const event = this.sideQuestionEvent;
		if (options.abort && event?.status === "running") {
			this.abortSideQuestion(event.id);
		}
		if (this.sideQuestionBash) {
			// A side-conversation bash run dies with its pane. Its bash_* events may
			// still be in flight (even bash_start), so swallow them until bash_end.
			const ownsRunningBash = this.sideQuestionBashComponent !== undefined;
			this.sideQuestionBashDiscarded = this.sideQuestionBash.runId;
			this.sideQuestionBash = undefined;
			this.sideQuestionBashComponent = undefined;
			// abort_bash is session-scoped. Before our matching bash_start arrives,
			// another client may own the slot, so only abort a run we have observed.
			if (ownsRunningBash) {
				void this.agentConnection.abortBash().catch(() => undefined);
			}
		}
		this.sideQuestionEvent = undefined;
		this.sideQuestionTurns = [];
		this.sideQuestionComponent = undefined;
		this.sideQuestionContainer.clear();
		if (this.isInitialized) {
			this.ui.requestRender();
		}
	}

	private resetSideQuestion(): void {
		this.clearSideQuestion({ abort: true });
		this.activeSideQuestionId = undefined;
	}

	private abortSideQuestion(id: string, reportError = false): void {
		void this.agentConnection
			.abortSideQuestion(id)
			.then((aborted) => {
				if (!aborted && this.activeSideQuestionId === id) {
					this.activeSideQuestionId = undefined;
				}
			})
			.catch((error) => {
				if (reportError) {
					this.showError(error instanceof Error ? error.message : String(error));
				}
			});
	}

	private async renderTreeNavigation(result: { editorText?: string }): Promise<void> {
		this.clearSideQuestion({ abort: true });
		this.chatContainer.clear();
		await this.renderInitialMessages();
		if (result.editorText && !this.editor.getText().trim()) {
			this.editor.setText(result.editorText);
		}
		this.showStatus("Navigated to selected point");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (text: string) => {
			const streamingBehavior = this.submittedInputBehavior;
			this.submittedInputBehavior = "steer";
			if (this.queueSelection?.isBrowsing && !this.pendingQueueEdit) {
				const targetLane = streamingBehavior === "followUp" ? "followUp" : "steering";
				try {
					if (await this.applyQueueSelection(text, targetLane)) return;
				} catch (error) {
					this.showError(error instanceof Error ? error.message : String(error));
					return;
				}
			}
			text = text.trim();
			if (!text) return;
			const submissionGeneration = ++this.inputSubmissionGeneration;
			this.inputSubmissionsPending++;
			this.clearShortcutGuide();
			// A barrier wait can resume after /new repointed the live session fields.
			const submissionStashState = this.promptStashState;
			const submissionSessionId = this.promptStashSessionId;
			const promptStashToRestore = this.promptStash;
			const liveEditorText = this.editor.getText();
			const submittedDraft =
				this.pendingSubmittedPromptStash ??
				(liveEditorText.trim() ? this.snapshotPromptStash(liveEditorText) : this.latestEditorPromptStash);
			this.pendingSubmittedPromptStash = undefined;
			let restorePromptStashAfterSubmit = true;
			let submissionOutcome: StartupPromptBarrierOutcome = "admitted";

			try {
				const slashCommand = parseSlashCommand(text);
				const commandName = slashCommand ? resolveBuiltinSlashCommandName(slashCommand.name) : undefined;
				const commandArgs = slashCommand?.args ?? "";
				const canonicalCommandText = commandName ? `/${commandName}${commandArgs ? ` ${commandArgs}` : ""}` : text;

				// Slash commands are disabled while a side conversation is open: they
				// act on the main session, which is confusing mid-side-chat. The notice
				// renders as a pane response and never reaches the model. A reply that
				// merely starts with "/" (e.g. an absolute path) is not a command and
				// falls through to the side-conversation capture below.
				if (
					this.sideQuestionComponent &&
					slashCommand !== undefined &&
					(isBuiltinSlashCommandName(slashCommand.name) ||
						this.connectionCommands.some((command) => command.name === slashCommand.name))
				) {
					this.editor.addToHistory?.(text);
					this.sideQuestionComponent.addTurn({
						id: `side-notice-${randomUUID()}`,
						question: text,
						answer:
							"Slash commands are not available in side conversations. Press esc to return to the main thread.",
						status: "complete",
					});
					this.ui.requestRender();
					return;
				}
				if (commandName) {
					void captureAgentCommandUsed({
						agentDir: getAgentDir(),
						settingsManager: this.settingsManager,
						commandName,
					}).catch(() => {});
				}

				if (commandName === "btw") {
					this.editor.setText("");
					await this.handleSideQuestion(commandArgs);
					return;
				}
				if (commandName === "settings" && !commandArgs) {
					await this.showSettingsSelector();
					this.editor.setText("");
					return;
				}
				if (commandName === "scoped-models" && !commandArgs) {
					this.editor.setText("");
					await this.showModelsSelector();
					return;
				}
				if (commandName === "model") {
					const searchTerm = commandArgs || undefined;
					this.editor.setText("");
					await this.handleModelCommand(searchTerm);
					return;
				}
				if (commandName === "effort") {
					this.editor.setText("");
					this.handleEffortCommand(commandArgs);
					return;
				}
				if (commandName === "fast") {
					this.editor.setText("");
					if (commandArgs) {
						this.showError("Usage: /fast");
					} else {
						this.handleFastCommand();
					}
					return;
				}
				if (commandName === "export") {
					await this.handleExportCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "import") {
					await this.handleImportCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "share" && !commandArgs) {
					await this.handleShareCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "copy" && !commandArgs) {
					await this.handleCopyCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "name") {
					await this.handleNameCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "rlm-max-depth") {
					this.editor.setText("");
					await this.handleRlmMaxDepthCommand(commandArgs);
					return;
				}
				if (commandName === "session" && !commandArgs) {
					this.echoLocalCommand(text);
					await this.handleSessionCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "system-prompt" && !commandArgs) {
					this.echoLocalCommand(text);
					await this.handleSystemPromptCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "traces") {
					await this.handleTracesCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "context" && !commandArgs) {
					this.echoLocalCommand(text);
					await this.handleContextCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "logs" && !commandArgs) {
					this.echoLocalCommand(text);
					this.handleLogsCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "heartbeat") {
					await this.handleHeartbeatCommand(canonicalCommandText);
					this.editor.setText("");
					return;
				}
				if (commandName === "heartbeats") {
					this.editor.setText("");
					await this.showHeartbeatManager();
					return;
				}
				if (commandName === "changelog" && !commandArgs) {
					this.echoLocalCommand(text);
					this.handleChangelogCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "hotkeys" && !commandArgs) {
					this.echoLocalCommand(text);
					this.handleHotkeysCommand();
					this.editor.setText("");
					return;
				}
				if (commandName === "fork" && !commandArgs) {
					this.editor.setText("");
					await this.showUserMessageSelector();
					return;
				}
				if (commandName === "clone" && !commandArgs) {
					this.editor.setText("");
					await this.handleCloneCommand();
					return;
				}
				if (commandName === "tree" && !commandArgs) {
					this.editor.setText("");
					restorePromptStashAfterSubmit = false;
					await this.showTreeSelector();
					return;
				}
				if (commandName === "login" && !commandArgs) {
					this.editor.setText("");
					await this.showConfigurationMenu("providers");
					return;
				}
				if (commandName === "logout" && !commandArgs) {
					this.editor.setText("");
					await this.showLogoutSelector();
					return;
				}
				if (commandName === "mcp") {
					this.editor.setText("");
					await this.handleMcpCommand(commandArgs);
					return;
				}
				if (slashCommand?.name === "clear") {
					if (commandArgs) {
						this.editor.setText(text);
						this.showError("Usage: /clear");
					} else {
						this.editor.setText("");
						await this.handleClearCommand();
					}
					return;
				}
				if (slashCommand?.name === "new") {
					let options: ReturnType<typeof parseNewSessionCommand>;
					try {
						options = parseNewSessionCommand(text.slice(4));
					} catch (error) {
						this.editor.setText(text);
						this.showError(error instanceof Error ? error.message : String(error));
						return;
					}
					this.editor.setText("");
					await this.handleClearCommand(options);
					return;
				}
				if (commandName === "resume") {
					this.editor.setText("");
					await this.handleResumeCommand(commandArgs);
					return;
				}
				if (commandName === "reload" && !commandArgs) {
					this.editor.setText("");
					await this.handleReloadCommand();
					return;
				}
				if (commandName === "update") {
					this.editor.setText("");
					const updateArgs = parseCommandArgs(commandArgs);
					if (
						!updateArgsIncludeSelf(updateArgs) &&
						(this.isAgentCompacting() || this.isAgentStreaming() || this.isBashRunning())
					) {
						this.showWarning("Wait for the current work to finish before updating.");
						return;
					}
					await this.handleUpdateCommand(commandArgs);
					return;
				}
				if (commandName === "fullscreen") {
					this.editor.setText("");
					const arg = commandArgs?.trim().toLowerCase();
					if (arg && arg !== "on" && arg !== "off") {
						this.showError("Usage: /fullscreen [on|off]");
						return;
					}
					const enable = arg === "on" ? true : arg === "off" ? false : !this.fullscreenEnabled;
					this.setFullscreenMode(enable);
					return;
				}
				if (commandName === "debug" && !commandArgs) {
					await this.handleDebugCommand();
					this.editor.setText("");
					return;
				}
				if (text === "/arminsayshi") {
					this.handleArminSaysHi();
					this.editor.setText("");
					return;
				}
				if (text === "/dementedelves") {
					this.handleDementedDelves();
					this.editor.setText("");
					return;
				}
				if (text === "/quit") {
					this.editor.setText("");
					await this.shutdown();
					return;
				}

				// Handle bash command (! for normal, !! for excluded from context)
				if (text.startsWith("!")) {
					const isExcluded = text.startsWith("!!");
					const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
					if (!command) {
						// Bare ! / !! is bash mode with nothing to run; don't send it as a prompt
						return;
					}
					if (this.isBashRunning()) {
						this.showWarning(
							`A bash command is already running. Press ${keyText("app.clear")} to cancel it first.`,
						);
						return;
					}
					// A streaming side turn blocks bash just like it blocks follow-up
					// replies: overlapping pane turns would seed out of order.
					if (this.sideQuestionComponent && this.activeSideQuestionId) {
						this.editor.setText(text);
						this.showWarning("Wait for the current side question to finish or cancel it first.");
						return;
					}
					// Inside a side conversation the command runs inside the pane (its
					// bash_start event mounts the usual BashExecutionComponent there),
					// stays out of the main-session context, and (for !, not !!) seeds
					// follow-up side questions.
					const sideBash = this.sideQuestionComponent
						? { runId: randomUUID(), input: text, seedTranscript: !isExcluded }
						: undefined;
					if (sideBash) {
						this.sideQuestionBash = sideBash;
					} else {
						this.clearSideQuestion({ abort: true });
					}
					this.editor.addToHistory?.(text);
					this.editor.setText("");
					// Optimistic: bash_start only fires after extension dispatch, and the
					// clear key must already route to abortBash in that window.
					this.patchConnectionState({ isBashRunning: true });
					try {
						await this.agentConnection.executeBash(command, {
							excludeFromContext: isExcluded || sideBash !== undefined,
							...(sideBash ? { transient: true, runId: sideBash.runId } : {}),
						});
					} catch (error) {
						// Re-sync rather than assume idle: the rejection may mean another
						// client's bash run already holds the slot.
						try {
							const state = await this.agentConnection.getState();
							this.patchConnectionState({ isBashRunning: state.isBashRunning });
						} catch {
							this.patchConnectionState({ isBashRunning: false });
						}
						if (this.sideQuestionBash === sideBash) {
							this.sideQuestionBash = undefined;
						}
						if (sideBash && this.sideQuestionBashDiscarded === sideBash.runId) {
							// The pane discarded this run, but it never started, so no
							// bash_end will arrive to consume the marker.
							this.sideQuestionBashDiscarded = undefined;
						}
						this.showError(error instanceof Error ? error.message : String(error));
					}
					return;
				}

				// An open side-question pane captures replies as follow-up side
				// questions; ! bash routed above and slash commands were rejected
				// earlier with a notice. Esc returns to the main thread.
				if (this.sideQuestionComponent) {
					// A follow-up submitted mid-bash would seed the transcript ahead of
					// the output it reacts to; make it wait like a running side turn.
					// The editor cleared its buffer before onSubmit fired, so blocked
					// paths put the draft back rather than merely skip clearing it.
					if (this.sideQuestionBash) {
						this.editor.setText(text);
						this.showWarning("Wait for the running command to finish or cancel it first.");
						return;
					}
					if (this.activeSideQuestionId) {
						this.editor.setText(text);
						await this.handleSideQuestion(text);
						return;
					}
					// Side questions are text-only end to end; a reply with pasted
					// images gets an in-pane notice instead of silently dropping them.
					if (this.hasPastedImagesFor(text)) {
						this.editor.setText(text);
						this.sideQuestionComponent.addTurn({
							id: `side-notice-${randomUUID()}`,
							question: text,
							answer: "Images are not supported in side conversations. Press esc to return to the main thread.",
							status: "complete",
						});
						this.ui.requestRender();
						return;
					}
					this.editor.addToHistory?.(text);
					await this.handleSideQuestion(text);
					return;
				}

				this.clearSideQuestion({ abort: true });
				this.flushPendingBashComponents();
				const images = this.collectImagesFor(text);
				this.editor.addToHistory?.(text);
				this.editor.setText("");
				const promptStashAfterClear = this.promptStash;
				submissionOutcome = (await this.admitPendingStartupPrompts?.()) ?? "admitted";
				// Retention is not admission. Startup drafts were inserted synchronously
				// before the barrier settled, so append this blocked submission behind them
				// and never let it prompt or overtake them.
				if (submissionOutcome === "retained") {
					this.retainSubmittedDraft(submittedDraft ?? { text }, submissionGeneration);
					return;
				}
				// The barrier also settles when the run lifecycle ends; a submit resumed
				// by teardown must neither prompt nor mutate the editor/durable stash.
				if (
					submissionOutcome === "lifecycle-cancelled" ||
					this.isShuttingDown ||
					this.agentsViewRequest ||
					this.promptStashSessionId !== submissionSessionId
				) {
					// The editor is already torn down, but its shared session stash outlives
					// this view. Preserve the submitted draft in the stash of the session it
					// was typed for, without overwriting an explicit older stash.
					this.retainSubmittedDraft(submittedDraft ?? { text }, submissionGeneration, submissionStashState);
					submissionOutcome = "lifecycle-cancelled";
					return;
				}
				try {
					await this.agentConnection.prompt(text, {
						streamingBehavior,
						queueIfBusy: true,
						images,
					});
				} catch (error) {
					// Generation guards editor ownership, not draft durability: a stale
					// rejection must be retained rather than overwrite newer input or vanish.
					const rejectedDraft = submittedDraft ?? { text };
					const canRestore =
						!this.isShuttingDown &&
						!this.agentsViewRequest &&
						submissionGeneration === this.inputSubmissionGeneration &&
						this.editor.getText().length === 0;
					if (canRestore) {
						const canRestorePasteSnapshot =
							rejectedDraft.pasteSnapshot === undefined || this.editor.restorePasteSnapshot !== undefined;
						this.editor.setText(
							canRestorePasteSnapshot ? rejectedDraft.text : (rejectedDraft.expandedText ?? rejectedDraft.text),
						);
						if (rejectedDraft.pasteSnapshot && this.editor.restorePasteSnapshot) {
							this.editor.restorePasteSnapshot(rejectedDraft.pasteSnapshot);
						}
						this.latestEditorPromptStash = this.snapshotPromptStash(this.editor.getText());
						if (this.promptStash === promptStashAfterClear) this.promptStash = promptStashToRestore;
					} else {
						this.retainSubmittedDraft(rejectedDraft, submissionGeneration, submissionStashState);
					}
					this.showError(error instanceof Error ? error.message : String(error));
					return;
				}
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
			} finally {
				if (this.isShuttingDown || this.agentsViewRequest) {
					submissionOutcome = "lifecycle-cancelled";
				}
				if (
					submissionOutcome === "admitted" &&
					restorePromptStashAfterSubmit &&
					promptStashToRestore !== undefined &&
					submissionGeneration === this.inputSubmissionGeneration
				) {
					this.restorePromptStashIfEditorEmpty(promptStashToRestore);
				}
				this.inputSubmissionsPending--;
				if (this.inputSubmissionsPending === 0 && this.pendingPromptStashReleases.length > 0) {
					this.completeDeferredPromptStashRelease();
				}
			}
		};
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.agentConnection.subscribe(async (event) => {
			try {
				if (event.type === "session_event") {
					// Connection adapters dispatch without awaiting, so serialize events.
					// Replacement advances the generation before entering this queue, which
					// prevents already-queued source events from mutating the target UI.
					const generation = this.sessionEventGeneration;
					const run = this.sessionEventQueue.then(() =>
						generation === this.sessionEventGeneration ? this.handleEvent(event.event) : undefined,
					);
					this.sessionEventQueue = run.catch(() => {});
					await run;
				} else if (event.type === "session_replaced") {
					const generation = ++this.sessionEventGeneration;
					const run = this.sessionEventQueue.then(async () => {
						if (generation !== this.sessionEventGeneration) return;
						this.resetSideQuestion();
						this.resetExtensionUI();
						this.applyConnectionStateSnapshot(event.state);
						this.resetCurrentSessionRenderState();
						await this.rebindCurrentSession();
						await this.renderInitialMessages();
						this.ui.requestRender();
					});
					this.sessionEventQueue = run.catch(() => {});
					await run;
				} else if (event.type === "session_resynced") {
					const generation = this.sessionEventGeneration;
					const run = this.sessionEventQueue.then(async () => {
						if (generation !== this.sessionEventGeneration) return false;
						await this.refreshCommandCatalogForCurrentSession?.();
						if (generation !== this.sessionEventGeneration) return false;
						await this.renderResyncedSession(event.snapshot);
						return true;
					});
					this.sessionEventQueue = run.then(() => undefined).catch(() => {});
					if (await run) this.ui.requestRender();
				} else if (event.type === "session_status") {
					this.sessionRecap = event.recap;
					this.patchConnectionState({ recap: event.recap });
					this.renderRecap();
				} else if (event.type === "side_question_event") {
					this.handleSideQuestionEvent(event.event);
				} else if (event.type === "extension_ui_request") {
					await this.handleConnectionExtensionUiRequest(event.request);
				} else if (event.type === "connection_status") {
					this.showStatus(
						event.status === "connected" ? "Daemon reconnected" : "Daemon connection lost; reconnecting…",
						event.status === "reconnecting" ? "warning" : "dim",
					);
					if (event.status === "connected") {
						await this.refreshHeartbeatCatalog();
					}
				} else if (event.type === "heartbeats_changed") {
					await this.refreshHeartbeatCatalog();
				} else if (event.type === "closed") {
					this.showError(event.error ?? "Agent connection closed");
				}
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
		});
	}

	private async handleConnectionExtensionUiRequest(request: AgentConnectionExtensionUiRequest): Promise<void> {
		let response: AgentConnectionExtensionUiResponse | undefined;
		const expectsResponse = this.expectsConnectionExtensionUiResponse(request);

		try {
			if (expectsResponse) {
				let cancelLocal: (response: AgentConnectionExtensionUiResponse) => void = () => {};
				const cancelled = new Promise<AgentConnectionExtensionUiResponse>((resolve) => {
					cancelLocal = resolve;
				});
				this.activeConnectionExtensionUiRequests.set(request.id, {
					cancelLocal: () => cancelLocal({ cancelled: true }),
				});
				response = await Promise.race([this.resolveConnectionExtensionUiRequest(request), cancelled]);
			} else {
				response = await this.resolveConnectionExtensionUiRequest(request);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			response = { cancelled: true };
		}

		if (response === undefined) {
			this.activeConnectionExtensionUiRequests.delete(request.id);
			return;
		}

		if (!this.activeConnectionExtensionUiRequests.delete(request.id)) {
			return;
		}

		try {
			await this.agentConnection.respondToExtensionUiRequest(request.id, response);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private expectsConnectionExtensionUiResponse(request: AgentConnectionExtensionUiRequest): boolean {
		return (
			request.method === "select" ||
			request.method === "confirm" ||
			request.method === "input" ||
			request.method === "editor"
		);
	}

	private cancelActiveConnectionExtensionUiRequests(): void {
		const requestIds = [...this.activeConnectionExtensionUiRequests.keys()];
		for (const requestId of requestIds) {
			const activeRequest = this.activeConnectionExtensionUiRequests.get(requestId);
			if (!activeRequest) {
				continue;
			}
			this.activeConnectionExtensionUiRequests.delete(requestId);
			activeRequest.cancelLocal();
			void this.agentConnection.respondToExtensionUiRequest(requestId, { cancelled: true }).catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
		}
	}

	private async resolveConnectionExtensionUiRequest(
		request: AgentConnectionExtensionUiRequest,
	): Promise<AgentConnectionExtensionUiResponse | undefined> {
		const { payload } = request;
		switch (request.method) {
			case "select": {
				const title = getPayloadString(payload, "title");
				const options = getPayloadStringArray(payload, "options");
				if (!title || !options) {
					return { cancelled: true };
				}
				const value = await this.showExtensionSelector(title, options, {
					timeout: getPayloadNumber(payload, "timeout"),
				});
				return value === undefined ? { cancelled: true } : { value };
			}
			case "confirm": {
				const title = getPayloadString(payload, "title");
				const message = getPayloadString(payload, "message");
				if (!title || message === undefined) {
					return { cancelled: true };
				}
				const confirmed = await this.showExtensionConfirm(title, message, {
					timeout: getPayloadNumber(payload, "timeout"),
				});
				return { confirmed };
			}
			case "input": {
				const title = getPayloadString(payload, "title");
				if (!title) {
					return { cancelled: true };
				}
				const value = await this.showExtensionInput(title, getPayloadString(payload, "placeholder"), {
					timeout: getPayloadNumber(payload, "timeout"),
				});
				return value === undefined ? { cancelled: true } : { value };
			}
			case "editor": {
				const title = getPayloadString(payload, "title");
				if (!title) {
					return { cancelled: true };
				}
				const value = await this.showExtensionEditor(title, getPayloadString(payload, "prefill"));
				return value === undefined ? { cancelled: true } : { value };
			}
			case "notify": {
				const message = getPayloadString(payload, "message");
				if (message) {
					this.showExtensionNotify(message, getPayloadNotifyType(payload, "notifyType"));
				}
				return undefined;
			}
			case "setStatus": {
				const key = getPayloadString(payload, "statusKey");
				if (key) {
					this.setExtensionStatus(key, getPayloadString(payload, "statusText"));
				}
				return undefined;
			}
			case "setWorkingMessage": {
				this.workingMessage = getPayloadString(payload, "message");
				if (this.loadingAnimation) {
					this.updateWorkingLoaderMessage();
				}
				return undefined;
			}
			case "setWorkingVisible": {
				const visible = getPayloadBoolean(payload, "visible");
				if (visible !== undefined) {
					this.setWorkingVisible(visible);
				}
				return undefined;
			}
			case "setWorkingIndicator": {
				this.setWorkingIndicator(getPayloadWorkingIndicatorOptions(payload, "options"));
				return undefined;
			}
			case "setHiddenThinkingLabel": {
				this.setHiddenThinkingLabel(getPayloadString(payload, "label"));
				return undefined;
			}
			case "setWidget": {
				const key = getPayloadString(payload, "widgetKey");
				if (key) {
					const placement = getPayloadWidgetPlacement(payload, "widgetPlacement");
					this.setExtensionWidget(
						key,
						getPayloadStringArray(payload, "widgetLines"),
						placement ? { placement } : undefined,
					);
				}
				return undefined;
			}
			case "setTitle": {
				const title = getPayloadString(payload, "title");
				if (title) {
					this.ui.terminal.setTitle(title);
				}
				return undefined;
			}
			case "setEditorText": {
				const text = getPayloadString(payload, "text");
				if (text !== undefined) {
					this.editor.setText(text);
				}
				return undefined;
			}
			default:
				this.showStatus(`Unsupported extension UI request: ${request.method}`);
				return undefined;
		}
	}

	private async handleEvent(event: AgentConnectionSessionEvent): Promise<void> {
		if (!this.isInitialized) {
			await this.init();
		}

		this.footer.invalidate();
		this.updateConnectionStateFromEvent(event);
		// A new user message resets the activity tracker to 0, so the in-flight baseline must
		// reset with it. (agent_start on auto-retry does not reset the tracker.)
		if (event.type === "message_start") {
			this.prepareFeatureHintRun(event.message);
		}
		if (event.type === "message_start" && (event.message.role === "user" || isAgentSessionMessage(event.message))) {
			this.contextUsageTokenBaseline = 0;
			this.clearShortcutGuide();
			this.agentRunFileChanges.clear();
			this.renderRecap();
		}
		this.activityTracker.handleEvent(event);
		this.updateWorkingLoaderMessage();

		switch (event.type) {
			case "agent_start":
				this.featureHintRunPending = this.getRetryAttempt() === 0;
				this.resetPendingToolState();
				this.renderRecap();
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(true);
				}
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
				}
				this.stopWorkingLoader();
				if (this.workingVisible) {
					this.startWorkingLoader();
				}
				this.ui.requestRender();
				break;

			case "session_action_update": {
				this.updatePendingMessagesDisplay();
				this.ui.requestRender();
				break;
			}

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "thinking_level_changed":
				this.footer.invalidate();
				this.subagentSummaryLine.invalidate();
				this.updateEditorBorderColor();
				break;

			case "service_tier_changed":
				this.footer.invalidate();
				this.subagentSummaryLine.invalidate();
				break;

			case "bash_start": {
				if (this.sideQuestionBashDiscarded !== undefined) {
					if (event.runId === this.sideQuestionBashDiscarded) {
						// The discarded side run now owns the bash slot. Abort only
						// after matching its identity so a foreign run is never killed.
						void this.agentConnection.abortBash().catch(() => undefined);
						break;
					}
					// A different run claimed the slot, so the discarded run lost the
					// race and can never start (its execute_bash will reject); render
					// this run normally instead of swallowing it.
					this.sideQuestionBashDiscarded = undefined;
				}
				const ownSideBash = this.sideQuestionBash !== undefined && event.runId === this.sideQuestionBash.runId;
				if (event.transient && !ownSideBash) {
					// Another client's side-conversation run: it renders only in that
					// client's pane, never in this window's chat.
					break;
				}
				const component = new BashExecutionComponent(event.command, this.ui, event.excludeFromContext, {
					suppressLeadingSpace: this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
				});
				if (ownSideBash && this.sideQuestionComponent) {
					// Same component as the main thread, mounted inside the pane.
					this.sideQuestionComponent.addBash(component);
					this.sideQuestionBashComponent = component;
				} else if (this.isAgentStreaming()) {
					this.pendingMessagesContainer.addChild(component);
					this.pendingBashComponents.push(component);
				} else {
					this.chatContainer.addChild(component);
				}
				this.activeBashComponent = component;
				this.ui.requestRender();
				break;
			}

			case "bash_output":
				if (this.sideQuestionBashDiscarded !== undefined) {
					break;
				}
				if (this.activeBashComponent) {
					this.activeBashComponent.appendOutput(event.chunk);
					this.ui.requestRender();
				}
				break;

			case "bash_end": {
				if (this.sideQuestionBashDiscarded !== undefined) {
					// Only the discarded run's own end consumes the marker; bash_start
					// already cleared it for any other run that claimed the slot.
					this.sideQuestionBashDiscarded = undefined;
					this.activeBashComponent = undefined;
					this.ui.requestRender();
					break;
				}
				const component = this.activeBashComponent;
				if (component) {
					if (event.errorMessage) {
						component.setFailed(event.errorMessage);
					} else {
						component.setComplete(
							event.exitCode,
							event.cancelled,
							event.truncated ? ({ truncated: true } as TruncationResult) : undefined,
							event.fullOutputPath,
						);
					}
					this.activeBashComponent = undefined;
				} else if (event.errorMessage && !event.transient) {
					// Transient failures surface in the owning client's pane, not here.
					this.showError(`Bash command failed: ${event.errorMessage}`);
				}
				// Seed the side transcript only when our own pane-mounted run ended.
				if (component !== undefined && component === this.sideQuestionBashComponent) {
					this.sideQuestionBashComponent = undefined;
					this.finishSideQuestionBash(event, component.getOutput());
				}
				this.ui.requestRender();
				break;
			}

			case "message_start":
				// The run's first starter anchors the elapsed display; mid-turn steering must not restart it.
				if (this.turnStartedAt === undefined && startsAgentRun(event.message)) {
					this.turnStartedAt = event.message.timestamp;
					if (this.workingStartedAt !== undefined) {
						this.workingStartedAt = event.message.timestamp;
						this.updateWorkingLoaderMessage();
					}
				}
				if (event.message.role === "custom") {
					if (isSessionSlashCommandMessage(event.message) && event.message.details.command.name === "refine") {
						this.startRefineLoader();
					}
					// The /refine result row is the user refine's settle edge; refine_complete
					// alone can belong to an agent/auto refinement the queued /refine waited on.
					if (
						isSessionSlashCommandResultMessage(event.message) &&
						event.message.details.command.name === "refine"
					) {
						this.stopRefineLoader();
					}
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.startAssistantStreamingMessage(event.message);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.ensureAssistantStreamingComponent(event.message).updateContent(this.streamingMessage, true);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							await this.getOrCreatePendingToolComponent(content);
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end":
				if (event.message.role === "user") break;
				if (event.message.role === "assistant") {
					this.streamingMessage = event.message;
					let errorMessage: string | undefined;
					if (this.streamingMessage.stopReason === "aborted") {
						const retryAttempt = this.getRetryAttempt();
						const elapsedSuffix =
							this.workingStartedAt === undefined
								? ""
								: ` · ${this.formatWorkingElapsed(Date.now() - this.workingStartedAt)}`;
						errorMessage =
							retryAttempt > 0
								? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}${elapsedSuffix}`
								: `Operation aborted${elapsedSuffix}`;
						this.streamingMessage.errorMessage = errorMessage;
					}
					this.ensureAssistantStreamingComponent(event.message).updateContent(this.streamingMessage, false);

					if (this.streamingMessage.stopReason === "aborted" || this.streamingMessage.stopReason === "error") {
						if (!errorMessage) {
							errorMessage = this.streamingMessage.errorMessage || "Error";
						}
						for (const [, component] of this.pendingTools.entries()) {
							component.updateResult({
								content: [{ type: "text", text: errorMessage }],
								isError: true,
							});
						}
						this.resetPendingToolState();
					} else {
						// Args are now complete - trigger diff computation for edit tools
						for (const [, component] of this.pendingTools.entries()) {
							component.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					this.footer.invalidate();
				}
				this.ui.requestRender();
				break;

			case "tool_execution_start": {
				this.startedToolCalls.add(event.toolCallId);
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = await this.getOrCreatePendingToolComponent({
						id: event.toolCallId,
						name: event.toolName,
						arguments: event.args,
					});
				}
				if (component) {
					component.markExecutionStarted();
				}
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
					this.startedToolCalls.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "ipython_sent_agent_message": {
				const messages = this.lateIpythonSentAgentMessages.get(event.toolCallId) ?? [];
				if (!messages.some((message) => message.id === event.message.id)) {
					messages.push(event.message);
					this.lateIpythonSentAgentMessages.set(event.toolCallId, messages);
				}
				this.ipythonToolComponents.get(event.toolCallId)?.appendSentAgentMessage(event.message);
				this.ui.requestRender();
				break;
			}

			case "turn_end":
				mergeTurnFileChanges(this.agentRunFileChanges, event.message, event.toolResults, this.getCurrentCwd());
				break;

			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				this.turnStartedAt = undefined;
				// Drops the loader; background subagents are shown by the tree, not the loader.
				this.syncWorkingLoader();
				if (this.streamingComponent) {
					if (this.streamingMessage) {
						this.streamingComponent.updateContent(this.streamingMessage, false);
					} else {
						this.chatContainer.removeChild(this.streamingComponent);
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.flushPendingBashComponents();
				this.resetPendingToolState();
				this.renderRecap();

				this.applyOptimisticContextUsage();
				// Auto-compaction can start server-side while this event is being handled.
				// Do not hold its start event behind a stats RPC; stale refreshes are discarded.
				void this.refreshConnectionContextUsage();

				await this.checkShutdownRequested();

				this.ui.requestRender();
				break;

			case "compaction_start": {
				this.startCompactionLoader(event.reason, event.customInstructions);
				break;
			}

			case "compaction_end": {
				if (this.settingsManager.getShowTerminalProgress()) {
					this.ui.terminal.setProgress(false);
				}
				if (this.autoCompactionLoader) {
					this.autoCompactionLoader.stop();
					this.autoCompactionLoader = undefined;
					this.statusContainer.clear();
				}
				// Restore the working loader if streaming/subagents still warrant it.
				this.syncWorkingLoader();
				if (event.aborted) {
					if (event.reason === "manual") this.showError("Compaction cancelled");
				} else if (event.result) {
					try {
						await this.rebuildChatFromMessages();
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.showError(`Compaction succeeded, but the transcript could not be refreshed: ${message}`);
					}
					await this.refreshConnectionContextUsage();
					this.footer.invalidate();
				} else if (event.errorMessage && event.reason === "manual") {
					if (event.errorSeverity === "warning") this.showWarning(event.errorMessage);
					else this.showError(event.errorMessage);
				}
				this.ui.requestRender();
				break;
			}

			case "auto_retry_start": {
				this.stopWorkingLoader();
				this.statusContainer.clear();
				this.retryCountdown?.dispose();
				const retryMessage = (seconds: number) =>
					`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s... (${keyText("app.clear")} to cancel)`;
				this.retryLoader = new Loader(
					this.ui,
					(spinner) => theme.fg("muted", spinner),
					(text) => theme.fg("muted", text),
					retryMessage(Math.ceil(event.delayMs / 1000)),
				);
				this.retryCountdown = new CountdownTimer(
					event.delayMs,
					this.ui,
					(seconds) => {
						this.retryLoader?.setMessage(retryMessage(seconds));
					},
					() => {
						this.retryCountdown = undefined;
					},
				);
				this.statusContainer.addChild(this.retryLoader);
				this.ui.requestRender();
				break;
			}

			case "auto_retry_end": {
				if (this.retryCountdown) {
					this.retryCountdown.dispose();
					this.retryCountdown = undefined;
				}
				if (this.retryLoader) {
					this.retryLoader.stop();
					this.retryLoader = undefined;
					this.statusContainer.clear();
				}
				// Restore the working loader if streaming/subagents still warrant it.
				this.syncWorkingLoader();
				// Show error only on final failure (success shows normal response)
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				this.ui.requestRender();
				break;
			}

			case "auth_stale": {
				this.applyAuthStaleEvent(event);
				this.ui.requestRender();
				break;
			}

			case "rlm_child_update":
				this.updateSubagentSummary(event.child);
				break;

			case "goal_update":
				this.handleGoalUpdate(event.goal);
				break;

			case "refine_failed":
				// This event has no request identity; the matching command result settles its loader.
				this.showError(`Refinement failed: ${event.error}`);
				break;

			case "refine_complete":
				break;
		}
	}

	private startAssistantStreamingMessage(message: AssistantMessage): void {
		this.streamingComponent = new AssistantMessageComponent(
			undefined,
			this.hideThinkingBlock,
			this.getMarkdownThemeWithSettings(),
			this.hiddenThinkingLabel,
			{
				expanded: this.toolOutputExpanded,
				precededByToolActivity:
					this.chatContainer.children.at(-1) instanceof ToolExecutionComponent ||
					this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
				mermaidTransform: this.mermaidMarkdownTransform,
			},
		);
		this.streamingMessage = message;
		this.chatContainer.addChild(this.streamingComponent);
		this.streamingComponent.updateContent(this.streamingMessage, true);
	}

	private ensureAssistantStreamingComponent(message: AssistantMessage): AssistantMessageComponent {
		let component = this.streamingComponent;
		if (!component) {
			this.startAssistantStreamingMessage(message);
			component = this.streamingComponent;
		}
		if (!component) {
			throw new Error("Failed to create assistant streaming component");
		}
		return component;
	}

	private handleGoalUpdate(goal: GoalState): void {
		this.syncGoalTray(goal);
		if (this.shouldAnnounceGoalUpdate(goal)) {
			this.showStatus(this.formatGoalStatus(goal));
		} else {
			this.ui.requestRender();
		}
	}

	private syncGoalTray(goal: GoalState): void {
		this.subagentSummaryLine.invalidate();
		this.updateGoalTrayTimer(goal);
	}

	private updateGoalTrayTimer(goal: GoalState): void {
		if (goal.status === "active") {
			if (!this.goalTrayTimer) {
				this.goalTrayTimer = setInterval(() => {
					this.subagentSummaryLine.invalidate();
					this.ui.requestRender();
				}, 1000);
				this.goalTrayTimer.unref?.();
			}
			return;
		}
		this.stopGoalTrayTimer();
	}

	private stopGoalTrayTimer(): void {
		if (!this.goalTrayTimer) {
			return;
		}
		clearInterval(this.goalTrayTimer);
		this.goalTrayTimer = undefined;
	}

	private setGoalAnnouncementBaseline(goal: GoalState): void {
		this.lastGoalAnnouncement = this.goalAnnouncementSnapshot(goal);
	}

	private goalAnnouncementSnapshot(goal: GoalState): GoalAnnouncementSnapshot {
		return {
			goalId: goal.goalId,
			status: goal.status,
			objective: goal.objective,
			lastReason: goal.lastReason,
			lastError: goal.lastError,
		};
	}

	private shouldAnnounceGoalUpdate(goal: GoalState): boolean {
		const previous = this.lastGoalAnnouncement;
		const next = this.goalAnnouncementSnapshot(goal);
		this.lastGoalAnnouncement = next;
		if (!previous) {
			return goal.status !== "idle";
		}
		if (previous.status !== next.status) {
			return true;
		}
		if (previous.goalId !== next.goalId) {
			return goal.status !== "idle";
		}
		switch (goal.status) {
			case "active":
				return false;
			case "paused":
			case "budget_limited":
			case "complete":
				return previous.lastReason !== next.lastReason;
			case "error":
				return previous.lastError !== next.lastError;
			case "idle":
				return false;
			default: {
				const _exhaustive: never = goal.status;
				return _exhaustive;
			}
		}
	}

	private formatGoalStatus(goal: GoalState): string {
		const usage = formatGoalUsage(goal);
		const usageText = usage ? ` (${usage})` : "";
		switch (goal.status) {
			case "idle":
				return "No active goal";
			case "active":
				return goal.objective
					? `Goal${this.formatGoalDetailSuffix(goal.objective, visibleWidth("Goal"))}`
					: "Pursuing goal";
			case "paused":
				return goal.lastReason
					? `Goal paused${this.formatGoalDetailSuffix(goal.lastReason, visibleWidth("Goal paused"))}`
					: "Goal paused (/goal resume)";
			case "budget_limited":
				if (goal.lastReason) {
					const prefix = `Goal budget limited${usageText}`;
					return prefix + this.formatGoalDetailSuffix(goal.lastReason, visibleWidth(prefix));
				}
				return `Goal budget limited${usageText}`;
			case "complete":
				return goal.lastReason
					? `Goal complete${this.formatGoalDetailSuffix(goal.lastReason, visibleWidth("Goal complete"))}`
					: "Goal complete";
			case "error":
				return goal.lastError
					? `Goal error${this.formatGoalDetailSuffix(goal.lastError, visibleWidth("Goal error"))}`
					: "Goal error";
			default: {
				const _exhaustive: never = goal.status;
				return _exhaustive;
			}
		}
	}

	private formatGoalDetailSuffix(value: string | undefined, prefixWidth: number): string {
		const detail = value?.replace(/\s+/g, " ").trim();
		if (!detail) {
			return "";
		}
		const availableWidth = Math.min(120, Math.max(1, this.ui.terminal.columns - prefixWidth - 2));
		if (availableWidth < 8) {
			return "";
		}
		return `: ${truncateToWidth(detail, availableWidth)}`;
	}

	private seedSubagentSummary(children: readonly AgentConnectionRlmChildAgentSnapshot[] | undefined): void {
		for (const child of children ?? []) {
			// Live updates can arrive before the initial snapshot; do not replace them
			// with the snapshot's older state.
			if (!this.subagentSnapshots.has(child.id) && child.status !== "cancelled") {
				this.subagentSnapshots.set(child.id, child);
			}
		}
		this.refreshSubagentSummary();
	}

	private replaceSubagentSummary(children: readonly AgentConnectionRlmChildAgentSnapshot[] | undefined): void {
		const next = new Map<string, AgentConnectionRlmChildAgentSnapshot>();
		for (const child of children ?? []) {
			if (child.status === "cancelled") continue;
			const previous = this.subagentSnapshots.get(child.id);
			next.set(child.id, previous ? mergeSubagentSnapshot(previous, child) : child);
		}
		this.subagentSnapshots = next;
		this.refreshSubagentSummary();
	}

	private updateSubagentSummary(child: AgentConnectionRlmChildAgentSnapshot): void {
		if (child.status === "cancelled") {
			this.removeSubagentSnapshot(child.id);
		} else {
			const previous = this.subagentSnapshots.get(child.id);
			this.subagentSnapshots.set(child.id, previous ? mergeSubagentSnapshot(previous, child) : child);
		}
		this.refreshSubagentSummary();
	}

	private refreshSubagentSummary(): void {
		this.scheduleHeartbeatManagerRefresh();
		this.updateSubagentSummaryLine();
		this.updateWorkingPulse();
		this.syncWorkingLoader();
		this.updateWorkingLoaderMessage();
		this.ui.requestRender();
	}

	private updateSubagentSummaryLine(): void {
		const activeHeartbeatSessionIds = new Set(
			this.heartbeatCatalog
				.filter((heartbeat) => heartbeat.job.status === "active")
				.map((heartbeat) => heartbeat.job.activeSessionId),
		);
		this.subagentSummaryLine.setSubagentCounts(
			countDirectSubagentStatuses(this.subagentSnapshots.values(), this.rlmNodeId, activeHeartbeatSessionIds),
		);
		if (!this.subagentSummaryLine.isSelectable() && this.subagentSummaryLine.focused) this.focusEditor();
	}

	private removeSubagentSnapshot(id: string): void {
		this.subagentSnapshots.delete(id);
		for (const child of [...this.subagentSnapshots.values()]) {
			if (child.parentId === id) this.removeSubagentSnapshot(child.id);
		}
	}

	private resetSubagentSummary(): void {
		this.subagentSnapshots.clear();
		this.rlmNodeId = undefined;
		this.updateSubagentSummaryLine();
		this.scheduleHeartbeatManagerRefresh();
		// Clearing snapshots can drop the last running subagent; reconcile the
		// pulse and loader so neither lingers when nothing is in flight.
		this.updateWorkingPulse();
		this.syncWorkingLoader();
	}

	private focusEditor(): void {
		this.ui.setFocus(this.editor);
		this.ui.requestRender();
	}

	private focusSubagentSummary(): boolean {
		if (!this.subagentSummaryLine.isSelectable() || this.getTrayOverrideLabel()) return false;
		this.ui.setFocus(this.subagentSummaryLine);
		this.ui.requestRender();
		return true;
	}

	private async openScopedAgentsView(): Promise<void> {
		if (!this.options.returnToAgentsView) {
			this.focusEditor();
			this.showStatus("The agents view needs the daemon; start without --no-daemon to browse sessions");
			return;
		}
		await this.returnToAgentsView("scoped_agents_view");
	}

	private handleSubagentSummaryChatAction(data: string): void {
		if (this.keybindings.matches(data, "app.tools.expand")) {
			this.toggleToolOutputExpansion();
			return;
		}
		if (this.keybindings.matches(data, "app.messages.expand")) {
			this.toggleAgentMessageExpansion();
			return;
		}
		// A raw "\n" is a newline for the editor, not ctrl+j.
		if (data !== "\n" && this.keybindings.matches(data, "app.edits.expand")) {
			this.toggleEditDiffExpansion();
			return;
		}
		if (this.keybindings.matches(data, "app.thinking.toggle")) {
			this.toggleThinkingBlockVisibility();
			return;
		}
		this.focusEditor();
		this.editor.handleInput(data);
	}

	private getTrayOverrideLabel(): string | undefined {
		if (this.isCtrlCExitHintVisible()) {
			const clearKey = keyText("app.clear");
			return clearKey ? `Press ${clearKey} again to exit` : "Press again to exit";
		}
		const text = this.editor.getExpandedText?.() ?? this.editor.getText();
		if (!this.isAgentStreaming() || !text.trim()) {
			return undefined;
		}
		return `${keyText("app.message.followUp")} to queue message`;
	}

	private getTrayLocationLabel(): string | undefined {
		const modelLabel = this.getModelTrayLabel();
		const hasChildren = this.options.sessionHasChildren === true || (this.subagentSnapshots?.size ?? 0) > 0;
		const depthLabel = formatAgentDepthLabel(this.options.sessionDepth, hasChildren);
		const shortcutsHint = this.getShortcutsTrayHint();
		const agentsHint = this.getAgentsViewTrayHint();
		return [agentsHint, depthLabel, modelLabel, shortcutsHint]
			.filter((label): label is string => label !== undefined)
			.join("  ");
	}

	private getShortcutsTrayHint(): string | undefined {
		if (!this.isNewChat() || this.editor.getText().length > 0) {
			return undefined;
		}
		return keyText("app.shortcuts") ? keyHint("app.shortcuts", "for shortcuts") : "/hotkeys for shortcuts";
	}

	private isNewChat(): boolean {
		return (this.connectionState?.messageCount ?? 0) === 0 && this.connectionState?.isStreaming !== true;
	}

	private getModelTrayLabel(): string {
		const model = this.getCurrentModel();
		if (!model) {
			return "—";
		}
		const parts = [model.name];
		if (model.reasoning) {
			const level = this.connectionState?.thinkingLevel ?? "off";
			if (level !== "off") {
				parts.push(level);
			}
		}
		if (this.connectionState?.serviceTier === "priority") {
			parts.push("fast");
		}
		return parts.join(" • ");
	}

	private getAgentsViewTrayHint(): string | undefined {
		if (!this.options.returnToAgentsView) {
			return undefined;
		}
		return keyHint("app.agents.back", "agents/resume");
	}

	private getTrayContextLabel(): string | undefined {
		const goalLabel = this.getTrayGoalLabel();
		const heartbeatLabel = this.getTrayHeartbeatLabel();
		const usage = this.getConnectionContextUsage();
		const contextLabel =
			usage && typeof usage.tokens === "number" && typeof usage.percent === "number"
				? `${formatTokenCount(usage.tokens)} (${Math.round(usage.percent)}%)`
				: undefined;
		return [goalLabel, heartbeatLabel, contextLabel].filter((label) => label !== undefined).join(" · ") || undefined;
	}

	private getTrayHeartbeatLabel(): string | undefined {
		const heartbeats = this.getScopedHeartbeats();
		if (heartbeats.length === 0) {
			return undefined;
		}
		const paused = heartbeats.filter((heartbeat) => heartbeat.job.status === "paused").length;
		const count = `${heartbeats.length} heartbeat${heartbeats.length === 1 ? "" : "s"}`;
		const pausedLabel = paused ? ` · ${paused} paused` : "";
		const shortcut = keyText("app.heartbeats.open");
		return `${count}${pausedLabel}${shortcut ? ` (${shortcut})` : ""}`;
	}

	private getTrayGoalLabel(): string | undefined {
		const goal = this.getGoalState();
		switch (goal.status) {
			case "active":
				return `Pursuing goal (${this.formatGoalElapsed(goal.timeUsedSeconds)})`;
			case "paused":
				return `Goal paused (${this.formatGoalElapsed(goal.timeUsedSeconds)})`;
			case "budget_limited":
				return `Goal budget limited (${this.formatGoalElapsed(goal.timeUsedSeconds)})`;
			case "idle":
			case "complete":
			case "error":
				return undefined;
			default: {
				const _exhaustive: never = goal.status;
				return _exhaustive;
			}
		}
	}

	private formatGoalElapsed(seconds: number): string {
		const totalSeconds = Math.max(0, Math.trunc(seconds));
		if (totalSeconds < 60) {
			return `${totalSeconds}s`;
		}
		const minutes = Math.floor(totalSeconds / 60);
		const remainingSeconds = totalSeconds % 60;
		if (minutes < 60) {
			return `${minutes}m ${remainingSeconds.toString().padStart(2, "0")}s`;
		}
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		return `${hours}h ${remainingMinutes.toString().padStart(2, "0")}m`;
	}

	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as { text: string }).text).join("");
	}

	private createLegacyHeartbeatPromptMessage(
		message: Message,
		textContent: string,
	): ReturnType<typeof createHeartbeatPromptMessage> | undefined {
		const heartbeat = this.connectionState?.heartbeat;
		if (
			message.role !== "user" ||
			!heartbeat ||
			!this.isTextOnlyUserMessage(message) ||
			textContent.trim() !== heartbeat.prompt.trim() ||
			!this.isLikelyHeartbeatPromptTimestamp(heartbeat, message.timestamp)
		) {
			return undefined;
		}

		return createHeartbeatPromptMessage(heartbeat, message.timestamp);
	}

	private isTextOnlyUserMessage(message: Message): boolean {
		if (message.role !== "user") {
			return false;
		}
		if (typeof message.content === "string") {
			return true;
		}
		return message.content.every((content) => content.type === "text");
	}

	private isLikelyHeartbeatPromptTimestamp(job: AgentCronJob, timestamp: number): boolean {
		const directRunTimes = [job.lastRunAt, job.nextRunAt]
			.map((value) => (value ? Date.parse(value) : Number.NaN))
			.filter((value) => Number.isFinite(value));
		const tolerance = this.heartbeatLegacyPromptToleranceMs(job);
		if (directRunTimes.some((runAt) => Math.abs(timestamp - runAt) <= tolerance)) {
			return true;
		}
		return false;
	}

	private heartbeatLegacyPromptToleranceMs(job: AgentCronJob): number {
		const intervalMs = job.schedule.intervalMs;
		if (!intervalMs || intervalMs <= 0) {
			return HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS;
		}
		return Math.min(
			HEARTBEAT_LEGACY_PROMPT_MAX_TOLERANCE_MS,
			Math.max(HEARTBEAT_LEGACY_PROMPT_MIN_TOLERANCE_MS, intervalMs / 3),
		);
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string, tone: "dim" | "warning" = "dim"): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusText.setText(theme.fg(tone, message));
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		const text = new Text(theme.fg(tone, message), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private async copyFullscreenSelection(text: string): Promise<void> {
		try {
			await copyToClipboard(text);
			this.showStatus("Copied selection to clipboard");
		} catch (error) {
			this.showError(`Failed to copy selection: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	// Local slash commands (/context, /system-prompt, …) print into the chat
	// without round-tripping through the agent, so no user message event echoes
	// the typed command. Render the turn ourselves, mirroring the "user" case
	// above, so the output is anchored to a visible command instead of floating.
	private echoLocalCommand(text: string): void {
		if (this.chatContainer.children.length > 0) {
			this.chatContainer.addChild(new Spacer(1));
		}
		this.chatContainer.addChild(
			new UserMessageComponent(text, this.getMarkdownThemeWithSettings(), (name) =>
				this.isRecognizedSlashCommand(name),
			),
		);
	}

	private addMessageToEditorHistory(message: AgentMessage): void {
		if (message.role !== "user") {
			return;
		}
		const textContent = this.getUserMessageText(message);
		if (textContent && !this.createLegacyHeartbeatPromptMessage(message, textContent)) {
			this.editor.addToHistory?.(textContent);
		}
	}

	private createDisplayedCustomMessageComponent(message: CustomMessage): Component {
		if (isSessionSlashCommandMessage(message)) return new SlashCommandMessageComponent(message.content);
		if (isSessionSlashCommandResultMessage(message)) return new SlashCommandResultMessageComponent(message);
		if (
			message.customType === SESSION_SLASH_COMMAND_CUSTOM_TYPE ||
			message.customType === SESSION_SLASH_COMMAND_RESULT_CUSTOM_TYPE
		) {
			return new UserMessageComponent("[Malformed session command message]", this.getMarkdownThemeWithSettings());
		}
		if (isCompactionOutcomeMessage(message)) return new CompactionOutcomeMessageComponent(message);
		if (message.customType === COMPACTION_OUTCOME_CUSTOM_TYPE) {
			return new MalformedCompactionOutcomeMessageComponent();
		}
		if (isRefinementOutcomeMessage(message)) return new RefinementOutcomeMessageComponent(message);
		if (message.customType === REFINEMENT_OUTCOME_CUSTOM_TYPE) {
			return new MalformedRefinementOutcomeMessageComponent();
		}
		if (isAgentSessionMessage(message)) {
			return new AgentMessageComponent(message, this.getMarkdownThemeWithSettings(), {
				suppressLeadingSpace: isCompactAgentMessageNeighbor(this.chatContainer.children.at(-1)),
			});
		}
		if (isInjectedPromptMessage(message)) {
			return new InjectedPromptMessageComponent(message, this.getMarkdownThemeWithSettings());
		}
		return new CustomMessageComponent(
			message,
			this.bindLocalSessionExtensions
				? this.getLocalSessionHost().getExtensionRunner().getMessageRenderer(message.customType)
				: undefined,
			this.getMarkdownThemeWithSettings(),
		);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.ui, message.excludeFromContext, {
					suppressLeadingSpace: this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
				});
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				if (message.display) {
					const component = this.createDisplayedCustomMessageComponent(message);
					if (isExpandable(component)) {
						component.setExpanded(this.expansionStateFor(component));
					}
					if (hasEditDiffsExpansion(component)) {
						component.setEditDiffsExpanded(this.editDiffsExpanded);
					}
					if (isSessionSlashCommandMessage(message) && this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					this.chatContainer.addChild(component);
				}
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "branchSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					const heartbeatMessage = this.createLegacyHeartbeatPromptMessage(message, textContent);
					if (heartbeatMessage) {
						if (this.chatContainer.children.length > 0) {
							this.chatContainer.addChild(new Spacer(1));
						}
						const component = new InjectedPromptMessageComponent(
							heartbeatMessage,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						break;
					}

					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					const skillBlock = parseSkillBlock(textContent);
					if (skillBlock) {
						const component = new SkillInvocationMessageComponent(
							skillBlock,
							this.getMarkdownThemeWithSettings(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						if (skillBlock.userMessage) {
							const userComponent = new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								(name) => this.isRecognizedSlashCommand(name),
							);
							this.chatContainer.addChild(userComponent);
						}
					} else {
						const userComponent = new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							(name) => this.isRecognizedSlashCommand(name),
						);
						this.chatContainer.addChild(userComponent);
					}
					if (options?.populateHistory) {
						this.editor.addToHistory?.(textContent);
					}
				}
				break;
			}
			case "assistant": {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					this.getMarkdownThemeWithSettings(),
					this.hiddenThinkingLabel,
					{
						expanded: this.toolOutputExpanded,
						precededByToolActivity:
							this.chatContainer.children.at(-1) instanceof ToolExecutionComponent ||
							this.chatContainer.children.at(-1) instanceof AgentMessageComponent,
						mermaidTransform: this.mermaidMarkdownTransform,
					},
				);
				this.chatContainer.addChild(assistantComponent);
				break;
			}
			case "toolResult": {
				break;
			}
			default: {
				const _exhaustive: never = message;
			}
		}
	}

	/**
	 * Render session context to chat. Used for initial load and rebuild after compaction.
	 * @param sessionContext Session context to render
	 * @param options.updateFooter Update footer state
	 * @param options.populateHistory Add user messages to editor history
	 * @param options.clearChat Clear the current transcript immediately before rendering
	 * @param options.limitTranscript Limit transcript replay to the recent tail
	 */
	private orderMessagesForTranscript(messages: AgentMessage[]): AgentMessage[] {
		const summaryIndex = messages.findIndex((message) => message.role === "compactionSummary");
		if (summaryIndex === -1) return messages;
		const summary = messages[summaryIndex];
		if (summary.role !== "compactionSummary") return messages;
		const remaining = messages.filter((_, index) => index !== summaryIndex);
		if (Number.isSafeInteger(summary.retainedMessageCount) && summary.retainedMessageCount! >= 0) {
			const boundary = Math.min(summary.retainedMessageCount!, remaining.length);
			return [...remaining.slice(0, boundary), summary, ...remaining.slice(boundary)];
		}

		// Compatibility for summaries created before retainedMessageCount was added.
		const retained: AgentMessage[] = [];
		const later: AgentMessage[] = [];
		for (const message of remaining) {
			(message.timestamp < summary.timestamp ? retained : later).push(message);
		}
		return [...retained, summary, ...later];
	}

	private async renderSessionContext(
		sessionContext: AgentConnectionSessionContext,
		options: {
			updateFooter?: boolean;
			populateHistory?: boolean;
			clearChat?: boolean;
			limitTranscript?: boolean;
		} = {},
	): Promise<void> {
		this.resetPendingToolState();
		const transcriptMessages = this.orderMessagesForTranscript(sessionContext.messages);
		const messagesToRender = options.limitTranscript ? initialRenderMessages(transcriptMessages) : transcriptMessages;
		this.ipythonToolComponents.clear();
		this.lateIpythonSentAgentMessages.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		const toolNames: string[] = [];
		for (const message of messagesToRender) {
			if (message.role !== "assistant") {
				continue;
			}
			for (const content of message.content) {
				if (content.type === "toolCall") {
					toolNames.push(content.name);
				}
			}
		}
		await this.preloadToolDefinitions(toolNames);

		if (options.clearChat) {
			this.chatContainer.clear();
		}

		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}

		if (options.populateHistory) {
			for (const message of sessionContext.messages) {
				this.addMessageToEditorHistory(message);
			}
		}

		const renderOptions = { ...options, populateHistory: false };

		if (messagesToRender.length < sessionContext.messages.length) {
			this.chatContainer.addChild(
				new Text(
					theme.fg(
						"dim",
						`Showing latest ${messagesToRender.length} of ${sessionContext.messages.length} messages for faster open.`,
					),
					1,
					0,
				),
			);
			this.chatContainer.addChild(new Spacer(1));
		}

		for (const message of messagesToRender) {
			// Assistant messages need special handling for tool calls
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				// Render tool call components
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{
								showImages: this.settingsManager.getShowImages(),
								includeImageDimensions: false,
							},
							this.getCachedToolDefinition(content.name),
							this.ui,
							this.getCurrentCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						component.setAgentMessagesExpanded(this.agentMessagesExpanded);
						component.setEditDiffsExpanded(this.editDiffsExpanded);
						selectLatestToolExpandHint(this.chatContainer.children, component);
						this.chatContainer.addChild(component);
						this.registerIpythonToolComponent(content.name, content.id, component);

						if (message.stopReason === "aborted" || message.stopReason === "error") {
							let errorMessage: string;
							if (message.stopReason === "aborted") {
								const retryAttempt = this.getRetryAttempt();
								errorMessage =
									retryAttempt > 0
										? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
										: message.errorMessage && message.errorMessage !== "Request was aborted"
											? message.errorMessage
											: "Operation aborted";
							} else {
								errorMessage = message.errorMessage || "Error";
							}
							component.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
			} else if (message.role === "toolResult") {
				// Match tool results to pending tool components
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				// All other messages use standard rendering
				this.addMessageToChat(message, renderOptions);
			}
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			component.setIncludeImageDimensions(true);
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	async renderInitialMessages(): Promise<void> {
		const snapshot = await this.agentConnection.getInitialSnapshot();
		const context = this.getSessionContextFromConnectionSnapshot(snapshot);
		const state = snapshot.state;
		const streamingMessage = snapshot.streamingMessage;
		this.rlmNodeId = snapshot.parent?.childId;
		this.seedSubagentSummary(snapshot.children);
		this.applyConnectionStateSnapshot(state);
		this.restoreTurnStartFromMessages(context.messages);
		await this.renderSessionContext(context, {
			updateFooter: true,
			populateHistory: true,
			limitTranscript: true,
		});
		await this.restoreStreamingMessageFromSnapshot(streamingMessage);

		// Show compaction info if session was compacted
		const compactionCount = state.compactionCount;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	private async restoreStreamingMessageFromSnapshot(message: AgentMessage | undefined): Promise<void> {
		if (message?.role === "assistant") {
			this.startAssistantStreamingMessage(message);
			for (const content of message.content) {
				if (content.type === "toolCall") {
					this.startedToolCalls.add(content.id);
					await this.getOrCreatePendingToolComponent(content);
				}
			}
		}
	}

	private getSessionContextFromConnectionSnapshot(snapshot: AgentConnectionSnapshot): AgentConnectionSessionContext {
		if (snapshot.sessionContext) {
			return snapshot.sessionContext;
		}
		return {
			messages: snapshot.messages,
			thinkingLevel: snapshot.state.thinkingLevel,
			serviceTier: snapshot.state.serviceTier,
			model: snapshot.state.model
				? { provider: snapshot.state.model.provider, modelId: snapshot.state.model.id }
				: null,
		};
	}

	async getUserInput(): Promise<string | undefined> {
		if (this.agentsViewRequest) {
			return undefined;
		}
		return new Promise((resolve) => {
			this.onInputCallback = (text: string | undefined) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private async rebuildChatFromMessages(): Promise<void> {
		const context = await this.agentConnection.getSessionContext();
		await this.renderSessionContext(context, { clearChat: true });
	}

	private handleEscape(): void {
		this.clearCtrlCExitHint();
		if (this.sideQuestionEvent) {
			this.clearEscapeRepeat();
			this.clearSideQuestion({ abort: true });
			return;
		}
		const action = this.takeEscapeRepeatAction();
		if (action === "tree") {
			void this.showTreeSelector();
			return;
		}
		if (action === "clear") {
			this.clearInputBar();
			return;
		}

		this.armEscapeRepeat(this.hasInterruptibleWork() || this.editor.getText().length === 0 ? "tree" : "clear");
		this.interruptOrClearInput();
	}

	private armEscapeRepeat(action: "tree" | "clear"): void {
		this.clearEscapeRepeat();
		this.escapeRepeatAction = action;
		this.escapeRepeatExpiresAt = Date.now() + InteractiveMode.ESCAPE_REPEAT_WINDOW_MS;
		this.escapeRepeatTimer = setTimeout(() => {
			this.clearEscapeRepeat();
		}, InteractiveMode.ESCAPE_REPEAT_WINDOW_MS);
		this.escapeRepeatTimer.unref?.();
	}

	private takeEscapeRepeatAction(): "tree" | "clear" | undefined {
		if (!this.escapeRepeatAction || this.escapeRepeatExpiresAt <= Date.now()) {
			this.clearEscapeRepeat();
			return undefined;
		}
		const action = this.escapeRepeatAction;
		this.clearEscapeRepeat();
		return action;
	}

	private clearEscapeRepeat(): void {
		if (this.escapeRepeatTimer) {
			clearTimeout(this.escapeRepeatTimer);
			this.escapeRepeatTimer = undefined;
		}
		this.escapeRepeatAction = undefined;
		this.escapeRepeatExpiresAt = 0;
	}

	private handleCtrlC(): void {
		this.clearEscapeRepeat();
		if (this.isCtrlCExitHintVisible()) {
			void this.shutdown();
			return;
		}
		this.handleInterruptKey();
	}

	private handleInterruptKey(): void {
		this.clearEscapeRepeat();
		this.interruptOrClearInput();
		this.showCtrlCExitHint();
	}

	private interruptOrClearInput(): void {
		this.traceUploadAllAbortController?.abort(new Error("Trace upload cancelled"));
		if (this.sideQuestionEvent?.status === "running") {
			this.abortSideQuestion(this.sideQuestionEvent.id, true);
		}
		if (this.getRetryAttempt() > 0) {
			void this.agentConnection.abortRetry();
		}
		if (this.isAgentCompacting()) {
			void this.agentConnection.abortCompaction();
			void this.agentConnection.abortBranchSummary();
		}
		if (this.isBashRunning()) {
			void this.agentConnection.abortBash();
		}
		if (this.isAgentStreaming()) {
			// The queue is preserved server-side; draining resumes on the next
			// submit or queued-message edit.
			void this.agentConnection.abort().catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
		}
	}

	private showCtrlCExitHint(): void {
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
		}
		this.ctrlCExitHintExpiresAt = Date.now() + InteractiveMode.EXIT_HINT_DURATION_MS;
		this.ctrlCExitHintTimer = setTimeout(() => {
			this.ctrlCExitHintTimer = undefined;
			if (!this.isCtrlCExitHintVisible()) {
				this.ctrlCExitHintExpiresAt = 0;
				this.subagentSummaryLine.invalidate();
				this.ui.requestRender();
			}
		}, InteractiveMode.EXIT_HINT_DURATION_MS);
		this.ctrlCExitHintTimer.unref?.();
		this.subagentSummaryLine.invalidate();
		this.ui.requestRender();
	}

	private clearCtrlCExitHint(options: { render?: boolean } = {}): void {
		if (!this.ctrlCExitHintTimer && this.ctrlCExitHintExpiresAt === 0) {
			return;
		}
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
			this.ctrlCExitHintTimer = undefined;
		}
		this.ctrlCExitHintExpiresAt = 0;
		if (options.render !== false) {
			this.subagentSummaryLine.invalidate();
			this.ui.requestRender();
		}
	}

	private isCtrlCExitHintVisible(): boolean {
		return this.ctrlCExitHintExpiresAt > Date.now();
	}

	private handleCtrlD(): void {
		void this.shutdown();
	}

	/**
	 * Gracefully shutdown the agent.
	 * Stops the TUI before emitting shutdown events so extension UI cleanup cannot
	 * repaint the final frame while the process is exiting.
	 */
	private isShuttingDown = false;

	private async shutdown(): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		this.clearCtrlCExitHint({ render: false });

		// Fetch while the connection is still alive; exit must not fail on a stats error.
		const sessionStats = await this.agentConnection.getSessionStats().catch(() => undefined);

		// Drain any in-flight Kitty key release events before stopping.
		// This prevents escape sequences from leaking to the parent shell over slow SSH.
		await this.ui.terminal.drainInput(1000);

		this.stop();
		try {
			await this.agentConnection.dispose();
		} finally {
			await this.options.onShutdown?.();
		}
		const resumeHint = formatResumeHint(sessionStats);
		if (resumeHint) {
			console.log(resumeHint);
		}
		process.exit(0);
	}

	/**
	 * Tear down the session's terminal UI before handing the terminal back to the
	 * agents view. Drains in-flight Kitty/SSH key-release sequences so they don't
	 * leak into the parent UI, then stops the renderer and theme watcher. Safe to
	 * call from a crash path too; idempotent via stop().
	 */
	async teardownSessionUi(options: { preserveAltScreen?: boolean } = {}): Promise<void> {
		await this.ui.terminal.drainInput(1000).catch(() => undefined);
		this.releasePromptStashSession();
		this.stop({ preserveAltScreen: options.preserveAltScreen });
		stopThemeWatcher();
	}

	private handleAgentsBack(): boolean {
		if (this.editor.getText().trim()) {
			return false;
		}
		if (!this.options.returnToAgentsView) {
			void this.requestAgentsView();
			return true;
		}
		void this.returnToAgentsView();
		return true;
	}

	private async requestAgentsView(): Promise<void> {
		if (!this.options.returnToAgentsView) {
			this.showStatus("The agents view needs the daemon; start without --no-daemon to browse sessions");
			return;
		}
		await this.returnToAgentsView();
	}

	private async returnToAgentsView(request: InteractiveModeRunResult["type"] = "agents_view"): Promise<void> {
		if (this.isShuttingDown || this.agentsViewRequest) return;
		this.stashDraftForAgentsView();
		this.agentsViewRequest = request;
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();

		await this.teardownSessionUi({ preserveAltScreen: true });
		let handoffComplete = false;
		try {
			try {
				await this.agentConnection.dispose();
			} finally {
				await this.options.onShutdown?.();
				this.onInputCallback?.(undefined);
				handoffComplete = true;
			}
		} finally {
			if (!handoffComplete) {
				this.ui.terminal.leaveAltScreen();
				this.ui.terminal.showCursor();
			}
		}
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		// The terminal is gone. Do not run normal shutdown because TUI and
		// extension cleanup can write restore sequences and re-trigger EIO.
		process.exit(129);
	}

	/**
	 * Check if shutdown was requested and perform shutdown if so.
	 */
	private async checkShutdownRequested(): Promise<void> {
		if (!this.shutdownRequested) return;
		await this.shutdown();
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				if (signal === "SIGHUP") {
					this.emergencyTerminalExit();
				}
				killTrackedDetachedChildren();
				void this.shutdown();
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
			}
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The handler is removed on resume.
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			this.ui.start();
			// ui.stop() left the alt screen before suspending; re-enter it
			if (this.fullscreenEnabled) {
				this.applyFullscreen(true);
			}
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			throw error;
		}
	}

	private async handleFollowUp(): Promise<void> {
		const editorText = this.editor.getText();
		const text = (this.editor.getExpandedText?.() ?? editorText).trim();
		if (this.queueSelection?.isBrowsing && !this.pendingQueueEdit) {
			await this.applyQueueSelection(text, "followUp").catch((error) =>
				this.showError(error instanceof Error ? error.message : String(error)),
			);
			return;
		}
		if (!text || !this.editor.onSubmit) return;

		// Unlike Enter, Alt+Enter does not go through Editor.submitValue(), so
		// capture and clear synchronously before an async/local handler can yield.
		this.pendingSubmittedPromptStash = this.snapshotPromptStash(editorText);
		this.editor.setText("");
		this.submittedInputBehavior = "followUp";
		// onSubmit consumes the behavior flag and bumps the generation synchronously;
		// capture the generation so an older failed submit never clobbers newer
		// typing or submissions.
		const submission = this.editor.onSubmit(text);
		this.submittedInputBehavior = "steer";
		const submissionGeneration = this.inputSubmissionGeneration;
		try {
			await submission;
		} catch (error) {
			if (submissionGeneration === this.inputSubmissionGeneration && this.editor.getText().length === 0) {
				this.editor.setText(text);
			}
			throw error;
		}
	}

	private refreshQueueSelectionAt(
		queue: AgentConnectionQueueState,
		selected: QueueSelectionItem,
		index: number,
	): void {
		const dropped = this.queueSelection.refreshAt(queue, selected.lane, index, selected.text);
		if (dropped !== undefined && this.editor.getText() === selected.text) {
			this.setEditorTextFromQueueSelection(dropped);
		}
	}

	private browseQueueSelection(direction: -1 | 1): void {
		if (this.pendingQueueEdit || this.pendingQueueMove) return;
		const text = this.queueSelection.move(this.getConnectionQueue(), this.editor.getText(), direction);
		if (text === undefined) return;
		this.setEditorTextFromQueueSelection(text);
		this.ui.requestRender();
	}

	/** Serializes queue mutations so rapid keypresses never race each other or use stale indices. */
	private enqueueQueueMutation<T>(run: () => Promise<T>): Promise<T> {
		const next = this.queueMutationChain.then(run, run);
		this.queueMutationChain = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private moveQueueSelection(direction: -1 | 1): void {
		if (this.pendingQueueEdit || !this.queueSelection.selected) return;
		const sessionGeneration = this.sessionEventGeneration;
		void this.enqueueQueueMutation(async () => {
			if (sessionGeneration !== this.sessionEventGeneration) return;
			const selected = this.queueSelection.selected;
			if (!selected) return;
			this.pendingQueueMove = true;
			const actionsBefore = this.connectionState?.sessionActions;
			try {
				const status = await this.agentConnection.mutateQueuedMessage(
					selected.lane,
					selected.index,
					selected.text,
					{
						type: "move",
						direction,
					},
				);
				if (sessionGeneration !== this.sessionEventGeneration) return;
				await this.sessionEventQueue;
				if (sessionGeneration !== this.sessionEventGeneration) return;
				// The move's event can land after the response; mirror it locally (events assign a fresh sessionActions).
				if (status === "applied" && actionsBefore && this.connectionState?.sessionActions === actionsBefore) {
					const queue = this.getConnectionQueue();
					const lane = queue[selected.lane];
					const target = selected.index + direction;
					if (lane[selected.index] === selected.text && target >= 0 && target < lane.length) {
						[lane[selected.index], lane[target]] = [lane[target] as string, selected.text];
						this.patchConnectionState({
							sessionActions: { ...actionsBefore, steering: queue.steering, followUps: queue.followUp },
						});
						this.updatePendingMessagesDisplay();
					}
				}
				this.refreshQueueSelectionAt(
					this.getConnectionQueue(),
					selected,
					status === "applied" ? selected.index + direction : selected.index,
				);
				if (status === "applied") this.ui.requestRender();
				else if (status === "unsupported") this.showStatus("Queue editing requires a newer daemon");
				else this.showStatus("Queue changed; reorder not applied");
			} finally {
				this.pendingQueueMove = false;
			}
		}).catch((error) => {
			if (sessionGeneration === this.sessionEventGeneration) {
				this.refreshQueueSelectionFromState();
				this.showError(error instanceof Error ? error.message : String(error));
			}
		});
	}

	/**
	 * Applies the edited text to the selected queued message. Returns true when
	 * the submission was consumed (the caller must not treat it as a new prompt).
	 * Empty text deletes; otherwise replaces, moving the item to `targetLane`.
	 */
	private applyQueueSelection(text: string, targetLane: "steering" | "followUp"): Promise<boolean> {
		if (this.pendingQueueEdit || !this.queueSelection.selected) return Promise.resolve(false);
		const pendingQueueEdit = Symbol("pending-queue-edit");
		this.pendingQueueEdit = pendingQueueEdit;
		const sessionGeneration = this.sessionEventGeneration;
		const submissionGeneration = this.inputSubmissionGeneration;
		const trimmed = text.trim();
		const mutation =
			trimmed.length === 0
				? ({ type: "delete" } as const)
				: ({
						type: "replace",
						text: trimmed,
						images: this.collectQueueReplaceImages(trimmed),
						lane: targetLane,
					} as const);
		const editorTextBefore = this.editor.getText();
		const discardStaleSelection = (): boolean => {
			if (sessionGeneration === this.sessionEventGeneration) return false;
			if (this.pendingQueueEdit === pendingQueueEdit) {
				this.pendingQueueEdit = undefined;
				this.queueSelection.reset();
				if (submissionGeneration === this.inputSubmissionGeneration && this.editor.getText() === editorTextBefore) {
					this.setEditorTextFromQueueSelection("");
				}
				this.ui.requestRender();
			}
			return true;
		};
		return this.enqueueQueueMutation(async () => {
			if (discardStaleSelection()) return true;
			const selected = this.queueSelection.selected;
			let status: AgentConnectionQueuedMessageMutationStatus;
			if (selected) {
				try {
					status = await this.agentConnection.mutateQueuedMessage(
						selected.lane,
						selected.index,
						selected.text,
						mutation,
					);
				} catch (error) {
					if (discardStaleSelection()) return true;
					// The editor was already cleared by Enter; restore the edit before surfacing the error.
					const editorUntouched =
						submissionGeneration === this.inputSubmissionGeneration && this.editor.getText() === editorTextBefore;
					if (editorUntouched) {
						this.setEditorTextFromQueueSelection(text);
					}
					if (!this.queueSelection.isBrowsing) {
						this.queueSelection.replaceDraft(editorUntouched ? text : this.editor.getText());
					}
					throw error;
				}
			} else {
				status = "rejected";
			}
			if (discardStaleSelection()) return true;
			const editorUntouched =
				submissionGeneration === this.inputSubmissionGeneration && this.editor.getText() === editorTextBefore;
			if (status === "applied") {
				if (trimmed) this.editor.addToHistory?.(trimmed);
				const draft = this.queueSelection.reset();
				if (editorUntouched) this.setEditorTextFromQueueSelection(draft);
			} else {
				// Enter submissions clear the editor before onSubmit runs; restore the
				// edit so a failed mutation never swallows it.
				if (editorUntouched) this.setEditorTextFromQueueSelection(text);
				if (!this.queueSelection.isBrowsing) {
					this.queueSelection.replaceDraft(editorUntouched ? text : this.editor.getText());
				}
				if (status === "invalid")
					this.showStatus("Edited command is not a valid session command; edit kept in the editor");
				else if (status === "unsupported") this.showStatus("Queue editing requires a newer daemon");
				else this.showStatus("Queue changed; edit kept in the editor");
			}
			this.updatePendingMessagesDisplay();
			this.ui.requestRender();
			return true;
		}).finally(() => {
			if (this.pendingQueueEdit === pendingQueueEdit) {
				this.pendingQueueEdit = undefined;
				// Queue events were not reconciled while the edit was pending; drop a now-stale selection.
				this.refreshQueueSelectionFromState();
			}
		});
	}

	/**
	 * Images for a queue replace: undefined preserves the server's images (some
	 * markers cannot be resolved by this client), [] clears, a list replaces.
	 */
	private collectQueueReplaceImages(text: string): ImageContent[] | undefined {
		const markers = [...new Set(imageMarkerIds(text))];
		if (markers.length === 0) return [];
		const resolved = markers.map((markerId) => this.pastedImages.get(markerId));
		return resolved.every((image) => image !== undefined)
			? resolved.map((image) => ({ ...(image as ImageContent) }))
			: undefined;
	}

	private setEditorTextFromQueueSelection(text: string): void {
		this.isApplyingQueueSelectionText = true;
		try {
			this.editor.setText(text);
		} finally {
			this.isApplyingQueueSelectionText = false;
		}
	}

	private getQueueSelectionHeader(): string | undefined {
		const selected = this.queueSelection.selected;
		if (!selected) return undefined;
		const lane = selected.lane === "steering" ? "steering" : "follow-up";
		const older = this.getAppKeyDisplay("app.message.navigateOlder");
		const newer = this.getAppKeyDisplay("app.message.navigateNewer");
		const earlier = this.getAppKeyDisplay("app.message.moveEarlier");
		const later = this.getAppKeyDisplay("app.message.moveLater");
		const queue = this.getAppKeyDisplay("app.message.followUp");
		return theme.fg(
			"dim",
			`${lane} ${selected.index + 1} · ${older}/${newer} browse · ${earlier}/${later} reorder · enter steers · ${queue} queues · empty deletes`,
		);
	}

	private updateEditorBorderColor(): void {
		const editorTheme = getEditorTheme();
		this.editor.borderColor = editorTheme.borderColor;
		this.editor.backgroundColor = editorTheme.backgroundColor;
		this.ui.requestRender();
	}

	private getPromptContextContainers(): Container[] {
		return [this.recapContainer, this.featureHintContainer, this.queuedMessagesContainer, this.sideQuestionContainer];
	}

	private getPromptDockComponents(): Component[] {
		return [this.editorContainer, this.subagentSummaryLine, this.footerSlot];
	}

	/** Enter or leave fullscreen rendering without touching the persisted setting. */
	private applyFullscreen(enabled: boolean): void {
		if (enabled) {
			if (!process.stdout.isTTY) return;
			this.ui.enterFullscreen({
				scroll: [
					this.headerContainer,
					this.mainViewContainer,
					this.widgetContainerAbove,
					...this.getPromptContextContainers(),
					this.widgetContainerBelow,
				],
				dock: this.promptDock,
				mouse: this.settingsManager.getFullscreenMouse(),
			});
		} else {
			this.ui.exitFullscreen();
		}
	}

	private setFullscreenMode(enabled: boolean): void {
		this.settingsManager.setFullscreen(enabled);
		if (enabled && !process.stdout.isTTY) {
			this.fullscreenEnabled = false;
			this.showStatus("Fullscreen rendering requires an interactive terminal");
			return;
		}
		this.fullscreenEnabled = enabled;
		this.applyFullscreen(enabled);
		const followKey = this.getEditorKeyDisplay("tui.viewport.follow");
		this.showStatus(
			enabled
				? `Fullscreen rendering on — wheel/pageUp scroll, ${followKey} follows output`
				: "Fullscreen rendering off",
		);
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private toggleAgentMessageExpansion(): void {
		this.agentMessagesExpanded = !this.agentMessagesExpanded;
		this.applyChatExpansion();
	}

	private toggleEditDiffExpansion(): void {
		this.editDiffsExpanded = !this.editDiffsExpanded;
		this.applyChatExpansion();
	}

	private setToolsExpanded(expanded: boolean): void {
		this.toolOutputExpanded = expanded;
		this.applyChatExpansion();
	}

	/** Expansion state for a chat component: agent messages toggle separately from tools. */
	private expansionStateFor(component: unknown): boolean {
		return component instanceof AgentMessageComponent ? this.agentMessagesExpanded : this.toolOutputExpanded;
	}

	private applyChatExpansion(): void {
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) {
			activeHeader.setExpanded(this.toolOutputExpanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(this.expansionStateFor(child));
			}
			if (hasAgentMessagesExpansion(child)) {
				child.setAgentMessagesExpanded(this.agentMessagesExpanded);
			}
			if (hasEditDiffsExpansion(child)) {
				child.setEditDiffsExpanded(this.editDiffsExpanded);
			}
		}
		// Expanding/collapsing changes blocks above the viewport, which would
		// otherwise force a full redraw that scrolls to the top and replays the
		// whole transcript. Keep the user anchored at their current position.
		// Fullscreen frames have no scrollback to preserve.
		if (this.ui.isFullscreen()) {
			this.ui.requestRender();
		} else {
			this.ui.requestRenderPreservingViewport();
		}
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(this.hideThinkingBlock);

		void (async () => {
			// Rebuild chat from session messages
			await this.rebuildChatFromMessages();

			// If streaming, re-add the streaming component with updated visibility and re-render
			if (this.streamingComponent && this.streamingMessage) {
				this.streamingComponent.setHideThinkingBlock(this.hideThinkingBlock);
				this.streamingComponent.updateContent(this.streamingMessage);
				this.chatContainer.addChild(this.streamingComponent);
			}

			this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
		})().catch((error) => {
			this.showError(error instanceof Error ? error.message : String(error));
		});
	}

	private openExternalEditor(): void {
		// Determine editor (respect $VISUAL, then $EDITOR)
		const editorCmd = process.env.VISUAL || process.env.EDITOR;
		if (!editorCmd) {
			this.showWarning("No editor configured. Set $VISUAL or $EDITOR environment variable.");
			return;
		}

		const currentText = this.editor.getExpandedText?.() ?? this.editor.getText();
		const tmpFile = path.join(os.tmpdir(), `pi-editor-${Date.now()}.pi.md`);

		try {
			// Write current content to temp file
			fs.writeFileSync(tmpFile, currentText, "utf-8");

			// Stop TUI to release terminal
			this.ui.stop();

			// Split by space to support editor arguments (e.g., "code --wait")
			const [editor, ...editorArgs] = editorCmd.split(" ");

			// Spawn editor synchronously with inherited stdio for interactive editing
			const result = spawnSync(editor, [...editorArgs, tmpFile], {
				stdio: "inherit",
				shell: process.platform === "win32",
			});

			// On successful exit (status 0), replace editor content
			if (result.status === 0) {
				const newContent = fs.readFileSync(tmpFile, "utf-8").replace(/\n$/, "");
				this.editor.setText(newContent);
			}
			// On non-zero exit, keep original text (no action needed)
		} finally {
			// Clean up temp file
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}

			// Restart TUI
			this.ui.start();
			// ui.stop() left fullscreen so the editor got a clean terminal
			if (this.fullscreenEnabled) {
				this.applyFullscreen(true);
			}
			// Force full re-render since external editor uses alternate screen
			this.ui.requestRender(true);
		}
	}

	private clearInputBar(): void {
		this.clearEscapeRepeat();
		this.clearCtrlCExitHint({ render: false });
		// Leaving browse mode restores the stashed draft instead of arming an
		// accidental empty-submit delete of the selected queued message.
		this.editor.setText(this.queueSelection.hasDraft ? this.queueSelection.reset() : "");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("error", `Error: ${errorMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("warning", `⚠ ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	showNewVersionNotification(newVersion: string): void {
		this.chatContainer.addChild(new Text(formatUpdateAvailableNotice(newVersion), 1, 0));
		this.ui.requestRender();
	}

	showPackageUpdateNotification(packages: string[]): void {
		this.chatContainer.addChild(new Text(formatPackageUpdateNotice(packages), 1, 0));
		this.ui.requestRender();
	}

	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return this.getConnectionQueue();
	}

	private updatePendingMessagesDisplay(): void {
		// pendingMessagesContainer holds only in-flight bash output for the current
		// turn, so it stays above the execution indicator. clear() detaches the
		// components but they stay tracked in pendingBashComponents until flushed.
		this.pendingMessagesContainer.clear();
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.addChild(component);
		}
		// Queued steering/follow-up previews are future turns, so they render in
		// their own container below the execution indicator and recap.
		this.queuedMessagesContainer.clear();
		const { steering: steeringMessages, followUp: followUpMessages } = this.getAllQueuedMessages();
		const hasQueuedMessages = steeringMessages.length > 0 || followUpMessages.length > 0;
		if (hasQueuedMessages) {
			this.queuedMessagesContainer.addChild(new Spacer(1));
			for (const message of steeringMessages) {
				const text = styleQueuedMessagePreview(message, "Steering", (name) => this.isRecognizedSlashCommand(name));
				this.queuedMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			for (const message of followUpMessages) {
				const text = styleQueuedMessagePreview(message, "Follow-up", (name) => this.isRecognizedSlashCommand(name));
				this.queuedMessagesContainer.addChild(new TruncatedText(text, 1, 0));
			}
			const dequeueHint = this.getAppKeyDisplay("app.message.navigateOlder");
			const hintText = theme.fg("dim", `╰─ ${dequeueHint} to browse and edit queued messages`);
			this.queuedMessagesContainer.addChild(new TruncatedText(hintText, 1, 0));
		}
		if (hasQueuedMessages && !this.featureHintSuppressedByQueue) {
			this.featureHintSuppressedByQueue = true;
			this.clearFeatureHintPresentation();
		} else if (!hasQueuedMessages && this.featureHintSuppressedByQueue) {
			this.featureHintSuppressedByQueue = false;
			this.resumeFeatureHintPresentation();
		}
	}

	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(create: (done: () => void) => { component: Component; focus: Component }): void {
		const done = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const { component, focus } = create(done);
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.ui.setFocus(focus);
		this.ui.requestRender();
	}

	private showFullPaneOverlay(component: Component, options: number | FullPaneOverlayOptions = 80): OverlayHandle {
		return showFullPaneOverlay(this.ui, component, options);
	}

	private async showSettingsSelector(): Promise<void> {
		let state: AgentConnectionState;
		try {
			state = await this.agentConnection.getState();
			this.applyConnectionStateSnapshot(state);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				{
					autoCompact: state.autoCompactionEnabled,
					idleEvictionMinutes: this.settingsManager.getIdleEvictionMinutes(),
					showImages: this.settingsManager.getShowImages(),
					autoResizeImages: this.settingsManager.getImageAutoResize(),
					blockImages: this.settingsManager.getBlockImages(),
					enableSkillCommands: this.settingsManager.getEnableSkillCommands(),
					enableBuiltinSkills: this.settingsManager.getEnableBuiltinSkills(),
					steeringMode: state.steeringMode,
					followUpMode: state.followUpMode,
					transport: this.settingsManager.getTransport(),
					thinkingLevel: state.thinkingLevel,
					availableThinkingLevels: state.availableThinkingLevels,
					currentTheme: this.settingsManager.getTheme() || "prime",
					availableThemes: getAvailableThemes(),
					hideThinkingBlock: this.hideThinkingBlock,
					mermaidRenderingMode: this.settingsManager.getMermaidRenderingMode(),
					treeFilterMode: this.settingsManager.getTreeFilterMode(),
					showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
					editorPaddingX: this.settingsManager.getEditorPaddingX(),
					autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
					quietStartup: this.settingsManager.getQuietStartup(),
					clearOnShrink: this.settingsManager.getClearOnShrink(),
					showTerminalProgress: this.settingsManager.getShowTerminalProgress(),
					fullscreen: this.fullscreenEnabled,
					warnings: this.settingsManager.getWarnings(),
				},
				{
					onAutoCompactChange: (enabled) => {
						this.patchConnectionState({ autoCompactionEnabled: enabled });
						void this.agentConnection.setAutoCompactionEnabled(enabled).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
						this.footer.setAutoCompactEnabled(enabled);
					},
					onIdleEvictionMinutesChange: (value) => {
						this.settingsManager.setIdleEvictionMinutes(value);
					},
					onShowImagesChange: (enabled) => {
						this.settingsManager.setShowImages(enabled);
						for (const child of this.chatContainer.children) {
							if (child instanceof ToolExecutionComponent) {
								child.setShowImages(enabled);
							}
						}
					},
					onAutoResizeImagesChange: (enabled) => {
						this.settingsManager.setImageAutoResize(enabled);
					},
					onBlockImagesChange: (blocked) => {
						this.settingsManager.setBlockImages(blocked);
					},
					onEnableSkillCommandsChange: (enabled) => {
						this.settingsManager.setEnableSkillCommands(enabled);
						this.setupAutocompleteProvider();
					},
					onEnableBuiltinSkillsChange: (enabled) => {
						this.settingsManager.setEnableBuiltinSkills(enabled);
						void this.handleReloadCommand();
					},
					onSteeringModeChange: (mode) => {
						this.patchConnectionState({ steeringMode: mode });
						void this.agentConnection.setSteeringMode(mode).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onFollowUpModeChange: (mode) => {
						this.patchConnectionState({ followUpMode: mode });
						void this.agentConnection.setFollowUpMode(mode).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onTransportChange: (transport) => {
						void this.agentConnection.setTransport(transport).catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onThinkingLevelChange: (level) => {
						void this.agentConnection
							.setThinkingLevel(level)
							.then(() => {
								this.patchConnectionState({ thinkingLevel: level });
								this.footer.invalidate();
								this.updateEditorBorderColor();
							})
							.catch((error) => {
								this.showError(error instanceof Error ? error.message : String(error));
							});
					},
					onThemeChange: (themeName) => {
						const result = setTheme(themeName, true);
						this.settingsManager.setTheme(themeName);
						this.ui.invalidate();
						if (!result.success) {
							this.showError(`Failed to load theme "${themeName}": ${result.error}\nFell back to dark theme.`);
						}
					},
					onThemePreview: (themeName) => {
						const result = setTheme(themeName, true);
						if (result.success) {
							this.ui.invalidate();
							this.ui.requestRender();
						}
					},
					onHideThinkingBlockChange: (hidden) => {
						this.hideThinkingBlock = hidden;
						this.settingsManager.setHideThinkingBlock(hidden);
						for (const child of this.chatContainer.children) {
							if (child instanceof AssistantMessageComponent) {
								child.setHideThinkingBlock(hidden);
							}
						}
						void this.rebuildChatFromMessages().catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
					},
					onMermaidRenderingModeChange: (mode) => {
						this.settingsManager.setMermaidRenderingMode(mode);
						this.chatContainer.invalidate();
						this.ui.requestRender();
					},
					onQuietStartupChange: (enabled) => {
						this.settingsManager.setQuietStartup(enabled);
					},
					onTreeFilterModeChange: (mode) => {
						this.settingsManager.setTreeFilterMode(mode);
					},
					onShowHardwareCursorChange: (enabled) => {
						this.settingsManager.setShowHardwareCursor(enabled);
						this.ui.setShowHardwareCursor(enabled);
					},
					onEditorPaddingXChange: (padding) => {
						this.settingsManager.setEditorPaddingX(padding);
						this.defaultEditor.setPaddingX(padding);
						if (this.editor !== this.defaultEditor && this.editor.setPaddingX !== undefined) {
							this.editor.setPaddingX(padding);
						}
					},
					onAutocompleteMaxVisibleChange: (maxVisible) => {
						this.settingsManager.setAutocompleteMaxVisible(maxVisible);
						this.defaultEditor.setAutocompleteMaxVisible(maxVisible);
						if (this.editor !== this.defaultEditor && this.editor.setAutocompleteMaxVisible !== undefined) {
							this.editor.setAutocompleteMaxVisible(maxVisible);
						}
					},
					onClearOnShrinkChange: (enabled) => {
						this.settingsManager.setClearOnShrink(enabled);
						this.ui.setClearOnShrink(enabled);
					},
					onShowTerminalProgressChange: (enabled) => {
						this.settingsManager.setShowTerminalProgress(enabled);
					},
					onFullscreenChange: (enabled) => {
						this.setFullscreenMode(enabled);
					},
					onWarningsChange: (warnings) => {
						this.settingsManager.setWarnings(warnings);
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private async handleModelCommand(searchTerm?: string): Promise<void> {
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		const model = await this.findExactModelMatch(searchTerm);
		if (model) {
			try {
				const authFlows = this.createAuthFlows();
				const providerOptions = authFlows.getLoginProviderOptions();
				if (!(await this.ensureModelProviderConfigured(model, authFlows, providerOptions))) return;
				await this.completeModelSelection(model);
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		this.showModelSelector(searchTerm);
	}

	private async findExactModelMatch(searchTerm: string): Promise<Model<Api> | undefined> {
		const cachedMatch = findExactModelReferenceMatch(searchTerm, this.getCachedModelCandidates());
		if (cachedMatch) {
			return cachedMatch;
		}

		const refreshPromise = this.getModelSelectorRefreshPromise({ force: true });
		if (!refreshPromise) {
			return undefined;
		}

		try {
			return findExactModelReferenceMatch(searchTerm, await refreshPromise);
		} catch {
			return undefined;
		}
	}

	private async applySelectedModel(model: AgentConnectionModel): Promise<void> {
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		await connection.setModel(model.provider, model.id);
		const state = await connection.getState();
		if (
			this.agentConnection !== connection ||
			this.connectionState?.sessionId !== sessionId ||
			(sessionId !== undefined && state.sessionId !== sessionId)
		) {
			return;
		}
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
		this.patchConnectionState({
			model: state.model ?? model,
			serviceTier: state.serviceTier,
			availableThinkingLevels: state.availableThinkingLevels,
		});
		this.footer.invalidate();
		this.subagentSummaryLine.invalidate();
		this.updateEditorBorderColor();
		// Rebuild so the /effort argument hint reflects the new model's levels.
		this.setupAutocompleteProvider();
	}

	private async completeModelSelection(model: AgentConnectionModel): Promise<void> {
		this.showStatus(`Switching model: ${model.id}`);
		await this.applySelectedModel(model);
		this.showStatus(`Model: ${model.id}`);
		void this.maybeWarnAboutAnthropicSubscriptionAuth(model);
		this.checkDaxnutsEasterEgg(model);
	}

	private async ensureModelProviderConfigured(
		model: AgentConnectionModel,
		authFlows: ProviderAuthFlows,
		providerOptions: ReadonlyArray<AuthSelectorProvider>,
	): Promise<boolean> {
		if (this.isModelProviderConfigured(model)) return true;

		const provider = providerOptions.find(
			(option) => option.id === model.provider && (option.category ?? "provider") === "provider",
		);
		if (!provider) {
			this.showError(`Authentication for ${model.provider} must be configured externally.`);
			return false;
		}

		const result = await authFlows.loginProvider(provider);
		if (result.status !== "success") return false;

		this.invalidateConnectionModels();
		await this.getConnectionAvailableModels();
		if (this.isModelProviderConfigured(model)) return true;

		this.showError(`Authentication completed, but ${model.provider} is still unavailable.`);
		return false;
	}

	private isModelProviderConfigured(model: AgentConnectionModel): boolean {
		return this.connectionConfiguredProviders.has(model.provider) || this.modelRegistry.hasConfiguredAuth(model);
	}

	private applyConnectionModelCatalog(catalog: AgentConnectionModelCatalog): void {
		this.connectionModelCatalog = [...catalog.models];
		this.connectionConfiguredProviders = new Set(catalog.configuredProviders);
	}

	private getAvailableConnectionModels(): AgentConnectionModel[] {
		return this.connectionModelCatalog.filter((model) => this.connectionConfiguredProviders.has(model.provider));
	}

	private async getConnectionAvailableModels(): Promise<AgentConnectionModel[]> {
		const inFlight = this.connectionModelsRefreshInFlight;
		if (inFlight && inFlight.version === this.connectionModelsRefreshVersion) {
			return [...(await inFlight.promise)];
		}

		const version = this.connectionModelsRefreshVersion;
		const promise = this.agentConnection.getModelCatalog().then((catalog) => {
			if (version !== this.connectionModelsRefreshVersion) {
				return this.getAvailableConnectionModels();
			}
			this.applyConnectionModelCatalog(catalog);
			this.connectionModelsFetchedAt = Date.now();
			return this.getAvailableConnectionModels();
		});
		this.connectionModelsRefreshInFlight = { version, promise };

		try {
			return [...(await promise)];
		} finally {
			if (this.connectionModelsRefreshInFlight?.promise === promise) {
				this.connectionModelsRefreshInFlight = undefined;
			}
		}
	}

	private async getConnectionModelCatalog(): Promise<AgentConnectionModel[]> {
		await this.getConnectionAvailableModels();
		return [...this.connectionModelCatalog];
	}

	private getCachedModelCandidates(): AgentConnectionModel[] {
		const modelsById = new Map<string, AgentConnectionModel>();
		for (const scoped of this.getScopedModelState()) {
			modelsById.set(`${scoped.model.provider}/${scoped.model.id}`, scoped.model);
		}
		for (const model of this.connectionModelCatalog) {
			modelsById.set(`${model.provider}/${model.id}`, model);
		}
		return [...modelsById.values()];
	}

	private getModelSelectorRefreshPromise(
		options: { force?: boolean } = {},
	): Promise<AgentConnectionModel[]> | undefined {
		const refreshCatalog = () => this.getConnectionAvailableModels().then(() => this.getCachedModelCandidates());
		if (this.connectionModelsRefreshInFlight) {
			return refreshCatalog();
		}
		if (options.force || this.connectionModelsFetchedAt === 0) {
			return refreshCatalog();
		}
		if (Date.now() - this.connectionModelsFetchedAt > MODEL_CATALOG_REFRESH_TTL_MS) {
			return refreshCatalog();
		}
		return undefined;
	}

	private invalidateConnectionModelRefresh(): void {
		this.connectionModelsRefreshVersion++;
		this.connectionModelsRefreshInFlight = undefined;
	}

	private invalidateConnectionModels(): void {
		this.connectionConfiguredProviders = new Set();
		this.connectionModelsFetchedAt = 0;
		this.invalidateConnectionModelRefresh();
	}

	private async refreshConnectionModelsAfterAuthChange(): Promise<void> {
		this.invalidateConnectionModels();
		await this.getConnectionAvailableModels();
	}

	private async getModelCandidates(): Promise<AgentConnectionModel[]> {
		const scopedModels = this.getScopedModelState();
		if (scopedModels.length > 0) {
			return scopedModels.map((scoped) => scoped.model);
		}

		try {
			return await this.getConnectionAvailableModels();
		} catch {
			return [];
		}
	}

	private getScopedModelsFromModelIds(
		enabledIds: readonly string[],
		allModels: readonly AgentConnectionModel[],
	): AgentConnectionState["scopedModels"] {
		const modelsById = new Map(allModels.map((model) => [`${model.provider}/${model.id}`, model]));
		const selectedIds = new Set<string>();
		const scopedModels: AgentConnectionState["scopedModels"] = [];

		for (const id of enabledIds) {
			if (selectedIds.has(id)) {
				continue;
			}

			const model = modelsById.get(id);
			if (!model) {
				continue;
			}

			selectedIds.add(id);
			scopedModels.push({ model });
		}

		return scopedModels;
	}

	private async updateAvailableProviderCount(): Promise<void> {
		const models = await this.getModelCandidates();
		const uniqueProviders = new Set(models.map((m) => m.provider));
		this.footerDataProvider.setAvailableProviderCount(uniqueProviders.size);
	}

	private async maybeWarnAboutAnthropicSubscriptionAuth(
		model: Model<any> | undefined = this.getCurrentModel(),
	): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) {
			return;
		}
		if (this.anthropicSubscriptionWarningShown) {
			return;
		}
		const warning = await getAnthropicSubscriptionAuthWarning(this.modelRegistry, model);
		if (!warning) {
			return;
		}
		this.anthropicSubscriptionWarningShown = true;
		this.showWarning(warning);
	}

	private getAvailableThinkingLevels(): ThinkingLevel[] {
		const levels = this.connectionState?.availableThinkingLevels ?? [];
		const supportsThinking = levels.length > 0 && !(levels.length === 1 && levels[0] === "off");
		return supportsThinking ? levels : [];
	}

	private getThinkingLevelCompletions(prefix: string): AutocompleteItem[] | null {
		const levels = this.getAvailableThinkingLevels();
		if (levels.length === 0) return null;
		const current = this.connectionState?.thinkingLevel;
		const term = prefix.trim().toLowerCase();
		const matches = term ? levels.filter((level) => level.startsWith(term)) : levels;
		if (matches.length === 0) return null;
		return matches.map((level) => ({
			value: level,
			label: level,
			description:
				level === current ? `${THINKING_LEVEL_DESCRIPTIONS[level]} (current)` : THINKING_LEVEL_DESCRIPTIONS[level],
		}));
	}

	private getHeartbeatArgumentCompletions(prefix: string): AutocompleteItem[] | null {
		const term = prefix.trim().toLowerCase();
		const filtered = term
			? HEARTBEAT_ARGUMENT_COMPLETIONS.filter(
					(item) => item.value.toLowerCase().startsWith(term) || item.label.toLowerCase().startsWith(term),
				)
			: HEARTBEAT_ARGUMENT_COMPLETIONS;
		return filtered.length === 0 ? null : filtered;
	}

	private currentModelSupportsFastMode(): boolean {
		const model = this.getCurrentModel();
		return model !== undefined && supportsFastMode(model);
	}

	private handleFastCommand(): void {
		const unavailableMessage =
			"Fast mode requires GPT-5.4, GPT-5.5, or GPT-5.6 with ChatGPT or OpenAI API key authentication";
		if (!this.currentModelSupportsFastMode()) {
			this.showStatus(unavailableMessage);
			return;
		}
		const connection = this.agentConnection;
		const sessionId = this.connectionState?.sessionId;
		this.fastModeToggleQueue = this.fastModeToggleQueue
			.then(async () => {
				if (this.agentConnection !== connection || this.connectionState?.sessionId !== sessionId) {
					return;
				}
				if (!this.currentModelSupportsFastMode()) {
					this.showStatus(unavailableMessage);
					return;
				}
				const enabled = this.connectionState?.serviceTier === "priority";
				const serviceTier: ServiceTier = enabled ? "default" : "priority";
				await connection.setServiceTier(serviceTier);
				if (this.agentConnection !== connection || this.connectionState?.sessionId !== sessionId) {
					return;
				}
				const state = await connection.getState();
				if (
					this.agentConnection !== connection ||
					this.connectionState?.sessionId !== sessionId ||
					state.sessionId !== sessionId
				) {
					return;
				}
				this.patchConnectionState({ serviceTier: state.serviceTier });
				this.footer.invalidate();
				this.subagentSummaryLine.invalidate();
				this.showStatus(`Fast mode: ${state.serviceTier === "priority" ? "on" : "off"}`);
			})
			.catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	private handleEffortCommand(arg: string): void {
		const levels = this.getAvailableThinkingLevels();
		if (levels.length === 0) {
			this.showStatus("Current model does not support thinking");
			return;
		}
		const requested = arg.trim().toLowerCase();
		if (!requested) {
			this.showThinkingSelector(levels);
			return;
		}
		if (!levels.includes(requested as ThinkingLevel)) {
			this.showError(`Unknown thinking level '${requested}'. Available: ${levels.join(", ")}`);
			return;
		}
		this.applyThinkingLevel(requested as ThinkingLevel);
	}

	private showThinkingSelector(levels: ThinkingLevel[] = this.getAvailableThinkingLevels()): void {
		const currentLevel = this.connectionState?.thinkingLevel ?? levels[0];
		if (!currentLevel) {
			this.showStatus("Current model does not support thinking");
			return;
		}
		this.showSelector((done) => {
			const selector = new ThinkingSelectorComponent(
				currentLevel,
				levels,
				(level) => {
					done();
					this.applyThinkingLevel(level);
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector.getSelectList() };
		});
	}

	private applyThinkingLevel(level: ThinkingLevel): void {
		void this.agentConnection
			.setThinkingLevel(level)
			.then(() => {
				this.patchConnectionState({ thinkingLevel: level });
				this.footer.invalidate();
				this.updateEditorBorderColor();
				this.showStatus(`Thinking level: ${level}`);
			})
			.catch((error) => {
				this.showError(error instanceof Error ? error.message : String(error));
			});
	}

	private showModelSelector(initialSearchInput?: string): void {
		void this.showConfigurationMenu("models", initialSearchInput);
	}

	private showConfigurationMenu(initialTab: ConfigurationMenuTab, initialModelSearch?: string): Promise<void> {
		const modelCatalog = this.getCachedModelCandidates();
		const authFlows = this.createAuthFlows();
		const providerOptions = authFlows.getLoginProviderOptions();

		return new Promise((resolve) => {
			let handle: OverlayHandle | undefined;
			let settled = false;
			let hidden = false;
			let removed = false;
			let menu: ConfigurationMenuComponent;
			const hide = () => {
				if (removed) return;
				removed = true;
				hidden = true;
				handle?.hide();
				this.ui.requestRender();
			};
			const conceal = () => {
				if (hidden || removed) return;
				hidden = true;
				handle?.setHidden(true);
				this.ui.requestRender();
			};
			const show = () => {
				if (!hidden || removed || settled) return;
				hidden = false;
				handle?.setHidden(false);
				handle?.focus();
				this.ui.requestRender();
			};
			const finish = () => {
				if (settled) return;
				settled = true;
				hide();
				resolve();
			};
			const refreshModels = (force: boolean) => {
				const refreshPromise = this.getModelSelectorRefreshPromise({ force });
				if (!refreshPromise) return;
				void refreshPromise
					.then((models) => {
						if (!settled) menu.updateModels(this.getCurrentModel(), models, this.connectionConfiguredProviders);
					})
					.catch((error) => {
						if (!settled) this.showError(error instanceof Error ? error.message : String(error));
					});
			};
			const authenticate = (provider: AuthSelectorProvider, tab: "providers" | "mcp-connections") => {
				if (settled) return;
				void authFlows
					.loginProvider(provider)
					.then(async (authResult) => {
						if (settled) return;
						handle?.focus();
						menu.refreshAuthentication();
						if (authResult.status !== "success") return;

						if (tab === "mcp-connections") {
							if (!authResult.providerId.startsWith("mcp:")) return;
							if (this.isAgentStreaming() || this.isAgentCompacting()) {
								this.showStatus("Connected. Run /reload (after the current turn) to activate the integration.");
								return;
							}
							finish();
							await this.handleReloadCommand();
							return;
						}

						await this.prepareForModelSelectionAfterLogin(authResult);
						menu.updateModels(
							this.getCurrentModel(),
							this.getCachedModelCandidates(),
							this.connectionConfiguredProviders,
						);
						menu.setActiveTab("models");
						refreshModels(true);
					})
					.catch((error) => {
						handle?.focus();
						this.showError(error instanceof Error ? error.message : String(error));
					});
			};

			menu = new ConfigurationMenuComponent({
				initialTab,
				tui: this.ui,
				authStorage: this.modelRegistry.authStorage,
				providerOptions,
				modelRegistry: this.modelRegistry,
				currentModel: this.getCurrentModel(),
				scopedModels: this.getScopedModelState(),
				availableModels: modelCatalog,
				configuredProviders: this.connectionConfiguredProviders,
				recentModels: this.settingsManager.getRecentModels(),
				initialModelSearch,
				getRows: () => this.ui.terminal.rows,
				requestRender: () => this.ui.requestRender(),
				onSelectProvider: (provider) => authenticate(provider, "providers"),
				onSelectMcpConnection: (provider) => authenticate(provider, "mcp-connections"),
				onSelectModel: (model) => {
					void (async () => {
						let completed = false;
						try {
							const ready = await this.ensureModelProviderConfigured(model, authFlows, providerOptions);
							handle?.focus();
							menu.refreshAuthentication();
							menu.updateModels(
								this.getCurrentModel(),
								this.getCachedModelCandidates(),
								this.connectionConfiguredProviders,
							);
							if (!ready || settled) return;
							conceal();
							await this.completeModelSelection(model);
							completed = true;
						} catch (error) {
							show();
							this.showError(error instanceof Error ? error.message : String(error));
						} finally {
							if (completed) finish();
						}
					})();
				},
				onCancel: finish,
			});
			handle = this.showFullPaneOverlay(menu, 96);
			refreshModels(initialModelSearch !== undefined);
		});
	}

	private async showModelsSelector(): Promise<void> {
		let allModels: AgentConnectionModel[];
		try {
			allModels = await this.getConnectionModelCatalog();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		if (allModels.length === 0) {
			this.showStatus("No models available");
			return;
		}

		// Check if session has scoped models (from previous session-only changes or CLI --models)
		const sessionScopedModels = this.getScopedModelState();
		const hasSessionScope = sessionScopedModels.length > 0;

		// Build enabled model IDs from session state or settings
		let currentEnabledIds: string[] | null = null;

		if (hasSessionScope) {
			// Use current session's scoped models
			currentEnabledIds = sessionScopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		} else {
			// Fall back to settings
			const patterns = this.settingsManager.getEnabledModels();
			if (patterns !== undefined && patterns.length > 0) {
				const scopedModels = resolveModelScopeFromModels(patterns, allModels);
				currentEnabledIds = scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
			}
		}

		// Helper to update session's scoped models (session-only, no persist)
		const updateSessionModels = async (enabledIds: string[] | null) => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			if (enabledIds && enabledIds.length > 0 && enabledIds.length < allModels.length) {
				const scopedModels = this.getScopedModelsFromModelIds(enabledIds, allModels);
				await this.agentConnection.setScopedModels(scopedModels);
				this.patchConnectionState({ scopedModels });
			} else {
				// All enabled or none enabled = no filter
				await this.agentConnection.setScopedModels([]);
				this.patchConnectionState({ scopedModels: [] });
			}
			await this.updateAvailableProviderCount();
			this.ui.requestRender();
		};

		this.showSelector((done) => {
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels,
					enabledModelIds: currentEnabledIds,
				},
				{
					onChange: async (enabledIds) => {
						await updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						// Persist to settings
						const newPatterns =
							enabledIds === null || enabledIds.length === allModels.length
								? undefined // All enabled = clear filter
								: enabledIds;
						this.settingsManager.setEnabledModels(newPatterns ? [...newPatterns] : undefined);
						this.showStatus("Model selection saved to settings");
					},
					onCancel: () => {
						done();
						this.ui.requestRender();
					},
				},
			);
			return { component: selector, focus: selector };
		});
	}

	private async showUserMessageSelector(): Promise<void> {
		let userMessages: Array<{ entryId: string; text: string }>;
		try {
			userMessages = await this.agentConnection.getUserMessagesForForking();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		if (userMessages.length === 0) {
			this.showStatus("No messages to fork from");
			return;
		}

		const initialSelectedId = userMessages[userMessages.length - 1]?.entryId;

		this.showSelector((done) => {
			const selector = new UserMessageSelectorComponent(
				userMessages.map((m) => ({ id: m.entryId, text: m.text })),
				async (entryId) => {
					try {
						const result = await this.agentConnection.fork(entryId);
						if (result.cancelled) {
							done();
							this.ui.requestRender();
							return;
						}

						await this.renderCurrentSessionState();
						this.editor.setText(result.selectedText ?? "");
						done();
						this.showStatus("Forked to new session");
					} catch (error: unknown) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSelectedId,
			);
			return { component: selector, focus: selector.getMessageList() };
		});
	}

	private async handleCloneCommand(): Promise<void> {
		try {
			const { leafId } = await this.agentConnection.getSessionTree();
			if (!leafId) {
				this.showStatus("Nothing to clone yet");
				return;
			}

			const result = await this.agentConnection.fork(leafId, { position: "at" });
			if (result.cancelled) {
				this.ui.requestRender();
				return;
			}

			await this.renderCurrentSessionState();
			this.editor.setText("");
			this.showStatus("Cloned to new session");
		} catch (error: unknown) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showTreeSelector(initialSelectedId?: string): Promise<void> {
		let tree: AgentConnectionSessionTreeNode[];
		let realLeafId: string | null;
		try {
			const sessionTree = await this.agentConnection.getSessionTree();
			tree = sessionTree.tree;
			realLeafId = sessionTree.leafId;
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		const initialFilterMode = this.settingsManager.getTreeFilterMode();

		if (tree.length === 0) {
			this.showStatus("No entries in session");
			return;
		}

		this.showSelector((done) => {
			const selector = new TreeSelectorComponent(
				tree,
				realLeafId,
				this.ui.terminal.rows,
				async (entryId) => {
					// Selecting the current leaf is a no-op (already there)
					if (entryId === realLeafId) {
						done();
						this.showStatus("Already at this point");
						return;
					}

					// Ask about summarization
					done(); // Close selector first

					// Loop until user makes a complete choice or cancels to tree
					let wantsSummary = false;
					let customInstructions: string | undefined;

					// Check if we should skip the prompt (user preference to always default to no summary)
					if (!this.settingsManager.getBranchSummarySkipPrompt()) {
						while (true) {
							const summaryChoice = await this.showExtensionSelector("Summarize branch?", [
								"No summary",
								"Summarize",
								"Summarize with custom prompt",
							]);

							if (summaryChoice === undefined) {
								// User pressed escape - re-show tree selector with same selection
								void this.showTreeSelector(entryId);
								return;
							}

							wantsSummary = summaryChoice !== "No summary";

							if (summaryChoice === "Summarize with custom prompt") {
								customInstructions = await this.showExtensionEditor("Custom summarization instructions");
								if (customInstructions === undefined) {
									// User cancelled - loop back to summary selector
									continue;
								}
							}

							// User made a complete choice
							break;
						}
					}

					// Set up escape handler and loader if summarizing
					let summaryLoader: Loader | undefined;
					if (wantsSummary) {
						this.chatContainer.addChild(new Spacer(1));
						summaryLoader = new Loader(
							this.ui,
							(spinner) => theme.fg("muted", spinner),
							(text) => theme.fg("muted", text),
							`Summarizing branch... (${keyText("app.clear")} to cancel)`,
						);
						this.statusContainer.addChild(summaryLoader);
						this.ui.requestRender();
					}

					try {
						const result = await this.agentConnection.navigateTree(entryId, {
							summarize: wantsSummary,
							customInstructions,
						});

						if (result.aborted) {
							// Summarization aborted - re-show tree selector with same selection
							this.showStatus("Branch summarization cancelled");
							void this.showTreeSelector(entryId);
							return;
						}
						if (result.cancelled) {
							this.showStatus("Navigation cancelled");
							return;
						}

						await this.renderTreeNavigation(result);
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						if (summaryLoader) {
							summaryLoader.stop();
							this.statusContainer.clear();
						}
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				(entryId, label) => {
					void this.agentConnection
						.setSessionEntryLabel(entryId, label)
						.then(() => {
							this.ui.requestRender();
						})
						.catch((error) => {
							this.showError(error instanceof Error ? error.message : String(error));
						});
				},
				initialSelectedId,
				initialFilterMode,
			);
			return { component: selector, focus: selector };
		});
	}

	private async handleResumeCommand(args: string): Promise<void> {
		const selector = args.trim();
		if (!selector) {
			await this.requestAgentsView();
			return;
		}
		let sessionPath: string;
		try {
			sessionPath = (await resolveSessionPath(selector, this.getCurrentCwd(), this.connectionState?.sessionDir))
				.path;
		} catch (error) {
			if (error instanceof SessionSelectorError) {
				const suggestion =
					error instanceof SessionSelectorNotFoundError && error.suggestion
						? ` Did you mean '${error.suggestion}'?`
						: "";
				this.showError(`${error.message}.${suggestion}`);
				return;
			}
			throw error;
		}
		await this.handleResumeSession(sessionPath);
	}

	private async handleResumeSession(
		sessionPath: string,
		options?: Parameters<ExtensionCommandContext["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		this.stopWorkingLoader();
		try {
			const result = options?.withSession
				? await this.getLocalSessionHost().switchSession(sessionPath, {
						withSession: options.withSession,
					})
				: await this.agentConnection.switchSession(sessionPath);
			if (result.cancelled) {
				return result;
			}
			await this.renderCurrentSessionState();
			this.showStatus("Resumed session");
			return result;
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Resume cancelled");
					return { cancelled: true };
				}
				const result = options?.withSession
					? await this.getLocalSessionHost().switchSession(sessionPath, {
							cwdOverride: selectedCwd,
							withSession: options.withSession,
						})
					: await this.agentConnection.switchSession(sessionPath, { cwdOverride: selectedCwd });
				if (result.cancelled) {
					return result;
				}
				await this.renderCurrentSessionState();
				this.showStatus("Resumed session in current cwd");
				return result;
			}
			return this.handleFatalRuntimeError("Failed to resume session", error);
		}
	}

	private showOnboardingSplash(continueActionLabel?: string): Promise<OnboardingSplashHandle | undefined> {
		return new Promise((resolve) => {
			let settled = false;
			let dismissed = false;
			let handle: OverlayHandle | undefined;
			let selector: PrimeOnboardingSplashComponent | undefined;
			const settle = (result: OnboardingSplashHandle | undefined) => {
				if (settled) {
					return;
				}
				settled = true;
				resolve(result);
			};
			const dismiss = () => {
				if (dismissed) {
					return;
				}
				dismissed = true;
				selector?.dispose();
				handle?.hide();
				this.ui.requestRender();
			};
			selector = new PrimeOnboardingSplashComponent(
				() => {
					selector?.dispose();
					settle({
						showProgress: (message) => selector?.showProgress(message),
						dismiss,
					});
				},
				() => {
					dismiss();
					settle(undefined);
				},
				{
					getRows: () => this.ui.terminal.rows,
					requestRender: () => this.ui.requestRender(),
					...(continueActionLabel ? { continueActionLabel } : {}),
				},
			);
			handle = this.ui.showOverlay(selector, {
				width: "100%",
				maxHeight: "100%",
				row: 0,
				col: 0,
			});
		});
	}

	private createAuthFlows(): ProviderAuthFlows {
		return new ProviderAuthFlows({
			ui: this.ui,
			modelRegistry: this.modelRegistry,
			showStatus: (message) => this.showStatus(message),
			showError: (message) => this.showError(message),
			getAvailableModels: () => this.getConnectionAvailableModels(),
			onAuthChanged: async () => {
				await this.refreshConnectionModelsAfterAuthChange();
				await this.updateAvailableProviderCount();
				this.footer.invalidate();
				this.updateEditorBorderColor();
			},
			onLoginCompleted: () => {
				void this.maybeWarnAboutAnthropicSubscriptionAuth();
			},
		});
	}

	private async prepareForModelSelectionAfterLogin(authResult: AuthenticationResult): Promise<boolean> {
		const currentModel = this.getCurrentModel();
		// The agent core uses unknown/unknown as its no-model sentinel.
		const selectedModel =
			currentModel?.provider === "unknown" && currentModel.id === "unknown" ? undefined : currentModel;
		let action = resolvePrimeInferencePostLoginModelAction(authResult, selectedModel, this.modelRegistry);
		if (!action.openModelPicker) {
			return false;
		}

		if (!selectedModel) {
			try {
				const availableModels = await this.getConnectionAvailableModels();
				action = resolvePrimeInferencePostLoginModelAction(authResult, selectedModel, {
					find: (provider, modelId) =>
						availableModels.find((model) => model.provider === provider && model.id === modelId) ??
						this.modelRegistry.find(provider, modelId),
				});
			} catch {
				// Preserve the registry fallback so selection can still report a specific failure below.
			}
		}

		if (action.fallbackModel) {
			try {
				await this.applySelectedModel(action.fallbackModel);
				await this.settingsManager.flush();
			} catch (error) {
				this.showError(
					`Prime Inference login succeeded, but the default model could not be selected: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		} else if (!selectedModel) {
			this.showError("Prime Inference login succeeded, but the default GLM 5.2 model is unavailable.");
		}

		return true;
	}

	private async handleMcpCommand(args: string | undefined): Promise<void> {
		const argv = parseCommandArgs((args ?? "").trim());
		const [sub, server] = argv;
		if (!sub) {
			await this.showConfigurationMenu("mcp-connections");
			return;
		}

		const authStorage = this.modelRegistry.authStorage;
		const isAuthed = (name: string) => authStorage.get(`mcp:${name}`) !== undefined;
		if (sub === "login") {
			if (!server || argv.length !== 2) {
				this.showError("Usage: /mcp login <name> (e.g. /mcp login linear)");
				return;
			}
			const result = await this.createAuthFlows().runMcpLogin(server);
			if (result.status === "success") await this.reloadAfterMcpChange(`Connected ${server}.`);
			return;
		}

		if (sub === "logout") {
			if (!server || argv.length !== 2) {
				this.showError("Usage: /mcp logout <name>");
				return;
			}
			if (!isAuthed(server)) {
				this.showStatus(`${server} is not connected.`);
				return;
			}
			authStorage.logout(`mcp:${server}`);
			await this.reloadAfterMcpChange(`Disconnected ${server}.`);
			return;
		}

		try {
			const result = await runMcpManagementCommand(argv, this.settingsManager, this.modelRegistry.authStorage);
			if (result.changed && result.serverChange) {
				const { name, transport, verb, usesOAuth } = result.serverChange;
				const hasMcpProviderRefresh = this.uiServices.refreshMcpProviders !== undefined;
				this.uiServices.refreshMcpProviders?.();
				const successMessage =
					verb === "removed"
						? `Removed MCP server "${name}" (${transport}). It is no longer available through mcp.`
						: usesOAuth
							? `${verb === "replaced" ? "Replaced" : "Added"} MCP server "${name}" (${transport}). ${hasMcpProviderRefresh ? "Run" : "Restart Prime Agent, then run"} /mcp login ${name} to connect.`
							: `${verb === "replaced" ? "Replaced" : "Added"} MCP server "${name}" (${transport}). Available next turn through mcp.`;
				await this.reloadAfterMcpChange(usesOAuth ? successMessage : result.message, successMessage);
			} else if (result.action === "list") {
				const builtins = BUILTIN_MCP_CATALOG.map(
					(entry) => `${entry.label} (${entry.server}): ${isAuthed(entry.server) ? "connected" : "not connected"}`,
				).join("\n");
				this.showStatus(
					`Built-in MCP integrations:\n${builtins}\n\nUser-configured MCP servers:\n${result.message}`,
				);
			} else {
				this.showStatus(result.message);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async reloadAfterMcpChange(message: string, successMessage = message): Promise<void> {
		if (this.isAgentStreaming() || this.isAgentCompacting()) {
			this.showStatus(`${message} The change was saved. Run /reload after the current turn to activate it.`);
			return;
		}
		const reloaded = await this.handleReloadCommand();
		if (reloaded) {
			this.showStatus(successMessage);
		} else {
			this.showWarning(`${message} The change remains saved, but it is not active in this session.`);
		}
	}

	private async showLogoutSelector(): Promise<void> {
		// Only reload when an MCP integration was actually removed (its skill must
		// be disabled); a cancelled or non-MCP logout needs no reload.
		const loggedOut = await this.createAuthFlows().runLogout();
		if (loggedOut?.startsWith("mcp:")) {
			await this.handleReloadCommand();
		}
	}

	private async handleUpdateCommand(args: string): Promise<void> {
		const entrypoint = process.argv[1];
		if (!entrypoint) {
			this.showError("Cannot determine current CLI entrypoint for update");
			return;
		}

		const updateArgs = parseCommandArgs(args);
		const includesSelf = updateArgsIncludeSelf(updateArgs);
		const updateCwd = this.getCurrentCwd();
		const daemonSocketPath = resolveInteractiveUpdateDaemonSocketPath(
			updateArgs,
			resolveDaemonUpdateRestartSocketPath(this.options.daemonSocketPath),
		);
		const updateChildArgs = includesSelf ? buildUpdateChildArgs(updateArgs, daemonSocketPath) : updateArgs;
		this.stopWorkingLoader();
		await this.ui.terminal.drainInput(1000).catch(() => undefined);
		this.ui.stop();

		const updateEnv = includesSelf ? { ...process.env, [SELF_UPDATE_INTERACTIVE_CHILD_ENV]: "1" } : process.env;
		const updateResult = spawnSync(
			process.execPath,
			[...process.execArgv, entrypoint, "update", ...updateChildArgs],
			{
				stdio: "inherit",
				cwd: updateCwd,
				env: updateEnv,
			},
		);
		const updateExitCode = updateResult.status ?? (updateResult.signal ? 1 : 0);
		const selfUpdateNotAttempted =
			includesSelf && !updateResult.error && updateExitCode === SELF_UPDATE_NOT_ATTEMPTED_EXIT_CODE;

		if (includesSelf && !selfUpdateNotAttempted) {
			const relaunchArgs = buildUpdateRelaunchArgs(process.argv.slice(2), this.connectionState?.sessionFile);
			if (updateResult.error) {
				console.error(`Update failed: ${updateResult.error.message}`);
				console.error(`Relaunching ${APP_NAME}...`);
			} else if (updateExitCode !== 0) {
				console.error(
					updateResult.signal
						? `Update terminated by signal ${updateResult.signal}`
						: `Update exited with code ${updateExitCode}`,
				);
				console.error(`Relaunching ${APP_NAME}...`);
			}
			this.stop();
			await this.agentConnection.dispose().catch(() => undefined);
			try {
				await this.options.onShutdown?.();
			} catch {
				// The update already completed; do not block relaunch on local teardown.
			}
			if (!updateResult.error && updateExitCode === 0) {
				try {
					const status = await launchDaemonUpdateRestartCoordinator({
						socketPath: daemonSocketPath,
						agentDir: getAgentDir(),
						cwd: updateCwd,
						originActiveSessionId: this.connectionState?.activeSessionId,
					});
					const report = buildDaemonUpdateRestartReport(status);
					for (const message of report.info) {
						console.log(message);
					}
					for (const warning of report.warnings) {
						console.error(`Warning: ${warning}`);
					}
				} catch (error: unknown) {
					console.error(
						`Warning: updated, but could not coordinate the daemon restart (${error instanceof Error ? error.message : String(error)}).`,
					);
				}
			}
			const relaunchResult = spawnSync(process.execPath, [...process.execArgv, entrypoint, ...relaunchArgs], {
				stdio: "inherit",
				cwd: updateCwd,
				env: process.env,
			});
			if (relaunchResult.error) {
				console.error(`Failed to relaunch ${APP_NAME}: ${relaunchResult.error.message}`);
				process.exit(1);
			}
			process.exit(relaunchResult.status ?? (relaunchResult.signal ? 1 : 0));
		}

		this.ui.start();
		if (this.fullscreenEnabled) {
			this.applyFullscreen(true);
		}
		this.ui.requestRender(true);

		if (selfUpdateNotAttempted) {
			this.showStatus(`Update did not change ${APP_NAME}. Reloading resources...`);
			await this.handleReloadCommand();
			return;
		}
		if (updateResult.error) {
			this.showError(`Update failed: ${updateResult.error.message}`);
			return;
		}
		if (updateExitCode !== 0) {
			this.showError(
				updateResult.signal
					? `Update terminated by signal ${updateResult.signal}`
					: `Update exited with code ${updateExitCode}`,
			);
			return;
		}
		this.showStatus("Packages updated. Reloading resources...");
		await this.handleReloadCommand();
	}

	private async handleReloadCommand(): Promise<boolean> {
		if (this.isAgentStreaming()) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return false;
		}
		if (this.isAgentCompacting()) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return false;
		}

		this.resetExtensionUI();

		const reloadBox = new Container();
		const borderColor = (s: string) => theme.fg("border", s);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes..."), 1, 0),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));

		const previousEditor = this.editor;
		this.editorContainer.clear();
		this.editorContainer.addChild(reloadBox);
		this.ui.setFocus(reloadBox);
		this.ui.requestRender(true);
		await new Promise((resolve) => process.nextTick(resolve));

		const dismissReloadBox = (editor: Component) => {
			this.editorContainer.clear();
			this.editorContainer.addChild(editor);
			this.ui.setFocus(editor);
			this.ui.requestRender();
		};

		try {
			await this.agentConnection.reload();
			this.toolDefinitionCache.clear();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) {
				activeHeader.setExpanded(this.toolOutputExpanded);
			}
			setRegisteredThemes(this.uiServices.getThemes());
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			const themeName = this.settingsManager.getTheme();
			const themeResult = themeName ? setTheme(themeName, true) : { success: true };
			if (!themeResult.success) {
				this.showError(`Failed to load theme "${themeName}": ${themeResult.error}\nFell back to dark theme.`);
			}
			const editorPaddingX = this.settingsManager.getEditorPaddingX();
			const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
			this.defaultEditor.setPaddingX(editorPaddingX);
			this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
			if (this.editor !== this.defaultEditor) {
				this.editor.setPaddingX?.(editorPaddingX);
				this.editor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
			}
			this.ui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
			this.ui.setClearOnShrink(this.settingsManager.getClearOnShrink());
			await this.refreshConnectionCatalog();
			this.setupAutocompleteProvider();
			if (this.bindLocalSessionExtensions) {
				const runner = this.getLocalSessionHost().getExtensionRunner();
				this.setupExtensionShortcuts(runner);
			}
			await this.rebuildChatFromMessages();
			dismissReloadBox(this.editor as Component);
			this.showLoadedResources({
				force: false,
				showDiagnosticsWhenQuiet: true,
			});
			const modelsJsonError = this.modelRegistry.getError();
			if (modelsJsonError) {
				this.showError(`models.json error: ${modelsJsonError}`);
			}
			this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes");
			return true;
		} catch (error) {
			dismissReloadBox(previousEditor as Component);
			this.showError(`Reload failed: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");

		try {
			if (outputPath?.endsWith(".jsonl")) {
				const filePath = await this.agentConnection.exportToJsonl(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			} else {
				const filePath = await this.agentConnection.exportToHtml(outputPath);
				this.showStatus(`Session exported to: ${filePath}`);
			}
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export" | "/import"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleImportCommand(text: string): Promise<void> {
		const inputPath = this.getPathCommandArgument(text, "/import");
		if (!inputPath) {
			this.showError("Usage: /import <path.jsonl>");
			return;
		}

		const confirmed = await this.showExtensionConfirm("Import session", `Replace current session with ${inputPath}?`);
		if (!confirmed) {
			this.showStatus("Import cancelled");
			return;
		}

		try {
			this.stopWorkingLoader();
			const result = await this.agentConnection.importFromJsonl(inputPath);
			if (result.cancelled) {
				this.showStatus("Import cancelled");
				return;
			}
			await this.renderCurrentSessionState();
			this.showStatus(`Session imported from: ${inputPath}`);
		} catch (error: unknown) {
			if (error instanceof MissingSessionCwdError) {
				const selectedCwd = await this.promptForMissingSessionCwd(error);
				if (!selectedCwd) {
					this.showStatus("Import cancelled");
					return;
				}
				const result = await this.agentConnection.importFromJsonl(inputPath, selectedCwd);
				if (result.cancelled) {
					this.showStatus("Import cancelled");
					return;
				}
				await this.renderCurrentSessionState();
				this.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				this.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await this.handleFatalRuntimeError("Failed to import session", error);
		}
	}

	private async handleShareCommand(): Promise<void> {
		// Check if gh is available and logged in
		try {
			const authResult = spawnSync("gh", ["auth", "status"], { encoding: "utf-8" });
			if (authResult.status !== 0) {
				this.showError("GitHub CLI is not logged in. Run 'gh auth login' first.");
				return;
			}
		} catch {
			this.showError("GitHub CLI (gh) is not installed. Install it from https://cli.github.com/");
			return;
		}

		// Export to a temp file
		const tmpFile = path.join(os.tmpdir(), "session.html");
		try {
			await this.agentConnection.exportToHtml(tmpFile);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
			return;
		}

		// Show cancellable loader, replacing the editor
		const loader = new BorderedLoader(this.ui, theme, "Creating gist...");
		this.editorContainer.clear();
		this.editorContainer.addChild(loader);
		this.ui.setFocus(loader);
		this.ui.requestRender();

		const restoreEditor = () => {
			loader.dispose();
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			try {
				fs.unlinkSync(tmpFile);
			} catch {
				// Ignore cleanup errors
			}
		};

		// Create a secret gist asynchronously
		let proc: ReturnType<typeof spawn> | null = null;

		loader.onAbort = () => {
			proc?.kill();
			restoreEditor();
			this.showStatus("Share cancelled");
		};

		try {
			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
				proc = spawn("gh", ["gist", "create", "--public=false", tmpFile]);
				let stdout = "";
				let stderr = "";
				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.stderr?.on("data", (data) => {
					stderr += data.toString();
				});
				proc.on("close", (code) => resolve({ stdout, stderr, code }));
			});

			if (loader.signal.aborted) return;

			restoreEditor();

			if (result.code !== 0) {
				const errorMsg = result.stderr?.trim() || "Unknown error";
				this.showError(`Failed to create gist: ${errorMsg}`);
				return;
			}

			// Extract gist ID from the URL returned by gh
			// gh returns something like: https://gist.github.com/username/GIST_ID
			const gistUrl = result.stdout?.trim();
			const gistId = gistUrl?.split("/").pop();
			if (!gistId) {
				this.showError("Failed to parse gist ID from gh output");
				return;
			}

			// Create the preview URL
			const previewUrl = getShareViewerUrl(gistId);
			this.showStatus(`Share URL: ${previewUrl}\nGist: ${gistUrl}`);
		} catch (error: unknown) {
			if (!loader.signal.aborted) {
				restoreEditor();
				this.showError(`Failed to create gist: ${error instanceof Error ? error.message : "Unknown error"}`);
			}
		}
	}

	private async handleCopyCommand(): Promise<void> {
		const text = await this.agentConnection.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			this.showStatus("Copied last agent message to clipboard");
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleNameCommand(text: string): Promise<void> {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.getCurrentSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new Text(theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		await this.agentConnection.setSessionName(name);
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(theme.fg("dim", `Session name set: ${name}`), 1, 0));
		this.ui.requestRender();
	}

	private async handleRlmMaxDepthCommand(args: string): Promise<void> {
		const tokens = args ? args.split(/\s+/) : [];
		if (tokens.length === 0) {
			try {
				const status = await this.agentConnection.getRlmMaxDepthStatus();
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(
					new Text(theme.fg("dim", `RLM max depth: ${status.maxDepth} (${status.source})`), 1, 0),
				);
				this.ui.requestRender();
			} catch (error) {
				this.showError(error instanceof Error ? error.message : String(error));
			}
			return;
		}

		const global = tokens[1] === "--global";
		if (tokens.length > (global ? 2 : 1) || !/^\d+$/.test(tokens[0] ?? "")) {
			this.showWarning("Usage: /rlm-max-depth [<non-negative integer> [--global]]");
			return;
		}
		const maxDepth = Number(tokens[0]);
		if (!Number.isSafeInteger(maxDepth)) {
			this.showWarning("RLM max depth must be a non-negative integer.");
			return;
		}

		try {
			const result = await this.agentConnection.setRlmMaxDepth(maxDepth, { global });
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(
					theme.fg(
						"dim",
						`RLM max depth set: ${result.maxDepth}${result.globalSaved ? " and saved as global default" : ""}`,
					),
					1,
					0,
				),
			);
			this.ui.requestRender();
			if (result.globalError) {
				this.showError(
					`RLM max depth set for this chat, but the global default was not saved: ${result.globalError}`,
				);
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleSessionCommand(): Promise<void> {
		const stats = await this.agentConnection.getSessionStats();
		const sessionName = this.getCurrentSessionName();

		let info = `${theme.bold("Session Info")}\n\n`;
		if (sessionName) {
			info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
		}
		info += `${theme.fg("dim", "File:")} ${stats.sessionFile ?? "In-memory"}\n`;
		info += `${theme.fg("dim", "ID:")} ${stats.sessionId}\n\n`;
		info += `${theme.bold("Messages")}\n`;
		info += `${theme.fg("dim", "User:")} ${stats.userMessages}\n`;
		info += `${theme.fg("dim", "Assistant:")} ${stats.assistantMessages}\n`;
		info += `${theme.fg("dim", "Tool Calls:")} ${stats.toolCalls}\n`;
		info += `${theme.fg("dim", "Tool Results:")} ${stats.toolResults}\n`;
		info += `${theme.fg("dim", "Total:")} ${stats.totalMessages}\n\n`;
		info += theme.fg("dim", "Use /context for token, cost, and context usage.");

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private handleLogsCommand(): void {
		const logsDir = getLogsDir();
		let info = `${theme.bold("Logs")}\n\n`;
		info += `${theme.fg("dim", "Directory:")} ${logsDir}\n\n`;

		let files: string[] = [];
		try {
			if (fs.existsSync(logsDir)) {
				files = fs.readdirSync(logsDir).filter((name) => !name.startsWith("."));
			}
		} catch {
			// Fall through to the empty-state line below.
		}
		if (files.length === 0) {
			info += `${theme.fg("dim", "No logs written yet.")}\n`;
		} else {
			for (const name of files.sort()) {
				let size = "";
				try {
					size = ` ${theme.fg("dim", `(${(fs.statSync(path.join(logsDir, name)).size / 1024).toFixed(1)} KB)`)}`;
				} catch {
					// Skip the size if the file vanished between readdir and stat.
				}
				info += `${theme.fg("dim", "•")} ${name}${size}\n`;
			}
		}
		info += `\n${theme.fg("dim", "Daemon crashes log to <socket>.log; agent-open failures log to client-errors.log.")}`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleSystemPromptCommand(): Promise<void> {
		const prompt = await this.agentConnection.getSystemPrompt();
		const header = `${theme.bold("System Prompt")} ${theme.fg("dim", `(${prompt.length} chars)`)}`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(header, 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(prompt, 1, 0));
		this.ui.requestRender();
	}

	private formatTraceUploadResult(result: AgentTraceUploadResult): string {
		switch (result.status) {
			case "uploaded":
				return `Trace uploaded (${result.bytesStored.toLocaleString()} bytes).`;
			case "disabled":
				return "Trace sharing is disabled.";
			case "missing_credentials":
				return "Trace sharing needs a Prime API key. Run /traces login.";
			case "no_session_file":
				return "Current session has no persisted trace yet.";
			case "empty_session":
				return "Current session trace is empty.";
			case "invalid_session":
				return `Trace upload skipped: ${result.message}.`;
			case "too_large":
				return `Trace upload skipped: session file is ${result.size.toLocaleString()} bytes; limit is ${result.maxBytes.toLocaleString()} bytes.`;
			case "failed":
				if (result.statusCode === 404) {
					return "Trace upload endpoint was not found. The platform API may not be deployed yet, or PRIME_AGENT_TRACES_BASE_URL points at the wrong API.";
				}
				return `Trace upload failed: ${result.statusCode ? `HTTP ${result.statusCode}: ` : ""}${result.message}. See ${getAgentTracesLogPath()} for details.`;
		}
	}

	private async uploadCurrentTraceOnce(): Promise<AgentTraceUploadResult> {
		const state = await this.agentConnection.getState();
		return uploadAgentTraceFile({
			sessionFile: state.sessionFile,
			authStorage: this.modelRegistry.authStorage,
			settingsManager: this.settingsManager,
			requireEnabled: false,
			reloadConfig: false,
		});
	}

	private async previewCurrentTrace(): Promise<void> {
		const state = await this.agentConnection.getState();
		const result = await previewAgentTraceFile({ sessionFile: state.sessionFile });
		let info: string;
		switch (result.status) {
			case "no_session_file":
				info = "Trace preview is unavailable until the current session has a persisted assistant response.";
				break;
			case "empty_session":
				info = "The current trace is empty.";
				break;
			case "invalid_session":
			case "failed":
				info = `Trace preview failed: ${result.message}.`;
				break;
			case "ready":
				info = this.formatTracePreview(result);
				break;
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private formatTracePreview(result: Extract<AgentTracePreviewResult, { status: "ready" }>): string {
		const lines = [
			theme.bold("Trace Preview"),
			theme.fg("dim", "Nothing has been uploaded by this command."),
			"",
			`${theme.fg("dim", "File:")} ${result.sessionFile}`,
			`${theme.fg("dim", "Size:")} ${result.size.toLocaleString()} bytes`,
			`${theme.fg("dim", "Uploadable:")} ${result.uploadable ? "Yes" : `No (limit ${result.maxBytes.toLocaleString()} bytes)`}`,
			`${theme.fg("dim", "Endpoint:")} ${result.endpoint}`,
			`${theme.fg("dim", "Session ID:")} ${result.sessionId}`,
			`${theme.fg("dim", "Trace ID:")} ${result.traceId}`,
		];
		if (result.parentSessionId) {
			lines.push(`${theme.fg("dim", "Parent session:")} ${result.parentSessionId}`);
		}
		if (result.gitRepo) {
			lines.push(`${theme.fg("dim", "Git repository:")} ${result.gitRepo}`);
		}
		if (result.gitCommit) {
			lines.push(`${theme.fg("dim", "Git commit:")} ${result.gitCommit}`);
		}
		lines.push("", theme.bold("Raw JSONL payload preview"));
		if (result.contentPreview) {
			lines.push(result.contentPreview);
			if (result.truncated) {
				lines.push("", theme.fg("dim", "Preview truncated; upload sends the complete file."));
			}
		} else {
			lines.push(theme.fg("dim", "Payload omitted because the trace exceeds the upload limit."));
		}
		return lines.join("\n");
	}

	private async uploadAllTraces(sessionDir?: string, signal?: AbortSignal): Promise<AgentTraceUploadAllResult> {
		return uploadAllAgentTraces({
			authStorage: this.modelRegistry.authStorage,
			settingsManager: this.settingsManager,
			sessionDir,
			requireEnabled: false,
			reloadConfig: false,
			signal,
			onProgress: ({ completed, total }) => {
				if (total > 0 && (completed === 0 || completed === total || completed % 10 === 0)) {
					this.showStatus(
						`Uploading traces: ${completed.toLocaleString()}/${total.toLocaleString()} (${keyText("app.clear")} to cancel)`,
					);
				}
			},
		});
	}

	private async handleTracesCommand(text: string): Promise<void> {
		const command =
			text
				.replace(/^\/traces\b/, "")
				.trim()
				.toLowerCase() || "status";

		if (command === "status") {
			await this.settingsManager.reload().catch(() => undefined);
			const credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			const state = await this.agentConnection.getState();
			const info = [
				theme.bold("Trace Sharing"),
				"",
				`${theme.fg("dim", "Automatic uploads:")} ${this.settingsManager.getAgentTracesEnabled() ? "Enabled" : "Disabled"}`,
				`${theme.fg("dim", "Credential:")} ${credential?.label ?? "Not configured"}`,
				`${theme.fg("dim", "Endpoint:")} ${resolvePrimeAgentTracesBaseUrl()}`,
				`${theme.fg("dim", "Session file:")} ${state.sessionFile ?? "In-memory"}`,
				"",
				theme.fg(
					"dim",
					"Commands: /traces on, /traces off, /traces preview, /traces upload-current, /traces upload-all, /traces login",
				),
			].join("\n");
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(info, 1, 0));
			this.ui.requestRender();
			return;
		}

		if (command === "off" || command === "disable") {
			this.settingsManager.setAgentTracesEnabled(false);
			await this.settingsManager.flush();
			this.showStatus("Trace sharing disabled.");
			return;
		}

		if (command === "login") {
			await this.createAuthFlows().runPrimeAgentTracesLogin();
			return;
		}

		if (command === "preview") {
			await this.previewCurrentTrace();
			return;
		}

		if (command === "on" || command === "enable") {
			let credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			if (!credential) {
				const authResult = await this.createAuthFlows().runPrimeAgentTracesLogin();
				if (authResult.status !== "success") {
					return;
				}
				credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			}
			if (!credential) {
				this.showError("Trace sharing needs a Prime API key.");
				return;
			}

			this.settingsManager.setAgentTracesEnabled(true);
			await this.settingsManager.flush();
			const uploadResult = await this.uploadCurrentTraceOnce();
			const uploadMessage =
				uploadResult.status === "no_session_file" || uploadResult.status === "empty_session"
					? "Current session will upload after the first assistant response."
					: this.formatTraceUploadResult(uploadResult);
			this.showStatus(`Trace sharing enabled. ${uploadMessage}`);
			return;
		}

		if (command === "upload" || command === "upload-current") {
			const credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			if (!credential) {
				this.showError("Trace sharing needs a Prime API key. Run /traces login.");
				return;
			}
			const uploadResult = await this.uploadCurrentTraceOnce();
			const message = this.formatTraceUploadResult(uploadResult);
			if (uploadResult.status === "failed") {
				this.showError(message);
			} else {
				this.showStatus(message);
			}
			return;
		}

		if (command === "upload-all") {
			const credential = await getPrimeAgentTraceCredential(this.modelRegistry.authStorage);
			if (!credential) {
				this.showError("Trace sharing needs a Prime API key. Run /traces login.");
				return;
			}
			if (this.traceUploadAllAbortController) {
				this.showWarning("A trace upload is already running. Cancel it before starting another.");
				return;
			}
			const state = await this.agentConnection.getState();
			const abortController = new AbortController();
			this.traceUploadAllAbortController = abortController;
			let result: AgentTraceUploadAllResult;
			try {
				result = await this.uploadAllTraces(state.sessionDir, abortController.signal);
			} finally {
				if (this.traceUploadAllAbortController === abortController) {
					this.traceUploadAllAbortController = undefined;
				}
			}
			if (abortController.signal.aborted) {
				this.showStatus("Trace upload cancelled.");
				return;
			}
			if (result.total === 0) {
				this.showStatus("No persisted traces were found.");
				return;
			}
			const summary = [
				`Uploaded ${result.uploaded.toLocaleString()} of ${result.total.toLocaleString()} traces`,
				result.skipped > 0 ? `${result.skipped.toLocaleString()} skipped` : undefined,
				result.failed > 0 ? `${result.failed.toLocaleString()} failed` : undefined,
				`${result.bytesStored.toLocaleString()} bytes stored`,
			]
				.filter((part): part is string => part !== undefined)
				.join("; ");
			if (result.failed > 0) {
				this.showWarning(`${summary}. See ${getAgentTracesLogPath()} for details.`);
			} else {
				this.showStatus(`${summary}.`);
			}
			return;
		}

		this.showWarning("Usage: /traces [status|on|off|preview|upload|upload-current|upload-all|login]");
	}

	private async handleContextCommand(): Promise<void> {
		let info: string;
		try {
			const tree = await this.agentConnection.getContextTree();
			const width = Math.max(60, Math.min(this.ui.terminal.columns - 2, 120));
			info = formatContextTree(tree, width);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(info, 1, 0));
		this.ui.requestRender();
	}

	private async handleHeartbeatCommand(text: string): Promise<void> {
		try {
			const command = parseHeartbeatCommand(text);
			switch (command.type) {
				case "status": {
					const heartbeat = await this.agentConnection.getHeartbeat();
					this.patchConnectionState({ heartbeat: heartbeat ?? null });
					await this.refreshHeartbeatCatalog();
					this.showHeartbeat(heartbeat);
					return;
				}
				case "set": {
					const heartbeat = await this.agentConnection.setHeartbeat(
						command.schedule,
						command.instruction,
						command.deliveryMode,
					);
					this.patchConnectionState({ heartbeat });
					await this.refreshHeartbeatCatalog();
					this.showStatus(
						`Heartbeat set\nDelivery: ${heartbeat.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE}\nNext run: ${heartbeat.nextRunAt ?? "-"}`,
					);
					return;
				}
				case "pause": {
					const heartbeat = await this.agentConnection.updateHeartbeat("pause");
					if (!heartbeat) {
						this.showStatus("No active heartbeat");
						return;
					}
					this.patchConnectionState({ heartbeat });
					await this.refreshHeartbeatCatalog();
					this.showStatus("Heartbeat paused");
					return;
				}
				case "resume": {
					const heartbeat = await this.agentConnection.updateHeartbeat("resume");
					if (!heartbeat) {
						this.showStatus("No active heartbeat");
						return;
					}
					this.patchConnectionState({ heartbeat });
					await this.refreshHeartbeatCatalog();
					this.showStatus(`Heartbeat resumed\nNext run: ${heartbeat.nextRunAt ?? "-"}`);
					return;
				}
				case "clear": {
					const heartbeat = await this.agentConnection.updateHeartbeat("clear");
					if (!heartbeat) {
						this.showStatus("No active heartbeat");
						return;
					}
					this.patchConnectionState({ heartbeat: null });
					await this.refreshHeartbeatCatalog();
					this.showStatus("Heartbeat cleared");
					return;
				}
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async showHeartbeatManager(): Promise<void> {
		if (this.heartbeatManagerHandle) {
			this.heartbeatManagerHandle.focus();
			return;
		}
		try {
			await this.refreshHeartbeatCatalog();
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
			return;
		}
		const manager = new HeartbeatManagerComponent({
			getHeartbeats: () => this.getScopedHeartbeats(),
			getRows: () => this.ui.terminal.rows,
			onAction: (heartbeat, action) => this.manageHeartbeat(heartbeat, action),
			onClose: () => this.closeHeartbeatManager(),
			requestRender: () => this.ui.requestRender(),
		});
		this.heartbeatManager = manager;
		this.heartbeatManagerHandle = this.showFullPaneOverlay(manager, {
			fullWidth: true,
			suspendFullscreenMouse: true,
		});
		this.scheduleHeartbeatManagerRefresh();
	}

	private closeHeartbeatManager(): void {
		this.clearHeartbeatManagerRefreshTimer();
		this.heartbeatManagerHandle?.hide();
		this.heartbeatManagerHandle = undefined;
		this.heartbeatManager = undefined;
		this.ui.requestRender();
	}

	private scheduleHeartbeatManagerRefresh(): void {
		if (!this.heartbeatManager) {
			this.clearHeartbeatManagerRefreshTimer();
			return;
		}
		const nextRunAt = this.getScopedHeartbeats()
			.filter((heartbeat) => heartbeat.job.status === "active" && heartbeat.job.nextRunAt)
			.map((heartbeat) => Date.parse(heartbeat.job.nextRunAt!))
			.filter(Number.isFinite)
			.sort((left, right) => left - right)[0];
		if (nextRunAt === undefined) {
			this.clearHeartbeatManagerRefreshTimer();
			return;
		}
		const untilNextRun = nextRunAt - Date.now();
		const delay = untilNextRun > 0 ? Math.min(60_000, untilNextRun + 250) : 5_000;
		const refreshAt = Date.now() + delay;
		// Subagent snapshots re-derive this schedule constantly; keep an earlier
		// pending refresh instead of re-arming, or an overdue heartbeat's 5s
		// fallback would be postponed for as long as children stay busy.
		if (
			this.heartbeatManagerRefreshTimer &&
			this.heartbeatManagerRefreshAt !== undefined &&
			this.heartbeatManagerRefreshAt <= refreshAt
		) {
			return;
		}
		this.clearHeartbeatManagerRefreshTimer();
		this.heartbeatManagerRefreshAt = refreshAt;
		this.heartbeatManagerRefreshTimer = setTimeout(() => {
			this.heartbeatManagerRefreshTimer = undefined;
			this.heartbeatManagerRefreshAt = undefined;
			if (!this.heartbeatManager) {
				return;
			}
			void this.refreshHeartbeatCatalog().catch(() => this.scheduleHeartbeatManagerRefresh());
		}, delay);
		this.heartbeatManagerRefreshTimer.unref?.();
	}

	private clearHeartbeatManagerRefreshTimer(): void {
		if (this.heartbeatManagerRefreshTimer) {
			clearTimeout(this.heartbeatManagerRefreshTimer);
			this.heartbeatManagerRefreshTimer = undefined;
		}
		this.heartbeatManagerRefreshAt = undefined;
	}

	private async manageHeartbeat(
		heartbeat: AgentConnectionHeartbeat,
		action: AgentHeartbeatManagementAction,
	): Promise<void> {
		const updated = await this.agentConnection.manageHeartbeat(
			heartbeat.job.activeSessionId,
			heartbeat.job.id,
			action,
		);
		if (updated.source === "heartbeat" && updated.activeSessionId === this.connectionState?.activeSessionId) {
			this.patchConnectionState({ heartbeat: action === "stop" ? null : updated });
		}
		const remaining = this.heartbeatCatalog.filter((entry) => entry.job.id !== updated.id);
		this.applyHeartbeatCatalog(
			updated.status === "active" || updated.status === "paused"
				? [...remaining, { ...heartbeat, job: updated }]
				: remaining,
		);
		void this.refreshHeartbeatCatalog().catch(() => undefined);
	}

	private showHeartbeat(job: AgentCronJob | undefined): void {
		if (!job) {
			this.showStatus("No active heartbeat");
			return;
		}
		const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "-";
		const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString() : "-";
		const lines = [
			theme.bold("Heartbeat"),
			"",
			`${theme.fg("dim", "Status:")} ${job.status}`,
			`${theme.fg("dim", "Every:")} ${job.schedule.expression}`,
			`${theme.fg("dim", "Delivery:")} ${job.deliveryMode ?? DEFAULT_HEARTBEAT_DELIVERY_MODE}`,
			`${theme.fg("dim", "Instruction:")} ${job.prompt}`,
			`${theme.fg("dim", "Next:")} ${next}`,
			`${theme.fg("dim", "Last:")} ${last}`,
			`${theme.fg("dim", "Runs:")} ${job.runCount}`,
		];
		if (job.lastError) {
			lines.push(`${theme.fg("dim", "Error:")} ${job.lastError}`);
		}
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Text(lines.join("\n"), 1, 0));
		this.ui.requestRender();
	}

	private handleChangelogCommand(): void {
		const changelogPath = getChangelogPath();
		const allEntries = parseChangelog(changelogPath);

		const changelogMarkdown =
			allEntries.length > 0
				? allEntries
						.reverse()
						.map((e) => e.content)
						.join("\n\n")
				: "No changelog entries found.";

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new Text(theme.bold(theme.fg("accent", "What's New")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(changelogMarkdown, 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private capitalizeKey(key: string): string {
		return key
			.split("/")
			.map((k) =>
				k
					.split("+")
					.map((part) => (part === "esc" ? part : part.charAt(0).toUpperCase() + part.slice(1)))
					.join("+"),
			)
			.join("/");
	}

	private getAppKeyDisplay(action: AppKeybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private getEditorKeyDisplay(action: Keybinding): string {
		return this.capitalizeKey(keyText(action));
	}

	private getShortcutGuide(): string {
		const tab = this.getEditorKeyDisplay("tui.input.tab");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const clearInput = this.getAppKeyDisplay("app.input.clear");
		const shortcutsKey = this.getAppKeyDisplay("app.shortcuts");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const expandMessages = this.getAppKeyDisplay("app.messages.expand");
		const expandEdits = this.getAppKeyDisplay("app.edits.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const promptStash = this.getAppKeyDisplay("app.prompt.stash");
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");

		return `
**Prompt**
\`!\` shell mode · \`/\` commands · \`@\` file paths
\`${tab}\` complete paths · \`${newLine}\` new line
\`${clearInput}\` interrupt · press twice to rewind or clear the prompt

**Controls**
\`${selectModel}\` select model · \`/effort\` set reasoning · \`${expandTools}\` tool output
\`${expandMessages}\` agent messages · \`${expandEdits}\` edit diffs · \`${toggleThinking}\` thinking blocks · \`${promptStash}\` stash prompt · \`${externalEditor}\` edit in \`$EDITOR\`
\`${pasteImage}\` paste image

**Help**
${shortcutsKey ? `\`${shortcutsKey}\` quick shortcuts · ` : ""}\`/hotkeys\` full reference
`;
	}

	private getHotkeysGuide(): string {
		const cursorUp = this.getEditorKeyDisplay("tui.editor.cursorUp");
		const cursorDown = this.getEditorKeyDisplay("tui.editor.cursorDown");
		const cursorLeft = this.getEditorKeyDisplay("tui.editor.cursorLeft");
		const cursorRight = this.getEditorKeyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = this.getEditorKeyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = this.getEditorKeyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = this.getEditorKeyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = this.getEditorKeyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = this.getEditorKeyDisplay("tui.editor.jumpForward");
		const jumpBackward = this.getEditorKeyDisplay("tui.editor.jumpBackward");
		const pageUp = this.getEditorKeyDisplay("tui.editor.pageUp");
		const pageDown = this.getEditorKeyDisplay("tui.editor.pageDown");
		const submit = this.getEditorKeyDisplay("tui.input.submit");
		const newLine = this.getEditorKeyDisplay("tui.input.newLine");
		const deleteWordBackward = this.getEditorKeyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = this.getEditorKeyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = this.getEditorKeyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = this.getEditorKeyDisplay("tui.editor.deleteToLineEnd");
		const yank = this.getEditorKeyDisplay("tui.editor.yank");
		const yankPop = this.getEditorKeyDisplay("tui.editor.yankPop");
		const undo = this.getEditorKeyDisplay("tui.editor.undo");
		const tab = this.getEditorKeyDisplay("tui.input.tab");
		const clear = this.getAppKeyDisplay("app.clear");
		const clearInput = this.getAppKeyDisplay("app.input.clear");
		const interrupt = this.getAppKeyDisplay("app.interrupt");
		const shortcutsKey = this.getAppKeyDisplay("app.shortcuts");
		const exit = this.getAppKeyDisplay("app.exit");
		const selectModel = this.getAppKeyDisplay("app.model.select");
		const expandTools = this.getAppKeyDisplay("app.tools.expand");
		const expandMessages = this.getAppKeyDisplay("app.messages.expand");
		const expandEdits = this.getAppKeyDisplay("app.edits.expand");
		const toggleThinking = this.getAppKeyDisplay("app.thinking.toggle");
		const focusSubagents = this.getAppKeyDisplay("app.subagents.focus");
		const manageHeartbeats = this.getAppKeyDisplay("app.heartbeats.open");
		const externalEditor = this.getAppKeyDisplay("app.editor.external");
		const promptStash = this.getAppKeyDisplay("app.prompt.stash");
		const followUp = this.getAppKeyDisplay("app.message.followUp");
		const browseQueue = this.getAppKeyDisplay("app.message.navigateOlder");
		const reorderQueue = `${this.getAppKeyDisplay("app.message.moveEarlier")} / ${this.getAppKeyDisplay("app.message.moveLater")}`;
		const pasteImage = this.getAppKeyDisplay("app.clipboard.pasteImage");
		const viewportPageUp = this.getEditorKeyDisplay("tui.viewport.pageUp");
		const viewportPageDown = this.getEditorKeyDisplay("tui.viewport.pageDown");
		const viewportTop = this.getEditorKeyDisplay("tui.viewport.top");
		const viewportFollow = this.getEditorKeyDisplay("tui.viewport.follow");

		let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history (Up when empty) |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${clearInput}\` | Clear input / cancel autocomplete |
| \`${clear}\` | Interrupt current operation (first) / exit (second) |
${interrupt ? `| \`${interrupt}\` | Interrupt current operation |\n` : ""}${shortcutsKey ? `| \`${shortcutsKey}\` | Show quick shortcuts |\n` : ""}| \`${exit}\` | Exit (when editor is empty) |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${expandMessages}\` | Toggle agent message expansion |
| \`${expandEdits}\` | Toggle edit diff expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${focusSubagents}\` | Focus the subagent summary / open the scoped agents view |
| \`${manageHeartbeats}\` | Manage heartbeats |
| \`${externalEditor}\` | Edit message in external editor |
| \`${promptStash}\` | Stash or restore draft prompt |
| \`${followUp}\` | Queue follow-up message |
| \`${browseQueue}\` | Browse and edit queued messages |
| \`${reorderQueue}\` | Reorder the selected queued message |
| \`${pasteImage}\` | Paste image from clipboard |
| \`/\` | Slash commands |

**Fullscreen mode (\`/fullscreen\`)**
| Key | Action |
|-----|--------|
| \`${viewportPageUp}\` / \`${viewportPageDown}\` | Scroll transcript by page |
| \`${viewportTop}\` | Scroll to top |
| \`${viewportFollow}\` | Scroll to bottom and follow output |
| mouse wheel | Scroll transcript |
| mouse drag | Select and copy text |
| mouse click on link | Open link in browser |
`;

		const shortcuts = this.bindLocalSessionExtensions
			? this.getLocalSessionHost().getExtensionRunner().getShortcuts(this.keybindings.getEffectiveConfig())
			: undefined;
		if (shortcuts && shortcuts.size > 0) {
			hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
			for (const [key, shortcut] of shortcuts) {
				const description = shortcut.description ?? shortcut.extensionPath;
				hotkeys += `| \`${formatKeyText(key)}\` | ${description} |\n`;
			}
		}

		return hotkeys;
	}

	private showShortcutGuide(): void {
		const hotkeys = this.getShortcutGuide();

		this.shortcutGuideContainer.clear();
		this.shortcutGuideContainer.addChild(new Spacer(1));
		this.shortcutGuideContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.ui.requestRender();
	}

	private handleHotkeysCommand(): void {
		const hotkeys = this.getHotkeysGuide();

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.ui.requestRender();
	}

	private clearShortcutGuide(): void {
		if (this.shortcutGuideContainer.children.length === 0) {
			return;
		}
		this.shortcutGuideContainer.clear();
		this.ui.requestRender();
	}

	private async handleClearCommand(options: { name?: string; prompt?: string } = {}): Promise<void> {
		this.stopWorkingLoader();
		const retainedImages = options.prompt ? this.getPromptStashImages(options.prompt) : [];
		const restorePrompt = () => {
			if (!options.prompt) return;
			for (const [id, image] of retainedImages) this.pastedImages.set(id, image);
			this.editor.setText(options.prompt);
		};
		let created = false;
		try {
			const result = await this.agentConnection.newSession();
			if (result.cancelled) {
				restorePrompt();
				return;
			}
			created = true;
			await this.renderCurrentSessionState();
			for (const [id, image] of retainedImages) this.pastedImages.set(id, image);
			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(new Text(`${theme.fg("accent", "✓ New session started")}`, 1, 1));
			this.ui.requestRender();
			const images = options.prompt ? this.collectImagesFor(options.prompt) : undefined;
			if (options.name) await this.agentConnection.setSessionName(options.name);
			if (options.prompt) {
				this.editor.addToHistory?.(options.prompt);
				await this.agentConnection.prompt(options.prompt, { images });
			}
		} catch (error: unknown) {
			if (!created) {
				await this.handleFatalRuntimeError("Failed to create session", error);
				return;
			}
			restorePrompt();
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private async handleDebugCommand(): Promise<void> {
		const width = this.ui.terminal.columns;
		const height = this.ui.terminal.rows;
		const allLines = this.ui.render(width);
		try {
			const messages = await this.agentConnection.getMessages();
			const debugLogPath = getDebugLogPath();
			const debugData = [
				`Debug output at ${new Date().toISOString()}`,
				`Terminal: ${width}x${height}`,
				`Total lines: ${allLines.length}`,
				"",
				"=== All rendered lines with visible widths ===",
				...allLines.map((line, idx) => {
					const vw = visibleWidth(line);
					const escaped = JSON.stringify(line);
					return `[${idx}] (w=${vw}) ${escaped}`;
				}),
				"",
				"=== Agent messages (JSONL) ===",
				...messages.map((msg) => JSON.stringify(msg)),
				"",
			].join("\n");

			fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
			fs.writeFileSync(debugLogPath, debugData);

			this.chatContainer.addChild(new Spacer(1));
			this.chatContainer.addChild(
				new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
			);
			this.ui.requestRender();
		} catch (error: unknown) {
			this.showError(`Failed to write debug log: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private handleArminSaysHi(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ArminComponent(this.ui));
		this.ui.requestRender();
	}

	private handleDementedDelves(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new EarendilAnnouncementComponent());
		this.ui.requestRender();
	}

	private handleDaxnuts(): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DaxnutsComponent(this.ui));
		this.ui.requestRender();
	}

	private checkDaxnutsEasterEgg(model: { provider: string; id: string }): void {
		if (model.provider === "opencode" && model.id.toLowerCase().includes("kimi-k2.5")) {
			this.handleDaxnuts();
		}
	}

	stop(options: { preserveAltScreen?: boolean } = {}): void {
		this.unregisterSignalHandlers();
		this.clearCtrlCExitHint({ render: false });
		this.clearEscapeRepeat();
		if (this.settingsManager.getShowTerminalProgress()) {
			this.ui.terminal.setProgress(false);
		}
		this.stopWorkingLoader();
		this.discardRefineLoader();
		this.endFeatureHintRun();
		this.stopWorkingPulse();
		this.stopGoalTrayTimer();
		this.closeHeartbeatManager();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
		}
		if (this.isInitialized) {
			this.ui.stop({
				preserveAltScreen: options.preserveAltScreen,
				flushFullscreen: options.preserveAltScreen ? false : undefined,
			});
			this.isInitialized = false;
		}
	}
}
