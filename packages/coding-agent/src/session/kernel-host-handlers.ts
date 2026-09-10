import type { Api, Model } from "@earendil-works/pi-ai";
import {
	AGENT_MESSAGE_SKILL_NAME,
	type AgentSessionMessageController,
	type AgentSessionMessageReceipt,
	agentFamilyMemberName,
	createAgentMessageHostHandlers,
} from "../core/agent-messages.js";
import {
	type AgentObserveAgentSnapshot,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	createAgentObserveHostHandlers,
} from "../core/agent-observe.js";
import type { HostRequestHandlers } from "../core/kernel/index.js";
import type { McpManager } from "../core/mcp/mcp-manager.js";
import type { AsyncBashCompletionDetails } from "../core/messages.js";
import {
	createAsyncBashCompletionHostHandler,
	createAsyncBashConsumedHostHandler,
	createRlmCreateSessionHostHandler,
	createRlmDeleteSubagentHostHandler,
	createRlmFindModelsHostHandler,
	createRlmListSubagentsHostHandler,
	createRlmRunHostHandler,
	type RlmCreateSessionResult,
	type RlmDeleteSubagentResult,
	type RlmFindModelsResult,
	type RlmListSubagentsResult,
	type RlmSpawnHandle,
} from "../core/rlm-runtime.js";
import type { Skill } from "../core/skills.js";

type ObserveResult = AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult;
export interface SessionKernelOperations {
	runChild(prompt: string, kwargs: Record<string, unknown>, cellSourceCode?: string): Promise<RlmSpawnHandle>;
	createSession(prompt: string, kwargs: Record<string, unknown>): Promise<RlmCreateSessionResult>;
	findModels(query: string, limit: number): Promise<RlmFindModelsResult>;
	listSubagents(): Promise<RlmListSubagentsResult>;
	deleteSubagent(target: string): Promise<RlmDeleteSubagentResult>;
	handleBashCompletion(details: AsyncBashCompletionDetails): Promise<void>;
	withdrawBashCompletion(details: { pid: number; command: string }): void;
	getModel(): Model<Api> | undefined;
	includeGoals: boolean;
	includeCompactSkill: boolean;
	isRefineAllowed(): boolean;
	hasHeartbeatController(): boolean;
	getModelVisibleSkills(): Skill[];
	getAgentMessageController(): AgentSessionMessageController | undefined;
	hasObserveController(): boolean;
	getMcpManager(): McpManager | undefined;
	getDepth(): number;
	awaitChildPublication(selector: string): Promise<string | undefined>;
	recordParentReply(): void;
	handleGoal(type: string, payload: Record<string, unknown>): Record<string, unknown>;
	handleCompact(type: string, payload: Record<string, unknown>): Record<string, unknown>;
	handleRefine(type: string, payload: Record<string, unknown>): Record<string, unknown>;
	handleHeartbeat(type: string, payload: Record<string, unknown>): Record<string, unknown>;
	handleMessage(type: string, payload?: Record<string, unknown>): Promise<AgentSessionMessageReceipt>;
	handleObserve(type: string, payload?: Record<string, unknown>): ObserveResult | Promise<ObserveResult>;
}
export function createSessionKernelHostHandlers(host: SessionKernelOperations): HostRequestHandlers {
	const handlers: HostRequestHandlers = {
		"rlm.run": createRlmRunHostHandler(async ({ prompt, kwargs, cellSourceCode }) => ({
			...(await host.runChild(prompt, kwargs, cellSourceCode)),
		})),
		"rlm.create_session": createRlmCreateSessionHostHandler(async ({ prompt, kwargs }) => ({
			...(await host.createSession(prompt, kwargs)),
		})),
		"bash.completed": createAsyncBashCompletionHostHandler((details) => host.handleBashCompletion(details)),
		"bash.consumed": createAsyncBashConsumedHostHandler((details) => {
			host.withdrawBashCompletion(details);
		}),
		"rlm.find_models": createRlmFindModelsHostHandler((query, limit) => host.findModels(query, limit)),
		"rlm.list_subagents": createRlmListSubagentsHostHandler(() => host.listSubagents()),
		"rlm.delete_subagent": createRlmDeleteSubagentHostHandler((target) => host.deleteSubagent(target)),
		"model.info": async () => ({
			id: host.getModel()?.id ?? null,
			provider: host.getModel()?.provider ?? null,
			input: host.getModel()?.input ?? [],
		}),
	};
	if (host.includeGoals) {
		for (const type of ["goal.get", "goal.create", "goal.complete"]) {
			handlers[type] = async (payload) => host.handleGoal(type, payload);
		}
	}
	if (host.includeCompactSkill) {
		for (const type of ["compact.run", "compact.status"]) {
			handlers[type] = async (payload) => host.handleCompact(type, payload);
		}
	}
	if (host.isRefineAllowed()) {
		for (const type of ["refine.run", "refine.status"]) {
			handlers[type] = async (payload) => host.handleRefine(type, payload);
		}
	}
	if (host.hasHeartbeatController()) {
		for (const type of [
			"rlm_heartbeat.list",
			"rlm_heartbeat.create",
			"rlm_heartbeat.update",
			"rlm_heartbeat.delete",
		]) {
			handlers[type] = async (payload) => host.handleHeartbeat(type, payload);
		}
	}
	const visibleKernelSkillNames = new Set(
		host
			.getModelVisibleSkills()
			.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => skill.name),
	);
	const messageController = host.getAgentMessageController();
	if (messageController && visibleKernelSkillNames.has(AGENT_MESSAGE_SKILL_NAME)) {
		Object.assign(
			handlers,
			createAgentMessageHostHandlers({
				family: async () => {
					if (!messageController.family) throw new Error("agent family roster is not available in this session");
					return messageController.family();
				},
				awaitPendingChildPublication: (selector) => host.awaitChildPublication(selector),
				sendAgentMessage: async (input) => {
					const receipt = (await host.handleMessage("agent_message.send", {
						target: input.target,
						message: input.message,
					})) as AgentSessionMessageReceipt;
					if (host.getDepth() > 0) {
						let addressedParent = input.receiverRole === "parent";
						if (input.receiverRole === undefined && messageController.family) {
							try {
								addressedParent = (await messageController.family()).some(
									(member) =>
										member.relationship === "parent" &&
										(member.entry.id === input.target ||
											agentFamilyMemberName(member.entry) === input.target),
								);
							} catch {
								addressedParent = false;
							}
						}
						if (addressedParent) {
							host.recordParentReply();
						}
					}
					return receipt;
				},
			}),
		);
	}
	if (host.hasObserveController()) {
		Object.assign(
			handlers,
			createAgentObserveHostHandlers({
				listAgents: () => host.handleObserve("agent_observe.list") as AgentObserveListResult,
				getAgent: (target) =>
					host.handleObserve("agent_observe.get", {
						target,
					}) as AgentObserveAgentSnapshot,
				recentMessages: (input) =>
					host.handleObserve("agent_observe.recent", {
						target: input.target,
						limit: input.limit,
						max_chars: input.maxChars,
					}) as AgentObserveRecentMessagesResult,
			}),
		);
	}
	const mcpManager = host.getMcpManager();
	if (mcpManager) {
		Object.assign(handlers, mcpManager.hostHandlers());
	}
	return handlers;
}
