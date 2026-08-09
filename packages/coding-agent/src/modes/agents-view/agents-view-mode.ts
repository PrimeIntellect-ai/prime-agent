import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	clippedFullscreenDockHeight,
	type Focusable,
	ProcessTerminal,
	setKeybindings,
	TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { APP_TITLE, appendRotatingLog, getAgentDir, getClientErrorLogPath, VERSION } from "../../config.js";
import type { AgentSessionRuntimeConfig } from "../../core/agent-session-config.js";
import { KeybindingsManager } from "../../core/keybindings.js";
import { SessionManager } from "../../core/session-manager.js";
import {
	BUILTIN_SLASH_COMMANDS,
	isBuiltinSlashCommandName,
	isSessionSlashCommandName,
	parseSlashCommand,
	resolveBuiltinSlashCommandName,
} from "../../core/slash-commands.js";
import { canonicalizePath } from "../../utils/paths.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { DaemonAgentConnection } from "../agent-connection/daemon-agent-connection.js";
import type { AgentConnectionHeartbeat, AgentConnectionSavedSessionInfo } from "../agent-connection/types.js";
import { DaemonClient, getDaemonSocketCloseReason } from "../daemon/daemon-client.js";
import {
	collectDaemonClientEnv,
	type DaemonClosingReason,
	type DaemonCommand,
	type DaemonResponse,
	isUnknownDaemonCommandError,
} from "../daemon/daemon-protocol.js";
import { resolveAttachModelFallbackMessage, type SessionSummary } from "../daemon/daemon-session-list.js";
import { listDaemonHeartbeats } from "../daemon/heartbeat-catalog.js";
import {
	type DaemonSavedSessionCatalogContext,
	deleteDaemonSavedSession,
	listDaemonSavedSessions,
	renameDaemonSavedSession,
} from "../daemon/saved-session-catalog.js";
import { CustomEditor } from "../interactive/components/custom-editor.js";
import { keyText } from "../interactive/components/keybinding-hints.js";
import { BrandSplashHeader, InteractiveMode } from "../interactive/interactive-mode.js";
import type { InteractiveModeUiServices } from "../interactive/interactive-mode-services.js";
import { ClientPromptStashStore } from "../interactive/prompt-stash-state.js";
import {
	getEditorTheme,
	initTheme,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	theme,
} from "../interactive/theme/theme.js";
import { WORKING_ICON_INTERVAL_MS, workingIconFrame } from "../interactive/theme/working-icon.js";
import {
	formatPackageUpdateNotice,
	formatTmuxWarningNotice,
	formatUpdateAvailableNotice,
	gatherStartupNotices,
	type StartupNotices,
} from "../shared/startup-notices.js";
import {
	type AgentsViewRow,
	type AgentsViewScopeFrame,
	type AgentsViewScopeKey,
	type AgentsViewSection,
	type AgentsViewSelectionKey,
	buildAgentsViewRows,
	buildUnifiedSessionIndex,
	createUnattachableChildOpenResult,
	filterUnifiedSessions,
	formatHeartbeatBadge,
	getAgentsViewSelectionKey,
	getAgentsViewSessionTitle,
	getAgentsViewSummaryIdentity as getSummaryIdentity,
	getUnifiedSessionAncestorSessionIds,
	hasUnifiedSessionChildren,
	reconcileUnifiedSessions,
	resolveAgentsViewLeftResult,
	resolveAgentsViewScopeFrames,
	resolveAgentsViewSelectionState,
	scopeToSessionSubtree,
	sectionTitle,
	shouldApplyScopeResolution,
	shouldShowAgentsViewSession,
	summaryForUnifiedRecord,
	transitionAgentsViewScope,
	type UnifiedSessionIndex,
	type UnifiedSessionRecord,
} from "./agents-view-state.js";
import { matchesSearchText } from "./session-view-search.js";

const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_POLL_INTERVAL_MS = 15000;
const RECONNECT_TIMEOUT_MS = 120000;
const RECONNECT_RETRY_MS = 1000;
const EXIT_HINT_DURATION_MS = 2000;
const DELETE_CONFIRM_DURATION_MS = 2000;
const STATUS_MESSAGE_DURATION_MS = 4500;
const SEARCH_PROMPT_PLACEHOLDER = "Search sessions";
const REPLY_PROMPT_FALLBACK_PLACEHOLDER = "Write a reply to this agent";
const RESUME_PROMPT_PLACEHOLDER = "Write a prompt to resume this session";
const COMPLETED_ROW_ICON = "✓";
const NEEDS_INPUT_ROW_ICON = "●";
const SELECTED_ROW_MARKER = "\0agents-view-selected-row\0";
// Tags a spawn-code line so finalize can wrap the whole row in a panel
// background, visually segmenting the program from the agent rows.
const CODE_ROW_MARKER = "\0agents-view-code-row\0";

export interface AgentsViewModeOptions {
	socketPath?: string;
	config: AgentSessionRuntimeConfig;
	uiServices: InteractiveModeUiServices;
	createUiServicesForSession?: (summary: SessionSummary) => Promise<InteractiveModeUiServices>;
	migratedProviders?: string[];
	modelFallbackMessage?: string;
	startupModelId?: string;
	verbose?: boolean;
	recoverDaemon?: () => Promise<void>;
	reconnectTimeoutMs?: number;
	promptStashStore?: ClientPromptStashStore;
	initialSession?: SessionSummary;
	/** When set, the first view is rooted at this session's direct children. */
	initialScopeKey?: AgentsViewScopeKey;
}

export type AgentsViewRunResult =
	| { type: "exit" }
	| {
			type: "scope_back";
			selection: SessionSummary;
			expandedAncestorSessionIds: string[];
			returnChat?: SessionSummary;
			hasChildren: boolean;
	  }
	| {
			type: "open";
			summary: SessionSummary;
			/** Row restored after chat closes; differs from summary only for an unattachable-child fallback. */
			selection?: SessionSummary;
			expandedAncestorSessionIds?: string[];
			hasChildren?: boolean;
			statusMessage?: string;
	  };
export type AgentsViewPersistentState = {
	selectedRowIdentity?: string;
	backSession?: SessionSummary;
	scopeFrames?: AgentsViewScopeFrame[];
	scopeRootSummary?: SessionSummary;
	selectedSessionKey?: AgentsViewSelectionKey;
	// Ancestor chain to re-expand on return to a nested agent. Kept by sessionId,
	// not row identity, so it survives an active→persisted identity flip.
	pendingExpandedAncestorSessionIds?: string[];
	statusMessage?: string;
	// Gathered once and reused across agents-view instances so the notices survive
	// re-entry and render the moment they resolve, even if the first view was left early.
	startupNotices?: StartupNotices;
	startupNoticesPromise?: Promise<StartupNotices>;
	query?: string;
	savedSessions?: AgentConnectionSavedSessionInfo[];
	lastSuccessfulSavedSessions?: AgentConnectionSavedSessionInfo[];
	lastSuccessfulLiveSummaries?: SessionSummary[];
	savedCatalogGeneration?: number;
	heartbeats?: AgentConnectionHeartbeat[];
};

type PromptCommand = Extract<DaemonCommand, { type: "prompt" }>;
type PendingDeleteAgent = {
	identity: string;
	activeSessionId?: string;
	sessionFile?: string;
	summary: SessionSummary;
	stopped: boolean;
};
type PendingKillSubagent = {
	identity: string;
	rootActiveSessionId: string;
	childId: string;
};

export async function resolveAgentsViewSessionUiServices(
	options: Pick<AgentsViewModeOptions, "createUiServicesForSession" | "uiServices">,
	summary: SessionSummary,
): Promise<InteractiveModeUiServices> {
	return options.createUiServicesForSession ? await options.createUiServicesForSession(summary) : options.uiServices;
}

// Stripping cwd opens the session in its own stored directory; overrideCwd is
// sent when that directory no longer exists so the daemon doesn't reject it.
export function createAgentsViewResumeConfig(
	config: AgentSessionRuntimeConfig,
	overrideCwd?: string,
): AgentSessionRuntimeConfig {
	const resumeConfig: AgentSessionRuntimeConfig = { ...config };
	if (overrideCwd) {
		resumeConfig.cwd = overrideCwd;
	} else {
		delete resumeConfig.cwd;
	}
	return resumeConfig;
}

export function createAgentsViewListCommand(): Extract<DaemonCommand, { type: "list" }> {
	// Omitting `all` returns daemon-resident sessions only; on-disk ones come back
	// through the view's saved-session catalog.
	return { type: "list" };
}

export function resolveAgentsViewActiveSummaryForPath(
	sessionPath: string,
	summaries: readonly SessionSummary[],
): SessionSummary | undefined {
	const selectedPath = resolvePath(canonicalizePath(sessionPath));
	return summaries.find(
		(summary) =>
			summary.activeSessionId !== undefined &&
			summary.sessionFile !== undefined &&
			resolvePath(canonicalizePath(summary.sessionFile)) === selectedPath,
	);
}

// Status messages render in a single-row hint slot below the editor; embedded
// newlines would make that row taller than the layout accounts for and overlap
// the input, so flatten all whitespace runs to single spaces.
export function formatAgentsViewStatusLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function combineAgentsViewStartupNotices(...notices: readonly (string | undefined)[]): string | undefined {
	const formatted = notices
		.map((notice) => (notice ? formatAgentsViewStatusLine(notice) : ""))
		.filter((notice) => notice.length > 0);
	return formatted.length > 0 ? formatted.join(" · ") : undefined;
}

export function shouldReconnectAgentsViewDaemon(reason: DaemonClosingReason | undefined): boolean {
	return reason !== "shutdown";
}

export function createAgentsViewReplyHeadline(text: string | undefined): string | undefined {
	return text
		?.split("\n")
		.map((line) => line.replace(/\s+/g, " ").trim())
		.find((line) => line.length > 0);
}

export function getAgentsViewDepth(scopeRoot: SessionSummary | undefined): number {
	return scopeRoot ? (scopeRoot.rlmDepth ?? 0) + 1 : 0;
}

export function createInitialAgentsViewScopeFrames(
	initialScopeKey: AgentsViewScopeKey | undefined,
	returnChat: SessionSummary | undefined,
): AgentsViewScopeFrame[] {
	if (!initialScopeKey) return [];
	return [
		{
			scope: initialScopeKey,
			...(returnChat?.sessionId === initialScopeKey.sessionId ? { returnChat } : {}),
		},
	];
}

export function createInitialAgentsViewPersistentState(
	options: Pick<AgentsViewModeOptions, "initialScopeKey" | "initialSession">,
): AgentsViewPersistentState {
	const initialSession = options.initialSession;
	return {
		...(initialSession
			? {
					selectedRowIdentity: getSummaryIdentity(initialSession),
					selectedSessionKey: getAgentsViewSelectionKey(initialSession),
					backSession: initialSession,
				}
			: {}),
		...(options.initialScopeKey
			? {
					scopeFrames: createInitialAgentsViewScopeFrames(options.initialScopeKey, initialSession),
					...(initialSession ? { lastSuccessfulLiveSummaries: [initialSession] } : {}),
				}
			: {}),
	};
}

export function createScopeBackReturnChatOpenResult(
	result: Extract<AgentsViewRunResult, { type: "scope_back" }>,
): Extract<AgentsViewRunResult, { type: "open" }> | undefined {
	if (!result.returnChat) return undefined;
	return {
		type: "open",
		summary: result.returnChat,
		expandedAncestorSessionIds: result.expandedAncestorSessionIds,
		hasChildren: result.hasChildren,
	};
}

interface OpenedAgentsViewSession {
	connection: DaemonAgentConnection;
	summary: SessionSummary;
	cwdFallbackNotice?: string;
}

export function resolveAgentsViewOpenCwd(
	summary: SessionSummary,
	fallbackCwd: string | undefined,
): { overrideCwd?: string; notice?: string } {
	if (!summary.cwd || existsSync(summary.cwd) || !fallbackCwd) {
		return {};
	}
	return {
		overrideCwd: fallbackCwd,
		notice: `Original directory is missing (${summary.cwd}); opened in ${fallbackCwd} instead.`,
	};
}

/**
 * The runtime config an agents-view chat uses to (re)create the session from
 * its saved file — the same computation resumeSavedAgentsViewSession performs,
 * shared so the connection's revival fallback recreates with the identical
 * launch context instead of daemon defaults.
 * @internal Exported to pin the revive-config parity without a live daemon.
 */
export function agentsViewSessionRuntimeConfig(
	config: AgentSessionRuntimeConfig,
	summary: SessionSummary,
): AgentSessionRuntimeConfig {
	const { overrideCwd } = resolveAgentsViewOpenCwd(summary, config.cwd);
	return createAgentsViewResumeConfig(config, overrideCwd);
}

async function openAgentsViewSession(
	options: AgentsViewModeOptions,
	summary: SessionSummary,
): Promise<OpenedAgentsViewSession> {
	const socketPath = options.socketPath;
	if (!socketPath) throw new Error("Agents view daemon socket is not configured");
	let client = await connectAgentsViewDaemonClient(socketPath);
	if (summary.activeSessionId) {
		try {
			const connection = await DaemonAgentConnection.attach(client, summary.activeSessionId, {
				closeClientOnDispose: true,
				recoverDaemon: options.recoverDaemon,
				reconnectTimeoutMs: options.reconnectTimeoutMs,
				telemetryDisabled: options.config.telemetryDisabled,
				reviveConfig: agentsViewSessionRuntimeConfig(options.config, summary),
			});
			return { connection, summary };
		} catch (error) {
			client.close();
			if (!summary.sessionFile || !isUnknownActiveSessionError(error)) {
				throw error;
			}
			client = await connectAgentsViewDaemonClient(socketPath);
		}
	}

	if (!summary.sessionFile) {
		client.close();
		throw new Error("Cannot open agent without an active runtime or saved session file");
	}

	try {
		const resumed = await resumeSavedAgentsViewSession(client, options.config, summary);
		const connection = await DaemonAgentConnection.attach(client, resumed.activeSessionId, {
			closeClientOnDispose: true,
			recoverDaemon: options.recoverDaemon,
			reconnectTimeoutMs: options.reconnectTimeoutMs,
			telemetryDisabled: options.config.telemetryDisabled,
			reviveConfig: resumed.reviveConfig,
		});
		return { connection, summary: resumed.summary, cwdFallbackNotice: resumed.cwdFallbackNotice };
	} catch (error) {
		client.close();
		throw error;
	}
}

