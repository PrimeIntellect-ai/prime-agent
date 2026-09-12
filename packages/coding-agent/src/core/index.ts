/**
 * Core modules shared between all run modes.
 */

export type {
	AgentSessionCreationOptions,
	AgentSessionRuntimeDiagnostic,
	AgentSessionServices,
	CreateAgentSessionFromServicesOptions,
	CreateAgentSessionServicesOptions,
} from "../sdk/contracts.js";
export { createAgentSessionFromServices, createAgentSessionServices } from "../sdk/services.js";
export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
} from "../session/agent-session.js";
export type {
	CreateRlmSubagentRuntimeOptions,
	RlmSubagentRuntime,
	SubagentRuntimeHost,
} from "../session/children/runtime-contracts.js";
export type { CompactionResult } from "../session/compaction/types.js";
export type { SessionStats } from "../session/context/session-stats.js";
export type { RefinementResult } from "../session/refinement/types.js";
export type { AgentSessionRuntimeConfig } from "../session/runtime/config.js";
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeKind,
	type AgentSessionRuntimeMetadata,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "../session/runtime/runtime.js";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.js";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.js";
// Extensions system
export {
	type AgentEndEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BuildSystemPromptOptions,
	type ContextEvent,
	defineTool,
	discoverAndLoadExtensions,
	type ExecOptions,
	type ExecResult,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionError,
	type ExtensionEvent,
	type ExtensionFactory,
	type ExtensionFlag,
	type ExtensionHandler,
	ExtensionRunner,
	type ExtensionShortcut,
	type ExtensionUIContext,
	type LoadExtensionsResult,
	type MessageRenderer,
	type RegisteredCommand,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeSwitchEvent,
	type SessionBeforeTreeEvent,
	type SessionCompactEvent,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./extensions/index.js";
export { SessionImportFileNotFoundError } from "./session-import-errors.js";
export { createSyntheticSourceInfo } from "./source-info.js";
