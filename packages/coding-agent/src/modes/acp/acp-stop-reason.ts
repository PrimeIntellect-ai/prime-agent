import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import { autonomousLimitReason } from "../../core/autonomous.js";

export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export function acpStopReason(options: { cancelled: boolean; autonomous?: AgentAutonomousStatus }): AcpStopReason {
	if (options.cancelled) return "cancelled";
	const status = options.autonomous;
	if (!status?.enabled) return "end_turn";
	const limit = autonomousLimitReason(status);
	// Token exhaustion is the one autonomous limit ACP expresses natively. Turn,
	// continuation, and wall-clock limits all mean the agent was stopped before
	// finishing, so none of them may report as a clean end_turn.
	if (limit === "maxTokens") return "max_tokens";
	if (limit) return "max_turn_requests";
	return "end_turn";
}
