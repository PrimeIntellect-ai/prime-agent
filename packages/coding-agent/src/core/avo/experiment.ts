import { createHash } from "node:crypto";
import { classifyAvoHostEvaluationCommand } from "./evaluator.js";
import type {
	AvoCandidateAggregate,
	AvoConditionAggregate,
	AvoConditionPairedComparison,
	AvoEnvironment,
	AvoExperiment,
	AvoExperimentCondition,
	AvoExperimentOutcome,
	AvoExperimentPlan,
	AvoExperimentPlanInput,
	AvoMetricSummary,
	AvoPairedComparison,
	AvoTrial,
} from "./types.js";

const RESERVED_EXPERIMENT_METRICS = new Set([
	"candidate_payload_digest",
	"cell_digest",
	"command_digest",
	"condition_id",
	"experiment_id",
	"meaningful",
	"output_digest",
	"seed",
	"source_evaluation_created_at",
	"source_evaluation_id",
]);

function markerSafe(value: string, label: string): string {
	const normalized = value.trim();
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized)) {
		throw new Error(`${label} must be a marker-safe identifier`);
	}
	return normalized;
}

function metricName(value: string): string {
	const normalized = value.trim();
	if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(normalized)) {
		throw new Error("experiment primary_metric must be a safe metric name");
	}
	if (RESERVED_EXPERIMENT_METRICS.has(normalized)) {
		throw new Error(`experiment primary_metric ${normalized} is reserved by the host`);
	}
	return normalized;
}

function experimentSeed(value: string | number): string {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new Error("numeric experiment seeds must be safe integers");
		return String(value);
	}
	return markerSafe(value, "experiment seed");
}

function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
		.join(",")}}`;
}

export function digestAvoExperimentValue(value: unknown): string {
	return createHash("sha256").update(stableJson(value)).digest("hex");
}

function scalarParameters(
	value: Record<string, number | string | boolean> | undefined,
	label: string,
): Record<string, number | string | boolean> {
	const parameters: Record<string, number | string | boolean> = {};
	for (const [key, item] of Object.entries(value ?? {})) {
		if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new Error(`${label}.${key} has an invalid key`);
		if (typeof item === "number" && !Number.isFinite(item)) throw new Error(`${label}.${key} must be finite`);
		if (typeof item === "string" && (!item.trim() || item.length > 128 || !/^[A-Za-z0-9._:/+ -]+$/.test(item))) {
			throw new Error(`${label}.${key} must be a bounded shell-safe scalar`);
		}
		parameters[key] = item;
	}
	if (Object.keys(parameters).length > 32) throw new Error(`${label} may contain at most 32 parameters`);
	return parameters;
}

function shellValue(value: number | string | boolean): string {
	return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function templateBindsOption(template: string, option: string, placeholder: string): boolean {
	const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|\\s)--${escapeRegex(option)}(?:=|\\s+)${escapeRegex(placeholder)}(?=\\s|$)`).test(template);
}

function renderTemplate(
	template: string,
	candidateId: string,
	condition: AvoExperimentCondition,
	seed: string,
): string {
	let command = template
		.replaceAll("{{candidate_id}}", shellValue(candidateId))
		.replaceAll("{{condition_id}}", shellValue(condition.conditionId))
		.replaceAll("{{seed}}", shellValue(seed));
	for (const [key, value] of Object.entries(condition.parameters)) {
		command = command.replaceAll(`{{param:${key}}}`, shellValue(value));
	}
	if (/{{[^{}]+}}/.test(command)) throw new Error("experiment command_template contains an unknown placeholder");
	classifyAvoHostEvaluationCommand(command);
	return command;
}

