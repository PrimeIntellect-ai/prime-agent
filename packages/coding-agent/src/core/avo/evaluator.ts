import type {
	AvoCandidate,
	AvoEvaluationAuthority,
	AvoEvaluationReceipt,
	AvoEvaluationStatus,
	AvoStopGate,
} from "./types.js";

export const AVO_HOST_COMMAND_EVALUATORS = [
	"test",
	"build",
	"lint",
	"benchmark",
	"runtime",
	"filesystem",
	"git",
] as const;
export type AvoHostCommandEvaluator = (typeof AVO_HOST_COMMAND_EVALUATORS)[number];

export function classifyAvoHostEvaluationCommand(command: string): AvoHostCommandEvaluator {
	const normalized = command.trim().replace(/[ \t]+/g, " ");
	if (!normalized || normalized.length > 20_000)
		throw new Error("AVO evaluation command must be 1 to 20000 characters");
	if (/\r|\n|[;&|<>`]|\$\(/.test(normalized)) {
		throw new Error("AVO authoritative evaluation requires one direct command without shell composition");
	}
	const patterns: Array<[AvoHostCommandEvaluator, RegExp]> = [
		[
			"test",
			/^(?:(?:npm|pnpm|yarn|bun) (?:run )?test\b|npx (?:[^ ]+ )*(?:vitest|jest)\b|(?:python3?|uv run) (?:-m )?pytest\b|pytest\b|cargo test\b|go test\b|dotnet test\b|mvn test\b|gradle test\b|node --test\b)/,
		],
		[
			"build",
			/^(?:(?:npm|pnpm|yarn|bun) (?:run )?build\b|(?:npx )?tsc\b|cargo build\b|go build\b|dotnet build\b|mvn package\b|gradle build\b|node --check\b)/,
		],
		[
			"lint",
			/^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:lint|check)\b|(?:npx )?(?:biome|eslint|prettier)\b|(?:python3? -m )?ruff\b|ruff\b)/,
		],
		[
			"benchmark",
			/^(?:(?:npm|pnpm|yarn|bun) (?:run )?(?:bench|benchmark)\b|cargo bench\b|go test\b.* -bench\b|pytest\b.*--benchmark)/,
		],
		["git", /^git (?:diff --check|status --porcelain|fsck)\b/],
		["filesystem", /^(?:test -(?:e|f|d|r|w|x) |stat |find )/],
		["runtime", /^(?:(?:node|python3?|ruby|php) [^ -][^ ]*\.(?:js|mjs|cjs|py|rb|php)\b|go run\b|cargo run\b)/],
	];
	for (const [evaluator, pattern] of patterns) if (pattern.test(normalized)) return evaluator;
	throw new Error(
		"command is not a recognized host-verifiable test, build, lint, benchmark, runtime, filesystem, or git check",
	);
}

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
	return (
		receipt.issuedBy === "host" &&
		AUTHORITY_RANK[receipt.authority] >= AUTHORITY_RANK.external &&
		receipt.evidenceRefs.length > 0
	);
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
