export const PRIME_AGENT_META_NAMESPACE = "ai.primeintellect.prime-agent";

export interface PrimeAgentSubagentMeta {
	id: string;
	sessionName?: string;
	status: string;
	model?: string;
	depth?: number;
	tokenCount?: number;
	error?: string;
}

export interface PrimeAgentAutonomousMeta {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	gateAttempt?: number;
	gateFailure?: string;
	limitReason?: string;
}

export interface PrimeAgentIpythonAttachmentMeta {
	mimeType?: string;
	path?: string;
	bytes?: number;
}

export interface PrimeAgentIpythonMeta {
	attachments?: PrimeAgentIpythonAttachmentMeta[];
	diffCount?: number;
}

export interface PrimeAgentGoalMeta {
	status: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
}

export interface PrimeAgentRefinementMeta {
	status: "complete" | "failed";
	summary?: string;
	changes?: string[];
	error?: string;
}

export interface PrimeAgentAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface PrimeAgentCwdMeta {
	requested: string;
	actual: string;
}

export interface PrimeAgentSessionMeta {
	cwd?: PrimeAgentCwdMeta;
	heartbeatsChanged?: boolean;
	goal?: PrimeAgentGoalMeta;
	refinement?: PrimeAgentRefinementMeta;
	agentMessage?: PrimeAgentAgentMessageMeta;
	sessionId?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	compaction?: { tokensBefore?: number; summary?: string };
	subagents?: PrimeAgentSubagentMeta[];
	autonomous?: PrimeAgentAutonomousMeta;
	ipython?: PrimeAgentIpythonMeta;
}

export function primeAgentMeta(payload: PrimeAgentSessionMeta): Record<string, unknown> {
	return { [PRIME_AGENT_META_NAMESPACE]: payload };
}
