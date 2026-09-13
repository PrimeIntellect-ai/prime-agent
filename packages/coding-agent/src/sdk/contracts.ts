import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model, ServiceTier } from "@earendil-works/pi-ai";
import type { AgentSessionMessageController } from "../core/agent-messages.js";
import type { AgentObserveController } from "../core/agent-observe.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { AgentRlmHeartbeatController } from "../core/cron-jobs.js";
import type { LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "../core/extensions/index.js";
import type { McpManager } from "../core/mcp/mcp-manager.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { DefaultResourceLoaderOptions, ResourceLoader } from "../core/resource-loader.js";
import type { SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";
import type { AgentSession } from "../session/agent-session.js";
import type { AgentAutonomousConfig } from "../session/autonomy/autonomous.js";
import type { SubagentRuntimeHost } from "../session/children/runtime-contracts.js";
import type { AgentExecutionMode } from "../session/runtime/config.js";

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
	semanticParentSessionId?: string;
	semanticSpawnedByRequestId?: string;
	subagentRuntimeHost?: SubagentRuntimeHost;
	rlmHeartbeatController?: AgentRlmHeartbeatController;
	prewarmIpythonKernel?: boolean;
	autonomous?: AgentAutonomousConfig;
	serializedRefine?: boolean;
	executionMode?: AgentExecutionMode;
	telemetryDisabled?: true;
	initialGoal?: { objective: string; tokenBudget?: number };
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
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}
