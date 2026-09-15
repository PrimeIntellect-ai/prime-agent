/**
 * Daemon-owned digest-lane controller (swarm communication PR D).
 *
 * The daemon decides the delivery lane; senders never opt in or out (a sender
 * always prefers steering its recipient). Per-recipient counters with
 * hysteresis: one crossed trigger switches push -> digest, and only all
 * triggers relaxed below their half values switch back. A user pin on the
 * session ("push"/"digest") suspends the controller entirely.
 *
 * Default thresholds are the pre-registered design values; the starvation eval
 * (PR B) exists to check they sit at the measured crossing point.
 */

export interface AgentMessageDigestControllerOptions {
	/** Switch to digest when the arrivals EMA reaches this value. Default 5. */
	pendingEmaTrigger?: number;
	/** Switch to digest when the agent-message context share reaches this value. Default 0.2. */
	ingestionShareTrigger?: number;
	/** Switch to digest when the ingestion-turn share reaches this value. Default 0.3. */
	ingestionTurnShareTrigger?: number;
	/** EMA smoothing factor per evaluation. Default 0.3. */
	emaAlpha?: number;
}

export interface AgentMessageDigestEvaluation {
	/** Agent-message arrivals in the trailing window ( MessagingStats.arrivals.last5m ). */
	pending: number;
	/** Agent-message share of working context, when measurable. */
	ingestionShare: number | null;
	/** Ingestion steps over all model steps, when measurable. */
	ingestionTurnShare: number | null;
	currentMode: "push" | "digest";
}

export type AgentMessageDigestDecisionReason =
	| "pending-pressure"
	| "ingestion-context-share"
	| "ingestion-turn-share"
	| "recovered"
	| "hold";

export interface AgentMessageDigestDecision {
	mode: "push" | "digest";
	changed: boolean;
	reason: AgentMessageDigestDecisionReason;
	pendingEma: number;
}

export class AgentMessageDigestController {
	private readonly pendingEmaTrigger: number;
	private readonly ingestionShareTrigger: number;
	private readonly ingestionTurnShareTrigger: number;
	private readonly emaAlpha: number;
	private pendingEma = 0;
	private observed = false;

	constructor(options: AgentMessageDigestControllerOptions = {}) {
		this.pendingEmaTrigger = options.pendingEmaTrigger ?? 5;
		this.ingestionShareTrigger = options.ingestionShareTrigger ?? 0.2;
		this.ingestionTurnShareTrigger = options.ingestionTurnShareTrigger ?? 0.3;
		this.emaAlpha = options.emaAlpha ?? 0.3;
	}

	evaluate(input: AgentMessageDigestEvaluation): AgentMessageDigestDecision {
		this.pendingEma = this.observed
			? this.emaAlpha * input.pending + (1 - this.emaAlpha) * this.pendingEma
			: input.pending;
		this.observed = true;

		if (input.currentMode === "push") {
			// Any single trigger crossed: switch before starvation compounds.
			if (this.pendingEma >= this.pendingEmaTrigger) {
				return { mode: "digest", changed: true, reason: "pending-pressure", pendingEma: this.pendingEma };
			}
			if (input.ingestionShare !== null && input.ingestionShare >= this.ingestionShareTrigger) {
				return { mode: "digest", changed: true, reason: "ingestion-context-share", pendingEma: this.pendingEma };
			}
			if (input.ingestionTurnShare !== null && input.ingestionTurnShare >= this.ingestionTurnShareTrigger) {
				return { mode: "digest", changed: true, reason: "ingestion-turn-share", pendingEma: this.pendingEma };
			}
			return { mode: "push", changed: false, reason: "hold", pendingEma: this.pendingEma };
		}

		// Digest -> push only when every trigger is relaxed below half value.
		const recovered =
			this.pendingEma < this.pendingEmaTrigger / 2 &&
			(input.ingestionShare === null || input.ingestionShare < this.ingestionShareTrigger / 2) &&
			(input.ingestionTurnShare === null || input.ingestionTurnShare < this.ingestionTurnShareTrigger / 2);
		return {
			mode: recovered ? "push" : "digest",
			changed: recovered,
			reason: recovered ? "recovered" : "hold",
			pendingEma: this.pendingEma,
		};
	}
}
