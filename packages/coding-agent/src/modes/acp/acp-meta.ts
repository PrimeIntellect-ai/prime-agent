/**
 * Namespaced `_meta` payloads for prime-agent capabilities that ACP has no
 * native concept for (Python cell semantics, RLM subagents, autonomous gates,
 * goals, heartbeats, continual harness state).
 *
 * ACP reserves `_meta` on capability objects, notifications, tool calls, and
 * content blocks precisely so agents can carry non-standard data. Vanilla ACP
 * clients ignore these keys; a prime-agent-aware client (or the verifiers
 * harness) reads them. Never add non-standard fields to an ACP object root.
 */

/** Reverse-domain namespace for every prime-agent `_meta` payload. */
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
	/** Media the cell loaded into context, as reported by the ipython tool. */
	attachments?: PrimeAgentIpythonAttachmentMeta[];
	/** Number of diffs the cell displayed. */
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

export interface PrimeAgentQuiescenceMeta {
	/** Subagents that have not reached a terminal state at the observation point. */
	outstandingSubagents: number;
	/** Autonomous continuation slots still available at the observation point. */
	remainingAutonomousContinuations: number;
}

export interface PrimeAgentAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface PrimeAgentCwdMeta {
	/** The cwd the client asked for. */
	requested: string;
	/** The cwd prime-agent is actually running in, fixed at startup. */
	actual: string;
}

/**
 * Producer-side ordering and causality for ACP updates.
 *
 * `promptTurnId` is allocated when ACP accepts a prompt, never inferred from
 * whichever prompt happens to be running when an update is delivered. `0`
 * means a session-scoped event with no prompt origin (for example a heartbeat
 * change before the first prompt). `eventSequence` is connection-wide and
 * strictly increases for every update Prime Agent publishes.
 */
export type PrimeAgentEventPhase = "event" | "responseBoundary" | "terminalQuiescence";

/** The outcome carried by a correlated response boundary and terminal envelope. */
export type PrimeAgentResponseOutcome = "result" | "error";

export interface PrimeAgentSessionMeta {
	/** Monotonically increasing ACP prompt turn which caused this update. */
	promptTurnId?: number;
	/** Strictly increasing producer sequence, across all ACP updates. */
	eventSequence?: number;
	/** Whether this is ordinary work, the prompt response boundary, or final quiescence. */
	phase?: PrimeAgentEventPhase;
	/**
	 * The boundary/terminal outcome. This deliberately has only `result` and
	 * `error`: ACP's transport stop reasons (including `end_turn`) are never a
	 * causal completion signal.
	 */
	outcome?: PrimeAgentResponseOutcome;
	/** Whether an accepted response boundary promises a later terminal-quiescence envelope. */
	terminalQuiescenceExpected?: boolean;
	/** Present when a client-requested cwd differs from the agent's real cwd. */
	cwd?: PrimeAgentCwdMeta;
	/** Set when the session's heartbeat or cron schedule changed. */
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
	/** Observed subagent and autonomous-continuation counts at completion. */
	quiescence?: PrimeAgentQuiescenceMeta;
	ipython?: PrimeAgentIpythonMeta;
}

/** Wrap a prime-agent payload in its reverse-domain `_meta` envelope. */
export function primeAgentMeta(payload: PrimeAgentSessionMeta): Record<string, unknown> {
	return { [PRIME_AGENT_META_NAMESPACE]: payload };
}