/**
 * Resume a saved session file into the daemon and return the live summary.
 * The daemon's create-with-sessionPath is idempotent for this client: an
 * already-resident session is reused instead of resumed twice.
 */
async function resumeSavedAgentsViewSession(
	client: DaemonClient,
	config: AgentSessionRuntimeConfig,
	summary: SessionSummary,
): Promise<{
	summary: SessionSummary;
	activeSessionId: string;
	cwdFallbackNotice?: string;
	reviveConfig: AgentSessionRuntimeConfig;
}> {
	if (!summary.sessionFile) {
		throw new Error("Cannot resume a session without a saved session file");
	}
	const { notice } = resolveAgentsViewOpenCwd(summary, config.cwd);
	const resumeConfig = agentsViewSessionRuntimeConfig(config, summary);
	const response = await client.request({
		type: "create",
		config: resumeConfig,
		sessionPath: summary.sessionFile,
	});
	const createdSummary = expectSessionSummary(requireDaemonData(response));
	return {
		summary: createdSummary,
		activeSessionId: getRequiredActiveSessionId(createdSummary),
		cwdFallbackNotice: notice,
		// The connection's revival fallback recreates with the same launch
		// context this resume used.
		reviveConfig: resumeConfig,
	};
}

async function connectAgentsViewDaemonClient(socketPath: string): Promise<DaemonClient> {
	const client = new DaemonClient(socketPath);
	try {
		await client.connect();
		return client;
	} catch (error) {
		client.close();
		throw error;
	}
}

function getRequiredActiveSessionId(summary: SessionSummary): string {
	if (!summary.activeSessionId) {
		throw new Error("Daemon returned a session without an active session id");
	}
	return summary.activeSessionId;
}

function isUnknownActiveSessionError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith("Unknown active session:");
}

export async function runAgentsViewMode(options: AgentsViewModeOptions): Promise<void> {
	const persistentState = createInitialAgentsViewPersistentState(options);
	const promptStashStore = options.promptStashStore ?? new ClientPromptStashStore();

	while (true) {
		const view = new AgentsViewMode(options, persistentState);
		const viewResult = await view.run();
		if (viewResult.type === "exit") return;
		let result: Extract<AgentsViewRunResult, { type: "open" }>;
		if (viewResult.type === "scope_back") {
			persistentState.scopeFrames = transitionAgentsViewScope(persistentState.scopeFrames ?? [], { type: "back" });
			persistentState.scopeRootSummary = undefined;
			persistentState.selectedRowIdentity = getSummaryIdentity(viewResult.selection);
			persistentState.selectedSessionKey = getAgentsViewSelectionKey(viewResult.selection);
			persistentState.pendingExpandedAncestorSessionIds = viewResult.expandedAncestorSessionIds;
			persistentState.query = "";
			const returnChatResult = createScopeBackReturnChatOpenResult(viewResult);
			if (!returnChatResult) continue;
			result = returnChatResult;
		} else {
			result = viewResult;
		}

		const selection = result.selection ?? result.summary;
		persistentState.selectedRowIdentity = getSummaryIdentity(selection);
		persistentState.selectedSessionKey = getAgentsViewSelectionKey(selection);
		persistentState.pendingExpandedAncestorSessionIds = result.expandedAncestorSessionIds;
		if (result.statusMessage) persistentState.statusMessage = result.statusMessage;

		let opened: OpenedAgentsViewSession | undefined;
		try {
			opened = await openAgentsViewSession(options, result.summary);
			persistentState.backSession = opened.summary;
			if (opened.cwdFallbackNotice) {
				persistentState.statusMessage = combineAgentsViewStartupNotices(
					result.statusMessage,
					opened.cwdFallbackNotice,
				);
			}
			const uiServices = await resolveAgentsViewSessionUiServices(options, opened.summary);
			const interactiveMode = new InteractiveMode({
				agentConnection: opened.connection,
				daemonSocketPath: options.socketPath,
				uiServices,
				promptStashStore,
				promptStashSessionId: opened.summary.sessionId,
				bindLocalSessionExtensions: false,
				migratedProviders: options.migratedProviders,
				modelFallbackMessage: resolveAttachModelFallbackMessage(opened.summary, options.modelFallbackMessage),
				startupNotice: combineAgentsViewStartupNotices(result.statusMessage, opened.cwdFallbackNotice),
				verbose: options.verbose,
				returnToAgentsView: true,
				forceFullscreen: true,
				// The agents view renders the global notices itself, so suppress them in-session.
				agentsViewOwnsStartupNotices: true,
				sessionDepth: opened.summary.rlmDepth,
				sessionHasChildren: result.hasChildren,
			});
			try {
				const interactiveResult = await interactiveMode.run();
				const source = interactiveResult.source;
				const returnedSession: SessionSummary = {
					...opened.summary,
					...source,
					id: source.activeSessionId ?? opened.summary.id,
				};
				// Preserve an unattachable child's selection while its parent chat was open.
				if (selection.sessionId === result.summary.sessionId) {
					persistentState.selectedRowIdentity = getSummaryIdentity(returnedSession);
					persistentState.selectedSessionKey = getAgentsViewSelectionKey(returnedSession);
				}
				if (interactiveResult.type === "scoped_agents_view") {
					const nextScope = { sessionId: source.sessionId, activeSessionId: source.activeSessionId };
					persistentState.scopeFrames = transitionAgentsViewScope(persistentState.scopeFrames ?? [], {
						type: "push",
						scope: nextScope,
						returnChat: returnedSession,
					});
					const cachedLiveSummaries = persistentState.lastSuccessfulLiveSummaries ?? [];
					const cachedIndex = cachedLiveSummaries.findIndex(
						(summary) => summary.sessionId === returnedSession.sessionId,
					);
					persistentState.lastSuccessfulLiveSummaries =
						cachedIndex === -1
							? [...cachedLiveSummaries, returnedSession]
							: cachedLiveSummaries.map((summary, index) => (index === cachedIndex ? returnedSession : summary));
					persistentState.scopeRootSummary = undefined;
					persistentState.query = "";
				}
				persistentState.backSession = returnedSession;
			} catch (error) {
				// The session opened fine and then threw while running; label it as a
				// runtime crash so it isn't mixed in with true open failures.
				logClientError("Agent session crashed", error);
				persistentState.statusMessage = formatError("Agent session crashed", error);
				// Tear down the session TUI exactly as a normal back-navigation would
				// (drain input, stop renderer + theme watcher) so it doesn't fight the
				// agents-view UI for the terminal, then drop the daemon connection.
				await interactiveMode.teardownSessionUi({ preserveAltScreen: true });
				await opened.connection.dispose().catch(() => undefined);
			}
		} catch (error) {
			await opened?.connection.dispose().catch(() => undefined);
			logClientError("Failed to open agent", error);
			persistentState.statusMessage = formatError("Failed to open agent", error);
		}
	}
}

const AGENTS_VIEW_COMMAND_NAMES = ["name", "kill"] as const;
export type AgentsViewCommandName = (typeof AGENTS_VIEW_COMMAND_NAMES)[number];
const AGENTS_VIEW_COMMAND_NAME_SET: ReadonlySet<string> = new Set(AGENTS_VIEW_COMMAND_NAMES);

export interface AgentsViewCommand {
	name: AgentsViewCommandName;
	args: string;
}

/** Row-targeted commands the armed composer maps onto existing RPCs. */
export function parseAgentsViewCommand(text: string): AgentsViewCommand | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	if (!AGENTS_VIEW_COMMAND_NAME_SET.has(name)) return undefined;
	return { name: name as AgentsViewCommandName, args: parsed.args };
}

/**
 * Reject recognized built-ins that are neither session-owned nor view
 * commands, so they are never sent to the model as plain prompt text.
 */
export function getReplyComposerCommandRejection(text: string): string | undefined {
	const parsed = parseSlashCommand(text);
	if (!parsed) return undefined;
	const name = resolveBuiltinSlashCommandName(parsed.name);
	if (isSessionSlashCommandName(name)) return undefined;
	if (AGENTS_VIEW_COMMAND_NAME_SET.has(name)) return undefined;
	if (!isBuiltinSlashCommandName(parsed.name)) return undefined;
	return `/${parsed.name} is not available here; open the session to run it`;
}

const AGENTS_VIEW_COMMAND_DESCRIPTIONS: Record<AgentsViewCommandName, { description: string; argumentHint?: string }> =
	{
		name: { description: "Set session display name", argumentHint: "<name>" },
		kill: { description: "Stop this agent's runtime (session stays resumable)" },
	};

function agentsViewSlashCommands(): {
	name: string;
	aliases?: readonly string[];
	description: string;
	argumentHint?: string;
	takesArgument?: boolean;
}[] {
	return AGENTS_VIEW_COMMAND_NAMES.map((name) => {
		const builtin = BUILTIN_SLASH_COMMANDS.find((command) => command.name === name);
		const display = AGENTS_VIEW_COMMAND_DESCRIPTIONS[name];
		return {
			name,
			aliases: builtin?.aliases,
			description: display.description,
			argumentHint: display.argumentHint ?? builtin?.argumentHint,
			takesArgument: name === "name" ? true : builtin?.takesArgument,
		};
	});
}

/** Autocomplete for the reply composer: session-owned plus view commands. */
export function createReplyComposerAutocompleteProvider(cwd: string, fdPath?: string): AutocompleteProvider {
	const sessionCommands = BUILTIN_SLASH_COMMANDS.filter((command) => isSessionSlashCommandName(command.name)).map(
		(command) => ({
			name: command.name,
			aliases: command.aliases,
			description: command.description,
			argumentHint: command.argumentHint,
			takesArgument: command.takesArgument,
		}),
	);
	return new CombinedAutocompleteProvider([...sessionCommands, ...agentsViewSlashCommands()], cwd, fdPath ?? null);
}

export function resolveCurrentReplyTargetSummary(
	records: readonly UnifiedSessionRecord[],
	target: { key: string; summary: SessionSummary },
	findLive: (activeSessionId: string) => SessionSummary | undefined,
): SessionSummary {
	const identity = getSummaryIdentity(target.summary);
	const current = records.find((record) => record.identity === identity || record.identityAliases.includes(identity));
	if (current) return summaryForUnifiedRecord(current);
	const live = target.summary.activeSessionId ? findLive(target.summary.activeSessionId) : undefined;
	if (live) return live;
	// A persisted target missing from the current live catalog can still be
	// resumed from its captured file, but its captured runtime id is stale.
	if (target.summary.sessionFile && target.summary.activeSessionId) {
		return { ...target.summary, activeSessionId: undefined, lifecycle: "archived", activity: "idle" };
	}
	return target.summary;
}

export class AgentsViewMode implements Component, Focusable {
	focused = false;

