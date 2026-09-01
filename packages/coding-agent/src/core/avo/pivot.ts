import { deriveAvoEvaluation } from "./evaluator.js";
import type { AvoCandidate, AvoRunState } from "./types.js";

function hasAuthoritativeRevision(state: AvoRunState, candidate: AvoCandidate): boolean {
	const derived = deriveAvoEvaluation(
		state.evaluations.filter((evaluation) => evaluation.candidateId === candidate.candidateId),
	);
	return derived.status === "fail" || derived.status === "revise";
}

export function requiredAvoCodingPivotParent(state: AvoRunState): AvoCandidate | undefined {
	if (state.routing.environment !== "coding") return undefined;
	const latest = state.candidates.at(-1);
	return latest && hasAuthoritativeRevision(state, latest) ? latest : undefined;
}

export interface AvoCodingPivotSummary {
	required: number;
	material: number;
	pending: number;
}

export function deriveAvoCodingPivotSummary(state: AvoRunState): AvoCodingPivotSummary {
	if (state.routing.environment !== "coding") return { required: 0, material: 0, pending: 0 };
	const revised = state.candidates.filter((candidate) => hasAuthoritativeRevision(state, candidate));
	const material = revised.filter((parent) =>
		state.candidates.some(
			(candidate) =>
				candidate.parentCandidateId === parent.candidateId &&
				typeof candidate.workspaceDigest === "string" &&
				typeof parent.workspaceDigest === "string" &&
				candidate.workspaceDigest !== parent.workspaceDigest,
		),
	).length;
	return { required: revised.length, material, pending: revised.length - material };
}
