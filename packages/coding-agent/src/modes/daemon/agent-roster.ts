// One status formula shared by every agent surface; surfaces adapt their inputs and never reimplement it.
export type AgentRosterStatus = "running" | "idle" | "inactive";

export interface AgentStatusInput {
	/** A live runtime exists for the agent. */
	resident: boolean;
	/** Admitted child run whose session has not materialized yet. */
	queuedChild: boolean;
	/** Actively working: streaming, running tools/bash, or running children. */
	busy: boolean;
	hasActiveHeartbeat: boolean;
}

export function classifyAgentStatus(input: AgentStatusInput): AgentRosterStatus {
	if (input.queuedChild) return "running";
	if (!input.resident) return "inactive";
	return input.busy || input.hasActiveHeartbeat ? "running" : "idle";
}