	private readonly ui: TUI;
	private readonly editor: CustomEditor;
	private readonly splash: BrandSplashHeader;
	private readonly fullscreenDock: Component;
	private readonly keybindings: KeybindingsManager;
	private client: DaemonClient | undefined;
	private unsubscribeClientClose: (() => void) | undefined;
	private unsubscribeClientMessage: (() => void) | undefined;
	private reconnectPromise: Promise<void> | undefined;
	private reconnectTimedOut = false;
	private daemonShutdownReceived = false;
	private resolveRun: ((result: AgentsViewRunResult) => void) | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	private heartbeatPollTimer: NodeJS.Timeout | undefined;
	private animationTimer: NodeJS.Timeout | undefined;
	private ctrlCExitHintExpiresAt = 0;
	private ctrlCExitHintTimer: ReturnType<typeof setTimeout> | undefined;
	private deleteConfirmExpiresAt = 0;
	private deleteConfirmTimer: ReturnType<typeof setTimeout> | undefined;
	private workingIconFrame = 0;
	private rows: AgentsViewRow[] = [];
	private lastListedSummaries: SessionSummary[] = [];
	private lastVisibleSummaries: SessionSummary[] = [];
	private savedSessions: AgentConnectionSavedSessionInfo[] = [];
	private lastSuccessfulSavedSessions: AgentConnectionSavedSessionInfo[] = [];
	private heartbeats: AgentConnectionHeartbeat[] = [];
	private unifiedRecords: UnifiedSessionRecord[] = [];
	private unifiedIndex: UnifiedSessionIndex = buildUnifiedSessionIndex([]);
	private scopedRecords: UnifiedSessionRecord[] = [];
	private scopeKey: AgentsViewScopeKey | undefined;
	private scopeRootSummary: SessionSummary | undefined;
	private liveCatalogReady = false;
	private savedCatalogReady = false;
	private savedCatalogGeneration = 0;
	private liveCatalogGeneration = 0;
	private heartbeatCatalogGeneration = 0;
	private liveCatalogPollPromise: Promise<void> | undefined;
	private liveCatalogRefreshPending = false;
	private savedCatalogRefreshPending = false;
	private expandedSubagentParents = new Set<string>();
	// Agent row identities whose full spawn program is currently shown.
	// The program key toggles each agent shown ↔ hidden.
	private programShownParents = new Set<string>();
	private selectedIndex = 0;
	private selectedRowIdentity: string | undefined;
	private selectedActiveSessionId: string | undefined;
	private selectedSessionKey: AgentsViewSelectionKey | undefined;
	private selectionAnchorPending = false;
	/** Armed reply composer target: a live agent or a saved session to resume on send. */
	private replyTarget: { key: string; summary: SessionSummary } | undefined;
	/** Provider bound to the armed target's cwd for file-path completions. */
	private replyAutocomplete: AutocompleteProvider | undefined;
	private fdPath: string | undefined;
	private creatingNewSession = false;
	private replyLastAssistantText: string | undefined;
	private replyLastAssistantTextLoading = false;
	private replyHeaderTime = "";
	private pendingDeleteAgent: PendingDeleteAgent | undefined;
	private pendingKillSubagent: PendingKillSubagent | undefined;
	private renameTarget: { activeSessionId?: string; sessionFile?: string; summary: SessionSummary } | undefined;
	private actionModeSearchQuery: string | undefined;
	private readonly inactiveAgentIdentities = new Set<string>();
	private statusMessage: string | undefined;
	private statusMessageTone: "muted" | "error" | "warning" = "muted";
	private statusMessageSticky = false;
	private statusMessageTimer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(
		private readonly options: AgentsViewModeOptions,
		private readonly persistentState: AgentsViewPersistentState = {},
	) {
		const initialFrames =
			persistentState.scopeFrames ??
			createInitialAgentsViewScopeFrames(
				options.initialScopeKey,
				persistentState.backSession ?? options.initialSession,
			);
		persistentState.scopeFrames = initialFrames;
		this.scopeKey = initialFrames.at(-1)?.scope;
		this.scopeRootSummary = persistentState.scopeRootSummary;
		this.selectedRowIdentity = persistentState.selectedRowIdentity;
		this.selectedSessionKey = persistentState.selectedSessionKey;
		this.selectedActiveSessionId = persistentState.selectedSessionKey?.activeSessionId;
		this.lastListedSummaries = persistentState.lastSuccessfulLiveSummaries ?? [];
		this.savedSessions = persistentState.savedSessions ?? [];
		this.lastSuccessfulSavedSessions = persistentState.lastSuccessfulSavedSessions ?? this.savedSessions;
		this.savedCatalogReady = persistentState.lastSuccessfulSavedSessions !== undefined;
		this.heartbeats = persistentState.heartbeats ?? [];
		this.savedCatalogGeneration = persistentState.savedCatalogGeneration ?? 0;
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		setRegisteredThemes(options.uiServices.getThemes());
		initTheme(options.uiServices.settingsManager.getTheme(), true);

		this.ui = new TUI(new ProcessTerminal(), options.uiServices.settingsManager.getShowHardwareCursor());
		this.ui.setClearOnShrink(options.uiServices.settingsManager.getClearOnShrink());
		this.ui.terminal.setTitle(`${APP_TITLE} - Agents`);
		this.editor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: options.uiServices.settingsManager.getEditorPaddingX(),
			autocompleteMaxVisible: options.uiServices.settingsManager.getAutocompleteMaxVisible(),
			placeholder: SEARCH_PROMPT_PLACEHOLDER,
			placeholderColor: (text) => theme.fg("dim", text),
		});
		void ensureTool("fd").then((fdPath) => {
			this.fdPath = fdPath;
			// Rebind an already-armed provider so @-completion picks up fd.
			if (this.replyTarget) {
				this.replyAutocomplete = createReplyComposerAutocompleteProvider(this.replyTarget.summary.cwd, fdPath);
			}
		});
		// Search input never autocompletes; only the armed composer's provider answers.
		this.editor.setAutocompleteProvider({
			getSuggestions: async (lines, cursorLine, cursorCol, suggestOptions) => {
				if (!this.replyTarget) return null;
				return this.replyAutocomplete?.getSuggestions(lines, cursorLine, cursorCol, suggestOptions) ?? null;
			},
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
				this.replyAutocomplete?.applyCompletion(lines, cursorLine, cursorCol, item, prefix) ?? {
					lines,
					cursorLine,
					cursorCol,
				},
		});
		this.editor.focused = true;
		this.editor.getHeaderLine = () => this.renderReplyHeaderLine();
		this.editor.onSubmit = (value) => {
			void this.submit(value);
		};
		this.editor.setText(persistentState.query ?? "");
		this.editor.onCtrlD = () => {
			this.finish({ type: "exit" });
		};
		this.editor.onAgentsBack = () => {
			if (this.replyTarget) {
				this.setReplyTarget(undefined);
				return true;
			}
			if (this.editor.getText().length > 0) return false;
			const ancestors = this.scopeKey
				? getUnifiedSessionAncestorSessionIds(this.unifiedRecords, this.scopeKey, this.unifiedIndex)
				: [];
			const scopeRoot = this.scopeRootSummary;
			const result = resolveAgentsViewLeftResult(
				scopeRoot,
				ancestors,
				this.persistentState.scopeFrames?.at(-1)?.returnChat,
			);
			if (result && scopeRoot) {
				this.finish({
					...result,
					hasChildren: hasUnifiedSessionChildren(
						this.unifiedRecords,
						getAgentsViewSelectionKey(scopeRoot),
						this.unifiedIndex,
					),
				});
			}
			// Global view has no hierarchy parent: consume Left without opening chat.
			return true;
		};
		this.editor.onEscape = () => {
			if (this.replyTarget) {
				this.setReplyTarget(undefined);
			} else if (this.editor.getText().length > 0) {
				this.setSearchQuery("");
			} else {
				const backSession = this.persistentState.backSession;
				this.finish(
					backSession
						? {
								type: "open",
								summary: backSession,
								hasChildren: hasUnifiedSessionChildren(
									this.unifiedRecords,
									getAgentsViewSelectionKey(backSession),
									this.unifiedIndex,
								),
							}
						: { type: "exit" },
				);
			}
		};
		this.fullscreenDock = {
			render: (width) => this.renderDock(width),
			invalidate: () => {
				this.editor.invalidate();
			},
		};
		this.splash = new BrandSplashHeader(
			VERSION,
			() => this.getSplashModelId(),
			() => this.getSplashCwd(),
			undefined,
			{
				topPadding: true,
				getExtraMetadata: () => {
					const root = this.scopeRootSummary;
					return [
						{ label: "agents", value: this.getAgentCountsText() },
						{ label: "scope", value: root ? getAgentsViewSessionTitle(root) : "global" },
						{ label: "depth", value: String(getAgentsViewDepth(root)) },
					];
				},
			},
		);
	}

	async run(): Promise<AgentsViewRunResult> {
		this.client = new DaemonClient(this.requireSocketPath());
		await this.client.connect();
		this.subscribeToClientClose(this.client);
		this.unsubscribeClientMessage = this.client.onMessage((message) => {
			if (message.type === "heartbeats_changed") void this.refreshHeartbeats();
		});

		this.ui.addChild(this);
		this.ui.setFocus(this);
		this.ui.start();
		this.ui.enterFullscreen({
			scroll: [this],
			dock: this.fullscreenDock,
			mouse: false,
			viewportControls: false,
		});
		const startupStatusMessage = this.persistentState.statusMessage;
		this.persistentState.statusMessage = undefined;
		if (startupStatusMessage) {
			this.setStatusMessage(startupStatusMessage, { render: false });
		}
		this.ui.requestRender(true);
		onThemeChange(() => {
			this.ui.invalidate();
			this.ui.requestRender();
		});

		const runPromise = new Promise<AgentsViewRunResult>((resolve) => {
			this.resolveRun = resolve;
		});
		void this.refreshSessions();
		void this.refreshSavedSessions();
		void this.refreshHeartbeats();
		this.loadStartupNotices();
		this.pollTimer = setInterval(() => this.pollSessions(), POLL_INTERVAL_MS);
		this.pollTimer.unref?.();
		this.heartbeatPollTimer = setInterval(() => void this.refreshHeartbeats(), HEARTBEAT_POLL_INTERVAL_MS);
		this.heartbeatPollTimer.unref?.();
		this.animationTimer = setInterval(() => {
			if (!this.rows.some((row) => row.section === "running")) return;
			this.workingIconFrame += 1;
			this.ui.requestRender();
		}, WORKING_ICON_INTERVAL_MS);
		this.animationTimer.unref?.();

		return runPromise;
	}

	handleInput(data: string): void {
		this.clearStickyStatusMessage();
		if (this.renameTarget) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.editor.handleInput(data);
			return;
		}
		if (this.keybindings.matches(data, "app.clear")) {
			// The composer hints advertise ctrl+c as cancel; it must not start the exit flow.
			if (this.replyTarget) {
				this.setReplyTarget(undefined);
				return;
			}
			this.handleCtrlC();
			return;
		}
		if (this.editor.getText().length === 0 && this.keybindings.matches(data, "app.agents.rename")) {
			this.enterRenameMode();
			return;
		}
		if (this.editor.getText().length === 0 && this.keybindings.matches(data, "app.agents.delete")) {
			this.clearCtrlCExitHint({ render: false });
			void this.handleDeleteSelected();
			return;
		}
		this.clearCtrlCExitHint({ render: false });
		this.clearDeleteConfirmation({ render: false });
		if (this.keybindings.matches(data, "app.agents.reply") && this.editor.getText().length === 0) {
			void this.toggleReplyTarget();
			return;
		}
		if (!this.replyTarget && this.keybindings.matches(data, "app.agents.new")) {
			void this.createNewSession();
			return;
		}
		if (this.replyTarget && this.keybindings.matches(data, "app.message.followUp")) {
			this.handleReplyFollowUp();
			return;
		}
		if (this.editor.getText().length === 0 && this.keybindings.matches(data, "app.agents.program")) {
			this.cycleProgramForSelected();
			return;
		}
		if (!this.replyTarget && this.keybindings.matches(data, "app.agents.open")) {
			if (this.editor.getText().length === 0 || this.isSearchCursorAtEnd()) {
				this.openSelected();
				return;
			}
		}
		if (!this.replyTarget && this.handleListNavigation(data)) {
			return;
		}
		const previous = this.editor.getText();
		this.editor.handleInput(data);
		if (!this.replyTarget && this.editor.getText() !== previous) {
			this.queryChanged();
		}
	}

	private isSearchCursorAtEnd(): boolean {
		const lines = this.editor.getLines();
		const cursor = this.editor.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line]?.length ?? 0);
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const height = this.contentHeight(safeWidth);
		const lines = this.renderContent(safeWidth, height).slice(0, height);
		while (lines.length < height) {
			lines.push("");
		}
		return lines.slice(0, height).map((line) => this.finalizeRenderedLine(line, safeWidth));
	}

	invalidate(): void {
		this.editor.invalidate();
		this.splash.invalidate();
	}

	private renderContent(width: number, height: number): string[] {
		if (height <= 0) {
			return [];
		}
		const headerLines = this.splash.render(width);
		const noticeLines = this.renderStartupNotices(width);
		if (noticeLines.length > 0) {
			headerLines.push("", ...noticeLines);
		}
		headerLines.push("");

		// The prompt belongs to the scroll pane rather than the fullscreen dock, but
		// it must remain usable when a short viewport or wrapped notices exhaust the
		// header. Trim optional header chrome first and reserve one session-list row.
		const promptLines = this.renderPrompt(width);
		const listGap = height >= promptLines.length + 2 ? 1 : 0;
		const headerRows = Math.max(0, height - promptLines.length - listGap - 1);
		const lines = headerLines.slice(0, headerRows);
		lines.push(...promptLines);
		if (listGap > 0) lines.push("");
		const listRows = Math.max(0, height - lines.length);
		lines.push(...this.renderSessionRows(width, listRows));
		return lines;
	}

	private loadStartupNotices(): void {
		// Notices live on persistentState (read directly in renderStartupNotices), so they
		// survive leaving and re-entering the agents view regardless of which instance's
		// gather resolved. Already have them? Nothing to do.
		if (this.persistentState.startupNotices) {
			return;
		}
		// Reuse an in-flight gather from an earlier agents-view instance so re-entry does
		// not re-run the checks or lose a result that resolved meanwhile.
		const promise =
			this.persistentState.startupNoticesPromise ??
			gatherStartupNotices({
				version: VERSION,
				cwd: this.options.uiServices.getInitialCwd(),
				agentDir: getAgentDir(),
				settingsManager: this.options.uiServices.settingsManager,
			});
		this.persistentState.startupNoticesPromise = promise;
		void promise
			.then((notices) => {
				this.persistentState.startupNotices = notices;
				// Best-effort immediate paint; a re-entered instance also picks this up on
				// its next poll tick since render reads persistentState directly.
				this.ui.requestRender();
			})
			.catch(() => {});
	}

	private renderStartupNotices(width: number): string[] {
		const notices = this.persistentState.startupNotices;
		if (!notices) {
			return [];
		}
		const formatted: string[] = [];
		if (notices.newVersion) {
			formatted.push(formatUpdateAvailableNotice(notices.newVersion));
		}
		if (notices.packageUpdates.length > 0) {
			formatted.push(formatPackageUpdateNotice(notices.packageUpdates));
		}
		if (notices.tmuxWarning) {
			formatted.push(formatTmuxWarningNotice(notices.tmuxWarning));
		}
		// Match the splash header's one-column gutter and wrap so long notices
		// (e.g. the tmux fix instructions) stay readable instead of truncating.
		const wrapWidth = Math.max(1, width - 1);
		return formatted.flatMap((line) => wrapTextWithAnsi(line, wrapWidth).map((wrapped) => ` ${wrapped}`));
	}

	private handleListNavigation(data: string): boolean {
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-Math.max(1, this.visibleListRows()));
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(Math.max(1, this.visibleListRows()));
			return true;
		}
		return false;
	}

	private handleCtrlC(): void {
		if (this.isCtrlCExitHintVisible()) {
			this.finish({ type: "exit" });
			return;
		}
		this.showCtrlCExitHint();
	}

	private showCtrlCExitHint(): void {
		if (this.ctrlCExitHintTimer) {
			clearTimeout(this.ctrlCExitHintTimer);
		}
		this.ctrlCExitHintExpiresAt = Date.now() + EXIT_HINT_DURATION_MS;
		this.ctrlCExitHintTimer = setTimeout(() => {
			this.ctrlCExitHintTimer = undefined;
			if (!this.isCtrlCExitHintVisible()) {
				this.ctrlCExitHintExpiresAt = 0;
				this.ui.requestRender();
			}
		}, EXIT_HINT_DURATION_MS);
		this.ctrlCExitHintTimer.unref?.();
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
			this.ui.requestRender();
		}
	}

	private isCtrlCExitHintVisible(): boolean {
		return this.ctrlCExitHintExpiresAt > Date.now();
	}

	private showDeleteConfirmation(): void {
		if (this.deleteConfirmTimer) {
			clearTimeout(this.deleteConfirmTimer);
		}
		this.deleteConfirmExpiresAt = Date.now() + DELETE_CONFIRM_DURATION_MS;
		this.deleteConfirmTimer = setTimeout(() => {
			this.deleteConfirmTimer = undefined;
			if (!this.isDeleteConfirmationVisible()) {
				this.deleteConfirmExpiresAt = 0;
				this.ui.requestRender();
			}
		}, DELETE_CONFIRM_DURATION_MS);
		this.deleteConfirmTimer.unref?.();
		this.ui.requestRender();
	}

	private clearDeleteConfirmation(options: { render?: boolean } = {}): void {
		this.pendingKillSubagent = undefined;
		if (!this.deleteConfirmTimer && this.deleteConfirmExpiresAt === 0) {
			return;
		}
		if (this.deleteConfirmTimer) {
			clearTimeout(this.deleteConfirmTimer);
			this.deleteConfirmTimer = undefined;
		}
		this.deleteConfirmExpiresAt = 0;
		if (options.render !== false) {
			this.ui.requestRender();
		}
	}

	private isDeleteConfirmationVisible(): boolean {
		return this.deleteConfirmExpiresAt > Date.now();
	}

	private setStatusMessage(
		message: string | undefined,
		options: { render?: boolean; tone?: "muted" | "error" | "warning"; sticky?: boolean } = {},
	): void {
		const statusLine = message === undefined ? undefined : formatAgentsViewStatusLine(message);
		if (this.statusMessageTimer) {
			clearTimeout(this.statusMessageTimer);
			this.statusMessageTimer = undefined;
		}
		this.statusMessage = statusLine;
		// Errors come both from explicit tones and from formatError-style messages.
		this.statusMessageTone = options.tone ?? (statusLine?.startsWith("Failed") ? "error" : "muted");
		// Sticky messages stay up until the next keypress instead of a timer.
		this.statusMessageSticky = options.sticky === true && statusLine !== undefined;
		if (statusLine && !this.statusMessageSticky) {
			this.statusMessageTimer = setTimeout(() => {
				this.statusMessageTimer = undefined;
				if (this.statusMessage === statusLine) {
					this.statusMessage = undefined;
					this.ui.requestRender();
				}
			}, STATUS_MESSAGE_DURATION_MS);
			this.statusMessageTimer.unref?.();
		}
		if (options.render !== false) {
			this.ui.requestRender();
		}
	}

	/** Sticky messages (e.g. billing warnings) stay until the user acknowledges them with any keypress. */
	private clearStickyStatusMessage(): void {
		if (!this.statusMessageSticky || this.daemonShutdownReceived || this.reconnectPromise) {
			return;
		}
		this.statusMessageSticky = false;
		this.statusMessage = undefined;
		this.ui.requestRender();
	}

	private moveSelection(delta: number): void {
		const selectableIndexes = this.getSelectableRowIndexes();
		if (selectableIndexes.length === 0) {
			return;
		}
		const currentPosition = selectableIndexes.includes(this.selectedIndex)
			? selectableIndexes.indexOf(this.selectedIndex)
			: 0;
		const nextPosition = Math.max(0, Math.min(selectableIndexes.length - 1, currentPosition + delta));
		this.selectedIndex = selectableIndexes[nextPosition] ?? 0;
		this.collapseSubagentListsOutsideSelection();
		this.syncSelectedRowState();
		this.clearDeleteConfirmation({ render: false });
		// Reply stays armed only while the selection sits on the agent row it
		// targets; nested rows share the parent's session id but are read-only.
		const selectedRow = this.rows[this.selectedIndex];
		if (
			this.replyTarget &&
			(selectedRow?.kind !== "agent" || this.replyTarget.key !== this.selectedActiveSessionId)
		) {
			this.setReplyTarget(undefined);
		}
		this.ui.requestRender();
	}

	// Resolve the persisted sessionId breadcrumb to live row identities once, so
	// the rest of the expansion lifecycle stays uniformly identity-keyed.
	private applyPendingAncestorExpansion(): void {
		const sessionIds = this.persistentState.pendingExpandedAncestorSessionIds;
		if (!sessionIds || sessionIds.length === 0) {
			this.persistentState.pendingExpandedAncestorSessionIds = undefined;
			return;
		}
		this.persistentState.pendingExpandedAncestorSessionIds = undefined;
		const wanted = new Set(sessionIds);
		// A nested ancestor's row only appears once its own parent is expanded, so
		// expand-and-rebuild until a pass reveals nothing new.
		let added = true;
		while (added) {
			added = false;
			for (const row of this.rows) {
				if (wanted.has(row.summary.sessionId) && !this.expandedSubagentParents.has(row.identity)) {
					this.expandedSubagentParents.add(row.identity);
					added = true;
				}
			}
			if (added) {
				this.rebuildRows();
			}
		}
	}

	/** Expanded subagent lists collapse back to their summary row once selection leaves them. */
	private collapseSubagentListsOutsideSelection(): void {
		if (this.expandedSubagentParents.size === 0) {
			return;
		}
		const keep = new Set<string>();
		const selectedRow = this.rows[this.selectedIndex];
		// Selecting the expanded agent itself still counts as inside its list;
		// only moving past the block (above the parent or below the last child)
		// collapses it.
		if (selectedRow && this.expandedSubagentParents.has(selectedRow.identity)) {
			keep.add(selectedRow.identity);
		}
		let parentIdentity = selectedRow?.parentIdentity;
		while (parentIdentity !== undefined && !keep.has(parentIdentity)) {
			keep.add(parentIdentity);
			const target: string = parentIdentity;
			parentIdentity = this.rows.find((row) => row.identity === target)?.parentIdentity;
		}
		const next = new Set([...this.expandedSubagentParents].filter((identity) => keep.has(identity)));
		if (next.size === this.expandedSubagentParents.size) {
			return;
		}
		this.expandedSubagentParents = next;
		// A collapsed agent's revealed program collapses with it, so reopening
		// starts from the hidden state rather than a stale reveal.
		for (const identity of [...this.programShownParents]) {
			if (!next.has(identity)) {
				this.programShownParents.delete(identity);
			}
		}
		this.rebuildRows();
	}

	private setSearchQuery(query: string): void {
		this.editor.setText(query);
		this.queryChanged();
	}

	private queryChanged(): void {
		this.persistentState.query = this.editor.getText();
		this.rebuildRows();
		// Typing must not claim the visible fallback row while the restored
		// anchor is still waiting for its catalog row.
		if (!this.selectionAnchorPending) this.syncSelectedRowState();
		this.ui.requestRender();
	}

	private getFilteredRecords(): UnifiedSessionRecord[] {
		const query = this.replyTarget || this.renameTarget ? (this.actionModeSearchQuery ?? "") : this.editor.getText();
		return filterUnifiedSessions(this.scopedRecords, (text) => matchesSearchText(text, query));
	}

	/** Rebuild rows from the last fetched summaries, keeping selection on the same row. */
	private rebuildRows(): void {
		const selectedIdentity = this.rows[this.selectedIndex]?.identity;
		this.rows = buildAgentsViewRows(
			this.getFilteredRecords(),
			this.expandedSubagentParents,
			this.programShownParents,
			this.scopeKey,
		);
		const index =
			selectedIdentity === undefined ? -1 : this.rows.findIndex((row) => row.identity === selectedIdentity);
		if (index >= 0) {
			this.selectedIndex = index;
		} else {
			this.restoreSelection();
		}
	}

	private async submit(value: string, delivery: "steer" | "followUp" = "steer"): Promise<void> {
		if (this.renameTarget) {
			await this.confirmRename(value);
			return;
		}
		if (this.replyTarget) {
			const target = this.replyTarget;
			const text = value.trim();
			const viewCommand = parseAgentsViewCommand(text);
			if (viewCommand) {
				// Stale summaries mis-route the RPCs after a runtime replacement.
				const currentSummary = resolveCurrentReplyTargetSummary(
					this.unifiedRecords ?? [],
					target,
					(activeSessionId) => this.findSummaryByActiveSessionId(activeSessionId),
				);
				const succeeded = await this.runAgentsViewCommand(viewCommand, currentSummary);
				if (!succeeded && this.replyTarget === target && this.editor.getText().length === 0) {
					this.editor.setText(value);
				}
				return;
			}
			const rejection = getReplyComposerCommandRejection(text);
			if (rejection) {
				// submitValue cleared the buffer before onSubmit; keep the draft.
				if (this.editor.getText().length === 0) this.editor.setText(value);
				this.setStatusMessage(rejection, { tone: "warning" });
				return;
			}
			if (text) {
				this.editor.setText("");
				const sent = await this.sendReply(target, text, delivery);
				if (sent) {
					if (this.replyTarget === target && this.editor.getText().length === 0) {
						this.setReplyTarget(undefined);
					}
					// Keep the send outcome (or sticky cwd notice) that sendReply just surfaced.
					await this.refreshSessions({ preserveStatusOnError: true });
				} else if (this.replyTarget === target && this.editor.getText().length === 0) {
					this.editor.setText(value);
				}
			}
			return;
		}
		// Search text is never a prompt or a command; Enter opens the selection.
		this.openSelected();
	}

	/** Alt+Enter in the reply composer queues the reply as a follow-up. */
	private handleReplyFollowUp(): void {
		if (!this.replyTarget) return;
		// Unlike Enter, this path skips submitValue, so expand paste markers here.
		const text = this.editor.getExpandedText();
		if (!text.trim()) return;
		void this.submit(text, "followUp");
	}

	private getSavedSessionCwd(): string {
		return this.options.config.cwd ?? this.options.uiServices.getInitialCwd();
	}

	private getSavedSessionCatalogContext(): DaemonSavedSessionCatalogContext {
		return { cwd: this.getSavedSessionCwd(), sessionDir: this.options.config.sessionDir };
	}

	private openSelected(): void {
		const row = this.rows[this.selectedIndex];
		if (!row?.selectable || this.isPendingDeleteRow(row)) {
			return;
		}
		if (this.selectionAnchorPending) {
			this.setStatusMessage("Waiting for the selected session to load");
			return;
		}
		if (row.kind === "subagent-summary") {
			this.expandSubagentList(row);
			return;
		}
		if (row.kind === "subagent") {
			this.openSelectedSubagent(row);
			return;
		}
		if (!row.summary.activeSessionId && !row.summary.sessionFile) {
			this.setStatusMessage("Cannot open agent without an active runtime or saved session file");
			return;
		}
		this.finish({
			type: "open",
			summary: row.summary,
			hasChildren: hasUnifiedSessionChildren(
				this.unifiedRecords,
				getAgentsViewSelectionKey(row.summary),
				this.unifiedIndex,
			),
		});
	}

	private expandSubagentList(row: AgentsViewRow): void {
		if (!row.parentIdentity) {
			return;
		}
		this.expandedSubagentParents.add(row.parentIdentity);
		this.rebuildRows();
		const firstChild = this.rows.findIndex(
			(candidate) => candidate.kind === "subagent" && candidate.parentIdentity === row.parentIdentity,
		);
		if (firstChild >= 0) {
			this.selectedIndex = firstChild;
		}
		this.syncSelectedRowState();
		this.ui.requestRender();
	}

	/**
	 * Toggle the full spawn program for the agent owning the selected row:
	 * one press shows it, another hides it. The subagent list is expanded as
	 * needed so the code sits directly above the subagents it launched.
	 */
	private cycleProgramForSelected(): void {
		const row = this.rows[this.selectedIndex];
		if (!row) {
			return;
		}
		const target = row.kind === "agent" ? row.identity : row.parentIdentity;
		if (!target) {
			return;
		}
		if (!this.targetHasSpawnCode(target)) {
			this.setStatusMessage("No program recorded for these subagents");
			return;
		}
		// Code only renders inside an expanded subagent list, so reveal it too.
		this.expandedSubagentParents.add(target);
		if (this.programShownParents.has(target)) {
			this.programShownParents.delete(target);
		} else {
			this.programShownParents.add(target);
		}
		const prevIdentity = row.identity;
		this.rebuildRows();
		// The collapsed summary row vanishes once expanded; keep a sane selection.
		if (this.rows[this.selectedIndex]?.identity !== prevIdentity) {
			const agentIndex = this.rows.findIndex((candidate) => candidate.identity === target);
			if (agentIndex >= 0) {
				this.selectedIndex = agentIndex;
			}
		}
		this.syncSelectedRowState();
		this.ui.requestRender();
	}

	/** Whether any subagent under the given agent identity carries spawn code. */
	private targetHasSpawnCode(target: string): boolean {
		for (const row of this.rows) {
			if (row.parentIdentity !== target) {
				continue;
			}
			if (row.kind === "subagent-summary") {
				return row.hasSpawnCode === true;
			}
			if (row.kind === "subagent" && rowHasSpawnCode(row)) {
				return true;
			}
		}
		return false;
	}

	/** True when the selected row exposes the "show program" affordance. */
	private selectedRowCanShowProgram(): boolean {
		const row = this.rows[this.selectedIndex];
		if (!row) {
			return false;
		}
		const target = row.kind === "agent" ? row.identity : row.parentIdentity;
		return target !== undefined && this.targetHasSpawnCode(target);
	}

	private openSelectedSubagent(row: AgentsViewRow): void {
		const expandedAncestorSessionIds = this.collectSubagentAncestorSessionIds(row);
		if (row.summary.activeSessionId || row.summary.sessionFile) {
			this.finish({
				type: "open",
				summary: row.summary,
				expandedAncestorSessionIds,
				hasChildren: hasUnifiedSessionChildren(
					this.unifiedRecords,
					getAgentsViewSelectionKey(row.summary),
					this.unifiedIndex,
				),
			});
			return;
		}
		const root = this.findSubagentRootRow(row);
		if (!root || !(root.summary.activeSessionId || root.summary.sessionFile)) {
			this.setStatusMessage("Cannot open agent without an active runtime or saved session file");
			return;
		}
		this.finish(
			createUnattachableChildOpenResult(
				row.summary,
				root.summary,
				expandedAncestorSessionIds,
				hasUnifiedSessionChildren(this.unifiedRecords, getAgentsViewSelectionKey(root.summary), this.unifiedIndex),
			),
		);
	}

	/** Session ids of every ancestor of a subagent row, root-most first. */
	private collectSubagentAncestorSessionIds(row: AgentsViewRow): string[] {
		const ancestors: string[] = [];
		let parentIdentity = row.parentIdentity;
		while (parentIdentity !== undefined) {
			const parent = this.rows.find((candidate) => candidate.identity === parentIdentity);
			if (!parent) {
				break;
			}
			ancestors.unshift(parent.summary.sessionId);
			parentIdentity = parent.parentIdentity;
		}
		return ancestors;
	}

	/**
	 * The whole subagent tree belongs to the root agent's session, so nested
	 * subagents also resolve to their top-level ancestor.
	 */
	private findSubagentRootRow(row: AgentsViewRow): AgentsViewRow | undefined {
		let root = this.rows.find((candidate) => candidate.identity === row.parentIdentity);
		while (root && root.kind !== "agent") {
			const parentIdentity = root.parentIdentity;
			root = this.rows.find((candidate) => candidate.identity === parentIdentity);
		}
		return root;
	}

	private async toggleReplyTarget(): Promise<void> {
		const selectedRow = this.rows[this.selectedIndex];
		// Subagents are read-only; replying is reserved for top-level agents.
		if (selectedRow?.kind !== "agent") {
			return;
		}
		const summary = selectedRow.summary;
		// Live agents reply directly; saved sessions are resumed when the reply is
		// sent. Rows with neither runtime nor file have nothing to receive a prompt.
		if (!summary.activeSessionId && !summary.sessionFile) {
			return;
		}
		if (this.pendingDeleteAgent?.identity === getSelectedRowIdentity(selectedRow)) {
			return;
		}
		const key = summary.activeSessionId ?? summary.id;
		if (this.replyTarget?.key === key) {
			this.setReplyTarget(undefined);
			return;
		}
		this.setReplyTarget({ key, summary });
		if (!summary.activeSessionId) {
			// Inactive sessions have no live transcript endpoint; the persisted recap
			// (or opener) is the best preview and needs no daemon round-trip.
			this.replyLastAssistantText = summary.summary ?? summary.firstMessage;
			this.ui.requestRender();
			return;
		}
		const activeSessionId = summary.activeSessionId;
		this.replyLastAssistantTextLoading = true;
		try {
			const latestAssistantText = await this.getLastAssistantText(activeSessionId);
			if (this.replyTarget?.key === key) {
				this.replyLastAssistantText = latestAssistantText;
				this.replyLastAssistantTextLoading = false;
				this.ui.requestRender();
			}
		} catch (error) {
			if (this.replyTarget?.key === key) {
				this.replyLastAssistantTextLoading = false;
				this.setStatusMessage(formatError("Failed to load latest response", error));
			}
		}
	}

	private setReplyTarget(target: { key: string; summary: SessionSummary } | undefined): void {
		if (target && !this.replyTarget) {
			this.actionModeSearchQuery = this.editor.getText();
			this.editor.setText("");
		} else if (!target && this.replyTarget) {
			this.editor.setText(this.actionModeSearchQuery ?? this.persistentState.query ?? "");
			this.actionModeSearchQuery = undefined;
		}
		this.replyTarget = target;
		this.replyAutocomplete = target
			? createReplyComposerAutocompleteProvider(target.summary.cwd, this.fdPath)
			: undefined;
		this.replyLastAssistantText = undefined;
		this.replyLastAssistantTextLoading = false;
		this.replyHeaderTime = target
			? formatAgentsViewRelativeTime(target.summary.modified ?? target.summary.created)
			: "";
		this.editor.setPlaceholder(
			target
				? target.summary.activeSessionId
					? REPLY_PROMPT_FALLBACK_PLACEHOLDER
					: RESUME_PROMPT_PLACEHOLDER
				: SEARCH_PROMPT_PLACEHOLDER,
		);
		if (!target) this.rebuildRows();
		this.ui.requestRender();
	}

	private enterRenameMode(): void {
		const row = this.rows[this.selectedIndex];
		// Only top-level agents carry a renameable session; subagents do not.
		if (row?.kind !== "agent" || !row.selectable) {
			return;
		}
		const activeSessionId = row.summary.activeSessionId;
		const sessionFile = row.summary.sessionFile;
		if (!activeSessionId && !sessionFile) {
			this.setStatusMessage("This session cannot be renamed");
			return;
		}
		this.setReplyTarget(undefined);
		this.actionModeSearchQuery = this.editor.getText();
		this.pendingDeleteAgent = undefined;
		this.pendingKillSubagent = undefined;
		this.renameTarget = { activeSessionId, sessionFile, summary: row.summary };
		this.editor.setPlaceholder("Name this agent session");
		this.editor.setText(row.summary.sessionName ?? "");
		this.ui.requestRender();
	}

	private exitRenameMode(): void {
		this.renameTarget = undefined;
		this.editor.setText(this.actionModeSearchQuery ?? this.persistentState.query ?? "");
		this.actionModeSearchQuery = undefined;
		this.editor.setPlaceholder(SEARCH_PROMPT_PLACEHOLDER);
		this.rebuildRows();
		this.ui.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const target = this.renameTarget;
		if (!target) {
			return;
		}
		const name = value.trim();
		if (!name) {
			this.exitRenameMode();
			return;
		}
		this.exitRenameMode();
		await this.renameSession(target.summary, name);
	}

	/** Shared by rename mode and /name: rename, refresh both catalogs, report. */
	private async renameSession(summary: SessionSummary, name: string): Promise<boolean> {
		this.setStatusMessage("Renaming agent...");
		try {
			if (summary.activeSessionId) {
				requireDaemonData(
					await this.requireClient().request({ type: "rename", activeSessionId: summary.activeSessionId, name }),
				);
			} else if (summary.sessionFile) {
				await renameDaemonSavedSession(
					this.requireClient(),
					this.getSavedSessionCatalogContext(),
					summary.sessionFile,
					name,
				);
			} else {
				this.setStatusMessage("This session cannot be renamed", { tone: "warning" });
				return false;
			}
			const refreshed = await this.refreshBothCatalogs();
			this.setStatusMessage(refreshed ? `Renamed to ${name}` : `Renamed to ${name}; refresh failed`);
			return true;
		} catch (error) {
			this.setStatusMessage(
				isUnknownDaemonCommandError(error, "rename")
					? "Failed to rename: the daemon is running an older build; restart the daemon and try again"
					: formatError("Failed to rename agent", error),
			);
			return false;
		}
	}

	private findSummaryByActiveSessionId(activeSessionId: string): SessionSummary | undefined {
		return this.rows.find((row) => (row.summary.activeSessionId ?? row.summary.id) === activeSessionId)?.summary;
	}

	private renderReplyHeaderLine(): string | undefined {
		if (this.renameTarget) {
			return theme.fg("warning", "Rename agent session");
		}
		if (!this.replyTarget) {
			return undefined;
		}
		const headline =
			createAgentsViewReplyHeadline(this.replyLastAssistantText) ??
			theme.fg("dim", this.replyLastAssistantTextLoading ? "Loading last response..." : "No response yet");
		return this.replyHeaderTime ? `${theme.fg("warning", this.replyHeaderTime)} ${headline}` : headline;
	}

	private async getLastAssistantText(activeSessionId: string): Promise<string | undefined> {
		const response = await this.requireClient().request({
			type: "get_last_assistant_text",
			activeSessionId,
		});
		const data = requireDaemonData(response);
		if (!isRecord(data)) {
			throw new Error("Daemon returned an invalid last assistant response");
		}
		if (data.text === null || data.text === undefined) {
			return undefined;
		}
		if (typeof data.text !== "string") {
			throw new Error("Daemon returned an invalid last assistant response");
		}
		return data.text;
	}

	private async sendReply(
		target: { key: string; summary: SessionSummary },
		text: string,
		delivery: "steer" | "followUp" = "steer",
	): Promise<boolean> {
		const currentSummary = resolveCurrentReplyTargetSummary(this.unifiedRecords ?? [], target, (activeSessionId) =>
			this.findSummaryByActiveSessionId(activeSessionId),
		);
		let activeSessionId = currentSummary.activeSessionId;
		let liveSummary = activeSessionId ? currentSummary : undefined;
		let cwdFallbackNotice: string | undefined;
		let resumedReviveConfig: AgentSessionRuntimeConfig | undefined;
		let didResume = false;
		try {
			if (!activeSessionId) {
				// Saved session: resume it into the daemon first, then deliver the
				// prompt through the same path as a live reply.
				this.setStatusMessage("Resuming session...");
				const resumed = await resumeSavedAgentsViewSession(
					this.requireClient(),
					this.options.config,
					currentSummary,
				);
				activeSessionId = resumed.activeSessionId;
				didResume = true;
				// The rows are still pre-resume; the fresh summary is the authoritative
				// streaming state for scheduling the prompt.
				liveSummary = resumed.summary;
				cwdFallbackNotice = resumed.cwdFallbackNotice;
				// The config the resume just created with (including any fallback
				// cwd for a missing recorded directory) also governs a revival of
				// the delivery connection.
				resumedReviveConfig = resumed.reviveConfig;
				this.inactiveAgentIdentities.delete(getSummaryIdentity(target.summary));
				// The resume and delivery still belong to this submission, but selection
				// belongs to the current composer. Do not steal it after cancellation.
				if (this.replyTarget === target) this.selectSummary(resumed.summary);
			}
			const behavior = delivery === "followUp" ? "followUp" : liveSummary?.isStreaming ? "steer" : undefined;
			this.setStatusMessage("Sending reply...");
			await this.sendPrompt(activeSessionId, text, behavior, liveSummary ?? target.summary, resumedReviveConfig);
			// The fallback-directory notice must outlive the transient send statuses.
			if (cwdFallbackNotice) this.setStatusMessage(cwdFallbackNotice, { sticky: true });
			else this.setStatusMessage("Reply sent");
			return true;
		} catch (error) {
			this.setStatusMessage(formatError("Failed to send reply", error));
			if (didResume) await this.refreshSessions({ preserveStatusOnError: true });
			return false;
		}
	}

	/** Create a fresh daemon session and open it in the chat view. */
	private async createNewSession(): Promise<boolean> {
		if (this.creatingNewSession || this.stopped) return false;
		this.creatingNewSession = true;
		try {
			const client = await this.connectDedicatedClient();
			try {
				this.setStatusMessage("Creating session...");
				const response = await client.request({
					type: "create",
					config: this.options.config,
					env: collectDaemonClientEnv(),
				});
				const created = expectSessionSummary(requireDaemonData(response));
				// The view can finish mid-create; kill the fresh session instead of orphaning it.
				if (this.stopped) {
					if (created.activeSessionId) {
						await client
							.request({ type: "kill", activeSessionId: created.activeSessionId })
							.catch(() => undefined);
					}
					return false;
				}
				this.selectSummary(created);
				this.finish({ type: "open", summary: created });
				return true;
			} finally {
				client.close();
			}
		} catch (error) {
			if (!this.stopped) this.setStatusMessage(formatError("Failed to create session", error));
			return false;
		} finally {
			this.creatingNewSession = false;
		}
	}

	/**
	 * Run a view command against the armed composer's target. Returns whether
	 * it completed so callers can restore the draft; disarms are guarded
	 * against a composer re-armed during the awaited RPCs.
	 */
	private async runAgentsViewCommand(command: AgentsViewCommand, target: SessionSummary): Promise<boolean> {
		const armedAtStart = this.replyTarget;
		const disarmIfUnchanged = () => {
			if (armedAtStart && this.replyTarget === armedAtStart) this.setReplyTarget(undefined);
		};
		try {
			switch (command.name) {
				case "name": {
					const name = command.args.trim();
					if (!name) {
						this.setStatusMessage("Usage: /name <session name>", { tone: "warning" });
						return false;
					}
					return await this.renameSession(target, name);
				}
				case "kill": {
					if (!target.activeSessionId) {
						this.setStatusMessage("/kill needs a running agent; this session is inactive", { tone: "warning" });
						return false;
					}
					try {
						requireDaemonData(
							await this.requireClient().request({ type: "kill", activeSessionId: target.activeSessionId }),
						);
					} catch (error) {
						// As in deactivatePendingAgent: an agent that already finished counts as stopped.
						if (!isUnknownActiveSessionError(error)) throw error;
					}
					disarmIfUnchanged();
					this.setStatusMessage("Agent stopped");
					await this.refreshBothCatalogs();
					return true;
				}
			}
		} catch (error) {
			this.setStatusMessage(formatError(`Failed to run /${command.name}`, error));
			return false;
		}
		return false;
	}

	/**
	 * Outlives finish(), which closes the shared client and would reject an
	 * in-flight create while the daemon still materializes the session.
	 */
	private async connectDedicatedClient(): Promise<DaemonClient> {
		return connectAgentsViewDaemonClient(this.requireSocketPath());
	}

	/** Point selection (and its persisted key) at a freshly resumed session row. */
	private selectSummary(summary: SessionSummary): void {
		this.selectedRowIdentity = getSummaryIdentity(summary);
		this.selectedActiveSessionId = summary.activeSessionId ?? summary.id;
		this.selectedSessionKey = getAgentsViewSelectionKey(summary);
		this.persistentState.selectedRowIdentity = this.selectedRowIdentity;
		this.persistentState.selectedSessionKey = this.selectedSessionKey;
	}

	private async handleDeleteSelected(): Promise<void> {
		const row = this.rows[this.selectedIndex];
		if (!row?.selectable) {
			return;
		}
		if (row.kind === "subagent") {
			this.pendingDeleteAgent = undefined;
			await this.handleKillSubagentSelected(row);
			return;
		}
		if (row.kind !== "agent") {
			return;
		}
		this.pendingKillSubagent = undefined;
		const identity = getSummaryIdentity(row.summary);
		if (!row.summary.activeSessionId && row.summary.sessionFile) {
			if (this.pendingDeleteAgent?.identity === identity && this.isDeleteConfirmationVisible()) {
				this.clearDeleteConfirmation({ render: false });
				try {
					const latest = expectSessionList(
						requireDaemonData(await this.requireClient().request(createAgentsViewListCommand())),
					);
					this.lastListedSummaries = latest;
					const active = resolveAgentsViewActiveSummaryForPath(row.summary.sessionFile, latest);
					if (active) {
						this.pendingDeleteAgent = undefined;
						this.setStatusMessage("Session became active; stop it before deleting", { tone: "warning" });
						await this.refreshSessions();
						return;
					}
					const result = await deleteDaemonSavedSession(
						this.requireClient(),
						this.getSavedSessionCatalogContext(),
						row.summary.sessionFile,
					);
					if (!result.ok) {
						this.setStatusMessage(`Failed to delete session: ${result.error ?? "Unknown error"}`, {
							tone: "error",
						});
						return;
					}
					this.pendingDeleteAgent = undefined;
					const refreshed = await this.refreshSavedSessions({ preserveStatusOnError: true });
					const success = result.method === "trash" ? "Session moved to trash" : "Session deleted";
					this.setStatusMessage(refreshed ? success : `${success}; refresh failed`);
				} catch (error) {
					this.setStatusMessage(formatError("Failed to delete session", error));
				}
				return;
			}
			this.pendingDeleteAgent = {
				identity,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: false,
			};
			this.showDeleteConfirmation();
			return;
		}
		if (this.pendingDeleteAgent?.identity === identity) {
			if (this.isDeleteConfirmationVisible()) {
				await this.deactivatePendingAgent();
				return;
			}
			this.showDeleteConfirmation();
			return;
		}
		await this.stopAgentForDeletion(row);
	}

	private async handleKillSubagentSelected(row: AgentsViewRow): Promise<void> {
		const identity = getSummaryIdentity(row.summary);
		if (this.pendingKillSubagent?.identity === identity && this.isDeleteConfirmationVisible()) {
			const pending = this.pendingKillSubagent;
			this.clearDeleteConfirmation({ render: false });
			await this.killSubagent(pending, row);
			return;
		}
		const childId = row.summary.rlmChildId;
		const rootActiveSessionId = this.findSubagentRootRow(row)?.summary.activeSessionId;
		if (!childId || !rootActiveSessionId) {
			this.setStatusMessage("Cannot stop subagent without its parent agent");
			return;
		}
		this.pendingKillSubagent = { identity, rootActiveSessionId, childId };
		this.showDeleteConfirmation();
	}

	private async killSubagent(pending: PendingKillSubagent, currentRow: AgentsViewRow): Promise<void> {
		const running = currentRow.section === "running";
		const client = this.requireClient();
		this.setStatusMessage(running ? "Stopping subagent..." : "Deleting subagent...");
		try {
			if (!running && client.supportsServerCapability("delete_rlm_subagent")) {
				const data = requireDaemonData(
					await client.request({
						type: "delete_rlm_subagent",
						activeSessionId: pending.rootActiveSessionId,
						childId: pending.childId,
					}),
				);
				const deleted = isRecord(data) && data.deleted === true;
				const stillRunning = isRecord(data) && data.reason === "running";
				this.setStatusMessage(
					deleted
						? "Subagent deleted"
						: stillRunning
							? "Subagent is running; stop it first"
							: "Subagent already removed",
					{ render: false },
				);
			} else {
				const data = requireDaemonData(
					await client.request({
						type: "cancel_rlm_child",
						activeSessionId: pending.rootActiveSessionId,
						childId: pending.childId,
					}),
				);
				const cancelled = isRecord(data) && data.cancelled === true;
				this.setStatusMessage(
					running
						? cancelled
							? "Subagent stopped"
							: "Subagent already finished"
						: "The daemon cannot delete subagents; it was left unchanged",
					{ render: false, ...(running ? {} : { tone: "warning" as const }) },
				);
			}
			await this.refreshSessions();
		} catch (error) {
			const command = running ? "cancel_rlm_child" : "delete_rlm_subagent";
			this.setStatusMessage(
				isUnknownDaemonCommandError(error, command)
					? "Failed to update subagent: the daemon is running an older build; restart the daemon and try again"
					: formatError("Failed to update subagent", error),
			);
		}
	}

	private async stopAgentForDeletion(row: AgentsViewRow): Promise<void> {
		const identity = getSummaryIdentity(row.summary);
		const activeSessionId = row.summary.activeSessionId;
		if (!activeSessionId) {
			this.pendingDeleteAgent = {
				identity,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: false,
			};
			this.setStatusMessage(undefined, { render: false });
			this.setReplyTarget(undefined);
			this.showDeleteConfirmation();
			return;
		}
		if (!isRunningSessionSummary(row.summary)) {
			this.pendingDeleteAgent = {
				identity,
				activeSessionId,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: false,
			};
			this.setStatusMessage(undefined, { render: false });
			this.setReplyTarget(undefined);
			this.showDeleteConfirmation();
			return;
		}
		this.setStatusMessage("Stopping agent...");
		try {
			const response = await this.requireClient().request({
				type: "kill",
				activeSessionId,
			});
			requireDaemonData(response);
			this.pendingDeleteAgent = {
				identity,
				activeSessionId,
				sessionFile: row.summary.sessionFile,
				summary: row.summary,
				stopped: true,
			};
			this.selectedActiveSessionId = activeSessionId;
			this.setReplyTarget(undefined);
			this.setStatusMessage(undefined, { render: false });
			this.showDeleteConfirmation();
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(formatError("Failed to stop agent", error));
		}
	}

	private async deactivatePendingAgent(): Promise<void> {
		const pending = this.pendingDeleteAgent;
		if (!pending) {
			return;
		}
		this.setStatusMessage("Deactivating agent...");
		try {
			if (pending.activeSessionId) {
				try {
					const killResponse = await this.requireClient().request({
						type: "kill",
						activeSessionId: pending.activeSessionId,
					});
					requireDaemonData(killResponse);
				} catch (error) {
					if (!isUnknownActiveSessionError(error)) {
						throw error;
					}
				}
			}
			// Skip a file deleted between listing and now: SessionManager.open would
			// recreate a stub at the old path instead of loading it.
			if (pending.sessionFile && existsSync(pending.sessionFile)) {
				// Persist archived unless it already is: sessions with no prior
				// session_state entry would otherwise resurface on the next scan.
				const sessionManager = SessionManager.open(pending.sessionFile, this.options.config.sessionDir);
				if (sessionManager.getSessionState()?.status !== "archived") {
					sessionManager.appendSessionState({ status: "archived" });
				}
			}
			this.inactiveAgentIdentities.add(pending.identity);
			this.pendingDeleteAgent = undefined;
			this.clearDeleteConfirmation({ render: false });
			this.selectedActiveSessionId = undefined;
			this.setStatusMessage("Agent inactive", { render: false });
			await this.refreshSessions();
		} catch (error) {
			this.setStatusMessage(formatError("Failed to deactivate agent", error));
		}
	}

	private async sendPrompt(
		activeSessionId: string,
		message: string,
		streamingBehavior?: "steer" | "followUp",
		targetSummary?: SessionSummary,
		reviveConfig?: AgentSessionRuntimeConfig,
	): Promise<void> {
		if (this.options.config.telemetryDisabled) {
			const client = await this.connectDedicatedClient();
			// The reply's revival fallback must recreate with the agents-view
			// launch context, not daemon defaults. A config carried from the
			// resume that just ran wins: recomputing from the now-live summary
			// would strip a fallback cwd the resume was opened with (its
			// recorded directory is missing), and revival would fail on it.
			const revivalConfig =
				reviveConfig ??
				(targetSummary ? agentsViewSessionRuntimeConfig(this.options.config, targetSummary) : undefined);
			const connection = await DaemonAgentConnection.attach(client, activeSessionId, {
				closeClientOnDispose: true,
				supportsExtensionUi: false,
				recoverDaemon: this.options.recoverDaemon,
				reconnectTimeoutMs: this.options.reconnectTimeoutMs,
				telemetryDisabled: true,
				...(revivalConfig ? { reviveConfig: revivalConfig } : {}),
			});
			try {
				await connection.prompt(message, streamingBehavior === undefined ? undefined : { streamingBehavior });
			} finally {
				await connection.dispose();
			}
			return;
		}
		const command: PromptCommand = { type: "prompt", activeSessionId, message };
		if (streamingBehavior) command.streamingBehavior = streamingBehavior;
		const response = await this.requireClient().request(command);
		requireDaemonData(response);
	}

	private pollSessions(): void {
		if (this.liveCatalogPollPromise) return;
		const poll = this.refreshSessions().then(() => undefined);
		this.liveCatalogPollPromise = poll;
		void poll.finally(() => {
			if (this.liveCatalogPollPromise === poll) this.liveCatalogPollPromise = undefined;
		});
	}

	private async refreshSessions(options: { preserveStatusOnError?: boolean } = {}): Promise<boolean> {
		if (this.reconnectPromise || this.daemonShutdownReceived) return false;
		const generation = ++this.liveCatalogGeneration;
		this.liveCatalogRefreshPending = true;
		try {
			const client = this.requireClient();
			try {
				const response = await client.request(createAgentsViewListCommand());
				if (generation !== this.liveCatalogGeneration) return false;
				this.liveCatalogReady = true;
				this.applySessionList(expectSessionList(requireDaemonData(response)), true);
				return true;
			} catch (error) {
				if (generation === this.liveCatalogGeneration) {
					// A completed failed attempt is still catalog-settled: otherwise a
					// vanished scope can permanently trap an empty view.
					this.liveCatalogReady = true;
					this.reconcileCatalogs();
					if (!options.preserveStatusOnError && !this.reconnectPromise) {
						if (client.isConnected) this.setStatusMessage(formatError("Failed to refresh agents", error));
						else this.startClientReconnect(client, error);
					}
				}
				return false;
			}
		} catch (error) {
			if (generation === this.liveCatalogGeneration) {
				this.liveCatalogReady = true;
				this.reconcileCatalogs();
				if (!options.preserveStatusOnError) {
					this.setStatusMessage(formatError("Failed to refresh current session", error));
				}
			}
			return false;
		} finally {
			if (generation === this.liveCatalogGeneration) {
				this.liveCatalogRefreshPending = false;
				this.resolveMissingSelectionAnchor();
			}
		}
	}

	private applySessionList(sessions: SessionSummary[], successful = false): void {
		this.lastListedSummaries = sessions;
		if (successful) this.persistentState.lastSuccessfulLiveSummaries = sessions;
		this.reconcileCatalogs();
	}

	private reconcileCatalogs(): void {
		const visibleSessions = this.lastListedSummaries.filter((summary) =>
			shouldShowAgentsViewSession(summary, this.inactiveAgentIdentities.has(getSummaryIdentity(summary))),
		);
		this.lastVisibleSummaries = this.withPendingDeleteSession(visibleSessions);
		this.unifiedRecords = reconcileUnifiedSessions(this.lastVisibleSummaries, this.savedSessions, this.heartbeats);
		this.unifiedIndex = buildUnifiedSessionIndex(this.unifiedRecords);

		const frames = this.persistentState.scopeFrames ?? [];
		const resolution = resolveAgentsViewScopeFrames(this.unifiedRecords, frames, this.unifiedIndex);
		if (shouldApplyScopeResolution(resolution.droppedFrames, this.liveCatalogReady, this.savedCatalogReady)) {
			this.persistentState.scopeFrames = resolution.frames;
			this.scopeKey = resolution.frames.at(-1)?.scope;
			this.scopeRootSummary = resolution.root ? summaryForUnifiedRecord(resolution.root) : undefined;
			this.persistentState.scopeRootSummary = this.scopeRootSummary;
			if (resolution.droppedFrames > 0) {
				const destination = resolution.root ? "the nearest available parent" : "the global view";
				this.setStatusMessage(`Scope is no longer available; returned to ${destination}`, { render: false });
			}
		}
		this.scopedRecords = scopeToSessionSubtree(this.unifiedRecords, this.scopeKey, this.unifiedIndex);
		this.rows = buildAgentsViewRows(
			this.getFilteredRecords(),
			this.expandedSubagentParents,
			this.programShownParents,
			this.scopeKey,
		);
		this.applyPendingAncestorExpansion();
		this.restoreSelection();
		this.ui.requestRender();
	}

	/** A session appears in both catalogs; mutations must refresh both. */
	private async refreshBothCatalogs(): Promise<boolean> {
		const results = await Promise.all([
			this.refreshSessions({ preserveStatusOnError: true }),
			this.refreshSavedSessions({ preserveStatusOnError: true }),
		]);
		return results.every(Boolean);
	}

	private async refreshSavedSessions(
		options: { duringReconnect?: boolean; preserveStatusOnError?: boolean } = {},
	): Promise<boolean> {
		if ((!options.duringReconnect && this.reconnectPromise) || this.daemonShutdownReceived) return false;
		const generation = ++this.savedCatalogGeneration;
		this.persistentState.savedCatalogGeneration = generation;
		this.savedCatalogRefreshPending = true;
		this.savedCatalogReady = false;
		const successfulSessions = this.lastSuccessfulSavedSessions;
		const progressiveSessions = new Map(
			successfulSessions.map((session) => [resolvePath(canonicalizePath(session.path)), session]),
		);
		try {
			const onSession = (session: AgentConnectionSavedSessionInfo) => {
				if (generation !== this.savedCatalogGeneration) return;
				progressiveSessions.set(resolvePath(canonicalizePath(session.path)), session);
				this.savedSessions = [...progressiveSessions.values()];
				this.persistentState.savedSessions = this.savedSessions;
				this.reconcileCatalogs();
			};
			const sessions = await listDaemonSavedSessions(
				this.requireClient(),
				this.getSavedSessionCatalogContext(),
				"all",
				{
					onSession,
				},
			);
			if (generation !== this.savedCatalogGeneration) return false;
			this.savedSessions = sessions;
			this.lastSuccessfulSavedSessions = sessions;
			this.savedCatalogReady = true;
			this.persistentState.lastSuccessfulSavedSessions = sessions;
			this.persistentState.savedSessions = sessions;
			this.reconcileCatalogs();
			return true;
		} catch (error) {
			if (generation === this.savedCatalogGeneration) {
				this.savedSessions = successfulSessions;
				this.persistentState.savedSessions = successfulSessions;
				// Treat a terminal failure as settled so scope fallback cannot soft-lock.
				this.savedCatalogReady = true;
				this.reconcileCatalogs();
				if (!options.preserveStatusOnError && !this.reconnectPromise && !this.daemonShutdownReceived) {
					this.setStatusMessage(formatError("Failed to load saved sessions", error));
				}
			}
			return false;
		} finally {
			if (generation === this.savedCatalogGeneration) {
				this.savedCatalogRefreshPending = false;
				this.resolveMissingSelectionAnchor();
			}
		}
	}

	private async refreshHeartbeats(options: { duringReconnect?: boolean } = {}): Promise<boolean> {
		if ((!options.duringReconnect && this.reconnectPromise) || this.daemonShutdownReceived) return false;
		const generation = ++this.heartbeatCatalogGeneration;
		try {
			const heartbeats = await listDaemonHeartbeats(this.requireClient());
			if (generation !== this.heartbeatCatalogGeneration) return false;
			this.heartbeats = heartbeats;
			this.persistentState.heartbeats = heartbeats;
			this.reconcileCatalogs();
			return true;
		} catch (error) {
			if (generation === this.heartbeatCatalogGeneration && !this.reconnectPromise) {
				this.setStatusMessage(formatError("Failed to refresh heartbeats", error));
			}
			return false;
		}
	}

	private withPendingDeleteSession(sessions: readonly SessionSummary[]): SessionSummary[] {
		const pending = this.pendingDeleteAgent;
		// Saved-only rows already come from the durable catalog. Injecting their
		// synthetic archived summary as a daemon record would move confirmation
		// from Inactive to Idle.
		if (!pending || pending.summary.lifecycle !== "live") {
			return [...sessions];
		}
		if (!this.isDeleteConfirmationVisible()) {
			return [...sessions];
		}
		let replaced = false;
		const merged = sessions.map((summary) => {
			if (getSummaryIdentity(summary) !== pending.identity) {
				return summary;
			}
			replaced = true;
			return pending.summary;
		});
		return replaced ? merged : [...merged, pending.summary];
	}

	private resolveMissingSelectionAnchor(): void {
		if (!this.selectionAnchorPending || this.liveCatalogRefreshPending || this.savedCatalogRefreshPending) {
			return;
		}
		// Unblock the fallback row, but keep the anchor identities: a later poll
		// can still deliver the intended session and re-anchor selection to it.
		this.selectionAnchorPending = false;
		const row = this.rows[this.selectedIndex];
		this.selectedActiveSessionId = row?.selectable ? (row.summary.activeSessionId ?? row.summary.id) : undefined;
	}

	private restoreSelection(): void {
		if (this.rows.length === 0) {
			this.selectedIndex = 0;
			this.selectedActiveSessionId = undefined;
			return;
		}
		const resolution = resolveAgentsViewSelectionState(
			this.rows,
			this.selectedIndex,
			this.selectedRowIdentity ?? this.persistentState.selectedRowIdentity,
			this.selectedSessionKey ?? this.persistentState.selectedSessionKey,
		);
		this.selectedIndex = resolution.index;
		if (resolution.resolved) {
			this.syncSelectedRowState();
			return;
		}
		this.selectionAnchorPending = Boolean(
			this.selectedRowIdentity ??
				this.persistentState.selectedRowIdentity ??
				this.selectedSessionKey ??
				this.persistentState.selectedSessionKey,
		);
		// Catalogs stream independently. Show a temporary fallback row without
		// replacing the source-session anchor before its daemon row arrives.
		const fallback = this.rows[this.selectedIndex];
		this.selectedActiveSessionId = fallback?.selectable
			? (fallback.summary.activeSessionId ?? fallback.summary.id)
			: undefined;
	}

	private getSelectableRowIndexes(): number[] {
		return this.rows.flatMap((row, index) => (row.selectable ? [index] : []));
	}

	private syncSelectedRowState(): void {
		this.selectionAnchorPending = false;
		const row = this.rows[this.selectedIndex];
		this.selectedActiveSessionId = row?.selectable ? (row.summary.activeSessionId ?? row.summary.id) : undefined;
		this.selectedRowIdentity = getSelectedRowIdentity(row);
		this.selectedSessionKey = row?.selectable ? getAgentsViewSelectionKey(row.summary) : undefined;
		this.persistentState.selectedRowIdentity = this.selectedRowIdentity;
		this.persistentState.selectedSessionKey = this.selectedSessionKey;
	}

	private finish(result: AgentsViewRunResult): void {
		if (this.stopped) {
			return;
		}
		this.stopped = true;
		this.savedCatalogGeneration += 1;
		this.liveCatalogGeneration += 1;
		this.heartbeatCatalogGeneration += 1;
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
		if (this.heartbeatPollTimer) {
			clearInterval(this.heartbeatPollTimer);
			this.heartbeatPollTimer = undefined;
		}
		if (this.animationTimer) {
			clearInterval(this.animationTimer);
			this.animationTimer = undefined;
		}
		this.clearCtrlCExitHint({ render: false });
		this.clearDeleteConfirmation({ render: false });
		this.setStatusMessage(undefined, { render: false });
		this.ui.stop({
			preserveAltScreen: result.type !== "exit",
			flushFullscreen: false,
		});
		stopThemeWatcher();
		this.unsubscribeClientClose?.();
		this.unsubscribeClientClose = undefined;
		this.unsubscribeClientMessage?.();
		this.unsubscribeClientMessage = undefined;
		this.client?.close();
		this.client = undefined;
		this.resolveRun?.(result);
		this.resolveRun = undefined;
	}

	private subscribeToClientClose(client: DaemonClient): void {
		this.unsubscribeClientClose?.();
		this.unsubscribeClientClose = client.onClose((error) => {
			if (!shouldReconnectAgentsViewDaemon(getDaemonSocketCloseReason(error))) {
				this.handleDaemonShutdown(client, error);
				return;
			}
			this.startClientReconnect(client, error);
		});
	}

	private handleDaemonShutdown(client: DaemonClient, error: Error): void {
		if (this.stopped || client !== this.client) {
			return;
		}
		this.daemonShutdownReceived = true;
		this.reconnectTimedOut = false;
		this.setStatusMessage(`Prime Agent daemon shut down. Restart Prime Agent to reconnect. ${error.message}`, {
			tone: "error",
			sticky: true,
		});
		this.applySessionList([]);
	}

	private startClientReconnect(client: DaemonClient, error: unknown): void {
		if (this.stopped || client !== this.client || this.reconnectPromise || this.daemonShutdownReceived) {
			return;
		}
		if (!this.reconnectTimedOut) {
			this.setStatusMessage("Daemon connection lost; reconnecting…", { tone: "warning", sticky: true });
		}
		const reconnectPromise = this.reconnectClient(client, error).finally(() => {
			if (this.reconnectPromise === reconnectPromise) {
				this.reconnectPromise = undefined;
			}
		});
		this.reconnectPromise = reconnectPromise;
	}

	private async reconnectClient(client: DaemonClient, initialError: unknown): Promise<void> {
		const deadline = Date.now() + (this.options.reconnectTimeoutMs ?? RECONNECT_TIMEOUT_MS);
		let lastError = initialError;
		while (!this.stopped && !this.daemonShutdownReceived && client === this.client && Date.now() < deadline) {
			try {
				await this.options.recoverDaemon?.();
				await client.reconnect(1000);
				const response = await client.request(createAgentsViewListCommand());
				const data = requireDaemonData(response);
				const sessions = expectSessionList(data);
				const heartbeatsRefreshed = await this.refreshHeartbeats({ duringReconnect: true });
				if (!heartbeatsRefreshed) throw new Error("Heartbeat catalog did not refresh during reconnect");
				this.daemonShutdownReceived = false;
				this.reconnectTimedOut = false;
				this.setStatusMessage("Daemon reconnected", { render: false });
				this.applySessionList(sessions, true);
				void this.refreshSavedSessions({ duringReconnect: true, preserveStatusOnError: true });
				return;
			} catch (error) {
				lastError = error;
			}
			await new Promise<void>((resolve) => {
				const retryTimer = setTimeout(resolve, RECONNECT_RETRY_MS);
				retryTimer.unref?.();
			});
		}
		if (!this.stopped && !this.daemonShutdownReceived && client === this.client) {
			this.reconnectTimedOut = true;
			this.setStatusMessage(formatError("Daemon unavailable; retrying", lastError), {
				tone: "error",
				sticky: true,
				render: false,
			});
		}
	}

	private requireSocketPath(): string {
		if (!this.options.socketPath) throw new Error("Session view daemon socket is not configured");
		return this.options.socketPath;
	}

	private requireClient(): DaemonClient {
		if (!this.client) {
			throw new Error("Agents view daemon client is not connected");
		}
		return this.client;
	}

	private getAgentCountsText(): string {
		const counts = countRowsBySection(this.rows);
		return `${counts.running} running, ${counts.idle} idle, ${counts.inactive} inactive`;
	}

	private renderSessionRows(width: number, maxRows: number): string[] {
		if (maxRows <= 0) {
			return [];
		}
		if (this.rows.length === 0) {
			return [theme.bold(sectionTitle("running")), theme.fg("dim", "  No sessions match your search.")].slice(
				0,
				maxRows,
			);
		}

		const displayItems = buildDisplayItems(this.rows);
		const selectedIdentity = this.rows[this.selectedIndex]?.identity;
		const selectedDisplayIndex = displayItems.findIndex(
			(item) => item.type === "row" && item.row.identity === selectedIdentity,
		);
		const visibleRows = Math.min(maxRows, this.visibleListRows());
		const start = Math.max(
			0,
			Math.min(displayItems.length - visibleRows, selectedDisplayIndex - Math.floor(visibleRows / 2)),
		);
		const showLeadingEllipsis = start > 0;
		let showTrailingEllipsis = start + visibleRows < displayItems.length;
		if ((showLeadingEllipsis ? 1 : 0) + (showTrailingEllipsis ? 1 : 0) >= visibleRows) {
			showTrailingEllipsis = false;
		}
		const contentVisibleRows = Math.max(
			0,
			visibleRows - (showLeadingEllipsis ? 1 : 0) - (showTrailingEllipsis ? 1 : 0),
		);
		const visibleItems = displayItems.slice(start, start + contentVisibleRows);
		const lines = visibleItems.map((item) => {
			if (item.type === "spacer") {
				return "";
			}
			if (item.type === "heading") {
				return theme.bold(sectionTitle(item.section));
			}
			if (item.type === "empty") {
				return theme.fg("dim", "  No agents");
			}
			return this.renderRow(item.row, width);
		});
		if (showLeadingEllipsis) {
			lines.unshift(theme.fg("dim", "  ..."));
		}
		if (showTrailingEllipsis) {
			lines.push(theme.fg("dim", "  ..."));
		}
		return lines;
	}

	private renderRow(row: AgentsViewRow, width: number): string {
		const selected = row.selectable && row.identity === this.rows[this.selectedIndex]?.identity;
		if (row.kind === "subagent-code") {
			return this.renderCodeRow(row);
		}
		if (row.kind === "subagent-summary") {
			const indent = "  ".repeat(row.depth);
			const hint = row.hasSpawnCode ? theme.fg("dim", ` · ${keyText("app.agents.program")} show program`) : "";
			const label = `${theme.fg("dim", `▸ ${row.title}`)}${hint}`;
			const line = padLine(truncateToWidth(`${indent}${label}`, width, ""), width);
			return selected ? `${SELECTED_ROW_MARKER}${line}` : line;
		}
		const pendingDelete = row.kind === "agent" && this.isPendingDeleteRow(row);
		const pendingKill = row.kind === "subagent" && this.isPendingKillSubagentRow(row);
		const rawIcon = this.getRowIcon(row.section);
		const icon = this.formatRowIcon(row.section, rawIcon);
		const indent = "  ".repeat(row.depth);
		const age = formatSessionDuration(row.summary);
		const details = row.section === "inactive" ? `${row.summary.messageCount} · ${age}` : age;
		const detailsWidth = row.section === "inactive" ? Math.max(10, visibleWidth(details)) : 10;
		const heartbeatBadge = !pendingDelete && !pendingKill ? formatHeartbeatBadge(row.heartbeat) : "";
		const heartbeatCell = heartbeatBadge ? theme.fg("error", heartbeatBadge) : "";
		const heartbeatWidth = visibleWidth(heartbeatBadge);
		const titleWidth = Math.max(
			0,
			width -
				visibleWidth(indent) -
				visibleWidth(rawIcon) -
				detailsWidth -
				2 -
				(heartbeatWidth > 0 ? heartbeatWidth + 1 : 0),
		);
		const title = pendingDelete
			? this.getPendingDeleteTitle()
			: pendingKill
				? `${keyText("app.agents.delete")} again to ${row.section === "running" ? "stop" : "delete"}`
				: styleRowTitle(row);
		// Append the background summary as a dim suffix on the same line, e.g.
		// "fix auth · Refactoring token validation". Hidden during delete/stop
		// confirmations so the warning text stands alone.
		const summaryText = !pendingDelete && !pendingKill ? row.summary.summary : undefined;
		const titleContent = summaryText ? `${title} ${theme.fg("dim", `· ${summaryText}`)}` : title;
		const titleCell = formatTableCell(titleContent, titleWidth);
		const cells = [
			icon,
			pendingDelete || pendingKill ? theme.fg("error", titleCell) : titleCell,
			formatRightTableCell(details, detailsWidth),
		];
		const base = `${indent}${cells[0]} ${heartbeatCell ? `${heartbeatCell} ` : ""}${cells[1]} ${cells[2]}`;
		const line = padLine(truncateToWidth(base, width, ""), width);
		return selected ? `${SELECTED_ROW_MARKER}${line}` : line;
	}

	// Spawn-code rows are read-only context. They render deemphasized — muted
	// text on a panel background (applied in finalizeRenderedLine) so the program
	// reads as one quiet segmented block rather than competing with agent rows.
	private renderCodeRow(row: AgentsViewRow): string {
		const indent = "  ".repeat(row.depth);
		const body = theme.fg("muted", row.code || " ");
		return `${CODE_ROW_MARKER}${indent}  ${body}`;
	}

	private finalizeRenderedLine(line: string, width: number): string {
		const code = line.startsWith(CODE_ROW_MARKER);
		const selected = !code && line.startsWith(SELECTED_ROW_MARKER);
		let content = code
			? line.slice(CODE_ROW_MARKER.length)
			: selected
				? line.slice(SELECTED_ROW_MARKER.length)
				: line;
		// Each rendered line must occupy exactly one terminal row; a stray
		// newline would shift every line below it and overlap the editor.
		if (content.includes("\n") || content.includes("\r")) {
			content = content.replace(/[\r\n]+/g, " ");
		}
		const padded = padLine(truncateToWidth(content, width), width);
		if (code) {
			return theme.bg("toolPanelBg", padded);
		}
		if (!selected) {
			return padded;
		}
		// Truncating styled cells embeds full \x1b[0m resets; re-open the
		// selection background after each so the highlight spans the whole row.
		const applySelectionBg = theme.getSelectionBackgroundColor();
		return padded.split("\x1b[0m").map(applySelectionBg).join("\x1b[0m");
	}

	private isPendingDeleteRow(row: AgentsViewRow): boolean {
		return (
			getSummaryIdentity(row.summary) === this.pendingDeleteAgent?.identity && this.isDeleteConfirmationVisible()
		);
	}

	private isPendingKillSubagentRow(row: AgentsViewRow): boolean {
		return (
			getSummaryIdentity(row.summary) === this.pendingKillSubagent?.identity && this.isDeleteConfirmationVisible()
		);
	}

	private getPendingDeleteTitle(): string {
		const deleteKey = keyText("app.agents.delete");
		return this.pendingDeleteAgent?.stopped
			? `stopped - ${deleteKey} again to remove`
			: `${deleteKey} again to remove`;
	}

	private renderPrompt(width: number): string[] {
		return this.editor.render(width);
	}

	private renderDock(width: number): string[] {
		const safeWidth = Math.max(1, width);
		return [this.renderHints(safeWidth)].map((line) => this.finalizeRenderedLine(line, safeWidth));
	}

	private renderHints(width: number): string {
		if (this.isCtrlCExitHintVisible()) {
			const clearKey = keyText("app.clear");
			const hint = clearKey ? `Press ${clearKey} again to exit` : "Press again to exit";
			return truncateToWidth(theme.fg("muted", hint), width);
		}
		if (this.statusMessage) {
			return truncateToWidth(theme.fg(this.statusMessageTone, this.statusMessage), width);
		}
		if (this.renameTarget) {
			const hint = `${keyText("tui.select.confirm")} save   ${keyText("tui.select.cancel")} cancel`;
			return truncateToWidth(theme.fg("muted", hint), width);
		}
		if (this.replyTarget) {
			return truncateToWidth(theme.fg("muted", this.renderReplyComposerHints()), width);
		}
		// Replying is reserved for top-level agents; subagents can be stopped or deleted.
		const selectedRow = this.rows[this.selectedIndex];
		const selectedAgent = selectedRow?.kind === "agent";
		const selectedSubagent = selectedRow?.kind === "subagent";
		const hints = [
			`${keyText("tui.select.up")}/${keyText("tui.select.down")} move`,
			`${keyText("tui.select.confirm")} open`,
			`${keyText("app.agents.open")} open`,
			selectedAgent
				? `${keyText("app.agents.reply")} ${selectedRow?.section === "inactive" ? "resume" : "reply"}`
				: undefined,
			`${keyText("app.agents.new")} new`,
			selectedAgent ? `${keyText("app.agents.rename")} rename` : undefined,
			selectedAgent
				? `${keyText("app.agents.delete")} ${selectedRow?.section === "inactive" ? "delete" : "stop/deactivate"}`
				: undefined,
			selectedSubagent
				? `${keyText("app.agents.delete")} ${selectedRow.section === "running" ? "stop" : "delete"}`
				: undefined,
			this.selectedRowCanShowProgram() ? `${keyText("app.agents.program")} program` : undefined,
		]
			.filter((hint): hint is string => hint !== undefined)
			.join("   ");
		return truncateToWidth(theme.fg("muted", hints), width);
	}

	private renderReplyComposerHints(): string {
		const target = this.replyTarget!;
		const current = resolveCurrentReplyTargetSummary(this.unifiedRecords ?? [], target, (activeSessionId) =>
			this.findSummaryByActiveSessionId(activeSessionId),
		);
		const streaming = current.activeSessionId !== undefined && current.isStreaming;
		const hasText = this.editor.getText().trim().length > 0;
		return [
			`${keyText("tui.select.confirm")} ${streaming ? "steer" : current.activeSessionId ? "send" : "resume & send"}`,
			hasText ? `${keyText("app.message.followUp")} queue` : undefined,
			`${keyText("tui.select.cancel")} cancel`,
		]
			.filter((hint): hint is string => hint !== undefined)
			.join("   ");
	}

	private visibleListRows(): number {
		return Math.max(4, this.ui.terminal.rows - 9);
	}

	private contentHeight(width: number): number {
		const rows = this.ui.terminal.rows;
		const dockHeight = clippedFullscreenDockHeight(this.renderDock(width).length, rows);
		return Math.max(0, rows - dockHeight);
	}

	private getSplashModelId(): string | undefined {
		return this.rows[this.selectedIndex]?.summary.model?.id ?? this.options.startupModelId;
	}

	private getSplashCwd(): string {
		return this.rows[this.selectedIndex]?.summary.cwd ?? this.options.uiServices.getInitialCwd();
	}

	private getRowIcon(section: AgentsViewSection): string {
		switch (section) {
			case "running":
				return workingIconFrame(this.workingIconFrame);
			case "idle":
				return NEEDS_INPUT_ROW_ICON;
			case "inactive":
				return COMPLETED_ROW_ICON;
			default: {
				const _exhaustive: never = section;
				return _exhaustive;
			}
		}
	}

	private formatRowIcon(section: AgentsViewSection, icon: string): string {
		switch (section) {
			case "running":
				return theme.bold(icon);
			case "idle":
				return theme.fg("warning", icon);
			case "inactive":
				return theme.fg("dim", icon);
			default: {
				const _exhaustive: never = section;
				return _exhaustive;
			}
		}
	}
}

