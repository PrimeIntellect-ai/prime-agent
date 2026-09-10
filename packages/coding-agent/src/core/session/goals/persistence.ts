import {
	emptyGoalState,
	GOAL_STATE_CUSTOM_TYPE,
	type GoalState,
	isPersistedGoalState,
	normalizeGoalState,
} from "../../goals.js";
import type { SessionManager } from "../../session-manager.js";

export interface GoalPersistence {
	load(): GoalState;
	save(goal: GoalState): void;
}

export function createGoalPersistence(
	session: Pick<SessionManager, "getBranch" | "appendCustomEntry" | "flushNow">,
): GoalPersistence & { canSeed(): boolean } {
	return {
		load() {
			const branch = session.getBranch();
			for (let i = branch.length - 1; i >= 0; i--) {
				const entry = branch[i];
				if (
					entry.type === "custom" &&
					entry.customType === GOAL_STATE_CUSTOM_TYPE &&
					isPersistedGoalState(entry.data)
				) {
					return normalizeGoalState(entry.data);
				}
			}
			return emptyGoalState();
		},
		save(goal) {
			session.appendCustomEntry(GOAL_STATE_CUSTOM_TYPE, goal);
			// Restart must see the goal even before the first assistant response.
			session.flushNow();
		},
		canSeed() {
			// Any message or custom entry, including a cleared goal, means this branch was used.
			return session
				.getBranch()
				.every(
					(entry) =>
						entry.type === "model_change" ||
						entry.type === "thinking_level_change" ||
						entry.type === "service_tier_change",
				);
		},
	};
}
