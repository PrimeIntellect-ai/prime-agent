/**
 * Per-session messaging instrumentation for swarm starvation measurement.
 *
 * Counters feed the pre-registered defense lines of the swarm communication
 * eval: context share (estimated agent-message tokens over working context),
 * turn share (agent-triggered model steps over all steps), and cost share
 * (agent-triggered step tokens over all step tokens). Pure counters: no
 * delivery behavior depends on this module.
 */

export const MESSAGING_STATS_WINDOW_MS = 5 * 60 * 1000;
const MESSAGING_STATS_MAX_EVENTS = 5_000;

interface TimestampedTokens {
	t: number;
	tokens: number;
}

export interface MessagingStatsSnapshot {
	/** Accepted inbound agent messages (delivered or queued). */
	arrivals: { total: number; last5m: number };
	/** Completed model steps with usage; a run may contain several. */
	model_steps: { total: number; last5m: number; tokens: number };
	/** Steps in runs triggered by an agent message. */
	ingestion_steps: { total: number; last5m: number; tokens: number };
	/** Heuristic context share of agent-message content (chars / 4). */
	context: {
		estimated_agent_message_tokens: number;
		context_tokens: number | null;
		/** estimated_agent_message_tokens / context_tokens, when both known. */
		share: number | null;
	};
	sends: { attempts: number; failures: number };
}

export class MessagingStats {
	private readonly windowMs: number;
	private readonly maxEvents: number;
	private arrivals: number[] = [];
	private steps: TimestampedTokens[] = [];
	private ingestionSteps: TimestampedTokens[] = [];
	private sendAttempts = 0;
	private sendFailures = 0;

	constructor(options: { windowMs?: number; maxEvents?: number } = {}) {
		this.windowMs = options.windowMs ?? MESSAGING_STATS_WINDOW_MS;
		this.maxEvents = options.maxEvents ?? MESSAGING_STATS_MAX_EVENTS;
	}

	/** One accepted inbound agent message. */
	recordArrival(now = Date.now()): void {
		this.arrivals.push(now);
		if (this.arrivals.length > this.maxEvents) this.arrivals.splice(0, this.arrivals.length - this.maxEvents);
	}

	/** One completed model step with its usage tokens. */
	recordModelStep(tokens: number, ingestion: boolean, now = Date.now()): void {
		const event = { t: now, tokens };
		this.steps.push(event);
		if (this.steps.length > this.maxEvents) this.steps.splice(0, this.steps.length - this.maxEvents);
		if (!ingestion) return;
		this.ingestionSteps.push(event);
		if (this.ingestionSteps.length > this.maxEvents) {
			this.ingestionSteps.splice(0, this.ingestionSteps.length - this.maxEvents);
		}
	}

	/** One outbound agent-message send attempt; failed rejections count both. */
	recordSendAttempt(failed: boolean): void {
		this.sendAttempts += 1;
		if (failed) this.sendFailures += 1;
	}

	snapshot(
		context: { contextTokens: number | undefined; estimatedAgentMessageTokens: number },
		now = Date.now(),
	): MessagingStatsSnapshot {
		const windowStart = now - this.windowMs;
		const inWindow = (events: TimestampedTokens[]) => events.filter((event) => event.t >= windowStart);
		const arrivalWindow = this.arrivals.filter((t) => t >= windowStart);
		const stepWindow = inWindow(this.steps);
		const ingestionWindow = inWindow(this.ingestionSteps);
		const totalTokens = this.steps.reduce((sum, event) => sum + event.tokens, 0);
		const ingestionTokens = this.ingestionSteps.reduce((sum, event) => sum + event.tokens, 0);
		return {
			arrivals: { total: this.arrivals.length, last5m: arrivalWindow.length },
			model_steps: {
				total: this.steps.length,
				last5m: stepWindow.length,
				tokens: totalTokens,
			},
			ingestion_steps: {
				total: this.ingestionSteps.length,
				last5m: ingestionWindow.length,
				tokens: ingestionTokens,
			},
			context: {
				estimated_agent_message_tokens: context.estimatedAgentMessageTokens,
				context_tokens: context.contextTokens ?? null,
				share:
					context.contextTokens && context.contextTokens > 0
						? Math.min(1, context.estimatedAgentMessageTokens / context.contextTokens)
						: null,
			},
			sends: { attempts: this.sendAttempts, failures: this.sendFailures },
		};
	}
}

/** Heuristic token estimate for agent-message text: ~4 characters per token. */
export function estimateMessagingTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

/**
 * Pre-registered defense lines for the swarm starvation eval. A config is
 * defensible only if all three lines hold; any line failing is a starvation
 * finding, any line unknown keeps the verdict inconclusive rather than pass.
 */
export const MESSAGING_DEFENSE_LINE_LIMITS = {
	/** Agent-message share of working context. */
	contextShare: 0.25,
	/** Agent-triggered model steps over all model steps. */
	turnShare: 1 / 3,
	/** Ingestion-step usage tokens over all step usage tokens. */
	costShare: 0.2,
} as const;

export interface MessagingDefenseLine {
	value: number | null;
	limit: number;
	passed: boolean | null;
}

export interface MessagingDefenseLines {
	contextShare: MessagingDefenseLine;
	turnShare: MessagingDefenseLine;
	costShare: MessagingDefenseLine;
	/** "fail" if any line failed; "inconclusive" if any line is unknown and none failed; else "pass". */
	verdict: "pass" | "fail" | "inconclusive";
}

export function evaluateMessagingDefenseLines(
	snapshot: MessagingStatsSnapshot,
	limits: Partial<Record<keyof typeof MESSAGING_DEFENSE_LINE_LIMITS, number>> = {},
): MessagingDefenseLines {
	const contextLimit = limits.contextShare ?? MESSAGING_DEFENSE_LINE_LIMITS.contextShare;
	const turnLimit = limits.turnShare ?? MESSAGING_DEFENSE_LINE_LIMITS.turnShare;
	const costLimit = limits.costShare ?? MESSAGING_DEFENSE_LINE_LIMITS.costShare;
	const line = (value: number | null, limit: number): MessagingDefenseLine => ({
		value,
		limit,
		passed: value === null ? null : value <= limit,
	});
	const contextLine = line(snapshot.context.share, contextLimit);
	const turnLine = line(
		snapshot.model_steps.total > 0 ? snapshot.ingestion_steps.total / snapshot.model_steps.total : null,
		turnLimit,
	);
	const costLine = line(
		snapshot.model_steps.tokens > 0 ? snapshot.ingestion_steps.tokens / snapshot.model_steps.tokens : null,
		costLimit,
	);
	const lines = [contextLine, turnLine, costLine];
	const verdict = lines.some((l) => l.passed === false)
		? "fail"
		: lines.some((l) => l.passed === null)
			? "inconclusive"
			: "pass";
	return { contextShare: contextLine, turnShare: turnLine, costShare: costLine, verdict };
}
