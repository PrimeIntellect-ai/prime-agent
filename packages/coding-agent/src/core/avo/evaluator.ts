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

export interface AvoHostCommandObservation {
	exitCode?: number;
	cancelled: boolean;
	truncated: boolean;
	output: string;
}

export interface AvoHostCommandAssessment {
	status: AvoEvaluationStatus;
	metrics: Record<string, number | string | boolean>;
}

export function classifyAvoHostEvaluationCommand(command: string): AvoHostCommandEvaluator {
	const normalized = command.trim().replace(/[ \t]+/g, " ");
	if (!normalized || normalized.length > 20_000)
		throw new Error("AVO evaluation command must be 1 to 20000 characters");
	if (/\r|\n|[;&|<>`]|\$\(/.test(normalized)) {
		throw new Error("AVO authoritative evaluation requires one direct command without shell composition");
	}
	if (
		/(?:^| )(?:(?:--collect-only|--co|--listTests|--list-tests|--passWithNoTests|--allow-no-tests)(?:=\S+)?)(?: |$)/i.test(
			normalized,
		)
	) {
		throw new Error("AVO test evaluation rejects discovery-only and pass-with-no-tests options");
	}
	const patterns: Array<[AvoHostCommandEvaluator, RegExp]> = [
		[
			"test",
			/^(?:(?:npm|pnpm|yarn|bun) (?:run )?test\b|npx (?:(?:--yes|--no-install|-y) )?(?:vitest|jest)\b|(?:python3?|uv run) (?:-m )?pytest\b|pytest\b|cargo test\b|go test\b|dotnet test\b|mvn test\b|gradle test\b|node --test\b)/,
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

function observedTestUnits(output: string): { units: number; parser: string } | undefined {
	const normalized = output.replaceAll("\r", "");
	const countedPatterns: Array<[string, RegExp]> = [
		["node_tap", /^# tests\s+(\d+)\s*$/im],
		["pytest", /(?:^|\s)(\d+)\s+passed(?:\s|,|$)/i],
		["vitest", /^\s*Tests\s+(?:\d+\s+failed\s*\|\s*)?(\d+)\s+passed/im],
		["jest", /^Tests:\s+(?:\d+\s+failed,\s*)?(\d+)\s+passed/im],
		["cargo", /test result:\s+ok\.\s+(\d+)\s+passed/i],
		["dotnet", /Passed!\s+-\s+Failed:\s*\d+,\s*Passed:\s*(\d+)/i],
		["maven", /Tests run:\s*(\d+)/i],
	];
	for (const [parser, pattern] of countedPatterns) {
		const match = pattern.exec(normalized);
		if (match?.[1]) return { units: Number.parseInt(match[1], 10), parser };
	}
	const goPackages = normalized
		.split("\n")
		.filter((line) => /^ok\s+\S+/.test(line) && !line.includes("[no test files]")).length;
	if (goPackages > 0) return { units: goPackages, parser: "go_packages" };
	return undefined;
}

export function assessAvoHostCommand(
	evaluatorId: AvoHostCommandEvaluator,
	observation: AvoHostCommandObservation,
): AvoHostCommandAssessment {
	const baseMetrics: Record<string, number | string | boolean> = {
		exit_code: observation.exitCode ?? "cancelled",
		cancelled: observation.cancelled,
		truncated: observation.truncated,
		output_bytes: Buffer.byteLength(observation.output),
	};
	if (observation.cancelled) {
		return {
			status: "inconclusive",
			metrics: { ...baseMetrics, meaningful: false, validation_reason: "execution was cancelled" },
		};
	}
	if (observation.exitCode !== 0) {
		return {
			status: "fail",
			metrics: { ...baseMetrics, meaningful: true, validation_reason: "command exited non-zero" },
		};
	}
	if (evaluatorId !== "test") {
		return {
			status: "pass",
			metrics: { ...baseMetrics, meaningful: true, validation_reason: "recognized check exited zero" },
		};
	}
	const observed = observedTestUnits(observation.output);
	if (!observed || observed.units < 1) {
		return {
			status: "inconclusive",
			metrics: {
				...baseMetrics,
				meaningful: false,
				observed_work_units: observed?.units ?? 0,
				validation_reason: "no executed passing test was observed in runner output",
			},
		};
	}
	return {
		status: "pass",
		metrics: {
			...baseMetrics,
			meaningful: true,
			observed_work_units: observed.units,
			result_parser: observed.parser,
			validation_reason: "runner output proved at least one test executed and passed",
		},
	};
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
