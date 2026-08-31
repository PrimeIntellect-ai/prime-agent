import type { AgentConnectionHeartbeat } from "../agent-connection/types.js";
import type { DaemonClient } from "./daemon-client.js";
import { deserializeDaemonError } from "./daemon-errors.js";
import { isUnknownDaemonCommandError } from "./daemon-protocol.js";

export async function listDaemonHeartbeats(
	client: DaemonClient,
	activeSessionId?: string,
): Promise<AgentConnectionHeartbeat[]> {
	if (!client.hello) await client.waitForHello();
	if (!client.supportsServerCapability("heartbeat_catalog")) return [];
	try {
		const command = { type: "heartbeats_list", ...(activeSessionId ? { activeSessionId } : {}) } as const;
		const response = await client.request(command);
		if (!response.success) {
			throw deserializeDaemonError(response);
		}
		return (response.data as { heartbeats: AgentConnectionHeartbeat[] }).heartbeats;
	} catch (error) {
		if (isUnknownDaemonCommandError(error, "heartbeats_list")) {
			return [];
		}
		throw error;
	}
}
