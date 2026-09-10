import {
	type AgentSessionMessageController,
	type AgentSessionMessageReceipt,
	assertDirectAgentMessageTarget,
	normalizeAgentSessionMessage,
} from "../core/agent-messages.js";

export function handleAgentMessageHostRequest(
	getController: () => AgentSessionMessageController | undefined,

	type: string,
	payload: Record<string, unknown> = {},
): Promise<AgentSessionMessageReceipt> {
	if (!getController()) {
		throw new Error("agent messaging is not available in this session");
	}
	switch (type) {
		case "agent_message.send": {
			if (typeof payload.target !== "string") {
				throw new Error("agent_message.send target must be a string");
			}
			if (typeof payload.message !== "string") {
				throw new Error("agent_message.send message must be a string");
			}
			return getController()!.sendAgentMessage({
				target: assertDirectAgentMessageTarget(payload.target),
				message: normalizeAgentSessionMessage(payload.message),
			});
		}
		default:
			throw new Error(`unknown agent message request type "${type}"`);
	}
}
