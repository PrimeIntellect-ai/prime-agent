/**
 * Tool wrappers for extension-registered tools.
 *
 * These wrappers only adapt tool execution so extension tools receive the runner context.
 * Tool call and tool result interception is handled by AgentSession via agent-core hooks.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.js";
import type { ExtensionRunner } from "./runner.js";
import type { RegisteredTool } from "./types.js";

type RunnerSource = ExtensionRunner | (() => ExtensionRunner);

function toRunnerGetter(source: RunnerSource): () => ExtensionRunner {
	return typeof source === "function" ? source : () => source;
}

/**
 * Wrap a RegisteredTool into an AgentTool.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTool(registeredTool: RegisteredTool, runner: RunnerSource): AgentTool {
	const getRunner = toRunnerGetter(runner);
	return wrapToolDefinition(registeredTool.definition, () =>
		getRunner().createContext(registeredTool.sourceInfo.path),
	);
}

/**
 * Wrap all registered tools into AgentTools.
 * Uses the runner's createContext() for consistent context across tools and event handlers.
 */
export function wrapRegisteredTools(registeredTools: RegisteredTool[], runner: RunnerSource): AgentTool[] {
	return registeredTools.map((registeredTool) => wrapRegisteredTool(registeredTool, runner));
}
