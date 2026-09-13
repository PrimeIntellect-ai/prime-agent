import {
	type AgentObserveAgentSnapshot,
	type AgentObserveController,
	type AgentObserveListResult,
	type AgentObserveRecentMessagesResult,
	normalizeObserveLimit,
	normalizeObserveMaxChars,
} from "../../core/agent-observe.js";

export function handleAgentObserveHostRequest(
	controller: AgentObserveController | undefined,

	type: string,
	payload: Record<string, unknown> = {},
):
	| AgentObserveListResult
	| AgentObserveAgentSnapshot
	| AgentObserveRecentMessagesResult
	| Promise<AgentObserveListResult | AgentObserveAgentSnapshot | AgentObserveRecentMessagesResult> {
	if (!controller) {
		throw new Error("agent observation is not available in this session");
	}
	switch (type) {
		case "agent_observe.list":
			return controller.listAgents();
		case "agent_observe.get": {
			if (typeof payload.target !== "string") {
				throw new Error("agent_observe.get target must be a string");
			}
			return controller.getAgent(payload.target);
		}
		case "agent_observe.recent": {
			if (typeof payload.target !== "string") {
				throw new Error("agent_observe.recent target must be a string");
			}
			return controller.recentMessages({
				target: payload.target,
				limit: normalizeObserveLimit(payload.limit as number | undefined),
				maxChars: normalizeObserveMaxChars((payload.max_chars ?? payload.maxChars) as number | undefined),
			});
		}
		default:
			throw new Error(`unknown agent observe request type "${type}"`);
	}
}
