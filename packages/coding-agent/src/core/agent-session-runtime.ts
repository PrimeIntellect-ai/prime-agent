// Compatibility exports; implementation lives with its feature owner.
export {
	AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionRuntimeDisposeOptions,
	type AgentSessionRuntimeKind,
	type AgentSessionRuntimeMetadata,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	SessionImportFileNotFoundError,
} from "../session/runtime/runtime.js";
