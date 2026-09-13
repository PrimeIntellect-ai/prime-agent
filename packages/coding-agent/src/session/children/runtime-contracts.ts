import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, ServiceTier } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "../../core/extensions/index.js";
import type { AgentSession } from "../agent-session.js";

/** Request emitted by `rlm.spawn`; cellSourceCode preserves the spawning cell for display. */
export interface RlmRunRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
	cellSourceCode?: string;
}

interface RlmCreateSessionRequest {
	prompt: string;
	kwargs: Record<string, unknown>;
}

export interface RlmCreateSessionResult {
	active_session_id: string;
	session_id: string;
	name: string;
	session_file: string;
	model: string;
}

export interface RlmSpawnHandle {
	rlm_child_id: string;
	name: string;
	session_dir: string;
	model: string;
}

export type RlmSubagentRegistryStatus = "running" | "completed" | "error";

export interface RlmSubagentRegistryEntry {
	rlm_child_id: string;
	active_session_id: string | null;
	session_id: string | null;
	session_name: string;
	session_dir: string;
	status: RlmSubagentRegistryStatus;
}

export interface RlmListSubagentsResult {
	subagents: RlmSubagentRegistryEntry[];
}

export interface RlmDeleteSubagentResult {
	subagent: RlmSubagentRegistryEntry;
	outcome?: "deleted" | "skipped_running";
}

export type RlmRunHandler = (request: RlmRunRequest) => Promise<Record<string, unknown>>;
export type RlmCreateSessionHandler = (request: RlmCreateSessionRequest) => Promise<RlmCreateSessionResult>;

export type RlmListSubagentsHandler = () => RlmListSubagentsResult | Promise<RlmListSubagentsResult>;
export type RlmDeleteSubagentHandler = (target: string) => Promise<RlmDeleteSubagentResult>;
export interface RlmSubagentRuntime {
	session: AgentSession;
}

export interface CreateRlmSubagentRuntimeOptions {
	parentSession: AgentSession;
	id: string;
	prompt: string;
	sessionName: string;
	sessionDir: string;
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	serviceTier: ServiceTier;
	scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	activeToolNames: string[];
	allowedToolNames?: string[];
	customTools: ToolDefinition[];
	includeGoals: boolean;
	includeCompactSkill: boolean;
	rlmDepth: number;
	rlmMaxDepth: number;
	rlmParentNodeId: string;
	/** Request ID of the parent model call whose tool call caused this spawn. */
	spawnedByRequestId?: string;
	/** Source of the Python cell that spawned this subagent, for display. */
	spawnCode?: string;
	/** Publish the session to the parent before a host makes the runtime addressable. */
	onSessionPublished?: (session: AgentSession) => void;
}

export interface CreateRlmRootSessionOptions {
	prompt: string;
	sessionName?: string;
	cwd: string;
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
}

export interface SubagentRuntimeHost {
	createRlmSubagentRuntime(options: CreateRlmSubagentRuntimeOptions): Promise<RlmSubagentRuntime>;
	createRlmRootSession?(options: CreateRlmRootSessionOptions): Promise<RlmCreateSessionResult>;
	/** Persist host-owned completion before the child becomes passivation-eligible. */
	completeRlmSubagentRuntime?(childId: string, session: AgentSession): boolean;
	/** Release a host-owned child after its detached initial task settles. */
	releaseRlmSubagentRuntime?: (
		runtime: RlmSubagentRuntime,
		options: CreateRlmSubagentRuntimeOptions,
		status: "done" | "error" | "cancelled",
	) => Promise<void>;
	/** Close or remove the host-owned child; session is absent when a persisted child is still passive. */
	deleteRlmSubagentRuntime(childId: string, session?: AgentSession): Promise<void>;
	disposeRlmSubagentRuntimes?(): Promise<void>;
}