export function normalizeAvoExperimentPlan(
	input: AvoExperimentPlanInput,
	environment: AvoEnvironment,
): AvoExperimentPlan {
	if (!input || typeof input !== "object") throw new Error("experiment.plan must be an object");
	if (!Array.isArray(input.candidateIds)) throw new Error("experiment plan candidate_ids must be an array");
	if (!Array.isArray(input.seeds)) throw new Error("experiment plan seeds must be an array");
	const candidateIds = [...new Set(input.candidateIds.map((item) => markerSafe(item, "candidate_id")))];
	if (candidateIds.length === 0 || candidateIds.length > 16 || candidateIds.length !== input.candidateIds.length) {
		throw new Error("experiment plan requires 1 to 16 unique candidate_ids");
	}
	const seeds = [...new Set(input.seeds.map(experimentSeed))];
	if (seeds.length === 0 || seeds.length > 1_000 || seeds.length !== input.seeds.length) {
		throw new Error("experiment plan requires 1 to 1000 unique seeds");
	}
	if (!Array.isArray(input.conditions) || input.conditions.length === 0 || input.conditions.length > 64) {
		throw new Error("experiment plan requires 1 to 64 conditions");
	}
	const conditions = input.conditions.map((condition, index): AvoExperimentCondition => {
		const conditionId = markerSafe(condition.conditionId, `experiment.conditions[${index}].condition_id`);
		const label = condition.label?.trim() || conditionId;
		if (label.length > 160) throw new Error(`experiment.conditions[${index}].label is too long`);
		const commandTemplate = condition.commandTemplate.trim();
		if (!commandTemplate || commandTemplate.length > 20_000) {
			throw new Error(`experiment.conditions[${index}].command_template must contain 1 to 20000 characters`);
		}
		if (!templateBindsOption(commandTemplate, "seed", "{{seed}}")) {
			throw new Error(`experiment condition ${conditionId} must bind --seed {{seed}} in command_template`);
		}
		const parameters = scalarParameters(condition.parameters, `experiment.conditions[${index}].parameters`);
		for (const key of Object.keys(parameters)) {
			if (!templateBindsOption(commandTemplate, key, `{{param:${key}}}`)) {
				throw new Error(
					`experiment condition ${conditionId} must bind --${key} {{param:${key}}} in command_template`,
				);
			}
		}
		if (
			input.conditions.length > 1 &&
			Object.keys(parameters).length === 0 &&
			!templateBindsOption(commandTemplate, "condition", "{{condition_id}}")
		) {
			throw new Error(
				`experiment condition ${conditionId} must bind --condition {{condition_id}} in command_template`,
			);
		}
		if (
			candidateIds.length > 1 &&
			environment !== "coding" &&
			!templateBindsOption(commandTemplate, "candidate", "{{candidate_id}}")
		) {
			throw new Error(
				`multi-candidate ${environment} experiments must bind --candidate {{candidate_id}} in command_template`,
			);
		}
		return { conditionId, label, parameters, commandTemplate };
	});
	if (new Set(conditions.map((condition) => condition.conditionId)).size !== conditions.length) {
		throw new Error("experiment condition_id values must be unique");
	}
	const mode = input.mode ?? "prospective";
	if (mode !== "prospective" && mode !== "retrospective") throw new Error("experiment mode is invalid");
	const pairing = input.pairing ?? "paired";
	if (pairing !== "paired" && pairing !== "independent") throw new Error("experiment pairing is invalid");
	if (input.metricDirection !== "maximize" && input.metricDirection !== "minimize") {
		throw new Error("experiment metric_direction must be maximize or minimize");
	}
	const baselineCandidateId = input.baselineCandidateId
		? markerSafe(input.baselineCandidateId, "baseline_candidate_id")
		: undefined;
	if (candidateIds.length > 1 && (!baselineCandidateId || !candidateIds.includes(baselineCandidateId))) {
		throw new Error("multi-candidate experiments require a baseline_candidate_id from candidate_ids");
	}
	const expectedTrials = candidateIds.length * conditions.length * seeds.length;
	if (expectedTrials > 1_024) throw new Error("experiment plan exceeds the 1024-trial host limit");
	const plan: AvoExperimentPlan = {
		mode,
		candidateIds,
		conditions,
		seeds,
		pairing,
		primaryMetric: metricName(input.primaryMetric),
		metricDirection: input.metricDirection,
		baselineCandidateId,
		expectedTrials,
	};
	for (const condition of conditions) {
		for (const candidateId of candidateIds) {
			for (const seed of seeds) renderTemplate(condition.commandTemplate, candidateId, condition, seed);
		}
	}
	return plan;
}

export interface AvoExperimentCellContract {
	experimentId: string;
	candidateId: string;
	conditionId: string;
	seed: string;
	label: string;
	parameters: Record<string, number | string | boolean>;
	command: string;
	commandDigest: string;
	cellDigest: string;
}

export function deriveAvoExperimentCellContract(
	experiment: AvoExperiment,
	candidateId: string,
	conditionId: string,
	seed: string,
): AvoExperimentCellContract {
	const plan = experiment.plan;
	if (!plan) throw new Error(`experiment ${experiment.experimentId} predates structured trial planning`);
	if (!plan.candidateIds.includes(candidateId)) throw new Error(`candidate ${candidateId} is not preregistered`);
	const condition = plan.conditions.find((item) => item.conditionId === conditionId);
	if (!condition) throw new Error(`condition ${conditionId} is not preregistered`);
	if (!plan.seeds.includes(seed)) throw new Error(`seed ${seed} is not preregistered`);
	const command = renderTemplate(condition.commandTemplate, candidateId, condition, seed);
	const commandDigest = createHash("sha256").update(command).digest("hex");
	const cellDigest = digestAvoExperimentValue({
		experimentId: experiment.experimentId,
		candidateId,
		conditionId,
		seed,
		parameters: condition.parameters,
		commandDigest,
	});
	return {
		experimentId: experiment.experimentId,
		candidateId,
		conditionId,
		seed,
		label: `${candidateId} · ${condition.label} · seed ${seed}`,
		parameters: structuredClone(condition.parameters),
		command,
		commandDigest,
		cellDigest,
	};
}

