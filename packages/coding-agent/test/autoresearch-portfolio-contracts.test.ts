import { describe, expect, it } from "vitest";
import {
	autoResearchPortfolioCandidateDigest,
	autoResearchPortfolioContractDigest,
	autoResearchPortfolioMeasurementDigest,
	parseAutoResearchPortfolioCandidate,
	parseAutoResearchPortfolioContract,
	parseAutoResearchPortfolioMeasurement,
	projectAutoResearchPortfolioTrainingProjection,
} from "../src/core/autoresearch/portfolio-contracts.js";
import { digestObject } from "../src/core/workflow/contracts.js";

const DIGEST = "a".repeat(64);
const PORTFOLIO_ROOT_DIGEST = "b".repeat(64);
const TRAINING_ROOT_DIGEST = "c".repeat(64);
const VALIDATION_ROOT_DIGEST = "d".repeat(64);
const HOLDOUT_ROOT_DIGEST = "e".repeat(64);
const VERIFICATION_DIGEST = "9".repeat(64);
const TRAINING_ARTIFACT_DIGEST = "1".repeat(64);
const VALIDATION_ARTIFACT_DIGEST = "2".repeat(64);
const HOLDOUT_ARTIFACT_DIGEST = "3".repeat(64);

type Split = "training" | "validation" | "holdout";
type AccessAuthority =
	| "training_workers_training_only"
	| "validation_evaluator_host_only"
	| "holdout_host_aggregate_only";

function digestWithoutField(value: Record<string, unknown>, field: string): string {
	const payload = { ...value };
	delete payload[field];
	return digestObject(payload);
}

function sortedForDigest(values: readonly string[]): readonly string[] {
	return [...values].sort((left, right) => left.localeCompare(right));
}

function splitRoot(split: Split): string {
	return split === "training"
		? TRAINING_ROOT_DIGEST
		: split === "validation"
			? VALIDATION_ROOT_DIGEST
			: HOLDOUT_ROOT_DIGEST;
}

function datasetArtifact(
	split: Split,
	sourceTimeStart: string,
	sourceTimeEnd: string,
	accessAuthority: AccessAuthority,
	modality: string,
	index: number,
): Record<string, unknown> {
	return {
		split,
		objectUri: `gs://autoresearch-${split}/closure/${modality}-${index}.json`,
		generation: index + 1,
		sha256:
			split === "training"
				? TRAINING_ARTIFACT_DIGEST
				: split === "validation"
					? VALIDATION_ARTIFACT_DIGEST
					: HOLDOUT_ARTIFACT_DIGEST,
		bytes: 128 + index,
		schemaVersion: "observations-v1",
		modality,
		instrumentSet: ["EUR_USD", "USD_JPY"],
		sourceTimeStart,
		sourceTimeEnd,
		validationResult: "passed",
		coverage: "complete",
		gapClassification: "none",
		lifecycle: "sealed",
		restoreVerification: {
			locked: true,
			independentlyRestored: true,
			independentlyRehashed: true,
			verificationEvidenceDigest: VERIFICATION_DIGEST,
		},
		provenance: {
			sourceSystem: "fixture-source",
			sourceDataset: `dataset-${split}-${modality}`,
			ingestDigest: DIGEST,
			lineageDigest: DIGEST,
			provenanceReceiptDigest: DIGEST,
		},
		closureRootDigest: splitRoot(split),
		accessAuthority,
	};
}

function splitManifest(
	split: Split,
	sourceTimeStart: string,
	sourceTimeEnd: string,
	accessAuthority: AccessAuthority,
): Record<string, unknown> {
	return {
		locked: true,
		split,
		closureRootDigest: splitRoot(split),
		artifacts: [
			datasetArtifact(split, sourceTimeStart, sourceTimeEnd, accessAuthority, "time_series", 0),
			datasetArtifact(split, sourceTimeStart, sourceTimeEnd, accessAuthority, "order_book", 1),
		],
	};
}

function inputManifest(): Record<string, unknown> {
	const splitBoundaryPolicy: Record<string, unknown> = {
		locked: true,
		trainingEndExclusive: "2025-01-01T00:00:00.000Z",
		validationStartInclusive: "2025-01-01T00:00:00.000Z",
		validationEndExclusive: "2026-01-01T00:00:00.000Z",
		holdoutStartInclusive: "2026-01-01T00:00:00.000Z",
		holdoutEndExclusive: "2027-01-01T00:00:00.000Z",
		policyDigest: "",
	};
	splitBoundaryPolicy.policyDigest = digestWithoutField(splitBoundaryPolicy, "policyDigest");
	const training = splitManifest(
		"training",
		"2024-01-01T00:00:00.000Z",
		"2025-01-01T00:00:00.000Z",
		"training_workers_training_only",
	);
	const validation = splitManifest(
		"validation",
		"2025-01-01T00:00:00.000Z",
		"2026-01-01T00:00:00.000Z",
		"validation_evaluator_host_only",
	);
	const holdout = splitManifest(
		"holdout",
		"2026-01-01T00:00:00.000Z",
		"2027-01-01T00:00:00.000Z",
		"holdout_host_aggregate_only",
	);
	const manifest: Record<string, unknown> = {
		locked: true,
		evaluationEpoch: 1,
		manifestRevision: 1,
		closureRootDigest: PORTFOLIO_ROOT_DIGEST,
		manifestDigest: "",
		splitClosureRoots: {
			training: TRAINING_ROOT_DIGEST,
			validation: VALIDATION_ROOT_DIGEST,
			holdout: HOLDOUT_ROOT_DIGEST,
		},
		splitBoundaryPolicy,
		training,
		validation,
		holdout,
		modelAccess: {
			training: "training_workers_training_only",
			validation: "validation_evaluator_host_only",
			holdout: "holdout_host_aggregate_only",
			holdoutRowsVisible: false,
			holdoutPerCaseFeedback: false,
			holdoutReturns: "aggregate_signed_evidence_only",
			signedAggregateEvidence: true,
		},
	};
	manifest.manifestDigest = manifestDigestFor(manifest);
	return manifest;
}

