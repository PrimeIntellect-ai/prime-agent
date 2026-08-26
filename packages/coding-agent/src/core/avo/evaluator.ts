import type {
	AvoCandidate,
	AvoEvaluationAuthority,
	AvoEvaluationReceipt,
	AvoEvaluationStatus,
	AvoStopGate,
} from "./types.js";

const AUTHORITY_RANK: Record<AvoEvaluationAuthority, number> = {
	model_opinion: 0,
	external: 1,
	environment: 2,
	host: 3,
};

export interface AvoDerivedEvaluation {
	status: AvoEvaluationStatus;
	canonical: boolean;
	authoritativeReceipts: AvoEvaluationReceipt[];
	modelOpinionReceipts: AvoEvaluationReceipt[];
	reasons: string[];
}

export function isAuthoritativeAvoEvaluation(receipt: AvoEvaluationReceipt): boolean {
	return AUTHORITY_RANK[receipt.authority] >= AUTHORITY_RANK.external && receipt.evidenceRefs.length > 0;
}

export function deriveAvoEvaluation(receipts: readonly AvoEvaluationReceipt[]): AvoDerivedEvaluation {
	const authoritativeReceipts = receipts.filter(isAuthoritativeAvoEvaluation);
	const modelOpinionReceipts = receipts.filter((receipt) => !isAuthoritativeAvoEvaluation(receipt));
	const reasons: string[] = [];
	let status: AvoEvaluationStatus = "inconclusive";
	if (authoritativeReceipts.some((receipt) => receipt.status === "fail")) {
		status = "fail";
		reasons.push("an authoritative evaluator failed the candidate");
	} else if (authoritativeReceipts.some((receipt) => receipt.status === "revise")) {
		status = "revise";
		reasons.push("an authoritative evaluator requires revision");
	} else if (authoritativeReceipts.some((receipt) => receipt.status === "pass")) {
		status = "pass";
		reasons.push("at least one authoritative evaluator passed the candidate");
	} else {
		reasons.push("no evidence-backed host, environment, or external evaluation exists");
	}
	return {
		status,
		canonical: status === "pass",
		authoritativeReceipts,
		modelOpinionReceipts,
		reasons,
	};
}

export function evaluateGenericAvoStopGate(
	candidates: readonly AvoCandidate[],
	receipts: readonly AvoEvaluationReceipt[],
): AvoStopGate {
	const acceptedCandidate = [...candidates].reverse().find((candidate) => {
		const candidateReceipts = receipts.filter((receipt) => receipt.candidateId === candidate.candidateId);
		return deriveAvoEvaluation(candidateReceipts).canonical;
	});
	const checks = [
		{
			id: "candidate",
			label: "Candidate recorded",
			passed: candidates.length > 0,
			reason: candidates.length > 0 ? undefined : "no candidate or action has been recorded",
		},
		{
			id: "authoritative_evaluation",
			label: "Externally grounded evaluation",
			passed: receipts.some(isAuthoritativeAvoEvaluation),
			reason: receipts.some(isAuthoritativeAvoEvaluation)
				? undefined
				: "no evidence-backed host, environment, or external evaluation exists",
		},
		{
			id: "accepted_lineage",
			label: "Accepted canonical lineage",
			passed: acceptedCandidate !== undefined,
			reason: acceptedCandidate ? undefined : "no candidate has passed authoritative evaluation",
		},
	];
	const reasons = checks.flatMap((check) => (!check.passed && check.reason ? [check.reason] : []));
	return { passed: reasons.length === 0, checks, reasons };
}
