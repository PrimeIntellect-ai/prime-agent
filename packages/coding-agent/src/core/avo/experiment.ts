import { createHash } from "node:crypto";
import { classifyAvoHostEvaluationCommand } from "./evaluator.js";
import type {
	AvoCandidate,
	AvoCandidateAggregate,
	AvoConditionAggregate,
	AvoConditionPairedComparison,
	AvoEnvironment,
	AvoExperiment,
	AvoExperimentCondition,
	AvoExperimentOutcome,
	AvoExperimentPlan,
	AvoExperimentPlanInput,
	AvoExperimentSelectionEvidence,
	AvoMetricSummary,
	AvoPairedComparison,
	AvoTrial,
} from "./types.js";
import {
	AVO_EXPERIMENT_FAMILYWISE_ALPHA,
	AVO_EXPERIMENT_INFERENCE_VERSION,
	AVO_EXPERIMENT_SELECTION_POLICY_VERSION,
	AVO_MIN_PAIRED_OBSERVATIONS_FOR_PROMOTION,
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

// Two-sided 95% Student-t critical values for 1-30 degrees of freedom.
// Above 30 df, a third-order Cornish-Fisher expansion is effectively exact
// for the precision retained in experiment receipts and avoids a statistics
// runtime dependency in the host authority path.
const STUDENT_T_975_CRITICAL_VALUES = [
	Number.NaN,
	12.706204736432095,
	4.302652729696142,
	3.182446305284263,
	2.7764451051977987,
	2.570581835636314,
	2.4469118487916806,
	2.3646242515927844,
	2.3060041350333704,
	2.2621571628540993,
	2.2281388519649385,
	2.200985160091638,
	2.1788128296634177,
	2.1603686564610127,
	2.1447866879169273,
	2.131449545559323,
	2.1199052992210112,
	2.1098155778331806,
	2.10092204024096,
	2.093024054408263,
	2.0859634472658364,
	2.079613844727662,
	2.0738730679040147,
	2.0686576104190406,
	2.0638985616280205,
	2.059538552753294,
	2.055529438642871,
	2.0518305164802833,
	2.048407141795244,
	2.045229642132703,
	2.0422724563012373,
] as const;

function studentT975CriticalValue(degreesOfFreedom: number): number {
	if (!Number.isSafeInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
		throw new Error("Student-t confidence intervals require at least one degree of freedom");
	}
	const tabulated = STUDENT_T_975_CRITICAL_VALUES[degreesOfFreedom];
	if (tabulated !== undefined) return tabulated;
	const z = 1.959963984540054;
	const inverseDf = 1 / degreesOfFreedom;
	const z2 = z * z;
	const z3 = z2 * z;
	const z5 = z3 * z2;
	const z7 = z5 * z2;
	return (
		z +
		((z3 + z) * inverseDf) / 4 +
		((5 * z5 + 16 * z3 + 3 * z) * inverseDf ** 2) / 96 +
		((3 * z7 + 19 * z5 + 17 * z3 - 15 * z) * inverseDf ** 3) / 384
	);
}

function logGamma(value: number): number {
	const coefficients = [
		0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406,
		12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
	] as const;
	if (!Number.isFinite(value) || value <= 0) throw new Error("log-gamma requires a positive finite value");
	if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
	const shifted = value - 1;
	let series = coefficients[0];
	for (let index = 1; index < coefficients.length; index++) {
		series += coefficients[index]! / (shifted + index);
	}
	const base = shifted + coefficients.length - 1.5;
	return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(base) - base + Math.log(series);
}

function betaContinuedFraction(firstShape: number, secondShape: number, value: number): number {
	const maximumIterations = 240;
	const epsilon = 3e-14;
	const floor = 1e-300;
	const sum = firstShape + secondShape;
	const firstPlusOne = firstShape + 1;
	const firstMinusOne = firstShape - 1;
	let c = 1;
	let d = 1 - (sum * value) / firstPlusOne;
	if (Math.abs(d) < floor) d = floor;
	d = 1 / d;
	let fraction = d;
	for (let iteration = 1; iteration <= maximumIterations; iteration++) {
		const doubled = 2 * iteration;
		let coefficient =
			(iteration * (secondShape - iteration) * value) / ((firstMinusOne + doubled) * (firstShape + doubled));
		d = 1 + coefficient * d;
		if (Math.abs(d) < floor) d = floor;
		c = 1 + coefficient / c;
		if (Math.abs(c) < floor) c = floor;
		d = 1 / d;
		fraction *= d * c;
		coefficient =
			-((firstShape + iteration) * (sum + iteration) * value) / ((firstShape + doubled) * (firstPlusOne + doubled));
		d = 1 + coefficient * d;
		if (Math.abs(d) < floor) d = floor;
		c = 1 + coefficient / c;
		if (Math.abs(c) < floor) c = floor;
		d = 1 / d;
		const delta = d * c;
		fraction *= delta;
		if (Math.abs(delta - 1) <= epsilon) return fraction;
	}
	throw new Error("Student-t probability calculation did not converge");
}

function regularizedIncompleteBeta(value: number, firstShape: number, secondShape: number): number {
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	const scale = Math.exp(
		logGamma(firstShape + secondShape) -
			logGamma(firstShape) -
			logGamma(secondShape) +
			firstShape * Math.log(value) +
			secondShape * Math.log1p(-value),
	);
	const result =
		value < (firstShape + 1) / (firstShape + secondShape + 2)
			? (scale * betaContinuedFraction(firstShape, secondShape, value)) / firstShape
			: 1 - (scale * betaContinuedFraction(secondShape, firstShape, 1 - value)) / secondShape;
	return Math.min(1, Math.max(0, result));
}

export function avoStudentTUpperTailProbability(tStatistic: number, degreesOfFreedom: number): number {
	if (!Number.isFinite(tStatistic)) {
		if (tStatistic === Number.POSITIVE_INFINITY) return 0;
		if (tStatistic === Number.NEGATIVE_INFINITY) return 1;
		throw new Error("Student-t probability requires a numeric test statistic");
	}
	if (!Number.isSafeInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
		throw new Error("Student-t probability requires at least one degree of freedom");
	}
	if (tStatistic === 0) return 0.5;
	const beta = regularizedIncompleteBeta(
		degreesOfFreedom / (degreesOfFreedom + tStatistic * tStatistic),
		degreesOfFreedom / 2,
		0.5,
	);
	return tStatistic > 0 ? beta / 2 : 1 - beta / 2;
}

function studentTUpperCriticalValue(alpha: number, degreesOfFreedom: number): number {
	if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 0.5) {
		throw new Error("Student-t upper critical value requires alpha between zero and one half");
	}
	let lower = 0;
	let upper = 1;
	while (avoStudentTUpperTailProbability(upper, degreesOfFreedom) > alpha) {
		upper *= 2;
		if (!Number.isFinite(upper)) throw new Error("Student-t upper critical value could not be bounded");
	}
	for (let iteration = 0; iteration < 96; iteration++) {
		const middle = (lower + upper) / 2;
		if (avoStudentTUpperTailProbability(middle, degreesOfFreedom) > alpha) lower = middle;
		else upper = middle;
	}
	return (lower + upper) / 2;
}

