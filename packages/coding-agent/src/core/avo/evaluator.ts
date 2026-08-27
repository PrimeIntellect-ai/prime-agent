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

export interface AvoClaimEvidenceAssessment {
	relation: "supports" | "contradicts" | "insufficient";
	reason: string;
	claimTokenCoverage: number;
}

export interface AvoDeterministicArithmeticContract {
	expression: string;
	result: string;
}

class ArithmeticParser {
	private index = 0;

	constructor(private readonly input: string) {}

	parse(): number {
		const value = this.additive();
		this.space();
		if (this.index !== this.input.length || !Number.isFinite(value))
			throw new Error("unsupported arithmetic expression");
		return value;
	}

	private space(): void {
		while (/\s/.test(this.input[this.index] ?? "")) this.index += 1;
	}

	private additive(): number {
		let value = this.multiplicative();
		for (;;) {
			this.space();
			const operator = this.input[this.index];
			if (operator !== "+" && operator !== "-") return value;
			this.index += 1;
			const right = this.multiplicative();
			value = this.safe(operator === "+" ? value + right : value - right);
		}
	}

	private multiplicative(): number {
		let value = this.unary();
		for (;;) {
			this.space();
			const operator = this.input[this.index];
			if (operator !== "*" && operator !== "/") return value;
			this.index += 1;
			const right = this.unary();
			if (operator === "/" && right === 0) throw new Error("division by zero");
			if (operator === "/" && value % right !== 0) throw new Error("non-integral division is unsupported");
			value = this.safe(operator === "*" ? value * right : value / right);
		}
	}

	private unary(): number {
		this.space();
		const operator = this.input[this.index];
		if (operator === "+" || operator === "-") {
			this.index += 1;
			const value = this.unary();
			return this.safe(operator === "-" ? -value : value);
		}
		return this.primary();
	}

	private primary(): number {
		this.space();
		if (this.input[this.index] === "(") {
			this.index += 1;
			const value = this.additive();
			this.space();
			if (this.input[this.index] !== ")") throw new Error("unclosed arithmetic parenthesis");
			this.index += 1;
			return value;
		}
		const match = this.input.slice(this.index).match(/^\d+/);
		if (!match) throw new Error("expected a number");
		this.index += match[0].length;
		return this.safe(Number(match[0]));
	}

	private safe(value: number): number {
		if (!Number.isSafeInteger(value)) throw new Error("arithmetic is outside the exact safe-integer subset");
		return value;
	}
}