function manifestDigestFor(manifest: Record<string, unknown>): string {
	const canonicalManifest: Record<string, unknown> = {
		...manifest,
		training: {
			...(manifest.training as Record<string, unknown>),
			artifacts: [
				...((manifest.training as Record<string, unknown>).artifacts as Array<Record<string, unknown>>),
			].sort((left, right) => String(left.objectUri).localeCompare(String(right.objectUri))),
		},
		validation: {
			...(manifest.validation as Record<string, unknown>),
			artifacts: [
				...((manifest.validation as Record<string, unknown>).artifacts as Array<Record<string, unknown>>),
			].sort((left, right) => String(left.objectUri).localeCompare(String(right.objectUri))),
		},
		holdout: {
			...(manifest.holdout as Record<string, unknown>),
			artifacts: [
				...((manifest.holdout as Record<string, unknown>).artifacts as Array<Record<string, unknown>>),
			].sort((left, right) => String(left.objectUri).localeCompare(String(right.objectUri))),
		},
	};
	return digestWithoutField(canonicalManifest, "manifestDigest");
}

function manifestDigest(): string {
	return String(inputManifest().manifestDigest);
}

function refreshContractManifestBindings(value: Record<string, unknown>): void {
	const manifest = value.inputManifest as Record<string, unknown>;
	manifest.manifestDigest = manifestDigestFor(manifest);
	for (const goalRecord of value.goals as Array<Record<string, unknown>>) {
		for (const metricRecord of goalRecord.metrics as Array<Record<string, unknown>>) {
			metricRecord.inputManifestDigest = manifest.manifestDigest;
		}
		for (const key of ["baseline", "evaluator", "parser"] as const) {
			(goalRecord[key] as Record<string, unknown>).inputManifestDigest = manifest.manifestDigest;
		}
		const evaluator = goalRecord.evaluator as Record<string, unknown>;
		evaluator.evaluatorDigest = digestWithoutField(evaluator, "evaluatorDigest");
		const parser = goalRecord.parser as Record<string, unknown>;
		parser.parserDigest = digestWithoutField(parser, "parserDigest");
	}
}

function splitClosureRoots(): Record<string, string> {
	return {
		training: TRAINING_ROOT_DIGEST,
		validation: VALIDATION_ROOT_DIGEST,
		holdout: HOLDOUT_ROOT_DIGEST,
	};
}

function metric(metricId: string, name: string, requirementId: string): Record<string, unknown> {
	return {
		metricId,
		name,
		requirementId,
		direction: "higher",
		target: 0.8,
		unit: "ratio",
		locked: true,
		evaluationEpoch: 1,
		metricRevision: 1,
		closureRootDigest: PORTFOLIO_ROOT_DIGEST,
		inputManifestDigest: manifestDigest(),
		splitClosureRoots: splitClosureRoots(),
	};
}