export function deriveAvoExperimentAllocatedAlpha(attemptIndex: number): number {
	if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 1) {
		throw new Error("experiment selection attempt index must be a positive safe integer");
	}
	return AVO_EXPERIMENT_FAMILYWISE_ALPHA / (attemptIndex * (attemptIndex + 1));
}

export function deriveAvoExperimentCumulativeAlpha(attemptIndex: number): number {
	if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 1) {
		throw new Error("experiment selection attempt index must be a positive safe integer");
	}
	return AVO_EXPERIMENT_FAMILYWISE_ALPHA * (attemptIndex / (attemptIndex + 1));
}

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

function nonNegativeFinite(value: number | undefined, fallback: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isFinite(resolved) || resolved < 0) throw new Error(`${label} must be a finite non-negative number`);
	return resolved;
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

export function digestAvoExperimentSelectionBinding(experimentId: string, plan: AvoExperimentPlan): string {
	const { selectionReservation, ...boundPlan } = plan;
	void selectionReservation;
	return digestAvoExperimentValue({ experimentId, plan: boundPlan });
}

function approximatelyEqual(left: number, right: number): boolean {
	return Math.abs(left - right) <= Number.EPSILON * 16 * Math.max(1, Math.abs(left), Math.abs(right));
}

export function isAvoExperimentSelectionReservationCurrent(experimentId: string, plan: AvoExperimentPlan): boolean {
	const reservation = plan.selectionReservation;
	if (!reservation) return false;
	return (
		reservation.policyVersion === AVO_EXPERIMENT_SELECTION_POLICY_VERSION &&
		/^[a-f0-9]{64}$/.test(reservation.familyId) &&
		/^[a-f0-9]{64}$/.test(reservation.reservationId) &&
		/^[a-f0-9]{64}$/.test(reservation.bindingDigest) &&
		Number.isSafeInteger(reservation.attemptIndex) &&
		reservation.attemptIndex >= 1 &&
		approximatelyEqual(reservation.familywiseAlpha, AVO_EXPERIMENT_FAMILYWISE_ALPHA) &&
		approximatelyEqual(reservation.allocatedAlpha, deriveAvoExperimentAllocatedAlpha(reservation.attemptIndex)) &&
		approximatelyEqual(reservation.cumulativeAlpha, deriveAvoExperimentCumulativeAlpha(reservation.attemptIndex)) &&
		reservation.bindingDigest === digestAvoExperimentSelectionBinding(experimentId, plan) &&
		typeof reservation.reservedAt === "string" &&
		reservation.reservedAt.length > 0
	);
}