export function parseAvoTrialMetricsOutput(
	output: string,
	allowedMetric: string,
): Record<string, number | string | boolean> {
	const prefix = "AVO_TRIAL_METRICS_JSON:";
	const lines = output
		.replaceAll("\r", "")
		.split("\n")
		.filter((line) => line.startsWith(prefix));
	if (lines.length === 0) return {};
	if (lines.length !== 1) throw new Error("trial command output must contain at most one metrics marker");
	const encoded = lines[0]!.slice(prefix.length);
	if (encoded.length === 0 || encoded.length > 16_384) throw new Error("trial metrics JSON is empty or too large");
	const parsed = JSON.parse(encoded) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("trial metrics marker must contain one JSON object");
	}
	const metrics: Record<string, number | string | boolean> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (key !== allowedMetric) throw new Error(`trial output returned undeclared metric ${key}`);
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`trial metric ${key} must be a finite number`);
		}
		metrics[key] = value;
	}
	return metrics;
}

function metricSummary(values: readonly number[]): AvoMetricSummary {
	if (values.length === 0 || values.some((value) => !Number.isFinite(value))) {
		throw new Error("experiment aggregate requires finite numeric observations");
	}
	const sorted = [...values].sort((left, right) => left - right);
	const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
	const variance =
		values.length > 1 ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1) : 0;
	const standardDeviation = Math.sqrt(variance);
	const margin = 1.96 * (standardDeviation / Math.sqrt(values.length));
	return {
		count: values.length,
		mean,
		median,
		variance,
		standardDeviation,
		minimum: sorted[0]!,
		maximum: sorted.at(-1)!,
		ci95Low: mean - margin,
		ci95High: mean + margin,
	};
}

function observationKey(candidateId: string, conditionId: string | undefined, seed: string | undefined): string {
	return digestAvoExperimentValue([candidateId, conditionId ?? null, seed ?? null]);
}