function goal(goalId: string, domainId: string, metrics: readonly Record<string, unknown>[]): Record<string, unknown> {
	const baseline: Record<string, unknown> = {
		locked: true,
		measurementId: "m-baseline",
		metricValues: metrics.map((entry) => ({ metricId: String(entry.metricId), value: 0.5 })),
		evidenceDigest: DIGEST,
		evaluationEpoch: 1,
		closureRootDigest: PORTFOLIO_ROOT_DIGEST,
		inputManifestDigest: manifestDigest(),
		splitClosureRoots: splitClosureRoots(),
	};
	const evaluator: Record<string, unknown> = {
		locked: true,
		evaluatorId: `evaluator-${goalId}`,
		sourceDigest: DIGEST,
		inputDigest: DIGEST,
		environmentDigest: DIGEST,
		evaluatorDigest: "",
		evaluationEpoch: 1,
		evaluatorRevision: 1,
		closureRootDigest: PORTFOLIO_ROOT_DIGEST,
		inputManifestDigest: manifestDigest(),
		splitClosureRoots: splitClosureRoots(),
	};
	evaluator.evaluatorDigest = digestWithoutField(evaluator, "evaluatorDigest");
	const parser: Record<string, unknown> = {
		locked: true,
		parserId: `parser-${goalId}`,
		kind: "json_object",
		metricKeys: sortedForDigest(metrics.map((entry) => String(entry.metricId))),
		parserDigest: "",
		evaluationEpoch: 1,
		inputManifestRevision: 1,
		closureRootDigest: PORTFOLIO_ROOT_DIGEST,
		inputManifestDigest: manifestDigest(),
		splitClosureRoots: splitClosureRoots(),
	};
	parser.parserDigest = digestWithoutField(parser, "parserDigest");
	const command: Record<string, unknown> = {
		locked: true,
		argv: ["node", "evaluate.mjs"],
		shell: false,
		cwd: "isolated_candidate",
		commandDigest: "",
	};
	command.commandDigest = digestWithoutField(command, "commandDigest");
	const falsification: Record<string, unknown> = {
		locked: true,
		criteria: ["quality fails to improve on the sealed sample"],
		manifestDigest: "",
	};
	falsification.manifestDigest = digestWithoutField(falsification, "manifestDigest");
	const adversarial: Record<string, unknown> = {
		locked: true,
		checks: sortedForDigest(["metric omission", "evaluator mutation", "holdout leakage"]),
		manifestDigest: "",
	};
	adversarial.manifestDigest = digestWithoutField(adversarial, "manifestDigest");
	return {
		goalId,
		domainId,
		title: `Goal ${goalId}`,
		description: `A bounded objective for ${goalId}`,
		scope: "terminal",
		metrics,
		baseline,
		evaluator,
		parser,
		command,
		repeatability: {
			locked: true,
			runs: 3,
			aggregation: "median",
			seed: "seed-1",
			maxVariance: 0.01,
		},
		uncertainty: {
			locked: true,
			method: "bootstrap",
			confidence: 0.95,
			maxWidth: 0.2,
			maxVariance: 0.01,
		},
		opaqueHoldout: {
			locked: true,
			policy: "host_only",
			candidateVisible: false,
			handleDigest: DIGEST,
			inputDigest: DIGEST,
			resolverDigest: DIGEST,
			evaluationEpoch: 1,
			closureRootDigest: PORTFOLIO_ROOT_DIGEST,
			splitClosureRoots: splitClosureRoots(),
		},
		falsification,
		adversarial,
	};
}

function candidate(candidateId: string): Record<string, unknown> {
	return {
		candidateId,
		goalIds: ["goal-quality"],
		solutionFamily: {
			familyId: `family-${candidateId}`,
			name: `structural representation ${candidateId}`,
			mechanismClass: "representation",
		},
		ancestry: {
			parentCandidateIds: [],
			baseDigest: DIGEST,
			lineageDigest: DIGEST,
		},
		causalMechanism: {
			hypothesis: "A causal representation separates regimes before scoring.",
			intervention: "Replace the shared representation with a regime state.",
			expectedObservation: "The quality vector improves without weakening latency.",
			falsificationCondition: "The quality improvement disappears on the sealed sample.",
			mechanismDigest: DIGEST,
		},
		change: {
			kind: "mechanism",
			changedPaths: ["src/representation.ts"],
			parameterChanges: [],
			changeDigest: DIGEST,
		},
		scope: "terminal",
	};
}

function measurement(measurementId: string, candidateId: string | null): Record<string, unknown> {
	const value: Record<string, unknown> = {
		measurementId,
		goalId: "goal-quality",
		candidateId,
		scope: "terminal",
		kind: candidateId === null ? "baseline" : "candidate",
		vector: [{ metricId: "quality", value: candidateId === null ? 0.5 : 0.85 }],
		repeatIndex: 1,
		sampleCount: 3,
		evaluationEpoch: 1,
		inputManifestDigest: manifestDigest(),
		splitClosureRoots: splitClosureRoots(),
		confidenceInterval: { lower: 0.8, upper: 0.9, level: 0.95 },
		variance: 0.01,
		runCount: 3,
		aggregation: "median",
		inputDigest: manifestDigest(),
		evaluatorDigest: DIGEST,
		parserDigest: DIGEST,
		commandDigest: DIGEST,
		workspaceDigest: DIGEST,
		evidenceDigests: [DIGEST],
		measuredAt: "2026-08-17T12:00:00.000Z",
		measurementDigest: "",
	};
	value.measurementDigest = digestWithoutField(value, "measurementDigest");
	return value;
}

function acceptanceRequirement(requirementId: string, statement: string): Record<string, unknown> {
	const value: Record<string, unknown> = { requirementId, statement, locked: true, requirementDigest: "" };
	value.requirementDigest = digestWithoutField(value, "requirementDigest");
	return value;
}

