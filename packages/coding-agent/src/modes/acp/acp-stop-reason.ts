import type { AgentAutonomousStatus } from "../../core/autonomous.js";
import { autonomousLimitReason } from "../../core/autonomous.js";

/**
 * ACP stop reasons. `session/prompt` resolves with one of these after the agent
 * has streamed its updates.
 */
export type AcpStopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

/**
 * Map a finished prime-agent turn onto an ACP stop reason.
 *
 * Autonomous quality gates deliberately do NOT surface as a distinct stop
 * reason: a failing gate is a continuation inside the same prompt turn, so the
 * turn only ends once the gate loop itself is finished. What the client sees is
 * why the loop stopped, not that a gate failed mid-flight.
 */
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