export function digestAvoExperimentCandidateIdentity(candidate: AvoCandidate): string {
	return digestAvoExperimentValue({
		kind: candidate.kind,
		payloadDigest: candidate.payloadDigest,
		deterministicResult: candidate.deterministicResult ?? null,
		artifactTargetDigest: candidate.artifactTargetDigest ?? null,
		claims: [...(candidate.claims ?? [])].sort((left, right) => left.claimId.localeCompare(right.claimId)),
		workspaceDigest: candidate.workspaceDigest ?? null,
		workspaceMode: candidate.workspaceMode ?? null,
	});
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
	const stage = input.stage ?? "screening";
	if (stage !== "screening" && stage !== "confirmation") throw new Error("experiment stage is invalid");
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
	const pairedObservations = conditions.length * seeds.length;
	const minimumPairedObservations =
		input.promotion?.minimumPairedObservations ?? AVO_MIN_PAIRED_OBSERVATIONS_FOR_PROMOTION;
	if (
		!Number.isSafeInteger(minimumPairedObservations) ||
		minimumPairedObservations < AVO_MIN_PAIRED_OBSERVATIONS_FOR_PROMOTION ||
		minimumPairedObservations > 1_024
	) {
		throw new Error(
			`experiment promotion.min_pairs must be an integer from ${AVO_MIN_PAIRED_OBSERVATIONS_FOR_PROMOTION} to 1024`,
		);
	}
	const minimumAbsoluteEffect = nonNegativeFinite(
		input.promotion?.minimumAbsoluteEffect,
		0,
		"experiment promotion.min_effect",
	);
	const minimumRelativeEffect = nonNegativeFinite(
		input.promotion?.minimumRelativeEffect,
		0,
		"experiment promotion.min_relative_effect",
	);
	const confirmationOfExperimentId = input.confirmationOfExperimentId
		? markerSafe(input.confirmationOfExperimentId, "confirmation_of_experiment_id")
		: undefined;
	if (stage === "screening") {
		if (confirmationOfExperimentId) {
			throw new Error("screening experiments cannot declare confirmation_of_experiment_id");
		}
		if (input.promotion !== undefined) {
			throw new Error("screening experiments rank candidates only and cannot declare a promotion policy");
		}
	} else {
		if (mode !== "prospective") throw new Error("confirmation experiments must be prospective");
		if (pairing !== "paired") throw new Error("confirmation experiments must use paired observations");
		if (candidateIds.length !== 2 || !baselineCandidateId) {
			throw new Error("confirmation experiments require exactly one baseline and one challenger");
		}
		if (!confirmationOfExperimentId) {
			throw new Error("confirmation experiments require confirmation_of_experiment_id");
		}
		if (!input.promotion) throw new Error("confirmation experiments require a promotion policy");
		if (minimumAbsoluteEffect === 0 && minimumRelativeEffect === 0) {
			throw new Error("confirmation promotion requires a positive min_effect or min_relative_effect");
		}
		if (minimumPairedObservations > pairedObservations) {
			throw new Error(
				`confirmation plan has ${pairedObservations} matched cells but requires ${minimumPairedObservations} paired observations`,
			);
		}
	}
	const plan: AvoExperimentPlan = {
		stage,
		mode,
		candidateIds,
		conditions,
		seeds,
		pairing,
		primaryMetric: metricName(input.primaryMetric),
		metricDirection: input.metricDirection,
		baselineCandidateId,
		confirmationOfExperimentId,
		promotion: {
			minimumPairedObservations,
			minimumAbsoluteEffect,
			minimumRelativeEffect,
		},
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
	let scale = 0;
	for (const value of values) scale = Math.max(scale, Math.abs(value));
	let scaledMean = 0;
	let scaledSquaredDeviations = 0;
	if (scale > 0) {
		for (const [index, value] of values.entries()) {
			const scaled = value / scale;
			const delta = scaled - scaledMean;
			scaledMean += delta / (index + 1);
			scaledSquaredDeviations += delta * (scaled - scaledMean);
		}
	}
	const mean = scale === 0 ? 0 : scaledMean * scale;
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? sorted[middle - 1]! / 2 + sorted[middle]! / 2 : sorted[middle]!;
	const scaledVariance = values.length > 1 ? scaledSquaredDeviations / (values.length - 1) : 0;
	const standardDeviation = scale === 0 ? 0 : scale * Math.sqrt(Math.max(0, scaledVariance));
	const variance = standardDeviation * standardDeviation;
	const ci95DegreesOfFreedom = values.length - 1;
	const margin =
		ci95DegreesOfFreedom > 0
			? studentT975CriticalValue(ci95DegreesOfFreedom) * (standardDeviation / Math.sqrt(values.length))
			: undefined;
	const ci95Low = margin === undefined ? null : mean - margin;
	const ci95High = margin === undefined ? null : mean + margin;
	if (
		![mean, median, variance, standardDeviation, sorted[0]!, sorted.at(-1)!].every(Number.isFinite) ||
		(margin !== undefined && ![margin, ci95Low, ci95High].every(Number.isFinite))
	) {
		throw new Error("experiment metric summary exceeds the host finite numeric range");
	}
	return {
		count: values.length,
		mean,
		median,
		variance,
		standardDeviation,
		minimum: sorted[0]!,
		maximum: sorted.at(-1)!,
		ci95Method: margin === undefined ? "not_estimable" : "student_t",
		ci95DegreesOfFreedom,
		ci95Low,
		ci95High,
	};
}

function observationKey(candidateId: string, conditionId: string | undefined, seed: string | undefined): string {
	return digestAvoExperimentValue([candidateId, conditionId ?? null, seed ?? null]);
}

function deriveSelectionEvidence(
	comparison: AvoPairedComparison,
	requiredMinimumEffect: number,
	plan: AvoExperimentPlan,
): AvoExperimentSelectionEvidence {
	const reservation = plan.selectionReservation!;
	const standardError = comparison.delta.standardDeviation / Math.sqrt(comparison.delta.count);
	const testStatistic =
		standardError === 0
			? comparison.favorableMean > requiredMinimumEffect
				? Number.POSITIVE_INFINITY
				: Number.NEGATIVE_INFINITY
			: (comparison.favorableMean - requiredMinimumEffect) / standardError;
	const oneSidedPValue = avoStudentTUpperTailProbability(testStatistic, comparison.delta.ci95DegreesOfFreedom);
	const criticalValue = studentTUpperCriticalValue(reservation.allocatedAlpha, comparison.delta.ci95DegreesOfFreedom);
	const favorableLowerBound =
		standardError === 0 ? comparison.favorableMean : comparison.favorableMean - criticalValue * standardError;
	if (![standardError, oneSidedPValue, criticalValue, favorableLowerBound].every(Number.isFinite)) {
		throw new Error("experiment selection evidence exceeds the host finite numeric range");
	}
	return {
		...structuredClone(reservation),
		candidateId: comparison.candidateId,
		oneSidedPValue,
		oneSidedConfidenceLevel: 1 - reservation.allocatedAlpha,
		favorableLowerBound,
		passed:
			comparison.delta.count >= plan.promotion.minimumPairedObservations &&
			oneSidedPValue <= reservation.allocatedAlpha &&
			favorableLowerBound > requiredMinimumEffect,
	};
}

export function deriveAvoExperimentOutcome(
	experiment: AvoExperiment,
	trials: readonly AvoTrial[],
): AvoExperimentOutcome {
	const plan = experiment.plan;
	if (!plan) throw new Error(`experiment ${experiment.experimentId} has no structured plan`);
	if (plan.stage === "confirmation" && !isAvoExperimentSelectionReservationCurrent(experiment.experimentId, plan)) {
		throw new Error("confirmation experiment lacks a current host-reserved project selection error budget");
	}
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
				favorableCi95Low:
					delta.ci95Low === null || delta.ci95High === null
						? null
						: direction === 1
							? delta.ci95Low
							: -delta.ci95High,
				favorableCi95High:
					delta.ci95Low === null || delta.ci95High === null
						? null
						: direction === 1
							? delta.ci95High
							: -delta.ci95Low,
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
					favorableCi95Low:
						conditionDelta.ci95Low === null || conditionDelta.ci95High === null
							? null
							: direction === 1
								? conditionDelta.ci95Low
								: -conditionDelta.ci95High,
					favorableCi95High:
						conditionDelta.ci95Low === null || conditionDelta.ci95High === null
							? null
							: direction === 1
								? conditionDelta.ci95High
								: -conditionDelta.ci95Low,
					wins: conditionWins,
					losses: conditionLosses,
					ties: conditionDeltas.length - conditionWins - conditionLosses,
					winRate: conditionWins / Math.max(1, conditionDeltas.length),
				});
			}
		}
	}
	const provisionalBestCandidateId = ranking[0];
	let championCandidateId: string | undefined;
	let decision: AvoExperimentOutcome["decision"] = "inconclusive";
	let reason =
		plan.candidateIds.length > 1
			? "screening ranked a provisional best candidate; host promotion requires a fresh two-candidate confirmation experiment"
			: "a single-candidate screening experiment cannot issue a champion decision";
	let requiredMinimumEffect: number | undefined;
	let selectionEvidence: AvoExperimentSelectionEvidence | undefined;
	if (
		plan.stage === "confirmation" &&
		plan.candidateIds.length === 2 &&
		plan.pairing === "paired" &&
		plan.baselineCandidateId
	) {
		const baselineAggregate = candidateAggregates.find(
			(aggregate) => aggregate.candidateId === plan.baselineCandidateId,
		)!;
		requiredMinimumEffect = Math.max(
			plan.promotion.minimumAbsoluteEffect,
			Math.abs(baselineAggregate.metric.mean) * plan.promotion.minimumRelativeEffect,
		);
		if (!Number.isFinite(requiredMinimumEffect)) {
			throw new Error("experiment promotion must derive a finite meaningful-effect threshold");
		}
		const challengerComparison = pairedComparisons.find(
			(comparison) => comparison.candidateId !== plan.baselineCandidateId,
		);
		if (!challengerComparison) throw new Error("confirmation experiment lacks its paired challenger comparison");
		selectionEvidence = deriveSelectionEvidence(challengerComparison, requiredMinimumEffect, plan);
		const top = ranking[0]!;
		if (top === plan.baselineCandidateId) {
			championCandidateId = plan.baselineCandidateId;
			decision = "retain";
			reason = "the preregistered baseline retained the best confirmatory aggregate primary metric";
		} else {
			const comparison = pairedComparisons.find((item) => item.candidateId === top)!;
			if (requiredMinimumEffect <= 0) {
				championCandidateId = plan.baselineCandidateId;
				decision = "retain";
				reason =
					"the relative meaningful-effect threshold resolves to zero at the confirmatory baseline; preregister a positive absolute effect to permit promotion";
			} else if (comparison.delta.count < plan.promotion.minimumPairedObservations) {
				championCandidateId = plan.baselineCandidateId;
				decision = "retain";
				reason = `the challenger has ${comparison.delta.count} paired observations; automatic promotion requires at least ${plan.promotion.minimumPairedObservations}`;
			} else if (selectionEvidence.passed) {
				championCandidateId = top;
				decision = "promote";
				reason = `the preregistered challenger cleared project selection attempt ${selectionEvidence.attemptIndex} at one-sided p=${selectionEvidence.oneSidedPValue} <= allocated alpha ${selectionEvidence.allocatedAlpha}, the ${plan.promotion.minimumPairedObservations}-pair floor, and meaningful-effect threshold ${requiredMinimumEffect}`;
			} else {
				championCandidateId = plan.baselineCandidateId;
				decision = "retain";
				reason = `the challenger did not clear project selection attempt ${selectionEvidence.attemptIndex}: one-sided p=${selectionEvidence.oneSidedPValue}, allocated alpha=${selectionEvidence.allocatedAlpha}, lower bound=${selectionEvidence.favorableLowerBound}, meaningful-effect threshold=${requiredMinimumEffect}`;
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
	const withoutDigest: Omit<AvoExperimentOutcome, "aggregateDigest"> = {
		inferenceVersion: AVO_EXPERIMENT_INFERENCE_VERSION,
		stage: plan.stage,
		confirmationOfExperimentId: plan.confirmationOfExperimentId,
		confirmationCandidateIdentityDigests: plan.confirmationCandidateIdentityDigests
			? structuredClone(plan.confirmationCandidateIdentityDigests)
			: undefined,
		minimumPairedObservationsForPromotion: plan.promotion.minimumPairedObservations,
		minimumAbsoluteEffectForPromotion: plan.promotion.minimumAbsoluteEffect,
		minimumRelativeEffectForPromotion: plan.promotion.minimumRelativeEffect,
		requiredMinimumEffect,
		selectionEvidence,
		primaryMetric: plan.primaryMetric,
		metricDirection: plan.metricDirection,
		candidateAggregates,
		conditionAggregates,
		pairedComparisons,
		conditionPairedComparisons,
		ranking,
		provisionalBestCandidateId,
		championCandidateId,
		decision,
		reason,
		trialManifestDigest,
	};
	return { ...withoutDigest, aggregateDigest: digestAvoExperimentValue(withoutDigest) };
}
