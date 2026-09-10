import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { emptyGoalState, type GoalState, goalTokenDeltaForUsage, normalizeGoalState } from "../core/goals.js";
import type { GoalPersistence } from "./persistence.js";

export interface GoalCheckpoint {
	readonly state: Readonly<GoalState>;
	readonly accountingStartedAt: number | undefined;
}

/** Owns goal state and accounting; the session owns scheduling and runtime readiness. */
export class GoalController {
	private _state: GoalState;
	private _accountingStartedAt: number | undefined;
	private readonly _accountedAssistantMessages = new WeakSet<AssistantMessage>();

	constructor(
		private readonly _persistence: GoalPersistence,
		private readonly _onUpdate: (goal: GoalState) => void,
		private readonly _now: () => number = () => Date.now(),
	) {
		this._state = _persistence.load();
	}

	get state(): Readonly<GoalState> {
		return this._state;
	}

	get current(): GoalState {
		return { ...this._withCurrentWallClock() };
	}

	restartAccounting(): void {
		this._accountingStartedAt = this._state.status === "active" ? this._now() : undefined;
	}

	reload(): void {
		this._state = this._persistence.load();
		this.restartAccounting();
		this._onUpdate(this.current);
	}

	// The session request boundary validates the objective and budget before starting.
	start(objective: string, tokenBudget: number | undefined): GoalState {
		const now = this._now();
		this._accountingStartedAt = now;
		this._setState({
			active: true,
			status: "active",
			goalId: randomUUID(),
			objective,
			tokenBudget,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			continuationsUsed: 0,
			createdAt: now,
			updatedAt: now,
		});
		return this._state;
	}

	clear(): void {
		this._setState(emptyGoalState());
	}

	pause(reason = "Paused by user"): void {
		if (this._state.status !== "active") {
			this._onUpdate(this.current);
			return;
		}
		this._setState({
			...this._withAccountedWallClock(),
			active: false,
			status: "paused",
			lastReason: reason,
			lastError: undefined,
		});
	}

	/** Returns whether the session should schedule a continuation. */
	resume(): boolean {
		if (!this._state.objective || (this._state.status !== "paused" && this._state.status !== "budget_limited")) {
			this._onUpdate(this.current);
			return false;
		}
		const exhausted = this._state.tokenBudget !== undefined && this._state.tokensUsed >= this._state.tokenBudget;
		this._setState({
			...this._state,
			active: !exhausted,
			status: exhausted ? "budget_limited" : "active",
			lastReason: exhausted ? "Goal token budget already reached" : undefined,
			lastError: undefined,
		});
		return !exhausted;
	}

	fail(errorMessage: string): void {
		if (!this._state.objective || this._state.status !== "active") return;
		this._setState({
			...this._withAccountedWallClock(),
			active: false,
			status: "error",
			lastReason: errorMessage,
			lastError: errorMessage,
		});
	}

	complete(clearQueuedContexts: () => void): GoalState {
		if (!this._state.objective || this._state.status === "idle") {
			throw new Error("cannot complete goal because this thread has no goal");
		}
		const goal = this._withAccountedWallClock();
		// Capture usage before clearing stale budget messages, then publish completion.
		clearQueuedContexts();
		this._setState({
			...goal,
			active: false,
			status: "complete",
			lastReason: "Goal achieved",
			lastError: undefined,
		});
		return this._state;
	}

	recordContinuation(): void {
		this._setState({
			...this._state,
			continuationsUsed: this._state.continuationsUsed + 1,
			lastReason: undefined,
			lastError: undefined,
		});
	}

	cancelContinuation(): void {
		this._setState({ ...this._state, continuationsUsed: this._state.continuationsUsed - 1 });
	}

	checkpoint(): GoalCheckpoint {
		return { state: this._state, accountingStartedAt: this._accountingStartedAt };
	}

	restore(checkpoint: GoalCheckpoint, options: { restoreClock?: boolean } = {}): void {
		this._setState(checkpoint.state);
		if (options.restoreClock !== false) this._accountingStartedAt = checkpoint.accountingStartedAt;
	}

	/** Returns true only when this message newly reaches the goal budget. */
	accountAssistantMessage(message: AssistantMessage): boolean {
		if (!this._state.objective || message.stopReason === "error" || message.stopReason === "aborted") return false;
		if (this._accountedAssistantMessages.has(message) || this._state.status !== "active") return false;
		this._accountedAssistantMessages.add(message);
		const goal = this._withAccountedWallClock();
		const nextGoal = { ...goal, tokensUsed: goal.tokensUsed + goalTokenDeltaForUsage(message.usage) };
		const budgetReached = nextGoal.tokenBudget !== undefined && nextGoal.tokensUsed >= nextGoal.tokenBudget;
		if (!budgetReached) {
			this._setState(nextGoal);
			return false;
		}
		this._setState({
			...nextGoal,
			active: false,
			status: "budget_limited",
			lastReason: `Reached ${nextGoal.tokenBudget} token goal budget`,
			lastError: undefined,
		});
		return true;
	}

	private _setState(next: Readonly<GoalState>): void {
		const normalized = normalizeGoalState({ ...next, updatedAt: this._now() });
		this._state = normalized;
		if (normalized.status === "active") {
			this._accountingStartedAt ??= this._now();
		} else {
			this._accountingStartedAt = undefined;
		}
		this._persistence.save(normalized);
		this._onUpdate(this.current);
	}

	private _withCurrentWallClock(now = this._now()): GoalState {
		if (this._state.status !== "active" || !this._accountingStartedAt) return this._state;
		const elapsedSeconds = Math.floor((now - this._accountingStartedAt) / 1000);
		if (elapsedSeconds <= 0) return this._state;
		return { ...this._state, timeUsedSeconds: this._state.timeUsedSeconds + elapsedSeconds };
	}

	private _withAccountedWallClock(): GoalState {
		const now = this._now();
		const goal = this._withCurrentWallClock(now);
		if (goal !== this._state) this._accountingStartedAt = now;
		return goal;
	}
}
