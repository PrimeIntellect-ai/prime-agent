import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentAutonomousConfig } from "./autonomous.js";

export type AgentExecutionMode = "interactive" | "print" | "json" | "rpc" | "acp";

export interface AgentSessionRuntimeConfig {
	cwd?: string;
	agentDir?: string;
	sessionDir?: string;
	provider?: string;
	model?: string;
	apiKey?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	thinking?: ThinkingLevel;
	models?: string[];
	tools?: string[];
	noTools?: boolean;
	noBuiltinTools?: boolean;
	extensions?: string[];
	noExtensions?: boolean;
	skills?: string[];
	noSkills?: boolean;
	promptTemplates?: string[];
	noPromptTemplates?: boolean;
	themes?: string[];
	noThemes?: boolean;
	noContextFiles?: boolean;
	autonomous?: AgentAutonomousConfig;
	extensionFlagValues?: Record<string, boolean | string>;
	/**
	 * When true, auto-refine runs synchronously between turns at the
	 * shouldStopAfterTurn boundary instead of in the background after
	 * agent_end. Passed from the JSON/print client to the daemon worker
	 * so it survives the appMode="daemon" context switch.
	 */
	serializedRefine?: boolean;
	/** User-facing client mode that created this session. The daemon is transport, not an execution mode. */
	executionMode?: AgentExecutionMode;
	/** Opt-out-only policy carried across daemon process boundaries. */
	telemetryDisabled?: true;
	/**
	 * Initial goal to seed when creating a new top-level session (rlmDepth 0).
	 * Ignored for subagent sessions and when the branch already has a persisted
	 * thread_goal_state entry (idempotent restart/rehydration).
	 */
	initialGoal?: { objective: string; tokenBudget?: number };
}

export function mergeAgentSessionRuntimeConfig(
	base: AgentSessionRuntimeConfig,
	override?: AgentSessionRuntimeConfig,
): AgentSessionRuntimeConfig {
	if (!override) {
		return cloneAgentSessionRuntimeConfig(base);
	}
	return {
		cwd: override.cwd ?? base.cwd,
		agentDir: override.agentDir ?? base.agentDir,
		sessionDir: override.sessionDir ?? base.sessionDir,
		provider: override.provider ?? base.provider,
		model: override.model ?? base.model,
		apiKey: override.apiKey ?? base.apiKey,
		systemPrompt: override.systemPrompt ?? base.systemPrompt,
		appendSystemPrompt: cloneArray(override.appendSystemPrompt ?? base.appendSystemPrompt),
		thinking: override.thinking ?? base.thinking,
		models: cloneArray(override.models ?? base.models),
		tools: cloneArray(override.tools ?? base.tools),
		noTools: override.noTools ?? base.noTools,
		noBuiltinTools: override.noBuiltinTools ?? base.noBuiltinTools,
		extensions: cloneArray(override.extensions ?? base.extensions),
		noExtensions: override.noExtensions ?? base.noExtensions,
		skills: cloneArray(override.skills ?? base.skills),
		noSkills: override.noSkills ?? base.noSkills,
		promptTemplates: cloneArray(override.promptTemplates ?? base.promptTemplates),
		noPromptTemplates: override.noPromptTemplates ?? base.noPromptTemplates,
		themes: cloneArray(override.themes ?? base.themes),
		noThemes: override.noThemes ?? base.noThemes,
		noContextFiles: override.noContextFiles ?? base.noContextFiles,
		autonomous: mergeAutonomousConfig(base.autonomous, override.autonomous),
		extensionFlagValues:
			base.extensionFlagValues || override.extensionFlagValues
				? { ...(base.extensionFlagValues ?? {}), ...(override.extensionFlagValues ?? {}) }
				: undefined,
		serializedRefine: override.serializedRefine ?? base.serializedRefine,
		executionMode: override.executionMode ?? base.executionMode,
		telemetryDisabled: base.telemetryDisabled || override.telemetryDisabled ? true : undefined,
		initialGoal: override.initialGoal ?? base.initialGoal,
	};
}

function cloneAgentSessionRuntimeConfig(config: AgentSessionRuntimeConfig): AgentSessionRuntimeConfig {
	return {
		...config,
		appendSystemPrompt: cloneArray(config.appendSystemPrompt),
		models: cloneArray(config.models),
		tools: cloneArray(config.tools),
		extensions: cloneArray(config.extensions),
		skills: cloneArray(config.skills),
		promptTemplates: cloneArray(config.promptTemplates),
		themes: cloneArray(config.themes),
		autonomous: mergeAutonomousConfig(undefined, config.autonomous),
		extensionFlagValues: config.extensionFlagValues ? { ...config.extensionFlagValues } : undefined,
		serializedRefine: config.serializedRefine,
		executionMode: config.executionMode,
		telemetryDisabled: config.telemetryDisabled,
		initialGoal: config.initialGoal ? { ...config.initialGoal } : undefined,
	};
}

export function mergeAutonomousConfig(
	base: AgentAutonomousConfig | undefined,
	override: AgentAutonomousConfig | undefined,
): AgentAutonomousConfig | undefined {
	if (!base && !override) {
		return undefined;
	}
	const gates = mergeAutonomousGateConfig(base?.gates, override?.gates);
	return {
		...(base ?? {}),
		...(override ?? {}),
		...(gates ? { gates } : {}),
	};
}

function mergeAutonomousGateConfig(
	base: AgentAutonomousConfig["gates"] | undefined,
	override: AgentAutonomousConfig["gates"] | undefined,
): AgentAutonomousConfig["gates"] | undefined {
	if (!base && !override) {
		return undefined;
	}
	return {
		...(base ?? {}),
		...(override ?? {}),
		...(override?.commands !== undefined || base?.commands !== undefined
			? { commands: cloneArray(override?.commands ?? base?.commands) }
			: {}),
	};
}

function cloneArray<T>(value: T[] | undefined): T[] | undefined {
	return value ? [...value] : undefined;
}