function validPortfolio(): Record<string, unknown> {
	return {
		schemaVersion: 3,
		contractId: "portfolio-1",
		objective: "Improve quality while preserving latency and safety invariants.",
		acceptanceRequirements: [
			acceptanceRequirement("requirement-quality", "Quality must improve without violating the quality guard."),
			acceptanceRequirement("requirement-latency", "Latency must remain within the locked latency bound."),
		],
		goals: [
			goal("goal-quality", "market-quality", [
				metric("quality", "quality", "requirement-quality"),
				metric("quality-secondary", "quality secondary", "requirement-quality"),
			]),
			goal("goal-latency", "market-latency", [metric("latency", "latency", "requirement-latency")]),
		],
		goalRelations: [
			{ fromGoalId: "goal-quality", toGoalId: "goal-latency", relation: "competing", rationale: "shared compute" },
		],
		lexicographicTiers: [
			{ tier: 1, goalIds: ["goal-quality"] },
			{ tier: 2, goalIds: ["goal-latency"] },
		],
		hardBoundaries: [
			{
				boundaryId: "boundary-evaluator",
				statement: "The evaluator is immutable.",
				scope: "terminal",
				locked: true,
			},
		],
		invariants: [
			{
				invariantId: "invariant-safety",
				statement: "No protected test regresses.",
				scope: "terminal",
				locked: true,
				checkDigest: DIGEST,
			},
		],
		nonGoals: [
			{ nonGoalId: "non-goal-deployment", statement: "Deployment is outside this portfolio.", scope: "terminal" },
		],
		budgets: {
			maxCandidates: 12,
			maxMeasurements: 96,
			maxWallSeconds: 3600,
			maxCostMicrounits: 100000,
			maxParallelCandidates: 2,
			maxTokens: 50000,
		},
		safety: {
			locked: true,
			network: "disabled",
			externalEffects: "none",
			requireOpaqueHoldout: true,
			requireAdversarialReview: true,
			maxUncertainty: 0.2,
		},
		inputManifest: inputManifest(),
		scopePartitions: [
			{
				partitionId: "terminal-code",
				scope: "terminal",
				paths: ["src/"],
				dataDigests: [DIGEST],
				mutableBy: "candidate",
			},
			{
				partitionId: "learning-notes",
				scope: "learning",
				paths: ["notes/"],
				dataDigests: [DIGEST],
				mutableBy: "host",
			},
		],
		terminalScope: "terminal",
		learningScope: "learning",
	};
}