export function deriveAvoDeterministicArithmeticContract(objective: string): AvoDeterministicArithmeticContract {
	const normalized = objective.normalize("NFKC").replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-");
	const candidates = (normalized.match(/[\d\s.,()+\-*/^%=]+/g) ?? [])
		.map((item) => item.trim().replace(/^[,.\s]+|[,.\s]+$/g, ""))
		.filter((item) => /\d/.test(item) && /[+\-*/^%=]/.test(item) && item.length <= 256);
	if (candidates.length !== 1) {
		throw new Error("the objective does not contain one host-supported arithmetic expression");
	}
	const rawExpression = candidates[0]!;
	for (const numericToken of rawExpression.match(/[\d,]+/g) ?? []) {
		if (numericToken.includes(",") && !/^\d{1,3}(?:,\d{3})+$/.test(numericToken)) {
			throw new Error("the objective contains an invalid or ambiguous digit-grouping separator");
		}
	}
	const expression = rawExpression.replaceAll(",", "");
	let result: number;
	try {
		result = new ArithmeticParser(expression).parse();
	} catch (error) {
		throw new Error(
			`the objective does not contain one host-supported arithmetic expression: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return { expression, result: Object.is(result, -0) ? "0" : String(result) };
}

const CLAIM_STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"was",
	"were",
	"with",
]);

function normalizedClaimText(value: string): string {
	return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function semanticTokens(value: string): Set<string> {
	return new Set(
		normalizedClaimText(value)
			.match(/[\p{L}\p{N}]+/gu)
			?.filter((token) => token.length > 1 && !CLAIM_STOP_WORDS.has(token)) ?? [],
	);
}

function hasNegation(value: string): boolean {
	return /(?:^|\s)(?:false|incorrect|never|no|not|untrue|without)(?:\s|[.:,;!?]|$)/i.test(value);
}

export function assessAvoClaimEvidence(claimText: string, exactQuote: string): AvoClaimEvidenceAssessment {
	const claim = normalizedClaimText(claimText);
	const quote = normalizedClaimText(exactQuote);
	const claimTokens = semanticTokens(claim);
	const quoteTokens = semanticTokens(quote);
	const shared = [...claimTokens].filter((token) => quoteTokens.has(token)).length;
	const coverage = claimTokens.size === 0 ? 0 : shared / claimTokens.size;
	if (claim === quote) {
		return {
			relation: "supports",
			reason: "the host-observed quote exactly matches the candidate claim",
			claimTokenCoverage: 1,
		};
	}
	if (quote.includes(claim)) {
		const index = quote.indexOf(claim);
		const prefix = quote.slice(Math.max(0, index - 96), index);
		const suffix = quote.slice(index + claim.length, Math.min(quote.length, index + claim.length + 96));
		if (
			/(?:false|incorrect|not true|no evidence|unverified|disputed|denied)(?:\s+(?:that|for|to support))?(?:\s|:|,|-)*$/i.test(
				prefix,
			) ||
			/^(?:\s|:|,|-)*(?:is|was|were|has been)?\s*(?:false|incorrect|untrue|unsupported|disproved|retracted|disputed|denied)(?:\s|[.:,;!?]|$)/i.test(
				suffix,
			)
		) {
			return {
				relation: "contradicts",
				reason: "the quote frames the embedded claim as false, denied, disputed, or unsupported",
				claimTokenCoverage: coverage,
			};
		}
		return {
			relation: "supports",
			reason: "the candidate claim occurs directly in the host-observed quote",
			claimTokenCoverage: coverage,
		};
	}
	const claimNumbers = claim.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
	const quoteNumbers = quote.match(/\d+(?:[.,]\d+)?%?/g) ?? [];
	if (coverage >= 0.6 && claimNumbers.join("|") !== quoteNumbers.join("|")) {
		return {
			relation: "contradicts",
			reason: "the quote overlaps the claim but gives different numeric evidence",
			claimTokenCoverage: coverage,
		};
	}
	if (coverage >= 0.6 && hasNegation(claim) !== hasNegation(quote)) {
		return {
			relation: "contradicts",
			reason: "the quote and claim have conflicting negation polarity",
			claimTokenCoverage: coverage,
		};
	}
	return {
		relation: "insufficient",
		reason: "the quote does not directly contain the candidate claim",
		claimTokenCoverage: coverage,
	};
}

export function classifyAvoHostEvaluationCommand(command: string): AvoHostCommandEvaluator {
	const normalized = command.trim().replace(/[ \t]+/g, " ");
	if (!normalized || normalized.length > 20_000)
		throw new Error("AVO evaluation command must be 1 to 20000 characters");
	if (/\r|\n|[;&|<>`#]|\$\(/.test(normalized)) {
		throw new Error("AVO authoritative evaluation requires one direct command without shell composition");
	}
	if (
		/(?:^| )(?:(?:--collect-only|--co|--listTests|--list-tests|-list|--passWithNoTests|--allow-no-tests)(?:=\S+)?)(?: |$)/i.test(
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

function observedTestSummary(output: string): { units: number; passed: number; parser: string } | undefined {
	const normalized = output.replaceAll("\r", "");
	const nodeTotal = /^# tests\s+(\d+)\s*$/im.exec(normalized)?.[1];
	if (nodeTotal) {
		const passed = /^# pass\s+(\d+)\s*$/im.exec(normalized)?.[1] ?? "0";
		return { units: Number.parseInt(nodeTotal, 10), passed: Number.parseInt(passed, 10), parser: "node_tap" };
	}
	const vitestLine = /^\s*Tests\s+(.*)$/im.exec(normalized)?.[1];
	if (vitestLine) {
		const counts = [...vitestLine.matchAll(/(\d+)\s+(passed|failed|skipped|todo)(?=\s|\||\(|$)/gi)];
		const units = counts.reduce((sum, match) => sum + Number.parseInt(match[1]!, 10), 0);
		const passed = counts
			.filter((match) => match[2]?.toLowerCase() === "passed")
			.reduce((sum, match) => sum + Number.parseInt(match[1]!, 10), 0);
		if (units > 0) return { units, passed, parser: "vitest" };
	}
	const jestLine = /^Tests:\s+(.*)$/im.exec(normalized)?.[1];
	if (jestLine) {
		const total = /(\d+)\s+total/i.exec(jestLine)?.[1];
		const passed = /(\d+)\s+passed/i.exec(jestLine)?.[1] ?? "0";
		if (total) return { units: Number.parseInt(total, 10), passed: Number.parseInt(passed, 10), parser: "jest" };
	}
	const pytestLine = normalized
		.split("\n")
		.reverse()
		.find(
			(line) =>
				/\b\d+\s+(?:passed|failed|error|errors|skipped|xfailed|xpassed)\b/i.test(line) &&
				/(?:\bin\s+\d|^=+|=+$)/i.test(line.trim()),
		);
	if (pytestLine) {
		const counts = [...pytestLine.matchAll(/(\d+)\s+(passed|failed|error|errors|skipped|xfailed|xpassed)\b/gi)];
		const units = counts.reduce((sum, match) => sum + Number.parseInt(match[1]!, 10), 0);
		const passed = counts
			.filter((match) => match[2]?.toLowerCase() === "passed")
			.reduce((sum, match) => sum + Number.parseInt(match[1]!, 10), 0);
		if (units > 0) return { units, passed, parser: "pytest" };
	}
	const cargo =
		/test result:\s+(?:ok|FAILED)\.\s+(\d+)\s+passed;\s+(\d+)\s+failed;\s+(\d+)\s+ignored;\s+(\d+)\s+measured/i.exec(
			normalized,
		);
	if (cargo) {
		return {
			units: cargo.slice(1, 5).reduce((sum, value) => sum + Number.parseInt(value!, 10), 0),
			passed: Number.parseInt(cargo[1]!, 10),
			parser: "cargo",
		};
	}
	const maven = /Tests run:\s*(\d+)(?:,\s*Failures:\s*(\d+))?(?:,\s*Errors:\s*(\d+))?(?:,\s*Skipped:\s*(\d+))?/i.exec(
		normalized,
	);
	if (maven?.[1]) {
		const units = Number.parseInt(maven[1], 10);
		return {
			units,
			passed: Math.max(
				0,
				units -
					Number.parseInt(maven[2] ?? "0", 10) -
					Number.parseInt(maven[3] ?? "0", 10) -
					Number.parseInt(maven[4] ?? "0", 10),
			),
			parser: "maven",
		};
	}
	const dotnet = /Passed!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i.exec(
		normalized,
	);
	if (dotnet?.[4]) {
		return {
			units: Number.parseInt(dotnet[4], 10),
			passed: Number.parseInt(dotnet[2]!, 10),
			parser: "dotnet",
		};
	}
	const goVerbose = [...normalized.matchAll(/^--- (PASS|FAIL|SKIP):\s+\S+/gm)];
	if (goVerbose.length > 0) {
		return {
			units: goVerbose.length,
			passed: goVerbose.filter((match) => match[1] === "PASS").length,
			parser: "go_verbose",
		};
	}
	return undefined;
}

export function assessAvoHostCommand(
	evaluatorId: AvoHostCommandEvaluator,
	observation: AvoHostCommandObservation,
): AvoHostCommandAssessment {
	const observed = evaluatorId === "test" ? observedTestSummary(observation.output) : undefined;
	const observedPassed = observed?.passed ?? 0;
	const baseMetrics: Record<string, number | string | boolean> = {
		exit_code: observation.exitCode ?? "cancelled",
		cancelled: observation.cancelled,
		truncated: observation.truncated,
		output_bytes: Buffer.byteLength(observation.output),
		...(evaluatorId === "test"
			? {
					observed_work_units: observed?.units ?? 0,
					observed_passed_work_units: observedPassed,
					result_parser: observed?.parser ?? "unrecognized",
				}
			: {}),
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
			metrics: {
				...baseMetrics,
				meaningful: evaluatorId !== "test" || (observed?.units ?? 0) > 0,
				validation_reason:
					evaluatorId === "test" && !observed
						? "test command exited non-zero without proving a test executed"
						: "command exited non-zero",
			},
		};
	}
	if (evaluatorId !== "test") {
		return {
			status: "pass",
			metrics: { ...baseMetrics, meaningful: true, validation_reason: "recognized check exited zero" },
		};
	}
	if (!observed || observed.units < 1 || observedPassed < 1) {
		return {
			status: "inconclusive",
			metrics: {
				...baseMetrics,
				meaningful: false,
				observed_work_units: observed?.units ?? 0,
				validation_reason: "no passing executed test was observed in runner output",
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
