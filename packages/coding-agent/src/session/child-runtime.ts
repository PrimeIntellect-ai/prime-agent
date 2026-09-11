import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "../core/agent-session.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { ResourceLoader } from "../core/resource-loader.js";
import type { CreateRlmSubagentRuntimeOptions, RlmSubagentRuntime } from "../core/rlm-runtime.js";
import { SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";

export interface InlineChildRuntimeHost {
	cwd: string;
	agentDir?: string;
	agent: Pick<
		Agent,
		"convertToLlm" | "transformContext" | "streamFn" | "getApiKey" | "onPayload" | "onResponse" | "toolExecution"
	>;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	modelRegistry: ModelRegistry;
}
export function createInlineChildRuntime(
	host: InlineChildRuntimeHost,
	options: CreateRlmSubagentRuntimeOptions,
): RlmSubagentRuntime {
	const childSessionManager = SessionManager.create(host.cwd, options.sessionDir);
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
		convertToLlm: host.agent.convertToLlm,
		transformContext: host.agent.transformContext,
		streamFn: host.agent.streamFn,
		getApiKey: host.agent.getApiKey,
		onPayload: host.agent.onPayload,
		onResponse: host.agent.onResponse,
		steeringMode: host.settingsManager.getSteeringMode(),
		followUpMode: host.settingsManager.getFollowUpMode(),
		sessionId: childSessionManager.getSessionId(),
		thinkingBudgets: host.settingsManager.getThinkingBudgets(),
		transport: host.settingsManager.getTransport(),
		toolExecution: host.agent.toolExecution,
	});

	const child = new AgentSession({
		agent: childAgent,
		sessionManager: childSessionManager,
		settingsManager: host.settingsManager,
		cwd: host.cwd,
		agentDir: host.agentDir,
		scopedModels: options.scopedModels,
		resourceLoader: host.resourceLoader,
		customTools: options.customTools,
		modelRegistry: host.modelRegistry,
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

export function createChildSessionDir(getParentDir: () => string): string {
	const parentDir = getParentDir();
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