describe("schema-v3 AutoResearch portfolio contracts", () => {
	it("parses an immutable preregistration without run-state projections", () => {
		const parsed = parseAutoResearchPortfolioContract(validPortfolio());

		expect(parsed.schemaVersion).toBe(3);
		expect(parsed.goals.find((entry) => entry.goalId === "goal-quality")?.domainId).toBe("market-quality");
		expect(parsed.inputManifest.training.artifacts).toHaveLength(2);
		expect(parsed.inputManifest.validation.artifacts.map((entry) => entry.modality)).toContain("order_book");
		expect("impactClosure" in parsed).toBe(false);
		expect("candidates" in parsed).toBe(false);
		expect("measurements" in parsed).toBe(false);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.goals)).toBe(true);
		expect(Object.isFrozen(parsed.inputManifest.training.artifacts)).toBe(true);
		expect("weightedScore" in parsed).toBe(false);
		expect(autoResearchPortfolioContractDigest(parsed)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps the contract digest independent of evolving coordinator run state", () => {
		const preregistration = validPortfolio();
		const digest = autoResearchPortfolioContractDigest(preregistration);
		const withRunState = {
			...preregistration,
			candidates: [candidate("candidate-1")],
			measurements: [measurement("measurement-1", "candidate-1")],
			impactClosure: { authority: "host_derived" },
		};

		expect(autoResearchPortfolioContractDigest(preregistration)).toBe(digest);
		expect(() => parseAutoResearchPortfolioContract(withRunState)).toThrow(/unknown field|closed|run state/i);
	});

	it("canonicalizes preregistration and standalone run-state order", () => {
		const first = validPortfolio();
		const second = structuredClone(first);
		(second.acceptanceRequirements as Array<Record<string, unknown>>).reverse();
		(second.goals as Array<Record<string, unknown>>).reverse();
		for (const goalRecord of second.goals as Array<Record<string, unknown>>) {
			(goalRecord.metrics as Array<Record<string, unknown>>).reverse();
		}
		(second.goalRelations as Array<Record<string, unknown>>).reverse();
		(second.lexicographicTiers as Array<Record<string, unknown>>).reverse();
		for (const tier of second.lexicographicTiers as Array<Record<string, unknown>>) {
			(tier.goalIds as string[]).reverse();
		}
		for (const split of ["training", "validation", "holdout"] as const) {
			const manifest = (second.inputManifest as Record<string, unknown>)[split] as Record<string, unknown>;
			(manifest.artifacts as Array<Record<string, unknown>>).reverse();
		}

		expect(autoResearchPortfolioContractDigest(first)).toBe(autoResearchPortfolioContractDigest(second));

		const firstCandidate = candidate("candidate-1");
		const secondCandidate = structuredClone(firstCandidate);
		(secondCandidate.goalIds as string[]).reverse();
		(secondCandidate.ancestry as Record<string, unknown>).parentCandidateIds = [];
		expect(autoResearchPortfolioCandidateDigest(firstCandidate)).toBe(
			autoResearchPortfolioCandidateDigest(secondCandidate),
		);

		const firstMeasurement = measurement("measurement-1", "candidate-1");
		const secondMeasurement = structuredClone(firstMeasurement);
		(secondMeasurement.vector as Array<Record<string, unknown>>).reverse();
		(secondMeasurement.evidenceDigests as string[]).reverse();
		expect(autoResearchPortfolioMeasurementDigest(firstMeasurement)).toBe(
			autoResearchPortfolioMeasurementDigest(secondMeasurement),
		);
	});

	it("uses the locked policy rather than hardcoded calendar years", () => {
		const value = validPortfolio();
		const manifest = value.inputManifest as Record<string, unknown>;
		const policy = manifest.splitBoundaryPolicy as Record<string, unknown>;
		policy.trainingEndExclusive = "2015-01-01T00:00:00.000Z";
		policy.validationStartInclusive = "2015-01-01T00:00:00.000Z";
		policy.validationEndExclusive = "2016-01-01T00:00:00.000Z";
		policy.holdoutStartInclusive = "2016-01-01T00:00:00.000Z";
		policy.holdoutEndExclusive = "2017-01-01T00:00:00.000Z";
		policy.policyDigest = digestWithoutField(policy, "policyDigest");
		const ranges: readonly [Split, string, string][] = [
			["training", "2014-01-01T00:00:00.000Z", "2015-01-01T00:00:00.000Z"],
			["validation", "2015-01-01T00:00:00.000Z", "2016-01-01T00:00:00.000Z"],
			["holdout", "2016-01-01T00:00:00.000Z", "2017-01-01T00:00:00.000Z"],
		];
		for (const [split, start, end] of ranges) {
			const splitRecord = manifest[split] as Record<string, unknown>;
			for (const artifact of splitRecord.artifacts as Array<Record<string, unknown>>) {
				artifact.sourceTimeStart = start;
				artifact.sourceTimeEnd = end;
			}
		}
		refreshContractManifestBindings(value);

		expect(parseAutoResearchPortfolioContract(value).inputManifest.validation.artifacts[0]?.sourceTimeStart).toBe(
			"2015-01-01T00:00:00.000Z",
		);
	});

	it("parses standalone host measurements without requiring every global metric", () => {
		const parsed = parseAutoResearchPortfolioMeasurement(measurement("measurement-1", "candidate-1"));

		expect(parsed.vector).toHaveLength(1);
		expect(parsed.evaluationEpoch).toBe(1);
		expect(parsed.inputManifestDigest).toBe(manifestDigest());
		expect(parsed.confidenceInterval).toEqual({ lower: 0.8, upper: 0.9, level: 0.95 });
		expect(parsed.aggregation).toBe("median");
		expect(autoResearchPortfolioMeasurementDigest(parsed)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("parses strict standalone candidates", () => {
		const parsed = parseAutoResearchPortfolioCandidate(candidate("candidate-1"));

		expect(parsed.candidateId).toBe("candidate-1");
		expect(autoResearchPortfolioCandidateDigest(parsed)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("rejects non-enumerable run-state fields and symbol fields", () => {
		const hidden = validPortfolio();
		Object.defineProperty(hidden, "measurements", { configurable: true, enumerable: false, value: [] });
		expect(() => parseAutoResearchPortfolioContract(hidden)).toThrow(/unknown|non-enumerable|closed/i);

		const symbolField = validPortfolio();
		Object.defineProperty(symbolField, Symbol("measurements"), { configurable: true, enumerable: true, value: [] });
		expect(() => parseAutoResearchPortfolioContract(symbolField)).toThrow(/unknown|symbol|closed/i);
	});

	it("rejects closed-schema array mutations", () => {
		const hidden = validPortfolio();
		Object.defineProperty(hidden.goals, "hidden", { configurable: true, enumerable: false, value: true });
		expect(() => parseAutoResearchPortfolioContract(hidden)).toThrow(/array|closed|own|enumerable/i);

		const symbolField = validPortfolio();
		Object.defineProperty(symbolField.goals, Symbol("hidden"), { configurable: true, enumerable: true, value: true });
		expect(() => parseAutoResearchPortfolioContract(symbolField)).toThrow(/array|closed|symbol|own/i);

		const customMap = validPortfolio();
		Object.defineProperty(customMap.goals, "map", { configurable: true, enumerable: true, value: () => [] });
		expect(() => parseAutoResearchPortfolioContract(customMap)).toThrow(/array|closed|map|own/i);

		const customPrototype = validPortfolio();
		Object.setPrototypeOf(customPrototype.goals, { custom: true });
		expect(() => parseAutoResearchPortfolioContract(customPrototype)).toThrow(/array|closed|prototype/i);
	});

	it("rejects enumerable accessor array elements without invoking the accessor", () => {
		const value = validPortfolio();
		const goals = value.goals as Array<unknown>;
		const existingGoal = goals[0];
		let reads = 0;
		Object.defineProperty(goals, "0", {
			configurable: true,
			enumerable: true,
			get: () => {
				reads += 1;
				return existingGoal;
			},
		});

		expect(() => parseAutoResearchPortfolioContract(value)).toThrow(/array|accessor|data|writable/i);
		expect(reads).toBe(0);
	});

	it.each(["map", "filter", "sort"] as const)("does not trust poisoned Array.prototype.%s", (method) => {
		const value = validPortfolio();
		const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, method);
		if (descriptor === undefined) throw new Error(`missing Array.prototype.${method}`);
		try {
			Object.defineProperty(Array.prototype, method, {
				configurable: descriptor.configurable,
				enumerable: descriptor.enumerable,
				writable: true,
				value: () => {
					throw new Error(`poisoned ${method}`);
				},
			});
			expect(() => autoResearchPortfolioContractDigest(value)).not.toThrow();
		} finally {
			Object.defineProperty(Array.prototype, method, descriptor);
		}
	});

	it("rejects a prerequisite cycle", () => {
		const value = validPortfolio();
		value.goalRelations = [
			{ fromGoalId: "goal-quality", toGoalId: "goal-latency", relation: "prerequisite", rationale: "quality first" },
			{ fromGoalId: "goal-latency", toGoalId: "goal-quality", relation: "prerequisite", rationale: "latency first" },
		];
		expect(() => parseAutoResearchPortfolioContract(value)).toThrow(/prerequisite.*cycle|cycle.*prerequisite/i);
	});

	it("rejects reverse prerequisite and conflict contradictions", () => {
		const value = validPortfolio();
		value.goalRelations = [
			{ fromGoalId: "goal-quality", toGoalId: "goal-latency", relation: "prerequisite", rationale: "quality first" },
			{
				fromGoalId: "goal-latency",
				toGoalId: "goal-quality",
				relation: "conflict",
				rationale: "latency blocks quality",
			},
		];
		expect(() => parseAutoResearchPortfolioContract(value)).toThrow(/reverse|contradict|prerequisite|conflict/i);
	});

	it.each([
		["prerequisite", "conflict"],
		["conflict", "prerequisite"],
		["prerequisite", "competing"],
		["competing", "prerequisite"],
		["complementary", "conflict"],
		["conflict", "complementary"],
		["complementary", "competing"],
		["competing", "complementary"],
	] as const)("rejects canonical-order-invariant reverse %s/%s contradiction", (forward, reverse) => {
		const value = validPortfolio();
		value.goalRelations = [
			{ fromGoalId: "goal-quality", toGoalId: "goal-latency", relation: forward, rationale: "forward" },
			{ fromGoalId: "goal-latency", toGoalId: "goal-quality", relation: reverse, rationale: "reverse" },
		];
		const reordered = structuredClone(value);
		(reordered.goalRelations as Array<Record<string, unknown>>).reverse();
		expect(() => parseAutoResearchPortfolioContract(value)).toThrow(/reverse|contradict|relation/i);
		expect(() => parseAutoResearchPortfolioContract(reordered)).toThrow(/reverse|contradict|relation/i);
	});

	it("rejects a prerequisite that violates lexicographic tier order", () => {
		const value = validPortfolio();
		value.goalRelations = [
			{ fromGoalId: "goal-latency", toGoalId: "goal-quality", relation: "prerequisite", rationale: "latency first" },
		];
		expect(() => parseAutoResearchPortfolioContract(value)).toThrow(/tier|lexicographic|prerequisite/i);
	});

	it.each([
		[
			"acceptance requirement",
			(value: Record<string, unknown>) => {
				const requirement = (value.acceptanceRequirements as Array<Record<string, unknown>>)[0]!;
				requirement.requirementDigest = "0".repeat(64);
			},
		],
		[
			"split boundary policy",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const policy = manifest.splitBoundaryPolicy as Record<string, unknown>;
				policy.policyDigest = "0".repeat(64);
			},
		],
		[
			"input manifest",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				manifest.manifestDigest = "0".repeat(64);
			},
		],
		[
			"evaluator",
			(value: Record<string, unknown>) => {
				const evaluator = (value.goals as Array<Record<string, unknown>>)[0]!.evaluator as Record<string, unknown>;
				evaluator.evaluatorDigest = "0".repeat(64);
			},
		],
		[
			"parser",
			(value: Record<string, unknown>) => {
				const parser = (value.goals as Array<Record<string, unknown>>)[0]!.parser as Record<string, unknown>;
				parser.parserDigest = "0".repeat(64);
			},
		],
		[
			"command",
			(value: Record<string, unknown>) => {
				const command = (value.goals as Array<Record<string, unknown>>)[0]!.command as Record<string, unknown>;
				command.commandDigest = "0".repeat(64);
			},
		],
		[
			"falsification manifest",
			(value: Record<string, unknown>) => {
				const falsification = (value.goals as Array<Record<string, unknown>>)[0]!.falsification as Record<
					string,
					unknown
				>;
				falsification.manifestDigest = "0".repeat(64);
			},
		],
		[
			"adversarial manifest",
			(value: Record<string, unknown>) => {
				const adversarial = (value.goals as Array<Record<string, unknown>>)[0]!.adversarial as Record<
					string,
					unknown
				>;
				adversarial.manifestDigest = "0".repeat(64);
			},
		],
	])("rejects a forged internally-derived %s digest", (_name, mutate) => {
		const value = validPortfolio();
		mutate(value);
		expect(() => parseAutoResearchPortfolioContract(value)).toThrow(/digest|canonical|derived/i);
	});

	it("rejects a forged standalone measurement digest", () => {
		const value = measurement("measurement-1", "candidate-1");
		value.measurementDigest = "0".repeat(64);
		expect(() => parseAutoResearchPortfolioMeasurement(value)).toThrow(/digest|canonical|derived/i);
	});

	it("enforces measurement sample count, interval containment, and contextual confidence", () => {
		const tooFewSamples = measurement("measurement-1", "candidate-1");
		tooFewSamples.sampleCount = 2;
		expect(() => parseAutoResearchPortfolioMeasurement(tooFewSamples)).toThrow(/sample|run/i);

		const outsideInterval = measurement("measurement-1", "candidate-1");
		(outsideInterval.vector as Array<Record<string, unknown>>)[0]!.value = 0.95;
		expect(() => parseAutoResearchPortfolioMeasurement(outsideInterval)).toThrow(/interval|confidence|vector/i);

		expect(() =>
			parseAutoResearchPortfolioMeasurement(measurement("measurement-1", "candidate-1"), {
				confidenceLevel: 0.9,
			}),
		).toThrow(/confidence|uncertainty|policy/i);
	});

	it("accepts one artifact per physical split", () => {
		const value = validPortfolio();
		const manifest = value.inputManifest as Record<string, unknown>;
		for (const split of ["training", "validation", "holdout"] as const) {
			const splitRecord = manifest[split] as Record<string, unknown>;
			splitRecord.artifacts = [(splitRecord.artifacts as Array<Record<string, unknown>>)[0]!];
		}
		refreshContractManifestBindings(value);
		expect(() => parseAutoResearchPortfolioContract(value)).not.toThrow();
	});

	it("projects training-only artifact metadata with authenticated bindings", () => {
		const parsed = parseAutoResearchPortfolioContract(validPortfolio());
		const projection = projectAutoResearchPortfolioTrainingProjection(parsed);
		const serialized = JSON.stringify(projection);

		expect(projection.split).toBe("training");
		expect(projection.manifestDigest).toBe(parsed.inputManifest.manifestDigest);
		expect(projection.closureRootDigest).toBe(parsed.inputManifest.training.closureRootDigest);
		expect(projection.evaluationEpoch).toBe(parsed.inputManifest.evaluationEpoch);
		expect(projection.artifacts).toHaveLength(parsed.inputManifest.training.artifacts.length);
		expect(serialized).toContain(parsed.inputManifest.training.artifacts[0]!.objectUri);
		expect(serialized).toContain(parsed.inputManifest.training.artifacts[0]!.sha256);
		for (const artifact of [
			...parsed.inputManifest.validation.artifacts,
			...parsed.inputManifest.holdout.artifacts,
		]) {
			for (const protectedValue of [
				artifact.objectUri,
				artifact.sha256,
				artifact.sourceTimeStart,
				artifact.sourceTimeEnd,
				artifact.closureRootDigest,
				artifact.provenance.sourceDataset,
				artifact.provenance.provenanceReceiptDigest,
			]) {
				expect(serialized).not.toContain(protectedValue);
			}
		}
	});

	it.each([
		[
			"rejects run-state projections on the immutable contract",
			(value: Record<string, unknown>) => {
				value.measurements = [];
			},
		],
		[
			"rejects a missing goal domain",
			(value: Record<string, unknown>) => {
				delete ((value.goals as Array<Record<string, unknown>>)[0] as Record<string, unknown>).domainId;
			},
		],
		[
			"rejects an unknown goal domain field",
			(value: Record<string, unknown>) => {
				((value.goals as Array<Record<string, unknown>>)[0] as Record<string, unknown>).domain = "market-quality";
			},
		],
		[
			"rejects a missing split artifact binding",
			(value: Record<string, unknown>) => {
				const training = value.inputManifest as Record<string, unknown>;
				(training.training as Record<string, unknown>).artifacts = [];
			},
		],
		[
			"rejects an artifact root mutation",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const validation = manifest.validation as Record<string, unknown>;
				const artifact = (validation.artifacts as Array<Record<string, unknown>>)[1]!;
				artifact.closureRootDigest = PORTFOLIO_ROOT_DIGEST;
			},
		],
		[
			"rejects a split manifest root mutation",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				(manifest.holdout as Record<string, unknown>).closureRootDigest = PORTFOLIO_ROOT_DIGEST;
			},
		],
		[
			"rejects an artifact with the wrong physical split",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const artifact = (
					(manifest.training as Record<string, unknown>).artifacts as Array<Record<string, unknown>>
				)[0]!;
				artifact.split = "holdout";
			},
		],
		[
			"rejects an artifact access-authority violation",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const artifact = (
					(manifest.validation as Record<string, unknown>).artifacts as Array<Record<string, unknown>>
				)[0]!;
				artifact.accessAuthority = "training_workers_training_only";
			},
		],
		[
			"rejects a forged measurement epoch",
			(value: Record<string, unknown>) => {
				value.evaluationEpoch = 0;
			},
		],
		[
			"rejects a forged measurement manifest root",
			(value: Record<string, unknown>) => {
				value.inputManifestDigest = "not-a-digest";
			},
		],
		[
			"rejects a mismatched measurement split root",
			(value: Record<string, unknown>) => {
				(value.splitClosureRoots as Record<string, unknown>).holdout = TRAINING_ROOT_DIGEST;
			},
		],
		[
			"rejects an inverted confidence interval",
			(value: Record<string, unknown>) => {
				(value.confidenceInterval as Record<string, unknown>).lower = 1;
			},
		],
		[
			"rejects an invalid confidence level",
			(value: Record<string, unknown>) => {
				(value.confidenceInterval as Record<string, unknown>).level = 1.1;
			},
		],
		[
			"rejects an unknown field",
			(value: Record<string, unknown>) => {
				value.unexpected = true;
			},
		],
		[
			"rejects malformed relations and lexicographic tiers",
			(value: Record<string, unknown>) => {
				(value.goalRelations as Array<Record<string, unknown>>)[0]!.relation = "unrelated";
				(value.lexicographicTiers as Array<Record<string, unknown>>)[1]!.tier = 3;
			},
		],
		[
			"rejects an unlocked evaluator",
			(value: Record<string, unknown>) => {
				const goalRecord = (value.goals as Array<Record<string, unknown>>)[0]!;
				(goalRecord.evaluator as Record<string, unknown>).locked = false;
			},
		],
		[
			"rejects an unlocked opaque holdout policy",
			(value: Record<string, unknown>) => {
				const goalRecord = (value.goals as Array<Record<string, unknown>>)[0]!;
				(goalRecord.opaqueHoldout as Record<string, unknown>).locked = false;
			},
		],
		[
			"rejects an unknown-or-missing collapse",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const artifact = (
					(manifest.validation as Record<string, unknown>).artifacts as Array<Record<string, unknown>>
				)[0]!;
				artifact.coverage = "unknown_or_missing";
			},
		],
		[
			"rejects an in-progress split as completion authority",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const artifact = (
					(manifest.holdout as Record<string, unknown>).artifacts as Array<Record<string, unknown>>
				)[0]!;
				artifact.lifecycle = "in_progress";
			},
		],
		[
			"rejects missing restore verification evidence",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const artifact = (
					(manifest.validation as Record<string, unknown>).artifacts as Array<Record<string, unknown>>
				)[0]!;
				artifact.restoreVerification = {
					locked: true,
					independentlyRestored: false,
					independentlyRehashed: true,
					verificationEvidenceDigest: VERIFICATION_DIGEST,
				};
			},
		],
		[
			"rejects sealed evidence without passed validation",
			(value: Record<string, unknown>) => {
				const manifest = value.inputManifest as Record<string, unknown>;
				const artifact = (
					(manifest.holdout as Record<string, unknown>).artifacts as Array<Record<string, unknown>>
				)[0]!;
				artifact.coverage = "unknown";
				artifact.gapClassification = "unknown";
				artifact.validationResult = "unknown";
			},
		],
		[
			"rejects a malformed measuredAt timestamp",
			(value: Record<string, unknown>) => {
				value.measuredAt = "not-a-timestamp";
			},
		],
	] as const)("rejects adversarial mutation", (name, mutate) => {
		const source =
			name.includes("measurement") || name.includes("measuredAt") || name.includes("confidence")
				? measurement("measurement-1", "candidate-1")
				: validPortfolio();
		mutate(source);
		const parse = "schemaVersion" in source ? parseAutoResearchPortfolioContract : null;
		if (parse !== null) {
			expect(() => parse(source), name).toThrow(
				/unknown|closed|incomplete|domain|artifact|root|split|authority|epoch|digest|interval|confidence|invalid|locked|coverage|lifecycle|restore|timestamp|relation|tier/i,
			);
		} else {
			expect(() => parseAutoResearchPortfolioMeasurement(source), name).toThrow(
				/unknown|digest|epoch|interval|confidence|timestamp|split/i,
			);
		}
	});

	it("rejects read-only provenance as an active portfolio", () => {
		expect(() =>
			parseAutoResearchPortfolioContract({
				kind: "read_only_provenance",
				source: "host",
				sourceDigest: DIGEST,
				recordedAt: "2026-08-17T12:00:00.000Z",
			}),
		).toThrow(/read-only provenance|active portfolio/i);
	});

	it("fails closed on a legacy scalar schema with an actionable migration error", () => {
		expect(() =>
			parseAutoResearchPortfolioContract({
				schemaVersion: 2,
				goal: "maximize one score",
				metric: { name: "score", direction: "higher" },
				target: 1,
			}),
		).toThrow(/incompatible.*migration|migration.*schema|legacy.*scalar/i);
	});
});
