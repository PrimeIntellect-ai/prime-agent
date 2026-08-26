import { randomUUID } from "node:crypto";
import type { AvoCheckpoint, AvoCycle } from "./types.js";

function trailingMatches(cycles: readonly AvoCycle[], select: (cycle: AvoCycle) => string | undefined): number {
	const value = select(cycles.at(-1)!);
	if (!value) return 0;
	let count = 0;
	for (let index = cycles.length - 1; index >= 0; index--) {
		if (select(cycles[index]!) !== value) break;
		count += 1;
	}
	return count;
}

export function evaluateAvoCheckpoint(cycles: readonly AvoCycle[], now: string): AvoCheckpoint {
	const latest = cycles.at(-1);
	const lastAcceptedIndex = [...cycles].map((cycle) => cycle.outcome).lastIndexOf("accepted");
	const cyclesSinceAcceptedProgress = lastAcceptedIndex < 0 ? cycles.length : cycles.length - lastAcceptedIndex - 1;
	const repeatedFailureCount = latest ? trailingMatches(cycles, (cycle) => cycle.failureSignature) : 0;
	const repeatedTrajectoryCount = latest ? trailingMatches(cycles, (cycle) => cycle.trajectoryFingerprint) : 0;
	const repeatedCandidateKindCount = latest ? trailingMatches(cycles, (cycle) => cycle.candidateKind) : 0;
	const triggeredHeuristics: string[] = [];
	if (cyclesSinceAcceptedProgress >= 5) triggeredHeuristics.push("no_accepted_progress_5_cycles");
	if (repeatedFailureCount >= 3) triggeredHeuristics.push("same_failure_3_cycles");
	if (repeatedTrajectoryCount >= 3) triggeredHeuristics.push("same_trajectory_3_cycles");
	const watch: string[] = [];
	if (cyclesSinceAcceptedProgress >= 3) watch.push("accepted progress is approaching the five-cycle limit");
	if (repeatedFailureCount === 2) watch.push("the last two cycles share a failure signature");
	if (repeatedTrajectoryCount === 2) watch.push("the last two cycles share a trajectory fingerprint");
	const interventionNeeded = triggeredHeuristics.length > 0;
	const status = interventionNeeded ? "intervene" : watch.length > 0 ? "watch" : "progressing";
	return {
		checkpointId: `checkpoint-${randomUUID()}`,
		cycleId: latest?.cycleId,
		status,
		reason: interventionNeeded
			? `Trajectory heuristics triggered: ${triggeredHeuristics.join(", ")}.`
			: watch.length > 0
				? watch.join("; ")
				: latest
					? "The latest cycle changed or accepted the trajectory."
					: "No cycle has been recorded yet.",
		interventionNeeded,
		triggeredHeuristics,
		progressIndicators: {
			cyclesSinceAcceptedProgress,
			repeatedFailureCount,
			repeatedTrajectoryCount,
			repeatedCandidateKindCount,
		},
		createdAt: now,
	};
}