export function deriveAvoExperimentOutcome(
	experiment: AvoExperiment,
	trials: readonly AvoTrial[],
): AvoExperimentOutcome {
	const plan = experiment.plan;
	if (!plan) throw new Error(`experiment ${experiment.experimentId} has no structured plan`);
	const valuesByCandidate = new Map<string, number[]>();
	for (const candidateId of plan.candidateIds) valuesByCandidate.set(candidateId, []);
	for (const trial of trials) {
		const value = trial.metrics[plan.primaryMetric];
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`trial ${trial.trialId} lacks numeric primary metric ${plan.primaryMetric}`);
		}
		valuesByCandidate.get(trial.candidateId)?.push(value);
	}
	const candidateAggregates: AvoCandidateAggregate[] = plan.candidateIds.map((candidateId) => ({
		candidateId,
		metric: metricSummary(valuesByCandidate.get(candidateId) ?? []),
	}));
	const conditionAggregates: AvoConditionAggregate[] = plan.conditions.flatMap((condition) =>
		plan.candidateIds.map((candidateId) => ({
			conditionId: condition.conditionId,
			candidateId,
			metric: metricSummary(
				trials
					.filter((trial) => trial.conditionId === condition.conditionId && trial.candidateId === candidateId)
					.map((trial) => trial.metrics[plan.primaryMetric] as number),
			),
		})),
	);
	const direction = plan.metricDirection === "maximize" ? 1 : -1;
	const ranking = [...candidateAggregates]
		.sort(
			(left, right) =>
				direction * (right.metric.mean - left.metric.mean) || left.candidateId.localeCompare(right.candidateId),
		)
		.map((item) => item.candidateId);
	const pairedComparisons: AvoPairedComparison[] = [];
	const conditionPairedComparisons: AvoConditionPairedComparison[] = [];
	if (plan.pairing === "paired" && plan.baselineCandidateId) {
		const baselineCandidateId = plan.baselineCandidateId;
		const byCell = new Map(
			trials.map((trial) => [observationKey(trial.candidateId, trial.conditionId, trial.seed), trial]),
		);
		for (const candidateId of plan.candidateIds) {
			if (candidateId === baselineCandidateId) continue;
			const deltas: number[] = [];
			for (const condition of plan.conditions) {
				for (const seed of plan.seeds) {
					const candidate = byCell.get(observationKey(candidateId, condition.conditionId, seed));
					const baseline = byCell.get(observationKey(baselineCandidateId, condition.conditionId, seed));
					const candidateValue = candidate?.metrics[plan.primaryMetric];
					const baselineValue = baseline?.metrics[plan.primaryMetric];
					if (typeof candidateValue !== "number" || typeof baselineValue !== "number") {
						throw new Error("paired experiment is missing a matched numeric observation");
					}
					deltas.push(candidateValue - baselineValue);
				}
			}
			const delta = metricSummary(deltas);
			const wins = deltas.filter((value) => direction * value > 0).length;
			const losses = deltas.filter((value) => direction * value < 0).length;
			pairedComparisons.push({
				candidateId,
				baselineCandidateId,
				delta,
				favorableMean: direction * delta.mean,
				favorableCi95Low: direction === 1 ? delta.ci95Low : -delta.ci95High,
				favorableCi95High: direction === 1 ? delta.ci95High : -delta.ci95Low,
				wins,
				losses,
				ties: deltas.length - wins - losses,
				winRate: wins / Math.max(1, deltas.length),
			});
			for (const condition of plan.conditions) {
				const conditionDeltas = plan.seeds.map((seed) => {
					const candidate = byCell.get(observationKey(candidateId, condition.conditionId, seed));
					const baseline = byCell.get(observationKey(baselineCandidateId, condition.conditionId, seed));
					const candidateValue = candidate?.metrics[plan.primaryMetric];
					const baselineValue = baseline?.metrics[plan.primaryMetric];
					if (typeof candidateValue !== "number" || typeof baselineValue !== "number") {
						throw new Error("paired experiment is missing a condition-level numeric observation");
					}
					return candidateValue - baselineValue;
				});
				const conditionDelta = metricSummary(conditionDeltas);
				const conditionWins = conditionDeltas.filter((value) => direction * value > 0).length;
				const conditionLosses = conditionDeltas.filter((value) => direction * value < 0).length;
				conditionPairedComparisons.push({
					conditionId: condition.conditionId,
					candidateId,
					baselineCandidateId,
					delta: conditionDelta,
					favorableMean: direction * conditionDelta.mean,
					favorableCi95Low: direction === 1 ? conditionDelta.ci95Low : -conditionDelta.ci95High,
					favorableCi95High: direction === 1 ? conditionDelta.ci95High : -conditionDelta.ci95Low,
					wins: conditionWins,
					losses: conditionLosses,
					ties: conditionDeltas.length - conditionWins - conditionLosses,
					winRate: conditionWins / Math.max(1, conditionDeltas.length),
				});
			}
		}
	}
	let championCandidateId: string | undefined;
	let decision: AvoExperimentOutcome["decision"] = "inconclusive";
	let reason = "a single candidate or independent design does not support host-issued champion promotion";
	if (plan.candidateIds.length > 1 && plan.pairing === "paired" && plan.baselineCandidateId) {
		const top = ranking[0]!;
		if (top === plan.baselineCandidateId) {
			championCandidateId = plan.baselineCandidateId;
			decision = "retain";
			reason = "the preregistered baseline retained the best aggregate primary metric";
		} else {
			const comparison = pairedComparisons.find((item) => item.candidateId === top)!;
			if (comparison.delta.count >= 2 && comparison.favorableCi95Low > 0) {
				championCandidateId = top;
				decision = "promote";
				reason = "the top challenger improved the paired primary metric with a positive 95% confidence interval";
			} else {
				championCandidateId = plan.baselineCandidateId;
				decision = "retain";
				reason = "the challenger did not clear the positive paired 95% confidence bound";
			}
		}
	}
	const trialManifestDigest = digestAvoExperimentValue(
		[...trials]
			.sort((left, right) => (left.cellDigest ?? left.trialId).localeCompare(right.cellDigest ?? right.trialId))
			.map((trial) => ({
				trialId: trial.trialId,
				evaluationId: trial.evaluationId,
				sourceEvaluationId: trial.sourceEvaluationId,
				candidateId: trial.candidateId,
				conditionId: trial.conditionId,
				seed: trial.seed,
				cellDigest: trial.cellDigest,
				commandDigest: trial.commandDigest,
				primaryMetric: trial.metrics[plan.primaryMetric],
			})),
	);
	const withoutDigest = {
		primaryMetric: plan.primaryMetric,
		metricDirection: plan.metricDirection,
		candidateAggregates,
		conditionAggregates,
		pairedComparisons,
		conditionPairedComparisons,
		ranking,
		championCandidateId,
		decision,
		reason,
		trialManifestDigest,
	};
	return { ...withoutDigest, aggregateDigest: digestAvoExperimentValue(withoutDigest) };
}