type DisplayItem =
	| { type: "spacer" }
	| { type: "heading"; section: AgentsViewSection }
	| { type: "empty"; section: AgentsViewSection }
	| { type: "row"; row: AgentsViewRow };

function buildDisplayItems(rows: readonly AgentsViewRow[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	const sections: AgentsViewSection[] = ["running", "idle", "inactive"];
	for (const [index, section] of sections.entries()) {
		if (index > 0) {
			items.push({ type: "spacer" });
		}
		items.push({ type: "heading", section });
		const sectionRows = getDisplayRowsForSection(rows, section);
		if (sectionRows.length === 0) {
			items.push({ type: "empty", section });
			continue;
		}
		for (const row of sectionRows) {
			items.push({ type: "row", row });
		}
	}
	return items;
}

// Nested rows (subagent summaries and expanded subagents) always render in
// their top-level agent's section block, regardless of their own section.
function getDisplayRowsForSection(rows: readonly AgentsViewRow[], section: AgentsViewSection): AgentsViewRow[] {
	const result: AgentsViewRow[] = [];
	let include = false;
	for (const row of rows) {
		if (row.depth === 0) {
			include = row.section === section;
		}
		if (include) {
			result.push(row);
		}
	}
	return result;
}

function countRowsBySection(rows: readonly AgentsViewRow[]): Record<AgentsViewSection, number> {
	const agents = rows.filter((row) => row.kind === "agent");
	return {
		running: agents.filter((row) => row.section === "running").length,
		idle: agents.filter((row) => row.section === "idle").length,
		inactive: agents.filter((row) => row.section === "inactive").length,
	};
}

function getSelectedRowIdentity(row: AgentsViewRow | undefined): string | undefined {
	return row?.identity;
}

function rowHasSpawnCode(row: AgentsViewRow): boolean {
	const code = row.summary.spawnCode;
	return typeof code === "string" && code.trim().length > 0;
}

function isRunningSessionSummary(summary: SessionSummary): boolean {
	return summary.activity === "working";
}

// Explicit session names read bold so they stand out from fallback titles
// (first prompt, cwd, ids); the "(no messages)" placeholder reads italic.
function styleRowTitle(row: AgentsViewRow): string {
	if (row.summary.sessionName?.replace(/\s+/g, " ").trim()) {
		return theme.bold(row.title);
	}
	if (row.title === "(no messages)") {
		return theme.italic(row.title);
	}
	return row.title;
}

function formatTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function formatRightTableCell(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return " ".repeat(Math.max(0, width - visibleWidth(truncated))) + truncated;
}

function formatSessionDuration(summary: SessionSummary): string {
	return formatAgentsViewRelativeTime(
		summary.activeSessionId ? (summary.created ?? summary.modified) : (summary.modified ?? summary.created),
	);
}

export function formatAgentsViewRelativeTime(value: string | undefined, now: number = Date.now()): string {
	const timestamp = parseSessionTimestamp(value);
	if (!timestamp) {
		return "";
	}
	const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		return `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	if (hours < 24) {
		return `${hours}h`;
	}
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

function parseSessionTimestamp(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

function requireDaemonData(response: DaemonResponse): unknown {
	if (!response.success) {
		throw new Error(response.error);
	}
	return response.data;
}

function expectSessionList(value: unknown): SessionSummary[] {
	if (!isRecord(value) || !Array.isArray(value.sessions)) {
		throw new Error("Daemon returned an invalid session list response");
	}
	if (!value.sessions.every(isSessionSummary)) {
		throw new Error("Daemon returned an invalid session summary");
	}
	return value.sessions;
}

function expectSessionSummary(value: unknown): SessionSummary {
	if (!isSessionSummary(value)) {
		throw new Error("Daemon returned an invalid session summary");
	}
	return value;
}

function isSessionSummary(value: unknown): value is SessionSummary {
	return isRecord(value) && typeof value.id === "string" && typeof value.sessionId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(prefix: string, error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return formatAgentsViewStatusLine(`${prefix}: ${message}`);
}

// The agents view shows open failures as a one-line status only, so a client-side
// crash (e.g. "Maximum call stack size exceeded") leaves no stack to debug from.
// Persist the full stack to a file — the TUI owns stdout/stderr, so a log file is
// the only safe sink.
function logClientError(prefix: string, error: unknown): void {
	const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
	appendRotatingLog(getClientErrorLogPath(), `[${new Date().toISOString()}] ${prefix}: ${detail}`);
}

function padLine(line: string, width: number): string {
	return line + " ".repeat(Math.max(0, width - visibleWidth(line)));
}
